import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { buildGeneratedRelease } from "../../../.config/mise/scripts/repository/schema-release";
import { generatedAppLocalDatabaseUrl, setupGeneratedAppLocal } from "../server";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testDirectory, "../../..");
const directory = mkdtempSync(path.join(tmpdir(), "query-contract-proof-"));
const database = `query_contract_${randomUUID().replaceAll("-", "")}`;
const url = new URL(generatedAppLocalDatabaseUrl({ root, appId: "data-plane-proof" }));
url.pathname = "/postgres";
const admin = new Pool({ connectionString: url.toString() });
let installed: Pool;
let databaseCreated = false;
let capabilityRoles: string[] = [];
const asOf = "2026-09-15";
const request = (extra: Record<string, unknown> = {}) => ({
  app_id: "query-contract",
  customer_id: "local-demo",
  schema_version: "query-contract-v1",
  model_id: "asset",
  as_of: asOf,
  ...extra,
});

const query = async (value: Record<string, unknown>) =>
  (await installed.query("select kernel_data_query($1::jsonb) as result", [JSON.stringify(value)]))
    .rows[0]!.result;

beforeAll(async () => {
  try {
    await admin.query("select 1");
  } catch {
    throw new Error(
      "Data-plane tests require local PostgreSQL. Run `mise run test:data-plane` for an owned fixture or configure DATA_PLANE_PROOF_DATABASE_URL for a disposable test database.",
    );
  }
  const release = buildGeneratedRelease("query-contract", directory, [
    "packages/schema-compiler/cue/app-manifest.cue",
    "packages/generated-app-runtime/__tests__/query-contract.cue",
  ]);
  await admin.query(`create database "${database}"`);
  databaseCreated = true;
  url.pathname = `/${database}`;
  await setupGeneratedAppLocal({
    appId: "query-contract",
    customerId: "local-demo",
    databaseUrl: url.toString(),
    releaseDirectory: release.directory,
  });
  installed = new Pool({ connectionString: url.toString() });
  capabilityRoles = (
    await installed.query<{ name: string }>(
      "select kernel_installer_capability_role(capability) as name from unnest(array['query','runtime','schema_admin','execution_owner']) capability",
    )
  ).rows.map((row) => row.name);
  const principal = (await installed.query("select session_user::text name")).rows[0].name;
  await installed.query(
    `grant "${capabilityRoles[1]}" to "${String(principal).replaceAll('"', '""')}"`,
  );
  for (const [operation, payload] of [
    ["kernel_bind_principal_scope", { capability: "runtime" }],
    [
      "kernel_bind_actor_membership",
      { actor_id: "fixture-human", actor_kind: "human", role: "fixture" },
    ],
  ] as const) {
    const result = await installed.query(`select ${operation}($1::jsonb) result`, [
      JSON.stringify({
        principal_name: principal,
        app_id: "query-contract",
        customer_id: "local-demo",
        ...payload,
      }),
    ]);
    expect(result.rows[0].result.ok).toBe(true);
  }
  await installed.query("set kernel.actor_id='fixture-human'");
  const id = randomUUID();
  const applied = (
    await installed.query("select kernel_apply_change_set($1::jsonb) as result", [
      JSON.stringify({
        app_id: "query-contract",
        customer_id: "local-demo",
        actor_id: "fixture-human",
        source_kind: "human",
        mode: "mainline",
        idempotency_key: "seed-query-contract",
        writes: [
          {
            model_id: "asset",
            new_record_id: id,
            effective_start: asOf,
            values: {
              title: { type: "text", value: "Retired enum fixture" },
            },
          },
        ],
      }),
    ])
  ).rows[0]!.result;
  expect(applied.ok).toBe(true);
  await installed.query("update asset_version set custom_fields=$1::jsonb where record_id=$2", [
    JSON.stringify([{ field_id: "state", type: "enum", value: "retired" }]),
    id,
  ]);
}, 120000);

afterAll(async () => {
  await installed?.end();
  if (databaseCreated) await admin.query(`drop database if exists "${database}"`);
  for (const role of capabilityRoles)
    await admin.query(`drop role if exists "${role.replaceAll('"', '""')}"`);
  await admin.end();
  rmSync(directory, { recursive: true, force: true });
});

test("normalizes malformed pagination envelopes after object validation", async () => {
  const malformed = [
    { limit: "five" },
    { limit: "9".repeat(200_000) },
    { limit: {} },
    { limit: 1e100 },
    { limit: -1 },
    { limit: 1.5 },
    { limit: 0 },
    { offset: "five" },
    { offset: 1e100 },
    { offset: -1 },
    { offset: 1.5 },
    { offset: 10001 },
  ];
  for (const pagination of malformed) {
    const result = await query(request(pagination));
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("contract_validation_failed");
  }
  expect((await query(request({ limit: null }))).ok).toBe(true);
  expect((await query(request({ offset: null }))).ok).toBe(true);
});

test("rejects archived custom query fields", async () => {
  const result = await query(request({ where: [{ field: "legacy", op: "eq", value: "x" }] }));
  expect(result.ok).toBe(false);
  expect(result.error.code).toBe("contract_validation_failed");
});

test("sanitizes retired custom enum values for filter, order, and grouping", async () => {
  const filtered = await query(
    request({ where: [{ field: "state", op: "eq", value: "retired" }] }),
  );
  expect(filtered).toMatchObject({ ok: true, data: [] });
  const ordered = await query(request({ order_by: [{ field: "state", direction: "asc" }] }));
  expect(ordered.ok).toBe(true);
  expect(ordered.data).toHaveLength(1);
  expect(ordered.data[0].custom_fields).toEqual([]);
  const grouped = await query(
    request({ kind: "aggregate", group_by: ["state"], metrics: [{ fn: "count" }] }),
  );
  expect(grouped).toMatchObject({
    ok: true,
    data: { groups: [{ key: [null], metrics: ["1"] }], total: { metrics: ["1"] } },
  });
});

test("rejects malformed, duplicate, retired, and count selections in PostgreSQL", async () => {
  for (const select of [[], ["title", "title"], ["missing"], ["legacy"], null, "title", [1]]) {
    const result = await query(request({ select }));
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("contract_validation_failed");
  }
  const count = await query(
    request({ kind: "aggregate", metrics: [{ fn: "count" }], select: ["title"] }),
  );
  expect(count.ok).toBe(false);
  expect(count.error.code).toBe("contract_validation_failed");
});
