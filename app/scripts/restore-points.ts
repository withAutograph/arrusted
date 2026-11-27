import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { migrationLock } from "./migration-lock";
import { chmod, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export type PgDumpRestorePoint = {
  kind: "pg_dump";
  id: string;
  target: string;
  path: string;
  sha256: string;
};
export type NeonRestorePoint = {
  kind: "neon";
  id: string;
  target: string;
  projectId: string;
  branchId: string;
  backupBranchId: string;
  endpointId: string;
};
export type RestorePoint = PgDumpRestorePoint | NeonRestorePoint;
export type RestoreInput = {
  databaseUrl: string;
  point: RestorePoint;
  expectedAppliedId?: string;
  expectedRestoredHash?: string | null;
  /** Release the coordinator lock only after the archive is ready to execute. */
  beforeRestore?: () => Promise<void>;
};

/** Create runs under the coordinator lock; restore takes its own transaction lock. */
export interface RestorePoints {
  create(input: { databaseUrl: string; id: string }): Promise<RestorePoint>;
  restore(input: RestoreInput): Promise<void>;
}

export function connection(databaseUrl: string) {
  const url = new URL(databaseUrl);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    !url.username ||
    url.pathname.length < 2
  ) {
    throw new Error("Restore points require an explicit PostgreSQL host, user and database.");
  }
  const options: Record<string, string> = {
    sslmode: "PGSSLMODE",
    sslrootcert: "PGSSLROOTCERT",
    sslcert: "PGSSLCERT",
    sslkey: "PGSSLKEY",
    channel_binding: "PGCHANNELBINDING",
    connect_timeout: "PGCONNECT_TIMEOUT",
  };
  // Do not inherit PGHOST, PGSERVICE, PGOPTIONS or credentials for another target.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    PGHOST: url.hostname.replace(/^\[|\]$/g, ""),
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGCONNECT_TIMEOUT: "15",
    PGPASSFILE: "/dev/null",
  };
  for (const [name, value] of url.searchParams) {
    const key = options[name];
    if (!key) throw new Error(`Unsupported database connection option: ${name}`);
    env[key] = value;
  }
  if (env.PGSSLMODE === "verify-full" && !env.PGSSLROOTCERT) env.PGSSLROOTCERT = "system";
  return { url, env };
}

/** Password changes do not change the target. Query overrides are rejected above. */
export function restoreTarget(databaseUrl: string): string {
  const { env } = connection(databaseUrl);
  return createHash("sha256")
    .update(JSON.stringify([env.PGHOST, env.PGPORT, env.PGDATABASE, env.PGUSER]))
    .digest("hex");
}

function checkId(id: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("Invalid restore point id.");
}

async function run(program: string, args: string[], databaseUrl?: string): Promise<void> {
  const env = databaseUrl
    ? connection(databaseUrl).env
    : { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR };
  await new Promise<void>((done, reject) => {
    const child = spawn(program, args, { env, stdio: ["ignore", "ignore", "pipe"] });
    // SQL errors can contain row values or credentials; never surface subprocess output.
    child.stderr.resume();
    child.once("error", () =>
      reject(new Error(`Could not start ${program}. Check PostgreSQL client installation.`)),
    );
    child.once("close", (code) =>
      code === 0
        ? done()
        : reject(new Error(`${program} failed (exit ${code}); database restore did not complete.`)),
    );
  });
}

async function digest(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function sync(path: string) {
  const file = await open(path, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

// Only public and marked Better Auth app schemas (auth_*) are permitted; unmarked schemas fail closed.
const publicOnly = `DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_namespace
    WHERE nspname <> 'public'
      AND nspname <> 'information_schema'
      AND left(nspname, 3) <> 'pg_'
      AND NOT (
        nspname ~ '^auth_[a-z0-9_]{1,57}$'
        AND coalesce(obj_description(oid, 'pg_namespace'), '') ~ '^autograph:auth-schema:[0-9a-f]{64}$'
      )
  ) THEN
    RAISE EXCEPTION 'Restore requires a database dedicated to the public schema';
  END IF;
END $$;`;

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
function restoreGuard(expectedAppliedId?: string) {
  return `DO $$ BEGIN
    IF NOT pg_try_advisory_xact_lock(hashtextextended(${literal(migrationLock)}, 0)) THEN
      RAISE EXCEPTION 'Another migration or undo is running';
    END IF;
    ${
      expectedAppliedId === undefined
        ? ""
        : `
    IF to_regclass('public.autograph_applied_schema') IS NULL THEN
      RAISE EXCEPTION 'Migration history changed before restore';
    END IF;
    IF (SELECT id::text FROM public.autograph_applied_schema ORDER BY applied_at DESC, id DESC LIMIT 1)
      IS DISTINCT FROM ${literal(expectedAppliedId)} THEN
      RAISE EXCEPTION 'Migration history changed before restore';
    END IF;`
    }
  END $$;`;
}

function restoredGuard(expectedRestoredHash: string | null) {
  return `DO $$ DECLARE restored_hash text; BEGIN
    IF to_regclass('public.autograph_applied_schema') IS NOT NULL THEN
      SELECT release_hash INTO restored_hash FROM public.autograph_applied_schema ORDER BY applied_at DESC, id DESC LIMIT 1;
    END IF;
    IF restored_hash IS DISTINCT FROM ${expectedRestoredHash === null ? "NULL" : literal(expectedRestoredHash)} THEN
      RAISE EXCEPTION 'Restored migration history does not match expected predecessor';
    END IF;
  END $$;`;
}

// Auth is an independent lifetime: exclude its objects from backups and preserve
// the live tables (including indexes, constraints, ACLs and row identities) on undo.
const authTables = [
  ...readFileSync(new URL("../../packages/auth/schema.sql", import.meta.url), "utf8").matchAll(
    /create table "([^"]+)"/g,
  ),
].map((match) => match[1]!);
const authNames = authTables.map(literal).join(",");
const preserveAuth = `
CREATE SCHEMA autograph_undo_auth;
CREATE OR REPLACE FUNCTION pg_temp.autograph_decode_tgargs(raw bytea)
RETURNS text[] LANGUAGE plpgsql IMMUTABLE AS $tgargs$
DECLARE
  rest bytea := coalesce(raw, ''::bytea);
  pos integer;
  decoded text[] := array[]::text[];
BEGIN
  LOOP
    pos := position(decode('00', 'hex') in rest);
    EXIT WHEN pos = 0;
    decoded := array_append(
      decoded,
      convert_from(substring(rest from 1 for pos - 1), current_setting('server_encoding'))
    );
    rest := substring(rest from pos + 1);
  END LOOP;
  RETURN decoded;
END $tgargs$;
CREATE TEMP TABLE autograph_undo_trigger AS
  SELECT ns_rel.nspname AS member_schema,
    (pg_temp.autograph_decode_tgargs(t.tgargs))[1] AS principal_name,
    (pg_temp.autograph_decode_tgargs(t.tgargs))[2] AS app_id,
    (pg_temp.autograph_decode_tgargs(t.tgargs))[3] AS customer_id,
    CASE WHEN t.tgnargs >= 4
      THEN (pg_temp.autograph_decode_tgargs(t.tgargs))[4]
      ELSE 'member'
    END AS role_name,
    pg_get_triggerdef(t.oid) AS ddl, t.tgenabled AS enabled,
    pg_get_functiondef(p.oid) AS function_ddl,
    format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) AS function_identity,
    pg_get_userbyid(p.proowner) AS function_owner
  FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace ns_rel ON ns_rel.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
    JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE t.tgname = 'autograph_member_kernel'
    AND c.relname = 'member'
    AND NOT t.tgisinternal
    AND (
      ns_rel.nspname = 'public'
      OR (
        ns_rel.nspname ~ '^auth_[a-z0-9_]{1,57}$'
        AND coalesce(obj_description(ns_rel.oid, 'pg_namespace'), '') ~ '^autograph:auth-schema:[0-9a-f]{64}$'
      )
    );
CREATE TEMP TABLE autograph_undo_runtime_scope (request jsonb);
CREATE TEMP TABLE autograph_undo_scope_catalog AS
  SELECT to_regclass('public.kernel_principal_scope') IS NOT NULL AS present;
DO $$ DECLARE t text; BEGIN
  IF (SELECT present FROM autograph_undo_scope_catalog) THEN
    INSERT INTO autograph_undo_runtime_scope
      SELECT jsonb_build_object('principal_name', principal_name, 'capability', capability,
        'app_id', app_id, 'customer_id', customer_id, 'actor_id', actor_id,
        'active', true, 'actor_binding_required', actor_binding_required)
      FROM public.kernel_principal_scope WHERE capability='runtime' AND active;
  END IF;
  FOR t IN SELECT unnest(ARRAY[${authNames}]) LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I SET SCHEMA autograph_undo_auth', t);
    END IF;
  END LOOP;
END $$;`;
const recoverAuth = `
SET LOCAL search_path = pg_catalog, public;
DO $$ DECLARE t text; binding record; result jsonb; has_principal boolean; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'autograph_undo_auth' LOOP
    EXECUTE format('ALTER TABLE autograph_undo_auth.%I SET SCHEMA public', t);
  END LOOP;
  IF to_regclass('public.kernel_actor_membership') IS NOT NULL THEN
    -- Runtime admission belongs to current Auth, not to the archived app schema.
    -- Clear archived admission first so a revoked or removed scope stays revoked.
    IF to_regclass('public.kernel_principal_scope') IS NOT NULL
      AND (SELECT present FROM autograph_undo_scope_catalog) THEN
      UPDATE public.kernel_principal_scope SET active=false WHERE capability='runtime';
      FOR binding IN SELECT request FROM autograph_undo_runtime_scope LOOP
        result := public.kernel_bind_principal_scope(binding.request);
        IF result->>'ok' IS DISTINCT FROM 'true' THEN
          RAISE EXCEPTION 'Current runtime scope could not be restored';
        END IF;
      END LOOP;
    END IF;
    FOR binding IN SELECT * FROM autograph_undo_trigger LOOP
      -- A snapshot before the first runtime binding has no membership function.
      EXECUTE binding.function_ddl;
      EXECUTE format('ALTER FUNCTION %s OWNER TO %I', binding.function_identity, binding.function_owner);
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', binding.function_identity);
      EXECUTE format('DROP TRIGGER IF EXISTS autograph_member_kernel ON %I.member', binding.member_schema);
      EXECUTE binding.ddl;
      EXECUTE format('ALTER TABLE %I.member %s TRIGGER autograph_member_kernel',
        binding.member_schema,
        CASE binding.enabled
          WHEN 'D' THEN 'DISABLE' WHEN 'R' THEN 'ENABLE REPLICA'
          WHEN 'A' THEN 'ENABLE ALWAYS' ELSE 'ENABLE' END);
    END LOOP;
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'kernel_actor_membership' AND column_name = 'principal_name'
    ) INTO has_principal;
    IF has_principal AND EXISTS (SELECT 1 FROM autograph_undo_trigger) THEN
      FOR binding IN SELECT * FROM autograph_undo_trigger LOOP
        EXECUTE format(
          'UPDATE public.kernel_actor_membership k SET active = false
             WHERE k.actor_kind = ''human''
               AND k.active = true
               AND k.fence_generation = 0
               AND k.principal_name = $1::name
               AND k.app_id = $2
               AND k.customer_id = $3
               AND (
                 k.role <> $4
                 OR NOT EXISTS (
                   SELECT 1 FROM %I.member m
                   WHERE m."userId" = k.actor_id AND m."organizationId" = k.customer_id
                 )
               )',
          binding.member_schema
        ) USING binding.principal_name, binding.app_id, binding.customer_id, binding.role_name;
        EXECUTE format('UPDATE %I.member SET "userId"="userId"', binding.member_schema);
      END LOOP;
    ELSIF to_regclass('public.member') IS NOT NULL THEN
      UPDATE public.kernel_actor_membership k SET active = false
        WHERE actor_kind = 'human' AND NOT EXISTS (
          SELECT 1 FROM public.member m WHERE m."userId" = k.actor_id AND m."organizationId" = k.customer_id);
      UPDATE public.member SET "userId"="userId";
    END IF;
  END IF;
END $$;
DROP SCHEMA autograph_undo_auth;`;

export class PgDumpRestorePoints implements RestorePoints {
  readonly directory: string;
  constructor(options: { directory?: string } = {}) {
    this.directory = resolve(
      options.directory ?? new URL("../.local/restore-points", import.meta.url).pathname,
    );
  }

  async create({
    databaseUrl,
    id,
  }: {
    databaseUrl: string;
    id: string;
  }): Promise<PgDumpRestorePoint> {
    checkId(id);
    const target = restoreTarget(databaseUrl);
    await run(
      "psql",
      ["--no-psqlrc", "--no-password", "--set=ON_ERROR_STOP=1", "--command", publicOnly],
      databaseUrl,
    );
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const directory = join(await realpath(this.directory), id);
    await mkdir(directory, { mode: 0o700 }); // Exclusive: an existing restore point is never overwritten.
    const path = join(directory, "public.dump");
    try {
      const file = await open(path, "wx", 0o600);
      await file.close();
      // Keep owners and ACLs: SECURITY DEFINER functions must retain their execution roles.
      await run(
        "pg_dump",
        [
          "--no-password",
          "--format=custom",
          "--schema=public",
          "--strict-names",
          ...authTables.map((name) => `--exclude-table=public."${name}"`),
          "--file",
          path,
        ],
        databaseUrl,
      );
      await sync(path);
      const sha256 = await digest(path);
      await sync(directory);
      await sync(this.directory);
      return { kind: "pg_dump", id, target, path, sha256 };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async restore({
    databaseUrl,
    point,
    expectedAppliedId,
    expectedRestoredHash,
    beforeRestore,
  }: RestoreInput): Promise<void> {
    if (point.kind !== "pg_dump" || point.target !== restoreTarget(databaseUrl)) {
      throw new Error("Restore point does not belong to this database target.");
    }
    if (
      (expectedAppliedId !== undefined && !/^[a-f0-9-]{36}$/i.test(expectedAppliedId)) ||
      (expectedRestoredHash !== undefined &&
        expectedRestoredHash !== null &&
        !/^[a-f0-9]{64}$/i.test(expectedRestoredHash))
    ) {
      throw new Error("Invalid expected migration identity.");
    }
    checkId(point.id);
    const expected = join(await realpath(this.directory), point.id, "public.dump");
    if (
      point.path !== expected ||
      (await realpath(point.path)) !== expected ||
      (await digest(point.path)) !== point.sha256
    ) {
      throw new Error("Restore point path or checksum does not match.");
    }
    const temporary = await mkdtemp(join(dirname(point.path), "restore-"));
    const sql = join(temporary, "objects.sql");
    const schema = join(temporary, "schema.sql");
    const schemaAcl = join(temporary, "schema-acl.sql");
    const list = join(temporary, "archive.list");
    try {
      await run("pg_restore", ["--list", "--file", list, point.path]);
      let entries = (await readFile(list, "utf8")).split("\n");
      const schemaDefinition = (entry: string) => /^\d+; \d+ \d+ SCHEMA - public /.test(entry);
      // pg_dump >=15 synthesizes public's baseline by NAME, even after undo
      // changes its OID. The writer version, not the source server, owns this.
      const initialPublic = entries.some((entry) => /^\d+; 2615 2200 SCHEMA - public /.test(entry));
      const dumpVersion = Number(entries.join("\n").match(/Dumped by pg_dump version: (\d+)/)?.[1]);
      if (!Number.isFinite(dumpVersion)) throw new Error("Archive pg_dump version is missing.");
      const defaultAcl = (entry: string) => /^\d+; \d+ \d+ DEFAULT ACL /.test(entry);
      if (entries.some(defaultAcl)) {
        // Match PostgreSQL's has_privs_of_role check for ALTER DEFAULT PRIVILEGES.
        // This is read-only preparation; all restore writes still share one transaction.
        const rolesFile = join(temporary, "roles.json");
        await run(
          "psql",
          [
            "--no-psqlrc",
            "--no-password",
            "--set=ON_ERROR_STOP=1",
            "--tuples-only",
            "--no-align",
            "--output",
            rolesFile,
            "--command",
            "SELECT json_object_agg(rolname, pg_has_role(current_user, oid, 'USAGE')) FROM pg_roles",
          ],
          databaseUrl,
        );
        const roles = JSON.parse(await readFile(rolesFile, "utf8")) as Record<string, boolean>;
        entries = entries.filter((entry) => {
          if (!defaultAcl(entry)) return true;
          // Only schema-local defaults are additive; never skip a global default
          // (which can revoke builtin privileges) or an unrecognized entry.
          const owner = entry.match(
            /^\d+; \d+ \d+ DEFAULT ACL public DEFAULT PRIVILEGES FOR (?:TABLES|SEQUENCES|FUNCTIONS|TYPES) (.+)$/,
          )?.[1];
          if (owner === undefined || !Object.hasOwn(roles, owner)) {
            throw new Error("Cannot identify an archived DEFAULT ACL owner; restore refused.");
          }
          if (roles[owner]) return true;
          console.warn(
            `Skipped public DEFAULT ACL for role ${JSON.stringify(owner)}: the restore login cannot change its default privileges. These schema-local grants will be absent after undo; a role administrator must reapply them if needed.`,
          );
          return false;
        });
      }
      const schemaEntry = (entry: string) =>
        /^\d+; \d+ \d+ (SCHEMA - public |(?:ACL|COMMENT|SECURITY LABEL) - SCHEMA public )/.test(
          entry,
        );
      // ALTER OWNER requires CREATE on the schema for the new owner. pg_restore
      // defers ACLs even with a reordered TOC, so emit schema + its ACLs separately.
      // Keep PostgreSQL's owner/grantor SQL intact; all files run in one transaction.
      for (const [path, selected] of [
        [schema, entries.filter(schemaDefinition)],
        [schemaAcl, entries.filter((entry) => schemaEntry(entry) && !schemaDefinition(entry))],
        [sql, entries.filter((entry) => !schemaEntry(entry))],
      ] as const) {
        await writeFile(list, selected.join("\n"));
        await writeFile(path, "", { flag: "wx", mode: 0o600 });
        await run("pg_restore", [
          "--exit-on-error",
          "--use-list",
          list,
          "--file",
          path,
          point.path,
        ]);
      }
      await beforeRestore?.();
      // psql understands COPY data. Both the drop and complete archive run in ONE
      // transaction; any error rolls everything back, including the applied record.
      // The child owns the transaction lock, so killing its coordinator cannot
      // permit a second migration while this restore is still running.
      await run(
        "psql",
        [
          "--no-psqlrc",
          "--no-password",
          "--set=ON_ERROR_STOP=1",
          "--single-transaction",
          "--command",
          `${restoreGuard(expectedAppliedId)}\n${publicOnly}\n${preserveAuth}\nDROP SCHEMA IF EXISTS public CASCADE;`,
          "--file",
          schema,
          // pg_dump emits public's ACL as a delta from its initial privileges.
          // CREATE SCHEMA does not supply that baseline; archived revocations
          // must run afterward so a restricted public schema remains restricted.
          ...(dumpVersion >= 15 || initialPublic
            ? [
                "--command",
                `GRANT ${dumpVersion < 15 ? "CREATE, USAGE" : "USAGE"} ON SCHEMA public TO PUBLIC;`,
              ]
            : []),
          "--file",
          schemaAcl,
          "--file",
          sql,
          "--command",
          recoverAuth,
          ...(expectedRestoredHash === undefined
            ? []
            : ["--command", restoredGuard(expectedRestoredHash)]),
        ],
        databaseUrl,
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

type Endpoint = { id: string; host: string; branch_id: string; type: string };
type Operation = { id: string; status: string };
type BranchResult = {
  branch: { id: string; parent_id: string };
  endpoints: Endpoint[];
  operations: Operation[];
};
type NeonOptions = {
  apiKey: string;
  projectId: string;
  branchId: string;
  directory?: string;
  fetch?: typeof fetch;
  dumps?: RestorePoints;
  pollIntervalMs?: number;
};

/**
 * Provider code only in phase 2a; tests inject fetch and dump adapters.
 * Snapshot branches are retained for undo and may incur Neon storage/compute cost.
 * Undo dumps the read-only snapshot and uses the transactional local restore path.
 * It never resets/restarts the target branch, which would release its advisory lock.
 * API: https://neon.com/docs/reference/api/branches/create-project-branch
 *      https://neon.com/docs/reference/api/projects/get-connection-uri
 */
export class NeonRestorePoints implements RestorePoints {
  private readonly request: typeof fetch;
  private readonly dumps: RestorePoints;
  constructor(private readonly options: NeonOptions) {
    if (!options.apiKey || !options.projectId || !options.branchId)
      throw new Error(
        "Neon restore points require NEON_API_KEY, NEON_PROJECT_ID and NEON_BRANCH_ID.",
      );
    this.request = options.fetch ?? fetch;
    this.dumps = options.dumps ?? new PgDumpRestorePoints({ directory: options.directory });
  }

  private async api<T>(path: string, body?: unknown): Promise<T> {
    const response = await this.request(
      `https://console.neon.tech/api/v2/projects/${encodeURIComponent(this.options.projectId)}${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
      },
    );
    if (!response.ok)
      throw new Error(`Neon restore-point request failed (HTTP ${response.status}).`);
    return (await response.json()) as T;
  }

  private async wait(operations: Operation[]) {
    const deadline = Date.now() + 120_000;
    for (let operation of operations) {
      while (operation.status !== "finished") {
        if (!["running", "scheduling"].includes(operation.status))
          throw new Error("Neon restore-point operation failed.");
        if (Date.now() >= deadline)
          throw new Error(
            "Timed out waiting for Neon restore point. Inspect the retained branch before retrying.",
          );
        await delay(this.options.pollIntervalMs ?? 500);
        ({ operation } = await this.api<{ operation: Operation }>(
          `/operations/${encodeURIComponent(operation.id)}`,
        ));
      }
    }
  }

  private async verifyTarget(databaseUrl: string) {
    const { url } = connection(databaseUrl);
    const { endpoints } = await this.api<{ endpoints: Endpoint[] }>("/endpoints");
    if (
      !endpoints.some(
        (endpoint) =>
          endpoint.host === url.hostname &&
          endpoint.branch_id === this.options.branchId &&
          endpoint.type === "read_write",
      )
    ) {
      throw new Error(
        "Database URL is not the direct writable endpoint of NEON_BRANCH_ID in NEON_PROJECT_ID.",
      );
    }
  }

  async create({
    databaseUrl,
    id,
  }: {
    databaseUrl: string;
    id: string;
  }): Promise<NeonRestorePoint> {
    checkId(id);
    await this.verifyTarget(databaseUrl);
    const result = await this.api<BranchResult>("/branches", {
      branch: { name: `restore-${id}`, parent_id: this.options.branchId },
      endpoints: [{ type: "read_only" }],
    });
    await this.wait(result.operations);
    const endpoint = result.endpoints.find(
      (value) => value.branch_id === result.branch.id && value.type === "read_only",
    );
    if (result.branch.parent_id !== this.options.branchId || !endpoint)
      throw new Error("Neon snapshot does not match the requested source branch.");
    return {
      kind: "neon",
      id,
      target: restoreTarget(databaseUrl),
      projectId: this.options.projectId,
      branchId: this.options.branchId,
      backupBranchId: result.branch.id,
      endpointId: endpoint.id,
    };
  }

  async restore({
    databaseUrl,
    point,
    expectedAppliedId,
    expectedRestoredHash,
    beforeRestore,
  }: RestoreInput): Promise<void> {
    if (
      point.kind !== "neon" ||
      point.target !== restoreTarget(databaseUrl) ||
      point.projectId !== this.options.projectId ||
      point.branchId !== this.options.branchId
    ) {
      throw new Error("Restore point does not belong to this Neon database target.");
    }
    await this.verifyTarget(databaseUrl);
    const { branch } = await this.api<{ branch: BranchResult["branch"] }>(
      `/branches/${encodeURIComponent(point.backupBranchId)}`,
    );
    const { endpoints } = await this.api<{ endpoints: Endpoint[] }>("/endpoints");
    const endpoint = endpoints.find(
      (value) =>
        value.id === point.endpointId &&
        value.branch_id === point.backupBranchId &&
        value.type === "read_only",
    );
    if (
      branch.id !== point.backupBranchId ||
      branch.parent_id !== point.branchId ||
      !endpoint ||
      endpoints.some(
        (value) => value.branch_id === point.backupBranchId && value.type === "read_write",
      )
    ) {
      throw new Error("Snapshot branch lineage or read-only endpoint changed.");
    }
    const { env } = connection(databaseUrl);
    const params = new URLSearchParams({
      branch_id: point.backupBranchId,
      endpoint_id: point.endpointId,
      database_name: env.PGDATABASE!,
      role_name: env.PGUSER!,
      pooled: "false",
    });
    const { uri } = await this.api<{ uri: string }>(`/connection_uri?${params}`);
    const source = connection(uri);
    if (
      source.url.hostname !== endpoint.host ||
      source.env.PGDATABASE !== env.PGDATABASE ||
      source.env.PGUSER !== env.PGUSER
    ) {
      throw new Error("Snapshot connection does not match its verified branch and database.");
    }
    const snapshot = await this.dumps.create({ databaseUrl: uri, id: `neon-${randomUUID()}` });
    if (snapshot.kind !== "pg_dump")
      throw new Error("Neon snapshot must be materialized as a PostgreSQL archive.");
    // Transfer target binding only after the provider verifies snapshot lineage.
    await this.dumps.restore({
      databaseUrl,
      point: { ...snapshot, target: point.target },
      expectedAppliedId,
      expectedRestoredHash,
      beforeRestore,
    });
  }
}

export function restorePointsFromEnvironment(directory?: string): RestorePoints {
  const {
    NEON_API_KEY: apiKey,
    NEON_PROJECT_ID: projectId,
    NEON_BRANCH_ID: branchId,
  } = process.env;
  if (apiKey || projectId || branchId) {
    if (!apiKey || !projectId || !branchId)
      throw new Error(
        "Set all three Neon restore-point environment variables, or none for pg_dump.",
      );
    return new NeonRestorePoints({ apiKey, projectId, branchId, directory });
  }
  return new PgDumpRestorePoints({ directory });
}
