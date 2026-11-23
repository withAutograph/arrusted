import { useEffect, useRef, useState, type ComponentType, type ReactNode, type Ref } from "react";

import { BodyPortalPopover, Button, StatusPill, Tag, cx, focusRing } from "@autograph/components";

/** A short pulse while `count` has just grown; never on the first count. */
export function useArrivalPulse(count: number, quiet: boolean) {
  const [pulse, setPulse] = useState(false);
  const seen = useRef<number | null>(null);
  useEffect(() => {
    const previous = seen.current;
    seen.current = count;
    if (quiet || previous === null || count <= previous) {
      // Opening the pane or a falling count ends a pulse in progress.
      setPulse(false);
      return;
    }
    setPulse(true);
    const timer = setTimeout(() => setPulse(false), 1600);
    return () => clearTimeout(timer);
  }, [count, quiet]);
  return pulse && !quiet;
}

/**
 * A top-bar button that opens its pane down from the top bar, like the
 * shell's pullouts: icon-only with a count badge, a status pill, or a
 * labelled button. The badge pulses briefly when `pulse` is set. Outside
 * clicks and Escape close the pane, except while a confirmation from inside
 * it is open.
 */
export function PaneButton({
  id,
  label,
  icon: Icon,
  count,
  open,
  pulse = false,
  pill,
  labelled = false,
  pressed,
  labelClassName,
  data,
  onOpenChange,
  children,
}: {
  id: string;
  label: string;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  count: number;
  open: boolean;
  pulse?: boolean;
  /** Shown as a status pill (e.g. "2 unsaved changes") instead of the icon and badge. */
  pill?: string;
  /** Shown as a button with the icon, `label` and the count instead of the icon alone. */
  labelled?: boolean;
  /**
   * A mode the labelled button also shows (e.g. comment mode): while on, the
   * button is filled and pressed, says `title`, and a click calls `onRelease`
   * (to turn the mode off) instead of opening the pane.
   */
  pressed?: { on: boolean; title: string; onRelease: () => void };
  /**
   * Classes for the labelled button's visible label, e.g. a container query
   * that hides it in a narrow bar; the button keeps its name and title.
   */
  labelClassName?: string;
  /** Data attributes for the button itself (e.g. `data-comment-mode`). */
  data?: Record<`data-${string}`, string>;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const anchor = useRef<HTMLElement | null>(null);
  const on = pressed?.on === true;
  return (
    <>
      {labelled ? (
        <span className="inline-flex shrink-0" ref={anchor}>
          <Button
            {...data}
            aria-expanded={open}
            aria-haspopup="dialog"
            aria-label={count > 0 ? `${label}, ${count}` : label}
            aria-pressed={pressed === undefined ? undefined : on}
            // Open shows as selected, as the icon and pill faces do; pressed stays
            // filled. The attribute variant outranks the intent's background.
            className={
              on
                ? undefined
                : "aria-expanded:bg-[var(--color-bg-selected)] aria-expanded:text-[var(--color-text-primary)]"
            }
            data-pane-button={id}
            data-pane-count={count}
            intent={on ? "primary" : "secondary"}
            leading={<Icon aria-hidden className="size-[var(--size-icon-sm)]" />}
            size="sm"
            title={on ? pressed.title : label}
            trailing={
              count > 0 ? (
                <span
                  aria-hidden
                  className={cx(
                    "inline-flex h-[var(--space-4)] min-w-[var(--space-4)] items-center justify-center rounded-[var(--radius-pill)] px-[var(--space-1)] text-[length:var(--text-micro)] font-[var(--font-weight-semibold)] tabular-nums",
                    // Inverted on the filled (pressed) button so it stays legible.
                    on
                      ? "bg-[var(--color-bg-surface)] text-[var(--color-action-primary)]"
                      : "bg-[var(--color-action-primary)] text-[var(--color-text-inverse)]",
                  )}
                >
                  {count}
                </span>
              ) : undefined
            }
            onClick={() => (on ? pressed.onRelease() : onOpenChange(!open))}
          >
            <span className={labelClassName}>{label}</span>
          </Button>
        </span>
      ) : pill === undefined ? (
        <TopBarIconButton
          buttonRef={anchor as Ref<HTMLButtonElement>}
          count={count}
          expanded={open}
          icon={Icon}
          id={id}
          label={label}
          pulse={pulse}
          onClick={() => onOpenChange(!open)}
        />
      ) : (
        <button
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={count > 0 ? `${label}, ${count}` : label}
          className={cx(
            "relative inline-flex shrink-0 rounded-[var(--radius-pill)]",
            open && "ring-2 ring-[var(--color-border-strong)]",
            focusRing,
          )}
          data-pane-button={id}
          data-pane-count={count}
          data-pulse={pulse ? "" : undefined}
          ref={anchor as Ref<HTMLButtonElement>}
          title={label}
          type="button"
          onClick={() => onOpenChange(!open)}
        >
          {pulse ? (
            <span
              aria-hidden
              className="absolute inset-[var(--space-0)] animate-ping rounded-[var(--radius-pill)] bg-[var(--color-action-primary)] opacity-30"
            />
          ) : null}
          <StatusPill label={pill} size="xs" tone={count > 0 ? "info" : "neutral"} />
        </button>
      )}
      <BodyPortalPopover
        anchorRef={anchor}
        ariaLabel={label}
        open={open}
        onClose={() => {
          // A confirmation the pane opened (e.g. Revert turn) is outside it but part of it.
          if (document.querySelector("[aria-modal='true']") !== null) return;
          onOpenChange(false);
        }}
      >
        <div
          className="flex max-h-[calc(100vh-var(--space-8)-var(--space-8)-var(--space-8))] w-[min(calc(var(--size-agent-panel-width)+var(--space-8)),calc(100vw-var(--space-4)))] flex-col overflow-hidden"
          data-pane={id}
        >
          {children}
        </div>
      </BodyPortalPopover>
    </>
  );
}

/**
 * An icon-only top-bar button with a count badge, e.g. a pane's opener or
 * the approver's bell. `expanded` marks a button that opens a popover.
 */
export function TopBarIconButton({
  id,
  label,
  icon: Icon,
  count,
  expanded,
  pulse = false,
  buttonRef,
  onClick,
}: {
  id: string;
  label: string;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  count: number;
  expanded?: boolean;
  pulse?: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
  onClick: () => void;
}) {
  return (
    <button
      aria-expanded={expanded}
      aria-haspopup={expanded === undefined ? undefined : "dialog"}
      aria-label={count > 0 ? `${label}, ${count}` : label}
      className={cx(
        "relative inline-flex size-[var(--size-control-sm)] shrink-0 items-center justify-center rounded-[var(--radius-control)]",
        expanded
          ? "bg-[var(--color-bg-selected)] text-[var(--color-text-primary)]"
          : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]",
        focusRing,
      )}
      data-pane-button={id}
      data-pulse={pulse ? "" : undefined}
      ref={buttonRef}
      title={label}
      type="button"
      onClick={onClick}
    >
      <Icon aria-hidden className="size-[var(--size-icon-md)]" />
      {count > 0 ? (
        <span
          aria-hidden
          className="absolute -right-[var(--space-1)] -top-[var(--space-0-5)] inline-flex"
          data-pane-count={count}
        >
          {pulse ? (
            <span className="absolute inset-[var(--space-0)] animate-ping rounded-[var(--radius-pill)] bg-[var(--color-action-primary)] opacity-60" />
          ) : null}
          <span className="relative inline-flex h-[var(--space-4)] min-w-[var(--space-4)] items-center justify-center rounded-[var(--radius-pill)] bg-[var(--color-action-primary)] px-[var(--space-1)] text-[length:var(--text-micro)] font-[var(--font-weight-semibold)] tabular-nums text-[var(--color-text-inverse)]">
            {count}
          </span>
        </span>
      ) : null}
    </button>
  );
}

/** A pane's title row: the name and its count. */
export function PaneHeader({ title, count }: { title: string; count: number }) {
  return (
    <header className="flex items-center gap-[var(--space-2)] border-b border-[var(--color-border-subtle)] px-[var(--space-4)] py-[var(--space-3)]">
      <h2 className="m-[var(--space-0)] text-[length:var(--text-control-md)] font-[var(--font-weight-semibold)] text-[var(--color-text-primary)]">
        {title}
      </h2>
      <Tag label={count} tone={count > 0 ? "blue" : "gray"} />
    </header>
  );
}

/** A pane's list of choices: each item is one button with a title and a line below it. */
export function PaneList({
  label,
  items,
  empty,
}: {
  label: string;
  items: readonly {
    key: string;
    title: string;
    detail: string;
    trailing?: ReactNode;
    onChoose: () => void;
  }[];
  empty: string;
}) {
  if (items.length === 0)
    return (
      <p className="m-[var(--space-0)] px-[var(--space-4)] py-[var(--space-4)] text-[length:var(--text-control-sm)] text-[var(--color-text-muted)]">
        {empty}
      </p>
    );
  return (
    <ul
      aria-label={label}
      className="m-[var(--space-0)] flex min-h-[var(--space-0)] list-none flex-col overflow-y-auto p-[var(--space-1)]"
    >
      {items.map((item) => (
        <li key={item.key}>
          <button
            className={cx(
              "flex w-full items-start gap-[var(--space-3)] rounded-[var(--radius-control)] px-[var(--space-3)] py-[var(--space-2)] text-left hover:bg-[var(--color-bg-hover)]",
              focusRing,
            )}
            type="button"
            onClick={item.onChoose}
          >
            <span className="flex min-w-[var(--space-0)] flex-1 flex-col gap-[var(--space-0-5)]">
              <span className="truncate text-[length:var(--text-control-sm)] font-[var(--font-weight-medium)] text-[var(--color-text-primary)]">
                {item.title}
              </span>
              <span className="line-clamp-2 text-[length:var(--text-caption)] leading-[var(--leading-caption)] text-[var(--color-text-secondary)]">
                {item.detail}
              </span>
            </span>
            {item.trailing}
          </button>
        </li>
      ))}
    </ul>
  );
}
