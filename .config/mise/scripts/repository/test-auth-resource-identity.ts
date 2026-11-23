import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { Pool } from "pg";
import { createAuthPool } from "../../../../packages/auth/server";
import {
  REQUIRED_AUTH_TABLES,
  verifyAuthDatabaseResource,
  type AuthDatabaseResource,
} from "../../../../packages/auth/database-resource";

// Owned disposable cluster only; never consumes a configured database URL.
const directory = await mkdtemp(path.join(tmpdir(), "auth-resource-test-"));
const data = path.join(directory, "postgres");
const password = crypto.randomUUID();
const passwordFile = path.join(directory, "password");
const port = await new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture port");
    server.close((error) => (error ? reject(error) : resolve(address.port)));
  });
});
function command(name: string, args: string[]) {
  const result = spawnSync(name, args, {
    encoding: "utf8",
    env: { PATH: process.env.PATH, LANG: "C", LC_ALL: "C" },
  });
  if (result.status !== 0)
    throw new Error(
      `Disposable PostgreSQL ${name} failed: ${result.error?.message ?? result.stderr}`,
    );
}
const connection = (role: string, database = "auth_store") =>
  `postgres://${role}:${password}@127.0.0.1:${port}/${database}?sslmode=disable`;
const resource: AuthDatabaseResource = {
  version: 1,
  environment: "local",
  hostname: "127.0.0.1",
  port,
  database: "auth_store",
  schema: "public",
  runtimeRole: "auth_runtime",
  migratorRole: "auth_migrator",
};
let started = false;
let admin: Pool | undefined;
let owner: Pool | undefined;
let checks = 0;
async function rejected(category: string) {
  const pool = createAuthPool(connection("auth_runtime"), resource);
  try {
    await assert.rejects(
      pool.query(`insert into public.session values ('must-not-write')`),
      new RegExp(category),
    );
    checks++;
  } finally {
    await pool.end();
  }
}
try {
  await writeFile(passwordFile, password, { mode: 0o600 });
  command("initdb", [
    "-D",
    data,
    "--username=postgres",
    "--auth=scram-sha-256",
    `--pwfile=${passwordFile}`,
    "--no-locale",
    "--encoding=UTF8",
  ]);
  command("pg_ctl", [
    "-D",
    data,
    "-l",
    path.join(directory, "postgres.log"),
    "-o",
    `-h 127.0.0.1 -p ${port} -k ${directory}`,
    "-w",
    "start",
  ]);
  started = true;
  admin = new Pool({ connectionString: connection("postgres", "postgres"), max: 1 });
  await admin.query(
    `create role auth_migrator login password '${password}'; create role auth_runtime login password '${password}'; create role inherited_capability; create role neon_superuser;`,
  );
  await admin.query("create database auth_store owner auth_migrator");
  owner = new Pool({ connectionString: connection("auth_migrator"), max: 1 });
  await owner.query("revoke create on schema public from public");
  // Migrator can reach an empty, correct store; runtime cannot serve it.
  const migrator = createAuthPool(connection("auth_migrator"), resource, "migrator");
  await migrator.query("select 1");
  await migrator.end();
  checks++;
  await rejected("required Auth table missing");
  for (const name of REQUIRED_AUTH_TABLES)
    await owner.query(`create table public."${name}" (id text primary key)`);
  await owner.query(
    `insert into public."user" values ('existing-user'); insert into public.session values ('existing-session'); grant select on all tables in schema public to auth_runtime; grant insert on public.session to auth_runtime`,
  );
  const runtime = createAuthPool(connection("auth_runtime"), resource);
  assert.deepEqual((await runtime.query("select id from public.session")).rows, [
    { id: "existing-session" },
  ]);
  checks++;
  const client = await runtime.connect();
  await assert.rejects(
    verifyAuthDatabaseResource(client, { ...resource, database: "wrong" }, "runtime"),
    /database\/schema\/role mismatch/u,
  );
  checks++;
  client.release();
  await runtime.end();

  await admin.query("alter role auth_runtime set search_path=pg_catalog");
  await rejected("database/schema/role mismatch");
  await admin.query("alter role auth_runtime reset search_path");
  await admin.query("alter role auth_runtime createdb");
  await rejected("elevated runtime capability");
  await admin.query("alter role auth_runtime nocreatedb");
  await owner.query("grant create on database auth_store to public");
  await rejected("elevated runtime capability");
  await owner.query("revoke create on database auth_store from public");
  await admin.query(
    "grant neon_superuser to inherited_capability; grant inherited_capability to auth_runtime",
  );
  await rejected("elevated runtime capability");
  await admin.query(
    "revoke inherited_capability from auth_runtime; revoke neon_superuser from inherited_capability",
  );
  await admin.query("grant auth_migrator to auth_runtime");
  await rejected("elevated runtime capability");
  await admin.query("revoke auth_migrator from auth_runtime");
  await owner.query("grant create on schema public to auth_runtime");
  await rejected("elevated runtime capability");
  await owner.query("revoke create on schema public from auth_runtime");
  await owner.query("grant create on schema public to public");
  await rejected("elevated runtime capability");
  await owner.query("revoke create on schema public from public");
  await owner.query("grant update(id) on public.app_actor_assignment to auth_runtime");
  await rejected("runtime can mutate operator-owned Auth records");
  await owner.query("revoke update(id) on public.app_actor_assignment from auth_runtime");
  await owner.query("grant update on public.app_actor_assignment to public");
  await rejected("runtime can mutate operator-owned Auth records");
  await owner.query("revoke update on public.app_actor_assignment from public");
  await owner.query("grant update(id) on public.app_actor_assignment to public");
  await rejected("runtime can mutate operator-owned Auth records");
  await owner.query("revoke update(id) on public.app_actor_assignment from public");
  await admin.query(
    "alter role auth_runtime noinherit; grant inherited_capability to auth_runtime",
  );
  await owner.query("grant update(id) on public.app_actor_assignment to inherited_capability");
  await rejected("runtime can mutate operator-owned Auth records");
  await owner.query("revoke update(id) on public.app_actor_assignment from inherited_capability");
  await admin.query(
    "revoke inherited_capability from auth_runtime; alter role auth_runtime inherit",
  );
  await owner.query("alter table public.verification rename to missing_verification");
  await rejected("required Auth table missing");
  await owner.query("alter table public.missing_verification rename to verification");
  assert.deepEqual((await owner.query("select id from public.session")).rows, [
    { id: "existing-session" },
  ]);
  checks++;
  assert.deepEqual((await owner.query('select id from public."user"')).rows, [
    { id: "existing-user" },
  ]);
  checks++;
  const restarted = createAuthPool(connection("auth_runtime"), resource);
  await restarted.query("select 1");
  await restarted.end();
  checks++;
  console.log(
    `Auth resource identity: ${checks} disposable PostgreSQL checks passed; existing fixture user/session rows preserved; no hosted proof.`,
  );
} finally {
  await owner?.end();
  await admin?.end();
  if (started) command("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
  await rm(directory, { recursive: true, force: true });
}
