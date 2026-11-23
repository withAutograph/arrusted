import type { ReactNode } from "react";

import { cx, focusRing } from "./utils";

export type RecordListItem = {
  id: string;
  primary: ReactNode;
  secondary?: ReactNode;
  trailing?: ReactNode;
  disabled?: boolean;
};

export type RecordListProps = {
  items: readonly RecordListItem[];
  ariaLabel: string;
  selectedId?: string;
  onSelect: (id: string) => void;
  heading?: ReactNode;
  summary?: ReactNode;
  /** Full-width supporting context below the heading and compact summary. */
  description?: ReactNode;
  emptyState?: ReactNode;
  className?: string;
};

/**
 * A controlled master-list for record review. It deliberately owns row
 * interaction so consumers do not restyle a general-purpose Button as a row.
 */
export function RecordList(props: RecordListProps) {
  const {
    items,
    ariaLabel,
    selectedId,
    onSelect,
    heading,
    summary,
    description,
    emptyState,
    className,
  } = props;
  return (
    <section
      aria-label={ariaLabel}
      className={cx(
        "overflow-hidden rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)]",
        className,
      )}
    >
      {description != null ? (
        <div className="border-b border-[var(--color-border-subtle)] p-[var(--space-4)]">
          {heading != null || summary != null ? (
            <div className="flex flex-wrap items-baseline justify-between gap-[var(--space-2)]">
              {heading != null ? (
                <h2 className="m-0 text-[length:var(--text-section-title)] font-[var(--font-weight-semibold)] leading-[var(--leading-section-title)]">
                  {heading}
                </h2>
              ) : null}
              {summary != null ? (
                <span className="text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
                  {summary}
                </span>
              ) : null}
            </div>
          ) : null}
          <p className="mb-0 mt-[var(--space-1)] text-[length:var(--text-body)] font-[var(--font-weight-normal)] leading-[var(--leading-body)] text-[var(--color-text-primary)]">
            {description}
          </p>
        </div>
      ) : heading != null || summary != null ? (
        <div className="flex flex-wrap items-baseline justify-between gap-[var(--space-2)] border-b border-[var(--color-border-subtle)] p-[var(--space-4)]">
          {heading != null ? (
            <h2 className="m-0 text-[length:var(--text-section-title)] font-[var(--font-weight-semibold)] leading-[var(--leading-section-title)]">
              {heading}
            </h2>
          ) : null}
          {summary != null ? (
            <span className="text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
              {summary}
            </span>
          ) : null}
        </div>
      ) : null}
      {items.length ? (
        <ul className="m-0 list-none p-0">
          {items.map((item) => {
            const selected = item.id === selectedId;
            return (
              <li
                key={item.id}
                className="border-b border-[var(--color-border-subtle)] last:border-b-0"
              >
                <button
                  type="button"
                  disabled={item.disabled}
                  aria-pressed={selected}
                  data-record-list-item="true"
                  data-record-list-id={item.id}
                  data-selected={selected ? "true" : undefined}
                  className={cx(
                    "flex min-h-[var(--size-control-lg)] w-full items-start justify-between gap-[var(--space-3)] px-[var(--space-4)] py-[var(--space-3)] text-left transition-colors hover:bg-[var(--color-bg-hover)] data-[selected=true]:bg-[var(--color-bg-selected)] data-[selected=true]:shadow-[inset_3px_0_0_var(--color-action-primary)] disabled:cursor-not-allowed disabled:opacity-50",
                    focusRing,
                  )}
                  onClick={() => onSelect(item.id)}
                >
                  <span className="min-w-[var(--space-0)] flex-1">
                    <span className="block text-[length:var(--text-body)] font-[var(--font-weight-semibold)] leading-[var(--leading-body)] text-[var(--color-text-primary)]">
                      {item.primary}
                    </span>
                    {item.secondary != null ? (
                      <span className="mt-[var(--space-0-5)] block text-[length:var(--text-caption)] leading-[var(--leading-caption)] text-[var(--color-text-muted)]">
                        {item.secondary}
                      </span>
                    ) : null}
                  </span>
                  {item.trailing != null ? (
                    <span className="flex shrink-0 flex-col items-end gap-[var(--space-1)] text-right">
                      {item.trailing}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="p-[var(--space-6)] text-center text-[length:var(--text-body)] text-[var(--color-text-muted)]">
          {emptyState ?? "No records."}
        </div>
      )}
    </section>
  );
}
