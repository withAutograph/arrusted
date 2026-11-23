// Fixed-vocabulary text selector. It leaves panel chrome to consumers, keeps
// AG Grid-owned Enter/Escape from racing React, and preserves current values
// that are no longer in the option set.
import { useCallback, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { FieldValue } from "@contracts";

import { cx } from "../../utils";
import type { EditorContext, EditorProps, FieldEditor } from "../protocol";

export type ValueSelectValue = string;

type NormalizedOption = {
  value: string;
  label: string;
};

function normalizeOption(option: string | { value: string; label: string }): NormalizedOption {
  return typeof option === "string" ? { value: option, label: option } : option;
}

function ValueSelectComponent(props: EditorProps<ValueSelectValue>) {
  const { initialValue, context, onCancel, onCommit } = props;
  const finishedRef = useRef(false);

  const options = useMemo(() => {
    const allowed = (context.fieldType.valueOptions ?? []).map(normalizeOption);
    // Surface an out-of-vocabulary current value at the top so it stays
    // selectable and visible rather than being silently dropped.
    if (initialValue && !allowed.some((option) => option.value === initialValue)) {
      return [{ value: initialValue, label: initialValue }, ...allowed];
    }
    return allowed;
  }, [context.fieldType.valueOptions, initialValue]);

  const initialIndex = options.findIndex((option) => option.value === initialValue);
  const [activeIndex, setActiveIndex] = useState<number | null>(
    initialValue && initialIndex >= 0 ? initialIndex : null,
  );
  const baseId = useId();
  const listboxId = `${baseId}-valueselect`;
  const activeOptionId =
    activeIndex === null || options[activeIndex] === undefined
      ? undefined
      : `${listboxId}-${activeIndex}`;
  const setListboxRef = useCallback((node: HTMLDivElement | null) => {
    node?.focus({ preventScroll: true });
  }, []);

  function commit(next: string) {
    if (finishedRef.current) return;
    finishedRef.current = true;
    onCommit(next);
  }

  function cancel() {
    if (finishedRef.current) return;
    finishedRef.current = true;
    onCancel();
  }

  function moveActive(delta: number) {
    if (options.length === 0) return;
    const start = activeIndex ?? (delta > 0 ? -1 : options.length);
    const next = Math.max(0, Math.min(options.length - 1, start + delta));
    setActiveIndex(next);
    window.setTimeout(
      () => document.getElementById(`${listboxId}-${next}`)?.scrollIntoView?.({ block: "nearest" }),
      0,
    );
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      moveActive(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      moveActive(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      const choice = activeIndex === null ? undefined : options[activeIndex];
      if (choice !== undefined) commit(choice.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
  }

  return (
    <div
      ref={setListboxRef}
      id={listboxId}
      role="listbox"
      aria-label={context.fieldType.label ?? context.fieldId}
      aria-activedescendant={activeOptionId}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="flex max-h-[var(--size-editor-options-max-height)] flex-col gap-[var(--space-1)] overflow-auto focus-visible:outline-none"
    >
      {options.length === 0 ? (
        <div
          role="status"
          className="px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-control-sm)] text-[var(--color-text-muted)]"
        >
          No options
        </div>
      ) : (
        options.map((option, index) => {
          const active = index === activeIndex;
          const selected = active;
          return (
            <div
              key={option.value}
              id={`${listboxId}-${index}`}
              role="option"
              aria-selected={selected}
              className={cx(
                "block w-full cursor-pointer rounded-[var(--radius-control)] px-[var(--space-3)] py-[var(--space-2)] text-left text-[length:var(--text-control-sm)] font-[var(--font-weight-medium)] text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-hover)]",
                active && "bg-[var(--color-bg-hover)]",
                selected && "bg-[var(--color-bg-selected)] font-[var(--font-weight-semibold)]",
              )}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => commit(option.value)}
            >
              {option.label}
            </div>
          );
        })
      )}
    </div>
  );
}

export const ValueSelect: FieldEditor<ValueSelectValue, Extract<FieldValue, { type: "text" }>> = {
  Component: ValueSelectComponent,
  mode: "popover",
  parse: (fieldValue) => fieldValue?.value ?? "",
  serialize: (uiValue, _ctx: EditorContext) => ({ type: "text", value: uiValue }),
};
