import { Component, type PointerEvent, type ReactNode } from "react";

import { Button, cx } from "@autograph/components";
import { Close } from "@autograph/icons";

import { useCommentMode, type ThreadAnchor } from "./comment-mode";

/** Keeps one failing unit from taking down the canvas. */
class UnitErrorBoundary extends Component<
  { title: string; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        className="flex h-full items-center justify-center p-[var(--space-6)] text-center text-[length:var(--text-body)] text-[var(--color-text-muted)]"
        role="alert"
      >
        {this.props.title} could not be shown.
      </div>
    );
  }
}

export type UnitFrameProps = {
  /** The unit's id in the layout; comment mode anchors to it when nothing inside claims the click. */
  unitId: string;
  title: string;
  /** Unit controls shown in the header, e.g. a model or metric picker. */
  controls?: ReactNode;
  /** Markers beside the title, e.g. a `ThreadPin` for threads on the unit. */
  pins?: ReactNode;
  /** Absent when the unit cannot be removed. */
  onRemove?: () => void;
  /**
   * A primary-button press on the header outside its controls: the start of a
   * move. Absent when the unit is not movable.
   */
  onMoveStart?: (event: PointerEvent<HTMLElement>) => void;
  className?: string;
  children: ReactNode;
};

/**
 * A unit's flat card: title, controls and a remove action in the header, and
 * the content in its own scroll area. It fills the box its parent gives it.
 * In comment mode, a click inside that no target claimed anchors to the unit.
 */
export function UnitFrame({
  unitId,
  title,
  controls,
  pins,
  onRemove,
  onMoveStart,
  className,
  children,
}: UnitFrameProps) {
  const comment = useCommentMode();
  const anchor: ThreadAnchor = { unit_id: unitId };
  return (
    <section
      aria-label={title}
      className={cx(
        "flex h-full w-full min-w-[var(--space-0)] flex-col overflow-hidden",
        "rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)]",
        comment.on &&
          "cursor-crosshair outline-dashed outline-1 outline-offset-2 outline-[var(--color-action-primary)]",
        className,
      )}
      data-canvas-unit={unitId}
      onClick={() => {
        if (comment.on) comment.fallback(anchor);
      }}
      // In comment mode the unit is also reachable by keyboard: Enter on it anchors there.
      tabIndex={comment.on ? 0 : undefined}
      onKeyDown={(event) => {
        if (comment.on && event.key === "Enter" && event.target === event.currentTarget)
          comment.anchor(anchor);
      }}
    >
      <header
        className={cx(
          "flex min-h-[var(--size-control-lg)] shrink-0 items-start gap-[var(--space-3)] border-b border-[var(--color-border-subtle)] px-[var(--space-4)] py-[var(--space-2)]",
          onMoveStart && !comment.on && "cursor-grab touch-none select-none active:cursor-grabbing",
        )}
        data-move-handle={onMoveStart ? "" : undefined}
        onPointerDown={(event) => {
          if (!onMoveStart || comment.on || event.button !== 0) return;
          // Header controls (pickers, pins, remove) are not move starts.
          if ((event.target as HTMLElement).closest("button, select, input, a, [role='combobox']"))
            return;
          onMoveStart(event);
        }}
      >
        {/*
         * The title comes first and keeps its full width: controls sit beside it
         * while they fit and wrap onto rows below it in a narrow unit. Only a
         * title wider than the whole header is cut short.
         */}
        <div
          className="flex min-w-[var(--space-0)] flex-1 flex-wrap items-center justify-between gap-x-[var(--space-3)] gap-y-[var(--space-1)]"
          data-unit-header-main
        >
          <div
            className="flex min-h-[var(--size-control-sm)] min-w-[var(--space-0)] max-w-full shrink-0 items-center gap-[var(--space-2)]"
            data-unit-title-row
          >
            <h2 className="m-[var(--space-0)] min-w-[var(--space-0)] truncate text-[length:var(--text-control-md)] font-[var(--font-weight-semibold)] text-[var(--color-text-primary)]">
              {title}
            </h2>
            {pins}
          </div>
          {controls === undefined || controls === null ? null : (
            <div
              className="ml-auto flex min-w-[var(--space-0)] max-w-full flex-wrap items-center justify-end gap-[var(--space-2)]"
              data-unit-controls
            >
              {controls}
            </div>
          )}
        </div>
        {/* Remove stays at the end of the title's row, however the controls wrap. */}
        {onRemove ? (
          <span className="flex h-[var(--size-control-sm)] shrink-0 items-center" data-unit-remove>
            <Button
              aria-label={`Remove ${title}`}
              className="-mr-[var(--space-1)] px-[var(--space-1)]"
              intent="ghost"
              size="xs"
              title="Remove from canvas"
              onClick={(event) => {
                event.stopPropagation();
                onRemove();
              }}
            >
              <Close aria-hidden className="size-[var(--size-icon-sm)]" />
            </Button>
          </span>
        ) : null}
      </header>
      <div className="min-h-[var(--space-0)] flex-1 overflow-auto" data-unit-content>
        <UnitErrorBoundary title={title}>{children}</UnitErrorBoundary>
      </div>
    </section>
  );
}
