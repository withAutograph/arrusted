// AG Grid cellEditor adapter wrapping the design-system RelationPicker leaf.
//
// Mode: POPUP. The picker renders a search input + scrollable option list
// that exceeds row height; popup mode anchors it "under" the cell.
//
// Atom-only: the leaf renders the search+list with NO chrome (border /
// shadow / padding); this adapter wraps the atom in the panel surface so
// the popup reads as a deliberate panel rather than a bare list floating
// below the cell.
//
// Value bridge:
//   - AG Grid hands us `params.value` = the unwrapped relation primitive
//     (the `record_id` string) from `ctx.fieldGetter(...)`.
//   - The leaf's `initialValue` is `RecordKey | null`; we wrap the string
//     into `{type: "record_id", value: <string>}`.
//   - The leaf commits `RecordKey`; we emit the full relation FieldValue via
//     `node.setDataValue`, and the column's `ctx.fieldSetterFromValue(...)`
//     stages it unchanged, so the picked option's key type is what saves.
//
// FieldType meta: pass `relationOptions` via `cellEditorParams.fieldType`
// (apps build the options array from their lookup map).

import type { ReactElement } from "react";
import type { CustomCellEditorProps } from "ag-grid-react";

import { RelationPicker as RelationPickerLeaf } from "@autograph/components";
import type { EditorContext } from "@autograph/components";
import type { RecordKey } from "@contracts";

import { ClearValueAction } from "@autograph/components";
import {
  fieldTypeMetaFromParams,
  rowKeyFromParams,
  initialRelationKey,
  type ClearableEditorParams,
  type LeafCellEditorParams,
  type RelationEditorParams,
} from "./shared";

export function RelationPickerCellEditorAdapter(
  props: CustomCellEditorProps<unknown, string> &
    LeafCellEditorParams &
    ClearableEditorParams &
    RelationEditorParams,
): ReactElement {
  const initialKey = initialRelationKey(props, props.fieldType?.relationOptions);
  const hasValue = initialKey !== null;
  const fieldId = String(props.column.getColId());
  const context: EditorContext = {
    rowKey: rowKeyFromParams(props),
    fieldId,
    fieldType: fieldTypeMetaFromParams(props, "relation"),
  };

  return (
    <div className="w-[var(--size-editor-popover-md)] rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-[var(--space-3)] shadow-[var(--shadow-raised)] flex items-start gap-[var(--space-2)]">
      <div className="min-w-0 flex-1">
        <RelationPickerLeaf.Component
          initialValue={initialKey}
          context={context}
          onCommit={(next: RecordKey) => {
            // See text-cell-editor.tsx for the rationale on direct setDataValue.
            // The whole RecordKey goes through, so the picked option's key type
            // is saved, not the key type of a pending value it replaces.
            props.node.setDataValue(props.column, { type: "relation", value: next }, "edit");
            props.api.stopEditing(true);
          }}
          onCancel={() => {
            props.api.stopEditing(true);
          }}
        />
      </div>
      {props.clearable && hasValue ? (
        <ClearValueAction
          variant="inline"
          onClear={() => {
            props.node.setDataValue(props.column, null, "edit");
            props.api.stopEditing(true);
          }}
        />
      ) : null}
    </div>
  );
}
