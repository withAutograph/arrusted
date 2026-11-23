// ConfirmButton — primary button that morphs into a confirmation state
// on the first click. The second click within the auto-revert window
// fires the action. The button reverts to its idle state after
// `revertAfterMs` (default 5_000) of no interaction, so a user who
// arms then walks away can't return to a trigger-armed destructive
// affordance.
//
// Usage:
//   <ConfirmButton
//     intent="danger"
//     idleLabel="Discard"
//     confirmLabel="Confirm Discard?"
//     onConfirm={() => onDiscard(card.change_set_id)}
//   />
//
// The primitive is intentionally minimal — it wraps the standard
// `<Button>` so size / leading / trailing / className behave the same;
// the only added behavior is the two-click arming state + the
// auto-revert timer. Apps that need fancier UX (e.g. a popover) can
// keep using `<Button>` directly and roll their own confirmation flow.

import { useCallback, useEffect, useRef, useState } from "react";

import { Button, type ButtonProps } from "./Button";

export type ConfirmButtonProps = Omit<ButtonProps, "children" | "onClick"> & {
  // Label rendered in the idle (un-armed) state.
  idleLabel: string;
  // Label rendered in the armed (one-click-to-fire) state.
  confirmLabel: string;
  // Called when the user clicks while armed. Synchronous OR async — the
  // component doesn't await; callers that want post-action UI (e.g. a
  // disabled state during a network call) wire that through `disabled`
  // / `loading` on `ButtonProps`.
  onConfirm: () => void;
  // Auto-revert window (ms) after the arming click. Defaults to 5000.
  // Set to 0 to disable auto-revert (caller must reset by remount or
  // by changing some external prop that fires the unmount effect).
  revertAfterMs?: number;
};

export function ConfirmButton(props: ConfirmButtonProps) {
  const { idleLabel, confirmLabel, onConfirm, revertAfterMs = 5_000, intent, ...rest } = props;
  const [armed, setArmed] = useState(false);
  // The auto-revert timer handle. Stored in a ref so the cleanup effect
  // can clear it without re-creating the effect every time `armed`
  // changes (which would itself reset the timer and create a feedback
  // loop).
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Clear the timer on unmount so we don't fire setState on an
  // unmounted component (React strict mode would otherwise warn, and
  // the dangling timer would leak across navigation).
  useEffect(() => () => clearTimer(), [clearTimer]);

  const handleClick = useCallback(() => {
    if (!armed) {
      setArmed(true);
      if (revertAfterMs > 0) {
        clearTimer();
        timerRef.current = setTimeout(() => {
          setArmed(false);
          timerRef.current = null;
        }, revertAfterMs);
      }
      return;
    }
    // Armed: fire + reset. Clear the timer first so a slow onConfirm
    // (or an unmount triggered by onConfirm — e.g. the row disappears
    // from the card after Discard) doesn't leave a dangling timer.
    clearTimer();
    setArmed(false);
    onConfirm();
  }, [armed, clearTimer, onConfirm, revertAfterMs]);

  // Screen-reader announcement for the arming transition is delivered
  // through a SIBLING live region whose content is empty in idle state
  // and populated with `confirmLabel` only while armed.
  //
  // P11 P6: the legacy implementation wrapped the visible button label
  // in `aria-live="polite"`, so the IDLE label (`idleLabel`) sat in a
  // live region from first paint. SRs that snapshot live-region
  // content on mount (NVDA does, JAWS may) would announce every card's
  // button label once per render — N cards mounted → N announcements
  // → the user hears the page's destructive affordances chanted at
  // them before they've done anything. Separating the visible button
  // label from the live region means the live region is empty at
  // mount (no announcement), populated transiently when the user arms
  // (one announcement per arming click). The visible label still
  // updates per state via the `{armed ? confirmLabel : idleLabel}`
  // ternary; only the announcement channel changed.
  return (
    <Button
      {...rest}
      // Intent stays the caller's choice in idle state; once armed we
      // amplify to `danger` so the second-click affordance reads
      // unambiguously destructive even if the caller passed `primary`
      // (e.g. Publish → Confirm Publish? renders as danger to signal
      // "you can't undo this from the same surface").
      intent={armed ? "danger" : intent}
      onClick={handleClick}
      data-confirm-armed={armed ? "true" : undefined}
    >
      <span>{armed ? confirmLabel : idleLabel}</span>
      {/*
        Empty-on-mount live region. SR-only via visually-hidden CSS
        (clip-path + 1px size) — sighted users see the visible label
        above; SR users hear the announcement only when `armed` flips
        true. `role="status"` is the implicit live-region role for
        polite announcements; pairing it with `aria-live="polite"`
        is redundant per spec but tolerated by every shipping SR and
        keeps intent explicit at the source.
      */}
      <span role="status" aria-live="polite" className="sr-only">
        {armed ? confirmLabel : ""}
      </span>
    </Button>
  );
}
