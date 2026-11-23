// AG Grid cellEditor adapter wrapping the design-system PersonPicker leaf.
//
// Mode: POPUP. The PersonPicker is the same atom shape as RelationPicker
// (search input + listbox) but with a per-option `detail` row for the
// person-specific use case; it needs more space than a row.
//
// Atom-only: the leaf renders the search+list with NO chrome (border /
// shadow / padding). This adapter wraps the atom in the panel surface.
//
// Value bridge: identical to RelationPickerCellEditorAdapter. The leaf commits
// a `RecordKey`; we forward the full relation FieldValue via
// `node.setDataValue` and the column stages it unchanged.

import type { ReactElement } from "react";
import type { CustomCellEditorProps } from "ag-grid-react";

import { PersonPicker as PersonPickerLeaf } from "@autograph/components";
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

export function PersonPickerCellEditorAdapter(
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
    <div className="w-[var(--size-editor-popover-lg)] rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-[var(--space-3)] shadow-[var(--shadow-raised)] flex items-start gap-[var(--space-2)]">
      <div className="min-w-0 flex-1">
        <PersonPickerLeaf.Component
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
