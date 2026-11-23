import { useRef, useState } from "react";
import type { FieldValue } from "@contracts";

import { TextField } from "../../FormControls";
import type { EditorContext, EditorProps, FieldEditor } from "../protocol";

export type TextCellEditorValue = string;

function TextCellEditorComponent(props: EditorProps<TextCellEditorValue>) {
  const { initialValue, onCancel, onCommit, onNavigate } = props;
  const [value, setValue] = useState(initialValue);
  const finishedRef = useRef(false);

  function commit() {
    if (finishedRef.current) {
      return;
    }
    finishedRef.current = true;
    onCommit(value);
  }

  function cancel() {
    if (finishedRef.current) {
      return;
    }
    finishedRef.current = true;
    onCancel();
  }

  return (
    <TextField
      aria-label={props.context.fieldType.label ?? props.context.fieldId}
      autoFocus
      size="sm"
      value={value}
      onBlur={commit}
      onKeyDown={(event) => {
        // stopPropagation on Enter/Escape so AG Grid's v33 cell-bound listener
        // doesn't race React (see `docs/known-footguns.md` "Editable Grid Host").
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          commit();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          cancel();
        }
        if (event.key === "Tab") {
          if (!onNavigate) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          commit();
          onNavigate?.(event.shiftKey ? "previous" : "next");
        }
      }}
      onValueChange={setValue}
    />
  );
}

export const TextCellEditor: FieldEditor<
  TextCellEditorValue,
  Extract<FieldValue, { type: "text" }>
> = {
  Component: TextCellEditorComponent,
  mode: "inline",
  parse: (fieldValue) => fieldValue?.value ?? "",
  serialize: (uiValue, _ctx: EditorContext) => ({ type: "text", value: uiValue }),
};
