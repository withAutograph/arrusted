import { capabilityRoleFixture } from "../../generated-app-runtime/__tests__/capability-role-fixture";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { buildGeneratedRelease } from "../../../.config/mise/scripts/repository/schema-release";
import {
  createGeneratedAppRuntime,
  generatedAppLocalDatabaseUrl,
  installGeneratedAppRuntime,
} from "../../generated-app-runtime/server";
import { convertCurrency, createCurrencyRateStore, resolveCurrencyRate } from "../index";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const appId = "currency-persistence-proof";
const customerId = "local-demo";
const otherCustomerId = "local-other";
const directory = mkdtempSync(path.join(tmpdir(), "currency-persistence-"));
const database = `currency_proof_${randomUUID().replaceAll("-", "")}`;
const url = new URL(generatedAppLocalDatabaseUrl({ root, appId }));
url.pathname = "/postgres";
const admin = new Pool({ connectionString: url.toString() });
let created = false;
let roles: string[] = [];
let roleFixture: Awaited<ReturnType<typeof capabilityRoleFixture>> | undefined;
let runtime: ReturnType<typeof createGeneratedAppRuntime>;
let otherRuntime: ReturnType<typeof createGeneratedAppRuntime>;
let store: ReturnType<typeof createCurrencyRateStore>;
let otherStore: ReturnType<typeof createCurrencyRateStore>;
const pair = { sourceCurrency: "EUR", targetCurrency: "USD" };
const key = (idempotencyKey: string) => ({ idempotencyKey });

beforeAll(async () => {
  await admin.query("select 1");
  const release = buildGeneratedRelease(appId, directory, [
    "packages/schema-compiler/cue/app-manifest.cue",
    "packages/currency-rates/__tests__/exchange-rates.cue",
  ]);
  roleFixture = await capabilityRoleFixture(admin);
  await admin.query(`create database "${database}"`);
  created = true;
  url.pathname = `/${database}`;
  await installGeneratedAppRuntime({
    appId,
    customerIds: [customerId, otherCustomerId],
    databaseUrl: url.toString(),
    releaseDirectory: release.directory,
  });
  const installed = new Pool({ connectionString: url.toString() });
  try {
    roles = (
      await installed.query(
        "select kernel_installer_capability_role(capability) as name from unnest(array['query','runtime','schema_admin','execution_owner']) capability",
      )
    ).rows.map((row) => String(row.name));
    const principal = String(
      (await installed.query("select session_user::text as name")).rows[0].name,
    );
    await roleFixture.grantRuntime(installed, roles[1]!, principal);
    for (const [customer_id, actor_id] of [
      [customerId, "currency-proof"],
      [otherCustomerId, "currency-proof-other"],
    ]) {
      for (const [operation, payload] of [
        ["kernel_bind_principal_scope", { capability: "runtime" }],
        ["kernel_bind_actor_membership", { actor_id, actor_kind: "human", role: "fixture" }],
      ] as const) {
        const result = await installed.query(`select ${operation}($1::jsonb) result`, [
          JSON.stringify({ principal_name: principal, app_id: appId, customer_id, ...payload }),
        ]);
        expect(result.rows[0].result.ok).toBe(true);
      }
    }
  } finally {
    await installed.end();
  }
  // Raw kernel operations use the connection actor as well as trusted membership.
  const runtimeUrl = new URL(url);
  runtimeUrl.searchParams.set("options", "-c kernel.actor_id=currency-proof");
  const otherRuntimeUrl = new URL(url);
  otherRuntimeUrl.searchParams.set("options", "-c kernel.actor_id=currency-proof-other");
  runtime = createGeneratedAppRuntime({
    appId,
    customerId,
    databaseUrl: runtimeUrl.toString(),
    releaseDirectory: release.directory,
  });
  store = createCurrencyRateStore({
    kernel: runtime.operations,
    scope: { appId, customerId },
    actorId: "currency-proof",
  });
  otherRuntime = createGeneratedAppRuntime({
    appId,
    customerId: otherCustomerId,
    databaseUrl: otherRuntimeUrl.toString(),
    releaseDirectory: release.directory,
  });
  otherStore = createCurrencyRateStore({
    kernel: otherRuntime.operations,
    scope: { appId, customerId: otherCustomerId },
    actorId: "currency-proof-other",
  });
}, 180000);

afterAll(async () => {
  await runtime?.close();
  await otherRuntime?.close();
  if (created) await admin.query(`drop database if exists "${database}"`);
  await roleFixture?.cleanup(roles);
  await admin.end();
  rmSync(directory, { recursive: true, force: true });
}, 60000);

async function resolved(asOf: string) {
  const request = { ...pair, asOf };
  return resolveCurrencyRate(await store.read(request), request);
}
async function visible(asOf: string) {
  return runtime.operations.readVisibleRecords({
    app_id: appId,
    customer_id: customerId,
    model_id: "exchange_rate",
    as_of: asOf,
  });
}
async function importMonth(month: string, rate: string, idempotencyKey: string) {
  return store.importMonthly(
    { ...pair, month },
    {
      ...key(idempotencyKey),
      today: "2026-10-24",
      fetch: async () =>
        new Response(JSON.stringify({ base: "EUR", quote: "USD", date: `${month}-01`, rate })),
    },
  );
}

test("ordinary kernel versions preserve monthly history, corrections and custom precedence", async () => {
  await importMonth("2026-08", "1.10", "august");
  const august = (await visible("2026-08-15"))[0]!;
  expect(august.external_key).toBe("EUR/USD/frankfurter");
  await importMonth("2026-09", "1.20", "september");
  await expect(resolved("2026-08-31")).resolves.toMatchObject({
    status: "found",
    rate: "1.10",
    origin: "frankfurter",
  });
  await expect(resolved("2026-09-01")).resolves.toMatchObject({ status: "found", rate: "1.20" });
  const september = (await visible("2026-09-01"))[0]!;
  expect(september.record_id).toBe(august.record_id);
  expect(september.version_id).not.toBe(august.version_id);
  await importMonth("2026-09", "1.25", "september-correction");
  await expect(resolved("2026-09-01")).resolves.toMatchObject({ rate: "1.25" });
  await expect(resolved("2027-01-01")).resolves.toMatchObject({ rate: "1.25" });
  expect(await visible("2027-01-01")).toHaveLength(1);
  await importMonth("2026-07", "1.05", "july-backfill");
  await expect(resolved("2026-07-31")).resolves.toMatchObject({ rate: "1.05" });
  await expect(resolved("2026-08-01")).resolves.toMatchObject({ rate: "1.10" });
  await expect(resolved("2026-09-01")).resolves.toMatchObject({ rate: "1.25" });
  await expect(resolved("2027-01-01")).resolves.toMatchObject({ rate: "1.25" });
  expect((await visible("2026-07-01"))[0]!.record_id).toBe(august.record_id);

  await store.saveCustom(
    { ...pair, rate: "1.50", effectiveStart: "2026-09-10", effectiveEnd: "2026-09-20" },
    key("custom-finite"),
  );
  await expect(resolved("2026-09-09")).resolves.toMatchObject({
    rate: "1.25",
    origin: "frankfurter",
  });
  await expect(resolved("2026-09-10")).resolves.toMatchObject({ rate: "1.50", origin: "custom" });
  await expect(resolved("2026-09-20")).resolves.toMatchObject({ rate: "1.50", origin: "custom" });
  await expect(resolved("2026-09-21")).resolves.toMatchObject({
    rate: "1.25",
    origin: "frankfurter",
  });
  expect(
    (await visible("2026-09-21")).find((row) => row.external_key === "EUR/USD/custom")?.values.rate,
  ).toBeUndefined();

  await store.saveCustom(
    { ...pair, rate: "1.75", effectiveStart: "2026-09-25", effectiveEnd: null },
    key("custom-open"),
  );
  await store.useAutomatic({ ...pair, effectiveStart: "2026-10-01" }, key("automatic"));
  await expect(resolved("2026-09-30")).resolves.toMatchObject({ rate: "1.75", origin: "custom" });
  await expect(resolved("2026-10-01")).resolves.toMatchObject({
    rate: "1.25",
    origin: "frankfurter",
  });
  await expect(resolved("2027-01-01")).resolves.toMatchObject({
    rate: "1.25",
    origin: "frankfurter",
  });
  const history = await store.history(pair);
  expect(
    history.map(({ origin, rate, effectiveStart, effectiveEnd }) => ({
      origin,
      rate,
      effectiveStart,
      effectiveEnd,
    })),
  ).toEqual([
    { origin: "custom", rate: "1.75", effectiveStart: "2026-09-25", effectiveEnd: "2026-09-30" },
    { origin: "custom", rate: "1.50", effectiveStart: "2026-09-10", effectiveEnd: "2026-09-20" },
    { origin: "frankfurter", rate: "1.25", effectiveStart: "2026-09-01", effectiveEnd: null },
    {
      origin: "frankfurter",
      rate: "1.10",
      effectiveStart: "2026-08-01",
      effectiveEnd: "2026-08-31",
    },
    {
      origin: "frankfurter",
      rate: "1.05",
      effectiveStart: "2026-07-01",
      effectiveEnd: "2026-07-31",
    },
  ]);
  expect(
    history.filter((rate) => rate.origin === "frankfurter").map((rate) => rate.observationDate),
  ).toEqual(["2026-09-01", "2026-08-01", "2026-07-01"]);
  await expect(store.history({ sourceCurrency: "GBP", targetCurrency: "USD" })).resolves.toEqual(
    [],
  );
  const rows = await visible("2027-01-01");
  expect(rows).toHaveLength(2);
  expect(
    rows.map((row) => row.external_key).sort((a, b) => (a ?? "").localeCompare(b ?? "")),
  ).toEqual(["EUR/USD/custom", "EUR/USD/frankfurter"]);
  expect(rows.find((row) => row.external_key === "EUR/USD/custom")?.values.rate).toBeUndefined();
}, 60000);

test("installed tenants cannot observe or replace each other's rates", async () => {
  await expect(otherStore.history(pair)).resolves.toEqual([]);
  await otherStore.saveCustom(
    { ...pair, rate: "9.99", effectiveStart: "2031-01-01", effectiveEnd: null },
    key("other-tenant-custom"),
  );
  await expect(
    resolveCurrencyRate(await otherStore.read({ ...pair, asOf: "2031-01-01" }), {
      ...pair,
      asOf: "2031-01-01",
    }),
  ).toMatchObject({ rate: "9.99", origin: "custom" });
  await expect(resolved("2031-01-01")).resolves.not.toMatchObject({ rate: "9.99" });
  const firstTenantRows = await visible("2031-01-01");
  expect(firstTenantRows.some((row) => row.values.rate?.value === "9.99")).toBe(false);
}, 60000);

test("correcting a finite period can extend and reopen its kernel timeline", async () => {
  await store.saveCustom(
    { ...pair, rate: "2.10", effectiveStart: "2030-01-01", effectiveEnd: "2030-01-10" },
    key("finite-before-correction"),
  );
  const current = (await visible("2030-01-01")).find(
    (row) => row.external_key === "EUR/USD/custom",
  )!;
  await store.saveCustom(
    {
      ...pair,
      rate: "2.20",
      effectiveStart: "2030-01-01",
      effectiveEnd: null,
      previousEffectiveEnd: "2030-01-10",
    },
    { ...key("reopen-finite-correction"), expectedVersionId: current.version_id },
  );
  await expect(resolved("2030-01-01")).resolves.toMatchObject({ rate: "2.20" });
  await expect(resolved("2030-01-11")).resolves.toMatchObject({ rate: "2.20" });
  await expect(resolved("2030-12-31")).resolves.toMatchObject({ rate: "2.20" });
}, 60000);

test("finite successors close open custom periods without resurrection", async () => {
  await store.saveCustom(
    { ...pair, rate: "1.80", effectiveStart: "2027-02-01", effectiveEnd: null },
    key("successor-open"),
  );
  await store.saveCustom(
    { ...pair, rate: "1.90", effectiveStart: "2027-02-10", effectiveEnd: "2027-02-20" },
    key("successor-finite"),
  );
  const predecessor = (await visible("2027-02-09")).find(
    (row) => row.external_key === "EUR/USD/custom",
  );
  expect(predecessor?.effective_end).toBe("2027-02-09");
  await expect(resolved("2027-02-09")).resolves.toMatchObject({ rate: "1.80", origin: "custom" });
  await expect(resolved("2027-02-10")).resolves.toMatchObject({ rate: "1.90", origin: "custom" });
  await expect(resolved("2027-02-20")).resolves.toMatchObject({ rate: "1.90", origin: "custom" });
  await expect(resolved("2027-02-21")).resolves.toMatchObject({
    rate: "1.25",
    origin: "frankfurter",
  });
  await expect(resolved("2028-01-01")).resolves.toMatchObject({
    rate: "1.25",
    origin: "frankfurter",
  });
}, 60000);

test("inverse entry replaces the same pair record and governs both conversion directions", async () => {
  const reverse = { sourceCurrency: "USD", targetCurrency: "EUR" };
  await store.saveCustom(
    { ...reverse, rate: "0.8", effectiveStart: "2029-01-01", effectiveEnd: null },
    key("inverse-entry"),
  );
  const request = { ...pair, asOf: "2029-01-01" };
  expect(convertCurrency("10", await store.read(request), request)).toMatchObject({
    amount: "12.5",
    operation: "divide",
    origin: "custom",
  });
  const reversed = { ...reverse, asOf: request.asOf };
  expect(convertCurrency("10", await store.read(reversed), reversed)).toMatchObject({
    amount: "8",
    operation: "multiply",
    origin: "custom",
  });
  const initial = (await visible(request.asOf)).find(
    (row) => row.external_key === "EUR/USD/custom",
  )!;
  expect(initial.values.rate?.value).toBe("0.8");
  expect(initial.values.source_currency?.value).toBe("USD");
  await store.saveCustom(
    { ...pair, rate: "1.5", effectiveStart: "2029-02-01", effectiveEnd: null },
    key("direct-successor"),
  );
  const rows = await visible("2029-02-01");
  expect(rows).toHaveLength(2);
  expect(rows.find((row) => row.external_key === "EUR/USD/custom")!.record_id).toBe(
    initial.record_id,
  );
  expect(await store.history(reverse)).toEqual(await store.history(pair));
  const history = await store.history(pair);
  expect(
    history.find((entry) => entry.effectiveStart === "2029-01-01" && entry.origin === "custom"),
  ).toMatchObject({
    sourceCurrency: "USD",
    targetCurrency: "EUR",
    rate: "0.8",
    effectiveEnd: "2029-01-31",
  });
  await store.useAutomatic({ ...reverse, effectiveStart: "2029-03-01" }, key("inverse-reset"));
  const reset = { ...reversed, asOf: "2029-03-01" };
  expect(convertCurrency("10", await store.read(reset), reset)).toMatchObject({
    amount: "8",
    origin: "frankfurter",
  });
}, 60000);
