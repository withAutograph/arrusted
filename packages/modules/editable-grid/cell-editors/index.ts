// Barrel + factory for AG Grid cell-editor adapters that mount our
// storybook-validated leaf editors.
//
// Use:
//   import { agGridLeafEditor } from "@modules/editable-grid";
//   const colDef = {
//     colId: "department",
//     editable: true,
//     ...agGridLeafEditor("relation-picker"),
//     cellEditorParams: { fieldType: { type: "relation", label: "Department",
//                                      relationOptions: [...] } },
//     valueGetter: ctx.fieldGetter("department"),
//     valueSetter: ctx.fieldSetter("department", "relation"),
//     cellClassRules: ctx.dirtyCellClassRules,
//   };
//
// The factory returns an object that includes `cellEditor` plus, for popup
// editors, `cellEditorPopup: true` and `cellEditorPopupPosition: "under"`.
// Apps spread the bundle into their ColDef so the popup-vs-inline decision
// stays inside the module — apps don't have to remember which editors need
// the popup config.
//
// Lifecycle pattern (all adapters):
//   - Modern AG Grid v33 React custom cell editor: component receives
//     `CustomCellEditorProps`. On the leaf's `onCommit(next)`, the adapter
//     drives the commit by calling
//     `props.node.setDataValue(props.column, next, "edit")` directly. This
//     fires the column's `valueSetter` (which wraps the primitive into
//     FieldValue and registers a buffer entry), then we call
//     `props.api.stopEditing(true)` to close the editor with `cancel=true`
//     (we already committed via setDataValue; AG Grid's stopEditing flow
//     would otherwise commit a second time).
//   - Why direct setDataValue instead of `props.onValueChange(next) +
//     props.api.stopEditing(false)`: with `reactiveCustomComponents`
//     (default true in v33), AG Grid attaches its own keyboard / focus
//     listeners directly to the cell DOM element, while React 18 delegates
//     synthetic events at the root container. On Enter, AG Grid's
//     cell-bound listener fires BEFORE React dispatches to the leaf's
//     onKeyDown — AG Grid reads `proxy.getValue()` while `proxy.value` is
//     still the initial value, gets `newValue === oldValue`, skips
//     `setDataValue`, and sets `cellCtrl.editing = false`. By the time the
//     leaf's commit handler runs and calls `props.onValueChange(next)`,
//     a subsequent `props.api.stopEditing(false)` sees `!cellCtrl.editing`
//     and early-returns. Direct `node.setDataValue(column, next, "edit")`
//     bypasses the editing-state gate; it's the same call AG Grid's own
//     internals use after `takeValueFromCellEditor`, and it ALWAYS
//     triggers the column's valueSetter chain regardless of editing state.
//     See `text-cell-editor.tsx` for the full mechanism narrative.
//   - Footgun: `props.stopEditing(suppressNavigateAfterEdit?)` (the
//     ICellEditorParams method) is NOT the same as the API's
//     `stopEditing(cancel?)`. The cell-editor-params version controls
//     post-edit navigation, NOT cancellation. Use `props.api.stopEditing`
//     for cancel semantics.
//   - We do NOT use `forwardRef` + `useImperativeHandle`. AG Grid's
//     `CellEditorComponentProxy` reads the value through `onValueChange`,
//     so an explicit `getValue()` method is unnecessary — but we also
//     don't rely on the proxy path at all (see direct setDataValue above).
//
// MoneyRate is the exception that proves the rule: its leaf commits
// `{amount, currency, period}` (an object). The adapter serializes that
// to a full `FieldValue` and emits it via `onValueChange`. The column
// pairs that with `valueSetter: ctx.fieldSetterFromValue(fieldId)` —
// see `money-rate-editor.tsx` for the contract.

import type { ComponentType } from "react";
import type { SuppressKeyboardEventParams } from "ag-grid-community";

import { TextCellEditorAdapter } from "./text-cell-editor";
import { ValueSelectCellEditorAdapter } from "./value-select-editor";
import { NumberCellEditorAdapter } from "./number-cell-editor";
import { BoolCellEditorAdapter } from "./bool-cell-editor";
import { DatePickerCellEditorAdapter } from "./date-picker-editor";
import { RelationPickerCellEditorAdapter } from "./relation-picker-editor";
import { PersonPickerCellEditorAdapter } from "./person-picker-editor";
import { MoneyRateCellEditorAdapter } from "./money-rate-editor";
import { DatetimeCellEditorAdapter } from "./datetime-editor";
import { TextListCellEditorAdapter } from "./text-list-editor";

export type LeafEditorKind =
  | "text-cell-editor"
  | "value-select"
  | "number-cell-editor"
  | "bool-cell-editor"
  | "date-picker"
  | "relation-picker"
  | "person-picker"
  | "money-rate-editor"
  | "datetime-editor"
  | "text-list-editor";

// Tell AG Grid NOT to handle Enter / Escape while one of our leaves is the
// active cell editor. Without this, AG Grid's internal editing-shortcut
// handler runs `stopEditing()` BEFORE the leaf's own React onKeyDown can
// dispatch the commit — the popup tears down and the value never round-trips
// through `node.setDataValue`. Returning `true` from `suppressKeyboardEvent`
// tells AG Grid to skip its default keyboard handling and let our leaf own
// the keystroke. The leaf's onKeyDown explicitly calls onCommit / onCancel,
// which bridge back to AG Grid via `node.setDataValue` + `api.stopEditing`.
//
// Tab is NOT suppressed: AG Grid's default Tab behavior (commit current cell,
// move focus to the next/previous cell) is what we want, and no leaf wires
// `onNavigate` from the cell-editor adapter (the leaf's Tab branch is a
// no-op when `onNavigate` is undefined). Letting AG Grid handle Tab keeps
// keyboard navigation across the grid working.
function suppressEditorKeyboardEvent(params: SuppressKeyboardEventParams): boolean {
  if (!params.editing) return false;
  return params.event.key === "Enter" || params.event.key === "Escape";
}

// `cellEditor` is constrained to a React `ComponentType` (catches "passed
// a string by mistake" regressions) but stays prop-shape-loose because
// per-adapter generics (TValue: string vs FieldValue, etc.) fight a
// narrower `CustomCellEditorProps<...>` constraint here at the bundle
// boundary. AG Grid's `cellEditor` ColDef field is itself loose; the
// individual adapter modules carry the precise per-leaf types.
export type LeafEditorBundle = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cellEditor: ComponentType<any>;
  cellEditorPopup?: boolean;
  cellEditorPopupPosition?: "over" | "under";
  suppressKeyboardEvent?: (params: SuppressKeyboardEventParams) => boolean;
};

const REGISTRY: Record<LeafEditorKind, LeafEditorBundle> = {
  "text-cell-editor": {
    cellEditor: TextCellEditorAdapter,
    suppressKeyboardEvent: suppressEditorKeyboardEvent,
  },
  // Popup (like relation-picker): the leaf is a scrollable design-system
  // listbox that exceeds row height; the adapter provides the panel surface.
  "value-select": {
    cellEditor: ValueSelectCellEditorAdapter,
    cellEditorPopup: true,
    cellEditorPopupPosition: "under",
    suppressKeyboardEvent: suppressEditorKeyboardEvent,
  },
  "number-cell-editor": {
    cellEditor: NumberCellEditorAdapter,
    suppressKeyboardEvent: suppressEditorKeyboardEvent,
  },
  "bool-cell-editor": {
    cellEditor: BoolCellEditorAdapter,
    suppressKeyboardEvent: suppressEditorKeyboardEvent,
  },
  "date-picker": {
    cellEditor: DatePickerCellEditorAdapter,
    cellEditorPopup: true,
    cellEditorPopupPosition: "under",
    suppressKeyboardEvent: suppressEditorKeyboardEvent,
  },
  "relation-picker": {
    cellEditor: RelationPickerCellEditorAdapter,
    cellEditorPopup: true,
    cellEditorPopupPosition: "under",
    suppressKeyboardEvent: suppressEditorKeyboardEvent,
  },
  "person-picker": {
    cellEditor: PersonPickerCellEditorAdapter,
    cellEditorPopup: true,
    cellEditorPopupPosition: "under",
    suppressKeyboardEvent: suppressEditorKeyboardEvent,
  },
  "money-rate-editor": {
    cellEditor: MoneyRateCellEditorAdapter,
    cellEditorPopup: true,
    cellEditorPopupPosition: "under",
    suppressKeyboardEvent: suppressEditorKeyboardEvent,
  },
  "datetime-editor": {
    cellEditor: DatetimeCellEditorAdapter,
    cellEditorPopup: true,
    cellEditorPopupPosition: "under",
    suppressKeyboardEvent: suppressEditorKeyboardEvent,
  },
  "text-list-editor": {
    cellEditor: TextListCellEditorAdapter,
    cellEditorPopup: true,
    cellEditorPopupPosition: "under",
    suppressKeyboardEvent: suppressEditorKeyboardEvent,
  },
};

export function agGridLeafEditor(kind: LeafEditorKind): LeafEditorBundle {
  const bundle = REGISTRY[kind];
  if (!bundle) {
    throw new Error(`Unknown leaf editor kind: ${String(kind)}`);
  }
  return bundle;
}

export {
  TextCellEditorAdapter,
  ValueSelectCellEditorAdapter,
  NumberCellEditorAdapter,
  BoolCellEditorAdapter,
  DatePickerCellEditorAdapter,
  RelationPickerCellEditorAdapter,
  PersonPickerCellEditorAdapter,
  MoneyRateCellEditorAdapter,
  DatetimeCellEditorAdapter,
  TextListCellEditorAdapter,
};
