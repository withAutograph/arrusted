// AG Grid cellEditor adapter for the design-system TextListEditor leaf.
//
// Mode: POPUP: the chips wrap onto several lines. The adapter supplies the
// panel chrome; for optional columns the leaf renders the Clear action.
//
// Value bridge: the column's primitive is the comma-joined display string,
// which cannot recover the items, so the adapter reads the live FieldValue
// through `currentValue`. Done, Enter and Clear commit a `text_list`
// FieldValue, or `null` when the list is emptied or cleared, and the column's
// `ctx.fieldSetterFromValue` stages a clear (or refuses it for a required
// field). See text-cell-editor.tsx for why the bridge calls setDataValue
// directly. Every draft is also mirrored into AG Grid's editor value, so when
// AG Grid closes the popup itself (Tab), its own commit stages the draft.

import { useRef, type ReactElement } from "react";
import type { CustomCellEditorProps } from "ag-grid-react";

import { TextListEditor as TextListEditorLeaf } from "@autograph/components";
import type { EditorContext } from "@autograph/components";

import {
  currentFieldValue,
  fieldTypeMetaFromParams,
  rowKeyFromParams,
  type ClearableEditorParams,
  type CurrentValueEditorParams,
  type LeafCellEditorParams,
} from "./shared";

export function TextListCellEditorAdapter(
  props: CustomCellEditorProps<unknown, unknown> &
    LeafCellEditorParams &
    ClearableEditorParams &
    CurrentValueEditorParams,
): ReactElement {
  const context: EditorContext = {
    rowKey: rowKeyFromParams(props),
    fieldId: String(props.column.getColId()),
    fieldType: fieldTypeMetaFromParams(props, "text_list"),
  };
  // AG Grid's `value` tracks the editor's current value, so keep the one it
  // started with: reverting a draft must restore that, not the last edit.
  const startingValue = useRef(props.value).current;
  const stored = currentFieldValue(props);
  const initialValue = TextListEditorLeaf.parse(
    stored?.type === "text_list" ? stored : undefined,
    context,
  );
  const toFieldValue = (items: string[]) =>
    items.length === 0 ? null : TextListEditorLeaf.serialize(items, context);

  return (
    <div className="rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] shadow-[var(--shadow-raised)]">
      <TextListEditorLeaf.Component
        initialValue={initialValue}
        context={context}
        onDraftChange={(draft) => {
          // No draft: restore AG Grid's starting value, so it stages nothing.
          props.onValueChange(draft ? toFieldValue(draft) : startingValue);
        }}
        onClear={
          props.clearable && stored != null
            ? () => {
                props.node.setDataValue(props.column, null, "edit");
                props.api.stopEditing(true);
              }
            : undefined
        }
        onCommit={(next) => {
          props.node.setDataValue(props.column, toFieldValue(next), "edit");
          props.api.stopEditing(true);
        }}
        onCancel={() => {
          props.api.stopEditing(true);
        }}
      />
    </div>
  );
}
