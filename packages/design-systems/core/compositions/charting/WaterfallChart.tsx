import { useMemo } from "react";
import { ChartControls } from "./ChartControls";
import { ChartEmptyState, ChartFrame } from "./ChartFrame";
import { ChartSummary } from "./ChartSummary";
import { createChartValueFormatter } from "./format";
import { emitSegment } from "./interaction";
import { AgChartsHost, type AgChartOptions } from "./runtime";
import { chartAxis, useResolvedChartTheme } from "./theme";
import type { ChartRuntimeProps, WaterfallChartConfig } from "./types";

const DEFAULT_HEIGHT = 320;

export function WaterfallChart(props: ChartRuntimeProps<WaterfallChartConfig>) {
  const theme = useResolvedChartTheme();
  const height = props.height ?? DEFAULT_HEIGHT;
  const formatValue = props.formatValue ?? createChartValueFormatter(props.valueFormat);
  const chartState = useMemo(() => {
    let runningTotal = 0;
    const chartData: Array<
      WaterfallChartConfig["data"][number] & { low: number; high: number; connector: number }
    > = [];
    for (const datum of props.data) {
      if (datum.kind === "start" || datum.kind === "end") {
        runningTotal = datum.value;
        chartData.push({
          ...datum,
          low: Math.min(0, datum.value),
          high: Math.max(0, datum.value),
          connector: datum.value,
        });
        continue;
      }
      const nextTotal = runningTotal + datum.value;
      chartData.push({
        ...datum,
        low: Math.min(runningTotal, nextTotal),
        high: Math.max(runningTotal, nextTotal),
        connector: nextTotal,
      });
      runningTotal = nextTotal;
    }
    return chartData;
  }, [props.data]);
  const options = useMemo<AgChartOptions | null>(() => {
    if (!theme) return null;
    return {
      data: chartState,
      animation: { enabled: false },
      background: { visible: false },
      legend: { enabled: false },
      padding: { top: 8, right: 16, bottom: 8, left: 8 },
      axes: [
        { type: "category", position: "bottom", ...chartAxis(theme) },
        {
          type: "number",
          position: "left",
          ...chartAxis(theme),
          label: {
            ...chartAxis(theme).label,
            formatter: ({ value }: { value: number }) => formatValue(value),
          },
        },
      ],
      series: [
        {
          type: "line",
          xKey: "label",
          yKey: "connector",
          stroke: theme.axisText,
          strokeWidth: 1,
          strokeOpacity: 0.4,
          interpolation: { type: "step", position: "end" },
          marker: { enabled: false },
        },
        {
          type: "range-bar",
          direction: "vertical",
          xKey: "label",
          yLowKey: "low",
          yHighKey: "high",
          yName: props.valueLabel ?? "Value",
          fill: theme.palette["chart-2"],
          stroke: theme.palette["chart-2"],
          cornerRadius: theme.cornerRadius,
          itemStyler: ({ datum }: { datum: (typeof chartState)[number] }) => {
            const color =
              datum.kind === "start" || datum.kind === "end"
                ? theme.palette["chart-1"]
                : datum.value < 0
                  ? theme.palette["chart-4"]
                  : theme.palette["chart-2"];
            return { fill: color, stroke: color, cornerRadius: theme.cornerRadius };
          },
        },
      ],
      listeners:
        props.onSegmentClick || props.onSegmentAction
          ? {
              seriesNodeClick: ({ datum }: { datum: WaterfallChartConfig["data"][number] }) =>
                emitSegment(props, {
                  family: "waterfall",
                  datumId: datum.id,
                  value: datum.value,
                }),
            }
          : undefined,
    } as unknown as AgChartOptions;
  }, [chartState, formatValue, props, theme]);

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
        <AgChartsHost options={options} label={props.title ?? "waterfall chart"} height={height} />
      ) : (
        <ChartEmptyState height={height}>Loading chart theme…</ChartEmptyState>
      )}
      <ChartSummary
        caption={props.title ?? "Waterfall chart data"}
        columns={["Step", props.valueLabel ?? "Value"]}
        rows={props.data.map((datum) => ({
          id: datum.id,
          cells: [datum.label, formatValue(datum.value)],
          segment: { family: "waterfall", datumId: datum.id, value: datum.value },
        }))}
        onSegmentClick={
          props.onSegmentClick || props.onSegmentAction
            ? (segment) => emitSegment(props, segment)
            : undefined
        }
        actionLabel={props.segmentAction?.label}
      />
    </ChartFrame>
  );
}
