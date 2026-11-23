import { useEffect, useRef, type ReactNode } from "react";

import { Close } from "../../icons";
import { cx, focusRing } from "../utils";

// Visual primitive for a single toast. Pure — no portal, no timer, no
// stacking. The ToastProvider owns the queue, the auto-dismiss timer, the
// portal, and the stack layout; this component renders one entry at a
// chosen position in that stack.
//
// Variants are status-tinted with a thin left bar; the bar gives each
// variant a glanceable identity without flooding the surface in tinted
// background, which would compete with the page underneath.
export type ToastVariant = "success" | "warning" | "error" | "info";

export type ToastAction = {
  label: string;
  onClick: () => void;
};

export type ToastProps = {
  variant: ToastVariant;
  message: ReactNode;
  // Optional action button (e.g. "Undo"). Clicking the action does NOT
  // auto-dismiss the toast — the action handler decides what to do next.
  // The provider's onDismiss-via-click-X path is unaffected.
  action?: ToastAction;
  onDismiss: () => void;
  // Hint used by the provider to set role/aria-live: errors are assertive
  // (interrupt screen readers), everything else is polite. Defaults to
  // "polite" via the provider; the component itself doesn't change role.
  // Surfaced here for storybook standalone use.
  ariaLive?: "polite" | "assertive";
};

const VARIANT_BAR: Record<ToastVariant, string> = {
  success: "bg-[var(--color-status-success)]",
  warning: "bg-[var(--color-status-warning)]",
  error: "bg-[var(--color-status-danger)]",
  info: "bg-[var(--color-action-primary)]",
};

const VARIANT_LABEL: Record<ToastVariant, string> = {
  success: "Success",
  warning: "Warning",
  error: "Error",
  info: "Info",
};

export function Toast(props: ToastProps) {
  const { variant, message, action, onDismiss, ariaLive } = props;
  return (
    <div
      role={variant === "error" ? "alert" : "status"}
      aria-live={ariaLive ?? (variant === "error" ? "assertive" : "polite")}
      data-toast
      data-variant={variant}
      className={cx(
        "pointer-events-auto flex w-[var(--size-toast-width)] max-w-[var(--size-toast-max-width)] items-start gap-[var(--space-3)]",
        "overflow-hidden rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)]",
        "bg-[var(--color-bg-surface)] shadow-[var(--shadow-raised)]",
      )}
    >
      <div
        aria-hidden
        className={cx("self-stretch w-[var(--space-1)] shrink-0", VARIANT_BAR[variant])}
      />
      <div className="flex flex-1 items-start gap-[var(--space-3)] py-[var(--space-3)] pr-[var(--space-3)] pl-[var(--space-1)]">
        <div className="min-w-[var(--space-0)] flex-1">
          <span className="sr-only">{VARIANT_LABEL[variant]}: </span>
          <div
            data-toast-message
            className="text-[length:var(--text-body)] text-[var(--color-text-primary)]"
          >
            {message}
          </div>
        </div>
        {action ? (
          <button
            type="button"
            data-toast-action
            onClick={action.onClick}
            className={cx(
              "shrink-0 self-start rounded-[var(--radius-control)] px-[var(--space-2)] py-[var(--space-1)]",
              "text-[length:var(--text-caption)] font-[var(--font-weight-medium)] text-[var(--color-action-primary)]",
              "hover:bg-[var(--color-bg-hover)]",
              focusRing,
            )}
          >
            {action.label}
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Dismiss"
          data-toast-dismiss
          onClick={onDismiss}
          className={cx(
            "shrink-0 self-start inline-flex h-[var(--size-control-xs)] w-[var(--size-control-xs)] items-center justify-center",
            "rounded-[var(--radius-control)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]",
            focusRing,
          )}
        >
          <Close className="h-[var(--size-icon-sm)] w-[var(--size-icon-sm)]" />
        </button>
      </div>
    </div>
  );
}

// Auto-dismiss controller. Wraps a Toast with a timer that fires onDismiss
// after `duration` ms. The timer pauses on pointer-enter / focus and
// resumes on pointer-leave / blur, so a user reading the toast doesn't
// lose it mid-read. The manager uses this; storybook can use Toast
// directly without auto-dismiss.
export type AutoDismissToastProps = ToastProps & {
  duration: number;
};

export function AutoDismissToast(props: AutoDismissToastProps) {
  const { duration, onDismiss, ...rest } = props;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (duration <= 0) return;
    const id = setTimeout(() => {
      onDismissRef.current();
    }, duration);
    timerRef.current = id;
    // Read the current timer id off the ref at cleanup time, not the
    // `id` closed over from this effect run. `restartTimer` (called on
    // hover-leave / focus-blur resume) replaces `timerRef.current` with
    // a fresh id; clearing the closed-over `id` would leak the restarted
    // timer and let `onDismissRef.current()` fire after unmount.
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [duration]);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };
  const restartTimer = () => {
    if (duration <= 0) return;
    clearTimer();
    timerRef.current = setTimeout(() => {
      onDismissRef.current();
    }, duration);
  };

  return (
    <div
      onMouseEnter={clearTimer}
      onMouseLeave={restartTimer}
      onFocus={clearTimer}
      onBlur={restartTimer}
    >
      <Toast {...rest} onDismiss={onDismiss} />
    </div>
  );
}
