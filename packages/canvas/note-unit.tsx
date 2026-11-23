import { useEffect, useRef, useState } from "react";
import { TextArea } from "@autograph/components";
import { noteConfigSchema, noteMaxLength } from "@autograph/work-session-tools/layout";

export type NoteUnitProps = {
  unitId: string;
  /** The unit's config (`noteConfigSchema`): its text. */
  config: unknown;
  /** Saves the edited text into the unit's config (a layout update). */
  onSave: (text: string) => void;
};

/** A note's text from its config; an unreadable config reads as empty. */
export const noteText = (config: unknown) => {
  const parsed = noteConfigSchema.safeParse(config);
  return parsed.success ? parsed.data.text : "";
};

/**
 * A note unit: plain text edited in place, saved into the unit's config when
 * the field loses focus. While it has focus, text from elsewhere (the agent's
 * `update_unit`) waits; afterwards the note shows the session's text.
 */
export function NoteUnit({ unitId, config, onSave }: NoteUnitProps) {
  const saved = noteText(config);
  const [draft, setDraft] = useState(saved);
  const editing = useRef(false);
  /** The text when the field took focus: only the user's own change is saved. */
  const atFocus = useRef(saved);
  useEffect(() => {
    if (!editing.current) setDraft(saved);
  }, [saved]);
  const near = draft.length > noteMaxLength * 0.9;
  return (
    <div
      className="flex h-full min-h-[var(--space-0)] flex-col gap-[var(--space-1)] p-[var(--space-3)]"
      data-note-unit={unitId}
    >
      <TextArea
        aria-label="Note"
        className="min-h-[var(--space-0)] flex-1 resize-none border-transparent bg-transparent leading-[var(--leading-prose)] shadow-none hover:border-[var(--color-border-subtle)] focus:border-[var(--color-border-default)]"
        maxLength={noteMaxLength}
        placeholder="Write a note for this session…"
        value={draft}
        onBlur={() => {
          editing.current = false;
          // Unchanged since focus: keep the session's text (an agent may have changed it).
          if (draft !== atFocus.current) onSave(draft);
          else setDraft(saved);
        }}
        onFocus={() => {
          editing.current = true;
          atFocus.current = draft;
        }}
        onValueChange={setDraft}
      />
      {near ? (
        <span className="self-end text-[length:var(--text-caption)] tabular-nums text-[var(--color-text-muted)]">
          {draft.length} / {noteMaxLength}
        </span>
      ) : null}
    </div>
  );
}
