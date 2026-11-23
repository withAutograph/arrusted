// TextListEditor — edits a `text_list` FieldValue as removable chips plus an
// input where Enter adds an item. Enter on an empty input (or Done) commits;
// committing no items is how a host clears the value.
//
// Atom-only: no border or shadow; the host (AG Grid popup) supplies chrome.

import { useRef, useState } from "react";
import type { FieldValue } from "@contracts";

import { Close } from "../../../icons";
import { Button } from "../../Button";
import { TextField } from "../../FormControls";
import { ClearValueAction } from "../clear-value-action";
import type { EditorContext, EditorProps, FieldEditor } from "../protocol";

export type TextListEditValue = string[];

// Splits pasted text into list items on commas and line breaks, trimming each
// item and dropping empty ones and repeats (the first occurrence is kept).
export function splitTextListText(text: string): string[] {
  return withItems([], text.split(/[,\r\n]/u));
}

// `items` followed by each new, non-empty trimmed entry not already present.
function withItems(items: ReadonlyArray<string>, entries: ReadonlyArray<string>): string[] {
  const next = [...items];
  const seen = new Set(items);
  for (const entry of entries) {
    const item = entry.trim();
    if (item && !seen.has(item)) {
      seen.add(item);
      next.push(item);
    }
  }
  return next;
}

// The list committing now would save: text still in the input is part of it,
// not discarded.
function pendingItems(items: ReadonlyArray<string>, draft: string): string[] {
  return withItems(items, [draft]);
}

function sameItems(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function TextListEditorComponent(props: EditorProps<TextListEditValue>) {
  const { initialValue, context, onCancel, onClear, onCommit, onDraftChange } = props;
  const [items, setItems] = useState<string[]>(initialValue);
  const [draft, setDraft] = useState("");
  const finishedRef = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const label = context.fieldType.label ?? context.fieldId;

  function update(nextItems: string[], nextDraft: string) {
    setItems(nextItems);
    setDraft(nextDraft);
    const pending = pendingItems(nextItems, nextDraft);
    onDraftChange?.(sameItems(pending, initialValue) ? null : pending);
  }

  function commit() {
    if (finishedRef.current) return;
    finishedRef.current = true;
    const next = pendingItems(items, draft);
    if (sameItems(next, initialValue)) onCancel();
    else onCommit(next);
  }

  function cancel() {
    if (finishedRef.current) return;
    finishedRef.current = true;
    onCancel();
  }

  return (
    <div
      ref={rootRef}
      className="flex w-[var(--size-date-picker-popover)] flex-col gap-[var(--space-2)] p-[var(--space-2)]"
      onBlur={(event) => {
        const nextFocus = event.relatedTarget;
        if (nextFocus instanceof Node && rootRef.current?.contains(nextFocus)) return;
        if (nextFocus === null) return;
        commit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          cancel();
        }
      }}
    >
      {onClear ? (
        <ClearValueAction
          onClear={() => {
            if (finishedRef.current) return;
            finishedRef.current = true;
            onClear();
          }}
        />
      ) : null}
      {items.length > 0 ? (
        <ul aria-label={label} className="flex flex-wrap gap-[var(--space-1)]">
          {items.map((item) => (
            <li
              key={item}
              className="inline-flex max-w-full items-center gap-[var(--space-0-5)] rounded-[var(--radius-pill)] bg-[var(--color-bg-muted)] py-[var(--space-0-5)] pr-[var(--space-0-5)] pl-[var(--space-2)] text-[length:var(--text-control-xs)] text-[var(--color-text-primary)]"
            >
              <span className="truncate">{item}</span>
              <button
                type="button"
                aria-label={`Remove ${item}`}
                className="flex size-[var(--size-icon-md)] shrink-0 items-center justify-center rounded-[var(--radius-pill)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"
                // Keeps focus in the input, so removing an item never commits.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  update(
                    items.filter((value) => value !== item),
                    draft,
                  );
                }}
              >
                <Close aria-hidden="true" className="size-[var(--size-icon-xs)]" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center gap-[var(--space-2)]">
        <TextField
          aria-label={`Add to ${label}`}
          autoFocus
          placeholder="Add an item"
          size="sm"
          value={draft}
          onValueChange={(next) => update(items, next)}
          onPaste={(event) => {
            // A pasted list (commas or line breaks) becomes items at once,
            // pasted at the cursor over any selection, as the browser would.
            const text = event.clipboardData.getData("text");
            if (!/[,\r\n]/u.test(text)) return;
            event.preventDefault();
            const input = event.currentTarget;
            const start = input.selectionStart ?? draft.length;
            const end = input.selectionEnd ?? start;
            const combined = `${draft.slice(0, start)}${text}${draft.slice(end)}`;
            update(withItems(items, splitTextListText(combined)), "");
          }}
          onKeyDown={(event) => {
            // stopPropagation so AG Grid's cell-bound listener doesn't race
            // React (see `docs/known-footguns.md` "Editable Grid Host").
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              if (draft.trim()) update(pendingItems(items, draft), "");
              else commit();
            } else if (event.key === "Backspace" && draft === "" && items.length > 0) {
              event.preventDefault();
              update(items.slice(0, -1), "");
            }
          }}
        />
        <Button
          intent="primary"
          size="xs"
          onMouseDown={(event) => event.preventDefault()}
          onClick={commit}
        >
          Done
        </Button>
      </div>
    </div>
  );
}

export const TextListEditor: FieldEditor<
  TextListEditValue,
  Extract<FieldValue, { type: "text_list" }>
> = {
  Component: TextListEditorComponent,
  mode: "popover",
  // Repeated stored items show once; chips are keyed by value.
  parse: (fieldValue, _ctx: EditorContext) => [...new Set(fieldValue?.value ?? [])],
  serialize: (uiValue, _ctx: EditorContext) => ({ type: "text_list", value: [...uiValue] }),
};
