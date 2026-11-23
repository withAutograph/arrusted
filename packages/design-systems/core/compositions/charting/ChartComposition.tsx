import type { CompositionSpec } from "../spec";
import { BreakdownChart } from "./BreakdownChart";
import { CombinedBarLineChart } from "./CombinedBarLineChart";
import { DonutChart } from "./DonutChart";
import { HeatmapChart } from "./HeatmapChart";
import { RangeMarkerChart } from "./RangeMarkerChart";
import { ScatterChart } from "./ScatterChart";
import { StackedTimelineChart } from "./StackedTimelineChart";
import type { ChartConfig, ChartSegmentClick } from "./types";
import { WaterfallChart } from "./WaterfallChart";

export type ChartCompositionProps = {
  spec: CompositionSpec<"chart", ChartConfig>;
  onControlChange?: (controlId: string, value: string) => void;
  onSegmentClick?: (segment: ChartSegmentClick) => void;
  onSegmentAction?: (actionId: string, segment: ChartSegmentClick) => void;
};

export function ChartComposition(props: ChartCompositionProps) {
  const interactions = {
    onControlChange: props.onControlChange,
    onSegmentClick: props.onSegmentClick,
    onSegmentAction: props.onSegmentAction,
  };
  switch (props.spec.config.family) {
    case "breakdown":
      return (
        <BreakdownChart
          {...props.spec.config}
          title={props.spec.title}
          subtitle={props.spec.description}
          {...interactions}
        />
      );
    case "stacked_timeline":
      return (
        <StackedTimelineChart
          {...props.spec.config}
          title={props.spec.title}
          subtitle={props.spec.description}
          {...interactions}
        />
      );
    case "waterfall":
      return (
        <WaterfallChart
          {...props.spec.config}
          title={props.spec.title}
          subtitle={props.spec.description}
          {...interactions}
        />
      );
    case "scatter":
      return (
        <ScatterChart
          {...props.spec.config}
          title={props.spec.title}
          subtitle={props.spec.description}
          {...interactions}
        />
      );
    case "range_marker":
      return (
        <RangeMarkerChart
          {...props.spec.config}
          title={props.spec.title}
          subtitle={props.spec.description}
          {...interactions}
        />
      );
    case "donut":
      return (
        <DonutChart
          {...props.spec.config}
          title={props.spec.title}
          subtitle={props.spec.description}
          {...interactions}
        />
      );
    case "combined_bar_line":
      return (
        <CombinedBarLineChart
          {...props.spec.config}
          title={props.spec.title}
          subtitle={props.spec.description}
          {...interactions}
        />
      );
    case "heatmap":
      return (
        <HeatmapChart
          {...props.spec.config}
          title={props.spec.title}
          subtitle={props.spec.description}
          {...interactions}
        />
      );
  }
}
