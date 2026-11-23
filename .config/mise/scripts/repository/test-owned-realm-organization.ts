import { checkNormalSignupToCompiledMembership } from "./owned-realm-normal-signup-fixture";
import { checkCompiledMembershipWorker } from "./owned-realm-membership-worker-fixture";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { Pool } from "pg";
import {
  createOwnedRealmOrganization,
  readOwnedRealmOrganization,
} from "../../../../packages/auth/owned-organization";
import type { OwnedOrganizationSpec } from "../../../../packages/auth/owned-organization";

// This acceptance owns every process/database/row; it never reads a configured provider URL.
const root = await mkdtemp(path.join(tmpdir(), "owned-realm-organization-"));
const data = path.join(root, "postgres");
const secret = randomUUID();
const passwordFile = path.join(root, "password");
await writeFile(passwordFile, secret, { mode: 0o600 });
const port = await new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture_port");
    server.close((error) => (error ? reject(error) : resolve(address.port)));
  });
});
const command = (name: string, args: string[]) => {
  const result = spawnSync(name, args, {
    encoding: "utf8",
    env: { PATH: process.env.PATH, LANG: "C", LC_ALL: "C" },
  });
  if (result.status !== 0) throw new Error(`owned_postgres_${name}_failed`);
};
const connection = (user: string, database: string) =>
  `postgres://${user}:${secret}@127.0.0.1:${port}/${database}?sslmode=disable`;
let started = false;
let admin: Pool | undefined;
let owner: Pool | undefined;
let runtime: Pool | undefined;
const resource = {
  version: 1 as const,
  environment: "local" as const,
  hostname: "127.0.0.1",
  port,
  database: "owned_auth",
  schema: "public" as const,
  runtimeRole: "auth_runtime",
  migratorRole: "auth_migrator",
};
const spec: OwnedOrganizationSpec = {
  actorId: "normal-user",
  bootstrapPlanDigest: "a".repeat(64),
  identityNonceSha256: "b".repeat(64),
  identityProof: { reference: "private-proof", sha256: "c".repeat(64) },
  identityVerification: {
    audience: "https://operator.example",
    issuer: "https://realm.example",
    jwksUrl: "https://realm.example/_platform/jwks.json",
  },
  kind: "create-owned-organization",
  name: "Approved organization",
  organizationId: "approved-org",
  slug: "approved-org",
};
let checks = 0;
try {
  command("initdb", [
    "-D",
    data,
    "-A",
    "scram-sha-256",
    "--pwfile",
    passwordFile,
    "--username",
    "fixture_admin",
    "--no-locale",
  ]);
  command("pg_ctl", [
    "-D",
    data,
    "-l",
    path.join(root, "postgres.log"),
    "-o",
    `-h 127.0.0.1 -p ${port}`,
    "-w",
    "start",
  ]);
  started = true;
  admin = new Pool({ connectionString: connection("fixture_admin", "postgres") });
  await admin.query(
    `create role auth_migrator login password '${secret}'; create role auth_runtime login password '${secret}'`,
  );
  await admin.query("create database owned_auth owner auth_migrator");
  owner = new Pool({ connectionString: connection("auth_migrator", "owned_auth") });
  runtime = new Pool({ connectionString: connection("auth_runtime", "owned_auth") });
  await owner.query(
    `create table public."user" (id text primary key); create table public.session (id text primary key,"userId" text references public."user"(id),"expiresAt" timestamptz not null); create table public.organization (id text primary key,name text,slug text unique,"createdAt" timestamptz,metadata text,"appIds" jsonb); create table public.member (id text primary key,"organizationId" text references public.organization(id),"userId" text references public."user"(id),role text,"createdAt" timestamptz, unique("organizationId","userId")); insert into public."user" values ('normal-user'),('sibling-user'); insert into public.session values ('normal-session','normal-user',now()+interval '1 hour'),('sibling-session','sibling-user',now()+interval '1 hour'); insert into public.organization values ('sibling-org','Sibling','sibling',now(),null,'["sibling-app"]'); insert into public.member values ('sibling-member','sibling-org','sibling-user','owner',now()); grant usage on schema public to auth_runtime; grant select on public."user",public.session,public.organization,public.member to auth_runtime`,
  );
  checks += await checkCompiledMembershipWorker({
    root,
    resource,
    connection: connection("auth_migrator", "owned_auth"),
    owner,
  });
  await admin.query("create database normal_auth owner auth_migrator");
  checks += await checkNormalSignupToCompiledMembership({
    root: path.join(root, "normal"),
    resource: { ...resource, database: "normal_auth" },
    connection: connection("auth_migrator", "normal_auth"),
    runtimeConnection: connection("auth_runtime", "normal_auth"),
  });
  const input = {
    resource,
    spec,
    ownerSessionId: "actual-builder-session",
    planDigest: "d".repeat(64),
    realmSessionId: "normal-session",
    assertCurrent: async () => {},
  };
  const client = await owner.connect();
  try {
    assert.equal((await createOwnedRealmOrganization({ ...input, client })).replayed, false);
    checks++;
    assert.equal((await createOwnedRealmOrganization({ ...input, client })).replayed, true);
    checks++;
    assert.deepEqual(
      (await client.query('select "appIds" from organization where id=$1', [spec.organizationId]))
        .rows[0].appIds,
      [],
    );
    checks++;
    await assert.rejects(
      createOwnedRealmOrganization({
        ...input,
        client,
        spec: { ...spec, organizationId: "sibling-org", slug: "sibling" },
      }),
      /auth_membership_required/,
    );
    checks++;
    await assert.rejects(
      createOwnedRealmOrganization({
        ...input,
        client,
        realmSessionId: "sibling-session",
        spec: { ...spec, organizationId: "wrong-session", slug: "wrong-session" },
      }),
      /auth_identity_required/,
    );
    checks++;
    await client.query(
      `insert into session values ('expired-session','normal-user',now()-interval '1 hour')`,
    );
    await assert.rejects(
      createOwnedRealmOrganization({
        ...input,
        client,
        realmSessionId: "expired-session",
        spec: { ...spec, organizationId: "expired", slug: "expired" },
      }),
      /auth_identity_required/,
    );
    checks++;
    await client.query(
      `insert into session values ('expiring-session','normal-user',clock_timestamp()+interval '300 milliseconds')`,
    );
    let expiryChecks = 0;
    await assert.rejects(
      createOwnedRealmOrganization({
        ...input,
        client,
        realmSessionId: "expiring-session",
        spec: { ...spec, organizationId: "expires-during-grant", slug: "expires-during-grant" },
        assertCurrent: async () => {
          expiryChecks++;
          if (expiryChecks === 2) await new Promise((resolve) => setTimeout(resolve, 400));
        },
      }),
      /auth_identity_required/,
    );
    assert.equal(
      (
        await client.query(
          "select count(*)::int as count from organization where id='expires-during-grant'",
        )
      ).rows[0].count,
      0,
    );
    assert.equal(expiryChecks, 2, "mid-grant expiry reached the precommit guard");
    checks += 3;
    let fenceChecks = 0;
    await assert.rejects(
      createOwnedRealmOrganization({
        ...input,
        client,
        spec: { ...spec, organizationId: "fence-denied", slug: "fence-denied" },
        assertCurrent: async () => {
          fenceChecks++;
          if (fenceChecks === 2) throw new Error("fence-revoked");
        },
      }),
      /fence-revoked/,
    );
    checks++;
    assert.equal(
      (
        await client.query("select count(*)::int as count from organization where id=$1", [
          "fence-denied",
        ])
      ).rows[0].count,
      0,
    );
    checks++;
    assert.equal(
      (await client.query("select role from member where id=$1", ["sibling-member"])).rows[0].role,
      "owner",
    );
    checks++;
    assert.equal(
      (await client.query('select count(*)::int as count from "user"')).rows[0].count,
      2,
    );
    checks++;
  } finally {
    client.release();
  }
  const writerClient = await owner.connect();
  const readClient = await owner.connect();
  let writerReady: (() => void) | undefined;
  let releaseWriter: (() => void) | undefined;
  const createdUncommitted = new Promise<void>((resolve) => {
    writerReady = resolve;
  });
  const releaseCommit = new Promise<void>((resolve) => {
    releaseWriter = resolve;
  });
  const lockedSpec = { ...spec, organizationId: "readback-race", slug: "readback-race" };
  let writerGuards = 0;
  const writer = createOwnedRealmOrganization({
    ...input,
    client: writerClient,
    spec: lockedSpec,
    assertCurrent: async () => {
      writerGuards++;
      if (writerGuards === 2) {
        writerReady?.();
        await releaseCommit;
      }
    },
  });
  let reading: ReturnType<typeof readOwnedRealmOrganization> | undefined;
  try {
    await createdUncommitted;
    const readPid = (await readClient.query("select pg_backend_pid() as pid")).rows[0].pid;
    reading = readOwnedRealmOrganization({ ...input, client: readClient, spec: lockedSpec });
    const deadline = Date.now() + 2000;
    let waiting = false;
    while (Date.now() < deadline) {
      const state = (
        await admin.query("select wait_event from pg_stat_activity where pid=$1", [readPid])
      ).rows[0];
      if (state?.wait_event === "advisory") {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true, "readback waits on the actual writer advisory lock");
    releaseWriter?.();
    const created = await writer;
    const observed = await reading;
    assert.equal(observed.status, "applied");
    assert.equal(observed.readbackSha256, created.readbackSha256);
    checks += 3;
  } finally {
    releaseWriter?.();
    await writer.catch(() => {});
    await reading?.catch(() => {});
    writerClient.release();
    readClient.release();
  }
  const grantClient = await owner.connect();
  const logoutClient = await owner.connect();
  let grantUnlock: (() => void) | undefined;
  let grantLocked: (() => void) | undefined;
  const locked = new Promise<void>((resolve) => {
    grantLocked = resolve;
  });
  const unlock = new Promise<void>((resolve) => {
    grantUnlock = resolve;
  });
  let guardCount = 0;
  const grant = createOwnedRealmOrganization({
    client: grantClient,
    resource,
    spec: { ...spec, organizationId: "race-org", slug: "race-org" },
    ownerSessionId: "actual-builder-session",
    planDigest: "d".repeat(64),
    realmSessionId: "normal-session",
    assertCurrent: async () => {
      guardCount++;
      if (guardCount === 2) {
        grantLocked?.();
        await unlock;
      }
    },
  });
  try {
    await locked;
    await logoutClient.query("set lock_timeout='100ms'");
    await assert.rejects(
      logoutClient.query("delete from session where id='normal-session'"),
      /lock timeout/,
    );
    checks++;
    grantUnlock?.();
    await grant;
    await logoutClient.query("delete from session where id='normal-session'");
    await assert.rejects(
      createOwnedRealmOrganization({
        client: grantClient,
        resource,
        spec: { ...spec, organizationId: "after-logout", slug: "after-logout" },
        ownerSessionId: "actual-builder-session",
        planDigest: "d".repeat(64),
        realmSessionId: "normal-session",
        assertCurrent: async () => {},
      }),
      /auth_identity_required/,
    );
    checks++;
  } finally {
    grantUnlock?.();
    await grant.catch(() => {});
    grantClient.release();
    logoutClient.release();
  }
  await assert.rejects(
    runtime.query(
      `insert into organization(id,name,slug) values ('runtime-org','Runtime','runtime')`,
    ),
    /permission denied/,
  );
  checks++;
  await assert.rejects(
    runtime.query(`update organization set metadata='forged' where id='approved-org'`),
    /permission denied/,
  );
  checks++;
  console.log(
    JSON.stringify({ checks, fixture: "owned-realm-organization", providerEffects: false }),
  );
} finally {
  await runtime?.end();
  await owner?.end();
  await admin?.end();
  if (started) command("pg_ctl", ["-D", data, "-w", "stop", "-m", "immediate"]);
  await rm(root, { recursive: true, force: true });
}
