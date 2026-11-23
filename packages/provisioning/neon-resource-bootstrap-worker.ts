import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client, Pool, type PoolClient } from "pg";
import { z } from "zod";
import {
  createApprovedGeneratedAccessInspector,
  protectedGeneratedConnectionsSchema,
  type ProtectedGeneratedConnections,
  verifyProtectedConnection,
} from "../generated-app-runtime/protected-installer";
import {
  ResourceBootstrapSpoolSession,
  resourceBootstrapCredentialsSchema,
  digestResourceBootstrapCredentials,
  digestResourceBootstrapContext,
  type ProtectedInstallerFailureCode,
  type ResourceBootstrapCredentials,
  type ResourceBootstrapContext,
} from "../protected-installer/node-spool";

import {
  assertAuthOperatorConnection,
  verifyAuthOperatorConnection,
} from "../protected-installer/auth-operator";

export const NEON_RESOURCE_BOOTSTRAP_ID = "neon-resource-bootstrap-v1";
export const RESOURCE_BOOTSTRAP_EFFECTS = [
  "resources:roles",
  "resources:database",
  "resources:acl",
  "resources:retire",
] as const;

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
type CredentialBundle = ResourceBootstrapCredentials;
type SqlClient = Pick<Client, "query">;

const safeError = (code: string) => new Error(`neon_resource_bootstrap_failed:${code}`);
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const commentFor = (context: ResourceBootstrapContext, role: "migrator" | "runtime") =>
  `protected-resource:v1:${context.resource.scope}:${context.resource.resource_id}:${role}`;
const pendingDatabaseCommentFor = (context: ResourceBootstrapContext) =>
  `${commentFor(context, "migrator")}:database-create-pending:${context.resource.database}`;
const preserveFailure = (error: unknown, fallback: string) =>
  error instanceof Error && error.message.startsWith("neon_resource_bootstrap_failed:")
    ? error
    : safeError(fallback);
const databaseCommentFor = (context: ResourceBootstrapContext) =>
  `protected-resource:v1:${context.resource.scope}:${context.resource.resource_id}:database`;

function assertDirectAdminUrl(value: string, context: ResourceBootstrapContext): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw safeError("startup_rejected");
  }
  const resource = context.resource;
  let database = "";
  let role = "";
  try {
    database = decodeURIComponent(url.pathname.slice(1));
    role = decodeURIComponent(url.username);
  } catch {
    throw safeError("startup_rejected");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.hostname !== resource.hostname ||
    url.hostname.includes("-pooler.") ||
    Number(url.port || 5432) !== resource.port ||
    database !== resource.maintenance_database ||
    role !== resource.bootstrap_role ||
    url.hash ||
    [...url.searchParams.keys()].some((key) => !["sslmode", "channel_binding"].includes(key)) ||
    url.searchParams.getAll("sslmode").length !== 1 ||
    url.searchParams.getAll("channel_binding").length > 1 ||
    (url.searchParams.has("channel_binding") &&
      url.searchParams.get("channel_binding") !== "require") ||
    (resource.environment === "local"
      ? url.searchParams.get("sslmode") !== "disable"
      : url.searchParams.get("sslmode") !== "verify-full")
  ) {
    throw safeError("startup_rejected");
  }
  return url;
}

function targetConnectionUrl(
  adminUrl: URL,
  database: string,
  role: string,
  password: string,
): string {
  const url = new URL(adminUrl);
  url.username = role;
  url.password = encodeURIComponent(password);
  url.pathname = `/${database}`;
  return url.toString();
}

async function readIdentity(client: SqlClient) {
  const result = await client.query(
    `select current_database() as database, current_user as current_role,
            session_user as login_role,
            current_setting('neon.project_id', true) as project_id,
            current_setting('neon.branch_id', true) as branch_id,
            current_setting('neon.endpoint_id', true) as endpoint_id,
            r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication,
            r.rolbypassrls
     from pg_roles r where r.rolname = session_user`,
  );
  if (result.rows.length !== 1) throw safeError("database_identity_mismatch");
  return result.rows[0] as {
    database: string;
    current_role: string;
    login_role: string;
    project_id: string | null;
    branch_id: string | null;
    endpoint_id: string | null;
    rolsuper: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolreplication: boolean;
    rolbypassrls: boolean;
  };
}

async function assertAdminIdentity(client: SqlClient, context: ResourceBootstrapContext) {
  const { resource } = context;
  const actual = await readIdentity(client);
  if (
    actual.database !== resource.maintenance_database ||
    actual.current_role !== resource.bootstrap_role ||
    actual.login_role !== resource.bootstrap_role ||
    actual.rolsuper !== false ||
    actual.rolcreatedb !== true ||
    actual.rolcreaterole !== true ||
    // Managed Neon owner logins carry provider-controlled REPLICATION/BYPASSRLS.
    // Local maintenance admins and every target login keep the restricted contract.
    (resource.environment === "local" &&
      (actual.rolreplication !== false || actual.rolbypassrls !== false))
  ) {
    throw safeError("database_identity_mismatch");
  }
  if (
    resource.environment !== "local"
      ? actual.project_id !== resource.provider_project_id ||
        actual.branch_id !== resource.provider_branch_id ||
        actual.endpoint_id !== resource.provider_endpoint_id
      : actual.project_id !== null || actual.branch_id !== null || actual.endpoint_id !== null
  ) {
    throw safeError("provider_identity_mismatch");
  }
  assertNoKernelCapabilityRoleCollision(context);
  return actual;
}

function kernelCapabilityRoleNames(database: string): string[] {
  return ["execution_owner", "runtime", "schema_admin", "query"].map((capability) => {
    const raw = `${database}__public__kernel_${capability}`;
    const normalized = raw
      .toLowerCase()
      .replace(/[_\-\s]+/gu, "_")
      .replace(/[^a-z0-9_]/gu, "")
      .replace(/^_+|_+$/gu, "");
    if (Buffer.byteLength(normalized) <= 63) return normalized;
    return `${normalized.slice(0, 46)}_${createHash("md5").update(normalized).digest("hex").slice(0, 16)}`;
  });
}

function resourceAdvisoryLockKeys(context: ResourceBootstrapContext): string[] {
  return [
    `database:${context.resource.database}`,
    `role:${context.resource.migrator_role}`,
    `role:${context.resource.runtime_role}`,
  ]
    .sort()
    .map((identity) => `protected-resource-bootstrap:${identity}`);
}

function assertNoKernelCapabilityRoleCollision(context: ResourceBootstrapContext): void {
  if (
    context.resource.scope === "app_database" &&
    kernelCapabilityRoleNames(context.resource.database).some((name) =>
      [
        context.resource.migrator_role,
        context.resource.runtime_role,
        context.resource.bootstrap_role,
      ].includes(name),
    )
  ) {
    throw safeError("resource_identity_conflict");
  }
}

async function roleState(client: SqlClient, context: ResourceBootstrapContext) {
  const { resource } = context;
  const result = await client.query(
    `select r.rolname, r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole,
            r.rolreplication, r.rolbypassrls, r.rolinherit,
            pg_catalog.shobj_description(r.oid, 'pg_authid') as comment,
            exists (
              select 1 from pg_roles elevated
              where (elevated.rolname = any($3::text[]) or elevated.rolsuper
                or elevated.rolcreatedb or elevated.rolcreaterole or elevated.rolreplication
                or elevated.rolbypassrls) and elevated.oid <> r.oid
                and pg_has_role(r.oid, elevated.oid, 'MEMBER')
            ) as privileged_membership,
            exists (
              select 1 from pg_roles migrator
              where migrator.rolname=$1 and r.oid <> migrator.oid
                and pg_has_role(r.oid, migrator.oid, 'MEMBER')
            ) as migrator_membership,
            exists (
              select 1 from pg_roles member_role
              where r.rolname=$4 and member_role.oid <> r.oid
                and pg_has_role(r.oid, member_role.oid, 'MEMBER')
                and not (member_role.rolname=any($5::text[]))
            ) as unexpected_runtime_membership,
            exists (
              select 1 from pg_auth_members m
              join pg_roles granted on granted.oid=m.roleid
              where m.member=r.oid and (m.set_option or m.inherit_option)
                and not (r.rolname=$4 and granted.rolname=any($5::text[]))
                and not (r.rolname=$1 and granted.rolname=$6 and m.grantor=r.oid)
            ) as unexpected_outgoing_membership,
            exists (
              select 1 from pg_auth_members m
              join pg_roles member on member.oid=m.member
              join pg_roles grantor on grantor.oid=m.grantor
              where m.roleid=r.oid and (m.set_option or m.inherit_option)
                and not (
                  r.rolname=$1 and member.rolname=$7 and grantor.rolname=$7
                  and m.set_option and not m.inherit_option and not m.admin_option
                  and (select bool_and(exists(
                    select 1 from pg_locks l
                    where l.locktype='advisory' and l.pid=pg_backend_pid() and l.granted
                      and l.objsubid=1
                      and l.classid=((hashtextextended(key,0) >> 32) & 4294967295)::oid
                      and l.objid=(hashtextextended(key,0) & 4294967295)::oid
                  )) from unnest($8::text[]) as lock_keys(key))
                )
            ) as unexpected_incoming_membership
     from pg_roles r where r.rolname = any($2::text[]) order by r.rolname`,
    [
      resource.migrator_role,
      [resource.migrator_role, resource.runtime_role],
      [
        "neon_superuser",
        "neondb_owner",
        "pg_read_all_data",
        "pg_write_all_data",
        "pg_execute_server_program",
        "pg_read_server_files",
        "pg_write_server_files",
      ],
      resource.runtime_role,
      resource.scope === "app_database"
        ? kernelCapabilityRoleNames(resource.database).filter(
            (_name, index) => index === 1 || index === 3,
          )
        : [],
      resource.scope === "app_database" ? kernelCapabilityRoleNames(resource.database)[0] : "",
      resource.bootstrap_role,
      resourceAdvisoryLockKeys(context),
    ],
  );
  return result.rows as Array<{
    rolname: string;
    rolcanlogin: boolean;
    rolsuper: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolreplication: boolean;
    rolbypassrls: boolean;
    rolinherit: boolean;
    comment: string | null;
    privileged_membership: boolean;
    migrator_membership: boolean;
    unexpected_runtime_membership: boolean;
    unexpected_outgoing_membership: boolean;
    unexpected_incoming_membership: boolean;
  }>;
}

function assertRoleState(
  context: ResourceBootstrapContext,
  rows: Awaited<ReturnType<typeof roleState>>,
) {
  const { resource } = context;
  if (rows.length !== 2) throw safeError("resource_identity_conflict");
  const migrator = rows.find((row) => row.rolname === resource.migrator_role);
  const runtime = rows.find((row) => row.rolname === resource.runtime_role);
  const expectedMigratorComment = commentFor(context, "migrator");
  const expectedRuntimeComment = commentFor(context, "runtime");
  if (
    !migrator ||
    !runtime ||
    ![expectedMigratorComment, pendingDatabaseCommentFor(context)].includes(
      migrator.comment ?? "",
    ) ||
    runtime.comment !== expectedRuntimeComment ||
    migrator.rolcanlogin !== true ||
    migrator.rolsuper !== false ||
    migrator.rolcreatedb !== false ||
    migrator.rolcreaterole !== (resource.scope === "app_database") ||
    migrator.rolreplication !== false ||
    migrator.rolbypassrls !== false ||
    migrator.rolinherit !== true ||
    migrator.privileged_membership !== false ||
    migrator.migrator_membership !== false ||
    runtime.rolcanlogin !== true ||
    runtime.rolsuper !== false ||
    runtime.rolcreatedb !== false ||
    runtime.rolcreaterole !== false ||
    runtime.rolreplication !== false ||
    runtime.rolbypassrls !== false ||
    runtime.rolinherit !== true ||
    runtime.privileged_membership !== false ||
    runtime.migrator_membership !== false ||
    runtime.unexpected_runtime_membership !== false ||
    migrator.unexpected_outgoing_membership !== false ||
    runtime.unexpected_outgoing_membership !== false ||
    migrator.unexpected_incoming_membership !== false ||
    runtime.unexpected_incoming_membership !== false
  ) {
    throw safeError("resource_identity_conflict");
  }
  return { migrator, runtime };
}

async function createOrReadRoles(
  client: Client,
  context: ResourceBootstrapContext,
  credentials: CredentialBundle,
) {
  const before = await roleState(client, context);
  if (before.length !== 0) {
    assertRoleState(context, before);
    return { state: "no_change" as const, roles: before };
  }
  const { resource } = context;
  await client.query("begin");
  try {
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `resource-bootstrap:${resource.hostname}:${resource.port}:${resource.database}`,
    ]);
    const raced = await roleState(client, context);
    if (raced.length !== 0) {
      assertRoleState(context, raced);
      await client.query("commit");
      return { state: "no_change" as const, roles: raced };
    }
    const migratorAttributes = resource.scope === "app_database" ? "CREATEROLE" : "NOCREATEROLE";
    await client.query(
      `create role ${identifier(resource.migrator_role)} login inherit nosuperuser nocreatedb ${migratorAttributes} noreplication nobypassrls password ${literal(credentials.migratorPassword)}`,
    );
    await client.query(
      `comment on role ${identifier(resource.migrator_role)} is ${literal(commentFor(context, "migrator"))}`,
    );
    await client.query(
      `create role ${identifier(resource.runtime_role)} login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password ${literal(credentials.runtimePassword)}`,
    );
    await client.query(
      `comment on role ${identifier(resource.runtime_role)} is ${literal(commentFor(context, "runtime"))}`,
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw preserveFailure(error, "effect_failed");
  }
  const roles = await roleState(client, context);
  assertRoleState(context, roles);
  return { state: "applied" as const, roles };
}

async function databaseState(client: SqlClient, context: ResourceBootstrapContext) {
  const result = await client.query(
    `select d.datname, r.rolname as owner,
            pg_catalog.shobj_description(d.oid, 'pg_database') as comment
     from pg_database d join pg_roles r on r.oid=d.datdba where d.datname=$1`,
    [context.resource.database],
  );
  return result.rows[0] as { datname: string; owner: string; comment: string | null } | undefined;
}

async function publicNamespaceObjectCount(client: SqlClient): Promise<number> {
  const result = await client.query(
    `select count(*)::int as objects from pg_depend d
     where d.refclassid='pg_namespace'::regclass and d.refobjid='public'::regnamespace`,
  );
  return z.number().int().nonnegative().parse(result.rows[0]?.objects);
}

async function authActorsClosedOrNamespaceEmpty(input: {
  approved: ReturnType<typeof createApprovedGeneratedAccessInspector>["approved"];
  context: ResourceBootstrapContext;
  authWriterConnection: string;
  assertCurrent: () => Promise<void>;
}): Promise<boolean> {
  let auth: Client | undefined;
  try {
    const authIdentity = z
      .object({
        resourceId: z.string().min(1),
        database: z.string().min(1),
        migratorRole: z.string().min(1),
        runtimeRole: z.string().min(1),
      })
      .parse(input.approved.authDatabase);
    const authResource = {
      ...authIdentity,
      environment: input.context.resource.environment,
      hostname: input.context.resource.hostname,
      port: input.context.resource.port,
      schema: "public" as const,
    };
    if (input.approved.authOperatorRole !== undefined) {
      assertAuthOperatorConnection(
        input.authWriterConnection,
        authResource,
        input.approved.authOperatorRole,
      );
    } else {
      const url = new URL(input.authWriterConnection);
      if (
        !["postgres:", "postgresql:"].includes(url.protocol) ||
        url.hostname !== authResource.hostname ||
        url.hostname.includes("-pooler.") ||
        Number(url.port || 5432) !== authResource.port ||
        decodeURIComponent(url.pathname.slice(1)) !== authResource.database ||
        decodeURIComponent(url.username) !== authResource.migratorRole ||
        url.hash ||
        [...url.searchParams.keys()].some((key) => !["sslmode", "channel_binding"].includes(key)) ||
        url.searchParams.getAll("sslmode").length !== 1 ||
        (authResource.environment === "local"
          ? url.searchParams.get("sslmode") !== "disable"
          : url.searchParams.get("sslmode") !== "verify-full")
      )
        return false;
    }
    await input.assertCurrent();
    auth = new Client({
      connectionString: input.authWriterConnection,
      connectionTimeoutMillis: 10_000,
    });
    await auth.connect();
    await auth.query("begin read only");
    if (input.approved.authOperatorRole === undefined)
      await verifyProtectedConnection(auth as unknown as PoolClient, authResource, "migrator");
    else await verifyAuthOperatorConnection(auth, authResource, input.approved.authOperatorRole);
    await input.assertCurrent();
    const schema = await auth.query(
      `select to_regclass('public.organization') as organization,
              to_regclass('public.app_actor_assignment') as assignments,
              to_regclass('public.app_actor_access') as access`,
    );
    const organizationExists = schema.rows[0]?.organization !== null;
    const assignmentsExist = schema.rows[0]?.assignments !== null;
    await input.assertCurrent();
    if (!organizationExists && !assignmentsExist) {
      const namespace = await auth.query(
        `select pg_catalog.pg_get_userbyid(n.nspowner) as owner
         from pg_namespace n where n.nspname='public'`,
      );
      await input.assertCurrent();
      return (
        namespace.rowCount === 1 &&
        [authResource.migratorRole, "pg_database_owner"].includes(namespace.rows[0]?.owner ?? "") &&
        (await publicNamespaceObjectCount(auth)) === 0
      );
    }
    if (!organizationExists || !assignmentsExist) return false;
    const activeAssignments = await auth.query(
      `select 1 from "app_actor_assignment" where "appId"=$1 and active limit 1`,
      [input.context.app_id],
    );
    await input.assertCurrent();
    if (activeAssignments.rowCount !== 0) return false;
    if (schema.rows[0]?.access !== null) {
      const activeAccess = await auth.query(
        `select 1 from "app_actor_access" where "appId"=$1 and active limit 1`,
        [input.context.app_id],
      );
      await input.assertCurrent();
      if (activeAccess.rowCount !== 0) return false;
    }
    const catalog = await auth.query(
      `select 1 from "organization"
       where coalesce("appIds", '[]'::jsonb) ? $1 limit 1`,
      [input.context.app_id],
    );
    await input.assertCurrent();
    return catalog.rowCount === 0;
  } catch {
    return false;
  } finally {
    if (auth) {
      await auth.query("rollback").catch(() => undefined);
      await auth.end().catch(() => undefined);
    }
  }
}

/** Independent current native closure readback; actor-row lease generations are not inferred. */
async function appActorsClosed(input: {
  approved: ReturnType<typeof createApprovedGeneratedAccessInspector>["approved"];
  context: ResourceBootstrapContext;
  appMigratorConnection: string;
  assertCurrent: () => Promise<void>;
  requireEmptyNamespace?: boolean;
}): Promise<boolean> {
  let app: Client | undefined;
  try {
    const appIdentity = z
      .object({
        resourceId: z.string().min(1),
        database: z.string().min(1),
        migratorRole: z.string().min(1),
        runtimeRole: z.string().min(1),
      })
      .parse(input.approved.appDatabase);
    const appResource = {
      ...appIdentity,
      environment: input.context.resource.environment,
      hostname: input.context.resource.hostname,
      port: input.context.resource.port,
      schema: "public" as const,
    };
    const url = new URL(input.appMigratorConnection);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      url.hostname !== appResource.hostname ||
      url.hostname.includes("-pooler.") ||
      Number(url.port || 5432) !== appResource.port ||
      decodeURIComponent(url.pathname.slice(1)) !== appResource.database ||
      decodeURIComponent(url.username) !== appResource.migratorRole ||
      url.hash ||
      [...url.searchParams.keys()].some((key) => !["sslmode", "channel_binding"].includes(key)) ||
      url.searchParams.getAll("sslmode").length !== 1 ||
      (appResource.environment === "local"
        ? url.searchParams.get("sslmode") !== "disable"
        : url.searchParams.get("sslmode") !== "verify-full")
    )
      return false;
    await input.assertCurrent();
    app = new Client({
      connectionString: input.appMigratorConnection,
      connectionTimeoutMillis: 10_000,
    });
    await app.connect();
    await app.query("begin read only");
    await verifyProtectedConnection(app as unknown as PoolClient, appResource, "migrator");
    await input.assertCurrent();
    if (input.requireEmptyNamespace) {
      const namespace = await app.query(
        `select pg_catalog.pg_get_userbyid(n.nspowner) as owner
         from pg_namespace n where n.nspname='public'`,
      );
      await input.assertCurrent();
      const objects = await publicNamespaceObjectCount(app);
      await input.assertCurrent();
      return (
        namespace.rowCount === 1 &&
        [appResource.migratorRole, "pg_database_owner"].includes(namespace.rows[0]?.owner ?? "") &&
        objects === 0
      );
    }
    const membership = await app.query(
      `select to_regclass('public.kernel_actor_membership') as relation,
              to_regclass('public.kernel_actor_access') as access`,
    );
    await input.assertCurrent();
    if (membership.rows[0]?.relation === null) return false;
    const active = await app.query(
      `select 1 from "kernel_actor_membership"
       where "principal_name"=$1 and "app_id"=$2 and active limit 1`,
      [appResource.runtimeRole, input.context.app_id],
    );
    await input.assertCurrent();
    if (active.rowCount !== 0) return false;
    if (membership.rows[0]?.access !== null) {
      const access = await app.query(
        `select 1 from kernel_actor_access
         where principal_name=$1 and app_id=$2 and active limit 1`,
        [appResource.runtimeRole, input.context.app_id],
      );
      await input.assertCurrent();
      if (access.rowCount !== 0) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    if (app) {
      await app.query("rollback").catch(() => undefined);
      await app.end().catch(() => undefined);
    }
  }
}

async function retirementAccessClosed(input: {
  approved: ReturnType<typeof createApprovedGeneratedAccessInspector>["approved"];
  context: ResourceBootstrapContext;
  appMigratorConnection: string;
  authWriterConnection: string;
  assertCurrent: () => Promise<void>;
}): Promise<boolean> {
  return (
    (await appActorsClosed(input)) &&
    (await authActorsClosedOrNamespaceEmpty({
      approved: input.approved,
      context: input.context,
      authWriterConnection: input.authWriterConnection,
      assertCurrent: input.assertCurrent,
    }))
  );
}

async function grantTemporaryOwnerSet(
  client: Client,
  context: ResourceBootstrapContext,
  assertCurrent?: () => Promise<void>,
  phase: "bootstrap" | "retire" = "bootstrap",
) {
  const { bootstrap_role, migrator_role } = context.resource;
  await assertCurrent?.();
  const membership = await client.query(
    `select pg_has_role($1, $2, 'SET') as can_set,
            exists(select 1 from pg_auth_members m
                   join pg_roles granted on granted.oid=m.roleid
                   join pg_roles member on member.oid=m.member
                   join pg_roles grantor on grantor.oid=m.grantor
                   where granted.rolname=$2 and member.rolname=$1
                     and grantor.rolname=$1) as owned_membership,
            exists(select 1 from pg_auth_members m
                   join pg_roles granted on granted.oid=m.roleid
                   join pg_roles member on member.oid=m.member
                   where granted.rolname=$2 and member.rolname=$1 and m.admin_option
                     and pg_catalog.shobj_description(granted.oid,'pg_authid')=any($3::text[])) as created_role_admin,
            exists(select 1 from pg_auth_members m
                   join pg_roles granted on granted.oid=m.roleid
                   join pg_roles member on member.oid=m.member
                   where granted.rolname=$2 and member.rolname=$1) as is_member`,
    [
      bootstrap_role,
      migrator_role,
      [commentFor(context, "migrator"), pendingDatabaseCommentFor(context)],
    ],
  );
  if (membership.rows[0]?.can_set === true) {
    const migratorComment = (await roleState(client, context)).find(
      (row) => row.rolname === migrator_role,
    )?.comment;
    if (
      membership.rows[0]?.owned_membership !== true ||
      (phase === "retire"
        ? ![commentFor(context, "migrator"), pendingDatabaseCommentFor(context)].includes(
            migratorComment ?? "",
          )
        : migratorComment !== pendingDatabaseCommentFor(context))
    )
      throw safeError("resource_identity_conflict");
    return true;
  }
  if (
    membership.rows[0]?.is_member === true &&
    membership.rows[0]?.owned_membership !== true &&
    membership.rows[0]?.created_role_admin !== true
  )
    throw safeError("resource_identity_conflict");
  await assertCurrent?.();
  await client.query(
    `grant ${identifier(migrator_role)} to ${identifier(bootstrap_role)} with set true, inherit false`,
  );
  try {
    await assertCurrent?.();
    const verified = await client.query("select pg_has_role($1, $2, 'SET') as can_set", [
      bootstrap_role,
      migrator_role,
    ]);
    if (verified.rows[0]?.can_set !== true) throw safeError("database_owner_readback_failed");
  } catch (error) {
    await revokeTemporaryOwnerSet(client, context, assertCurrent);
    throw preserveFailure(error, "database_owner_readback_failed");
  }
  return true;
}

async function revokeTemporaryOwnerSet(
  client: Client,
  context: ResourceBootstrapContext,
  assertCurrent?: () => Promise<void>,
) {
  const { bootstrap_role, migrator_role } = context.resource;
  const proveWorkerLocks = async () => {
    const identities = [
      `database:${context.resource.database}`,
      `role:${context.resource.migrator_role}`,
      `role:${context.resource.runtime_role}`,
    ]
      .sort()
      .map((identity) => `protected-resource-bootstrap:${identity}`);
    const result = await client.query(
      `select bool_and(exists(
         select 1 from pg_locks l
         where l.locktype='advisory' and l.pid=pg_backend_pid() and l.granted
           and l.objsubid=1
           and l.classid=((hashtextextended(key,0) >> 32) & 4294967295)::oid
           and l.objid=(hashtextextended(key,0) & 4294967295)::oid
       )) as held from unnest($1::text[]) as locks(key)`,
      [identities],
    );
    return result.rows[0]?.held === true;
  };
  const revokeOwnedTemporaryGrant = async () => {
    await client.query("reset role");
    if (!(await proveWorkerLocks())) return false;
    const owned = await client.query(
      `select exists(
         select 1 from pg_auth_members m
         join pg_roles granted on granted.oid=m.roleid
         join pg_roles member on member.oid=m.member
         join pg_roles grantor on grantor.oid=m.grantor
         where granted.rolname=$1 and member.rolname=$2 and grantor.rolname=$2
           and m.set_option and not m.inherit_option and not m.admin_option
       ) as present`,
      [migrator_role, bootstrap_role],
    );
    if (owned.rows[0]?.present !== true) return true;
    await client.query(
      `revoke ${identifier(migrator_role)} from ${identifier(bootstrap_role)} granted by ${identifier(bootstrap_role)}`,
    );
    const remaining = await client.query(
      `select exists(
         select 1 from pg_auth_members m
         join pg_roles granted on granted.oid=m.roleid
         join pg_roles member on member.oid=m.member
         join pg_roles grantor on grantor.oid=m.grantor
         where granted.rolname=$1 and member.rolname=$2 and grantor.rolname=$2
           and m.set_option and not m.inherit_option and not m.admin_option
       ) as present`,
      [migrator_role, bootstrap_role],
    );
    return remaining.rows[0]?.present === false;
  };

  try {
    await assertCurrent?.();
    await client.query("reset role");
    await assertCurrent?.();
    await client.query(
      `revoke ${identifier(migrator_role)} from ${identifier(bootstrap_role)} granted by ${identifier(bootstrap_role)}`,
    );
    const remaining = await client.query(
      `select exists(
         select 1 from pg_auth_members m
         join pg_roles granted on granted.oid=m.roleid
         join pg_roles member on member.oid=m.member
         join pg_roles grantor on grantor.oid=m.grantor
         where granted.rolname=$1 and member.rolname=$2 and grantor.rolname=$2
           and m.set_option and not m.inherit_option and not m.admin_option
       ) as present`,
      [migrator_role, bootstrap_role],
    );
    if (remaining.rows[0]?.present !== false) throw safeError("database_owner_readback_failed");
  } catch (error) {
    if (assertCurrent === undefined) throw error;
    try {
      if (!(await revokeOwnedTemporaryGrant())) throw error;
    } catch {
      throw error;
    }
    // Roll back only this worker's exact grant while all three session locks remain held.
    // The original stale-fence or database failure still fails the operation.
    throw error;
  }
}

async function createOrReadDatabase(
  client: Client,
  context: ResourceBootstrapContext,
  assertCurrent: () => Promise<void>,
) {
  const query = async (sql: string) => {
    await assertCurrent();
    const result = await client.query(sql);
    await assertCurrent();
    return result;
  };
  const { resource } = context;
  const before = await databaseState(client, context);
  const expectedOwner = resource.migrator_role;
  const roles = await roleState(client, context);
  assertRoleState(context, roles);
  const pending =
    roles.find((role) => role.rolname === expectedOwner)?.comment ===
    pendingDatabaseCommentFor(context);
  if (
    before &&
    (before.owner !== expectedOwner ||
      (before.comment !== databaseCommentFor(context) && !(before.comment === null && pending)))
  )
    throw safeError("resource_identity_conflict");
  // Intent is physical ownership metadata, committed only after observing absence
  // under the session locks. It survives loss between CREATE DATABASE and COMMENT.
  if (!before && !pending)
    await query(
      `comment on role ${identifier(expectedOwner)} is ${literal(pendingDatabaseCommentFor(context))}`,
    );
  let temporarySet = false;
  let created = false;
  try {
    temporarySet = await grantTemporaryOwnerSet(client, context, assertCurrent);
    if (!before) {
      await query(
        `create database ${identifier(resource.database)} owner ${identifier(expectedOwner)}`,
      );
      created = true;
    }
    if (before?.comment !== databaseCommentFor(context)) {
      await query(`set role ${identifier(expectedOwner)}`);
      await query(
        `comment on database ${identifier(resource.database)} is ${literal(databaseCommentFor(context))}`,
      );
    }
  } finally {
    // Includes grants left by an interrupted worker with the same physical intent.
    if (temporarySet) await revokeTemporaryOwnerSet(client, context, assertCurrent);
    else await client.query("reset role");
  }
  const observed = await databaseState(client, context);
  if (observed?.owner !== expectedOwner || observed.comment !== databaseCommentFor(context))
    throw safeError("database_owner_readback_failed");
  await query(
    `comment on role ${identifier(expectedOwner)} is ${literal(commentFor(context, "migrator"))}`,
  );
  return {
    state:
      created || before?.comment !== databaseCommentFor(context)
        ? ("applied" as const)
        : ("no_change" as const),
  };
}

async function assertTargetRoleLogin(input: {
  url: string;
  context: ResourceBootstrapContext;
  expectedRole: "migrator" | "runtime";
  assertCurrent?: () => Promise<void>;
}) {
  const pool = new Pool({ connectionString: input.url, max: 1, connectionTimeoutMillis: 10_000 });
  try {
    await input.assertCurrent?.();
    const client = await pool.connect();
    try {
      await input.assertCurrent?.();
      const result = await client.query(
        `select current_database() as database,current_user as current_role,session_user as login_role,
                pg_catalog.pg_get_userbyid(d.datdba) as owner
         from pg_database d where d.datname=current_database()`,
      );
      await input.assertCurrent?.();
      const expected =
        input.expectedRole === "migrator"
          ? input.context.resource.migrator_role
          : input.context.resource.runtime_role;
      if (
        result.rows.length !== 1 ||
        result.rows[0]?.database !== input.context.resource.database ||
        result.rows[0]?.current_role !== expected ||
        result.rows[0]?.login_role !== expected ||
        result.rows[0]?.owner !== input.context.resource.migrator_role
      )
        throw safeError("role_login_readback_failed");
      if (input.expectedRole === "runtime") {
        await input.assertCurrent?.();
        const privilege = await client.query(
          `select r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,r.rolinherit,
                  has_database_privilege(session_user,current_database(),'CONNECT') as can_connect,
                  has_database_privilege(session_user,current_database(),'CREATE') as can_create_database,
                  has_database_privilege(session_user,current_database(),'TEMP') as can_temp,
                  has_schema_privilege(session_user,'public','USAGE') as schema_usage,
                  has_schema_privilege(session_user,'public','CREATE') as schema_create,
                  has_database_privilege('public',current_database(),'CONNECT') as public_connect,
                  has_database_privilege('public',current_database(),'TEMP') as public_temp,
                  has_schema_privilege('public','public','USAGE') as public_schema_usage,
                  has_schema_privilege('public','public','CREATE') as public_schema_create,
                  exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
                         where n.nspname='public' and pg_has_role(session_user,c.relowner,'MEMBER')) as owns_objects,
                  exists(select 1 from pg_roles m where m.rolname=$1 and pg_has_role(session_user,m.oid,'MEMBER')) as migrator_member
           from pg_roles r where r.rolname=session_user`,
          [input.context.resource.migrator_role],
        );
        await input.assertCurrent?.();
        const row = privilege.rows[0];
        if (
          !row ||
          row.rolsuper !== false ||
          row.rolcreatedb !== false ||
          row.rolcreaterole !== false ||
          row.rolreplication !== false ||
          row.rolbypassrls !== false ||
          row.rolinherit !== true ||
          row.can_connect !== true ||
          row.can_create_database !== false ||
          row.can_temp !== false ||
          row.schema_usage !== true ||
          row.schema_create !== false ||
          row.public_connect !== false ||
          row.public_temp !== false ||
          row.public_schema_usage !== false ||
          row.public_schema_create !== false ||
          row.owns_objects !== false ||
          row.migrator_member !== false
        )
          throw safeError("runtime_privilege_readback_failed");
      }
      return sha256(
        JSON.stringify({
          database: result.rows[0]?.database,
          role: result.rows[0]?.current_role,
          owner: result.rows[0]?.owner,
          purpose: input.expectedRole,
        }),
      );
    } finally {
      client.release();
    }
  } catch (error) {
    throw preserveFailure(error, "role_login_readback_failed");
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function configureAcl(
  adminClient: Client,
  context: ResourceBootstrapContext,
  credentials: CredentialBundle,
  adminUrl: URL,
) {
  const { resource } = context;
  assertRoleState(context, await roleState(adminClient, context));
  const before = await databaseState(adminClient, context);
  if (before?.owner !== resource.migrator_role || before.comment !== databaseCommentFor(context))
    throw safeError("resource_identity_conflict");

  const migratorUrl = targetConnectionUrl(
    adminUrl,
    resource.database,
    resource.migrator_role,
    credentials.migratorPassword,
  );
  const runtimeUrl = targetConnectionUrl(
    adminUrl,
    resource.database,
    resource.runtime_role,
    credentials.runtimePassword,
  );
  const migratorPool = new Pool({
    connectionString: migratorUrl,
    max: 1,
    connectionTimeoutMillis: 10_000,
  });
  let beforeHash = "";
  let afterAcl: Record<string, unknown> | undefined;
  try {
    const client = await migratorPool.connect();
    try {
      const identity = await client.query(
        `select current_database() as database,current_user as current_role,session_user as login_role,
                pg_catalog.pg_get_userbyid(d.datdba) as owner
         from pg_database d where d.datname=current_database()`,
      );
      if (
        identity.rows.length !== 1 ||
        identity.rows[0]?.database !== resource.database ||
        identity.rows[0]?.current_role !== resource.migrator_role ||
        identity.rows[0]?.login_role !== resource.migrator_role ||
        identity.rows[0]?.owner !== resource.migrator_role
      )
        throw safeError("database_owner_readback_failed");
      const currentAcl = await client.query(
        `select has_database_privilege($1,current_database(),'CONNECT') as runtime_connect,
                has_database_privilege($1,current_database(),'CREATE') as runtime_db_create,
                has_database_privilege($1,current_database(),'TEMP') as runtime_temp,
                has_schema_privilege($1,'public','USAGE') as runtime_schema_usage,
                has_schema_privilege($1,'public','CREATE') as runtime_schema_create,
                has_database_privilege('public',current_database(),'CONNECT') as public_connect,
                has_database_privilege('public',current_database(),'TEMP') as public_temp,
                has_schema_privilege('public','public','USAGE') as public_schema_usage,
                has_schema_privilege('public','public','CREATE') as public_schema_create`,
        [resource.runtime_role],
      );
      const before = currentAcl.rows[0];
      beforeHash = sha256(JSON.stringify(before));
      await client.query("begin");
      try {
        await client.query(
          `revoke all privileges on database ${identifier(resource.database)} from public`,
        );
        await client.query(
          `revoke all privileges on database ${identifier(resource.database)} from ${identifier(resource.runtime_role)}`,
        );
        await client.query(
          `grant connect on database ${identifier(resource.database)} to ${identifier(resource.runtime_role)}`,
        );
        await client.query(`revoke all privileges on schema public from public`);
        await client.query(`grant usage on schema public to ${identifier(resource.runtime_role)}`);
        await client.query(
          `revoke create on schema public from ${identifier(resource.runtime_role)}`,
        );
        await client.query("commit");
      } catch {
        await client.query("rollback").catch(() => undefined);
        throw safeError("effect_failed");
      }
      const after = await client.query(
        `select has_database_privilege($1,current_database(),'CONNECT') as runtime_connect,
                has_database_privilege($1,current_database(),'CREATE') as runtime_db_create,
                has_database_privilege($1,current_database(),'TEMP') as runtime_temp,
                has_schema_privilege($1,'public','USAGE') as runtime_schema_usage,
                has_schema_privilege($1,'public','CREATE') as runtime_schema_create,
                has_database_privilege('public',current_database(),'CONNECT') as public_connect,
                has_database_privilege('public',current_database(),'TEMP') as public_temp,
                has_schema_privilege('public','public','USAGE') as public_schema_usage,
                has_schema_privilege('public','public','CREATE') as public_schema_create`,
        [resource.runtime_role],
      );
      afterAcl = after.rows[0] as Record<string, unknown> | undefined;
    } finally {
      client.release();
    }
  } catch (error) {
    throw preserveFailure(error, "migrator_login_readback_failed");
  } finally {
    await migratorPool.end().catch(() => undefined);
  }
  const migratorDigest = await assertTargetRoleLogin({
    url: migratorUrl,
    context,
    expectedRole: "migrator",
  });
  const final = await adminClient.query(
    `select pg_catalog.pg_get_userbyid(d.datdba) as owner,
            pg_catalog.shobj_description(d.oid,'pg_database') as comment
     from pg_database d where d.datname=$1`,
    [resource.database],
  );
  if (
    final.rows[0]?.owner !== resource.migrator_role ||
    final.rows[0]?.comment !== databaseCommentFor(context)
  )
    throw safeError("database_owner_readback_failed");
  const row = afterAcl;
  if (
    !row ||
    row.runtime_connect !== true ||
    row.runtime_db_create !== false ||
    row.runtime_temp !== false ||
    row.runtime_schema_usage !== true ||
    row.runtime_schema_create !== false ||
    row.public_connect !== false ||
    row.public_temp !== false ||
    row.public_schema_usage !== false ||
    row.public_schema_create !== false
  )
    throw safeError("runtime_privilege_readback_failed");
  assertRoleState(context, await roleState(adminClient, context));
  const runtimeDigest = await assertTargetRoleLogin({
    url: runtimeUrl,
    context,
    expectedRole: "runtime",
  });
  return {
    state:
      beforeHash ===
      sha256(
        JSON.stringify({
          runtime_connect: true,
          runtime_db_create: false,
          runtime_temp: false,
          runtime_schema_usage: true,
          runtime_schema_create: false,
          public_connect: false,
          public_temp: false,
          public_schema_usage: false,
          public_schema_create: false,
        }),
      )
        ? ("no_change" as const)
        : ("applied" as const),
    digest: sha256(
      JSON.stringify({
        resourceId: resource.resource_id,
        owner: final.rows[0].owner,
        comment: final.rows[0].comment,
        acl: row,
        migratorDigest,
        runtimeDigest,
      }),
    ),
  };
}

async function recordEffect(
  session: ResourceBootstrapSpoolSession,
  effectId: (typeof RESOURCE_BOOTSTRAP_EFFECTS)[number],
  run: () => Promise<{ state: "applied" | "no_change"; digest: string }>,
): Promise<void> {
  const sequence = await session.authorize(effectId, null);
  try {
    const result = await run();
    await session.checkpoint(sequence, effectId, null, {
      state: result.state,
      readback_sha256: digestSchema.parse(result.digest),
    });
  } catch (error) {
    try {
      await session.checkpoint(sequence, effectId, null, { state: "unknown" });
    } catch (checkpointError) {
      if (
        !(
          checkpointError instanceof Error &&
          checkpointError.message === "protected_installer_readback_unknown"
        )
      )
        throw checkpointError;
    }
    throw error;
  }
}

function loadCredentials(session: ResourceBootstrapSpoolSession): CredentialBundle {
  let bytes: Buffer | undefined;
  try {
    bytes = session.readStartupFile("resource-credentials.json");
    const credentials = resourceBootstrapCredentialsSchema.parse(
      JSON.parse(bytes.toString("utf8")),
    );
    session.removeStartupFile("resource-credentials.json");
    if (
      digestResourceBootstrapCredentials(credentials) !==
      session.context.resource.credentials_sha256
    )
      throw safeError("startup_rejected");
    return credentials;
  } catch {
    session.removeStartupFile("resource-credentials.json");
    throw safeError("startup_rejected");
  } finally {
    bytes?.fill(0);
  }
}

/** Fixed source-owned SQL worker for one explicitly frozen app or Auth database resource. */
export async function runNeonResourceBootstrapWorker(input: {
  spoolDirectory: string;
  runId: string;
  timeoutMs: number;
  notices?: NodeJS.WritableStream;
}): Promise<void> {
  let session: ResourceBootstrapSpoolSession | undefined;
  let admin: Client | undefined;
  let terminal = false;
  let started = false;
  let failureCode: ProtectedInstallerFailureCode = "startup_rejected";
  let credentials: CredentialBundle | undefined;
  try {
    session = new ResourceBootstrapSpoolSession(input).open();
    const context = session.context;
    if (context.installer.id !== NEON_RESOURCE_BOOTSTRAP_ID) throw safeError("startup_rejected");
    credentials = loadCredentials(session);
    const adminUrl = assertDirectAdminUrl(session.databaseUrl, context);
    admin = new Client({ connectionString: session.databaseUrl, connectionTimeoutMillis: 10_000 });
    await admin.connect();
    const initialIdentity = await assertAdminIdentity(admin, context);
    // PostgreSQL session locks serialize standalone workers over real shared
    // database/role identities. Loss of the process releases them automatically.
    for (const identity of [
      `database:${context.resource.database}`,
      `role:${context.resource.migrator_role}`,
      `role:${context.resource.runtime_role}`,
    ].sort())
      await admin.query("select pg_advisory_lock(hashtextextended($1, 0))", [
        `protected-resource-bootstrap:${identity}`,
      ]);
    session.lifecycle.started();
    started = true;

    failureCode = "authority_denied";
    await recordEffect(session, "resources:roles", async () => {
      await assertAdminIdentity(admin!, context);
      const result = await createOrReadRoles(admin!, context, credentials!);
      return {
        state: result.state,
        digest: sha256(
          JSON.stringify({
            resourceId: context.resource.resource_id,
            scope: context.resource.scope,
            roles: result.roles.map((role) => ({
              name: role.rolname,
              login: role.rolcanlogin,
              superuser: role.rolsuper,
              createdb: role.rolcreatedb,
              createrole: role.rolcreaterole,
              replication: role.rolreplication,
              bypassRls: role.rolbypassrls,
              inherit: role.rolinherit,
              comment: role.comment,
              privilegedMembership: role.privileged_membership,
              migratorMembership: role.migrator_membership,
            })),
          }),
        ),
      };
    });

    failureCode = "authority_denied";
    await recordEffect(session, "resources:database", async () => {
      await assertAdminIdentity(admin!, context);
      const result = await createOrReadDatabase(admin!, context, () => session!.assertCurrent());
      const digest = sha256(
        JSON.stringify({
          resourceId: context.resource.resource_id,
          database: context.resource.database,
          owner: context.resource.migrator_role,
          comment: databaseCommentFor(context),
        }),
      );
      return { state: result.state, digest };
    });

    failureCode = "authority_denied";
    await recordEffect(session, "resources:acl", async () => {
      await assertAdminIdentity(admin!, context);
      const result = await configureAcl(admin!, context, credentials!, adminUrl);
      return result;
    });
    assertRoleState(context, await roleState(admin, context));
    const finalIdentity = await assertAdminIdentity(admin, context);
    if (
      JSON.stringify({
        database: initialIdentity.database,
        role: initialIdentity.login_role,
        project: initialIdentity.project_id,
        branch: initialIdentity.branch_id,
        endpoint: initialIdentity.endpoint_id,
      }) !==
      JSON.stringify({
        database: finalIdentity.database,
        role: finalIdentity.login_role,
        project: finalIdentity.project_id,
        branch: finalIdentity.branch_id,
        endpoint: finalIdentity.endpoint_id,
      })
    )
      throw safeError("provider_identity_mismatch");
    session.lifecycle.succeeded();
    terminal = true;
  } catch (error) {
    const categorized =
      error instanceof Error && /^neon_resource_bootstrap_failed:[a-z_]+$/u.test(error.message)
        ? error.message.slice("neon_resource_bootstrap_failed:".length)
        : undefined;
    if (
      categorized === "readback_unknown" ||
      categorized === "runtime_privilege_readback_failed" ||
      categorized === "database_owner_readback_failed" ||
      categorized === "role_login_readback_failed" ||
      categorized === "migrator_login_readback_failed"
    )
      failureCode = "readback_unknown";
    else if (
      categorized === "authority_denied" ||
      (error instanceof Error && error.message === "protected_installer_authority_denied")
    )
      failureCode = "authority_denied";
    else if (
      categorized === "startup_rejected" ||
      categorized === "provider_identity_mismatch" ||
      categorized === "database_identity_mismatch"
    )
      failureCode = started ? "effect_failed" : "startup_rejected";
    else if (error instanceof Error && error.message === "protected_installer_readback_unknown")
      failureCode = "readback_unknown";
    else if (error instanceof Error && /timeout/iu.test(error.message)) failureCode = "timeout";
    else if (
      error instanceof Error &&
      /protected_installer_(?:protocol|checkpoint|readback_unknown)/u.test(error.message)
    )
      failureCode = "protocol_failure";
    else if (started && failureCode === "authority_denied") failureCode = "effect_failed";
    if (session && !terminal) {
      try {
        session.lifecycle.failed(started ? failureCode : "startup_rejected");
        terminal = true;
      } catch {
        // The host treats a missing terminal notice as an unconfirmed worker result.
      }
    }
    throw new Error(`neon_resource_bootstrap_failed:${failureCode}`);
  } finally {
    credentials = undefined;
    if (admin) await admin.end().catch(() => undefined);
    session?.close();
  }
}

const inspectionFailureReasons = [
  "authority_denied",
  "database_identity_mismatch",
  "provider_identity_mismatch",
  "resource_identity_conflict",
  "role_login_readback_failed",
  "runtime_privilege_readback_failed",
  "startup_rejected",
  "effect_failed",
] as const;
const inspectionSqlStateClasses = [
  "08",
  "22",
  "23",
  "28",
  "3D",
  "3F",
  "40",
  "42",
  "53",
  "54",
  "55",
  "57",
  "58",
  "XX",
] as const;
type ResourceInspectionStage =
  | "fence"
  | "admin_identity"
  | "database_read"
  | "role_read"
  | "role_assertion"
  | "database_assertion"
  | "migrator_login"
  | "runtime_login"
  | "final_fence";
type ResourceInspectionFailure = {
  stage: ResourceInspectionStage;
  reason?: (typeof inspectionFailureReasons)[number];
  sqlStateClass?: (typeof inspectionSqlStateClasses)[number];
};

/** Project closed diagnostics only; database errors may contain private values. */
function resourceInspectionFailure(
  stage: ResourceInspectionStage,
  error: unknown,
): ResourceInspectionFailure {
  const failure: ResourceInspectionFailure = { stage };
  if (typeof error !== "object" || error === null) return failure;
  try {
    const message = Object.getOwnPropertyDescriptor(error, "message")?.value;
    const reason = inspectionFailureReasons.find(
      (value) => message === `neon_resource_bootstrap_failed:${value}`,
    );
    if (reason !== undefined) failure.reason = reason;
    const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/u.test(code)) {
      const sqlStateClass = inspectionSqlStateClasses.find((value) => value === code.slice(0, 2));
      if (sqlStateClass !== undefined) failure.sqlStateClass = sqlStateClass;
    }
  } catch {
    // A diagnostic must never change the existing unknown outcome.
  }
  return failure;
}

export type NeonResourceObservation = {
  version: 1;
  operation_id: string;
  context_digest: string;
  fence_generation: number;
  resource_id: string;
  scope: ResourceBootstrapContext["resource"]["scope"];
  status: "absent" | "applied" | "unknown";
  readback_sha256?: string;
  inspectionFailure?: ResourceInspectionFailure;
};

/** Read-only owned resource inventory. Errors and partial/foreign state remain unknown. */
export async function inspectNeonResource(input: {
  client: SqlClient;
  context: ResourceBootstrapContext;
  assertCurrent: () => Promise<void>;
  credentials?: ResourceBootstrapCredentials;
  maintenanceUrl?: string;
}): Promise<NeonResourceObservation> {
  const base = {
    version: 1 as const,
    operation_id: input.context.operation.operation_id,
    context_digest: digestResourceBootstrapContext(input.context),
    fence_generation: input.context.operation.fence_generation,
    resource_id: input.context.resource.resource_id,
    scope: input.context.resource.scope,
  };
  let inspectionStage: ResourceInspectionStage = "fence";
  try {
    await input.assertCurrent();
    inspectionStage = "admin_identity";
    await assertAdminIdentity(input.client, input.context);
    inspectionStage = "fence";
    await input.assertCurrent();
    inspectionStage = "database_read";
    const database = await databaseState(input.client, input.context);
    inspectionStage = "fence";
    await input.assertCurrent();
    inspectionStage = "role_read";
    const roles = await roleState(input.client, input.context);
    inspectionStage = "fence";
    await input.assertCurrent();
    if (database === undefined && roles.length === 0) {
      return {
        ...base,
        status: "absent",
        readback_sha256: sha256(JSON.stringify({ database: null, roles: [] })),
      };
    }
    inspectionStage = "role_assertion";
    assertRoleState(input.context, roles);
    inspectionStage = "database_assertion";
    if (
      database?.owner !== input.context.resource.migrator_role ||
      database.comment !== databaseCommentFor(input.context)
    )
      throw safeError("resource_identity_conflict");
    if (!input.credentials || !input.maintenanceUrl) throw safeError("startup_rejected");
    const adminUrl = assertDirectAdminUrl(input.maintenanceUrl, input.context);
    inspectionStage = "migrator_login";
    const migratorDigest = await assertTargetRoleLogin({
      url: targetConnectionUrl(
        adminUrl,
        input.context.resource.database,
        input.context.resource.migrator_role,
        input.credentials.migratorPassword,
      ),
      context: input.context,
      expectedRole: "migrator",
      assertCurrent: input.assertCurrent,
    });
    inspectionStage = "runtime_login";
    const runtimeDigest = await assertTargetRoleLogin({
      url: targetConnectionUrl(
        adminUrl,
        input.context.resource.database,
        input.context.resource.runtime_role,
        input.credentials.runtimePassword,
      ),
      context: input.context,
      expectedRole: "runtime",
      assertCurrent: input.assertCurrent,
    });
    inspectionStage = "final_fence";
    await input.assertCurrent();
    return {
      ...base,
      status: "applied",
      readback_sha256: sha256(JSON.stringify({ database, roles, migratorDigest, runtimeDigest })),
    };
  } catch (error) {
    return {
      ...base,
      status: "unknown",
      inspectionFailure: resourceInspectionFailure(inspectionStage, error),
    };
  }
}

export type NeonResourceRetirement = NeonResourceObservation & {
  databaseAbsent: boolean;
  retainedRoles: Array<{
    name: string;
    reason: "no_exclusive_owner_proof" | "remaining_dependencies";
    globalAuthority: boolean;
  }>;
};

export type NeonResourceRetiredObservation = Omit<NeonResourceObservation, "status"> & {
  status: "applied" | "retryable" | "unknown";
  databaseAbsent: boolean;
  authActorsClosed: boolean;
  retainedRoles: NeonResourceRetirement["retainedRoles"];
};

type RetirementConnections = ProtectedGeneratedConnections;
const authWriterConnection = (connections: RetirementConnections) =>
  "authOperator" in connections ? connections.authOperator : connections.authMigrator;

/** Delete only the tagged app resource after independent kernel-close and Auth-revocation readback. */
export async function retireNeonResource(input: {
  client: Client;
  context: ResourceBootstrapContext;
  approvedPlan: unknown;
  connections: RetirementConnections;
  releaseDirectory: string;
  assertCurrent: () => Promise<void>;
}): Promise<NeonResourceRetirement> {
  const { client, context, assertCurrent } = input;
  if (context.resource.scope !== "app_database") throw safeError("shared_auth_retained");
  const { approved } = createApprovedGeneratedAccessInspector(input);
  if (approved.action !== "cleanup") throw safeError("authority_denied");
  const resourcesWorker = z
    .object({ reference: z.literal(NEON_RESOURCE_BOOTSTRAP_ID), sha256: digestSchema })
    .parse(z.object({ resourcesWorker: z.unknown() }).parse(input.approvedPlan).resourcesWorker);
  if (
    resourcesWorker.sha256 !== context.installer.sha256 ||
    context.installer.id !== NEON_RESOURCE_BOOTSTRAP_ID
  )
    throw safeError("startup_rejected");
  const query = async (sql: string, params?: unknown[]) => {
    await assertCurrent();
    const result = await client.query(sql, params);
    await assertCurrent();
    return result;
  };
  await assertCurrent();
  await assertAdminIdentity(client, context);
  await assertCurrent();
  let database = await databaseState(client, context);
  await assertCurrent();
  const roles = await roleState(client, context);
  await assertCurrent();
  // Role names alone do not prove ownership, including during interrupted cleanup.
  for (const row of roles) {
    const role = row.rolname === context.resource.migrator_role ? "migrator" : "runtime";
    const pendingBootstrapState =
      role === "migrator" &&
      row.comment === pendingDatabaseCommentFor(context) &&
      (!database ||
        (database.owner === context.resource.migrator_role && database.comment === null));
    if (
      (row.comment !== commentFor(context, role) && !pendingBootstrapState) ||
      row.rolsuper ||
      row.rolreplication ||
      row.rolbypassrls ||
      row.rolcreatedb ||
      row.privileged_membership ||
      row.unexpected_outgoing_membership ||
      row.unexpected_incoming_membership
    )
      throw safeError("resource_identity_conflict");
  }
  if (
    database &&
    (database.owner !== context.resource.migrator_role ||
      (database.comment !== databaseCommentFor(context) &&
        !(
          database.comment === null &&
          roles.some(
            (row) =>
              row.rolname === context.resource.migrator_role &&
              row.comment === pendingDatabaseCommentFor(context),
          )
        )))
  )
    throw safeError("resource_identity_conflict");
  const pending =
    database?.comment === null &&
    roles.some(
      (row) =>
        row.rolname === context.resource.migrator_role &&
        row.comment === pendingDatabaseCommentFor(context),
    );
  await assertCurrent();
  const closed = database
    ? pending
      ? (await appActorsClosed({
          approved,
          context,
          appMigratorConnection: input.connections.appMigrator,
          assertCurrent,
          requireEmptyNamespace: true,
        })) &&
        (await authActorsClosedOrNamespaceEmpty({
          approved,
          context,
          authWriterConnection: authWriterConnection(input.connections),
          assertCurrent,
        }))
        ? ("applied" as const)
        : ("incomplete" as const)
      : (await retirementAccessClosed({
            approved,
            context,
            appMigratorConnection: input.connections.appMigrator,
            authWriterConnection: authWriterConnection(input.connections),
            assertCurrent,
          }))
        ? ("applied" as const)
        : ("incomplete" as const)
    : (await authActorsClosedOrNamespaceEmpty({
          approved,
          context,
          authWriterConnection: authWriterConnection(input.connections),
          assertCurrent,
        }))
      ? ("applied" as const)
      : ("incomplete" as const);
  await assertCurrent();
  if (closed !== "applied") throw safeError("cleanup_prerequisites_incomplete");
  if (database) {
    assertRoleState(context, roles);
    const temporarySet = await grantTemporaryOwnerSet(client, context, assertCurrent, "retire");
    try {
      await query(`set role ${identifier(context.resource.migrator_role)}`);
      await query(`drop database ${identifier(context.resource.database)}`);
    } finally {
      if (temporarySet) await revokeTemporaryOwnerSet(client, context, assertCurrent);
    }
    database = await databaseState(client, context);
    await assertCurrent();
    if (database) throw safeError("database_owner_readback_failed");
  }
  const retainedRoles: NeonResourceRetirement["retainedRoles"] = [];
  const retirementOrder = [...roles].sort((left, right) =>
    left.rolname === context.resource.runtime_role
      ? -1
      : right.rolname === context.resource.runtime_role
        ? 1
        : 0,
  );
  for (const row of retirementOrder) {
    const dependencies = await query(
      `select count(*)::int as count from pg_shdepend where refclassid='pg_authid'::regclass and refobjid=(select oid from pg_roles where rolname=$1)`,
      [row.rolname],
    );
    if (dependencies.rows[0]?.count !== 0) {
      const memberships = await query(
        `select granted.rolname as role,grantor.rolname as grantor from pg_auth_members m join pg_roles granted on granted.oid=m.roleid join pg_roles grantor on grantor.oid=m.grantor join pg_roles member on member.oid=m.member where member.rolname=$1 and (m.set_option or m.inherit_option)`,
        [row.rolname],
      );
      if (
        memberships.rows.some(
          (membership) =>
            membership.grantor !== context.resource.migrator_role ||
            !roles.some((owned) => owned.rolname === context.resource.migrator_role),
        )
      )
        throw safeError("remaining_role_authority");
      for (const membership of memberships.rows) {
        const temporarySet = await grantTemporaryOwnerSet(client, context, assertCurrent, "retire");
        try {
          await query(`set role ${identifier(context.resource.migrator_role)}`);
          await query(
            `revoke ${identifier(z.string().parse(membership.role))} from ${identifier(row.rolname)} granted by ${identifier(context.resource.migrator_role)}`,
          );
        } finally {
          if (temporarySet) await revokeTemporaryOwnerSet(client, context, assertCurrent);
        }
      }
      await query(`alter role ${identifier(row.rolname)} nologin nocreaterole`);
      const closedRole = await query(
        `select r.rolcanlogin,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,
        exists(select 1 from pg_auth_members m where (m.member=r.oid or m.roleid=r.oid) and (m.set_option or m.inherit_option)) as unexpected_membership,
        exists(select 1 from pg_stat_activity a where a.usename=r.rolname) as active_sessions
        from pg_roles r where r.rolname=$1`,
        [row.rolname],
      );
      const observed = closedRole.rows[0];
      if (!observed || Object.values(observed).some((value) => value !== false))
        throw safeError("remaining_role_authority");
      const remainingDependencies = await query(
        `select count(*)::int as count from pg_shdepend where refclassid='pg_authid'::regclass and refobjid=(select oid from pg_roles where rolname=$1)`,
        [row.rolname],
      );
      if (remainingDependencies.rows[0]?.count === 0) {
        await query(`drop role ${identifier(row.rolname)}`);
        continue;
      }
      retainedRoles.push({
        name: row.rolname,
        reason: "remaining_dependencies",
        globalAuthority: false,
      });
      continue;
    }
    await query(`drop role ${identifier(row.rolname)}`);
    const remaining = await query("select 1 from pg_roles where rolname=$1", [row.rolname]);
    if (remaining.rowCount !== 0) throw safeError("readback_unknown");
  }
  const capabilities = await query(
    `select rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls from pg_roles where rolname=any($1::text[]) order by rolname`,
    [kernelCapabilityRoleNames(context.resource.database)],
  );
  for (const row of capabilities.rows)
    retainedRoles.push({
      name: z.string().parse(row.rolname),
      reason: "no_exclusive_owner_proof",
      globalAuthority: [
        row.rolsuper,
        row.rolcreatedb,
        row.rolcreaterole,
        row.rolreplication,
        row.rolbypassrls,
      ].some((value) => value === true),
    });
  await assertCurrent();
  const finalDatabase = await databaseState(client, context);
  await assertCurrent();
  if (finalDatabase) throw safeError("readback_unknown");
  const facts = { databaseAbsent: true, retainedRoles };
  return {
    version: 1,
    operation_id: context.operation.operation_id,
    context_digest: digestResourceBootstrapContext(context),
    fence_generation: context.operation.fence_generation,
    resource_id: context.resource.resource_id,
    scope: context.resource.scope,
    status: "applied",
    ...facts,
    readback_sha256: sha256(JSON.stringify(facts)),
  };
}

/** Read-only native proof of an already-retired or safely retryable app resource. */
export async function inspectRetiredNeonResource(input: {
  client: Client;
  context: ResourceBootstrapContext;
  approvedPlan: unknown;
  connections: RetirementConnections;
  releaseDirectory: string;
  assertCurrent: () => Promise<void>;
}): Promise<NeonResourceRetiredObservation> {
  const { client, context, assertCurrent } = input;
  const base = {
    version: 1 as const,
    operation_id: context.operation.operation_id,
    context_digest: digestResourceBootstrapContext(context),
    fence_generation: context.operation.fence_generation,
    resource_id: context.resource.resource_id,
    scope: context.resource.scope,
  };
  const unknown = (databaseAbsent: boolean): NeonResourceRetiredObservation => {
    const facts = { databaseAbsent, authActorsClosed: false, retainedRoles: [] };
    return {
      ...base,
      status: "unknown",
      ...facts,
      readback_sha256: sha256(JSON.stringify(facts)),
    };
  };
  try {
    if (context.resource.scope !== "app_database") return unknown(false);
    const { approved } = createApprovedGeneratedAccessInspector(input);
    if (approved.action !== "cleanup") return unknown(false);
    const resourcesWorker = z
      .object({ reference: z.literal(NEON_RESOURCE_BOOTSTRAP_ID), sha256: digestSchema })
      .parse(z.object({ resourcesWorker: z.unknown() }).parse(input.approvedPlan).resourcesWorker);
    if (
      resourcesWorker.sha256 !== context.installer.sha256 ||
      context.installer.id !== NEON_RESOURCE_BOOTSTRAP_ID
    )
      return unknown(false);

    await assertCurrent();
    const database = await databaseState(client, context);
    await assertCurrent();
    const roles = await roleState(client, context);
    await assertCurrent();
    const capabilities = await client.query(
      `select r.rolname,r.rolcanlogin,r.rolsuper,r.rolcreatedb,r.rolcreaterole,
              r.rolreplication,r.rolbypassrls,r.rolinherit,
              exists(select 1 from pg_stat_activity a where a.usename=r.rolname) as active_sessions,
              exists(select 1 from pg_auth_members m where (m.member=r.oid or m.roleid=r.oid) and (m.set_option or m.inherit_option)) as enabled_membership
       from pg_roles r where r.rolname=any($1::text[]) order by r.rolname`,
      [kernelCapabilityRoleNames(context.resource.database)],
    );
    await assertCurrent();

    if (database) {
      const pendingDatabase =
        database.comment === null &&
        roles.some(
          (row) =>
            row.rolname === context.resource.migrator_role &&
            row.comment === pendingDatabaseCommentFor(context),
        );
      if (
        database.owner !== context.resource.migrator_role ||
        (database.comment !== databaseCommentFor(context) && !pendingDatabase)
      )
        return unknown(false);
      assertRoleState(context, roles);
      const closed = pendingDatabase
        ? (await appActorsClosed({
            approved,
            context,
            appMigratorConnection: input.connections.appMigrator,
            assertCurrent,
            requireEmptyNamespace: true,
          })) &&
          (await authActorsClosedOrNamespaceEmpty({
            approved,
            context,
            authWriterConnection: authWriterConnection(input.connections),
            assertCurrent,
          }))
          ? "applied"
          : "incomplete"
        : (await retirementAccessClosed({
              approved,
              context,
              appMigratorConnection: input.connections.appMigrator,
              authWriterConnection: authWriterConnection(input.connections),
              assertCurrent,
            }))
          ? "applied"
          : "incomplete";
      await assertCurrent();
      if (closed !== "applied") return unknown(false);
      return {
        ...base,
        status: "retryable",
        databaseAbsent: false,
        authActorsClosed: true,
        retainedRoles: [],
        readback_sha256: sha256(
          JSON.stringify({ databaseAbsent: false, authActorsClosed: true, retainedRoles: [] }),
        ),
      };
    }

    const authClosed = await authActorsClosedOrNamespaceEmpty({
      approved,
      context,
      authWriterConnection: authWriterConnection(input.connections),
      assertCurrent,
    });
    await assertCurrent();
    if (!authClosed) return unknown(true);
    const retainedRoles: NeonResourceRetirement["retainedRoles"] = [];
    for (const row of roles) {
      const expectedComment =
        row.rolname === context.resource.migrator_role
          ? commentFor(context, "migrator")
          : commentFor(context, "runtime");
      const pendingMigrator =
        row.rolname === context.resource.migrator_role &&
        row.comment === pendingDatabaseCommentFor(context);
      if (
        (row.comment !== expectedComment && !pendingMigrator) ||
        row.rolcanlogin ||
        row.rolsuper ||
        row.rolcreatedb ||
        row.rolcreaterole ||
        row.rolreplication ||
        row.rolbypassrls ||
        row.privileged_membership ||
        row.migrator_membership ||
        row.unexpected_runtime_membership ||
        row.unexpected_outgoing_membership ||
        row.unexpected_incoming_membership
      )
        return unknown(true);
      const access = await client.query(
        `select exists(select 1 from pg_auth_members m where (m.member=(select oid from pg_roles where rolname=$1) or m.roleid=(select oid from pg_roles where rolname=$1)) and (m.set_option or m.inherit_option)) as enabled_membership,
                exists(select 1 from pg_stat_activity a where a.usename=$1) as active_sessions,
                count(d.objid)::int as dependencies
         from pg_shdepend d where d.refclassid='pg_authid'::regclass
           and d.refobjid=(select oid from pg_roles where rolname=$1)`,
        [row.rolname],
      );
      await assertCurrent();
      if (access.rows[0]?.enabled_membership !== false || access.rows[0]?.active_sessions !== false)
        return unknown(true);
      retainedRoles.push({
        name: row.rolname,
        reason: "remaining_dependencies",
        globalAuthority: false,
      });
    }
    for (const role of capabilities.rows) {
      const globalAuthority = [
        role.rolsuper,
        role.rolcreatedb,
        role.rolcreaterole,
        role.rolreplication,
        role.rolbypassrls,
      ].some((value) => value === true);
      retainedRoles.push({
        name: z.string().parse(role.rolname),
        reason: "no_exclusive_owner_proof",
        globalAuthority,
      });
    }
    const facts = { databaseAbsent: true, authActorsClosed: true, retainedRoles };
    return {
      ...base,
      status: "applied",
      ...facts,
      readback_sha256: sha256(JSON.stringify(facts)),
    };
  } catch {
    return unknown(false);
  }
}

/** Fixed read-only command verifies retirement or safe retry without issuing effect receipts. */
export async function runNeonResourceInspectRetiredWorker(input: {
  spoolDirectory: string;
  runId: string;
  timeoutMs: number;
  releaseDirectory: string;
  notices?: NodeJS.WritableStream;
}): Promise<NeonResourceRetiredObservation> {
  const session = new ResourceBootstrapSpoolSession(input);
  let client: Client | undefined;
  let planBytes: Buffer | undefined;
  let connectionBytes: Buffer | undefined;
  let started = false;
  let terminal = false;
  try {
    session.open();
    const context = session.context;
    if (
      context.installer.id !== NEON_RESOURCE_BOOTSTRAP_ID ||
      sha256(readFileSync(process.execPath)) !== context.installer.sha256 ||
      context.resource.scope !== "app_database"
    )
      throw safeError("startup_rejected");
    assertDirectAdminUrl(session.databaseUrl, context);
    planBytes = session.readStartupFile("approved-access-plan.json");
    connectionBytes = session.readStartupFile("access-connections.json");
    const approvedPlan: unknown = JSON.parse(planBytes.toString("utf8"));
    const connections = protectedGeneratedConnectionsSchema.parse(
      JSON.parse(connectionBytes.toString("utf8")),
    );
    createApprovedGeneratedAccessInspector({
      approvedPlan,
      context,
      connections,
      releaseDirectory: input.releaseDirectory,
      assertCurrent: () => session.assertCurrent(),
    });
    session.removeStartupFile("approved-access-plan.json");
    session.removeStartupFile("access-connections.json");
    await session.assertCurrent();
    client = new Client({ connectionString: session.databaseUrl, connectionTimeoutMillis: 10_000 });
    await client.connect();
    for (const identity of [
      `database:${context.resource.database}`,
      `role:${context.resource.migrator_role}`,
      `role:${context.resource.runtime_role}`,
    ].sort()) {
      await session.assertCurrent();
      await client.query("select pg_advisory_lock(hashtextextended($1,0))", [
        `protected-resource-bootstrap:${identity}`,
      ]);
      await session.assertCurrent();
    }
    session.lifecycle.started();
    started = true;
    const result = await inspectRetiredNeonResource({
      client,
      context,
      approvedPlan,
      connections,
      releaseDirectory: input.releaseDirectory,
      assertCurrent: () => session.assertCurrent(),
    });
    writeFileSync(
      path.join(input.spoolDirectory, "resource-observation.json"),
      JSON.stringify(result),
      { mode: 0o600 },
    );
    if (result.status === "unknown") throw safeError("readback_unknown");
    session.lifecycle.succeeded();
    terminal = true;
    return result;
  } catch (error) {
    if (!terminal) {
      try {
        session.lifecycle.failed(started ? "readback_unknown" : "startup_rejected");
        terminal = true;
      } catch {
        // Missing terminal fact remains unconfirmed at the host.
      }
    }
    throw preserveFailure(error, started ? "readback_unknown" : "startup_rejected");
  } finally {
    planBytes?.fill(0);
    connectionBytes?.fill(0);
    session.removeStartupFile("approved-access-plan.json");
    session.removeStartupFile("access-connections.json");
    if (client) await client.end().catch(() => undefined);
    session.close();
  }
}

/** Fixed mutating resource command; startup secrets stay private and every DDL has a fresh fence. */
export async function runNeonResourceRetireWorker(input: {
  spoolDirectory: string;
  runId: string;
  timeoutMs: number;
  releaseDirectory: string;
  notices?: NodeJS.WritableStream;
}): Promise<NeonResourceRetirement> {
  const session = new ResourceBootstrapSpoolSession(input);
  let client: Client | undefined;
  let planBytes: Buffer | undefined;
  let connectionBytes: Buffer | undefined;
  try {
    session.open();
    const context = session.context;
    if (
      context.installer.id !== NEON_RESOURCE_BOOTSTRAP_ID ||
      sha256(readFileSync(process.execPath)) !== context.installer.sha256
    )
      throw safeError("startup_rejected");
    if (context.resource.scope !== "app_database") throw safeError("shared_auth_retained");
    assertDirectAdminUrl(session.databaseUrl, context);
    planBytes = session.readStartupFile("approved-access-plan.json");
    connectionBytes = session.readStartupFile("access-connections.json");
    const approvedPlan: unknown = JSON.parse(planBytes.toString("utf8"));
    const connections = protectedGeneratedConnectionsSchema.parse(
      JSON.parse(connectionBytes.toString("utf8")),
    );
    createApprovedGeneratedAccessInspector({
      approvedPlan,
      context,
      connections,
      releaseDirectory: input.releaseDirectory,
      assertCurrent: () => session.assertCurrent(),
    });
    session.removeStartupFile("approved-access-plan.json");
    session.removeStartupFile("access-connections.json");
    await session.assertCurrent();
    client = new Client({ connectionString: session.databaseUrl, connectionTimeoutMillis: 10_000 });
    await client.connect();
    for (const identity of [
      `database:${context.resource.database}`,
      `role:${context.resource.migrator_role}`,
      `role:${context.resource.runtime_role}`,
    ].sort()) {
      await session.assertCurrent();
      await client.query("select pg_advisory_lock(hashtextextended($1,0))", [
        `protected-resource-bootstrap:${identity}`,
      ]);
      await session.assertCurrent();
    }
    session.lifecycle.started();
    let result: NeonResourceRetirement | undefined;
    await recordEffect(session, "resources:retire", async () => {
      result = await retireNeonResource({
        client: client!,
        context,
        approvedPlan,
        connections,
        releaseDirectory: input.releaseDirectory,
        assertCurrent: () => session.assertCurrent(),
      });
      return { state: "applied", digest: result.readback_sha256! };
    });
    if (!result) throw safeError("readback_unknown");
    writeFileSync(
      path.join(input.spoolDirectory, "resource-observation.json"),
      JSON.stringify(result),
      { mode: 0o600 },
    );
    session.lifecycle.succeeded();
    return result;
  } catch {
    try {
      session.lifecycle.failed("readback_unknown");
    } catch {
      /* Missing terminal fact remains unconfirmed at the host. */
    }
    throw safeError("readback_unknown");
  } finally {
    planBytes?.fill(0);
    connectionBytes?.fill(0);
    session.removeStartupFile("approved-access-plan.json");
    session.removeStartupFile("access-connections.json");
    if (client) await client.end().catch(() => undefined);
    session.close();
  }
}

/** Fixed read-only command uses the same private startup binding and nonmutating fence protocol. */
export async function runNeonResourceInspectWorker(input: {
  spoolDirectory: string;
  runId: string;
  timeoutMs: number;
  notices?: NodeJS.WritableStream;
}): Promise<NeonResourceObservation> {
  const session = new ResourceBootstrapSpoolSession(input);
  let client: Client | undefined;
  let started = false;
  let terminal = false;
  try {
    session.open();
    if (session.context.installer.id !== NEON_RESOURCE_BOOTSTRAP_ID)
      throw safeError("startup_rejected");
    assertDirectAdminUrl(session.databaseUrl, session.context);
    const credentials = loadCredentials(session);
    await session.assertCurrent();
    client = new Client({ connectionString: session.databaseUrl, connectionTimeoutMillis: 10_000 });
    await client.connect();
    session.lifecycle.started();
    started = true;
    const observed = await inspectNeonResource({
      client,
      context: session.context,
      assertCurrent: () => session.assertCurrent(),
      credentials,
      maintenanceUrl: session.databaseUrl,
    });
    writeFileSync(
      path.join(input.spoolDirectory, "resource-observation.json"),
      JSON.stringify(observed),
      { mode: 0o600 },
    );
    if (observed.status === "unknown") throw safeError("readback_unknown");
    session.lifecycle.succeeded();
    terminal = true;
    return observed;
  } catch (error) {
    if (!terminal) {
      try {
        session.lifecycle.failed(started ? "readback_unknown" : "startup_rejected");
        terminal = true;
      } catch {
        // Missing terminal fact remains unconfirmed at the host.
      }
    }
    throw preserveFailure(error, started ? "readback_unknown" : "startup_rejected");
  } finally {
    if (client) await client.end().catch(() => undefined);
    session.close();
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (
    args.length !==
      (["neon-resource-retire", "neon-resource-inspect-retired"].includes(args[0] ?? "") ? 6 : 5) ||
    ![
      "neon-resource-bootstrap",
      "neon-resource-inspect",
      "neon-resource-retire",
      "neon-resource-inspect-retired",
    ].includes(args[0] ?? "") ||
    args[1] !== "--file-spool" ||
    !args[2] ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(args[3] ?? "")
  ) {
    console.error("Neon resource bootstrap failed: startup_rejected");
    process.exit(1);
  }
  const timeoutMs = Number(args[4]);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    console.error("Neon resource bootstrap failed: startup_rejected");
    process.exit(1);
  }
  if (args[0] === "neon-resource-retire") {
    if (!args[5]) {
      console.error("Neon resource bootstrap failed: startup_rejected");
      process.exit(1);
    }
    await runNeonResourceRetireWorker({
      spoolDirectory: args[2]!,
      runId: args[3]!,
      timeoutMs,
      releaseDirectory: args[5]!,
    }).catch(() => {
      console.error("Neon resource bootstrap failed: readback_unknown");
      process.exit(1);
    });
    process.exit(0);
  }
  if (args[0] === "neon-resource-inspect-retired") {
    if (!args[5]) {
      console.error("Neon resource bootstrap failed: startup_rejected");
      process.exit(1);
    }
    await runNeonResourceInspectRetiredWorker({
      spoolDirectory: args[2]!,
      runId: args[3]!,
      timeoutMs,
      releaseDirectory: args[5]!,
    }).catch((error) => {
      console.error(
        `Neon resource bootstrap failed: ${error instanceof Error ? error.message : "readback_unknown"}`,
      );
      process.exit(1);
    });
    process.exit(0);
  }
  const run =
    args[0] === "neon-resource-inspect"
      ? runNeonResourceInspectWorker
      : runNeonResourceBootstrapWorker;
  await run({
    spoolDirectory: args[2]!,
    runId: args[3]!,
    timeoutMs,
  }).catch((error) => {
    const failure =
      error instanceof Error && /^neon_resource_bootstrap_failed:[a-z_]+$/u.test(error.message)
        ? error.message.slice("neon_resource_bootstrap_failed:".length)
        : "effect_failed";
    console.error(`Neon resource bootstrap failed: ${failure}`);
    process.exit(1);
  });
}
