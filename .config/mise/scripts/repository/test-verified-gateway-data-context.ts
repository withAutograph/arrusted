// @vitest-environment node
import assert from "node:assert/strict";
import { prepareProtectedInstallerTestRelease } from "./protected-installer-test-fixture";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { verifyCheckedRelease } from "../../../../packages/generated-app-runtime/server";
import { createPostgresDataContext } from "../../../../packages/generated-app-runtime/postgres";
import {
  createProtectedGeneratedInstaller,
  PROTECTED_GENERATED_APP_INSTALLER_ID,
} from "../../../../packages/generated-app-runtime/protected-installer";
import type { ProtectedGeneratedPlan } from "../../../../packages/generated-app-runtime/protected-installer";
import {
  createPrincipalSigner,
  createPrincipalVerifier,
  PRINCIPAL_HEADER,
} from "../../../../packages/platform-microfrontends/src/policy/identity";
import {
  VERIFIED_BODY_HEADER,
  VERIFIED_METHOD_HEADER,
  VERIFIED_TARGET_HEADER,
} from "../../../../packages/platform-microfrontends/src/policy/next-request-ingress";
import { createVerifiedGatewayDataContext } from "../../../../packages/platform-microfrontends/src/policy/verified-data-context";

const keys = generateKeyPairSync("ed25519");
const signer = createPrincipalSigner({
  issuer: "https://fixture.example",
  keyId: "fixture",
  privateKey: keys.privateKey,
});
const verifier = createPrincipalVerifier({
  issuer: "https://fixture.example",
  keyId: "fixture",
  publicKey: keys.publicKey,
});
const root = path.resolve(import.meta.dirname, "../../../..");
const scratch = await mkdtemp(path.join(tmpdir(), "verified-data-context-"));
const releaseDirectory = await prepareProtectedInstallerTestRelease(root, scratch);
const manifest = verifyCheckedRelease(releaseDirectory);
let port = 0;
let started = false;
let owner: Pool | undefined;
let runtime: Pool | undefined;
const password = `fixture-${randomUUID()}`;
const url = (role: string, database: string) =>
  `postgresql://${role}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}?sslmode=disable`;
function command(name: string, args: string[]) {
  const result = spawnSync(name, args, { encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`Owned PostgreSQL fixture command failed: ${name}: ${result.stderr}`);
}
const signedBody = new TextEncoder().encode("{}");
const signed = (change: Partial<Parameters<typeof signer.issue>[0]> = {}) =>
  signer.issue({
    aud: "platform-fixture",
    sub: "actor",
    organizationId: "tenant",
    customerId: "tenant",
    organizationRole: "member",
    appActorGrants: [{ role: "fixture_primary", fenceGeneration: 7 }],
    method: "POST",
    path: "/platform-fixture",
    jti: randomUUID(),
    bodySha256: createHash("sha256").update(signedBody).digest("base64url"),
    ...change,
  });
const input = (token = signed()) => ({
  request: {
    kind: "delegated-api" as const,
    body: signedBody,
    headers: new Headers({ [PRINCIPAL_HEADER]: token }),
    method: "POST",
    target: "/platform-fixture",
  },
  verification: { kind: "public-key" as const, verifier },
  scope: { appId: "platform-fixture", actorId: "actor", organizationId: "tenant" },
  role: "fixture_primary",
  runtime: {
    databaseUrl: url("app_runtime", "app_fixture"),
    database: "app_fixture",
    hostname: "127.0.0.1",
    port,
    runtimeRole: "app_runtime",
    environment: "local" as const,
  },
  sourceKind: "user",
  normalizedPayload: { fixture: "verified-gateway-data-context" },
  authorize: async () => {},
  verifyRelease: () => {
    verifyCheckedRelease(releaseDirectory);
  },
});
const payload = () => ({
  schema_version: manifest.schema_version,
  model_id: "fixture_record",
  kind: "aggregate",
  metrics: [{ fn: "count" }],
  as_of: "2026-10-24",
});
async function bind(active: boolean, generation: number) {
  if (!owner) throw new Error("fixture unavailable");
  const result = await owner.query("select kernel_bind_actor_membership($1::jsonb) result", [
    JSON.stringify({
      principal_name: "app_runtime",
      app_id: "platform-fixture",
      customer_id: "tenant",
      actor_id: "actor",
      actor_kind: "human",
      role: "fixture_primary",
      active,
      fence_generation: generation,
    }),
  ]);
  assert.equal(result.rows[0]?.result.ok, true);
  assert.equal(result.rows[0]?.result.data.active, active);
  assert.equal(Number(result.rows[0]?.result.data.fence_generation), generation);
}
async function setup() {
  port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string")
        return reject(new Error("fixture port unavailable"));
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
  const pgData = path.join(scratch, "data");
  command("initdb", ["-D", pgData, "-U", "fixture_root", "--auth=trust"]);
  command("pg_ctl", [
    "-D",
    pgData,
    "-l",
    path.join(scratch, "pg.log"),
    "-o",
    `-h 127.0.0.1 -p ${port} -k ${scratch}`,
    "-w",
    "start",
  ]);
  started = true;
  const admin = new Pool({ connectionString: url("fixture_root", "postgres") });
  try {
    await admin.query(
      `create role app_migrator login inherit createrole nosuperuser nocreatedb noreplication nobypassrls password '${password}';create role app_runtime login inherit nocreaterole nosuperuser nocreatedb noreplication nobypassrls password '${password}';create role auth_migrator login inherit nocreaterole nosuperuser nocreatedb noreplication nobypassrls password '${password}';create role auth_runtime login inherit nocreaterole nosuperuser nocreatedb noreplication nobypassrls password '${password}'`,
    );
    await admin.query("create database app_fixture owner app_migrator");
    await admin.query("create database auth_fixture owner auth_migrator");
  } finally {
    await admin.end();
  }
  const resources = (name: "app" | "auth") => ({
    resourceId: `fixture_${name}`,
    environment: "local" as const,
    hostname: "127.0.0.1",
    port,
    database: `${name}_fixture`,
    schema: "public" as const,
    migratorRole: `${name}_migrator`,
    runtimeRole: `${name}_runtime`,
  });
  for (const name of ["app", "auth"]) {
    const setup = new Pool({ connectionString: url(`${name}_migrator`, `${name}_fixture`) });
    try {
      await setup.query(
        `revoke all on database ${name}_fixture from public;grant connect on database ${name}_fixture to ${name}_runtime;revoke all on schema public from public;grant usage on schema public to ${name}_runtime`,
      );
    } finally {
      await setup.end();
    }
  }
  // The trusted installer checks Auth assignment-write isolation. This fixture
  // supplies only that schema dependency; the app adapter never receives its URL.
  const authSetup = new Pool({ connectionString: url("auth_migrator", "auth_fixture") });
  try {
    await authSetup.query(
      `create table public.app_actor_assignment ("organizationId" text,"actorId" text,"appId" text,role text,active boolean,"fence_generation" bigint,primary key("organizationId","actorId","appId",role)); grant select on public.app_actor_assignment to auth_runtime`,
    );
  } finally {
    await authSetup.end();
  }
  const trust = {
    id: PROTECTED_GENERATED_APP_INSTALLER_ID,
    sqlBundleHash: createHash("sha256")
      .update(await readFile(path.join(releaseDirectory, "sql-bundle.sql")))
      .digest("hex"),
  };
  const plan: ProtectedGeneratedPlan = {
    version: 1,
    appId: "platform-fixture",
    app: resources("app"),
    auth: resources("auth"),
    release: {
      id: manifest.schema_version,
      artifactHash: manifest.hashes.schema!.replace(/^sha256:/u, ""),
      manifestHash: createHash("sha256")
        .update(await readFile(path.join(releaseDirectory, "release-manifest.json")))
        .digest("hex"),
    },
    installer: trust,
    organizations: [
      { organizationId: "tenant", actors: [{ actorId: "actor", actorKind: "human", roles: ["fixture_primary"] }] },
    ],
  };
  await createProtectedGeneratedInstaller({
    plan,
    trust,
    fenceGeneration: 7,
    releaseDirectory,
    connections: {
      appMigrator: url("app_migrator", "app_fixture"),
      appRuntime: url("app_runtime", "app_fixture"),
      authMigrator: url("auth_migrator", "auth_fixture"),
      authRuntime: url("auth_runtime", "auth_fixture"),
    },
    assertCurrent: async () => {},
  }).install();
  owner = new Pool({ connectionString: url("app_migrator", "app_fixture") });
  runtime = new Pool({ connectionString: url("app_runtime", "app_fixture") });
  await bind(true, 7);
}
async function teardown() {
  await runtime?.end();
  await owner?.end();
  if (started) command("pg_ctl", ["-D", path.join(scratch, "data"), "-m", "fast", "-w", "stop"]);
  if (scratch) await rm(scratch, { recursive: true, force: true });
}

try {
  await setup();
  await assert.rejects(
    createVerifiedGatewayDataContext({ ...input(), normalizedPayload: undefined }),
  );
  const handle = await createVerifiedGatewayDataContext(input());
  try {
    assert.deepEqual(
      await handle.context.transaction((session) => session.call("kernel_data_query", payload())),
      { as_of: "2026-10-24", units: [null], groups: [], total: { metrics: ["0"] } },
    );
  } finally {
    await handle.close();
  }
  // A verified action refresh can read through its signed POST identity but must never write.
  const refreshInput = input();
  const refreshHeaders = new Headers(refreshInput.request.headers);
  refreshHeaders.set(VERIFIED_METHOD_HEADER, "POST");
  refreshHeaders.set(VERIFIED_TARGET_HEADER, "/platform-fixture");
  refreshHeaders.set(
    VERIFIED_BODY_HEADER,
    createHash("sha256").update(signedBody).digest("base64url"),
  );
  const refresh = await createVerifiedGatewayDataContext({
    ...refreshInput,
    normalizedPayload: undefined,
    request: {
      kind: "next-read",
      headers: refreshHeaders,
      method: "POST",
      target: "/platform-fixture",
    },
  });
  try {
    assert.deepEqual(
      await refresh.context.transaction((session) => session.call("kernel_data_query", payload())),
      { as_of: "2026-10-24", units: [null], groups: [], total: { metrics: ["0"] } },
    );
    await assert.rejects(
      refresh.context.transaction((session) =>
        session.call("kernel_record_agent_run", {
          run_id: randomUUID(),
          agent_identity_id: "adapter_fixture",
          execution_profile_id: "adapter_fixture",
        }),
      ),
      /Read-only data context rejects this operation/,
    );
  } finally {
    await refresh.close();
  }
  // Exercise a genuine generic runtime mutation and hold its actor SHARE lock
  // until the DataContext transaction commits. This is not product behavior.
  const writer = await createVerifiedGatewayDataContext(input());
  let releaseWrite = () => {};
  let enteredWrite = () => {};
  const holdWrite = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const writeEntered = new Promise<void>((resolve) => {
    enteredWrite = resolve;
  });
  const recordId = randomUUID();
  if (!owner) throw new Error("fixture unavailable");
  const revisionSetup = await owner.connect();
  let revisionId: number;
  try {
    await revisionSetup.query("begin");
    await revisionSetup.query(
      "select set_config('kernel.app_id','platform-fixture',true),set_config('kernel.customer_id','tenant',true)",
    );
    revisionId = (
      await revisionSetup.query(
        "select id from schema_revision where app_id='platform-fixture' and customer_id='tenant' and activated_at is not null",
      )
    ).rows[0].id;
    await revisionSetup.query("commit");
  } finally {
    await revisionSetup.query("rollback");
    revisionSetup.release();
  }
  const writing = writer.context.transaction(async (session) => {
    const result = await session.call("kernel_apply_change_set", {
      schema_revision_id: revisionId,
      source_kind: "user",
      idempotency_key: recordId,
      mode: "mainline",
      writes: [
        {
          model_id: "fixture_record",
          new_record_id: recordId,
          effective_start: "2026-01-01",
          values: { name: { type: "text", value: "Locked write" } },
        },
      ],
    });
    enteredWrite();
    await holdWrite;
    return result;
  });
  try {
    await writeEntered;
    const revoking = bind(false, 8);
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!owner) throw new Error("fixture unavailable");
      const result = await owner.query(
        "select exists(select 1 from pg_stat_activity where usename='app_migrator' and wait_event_type='Lock' and query like '%kernel_bind_actor_membership%') waiting",
      );
      if (result.rows[0]?.waiting === true) {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      waiting,
      true,
      "App binding revoke must wait for the mutation transaction's SHARE lock",
    );
    releaseWrite();
    assert.notEqual(await writing, undefined);
    await revoking;
    await bind(true, 9);
    if (!owner) throw new Error("fixture unavailable");
    if (!runtime) throw new Error("fixture unavailable");
    const observer = await runtime.connect();
    try {
      await observer.query("begin");
      await observer.query(
        "select set_config('kernel.app_id','platform-fixture',true),set_config('kernel.customer_id','tenant',true),set_config('kernel.actor_id','actor',true),set_config('kernel.actor_role','fixture_primary',true),set_config('kernel.actor_fence_generation','9',true)",
      );
      const persisted = await observer.query("select kernel_data_query($1::jsonb) result", [
        JSON.stringify({ ...payload(), app_id: "platform-fixture", customer_id: "tenant" }),
      ]);
      assert.equal(persisted.rows[0]?.result.ok, true);
      assert.equal(persisted.rows[0]?.result.data.total.metrics[0], "1");
      await observer.query("commit");
    } finally {
      await observer.query("rollback");
      observer.release();
    }
  } finally {
    releaseWrite();
    await writer.close();
  }
  for (const change of [
    { sub: "other" },
    { customerId: "other", organizationId: "other" },
    { aud: "other" },
    { method: "GET" },
    { path: "/other" },
    { appActorGrants: undefined },
  ])
    await assert.rejects(createVerifiedGatewayDataContext(input(signed(change))));
  const attacker = generateKeyPairSync("ed25519");
  const forged = createPrincipalSigner({
    issuer: "https://fixture.example",
    keyId: "fixture",
    privateKey: attacker.privateKey,
  }).issue({
    aud: "platform-fixture",
    sub: "actor",
    organizationId: "tenant",
    customerId: "tenant",
    organizationRole: null,
    appActorGrants: [{ role: "fixture_primary", fenceGeneration: 7 }],
    method: "POST",
    path: "/platform-fixture",
    jti: "forged",
  });
  await assert.rejects(createVerifiedGatewayDataContext(input(forged)));
  const selected = input();
  selected.runtime.databaseUrl = url("app_migrator", "app_fixture");
  await assert.rejects(createVerifiedGatewayDataContext(selected));
  if (!runtime) throw new Error("fixture unavailable");
  const omitted = createPostgresDataContext({
    pool: runtime,
    appId: "platform-fixture",
    customerId: "tenant",
    actorId: "actor",
    sourceKind: "user",
    authorize: async () => {},
    verifyRelease: () => {},
  });
  await assert.rejects(
    omitted.transaction((session) => session.call("kernel_data_query", payload())),
  );
  const stale = await createVerifiedGatewayDataContext(
    input(signed({ appActorGrants: [{ role: "fixture_primary", fenceGeneration: 6 }] })),
  );
  try {
    await assert.rejects(
      stale.context.transaction((session) => session.call("kernel_data_query", payload())),
    );
  } finally {
    await stale.close();
  }
  await bind(false, 10);
  const revoked = await createVerifiedGatewayDataContext(
    input(signed({ appActorGrants: [{ role: "fixture_primary", fenceGeneration: 10 }] })),
  );
  try {
    await assert.rejects(
      revoked.context.transaction((session) => session.call("kernel_data_query", payload())),
    );
  } finally {
    await revoked.close();
    await bind(true, 11);
  }
  console.log("Verified Gateway DataContext owned PostgreSQL acceptance passed");
} finally {
  await teardown();
}
