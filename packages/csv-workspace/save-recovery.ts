import type { SchemaRevisionId } from "../contracts/index";
import type { WorkspaceDraft } from "./draft";
import type { CsvWorkspaceRecoveryContext } from "./types";

export type CsvWorkspaceRecoveryStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;

export type PendingSaveAttempt = {
  key: string;
  payload: string;
  sourceFilename: string;
  schemaRevisionId: SchemaRevisionId;
  recoveryContext: CsvWorkspaceRecoveryContext;
};

export function pendingSaveStorageKey(
  recoveryContext: CsvWorkspaceRecoveryContext,
  namespace = "csv-workspace.pending-save.v1",
) {
  return [namespace, recoveryContext.appId, recoveryContext.customerId, recoveryContext.actorId]
    .map((part) => encodeURIComponent(String(part)))
    .join(":");
}

function sameRecoveryContext(
  left: CsvWorkspaceRecoveryContext,
  right: CsvWorkspaceRecoveryContext,
) {
  return (
    left.appId === right.appId &&
    left.customerId === right.customerId &&
    left.actorId === right.actorId
  );
}

export function createPendingSaveAttempt(
  draft: WorkspaceDraft,
  recoveryContext: CsvWorkspaceRecoveryContext,
  schemaRevisionId: SchemaRevisionId,
  sourceFilename: string,
  key: string = crypto.randomUUID(),
): PendingSaveAttempt {
  return { key, payload: JSON.stringify(draft), sourceFilename, schemaRevisionId, recoveryContext };
}

export function pendingSaveDraft(attempt: PendingSaveAttempt): WorkspaceDraft {
  const candidate = JSON.parse(attempt.payload) as unknown;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("Pending Save payload is not an object");
  }
  const draft = candidate as Partial<WorkspaceDraft>;
  if (!Number.isSafeInteger(draft.revision) || !Array.isArray(draft.rows)) {
    throw new Error("Pending Save payload is not a workspace draft");
  }
  return candidate as WorkspaceDraft;
}

export function readPendingSave(
  storage: CsvWorkspaceRecoveryStorage,
  storageKey: string,
  recoveryContext: CsvWorkspaceRecoveryContext,
): PendingSaveAttempt | null {
  // One storage entry per request avoids cross-tab read/modify/write races.
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
    .filter(
      (key): key is string =>
        key !== null && (key === storageKey || key.startsWith(`${storageKey}:`)),
    )
    .sort();
  for (const key of keys) {
    const attempt = readPendingSaveEntry(storage, key, recoveryContext, key === storageKey);
    if (attempt) return attempt;
  }
  return null;
}

function readPendingSaveEntry(
  storage: CsvWorkspaceRecoveryStorage,
  storageKey: string,
  recoveryContext: CsvWorkspaceRecoveryContext,
  legacy: boolean,
): PendingSaveAttempt | null {
  const encoded = storage.getItem(storageKey);
  if (!encoded) return null;
  try {
    const attempt = JSON.parse(encoded) as Partial<PendingSaveAttempt>;
    if (
      typeof attempt.key !== "string" ||
      !/^[a-zA-Z0-9-]{16,128}$/u.test(attempt.key) ||
      (!legacy && !storageKey.endsWith(`:${attempt.key}`)) ||
      typeof attempt.payload !== "string" ||
      typeof attempt.schemaRevisionId !== "string" ||
      !attempt.schemaRevisionId ||
      attempt.schemaRevisionId.length > 100 ||
      typeof attempt.sourceFilename !== "string" ||
      !attempt.sourceFilename.trim() ||
      attempt.sourceFilename.length > 255 ||
      !attempt.recoveryContext ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(attempt.recoveryContext.asOf) ||
      !sameRecoveryContext(attempt.recoveryContext, recoveryContext)
    ) {
      throw new Error("Invalid pending Save receipt");
    }
    const valid = attempt as PendingSaveAttempt;
    pendingSaveDraft(valid);
    return valid;
  } catch {
    storage.removeItem(storageKey);
    return null;
  }
}

export function writePendingSave(
  storage: CsvWorkspaceRecoveryStorage,
  storageKey: string,
  attempt: PendingSaveAttempt,
) {
  storage.setItem(`${storageKey}:${attempt.key}`, JSON.stringify(attempt));
}

export function clearPendingSave(
  storage: CsvWorkspaceRecoveryStorage,
  storageKey: string,
  attempt: PendingSaveAttempt,
) {
  storage.removeItem(`${storageKey}:${attempt.key}`);
  // Earlier local sessions used the context key itself. Keep those receipts
  // in place until confirmed; never migrate them through a shared write slot.
  const legacy = storage.getItem(storageKey);
  if (legacy) {
    let matches = false;
    try {
      matches = JSON.stringify(JSON.parse(legacy)) === JSON.stringify(attempt);
    } catch {
      // An unrelated malformed legacy receipt is not this attempt to clear.
    }
    if (matches) storage.removeItem(storageKey);
  }
}

export function saveOutcomeIsDefinitiveRejection(outcome: unknown) {
  return outcome === "not_applied";
}
