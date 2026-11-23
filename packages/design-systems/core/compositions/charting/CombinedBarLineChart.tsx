import { useMemo } from "react";
import { ChartControls } from "./ChartControls";
import { ChartEmptyState, ChartFrame, ChartLegend } from "./ChartFrame";
import { ChartSummary } from "./ChartSummary";
import { createChartValueFormatter } from "./format";
import { emitSegment } from "./interaction";
import { AgChartsHost, type AgCartesianChartOptions } from "./runtime";
import { chartAxis, useResolvedChartTheme } from "./theme";
import type { ChartRuntimeProps, CombinedBarLineChartConfig } from "./types";

const DEFAULT_HEIGHT = 340;

export function CombinedBarLineChart(props: ChartRuntimeProps<CombinedBarLineChartConfig>) {
  const theme = useResolvedChartTheme();
  const height = props.height ?? DEFAULT_HEIGHT;
  const fallbackFormat = props.formatValue ?? createChartValueFormatter(props.valueFormat);
  const formatBar = props.barValueFormat
    ? createChartValueFormatter(props.barValueFormat)
    : fallbackFormat;
  const formatLine = props.lineValueFormat
    ? createChartValueFormatter(props.lineValueFormat)
    : fallbackFormat;
  const options = useMemo<AgCartesianChartOptions | null>(() => {
    if (!theme) return null;
    return {
      data: props.data,
      animation: { enabled: false },
      background: { visible: false },
      legend: { enabled: false },
      padding: { top: 8, right: 16, bottom: 8, left: 16 },
      axes: {
        x: { type: "category", position: "bottom", ...chartAxis(theme) },
        y: {
          type: "number",
          position: "left",
          ...chartAxis(theme),
          label: {
            ...chartAxis(theme).label,
            formatter: ({ value }: { value: number }) => formatBar(value),
          },
        },
        y2: {
          type: "number",
          position: "right",
          ...chartAxis(theme),
          label: {
            ...chartAxis(theme).label,
            formatter: ({ value }: { value: number }) => formatLine(value),
          },
        },
      },
      series: [
        {
          type: "bar",
          xKey: "label",
          yKey: "barValue",
          yName: props.barLabel,
          fill: theme.palette["chart-1"],
          stroke: theme.palette["chart-1"],
          cornerRadius: theme.cornerRadius,
        },
        {
          type: "line",
          xKey: "label",
          yKey: "lineValue",
          yName: props.lineLabel,
          yKeyAxis: "y2",
          stroke: theme.palette["chart-2"],
          marker: {
            enabled: true,
            size: 7,
            fill: theme.palette["chart-2"],
            stroke: theme.palette["chart-2"],
          },
        },
      ],
      listeners:
        props.onSegmentClick || props.onSegmentAction
          ? {
              seriesNodeClick: ({
                datum,
                yKey,
              }: {
                datum: CombinedBarLineChartConfig["data"][number];
                yKey?: string;
              }) => {
                const line = yKey === "lineValue";
                emitSegment(props, {
                  family: "combined_bar_line",
                  datumId: datum.id,
                  seriesId: line ? "line" : "bar",
                  value: line ? datum.lineValue : datum.barValue,
                });
              },
            }
          : undefined,
    } satisfies AgCartesianChartOptions;
  }, [formatBar, formatLine, props, theme]);

  return (
    <ChartFrame
      title={props.title}
      subtitle={props.subtitle}
      frame={props.frame}
      className={props.className}
      controls={<ChartControls controls={props.controls} onChange={props.onControlChange} />}
    >
      {props.data.length === 0 ? (
        <ChartEmptyState height={height}>
          {props.emptyState ?? props.emptyLabel ?? "No data available"}
        </ChartEmptyState>
      ) : options ? (
        <AgChartsHost options={options} label={props.title ?? "combined chart"} height={height} />
      ) : (
        <ChartEmptyState height={height}>Loading chart theme…</ChartEmptyState>
      )}
      {props.showLegend !== false ? (
        <ChartLegend
          items={[
            { id: "bar", label: props.barLabel, color: theme?.palette["chart-1"] ?? "" },
            { id: "line", label: props.lineLabel, color: theme?.palette["chart-2"] ?? "" },
          ]}
        />
      ) : null}
      <ChartSummary
        caption={props.title ?? "Combined bar and line chart data"}
        columns={["Category", props.barLabel, props.lineLabel]}
        rows={props.data.map((datum) => ({
          id: datum.id,
          cells: [datum.label, formatBar(datum.barValue), formatLine(datum.lineValue)],
        }))}
      />
      {props.onSegmentClick || props.onSegmentAction ? (
        <div className="sr-only" aria-label="Combined chart actions">
          {props.data.flatMap((datum) =>
            (
              [
                ["bar", props.barLabel, datum.barValue],
                ["line", props.lineLabel, datum.lineValue],
              ] as const
            ).map(([seriesId, label, value]) => (
              <button
                key={`${datum.id}:${seriesId}`}
                type="button"
                onClick={() =>
                  emitSegment(props, {
                    family: "combined_bar_line",
                    datumId: datum.id,
                    seriesId,
                    value,
                  })
                }
              >
                {props.segmentAction?.label ?? "Inspect"} {label} for {datum.label}
              </button>
            )),
          )}
        </div>
      ) : null}
    </ChartFrame>
  );
}
