import { useMemo, useRef, useState } from "react";

import {
  BodyPortalPopover,
  Button,
  FieldFrame,
  SegmentedControl,
  Select,
} from "@autograph/components";
import type { DataDefinition, DataField, WorkJson } from "@autograph/generated-app-runtime/data";
import { Plus } from "@autograph/icons";
import { fieldHeader, modelLabel } from "@autograph/work-session-tools/labels";

import type { ChartKind, UnitKind } from "@autograph/work-session-tools/layout";
import { shownFields } from "./record-values";

/** Columns a chart can group by: one value per record. */
const groupable = new Set([
  "text",
  "enum",
  "bool",
  "relation",
  "date",
  "iso_country",
  "iso_currency",
  "number",
]);
/** Columns a chart can sum or average. */
const measurable = new Set(["number", "money_rate"]);
const groupOrder = (field: DataField) =>
  field.type === "enum" ? 0 : field.type === "bool" ? 1 : field.type === "relation" ? 2 : 3;
const kindOptions = [
  { value: "grid", label: "Table" },
  { value: "chart", label: "Chart" },
  { value: "graph", label: "Graph" },
  { value: "kpi", label: "Figures" },
  { value: "note", label: "Note" },
] as const satisfies readonly { value: Exclude<UnitKind, "rule">; label: string }[];
const chartKindOptions = [
  { value: "breakdown", label: "Bars" },
  { value: "donut", label: "Donut" },
  { value: "heatmap", label: "Heatmap" },
  { value: "stacked_timeline", label: "Stacked over time" },
  { value: "range", label: "Range" },
] as const satisfies readonly { value: ChartKind; label: string }[];
/** Columns a stacked timeline runs over: dates (aggregates group by date, not datetime). */
const timeTypes = new Set(["date"]);

/** A new unit's kind and config, as `addUnit` takes them. */
export type NewUnit = { kind: UnitKind; config: { [key: string]: WorkJson } };

const option = (field: DataField) => ({ value: field.id, label: fieldHeader(field) });

/**
 * The form inside the Add to canvas picker: what kind of unit and what it shows,
 * by model label and column header. Columns the chart or graph cannot use
 * are left out; the kernel still judges the aggregate.
 */
export function AddUnitForm({
  definition,
  onAdd,
  onCancel,
}: {
  definition: DataDefinition;
  onAdd: (unit: NewUnit) => void;
  onCancel: () => void;
}) {
  const models = definition.models;
  const [kind, setKind] = useState<(typeof kindOptions)[number]["value"]>("grid");
  const [chartKind, setChartKind] = useState<ChartKind>("breakdown");
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const model = models.find((item) => item.id === modelId);
  const fields = useMemo(() => (model === undefined ? [] : shownFields(model)), [model]);
  // Option columns first: they make the most readable groups.
  const groups = fields
    .filter((field) => groupable.has(field.type))
    .toSorted((a, b) => groupOrder(a) - groupOrder(b));
  const relations = fields.filter(
    (field) => field.type === "relation" && typeof field.target_model === "string",
  );
  const metrics = [
    { value: "count", label: `Count of ${model === undefined ? "records" : modelLabel(model)}` },
    ...fields
      .filter((field) => measurable.has(field.type))
      .flatMap((field) => [
        { value: `sum:${field.id}`, label: `Sum of ${fieldHeader(field)}` },
        { value: `avg:${field.id}`, label: `Average of ${fieldHeader(field)}` },
      ]),
  ];
  const numbers = fields.filter((field) => measurable.has(field.type));
  const times = fields.filter((field) => timeTypes.has(field.type));
  const [groupBy, setGroupBy] = useState<string | null>(null);
  const [seriesBy, setSeriesBy] = useState<string | null>(null);
  const [metric, setMetric] = useState("count");
  const [relation, setRelation] = useState<string | null>(null);
  const [range, setRange] = useState<{
    value?: string;
    low?: string;
    high?: string;
    target?: string;
  }>({});
  // A timeline runs over a date column; every other chart groups by any groupable one.
  const groupChoices = chartKind === "stacked_timeline" ? times : groups;
  // A pick that the newly chosen model does not have falls back to its first column.
  const group = groupChoices.find((field) => field.id === groupBy) ?? groupChoices[0];
  const series =
    groups.find((field) => field.id === seriesBy && field.id !== group?.id) ??
    groups.find((field) => field.id !== group?.id);
  const measure = metrics.find((item) => item.value === metric) ?? metrics[0]!;
  const follow = relations.find((field) => field.id === relation) ?? relations[0];
  const pickNumber = (id: string | undefined, index: number) =>
    numbers.find((field) => field.id === id) ?? numbers[Math.min(index, numbers.length - 1)];
  const rangeFields = {
    value: pickNumber(range.value, 0),
    low: pickNumber(range.low, 1),
    high: pickNumber(range.high, 2),
    target: numbers.find((field) => field.id === range.target),
  };
  const withSeries = chartKind === "heatmap" || chartKind === "stacked_timeline";

  const unit = (): NewUnit | null => {
    if (kind === "note") return { kind, config: { text: "" } };
    if (model === undefined) return null;
    if (kind === "grid") return { kind, config: { model_id: model.id } };
    const [fn, fieldId] = measure.value.split(":");
    const chosen: { [key: string]: WorkJson } =
      fn === "count" ? { fn: "count" } : { fn: fn!, field_id: fieldId! };
    if (kind === "kpi")
      return {
        kind,
        config: {
          model_id: model.id,
          metrics: fn === "count" ? [chosen] : [{ fn: "count" }, chosen],
        },
      };
    if (kind === "chart") {
      if (group === undefined) return null;
      if (chartKind === "range") {
        const { value, low, high, target } = rangeFields;
        // Value, low and high are three different columns.
        if (value === undefined || low === undefined || high === undefined) return null;
        if (new Set([value.id, low.id, high.id]).size < 3) return null;
        return {
          kind,
          config: {
            kind: chartKind,
            model_id: model.id,
            group_by: group.id,
            value: value.id,
            low: low.id,
            high: high.id,
            ...(target === undefined ? {} : { target: target.id }),
          },
        };
      }
      if (withSeries && series === undefined) return null;
      return {
        kind,
        config: {
          kind: chartKind,
          model_id: model.id,
          group_by: group.id,
          ...(withSeries && series !== undefined ? { series_by: series.id } : {}),
          metric: chosen,
        },
      };
    }
    if (follow === undefined) return null;
    return { kind, config: { model_id: model.id, field_id: follow.id } };
  };
  const ready = unit();
  const missing =
    model === undefined || kind === "note"
      ? null
      : kind === "chart" && group === undefined
        ? chartKind === "stacked_timeline"
          ? `${modelLabel(model)} has no date column to run over.`
          : `${modelLabel(model)} has no column to group by.`
        : kind === "chart" && withSeries && series === undefined
          ? `${modelLabel(model)} has no second column to split by.`
          : kind === "chart" && chartKind === "range" && numbers.length === 0
            ? `${modelLabel(model)} has no number or money column.`
            : kind === "chart" &&
                chartKind === "range" &&
                new Set([rangeFields.value?.id, rangeFields.low?.id, rangeFields.high?.id]).size < 3
              ? "Choose three different columns for the value, low and high."
              : kind === "graph" && follow === undefined
                ? `${modelLabel(model)} has no link to other records.`
                : null;

  return (
    <form
      aria-label="Add to canvas"
      className="flex w-[var(--size-editor-popover-md)] max-w-full flex-col gap-[var(--space-3)] p-[var(--space-4)]"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready !== null) onAdd(ready);
      }}
    >
      <SegmentedControl
        ariaLabel="What to add"
        className="w-full"
        options={kindOptions}
        size="sm"
        value={kind}
        onChange={setKind}
      />
      {kind === "note" ? null : (
        <FieldFrame label="Records">
          <Select
            options={models.map((item) => ({ value: item.id, label: modelLabel(item) }))}
            size="sm"
            value={modelId}
            onValueChange={setModelId}
          />
        </FieldFrame>
      )}
      {kind === "chart" ? (
        <FieldFrame label="Chart">
          <Select
            options={[...chartKindOptions]}
            size="sm"
            value={chartKind}
            onValueChange={(next) => setChartKind(next as ChartKind)}
          />
        </FieldFrame>
      ) : null}
      {kind === "chart" && groupChoices.length > 0 ? (
        <FieldFrame label={chartKind === "stacked_timeline" ? "Over" : "Group by"}>
          <Select
            options={groupChoices.map(option)}
            size="sm"
            value={group?.id ?? ""}
            onValueChange={setGroupBy}
          />
        </FieldFrame>
      ) : null}
      {kind === "chart" && withSeries && series !== undefined ? (
        <FieldFrame label={chartKind === "heatmap" ? "Columns" : "Stack by"}>
          <Select
            options={groups.filter((field) => field.id !== group?.id).map(option)}
            size="sm"
            value={series.id}
            onValueChange={setSeriesBy}
          />
        </FieldFrame>
      ) : null}
      {kind === "chart" && chartKind === "range" && numbers.length > 0
        ? (["value", "low", "high", "target"] as const).map((part) => (
            <FieldFrame
              key={part}
              label={
                part === "value"
                  ? "Value"
                  : part === "low"
                    ? "Low"
                    : part === "high"
                      ? "High"
                      : "Target"
              }
            >
              <Select
                options={[
                  ...(part === "target" ? [{ value: "", label: "None" }] : []),
                  ...numbers.map(option),
                ]}
                size="sm"
                value={rangeFields[part]?.id ?? ""}
                onValueChange={(next) => setRange((current) => ({ ...current, [part]: next }))}
              />
            </FieldFrame>
          ))
        : null}
      {(kind === "chart" && chartKind !== "range" && groupChoices.length > 0) || kind === "kpi" ? (
        <FieldFrame label="Measure">
          <Select options={metrics} size="sm" value={measure.value} onValueChange={setMetric} />
        </FieldFrame>
      ) : null}
      {kind === "graph" && relations.length > 0 ? (
        <FieldFrame label="Follow">
          <Select
            options={relations.map(option)}
            size="sm"
            value={follow?.id ?? ""}
            onValueChange={setRelation}
          />
        </FieldFrame>
      ) : null}
      {missing === null ? null : (
        <p className="m-[var(--space-0)] text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
          {missing}
        </p>
      )}
      <div className="flex justify-end gap-[var(--space-2)] pt-[var(--space-1)]">
        <Button intent="ghost" size="sm" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={ready === null} intent="primary" size="sm" type="submit">
          Add{" "}
          {kind === "kpi"
            ? "figures"
            : kindOptions.find((item) => item.value === kind)!.label.toLowerCase()}
        </Button>
      </div>
    </form>
  );
}

/** The Add to canvas button and its picker. */
export function AddUnitButton({
  definition,
  onAdd,
  intent = "secondary",
  labelClassName,
}: {
  definition: DataDefinition;
  onAdd: (unit: NewUnit) => void;
  intent?: "primary" | "secondary";
  /** Classes for the visible label, e.g. hidden in a narrow bar; the button keeps its name. */
  labelClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement | null>(null);
  return (
    <span className="inline-flex" ref={anchor}>
      <Button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Add to canvas"
        intent={intent}
        leading={<Plus aria-hidden className="size-[var(--size-icon-sm)]" />}
        size="sm"
        title="Add to canvas"
        onClick={() => setOpen((current) => !current)}
      >
        <span className={labelClassName}>Add to canvas</span>
      </Button>
      <BodyPortalPopover
        align="start"
        anchorRef={anchor}
        ariaLabel="Add to canvas"
        open={open}
        onClose={() => setOpen(false)}
      >
        <AddUnitForm
          definition={definition}
          onAdd={(unit) => {
            setOpen(false);
            onAdd(unit);
          }}
          onCancel={() => setOpen(false)}
        />
      </BodyPortalPopover>
    </span>
  );
}
