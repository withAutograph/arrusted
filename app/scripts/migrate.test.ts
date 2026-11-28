import { createWorkSessionClient } from "../../packages/generated-app-runtime/work-sessions";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { compileApp, repositoryRoot } from "./compile";
import { migrate, undo, rehearse, migrationLock } from "./migrate";
import { PgDumpRestorePoints } from "./restore-points";
import { createDataClient, type DataDefinition } from "../../packages/generated-app-runtime/data";
import { createGeneratedAppRuntime } from "../../packages/generated-app-runtime/server";

const databaseURL = process.env.KERNEL_TEST_DATABASE_URL;
const suite = databaseURL ? test : test.skip;
mkdirSync(path.join(repositoryRoot, "app/.local"), { recursive: true });
const directory = mkdtempSync(path.join(repositoryRoot, "app/.local", "migration-test-"));
const database = `spike_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const url = new URL(databaseURL ?? "postgres://unused:unused@127.0.0.1/postgres");
const admin = new Pool({ connectionString: url.toString() });
url.pathname = `/${database}`;
const connectionString = url.toString();
const runtimeRole = `${database}_runtime`;
const runtimeUrl = new URL(connectionString);
runtimeUrl.username = runtimeRole;
runtimeUrl.password = "local-test-only";
const pool = new Pool({ connectionString });
const restorePoints = new PgDumpRestorePoints({ directory: path.join(directory, "backups") });
let created = false;
const releases = new Map<string, string>();

function compile(name: string, fields: string, extraModels = "") {
  const source = path.join(directory, `${name}.cue`);
  writeFileSync(
    source,
    `package schema\nmanifest: #AppManifest & {
    app_id: "starter", customer_id: "starter", version: "test-${name}", label: "Fixture"
    models: [{id: "note", kind: "entity", label: "Note", fields: [${fields}]}${extraModels}]
  }\n`,
  );
  const release = compileApp({ source, outputDirectory: path.join(directory, name, "release") });
  releases.set(name, release.directory);
  return release.directory;
}
const title = '{id: "title", label: "Title", type: "text", required: true}';
const detail = '{id: "detail", label: "Detail", type: "text"}';
function input(name: string) {
  return {
    databaseUrl: connectionString,
    releaseDirectory: releases.get(name)!,
    restorePoints,
    sourceCommit: `source-${name}`,
    sourceDirty: false,
  };
}
async function operations<T>(
  name: string,
  run: (ops: ReturnType<typeof createDataClient>) => Promise<T>,
): Promise<T> {
  const releaseDirectory = releases.get(name)!;
  const runtime = createGeneratedAppRuntime({
    databaseUrl: connectionString,
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
async function record() {
  return (
    await pool.query("select * from autograph_applied_schema order by applied_at desc limit 1")
  ).rows[0];
}

beforeAll(async () => {
  if (!databaseURL) return;
  await admin.query(`create database "${database}"`);
  created = true;
  await admin.query(
    `create role "${runtimeRole}" login password 'local-test-only' nosuperuser nocreatedb nocreaterole nobypassrls`,
  );
  compile("initial", title);
  compile("optional", `${title}, ${detail}`);
  compile(
    "table",
    `${title}, ${detail}`,
    ', {id: "tag", kind: "entity", label: "Tag", fields: [{id: "name", label: "Name", type: "text"}]}',
  );
  compile(
    "rename",
    `${title}, {id: "detail", name: "description", label: "Description", type: "text"}`,
  );
  compile("retire", title);
  compile("wrongtype", `${title}, {id: "detail", label: "Detail", type: "number"}`);
  compile("interrupted1", `${title}, {id: "one", label: "One", type: "text"}`);
  compile("membership", `${title}, {id: "three", label: "Three", type: "text"}`);
  compile(
    "membership-next",
    `${title}, {id: "three", label: "Three", type: "text"}, {id: "four", label: "Four", type: "text"}`,
  );
  compile("interrupted2", `${title}, {id: "two", label: "Two", type: "text"}`);
}, 240000);

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

suite(
  "adds tables and optional fields, keeps rename aliases and retired data, refuses historical type changes; undo restores rows and record together",
  async () => {
    expect((await migrate(input("initial"))).applied).toBe(true);
    await operations("initial", async (ops) => {
      await ops.apply({
        effectiveStart: "2026-01-01",
        idempotencyKey: "initial-row",
        writes: [ops.note!.writes.create({ title: "Before" })],
      });
    });
    expect((await migrate(input("optional"))).applied).toBe(true);
    expect(
      await operations("optional", (ops) => ops.note!.list({ asOf: "2026-01-02" })),
    ).toMatchObject([{ title: "Before", detail: null }]);
    await operations("optional", async (ops) => {
      await ops.apply({
        effectiveStart: "2026-01-01",
        idempotencyKey: "second-row",
        writes: [ops.note!.writes.create({ title: "Preserve", detail: "Keep this data" })],
      });
    });
    await expect(
      rehearse({
        ...input("table"),
        runtimeDatabaseUrl: runtimeUrl.href,
        productionDatabaseUrl: connectionString.replace("localhost", "127.0.0.1"),
      }),
    ).rejects.toThrow(/production database/);
    await rehearse({
      ...input("table"),
      runtimeDatabaseUrl: runtimeUrl.href,
      productionDatabaseUrl: databaseURL!,
    });
    expect((await pool.query("select to_regclass('public.tag_record') as name")).rows[0].name).toBe(
      "tag_record",
    );
    await migrate({ ...input("rename"), allowRetire: true });
    const renamed = await operations("rename", (ops) =>
      ops.note!.list({ asOf: "2026-01-02", select: ["title", "description", "detail"] }),
    );
    expect(renamed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Preserve",
          description: "Keep this data",
          detail: "Keep this data",
        }),
      ]),
    );
    await expect(migrate(input("wrongtype"))).rejects.toThrow(/new field/i);
    await expect(migrate(input("retire"))).rejects.toThrow(/--allow-retire/);
    await migrate({ ...input("retire"), allowRetire: true });
    const definition = JSON.parse(
      readFileSync(path.join(releases.get("retire")!, "operation-manifest.json"), "utf8"),
    );
    expect(
      JSON.stringify(
        definition.models.find((model: { name: string }) => model.name === "note").fields,
      ),
    ).not.toContain("detail");
    expect(
      (await pool.query("select detail from note_version where detail is not null")).rows,
    ).toContainEqual({ detail: "Keep this data" });
    await expect(migrate(input("wrongtype"))).rejects.toThrow(/new field/i);
    await operations("retire", async (ops) => {
      await ops.apply({
        effectiveStart: "2026-01-01",
        idempotencyKey: "after-backup",
        writes: [ops.note!.writes.create({ title: "After backup" })],
      });
    });
    const result = await undo(input("retire"));
    expect(result.sourceCommit).toBe("source-rename");
    expect((await record()).source_commit).toBe("source-rename");
    const restored = await operations("rename", (ops) => ops.note!.list({ asOf: "2026-01-02" }));
    expect(restored).toHaveLength(2);
    expect(restored).toEqual(
      expect.arrayContaining([expect.objectContaining({ description: "Keep this data" })]),
    );
    expect((await migrate(input("rename"))).applied).toBe(false);
  },
  180000,
);

async function killAt(name: string, phase: "restored" | "applied") {
  const worker = path.join(directory, `${name}-worker.ts`);
  writeFileSync(
    worker,
    `import {migrate} from ${JSON.stringify(path.join(repositoryRoot, "app/scripts/migrate.ts"))};
    import {PgDumpRestorePoints} from ${JSON.stringify(path.join(repositoryRoot, "app/scripts/restore-points.ts"))};
    import {Pool} from 'pg';
    const pause = async () => {console.log('CHECKPOINT'); await new Promise(() => setInterval(() => {}, 1000));};
    const restores = new PgDumpRestorePoints({directory:${JSON.stringify(path.join(directory, "backups"))}});
    if (${JSON.stringify(phase)} === 'restored') {
      const create = restores.create.bind(restores);
      restores.create = async (input) => { const point = await create(input); await pause(); return point; };
    } else {
      // Test-owned instrumentation: stop after the real transaction wrote its ledger row.
      const connect = Pool.prototype.connect;
      Pool.prototype.connect = async function() {
        const client = await connect.call(this);
        const query = client.query.bind(client);
        client.query = async (...args) => {
          const result = await query(...args);
          if (typeof args[0] === 'string' && args[0].includes('insert into autograph_applied_schema')) await pause();
          return result;
        };
        return client;
      };
    }
    await migrate({databaseUrl: process.env.TEST_WORKER_DATABASE_URL!, releaseDirectory: ${JSON.stringify(releases.get(name))},
      sourceCommit: ${JSON.stringify(`source-${name}`)}, restorePoints: restores, allowRetire: true
    });`,
  );
  const child = spawn("bun", [worker], {
    env: { ...process.env, TEST_WORKER_DATABASE_URL: connectionString },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += String(chunk);
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Worker checkpoint timed out: " + errors));
    }, 60000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("CHECKPOINT")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Worker exited before checkpoint (${code}): ${errors}`));
    });
  });
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
  });
}

suite(
  "real SIGKILL after backup and after SQL apply rolls back; retry applies once",
  async () => {
    for (const [name, phase] of [
      ["interrupted1", "restored"],
      ["interrupted2", "applied"],
    ] as const) {
      const before = (await record()).id;
      await killAt(name, phase);
      expect((await record()).id).toBe(before);
      expect((await migrate({ ...input(name), allowRetire: true })).applied).toBe(true);
      expect((await migrate(input(name))).applied).toBe(false);
      expect(
        (
          await pool.query(
            "select count(*)::int as count from autograph_applied_schema where source_commit=$1",
            [`source-${name}`],
          )
        ).rows[0].count,
      ).toBe(1);
    }
  },
  180000,
);

suite(
  "concurrent migration is refused while another connection holds the advisory lock",
  async () => {
    const client = await pool.connect();
    try {
      await client.query("select pg_advisory_lock(hashtextextended($1,0))", [migrationLock]);
      await expect(migrate(input("interrupted2"))).rejects.toThrow(/Another migration/);
    } finally {
      await client.query("select pg_advisory_unlock(hashtextextended($1,0))", [migrationLock]);
      client.release();
    }
  },
);

suite(
  "Auth membership drives kernel access transactionally without granting runtime owner privileges",
  async () => {
    await migrate({ ...input("membership"), allowRetire: true });
    // A completed schema install must still repair an absent runtime binding.
    await pool.query("drop trigger if exists autograph_member_kernel on public.member");
    await pool.query("delete from kernel_principal_scope where principal_name=$1", [runtimeRole]);
    expect(
      (await migrate({ ...input("membership"), runtimeRole, authRole: runtimeRole })).applied,
    ).toBe(false);
    const runtimePool = new Pool({ connectionString: runtimeUrl.toString() });
    const releaseDirectory = releases.get("membership")!;
    const runtime = createGeneratedAppRuntime({
      databaseUrl: runtimeUrl.toString(),
      releaseDirectory,
      appId: "starter",
      customerId: "starter",
    });
    const definition = JSON.parse(
      readFileSync(path.join(releaseDirectory, "operation-manifest.json"), "utf8"),
    ) as DataDefinition;
    const operations = createDataClient(
      definition,
      runtime.dataContext({
        actorId: "member-proof",
        sourceKind: "test",
        authorize: async () => {},
      }),
    );
    try {
      await runtimePool.query(`insert into "user" (id,name,email,"emailVerified") values ('member-proof','Member','member@example.test',false);
      insert into organization (id,name,slug,"createdAt") values ('starter','Starter','starter',now());
      insert into member (id,"organizationId","userId",role,"createdAt") values ('membership-proof','starter','member-proof','member',now())`);
      expect(await operations.note!.list({ asOf: "2026-01-02" })).toHaveLength(2);
      await operations.apply({
        effectiveStart: "2026-01-01",
        idempotencyKey: "member-write",
        writes: [operations.note!.writes.create({ title: "Member write" })],
      });
      const agent = createDataClient(
        definition,
        runtime.dataContext({
          actorId: "member-proof",
          sourceKind: "agent",
          agent: { turnId: randomUUID() },
          authorize: async () => {},
        }),
      );
      await expect(
        agent.apply({
          effectiveStart: "2026-01-01",
          idempotencyKey: "forbidden-agent-write",
          writes: [agent.note!.writes.create({ title: "Forbidden" })],
        }),
      ).rejects.toThrow();
      await expect(runtimePool.query("select * from note_version")).rejects.toThrow(
        /permission denied/,
      );
      await runtimePool.query("begin");
      await runtimePool.query(`delete from member where id='membership-proof'`);
      await runtimePool.query("rollback");
      expect(await operations.note!.list({ asOf: "2026-01-02" })).toHaveLength(3);
      const sessions = createWorkSessionClient(
        runtime.dataContext({
          actorId: "member-proof",
          sourceKind: "test",
          authorize: async () => {},
        }),
        definition.schemaVersion,
      );
      expect(await sessions.request({ operation: "list" })).toEqual([]);
      await migrate({ ...input("membership-next"), runtimeRole, authRole: runtimeRole });
      await runtimePool.query(`delete from member where id='membership-proof';
        insert into "user" (id,name,email,"emailVerified") values ('new-member','New','new@example.test',false);
        insert into member (id,"organizationId","userId",role,"createdAt") values ('new-membership','starter','new-member','member',now())`);
      await undo(input("membership-next"));
      expect(
        (await pool.query("select active from kernel_actor_membership where actor_id='new-member'"))
          .rows[0].active,
      ).toBe(true);
      expect(
        (
          await pool.query(
            "select active from kernel_actor_membership where actor_id='member-proof'",
          )
        ).rows[0].active,
      ).toBe(false);
      await expect(sessions.request({ operation: "list" })).rejects.toThrow(/authoriz|bound/);
    } finally {
      await runtime.close();
      await runtimePool.end();
    }
  },
  120000,
);

suite("rehearsal requires an actual runtime connection", async () => {
  await admin.query(`alter role "${runtimeRole}" nologin`);
  try {
    await expect(
      rehearse({
        ...input("membership"),
        runtimeDatabaseUrl: runtimeUrl.href,
        productionDatabaseUrl: databaseURL!,
      }),
    ).rejects.toThrow(/not permitted to log in/);
  } finally {
    await admin.query(`alter role "${runtimeRole}" login`);
  }
});

suite("Auth checksum and users survive undoing the first app migration", async () => {
  const firstDatabase = `${database}_first`;
  const firstUrl = new URL(connectionString);
  firstUrl.pathname = `/${firstDatabase}`;
  await admin.query(`create database "${firstDatabase}"`);
  const firstPool = new Pool({ connectionString: firstUrl.href });
  const firstInput = { ...input("initial"), databaseUrl: firstUrl.href };
  try {
    await migrate(firstInput);
    await firstPool.query(
      `insert into "user" (id,name,email,"emailVerified") values ('retained','Retained','retained@example.test',false)`,
    );
    await undo(firstInput);
    expect((await firstPool.query('select id from "user"')).rows).toEqual([{ id: "retained" }]);
    expect((await migrate(firstInput)).applied).toBe(true);
    await undo(firstInput);
    await firstPool.query(`comment on table "user" is 'autograph:auth-schema:changed'`);
    await expect(migrate(firstInput)).rejects.toThrow(/retained Auth schema.*upgrade plan/);
    await firstPool.query(`comment on table "user" is null`);
    await expect(migrate(firstInput)).rejects.toThrow(/retained Auth schema.*upgrade plan/);
    expect((await firstPool.query('select id from "user"')).rows).toEqual([{ id: "retained" }]);
  } finally {
    await firstPool.end();
    const roles = (
      await admin.query("select rolname from pg_roles where starts_with(rolname,$1)", [
        `${firstDatabase}_`,
      ])
    ).rows;
    await admin.query(`drop database "${firstDatabase}" with (force)`);
    for (const { rolname } of roles)
      await admin.query(`drop role "${String(rolname).replaceAll('"', '""')}"`);
  }
});

suite("apply refuses a missing runtime URL before changing PostgreSQL", async () => {
  const before = (await pool.query("select count(*)::int count from autograph_applied_schema"))
    .rows;
  const result = spawnSync("bun", [path.join(repositoryRoot, "app/scripts/migrate.ts"), "apply"], {
    cwd: directory,
    env: {
      ...process.env,
      MIGRATION_DATABASE_URL: connectionString,
      APP_DATABASE_URL: "",
      AUTH_DATABASE_URL: "",
    },
    encoding: "utf8",
  });
  expect(result.status).toBe(1);
  expect(result.stderr.trim()).toBe(
    "APP_DATABASE_URL is required (separate restricted runtime login).",
  );
  expect(
    (await pool.query("select count(*)::int count from autograph_applied_schema")).rows,
  ).toEqual(before);
  const rehearsal = spawnSync(
    "bun",
    [path.join(repositoryRoot, "app/scripts/migrate.ts"), "rehearse"],
    {
      cwd: directory,
      env: {
        ...process.env,
        MIGRATION_DATABASE_URL: connectionString,
        APP_DATABASE_URL: runtimeUrl.href,
        AUTH_DATABASE_URL: "",
        PRODUCTION_APP_DATABASE_URL: runtimeUrl.href,
      },
      encoding: "utf8",
    },
  );
  expect(rehearsal.status).toBe(1);
  expect(rehearsal.stderr.trim()).toBe(
    "MIGRATION_DATABASE_URL must not target the production database during rehearsal.",
  );
});
