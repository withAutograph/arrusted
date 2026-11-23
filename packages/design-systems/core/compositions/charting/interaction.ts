import type { ChartConfig, ChartRuntimeProps, ChartSegmentClick } from "./types";

export function emitSegment(
  props: Pick<
    ChartRuntimeProps<ChartConfig>,
    "onSegmentClick" | "onSegmentAction" | "segmentAction"
  >,
  segment: ChartSegmentClick,
) {
  props.onSegmentClick?.(segment);
  if (props.segmentAction) props.onSegmentAction?.(props.segmentAction.actionId, segment);
}
