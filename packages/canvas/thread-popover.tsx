import { useMemo, useState, type RefObject } from "react";

import type { DataDefinition, DataField } from "@autograph/generated-app-runtime/data";
import { createLabelIndex, fieldHeader } from "@autograph/work-session-tools/labels";
import { BodyPortalPopover, Button, StatusPill, Tag, cx, focusRing } from "@autograph/components";
import { Close } from "@autograph/icons";
import {
  MessageThread,
  PromptInput,
  StageConfirmation,
  type ChatMessageView,
} from "@modules/agent-chat";
import type { Field, FieldValue, RecordKey } from "@contracts";
import { formatField } from "@engines/format";

import { threadAnchor } from "./comment-mode";
import { columnHeader } from "./review-labels";
import type { CanvasThread } from "./threads";
import type { CanvasOutcome, CanvasSession } from "./use-canvas-session";

/**
 * A record's display name, when the host has it loaded: by record id, or by
 * the external key a relation value holds.
 */
export type RecordName = ((
  modelId: string,
  value: string,
  type?: "record_id" | "external_key",
) => string | undefined) & {
  /**
   * Whether the host has read this record's name (found or not); false while
   * the read is still on its way, so nothing names it as unknown, or shows an
   * id, before it lands. Absent: every name is settled.
   */
  settled?: (modelId: string, value: string, type?: "record_id" | "external_key") => boolean;
};

/** Shown in place of a record's name while it loads: never an id, never "unknown" yet. */
export const NAME_LOADING = "…";

/**
 * A record as people read it: its name; while its name loads, a neutral
 * placeholder; once read and not found, `unknown` (never its id).
 */
export function recordLabel(
  recordName: RecordName,
  modelId: string,
  value: string,
  unknown: string,
  type: "record_id" | "external_key" = "record_id",
): string {
  const name = recordName(modelId, value, type);
  if (name !== undefined) return name;
  return recordName.settled?.(modelId, value, type) === false ? NAME_LOADING : unknown;
}

export type ThreadPopoverProps = {
  /** The thread shown; the popover is closed when null. */
  thread: CanvasThread | null;
  /**
   * What the popover opens beside: the pin, cell, row or unit the thread is
   * anchored to, or a centred placeholder when that is not on screen.
   */
  anchorRef: RefObject<HTMLElement | null>;
  definition: DataDefinition;
  session: Pick<CanvasSession, "revision" | "threadReply" | "threadResolve" | "pull" | "dismiss">;
  recordName: RecordName;
  /** A unit's title by its layout id, for anchors on a unit. */
  unitTitle?: (unitId: string) => string | undefined;
  onClose: () => void;
  /** Hears every outcome, e.g. for a toast. */
  onOutcome?: (outcome: CanvasOutcome, action: Action) => void;
};
type Action = "reply" | "resolve" | "pull" | "dismiss";

const field = (
  definition: DataDefinition,
  modelId: string,
  fieldId: string,
): DataField | undefined =>
  definition.models
    .find((model) => model.id === modelId)
    ?.fields.find((item) => item.id === fieldId);

/** Where a thread is anchored, in words: the surface and, for a record, its name and column. */
export function threadPlace(
  thread: CanvasThread,
  definition: DataDefinition,
  recordName: RecordName,
  unitTitle?: (unitId: string) => string | undefined,
): { surface: string; scope?: string } {
  const labels = createLabelIndex(definition);
  const anchor = threadAnchor(thread);
  const surface =
    (anchor.unit_id === undefined ? undefined : unitTitle?.(anchor.unit_id)) ??
    (anchor.model_id === undefined ? "Canvas" : labels.modelLabel(anchor.model_id));
  if (anchor.model_id === undefined || anchor.record_id === undefined) return { surface };
  const scope = [
    recordLabel(
      recordName,
      anchor.model_id,
      anchor.record_id,
      `a ${labels.modelLabel(anchor.model_id)} outside this view`,
    ),
    anchor.field_id === undefined
      ? undefined
      : columnHeader(labels, anchor.model_id, anchor.field_id),
  ]
    .filter(Boolean)
    .join(" · ");
  return { surface, scope };
}

/**
 * One thread in a small popover beside what it is pinned to: the messages,
 * a reply box, the pending proposal with Pull and Dismiss, and Resolve. Pull
 * and Dismiss name the revision the user saw; when the proposal changed
 * under them the popover says so and shows the new one, never acting on it.
 */
export function ThreadPopover({
  thread,
  anchorRef,
  definition,
  session,
  recordName,
  unitTitle,
  onClose,
  onOutcome,
}: ThreadPopoverProps) {
  return (
    <BodyPortalPopover
      align="start"
      anchorRef={anchorRef}
      ariaLabel="Thread"
      open={thread !== null}
      onClose={onClose}
    >
      {thread === null ? null : (
        <ThreadBody
          // A different thread starts with no busy action, failure or notice.
          definition={definition}
          key={thread.id}
          recordName={recordName}
          session={session}
          thread={thread}
          unitTitle={unitTitle}
          onClose={onClose}
          onOutcome={onOutcome}
        />
      )}
    </BodyPortalPopover>
  );
}

function ThreadBody({
  thread,
  definition,
  session,
  recordName,
  unitTitle,
  onClose,
  onOutcome,
}: Omit<ThreadPopoverProps, "thread" | "anchorRef"> & { thread: CanvasThread }) {
  const labels = useMemo(() => createLabelIndex(definition), [definition]);
  const [busy, setBusy] = useState<Action | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /** The proposal the user acted on when it turned out to have changed. */
  const [changed, setChanged] = useState<string | null>(null);
  const proposal = thread.proposal;
  /** Pull and Dismiss act on this proposal at the revision it was rendered from. */
  const rendered =
    proposal === undefined || session.revision === null
      ? undefined
      : { proposal: proposal.id, revision: session.revision };

  const name = (modelId: string, recordId: string) =>
    recordLabel(recordName, modelId, recordId, `a ${labels.modelLabel(modelId)} outside this view`);
  const place = threadPlace(thread, definition, recordName, unitTitle);

  const run = async (action: Action, request: () => Promise<CanvasOutcome>) => {
    setBusy(action);
    setFailure(null);
    if (action === "pull" || action === "dismiss") setChanged(null);
    const outcome = await request();
    setBusy(null);
    if (!outcome.ok) {
      if (outcome.code === "proposal_changed") setChanged(proposal?.id ?? null);
      else setFailure(outcome.message);
    }
    onOutcome?.(outcome, action);
    return outcome;
  };

  const display = (change: NonNullable<CanvasThread["proposal"]>["changes"][number]) => {
    const column = field(definition, change.model_id, change.field_id);
    const value = change.value as FieldValue | null;
    const shown =
      value === null
        ? "empty"
        : formatField(
            value,
            (column ?? { id: change.field_id, type: value.type }) as Pick<
              Field,
              "id" | "label" | "type" | "option_set"
            >,
            {
              relationLabel: (key: RecordKey) =>
                typeof column?.target_model !== "string"
                  ? null
                  : key.type === "record_id"
                    ? name(column.target_model, key.value)
                    : key.type === "external_key"
                      ? (recordName(column.target_model, key.value, key.type) ?? null)
                      : null,
            },
          );
    return {
      record: name(change.model_id, change.record_id),
      header: column === undefined ? "a removed column" : fieldHeader(column),
      value: shown,
    };
  };

  const rows = proposal?.changes.map((change) => ({ change, text: display(change) })) ?? [];

  return (
    <div
      className="flex max-h-[min(36rem,calc(100vh-var(--space-8)))] w-[min(var(--size-editor-popover-md),calc(100vw-var(--space-4)))] flex-col"
      data-thread={thread.id}
      data-thread-resolved={thread.resolved}
    >
      <header className="flex items-center gap-[var(--space-2)] border-b border-[var(--color-border-subtle)] py-[var(--space-2)] pl-[var(--space-3)] pr-[var(--space-2)]">
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
        {thread.resolved ? null : (
          <Button
            disabled={busy !== null}
            intent="ghost"
            loading={busy === "resolve"}
            size="xs"
            onClick={() => void run("resolve", () => session.threadResolve(thread.id))}
          >
            Resolve
          </Button>
        )}
        <button
          aria-label="Close thread"
          className={cx(
            "inline-flex size-[var(--size-control-xs)] shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]",
            focusRing,
          )}
          type="button"
          onClick={onClose}
        >
          <Close aria-hidden className="size-[var(--size-icon-sm)]" />
        </button>
      </header>
      <div className="flex min-h-[var(--space-0)] flex-1 flex-col gap-[var(--space-3)] overflow-y-auto px-[var(--space-3)] py-[var(--space-3)]">
        <ThreadMessages thread={thread} />
        {changed !== null ? (
          <p
            className="m-[var(--space-0)] rounded-[var(--radius-control)] bg-[var(--color-status-warning-bg)] px-[var(--space-2-5)] py-[var(--space-1-5)] text-[length:var(--text-caption)] text-[var(--color-status-warning-ink)]"
            data-proposal-changed
            role="status"
          >
            This proposal changed. Review it again before you pull or dismiss it.
          </p>
        ) : null}
        {proposal === undefined ? null : (
          <div data-proposal={proposal.id}>
            <StageConfirmation
              details={
                <ul
                  aria-label="Proposed changes"
                  className="m-[var(--space-0)] flex list-none flex-col gap-[var(--space-1)] p-[var(--space-0)]"
                >
                  {rows.map(({ change, text }) => (
                    <li
                      className="flex flex-wrap items-baseline gap-x-[var(--space-1-5)] text-[length:var(--text-caption)] leading-[var(--leading-caption)]"
                      data-proposal-change
                      key={`${change.model_id}:${change.record_id}:${change.field_id}`}
                    >
                      <span className="font-[var(--font-weight-medium)] text-[var(--color-text-primary)]">
                        {text.record}
                      </span>
                      <span className="text-[var(--color-text-muted)]">{text.header}</span>
                      <span aria-hidden className="text-[var(--color-text-disabled)]">
                        →
                      </span>
                      <span className="tabular-nums text-[var(--color-text-primary)]">
                        {text.value}
                      </span>
                      {change.gone === undefined ? null : (
                        <Tag
                          label={
                            change.gone === "record_gone" ? "record removed" : "column retired"
                          }
                          tone="amber"
                        />
                      )}
                    </li>
                  ))}
                </ul>
              }
              labels={{
                ready: "Proposed",
                done: "Pulled",
                stage: "Add to unsaved changes",
                discard: "Dismiss",
              }}
              proposal={{
                headline: proposal.author_kind === "agent" ? "From the agent" : "From you",
                changeCount: proposal.changes.length,
                targets: [],
              }}
              staging={busy === "pull"}
              onDiscard={() => void run("dismiss", () => session.dismiss(thread.id, rendered))}
              onStage={() => void run("pull", () => session.pull(thread.id, rendered))}
            />
          </div>
        )}
        {failure === null ? null : (
          <p
            className="m-[var(--space-0)] text-[length:var(--text-caption)] text-[var(--color-status-danger)]"
            role="alert"
          >
            {failure}
          </p>
        )}
      </div>
      <div className="border-t border-[var(--color-border-subtle)] p-[var(--space-2)]">
        <ThreadReply
          busy={busy === "reply"}
          onSend={(text) => void run("reply", () => session.threadReply(thread.id, text))}
        />
      </div>
    </div>
  );
}

/** A thread's messages, scrolling in place once long. Shared by session and draft threads. */
export function ThreadMessages({ thread }: { thread: CanvasThread }) {
  const messages: ChatMessageView[] = thread.messages.map((message) => ({
    id: message.id,
    role: message.author_kind === "agent" ? "agent" : "human",
    parts: [{ kind: "text", text: message.message }],
  }));
  return (
    <MessageThread
      // A long conversation scrolls in place; the popover stays small.
      className="max-h-[16rem] shrink-0"
      viewportClassName="min-h-[var(--space-0)]"
      emptyState={
        <p className="m-[var(--space-0)] text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
          No messages yet. Write the first one below.
        </p>
      }
      gap="var(--space-2)"
      messages={messages}
    />
  );
}

/** A thread's reply box; sends the trimmed text, never an empty reply. */
export function ThreadReply({ busy, onSend }: { busy: boolean; onSend: (text: string) => void }) {
  return (
    <PromptInput
      isRunning={busy}
      placeholder="Reply…"
      onSend={(text) => {
        if (text.trim()) onSend(text.trim());
      }}
    />
  );
}
