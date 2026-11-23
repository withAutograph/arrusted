import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { compileApp, repositoryRoot } from "./compile";
import { migrate, rehearse } from "./migrate";
import { PgDumpRestorePoints } from "./restore-points";
import { createDataClient, type DataDefinition } from "../../packages/generated-app-runtime/data";
import { createGeneratedAppRuntime } from "../../packages/generated-app-runtime/server";

const databaseURL = process.env.KERNEL_TEST_DATABASE_URL;
const suite = databaseURL ? test : test.skip;
mkdirSync(path.join(repositoryRoot, "app/.local"), { recursive: true });
const sources = mkdtempSync(path.join(repositoryRoot, "app/.local/schema-sources-"));
const directory = mkdtempSync(path.join(tmpdir(), "schema-changes-"));
const database = `schema_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const url = new URL(databaseURL ?? "postgres://unused:unused@127.0.0.1/postgres");
const admin = new Pool({ connectionString: url.toString() });
url.pathname = `/${database}`;
const databaseUrl = url.toString();
const pool = new Pool({ connectionString: databaseUrl });
const runtimeRole = `${database}_runtime`;
const runtimeUrl = new URL(databaseUrl);
runtimeUrl.username = runtimeRole;
runtimeUrl.password = "local-test-only";
const restorePoints = new PgDumpRestorePoints({ directory: path.join(directory, "backups") });
const releases = new Map<string, string>();
let created = false;
const title = '{id: "title", label: "Title", type: "text", required: true}';
const code = '{id: "code", label: "Code", type: "text"}';
const choice =
  '{id: "status", label: "Status", type: "enum", option_set: [{id: "open", label: "Open"}]}';
function compile(name: string, fields: string, model = "", extra = "") {
  const source = path.join(sources, `${name}.cue`);
  writeFileSync(
    source,
    `package schema\nmanifest: #AppManifest & {
    app_id: "starter", customer_id: "starter", version: "${name}"
    models: [{id: "note", kind: "entity", label: "Note", ${model} fields: [${fields}]}${extra}]
  }`,
  );
  const release = compileApp({ source, outputDirectory: path.join(directory, name, "release") });
  releases.set(name, release.directory);
}
const input = (name: string) => ({
  databaseUrl,
  releaseDirectory: releases.get(name)!,
  restorePoints,
  runtimeRole,
});
const rehearsal = (name: string) =>
  rehearse({
    ...input(name),
    runtimeDatabaseUrl: runtimeUrl.href,
    productionDatabaseUrl: databaseURL!,
  });
async function operations<T>(
  name: string,
  run: (ops: ReturnType<typeof createDataClient>) => Promise<T>,
) {
  const releaseDirectory = releases.get(name)!;
  const runtime = createGeneratedAppRuntime({
    databaseUrl,
    releaseDirectory,
    appId: "starter",
    customerId: "starter",
  });
  try {
    const definition = JSON.parse(
      readFileSync(path.join(releaseDirectory, "operation-manifest.json"), "utf8"),
    ) as DataDefinition;
    return await run(
      createDataClient(
        definition,
        runtime.dataContext({ actorId: "test", sourceKind: "test", authorize: async () => {} }),
      ),
    );
  } finally {
    await runtime.close();
  }
}
beforeAll(async () => {
  if (!databaseURL) return;
  await admin.query(`create database "${database}"`);
  created = true;
  await admin.query(
    `create role "${runtimeRole}" login password 'local-test-only' nosuperuser nocreatedb nocreaterole nobypassrls`,
  );
  compile("initial", title);
  compile("optional", `${title}, ${code}, ${choice}`);
  compile(
    "required",
    `${title}, ${code.replace('type: "text"', 'type: "text", required: true')}, ${choice}`,
  );
  compile(
    "unique",
    `${title}, ${code.replace('type: "text"', 'type: "text", required: true, is_unique: true')}, ${choice}`,
  );
  compile(
    "rename",
    `${title}, ${code.replace('label: "Code"', 'name: "reference", label: "Reference"')}, ${choice.replace('label: "Open"', 'label: "Ready", aliases: ["Open"]')}`,
    'name: "memo",',
  );
  compile(
    "renamedAgain",
    `${title}, ${code.replace('label: "Code"', 'name: "reference", label: "Reference", required: true')}, ${choice.replace('label: "Open"', 'label: "Ready", aliases: ["Open"]')}`,
    'name: "memoAgain", aliases: ["memo"],',
  );
  compile("retired", title, 'name: "memoAgain", aliases: ["memo"],');
  releases.set("retiredTables", releases.get("retired")!);
  compile(
    "reusedFieldName",
    `${title}, {id: "another", name: "reference", label: "Another", type: "text"}`,
    'name: "memoAgain", aliases: ["memo"],',
  );
  compile(
    "reusedTableName",
    title,
    'name: "memoAgain", aliases: ["memo"],',
    ', {id: "another", name: "tag", kind: "entity", label: "Another", fields: [{id: "name", label: "Name", type: "text"}]}',
  );
  compile("newRequired", `${title}, {id: "new", label: "New", type: "text", required: true}`);
  compile("wrongtype", `${title}, ${code.replace('type: "text"', 'type: "number"')}`);
  compile(
    "table",
    title,
    'name: "memoAgain", aliases: ["memo"],',
    ', {id: "tag", kind: "entity", label: "Tag", fields: [{id: "name", label: "Name", type: "text", required: true}]}',
  );
  for (const [name, modifiers] of [
    ["lookup", ""],
    ["lookupRequired", ", required: true"],
    ["lookupUnique", ", required: true, is_unique: true"],
  ]) {
    compile(
      name!,
      title,
      'name: "memoAgain", aliases: ["memo"],',
      `, {id: "catalog", kind: "lookup", label: "Catalog", display_field_id: "name", fields: [{id: "name", label: "Name", type: "text", required: true}, {id: "code", label: "Code", type: "text"${modifiers}}]}`,
    );
  }
}, 360000);
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
  rmSync(sources, { recursive: true, force: true });
});

suite("optional → fill → required and unique validate actual rows and keep history", async () => {
  await migrate(input("initial"));
  const first = randomUUID(),
    second = randomUUID();
  await operations("initial", (ops) =>
    ops.apply({
      effectiveStart: "2026-01-01",
      idempotencyKey: "create",
      writes: [
        ops.note!.writes.create({ title: "One" }, { id: first }),
        ops.note!.writes.create({ title: "Two" }, { id: second }),
      ],
    }),
  );
  await migrate(input("optional"));
  await expect(rehearsal("required")).rejects.toThrow(first);
  await expect(migrate(input("required"))).rejects.toThrow(second);
  await operations("optional", (ops) =>
    ops.apply({
      effectiveStart: "2026-02-01",
      idempotencyKey: "fill",
      writes: [
        ops.note!.writes.update(first, { code: "same", status: "open" }),
        ops.note!.writes.update(second, { code: "same", status: "open" }),
      ],
    }),
  );
  await rehearsal("required");
  await expect(migrate(input("unique"))).rejects.toThrow(first);
  await expect(rehearsal("unique")).rejects.toThrow(second);
  await operations("required", (ops) =>
    ops.apply({
      effectiveStart: "2026-03-01",
      idempotencyKey: "deduplicate",
      writes: [ops.note!.writes.update(second, { code: "different" })],
    }),
  );
  await rehearsal("unique");
  expect(
    (
      await pool.query(
        "select count(*)::int as count from note_version where code is null and effective_end is not null",
      )
    ).rows[0].count,
  ).toBe(2);
  await expect(migrate(input("newRequired"))).rejects.toThrow(
    /optional field.*fill existing rows/i,
  );
  await expect(migrate(input("wrongtype"))).rejects.toThrow(/new field/i);
});

suite(
  "renames preserve aliases; archival keeps history and refuses re-adds after edits",
  async () => {
    await migrate(input("rename"));
    const rows = await operations("rename", (ops) =>
      ops.memo!.list({ asOf: "2026-04-01", select: ["id", "reference", "code", "status"] }),
    );
    expect(rows).toHaveLength(2);
    const definition = JSON.parse(
      readFileSync(path.join(releases.get("rename")!, "operation-manifest.json"), "utf8"),
    );
    expect(
      definition.models[0].fields.find((field: { id: string }) => field.id === "status").option_set,
    ).toMatchObject([{ id: "open", label: "Ready", aliases: ["Open"] }]);
    expect(rows[0]).toMatchObject({ reference: rows[0]!.code, status: "open" });
    expect(
      await operations("rename", (ops) => ops.note!.list({ asOf: "2026-04-01" })),
    ).toHaveLength(2);
    await migrate(input("renamedAgain"));
    expect(
      await operations("renamedAgain", (ops) => ops.memo!.list({ asOf: "2026-04-01" })),
    ).toHaveLength(2);
    await migrate(input("retired"));
    expect(
      (await pool.query("select count(*)::int as count from note_version where code is not null"))
        .rows[0].count,
    ).toBeGreaterThan(0);
    const [row] = await operations("retired", (ops) => ops.memoAgain!.list({ asOf: "2026-04-01" }));
    await operations("retired", (ops) =>
      ops.apply({
        effectiveStart: "2026-05-01",
        idempotencyKey: "edit-after-archive",
        writes: [ops.memoAgain!.writes.update(row!.id, { title: "Edited while archived" })],
      }),
    );
    for (const name of ["wrongtype", "renamedAgain", "reusedFieldName"]) {
      await expect(migrate(input(name))).rejects.toThrow(
        /was archived; give the new field a different name/,
      );
    }
  },
);

suite("removed tables retain data and refuse re-adds by id or name", async () => {
  await migrate(input("table"));
  await operations("table", (ops) =>
    ops.apply({
      effectiveStart: "2026-01-01",
      idempotencyKey: "tag",
      writes: [ops.tag!.writes.create({ name: "Keep" })],
    }),
  );
  await migrate(input("retiredTables"));
  expect((await pool.query("select name from tag_version")).rows).toEqual([{ name: "Keep" }]);
  for (const name of ["table", "reusedTableName"]) {
    await expect(rehearsal(name)).rejects.toThrow(
      /was archived; give the new table a different name/,
    );
  }
});

suite(
  "lookup required and unique changes validate existing rows through the same planner",
  async () => {
    await migrate(input("lookup"));
    const first = randomUUID(),
      second = randomUUID();
    await operations("lookup", (ops) =>
      ops.apply({
        effectiveStart: "2026-01-01",
        idempotencyKey: "lookup-create",
        writes: [
          ops.catalog!.writes.create({ name: "First" }, { id: first }),
          ops.catalog!.writes.create({ name: "Second" }, { id: second }),
        ],
      }),
    );
    await expect(rehearsal("lookupRequired")).rejects.toThrow(first);
    await operations("lookup", (ops) =>
      ops.apply({
        effectiveStart: "2026-02-01",
        idempotencyKey: "lookup-fill",
        writes: [
          ops.catalog!.writes.update(first, { code: "same" }),
          ops.catalog!.writes.update(second, { code: "same" }),
        ],
      }),
    );
    await rehearsal("lookupRequired");
    await expect(migrate(input("lookupUnique"))).rejects.toThrow(second);
    await operations("lookupRequired", (ops) =>
      ops.apply({
        effectiveStart: "2026-03-01",
        idempotencyKey: "lookup-deduplicate",
        writes: [ops.catalog!.writes.update(second, { code: "different" })],
      }),
    );
    await rehearsal("lookupUnique");
  },
);

suite(
  "identical source and path can return after a field addition, preserving archived values",
  async () => {
    compile("roundtrip", title, 'name: "memoAgain", aliases: ["memo"],');
    const source = path.join(sources, "roundtrip.cue");
    const originalSource = readFileSync(source, "utf8");
    const originalArtifact = readFileSync(
      path.join(releases.get("roundtrip")!, "app-artifact.json"),
      "utf8",
    );
    expect((await migrate(input("roundtrip"))).applied).toBe(true);
    compile(
      "roundtrip",
      `${title}, {id: "scratch", label: "Scratch", type: "text"}`,
      'name: "memoAgain", aliases: ["memo"],',
    );
    expect((await migrate(input("roundtrip"))).applied).toBe(true);
    await operations("roundtrip", (ops) =>
      ops.apply({
        effectiveStart: "2026-06-01",
        idempotencyKey: "roundtrip-value",
        writes: [ops.memoAgain!.writes.create({ title: "Round trip", scratch: "Keep archived" })],
      }),
    );
    compile("roundtrip", title, 'name: "memoAgain", aliases: ["memo"],');
    expect(readFileSync(source, "utf8")).toBe(originalSource);
    expect(readFileSync(path.join(releases.get("roundtrip")!, "app-artifact.json"), "utf8")).toBe(
      originalArtifact,
    );
    expect((await migrate(input("roundtrip"))).applied).toBe(true);
    expect((await migrate(input("roundtrip"))).applied).toBe(false);
    expect(
      (await pool.query("select scratch from note_version where scratch is not null")).rows,
    ).toEqual([{ scratch: "Keep archived" }]);
    expect(
      await operations("roundtrip", (ops) => ops.memoAgain!.list({ asOf: "2026-06-01" })),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ title: "Round trip" })]));
    const applied = (
      await pool.query(
        "select release_hash from autograph_applied_schema order by applied_at desc limit 3",
      )
    ).rows;
    expect(applied).toHaveLength(3);
    expect(applied[0].release_hash).toBe(applied[2].release_hash);
    expect(applied[0].release_hash).not.toBe(applied[1].release_hash);
    compile(
      "roundtrip",
      `${title}, {id: "scratch", label: "Scratch", type: "text"}`,
      'name: "memoAgain", aliases: ["memo"],',
    );
    await expect(migrate(input("roundtrip"))).rejects.toThrow(/was archived/);
  },
);
