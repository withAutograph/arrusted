// StageConfirmation — the approve-to-stage affordance.
//
// A settled, checked draft proposal rendered as a chat preview with a primary
// "Add to grid" action and a "Discard" action.
//
// SEMANTICS (load-bearing): this gates STAGING — committing the draft into the
// editable-grid buffer where human edits live — NOT a kernel write. The
// canonical write is still grid-Save, and this never implies a write landed.
//
// COPY vs INTERNALS: user-facing copy says "Add to grid" / "Added" (plain
// workplace language). The internal vocabulary — the `onStage` prop, `staged`
// state, `StageProposalView` — deliberately keeps the staging terms; only the
// rendered strings change.

import type { ReactNode } from "react";

import { CheckCircleSolid, Trash } from "@autograph/icons";
import { Button, cx } from "@autograph/components";

import type { StageProposalView } from "./types";

/**
 * Copy overrides for hosts whose staging surface is not "the grid" (e.g. a
 * canvas session's staged changes). Absent keys keep the default copy.
 */
export type StageConfirmationLabels = {
  /** Before the change count while pending. Default "Ready to add". */
  ready?: string;
  /** Before the change count once staged. Default "Added". */
  done?: string;
  /** The primary action. Default "Add to grid". */
  stage?: string;
  /** The secondary action. Default "Discard". */
  discard?: string;
  /** The line shown once staged. Default "Added to the grid — review, then Save to apply." */
  doneNote?: string;
};

export type StageConfirmationProps = {
  proposal: StageProposalView;
  /** Copy for hosts that stage somewhere other than a grid; see `StageConfirmationLabels`. */
  labels?: StageConfirmationLabels;
  /**
   * Host-rendered detail under the headline, e.g. one row per change with its
   * own action. The host owns its content; the card only places it.
   */
  details?: ReactNode;
  onStage: () => void;
  onDiscard: () => void;
  /** True once staged; the banner settles into a done state and hides actions. */
  staged?: boolean;
  /** True while the stage action is in flight. */
  staging?: boolean;
  className?: string;
};

// Cap how many target chips the leaf renders so an unbounded proposal (the
// agent could target dozens of rows) cannot blow out the panel height. The
// remainder collapses into a "+N more" chip.
const MAX_VISIBLE_TARGETS = 6;

// Same guard for the partial-add failure list — a repair-exhausted set could
// carry many failures; cap the rendered rows with a "+N more" overflow.
const MAX_VISIBLE_FAILURES = 6;

export function StageConfirmation(props: StageConfirmationProps) {
  const { proposal, onStage, onDiscard, staged, staging, className, labels, details } = props;
  // Partial-add (§6): after repair exhausts, offer the passing subset. Additive
  // — absent `partial` leaves every existing behavior untouched.
  const partial = proposal.partial;
  const changeLabel = `${proposal.changeCount} ${
    proposal.changeCount === 1 ? "change" : "changes"
  }`;
  const stageLabel = partial
    ? `Add the ${partial.passedCount} that passed`
    : (labels?.stage ?? "Add to grid");
  const visibleTargets = proposal.targets.slice(0, MAX_VISIBLE_TARGETS);
  const visibleTargetsWithKeys = keyedValues(visibleTargets);
  const visibleFailuresWithKeys = partial
    ? keyedFailures(partial.failures.slice(0, MAX_VISIBLE_FAILURES))
    : [];
  // Overflow counts against the TRUE target count when the app capped the
  // list it passed, so a 50-row proposal doesn't read as "+6 more".
  const totalTargets = Math.max(proposal.targetCount ?? 0, proposal.targets.length);
  const overflowCount = totalTargets - visibleTargets.length;
  return (
    <div
      className={cx(
        "flex flex-col gap-[var(--space-3)] rounded-[var(--radius-panel)] border",
        "px-[var(--space-4)] py-[var(--space-3)]",
        staged
          ? "border-[var(--color-status-success)] bg-[var(--color-status-success-bg)]"
          : "border-[var(--color-border-strong)] bg-[var(--color-bg-surface)] shadow-[var(--shadow-subtle)]",
        className,
      )}
    >
      <div className="flex items-start gap-[var(--space-2-5)]">
        <CheckCircleSolid
          aria-hidden="true"
          className={cx(
            "mt-[var(--space-0-5)] size-[var(--size-icon-md)] shrink-0",
            staged ? "text-[var(--color-status-success)]" : "text-[var(--color-action-primary)]",
          )}
        />
        {/* With host details, the content column takes the card's width so
            per-row actions align to the card's edge. */}
        <div
          className={cx(
            "flex min-w-[var(--space-0)] flex-col gap-[var(--space-2)]",
            details !== undefined && "flex-1",
          )}
        >
          <div className="flex flex-col gap-[var(--space-0-5)]">
            <p className="text-[length:var(--text-control-md)] font-[var(--font-weight-semibold)] leading-[var(--leading-body)] text-[var(--color-text-primary)]">
              {staged ? (labels?.done ?? "Added") : (labels?.ready ?? "Ready to add")} {changeLabel}
            </p>
            <p className="text-[length:var(--text-caption)] leading-[var(--leading-caption)] text-[var(--color-text-secondary)]">
              {proposal.headline}
            </p>
          </div>
          {visibleTargets.length > 0 ? (
            <p className="flex flex-wrap items-center gap-x-[var(--space-1-5)] gap-y-[var(--space-1)] text-[length:var(--text-caption)] leading-[var(--leading-caption)] text-[var(--color-text-muted)]">
              {visibleTargetsWithKeys.map(({ key, value: target }, index) => (
                <span key={key} className="inline-flex items-center gap-[var(--space-1-5)]">
                  {index > 0 ? (
                    <span aria-hidden="true" className="text-[var(--color-text-disabled)]">
                      ·
                    </span>
                  ) : null}
                  <span className="font-[var(--font-weight-normal)] text-[var(--color-text-muted)]">
                    {target}
                  </span>
                </span>
              ))}
              {overflowCount > 0 ? (
                <span className="inline-flex items-center gap-[var(--space-1-5)]">
                  <span aria-hidden="true" className="text-[var(--color-text-disabled)]">
                    ·
                  </span>
                  <span className="font-[var(--font-weight-normal)] text-[var(--color-text-muted)]">
                    +{overflowCount} more
                  </span>
                </span>
              ) : null}
            </p>
          ) : null}
          {proposal.verdict ? (
            <p className="text-[length:var(--text-caption)] leading-[var(--leading-caption)] text-[var(--color-text-muted)]">
              {proposal.verdict}
            </p>
          ) : null}
          {details}
          {partial && !staged ? (
            <div className="flex flex-col gap-[var(--space-1)] rounded-[var(--radius-control)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-muted)] px-[var(--space-3)] py-[var(--space-2)]">
              <p className="text-[length:var(--text-caption)] font-[var(--font-weight-medium)] leading-[var(--leading-caption)] text-[var(--color-text-secondary)]">
                {partial.failures.length}{" "}
                {partial.failures.length === 1 ? "change didn't pass" : "changes didn't pass"} —
                left out
              </p>
              <ul className="flex flex-col gap-[var(--space-0-5)]">
                {visibleFailuresWithKeys.map(({ key, failure }) => (
                  <li
                    key={key}
                    className="flex flex-wrap items-baseline gap-x-[var(--space-1-5)] text-[length:var(--text-caption)] leading-[var(--leading-caption)]"
                  >
                    <span className="font-[var(--font-weight-normal)] text-[var(--color-text-primary)]">
                      {failure.target}
                    </span>
                    <span className="text-[var(--color-text-muted)]">{failure.reason}</span>
                  </li>
                ))}
                {partial.failures.length > MAX_VISIBLE_FAILURES ? (
                  <li className="text-[length:var(--text-caption)] leading-[var(--leading-caption)] text-[var(--color-text-muted)]">
                    +{partial.failures.length - MAX_VISIBLE_FAILURES} more
                  </li>
                ) : null}
              </ul>
            </div>
          ) : null}
          {staged ? (
            <p className="text-[length:var(--text-caption)] leading-[var(--leading-caption)] text-[var(--color-status-success)]">
              {labels?.doneNote ?? "Added to the grid — review, then Save to apply."}
            </p>
          ) : null}
        </div>
      </div>
      {staged ? null : (
        <div className="flex items-center justify-end gap-[var(--space-2)] border-t border-[var(--color-border-subtle)] pt-[var(--space-3)]">
          <Button
            intent="ghost"
            size="sm"
            onClick={onDiscard}
            disabled={staging}
            leading={<Trash aria-hidden="true" className="size-[var(--size-icon-sm)]" />}
          >
            {labels?.discard ?? "Discard"}
          </Button>
          <Button intent="primary" size="sm" onClick={onStage} loading={staging}>
            {stageLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

function keyedValues(values: readonly string[]): Array<{ key: string; value: string }> {
  const seen = new Map<string, number>();
  return values.map((value) => {
    const count = seen.get(value) ?? 0;
    seen.set(value, count + 1);
    return { key: `${value}:${count}`, value };
  });
}

function keyedFailures(
  failures: readonly { target: string; reason: string }[],
): Array<{ key: string; failure: { target: string; reason: string } }> {
  const seen = new Map<string, number>();
  return failures.map((failure) => {
    const baseKey = `${failure.target}:${failure.reason}`;
    const count = seen.get(baseKey) ?? 0;
    seen.set(baseKey, count + 1);
    return { key: `${baseKey}:${count}`, failure };
  });
}
