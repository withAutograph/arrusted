import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { beforeAll, afterAll, afterEach, expect, test } from "vite-plus/test";
import { Pool } from "pg";
import {
  createAuth,
  createAuthPool,
  createAuthSchemaDefinitionOptions,
} from "../../../../packages/auth/server";
import { bootstrapValidationIdentity } from "../../../../packages/auth/preview-qa";
import { getMigrations } from "better-auth/db/migration";
import type { BetterAuthOptions } from "better-auth";
import {
  verifyAuthDatabaseResource,
  type AuthDatabaseResource,
} from "../../../../packages/auth/database-resource";
import {
  applyAuthSchemaMigration,
  planAuthSchemaMigration,
  assertGeneratedAuthSqlIsAdditive,
  authSchemaHash,
  proposeEmptyAuthSchemaMigration,
  authSchemaDefinition,
  readAuthSchemaMigration,
} from "./auth-schema-history";
import { createAuthSchemaOptions, provisionEnrolledAuthAccess } from "./auth-enrolled-provision";
import {
  AUTH_ACCESS_EFFECT,
  AUTH_PROTECTED_INSTALLER_ID,
  AUTH_SCHEMA_EFFECT,
  AUTH_SCHEMA_ONLY_INSTALLER_ID,
} from "../../../../packages/auth/protected-installer-worker";
import { joinExistingRealmOrganization } from "../../../../packages/auth/owned-organization";
import {
  linkManagedCreatorIdentity,
  updateManagedAppInvitation,
} from "../../../../packages/auth/managed-app-invitations";
import { authDatabaseResourceDigest } from "../../../../packages/auth/signup-policy";
import type { ManagedProductionRealm } from "../../../../packages/auth/public-realm-enrollment";
import { verifyAuthOperatorConnection } from "../../../../packages/protected-installer/auth-operator";

import {
  listManagedAppMembers,
  readManagedAppActorAccess,
  hasManagedAppRecord,
  setManagedFrontendAccess,
} from "../../../../packages/auth/managed-app-access";

test("managed app admission isolates workspaces and final frontend revocation reconciles organization apps", async () => {
  const f = await fixture();
  await install(f);
  await f.pool.query(`insert into public.organization(id,name,slug,"createdAt","appIds") values
    ('dev','Controlled workspace','dev',now(),'["unrelated"]')`);
  await f.pool.query(`insert into public."user"(id,name,email,"emailVerified") values
    ('first','First','first@example.test',true),('second','Second','second@example.test',true)`);
  await f.pool
    .query(`insert into public.member(id,"organizationId","userId",role,"createdAt") values
    ('member-first','dev','first','member',now()),('member-second','dev','second','member',now())`);
  const client = await f.pool.connect();
  const scope = { workspaceId: "workspace", appId: "managed", organizationId: "dev" };
  const grant = {
    ...scope,
    actorId: "first",
    roles: [] as string[],
    active: true,
    fenceGeneration: 1,
  };
  const apps = async () =>
    (await f.pool.query(`select "appIds" from public.organization where id='dev'`)).rows[0].appIds;
  try {
    await setManagedFrontendAccess(client, grant, async () => {});
    expect(await readManagedAppActorAccess(client, { ...scope, actorId: "first" })).toEqual({
      fenceGeneration: 1,
    });
    expect(
      await readManagedAppActorAccess(client, {
        ...scope,
        actorId: "first",
        workspaceId: "other-workspace",
      }),
    ).toBeNull();
    expect(
      await hasManagedAppRecord(client, {
        appId: "managed",
        workspaceId: "other-workspace",
        resourceDigest: "a".repeat(64),
      }),
    ).toBe(false);
    expect(
      await hasManagedAppRecord(client, {
        appId: "managed",
        workspaceId: "workspace",
        resourceDigest: "a".repeat(64),
      }),
    ).toBe(true);

    await f.pool
      .query(`insert into public.app_access_invitation(id,"workspaceId","resourceDigest","appId","organizationId",email,roles,"returnUrl","operationRef","planDigest","scopeDigest","fenceGeneration","expiresAt")
      values('pending-invite','workspace',repeat('a',64),'pending-only','dev','first@example.test','[]','https://apps.example/pending-only','operation',repeat('b',64),repeat('c',64),1,now()+interval '1 hour')`);
    expect(
      await hasManagedAppRecord(client, {
        appId: "pending-only",
        workspaceId: "workspace",
        resourceDigest: "b".repeat(64),
      }),
    ).toBe(false);
    expect(
      await hasManagedAppRecord(client, {
        appId: "pending-only",
        workspaceId: "workspace",
        resourceDigest: "a".repeat(64),
      }),
    ).toBe(true);

    await setManagedFrontendAccess(
      client,
      { ...grant, actorId: "second", roles: ["reader"] },
      async () => {},
    );
    await setManagedFrontendAccess(
      client,
      { ...grant, active: false, fenceGeneration: 2 },
      async () => {},
    );
    expect(await apps()).toContain("managed");
    await setManagedFrontendAccess(
      client,
      { ...grant, actorId: "second", roles: ["reader"], active: false, fenceGeneration: 2 },
      async () => {},
    );
    expect(await apps()).toEqual(["unrelated"]);
    expect(await readManagedAppActorAccess(client, { ...scope, actorId: "first" })).toBeNull();

    await setManagedFrontendAccess(client, { ...grant, fenceGeneration: 3 }, async () => {});
    await f.pool
      .query(`insert into public.app_actor_assignment("organizationId","actorId","appId",role,active,fence_generation)
      values('dev','second','managed','independent',true,3)`);
    await setManagedFrontendAccess(
      client,
      { ...grant, active: false, fenceGeneration: 4 },
      async () => {},
    );
    expect(await apps()).toContain("managed");
    await setManagedFrontendAccess(
      client,
      { ...grant, actorId: "second", roles: ["independent"], active: false, fenceGeneration: 4 },
      async () => {},
    );
    expect(await apps()).toEqual(["unrelated"]);
  } finally {
    client.release();
  }
}, 30_000);

const root = path.resolve(import.meta.dirname, "../../../..");
let directory: string;
let port: number;
let admin: Pool;
let protectedWorkerPath: string;
const password = randomUUID();
const pools: Pool[] = [];
const databases: string[] = [];
function run(binary: string, args: string[]) {
  const result = spawnSync(binary, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Owned PostgreSQL fixture ${binary} failed`);
}
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "auth-schema-history-"));
  const workerDirectory = path.join(directory, "compiled-worker");
  await mkdir(workerDirectory);
  try {
    protectedWorkerPath = await buildProtectedWorker(workerDirectory);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No owned port");
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
  const passwordFile = path.join(directory, "password");
  await writeFile(passwordFile, password, { mode: 0o600 });
  run("initdb", [
    "-D",
    path.join(directory, "postgres"),
    "--username=postgres",
    "--auth=scram-sha-256",
    `--pwfile=${passwordFile}`,
    "--no-locale",
    "--encoding=UTF8",
  ]);
  run("pg_ctl", [
    "-D",
    path.join(directory, "postgres"),
    "-l",
    path.join(directory, "postgres.log"),
    "-o",
    `-h 127.0.0.1 -p ${port} -k ${directory}`,
    "-w",
    "start",
  ]);
  admin = new Pool({
    connectionString: `postgres://postgres:${password}@127.0.0.1:${port}/postgres?sslmode=disable`,
  });
  await admin.query(
    `create role auth_migrator login password '${password}';create role auth_runtime login password '${password}';create role auth_operator login password '${password}'`,
  );
}, 30_000);
async function awaitOwnedBackendClosure(
  readRemaining: () => Promise<number>,
  deadline: number,
  now = () => performance.now(),
  pause = () => new Promise<void>((resolve) => setTimeout(resolve, 10)),
) {
  // pg-pool ends local sockets before PostgreSQL necessarily removes their
  // backend entries. Observe server-side closure before ordinary DROP.
  let remaining = await readRemaining();
  while (remaining !== 0 && now() < deadline) {
    await pause();
    remaining = await readRemaining();
  }
  expect(remaining, "Owned PostgreSQL fixture backends did not close").toBe(0);
}
async function disposeTestDatabases() {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
  // One shared observation budget leaves room inside the existing 30s hook;
  // a live leaked connection still fails rather than being force-terminated.
  const deadline = performance.now() + 10_000;
  if (admin)
    while (databases.length > 0) {
      await awaitOwnedBackendClosure(async () => {
        const active = await admin.query(
          "select count(*)::int as count from pg_stat_activity where datname=$1",
          [databases[0]],
        );
        return active.rows[0].count;
      }, deadline);
      await admin.query(`drop database if exists "${databases[0]}"`);
      databases.shift();
    }
}
test("owned database cleanup observes delayed backend closure and rejects a live leak", async () => {
  let clock = 0;
  let reads = 0;
  const remaining = [3, 1, 0];
  const pause = async () => {
    clock += 10;
  };
  await awaitOwnedBackendClosure(
    async () => remaining[reads++]!,
    100,
    () => clock,
    pause,
  );
  expect(reads).toBe(3);
  await expect(
    awaitOwnedBackendClosure(
      async () => 1,
      clock + 20,
      () => clock,
      pause,
    ),
  ).rejects.toThrow("Owned PostgreSQL fixture backends did not close");
});

afterEach(disposeTestDatabases, 30_000);
afterAll(async () => {
  try {
    await disposeTestDatabases();
    if (admin) await admin.end();
  } finally {
    if (directory) {
      if (existsSync(path.join(directory, "postgres", "postmaster.pid")))
        run("pg_ctl", ["-D", path.join(directory, "postgres"), "-m", "fast", "-w", "stop"]);
      await rm(directory, { recursive: true, force: true });
    }
  }
}, 30_000);
function ownedAuth(
  options: Parameters<typeof createAuth>[0] & { env: { PLATFORM_AUTH_DATABASE_URL: string } },
  resource: AuthDatabaseResource,
) {
  // Own the original pool directly: package resolution can load distinct pg
  // constructors, so auth.options.database instanceof Pool is not an ownership test.
  const pool = createAuthPool(
    options.env.PLATFORM_AUTH_DATABASE_URL,
    resource,
    options.databasePurpose,
  );
  pools.push(pool);
  return { auth: createAuth({ ...options, databaseOverride: pool }), pool };
}
async function fixture() {
  const database = `history_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  databases.push(database);
  await admin.query(`create database "${database}" owner auth_migrator`);
  const resource: AuthDatabaseResource = {
    version: 1,
    environment: "local",
    hostname: "127.0.0.1",
    port,
    database,
    schema: "public",
    runtimeRole: "auth_runtime",
    migratorRole: "auth_migrator",
  };
  const connection = `postgres://auth_migrator:${password}@127.0.0.1:${port}/${database}?sslmode=disable`;
  const env = {
    AUTH_DATABASE_RESOURCE: JSON.stringify(resource),
    PLATFORM_AUTH_DATABASE_URL: connection,
    BETTER_AUTH_URL: "http://localhost:3000",
    BETTER_AUTH_SECRET: randomUUID(),
  };
  const { auth, pool: authPool } = ownedAuth(
    { appName: "Autograph", databasePurpose: "migrator", env },
    resource,
  );
  const pool = new Pool({ connectionString: connection, max: 4 });
  pools.push(pool);
  await pool.query("revoke create on schema public from public");
  return {
    pool,
    authPool,
    resource,
    options: auth.options as BetterAuthOptions,
    // Historical app IDs are test-owned access fixtures, not deployed applications.
    catalogAppIds: ["hc", "vendor", "integrations"],
    auth,
    env,
    connection,
  };
}
async function install(f: Awaited<ReturnType<typeof fixture>>) {
  const plan = await planAuthSchemaMigration(f);
  const receipt = await applyAuthSchemaMigration({ ...f, approvedDigest: plan.planDigest });
  // The plan's Better Auth instance inspected the empty database. Use a fresh
  // runtime instance so its schema cache reflects the installed tables.
  const fresh = ownedAuth(
    { appName: "Autograph", databasePurpose: "migrator", env: f.env },
    f.resource,
  );
  f.auth = fresh.auth;
  f.authPool = fresh.pool;
  return { plan, receipt };
}
async function seed(f: Awaited<ReturnType<typeof fixture>>, actorId = "schema_actor") {
  const adapter = (await f.auth.$context).adapter;
  await bootstrapValidationIdentity({
    adapter: {
      findOne: (input) => adapter.findOne<Record<string, unknown>>(input),
      create: (input) => adapter.create<Record<string, unknown>>(input),
      update: async (input) => {
        const value = await adapter.update<Record<string, unknown>>(input);
        if (!value) throw new Error("Missing synthetic actor");
        return value;
      },
    },
    identity: {
      actorId,
      email: `${actorId}@example.test`,
      organizationId: "schema_team",
      organizationName: "Schema fixtures",
      applicationIds: ["hc"],
      password,
    },
  });
}

// Ready-path existence is the consumer's completeness signal. Publish private
// bytes immutably only after their temporary file has been fully written.
function publishFixtureReplyJson(
  file: string,
  value: unknown,
  beforePublish?: (temporary: string) => void,
) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    beforePublish?.(temporary);
    linkSync(temporary, file);
  } finally {
    unlinkSync(temporary);
  }
}

test("fixture reply publication exposes complete immutable frames without a partial ready marker", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "auth-reply-publication-"));
  const file = path.join(temporary, "reply.ready");
  const marker = { version: 1, run_id: "fixture-run", frame_id: 2 };
  try {
    publishFixtureReplyJson(file, marker, (pending) => {
      expect(existsSync(file)).toBe(false);
      expect(JSON.parse(readFileSync(pending, "utf8"))).toEqual(marker);
    });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(marker);
    expect(() => publishFixtureReplyJson(file, { ...marker, frame_id: 3 })).toThrow();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(marker);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

async function runProtectedWorker(
  f: Awaited<ReturnType<typeof fixture>>,
  plan: Awaited<ReturnType<typeof planAuthSchemaMigration>>,
  workerPath: string,
  options: {
    interruptAfterSchemaCommit?: boolean;
    newEmptyProposal?: boolean;
    protectedSchemaOnly?: boolean;
    schemaReadback?: boolean;
    omitOwnerPlan?: boolean;
    signal?: AbortSignal;
  } = {},
) {
  options.signal?.throwIfAborted();
  const directory = await mkdtemp(path.join(tmpdir(), "auth-protected-worker-"));
  const spool = path.join(directory, "spool");
  const runId = randomUUID();
  const startup = path.join(spool, "startup");
  for (const entry of [startup, path.join(spool, "requests"), path.join(spool, "responses")])
    await mkdir(entry, { recursive: true, mode: 0o700 });
  const context = {
    version: 1,
    operation: {
      operation_id: randomUUID(),
      approval_digest: "a".repeat(64),
      fence_generation: 1,
    },
    app_id: "auth",
    resource: {
      resource_id: "owned-auth-resource",
      environment: f.resource.environment,
      hostname: f.resource.hostname,
      port: f.resource.port,
      database: f.resource.database,
      schema: f.resource.schema,
      migrator_role: f.resource.migratorRole,
      runtime_role: f.resource.runtimeRole,
    },
    release: { id: plan.targetDigest, sha256: plan.planDigest },
    installer: { id: AUTH_PROTECTED_INSTALLER_ID, sha256: "b".repeat(64) },
    tenant_targets: [] as string[],
  };
  if (options.protectedSchemaOnly || options.schemaReadback) {
    const operatorPlan = {
      version: 1,
      action: "prepare",
      authDatabase: {
        resourceId: context.resource.resource_id,
        database: f.resource.database,
        migratorRole: f.resource.migratorRole,
        runtimeRole: f.resource.runtimeRole,
      },
      authSchema: {
        planDigest: plan.planDigest,
        targetDigest: plan.targetDigest,
        ...(plan.authOperatorRole === undefined ? {} : { authOperatorRole: plan.authOperatorRole }),
      },
      neon: { endpoint: f.resource.hostname },
    };
    const canonical = (value: unknown): string => {
      if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
      if (value !== null && typeof value === "object")
        return `{${Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
          .join(",")}}`;
      return JSON.stringify(value);
    };
    context.operation.approval_digest = createHash("sha256")
      .update(canonical(operatorPlan))
      .digest("hex");
    context.installer.id = AUTH_SCHEMA_ONLY_INSTALLER_ID;
    if (!options.omitOwnerPlan)
      await writeFile(path.join(startup, "operator-plan.json"), JSON.stringify(operatorPlan), {
        mode: 0o600,
      });
  }
  await writeFile(path.join(startup, "context.json"), JSON.stringify(context), { mode: 0o600 });
  await writeFile(path.join(startup, "direct-database-url.json"), JSON.stringify(f.connection), {
    mode: 0o600,
  });
  await writeFile(
    path.join(startup, "auth-schema-plan.json"),
    JSON.stringify({
      version: 1,
      resource: f.resource,
      schemaPlan: plan,
      ...(options.newEmptyProposal ? { proposal: "new-empty" } : {}),
    }),
    { mode: 0o600 },
  );
  await writeFile(
    path.join(startup, "ready.json"),
    JSON.stringify({ version: 1, run_id: runId, frame_id: 0 }),
    { mode: 0o600 },
  );
  const requests: Array<{ kind: string; effect_id: string; sequence: number }> = [];
  const lifecycle: string[] = [];
  let ownedChild: ReturnType<typeof spawn> | undefined;
  let childClosed: Promise<void> | undefined;
  try {
    const child = spawn(
      workerPath,
      [
        options.schemaReadback
          ? "auth-protected-schema-readback"
          : options.protectedSchemaOnly
            ? "auth-protected-schema"
            : "auth-protected-migrate",
        "--file-spool",
        spool,
        runId,
        "5000",
      ],
      {
        cwd: spool,
        env: { PATH: process.env.PATH ?? "", TMPDIR: spool },
        stdio: ["ignore", "pipe", "pipe"],
        signal: options.signal,
        killSignal: "SIGKILL",
      },
    );
    ownedChild = child;
    childClosed = new Promise((resolve) => child.once("close", () => resolve()));
    let noticeBuffer = "";
    let stderrBuffer = "";
    let relayFailure: Error | undefined;
    let interruptedAfterSchemaCommit = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrBuffer += chunk;
    });
    child.stdout.on("data", (chunk: string) => {
      noticeBuffer += chunk;
      for (;;) {
        const newline = noticeBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = noticeBuffer.slice(0, newline);
        noticeBuffer = noticeBuffer.slice(newline + 1);
        try {
          const notice = JSON.parse(line) as { kind: string; frame_id: number };
          if (notice.kind === "protected_installer_frame_ready") {
            const request = JSON.parse(
              readFileSync(path.join(spool, "requests", `${notice.frame_id}.json`), "utf8"),
            ) as {
              kind: string;
              operation_id: string;
              context_digest: string;
              fence_generation: number;
              sequence: number;
              effect_id: string;
            };
            requests.push(request);
            if (
              options.interruptAfterSchemaCommit &&
              request.kind === "checkpoint_effect" &&
              request.effect_id === AUTH_SCHEMA_EFFECT
            ) {
              interruptedAfterSchemaCommit = true;
              child.kill("SIGKILL");
              return;
            }
            const response =
              request.kind === "check_fence"
                ? {
                    kind: "fence_current",
                    version: 1,
                    operation_id: request.operation_id,
                    context_digest: request.context_digest,
                    fence_generation: request.fence_generation,
                    current: true,
                  }
                : request.kind === "authorize_effect"
                  ? {
                      kind: "effect_authorized",
                      version: 1,
                      operation_id: request.operation_id,
                      context_digest: request.context_digest,
                      fence_generation: request.fence_generation,
                      sequence: request.sequence,
                      effect_id: request.effect_id,
                      allowed: [AUTH_SCHEMA_EFFECT, AUTH_ACCESS_EFFECT].includes(request.effect_id),
                    }
                  : {
                      kind: "checkpoint_recorded",
                      version: 1,
                      operation_id: request.operation_id,
                      context_digest: request.context_digest,
                      fence_generation: request.fence_generation,
                      sequence: request.sequence,
                      effect_id: request.effect_id,
                      recorded: true,
                    };
            publishFixtureReplyJson(
              path.join(spool, "responses", `${notice.frame_id}.json`),
              response,
            );
            publishFixtureReplyJson(path.join(spool, "responses", `${notice.frame_id}.ready`), {
              version: 1,
              run_id: runId,
              frame_id: notice.frame_id,
            });
          } else if (notice.kind === "protected_installer_lifecycle_ready") {
            const fact = JSON.parse(
              readFileSync(path.join(spool, "lifecycle", `${notice.frame_id}.json`), "utf8"),
            ) as { kind: string };
            lifecycle.push(fact.kind);
          }
        } catch (error) {
          relayFailure = error as Error;
          child.kill("SIGKILL");
        }
      }
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (relayFailure) throw new Error("Protected Auth worker relay failed");
    if (interruptedAfterSchemaCommit) {
      expect(exitCode).toBeNull();
      expect(lifecycle).toEqual(["worker_started"]);
      return;
    }
    if (exitCode !== 0) {
      const safeFailure = stderrBuffer.match(/Auth protected installer failed: [a-z_]+/u)?.[0];
      const readbackFailure = stderrBuffer.match(
        /Protected Auth (?:schema|access) readback failed: [a-z_]+/u,
      )?.[0];
      throw new Error(
        `Protected Auth worker exited ${String(exitCode)} (${safeFailure ?? "unknown"}; ${readbackFailure ?? "no readback category"})`,
      );
    }
    expect(noticeBuffer).toBe("");
    if (options.schemaReadback) {
      expect(requests.map((request) => request.kind)).toEqual(["check_fence", "check_fence"]);
      expect(lifecycle).toEqual(["worker_started", "worker_succeeded"]);
      const readback = JSON.parse(readFileSync(path.join(spool, "readback.json"), "utf8")) as {
        version: number;
        operation_id: string;
        context_digest: string;
        fence_generation: number;
        status: string;
        readback_sha256: string;
      };
      expect(readback).toMatchObject({
        version: 1,
        operation_id: context.operation.operation_id,
        fence_generation: context.operation.fence_generation,
        status: "applied",
      });
      expect(readback.context_digest).toMatch(/^[a-f0-9]{64}$/u);
      expect(readback.readback_sha256).toMatch(/^[a-f0-9]{64}$/u);
      return readback;
    }
    if (options.protectedSchemaOnly) {
      expect(requests.map((request) => request.kind)).toEqual([
        "authorize_effect",
        "checkpoint_effect",
      ]);
      expect(requests.map((request) => request.effect_id)).toEqual([
        AUTH_SCHEMA_EFFECT,
        AUTH_SCHEMA_EFFECT,
      ]);
      expect(lifecycle).toEqual(["worker_started", "worker_succeeded"]);
      return;
    }
    expect(requests.map((request) => request.kind)).toEqual([
      "authorize_effect",
      "checkpoint_effect",
      "authorize_effect",
      "checkpoint_effect",
    ]);
    expect(requests.map((request) => request.effect_id)).toEqual([
      AUTH_SCHEMA_EFFECT,
      AUTH_SCHEMA_EFFECT,
      AUTH_ACCESS_EFFECT,
      AUTH_ACCESS_EFFECT,
    ]);
    expect(requests.map((request) => request.sequence)).toEqual([1, 1, 2, 2]);
    expect(lifecycle).toEqual(["worker_started", "worker_succeeded"]);
    return;
  } finally {
    if (ownedChild && ownedChild.exitCode === null && ownedChild.signalCode === null)
      ownedChild.kill("SIGKILL");
    await childClosed;
    await rm(directory, { recursive: true, force: true });
  }
}

test("schema readback reconciles a lost coordinator checkpoint without effects", async () => {
  const f = await fixture();
  const input = {
    ...f,
    options: createAuthSchemaOptions(f.pool),
  };
  const plan = await planAuthSchemaMigration(input);
  await runProtectedWorker(f, plan, protectedWorkerPath, {
    protectedSchemaOnly: true,
    interruptAfterSchemaCommit: true,
  });
  await f.pool.query(`insert into public."user"(id,name,email,"emailVerified")
    values('retained-actor','Retained actor','retained@example.test',true)`);
  const snapshot = async () => {
    const client = await f.pool.connect();
    let schema: string;
    try {
      schema = await authSchemaHash(client);
    } finally {
      client.release();
    }
    return {
      schema,
      history: (
        await f.pool.query(
          `select to_jsonb(a) value from _auth_schema_history.attempt a order by id`,
        )
      ).rows,
      plans: (
        await f.pool.query(
          `select to_jsonb(p) value from _auth_schema_history.plan p order by digest`,
        )
      ).rows,
      publication: (
        await f.pool.query(`select to_jsonb(r) value from _auth_schema_readiness.current_target r`)
      ).rows,
      actors: (await f.pool.query(`select to_jsonb(u) value from public."user" u order by id`))
        .rows,
      sessions: (await f.pool.query(`select to_jsonb(s) value from public.session s order by id`))
        .rows,
      memberships: (await f.pool.query(`select to_jsonb(m) value from public.member m order by id`))
        .rows,
    };
  };
  const before = await snapshot();
  const proof = await runProtectedWorker(f, plan, protectedWorkerPath, { schemaReadback: true });
  expect(proof?.status).toBe("applied");
  expect(await snapshot()).toEqual(before);
  const readonlyPool = new Pool({
    connectionString: f.connection,
    max: 2,
    options: "-c default_transaction_read_only=on",
  });
  try {
    const observed = await readAuthSchemaMigration({
      ...input,
      pool: readonlyPool,
      options: createAuthSchemaOptions(readonlyPool),
      approvedPlan: plan,
      approvedDigest: plan.planDigest,
    });
    expect(observed).toMatchObject({ state: "verified", planDigest: plan.planDigest });
    await expect(
      readonlyPool.query("create table public.readback_must_not_write(id text)"),
    ).rejects.toMatchObject({ code: "25006" });
  } finally {
    await readonlyPool.end();
  }
  expect(await snapshot()).toEqual(before);
}, 30_000);

test("schema readback rejects changed approval scope, incomplete history and ACL drift without repair", async () => {
  const f = await fixture();
  const input = {
    ...f,
    options: createAuthSchemaOptions(f.pool),
  };
  const plan = await planAuthSchemaMigration(input);
  const read = (changes: Partial<Parameters<typeof readAuthSchemaMigration>[0]> = {}) =>
    readAuthSchemaMigration({
      ...input,
      approvedPlan: plan,
      approvedDigest: plan.planDigest,
      ...changes,
    });
  await expect(read()).rejects.toMatchObject({ code: "schema_readback_not_verified" });
  expect(
    (await f.pool.query("select to_regnamespace('_auth_schema_history') as history")).rows[0]
      .history,
  ).toBeNull();
  await applyAuthSchemaMigration({ ...input, approvedDigest: plan.planDigest });
  await expect(read({ resource: { ...f.resource, database: "other_auth" } })).rejects.toMatchObject(
    { code: "schema_readback_plan_mismatch" },
  );
  await expect(read({ authOperatorRole: "other_operator" })).rejects.toMatchObject({
    code: "schema_readback_plan_mismatch",
  });
  await expect(
    read({ catalogAppIds: [...plan.catalogAppIds, "different-app"] }),
  ).rejects.toMatchObject({ code: "schema_readback_plan_mismatch" });
  await expect(read({ approvedDigest: "0".repeat(64) })).rejects.toMatchObject({
    code: "schema_readback_plan_mismatch",
  });
  const { planDigest: _digest, ...body } = plan;
  const changedBody = {
    ...body,
    effects: body.effects.map((effect, index) =>
      index === 0 ? { ...effect, sql: `${effect.sql}\n-- different reviewed input` } : effect,
    ),
  };
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object")
      return `{${Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
        .join(",")}}`;
    return JSON.stringify(value);
  };
  const changedPlan = {
    ...changedBody,
    planDigest: createHash("sha256").update(canonical(changedBody)).digest("hex"),
  };
  await expect(
    read({ approvedPlan: changedPlan, approvedDigest: changedPlan.planDigest }),
  ).rejects.toMatchObject({ code: "schema_readback_not_verified" });
  await expect(
    runProtectedWorker(f, changedPlan, protectedWorkerPath, { schemaReadback: true }),
  ).rejects.toThrow("readback_unknown");
  await expect(
    runProtectedWorker(f, plan, protectedWorkerPath, { schemaReadback: true, omitOwnerPlan: true }),
  ).rejects.toThrow("startup_rejected");
  await f.pool.query("update _auth_schema_history.attempt set status='applying'");
  await expect(read()).rejects.toMatchObject({ code: "schema_readback_not_verified" });
  expect((await f.pool.query("select status from _auth_schema_history.attempt")).rows).toEqual([
    { status: "applying" },
  ]);
  await f.pool.query("update _auth_schema_history.attempt set status='verified'");
  await f.pool.query('grant delete on public."user" to auth_runtime');
  await expect(
    runProtectedWorker(f, plan, protectedWorkerPath, { schemaReadback: true }),
  ).rejects.toThrow("readback_unknown");
  expect(
    (
      await f.pool.query(
        `select has_table_privilege('auth_runtime','public.user','DELETE') as granted`,
      )
    ).rows[0].granted,
  ).toBe(true);
  expect(
    (await f.pool.query("select count(*)::int as attempts from _auth_schema_history.attempt"))
      .rows[0].attempts,
  ).toBe(1);
}, 30_000);

test("schema readback preserves the original Production operator-role approval", async () => {
  const f = await fixture();
  // Exercise the Production schema profile with owned local transport, as the
  // existing operator-profile tests do; this is not hosted endpoint proof.
  const input = {
    ...f,
    resource: { ...f.resource, environment: "production" as const },
    options: createAuthSchemaOptions(f.pool),
    authOperatorRole: "auth_operator",
  };
  const plan = await planAuthSchemaMigration(input);
  await admin.query(
    "grant auth_operator to auth_migrator with admin true, inherit false, set false",
  );
  try {
    await applyAuthSchemaMigration({ ...input, approvedDigest: plan.planDigest });
  } finally {
    await admin.query("revoke auth_operator from auth_migrator");
  }
  const observed = await readAuthSchemaMigration({
    ...input,
    approvedPlan: plan,
    approvedDigest: plan.planDigest,
  });
  expect(observed).toMatchObject({ state: "verified", planDigest: plan.planDigest });
  await expect(
    readAuthSchemaMigration({
      ...input,
      authOperatorRole: undefined,
      approvedPlan: plan,
      approvedDigest: plan.planDigest,
    }),
  ).rejects.toMatchObject({ code: "schema_readback_plan_mismatch" });
  await expect(
    readAuthSchemaMigration({
      ...input,
      authOperatorRole: "different_operator",
      approvedPlan: plan,
      approvedDigest: plan.planDigest,
    }),
  ).rejects.toMatchObject({ code: "schema_readback_plan_mismatch" });
}, 30_000);

async function buildProtectedWorker(directory: string): Promise<string> {
  const bundled = spawnSync(
    "bun",
    [path.join(root, ".config/mise/scripts/repository/build-protected-auth-worker.mjs"), directory],
    {
      cwd: root,
      env: { PATH: process.env.PATH ?? "", TMPDIR: directory },
      encoding: "utf8",
    },
  );
  if (bundled.status !== 0) throw new Error("Protected Auth worker bundle failed");
  const workerPath = path.join(directory, "auth-protected-migrate");
  const result = spawnSync(
    "bun",
    [
      "build",
      "--compile",
      path.join(directory, "protected-installer-worker.js"),
      "--outfile",
      workerPath,
    ],
    {
      cwd: root,
      env: { PATH: process.env.PATH ?? "", TMPDIR: directory },
      encoding: "utf8",
    },
  );
  if (result.status !== 0)
    throw new Error(`Protected Auth worker compile failed (${result.status})`);
  return workerPath;
}

test("fixed protected Auth worker applies reviewed schema and preserves live identity and grants", async ({
  signal,
}) => {
  const workerPath = protectedWorkerPath;
  for (const sql of [
    "create type public.marker as enum ('x')",
    "create function public.marker() returns integer language sql as 'select 1'",
  ]) {
    const occupied = await fixture();
    const proposal = await proposeEmptyAuthSchemaMigration({
      resource: occupied.resource,
      catalogAppIds: occupied.catalogAppIds,
    });
    await occupied.pool.query(sql);
    await expect(
      runProtectedWorker(occupied, proposal.schemaPlan, workerPath, {
        newEmptyProposal: true,
        signal,
      }),
    ).rejects.toThrow();
    expect(
      (await occupied.pool.query("select to_regclass('public.user') relation")).rows[0].relation,
    ).toBeNull();
    for (const pool of [occupied.pool, occupied.authPool]) {
      pools.splice(pools.indexOf(pool), 1);
      await pool.end();
    }
  }
  const fresh = await fixture();
  const freshModel = createAuthSchemaOptions(fresh.pool);
  const freshPlan = (
    await proposeEmptyAuthSchemaMigration({
      resource: fresh.resource,
      catalogAppIds: fresh.catalogAppIds,
    })
  ).schemaPlan;
  expect(freshPlan).toEqual(await planAuthSchemaMigration({ ...fresh, options: freshModel }));
  await runProtectedWorker(fresh, freshPlan!, workerPath, {
    interruptAfterSchemaCommit: true,
    newEmptyProposal: true,
    signal,
  });
  expect(
    (
      await fresh.pool.query(
        `select status from "_auth_schema_history".attempt where plan_digest=$1`,
        [freshPlan!.planDigest],
      )
    ).rows,
  ).toEqual([{ status: "verified" }]);
  await runProtectedWorker(fresh, freshPlan!, workerPath, { signal });
  expect(
    (
      await fresh.pool.query(
        `select status from "_auth_schema_history".attempt where plan_digest=$1`,
        [freshPlan!.planDigest],
      )
    ).rows,
  ).toEqual([{ status: "verified" }]);

  const enrolled = await fixture();
  await install(enrolled);
  await seed(enrolled, "protected_actor");
  const signed = await enrolled.auth.api.signInEmail({
    body: { email: "protected_actor@example.test", password },
    headers: new Headers({ origin: enrolled.env.BETTER_AUTH_URL, host: "localhost:3000" }),
    returnHeaders: true,
  });
  const headers = new Headers({
    origin: enrolled.env.BETTER_AUTH_URL,
    host: "localhost:3000",
    cookie: signed.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";", 1)[0])
      .join("; "),
  });
  const userBefore = (await enrolled.pool.query(`select id,name,email from "user" order by id`))
    .rows;
  const accountBefore = (
    await enrolled.pool.query(`select id,"userId","accountId",password from "account" order by id`)
  ).rows;
  const sessionBefore = (
    await enrolled.pool.query(
      `select id,"userId",token,"activeOrganizationId" from "session" where "userId"='protected_actor' order by id`,
    )
  ).rows;
  const memberBefore = (
    await enrolled.pool.query(
      `select id,"organizationId","userId",role from "member" where "userId"='protected_actor' order by id`,
    )
  ).rows;
  await enrolled.pool.query(
    `insert into "organization" (id,name,slug,"createdAt","appIds")
       values ('demo','Legacy Vendor','vendor',now(),'["vendor","sibling-app"]'::jsonb)`,
  );
  await enrolled.pool.query(
    `update "member" set "organizationId"='demo' where "userId"='protected_actor'`,
  );
  await enrolled.pool.query(
    `update "session" set "activeOrganizationId"='demo' where "userId"='protected_actor'`,
  );
  await enrolled.pool.query(
    `insert into "app_actor_assignment" ("organizationId","actorId","appId","role")
     values ('demo','protected_actor','vendor','member')`,
  );
  const assignmentBefore = (
    await enrolled.pool.query(
      `select "organizationId","actorId","appId","role",active,"fence_generation"
       from "app_actor_assignment" where "actorId"='protected_actor'`,
    )
  ).rows;
  expect(userBefore.some((row) => row.id === "protected_actor")).toBe(true);
  expect(accountBefore.some((row) => row.userId === "protected_actor" && row.password)).toBe(true);
  expect(sessionBefore.length).toBeGreaterThan(0);
  expect(memberBefore.length).toBeGreaterThan(0);
  expect(assignmentBefore).toHaveLength(1);
  const enrolledModel = createAuthSchemaOptions(enrolled.pool);
  const enrolledPlan = await planAuthSchemaMigration({ ...enrolled, options: enrolledModel });
  await runProtectedWorker(enrolled, enrolledPlan!, workerPath, { signal });

  expect((await enrolled.pool.query(`select id,name,email from "user" order by id`)).rows).toEqual(
    userBefore,
  );
  expect(
    (
      await enrolled.pool.query(
        `select id,"userId","accountId",password from "account" order by id`,
      )
    ).rows,
  ).toEqual(accountBefore);
  expect(
    (
      await enrolled.pool.query(
        `select id,"userId",token,"activeOrganizationId" from "session" where "userId"='protected_actor' order by id`,
      )
    ).rows,
  ).toEqual(
    sessionBefore.map((row) => ({
      ...row,
      activeOrganizationId: row.activeOrganizationId ? "vendor" : null,
    })),
  );
  expect(
    (
      await enrolled.pool.query(
        `select id,"organizationId","userId",role from "member" where "userId"='protected_actor' order by id`,
      )
    ).rows,
  ).toEqual(memberBefore.map((row) => ({ ...row, organizationId: "vendor" })));
  expect(
    (
      await enrolled.pool.query(
        `select "organizationId","actorId","appId","role",active,"fence_generation"
         from "app_actor_assignment" where "actorId"='protected_actor'`,
      )
    ).rows,
  ).toEqual(
    assignmentBefore.map((row) => ({ ...row, organizationId: "vendor", fence_generation: "0" })),
  );
  expect(
    (await enrolled.pool.query(`select "appIds" from "organization" where id='vendor'`)).rows[0]
      ?.appIds,
  ).toEqual(expect.arrayContaining(["vendor", "sibling-app"]));
  expect((await enrolled.auth.api.getSession({ headers }))?.user.id).toBe("protected_actor");
}, 30_000);

test("produces and applies signup policy schema for empty and enrolled Auth resources", async () => {
  const f = await fixture();
  const catalogAppIds = ["signup-fixture"];
  const input = { ...f, catalogAppIds };
  const proposal = await proposeEmptyAuthSchemaMigration({ resource: f.resource, catalogAppIds });
  const emptyPlan = await planAuthSchemaMigration(input);
  expect(proposal.schemaPlan.targetDigest).toBe(emptyPlan.targetDigest);
  await applyAuthSchemaMigration({
    ...input,
    approvedDigest: emptyPlan.planDigest,
    afterSchema: (client) => provisionEnrolledAuthAccess(client, catalogAppIds),
  });
  const enrolledPlan = await planAuthSchemaMigration({
    ...input,
    options: createAuthSchemaOptions(f.pool),
  });
  expect(enrolledPlan.targetDigest).toBe(emptyPlan.targetDigest);
  const functionReadback = await f.pool.query(
    "select to_regprocedure('public.enroll_app_signup_user(text,text,text,text,text)') is not null as installed",
  );
  expect(functionReadback.rows[0]?.installed).toBe(true);
  const insertPolicy = (policyId: string) =>
    f.pool.query(
      `insert into public.app_signup_policy(id,"authResourceId","resourceDigest","appId",origin,"appPath","organizationId",eligibility,"membershipRole","appRoles","operationRef","planDigest","policyDigest","fenceGeneration","createdAt")
     values ($1,'auth-resource',repeat('a',64),'signup-fixture','https://signup.example','/','dev','public','member','["member"]'::jsonb,'operation',repeat('b',64),repeat('c',64),1,now())`,
      [policyId],
    );
  await insertPolicy("first-policy");
  await expect(insertPolicy("duplicate-policy")).rejects.toMatchObject({ code: "23505" });
});

test("managed invitation verifies only its real account and role-less grants remain tenant scoped and revocable", async () => {
  const f = await fixture();
  await install(f);
  await f.pool.query(`insert into public.organization(id,name,slug,"createdAt","appIds") values
    ('dev','Controlled workspace','dev',now(),'[]')`);
  await f.pool.query(`insert into public."user"(id,name,email,"emailVerified") values
    ('invited','Invited','invited@example.test',true),('other','Other','other@example.test',true)`);
  await f.pool.query(`insert into public.session(id,token,"userId","expiresAt","updatedAt") values
    ('invited-session','private-invited-token','invited',now()+interval '1 hour',now()),
    ('other-session','private-other-token','other',now()+interval '1 hour',now())`);
  await f.pool
    .query(`insert into public.app_access_invitation(id,"workspaceId","resourceDigest","appId","organizationId",email,roles,"returnUrl","operationRef","planDigest","scopeDigest","fenceGeneration","expiresAt")
    values('invite','workspace',repeat('a',64),'roleless','dev','invited@example.test','[]','https://apps.example/roleless','operation',repeat('b',64),repeat('c',64),1,now()+interval '1 hour')`);
  const runtime = new Pool({
    connectionString: f.connection.replace("auth_migrator:", "auth_runtime:"),
  });
  pools.push(runtime);
  expect(
    (
      await runtime.query(
        `select public.verify_app_access_invitation('invite','other','other-session',repeat('a',64)) as ok`,
      )
    ).rows[0].ok,
  ).toBe(false);
  expect(
    (
      await runtime.query(
        `select public.verify_app_access_invitation('invite','invited','other-session',repeat('a',64)) as ok`,
      )
    ).rows[0].ok,
  ).toBe(false);
  expect(
    (
      await runtime.query(
        `select public.verify_app_access_invitation('invite','invited','invited-session',repeat('a',64)) as ok`,
      )
    ).rows[0].ok,
  ).toBe(true);
  expect(
    (await f.pool.query(`select * from public.member where "userId"='invited'`)).rows,
  ).toHaveLength(0);
  await expect(
    runtime.query(`update public.app_access_invitation set roles='["owner"]'`),
  ).rejects.toMatchObject({ code: "42501" });
  const client = await f.pool.connect();
  try {
    await client.query(
      `update public.app_access_invitation set "deliveryStatus"='unknown',"deliveryAttemptId"='attempt' where id='invite'`,
    );
    expect(
      (
        await runtime.query(
          `select public.record_app_invitation_delivery('invite','wrong-attempt','provider') as ok`,
        )
      ).rows[0].ok,
    ).toBe(false);
    // A delayed provider response resolves exactly the retained send attempt.
    await client.query(
      `update public.app_access_invitation set status='pending' where id='invite'`,
    );
    expect(
      (
        await runtime.query(
          `select public.record_app_invitation_delivery('invite','attempt','provider') as ok`,
        )
      ).rows[0].ok,
    ).toBe(true);
    expect(
      (
        await client.query(
          `select "deliveryStatus" from public.app_access_invitation where id='invite'`,
        )
      ).rows[0].deliveryStatus,
    ).toBe("sent");
    const member = {
      client,
      resource: f.resource,
      spec: { workspaceId: "workspace", organizationId: "dev", actorId: "invited" },
      realmSessionId: "invited-session",
      assertCurrent: async () => {},
    };
    expect((await joinExistingRealmOrganization(member)).replayed).toBe(false);
    expect((await joinExistingRealmOrganization(member)).replayed).toBe(true);
    expect(
      (await f.pool.query('select id,"activeOrganizationId" from public.session order by id')).rows,
    ).toEqual([
      { id: "invited-session", activeOrganizationId: "dev" },
      { id: "other-session", activeOrganizationId: null },
    ]);
    expect(
      (await f.pool.query(`select role from public.member where "userId"='invited'`)).rows,
    ).toEqual([{ role: "member" }]);
    const scope = { workspaceId: "workspace", organizationId: "dev", appId: "roleless" };
    const grant = { ...scope, actorId: "invited", roles: [], active: true, fenceGeneration: 2 };
    await setManagedFrontendAccess(client, grant, async () => {});
    expect(await listManagedAppMembers(client, scope)).toEqual([
      { id: "invited", name: "Invited", email: "invited@example.test", roles: [] },
    ]);
    expect(await listManagedAppMembers(client, { ...scope, appId: "unrelated" })).toEqual([]);
    await setManagedFrontendAccess(
      client,
      { ...grant, active: false, fenceGeneration: 3 },
      async () => {},
    );
    await expect(setManagedFrontendAccess(client, grant, async () => {})).rejects.toThrow(
      "app_access_stale_fence",
    );
    expect(await listManagedAppMembers(client, scope)).toEqual([]);
    await expect(
      runtime.query(`update public.app_actor_access set active=true`),
    ).rejects.toMatchObject({ code: "42501" });
  } finally {
    client.release();
  }
}, 30_000);

test("plans exact generated SQL without effects, binds approval and replays the verified schema receipt", async () => {
  const f = await fixture();
  const plan = await planAuthSchemaMigration(f);
  expect(plan.catalogAppIds.length).toBeGreaterThan(0);
  const expandedCatalogPlan = await planAuthSchemaMigration({
    ...f,
    catalogAppIds: [...plan.catalogAppIds, "sibling-app"].sort(),
  });
  expect(expandedCatalogPlan.targetDigest).not.toBe(plan.targetDigest);
  expect(expandedCatalogPlan.planDigest).not.toBe(plan.planDigest);
  const schemaModel = createAuthSchemaOptions(f.pool);
  const fixedPlan = await planAuthSchemaMigration({ ...f, options: schemaModel });
  expect(fixedPlan.targetDigest).toBe(plan.targetDigest);
  expect(fixedPlan.planDigest).toBe(plan.planDigest);
  expect(plan.effects.find((effect) => effect.owner === "better-auth")?.sql).toContain(
    'create table "user"',
  );
  expect(plan.effects.find((effect) => effect.owner === "platform")?.sql).toContain(
    "app_actor_assignment",
  );
  expect(JSON.stringify(plan)).not.toContain(password);
  expect(JSON.stringify(plan)).not.toContain(f.env.BETTER_AUTH_SECRET);
  expect(
    (await f.pool.query("select to_regnamespace('_auth_schema_history') as history")).rows[0]
      .history,
  ).toBeNull();
  await expect(
    applyAuthSchemaMigration({ ...f, approvedDigest: "0".repeat(64) }),
  ).rejects.toMatchObject({ code: "reviewed_plan_digest_mismatch" });
  expect(
    (
      await f.pool.query(
        "select count(*)::int as total from information_schema.tables where table_schema='public'",
      )
    ).rows[0].total,
  ).toBe(0);
  const first = await applyAuthSchemaMigration({ ...f, approvedDigest: plan.planDigest });
  expect(
    (
      await f.pool.query(
        "select column_default from information_schema.columns where table_schema='public' and table_name='app_actor_assignment' and column_name='active'",
      )
    ).rows[0]?.column_default,
  ).toBe("true");
  const repeated = await applyAuthSchemaMigration({ ...f, approvedDigest: plan.planDigest });
  expect(repeated).toMatchObject({ state: "verified", attemptId: first.attemptId, replayed: true });
  expect((await f.pool.query('select status from "_auth_schema_history".attempt')).rows).toEqual([
    { status: "verified" },
  ]);
  expect(
    (
      await f.pool.query(
        "select has_schema_privilege('auth_runtime','_auth_schema_history','USAGE,CREATE') as privileged",
      )
    ).rows[0].privileged,
  ).toBe(false);
});

test("additive Auth changes preserve existing IDs, password hashes, memberships and actual sessions", async () => {
  const f = await fixture();
  const { plan } = await install(f);
  await seed(f);
  const signed = await f.auth.api.signInEmail({
    body: { email: "schema_actor@example.test", password },
    headers: new Headers({ origin: f.env.BETTER_AUTH_URL, host: "localhost:3000" }),
    returnHeaders: true,
  });
  const headers = new Headers({
    origin: f.env.BETTER_AUTH_URL,
    host: "localhost:3000",
    cookie: signed.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";", 1)[0])
      .join("; "),
  });
  const accounts = (await f.pool.query('select id,password from "account" order by id')).rows;
  const memberships = (
    await f.pool.query('select id,"organizationId","userId" from "member" order by id')
  ).rows;
  const expanded = {
    ...f,
    options: {
      ...f.options,
      user: {
        ...f.options.user,
        additionalFields: {
          ...f.options.user?.additionalFields,
          reviewedLabel: { type: "string" as const, required: false },
        },
      },
    },
  };
  await expect(
    applyAuthSchemaMigration({ ...expanded, approvedDigest: plan.planDigest }),
  ).rejects.toMatchObject({ code: "reviewed_plan_digest_mismatch" });
  const expansion = await planAuthSchemaMigration(expanded);
  expect(expansion.planDigest).not.toBe(plan.planDigest);
  expect(expansion.effects.find((effect) => effect.owner === "better-auth")?.sql).toContain(
    'add column "reviewedLabel"',
  );
  await applyAuthSchemaMigration({ ...expanded, approvedDigest: expansion.planDigest });
  expect((await f.pool.query('select id,password from "account" order by id')).rows).toEqual(
    accounts,
  );
  expect(
    (await f.pool.query('select id,"organizationId","userId" from "member" order by id')).rows,
  ).toEqual(memberships);
  expect((await f.auth.api.getSession({ headers }))?.user.id).toBe("schema_actor");
  expect(
    (await f.pool.query('select "reviewedLabel" from "user" where id=$1', ["schema_actor"])).rows,
  ).toEqual([{ reviewedLabel: null }]);
  const unsafe = {
    ...expanded,
    options: {
      ...expanded.options,
      user: {
        ...expanded.options.user,
        additionalFields: {
          ...expanded.options.user.additionalFields,
          requiredWithoutBackfill: { type: "string" as const, required: true },
        },
      },
    },
  };
  await expect(planAuthSchemaMigration(unsafe)).rejects.toThrow("Cannot add required column");
});

test("retains failed attempt evidence, rolls back schema effects and safely retries the same reviewed plan", async () => {
  const f = await fixture();
  await install(f);
  await seed(f);
  await seed(f, "other_actor");
  const failed = { ...f, previewSql: 'create unique index reviewed_name_unique on "user"("name")' };
  const plan = await planAuthSchemaMigration(failed);
  await expect(
    applyAuthSchemaMigration({ ...failed, approvedDigest: plan.planDigest }),
  ).rejects.toMatchObject({ code: "23505" });
  expect(
    (
      await f.pool.query(
        'select status,failure_code,after_hash from "_auth_schema_history".attempt where plan_digest=$1',
        [plan.planDigest],
      )
    ).rows,
  ).toEqual([{ status: "failed", failure_code: "23505", after_hash: null }]);
  expect((await planAuthSchemaMigration(failed)).planDigest).toBe(plan.planDigest);
  await f.pool.query('update "user" set name=id');
  const retry = await applyAuthSchemaMigration({ ...failed, approvedDigest: plan.planDigest });
  expect(retry.state).toBe("verified");
  expect(
    (
      await f.pool.query(
        'select status,failure_code from "_auth_schema_history".attempt where plan_digest=$1 order by id',
        [plan.planDigest],
      )
    ).rows,
  ).toEqual([
    { status: "failed", failure_code: "23505" },
    { status: "verified", failure_code: null },
  ]);
});

test("explicit resource contention is retryable and catalog drift cannot reuse a completed receipt", async () => {
  const f = await fixture();
  const { plan } = await install(f);
  const owner = await f.pool.connect();
  await owner.query("select pg_advisory_lock(hashtext('platform:auth-schema:migration:v1'))");
  try {
    await expect(planAuthSchemaMigration(f)).rejects.toMatchObject({
      code: "migration_contention",
      retryable: true,
    });
  } finally {
    await owner.query("select pg_advisory_unlock(hashtext('platform:auth-schema:migration:v1'))");
    owner.release();
  }
  await f.pool.query('alter table "user" add column unexpected_catalog_drift text');
  await expect(
    applyAuthSchemaMigration({ ...f, approvedDigest: plan.planDigest }),
  ).rejects.toMatchObject({ code: "verified_schema_drift" });
});

test("schema hash detects trigger, trigger function, and RLS policy drift", async () => {
  const f = await fixture();
  await install(f);
  const client = await f.pool.connect();
  try {
    const baseline = await authSchemaHash(client);
    await client.query(
      `create function test_auth_trigger() returns trigger language plpgsql as $$ begin return new; end $$`,
    );
    await client.query(
      `create trigger test_auth_trigger before insert on "user" for each row execute function test_auth_trigger()`,
    );
    const withTrigger = await authSchemaHash(client);
    expect(withTrigger).not.toBe(baseline);
    await client.query(
      `create or replace function test_auth_trigger() returns trigger language plpgsql as $$ begin perform 1; return new; end $$`,
    );
    const withChangedFunction = await authSchemaHash(client);
    expect(withChangedFunction).not.toBe(withTrigger);
    await client.query(`create policy test_auth_policy on "user" using (true)`);
    expect(await authSchemaHash(client)).not.toBe(withChangedFunction);
  } finally {
    client.release();
  }
});

test("enrolled access provisioning rolls back tenant rewrites when organization upsert fails", async () => {
  const f = await fixture();
  await install(f);
  await f.pool.query(
    `insert into "organization" (id,name,slug,"createdAt") values ('demo','Demo','vendor',now())`,
  );
  await f.pool.query(
    `insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt")
     values ('legacy_grant_actor','Legacy grant','legacy-grant@example.test',true,now(),now())`,
  );
  await f.pool.query(
    `insert into "app_actor_assignment" ("organizationId","actorId","appId","role")
     values ('demo','legacy_grant_actor','vendor','member')`,
  );
  await f.pool.query(`create function fail_auth_upsert() returns trigger language plpgsql as $$
    begin if new.id='hc' then raise exception 'organization upsert fixture'; end if; return new; end $$`);
  await f.pool.query(
    `create trigger fail_auth_upsert before insert on "organization" for each row execute function fail_auth_upsert()`,
  );
  const client = await f.pool.connect();
  try {
    await expect(provisionEnrolledAuthAccess(client, f.catalogAppIds)).rejects.toThrow(
      "organization upsert fixture",
    );
    expect(
      (
        await client.query(
          `select id,slug from "organization" where id in ('demo','vendor') order by id`,
        )
      ).rows,
    ).toEqual([{ id: "demo", slug: "vendor" }]);
    expect(
      (
        await client.query(
          `select "organizationId","actorId","appId","role" from "app_actor_assignment"
           where "actorId"='legacy_grant_actor'`,
        )
      ).rows,
    ).toEqual([
      {
        organizationId: "demo",
        actorId: "legacy_grant_actor",
        appId: "vendor",
        role: "member",
      },
    ]);
    await client.query(`drop trigger fail_auth_upsert on "organization"`);
    await client.query(`drop function fail_auth_upsert()`);
    await provisionEnrolledAuthAccess(client, f.catalogAppIds);
    expect(
      (
        await client.query(
          `select id from "organization" where id in ('demo','vendor') order by id`,
        )
      ).rows,
    ).toEqual([{ id: "vendor" }]);
    expect(
      (
        await client.query(
          `select "organizationId","actorId","appId","role" from "app_actor_assignment"
           where "actorId"='legacy_grant_actor'`,
        )
      ).rows,
    ).toEqual([
      {
        organizationId: "vendor",
        actorId: "legacy_grant_actor",
        appId: "vendor",
        role: "member",
      },
    ]);
  } finally {
    client.release();
  }
});

test("legacy access canonicalization works before the assignment table exists", async () => {
  const f = await fixture();
  await install(f);
  await f.pool.query(`drop table "app_actor_assignment"`);
  await f.pool.query(
    `insert into "organization" (id,name,slug,"createdAt") values ('demo','Demo','vendor',now())`,
  );
  const client = await f.pool.connect();
  try {
    await provisionEnrolledAuthAccess(client, f.catalogAppIds);
  } finally {
    client.release();
  }
  expect(
    (await f.pool.query(`select id from "organization" where id in ('demo','vendor') order by id`))
      .rows,
  ).toEqual([{ id: "vendor" }]);
  expect(
    (await f.pool.query(`select to_regclass('public.app_actor_assignment') as assignment_table`))
      .rows[0]?.assignment_table,
  ).toBe("app_actor_assignment");
});

test("access reconciliation retains enabled sibling app IDs", async () => {
  const f = await fixture();
  await install(f);
  const firstClient = await f.pool.connect();
  try {
    await provisionEnrolledAuthAccess(firstClient, f.catalogAppIds);
  } finally {
    firstClient.release();
  }
  await f.pool.query(
    `update "organization" set "appIds" = "appIds" || '["sibling-app"]'::jsonb where id='hc'`,
  );
  expect(
    (await f.pool.query(`select "appIds" from "organization" where id='hc'`)).rows[0]?.appIds,
  ).toEqual(["hc", "sibling-app"]);
  const client = await f.pool.connect();
  try {
    await provisionEnrolledAuthAccess(client, f.catalogAppIds);
  } finally {
    client.release();
  }
  const appIds = (await f.pool.query(`select "appIds" from "organization" where id='hc'`)).rows[0]
    ?.appIds as string[];
  expect(appIds).toContain("hc");
  expect(appIds).toContain("sibling-app");
  const check = spawnSync(
    "bun",
    [path.join(root, ".config/mise/scripts/repository/auth-schema-check.ts")],
    {
      cwd: root,
      env: {
        ...process.env,
        ...f.env,
        AUTH_CATALOG_APP_IDS: JSON.stringify(f.catalogAppIds),
        VERCEL_ENV: undefined,
        NODE_ENV: "test",
      },
      encoding: "utf8",
    },
  );
  expect(check.status, check.stderr).toBe(0);

  for (const invalidAppIds of [
    ["hc", "not an app id"],
    ["hc", "hc"],
  ]) {
    await f.pool.query(`update "organization" set "appIds"=$1::jsonb where id='hc'`, [
      JSON.stringify(invalidAppIds),
    ]);
    const rejected = spawnSync(
      "bun",
      [path.join(root, ".config/mise/scripts/repository/auth-schema-check.ts")],
      {
        cwd: root,
        env: {
          ...process.env,
          ...f.env,
          AUTH_CATALOG_APP_IDS: JSON.stringify(f.catalogAppIds),
          VERCEL_ENV: undefined,
          NODE_ENV: "test",
        },
        encoding: "utf8",
      },
    );
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("Auth organization assignment is missing or stale");
  }
});

test.each([JSON.stringify("malformed"), JSON.stringify({ stale: true })])(
  "access reconciliation repairs non-array organization appIds %s",
  async (invalidAppIds) => {
    const f = await fixture();
    await install(f);
    await f.pool.query(`update "organization" set "appIds"=$1::jsonb where id='hc'`, [
      invalidAppIds,
    ]);
    const client = await f.pool.connect();
    try {
      await provisionEnrolledAuthAccess(client, f.catalogAppIds);
    } finally {
      client.release();
    }
    expect(
      (await f.pool.query(`select "appIds" from "organization" where id='hc'`)).rows[0]?.appIds,
    ).toEqual(["hc"]);
  },
);

test("catalog IDs containing quotes and backslashes remain data during access provisioning", async () => {
  const f = await fixture();
  await install(f);
  await seed(f, "catalog_quote_actor");
  const usersBefore = (await f.pool.query(`select id,email from "user" order by id`)).rows;
  const unusualId = "quote'); delete from \"user\"; --\\catalog $& $' $`";
  const client = await f.pool.connect();
  try {
    await provisionEnrolledAuthAccess(client, ["hc", unusualId]);
  } finally {
    client.release();
  }
  const appIds = (await f.pool.query(`select "appIds" from "organization" where id='dev'`)).rows[0]
    ?.appIds as string[];
  expect(appIds).toContain(unusualId);
  expect((await f.pool.query(`select id,email from "user" order by id`)).rows).toEqual(usersBefore);
});

test("legacy grant key conflicts fail closed and roll back without overwriting either assignment", async () => {
  const f = await fixture();
  await install(f);
  await f.pool.query(
    `insert into "organization" (id,name,slug,"createdAt") values ('demo','Demo','vendor',now())`,
  );
  await f.pool.query(
    `insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt")
     values ('conflicting_grant_actor','Conflicting grant','conflicting-grant@example.test',true,now(),now())`,
  );
  await f.pool.query(
    `insert into "app_actor_assignment" ("organizationId","actorId","appId","role")
     values ('demo','conflicting_grant_actor','vendor','member')`,
  );
  await f.pool
    .query(`create function seed_conflicting_vendor_grant() returns trigger language plpgsql as $$
    begin
      if new.id='vendor' then
        insert into "app_actor_assignment" ("organizationId","actorId","appId","role")
        values ('vendor','conflicting_grant_actor','vendor','member');
      end if;
      return new;
    end $$`);
  await f.pool.query(
    `create trigger seed_conflicting_vendor_grant after insert on "organization"
     for each row execute function seed_conflicting_vendor_grant()`,
  );

  const client = await f.pool.connect();
  try {
    await expect(provisionEnrolledAuthAccess(client, f.catalogAppIds)).rejects.toMatchObject({
      code: "23505",
    });
    expect(
      (
        await client.query(
          `select id from "organization" where id in ('demo','vendor') order by id`,
        )
      ).rows,
    ).toEqual([{ id: "demo" }]);
    expect(
      (
        await client.query(
          `select "organizationId","actorId","appId","role" from "app_actor_assignment"
           where "actorId"='conflicting_grant_actor' order by "organizationId"`,
        )
      ).rows,
    ).toEqual([
      {
        organizationId: "demo",
        actorId: "conflicting_grant_actor",
        appId: "vendor",
        role: "member",
      },
    ]);
  } finally {
    client.release();
  }
});

test("enrolled access provisioning upgrades an existing assignment table with operation fences", async () => {
  const f = await fixture();
  await install(f);
  await f.pool.query(
    `insert into "organization" (id,name,slug,"createdAt") values ('vendor','Vendor','vendor',now())
     on conflict (id) do nothing`,
  );
  await f.pool.query(
    `insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt")
     values ('existing_actor','Existing','existing@example.test',true,now(),now())`,
  );
  await f.pool.query(
    `insert into "app_actor_assignment" ("organizationId","actorId","appId","role",active)
     values ('vendor','existing_actor','vendor','member',true)`,
  );
  await f.pool.query(
    `alter table "app_actor_assignment" drop constraint app_actor_assignment_fence_generation_nonnegative;
     alter table "app_actor_assignment" drop column "fence_generation"`,
  );

  const client = await f.pool.connect();
  try {
    await provisionEnrolledAuthAccess(client, f.catalogAppIds);
  } finally {
    client.release();
  }

  expect(
    (
      await f.pool.query(
        `select active,fence_generation from "app_actor_assignment"
         where "organizationId"='vendor' and "actorId"='existing_actor' and "appId"='vendor'`,
      )
    ).rows,
  ).toEqual([{ active: true, fence_generation: "0" }]);
  expect(
    (
      await f.pool.query(
        `select convalidated,pg_get_constraintdef(oid) as definition from pg_constraint
         where conrelid='public.app_actor_assignment'::regclass
           and conname='app_actor_assignment_fence_generation_nonnegative'`,
      )
    ).rows,
  ).toEqual([{ convalidated: true, definition: "CHECK ((fence_generation >= 0))" }]);
});

test("an interrupted worker leaves applying history; retry inspects the same rolled-back resources", async () => {
  const f = await fixture();
  await install(f);
  const options = {
    ...f.options,
    user: {
      ...f.options.user,
      additionalFields: {
        ...f.options.user?.additionalFields,
        crashProof: { type: "string" as const, required: false },
      },
    },
  };
  const plan = await planAuthSchemaMigration({ ...f, options });
  const workerFile = path.join(directory, "worker.ts");
  await writeFile(
    workerFile,
    `import {Pool} from ${JSON.stringify(path.join(root, "node_modules/pg/lib/index.js"))};
import {createAuth} from ${JSON.stringify(path.join(root, "packages/auth/server.ts"))};
import {applyAuthSchemaMigration} from ${JSON.stringify(path.join(root, ".config/mise/scripts/repository/auth-schema-history.ts"))};
const auth=createAuth({appName:"Autograph",databasePurpose:"migrator",env:process.env});
const options={...auth.options,user:{...auth.options.user,additionalFields:{...auth.options.user?.additionalFields,crashProof:{type:"string",required:false}}}};
await applyAuthSchemaMigration({pool:new Pool({connectionString:process.env.PLATFORM_AUTH_DATABASE_URL,max:1}),resource:JSON.parse(process.env.AUTH_DATABASE_RESOURCE),options,catalogAppIds:${JSON.stringify(f.catalogAppIds)},approvedDigest:process.env.AUTH_SCHEMA_MIGRATION_PLAN_DIGEST});
`,
    { mode: 0o600 },
  );
  const blocker = await f.pool.connect();
  await blocker.query("begin");
  await blocker.query('lock table "user" in access share mode');
  const worker = spawn("bun", [workerFile], {
    cwd: root,
    env: { PATH: process.env.PATH, ...f.env, AUTH_SCHEMA_MIGRATION_PLAN_DIGEST: plan.planDigest },
    stdio: "ignore",
  });
  let waiting = false;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      waiting =
        (
          await admin.query(
            "select 1 from pg_stat_activity where datname=$1 and wait_event_type='Lock'",
            [f.resource.database],
          )
        ).rowCount! > 0;
      if (waiting) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(waiting).toBe(true);
    const exit = new Promise((resolve) => worker.once("exit", resolve));
    worker.kill("SIGKILL");
    await exit;
  } finally {
    await blocker.query("rollback");
    blocker.release();
    if (!worker.killed) worker.kill("SIGKILL");
  }
  // Releasing the blocker lets PostgreSQL observe the disconnected owner and roll back its transaction.
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      !(
        await admin.query(
          "select 1 from pg_stat_activity where datname=$1 and wait_event_type='Lock'",
          [f.resource.database],
        )
      ).rowCount
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const interrupted = (
    await f.pool.query(
      'select status,after_hash from "_auth_schema_history".attempt where plan_digest=$1',
      [plan.planDigest],
    )
  ).rows;
  expect(interrupted).toEqual([{ status: "applying", after_hash: null }]);
  const publicationRuntime = new Pool({
    connectionString: f.connection.replace("auth_migrator", "auth_runtime"),
  });
  pools.push(publicationRuntime);
  expect(
    (await publicationRuntime.query("select _auth_schema_readiness.read_current() readiness"))
      .rows[0].readiness.status,
  ).toBe("unverified");
  expect((await planAuthSchemaMigration({ ...f, options })).planDigest).toBe(plan.planDigest);
  await applyAuthSchemaMigration({ ...f, options, approvedDigest: plan.planDigest });
  expect(
    (
      await f.pool.query(
        'select status from "_auth_schema_history".attempt where plan_digest=$1 order by id',
        [plan.planDigest],
      )
    ).rows,
  ).toEqual([{ status: "applying" }, { status: "verified" }]);
  expect(
    (await publicationRuntime.query("select _auth_schema_readiness.read_current() readiness"))
      .rows[0].readiness,
  ).toMatchObject({ status: "verified", targetDigest: plan.targetDigest });
}, 30_000);

test("the supported provisioner consumes reviewed schema history and preserves access reconciliation", async () => {
  const f = await fixture();
  const env = {
    ...process.env,
    ...f.env,
    BETTER_AUTH_APP_NAME: "Autograph",
    AUTH_CATALOG_APP_IDS: JSON.stringify(f.catalogAppIds),
    VERCEL_ENV: undefined,
    AUTH_SCHEMA_PREVIEW_ARTIFACT_FILE: undefined,
  };
  const planning = spawnSync(
    "bun",
    [path.join(root, ".config/mise/scripts/repository/auth-enrolled-provision.ts"), "plan"],
    { cwd: root, env, encoding: "utf8" },
  );
  expect(planning.status, planning.stderr).toBe(0);
  const plan = JSON.parse(planning.stdout);
  expect(plan.catalogAppIds).toEqual([...f.catalogAppIds].sort());
  const result = spawnSync(path.join(root, ".config/mise/scripts/auth/db-provision"), [], {
    cwd: root,
    env: { ...env, AUTH_SCHEMA_MIGRATION_PLAN_DIGEST: plan.planDigest },
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  expect((await f.pool.query('select status from "_auth_schema_history".attempt')).rows).toEqual([
    { status: "verified" },
  ]);
  expect((await f.pool.query("select id from \"organization\" where id='dev'")).rows).toEqual([
    { id: "dev" },
  ]);
  expect(
    (
      await f.pool.query(`select "appIds" from "organization" where id='dev'`)
    ).rows[0].appIds.sort(),
  ).toEqual([...f.catalogAppIds].sort());
});

test.each([
  'drop table "user"',
  'alter table "user" drop column email',
  'create index concurrently bad on "user"(email)',
])("rejects unsupported/nontransactional schema effect %s", async (sql) => {
  await expect(assertGeneratedAuthSqlIsAdditive(sql)).rejects.toMatchObject({
    code: "non_additive_schema_effect",
  });
});

test("publishes live Auth catalog readiness without exposing private history or publication state", async () => {
  const f = await fixture();
  const { plan } = await install(f);
  const runtime = new Pool({
    connectionString: f.connection.replace("auth_migrator", "auth_runtime"),
  });
  pools.push(runtime);
  const asset = plan.effects.find((effect) => effect.owner === "readiness");
  expect(asset).toBeDefined();
  const observed = await runtime.query("select _auth_schema_readiness.read_current() readiness");
  expect(observed.rows[0].readiness).toMatchObject({
    version: 1,
    status: "verified",
    targetDigest: plan.targetDigest,
    assetSha256: asset!.sha256,
    algorithm: "pg-jsonb-catalog-sha256-v1",
  });
  expect(observed.rows[0].readiness.observedFingerprint).toBe(
    observed.rows[0].readiness.publishedFingerprint,
  );
  const forbidden = [
    "select * from _auth_schema_history.plan",
    "select * from _auth_schema_history.attempt",
    "select * from _auth_schema_readiness.current_target",
    "update _auth_schema_readiness.current_target set state='verified'",
    "select _auth_schema_readiness.catalog_fingerprint('auth_runtime')",
    "create table public.runtime_must_not_create(id int)",
  ];
  for (const statement of forbidden)
    await expect(runtime.query(statement)).rejects.toMatchObject({ code: "42501" });
  await f.pool.query("grant update on _auth_schema_readiness.current_target to auth_runtime");
  expect(
    (await runtime.query("select _auth_schema_readiness.read_current() readiness")).rows[0]
      .readiness.status,
  ).toBe("unverified");
  await f.pool.query("revoke update on _auth_schema_readiness.current_target from auth_runtime");
  expect(
    (await runtime.query("select _auth_schema_readiness.read_current() readiness")).rows[0]
      .readiness.status,
  ).toBe("verified");
  const first = (
    await f.pool.query("select id,readiness_fingerprint from _auth_schema_history.attempt")
  ).rows;
  await f.pool.query("delete from _auth_schema_readiness.current_target");
  expect(
    (await runtime.query("select _auth_schema_readiness.read_current() readiness")).rows[0]
      .readiness.status,
  ).toBe("unverified");
  await applyAuthSchemaMigration({ ...f, approvedDigest: plan.planDigest });
  expect(
    (await f.pool.query("select id,readiness_fingerprint from _auth_schema_history.attempt")).rows,
  ).toEqual(first);
  expect(
    (await runtime.query("select _auth_schema_readiness.read_current() readiness")).rows[0]
      .readiness.status,
  ).toBe("verified");
});

test("Auth readiness detects actual catalog and ACL drift without blessing it on verified replay", async () => {
  const f = await fixture();
  const { plan } = await install(f);
  const runtime = new Pool({
    connectionString: f.connection.replace("auth_migrator", "auth_runtime"),
  });
  pools.push(runtime);
  await f.pool.query('grant delete on public."user" to auth_runtime');
  expect(
    (await runtime.query("select _auth_schema_readiness.read_current() readiness")).rows[0]
      .readiness.status,
  ).toBe("catalog_drift");
  await expect(
    applyAuthSchemaMigration({ ...f, approvedDigest: plan.planDigest }),
  ).rejects.toMatchObject({ code: "verified_readiness_drift" });
  await f.pool.query('revoke delete on public."user" from auth_runtime');
  // Equivalent NULL/default and explicit ACL representations are normalized.
  expect(
    (await runtime.query("select _auth_schema_readiness.read_current() readiness")).rows[0]
      .readiness.status,
  ).toBe("verified");
  await f.pool.query('grant select("email") on public."user" to auth_runtime');
  expect(
    (await runtime.query("select _auth_schema_readiness.read_current() readiness")).rows[0]
      .readiness.status,
  ).toBe("catalog_drift");
  await f.pool.query('revoke select("email") on public."user" from auth_runtime');
  expect(
    (await runtime.query("select _auth_schema_readiness.read_current() readiness")).rows[0]
      .readiness.status,
  ).toBe("verified");
});

test("Auth readiness fails closed during migration and after a rolled-back schema effect", async () => {
  const f = await fixture();
  const failed = {
    ...f,
    previewSql:
      'create table "publication_failure"("id" text default publication_missing_default())',
  };
  const plan = await planAuthSchemaMigration(failed);
  await expect(
    applyAuthSchemaMigration({ ...failed, approvedDigest: plan.planDigest }),
  ).rejects.toThrow();
  const runtime = new Pool({
    connectionString: f.connection.replace("auth_migrator", "auth_runtime"),
  });
  pools.push(runtime);
  expect(
    (await runtime.query("select _auth_schema_readiness.read_current() readiness")).rows[0]
      .readiness.status,
  ).toBe("unverified");
  expect(
    (await f.pool.query("select to_regclass('public.publication_failure') relation")).rows[0]
      .relation,
  ).toBeNull();
  const owner = await f.pool.connect();
  try {
    await owner.query("select pg_advisory_lock(hashtext('platform:auth-schema:migration:v1'))");
    expect(
      (await runtime.query("select _auth_schema_readiness.read_current() readiness")).rows[0]
        .readiness.status,
    ).toBe("migration_in_progress");
  } finally {
    await owner.query("select pg_advisory_unlock(hashtext('platform:auth-schema:migration:v1'))");
    owner.release();
  }
  await f.pool.query(
    "create function public.publication_missing_default() returns text language sql immutable as 'select null::text'",
  );
  expect((await planAuthSchemaMigration(failed)).planDigest).toBe(plan.planDigest);
  await applyAuthSchemaMigration({ ...failed, approvedDigest: plan.planDigest });
  expect(
    (await runtime.query("select _auth_schema_readiness.read_current() readiness")).rows[0]
      .readiness,
  ).toMatchObject({ status: "verified", targetDigest: plan.targetDigest });
});

test("protected Auth runtime supports real login, password, session, organization and invitation lifecycle", async () => {
  const f = await fixture();
  const { plan } = await install(f);
  await seed(f);
  const connection = f.connection.replace("auth_migrator", "auth_runtime");
  const runtime = new Pool({ connectionString: connection });
  pools.push(runtime);
  const { auth } = ownedAuth(
    { appName: "Autograph", env: { ...f.env, PLATFORM_AUTH_DATABASE_URL: connection } },
    f.resource,
  );
  const signed = await auth.api.signInEmail({
    body: { email: "schema_actor@example.test", password },
    headers: new Headers({ origin: f.env.BETTER_AUTH_URL, host: "localhost:3000" }),
    returnHeaders: true,
  });
  const headers = new Headers({
    origin: f.env.BETTER_AUTH_URL,
    host: "localhost:3000",
    cookie: signed.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; "),
  });
  expect((await auth.api.getSession({ headers }))?.user.id).toBe("schema_actor");
  await auth.api.updateUser({ headers, body: { name: "Updated Actor" } });
  await auth.api.setActiveOrganization({ headers, body: { organizationId: "schema_team" } });
  await auth.api.updateOrganization({
    headers,
    body: { organizationId: "schema_team", data: { name: "Updated Team" } },
  });
  const invitation = await auth.api.createInvitation({
    headers,
    body: { organizationId: "schema_team", email: "invited@example.test", role: "member" },
  });
  const resentPending = await auth.api.createInvitation({
    headers,
    body: {
      organizationId: "schema_team",
      email: "invited@example.test",
      role: "member",
      resend: true,
    },
  });
  expect(resentPending.id).toBe(invitation.id);
  await runtime.query(
    "update public.invitation set \"expiresAt\"=now()-interval '1 day' where id=$1",
    [invitation.id],
  );
  await expect(
    auth.api.getInvitation({ headers, query: { id: invitation.id } }),
  ).rejects.toBeDefined();
  const resent = await auth.api.createInvitation({
    headers,
    body: {
      organizationId: "schema_team",
      email: "invited@example.test",
      role: "member",
      resend: true,
    },
  });
  await auth.api.cancelInvitation({ headers, body: { invitationId: resent.id } });
  const operator = await f.pool.connect();
  try {
    await provisionEnrolledAuthAccess(operator, f.catalogAppIds);
  } finally {
    operator.release();
  }
  const enrolled = await auth.api.signUpEmail({
    headers,
    body: { name: "Invited Actor", email: "invited@example.test", password },
    returnHeaders: true,
  });
  const invitedHeaders = new Headers({
    origin: f.env.BETTER_AUTH_URL,
    host: "localhost:3000",
    cookie: enrolled.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; "),
  });
  const activeInvite = await auth.api.createInvitation({
    headers,
    body: { organizationId: "schema_team", email: "invited@example.test", role: "member" },
  });
  const accepted = await auth.api.acceptInvitation({
    headers: invitedHeaders,
    body: { invitationId: activeInvite.id },
  });
  await auth.api.updateMemberRole({
    headers,
    body: { organizationId: "schema_team", memberId: accepted.member.id, role: "admin" },
  });
  await auth.api.removeMember({
    headers,
    body: { organizationId: "schema_team", memberIdOrEmail: accepted.member.id },
  });
  expect(
    (
      await runtime.query(
        'select role from public.member where "userId"=$1 and "organizationId"=\'dev\'',
        [enrolled.response.user.id],
      )
    ).rows[0]?.role,
  ).toBe("owner");
  const internal = (await auth.$context).internalAdapter;
  await internal.createVerificationValue({
    identifier: "runtime-verification",
    value: "first",
    expiresAt: new Date(Date.now() + 60_000),
  });
  expect((await internal.findVerificationValue("runtime-verification"))?.value).toBe("first");
  await internal.updateVerificationByIdentifier("runtime-verification", { value: "second" });
  const account = await internal.createAccount({
    userId: "schema_actor",
    providerId: "fixture-oauth",
    accountId: "fixture-oauth-account",
    accessToken: "synthetic-fixture-token",
  });
  await internal.updateAccount(account.id, { accessToken: "synthetic-updated-token" });
  await internal.deleteAccount(account.id);
  await internal.deleteVerificationByIdentifier("runtime-verification");
  expect(await internal.findVerificationValue("runtime-verification")).toBeNull();
  const nextPassword = `${password}-changed`;
  await auth.api.changePassword({
    headers,
    body: { currentPassword: password, newPassword: nextPassword, revokeOtherSessions: true },
  });
  await auth.api.signOut({ headers });
  expect(await auth.api.getSession({ headers })).toBeNull();
  expect(
    (
      await auth.api.signInEmail({
        headers,
        body: { email: "schema_actor@example.test", password: nextPassword },
      })
    ).user.id,
  ).toBe("schema_actor");
  for (const sql of [
    "update public.organization set metadata=null",
    "update public.organization set \"appIds\"='[]'::jsonb",
    "delete from public.organization",
    'delete from public."user"',
    "update public.app_actor_assignment set active=false",
    "select * from _auth_schema_history.attempt",
    "select * from _auth_schema_readiness.current_target",
    "create table public.forbidden_auth_table(id int)",
  ])
    await expect(runtime.query(sql)).rejects.toMatchObject({ code: "42501" });
  await f.pool.query("grant update(metadata) on public.organization to public");
  const profile = plan.effects.find((effect) => effect.owner === "runtime-privileges");
  expect(profile).toBeDefined();
  await f.pool.query(profile!.sql);
  await expect(runtime.query("update public.organization set metadata=null")).rejects.toMatchObject(
    { code: "42501" },
  );
  expect((await applyAuthSchemaMigration({ ...f, approvedDigest: plan.planDigest })).replayed).toBe(
    true,
  );
}, 30_000);

test("failed publication readback rolls back verified history and publication together, then recovers", async () => {
  const f = await fixture();
  const { plan: original } = await install(f);
  await seed(f);
  await f.pool
    .query(`create function public.corrupt_publication_fixture() returns trigger language plpgsql as $$ begin if new.state='verified' then new.catalog_fingerprint:=repeat('0',64); end if; return new; end $$;
    create trigger corrupt_publication before update on _auth_schema_readiness.current_target for each row execute function public.corrupt_publication_fixture()`);
  const changed = { ...f, catalogAppIds: [...original.catalogAppIds, "publication-fixture"] };
  const plan = await planAuthSchemaMigration(changed);
  await expect(
    applyAuthSchemaMigration({ ...changed, approvedDigest: plan.planDigest }),
  ).rejects.toMatchObject({ code: "schema_effect_failed" });
  expect(
    (
      await f.pool.query(
        "select status from _auth_schema_history.attempt where plan_digest=$1 order by id desc limit 1",
        [plan.planDigest],
      )
    ).rows[0].status,
  ).toBe("failed");
  expect(
    (await f.pool.query("select state from _auth_schema_readiness.current_target")).rows[0].state,
  ).toBe("pending");
  expect(
    (await f.pool.query("select _auth_schema_readiness.read_current() readiness")).rows[0].readiness
      .status,
  ).toBe("unverified");
  await f.pool.query("drop trigger corrupt_publication on _auth_schema_readiness.current_target");
  expect((await planAuthSchemaMigration(changed)).planDigest).toBe(plan.planDigest);
  expect(
    (await applyAuthSchemaMigration({ ...changed, approvedDigest: plan.planDigest })).state,
  ).toBe("verified");
  expect(
    (
      await f.pool.query(
        "select status from _auth_schema_history.attempt where plan_digest=$1 order by id desc limit 1",
        [plan.planDigest],
      )
    ).rows[0].status,
  ).toBe("verified");
  expect(
    (await f.pool.query("select _auth_schema_readiness.read_current() readiness")).rows[0].readiness
      .status,
  ).toBe("verified");
  expect(
    (await applyAuthSchemaMigration({ ...changed, approvedDigest: plan.planDigest })).replayed,
  ).toBe(true);
  expect(
    (await f.pool.query("select id from public.\"user\" where id='schema_actor'")).rowCount,
  ).toBe(1);
});

test.each([false, true])(
  "lost verification COMMIT acknowledgement preserves the actual database outcome (committed=%s)",
  async (committed) => {
    const f = await fixture();
    const plan = await planAuthSchemaMigration(f);
    let verifiedRead = false;
    let injected = false;
    const intercepted = new Proxy(f.pool, {
      get(pool, key) {
        if (key === "connect")
          return async () => {
            const client = await pool.connect();
            return new Proxy(client, {
              get(connection, member) {
                if (member === "query")
                  return async (text: string, values?: unknown[]) => {
                    if (text === "commit" && verifiedRead && !injected) {
                      injected = true;
                      if (committed) await connection.query(text, values);
                      throw new Error("Synthetic lost COMMIT acknowledgement");
                    }
                    const result = await connection.query(text, values);
                    if (text === "select _auth_schema_readiness.read_current() as readiness")
                      verifiedRead = true;
                    return result;
                  };
                const value: unknown = Reflect.get(connection, member, connection);
                return typeof value === "function" ? value.bind(connection) : value;
              },
            });
          };
        const value: unknown = Reflect.get(pool, key, pool);
        return typeof value === "function" ? value.bind(pool) : value;
      },
    });
    await expect(
      applyAuthSchemaMigration({ ...f, pool: intercepted, approvedDigest: plan.planDigest }),
    ).rejects.toMatchObject({ code: "schema_verification_commit_unknown", retryable: true });
    expect(injected).toBe(true);
    const history = (
      await f.pool.query("select status from _auth_schema_history.attempt order by id desc limit 1")
    ).rows[0].status;
    const publication = (
      await f.pool.query("select state from _auth_schema_readiness.current_target")
    ).rows[0].state;
    expect(history).toBe(committed ? "verified" : "applying");
    expect(publication).toBe(committed ? "verified" : "pending");
    expect((await planAuthSchemaMigration(f)).planDigest).toBe(plan.planDigest);
    const receipt = await applyAuthSchemaMigration({ ...f, approvedDigest: plan.planDigest });
    expect(receipt.state).toBe("verified");
    expect(receipt.replayed).toBe(true);
    expect(
      (await f.pool.query("select _auth_schema_readiness.read_current() readiness")).rows[0]
        .readiness.status,
    ).toBe("verified");
  },
);

test("current trusted Auth genesis SQL matches the official fresh PostgreSQL planner exactly", async () => {
  const f = await fixture();
  const migrations = await getMigrations(f.options);
  const generated = await migrations.compileMigrations();
  const genesis = readFileSync(path.join(root, "packages/auth/schema.sql"), "utf8").trim();
  expect(generated).toBe(genesis);
});

test("pure new-empty Auth proposal matches actual source definition and real fresh PostgreSQL plan without fabricated database state", async () => {
  const f = await fixture();
  expect(authSchemaDefinition(createAuthSchemaDefinitionOptions())).toBe(
    authSchemaDefinition(f.options),
  );
  const proposal = await proposeEmptyAuthSchemaMigration({
    resource: f.resource,
    catalogAppIds: f.catalogAppIds,
  });
  expect(proposal.proposal).toBe("new-empty");
  expect(proposal.schemaPlan).toEqual(await planAuthSchemaMigration(f));
  await applyAuthSchemaMigration({ ...f, approvedDigest: proposal.schemaPlan.planDigest });
});
test("new-empty proposal does not authorize a nonempty or different actual Auth database", async () => {
  const f = await fixture();
  const proposal = await proposeEmptyAuthSchemaMigration({
    resource: f.resource,
    catalogAppIds: f.catalogAppIds,
  });
  await f.pool.query("create table public.existing_marker(id text)");
  await expect(
    applyAuthSchemaMigration({ ...f, approvedDigest: proposal.schemaPlan.planDigest }),
  ).rejects.toThrow();
  expect(
    (await f.pool.query("select to_regclass('public.user') relation")).rows[0].relation,
  ).toBeNull();
});

for (const sql of [
  "create type public.marker as enum ('x')",
  "create function public.marker() returns integer language sql as 'select 1'",
]) {
  test(`new-empty proposal rejects standalone namespace objects: ${sql}`, async () => {
    const f = await fixture();
    const proposal = await proposeEmptyAuthSchemaMigration({
      resource: f.resource,
      catalogAppIds: f.catalogAppIds,
    });
    await f.pool.query(sql);
    await expect(
      planAuthSchemaMigration({ ...f, requireNewEmptyPublicNamespace: true }),
    ).rejects.toThrow("new_empty_public_namespace_occupied");
    await expect(
      applyAuthSchemaMigration({
        ...f,
        requireNewEmptyPublicNamespace: true,
        approvedDigest: proposal.schemaPlan.planDigest,
      }),
    ).rejects.toThrow("new_empty_public_namespace_occupied");
    expect(
      (await f.pool.query("select to_regclass('public.user') relation")).rows[0].relation,
    ).toBeNull();
  });
}

test("new-empty Auth producer command needs no credential, database URL or native settings", async () => {
  const f = await fixture();
  const result = spawnSync(
    "bun",
    [path.join(root, ".config/mise/scripts/repository/auth-schema-proposal.ts")],
    {
      cwd: root,
      env: { PATH: process.env.PATH },
      input: JSON.stringify({ resource: f.resource, catalogAppIds: f.catalogAppIds }),
      encoding: "utf8",
    },
  );
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual(
    await proposeEmptyAuthSchemaMigration({ resource: f.resource, catalogAppIds: f.catalogAppIds }),
  );
  expect(result.stdout).not.toContain(password);
});

test("approved schema-only Auth ABI installs a fresh Realm without legacy organizations", async ({
  signal,
}) => {
  const worker = protectedWorkerPath;
  const f = await fixture();
  const proposal = await proposeEmptyAuthSchemaMigration({
    resource: f.resource,
    catalogAppIds: f.catalogAppIds,
  });
  await expect(
    runProtectedWorker(f, proposal.schemaPlan, worker, {
      protectedSchemaOnly: true,
      newEmptyProposal: true,
      omitOwnerPlan: true,
      signal,
    }),
  ).rejects.toThrow();
  expect(
    (await f.pool.query("select to_regclass('public.user') relation")).rows[0].relation,
  ).toBeNull();
  await runProtectedWorker(f, proposal.schemaPlan, worker, {
    protectedSchemaOnly: true,
    newEmptyProposal: true,
    signal,
  });
  expect(
    (await f.pool.query("select count(*)::int as count from public.organization")).rows[0].count,
  ).toBe(0);
  expect(
    (await f.pool.query("select count(*)::int as count from public.member")).rows[0].count,
  ).toBe(0);
  expect(
    (await f.pool.query('select count(*)::int as count from public."user"')).rows[0].count,
  ).toBe(0);
}, 60000);

test("the reviewed Production app-access profile grants access work without granting Auth ownership", async () => {
  const f = await fixture();
  const role = "auth_operator";
  await expect(planAuthSchemaMigration({ ...f, authOperatorRole: role })).rejects.toThrow(
    "invalid_auth_operator_role",
  );
  const resource = { ...f.resource, environment: "production" as const };
  const input = { ...f, resource, authOperatorRole: role };
  const plan = await planAuthSchemaMigration(input);
  expect(plan.authOperatorRole).toBe(role);
  expect(plan.effects.some((effect) => effect.owner === "operator-privileges")).toBe(true);
  expect(plan.targetDigest).not.toBe(
    (await planAuthSchemaMigration({ ...f, resource })).targetDigest,
  );
  const operator = new Pool({
    connectionString: f.connection.replace("auth_migrator:", "auth_operator:"),
  });
  pools.push(operator);
  await admin.query(
    "grant auth_operator to auth_migrator with admin true, inherit false, set false",
  );
  try {
    await applyAuthSchemaMigration({ ...input, approvedDigest: plan.planDigest });
    await verifyAuthOperatorConnection(operator, resource, role);
  } finally {
    await admin.query("revoke auth_operator from auth_migrator");
  }
  await f.pool
    .query(`insert into public."user" (id,name,email,"emailVerified","createdAt","updatedAt")
    values ('verified','Verified','verified@example.test',true,now(),now()),
    ('unverified','Unverified','unverified@example.test',false,now(),now()),
    ('owner','Owner','owner@example.test',true,now(),now());
    insert into public.organization (id,name,slug,"createdAt") values ('dev','Dev','dev',now());
    insert into public.member (id,"organizationId","userId",role,"createdAt")
      values ('owner-member','dev','owner','owner',now())`);

  await admin.query("grant auth_operator to auth_runtime with set true");
  try {
    await expect(verifyAuthOperatorConnection(operator, resource, role)).rejects.toThrow(
      "auth_operator_identity_or_privilege_mismatch",
    );
  } finally {
    await admin.query("revoke auth_operator from auth_runtime");
  }
  await f.pool.query(
    "create sequence public.operator_scope_test; grant usage on sequence public.operator_scope_test to auth_operator",
  );
  await expect(verifyAuthOperatorConnection(operator, resource, role)).rejects.toThrow(
    "auth_operator_identity_or_privilege_mismatch",
  );
  await f.pool.query("revoke usage on sequence public.operator_scope_test from auth_operator");
  await verifyAuthOperatorConnection(operator, resource, role);
  await expect(operator.query("select id, email from public.user")).resolves.toBeDefined();
  await expect(
    operator.query("select public.lock_auth_operator_user('verified') as found"),
  ).resolves.toMatchObject({ rows: [{ found: true }] });
  await expect(
    operator.query(
      "select public.insert_auth_operator_member('unverified-member','dev','unverified')",
    ),
  ).rejects.toThrow("auth_identity_required");
  await operator.query(
    "select public.insert_auth_operator_member('verified-member','dev','verified')",
  );
  await operator.query("select public.insert_auth_operator_member('other-member','dev','owner')");
  await expect(
    operator.query("select id, role from public.member order by id"),
  ).resolves.toMatchObject({
    rows: [
      { id: "owner-member", role: "owner" },
      { id: "verified-member", role: "member" },
    ],
  });
  await expect(
    operator.query(`update public.organization set "appIds"='[]' where id='missing'`),
  ).resolves.toBeDefined();
  for (const sql of [
    "select password from public.account",
    "select token from public.session",
    "update public.member set role='owner'",
    `insert into public.member (id,"organizationId","userId",role,"createdAt") values ('extra','dev','verified','owner',now())`,
    "delete from public.app_actor_assignment",
    "create table public.unexpected (id text)",
  ]) {
    await expect(operator.query(sql)).rejects.toMatchObject({ code: "42501" });
  }
}, 30_000);

test("aborting an owned Auth worker waits for its exit before removing its spool", async () => {
  const workerDirectory = await mkdtemp(path.join(tmpdir(), "auth-worker-cancellation-"));
  const marker = path.join(workerDirectory, "started.json");
  const executable = path.join(workerDirectory, "worker.mjs");
  const controller = new AbortController();
  let running: ReturnType<typeof runProtectedWorker> | undefined;
  try {
    await writeFile(
      executable,
      `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, spool: process.argv[4] }));
setInterval(() => {}, 1000);
`,
    );
    chmodSync(executable, 0o700);
    const f = await fixture();
    const proposal = await proposeEmptyAuthSchemaMigration({
      resource: f.resource,
      catalogAppIds: f.catalogAppIds,
    });
    running = runProtectedWorker(f, proposal.schemaPlan, executable, {
      signal: controller.signal,
      newEmptyProposal: true,
    });
    // Attach the rejection assertion before triggering cancellation.
    const rejected = expect(running).rejects.toMatchObject({ name: "AbortError" });
    for (let attempt = 0; attempt < 100 && !existsSync(marker); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(marker)).toBe(true);
    const { pid, spool } = JSON.parse(readFileSync(marker, "utf8")) as {
      pid: number;
      spool: string;
    };
    controller.abort();
    await rejected;
    expect(() => process.kill(pid, 0)).toThrow();
    expect(existsSync(path.dirname(spool))).toBe(false);
    expect(
      (await f.pool.query("select to_regclass('public.user') relation")).rows[0].relation,
    ).toBeNull();
  } finally {
    controller.abort();
    await running?.catch(() => {});
    await rm(workerDirectory, { recursive: true, force: true });
  }
});

test("durable creator links reuse a verified actor for a new app without the old session or email equality", async () => {
  const f = await fixture();
  await install(f);
  const sourceId = randomUUID();
  const targetId = randomUUID();
  const sourceDigest = "c".repeat(64);
  const resourceDigest = authDatabaseResourceDigest(f.resource);
  await f.pool.query(`insert into public.organization(id,name,slug,"createdAt","appIds") values
    ('dev','Controlled workspace','dev',now(),'[]')`);
  await f.pool.query(`insert into public."user"(id,name,email,"emailVerified") values
    ('linked-creator','Creator','current@example.test',true)`);
  const invitation = async (id: string, app: string) =>
    f.pool.query(
      `insert into public.app_access_invitation(id,"workspaceId","resourceDigest","appId","organizationId",email,roles,"returnUrl","operationRef","planDigest","scopeDigest","fenceGeneration","expiresAt")
     values($1,'workspace',$2,$3,'dev','different-builder-email@example.test','[]','https://apps.example/new',$4,repeat('b',64),$5,1,now()+interval '1 hour')`,
      [id, resourceDigest, app, randomUUID(), sourceDigest],
    );
  await invitation(sourceId, "original-app");
  await invitation(targetId, "new-app");
  await f.pool.query(
    `update public.app_access_invitation set status='accepted',"verifiedActorId"='linked-creator',"verifiedSessionId"='expired-session',"expiresAt"=now()-interval '1 hour' where id=$1`,
    [sourceId],
  );
  // The protected transport checks Production enrollment; this proof runs the same SQL against an owned local resource.
  const realm = {
    workspaceId: "workspace",
    resource: f.resource,
    authorizedOrganizationIds: ["dev"],
  } as ManagedProductionRealm;
  const client = await f.pool.connect();
  const base = {
    client,
    realm,
    invitationId: targetId,
    sourceInvitationId: sourceId,
    sourceScopeDigest: sourceDigest,
    actorId: "linked-creator",
    assertCurrent: async () => {},
  };
  try {
    await expect(
      linkManagedCreatorIdentity({ ...base, realm: { ...realm, workspaceId: "other" } }),
    ).rejects.toThrow("creator_identity_link_unavailable");
    await expect(
      linkManagedCreatorIdentity({
        ...base,
        realm: { ...realm, resource: { ...realm.resource, database: "other" } },
      }),
    ).rejects.toThrow("creator_identity_link_unavailable");
    await expect(
      linkManagedCreatorIdentity({ ...base, sourceScopeDigest: "d".repeat(64) }),
    ).rejects.toThrow("creator_identity_link_unavailable");
    await expect(linkManagedCreatorIdentity({ ...base, actorId: "deleted-actor" })).rejects.toThrow(
      "creator_identity_link_unavailable",
    );
    await f.pool.query(`update public."user" set "emailVerified"=false where id='linked-creator'`);
    await expect(linkManagedCreatorIdentity(base)).rejects.toThrow(
      "creator_identity_link_unavailable",
    );
    await f.pool.query(`update public."user" set "emailVerified"=true where id='linked-creator'`);
    const sameApp = randomUUID();
    await invitation(sameApp, "original-app");
    await expect(linkManagedCreatorIdentity({ ...base, invitationId: sameApp })).rejects.toThrow(
      "creator_identity_link_unavailable",
    );
    const linked = await linkManagedCreatorIdentity(base);
    expect(linked).toMatchObject({
      status: "verified",
      verifiedActorId: "linked-creator",
      verifiedSessionId: null,
      linkedFromInvitationId: sourceId,
      deliveryStatus: "ready",
    });
    expect(await linkManagedCreatorIdentity(base)).toEqual(linked);
    const membership = {
      client,
      resource: f.resource,
      spec: { workspaceId: "workspace", organizationId: "dev", actorId: "linked-creator" },
      creatorIdentityLink: {
        invitationId: targetId,
        sourceInvitationId: sourceId,
        sourceScopeDigest: sourceDigest,
      },
      assertCurrent: async () => {},
    };
    await f.pool.query(
      `update public.app_access_invitation set "expiresAt"=now()-interval '1 second' where id=$1`,
      [targetId],
    );
    await expect(joinExistingRealmOrganization(membership)).rejects.toThrow(
      "auth_identity_required",
    );
    await f.pool.query(
      `update public.app_access_invitation set "expiresAt"=now()+interval '1 hour' where id=$1`,
      [targetId],
    );
    expect((await joinExistingRealmOrganization(membership)).replayed).toBe(false);
    expect((await joinExistingRealmOrganization(membership)).replayed).toBe(true);
    expect(
      (await f.pool.query(`select role from public.member where "userId"='linked-creator'`)).rows,
    ).toEqual([{ role: "member" }]);
    expect(
      (await f.pool.query(`select * from public.session where "userId"='linked-creator'`)).rows,
    ).toHaveLength(0);
    await f.pool.query(`update public."user" set "emailVerified"=false where id='linked-creator'`);
    await expect(joinExistingRealmOrganization(membership)).rejects.toThrow(
      "auth_identity_required",
    );
    await f.pool.query(`update public."user" set "emailVerified"=true where id='linked-creator'`);
    await f.pool.query(
      `insert into public.app_actor_access("organizationId","actorId","appId","workspaceId",active,roles,"fenceGeneration") values('dev','linked-creator','new-app','workspace',false,'[]',2)`,
    );
    const restore = randomUUID();
    await invitation(restore, "new-app");
    await expect(linkManagedCreatorIdentity({ ...base, invitationId: restore })).rejects.toThrow(
      "creator_identity_link_unavailable",
    );
    await f.pool.query(`update public.app_access_invitation set status='accepted' where id=$1`, [
      targetId,
    ]);
    await expect(joinExistingRealmOrganization(membership)).rejects.toThrow(
      "auth_identity_required",
    );
  } finally {
    client.release();
  }
}, 30_000);

test("invitation membership locks out cancellation, expiry, and unverified accounts before granting", async () => {
  const f = await fixture();
  await install(f);
  const id = randomUUID();
  const scopeDigest = "d".repeat(64);
  const resourceDigest = authDatabaseResourceDigest(f.resource);
  await f.pool.query(`insert into public.organization(id,name,slug,"createdAt","appIds") values
    ('dev','Controlled workspace','dev',now(),'[]')`);
  await f.pool.query(`insert into public."user"(id,name,email,"emailVerified") values
    ('invited','Invited','invited@example.test',true)`);
  await f.pool.query(`insert into public.session(id,token,"userId","expiresAt","updatedAt") values
    ('invited-session','private-invited-token','invited',now()+interval '1 hour',now())`);
  await f.pool.query(
    `insert into public.app_access_invitation(id,"workspaceId","resourceDigest","appId","organizationId",email,roles,"returnUrl","operationRef","planDigest","scopeDigest","fenceGeneration","expiresAt",status,"verifiedActorId","verifiedSessionId")
    values($1,'workspace',$2,'requests','dev','invited@example.test','[]','https://apps.example/requests',$3,repeat('b',64),$4,1,now()+interval '1 hour','verified','invited','invited-session')`,
    [id, resourceDigest, randomUUID(), scopeDigest],
  );
  const realm = {
    workspaceId: "workspace",
    resource: f.resource,
    authorizedOrganizationIds: ["dev"],
  } as ManagedProductionRealm;
  const client = await f.pool.connect();
  const cancelling = await f.pool.connect();
  const input = {
    client,
    resource: f.resource,
    spec: { workspaceId: "workspace", organizationId: "dev", actorId: "invited" },
    realmSessionId: "invited-session",
    invitationIdentity: { invitationId: id, scopeDigest },
    assertCurrent: async () => {},
  };
  try {
    // Cancellation has the row lock before a concurrent membership continuation reads it.
    await cancelling.query("begin");
    await cancelling.query(
      `update public.app_access_invitation set status='cancelled' where id=$1`,
      [id],
    );
    const rejected = expect(joinExistingRealmOrganization(input)).rejects.toThrow(
      "app_invitation_identity_required",
    );
    await cancelling.query("commit");
    await rejected;
    expect((await f.pool.query("select * from public.member")).rows).toHaveLength(0);
    await f.pool.query(
      `update public.app_access_invitation set status='verified',"expiresAt"=now()-interval '1 second' where id=$1`,
      [id],
    );
    await expect(joinExistingRealmOrganization(input)).rejects.toThrow(
      "app_invitation_identity_required",
    );
    await expect(
      updateManagedAppInvitation(client, realm, {
        id,
        scopeDigest,
        fenceGeneration: 2,
        action: "accept",
        actorId: "invited",
      }),
    ).rejects.toThrow();
    await f.pool.query(
      `update public.app_access_invitation set "expiresAt"=now()+interval '1 hour' where id=$1`,
      [id],
    );
    await f.pool.query(`update public."user" set "emailVerified"=false where id='invited'`);
    await expect(joinExistingRealmOrganization(input)).rejects.toThrow(
      "app_invitation_identity_required",
    );
    await f.pool.query(`update public."user" set "emailVerified"=true where id='invited'`);
    expect((await joinExistingRealmOrganization(input)).replayed).toBe(false);
    expect(
      (
        await updateManagedAppInvitation(client, realm, {
          id,
          scopeDigest,
          fenceGeneration: 2,
          action: "accept",
          actorId: "invited",
        })
      ).status,
    ).toBe("accepted");
    // A lost acceptance response remains reconcilable after expiry; it grants nothing again.
    await f.pool.query(
      `update public.app_access_invitation set "expiresAt"=now()-interval '1 second' where id=$1`,
      [id],
    );
    expect(
      (
        await updateManagedAppInvitation(client, realm, {
          id,
          scopeDigest,
          fenceGeneration: 2,
          action: "accept",
          actorId: "invited",
        })
      ).status,
    ).toBe("accepted");
    await expect(joinExistingRealmOrganization(input)).rejects.toThrow(
      "app_invitation_identity_required",
    );
    expect((await f.pool.query("select role from public.member")).rows).toEqual([
      { role: "member" },
    ]);
  } finally {
    await cancelling.query("rollback");
    cancelling.release();
    client.release();
  }
}, 30_000);

test("runtime preflight rejects direct, PUBLIC, and inherited managed-app table or column writes", async () => {
  const f = await fixture();
  await install(f);
  const runtime = new Pool({
    connectionString: f.connection.replace("auth_migrator:", "auth_runtime:"),
  });
  pools.push(runtime);
  const inheritedRole = `acl_${randomUUID().replaceAll("-", "")}`;
  await admin.query(
    `create role "${inheritedRole}" nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls`,
  );
  await admin.query(`grant "${inheritedRole}" to auth_runtime`);
  try {
    await expect(
      verifyAuthDatabaseResource(runtime, f.resource, "runtime"),
    ).resolves.toBeUndefined();
    for (const table of ["app_actor_access", "app_access_invitation"]) {
      for (const grantee of ["auth_runtime", inheritedRole, "public"]) {
        for (const privilege of [
          "INSERT",
          "UPDATE",
          "DELETE",
          "TRUNCATE",
          "REFERENCES",
          "TRIGGER",
          'INSERT ("appId")',
          'UPDATE ("appId")',
          'REFERENCES ("appId")',
        ]) {
          const target = grantee === "public" ? "public" : `"${grantee}"`;
          await f.pool.query(`grant ${privilege} on public.${table} to ${target}`);
          await expect(verifyAuthDatabaseResource(runtime, f.resource, "runtime")).rejects.toThrow(
            "runtime can mutate operator-owned Auth records",
          );
          // Verify the real runtime pool performs this check before exposing its first query.
          const checked = createAuthPool(
            f.connection.replace("auth_migrator:", "auth_runtime:"),
            f.resource,
            "runtime",
          );
          try {
            await expect(checked.query("select 1")).rejects.toThrow(
              "runtime can mutate operator-owned Auth records",
            );
          } finally {
            await checked.end();
          }
          await f.pool.query(`revoke ${privilege} on public.${table} from ${target}`);
          await expect(
            verifyAuthDatabaseResource(runtime, f.resource, "runtime"),
          ).resolves.toBeUndefined();
        }
      }
    }
    // Existing frozen Preview realms need no new managed tables to keep their old login path.
    await f.pool.query("drop table public.app_access_invitation, public.app_actor_access");
    await expect(
      verifyAuthDatabaseResource(runtime, f.resource, "runtime"),
    ).resolves.toBeUndefined();
  } finally {
    await admin.query(`revoke "${inheritedRole}" from auth_runtime`);
    await admin.query(`drop role "${inheritedRole}"`);
  }
}, 30_000);
