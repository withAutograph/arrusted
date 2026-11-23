/** Reviewed, non-secret identity shared by Auth runtime and protected migration. */
export type AuthDatabaseResource = Readonly<{
  version: 1;
  environment: "local" | "preview" | "production" | "isolated-development";
  hostname: string;
  port: number;
  database: string;
  schema: "public";
  runtimeRole: string;
  migratorRole: string;
  neon?: Readonly<{ projectId: string; branchId: string }>;
}>;
export type AuthDatabasePurpose = "runtime" | "migrator";

export class AuthDatabaseIdentityError extends Error {
  readonly code = "auth_configuration_error";
  constructor(category: string) {
    super(`Auth database preflight failed: ${category}`);
    this.name = "AuthDatabaseIdentityError";
  }
}

const identifier = /^[a-z][a-z0-9_]{0,62}$/u;
const providerId = /^[a-zA-Z0-9_-]+$/u;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

export function readAuthDatabaseResource(
  value: string | undefined,
): AuthDatabaseResource | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new AuthDatabaseIdentityError("invalid resource record");
  }
  if (
    !record(parsed) ||
    !exactKeys(parsed, [
      "version",
      "environment",
      "hostname",
      "port",
      "database",
      "schema",
      "runtimeRole",
      "migratorRole",
      "neon",
    ]) ||
    parsed.version !== 1 ||
    typeof parsed.environment !== "string" ||
    !["local", "preview", "production", "isolated-development"].includes(parsed.environment) ||
    typeof parsed.hostname !== "string" ||
    !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(parsed.hostname) ||
    typeof parsed.port !== "number" ||
    !Number.isInteger(parsed.port) ||
    parsed.port < 1 ||
    parsed.port > 65535 ||
    parsed.schema !== "public" ||
    ![parsed.database, parsed.runtimeRole, parsed.migratorRole].every(
      (part) => typeof part === "string" && identifier.test(part),
    ) ||
    parsed.runtimeRole === parsed.migratorRole ||
    ["postgres", "neondb"].includes(String(parsed.database))
  ) {
    throw new AuthDatabaseIdentityError("invalid resource record");
  }
  if (
    parsed.neon !== undefined &&
    (!record(parsed.neon) ||
      !exactKeys(parsed.neon, ["projectId", "branchId"]) ||
      typeof parsed.neon.projectId !== "string" ||
      !providerId.test(parsed.neon.projectId) ||
      typeof parsed.neon.branchId !== "string" ||
      !providerId.test(parsed.neon.branchId))
  ) {
    throw new AuthDatabaseIdentityError("invalid provider identity");
  }
  if (parsed.environment !== "local" && (!parsed.neon || !parsed.hostname.endsWith(".neon.tech"))) {
    throw new AuthDatabaseIdentityError("hosted resource requires Neon identity");
  }
  const resource = parsed as AuthDatabaseResource;
  return Object.freeze({
    ...resource,
    ...(resource.neon ? { neon: Object.freeze({ ...resource.neon }) } : {}),
  });
}

function endpoint(host: string): string {
  return host.toLowerCase().replace(/-pooler(?=\.)/u, "");
}

export function assertAuthDatabaseConnection(
  connection: string,
  resource: AuthDatabaseResource,
  purpose: AuthDatabasePurpose,
): void {
  let url: URL;
  try {
    url = new URL(connection);
  } catch {
    throw new AuthDatabaseIdentityError("invalid connection");
  }
  let database: string;
  let role: string;
  try {
    database = decodeURIComponent(url.pathname.slice(1));
    role = decodeURIComponent(url.username);
  } catch {
    throw new AuthDatabaseIdentityError("invalid connection identity");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    (resource.neon
      ? endpoint(url.hostname) !== endpoint(resource.hostname)
      : url.hostname !== resource.hostname) ||
    Number(url.port || 5432) !== resource.port ||
    database !== resource.database ||
    role !== (purpose === "runtime" ? resource.runtimeRole : resource.migratorRole)
  ) {
    throw new AuthDatabaseIdentityError("connection identity mismatch");
  }
  // libpq/pg query parameters may otherwise override host, database, role or search_path.
  if (
    url.hash ||
    [...url.searchParams.keys()].some((key) => !["sslmode", "channel_binding"].includes(key)) ||
    url.searchParams.getAll("sslmode").length > 1 ||
    url.searchParams.getAll("channel_binding").length > 1
  ) {
    throw new AuthDatabaseIdentityError("connection overrides are forbidden");
  }
  if (resource.neon && url.searchParams.get("sslmode") !== "verify-full") {
    throw new AuthDatabaseIdentityError("verified TLS is required");
  }
  if (purpose === "migrator" && url.hostname.includes("-pooler.")) {
    throw new AuthDatabaseIdentityError("migration requires a direct connection");
  }
}

export function assertAuthDatabaseProvider(
  resource: AuthDatabaseResource,
  projectId: string,
  branchId: string,
): void {
  if (
    !resource.neon ||
    resource.neon.projectId !== projectId ||
    resource.neon.branchId !== branchId
  ) {
    throw new AuthDatabaseIdentityError("provider identity mismatch");
  }
}

export const REQUIRED_AUTH_TABLES = [
  "account",
  "app_actor_assignment",
  "app_signup_policy",
  "invitation",
  "member",
  "organization",
  "session",
  "user",
  "verification",
] as const;

export type AuthIdentityDatabase = {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};

/** Only catalog reads. No user/session rows, DDL, grants, or repair on this path. */
export async function verifyAuthDatabaseResource(
  database: AuthIdentityDatabase,
  resource: AuthDatabaseResource,
  purpose: AuthDatabasePurpose,
): Promise<void> {
  const identity =
    await database.query(`select pg_catalog.current_database() as database, pg_catalog.current_schema() as schema,
    current_user as role, session_user as login`);
  const row = identity.rows[0];
  const expectedRole = purpose === "runtime" ? resource.runtimeRole : resource.migratorRole;
  if (
    row?.database !== resource.database ||
    row.schema !== resource.schema ||
    row.role !== expectedRole ||
    row.login !== expectedRole
  ) {
    throw new AuthDatabaseIdentityError("database/schema/role mismatch");
  }
  if (purpose === "migrator") return;
  const capabilities = await database.query(
    `select
    exists (select 1 from pg_catalog.pg_roles r where pg_catalog.pg_has_role(session_user, r.oid, 'MEMBER')
      and (r.rolsuper or r.rolcreatedb or r.rolcreaterole or r.rolreplication or r.rolbypassrls
        or r.rolname in ('neon_superuser', 'pg_write_all_data', 'pg_read_all_data', 'pg_execute_server_program', 'pg_read_server_files', 'pg_write_server_files'))) as elevated,
    exists (select 1 from pg_catalog.pg_roles r where pg_catalog.pg_has_role(session_user, r.oid, 'MEMBER')
      and pg_catalog.has_database_privilege(r.oid, pg_catalog.current_database(), 'CREATE')) as database_create,
    exists (select 1 from pg_catalog.pg_namespace n cross join pg_catalog.pg_roles r
      where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
      and pg_catalog.pg_has_role(session_user, r.oid, 'MEMBER')
      and pg_catalog.has_schema_privilege(r.oid, n.oid, 'CREATE')) as schema_create,
    exists (select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and pg_catalog.pg_has_role(session_user, c.relowner, 'MEMBER')) as owns_objects,
    exists (select 1 from pg_catalog.pg_roles r where r.rolname = $1 and pg_catalog.pg_has_role(session_user, r.oid, 'MEMBER')) as migrator_member`,
    [resource.migratorRole],
  );
  const capability = capabilities.rows[0];
  if (
    !capability ||
    ["elevated", "database_create", "schema_create", "owns_objects", "migrator_member"].some(
      (key) => capability[key] !== false,
    )
  ) {
    throw new AuthDatabaseIdentityError("elevated runtime capability");
  }
  const tables = await database.query(
    `select c.relname as name from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname = any($1::text[])`,
    [[...REQUIRED_AUTH_TABLES]],
  );
  if (REQUIRED_AUTH_TABLES.some((name) => !tables.rows.some((table) => table.name === name))) {
    throw new AuthDatabaseIdentityError("required Auth table missing");
  }
  // Managed app tables may be absent in frozen Preview realms; when installed,
  // table, column, PUBLIC and inherited writes all violate the runtime boundary.
  const assignments = await database.query(`select
    exists (select 1 from pg_catalog.pg_roles r where pg_catalog.pg_has_role(session_user, r.oid, 'MEMBER') and (
      pg_catalog.has_table_privilege(r.oid, 'public.app_actor_assignment', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or pg_catalog.has_any_column_privilege(r.oid, 'public.app_actor_assignment', 'INSERT,UPDATE,REFERENCES'))) as assignment_write,
    exists (select 1 from pg_catalog.pg_roles r where pg_catalog.pg_has_role(session_user, r.oid, 'MEMBER') and (
      pg_catalog.has_table_privilege(r.oid, 'public.app_signup_policy', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or pg_catalog.has_any_column_privilege(r.oid, 'public.app_signup_policy', 'INSERT,UPDATE,REFERENCES'))) as signup_policy_write,
    exists (select 1 from pg_catalog.pg_roles r where pg_catalog.pg_has_role(session_user, r.oid, 'MEMBER') and (
      pg_catalog.has_table_privilege(r.oid, pg_catalog.to_regclass('public.app_actor_access'), 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or pg_catalog.has_any_column_privilege(r.oid, pg_catalog.to_regclass('public.app_actor_access'), 'INSERT,UPDATE,REFERENCES'))) as app_access_write,
    exists (select 1 from pg_catalog.pg_roles r where pg_catalog.pg_has_role(session_user, r.oid, 'MEMBER') and (
      pg_catalog.has_table_privilege(r.oid, pg_catalog.to_regclass('public.app_access_invitation'), 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or pg_catalog.has_any_column_privilege(r.oid, pg_catalog.to_regclass('public.app_access_invitation'), 'INSERT,UPDATE,REFERENCES'))) as app_invitation_write`);
  if (
    assignments.rows[0]?.assignment_write !== false ||
    assignments.rows[0]?.signup_policy_write !== false ||
    assignments.rows[0]?.app_access_write !== false ||
    assignments.rows[0]?.app_invitation_write !== false
  ) {
    throw new AuthDatabaseIdentityError("runtime can mutate operator-owned Auth records");
  }
}
