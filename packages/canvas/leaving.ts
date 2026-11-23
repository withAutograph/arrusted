import { useRef } from "react";
import type { WorkChange } from "@autograph/generated-app-runtime/data";

const cell = (entry: Pick<WorkChange, "model_id" | "record_id" | "field_id">) =>
  `${entry.model_id}:${entry.record_id}:${entry.field_id}`;

/**
 * Staged entries that left the session (reverted, discarded or saved) after
 * the shown read began. Records are read over the session, so that read
 * still carries the staged value, not the value beneath. Each is held as it
 * was last shown, staged and settling, until a read begun after it left
 * lands. Nothing is guessed in between, so the cell changes once.
 *
 * `begin` numbers a read as it starts; pass the shown read's number to
 * `leaving` (null while none is shown).
 */
export function useLeavingEntries(entries: readonly WorkChange[]) {
  const begun = useRef(0);
  const left = useRef(new Map<string, { entry: WorkChange; after: number }>());
  const previous = useRef<readonly WorkChange[]>(entries);
  if (previous.current !== entries) {
    const now = new Set(entries.map(cell));
    for (const entry of previous.current)
      if (!now.has(cell(entry))) left.current.set(cell(entry), { entry, after: begun.current });
    for (const key of now) left.current.delete(key);
    previous.current = entries;
  }
  const api = useRef({
    begin: () => (begun.current += 1),
    leaving: (shown: number | null): WorkChange[] => {
      const held: WorkChange[] = [];
      for (const [key, { entry, after }] of left.current)
        if (shown !== null && shown > after) left.current.delete(key);
        else held.push(entry);
      return held;
    },
  });
  return api.current;
}
