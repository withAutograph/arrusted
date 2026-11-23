import { createContext, use, useCallback, useMemo, useRef, useState, type ReactNode } from "react";

import { Button, Tag, cx, focusRing } from "@autograph/components";
import { Comment } from "@autograph/icons";
import type { CellPin } from "@modules/editable-grid";

import type { CanvasThread } from "./threads";
import type { CanvasOutcome, CanvasSession } from "./use-canvas-session";

/**
 * What a thread is pinned to: a unit, a row (`model_id` + `record_id`), or a
 * cell or record field (`field_id` too). The unit is kept when the target is
 * inside one; a record field in the record panel has none. The kernel checks
 * that a named record exists.
 */
export type ThreadAnchor = {
  unit_id?: string;
  model_id?: string;
  record_id?: string;
  field_id?: string;
};

type CommentModeValue = {
  on: boolean;
  setOn: (on: boolean) => void;
  /**
   * Called by a unit's click handler with the target under the click. While
   * comment mode is on, the first call opens a thread anchored there and ends
   * comment mode, so the unit frame's own fallback (the unit) is skipped; it
   * returns true when the click was taken for a thread, and the unit should
   * then do nothing else with it.
   */
  anchor: (target: ThreadAnchor) => boolean;
  /**
   * The unit frame's fallback for a click no target inside claimed. It waits
   * one task first: the grid reports cell clicks from its own next-task flush
   * (scheduled while the click bubbles up to the frame), so a cell claims the
   * click before the frame's fallback runs.
   */
  fallback: (target: ThreadAnchor) => void;
};

const CommentModeContext = createContext<CommentModeValue>({
  on: false,
  setOn: () => {},
  anchor: () => false,
  fallback: () => {},
});

/** Comment mode for the units inside; off when there is no provider. */
export function useCommentMode(): CommentModeValue {
  return use(CommentModeContext);
}

/**
 * Comment mode: while on, the next click on a unit opens a new thread
 * anchored to what was under it (the deepest target a unit reports, else the
 * unit). The thread id is minted here; `onOpened` hears it once the session
 * holds the thread, `onFailed` hears a refusal.
 */
export function CommentModeProvider({
  threadOpen,
  onOpened,
  onFailed,
  initiallyOn = false,
  children,
}: {
  threadOpen: CanvasSession["threadOpen"];
  onOpened: (threadId: string, anchor: ThreadAnchor) => void;
  onFailed?: (outcome: Extract<CanvasOutcome, { ok: false }>) => void;
  /** For stories: start with comment mode on. */
  initiallyOn?: boolean;
  children: ReactNode;
}) {
  const [on, setOnState] = useState(initiallyOn);
  // A click reaches the claiming target before the frame's fallback within
  // one event, so the claim is read synchronously, not from state.
  const live = useRef(initiallyOn);
  const setOn = useCallback((next: boolean) => {
    live.current = next;
    setOnState(next);
  }, []);
  const anchor = useCallback(
    (target: ThreadAnchor) => {
      if (!live.current) return false;
      setOn(false);
      const threadId = crypto.randomUUID();
      void threadOpen(threadId, target).then((outcome) => {
        if (outcome.ok) onOpened(threadId, target);
        else onFailed?.(outcome);
      });
      return true;
    },
    [threadOpen, onOpened, onFailed, setOn],
  );
  const fallback = useCallback(
    (target: ThreadAnchor) => {
      if (!live.current) return;
      setTimeout(() => anchor(target), 0);
    },
    [anchor],
  );
  const value = useMemo(() => ({ on, setOn, anchor, fallback }), [on, setOn, anchor, fallback]);
  return <CommentModeContext value={value}>{children}</CommentModeContext>;
}

/** The top bar's speech-bubble toggle for comment mode. */
export function CommentModeToggle({ className }: { className?: string }) {
  const { on, setOn } = useCommentMode();
  return (
    <Button
      aria-pressed={on}
      className={className}
      data-comment-mode={on ? "on" : "off"}
      intent={on ? "primary" : "secondary"}
      leading={<Comment aria-hidden className="size-[var(--size-icon-sm)]" />}
      size="sm"
      title={on ? "Click something to comment on it" : "Comment"}
      onClick={() => setOn(!on)}
    >
      Comment
    </Button>
  );
}

/** A thread's anchor as an object; an anchor that is not one (any JSON is valid) anchors to nothing. */
export const threadAnchor = (thread: CanvasThread): ThreadAnchor =>
  thread.anchor !== null && typeof thread.anchor === "object" && !Array.isArray(thread.anchor)
    ? (thread.anchor as ThreadAnchor)
    : {};

/**
 * The open threads pinned exactly to a target: a unit's own threads, a row's,
 * or a cell's. A thread on a cell is not counted on its row or unit.
 */
export function threadsOn(threads: readonly CanvasThread[], target: ThreadAnchor): CanvasThread[] {
  return threads.filter((thread) => {
    if (thread.resolved) return false;
    const anchor = threadAnchor(thread);
    if (target.record_id === undefined)
      return anchor.record_id === undefined && anchor.unit_id === target.unit_id;
    return (
      anchor.model_id === target.model_id &&
      anchor.record_id === target.record_id &&
      anchor.field_id === target.field_id
    );
  });
}

/**
 * The thread a pin opens: the one after the thread already open, else the
 * first, so clicking a pin again steps through all of its threads.
 */
export function nextThreadId(on: readonly CanvasThread[], open: string | null): string {
  return on[(on.findIndex((thread) => thread.id === open) + 1) % on.length]!.id;
}

const pinLabel = (count: number, target: string) =>
  `${count} open thread${count === 1 ? "" : "s"} on ${target}`;

/** The pin's face: the comment glyph and the open-thread count. Grid cell pins use it too. */
function ThreadPinFace({ count }: { count: number }) {
  return (
    <span className="inline-flex items-center gap-[var(--space-0-5)] tabular-nums">
      <Comment aria-hidden className="size-[var(--size-icon-xs)]" />
      {count}
    </span>
  );
}

/**
 * A marker for the open threads pinned to a unit, a record or a record field.
 * Nothing renders without open threads. Grid cells use `threadCellPin`.
 */
export function ThreadPin({
  count,
  target,
  onOpen,
}: {
  count: number;
  /** What the threads are pinned to, by name, for the accessible label. */
  target: string;
  onOpen: () => void;
}) {
  if (count === 0) return null;
  return (
    <button
      aria-label={pinLabel(count, target)}
      className={cx("inline-flex shrink-0 rounded-[var(--radius-pill)]", focusRing)}
      data-thread-pin={count}
      title={pinLabel(count, target)}
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
    >
      <Tag label={<ThreadPinFace count={count} />} tone="blue" />
    </button>
  );
}

/** The grid's `CellPin` for a cell's open threads, with the same face as `ThreadPin`. */
export function threadCellPin(
  count: number,
  target: string,
  onOpen: () => void,
): CellPin | undefined {
  if (count === 0) return undefined;
  return {
    label: <ThreadPinFace count={count} />,
    ariaLabel: pinLabel(count, target),
    count,
    onOpen,
  };
}
