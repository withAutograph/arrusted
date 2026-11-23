import type { ReactNode } from "react";
import { cx } from "./utils";

export type TagTone = "blue" | "green" | "amber" | "red" | "gray";
const toneClass: Record<TagTone, string> = {
  blue: "bg-[var(--color-bg-selected)] text-[var(--color-action-primary-ink)]",
  green: "bg-[var(--color-status-success-bg)] text-[var(--color-status-success-ink)]",
  amber: "bg-[var(--color-status-warning-bg)] text-[var(--color-status-warning-ink)]",
  red: "bg-[var(--color-status-danger-bg)] text-[var(--color-status-danger-ink)]",
  gray: "bg-[var(--color-bg-muted)] text-[var(--color-text-secondary)]",
};

export function Tag(props: {
  label: ReactNode;
  tone?: TagTone;
  size?: "sm" | "md";
  className?: string;
}) {
  const { label, tone = "gray", size = "sm", className } = props;
  return (
    <span
      data-tag
      data-tone={tone}
      className={cx(
        "inline-flex whitespace-nowrap rounded-[var(--radius-pill)] font-[var(--font-weight-medium)]",
        size === "md"
          ? "px-[var(--space-2-5)] py-[var(--space-1)] text-[length:var(--text-body)] leading-[var(--leading-body)]"
          : "px-[var(--space-2)] py-[var(--space-0-5)] text-[length:var(--text-micro)]",
        toneClass[tone],
        className,
      )}
    >
      {label}
    </span>
  );
}
