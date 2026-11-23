// AG Grid cellEditor adapter for the design-system DatetimeEditor leaf.
//
// Mode: POPUP, like the date picker: the calendar and time row exceed row
// height. The adapter supplies the panel chrome; for optional columns the leaf
// renders the Clear action inside its own focus scope.
//
// Value bridge: the column's primitive is the stored ISO string; the adapter
// reads the live FieldValue through `currentValue`. Done, Enter and Clear
// commit a full `datetime` FieldValue (or `null`) via direct setDataValue,
// which the column stages through `ctx.fieldSetterFromValue`; see
// text-cell-editor.tsx for why. Every draft is also mirrored into AG Grid's
// editor value, so when AG Grid closes the popup itself (Tab), its own commit
// stages the draft instead of discarding it.

import { useRef, type ReactElement } from "react";
import type { CustomCellEditorProps } from "ag-grid-react";

import { DatetimeEditor as DatetimeEditorLeaf } from "@autograph/components";
import type { EditorContext } from "@autograph/components";

import {
  currentFieldValue,
  fieldTypeMetaFromParams,
  rowKeyFromParams,
  type ClearableEditorParams,
  type CurrentValueEditorParams,
  type LeafCellEditorParams,
} from "./shared";

export function DatetimeCellEditorAdapter(
  props: CustomCellEditorProps<unknown, unknown> &
    LeafCellEditorParams &
    ClearableEditorParams &
    CurrentValueEditorParams,
): ReactElement {
  const context: EditorContext = {
    rowKey: rowKeyFromParams(props),
    fieldId: String(props.column.getColId()),
    fieldType: fieldTypeMetaFromParams(props, "datetime"),
  };
  // AG Grid's `value` tracks the editor's current value, so keep the one it
  // started with: reverting a draft must restore that, not the last edit.
  const startingValue = useRef(props.value).current;
  const stored = currentFieldValue(props);
  const initialValue = DatetimeEditorLeaf.parse(
    stored?.type === "datetime" ? stored : undefined,
    context,
  );

  return (
    <div className="overflow-hidden rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] shadow-[var(--shadow-raised)]">
      <DatetimeEditorLeaf.Component
        initialValue={initialValue}
        context={context}
        onDraftChange={(draft) => {
          // No draft: restore AG Grid's starting value, so it stages nothing.
          props.onValueChange(draft ? DatetimeEditorLeaf.serialize(draft, context) : startingValue);
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
          props.node.setDataValue(
            props.column,
            DatetimeEditorLeaf.serialize(next, context),
            "edit",
          );
          props.api.stopEditing(true);
        }}
        onCancel={() => {
          props.api.stopEditing(true);
        }}
      />
    </div>
  );
}
