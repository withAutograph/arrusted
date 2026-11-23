// ThinkingIndicator — the "agent is working, nothing to show yet" beat.
//
// Rendered in the thread while a turn is in flight AND the assistant has not
// yet streamed any text (once prose/tool rows appear they carry the progress).
// Mirrors an agent turn's layout — the shared sparkle avatar plus a left-
// aligned row — so the eventual message doesn't jump. The single "Thinking…"
// label shimmers (the motion IS the signal); `shimmer-text` self-gates
// on `prefers-reduced-motion` so reduced-motion users get a static muted label.

import { cx } from "@autograph/components";

import { AgentAvatar } from "./AgentAvatar";

export type ThinkingIndicatorProps = {
  className?: string;
};

export function ThinkingIndicator(props: ThinkingIndicatorProps) {
  const { className } = props;
  return (
    <div
      className={cx(
        "flex items-center justify-start gap-[var(--space-2)]",
        "motion-safe:animate-[chat-in_150ms_ease-out]",
        className,
      )}
      aria-label="Agent is thinking"
      role="status"
    >
      <AgentAvatar />
      <span className="shimmer-text pt-[var(--space-1)] text-[length:var(--text-body)] leading-[var(--leading-prose)]">
        Thinking…
      </span>
    </div>
  );
}
