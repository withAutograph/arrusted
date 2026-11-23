import type { ReactNode } from "react";
import { cx } from "./utils";

export function Divider(props: { className?: string }) {
  return (
    <div
      className={cx(
        "h-[var(--size-divider)] w-full bg-[var(--color-border-subtle)]",
        props.className,
      )}
    />
  );
}

export function Card(props: {
  children: ReactNode;
  title?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const { children, title, actions, className } = props;
  return (
    <section
      className={cx(
        "rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)]",
        className,
      )}
    >
      {title || actions ? (
        <header className="flex items-center justify-between gap-[var(--space-3)] border-b border-[var(--color-border-subtle)] px-[var(--space-4)] py-[var(--space-3)]">
          <h3 className="text-[length:var(--text-control-lg)] font-[var(--font-weight-semibold)]">
            {title}
          </h3>
          {actions}
        </header>
      ) : null}
      <div className="p-[var(--space-4)]">{children}</div>
    </section>
  );
}

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

const badgeClass: Record<BadgeTone, string> = {
  neutral: "border-[var(--color-border-subtle)] text-[var(--color-text-secondary)]",
  success: "border-[var(--color-status-success)] text-[var(--color-status-success)]",
  warning: "border-[var(--color-status-warning)] text-[var(--color-status-warning)]",
  danger: "border-[var(--color-status-danger)] text-[var(--color-status-danger)]",
  info: "border-[var(--color-action-primary)] text-[var(--color-action-primary)]",
};

export function Badge(props: {
  tone?: BadgeTone;
  size?: "xs" | "sm";
  children: ReactNode;
  className?: string;
}) {
  const { tone = "neutral", size = "sm", children, className } = props;
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-[var(--radius-pill)] border bg-transparent font-[var(--font-weight-medium)]",
        size === "xs"
          ? "px-[var(--space-2)] py-[var(--space-1)] text-[length:var(--text-badge-xs)] leading-[var(--leading-badge-xs)]"
          : "px-[var(--space-2-5)] py-[var(--space-0-5)] text-[length:var(--text-caption)]",
        badgeClass[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export type TabItem = { id: string; label: ReactNode; disabled?: boolean };

export function Tabs(props: {
  items: TabItem[];
  value: string;
  onValueChange: (value: string) => void;
}) {
  const { items, value, onValueChange } = props;
  return (
    <div className="inline-flex rounded-[var(--radius-control)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-subtle)] p-[var(--space-1)]">
      {items.map((item) => {
        const active = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            disabled={item.disabled}
            onClick={() => onValueChange(item.id)}
            className={cx(
              "rounded-[var(--radius-control)] px-[var(--space-3)] py-[var(--space-1-5)] text-[length:var(--text-control-sm)] font-[var(--font-weight-medium)]",
              active
                ? "bg-[var(--color-bg-surface)] text-[var(--color-text-primary)] shadow-[var(--shadow-control)]"
                : "text-[var(--color-text-muted)]",
              item.disabled && "cursor-not-allowed opacity-50",
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
