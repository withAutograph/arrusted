import type {
  AggregateUnit,
  DataDefinition,
  DataField,
  DataModel,
  QueryInput,
} from "@autograph/generated-app-runtime/data";
import {
  validateChartSpec,
  type ChartConfig,
  type ChartPaletteColor,
  type RangeMarkerDatum,
  type RangeMarkerPoint,
} from "@autograph/compositions";
import { createLabelIndex, fieldHeader, modelLabel } from "@autograph/work-session-tools/labels";
import {
  chartConfigSchema,
  type ChartConfig as UnitChartConfig,
} from "@autograph/work-session-tools/layout";

import type { CanvasAggregateInput, CanvasAggregateResult, CanvasRecord } from "./client";
import { naturalOrder } from "./record-values";

/**
 * A chart unit's config (`chartConfigSchema` of the layout, one source with
 * the agent tools): a model, its columns by field id and a chart kind. The
 * kernel aggregates, so a column it cannot group or sum fails there and the
 * unit shows that error; the spec only has to resolve.
 */
export const chartSpecSchema = chartConfigSchema;
export type ChartSpec = UnitChartConfig;
type AggregateSpec = Exclude<ChartSpec, { kind: "range" }>;
type RangeSpec = Extract<ChartSpec, { kind: "range" }>;

/** An aggregate chart resolved against the definition: its model and columns. */
export type AggregateChart = {
  spec: AggregateSpec;
  model: DataModel;
  /** Breakdown and donut groups; heatmap rows; a timeline's periods. */
  group: DataField;
  /** A heatmap's columns or a timeline's stacks. */
  series?: DataField;
  /** The summed or averaged column; absent for a count. */
  measure?: DataField;
};
/** A range chart resolved: each record's `value` against its group's `low`–`high` range. */
export type RangeChart = {
  spec: RangeSpec;
  model: DataModel;
  group: DataField;
  value: DataField;
  low: DataField;
  high: DataField;
  target?: DataField;
};
export type ResolvedChartSpec = AggregateChart | RangeChart;

export const isRange = (chart: ResolvedChartSpec): chart is RangeChart =>
  chart.spec.kind === "range";

/** The spec in a unit's config, resolved, or why it cannot be drawn. */
export function resolveChartSpec(
  definition: DataDefinition,
  config: unknown,
): { ok: true; chart: ResolvedChartSpec } | { ok: false; error: string } {
  const parsed = chartSpecSchema.safeParse(config);
  if (!parsed.success) return { ok: false, error: "Its settings are incomplete or not valid." };
  const spec = parsed.data;
  const labels = createLabelIndex(definition);
  const model = labels.modelById(spec.model_id);
  if (model === undefined) return { ok: false, error: "This chart's table is not in this app." };
  const field = (id: string | undefined) => (id === undefined ? null : labels.fieldById(model, id));
  const missing = {
    ok: false as const,
    error: `A column this chart uses is no longer in ${modelLabel(model)}.`,
  };
  const group = field(spec.group_by);
  if (group == null) return missing;
  if (spec.kind === "range") {
    const [value, low, high] = [field(spec.value), field(spec.low), field(spec.high)];
    const target = field(spec.target);
    if (value == null || low == null || high == null || target === undefined) return missing;
    return {
      ok: true,
      chart: { spec, model, group, value, low, high, ...(target ? { target } : {}) },
    };
  }
  const series = "series_by" in spec ? field(spec.series_by) : null;
  const measure = spec.metric.fn === "count" ? null : field(spec.metric.field_id);
  if (series === undefined || measure === undefined) return missing;
  return {
    ok: true,
    chart: { spec, model, group, ...(series ? { series } : {}), ...(measure ? { measure } : {}) },
  };
}

/**
 * The unit's own header filters as a query `where`, by field name: a filter
 * without a value, or on a column that is gone, reads everything.
 */
export function headerWhere(chart: ResolvedChartSpec): NonNullable<QueryInput["where"]> {
  return (chart.spec.filters ?? []).flatMap((filter) => {
    if (filter.value === undefined) return [];
    const field = chart.model.fields.find((item) => item.id === filter.field_id);
    return field === undefined
      ? []
      : [{ field: field.name, op: "eq" as const, value: filter.value }];
  });
}

/** What the chart measures, by column header: "Count of Person", "Sum of Base pay". */
export function metricLabel(chart: AggregateChart): string {
  if (chart.measure === undefined) return `Count of ${modelLabel(chart.model)}`;
  return `${chart.spec.metric.fn === "sum" ? "Sum" : "Average"} of ${fieldHeader(chart.measure)}`;
}

/** The chart's default title: "Base pay by Team", "Base pay vs range". */
export function chartTitle(chart: ResolvedChartSpec): string {
  if (isRange(chart)) return `${fieldHeader(chart.value)} vs range`;
  const what = chart.measure === undefined ? modelLabel(chart.model) : fieldHeader(chart.measure);
  if (chart.series === undefined) return `${what} by ${fieldHeader(chart.group)}`;
  return chart.spec.kind === "stacked_timeline"
    ? `${what} over ${fieldHeader(chart.group)} by ${fieldHeader(chart.series)}`
    : `${what} by ${fieldHeader(chart.group)} and ${fieldHeader(chart.series)}`;
}

/** The aggregate the chart reads: its group (and series) columns, one metric, by field name. */
export function chartQuery(
  chart: AggregateChart,
): Pick<CanvasAggregateInput, "groupBy" | "metrics"> {
  const { spec, group, series, measure } = chart;
  return {
    groupBy: [group.name, ...(series === undefined ? [] : [series.name])],
    metrics:
      spec.metric.fn === "count" || measure === undefined
        ? [{ fn: "count" }]
        : [{ fn: spec.metric.fn, field: measure.name }],
  };
}

/**
 * One bar, slice or cell: `key` is the raw group key value, for the
 * selection; a heatmap cell or timeline stack also has its series.
 */
export type ChartDatum = {
  id: string;
  label: string;
  value: number;
  key: unknown;
  series?: { id: string; label: string };
};
/**
 * The values of one money unit (currency and period), or of a non-money
 * metric (`unit` null). Money groups never mix units, so each unit draws on
 * its own axis.
 */
export type ChartPanel = { unit: AggregateUnit | null; data: ChartDatum[] };

/** A group key as a stable datum id. */
export const datumId = (key: unknown) => JSON.stringify(key ?? null);

/**
 * The aggregate's groups as chart panels, one per money unit. Group key
 * values are labelled as people read them: option labels, related records
 * by `recordName`, Yes/No, and "No <header>" for an empty group. Groups
 * whose metric is empty are left out.
 */
export function chartPanels(
  definition: DataDefinition,
  chart: AggregateChart,
  result: CanvasAggregateResult,
  recordName: (recordId: string) => string,
): ChartPanel[] {
  const labels = createLabelIndex(definition);
  const money = chart.measure?.type === "money_rate";
  // The money unit follows the group columns in every key.
  const unitAt = chart.series === undefined ? 1 : 2;
  const panels = new Map<string, ChartPanel>();
  for (const group of result.groups) {
    const raw = group.metrics[0];
    if (raw === null || raw === undefined) continue;
    const key = group.key[0];
    const unit = money
      ? ((group.key[unitAt] as { unit?: AggregateUnit | null })?.unit ?? null)
      : null;
    const id = datumId(unit);
    const panel = panels.get(id) ?? { unit, data: [] };
    const seriesKey = group.key[1];
    panel.data.push({
      id: chart.series === undefined ? datumId(key) : datumId([key, seriesKey]),
      label: keyLabel(labels, chart.group, key, recordName),
      value: Number(raw),
      key,
      ...(chart.series === undefined
        ? {}
        : {
            series: {
              id: datumId(seriesKey),
              label: keyLabel(labels, chart.series, seriesKey, recordName),
            },
          }),
    });
    panels.set(id, panel);
  }
  // Groups (and a heatmap's columns) in rank order; a timeline keeps the kernel's periods.
  const byGroup = rankCompare(chart.group);
  const bySeries = chart.series === undefined ? null : rankCompare(chart.series);
  const ranked = (a: ChartDatum, b: ChartDatum) =>
    byGroup(a, b) ||
    (bySeries === null || a.series === undefined || b.series === undefined
      ? 0
      : bySeries(
          { key: JSON.parse(a.series.id) as unknown, label: a.series.label },
          { key: JSON.parse(b.series.id) as unknown, label: b.series.label },
        ));
  return [...panels.values()]
    .toSorted((a, b) => datumId(a.unit).localeCompare(datumId(b.unit)))
    .map((panel) =>
      chart.spec.kind === "stacked_timeline"
        ? panel
        : { ...panel, data: panel.data.toSorted(ranked) },
    );
}

/**
 * Group keys in rank order: an enum's in its option order, numbers by value,
 * anything else (a related record's name, text) naturally by its label, so
 * levels read L3, L4 … L10; no value comes last.
 */
/** A group key's numeric value: a number, or a decimal string. */
const numericKey = (key: unknown): number | null =>
  typeof key === "number"
    ? key
    : typeof key === "string" && /^-?\d+(\.\d+)?$/u.test(key)
      ? Number(key)
      : null;

export function rankCompare(
  field: DataField,
): (a: { key: unknown; label: string }, b: { key: unknown; label: string }) => number {
  const options = field.type === "enum" ? (field.option_set ?? []).map((option) => option.id) : [];
  const rank = (key: unknown) => {
    const index = options.indexOf(String(key));
    return index === -1 ? options.length : index;
  };
  return (a, b) => {
    const [aEmpty, bEmpty] = [
      a.key === null || a.key === undefined,
      b.key === null || b.key === undefined,
    ];
    if (aEmpty || bEmpty) return Number(aEmpty) - Number(bEmpty);
    if (options.length > 0 && rank(a.key) !== rank(b.key)) return rank(a.key) - rank(b.key);
    // Numbers (decimal and integer group keys arrive as strings) by value.
    const [aNumber, bNumber] = [numericKey(a.key), numericKey(b.key)];
    if (aNumber !== null && bNumber !== null && aNumber !== bNumber) return aNumber - bNumber;
    return naturalOrder.compare(a.label, b.label);
  };
}

/** A group key as people read it. */
export function keyLabel(
  labels: ReturnType<typeof createLabelIndex>,
  field: DataField,
  key: unknown,
  recordName: (recordId: string) => string,
): string {
  if (key === null || key === undefined) return `No ${fieldHeader(field)}`;
  if (field.type === "enum" && typeof key === "string") return labels.optionLabel(field, key);
  if (typeof key === "boolean") return key ? "Yes" : "No";
  const recordId = relatedRecordId(key);
  const label =
    recordId !== null ? recordName(recordId) : typeof key === "string" ? key : String(key);
  // Charts need a visible label; an empty value keeps its key for filtering.
  return label.trim() === "" ? `Blank ${fieldHeader(field)}` : label;
}

/** The record id of a relation group key (`{ type: "record_id", value }`), else null. */
export function relatedRecordId(key: unknown): string | null {
  if (key === null || typeof key !== "object") return null;
  const tagged = key as { type?: unknown; value?: unknown };
  return tagged.type === "record_id" && typeof tagged.value === "string" ? tagged.value : null;
}

/**
 * The compositions chart config for one panel, checked by the compositions'
 * own `validateChartSpec`. Bars share one colour; a selected bar takes the
 * accent colour.
 */
export function panelConfig(
  chart: AggregateChart,
  panel: ChartPanel,
  options: { height: number; selectedId: string | null },
): ChartConfig {
  const valueLabel = metricLabel(chart);
  const common = { frame: "flat" as const, height: options.height };
  const kind = chart.spec.kind;
  // Categories are drawn by their labels: two keys with one name stay apart.
  const categories = distinctLabels(panel.data.map((datum) => [datum.id, datum.label]));
  if (kind === "donut")
    return validateChartSpec({
      family: "donut",
      ...common,
      valueLabel,
      showLegend: true,
      data: panel.data.map(({ id, value }) => ({ id, label: categories.get(id)!, value })),
    });
  if (kind === "heatmap") {
    // The heatmap's categories are its labels: two keys with one name stay apart.
    const xLabels = distinctLabels(
      panel.data.map((datum) => [datum.series?.id ?? "", datum.series?.label ?? ""]),
    );
    const yLabels = distinctLabels(panel.data.map((datum) => [datumId(datum.key), datum.label]));
    return validateChartSpec({
      family: "heatmap",
      ...common,
      valueLabel,
      xLabel: chart.series === undefined ? undefined : fieldHeader(chart.series),
      yLabel: fieldHeader(chart.group),
      data: panel.data.map((datum) => ({
        id: datum.id,
        xKey: datum.series?.id ?? "",
        xLabel: xLabels.get(datum.series?.id ?? "")!,
        yKey: datumId(datum.key),
        yLabel: yLabels.get(datumId(datum.key))!,
        value: datum.value,
      })),
    });
  }
  if (kind === "stacked_timeline") {
    const series = new Map<string, string>();
    const periods = new Map<
      string,
      { periodKey: string; periodLabel: string; values: Record<string, number> }
    >();
    for (const datum of panel.data) {
      const seriesId = datum.series?.id ?? "";
      series.set(seriesId, datum.series?.label ?? "");
      const periodKey = datumId(datum.key);
      const period = periods.get(periodKey) ?? { periodKey, periodLabel: datum.label, values: {} };
      period.values[seriesId] = datum.value;
      periods.set(periodKey, period);
    }
    const seriesLabels = distinctLabels([...series]);
    const periodLabels = distinctLabels(
      [...periods.values()].map((period) => [period.periodKey, period.periodLabel]),
    );
    return validateChartSpec({
      family: "stacked_timeline",
      ...common,
      variant: "bar",
      valueLabel,
      showLegend: true,
      series: [...series.keys()].map((id) => ({ id, label: seriesLabels.get(id)! })),
      data: [...periods.values()].map((period) => ({
        ...period,
        periodLabel: periodLabels.get(period.periodKey)!,
      })),
    });
  }
  return validateChartSpec({
    family: "breakdown",
    ...common,
    orientation: "vertical",
    valueLabel,
    data: panel.data.map(({ id, value }) => ({
      id,
      label: categories.get(id)!,
      value,
      color:
        options.selectedId !== null && id === options.selectedId
          ? ("chart-4" as const)
          : ("chart-1" as const),
    })),
  });
}

/**
 * Where a record's value sits on its own range (the spike's colour roles: the
 * palette's warm, green and coral read as below, within and above).
 */
export const rangePositions = {
  below: { label: "Below range", color: "chart-3" },
  within: { label: "Within range", color: "chart-2" },
  above: { label: "Above range", color: "chart-4" },
} as const satisfies Record<string, { label: string; color: ChartPaletteColor }>;

/** One money unit's (or the plain numbers') ranges and the records on them. */
export type RangePanel = {
  unit: AggregateUnit | null;
  rows: RangeMarkerDatum[];
  points: RangeMarkerPoint[];
  /** How many records sit below, within and above their range. */
  counts: Record<RangePosition, number>;
};
export type RangePosition = keyof typeof rangePositions;

/**
 * A range panel in one sentence: "3 below · 4 within · 1 above range.
 * Showing USD · annual."
 */
export function rangeSummary(panel: Pick<RangePanel, "counts" | "unit">): string {
  const { below, within, above } = panel.counts;
  const counts = `${below} below · ${within} within · ${above} above range.`;
  return panel.unit === null
    ? counts
    : `${counts} Showing ${panel.unit.currency} · ${panel.unit.period}.`;
}

/** A record's number or money amount, with its money unit. */
function amountOf(value: unknown): { amount: number; unit: AggregateUnit | null } | null {
  if (typeof value === "string" || typeof value === "number") {
    const amount = Number(value);
    return Number.isFinite(amount) ? { amount, unit: null } : null;
  }
  if (value === null || typeof value !== "object") return null;
  const money = value as { amount?: unknown; currency?: unknown; period?: unknown };
  if (typeof money.currency !== "string" || typeof money.period !== "string") return null;
  const amount = Number(money.amount);
  return Number.isFinite(amount)
    ? { amount, unit: { currency: money.currency, period: money.period } as AggregateUnit }
    : null;
}

/**
 * The range chart's panels from records (values by field name): one range per
 * group, from its records' lowest low to highest high, marked at their mean
 * target (or the middle without a target column), and each record's value as
 * a point coloured by where it sits on its own range. Money never mixes units:
 * one panel per currency and period, and a record whose range is in another
 * unit than its value is left out (`skipped`), as is one missing a number.
 */
export function rangePanels(
  definition: DataDefinition,
  chart: RangeChart,
  records: readonly CanvasRecord[],
  names: { record: (record: CanvasRecord) => string; related: (recordId: string) => string },
): { panels: RangePanel[]; skipped: number } {
  const labels = createLabelIndex(definition);
  type Row = { key: unknown; label: string; lows: number[]; highs: number[]; targets: number[] };
  const panels = new Map<
    string,
    {
      unit: AggregateUnit | null;
      rows: Map<string, Row>;
      points: RangeMarkerPoint[];
      counts: Record<RangePosition, number>;
    }
  >();
  type Panel = typeof panels extends Map<string, infer P> ? P : never;
  let skipped = 0;
  for (const record of records) {
    const value = amountOf(record[chart.value.name]);
    const low = amountOf(record[chart.low.name]);
    const high = amountOf(record[chart.high.name]);
    const target = chart.target === undefined ? null : amountOf(record[chart.target.name]);
    const unit = datumId(value?.unit ?? null);
    if (
      value === null ||
      low === null ||
      high === null ||
      low.amount > high.amount ||
      [low, high, ...(target === null ? [] : [target])].some(
        (bound) => datumId(bound.unit) !== unit,
      )
    ) {
      skipped += 1;
      continue;
    }
    const panel: Panel = panels.get(unit) ?? {
      unit: value.unit,
      rows: new Map(),
      points: [],
      counts: { below: 0, within: 0, above: 0 },
    };
    const key = record[chart.group.name] ?? null;
    const rowId = datumId(key);
    const row = panel.rows.get(rowId) ?? {
      key,
      label: keyLabel(labels, chart.group, key, names.related),
      lows: [],
      highs: [],
      targets: [],
    };
    row.lows.push(low.amount);
    row.highs.push(high.amount);
    if (target !== null) row.targets.push(target.amount);
    panel.rows.set(rowId, row);
    const position =
      value.amount < low.amount ? "below" : value.amount > high.amount ? "above" : "within";
    panel.counts[position] += 1;
    panel.points.push({
      id: record.id,
      rowId,
      value: value.amount,
      label: names.record(record),
      group: rangePositions[position].label,
      color: rangePositions[position].color,
    });
    panels.set(unit, panel);
  }
  const order: string[] = Object.values(rangePositions).map((position) => position.label);
  const ranked = rankCompare(chart.group);
  return {
    skipped,
    panels: [...panels.entries()]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([, panel]) => {
        // The chart's rows are its labels: two groups with one name stay apart.
        const labels = distinctLabels([...panel.rows].map(([id, row]) => [id, row.label]));
        return {
          unit: panel.unit,
          counts: panel.counts,
          // Rows in rank order (levels L3, L4 … L10), not as the records came.
          rows: [...panel.rows.entries()]
            .toSorted(([, a], [, b]) => ranked(a, b))
            .map(([id, row]) => {
              const low = Math.min(...row.lows);
              const high = Math.max(...row.highs);
              return {
                id,
                label: labels.get(id) ?? row.label,
                low,
                high,
                marker:
                  row.targets.length > 0
                    ? row.targets.reduce((sum, item) => sum + item, 0) / row.targets.length
                    : (low + high) / 2,
              };
            }),
          // Legend order: below, within, above.
          points: panel.points.toSorted((a, b) => order.indexOf(a.group) - order.indexOf(b.group)),
        };
      }),
  };
}

/**
 * The range-marker config for one range panel, checked by `validateChartSpec`:
 * the ranges in the palette's lavender, under the points.
 */
export function rangeConfig(chart: RangeChart, panel: RangePanel, height: number): ChartConfig {
  return validateChartSpec({
    family: "range_marker",
    frame: "flat",
    height,
    rangeColor: "chart-1",
    rangeLabel: `${fieldHeader(chart.low)} – ${fieldHeader(chart.high)}`,
    markerLabel: chart.target === undefined ? "Middle of range" : fieldHeader(chart.target),
    data: panel.rows,
    points: panel.points,
    showLegend: true,
  });
}

/**
 * A label per key, in first-seen order; a label two keys share gets " (2)",
 * " (3)" on its later keys, so categories named alike stay apart.
 */
export function distinctLabels(
  pairs: readonly (readonly [key: string, label: string])[],
): Map<string, string> {
  const labels = new Map<string, string>();
  // Every original label stays reserved, so a generated "Name (2)" never
  // collides with a row really named "Name (2)".
  const reserved = new Set(pairs.map(([, label]) => label));
  const taken = new Set<string>();
  for (const [key, label] of pairs) {
    if (labels.has(key)) continue;
    let name = label;
    if (taken.has(name)) {
      let count = 2;
      while (taken.has(`${label} (${count})`) || reserved.has(`${label} (${count})`)) count += 1;
      name = `${label} (${count})`;
    }
    taken.add(name);
    labels.set(key, name);
  }
  return labels;
}
