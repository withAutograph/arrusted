import { createHash } from "node:crypto";
import { parse } from "@libpg-query/parser";
import { getSchema } from "better-auth/db";
import { createAuthSchemaDefinitionOptions } from "../../../../packages/auth/server";
// @ts-ignore The Vite and Bun worker bundlers resolve the SQL raw suffix.
import genesisSql from "../../../../packages/auth/schema.sql?raw";
import { getMigrations, matchType } from "better-auth/db/migration";
import type { BetterAuthOptions } from "better-auth";
import type { Pool, PoolClient } from "pg";
// @ts-ignore The Vite and Bun worker bundlers resolve the SQL raw suffix.
import compatibilitySql from "../../../../packages/auth/relax-account-issuer-v1.7.3.sql?raw";
// @ts-ignore The Vite and Bun worker bundlers resolve the SQL raw suffix.
import runtimePrivilegesSql from "../../../../packages/auth/runtime-privileges.sql?raw";
// @ts-ignore The Vite and Bun worker bundlers resolve the SQL raw suffix.
import operatorLocksSql from "../../../../packages/auth/operator-locks.sql?raw";
// @ts-ignore The Vite and Bun worker bundlers resolve the SQL raw suffix.
import operatorPrivilegesSql from "../../../../packages/auth/operator-privileges.sql?raw";
// @ts-ignore The Vite and Bun worker bundlers resolve the SQL raw suffix.
import readinessSql from "../../../../packages/auth/schema-readiness.sql?raw";
import { verifyAuthSchemaReadiness } from "../../../../packages/auth/schema-readiness";
// @ts-ignore The Vite and Bun worker bundlers resolve the SQL raw suffix.
import platformSql from "../../../../packages/auth/provision-organizations.sql?raw";
import {
  verifyAuthDatabaseResource,
  type AuthDatabaseResource,
} from "../../../../packages/auth/database-resource";

const history = '"_auth_schema_history"';
const historyContract = {
  version: 1,
  schema: "_auth_schema_history",
  tables: ["plan", "attempt"],
} as const;
const sqlDigest = (value: string) => createHash("sha256").update(value).digest("hex");
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
function canonical(value: unknown): string {
  if (typeof value === "function") return JSON.stringify("[computed-schema-default]");
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export class AuthSchemaMigrationError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
  ) {
    super(
      `Auth schema migration failed: ${code}${retryable ? "; retry the same reviewed plan" : ""}`,
    );
  }
}
export type AuthSchemaPlan = {
  version: 1;
  resource: AuthDatabaseResource;
  authOperatorRole?: string;
  toolchain: "better-auth@1.7.28";
  history: typeof historyContract;
  catalogAppIds: string[];
  targetDigest: string;
  beforeSchemaHash: string;
  effects: Array<{
    owner:
      | "compatibility"
      | "preview-artifact"
      | "better-auth"
      | "platform"
      | "readiness"
      | "runtime-privileges"
      | "operator-privileges";
    sql: string;
    sha256: string;
  }>;
  planDigest: string;
};
type MigrationInput = {
  pool: Pool;
  resource: AuthDatabaseResource;
  authOperatorRole?: string;
  options: BetterAuthOptions;
  catalogAppIds?: string[];
  previewSql?: string;
  requireNewEmptyPublicNamespace?: boolean;
};
type Attempt = {
  id: string;
  status: string;
  before_hash: string;
  after_hash: string | null;
  readiness_fingerprint: string | null;
  plan: AuthSchemaPlan;
};

/** The retained database-scoped lock also serializes legacy deployment runners. */
export async function withAuthSchemaLock<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let locked = false;
  try {
    locked =
      (
        await client.query(
          "select pg_try_advisory_lock(hashtext('platform:auth-schema:migration:v1')) as locked",
        )
      ).rows[0]?.locked === true;
    if (!locked) throw new AuthSchemaMigrationError("migration_contention", true);
    return await operation(client);
  } finally {
    if (locked)
      await client
        .query("select pg_advisory_unlock(hashtext('platform:auth-schema:migration:v1'))")
        .catch(() => {});
    client.release();
  }
}

export async function authSchemaHash(client: PoolClient): Promise<string> {
  // Catalog metadata only; no account, user, session, membership or assignment rows.
  const columns = await client.query(
    "select table_name,column_name,ordinal_position,data_type,udt_name,is_nullable,column_default from information_schema.columns where table_schema='public' order by table_name,ordinal_position",
  );
  const constraints = await client.query(
    "select c.relname,con.conname,con.contype,con.convalidated,pg_get_constraintdef(con.oid) as definition from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' order by c.relname,con.conname",
  );
  const indexes = await client.query(
    "select c.relname,i.relname as index_name,x.indisvalid,x.indisready,pg_get_indexdef(x.indexrelid) as definition from pg_index x join pg_class c on c.oid=x.indrelid join pg_class i on i.oid=x.indexrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' order by c.relname,i.relname",
  );
  const relations = await client.query(
    "select c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' order by c.relname",
  );
  const triggers = await client.query(
    "select c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid,true) as definition,pg_get_functiondef(t.tgfoid) as function_definition from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal order by c.relname,t.tgname",
  );
  const policies = await client.query(
    "select c.relname,p.polname,p.polcmd,p.polpermissive,p.polroles::text as roles,pg_get_expr(p.polqual,p.polrelid) as using_expression,pg_get_expr(p.polwithcheck,p.polrelid) as check_expression from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' order by c.relname,p.polname",
  );
  return digest([
    columns.rows,
    constraints.rows,
    indexes.rows,
    relations.rows,
    triggers.rows,
    policies.rows,
  ]);
}

async function platformSchemaSql(): Promise<string> {
  const source = platformSql;
  const parsed = await parse(source);
  if (
    (parsed.stmts ?? []).some((statement) => {
      const node = statement.stmt ?? {};
      return !(
        "CreateStmt" in node ||
        "IndexStmt" in node ||
        "AlterTableStmt" in node ||
        "InsertStmt" in node ||
        "TransactionStmt" in node
      );
    })
  )
    throw new AuthSchemaMigrationError("unsupported_platform_schema_effect");
  const statements = (parsed.stmts ?? []).filter(
    (statement) =>
      "CreateStmt" in (statement.stmt ?? {}) ||
      "AlterTableStmt" in (statement.stmt ?? {}) ||
      "IndexStmt" in (statement.stmt ?? {}),
  );
  return statements.map((statement) => originalParsedStatement(source, statement)).join("\n");
}
export function originalParsedStatement(
  source: string,
  statement: { stmt_location?: number; stmt_len?: number },
): string {
  const start = statement.stmt_location ?? 0;
  const length = statement.stmt_len;
  const bytes = Buffer.from(source, "utf8");
  if (length === undefined || length <= 0 || start < 0 || start + length > bytes.length)
    throw new AuthSchemaMigrationError("invalid_parsed_schema_statement");
  return `${bytes
    .subarray(start, start + length)
    .toString("utf8")
    .trim()};`;
}
export async function assertGeneratedAuthSqlIsAdditive(sql: string): Promise<void> {
  if (!sql.trim() || sql.trim() === ";") return;
  if (/\$[0-9]+/u.test(sql)) throw new AuthSchemaMigrationError("unbound_schema_parameters");
  const parsed = await parse(sql);
  for (const statement of parsed.stmts ?? []) {
    const node = statement.stmt as Record<string, unknown>;
    const index = node.IndexStmt as { concurrent?: boolean } | undefined;
    const alter = node.AlterTableStmt as
      | { cmds?: Array<{ AlterTableCmd?: { subtype?: string } }> }
      | undefined;
    if (
      "CreateStmt" in node ||
      (index && !index.concurrent) ||
      (alter?.cmds?.length &&
        alter.cmds.every((command) => command.AlterTableCmd?.subtype === "AT_AddColumn"))
    )
      continue;
    throw new AuthSchemaMigrationError("non_additive_schema_effect");
  }
}
async function historyExists(client: PoolClient, resource: AuthDatabaseResource): Promise<boolean> {
  const found = await client.query(
    "select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname='_auth_schema_history'",
  );
  if (!found.rowCount) return false;
  if (found.rows[0]?.owner !== resource.migratorRole)
    throw new AuthSchemaMigrationError("unowned_schema_history");
  const tables = await client.query(
    "select c.relname,pg_get_userbyid(c.relowner) as owner from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='_auth_schema_history' and c.relkind='r' order by c.relname",
  );
  if (
    tables.rows.length !== 2 ||
    tables.rows.some(
      (table) =>
        !["attempt", "plan"].includes(table.relname) || table.owner !== resource.migratorRole,
    )
  )
    throw new AuthSchemaMigrationError("invalid_schema_history_tables");
  const privilege = await client.query(
    "select has_schema_privilege($1,'_auth_schema_history','USAGE,CREATE') as schema,has_table_privilege($1,'_auth_schema_history.plan','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as plan,has_table_privilege($1,'_auth_schema_history.attempt','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as attempt",
    [resource.runtimeRole],
  );
  if (Object.values(privilege.rows[0] ?? {}).some(Boolean))
    throw new AuthSchemaMigrationError("exposed_schema_history");
  return true;
}
async function recordedAttempts(
  client: PoolClient,
  targetDigest: string,
  resource: AuthDatabaseResource,
): Promise<Attempt[]> {
  if (!(await historyExists(client, resource))) return [];
  const result = await client.query<Attempt>(
    `select a.id::text,a.status,a.before_hash,a.after_hash,to_jsonb(a)->>'readiness_fingerprint' as readiness_fingerprint,p.plan from ${history}.attempt a join ${history}.plan p on p.digest=a.plan_digest where p.target_digest=$1 order by a.id desc`,
    [targetDigest],
  );
  return result.rows;
}
/** Same canonical representation used by historical target digests, including computed defaults. */
export function authSchemaDefinition(options: BetterAuthOptions): string {
  return canonical(getSchema(options));
}

type AuthDesiredInput = Omit<MigrationInput, "pool">;
async function desiredAuthSchema(input: AuthDesiredInput) {
  const { authOperatorRole, resource } = input;
  if (
    authOperatorRole !== undefined &&
    (resource.environment !== "production" ||
      !/^[a-z][a-z0-9_]{0,62}$/u.test(authOperatorRole) ||
      [resource.migratorRole, resource.runtimeRole].includes(authOperatorRole))
  )
    throw new AuthSchemaMigrationError("invalid_auth_operator_role");
  const operatorPrivileges =
    authOperatorRole === undefined
      ? undefined
      : `${operatorLocksSql}\n${operatorPrivilegesSql}`
          .replaceAll("__OPERATOR_ROLE__", quote(authOperatorRole))
          .replaceAll("__OPERATOR_ROLE_LITERAL__", `'${authOperatorRole}'`);
  const compatibility = compatibilitySql;
  const platform = await platformSchemaSql();
  const catalogAppIds = [...(input.catalogAppIds ?? [])].sort();
  if (!catalogAppIds.length || new Set(catalogAppIds).size !== catalogAppIds.length)
    throw new AuthSchemaMigrationError("invalid_catalog_app_ids");
  const preview = input.previewSql ?? "";
  await assertGeneratedAuthSqlIsAdditive(preview);
  const targetDigest = digest({
    toolchain: "better-auth@1.7.28",
    resource: input.resource,
    catalogAppIds,
    schema: getSchema(input.options),
    compatibility,
    platform,
    preview,
    runtimePrivilegesAssetSha256: sqlDigest(runtimePrivilegesSql),
    ...(operatorPrivileges === undefined
      ? {}
      : { authOperatorRole, operatorPrivilegesAssetSha256: sqlDigest(operatorPrivileges) }),
    readinessAssetSha256: sqlDigest(readinessSql),
  });
  return { compatibility, platform, preview, catalogAppIds, operatorPrivileges, targetDigest };
}
function buildAuthSchemaPlan(
  input: AuthDesiredInput,
  desired: Awaited<ReturnType<typeof desiredAuthSchema>>,
  beforeSchemaHash: string,
  generated: string,
): AuthSchemaPlan {
  const { compatibility, platform, preview, catalogAppIds, operatorPrivileges, targetDigest } =
    desired;
  const effects: AuthSchemaPlan["effects"] = [
    { owner: "compatibility", sql: compatibility, sha256: sqlDigest(compatibility) },
    ...(preview.trim()
      ? [{ owner: "preview-artifact" as const, sql: preview, sha256: sqlDigest(preview) }]
      : []),
    { owner: "better-auth", sql: generated, sha256: sqlDigest(generated) },
    { owner: "compatibility", sql: compatibility, sha256: sqlDigest(compatibility) },
    { owner: "platform", sql: platform, sha256: sqlDigest(platform) },
    {
      owner: "runtime-privileges",
      sql: runtimePrivilegesSql
        .replaceAll("__RUNTIME_ROLE__", quote(input.resource.runtimeRole))
        .replaceAll(
          "__RUNTIME_ROLE_LITERAL__",
          `'${input.resource.runtimeRole.replaceAll("'", "''")}'`,
        ),
      sha256: sqlDigest(
        runtimePrivilegesSql
          .replaceAll("__RUNTIME_ROLE__", quote(input.resource.runtimeRole))
          .replaceAll(
            "__RUNTIME_ROLE_LITERAL__",
            `'${input.resource.runtimeRole.replaceAll("'", "''")}'`,
          ),
      ),
    },
    ...(operatorPrivileges === undefined
      ? []
      : [
          {
            owner: "operator-privileges" as const,
            sql: operatorPrivileges,
            sha256: sqlDigest(operatorPrivileges),
          },
        ]),
    { owner: "readiness", sql: readinessSql, sha256: sqlDigest(readinessSql) },
  ];
  const plan = {
    version: 1 as const,
    resource: input.resource,
    ...(input.authOperatorRole === undefined ? {} : { authOperatorRole: input.authOperatorRole }),
    history: historyContract,
    catalogAppIds,
    toolchain: "better-auth@1.7.28" as const,
    targetDigest,
    beforeSchemaHash,
    effects,
  };
  return { ...plan, planDigest: digest(plan) };
}

/** Prospective empty catalog only. A worker must re-plan its actual owned database before writing. */
export const EMPTY_AUTH_PUBLIC_CATALOG_HASH = digest([[], [], [], [], [], []]);
export async function proposeEmptyAuthSchemaMigration(
  input: Pick<MigrationInput, "resource" | "catalogAppIds" | "authOperatorRole">,
) {
  const definition = { ...input, options: createAuthSchemaDefinitionOptions() };
  const desired = await desiredAuthSchema(definition);
  const generated = genesisSql.trim();
  await assertGeneratedAuthSqlIsAdditive(generated);
  return {
    version: 1 as const,
    proposal: "new-empty" as const,
    resource: input.resource,
    schemaPlan: buildAuthSchemaPlan(definition, desired, EMPTY_AUTH_PUBLIC_CATALOG_HASH, generated),
  };
}

/** New-resource proposals require the entire public namespace to be empty.
 * Keep this separate from the historical schema fingerprint algorithm. */
async function assertEmptyPublicNamespace(client: PoolClient): Promise<void> {
  const result = await client.query<{ occupied: boolean }>(`
    select exists (
      select 1 from pg_depend
      where refclassid = 'pg_namespace'::regclass
        and refobjid = 'public'::regnamespace
    ) as occupied
  `);
  if (result.rows[0]?.occupied !== false)
    throw new AuthSchemaMigrationError("new_empty_public_namespace_occupied");
}

async function buildPlan(client: PoolClient, input: MigrationInput): Promise<AuthSchemaPlan> {
  await verifyAuthDatabaseResource(client, input.resource, "migrator");
  const desired = await desiredAuthSchema(input);
  const { targetDigest } = desired;
  const beforeSchemaHash = await authSchemaHash(client);
  const attempts = await recordedAttempts(client, targetDigest, input.resource);
  if (input.requireNewEmptyPublicNamespace && !attempts.some((attempt) => attempt.after_hash))
    await assertEmptyPublicNamespace(client);
  const verified = attempts.find((attempt) => attempt.status === "verified");
  if (verified) {
    if (verified.after_hash !== beforeSchemaHash)
      throw new AuthSchemaMigrationError("verified_schema_drift");
    return verified.plan;
  }
  const interrupted = attempts.find((attempt) =>
    ["attempted", "applying", "failed"].includes(attempt.status),
  );
  if (interrupted?.after_hash) {
    if (interrupted.after_hash !== beforeSchemaHash)
      throw new AuthSchemaMigrationError("incomplete_schema_reconciliation_required");
    return interrupted.plan;
  }
  if (interrupted && interrupted.before_hash !== beforeSchemaHash)
    throw new AuthSchemaMigrationError("incomplete_schema_reconciliation_required");
  const migrations = await getMigrations(input.options);
  const generated = await migrations.compileMigrations();
  await assertGeneratedAuthSqlIsAdditive(generated);
  const result = buildAuthSchemaPlan(input, desired, beforeSchemaHash, generated);
  if (interrupted && interrupted.plan.planDigest !== result.planDigest)
    throw new AuthSchemaMigrationError("incomplete_effect_plan_changed");
  return result;
}
export async function planAuthSchemaMigration(input: MigrationInput): Promise<AuthSchemaPlan> {
  return withAuthSchemaLock(input.pool, (client) => buildPlan(client, input));
}

/** Confirm the original verified outcome without planning, initializing, or applying effects. */
export async function readAuthSchemaMigration(
  input: MigrationInput & { approvedPlan: AuthSchemaPlan; approvedDigest: string },
) {
  const { planDigest, ...approvedBody } = input.approvedPlan;
  if (
    !/^[a-f0-9]{64}$/u.test(input.approvedDigest) ||
    input.approvedDigest !== planDigest ||
    digest(approvedBody) !== planDigest ||
    canonical(input.approvedPlan.resource) !== canonical(input.resource) ||
    input.approvedPlan.authOperatorRole !== input.authOperatorRole
  )
    throw new AuthSchemaMigrationError("schema_readback_plan_mismatch");
  const desired = await desiredAuthSchema(input);
  if (
    input.approvedPlan.targetDigest !== desired.targetDigest ||
    canonical(input.approvedPlan.catalogAppIds) !== canonical(desired.catalogAppIds)
  )
    throw new AuthSchemaMigrationError("schema_readback_plan_mismatch");
  return withAuthSchemaLock(input.pool, async (client) => {
    await client.query("begin isolation level repeatable read read only");
    try {
      await verifyAuthDatabaseResource(client, input.resource, "migrator");
      const attempts = await recordedAttempts(client, desired.targetDigest, input.resource);
      const verified = attempts.find(
        (attempt) =>
          attempt.status === "verified" &&
          canonical(attempt.plan) === canonical(input.approvedPlan),
      );
      if (
        !verified?.after_hash ||
        !verified.readiness_fingerprint ||
        verified.before_hash !== input.approvedPlan.beforeSchemaHash
      )
        throw new AuthSchemaMigrationError("schema_readback_not_verified");
      await verifyAuthDesiredSchema(client, input.options);
      const observedHash = await authSchemaHash(client);
      if (observedHash !== verified.after_hash)
        throw new AuthSchemaMigrationError("schema_readback_drift");
      const readiness = await verifyAuthSchemaReadiness(client, {
        database: input.resource.database,
        targetDigest: desired.targetDigest,
        assetSha256: readinessAssetSha256,
      });
      if (readiness.observedFingerprint !== verified.readiness_fingerprint)
        throw new AuthSchemaMigrationError("schema_readback_drift");
      await client.query("commit");
      return {
        version: 1,
        scope: "auth-schema",
        state: "verified",
        planDigest,
        targetDigest: desired.targetDigest,
        attemptId: verified.id,
        beforeSchemaHash: verified.before_hash,
        afterSchemaHash: observedHash,
        readinessFingerprint: readiness.observedFingerprint,
      };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

async function initializeHistory(client: PoolClient, resource: AuthDatabaseResource) {
  if (await historyExists(client, resource)) {
    await client.query(
      `alter table ${history}.attempt add column if not exists readiness_fingerprint text`,
    );
    return;
  }
  await client.query("begin");
  try {
    await client.query(`create schema ${history}`);
    await client.query(
      `revoke all on schema ${history} from public, ${quote(resource.runtimeRole)}`,
    );
    await client.query(
      `create table if not exists ${history}.plan (digest text primary key,target_digest text not null,plan jsonb not null,recorded_at timestamptz not null default now())`,
    );
    await client.query(
      `create table if not exists ${history}.attempt (id bigint generated always as identity primary key,plan_digest text not null references ${history}.plan(digest),status text not null check(status in ('attempted','applying','verified','failed')),before_hash text not null,after_hash text,readiness_fingerprint text,failure_code text,started_at timestamptz not null default now(),observed_at timestamptz not null default now())`,
    );
    await client.query(
      `revoke all on all tables in schema ${history} from public, ${quote(resource.runtimeRole)}`,
    );
    await client.query(
      `revoke all on all sequences in schema ${history} from public, ${quote(resource.runtimeRole)}`,
    );
    await historyExists(client, resource);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}
/** Re-read the configured Better Auth schema against an independent connection. */
const readinessNamespace = '"_auth_schema_readiness"';
const readinessAssetSha256 = sqlDigest(readinessSql);
async function initializeReadiness(client: PoolClient, resource: AuthDatabaseResource) {
  const marker = `auth-schema-readiness:v1:${resource.database}:${resource.migratorRole}:${resource.runtimeRole}`;
  const found = await client.query(
    "select pg_get_userbyid(nspowner) owner,obj_description(oid,'pg_namespace') marker from pg_namespace where nspname='_auth_schema_readiness'",
  );
  if (
    found.rows.length &&
    (found.rows[0]?.owner !== resource.migratorRole || found.rows[0]?.marker !== marker)
  )
    throw new AuthSchemaMigrationError("unowned_readiness_namespace");
  if (found.rows.length) {
    const objects = await client.query(
      "select c.relname name,pg_get_userbyid(c.relowner) owner from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='_auth_schema_readiness' and c.relkind not in ('i','I')",
    );
    if (
      objects.rows.some(
        (row) => row.name !== "current_target" || row.owner !== resource.migratorRole,
      )
    )
      throw new AuthSchemaMigrationError("unowned_readiness_object");
    const functions = await client.query(
      "select p.proname name,pg_get_function_identity_arguments(p.oid) arguments,pg_get_userbyid(p.proowner) owner from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='_auth_schema_readiness'",
    );
    if (
      functions.rows.some(
        (row) =>
          !(row.name === "catalog_fingerprint"
            ? row.arguments === "runtime_name text"
            : row.name === "normalized_acl"
              ? row.arguments === 'items aclitem[], object_type "char", owner_id oid'
              : row.name === "read_current" && row.arguments === "") ||
          row.owner !== resource.migratorRole,
      )
    )
      throw new AuthSchemaMigrationError("unowned_readiness_object");
  }
  await client.query("begin");
  try {
    if (!found.rows.length) {
      await client.query(`create schema ${readinessNamespace}`);
      await client.query(`comment on schema ${readinessNamespace} is '${marker}'`);
    }
    await client.query(readinessSql);
    await client.query(
      `revoke all on schema ${readinessNamespace} from public,${quote(resource.runtimeRole)}`,
    );
    await client.query(
      `revoke all on all tables in schema ${readinessNamespace} from public,${quote(resource.runtimeRole)}`,
    );
    await client.query(
      `revoke all on all functions in schema ${readinessNamespace} from public,${quote(resource.runtimeRole)}`,
    );
    await client.query(
      `grant usage on schema ${readinessNamespace} to ${quote(resource.runtimeRole)}`,
    );
    await client.query(
      `grant execute on function ${readinessNamespace}.read_current() to ${quote(resource.runtimeRole)}`,
    );
    const privilege = await client.query(
      `select has_schema_privilege($1,'_auth_schema_readiness','CREATE') schema_create,has_table_privilege($1,'_auth_schema_readiness.current_target','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') publication,has_any_column_privilege($1,'_auth_schema_readiness.current_target','SELECT,INSERT,UPDATE,REFERENCES') publication_column,has_function_privilege($1,'_auth_schema_readiness.catalog_fingerprint(text)','EXECUTE') catalog_function`,
      [resource.runtimeRole],
    );
    if (Object.values(privilege.rows[0] ?? {}).some((allowed) => allowed !== false))
      throw new AuthSchemaMigrationError("exposed_readiness_state");
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}
async function invalidateReadiness(client: PoolClient, plan: AuthSchemaPlan) {
  await client.query(
    `insert into ${readinessNamespace}.current_target(singleton,state,target_digest,asset_sha256,runtime_role) values(true,'pending',$1,$2,$3) on conflict(singleton) do update set state='pending',target_digest=excluded.target_digest,asset_sha256=excluded.asset_sha256,runtime_role=excluded.runtime_role,catalog_fingerprint=null,verified_at=null`,
    [plan.targetDigest, readinessAssetSha256, plan.resource.runtimeRole],
  );
}
async function currentReadinessFingerprint(
  client: PoolClient,
  resource: AuthDatabaseResource,
): Promise<string> {
  return (
    await client.query<{ fingerprint: string }>(
      `select ${readinessNamespace}.catalog_fingerprint($1) fingerprint`,
      [resource.runtimeRole],
    )
  ).rows[0]!.fingerprint;
}
async function publishReadiness(client: PoolClient, plan: AuthSchemaPlan, fingerprint: string) {
  await client.query(
    `insert into ${readinessNamespace}.current_target(singleton,state,target_digest,asset_sha256,runtime_role,catalog_fingerprint,verified_at) values(true,'verified',$1,$2,$3,$4,now()) on conflict(singleton) do update set state='verified',target_digest=excluded.target_digest,asset_sha256=excluded.asset_sha256,runtime_role=excluded.runtime_role,catalog_fingerprint=excluded.catalog_fingerprint,verified_at=excluded.verified_at`,
    [plan.targetDigest, readinessAssetSha256, plan.resource.runtimeRole, fingerprint],
  );
}

export async function verifyAuthDesiredSchema(client: PoolClient, options: BetterAuthOptions) {
  const result = await client.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    udt_name: string;
    is_nullable: string;
  }>(
    "select table_name,column_name,data_type,udt_name,is_nullable from information_schema.columns where table_schema='public'",
  );
  for (const [table, schema] of Object.entries(getSchema(options))) {
    if (schema.disableMigrations) continue;
    if (
      !result.rows.some(
        (column) =>
          column.table_name === table && column.column_name === "id" && column.is_nullable === "NO",
      )
    )
      throw new AuthSchemaMigrationError("configured_schema_mismatch");
    for (const [field, definition] of Object.entries(schema.fields)) {
      const column = result.rows.find(
        (candidate) => candidate.table_name === table && candidate.column_name === field,
      );
      if (
        !column ||
        !matchType(
          definition.type === "date" ? column.udt_name : column.data_type,
          definition.type,
          "postgres",
        ) ||
        (definition.required !== false && column.is_nullable !== "NO")
      )
        throw new AuthSchemaMigrationError("configured_schema_mismatch");
    }
  }
  const remaining = await getMigrations(options);
  if (
    remaining.toBeCreated.length ||
    remaining.toBeAdded.length ||
    remaining.toBeAddedIndexes.length ||
    remaining.unsafeChanges.length ||
    remaining.schemaProblems.length
  )
    throw new AuthSchemaMigrationError("schema_reconciliation_incomplete");
}

export async function applyAuthSchemaMigration(
  input: MigrationInput & {
    approvedDigest: string;
    /** Existing organization/access provisioning remains outside schema history. */
    afterSchema?: (client: PoolClient) => Promise<void>;
  },
) {
  return withAuthSchemaLock(input.pool, async (client) => {
    const plan = await buildPlan(client, input);
    if (!/^[0-9a-f]{64}$/u.test(input.approvedDigest) || input.approvedDigest !== plan.planDigest)
      throw new AuthSchemaMigrationError("reviewed_plan_digest_mismatch");
    const attempts = await recordedAttempts(client, plan.targetDigest, input.resource);
    const previous = attempts.find((attempt) => attempt.plan.planDigest === plan.planDigest);
    await initializeHistory(client, input.resource);
    await initializeReadiness(client, input.resource);
    if (previous?.status === "verified") {
      await verifyAuthDesiredSchema(client, input.options);
      const observed = await currentReadinessFingerprint(client, input.resource);
      if (!previous.readiness_fingerprint || observed !== previous.readiness_fingerprint)
        throw new AuthSchemaMigrationError("verified_readiness_drift");
      await client.query("begin");
      try {
        await publishReadiness(client, plan, observed);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
      await verifyAuthSchemaReadiness(client, {
        database: input.resource.database,
        targetDigest: plan.targetDigest,
        assetSha256: readinessAssetSha256,
      });
      await input.afterSchema?.(client);
      return {
        version: 1,
        scope: "auth-schema",
        state: "verified",
        planDigest: plan.planDigest,
        attemptId: previous.id,
        replayed: true,
        beforeSchemaHash: previous.before_hash,
        afterSchemaHash: previous.after_hash,
      };
    }
    await invalidateReadiness(client, plan);
    await client.query(
      `insert into ${history}.plan(digest,target_digest,plan) values($1,$2,$3::jsonb) on conflict(digest) do nothing`,
      [plan.planDigest, plan.targetDigest, JSON.stringify(plan)],
    );
    const attempt = (
      await client.query<{ id: string }>(
        `insert into ${history}.attempt(plan_digest,status,before_hash) values($1,'attempted',$2) returning id::text`,
        [plan.planDigest, await authSchemaHash(client)],
      )
    ).rows[0]!;
    let transaction = false;
    let afterSchemaHash: string | undefined;
    let verificationCommitStarted = false;
    try {
      await client.query(
        `update ${history}.attempt set status='applying',observed_at=now() where id=$1`,
        [attempt.id],
      );
      if (previous?.after_hash) {
        // A committed effect interrupted before verification is inspected, never replayed blindly.
        afterSchemaHash = previous.after_hash;
        await client.query(
          `update ${history}.attempt set after_hash=$2,observed_at=now() where id=$1`,
          [attempt.id, afterSchemaHash],
        );
      } else {
        await client.query("begin");
        transaction = true;
        await client.query("set local lock_timeout='5s'");
        if (input.requireNewEmptyPublicNamespace) await assertEmptyPublicNamespace(client);
        for (const effect of plan.effects)
          if (effect.sql.trim() && effect.sql.trim() !== ";") await client.query(effect.sql);
        afterSchemaHash = await authSchemaHash(client);
        await client.query(
          `update ${history}.attempt set after_hash=$2,observed_at=now() where id=$1`,
          [attempt.id, afterSchemaHash],
        );
        await client.query("commit");
        transaction = false;
      }
      await verifyAuthDesiredSchema(client, input.options);
      if ((await authSchemaHash(client)) !== afterSchemaHash)
        throw new AuthSchemaMigrationError("schema_changed_during_verification");
      const fingerprint = await currentReadinessFingerprint(client, input.resource);
      await client.query("begin");
      transaction = true;
      await client.query(
        `update ${history}.attempt set status='verified',after_hash=$2,readiness_fingerprint=$3,observed_at=now() where id=$1`,
        [attempt.id, afterSchemaHash, fingerprint],
      );
      await publishReadiness(client, plan, fingerprint);
      await verifyAuthSchemaReadiness(client, {
        database: input.resource.database,
        targetDigest: plan.targetDigest,
        assetSha256: readinessAssetSha256,
      });
      // Publish history and its verified runtime fact as one atomic outcome.
      verificationCommitStarted = true;
      await client.query("commit");
      transaction = false;
    } catch (error) {
      if (transaction) await client.query("rollback").catch(() => {});
      // A lost COMMIT acknowledgement does not prove rollback. Preserve the
      // database outcome; a retry reconciles verified or applying history.
      if (verificationCommitStarted)
        throw new AuthSchemaMigrationError("schema_verification_commit_unknown", true);
      const code =
        error instanceof AuthSchemaMigrationError
          ? error.code
          : error &&
              typeof error === "object" &&
              "code" in error &&
              typeof error.code === "string" &&
              /^[A-Z0-9]{5}$/u.test(error.code)
            ? error.code
            : "schema_effect_failed";
      await client
        .query(
          `update ${history}.attempt set status='failed',failure_code=$2,observed_at=now() where id=$1`,
          [attempt.id, code],
        )
        .catch(() => {});
      if (code === "55P03") throw new AuthSchemaMigrationError("schema_lock_contention", true);
      throw new AuthSchemaMigrationError(code);
    }
    await input.afterSchema?.(client);
    return {
      version: 1,
      scope: "auth-schema",
      state: "verified",
      planDigest: plan.planDigest,
      attemptId: attempt.id,
      replayed: Boolean(previous),
      beforeSchemaHash: plan.beforeSchemaHash,
      afterSchemaHash,
    };
  });
}
