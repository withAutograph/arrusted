// StatusTicker — the cumulative status narrator for one agent turn (§3).
//
// Consumes an ORDERED array of ticker steps (phases, tool calls, repair
// attempts) the app pre-humanizes from its wire events. Two states:
//
//   • Collapsed (default): ONE line.
//       - running  → the latest step's label, shimmering (existing
//         `.shimmer-text`; the motion IS the signal, no icons).
//       - settled  → a quiet "Worked for Xs · N steps" (no shimmer).
//   • Expanded (disclosure chevron): the FULL accumulated step list in order —
//     every tool call with its outcome (reusing `ToolCallRow`), every phase,
//     every repair attempt.
//
// After the turn settles the tool rows live HERE (the transcript fold-in): the
// agent bubble renders prose + cards only, and this disclosure becomes the
// turn's audit surface. Both collapsed states stay expandable.
//
// Leaf boundary: purely presentational. Steps + labels arrive already
// humanized; this never parses raw tool args/results.

import { useState } from "react";

import { ChevronDown, ChevronRight } from "@autograph/icons";
import { cx } from "@autograph/components";

import { ToolCallRow } from "./ToolCallRow";
import type { TickerState, TickerStep } from "./types";

export type StatusTickerProps = {
  ticker: TickerState;
  /** Start expanded. Defaults to collapsed. */
  defaultExpanded?: boolean;
  className?: string;
};

// The label the collapsed running line shows: the latest step's line. A phase
// carries its own label; a tool step reads as its (running or settled) title.
// Empty steps (the pre-first-event beat) fall back to a generic working line.
function latestLabel(steps: readonly TickerStep[]): string {
  const last = steps[steps.length - 1];
  if (!last) return "Working…";
  return last.kind === "phase" ? last.label : last.tool.title;
}

function settledSummary(ticker: TickerState): string {
  const n = ticker.steps.length;
  const stepsLabel = `${n} ${n === 1 ? "step" : "steps"}`;
  if (ticker.elapsedMs == null) return stepsLabel;
  const seconds = Math.max(1, Math.round(ticker.elapsedMs / 1000));
  return `Worked for ${seconds}s · ${stepsLabel}`;
}

function PhaseStep(props: { step: Extract<TickerStep, { kind: "phase" }> }) {
  return (
    <div className="flex items-baseline gap-[var(--space-1-5)] py-[var(--space-0-5)]">
      <span
        aria-hidden="true"
        className="text-[var(--color-text-disabled)] leading-[var(--leading-caption)]"
      >
        ·
      </span>
      <span className="text-[length:var(--text-caption)] leading-[var(--leading-caption)] text-[var(--color-text-secondary)]">
        {props.step.label}
      </span>
    </div>
  );
}

export function StatusTicker(props: StatusTickerProps) {
  const { ticker, defaultExpanded, className } = props;
  const [expanded, setExpanded] = useState(defaultExpanded ?? false);

  const collapsedLine = ticker.running ? latestLabel(ticker.steps) : settledSummary(ticker);
  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <div
      className={cx(
        "flex flex-col gap-[var(--space-1)]",
        // A quiet sub-block beneath the agent's prose, not a boxed card.
        className,
      )}
      role="group"
      aria-label="Agent progress"
    >
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        className={cx(
          "flex w-fit min-w-[var(--space-0)] items-baseline gap-[var(--space-1)]",
          "rounded-[var(--radius-control)] text-left",
          "hover:text-[var(--color-text-primary)]",
        )}
      >
        <Chevron
          aria-hidden="true"
          className="size-[var(--size-icon-xs)] shrink-0 translate-y-[var(--space-0-5)] text-[var(--color-text-disabled)]"
        />
        <span
          className={cx(
            "text-[length:var(--text-caption)] leading-[var(--leading-caption)]",
            ticker.running ? "shimmer-text" : "text-[var(--color-text-muted)]",
          )}
        >
          {collapsedLine}
        </span>
      </button>

      {expanded ? (
        <div
          className={cx(
            "flex flex-col gap-[var(--space-0-5)]",
            // Indent the accumulated list under the disclosure line.
            "pl-[var(--space-4)]",
            "motion-safe:animate-[chat-in_150ms_ease-out]",
          )}
        >
          {ticker.steps.length === 0 ? (
            <span className="py-[var(--space-0-5)] text-[length:var(--text-caption)] leading-[var(--leading-caption)] text-[var(--color-text-disabled)]">
              No steps yet.
            </span>
          ) : (
            ticker.steps.map((step) =>
              step.kind === "phase" ? (
                <PhaseStep key={step.id} step={step} />
              ) : (
                <ToolCallRow key={step.id} tool={step.tool} />
              ),
            )
          )}
        </div>
      ) : null}
    </div>
  );
}
