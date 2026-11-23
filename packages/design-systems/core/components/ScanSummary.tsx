import type { ReactNode } from "react";
import type { IconComponent } from "../icons";
import { cx } from "./utils";

/*
 * ScanSummary: the banner above a review surface that says how far an automatic
 * pass got and how much is left for a person.
 *
 * It is a design-system component rather than an app one because the shape is
 * the same wherever an agent pre-answers a queue: a readiness ring, then a rail
 * of steps from "the machine finished" to "here is what it costs you". Nothing
 * here knows what kind of records the queue contains.
 *
 * Every label and value is rendered plainly -- no hover, no tooltip, no
 * disclosure. A number a reader has to uncover is a number they will not check.
 */

export type ScanSummaryStepState = "done" | "pending";

export type ScanSummaryStep = Readonly<{
  /** Stable across renders. Falls back to position when a caller has none. */
  id?: string;
  icon: IconComponent;
  /** The fact itself, e.g. "12 decisions remaining". Always a whole statement. */
  label: ReactNode;
  /** What the fact counts, e.g. "Across 5 review areas". */
  detail?: ReactNode;
  /** `done` fills the marker; `pending` leaves it waiting. Defaults to done. */
  state?: ScanSummaryStepState;
}>;

export type ScanSummaryProps = {
  /** Share of the queue the scan settled, 0..1. Values outside are clamped. */
  progress: number;
  /** Spoken form of the ring, e.g. "412 of 1592 transactions settled". */
  progressLabel: string;
  /** The word under the percentage. Defaults to "ready". */
  progressCaption?: string;
  steps: readonly ScanSummaryStep[];
  actions?: ReactNode;
  /** A caveat the reader must see, e.g. records the scan could not judge. */
  note?: ReactNode;
  className?: string;
};

export function ScanSummary(props: ScanSummaryProps) {
  const {
    progress,
    progressLabel,
    progressCaption = "ready",
    steps,
    actions,
    note,
    className,
  } = props;
  return (
    <section
      data-scan-summary
      className={cx(
        "flex flex-col gap-[var(--space-6)] rounded-[var(--radius-banner)] bg-[var(--color-bg-surface)] px-[var(--space-8)] py-[var(--space-6)] shadow-[var(--shadow-banner)] sm:flex-row sm:items-center",
        className,
      )}
    >
      <ProgressRing progress={progress} label={progressLabel} caption={progressCaption} />
      <div
        aria-hidden="true"
        className="hidden w-px self-stretch bg-[var(--color-border-subtle)] sm:block"
      />
      <div className="flex min-w-[var(--space-0)] flex-1 flex-col gap-[var(--space-3)]">
        <ol
          data-scan-summary-rail
          className="flex flex-col gap-[var(--space-4)] sm:flex-row sm:items-center sm:gap-[var(--space-6)]"
        >
          {steps.map((step, index) => (
            <Step
              key={step.id ?? index}
              step={step}
              // The connector belongs to the step on its left and is coloured by
              // that step: a filled bar means the work behind it is finished.
              connector={index < steps.length - 1 ? (step.state ?? "done") : null}
            />
          ))}
        </ol>
        {note ? (
          <p className="text-[length:var(--text-micro)] text-[var(--color-status-warning-ink)]">
            {note}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-[var(--space-2)]">{actions}</div>
      ) : null}
    </section>
  );
}

function Step({
  step,
  connector,
}: {
  step: ScanSummaryStep;
  connector: ScanSummaryStepState | null;
}) {
  const { icon: Icon, label, detail, state = "done" } = step;
  const done = state === "done";
  return (
    <li className="flex min-w-[var(--space-0)] flex-1 items-center gap-[var(--space-3)]">
      <span
        data-scan-summary-marker
        data-state={state}
        className={cx(
          "grid size-[var(--size-step-marker)] shrink-0 place-items-center rounded-[var(--radius-pill)]",
          done
            ? "bg-[var(--color-action-primary)] text-[var(--color-text-inverse)]"
            : "bg-[var(--color-bg-accent-soft)] text-[var(--color-action-primary)]",
        )}
      >
        <Icon aria-hidden="true" className="size-[var(--size-icon-md)]" />
        {/*
         * The marker says "done" or "waiting" by fill colour and by an icon
         * that is hidden from assistive technology, which leaves a finished
         * step and an unfinished one reading identically. A rail whose whole
         * job is to show how far the pass got cannot be a rail that only
         * sighted readers can follow.
         */}
        <span className="sr-only">{done ? "Done: " : "Waiting: "}</span>
      </span>
      <span className="flex min-w-[var(--space-0)] flex-col gap-[var(--space-0-5)]">
        <span className="text-[length:var(--text-control-sm)] font-[var(--font-weight-semibold)] text-[var(--color-text-secondary)]">
          {label}
        </span>
        {detail ? (
          <span className="text-[length:var(--text-micro)] text-[var(--color-text-muted)]">
            {detail}
          </span>
        ) : null}
      </span>
      {connector ? (
        <span
          aria-hidden="true"
          className={cx(
            "hidden h-[var(--space-0-5)] min-w-[var(--space-0)] flex-1 rounded-[var(--radius-xs)] sm:block",
            connector === "done"
              ? "bg-[var(--color-action-primary)]"
              : "bg-[var(--color-border-subtle)]",
          )}
        />
      ) : null}
    </li>
  );
}

const RING_RADIUS = 34;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function ProgressRing({
  progress,
  label,
  caption,
}: {
  progress: number;
  label: string;
  caption: string;
}) {
  const settled = Number.isFinite(progress) ? Math.min(Math.max(progress, 0), 1) : 0;
  // Round toward "not finished": 99.6% settled must not read as 100%, because
  // the difference is precisely the rows a person still has to answer.
  const percent = settled === 1 ? 100 : Math.min(99, Math.floor(settled * 100));
  return (
    <div
      data-scan-summary-ring
      role="img"
      aria-label={label}
      className="relative grid size-[var(--size-progress-ring)] shrink-0 place-items-center"
    >
      <svg viewBox="0 0 80 80" className="size-full -rotate-90" aria-hidden="true">
        <circle
          cx="40"
          cy="40"
          r={RING_RADIUS}
          fill="none"
          strokeWidth="8"
          className="stroke-[var(--color-bg-accent-soft)]"
        />
        <circle
          cx="40"
          cy="40"
          r={RING_RADIUS}
          fill="none"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={RING_CIRCUMFERENCE * (1 - settled)}
          className="stroke-[var(--color-action-primary)]"
        />
      </svg>
      <span
        aria-hidden="true"
        className="absolute grid place-items-center leading-[var(--leading-micro)]"
      >
        <span className="text-[length:var(--text-section-title)] font-[var(--font-weight-semibold)] text-[var(--color-text-primary)] [font-variant-numeric:tabular-nums]">
          {percent}%
        </span>
        <span className="text-[length:var(--text-micro)] text-[var(--color-text-muted)]">
          {caption}
        </span>
      </span>
    </div>
  );
}
