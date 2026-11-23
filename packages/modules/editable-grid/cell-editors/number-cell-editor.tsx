// AG Grid cellEditor adapter wrapping the design-system NumberCellEditor leaf.
//
// Mode: INLINE. The leaf renders a single `<TextField>` with inline validation
// hint; it fits the cell row. Same lifecycle bridge as the text adapter.
//
// FieldValue type emitted: "number" (decimal string).

import type { ReactElement } from "react";
import type { CustomCellEditorProps } from "ag-grid-react";

import { NumberCellEditor as NumberCellEditorLeaf } from "@autograph/components";
import type { EditorContext } from "@autograph/components";

import { fieldTypeMetaFromParams, rowKeyFromParams, type LeafCellEditorParams } from "./shared";

export function NumberCellEditorAdapter(
  props: CustomCellEditorProps<unknown, string> & LeafCellEditorParams,
): ReactElement {
  const initialValue =
    typeof props.value === "string" ? props.value : props.value == null ? "" : String(props.value);
  const fieldId = String(props.column.getColId());
  const context: EditorContext = {
    rowKey: rowKeyFromParams(props),
    fieldId,
    fieldType: fieldTypeMetaFromParams(props, "number"),
  };

  return (
    <NumberCellEditorLeaf.Component
      initialValue={initialValue}
      context={context}
      onCommit={(next) => {
        // See text-cell-editor.tsx for the rationale on direct setDataValue.
        props.node.setDataValue(props.column, next, "edit");
        props.api.stopEditing(true);
      }}
      onCancel={() => {
        props.api.stopEditing(true);
      }}
    />
  );
}
