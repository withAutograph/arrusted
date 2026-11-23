import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx, focusRing, type Intent, type Size } from "./utils";

/*
 * `slim` is button-only, which is why it is not in the shared `Size`: it keeps
 * body-sized text so a card action reads at the same weight as the card's own
 * copy, and only loses height and padding so it can sit on the baseline of a
 * pill row without dominating it. A slim select or input would just be short.
 */
export type ButtonSize = Size | "slim";
export type ButtonIntent = Intent | "primary-strong";

export type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  intent?: ButtonIntent;
  size?: ButtonSize;
  leading?: ReactNode;
  trailing?: ReactNode;
  loading?: boolean;
  children: ReactNode;
};

const intentClass: Record<ButtonIntent, string> = {
  primary:
    "border-transparent bg-[var(--color-action-primary)] text-[var(--color-text-inverse)] shadow-[var(--shadow-control-raised)] transition-colors hover:bg-[var(--color-action-primary-hover)]",
  "primary-strong":
    "border-transparent bg-[var(--color-action-primary-ink)] text-[var(--color-text-inverse)] shadow-[var(--shadow-control-raised)] transition-[color,background-color,border-color,box-shadow] hover:shadow-[var(--shadow-raised)]",
  secondary:
    "border-[var(--color-border-strong)] bg-transparent text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)]",
  danger:
    "border-[var(--color-status-danger)] bg-[var(--color-bg-surface)] text-[var(--color-status-danger)] transition-colors hover:bg-[var(--color-status-danger-bg)]",
  ghost:
    "border-transparent bg-transparent text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)]",
};

const sizeClass: Record<ButtonSize, string> = {
  xs: "h-[var(--size-control-xs)] gap-[var(--space-1)] px-[var(--space-2)] text-[length:var(--text-control-xs)]",
  sm: "h-[var(--size-control-sm)] gap-[var(--space-1-5)] px-[var(--space-3)] text-[length:var(--text-control-sm)]",
  // Same weight and text size as `md` on purpose: only the height and padding
  // change. A button that is also a different weight stops reading as the same
  // control at a smaller size and starts reading as a different kind of thing.
  slim: "h-[var(--size-control-sm)] gap-[var(--space-1)] px-[var(--space-3)] text-[length:var(--text-control-md)]",
  md: "h-[var(--size-control-md)] gap-[var(--space-2)] px-[var(--space-4)] text-[length:var(--text-control-md)]",
  lg: "h-[var(--size-control-lg)] gap-[var(--space-2)] px-[var(--space-5)] text-[length:var(--text-control-lg)]",
};

/*
 * The class list on its own, so a link can be given a button's appearance
 * without a <button> inside an <a>. A card action that navigates should be a
 * real anchor -- middle-click, copy-link, and "open in new tab" all have to
 * work, and a click handler on a <button> gives up all three.
 */
export function buttonClassName(options?: {
  intent?: ButtonIntent;
  size?: ButtonSize;
  disabled?: boolean;
  className?: string;
}): string {
  const { intent = "secondary", size = "md", disabled, className } = options ?? {};
  return cx(
    // Family, weight, and line-height are stated here rather than left to
    // inherit: `button` elements do not inherit type from the page the way an
    // anchor does, so a link-shaped action and a real button only look alike if
    // both are told the same thing.
    //
    // `family-name:` is load-bearing. Without the hint Tailwind cannot tell a
    // family from a weight and resolves the arbitrary value to `font-weight` --
    // so the family silently became an invalid weight and clobbered the semibold
    // beside it. (Written without the offending class spelled out: Tailwind
    // scans comments too, and would emit the broken rule from this very note.)
    "inline-flex items-center justify-center rounded-[var(--radius-control)] border font-[family-name:var(--font-sans)] font-[var(--font-weight-semibold)] leading-[var(--leading-body)] tracking-[var(--tracking-tight)]",
    focusRing,
    intentClass[intent],
    sizeClass[size],
    disabled && "cursor-not-allowed opacity-50",
    className,
  );
}

export function Button(props: ButtonProps) {
  const {
    intent = "secondary",
    size = "md",
    leading,
    trailing,
    loading,
    disabled,
    className,
    children,
    ...rest
  } = props;
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={buttonClassName({
        intent,
        size,
        disabled: disabled || loading,
        className,
      })}
      {...rest}
    >
      {leading}
      <span>{loading ? "Loading..." : children}</span>
      {trailing}
    </button>
  );
}
