// AgentChatPanel — the assembled live conversation surface.
//
// Composes the proven Phase-1 leaves — `MessageThread` (the conversation) and
// `PromptInput` (the composer) — plus ToolCallRow (nested inside the thread),
// StageConfirmation, AnchorChip, and ClarificationCard into the panel shown in
// the approved gallery: a header (title + anchor chip + close), a scrolling
// message thread with tool-calls nested in assistant turns, the settled stage /
// clarification card beneath the thread, an inline error, and the docked
// composer.
//
// STRUCTURAL DEDUPE (this rework): the panel used to re-implement the thread +
// composer inline against the primitives, leaving `MessageThread`/`PromptInput`
// as dead public API. It now COMPOSES those leaves so there is a single
// definition of each surface. Rendered output is unchanged (same approved
// gallery look); the leaves each self-wrap their view-only runtime, so the
// thread renders `messages` and the composer routes send → `onSend`.
//
// PRESENTATIONAL: every bit of state + every action arrives via props (from
// `useAgentChatSession` at the app call site). The panel owns no conversation
// truth, no backend, no domain semantics.

import { Close } from "@autograph/icons";
import { Button, cx } from "@autograph/components";

import { AgentAvatar } from "./AgentAvatar";
import { AnchorChip } from "./AnchorChip";
import { ClarificationCard } from "./ClarificationCard";
import { MessageThread } from "./Message";
import { PromptInput } from "./PromptInput";
import { StageConfirmation } from "./StageConfirmation";
import type {
  ChatAnchorView,
  ChatMessageView,
  ClarificationView,
  RunContinuationView,
  StageProposalView,
} from "./types";
import type { SessionErrorAction } from "./useAgentChatSession";

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-[var(--space-2)] px-[var(--space-4)] text-center">
      <AgentAvatar />
      <p className="text-[length:var(--text-control-md)] font-[var(--font-weight-medium)] text-[var(--color-text-secondary)]">
        Ask about this view, or describe a change.
      </p>
      <p className="max-w-[var(--size-editor-options-max-height)] text-[length:var(--text-caption)] leading-[var(--leading-caption)] text-[var(--color-text-muted)]">
        The agent reads what&apos;s on screen and drafts changes for you to review. Nothing is
        applied until you Save.
      </p>
    </div>
  );
}

export type AgentChatPanelProps = {
  /** The grounding anchor chip contents (what the conversation is anchored to). */
  anchor: ChatAnchorView;
  /** The ephemeral conversation, from `useAgentChatSession`. */
  messages: readonly ChatMessageView[];
  /** True while a turn is in flight. */
  isRunning: boolean;
  /** A settled draft awaiting the Stage decision, if any. */
  proposal: { preview: StageProposalView; staged: boolean } | null;
  /** An open clarification, if the agent asked one. */
  clarification: ClarificationView | null;
  /** A settled fresh-run continuation, if the last turn reached its limit. */
  continuation: RunContinuationView | null;
  /**
   * True while a stage-into-buffer commit is in flight. Optional: the live
   * session stages synchronously and never sets this, but the leaf keeps the
   * capability (used in isolation / if an app makes staging async).
   */
  staging?: boolean;
  /** A turn / stage error to surface inline. */
  error: string | null;
  /**
   * A secondary action attached to the current error (e.g. an informed
   * "Replace…" override the app offered). Generic — the panel just renders the
   * label and calls `onAction`; it knows no staging/agent semantics.
   */
  errorAction?: SessionErrorAction | null;

  onSend: (prompt: string) => void;
  /** Abort the in-flight turn (§4); wires the composer's stop control. */
  onStop?: () => void;
  onStage: () => void;
  onDiscard: () => void;
  onAnswerClarification: (choiceId: string | null, followUp?: string | null) => void;
  /** Start a fresh run from the current ephemeral transcript. */
  onContinueRun: () => void;
  /** Optional — when present, the header shows a close/collapse control. */
  onClose?: () => void;

  className?: string;
  title?: string;
  composerPlaceholder?: string;
};

export function AgentChatPanel(props: AgentChatPanelProps) {
  const {
    anchor,
    messages,
    isRunning,
    proposal,
    clarification,
    continuation,
    staging,
    error,
    errorAction,
    onSend,
    onStop,
    onStage,
    onDiscard,
    onAnswerClarification,
    onContinueRun,
    onClose,
    className,
    title = "Agent",
    composerPlaceholder = "Ask about this view, or describe a change…",
  } = props;

  return (
    <section
      className={cx(
        "flex h-full min-h-[var(--space-0)] flex-col overflow-hidden",
        "border-l border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)]",
        className,
      )}
      aria-label={title}
    >
      {/* Header keeps only the persona title + close. The grounding anchor
          moved down to the composer dock (Hari) so it sits next to where the
          human types, not competing with the title in a cramped bar. */}
      <header className="flex items-center justify-between gap-[var(--space-3)] border-b border-[var(--color-border-subtle)] px-[var(--space-4)] py-[var(--space-3)]">
        <span className="flex items-center gap-[var(--space-2)] text-[length:var(--text-control-lg)] font-[var(--font-weight-semibold)] text-[var(--color-text-primary)]">
          <AgentAvatar />
          {title}
        </span>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close agent"
            className={cx(
              "flex size-[var(--size-control-sm)] shrink-0 items-center justify-center rounded-[var(--radius-control)]",
              "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]",
            )}
          >
            <Close aria-hidden="true" className="size-[var(--size-icon-md)]" />
          </button>
        ) : null}
      </header>

      {/* The proven MessageThread leaf owns the scrolling conversation; the
          settled cards + inline error ride inside its viewport (as children)
          so they scroll with the thread — the original panel layout. */}
      <MessageThread
        className="min-h-[var(--space-0)] flex-1"
        viewportClassName="min-h-[var(--space-0)] px-[var(--space-4)] py-[var(--space-4)]"
        gap="var(--space-5)"
        messages={messages}
        isRunning={isRunning}
        emptyState={<EmptyState />}
      >
        {clarification ? (
          <ClarificationCard
            clarification={clarification}
            answering={isRunning}
            onAnswer={onAnswerClarification}
            className="motion-safe:animate-[chat-in_150ms_ease-out]"
          />
        ) : null}

        {proposal ? (
          <StageConfirmation
            proposal={proposal.preview}
            staged={proposal.staged}
            staging={staging}
            onStage={onStage}
            onDiscard={onDiscard}
            className="motion-safe:animate-[chat-in_150ms_ease-out]"
          />
        ) : null}

        {continuation ? (
          <div
            role="status"
            className="flex flex-col gap-[var(--space-2)] rounded-[var(--radius-control)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-subtle)] px-[var(--space-3)] py-[var(--space-2)]"
          >
            <p className="text-[length:var(--text-caption)] leading-[var(--leading-caption)] text-[var(--color-text-secondary)]">
              {continuation.message}
            </p>
            <div className="flex justify-end">
              <Button intent="secondary" size="sm" onClick={onContinueRun}>
                {continuation.actionLabel}
              </Button>
            </div>
          </div>
        ) : null}

        {error ? (
          <div
            role="alert"
            className="flex flex-col gap-[var(--space-2)] rounded-[var(--radius-control)] border border-[var(--color-status-danger)] bg-[var(--color-status-danger-bg)] px-[var(--space-3)] py-[var(--space-2)]"
          >
            <p className="text-[length:var(--text-caption)] leading-[var(--leading-caption)] text-[var(--color-status-danger)]">
              {error}
            </p>
            {errorAction ? (
              <div className="flex justify-end">
                <Button intent="secondary" size="sm" onClick={errorAction.onAction}>
                  {errorAction.label}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </MessageThread>

      {/* The composer dock: the grounding anchor chip sits ABOVE the input
          (Hari) so the human always sees what the agent is grounded in right
          where they type, then the proven PromptInput leaf. */}
      <div className="flex flex-col gap-[var(--space-2)] border-t border-[var(--color-border-subtle)] px-[var(--space-4)] py-[var(--space-3)]">
        <AnchorChip anchor={anchor} className="min-w-[var(--space-0)] self-start" />
        <PromptInput
          onSend={onSend}
          onStop={onStop}
          isRunning={isRunning}
          placeholder={composerPlaceholder}
        />
      </div>
    </section>
  );
}
