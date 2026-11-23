// Row-meta strip rendered as a full-width AG Grid row directly beneath any
// row that has at least one staged edit.
//
// Visual contract:
//   - Outer `.ag-row-meta` is shorter than a data row (height set via
//     AG Grid's `getRowHeight` callback in `index.tsx`), indented from
//     the left to nest under the data area (NOT under the row-selection
//     chrome), and carries a neutral `--color-bg-muted` tint + 3px
//     left-accent (`--color-action-primary`). The data row directly
//     above suppresses its bottom border so the two read as one fused
//     unit (CSS sibling rule in `row-meta-row.css`).
//   - The pill cluster (`.ag-row-meta-controls`) is centered on the row
//     and includes the discard ✕ as its trailing member. ✕ stays last
//     in DOM so tab order is Type → Effective → ✕.
//   - Bulk variant: the bulk-name link + read-only Type/Effective live
//     in the same centered cluster; ✕ trails them the same way.
//
// AG Grid's full-width row API: `isFullWidthRow` returns `true` when a
// rowNode's `data` is shaped like a meta-row marker; `fullWidthCellRenderer`
// receives `params.data` and renders the row's full content. The library
// stitches synthetic meta-row entries into the rowData the surface receives,
// keyed `meta:${parentRowKey}` so AG Grid's `getRowId` returns a stable id
// that doesn't collide with real `record_id`s.
//
// External filter (see `<EditableRowVersionGrid>`) honors a meta row by
// returning the same pass/fail as its parent — so when the parent row
// passes the bulk-group / changes-only filter, the meta strip stays
// visible directly beneath it.
//
// Picker mounts: the per-row Type / Effective pills open small popovers
// (DatePickerCalendar for date, DropdownMenu-style list for change_type).
// Both popovers are PORTALED to `document.body` via `createPortal` and
// positioned with `getBoundingClientRect()` against the trigger pill,
// because AG Grid's `.ag-body-viewport` clips its descendants — a
// position-absolute popover anchored inside the full-width row would be
// truncated at the row boundary, especially for the tall calendar.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { DatePickerCalendar } from "@autograph/components";
import { ChevronDown, Close } from "@autograph/icons";
import type { ChangeTypeId, VisibleRecord } from "@contracts";

// Marker shape we stitch into `rowData` for each parent that has staged
// edits. AG Grid sees this as just another row's data; `isFullWidthRow`
// detects the marker via the `__metaRow` discriminator and routes
// rendering through this renderer.
//
// The marker carries enough state for the renderer to render the strip
// AND for the external-filter pass to delegate to its parent.
export type MetaRowMarker = {
  __metaRow: true;
  // Stable row id AG Grid uses for `getRowId`. Matches the rowKey shape
  // (`meta:${parentRowKey}`).
  record_id: string;
  // The parent row's record_id / tmp rowKey. The external-filter pass
  // walks this back to the parent's row node to delegate the pass/fail
  // decision; `revertRow` uses it to drop the parent row's buffer entries.
  parentRowKey: string;
  // Inferred change_type for the parent row's currently-staged edits.
  // Derived in `pendingChangesByRow` per row from the union of touched
  // field ids; lands here as a stable ref so the renderer can label the
  // type pill without re-running inference. Undefined when no
  // resolution path produced a value (no explicit override, no
  // inferChangeType callback, no config-level changeTypeId) — the
  // renderer surfaces a "set type" placeholder so the user knows the
  // app needs a pick before save() can fire. See FR-A F3 in
  // `polish/positions-editing-model` Phase 7.
  changeType: ChangeTypeId | undefined;
  // Effective_start the parent row's edits will commit at. Today this is
  // always the controller's current asOf because all per-row edits
  // re-anchor to asOf at edit time; carrying it explicitly here means a
  // future per-row "reschedule" affordance can override.
  effectiveDate: string;
  // Bulk group id (opaque) when the parent's edits came from a multi-row
  // bulk staging action. The renderer reads `bulkGroupName` from the
  // app-supplied store via the renderer's context to show "Part of '<n>'".
  bulkGroupId?: string;
  // Padding shape so AG Grid's `VisibleRecord`-typed grid options
  // (rowData / getRowId) don't choke. Real meta rows ignore these fields
  // entirely; the renderer reads only `__metaRow` / `parentRowKey` /
  // `changeType` / `effectiveDate` / `bulkGroupId`.
  effective_start: string;
  effective_end: string | null;
  values: Record<string, never>;
  custom_fields: [];
};

// Maps a bulkGroupId → human-readable group label. Apps own the store; the
// row-meta strip just reads. Today the store is in-memory on the page
// (`Map<groupId, name>`); on the bulk-action ticket it'll move to an
// app-level recoil/zustand or to `notes` on the change_set, whichever wins.
export type BulkGroupLabelLookup = (groupId: string) => string;

// Maps a changeType id → human-readable label (from the schema). Same
// motivation as `BulkGroupLabelLookup`: the library doesn't carry schema
// state; apps inject the lookup at mount time.
export type ChangeTypeLabelLookup = (changeTypeId: ChangeTypeId) => string;

// Per-row change_type picker option. Apps thread the schema's
// position-targeted `change_types` through `controller.changeTypeOptions`
// (set on `useEditableRowVersionGrid` config); the library doesn't know
// which change_types each app has registered. Empty list disables the
// type-picker dropdown (the pill stays static).
export type ChangeTypeOption = {
  id: ChangeTypeId;
  label: string;
};

export type RowMetaRowRendererProps = {
  data?: MetaRowMarker;
  onDiscardRow: (parentRowKey: string) => void;
  // Per-row meta mutation. The renderer wires these to the date-picker /
  // change_type-picker pop-overs. The library hook captures both off the
  // controller and passes them through `fullWidthCellRendererParams`.
  effectiveDateReadOnly?: boolean;
  setRowEffectiveDate: (parentRowKey: string, effectiveStart: string) => void;
  setRowChangeType: (parentRowKey: string, changeTypeId: ChangeTypeId) => void;
  onClickBulkLink: (bulkGroupId: string) => void;
  bulkGroupLabel: BulkGroupLabelLookup;
  changeTypeLabel: ChangeTypeLabelLookup;
  changeTypeOptions: ReadonlyArray<ChangeTypeOption>;
  // When the controller has an active bulk filter that matches this row's
  // bulkGroupId, the page-level BulkFilterIndicator already surfaces the
  // group name + Type + Effective for the whole batch. The per-row strip
  // would then duplicate that copy; this flag tells the renderer to
  // collapse the bulk variant's body down to just the trailing ✕ so the
  // strip becomes a quiet "this row belongs to the filtered group, click
  // ✕ to drop it" affordance. The library hook computes this by
  // comparing `controller.activeBulkFilter` against the row's
  // `bulkGroupId` at render time.
  bulkFilterActive: boolean;
};

export function RowMetaRowRenderer(props: RowMetaRowRendererProps) {
  const data = props.data;

  const handleDiscard = useCallback(() => {
    if (!data) return;
    props.onDiscardRow(data.parentRowKey);
  }, [data, props]);

  const handleBulkLink = useCallback(() => {
    if (!data?.bulkGroupId) return;
    props.onClickBulkLink(data.bulkGroupId);
  }, [data, props]);

  if (!data) return null;
  const isBulk = !!data.bulkGroupId;
  // Render a placeholder when the digest couldn't resolve a change_type
  // (no explicit override + no inferChangeType callback + no
  // config-level changeTypeId). The strip reads "Set type" so the user
  // knows the app needs a pick before save() can fire; without this
  // the pill would render an empty value and confuse the user. See
  // FR-A F3 in `polish/positions-editing-model` Phase 7.
  const typeLabel = data.changeType ? props.changeTypeLabel(data.changeType) : "Set type";
  const dateLabel = formatEffectiveDate(data.effectiveDate);
  const discardTitle = isBulk ? "Drop this row from the bulk group" : "Discard this row's changes";

  // Bulk rows under an active page-level filter collapse to "just ✕"
  // because the BulkFilterIndicator above the grid already labels the
  // batch (name + Type + Effective). The strip chrome (bg, left accent,
  // trailing ✕) stays so the row still reads as "annotation row."
  const bulkVariantCollapsed = isBulk && props.bulkFilterActive;

  return (
    <div className="ag-row-meta" data-row-meta>
      <div className="ag-row-meta-controls">
        {bulkVariantCollapsed ? null : isBulk ? (
          <>
            <span className="ag-row-meta-label">Part of</span>
            <button type="button" className="ag-row-meta-bulk-link" onClick={handleBulkLink}>
              “{props.bulkGroupLabel(data.bulkGroupId!)}”
            </button>
            <span className="ag-row-meta-label">·</span>
            <span className="ag-row-meta-label">Type:</span>
            <span className="ag-row-meta-control ag-row-meta-control-static">
              <b>{typeLabel}</b>
            </span>
            <span className="ag-row-meta-label">Effective:</span>
            <span className="ag-row-meta-control ag-row-meta-control-static">
              <b>{dateLabel}</b>
            </span>
          </>
        ) : (
          <>
            <span className="ag-row-meta-label">Type:</span>
            <ChangeTypePickerPill
              currentLabel={typeLabel}
              options={props.changeTypeOptions}
              onPick={(id) => props.setRowChangeType(data.parentRowKey, id)}
            />
            <span className="ag-row-meta-label">Effective:</span>
            {props.effectiveDateReadOnly ? (
              <span className="ag-row-meta-control ag-row-meta-control-static">
                <b>{dateLabel}</b>
              </span>
            ) : (
              <EffectiveDatePickerPill
                currentLabel={dateLabel}
                currentValue={data.effectiveDate}
                onPick={(iso) => props.setRowEffectiveDate(data.parentRowKey, iso)}
              />
            )}
          </>
        )}
        {/* Discard ✕ is the trailing member of the centered cluster
         * (Type → Effective → ✕). Renders LAST in DOM so tab order
         * matches reading order. CSS gives it a slightly more muted
         * treatment than the picker pills so it reads as a quiet
         * close affordance, not a peer control. */}
        <button
          type="button"
          className="ag-row-meta-discard"
          title={discardTitle}
          aria-label={discardTitle}
          onClick={handleDiscard}
        >
          <Close aria-hidden="true" className="h-[var(--size-icon-xs)] w-[var(--size-icon-xs)]" />
        </button>
      </div>
    </div>
  );
}

// Render an ISO date as "MMM D, YYYY" without locale variance. The renderer
// stays library-side so app callers don't need to thread a date formatter
// through; `Intl.DateTimeFormat` would pull locale from the page.
function formatEffectiveDate(iso: string): string {
  // Defensive: if the meta row carries a bad date, surface it verbatim
  // rather than crash.
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  const year = match[1]!;
  const monthNum = parseInt(match[2]!, 10);
  const day = parseInt(match[3]!, 10);
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const monthLabel = months[monthNum - 1] ?? match[2]!;
  return `${monthLabel} ${day}, ${year}`;
}

// Anchored popover that portals its content to `document.body`. The
// content is positioned using the trigger's bounding rect, so AG Grid's
// `.ag-body-viewport` clipping doesn't truncate the panel — the panel
// lives outside AG Grid's overflow context entirely. Mirrors the escape
// pattern Modal uses (also `createPortal(..., document.body)`).
//
// The trigger element renders inline so AG Grid's row layout is undisturbed;
// the panel renders as a fixed-positioned descendant of `<body>` and
// repositions on scroll/resize via the effect.
type AnchoredPopoverProps = {
  trigger: (refSetter: (el: HTMLButtonElement | null) => void, open: boolean) => React.ReactNode;
  open: boolean;
  onClose: () => void;
  panelClassName?: string;
  children: React.ReactNode;
  // ARIA dialog label for the panel.
  ariaLabel: string;
};

function AnchoredPopover(props: AnchoredPopoverProps) {
  const { trigger, open, onClose, children, ariaLabel } = props;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDialogElement | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  // Position the panel beneath the trigger every time `open` flips on,
  // and on scroll/resize while open. Using `useLayoutEffect` so the panel
  // paints at its anchored position in the same frame as it appears
  // (avoids a flash at top:0 / left:0).
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    function updatePosition() {
      const trig = triggerRef.current;
      if (!trig) return;
      const rect = trig.getBoundingClientRect();
      // Place beneath the trigger; the panel's own width/height comes
      // from its content + design-system tokens.
      setPosition({
        top: rect.bottom + 4 /* small visual gap; matches AsOfDatePill rhythm */,
        left: rect.left,
      });
    }
    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [open]);

  // Outside-click + Escape dismissal. The handler runs on the document so
  // a click on the AG Grid surface (or anywhere outside the panel +
  // trigger) closes the popover. Capture-phase pointerdown so we beat any
  // descendant handlers that might stopPropagation.
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      onClose();
    }
    function handleKey(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      onClose();
      triggerRef.current?.focus({ preventScroll: true });
    }
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open, onClose]);

  const setTriggerRef = useCallback((el: HTMLButtonElement | null) => {
    triggerRef.current = el;
  }, []);

  return (
    <>
      {trigger(setTriggerRef, open)}
      {open && position && typeof document !== "undefined"
        ? createPortal(
            <dialog
              ref={panelRef}
              open
              aria-label={ariaLabel}
              data-row-meta-popover
              style={{
                position: "fixed",
                top: position.top,
                left: position.left,
                zIndex: "var(--z-popover)",
              }}
              className={
                "m-0 overflow-hidden p-0 rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] " +
                "bg-[var(--color-bg-surface)] shadow-[var(--shadow-raised)]"
              }
            >
              {children}
            </dialog>,
            document.body,
          )
        : null}
    </>
  );
}

// Effective-date picker pill. Click the pill → opens a popover containing
// the core `DatePickerCalendar` atom. Picking a day commits via `onPick`
// and closes the popover.
function EffectiveDatePickerPill(props: {
  currentLabel: string;
  currentValue: string;
  onPick: (iso: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <AnchoredPopover
      open={open}
      onClose={close}
      ariaLabel="Effective date"
      trigger={(setRef) => (
        <button
          ref={setRef}
          type="button"
          className="ag-row-meta-control"
          aria-haspopup="dialog"
          aria-expanded={open}
          data-row-meta-date-trigger
          onClick={() => setOpen((current) => !current)}
        >
          <b>{props.currentLabel}</b>
          <ChevronDown
            aria-hidden="true"
            className="h-[var(--size-icon-xs)] w-[var(--size-icon-xs)]"
          />
        </button>
      )}
    >
      <div
        data-row-meta-date-popover
        style={{
          width: "var(--size-date-picker-popover)",
          height: "var(--size-date-picker-popover)",
        }}
      >
        <DatePickerCalendar
          value={props.currentValue}
          onSelect={(next) => {
            if (!next) return;
            props.onPick(next);
            setOpen(false);
          }}
        />
      </div>
    </AnchoredPopover>
  );
}

// Change_type picker pill. Click the pill → opens a popover with the
// app-supplied list of change_type options. Picking an item commits via
// `onPick` and closes the popover. If `options` is empty the pill stays
// inert (apps without a schema-derived list don't need the picker).
function ChangeTypePickerPill(props: {
  currentLabel: string;
  options: ReadonlyArray<ChangeTypeOption>;
  onPick: (id: ChangeTypeId) => void;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  // Inert pill (no options threaded): render as static, no popover.
  if (props.options.length === 0) {
    return (
      <span className="ag-row-meta-control ag-row-meta-control-static">
        <b>{props.currentLabel}</b>
      </span>
    );
  }
  return (
    <AnchoredPopover
      open={open}
      onClose={close}
      ariaLabel="Change type"
      trigger={(setRef) => (
        <button
          ref={setRef}
          type="button"
          className="ag-row-meta-control"
          aria-haspopup="menu"
          aria-expanded={open}
          data-row-meta-type-trigger
          onClick={() => setOpen((current) => !current)}
        >
          <b>{props.currentLabel}</b>
          <ChevronDown
            aria-hidden="true"
            className="h-[var(--size-icon-xs)] w-[var(--size-icon-xs)]"
          />
        </button>
      )}
    >
      <div
        data-row-meta-type-popover
        role="menu"
        className="flex flex-col gap-[var(--space-1)] p-[var(--space-2)]"
        style={{ minWidth: "var(--size-popover-min-width)" }}
      >
        {props.options.map((option) => {
          // Highlight the currently-selected option so the picker reads
          // "this is the active type" instead of an undifferentiated list.
          // The current-label match is the same string the pill renders,
          // so we compare option.label (not the id, which the parent
          // doesn't pass through). Active option goes bold + selected
          // background; inactive options now render in primary text
          // (was: text-secondary, which read as "disabled").
          const isActive = option.label === props.currentLabel;
          return (
            <button
              key={option.id}
              type="button"
              role="menuitem"
              data-row-meta-type-item={option.id}
              data-row-meta-type-active={isActive ? "true" : "false"}
              className={
                "rounded-[var(--radius-control)] px-[var(--space-2)] py-[var(--space-1-5)] " +
                "text-left text-[length:var(--text-body)] text-[var(--color-text-primary)] " +
                "hover:bg-[var(--color-bg-selected)] " +
                (isActive ? "bg-[var(--color-bg-selected)] font-[var(--font-weight-semibold)]" : "")
              }
              onClick={() => {
                props.onPick(option.id);
                setOpen(false);
              }}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </AnchoredPopover>
  );
}
