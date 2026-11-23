import { useMemo } from "react";
import { ChartControls } from "./ChartControls";
import { ChartEmptyState, ChartFrame } from "./ChartFrame";
import { ChartSummary } from "./ChartSummary";
import { createChartValueFormatter } from "./format";
import { emitSegment } from "./interaction";
import { AgChartsHost, type AgChartOptions } from "./runtime";
import { chartAxis, chartColor, useResolvedChartTheme } from "./theme";
import type { ChartRuntimeProps, ScatterChartConfig } from "./types";

const DEFAULT_HEIGHT = 320;

export function ScatterChart(props: ChartRuntimeProps<ScatterChartConfig>) {
  const theme = useResolvedChartTheme();
  const height = props.height ?? DEFAULT_HEIGHT;
  const formatValue = props.formatValue ?? createChartValueFormatter(props.valueFormat);
  const data = useMemo(
    () =>
      props.data.map((datum, index) => ({
        ...datum,
        fill: theme ? chartColor(theme, datum.color, index) : "",
      })),
    [props.data, theme],
  );
  const options = useMemo<AgChartOptions | null>(() => {
    if (!theme) return null;
    return {
      data,
      animation: { enabled: false },
      background: { visible: false },
      legend: { enabled: false },
      padding: { top: 8, right: 16, bottom: 8, left: 8 },
      axes: [
        {
          type: "number",
          position: "bottom",
          title: { text: props.xLabel ?? "X", color: theme.axisText, fontFamily: theme.fontFamily },
          ...chartAxis(theme),
          label: {
            ...chartAxis(theme).label,
            formatter: ({ value }: { value: number }) => formatValue(value),
          },
        },
        {
          type: "number",
          position: "left",
          title: { text: props.yLabel ?? "Y", color: theme.axisText, fontFamily: theme.fontFamily },
          ...chartAxis(theme),
          label: {
            ...chartAxis(theme).label,
            formatter: ({ value }: { value: number }) => formatValue(value),
          },
        },
      ],
      series: [
        {
          type: props.bubble ? "bubble" : "scatter",
          xKey: "x",
          yKey: "y",
          sizeKey: props.bubble ? "size" : undefined,
          xName: props.xLabel ?? "X",
          yName: props.yLabel ?? "Y",
          marker: { size: props.bubble ? undefined : 8 },
          itemStyler: ({ datum }: { datum: { fill: string } }) => ({
            fill: datum.fill,
            stroke: datum.fill,
          }),
        },
      ],
      listeners:
        props.onSegmentClick || props.onSegmentAction
          ? {
              seriesNodeClick: ({ datum }: { datum: (typeof data)[number] }) =>
                emitSegment(props, { family: "scatter", datumId: datum.id, value: datum.y }),
            }
          : undefined,
    } as unknown as AgChartOptions;
  }, [data, formatValue, props, theme]);

  return (
    <ChartFrame
      title={props.title}
      subtitle={props.subtitle}
      frame={props.frame}
      className={props.className}
      controls={<ChartControls controls={props.controls} onChange={props.onControlChange} />}
    >
      {data.length === 0 ? (
        <ChartEmptyState height={height}>
          {props.emptyState ?? props.emptyLabel ?? "No data available"}
        </ChartEmptyState>
      ) : options ? (
        <AgChartsHost options={options} label={props.title ?? "scatter chart"} height={height} />
      ) : (
        <ChartEmptyState height={height}>Loading chart theme…</ChartEmptyState>
      )}
      <ChartSummary
        caption={props.title ?? "Scatter chart data"}
        columns={["Point", props.xLabel ?? "X", props.yLabel ?? "Y"]}
        rows={props.data.map((datum) => ({
          id: datum.id,
          cells: [datum.label ?? datum.id, formatValue(datum.x), formatValue(datum.y)],
          segment: { family: "scatter", datumId: datum.id, value: datum.y },
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
