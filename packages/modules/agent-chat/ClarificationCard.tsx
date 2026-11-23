// ClarificationCard — the agent's "I need to check something" turn.
//
// When the agent asks instead of proposing, the app hands the session a
// humanized `ClarificationView`; this leaf renders it as a card with the
// question, an optional rationale, choice buttons, and (when allowed) a
// free-text follow-up. Answering resumes the run.
//
// Presentational: choices + follow-up come back through `onAnswer`. The module
// never resolves what a choice means — that is the app's job on resume.

import { useState } from "react";

import { Button, cx } from "@autograph/components";

import { AgentAvatar } from "./AgentAvatar";
import type { ClarificationView } from "./types";

export type ClarificationCardProps = {
  clarification: ClarificationView;
  onAnswer: (choiceId: string | null, followUp?: string | null) => void;
  /** True while the resumed turn is in flight. */
  answering?: boolean;
  className?: string;
};

export function ClarificationCard(props: ClarificationCardProps) {
  const { clarification, onAnswer, answering, className } = props;
  const [followUp, setFollowUp] = useState("");
  const canSubmitFollowUp = followUp.trim().length > 0;

  return (
    <div
      className={cx(
        "flex flex-col gap-[var(--space-3)] rounded-[var(--radius-panel)] border",
        "border-[var(--color-border-strong)] bg-[var(--color-bg-surface)] shadow-[var(--shadow-subtle)]",
        "px-[var(--space-4)] py-[var(--space-3)]",
        className,
      )}
    >
      <div className="flex items-start gap-[var(--space-2-5)]">
        <AgentAvatar className="mt-[var(--space-0-5)]" />
        <div className="flex min-w-[var(--space-0)] flex-col gap-[var(--space-1)]">
          <p className="text-[length:var(--text-control-md)] font-[var(--font-weight-semibold)] leading-[var(--leading-body)] text-[var(--color-text-primary)]">
            {clarification.headline}
          </p>
          {clarification.reasoning ? (
            <p className="text-[length:var(--text-caption)] leading-[var(--leading-caption)] text-[var(--color-text-muted)]">
              {clarification.reasoning}
            </p>
          ) : null}
        </div>
      </div>

      {clarification.choices.length > 0 ? (
        <div className="flex flex-wrap items-center gap-[var(--space-2)]">
          {clarification.choices.map((choice) => (
            <Button
              key={choice.id}
              intent={
                choice.intent === "primary"
                  ? "primary"
                  : choice.intent === "secondary"
                    ? "ghost"
                    : "secondary"
              }
              size="sm"
              disabled={answering}
              // A choice is a self-contained answer: clicking it answers
              // immediately, carrying any typed follow-up along (choiceId +
              // followUp together). When data / free text is needed the agent
              // emits NO choices and the free-text follow-up stands alone.
              onClick={() => onAnswer(choice.id, followUp)}
            >
              {choice.label}
            </Button>
          ))}
        </div>
      ) : null}

      {clarification.canAskFollowUp ? (
        <div className="flex items-end gap-[var(--space-2)]">
          <textarea
            rows={1}
            value={followUp}
            disabled={answering}
            aria-label="Add a detail to your answer"
            placeholder="Add a detail…"
            onChange={(event) => setFollowUp(event.target.value)}
            className={cx(
              "field-sizing-content max-h-[var(--size-editor-options-max-height)] w-full resize-none",
              "rounded-[var(--radius-control)] border border-[var(--color-border-strong)] bg-[var(--color-bg-surface)]",
              "px-[var(--space-3)] py-[var(--space-2)]",
              "text-[length:var(--text-body)] leading-[var(--leading-prose)] text-[var(--color-text-primary)]",
              "placeholder:text-[var(--color-text-muted)]",
              "focus-within:border-[var(--color-action-primary)]",
            )}
          />
          <Button
            intent="secondary"
            size="sm"
            // A free-text follow-up requires non-empty text to submit.
            disabled={answering || !canSubmitFollowUp}
            // A free-text answer carries no choice id.
            onClick={() => onAnswer(null, followUp)}
          >
            Send
          </Button>
        </div>
      ) : null}
    </div>
  );
}
