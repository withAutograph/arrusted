import type { ReactNode } from "react";
import type { IconComponent } from "../icons";
import { Check } from "../icons";
import { cx } from "./utils";

export function KpiPill({ label, emphasis }: { label: ReactNode; emphasis?: boolean }) {
  return (
    <span
      data-kpi-pill
      className={cx(
        "inline-flex rounded-[var(--radius-pill)] px-[var(--space-1-5)] py-[var(--space-1)] text-[length:var(--text-micro)] leading-[var(--leading-micro)] text-[var(--color-text-muted)]",
        emphasis ? "bg-[var(--color-bg-accent-soft)]" : "bg-[var(--color-bg-pill-subtle)]",
      )}
    >
      {label}
    </span>
  );
}

export type KpiCardProps = {
  icon?: IconComponent;
  title: ReactNode;
  description?: ReactNode;
  value?: ReactNode;
  valueLabel?: ReactNode;
  pills?: ReactNode;
  action?: ReactNode;
  allClear?: { label: ReactNode };
  className?: string;
};

export function KpiCard(props: KpiCardProps) {
  const {
    icon: Icon,
    title,
    description,
    value,
    valueLabel,
    pills,
    action,
    allClear,
    className,
  } = props;
  return (
    <section
      data-kpi-card
      className={cx(
        "flex min-w-[var(--space-0)] flex-col gap-[var(--space-2)] rounded-[var(--radius-card-lg)] bg-[var(--color-bg-surface)] p-[var(--space-6)] shadow-[var(--shadow-card-soft)]",
        className,
      )}
    >
      <div className="flex items-start gap-[var(--space-1)]">
        {Icon ? (
          // A bare glyph, not a chip: the icon is a bullet for the title, and a
          // filled tile beside it would compete with the number below.
          <span className="flex shrink-0 items-center px-[var(--space-0-5)] py-[var(--space-px)] text-[var(--color-text-muted)]">
            <Icon aria-hidden="true" className="size-[var(--size-icon-md)]" />
          </span>
        ) : null}
        <span className="min-w-[var(--space-0)]">
          <span className="block text-[length:var(--text-control-md)] font-[var(--font-weight-semibold)] leading-[var(--leading-body)] text-[var(--color-text-secondary)]">
            {title}
          </span>
          {description ? (
            <span className="block text-[length:var(--text-micro)] leading-[var(--leading-micro)] text-[var(--color-text-muted)]">
              {description}
            </span>
          ) : null}
        </span>
      </div>
      <div className="flex items-end gap-[var(--space-1-5)] pt-[var(--space-2)]">
        <span
          data-kpi-value
          className="text-[length:var(--text-display-sm)] font-[var(--font-weight-semibold)] leading-none tracking-[var(--tracking-tight)] text-[var(--color-text-primary)] [font-variant-numeric:tabular-nums]"
        >
          {value}
        </span>
        {valueLabel ? (
          <span className="text-[length:var(--text-section-title)] font-[var(--font-weight-medium)] leading-[var(--leading-title)] tracking-[var(--tracking-tight)] text-[var(--color-text-secondary)]">
            {valueLabel}
          </span>
        ) : null}
      </div>
      {allClear ? (
        <div className="grid justify-items-center gap-[var(--space-1)] py-[var(--space-3)] text-[var(--color-status-success)]">
          <span className="grid size-[var(--size-avatar-md)] place-items-center rounded-[var(--radius-pill)] bg-[var(--color-status-success-bg)]">
            <Check aria-hidden="true" className="size-[var(--size-icon-xl)]" />
          </span>
          <span className="text-[length:var(--text-control-md)] font-[var(--font-weight-semibold)]">
            {allClear.label}
          </span>
        </div>
      ) : null}
      {pills || action ? (
        <div className="mt-auto flex flex-wrap items-end justify-between gap-[var(--space-3)]">
          <span className="flex flex-wrap gap-[var(--space-2)]">{pills}</span>
          {action}
        </div>
      ) : null}
    </section>
  );
}

export function KpiCardGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-[var(--space-4)] sm:grid-cols-2">{children}</div>;
}
