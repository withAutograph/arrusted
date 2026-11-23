import { useEffect, useRef, useState } from "react";
import type { FieldValue } from "@contracts";

import type { EditorContext, EditorProps, FieldEditor } from "../protocol";

export type BoolCellEditorValue = boolean | null;
export type BoolCellEditorCommitValue = boolean;

function BoolCellEditorComponent(
  props: EditorProps<BoolCellEditorValue, BoolCellEditorCommitValue>,
) {
  const { initialValue, onCancel, onCommit, onNavigate } = props;
  const [selected, setSelected] = useState(initialValue);
  const groupRef = useRef<HTMLDivElement | null>(null);
  const yesRef = useRef<HTMLButtonElement | null>(null);
  const noRef = useRef<HTMLButtonElement | null>(null);
  const finishedRef = useRef(false);

  useEffect(() => {
    if (initialValue === null) {
      groupRef.current?.focus();
    }
  }, [initialValue]);

  function finishNoop(options: { emptyNoopAction?: "cancel" | "none" } = {}) {
    if (finishedRef.current) {
      return false;
    }
    finishedRef.current = true;
    if (options.emptyNoopAction !== "none") {
      onCancel();
    }
    return true;
  }

  function commit(
    next: BoolCellEditorCommitValue,
    options: { emptyNoopAction?: "cancel" | "none" } = {},
  ) {
    if (finishedRef.current) {
      return false;
    }
    if (next === initialValue) {
      return finishNoop(options);
    }
    finishedRef.current = true;
    setSelected(next);
    onCommit(next);
    return true;
  }

  function cancel() {
    if (finishedRef.current) {
      return false;
    }
    finishedRef.current = true;
    onCancel();
    return true;
  }

  function moveFocus(next: boolean) {
    setSelected(next);
    if (next) {
      yesRef.current?.focus();
    } else {
      noRef.current?.focus();
    }
  }

  return (
    <div
      aria-label={props.context.fieldType.label ?? props.context.fieldId}
      className="inline-flex items-center gap-[var(--space-2)]"
      ref={groupRef}
      role="radiogroup"
      tabIndex={initialValue === null ? -1 : undefined}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          cancel();
        }
      }}
      onKeyDown={(event) => {
        // stopPropagation on Enter/Escape so AG Grid's v33 cell-bound listener
        // doesn't race React (see `docs/known-footguns.md` "Editable Grid Host").
        if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          event.preventDefault();
          event.stopPropagation();
          moveFocus(true);
        }
        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          event.preventDefault();
          event.stopPropagation();
          moveFocus(false);
        }
        if (event.key === "Enter" || event.key === " ") {
          if (event.target !== event.currentTarget) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          if (selected === null) {
            finishNoop();
          } else {
            commit(selected);
          }
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          cancel();
        }
        if (event.key === "Tab" && onNavigate) {
          event.preventDefault();
          event.stopPropagation();
          const completed =
            selected === null
              ? finishNoop({ emptyNoopAction: "none" })
              : commit(selected, { emptyNoopAction: "none" });
          if (completed) {
            onNavigate(event.shiftKey ? "previous" : "next");
          }
        }
      }}
    >
      {initialValue === null ? (
        <span className="text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
          Unset
        </span>
      ) : null}
      <BoolOptionButton
        ref={yesRef}
        active={selected === true}
        autoFocus={selected === true}
        label="Yes"
        onCommit={() => commit(true)}
      />
      <BoolOptionButton
        ref={noRef}
        active={selected === false}
        autoFocus={selected === false}
        label="No"
        onCommit={() => commit(false)}
      />
    </div>
  );
}

function BoolOptionButton(props: {
  active: boolean;
  autoFocus: boolean;
  label: string;
  onCommit: () => void;
  ref: React.Ref<HTMLButtonElement>;
}) {
  return (
    <button
      aria-checked={props.active}
      autoFocus={props.autoFocus}
      className={[
        "inline-flex min-h-[var(--size-input-sm)] min-w-[var(--size-editor-bool-option-min)] items-center justify-center rounded-[var(--radius-control)] border px-[var(--space-3)] text-[length:var(--text-body)] font-[var(--font-weight-medium)] transition-colors",
        props.active
          ? "border-[var(--color-action-primary)] bg-[var(--color-action-primary)] text-[var(--color-text-inverse)] shadow-[var(--shadow-control)]"
          : "border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-subtle)]",
      ].join(" ")}
      ref={props.ref}
      role="radio"
      type="button"
      onClick={props.onCommit}
    >
      {props.label}
    </button>
  );
}

export const BoolCellEditor: FieldEditor<
  BoolCellEditorValue,
  Extract<FieldValue, { type: "bool" }>,
  BoolCellEditorCommitValue
> = {
  Component: BoolCellEditorComponent,
  mode: "inline",
  parse: (fieldValue) => fieldValue?.value ?? null,
  serialize: (uiValue, _ctx: EditorContext) => ({ type: "bool", value: uiValue }),
};
