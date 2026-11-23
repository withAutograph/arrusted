// PromptInput — the composer, built on assistant-ui ComposerPrimitive.
//
// Auto-resizing textarea (rows=1 grows with content), a send button that
// ComposerPrimitive.Send auto-disables when the composer is empty. Styled as a
// single rounded field with the send affordance docked bottom-right — the
// playground idiom. Presentational: `onSend` fires with the composed text.
//
// Needs a runtime for the composer state, so it self-wraps in the view-only
// ChatRuntimeProvider. The live surface (PR E) shares one runtime across the
// thread + composer; this leaf is unchanged either way.

import { ArrowUp, Spinner, Stop } from "@autograph/icons";
import { cx } from "@autograph/components";
import { ComposerPrimitive } from "@assistant-ui/react";

import { ChatRuntimeProvider } from "./runtime";

export type PromptInputProps = {
  onSend?: (text: string) => void;
  /**
   * Abort the in-flight turn (§4). When provided, the send affordance morphs
   * into an ACTIVE stop control while running (clickable — unlike the disabled
   * spinner), so the human can cancel. Omitted ⇒ the button just shows a
   * working state and stays disabled.
   */
  onStop?: () => void;
  /** True while the agent is producing a turn (dims + halts the composer). */
  isRunning?: boolean;
  placeholder?: string;
  className?: string;
};

export function PromptInput(props: PromptInputProps) {
  const {
    onSend,
    onStop,
    isRunning,
    placeholder = "Ask about this view, or describe a change…",
    className,
  } = props;
  const showStop = Boolean(isRunning && onStop);
  return (
    <ChatRuntimeProvider messages={[]} onSend={onSend} isRunning={isRunning}>
      <ComposerPrimitive.Root
        className={cx(
          "flex w-full flex-col rounded-[var(--radius-panel)] border",
          // Quiet at rest — a subtle hairline, no resting shadow — then the
          // field lifts on focus (accent border + control shadow). The heavier
          // resting border/shadow read as a permanently-active field.
          "border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)]",
          "focus-within:border-[var(--color-action-primary)]",
          "focus-within:shadow-[var(--shadow-control)]",
          "transition-[color,border-color,box-shadow]",
          className,
        )}
      >
        <ComposerPrimitive.Input
          rows={1}
          aria-label="Message the agent"
          placeholder={placeholder}
          className={cx(
            "field-sizing-content max-h-[var(--size-editor-options-max-height)] w-full resize-none",
            "border-0 bg-transparent",
            "px-[var(--space-4)] pt-[var(--space-3)] pb-[var(--space-1)]",
            "text-[length:var(--text-body)] leading-[var(--leading-prose)] text-[var(--color-text-primary)]",
            // The composer CONTAINER carries the focus affordance
            // (focus-within border + shadow). The textarea opts out of the
            // global DS focus-visible ring so it doesn't double-ring inside an
            // already-ringed field; `!` beats the global :focus-visible rule's
            // higher `:not()`-chain specificity.
            "placeholder:text-[var(--color-text-muted)] outline-none! focus-visible:outline-none!",
          )}
        />
        <div className="flex items-center justify-end px-[var(--space-2)] pb-[var(--space-2)]">
          {/* While a turn is in flight AND a stop handler is wired, the send
              affordance becomes an ACTIVE stop control (§4) — a real button so
              the human can abort. Otherwise it's ComposerPrimitive.Send, which
              owns the empty-disabled state and dispatches the composed text. */}
          {showStop ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop"
              className={cx(
                "flex size-[var(--size-control-sm)] items-center justify-center rounded-[var(--radius-pill)]",
                "bg-[var(--color-action-primary)] text-[var(--color-text-inverse)]",
                "shadow-[var(--shadow-control)] transition-colors",
                "hover:bg-[var(--color-action-primary-hover)]",
              )}
            >
              <Stop aria-hidden="true" className="size-[var(--size-icon-md)]" />
            </button>
          ) : (
            <ComposerPrimitive.Send
              className={cx(
                "flex size-[var(--size-control-sm)] items-center justify-center rounded-[var(--radius-pill)]",
                "bg-[var(--color-action-primary)] text-[var(--color-text-inverse)]",
                "shadow-[var(--shadow-control)] transition-colors",
                "hover:bg-[var(--color-action-primary-hover)]",
                "disabled:cursor-not-allowed disabled:bg-[var(--color-bg-toggle-off)]",
              )}
            >
              {/* No stop handler wired: restore the prior working state — the
                  arrow morphs into a spinner while running (button stays
                  disabled). This keeps the shared leaf's no-onStop path
                  unchanged for callers that don't offer cancel. */}
              {isRunning ? (
                <Spinner
                  aria-hidden="true"
                  className="size-[var(--size-icon-md)] motion-safe:animate-spin"
                />
              ) : (
                <ArrowUp aria-hidden="true" className="size-[var(--size-icon-md)]" />
              )}
              <span className="sr-only">Send</span>
            </ComposerPrimitive.Send>
          )}
        </div>
      </ComposerPrimitive.Root>
    </ChatRuntimeProvider>
  );
}
