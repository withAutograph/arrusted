import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir, userInfo } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { Pool } from "pg";
import { withNormalActorReadback } from "./normal-actor-readback.js";

// Actual local PostgreSQL qualifies transport/authority; controlled SQL functions are not compiled-kernel or hosted-app proof.
const fixture = vi.hoisted(() => ({ appRuntimeUrl: "", authRuntimeUrl: "", roleless: false }));
vi.mock("./normal-actor-private-fixture.js", () => ({
  readProtectedNormalActorFixture: async () => ({
    ...fixture,
    plan: {
      version: 1,
      appId: "review",
      environment: "local",
      runtimeId: "owned-runtime",
      database: "owned_app",
      authDatabase: "owned_auth",
      principal: "app_runtime",
      authPrincipal: "auth_runtime",
      authScope: "context",
      roles: fixture.roleless ? [] : ["reviewer"],
      tenants: ["tenant-one"],
      releaseId: "release-one",
      artifactHash: `sha256:${"a".repeat(64)}`,
    },
    identity: {
      actorId: "member",
      organizationId: "tenant-one",
      roles: fixture.roleless ? [] : ["reviewer"],
      role: fixture.roleless ? null : "reviewer",
      access: "admitted",
    },
    assertCurrent: async () => {},
  }),
}));
vi.mock("@autograph/generated-app-runtime/release-verification", () => ({
  verifyCheckedRelease: () => ({
    app: "review",
    schema_version: "release-one",
    hashes: { schema: `sha256:${"a".repeat(64)}` },
  }),
}));
const tools = [
  "/Applications/Postgres.app/Contents/Versions/17/bin",
  "/opt/homebrew/opt/postgresql@17/bin",
  "/usr/lib/postgresql/17/bin",
].find((directory) => {
  try {
    return /PostgreSQL\) 17\./u.test(
      execFileSync(path.join(directory, "postgres"), ["--version"], { encoding: "utf8" }),
    );
  } catch {
    return false;
  }
});
const suite = tools ? it : it.skip;
let root: string;
let started = false;
let admin: Pool;
let appAdmin: Pool;
let authAdmin: Pool;
const input = {
  appId: "review",
  selector: { actorKey: "member", organizationId: "tenant-one" },
  baseURL: "https://owned-local-fixture.vercel.run",
};
beforeAll(async () => {
  if (!tools) return;
  root = await mkdtemp(path.join(tmpdir(), "normal-readback-pg-"));
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Owned fixture port is unavailable");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  execFileSync(
    path.join(tools, "initdb"),
    [
      "-D",
      path.join(root, "data"),
      "--auth-local=trust",
      "--auth-host=scram-sha-256",
      "--no-locale",
      "-E",
      "utf8",
    ],
    { stdio: "pipe" },
  );
  execFileSync(
    path.join(tools, "pg_ctl"),
    [
      "-D",
      path.join(root, "data"),
      "-l",
      path.join(root, "postgres.log"),
      "-o",
      `-h 127.0.0.1 -k ${root} -p ${port}`,
      "-w",
      "start",
    ],
    { stdio: "pipe" },
  );
  started = true;
  const connect = (database: string) =>
    new Pool({ host: root, port, database, user: userInfo().username, max: 1 });
  admin = connect("postgres");
  const appPassword = randomBytes(24).toString("hex"),
    authPassword = randomBytes(24).toString("hex");
  await admin.query(`create role app_runtime login password '${appPassword}' nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    create role auth_runtime login password '${authPassword}' nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
  await admin.query("create database owned_app");
  await admin.query("create database owned_auth");
  await admin.query(`comment on database owned_app is 'app-validation:owned-runtime:review';
    comment on role app_runtime is 'app-validation:owned-runtime:review';
    comment on database owned_auth is 'app-validation-context:local:owned-runtime';
    comment on role auth_runtime is 'app-validation-context:local:owned-runtime'`);
  appAdmin = connect("owned_app");
  authAdmin = connect("owned_auth");
  await authAdmin.query(`create table member("organizationId" text,"userId" text);
    create table app_actor_assignment("appId" text,"organizationId" text,"actorId" text,role text,active boolean);
    create table app_signup_policy(id integer);
    create table app_actor_access("appId" text,"organizationId" text,"actorId" text,"workspaceId" text,roles jsonb,active boolean,"fenceGeneration" bigint);
    insert into member values('tenant-one','member');
    insert into app_actor_assignment values('review','tenant-one','member','reviewer',true);
    insert into app_actor_access values('review','tenant-one','member','app-validation-context:local:owned-runtime','[]',true,4);
    grant usage on schema public to auth_runtime;
    grant select on member,app_actor_assignment,app_signup_policy,app_actor_access to auth_runtime`);
  await appAdmin.query(`create table memberships(active boolean,actor text,tenant text,role text,generation integer);
    insert into memberships values(true,'member','tenant-one','reviewer',4);
    insert into memberships values(true,'member','tenant-one',null,4);
    create table bills(id text,tenant text,status text);
    insert into bills values('bill-one','tenant-one','open');
    create function kernel_read_actor_binding(request jsonb) returns jsonb language sql security definer set search_path=public as $$
      select jsonb_build_object('ok',true,'data',(select jsonb_build_object('active',active,'actorId',actor,'appId','review','organizationId',tenant,'role',role,'fenceGeneration',generation)
      from memberships where actor=request->>'actor_id' and tenant=request->>'customer_id' and role=request->>'role')) $$;
    create function kernel_read_active_schema_revision(request jsonb) returns jsonb language sql security definer set search_path=public as $$
      select jsonb_build_object('ok',true,'data',jsonb_build_object('schema',jsonb_build_object('version','release-one'))) $$;
    create function kernel_read_actor_access(request jsonb) returns jsonb language sql security definer set search_path=public as $$
      select jsonb_build_object('ok',true,'data',(select jsonb_build_object('active',active,'actorId',actor,'appId','review','organizationId',tenant,'fenceGeneration',generation)
      from memberships where actor=request->>'actor_id' and tenant=request->>'customer_id' and role is null)) $$;
    create function kernel_read_visible_record(request jsonb) returns jsonb language sql security definer set search_path=public as $$
      select jsonb_build_object('ok',true,'data',(select jsonb_build_object('id',id,'paymentStatus',status) from bills
        where id=request->>'record_id' and tenant=request->>'customer_id' and tenant=current_setting('kernel.customer_id')
          and request->>'actor_id'=current_setting('kernel.actor_id'))) $$;
    revoke all on bills,memberships from public;
    grant usage on schema public to app_runtime;
    grant execute on function kernel_read_actor_binding(jsonb),kernel_read_actor_access(jsonb),kernel_read_active_schema_revision(jsonb),kernel_read_visible_record(jsonb) to app_runtime`);
  fixture.appRuntimeUrl = `postgresql://app_runtime:${appPassword}@127.0.0.1:${port}/owned_app`;
  fixture.authRuntimeUrl = `postgresql://auth_runtime:${authPassword}@127.0.0.1:${port}/owned_auth`;
});
afterAll(async () => {
  await Promise.all([admin?.end(), appAdmin?.end(), authAdmin?.end()]);
  if (started && tools)
    execFileSync(
      path.join(tools, "pg_ctl"),
      ["-D", path.join(root, "data"), "-m", "fast", "-w", "stop"],
      { stdio: "pipe" },
    );
  if (root) await rm(root, { recursive: true, force: true });
});
suite(
  "independently observes a persisted fixture write through a different restricted connection",
  async () => {
    await appAdmin.query("update bills set status='paid' where id='bill-one'");
    await withNormalActorReadback(input, async (context) => {
      const row = await context.transaction(
        async (session) =>
          await session.call("kernel_read_visible_record", { record_id: "bill-one" }),
      );
      expect(row).toEqual({ id: "bill-one", paymentStatus: "paid" });
      await expect(
        context.transaction(async (session) => await session.call("kernel_apply_change_set", {})),
      ).rejects.toThrow("Read-only data context");
    });
  },
);
suite("current Auth revocation denies the same fixture identity before data access", async () => {
  await authAdmin.query("update app_actor_assignment set active=false");
  let entered = false;
  await expect(
    withNormalActorReadback(input, async () => {
      entered = true;
    }),
  ).rejects.toThrow("actor_not_authorized");
  expect(entered).toBe(false);
});

suite(
  "an explicitly admitted roleless actor independently reads persisted data with no Auth write privilege",
  async () => {
    fixture.roleless = true;
    try {
      await appAdmin.query("update bills set status='roleless-saved' where id='bill-one'");
      await withNormalActorReadback(input, async (context) => {
        const row = await context.transaction(async (session) =>
          session.call("kernel_read_visible_record", { record_id: "bill-one" }),
        );
        expect(row).toEqual({ id: "bill-one", paymentStatus: "roleless-saved" });
      });
    } finally {
      fixture.roleless = false;
    }
  },
);

suite.each(["revoked", "mismatched-generation"] as const)(
  "denies actual roleless Auth %s before exposing app data",
  async (kind) => {
    fixture.roleless = true;
    try {
      await authAdmin.query('update app_actor_access set active=$1,"fenceGeneration"=$2', [
        kind !== "revoked",
        kind === "mismatched-generation" ? 3 : 4,
      ]);
      let entered = false;
      await expect(
        withNormalActorReadback(input, async () => {
          entered = true;
        }),
      ).rejects.toMatchObject({
        code: "actor_not_authorized",
        message: "Normal actor readback failed (actor_not_authorized).",
      });
      expect(entered).toBe(false);
    } finally {
      fixture.roleless = false;
      await authAdmin.query('update app_actor_access set active=true,"fenceGeneration"=4');
    }
  },
);
