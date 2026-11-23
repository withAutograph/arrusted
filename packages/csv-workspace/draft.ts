import type { FieldValue, RowVersionWrite } from "../contracts/index";

export type WorkspaceRow = {
  rowId: string;
  modelId: string;
  recordId: string;
  operation: "create" | "update";
  effectiveStart: string;
  values: Record<string, FieldValue>;
  clearFields: string[];
};
export type WorkspaceDraft = { revision: number; rows: WorkspaceRow[] };
export type WorkspaceAmendment = Pick<WorkspaceRow, "rowId" | "values" | "clearFields">;
export type WorkspaceProposal = {
  additions: WorkspaceRow[];
  amendments: WorkspaceAmendment[];
  removeRowIds?: string[];
};
export type WorkspaceIssue = { code: string; message: string; path?: string };
export type WorkspaceValidationPorts = {
  dryRun: (writes: RowVersionWrite[], signal?: AbortSignal) => Promise<readonly WorkspaceIssue[]>;
};

export function validateWorkspaceRunDate(draft: WorkspaceDraft, asOf: string): WorkspaceIssue[] {
  return draft.rows.flatMap((row, index) =>
    row.effectiveStart === asOf
      ? []
      : [
          {
            code: "frozen_date_mismatch",
            path: `rows[${index}].effectiveStart`,
            message: `Row effective date must match the frozen run date ${asOf}.`,
          },
        ],
  );
}

export function buildWorkspaceWrites(draft: WorkspaceDraft): RowVersionWrite[] {
  return draft.rows.map((row) => ({
    model_id: row.modelId,
    ...(row.operation === "create"
      ? { new_record_id: row.recordId }
      : { record_key: { type: "record_id" as const, value: row.recordId } }),
    effective_start: row.effectiveStart,
    values: structuredClone(row.values),
    clear_fields: [...row.clearFields],
  }));
}

/** Shape decoding only. Active-schema/value semantics belong to host dry-run. */
export function parseWorkspaceProposal(value: unknown): WorkspaceProposal {
  const object = asObject(value);
  assertKeys(object, ["additions", "amendments", "removeRowIds"], "proposal");
  if (!Array.isArray(object.additions) || !Array.isArray(object.amendments))
    throw new Error("Expected additions and amendments arrays");
  return {
    additions: object.additions.map((value, index) => {
      const path = `proposal.additions[${index}]`;
      const row = asObject(value);
      assertKeys(
        row,
        ["rowId", "modelId", "recordId", "operation", "effectiveStart", "values", "clearFields"],
        path,
      );
      if (row.operation !== "create" && row.operation !== "update")
        throw new Error("Invalid operation");
      return {
        ...parseAmendment(
          { rowId: row.rowId, values: row.values, clearFields: row.clearFields },
          path,
        ),
        modelId: string(row.modelId),
        recordId: string(row.recordId),
        operation: row.operation,
        effectiveStart: string(row.effectiveStart),
      };
    }),
    amendments: object.amendments.map((value, index) =>
      parseAmendment(value, `proposal.amendments[${index}]`),
    ),
    removeRowIds:
      object.removeRowIds === undefined
        ? []
        : Array.isArray(object.removeRowIds)
          ? object.removeRowIds.map(string)
          : (() => {
              throw new Error("Expected removeRowIds");
            })(),
  };
}
function parseAmendment(value: unknown, path: string): WorkspaceAmendment {
  const row = asObject(value);
  assertKeys(row, ["rowId", "values", "clearFields"], path);
  const values = asObject(row.values);
  for (const [fieldId, field] of Object.entries(values)) {
    const tagged = asObject(field);
    assertKeys(tagged, ["type", "value"], `${path}.values[${diagnosticKey(fieldId)}]`);
    if (typeof tagged.type !== "string" || !("value" in tagged))
      throw new Error("Expected tagged FieldValue");
  }
  if (!Array.isArray(row.clearFields) || !row.clearFields.every((v) => typeof v === "string"))
    throw new Error("Expected clearFields array");
  return {
    rowId: string(row.rowId),
    values: structuredClone(values) as Record<string, FieldValue>,
    clearFields: [...row.clearFields] as string[],
  };
}
// Diagnostics name locations and keys only; source values never enter the verdict.
function diagnosticKey(key: string): string {
  return JSON.stringify(key.length > 80 ? `${key.slice(0, 80)}…` : key);
}
function assertKeys(object: Record<string, unknown>, keys: readonly string[], path: string) {
  const allowed = new Set(keys);
  const unknown = Object.keys(object).filter((key) => !allowed.has(key));
  if (unknown.length)
    throw new Error(
      `Unknown proposal properties at ${path}: ${unknown.slice(0, 8).map(diagnosticKey).join(", ")}${unknown.length > 8 ? ` (+${unknown.length - 8} more)` : ""}. Allowed keys: ${keys.join(", ")}`,
    );
}
function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected object");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected nonempty string");
  return value;
}

export function amendWorkspaceDraft(
  current: WorkspaceDraft,
  proposal: WorkspaceProposal,
): WorkspaceDraft {
  const next = structuredClone(current);
  const removed = new Set(proposal.removeRowIds ?? []);
  for (const rowId of removed)
    if (!next.rows.some((row) => row.rowId === rowId)) throw new Error("Unknown removed row");
  next.rows = next.rows.filter((row) => !removed.has(row.rowId));
  const byId = new Map(next.rows.map((row) => [row.rowId, row]));
  const touched = new Set<string>();
  for (const [index, amendment] of proposal.amendments.entries()) {
    const row = byId.get(amendment.rowId);
    if (!row)
      throw new Error(
        `Unknown amendment rowId ${diagnosticKey(amendment.rowId)} at proposal.amendments[${index}]. Amendments must target rowIds in the original currentDraft and cannot target removed rows. To stage an existing database record absent from currentDraft, use additions with its resolve_identity grant and operation update. Prior attempt additions are not amendment targets; include them again in additions.`,
      );
    if (touched.has(row.rowId))
      throw new Error(
        `Repeated amendment rowId ${diagnosticKey(amendment.rowId)} at proposal.amendments[${index}]. Combine field edits for this row into one amendment.`,
      );
    touched.add(row.rowId);
    for (const field of amendment.clearFields) {
      if (field in amendment.values) throw new Error("Cannot set and clear the same field");
      delete row.values[field];
    }
    row.clearFields = [
      ...new Set([
        ...row.clearFields.filter((field) => !(field in amendment.values)),
        ...amendment.clearFields,
      ]),
    ];
    Object.assign(row.values, structuredClone(amendment.values));
  }
  for (const row of proposal.additions) {
    if (byId.has(row.rowId)) throw new Error("Repeated row ID");
    if (row.clearFields.some((field) => field in row.values))
      throw new Error("Cannot set and clear the same field");
    const copy = structuredClone(row);
    next.rows.push(copy);
    byId.set(copy.rowId, copy);
  }
  const subjects = new Map<string, string>();
  for (const row of next.rows) {
    const key = JSON.stringify([row.modelId, row.recordId]);
    const effectiveStart = subjects.get(key);
    if (effectiveStart === row.effectiveStart) throw new Error("Repeated record/date write");
    if (effectiveStart !== undefined)
      throw new Error("Multiple effective dates for one record are not supported");
    subjects.set(key, row.effectiveStart);
  }
  next.revision += 1;
  return next;
}

export async function validateWorkspaceDraft(
  draft: WorkspaceDraft,
  ports: WorkspaceValidationPorts,
  signal?: AbortSignal,
): Promise<readonly WorkspaceIssue[]> {
  signal?.throwIfAborted();
  const verdict = await ports.dryRun(buildWorkspaceWrites(draft), signal);
  signal?.throwIfAborted();
  return verdict;
}
