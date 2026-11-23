import type { ReactNode } from "react";
import type { ChartFrame as ChartFrameType } from "./types";

export function ChartFrame(props: {
  title?: string;
  subtitle?: string;
  frame?: ChartFrameType;
  className?: string;
  controls?: ReactNode;
  children: ReactNode;
}) {
  const className = [
    "min-w-[var(--space-0)]",
    props.frame === "flat"
      ? ""
      : "rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-[var(--space-4)]",
    props.className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <section className={className} aria-label={props.title ?? "Chart"}>
      {props.title || props.subtitle || props.controls ? (
        <header className="mb-[var(--space-3)] flex flex-wrap items-start justify-between gap-[var(--space-3)]">
          <div>
            {props.title ? (
              <h3 className="text-[length:var(--text-control-lg)] font-[var(--font-weight-semibold)] text-[var(--color-text-primary)]">
                {props.title}
              </h3>
            ) : null}
            {props.subtitle ? (
              <p className="mt-[var(--space-1)] text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
                {props.subtitle}
              </p>
            ) : null}
          </div>
          {props.controls}
        </header>
      ) : null}
      {props.children}
    </section>
  );
}

export function ChartEmptyState(props: { height: number; children: ReactNode }) {
  return (
    <div
      className="flex items-center justify-center rounded-[var(--radius-panel)] bg-[var(--color-bg-muted)] text-[length:var(--text-caption)] text-[var(--color-text-muted)]"
      style={{ height: props.height }}
    >
      {props.children}
    </div>
  );
}

export function ChartLegend(props: { items: Array<{ id: string; label: string; color: string }> }) {
  return (
    <ul className="mt-[var(--space-3)] flex flex-wrap gap-x-[var(--space-4)] gap-y-[var(--space-2)] text-[length:var(--text-caption)] text-[var(--color-text-secondary)]">
      {props.items.map((item) => (
        <li key={item.id} className="flex items-center gap-[var(--space-2)]">
          <span
            aria-hidden="true"
            className="h-[var(--size-icon-xs)] w-[var(--size-icon-xs)] rounded-[var(--radius-pill)]"
            style={{ backgroundColor: item.color }}
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}
