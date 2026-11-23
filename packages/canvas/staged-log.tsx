import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkChange, WorkTarget } from "@autograph/generated-app-runtime/data";
import { Button, Modal, Tag, cx, focusRing, useToast } from "@autograph/components";
import { Undo } from "@autograph/icons";
import type { CanvasClient } from "./client";
import { ImpactStrip } from "./impact-strip";
import { Provenance, replacedYours, ruleNote } from "./provenance";
import {
  entryLabel,
  formatTime,
  formatValue,
  useRecordNames,
  type RecordNames,
} from "./review-labels";
import type { CanvasOutcome, CanvasSession, StagedGroup } from "./use-canvas-session";

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** A failed revert as the user reads it; the session was re-read either way. */
export function revertFailure(outcome: Extract<CanvasOutcome, { ok: false }>): string {
  if (outcome.code === "revision_conflict")
    return "The session changed while reverting. The log shows it as it is now; try again.";
  if (outcome.code === "outcome_unknown")
    return "We couldn't confirm the revert. The log shows the session as it is now.";
  return outcome.message;
}

/** Why a stale or gone entry needs a look, or null. */
export function entryProblem(entry: WorkChange): string | null {
  if (entry.gone === "record_gone") return "Record removed";
  if (entry.gone === "field_archived") return "Column archived";
  if (entry.stale) return "Changed since the edit";
  return null;
}

/** What the confirmation shows. */
type Confirming = { kind: "turn"; group: StagedGroup; number: number } | { kind: "agent" };

/** An entry's cell, as a key. */
export const entryKey = (entry: WorkTarget) =>
  JSON.stringify([entry.model_id, entry.record_id, entry.field_id]);

function EntryName({ record, header }: { record: string; header: string }) {
  return (
    <span className="flex flex-wrap items-center gap-x-[var(--space-2)] gap-y-[var(--space-0-5)] text-[length:var(--text-control-sm)] leading-[var(--leading-body)]">
      <span className="font-[var(--font-weight-medium)] text-[var(--color-text-primary)]">
        {record}
      </span>
      <span className="text-[var(--color-text-muted)]">{header}</span>
    </span>
  );
}

/**
 * One staged entry: record name and column header, old → new with
 * provenance on hover, stale and gone marked, and a per-change revert.
 */
export function StagedEntry(props: {
  entry: WorkChange;
  names: RecordNames;
  session: CanvasSession;
  busy: boolean;
  onRevert: () => void;
  /** Stages the user's replaced value again (shown when the agent replaced it). */
  onRestore?: () => void;
  /** Shows the entry's cell on the canvas. */
  onShow?: () => void;
  /** Marked, e.g. when a toast's View or Review opened the log at it. */
  focused?: boolean;
}) {
  const { entry, names, session, busy, onRevert, onRestore, onShow, focused = false } = props;
  const { record, header } = entryLabel(names, entry);
  const field = names.labels.fieldById(names.labels.modelById(entry.model_id), entry.field_id);
  const from = formatValue(names, field, entry.baseline);
  const to = formatValue(names, field, entry.value);
  const problem = entryProblem(entry);
  const now = formatValue(names, field, entry.current_value);
  const note = ruleNote(entry);
  const replaced = replacedYours(entry);
  return (
    <li
      className={cx(
        "-mx-[var(--space-2)] flex items-start gap-[var(--space-2)] rounded-[var(--radius-control)] px-[var(--space-2)] py-[var(--space-2)]",
        focused && "bg-[var(--color-bg-selected)]",
      )}
      data-focused={focused ? "" : undefined}
      data-staged-entry
      data-stale={entry.stale ? "" : undefined}
      data-gone={entry.gone ?? undefined}
    >
      <div className="flex min-w-[var(--space-0)] flex-1 flex-col gap-[var(--space-0-5)]">
        {onShow === undefined ? (
          <EntryName header={header} record={record} />
        ) : (
          <button
            className={cx(
              "-mx-[var(--space-1)] self-start rounded-[var(--radius-xs)] px-[var(--space-1)] text-left hover:bg-[var(--color-bg-hover)]",
              focusRing,
            )}
            title="Show on the canvas"
            type="button"
            onClick={onShow}
          >
            <EntryName header={header} record={record} />
          </button>
        )}
        <div className="flex min-w-[var(--space-0)] flex-wrap items-baseline gap-x-[var(--space-1-5)] text-[length:var(--text-caption)] leading-[var(--leading-caption)]">
          <span
            className={cx(
              "tabular-nums text-[var(--color-text-muted)]",
              from !== null && "line-through decoration-[var(--color-text-disabled)]",
            )}
          >
            {from ?? "empty"}
          </span>
          <span aria-label="to" className="text-[var(--color-text-muted)]">
            →
          </span>
          <Provenance entry={entry} source={session}>
            <span className="tabular-nums font-[var(--font-weight-medium)] text-[var(--color-text-primary)]">
              {to ?? "empty"}
            </span>
          </Provenance>
        </div>
        {note === null ? null : (
          <span
            className="text-[length:var(--text-caption)] leading-[var(--leading-caption)] text-[var(--color-text-secondary)]"
            data-rule-note
          >
            {note}
          </span>
        )}
        {replaced ? (
          <div
            className="flex flex-wrap items-center gap-x-[var(--space-2)] gap-y-[var(--space-0-5)] text-[length:var(--text-caption)] leading-[var(--leading-caption)] text-[var(--color-text-secondary)]"
            data-replaced-yours
          >
            <span>
              Agent replaced your edit (
              {formatValue(names, field, entry.replaced?.value) ?? "empty"})
            </span>
            {onRestore === undefined ? null : (
              <Button disabled={busy} intent="ghost" size="xs" onClick={onRestore}>
                Restore yours
              </Button>
            )}
          </div>
        ) : null}
        {problem === null ? null : (
          <div className="flex flex-wrap items-center gap-x-[var(--space-2)] gap-y-[var(--space-0-5)] pt-[var(--space-0-5)] text-[length:var(--text-caption)] leading-[var(--leading-caption)] text-[var(--color-text-secondary)]">
            <Tag label={problem} tone={entry.gone ? "red" : "amber"} />
            {entry.gone ? null : <span>Now {now ?? "empty"}</span>}
          </div>
        )}
      </div>
      <Button
        aria-label={`Revert ${header} for ${record}`}
        disabled={busy}
        intent="ghost"
        leading={<Undo aria-hidden className="size-[var(--size-icon-sm)]" />}
        size="xs"
        onClick={onRevert}
      >
        Revert
      </Button>
    </li>
  );
}

/**
 * The staged-change log, as the top bar's Staged changes pane: every staged
 * entry, agent turns by time then "Your edits". Choosing an entry shows its
 * cell on the canvas. Revert one change, a whole agent turn (after a
 * confirmation) or all of the agent's changes (also confirmed).
 */
export function StagedLog(props: {
  client: CanvasClient;
  session: CanvasSession;
  /** Shows an entry's cell on the canvas; entries are plain text without it. */
  onShow?: (entry: WorkChange) => void;
  /** Entries to mark and scroll to, e.g. the ones a toast's View named. */
  focus?: readonly WorkTarget[] | null;
  /** Set when Save opened the log: this many staged changes are not on the canvas. */
  hidden?: number;
  /** Shows the staged changes' impact under the summary, named with the log's own names. */
  impact?: boolean;
}) {
  const { client, session, onShow, focus, hidden = 0, impact = false } = props;
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const names = useRecordNames(client, {
    sessionId: session.session?.id ?? "",
    asOf: session.session?.as_of ?? null,
    generation: session.generation,
    entries: session.entries,
  });
  const focused = useMemo(() => new Set((focus ?? []).map(entryKey)), [focus]);
  const list = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (focused.size === 0) return;
    list.current
      ?.querySelector<HTMLElement>("[data-focused]")
      ?.scrollIntoView?.({ block: "nearest" });
  }, [focused]);
  /** What discarding the agent's changes removes: everything it staged, pulled proposals included. */
  const agentCount = session.entries.filter((entry) => entry.source === "agent").length;
  const pulledCount = session.entries.filter(
    (entry) => entry.source === "agent" && entry.turn_id === undefined,
  ).length;
  /** The user's own staged values; pulled proposals count as the agent's, as Discard treats them. */
  const yours = session.entries.length - agentCount;
  const groups = useMemo(() => {
    let turns = 0;
    return session.groups.map((group) => ({
      ...group,
      number: group.turn_id === null ? 0 : (turns += 1),
      entries: group.entries.toSorted((a, b) => {
        const left = entryLabel(names, a);
        const right = entryLabel(names, b);
        return left.record.localeCompare(right.record) || left.header.localeCompare(right.header);
      }),
    }));
  }, [session.groups, names]);

  const run = async (action: () => Promise<CanvasOutcome>, success?: string) => {
    setBusy(true);
    try {
      const outcome = await action();
      if (!outcome.ok) toast.warning(revertFailure(outcome));
      else if (success !== undefined) toast.success(success);
      return outcome;
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (confirming === null) return;
    const outcome =
      confirming.kind === "turn"
        ? await run(
            () => session.discardTurn(confirming.group.turn_id!),
            `Reverted agent turn ${confirming.number}`,
          )
        : await run(() => session.discardAgent(), "Discarded the agent's changes");
    if (outcome.ok || outcome.code !== "outcome_unknown") setConfirming(null);
  };

  return (
    <section
      aria-label="Unsaved changes"
      className="flex min-h-[var(--space-0)] flex-col"
      data-staged-log
    >
      <header
        className="flex items-center gap-[var(--space-2)] border-b border-[var(--color-border-subtle)] px-[var(--space-4)] py-[var(--space-3)]"
        data-staged-summary
      >
        <h2 className="m-[var(--space-0)] shrink-0 whitespace-nowrap text-[length:var(--text-control-md)] font-[var(--font-weight-semibold)] text-[var(--color-text-primary)]">
          Unsaved changes
        </h2>
        <Tag label={session.entries.length} tone={session.entries.length > 0 ? "blue" : "gray"} />
        {session.entries.length > 0 ? (
          <span className="ml-auto min-w-[var(--space-0)] truncate text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
            {[
              agentCount > 0 ? `${agentCount} by the agent` : null,
              yours > 0 ? `${yours} yours` : null,
            ]
              .filter((part) => part !== null)
              .join(" · ")}
          </span>
        ) : null}
      </header>
      {impact && session.entries.length > 0 ? (
        <div className="border-b border-[var(--color-border-subtle)]">
          <ImpactStrip client={client} names={names} session={session} />
        </div>
      ) : null}
      {hidden > 0 ? (
        <div
          className="border-b border-[var(--color-border-subtle)] bg-[var(--color-status-warning-bg)] px-[var(--space-4)] py-[var(--space-2-5)] text-[length:var(--text-control-sm)] leading-[var(--leading-body)] text-[var(--color-status-warning-ink)]"
          data-hidden-warning={hidden}
          role="status"
        >
          <span className="font-[var(--font-weight-semibold)]">
            {plural(hidden, "unsaved change")} not shown on canvas — review
          </span>
          <span className="block text-[length:var(--text-caption)]">
            They are marked below. Save again to save every unsaved change.
          </span>
        </div>
      ) : null}
      {session.entries.length === 0 ? (
        <p className="m-[var(--space-0)] px-[var(--space-4)] py-[var(--space-4)] text-[length:var(--text-control-sm)] text-[var(--color-text-muted)]">
          No unsaved changes. Edits you or the agent make show here until you Save.
        </p>
      ) : (
        <div
          className="max-h-[min(32rem,60vh)] overflow-y-auto px-[var(--space-4)] pb-[var(--space-2)]"
          ref={list}
        >
          {groups.map((group) => {
            const agent = group.turn_id !== null;
            const { number } = group;
            return (
              <div data-staged-group={agent ? "agent" : "yours"} key={group.turn_id ?? "yours"}>
                <div className="sticky top-[var(--space-0)] z-[1] flex items-center gap-[var(--space-2)] border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] pb-[var(--space-1-5)] pt-[var(--space-3)]">
                  <span className="shrink-0 whitespace-nowrap text-[length:var(--text-caption)] font-[var(--font-weight-semibold)] text-[var(--color-text-secondary)]">
                    {agent ? `Agent turn ${number}` : "Your edits"}
                  </span>
                  <span className="min-w-[var(--space-0)] truncate text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
                    {agent ? `${formatTime(group.at)} · ` : ""}
                    {plural(group.entries.length, "change")}
                  </span>
                  {agent ? (
                    <Button
                      className="ml-auto shrink-0 whitespace-nowrap"
                      disabled={busy}
                      intent="ghost"
                      size="xs"
                      onClick={() => setConfirming({ kind: "turn", group, number })}
                    >
                      Revert turn
                    </Button>
                  ) : null}
                </div>
                <ul className="m-[var(--space-0)] list-none divide-y divide-[var(--color-border-subtle)] p-[var(--space-0)]">
                  {group.entries.map((entry) => (
                    <StagedEntry
                      busy={busy}
                      entry={entry}
                      focused={focused.has(entryKey(entry))}
                      key={entryKey(entry)}
                      names={names}
                      session={session}
                      onRestore={() =>
                        void run(() => session.restore(entry), "Restored your value")
                      }
                      onRevert={() => void run(() => session.unstage(entry, entry))}
                      onShow={onShow === undefined ? undefined : () => onShow(entry)}
                    />
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
      {agentCount > 0 ? (
        <div className="flex justify-end border-t border-[var(--color-border-subtle)] px-[var(--space-4)] py-[var(--space-2)]">
          <Button
            disabled={busy}
            intent="ghost"
            size="xs"
            onClick={() => setConfirming({ kind: "agent" })}
          >
            Discard all of the agent's changes
          </Button>
        </div>
      ) : null}
      <Modal
        actions={
          <div className="flex justify-end gap-[var(--space-2)]">
            <Button intent="secondary" size="sm" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button intent="danger" loading={busy} size="sm" onClick={() => void confirm()}>
              {confirming?.kind === "turn" ? "Revert turn" : "Discard the agent's changes"}
            </Button>
          </div>
        }
        open={confirming !== null}
        size="sm"
        title={
          confirming?.kind === "turn"
            ? `Revert agent turn ${confirming.number}?`
            : "Discard all of the agent's changes?"
        }
        onClose={() => setConfirming(null)}
      >
        <p className="m-[var(--space-0)] text-[length:var(--text-body)] leading-[var(--leading-prose)] text-[var(--color-text-secondary)]">
          {confirming?.kind === "turn"
            ? `This removes the ${plural(confirming.group.entries.length, "unsaved value")} this turn set. It does not bring back values that an earlier turn or you had set in the same cells before it.`
            : `This removes all ${plural(agentCount, "unsaved value")} the agent has set in this session${pulledCount > 0 ? `, including ${pulledCount} you pulled from a thread` : ""}. Your own edits stay. It does not bring back values the agent replaced.`}
        </p>
      </Modal>
    </section>
  );
}
