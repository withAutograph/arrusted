import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import { z } from "zod";
import {
  classifyGeneratedPredecessorReadback,
  type GeneratedPredecessorReadbackFacts,
  withProtectedTenantReadback,
} from "./protected-installer-readback";

const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const schema = z.looseObject({
  app_id: z.string(),
  customer_id: z.string(),
  version: z.string(),
  models: z.array(
    z.looseObject({
      id: z.string(),
      kind: z.string(),
      fields: z.array(
        z.looseObject({
          id: z.string(),
          type: z.string(),
          required: z.boolean(),
          is_unique: z.boolean(),
          lifecycle: z.string(),
        }),
      ),
    }),
  ),
});
const planSchema = z.strictObject({
  kind: z.literal("optional-text-addition-v1"),
  predecessor_artifact_sha256: hash,
  predecessor_schema: schema,
  model_id: z.string().min(1),
  field_id: z.string().min(1),
  table: identifier,
  column: identifier,
  constraint: identifier,
  constraint_catalog: z.array(z.record(z.string(), z.unknown())),
  authorization_policy: z
    .strictObject({
      policy: z.record(z.string(), z.unknown()),
      sha256: hash,
    })
    .nullable(),
});

export type OnlineSchemaPlan = z.infer<typeof planSchema>;
type Schema = z.infer<typeof schema>;
type Scope = {
  appId: string;
  customerIds: readonly string[];
  candidateSchema: Schema;
  candidateHash: string;
};
type CheckFence = () => Promise<void>;

const invalid = () => new Error("protected_installer_online_schema_mismatch");
const quote = (value: string) => `"${identifier.parse(value)}"`;

/** Read only compiler metadata from the already verified release snapshot. */
export function readOnlineSchemaPlan(
  release: ReadonlyMap<string, Buffer>,
): OnlineSchemaPlan | undefined {
  const transition = JSON.parse(release.get("transition-plan.json")!.toString("utf8"));
  if (transition.online_optional_text_addition === undefined) return;
  const plan = planSchema.parse(transition.online_optional_text_addition);
  const operations = JSON.parse(release.get("operation-manifest.json")!.toString("utf8"));
  const matching = operations.predecessorCompatibility?.predecessors?.filter(
    (prior: {
      artifactSha256: string;
      field: { modelId: string; fieldId: string };
      schema: unknown;
    }) =>
      prior.artifactSha256 === plan.predecessor_artifact_sha256 &&
      prior.field.modelId === plan.model_id &&
      prior.field.fieldId === plan.field_id &&
      isDeepStrictEqual(prior.schema, plan.predecessor_schema),
  );
  if (operations.predecessorCompatibility?.kind !== plan.kind || matching?.length !== 1)
    throw invalid();
  return plan;
}

export function readOnlineSchemaCandidate(release: ReadonlyMap<string, Buffer>): Schema {
  return schema.parse(JSON.parse(release.get("app-artifact.json")!.toString("utf8")).schema);
}

/** Install one optional text field without replaying DDL on shared catalog or existing policy tables. */
export async function installOnlineSchema(
  client: PoolClient,
  scope: Scope,
  plan: OnlineSchemaPlan,
  assertCurrent: CheckFence,
): Promise<ReadonlyMap<string, string>> {
  if (
    scope.customerIds.length === 0 ||
    plan.predecessor_schema.app_id !== scope.appId ||
    scope.candidateSchema.app_id !== scope.appId ||
    plan.predecessor_schema.customer_id !== scope.candidateSchema.customer_id ||
    plan.predecessor_schema.version === scope.candidateSchema.version ||
    plan.predecessor_artifact_sha256 === scope.candidateHash
  )
    throw invalid();
  const priorModel = plan.predecessor_schema.models.find((model) => model.id === plan.model_id);
  const model = scope.candidateSchema.models.find((entry) => entry.id === plan.model_id);
  const field = model?.fields.find((entry) => entry.id === plan.field_id);
  if (
    priorModel?.kind !== "entity" ||
    priorModel.fields.some((entry) => entry.id === plan.field_id) ||
    model?.kind !== "entity" ||
    field?.type !== "text" ||
    field.required ||
    field.is_unique ||
    field.lifecycle !== "active"
  )
    throw invalid();
  const names = await client.query<{
    table_name: string;
    column_name: string;
    constraint_name: string;
  }>(
    `with names as (
       select kernel_admin_bounded_identifier(kernel_admin_normalize_identifier($1) || '_version') as table_name,
              kernel_admin_bounded_identifier(kernel_admin_normalize_identifier($2)) as column_name
     )
     select *, kernel_admin_bounded_identifier(table_name || '_' || column_name || '_record_event_null_check') as constraint_name
     from names`,
    [plan.model_id, plan.field_id],
  );
  const physical = names.rows[0];
  if (
    physical?.table_name !== plan.table ||
    physical.column_name !== plan.column ||
    physical.constraint_name !== plan.constraint
  )
    throw invalid();

  const activeHashes = new Map<string, string>();
  for (const customerId of scope.customerIds) {
    const activeHash = await withProtectedTenantReadback(
      client,
      scope.appId,
      customerId,
      async () => {
        const predecessor = { ...plan.predecessor_schema, customer_id: customerId };
        const candidate = { ...scope.candidateSchema, customer_id: customerId };
        const active = await client.query<GeneratedPredecessorReadbackFacts & { schema: Schema }>(
          `select sr.version, sr.base_schema as schema,
                kernel_installer_default_model_kind(sr.base_schema) in ($3::jsonb, $4::jsonb) as base_schema_matches,
                sr.customer_overlay='{}'::jsonb as overlay_empty,
                sr.schema=sr.base_schema as schema_matches,
                sr.schema_hash=kernel_admin_sha256(kernel_canonical_json(sr.schema)) as schema_hash_matches,
                sr.activated_at is null as revision_inactive,
                sr.materialized_at is null as materialization_pending,
                sir.release_id, sir.activation_kind, sir.base_artifact_hash, sir.effective_artifact_hash,
                sir.ready_at, sir.activated_at is null as installation_inactive
         from schema_revision sr
         join schema_installation_revision sir
           on sir.schema_revision_id=sr.id and sir.app_id=sr.app_id and sir.customer_id=sr.customer_id
         where sr.app_id=$1 and sr.customer_id=$2 and sr.activated_at is not null`,
          [scope.appId, customerId, JSON.stringify(predecessor), JSON.stringify(candidate)],
        );
        const row = active.rows[0];
        const expectedHash =
          row?.version === candidate.version
            ? scope.candidateHash
            : plan.predecessor_artifact_sha256;
        if (
          active.rowCount !== 1 ||
          !row ||
          !classifyGeneratedPredecessorReadback(row) ||
          row.base_artifact_hash !== expectedHash ||
          (row.version !== predecessor.version && row.version !== candidate.version)
        )
          throw invalid();

        const checked = await client.query<{
          materialized: { ok: boolean; data?: boolean };
          preflight: { ok: boolean };
        }>(
          `select kernel_schema_revision_is_active_with_materialized_tables($1::jsonb) as materialized,
                kernel_preflight_schema_materialization($2::jsonb) as preflight`,
          [JSON.stringify(row.schema), JSON.stringify(candidate)],
        );
        const result = checked.rows[0];
        if (!result?.materialized?.ok || result.materialized.data !== true || !result.preflight?.ok)
          throw invalid();
        return expectedHash;
      },
    );
    activeHashes.set(customerId, activeHash);
  }

  await writeOnlineCatalog(client, scope, plan, assertCurrent);
  const table = `public.${quote(plan.table)}`;
  const column = quote(plan.column);
  const constraint = quote(plan.constraint);
  const expression = `(not tombstones_record and not untombstones_record) or ${column} is null`;
  await retrySchemaTransaction(client, assertCurrent, async () => {
    await client.query("select kernel_installer_lock_app($1, true)", [scope.appId]);
    const installed = await readOnlineColumn(client, plan, expression);
    if (!installed.columnPresent || !installed.constraintPresent) {
      // Never queue an exclusive relation lock in front of ordinary app queries.
      await client.query(`lock table only ${table} in access exclusive mode nowait`);
      if (!installed.columnPresent)
        await client.query(`alter table ${table} add column ${column} text`);
      if (!installed.constraintPresent)
        await client.query(
          `alter table ${table} add constraint ${constraint} check (${expression}) not valid`,
        );
    }
  });
  await retrySchemaTransaction(client, assertCurrent, async () => {
    await client.query("select kernel_installer_lock_app($1, true)", [scope.appId]);
    const installed = await readOnlineColumn(client, plan, expression);
    if (!installed.columnPresent || !installed.constraintPresent) throw invalid();
    // Validation needs only SHARE UPDATE EXCLUSIVE, which permits normal reads and writes.
    if (!installed.validated)
      await client.query(`alter table ${table} validate constraint ${constraint}`);
    if (!(await readOnlineColumn(client, plan, expression)).validated) throw invalid();
  });
  return activeHashes;
}

async function readOnlineColumn(client: PoolClient, plan: OnlineSchemaPlan, expression: string) {
  const result = await client.query<{
    columnPresent: boolean;
    columnMatches: boolean;
    constraintPresent: boolean;
    constraintMatches: boolean;
    validated: boolean;
  }>(
    `select
       attribute.attnum is not null as "columnPresent",
       coalesce(attribute.atttypid='text'::regtype and not attribute.attnotnull
         and not attribute.atthasdef and attribute.attidentity='' and attribute.attgenerated='', false) as "columnMatches",
       rule.oid is not null as "constraintPresent",
       coalesce(rule.contype='c' and regexp_replace(lower(pg_get_expr(rule.conbin, rule.conrelid)), '[[:space:]()"]', '', 'g')
         = regexp_replace(lower($4), '[[:space:]()"]', '', 'g'), false) as "constraintMatches",
       coalesce(rule.convalidated, false) as validated
     from pg_class relation
     left join pg_attribute attribute
       on attribute.attrelid=relation.oid and attribute.attname=$2 and attribute.attnum>0 and not attribute.attisdropped
     left join pg_constraint rule on rule.conrelid=relation.oid and rule.conname=$3
     where relation.oid=to_regclass(format('public.%I', $1::text)) and relation.relkind='r'`,
    [plan.table, plan.column, plan.constraint, expression],
  );
  const row = result.rows[0];
  if (
    !row ||
    (row.columnPresent && !row.columnMatches) ||
    (row.constraintPresent && (!row.constraintMatches || !row.columnPresent))
  )
    throw invalid();
  return row;
}

async function writeOnlineCatalog(
  client: PoolClient,
  scope: Scope,
  plan: OnlineSchemaPlan,
  assertCurrent: CheckFence,
) {
  const version = scope.candidateSchema.version;
  const policy = plan.authorization_policy;
  await retrySchemaTransaction(client, assertCurrent, async () => {
    await client.query("select kernel_installer_lock_app($1, true)", [scope.appId]);
    await client.query(
      "select set_config('kernel.app_id',$1,true), set_config('kernel.customer_id',$2,true)",
      [scope.appId, scope.candidateSchema.customer_id],
    );
    const catalog = [scope.appId, version, JSON.stringify(plan.constraint_catalog)];
    await client.query(
      "insert into schema_constraint_identity_source (app_id,schema_version,catalog) values ($1,$2,$3::jsonb) on conflict do nothing",
      catalog,
    );
    const expectedCatalog = await client.query(
      "select 1 from schema_constraint_identity_source where app_id=$1 and schema_version=$2 and catalog=$3::jsonb",
      catalog,
    );
    if (expectedCatalog.rowCount !== 1) throw invalid();
    if (policy) {
      const expected = [scope.appId, version, JSON.stringify(policy.policy), policy.sha256];
      await client.query(
        "insert into schema_authorization_policy_source (app_id,schema_version,policy,policy_hash) values ($1,$2,$3::jsonb,$4) on conflict do nothing",
        expected,
      );
      const policyReadback = await client.query(
        `select 1 from schema_authorization_policy_source where app_id=$1 and schema_version=$2
         and policy=$3::jsonb and policy_hash=$4 and policy_hash=kernel_admin_sha256(kernel_canonical_json(policy))`,
        expected,
      );
      if (policyReadback.rowCount !== 1) throw invalid();
    }
    const expectation = [scope.appId, version, policy !== null, policy?.sha256 ?? null];
    await client.query(
      "insert into schema_authorization_policy_expectation (app_id,schema_version,policy_declared,policy_hash) values ($1,$2,$3,$4) on conflict do nothing",
      expectation,
    );
    const policyReadback = await client.query(
      "select 1 from schema_authorization_policy_expectation where app_id=$1 and schema_version=$2 and policy_declared=$3 and policy_hash is not distinct from $4",
      expectation,
    );
    if (policyReadback.rowCount !== 1) throw invalid();
  });
}

/** Give online activation SQL a shorter lock budget than live app requests. */
export async function runOnlineSchemaRevisionEffect<T>(
  client: PoolClient,
  assertCurrent: CheckFence,
  run: () => Promise<T>,
): Promise<T> {
  return retrySchemaTransaction(client, assertCurrent, run);
}

async function retrySchemaTransaction<T>(
  client: PoolClient,
  assertCurrent: CheckFence,
  run: () => Promise<T>,
): Promise<T> {
  const deadline = performance.now() + 20_000;
  while (true) {
    await assertCurrent();
    await client.query("begin");
    try {
      await client.query("set local lock_timeout = '250ms'");
      const result = await run();
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      if (
        !(error instanceof Error && "code" in error && error.code === "55P03") ||
        performance.now() >= deadline
      )
        throw error;
    }
    await delay(250);
  }
}
