// AG Grid popup adapter for the design-system ValueSelect leaf. It provides
// panel chrome and uses the shared direct setDataValue lifecycle bridge.

import type { ReactElement } from "react";
import type { CustomCellEditorProps } from "ag-grid-react";

import { ValueSelect as ValueSelectLeaf } from "@autograph/components";
import type { EditorContext, FieldTypeMeta } from "@autograph/components";

import { ClearValueAction } from "@autograph/components";
import {
  fieldTypeMetaFromParams,
  rowKeyFromParams,
  type ClearableEditorParams,
  type LeafCellEditorParams,
} from "./shared";

export function ValueSelectCellEditorAdapter(
  props: CustomCellEditorProps<unknown, string> & LeafCellEditorParams & ClearableEditorParams,
): ReactElement {
  const initialValue =
    typeof props.value === "string" ? props.value : props.value == null ? "" : String(props.value);
  const hasValue = initialValue !== "";
  const fieldId = String(props.column.getColId());
  const context: EditorContext = {
    rowKey: rowKeyFromParams(props),
    fieldId,
    fieldType: fieldTypeMetaFromParams(props, "text") as FieldTypeMeta,
  };

  return (
    <div className="w-max min-w-[var(--size-editor-value-select-min)] max-w-[var(--size-editor-popover-md)] rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-[var(--space-2)] shadow-[var(--shadow-raised)]">
      {props.clearable && hasValue ? (
        <ClearValueAction
          onClear={() => {
            props.node.setDataValue(props.column, null, "edit");
            props.api.stopEditing(true);
          }}
        />
      ) : null}
      <ValueSelectLeaf.Component
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
    </div>
  );
}
