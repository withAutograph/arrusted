import { useEffect, useRef } from "react";
import type { WorkChange, WorkTarget } from "@autograph/generated-app-runtime/data";

import { entryKey } from "./staged-log";
import type { CanvasThread } from "./threads";

/** What a re-read brought that the canvas did not do itself. */
export type OutsideChange =
  | { kind: "agent_staged"; entries: WorkTarget[] }
  | { kind: "agent_replied"; thread_id: string }
  | { kind: "agent_proposed"; thread_id: string }
  | { kind: "changed_underneath"; entries: WorkTarget[] };

type Snapshot = { entries: readonly WorkChange[]; threads: readonly CanvasThread[] };

const target = (entry: WorkTarget): WorkTarget => ({
  model_id: entry.model_id,
  record_id: entry.record_id,
  field_id: entry.field_id,
});
const flagged = (entry: WorkChange) => entry.stale === true || entry.gone != null;

/**
 * The outside changes between two reads of one session: values an agent
 * turn staged or restaged, agent replies and proposals on threads, and
 * staged values that published data changed underneath (newly stale or
 * gone). A pulled proposal has no turn, so the user's own Pull is not one.
 */
export function outsideChanges(before: Snapshot, after: Snapshot): OutsideChange[] {
  const changes: OutsideChange[] = [];
  const earlier = new Map(before.entries.map((entry) => [entryKey(entry), entry]));

  const staged = after.entries.filter((entry) => {
    if (entry.source !== "agent" || entry.turn_id === undefined) return false;
    const was = earlier.get(entryKey(entry));
    return was === undefined || was.updated_at !== entry.updated_at;
  });
  if (staged.length > 0) changes.push({ kind: "agent_staged", entries: staged.map(target) });

  const threads = new Map(before.threads.map((thread) => [thread.id, thread]));
  for (const thread of after.threads) {
    if (thread.resolved) continue;
    const was = threads.get(thread.id);
    const proposal = thread.proposal;
    if (proposal?.author_kind === "agent" && was?.proposal?.id !== proposal.id) {
      changes.push({ kind: "agent_proposed", thread_id: thread.id });
      continue;
    }
    const seen = new Set(was?.messages.map((message) => message.id));
    if (thread.messages.some((message) => message.author_kind === "agent" && !seen.has(message.id)))
      changes.push({ kind: "agent_replied", thread_id: thread.id });
  }

  const underneath = after.entries.filter((entry) => {
    const was = earlier.get(entryKey(entry));
    return was !== undefined && !flagged(was) && flagged(entry);
  });
  if (underneath.length > 0)
    changes.push({ kind: "changed_underneath", entries: underneath.map(target) });
  return changes;
}

/**
 * Calls `onChange` with what each re-read of the session brought from
 * outside, compared with the read before it. The first read of a session
 * is the baseline, so nothing already there is announced.
 */
export function useOutsideChanges(
  sessionId: string | null,
  snapshot: Snapshot,
  onChange: (changes: OutsideChange[]) => void,
) {
  const last = useRef<{ sessionId: string; snapshot: Snapshot } | null>(null);
  const listener = useRef(onChange);
  listener.current = onChange;
  const { entries, threads } = snapshot;
  useEffect(() => {
    if (sessionId === null) return;
    const previous = last.current;
    last.current = { sessionId, snapshot: { entries, threads } };
    if (previous === null || previous.sessionId !== sessionId) return;
    if (previous.snapshot.entries === entries && previous.snapshot.threads === threads) return;
    const found = outsideChanges(previous.snapshot, { entries, threads });
    if (found.length > 0) listener.current(found);
  }, [sessionId, entries, threads]);
}

/**
 * Calls `onAdded` with the units each change of the layout brought that the
 * canvas did not add itself (`own` names those): an agent's add_unit, or
 * another tab's. The first layout of a session is the baseline.
 */
export function useAddedUnits(
  sessionId: string | null,
  unitIds: readonly string[],
  own: ReadonlySet<string>,
  onAdded: (unitIds: string[]) => void,
) {
  const known = useRef<{ sessionId: string; ids: Set<string> } | null>(null);
  const listener = useRef(onAdded);
  listener.current = onAdded;
  const key = unitIds.join("\n");
  useEffect(() => {
    if (sessionId === null) return;
    const previous = known.current;
    if (previous === null || previous.sessionId !== sessionId) {
      known.current = { sessionId, ids: new Set(unitIds) };
      return;
    }
    const added = unitIds.filter((id) => !previous.ids.has(id));
    for (const id of added) previous.ids.add(id);
    const outside = added.filter((id) => !own.has(id));
    if (outside.length > 0) listener.current(outside);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- keyed by the ids' content.
  }, [sessionId, key]);
}
