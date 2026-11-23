import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { buildReleaseFixture } from "./release-fixture";
import {
  createGeneratedAppRuntime,
  createPostgresDataContext,
  generatedAppLocalDatabaseUrl,
} from "../server";

type ProbeResult = {
  request: Record<string, unknown>;
  app_id: string;
  customer_id: string;
  actor_id: string;
  backend_pid: number;
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const adminUrl = new URL(
  generatedAppLocalDatabaseUrl({ root, appId: "authorization-context-proof" }),
);
adminUrl.pathname = "/postgres";
const database = `authorization_context_${randomUUID().replaceAll("-", "")}`;
const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
let databaseUrl: string;
let pool: Pool | undefined;
let databaseCreated = false;

beforeAll(async () => {
  try {
    await admin.query("select 1");
  } catch {
    throw new Error(
      "Authorization-context tests require local PostgreSQL. Configure AUTHORIZATION_CONTEXT_PROOF_DATABASE_URL before running this check.",
    );
  }
  await admin.query(`create database "${database}"`);
  databaseCreated = true;
  const fixtureUrl = new URL(adminUrl);
  fixtureUrl.pathname = `/${database}`;
  databaseUrl = fixtureUrl.toString();
  pool = new Pool({ connectionString: databaseUrl, max: 2 });
  pool.on("error", () => {});
  pool.on("connect", (client) => client.on("error", () => {}));
  await pool.query(`
    create function kernel_context_probe(request jsonb)
    returns jsonb
    language sql
    as $function$
      select jsonb_build_object(
        'ok', true,
        'data', jsonb_build_object(
          'request', request,
          'app_id', current_setting('kernel.app_id', true),
          'customer_id', current_setting('kernel.customer_id', true),
          'actor_id', current_setting('kernel.actor_id', true),
          'backend_pid', pg_backend_pid()
        )
      )
    $function$
  `);
}, 30000);

afterAll(async () => {
  await pool?.end();
  if (databaseCreated) await admin.query(`drop database if exists "${database}"`);
  await admin.end();
});

function fixturePool(): Pool {
  if (!pool) throw new Error("PostgreSQL fixture was not initialized");
  return pool;
}
function probe(value: unknown): ProbeResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid probe");
  const result = value as Record<string, unknown>;
  if (
    !result.request ||
    typeof result.request !== "object" ||
    Array.isArray(result.request) ||
    typeof result.app_id !== "string" ||
    typeof result.customer_id !== "string" ||
    typeof result.actor_id !== "string" ||
    typeof result.backend_pid !== "number" ||
    !Number.isSafeInteger(result.backend_pid)
  )
    throw new Error("invalid probe");
  return {
    request: result.request as Record<string, unknown>,
    app_id: result.app_id,
    customer_id: result.customer_id,
    actor_id: result.actor_id,
    backend_pid: result.backend_pid,
  };
}

function context(input: {
  appId: string;
  customerId: string;
  actorId: string;
  sourceKind: string;
  authorize?: () => Promise<void>;
}) {
  return createPostgresDataContext({
    pool: fixturePool(),
    ...input,
    authorize: input.authorize ?? (async () => {}),
    verifyRelease: () => {},
  });
}

test("snapshots the original context before caller mutation", async () => {
  let authorizationCalls = 0;
  let releaseChecks = 0;
  const input = {
    pool: fixturePool(),
    appId: "app-original",
    customerId: "customer-original",
    actorId: "actor-original",
    sourceKind: "human",
    authorize: async () => {
      authorizationCalls += 1;
    },
    verifyRelease: () => {
      releaseChecks += 1;
    },
  };
  const originalContext = createPostgresDataContext(input);
  input.appId = "app-mutated";
  input.customerId = "customer-mutated";
  input.actorId = "actor-mutated";
  input.sourceKind = "source-mutated";
  input.authorize = async () => {
    throw new Error("mutated authorize function was used");
  };
  input.verifyRelease = () => {
    throw new Error("mutated release verifier was used");
  };

  expect(originalContext.scope).toEqual({
    appId: "app-original",
    customerId: "customer-original",
  });
  await originalContext.authorize("asset.read");
  const result = await originalContext.transaction(async (session) =>
    probe(await session.call("kernel_context_probe", { value: "original" })),
  );

  expect(authorizationCalls).toBe(1);
  expect(releaseChecks).toBe(1);
  expect(result).toMatchObject({
    app_id: "app-original",
    customer_id: "customer-original",
    actor_id: "actor-original",
  });
  expect(result.request).toEqual({
    value: "original",
    app_id: "app-original",
    customer_id: "customer-original",
    actor_id: "actor-original",
  });
});

test("isolates tenant and actor context when concurrent transactions share one pool", async () => {
  const firstContext = context({
    appId: "app-first",
    customerId: "customer-first",
    actorId: "actor-first",
    sourceKind: "human",
  });
  const secondContext = context({
    appId: "app-second",
    customerId: "customer-second",
    actorId: "actor-second",
    sourceKind: "automation",
  });
  let entered = 0;
  let releaseBoth: (() => void) | undefined;
  const bothEntered = new Promise<void>((resolve) => {
    releaseBoth = resolve;
  });
  const run = async (dataContext: ReturnType<typeof context>, value: string) =>
    dataContext.transaction(async (session) => {
      entered += 1;
      if (entered === 2) releaseBoth?.();
      await bothEntered;
      return probe(await session.call("kernel_context_probe", { value }));
    });

  const [firstResult, secondResult] = await Promise.all([
    run(firstContext, "first"),
    run(secondContext, "second"),
  ]);

  expect(firstResult).toMatchObject({
    app_id: "app-first",
    customer_id: "customer-first",
    actor_id: "actor-first",
    request: { value: "first" },
  });
  expect(secondResult).toMatchObject({
    app_id: "app-second",
    customer_id: "customer-second",
    actor_id: "actor-second",
    request: { value: "second" },
  });
  expect(firstResult.backend_pid).not.toBe(secondResult.backend_pid);
});

test("rejects a forged actor payload before it reaches the kernel", async () => {
  const trustedContext = context({
    appId: "app",
    customerId: "customer",
    actorId: "trusted-actor",
    sourceKind: "human",
  });

  await expect(
    trustedContext.transaction((session) =>
      session.call("kernel_context_probe", { actor_id: "forged-actor" }),
    ),
  ).rejects.toThrow("Actor provenance does not match trusted context");
});

test("rejects a forged source payload before it reaches the kernel", async () => {
  const trustedContext = context({
    appId: "app",
    customerId: "customer",
    actorId: "actor",
    sourceKind: "human",
  });

  const trusted = await trustedContext.transaction(async (session) =>
    probe(
      await session.call("kernel_context_probe", {
        source_kind: "human",
        phase: "trusted-source",
      }),
    ),
  );
  expect(trusted.request).toMatchObject({
    source_kind: "human",
    phase: "trusted-source",
  });
  await expect(
    trustedContext.transaction((session) =>
      session.call("kernel_context_probe", { source_kind: "forged-source" }),
    ),
  ).rejects.toThrow("Source provenance does not match trusted context");
});

test("rolls back transaction-local GUCs before reusing a pooled connection", async () => {
  const firstContext = context({
    appId: "app-before-rollback",
    customerId: "customer-before-rollback",
    actorId: "actor-before-rollback",
    sourceKind: "human",
  });
  const secondContext = context({
    appId: "app-after-rollback",
    customerId: "customer-after-rollback",
    actorId: "actor-after-rollback",
    sourceKind: "human",
  });
  const operationError = new Error("operation failed");
  let firstProbe: ProbeResult | undefined;

  await expect(
    firstContext.transaction(async (session) => {
      firstProbe = probe(await session.call("kernel_context_probe", { phase: "first" }));
      throw operationError;
    }),
  ).rejects.toBe(operationError);

  const secondProbe = await secondContext.transaction(async (session) =>
    probe(await session.call("kernel_context_probe", { phase: "second" })),
  );

  expect(firstProbe).toMatchObject({
    app_id: "app-before-rollback",
    customer_id: "customer-before-rollback",
    actor_id: "actor-before-rollback",
  });
  expect(secondProbe).toMatchObject({
    app_id: "app-after-rollback",
    customer_id: "customer-after-rollback",
    actor_id: "actor-after-rollback",
  });
  expect(secondProbe.backend_pid).toBe(firstProbe?.backend_pid);
});

test("preserves the operation error and resets a connection when rollback fails", async () => {
  const resetContext = context({
    appId: "app-reset",
    customerId: "customer-reset",
    actorId: "actor-reset",
    sourceKind: "human",
  });
  const operationError = new Error("operation failed before connection termination");

  await expect(
    resetContext.transaction(async (session) => {
      const result = probe(await session.call("kernel_context_probe", { phase: "reset" }));
      await admin.query("select pg_terminate_backend($1, 5000)", [result.backend_pid]);
      throw operationError;
    }),
  ).rejects.toBe(operationError);

  const followUp = await resetContext.transaction(async (session) =>
    probe(await session.call("kernel_context_probe", { phase: "after-reset" })),
  );
  expect(followUp).toMatchObject({
    app_id: "app-reset",
    customer_id: "customer-reset",
    actor_id: "actor-reset",
    request: { phase: "after-reset" },
  });
});

test("factory snapshots all runtime inputs and keeps release verification stable", async () => {
  const fixture = buildReleaseFixture();
  const { appId, sourceCue, releaseDirectory } = fixture;
  const factoryDatabaseUrl = new URL(
    generatedAppLocalDatabaseUrl({
      root,
      appId: "authorization-context-proof",
    }),
  );
  factoryDatabaseUrl.pathname = `/${database}`;
  const input = {
    appId,
    customerId: "factory-customer",
    databaseUrl: factoryDatabaseUrl.toString(),
    releaseDirectory,
    sourceCue,
  };
  const runtime = createGeneratedAppRuntime(input);
  input.appId = "mutated-app";
  input.customerId = "mutated-customer";
  input.databaseUrl = "postgres://invalid:invalid@127.0.0.1:1/mutated";
  input.releaseDirectory = root;
  input.sourceCue = path.join(root, "missing-source.cue");

  try {
    expect(() => runtime.verifyRelease()).not.toThrow();
    const dataContext = runtime.dataContext({
      actorId: "factory-actor",
      sourceKind: "human",
      authorize: async () => {},
    });
    expect(runtime.appId).toBe(appId);
    expect(runtime.customerId).toBe("factory-customer");
    expect(dataContext.scope).toEqual({
      appId,
      customerId: "factory-customer",
    });
    await expect(
      dataContext.transaction(async (session) =>
        probe(await session.call("kernel_context_probe", { phase: "factory" })),
      ),
    ).resolves.toMatchObject({
      app_id: appId,
      customer_id: "factory-customer",
      actor_id: "factory-actor",
      request: {
        phase: "factory",
        app_id: appId,
        customer_id: "factory-customer",
        actor_id: "factory-actor",
      },
    });
  } finally {
    await runtime.close();
    fixture.cleanup();
  }
}, 180_000);

test("retries a session serialization failure with the same request identity", async () => {
  await fixturePool().query(`
    create sequence session_retry_attempt;
    create function kernel_work_session(request jsonb) returns jsonb language plpgsql as $test$
    begin
      if nextval('session_retry_attempt') = 1 then
        raise exception using errcode='40001', message='session contention';
      end if;
      return jsonb_build_object('ok',true,'data',request);
    end $test$;
  `);
  const trustedContext = context({
    appId: "app",
    customerId: "customer",
    actorId: "human",
    sourceKind: "human",
  });
  let attempts = 0;
  const request = {
    operation: "pin",
    session_id: "00000000-0000-4000-8000-000000000001",
    expected_revision: 1,
    request_id: "same-session-request",
    pinned: true,
  };
  const result = await trustedContext.transaction(async (session) => {
    attempts += 1;
    return await session.call("kernel_work_session", request);
  });
  expect(attempts).toBe(2);
  expect(result).toMatchObject(request);
  expect(request.request_id).toBe("same-session-request");
  const sequence = await fixturePool().query("select last_value from session_retry_attempt");
  expect(sequence.rows[0].last_value).toBe("2");
});
