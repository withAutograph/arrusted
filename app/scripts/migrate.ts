import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import {
  installGeneratedAppRuntime,
  createGeneratedAppRuntime,
} from "../../packages/generated-app-runtime/server";
import { createDataClient, type DataDefinition } from "../../packages/generated-app-runtime/data";
import { verifyCheckedRelease } from "../../packages/generated-app-runtime/release-verification";
import {
  assertProtectedConnection,
  verifyDatabaseConnection,
  verifyRuntimeRolePrivileges,
  type DatabaseTarget,
} from "../../packages/protected-installer/database-target";
import {
  type RestorePoints,
  type RestorePoint,
  restorePointsFromEnvironment,
} from "./restore-points";

import { migrationLock } from "./migration-lock";
export { migrationLock } from "./migration-lock";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const lockSQL = "select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired";
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const validAuthSchema = /^(?:public|auth_[a-z0-9_]{1,57})$/;
const validIdentifier = /^[a-z][a-z0-9_]{0,62}$/;

type AuthorizationPolicyShape = {
  roles?: Array<{ id: string }>;
  grants?: Array<{
    role: string;
    model: string;
    operations?: string[];
    read_fields?: string[];
  }>;
};
type Artifact = {
  schema: {
    app_id: string;
    customer_id: string;
    version: string;
    models: unknown[];
    authorization?: AuthorizationPolicyShape;
  };
  extras?: {
    authorization_policy?: AuthorizationPolicyShape;
  };
};
function artifactPolicy(artifact: Artifact): AuthorizationPolicyShape | undefined {
  return artifact.extras?.authorization_policy ?? artifact.schema.authorization;
}
export type AppliedSchema = {
  id: string;
  artifact: string;
  schema: Artifact["schema"];
  schema_hash: string;
  release_hash: string;
  auth_hash: string;
  source_commit: string;
  source_dirty: boolean;
  restore_point: RestorePoint;
  applied_at: string;
};
export type MigrationInput = {
  databaseUrl: string;
  releaseDirectory?: string;
  restorePoints?: RestorePoints;
  sourceCommit?: string;
  sourceDirty?: boolean;
  /** Restricted runtime logins; optional passwords provision missing SQL roles. */
  runtimeRole?: string;
  authRole?: string;
  /** PostgreSQL schema owning Better Auth tables for this app (default: 'public', or 'auth_<app>'). */
  authSchema?: string;
  /** CUE authorization role granted to human members of this app (default: 'member'). */
  kernelRole?: string;
  /** Optional explicit path to schema-compiler binary when not bundled next to releaseDirectory. */
  compilerBinary?: string;
  runtimeLogins?: { role: string; password: string }[];
};

function normalizeAuthSchema(authSchema?: string): string {
  const resolved = authSchema ?? "public";
  if (!validAuthSchema.test(resolved)) {
    throw new Error(
      "Invalid authSchema: expected 'public' or an 'auth_<app>' identifier (lowercase alphanumeric/underscore).",
    );
  }
  return resolved;
}

function normalizeKernelRole(
  kernelRole: string | undefined,
  artifact: Artifact,
  hasRuntimeRole: boolean,
): string {
  const resolved = kernelRole ?? "member";
  if (!validIdentifier.test(resolved)) {
    throw new Error("Invalid kernelRole identifier.");
  }
  const declaredRoles = artifactPolicy(artifact)?.roles;
  if (
    (kernelRole !== undefined || hasRuntimeRole) &&
    Array.isArray(declaredRoles) &&
    declaredRoles.length > 0 &&
    !declaredRoles.some((r) => r.id === resolved)
  ) {
    throw new Error(
      `CUE authorization policy does not declare role '${resolved}'. Specify kernelRole (APP_KERNEL_ROLE) matching authorization.roles before migrating.`,
    );
  }
  return resolved;
}

function resolveMigrationCompiler(
  builtRelease: string,
  snapshot: string,
  buildCompilerBinaryHash?: string,
  explicitCompilerBinary?: string,
): { executable: string; prefixArgs: string[]; cwd: string } {
  const stagedAdjacent = path.join(builtRelease, "../schema-compiler");
  if (existsSync(stagedAdjacent)) {
    const compiler = path.join(snapshot, "schema-compiler");
    cpSync(stagedAdjacent, compiler);
    if (buildCompilerBinaryHash && hash(readFileSync(compiler)) !== buildCompilerBinaryHash) {
      throw new Error("The migration compiler differs from the build. Rebuild before migrating.");
    }
    return { executable: compiler, prefixArgs: [], cwd: root };
  }
  if (buildCompilerBinaryHash) {
    throw new Error("The migration compiler differs from the build. Rebuild before migrating.");
  }
  const candidate =
    explicitCompilerBinary ??
    process.env.ARRUSTED_SCHEMA_COMPILER_BIN?.trim() ??
    path.join(root, "target/debug/schema-compiler");
  if (candidate && existsSync(candidate)) {
    return { executable: path.resolve(candidate), prefixArgs: [], cwd: root };
  }
  return {
    executable: "cargo",
    prefixArgs: ["run", "--quiet", "-p", "schema-compiler", "--"],
    cwd: root,
  };
}

function connectionTarget(databaseUrl: string): { url: string; resource: DatabaseTarget } {
  const url = new URL(databaseUrl);
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (local) url.hostname = "127.0.0.1";
  if (!url.searchParams.has("sslmode"))
    url.searchParams.set("sslmode", local ? "disable" : "verify-full");
  const resource: DatabaseTarget = {
    environment: local ? "local" : "production",
    hostname: url.hostname,
    port: Number(url.port || 5432),
    database: decodeURIComponent(url.pathname.slice(1)),
    schema: "public",
    migratorRole: decodeURIComponent(url.username),
    runtimeRole: "unused_runtime",
  };
  assertProtectedConnection(url.toString(), resource, "migrator");
  return { url: url.toString(), resource };
}

/** Bind configured runtime URLs to the same target before selecting their login names. */
export function runtimeRoles(
  databaseUrl: string,
  appUrl?: string,
  authUrl?: string,
): Pick<MigrationInput, "runtimeRole" | "authRole" | "runtimeLogins"> {
  const { resource } = connectionTarget(databaseUrl);
  const role = (value: string) => {
    const normalized = connectionTarget(value);
    const runtimeRole = normalized.resource.migratorRole;
    assertProtectedConnection(normalized.url, { ...resource, runtimeRole }, "runtime");
    if (runtimeRole === resource.migratorRole)
      throw new Error("The application must use a separate unprivileged database login.");
    return runtimeRole;
  };
  const runtimeRole = appUrl ? role(appUrl) : undefined;
  const authRole = authUrl ? role(authUrl) : runtimeRole;
  const runtimeLogins = [
    ...new Set([appUrl, authUrl].filter((url): url is string => Boolean(url))),
  ].map((value) => {
    const url = new URL(value);
    return { role: role(value), password: decodeURIComponent(url.password) };
  });
  return {
    ...(runtimeRole ? { runtimeRole } : {}),
    ...(authRole ? { authRole } : {}),
    runtimeLogins,
  };
}

async function locked<T>(
  input: MigrationInput,
  run: (client: PoolClient, url: string) => Promise<T>,
): Promise<T> {
  const { url, resource } = connectionTarget(input.databaseUrl);
  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await verifyDatabaseConnection(client, resource, "migrator");
    if (!(await client.query(lockSQL, [migrationLock])).rows[0]?.acquired)
      throw new Error("Another migration or undo is running. Wait for it to finish, then retry.");
    return await run(client, url);
  } finally {
    await client
      .query("select pg_advisory_unlock(hashtextextended($1, 0))", [migrationLock])
      .catch(() => {});
    client.release();
    await pool.end();
  }
}

async function records(client: PoolClient): Promise<AppliedSchema[]> {
  if (
    !(await client.query("select to_regclass('public.autograph_applied_schema') as table")).rows[0]
      ?.table
  )
    return [];
  const result = await client.query<AppliedSchema>(
    "select * from autograph_applied_schema order by applied_at, id",
  );
  for (const row of result.rows) {
    if (hash(JSON.stringify(row.schema)) !== row.schema_hash)
      throw new Error(
        "The recorded schema checksum is invalid. Restore the database before migrating.",
      );
    const artifact = JSON.parse(row.artifact) as Artifact;
    // jsonb orders keys itself. Compare through PostgreSQL, not JS property insertion order.
    if (
      !(
        await client.query("select $1::jsonb = $2::jsonb as equal", [
          JSON.stringify(artifact.schema),
          JSON.stringify(row.schema),
        ])
      ).rows[0]?.equal
    )
      throw new Error("The recorded compiler artifact disagrees with the applied schema.");
  }
  return result.rows;
}

async function validateApplied(
  client: PoolClient,
  previous: Pick<AppliedSchema, "schema"> | undefined,
): Promise<void> {
  const exists = (await client.query("select to_regclass('public.schema_revision') as table"))
    .rows[0]?.table;
  if (!previous) {
    if (exists)
      throw new Error(
        "This database has a kernel schema but no applied-schema record. Refusing to guess its history.",
      );
    return;
  }
  if (!exists)
    throw new Error("The applied-schema record exists but the kernel schema is missing.");
  const active = (
    await client.query(
      "select version, schema_hash from schema_revision where app_id=$1 and customer_id=$2 and activated_at is not null",
      [previous.schema.app_id, previous.schema.customer_id],
    )
  ).rows;
  if (active.length !== 1 || active[0]?.version !== previous.schema.version)
    throw new Error("The database active schema disagrees with its applied-schema record.");
  await kernel(client, "kernel_validate_materialized_schema_revision", {
    schema: previous.schema,
    expected_schema_hash: active[0].schema_hash,
  });
}

async function kernel(client: PoolClient, operation: string, request: unknown): Promise<unknown> {
  const result = (
    await client.query(`select ${operation}($1::jsonb) as result`, [JSON.stringify(request)])
  ).rows[0]?.result;
  if (!result?.ok) throw new Error(`${operation}: ${JSON.stringify(result?.error)}`);
  return result.data;
}

function transition(
  release: string,
  applied: AppliedSchema[],
  compiler: { executable: string; prefixArgs: string[]; cwd: string },
): unknown {
  const directory = mkdtempSync(path.join(tmpdir(), "autograph-plan-"));
  try {
    const predecessors = applied
      .map((row, index) => {
        const file = path.join(directory, `${index}.json`);
        writeFileSync(file, row.artifact);
        return ["--previous-compiled-artifact", file];
      })
      .flat();
    const args = ["--compiled-artifact", path.join(release, "app-artifact.json"), ...predecessors];
    return JSON.parse(
      execFileSync(
        compiler.executable,
        [...compiler.prefixArgs, "--schema-transition-contract", ...args],
        {
          cwd: compiler.cwd,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        },
      ),
    );
  } catch (error) {
    const message = (error as { stderr?: Buffer }).stderr?.toString().trim();
    throw new Error(message || "Could not compile the migration plan.", { cause: error });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const authSQL = () => readFileSync(path.join(root, "packages/auth/schema.sql"), "utf8");

// Auth outlives the app ledger on undo. Its owned table (and auth_* namespace when isolated)
// keeps the installed package checksum even when an app migration is undone.
async function validateAuth(client: PoolClient, authHash: string, authSchema: string) {
  const expected = `autograph:auth-schema:${authHash}`;
  if (authSchema === "public") {
    const table = (
      await client.query(`select obj_description(to_regclass('public.user'), 'pg_class') as marker,
      to_regclass('public.user') is not null as exists`)
    ).rows[0];
    if (!table.exists) return false;
    if (table.marker !== expected)
      throw new Error(
        "The retained Auth schema is unknown or changed. An Auth upgrade plan is required; this migration has not changed the database.",
      );
    return true;
  }
  const state = (
    await client.query(
      `select n.oid is not null as schema_exists,
              obj_description(n.oid, 'pg_namespace') as schema_marker,
              to_regclass(format('%I."user"', $1::text)) is not null as table_exists,
              obj_description(to_regclass(format('%I."user"', $1::text)), 'pg_class') as table_marker
         from (select 1) dummy
         left join pg_namespace n on n.nspname = $1`,
      [authSchema],
    )
  ).rows[0];
  if (!state.schema_exists && !state.table_exists) return false;
  if (!state.table_exists || state.schema_marker !== expected || state.table_marker !== expected) {
    throw new Error(
      "The retained Auth schema is unknown or changed. An Auth upgrade plan is required; this migration has not changed the database.",
    );
  }
  return true;
}

async function ensureAndMarkAuth(
  client: PoolClient,
  authSchema: string,
  auth: string,
  authHash: string,
  authExists: boolean,
) {
  if (!authExists) {
    if (authSchema === "public") {
      await client.query(auth);
    } else {
      await client.query(
        `create schema ${quote(authSchema)}; revoke all on schema ${quote(authSchema)} from public`,
      );
      const prev = (await client.query("select current_setting('search_path') as sp")).rows[0].sp;
      await client.query("select set_config('search_path', $1, true)", [
        `${quote(authSchema)}, pg_catalog`,
      ]);
      await client.query(auth);
      await client.query("select set_config('search_path', $1, true)", [prev]);
    }
  }
  // SHA-256 is generated here, never supplied as SQL by the caller.
  if (authSchema !== "public") {
    await client.query(
      `comment on schema ${quote(authSchema)} is 'autograph:auth-schema:${authHash}'`,
    );
  }
  await client.query(
    `comment on table ${quote(authSchema)}."user" is 'autograph:auth-schema:${authHash}'`,
  );
}

export async function migrate(
  input: MigrationInput,
): Promise<{ applied: boolean; schemaHash: string }> {
  const authSchema = normalizeAuthSchema(input.authSchema);
  const builtRelease = input.releaseDirectory ?? path.join(root, "app/.generated/release");
  const snapshot = mkdtempSync(path.join(tmpdir(), "autograph-migrate-"));
  const release = path.join(snapshot, "release");
  try {
    cpSync(builtRelease, release, { recursive: true });
    const manifest = verifyCheckedRelease(release);
    const build = JSON.parse(readFileSync(path.join(builtRelease, "../build.json"), "utf8")) as {
      sourceCommit: string;
      sourceDirty: boolean;
      compilerBinaryHash?: string;
      releaseHash: string;
    };
    const compiler = resolveMigrationCompiler(
      builtRelease,
      snapshot,
      build.compilerBinaryHash,
      input.compilerBinary,
    );
    const sourceCommit = input.sourceCommit ?? build.sourceCommit;
    if (!sourceCommit)
      throw new Error("Build provenance is missing. Compile the schema before migrating.");
    const artifactBytes = readFileSync(path.join(release, "app-artifact.json"), "utf8");
    const artifact = JSON.parse(artifactBytes) as Artifact;
    const kernelRole = normalizeKernelRole(input.kernelRole, artifact, Boolean(input.runtimeRole));
    const releaseHash = hash(readFileSync(path.join(release, "release-manifest.json")));
    if (build.releaseHash !== releaseHash)
      throw new Error(
        "The release and its compiler/provenance are from different builds. Rebuild before migrating.",
      );
    const auth = authSQL();
    const authHash = hash(auth);
    const membership = readFileSync(
      path.join(root, "packages/auth/single-organization-membership.sql"),
      "utf8",
    );
    for (const [name, sql] of [
      ["schema.sql", auth],
      ["single-organization-membership.sql", membership],
    ]) {
      if (manifest.sources[`packages/auth/${name}`] !== `sha256:${hash(sql!)}`)
        throw new Error(
          `The Auth package ${name} differs from the build. Rebuild before migrating.`,
        );
    }
    return await locked(input, async (client, url) => {
      const applied = await records(client);
      const previous = applied.at(-1);
      await validateApplied(client, previous);
      const authExists = await validateAuth(client, authHash, authSchema);
      if (previous?.release_hash === releaseHash && previous.auth_hash === authHash) {
        await client.query("begin");
        try {
          await ensureAndMarkAuth(client, authSchema, auth, authHash, authExists);
          await bindRuntime(client, artifact, input, auth, membership, authSchema, kernelRole);
          await client.query("commit");
        } catch (error) {
          await client.query("rollback");
          throw error;
        }
        return { applied: false, schemaHash: previous.schema_hash };
      }
      if (
        previous &&
        (previous.schema.app_id !== artifact.schema.app_id ||
          previous.schema.customer_id !== artifact.schema.customer_id)
      )
        throw new Error("A deployment cannot change its application or organization identity.");
      if (previous && previous.auth_hash !== authHash)
        throw new Error(
          "The Auth package schema changed. An Auth upgrade plan is required; this migration has not changed the database.",
        );
      const contract = transition(release, applied, compiler);
      // The ledger records applications, including a return to identical source.
      // Only the current release is a retry; its hash need not be unique in history.
      await client.query(`create table if not exists autograph_applied_schema (
      id uuid primary key, artifact text not null, schema jsonb not null, schema_hash text not null,
      release_hash text not null, auth_hash text not null, source_commit text not null,
      source_dirty boolean not null, restore_point jsonb not null, applied_at timestamptz not null default clock_timestamp()
    ); revoke all on autograph_applied_schema from public`);
      const id = randomUUID();
      const restores =
        input.restorePoints ??
        restorePointsFromEnvironment(path.join(root, "app/.local/restore-points"));
      const restorePoint = await restores.create({ databaseUrl: url, id });
      await client.query("begin");
      try {
        await installGeneratedAppRuntime({
          appId: manifest.app,
          customerIds: [artifact.schema.customer_id],
          databaseUrl: url,
          releaseDirectory: release,
          client,
          transitionContract: contract,
        });
        await validateApplied(client, { schema: artifact.schema });
        await ensureAndMarkAuth(client, authSchema, auth, authHash, authExists);
        await bindRuntime(client, artifact, input, auth, membership, authSchema, kernelRole);
        // Hash the normalized jsonb readback, so the stored record and later verification use identical bytes.
        const normalized = (
          await client.query("select $1::jsonb as schema", [JSON.stringify(artifact.schema)])
        ).rows[0].schema;
        const schemaHash = hash(JSON.stringify(normalized));
        await client.query(
          `insert into autograph_applied_schema
        (id,artifact,schema,schema_hash,release_hash,auth_hash,source_commit,source_dirty,restore_point)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            id,
            artifactBytes,
            JSON.stringify(normalized),
            schemaHash,
            releaseHash,
            authHash,
            sourceCommit,
            input.sourceDirty ?? build.sourceDirty ?? false,
            JSON.stringify(restorePoint),
          ],
        );
        await client.query("commit");
        return { applied: true, schemaHash };
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    });
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

async function provisionRuntimeLogin(client: PoolClient, role: string, password: string) {
  const existing = await client.query("select rolname from pg_roles where rolname=$1", [role]);
  if (existing.rows.length) return; // Never reset a live password on rerun.
  if (!validIdentifier.test(role) || password.length < 32)
    throw new Error(
      "Use a simple runtime role name and a generated password of at least 32 characters.",
    );
  const statement = await client.query(
    "select format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS', $1::text, $2::text) as sql",
    [role, password],
  );
  await client.query(statement.rows[0].sql);
}

async function bindRuntime(
  client: PoolClient,
  artifact: Artifact,
  input: MigrationInput,
  auth: string,
  membership: string,
  authSchema: string,
  kernelRole: string,
): Promise<void> {
  const { resource } = connectionTarget(input.databaseUrl);
  for (const login of input.runtimeLogins ?? []) {
    if (![input.runtimeRole, input.authRole].includes(login.role))
      throw new Error("Unexpected runtime login.");
    await provisionRuntimeLogin(client, login.role, login.password);
  }
  const candidateRoles = [
    ...new Set(
      [input.runtimeRole, input.authRole].filter((value): value is string => Boolean(value)),
    ),
  ];
  for (const runtimeRole of candidateRoles) {
    await verifyRuntimeRolePrivileges(client, { ...resource, runtimeRole });
    const triggerConflict = (
      await client.query<{ member_schema: string }>(
        `select ns_rel.nspname as member_schema
           from pg_trigger t
           join pg_class c on c.oid = t.tgrelid
           join pg_namespace ns_rel on ns_rel.oid = c.relnamespace
          where t.tgname = 'autograph_member_kernel'
            and c.relname = 'member'
            and not t.tgisinternal
            and ns_rel.nspname <> $1
            and (string_to_array(encode(t.tgargs, 'escape'), chr(92) || '000'))[1] = $2
          limit 1`,
        [authSchema, runtimeRole],
      )
    ).rows[0];
    if (triggerConflict) {
      throw new Error(
        `Runtime login '${runtimeRole}' is already bound to auth schema '${triggerConflict.member_schema}'. Each app must use its own dedicated database login.`,
      );
    }
    const schemaConflict = (
      await client.query<{ nspname: string }>(
        `select n.nspname
           from pg_namespace n
          where n.nspname <> $1
            and n.nspname ~ '^auth_[a-z0-9_]{1,57}$'
            and coalesce(obj_description(n.oid, 'pg_namespace'), '') ~ '^autograph:auth-schema:[0-9a-f]{64}$'
            and has_schema_privilege($2, n.oid, 'USAGE')
          limit 1`,
        [authSchema, runtimeRole],
      )
    ).rows[0];
    if (schemaConflict) {
      throw new Error(
        `Runtime login '${runtimeRole}' already has access to auth schema '${schemaConflict.nspname}'. Each app must use its own dedicated database login.`,
      );
    }
  }
  if (input.runtimeRole) {
    const privileges = (
      await client.query(
        "select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb from pg_roles where rolname=$1",
        [input.runtimeRole],
      )
    ).rows[0];
    if (!privileges || Object.values(privileges).some(Boolean))
      throw new Error("APP_DATABASE_URL must use an existing unprivileged runtime login.");
    const role = (await client.query("select kernel_installer_capability_role('runtime') as role"))
      .rows[0].role;
    await client.query(`grant ${quote(role)} to ${quote(input.runtimeRole)}`);
    await kernel(client, "kernel_bind_principal_scope", {
      principal_name: input.runtimeRole,
      capability: "runtime",
      app_id: artifact.schema.app_id,
      customer_id: artifact.schema.customer_id,
    });
    await client.query(membership);
    await client.query(
      `create unique index if not exists autograph_member_identity on ${quote(authSchema)}.member ("organizationId", "userId")`,
    );
    const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
    await client.query(`create or replace trigger autograph_member_kernel
      after insert or update or delete on ${quote(authSchema)}.member for each row
      execute function public.autograph_sync_member(${literal(input.runtimeRole)}, ${literal(artifact.schema.app_id)}, ${literal(artifact.schema.customer_id)}, ${literal(kernelRole)})`);
    await client.query(
      `update public.kernel_actor_membership k set active = false
         where k.actor_kind = 'human'
           and k.active = true
           and k.fence_generation = 0
           and k.principal_name = $1::name
           and k.app_id = $2
           and k.customer_id = $3
           and (
             k.role <> $4
             or not exists (
               select 1 from ${quote(authSchema)}.member m
               where m."userId" = k.actor_id and m."organizationId" = k.customer_id
             )
           )`,
      [input.runtimeRole, artifact.schema.app_id, artifact.schema.customer_id, kernelRole],
    );
    await client.query(
      `update ${quote(authSchema)}.member set "userId"="userId" where "organizationId"=$1`,
      [artifact.schema.customer_id],
    );
  }
  if (input.authRole) {
    // Only Better Auth's owned tables in this app's authSchema; never grant direct writes to generated model tables.
    const tables = [...auth.matchAll(/create table "([^"]+)"/gu)].map(
      (match) => `${quote(authSchema)}.${quote(match[1]!)}`,
    );
    await client.query(
      `grant usage on schema ${quote(authSchema)} to ${quote(input.authRole)}; grant select, insert, update, delete on ${tables.join(",")} to ${quote(input.authRole)}`,
    );
  }
}

export async function undo(
  input: MigrationInput,
): Promise<{ sourceCommit: string; sourceDirty: boolean }> {
  return locked(input, async (client, url) => {
    const applied = await records(client);
    const current = applied.at(-1);
    if (!current) throw new Error("There is no migration to undo.");
    if (current.auth_hash !== hash(authSQL()))
      throw new Error(
        "The Auth package differs from the installed version. Use the matching Auth package before undo so all Auth tables are preserved.",
      );
    await validateApplied(client, current);
    const previous = applied.at(-2);
    const restores =
      input.restorePoints ??
      restorePointsFromEnvironment(path.join(root, "app/.local/restore-points"));
    await restores.restore({
      databaseUrl: url,
      point: current.restore_point,
      expectedAppliedId: current.id,
      expectedRestoredHash: previous?.release_hash ?? null,
      // The restoring SQL session must own the lock, including after SIGKILL of
      // this coordinator. Its predecessor check closes the handoff race.
      beforeRestore: async () => {
        await client.query("select pg_advisory_unlock(hashtextextended($1,0))", [migrationLock]);
      },
    });
    return {
      sourceCommit: previous?.source_commit ?? "the schema before its first migration",
      sourceDirty: previous?.source_dirty ?? false,
    };
  });
}

export async function rehearse(
  input: MigrationInput & { runtimeDatabaseUrl: string; productionDatabaseUrl: string },
): Promise<void> {
  const rehearsal = connectionTarget(input.databaseUrl).resource;
  const production = connectionTarget(input.productionDatabaseUrl).resource;
  if (
    rehearsal.hostname === production.hostname &&
    rehearsal.port === production.port &&
    rehearsal.database === production.database
  )
    throw new Error(
      "MIGRATION_DATABASE_URL must not target the production database during rehearsal.",
    );
  const roles = runtimeRoles(input.databaseUrl, input.runtimeDatabaseUrl);
  await migrate({ ...input, ...roles, authRole: input.authRole ?? roles.authRole });
  const releaseDirectory = input.releaseDirectory ?? path.join(root, "app/.generated/release");
  const artifact = JSON.parse(
    readFileSync(path.join(releaseDirectory, "app-artifact.json"), "utf8"),
  ) as Artifact;
  const kernelRole = normalizeKernelRole(input.kernelRole, artifact, true);
  const definition = JSON.parse(
    readFileSync(path.join(releaseDirectory, "operation-manifest.json"), "utf8"),
  ) as DataDefinition;
  const runtime = createGeneratedAppRuntime({
    databaseUrl: input.runtimeDatabaseUrl,
    releaseDirectory,
    appId: artifact.schema.app_id,
    customerId: artifact.schema.customer_id,
  });
  const owner = new Pool({ connectionString: connectionTarget(input.databaseUrl).url });
  const actorId = `rehearsal-${randomUUID()}`;
  try {
    await owner.query(
      `insert into kernel_actor_membership (principal_name,app_id,customer_id,actor_id,role,actor_kind,active,fence_generation)
      values ($1,$2,$3,$4,$5,'human',true,0)`,
      [roles.runtimeRole, artifact.schema.app_id, artifact.schema.customer_id, actorId, kernelRole],
    );
    const operations = createDataClient(
      definition,
      runtime.dataContext({
        actorId,
        sourceKind: "migration-rehearsal",
        authorize: async () => {},
      }),
    );
    const asOf = new Date().toISOString().slice(0, 10);
    const grants = artifactPolicy(artifact)?.grants;
    if (Array.isArray(grants)) {
      const readFieldsByModel = new Map<string, Set<string>>();
      for (const grant of grants) {
        if (grant.role !== kernelRole || !(grant.operations ?? []).includes("read")) continue;
        let allowed = readFieldsByModel.get(grant.model);
        if (!allowed) {
          allowed = new Set();
          readFieldsByModel.set(grant.model, allowed);
        }
        for (const f of grant.read_fields ?? []) allowed.add(f);
      }
      for (const model of Object.values(definition.models)) {
        const allowed = readFieldsByModel.get(model.id);
        if (!allowed || allowed.size === 0) continue;
        const select: string[] = [];
        if (allowed.has("$id")) select.push("id");
        if (allowed.has("$externalKey")) select.push("externalKey");
        if (allowed.has("$version") && definition.capabilities?.versionPreconditions === true) {
          select.push("$version");
        }
        for (const field of model.fields) {
          if (field.lifecycle !== "retired" && allowed.has(field.id)) {
            select.push(field.name);
          }
        }
        if (select.length === 0) continue;
        await operations[model.name]!.list({ asOf, limit: 1, select });
      }
    } else {
      for (const model of Object.values(definition.models)) {
        await operations[model.name]!.list({ asOf, limit: 1 });
      }
    }
  } finally {
    await runtime.close();
    try {
      await owner.query("delete from kernel_actor_membership where actor_id=$1", [actorId]);
    } finally {
      await owner.end();
    }
  }
}

if (import.meta.main) {
  try {
    const command = process.argv[2] ?? "apply";
    const databaseUrl = process.env.MIGRATION_DATABASE_URL;
    if (!databaseUrl) throw new Error("MIGRATION_DATABASE_URL is required.");
    if (["apply", "rehearse"].includes(command) && !process.env.APP_DATABASE_URL?.trim())
      throw new Error("APP_DATABASE_URL is required (separate restricted runtime login).");
    const roles = runtimeRoles(
      databaseUrl,
      process.env.APP_DATABASE_URL,
      process.env.AUTH_DATABASE_URL,
    );
    const authSchema = process.env.AUTH_SCHEMA?.trim() || undefined;
    const kernelRole = process.env.APP_KERNEL_ROLE?.trim() || undefined;
    const input: MigrationInput = {
      databaseUrl,
      ...roles,
      ...(authSchema ? { authSchema } : {}),
      ...(kernelRole ? { kernelRole } : {}),
    };
    if (command === "undo") {
      const result = await undo(input);
      console.log(
        `Database and applied-schema record restored. Revert the schema source to ${result.sourceCommit}.${result.sourceDirty ? " That build included uncommitted schema edits; restore those source files too." : ""}`,
      );
    } else if (command === "rehearse") {
      if (!process.env.PRODUCTION_APP_DATABASE_URL)
        throw new Error("Rehearsal requires PRODUCTION_APP_DATABASE_URL for target isolation.");
      await rehearse({
        ...input,
        runtimeDatabaseUrl: process.env.APP_DATABASE_URL!,
        productionDatabaseUrl: process.env.PRODUCTION_APP_DATABASE_URL,
      });
      console.log("Migration rehearsal and every section list query passed.");
    } else if (command === "apply") {
      const result = await migrate(input);
      console.log(result.applied ? "Migration applied." : "Already applied; no changes.");
    } else throw new Error(`Unknown migration command: ${command}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Migration failed.");
    process.exitCode = 1;
  }
}
