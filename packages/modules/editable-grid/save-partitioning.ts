import {
  splitPendingValues,
  type EditEntry,
  type PendingFieldValue,
} from "../../engines/edit-buffer/index";
import type {
  ChangeTypeId,
  FieldId,
  FieldValue,
  ModelId,
  RecordKey,
  RecordId,
  RowVersionWrite,
} from "@contracts";

// Buffer slice for one ApplyChangeSet, preserving input order. bulkGroupId is
// present only when every row in the partition shares the same group.
export type SaveChangeSetPartition = {
  sourceKind: string;
  sourceRef: string | null;
  changeTypeId: ChangeTypeId;
  entries: EditEntry[];
  bulkGroupId?: string;
};

function recordKeysEqual(left: RecordKey | undefined, right: RecordKey | undefined): boolean {
  return left === right || (left?.type === right?.type && left?.value === right?.value);
}

// Partition entries by row-resolved source/change_type while preserving
// first-seen order. Change type mirrors the pendingChangesByRow digest rule:
// explicit row override, then app inference, then default. Callers may supply
// one authoritative persisted source for reviewed workflows without mutating
// the buffer's last-touched source shown in pending-state chrome.
export function partitionEntriesForSave(
  entries: ReadonlyArray<EditEntry>,
  opts: {
    inferChangeType?: (touchedFieldIds: FieldId[]) => ChangeTypeId;
    defaultChangeType: ChangeTypeId;
    defaultSourceKind: string;
    defaultSourceRef: string | null;
    saveSource?: {
      sourceKind: string;
      sourceRef: string;
    };
  },
): SaveChangeSetPartition[] {
  // First pass: group by rowKey and capture row-level overrides/touches.
  // firstSeenIndex preserves the user's staging order for serial save().
  type RowBucket = {
    entries: EditEntry[];
    explicitChangeType?: ChangeTypeId;
    sourceKind: string;
    sourceRef: string | null;
    touchedFieldIds: FieldId[];
    firstSeenIndex: number;
  };
  const byRow = new Map<string, RowBucket>();
  let nextIndex = 0;
  for (const entry of entries) {
    const rowKey = entry.addr.rowKey;
    const changeTypeId = entry.meta?.changeTypeId;
    let bucket = byRow.get(rowKey);
    if (!bucket) {
      bucket = {
        entries: [],
        explicitChangeType: changeTypeId,
        sourceKind: opts.saveSource?.sourceKind ?? entry.meta?.sourceKind ?? opts.defaultSourceKind,
        sourceRef: opts.saveSource
          ? opts.saveSource.sourceRef
          : entry.meta && "sourceRef" in entry.meta
            ? (entry.meta.sourceRef ?? null)
            : opts.defaultSourceRef,
        touchedFieldIds: [],
        firstSeenIndex: nextIndex++,
      };
      byRow.set(rowKey, bucket);
    } else if (!bucket.explicitChangeType && changeTypeId) {
      bucket.explicitChangeType = changeTypeId;
    }
    bucket.entries.push(entry);
    bucket.touchedFieldIds.push(entry.addr.fieldId);
  }

  // Second pass: resolve each row's change_type and bucket by partition.
  type PartitionBucket = {
    sourceKind: string;
    sourceRef: string | null;
    changeTypeId: ChangeTypeId;
    entries: EditEntry[];
    firstSeenIndex: number;
  };
  const byPartition = new Map<string, PartitionBucket>();
  // Iterate rows in first-seen order so partition order is deterministic.
  const rowsInOrder = Array.from(byRow.entries()).sort(
    ([, a], [, b]) => a.firstSeenIndex - b.firstSeenIndex,
  );
  for (const [rowKey, bucket] of rowsInOrder) {
    const resolved =
      bucket.explicitChangeType ??
      (opts.inferChangeType
        ? opts.inferChangeType(bucket.touchedFieldIds)
        : opts.defaultChangeType);
    // Dev-loud guardrail: unresolved change_type must fail before submit.
    if (!resolved) {
      throw new Error(
        `[editable-grid] Cannot resolve change_type for row "${rowKey}" ` +
          `(touched fields: ${bucket.touchedFieldIds.join(", ") || "<none>"}). ` +
          `Provide config.changeTypeId, config.inferChangeType, or per-entry meta.changeTypeId.`,
      );
    }
    const partitionKey = JSON.stringify([bucket.sourceKind, bucket.sourceRef, resolved]);
    let partition = byPartition.get(partitionKey);
    if (!partition) {
      partition = {
        sourceKind: bucket.sourceKind,
        sourceRef: bucket.sourceRef,
        changeTypeId: resolved,
        entries: [],
        firstSeenIndex: bucket.firstSeenIndex,
      };
      byPartition.set(partitionKey, partition);
    }
    for (const e of bucket.entries) partition.entries.push(e);
  }

  return Array.from(byPartition.values())
    .sort((a, b) => a.firstSeenIndex - b.firstSeenIndex)
    .map((p) => {
      // Surface bulkGroupId only for homogeneous bulk partitions; notes is a
      // single label, so mixed groups must not pick a representative.
      let bulkGroupId: string | undefined;
      let mixed = false;
      for (const entry of p.entries) {
        const id = entry.meta?.bulkGroupId;
        if (id == null) {
          mixed = true;
          break;
        }
        if (bulkGroupId == null) {
          bulkGroupId = id;
        } else if (bulkGroupId !== id) {
          mixed = true;
          break;
        }
      }
      const out: SaveChangeSetPartition = {
        sourceKind: p.sourceKind,
        sourceRef: p.sourceRef,
        changeTypeId: p.changeTypeId,
        entries: p.entries,
      };
      if (!mixed && bulkGroupId != null) out.bulkGroupId = bulkGroupId;
      return out;
    });
}

export function entriesToWrites(
  entries: ReadonlyArray<{
    addr: { rowKey: string; fieldId: FieldId };
    value: PendingFieldValue;
    meta?: {
      modelId: ModelId;
      recordKey?: RecordKey;
      newRecordId?: RecordId;
      effectiveStart: string;
    };
  }>,
  defaultModelId: ModelId,
): RowVersionWrite[] {
  // Group by rowKey, not recordKey; new records have no recordKey and would
  // otherwise collapse into one write group. Editable-grid owns the invariant
  // that one pending row has exactly one effective_start.
  const groups = new Map<
    string,
    {
      modelId: ModelId;
      recordKey?: RecordKey;
      newRecordId?: RecordId;
      effectiveStart: string;
      values: Record<FieldId, PendingFieldValue>;
    }
  >();
  for (const entry of entries) {
    const meta = entry.meta;
    const modelId = meta?.modelId ?? defaultModelId;
    // Preserve absent recordKey for new-record writes.
    const recordKey: RecordKey | undefined = meta
      ? meta.recordKey
      : { type: "record_id", value: entry.addr.rowKey };
    const effectiveStart = meta?.effectiveStart ?? "";
    const newRecordId = meta?.newRecordId;
    if (recordKey && newRecordId) {
      throw new Error(`Row "${entry.addr.rowKey}" cannot have both recordKey and newRecordId.`);
    }
    const key = entry.addr.rowKey;
    let group = groups.get(key);
    if (!group) {
      group = { modelId, recordKey, newRecordId, effectiveStart, values: {} };
      groups.set(key, group);
    } else if (
      group.modelId !== modelId ||
      group.effectiveStart !== effectiveStart ||
      !recordKeysEqual(group.recordKey, recordKey) ||
      group.newRecordId !== newRecordId
    ) {
      throw new Error(`Row "${key}" has conflicting subject metadata across staged cells.`);
    }
    group.values[entry.addr.fieldId] = entry.value;
  }
  return Array.from(groups.values()).map((g) => {
    const pending = splitPendingValues(g.values);
    const write: RowVersionWrite = {
      model_id: g.modelId,
      effective_start: g.effectiveStart,
      values: pending.values,
    };
    // Pending clears become `clear_fields`; custom-field ids among them move
    // to `clear_custom_fields` at the save boundary.
    if (pending.clearFields.length > 0) write.clear_fields = pending.clearFields;
    // Omit record_key entirely for creates.
    if (g.recordKey) write.record_key = g.recordKey;
    if (g.newRecordId) write.new_record_id = g.newRecordId;
    return write;
  });
}
