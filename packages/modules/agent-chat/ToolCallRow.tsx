// ToolCallRow — a single agent tool call, rendered DOMAIN-READABLE.
//
// The app maps its raw `{toolName, args, result, status}` onto a `ToolCallView`
// ("Searched positions · dept = Engineering → 3 found") at the call site; this
// leaf never parses args/results itself. Raw-JSON tool viewers are rejected by
// the spec — the readable line IS the better review UX.
//
// Renders inline inside an agent message (the "tool-call-nested-in-assistant-
// message" pattern) via MessageParts, or standalone in a gallery.
//
// L3 in the type hierarchy: a tool call is a quiet sub-step BENEATH the agent's
// prose. No persistent iconography — a running step shimmers (the motion IS the
// signal), a done step is a flat muted caption, and only an error carries a
// single compact glyph plus danger color.

import { Close } from "@autograph/icons";
import { cx } from "@autograph/components";

import type { ToolCallView } from "./types";

export type ToolCallRowProps = {
  tool: ToolCallView;
  className?: string;
};

export function ToolCallRow(props: ToolCallRowProps) {
  const { tool, className } = props;
  const isError = tool.status === "error";
  const isRunning = tool.status === "running";
  return (
    <div
      className={cx(
        // Borderless, unindented muted line — a tool call reads as a quiet
        // sub-step of the agent's prose, not a boxed card and not an icon row.
        "flex min-w-[var(--space-0)] flex-wrap items-baseline gap-x-[var(--space-1-5)] gap-y-[var(--space-0-5)] py-[var(--space-0-5)]",
        isError && "text-[var(--color-status-danger)]",
        className,
      )}
    >
      {isError ? (
        <Close
          aria-hidden="true"
          className="size-[var(--size-icon-xs)] shrink-0 self-center text-[var(--color-status-danger)]"
        />
      ) : null}
      <span
        className={cx(
          "text-[length:var(--text-caption)] font-[var(--font-weight-normal)] leading-[var(--leading-caption)]",
          isError
            ? "text-[var(--color-status-danger)]"
            : isRunning
              ? "shimmer-text"
              : "text-[var(--color-text-muted)]",
        )}
      >
        {tool.title}
      </span>
      {tool.detail ? (
        <span className="font-[var(--font-mono)] text-[length:var(--text-caption)] leading-[var(--leading-caption)] text-[var(--color-text-disabled)]">
          {tool.detail}
        </span>
      ) : null}
      {tool.outcome ? (
        <span
          className={cx(
            "inline-flex items-center gap-[var(--space-1)] text-[length:var(--text-caption)] leading-[var(--leading-caption)]",
            isError ? "text-[var(--color-status-danger)]" : "text-[var(--color-text-secondary)]",
          )}
        >
          <span aria-hidden="true" className="text-[var(--color-text-disabled)]">
            →
          </span>
          <span>{tool.outcome}</span>
        </span>
      ) : null}
    </div>
  );
}
