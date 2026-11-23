import { useMemo } from "react";
import { ChartControls } from "./ChartControls";
import { ChartEmptyState, ChartFrame, ChartLegend } from "./ChartFrame";
import { ChartSummary } from "./ChartSummary";
import { createChartValueFormatter } from "./format";
import { emitSegment } from "./interaction";
import { AgChartsHost, type AgCartesianChartOptions } from "./runtime";
import { chartAxis, chartColor, useResolvedChartTheme } from "./theme";
import type { ChartRuntimeProps, StackedTimelineChartConfig } from "./types";

const DEFAULT_HEIGHT = 320;

export function StackedTimelineChart(props: ChartRuntimeProps<StackedTimelineChartConfig>) {
  const theme = useResolvedChartTheme();
  const height = props.height ?? DEFAULT_HEIGHT;
  const formatValue = props.formatValue ?? createChartValueFormatter(props.valueFormat);
  const variant = props.variant ?? "bar";
  const series = useMemo(
    () =>
      props.series.map((item, index) => ({
        ...item,
        fill: theme ? chartColor(theme, item.color, index) : "",
      })),
    [theme, props.series],
  );
  const data = useMemo(
    () =>
      props.data.map((datum) => ({
        periodKey: datum.periodKey,
        periodLabel: datum.periodLabel,
        ...Object.fromEntries(
          Object.entries(datum.values).map(([key, value]) => [
            key,
            variant === "area" && value === null ? 0 : value,
          ]),
        ),
      })),
    [props.data, variant],
  );
  const options = useMemo<AgCartesianChartOptions | null>(() => {
    if (!theme) return null;
    return {
      data,
      animation: { enabled: false },
      background: { visible: false },
      legend: { enabled: false },
      padding: { top: 8, right: 16, bottom: 8, left: 8 },
      axes: {
        x: { type: "category", position: "bottom", ...chartAxis(theme) },
        y: {
          type: "number",
          position: "left",
          ...chartAxis(theme),
          label: {
            ...chartAxis(theme).label,
            formatter: ({ value }: { value: number }) => formatValue(value),
          },
        },
      },
      series: series.map((item) => ({
        type: variant,
        xKey: "periodLabel",
        yKey: item.id,
        yName: item.label,
        fill: item.fill,
        stroke: item.fill,
        stacked: variant !== "line",
        cornerRadius: variant === "bar" ? theme.cornerRadius : undefined,
        marker: variant === "line" ? { enabled: true, size: 5 } : undefined,
      })),
      listeners:
        props.onSegmentClick || props.onSegmentAction
          ? {
              seriesNodeClick: ({
                datum,
                yKey,
              }: {
                datum: Record<string, unknown>;
                yKey?: string;
              }) => {
                if (!yKey) return;
                emitSegment(props, {
                  family: "stacked_timeline",
                  datumId: String(datum.periodKey),
                  periodKey: String(datum.periodKey),
                  seriesId: yKey,
                  value: Number(datum[yKey]),
                });
              },
            }
          : undefined,
    } satisfies AgCartesianChartOptions;
  }, [data, formatValue, props, series, theme, variant]);

  return (
    <ChartFrame
      title={props.title}
      subtitle={props.subtitle}
      frame={props.frame}
      className={props.className}
      controls={<ChartControls controls={props.controls} onChange={props.onControlChange} />}
    >
      {data.length === 0 || series.length === 0 ? (
        <ChartEmptyState height={height}>
          {props.emptyState ?? props.emptyLabel ?? "No data available"}
        </ChartEmptyState>
      ) : options ? (
        <AgChartsHost options={options} label={props.title ?? "timeline chart"} height={height} />
      ) : (
        <ChartEmptyState height={height}>Loading chart theme…</ChartEmptyState>
      )}
      {props.showLegend !== false && series.length > 0 ? (
        <ChartLegend
          items={series.map((item) => ({ id: item.id, label: item.label, color: item.fill }))}
        />
      ) : null}
      <ChartSummary
        caption={props.title ?? "Timeline chart data"}
        columns={["Period", ...props.series.map((item) => item.label)]}
        rows={props.data.map((datum) => ({
          id: datum.periodKey,
          cells: [
            datum.periodLabel,
            ...props.series.map((item) => {
              const value = datum.values[item.id];
              return value === null || value === undefined ? "No value" : formatValue(value);
            }),
          ],
        }))}
      />
      {props.onSegmentClick || props.onSegmentAction ? (
        <div className="sr-only" aria-label="Timeline chart actions">
          {props.data.flatMap((datum) =>
            props.series.map((item) => {
              const value = datum.values[item.id];
              if (value === null || value === undefined) return null;
              return (
                <button
                  key={`${datum.periodKey}:${item.id}`}
                  type="button"
                  onClick={() =>
                    emitSegment(props, {
                      family: "stacked_timeline",
                      datumId: datum.periodKey,
                      periodKey: datum.periodKey,
                      seriesId: item.id,
                      value,
                    })
                  }
                >
                  {props.segmentAction?.label ?? "Inspect"} {item.label} for {datum.periodLabel}
                </button>
              );
            }),
          )}
        </div>
      ) : null}
    </ChartFrame>
  );
}
