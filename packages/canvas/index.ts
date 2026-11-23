// The canvas package: a working-session surface any generated app mounts.
export {
  CanvasKernelError,
  kernelErrorCode,
  type CanvasAggregateInput,
  type CanvasAggregateResult,
  type CanvasClient,
  type CanvasData,
  type CanvasDrafts,
  type CanvasDraftStatus,
  type CanvasDraftThreads,
  type CanvasSessionDraft,
  type CanvasSessionHeader,
  type CanvasSessions,
  type CanvasListener,
  type CanvasListInput,
  type CanvasRecord,
} from "./client";
export {
  createMemoryCanvasClient,
  type MemoryCanvas,
  type MemoryDraft,
  type MemoryRow,
  type MemorySave,
} from "./memory-client";
export {
  parseSaveRequest,
  parseThreads,
  threadSchema,
  type CanvasSaveRequest,
  type CanvasThread,
} from "./threads";
export {
  addUnit,
  chartKinds,
  freeSlot,
  layoutSchema,
  parseLayout,
  unitKinds,
  unitSizes,
  type CanvasLayout,
  type CanvasUnit,
  type UnitKind,
} from "@autograph/work-session-tools/layout";
export {
  createSelectionStore,
  selectionFilter,
  useCanvasSelection,
  type CanvasFilter,
  type CanvasSelection,
  type SelectionStore,
} from "./selection";
export {
  groupByTurn,
  useCanvasSession,
  type CanvasOutcome,
  type CanvasSession,
  type SaveOutcome,
  type StagedGroup,
} from "./use-canvas-session";
export {
  recordsAffected,
  stagedImpact,
  sumDecimals,
  type FieldImpact,
  type ImpactUnit,
} from "./impact";
export type { UnitSession } from "./use-canvas-session";

// The assembled canvas a host mounts.
export { Canvas, unitModelId, type CanvasProps } from "./canvas";
export {
  CanvasPlane,
  fitScale,
  type PlaneFocus,
  minReadableScale,
  planeBounds,
  type CanvasPlaneProps,
  type UnitView,
} from "./canvas-plane";
export { AddUnitButton, AddUnitForm, type NewUnit } from "./add-unit";

// Units and review parts, for hosts that compose their own surface.
export { UnitFrame, type UnitFrameProps } from "./unit-frame";
export { GridUnit, type GridReveal, type GridUnitProps } from "./grid-unit";
export {
  RecordDrawer,
  RecordPanel,
  type RecordDrawerProps,
  type RecordPanelProps,
} from "./record-panel";
export { ChartUnit, chartUnitTitle, type ChartUnitProps } from "./chart-unit";
export { chartSpecSchema, resolveChartSpec, type ChartSpec } from "./chart-spec";
export { KpiUnit, kpiUnitTitle, resolveKpi, type KpiUnitProps } from "./kpi-unit";
export { NoteUnit, noteText, type NoteUnitProps } from "./note-unit";
export { SessionsMenu } from "./sessions-menu";
export {
  GraphUnit,
  graphSpecSchema,
  graphUnitTitle,
  resolveGraphSpec,
  type GraphSpec,
  type GraphUnitProps,
} from "./graph-unit";
export { StagedLog } from "./staged-log";
export { PaneButton, PaneHeader, PaneList, TopBarIconButton } from "./top-bar-pane";
export { ReviewSurface, ReviewSwitch, useReview, type CanvasMode } from "./review-mode";
export { DraftCardThreads, DraftThread, SessionDraftThreads } from "./draft-threads";
export { outsideChanges, useOutsideChanges, type OutsideChange } from "./outside-changes";
export { SaveBar } from "./save-bar";
export { ImpactStrip } from "./impact-strip";
export { Provenance } from "./provenance";
export { RuleCard, ruleTitle, type CanvasRule, type RuleCardProps } from "./rule-card";
export { ThreadPopover, threadPlace, type ThreadPopoverProps } from "./thread-popover";
export {
  CommentModeProvider,
  CommentModeToggle,
  ThreadPin,
  threadCellPin,
  threadsOn,
  useCommentMode,
  type ThreadAnchor,
} from "./comment-mode";
export { moneyDefaults, recordTitle, titleField } from "./record-values";
export {
  NewSessionForm,
  OrganizationChooser,
  type OrganizationOption,
  type StartSessionInput,
  type StartSessionResult,
} from "./session-start";
