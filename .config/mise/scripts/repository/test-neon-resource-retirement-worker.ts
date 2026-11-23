import assert from "node:assert/strict";
import { prepareProtectedInstallerTestRelease } from "./protected-installer-test-fixture";
import { z } from "zod";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { createServer } from "node:net";
import { Client, Pool, type QueryResult } from "pg";
import { retireNeonResource } from "../../../../packages/provisioning/neon-resource-bootstrap-worker";
import {
  digestResourceBootstrapContext,
  digestResourceBootstrapCredentials,
  type ResourceBootstrapContext,
} from "../../../../packages/protected-installer/node-spool";
import { verifyCheckedRelease } from "../../../../packages/generated-app-runtime/server";
import {
  createProtectedGeneratedInstaller,
  type ProtectedGeneratedPlan,
  type ProtectedGeneratedConnections,
} from "../../../../packages/generated-app-runtime/protected-installer";

// Own every byte and process; never consume a configured database URL or provider credential.
const directory = await mkdtemp(path.join(tmpdir(), "neon-retirement-test-"));
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
const binary = path.join(directory, "neon-resource-fixed");
try {
  const bundled = spawnSync(
    "bun",
    [
      path.join(root, ".config/mise/scripts/repository/build-neon-resource-bootstrap-worker.mjs"),
      directory,
    ],
    { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH } },
  );
  assert.equal(bundled.status, 0, bundled.stderr);
  const compiled = spawnSync(
    "bun",
    [
      "build",
      "--compile",
      path.join(directory, "neon-resource-bootstrap-worker.js"),
      "--outfile",
      binary,
    ],
    { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH } },
  );
  assert.equal(compiled.status, 0, compiled.stderr);
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
  await admin.query(
    `create role resource_bootstrap login createdb createrole nosuperuser noreplication nobypassrls noinherit password '${password}'`,
  );
  const roleCreator = new Pool({ connectionString: connection("resource_bootstrap", "postgres") });
  for (const target of [plan.auth]) {
    await roleCreator.query(
      `create role ${target.migratorRole} login createrole password '${password}'; create role ${target.runtimeRole} login password '${password}'`,
    );
    await admin.query(`create database ${target.database} owner ${target.migratorRole}`);
  }
  await roleCreator.end();
  const bootstrapContext: ResourceBootstrapContext = {
    kind: "neon_resource_bootstrap",
    version: 1,
    operation: {
      operation_id: crypto.randomUUID(),
      approval_digest: sha256(JSON.stringify({ action: "prepare", plan })),
      fence_generation: 1,
    },
    app_id: plan.appId,
    resource: {
      scope: "app_database",
      resource_id: plan.app.resourceId,
      environment: "local",
      hostname: "127.0.0.1",
      port,
      database: plan.app.database,
      migrator_role: plan.app.migratorRole,
      runtime_role: plan.app.runtimeRole,
      maintenance_database: "postgres",
      bootstrap_role: "resource_bootstrap",
      credentials_sha256: digestResourceBootstrapCredentials({
        migratorPassword: password,
        runtimePassword: password,
      }),
    },
    release: { id: plan.release.id, sha256: plan.release.manifestHash },
    installer: { id: "neon-resource-bootstrap-v1", sha256: sha256(await readFile(binary)) },
    tenant_targets: [],
  };
  const launchBootstrap = async (
    workerContext: ResourceBootstrapContext,
    stopAt?: "roles" | "database",
  ) => {
    const bootstrapSpool = path.join(directory, `bootstrap-spool-${crypto.randomUUID()}`);
    for (const name of ["startup", "requests", "responses", "lifecycle"])
      await mkdir(path.join(bootstrapSpool, name), { recursive: true });
    const bootstrapRunId = crypto.randomUUID();
    for (const [name, value] of Object.entries({
      "context.json": workerContext,
      "direct-database-url.json": connection("resource_bootstrap", "postgres"),
      "resource-credentials.json": { migratorPassword: password, runtimePassword: password },
      "ready.json": { version: 1, run_id: bootstrapRunId, frame_id: 0 },
    }))
      await writeFile(path.join(bootstrapSpool, "startup", name), JSON.stringify(value), {
        mode: 0o600,
      });
    const bootstrapChild = spawn(
      binary,
      ["neon-resource-bootstrap", "--file-spool", bootstrapSpool, bootstrapRunId, "10000"],
      { cwd: directory, env: {}, stdio: ["ignore", "pipe", "pipe"] },
    );
    const bootstrapExit = once(bootstrapChild, "close");
    let bootstrapError = "";
    bootstrapChild.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      bootstrapError += chunk;
    });
    let bootstrapEffects = 0;
    let crashObserved = false;
    for await (const line of createInterface({ input: bootstrapChild.stdout })) {
      const notice = JSON.parse(line);
      if (notice.kind !== "protected_installer_frame_ready") continue;
      const frame = JSON.parse(
        await readFile(path.join(bootstrapSpool, "requests", `${notice.frame_id}.json`), "utf8"),
      );
      assert.equal(frame.context_digest, digestResourceBootstrapContext(workerContext));
      assert.equal(frame.resource_id, workerContext.resource.resource_id);
      assert.equal(frame.tenant_id, null);
      if (frame.kind === "check_fence") {
        const native = await admin!.query(
          `select pg_get_userbyid(datdba) as owner,shobj_description(oid,'pg_database') as comment
         from pg_database where datname=$1`,
          [workerContext.resource.database],
        );
        const interrupted =
          stopAt === "database" &&
          native.rows[0]?.owner === workerContext.resource.migrator_role &&
          native.rows[0]?.comment === null;
        if (interrupted) crashObserved = true;
        await writeFile(
          path.join(bootstrapSpool, "responses", `${notice.frame_id}.json`),
          JSON.stringify({
            kind: "fence_current",
            version: 1,
            operation_id: frame.operation_id,
            context_digest: frame.context_digest,
            fence_generation: frame.fence_generation,
            current: !interrupted,
          }),
        );
        await writeFile(
          path.join(bootstrapSpool, "responses", `${notice.frame_id}.ready`),
          JSON.stringify({
            version: 1,
            run_id: bootstrapRunId,
            frame_id: notice.frame_id,
          }),
        );
        continue;
      }
      assert(["resources:roles", "resources:database", "resources:acl"].includes(frame.effect_id));
      if (frame.kind === "authorize_effect") bootstrapEffects++;
      const reply = {
        version: 1,
        kind: frame.kind === "authorize_effect" ? "effect_authorized" : "checkpoint_recorded",
        operation_id: frame.operation_id,
        context_digest: frame.context_digest,
        fence_generation: frame.fence_generation,
        sequence: frame.sequence,
        effect_id: frame.effect_id,
        ...(frame.kind === "authorize_effect"
          ? { allowed: !(stopAt === "roles" && frame.effect_id === "resources:database") }
          : { recorded: true }),
      };
      await writeFile(
        path.join(bootstrapSpool, "responses", `${notice.frame_id}.json`),
        JSON.stringify(reply),
      );
      await writeFile(
        path.join(bootstrapSpool, "responses", `${notice.frame_id}.ready`),
        JSON.stringify({ version: 1, run_id: bootstrapRunId, frame_id: notice.frame_id }),
      );
    }
    const exit = (await bootstrapExit)[0];
    assert(!bootstrapError.includes(password));
    return { exit, bootstrapError, bootstrapEffects, crashObserved };
  };
  const prepared = await launchBootstrap(bootstrapContext);
  assert.equal(prepared.exit, 0, prepared.bootstrapError);
  assert.equal(prepared.bootstrapEffects, 3);
  checks += 2;
  app = new Pool({ connectionString: connections.appMigrator });
  auth = new Pool({ connectionString: connections.authMigrator });
  await app.query(
    `revoke create on schema public from public;
     create table preserved_data(id text primary key, value text);
     insert into preserved_data values ('existing','keep');
     create table kernel_actor_membership (
       principal_name name not null, app_id text not null, customer_id text not null,
       actor_id text not null, role text not null, active boolean not null default true,
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
  const operatorConnections: ProtectedGeneratedConnections = {
    appMigrator: connections.appMigrator,
    appRuntime: connections.appRuntime,
    authOperator: connection(authOperatorRole, plan.auth.database),
    authRuntime: connections.authRuntime,
  };

  await auth.query(
    `insert into "app_actor_assignment" ("organizationId","actorId","appId",role,active)
     values ('org_fixture','actor_fixture','other-app','member',true);
     grant select on all tables in schema public to protected_auth_runtime;`,
  );

  await installer().install();
  await installer().grant();
  // A genuine dependency in a preserved sibling DB requires retention and closed login.
  await auth.query("grant select on session to protected_app_migrator");
  const approvedPlan = {
    version: 1,
    action: "cleanup",
    selection: { appId: plan.appId },
    appDatabase: {
      resourceId: plan.app.resourceId,
      database: plan.app.database,
      migratorRole: plan.app.migratorRole,
      runtimeRole: plan.app.runtimeRole,
    },
    authDatabase: {
      resourceId: plan.auth.resourceId,
      database: plan.auth.database,
      migratorRole: plan.auth.migratorRole,
      runtimeRole: plan.auth.runtimeRole,
    },
    neon: { endpoint: plan.app.hostname },
    release: { id: plan.release.id, sha256: plan.release.manifestHash },
    installer: { reference: "generated-app-protected-installer-v1", sha256: "b".repeat(64) },
    resourcesWorker: { reference: "neon-resource-bootstrap-v1", sha256: "c".repeat(64) },
    access: [
      {
        organizationId: "org_fixture",
        actorId: "actor_fixture",
        actorKind: "human",
        roles: ["fixture_primary"],
      },
    ],
  };
  const context: ResourceBootstrapContext = {
    kind: "neon_resource_bootstrap",
    version: 1,
    operation: {
      operation_id: crypto.randomUUID(),
      approval_digest: sha256(JSON.stringify(approvedPlan)),
      fence_generation: 2,
    },
    app_id: plan.appId,
    resource: {
      scope: "app_database",
      resource_id: plan.app.resourceId,
      environment: "local",
      hostname: "127.0.0.1",
      port,
      database: plan.app.database,
      migrator_role: plan.app.migratorRole,
      runtime_role: plan.app.runtimeRole,
      maintenance_database: "postgres",
      bootstrap_role: "resource_bootstrap",
      credentials_sha256: "d".repeat(64),
    },
    release: { id: plan.release.id, sha256: plan.release.manifestHash },
    installer: { id: "neon-resource-bootstrap-v1", sha256: "c".repeat(64) },
    tenant_targets: [],
  };
  const maintenance = new Client({
    connectionString: connection("resource_bootstrap", "postgres"),
  });
  await maintenance.connect();
  const retirementLocks = [
    `database:${context.resource.database}`,
    `role:${context.resource.migrator_role}`,
    `role:${context.resource.runtime_role}`,
  ]
    .sort()
    .map((identity) => `protected-resource-bootstrap:${identity}`);
  const withRetirementLocks = async <T>(run: () => Promise<T>): Promise<T> => {
    const acquired: string[] = [];
    try {
      for (const key of retirementLocks) {
        await maintenance.query("select pg_advisory_lock(hashtextextended($1,0))", [key]);
        acquired.push(key);
      }
      return await run();
    } finally {
      for (const key of acquired.reverse())
        await maintenance.query("select pg_advisory_unlock(hashtextextended($1,0))", [key]);
    }
  };
  const pin = sha256(await readFile(binary));
  approvedPlan.resourcesWorker.sha256 = pin;
  context.installer.sha256 = pin;
  context.operation.approval_digest = sha256(JSON.stringify(approvedPlan));
  const retirementContext = context;
  const retirementPlan = approvedPlan;
  const retirementConnections = connections;
  const operatorPlan = {
    ...approvedPlan,
    kind: "repository-production-setup-v1",
    authOperatorRole,
  };
  const operatorContext = {
    ...context,
    operation: { ...context.operation, approval_digest: sha256(JSON.stringify(operatorPlan)) },
  };

  const launchRetirement = async (
    workerCommand = "neon-resource-retire",
    context = retirementContext,
    approvedPlan = retirementPlan,
    connections: ProtectedGeneratedConnections = retirementConnections,
    expectStartupRejection = false,
  ) => {
    const spool = path.join(directory, `retire-spool-${workerCommand}-${crypto.randomUUID()}`);
    for (const name of ["startup", "requests", "responses", "lifecycle"])
      await mkdir(path.join(spool, name), { recursive: true });
    const runId = crypto.randomUUID();
    for (const [name, value] of Object.entries({
      "context.json": context,
      "direct-database-url.json": connection("resource_bootstrap", "postgres"),
      "approved-access-plan.json": approvedPlan,
      "access-connections.json": connections,
      "ready.json": { version: 1, run_id: runId, frame_id: 0 },
    }))
      await writeFile(path.join(spool, "startup", name), JSON.stringify(value), { mode: 0o600 });
    const child = spawn(
      binary,
      [workerCommand, "--file-spool", spool, runId, "10000", releaseDirectory],
      { cwd: directory, env: {}, stdio: ["ignore", "pipe", "pipe"] },
    );
    const exited = once(child, "close");
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const requests: Array<{ kind: string; effect_id?: string; receipt?: { state: string } }> = [];
    for await (const line of createInterface({ input: child.stdout })) {
      const notice = JSON.parse(line);
      if (notice.kind !== "protected_installer_frame_ready") continue;
      const request = JSON.parse(
        await readFile(path.join(spool, "requests", `${notice.frame_id}.json`), "utf8"),
      );
      requests.push(request);
      assert.equal(request.context_digest, digestResourceBootstrapContext(context));
      assert.equal(request.resource_id, context.resource.resource_id);
      assert.equal(request.tenant_id, null);
      const reply =
        request.kind === "check_fence"
          ? {
              kind: "fence_current",
              version: 1,
              operation_id: request.operation_id,
              context_digest: request.context_digest,
              fence_generation: request.fence_generation,
              current: true,
            }
          : {
              kind:
                request.kind === "authorize_effect" ? "effect_authorized" : "checkpoint_recorded",
              version: 1,
              operation_id: request.operation_id,
              context_digest: request.context_digest,
              fence_generation: request.fence_generation,
              sequence: request.sequence,
              effect_id: request.effect_id,
              ...(request.kind === "authorize_effect" ? { allowed: true } : { recorded: true }),
            };
      await writeFile(
        path.join(spool, "responses", `${notice.frame_id}.json`),
        JSON.stringify(reply),
        { mode: 0o600 },
      );
      await writeFile(
        path.join(spool, "responses", `${notice.frame_id}.ready`),
        JSON.stringify({ version: 1, run_id: runId, frame_id: notice.frame_id }),
        { mode: 0o600 },
      );
    }
    const [exit] = await exited;
    if (expectStartupRejection) {
      assert.notEqual(exit, 0);
      assert.equal(requests.filter((item) => item.kind === "authorize_effect").length, 0);
    }
    assert.equal(exit, 0, `${workerCommand}: ${stderr}`);
    const readOnly = workerCommand === "neon-resource-inspect-retired";
    assert.equal(
      requests.filter((item) => item.kind === "authorize_effect").length,
      readOnly ? 0 : 1,
    );
    assert.equal(
      requests.filter((item) => item.kind === "checkpoint_effect").length,
      readOnly ? 0 : 1,
    );
    if (!readOnly) {
      assert.equal(
        requests.find((item) => item.kind === "authorize_effect")?.effect_id,
        "resources:retire",
      );
      assert.equal(
        requests.find((item) => item.kind === "checkpoint_effect")?.receipt?.state,
        "applied",
      );
    }
    assert(requests.some((item) => item.kind === "check_fence"));
    assert(!stderr.includes(password));
    return z
      .object({
        databaseAbsent: z.boolean(),
        status: z.enum(["absent", "applied", "retryable", "unknown"]),
        authActorsClosed: z.boolean().optional(),
        retainedRoles: z.array(
          z.object({
            name: z.string(),
            reason: z.enum(["no_exclusive_owner_proof", "remaining_dependencies"]),
            globalAuthority: z.boolean(),
          }),
        ),
        operation_id: z.literal(context.operation.operation_id),
        context_digest: z.literal(digestResourceBootstrapContext(context)),
        fence_generation: z.literal(context.operation.fence_generation),
        resource_id: z.literal(context.resource.resource_id),
        scope: z.literal("app_database"),
      })
      .parse(JSON.parse(await readFile(path.join(spool, "resource-observation.json"), "utf8")));
  };
  const retire = () =>
    withRetirementLocks(() =>
      retireNeonResource({
        client: maintenance,
        context,
        approvedPlan,
        connections,
        releaseDirectory,
        assertCurrent: () => fence(),
      }),
    );
  try {
    const missingRolePlan = { ...approvedPlan, kind: "repository-production-setup-v1" };
    const missingRoleContext = {
      ...context,
      operation: { ...context.operation, approval_digest: sha256(JSON.stringify(missingRolePlan)) },
    };
    for (const workerCommand of ["neon-resource-retire", "neon-resource-inspect-retired"]) {
      await assert.rejects(
        launchRetirement(workerCommand, missingRoleContext, missingRolePlan, connections, true),
        /startup_rejected|readback_unknown/u,
      );
      await assert.rejects(
        launchRetirement(workerCommand, operatorContext, operatorPlan, connections, true),
        /startup_rejected|readback_unknown/u,
      );
      checks += 2;
    }
    await admin.query(
      "create role fixture_sibling_capability nologin; grant fixture_sibling_capability to protected_app_migrator with set true, inherit true",
    );
    await assert.rejects(retire(), /resource_identity_conflict/u);
    assert.equal(
      (
        await admin.query(
          `select exists(select 1 from pg_auth_members m join pg_roles granted on granted.oid=m.roleid join pg_roles member on member.oid=m.member where granted.rolname='fixture_sibling_capability' and member.rolname=$1 and m.set_option and m.inherit_option) as present`,
          [context.resource.migrator_role],
        )
      ).rows[0]?.present,
      true,
    );
    assert.deepEqual(
      (
        await admin.query("select rolcanlogin,rolcreaterole from pg_roles where rolname=$1", [
          context.resource.migrator_role,
        ])
      ).rows[0],
      { rolcanlogin: true, rolcreaterole: true },
    );
    await admin.query(
      "revoke fixture_sibling_capability from protected_app_migrator; grant protected_app_migrator to fixture_sibling_capability with set true, inherit true",
    );
    await assert.rejects(retire(), /resource_identity_conflict/u);
    assert.equal(
      (
        await admin.query(
          `select exists(select 1 from pg_auth_members m join pg_roles granted on granted.oid=m.roleid join pg_roles member on member.oid=m.member where granted.rolname=$1 and member.rolname='fixture_sibling_capability' and m.set_option and m.inherit_option) as present`,
          [context.resource.migrator_role],
        )
      ).rows[0]?.present,
      true,
    );
    await admin.query(
      "revoke protected_app_migrator from fixture_sibling_capability; drop role fixture_sibling_capability",
    );
    checks += 5;
    await assert.rejects(retire(), /cleanup_prerequisites_incomplete/u);
    checks++;
    await assert.rejects(
      retireNeonResource({
        client: maintenance,
        context: { ...context, resource: { ...context.resource, scope: "auth_database" } },
        approvedPlan,
        connections,
        releaseDirectory,
        assertCurrent: () => fence(),
      }),
      /shared_auth_retained/u,
    );
    checks++;
    await installer({}, 2).revoke();
    // A selective revoke is not enough when another actor in this app remains live.
    await app.query(
      "insert into kernel_actor_membership (principal_name,app_id,customer_id,actor_id,role,active,fence_generation) values ('protected_app_runtime','platform-fixture','another_org','another_actor','fixture_primary',true,2)",
    );
    await assert.rejects(retire(), /cleanup_prerequisites_incomplete/u);
    checks++;
    await app.query("delete from kernel_actor_membership where customer_id='another_org'");
    await auth.query(
      `insert into "user" (id,name,email,"emailVerified") values ('another_actor','Another','another@example.invalid',true);insert into "app_actor_assignment" ("organizationId","actorId","appId",role,active,"fence_generation") values ('org_fixture','another_actor','platform-fixture','fixture_primary',true,2)`,
    );
    await assert.rejects(retire(), /cleanup_prerequisites_incomplete/u);
    checks++;
    await auth.query(`delete from "app_actor_assignment" where "actorId"='another_actor'`);
    // Both access modes must be closed before an app database can be retired.
    await auth.query(`insert into app_actor_access("organizationId","actorId","appId","workspaceId",active,"fenceGeneration",roles)
      values ('org_fixture','another_actor','platform-fixture','fixture-workspace',true,2,'[]')`);
    await assert.rejects(retire(), /cleanup_prerequisites_incomplete/u);
    await assert.rejects(
      launchRetirement(
        "neon-resource-inspect-retired",
        operatorContext,
        operatorPlan,
        operatorConnections,
      ),
      /readback_unknown/u,
    );
    await auth.query(`delete from app_actor_access where "actorId"='another_actor'`);
    // The runtime table's row is independently checked even without Auth access.
    await app.query(`insert into kernel_actor_access(principal_name,app_id,customer_id,actor_id,actor_kind,active,fence_generation)
      values ('protected_app_runtime','platform-fixture','org_fixture','another_actor','human',true,2)`);
    await assert.rejects(retire(), /cleanup_prerequisites_incomplete/u);
    await app.query(`delete from kernel_actor_access where actor_id='another_actor'`);
    checks += 3;

    fence = async () => {
      throw new Error("stale fence");
    };
    await assert.rejects(retire(), /stale fence/u);
    checks++;
    fence = async () => {};
    // Recover an owned temporary SET grant left by a lost retirement process.
    await maintenance.query(
      "grant protected_app_migrator to resource_bootstrap with set true, inherit false",
    );
    const live = await app.connect();
    await assert.rejects(retire(), /being accessed/u);
    checks++;
    live.release();
    const activeAdmin = admin;
    const rejectAfterTemporaryGrant = async () => {
      const grant = await activeAdmin.query(
        `select exists(select 1 from pg_auth_members m join pg_roles granted on granted.oid=m.roleid join pg_roles member on member.oid=m.member join pg_roles grantor on grantor.oid=m.grantor where granted.rolname=$1 and member.rolname='resource_bootstrap' and grantor.rolname='resource_bootstrap' and m.set_option and not m.inherit_option and not m.admin_option) as present`,
        [context.resource.migrator_role],
      );
      if (grant.rows[0]?.present) throw new Error("stale fence after temporary grant");
    };
    await assert.rejects(
      withRetirementLocks(() =>
        retireNeonResource({
          client: maintenance,
          context,
          approvedPlan,
          connections,
          releaseDirectory,
          assertCurrent: rejectAfterTemporaryGrant,
        }),
      ),
      /stale fence after temporary grant/u,
    );
    assert.equal(
      (
        await admin.query(
          `select exists(select 1 from pg_auth_members m join pg_roles granted on granted.oid=m.roleid join pg_roles member on member.oid=m.member join pg_roles grantor on grantor.oid=m.grantor where granted.rolname=$1 and member.rolname='resource_bootstrap' and grantor.rolname='resource_bootstrap' and m.set_option and not m.inherit_option and not m.admin_option) as present`,
          [context.resource.migrator_role],
        )
      ).rows[0]?.present,
      false,
    );
    checks += 2;
    await app.end();
    app = undefined;
    await auth.query(
      `update "organization" set "appIds"='["platform-fixture"]' where id='org_fixture'`,
    );
    await assert.rejects(retire(), /cleanup_prerequisites_incomplete/u);
    await auth.query(`update "organization" set "appIds"='[]' where id='org_fixture'`);
    checks++;
    const closedPending = await launchRetirement("neon-resource-inspect-retired");
    assert.equal(closedPending.status, "retryable");
    assert.equal(closedPending.databaseAbsent, false);
    assert.equal(closedPending.authActorsClosed, true);
    checks += 3;
    const operatorPending = await launchRetirement(
      "neon-resource-inspect-retired",
      operatorContext,
      operatorPlan,
      operatorConnections,
    );
    assert.equal(operatorPending.status, "retryable");
    checks++;
    const result = await launchRetirement(
      "neon-resource-retire",
      operatorContext,
      operatorPlan,
      operatorConnections,
    );
    assert.equal(result.status, "applied");
    assert.equal(result.databaseAbsent, true);
    checks += 2;
    const inspectedRetired = await launchRetirement(
      "neon-resource-inspect-retired",
      operatorContext,
      operatorPlan,
      operatorConnections,
    );
    assert.equal(inspectedRetired.status, "applied");
    assert.equal(inspectedRetired.databaseAbsent, true);
    assert.equal(inspectedRetired.authActorsClosed, true);
    checks += 3;
    assert(
      result.retainedRoles.every((row) =>
        ["no_exclusive_owner_proof", "remaining_dependencies"].includes(row.reason),
      ),
    );
    const closedMigrator = await admin.query(
      "select rolcanlogin,rolcreaterole from pg_roles where rolname=$1",
      [plan.app.migratorRole],
    );
    assert.deepEqual(closedMigrator.rows[0], { rolcanlogin: false, rolcreaterole: false });
    assert(result.retainedRoles.some((row) => row.name === plan.app.migratorRole));
    assert.equal(
      (
        await auth.query("select has_table_privilege($1, 'session', 'select') as retained_select", [
          plan.app.migratorRole,
        ])
      ).rows[0]?.retained_select,
      true,
    );
    assert(result.retainedRoles.every((row) => row.globalAuthority === false));
    checks += 4;
    assert.equal(
      (await admin.query("select 1 from pg_database where datname='protected_app'")).rowCount,
      0,
    );
    checks++;
    assert.equal(
      (await admin.query("select 1 from pg_roles where rolname='protected_app_runtime'")).rowCount,
      0,
    );
    checks++;
    assert.equal(
      (await auth.query(`select 1 from "session" where id='existing-session'`)).rowCount,
      1,
    );
    checks++;
    assert.equal(
      (
        await auth.query(
          `select 1 from "app_actor_assignment" where "appId"='other-app' and active`,
        )
      ).rowCount,
      1,
    );
    checks++;
    await auth.query(
      `insert into "app_actor_assignment" ("organizationId","actorId","appId",role,active,"fence_generation") values ('org_fixture','another_actor','platform-fixture','fixture_primary',true,2)`,
    );
    await assert.rejects(retire(), /cleanup_prerequisites_incomplete/u);
    checks++;
    await auth.query(`delete from "app_actor_assignment" where "actorId"='another_actor'`);
    const replay = await retire();
    assert.equal(replay.databaseAbsent, true);
    checks++;
    const emptyAuth = resource("empty_owned_auth");
    const emptyAuthContext: ResourceBootstrapContext = {
      ...bootstrapContext,
      app_id: "auth",
      operation: { ...bootstrapContext.operation, operation_id: crypto.randomUUID() },
      resource: {
        ...bootstrapContext.resource,
        scope: "auth_database",
        resource_id: emptyAuth.resourceId,
        database: emptyAuth.database,
        migrator_role: emptyAuth.migratorRole,
        runtime_role: emptyAuth.runtimeRole,
      },
    };
    const emptyAuthBootstrap = await launchBootstrap(emptyAuthContext);
    assert.equal(emptyAuthBootstrap.exit, 0, emptyAuthBootstrap.bootstrapError);
    checks++;
    // Build real interrupted resources through the compiled worker, without catalog relabeling.
    for (const scenario of [
      { name: "roles", stopAt: "roles", emptyAuth: false },
      { name: "database", stopAt: "database", emptyAuth: false },
      { name: "empty_auth", stopAt: "database", emptyAuth: true },
    ] as const) {
      const { stopAt } = scenario;
      const fresh = resource(`pending_${scenario.name}`);
      const freshContext: ResourceBootstrapContext = {
        ...bootstrapContext,
        operation: { ...bootstrapContext.operation, operation_id: crypto.randomUUID() },
        resource: {
          ...bootstrapContext.resource,
          resource_id: fresh.resourceId,
          database: fresh.database,
          migrator_role: fresh.migratorRole,
          runtime_role: fresh.runtimeRole,
        },
      };
      const interrupted = await launchBootstrap(freshContext, stopAt);
      assert.notEqual(interrupted.exit, 0);
      assert.equal(interrupted.crashObserved, stopAt === "database");
      const native: QueryResult<{ owner: string; comment: string | null }> = await admin.query(
        `select pg_get_userbyid(datdba) as owner,shobj_description(oid,'pg_database') as comment
         from pg_database where datname=$1`,
        [fresh.database],
      );
      assert.equal(native.rowCount, stopAt === "database" ? 1 : 0);
      if (stopAt === "database")
        assert.deepEqual(native.rows[0], { owner: fresh.migratorRole, comment: null });
      assert.equal(
        (
          await admin.query(
            "select shobj_description(oid,'pg_authid') as comment from pg_roles where rolname=$1",
            [fresh.migratorRole],
          )
        ).rows[0]?.comment,
        `protected-resource:v1:app_database:${fresh.resourceId}:migrator${stopAt === "database" ? `:database-create-pending:${fresh.database}` : ""}`,
      );
      const freshPlan = {
        ...approvedPlan,
        appDatabase: {
          resourceId: fresh.resourceId,
          database: fresh.database,
          migratorRole: fresh.migratorRole,
          runtimeRole: fresh.runtimeRole,
        },
        ...(scenario.emptyAuth
          ? {
              authDatabase: {
                resourceId: emptyAuth.resourceId,
                database: emptyAuth.database,
                migratorRole: emptyAuth.migratorRole,
                runtimeRole: emptyAuth.runtimeRole,
              },
            }
          : {}),
      };
      freshContext.operation = {
        ...context.operation,
        operation_id: crypto.randomUUID(),
        approval_digest: sha256(JSON.stringify(freshPlan)),
      };
      const freshConnections = {
        ...connections,
        appMigrator: connection(fresh.migratorRole, fresh.database),
        appRuntime: connection(fresh.runtimeRole, fresh.database),
        ...(scenario.emptyAuth
          ? {
              authMigrator: connection(emptyAuth.migratorRole, emptyAuth.database),
              authRuntime: connection(emptyAuth.runtimeRole, emptyAuth.database),
            }
          : {}),
      };
      if (stopAt === "database") {
        const freshApp = new Pool({ connectionString: freshConnections.appMigrator });
        await freshApp.query("create table unexpected_app_data(id text)");
        await freshApp.end();
        await assert.rejects(
          launchRetirement(
            "neon-resource-inspect-retired",
            freshContext,
            freshPlan,
            freshConnections,
          ),
          /readback_unknown/u,
        );
        await assert.rejects(
          launchRetirement("neon-resource-retire", freshContext, freshPlan, freshConnections),
          /readback_unknown/u,
        );
        assert.equal(
          (await admin.query("select 1 from pg_database where datname=$1", [fresh.database]))
            .rowCount,
          1,
        );
        const clean = new Pool({ connectionString: freshConnections.appMigrator });
        assert.equal(
          (await clean.query("select to_regclass('public.unexpected_app_data') as preserved"))
            .rows[0]?.preserved,
          "unexpected_app_data",
        );
        await clean.query("drop table unexpected_app_data");
        assert.equal(
          (await clean.query("select to_regclass('public.kernel_actor_membership') as kernel"))
            .rows[0]?.kernel,
          null,
        );
        await clean.end();
        if (scenario.emptyAuth) {
          const wrongAuth = {
            ...freshConnections,
            authMigrator: connection(fresh.migratorRole, emptyAuth.database),
          };
          await assert.rejects(
            launchRetirement("neon-resource-retire", freshContext, freshPlan, wrongAuth),
            /readback_unknown/u,
          );
          assert.equal(
            (await admin.query("select 1 from pg_database where datname=$1", [fresh.database]))
              .rowCount,
            1,
          );
          checks += 2;
        }
        // A populated maintenance namespace must not be mistaken for AppDB contents.
        await admin.query("create table public.maintenance_only(id text)");
        const observed = await launchRetirement(
          "neon-resource-inspect-retired",
          freshContext,
          freshPlan,
          freshConnections,
        );
        assert.equal(observed.status, "retryable");
        checks += 6;
      }
      const recovered = await launchRetirement(
        "neon-resource-retire",
        freshContext,
        freshPlan,
        freshConnections,
      );
      assert.equal(recovered.status, "applied");
      assert.equal(recovered.databaseAbsent, true);
      if (stopAt === "database") {
        assert.equal(
          (await admin.query("select to_regclass('public.maintenance_only') as preserved")).rows[0]
            ?.preserved,
          "maintenance_only",
        );
        await admin.query("drop table public.maintenance_only");
        checks++;
      }
      assert.equal(
        (
          await admin.query("select 1 from pg_roles where rolname=any($1::text[])", [
            [fresh.migratorRole, fresh.runtimeRole],
          ])
        ).rowCount,
        0,
      );
      assert.equal(
        (await auth.query(`select 1 from session where id='existing-session'`)).rowCount,
        1,
      );
      assert.equal(
        (
          await auth.query(
            `select 1 from app_actor_assignment where "appId"='other-app' and active`,
          )
        ).rowCount,
        1,
      );
      checks += 9;
    }
    assert.equal(
      (await admin.query("select 1 from pg_database where datname=$1", [emptyAuth.database]))
        .rowCount,
      1,
    );
    const preservedEmptyAuth = new Pool({
      connectionString: connection(emptyAuth.migratorRole, emptyAuth.database),
    });
    assert.equal(
      (await preservedEmptyAuth.query("select to_regclass('public.organization') as organization"))
        .rows[0]?.organization,
      null,
    );
    await preservedEmptyAuth.end();
    checks += 2;
  } finally {
    await maintenance.end();
  }
  console.log(`Neon resource retirement owned PostgreSQL acceptance passed (${checks} checks)`);
} finally {
  await app?.end();
  await auth?.end();
  await admin?.end();
  if (started) command("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
  await rm(directory, { recursive: true, force: true });
}
