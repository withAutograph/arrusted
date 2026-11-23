import type { ReactNode } from "react";
import { cx } from "./utils";
import { Typography } from "./Typography";

export function PageHeader(props: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const { title, subtitle, actions, className } = props;
  return (
    <header className={cx("flex flex-wrap items-end gap-[var(--space-4)]", className)}>
      <div className="min-w-[var(--space-0)] flex-1">
        <Typography as="h1" variant="page-title" className="m-0">
          {title}
        </Typography>
        {subtitle ? (
          <Typography variant="body" tone="secondary" className="mt-[var(--space-1)] mb-0">
            {subtitle}
          </Typography>
        ) : null}
      </div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </header>
  );
}
