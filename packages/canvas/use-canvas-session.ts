import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  WorkChange,
  WorkEntriesPage,
  WorkJson,
  WorkRule,
  WorkSelectionTarget,
  WorkSession,
  WorkSessionRequest,
  WorkTarget,
  WorkTouched,
} from "@autograph/generated-app-runtime/data";
import { failureMessage, kernelErrorCode, type CanvasClient } from "./client";
import { parseLayout, placedLayout, type CanvasLayout } from "@autograph/work-session-tools/layout";
import { parseSaveRequest, parseThreads } from "./threads";

type Header = Omit<WorkSession, "overlay">;
/**
 * What a mutation came to. `code` is the kernel's failure code, or
 * `outcome_unknown` when the request failed without an answer (it may or may
 * not have happened), or `proposal_changed` when Pull or Dismiss met a new
 * proposal. Every failure re-reads the session first; nothing is re-applied
 * silently.
 */
export type CanvasOutcome =
  | { ok: true; revision: number }
  /** `details`: the kernel's failure details, when the host passed them on. */
  | { ok: false; code: string; message: string; details?: readonly unknown[] };
/**
 * A Save's outcome: on success, the draft it wrote, or null when nothing was
 * written. With `approve` (an approver's Save and approve), whether that
 * draft was then published, or why approval was refused; a refused approval
 * leaves the draft waiting in Review.
 */
export type SaveOutcome =
  | {
      ok: true;
      revision: number;
      changeSetId: number | null;
      published: boolean;
      approveFailure?: { code: string; message: string };
    }
  | { ok: false; code: string; message: string };
/** One turn's staged entries; `turn_id` null is the user's own edits (and pulls). */
export type StagedGroup = { turn_id: string | null; at: string; entries: WorkChange[] };

/** Staged entries by turn: agent turns in the order they staged, then "Your edits". */
export function groupByTurn(entries: readonly WorkChange[]): StagedGroup[] {
  const groups = new Map<string | null, WorkChange[]>();
  for (const entry of entries) {
    const key = entry.turn_id ?? null;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return [...groups.entries()]
    .map(([turn_id, items]) => ({
      turn_id,
      at: items.map((entry) => entry.updated_at).toSorted()[0]!,
      entries: items,
    }))
    .toSorted((a, b) =>
      a.turn_id === null ? 1 : b.turn_id === null ? -1 : a.at.localeCompare(b.at),
    );
}

const target = (t: WorkTarget): WorkTarget => ({
  model_id: t.model_id,
  record_id: t.record_id,
  field_id: t.field_id,
});
const proposalId = (header: Header | null, threadId: string) => {
  const thread = header?.threads[threadId] as { proposal?: { id?: unknown } } | undefined;
  return thread?.proposal?.id;
};

type Shown = { header: Header; entries: WorkChange[] };
const sameTarget = (a: WorkTarget, b: WorkTarget) =>
  a.model_id === b.model_id && a.record_id === b.record_id && a.field_id === b.field_id;
const compareTargets = (a: WorkTarget, b: WorkTarget) =>
  a.model_id.localeCompare(b.model_id) ||
  a.record_id.localeCompare(b.record_id) ||
  a.field_id.localeCompare(b.field_id);

/**
 * The entries shown with an edit's touched entries applied: removed targets
 * leave, touched entries replace theirs. An entry already shown keeps its
 * annotations (canonical truth did not move: a published change re-reads); a
 * new entry was staged over the current canonical value, so it is not stale.
 */
export function applyTouched(
  entries: readonly WorkChange[],
  touched: Pick<WorkTouched, "entries" | "removed">,
): WorkChange[] {
  const next = entries.filter(
    (entry) =>
      !touched.removed.some((gone) => sameTarget(gone, entry)) &&
      !touched.entries.some((changed) => sameTarget(changed, entry)),
  );
  for (const changed of touched.entries) {
    const before = entries.find((entry) => sameTarget(entry, changed));
    const annotated: WorkChange =
      before === undefined
        ? {
            ...changed,
            stale: false,
            current_version: changed.base_version,
            current_value: changed.baseline,
          }
        : {
            ...changed,
            ...(before.stale === undefined ? {} : { stale: before.stale }),
            ...(before.gone === undefined ? {} : { gone: before.gone }),
            ...(before.current_version === undefined
              ? {}
              : { current_version: before.current_version }),
            ...(before.current_value === undefined ? {} : { current_value: before.current_value }),
          };
    const at = next.findIndex((entry) => compareTargets(annotated, entry) < 0);
    next.splice(at === -1 ? next.length : at, 0, annotated);
  }
  return next;
}

/**
 * The session the canvas shows: the header (`get` without the overlay) and
 * every page of staged entries, re-read after each revision the client
 * pushes and after each mutation. Edits (stage, unstage, discards, layout and
 * as-of updates) are last-write-wins: they carry no revision or request id,
 * and when the edit made the only change since the read shown, its answer is
 * applied to what is shown without a re-read. Other mutations pass the
 * revision shown and a fresh request id per attempt.
 */
export function useCanvasSession(
  client: CanvasClient,
  sessionId: string,
  options: { pageSize?: number } = {},
) {
  /** What is shown, for the session it was read for; another session's state is never shown. */
  const [state, setState] = useState<{
    sessionId: string;
    shown: Shown | null;
    error: unknown;
    /** Counts successful reads, so a read at an unchanged revision still re-reads units. */
    generation: number;
  }>({ sessionId, shown: null, error: null, generation: 0 });
  const current =
    state.sessionId === sessionId ? state : { sessionId, shown: null, error: null, generation: 0 };
  const shown = current.shown;
  const error = current.error;
  /** The layout of a live gesture, or of a drop until its save settles. */
  const [localLayout, setLocalLayout] = useState<CanvasLayout | null>(null);
  /** The last coherent snapshot read; mutations name its revision. */
  const headerRef = useRef<Header | null>(null);
  /** The entries of that same read. */
  const entriesRef = useRef<readonly WorkChange[]>([]);
  const gesture = useRef(false);
  /**
   * Edits in flight, each settled once its answer is applied or re-read: a
   * pushed revision waits for them, so an edit's own push reads nothing more.
   */
  const edits = useRef(new Set<Promise<void>>());
  /** While a Save waits on edits: each collects the revisions those edits returned. */
  const committed = useRef(new Set<Set<number>>());
  /**
   * Targets of stages in flight (`session:model:record:field`), counted as
   * staged in their own session until they settle.
   */
  const [inFlight, setInFlight] = useState<readonly string[]>([]);
  /** The session reads apply to; a read of another session is discarded. */
  const live = useRef(sessionId);
  live.current = sessionId;
  const reading = useRef<{
    sessionId: string;
    again: boolean;
    /** Only a change re-reads the units: an identical snapshot keeps the generation. */
    quiet: boolean;
    done: Promise<void>;
  } | null>(null);
  const pageSize = options.pageSize;
  /**
   * The header and every entry page of one revision. A page of another
   * revision re-reads from the header; a session that keeps changing fails
   * the read rather than settle a mixed snapshot.
   */
  const readState = useCallback(async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
      const header = await client.session.request({
        operation: "get",
        session_id: sessionId,
        overlay: false,
      });
      const entries: WorkChange[] = [];
      let consistent = true;
      let after: WorkTarget | null = null;
      do {
        const page: WorkEntriesPage = await client.session.request({
          operation: "entries",
          session_id: sessionId,
          ...(pageSize === undefined ? {} : { limit: pageSize }),
          ...(after === null ? {} : { after }),
        });
        consistent &&= page.revision === header.revision;
        entries.push(...page.entries);
        after = page.has_more ? page.next : null;
      } while (after !== null && consistent);
      if (consistent) return { header, entries };
    }
    throw new Error("The session kept changing while it loaded.");
  }, [client, sessionId, pageSize]);

  /**
   * Re-reads the session; reads asked for while one runs coalesce into one
   * more. A failed read keeps the last coherent snapshot and shows the error;
   * the next push or mutation reads again.
   */
  const reload = useCallback(
    (quiet = false): Promise<void> => {
      const running = reading.current;
      if (running !== null && running.sessionId === sessionId) {
        running.again = true;
        running.quiet &&= quiet;
        return running.done;
      }
      const run = { sessionId, again: false, quiet, done: Promise.resolve() };
      run.done = (async () => {
        do {
          run.again = false;
          let next: { shown: Shown | null; error: unknown };
          try {
            const read = await readState();
            if (live.current === sessionId) {
              headerRef.current = read.header;
              entriesRef.current = read.entries;
            }
            next = { shown: read, error: null };
          } catch (failure) {
            next = { shown: null, error: failure };
          }
          if (live.current !== sessionId) {
            if (reading.current === run) reading.current = null;
            return;
          }
          const update = next;
          const quietRun = run.quiet;
          setState((before) =>
            // A quiet re-read that finds the session as shown changes nothing.
            quietRun &&
            update.shown !== null &&
            before.sessionId === sessionId &&
            before.shown !== null &&
            JSON.stringify(before.shown) === JSON.stringify(update.shown)
              ? before
              : {
                  sessionId,
                  shown: update.shown ?? (before.sessionId === sessionId ? before.shown : null),
                  error: update.error,
                  generation:
                    (before.sessionId === sessionId ? before.generation : 0) +
                    (update.shown === null ? 0 : 1),
                },
          );
        } while (run.again);
        // Cleared in the same tick as the last check, so a read asked for
        // after it starts a new run instead of joining one that is ending.
        if (reading.current === run) reading.current = null;
      })();
      reading.current = run;
      return run.done;
    },
    [readState, sessionId],
  );

  useEffect(() => {
    // Another session: nothing of the last one is shown or mutated.
    headerRef.current = null;
    entriesRef.current = [];
    setLocalLayout(null);
    // The stream opens first and the session (then every unit) is read once
    // it connects, so a published change after that arrives as an event. A
    // stream slow to connect does not hold the canvas back: after a short
    // wait the canvas reads anyway, and that late first connect re-reads
    // once. A reconnect re-reads even at the revision shown (it may have
    // missed a published-data change), and so does a published-data change:
    // canonical changes alter stale and gone without bumping the session. A
    // bump to the revision already shown (the canvas's own mutation, which
    // re-read) reads nothing more. Reads asked for meanwhile coalesce.
    let started = false;
    let readBeforeConnect = false;
    let connects = 0;
    let reconnected = false;
    const start = () => {
      if (started) return;
      started = true;
      void reload();
    };
    const fallback = setTimeout(() => {
      readBeforeConnect = true;
      start();
    }, connectGraceMs);
    const unsubscribe = client.subscribe(sessionId, {
      onConnect: () => {
        connects += 1;
        if (connects > 1) {
          reconnected = true;
          return;
        }
        clearTimeout(fallback);
        if (started && readBeforeConnect) reconnected = true;
        else start();
      },
      onRevision: (revision) => {
        // A stream that sends no connect: its first revision is the connect.
        if (connects === 0) {
          connects = 1;
          clearTimeout(fallback);
          if (started && readBeforeConnect) reconnected = true;
          else {
            start();
            return;
          }
        }
        if (reconnected) {
          reconnected = false;
          void reload();
          return;
        }
        void (async () => {
          await Promise.all(edits.current);
          await reading.current?.done;
          if (live.current !== sessionId || headerRef.current?.revision === revision) return;
          void reload();
        })();
      },
      onData: () => void reload(),
    });
    return () => {
      clearTimeout(fallback);
      unsubscribe();
    };
  }, [client, sessionId, reload]);

  /** A failed mutation re-reads, then says what it came to. */
  const failed = useCallback(
    async (failure: unknown): Promise<CanvasOutcome> => {
      await reload();
      const code = kernelErrorCode(failure);
      const details = (failure as { envelope?: { details?: unknown } } | null)?.envelope?.details;
      return {
        ok: false,
        code: code ?? "outcome_unknown",
        message:
          code === null
            ? "We couldn't confirm that. The session was re-read; check it before trying again."
            : failureMessage(failure),
        ...(Array.isArray(details) && details.length > 0 ? { details } : {}),
      };
    },
    [reload],
  );

  /**
   * One attempt at `revision` (the revision shown unless given), with a fresh
   * request id; it re-reads either way.
   */
  const send = useCallback(
    async (
      input: Record<string, unknown>,
      revision = headerRef.current?.revision,
      answered?: (result: unknown) => void,
    ): Promise<CanvasOutcome> => {
      if (revision === undefined || headerRef.current?.id !== sessionId)
        return { ok: false, code: "not_loaded", message: "The session has not loaded yet." };
      try {
        const result = await client.session.request({
          ...input,
          session_id: sessionId,
          expected_revision: revision,
          request_id: crypto.randomUUID(),
        } as WorkSessionRequest);
        answered?.(result);
        await reload();
        return { ok: true, revision: (result as { revision: number }).revision };
      } catch (failure) {
        return failed(failure);
      }
    },
    [client, sessionId, reload, failed],
  );

  /**
   * One last-write-wins edit. When it made the only change since the read
   * shown (its revision is the next one) and no read is running, `patch`
   * applies its answer to what is shown, and the units re-read on the new
   * generation; otherwise, or without `patch`, the session is re-read.
   */
  const edit = useCallback(
    async (
      input: Record<string, unknown>,
      patch?: (shown: Shown, result: unknown) => Shown,
    ): Promise<CanvasOutcome> => {
      if (headerRef.current?.id !== sessionId)
        return { ok: false, code: "not_loaded", message: "The session has not loaded yet." };
      let settle = () => {};
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      edits.current.add(settled);
      try {
        const result = await client.session.request({
          ...input,
          session_id: sessionId,
        } as WorkSessionRequest);
        const revision = (result as { revision: number }).revision;
        for (const own of committed.current) own.add(revision);
        const header = headerRef.current;
        if (
          patch !== undefined &&
          live.current === sessionId &&
          header?.id === sessionId &&
          revision === header.revision + 1 &&
          reading.current === null
        ) {
          const next = patch(
            { header: { ...header, revision }, entries: [...entriesRef.current] },
            result,
          );
          headerRef.current = next.header;
          entriesRef.current = next.entries;
          setState((before) => ({
            sessionId,
            shown: next,
            error: null,
            generation: (before.sessionId === sessionId ? before.generation : 0) + 1,
          }));
        } else await reload();
        return { ok: true, revision };
      } catch (failure) {
        return failed(failure);
      } finally {
        edits.current.delete(settled);
        settle();
      }
    },
    [client, sessionId, reload, failed],
  );
  /** Applies a stage, unstage or discard answer's touched entries. */
  const touchedPatch = useCallback(
    (shown: Shown, result: unknown): Shown => ({
      header: shown.header,
      entries: applyTouched(shown.entries, result as WorkTouched),
    }),
    [],
  );

  /**
   * Pull or Dismiss names the revision seen; after a conflict it re-applies
   * only an unchanged proposal. `shown` is the proposal as rendered (its id
   * and the revision it was read at), so one replaced since is never acted on.
   */
  const resolveProposal = useCallback(
    async (
      operation: "pull" | "dismiss",
      threadId: string,
      shown?: { proposal: string; revision: number },
    ): Promise<CanvasOutcome> => {
      const seen = shown?.proposal ?? proposalId(headerRef.current, threadId);
      const first = await send({ operation, thread_id: threadId }, shown?.revision);
      if (first.ok || first.code !== "revision_conflict") return first;
      if (seen === undefined || proposalId(headerRef.current, threadId) !== seen)
        return { ok: false, code: "proposal_changed", message: "This proposal changed." };
      return send({ operation, thread_id: threadId });
    },
    [send],
  );

  const layoutState = useMemo(
    () => (shown === null ? null : parseLayout(shown.header.layout)),
    [shown],
  );
  const pending = useMemo(() => shown?.entries ?? [], [shown]);
  const groups = useMemo(() => groupByTurn(pending), [pending]);
  // Grid layouts show the placement their order and spans derive.
  const layout = useMemo(
    () => placedLayout(localLayout ?? (layoutState?.ok ? layoutState.layout : { units: [] })),
    [localLayout, layoutState],
  );
  const threads = useMemo(() => parseThreads(shown?.header.threads ?? {}), [shown]);
  const saveRequest = useMemo(() => parseSaveRequest(shown?.header.threads ?? {}), [shown]);
  const rules = useMemo(
    () => Object.entries(shown?.header.rules ?? {}).map(([id, rule]) => ({ ...rule, id })),
    [shown],
  );

  return {
    status:
      shown !== null
        ? ("ready" as const)
        : error !== null
          ? ("error" as const)
          : ("loading" as const),
    /** The last read failure; the session shown stays as it was. */
    error,
    session: shown?.header ?? null,
    revision: shown?.header.revision ?? null,
    /**
     * Bumps on every successful read, including one at the revision shown
     * (a reconnect after canonical changes); units re-read on it.
     */
    generation: current.generation,
    /** The staged entries. */
    entries: pending,
    groups,
    rules,
    threads,
    /** The agent's open request to Save, or null; Save or Not now answers it. */
    saveRequest,
    /** The live gesture's layout, else the session's (empty when it does not validate). */
    layout,
    /** A gesture is live or its drop is still saving. */
    layoutPending: localLayout !== null,
    layoutError: layoutState?.ok === false ? layoutState.error : null,
    reload,

    stage: async (changes: readonly (WorkTarget & { value: WorkChange["value"] })[]) => {
      // Counted as staged at once; the read after the stage settles it.
      const keys = changes.map((change) => `${sessionId}:${targetKey(change)}`);
      setInFlight((current) => [...current, ...keys]);
      try {
        return await edit({ operation: "stage", changes }, touchedPatch);
      } finally {
        setInFlight((current) => {
          const next = [...current];
          for (const key of keys) next.splice(next.indexOf(key), 1);
          return next;
        });
      }
    },
    /**
     * Staged targets counted before their stage settles: the entries plus the
     * targets of stages in flight that are not staged yet.
     */
    stagedCount: new Set([
      ...pending.map(targetKey),
      ...inFlight
        .filter((key) => key.startsWith(`${sessionId}:`))
        .map((key) => key.slice(sessionId.length + 1)),
    ]).size,
    /**
     * "Restore yours": stages again, as the user, the value the agent's
     * entry replaced. Refused when the entry changed since it was shown.
     */
    restore: (shown: WorkChange): Promise<CanvasOutcome> => {
      const now = entriesRef.current.find(
        (item) =>
          item.model_id === shown.model_id &&
          item.record_id === shown.record_id &&
          item.field_id === shown.field_id,
      );
      if (shown.replaced === undefined || now === undefined || now.updated_at !== shown.updated_at)
        return Promise.resolve({
          ok: false,
          code: "revision_conflict",
          message: "The session changed.",
        });
      return edit(
        { operation: "stage", changes: [{ ...target(shown), value: shown.replaced.value }] },
        touchedPatch,
      );
    },
    /**
     * Moves the session to another as-of date: every view re-reads at it and
     * rules re-run; staged entries stay (some may read stale) for Save. Rules
     * re-ran, so it re-reads.
     */
    setAsOf: (asOf: string) => edit({ operation: "update", patch: { as_of: asOf } }),
    /**
     * Revert one change. With `shown`, the entry as the user saw it, it is
     * refused unless the last read still has that entry, so a change staged
     * there since (an agent's) is never removed.
     */
    unstage: (entry: WorkTarget, shown?: WorkChange): Promise<CanvasOutcome> => {
      if (shown !== undefined) {
        const now = entriesRef.current.find(
          (item) =>
            item.model_id === entry.model_id &&
            item.record_id === entry.record_id &&
            item.field_id === entry.field_id,
        );
        if (
          now === undefined ||
          now.updated_at !== shown.updated_at ||
          JSON.stringify(now.value) !== JSON.stringify(shown.value)
        )
          return Promise.resolve({
            ok: false,
            code: "revision_conflict",
            message: "The session changed.",
          });
      }
      return edit({ operation: "unstage", ...target(entry) }, touchedPatch);
    },
    /**
     * Revert one agent turn's current values (ask the user first). Discards
     * are last-write-wins: the turn's entries as they stand are removed.
     */
    discardTurn: (turnId: string) =>
      edit({ operation: "discard_turn", turn_id: turnId }, touchedPatch),
    /** Discard every change the agent staged, as they stand. */
    discardAgent: () => edit({ operation: "discard_source", source: "agent" }, touchedPatch),
    ruleCreate: (ruleId: string, rule: WorkRule) =>
      send({ operation: "rule_create", rule_id: ruleId, rule }),
    ruleParameters: (ruleId: string, parameters: NonNullable<WorkRule["parameters"]>) =>
      send({ operation: "rule_parameters", rule_id: ruleId, parameters }),
    ruleRemove: (ruleId: string) => send({ operation: "rule_remove", rule_id: ruleId }),
    threadOpen: (threadId: string, anchor: WorkJson) =>
      send({ operation: "thread_open", thread_id: threadId, anchor }),
    threadReply: (threadId: string, message: string) =>
      send({ operation: "thread_reply", thread_id: threadId, message }),
    threadResolve: (threadId: string) => send({ operation: "thread_resolve", thread_id: threadId }),
    /** "Not now": the person answers the agent's request to Save without saving. */
    declineSaveRequest: (threadId: string) =>
      send({ operation: "thread_resolve", thread_id: threadId }),
    /**
     * The person's selection in `forSession`, as presence (no revision, no
     * notification); the agent reads it. Written only while that session is
     * the one shown: a selection never lands in another session. Failures
     * are ignored: presence is a hint.
     */
    presence: async (selection: readonly WorkSelectionTarget[], forSession: string) => {
      if (forSession !== sessionId || headerRef.current?.id !== sessionId) return;
      try {
        await client.session.request({ operation: "presence", session_id: sessionId, selection });
      } catch {
        // Presence never interrupts work.
      }
    },
    pull: (threadId: string, shown?: { proposal: string; revision: number }) =>
      resolveProposal("pull", threadId, shown),
    dismiss: (threadId: string, shown?: { proposal: string; revision: number }) =>
      resolveProposal("dismiss", threadId, shown),
    /**
     * Saves the overlay at `revision` as one draft: the revision the user was
     * shown when they chose Save (or opened its confirmation). The kernel
     * refuses if anything changed since, so nothing unreviewed is saved.
     * `confirmed` are the stale or gone entries as the user was shown them;
     * each passes the current version it was shown with. With `approve` (an
     * approver's Save and approve), the draft is then approved through the
     * host's ordinary approval, which refuses anyone but a human approver.
     */
    save: async (
      revision: number,
      confirmed: readonly WorkChange[] = [],
      { approve = false }: { approve?: boolean } = {},
    ): Promise<SaveOutcome> => {
      // The person's own edits still in flight (a blur's stage) belong in this
      // Save: wait for them and save at the revisions they returned. If the
      // session moved any other way meanwhile, nothing is saved: it re-reads
      // and the person reviews before saving.
      let at = revision;
      if (edits.current.size > 0) {
        const own = new Set<number>();
        committed.current.add(own);
        try {
          await Promise.all(edits.current);
        } finally {
          committed.current.delete(own);
        }
        await reading.current?.done;
        // Advance only through revisions the person's own edits returned.
        while (own.has(at + 1)) at += 1;
        const now = headerRef.current?.revision;
        if (now !== undefined && now !== at) {
          // Something else changed the session (an agent, another tab, or
          // a stage that failed): show it and leave Save to the person.
          await reload();
          return {
            ok: false,
            code: "revision_conflict",
            message: "The session changed. Review it before you Save.",
          };
        }
      }
      const confirmed_stale = confirmed
        .filter((entry) => entry.stale || entry.gone)
        .map((entry) => ({
          ...target(entry),
          ...(entry.current_version == null ? {} : { current_version: entry.current_version }),
          ...(entry.gone ? { gone: entry.gone } : {}),
        }));
      let saved: { change_set?: { id?: unknown } | null } = {};
      const outcome = await send(
        {
          operation: "save",
          ...(confirmed_stale.length === 0 ? {} : { confirmed_stale }),
        },
        at,
        (result) => {
          saved = result as typeof saved;
        },
      );
      if (!outcome.ok) return { ok: false, code: outcome.code, message: outcome.message };
      const changeSetId = typeof saved.change_set?.id === "number" ? saved.change_set.id : null;
      const drafts = client.drafts;
      if (!approve || changeSetId === null || drafts === undefined)
        return { ...outcome, changeSetId, published: false };
      try {
        await drafts.kernel.postJson("/api/draft/approve", { change_set_id: changeSetId });
        return { ...outcome, changeSetId, published: true };
      } catch (failure) {
        return {
          ...outcome,
          changeSetId,
          published: false,
          approveFailure: {
            code: kernelErrorCode(failure) ?? "outcome_unknown",
            message: failureMessage(failure),
          },
        };
      }
    },

    /** A drag or resize starts: inbound layouts are ignored until it drops. */
    beginLayoutGesture: () => {
      gesture.current = true;
    },
    /** The gesture's layout, shown locally only. */
    moveLayout: (layout: CanvasLayout) => setLocalLayout(layout),
    /**
     * Saves a layout change through `update`, applied to the latest layout
     * the canvas read (a pushed revision re-reads it), so units another tab
     * added before then are kept. Layout updates are last-write-wins. A
     * layout that cannot be read is replaced only when `startOver` says so
     * (adding a unit starts a new layout); a move, a removal or a rule card
     * never does.
     */
    commitLayout: async (
      change: (current: CanvasLayout) => CanvasLayout,
      { startOver = false }: { startOver?: boolean } = {},
    ): Promise<CanvasOutcome> => {
      gesture.current = false;
      // A re-read in flight may carry a unit the agent just added: apply to it.
      await reading.current?.done;
      const parsed = parseLayout(headerRef.current?.layout ?? {});
      const current: CanvasLayout | null = parsed.ok
        ? parsed.layout
        : startOver
          ? { units: [] }
          : null;
      if (current === null)
        return { ok: false, code: "layout_invalid", message: "The canvas layout can't be read." };
      // A grid layout always stores the placement its order and spans derive.
      const layout = placedLayout(change(current));
      if (!gesture.current) setLocalLayout(layout);
      const outcome = await edit({ operation: "update", patch: { layout } }, (shown) => ({
        header: { ...shown.header, layout: layout as unknown as WorkJson },
        entries: shown.entries,
      }));
      if (!gesture.current) setLocalLayout(null);
      return outcome;
    },
  };
}
export type CanvasSession = ReturnType<typeof useCanvasSession>;
/**
 * What a read-only unit (chart, graph) takes of the canvas session: the
 * session it reads over and the revision shown. Every unit takes `session`;
 * a `CanvasSession` is one.
 */
export type UnitSession = {
  session: { id: string; as_of: string } | null;
  revision: number | null;
  /** `CanvasSession.generation`: a read at the same revision re-reads the unit. */
  generation?: number;
};

/** How long the canvas waits for its event stream before it reads anyway. */
export const connectGraceMs = 1500;

/** One staged target's key. */
const targetKey = (target: WorkTarget) =>
  `${target.model_id}:${target.record_id}:${target.field_id}`;
