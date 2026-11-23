// Message — user + agent turns, built on assistant-ui MessagePrimitive.
//
// The human turn is a right-aligned lavender bubble. The agent turn is a
// left-aligned, borderless prose block with a small sparkle avatar — the
// playground idiom (assistant text reads as document prose, not a chat
// bubble). Tool calls nest inside the agent turn via MessagePrimitive.Parts,
// rendered by ToolCallRow (the "tool-call-nested-in-assistant-message"
// pattern).
//
// `MessageThread` renders a whole conversation from `ChatMessageView[]` for
// isolated (Storybook) proof; the live surface composes the same primitives
// against a real runtime.

import { createContext, use, useMemo, useRef, type ReactNode } from "react";

import { cx } from "@autograph/components";
import {
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  useMessagePartText,
  useSmooth,
} from "@assistant-ui/react";

import { AgentAvatar } from "./AgentAvatar";
import { ChatRuntimeProvider } from "./runtime";
import { StatusTicker } from "./StatusTicker";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { ToolCallRow } from "./ToolCallRow";
import type { ChatMessageView, TickerState, ToolCallView } from "./types";

// Per-message metadata that does NOT ride through the assistant-ui runtime
// (which only carries text + tool parts): the accumulated status ticker and
// the "notice" variant. Keyed by message id and looked up inside the message
// components. This is the transcript fold-in seam — settled tool rows live in
// the ticker's disclosure, not inline in the turn.
type AgentTurnMeta = { ticker?: TickerState; notice?: boolean };
const MessageMetaContext = createContext<ReadonlyMap<string, AgentTurnMeta>>(new Map());

function useAgentTurnMeta(): AgentTurnMeta | undefined {
  const id = useAuiState((s) => s.message.id);
  return use(MessageMetaContext).get(id);
}

// SmoothText — eases streamed assistant prose in character-wise instead of
// popping the whole paragraph in. `useSmooth` self-gates on the part's stream
// status: a `running` part reveals from empty over ~drainMs; a `complete` part
// (all static history) returns its full text immediately. So history renders
// instantly and only the live, streaming turn animates — no explicit
// "is this the last message" bookkeeping needed.
function SmoothText() {
  const { text } = useSmooth(useMessagePartText(), true);
  return text ? <p className="whitespace-pre-wrap">{text}</p> : null;
}

// New-message boundary: the number of messages present when the thread first
// mounted. Only messages at or beyond this index are "genuinely new" and should
// play the chat-in mount motion. Without this, a whole-history remount (panel
// reopen, parent re-key) replays the entrance animation on EVERY message at
// once — the flash Greptile + the panel review flagged. History renders
// instantly; only turns appended after this mount ease in.
const NewMessageBoundaryContext = createContext(0);

// `motion-safe:` still gates on the user's reduced-motion preference.
const CHAT_IN = "motion-safe:animate-[chat-in_150ms_ease-out]";

function useMountMotionClass(): string | false {
  const boundary = use(NewMessageBoundaryContext);
  const index = useAuiState((s) => s.message.index);
  return index >= boundary && CHAT_IN;
}

function UserMessage() {
  const motion = useMountMotionClass();
  return (
    <MessagePrimitive.Root className={cx("flex justify-end", motion)}>
      <div
        className={cx(
          "w-fit max-w-full rounded-[var(--radius-panel)]",
          "bg-[var(--color-action-primary)] text-[var(--color-text-inverse)]",
          "px-[var(--space-4)] py-[var(--space-2-5)]",
          "text-[length:var(--text-body)] leading-[var(--leading-prose)]",
        )}
      >
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}

// The quiet, card-less "Stopped." notice after a cancel (§4): a muted caption,
// centered, no avatar and no prose styling — it reads as a system aside, not an
// agent turn.
function NoticeMessage() {
  const motion = useMountMotionClass();
  return (
    <MessagePrimitive.Root className={cx("flex justify-center", motion)}>
      <span className="text-[length:var(--text-caption)] italic leading-[var(--leading-caption)] text-[var(--color-text-muted)]">
        <MessagePrimitive.Parts />
      </span>
    </MessagePrimitive.Root>
  );
}

function AgentMessage() {
  const motion = useMountMotionClass();
  const meta = useAgentTurnMeta();
  const isEmptyShell = useAuiState(
    (s) =>
      !s.message.content.some(
        (part) =>
          (part.type === "text" && part.text.trim().length > 0) || part.type === "tool-call",
      ),
  );

  // A cancel notice ("Stopped.") is a muted caption, not an agent bubble.
  if (meta?.notice) return <NoticeMessage />;

  const ticker = meta?.ticker;

  // The pre-first-token shell: an agent turn with no prose, no tool part, and
  // no ticker. The ThinkingIndicator owns this state exclusively (symmetric
  // with `shouldShowThinking`), so rendering a row here would stack a SECOND
  // AgentAvatar sparkle beneath the indicator's. Render nothing — the indicator
  // is the sole occupant of the pre-content window.
  if (isEmptyShell && !ticker) return null;

  return (
    <MessagePrimitive.Root className={cx("flex justify-start gap-[var(--space-2)]", motion)}>
      <AgentAvatar />
      <div
        className={cx(
          "flex min-w-[var(--space-0)] max-w-full flex-col gap-[var(--space-1-5)] pt-[var(--space-1)]",
          "text-[length:var(--text-body)] leading-[var(--leading-prose)] text-[var(--color-text-primary)]",
        )}
      >
        <MessagePrimitive.Parts>
          {({ part }) => {
            if (part.type === "text") {
              // Prose reads as a document paragraph, not a chat bubble, and
              // eases in character-wise while streaming (SmoothText).
              return <SmoothText />;
            }
            if (part.type === "tool-call") {
              // Legacy inline tool parts. With the ticker fold-in the session
              // no longer emits these (tools live in `ticker`); render them
              // only when a turn has NO ticker, so isolated fixtures still work.
              if (ticker) return null;
              const tool = part.result as ToolCallView | undefined;
              return tool ? <ToolCallRow tool={tool} /> : null;
            }
            return null;
          }}
        </MessagePrimitive.Parts>
        {/* The status ticker: while running it narrates progress; once settled
            its disclosure holds the folded-in tool rows (the transcript stays
            prose + cards). Rendered beneath the prose so the conclusion reads
            first. */}
        {ticker ? <StatusTicker ticker={ticker} /> : null}
      </div>
    </MessagePrimitive.Root>
  );
}

export type MessageThreadProps = {
  messages: readonly ChatMessageView[];
  isRunning?: boolean;
  className?: string;
  /** Extra classes for the scrolling viewport (e.g. panel padding). */
  viewportClassName?: string;
  /** Gap size token between turns. Defaults to `--space-5` (isolated proof). */
  gap?: string;
  /** Rendered instead of the message list when there are no messages. */
  emptyState?: ReactNode;
  /**
   * Extra content rendered inside the viewport, beneath the messages, so it
   * scrolls with the conversation (e.g. the stage card, an inline error).
   */
  children?: ReactNode;
};

/**
 * The agent is working but has nothing to show yet: a turn is in flight and
 * the latest turn carries no assistant prose or tool row (once either streams
 * in, it carries the progress and the dots retire). True only while the last
 * message is the human's, or an agent turn that is still empty.
 */
function shouldShowThinking(messages: readonly ChatMessageView[], isRunning: boolean): boolean {
  if (!isRunning) return false;
  const last = messages[messages.length - 1];
  if (!last || last.role === "human") return true;
  // A running ticker IS the progress narrator — once it exists (even with zero
  // steps yet) the indicator retires so the two don't both animate.
  if (last.ticker) return false;
  const hasContent = last.parts.some(
    (part) => (part.kind === "text" && part.text.trim().length > 0) || part.kind === "tool",
  );
  return !hasContent;
}

/**
 * Renders a whole conversation from static props. Wraps the primitives in a
 * view-only runtime so the leaves can be proven in isolation, and is composed
 * directly by the live `AgentChatPanel` (a single definition of the thread).
 */
export function MessageThread(props: MessageThreadProps) {
  const {
    messages,
    isRunning,
    className,
    viewportClassName,
    gap = "var(--space-5)",
    emptyState,
    children,
  } = props;
  const isEmpty = messages.length === 0;
  const showThinking = shouldShowThinking(messages, isRunning ?? false);
  // Captured once, at first mount: the count of pre-existing (history) messages.
  // The ref initializer runs a single time per mount, so a remount recaptures
  // the full history length — every history turn then renders instantly and
  // only later-appended turns animate in.
  const newMessageBoundary = useRef(messages.length).current;
  // Per-message ticker / notice metadata, keyed by id — the fold-in seam the
  // message components read (this data does not ride through the runtime).
  const metaById = useMemo(() => {
    const map = new Map<string, AgentTurnMeta>();
    for (const message of messages) {
      if (message.role !== "agent") continue;
      if (message.ticker || message.variant === "notice") {
        map.set(message.id, {
          ticker: message.ticker,
          notice: message.variant === "notice",
        });
      }
    }
    return map;
  }, [messages]);
  return (
    <ChatRuntimeProvider messages={messages} isRunning={isRunning}>
      <MessageMetaContext.Provider value={metaById}>
        <ThreadPrimitive.Root className={cx("flex flex-col", className)}>
          <ThreadPrimitive.Viewport
            className={cx("flex flex-1 flex-col overflow-y-auto", viewportClassName)}
            style={{ gap }}
          >
            {isEmpty && emptyState ? (
              emptyState
            ) : (
              <NewMessageBoundaryContext.Provider value={newMessageBoundary}>
                <ThreadPrimitive.Messages
                  components={{
                    UserMessage,
                    AssistantMessage: AgentMessage,
                  }}
                />
              </NewMessageBoundaryContext.Provider>
            )}
            {showThinking ? <ThinkingIndicator /> : null}
            {children}
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>
      </MessageMetaContext.Provider>
    </ChatRuntimeProvider>
  );
}
