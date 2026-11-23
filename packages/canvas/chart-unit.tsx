import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AggregateUnit, DataField } from "@autograph/generated-app-runtime/data";
import { Button } from "@autograph/components";
import {
  BreakdownChart,
  DonutChart,
  HeatmapChart,
  RangeMarkerChart,
  StackedTimelineChart,
  type ChartConfig,
  type ChartSegmentClick,
} from "@autograph/compositions";
import { createLabelIndex, modelLabel } from "@autograph/work-session-tools/labels";

import { failureMessage, type CanvasClient, type CanvasRecord } from "./client";
import {
  rangeConfig,
  rangePanels,
  rangeSummary,
  chartPanels,
  chartQuery,
  chartTitle,
  datumId,
  headerWhere,
  isRange,
  panelConfig,
  relatedRecordId,
  resolveChartSpec,
  type RangePanel,
  type ChartPanel,
} from "./chart-spec";
import { formatMoney } from "./money";
import { recordTitle, titleField } from "./record-values";
import { useCanvasSelection, type SelectionStore } from "./selection";
import type { UnitSession } from "./use-canvas-session";

export type ChartUnitProps = {
  client: CanvasClient;
  /** The unit's id in the layout. */
  unitId: string;
  /** The unit's config: a chart spec (see `chartSpecSchema`). */
  config: unknown;
  /** The canvas session (`useCanvasSession`); a new revision re-reads. */
  session: UnitSession;
  selection: SelectionStore;
  /** Height of each chart, in pixels. */
  height?: number;
};

type Drawn =
  | { kind: "aggregate"; panels: ChartPanel[] }
  | { kind: "range"; panels: RangePanel[]; skipped: number; omitted: number };
type Read =
  | { status: "loading" }
  | { status: "error"; message: string }
  /** `chart` is the spec's key (`specKey`) the panels were read for. */
  | { status: "ready"; drawn: Drawn; chart: string };

/**
 * A chart config by value, without its header filters: what the chart is.
 * A session reload hands the same config as a new object, and a filter only
 * narrows the same chart, so neither starts it over.
 */
export function specKey(config: unknown): string {
  if (config === null || typeof config !== "object" || Array.isArray(config))
    return JSON.stringify(config ?? null);
  const { filters: _filters, ...spec } = config as Record<string, unknown>;
  return JSON.stringify(spec);
}

/** Records a range chart reads, a page at a time. */
const rangePage = 100;
/** The kernel's largest list offset: a range chart reads no further. */
export const rangeMaxOffset = 10_000;
/** The range chart's smallest drawing height, with a note under it. */
const rangeMinHeight = 160;
/** Related-record name reads a chart keeps in flight at once. */
export const nameReads = 8;
/** How many of a related model's records one name read scans before reading the rest by id. */
export const nameScan = 100;

/** A chart unit's title, by column header, for its frame. */
export function chartUnitTitle(client: CanvasClient, config: unknown): string {
  const resolved = resolveChartSpec(client.definition, config);
  return resolved.ok ? chartTitle(resolved.chart) : "Chart";
}

/** A money unit as its chart's caption: "EUR · annual". */
export const unitCaption = (unit: AggregateUnit) => `${unit.currency} · ${unit.period}`;

/**
 * A chart unit: a declarative spec drawn by the compositions charts — a
 * breakdown, donut, heatmap or stacked timeline from the kernel's aggregate
 * over the session, or a range (range marker) from the records themselves.
 * Money splits by currency and period, one chart each, with the unit on its
 * axis and caption. Clicking a bar or slice selects that group (again clears
 * it); the canvas decides whether the selection filters other units.
 */
export function ChartUnit({
  client,
  unitId,
  config,
  session,
  selection: store,
  height = 240,
}: ChartUnitProps) {
  const { definition } = client;
  // By value: a reload's equal config keeps the chart, its panels and its reads.
  const configKey = JSON.stringify(config ?? null);
  const resolved = useMemo(
    () => resolveChartSpec(definition, JSON.parse(configKey) as unknown),
    [definition, configKey],
  );
  const chartKey = specKey(config);
  const { selection, whereFor, select } = useCanvasSelection(store);
  // The filters on this chart's model, as a stable key: what other units'
  // selections set, and the unit's own header filters.
  const whereKey = JSON.stringify(
    resolved.ok
      ? [...whereFor(unitId, resolved.chart.model.id), ...headerWhere(resolved.chart)]
      : [],
  );
  const [read, setRead] = useState<Read>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const sessionId = session.session?.id ?? null;
  const asOf = session.session?.as_of ?? null;
  const revision = session.revision;
  const generation = session.generation;

  useEffect(() => {
    if (!resolved.ok || sessionId === null || asOf === null) return;
    const { chart } = resolved;
    let live = true;
    // A new revision, reload or filter keeps the last panels while it reads; another chart does not.
    setRead((current) =>
      current.status === "ready" && current.chart === chartKey ? current : { status: "loading" },
    );
    const labels = createLabelIndex(definition);
    const work = { sessionId };
    const where = JSON.parse(whereKey) as ReturnType<typeof whereFor>;
    /**
     * Related records of `field`'s target named by their name column, read
     * over the session: one read by id per referenced record, at most
     * `nameReads` at a time.
     */
    const nameRelated = async (field: DataField | undefined, keys: readonly unknown[]) => {
      const target = typeof field?.target_model === "string" ? field.target_model : null;
      const named = new Map<string, string>();
      const targetModel = target === null ? undefined : labels.modelById(target);
      const title = titleField(targetModel);
      const ids = [...new Set(keys.map(relatedRecordId).filter((id) => id !== null))];
      /** Whether the one read saw every record of the target. */
      let complete = false;
      if (targetModel !== undefined && title !== undefined && ids.length > 1) {
        // One read of the target's names (a lookup table, such as levels);
        // any id it leaves out is read by itself below.
        const rows = await client.data.list(targetModel.id, {
          asOf,
          work,
          select: ["id", title.name],
          limit: nameScan,
        });
        complete = rows.length < nameScan;
        const wanted = new Set(ids);
        for (const row of rows) {
          const id = row.id;
          const name = row[title.name];
          if (
            typeof id === "string" &&
            wanted.has(id) &&
            typeof name === "string" &&
            name.trim() !== ""
          )
            named.set(id, name);
        }
      }
      const unread = ids.filter((id) => !named.has(id));
      if (targetModel !== undefined && title !== undefined && unread.length > 0 && !complete) {
        const ids = unread;
        let next = 0;
        const worker = async () => {
          while (next < ids.length) {
            const id = ids[next++]!;
            const [record] = await client.data.list(targetModel.id, {
              asOf,
              work,
              where: [{ field: "id", op: "eq", value: id }],
              select: ["id", title.name],
              limit: 1,
            });
            const name = record?.[title.name];
            if (typeof name === "string" && name.trim() !== "") named.set(id, name);
          }
        };
        await Promise.all(Array.from({ length: Math.min(nameReads, ids.length) }, worker));
      }
      const fallback = targetModel === undefined ? "Record" : modelLabel(targetModel);
      return { named, fallback };
    };
    /** One namer over the group's and the series' targets (record ids are unique). */
    const namer = async (groupKeys: readonly unknown[], seriesKeys: readonly unknown[] = []) => {
      const group = await nameRelated(chart.group, groupKeys);
      const series =
        "series" in chart && chart.series !== undefined
          ? await nameRelated(chart.series, seriesKeys)
          : { named: new Map<string, string>(), fallback: group.fallback };
      return (id: string) =>
        group.named.get(id) ??
        series.named.get(id) ??
        `Unnamed ${group.named.size === 0 && series.named.size > 0 ? series.fallback : group.fallback}`;
    };
    void (async (): Promise<Drawn> => {
      if (isRange(chart)) {
        const records: CanvasRecord[] = [];
        let capped = false;
        for (let offset = 0; ; offset += rangePage) {
          // The kernel pages no further than this offset: draw what it reads.
          if (offset > rangeMaxOffset) {
            capped = true;
            break;
          }
          const batch = await client.data.list(chart.model.id, {
            asOf,
            work,
            where,
            orderBy: [{ field: "id", direction: "asc" }],
            offset,
            limit: rangePage,
          });
          records.push(...batch);
          if (batch.length < rangePage) break;
        }
        const omitted = capped
          ? Math.max(
              0,
              Number(
                (
                  await client.data.aggregate(chart.model.id, {
                    asOf,
                    work,
                    where,
                    metrics: [{ fn: "count" }],
                  })
                ).total.metrics[0] ?? 0,
              ) - records.length,
            )
          : 0;
        const related = await namer(records.map((record) => record[chart.group.name]));
        return {
          kind: "range",
          omitted,
          ...rangePanels(definition, chart, records, {
            record: (record) => recordTitle(chart.model, record),
            related,
          }),
        };
      }
      const result = await client.data.aggregate(chart.model.id, {
        asOf,
        work,
        where,
        ...chartQuery(chart),
      });
      const related = await namer(
        result.groups.map((group) => group.key[0]),
        result.groups.map((group) => group.key[1]),
      );
      return { kind: "aggregate", panels: chartPanels(definition, chart, result, related) };
    })().then(
      (drawn) => {
        if (live) setRead({ status: "ready", drawn, chart: chartKey });
      },
      (error: unknown) => {
        if (!live) return;
        setRead({
          status: "error",
          message: failureMessage(error, "The chart could not be read."),
        });
      },
    );
    return () => {
      live = false;
    };
  }, [
    client,
    definition,
    resolved,
    chartKey,
    sessionId,
    asOf,
    revision,
    generation,
    whereKey,
    attempt,
  ]);

  if (!resolved.ok)
    return <UnitMessage tone="error">This chart cannot be drawn. {resolved.error}</UnitMessage>;
  const chartSpec = resolved.chart;
  if (read.status === "error")
    return (
      <UnitMessage tone="error">
        <span>This chart could not be read: {read.message}</span>
        <Button intent="secondary" size="xs" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </Button>
      </UnitMessage>
    );
  if (read.status === "loading" || read.chart !== chartKey)
    return <UnitMessage>Loading chart…</UnitMessage>;
  const emptyLabel = `No ${modelLabel(chartSpec.model)} records to chart`;
  const money = (unit: AggregateUnit | null) => ({
    subtitle: unit === null ? undefined : unitCaption(unit),
    formatValue: unit === null ? undefined : (value: number) => formatMoney(value, unit, true),
  });

  if (read.drawn.kind === "range" || isRange(chartSpec)) {
    const drawn = read.drawn.kind === "range" ? read.drawn : { panels: [], skipped: 0, omitted: 0 };
    const noted = drawn.skipped > 0 || drawn.omitted > 0;
    const panels: RangePanel[] =
      drawn.panels.length > 0
        ? drawn.panels
        : [{ unit: null, rows: [], points: [], counts: { below: 0, within: 0, above: 0 } }];
    const rangeChart = chartSpec;
    // A point selects its record (the table shows it); a range selects its group.
    const selectedRecord =
      selection?.kind === "rows" &&
      selection.unit_id === unitId &&
      selection.record_ids.length === 1
        ? selection.record_ids[0]!
        : null;
    const selectedRange =
      selection?.kind === "segment" && selection.unit_id === unitId
        ? datumId(selection.value)
        : null;
    const onRangeClick = (segment: ChartSegmentClick) => {
      if (!isRange(rangeChart)) return;
      if (segment.seriesId === "points") {
        select(
          selectedRecord === segment.datumId
            ? null
            : {
                kind: "rows",
                unit_id: unitId,
                model_id: rangeChart.model.id,
                record_ids: [segment.datumId],
              },
        );
        return;
      }
      const row = drawn.panels
        .flatMap((panel) => panel.rows)
        .find((item) => item.id === segment.datumId);
      if (row === undefined) return;
      select(
        selectedRange === row.id
          ? null
          : {
              kind: "segment",
              unit_id: unitId,
              model_id: rangeChart.model.id,
              field_id: rangeChart.group.id,
              value: JSON.parse(row.id) as unknown,
            },
      );
    };
    const rangeSelected =
      selectedRecord !== null
        ? (drawn.panels
            .flatMap((panel) => panel.points)
            .find((point) => point.id === selectedRecord)?.label ?? null)
        : selectedRange !== null
          ? (drawn.panels.flatMap((panel) => panel.rows).find((row) => row.id === selectedRange)
              ?.label ?? null)
          : null;
    return (
      <div
        className="flex flex-col gap-[var(--space-4)] p-[var(--space-4)]"
        data-chart-unit={unitId}
      >
        {isRange(chartSpec)
          ? panels.map((panel) => (
              <div
                key={datumId(panel.unit)}
                data-chart-panel={panel.unit === null ? "" : unitCaption(panel.unit)}
              >
                <ChartFamily
                  common={{
                    ...money(panel.unit),
                    // The spike's one line above the chart: where everyone sits.
                    subtitle: panel.rows.length > 0 ? rangeSummary(panel) : undefined,
                    emptyLabel,
                    onSegmentClick: onRangeClick,
                  }}
                  // Room for the line saying what is left out.
                  config={rangeConfig(
                    chartSpec,
                    panel,
                    noted ? Math.max(rangeMinHeight, height - 28) : height,
                  )}
                />
              </div>
            ))
          : null}
        {noted ? (
          <p className="m-[var(--space-0)] text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
            {drawn.skipped > 0
              ? `${drawn.skipped} ${drawn.skipped === 1 ? "record is" : "records are"} not shown: no value or range, or a range in another currency or period.`
              : null}
            {drawn.skipped > 0 && drawn.omitted > 0 ? " " : null}
            {drawn.omitted > 0
              ? `${drawn.omitted} more ${drawn.omitted === 1 ? "record is" : "records are"} not shown: the chart reads at most ${(rangeMaxOffset + rangePage).toLocaleString("en-US")}.`
              : null}
          </p>
        ) : null}
        {rangeSelected !== null ? (
          <SelectedLine label={rangeSelected} onClear={() => select(null)} />
        ) : null}
      </div>
    );
  }

  const aggregateChart = chartSpec;
  const drawnPanels = read.drawn.panels;
  if (
    aggregateChart.spec.kind === "donut" &&
    drawnPanels.some((panel) => panel.data.some((datum) => datum.value < 0))
  )
    return (
      <UnitMessage>
        This chart can't be drawn as a donut because some totals are negative.
      </UnitMessage>
    );

  // Only a breakdown's bars and a donut's slices select their group.
  const selects = aggregateChart.spec.kind === "breakdown" || aggregateChart.spec.kind === "donut";
  const selectedId =
    selects && selection?.kind === "segment" && selection.unit_id === unitId
      ? datumId(selection.value)
      : null;
  const selectedLabel =
    selectedId === null
      ? null
      : (drawnPanels.flatMap((panel) => panel.data).find((datum) => datum.id === selectedId)
          ?.label ?? null);
  const panels: ChartPanel[] = drawnPanels.length > 0 ? drawnPanels : [{ unit: null, data: [] }];
  const onSegmentClick = (segment: ChartSegmentClick) => {
    const datum = drawnPanels
      .flatMap((panel) => panel.data)
      .find((item) => item.id === segment.datumId);
    if (datum === undefined) return;
    select(
      selectedId === datum.id
        ? null
        : {
            kind: "segment",
            unit_id: unitId,
            model_id: aggregateChart.model.id,
            field_id: aggregateChart.group.id,
            value: datum.key,
          },
    );
  };

  return (
    <div className="flex flex-col gap-[var(--space-4)] p-[var(--space-4)]" data-chart-unit={unitId}>
      {panels.map((panel) => (
        <div
          key={datumId(panel.unit)}
          data-chart-panel={panel.unit === null ? "" : unitCaption(panel.unit)}
        >
          <ChartFamily
            common={{
              ...money(panel.unit),
              emptyLabel,
              onSegmentClick: selects ? onSegmentClick : undefined,
            }}
            config={panelConfig(aggregateChart, panel, { height, selectedId })}
          />
        </div>
      ))}
      {selectedLabel !== null ? (
        <SelectedLine label={selectedLabel} onClear={() => select(null)} />
      ) : null}
    </div>
  );
}

/** What this chart selected, with a way to clear it. */
function SelectedLine({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <div className="flex items-center gap-[var(--space-2)] text-[length:var(--text-caption)] text-[var(--color-text-secondary)]">
      <span>
        Selected:{" "}
        <span className="font-[var(--font-weight-medium)] text-[var(--color-text-primary)]">
          {label}
        </span>
      </span>
      <Button intent="ghost" size="xs" onClick={onClear}>
        Clear
      </Button>
    </div>
  );
}

/** One validated chart config, drawn by its compositions chart family. */
function ChartFamily({
  config,
  common,
}: {
  config: ChartConfig;
  common: {
    subtitle?: string;
    emptyLabel: string;
    formatValue?: (value: number) => string;
    onSegmentClick?: (segment: ChartSegmentClick) => void;
  };
}) {
  switch (config.family) {
    case "donut":
      return <DonutChart {...config} {...common} />;
    case "breakdown":
      return <BreakdownChart {...config} {...common} />;
    case "heatmap":
      return <HeatmapChart {...config} {...common} />;
    case "stacked_timeline":
      return <StackedTimelineChart {...config} {...common} />;
    case "range_marker":
      return <RangeMarkerChart {...config} {...common} />;
    default:
      return null;
  }
}

function UnitMessage({ tone, children }: { tone?: "error"; children: ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      className="flex h-full flex-col items-center justify-center gap-[var(--space-3)] p-[var(--space-6)] text-center text-[length:var(--text-body)] text-[var(--color-text-muted)]"
    >
      {children}
    </div>
  );
}
