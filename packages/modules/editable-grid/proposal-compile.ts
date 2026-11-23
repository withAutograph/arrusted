import type {
  ChangeTypeId,
  Field,
  FieldId,
  FieldValue,
  ModelId,
  RecordKey,
  VisibleRecord,
} from "../../contracts/index";

export type EditableGridProposalEnvelope = {
  id: string;
  grounding: unknown;
  writes: EditableGridProposalWrite[];
};

export type EditableGridProposalWrite = {
  model: ModelId;
  record_key: RecordKey;
  field: FieldId;
  // `null` clears the stored value (optional fields only).
  value: FieldValue | null;
  effective_date: string;
  change_type_id?: ChangeTypeId | null;
};

export type CompiledPendingWrite = {
  rowKey: string;
  modelId: ModelId;
  effectiveStart: string;
  // `null` is a pending clear, as in the edit buffer.
  values: Record<FieldId, FieldValue | null>;
  sourceKind: string;
  sourceRef: string | null;
  changeTypeId?: ChangeTypeId;
  sourceWriteIndices: number[];
  sourceWriteIndicesByField: Record<FieldId, number[]>;
};

export type ProposalCompileDiagnostic = {
  path: string;
  code:
    | "wrong_model"
    | "malformed_proposal"
    | "record_not_found"
    | "ambiguous_record_key"
    | "mixed_effective_date"
    | "mixed_change_type"
    | "unsupported_model_scope"
    // The proposal targets a model with no records mounted at the seam —
    // distinct from record_not_found so the caller can name the real problem
    // (the model key) instead of implying the record ids are wrong.
    | "model_not_mounted"
    // The field is not on the model, or a clear targets a required field.
    | "unknown_field"
    | "field_not_clearable";
  message: string;
};

export type ProposalCompileResult = {
  writes: CompiledPendingWrite[];
  diagnostics: ProposalCompileDiagnostic[];
};

export function compileProposalToPendingWrites(
  envelope: EditableGridProposalEnvelope,
  opts: {
    modelId: ModelId;
    records: readonly VisibleRecord[];
    // The model's writable fields, declared and custom. Writes to other
    // fields and clears of required fields are rejected up front.
    fields: readonly Field[];
    sourceKind?: string;
    sourceRef?: string | null;
  },
): ProposalCompileResult {
  const diagnostics: ProposalCompileDiagnostic[] = [];
  const byRow = new Map<string, CompiledPendingWrite>();
  const sourceKind = opts.sourceKind ?? "agent";
  const sourceRef = opts.sourceRef ?? null;

  envelope.writes.forEach((write, index) => {
    const path = `writes.${index}`;
    if (write.model !== opts.modelId) {
      diagnostics.push({
        path: `${path}.model`,
        code: "wrong_model",
        message: `Proposal write targets model ${write.model}; mounted grid model is ${opts.modelId}.`,
      });
      return;
    }

    const field = opts.fields.find((candidate) => candidate.id === write.field);
    if (!field) {
      diagnostics.push({
        path: `${path}.field`,
        code: "unknown_field",
        message: `Field ${write.field} is not a field of ${opts.modelId}. Valid field ids: ${opts.fields
          .map((candidate) => candidate.id)
          .sort()
          .join(", ")}.`,
      });
      return;
    }
    if (write.value === null && field.required) {
      diagnostics.push({
        path: `${path}.value`,
        code: "field_not_clearable",
        message: `${field.label} is required and can't be cleared.`,
      });
      return;
    }

    const matches = resolveRecordKey(write.record_key, opts.records);
    if (matches.length === 0) {
      diagnostics.push({
        path: `${path}.record_key`,
        code: "record_not_found",
        message: `Proposal record_key ${recordKeyLabel(write.record_key)} did not match a mounted record.`,
      });
      return;
    }
    if (matches.length > 1) {
      diagnostics.push({
        path: `${path}.record_key`,
        code: "ambiguous_record_key",
        message: `Proposal record_key ${recordKeyLabel(write.record_key)} matched ${matches.length} mounted records.`,
      });
      return;
    }

    const rowKey = matches[0]!.record_id;
    let pending = byRow.get(rowKey);
    if (!pending) {
      pending = {
        rowKey,
        modelId: opts.modelId,
        effectiveStart: write.effective_date,
        values: {},
        sourceKind,
        sourceRef,
        ...(write.change_type_id ? { changeTypeId: write.change_type_id } : {}),
        sourceWriteIndices: [],
        sourceWriteIndicesByField: {},
      };
      byRow.set(rowKey, pending);
    } else {
      if (pending.effectiveStart !== write.effective_date) {
        diagnostics.push({
          path: `${path}.effective_date`,
          code: "mixed_effective_date",
          message: `Record ${rowKey} already has pending effective_date ${pending.effectiveStart}; received ${write.effective_date}.`,
        });
        return;
      }
      const incomingChangeType = write.change_type_id ?? undefined;
      if (
        pending.changeTypeId !== undefined &&
        incomingChangeType !== undefined &&
        pending.changeTypeId !== incomingChangeType
      ) {
        diagnostics.push({
          path: `${path}.change_type_id`,
          code: "mixed_change_type",
          message: `Record ${rowKey} already has pending change_type_id ${pending.changeTypeId}; received ${incomingChangeType}.`,
        });
        return;
      }
      if (pending.changeTypeId === undefined && incomingChangeType !== undefined) {
        pending.changeTypeId = incomingChangeType;
      }
    }

    pending.values[write.field] = write.value;
    pending.sourceWriteIndices.push(index);
    (pending.sourceWriteIndicesByField[write.field] ??= []).push(index);
  });

  return {
    writes: Array.from(byRow.values()),
    diagnostics,
  };
}

function resolveRecordKey(key: RecordKey, records: readonly VisibleRecord[]): VisibleRecord[] {
  switch (key.type) {
    case "record_id":
      return records.filter((record) => record.record_id === key.value);
    case "external_key":
      return records.filter((record) => record.external_key === key.value);
  }
  return [];
}

function recordKeyLabel(key: RecordKey): string {
  return `${key.type}:${key.value}`;
}
