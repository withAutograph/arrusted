import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

export type DatabaseTarget = {
  environment: "local" | "preview" | "production";
  hostname: string;
  port: number;
  database: string;
  schema: "public";
  runtimeRole: string;
  migratorRole: string;
};
type ConnectionPurpose = "migrator" | "runtime";
const reject = (): never => {
  throw new Error("protected_installer_identity_mismatch");
};

/** Validate a direct connection before pg can apply query-string endpoint overrides. */
export function assertProtectedConnection(
  urlInput: string,
  resource: DatabaseTarget,
  purpose: ConnectionPurpose,
): void {
  const url = new URL(urlInput);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.hostname !== resource.hostname ||
    url.hostname.includes("-pooler.") ||
    Number(url.port || 5432) !== resource.port ||
    decodeURIComponent(url.pathname.slice(1)) !== resource.database ||
    decodeURIComponent(url.username) !==
      (purpose === "migrator" ? resource.migratorRole : resource.runtimeRole) ||
    url.hash ||
    [...url.searchParams.keys()].some((key) => !["sslmode", "channel_binding"].includes(key)) ||
    url.searchParams.getAll("sslmode").length !== 1 ||
    url.searchParams.getAll("channel_binding").length > 1 ||
    (url.searchParams.has("channel_binding") &&
      url.searchParams.get("channel_binding") !== "require")
  )
    reject();
  if (resource.environment === "local") {
    if (resource.hostname !== "127.0.0.1" || url.searchParams.get("sslmode") !== "disable")
      reject();
  } else if (
    url.searchParams.get("sslmode") !== "verify-full" ||
    ["127.0.0.1", "localhost"].includes(resource.hostname)
  )
    reject();
}

/** Read-only actual role/schema preflight; provider resource IDs still require provider readback. */
export async function verifyDatabaseConnection(
  client: PoolClient,
  resource: DatabaseTarget,
  purpose: ConnectionPurpose,
): Promise<void> {
  const { rows } = await client.query(
    "select current_database() as database, current_schema() as schema, current_user as role, session_user as login",
  );
  const expected = purpose === "migrator" ? resource.migratorRole : resource.runtimeRole;
  if (
    rows[0]?.database !== resource.database ||
    rows[0]?.schema !== resource.schema ||
    rows[0]?.role !== expected ||
    rows[0]?.login !== expected
  )
    reject();
  if (purpose === "migrator") {
    const owner = await client.query(
      "select pg_get_userbyid(datdba) as owner from pg_database where datname=current_database()",
    );
    if (owner.rows[0]?.owner !== resource.migratorRole) reject();
    return;
  }
}

/** Run the same least-privilege check from a trusted migrator before any protected write. */
export async function verifyRuntimeRolePrivileges(
  client: PoolClient,
  resource: DatabaseTarget,
): Promise<void> {
  const executionOwner = workerCapabilityRole(resource, "execution_owner");
  const privileges = await client.query(
    `select
    exists(select 1 from pg_roles r where pg_has_role($1,r.oid,'MEMBER') and
      (r.rolsuper or r.rolcreatedb or r.rolcreaterole or r.rolreplication or r.rolbypassrls or r.rolname in
      ('neon_superuser','pg_write_all_data','pg_read_all_data','pg_execute_server_program','pg_read_server_files','pg_write_server_files'))) as elevated,
    exists(select 1 from pg_roles r where pg_has_role($1,r.oid,'MEMBER') and has_database_privilege(r.oid,current_database(),'CREATE')) as database_create,
    exists(select 1 from pg_namespace n cross join pg_roles r where n.nspname !~ '^pg_' and n.nspname <> 'information_schema' and pg_has_role($1,r.oid,'MEMBER') and has_schema_privilege(r.oid,n.oid,'CREATE')) as schema_create,
    exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and pg_has_role($1,c.relowner,'MEMBER')) as owns_objects,
    pg_has_role($1,$2,'MEMBER') as migrator_member,
    exists(select 1 from pg_roles r where r.rolname=$3 and pg_has_role($1,r.oid,'MEMBER')) as execution_owner_member`,
    [resource.runtimeRole, resource.migratorRole, executionOwner],
  );
  if (!privileges.rows[0] || Object.values(privileges.rows[0]).some((value) => value !== false))
    reject();
}

function workerCapabilityRole(resource: DatabaseTarget, capability: "execution_owner"): string {
  const normalized = `${resource.database}__${resource.schema}__kernel_${capability}`
    .toLowerCase()
    .replace(/[_\s-]+/gu, "_")
    .replace(/[^a-z0-9_]/gu, "")
    .replace(/^_+|_+$/gu, "");
  if (Buffer.byteLength(normalized) <= 63) return normalized;
  return `${normalized.slice(0, 46)}_${createHash("md5").update(normalized).digest("hex").slice(0, 16)}`;
}
