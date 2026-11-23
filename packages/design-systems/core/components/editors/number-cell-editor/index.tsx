import { useId, useRef, useState } from "react";
import type { FieldValue } from "@contracts";

import { TextField } from "../../FormControls";
import { normalizeDecimalInput } from "../decimal";
import type { EditorContext, EditorProps, FieldEditor } from "../protocol";

export type NumberCellEditorValue = string;

function isValidDecimalInput(value: string) {
  return normalizeDecimalInput(value) !== null;
}

function NumberCellEditorComponent(props: EditorProps<NumberCellEditorValue>) {
  const { initialValue, onCancel, onCommit, onNavigate } = props;
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState(() =>
    initialValue.trim().length > 0 && !isValidDecimalInput(initialValue)
      ? "Enter a valid number."
      : null,
  );
  const finishedRef = useRef(false);
  const errorId = useId();

  function commit(options: { emptyNoopAction?: "cancel" | "none" } = {}) {
    if (finishedRef.current) {
      return false;
    }
    if (initialValue.trim().length === 0 && value.trim().length === 0) {
      finishedRef.current = true;
      if (options.emptyNoopAction !== "none") {
        onCancel();
      }
      return true;
    }
    // Emptying a field the host marks optional commits "" so the host can
    // clear the stored value; a required (or unmarked) field keeps rejecting it.
    if (value.trim().length === 0 && props.context.fieldType.required === false) {
      finishedRef.current = true;
      onCommit("");
      return true;
    }

    const normalized = normalizeDecimalInput(value);
    if (!normalized) {
      setError("Enter a valid number.");
      return false;
    }
    finishedRef.current = true;
    onCommit(normalized);
    return true;
  }

  function cancel() {
    if (finishedRef.current) {
      return;
    }
    finishedRef.current = true;
    onCancel();
  }

  return (
    <div className="grid gap-[var(--space-1)]">
      <TextField
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? true : undefined}
        aria-label={props.context.fieldType.label ?? props.context.fieldId}
        autoFocus
        inputMode="decimal"
        size="sm"
        value={value}
        onBlur={() => {
          void commit();
        }}
        onKeyDown={(event) => {
          // stopPropagation on Enter/Escape so AG Grid's v33 cell-bound listener
          // doesn't race React (see `docs/known-footguns.md` "Editable Grid Host").
          if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            void commit();
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
            if (commit({ emptyNoopAction: "none" })) {
              onNavigate(event.shiftKey ? "previous" : "next");
            }
          }
        }}
        onValueChange={(next) => {
          setValue(next);
          if (error) {
            setError(null);
          }
        }}
      />
      {error ? (
        <span
          id={errorId}
          role="alert"
          className="text-[length:var(--text-caption)] text-[var(--color-status-danger)]"
        >
          {error}
        </span>
      ) : null}
    </div>
  );
}

export const NumberCellEditor: FieldEditor<
  NumberCellEditorValue,
  Extract<FieldValue, { type: "number" }>
> = {
  Component: NumberCellEditorComponent,
  mode: "inline",
  parse: (fieldValue) => fieldValue?.value ?? "",
  serialize: (uiValue, _ctx: EditorContext) => ({ type: "number", value: uiValue.trim() }),
};
