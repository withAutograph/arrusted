import { useMemo } from "react";
import { ChartControls } from "./ChartControls";
import { ChartEmptyState, ChartFrame } from "./ChartFrame";
import { ChartSummary } from "./ChartSummary";
import { createChartValueFormatter } from "./format";
import { emitSegment } from "./interaction";
import { AgChartsHost, type AgCartesianChartOptions } from "./runtime";
import { chartAxis, chartColor, useResolvedChartTheme } from "./theme";
import type { BreakdownChartConfig, ChartRuntimeProps } from "./types";

const DEFAULT_HEIGHT = 300;

export function BreakdownChart(props: ChartRuntimeProps<BreakdownChartConfig>) {
  const theme = useResolvedChartTheme();
  const height = props.height ?? DEFAULT_HEIGHT;
  const formatValue = props.formatValue ?? createChartValueFormatter(props.valueFormat);
  const data = useMemo(
    () =>
      props.data.map((datum, index) => ({
        ...datum,
        fill: theme ? chartColor(theme, datum.color, index) : "",
      })),
    [theme, props.data],
  );
  const horizontal = (props.orientation ?? "horizontal") === "horizontal";
  const options = useMemo<AgCartesianChartOptions | null>(() => {
    if (!theme) return null;
    return {
      data,
      animation: { enabled: false },
      background: { visible: false },
      legend: { enabled: false },
      padding: { top: 8, right: 16, bottom: 8, left: 8 },
      axes: {
        x: { type: "category", position: horizontal ? "left" : "bottom", ...chartAxis(theme) },
        y: {
          type: "number",
          position: horizontal ? "bottom" : "left",
          ...chartAxis(theme),
          label: {
            ...chartAxis(theme).label,
            formatter: ({ value }: { value: number }) => formatValue(value),
          },
        },
      },
      series: [
        {
          type: "bar",
          direction: horizontal ? "horizontal" : "vertical",
          xKey: "label",
          yKey: "value",
          yName: props.valueLabel ?? "Value",
          itemStyler: ({ datum }: { datum: { fill: string } }) => ({ fill: datum.fill }),
          cornerRadius: theme.cornerRadius,
        },
      ],
      listeners:
        props.onSegmentClick || props.onSegmentAction
          ? {
              seriesNodeClick: ({ datum }: { datum: (typeof data)[number] }) =>
                emitSegment(props, {
                  family: "breakdown",
                  datumId: datum.id,
                  value: datum.value,
                }),
            }
          : undefined,
    } satisfies AgCartesianChartOptions;
  }, [data, formatValue, horizontal, props, theme]);

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
        <AgChartsHost options={options} label={props.title ?? "breakdown chart"} height={height} />
      ) : (
        <ChartEmptyState height={height}>Loading chart theme…</ChartEmptyState>
      )}
      <ChartSummary
        caption={props.title ?? "Breakdown chart data"}
        columns={["Category", props.valueLabel ?? "Value"]}
        rows={props.data.map((datum) => ({
          id: datum.id,
          cells: [datum.label, formatValue(datum.value)],
          segment: { family: "breakdown", datumId: datum.id, value: datum.value },
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
