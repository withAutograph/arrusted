import type {
  AppId,
  AppliedChangeSet,
  ApplyChangeSet,
  CustomerId,
  ActiveSchemaRevision,
  ChangeSetDiff,
  ChangeSetDiffRequest,
  RecentActivityEntry,
  RecentActivityRequest,
  VisibleRecord,
} from "../contracts/index";

export type KernelFailureEnvelope = {
  code: string;
  message: string;
  details?: readonly { code: string; message: string; path?: string }[];
};
/** A canonical negative envelope, distinct from transport failure. */
export class KernelFailure extends Error {
  constructor(public readonly envelope: KernelFailureEnvelope) {
    super(envelope.message);
  }
}
export type QueryPort = {
  query(text: string, values?: unknown[]): Promise<{ rows: { result: unknown }[] }>;
};
export type KernelScope = { app_id: AppId; customer_id: CustomerId };
export type VisibleRecordsRequest = KernelScope & {
  model_id: string;
  as_of: string;
  record_ids?: string[];
};
export type CanonicalDryRunResult = { alreadyApplied: boolean };
/** Generated dry-run receipts use negative synthetic IDs; positive IDs are exact replays.
 * Normalize that canonical protocol here so consumers do not interpret ID conventions.
 */
export function canonicalDryRunResult(receipt: AppliedChangeSet): CanonicalDryRunResult {
  if (!Number.isSafeInteger(receipt?.id) || receipt.id === 0)
    throw new Error("Canonical dry-run receipt is missing or invalid");
  return { alreadyApplied: receipt.id > 0 };
}
export type CanonicalKernelOperations = {
  readVisibleRecords(request: VisibleRecordsRequest): Promise<VisibleRecord[]>;
  validateChangeSetDryRun(request: ApplyChangeSet): Promise<CanonicalDryRunResult>;
  applyChangeSet(request: ApplyChangeSet): Promise<AppliedChangeSet>;
  recentActivity(request: RecentActivityRequest): Promise<RecentActivityEntry[]>;
  changeSetDiff(request: ChangeSetDiffRequest): Promise<ChangeSetDiff>;
};

/** Transport only: generated kernel entrypoints retain validation, isolation, and replay authority. */
export async function kernelCall<T>(
  db: QueryPort,
  operation: string,
  request: unknown,
): Promise<T> {
  if (!/^kernel_[a-z_]+$/.test(operation)) throw new Error("Invalid generated entrypoint");
  const result = await db.query(
    `with response as materialized (select ${operation}($1::jsonb) as value)
    select case when value #> '{data,schema_revision_id}' is not null
      then jsonb_set(value, '{data,schema_revision_id}', to_jsonb(value #>> '{data,schema_revision_id}'))
      else value end as result from response`,
    [JSON.stringify(request)],
  );
  const envelope = result.rows[0]?.result as { ok: boolean; error: KernelFailureEnvelope; data: T };
  if (!envelope || typeof envelope.ok !== "boolean") throw new Error("Invalid kernel response");
  if (!envelope.ok) throw new KernelFailure(envelope.error);
  return envelope.data;
}

export function createPostgresKernelClient(db: QueryPort): CanonicalKernelOperations & {
  readActiveSchemaRevision(scope: KernelScope): Promise<ActiveSchemaRevision>;
} {
  return {
    readActiveSchemaRevision: (scope) =>
      kernelCall(db, "kernel_read_active_schema_revision", scope),
    readVisibleRecords: (request) => kernelCall(db, "kernel_read_visible_records", request),
    validateChangeSetDryRun: async (request) =>
      canonicalDryRunResult(
        await kernelCall<AppliedChangeSet>(db, "kernel_validate_change_set_dry_run", request),
      ),
    applyChangeSet: (request) => kernelCall(db, "kernel_apply_change_set", request),
    recentActivity: (request) => kernelCall(db, "kernel_recent_activity", request),
    changeSetDiff: (request) => kernelCall(db, "kernel_change_set_diff", request),
  };
}
