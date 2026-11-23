import { describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { compileApp, repositoryRoot } from "./compile";
import { migrate, runtimeRoles, undo } from "./migrate";
import {
  installGeneratedAppRuntime,
  createGeneratedAppRuntime,
} from "../../packages/generated-app-runtime/server";
import { createDataClient, type DataDefinition } from "../../packages/generated-app-runtime/data";
import {
  NeonRestorePoints,
  PgDumpRestorePoints,
  connection,
  restoreTarget,
  type RestorePoints,
} from "./restore-points";

test("target identity ignores password rotation but refuses target overrides", () => {
  expect(restoreTarget("postgres://owner:one@localhost:55432/app")).toBe(
    restoreTarget("postgres://owner:two@localhost:55432/app"),
  );
  expect(() => restoreTarget("postgres://owner:one@localhost/app?host=other")).toThrow(
    "Unsupported",
  );
});

test("libpq receives hosted certificate verification without target overrides or inherited PG settings", () => {
  const previous = process.env.PGOPTIONS;
  process.env.PGOPTIONS = "-c search_path=elsewhere";
  try {
    const { env } = connection("postgres://owner:p%40ss@ep-host.example/app?sslmode=verify-full");
    expect(env).toMatchObject({
      PGHOST: "ep-host.example",
      PGDATABASE: "app",
      PGUSER: "owner",
      PGPASSWORD: "p@ss",
      PGSSLMODE: "verify-full",
      PGSSLROOTCERT: "system",
      PGPASSFILE: "/dev/null",
    });
    expect(env.PGOPTIONS).toBeUndefined();
    expect(
      connection("postgres://owner:p@ep-host.example/app?sslmode=verify-full&sslrootcert=system")
        .env.PGSSLROOTCERT,
    ).toBe("system");
    expect(
      connection(
        "postgres://owner:p@ep-host.example/app?sslmode=verify-full&sslrootcert=%2Fcerts%2Fca.pem",
      ).env.PGSSLROOTCERT,
    ).toBe("/certs/ca.pem");
    expect(() => connection("postgres://owner:p@ep-host.example/app?service=elsewhere")).toThrow(
      "Unsupported",
    );
  } finally {
    if (previous === undefined) delete process.env.PGOPTIONS;
    else process.env.PGOPTIONS = previous;
  }
});

test("Neon snapshots are polled and restored through an archive without resetting the target", async () => {
  const databaseUrl = "postgres://owner:secret@ep-target.example/app";
  const targetEndpoint = {
    id: "ep-target",
    host: "ep-target.example",
    branch_id: "br-target",
    type: "read_write",
  };
  const backupEndpoint = {
    id: "ep-backup",
    host: "ep-backup.example",
    branch_id: "br-backup",
    type: "read_only",
  };
  const calls: string[] = [];
  const dumpCalls: unknown[] = [];
  const dumps: RestorePoints = {
    async create(input) {
      dumpCalls.push(input);
      return {
        kind: "pg_dump",
        id: input.id,
        target: restoreTarget(input.databaseUrl),
        path: "/test/archive",
        sha256: "hash",
      };
    },
    async restore(input) {
      dumpCalls.push(input);
    },
  };
  const mockedFetch = (async (input: string | URL | Request, options?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${options?.method} ${url.pathname}`);
    let result: unknown;
    if (url.pathname.endsWith("/endpoints"))
      result = { endpoints: [targetEndpoint, backupEndpoint] };
    else if (url.pathname.endsWith("/branches")) {
      expect(JSON.parse(String(options?.body))).toEqual({
        branch: { name: "restore-test", parent_id: "br-target" },
        endpoints: [{ type: "read_only" }],
      });
      result = {
        branch: { id: "br-backup", parent_id: "br-target" },
        endpoints: [backupEndpoint],
        operations: [{ id: "operation", status: "running" }],
      };
    } else if (url.pathname.endsWith("/operations/operation"))
      result = { operation: { id: "operation", status: "finished" } };
    else if (url.pathname.endsWith("/branches/br-backup"))
      result = { branch: { id: "br-backup", parent_id: "br-target" } };
    else if (url.pathname.endsWith("/connection_uri")) {
      expect(url.searchParams.get("endpoint_id")).toBe("ep-backup");
      expect(url.searchParams.get("database_name")).toBe("app");
      result = { uri: "postgres://owner:snapshot-secret@ep-backup.example/app" };
    } else throw new Error("Unexpected provider request");
    return Response.json(result);
  }) as typeof fetch;
  const adapter = new NeonRestorePoints({
    apiKey: "test-key",
    projectId: "project",
    branchId: "br-target",
    fetch: mockedFetch,
    dumps,
    pollIntervalMs: 0,
  });
  const point = await adapter.create({ databaseUrl, id: "test" });
  await adapter.restore({ databaseUrl, point });
  expect(calls.filter((call) => call.startsWith("POST"))).toEqual([
    "POST /api/v2/projects/project/branches",
  ]);
  expect(calls).toContain("GET /api/v2/projects/project/operations/operation");
  expect(dumpCalls).toHaveLength(2);
  expect(dumpCalls[1]).toMatchObject({
    databaseUrl,
    point: { target: restoreTarget(databaseUrl) },
  });
  await expect(
    adapter.restore({ databaseUrl: "postgres://owner:secret@ep-other.example/app", point }),
  ).rejects.toThrow("does not belong");
});

test("Neon failed snapshot operation prevents successful restore-point creation", async () => {
  const adapter = new NeonRestorePoints({
    apiKey: "test",
    projectId: "project",
    branchId: "br-target",
    fetch: (async (input) => {
      if (String(input).endsWith("/endpoints"))
        return Response.json({
          endpoints: [{ host: "ep-target.example", branch_id: "br-target", type: "read_write" }],
        });
      return Response.json({ operations: [{ id: "failed", status: "failed" }] });
    }) as typeof fetch,
  });
  await expect(
    adapter.create({ databaseUrl: "postgres://owner:secret@ep-target.example/app", id: "failed" }),
  ).rejects.toThrow("operation failed");
});

// Explicit disposable-server input only. Each test creates and drops its own database.
describe.skipIf(!process.env.RESTORE_POINTS_TEST_DATABASE_URL)("PostgreSQL restore", () => {
  test("non-superuser database owner can undo an imported app migration with owners and ACLs intact", async () => {
    const admin = new pg.Client({ connectionString: process.env.RESTORE_POINTS_TEST_DATABASE_URL });
    await admin.connect();
    const database = `undo_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const owner = `${database}_owner`;
    const cloudAdmin = `${database}_cloud_admin`;
    const neonSuperuser = `${database}_neon_superuser`;
    await mkdir(join(repositoryRoot, "app/.local"), { recursive: true });
    const directory = await mkdtemp(join(repositoryRoot, "app/.local/undo-owner-"));
    const url = new URL(process.env.RESTORE_POINTS_TEST_DATABASE_URL!);
    if (url.hostname === "localhost") url.hostname = "127.0.0.1";
    url.pathname = `/${database}`;
    url.username = owner;
    url.password = "local-owner-password";
    const runtimeUrl = new URL(url);
    runtimeUrl.username = `${database}_login`;
    runtimeUrl.password = "local-runtime-password-at-least-32-characters";
    const client = new pg.Client({ connectionString: url.href });
    const providerUrl = new URL(process.env.RESTORE_POINTS_TEST_DATABASE_URL!);
    providerUrl.pathname = `/${database}`;
    const provider = new pg.Client({ connectionString: providerUrl.href });
    const warnings = spyOn(console, "warn").mockImplementation(() => {});
    const restorePoints = new PgDumpRestorePoints({ directory: join(directory, "backups") });
    const source = join(directory, "fixture.cue");
    const releaseDirectory = join(directory, ".generated/release");
    const compile = async (extra = "") => {
      await writeFile(
        source,
        `package schema
        manifest: #AppManifest & { app_id: "starter", customer_id: "starter", version: "undo",
          models: [{id: "note", kind: "entity", label: "Note", fields: [
            {id: "title", label: "Title", type: "text", required: true}${extra}]}] }`,
      );
      compileApp({ source, outputDirectory: releaseDirectory });
    };
    const input = {
      databaseUrl: url.href,
      releaseDirectory,
      restorePoints,
      ...runtimeRoles(url.href, runtimeUrl.href),
    };
    const authTables = [
      ...(
        await readFile(new URL("../../packages/auth/schema.sql", import.meta.url), "utf8")
      ).matchAll(/create table "([^"]+)"/g),
    ].map((match) => match[1]!);
    // Compare catalog ACLs including grantors, not merely effective privileges.
    const permissions = async () =>
      (
        await client.query(
          `
      SELECT 'function' AS kind, p.oid::regprocedure::text AS name, proowner AS owner, proacl::text AS acl
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
      UNION ALL
      SELECT CASE WHEN c.relname = ANY($1) OR EXISTS (
          SELECT 1 FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid
          WHERE i.indexrelid=c.oid AND t.relname = ANY($1)
        ) THEN 'auth relation' ELSE 'relation' END, relname, relowner, relacl::text
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
      UNION ALL
      SELECT 'schema', nspname, nspowner, nspacl::text FROM pg_namespace WHERE nspname='public'
      UNION ALL
      SELECT 'default', defaclobjtype::text, defaclrole, defaclacl::text FROM pg_default_acl
      ORDER BY kind, name, owner`,
          [authTables],
        )
      ).rows;
    try {
      await admin.query(`CREATE ROLE "${owner}" LOGIN PASSWORD 'local-owner-password'
        NOSUPERUSER CREATEROLE CREATEDB BYPASSRLS`);
      await admin.query(`CREATE DATABASE "${database}" OWNER "${owner}"`);
      await admin.query(
        `CREATE ROLE "${cloudAdmin}" NOLOGIN; CREATE ROLE "${neonSuperuser}" NOLOGIN`,
      );
      await provider.connect();
      await provider.query(`SET ROLE "${cloudAdmin}";
        ALTER DEFAULT PRIVILEGES FOR ROLE "${cloudAdmin}" IN SCHEMA public GRANT ALL ON TABLES TO "${neonSuperuser}";
        ALTER DEFAULT PRIVILEGES FOR ROLE "${cloudAdmin}" IN SCHEMA public GRANT ALL ON SEQUENCES TO "${neonSuperuser}";
        RESET ROLE;`);
      await client.connect();
      expect(
        (
          await client.query(
            "SELECT pg_has_role(current_user,$1,'MEMBER') AS cloud, pg_has_role(current_user,$2,'MEMBER') AS neon",
            [cloudAdmin, neonSuperuser],
          )
        ).rows[0],
      ).toEqual({ cloud: false, neon: false });
      await expect(
        client.query(
          `ALTER DEFAULT PRIVILEGES FOR ROLE "${cloudAdmin}" IN SCHEMA public GRANT ALL ON TABLES TO "${neonSuperuser}"`,
        ),
      ).rejects.toThrow("permission denied to change default privileges");
      expect(
        (
          await client.query(
            "SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles WHERE rolname=current_user",
          )
        ).rows[0],
      ).toEqual({ rolsuper: false, rolcreaterole: true, rolcreatedb: true, rolbypassrls: true });
      await compile();
      expect((await migrate(input)).applied).toBe(true);
      const executionOwner = (
        await client.query("SELECT kernel_installer_capability_role('execution_owner') AS role")
      ).rows[0].role;
      // Exercise another owner and owner-issued ACLs/default privileges as well as kernel functions.
      await client.query(`CREATE TABLE public.acl_probe (id integer);
        ALTER TABLE public.acl_probe OWNER TO "${executionOwner}";
        GRANT SELECT ON public.acl_probe TO "${runtimeUrl.username}";
        ALTER DEFAULT PRIVILEGES FOR ROLE "${executionOwner}" IN SCHEMA public
          GRANT SELECT ON TABLES TO "${runtimeUrl.username}";`);
      await client.query(`INSERT INTO "user" (id,name,email,"emailVerified") VALUES ('builder','Builder','builder@test.invalid',true);
        INSERT INTO organization (id,name,slug,"createdAt") VALUES ('starter','Starter','starter',now());
        INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ('builder','starter','builder','member',now());`);
      const csv = join(directory, "notes.csv");
      await writeFile(csv, "key,title\nn1,Imported before migration\n");
      const imported = spawnSync(
        "bun",
        [join(repositoryRoot, "app/scripts/records-import.ts"), "note", csv, "--key", "key"],
        {
          cwd: directory,
          env: { ...process.env, MIGRATION_DATABASE_URL: url.href },
          encoding: "utf8",
        },
      );
      expect(imported.stderr).toBe("");
      expect(imported.status).toBe(0);
      expect(imported.stdout).toContain("Imported 1 records");
      const before = await permissions();
      const history = (await client.query("SELECT id FROM autograph_applied_schema")).rows;
      await compile(', {id: "detail", label: "Detail", type: "text"}');
      expect((await migrate(input)).applied).toBe(true);
      const current = (
        await client.query(
          "SELECT id, restore_point FROM autograph_applied_schema ORDER BY applied_at DESC LIMIT 1",
        )
      ).rows[0];
      const after = await permissions();
      const cloudOid = (
        await client.query("SELECT oid FROM pg_roles WHERE rolname=$1", [cloudAdmin])
      ).rows[0].oid;
      const archive = spawnSync("pg_restore", ["--list", current.restore_point.path], {
        encoding: "utf8",
      });
      expect(archive.status).toBe(0);
      const providerEntries = archive.stdout
        .split("\n")
        .filter((line) => line.includes("DEFAULT ACL") && line.endsWith(cloudAdmin));
      expect(providerEntries).toHaveLength(2);
      expect(providerEntries.some((line) => line.includes("DEFAULT PRIVILEGES FOR TABLES"))).toBe(
        true,
      );
      expect(
        providerEntries.some((line) => line.includes("DEFAULT PRIVILEGES FOR SEQUENCES")),
      ).toBe(true);
      await expect(
        restorePoints.restore({
          databaseUrl: url.href,
          point: current.restore_point,
          expectedAppliedId: current.id,
          expectedRestoredHash: "f".repeat(64),
        }),
      ).rejects.toThrow("psql failed");
      expect(await permissions()).toEqual(after);
      expect(
        (
          await client.query(
            "SELECT id FROM autograph_applied_schema ORDER BY applied_at DESC LIMIT 1",
          )
        ).rows[0].id,
      ).toBe(current.id);
      warnings.mockClear();
      await undo(input);
      expect(warnings.mock.calls).toHaveLength(2);
      expect(warnings.mock.calls.flat().join("\n")).toContain(JSON.stringify(cloudAdmin));
      expect(warnings.mock.calls.flat().join("\n")).toContain("Skipped public DEFAULT ACL");
      const restored = await permissions();
      // Auth tables retain their current ACLs; archived app objects return to
      // the predecessor. A later installer can grant Auth access to its owner.
      expect(restored.filter((row) => row.kind !== "auth relation")).toEqual(
        before.filter(
          (row) =>
            row.kind !== "auth relation" && !(row.kind === "default" && row.owner === cloudOid),
        ),
      );
      expect(restored.filter((row) => row.kind === "auth relation")).toEqual(
        after.filter((row) => row.kind === "auth relation"),
      );
      expect((await client.query("SELECT id FROM autograph_applied_schema")).rows).toEqual(history);
      // Skipping provider defaults must not reassign them to the app owner or
      // grant the provider's recipient access to app-created objects.
      await client.query(
        "CREATE TABLE public.after_undo_acl_probe (id integer); CREATE SEQUENCE public.after_undo_acl_seq",
      );
      expect(
        (
          await client.query(
            "SELECT has_table_privilege($1,'public.after_undo_acl_probe','SELECT') AS table_access, has_sequence_privilege($1,'public.after_undo_acl_seq','USAGE') AS sequence_access",
            [neonSuperuser],
          )
        ).rows[0],
      ).toEqual({ table_access: false, sequence_access: false });
      expect(
        (await client.query("SELECT title FROM note_version WHERE effective_end IS NULL")).rows,
      ).toEqual([{ title: "Imported before migration" }]);
      expect(
        (
          await client.query(
            "SELECT 1 FROM information_schema.columns WHERE table_name='note_version' AND column_name='detail'",
          )
        ).rowCount,
      ).toBe(0);
      await compile();
      const runtime = createGeneratedAppRuntime({
        databaseUrl: runtimeUrl.href,
        releaseDirectory,
        appId: "starter",
        customerId: "starter",
      });
      try {
        const definition = JSON.parse(
          await readFile(join(releaseDirectory, "operation-manifest.json"), "utf8"),
        ) as DataDefinition;
        const ops = createDataClient(
          definition,
          runtime.dataContext({
            actorId: "builder",
            sourceKind: "test",
            authorize: async () => {},
          }),
        );
        const asOf = new Date().toISOString().slice(0, 10);
        expect(await ops.note!.list({ asOf })).toMatchObject([
          { title: "Imported before migration" },
        ]);
        await ops.apply({
          effectiveStart: asOf,
          idempotencyKey: "after-undo",
          writes: [ops.note!.writes.create({ title: "Written after undo" })],
        });
        expect(await ops.note!.list({ asOf })).toHaveLength(2);
      } finally {
        await runtime.close();
      }
    } finally {
      warnings.mockRestore();
      await provider.end();
      await client.end();
      const roles = (
        await admin.query("SELECT rolname FROM pg_roles WHERE starts_with(rolname,$1)", [
          `${database}_`,
        ])
      ).rows;
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      for (const { rolname } of roles.filter((row) => row.rolname !== owner))
        await admin.query(`DROP ROLE "${String(rolname).replaceAll('"', '""')}"`);
      await admin.query(`DROP ROLE IF EXISTS "${owner}"`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  }, 240_000);

  test("non-superuser default public ACL survives two successive restore points and undos", async () => {
    const admin = new pg.Client({ connectionString: process.env.RESTORE_POINTS_TEST_DATABASE_URL });
    await admin.connect();
    const database = `undo_twice_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const owner = `${database}_owner`;
    const directory = await mkdtemp(join(tmpdir(), "undo-twice-"));
    const url = new URL(process.env.RESTORE_POINTS_TEST_DATABASE_URL!);
    url.pathname = `/${database}`;
    url.username = owner;
    url.password = "test-owner-password";
    const client = new pg.Client({ connectionString: url.href });
    try {
      await admin.query(`CREATE ROLE "${owner}" LOGIN NOSUPERUSER PASSWORD 'test-owner-password'`);
      await admin.query(`CREATE DATABASE "${database}" OWNER "${owner}"`);
      await client.connect();
      await client.query(
        "CREATE TABLE public.probe (value text); INSERT INTO public.probe VALUES ('before')",
      );
      const original = (
        await client.query(
          "SELECT oid, nspacl::text AS acl FROM pg_namespace WHERE nspname='public'",
        )
      ).rows[0];
      const adapter = new PgDumpRestorePoints({ directory });
      for (const id of ["first", "second"]) {
        const point = await adapter.create({ databaseUrl: url.href, id });
        await client.query("UPDATE public.probe SET value='after'");
        await adapter.restore({ databaseUrl: url.href, point });
        const restored = (
          await client.query(
            "SELECT oid, nspacl::text AS acl FROM pg_namespace WHERE nspname='public'",
          )
        ).rows[0];
        expect(restored.oid).not.toBe(original.oid);
        expect(restored.acl).toBe(original.acl);
        expect((await client.query("SELECT value FROM public.probe")).rows).toEqual([
          { value: "before" },
        ]);
      }
    } finally {
      await client.end();
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS "${owner}"`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  test("restores rows, schema, applied record and SECURITY DEFINER ownership atomically", async () => {
    const admin = new pg.Client({ connectionString: process.env.RESTORE_POINTS_TEST_DATABASE_URL });
    await admin.connect();
    const suffix = randomUUID().replaceAll("-", "");
    const database = `restore_test_${suffix}`;
    const owner = `restore_owner_${suffix}`;
    const directory = await mkdtemp(join(tmpdir(), "restore-points-"));
    const url = new URL(process.env.RESTORE_POINTS_TEST_DATABASE_URL!);
    url.pathname = `/${database}`;
    let client: pg.Client | undefined;
    const beforeId = randomUUID();
    const afterId = randomUUID();
    const beforeHash = "a".repeat(64);
    try {
      await admin.query(`CREATE DATABASE ${database}`);
      await admin.query(`CREATE ROLE ${owner} NOLOGIN`);
      client = new pg.Client({ connectionString: url.href });
      await client.connect();
      await client.query(`CREATE TABLE public.items (id integer PRIMARY KEY, value text);
        INSERT INTO public.items VALUES (1, E'row\\nwith\\ttabs');
        CREATE TABLE public.applied_schema (version text); INSERT INTO public.applied_schema VALUES ('one');
        CREATE FUNCTION public.execution_owner() RETURNS text LANGUAGE sql SECURITY DEFINER AS 'SELECT current_user::text';
        ALTER FUNCTION public.execution_owner() OWNER TO ${owner};`);
      await client.query(
        await readFile(new URL("../../packages/auth/schema.sql", import.meta.url), "utf8"),
      );
      await client.query(`CREATE TABLE kernel_actor_membership (actor_id text, customer_id text, actor_kind text, active boolean);
        CREATE FUNCTION autograph_sync_member() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
        CREATE TRIGGER autograph_member_kernel AFTER INSERT OR UPDATE OR DELETE ON member FOR EACH ROW EXECUTE FUNCTION autograph_sync_member('runtime','starter','starter');`);
      await client.query(`INSERT INTO "user" (id,name,email,"emailVerified") VALUES ('old-user','Before','before@example.test',false);
        INSERT INTO account (id,"accountId","providerId","userId",password,"createdAt","updatedAt")
          VALUES ('account','old-user','credential','old-user','old-password',now(),now());`);
      await client.query(
        "CREATE TABLE public.autograph_applied_schema (id uuid PRIMARY KEY, release_hash text, applied_at timestamptz DEFAULT clock_timestamp())",
      );
      await client.query(
        "INSERT INTO public.autograph_applied_schema (id,release_hash) VALUES ($1,$2)",
        [beforeId, beforeHash],
      );
      const adapter = new PgDumpRestorePoints({ directory });
      await client.query("REVOKE USAGE ON SCHEMA public FROM PUBLIC");
      const schemaAcl = (
        await client.query("SELECT nspacl::text FROM pg_namespace WHERE nspname='public'")
      ).rows;
      const point = await adapter.create({ databaseUrl: url.href, id: "before" });
      expect((await stat(point.path)).mode & 0o777).toBe(0o600);
      await client.query(`ALTER TABLE public.items ADD COLUMN later text; UPDATE public.items SET value='new';
        UPDATE public.applied_schema SET version='two'; CREATE TABLE public.new_table (id integer);`);
      await client.query(`UPDATE account SET password='new-password' WHERE id='account';
        INSERT INTO "user" (id,name,email,"emailVerified") VALUES ('new-user','After','after@example.test',false);
        INSERT INTO organization (id,name,slug,"createdAt") VALUES ('starter','Starter','starter',now());
        INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ('new-member','starter','new-user','member',now());`);
      await client.query("UPDATE public.autograph_applied_schema SET id=$1, release_hash=$2", [
        afterId,
        "b".repeat(64),
      ]);
      await expect(
        adapter.restore({ databaseUrl: process.env.RESTORE_POINTS_TEST_DATABASE_URL!, point }),
      ).rejects.toThrow("does not belong");
      await expect(
        adapter.restore({
          databaseUrl: url.href,
          point,
          expectedAppliedId: randomUUID(),
          expectedRestoredHash: beforeHash,
        }),
      ).rejects.toThrow("psql failed");
      expect((await client.query("SELECT value FROM public.items")).rows[0].value).toBe("new");
      await expect(
        adapter.restore({
          databaseUrl: url.href,
          point,
          expectedAppliedId: afterId,
          expectedRestoredHash: "c".repeat(64),
        }),
      ).rejects.toThrow("psql failed");
      expect(
        (await client.query("SELECT id FROM public.autograph_applied_schema")).rows[0].id,
      ).toBe(afterId);
      await adapter.restore({
        databaseUrl: url.href,
        point,
        expectedAppliedId: afterId,
        expectedRestoredHash: beforeHash,
      });
      expect(
        (await client.query("SELECT nspacl::text FROM pg_namespace WHERE nspname='public'")).rows,
      ).toEqual(schemaAcl);
      // The archive still uses public's baseline after its OID changes.
      // Its explicit revocation must survive backing up and undoing again.
      const restoredPoint = await adapter.create({ databaseUrl: url.href, id: "restored" });
      await adapter.restore({ databaseUrl: url.href, point: restoredPoint });
      expect(
        (await client.query("SELECT nspacl::text FROM pg_namespace WHERE nspname='public'")).rows,
      ).toEqual(schemaAcl);
      expect(
        (await client.query("SELECT password FROM account WHERE id='account'")).rows[0].password,
      ).toBe("new-password");
      expect((await client.query('SELECT id FROM "user" ORDER BY id')).rows).toEqual([
        { id: "new-user" },
        { id: "old-user" },
      ]);
      expect((await client.query("SELECT id FROM member")).rows).toEqual([{ id: "new-member" }]);
      expect((await client.query("SELECT * FROM public.items")).rows).toEqual([
        { id: 1, value: "row\nwith\ttabs" },
      ]);
      expect((await client.query("SELECT * FROM public.applied_schema")).rows).toEqual([
        { version: "one" },
      ]);
      expect((await client.query("SELECT public.execution_owner() AS owner")).rows[0].owner).toBe(
        owner,
      );
      expect(
        (await client.query("SELECT to_regclass('public.new_table') AS name")).rows[0].name,
      ).toBeNull();

      await client.query("CREATE SCHEMA pgx_other_app");
      await expect(adapter.restore({ databaseUrl: url.href, point })).rejects.toThrow(
        "psql failed",
      );
      expect(
        (await client.query("SELECT count(*)::integer AS count FROM public.items")).rows[0].count,
      ).toBe(1);
      await client.query("DROP SCHEMA pgx_other_app");

      // Losing an archived function owner makes restore fail AFTER dropping public.
      // The transaction must nevertheless preserve every current table and row.
      await client.query(`ALTER FUNCTION public.execution_owner() OWNER TO postgres; DROP ROLE ${owner};
        UPDATE public.items SET value='keep-after-failure'; UPDATE public.applied_schema SET version='keep';`);
      await expect(adapter.restore({ databaseUrl: url.href, point })).rejects.toThrow(
        "psql failed",
      );
      expect((await client.query("SELECT value FROM public.items")).rows[0].value).toBe(
        "keep-after-failure",
      );
      expect(
        (await client.query("SELECT version FROM public.applied_schema")).rows[0].version,
      ).toBe("keep");
    } finally {
      await client?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${owner}`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  test("undo before first runtime binding retains current admission and membership without reviving revoked scopes", async () => {
    const admin = new pg.Client({ connectionString: process.env.RESTORE_POINTS_TEST_DATABASE_URL });
    await admin.connect();
    const database = `binding_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const runtimeRole = `${database}_runtime`,
      revokedRole = `${database}_revoked`,
      removedRole = `${database}_removed`;
    const directory = await mkdtemp(join(tmpdir(), "restore-binding-"));
    await mkdir(join(repositoryRoot, "app/.local"), { recursive: true });
    const sourceDirectory = await mkdtemp(join(repositoryRoot, "app/.local/restore-binding-"));
    const url = new URL(process.env.RESTORE_POINTS_TEST_DATABASE_URL!);
    url.pathname = `/${database}`;
    let client: pg.Client | undefined;
    try {
      await admin.query(`CREATE DATABASE "${database}"`);
      for (const role of [runtimeRole, revokedRole, removedRole])
        await admin.query(
          `CREATE ROLE "${role}" LOGIN PASSWORD 'local-test-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
        );
      client = new pg.Client({ connectionString: url.href });
      await client.connect();
      const source = join(sourceDirectory, "fixture.cue");
      await writeFile(
        source,
        `package schema
        manifest: #AppManifest & { app_id: "starter", customer_id: "starter", version: "binding",
          models: [{id: "note", kind: "entity", label: "Note", fields: [{id: "title", label: "Title", type: "text"}]}] }`,
      );
      const release = compileApp({ source, outputDirectory: join(directory, "release") });
      await installGeneratedAppRuntime({
        databaseUrl: url.href,
        releaseDirectory: release.directory,
        appId: "starter",
        customerIds: ["starter"],
      });
      await client.query(
        await readFile(new URL("../../packages/auth/schema.sql", import.meta.url), "utf8"),
      );
      await client.query(
        "CREATE TABLE restore_value (value text); INSERT INTO restore_value VALUES ('before')",
      );
      const capability = (
        await client.query("SELECT kernel_installer_capability_role('runtime') AS role")
      ).rows[0].role;
      for (const role of [runtimeRole, revokedRole, removedRole])
        await client.query(`GRANT "${capability}" TO "${role}"`);
      const bind = async (role: string, active = true) => {
        const result = (
          await client!.query("SELECT kernel_bind_principal_scope($1::jsonb) AS result", [
            JSON.stringify({
              principal_name: role,
              capability: "runtime",
              app_id: "starter",
              customer_id: "starter",
              active,
              actor_binding_required: false,
            }),
          ])
        ).rows[0].result;
        expect(result.ok).toBe(true);
      };
      await bind(revokedRole);
      await bind(removedRole);
      const adapter = new PgDumpRestorePoints({ directory: join(directory, "backups") });
      const point = await adapter.create({ databaseUrl: url.href, id: "before-binding" });
      expect(
        (await client.query("SELECT to_regprocedure('public.autograph_sync_member()') AS function"))
          .rows[0].function,
      ).toBeNull();
      await bind(runtimeRole);
      await bind(revokedRole, false);
      await client.query("DELETE FROM kernel_principal_scope WHERE principal_name=$1", [
        removedRole,
      ]);
      await client.query(
        await readFile(
          new URL("../../packages/auth/single-organization-membership.sql", import.meta.url),
          "utf8",
        ),
      );
      await client.query(`CREATE TRIGGER autograph_member_kernel AFTER INSERT OR UPDATE OR DELETE ON member
        FOR EACH ROW EXECUTE FUNCTION autograph_sync_member('${runtimeRole}','starter','starter');
        INSERT INTO "user" (id,name,email,"emailVerified") VALUES ('member','Member','member@example.test',false);
        INSERT INTO organization (id,name,slug,"createdAt") VALUES ('starter','Starter','starter',now());
        INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ('membership','starter','member','member',now());
        UPDATE restore_value SET value='after'`);
      // A lost capability grant cannot be fabricated by undo; failure rolls back
      // both the restored app data and the temporary Auth preservation work.
      await client.query(`REVOKE "${capability}" FROM "${runtimeRole}"`);
      await expect(adapter.restore({ databaseUrl: url.href, point })).rejects.toThrow(
        "psql failed",
      );
      expect((await client.query("SELECT value FROM restore_value")).rows[0].value).toBe("after");
      expect((await client.query("SELECT id FROM member")).rows).toEqual([{ id: "membership" }]);
      await client.query(`GRANT "${capability}" TO "${runtimeRole}"`);
      await adapter.restore({ databaseUrl: url.href, point });
      expect((await client.query("SELECT value FROM restore_value")).rows[0].value).toBe("before");
      expect(
        (
          await client.query(
            "SELECT principal_name::text, active FROM kernel_principal_scope WHERE capability='runtime' ORDER BY principal_name",
          )
        ).rows,
      ).toEqual(
        [
          { principal_name: removedRole, active: false },
          { principal_name: revokedRole, active: false },
          { principal_name: runtimeRole, active: true },
        ].sort((a, b) => a.principal_name.localeCompare(b.principal_name)),
      );
      expect(
        (
          await client.query(
            "SELECT actor_id, active FROM kernel_actor_membership WHERE principal_name=$1",
            [runtimeRole],
          )
        ).rows,
      ).toEqual([{ actor_id: "member", active: true }]);
      const runtimeUrl = new URL(url);
      runtimeUrl.username = runtimeRole;
      runtimeUrl.password = "local-test-only";
      const runtime = createGeneratedAppRuntime({
        databaseUrl: runtimeUrl.href,
        releaseDirectory: release.directory,
        appId: "starter",
        customerId: "starter",
      });
      try {
        const definition = JSON.parse(
          await readFile(join(release.directory, "operation-manifest.json"), "utf8"),
        ) as DataDefinition;
        const ops = createDataClient(
          definition,
          runtime.dataContext({ actorId: "member", sourceKind: "test", authorize: async () => {} }),
        );
        expect(await ops.note!.list({ asOf: "2026-01-01" })).toEqual([]);
      } finally {
        await runtime.close();
      }
      await client.query("DELETE FROM member WHERE id='membership'");
      expect(
        (
          await client.query(
            "SELECT active FROM kernel_actor_membership WHERE principal_name=$1 AND actor_id='member'",
            [runtimeRole],
          )
        ).rows[0].active,
      ).toBe(false);
    } finally {
      await client?.end();
      const roles = (
        await admin.query("SELECT rolname FROM pg_roles WHERE starts_with(rolname,$1)", [
          `${database}_`,
        ])
      ).rows;
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      for (const { rolname } of roles)
        await admin.query(`DROP ROLE "${String(rolname).replaceAll('"', '""')}"`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
      await rm(sourceDirectory, { recursive: true, force: true });
    }
  }, 60_000);

  test("restore subprocess retains its transaction lock when its coordinator is killed", async () => {
    const admin = new pg.Client({ connectionString: process.env.RESTORE_POINTS_TEST_DATABASE_URL });
    await admin.connect();
    const database = `restore_kill_${randomUUID().replaceAll("-", "")}`;
    const directory = await mkdtemp(join(tmpdir(), "restore-kill-"));
    const url = new URL(process.env.RESTORE_POINTS_TEST_DATABASE_URL!);
    url.pathname = `/${database}`;
    let client: pg.Client | undefined;
    let blocker: pg.Client | undefined;
    let worker: ReturnType<typeof spawn> | undefined;
    const waitFor = async (check: () => Promise<boolean>) => {
      const deadline = Date.now() + 10_000;
      while (!(await check())) {
        if (Date.now() > deadline) throw new Error("Restore worker did not reach expected state");
        await delay(25);
      }
    };
    try {
      await admin.query(`CREATE DATABASE ${database}`);
      client = new pg.Client({ connectionString: url.href });
      blocker = new pg.Client({ connectionString: url.href });
      await client.connect();
      await blocker.connect();
      await client.query(
        "CREATE TABLE public.held (value text); INSERT INTO public.held VALUES ('before')",
      );
      const adapter = new PgDumpRestorePoints({ directory });
      const point = await adapter.create({ databaseUrl: url.href, id: "before" });
      await client.query("UPDATE public.held SET value='after'");
      await blocker.query("BEGIN; LOCK TABLE public.held IN ACCESS SHARE MODE");
      const script = join(directory, "worker.ts");
      await writeFile(
        script,
        `import {PgDumpRestorePoints} from ${JSON.stringify(new URL("./restore-points.ts", import.meta.url).href)};
        await new PgDumpRestorePoints({directory:${JSON.stringify(directory)}}).restore({databaseUrl:process.env.TEST_RESTORE_URL!,point:${JSON.stringify(point)}});`,
      );
      worker = spawn("bun", [script], {
        env: { PATH: process.env.PATH, TEST_RESTORE_URL: url.href },
        stdio: "ignore",
      });
      await waitFor(
        async () =>
          (
            await admin.query(
              "SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'",
              [database],
            )
          ).rowCount === 1,
      );
      const lock =
        "SELECT pg_try_advisory_lock(hashtextextended('autograph:deployment:migrate',0)) AS acquired";
      expect((await client.query(lock)).rows[0].acquired).toBe(false);
      await new Promise<void>((resolve) => {
        worker!.once("exit", () => resolve());
        worker!.kill("SIGKILL");
      });
      expect((await client.query(lock)).rows[0].acquired).toBe(false);
      await blocker.query("COMMIT");
      await waitFor(
        async () =>
          (
            await admin.query(
              "SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND state='active'",
              [database],
            )
          ).rowCount === 0,
      );
      expect((await client.query("SELECT value FROM public.held")).rows[0].value).toBe("before");
      expect((await client.query(lock)).rows[0].acquired).toBe(true);
      await client.query(
        "SELECT pg_advisory_unlock(hashtextextended('autograph:deployment:migrate',0))",
      );
    } finally {
      worker?.kill("SIGKILL");
      await blocker?.query("ROLLBACK").catch(() => {});
      await blocker?.end();
      await client?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
