// AnchorChip — the grounding-anchor chip.
//
// Shows what view the conversation is anchored to ("Positions grid · 3 rows
// selected"). Plain design-system UI — no assistant-ui primitive needed. Sits
// above the composer so the human always sees the agent's grounding.

import { TableCells } from "@autograph/icons";
import { cx } from "@autograph/components";

import type { ChatAnchorView } from "./types";

export type AnchorChipProps = {
  anchor: ChatAnchorView;
  className?: string;
};

export function AnchorChip(props: AnchorChipProps) {
  const { anchor, className } = props;
  return (
    <span
      className={cx(
        "inline-flex max-w-full items-center gap-[var(--space-1-5)] rounded-[var(--radius-pill)]",
        "border border-[var(--color-border-subtle)] bg-[var(--color-bg-subtle)]",
        "py-[var(--space-1)] pr-[var(--space-3)] pl-[var(--space-2-5)]",
        "text-[length:var(--text-caption)] leading-[var(--leading-caption)]",
        className,
      )}
    >
      <TableCells
        aria-hidden="true"
        className="size-[var(--size-icon-sm)] shrink-0 text-[var(--color-action-primary)]"
      />
      <span className="truncate font-[var(--font-weight-medium)] text-[var(--color-text-secondary)]">
        {anchor.surface}
      </span>
      {anchor.scope ? (
        <>
          <span aria-hidden="true" className="text-[var(--color-text-disabled)]">
            ·
          </span>
          <span className="truncate text-[var(--color-text-muted)]">{anchor.scope}</span>
        </>
      ) : null}
    </span>
  );
}
