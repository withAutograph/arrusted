import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { KernelFailure } from "../../../../packages/kernel-client/postgres";
import { buildGeneratedRelease } from "./schema-release";
import { exerciseManagedSignupGrant } from "./protected-managed-signup-fixture";
import {
  createDataClient,
  createWorkSessionClient,
  type DataDefinition,
} from "../../../../packages/generated-app-runtime/data";
import {
  createGeneratedAppRuntime,
  verifyCheckedRelease,
} from "../../../../packages/generated-app-runtime/server";
import { readPostgresAppActorAccess } from "../../../../packages/generated-app-runtime/actor-binding";
import {
  createProtectedGeneratedInstaller,
  type ProtectedDatabaseResource,
  type ProtectedGeneratedPlan,
} from "../../../../packages/generated-app-runtime/protected-installer";

/** Part of the existing disposable installer proof; never reads configured resources. */
export async function exerciseRolelessAccess(input: {
  root: string;
  directory: string;
  admin: Pool;
  auth: Pool;
  authResource: ProtectedDatabaseResource;
  authOperatorRole?: string;
  password: string;
  connection: (role: string, database: string) => string;
  observeSignupWire?: Parameters<typeof exerciseManagedSignupGrant>[0]["observeWire"];
}): Promise<number> {
  const appId = "roleless-fixture";
  const source = path.join(input.directory, "roleless.cue");
  await writeFile(
    source,
    `package schema
manifest: #AppManifest & {
 app_id: "${appId}", customer_id: "fixture-template", version: "roleless-v1"
 models: [{id:"entry",label:"Entry",kind:"entity",fields:[{id:"name",label:"Name",type:"text",required:true}]}]
}`,
  );
  const releaseDirectory = buildGeneratedRelease(
    appId,
    path.join(input.directory, "roleless-release"),
    ["packages/schema-compiler/cue/app-manifest.cue", path.relative(input.root, source)],
  ).directory;
  const manifest = verifyCheckedRelease(releaseDirectory);
  const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  const trust = {
    id: "reviewed-fixture-installer",
    sqlBundleHash: hash(await readFile(path.join(releaseDirectory, "sql-bundle.sql"))),
  };
  const app = {
    ...input.authResource,
    resourceId: "roleless-app-fixture",
    database: "roleless_app",
    runtimeRole: "roleless_runtime",
    migratorRole: "roleless_migrator",
  };
  await input.admin.query(
    `create role ${app.migratorRole} login createrole password '${input.password}'; create role ${app.runtimeRole} login password '${input.password}'`,
  );
  await input.admin.query(`create database ${app.database} owner ${app.migratorRole}`);
  const plan: ProtectedGeneratedPlan = {
    version: 1,
    appId,
    workspaceId: "workspace_fixture",
    app,
    auth: input.authResource,
    ...(input.authOperatorRole === undefined ? {} : { authOperatorRole: input.authOperatorRole }),
    installer: trust,
    release: {
      id: manifest.schema_version,
      artifactHash: manifest.hashes.schema!.replace(/^sha256:/u, ""),
      manifestHash: hash(await readFile(path.join(releaseDirectory, "release-manifest.json"))),
    },
    organizations: [
      {
        organizationId: "org_fixture",
        actors: [{ actorId: "actor_fixture", actorKind: "human", roles: [] }],
      },
    ],
  };
  let fence = async () => {};
  const installer = (generation: number, selected = plan) =>
    createProtectedGeneratedInstaller({
      plan: selected,
      trust,
      releaseDirectory,
      fenceGeneration: generation,
      assertCurrent: () => fence(),
      connections: {
        appMigrator: input.connection(app.migratorRole, app.database),
        appRuntime: input.connection(app.runtimeRole, app.database),
        ...(input.authOperatorRole === undefined
          ? {
              authMigrator: input.connection(
                input.authResource.migratorRole,
                input.authResource.database,
              ),
            }
          : {
              authOperator: input.connection(input.authOperatorRole, input.authResource.database),
            }),
        authRuntime: input.connection(input.authResource.runtimeRole, input.authResource.database),
      },
    });
  assert.throws(() => installer(1, { ...plan, workspaceId: undefined }), /owning workspace/u);
  await installer(1).install();
  let signupChecks = 0;
  if (input.authOperatorRole) {
    const audit = new Pool({ connectionString: input.connection(app.migratorRole, app.database) });
    try {
      signupChecks = await exerciseManagedSignupGrant({
        root: input.root,
        auth: input.auth,
        app: audit,
        plan,
        trust,
        releaseDirectory,
        authOperatorRole: input.authOperatorRole,
        appRoles: [],
        observeWire: input.observeSignupWire,
        connections: {
          appMigrator: input.connection(app.migratorRole, app.database),
          appRuntime: input.connection(app.runtimeRole, app.database),
          authOperator: input.connection(input.authOperatorRole, input.authResource.database),
          authRuntime: input.connection(
            input.authResource.runtimeRole,
            input.authResource.database,
          ),
        },
      });
    } finally {
      await audit.end();
    }
  }
  assert.equal(await installer(1).inspectAccess(true), "absent");
  await installer(1).grant();
  assert.equal(await installer(1).inspectAccess(true), "applied");
  await assert.rejects(
    installer(2, { ...plan, workspaceId: "other-workspace" }).grant(),
    /identity_mismatch/u,
  );
  assert.equal(
    await installer(1).reconcileAccess(true),
    "applied",
    "foreign workspace must not advance the kernel fence",
  );
  await input.auth.query(`grant update on app_actor_access to ${input.authResource.runtimeRole}`);
  try {
    await assert.rejects(installer(2).grant(), /identity_mismatch/u);
  } finally {
    await input.auth.query(
      `revoke update on app_actor_access from ${input.authResource.runtimeRole}`,
    );
  }
  const runtimePool = new Pool({
    connectionString: input.connection(app.runtimeRole, app.database),
  });
  try {
    assert.deepEqual(
      await readPostgresAppActorAccess({
        pool: runtimePool,
        appId,
        organizationId: "org_fixture",
        actorId: "actor_fixture",
      }),
      {
        appId,
        organizationId: "org_fixture",
        actorId: "actor_fixture",
        active: true,
        fenceGeneration: 1,
      },
    );
  } finally {
    await runtimePool.end();
  }
  const definition = JSON.parse(
    await readFile(path.join(releaseDirectory, "operation-manifest.json"), "utf8"),
  ) as DataDefinition;
  const withData = async <T>(
    generation: number,
    run: (operations: ReturnType<typeof createDataClient>) => Promise<T>,
    actorId = "actor_fixture",
    customerId = "org_fixture",
  ) => {
    const runtime = createGeneratedAppRuntime({
      appId,
      customerId,
      databaseUrl: input.connection(app.runtimeRole, app.database),
      releaseDirectory,
    });
    try {
      return await run(
        createDataClient(
          definition,
          runtime.dataContext({
            actorId,
            sourceKind: "human",
            actorBinding: { role: null, fenceGeneration: generation },
            authorize: async () => {},
            protectedHttpRequest: {
              audience: appId,
              issuer: "https://fixture.invalid",
              jti: randomUUID(),
              method: "POST",
              target: "/roleless-fixture",
              expiresAt: Math.floor(Date.now() / 1000) + 60,
              bodySha256: createHash("sha256").update("fixture").digest("base64url"),
              payloadSha256: createHash("sha256").update("fixture").digest("base64url"),
            },
          }),
        ),
      );
    } finally {
      await runtime.close();
    }
  };
  await withData(1, async (operations) =>
    operations.apply({
      effectiveStart: "2026-11-06",
      idempotencyKey: "roleless-save",
      writes: [operations.entry!.writes.create({ name: "Retained record" })],
    }),
  );
  const read = (generation: number, actorId = "actor_fixture", customerId = "org_fixture") =>
    withData(
      generation,
      (operations) => operations.entry!.list({ asOf: "2026-11-06", select: ["id", "name"] }),
      actorId,
      customerId,
    );
  assert.equal((await read(1))[0]!.name, "Retained record");
  await assert.rejects(read(1, "unassigned"));
  await assert.rejects(read(1, "actor_fixture", "different-tenant"));
  await installer(2).revoke();
  assert.equal(await installer(2).inspectAccess(false), "applied");
  await assert.rejects(read(1));
  await assert.rejects(installer(1).grant());
  // An interruption after kernel allocation cannot claim completion or lose the same app DB.
  const audit = new Pool({ connectionString: input.connection(app.migratorRole, app.database) });
  let interrupted = false;
  fence = async () => {
    const current = await audit.query(
      "select 1 from kernel_actor_access where actor_id='actor_fixture' and active and fence_generation=3",
    );
    if (current.rowCount === 1 && !interrupted) {
      interrupted = true;
      throw new Error("interrupted access after kernel grant");
    }
  };
  try {
    await assert.rejects(installer(3).grant(), /interrupted/u);
  } finally {
    fence = async () => {};
    await audit.end();
  }
  await installer(3).grant();
  assert.equal(await installer(3).reconcileAccess(true), "applied");
  await assert.rejects(read(1));
  assert.equal((await read(3))[0]!.name, "Retained record");
  const rows = await input.auth.query('select role from "app_actor_assignment" where "appId"=$1', [
    appId,
  ]);
  assert.equal(rows.rowCount, 0, "no fake business role is created");
  await installer(4).revoke();
  assert.equal(await installer(4).reconcileRetirementAccess(), "applied");
  // Upgrade the same database between authorization modes. Removing access in
  // the new mode must not leave a fallback grant from the old release.
  let previousDirectory = releaseDirectory;
  const transition = async (version: string, roles: string[], generation: number) => {
    const transitionSource = path.join(input.directory, `${version}.cue`);
    await writeFile(
      transitionSource,
      `package schema
manifest: #AppManifest & {
 app_id: "${appId}", customer_id: "fixture-template", version: "${version}"
 models: [{id:"entry",label:"Entry",kind:"entity",fields:[{id:"name",label:"Name",type:"text",required:true}]}]
 ${
   roles.length
     ? `authorization: {
  roles: [{id:"member",label:"Member"}]
  grants: [{role:"member",model:"entry",operations:["read","create","update","history"],read_fields:["$id","$version","name"],write_fields:["name"],record:{kind:"all"}}]
 }`
     : ""
 }
}`,
    );
    const target = buildGeneratedRelease(
      appId,
      path.join(input.directory, version),
      [
        "packages/schema-compiler/cue/app-manifest.cue",
        path.relative(input.root, transitionSource),
      ],
      input.root,
      process.env,
      [path.join(previousDirectory, "app-artifact.json")],
    ).directory;
    previousDirectory = target;
    const nextManifest = verifyCheckedRelease(target);
    const nextTrust = {
      ...trust,
      sqlBundleHash: hash(await readFile(path.join(target, "sql-bundle.sql"))),
    };
    const nextPlan: ProtectedGeneratedPlan = {
      ...plan,
      installer: nextTrust,
      release: {
        id: nextManifest.schema_version,
        artifactHash: nextManifest.hashes.schema!.replace(/^sha256:/u, ""),
        manifestHash: hash(await readFile(path.join(target, "release-manifest.json"))),
      },
      organizations: [
        {
          organizationId: "org_fixture",
          actors: [{ actorId: "actor_fixture", actorKind: "human", roles }],
        },
      ],
    };
    const nextInstaller = (fenceGeneration: number) =>
      createProtectedGeneratedInstaller({
        plan: nextPlan,
        trust: nextTrust,
        releaseDirectory: target,
        fenceGeneration,
        assertCurrent: () => fence(),
        retainedInstallationCustomerIds: ["org_fixture"],
        connections: {
          appMigrator: input.connection(app.migratorRole, app.database),
          appRuntime: input.connection(app.runtimeRole, app.database),
          ...(input.authOperatorRole === undefined
            ? {
                authMigrator: input.connection(
                  input.authResource.migratorRole,
                  input.authResource.database,
                ),
              }
            : {
                authOperator: input.connection(input.authOperatorRole, input.authResource.database),
              }),
          authRuntime: input.connection(
            input.authResource.runtimeRole,
            input.authResource.database,
          ),
        },
      });
    await nextInstaller(generation).install();
    const nextDefinition = JSON.parse(
      await readFile(path.join(target, "operation-manifest.json"), "utf8"),
    ) as DataDefinition;
    const nextRead = async (fenceGeneration: number, role: string | null = roles[0] ?? null) => {
      const runtime = createGeneratedAppRuntime({
        appId,
        customerId: "org_fixture",
        databaseUrl: input.connection(app.runtimeRole, app.database),
        releaseDirectory: target,
      });
      try {
        return await createDataClient(
          nextDefinition,
          runtime.dataContext({
            actorId: "actor_fixture",
            sourceKind: "human",
            actorBinding: { role, fenceGeneration },
            authorize: async () => {},
          }),
        ).entry!.list({ asOf: "2026-11-06", select: ["id", "name"] });
      } finally {
        await runtime.close();
      }
    };
    const listWork = async (fenceGeneration: number, role: string | null = roles[0] ?? null) => {
      const runtime = createGeneratedAppRuntime({
        appId,
        customerId: "org_fixture",
        databaseUrl: input.connection(app.runtimeRole, app.database),
        releaseDirectory: target,
      });
      try {
        return await createWorkSessionClient(
          runtime.dataContext({
            actorId: "actor_fixture",
            sourceKind: "human",
            actorBinding: { role, fenceGeneration },
            authorize: async () => {},
          }),
          nextDefinition.schemaVersion,
        ).request({ operation: "list" });
      } finally {
        await runtime.close();
      }
    };
    return { installer: nextInstaller, read: nextRead, listWork };
  };
  const state = async () => {
    const appAudit = new Pool({
      connectionString: input.connection(app.migratorRole, app.database),
    });
    try {
      const database = await appAudit.query(
        `select 'roleless' as mode, active, fence_generation from kernel_actor_access
        where app_id=$1 and customer_id='org_fixture' and actor_id='actor_fixture'
        union all select 'named',active,fence_generation from kernel_actor_membership
        where app_id=$1 and customer_id='org_fixture' and actor_id='actor_fixture'`,
        [appId],
      );
      const browser = await input.auth.query(
        `select 'roleless' as mode, active,"fenceGeneration" as fence_generation from app_actor_access
        where "appId"=$1 and "organizationId"='org_fixture' and "actorId"='actor_fixture'
        union all select 'named',active,fence_generation from app_actor_assignment
        where "appId"=$1 and "organizationId"='org_fixture' and "actorId"='actor_fixture'`,
        [appId],
      );
      return { database: database.rows, browser: browser.rows };
    } finally {
      await appAudit.end();
    }
  };
  await installer(5).grant();
  await withData(5, (operations) =>
    operations.workSessions.request({
      operation: "create",
      session_id: randomUUID(),
      request_id: randomUUID(),
      expected_revision: 0,
      title: "Retained private work",
      as_of: "2026-11-06",
    }),
  );
  assert.equal(
    (await withData(5, (operations) => operations.workSessions.request({ operation: "list" })))[0]!
      .title,
    "Retained private work",
  );
  const named = await transition("mode-named-v2", ["member"], 6);
  // Activation closes database admission before the separate Auth/grant phase.
  // Preserve the old generation as a tombstone, so retries cannot reopen it.
  assert.deepEqual((await state()).database, [
    { mode: "roleless", active: false, fence_generation: "5" },
  ]);
  assert.deepEqual((await state()).browser, [
    { mode: "roleless", active: true, fence_generation: "5" },
  ]);
  await assert.rejects(
    named.read(5, null),
    (error) => error instanceof KernelFailure && error.envelope.code === "authorization_denied",
  );
  await assert.rejects(
    named.listWork(5, null),
    (error) => error instanceof KernelFailure && error.envelope.code === "authorization_denied",
  );
  const legacyAudit = new Pool({
    connectionString: input.connection(app.migratorRole, app.database),
  });
  try {
    await assert.rejects(
      legacyAudit.query(
        "update kernel_actor_access set active=true where actor_id='actor_fixture'",
      ),
      /higher generation/u,
    );
    // Model a row retained by the previous installer under an already-active
    // named policy. Reinstalling that same release must close it, too.
    await legacyAudit.query(
      "insert into kernel_actor_access(principal_name,app_id,customer_id,actor_id,active,actor_kind,fence_generation) values ($1,$2,'org_fixture','legacy_actor',true,'human',5)",
      [app.runtimeRole, appId],
    );
    await named.installer(6).install();
    assert.deepEqual(
      (
        await legacyAudit.query(
          "select active,fence_generation from kernel_actor_access where actor_id='legacy_actor'",
        )
      ).rows,
      [{ active: false, fence_generation: "5" }],
    );
  } finally {
    await legacyAudit.end();
  }
  assert.equal(await named.installer(6).inspectAccess(true), "retryable");
  await named.installer(6).grant();
  assert.equal((await named.read(6))[0]!.name, "Retained record");
  assert.equal((await named.listWork(6))[0]!.title, "Retained private work");
  for (const rows of Object.values(await state())) {
    assert.equal(rows.find((row) => row.mode === "roleless")?.active, false);
    assert.equal(rows.find((row) => row.mode === "named")?.active, true);
  }
  await named.installer(7).revoke();
  assert.equal(await named.installer(7).reconcileAccess(false), "applied");
  for (const rows of Object.values(await state())) assert.ok(rows.every((row) => !row.active));
  await assert.rejects(named.read(5, null));
  await named.installer(10).grant();
  const roleless = await transition("mode-roleless-v3", [], 11);
  await assert.rejects(roleless.installer(9).grant(), /fence_rejected/u);
  for (const rows of Object.values(await state())) {
    assert.equal(rows.find((row) => row.mode === "named")?.active, true);
    assert.equal(Number(rows.find((row) => row.mode === "named")?.fence_generation), 10);
  }
  let stopped = false;
  fence = async () => {
    const observed = await input.auth.query(
      `select 1 from app_actor_assignment where "appId"=$1 and not active and fence_generation=11`,
      [appId],
    );
    if (observed.rowCount === 1 && !stopped) {
      stopped = true;
      throw new Error("interrupted mode closure");
    }
  };
  try {
    await assert.rejects(roleless.installer(11).grant(), /interrupted mode closure/u);
  } finally {
    fence = async () => {};
  }
  assert.equal((await state()).browser.find((row) => row.mode === "roleless")?.active, false);
  await roleless.installer(11).grant();
  assert.equal(await roleless.installer(11).reconcileAccess(true), "applied");
  assert.equal((await roleless.read(11))[0]!.name, "Retained record");
  for (const rows of Object.values(await state())) {
    assert.equal(rows.find((row) => row.mode === "named")?.active, false);
    assert.equal(rows.find((row) => row.mode === "roleless")?.active, true);
  }
  await roleless.installer(12).revoke();
  assert.equal(await roleless.installer(12).reconcileAccess(false), "applied");
  for (const rows of Object.values(await state())) assert.ok(rows.every((row) => !row.active));
  await assert.rejects(roleless.read(11));
  await assert.rejects(roleless.read(10, "member"));
  return 46 + signupChecks;
}
