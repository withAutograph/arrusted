import { useMemo } from "react";
import { ChartControls } from "./ChartControls";
import { ChartEmptyState, ChartFrame } from "./ChartFrame";
import { ChartSummary } from "./ChartSummary";
import { createChartValueFormatter } from "./format";
import { emitSegment } from "./interaction";
import type { AgScatterSeriesOptions } from "ag-charts-community";

import { AgChartsHost, type AgCartesianChartOptions } from "./runtime";
import { chartAxis, chartColor, useResolvedChartTheme, type ChartCanvasTheme } from "./theme";
import type { ChartRuntimeProps, RangeMarkerChartConfig, RangeMarkerPoint } from "./types";

type PlottedPoint = RangeMarkerPoint & { row: string };

/**
 * Point series: one per `group` (its legend entry, coloured by its first
 * point), then the hollow previous values of moved points.
 */
function pointSeries(
  points: readonly PlottedPoint[],
  theme: ChartCanvasTheme,
  previousLabel: string,
) {
  const groups = new Map<string, PlottedPoint[]>();
  for (const point of points) {
    const members = groups.get(point.group);
    if (members === undefined) groups.set(point.group, [point]);
    else members.push(point);
  }
  const series: AgScatterSeriesOptions<PlottedPoint>[] = [...groups].map(
    ([group, members], index) => {
      const fill = chartColor(theme, members[0]?.color, index);
      return {
        type: "scatter",
        // By position: a group's name never collides with `points:previous`.
        id: `points:group:${index}`,
        data: members,
        xKey: "value",
        yKey: "row",
        xName: group,
        labelKey: "label",
        title: group,
        size: 8,
        fill,
        stroke: fill,
        fillOpacity: 0.9,
        label: { enabled: false },
      };
    },
  );
  const moved = points.filter((point) => point.previous !== undefined);
  if (moved.length > 0)
    series.push({
      type: "scatter",
      id: "points:previous",
      data: moved,
      xKey: "previous",
      yKey: "row",
      xName: previousLabel,
      title: previousLabel,
      size: 8,
      fill: theme.axisText,
      fillOpacity: 0,
      stroke: theme.axisText,
      strokeWidth: 1.5,
      label: { enabled: false },
    });
  return series;
}

const DEFAULT_HEIGHT = 340;
/**
 * Room for two rows of legend entries. AG Charts otherwise caps a bottom
 * legend at a fifth of the chart's height, which in a short chart is one row,
 * and pages the rest behind arrows.
 */
const LEGEND_MAX_HEIGHT = 56;

export function RangeMarkerChart(props: ChartRuntimeProps<RangeMarkerChartConfig>) {
  const theme = useResolvedChartTheme();
  const height = props.height ?? DEFAULT_HEIGHT;
  const formatValue = props.formatValue ?? createChartValueFormatter(props.valueFormat);
  const rowLabels = useMemo(
    () => new Map(props.data.map((datum) => [datum.id, datum.label])),
    [props.data],
  );
  const points = useMemo<PlottedPoint[]>(
    () =>
      (props.points ?? []).flatMap((point) => {
        const row = rowLabels.get(point.rowId);
        return row === undefined ? [] : [{ ...point, row }];
      }),
    [props.points, rowLabels],
  );
  const previousLabel = props.previousLabel ?? "Previous";
  const options = useMemo<AgCartesianChartOptions | null>(() => {
    if (!theme) return null;
    const rangeFill = theme.palette[props.rangeColor ?? "chart-3"];
    return {
      data: props.data,
      animation: { enabled: false },
      background: { visible: false },
      // Without points the chart is as it was: no legend, no series titles.
      legend:
        points.length > 0
          ? { enabled: props.showLegend ?? true, position: "bottom", maxHeight: LEGEND_MAX_HEIGHT }
          : { enabled: false },
      padding: { top: 8, right: 16, bottom: 8, left: 8 },
      axes: {
        x: { type: "category", position: "left", ...chartAxis(theme) },
        y: {
          type: "number",
          position: "bottom",
          ...chartAxis(theme),
          label: {
            ...chartAxis(theme).label,
            formatter: ({ value }: { value: number }) => formatValue(value),
          },
        },
      },
      series: [
        {
          type: "range-bar",
          direction: "horizontal",
          xKey: "label",
          yLowKey: "low",
          yHighKey: "high",
          yName: props.rangeLabel ?? "Range",
          fill: rangeFill,
          stroke: rangeFill,
          // Quieter under points, so each point reads on top of its range.
          ...(points.length > 0 ? { fillOpacity: 0.28 } : {}),
          cornerRadius: theme.cornerRadius,
        },
        {
          type: "scatter",
          xKey: "marker",
          yKey: "label",
          xName: props.markerLabel ?? "Marker",
          // The legend (shown with points) names the series by its title.
          ...(points.length > 0 ? { title: props.markerLabel ?? "Marker" } : {}),
          size: 9,
          fill: theme.palette["chart-1"],
          stroke: theme.palette["chart-1"],
        },
        ...pointSeries(points, theme, previousLabel),
      ],
      listeners:
        props.onSegmentClick || props.onSegmentAction
          ? {
              seriesNodeClick: ({
                datum,
                seriesId,
              }: {
                datum: RangeMarkerChartConfig["data"][number] | PlottedPoint;
                seriesId?: string;
              }) =>
                emitSegment(
                  props,
                  "rowId" in datum
                    ? {
                        family: "range_marker",
                        datumId: datum.id,
                        seriesId: "points",
                        // A hollow marker is the point's previous value.
                        value:
                          seriesId === "points:previous" && datum.previous !== undefined
                            ? datum.previous
                            : datum.value,
                      }
                    : {
                        family: "range_marker",
                        datumId: datum.id,
                        ...(seriesId?.startsWith("points:") ? { seriesId: "points" } : {}),
                        value: datum.marker,
                      },
                ),
            }
          : undefined,
    } satisfies AgCartesianChartOptions;
  }, [formatValue, points, previousLabel, props, theme]);

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
        <AgChartsHost
          options={options}
          label={props.title ?? "range marker chart"}
          height={height}
        />
      ) : (
        <ChartEmptyState height={height}>Loading chart theme…</ChartEmptyState>
      )}
      <ChartSummary
        caption={props.title ?? "Range marker chart data"}
        columns={[
          "Category",
          `${props.rangeLabel ?? "Range"} low`,
          `${props.rangeLabel ?? "Range"} high`,
          props.markerLabel ?? "Marker",
        ]}
        rows={props.data.map((datum) => ({
          id: datum.id,
          cells: [
            datum.label,
            formatValue(datum.low),
            formatValue(datum.high),
            formatValue(datum.marker),
          ],
          segment: { family: "range_marker", datumId: datum.id, value: datum.marker },
        }))}
        onSegmentClick={
          props.onSegmentClick || props.onSegmentAction
            ? (segment) => emitSegment(props, segment)
            : undefined
        }
        actionLabel={props.segmentAction?.label}
      />
      {points.length > 0 ? (
        <ChartSummary
          caption={`${props.title ?? "Range marker chart"} points`}
          columns={["Point", "Row", "Value", "Group", previousLabel]}
          rows={points.map((point) => ({
            id: point.id,
            cells: [
              point.label ?? point.id,
              point.row,
              formatValue(point.value),
              point.group,
              point.previous === undefined ? "" : formatValue(point.previous),
            ],
            segment: {
              family: "range_marker",
              datumId: point.id,
              seriesId: "points",
              value: point.value,
            },
          }))}
          onSegmentClick={
            props.onSegmentClick || props.onSegmentAction
              ? (segment) => emitSegment(props, segment)
              : undefined
          }
          actionLabel={props.segmentAction?.label}
        />
      ) : null}
    </ChartFrame>
  );
}
