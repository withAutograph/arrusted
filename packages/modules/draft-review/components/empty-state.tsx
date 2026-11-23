// EmptyState — card-shaped surface used for the genuine "no cards" state
// AND for loading / error states (when only `title` is supplied).

import type { ReactNode } from "react";

import { Typography } from "@autograph/components";

export type EmptyStateProps = {
  title: string;
  body?: string;
  // Optional CTA. Apps own the action callback (e.g. navigate to the
  // editing surface). Module renders a token-styled anchor-as-button so
  // a Button import isn't required just for the empty state.
  cta?: { label: string; onClick: () => void } | null;
};

export function EmptyState(props: EmptyStateProps): ReactNode {
  return (
    <div
      data-empty-state
      className="flex flex-col items-center justify-center gap-[var(--space-3)] rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-[var(--space-6)] text-center"
    >
      <Typography variant="title" tone="primary">
        {props.title}
      </Typography>
      {props.body ? (
        <Typography variant="body" tone="muted">
          {props.body}
        </Typography>
      ) : null}
      {props.cta ? (
        <button
          type="button"
          onClick={props.cta.onClick}
          data-empty-state-cta
          className="mt-[var(--space-2)] cursor-pointer rounded-[var(--radius-control)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-subtle)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-control-sm)] font-[var(--font-weight-medium)] text-[var(--color-text-primary)] no-underline"
        >
          {props.cta.label}
        </button>
      ) : null}
    </div>
  );
}
