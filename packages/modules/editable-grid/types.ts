import type { ReactNode } from "react";
import type {
  ColDef,
  GridReadyEvent,
  IRowNode,
  IsFullWidthRowParams,
  RowHeightParams,
  RowSelectionOptions,
  SelectionChangedEvent,
  ValueGetterParams,
  ValueSetterParams,
} from "ag-grid-community";

import type { FieldValidator } from "@engines/field-validation/index";
import type {
  AppId,
  ChangeTypeId,
  CustomerId,
  ErrorEnvelope,
  FieldId,
  FieldValue,
  KernelClient,
  ModelId,
  RecordKey,
  RecordId,
  RowVersionWrite,
  Schema,
  VisibleRecord,
} from "@contracts";

import type { DiffCellParams } from "./diff-cell-renderer";
import type {
  FieldOverrides,
  OnRelationOptionPicked,
  RelationOptionsByModel,
  RelationSearchByModel,
} from "./schema-columns";
import type {
  BulkGroupLabelLookup,
  ChangeTypeLabelLookup,
  ChangeTypeOption,
  MetaRowMarker,
} from "./row-meta-row";

// Presentation/behavior modes for the grid:
// - read: force every column non-editable; controller is no-op.
// - tweak: live controller, read-style theme; apps opt fields into editing.
// - edit: live controller, edit-style theme; app editability is respected.
// Keep tweak vs edit as presentation only. Read is the only mode that changes
// commit behavior.
export type EditableGridMode = "read" | "tweak" | "edit";

// Internal bridge used by schema-column construction. It lets column builders
// wire FieldValue <-> primitive bridging without each app hand-rolling AG Grid
// getters/setters/renderers.
export type GridColumnContext = {
  asOf: string;
  mode: EditableGridMode;
  fieldGetter: (fieldId: FieldId) => (params: ValueGetterParams<VisibleRecord>) => unknown;
  // Wraps a primitive edit into FieldValue, validates against the projected
  // row, and stages into the record-level buffer.
  fieldSetter: (
    fieldId: FieldId,
    fieldType: FieldValue["type"],
    options?: { validate?: FieldValidator },
  ) => (params: ValueSetterParams<VisibleRecord>) => boolean;
  // For editors that emit a complete FieldValue instead of a primitive.
  fieldSetterFromValue: (
    fieldId: FieldId,
    options?: { validate?: FieldValidator },
  ) => (params: ValueSetterParams<VisibleRecord>) => boolean;
  // Returns the live FieldValue envelope for editors that need it.
  fieldValueGetter: (
    fieldId: FieldId,
  ) => (params: ValueGetterParams<VisibleRecord>) => FieldValue | null;
  dirtyCellClassRules: ColDef<VisibleRecord>["cellClassRules"];
  invalidCellClassRules: ColDef<VisibleRecord>["cellClassRules"];
  // Diff renderer: current value, prior micro-text, and hover revert.
  diffCellRenderer: (opts: {
    formatValue: (value: unknown, fieldValue: FieldValue | null | undefined) => string;
  }) => (params: DiffCellParams) => ReactNode;
};

// Per-row summary derived from the edit buffer for row-meta chrome. The
// inferred change type is derived from the row's touched fields rather than
// copied onto each cell entry, so adding/reverting cells cannot leave stale
// per-cell type state behind.
export type RowChangeSummary = {
  // `next: null` is a pending clear (custom fields only).
  fieldChanges: Array<{ fieldId: FieldId; prior: FieldValue | null; next: FieldValue | null }>;
  // Undefined means the UI must ask for a type and save() must fail before
  // building a payload.
  changeType: ChangeTypeId | undefined;
  effectiveDate: string;
  bulkGroupId?: string;
  // Row-level, last-touched provenance (mirrors EditMeta.sourceKind). The edit
  // buffer stores meta at the record (row) level and the last `set` wins, so a
  // human edit onto an agent-staged row stamps `"user"` here while PRESERVING
  // the row's `agent-*` bulkGroupId. Consumers classifying "who last touched
  // this row" (agent vs human) MUST read this, not the bulkGroupId prefix.
  sourceKind?: string;
  // Row-level, last-touched source reference (mirrors EditMeta.sourceRef, e.g.
  // an agent runId). Exposed so a consumer that snapshots a row's pending state
  // (to revert then faithfully RESTORE it) can round-trip provenance, not just
  // values. Same last-`set`-wins record-level semantics as `sourceKind`.
  sourceRef?: string | null;
};

// Per-change_set result inside a SaveOutcome.
// - saved: kernel accepted; entries clear.
// - failed: kernel rejected; entries stay dirty for retry.
// - blocked: apply single-flight gate prevented dispatch; no kernel error.
// - empty: partition collapsed to zero writes before dispatch.
export type SaveChangeSetResult = {
  changeTypeId: ChangeTypeId;
  stageCount: number;
  status: "saved" | "failed" | "blocked" | "empty";
  appliedChangeSetId?: number;
  error?: ErrorEnvelope;
};

// Outcome of one controller.save() invocation. Save partitions buffer rows by
// effective source/source_ref/change_type and submits one ApplyChangeSet per
// partition.
export type SaveOutcome = {
  savedStageCount: number;
  remainingStageCount: number;
  perChangeSet: ReadonlyArray<SaveChangeSetResult>;
};

// Stable no-op outcome reference.
export const EMPTY_SAVE_OUTCOME: SaveOutcome = {
  savedStageCount: 0,
  remainingStageCount: 0,
  perChangeSet: [],
};

// prepareAtomicSave locks every save-capable grid, including clean grids, until
// the coordinator calls acknowledge after confirmed kernel success or cancel
// after any failure. Both release methods are idempotent.
export type PreparedAtomicGridSave = {
  writes: readonly RowVersionWrite[];
  stageCount: number;
  acknowledge: () => void;
  cancel: () => void;
};

// Result of a bulk stage. Rejection is atomic: no cells stage if any target
// fails validation. Failures stay row-aware so bulk chrome can render precise
// per-row/per-field errors.
export type StageBulkUpdateResult =
  | { ok: true }
  | {
      ok: false;
      failures: ReadonlyArray<{
        rowKey: string;
        fieldId: FieldId;
        message: string;
      }>;
    };

// Hook return shape for app chrome.
export type EditableGridController = {
  isDirty: boolean;
  dirtyCount: number;
  // Per-row digest of all pending edits, keyed by server record_id or tmp row key.
  pendingChangesByRow: ReadonlyMap<string, RowChangeSummary>;
  // Rows with seeded or edit-time validation errors. Import preview uses this
  // to keep Save blocked only until the user fixes the highlighted cells.
  invalidRowCount: number;
  invalidCellCount: number;
  activeBulkFilter: string | null;
  setBulkFilter: (id: string | null) => void;
  showChangesOnly: boolean;
  setShowChangesOnly: (on: boolean) => void;
  revertField: (rowKey: string, fieldId: FieldId) => void;
  // Stage one field or a field map across rows under one bulkGroupId. The
  // optional changeTypeId is an explicit user/app override.
  stageBulkUpdate: (
    opts:
      | {
          rows: ReadonlyArray<{ rowKey: string }>;
          fieldId: FieldId;
          value: FieldValue | null;
          bulkGroupId: string;
          effectiveStart?: string;
          changeTypeId?: ChangeTypeId;
          sourceKind?: string;
          sourceRef?: string | null;
          initialInvalidCells?: Readonly<Record<FieldId, string>>;
        }
      | {
          rows: ReadonlyArray<{ rowKey: string }>;
          values: Record<FieldId, FieldValue | null>;
          bulkGroupId: string;
          effectiveStart?: string;
          changeTypeId?: ChangeTypeId;
          sourceKind?: string;
          sourceRef?: string | null;
          initialInvalidCells?: Readonly<Record<FieldId, string>>;
        },
  ) => StageBulkUpdateResult;
  revertRowEdits: (rowKey: string) => void;
  // Update meta.effectiveStart on every buffer entry for this row.
  setRowEffectiveDate: (rowKey: string, effectiveStart: string) => void;
  // Update meta.changeTypeId on every buffer entry for this row.
  setRowChangeType: (rowKey: string, changeTypeId: ChangeTypeId) => void;
  setBulkGroupEffectiveDate: (bulkGroupId: string, effectiveStart: string) => void;
  revertBulkGroup: (bulkGroupId: string) => void;
  // Pending edits hidden by the current mode; pages should surface this so
  // projected values are not mistaken for canonical state.
  pendingEditsHidden: number;
  submitting: boolean;
  // Last kernel error from save(); lastSaveOutcome carries richer breakdown.
  submitError: ErrorEnvelope | null;
  // Saves by effective change_type partition; successful partitions clear,
  // failed partitions stay dirty for retry.
  save: () => Promise<SaveOutcome>;
  prepareAtomicSave: () => PreparedAtomicGridSave | null;
  lastSaveOutcome: SaveOutcome | null;
  // Stage a brand-new record using tmp row keys. Import previews pass the
  // permanent UUID as newRecordId; unrelated generic create flows may omit
  // both subject fields and let the kernel allocate one.
  // Read-mode controllers return { tempRowKey: "" } without staging — callers
  // that key follow-up work off the returned key must treat "" as a no-op.
  stageNewRecord: (
    values: Record<FieldId, FieldValue>,
    options?: {
      effectiveStart?: string;
      changeTypeId?: ChangeTypeId;
      recordKey?: RecordKey;
      newRecordId?: RecordId;
      tempRowKey?: string;
      initialInvalidCells?: Readonly<Record<FieldId, string>>;
    },
  ) => { tempRowKey: string };
  newRowDrafts: VisibleRecord[];
};

export type EditableGridPreviewController = Omit<
  EditableGridController,
  "lastSaveOutcome" | "prepareAtomicSave" | "save" | "submitError" | "submitting"
>;

// A pending cell edit held by the host rather than the grid's own buffer.
// `prior` is the value it replaced (shown as "was …"); `source` marks who
// staged it ("agent" edits carry a marker).
export type HostStagedCell = {
  rowKey: string;
  fieldId: FieldId;
  value: FieldValue | null;
  prior: FieldValue | null;
  source?: "user" | "agent" | "import";
  // The entry has left the host's pending set (reverted, discarded or saved)
  // and the host has not read the value beneath yet: the cell keeps showing
  // the staged value with a spinner instead of its revert button.
  settling?: boolean;
};

// Host-owned staging. When set, the grid keeps no edit buffer of its own:
// `pending` is the host's pending set, rendered as dirty cells (dirty glyph,
// "was …", revert), and every validated cell edit or revert is handed to the
// host instead of being buffered. The host persists it and passes the new
// pending set back. Rows stay the host's baseline (pending values are not
// written into them), and the per-row meta strip is not rendered: effective
// date and change type belong to the host. Use with the preview hook; host
// staging has no grid Save.
export type HostStaging = {
  pending: ReadonlyArray<HostStagedCell>;
  // May return the stage's promise: until it settles (or `pending` shows the
  // value), the grid treats the edit as the cell's value, so an edit back to
  // the shown value is still handed over.
  onStage: (edit: {
    rowKey: string;
    fieldId: FieldId;
    value: FieldValue | null;
  }) => void | Promise<unknown>;
  onRevert: (cell: { rowKey: string; fieldId: FieldId }) => void;
};

// A quiet line under a cell's value (e.g. "in draft #4", or why an edit was
// not accepted). A staged (dirty) cell shows it beneath its "was …" line, so a
// rejected re-edit of an already-staged cell still says why. `danger` notes
// are announced as alerts.
// A note may carry one action (e.g. "Restore yours"), rendered as a small
// link-style button after the text; a click never starts an edit.
export type CellNote = {
  text: string;
  tone?: "muted" | "danger";
  action?: { label: string; ariaLabel?: string; onSelect: () => void };
};

// A small clickable marker at a cell's right edge, e.g. a comment count. The
// host renders what it opens; a click on the pin never starts an edit.
export type CellPin = {
  label: ReactNode;
  ariaLabel: string;
  count: number;
  tone?: "blue" | "green" | "amber" | "red" | "gray";
  onOpen: () => void;
};

// A small, quiet marker at a cell's right edge that only explains itself on
// hover, e.g. "draft" on a value that comes from a pending draft. Unlike a
// pin it is not a control: a click on it is a click on the cell.
export type CellMark = {
  label: ReactNode;
  title: string;
  tone?: "blue" | "green" | "amber" | "red" | "gray";
};

export type UseEditableRowVersionGridPreviewConfig = {
  modelId: ModelId;
  asOf: string;
  scope: { appId: AppId; customerId: CustomerId };
  rows: VisibleRecord[];
  // Schema-driven column construction; see schema-columns.ts for overrides.
  schema: Schema | null;
  model: string;
  fieldOverrides?: FieldOverrides;
  fieldOrder?: ReadonlyArray<string>;
  hidden?: ReadonlyArray<string>;
  // Picker options per relation target model. Relation columns without a
  // per-field override use their target model's options, which is how
  // tenant custom relations (whose field ids an app cannot know) get a
  // picker and labels.
  relationOptionsByModel?: RelationOptionsByModel;
  // Search per relation target model, so pickers find records that are not
  // loaded; `relationOptionsByModel` then labels values. Apps add the options
  // picked from search (reported by `onRelationOptionPicked`) to it.
  relationSearchByModel?: RelationSearchByModel;
  onRelationOptionPicked?: OnRelationOptionPicked;
  changeTypeId?: ChangeTypeId;
  sourceKind?: string;
  sourceRef?: string | null;
  mode?: EditableGridMode;
  // Infer per-row change_type from touched fields; falls back to changeTypeId.
  inferChangeType?: (touchedFieldIds: FieldId[]) => ChangeTypeId;
  bulkGroupLabel?: BulkGroupLabelLookup;
  // Resolves a homogeneous bulk partition's notes label. Mixed partitions omit
  // notes rather than choosing a misleading representative.
  bulkGroupNotes?: (bulkGroupId: string) => string | undefined;
  changeTypeLabel?: ChangeTypeLabelLookup;
  onClickBulkLink?: (bulkGroupId: string) => void;
  changeTypeOptions?: ReadonlyArray<ChangeTypeOption>;
  hostStaging?: HostStaging;
  // A note shown under a cell's value, clean or staged; see `CellNote`.
  cellNote?: (rowKey: string, fieldId: FieldId) => CellNote | undefined;
  // A clickable marker on a cell; see `CellPin`.
  cellPin?: (rowKey: string, fieldId: FieldId) => CellPin | undefined;
  // A quiet marker on a cell; see `CellMark`.
  cellMark?: (rowKey: string, fieldId: FieldId) => CellMark | undefined;
  // Rows that take no edit in any column (e.g. a record only a pending draft
  // creates); read per cell, so changing it keeps the columns.
  rowReadOnly?: (rowKey: string) => boolean;
};

export type UseEditableRowVersionGridConfig = UseEditableRowVersionGridPreviewConfig & {
  client: KernelClient;
  // Optional save-boundary projection for workflows whose editable schema is
  // wider than the canonical RowVersionWrite shape. Applied identically to
  // ordinary and coordinated atomic saves before any write is dispatched.
  transformWrites?: (writes: readonly RowVersionWrite[]) => readonly RowVersionWrite[];
  // Save-only persisted attribution for reviewed workflows. Pending rows keep
  // their last-touched source; this source is applied only while partitioning.
  saveSource?: { sourceKind: string; sourceRef: string };
  idempotencyKeyForChangeType?: (changeTypeId: ChangeTypeId, payload: unknown) => string;
  saveMode?: "draft" | "mainline";
  onApplied?: () => void;
  onApplyError?: (err: ErrorEnvelope) => void;
};

// Opaque hook-owned props passed through to EditableRowVersionGrid.
export type EditableRowVersionGridSurfaceProps = {
  rows: Array<VisibleRecord | MetaRowMarker>;
  columnDefs: ColDef<VisibleRecord>[];
  mode: EditableGridMode;
  isFullWidthRow: (params: IsFullWidthRowParams<VisibleRecord | MetaRowMarker>) => boolean;
  fullWidthCellRendererParams: {
    effectiveDateReadOnly?: boolean;
    onDiscardRow: (parentRowKey: string) => void;
    setRowEffectiveDate: (parentRowKey: string, effectiveStart: string) => void;
    setRowChangeType: (parentRowKey: string, changeTypeId: ChangeTypeId) => void;
    onClickBulkLink: (bulkGroupId: string) => void;
    bulkGroupLabel: BulkGroupLabelLookup;
    changeTypeLabel: ChangeTypeLabelLookup;
    changeTypeOptions: ReadonlyArray<ChangeTypeOption>;
    bulkFilterActive: boolean;
  };
  externalFilterPresent: boolean;
  externalFilterPass: (node: IRowNode<VisibleRecord | MetaRowMarker>) => boolean;
  filterVersion: number;
  rowSelection?: RowSelectionOptions<VisibleRecord | MetaRowMarker> | "single" | "multiple";
  onSelectionChanged?: (event: SelectionChangedEvent<VisibleRecord | MetaRowMarker>) => void;
  // A single click on a data cell (not its editor), e.g. to open the row's record from one column.
  onCellClicked?: (cell: { rowKey: string; fieldId: string }) => void;
  getRowHeight: (params: RowHeightParams<VisibleRecord | MetaRowMarker>) => number | undefined;
  onGridReady: (event: GridReadyEvent<VisibleRecord | MetaRowMarker>) => void;
};
