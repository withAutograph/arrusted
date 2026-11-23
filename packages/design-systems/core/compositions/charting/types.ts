import type { ReactNode } from "react";

export type ChartPaletteColor = "chart-1" | "chart-2" | "chart-3" | "chart-4";

export type ChartValueFormat =
  | { kind: "number"; maximumFractionDigits?: number }
  | { kind: "currency"; currency: string; maximumFractionDigits?: number }
  | { kind: "percent"; maximumFractionDigits?: number };

export type ChartFrame = "card" | "flat";

export type ChartControlRole =
  | "group_by"
  | "filter"
  | "as_of"
  | "granularity"
  | "measure"
  | "comparison"
  | "custom";

export type ChartChoiceControlSpec = {
  id: string;
  label: string;
  value: string;
  kind?: "choice";
  role?: ChartControlRole;
  display?: "segmented" | "select";
  options: Array<{ value: string; label: string }>;
};

export type ChartDateControlSpec = {
  id: string;
  label: string;
  value: string;
  kind: "date";
  role: "as_of";
  minDate?: string;
  maxDate?: string;
};

export type ChartControlSpec = ChartChoiceControlSpec | ChartDateControlSpec;

export type ChartSegmentActionSpec = {
  actionId: string;
  label: string;
};

export type ChartCommonConfig = {
  frame?: ChartFrame;
  height?: number;
  valueFormat?: ChartValueFormat;
  showLegend?: boolean;
  emptyLabel?: string;
  controls?: ChartControlSpec[];
  segmentAction?: ChartSegmentActionSpec;
};

export type BreakdownDatum = {
  id: string;
  label: string;
  value: number;
  color?: ChartPaletteColor;
};

export type BreakdownChartConfig = ChartCommonConfig & {
  family: "breakdown";
  data: BreakdownDatum[];
  orientation?: "horizontal" | "vertical";
  valueLabel?: string;
};

export type TimelineSeries = {
  id: string;
  label: string;
  color?: ChartPaletteColor;
};

export type TimelineDatum = {
  periodKey: string;
  periodLabel: string;
  values: Record<string, number | null>;
};

export type StackedTimelineChartConfig = ChartCommonConfig & {
  family: "stacked_timeline";
  variant?: "bar" | "area" | "line";
  series: TimelineSeries[];
  data: TimelineDatum[];
  valueLabel?: string;
};

export type WaterfallDatum = {
  id: string;
  label: string;
  value: number;
  kind: "start" | "change" | "end";
};

export type WaterfallChartConfig = ChartCommonConfig & {
  family: "waterfall";
  data: WaterfallDatum[];
  valueLabel?: string;
};

export type ScatterDatum = {
  id: string;
  label?: string;
  x: number;
  y: number;
  size?: number;
  group?: string;
  color?: ChartPaletteColor;
};

export type ScatterChartConfig = ChartCommonConfig & {
  family: "scatter";
  data: ScatterDatum[];
  xLabel?: string;
  yLabel?: string;
  bubble?: boolean;
};

export type RangeMarkerDatum = {
  id: string;
  label: string;
  low: number;
  high: number;
  marker: number;
};

/**
 * One of many values plotted on a range row, e.g. each member of a group
 * against the group's range. Points of the same `group` share a legend entry
 * and colour; `previous` draws where a moved point was, hollow.
 */
export type RangeMarkerPoint = {
  id: string;
  /** The `id` of the range row the point sits on. */
  rowId: string;
  value: number;
  label?: string;
  group: string;
  color?: ChartPaletteColor;
  previous?: number;
};

export type RangeMarkerChartConfig = ChartCommonConfig & {
  family: "range_marker";
  data: RangeMarkerDatum[];
  rangeLabel?: string;
  markerLabel?: string;
  /** Range colour; defaults to chart-3. */
  rangeColor?: ChartPaletteColor;
  points?: RangeMarkerPoint[];
  /** Legend name of the hollow previous-value points. Defaults to "Previous". */
  previousLabel?: string;
};

export type DonutDatum = {
  id: string;
  label: string;
  value: number;
  color?: ChartPaletteColor;
};

export type DonutChartConfig = ChartCommonConfig & {
  family: "donut";
  data: DonutDatum[];
  valueLabel?: string;
  innerRadiusRatio?: number;
};

export type CombinedBarLineDatum = {
  id: string;
  label: string;
  barValue: number;
  lineValue: number;
};

export type CombinedBarLineChartConfig = ChartCommonConfig & {
  family: "combined_bar_line";
  data: CombinedBarLineDatum[];
  barLabel: string;
  lineLabel: string;
  barValueFormat?: ChartValueFormat;
  lineValueFormat?: ChartValueFormat;
};

export type HeatmapDatum = {
  id: string;
  xKey: string;
  xLabel: string;
  yKey: string;
  yLabel: string;
  value: number;
};

export type HeatmapChartConfig = ChartCommonConfig & {
  family: "heatmap";
  data: HeatmapDatum[];
  xLabel?: string;
  yLabel?: string;
  valueLabel?: string;
};

export type ChartConfig =
  | BreakdownChartConfig
  | StackedTimelineChartConfig
  | WaterfallChartConfig
  | ScatterChartConfig
  | RangeMarkerChartConfig
  | DonutChartConfig
  | CombinedBarLineChartConfig
  | HeatmapChartConfig;

export type ChartSegmentClick = {
  family: ChartConfig["family"];
  datumId: string;
  seriesId?: string;
  periodKey?: string;
  value: number;
};

export type ChartRuntimeProps<TConfig extends ChartConfig> = TConfig & {
  title?: string;
  subtitle?: string;
  className?: string;
  emptyState?: ReactNode;
  formatValue?: (value: number) => string;
  onSegmentClick?: (segment: ChartSegmentClick) => void;
  onSegmentAction?: (actionId: string, segment: ChartSegmentClick) => void;
  onControlChange?: (controlId: string, value: string) => void;
};
