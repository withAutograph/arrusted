import { useEffect, useMemo, useState } from "react";
import type { AggregateUnit, DataField, DataModel } from "@autograph/generated-app-runtime/data";
import { Button } from "@autograph/components";
import { KpiStripComposition, type KpiStripSpec } from "@autograph/compositions";
import { createLabelIndex, fieldHeader, modelLabel } from "@autograph/work-session-tools/labels";
import { kpiConfigSchema, type KpiConfig } from "@autograph/work-session-tools/layout";

import { failureMessage, type CanvasAggregateInput, type CanvasClient } from "./client";
import { formatMoney } from "./money";
import { useCanvasSelection, type SelectionStore } from "./selection";
import type { UnitSession } from "./use-canvas-session";

export type KpiUnitProps = {
  client: CanvasClient;
  unitId: string;
  /** The unit's config (`kpiConfigSchema`). */
  config: unknown;
  session: UnitSession;
  selection: SelectionStore;
};

type Metric = KpiConfig["metrics"][number] & { field?: DataField };
type Resolved = { model: DataModel; metrics: Metric[] };
type Item = KpiStripSpec["items"][number];

const fnLabel: Record<Metric["fn"], string> = {
  count: "Count",
  sum: "Total",
  avg: "Average",
  min: "Lowest",
  max: "Highest",
  median: "Median",
};

/** A KPI unit's config resolved against the definition, or why it cannot be shown. */
export function resolveKpi(
  definition: CanvasClient["definition"],
  config: unknown,
): { ok: true; kpi: Resolved } | { ok: false; error: string } {
  const parsed = kpiConfigSchema.safeParse(config);
  if (!parsed.success) return { ok: false, error: "Its settings are incomplete or not valid." };
  const labels = createLabelIndex(definition);
  const model = labels.modelById(parsed.data.model_id);
  if (model === undefined) return { ok: false, error: "Its table is not in this app." };
  const metrics: Metric[] = [];
  for (const metric of parsed.data.metrics) {
    if (metric.fn === "count") {
      metrics.push(metric);
      continue;
    }
    const field =
      metric.field_id === undefined ? undefined : labels.fieldById(model, metric.field_id);
    if (field === undefined)
      return { ok: false, error: `A column it measures is no longer in ${modelLabel(model)}.` };
    metrics.push({ ...metric, field });
  }
  return { ok: true, kpi: { model, metrics } };
}

/** A KPI unit's title: "Employee at a glance". */
export function kpiUnitTitle(client: CanvasClient, config: unknown): string {
  const resolved = resolveKpi(client.definition, config);
  return resolved.ok ? `${modelLabel(resolved.kpi.model)} at a glance` : "Key figures";
}

const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
/** A kernel decimal string formatted exactly (Intl rounds the string, not a float). */
const decimal = (raw: string) => numberFormat.format(raw as `${number}`);
const label = (metric: Metric, model: DataModel) =>
  metric.field === undefined
    ? `${modelLabel(model)} records`
    : `${fnLabel[metric.fn]} ${fieldHeader(metric.field)}`;

/**
 * A strip of key figures over one model, drawn by `KpiStripComposition` from
 * the kernel's aggregates over the session (under any filter another unit's
 * selection sets). Money is never summed across units: a money figure shows
 * once per currency and period, with that unit beside it.
 */
export function KpiUnit({ client, unitId, config, session, selection: store }: KpiUnitProps) {
  const resolved = useMemo(
    () => resolveKpi(client.definition, config),
    [client.definition, config],
  );
  const { whereFor } = useCanvasSelection(store);
  const whereKey = JSON.stringify(resolved.ok ? whereFor(unitId, resolved.kpi.model.id) : []);
  const sessionId = session.session?.id ?? null;
  const asOf = session.session?.as_of ?? null;
  const [read, setRead] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; items: Item[] }
  >({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!resolved.ok || sessionId === null || asOf === null) return;
    const { model, metrics } = resolved.kpi;
    let live = true;
    const base = {
      asOf,
      work: { sessionId },
      where: JSON.parse(whereKey) as CanvasAggregateInput["where"],
    };
    const query = (metric: Metric): CanvasAggregateInput["metrics"][number] =>
      metric.fn === "count" || metric.field === undefined
        ? { fn: "count" }
        : { fn: metric.fn, field: metric.field.name };
    void (async () => {
      const plain = metrics.filter((metric) => metric.field?.type !== "money_rate");
      // Plain figures in one read; each money figure on its own, grouped by unit.
      const totals =
        plain.length === 0
          ? null
          : await client.data.aggregate(model.id, { ...base, metrics: plain.map(query) });
      const items: Item[] = [];
      for (const [index, metric] of metrics.entries()) {
        const id = `${index}`;
        if (metric.field?.type !== "money_rate") {
          const raw = totals?.total.metrics[plain.indexOf(metric)] ?? null;
          items.push({
            id,
            label: label(metric, model),
            value: raw === null ? "—" : decimal(raw),
          });
          continue;
        }
        const result = await client.data.aggregate(model.id, { ...base, metrics: [query(metric)] });
        const groups = result.groups.filter((group) => group.metrics[0] != null);
        if (groups.length === 0) items.push({ id, label: label(metric, model), value: "—" });
        for (const group of groups) {
          const unit = (group.key[0] as { unit?: AggregateUnit | null } | undefined)?.unit ?? null;
          const amount = group.metrics[0]!;
          // The figure carries its currency (symbol) and period (suffix): `$2.4M`, `$42.50/hr`.
          items.push({
            id: `${id}:${unit?.currency}:${unit?.period}`,
            label: label(metric, model),
            value: unit === null ? decimal(amount) : formatMoney(amount, unit, true),
          });
        }
      }
      return items;
    })().then(
      (items) => {
        if (live) setRead({ status: "ready", items });
      },
      (error: unknown) => {
        if (live)
          setRead({
            status: "error",
            message: failureMessage(error, "The figures could not be read."),
          });
      },
    );
    return () => {
      live = false;
    };
  }, [client, resolved, sessionId, asOf, session.revision, session.generation, whereKey, attempt]);

  const message = (text: string, retry = false) => (
    <div
      className="flex h-full items-center justify-center gap-[var(--space-3)] p-[var(--space-4)] text-[length:var(--text-body)] text-[var(--color-text-muted)]"
      role={retry ? "alert" : undefined}
    >
      <span>{text}</span>
      {retry ? (
        <Button intent="secondary" size="xs" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </Button>
      ) : null}
    </div>
  );
  if (!resolved.ok) return message(`These figures cannot be shown. ${resolved.error}`);
  if (read.status === "error")
    return message(`The figures could not be read: ${read.message}`, true);
  if (read.status === "loading") return message("Loading figures…");
  return (
    <div
      className="h-full overflow-auto px-[var(--space-4)] py-[var(--space-3)]"
      data-kpi-unit={unitId}
    >
      {/* One frame: the unit's. The figures sit flat inside it. */}
      <KpiStripComposition
        spec={{ type: "kpi_strip", config: { items: read.items, flat: true } }}
      />
    </div>
  );
}
