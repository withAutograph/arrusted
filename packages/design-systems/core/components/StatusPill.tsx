import type { ReactNode } from "react";
import { Badge, type BadgeTone } from "./Display";
import { cx } from "./utils";

export type StatusPillTone = BadgeTone;

export type StatusPillProps = {
  label: ReactNode;
  tone?: StatusPillTone;
  detail?: ReactNode;
  className?: string;
  size?: "xs" | "sm";
};

export function StatusPill(props: StatusPillProps) {
  const { label, tone = "neutral", detail, className, size = "sm" } = props;
  return (
    <Badge
      tone={tone}
      size={size}
      className={cx("max-w-full flex-wrap gap-[var(--space-1)]", className)}
    >
      <span
        aria-hidden="true"
        className={cx(
          "h-[var(--size-status-dot)] w-[var(--size-status-dot)] shrink-0 rounded-[var(--radius-pill)]",
          statusDotClass[tone],
        )}
      />
      <span className="min-w-[var(--space-0)] break-words">{label}</span>
      {detail ? (
        <span className="min-w-[var(--space-0)] break-words font-[var(--font-weight-normal)] text-[var(--color-text-muted)]">
          {detail}
        </span>
      ) : null}
    </Badge>
  );
}

const statusDotClass: Record<StatusPillTone, string> = {
  neutral: "bg-[var(--color-text-muted)]",
  success: "bg-[var(--color-status-success)]",
  warning: "bg-[var(--color-status-warning)]",
  danger: "bg-[var(--color-status-danger)]",
  info: "bg-[var(--color-action-primary)]",
};
