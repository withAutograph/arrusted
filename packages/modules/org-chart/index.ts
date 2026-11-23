// Org Chart module — public surface.
//
// The chart visualises a hierarchical reconciliation surface: a tree of slots
// with optional occupants attached. Apps own the domain mapping.
//
export { OrgChart, type OrgChartProps, type OrgChartSearchText } from "./org-chart";

export {
  NodeCard,
  type NodeCardAccent,
  type NodeCardDetail,
  type NodeCardDetailPair,
  type NodeCardLabel,
  type NodeCardOccupant,
  type NodeCardProps,
  type NodeCardSlot,
  type NodeCardState,
} from "./node-card";

export {
  OrgChartCanvas,
  type ChartInstanceHandle,
  type ChartRenderDerivedState,
  type ChartRenderNode,
  type ChartRenderNodeFn,
  type OrgChartCanvasDecoration,
  type OrgChartCanvasProps,
  type OrgChartInitialView,
  type OrgChartData,
} from "./canvas";

export {
  useOrgChartLayout,
  type OrgChartLayoutBounds,
  type OrgChartLayoutDirection,
  type OrgChartLayoutEdge,
  type OrgChartLayoutNode,
  type OrgChartLayoutNodeData,
  type OrgChartLayoutOptions,
  type OrgChartPositionedLayout,
  type OrgChartLink,
  type OrgChartNode,
} from "./layout";

export {
  RelationGraph,
  capRelationGroup,
  type RelationGraphFrame,
  type RelationGraphGroup,
  type RelationGraphItem,
  type RelationGraphOverflow,
  type RelationGraphProps,
} from "./relation-graph";

export type {
  DynamicFieldValue,
  NodeActivateOptions,
  OrgChartAtom,
  OrgChartNodeActivatePayload,
  OrgChartNodeKind,
} from "./types";
