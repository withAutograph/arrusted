import assert from "node:assert/strict";
import { exerciseManagedSignupGrant } from "./protected-managed-signup-fixture";
import { exerciseRolelessAccess } from "./protected-roleless-access-fixture";
import { prepareProtectedInstallerTestRelease } from "./protected-installer-test-fixture";
import { buildGeneratedRelease } from "./schema-release";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { createServer } from "node:net";
import { Pool } from "pg";
import { KernelFailure } from "../../../../packages/kernel-client/postgres";
import {
  verifyCheckedRelease,
  createGeneratedAppRuntime,
} from "../../../../packages/generated-app-runtime/server";
import {
  createDataClient,
  type DataDefinition,
} from "../../../../packages/generated-app-runtime/data";
import {
  createProtectedGeneratedInstaller,
  type ProtectedGeneratedPlan,
  type ProtectedGeneratedConnections,
} from "../../../../packages/generated-app-runtime/protected-installer";

// Own every byte and process; never consume a configured database URL or provider credential.
const directory = await mkdtemp(path.join(tmpdir(), "protected-installer-test-"));
const data = path.join(directory, "postgres");
const password = crypto.randomUUID();
const passwordFile = path.join(directory, "password");
const port = await new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture port");
    server.close((error) => (error ? reject(error) : resolve(address.port)));
  });
});
function command(name: string, args: string[]) {
  const result = spawnSync(name, args, {
    encoding: "utf8",
    env: { PATH: process.env.PATH, LANG: "C", LC_ALL: "C" },
  });
  if (result.status !== 0)
    throw new Error(
      `Disposable PostgreSQL ${name} failed: ${result.error?.message ?? result.stderr}`,
    );
}
const connection = (role: string, database: string) =>
  `postgres://${role}:${password}@127.0.0.1:${port}/${database}?sslmode=disable`;
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const root = path.resolve(import.meta.dirname, "../../../..");
const releaseDirectory = await prepareProtectedInstallerTestRelease(root, directory);
const manifest = verifyCheckedRelease(releaseDirectory);
const trust = {
  id: "reviewed-fixture-installer",
  sqlBundleHash: sha256(await readFile(path.join(releaseDirectory, "sql-bundle.sql"))),
};
const resource = (name: string) => ({
  resourceId: `${name}-fixture`,
  environment: "local" as const,
  hostname: "127.0.0.1",
  port,
  database: name,
  schema: "public" as const,
  migratorRole: `${name}_migrator`,
  runtimeRole: `${name}_runtime`,
});
const plan: ProtectedGeneratedPlan = {
  version: 1,
  appId: "platform-fixture",
  app: resource("protected_app"),
  auth: resource("protected_auth"),
  installer: { ...trust },
  release: {
    id: manifest.schema_version,
    artifactHash: manifest.hashes.schema!.replace(/^sha256:/u, ""),
    manifestHash: sha256(await readFile(path.join(releaseDirectory, "release-manifest.json"))),
  },
  organizations: [
    {
      organizationId: "org_fixture",
      actors: [{ actorId: "actor_fixture", actorKind: "human", roles: ["fixture_primary"] }],
    },
  ],
};
const connections = {
  appMigrator: connection(plan.app.migratorRole, plan.app.database),
  appRuntime: connection(plan.app.runtimeRole, plan.app.database),
  authMigrator: connection(plan.auth.migratorRole, plan.auth.database),
  authRuntime: connection(plan.auth.runtimeRole, plan.auth.database),
};
let started = false;
let admin: Pool | undefined;
let app: Pool | undefined;
let auth: Pool | undefined;
let checks = 0;
let fence: () => Promise<void> = async () => {};
const installer = (
  overrides: Partial<Parameters<typeof createProtectedGeneratedInstaller>[0]> = {},
  fenceGeneration = 1,
) =>
  createProtectedGeneratedInstaller({
    plan,
    trust,
    connections,
    releaseDirectory,
    fenceGeneration,
    assertCurrent: () => fence(),
    ...overrides,
  });
const workers = new Set<ReturnType<typeof spawn>>();
const startWorker = (
  action: "grant" | "revoke",
  fenceGeneration: number,
  pauseAfterFirstEffect = false,
) => {
  const child = spawn(
    process.execPath,
    [
      ...process.execArgv,
      path.join(root, ".config/mise/scripts/repository/protected-installer-test-worker.ts"),
    ],
    {
      env: { PATH: process.env.PATH, LANG: "C", LC_ALL: "C" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  workers.add(child);
  child.once("error", () => child.stdout?.destroy());
  child.stderr!.resume();
  const lines = createInterface({ input: child.stdout! });
  const output = lines[Symbol.asyncIterator]();
  child.stdin!.write(
    `${JSON.stringify({ plan, trust, connections, releaseDirectory, fenceGeneration, action, pauseAfterFirstEffect })}\n`,
  );
  const read = async () => {
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
    try {
      const message = await output.next();
      assert.equal(message.done, false, "owned installer worker must return its sanitized result");
      return JSON.parse(message.value!) as {
        kind: string;
        status?: string;
        pid: number;
        assignmentFenceRejected?: boolean;
      };
    } finally {
      clearTimeout(timeout);
    }
  };
  const stop = async () => {
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    workers.delete(child);
    lines.close();
  };
  const finish = async () => {
    const exited = once(child, "exit");
    child.stdin!.end();
    if (child.exitCode === null) await exited;
    workers.delete(child);
    lines.close();
  };
  return { child, read, stop, finish };
};
const accessBinary = path.join(directory, "protected-generated-access-worker");
const runAccessSpoolWorker = async (
  action: "prepare" | "cleanup",
  generation: number,
  options: {
    tamper?: boolean;
    denyAtFence?: number;
    denyAfterAuthClosure?: boolean;
    loseCheckpointResponse?: boolean;
    operationId?: string;
    readbackOnly?: boolean;
    installReadback?: boolean;
    install?: boolean;
    expectedInstallFailure?: boolean;
    installPlan?: ProtectedGeneratedPlan;
    installReleaseDirectory?: string;
    connections?: ProtectedGeneratedConnections;
    repositoryProduction?: boolean;
    signupGrantReadback?: { operationRef: string; fenceGeneration: number };
  } = {},
) => {
  const selectedPlan = options.installPlan ?? plan;
  const selectedReleaseDirectory = options.installReleaseDirectory ?? releaseDirectory;
  const spool = await mkdtemp(path.join(directory, "access-spool-"));
  for (const name of ["startup", "requests", "responses", "lifecycle"])
    await mkdir(path.join(spool, name), { mode: 0o700 });
  const binarySha = sha256(await readFile(accessBinary));
  const approvedPlan = {
    version: 1,
    ...(options.repositoryProduction ? { kind: "repository-production-setup-v1" } : {}),
    action,
    selection: {
      appId: selectedPlan.appId,
      ...(selectedPlan.workspaceId ? { workspaceId: selectedPlan.workspaceId } : {}),
    },
    appDatabase: selectedPlan.app,
    authDatabase: selectedPlan.auth,
    ...(selectedPlan.authOperatorRole === undefined
      ? {}
      : { authOperatorRole: selectedPlan.authOperatorRole }),
    ...(selectedPlan.signupClaim ? { signupClaim: selectedPlan.signupClaim } : {}),
    ...(options.signupGrantReadback ? { signupGrantReadback: options.signupGrantReadback } : {}),
    neon: { endpoint: "127.0.0.1" },
    release: { id: selectedPlan.release.id, sha256: selectedPlan.release.manifestHash },
    installer: { reference: "generated-app-protected-installer-v1", sha256: binarySha },
    access: selectedPlan.organizations.flatMap((organization) =>
      organization.actors.map((actor) => ({
        organizationId: organization.organizationId,
        ...actor,
      })),
    ),
    ...(options.installPlan === undefined
      ? {}
      : {
          appInstallation: {
            customerIds: selectedPlan.organizations.map(
              (organization) => organization.organizationId,
            ),
          },
        }),
  };
  const context = {
    version: 1,
    operation: {
      operation_id: options.operationId ?? crypto.randomUUID(),
      approval_digest: sha256(JSON.stringify(approvedPlan)),
      fence_generation: generation,
    },
    app_id: selectedPlan.appId,
    resource: {
      resource_id: selectedPlan.app.resourceId,
      environment: "local",
      hostname: "127.0.0.1",
      port,
      database: selectedPlan.app.database,
      schema: "public",
      migrator_role: selectedPlan.app.migratorRole,
      runtime_role: selectedPlan.app.runtimeRole,
    },
    release: { id: selectedPlan.release.id, sha256: selectedPlan.release.manifestHash },
    installer: { id: "generated-app-protected-installer-v1", sha256: binarySha },
    tenant_targets:
      options.install || options.installReadback
        ? selectedPlan.organizations.map((organization) => organization.organizationId)
        : [...new Set(approvedPlan.access.map((entry) => entry.organizationId))],
  };
  const runId = crypto.randomUUID();
  const write = async (name: string, value: unknown) =>
    await writeFile(path.join(spool, name), JSON.stringify(value), { mode: 0o600 });
  await write("startup/context.json", context);
  await write("startup/direct-database-url.json", (options.connections ?? connections).appMigrator);
  await write(
    "startup/approved-access-plan.json",
    options.tamper
      ? {
          ...approvedPlan,
          ...(approvedPlan.authOperatorRole === undefined
            ? {
                access: [
                  { ...approvedPlan.access[0], roles: ["fixture_primary", "fixture_secondary"] },
                ],
              }
            : { authOperatorRole: "unapproved_operator" }),
        }
      : approvedPlan,
  );
  if (!options.install)
    await write("startup/access-connections.json", options.connections ?? connections);
  if (options.install)
    await write("startup/generated-app-release.json", {
      version: 1,
      app_id: selectedPlan.appId,
      release_id: selectedPlan.release.id,
      release_manifest_sha256: selectedPlan.release.manifestHash,
      app_artifact_sha256: sha256(
        await readFile(path.join(selectedReleaseDirectory, "app-artifact.json")),
      ),
      sql_bundle_sha256: sha256(
        await readFile(path.join(selectedReleaseDirectory, "sql-bundle.sql")),
      ),
    });
  await write("startup/ready.json", { version: 1, run_id: runId, frame_id: 0 });
  const child = spawn(
    accessBinary,
    [
      options.install
        ? "protected-generated-app-install"
        : options.installReadback
          ? "protected-generated-app-install-readback"
          : options.readbackOnly
            ? "protected-generated-app-access-readback"
            : "protected-generated-app-access",
      "--file-spool",
      spool,
      runId,
      "5000",
      "--release-directory",
      selectedReleaseDirectory,
    ],
    {
      env: { PATH: process.env.PATH, LANG: "C", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  workers.add(child);
  const exited = once(child, "exit");
  child.stderr!.resume();
  let fences = 0;
  let authorizedEffects = 0;
  let receipt = false;
  const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    for await (const line of createInterface({ input: child.stdout! })) {
      const notice = JSON.parse(line);
      if (notice.kind !== "protected_installer_frame_ready") continue;
      const request = JSON.parse(
        await readFile(path.join(spool, `requests/${notice.frame_id}.json`), "utf8"),
      );
      assert.equal(request.operation_id, context.operation.operation_id);
      assert.equal(request.context_digest, sha256(JSON.stringify(context)));
      assert.equal(request.fence_generation, generation);
      const identity = {
        version: 1,
        operation_id: request.operation_id,
        context_digest: request.context_digest,
        fence_generation: generation,
      };
      if (request.kind === "check_fence") {
        fences++;
        const openAuthTransaction = await admin!.query(
          `select 1 from pg_stat_activity where usename=$1 and datname=$2 and state='idle in transaction' limit 1`,
          [plan.auth.migratorRole, plan.auth.database],
        );
        assert.equal(
          openAuthTransaction.rowCount,
          0,
          "operator fence request held an Auth transaction",
        );
        const state = options.denyAfterAuthClosure ? await readAccess() : undefined;
        const denyAfterAuthClosure = state?.browser === false && state.kernel === true;
        await write(`responses/${notice.frame_id}.json`, {
          ...identity,
          kind: "fence_current",
          current: fences !== options.denyAtFence && !denyAfterAuthClosure,
        });
      } else if (request.kind === "authorize_effect") {
        authorizedEffects++;
        if (options.install) {
          assert.ok(
            [
              "generated_app.install_bundle",
              "generated_app.prepare_schema_revision",
              "generated_app.validate_readiness",
              "generated_app.activate_app_base",
              "generated_app.grant_runtime_capability",
              "generated_app.bind_runtime_scope",
            ].includes(request.effect_id),
            "install worker requested an unsupported effect",
          );
          assert.ok(
            request.tenant_id === null || context.tenant_targets.includes(request.tenant_id),
            "install effect left its approved tenant union",
          );
        } else {
          assert.equal(
            request.effect_id,
            action === "prepare" ? "generated_app.grant_access" : "generated_app.revoke_access",
          );
        }
        await write(`responses/${notice.frame_id}.json`, {
          ...identity,
          kind: "effect_authorized",
          sequence: request.sequence,
          effect_id: request.effect_id,
          allowed: true,
        });
      } else {
        assert.equal(request.kind, "checkpoint_effect");
        assert.equal(request.receipt.state, "applied");
        // The effect and readback succeeded, but the operator response is lost.
        if (options.loseCheckpointResponse) continue;
        receipt = true;
        await write(`responses/${notice.frame_id}.json`, {
          ...identity,
          kind: "checkpoint_recorded",
          sequence: request.sequence,
          effect_id: request.effect_id,
          recorded: true,
        });
      }
      await write(`responses/${notice.frame_id}.ready`, {
        version: 1,
        run_id: runId,
        frame_id: notice.frame_id,
      });
    }
    const [exitCode] = await exited;
    assert.equal(
      exitCode,
      options.tamper ||
        options.expectedInstallFailure ||
        options.denyAtFence ||
        options.denyAfterAuthClosure ||
        options.loseCheckpointResponse
        ? 1
        : 0,
    );
    assert.equal(
      receipt,
      !(
        options.tamper ||
        options.expectedInstallFailure ||
        options.denyAtFence ||
        options.denyAfterAuthClosure ||
        options.loseCheckpointResponse ||
        options.readbackOnly
      ),
    );
    let readbackStatus: string | undefined;
    if (options.readbackOnly && !options.tamper && !options.denyAtFence) {
      const readback = JSON.parse(await readFile(path.join(spool, "readback.json"), "utf8"));
      assert.equal(readback.operation_id, context.operation.operation_id);
      assert.equal(readback.context_digest, sha256(JSON.stringify(context)));
      assert.equal(readback.fence_generation, generation);
      assert.match(readback.readback_sha256, /^[a-f0-9]{64}$/u);
      readbackStatus = readback.status;
    }
    for (const privateFile of [
      "approved-access-plan.json",
      "access-connections.json",
      "direct-database-url.json",
    ])
      await assert.rejects(readFile(path.join(spool, "startup", privateFile)), /ENOENT/u);
    return { fences, receipt, readbackStatus, authorizedEffects };
  } finally {
    clearTimeout(timeout);
    workers.delete(child);
    await rm(spool, { recursive: true, force: true });
  }
};

const readAccess = async () => {
  const browser = await auth!.query(
    'select active from app_actor_assignment where "organizationId"=$1 and "actorId"=$2 and "appId"=$3 and role=$4',
    ["org_fixture", "actor_fixture", plan.appId, "fixture_primary"],
  );
  const kernel = await app!.query(
    "select active from kernel_actor_membership where principal_name=$1 and app_id=$2 and customer_id=$3 and actor_id=$4 and role=$5",
    [plan.app.runtimeRole, plan.appId, "org_fixture", "actor_fixture", "fixture_primary"],
  );
  return { browser: browser.rows[0]?.active === true, kernel: kernel.rows[0]?.active === true };
};
const readFences = async () => {
  const browser = await auth!.query(
    'select active,"fence_generation" from app_actor_assignment where "organizationId"=$1 and "actorId"=$2 and "appId"=$3 and role=$4',
    ["org_fixture", "actor_fixture", plan.appId, "fixture_primary"],
  );
  const kernel = await app!.query(
    "select active,fence_generation from kernel_actor_membership where principal_name=$1 and app_id=$2 and customer_id=$3 and actor_id=$4 and role=$5",
    [plan.app.runtimeRole, plan.appId, "org_fixture", "actor_fixture", "fixture_primary"],
  );
  return {
    browser: browser.rows[0]
      ? { active: browser.rows[0].active, generation: Number(browser.rows[0].fence_generation) }
      : undefined,
    kernel: kernel.rows[0]
      ? { active: kernel.rows[0].active, generation: Number(kernel.rows[0].fence_generation) }
      : undefined,
  };
};
try {
  await writeFile(passwordFile, password, { mode: 0o600 });
  command("initdb", [
    "-D",
    data,
    "--username=postgres",
    "--auth=scram-sha-256",
    `--pwfile=${passwordFile}`,
    "--no-locale",
    "--encoding=UTF8",
  ]);
  command("pg_ctl", [
    "-D",
    data,
    "-l",
    path.join(directory, "postgres.log"),
    "-o",
    `-h 127.0.0.1 -p ${port} -k ${directory}`,
    "-w",
    "start",
  ]);
  started = true;
  admin = new Pool({ connectionString: connection("postgres", "postgres") });
  for (const target of [plan.app, plan.auth]) {
    await admin.query(
      `create role ${target.migratorRole} login createrole password '${password}'; create role ${target.runtimeRole} login password '${password}'`,
    );
    await admin.query(`create database ${target.database} owner ${target.migratorRole}`);
  }
  app = new Pool({ connectionString: connections.appMigrator });
  auth = new Pool({ connectionString: connections.authMigrator });
  assert.equal(await installer().reconcileInstall(), "absent");
  await app.query("create type public.install_marker as enum ('foreign')");
  assert.equal(await installer().reconcileInstall(), "incomplete");
  await app.query("drop type public.install_marker");
  await app.query(
    "create operator public.=== (leftarg=integer,rightarg=integer,function=pg_catalog.int4eq)",
  );
  assert.equal(await installer().reconcileInstall(), "incomplete");
  await app.query("drop operator public.=== (integer,integer)");
  checks += 3;
  await app.query(
    `revoke create on schema public from public;
     create table preserved_data(id text primary key, value text);
     insert into preserved_data values ('existing','keep');
     create table kernel_actor_membership (
       principal_name name not null, app_id text not null, customer_id text not null,
       actor_id text not null, role text not null,
       actor_kind text not null default 'agent' check (actor_kind in ('human','agent')),
       active boolean not null default true,
       fence_generation bigint not null default 0 check (fence_generation >= 0),
       bound_at timestamptz not null default now(),
       primary key (principal_name,app_id,customer_id,actor_id,role)
     );
     insert into kernel_actor_membership (principal_name,app_id,customer_id,actor_id,role,active)
       values ('protected_app_runtime','platform-fixture','org_fixture','actor_fixture','fixture_primary',false);`,
  );
  await auth.query("revoke create on schema public from public");
  await auth.query(await readFile(path.join(root, "packages/auth/schema.sql"), "utf8"));
  await auth.query(`
    insert into "organization" values ('org_fixture','Fixture','org-fixture',null,now(),null,'[]');
    insert into "user" (id,name,email,"emailVerified") values ('actor_fixture','Fixture','fixture@example.invalid',true);
    insert into "member" (id,"organizationId","userId",role,"createdAt") values ('fixture-member','org_fixture','actor_fixture','member',now());
    insert into "session" (id,"userId",token,"expiresAt","updatedAt") values ('existing-session','actor_fixture','preserve-token',now()+interval '1 day',now());`);
  const preservedAuthState = {
    users: (await auth.query('select * from "user"')).rows,
    sessions: (await auth.query('select * from "session"')).rows,
  };
  const provisionOrganizations = await readFile(
    path.join(root, "packages/auth/provision-organizations.sql"),
    "utf8",
  );
  await auth.query(provisionOrganizations.replaceAll("__CATALOG_APP_IDS__", "[]"));
  const authOperatorRole = "protected_auth_operator";
  await admin.query(`create role ${authOperatorRole} login password '${password}'`);
  await auth.query(await readFile(path.join(root, "packages/auth/operator-locks.sql"), "utf8"));
  await auth.query(
    (await readFile(path.join(root, "packages/auth/operator-privileges.sql"), "utf8"))
      .replaceAll("__OPERATOR_ROLE__", `"${authOperatorRole}"`)
      .replaceAll("__OPERATOR_ROLE_LITERAL__", `'${authOperatorRole}'`),
  );
  const operatorConnections = {
    appMigrator: connections.appMigrator,
    appRuntime: connections.appRuntime,
    authOperator: connection(authOperatorRole, plan.auth.database),
    authRuntime: connections.authRuntime,
  };
  const operatorPlan = { ...plan, authOperatorRole };
  assert.throws(() => installer({ plan: operatorPlan }), /identity_mismatch/u);
  assert.throws(() => installer({ connections: operatorConnections }), /identity_mismatch/u);
  assert.throws(
    () =>
      installer({
        plan: operatorPlan,
        connections: { ...operatorConnections, authOperator: connections.authMigrator },
      }),
    /mismatch/u,
  );
  assert.throws(() =>
    installer({
      plan: { ...operatorPlan, authOperatorRole: plan.auth.migratorRole },
      connections: operatorConnections,
    }),
  );
  checks += 4;
  await auth.query(
    `insert into "app_actor_assignment" ("organizationId","actorId","appId",role,active)
     values ('org_fixture','actor_fixture','other-app','member',true);
     grant select on all tables in schema public to protected_auth_runtime;`,
  );

  // Self-consistent generated checksums are not an independent installer trust root.
  const alteredDirectory = path.join(directory, "altered-release");
  await cp(releaseDirectory, alteredDirectory, { recursive: true });
  const changedSql =
    (await readFile(path.join(alteredDirectory, "sql-bundle.sql"), "utf8")) +
    "\ncreate table unapproved_effect(id text);\n";
  await writeFile(path.join(alteredDirectory, "sql-bundle.sql"), changedSql);
  const alteredManifest = JSON.parse(
    await readFile(path.join(alteredDirectory, "release-manifest.json"), "utf8"),
  );
  alteredManifest.hashes.bundle = `sha256:${sha256(changedSql)}`;
  await writeFile(
    path.join(alteredDirectory, "release-manifest.json"),
    JSON.stringify(alteredManifest),
  );
  verifyCheckedRelease(alteredDirectory);
  const selfSigned = {
    ...plan,
    installer: { ...plan.installer, sqlBundleHash: sha256(changedSql) },
    release: {
      ...plan.release,
      manifestHash: sha256(await readFile(path.join(alteredDirectory, "release-manifest.json"))),
    },
  };
  assert.throws(
    () => installer({ plan: selfSigned, releaseDirectory: alteredDirectory }),
    /identity_mismatch/u,
  );
  checks++;
  assert.equal(
    (await app.query("select to_regclass('public.unapproved_effect') as relation")).rows[0]
      .relation,
    null,
  );
  checks++;
  for (const mutated of [
    { ...plan, appId: "another-app" },
    { ...plan, release: { ...plan.release, id: "wrong-release" } },
    { ...plan, app: { ...plan.app, database: "wrong_database" } },
    { ...plan, app: { ...plan.app, hostname: "other.host" } },
    { ...plan, app: { ...plan.app, migratorRole: "another_migrator" } },
  ]) {
    assert.throws(() => installer({ plan: mutated }), /identity_mismatch/u);
    checks++;
  }
  for (const overlappingRole of [
    { runtimeRole: plan.auth.migratorRole },
    { migratorRole: plan.auth.runtimeRole },
    { migratorRole: plan.auth.migratorRole },
  ]) {
    assert.throws(() => installer({ plan: { ...plan, app: { ...plan.app, ...overlappingRole } } }));
    checks++;
  }
  assert.throws(
    () =>
      installer({
        connections: { ...connections, appMigrator: connections.appMigrator + "&host=other.host" },
      }),
    /identity_mismatch/u,
  );
  checks++;
  assert.equal(
    (await app.query("select to_regclass('public.schema_installation_revision') as relation"))
      .rows[0].relation,
    null,
  );
  checks++;
  await admin.query("alter role protected_app_runtime createdb");
  await assert.rejects(installer().install(), /identity_mismatch/u);
  checks++;
  await admin.query("alter role protected_app_runtime nocreatedb");
  await admin.query("alter role protected_app_migrator set search_path=pg_catalog");
  await assert.rejects(installer().install(), /identity_mismatch/u);
  checks++;
  await admin.query("alter role protected_app_migrator reset search_path");
  fence = async () => {
    throw new Error("fenced");
  };
  await assert.rejects(installer().install(), /fenced/u);
  checks++;
  fence = async () => {};
  await admin.query("create role unrelated_role; grant unrelated_role to protected_app_runtime");
  await assert.rejects(installer().install(), /identity_mismatch/u);
  assert.equal(
    (await app.query("select to_regclass('public.schema_installation_revision') as relation"))
      .rows[0].relation,
    null,
  );
  checks++;
  await admin.query("revoke unrelated_role from protected_app_runtime; drop role unrelated_role");

  const result = await installer().install();
  assert.equal(result.artifactHash, plan.release.artifactHash);
  assert.equal(await installer().reconcileInstall(), "applied");
  checks++;
  checks++;
  await app.query("delete from kernel_actor_membership where principal_name=$1 and app_id=$2", [
    plan.app.runtimeRole,
    plan.appId,
  ]);
  assert.equal(await installer({}, 9).inspectAccess(true), "absent");
  await app.query(
    "insert into kernel_actor_membership(principal_name,app_id,customer_id,actor_id,role,actor_kind,active,fence_generation) values($1,$2,'org_fixture','actor_fixture','fixture_primary','human',false,0)",
    [plan.app.runtimeRole, plan.appId],
  );
  assert.equal(await installer({}, 9).inspectAccess(true), "retryable");
  checks += 2;
  const upgradedKernelMembership = await app.query(
    "select active,fence_generation from kernel_actor_membership where principal_name=$1 and app_id=$2 and customer_id=$3 and actor_id=$4 and role=$5",
    [plan.app.runtimeRole, plan.appId, "org_fixture", "actor_fixture", "fixture_primary"],
  );
  assert.deepEqual(upgradedKernelMembership.rows[0], { active: false, fence_generation: "0" });
  checks++;
  const upgradedAuthAssignment = await auth.query(
    'select "fence_generation" from "app_actor_assignment" where "organizationId"=$1 and "actorId"=$2 and "appId"=$3 and role=$4',
    ["org_fixture", "actor_fixture", "other-app", "member"],
  );
  assert.deepEqual(upgradedAuthAssignment.rows[0], { fence_generation: "0" });
  checks++;
  assert.deepEqual(await installer().verify(), result);
  checks++;
  assert.deepEqual(await installer().install(), result);
  checks++;
  // This explicit write-contract fixture isolates runtime consumer interruption/recovery.
  // The schema-compiler disposable test separately exercises the real generated SQL.
  await app.query(`create or replace function kernel_bind_actor_membership(request jsonb)
    returns jsonb language plpgsql as $$
    declare generation_value bigint := coalesce((request->>'fence_generation')::bigint,0);
      applied record;
    begin
      insert into kernel_actor_membership(principal_name,app_id,customer_id,actor_id,role,actor_kind,active,fence_generation)
      values ((request->>'principal_name')::name,request->>'app_id',request->>'customer_id',
        request->>'actor_id',request->>'role',coalesce(request->>'actor_kind','agent'),coalesce((request->>'active')::boolean,true),generation_value)
      on conflict (principal_name,app_id,customer_id,actor_id,role) do update
        set active=excluded.active,actor_kind=excluded.actor_kind,fence_generation=excluded.fence_generation
        where (excluded.fence_generation=0 and kernel_actor_membership.fence_generation=0)
          or kernel_actor_membership.fence_generation<excluded.fence_generation
          or (kernel_actor_membership.fence_generation=excluded.fence_generation
            and kernel_actor_membership.active=excluded.active
            and kernel_actor_membership.actor_kind=excluded.actor_kind)
      returning active,fence_generation into applied;
      if not found then return jsonb_build_object('ok',false); end if;
      return jsonb_build_object('ok',true,'data',jsonb_build_object(
        'active',applied.active,'fence_generation',applied.fence_generation));
    end $$`);
  checks++;
  assert.equal(await installer().reconcileAccess(true), "incomplete");
  checks++;
  assert.deepEqual(await readAccess(), { browser: false, kernel: false });
  checks++;

  // Interrupt between the observed kernel grant and first Auth write.
  fence = async () => {
    const state = await readAccess();
    if (state.kernel && !state.browser) throw new Error("grant interrupted after kernel readback");
  };
  await assert.rejects(installer().grant(), /grant interrupted/u);
  checks++;
  assert.deepEqual(await readAccess(), { browser: false, kernel: true });
  checks++;
  fence = async () => {};
  await installer().grant();
  assert.equal(await installer().reconcileAccess(true), "applied");
  checks++;
  assert.deepEqual(await readFences(), {
    browser: { active: true, generation: 1 },
    kernel: { active: true, generation: 1 },
  });
  checks++;

  command(process.execPath, [
    "build",
    "--compile",
    path.join(root, "packages/generated-app-runtime/protected-installer-worker.ts"),
    "--outfile",
    accessBinary,
  ]);
  for (const appRoles of [["fixture_primary"]])
    checks += await exerciseManagedSignupGrant({
      root,
      auth,
      app,
      plan,
      connections: operatorConnections,
      trust,
      releaseDirectory,
      authOperatorRole,
      appRoles,
      observeWire: async (signupPlan, receipt, readbackOnly, signupReleaseDirectory) => {
        const result = await runAccessSpoolWorker("prepare", 10, {
          installPlan: signupPlan,
          installReleaseDirectory: signupReleaseDirectory,
          connections: operatorConnections,
          signupGrantReadback: receipt,
          readbackOnly,
          expectedInstallFailure: !readbackOnly,
        });
        assert.equal(result.authorizedEffects, 0);
        return result.readbackStatus;
      },
    });

  // A legacy scope cannot prove app closure; abort before changing either authority row.
  await app.query(
    "update kernel_principal_scope set actor_binding_required=false where principal_name=$1 and capability='runtime'",
    [plan.app.runtimeRole],
  );
  await assert.rejects(installer({}, 2).revoke(), /protected_installer_binding_profile_required/u);
  assert.deepEqual(await readAccess(), { browser: true, kernel: true });
  assert.deepEqual(await readFences(), {
    browser: { active: true, generation: 1 },
    kernel: { active: true, generation: 1 },
  });
  await app.query("select kernel_bind_principal_scope($1::jsonb)", [
    JSON.stringify({
      principal_name: plan.app.runtimeRole,
      capability: "runtime",
      app_id: plan.appId,
      customer_id: "org_fixture",
      actor_binding_required: true,
    }),
  ]);
  // Every scope of the principal is checked, including a non-selected organization.
  await app.query("select kernel_bind_principal_scope($1::jsonb)", [
    JSON.stringify({
      principal_name: plan.app.runtimeRole,
      capability: "runtime",
      app_id: plan.appId,
      customer_id: "legacy_other_org",
    }),
  ]);
  await assert.rejects(installer({}, 2).revoke(), /protected_installer_binding_profile_required/u);
  assert.deepEqual(await readAccess(), { browser: true, kernel: true });
  await app.query("select kernel_bind_principal_scope($1::jsonb)", [
    JSON.stringify({
      principal_name: plan.app.runtimeRole,
      capability: "runtime",
      app_id: plan.appId,
      customer_id: "legacy_other_org",
      actor_binding_required: true,
      active: false,
    }),
  ]);
  checks += 5;

  // A positive generation cannot be reused for the opposite intent.
  await assert.rejects(installer({}, 1).revoke(), /protected_installer_assignment_fence_rejected/u);
  checks++;
  assert.deepEqual(await readAccess(), { browser: true, kernel: true });
  checks++;

  await auth.query(
    `update "organization" set "appIds"='["other-app"]'::jsonb where id='org_fixture'`,
  );
  assert.equal(await installer().reconcileAccess(true), "incomplete");
  checks++;
  await auth.query(
    `update "organization" set "appIds"='["other-app","platform-fixture"]'::jsonb where id='org_fixture'`,
  );
  await installer().grant();
  assert.equal(
    (
      await auth.query('select count(*)::int as count from app_actor_assignment where "appId"=$1', [
        plan.appId,
      ])
    ).rows[0].count,
    1,
  );
  checks++;
  assert.deepEqual(
    (await auth.query('select "appIds" from "organization" where id=$1', ["org_fixture"])).rows[0]
      .appIds,
    ["other-app", "platform-fixture"],
  );
  checks++;

  // A changed runtime privilege is denied before opening any new access.
  await auth.query("grant update(active) on app_actor_assignment to protected_auth_runtime");
  await assert.rejects(installer().grant(), /identity_mismatch/u);
  checks++;
  await auth.query("revoke update(active) on app_actor_assignment from protected_auth_runtime");

  // Interrupt after Auth closure and before kernel revocation; retry preserves the closed browser boundary.
  fence = async () => {
    const state = await readAccess();
    if (!state.browser && state.kernel) throw new Error("revoke interrupted after Auth readback");
  };
  await assert.rejects(
    installer(
      {
        assertCurrent: async () => {
          const state = await readAccess();
          if (!state.browser && state.kernel)
            throw new Error("revoke interrupted after Auth readback");
        },
      },
      2,
    ).revoke(),
    /revoke interrupted/u,
  );
  checks++;
  assert.deepEqual(await readAccess(), { browser: false, kernel: true });
  checks++;
  fence = async () => {};
  await installer({}, 2).revoke();
  assert.equal(await installer({}, 2).reconcileAccess(false), "applied");
  checks++;
  await installer({}, 2).revoke();
  assert.deepEqual(await readAccess(), { browser: false, kernel: false });
  checks++;
  assert.deepEqual(await readFences(), {
    browser: { active: false, generation: 2 },
    kernel: { active: false, generation: 2 },
  });
  checks++;
  const revokedProjection = await auth.query(
    `select exists (select 1 from app_actor_assignment where "organizationId"=$1 and "appId"=$2 and active) as expected,
            coalesce(o."appIds",'[]'::jsonb)?$2 as actual from "organization" o where o.id=$1`,
    ["org_fixture", plan.appId],
  );
  assert.equal(revokedProjection.rows[0]?.expected, false);
  assert.equal(revokedProjection.rows[0]?.actual, false);
  assert.deepEqual(
    (await auth.query('select "appIds" from "organization" where id=$1', ["org_fixture"])).rows[0]
      .appIds,
    ["other-app"],
  );
  checks++;

  await auth.query(
    `update "organization" set "appIds"='["other-app","platform-fixture"]'::jsonb where id='org_fixture'`,
  );
  assert.equal(await installer({}, 2).reconcileAccess(false), "incomplete");
  await installer({}, 2).revoke();
  assert.equal(await installer({}, 2).reconcileAccess(false), "applied");
  checks++;

  // A second valid role for the same enrolled actor keeps organization access
  // until its own final assignment closes. It also proves the tampered role is
  // a valid backend target rather than an unrelated membership rejection.
  const secondaryRoleInstaller = (generation: number) =>
    installer(
      {
        plan: {
          ...plan,
          organizations: [
            {
              organizationId: "org_fixture",
              actors: [
                {
                  actorId: "actor_fixture",
                  actorKind: "human",
                  roles: ["fixture_secondary"],
                },
              ],
            },
          ],
        },
      },
      generation,
    );
  await secondaryRoleInstaller(2).grant();
  await installer({}, 2).revoke();
  assert.deepEqual(
    (await auth.query('select "appIds" from "organization" where id=$1', ["org_fixture"])).rows[0]
      .appIds,
    ["other-app", "platform-fixture"],
  );
  assert.equal(await secondaryRoleInstaller(2).reconcileAccess(true), "applied");
  checks++;
  await secondaryRoleInstaller(3).revoke();
  assert.deepEqual(
    (await auth.query('select "appIds" from "organization" where id=$1', ["org_fixture"])).rows[0]
      .appIds,
    ["other-app"],
  );
  checks++;

  // A legacy generation-zero attempt cannot reopen rows fenced by a protected revoke.
  const legacyAuth = await auth.query(
    `insert into "app_actor_assignment" ("organizationId","actorId","appId","role",active,"fence_generation")
     values ($1,$2,$3,$4,true,0)
     on conflict ("organizationId","actorId","appId","role") do update set active=true
     where "app_actor_assignment"."fence_generation"=0 returning active`,
    ["org_fixture", "actor_fixture", plan.appId, "fixture_primary"],
  );
  assert.equal(legacyAuth.rowCount, 0);
  checks++;
  const legacyKernel = await app.query("select kernel_bind_actor_membership($1::jsonb) as result", [
    JSON.stringify({
      principal_name: plan.app.runtimeRole,
      app_id: plan.appId,
      customer_id: "org_fixture",
      actor_id: "actor_fixture",
      role: "fixture_primary",
      active: true,
    }),
  ]);
  assert.equal(legacyKernel.rows[0]?.result?.ok, false);
  checks++;
  assert.deepEqual(await readAccess(), { browser: false, kernel: false });
  checks++;

  // The durable operation can lose its response after the Auth commit. Exact same-generation
  // reconciliation and retry observe/apply the same rows without duplicate assignments.
  await installer({}, 3).grant();
  assert.equal(await installer({}, 3).reconcileAccess(true), "applied");
  checks++;
  await installer({}, 3).grant();
  assert.deepEqual(await readFences(), {
    browser: { active: true, generation: 3 },
    kernel: { active: true, generation: 3 },
  });
  checks++;
  assert.equal(
    (
      await auth.query('select count(*)::int as count from app_actor_assignment where "appId"=$1', [
        plan.appId,
      ])
    ).rows[0].count,
    2,
  );
  assert.deepEqual(
    (
      await auth.query(
        'select "actorId",role,active,"fence_generation"::int as generation from app_actor_assignment where "appId"=$1 order by role',
        [plan.appId],
      )
    ).rows,
    [
      { actorId: "actor_fixture", role: "fixture_primary", active: true, generation: 3 },
      { actorId: "actor_fixture", role: "fixture_secondary", active: false, generation: 3 },
    ],
  );
  checks++;

  // Delay a grant after its kernel readback. A newer revoke wins both authority rows; the stale
  // grant's Auth write is rejected even when its process has not yet observed its lost fence.
  let currentChecks = 0;
  let revocationStarted = false;
  const delayedGrant = installer(
    {
      assertCurrent: async () => {
        currentChecks += 1;
        if (currentChecks === 3 && !revocationStarted) {
          revocationStarted = true;
          await installer({}, 4).revoke();
        }
      },
    },
    3,
  );
  await assert.rejects(delayedGrant.grant(), /assignment_fence_rejected/u);
  checks++;
  assert.deepEqual(await readAccess(), { browser: false, kernel: false });
  checks++;
  assert.deepEqual(await readFences(), {
    browser: { active: false, generation: 4 },
    kernel: { active: false, generation: 4 },
  });
  checks++;
  const activeAssignments = await auth.query(
    'select "actorId","appId",role,active,"fence_generation" from app_actor_assignment where "organizationId"=$1 and "appId"=$2 and active order by "appId",role',
    ["org_fixture", plan.appId],
  );
  assert.deepEqual(activeAssignments.rows, []);
  checks++;
  assert.deepEqual(
    (await auth.query('select "appIds" from "organization" where id=$1', ["org_fixture"])).rows[0]
      .appIds,
    ["other-app"],
  );
  checks++;
  // Independent OS workers share only PostgreSQL effect truth and the same trusted fixture
  // context. A delayed old grant cannot reopen a newer revoke; process loss does not erase fences.
  const oldGrant = startWorker("grant", 5, true);
  const oldPaused = await oldGrant.read();
  assert.equal(oldPaused.kind, "paused");
  const newRevoke = startWorker("revoke", 6);
  const revoked = await newRevoke.read();
  assert.equal(revoked.status, "applied");
  assert.notEqual(revoked.pid, oldPaused.pid);
  await newRevoke.finish();
  oldGrant.child.stdin!.write("continue\n");
  const stale = await oldGrant.read();
  assert.equal(stale.status, "rejected");
  assert.equal(stale.assignmentFenceRejected, true);
  await oldGrant.finish();
  assert.deepEqual(await readFences(), {
    browser: { active: false, generation: 6 },
    kernel: { active: false, generation: 6 },
  });
  checks++;

  const interrupted = startWorker("grant", 7, true);
  assert.equal((await interrupted.read()).kind, "paused");
  await interrupted.stop();
  assert.deepEqual(await readAccess(), { browser: false, kernel: true });
  const recovered = startWorker("revoke", 8);
  assert.equal((await recovered.read()).status, "applied");
  await recovered.finish();
  const replay = startWorker("revoke", 8);
  assert.equal((await replay.read()).status, "applied");
  await replay.finish();
  const staleRestart = startWorker("grant", 7);
  assert.equal((await staleRestart.read()).status, "rejected");
  await staleRestart.finish();
  assert.deepEqual(await readFences(), {
    browser: { active: false, generation: 8 },
    kernel: { active: false, generation: 8 },
  });
  assert.deepEqual(
    (await auth.query('select "appIds" from "organization" where id=$1', ["org_fixture"])).rows[0]
      .appIds,
    ["other-app"],
  );
  checks++;

  assert.equal(
    (await runAccessSpoolWorker("prepare", 9, { readbackOnly: true, installReadback: true }))
      .readbackStatus,
    "applied",
  );
  await runAccessSpoolWorker("prepare", 9, {
    readbackOnly: true,
    installReadback: true,
    denyAtFence: 1,
  });
  await app.query(
    "update kernel_principal_scope set actor_binding_required=false where principal_name=$1",
    [plan.app.runtimeRole],
  );
  assert.equal(
    (await runAccessSpoolWorker("prepare", 9, { readbackOnly: true, installReadback: true }))
      .readbackStatus,
    "incomplete",
  );
  await app.query(
    "update kernel_principal_scope set actor_binding_required=true where principal_name=$1",
    [plan.app.runtimeRole],
  );
  checks += 3;
  const lostCheckpoint = { operationId: "fixture-lost-checkpoint" };
  await runAccessSpoolWorker("prepare", 9, { ...lostCheckpoint, loseCheckpointResponse: true });
  assert.deepEqual(await readAccess(), { browser: true, kernel: true });
  assert.equal((await runAccessSpoolWorker("prepare", 9, lostCheckpoint)).receipt, true);
  assert.equal(
    (
      await auth.query(
        'select count(*)::int as count from "app_actor_assignment" where "appId"=$1',
        [plan.appId],
      )
    ).rows[0]?.count,
    2,
  );
  checks++;
  assert.deepEqual(await readAccess(), { browser: true, kernel: true });
  assert.equal(
    (await runAccessSpoolWorker("prepare", 9, { readbackOnly: true })).readbackStatus,
    "applied",
  );
  assert.equal(
    (await runAccessSpoolWorker("cleanup", 10, { readbackOnly: true })).readbackStatus,
    "retryable",
  );
  await runAccessSpoolWorker("prepare", 9, { readbackOnly: true, denyAtFence: 1 });
  assert.deepEqual(await readFences(), {
    browser: { active: true, generation: 9 },
    kernel: { active: true, generation: 9 },
  });
  checks++;
  await runAccessSpoolWorker("prepare", 10, { tamper: true });
  assert.deepEqual(await readFences(), {
    browser: { active: true, generation: 9 },
    kernel: { active: true, generation: 9 },
  });
  checks++;
  await runAccessSpoolWorker("cleanup", 10, { denyAfterAuthClosure: true });
  assert.deepEqual(await readFences(), {
    browser: { active: false, generation: 10 },
    kernel: { active: true, generation: 9 },
  });
  checks++;
  assert.equal(
    (await runAccessSpoolWorker("cleanup", 10, { readbackOnly: true })).readbackStatus,
    "retryable",
  );
  assert.equal(
    (await runAccessSpoolWorker("prepare", 9, { readbackOnly: true })).readbackStatus,
    "incomplete",
  );
  checks += 2;
  await runAccessSpoolWorker("cleanup", 10);
  await runAccessSpoolWorker("cleanup", 10);
  assert.equal(
    (await runAccessSpoolWorker("cleanup", 10, { readbackOnly: true })).readbackStatus,
    "applied",
  );
  assert.deepEqual(await readFences(), {
    browser: { active: false, generation: 10 },
    kernel: { active: false, generation: 10 },
  });
  checks++;

  assert.deepEqual((await app.query("select * from preserved_data")).rows, [
    { id: "existing", value: "keep" },
  ]);
  checks++;
  assert.deepEqual((await auth.query('select * from "session"')).rows, preservedAuthState.sessions);
  checks++;
  assert.deepEqual((await auth.query('select * from "user"')).rows, preservedAuthState.users);
  checks++;
  assert.equal(await installer({}, 10).reconcileAuthAccess(false), "applied");
  assert.equal(await installer({}, 9).reconcileAuthAccess(false), "incomplete");
  assert.equal(await installer({}, 10).reconcileRetirementAccess(), "applied");
  checks++;
  // Membership removed after the kernel effect cannot open browser authority.
  let membershipRemoved = false;
  await assert.rejects(
    installer(
      {
        assertCurrent: async () => {
          if (membershipRemoved) return;
          const state = await readAccess();
          if (state.kernel && !state.browser) {
            membershipRemoved = true;
            await auth!.query('delete from "member" where "organizationId"=$1 and "userId"=$2', [
              "org_fixture",
              "actor_fixture",
            ]);
          }
        },
      },
      11,
    ).grant(),
    /protected_installer_membership_required/u,
  );
  assert.equal(membershipRemoved, true);
  assert.deepEqual(await readAccess(), { browser: false, kernel: true });
  await auth.query(
    `insert into "member" (id,"organizationId","userId",role,"createdAt") values ($3,$1,$2,'member',now())`,
    ["org_fixture", "actor_fixture", crypto.randomUUID()],
  );
  await installer({}, 11).grant();
  checks++;
  // A killed revoke has already closed browser authority. Its restarted process
  // finishes the kernel effect at the same fence without reopening Auth.
  const interruptedRevoke = startWorker("revoke", 12, true);
  assert.equal((await interruptedRevoke.read()).kind, "paused");
  assert.deepEqual(await readAccess(), { browser: false, kernel: true });
  await interruptedRevoke.stop();
  const resumedRevoke = startWorker("revoke", 12);
  assert.equal((await resumedRevoke.read()).status, "applied");
  await resumedRevoke.finish();
  assert.deepEqual(await readFences(), {
    browser: { active: false, generation: 12 },
    kernel: { active: false, generation: 12 },
  });
  checks++;
  // Lose the operator fence after the last pre-transaction check. The grant must
  // close any Auth effect that committed before it observes the stale fence.
  let grantFenceExpired = false;
  let expiryScheduled = false;
  await assert.rejects(
    installer(
      {
        assertCurrent: async () => {
          if (grantFenceExpired) throw new Error("fixture_fence_expired");
          if (expiryScheduled) return;
          const state = await readAccess();
          if (state.kernel && !state.browser) {
            expiryScheduled = true;
            queueMicrotask(() => {
              grantFenceExpired = true;
            });
          }
        },
      },
      13,
    ).grant(),
    /fixture_fence_expired/u,
  );
  assert.equal(expiryScheduled, true);
  assert.deepEqual(await readFences(), {
    browser: { active: false, generation: 13 },
    kernel: { active: true, generation: 13 },
  });
  assert.deepEqual(
    (await auth.query('select "appIds" from "organization" where id=$1', ["org_fixture"])).rows[0]
      .appIds,
    ["other-app"],
  );
  checks++;
  // A newer revoke can race with the grant's post-commit fence check. Cleanup
  // for the failed grant must leave the newer inactive generations untouched.
  await installer({}, 14).grant();
  let newerRevokeCompleted = false;
  await assert.rejects(
    installer(
      {
        assertCurrent: async () => {
          if (newerRevokeCompleted) throw new Error("fixture_newer_revocation");
          const state = await readFences();
          if (state.browser?.active && state.browser.generation === 15) {
            await installer({}, 16).revoke();
            newerRevokeCompleted = true;
            throw new Error("fixture_newer_revocation");
          }
        },
      },
      15,
    ).grant(),
    /fixture_newer_revocation/u,
  );
  assert.equal(newerRevokeCompleted, true);
  assert.deepEqual(await readFences(), {
    browser: { active: false, generation: 16 },
    kernel: { active: false, generation: 16 },
  });
  assert.deepEqual(
    (await auth.query('select "appIds" from "organization" where id=$1', ["org_fixture"])).rows[0]
      .appIds,
    ["other-app"],
  );
  checks++;
  await auth.query(
    `insert into "user" (id,name,email,"emailVerified") values ('other_actor','Other','other@example.invalid',true)`,
  );
  await auth.query(
    `insert into "app_actor_assignment" ("organizationId","actorId","appId",role,active,"fence_generation","assignedAt") values ('org_fixture','other_actor','platform-fixture','fixture_primary',true,10,now())`,
  );
  assert.equal(await installer({}, 10).reconcileAuthAccess(false), "incomplete");
  assert.equal(await installer({}, 10).reconcileRetirementAccess(), "incomplete");
  await auth.query(
    `delete from "app_actor_assignment" where "actorId"='other_actor' and "appId"='platform-fixture'`,
  );
  await auth.query(`delete from "user" where id='other_actor'`);
  await app.query(
    `insert into kernel_actor_membership (principal_name,app_id,customer_id,actor_id,role,active,fence_generation) values ('protected_app_runtime','platform-fixture','org_fixture','other_actor','fixture_primary',true,10)`,
  );
  assert.equal(await installer({}, 10).reconcileRetirementAccess(), "incomplete");
  await app.query(
    `delete from kernel_actor_membership where actor_id='other_actor' and app_id='platform-fixture'`,
  );
  checks++;
  // A genuinely existing tenant missing a different requested release remains
  // unsupported here; a version-name guess must not authorize its upgrade.
  const nextSource = path.join(directory, "platform-fixture-next.cue");
  await writeFile(
    nextSource,
    (await readFile(path.join(directory, "platform-fixture.cue"), "utf8")).replace(
      'version: "platform-fixture-v1"',
      'version: "platform-fixture-v2"',
    ),
  );
  const nextDirectory = buildGeneratedRelease(
    "platform-fixture",
    path.join(directory, "next-release"),
    ["packages/schema-compiler/cue/app-manifest.cue", path.relative(root, nextSource)],
  ).directory;
  const nextManifest = verifyCheckedRelease(nextDirectory);
  const nextTrust = {
    ...trust,
    sqlBundleHash: sha256(await readFile(path.join(nextDirectory, "sql-bundle.sql"))),
  };
  const nextPlan = {
    ...plan,
    installer: nextTrust,
    release: {
      id: nextManifest.schema_version,
      artifactHash: nextManifest.hashes.schema!.replace(/^sha256:/u, ""),
      manifestHash: sha256(await readFile(path.join(nextDirectory, "release-manifest.json"))),
    },
  };
  assert.equal(
    await installer({
      plan: nextPlan,
      trust: nextTrust,
      releaseDirectory: nextDirectory,
    }).reconcileInstall(),
    "incomplete",
  );
  // New approved tenants share this populated database without adopting an
  // existing tenant's release or treating partial catalog rows as absence.
  const newTenantPlan: ProtectedGeneratedPlan = {
    ...nextPlan,
    organizations: ["org_new_a", "org_new_b"].map((organizationId) => ({
      organizationId,
      actors: [{ actorId: "actor_fixture", actorKind: "human", roles: ["fixture_primary"] }],
    })),
  };
  const newTenantInstaller = () =>
    installer({ plan: newTenantPlan, trust: nextTrust, releaseDirectory: nextDirectory });
  const withFixtureTenant = async <T>(
    organizationId: string,
    run: (client: import("pg").PoolClient) => Promise<T>,
  ) => {
    const client = await app!.connect();
    try {
      await client.query("begin");
      await client.query(
        "select set_config('kernel.app_id',$1,true),set_config('kernel.customer_id',$2,true)",
        [plan.appId, organizationId],
      );
      const value = await run(client);
      await client.query("commit");
      return value;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  };
  const siblingSnapshot = async () =>
    withFixtureTenant(
      "org_fixture",
      async (client) =>
        (
          await client.query(
            `select to_jsonb(sr) as revision,to_jsonb(sir) as installation
         from schema_revision sr join schema_installation_revision sir on sir.schema_revision_id=sr.id
         where sr.app_id=$1 and sr.customer_id=$2 order by sr.id`,
            [plan.appId, "org_fixture"],
          )
        ).rows,
    );
  const siblingBefore = await siblingSnapshot();
  assert.equal(siblingBefore.length, 1);
  assert.equal(await newTenantInstaller().reconcileInstall(), "retryable");
  // Independently present installation metadata must not disappear through a join.
  // Only this owned negative fixture removes the FK to model partial/corrupt
  // metadata; restore it before exercising normal installation.
  await app.query(
    "alter table schema_installation_revision drop constraint schema_installation_revision_schema_revision_fk",
  );
  await withFixtureTenant("org_new_a", (client) =>
    client.query(
      `insert into schema_installation_revision
     select (jsonb_populate_record(null::schema_installation_revision,$1::jsonb)).*`,
      [
        JSON.stringify({
          ...siblingBefore[0]!.installation,
          schema_revision_id: -90001,
          customer_id: "org_new_a",
        }),
      ],
    ),
  );
  assert.equal(await newTenantInstaller().reconcileInstall(), "incomplete");
  await withFixtureTenant("org_new_a", (client) =>
    client.query("delete from schema_installation_revision where schema_revision_id=-90001"),
  );
  await withFixtureTenant("org_fixture", (client) =>
    client.query(
      "alter table schema_installation_revision add constraint schema_installation_revision_schema_revision_fk foreign key (schema_revision_id) references schema_revision(id)",
    ),
  );
  await withFixtureTenant("org_new_a", (client) =>
    client.query(
      `insert into schema_revision
     select (jsonb_populate_record(null::schema_revision,$1::jsonb)).*`,
      [JSON.stringify({ ...siblingBefore[0]!.revision, id: -90002, customer_id: "org_new_a" })],
    ),
  );
  assert.equal(await newTenantInstaller().reconcileInstall(), "incomplete");
  await withFixtureTenant("org_new_a", (client) =>
    client.query("delete from schema_revision where id=-90002"),
  );
  // Catalog absence never bypasses existing runtime role or binding checks.
  await admin.query(
    "create role new_tenant_foreign_role; grant new_tenant_foreign_role to protected_app_runtime",
  );
  assert.equal(await newTenantInstaller().reconcileInstall(), "incomplete");
  await admin.query(
    "revoke new_tenant_foreign_role from protected_app_runtime; drop role new_tenant_foreign_role",
  );
  await admin.query("alter role protected_app_runtime createdb");
  await assert.rejects(newTenantInstaller().reconcileInstall(), /identity_mismatch/u);
  await admin.query("alter role protected_app_runtime nocreatedb");
  assert.equal(await newTenantInstaller().reconcileInstall(), "retryable");
  assert.deepEqual(await siblingSnapshot(), siblingBefore);
  await newTenantInstaller().install();
  assert.equal(await newTenantInstaller().reconcileInstall(), "applied");
  await withFixtureTenant("org_new_a", (client) =>
    client.query(
      "update kernel_principal_scope set actor_binding_required=false where principal_name=$1 and app_id=$2 and customer_id=$3 and capability='runtime'",
      [plan.app.runtimeRole, plan.appId, "org_new_a"],
    ),
  );
  assert.equal(await newTenantInstaller().reconcileInstall(), "incomplete");
  await withFixtureTenant("org_new_a", (client) =>
    client.query(
      "update kernel_principal_scope set actor_binding_required=true where principal_name=$1 and app_id=$2 and customer_id=$3 and capability='runtime'",
      [plan.app.runtimeRole, plan.appId, "org_new_a"],
    ),
  );
  assert.equal(await newTenantInstaller().reconcileInstall(), "applied");
  assert.deepEqual(await siblingSnapshot(), siblingBefore);
  assert.deepEqual((await app.query("select * from preserved_data")).rows, [
    { id: "existing", value: "keep" },
  ]);
  checks += 14;
  // The same issued target can already be active for QA tenants while the
  // retained original tenant is still on its explicitly supported predecessor.
  const supportedDirectory = buildGeneratedRelease(
    "platform-fixture",
    path.join(directory, "supported-next-release"),
    ["packages/schema-compiler/cue/app-manifest.cue", path.relative(root, nextSource)],
    root,
    process.env,
    [path.join(releaseDirectory, "app-artifact.json")],
  ).directory;
  const supportedManifest = verifyCheckedRelease(supportedDirectory);
  const supportedTrust = {
    ...trust,
    sqlBundleHash: sha256(await readFile(path.join(supportedDirectory, "sql-bundle.sql"))),
  };
  const supportedPlan: ProtectedGeneratedPlan = {
    ...newTenantPlan,
    installer: supportedTrust,
    release: {
      id: supportedManifest.schema_version,
      artifactHash: supportedManifest.hashes.schema!.replace(/^sha256:/u, ""),
      manifestHash: sha256(await readFile(path.join(supportedDirectory, "release-manifest.json"))),
    },
    organizations: [...newTenantPlan.organizations, { organizationId: "org_fixture", actors: [] }],
  };
  const supportedInstaller = () =>
    installer({
      plan: supportedPlan,
      trust: supportedTrust,
      releaseDirectory: supportedDirectory,
      retainedInstallationCustomerIds: ["org_fixture"],
    });
  const snapshotTenant = async (organizationId: string) =>
    await withFixtureTenant(
      organizationId,
      async (client) =>
        (
          await client.query(
            `select sr.id::text as id,sr.activated_at as activated_at,sr.materialized_at as materialized_at,sir.ready_at as ready_at,sir.activated_at as installation_activated_at
     from schema_revision sr join schema_installation_revision sir on sir.schema_revision_id=sr.id
     where sr.app_id=$1 and sr.customer_id=$2 and sr.activated_at is not null order by sr.id`,
            [plan.appId, organizationId],
          )
        ).rows,
    );
  let upgradeFixturePhase = "fixture scope setup";
  try {
    const qaBefore = await Promise.all(
      newTenantPlan.organizations.map(async ({ organizationId }) => ({
        organizationId,
        rows: await snapshotTenant(organizationId),
      })),
    );
    // The platform fixture's declared policy needs an actual scoped database
    // actor even for its owned admin data client. This is not app access: retain
    // the real app runtime/Auth grants separately and assert them unchanged.
    for (const { organizationId } of supportedPlan.organizations) {
      const actorId = organizationId === "org_fixture" ? "fixture-retained-owner" : "fixture-qa";
      const scope: import("pg").QueryResult<{ result: { ok: boolean } }> = await app.query(
        "select kernel_bind_principal_scope($1::jsonb) as result",
        [
          JSON.stringify({
            principal_name: "postgres",
            capability: "runtime",
            app_id: plan.appId,
            customer_id: organizationId,
            actor_binding_required: true,
          }),
        ],
      );
      assert.equal(scope.rows[0]?.result.ok, true);
      const membership: import("pg").QueryResult<{ result: { ok: boolean } }> = await app.query(
        "select kernel_bind_actor_membership($1::jsonb) as result",
        [
          JSON.stringify({
            principal_name: "postgres",
            app_id: plan.appId,
            customer_id: organizationId,
            actor_id: actorId,
            actor_kind: "human",
            role: "fixture_primary",
            active: true,
            fence_generation: 1,
          }),
        ],
      );
      assert.equal(membership.rows[0]?.result.ok, true);
    }
    const fixtureRequest = () => ({
      audience: plan.appId,
      issuer: "https://fixture.invalid",
      jti: crypto.randomUUID(),
      method: "POST",
      target: "/fixture-data",
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      bodySha256: createHash("sha256").update("mixed-upgrade-fixture").digest("base64url"),
      payloadSha256: createHash("sha256").update("mixed-upgrade-fixture").digest("base64url"),
    });
    upgradeFixturePhase = "QA record seeding";
    const qaRecords: Array<{ organizationId: string; id: string; name: string; history: unknown }> =
      [];
    const qaDefinition = JSON.parse(
      await readFile(path.join(nextDirectory, "operation-manifest.json"), "utf8"),
    ) as DataDefinition;
    for (const { organizationId } of newTenantPlan.organizations) {
      const runtime = createGeneratedAppRuntime({
        appId: plan.appId,
        customerId: organizationId,
        databaseUrl: connection("postgres", plan.app.database),
        releaseDirectory: nextDirectory,
      });
      try {
        const operations = createDataClient(
          qaDefinition,
          runtime.dataContext({
            actorId: "fixture-qa",
            sourceKind: "mixed-upgrade-fixture",
            actorBinding: { role: "fixture_primary", fenceGeneration: 1 },
            protectedHttpRequest: fixtureRequest(),
            authorize: async () => {},
          }),
        );
        const name = `Retained QA record ${organizationId}`;
        upgradeFixturePhase = "QA record apply";
        await operations.apply({
          effectiveStart: "2026-10-20",
          idempotencyKey: `mixed-upgrade-${organizationId}`,
          writes: [operations.fixtureRecord!.writes.create({ name })],
        });
        upgradeFixturePhase = "QA record list";
        const records = await operations.fixtureRecord!.list({
          asOf: "2026-10-20",
          select: ["id", "name"],
        });
        assert.equal(records.length, 1);
        qaRecords.push({
          organizationId,
          id: records[0]!.id,
          name,
          history: await operations.fixtureRecord!.history({ id: records[0]!.id }),
        });
      } finally {
        await runtime.close();
      }
    }
    upgradeFixturePhase = "retained owner record seeding";
    const writeOwnerRuntime = createGeneratedAppRuntime({
      appId: plan.appId,
      customerId: "org_fixture",
      databaseUrl: connection("postgres", plan.app.database),
      releaseDirectory,
    });
    const definition = JSON.parse(
      await readFile(path.join(releaseDirectory, "operation-manifest.json"), "utf8"),
    ) as DataDefinition;
    let ownerRecordId = "";
    let ownerHistory: unknown;
    try {
      const operations = createDataClient(
        definition,
        writeOwnerRuntime.dataContext({
          actorId: "fixture-retained-owner",
          sourceKind: "mixed-upgrade-fixture",
          actorBinding: { role: "fixture_primary", fenceGeneration: 1 },
          protectedHttpRequest: fixtureRequest(),
          authorize: async () => {},
        }),
      );
      const write = operations.fixtureRecord!.writes.create({ name: "Retained owner record" });
      await operations.apply({
        effectiveStart: "2026-10-20",
        idempotencyKey: "mixed-upgrade-owner-record",
        notes: "Retained owner history",
        writes: [write],
      });
      const records = await operations.fixtureRecord!.list({
        asOf: "2026-10-20",
        select: ["id", "name"],
      });
      assert.equal(records.length, 1);
      ownerRecordId = records[0]!.id;
      ownerHistory = await operations.fixtureRecord!.history({ id: ownerRecordId });
    } finally {
      await writeOwnerRuntime.close();
    }
    upgradeFixturePhase = "mixed installed reconciliation";
    assert.equal(await supportedInstaller().reconcileInstall(), "retryable");
    const beforeReadback = await runAccessSpoolWorker("prepare", 18, {
      readbackOnly: true,
      installReadback: true,
      installPlan: supportedPlan,
      installReleaseDirectory: supportedDirectory,
    });
    assert.equal(beforeReadback.readbackStatus, "retryable");
    const accessBeforeUpgrade = await readFences();
    // The full union was approved while the retained owner scope was active.
    // A later revocation must not become an implicit runtime grant at execution.
    const ownerBeforeRevocation = await snapshotTenant("org_fixture");
    await withFixtureTenant("org_fixture", (client) =>
      client.query(
        "update kernel_principal_scope set active=false where principal_name=$1 and app_id=$2 and customer_id=$3 and capability='runtime'",
        [plan.app.runtimeRole, plan.appId, "org_fixture"],
      ),
    );
    const revokedScope = async () =>
      await withFixtureTenant(
        "org_fixture",
        async (client) =>
          (
            await client.query(
              "select active,actor_binding_required from kernel_principal_scope where principal_name=$1 and app_id=$2 and customer_id=$3 and capability='runtime'",
              [plan.app.runtimeRole, plan.appId, "org_fixture"],
            )
          ).rows,
      );
    assert.deepEqual(await revokedScope(), [{ active: false, actor_binding_required: true }]);
    upgradeFixturePhase = "revoked retained scope rejection";
    await assert.rejects(
      supportedInstaller().install(),
      /protected_installer_scope_readback_failed/u,
    );
    const rejectedInstall = await runAccessSpoolWorker("prepare", 18, {
      install: true,
      expectedInstallFailure: true,
      installPlan: supportedPlan,
      installReleaseDirectory: supportedDirectory,
    });
    assert.equal(
      rejectedInstall.authorizedEffects,
      0,
      "revoked retained scope must reject before install effects",
    );
    assert.deepEqual(await revokedScope(), [{ active: false, actor_binding_required: true }]);
    assert.deepEqual(await snapshotTenant("org_fixture"), ownerBeforeRevocation);
    for (const before of qaBefore)
      assert.deepEqual(await snapshotTenant(before.organizationId), before.rows);
    assert.deepEqual(await readFences(), accessBeforeUpgrade);
    // Restore only this owned negative fixture, then exercise the same original
    // active-owner happy path and all record/history preservation assertions.
    await withFixtureTenant("org_fixture", (client) =>
      client.query(
        "update kernel_principal_scope set active=true where principal_name=$1 and app_id=$2 and customer_id=$3 and capability='runtime'",
        [plan.app.runtimeRole, plan.appId, "org_fixture"],
      ),
    );
    checks++;
    upgradeFixturePhase = "compiled union install";
    await runAccessSpoolWorker("prepare", 18, {
      install: true,
      installPlan: supportedPlan,
      installReleaseDirectory: supportedDirectory,
    });
    upgradeFixturePhase = "post-install reconciliation";
    assert.equal(await supportedInstaller().reconcileInstall(), "applied");
    assert.equal(
      (
        await runAccessSpoolWorker("prepare", 18, {
          readbackOnly: true,
          installReadback: true,
          installPlan: supportedPlan,
          installReleaseDirectory: supportedDirectory,
        })
      ).readbackStatus,
      "applied",
    );
    for (const before of qaBefore)
      assert.deepEqual(
        await snapshotTenant(before.organizationId),
        before.rows,
        "already current QA heads and installation timestamps must be preserved",
      );
    upgradeFixturePhase = "retained QA data readback";
    const upgradedDefinition = JSON.parse(
      await readFile(path.join(supportedDirectory, "operation-manifest.json"), "utf8"),
    ) as DataDefinition;
    for (const before of qaRecords) {
      const runtime = createGeneratedAppRuntime({
        appId: plan.appId,
        customerId: before.organizationId,
        databaseUrl: connection("postgres", plan.app.database),
        releaseDirectory: supportedDirectory,
      });
      try {
        const operations = createDataClient(
          upgradedDefinition,
          runtime.dataContext({
            actorId: "fixture-qa",
            sourceKind: "mixed-upgrade-fixture",
            actorBinding: { role: "fixture_primary", fenceGeneration: 1 },
            protectedHttpRequest: fixtureRequest(),
            authorize: async () => {},
          }),
        );
        const records = await operations.fixtureRecord!.list({
          asOf: "2026-10-20",
          select: ["id", "name"],
        });
        assert.equal(records.length, 1);
        assert.equal(records[0]!.id, before.id);
        assert.equal(records[0]!.name, before.name);
        assert.deepEqual(
          await operations.fixtureRecord!.history({ id: before.id }),
          before.history,
        );
      } finally {
        await runtime.close();
      }
    }
    assert.deepEqual(
      await readFences(),
      accessBeforeUpgrade,
      "schema-only owner inclusion must not grant or alter app access",
    );
    upgradeFixturePhase = "retained owner data readback";
    const upgradedOwnerRuntime = createGeneratedAppRuntime({
      appId: plan.appId,
      customerId: "org_fixture",
      databaseUrl: connection("postgres", plan.app.database),
      releaseDirectory: supportedDirectory,
    });
    try {
      const nextDefinition = JSON.parse(
        await readFile(path.join(supportedDirectory, "operation-manifest.json"), "utf8"),
      ) as DataDefinition;
      const operations = createDataClient(
        nextDefinition,
        upgradedOwnerRuntime.dataContext({
          actorId: "fixture-retained-owner",
          sourceKind: "mixed-upgrade-fixture",
          actorBinding: { role: "fixture_primary", fenceGeneration: 1 },
          protectedHttpRequest: fixtureRequest(),
          authorize: async () => {},
        }),
      );
      const records = await operations.fixtureRecord!.list({
        asOf: "2026-10-20",
        select: ["id", "name"],
      });
      assert.equal(records.length, 1);
      assert.equal(records[0]!.id, ownerRecordId);
      assert.equal(records[0]!.name, "Retained owner record");
      assert.deepEqual(
        await operations.fixtureRecord!.history({ id: ownerRecordId }),
        ownerHistory,
        "the existing owner record history must survive schema-only upgrade",
      );
    } finally {
      await upgradedOwnerRuntime.close();
    }
    // Exercise the separate pure installer with a genuinely pending upgrade.
    // An already-current replay would hide a nested helper rolling back its
    // caller-owned activation transaction.
    upgradeFixturePhase = "pure retained-target upgrade";
    const pureSource = path.join(directory, "platform-fixture-pure-next.cue");
    await writeFile(
      pureSource,
      (await readFile(nextSource, "utf8")).replace(
        'version: "platform-fixture-v2"',
        'version: "platform-fixture-v3"',
      ),
    );
    const pureDirectory = buildGeneratedRelease(
      "platform-fixture",
      path.join(directory, "pure-next-release"),
      ["packages/schema-compiler/cue/app-manifest.cue", path.relative(root, pureSource)],
      root,
      process.env,
      [path.join(supportedDirectory, "app-artifact.json")],
    ).directory;
    const pureManifest = verifyCheckedRelease(pureDirectory);
    const pureTrust = {
      ...trust,
      sqlBundleHash: sha256(await readFile(path.join(pureDirectory, "sql-bundle.sql"))),
    };
    const purePlan: ProtectedGeneratedPlan = {
      ...supportedPlan,
      installer: pureTrust,
      release: {
        id: pureManifest.schema_version,
        artifactHash: pureManifest.hashes.schema!.replace(/^sha256:/u, ""),
        manifestHash: sha256(await readFile(path.join(pureDirectory, "release-manifest.json"))),
      },
    };
    const pureInstaller = installer({
      plan: purePlan,
      trust: pureTrust,
      releaseDirectory: pureDirectory,
      retainedInstallationCustomerIds: ["org_fixture"],
    });
    assert.equal(await pureInstaller.reconcileInstall(), "retryable");
    await pureInstaller.install();
    assert.equal(await pureInstaller.reconcileInstall(), "applied");
    const pureDefinition = JSON.parse(
      await readFile(path.join(pureDirectory, "operation-manifest.json"), "utf8"),
    ) as DataDefinition;
    for (const before of [
      ...qaRecords,
      {
        organizationId: "org_fixture",
        id: ownerRecordId,
        name: "Retained owner record",
        history: ownerHistory,
      },
    ]) {
      const runtime = createGeneratedAppRuntime({
        appId: plan.appId,
        customerId: before.organizationId,
        databaseUrl: connection("postgres", plan.app.database),
        releaseDirectory: pureDirectory,
      });
      try {
        const operations = createDataClient(
          pureDefinition,
          runtime.dataContext({
            actorId:
              before.organizationId === "org_fixture" ? "fixture-retained-owner" : "fixture-qa",
            sourceKind: "mixed-upgrade-fixture",
            actorBinding: { role: "fixture_primary", fenceGeneration: 1 },
            protectedHttpRequest: fixtureRequest(),
            authorize: async () => {},
          }),
        );
        const records = await operations.fixtureRecord!.list({
          asOf: "2026-10-20",
          select: ["id", "name"],
        });
        assert.equal(records.length, 1);
        assert.equal(records[0]!.id, before.id);
        assert.equal(records[0]!.name, before.name);
        assert.deepEqual(
          await operations.fixtureRecord!.history({ id: before.id }),
          before.history,
        );
      } finally {
        await runtime.close();
      }
    }
    assert.deepEqual(await readFences(), accessBeforeUpgrade);
    assert.deepEqual(await revokedScope(), [{ active: true, actor_binding_required: true }]);
    assert.deepEqual((await app.query("select * from preserved_data")).rows, [
      { id: "existing", value: "keep" },
    ]);
    checks += 8;

    // Normal access execution projects only its approved actor organizations,
    // even though installation retained the original owner in the schema union.
    upgradeFixturePhase = "access-only inspection after union installation";
    for (const { organizationId } of newTenantPlan.organizations) {
      await auth.query(`insert into "organization" values ($1,$1,$1,null,now(),null,'[]')`, [
        organizationId,
      ]);
      await auth.query(
        `insert into "member" (id,"organizationId","userId",role,"createdAt") values ($3,$1,$2,'member',now())`,
        [organizationId, "actor_fixture", crypto.randomUUID()],
      );
    }
    const ownerAccessBefore = await readFences();
    const ownerRuntimeScopeBefore = await revokedScope();
    const accessOptions = {
      repositoryProduction: true,
      installPlan: { ...purePlan, authOperatorRole },
      installReleaseDirectory: pureDirectory,
      connections: operatorConnections,
    };
    for (const install of [false, true]) {
      const rejected = await runAccessSpoolWorker("prepare", 19, {
        repositoryProduction: true,
        install,
        expectedInstallFailure: true,
      });
      assert.equal(rejected.authorizedEffects, 0);
      checks++;
    }
    await runAccessSpoolWorker("prepare", 19, { ...accessOptions, tamper: true });
    checks++;
    assert.equal(
      (await runAccessSpoolWorker("prepare", 19, { ...accessOptions, readbackOnly: true }))
        .readbackStatus,
      "absent",
    );
    await runAccessSpoolWorker("prepare", 19, accessOptions);
    assert.equal(
      (await runAccessSpoolWorker("prepare", 19, { ...accessOptions, readbackOnly: true }))
        .readbackStatus,
      "applied",
    );
    const assignments = await auth.query(
      'select "organizationId",active,"fence_generation"::int as generation from "app_actor_assignment" where "appId"=$1 and "organizationId"=any($2::text[]) order by "organizationId"',
      [plan.appId, newTenantPlan.organizations.map((organization) => organization.organizationId)],
    );
    assert.deepEqual(
      assignments.rows,
      newTenantPlan.organizations.map(({ organizationId }) => ({
        organizationId,
        active: true,
        generation: 19,
      })),
    );
    assert.deepEqual(await readFences(), ownerAccessBefore);
    assert.deepEqual(await revokedScope(), ownerRuntimeScopeBefore);

    // A genuinely missing selected tenant still cannot satisfy access install verification.
    const missingSelected = installer({
      plan: { ...purePlan, organizations: [{ organizationId: "org_not_installed", actors: [] }] },
      trust: pureTrust,
      releaseDirectory: pureDirectory,
    });
    await assert.rejects(missingSelected.verify(), /protected_installer_release_readback_failed/u);
    assert.throws(
      () =>
        installer({
          plan: { ...purePlan, appId: "other-fixture" },
          trust: pureTrust,
          releaseDirectory: pureDirectory,
        }),
      /protected_installer_identity_mismatch/u,
    );
    const selectedTenant = newTenantPlan.organizations[0]!.organizationId;
    await withFixtureTenant(selectedTenant, async (client) => {
      await client.query(
        "update schema_installation_revision set effective_artifact_hash=$4 where app_id=$1 and release_id=$2 and customer_id=$3",
        [plan.appId, purePlan.release.id, selectedTenant, "f".repeat(64)],
      );
    });
    try {
      await assert.rejects(pureInstaller.verify(), /protected_installer_release_readback_failed/u);
    } finally {
      await withFixtureTenant(selectedTenant, async (client) => {
        await client.query(
          "update schema_installation_revision set effective_artifact_hash=$4 where app_id=$1 and release_id=$2 and customer_id=$3",
          [plan.appId, purePlan.release.id, selectedTenant, purePlan.release.artifactHash],
        );
      });
    }
    assert.deepEqual(await pureInstaller.verify(), {
      releaseId: purePlan.release.id,
      artifactHash: purePlan.release.artifactHash,
    });
    // Close only this new QA grant so the existing global Auth-retirement
    // readback below still observes its original no-active-consumers boundary.
    await runAccessSpoolWorker("cleanup", 20, accessOptions);
    assert.equal(
      (await runAccessSpoolWorker("cleanup", 20, { ...accessOptions, readbackOnly: true }))
        .readbackStatus,
      "applied",
    );
    assert.deepEqual(await readFences(), ownerAccessBefore);
    assert.deepEqual(await revokedScope(), ownerRuntimeScopeBefore);
    checks += 9;
  } catch (error) {
    throw new Error(
      `Mixed upgrade fixture failed during ${upgradeFixturePhase}${error instanceof KernelFailure ? `: ${JSON.stringify(error.envelope.details)}` : ""}`,
      { cause: error },
    );
  }
  checks += await exerciseRolelessAccess({
    root,
    directory,
    admin,
    auth,
    authResource: plan.auth,
    authOperatorRole,
    connection,
    password,
    observeSignupWire: async (signupPlan, receipt, readbackOnly, signupReleaseDirectory) => {
      const result = await runAccessSpoolWorker("prepare", 10, {
        installPlan: signupPlan,
        installReleaseDirectory: signupReleaseDirectory,
        connections: {
          appMigrator: connection(signupPlan.app.migratorRole, signupPlan.app.database),
          appRuntime: connection(signupPlan.app.runtimeRole, signupPlan.app.database),
          authOperator: connection(authOperatorRole, signupPlan.auth.database),
          authRuntime: connection(signupPlan.auth.runtimeRole, signupPlan.auth.database),
        },
        signupGrantReadback: receipt,
        readbackOnly,
        expectedInstallFailure: !readbackOnly,
      });
      assert.equal(result.authorizedEffects, 0);
      return result.readbackStatus;
    },
  });
  await app.end();
  app = undefined;
  await admin.query(`drop database ${plan.app.database}`);
  await assert.rejects(installer({}, 10).reconcileAccess(false), /does not exist/u);
  assert.equal(await installer({}, 16).reconcileAuthAccess(false), "applied");
  assert.equal(await installer({}, 15).reconcileAuthAccess(false), "incomplete");
  checks++;

  console.log(
    `Protected generated installer: ${checks} owned disposable PostgreSQL checks passed; no hosted evidence.`,
  );
} finally {
  await Promise.allSettled(
    [...workers].map(async (worker) => {
      if (worker.pid === undefined || worker.exitCode !== null || worker.signalCode !== null)
        return;
      const exited = once(worker, "exit");
      worker.kill("SIGKILL");
      await exited;
    }),
  );
  await Promise.all([app?.end(), auth?.end(), admin?.end()]);
  if (started) command("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
  await rm(directory, { recursive: true, force: true });
}
