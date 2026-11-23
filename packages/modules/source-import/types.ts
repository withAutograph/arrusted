import type {
  ChangeTypeId,
  CustomFieldEntry,
  FieldId,
  FieldValue,
  ModelId,
  RecordId,
  RecordKey,
} from "@contracts";

export type SourceArtifact = {
  id: string;
  name: string;
  contentType: string;
  sha256: string;
  sizeBytes: number;
  uploadedAtMs: number;
};

export type PreviewModelTab = {
  modelId: ModelId;
  label: string;
  rowCount: number;
  readyRowCount: number;
  needsReviewRowCount: number;
  parseErrorRowCount: number;
  unchangedRowCount?: number;
};

export type PreviewParseIssue = {
  modelId: ModelId;
  rowIndex: number;
  sourceRowNumber: number;
  path: string;
  code: string;
  message: string;
};

export type PreviewNotice = {
  modelId?: ModelId;
  sourceRowNumbers?: readonly number[];
  code: string;
  message: string;
};

export type PreviewRowIssue = {
  fieldId?: FieldId;
  path: string;
  code: string;
  message: string;
};

export type PreviewExistingRecord = {
  recordId: string;
  effectiveStart: string;
  priorValues: Record<FieldId, FieldValue | null>;
  priorCustomFields?: readonly CustomFieldEntry[];
  values: Record<FieldId, FieldValue>;
  clearFields?: readonly FieldId[];
  customFields?: readonly CustomFieldEntry[];
  changeTypeId?: ChangeTypeId;
  issues?: readonly PreviewRowIssue[];
  sourceRowNumber?: number;
};

export type PreviewNewRecord = {
  tempRowId: string;
  newRecordId?: RecordId;
  recordKey?: RecordKey;
  effectiveStart: string;
  values: Record<FieldId, FieldValue>;
  clearFields?: readonly FieldId[];
  customFields?: readonly CustomFieldEntry[];
  changeTypeId?: ChangeTypeId;
  issues?: readonly PreviewRowIssue[];
  sourceRowNumber?: number;
};

export type PreviewModelRows = {
  existing?: readonly PreviewExistingRecord[];
  creates?: readonly PreviewNewRecord[];
};

export type SaveBlockingReason =
  | "questions_pending"
  | "stage_errors"
  | "needs_review_rows"
  | "parse_errors"
  | "request_too_large"
  | "no_changes"
  | "write_date_pending";

export type WriteBoundImportPreview = {
  changeCount: number;
  modelTabs: readonly PreviewModelTab[];
  saveBlockingReason: SaveBlockingReason | null;
  rowsByModel?: Readonly<Record<ModelId, PreviewModelRows>>;
  parseIssues?: readonly PreviewParseIssue[];
  notices?: readonly PreviewNotice[];
};
