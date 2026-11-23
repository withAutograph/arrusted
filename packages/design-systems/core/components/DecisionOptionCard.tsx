import type { ReactNode } from "react";
import { cx } from "./utils";

export type DecisionOptionCardProps = {
  title: ReactNode;
  description?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  tag?: ReactNode;
  name: string;
  value: string;
  onSelect: () => void;
  density?: "comfortable" | "compact";
  className?: string;
};

export function DecisionOptionCard(props: DecisionOptionCardProps) {
  const {
    title,
    description,
    selected,
    disabled,
    tag,
    name,
    value,
    onSelect,
    density = "comfortable",
    className,
  } = props;
  const compact = density === "compact";
  return (
    <label
      data-decision-option-card
      className={cx(
        "relative grid grid-cols-[var(--space-5)_minmax(0,1fr)] rounded-[var(--radius-shell)] border shadow-[var(--shadow-subtle)] transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--color-action-primary-ink)]",
        compact
          ? "gap-[var(--space-3)] p-[var(--space-3)]"
          : "gap-[var(--space-4)] p-[var(--space-4)]",
        selected
          ? "border-[var(--color-action-primary-ink)] bg-[var(--color-bg-selected)]"
          : "border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] hover:bg-[var(--color-bg-hover)]",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
        className,
      )}
    >
      <input
        className="sr-only"
        type="radio"
        name={name}
        value={value}
        checked={selected}
        disabled={disabled}
        onChange={onSelect}
      />
      <span
        aria-hidden="true"
        className={cx(
          "mt-[var(--space-0-5)] grid h-[var(--space-5)] w-[var(--space-5)] place-items-center rounded-[var(--radius-pill)] border",
          selected
            ? "border-[var(--color-action-primary-ink)] bg-[var(--color-action-primary-ink)]"
            : "border-[var(--color-border-strong)] bg-[var(--color-bg-surface)]",
        )}
      >
        {selected ? (
          <span className="h-[var(--space-2)] w-[var(--space-2)] rounded-[var(--radius-pill)] bg-[var(--color-text-inverse)]" />
        ) : null}
      </span>
      <span
        className={cx(
          "flex min-w-[var(--space-0)] items-start",
          compact ? "gap-[var(--space-2)]" : "gap-[var(--space-3)]",
        )}
      >
        <span className="min-w-[var(--space-0)] flex-1">
          <span className="block text-[length:var(--text-title)] font-[var(--font-weight-semibold)] text-[var(--color-text-primary)]">
            {title}
          </span>
          {description ? (
            <span
              className={cx(
                "block text-[length:var(--text-body)] text-[var(--color-text-secondary)]",
                compact ? "mt-[var(--space-0-5)]" : "mt-[var(--space-1)]",
              )}
            >
              {description}
            </span>
          ) : null}
        </span>
        {tag ? <span className="shrink-0">{tag}</span> : null}
      </span>
    </label>
  );
}
