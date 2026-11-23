// Diff cell renderer factory.
//
// Wraps an app-supplied formatter so a dirty cell renders:
//   <span class="ag-diff-current">{formatted next value}</span>
//   <span class="ag-diff-was"><s>was {formatted prior value}</s></span>
//   <button class="ag-cell-revert" aria-label="Revert"><Undo/></button>
//
// Lightweight visual treatment matches `.scratch/mocks/A3-edit-mode.html`:
// the cell stays visually quiet (no bg highlight); the 6px dot in the
// upper-right (rendered by `dirty-glyph.css` via `.ag-cell-dirty::after`)
// plus the inline `was X` micro-text are the only edit cues. The revert
// button only surfaces on cell hover (rules in `diff-cell.css`).
//
// Empty-cell treatment: when the formatter returns an empty string AND
// the cell is neither dirty nor invalid, render a quiet `·` (middle dot,
// U+00B7) in disabled-text color rather than a fully blank cell. Reads
// as "intentionally empty" without the obituary feel of an em-dash. The
// formatter contract is preserved (`""` still flows to AG Grid sort/
// filter / valueFormatter); the dot is renderer-only sugar.
//
// The factory is exposed on the `GridColumnContext` so apps can opt-in
// per-column instead of the library auto-wrapping every cellRenderer
// (keeps the library's reach narrow per AGENTS.md).

import { useCallback, useEffect, useRef, type ReactNode } from "react";

import { Tag } from "@autograph/components";
import { Spinner, Undo } from "@autograph/icons";
import type { EditBuffer } from "@engines/edit-buffer/index";
import { fieldValuePrimitive } from "@engines/field-value-adapter/index";
import type { FieldId, FieldValue, VisibleRecord } from "@contracts";
import { isEditableGridTempRowKey } from "./temp-row-key";
import type { CellMark, CellNote, CellPin } from "./types";

// Params AG Grid hands to a cellRenderer. Subset we actually read; we keep
// the type narrow so the library doesn't depend on AG Grid's React-cell
// shape — AG Grid happily passes whatever it has and our renderer reads the
// fields it needs.
export type DiffCellParams = {
  data?: VisibleRecord;
  value?: unknown;
  valueFormatted?: string | null;
  colDef?: { colId?: string; field?: string };
};

export type DiffCellRendererProps = DiffCellParams & {
  buffer: EditBuffer;
  // Maps a row's baseline value for this (rowKey, fieldId) cell. Dirty cells
  // render the pending value from the buffer and the baseline value as
  // "was ..."; visible rows are never mutated to act as the pending store.
  priorValueGetter: (rowKey: string, fieldId: FieldId) => FieldValue | null | undefined;
  // Returns the validation error message for an invalid cell, or
  // undefined when the cell has no error. The hook sources this from the
  // `invalidCells: Map<string,string>` state populated by the field
  // setters. When defined, the renderer takes the error path FIRST
  // (mutually exclusive with the dirty path — invalid commits never
  // enter the buffer per the setter's gate, so the two states cannot
  // co-occur for a single commit).
  invalidMessageGetter?: (rowKey: string, fieldId: FieldId) => string | undefined;
  // App-supplied formatter — same shape it would pass to AG Grid's
  // `valueFormatter`. Returns the human-readable string for a primitive or
  // FieldValue. The renderer calls this with the primitive form so apps
  // don't need to change their existing formatters.
  formatValue: (value: unknown, fieldValue: FieldValue | null | undefined) => string;
  onRevert: (rowKey: string, fieldId: FieldId) => void;
};

// A control inside a cell (a pin, a note's action). AG Grid listens for clicks
// natively on the cell, below React's root listener, so React's
// stopPropagation would come too late: the grid would also see the click (a
// cell click, a double-click edit). Native listeners stop the event here.
function CellControl({
  className,
  ariaLabel,
  data,
  onActivate,
  children,
}: {
  className: string;
  ariaLabel: string;
  data: Record<string, string | number>;
  onActivate: () => void;
  children: ReactNode;
}) {
  const button = useRef<HTMLButtonElement | null>(null);
  const activate = useRef(onActivate);
  useEffect(() => {
    activate.current = onActivate;
  });
  useEffect(() => {
    const element = button.current;
    if (!element) return;
    const stop = (event: Event) => event.stopPropagation();
    const click = (event: Event) => {
      event.stopPropagation();
      activate.current();
    };
    element.addEventListener("click", click);
    for (const type of ["dblclick", "mousedown", "pointerdown"])
      element.addEventListener(type, stop);
    return () => {
      element.removeEventListener("click", click);
      for (const type of ["dblclick", "mousedown", "pointerdown"])
        element.removeEventListener(type, stop);
    };
  }, []);
  return (
    <button
      ref={button}
      type="button"
      className={className}
      aria-label={ariaLabel}
      title={ariaLabel}
      {...Object.fromEntries(Object.entries(data).map(([key, value]) => [`data-${key}`, value]))}
    >
      {children}
    </button>
  );
}

function CellPinButton({ pin }: { pin: CellPin }) {
  return (
    <CellControl
      className="ag-cell-pin"
      ariaLabel={pin.ariaLabel}
      data={{ "cell-pin": pin.count }}
      onActivate={pin.onOpen}
    >
      <Tag label={pin.label} tone={pin.tone ?? "blue"} />
    </CellControl>
  );
}

// A quiet marker: not a control, it names itself on hover.
function CellMarkTag({ mark }: { mark: CellMark }) {
  return (
    <span className="ag-cell-mark" data-cell-mark title={mark.title}>
      <Tag label={mark.label} tone={mark.tone ?? "gray"} />
    </span>
  );
}

// Stable renderer factory. Apps call `ctx.diffCellRenderer(formatValue)` to
// get a renderer ready to spread into a ColDef's `cellRenderer`.
export function makeDiffCellRenderer(props: {
  buffer: Pick<EditBuffer, "has" | "getEdit">;
  priorValueGetter: (rowKey: string, fieldId: FieldId) => FieldValue | null | undefined;
  invalidMessageGetter?: (rowKey: string, fieldId: FieldId) => string | undefined;
  // A quiet line under a cell, clean or dirty (host-supplied; see `CellNote`).
  cellNote?: (rowKey: string, fieldId: FieldId) => CellNote | undefined;
  // A small clickable marker at the cell's right edge (host-supplied; see `CellPin`).
  cellPin?: (rowKey: string, fieldId: FieldId) => CellPin | undefined;
  // A quiet marker at the cell's right edge, before any pin (see `CellMark`).
  cellMark?: (rowKey: string, fieldId: FieldId) => CellMark | undefined;
  // Who staged this cell's pending edit, per cell. Set only under host
  // staging; without it no source attribute or agent marker is rendered.
  sourceGetter?: (rowKey: string, fieldId: FieldId) => string | undefined;
  // Whether a staged cell's entry has left the host and awaits its next
  // read (host staging only): a spinner stands in for the revert button.
  settlingGetter?: (rowKey: string, fieldId: FieldId) => boolean;
  onRevert: (rowKey: string, fieldId: FieldId) => void;
  formatValue: (value: unknown, fieldValue: FieldValue | null | undefined) => string;
}) {
  // Opt-in through `cellPin` and `cellMark`: grids without them render exactly as before.
  function DiffCellRenderer(params: DiffCellParams) {
    const fieldId = params.colDef?.colId ?? params.colDef?.field ?? "";
    const rowKey = params.data?.record_id ?? "";
    const pin = fieldId && rowKey ? props.cellPin?.(rowKey, fieldId) : undefined;
    const mark = fieldId && rowKey ? props.cellMark?.(rowKey, fieldId) : undefined;
    if (!pin && !mark) return <DiffCellContent {...params} />;
    return (
      <span className="ag-cell-pinned">
        <span className="ag-cell-pinned-content">
          <DiffCellContent {...params} pinned />
        </span>
        {mark ? <CellMarkTag mark={mark} /> : null}
        {pin ? <CellPinButton pin={pin} /> : null}
      </span>
    );
  }
  return DiffCellRenderer;

  function DiffCellContent({ pinned, ...params }: DiffCellParams & { pinned?: boolean }) {
    const fieldId = params.colDef?.colId ?? params.colDef?.field ?? "";
    const rowKey = params.data?.record_id ?? "";
    const isDirty = !!fieldId && !!rowKey && props.buffer.has({ rowKey, fieldId });
    // Invalid takes precedence over dirty: per the setter at
    // index.tsx:800-820, invalid commits never enter the buffer (the
    // setter returns false and registers the error before the buffer
    // write), so a cell can be invalid OR dirty but not both for the
    // same commit. The two CSS classes (.ag-cell-invalid, .ag-cell-dirty)
    // are independent — invalid means "the LAST commit attempt was
    // rejected"; the cell may still hold a buffer entry from an EARLIER
    // (valid) commit. Renderer treats the two as exclusive for the
    // inline content (error message wins) but the dirty glyph still
    // renders via .ag-cell-dirty::after when both classes coexist.
    const invalidMessage =
      !!fieldId && !!rowKey ? props.invalidMessageGetter?.(rowKey, fieldId) : undefined;

    const handleRevert = useCallback(
      (event: React.MouseEvent<HTMLButtonElement>) => {
        // Stop propagation so the click doesn't enter cell-edit mode (AG
        // Grid treats a cell click that isn't on an editable affordance as
        // a focus event; without stopPropagation the renderer's click would
        // race with AG Grid's edit-on-double-click behavior on adjacent
        // ranges).
        event.stopPropagation();
        if (rowKey && fieldId) props.onRevert(rowKey, fieldId);
      },
      [rowKey, fieldId],
    );

    // Use AG Grid's pre-formatted value when present; fall back to the
    // app's formatter (passed as `formatValue`) so the renderer still
    // produces a clean string for columns without a `valueFormatter`.
    //
    // Partial-save reload race (HIGH): after a save where one partition
    // succeeded and another failed, the page reloads rows from the
    // kernel. The failed partition's row.values get reset back to the
    // PRIOR server value (the failed write never persisted), but the
    // failed partition's BUFFER entries are preserved verbatim for
    // retry. AG Grid's `params.value` / `params.valueFormatted` were
    // computed off the freshly-reloaded `row.values` — i.e. the old
    // server value, NOT the user's pending edit. Without this gate
    // the cell would render OLD_VALUE with "was OLD_VALUE" struck
    // out (identical strings), the user thinks the cell is clean,
    // but Save would still re-submit the hidden buffer value.
    //
    // Fix: when a buffer entry exists for this address, source the
    // displayed value FROM the buffer (not from row.values) and
    // re-format it via the app's `formatValue` callback. The
    // `valueFormatted` short-circuit only fires for clean cells (no
    // buffer entry) — for those, AG Grid's pre-formatted string is
    // canonical.
    const bufferEdit = isDirty ? props.buffer.getEdit({ rowKey, fieldId }) : undefined;
    // `null` in the buffer is a pending clear of the stored value.
    const pendingClear = bufferEdit === null;
    const liveValue: FieldValue | null | undefined =
      bufferEdit !== undefined ? bufferEdit : params.data?.values[fieldId];
    const currentText = pendingClear
      ? ""
      : bufferEdit
        ? props.formatValue(fieldValuePrimitive(bufferEdit), bufferEdit)
        : params.valueFormatted != null && params.valueFormatted !== ""
          ? params.valueFormatted
          : props.formatValue(params.value, liveValue);

    // Wrapper is LOAD-BEARING for vertical centering. AG Grid's `.ag-cell`
    // is `display: inline-block` with line-height-based centering — it
    // assumes the renderer emits inline content. A `display: block` span
    // (which `.ag-diff-current` needs so multi-line dirty cells stack)
    // breaks that line-height trick and pushes content to the cell top.
    // Wrap in `.ag-diff-wrapper` (`display: flex; flex-direction: column;
    // justify-content: center; min-height: 100%`) so content centers
    // vertically in both single-line (non-dirty) and dual-line (dirty)
    // cases. Without this, every cell using `diffCellRenderer` top-aligns.
    //
    // Invalid path: the cell's last commit attempt was rejected by a
    // `validate` predicate. Render the current projected value at top
    // + the validation message in danger color beneath. The ⚠ glyph
    // rides on the .ag-cell-invalid class via CSS (invalid-cell.css)
    // rather than the renderer, so a non-formatter column with the same
    // class still gets the glyph.
    // Both paths render the current value the same way: a still-pending clear
    // reads "Cleared" beside a later validation error too.
    const current = pendingClear ? (
      <span className="ag-diff-current ag-diff-cleared">Cleared</span>
    ) : (
      <span className="ag-diff-current">{currentText}</span>
    );
    // A staged cell whose entry left the host shows a spinner until the
    // host reads the value beneath, beside a validation error too.
    const settling = isDirty && props.settlingGetter?.(rowKey, fieldId) === true;
    const spinner = settling ? (
      <span className="ag-cell-settling" role="status" aria-label="Updating">
        <Spinner
          aria-hidden="true"
          className="h-[var(--size-icon-xs)] w-[var(--size-icon-xs)] motion-safe:animate-spin"
        />
      </span>
    ) : null;
    if (invalidMessage) {
      return (
        <span
          className="ag-diff-wrapper"
          data-settling={settling || undefined}
          aria-busy={settling || undefined}
        >
          {current}
          <span className="ag-diff-error" role="alert">
            {invalidMessage}
          </span>
          {spinner}
        </span>
      );
    }

    // Opt-in through `cellNote`: grids without it render exactly as before.
    const note = fieldId && rowKey ? props.cellNote?.(rowKey, fieldId) : undefined;
    const noteLine = note ? (
      <span
        className={note.tone === "danger" ? "ag-diff-error" : "ag-diff-note"}
        data-cell-note={note.tone ?? "muted"}
        role={note.tone === "danger" ? "alert" : undefined}
      >
        {note.text}
        {note.action ? (
          <>
            {" "}
            <CellControl
              className="ag-cell-note-action"
              ariaLabel={note.action.ariaLabel ?? note.action.label}
              data={{ "cell-note-action": note.action.label }}
              onActivate={note.action.onSelect}
            >
              {note.action.label}
            </CellControl>
          </>
        ) : null}
      </span>
    ) : null;

    if (!isDirty) {
      if (noteLine) {
        return (
          <span className="ag-diff-wrapper">
            {/* An empty value under a note shows only the note: the note says what it takes. */}
            {currentText === "" ? null : <span className="ag-diff-current">{currentText}</span>}
            {noteLine}
          </span>
        );
      }
      // Empty-cell sugar: when the formatter returns "" (null or
      // unset value), surface a quiet middle dot instead of a fully
      // blank cell. Disabled-text color so it reads as
      // "intentionally empty" rather than as data. Wrapper structure
      // stays identical so vertical centering keeps working.
      if (currentText === "") {
        return (
          <span className="ag-diff-wrapper">
            <span
              className="ag-diff-current"
              aria-hidden="true"
              style={{ color: "var(--color-text-disabled)" }}
            >
              ·
            </span>
          </span>
        );
      }
      return (
        <span className="ag-diff-wrapper">
          <span className="ag-diff-current">{currentText}</span>
        </span>
      );
    }

    const prior = props.priorValueGetter(rowKey, fieldId);
    const priorText = props.formatValue(
      prior != null ? fieldValuePrimitive(prior) : null,
      prior ?? null,
    );
    const suppressEmptyPrior = isEditableGridTempRowKey(rowKey) && priorText.trim() === "";
    // Empty-prior treatment: when the prior value formatted to an empty
    // string (cell was unset before this commit), render `was ·` (middle
    // dot, U+00B7) under the strikethrough rather than a bare " was "
    // with nothing visible after it. Matches the empty-cell placeholder
    // the renderer paints for un-dirty empty cells (see line ~159), so
    // "was empty" reads as the same atom as "is empty" elsewhere.
    const priorIsEmpty = priorText.trim() === "";
    const priorDisplay = priorIsEmpty ? "·" : priorText;

    // Who staged it: an agent's edit is marked, so a human approving it knows.
    // Only host staging knows per cell who staged an edit (the buffer keeps a
    // row's last source), so only it marks cells; other grids render as before.
    const source = props.sourceGetter?.(rowKey, fieldId);
    return (
      <span
        className="ag-diff-wrapper"
        data-edit-source={source}
        data-settling={settling || undefined}
        aria-busy={settling || undefined}
      >
        {current}
        {suppressEmptyPrior ? null : (
          // Beside a pin "was …" can run out of room: it ends in an ellipsis
          // (diff-cell.css) and the whole line is its title.
          <span className="ag-diff-was" title={pinned ? `was ${priorDisplay}` : undefined}>
            {source === "agent" ? (
              <span data-agent-marker title="Staged by an agent: review before saving">
                <Tag label="agent" tone="blue" />{" "}
              </span>
            ) : null}
            was <s>{priorDisplay}</s>
          </span>
        )}
        {/* A staged cell's note, e.g. why a later edit of it was not staged. */}
        {noteLine}
        {settling ? (
          spinner
        ) : (
          <button
            type="button"
            className="ag-cell-revert"
            aria-label="Revert"
            onClick={handleRevert}
            // The revert button is purely a recovery affordance; suppress its
            // role in keyboard tab order so AG Grid's cell focus model stays
            // canonical (Tab cycles cells, not nested chrome inside cells).
            tabIndex={-1}
          >
            <Undo aria-hidden="true" className="h-[var(--size-icon-xs)] w-[var(--size-icon-xs)]" />
          </button>
        )}
      </span>
    );
  }
}
