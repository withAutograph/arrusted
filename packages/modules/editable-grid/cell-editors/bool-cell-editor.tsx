// AG Grid cellEditor adapter wrapping the design-system BoolCellEditor leaf.
//
// Mode: INLINE. The leaf is a Yes/No radio group; fits in cell height.
//
// FieldValue type emitted: "bool". Leaf's commit value is `boolean`; emit
// it through onValueChange so the column's valueSetter wraps it.

import type { ReactElement } from "react";
import type { CustomCellEditorProps } from "ag-grid-react";

import { BoolCellEditor as BoolCellEditorLeaf } from "@autograph/components";
import type { EditorContext } from "@autograph/components";

import { fieldTypeMetaFromParams, rowKeyFromParams, type LeafCellEditorParams } from "./shared";

export function BoolCellEditorAdapter(
  props: CustomCellEditorProps<unknown, boolean | null> & LeafCellEditorParams,
): ReactElement {
  const raw = props.value;
  const initialValue: boolean | null =
    typeof raw === "boolean" ? raw : raw == null ? null : Boolean(raw);
  const fieldId = String(props.column.getColId());
  const context: EditorContext = {
    rowKey: rowKeyFromParams(props),
    fieldId,
    fieldType: fieldTypeMetaFromParams(props, "bool"),
  };

  return (
    <BoolCellEditorLeaf.Component
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
