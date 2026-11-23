// AG Grid cellEditor adapter mounting the design-system DatePickerCalendar
// atom directly inside AG Grid's popup.
//
// Mode: POPUP. The calendar grid needs more space than a row-height cell
// allows; popup positions it "under" the cell.
//
// FieldValue type emitted: "date" (YYYY-MM-DD).
//
// Atom-only: there is NO leaf-side input + popover wrapper; the popup IS
// the popover, and the calendar IS the picker. Click a day → onCommit;
// Escape → onCancel via AG Grid's standard cell-edit lifecycle.
//
// Lifecycle: same direct-setDataValue pattern as text-cell-editor.tsx (see
// the rationale block in that file). The Enter race doesn't apply here
// because the user commits via mouse click on a day, not Enter on an input.

import { useState, type ReactElement } from "react";
import type { CustomCellEditorProps } from "ag-grid-react";

import { DatePickerCalendar } from "@autograph/components";

import type { LeafCellEditorParams } from "./shared";

export function DatePickerCellEditorAdapter(
  props: CustomCellEditorProps<unknown, string> & LeafCellEditorParams,
): ReactElement {
  const raw = props.value;
  const initialValue: string = typeof raw === "string" ? raw : "";
  const [value, setValue] = useState(initialValue);

  return (
    // The calendar atom has no chrome — the popup ITSELF is the surface, but
    // AG Grid's `.ag-popup-editor` container is unstyled. Wrap with the
    // design-system panel chrome so the popup reads like a deliberate panel
    // rather than a bare grid floating below the cell.
    <div
      className="overflow-hidden rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] shadow-[var(--shadow-raised)]"
      style={{
        width: "var(--size-date-picker-popover)",
        height: "var(--size-date-picker-popover)",
      }}
      onKeyDown={(event) => {
        // Escape cancels via AG Grid's normal cell-edit teardown; allow it
        // to bubble up to the cell so AG Grid handles cancel-not-commit.
        if (event.key === "Escape") return;
      }}
    >
      <DatePickerCalendar
        value={value}
        onSelect={(next: string) => {
          // Click-to-commit: the calendar fires onSelect with the ISO date
          // (or "" if the user explicitly clears). Ignore "" — V0 doesn't
          // surface a date-clear affordance from the cell editor because
          // the kernel doesn't yet support a "clear field" operation that
          // would let us emit a persisted null without the apply path
          // misinterpreting it. Per the parity rubric (`positions-grid.
          // editor.person`-style "the source clear affordance is limited to
          // clearing or undoing a pending edit in V0"). Escape cancels;
          // dirty-glyph + revert handle the in-session clear path.
          if (!next) return;
          setValue(next);
          // Direct setDataValue + stopEditing(true) — see text-cell-editor.tsx
          // for the AG Grid v33 reactive proxy race rationale.
          props.node.setDataValue(props.column, next, "edit");
          props.api.stopEditing(true);
        }}
      />
    </div>
  );
}
