import { useState } from "react";
import { createPortal } from "react-dom";
import type { WorkChange } from "@autograph/generated-app-runtime/data";
import { Button, Modal, Tag, useToast } from "@autograph/components";
import type { CanvasClient } from "./client";
import { entryLabel, formatValue, useRecordNames } from "./review-labels";
import { entryProblem } from "./staged-log";
import type { CanvasSession, SaveOutcome } from "./use-canvas-session";

const changes = (count: number) => `${count} change${count === 1 ? "" : "s"}`;

/**
 * A Save outcome as a toast: what happened and what to do next. Nothing is
 * re-applied. `written` leaves out changes to removed records, which Save
 * clears without writing. Every Save writes a draft that waits for approval;
 * an approver's Save and approve publishes it too.
 */
export function saveToast(
  outcome: SaveOutcome,
  written: number,
): { variant: "success" | "warning" | "error"; message: string } {
  if (outcome.ok && written === 0)
    return {
      variant: "warning",
      message: "Nothing was saved: those records were removed, so their changes were cleared.",
    };
  // Every change was already at its saved value (e.g. an agent's revert of yours).
  if (outcome.ok && outcome.changeSetId === null)
    return {
      variant: "success",
      message: "Nothing to save: the changes were already at their saved values.",
    };
  if (outcome.ok && outcome.published)
    return { variant: "success", message: `Saved and published #${outcome.changeSetId}` };
  if (outcome.ok && outcome.approveFailure !== undefined)
    return {
      variant: "warning",
      message: `Saved as draft #${outcome.changeSetId}, but it was not published: ${outcome.approveFailure.message} It waits for approval in Review.`,
    };
  if (outcome.ok)
    return {
      variant: "success",
      message: `Saved as draft #${outcome.changeSetId}, pending approval`,
    };
  switch (outcome.code) {
    case "revision_conflict":
      return {
        variant: "warning",
        message: "The session changed before your Save. Review what changed, then Save again.",
      };
    case "stale_base":
      return {
        variant: "warning",
        message: "Some records changed again before your Save. Review them, then Save again.",
      };
    case "outcome_unknown":
      return {
        variant: "warning",
        message:
          "We couldn't confirm your Save. The session was re-read; check the unsaved changes before you Save again.",
      };
    default:
      return { variant: "error", message: outcome.message };
  }
}

/**
 * Save: the count and the button; every Save writes a draft for review. An
 * approver also gets Save and approve, which saves the draft and publishes
 * it in one action. Stale or gone entries are listed for the user to confirm
 * before Save passes them as confirmed; outcomes show as toasts.
 */
export function SaveBar(props: {
  client: CanvasClient;
  session: CanvasSession;
  /** A Save completed: the canvas re-reads what it saved (its drafts' threads). */
  onSaved?: () => void;
  /**
   * Asked before every Save, with the revision shown; false stops it (the
   * canvas shows what it would include first, e.g. changes not on the canvas).
   */
  beforeSave?: (revision: number) => boolean;
  /**
   * Where the agent's open request to Save shows: a full-width strip the
   * canvas places under its top bar. Without it the request is not shown.
   */
  requestSlot?: HTMLElement | null;
}) {
  const { client, session, onSaved, beforeSave, requestSlot } = props;
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  /** Only an approver may publish, so only they get Save and approve; the host decides. */
  const canApprove = client.drafts?.canApprove === true;
  /** The revision, count and entries to check, as shown when the confirmation opened. */
  const [confirming, setConfirming] = useState<{
    revision: number;
    count: number;
    entries: readonly WorkChange[];
    approve: boolean;
  } | null>(null);
  const names = useRecordNames(client, {
    sessionId: session.session?.id ?? "",
    asOf: session.session?.as_of ?? null,
    generation: session.generation,
    entries: session.entries,
  });
  const count = session.entries.length;
  const flagged = session.entries.filter((entry) => entryProblem(entry) !== null);
  const request = session.saveRequest;
  const [declining, setDeclining] = useState(false);
  /**
   * The person's Save, from the bar or from the agent's request; `approve`
   * is an approver's Save and approve.
   */
  const startSave = (approve = false) => {
    const revision = session.revision;
    if (revision === null) return;
    if (beforeSave !== undefined && !beforeSave(revision)) return;
    if (flagged.length > 0) setConfirming({ revision, count, entries: flagged, approve });
    else void save({ revision, count, entries: [], approve });
  };

  /** Saves the revision the user saw, with its count, so nothing unreviewed is saved. */
  const save = async (shown: {
    revision: number;
    count: number;
    entries: readonly WorkChange[];
    approve: boolean;
  }) => {
    setSaving(true);
    try {
      const outcome = await session.save(shown.revision, shown.entries, {
        approve: shown.approve,
      });
      if (outcome.ok) onSaved?.();
      const written = shown.count - shown.entries.filter((entry) => entry.gone).length;
      const toastShown = saveToast(outcome, written);
      toast[toastShown.variant](toastShown.message);
      setConfirming(null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-center gap-[var(--space-3)]" data-save-bar>
      {request === null || requestSlot == null
        ? null
        : createPortal(
            <div
              className="flex w-full items-center gap-[var(--space-4)] border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-accent-soft)] px-[var(--space-5)] py-[var(--space-2)]"
              data-save-request
              role="status"
            >
              <div className="flex min-w-[var(--space-0)] flex-1 flex-col gap-[var(--space-0-5)]">
                <p
                  className="m-[var(--space-0)] line-clamp-2 text-[length:var(--text-control-sm)] text-[var(--color-text-primary)]"
                  title={request.reason}
                >
                  The agent asks to Save: {request.reason}
                </p>
                {session.revision !== null && session.revision > request.revision ? (
                  <p className="m-[var(--space-0)] text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
                    The session changed since the agent asked
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-[var(--space-2)]">
                <Button
                  className="shrink-0 whitespace-nowrap"
                  data-save-request-save
                  disabled={count === 0 || saving || session.status !== "ready"}
                  intent="primary"
                  size="sm"
                  onClick={() => startSave()}
                >
                  {saving ? "Saving…" : "Save"}
                </Button>
                <Button
                  className="shrink-0 whitespace-nowrap"
                  data-save-request-decline
                  disabled={declining || saving}
                  intent="secondary"
                  loading={declining}
                  size="sm"
                  onClick={() => {
                    setDeclining(true);
                    void session
                      .declineSaveRequest(request.id)
                      .then((outcome) => {
                        if (!outcome.ok) toast.warning(outcome.message);
                      })
                      .finally(() => setDeclining(false));
                  }}
                >
                  Not now
                </Button>
              </div>
            </div>,
            requestSlot,
          )}
      {flagged.length > 0 ? <Tag label={`${flagged.length} to check`} tone="amber" /> : null}
      {canApprove ? (
        <Button
          className="shrink-0 whitespace-nowrap"
          data-save-approve-button
          disabled={count === 0 || saving || session.status !== "ready"}
          intent="secondary"
          size="sm"
          title="Saves a draft and publishes it"
          aria-label={count === 0 ? "Save and approve" : `Save and approve ${changes(count)}`}
          onClick={() => startSave(true)}
        >
          Save and approve
        </Button>
      ) : null}
      <Button
        data-save-button
        disabled={count === 0 || saving || session.status !== "ready"}
        intent="primary"
        size="sm"
        title="Saves a draft for review"
        // The unsaved-changes pill shows the count; the button says Save (its name keeps the count).
        aria-label={
          saving && confirming === null
            ? "Saving…"
            : count === 0
              ? "Save"
              : `Save ${changes(count)}`
        }
        onClick={() => startSave()}
      >
        {/* One clear state while it saves; the toast says how it went. */}
        {saving && confirming === null ? "Saving…" : "Save"}
      </Button>
      <Modal
        actions={
          <div className="flex justify-end gap-[var(--space-2)]">
            <Button intent="secondary" size="sm" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button
              intent="primary"
              loading={saving}
              size="sm"
              onClick={() => confirming !== null && void save(confirming)}
            >
              {confirming?.approve === true ? "Save and approve" : "Save"}{" "}
              {changes(confirming?.count ?? count)}
            </Button>
          </div>
        }
        description="These changed after the edits were made. Save writes your edits over changed records and leaves out removed ones."
        open={confirming !== null}
        size="sm"
        title={`Check ${changes(confirming?.entries.length ?? 0)} before you Save`}
        onClose={() => setConfirming(null)}
      >
        <ul className="m-[var(--space-0)] flex list-none flex-col divide-y divide-[var(--color-border-subtle)] p-[var(--space-0)]">
          {(confirming?.entries ?? []).map((entry) => {
            const { record, header } = entryLabel(names, entry);
            const field = names.labels.fieldById(
              names.labels.modelById(entry.model_id),
              entry.field_id,
            );
            const now = entry.gone ? null : formatValue(names, field, entry.current_value);
            return (
              <li
                className="flex flex-wrap items-center gap-x-[var(--space-2)] gap-y-[var(--space-0-5)] py-[var(--space-2)] text-[length:var(--text-control-sm)]"
                key={JSON.stringify([entry.model_id, entry.record_id, entry.field_id])}
              >
                <span className="font-[var(--font-weight-medium)] text-[var(--color-text-primary)]">
                  {record}
                </span>
                <span className="text-[var(--color-text-muted)]">{header}</span>
                <Tag label={entryProblem(entry)} tone={entry.gone ? "red" : "amber"} />
                <span className="basis-full text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
                  {entry.gone
                    ? "Left out of the Save."
                    : `Now ${now ?? "empty"}; Save writes ${formatValue(names, field, entry.value) ?? "empty"}.`}
                </span>
              </li>
            );
          })}
        </ul>
      </Modal>
    </div>
  );
}
