import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { Pool } from "pg";
import { createGeneratedAppRuntime, generatedAppLocalDatabaseUrl } from "../server";
import { createDataClient, type DataDefinition } from "../data";
import { capabilityRoleFixture } from "./capability-role-fixture";
import { buildGeneratedRelease } from "../../../.config/mise/scripts/repository/schema-release";
import { verifyCheckedReleaseMembers } from "../release-verification";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const token = randomUUID().replaceAll("-", "");
const appId = "protected-worker-fixture";
const tenants = [`protected-install-${token}-a`, `protected-install-${token}-b`];
const database = `protected_install_${token}`;
const runtimeRole = `protected_install_runtime_${token}`;
let releaseDirectory: string;
const workerSource = path.join(
  root,
  "packages/generated-app-runtime/protected-installer-worker.ts",
);
const scratch = path.join(root, ".scratch", `protected-generated-worker-${token}`);
const workerPath = path.join(scratch, "worker");
const releaseFiles = [
  "app-artifact.json",
  "sql-manifest.json",
  "sql-bundle.sql",
  "transition-plan.json",
  "transition-contract.json",
  "runtime-coverage.json",
  "cue-to-sql-source-map.json",
  "release-manifest.json",
  "operation-manifest.json",
  "data-operations.ts",
  "data-operations.md",
  "data-server.ts",
] as const;
const baseUrl = new URL(generatedAppLocalDatabaseUrl({ root, appId }));
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
let databaseCreated = false;
let runtimeRoleCreated = false;
let roleFixture: Awaited<ReturnType<typeof capabilityRoleFixture>>;
let buildOutput = "";

test("verifies checked release identity from the same captured member snapshot", () => {
  const snapshot = new Map(
    releaseFiles.map((name) => [name, readFileSync(path.join(releaseDirectory, name))]),
  );
  const manifest = verifyCheckedReleaseMembers(snapshot);
  expect(manifest.app).toBe(appId);
  expect(manifest.schema_version).toBeTruthy();
  snapshot.set("sql-bundle.sql", Buffer.from("-- changed after capture"));
  expect(() => verifyCheckedReleaseMembers(snapshot)).toThrow("checksum");
});

beforeAll(async () => {
  mkdirSync(scratch, { recursive: true });
  const cue = path.join(scratch, "fixture.cue");
  writeFileSync(
    cue,
    `package schema
manifest: #AppManifest & {
 app_id: "${appId}", customer_id: "fixture-template", version: "worker-v1"
 models: [{id:"item",kind:"entity",label:"Item",fields:[{id:"name",label:"Name",type:"text"}]}]
}
`,
  );
  releaseDirectory = buildGeneratedRelease(appId, path.join(scratch, "release"), [
    "packages/schema-compiler/cue/app-manifest.cue",
    path.relative(root, cue),
  ]).directory;
  const build = spawnSync("bun", ["build", "--compile", workerSource, "--outfile", workerPath], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
  });
  buildOutput = `${build.stdout ?? ""}${build.stderr ?? ""}`;
  if (build.status !== 0)
    throw new Error(`Protected generated-app worker compile failed: ${buildOutput}`);

  await admin.query("select 1");
  roleFixture = await capabilityRoleFixture(admin);
  await admin.query(`create role "${runtimeRole}" login`);
  runtimeRoleCreated = true;
  await admin.query(`create database "${database}" owner postgres`);
  databaseCreated = true;
}, 120_000);

afterAll(async () => {
  let capabilityRoles: string[] = [];
  if (databaseCreated) {
    const installed = new Pool({
      connectionString: new URL(`/${database}`, adminUrl).toString(),
      max: 1,
    });
    const capabilities = await installed
      .query<{ name: string }>(
        "select kernel_installer_capability_role(capability) as name from unnest(array['query','runtime','schema_admin','execution_owner']) capability",
      )
      .catch(() => ({ rows: [] as { name: string }[] }));
    await installed.end();
    capabilityRoles = capabilities.rows.map(({ name }) => name);
    await admin.query(`drop database if exists "${database}"`);
  }
  if (runtimeRoleCreated) await admin.query(`drop role if exists "${runtimeRole}"`);
  await roleFixture?.cleanup(capabilityRoles);
  await admin.end();
  rmSync(scratch, { recursive: true, force: true });
}, 120_000);

test("runs the pinned generated-app worker through two-tenant spool authorization and checkpoint relay", async () => {
  const selectedRelease = new URL(baseUrl);
  selectedRelease.pathname = `/${database}`;
  const databaseUrl = selectedRelease.toString();
  const manifestBytes = readFileSync(path.join(releaseDirectory, "release-manifest.json"));
  const artifactBytes = readFileSync(path.join(releaseDirectory, "app-artifact.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
    schema_version: string;
    hashes: { schema: string; bundle: string };
  };
  let firstRevisionIds: string[] | undefined;
  const addedTenant = `${tenants[0]}-added`;
  let expandedRevisionIds: string[] | undefined;
  const attempts = [
    { fenceGeneration: 1, targets: tenants },
    { fenceGeneration: 2, targets: tenants },
    { fenceGeneration: 3, targets: tenants, rejectElevatedRuntime: true },
    { fenceGeneration: 4, targets: [...tenants, addedTenant] },
    { fenceGeneration: 5, targets: [...tenants, addedTenant] },
  ];
  for (const [attempt, options] of attempts.entries()) {
    const { fenceGeneration, targets: attemptTargets } = options;
    const rejectElevatedRuntime = options.rejectElevatedRuntime ?? false;
    const { exitCode, lifecycle, seenEffects, stderr, workerErrors } = await runWorker({
      database,
      runtimeRole,
      release: releaseDirectory,
      fenceGeneration,
      targets: attemptTargets,
      rejectElevatedRuntime,
    });
    if (rejectElevatedRuntime) {
      expect(workerErrors).toEqual(["worker_failed:startup_rejected"]);
      expect(exitCode).toBe(1);
      expect(lifecycle).toEqual(["worker_failed"]);
      expect(seenEffects).toEqual([]);
      continue;
    }
    expect(workerErrors, `attempt ${attempt}: ${stderr.join("")}`).toEqual([]);
    expect(exitCode, stderr.join("")).toBe(0);
    expect(lifecycle).toEqual(["worker_started", "worker_succeeded"]);
    expect(seenEffects.map(({ effectId, tenantId }) => [effectId, tenantId])).toEqual([
      ["generated_app.install_bundle", null],
      ...attemptTargets.map((tenantId) => ["generated_app.prepare_schema_revision", tenantId]),
      ...attemptTargets.map((tenantId) => ["generated_app.validate_readiness", tenantId]),
      ["generated_app.activate_app_base", null],
      ["generated_app.grant_runtime_capability", null],
      ...attemptTargets.map((tenantId) => ["generated_app.bind_runtime_scope", tenantId]),
    ]);
    expect(seenEffects.every((effect) => effect.receipt === "applied")).toBe(true);

    const installed = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const revisions = await installed.query<{ customer_id: string; schema_revision_id: string }>(
        "select customer_id, schema_revision_id::text from schema_installation_revision where app_id=$1 and release_id=$2 and activation_kind='app_base' and customer_id=any($3::text[]) order by customer_id",
        [appId, manifest.schema_version, attemptTargets],
      );
      expect(revisions.rows.map((row) => row.customer_id)).toEqual([...attemptTargets].sort());
      const revisionIds = revisions.rows.map((row) => row.schema_revision_id);
      if (attempt === 0) firstRevisionIds = revisionIds;
      else if (attempt === 1) expect(revisionIds).toEqual(firstRevisionIds);
      else if (attempt === 3) expandedRevisionIds = revisionIds;
      else if (attempt === 4) expect(revisionIds).toEqual(expandedRevisionIds);
    } finally {
      await installed.end();
    }
    if (attempt === 0)
      await createUnrequestedTenantOverlay({
        databaseUrl,
        appId,
        customerId: `${tenants[0]}-overlay`,
        schemaVersion: manifest.schema_version,
        artifactHash: manifest.hashes.schema.replace(/^sha256:/u, ""),
        schema: JSON.parse(artifactBytes.toString("utf8")).schema as Record<string, unknown>,
      });
  }

  const installed = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const revisions = await installed.query<{
      customer_id: string;
      schema_revision_id: string;
      effective_artifact_hash: string;
      expected_active_effective_hash: string | null;
    }>(
      "select customer_id, schema_revision_id::text, effective_artifact_hash, expected_active_effective_hash from schema_installation_revision where app_id=$1 and release_id=$2 and activation_kind='app_base' and customer_id=any($3::text[]) and activated_at is not null order by customer_id",
      [appId, manifest.schema_version, [...tenants, addedTenant]],
    );
    expect(revisions.rows.map((row) => row.customer_id)).toEqual([...tenants, addedTenant].sort());
    const originalRevisions = new Map(
      tenants.map((tenantId, index) => [tenantId, firstRevisionIds?.[index]]),
    );
    expect(
      revisions.rows
        .filter((row) => tenants.includes(row.customer_id))
        .every((row) => row.schema_revision_id === originalRevisions.get(row.customer_id)),
    ).toBe(true);
    expect(
      revisions.rows.every(
        (row) => row.effective_artifact_hash === manifest.hashes.schema.replace(/^sha256:/u, ""),
      ),
    ).toBe(true);
    const scopes = await installed.query<{ customer_id: string }>(
      "select customer_id from kernel_principal_scope where principal_name=$1 and app_id=$2 and capability='runtime' and active order by customer_id",
      [runtimeRole, appId],
    );
    expect(scopes.rows.map((row) => row.customer_id)).toEqual([...tenants, addedTenant].sort());
    const unrelated = await installed.query<{ active: boolean; activation_kind: string }>(
      "select sr.activated_at is not null as active, sir.activation_kind from schema_installation_revision sir join schema_revision sr on sr.id=sir.schema_revision_id where sir.app_id=$1 and sir.release_id=$2 and sir.customer_id=$3",
      [appId, manifest.schema_version, `${tenants[0]}-overlay`],
    );
    expect(unrelated.rows).toEqual([{ active: true, activation_kind: "tenant_overlay" }]);

    const addedRevision = revisions.rows.find((row) => row.customer_id === addedTenant)!;
    const staleContinuation = await installed.query<{
      result: {
        ok: boolean;
        error?: { code: string; details?: Array<{ code: string }> };
      };
    }>("select kernel_continue_app_base_schema_revision($1::jsonb) as result", [
      JSON.stringify({
        app_id: appId,
        release_id: manifest.schema_version,
        base_artifact_hash: "0".repeat(64),
        targets: [
          {
            customer_id: addedTenant,
            schema_revision_id: Number(addedRevision.schema_revision_id),
            effective_artifact_hash: addedRevision.effective_artifact_hash,
            expected_active_effective_hash: addedRevision.expected_active_effective_hash,
          },
        ],
      }),
    ]);
    expect(staleContinuation.rows[0]?.result).toMatchObject({
      ok: false,
      error: {
        code: "schema_activation_conflict",
        details: [{ code: "different_base_requires_group_activation" }],
      },
    });
  } finally {
    await installed.end();
  }
}, 120_000);

test("installs an optional text field online and retries interrupted activation without changing access", async () => {
  const onlineAppId = `protected-online-${token.slice(0, 12)}`;
  const onlineDatabase = `protected_online_${token}`;
  const onlineRuntimeRole = `protected_online_runtime_${token}`;
  const runtimePassword = randomUUID();
  const fixtureApp = path.join(root, "apps", onlineAppId);
  const v1 = "worker-online-v1";
  const v2 = "worker-online-v2";
  const field = "review_note";
  const constraint = "item_version_review_note_record_event_null_check";
  const asOf = "2026-11-13";
  const actorId = "online-actor";
  const role = "fixture_role";
  const onlineUrl = new URL(`/${onlineDatabase}`, baseUrl);
  onlineUrl.search = baseUrl.search;
  const runtimeUrl = new URL(onlineUrl);
  runtimeUrl.username = onlineRuntimeRole;
  runtimeUrl.password = runtimePassword;
  const resources = {
    database: onlineDatabase,
    runtimeRole: onlineRuntimeRole,
    appId: onlineAppId,
    targets: tenants,
  };

  function compile(version: string, previous?: string) {
    const cue = path.join(scratch, `${version}.cue`);
    writeFileSync(
      cue,
      `package schema
manifest: #AppManifest & {
 app_id: "${onlineAppId}", customer_id: "fixture-template", version: "${version}"
 models: [{id:"item",kind:"entity",label:"Item",fields:[
   {id:"name",label:"Name",type:"text",required:true},
   ${previous ? '{id:"review_note",label:"Review note",type:"text"},' : ""}
 ]}]
}
`,
    );
    return buildGeneratedRelease(
      onlineAppId,
      path.join(fixtureApp, "schema", "release-output"),
      ["packages/schema-compiler/cue/app-manifest.cue", path.relative(root, cue)],
      root,
      process.env,
      previous === undefined ? [] : [path.join(previous, "app-artifact.json")],
    ).directory;
  }

  mkdirSync(fixtureApp);
  let installed: Pool | undefined;
  let databaseCreated = false;
  let roleCreated = false;
  try {
    const firstRelease = compile(v1);
    const checkedV1 = path.join(fixtureApp, "schema", "release", v1);
    mkdirSync(checkedV1, { recursive: true });
    for (const name of releaseFiles)
      copyFileSync(path.join(firstRelease, name), path.join(checkedV1, name));
    const nextRelease = compile(v2, checkedV1);
    const plan = JSON.parse(readFileSync(path.join(nextRelease, "transition-plan.json"), "utf8"));
    expect(plan.online_optional_text_addition).toMatchObject({
      kind: "optional-text-addition-v1",
      table: "item_version",
      column: field,
      constraint,
    });
    await admin.query(`create role "${onlineRuntimeRole}" login password '${runtimePassword}'`);
    roleCreated = true;
    await admin.query(`create database "${onlineDatabase}" owner postgres`);
    databaseCreated = true;
    installed = new Pool({ connectionString: onlineUrl.toString(), max: 3 });
    const initial = await runWorker({ ...resources, release: firstRelease, fenceGeneration: 1 });
    expect(initial.exitCode, initial.workerErrors.join(", ")).toBe(0);

    const tenantBindings = tenants.map((customerId, index) => ({
      customerId,
      actorId: index === 0 ? actorId : "other-tenant-actor",
      recordId: randomUUID(),
      name: `Existing note ${index}`,
    }));
    for (const binding of tenantBindings) {
      const result = await installed.query(
        "select kernel_bind_actor_membership($1::jsonb) as result",
        [
          JSON.stringify({
            principal_name: onlineRuntimeRole,
            app_id: onlineAppId,
            customer_id: binding.customerId,
            actor_id: binding.actorId,
            actor_kind: "human",
            role,
            fence_generation: 1,
          }),
        ],
      );
      expect(result.rows[0]?.result.ok).toBe(true);
      const { operations, close } = open(firstRelease, binding.customerId, binding.actorId, true);
      try {
        await operations.apply({
          effectiveStart: asOf,
          idempotencyKey: `seed-${binding.recordId}`,
          writes: [
            operations.item!.writes.create({ name: binding.name }, { id: binding.recordId }),
          ],
        });
      } finally {
        await close();
      }
    }
    const appDatabase = installed;
    const active = async () =>
      (
        await appDatabase.query<{ customer_id: string; version: string; revision_id: string }>(
          "select customer_id, version, id::text as revision_id from schema_revision where app_id=$1 and activated_at is not null order by customer_id",
          [onlineAppId],
        )
      ).rows;
    const preceding = await active();
    expect(preceding.map(({ customer_id, version }) => [customer_id, version])).toEqual(
      tenants.map((customerId) => [customerId, v1]),
    );
    const accessState = async () =>
      (
        await appDatabase.query(
          "select customer_id, actor_id, role, active, fence_generation::text from kernel_actor_membership where principal_name=$1 and app_id=$2 order by customer_id, actor_id, role",
          [onlineRuntimeRole, onlineAppId],
        )
      ).rows;
    const accessBefore = await accessState();
    const first = tenantBindings[0]!;
    const oldReader = open(firstRelease, first.customerId, first.actorId);
    const blocker = await appDatabase.connect();
    let holding = false;
    try {
      await blocker.query("begin");
      holding = true;
      await blocker.query("lock table only item_version in access share mode");
      const partial = await runWorker({
        ...resources,
        release: nextRelease,
        fenceGeneration: 2,
        retainAccess: true,
        denyEffect: "generated_app.activate_app_base",
        async duringInstall(fenceChecks) {
          if (fenceChecks !== 4) return;
          // The catalog phase and two failed NOWAIT DDL attempts have run.
          // A fresh runtime query still completes with the exclusive lock unavailable.
          expect(await oldReader.operations.item!.list({ asOf })).toMatchObject([
            { id: first.recordId, name: first.name },
          ]);
          expect(await active()).toEqual(preceding);
          await blocker.query("commit");
          holding = false;
        },
      });
      expect(holding).toBe(false);
      expect(partial.fenceChecks).toBeGreaterThanOrEqual(4);
      expect(partial.exitCode).toBe(1);
      expect(partial.lifecycle).toEqual(["worker_started", "worker_failed"]);
      expect(partial.seenEffects[0]).toMatchObject({
        effectId: "generated_app.install_bundle",
        receipt: "applied",
      });
      expect(partial.seenEffects.at(-1)).toEqual({
        effectId: "generated_app.activate_app_base",
        tenantId: null,
      });
    } finally {
      if (holding) await blocker.query("rollback");
      blocker.release();
      await oldReader.close();
    }

    expect(await active()).toEqual(preceding);
    expect(
      (
        await appDatabase.query(
          `select attribute.atttypid::regtype::text as type, attribute.attnotnull as required,
                  rule.convalidated as validated
           from pg_attribute attribute join pg_constraint rule on rule.conrelid=attribute.attrelid
           where attribute.attrelid='item_version'::regclass and attribute.attname=$1
             and rule.conname=$2 and rule.contype='c'`,
          [field, constraint],
        )
      ).rows,
    ).toEqual([{ type: "text", required: false, validated: true }]);
    const pending = open(nextRelease, first.customerId, first.actorId);
    try {
      expect(await pending.operations.item!.list({ asOf })).toMatchObject([
        { id: first.recordId, name: first.name, reviewNote: null },
      ]);
      expect(
        await pending.operations.item!.fieldActivation({
          field: "reviewNote",
          operation: "create",
        }),
      ).toBe("pending");
    } finally {
      await pending.close();
    }

    const completed = await runWorker({
      ...resources,
      release: nextRelease,
      fenceGeneration: 3,
      retainAccess: true,
    });
    expect(completed.exitCode, completed.workerErrors.join(", ")).toBe(0);
    expect(completed.seenEffects.map(({ effectId }) => effectId)).not.toContain(
      "generated_app.bind_runtime_scope",
    );
    const activated = await active();
    expect(activated.map(({ customer_id, version }) => [customer_id, version])).toEqual(
      tenants.map((customerId) => [customerId, v2]),
    );
    for (const [index, row] of activated.entries())
      expect(row.revision_id).not.toBe(preceding[index]?.revision_id);
    const replay = await runWorker({
      ...resources,
      release: nextRelease,
      fenceGeneration: 4,
      retainAccess: true,
    });
    expect(replay.exitCode, replay.workerErrors.join(", ")).toBe(0);
    expect(await active()).toEqual(activated);
    expect(await accessState()).toEqual(accessBefore);

    for (const binding of tenantBindings) {
      const { operations, close } = open(nextRelease, binding.customerId, binding.actorId);
      try {
        expect(await operations.item!.list({ asOf })).toMatchObject([
          { id: binding.recordId, name: binding.name, reviewNote: null },
        ]);
        expect(
          await operations.item!.fieldActivation({ field: "reviewNote", operation: "update" }),
        ).toBe("active");
      } finally {
        await close();
      }
    }
    for (const denied of [
      open(nextRelease, tenants[1]!, first.actorId),
      open(nextRelease, first.customerId, first.actorId, false, "unassigned_role"),
    ]) {
      try {
        await expect(denied.operations.item!.list({ asOf })).rejects.toMatchObject({
          envelope: { code: "authorization_denied" },
        });
        await expect(
          denied.operations.item!.fieldActivation({ field: "reviewNote", operation: "create" }),
        ).rejects.toMatchObject({ envelope: { code: "authorization_denied" } });
      } finally {
        await denied.close();
      }
    }
    const writer = open(nextRelease, first.customerId, first.actorId, true);
    try {
      await writer.operations.item!.update(
        first.recordId,
        { reviewNote: "New optional text" },
        { effectiveStart: asOf, idempotencyKey: "online-schema-v2-update" },
      );
    } finally {
      await writer.close();
    }
    const reader = open(nextRelease, first.customerId, first.actorId);
    try {
      expect(await reader.operations.item!.list({ asOf })).toMatchObject([
        { id: first.recordId, name: first.name, reviewNote: "New optional text" },
      ]);
    } finally {
      await reader.close();
    }
  } finally {
    try {
      const capabilityRoles = [];
      try {
        if (installed) {
          const capabilityFunction = await installed.query<{ available: boolean }>(
            "select to_regprocedure('kernel_installer_capability_role(text)') is not null as available",
          );
          if (capabilityFunction.rows[0]?.available) {
            const roles = await installed.query<{ name: string }>(
              "select kernel_installer_capability_role(capability) as name from unnest(array['query','runtime','schema_admin','execution_owner']) capability",
            );
            capabilityRoles.push(...roles.rows.map(({ name }) => name));
          }
        }
      } finally {
        try {
          await installed?.end();
        } finally {
          if (databaseCreated) await admin.query(`drop database "${onlineDatabase}"`);
          // Dropping this fixture login also removes its role memberships.
          if (roleCreated) await admin.query(`drop role "${onlineRuntimeRole}"`);
          await roleFixture.cleanup(capabilityRoles);
        }
      }
    } finally {
      rmSync(fixtureApp, { recursive: true, force: true });
    }
  }

  function open(
    release: string,
    customerId: string,
    actorId: string,
    write = false,
    actorRole = role,
  ) {
    const runtime = createGeneratedAppRuntime({
      appId: onlineAppId,
      customerId,
      releaseDirectory: release,
      databaseUrl: runtimeUrl.toString(),
    });
    const definition = JSON.parse(
      readFileSync(path.join(release, "operation-manifest.json"), "utf8"),
    ) as DataDefinition;
    const requestHash = createHash("sha256").update("worker fixture").digest("base64url");
    return {
      close: () => runtime.close(),
      operations: createDataClient(
        definition,
        runtime.dataContext({
          actorId,
          actorBinding: { role: actorRole, fenceGeneration: 1 },
          sourceKind: "fixture",
          authorize: async () => {},
          ...(write
            ? {
                protectedHttpRequest: {
                  audience: onlineAppId,
                  bodySha256: requestHash,
                  expiresAt: Math.floor(Date.now() / 1000) + 120,
                  issuer: "https://gateway.fixture",
                  jti: randomUUID(),
                  method: "POST",
                  payloadSha256: requestHash,
                  target: "/action",
                },
              }
            : {}),
        }),
      ),
    };
  }
}, 120_000);

async function runWorker(options: {
  appId?: string;
  database: string;
  runtimeRole: string;
  release: string;
  fenceGeneration: number;
  targets: string[];
  rejectElevatedRuntime?: boolean;
  retainAccess?: boolean;
  denyEffect?: string;
  duringInstall?: (fenceChecks: number) => Promise<void>;
}) {
  const { fenceGeneration, targets: attemptTargets } = options;
  const rejectElevatedRuntime = options.rejectElevatedRuntime ?? false;
  const runId = randomUUID().replaceAll("-", "");
  const spool = path.join(scratch, `spool-${runId}`);
  const selectedRelease = new URL(baseUrl);
  selectedRelease.pathname = `/${options.database}`;
  const databaseUrl = selectedRelease.toString();
  const manifestBytes = readFileSync(path.join(options.release, "release-manifest.json"));
  const artifactBytes = readFileSync(path.join(options.release, "app-artifact.json"));
  const bundleBytes = readFileSync(path.join(options.release, "sql-bundle.sql"));
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as { schema_version: string };
  const installerSha256 = digest(readFileSync(workerPath));
  const privateReleaseDirectory = path.join(scratch, `private-release-${runId}`);
  mkdirSync(privateReleaseDirectory);
  for (const name of releaseFiles)
    copyFileSync(path.join(options.release, name), path.join(privateReleaseDirectory, name));
  const { appId: selectedApp = appId, database, runtimeRole } = options;
  const approvedPlan = {
    version: 1,
    action: "prepare",
    selection: { appId: selectedApp },
    appDatabase: {
      resourceId: "owned-disposable-worker-db",
      database,
      migratorRole: "postgres",
      runtimeRole,
    },
    // This fixture exercises only the app installer; no Auth connection or grant is opened.
    authDatabase: {
      resourceId: "owned-disposable-auth-db",
      database: "fixture_auth",
      migratorRole: "fixture_auth_owner",
      runtimeRole: "fixture_auth_runtime",
    },
    neon: { endpoint: "127.0.0.1" },
    release: { id: manifest.schema_version, sha256: digest(manifestBytes) },
    installer: { reference: "generated-app-protected-installer-v1", sha256: installerSha256 },
    ...(options.retainAccess ? { appInstallation: { customerIds: attemptTargets } } : {}),
    access: (options.retainAccess ? [] : attemptTargets).map((organizationId) => ({
      organizationId,
      actorId: "fixture-actor",
      actorKind: "human",
      roles: ["fixture_role"],
    })),
  };
  const context = {
    version: 1,
    operation: {
      operation_id: randomUUID(),
      approval_digest: digest(Buffer.from(JSON.stringify(approvedPlan))),
      fence_generation: fenceGeneration,
    },
    app_id: selectedApp,
    resource: {
      resource_id: "owned-disposable-worker-db",
      environment: "local",
      hostname: "127.0.0.1",
      port: Number(selectedRelease.port || 5432),
      database,
      schema: "public",
      migrator_role: "postgres",
      runtime_role: runtimeRole,
    },
    release: { id: manifest.schema_version, sha256: digest(manifestBytes) },
    installer: { id: "generated-app-protected-installer-v1", sha256: installerSha256 },
    tenant_targets: attemptTargets,
  };
  const contextDigest = digest(Buffer.from(JSON.stringify(context)));
  mkdirSync(path.join(spool, "startup"), { recursive: true });
  mkdirSync(path.join(spool, "requests"), { recursive: true });
  mkdirSync(path.join(spool, "responses"), { recursive: true });
  mkdirSync(path.join(spool, "lifecycle"), { recursive: true });
  writeFileSync(path.join(spool, "startup", "context.json"), JSON.stringify(context));
  writeFileSync(
    path.join(spool, "startup", "direct-database-url.json"),
    JSON.stringify(databaseUrl),
  );
  writeFileSync(
    path.join(spool, "startup", "approved-access-plan.json"),
    JSON.stringify(approvedPlan),
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(spool, "startup", "generated-app-release.json"),
    JSON.stringify({
      version: 1,
      app_id: selectedApp,
      release_id: manifest.schema_version,
      release_manifest_sha256: digest(manifestBytes),
      app_artifact_sha256: digest(artifactBytes),
      sql_bundle_sha256: digest(bundleBytes),
    }),
  );
  writeFileSync(
    path.join(spool, "startup", "ready.json"),
    JSON.stringify({ version: 1, run_id: runId, frame_id: 0 }),
  );

  if (rejectElevatedRuntime)
    await admin.query(`alter role "${runtimeRole.replaceAll('"', '""')}" bypassrls`);
  const child = spawn(
    workerPath,
    [
      "protected-generated-app-install",
      "--file-spool",
      spool,
      runId,
      "60000",
      "--release-directory",
      privateReleaseDirectory,
    ],
    {
      cwd: spool,
      env: { NODE_ENV: "test" },
      stdio: "pipe",
    },
  );
  child.stdin.end();
  const stdout = createInterface({ input: child.stdout });
  const stderr: string[] = [];
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => stderr.push(chunk));
  const seenEffects: Array<{ effectId: string; tenantId: string | null; receipt?: string }> = [];
  const lifecycle: string[] = [];
  const workerErrors: string[] = [];
  let relay = Promise.resolve();
  let fenceChecks = 0;
  let pendingEffect: string | null = null;
  stdout.on("line", (line) => {
    relay = relay.then(async () => {
      const notice = JSON.parse(line) as {
        kind: string;
        version: number;
        run_id: string;
        frame_id: number;
      };
      expect(Object.keys(notice).toSorted()).toEqual(["frame_id", "kind", "run_id", "version"]);
      expect(notice.version).toBe(1);
      expect(notice.run_id).toBe(runId);
      if (notice.kind === "protected_installer_lifecycle_ready") {
        const fact = JSON.parse(
          readFileSync(path.join(spool, "lifecycle", `${notice.frame_id}.json`), "utf8"),
        ) as {
          kind: string;
          failure_code?: string;
        };
        lifecycle.push(fact.kind);
        if (fact.kind === "worker_failed") workerErrors.push(`worker_failed:${fact.failure_code}`);
        return;
      }
      expect(notice.kind).toBe("protected_installer_frame_ready");
      const requestPath = path.join(spool, "requests", `${notice.frame_id}.json`);
      const request = JSON.parse(readFileSync(requestPath, "utf8")) as {
        kind: string;
        sequence: number;
        effect_id: string;
        tenant_id: string | null;
        operation_id: string;
        context_digest: string;
        fence_generation: number;
        receipt?: { state: string; readback_sha256?: string };
      };
      expect(request.context_digest).toBe(contextDigest);
      expect(request.fence_generation).toBe(fenceGeneration);
      expect(request.operation_id).toBe(context.operation.operation_id);
      if (request.kind === "check_fence") {
        if (pendingEffect === "generated_app.install_bundle")
          await options.duringInstall?.(++fenceChecks);
        await writeReply(spool, notice.frame_id, runId, {
          kind: "fence_current",
          version: 1,
          operation_id: request.operation_id,
          context_digest: contextDigest,
          fence_generation: fenceGeneration,
          current: true,
        });
      } else if (request.kind === "authorize_effect") {
        pendingEffect = request.effect_id;
        seenEffects.push({ effectId: request.effect_id, tenantId: request.tenant_id });
        const response = {
          kind: "effect_authorized",
          version: 1,
          operation_id: request.operation_id,
          context_digest: contextDigest,
          fence_generation: request.fence_generation,
          sequence: request.sequence,
          effect_id: request.effect_id,
          allowed: request.effect_id !== options.denyEffect,
        };
        await writeReply(spool, notice.frame_id, runId, response);
      } else {
        expect(request.kind).toBe("checkpoint_effect");
        pendingEffect = null;
        if (request.receipt?.state !== "applied")
          workerErrors.push(
            `${request.effect_id}:checkpoint_${request.receipt?.state ?? "missing"}`,
          );
        if (request.receipt?.state === "applied")
          expect(request.receipt.readback_sha256).toMatch(/^[a-f0-9]{64}$/u);
        seenEffects[seenEffects.length - 1]!.receipt = request.receipt!.state;
        const response = {
          kind: "checkpoint_recorded",
          version: 1,
          operation_id: request.operation_id,
          context_digest: request.context_digest,
          fence_generation: request.fence_generation,
          sequence: request.sequence,
          effect_id: request.effect_id,
          recorded: true,
        };
        await writeReply(spool, notice.frame_id, runId, response);
      }
    });
    void relay.catch(() => child.kill("SIGKILL"));
  });
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Protected worker process timed out"));
      }, 120_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve(code ?? 1);
      });
    });
    await relay;
    return { exitCode, lifecycle, seenEffects, stderr, workerErrors, fenceChecks };
  } finally {
    stdout.close();
    if (rejectElevatedRuntime)
      await admin.query(`alter role "${runtimeRole.replaceAll('"', '""')}" nobypassrls`);
  }
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function createUnrequestedTenantOverlay(input: {
  databaseUrl: string;
  appId: string;
  customerId: string;
  schemaVersion: string;
  artifactHash: string;
  schema: Record<string, unknown>;
}): Promise<void> {
  const pool = new Pool({ connectionString: input.databaseUrl, max: 1 });
  const schema = { ...input.schema, customer_id: input.customerId };
  const schemaJson = JSON.stringify(schema);
  const planHash = digest(Buffer.from("[]"));
  try {
    const hash = await pool.query<{ hash: string }>(
      "select kernel_admin_sha256(kernel_canonical_json($1::jsonb)) as hash",
      [schemaJson],
    );
    const prepared = await pool.query<{
      result: { ok: boolean; data?: { schema_revision_id: number } };
    }>("select kernel_prepare_schema_revision($1::jsonb) as result", [
      JSON.stringify({
        app_id: input.appId,
        customer_id: input.customerId,
        version: input.schemaVersion,
        release_id: input.schemaVersion,
        activation_kind: "tenant_overlay",
        schema_hash: hash.rows[0]?.hash,
        base_artifact_hash: input.artifactHash,
        effective_artifact_hash: input.artifactHash,
        materialization_plan_hash: planHash,
        expected_active_effective_hash: null,
        materialization_source: "operator",
        base_schema: schema,
        customer_overlay: {},
        schema,
        seed_change_sets: [],
        phase_plan: [],
      }),
    ]);
    expect(prepared.rows[0]?.result.ok).toBe(true);
    const revisionId = prepared.rows[0]?.result.data?.schema_revision_id;
    expect(revisionId).toBeGreaterThan(0);
    const ready = await pool.query<{ result: { ok: boolean } }>(
      "select kernel_validate_schema_revision_readiness($1::jsonb) as result",
      [
        JSON.stringify({
          app_id: input.appId,
          customer_id: input.customerId,
          schema_revision_id: revisionId,
          effective_artifact_hash: input.artifactHash,
          materialization_plan_hash: planHash,
          phase_results: [],
        }),
      ],
    );
    expect(ready.rows[0]?.result.ok).toBe(true);
    const activated = await pool.query<{ result: { ok: boolean } }>(
      "select kernel_activate_tenant_schema_revision($1::jsonb) as result",
      [
        JSON.stringify({
          app_id: input.appId,
          customer_id: input.customerId,
          schema_revision_id: revisionId,
          effective_artifact_hash: input.artifactHash,
          expected_active_effective_hash: null,
        }),
      ],
    );
    expect(activated.rows[0]?.result.ok).toBe(true);
  } finally {
    await pool.end();
  }
}

async function writeReply(
  spoolDirectory: string,
  frameId: number,
  runId: string,
  value: unknown,
): Promise<void> {
  writeFileSync(path.join(spoolDirectory, "responses", `${frameId}.json`), JSON.stringify(value), {
    flag: "wx",
  });
  writeFileSync(
    path.join(spoolDirectory, "responses", `${frameId}.ready`),
    JSON.stringify({ version: 1, run_id: runId, frame_id: frameId }),
    { flag: "wx" },
  );
}
