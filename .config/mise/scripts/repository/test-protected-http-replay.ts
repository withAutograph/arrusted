import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { createServer } from "node:net";
import { type ProtectedHttpRequest } from "../../../../packages/generated-app-runtime/postgres";
import {
  checkedReleaseDirectory,
  createGeneratedAppRuntime,
  type GeneratedAppRuntime,
} from "../../../../packages/generated-app-runtime/server";
import { schemaCompilerCommand } from "./schema-compiler-command";
import { createWorkSessionClient } from "../../../../packages/generated-app-runtime/work-sessions";

const root = path.resolve(import.meta.dirname, "../../../..");
const scratch = await mkdtemp(path.join(tmpdir(), "http-replay-test-"));
const pgData = path.join(scratch, "pgdata");
const port = await new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") return reject(new Error("No fixture port"));
    server.close((error) => (error ? reject(error) : resolve(address.port)));
  });
});
const runtimeRole = `http_runtime_${randomUUID().replaceAll("-", "")}`;
const schema = `http_test_${randomUUID().replaceAll("-", "")}`;
const appId = "spend-review";
const customerId = "http_org";
const actorId = "http_actor";
let started = false;
let owner: Pool | undefined;
let runtime: GeneratedAppRuntime | undefined;
const run = (
  name: string,
  args: string[],
  outputFile?: string,
  environment?: NodeJS.ProcessEnv,
) => {
  const output = outputFile === undefined ? undefined : openSync(outputFile, "w", 0o600);
  const result = spawnSync(name, args, {
    cwd: root,
    encoding: "utf8",
    env: environment ?? process.env,
    ...(output === undefined ? {} : { stdio: ["ignore", output, "pipe"] as const }),
  });
  if (output !== undefined) closeSync(output);
  if (result.status !== 0)
    throw new Error(`${name} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
};
const hash = (input: string) => createHash("sha256").update(input).digest("base64url");
const requestExpiresAt = Math.floor(Date.now() / 1000) + 240;
const descriptor = (jti: string): ProtectedHttpRequest => ({
  audience: appId,
  bodySha256: hash("exact signed request bytes"),
  expiresAt: requestExpiresAt,
  issuer: "https://gateway.fixture",
  jti,
  method: "POST",
  payloadSha256: hash("normalized server action payload"),
  target: "/action",
});
const makeContext = (request?: ProtectedHttpRequest) => {
  assert(runtime);
  return runtime.dataContext({
    actorId,
    actorBinding: { role: "member", fenceGeneration: 1 },
    authorize: async () => {},
    sourceKind: "fixture",
    ...(request === undefined ? {} : { protectedHttpRequest: request }),
  });
};
const writes = (key: string, id: string, name: string) => ({
  schema_revision_id: "1",
  source_kind: "fixture",
  idempotency_key: key,
  mode: "mainline",
  writes: [
    {
      model_id: "item",
      new_record_id: id,
      effective_start: "2026-01-01",
      values: { name: { type: "text", value: name } },
    },
  ],
});
try {
  run("initdb", [
    "-D",
    pgData,
    "--auth-local=trust",
    "--auth-host=trust",
    "--username=fixture_root",
  ]);
  run("pg_ctl", [
    "-D",
    pgData,
    "-l",
    path.join(scratch, "postgres.log"),
    "-o",
    `-h 127.0.0.1 -p ${port} -k ${scratch}`,
    "-w",
    "start",
  ]);
  started = true;
  owner = new Pool({ connectionString: `postgresql://fixture_root@127.0.0.1:${port}/postgres` });
  await owner.query(`create schema "${schema}"`);
  const ownerConnection = await owner.connect();
  try {
    await ownerConnection.query(`set search_path to "${schema}"`);
    const fixtureManifest = {
      app_id: appId,
      customer_id: customerId,
      version: "http-v1",
      models: [
        {
          id: "item",
          kind: "entity",
          label: "Item",
          fields: [{ id: "name", label: "Name", type: "text", required: true }],
        },
      ],
    };
    const input = path.join(scratch, "fixture.json");
    await writeFile(input, JSON.stringify({ manifest: fixtureManifest }));
    const compiler = (mode: string, outputFile?: string) => {
      const invocation = schemaCompilerCommand([
        "run",
        "--locked",
        "--quiet",
        "-p",
        "schema-compiler",
        "--",
        mode,
        input,
      ]);
      return run(invocation.executable, invocation.args, outputFile, invocation.env);
    };
    const artifact = JSON.parse(compiler("--app-artifact")) as { schema: unknown };
    const sqlFile = path.join(scratch, "bundle.sql");
    compiler("--sql-bundle", sqlFile);
    await ownerConnection.query(await readFile(sqlFile, "utf8"));
    await ownerConnection.query(
      `create role "${runtimeRole}" login nosuperuser nocreatedb nocreaterole noreplication nobypassrls`,
    );
    const capability = (
      await ownerConnection.query("select kernel_installer_capability_role('runtime') as name")
    ).rows[0].name as string;
    await ownerConnection.query(
      `grant "${capability}" to "${runtimeRole}"; grant usage on schema "${schema}" to "${runtimeRole}"`,
    );
    const schemaJson = artifact.schema;
    await ownerConnection.query(
      "insert into schema_revision(app_id,customer_id,version,base_schema,customer_overlay,schema,activated_at) values($1,$2,'http-v1',$3,'{}',$3,now())",
      [appId, customerId, schemaJson],
    );
    await ownerConnection.query(
      "select kernel_sync_schema_authorization_policy(id) from schema_revision where app_id=$1",
      [appId],
    );
    for (const [functionName, request] of [
      [
        "kernel_bind_principal_scope",
        {
          principal_name: runtimeRole,
          capability: "runtime",
          app_id: appId,
          customer_id: customerId,
          actor_binding_required: true,
        },
      ],
      [
        "kernel_bind_actor_membership",
        {
          principal_name: runtimeRole,
          app_id: appId,
          customer_id: customerId,
          actor_id: actorId,
          actor_kind: "human",
          role: "member",
          active: true,
          fence_generation: 1,
        },
      ],
    ] as const) {
      const result = await ownerConnection.query(`select ${functionName}($1::jsonb) as result`, [
        JSON.stringify(request),
      ]);
      assert.equal(result.rows[0].result.ok, true);
    }
  } finally {
    ownerConnection.release();
  }
  const runtimeUrl = new URL(`postgresql://${runtimeRole}@127.0.0.1:${port}/postgres`);
  runtimeUrl.searchParams.set("options", `-c search_path=${schema},pg_catalog`);
  runtimeUrl.searchParams.set("application_name", "http_nonce_fixture");
  runtime = createGeneratedAppRuntime({
    appId,
    customerId,
    databaseUrl: runtimeUrl.toString(),
    releaseDirectory: checkedReleaseDirectory(root, appId),
  });
  for (const invalid of [
    { ...descriptor("wrong-audience"), audience: "https://app.fixture" },
    { ...descriptor("lower-method"), method: "post" },
    { ...descriptor("absolute-target"), target: "https://other.fixture/action" },
    { ...descriptor("fragment-target"), target: "/action#fragment" },
    { ...descriptor("noncanonical-target"), target: "/action/" },
    { ...descriptor("blank-jti"), jti: " " },
    { ...descriptor("noncanonical-digest"), bodySha256: "A".repeat(42) + "B" },
  ])
    assert.throws(() => makeContext(invalid));
  const { payloadSha256: _payload, ...readDescriptor } = descriptor("read-only");
  const validReadContext = makeContext({
    ...readDescriptor,
    method: "GET",
    target: "/items?q=one",
  });
  await validReadContext.transaction((session) =>
    session.call("kernel_data_query", {
      schema_version: "http-v1",
      model_id: "item",
      kind: "aggregate",
      metrics: [{ fn: "count" }],
      as_of: "2026-01-01",
    }),
  );
  const noncesBeforeWrites = await owner.query(
    `select count(*)::text as count from "${schema}".kernel_http_request_consumption`,
  );
  assert.equal(noncesBeforeWrites.rows[0].count, "0");
  const first = writes("first", randomUUID(), "first");
  const second = writes("second", randomUUID(), "second");
  await assert.rejects(
    makeContext().transaction((session) => session.call("kernel_apply_change_set", first)),
  );
  await assert.rejects(
    makeContext({
      ...descriptor("missing-body"),
      bodySha256: undefined,
    } as unknown as ProtectedHttpRequest).transaction((session) =>
      session.call("kernel_apply_change_set", first),
    ),
  );
  const execute = async (request: ProtectedHttpRequest) => {
    const context = makeContext(request);
    return await context.requestTransaction(async () => {
      const one = await context.transaction((session) =>
        session.call("kernel_apply_change_set", first),
      );
      const two = await context.transaction((session) =>
        session.call("kernel_apply_change_set", second),
      );
      return [one, two];
    });
  };
  let firstWritten!: () => void;
  let releaseFirst!: () => void;
  const firstReady = new Promise<void>((resolve) => {
    firstWritten = resolve;
  });
  const firstRelease = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const concurrentContext = makeContext(descriptor("concurrent"));
  const firstRequest = concurrentContext.requestTransaction(async () => {
    const one = await concurrentContext.transaction((session) =>
      session.call("kernel_apply_change_set", first),
    );
    firstWritten();
    await firstRelease;
    const two = await concurrentContext.transaction((session) =>
      session.call("kernel_apply_change_set", second),
    );
    return [one, two];
  });
  await firstReady;
  const secondRequest = execute(descriptor("concurrent"));
  let blocked = false;
  try {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const observed = await owner.query(
        "select exists(select 1 from pg_stat_activity where application_name='http_nonce_fixture' and wait_event_type='Lock') as blocked",
      );
      blocked = observed.rows[0].blocked as boolean;
      if (blocked) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    releaseFirst();
  }
  const results = await Promise.all([firstRequest, secondRequest]);
  assert.equal(
    blocked,
    true,
    "concurrent duplicate must wait on the original database consumption",
  );
  assert.deepEqual(results[0], results[1]);
  const replay = await execute(descriptor("concurrent"));
  assert.deepEqual(replay, results[0]);
  await assert.rejects(
    execute({ ...descriptor("concurrent"), payloadSha256: hash("changed body") }),
  );
  await assert.rejects(
    makeContext(descriptor("concurrent")).transaction((session) =>
      session.call("kernel_apply_change_set", { ...first, notes: "changed operation" }),
    ),
  );
  // Use the same context: nested generated operations share that context's one transaction.
  const rolledContext = makeContext(descriptor("rolled-back"));
  await assert.rejects(
    rolledContext.requestTransaction(async () => {
      await rolledContext.transaction((session) =>
        session.call(
          "kernel_apply_change_set",
          writes("rolled", "00000000-0000-4000-8000-000000000123", "rolled"),
        ),
      );
      throw new Error("rollback");
    }),
  );
  await assert.rejects(
    makeContext(descriptor("rolled-back")).transaction((session) =>
      session.call("kernel_apply_change_set", {
        ...writes("rolled", "00000000-0000-4000-8000-000000000123", "rolled"),
        notes: "altered after rollback",
      }),
    ),
  );
  await assert.rejects(
    makeContext({
      ...descriptor("rolled-back"),
      bodySha256: hash("altered signed body"),
    }).transaction((session) => session.call("kernel_apply_change_set", first)),
  );
  const retry = makeContext(descriptor("rolled-back"));
  await retry.transaction((session) =>
    session.call(
      "kernel_apply_change_set",
      writes("rolled", "00000000-0000-4000-8000-000000000123", "rolled"),
    ),
  );
  await assert.rejects(
    makeContext({ ...descriptor("rolled-back"), target: "/different" }).transaction((session) =>
      session.call("kernel_apply_change_set", first),
    ),
  );
  const rows = await owner.query(`select count(*)::text as count from "${schema}".item_record`);
  assert.equal(rows.rows[0].count, "3");
  // An authenticated app with no business roles still has individual DB admission.
  const rolelessActor = "roleless_actor";
  const rolelessScope = { app_id: appId, customer_id: customerId, actor_id: rolelessActor };
  const admin = await owner.connect();
  const rolelessRuntime = new Pool({ connectionString: runtimeUrl.toString() });
  try {
    await admin.query(`set search_path to "${schema}"`);
    const bind = async (active: boolean, generation: number) =>
      (
        await admin.query("select kernel_bind_actor_access($1::jsonb) as result", [
          JSON.stringify({
            ...rolelessScope,
            principal_name: runtimeRole,
            actor_kind: "human",
            active,
            fence_generation: generation,
          }),
        ])
      ).rows[0].result;
    assert.equal((await bind(true, 4)).ok, true);
    assert.equal((await bind(true, 4)).ok, true);
    const readback = (
      await rolelessRuntime.query("select kernel_read_actor_access($1::jsonb) as result", [
        JSON.stringify(rolelessScope),
      ])
    ).rows[0].result;
    assert.deepEqual(readback.data, {
      appId,
      organizationId: customerId,
      actorId: rolelessActor,
      active: true,
      fenceGeneration: 4,
    });
    assert.equal(
      (
        await admin.query(
          "select count(*)::int count from kernel_actor_membership where actor_id=$1",
          [rolelessActor],
        )
      ).rows[0].count,
      0,
    );
    await assert.rejects(
      rolelessRuntime.query("select kernel_bind_actor_access($1::jsonb)", [
        JSON.stringify({
          ...rolelessScope,
          principal_name: runtimeRole,
          actor_kind: "human",
          active: true,
          fence_generation: 5,
        }),
      ]),
    );
    const rolelessRequest = descriptor("roleless-write");
    const admission = {
      ...rolelessScope,
      role: null,
      fence_generation: 4,
      http_request: rolelessRequest,
    };
    const saved = { ...rolelessScope, ...writes("roleless-saved", randomUUID(), "roleless saved") };
    const admit = async (request: Record<string, unknown>) =>
      (
        await rolelessRuntime.query("select kernel_admit_http_request($1::jsonb) as result", [
          JSON.stringify(request),
        ])
      ).rows[0].result;
    for (const wrong of [
      { actor_id: "someone_else" },
      { customer_id: "other_tenant" },
      { app_id: "other_app" },
      { fence_generation: 3 },
    ])
      assert.equal((await admit({ ...admission, ...wrong })).ok, false);
    assert.equal((await admit(admission)).ok, true);
    assert.equal(
      (
        await rolelessRuntime.query("select kernel_admit_http_operation($1::jsonb) as result", [
          JSON.stringify({
            ...admission,
            sequence: 1,
            operation: "kernel_apply_change_set",
            payload: saved,
          }),
        ])
      ).rows[0].result.ok,
      true,
    );
    const useSession = async (generation: number, save: boolean) => {
      const connection = await rolelessRuntime.connect();
      try {
        await connection.query("begin");
        await connection.query(
          "select set_config('kernel.app_id',$1,true),set_config('kernel.customer_id',$2,true),set_config('kernel.actor_id',$3,true),set_config('kernel.actor_role','',true),set_config('kernel.actor_fence_generation',$4,true),set_config('kernel.http_jti',$5,true),set_config('kernel.http_descriptor',$6,true),set_config('kernel.http_sequence','1',true)",
          [
            appId,
            customerId,
            rolelessActor,
            String(generation),
            rolelessRequest.jti,
            JSON.stringify(rolelessRequest),
          ],
        );
        const result = save
          ? (
              await connection.query("select kernel_apply_change_set($1::jsonb) as result", [
                JSON.stringify(saved),
              ])
            ).rows[0].result
          : (
              await connection.query("select kernel_data_query($1::jsonb) as result", [
                JSON.stringify({
                  ...rolelessScope,
                  schema_version: "http-v1",
                  model_id: "item",
                  kind: "aggregate",
                  metrics: [{ fn: "count" }],
                  as_of: "2026-01-01",
                }),
              ])
            ).rows[0].result;
        await connection.query("commit");
        return result;
      } finally {
        await connection.query("rollback");
        connection.release();
      }
    };
    assert.equal((await useSession(4, true)).ok, true);
    assert.equal((await useSession(4, false)).ok, true);
    assert.equal(
      (await owner.query(`select count(*)::int count from "${schema}".item_record`)).rows[0].count,
      4,
    );
    const workSessionId = randomUUID();
    const work = () =>
      createWorkSessionClient(
        runtime!.dataContext({
          actorId: rolelessActor,
          actorBinding: { role: null, fenceGeneration: 4 },
          authorize: async () => {},
          sourceKind: "fixture",
          protectedHttpRequest: descriptor(randomUUID()),
        }),
        "http-v1",
      );
    // Work sessions resolve identity even when the schema has no business roles.
    const created = await work().request({
      operation: "create",
      session_id: workSessionId,
      request_id: randomUUID(),
      expected_revision: 0,
      title: "Roleless work",
      as_of: "2026-01-01",
    });
    assert.equal(created.revision, 1);
    assert.equal((await work().request({ operation: "list" })).length, 1);
    const staged = await work().request({
      operation: "stage",
      session_id: workSessionId,
      changes: [
        {
          model_id: "item",
          record_id: saved.writes[0]!.new_record_id,
          field_id: "name",
          value: { type: "text", value: "staged by human" },
        },
      ],
    });
    assert.equal(staged.entries[0]!.author_kind, "human");
    // Save is human-only: classifying every no-membership actor as an agent rejects it.
    const cleared = await work().request({
      operation: "save",
      session_id: workSessionId,
      request_id: randomUUID(),
      expected_revision: staged.revision,
    });
    assert.equal(cleared.cleared, true);
    const agentWork = createWorkSessionClient(
      runtime!.dataContext({
        actorId: rolelessActor,
        actorBinding: { role: null, fenceGeneration: 4 },
        authorize: async () => {},
        sourceKind: "agent",
        agent: { turnId: randomUUID() },
      }),
      "http-v1",
    );
    await assert.rejects(
      agentWork.request({
        operation: "save",
        session_id: workSessionId,
        request_id: randomUUID(),
        expected_revision: cleared.revision,
      }),
      /requires a human|not authorized/,
    );
    assert.equal((await bind(false, 5)).ok, true);
    assert.equal((await bind(true, 4)).ok, false);
    assert.equal((await useSession(4, false)).ok, false);
    assert.equal((await admit(admission)).ok, false);
    await assert.rejects(work().request({ operation: "list" }));
  } finally {
    admin.release();
    await rolelessRuntime.end();
  }
  console.log(
    "Protected HTTP replay: owned PostgreSQL multi-operation, concurrent duplicate, exact receipt replay, rollback, and identity negatives passed; no hosted evidence.",
  );
} finally {
  await runtime?.close();
  await owner?.end();
  if (started) run("pg_ctl", ["-D", pgData, "-m", "immediate", "-w", "stop"]);
  await rm(scratch, { recursive: true, force: true });
}
