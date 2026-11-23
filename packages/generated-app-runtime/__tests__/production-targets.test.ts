import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { Pool } from "pg";
import { buildGeneratedRelease } from "../../../.config/mise/scripts/repository/schema-release";

import {
  generatedAppLocalDatabaseUrl,
  installGeneratedAppProduction,
  installGeneratedAppProductionTargets,
} from "../server";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const appId = "production-targets-fixture";
const directory = mkdtempSync(path.join(tmpdir(), "production-targets-fixture-"));
let releaseDirectory: string;
const suffix = randomBytes(8).toString("hex");
const databases = [`target_batch_${suffix}`, `target_one_${suffix}`, `target_fail_${suffix}`];
const clusterUrl = new URL(
  process.env.DATA_PLANE_PROOF_DATABASE_URL ??
    generatedAppLocalDatabaseUrl({ root, appId: "production-targets-proof" }),
);
clusterUrl.pathname = "/postgres";
const admin = new Pool({ connectionString: clusterUrl.toString() });
const created: string[] = [];
const options = (database: string) => {
  const url = new URL(clusterUrl);
  url.pathname = `/${database}`;
  return {
    appId,
    databaseUrl: url.toString(),
    releaseDirectory,
  };
};

beforeAll(async () => {
  try {
    await admin.query("select 1");
  } catch (cause) {
    throw new Error(
      "PostgreSQL preflight failed. Run mise run test:data-plane to use an isolated test cluster, or start PostgreSQL and set DATA_PLANE_PROOF_DATABASE_URL to a local admin database URL with CREATE DATABASE and CREATE ROLE privileges.",
      { cause },
    );
  }
  const cue = path.join(directory, "fixture.cue");
  writeFileSync(
    cue,
    `package schema
manifest: #AppManifest & {
 app_id: "${appId}", customer_id: "fixture-template", version: "targets-v1"
 models: [{id:"item",kind:"entity",label:"Item",fields:[{id:"name",label:"Name",type:"text"}]}]
}
`,
  );
  releaseDirectory = buildGeneratedRelease(appId, directory, [
    "packages/schema-compiler/cue/app-manifest.cue",
    path.relative(root, cue),
  ]).directory;
  for (const database of databases) {
    await admin.query(`create database "${database}"`);
    created.push(database);
  }
});

afterAll(async () => {
  const failures: unknown[] = [];
  const attempt = async (query: string) => {
    try {
      await admin.query(query);
    } catch (error) {
      failures.push(error);
    }
  };
  try {
    for (const database of created) {
      await attempt(`drop database if exists "${database}" with (force)`);
      for (const capability of ["runtime", "query", "schema_admin", "execution_owner"]) {
        await attempt(`drop role if exists "${database}_public_kernel_${capability}"`);
      }
    }
  } finally {
    await admin.end();
    rmSync(directory, { recursive: true, force: true });
  }
  if (failures.length) throw new AggregateError(failures, "Target fixture cleanup failed");
});

test("a second-target preparation failure rolls back the first target and supports a clean retry", async () => {
  const input = { ...options(databases[2]!), customerIds: ["qa-a", "qa-b"] };
  const pool = new Pool({ connectionString: input.databaseUrl });
  try {
    await pool.query(readFileSync(path.join(input.releaseDirectory, "sql-bundle.sql"), "utf8"));
    await pool.query(`
      create function reject_qa_b() returns trigger language plpgsql as $$
      begin
        if NEW.customer_id = 'qa-b' then raise exception 'injected second-target failure'; end if;
        return NEW;
      end $$;
      create trigger reject_qa_b before insert on schema_revision
        for each row execute function reject_qa_b();
    `);
    await expect(installGeneratedAppProductionTargets(input)).rejects.toThrow();
    const staged = await pool.query(
      `select customer_id from schema_revision where app_id = '${appId}'`,
    );
    expect(staged.rows).toEqual([]);
    await pool.query("drop trigger reject_qa_b on schema_revision; drop function reject_qa_b()");
    await installGeneratedAppProductionTargets(input);
    expect(await activeCustomers(databases[2]!)).toEqual(["qa-a", "qa-b"]);
  } finally {
    await pool.end();
  }
}, 120000);

async function activeCustomers(database: string) {
  const pool = new Pool({ connectionString: options(database).databaseUrl });
  try {
    return (
      await pool.query<{ customer_id: string }>(
        `select customer_id from schema_revision where app_id = '${appId}' and activated_at is not null order by customer_id`,
      )
    ).rows.map((row) => row.customer_id);
  } finally {
    await pool.end();
  }
}

test("explicit targets activate together, replay together, and never silently omit a target", async () => {
  const database = databases[0]!;
  const input = { ...options(database), customerIds: ["qa-a", "qa-b"] };
  const first = await installGeneratedAppProductionTargets(input);
  expect(await activeCustomers(database)).toEqual(["qa-a", "qa-b"]);
  expect(
    await installGeneratedAppProductionTargets({ ...input, customerIds: ["qa-b", "qa-a"] }),
  ).toEqual(first);
  await expect(
    installGeneratedAppProductionTargets({ ...input, customerIds: ["qa-a"] }),
  ).rejects.toThrow("target_set_mismatch");
  expect(await activeCustomers(database)).toEqual(["qa-a", "qa-b"]);
}, 120000);

test("existing singleton installs stay idempotent and expand the approved target set atomically", async () => {
  const database = databases[1]!;
  const input = { ...options(database), customerId: "qa-a" };
  const first = await installGeneratedAppProduction(input);
  expect(await installGeneratedAppProduction(input)).toEqual(first);
  expect(await activeCustomers(database)).toEqual(["qa-a"]);
  expect(
    await installGeneratedAppProductionTargets({
      ...options(database),
      customerIds: ["qa-a", "qa-b"],
    }),
  ).toEqual(first);
  expect(await activeCustomers(database)).toEqual(["qa-a", "qa-b"]);
}, 120000);

test("empty and duplicate target sets fail before opening a database connection", async () => {
  for (const customerIds of [[], ["qa-a", "qa-a"], [" "]]) {
    await expect(
      installGeneratedAppProductionTargets({
        appId,
        databaseUrl: "invalid",
        releaseDirectory: "missing",
        customerIds,
      }),
    ).rejects.toThrow("nonempty, unique tenant set");
  }
});
