import type { FieldValue, VisibleRecord } from "../contracts/index";
import {
  createImportIdentityRecordIndex,
  resolveImportIdentity,
  validateImportIdentityPolicies,
  type ImportIdentityPolicy,
  type ImportIdentityPolicyCatalog,
} from "../engines/import-classification/index";
import type { WorkspaceDraft, WorkspaceIssue, WorkspaceRow } from "./draft";

export type WorkspaceIdentityInput = {
  policies: readonly ImportIdentityPolicy[];
  catalog: ImportIdentityPolicyCatalog;
  recordsByModel: ReadonlyMap<string, readonly VisibleRecord[]>;
};

/** Check final identity consistency, not provenance of a human-selected record target. */
export function validateWorkspaceIdentity(
  input: WorkspaceIdentityInput,
  draft: WorkspaceDraft,
): WorkspaceIssue[] {
  const populations = new Map(
    [...input.recordsByModel].map(([model, records]) => [
      model,
      new Map(records.map((record) => [record.record_id, structuredClone(record)])),
    ]),
  );
  const issues: WorkspaceIssue[] = [];
  const issue = (index: number, message: string) =>
    issues.push({ code: "invalid_identity", path: `rows[${index}]`, message });
  for (const [index, row] of draft.rows.entries()) {
    const records = populations.get(row.modelId) ?? new Map<string, VisibleRecord>();
    const persisted = input.recordsByModel
      .get(row.modelId)
      ?.find((record) => record.record_id === row.recordId);
    if (row.operation === "update" && !persisted) {
      issue(index, "Update target is not visible in the current population.");
      continue;
    }
    if (row.operation === "create" && persisted) {
      issue(index, "Create target already exists in the current population.");
      continue;
    }
    const values = structuredClone(
      row.operation === "update" ? { ...persisted!.values, ...row.values } : row.values,
    );
    for (const field of row.clearFields) delete values[field];
    records.set(row.recordId, {
      record_id: row.recordId,
      effective_start: row.effectiveStart,
      values,
      custom_fields: [],
    });
    populations.set(row.modelId, records);
  }
  if (issues.length) return issues;
  const finalRecords = new Map(
    [...populations].map(([model, records]) => [model, [...records.values()]]),
  );
  const indexes = new Map(
    input.policies.map((policy) => [
      policy.modelId,
      createImportIdentityRecordIndex({
        policy,
        existingRecords: finalRecords.get(policy.modelId) ?? [],
      }),
    ]),
  );
  const policiesByModel = new Map(input.policies.map((policy) => [policy.modelId, policy]));
  for (const [index, row] of draft.rows.entries()) {
    const policy = policiesByModel.get(row.modelId);
    if (!policy) {
      issue(index, "No domain identity policy for this model.");
      continue;
    }
    const records = populations.get(row.modelId)!;
    const resolution = resolveImportIdentity({
      policy,
      authoredValues: records.get(row.recordId)!.values,
      existingRecords: finalRecords.get(row.modelId)!,
      existingRecordIndex: indexes.get(row.modelId),
    });
    if (resolution.kind !== "matched" || resolution.record.record_id !== row.recordId)
      issue(
        index,
        "Final identity must resolve uniquely to this record. Restore missing identity fields or resolve conflicting identity edits.",
      );
  }
  return issues;
}

/** Existing populations stay tool-side. The exact domain resolver is the sole matcher. */
export function createWorkspaceIdentity(
  input: WorkspaceIdentityInput,
  draft: WorkspaceDraft,
  allocateId: () => string = () => crypto.randomUUID(),
) {
  const policyIssues = validateImportIdentityPolicies(
    input.catalog,
    input.policies,
    input.policies.map((policy) => policy.modelId),
  );
  if (policyIssues.length) throw new Error(JSON.stringify(policyIssues));
  const authorized = new Map<string, Pick<WorkspaceRow, "modelId" | "recordId" | "operation">>();
  const populations = new Map<string, VisibleRecord[]>();
  for (const [model, records] of input.recordsByModel)
    populations.set(model, structuredClone([...records]));
  for (const row of draft.rows) {
    authorized.set(row.rowId, {
      modelId: row.modelId,
      recordId: row.recordId,
      operation: row.operation,
    });
    const records = populations.get(row.modelId) ?? [];
    const existing = records.find((record) => record.record_id === row.recordId);
    if (existing) {
      Object.assign(existing.values, structuredClone(row.values));
      for (const field of row.clearFields) delete existing.values[field];
    } else
      records.push({
        record_id: row.recordId,
        effective_start: row.effectiveStart,
        values: structuredClone(row.values),
        custom_fields: [],
      });
    populations.set(row.modelId, records);
  }
  const indexes = new Map(
    input.policies.map((policy) => [
      policy.modelId,
      createImportIdentityRecordIndex({
        policy,
        existingRecords: populations.get(policy.modelId) ?? [],
      }),
    ]),
  );
  return {
    resolve(modelId: string, values: Record<string, FieldValue>, effectiveStart: string) {
      const policy = input.policies.find((p) => p.modelId === modelId);
      if (!policy) throw new Error("No domain identity policy for model");
      const records = populations.get(modelId) ?? [];
      const resolution = resolveImportIdentity({
        policy,
        authoredValues: values,
        existingRecords: records,
        existingRecordIndex: indexes.get(modelId),
      });
      if (resolution.kind === "ambiguous" || resolution.kind === "contradictory")
        return {
          kind: resolution.kind,
          count: resolution.records.length,
          recordIds: resolution.records.slice(0, 8).map((r) => r.record_id),
        };
      if (resolution.kind === "derivation_blocked") return { kind: resolution.kind };
      const matched = resolution.kind === "matched" ? resolution.record : undefined;
      const recordId = matched?.record_id ?? allocateId();
      const existingGrant = [...authorized.entries()].find(
        ([, row]) => row.modelId === modelId && row.recordId === recordId,
      );
      const currentValues = matched ? structuredClone(matched.values) : null;
      if (existingGrant)
        return {
          kind: "resolved",
          rowId: existingGrant[0],
          ...existingGrant[1],
          currentValues: existingGrant[1].operation === "create" ? null : currentValues,
        };
      const operation = matched ? ("update" as const) : ("create" as const);
      const rowId = allocateId();
      const grant = { modelId, recordId, operation };
      authorized.set(rowId, grant);
      if (!matched) {
        records.push({
          record_id: recordId,
          effective_start: effectiveStart,
          values: structuredClone(values),
          custom_fields: [],
        });
        populations.set(modelId, records);
        indexes.set(modelId, createImportIdentityRecordIndex({ policy, existingRecords: records }));
      }
      return { kind: "resolved", rowId, ...grant, currentValues };
    },
    // The grant fixes the target; final identity edits are checked on the complete candidate.
    assertAuthorized(row: WorkspaceRow) {
      const location = `rowId ${JSON.stringify(row.rowId.slice(0, 60))}, modelId ${JSON.stringify(row.modelId.slice(0, 60))}`;
      const grant = authorized.get(row.rowId);
      if (
        !grant ||
        grant.modelId !== row.modelId ||
        grant.recordId !== row.recordId ||
        grant.operation !== row.operation
      )
        throw new Error(
          `Row identity must come from exact identity tool (${location}). Use the returned rowId, modelId, recordId and operation unchanged.`,
        );
    },
  };
}
