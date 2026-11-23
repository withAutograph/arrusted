/** The access operator is neither a schema owner nor a browser runtime principal. */
export type AuthOperatorResource = Readonly<{
  environment?: "local" | "preview" | "production" | "isolated-development";
  hostname: string;
  port: number;
  database: string;
  schema: string;
  migratorRole: string;
  runtimeRole: string;
}>;
export type AuthOperatorDatabase = {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};

const identifier = /^[a-z][a-z0-9_]{0,62}$/u;
const reject = (): never => {
  throw new Error("auth_operator_identity_or_privilege_mismatch");
};
function assertOperatorRole(resource: AuthOperatorResource, role: string) {
  if (!identifier.test(role) || [resource.migratorRole, resource.runtimeRole].includes(role))
    reject();
}

export function assertAuthOperatorConnection(
  connection: string,
  resource: AuthOperatorResource,
  operatorRole: string,
): void {
  assertOperatorRole(resource, operatorRole);
  try {
    const url = new URL(connection);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      url.hostname !== resource.hostname ||
      url.hostname.includes("-pooler.") ||
      Number(url.port || 5432) !== resource.port ||
      decodeURIComponent(url.pathname.slice(1)) !== resource.database ||
      decodeURIComponent(url.username) !== operatorRole ||
      url.hash ||
      [...url.searchParams.keys()].some((key) => !["sslmode", "channel_binding"].includes(key)) ||
      url.searchParams.getAll("sslmode").length !== 1 ||
      url.searchParams.getAll("channel_binding").length > 1 ||
      (url.searchParams.has("channel_binding") &&
        url.searchParams.get("channel_binding") !== "require") ||
      (resource.environment === "local"
        ? resource.hostname !== "127.0.0.1" || url.searchParams.get("sslmode") !== "disable"
        : ["127.0.0.1", "localhost"].includes(resource.hostname) ||
          url.searchParams.get("sslmode") !== "verify-full")
    )
      reject();
  } catch {
    reject();
  }
}

const columns = (value: string) => value.split(",");
/** Maximum effective column privileges. Actual commands prove required privileges as they run. */
const allowedColumns: Record<
  string,
  Partial<Record<"select" | "insert" | "update", readonly string[] | "*">>
> = {
  user: { select: columns("id,name,email,emailVerified") },
  session: {
    select: columns("id,userId,expiresAt,activeOrganizationId"),
    update: columns("activeOrganizationId,updatedAt"),
  },
  member: { select: columns("id,organizationId,userId,role") },
  organization: { select: columns("id,appIds"), update: columns("appIds") },
  app_actor_assignment: {
    select: "*",
    insert: columns("organizationId,actorId,appId,role,active,fence_generation"),
    update: columns("active,fence_generation,assignedAt"),
  },
  app_actor_access: {
    select: "*",
    insert: columns("organizationId,actorId,appId,workspaceId,active,fenceGeneration,roles"),
    update: columns("active,fenceGeneration,roles"),
  },
  app_signup_policy: {
    select: "*",
    insert: columns(
      "id,authResourceId,resourceDigest,appId,origin,appPath,organizationId,eligibility,allowedEmails,membershipRole,appRoles,operationRef,planDigest,policyDigest,fenceGeneration,createdAt,admissionMode,workspaceId,enabled,signupStorage",
    ),
    update: columns(
      "appPath,eligibility,allowedEmails,appRoles,signupStorage,operationRef,planDigest,policyDigest,fenceGeneration,enabled",
    ),
  },
  app_access_invitation: {
    select: "*",
    insert: columns(
      "id,workspaceId,resourceDigest,appId,organizationId,email,roles,returnUrl,operationRef,planDigest,scopeDigest,fenceGeneration,expiresAt",
    ),
    update: columns(
      "id,status,fenceGeneration,expiresAt,deliveryStatus,deliveryAttemptId,deliveryProviderId,verifiedActorId,verifiedSessionId,verifiedAt,linkedFromInvitationId,signupGrantFence,signupGrantOperationRef,signupGrantFences",
    ),
  },
};

export async function verifyAuthOperatorConnection(
  database: AuthOperatorDatabase,
  resource: AuthOperatorResource,
  operatorRole: string,
): Promise<void> {
  assertOperatorRole(resource, operatorRole);
  const identity = await database.query(
    "select current_database() as database,current_schema() as schema,current_user as role,session_user as login",
  );
  const row = identity.rows[0];
  if (
    row?.database !== resource.database ||
    row.schema !== resource.schema ||
    row.role !== operatorRole ||
    row.login !== operatorRole
  )
    reject();
  const capabilities = await database.query(
    `select
    exists(select 1 from pg_roles where rolname=session_user and
      (rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)) as elevated,
    exists(select 1 from pg_roles r where r.rolname<>session_user and pg_has_role(session_user,r.oid,'MEMBER')) as membership,
    exists(select 1 from pg_auth_members m join pg_roles r on r.oid=m.member
      where m.roleid=(session_user::regrole)::oid and not (
        r.rolname=$1 and m.admin_option and not m.inherit_option and not m.set_option)) as delegated_role,
    exists(select 1 from pg_database where datname=current_database() and pg_get_userbyid(datdba)=session_user) as owns_database,
    has_database_privilege(session_user,current_database(),'CREATE') as database_create,
    exists(select 1 from pg_namespace n where n.nspname !~ '^pg_' and n.nspname<>'information_schema'
      and (pg_get_userbyid(n.nspowner)=session_user or has_schema_privilege(session_user,n.oid,'CREATE'))) as schema_create,
    (exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname !~ '^pg_' and n.nspname<>'information_schema' and pg_get_userbyid(c.relowner)=session_user)
     or exists(select 1 from pg_proc p where pg_get_userbyid(p.proowner)=session_user)) as owns_objects,
    exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname !~ '^pg_' and n.nspname<>'information_schema'
        and case when c.relkind='S' then has_sequence_privilege(session_user,c.oid,'USAGE,SELECT,UPDATE') else false end) as sequence_access`,
    [resource.migratorRole],
  );
  if (!capabilities.rows[0] || Object.values(capabilities.rows[0]).some((value) => value !== false))
    reject();
  const privileges =
    await database.query(`select n.nspname as schema,c.relname as table,a.attname as column,
    has_column_privilege(session_user,c.oid,a.attnum,'SELECT') as "select",
    has_column_privilege(session_user,c.oid,a.attnum,'INSERT') as "insert",
    has_column_privilege(session_user,c.oid,a.attnum,'UPDATE') as "update",
    has_column_privilege(session_user,c.oid,a.attnum,'REFERENCES') as reference,
    has_table_privilege(session_user,c.oid,'DELETE,TRUNCATE,REFERENCES,TRIGGER') as other_write
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
    where c.relkind in ('r','p','v','m','f') and n.nspname !~ '^pg_' and n.nspname<>'information_schema'`);
  for (const privilege of privileges.rows) {
    if (privilege.reference !== false || privilege.other_write !== false) reject();
    for (const operation of ["select", "insert", "update"] as const) {
      if (privilege[operation] !== true) continue;
      const allowed =
        privilege.schema === "public"
          ? allowedColumns[String(privilege.table)]?.[operation]
          : undefined;
      if (allowed !== "*" && !allowed?.includes(String(privilege.column))) reject();
    }
  }
  const functions = await database.query(`select n.nspname as schema,p.proname as name,
      pg_get_userbyid(p.proowner) as owner,oidvectortypes(p.proargtypes) as arguments,
      p.proconfig as configuration
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname !~ '^pg_' and n.nspname<>'information_schema'
      and has_schema_privilege(session_user,n.oid,'USAGE')
      and p.prosecdef and has_function_privilege(session_user,p.oid,'EXECUTE')`);
  const helpers: Record<string, string> = {
    lock_auth_operator_user: "text",
    lock_auth_operator_member: "text, text",
    insert_auth_operator_member: "text, text, text",
  };
  for (const fn of functions.rows) {
    const signature = helpers[String(fn.name)];
    if (
      !signature ||
      fn.schema !== "public" ||
      fn.owner !== resource.migratorRole ||
      !Array.isArray(fn.configuration) ||
      !fn.configuration.includes("search_path=pg_catalog, public") ||
      fn.arguments !== signature
    )
      reject();
  }
}
