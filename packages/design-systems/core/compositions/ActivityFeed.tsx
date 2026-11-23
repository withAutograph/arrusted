import type { ReactNode } from "react";
import { Disclosure } from "../components/Disclosure";
import { Card } from "../components/Display";
import { StatusPill, type StatusPillTone } from "../components/StatusPill";
import type { CompositionSpec } from "./spec";

export type ActivityFeedValue = string | number | boolean | null;

export type ActivityFeedFieldChangeSpec = {
  fieldId: string;
  label: string;
  before?: ActivityFeedValue;
  after?: ActivityFeedValue;
};

export type ActivityFeedItemSpec = {
  id: string;
  occurredAt: string;
  occurredAtLabel?: string;
  title: string;
  detail?: string;
  actorLabel?: string;
  modelLabel?: string;
  recordLabel?: string;
  statusLabel?: string;
  statusTone?: StatusPillTone;
  changes?: ActivityFeedFieldChangeSpec[];
};

export type ActivityFeedLabels = {
  empty: string;
  inspectChanges: string;
  before: string;
  after: string;
  emptyValue: string;
  trueValue: string;
  falseValue: string;
};

export type ActivityFeedSpec = {
  items: ActivityFeedItemSpec[];
  labels?: Partial<ActivityFeedLabels>;
};

const DEFAULT_LABELS: ActivityFeedLabels = {
  empty: "No activity yet.",
  inspectChanges: "Inspect changes",
  before: "Before",
  after: "After",
  emptyValue: "Empty",
  trueValue: "Yes",
  falseValue: "No",
};

export function ActivityFeedComposition(props: {
  spec: CompositionSpec<"activity_feed", ActivityFeedSpec>;
}) {
  const labels = { ...DEFAULT_LABELS, ...props.spec.config.labels };
  const { items } = props.spec.config;

  return (
    <Card title={props.spec.title ?? "Activity"}>
      {items.length === 0 ? (
        <div className="rounded-[var(--radius-panel)] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-bg-surface)] p-[var(--space-6)] text-center text-[length:var(--text-body)] text-[var(--color-text-muted)]">
          {labels.empty}
        </div>
      ) : (
        <ol className="flex flex-col">
          {items.map((item) => (
            <li
              key={item.id}
              className="border-b border-[var(--color-border-subtle)] py-[var(--space-4)] last:border-0"
            >
              <ActivityFeedRow item={item} labels={labels} />
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function ActivityFeedRow(props: { item: ActivityFeedItemSpec; labels: ActivityFeedLabels }) {
  const { item, labels } = props;
  const hasChanges = Boolean(item.changes?.length);
  return (
    <article className="flex flex-col gap-[var(--space-3)]">
      <div className="min-w-[var(--space-0)]">
        <div className="flex flex-wrap items-center gap-[var(--space-2)]">
          <h3 className="text-[length:var(--text-title)] font-[var(--font-weight-semibold)] text-[var(--color-text-primary)]">
            {item.title}
          </h3>
          {item.statusLabel ? (
            <StatusPill label={item.statusLabel} tone={item.statusTone ?? "neutral"} />
          ) : null}
        </div>
        <p className="mt-[var(--space-1)] text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
          {item.actorLabel ? `${item.actorLabel} - ` : null}
          {item.occurredAtLabel ?? item.occurredAt}
          {item.modelLabel || item.recordLabel ? (
            <>
              {" - "}
              {[item.modelLabel, item.recordLabel].filter(Boolean).join(" / ")}
            </>
          ) : null}
        </p>
        {item.detail ? (
          <p className="mt-[var(--space-2)] text-[length:var(--text-body)] text-[var(--color-text-secondary)]">
            {item.detail}
          </p>
        ) : null}
      </div>
      {hasChanges ? (
        <Disclosure
          className="rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-subtle)] p-[var(--space-3)]"
          summary={labels.inspectChanges}
          summaryClassName="text-[length:var(--text-caption)] font-[var(--font-weight-semibold)] text-[var(--color-text-secondary)]"
        >
          <div className="mt-[var(--space-3)] flex flex-col gap-[var(--space-2)]">
            {item.changes?.map((change) => (
              <div
                key={change.fieldId}
                className="grid gap-[var(--space-2)] border-t border-[var(--color-border-subtle)] pt-[var(--space-2)]"
                style={{
                  gridTemplateColumns:
                    "minmax(var(--size-detail-label-column), 0.8fr) minmax(var(--size-detail-value-column), 1fr) minmax(var(--size-detail-value-column), 1fr)",
                }}
              >
                <span className="text-[length:var(--text-caption)] font-[var(--font-weight-semibold)] text-[var(--color-text-secondary)]">
                  {change.label}
                </span>
                <ValueBlock label={labels.before}>
                  {renderChangeValue(change.before, labels)}
                </ValueBlock>
                <ValueBlock label={labels.after}>
                  {renderChangeValue(change.after, labels)}
                </ValueBlock>
              </div>
            ))}
          </div>
        </Disclosure>
      ) : null}
    </article>
  );
}

function ValueBlock(props: { label: string; children: ReactNode }) {
  return (
    <span className="flex min-w-[var(--space-0)] flex-col gap-[var(--space-0-5)]">
      <span className="text-[length:var(--text-micro)] font-[var(--font-weight-semibold)] uppercase tracking-[var(--tracking-micro)] text-[var(--color-text-muted)]">
        {props.label}
      </span>
      <span className="break-words text-[length:var(--text-caption)] text-[var(--color-text-primary)]">
        {props.children}
      </span>
    </span>
  );
}

function renderChangeValue(
  value: ActivityFeedValue | undefined,
  labels: ActivityFeedLabels,
): ReactNode {
  if (value === undefined || value === null || value === "") {
    return <span className="text-[var(--color-text-disabled)]">{labels.emptyValue}</span>;
  }
  if (typeof value === "boolean") {
    return value ? labels.trueValue : labels.falseValue;
  }
  return String(value);
}
