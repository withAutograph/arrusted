import { useMemo } from "react";
import { ChartControls } from "./ChartControls";
import { ChartEmptyState, ChartFrame } from "./ChartFrame";
import { ChartSummary } from "./ChartSummary";
import { createChartValueFormatter } from "./format";
import { emitSegment } from "./interaction";
import { AgChartsHost, agChartsEnterpriseEnabled, type AgCartesianChartOptions } from "./runtime";
import { chartAxis, useResolvedChartTheme } from "./theme";
import type { ChartRuntimeProps, HeatmapChartConfig } from "./types";

const DEFAULT_HEIGHT = 360;

export function HeatmapChart(props: ChartRuntimeProps<HeatmapChartConfig>) {
  const theme = useResolvedChartTheme();
  // This series type needs AG Charts Enterprise; Community shows the data table.
  const enterprise = agChartsEnterpriseEnabled();
  const height = props.height ?? DEFAULT_HEIGHT;
  const formatValue = props.formatValue ?? createChartValueFormatter(props.valueFormat);
  const options = useMemo<AgCartesianChartOptions | null>(() => {
    if (!theme) return null;
    return {
      data: props.data,
      animation: { enabled: false },
      background: { visible: false },
      legend: { enabled: props.showLegend !== false },
      padding: { top: 8, right: 16, bottom: 8, left: 8 },
      axes: {
        x: {
          type: "category",
          position: "bottom",
          title: props.xLabel
            ? { text: props.xLabel, color: theme.axisText, fontFamily: theme.fontFamily }
            : undefined,
          ...chartAxis(theme),
        },
        y: {
          type: "category",
          position: "left",
          title: props.yLabel
            ? { text: props.yLabel, color: theme.axisText, fontFamily: theme.fontFamily }
            : undefined,
          ...chartAxis(theme),
        },
      },
      series: [
        {
          type: "heatmap",
          xKey: "xLabel",
          yKey: "yLabel",
          colorKey: "value",
          colorName: props.valueLabel ?? "Value",
          colorScale: {
            fills: [{ color: theme.palette["chart-3"] }, { color: theme.palette["chart-1"] }],
          },
          label: {
            enabled: true,
            color: theme.axisText,
            fontFamily: theme.fontFamily,
            fontSize: theme.fontSize,
            formatter: ({ datum }: { datum: { value: number } }) => formatValue(datum.value),
          },
        },
      ],
      listeners:
        props.onSegmentClick || props.onSegmentAction
          ? {
              seriesNodeClick: ({ datum }: { datum: HeatmapChartConfig["data"][number] }) =>
                emitSegment(props, { family: "heatmap", datumId: datum.id, value: datum.value }),
            }
          : undefined,
    } satisfies AgCartesianChartOptions;
  }, [formatValue, props, theme]);

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
      ) : !enterprise ? null : options ? (
        <AgChartsHost options={options} label={props.title ?? "heatmap chart"} height={height} />
      ) : (
        <ChartEmptyState height={height}>Loading chart theme…</ChartEmptyState>
      )}
      <ChartSummary
        visible={!enterprise && props.data.length > 0}
        caption={props.title ?? "Heatmap chart data"}
        columns={[props.yLabel ?? "Row", props.xLabel ?? "Column", props.valueLabel ?? "Value"]}
        rows={props.data.map((datum) => ({
          id: datum.id,
          cells: [datum.yLabel, datum.xLabel, formatValue(datum.value)],
          segment: { family: "heatmap", datumId: datum.id, value: datum.value },
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
