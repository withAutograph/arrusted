// Owned-PostgreSQL fixture for the work-session acceptance tests: a private
// cluster (or an explicitly supplied loopback test server), test-owned generated
// apps, and the human and agent contexts over them. Never uses an app database.
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { createPostgresDataContext } from "@autograph/generated-app-runtime/postgres";
import { setupGeneratedAppLocal } from "@autograph/generated-app-runtime/server";
import type { DataDefinition } from "@autograph/generated-app-runtime/data";
import {
  createPrincipalSigner,
  createPrincipalVerifier,
  PRINCIPAL_HEADER,
} from "../../platform-microfrontends/src/policy/identity";
import { createVerifiedAgentDataContext } from "../../platform-microfrontends/src/policy/verified-data-context";
import { buildGeneratedRelease } from "../../../.config/mise/scripts/repository/schema-release";

const root = path.resolve(import.meta.dirname, "../../..");
const keys = generateKeyPairSync("ed25519");
const signer = createPrincipalSigner({
  issuer: "https://fixture.example",
  keyId: "fixture",
  privateKey: keys.privateKey,
});
const verifier = createPrincipalVerifier({
  issuer: "https://fixture.example",
  keyId: "fixture",
  publicKey: keys.publicKey,
});
const password = `fixture-${randomUUID()}`;
let scratch = "";
// Release sources live under the ignored repository scratch so generated
// clients resolve the workspace runtime.
const releases = path.join(root, ".scratch", `work-session-tools-${randomUUID()}`);
let port = 0;
let started = false;
let externalCluster: URL | undefined;
const databases: string[] = [];
const pools: Pool[] = [];

function command(name: string, args: string[]) {
  const result = spawnSync(name, args, {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
  });
  // A missing binary or spawn failure surfaces as `error`, not a status.
  if (result.error !== undefined)
    throw new Error(`Owned PostgreSQL fixture could not run ${name}: ${result.error.message}`, {
      cause: result.error,
    });
  if (result.status !== 0)
    throw new Error(
      `Owned PostgreSQL fixture command failed: ${name} (status ${String(result.status)}, signal ${String(result.signal)}): ${result.stderr}`,
    );
}
const url = (role: string, database: string, secret = password) => {
  if (!externalCluster)
    return `postgresql://${role}:${encodeURIComponent(secret)}@127.0.0.1:${port}/${database}?sslmode=disable`;
  const target = new URL(externalCluster);
  target.pathname = `/${database}`;
  if (role !== "postgres") {
    target.username = role;
    target.password = secret;
  }
  return target.href;
};

/** Starts the private cluster on a free port. */
export async function startPostgres() {
  const supplied = process.env.WORK_SESSION_TEST_DATABASE_URL;
  if (supplied) {
    const target = new URL(supplied);
    if (
      !["postgres:", "postgresql:"].includes(target.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)
    )
      throw new Error("Work-session fixtures require a loopback test server");
    // Ignore connection query overrides (host/service/options): this fixture only owns loopback DBs.
    target.search = "";
    target.hash = "";
    target.hostname = "127.0.0.1";
    target.searchParams.set("sslmode", "disable");
    externalCluster = target;
    port = Number(target.port || 5432);
    return;
  }
  scratch = await mkdtemp(path.join(tmpdir(), "work-session-tools-"));
  port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string")
        return reject(new Error("fixture port unavailable"));
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
  const data = path.join(scratch, "data");
  await writeFile(path.join(scratch, "pwfile"), password);
  command("initdb", [
    "-D",
    data,
    "-U",
    "postgres",
    "--auth=scram-sha-256",
    `--pwfile=${path.join(scratch, "pwfile")}`,
    "--no-locale",
    "--encoding=UTF8",
  ]);
  command("pg_ctl", [
    "-D",
    data,
    "-l",
    path.join(scratch, "pg.log"),
    "-o",
    `-h 127.0.0.1 -p ${port} -k ${scratch}`,
    "-w",
    "start",
  ]);
  started = true;
}

/** Closes every pool, stops the cluster and removes its files. */
export async function stopPostgres() {
  for (const pool of pools) await pool.end().catch(() => {});
  if (externalCluster) {
    const admin = new Pool({ connectionString: externalCluster.href });
    try {
      for (const database of databases) {
        const roles = (
          await admin.query("select rolname from pg_roles where starts_with(rolname,$1)", [
            `${database}_`,
          ])
        ).rows;
        await admin.query(`drop database "${database}" with (force)`);
        for (const { rolname } of roles)
          await admin.query(`drop role "${String(rolname).replaceAll('"', '""')}"`);
      }
    } finally {
      await admin.end();
    }
  }
  if (started) command("pg_ctl", ["-D", path.join(scratch, "data"), "-m", "fast", "-w", "stop"]);
  if (scratch) await rm(scratch, { recursive: true, force: true });
  await rm(releases, { recursive: true, force: true });
}

const cue = (app: string, policy: boolean) => `package schema
manifest: #AppManifest & {
 app_id: "${app}", customer_id: "tenant", version: "${app}-v1"
 models: [{id:"item",label:"Item",kind:"entity",fields:[
  {id:"owner",label:"Owner",type:"text",required:true},
  {id:"score",label:"Score",type:"number"},
  {id:"phase",label:"Phase",type:"enum",option_set:[{id:"draft",label:"Draft"},{id:"done",label:"Done"}]},
 ]}]
${
  policy
    ? ` authorization: {
  roles:[{id:"editor",label:"Editor"}]
  grants:[{role:"editor",model:"item",operations:["read","create","update","history"],read_fields:["$id","$version","owner","score","phase"],write_fields:["owner","score","phase"],record:{kind:"all"}}]
 }`
    : ""
}
 seed_change_sets: []
}
`;

/** Compiles a test-owned app and returns its release directory and generated definition. */
async function compile(app: string, policy: boolean) {
  const source = path.join(releases, `${app}.cue`);
  await mkdir(releases, { recursive: true });
  await writeFile(source, cue(app, policy));
  const directory = buildGeneratedRelease(app, path.join(releases, app), [
    "packages/schema-compiler/cue/app-manifest.cue",
    path.relative(root, source),
  ]).directory;
  // Load the generated definition against this workspace's runtime.
  const operations = (
    await readFile(path.join(directory, "data-operations.ts"), "utf8")
  ).replaceAll(
    '"@autograph/generated-app-runtime/',
    `"${path.join(root, "packages/generated-app-runtime")}/`,
  );
  const loader = path.join(releases, `${app}-definition.ts`);
  await writeFile(loader, operations);
  const { definition } = (await import(loader)) as { definition: DataDefinition };
  return { directory, definition };
}

/** Installs a test-owned app (Item: owner, score, phase) in its own database. */
export async function install(app: string, policy: boolean) {
  const { directory, definition } = await compile(app, policy);
  const database = `${app.replaceAll("-", "_")}_${randomUUID().slice(0, 8)}`;
  const admin = new Pool({ connectionString: url("postgres", "postgres") });
  try {
    await admin.query(`create database ${database}`);
    databases.push(database);
  } finally {
    await admin.end();
  }
  await setupGeneratedAppLocal({
    appId: app,
    customerId: "tenant",
    databaseUrl: url("postgres", database),
    releaseDirectory: directory,
  });
  const owner = new Pool({ connectionString: url("postgres", database) });
  // Dropping the database at the end terminates idle connections.
  owner.on("error", () => {});
  pools.push(owner);
  const runtimeRole = `${database}_runtime`;
  const capability = (await owner.query("select kernel_installer_capability_role('runtime') role"))
    .rows[0].role as string;
  await owner.query(
    `create role ${runtimeRole} login password '${password}'; grant "${capability}" to ${runtimeRole}; grant connect on database ${database} to ${runtimeRole}; grant usage on schema public to ${runtimeRole}`,
  );
  for (const [operation, request] of [
    [
      "kernel_bind_principal_scope",
      { principal_name: runtimeRole, capability: "runtime", app_id: app, customer_id: "tenant" },
    ],
    [
      "kernel_bind_actor_membership",
      {
        principal_name: runtimeRole,
        app_id: app,
        customer_id: "tenant",
        actor_id: "person",
        actor_kind: "human",
        role: "editor",
        fence_generation: 1,
      },
    ],
  ] as const) {
    const result = (
      await owner.query(`select ${operation}($1::jsonb) result`, [JSON.stringify(request)])
    ).rows[0].result;
    assert.equal(result.ok, true, `${operation}: ${JSON.stringify(result)}`);
  }
  const runtime = new Pool({ connectionString: url(runtimeRole, database) });
  runtime.on("error", () => {});
  pools.push(runtime);
  return { app, database, definition, owner, runtime, runtimeRole, policy };
}
export type InstalledApp = Awaited<ReturnType<typeof install>>;

/** The human's ordinary context; it seeds records, creates sessions and Saves. */
export function human(app: InstalledApp) {
  return createPostgresDataContext({
    pool: app.runtime,
    appId: app.app,
    customerId: "tenant",
    actorId: "person",
    actorBinding: { role: "editor", fenceGeneration: 1 },
    sourceKind: "user",
    authorize: async () => {},
    verifyRelease: () => {},
  });
}

export function runtimeOf(app: InstalledApp) {
  return {
    databaseUrl: url(app.runtimeRole, app.database),
    database: app.database,
    hostname: "127.0.0.1",
    port,
    runtimeRole: app.runtimeRole,
    environment: "local" as const,
  };
}

/** The verified agent context for the same person; `contextForTurn` marks its writes. */
export async function agent(app: InstalledApp) {
  return await createVerifiedAgentDataContext({
    request: {
      kind: "server-request",
      headers: new Headers({
        [PRINCIPAL_HEADER]: signer.issue({
          aud: app.app,
          sub: "person",
          organizationId: "tenant",
          customerId: "tenant",
          organizationRole: "member",
          appActorGrants: [{ role: "editor", fenceGeneration: 1 }],
          // The Gateway's agent principal: an MCP agent's OAuth grant.
          agentGrant: { id: "grant-fixture", clientId: "client-fixture" },
          method: "GET",
          path: "/mcp",
          jti: randomUUID(),
        }),
      }),
      method: "GET",
      target: "/mcp",
    },
    verification: { kind: "public-key", verifier },
    scope: { appId: app.app, actorId: "person", organizationId: "tenant" },
    role: "editor",
    runtime: runtimeOf(app),
    definition: app.definition,
    authorize: async () => {},
    verifyRelease: () => {},
  });
}
