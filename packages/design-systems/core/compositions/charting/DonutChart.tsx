import { useMemo } from "react";
import { ChartControls } from "./ChartControls";
import { ChartEmptyState, ChartFrame, ChartLegend } from "./ChartFrame";
import { ChartSummary } from "./ChartSummary";
import { createChartValueFormatter } from "./format";
import { emitSegment } from "./interaction";
import { AgChartsHost, type AgChartOptions } from "./runtime";
import { chartColor, useResolvedChartTheme } from "./theme";
import type { ChartRuntimeProps, DonutChartConfig } from "./types";

const DEFAULT_HEIGHT = 320;

export function DonutChart(props: ChartRuntimeProps<DonutChartConfig>) {
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
  const hasValue = data.some((datum) => datum.value > 0);
  const options = useMemo<AgChartOptions | null>(() => {
    if (!theme) return null;
    return {
      data,
      animation: { enabled: false },
      background: { visible: false },
      legend: { enabled: false },
      padding: { top: 8, right: 8, bottom: 8, left: 8 },
      series: [
        {
          type: "donut",
          angleKey: "value",
          calloutLabelKey: "label",
          sectorLabelKey: "value",
          angleName: props.valueLabel ?? "Value",
          innerRadiusRatio: props.innerRadiusRatio ?? 0.62,
          cornerRadius: theme.cornerRadius,
          itemStyler: ({ datum }: { datum: { fill: string } }) => ({ fill: datum.fill }),
          sectorLabel: {
            color: theme.axisText,
            fontFamily: theme.fontFamily,
            fontSize: theme.fontSize,
            formatter: ({ datum }: { datum: { value: number } }) => formatValue(datum.value),
          },
          calloutLabel: {
            color: theme.axisText,
            fontFamily: theme.fontFamily,
            fontSize: theme.fontSize,
          },
        },
      ],
      listeners:
        props.onSegmentClick || props.onSegmentAction
          ? {
              seriesNodeClick: ({ datum }: { datum: (typeof data)[number] }) =>
                emitSegment(props, { family: "donut", datumId: datum.id, value: datum.value }),
            }
          : undefined,
    } as AgChartOptions;
  }, [data, formatValue, props, theme]);

  return (
    <ChartFrame
      title={props.title}
      subtitle={props.subtitle}
      frame={props.frame}
      className={props.className}
      controls={<ChartControls controls={props.controls} onChange={props.onControlChange} />}
    >
      {!hasValue ? (
        <ChartEmptyState height={height}>
          {props.emptyState ?? props.emptyLabel ?? "No data available"}
        </ChartEmptyState>
      ) : options ? (
        <AgChartsHost options={options} label={props.title ?? "donut chart"} height={height} />
      ) : (
        <ChartEmptyState height={height}>Loading chart theme…</ChartEmptyState>
      )}
      {props.showLegend !== false && data.length > 0 ? (
        <ChartLegend
          items={data.map((datum) => ({ id: datum.id, label: datum.label, color: datum.fill }))}
        />
      ) : null}
      <ChartSummary
        caption={props.title ?? "Donut chart data"}
        columns={["Category", props.valueLabel ?? "Value"]}
        rows={props.data.map((datum) => ({
          id: datum.id,
          cells: [datum.label, formatValue(datum.value)],
          segment: { family: "donut", datumId: datum.id, value: datum.value },
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
