import type { PoolClient } from "pg";

/** Run one tenant read under the same transaction-local scope used by schema RLS. */
export async function withProtectedTenantReadback<T>(
  client: PoolClient,
  appId: string,
  customerId: string,
  read: () => Promise<T>,
): Promise<T> {
  await client.query("begin read only");
  try {
    await client.query(
      "select set_config('kernel.app_id',$1,true), set_config('kernel.customer_id',$2,true)",
      [appId, customerId],
    );
    return await read();
  } finally {
    await client.query("rollback");
  }
}

/** Read app catalog metadata through the compiler-owned RLS policy. */
export async function withProtectedAppCatalogReadback<T>(
  client: PoolClient,
  appId: string,
  read: () => Promise<T>,
): Promise<T> {
  await client.query("begin read only");
  try {
    await client.query(
      "select set_config('kernel.app_id',$1,true), set_config('kernel.customer_id','',true), set_config('kernel.schema_catalog_read','on',true)",
      [appId],
    );
    return await read();
  } finally {
    await client.query("rollback");
  }
}

export type GeneratedInstallReadbackFacts = {
  version: string;
  base_schema_matches: boolean;
  overlay_empty: boolean;
  schema_matches: boolean;
  schema_hash_matches: boolean;
  revision_inactive: boolean;
  materialization_pending: boolean;
  release_id: string | null;
  activation_kind: string | null;
  base_artifact_hash: string | null;
  effective_artifact_hash: string | null;
  materialization_plan_hash: string | null;
  seed_change_sets_empty: boolean | null;
  phase_plan_empty: boolean | null;
  ready_at: Date | null;
  installation_inactive: boolean | null;
};

/** Distinguish a complete install from an exact, safely resumable prepared revision. */
export function classifyGeneratedInstallReadback(
  row: GeneratedInstallReadbackFacts,
  releaseId: string,
  artifactHash: string,
  emptyPlanHash: string,
): "applied" | "prepared" | "conflict" {
  const exactSchema =
    row.base_schema_matches === true &&
    row.overlay_empty === true &&
    row.schema_matches === true &&
    row.schema_hash_matches === true &&
    row.version === releaseId;
  const exactInstall =
    row.release_id === releaseId &&
    row.activation_kind === "app_base" &&
    row.base_artifact_hash === artifactHash &&
    row.effective_artifact_hash === artifactHash &&
    row.materialization_plan_hash === emptyPlanHash &&
    row.seed_change_sets_empty === true &&
    row.phase_plan_empty === true;
  if (
    exactSchema &&
    exactInstall &&
    row.revision_inactive === false &&
    row.materialization_pending === false &&
    row.ready_at !== null &&
    row.installation_inactive === false
  )
    return "applied";
  if (
    exactSchema &&
    exactInstall &&
    row.revision_inactive === true &&
    row.installation_inactive === true &&
    (row.ready_at === null || row.materialization_pending === false)
  )
    return "prepared";
  return "conflict";
}

/** An already completed predecessor may have ordinary seed/backfill history.
 * Current base-upgrade execution cannot preserve a non-empty tenant overlay. */
export type GeneratedPredecessorReadbackFacts = Omit<
  GeneratedInstallReadbackFacts,
  "materialization_plan_hash" | "seed_change_sets_empty" | "phase_plan_empty"
>;
export function classifyGeneratedPredecessorReadback(
  row: GeneratedPredecessorReadbackFacts,
): boolean {
  return (
    row.base_schema_matches === true &&
    row.overlay_empty === true &&
    row.schema_matches === true &&
    row.schema_hash_matches === true &&
    row.version === row.release_id &&
    row.activation_kind === "app_base" &&
    typeof row.base_artifact_hash === "string" &&
    /^[a-f0-9]{64}$/u.test(row.base_artifact_hash) &&
    row.effective_artifact_hash === row.base_artifact_hash &&
    row.revision_inactive === false &&
    row.materialization_pending === false &&
    row.ready_at !== null &&
    row.installation_inactive === false
  );
}

/** Resume exact prepared, new-tenant or supported predecessor states and missing managed phases. */
export function classifyGeneratedInstallReconciliation(
  revisions: Array<"applied" | "prepared" | "new-tenant" | "supported-predecessor" | "missing">,
  managedPhaseMissing: boolean,
): "applied" | "retryable" | "incomplete" {
  if (revisions.length === 0 || revisions.some((revision) => revision === "missing"))
    return "incomplete";
  if (
    revisions.some(
      (revision) =>
        revision === "prepared" ||
        revision === "new-tenant" ||
        revision === "supported-predecessor",
    )
  )
    return "retryable";
  return managedPhaseMissing ? "retryable" : "applied";
}
