import { productionGate } from "./production-gate";
import { reportError, SafeError } from "./safe-output";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

type Artifact = {
  schema: { app_id: string; customer_id: string; version: string; models: unknown[] };
};
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
  runtimeLogins?: { role: string; password: string }[];
};

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

function transition(release: string, applied: AppliedSchema[], compiler: string): unknown {
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
      execFileSync(compiler, ["--schema-transition-contract", ...args], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
  } catch (error) {
    const message = (error as { stderr?: Buffer }).stderr?.toString().trim();
    throw new Error(message || "Could not compile the migration plan.", { cause: error });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const authSQL = () => readFileSync(path.join(root, "packages/auth/schema.sql"), "utf8");

// Auth outlives the app ledger on undo. Its owned table keeps the installed
// package checksum even when the first app migration is undone.
async function validateAuth(client: PoolClient, authHash: string) {
  const table = (
    await client.query(`select obj_description(to_regclass('public.user'), 'pg_class') as marker,
    to_regclass('public.user') is not null as exists`)
  ).rows[0];
  if (!table.exists) return false;
  const expected = `autograph:auth-schema:${authHash}`;
  if (table.marker !== expected)
    throw new Error(
      "The retained Auth schema is unknown or changed. An Auth upgrade plan is required; this migration has not changed the database.",
    );
  return true;
}
async function markAuth(client: PoolClient, authHash: string) {
  // SHA-256 is generated here, never supplied as SQL by the caller.
  await client.query(`comment on table public."user" is 'autograph:auth-schema:${authHash}'`);
}

export async function migrate(
  input: MigrationInput,
): Promise<{ applied: boolean; schemaHash: string }> {
  const builtRelease = input.releaseDirectory ?? path.join(root, "app/.generated/release");
  const snapshot = mkdtempSync(path.join(tmpdir(), "autograph-migrate-"));
  const release = path.join(snapshot, "release");
  try {
    cpSync(builtRelease, release, { recursive: true });
    const manifest = verifyCheckedRelease(release);
    const build = JSON.parse(readFileSync(path.join(builtRelease, "../build.json"), "utf8")) as {
      sourceCommit: string;
      sourceDirty: boolean;
      compilerBinaryHash: string;
      releaseHash: string;
    };
    const compiler = path.join(snapshot, "schema-compiler");
    cpSync(path.join(builtRelease, "../schema-compiler"), compiler);
    if (hash(readFileSync(compiler)) !== build.compilerBinaryHash)
      throw new Error("The migration compiler differs from the build. Rebuild before migrating.");
    const sourceCommit = input.sourceCommit ?? build.sourceCommit;
    if (!sourceCommit)
      throw new Error("Build provenance is missing. Compile the schema before migrating.");
    const artifactBytes = readFileSync(path.join(release, "app-artifact.json"), "utf8");
    const artifact = JSON.parse(artifactBytes) as Artifact;
    const releaseHash = hash(readFileSync(path.join(release, "release-manifest.json")));
    if (build.releaseHash !== releaseHash)
      throw new Error(
        "The release and its compiler/provenance are from different builds. Rebuild before migrating.",
      );
    const auth = authSQL();
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
      const authExists = await validateAuth(client, hash(auth));
      if (previous?.release_hash === releaseHash && previous.auth_hash === hash(auth)) {
        await client.query("begin");
        try {
          await markAuth(client, hash(auth));
          await bindRuntime(client, artifact, input, auth, membership);
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
      if (previous && previous.auth_hash !== hash(auth))
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
        if (!authExists) await client.query(auth);
        await markAuth(client, hash(auth));
        await bindRuntime(client, artifact, input, auth, membership);
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
            hash(auth),
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
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role) || password.length < 32)
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
): Promise<void> {
  const { resource } = connectionTarget(input.databaseUrl);
  for (const login of input.runtimeLogins ?? []) {
    if (![input.runtimeRole, input.authRole].includes(login.role))
      throw new Error("Unexpected runtime login.");
    await provisionRuntimeLogin(client, login.role, login.password);
  }
  for (const runtimeRole of new Set(
    [input.runtimeRole, input.authRole].filter((value): value is string => Boolean(value)),
  )) {
    await verifyRuntimeRolePrivileges(client, { ...resource, runtimeRole });
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
    // Serve verifies the active release through kernel_read_runtime_release_observability,
    // so the restricted runtime login needs no direct grant on autograph_applied_schema.
    await client.query(`revoke all on autograph_applied_schema from ${quote(input.runtimeRole)}`);
    await kernel(client, "kernel_bind_principal_scope", {
      principal_name: input.runtimeRole,
      capability: "runtime",
      app_id: artifact.schema.app_id,
      customer_id: artifact.schema.customer_id,
    });
    await client.query(membership);
    const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
    await client.query(`create or replace trigger autograph_member_kernel
      after insert or update or delete on public.member for each row
      execute function public.autograph_sync_member(${literal(input.runtimeRole)}, ${literal(artifact.schema.app_id)}, ${literal(artifact.schema.customer_id)})`);
    await client.query('update public.member set "userId"="userId" where "organizationId"=$1', [
      artifact.schema.customer_id,
    ]);
  }
  if (input.authRole) {
    // Only Better Auth's owned tables; never grant direct writes to generated model tables.
    const tables = [...auth.matchAll(/create table "([^"]+)"/gu)].map((match) => quote(match[1]!));
    await client.query(
      `grant usage on schema public to ${quote(input.authRole)}; grant select, insert, update, delete on ${tables.join(",")} to ${quote(input.authRole)}`,
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
    throw new SafeError(
      "MIGRATION_DATABASE_URL must not target the production database during rehearsal.",
    );
  const roles = runtimeRoles(input.databaseUrl, input.runtimeDatabaseUrl);
  await migrate({ ...input, ...roles, authRole: input.authRole ?? roles.authRole });
  const releaseDirectory = input.releaseDirectory ?? path.join(root, "app/.generated/release");
  const artifact = JSON.parse(
    readFileSync(path.join(releaseDirectory, "app-artifact.json"), "utf8"),
  ) as Artifact;
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
      values ($1,$2,$3,$4,'member','human',true,0)`,
      [roles.runtimeRole, artifact.schema.app_id, artifact.schema.customer_id, actorId],
    );
    const operations = createDataClient(
      definition,
      runtime.dataContext({
        actorId,
        sourceKind: "migration-rehearsal",
        authorize: async () => {},
      }),
    );
    for (const model of Object.values(definition.models)) {
      await operations[model.name]!.list({ asOf: new Date().toISOString().slice(0, 10), limit: 1 });
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
  let redactEnv: Record<string, string | undefined> = process.env;
  try {
    const command = process.argv[2] ?? "apply";
    const flags = process.argv.slice(3);
    const allowedFlags = new Set(["--local-only-repo", "--production"]);
    if (flags.some((flag) => !allowedFlags.has(flag)) || new Set(flags).size !== flags.length)
      throw new SafeError("Only --local-only-repo and --production are supported.");
    const production = flags.includes("--production");
    let databaseUrl = process.env.MIGRATION_DATABASE_URL;
    let appUrl = process.env.APP_DATABASE_URL;
    let authUrl = process.env.AUTH_DATABASE_URL;
    if (production) {
      const { existsSync } = await import("node:fs");
      const { ENV_PROD_MIGRATE, ENV_PROD_SECRETS, readEnv } = await import("./local-secrets");
      const appDir = path.join(root, "app");
      const prodSecretsPath = path.join(appDir, ENV_PROD_SECRETS);
      const prodMigratePath = path.join(appDir, ENV_PROD_MIGRATE);
      if (!existsSync(prodMigratePath))
        throw new SafeError(
          `Missing ${ENV_PROD_MIGRATE}. Run bun run setup:env --production and edit it in a local editor first.`,
        );
      const prodRuntime = existsSync(prodSecretsPath) ? readEnv(prodSecretsPath) : {};
      const prodMigrate = readEnv(prodMigratePath);
      redactEnv = { ...process.env, ...prodRuntime, ...prodMigrate };
      databaseUrl = prodMigrate.MIGRATION_DATABASE_URL || undefined;
      appUrl = prodRuntime.APP_DATABASE_URL || undefined;
      authUrl = prodRuntime.AUTH_DATABASE_URL || undefined;
      for (const key of ["NEON_API_KEY", "NEON_PROJECT_ID", "NEON_BRANCH_ID"]) {
        if (prodMigrate[key] && !(key in process.env)) process.env[key] = prodMigrate[key];
      }
    }
    if (!databaseUrl) throw new SafeError("MIGRATION_DATABASE_URL is required.");
    if (["apply", "rehearse"].includes(command) && !appUrl?.trim())
      throw new SafeError("APP_DATABASE_URL is required (separate restricted runtime login).");
    const roles = runtimeRoles(databaseUrl, appUrl, authUrl);
    const input: MigrationInput = { databaseUrl, ...roles };
    if (["apply", "undo"].includes(command)) {
      const { schemaPlan, appliedRelease, compiled } = await import("./release");
      await productionGate(
        databaseUrl,
        async () =>
          command === "undo"
            ? "Restore the last restore point. All later app data edits are lost; current Auth accounts and memberships survive."
            : schemaPlan((await appliedRelease(databaseUrl))?.schema, compiled().schema),
        flags.includes("--local-only-repo"),
      );
    }
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
        runtimeDatabaseUrl: appUrl!,
        productionDatabaseUrl: process.env.PRODUCTION_APP_DATABASE_URL,
      });
      console.log("Migration rehearsal and every section list query passed.");
    } else if (command === "apply") {
      const result = await migrate(input);
      console.log(result.applied ? "Migration applied." : "Already applied; no changes.");
    } else throw new Error(`Unknown migration command: ${command}`);
  } catch (error) {
    reportError(error, "Migration", redactEnv);
    process.exitCode = 1;
  }
}
