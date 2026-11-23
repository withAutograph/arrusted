import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { buildGeneratedRelease } from "../../.config/mise/scripts/repository/schema-release";
import { createDataClient, type DataDefinition } from "../../packages/generated-app-runtime/data";
import { createGeneratedAppRuntime } from "../../packages/generated-app-runtime/server";
import { verifyCheckedRelease } from "../../packages/generated-app-runtime/release-verification";
import { repositoryRoot } from "./compile";
import { migrate, undo } from "./migrate";
import { PgDumpRestorePoints } from "./restore-points";

const databaseURL = process.env.KERNEL_TEST_DATABASE_URL;
const suite = databaseURL ? test : test.skip;
mkdirSync(path.join(repositoryRoot, "app/.local"), { recursive: true });
const directory = mkdtempSync(path.join(repositoryRoot, "app/.local/core-upgrade-test-"));
const database = `core_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const admin = new Pool({ connectionString: databaseURL ?? "postgres://unused@127.0.0.1/postgres" });
const target = new URL(databaseURL ?? "postgres://unused@127.0.0.1/postgres");
target.pathname = `/${database}`;
const connectionString = target.toString();
const pool = new Pool({ connectionString });
const restorePoints = new PgDumpRestorePoints({ directory: path.join(directory, "backups") });
let created = false;
const releases: string[] = [];
const sha = (value: string | Buffer) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const read = (release: string, file: string) =>
  JSON.parse(readFileSync(path.join(release, file), "utf8"));
const write = (release: string, file: string, value: unknown) =>
  writeFileSync(path.join(release, file), JSON.stringify(value, null, 2) + "\n");

// This is a controlled package-upgrade fixture, not a claimed published package
// rebuild. Real compiler output supplies all schema SQL; this test-only core
// function changes between package versions without changing the app models.
function packageFixture(source: string, version: number): string {
  const release = buildGeneratedRelease(
    "starter",
    path.join(directory, `package-${version}`),
    ["packages/schema-compiler/cue/app-manifest.cue", path.relative(repositoryRoot, source)],
    repositoryRoot,
    { ...process.env, CARGO_TARGET_DIR: path.join(repositoryRoot, "target") },
    [],
    {
      schemaVersion: `core-fixture-v${version}`,
      sourcePaths: ["packages/auth/schema.sql", "packages/auth/single-organization-membership.sql"],
    },
  ).directory;
  const sql = `create or replace function kernel_fixture_package_version() returns integer language sql immutable as $$ select ${version} $$; revoke all on function kernel_fixture_package_version() from public;`;
  const manifest = read(release, "sql-manifest.json");
  // Match Rust's ChecksumPayload serialization order and verify the fixture
  // helper against the untouched compiler checksum before modifying anything.
  const checksum = () =>
    sha(
      JSON.stringify({
        format_version: manifest.format_version,
        app_id: manifest.app_id,
        customer_id: manifest.customer_id,
        version: manifest.version,
        source_checksum: manifest.source_checksum,
        constraint_expression_coverage: {
          implemented: manifest.constraint_expression_coverage.implemented,
          source_items: manifest.constraint_expression_coverage.source_items,
          implemented_items: manifest.constraint_expression_coverage.implemented_items,
          gaps: manifest.constraint_expression_coverage.gaps,
          detail: manifest.constraint_expression_coverage.detail,
        },
        runtime_api_capabilities: manifest.runtime_api_capabilities.map(
          (entry: Record<string, unknown>) => ({
            operation: entry.operation,
            sql_signatures: entry.sql_signatures,
            function_emitted: entry.function_emitted,
            behavioral_parity: entry.behavioral_parity,
            implemented: entry.implemented,
            gap: entry.gap,
          }),
        ),
        retirements: manifest.retirements.map((entry: Record<string, unknown>) => ({
          kind: entry.kind,
          model: entry.model,
          field: entry.field,
          element: entry.element,
        })),
        artifacts: manifest.artifacts.map((entry: Record<string, unknown>) => ({
          kind: entry.kind,
          name: entry.name,
          sql: entry.sql,
        })),
      }),
    );
  expect(checksum()).toBe(manifest.checksum);
  const oldChecksum = manifest.checksum;
  manifest.artifacts.push({ kind: "function", name: "kernel_fixture_package_version()", sql });
  manifest.checksum = checksum();
  write(release, "sql-manifest.json", manifest);
  write(release, "transition-plan.json", manifest);
  const bundle = readFileSync(path.join(release, "sql-bundle.sql"), "utf8")
    .replace(`-- checksum: ${oldChecksum}`, `-- checksum: ${manifest.checksum}`)
    .replace(/commit;\s*$/u, () => `-- test-owned package core function\n${sql}\n\ncommit;\n`);
  writeFileSync(path.join(release, "sql-bundle.sql"), bundle);
  const sourceMap = read(release, "cue-to-sql-source-map.json");
  sourceMap.sql_artifacts.push({
    kind: "function",
    name: "kernel_fixture_package_version()",
    origin: {
      source: path.relative(repositoryRoot, source),
      path: "fixture.package_version",
      kind: "migration",
    },
  });
  write(release, "cue-to-sql-source-map.json", sourceMap);
  const checked = read(release, "release-manifest.json");
  for (const [key, file] of Object.entries({
    sql_manifest: "sql-manifest.json",
    plan: "transition-plan.json",
    bundle: "sql-bundle.sql",
    source_map: "cue-to-sql-source-map.json",
  })) {
    checked.hashes[key] = sha(readFileSync(path.join(release, file)));
  }
  checked.installer.expected_hash = manifest.checksum;
  write(release, "release-manifest.json", checked);
  verifyCheckedRelease(release, source);
  const binary = path.join(repositoryRoot, "target/debug/schema-compiler");
  copyFileSync(binary, path.join(path.dirname(release), "schema-compiler"));
  writeFileSync(
    path.join(path.dirname(release), "build.json"),
    JSON.stringify({
      sourceCommit: `package-${version}`,
      sourceDirty: false,
      compilerBinaryHash: sha(readFileSync(binary)).slice(7),
      releaseHash: sha(readFileSync(path.join(release, "release-manifest.json"))).slice(7),
    }),
  );
  return release;
}

beforeAll(async () => {
  if (!databaseURL) return;
  await admin.query(`create database "${database}"`);
  created = true;
  const source = path.join(directory, "app.cue");
  writeFileSync(
    source,
    `package schema
manifest: #AppManifest & {
  app_id: "starter", customer_id: "starter", version: "unchanged", label: "Core fixture"
  models: [{id: "note", kind: "entity", label: "Note", fields: [{id: "title", label: "Title", type: "text", required: true}]}]
}`,
  );
  releases.push(packageFixture(source, 1), packageFixture(source, 2));
}, 120000);

afterAll(async () => {
  await pool.end();
  if (created) {
    const roles = (
      await admin.query("select rolname from pg_roles where starts_with(rolname,$1)", [
        `${database}_`,
      ])
    ).rows;
    await admin.query(`drop database "${database}" with (force)`);
    for (const { rolname } of roles)
      await admin.query(`drop role "${String(rolname).replaceAll('"', '""')}"`);
  }
  await admin.end();
  rmSync(directory, { recursive: true, force: true });
});

async function operations<T>(
  releaseDirectory: string,
  run: (client: ReturnType<typeof createDataClient>) => Promise<T>,
): Promise<T> {
  const runtime = createGeneratedAppRuntime({
    databaseUrl: connectionString,
    releaseDirectory,
    appId: "starter",
    customerId: "starter",
  });
  try {
    return await run(
      createDataClient(
        read(releaseDirectory, "operation-manifest.json") as DataDefinition,
        runtime.dataContext({ actorId: "test", sourceKind: "test", authorize: async () => {} }),
      ),
    );
  } finally {
    await runtime.close();
  }
}

suite(
  "package SQL upgrade preserves app rows; undo restores core SQL, rows and applied record",
  async () => {
    const input = (index: number) => ({
      databaseUrl: connectionString,
      releaseDirectory: releases[index]!,
      restorePoints,
      sourceCommit: `package-${index + 1}`,
      sourceDirty: false,
    });
    expect(read(releases[0]!, "app-artifact.json").schema.models).toEqual(
      read(releases[1]!, "app-artifact.json").schema.models,
    );
    await migrate(input(0));
    expect(
      (await pool.query("select kernel_fixture_package_version() as version")).rows[0].version,
    ).toBe(1);
    await operations(releases[0]!, async (ops) => {
      await ops.apply({
        effectiveStart: "2026-01-01",
        idempotencyKey: "before-upgrade",
        writes: [ops.note!.writes.create({ title: "Before upgrade" })],
      });
    });
    await migrate(input(1));
    expect(
      (await pool.query("select kernel_fixture_package_version() as version")).rows[0].version,
    ).toBe(2);
    expect(
      await operations(releases[1]!, (ops) => ops.note!.list({ asOf: "2026-11-18" })),
    ).toMatchObject([{ title: "Before upgrade" }]);
    const applied = (
      await pool.query(
        "select source_commit, restore_point from autograph_applied_schema order by applied_at",
      )
    ).rows;
    expect(applied).toHaveLength(2);
    expect(applied[1].source_commit).toBe("package-2");
    expect(applied[1].restore_point).toMatchObject({ kind: "pg_dump" });
    expect(readFileSync(applied[1].restore_point.path).length).toBeGreaterThan(0);
    await operations(releases[1]!, async (ops) => {
      await ops.apply({
        effectiveStart: "2026-01-01",
        idempotencyKey: "after-upgrade",
        writes: [ops.note!.writes.create({ title: "After upgrade" })],
      });
    });
    expect((await migrate(input(1))).applied).toBe(false);
    expect(await undo(input(1))).toMatchObject({ sourceCommit: "package-1" });
    expect(
      (await pool.query("select kernel_fixture_package_version() as version")).rows[0].version,
    ).toBe(1);
    expect((await pool.query("select source_commit from autograph_applied_schema")).rows).toEqual([
      { source_commit: "package-1" },
    ]);
    expect(
      await operations(releases[0]!, (ops) => ops.note!.list({ asOf: "2026-11-18" })),
    ).toMatchObject([{ title: "Before upgrade" }]);
    expect(await operations(releases[0]!, (ops) => ops.note!.count({ asOf: "2026-11-18" }))).toBe(
      "1",
    );
  },
  120000,
);
