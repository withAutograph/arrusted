import { Badge } from "../components/Display";
import { Typography } from "../components/Typography";
import { cx } from "../components/utils";
import type { CompositionSpec } from "./spec";

export * from "./charting";

export type KpiStripSpec = {
  /** Without frames: the figures sit on their surface, divided by a rule (inside a framed unit). */
  flat?: boolean;
  /** `container` responds to the strip's available width instead of the viewport. */
  layout?: "responsive" | "container";
  /** `primary` gives decision labels the existing body-strong primary text treatment. */
  labelEmphasis?: "primary";
  /** Limits a container-layout decision strip to two or three columns; defaults to three. */
  maxColumns?: 2 | 3;
  items: Array<{
    id: string;
    label: string;
    value: string;
    /** Optional semantic explanation shown below the KPI value. */
    description?: string;
    /** In a two-column container strip, reserves the full second row for an outcome. */
    span?: "full";
    delta?: string;
    tone?: "neutral" | "success" | "warning" | "danger";
  }>;
};

export function KpiStripComposition(props: { spec: CompositionSpec<"kpi_strip", KpiStripSpec> }) {
  const layout = props.spec.config.layout ?? "responsive";
  const labelEmphasis = props.spec.config.labelEmphasis;
  const maxColumns = props.spec.config.maxColumns ?? 3;
  const items = props.spec.config.items.map((item) => (
    <div
      key={item.id}
      className={cx(
        props.spec.config.flat
          ? "border-l border-[var(--color-border-subtle)] px-[var(--space-4)] py-[var(--space-1)] first:border-l-0 first:pl-[var(--space-0)]"
          : "rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-[var(--space-4)]",
        layout === "container" && maxColumns === 2 && item.span === "full" && "col-span-full",
      )}
    >
      {labelEmphasis === "primary" ? (
        <Typography as="div" variant="body-strong" tone="primary">
          {item.label}
        </Typography>
      ) : (
        <div className="text-[length:var(--text-caption)] font-[var(--font-weight-medium)] text-[var(--color-text-muted)]">
          {item.label}
        </div>
      )}
      <div className="mt-[var(--space-1)] text-[length:var(--text-page-title)] font-[var(--font-weight-semibold)]">
        {item.value}
      </div>
      {item.description ? (
        <Typography as="div" variant="body" tone="primary" className="mt-[var(--space-1)]">
          {item.description}
        </Typography>
      ) : null}
      {item.delta ? <Badge tone={item.tone}>{item.delta}</Badge> : null}
    </div>
  ));

  if (layout === "container") {
    return (
      <div className="@container/kpi-strip">
        <div
          className={cx(
            "grid grid-cols-1 gap-[var(--space-3)] @sm/kpi-strip:grid-cols-2",
            maxColumns === 3 && "@lg/kpi-strip:grid-cols-3",
          )}
        >
          {items}
        </div>
      </div>
    );
  }

  return <div className="grid gap-[var(--space-3)] sm:grid-cols-2 lg:grid-cols-4">{items}</div>;
}
