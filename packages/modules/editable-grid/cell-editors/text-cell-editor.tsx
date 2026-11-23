// AG Grid cellEditor adapter wrapping the design-system TextCellEditor leaf.
//
// Mode: INLINE. The leaf is a single `<TextField>`; it fits in cell height
// without a popup.
//
// Lifecycle bridge (AG Grid v33 React custom cell editor pattern):
//   - AG Grid mounts the component with `CustomCellEditorProps`.
//     `props.value` is the primitive (string) emitted by the column's
//     valueGetter.
//   - On the leaf's `onCommit(next)`: we drive the commit by calling
//     `props.node.setDataValue(props.column, next, "edit")` directly. That
//     fires the column's `valueSetter` (which wraps the primitive into
//     FieldValue and registers a buffer entry). We then call
//     `props.api.stopEditing(true)` to close the editor with `cancel=true`
//     — we already committed via setDataValue, so we don't want AG Grid's
//     stopEditing flow to commit a second time.
//   - On the leaf's `onCancel()`: `props.api.stopEditing(true)` (cancel,
//     don't commit).
//
// Why direct `setDataValue` instead of relying on AG Grid's normal commit
// path: with `reactiveCustomComponents` (default true in v33), AG Grid
// proxies the editor through `CellEditorComponentProxy.onValueChange` →
// `proxy.value`. The proxy's `getValue()` DOES return the latest value
// after our `onValueChange(next)` call (verified empirically via
// `props.api.getCellEditorInstances({...})[0].getValue()` — it returns the
// new value). The race is upstream of getValue:
//   1. AG Grid attaches its own keyboard / focus listeners directly to the
//      cell DOM element.
//   2. React 18 delegates synthetic events at the root container, not at
//      the cell.
//   3. On Enter inside our leaf's input, AG Grid's cell-bound listener
//      fires FIRST (during the bubble at the cell, before React dispatches
//      to the leaf's onKeyDown). AG Grid runs `takeValueFromCellEditor` →
//      `proxy.getValue()` while `proxy.value` is still the INITIAL value
//      (the leaf hasn't called `onValueChange` yet). `newValue === oldValue`
//      → no setDataValue. Then `cellCtrl.editing := false`.
//   4. React THEN dispatches the leaf's onKeyDown → leaf's `commit()` →
//      our adapter's onCommit → `onValueChange` updates `proxy.value` too
//      late. A subsequent `props.api.stopEditing(false)` sees
//      `!cellCtrl.editing` and early-returns — no second commit attempt.
// `node.setDataValue(props.column, next, "edit")` bypasses the
// editing-state gate entirely; it's the same call AG Grid's own internals
// use after `takeValueFromCellEditor`. We then call
// `props.api.stopEditing(true)` to close the editor surface with cancel
// semantics (we already committed), so AG Grid won't double-commit.

import type { ReactElement } from "react";
import type { CustomCellEditorProps } from "ag-grid-react";

import { TextCellEditor as TextCellEditorLeaf } from "@autograph/components";
import type { EditorContext, FieldTypeMeta } from "@autograph/components";

import { fieldTypeMetaFromParams, rowKeyFromParams } from "./shared";

export type TextCellEditorAdapterParams = {
  fieldType?: FieldTypeMeta;
};

export function TextCellEditorAdapter(
  props: CustomCellEditorProps<unknown, string> & TextCellEditorAdapterParams,
): ReactElement {
  const initialValue =
    typeof props.value === "string" ? props.value : props.value == null ? "" : String(props.value);
  const fieldId = String(props.column.getColId());
  const context: EditorContext = {
    rowKey: rowKeyFromParams(props),
    fieldId,
    fieldType: fieldTypeMetaFromParams(props, "text"),
  };

  return (
    <TextCellEditorLeaf.Component
      initialValue={initialValue}
      context={context}
      onCommit={(next) => {
        props.node.setDataValue(props.column, next, "edit");
        props.api.stopEditing(true);
      }}
      onCancel={() => {
        props.api.stopEditing(true);
      }}
    />
  );
}
