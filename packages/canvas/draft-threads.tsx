import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { Button, StatusPill } from "@autograph/components";

import {
  failureMessage,
  type CanvasClient,
  type CanvasDraftThreads,
  type CanvasDrafts,
  type CanvasSessionDraft,
} from "./client";
import { threadRefs, useRecordNames, type RecordRef } from "./record-names";
import { createLabelIndex } from "@autograph/work-session-tools/labels";
import { ThreadMessages, ThreadReply, threadPlace, type RecordName } from "./thread-popover";
import type { CanvasThread } from "./threads";
import type { CanvasSession } from "./use-canvas-session";

type NamesSession = Pick<CanvasSession, "session" | "generation">;

/**
 * One thread a draft carries: where it is, its messages, a reply box and,
 * for its author or an approver (`onResolve`), Resolve. The same message
 * list and reply box as a session thread's popover.
 */
export function DraftThread({
  thread,
  place,
  compact = false,
  onReply,
  onResolve,
}: {
  thread: CanvasThread;
  place: { surface: string; scope?: string };
  /** The reply box opens from a Reply button, for narrow panes. */
  compact?: boolean;
  onReply: (text: string) => Promise<void>;
  /** Absent when this user may not resolve the thread. */
  onResolve?: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<"reply" | "resolve" | null>(null);
  const [replying, setReplying] = useState(!compact);
  const [failure, setFailure] = useState<string | null>(null);
  const run = async (action: "reply" | "resolve", request: () => Promise<void>) => {
    setBusy(action);
    setFailure(null);
    try {
      await request();
    } catch (error) {
      setFailure(failureMessage(error));
    } finally {
      setBusy(null);
    }
  };
  return (
    <article
      className="flex flex-col gap-[var(--space-2)] rounded-[var(--radius-control)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-[var(--space-3)]"
      data-draft-thread={thread.id}
      data-thread-resolved={thread.resolved}
    >
      <header className="flex items-center gap-[var(--space-2)]">
        <div className="flex min-w-[var(--space-0)] flex-1 flex-col">
          <span className="flex min-w-[var(--space-0)] items-center gap-[var(--space-1-5)]">
            <span className="truncate text-[length:var(--text-control-sm)] font-[var(--font-weight-semibold)] text-[var(--color-text-primary)]">
              {place.scope ?? place.surface}
            </span>
            {thread.resolved ? <StatusPill label="Resolved" size="xs" tone="success" /> : null}
          </span>
          {place.scope === undefined ? null : (
            <span className="truncate text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
              {place.surface}
            </span>
          )}
        </div>
        {replying ? null : (
          <Button intent="ghost" size="xs" onClick={() => setReplying(true)}>
            Reply
          </Button>
        )}
        {thread.resolved || onResolve === undefined ? null : (
          <Button
            disabled={busy !== null}
            intent="ghost"
            loading={busy === "resolve"}
            size="xs"
            onClick={() => void run("resolve", onResolve)}
          >
            Resolve
          </Button>
        )}
      </header>
      <ThreadMessages thread={thread} />
      {failure === null ? null : (
        <p
          className="m-[var(--space-0)] text-[length:var(--text-caption)] text-[var(--color-status-danger)]"
          role="alert"
        >
          {failure}
        </p>
      )}
      {replying ? (
        <ThreadReply
          busy={busy === "reply"}
          onSend={(text) => void run("reply", () => onReply(text))}
        />
      ) : null}
    </article>
  );
}

/** A list of one draft's threads, each with replies and a reply box. */
function DraftThreadList({
  client,
  compact,
  threads,
  recordName,
  unitTitle,
  onReply,
  onResolve,
}: {
  client: CanvasClient;
  threads: readonly CanvasThread[];
  recordName: RecordName;
  unitTitle?: (unitId: string) => string | undefined;
  compact?: boolean;
  onReply: (threadId: string, text: string) => Promise<void>;
  /** Absent when this user may not resolve these threads. */
  onResolve?: (threadId: string) => Promise<void>;
}) {
  return (
    <div className="flex flex-col gap-[var(--space-2)]">
      {threads.map((thread) => (
        <DraftThread
          compact={compact}
          key={thread.id}
          place={threadPlace(thread, client.definition, recordName, unitTitle)}
          thread={thread}
          onReply={(text) => onReply(thread.id, text)}
          onResolve={onResolve === undefined ? undefined : () => onResolve(thread.id)}
        />
      ))}
    </div>
  );
}

/**
 * Re-reads with `load` whenever the events stream of `sessionId` says
 * published data or draft threads changed, and when it (re)connects, since a
 * reply during a gap is not announced and need not move the session's
 * revision. Staging edits moves only the revision, and reads nothing here.
 * Reads asked for while one runs coalesce into one more.
 */
function useLiveReload(
  client: CanvasClient,
  sessionId: string | undefined,
  load: () => Promise<void>,
) {
  const latest = useRef(load);
  useLayoutEffect(() => {
    latest.current = load;
  });
  useEffect(() => {
    if (sessionId === undefined) return;
    let running: Promise<void> | null = null;
    let again = false;
    const reload = () => {
      if (running !== null) {
        again = true;
        return;
      }
      running = (async () => {
        do {
          again = false;
          await latest.current();
        } while (again);
        running = null;
      })();
    };
    return client.subscribe(sessionId, {
      onRevision: () => {},
      onConnect: reload,
      onData: reload,
    });
  }, [client, sessionId]);
}

/**
 * A draft card's threads in Review mode: read when the card shows, re-read
 * after each reply or resolve and when anyone's reply reaches the events
 * stream. Every member replies; Resolve shows for the draft's author or an
 * approver, as the host says. Nothing shows for a draft with no threads.
 */
export function DraftCardThreads({
  client,
  drafts,
  session,
  changeSetId,
}: {
  client: CanvasClient;
  drafts: CanvasDrafts;
  session: NamesSession;
  changeSetId: number;
}) {
  const [found, setFound] = useState<CanvasDraftThreads | null>(null);
  const threads = found?.threads ?? null;
  const [failed, setFailed] = useState(false);
  // Reads overlap (first read, live reloads, after a reply); only the latest lands.
  const latestRead = useRef(0);
  const load = useCallback(async () => {
    const read = ++latestRead.current;
    try {
      const next = await drafts.threads.list(changeSetId);
      if (read !== latestRead.current) return;
      setFound(next);
      setFailed(false);
    } catch {
      if (read === latestRead.current) setFailed(true);
    }
  }, [drafts, changeSetId]);
  useEffect(() => {
    void load();
  }, [load]);
  useLiveReload(client, session.session?.id, load);
  const ruleNotes = Object.entries(found?.ruleNotes ?? {}).flatMap(([key, note]) => {
    const [model_id, record_id, field_id] = key.split(":");
    return model_id && record_id && field_id ? [{ model_id, record_id, field_id, note }] : [];
  });
  const recordName = useRecordNames(client, session, [
    ...threadRefs(client.definition, threads ?? []),
    ...ruleNotes.map(
      ({ model_id, record_id }) =>
        [model_id, { type: "record_id", value: record_id }] as const satisfies RecordRef,
    ),
  ]);
  if (failed)
    return (
      <p className="m-[var(--space-0)] text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
        This draft's comments could not be loaded.
      </p>
    );
  const labels = createLabelIndex(client.definition);
  // The rule behind an agent's value, as the staged list showed it.
  const rules =
    ruleNotes.length === 0 ? null : (
      <ul
        aria-label="Rules behind these changes"
        className="m-[var(--space-0)] flex max-w-[var(--size-modal-md)] list-none flex-col gap-[var(--space-1)] p-[var(--space-0)] text-[length:var(--text-caption)] text-[var(--color-text-secondary)]"
      >
        {ruleNotes.map((item) => (
          <li key={`${item.model_id}:${item.record_id}:${item.field_id}`} data-rule-note>
            {recordName(item.model_id, item.record_id) ?? labels.modelLabel(item.model_id)} ·{" "}
            {labels.header(item.model_id, item.field_id)}: By rule: {item.note}
          </li>
        ))}
      </ul>
    );
  if (threads === null || threads.length === 0) return rules;
  return (
    <>
      {rules}
      <section
        aria-label="Comments on this draft"
        // Readable line lengths on a wide card.
        className="flex max-w-[var(--size-modal-md)] flex-col gap-[var(--space-2)]"
      >
        <h3 className="m-[var(--space-0)] text-[length:var(--text-caption)] font-[var(--font-weight-semibold)] text-[var(--color-text-muted)]">
          {threads.length === 1 ? "1 comment" : `${threads.length} comments`}
        </h3>
        <DraftThreadList
          client={client}
          recordName={recordName}
          threads={threads}
          onReply={async (threadId, text) => {
            await drafts.threads.reply(changeSetId, threadId, text);
            await load();
          }}
          onResolve={
            found?.canResolve
              ? async (threadId) => {
                  await drafts.threads.resolve(changeSetId, threadId);
                  await load();
                }
              : undefined
          }
        />
      </section>
    </>
  );
}

/**
 * The drafts this session saved, with their threads: re-read on `reload` (the
 * canvas calls it when the user's own Save completes), on a stream reconnect
 * and on data events (a draft published or rejected, anyone's reply or
 * resolve), whether or not the Comments pane is open. Staging edits does not
 * re-read.
 */
export function useSessionDrafts(
  client: CanvasClient,
  drafts: CanvasDrafts | undefined,
  sessionId: string,
) {
  const [saved, setSaved] = useState<readonly CanvasSessionDraft[]>([]);
  // Reads overlap (first read, live reloads, after a Save); only the latest lands.
  const latestRead = useRef(0);
  const reload = useCallback(async () => {
    if (drafts === undefined) return;
    const read = ++latestRead.current;
    try {
      const found = await drafts.threads.forSession(sessionId);
      if (read === latestRead.current) setSaved(found);
    } catch {
      // The pane keeps what it last read; the session's own threads still show.
    }
  }, [drafts, sessionId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  useLiveReload(client, drafts === undefined ? undefined : sessionId, reload);
  const open = saved.reduce(
    (count, draft) => count + draft.threads.filter((thread) => !thread.resolved).length,
    0,
  );
  return { saved, open, reload };
}

const statusLabel: Record<CanvasSessionDraft["status"], string> = {
  draft: "Waiting for review",
  mainline: "Published",
  discarded: "Rejected",
};

/**
 * The Comments pane's "On your drafts" group: threads on drafts saved from
 * this session, so replies from reviewers reach the author, who may resolve
 * them.
 */
export function SessionDraftThreads({
  client,
  drafts,
  session,
  saved,
  unitTitle,
  onChanged,
}: {
  client: CanvasClient;
  drafts: CanvasDrafts;
  session: NamesSession;
  saved: readonly CanvasSessionDraft[];
  unitTitle?: (unitId: string) => string | undefined;
  onChanged: () => Promise<void>;
}) {
  // A draft shows when it has threads, or when it was rejected with a note:
  // the author reads why where they work, not only in Review's Rejected tab.
  const withThreads = saved.filter(
    (draft) => draft.threads.length > 0 || (draft.status === "discarded" && Boolean(draft.notes)),
  );
  const recordName = useRecordNames(
    client,
    session,
    threadRefs(
      client.definition,
      withThreads.flatMap((draft) => draft.threads),
    ),
  );
  if (withThreads.length === 0) return null;
  return (
    <section
      aria-label="On your drafts"
      className="flex flex-col gap-[var(--space-3)] border-t border-[var(--color-border-subtle)] px-[var(--space-3)] py-[var(--space-3)]"
      data-session-drafts
    >
      <h3 className="m-[var(--space-0)] px-[var(--space-1)] text-[length:var(--text-control-sm)] font-[var(--font-weight-semibold)] text-[var(--color-text-primary)]">
        On your drafts
      </h3>
      {withThreads.map((draft) => (
        <div className="flex flex-col gap-[var(--space-2)]" key={draft.change_set_id}>
          <div className="flex flex-wrap items-center gap-[var(--space-2)] px-[var(--space-1)] text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
            <span className="font-[var(--font-weight-medium)] text-[var(--color-text-secondary)]">
              Draft {saved.length - saved.indexOf(draft)}
            </span>
            <StatusPill
              label={statusLabel[draft.status]}
              size="xs"
              tone={
                draft.status === "draft"
                  ? "warning"
                  : draft.status === "mainline"
                    ? "success"
                    : "danger"
              }
            />
            {draft.notes ? <span className="line-clamp-2">“{draft.notes}”</span> : null}
          </div>
          <DraftThreadList
            client={client}
            compact
            recordName={recordName}
            threads={draft.threads}
            unitTitle={unitTitle}
            onReply={async (threadId, text) => {
              await drafts.threads.reply(draft.change_set_id, threadId, text);
              await onChanged();
            }}
            onResolve={async (threadId) => {
              await drafts.threads.resolve(draft.change_set_id, threadId);
              await onChanged();
            }}
          />
        </div>
      ))}
    </section>
  );
}
