import assert from "node:assert/strict";
import { prepareProtectedInstallerTestRelease } from "./protected-installer-test-fixture";
import { inspectNeonResource } from "../../../../packages/provisioning/neon-resource-bootstrap-worker";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { createServer } from "node:net";
import { Pool } from "pg";
import { verifyCheckedRelease } from "../../../../packages/generated-app-runtime/server";
import {
  createProtectedGeneratedInstaller,
  PROTECTED_GENERATED_APP_INSTALLER_ID,
  type ProtectedGeneratedPlan,
} from "../../../../packages/generated-app-runtime/protected-installer";
import {
  digestResourceBootstrapContext,
  digestResourceBootstrapCredentials,
  type ResourceBootstrapContext,
} from "../../../../packages/protected-installer/node-spool";

import { createPostgresDataContext } from "../../../../packages/generated-app-runtime/postgres";
import { readPostgresAppActorBinding } from "../../../../packages/generated-app-runtime/actor-binding";

const root = path.resolve(import.meta.dirname, "../../../..");
const scratch = await mkdtemp(path.join(tmpdir(), "neon-resource-bootstrap-"));
const releaseDirectory = await prepareProtectedInstallerTestRelease(root, scratch);
const manifest = verifyCheckedRelease(releaseDirectory);
const pgData = path.join(scratch, "pgdata");
const binary = path.join(scratch, "neon-resource-bootstrap");
const password = `bootstrap-${randomUUID()}-password`;
async function allocatePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string")
        return reject(new Error("fixture port unavailable"));
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}
let port = await allocatePort();
const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TMPDIR: tmpdir() };
function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8", env });
  if (result.status !== 0)
    throw new Error(`Disposable PostgreSQL ${command} failed: ${result.stderr}`);
}
let adminUrl = `postgresql://resource_bootstrap:${encodeURIComponent(password)}@127.0.0.1:${port}/postgres?sslmode=disable`;
const credentials = {
  migratorPassword: `migrator-%41-%invalid-${randomUUID()}-credential-long-enough`,
  runtimePassword: `runtime-%41-%invalid-${randomUUID()}-credential-long-enough`,
};
const context: ResourceBootstrapContext = {
  kind: "neon_resource_bootstrap" as const,
  version: 1 as const,
  operation: { operation_id: randomUUID(), approval_digest: "a".repeat(64), fence_generation: 1 },
  app_id: "platform-fixture",
  resource: {
    scope: "app_database" as const,
    resource_id: "resource_fixture_app",
    environment: "local" as const,
    hostname: "127.0.0.1",
    port,
    database: "fixture_app_db",
    migrator_role: "fixture_app_migrator",
    runtime_role: "fixture_app_runtime",
    maintenance_database: "postgres",
    bootstrap_role: "resource_bootstrap",
    credentials_sha256: digestResourceBootstrapCredentials(credentials),
  },
  release: { id: "schema-fixture", sha256: "b".repeat(64) },
  installer: { id: "neon-resource-bootstrap-v1", sha256: "c".repeat(64) },
  tenant_targets: [] as [],
};

async function launch(
  runNumber: number,
  options: {
    denyEffect?: string;
    denyFenceAfterDatabase?: boolean;
    command?: "neon-resource-bootstrap" | "neon-resource-inspect";
    workerContext?: ResourceBootstrapContext;
    workerCredentials?: typeof credentials;
  } = {},
) {
  const workerContext = options.workerContext ?? context;
  const workerCredentials = options.workerCredentials ?? credentials;
  const spool = path.join(scratch, `spool-${runNumber}`);
  for (const name of ["startup", "requests", "responses", "lifecycle"])
    await mkdir(path.join(spool, name), { recursive: true });
  await writeFile(path.join(spool, "startup/context.json"), JSON.stringify(workerContext));
  await writeFile(path.join(spool, "startup/direct-database-url.json"), JSON.stringify(adminUrl));
  await writeFile(
    path.join(spool, "startup/resource-credentials.json"),
    JSON.stringify(workerCredentials),
  );
  const runId = randomUUID();
  await writeFile(
    path.join(spool, "startup/ready.json"),
    JSON.stringify({ version: 1, run_id: runId, frame_id: 0 }),
  );
  const child = spawn(
    binary,
    [options.command ?? "neon-resource-bootstrap", "--file-spool", spool, runId, "10000"],
    {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  // Capture exit before draining stdout: a fast worker may close while the
  // async iterator is still consuming its final lifecycle notice.
  const completion = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const lines = createInterface({ input: child.stdout });
  let requestCount = 0;
  const lifecycle: Array<{ kind: string; failure_code?: string }> = [];
  const receipts: Array<{ effectId: string; state: string }> = [];
  for await (const line of lines) {
    const notice = JSON.parse(line) as { kind: string; frame_id?: number };
    if (notice.kind === "protected_installer_lifecycle_ready" && notice.frame_id !== undefined) {
      lifecycle.push(
        JSON.parse(
          await readFile(path.join(spool, "lifecycle", `${notice.frame_id}.json`), "utf8"),
        ),
      );
      continue;
    }
    if (notice.kind !== "protected_installer_frame_ready" || notice.frame_id === undefined)
      continue;
    const frameId = notice.frame_id;
    const requestPath = path.join(spool, "requests", `${frameId}.json`);
    const request = JSON.parse(await readFile(requestPath, "utf8")) as {
      kind: string;
      operation_id: string;
      context_digest: string;
      fence_generation: number;
      sequence: number;
      effect_id: string;
      resource_id: string;
      tenant_id: string | null;
      receipt?: { state: string };
    };
    requestCount += 1;
    assert.equal(request.context_digest, digestResourceBootstrapContext(workerContext));
    assert.equal(request.resource_id, workerContext.resource.resource_id);
    assert.equal(request.tenant_id, null);
    for (const secret of [
      password,
      workerCredentials.migratorPassword,
      workerCredentials.runtimePassword,
    ])
      assert(!JSON.stringify(request).includes(secret));
    if (request.kind === "check_fence") {
      assert.equal(request.sequence, undefined);
      assert.equal(request.effect_id, undefined);
      let current = true;
      if (options.denyFenceAfterDatabase) {
        const native = new Pool({ connectionString: adminUrl });
        try {
          const database = await native.query(
            "select pg_get_userbyid(datdba) as owner, shobj_description(oid,'pg_database') as comment from pg_database where datname=$1",
            [workerContext.resource.database],
          );
          current = !(
            database.rows[0]?.owner === workerContext.resource.migrator_role &&
            database.rows[0]?.comment === null
          );
        } finally {
          await native.end();
        }
      }
      await writeFile(
        path.join(spool, "responses", `${frameId}.json`),
        JSON.stringify({
          kind: "fence_current",
          version: 1,
          operation_id: request.operation_id,
          context_digest: request.context_digest,
          fence_generation: request.fence_generation,
          current,
        }),
      );
      await writeFile(
        path.join(spool, "responses", `${frameId}.ready`),
        JSON.stringify({ version: 1, run_id: runId, frame_id: frameId }),
      );
      continue;
    }
    let allowed = true;
    if (options.denyEffect === request.effect_id && request.kind === "authorize_effect")
      allowed = false;
    if (request.kind === "authorize_effect")
      assert(
        ["resources:roles", "resources:database", "resources:acl"].includes(request.effect_id),
      );
    const common = {
      version: 1,
      operation_id: request.operation_id,
      context_digest: request.context_digest,
      fence_generation: request.fence_generation,
      sequence: request.sequence,
      effect_id: request.effect_id,
    };
    if (request.kind === "checkpoint_effect")
      receipts.push({ effectId: request.effect_id, state: request.receipt?.state ?? "missing" });
    const reply =
      request.kind === "authorize_effect"
        ? { kind: "effect_authorized", ...common, allowed }
        : { kind: "checkpoint_recorded", ...common, recorded: true };
    await writeFile(path.join(spool, "responses", `${frameId}.json`), JSON.stringify(reply));
    await writeFile(
      path.join(spool, "responses", `${frameId}.ready`),
      JSON.stringify({ version: 1, run_id: runId, frame_id: frameId }),
    );
  }
  const exitCode = await completion;
  for (const secret of [
    password,
    workerCredentials.migratorPassword,
    workerCredentials.runtimePassword,
  ])
    assert(!stderr.includes(secret));
  assert.deepEqual(
    lifecycle.map((fact) => fact.kind),
    exitCode === 0
      ? ["worker_started", "worker_succeeded"]
      : lifecycle[0]?.kind === "worker_started"
        ? ["worker_started", "worker_failed"]
        : ["worker_failed"],
  );
  return { exitCode, stderr, requestCount, receipts, spool, lifecycle };
}

let postgresStarted = false;
try {
  run("initdb", [
    "-D",
    pgData,
    "--auth-local=trust",
    "--auth-host=trust",
    "--username=fixture_root",
    "--no-locale",
    "--encoding=UTF8",
  ]);
  for (;;) {
    const previousLog = await readFile(path.join(scratch, "postgres.log"), "utf8").catch(() => "");
    try {
      run("pg_ctl", [
        "-D",
        pgData,
        "-l",
        path.join(scratch, "postgres.log"),
        "-o",
        `-h 127.0.0.1 -p ${port}`,
        "-w",
        "start",
      ]);
      break;
    } catch (error) {
      const log = await readFile(path.join(scratch, "postgres.log"), "utf8");
      if (!log.slice(previousLog.length).includes("Address already in use")) throw error;
      port = await allocatePort();
      context.resource.port = port;
      adminUrl = `postgresql://resource_bootstrap:${encodeURIComponent(password)}@127.0.0.1:${port}/postgres?sslmode=disable`;
    }
  }
  postgresStarted = true;
  const superuser = new Pool({
    connectionString: `postgresql://fixture_root@127.0.0.1:${port}/postgres?sslmode=disable`,
  });
  try {
    await superuser.query(`alter role fixture_root password '${password}'`);
    await superuser.query(
      `create role resource_bootstrap login password '${password}' createdb createrole nosuperuser noreplication nobypassrls noinherit`,
    );
  } finally {
    await superuser.end();
  }
  // Exercise the real catalog identity read in a disposable PostgreSQL cluster.
  // Neon settings here are synthetic Preview fixtures, never hosted resource proof.
  const ownerControls = new Pool({
    connectionString: `postgresql://fixture_root@127.0.0.1:${port}/postgres?sslmode=disable`,
  });
  const identityConnections = new Pool({ connectionString: adminUrl });
  const previewIdentity = await identityConnections.connect();
  const localIdentity = await identityConnections.connect();
  const previewContext: ResourceBootstrapContext = {
    ...context,
    resource: {
      ...context.resource,
      environment: "preview",
      hostname: "ep-preview-fixture.neon.tech",
      provider_project_id: "project_fixture",
      provider_branch_id: "branch_fixture",
      provider_endpoint_id: "endpoint_fixture",
    },
  };
  const currentIdentity = async () => {};
  try {
    await previewIdentity.query(
      `select set_config('neon.project_id',$1,false),
              set_config('neon.branch_id',$2,false),
              set_config('neon.endpoint_id',$3,false)`,
      ["project_fixture", "branch_fixture", "endpoint_fixture"],
    );
    for (const attributes of [
      "noreplication nobypassrls",
      "replication nobypassrls",
      "noreplication bypassrls",
      "replication bypassrls",
    ]) {
      await ownerControls.query(`alter role resource_bootstrap ${attributes}`);
      assert.equal(
        (
          await inspectNeonResource({
            client: previewIdentity,
            context: previewContext,
            assertCurrent: currentIdentity,
          })
        ).status,
        "absent",
      );
      assert.equal(
        (
          await inspectNeonResource({
            client: previewIdentity,
            context: {
              ...previewContext,
              resource: { ...previewContext.resource, environment: "production" },
            },
            assertCurrent: currentIdentity,
          })
        ).status,
        "absent",
      );
      assert.equal(
        (
          await inspectNeonResource({
            client: localIdentity,
            context,
            assertCurrent: currentIdentity,
          })
        ).status,
        attributes === "noreplication nobypassrls" ? "absent" : "unknown",
      );
    }
    for (const changedResource of [
      { provider_project_id: "other_project" },
      { provider_branch_id: "other_branch" },
      { provider_endpoint_id: "other_endpoint" },
      { maintenance_database: "other_database" },
      { bootstrap_role: "other_role" },
    ]) {
      assert.equal(
        (
          await inspectNeonResource({
            client: previewIdentity,
            context: {
              ...previewContext,
              resource: { ...previewContext.resource, ...changedResource },
            },
            assertCurrent: currentIdentity,
          })
        ).status,
        "unknown",
      );
    }
    for (const attributes of ["superuser", "nocreatedb", "nocreaterole"]) {
      await ownerControls.query("alter role resource_bootstrap nosuperuser createdb createrole");
      await ownerControls.query(`alter role resource_bootstrap ${attributes}`);
      assert.equal(
        (
          await inspectNeonResource({
            client: previewIdentity,
            context: previewContext,
            assertCurrent: currentIdentity,
          })
        ).status,
        "unknown",
      );
    }
    assert.equal(
      (
        await inspectNeonResource({
          client: previewIdentity,
          context: previewContext,
          assertCurrent: async () => {
            throw new Error("stale fence");
          },
        })
      ).status,
      "unknown",
    );
  } finally {
    await ownerControls.query(
      "alter role resource_bootstrap nosuperuser createdb createrole noreplication nobypassrls",
    );
    previewIdentity.release(true);
    localIdentity.release(true);
    await identityConnections.end();
    await ownerControls.end();
  }

  const bundled = spawnSync(
    "bun",
    [
      path.join(root, ".config/mise/scripts/repository/build-neon-resource-bootstrap-worker.mjs"),
      scratch,
    ],
    { cwd: root, encoding: "utf8", env },
  );
  if (bundled.status !== 0) throw new Error("Resource worker fixture bundle failed");
  const built = spawnSync(
    "bun",
    [
      "build",
      path.join(scratch, "neon-resource-bootstrap-worker.js"),
      "--compile",
      "--outfile",
      binary,
    ],
    { cwd: root, encoding: "utf8", env },
  );
  if (built.status !== 0) throw new Error(`Worker compile failed: ${built.stderr}`);

  const emptyInspection = await launch(30, { command: "neon-resource-inspect" });
  assert.equal(emptyInspection.exitCode, 0, emptyInspection.stderr);
  assert.equal(emptyInspection.receipts.length, 0);
  const absentObservation = JSON.parse(
    await readFile(path.join(emptyInspection.spool, "resource-observation.json"), "utf8"),
  );
  assert.equal(absentObservation.status, "absent");
  assert.equal(absentObservation.resource_id, context.resource.resource_id);
  assert(emptyInspection.requestCount >= 4);
  const wrongInstaller = await launch(16, {
    workerContext: { ...context, installer: { ...context.installer, id: "another-installer" } },
  });
  assert.notEqual(wrongInstaller.exitCode, 0);
  assert.equal(wrongInstaller.requestCount, 0);
  assert(wrongInstaller.stderr.includes("startup_rejected"));

  const denied = await launch(1, { denyEffect: "resources:database" });
  assert.notEqual(denied.exitCode, 0);
  assert(denied.stderr.includes("authority_denied"));
  assert.equal(denied.requestCount, 3); // roles authorized/checkpointed; database authorization denied

  // Model a CREATE DATABASE whose owner is known but whose comment/checkpoint was interrupted.
  const bootstrap = new Pool({ connectionString: adminUrl });
  try {
    const roles = await bootstrap.query(
      "select rolname,rolcanlogin,rolcreatedb,rolcreaterole,rolsuper from pg_roles where rolname=any($1::text[])",
      [[context.resource.migrator_role, context.resource.runtime_role]],
    );
    assert.equal(roles.rows.length, 2);
    assert.equal(
      roles.rows.find((role) => role.rolname === context.resource.migrator_role)?.rolcreaterole,
      true,
    );
    assert.equal(
      roles.rows.find((role) => role.rolname === context.resource.migrator_role)?.rolcreatedb,
      false,
    );
    assert.equal(
      roles.rows.find((role) => role.rolname === context.resource.runtime_role)?.rolcreaterole,
      false,
    );
    await bootstrap.query(
      "grant fixture_app_migrator to resource_bootstrap with set true, inherit false",
    );
    await bootstrap.query("create database fixture_app_db owner fixture_app_migrator");
    await bootstrap.query("revoke fixture_app_migrator from resource_bootstrap");
  } finally {
    await bootstrap.end();
  }

  // Matching owner alone is not interrupted-creation provenance.
  const unknown = await launch(12);
  assert.notEqual(unknown.exitCode, 0);
  const provenance = new Pool({ connectionString: adminUrl });
  try {
    assert.equal(
      (
        await provenance.query(
          "select shobj_description(oid,'pg_database') comment from pg_database where datname='fixture_app_db'",
        )
      ).rows[0]?.comment,
      null,
    );
  } finally {
    await provenance.end();
  }
  const fixtureOwner = new Pool({
    connectionString: `postgresql://fixture_root@127.0.0.1:${port}/postgres?sslmode=disable`,
  });
  try {
    await fixtureOwner.query("drop database fixture_app_db");
  } finally {
    await fixtureOwner.end();
  }
  // A real compiled worker writes its durable intent and creates AppDB before losing its fence.
  const interrupted = await launch(18, { denyFenceAfterDatabase: true });
  assert.notEqual(interrupted.exitCode, 0);
  assert(
    !interrupted.receipts.some(
      (receipt) =>
        receipt.effectId === "resources:database" &&
        ["applied", "no_change"].includes(receipt.state),
    ),
  );
  const pending = new Pool({ connectionString: adminUrl });
  try {
    assert.deepEqual(
      (
        await pending.query(
          "select pg_get_userbyid(datdba) as owner, shobj_description(oid,'pg_database') as comment from pg_database where datname='fixture_app_db'",
        )
      ).rows[0],
      { owner: context.resource.migrator_role, comment: null },
    );
    assert.equal(
      (
        await pending.query(
          "select shobj_description(oid,'pg_authid') as comment from pg_roles where rolname=$1",
          [context.resource.migrator_role],
        )
      ).rows[0]?.comment,
      "protected-resource:v1:app_database:resource_fixture_app:migrator:database-create-pending:fixture_app_db",
    );
    assert.equal(
      (
        await pending.query(
          "select exists(select 1 from pg_auth_members m join pg_roles granted on granted.oid=m.roleid join pg_roles member on member.oid=m.member where granted.rolname=$1 and member.rolname=$2 and (m.set_option or m.inherit_option)) as enabled",
          [context.resource.migrator_role, context.resource.bootstrap_role],
        )
      ).rows[0]?.enabled,
      false,
    );
  } finally {
    await pending.end();
  }

  const resumed = await launch(2);
  assert.equal(resumed.exitCode, 0, resumed.stderr);
  assert(resumed.requestCount > 6);
  assert.deepEqual(resumed.receipts, [
    { effectId: "resources:roles", state: "no_change" },
    { effectId: "resources:database", state: "applied" },
    { effectId: "resources:acl", state: "applied" },
  ]);
  const ownedInspection = await launch(31, { command: "neon-resource-inspect" });
  assert.equal(ownedInspection.exitCode, 0, ownedInspection.stderr);
  assert.equal(ownedInspection.receipts.length, 0);
  assert.equal(
    JSON.parse(
      await readFile(path.join(ownedInspection.spool, "resource-observation.json"), "utf8"),
    ).status,
    "applied",
  );
  const uncertainInspection = await launch(32, {
    command: "neon-resource-inspect",
    workerContext: {
      ...context,
      resource: { ...context.resource, resource_id: "foreign-resource" },
    },
  });
  assert.notEqual(uncertainInspection.exitCode, 0);
  assert.deepEqual(
    uncertainInspection.lifecycle.map((fact) => fact.kind),
    ["worker_started", "worker_failed"],
  );
  assert.equal(uncertainInspection.lifecycle.at(-1)?.failure_code, "readback_unknown");
  const inspectConnection = new Pool({ connectionString: adminUrl });
  try {
    const client = await inspectConnection.connect();
    try {
      const current = async () => {};
      assert.equal(
        (
          await inspectNeonResource({
            client,
            context: {
              ...context,
              resource: { ...context.resource, resource_id: "foreign-resource" },
            },
            assertCurrent: current,
          })
        ).status,
        "unknown",
      );
      assert.equal(
        (
          await inspectNeonResource({
            client,
            context,
            assertCurrent: async () => {
              throw new Error("stale fence");
            },
          })
        ).status,
        "unknown",
      );
    } finally {
      client.release();
    }
    const disconnected = await inspectConnection.connect();
    disconnected.release(true);
    assert.equal(
      (await inspectNeonResource({ client: disconnected, context, assertCurrent: async () => {} }))
        .status,
      "unknown",
    );
  } finally {
    await inspectConnection.end();
  }
  const verify = new Pool({ connectionString: adminUrl });
  try {
    const management = await verify.query(
      `select exists(select 1 from pg_auth_members m join pg_roles r on r.oid=m.roleid join pg_roles member on member.oid=m.member where r.rolname='fixture_app_migrator' and member.rolname='resource_bootstrap' and m.admin_option) as admin,pg_has_role('resource_bootstrap','fixture_app_migrator','SET') as can_set`,
    );
    assert.equal(management.rows[0]?.admin, true);
    assert.equal(management.rows[0]?.can_set, false);
    const state =
      await verify.query(`select d.datname, r.rolname owner, shobj_description(d.oid,'pg_database') comment,
      has_database_privilege('fixture_app_runtime',d.datname,'CONNECT') connect,
      has_database_privilege('fixture_app_runtime',d.datname,'CREATE') create_db,
      has_database_privilege('fixture_app_runtime',d.datname,'TEMP') temp
      from pg_database d join pg_roles r on r.oid=d.datdba where d.datname='fixture_app_db'`);
    assert.deepEqual(state.rows[0], {
      datname: "fixture_app_db",
      owner: "fixture_app_migrator",
      comment: "protected-resource:v1:app_database:resource_fixture_app:database",
      connect: true,
      create_db: false,
      temp: false,
    });
    const membership = await verify.query(
      "select pg_has_role('resource_bootstrap','fixture_app_migrator','SET') member",
    );
    assert.equal(membership.rows[0]?.member, false);
    const login = new Pool({
      connectionString: `postgresql://fixture_app_runtime:${encodeURIComponent(credentials.runtimePassword)}@127.0.0.1:${port}/fixture_app_db?sslmode=disable`,
    });
    try {
      const privileges =
        await login.query(`select current_user,has_schema_privilege(current_user,'public','USAGE') usage,
        has_schema_privilege(current_user,'public','CREATE') create_schema,
        has_database_privilege(current_user,current_database(),'TEMP') temp`);
      assert.deepEqual(privileges.rows[0], {
        current_user: "fixture_app_runtime",
        usage: true,
        create_schema: false,
        temp: false,
      });
    } finally {
      await login.end();
    }
  } finally {
    await verify.end();
  }

  const roleControls = new Pool({
    connectionString: `postgresql://fixture_root@127.0.0.1:${port}/postgres?sslmode=disable`,
  });
  const restrictedRoles = new Pool({ connectionString: adminUrl });
  const inspectRestrictedRoles = async () =>
    await inspectNeonResource({
      client: restrictedRoles,
      context,
      assertCurrent: async () => {},
      credentials,
      maintenanceUrl: adminUrl,
    });
  try {
    assert.equal((await inspectRestrictedRoles()).status, "applied");
    for (const role of [context.resource.migrator_role, context.resource.runtime_role]) {
      for (const attribute of ["replication", "bypassrls"]) {
        await roleControls.query(`alter role "${role}" ${attribute}`);
        assert.equal((await inspectRestrictedRoles()).status, "unknown");
        await roleControls.query(`alter role "${role}" noreplication nobypassrls`);
        assert.equal((await inspectRestrictedRoles()).status, "applied");
      }
    }
  } finally {
    for (const role of [context.resource.migrator_role, context.resource.runtime_role]) {
      await roleControls.query(`alter role "${role}" noreplication nobypassrls`);
    }
    await restrictedRoles.end();
    await roleControls.end();
  }

  const retry = await launch(3);
  assert.equal(retry.exitCode, 0, retry.stderr);
  assert(retry.requestCount > 6);
  assert.deepEqual(retry.receipts, [
    { effectId: "resources:roles", state: "no_change" },
    { effectId: "resources:database", state: "no_change" },
    { effectId: "resources:acl", state: "no_change" },
  ]);

  // Standalone workers serialize the same real role/database identities.
  const concurrent = await Promise.all([launch(13), launch(14)]);
  for (const result of concurrent) {
    assert.equal(result.exitCode, 0, result.stderr);
    assert(result.receipts.every((receipt) => receipt.state === "no_change"));
  }
  // An unrelated pre-existing SET grant is not silently consumed on retry.
  const existingGrant = new Pool({ connectionString: adminUrl });
  try {
    await existingGrant.query(
      "grant fixture_app_migrator to resource_bootstrap with set true, inherit false",
    );
  } finally {
    await existingGrant.end();
  }
  const rejectedGrant = await launch(15);
  assert.notEqual(rejectedGrant.exitCode, 0);
  const grantReadback = new Pool({ connectionString: adminUrl });
  try {
    assert.equal(
      (
        await grantReadback.query(
          "select pg_has_role('resource_bootstrap','fixture_app_migrator','SET') present",
        )
      ).rows[0]?.present,
      true,
    );
    await grantReadback.query("revoke fixture_app_migrator from resource_bootstrap");
  } finally {
    await grantReadback.end();
  }

  const readerGrant = new Pool({ connectionString: adminUrl });
  try {
    await readerGrant.query(
      "create role unrelated_data_reader nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls",
    );
    await readerGrant.query("grant unrelated_data_reader to fixture_app_runtime");
  } finally {
    await readerGrant.end();
  }
  const unknownReader = await launch(17);
  assert.notEqual(unknownReader.exitCode, 0);
  const readerCleanup = new Pool({ connectionString: adminUrl });
  try {
    await readerCleanup.query("revoke unrelated_data_reader from fixture_app_runtime");
  } finally {
    await readerCleanup.end();
  }

  const authCredentials = {
    migratorPassword: `auth-migrator-${randomUUID()}-credential-long-enough`,
    runtimePassword: `auth-runtime-${randomUUID()}-credential-long-enough`,
  };
  const authContext: ResourceBootstrapContext = {
    ...context,
    app_id: "auth",
    operation: { ...context.operation, operation_id: randomUUID(), fence_generation: 2 },
    resource: {
      ...context.resource,
      scope: "auth_database",
      resource_id: "resource_fixture_auth",
      database: "fixture_auth_db",
      migrator_role: "fixture_auth_migrator",
      runtime_role: "fixture_auth_runtime",
      credentials_sha256: digestResourceBootstrapCredentials(authCredentials),
    },
  };
  const authRun = await launch(4, {
    workerContext: authContext,
    workerCredentials: authCredentials,
  });
  assert.equal(authRun.exitCode, 0, authRun.stderr);
  const authVerify = new Pool({ connectionString: adminUrl });
  try {
    const authRoles = await authVerify.query(
      "select rolname,rolcreaterole from pg_roles where rolname in ('fixture_auth_migrator','fixture_auth_runtime') order by rolname",
    );
    assert.deepEqual(authRoles.rows, [
      { rolname: "fixture_auth_migrator", rolcreaterole: false },
      { rolname: "fixture_auth_runtime", rolcreaterole: false },
    ]);
  } finally {
    await authVerify.end();
  }
  const authMigrator = new Pool({
    connectionString: `postgresql://fixture_auth_migrator:${encodeURIComponent(authCredentials.migratorPassword)}@127.0.0.1:${port}/fixture_auth_db?sslmode=disable`,
  });
  try {
    await authMigrator.query(
      `create table public.app_actor_assignment ("organizationId" text,"actorId" text,"appId" text,role text,active boolean,"fence_generation" bigint,primary key("organizationId","actorId","appId",role))`,
    );
    await authMigrator.query("grant select on public.app_actor_assignment to fixture_auth_runtime");
  } finally {
    await authMigrator.end();
  }

  const trust = {
    id: PROTECTED_GENERATED_APP_INSTALLER_ID,
    sqlBundleHash: createHash("sha256")
      .update(await readFile(path.join(releaseDirectory, "sql-bundle.sql")))
      .digest("hex"),
  };
  const resource = (name: "app" | "auth") => ({
    resourceId: `resource_fixture_${name}`,
    environment: "local" as const,
    hostname: "127.0.0.1",
    port,
    database: name === "app" ? "fixture_app_db" : "fixture_auth_db",
    schema: "public" as const,
    migratorRole: name === "app" ? "fixture_app_migrator" : "fixture_auth_migrator",
    runtimeRole: name === "app" ? "fixture_app_runtime" : "fixture_auth_runtime",
  });
  const plan: ProtectedGeneratedPlan = {
    version: 1,
    appId: "platform-fixture",
    app: resource("app"),
    auth: resource("auth"),
    release: {
      id: manifest.schema_version,
      artifactHash: manifest.hashes.schema!.replace(/^sha256:/u, ""),
      manifestHash: createHash("sha256")
        .update(await readFile(path.join(releaseDirectory, "release-manifest.json")))
        .digest("hex"),
    },
    installer: trust,
    organizations: [
      {
        organizationId: "fixture_org",
        actors: [{ actorId: "fixture_actor", actorKind: "human", roles: ["fixture_primary"] }],
      },
    ],
  };
  const installed = await createProtectedGeneratedInstaller({
    plan,
    trust,
    fenceGeneration: 1,
    releaseDirectory,
    connections: {
      appMigrator: `postgresql://fixture_app_migrator:${encodeURIComponent(credentials.migratorPassword)}@127.0.0.1:${port}/fixture_app_db?sslmode=disable`,
      appRuntime: `postgresql://fixture_app_runtime:${encodeURIComponent(credentials.runtimePassword)}@127.0.0.1:${port}/fixture_app_db?sslmode=disable`,
      authMigrator: `postgresql://fixture_auth_migrator:${encodeURIComponent(authCredentials.migratorPassword)}@127.0.0.1:${port}/fixture_auth_db?sslmode=disable`,
      authRuntime: `postgresql://fixture_auth_runtime:${encodeURIComponent(authCredentials.runtimePassword)}@127.0.0.1:${port}/fixture_auth_db?sslmode=disable`,
    },
    assertCurrent: async () => {},
  }).install();
  assert.equal(installed.releaseId, manifest.schema_version);
  const appBindingOwner = new Pool({
    connectionString: `postgresql://fixture_app_migrator:${encodeURIComponent(credentials.migratorPassword)}@127.0.0.1:${port}/fixture_app_db?sslmode=disable`,
  });
  try {
    const bound = await appBindingOwner.query(
      "select kernel_bind_actor_membership($1::jsonb) as result",
      [
        JSON.stringify({
          principal_name: "fixture_app_runtime",
          app_id: "platform-fixture",
          customer_id: "fixture_org",
          actor_id: "fixture_actor",
          actor_kind: "human",
          role: "fixture_primary",
          active: true,
          fence_generation: 1,
        }),
      ],
    );
    assert.equal(bound.rows[0]?.result.ok, true);
  } finally {
    await appBindingOwner.end();
  }
  const runtimeRead = new Pool({
    connectionString: `postgresql://fixture_app_runtime:${encodeURIComponent(credentials.runtimePassword)}@127.0.0.1:${port}/fixture_app_db?sslmode=disable`,
  });
  try {
    const currentBinding = await readPostgresAppActorBinding({
      pool: runtimeRead,
      appId: "platform-fixture",
      actorId: "fixture_actor",
      organizationId: "fixture_org",
      role: "fixture_primary",
    });
    assert.deepEqual(currentBinding, {
      appId: "platform-fixture",
      actorId: "fixture_actor",
      organizationId: "fixture_org",
      role: "fixture_primary",
      active: true,
      fenceGeneration: 1,
    });
    const omitted = await runtimeRead.query("select kernel_data_query($1::jsonb) as result", [
      JSON.stringify({
        app_id: "platform-fixture",
        customer_id: "fixture_org",
        schema_version: manifest.schema_version,
        model_id: "fixture_record",
        kind: "aggregate",
        metrics: [{ fn: "count" }],
        as_of: new Date().toISOString(),
      }),
    ]);
    assert.equal(omitted.rows[0]?.result.error.code, "authorization_denied");
    const capturedBinding = { role: "fixture_primary", fenceGeneration: 1 };
    const context = createPostgresDataContext({
      pool: runtimeRead,
      appId: "platform-fixture",
      customerId: "fixture_org",
      actorId: "fixture_actor",
      actorBinding: capturedBinding,
      sourceKind: "fixture",
      authorize: async () => {},
      verifyRelease: () => {},
    });
    capturedBinding.role = "unassigned";
    capturedBinding.fenceGeneration = 99;
    const capturedRead = await context.transaction((session) =>
      session.call("kernel_data_query", {
        schema_version: manifest.schema_version,
        model_id: "fixture_record",
        kind: "aggregate",
        metrics: [{ fn: "count" }],
        as_of: new Date().toISOString(),
      }),
    );
    assert(capturedRead !== undefined);
    const runtimeConnection = await runtimeRead.connect();
    try {
      await runtimeConnection.query("begin");
      await runtimeConnection.query(
        "select set_config('kernel.actor_id','fixture_actor',true),set_config('kernel.actor_role','fixture_primary',true),set_config('kernel.actor_fence_generation','1',true)",
      );
      const readback = await runtimeConnection.query(
        "select current_user as role,kernel_data_query($1::jsonb) as result",
        [
          JSON.stringify({
            app_id: "platform-fixture",
            customer_id: "fixture_org",
            schema_version: manifest.schema_version,
            model_id: "fixture_record",
            kind: "aggregate",
            metrics: [{ fn: "count" }],
            as_of: new Date().toISOString(),
          }),
        ],
      );
      assert.equal(readback.rows[0].role, "fixture_app_runtime");
      assert.equal(readback.rows[0].result.ok, true);
      await runtimeConnection.query("commit");
    } finally {
      await runtimeConnection.query("rollback");
      runtimeConnection.release();
    }
  } finally {
    await runtimeRead.end();
  }
  console.log("Neon resource bootstrap disposable PostgreSQL acceptance passed");
} finally {
  try {
    if (postgresStarted) run("pg_ctl", ["-D", pgData, "-m", "immediate", "-w", "stop"]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
