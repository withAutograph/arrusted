// Editable row-version grid module.
//
// Apps call `useEditableRowVersionGrid(...)` to get a controller plus opaque
// `surfaceProps`, render their own page chrome, then pass the props into
// `<EditableRowVersionGrid />`. The hook owns edit-buffer state, apply
// orchestration, and FieldValue <-> AG Grid bridging. The component owns only
// the AG Grid mount and module chrome.
//
// Boundary: this package may depend on kernel contracts and generic engines,
// but app semantics stay in app-owned config (`fieldOverrides`, validators,
// relation options, copy, and change_type inference).
export { useApplyChangeSet, isSingleFlightBlocked } from "./hooks/useApplyChangeSet";
export { extractAppliedChangeSetId } from "./apply-result";
export { useApplyChangeSetBatch } from "./hooks/useApplyChangeSetBatch";
export type { ApplyChangeSetPayload, ApplyState } from "./hooks/useApplyChangeSet";
export type {
  ApplyChangeSetBatchItem,
  ApplyChangeSetBatchResult,
  ApplyChangeSetBatchState,
} from "./hooks/useApplyChangeSetBatch";
export { useEditBuffer } from "./hooks/useEditBuffer";
export { useRecordReads } from "./hooks/useRecordReads";
export { useSelectedRowIds } from "./hooks/useSelectedRowIds";
export type { UseSelectedRowIdsResult } from "./hooks/useSelectedRowIds";
export { bootstrapAgGrid } from "./bootstrap";
export { agGridLeafEditor } from "./cell-editors";
export type { LeafEditorKind, LeafEditorBundle } from "./cell-editors";
export type { BulkGroupLabelLookup, ChangeTypeLabelLookup, ChangeTypeOption } from "./row-meta-row";
export { BulkUpdateTrigger } from "./bulk-update-trigger";
export type { BulkUpdateTriggerProps, BulkUpdatePickerItem } from "./bulk-update-trigger";
export { ChangesOnlyToggle } from "./changes-only-toggle";
export type { ChangesOnlyToggleProps } from "./changes-only-toggle";
export { BulkFilterIndicator } from "./bulk-filter-indicator";
export type { BulkFilterIndicatorProps } from "./bulk-filter-indicator";
export { buildSchemaColumnDef, buildSchemaColumnDefs, findModel } from "./schema-columns";
export { isEditableGridField } from "./field-capabilities";
export type { EditableGridFieldCapability } from "./field-capabilities";
export { compileProposalToPendingWrites } from "./proposal-compile";
export type {
  CompiledPendingWrite,
  EditableGridProposalEnvelope,
  EditableGridProposalWrite,
  ProposalCompileDiagnostic,
  ProposalCompileResult,
} from "./proposal-compile";
export type {
  BuildSchemaColumnsOptions,
  EditorDefaults,
  FieldOverride,
  FieldOverrides,
  RelationOption,
  OnRelationOptionPicked,
  RelationOptionsByModel,
  RelationSearchByModel,
} from "./schema-columns";
export {
  defaultDateFormat,
  defaultDatetimeFormat,
  relationKeyLabeler,
  relationLabelFormatter,
  relationOptionsByKey,
  UNRESOLVED_RELATION_LABEL,
} from "./schema-columns";
export { EditableRowVersionGrid } from "./EditableRowVersionGrid";
export { EDITABLE_GRID_TEMP_ROW_KEY_PREFIX, isEditableGridTempRowKey } from "./temp-row-key";
export {
  useEditableRowVersionGrid,
  useEditableRowVersionGridPreview,
} from "./useEditableRowVersionGrid";
export type {
  CellNote,
  CellMark,
  CellPin,
  HostStagedCell,
  HostStaging,
  EditableGridController,
  EditableGridPreviewController,
  EditableGridMode,
  EditableRowVersionGridSurfaceProps,
  GridColumnContext,
  RowChangeSummary,
  SaveChangeSetResult,
  SaveOutcome,
  PreparedAtomicGridSave,
  StageBulkUpdateResult,
  UseEditableRowVersionGridConfig,
  UseEditableRowVersionGridPreviewConfig,
} from "./types";

export { CurrencyRateEditor } from "./CurrencyRateEditor";
export type { CurrencyRateEditorProps, CurrencyRateSaveInput } from "./CurrencyRateEditor";

// AG Grid types hosts need for the grid surface events they receive.
export type { CellSelectionChangedEvent, GridApi, SelectionChangedEvent } from "ag-grid-community";
