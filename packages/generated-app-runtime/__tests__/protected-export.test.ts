import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { z } from "zod";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import {
  parseTenantExportManifestForWorker,
  tenantExportArtifactManifestSchema,
  type TenantExportWorkerInput,
} from "../protected-export-contract";

const tenantExportSpoolRoot = "/tmp/autograph-tenant-export";
const tenantExportInputRoot = "/tmp/autograph-tenant-export-input";
const tenantExportChunkBytes = 65_536;
const tenantExportCredentialEnvironment = "AUTOGRAPH_TENANT_EXPORT_APP_MIGRATOR_URL";
const tenantExportSpoolDirectory = (value: TenantExportWorkerInput) =>
  path.join(tenantExportSpoolRoot, value.exportId, value.attemptId);
const tenantExportInputPath = (value: TenantExportWorkerInput) =>
  path.join(tenantExportInputRoot, value.exportId, `${value.attemptId}.json`);
const tenantExportWorkerResultSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("tenant-export-worker-result"),
  state: z.literal("complete"),
  exportId: z.uuid(),
  attemptId: z.uuid(),
  snapshotId: z.uuid(),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  rowCount: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
  byteLength: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
});
const root = path.resolve(import.meta.dirname, "../../..");
const runWorker = (args: string[], value: unknown, credential: string) =>
  spawnSync(
    "bun",
    [path.join(root, "packages/generated-app-runtime/protected-installer-worker.ts"), ...args],
    {
      cwd: root,
      encoding: "utf8",
      input: JSON.stringify(value),
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH,
        [tenantExportCredentialEnvironment]: credential,
      },
    },
  );
async function exportProtectedTenant(value: TenantExportWorkerInput, credential: string) {
  const result = runWorker(["protected-generated-app-export"], value, credential);
  if (result.status !== 0) throw new Error("controlled_export_worker_failed");
  expect(result.stderr).toBe("");
  return tenantExportWorkerResultSchema.parse(JSON.parse(result.stdout));
}
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const attempts: TenantExportWorkerInput[] = [];
let scratch: string;
let databaseUrl: string;
let admin: Client;
let pgdata: string;
let started = false;
let port: number;
const database = "tenant_export_fixture";
const migrator = "tenant_export_migrator";
const runtime = "tenant_export_runtime";
const app = "orchard";
const customer = "tenant-a";
const artifact = "a".repeat(64);
const release = "selected-release-from-prepared-install";

const command = (name: string, args: string[]) => {
  const result = spawnSync(name, args, { encoding: "utf8", cwd: root });
  if (result.status !== 0) throw new Error(`Owned export fixture ${name} failed`);
};

function input(customerId = customer): TenantExportWorkerInput {
  const value: TenantExportWorkerInput = {
    version: 1,
    kind: "tenant-export-worker",
    exportId: randomUUID(),
    attemptId: randomUUID(),
    snapshotId: randomUUID(),
    planDigest: "d".repeat(64),
    scope: { appId: app, customerId },
    resource: {
      projectId: "controlled-project",
      branchId: "controlled-branch",
      resourceId: "controlled-resource",
      environment: "local",
      hostname: "127.0.0.1",
      port,
      database,
      schema: "public",
      migratorRole: migrator,
      runtimeRole: runtime,
    },
    release: {
      id: release,
      artifactHash: artifact,
      manifestRef: `_protected-operator/artifacts/generated-release/${app}/${"b".repeat(64)}`,
      manifestSha256: "c".repeat(64),
    },
    selection: "public-app-customer-tables-v1",
    format: "ndjson",
  };
  attempts.push(value);
  return value;
}

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "protected-export-fixture-"));
  pgdata = path.join(scratch, "postgres");
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Fixture port unavailable");
  port = address.port;
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  command("initdb", ["-D", pgdata, "--auth=trust", "--username=fixture_root"]);
  command("pg_ctl", [
    "-D",
    pgdata,
    "-l",
    path.join(scratch, "postgres.log"),
    "-o",
    `-h 127.0.0.1 -p ${port} -k ${scratch}`,
    "-w",
    "start",
  ]);
  started = true;
  const control = new Client({
    connectionString: `postgresql://fixture_root@127.0.0.1:${port}/postgres`,
  });
  await control.connect();
  try {
    await control.query(`create role ${migrator} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
      create role ${runtime} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
    await control.query(`create database ${database} owner ${migrator}`);
  } finally {
    await control.end();
  }
  admin = new Client({
    connectionString: `postgresql://fixture_root@127.0.0.1:${port}/${database}`,
  });
  await admin.connect();
  databaseUrl = `postgresql://${migrator}:synthetic-fixture-password@127.0.0.1:${port}/${database}?sslmode=disable`;
  await admin.query(`set role ${migrator};
    create table schema_revision(id bigint primary key, app_id text, customer_id text, version text, activated_at timestamptz, materialized_at timestamptz);
    create table schema_installation_revision(schema_revision_id bigint, app_id text, customer_id text, release_id text, activation_kind text, base_artifact_hash text, effective_artifact_hash text, ready_at timestamptz, activated_at timestamptz);
    create table opaque_business(app_id text, customer_id text, id integer, payload jsonb);
    create table empty_business(app_id text, customer_id text, id integer);
    create table "odd table""name"(app_id text, customer_id text, payload text);
    create table partitioned_business(app_id text, customer_id text, id integer) partition by range(id);
    create table partitioned_child partition of partitioned_business for values from(0)to(100);
    create table unrelated_infrastructure(secret text);
    reset role;`);
  for (const table of [
    "schema_revision",
    "schema_installation_revision",
    "opaque_business",
    "empty_business",
    "partitioned_business",
    "partitioned_child",
  ]) {
    await admin.query(
      `alter table ${table} enable row level security; alter table ${table} force row level security`,
    );
    // The intentionally permissive business policy proves explicit predicates independently.
    await admin.query(
      `create policy tenant_read on ${table} for select using(${table === "opaque_business" ? "true" : "app_id=current_setting('kernel.app_id',true) and customer_id=current_setting('kernel.customer_id',true)"})`,
    );
  }
  await admin.query(
    `insert into schema_revision values
    (1,'orchard','tenant-a',$1,now(),now()),(2,'orchard','tenant-b',$1,now(),now()),(3,'other-app','tenant-a',$1,now(),now()),(4,'orchard','empty-tenant',$1,now(),now());
    `,
    [release],
  );
  await admin.query(
    `insert into schema_installation_revision select id,app_id,customer_id,version,'app_base',$1,$1,now(),now() from schema_revision`,
    [artifact],
  );
  await admin.query(`insert into opaque_business select 'orchard','tenant-a',n,jsonb_build_object('text','postgres://business-value token=ordinary cookie password https://example.invalid', 'unicode','🍐', 'large',repeat('q',150)) from generate_series(1,1203)n;
    insert into opaque_business values('orchard','tenant-b',9999,'{"secret":"foreign-tenant"}'),('other-app','tenant-a',9998,'{"secret":"foreign-app"}');
    insert into "odd table""name" values('orchard','tenant-a','quoted table'),('other-app','tenant-a','foreign');
    insert into partitioned_business values('orchard','tenant-a',1),('orchard','tenant-b',2);
    insert into unrelated_infrastructure values('not part of export');`);
});

afterAll(async () => {
  await admin?.end();
  if (started) command("pg_ctl", ["-D", pgdata, "-m", "fast", "-w", "stop"]);
  for (const attempt of attempts)
    await rm(path.join(tenantExportSpoolRoot, attempt.exportId), { recursive: true, force: true });
  for (const attempt of attempts)
    await rm(path.join(tenantExportInputRoot, attempt.exportId), { recursive: true, force: true });
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

async function manifest(metadata: TenantExportWorkerInput) {
  const directory = tenantExportSpoolDirectory(metadata);
  const bytes = await readFile(path.join(directory, "manifest.json"));
  const value = tenantExportArtifactManifestSchema.parse(JSON.parse(bytes.toString("utf8")));
  return { bytes, value: parseTenantExportManifestForWorker(metadata, value), directory };
}

test("exports only the approved app/customer with exact selected installation, streaming chunks and opaque bytes", async () => {
  const metadata = input();
  const result = await exportProtectedTenant(metadata, databaseUrl);
  expect(tenantExportWorkerResultSchema.parse(result)).toEqual(result);
  const { bytes, value, directory } = await manifest(metadata);
  expect(result.manifestSha256).toBe(hash(bytes));
  expect(value.release.id).toBe(release);
  expect(value.files.map((file) => file.table.name)).toEqual([
    "empty_business",
    'odd table"name',
    "opaque_business",
    "partitioned_business",
    "partitioned_child",
    "schema_installation_revision",
    "schema_revision",
  ]);
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  expect((await stat(path.join(directory, "manifest.json"))).mode & 0o777).toBe(0o600);
  let rows = 0n;
  let total = 0n;
  for (const member of value.files) {
    const body = await readFile(path.join(directory, member.name));
    expect((await stat(path.join(directory, member.name))).mode & 0o777).toBe(0o600);
    expect(hash(body)).toBe(member.sha256);
    expect(String(body.length)).toBe(member.byteLength);
    const parsed = body.length
      ? body
          .toString("utf8")
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line) as { app_id: string; customer_id: string })
      : [];
    expect(String(parsed.length)).toBe(member.rowCount);
    expect(parsed.every((row) => row.app_id === app && row.customer_id === customer)).toBe(true);
    for (const chunk of member.chunks) {
      const fragment = body.subarray(
        chunk.index * tenantExportChunkBytes,
        (chunk.index + 1) * tenantExportChunkBytes,
      );
      expect(chunk.sha256).toBe(hash(fragment));
      expect(chunk.byteLength).toBe(String(fragment.length));
      expect(chunk.artifactRef).toBe(
        `_protected-operator/artifacts/tenant-export/${metadata.exportId}/${metadata.attemptId}/data/${chunk.sha256}`,
      );
    }
    rows += BigInt(member.rowCount);
    total += BigInt(member.byteLength);
  }
  expect(result.rowCount).toBe(String(rows));
  expect(result.byteLength).toBe(String(total));
  const business = value.files.find((member) => member.table.name === "opaque_business")!;
  expect(business.rowCount).toBe("1203");
  expect(business.chunks.length).toBeGreaterThan(1);
  const body = await readFile(path.join(directory, business.name), "utf8");
  expect(body).toContain("postgres://business-value");
  expect(body).toContain("🍐");
  expect(body).not.toContain("foreign-tenant");
  expect(body).not.toContain("foreign-app");
  const unchanged = await admin.query("select count(*)::text as count from opaque_business");
  expect(unchanged.rows[0]?.count).toBe("1205");
  await expect(exportProtectedTenant(metadata, databaseUrl)).rejects.toThrow();
  expect(await readFile(path.join(directory, "manifest.json"))).toEqual(bytes);
});

test("one repeatable-read snapshot excludes business changes committed during cursor capture", async () => {
  const metadata = input();
  const lock = 47392061;
  await admin.query(`set role ${migrator};
    create table a_snapshot_barrier(app_id text, customer_id text);
    create function export_fixture_barrier() returns boolean language plpgsql as $$begin perform pg_advisory_xact_lock(${lock}); return true; end$$;
    alter table a_snapshot_barrier enable row level security;
    alter table a_snapshot_barrier force row level security;
    create policy barrier on a_snapshot_barrier for select using(export_fixture_barrier());
    reset role;
    insert into a_snapshot_barrier values('orchard','tenant-a')`);
  await admin.query("select pg_advisory_lock($1)", [lock]);
  const child = spawn(
    "bun",
    [
      path.join(root, "packages/generated-app-runtime/protected-installer-worker.ts"),
      "protected-generated-app-export",
    ],
    {
      cwd: root,
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH,
        [tenantExportCredentialEnvironment]: databaseUrl,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let closed = false;
  let workerFailed = false;
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (value: string) => {
    stdout += value;
  });
  child.stderr.setEncoding("utf8").on("data", (value: string) => {
    stderr += value;
  });
  child.once("error", () => {
    workerFailed = true;
  });
  child.stdin.once("error", () => {
    workerFailed = true;
  });
  const completion = new Promise<number | null>((resolve) => {
    child.once("close", (code) => {
      closed = true;
      resolve(code);
    });
  });
  const waitForCompletion = async (milliseconds: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        completion,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Controlled snapshot worker did not close")),
            milliseconds,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  child.stdin.end(JSON.stringify(metadata));
  try {
    const barrierDeadline = Date.now() + 30_000;
    for (;;) {
      if (workerFailed || closed)
        throw new Error("Controlled snapshot worker ended before barrier");
      if (Date.now() >= barrierDeadline)
        throw new Error("Controlled snapshot barrier was not reached");
      const waiting = await admin.query(
        "select 1 from pg_stat_activity where datname=$1 and usename=$2 and wait_event_type='Lock' and wait_event='advisory'",
        [database, migrator],
      );
      if (waiting.rows.length) break;
      await delay(25);
    }
    await admin.query(
      'update opaque_business set payload=\'{"text":"committed-after-snapshot"}\' where app_id=$1 and customer_id=$2 and id=1',
      [app, customer],
    );
    await admin.query(
      'insert into opaque_business values($1,$2,1204,\'{"text":"new-after-snapshot"}\')',
      [app, customer],
    );
    await admin.query("select pg_advisory_unlock($1)", [lock]);
    expect(await waitForCompletion(30_000)).toBe(0);
    expect(stderr).toBe("");
    tenantExportWorkerResultSchema.parse(JSON.parse(stdout));
    const { value, directory } = await manifest(metadata);
    const member = value.files.find((file) => file.table.name === "opaque_business")!;
    expect(member.rowCount).toBe("1203");
    const body = await readFile(path.join(directory, member.name), "utf8");
    expect(body).not.toContain("committed-after-snapshot");
    expect(body).not.toContain("new-after-snapshot");
    expect(
      (await admin.query("select count(*)::text as count from opaque_business")).rows[0]?.count,
    ).toBe("1206");
  } finally {
    try {
      await admin.query("select pg_advisory_unlock($1)", [lock]);
    } finally {
      // Only this fixture's child is terminated; never another worker or process group.
      if (!closed) child.kill("SIGKILL");
      await waitForCompletion(5_000);
      await admin.query("drop table a_snapshot_barrier; drop function export_fixture_barrier()");
    }
  }
});

test("read-only capture refuses a policy write, preserves source data and never publishes a partial manifest", async () => {
  const metadata = input();
  await admin.query(`set role ${migrator};
    create table export_fixture_write_marker(value text);
    create table zz_read_only_guard(app_id text,customer_id text);
    create function export_fixture_write() returns boolean language plpgsql as $$begin insert into export_fixture_write_marker values('forbidden-write'); return true; end$$;
    alter table zz_read_only_guard enable row level security;
    alter table zz_read_only_guard force row level security;
    create policy writing on zz_read_only_guard for select using(export_fixture_write());
    reset role;
    insert into zz_read_only_guard values('orchard','tenant-a')`);
  try {
    const failed = runWorker(["protected-generated-app-export"], metadata, databaseUrl);
    expect(failed.status).toBe(1);
    expect(failed.stdout).toBe("");
    expect(failed.stderr).toBe("tenant_export_failed\n");
    const names = await readdir(tenantExportSpoolDirectory(metadata));
    expect(names.some((name) => name.endsWith(".ndjson"))).toBe(true);
    expect(names).not.toContain("manifest.json");
    expect(
      (await admin.query("select count(*)::text as count from export_fixture_write_marker")).rows[0]
        ?.count,
    ).toBe("0");
  } finally {
    await admin.query(
      "drop table zz_read_only_guard;drop table export_fixture_write_marker;drop function export_fixture_write()",
    );
  }
});

test("empty business scope and empty members are valid, and transaction-local scope never leaks", async () => {
  const metadata = input("empty-tenant");
  await exportProtectedTenant(metadata, databaseUrl);
  const { value } = await manifest(metadata);
  for (const member of value.files.filter((file) => !file.table.name.startsWith("schema_"))) {
    expect(member.rowCount).toBe("0");
    expect(member.byteLength).toBe("0");
    expect(member.sha256).toBe(hash(Buffer.alloc(0)));
    expect(member.chunks).toEqual([]);
  }
  const other = new Client({ connectionString: databaseUrl });
  await other.connect();
  try {
    expect(
      (await other.query("select count(*)::text as count from schema_revision")).rows[0]?.count,
    ).toBe("0");
  } finally {
    await other.end();
  }
});

test("rejects wrong resource, login, release, artifact, absent installation and symlink without a manifest", async () => {
  for (const change of [
    (value: TenantExportWorkerInput) => {
      value.resource.database = "different_database";
    },
    (value: TenantExportWorkerInput) => {
      value.resource.migratorRole = "fixture_root";
    },
    (value: TenantExportWorkerInput) => {
      value.release.id = "different-release";
    },
    (value: TenantExportWorkerInput) => {
      value.release.artifactHash = "f".repeat(64);
    },
    (value: TenantExportWorkerInput) => {
      value.scope.customerId = "missing-tenant";
    },
  ]) {
    const metadata = input();
    change(metadata);
    await expect(exportProtectedTenant(metadata, databaseUrl)).rejects.toThrow();
    expect(existsSync(path.join(tenantExportSpoolDirectory(metadata), "manifest.json"))).toBe(
      false,
    );
  }
  const metadata = input();
  await symlink(scratch, path.join(tenantExportSpoolRoot, metadata.exportId));
  await expect(exportProtectedTenant(metadata, databaseUrl)).rejects.toThrow();
  expect(existsSync(path.join(scratch, metadata.attemptId))).toBe(false);
});

test("fixed worker emits only closed metadata and redacts credentials, SQL and business failures", async () => {
  const metadata = input();
  const run = (args: string[], value: unknown, credential = databaseUrl) =>
    runWorker(args, value, credential);
  await mkdir(tenantExportInputRoot, { mode: 0o700, recursive: true });
  await mkdir(path.join(tenantExportInputRoot, metadata.exportId), { mode: 0o700 });
  await writeFile(tenantExportInputPath(metadata), JSON.stringify(metadata), {
    mode: 0o600,
    flag: "wx",
  });
  const success = run(
    ["protected-generated-app-export", "--file-spool", tenantExportInputPath(metadata)],
    null,
  );
  expect(success.status).toBe(0);
  expect(success.stderr).toBe("");
  const result = tenantExportWorkerResultSchema.parse(JSON.parse(success.stdout));
  expect(result.exportId).toBe(metadata.exportId);
  expect(success.stdout).not.toContain("payload");
  expect(success.stdout).not.toContain("synthetic-fixture-password");
  expect(success.stdout).not.toContain("postgres:");
  for (const args of [["protected-generated-app-export", "--output", scratch]]) {
    const failed = run(args, metadata);
    expect(failed.status).toBe(1);
    expect(failed.stdout).toBe("");
    expect(failed.stderr).toBe("tenant_export_failed\n");
  }
  for (const legacy of [
    "protected-generated-app-install",
    "protected-generated-app-access",
    "arbitrary-command",
  ]) {
    const failed = run([legacy], metadata);
    expect(failed.status).toBe(1);
    expect(failed.stdout).toBe("");
    expect(failed.stderr).toBe("protected_generated_app_install_failed\n");
  }
  const failed = run(
    ["protected-generated-app-export"],
    input(),
    "postgresql://credential-secret@unapproved.invalid/forbidden",
  );
  expect(failed.status).toBe(1);
  expect(failed.stdout).toBe("");
  expect(failed.stderr).toBe("tenant_export_failed\n");
});
