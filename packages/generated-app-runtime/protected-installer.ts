import {
  assertProtectedConnection,
  verifyDatabaseConnection,
  verifyRuntimeRolePrivileges,
} from "../protected-installer/database-target";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse } from "@libpg-query/parser";
import { Pool, type PoolClient } from "pg";
import { z } from "zod";
import appBaseActivationSql from "../schema-compiler/src/sql_runtime/app_base_activation.sql" with { type: "text" };
import appBaseContinuationSql from "../schema-compiler/src/sql_runtime/app_base_continuation.sql" with { type: "text" };
import { installGeneratedAppRuntime, verifyCheckedRelease } from "./server";
import {
  assertAuthOperatorConnection,
  verifyAuthOperatorConnection,
} from "../protected-installer/auth-operator";
import { verifyCheckedReleaseMembers } from "./release-verification";
import {
  installOnlineSchema,
  readOnlineSchemaCandidate,
  readOnlineSchemaPlan,
  runOnlineSchemaRevisionEffect,
} from "./protected-online-schema";
import {
  ProtectedInstallerSpoolSession,
  type ProtectedInstallContext,
  type ResourceBootstrapContext,
  type ProtectedInstallerFailureCode,
} from "../protected-installer/node-spool";

import {
  classifyGeneratedInstallReadback,
  classifyGeneratedPredecessorReadback,
  classifyGeneratedInstallReconciliation,
  withProtectedTenantReadback,
  withProtectedAppCatalogReadback,
  type GeneratedInstallReadbackFacts,
  type GeneratedPredecessorReadbackFacts,
} from "./protected-installer-readback";

import {
  managedAppSignupClaimProofSchema,
  assertManagedAppSignupGrant,
  recordManagedAppSignupGrant,
  readManagedAppSignupRecordedGrant,
  managedAppSignupRecordedGrantSchema,
  type ManagedAppSignupRecordedGrant,
} from "../auth/managed-app-signup";

const id = z
  .string()
  .min(1)
  .refine((value) => !/[\p{Cc}]/u.test(value));
const sqlName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const fenceGenerationSchema = z.number().int().positive();
export const protectedDatabaseResourceSchema = z
  .strictObject({
    resourceId: id,
    environment: z.enum(["local", "preview", "production"]),
    hostname: z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u),
    port: z.number().int().min(1).max(65535),
    database: sqlName,
    schema: z.literal("public"),
    runtimeRole: sqlName,
    migratorRole: sqlName,
  })
  .refine(
    (value) =>
      value.runtimeRole !== value.migratorRole && !["postgres", "neondb"].includes(value.database),
    "Distinct application roles and database are required",
  );
export const protectedGeneratedPlanSchema = z
  .strictObject({
    version: z.literal(1),
    appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
    workspaceId: id.optional(),
    signupClaim: managedAppSignupClaimProofSchema.optional(),
    app: protectedDatabaseResourceSchema,
    auth: protectedDatabaseResourceSchema,
    authOperatorRole: sqlName.optional(),
    release: z.strictObject({ id, artifactHash: hash, manifestHash: hash }),
    installer: z.strictObject({ id, sqlBundleHash: hash }),
    organizations: z
      .array(
        z.strictObject({
          organizationId: id,
          actors: z.array(
            z.strictObject({
              actorId: id,
              actorKind: z.enum(["human", "agent"]),
              roles: z.array(id),
            }),
          ),
        }),
      )
      .min(1),
  })
  .superRefine((plan, ctx) => {
    if (
      plan.app.resourceId === plan.auth.resourceId ||
      (plan.app.hostname === plan.auth.hostname &&
        plan.app.port === plan.auth.port &&
        plan.app.database === plan.auth.database) ||
      new Set([
        plan.app.runtimeRole,
        plan.app.migratorRole,
        plan.auth.runtimeRole,
        plan.auth.migratorRole,
      ]).size !== 4
    )
      ctx.addIssue({ code: "custom", message: "App and Auth resources must be distinct" });
    if (
      plan.authOperatorRole !== undefined &&
      [
        plan.app.runtimeRole,
        plan.app.migratorRole,
        plan.auth.runtimeRole,
        plan.auth.migratorRole,
      ].includes(plan.authOperatorRole)
    )
      ctx.addIssue({
        code: "custom",
        message: "Auth operator role must be distinct from resource roles",
      });
    if (
      new Set(plan.organizations.map((entry) => entry.organizationId)).size !==
      plan.organizations.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate organization" });
    if (
      plan.signupClaim &&
      (!plan.workspaceId ||
        !plan.authOperatorRole ||
        plan.organizations.length !== 1 ||
        plan.organizations[0]?.actors.length !== 1 ||
        plan.organizations[0]?.actors[0]?.actorKind !== "human")
    ) {
      ctx.addIssue({ code: "custom", message: "Signup requires one owned human access target." });
    }
    for (const entry of plan.organizations) {
      if (entry.actors.some((actor) => actor.roles.length === 0) && !plan.workspaceId)
        ctx.addIssue({ code: "custom", message: "App admission requires its owning workspace" });
      if (
        new Set(entry.actors.map((actor) => actor.actorId)).size !== entry.actors.length ||
        entry.actors.some((actor) => new Set(actor.roles).size !== actor.roles.length)
      )
        ctx.addIssue({ code: "custom", message: "Duplicate access target" });
    }
  });
export type ProtectedGeneratedPlan = z.infer<typeof protectedGeneratedPlanSchema>;
export type ProtectedDatabaseResource = z.infer<typeof protectedDatabaseResourceSchema>;
export type ProtectedInstallerTrust = Readonly<{ id: string; sqlBundleHash: string }>;
type ConnectionPurpose = "migrator" | "runtime";
const identifier = (value: string) => `"${sqlName.parse(value)}"`;
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const reject = (): never => {
  throw new Error("protected_installer_identity_mismatch");
};

export { assertProtectedConnection } from "../protected-installer/database-target";

/** Shared direct-target/login preflight plus protected runtime privilege inspection. */
export async function verifyProtectedConnection(
  client: PoolClient,
  resource: ProtectedDatabaseResource,
  purpose: ConnectionPurpose,
): Promise<void> {
  await verifyDatabaseConnection(client, resource, purpose);
  if (purpose === "runtime") await verifyRuntimeRolePrivileges(client, resource);
}

/**
 * Trusted process capability, never an app runtime object. The outer operator owns
 * durable intent, approval, resource fences and reconciliation; this library stores no journal.
 * trust must come from reviewed operator configuration, independently of plan/release files.
 */
export function createProtectedGeneratedInstaller(input: {
  plan: ProtectedGeneratedPlan;
  trust: ProtectedInstallerTrust;
  /** Positive generation supplied by the trusted operator journal, never by the app/request plan. */
  fenceGeneration: number;
  operationRef?: string;
  releaseDirectory: string;
  connections: ProtectedGeneratedConnections;
  assertCurrent: () => Promise<void>;
  /** Explicit schema-only partition derived by the trusted approved-plan adapter; absent preserves ordinary install semantics. */
  retainedInstallationCustomerIds?: readonly string[];
  /** A trusted readback adapter exposes no install/grant/revoke capability. */
  readOnly?: boolean;
}) {
  // Copy/freeze the data contract so caller mutation cannot change effects after approval.
  const plan = protectedGeneratedPlanSchema.parse(structuredClone(input.plan));
  const readOnly = input.readOnly === true;
  const retainedInstallationCustomerIds = new Set(
    z.array(id).parse(input.retainedInstallationCustomerIds ?? []),
  );
  if (
    [...retainedInstallationCustomerIds].some(
      (customerId) =>
        !plan.organizations.some((organization) => organization.organizationId === customerId),
    )
  )
    reject();
  const trust = { ...input.trust };
  const fenceGeneration = fenceGenerationSchema.parse(input.fenceGeneration);
  const connections = protectedGeneratedConnectionsSchema.parse(input.connections);
  const signupOperationRef = plan.signupClaim ? z.uuid().parse(input.operationRef) : undefined;
  const directory = path.resolve(input.releaseDirectory);
  const assertCurrent = input.assertCurrent;
  const validateArtifact = () => {
    if (
      trust.id !== plan.installer.id ||
      trust.sqlBundleHash !== plan.installer.sqlBundleHash ||
      !/^[a-f0-9]{64}$/u.test(trust.sqlBundleHash)
    )
      reject();
    const manifest = verifyCheckedRelease(directory);
    if (
      manifest.app !== plan.appId ||
      manifest.schema_version !== plan.release.id ||
      manifest.hashes.schema !== `sha256:${plan.release.artifactHash}` ||
      sha256(readFileSync(path.join(directory, "release-manifest.json"))) !==
        plan.release.manifestHash ||
      sha256(readFileSync(path.join(directory, "sql-bundle.sql"))) !== trust.sqlBundleHash
    )
      reject();
  };
  // Reject untrusted bundles and connection identity before opening any database connection.
  validateArtifact();
  assertProtectedConnection(connections.appMigrator, plan.app, "migrator");
  assertProtectedConnection(connections.appRuntime, plan.app, "runtime");
  // The approved role selects the credential capability; never reinterpret the
  // actual Auth resource owner or silently fall back to its migration credential.
  if (plan.authOperatorRole !== undefined) {
    if (!("authOperator" in connections)) throw new Error("protected_installer_identity_mismatch");
    assertAuthOperatorConnection(connections.authOperator, plan.auth, plan.authOperatorRole);
  } else {
    if (!("authMigrator" in connections)) throw new Error("protected_installer_identity_mismatch");
    assertProtectedConnection(connections.authMigrator, plan.auth, "migrator");
  }
  assertProtectedConnection(connections.authRuntime, plan.auth, "runtime");
  const scopes = plan.organizations.flatMap((organization) =>
    organization.actors.flatMap((actor) =>
      (actor.roles.length === 0 ? [null] : actor.roles).map((role) => ({
        organizationId: organization.organizationId,
        actorId: actor.actorId,
        actorKind: actor.actorKind,
        role,
      })),
    ),
  );
  const withClient = async <T>(
    resource: ProtectedDatabaseResource,
    purpose: ConnectionPurpose,
    url: string,
    run: (client: PoolClient) => Promise<T>,
    readOnly = false,
  ): Promise<T> => {
    const pool = new Pool({
      connectionString: url,
      max: 1,
      ...(readOnly ? { options: "-c default_transaction_read_only=on" } : {}),
    });
    try {
      const client = await pool.connect();
      try {
        await verifyProtectedConnection(client, resource, purpose);
        return await run(client);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  };
  const withAuthWriter = async <T>(
    run: (auth: PoolClient) => Promise<T>,
    readOnly = false,
  ): Promise<T> => {
    if ("authMigrator" in connections)
      return withClient(plan.auth, "migrator", connections.authMigrator, run, readOnly);
    const pool = new Pool({
      connectionString: connections.authOperator,
      max: 1,
      ...(readOnly ? { options: "-c default_transaction_read_only=on" } : {}),
    });
    try {
      const client = await pool.connect();
      try {
        await verifyAuthOperatorConnection(client, plan.auth, plan.authOperatorRole!);
        return await run(client);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  };
  const verifyAuthRuntime = async (readOnly = false) => {
    await withClient(
      plan.auth,
      "runtime",
      connections.authRuntime,
      async (auth) => {
        const writable = await auth.query(
          `select has_table_privilege(session_user,'public.app_actor_assignment','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_any_column_privilege(session_user,'public.app_actor_assignment','INSERT,UPDATE,REFERENCES') as writable`,
        );
        if (writable.rows[0]?.writable !== false) reject();
        const table = await auth.query(
          "select to_regclass('public.app_actor_access') is not null as present",
        );
        if (table.rows[0]?.present) {
          const accessWritable = await auth.query(
            "select has_table_privilege(session_user,'public.app_actor_access','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_any_column_privilege(session_user,'public.app_actor_access','INSERT,UPDATE,REFERENCES') as writable",
          );
          if (accessWritable.rows[0]?.writable !== false) reject();
        }
      },
      readOnly,
    );
  };
  const withMigrators = async <T>(
    run: (app: PoolClient, auth: PoolClient) => Promise<T>,
    readOnly = false,
  ) => {
    validateArtifact();
    await assertCurrent();
    // Runtime capability checks happen before the first mutating connection is handed out.
    await withClient(plan.app, "runtime", connections.appRuntime, async () => {}, readOnly);
    await verifyAuthRuntime(readOnly);
    return withClient(
      plan.app,
      "migrator",
      connections.appMigrator,
      (app) => withAuthWriter((auth) => run(app, auth), readOnly),
      readOnly,
    );
  };
  const write = async (client: PoolClient, sql: string, values: unknown[] = []) => {
    await assertCurrent();
    return client.query(sql, values);
  };
  const kernel = async (
    client: PoolClient,
    operation:
      | "kernel_bind_principal_scope"
      | "kernel_bind_actor_membership"
      | "kernel_bind_actor_access",
    request: Record<string, string | boolean | number>,
  ) => {
    const result = await write(client, `select ${operation}($1::jsonb) as result`, [
      JSON.stringify(request),
    ]);
    if (result.rows[0]?.result?.ok !== true) throw new Error("protected_installer_kernel_rejected");
  };
  const values = (scope: (typeof scopes)[number]) => [
    plan.app.runtimeRole,
    plan.appId,
    scope.organizationId,
    scope.actorId,
    scope.role,
  ];
  const kernelAccess = async (app: PoolClient, scope: (typeof scopes)[number], active: boolean) => {
    await kernel(
      app,
      scope.role === null ? "kernel_bind_actor_access" : "kernel_bind_actor_membership",
      {
        principal_name: plan.app.runtimeRole,
        app_id: plan.appId,
        customer_id: scope.organizationId,
        actor_id: scope.actorId,
        actor_kind: scope.actorKind,
        ...(scope.role === null ? {} : { role: scope.role }),
        active,
        fence_generation: fenceGeneration,
      },
    );
    const result = await readDatabaseAccess(app, scope);
    if (
      result.rows.length !== 1 ||
      result.rows[0]?.active !== active ||
      result.rows[0]?.actor_kind !== scope.actorKind ||
      Number(result.rows[0]?.fence_generation) !== fenceGeneration
    )
      throw new Error("protected_installer_membership_readback_failed");
  };
  const readDatabaseAccess = (app: PoolClient, scope: (typeof scopes)[number]) =>
    app.query(
      scope.role === null
        ? "select active,fence_generation,actor_kind from kernel_actor_access where principal_name=$1 and app_id=$2 and customer_id=$3 and actor_id=$4"
        : "select active,fence_generation,actor_kind from kernel_actor_membership where principal_name=$1 and app_id=$2 and customer_id=$3 and actor_id=$4 and role=$5",
      scope.role === null ? values(scope).slice(0, 4) : values(scope),
    );
  const readBrowserAccess = async (auth: PoolClient, scope: (typeof scopes)[number]) => {
    const result = await auth.query(
      scope.role === null
        ? 'select active,"fenceGeneration" as fence_generation,"workspaceId",roles from "app_actor_access" where "organizationId"=$1 and "actorId"=$2 and "appId"=$3'
        : 'select active,"fence_generation" from "app_actor_assignment" where "organizationId"=$1 and "actorId"=$2 and "appId"=$3 and role=$4',
      scope.role === null
        ? [scope.organizationId, scope.actorId, plan.appId]
        : [scope.organizationId, scope.actorId, plan.appId, scope.role],
    );
    if (scope.role === null && result.rows.some((row) => row.workspaceId !== plan.workspaceId))
      throw new Error("protected_installer_identity_mismatch");
    if (
      scope.role === null &&
      result.rows.some(
        (row) =>
          Number(row.fence_generation) === fenceGeneration && JSON.stringify(row.roles) !== "[]",
      )
    )
      throw new Error("protected_installer_assignment_readback_failed");
    return result;
  };
  type AccessRow = { active: boolean; fence_generation: string | number };
  type OppositeAccess = {
    scope: (typeof scopes)[number];
    database: AccessRow | undefined;
    browser: AccessRow | undefined;
  };
  // A role-mode change replaces the actor's old admission, including rows left by
  // an interrupted transition. Read both stores before opening the new mode.
  const readOppositeAccess = async (
    app: PoolClient,
    auth: PoolClient,
    scope: (typeof scopes)[number],
  ): Promise<OppositeAccess[]> => {
    if (scope.role === null) {
      const database = await app.query<AccessRow & { role: string }>(
        "select role,active,fence_generation from kernel_actor_membership where principal_name=$1 and app_id=$2 and customer_id=$3 and actor_id=$4",
        values(scope).slice(0, 4),
      );
      const browser = await auth.query<AccessRow & { role: string }>(
        'select role,active,fence_generation from app_actor_assignment where "organizationId"=$1 and "actorId"=$2 and "appId"=$3',
        [scope.organizationId, scope.actorId, plan.appId],
      );
      return [...new Set([...database.rows, ...browser.rows].map((row) => row.role))].map(
        (role) => ({
          scope: { ...scope, role },
          database: database.rows.find((row) => row.role === role),
          browser: browser.rows.find((row) => row.role === role),
        }),
      );
    }
    const databaseTable = await app.query(
      "select to_regclass('public.kernel_actor_access') is not null as present",
    );
    const browserTable = await auth.query(
      "select to_regclass('public.app_actor_access') is not null as present",
    );
    const opposite = { ...scope, role: null };
    const database = databaseTable.rows[0]?.present
      ? ((await readDatabaseAccess(app, opposite)).rows[0] as AccessRow | undefined)
      : undefined;
    const browser =
      !plan.signupClaim && browserTable.rows[0]?.present
        ? ((await readBrowserAccess(auth, opposite)).rows[0] as AccessRow | undefined)
        : undefined;
    return database || browser ? [{ scope: opposite, database, browser }] : [];
  };
  const oppositeIsClosed = (opposite: OppositeAccess[]) =>
    opposite.every((entry) =>
      [entry.database, entry.browser].every(
        (row) =>
          row === undefined ||
          (row.active === false && Number(row.fence_generation) <= fenceGeneration),
      ),
    );
  const closeOppositeAccess = async (app: PoolClient, auth: PoolClient) => {
    const entries: OppositeAccess[] = [];
    const actors = new Set<string>();
    for (const scope of scopes) {
      const key = JSON.stringify([scope.organizationId, scope.actorId]);
      if (actors.has(key)) continue;
      actors.add(key);
      entries.push(...(await readOppositeAccess(app, auth, scope)));
    }
    // Never let an older operation close a newer grant, even in the other mode.
    for (const entry of entries)
      for (const row of [entry.database, entry.browser]) {
        if (
          row !== undefined &&
          (!Number.isSafeInteger(Number(row.fence_generation)) ||
            Number(row.fence_generation) > fenceGeneration ||
            (Number(row.fence_generation) === fenceGeneration && row.active))
        )
          throw new Error("protected_installer_assignment_fence_rejected");
      }
    // Close all browser authority first, then its database authority. A retry
    // re-reads these same rows and completes the remaining closure before grant.
    for (const entry of entries) {
      if (entry.browser === undefined) continue;
      await assertCurrent();
      await auth.query("begin");
      try {
        await writeAuthAccess(auth, entry.scope, false);
        await auth.query("commit");
      } catch (error) {
        await auth.query("rollback");
        throw error;
      }
    }
    for (const entry of entries) {
      if (entry.database !== undefined) await kernelAccess(app, entry.scope, false);
    }
    for (const scope of scopes) {
      if (!oppositeIsClosed(await readOppositeAccess(app, auth, scope)))
        throw new Error("protected_installer_assignment_readback_failed");
    }
  };
  // Old frozen role-only realms may predate explicit app admission. Never require
  // their migration merely to keep their original protected operations working.
  const appAdmissionExists = async (auth: PoolClient, organization: string, appId: string) => {
    const table = await auth.query(
      "select to_regclass('public.app_actor_access') is not null as present",
    );
    if (table.rows[0]?.present !== true) return "false";
    return `exists(select 1 from public.app_actor_access x where x."organizationId"=${organization} and x."appId"=${appId} and x.active)`;
  };
  const syncOrganizationAppId = async (auth: PoolClient, organizationId: string): Promise<void> => {
    const locked = await auth.query('select 1 from "organization" where id=$1 for update', [
      organizationId,
    ]);
    if (locked.rowCount !== 1) throw new Error("protected_installer_assignment_readback_failed");
    const admission = await appAdmissionExists(auth, 'o."id"', "$2");
    const result = await auth.query(
      `update "organization" o
       set "appIds" = case when exists (
         select 1 from "app_actor_assignment" a
         where a."organizationId"=o."id" and a."appId"=$2 and a.active
       ) or ${admission} then
         case when coalesce(o."appIds",'[]'::jsonb)?$2
           then coalesce(o."appIds",'[]'::jsonb)
           else coalesce(o."appIds",'[]'::jsonb)||to_jsonb($2::text) end
       else coalesce(o."appIds",'[]'::jsonb) - $2::text end
       where o.id=$1 returning o."appIds"`,
      [organizationId, plan.appId],
    );
    if (result.rowCount !== 1) throw new Error("protected_installer_assignment_readback_failed");
  };
  const writeAuthAccess = async (
    auth: PoolClient,
    scope: (typeof scopes)[number],
    active: boolean,
  ): Promise<void> => {
    if (scope.role === null) {
      const result = await auth.query(
        `insert into public.app_actor_access("organizationId","actorId","appId","workspaceId",active,"fenceGeneration",roles)
         values($1,$2,$3,$4,$5,$6,'[]'::jsonb)
         on conflict("organizationId","actorId","appId") do update
           set active=excluded.active,"fenceGeneration"=excluded."fenceGeneration",roles=excluded.roles
         where app_actor_access."workspaceId"=excluded."workspaceId" and
           (app_actor_access."fenceGeneration"<excluded."fenceGeneration" or
            (app_actor_access."fenceGeneration"=excluded."fenceGeneration" and app_actor_access.active=excluded.active and app_actor_access.roles=excluded.roles))
         returning active,"fenceGeneration" as fence_generation`,
        [
          scope.organizationId,
          scope.actorId,
          plan.appId,
          plan.workspaceId,
          active,
          fenceGeneration,
        ],
      );
      if (
        result.rowCount !== 1 ||
        result.rows[0]?.active !== active ||
        Number(result.rows[0]?.fence_generation) !== fenceGeneration
      )
        throw new Error("protected_installer_assignment_fence_rejected");
      await syncOrganizationAppId(auth, scope.organizationId);
      return;
    }
    const result = await auth.query(
      `insert into "app_actor_assignment" ("organizationId","actorId","appId","role",active,"fence_generation")
       values ($1,$2,$3,$4,$5,$6)
       on conflict ("organizationId","actorId","appId","role") do update
         set active=excluded.active,
             "fence_generation"=excluded."fence_generation",
             "assignedAt"=case when "app_actor_assignment"."fence_generation"<excluded."fence_generation" then now() else "app_actor_assignment"."assignedAt" end
       where "app_actor_assignment"."fence_generation"<excluded."fence_generation"
          or ("app_actor_assignment"."fence_generation"=excluded."fence_generation" and "app_actor_assignment".active=excluded.active)
       returning active,"fence_generation"`,
      [scope.organizationId, scope.actorId, plan.appId, scope.role, active, fenceGeneration],
    );
    if (
      result.rowCount !== 1 ||
      result.rows[0]?.active !== active ||
      Number(result.rows[0]?.fence_generation) !== fenceGeneration
    )
      throw new Error("protected_installer_assignment_fence_rejected");
    await syncOrganizationAppId(auth, scope.organizationId);
  };
  const verifyOrganizationAppId = async (
    auth: PoolClient,
    organizationId: string,
  ): Promise<void> => {
    const admission = await appAdmissionExists(auth, "$1", "$2");
    const result = await auth.query(
      `select (exists (select 1 from "app_actor_assignment" a
                       where a."organizationId"=$1 and a."appId"=$2 and a.active) or ${admission}) as expected,
              coalesce(o."appIds",'[]'::jsonb)?$2 as actual
         from "organization" o where o.id=$1`,
      [organizationId, plan.appId],
    );
    if (result.rowCount !== 1 || result.rows[0]?.expected !== result.rows[0]?.actual)
      throw new Error("protected_installer_assignment_readback_failed");
  };
  const closeFailedGrant = async (auth: PoolClient): Promise<void> => {
    await auth.query("begin");
    try {
      for (const scope of scopes) {
        if (scope.role === null) {
          await auth.query(
            `update public.app_actor_access set active=false
            where "organizationId"=$1 and "actorId"=$2 and "appId"=$3 and "workspaceId"=$4
              and "fenceGeneration"=$5 and active`,
            [scope.organizationId, scope.actorId, plan.appId, plan.workspaceId, fenceGeneration],
          );
          await syncOrganizationAppId(auth, scope.organizationId);
          continue;
        }
        await auth.query(
          `update "app_actor_assignment" set active=false
           where "organizationId"=$1 and "actorId"=$2 and "appId"=$3 and role=$4
             and "fence_generation"=$5 and active`,
          [scope.organizationId, scope.actorId, plan.appId, scope.role, fenceGeneration],
        );
        await syncOrganizationAppId(auth, scope.organizationId);
      }
      if (plan.signupClaim) {
        const target = signupTarget();
        await auth.query(
          `update public.app_actor_access set active=false where "organizationId"=$1 and "actorId"=$2 and "appId"=$3 and "workspaceId"=$4 and "fenceGeneration"=$5 and active`,
          [
            target.organization.organizationId,
            target.actor.actorId,
            plan.appId,
            target.workspaceId,
            fenceGeneration,
          ],
        );
        await syncOrganizationAppId(auth, target.organization.organizationId);
      }
      await auth.query("commit");
    } catch (error) {
      await auth.query("rollback");
      throw error;
    }
    for (const scope of scopes) {
      const stale = await readBrowserAccess(auth, scope);
      if (stale.rows.some((row) => row.active && Number(row.fence_generation) === fenceGeneration))
        throw new Error("protected_installer_grant_closure_failed");
      await verifyOrganizationAppId(auth, scope.organizationId);
    }
  };
  const signupTarget = () => {
    const organization = plan.organizations[0];
    const actor = organization?.actors[0];
    if (!plan.signupClaim || !organization || !actor || !plan.workspaceId || !signupOperationRef)
      throw new Error("app_signup_claim_unavailable");
    return {
      organization,
      actor,
      proof: plan.signupClaim,
      workspaceId: plan.workspaceId,
      operationRef: signupOperationRef,
    };
  };
  const readSignupAdmission = async (auth: PoolClient) => {
    const target = signupTarget();
    const found = await auth.query(
      `select active,"fenceGeneration",roles,"workspaceId" from public.app_actor_access where "organizationId"=$1 and "actorId"=$2 and "appId"=$3`,
      [target.organization.organizationId, target.actor.actorId, plan.appId],
    );
    const row = found.rows[0];
    return (
      found.rows.length === 1 &&
      row?.active === true &&
      Number(row.fenceGeneration) === fenceGeneration &&
      row.workspaceId === target.workspaceId &&
      JSON.stringify(row.roles) === JSON.stringify([...target.actor.roles].sort())
    );
  };
  const signupGrant = async (app: PoolClient, auth: PoolClient) => {
    const target = signupTarget();
    const identity = {
      proof: target.proof,
      workspaceId: target.workspaceId,
      appId: plan.appId,
      organizationId: target.organization.organizationId,
      authResourceId: plan.auth.resourceId,
      storage: "postgres" as const,
      actorId: target.actor.actorId,
      appRoles: target.actor.roles,
      fenceGeneration,
      operationRef: target.operationRef,
    };
    await assertCurrent();
    await auth.query("begin");
    let ownedFences: number[];
    try {
      await auth.query("select id from public.organization where id=$1 for update", [
        identity.organizationId,
      ]);
      ({ ownedFences } = await assertManagedAppSignupGrant(auth, identity));
      await auth.query("commit");
    } catch (error) {
      await auth.query("rollback");
      throw error;
    }
    // An Auth claim cannot turn retained/revoked app-database rows into a new grant.
    const history = await app.query(
      `select active,fence_generation,role from kernel_actor_membership where principal_name=$1 and app_id=$2 and customer_id=$3 and actor_id=$4
       union all select active,fence_generation,null::text as role from kernel_actor_access where principal_name=$1 and app_id=$2 and customer_id=$3 and actor_id=$4`,
      [plan.app.runtimeRole, plan.appId, identity.organizationId, identity.actorId],
    );
    if (
      history.rows.some(
        (row) =>
          row.active !== true ||
          !ownedFences.includes(Number(row.fence_generation)) ||
          (row.role === null
            ? target.actor.roles.length !== 0
            : !target.actor.roles.includes(row.role)),
      )
    ) {
      throw new Error("app_signup_access_history");
    }
    for (const scope of scopes) await kernelAccess(app, scope, true);
    // Reservation and each actual store are durable observations. An uncertain
    // write/readback or lost authority must not manufacture revocation history.
    // A current higher-fence revoke closes both stores if cancellation is final.
    await assertCurrent();
    await auth.query("begin");
    try {
      await auth.query("select id from public.organization where id=$1 for update", [
        identity.organizationId,
      ]);
      await assertManagedAppSignupGrant(auth, identity);
      const member = await auth.query("select id from public.lock_auth_operator_member($1,$2)", [
        identity.organizationId,
        identity.actorId,
      ]);
      if (member.rows.length !== 1) throw new Error("protected_installer_membership_required");
      for (const scope of scopes) await writeAuthAccess(auth, scope, true);
      // Role-bearing signup also receives positive app admission, after all kernel roles verified.
      if (target.actor.roles.length !== 0) {
        const admission = await auth.query(
          `insert into public.app_actor_access("organizationId","actorId","appId","workspaceId",active,"fenceGeneration",roles)
             values($1,$2,$3,$4,true,$5,$6::jsonb) on conflict("organizationId","actorId","appId") do update
             set active=true,"fenceGeneration"=excluded."fenceGeneration",roles=excluded.roles
             where app_actor_access.active and app_actor_access."workspaceId"=excluded."workspaceId"
               and app_actor_access."fenceGeneration"<=excluded."fenceGeneration" returning active`,
          [
            identity.organizationId,
            identity.actorId,
            plan.appId,
            target.workspaceId,
            fenceGeneration,
            JSON.stringify([...target.actor.roles].sort()),
          ],
        );
        if (admission.rows.length !== 1)
          throw new Error("protected_installer_assignment_fence_rejected");
      }
      await recordManagedAppSignupGrant(auth, identity);
      await auth.query("commit");
    } catch (error) {
      await auth.query("rollback");
      throw error;
    }
    await assertCurrent();
    if (!(await readSignupAdmission(auth)))
      throw new Error("protected_installer_assignment_readback_failed");
    for (const scope of scopes) {
      if (!(await reconcileAuthScope(auth, scope, true)))
        throw new Error("protected_installer_assignment_readback_failed");
    }
  };
  const verifyInstall = async (app: PoolClient) => {
    const installed = await app.query(
      "select customer_id, effective_artifact_hash from schema_installation_revision where app_id=$1 and release_id=$2 and customer_id=any($3::text[]) and activated_at is not null order by customer_id",
      [
        plan.appId,
        plan.release.id,
        plan.organizations.map((organization) => organization.organizationId),
      ],
    );
    const actual = installed.rows
      .map((row) => String(row.customer_id))
      .sort((a, b) => a.localeCompare(b));
    const expected = plan.organizations
      .map((entry) => entry.organizationId)
      .sort((a, b) => a.localeCompare(b));
    if (
      JSON.stringify(actual) !== JSON.stringify(expected) ||
      installed.rows.some((row) => row.effective_artifact_hash !== plan.release.artifactHash)
    )
      throw new Error("protected_installer_release_readback_failed");
    for (const organization of plan.organizations) {
      const scope = await app.query(
        "select 1 from kernel_principal_scope where principal_name=$1 and app_id=$2 and customer_id=$3 and capability='runtime' and active",
        [plan.app.runtimeRole, plan.appId, organization.organizationId],
      );
      if (scope.rowCount !== 1) throw new Error("protected_installer_scope_readback_failed");
    }
  };
  const reconcileAuthScope = async (
    auth: PoolClient,
    scope: (typeof scopes)[number],
    active: boolean,
  ) => {
    const browser = await readBrowserAccess(auth, scope);
    const enabled = active
      ? await auth.query(
          'select 1 from "organization" where id=$1 and coalesce("appIds",\'[]\'::jsonb)?$2',
          [scope.organizationId, plan.appId],
        )
      : undefined;
    const admission = await appAdmissionExists(auth, "$1", "$2");
    const projection = await auth.query(
      `select (exists (select 1 from "app_actor_assignment" a
                             where a."organizationId"=$1 and a."appId"=$2 and a.active) or ${admission}) as expected,
                    coalesce(o."appIds",'[]'::jsonb)?$2 as actual
               from "organization" o where o.id=$1`,
      [scope.organizationId, plan.appId],
    );
    return (
      projection.rowCount === 1 &&
      projection.rows[0]?.expected === projection.rows[0]?.actual &&
      browser.rowCount === 1 &&
      browser.rows[0]?.active === active &&
      Number(browser.rows[0]?.fence_generation) === fenceGeneration &&
      (!active || enabled?.rowCount === 1) &&
      (!plan.signupClaim || !active || (await readSignupAdmission(auth)))
    );
  };
  return {
    async install() {
      if (readOnly) throw new Error("protected_installer_readonly_required");
      return withMigrators(async (app) => {
        for (const organization of plan.organizations) {
          if (retainedInstallationCustomerIds.has(organization.organizationId)) {
            await assertCurrent();
            await verifyRetainedRuntimeScope(
              app,
              plan.appId,
              organization.organizationId,
              plan.app.runtimeRole,
            );
          }
        }
        const result = await installGeneratedAppRuntime({
          appId: plan.appId,
          customerIds: plan.organizations.map((entry) => entry.organizationId),
          databaseUrl: connections.appMigrator,
          releaseDirectory: directory,
          authority: {
            releaseId: plan.release.id,
            artifactHash: plan.release.artifactHash,
            manifestHash: plan.release.manifestHash,
            sqlBundleHash: trust.sqlBundleHash,
            beforeEffect: assertCurrent,
            checkConnection: (client) => verifyProtectedConnection(client, plan.app, "migrator"),
            afterInstall: async (app) => {
              const capability = await app.query(
                "select kernel_installer_capability_role('runtime') as role",
              );
              const role = sqlName.parse(capability.rows[0]?.role);
              const memberships = await app.query(
                "select parent.rolname as role from pg_auth_members m join pg_roles child on child.oid=m.member join pg_roles parent on parent.oid=m.roleid where child.rolname=$1",
                [plan.app.runtimeRole],
              );
              if (memberships.rows.some((entry) => entry.role !== role)) reject();
              await write(app, `grant ${identifier(role)} to ${identifier(plan.app.runtimeRole)}`);
              for (const organization of plan.organizations) {
                if (retainedInstallationCustomerIds.has(organization.organizationId)) {
                  await verifyRetainedRuntimeScope(
                    app,
                    plan.appId,
                    organization.organizationId,
                    plan.app.runtimeRole,
                    "caller",
                  );
                  continue;
                }
                await kernel(app, "kernel_bind_principal_scope", {
                  principal_name: plan.app.runtimeRole,
                  app_id: plan.appId,
                  customer_id: organization.organizationId,
                  capability: "runtime",
                  actor_binding_required: true,
                  active: true,
                });
              }
              await verifyInstall(app);
            },
          },
        });
        return result;
      });
    },
    async grant() {
      if (readOnly) throw new Error("protected_installer_readonly_required");
      return withMigrators(async (app, auth) => {
        await verifyInstall(app);
        if (plan.signupClaim) return await signupGrant(app, auth);
        for (const scope of scopes) {
          // Reject a different workspace's existing admission before changing the app database.
          if (scope.role === null) await readBrowserAccess(auth, scope);
          const member = await auth.query(
            'select 1 from "member" where "organizationId"=$1 and "userId"=$2',
            [scope.organizationId, scope.actorId],
          );
          if (member.rowCount !== 1) throw new Error("protected_installer_membership_required");
        }
        await closeOppositeAccess(app, auth);
        // Verify every kernel membership before opening any browser authority.
        for (const scope of scopes) await kernelAccess(app, scope, true);
        let authWriteAttempted = false;
        try {
          for (const scope of scopes) {
            await assertCurrent();
            authWriteAttempted = true;
            await auth.query("begin");
            try {
              // Membership may have changed while kernel effects were applied.
              // Hold the Auth row through assignment commit, then read back both stores.
              const member = await auth.query(
                plan.authOperatorRole === undefined
                  ? 'select 1 from "member" where "organizationId"=$1 and "userId"=$2 for key share'
                  : "select id from public.lock_auth_operator_member($1,$2)",
                [scope.organizationId, scope.actorId],
              );
              if (member.rowCount !== 1) throw new Error("protected_installer_membership_required");
              await writeAuthAccess(auth, scope, true);
              await auth.query("commit");
            } catch (error) {
              await auth.query("rollback");
              throw error;
            }
            // Provider fencing cannot run inside the Auth transaction. A lost
            // fence after the pre-write check closes this generation's grant.
            await assertCurrent();
            const member = await auth.query(
              'select 1 from "member" where "organizationId"=$1 and "userId"=$2',
              [scope.organizationId, scope.actorId],
            );
            if (member.rowCount !== 1 || !(await reconcileAuthScope(auth, scope, true)))
              throw new Error("protected_installer_assignment_readback_failed");
            await verifyOrganizationAppId(auth, scope.organizationId);
          }
          await assertCurrent();
        } catch (error) {
          if (authWriteAttempted) {
            try {
              await closeFailedGrant(auth);
            } catch (closureError) {
              throw new AggregateError(
                [error, closureError],
                "protected_installer_grant_closure_failed",
              );
            }
          }
          throw error;
        }
      });
    },
    async revoke() {
      if (readOnly) throw new Error("protected_installer_readonly_required");
      return withMigrators(async (app, auth) => {
        // Legacy scopes can authorize mutations without actor membership. Every
        // scope of this physical runtime principal must enforce current bindings
        // before membership closure can establish the protected revoke boundary.
        const profiles = await app.query<{
          actor_binding_required: boolean;
          app_id: string;
          customer_id: string;
        }>(
          "select actor_binding_required,app_id,customer_id from kernel_principal_scope where principal_name=$1 and capability='runtime'",
          [plan.app.runtimeRole],
        );
        if (
          profiles.rows.some((profile) => profile.actor_binding_required !== true) ||
          plan.organizations.some(
            (organization) =>
              !profiles.rows.some(
                (profile) =>
                  profile.app_id === plan.appId &&
                  profile.customer_id === organization.organizationId,
              ),
          )
        )
          throw new Error("protected_installer_binding_profile_required");
        await closeOppositeAccess(app, auth);
        // Remove browser authority first. If the process stops here, retry closes the
        // remaining kernel membership with the same generation.
        for (const scope of scopes) {
          await assertCurrent();
          await auth.query("begin");
          try {
            await writeAuthAccess(auth, scope, false);
            await auth.query("commit");
          } catch (error) {
            await auth.query("rollback");
            throw error;
          }
          const closed = await readBrowserAccess(auth, scope);
          if (
            closed.rowCount !== 1 ||
            closed.rows[0]?.active !== false ||
            Number(closed.rows[0]?.fence_generation) !== fenceGeneration
          )
            throw new Error("protected_installer_assignment_readback_failed");
          await verifyOrganizationAppId(auth, scope.organizationId);
        }
        for (const scope of scopes) await kernelAccess(app, scope, false);
      });
    },
    /** Fixed native install facts; no writes, effect receipt, Auth grant or actor-binding snapshot. */
    async reconcileInstall() {
      validateArtifact();
      await assertCurrent();
      const status = await withClient(
        plan.app,
        "migrator",
        connections.appMigrator,
        async (app) => {
          await app.query("begin read only");
          try {
            const namespace = await app.query<{ objects: number }>(`
            select count(*)::int as objects from pg_depend d
            where d.refclassid='pg_namespace'::regclass
              and d.refobjid='public'::regnamespace`);
            if (namespace.rows[0]?.objects === 0) return "absent" as const;
            const required = await app.query<{ complete: boolean }>(`select
            to_regclass('public.schema_revision') is not null and
            to_regclass('public.schema_installation_revision') is not null and
            to_regclass('public.kernel_principal_scope') is not null and
            to_regprocedure('public.kernel_installer_capability_role(text)') is not null as complete`);
            if (required.rows[0]?.complete !== true) return "incomplete" as const;
            const expected = plan.organizations.map((entry) => entry.organizationId).sort();
            const artifact = JSON.parse(
              readFileSync(path.join(directory, "app-artifact.json"), "utf8"),
            ) as { schema: Record<string, unknown> };
            const revisionStates: Array<
              "applied" | "prepared" | "new-tenant" | "supported-predecessor" | "missing"
            > = [];
            let needsResume = false;
            for (const organizationId of expected) {
              // Fixed tenant settings expose only this approved install's metadata under existing RLS.
              await app.query(
                "select set_config('kernel.app_id',$1,true),set_config('kernel.customer_id',$2,true)",
                [plan.appId, organizationId],
              );
              const bound = await app.query<{
                actor_binding_required: boolean;
                active: boolean;
              }>(
                "select actor_binding_required,active from kernel_principal_scope where principal_name=$1 and app_id=$2 and customer_id=$3 and capability='runtime'",
                [plan.app.runtimeRole, plan.appId, organizationId],
              );
              if (bound.rows.length > 1) return "incomplete" as const;
              if (
                retainedInstallationCustomerIds.has(organizationId) &&
                (bound.rows.length !== 1 || bound.rows[0]?.active !== true)
              )
                return "incomplete" as const;
              if (bound.rows.length === 0) needsResume = true;
              else if (bound.rows[0]?.actor_binding_required !== true) return "incomplete" as const;
              else if (bound.rows[0]?.active !== true) needsResume = true;
              const expectedSchema = { ...artifact.schema, customer_id: organizationId };
              const installed = await app.query<GeneratedInstallReadbackFacts & { id: string }>(
                `
                select sr.id::text, sr.version,
                       sr.base_schema=$4::jsonb as base_schema_matches,
                       sr.customer_overlay='{}'::jsonb as overlay_empty,
                       sr.schema=$4::jsonb as schema_matches,
                       sr.schema_hash=kernel_admin_sha256(kernel_canonical_json($4::jsonb)) as schema_hash_matches,
                       sr.activated_at is null as revision_inactive,
                       sr.materialized_at is null as materialization_pending,
                       sir.release_id, sir.activation_kind, sir.base_artifact_hash,
                       sir.effective_artifact_hash, sir.materialization_plan_hash,
                       sir.seed_change_sets='[]'::jsonb as seed_change_sets_empty,
                       sir.phase_plan='[]'::jsonb as phase_plan_empty,
                       sir.ready_at,
                       sir.activated_at is null as installation_inactive
                from schema_revision sr join schema_installation_revision sir on sir.schema_revision_id=sr.id
                where sr.app_id=$1 and sr.customer_id=$2 and sr.version=$3`,
                [plan.appId, organizationId, plan.release.id, JSON.stringify(expectedSchema)],
              );
              if (installed.rows.length === 0) {
                // A new approved tenant can share an already populated app database.
                // Check both catalogs independently: an inner join or release filter
                // would hide older revisions and orphaned installation metadata.
                const presence = await app.query<{
                  revision_present: boolean;
                  installation_present: boolean;
                }>(
                  `select
                    exists(select 1 from schema_revision where app_id=$1 and customer_id=$2) as revision_present,
                    exists(select 1 from schema_installation_revision where app_id=$1 and customer_id=$2) as installation_present`,
                  [plan.appId, organizationId],
                );
                if (
                  presence.rows.length === 1 &&
                  presence.rows[0]?.revision_present === false &&
                  presence.rows[0]?.installation_present === false
                ) {
                  revisionStates.push("new-tenant");
                  continue;
                }
                const transition = JSON.parse(
                  readFileSync(path.join(directory, "transition-contract.json"), "utf8"),
                ) as { predecessors: Array<{ schema: Record<string, unknown> }> };
                const predecessors = transition.predecessors.map((entry) => ({
                  ...entry.schema,
                  customer_id: organizationId,
                }));
                const prior = await app.query<GeneratedPredecessorReadbackFacts>(
                  `select sr.version,
                    (sr.version=sr.base_schema->>'version' and exists(
                      select 1 from jsonb_array_elements($3::jsonb) predecessor(schema)
                      where predecessor.schema=kernel_installer_default_model_kind(sr.base_schema)
                    )) as base_schema_matches,
                    sr.customer_overlay='{}'::jsonb as overlay_empty,
                    sr.schema=sr.base_schema as schema_matches,
                    sr.schema_hash=kernel_admin_sha256(kernel_canonical_json(sr.schema)) as schema_hash_matches,
                    sr.activated_at is null as revision_inactive,
                    sr.materialized_at is null as materialization_pending,
                    sir.release_id,sir.activation_kind,sir.base_artifact_hash,sir.effective_artifact_hash,
                    sir.ready_at,
                    sir.activated_at is null as installation_inactive
                   from schema_revision sr left join schema_installation_revision sir
                     on sir.schema_revision_id=sr.id and sir.app_id=sr.app_id and sir.customer_id=sr.customer_id
                   where sr.app_id=$1 and sr.customer_id=$2 and sr.activated_at is not null
                     and not exists(select 1 from schema_installation_revision orphan
                       left join schema_revision parent on parent.id=orphan.schema_revision_id
                         and parent.app_id=orphan.app_id and parent.customer_id=orphan.customer_id
                       where orphan.app_id=$1 and orphan.customer_id=$2 and parent.id is null)`,
                  [plan.appId, organizationId, JSON.stringify(predecessors)],
                );
                const predecessor = prior.rows[0];
                revisionStates.push(
                  prior.rows.length === 1 &&
                    predecessor !== undefined &&
                    classifyGeneratedPredecessorReadback(predecessor)
                    ? "supported-predecessor"
                    : "missing",
                );
                continue;
              }
              if (installed.rows.length !== 1) return "incomplete" as const;
              const row = installed.rows[0]!;
              const classification = classifyGeneratedInstallReadback(
                row,
                plan.release.id,
                plan.release.artifactHash,
                digestHex(Buffer.from("[]")),
              );
              if (classification === "conflict") return "incomplete" as const;
              revisionStates.push(classification);
            }
            const capability = await app.query<{ role: string }>(
              "select kernel_installer_capability_role('runtime') as role",
            );
            if (!capability.rows[0]?.role) return "incomplete" as const;
            const roles = await app.query<{ role: string }>(
              "select parent.rolname as role from pg_auth_members m join pg_roles child on child.oid=m.member join pg_roles parent on parent.oid=m.roleid where child.rolname=$1 order by parent.rolname",
              [plan.app.runtimeRole],
            );
            if (
              roles.rows.length > 1 ||
              roles.rows.some((row) => row.role !== capability.rows[0]!.role)
            )
              return "incomplete" as const;
            if (roles.rows.length === 0) needsResume = true;
            await verifyRuntimeRolePrivileges(app, plan.app);
            return classifyGeneratedInstallReconciliation(revisionStates, needsResume);
          } finally {
            await app.query("rollback");
          }
        },
      );
      await assertCurrent();
      return status;
    },
    /** Actual absence and bounded saga resume facts; unreadable/stale/conflicting scopes never become absent. */
    async inspectAccess(active: boolean) {
      const status = await withMigrators(async (app, auth) => {
        await verifyInstall(app);
        await app.query("begin read only");
        await auth.query("begin read only");
        try {
          let empty = true;
          let applied = true;
          for (const scope of scopes) {
            const opposite = await readOppositeAccess(app, auth, scope);
            for (const entry of opposite)
              for (const row of [entry.database, entry.browser]) {
                if (
                  row !== undefined &&
                  (Number(row.fence_generation) > fenceGeneration ||
                    (Number(row.fence_generation) === fenceGeneration && row.active))
                )
                  return "incomplete" as const;
              }
            if (!oppositeIsClosed(opposite)) {
              applied = false;
              empty = false;
            }
            const profile = await app.query(
              "select actor_binding_required from kernel_principal_scope where principal_name=$1 and app_id=$2 and customer_id=$3 and capability='runtime' and active",
              [plan.app.runtimeRole, plan.appId, scope.organizationId],
            );
            if (profile.rows.length !== 1 || profile.rows[0]?.actor_binding_required !== true)
              return "incomplete" as const;
            if (active) {
              const member = await auth.query(
                'select 1 from "member" m join "user" u on u.id=m."userId" where m."organizationId"=$1 and m."userId"=$2',
                [scope.organizationId, scope.actorId],
              );
              if (member.rowCount !== 1) return "incomplete" as const;
            }
            const database = await readDatabaseAccess(app, scope);
            const browser = await readBrowserAccess(auth, scope);
            for (const result of [database, browser]) {
              if (result.rows.length > 1) return "incomplete" as const;
              const row = result.rows[0];
              if (row !== undefined) {
                empty = false;
                const generation = Number(row.fence_generation);
                if (
                  !Number.isSafeInteger(generation) ||
                  generation < 0 ||
                  generation > fenceGeneration ||
                  (generation === fenceGeneration && row.active !== active)
                )
                  return "incomplete" as const;
              }
            }
            if (
              database.rows[0]?.active !== active ||
              Number(database.rows[0]?.fence_generation) !== fenceGeneration ||
              !(await reconcileAuthScope(auth, scope, active))
            )
              applied = false;
          }
          if (applied) return "applied" as const;
          if (active && empty) return "absent" as const;
          return "retryable" as const;
        } finally {
          await auth.query("rollback");
          await app.query("rollback");
        }
      });
      await assertCurrent();
      return status;
    },
    /** Prove an original completed signup at its recorded fence, never at the new reader's lease. */
    async observeSignupGrant(recordedGrant: ManagedAppSignupRecordedGrant) {
      const expected = managedAppSignupRecordedGrantSchema.parse(recordedGrant);
      if (expected.fenceGeneration > fenceGeneration) return "incomplete" as const;
      const status = await withMigrators(async (app, auth) => {
        await app.query("begin read only");
        await auth.query("begin read only");
        try {
          await verifyInstall(app);
          const target = signupTarget();
          const binding = await app.query(
            "select actor_binding_required from kernel_principal_scope where principal_name=$1 and app_id=$2 and customer_id=$3 and capability='runtime' and active",
            [plan.app.runtimeRole, plan.appId, target.organization.organizationId],
          );
          if (binding.rows.length !== 1 || binding.rows[0]?.actor_binding_required !== true)
            return "incomplete" as const;
          const observed = await readManagedAppSignupRecordedGrant(auth, {
            proof: target.proof,
            workspaceId: target.workspaceId,
            appId: plan.appId,
            organizationId: target.organization.organizationId,
            authResourceId: plan.auth.resourceId,
            storage: "postgres",
            actorId: target.actor.actorId,
            appRoles: target.actor.roles,
            recordedGrant: expected,
          });
          if (!observed) return "incomplete" as const;
          const history = await app.query(
            `select active,fence_generation,role,actor_kind from kernel_actor_membership where principal_name=$1 and app_id=$2 and customer_id=$3 and actor_id=$4
              union all select active,fence_generation,null::text as role,actor_kind from kernel_actor_access where principal_name=$1 and app_id=$2 and customer_id=$3 and actor_id=$4`,
            [
              plan.app.runtimeRole,
              plan.appId,
              target.organization.organizationId,
              target.actor.actorId,
            ],
          );
          const roles = target.actor.roles;
          if (
            history.rows.length !== (roles.length || 1) ||
            history.rows.some(
              (row) =>
                row.active !== true ||
                row.actor_kind !== "human" ||
                Number(row.fence_generation) !== expected.fenceGeneration ||
                (row.role === null ? roles.length !== 0 : !roles.includes(String(row.role))),
            )
          )
            return "incomplete" as const;
          return "applied" as const;
        } finally {
          await auth.query("rollback");
          await app.query("rollback");
        }
      }, true);
      await assertCurrent();
      return status;
    },
    async reconcileAccess(active: boolean) {
      return withMigrators(async (app, auth) => {
        for (const scope of scopes) {
          if (!oppositeIsClosed(await readOppositeAccess(app, auth, scope)))
            return "incomplete" as const;
          const database = await readDatabaseAccess(app, scope);
          if (
            database.rowCount !== 1 ||
            database.rows[0]?.active !== active ||
            Number(database.rows[0]?.fence_generation) !== fenceGeneration ||
            !(await reconcileAuthScope(auth, scope, active))
          )
            return "incomplete" as const;
        }
        return "applied" as const;
      });
    },
    /** Independent Auth closure proof also works after the owned app database is retired. */
    async reconcileAuthAccess(active: boolean) {
      validateArtifact();
      await assertCurrent();
      await verifyAuthRuntime();
      return withAuthWriter(async (auth) => {
        for (const scope of scopes) {
          if (!(await reconcileAuthScope(auth, scope, active))) return "incomplete" as const;
        }
        if (!active) {
          const admission = await appAdmissionExists(auth, "o.id", "$1");
          const live = await auth.query(
            `select 1 from "organization" o where
            exists(select 1 from "app_actor_assignment" a where a."appId"=$1 and a.active)
            or ${admission} limit 1`,
            [plan.appId],
          );
          if (live.rowCount !== 0) return "incomplete" as const;
        }
        await assertCurrent();
        return "applied" as const;
      });
    },
    /** Retirement requires all actors of the physical app principal and app Auth scope closed. */
    async reconcileRetirementAccess() {
      return withMigrators(async (app, auth) => {
        for (const scope of scopes) {
          const database = await readDatabaseAccess(app, scope);
          if (
            database.rowCount !== 1 ||
            database.rows[0]?.active !== false ||
            Number(database.rows[0]?.fence_generation) !== fenceGeneration ||
            !(await reconcileAuthScope(auth, scope, false))
          )
            return "incomplete" as const;
        }
        const accessTable = await app.query(
          "select to_regclass('public.kernel_actor_access') is not null as present",
        );
        const liveApp = await app.query(
          "select 1 from kernel_actor_membership where principal_name=$1 and app_id=$2 and active" +
            (accessTable.rows[0]?.present
              ? " union all select 1 from kernel_actor_access where principal_name=$1 and app_id=$2 and active"
              : "") +
            " limit 1",
          [plan.app.runtimeRole, plan.appId],
        );
        const admission = await appAdmissionExists(auth, "o.id", "$1");
        const liveAuth = await auth.query(
          `select 1 from "organization" o where
          exists(select 1 from "app_actor_assignment" a where a."appId"=$1 and a.active)
          or ${admission} limit 1`,
          [plan.appId],
        );
        if (liveApp.rowCount !== 0 || liveAuth.rowCount !== 0) return "incomplete" as const;
        await assertCurrent();
        return "applied" as const;
      });
    },
    async verify() {
      return withMigrators(async (app) => {
        await verifyInstall(app);
        return { releaseId: plan.release.id, artifactHash: plan.release.artifactHash };
      });
    },
  };
}

/** Fixed worker identity selected by the trusted Builder installer catalog. */
export const PROTECTED_GENERATED_APP_INSTALLER_ID = "generated-app-protected-installer-v1";
export const PROTECTED_GENERATED_APP_EFFECTS = [
  "generated_app.install_bundle",
  "generated_app.prepare_schema_revision",
  "generated_app.validate_readiness",
  "generated_app.activate_app_base",
  "generated_app.grant_runtime_capability",
  "generated_app.bind_runtime_scope",
] as const;

type WorkerContext = ProtectedInstallContext;
type WorkerMetadata = {
  version: 1;
  app_id: string;
  release_id: string;
  release_manifest_sha256: string;
  app_artifact_sha256: string;
  sql_bundle_sha256: string;
};
type WorkerEffect = (typeof PROTECTED_GENERATED_APP_EFFECTS)[number];

const workerMetadataSchema = z.strictObject({
  version: z.literal(1),
  app_id: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
  release_id: id,
  release_manifest_sha256: hash,
  app_artifact_sha256: hash,
  sql_bundle_sha256: hash,
});
const workerReject = (code: string): never => {
  throw new Error(code);
};
const digestHex = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const digestJson = (value: unknown) => digestHex(Buffer.from(JSON.stringify(value)));
const releaseNames = [
  "app-artifact.json",
  "sql-manifest.json",
  "sql-bundle.sql",
  "transition-plan.json",
  "transition-contract.json",
  "runtime-coverage.json",
  "cue-to-sql-source-map.json",
  "release-manifest.json",
  "operation-manifest.json",
  "data-operations.ts",
  "data-operations.md",
  "data-server.ts",
] as const;

/** A schema-only installation cannot create or reactivate runtime access. */
async function verifyRetainedRuntimeScope(
  client: PoolClient,
  appId: string,
  customerId: string,
  runtimeRole: string,
  transactionOwner: "helper" | "caller" = "helper",
): Promise<void> {
  const read = () =>
    client.query<{ active: boolean; actor_binding_required: boolean }>(
      "select active,actor_binding_required from kernel_principal_scope where principal_name=$1 and app_id=$2 and customer_id=$3 and capability='runtime'",
      [runtimeRole, appId, customerId],
    );
  let result;
  if (transactionOwner === "caller") {
    // afterInstall already participates in the installer's atomic write transaction.
    // Establish its tenant-local read scope without beginning or ending that transaction.
    await client.query(
      "select set_config('kernel.app_id',$1,true),set_config('kernel.customer_id',$2,true)",
      [appId, customerId],
    );
    result = await read();
  } else {
    result = await withProtectedTenantReadback(client, appId, customerId, read);
  }
  if (
    result.rowCount !== 1 ||
    result.rows[0]?.active !== true ||
    result.rows[0]?.actor_binding_required !== true
  )
    workerReject("protected_installer_scope_readback_failed");
}

/**
 * Execute the source-owned generated-app installer behind the Rust-compatible protected spool.
 * The operator is the only approval and journal authority; this process owns no durable intent.
 */
export async function runProtectedGeneratedAppInstaller(input: {
  spoolDirectory: string;
  runId: string;
  timeoutMs: number;
  releaseDirectory: string;
  notices?: NodeJS.WritableStream;
}): Promise<void> {
  const notices = input.notices ?? process.stdout;
  const session = new ProtectedInstallerSpoolSession({
    spoolDirectory: input.spoolDirectory,
    runId: input.runId,
    timeoutMs: input.timeoutMs,
    notices,
  });
  let started = false;
  let metadataBytes: Buffer | undefined;
  let approvedPlanBytes: Buffer | undefined;
  let databaseUrl = "";
  try {
    session.open();
    const context = session.context;
    databaseUrl = session.databaseUrl;
    approvedPlanBytes = session.readStartupFile("approved-access-plan.json");
    const { accessCustomers } = readApprovedGeneratedPlan({
      approvedPlan: JSON.parse(approvedPlanBytes.toString("utf8")),
      context,
      purpose: "install",
    });
    const runtimeAccessCustomers = new Set(accessCustomers);
    metadataBytes = session.readStartupFile("generated-app-release.json");
    const metadata = workerMetadataSchema.parse(JSON.parse(metadataBytes.toString("utf8")));
    const resource = protectedDatabaseResourceSchema.parse({
      resourceId: context.resource.resource_id,
      environment: context.resource.environment,
      hostname: context.resource.hostname,
      port: context.resource.port,
      database: context.resource.database,
      schema: context.resource.schema,
      runtimeRole: context.resource.runtime_role,
      migratorRole: context.resource.migrator_role,
    });
    if (
      context.installer.id !== PROTECTED_GENERATED_APP_INSTALLER_ID ||
      digestHex(readFileSync(process.execPath)) !== context.installer.sha256 ||
      metadata.app_id !== context.app_id ||
      metadata.release_id !== context.release.id ||
      metadata.release_manifest_sha256 !== context.release.sha256
    )
      workerReject("protected_installer_identity_mismatch");
    assertProtectedConnection(databaseUrl, resource, "migrator");
    const releaseDirectory = path.resolve(input.releaseDirectory);
    const release = readWorkerRelease(releaseDirectory);
    const manifest = verifyWorkerRelease(release, context, metadata);
    const bundle = release.get("sql-bundle.sql")?.toString("utf8");
    if (typeof bundle !== "string") workerReject("protected_installer_release_invalid");
    await verifyBundleTransactionShape(bundle as string);

    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const client = await pool.connect();
      try {
        await verifyProtectedConnection(client, resource, "migrator");
        await verifyRuntimeRolePrivileges(client, resource);
        for (const tenantId of context.tenant_targets) {
          if (!runtimeAccessCustomers.has(tenantId)) {
            await session.assertCurrent();
            await verifyRetainedRuntimeScope(
              client,
              context.app_id,
              tenantId,
              resource.runtimeRole,
            );
          }
        }
        session.lifecycle.started();
        started = true;
        const installer = new GeneratedReleaseEffects(
          client,
          context,
          manifest,
          release,
          session,
          runtimeAccessCustomers,
        );
        await installer.installBundle();
        const prepared = new Map<string, PreparedGeneratedTarget>();
        for (const tenantId of context.tenant_targets)
          prepared.set(tenantId, await installer.prepare(tenantId));
        for (const tenantId of context.tenant_targets)
          await installer.validateReadiness(prepared.get(tenantId)!);
        await installer.activate([...prepared.values()]);
        await installer.grantRuntimeCapability();
        for (const tenantId of context.tenant_targets) await installer.bindRuntimeScope(tenantId);
        await installer.verifyComplete();
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
    session.lifecycle.succeeded();
  } catch (error) {
    session.lifecycle.failed(workerFailureCode(error, started));
    throw new Error("protected_generated_app_install_failed");
  } finally {
    metadataBytes?.fill(0);
    approvedPlanBytes?.fill(0);
    session.removeStartupFile("approved-access-plan.json");
    session.removeStartupFile("generated-app-release.json");
    session.close();
    databaseUrl = "";
  }
}

const approvedAccessPlanSchema = z.looseObject({
  version: z.literal(1),
  action: z.enum(["prepare", "cleanup"]),
  selection: z.looseObject({ appId: id, workspaceId: id.optional() }),
  appDatabase: z.looseObject({
    resourceId: id,
    database: sqlName,
    migratorRole: sqlName,
    runtimeRole: sqlName,
  }),
  authDatabase: z.looseObject({
    resourceId: id,
    database: sqlName,
    migratorRole: sqlName,
    runtimeRole: sqlName,
  }),
  authOperatorRole: sqlName.optional(),
  signupClaim: managedAppSignupClaimProofSchema.optional(),
  signupGrantReadback: managedAppSignupRecordedGrantSchema.optional(),
  neon: z.looseObject({ endpoint: id }),
  release: z.looseObject({ id, sha256: hash }),
  installer: z.looseObject({ reference: id, sha256: hash }),
  appInstallation: z.strictObject({ customerIds: z.array(id).min(1) }).optional(),
  access: z.array(
    z.strictObject({
      organizationId: id,
      actorId: id,
      actorKind: z.enum(["human", "agent"]),
      roles: z.array(id),
    }),
  ),
});
export const protectedGeneratedConnectionsSchema = z.union([
  z.strictObject({
    appMigrator: z.string().min(1),
    appRuntime: z.string().min(1),
    authMigrator: z.string().min(1),
    authRuntime: z.string().min(1),
  }),
  z.strictObject({
    appMigrator: z.string().min(1),
    appRuntime: z.string().min(1),
    authOperator: z.string().min(1),
    authRuntime: z.string().min(1),
  }),
]);
export type ProtectedGeneratedConnections = z.infer<typeof protectedGeneratedConnectionsSchema>;

/** Bind exact raw approval to its physical install/access partition without credential inputs. */
function readApprovedGeneratedPlan(input: {
  approvedPlan: unknown;
  context: ProtectedInstallContext | ResourceBootstrapContext;
  purpose?: "install" | "access";
}) {
  const context = input.context;
  const rawPlan = input.approvedPlan;
  // Hash the exact canonical approved plan before any subset parsing can strip fields.
  if (digestJson(rawPlan) !== context.operation.approval_digest)
    workerReject("protected_installer_identity_mismatch");
  const approved = approvedAccessPlanSchema.parse(rawPlan);
  if (approved.kind === "repository-production-setup-v1" && approved.authOperatorRole === undefined)
    workerReject("protected_installer_identity_mismatch");
  if (approved.signupClaim && approved.action !== "prepare")
    workerReject("protected_installer_identity_mismatch");
  if (approved.signupGrantReadback && !approved.signupClaim)
    workerReject("protected_installer_identity_mismatch");
  const accessCustomers = [...new Set(approved.access.map((entry) => entry.organizationId))];
  const installationCustomers = approved.appInstallation?.customerIds ?? accessCustomers;
  if (
    new Set(installationCustomers).size !== installationCustomers.length ||
    accessCustomers.some((customerId) => !installationCustomers.includes(customerId))
  )
    workerReject("protected_installer_identity_mismatch");
  const customers = input.purpose === "install" ? installationCustomers : accessCustomers;
  if (
    approved.installer.reference !== PROTECTED_GENERATED_APP_INSTALLER_ID ||
    approved.selection.appId !== context.app_id ||
    approved.release.id !== context.release.id ||
    approved.release.sha256 !== context.release.sha256 ||
    approved.neon.endpoint !== context.resource.hostname ||
    approved.appDatabase.resourceId !== context.resource.resource_id ||
    approved.appDatabase.database !== context.resource.database ||
    approved.appDatabase.migratorRole !== context.resource.migrator_role ||
    approved.appDatabase.runtimeRole !== context.resource.runtime_role ||
    ("kind" in context
      ? context.resource.scope !== "app_database"
      : JSON.stringify([...customers].sort()) !==
        JSON.stringify([...context.tenant_targets].sort()))
  )
    workerReject("protected_installer_identity_mismatch");
  return { approved, customers, accessCustomers };
}

/** Pure approved-plan/checked-release adapter reused by fixed access and retirement readers. No SQL occurs here. */
export function createApprovedGeneratedAccessInspector(input: {
  approvedPlan: unknown;
  context: ProtectedInstallContext | ResourceBootstrapContext;
  connections: z.infer<typeof protectedGeneratedConnectionsSchema>;
  releaseDirectory: string;
  assertCurrent: () => Promise<void>;
  purpose?: "install" | "access";
}) {
  const context = input.context;
  const { approved, customers, accessCustomers } = readApprovedGeneratedPlan(input);
  const manifestBytes = readFileSync(path.join(input.releaseDirectory, "release-manifest.json"));
  if (digestHex(manifestBytes) !== approved.release.sha256)
    workerReject("protected_installer_identity_mismatch");
  const manifest = verifyCheckedRelease(input.releaseDirectory);
  const sqlBundleHash = digestHex(
    readFileSync(path.join(input.releaseDirectory, "sql-bundle.sql")),
  );
  const resource = (owned: typeof approved.appDatabase) => ({
    resourceId: owned.resourceId,
    environment: context.resource.environment,
    hostname: context.resource.hostname,
    port: context.resource.port,
    database: owned.database,
    schema: "public" as const,
    migratorRole: owned.migratorRole,
    runtimeRole: owned.runtimeRole,
  });
  const organizations = customers.map((organizationId) => ({
    organizationId,
    actors: approved.access
      .filter((entry) => entry.organizationId === organizationId)
      .map((entry) => ({
        actorId: entry.actorId,
        actorKind: entry.actorKind,
        roles: entry.roles,
      })),
  }));
  const connections = protectedGeneratedConnectionsSchema.parse(input.connections);
  const installer = createProtectedGeneratedInstaller({
    plan: {
      version: 1,
      appId: approved.selection.appId,
      ...(approved.signupClaim ? { signupClaim: approved.signupClaim } : {}),
      ...(approved.selection.workspaceId === undefined
        ? {}
        : { workspaceId: approved.selection.workspaceId }),
      app: resource(approved.appDatabase),
      auth: resource(approved.authDatabase),
      ...(approved.authOperatorRole === undefined
        ? {}
        : { authOperatorRole: approved.authOperatorRole }),
      release: {
        id: approved.release.id,
        artifactHash: z
          .string()
          .regex(/^sha256:[a-f0-9]{64}$/u)
          .parse(manifest.hashes.schema)
          .slice(7),
        manifestHash: approved.release.sha256,
      },
      installer: { id: PROTECTED_GENERATED_APP_INSTALLER_ID, sqlBundleHash },
      organizations,
    },
    trust: { id: PROTECTED_GENERATED_APP_INSTALLER_ID, sqlBundleHash },
    fenceGeneration: context.operation.fence_generation,
    operationRef: context.operation.operation_id,
    releaseDirectory: input.releaseDirectory,
    connections,
    assertCurrent: input.assertCurrent,
    readOnly: approved.signupGrantReadback !== undefined,
    retainedInstallationCustomerIds: customers.filter(
      (customerId) => !accessCustomers.includes(customerId),
    ),
  });
  return { approved, organizations, installer };
}

/** Fixed approved-plan access bridge. Auth and kernel writes remain owned by the existing saga. */
export async function runProtectedGeneratedAppAccess(input: {
  spoolDirectory: string;
  runId: string;
  timeoutMs: number;
  releaseDirectory: string;
  notices?: NodeJS.WritableStream;
  readbackOnly?: boolean;
  readbackKind?: "install";
}): Promise<void> {
  const session = new ProtectedInstallerSpoolSession({
    ...input,
    notices: input.notices ?? process.stdout,
  });
  let planBytes: Buffer | undefined;
  let credentialsBytes: Buffer | undefined;
  let started = false;
  try {
    session.open();
    const context = session.context;
    planBytes = session.readStartupFile("approved-access-plan.json");
    const rawPlan: unknown = JSON.parse(planBytes.toString("utf8"));
    if (
      context.installer.id !== PROTECTED_GENERATED_APP_INSTALLER_ID ||
      digestHex(readFileSync(process.execPath)) !== context.installer.sha256
    )
      workerReject("protected_installer_identity_mismatch");
    credentialsBytes = session.readStartupFile("access-connections.json");
    const connections = protectedGeneratedConnectionsSchema.parse(
      JSON.parse(credentialsBytes.toString("utf8")),
    );
    if (connections.appMigrator !== session.databaseUrl)
      workerReject("protected_installer_identity_mismatch");
    const { approved, organizations, installer } = createApprovedGeneratedAccessInspector({
      approvedPlan: rawPlan,
      ...(input.readbackOnly && input.readbackKind === "install"
        ? { purpose: "install" as const }
        : {}),
      context,
      connections,
      releaseDirectory: input.releaseDirectory,
      assertCurrent: async () => {
        await session.assertCurrent();
      },
    });
    if (
      approved.installer.reference !== context.installer.id ||
      approved.installer.sha256 !== context.installer.sha256 ||
      (approved.signupGrantReadback && (!input.readbackOnly || input.readbackKind === "install"))
    )
      workerReject("protected_installer_identity_mismatch");
    session.lifecycle.started();
    started = true;
    const active = approved.action === "prepare";
    if (input.readbackOnly) {
      const status =
        input.readbackKind === "install"
          ? await installer.reconcileInstall()
          : approved.signupGrantReadback
            ? await installer.observeSignupGrant(approved.signupGrantReadback)
            : await installer.inspectAccess(active);
      await session.assertCurrent();
      writeFileSync(
        path.join(input.spoolDirectory, "readback.json"),
        JSON.stringify({
          version: 1,
          operation_id: context.operation.operation_id,
          context_digest: session.contextDigest,
          fence_generation: context.operation.fence_generation,
          status,
          readback_sha256: digestJson({
            appId: approved.selection.appId,
            organizations,
            active,
            fenceGeneration: context.operation.fence_generation,
            status,
            ...(approved.signupGrantReadback
              ? { signupGrantReadback: approved.signupGrantReadback }
              : {}),
          }),
        }),
        { mode: 0o600, flag: "wx" },
      );
      session.lifecycle.succeeded();
      return;
    }
    const effectId = active ? "generated_app.grant_access" : "generated_app.revoke_access";
    const sequence = await session.authorize(effectId, null);
    if (active) await installer.grant();
    else await installer.revoke();
    if ((await installer.reconcileAccess(active)) !== "applied")
      throw new Error("protected_installer_access_readback_failed");
    await session.assertCurrent();
    await session.checkpoint(sequence, effectId, null, {
      state: "applied",
      readback_sha256: digestJson({
        appId: approved.selection.appId,
        organizations,
        active,
        fenceGeneration: context.operation.fence_generation,
        appResourceId: approved.appDatabase.resourceId,
        authResourceId: approved.authDatabase.resourceId,
      }),
    });
    session.lifecycle.succeeded();
  } catch (error) {
    session.lifecycle.failed(workerFailureCode(error, started));
    throw new Error("protected_generated_app_access_failed");
  } finally {
    planBytes?.fill(0);
    credentialsBytes?.fill(0);
    try {
      session.removeStartupFile("approved-access-plan.json");
    } finally {
      try {
        session.removeStartupFile("access-connections.json");
      } finally {
        session.close();
      }
    }
  }
}

type PreparedGeneratedTarget = {
  customerId: string;
  schemaRevisionId: number;
  effectiveArtifactHash: string;
  expectedActiveEffectiveHash: string | null;
};

class GeneratedReleaseEffects {
  private onlineActiveHashes: ReadonlyMap<string, string> | undefined;

  constructor(
    private readonly client: PoolClient,
    private readonly context: WorkerContext,
    private readonly manifest: ReturnType<typeof verifyCheckedRelease>,
    private readonly release: Map<string, Buffer>,
    private readonly authority: ProtectedInstallerSpoolSession,
    private readonly runtimeAccessCustomers: ReadonlySet<string>,
  ) {}

  async installBundle(): Promise<void> {
    const bundle = this.release.get("sql-bundle.sql")!.toString("utf8");
    await this.effect("generated_app.install_bundle", null, async () => {
      const online =
        this.runtimeAccessCustomers.size === 0 ? readOnlineSchemaPlan(this.release) : undefined;
      if (online) {
        this.onlineActiveHashes = await installOnlineSchema(
          this.client,
          {
            appId: this.context.app_id,
            customerIds: this.context.tenant_targets,
            candidateSchema: readOnlineSchemaCandidate(this.release),
            candidateHash: this.manifest.hashes.schema!.slice(7),
          },
          online,
          () => this.authority.assertCurrent(),
        );
      } else {
        await this.client.query(bundle);
        await this.client.query(appBaseActivationSql);
        await this.client.query(appBaseContinuationSql);
        await this.client.query("select kernel_install_runtime_privileges()");
      }
      const functions = await this.client.query<{
        prepare: string | null;
        activate: string | null;
      }>(
        "select to_regprocedure('kernel_prepare_schema_revision(jsonb)')::text as prepare, to_regprocedure('kernel_activate_app_base_schema_revision(jsonb)')::text as activate",
      );
      const capabilities = await this.client.query<{
        execution_owner: string;
        runtime_capability: string;
      }>(
        "select kernel_installer_capability_role('execution_owner') as execution_owner, kernel_installer_capability_role('runtime') as runtime_capability",
      );
      const capabilityRow = capabilities.rows[0];
      if (!capabilityRow) workerReject("protected_installer_release_readback_failed");
      const verifiedCapabilities = capabilityRow!;
      const installed = await this.client.query<{ continue_base: string | null }>(
        "select to_regprocedure('kernel_continue_app_base_schema_revision(jsonb)')::text as continue_base",
      );
      const access = await this.client.query<{
        owner: string;
        security_definer: boolean;
        migrator_can_execute: boolean;
        runtime_login_can_execute: boolean;
        runtime_capability_can_execute: boolean;
        public_can_execute: boolean;
      }>(
        `select pg_get_userbyid(p.proowner) as owner,
                p.prosecdef as security_definer,
                has_function_privilege($1, p.oid, 'EXECUTE') as migrator_can_execute,
                has_function_privilege($2, p.oid, 'EXECUTE') as runtime_login_can_execute,
                has_function_privilege($3, p.oid, 'EXECUTE') as runtime_capability_can_execute,
                exists (
                  select 1
                  from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) privilege
                  where privilege.grantee = 0 and privilege.privilege_type = 'EXECUTE'
                ) as public_can_execute
         from pg_proc p
         where p.oid = to_regprocedure('kernel_continue_app_base_schema_revision(jsonb)')`,
        [
          this.context.resource.migrator_role,
          this.context.resource.runtime_role,
          verifiedCapabilities.runtime_capability,
        ],
      );
      const functionRow = functions.rows[0];
      const continuationRow = installed.rows[0];
      const accessRow = access.rows[0];
      if (
        !functionRow?.prepare ||
        !functionRow.activate ||
        !continuationRow?.continue_base ||
        !accessRow ||
        accessRow.owner !== verifiedCapabilities.execution_owner ||
        accessRow.security_definer ||
        !accessRow.migrator_can_execute ||
        accessRow.runtime_login_can_execute ||
        accessRow.runtime_capability_can_execute ||
        accessRow.public_can_execute
      )
        workerReject("protected_installer_release_readback_failed");
      const verifiedAccess = accessRow!;
      return {
        prepare: functionRow!.prepare!,
        activate: functionRow!.activate!,
        continuation: continuationRow!.continue_base!,
        continuation_owner: verifiedAccess.owner,
        runtime_private:
          !verifiedAccess.runtime_login_can_execute && !verifiedAccess.public_can_execute,
      };
    });
  }

  async prepare(customerId: string): Promise<PreparedGeneratedTarget> {
    const artifact = JSON.parse(this.release.get("app-artifact.json")!.toString("utf8")) as {
      schema: Record<string, unknown>;
    };
    const transitionContract = JSON.parse(
      this.release.get("transition-contract.json")!.toString("utf8"),
    ) as unknown;
    const schema = { ...artifact.schema, customer_id: customerId };
    const scopedTransitionContract = rebindWorkerTransitionContract(transitionContract, customerId);
    const schemaHashResult = await this.client.query<{ hash: string }>(
      "select kernel_admin_sha256(kernel_canonical_json($1::jsonb)) as hash",
      [JSON.stringify(schema)],
    );
    const schemaHash = schemaHashResult.rows[0]?.hash;
    if (!schemaHash) workerReject("protected_installer_schema_hash_unavailable");
    const active = await withProtectedTenantReadback(
      this.client,
      this.context.app_id,
      customerId,
      () =>
        this.client.query<{ effective_artifact_hash: string }>(
          "select sir.effective_artifact_hash from schema_revision sr join schema_installation_revision sir on sir.schema_revision_id=sr.id where sr.app_id=$1 and sr.customer_id=$2 and sr.activated_at is not null order by sr.id desc limit 1",
          [this.context.app_id, customerId],
        ),
    );
    const expectedActiveEffectiveHash = active.rows[0]?.effective_artifact_hash ?? null;
    if (
      this.onlineActiveHashes &&
      this.onlineActiveHashes.get(customerId) !== expectedActiveEffectiveHash
    )
      workerReject("protected_installer_online_schema_mismatch");
    const artifactHash = this.manifest.hashes.schema!.replace(/^sha256:/u, "");
    const materializationPlanHash = digestHex(Buffer.from("[]"));
    const request = {
      app_id: this.context.app_id,
      customer_id: customerId,
      version: this.manifest.schema_version,
      release_id: this.manifest.schema_version,
      activation_kind: "app_base",
      schema_hash: schemaHash,
      base_artifact_hash: artifactHash,
      effective_artifact_hash: artifactHash,
      materialization_plan_hash: materializationPlanHash,
      expected_active_effective_hash: expectedActiveEffectiveHash,
      materialization_source: "operator",
      materialization_git_sha: null,
      materialization_vercel_deployment_id: null,
      materialization_vercel_environment: null,
      materialization_vercel_git_ref: null,
      base_schema: schema,
      customer_overlay: {},
      schema,
      seed_change_sets: [],
      phase_plan: [],
      transition_contract: scopedTransitionContract,
    };
    return this.effect("generated_app.prepare_schema_revision", customerId, async () => {
      const data = await this.callRevisionKernel<{
        schema_revision_id: number;
        effective_artifact_hash: string;
      }>("kernel_prepare_schema_revision", request);
      const persisted = await withProtectedTenantReadback(
        this.client,
        this.context.app_id,
        customerId,
        () =>
          this.client.query<{
            id: string;
            effective_artifact_hash: string;
            expected_active_effective_hash: string | null;
          }>(
            "select sr.id, sir.effective_artifact_hash, sir.expected_active_effective_hash from schema_revision sr join schema_installation_revision sir on sir.schema_revision_id=sr.id where sr.app_id=$1 and sr.customer_id=$2 and sir.release_id=$3 and sir.activation_kind='app_base'",
            [this.context.app_id, customerId, this.manifest.schema_version],
          ),
      );
      if (
        persisted.rowCount !== 1 ||
        Number(persisted.rows[0]?.id) !== data.schema_revision_id ||
        persisted.rows[0]?.effective_artifact_hash !== data.effective_artifact_hash
      )
        workerReject("protected_installer_prepare_readback_failed");
      return {
        customerId,
        schemaRevisionId: Number(persisted.rows[0]!.id),
        effectiveArtifactHash: persisted.rows[0]!.effective_artifact_hash,
        expectedActiveEffectiveHash: persisted.rows[0]!.expected_active_effective_hash,
      };
    });
  }

  async validateReadiness(target: PreparedGeneratedTarget): Promise<void> {
    await this.effect("generated_app.validate_readiness", target.customerId, async () => {
      const readback = () =>
        withProtectedTenantReadback(this.client, this.context.app_id, target.customerId, () =>
          this.client.query<{ ready_at: Date | null; activated_at: Date | null }>(
            "select sir.ready_at, sr.activated_at from schema_installation_revision sir join schema_revision sr on sr.id=sir.schema_revision_id where sir.schema_revision_id=$1 and sir.app_id=$2 and sir.customer_id=$3 and sir.effective_artifact_hash=$4",
            [
              target.schemaRevisionId,
              this.context.app_id,
              target.customerId,
              target.effectiveArtifactHash,
            ],
          ),
        );
      let result = await readback();
      if (result.rowCount !== 1) workerReject("protected_installer_readiness_readback_failed");
      if (result.rows[0]?.activated_at) {
        if (!result.rows[0].ready_at) workerReject("protected_installer_readiness_readback_failed");
      } else {
        await this.callRevisionKernel("kernel_validate_schema_revision_readiness", {
          app_id: this.context.app_id,
          customer_id: target.customerId,
          schema_revision_id: target.schemaRevisionId,
          effective_artifact_hash: target.effectiveArtifactHash,
          materialization_plan_hash: digestHex(Buffer.from("[]")),
          phase_results: [],
        });
        result = await readback();
        if (result.rowCount !== 1 || !result.rows[0]?.ready_at)
          workerReject("protected_installer_readiness_readback_failed");
      }
      return { tenant_id: target.customerId, ready: true };
    });
  }

  async activate(targets: PreparedGeneratedTarget[]): Promise<void> {
    const artifactHash = this.manifest.hashes.schema!.replace(/^sha256:/u, "");
    const request = {
      app_id: this.context.app_id,
      release_id: this.manifest.schema_version,
      base_artifact_hash: artifactHash,
      targets: targets.map((target) => ({
        customer_id: target.customerId,
        schema_revision_id: target.schemaRevisionId,
        effective_artifact_hash: target.effectiveArtifactHash,
        expected_active_effective_hash: target.expectedActiveEffectiveHash,
      })),
    };
    await this.effect("generated_app.activate_app_base", null, async () => {
      const activeBase = await withProtectedAppCatalogReadback(
        this.client,
        this.context.app_id,
        () =>
          this.client.query<{
            active_count: string;
            current_count: string;
          }>(
            "select count(*)::text as active_count, count(*) filter (where sir.base_artifact_hash=$2 and sr.base_schema->>'version'=$3)::text as current_count from schema_revision sr left join schema_installation_revision sir on sir.schema_revision_id=sr.id where sr.app_id=$1 and sr.activated_at is not null",
            [this.context.app_id, artifactHash, this.manifest.schema_version],
          ),
      );
      const activeCount = Number(activeBase.rows[0]?.active_count ?? 0);
      const currentCount = Number(activeBase.rows[0]?.current_count ?? 0);
      const continuation = activeCount > 0 && activeCount === currentCount;
      await this.callRevisionKernel(
        continuation
          ? "kernel_continue_app_base_schema_revision"
          : "kernel_activate_app_base_schema_revision",
        request,
      );
      const readback = await withProtectedAppCatalogReadback(this.client, this.context.app_id, () =>
        this.client.query<{
          customer_id: string;
          effective_artifact_hash: string;
        }>(
          "select customer_id, effective_artifact_hash from schema_installation_revision where app_id=$1 and release_id=$2 and activation_kind='app_base' and customer_id=any($3::text[]) and activated_at is not null order by customer_id",
          [
            this.context.app_id,
            this.manifest.schema_version,
            targets.map((target) => target.customerId),
          ],
        ),
      );
      const actual = readback.rows.map((row) => row.customer_id).sort();
      const expected = targets.map((target) => target.customerId).sort();
      if (
        JSON.stringify(actual) !== JSON.stringify(expected) ||
        readback.rows.some((row) => row.effective_artifact_hash !== artifactHash)
      )
        workerReject("protected_installer_activation_readback_failed");
      return { targets: actual, artifact_hash: artifactHash };
    });
  }

  async grantRuntimeCapability(): Promise<void> {
    await this.effect("generated_app.grant_runtime_capability", null, async () => {
      const capability = await this.client.query<{ role: string }>(
        "select kernel_installer_capability_role('runtime') as role",
      );
      const role = sqlName.parse(capability.rows[0]?.role);
      const memberships = await this.client.query<{ role: string }>(
        "select parent.rolname as role from pg_auth_members m join pg_roles child on child.oid=m.member join pg_roles parent on parent.oid=m.roleid where child.rolname=$1 order by parent.rolname",
        [this.context.resource.runtime_role],
      );
      if (memberships.rows.some((entry) => entry.role !== role))
        workerReject("protected_installer_runtime_role_readback_failed");
      if (!memberships.rows.some((entry) => entry.role === role))
        await this.client.query(
          `grant ${identifier(role)} to ${identifier(this.context.resource.runtime_role)}`,
        );
      const readback = await this.client.query<{ role: string }>(
        "select parent.rolname as role from pg_auth_members m join pg_roles child on child.oid=m.member join pg_roles parent on parent.oid=m.roleid where child.rolname=$1 order by parent.rolname",
        [this.context.resource.runtime_role],
      );
      if (readback.rowCount !== 1 || readback.rows[0]?.role !== role)
        workerReject("protected_installer_runtime_role_readback_failed");
      return { runtime_role: this.context.resource.runtime_role, capability_role: role };
    });
  }

  private async callRevisionKernel<T>(operation: string, request: unknown): Promise<T> {
    const run = () => callWorkerKernel<T>(this.client, operation, request);
    if (!this.onlineActiveHashes) return run();
    return runOnlineSchemaRevisionEffect(this.client, () => this.authority.assertCurrent(), run);
  }

  async bindRuntimeScope(customerId: string): Promise<void> {
    if (!this.runtimeAccessCustomers.has(customerId)) {
      await this.authority.assertCurrent();
      await verifyRetainedRuntimeScope(
        this.client,
        this.context.app_id,
        customerId,
        this.context.resource.runtime_role,
      );
      return;
    }
    await this.effect("generated_app.bind_runtime_scope", customerId, async () => {
      await callWorkerKernel(this.client, "kernel_bind_principal_scope", {
        principal_name: this.context.resource.runtime_role,
        app_id: this.context.app_id,
        customer_id: customerId,
        capability: "runtime",
        actor_binding_required: true,
        active: true,
      });
      const readback = await withProtectedTenantReadback(
        this.client,
        this.context.app_id,
        customerId,
        () =>
          this.client.query<{
            active: boolean;
            actor_binding_required: boolean;
            capability: string;
          }>(
            "select active, actor_binding_required, capability from kernel_principal_scope where principal_name=$1 and app_id=$2 and customer_id=$3 and capability='runtime'",
            [this.context.resource.runtime_role, this.context.app_id, customerId],
          ),
      );
      if (
        readback.rowCount !== 1 ||
        readback.rows[0]?.active !== true ||
        readback.rows[0]?.actor_binding_required !== true
      )
        workerReject("protected_installer_scope_readback_failed");
      return { tenant_id: customerId, capability: "runtime", active: true };
    });
  }

  async verifyComplete(): Promise<void> {
    const installed = await withProtectedAppCatalogReadback(this.client, this.context.app_id, () =>
      this.client.query<{
        customer_id: string;
        effective_artifact_hash: string;
      }>(
        "select customer_id, effective_artifact_hash from schema_installation_revision where app_id=$1 and release_id=$2 and activation_kind='app_base' and customer_id=any($3::text[]) and activated_at is not null order by customer_id",
        [this.context.app_id, this.manifest.schema_version, this.context.tenant_targets],
      ),
    );
    const actual = installed.rows.map((row) => row.customer_id).sort();
    const expected = [...this.context.tenant_targets].sort();
    const artifactHash = this.manifest.hashes.schema!.replace(/^sha256:/u, "");
    if (
      JSON.stringify(actual) !== JSON.stringify(expected) ||
      installed.rows.some((row) => row.effective_artifact_hash !== artifactHash)
    )
      workerReject("protected_installer_release_readback_failed");
    for (const customerId of this.context.tenant_targets) {
      const scope = await withProtectedTenantReadback(
        this.client,
        this.context.app_id,
        customerId,
        () =>
          this.client.query(
            "select 1 from kernel_principal_scope where principal_name=$1 and app_id=$2 and customer_id=$3 and capability='runtime' and active",
            [this.context.resource.runtime_role, this.context.app_id, customerId],
          ),
      );
      if (scope.rowCount !== 1) workerReject("protected_installer_scope_readback_failed");
    }
  }

  private async effect<T>(
    effectId: WorkerEffect,
    tenantId: string | null,
    perform: () => Promise<T>,
  ): Promise<T> {
    const sequence = await this.authority.authorize(effectId, tenantId);
    let readback: unknown;
    try {
      readback = await perform();
    } catch {
      await this.authority.checkpoint(sequence, effectId, tenantId, { state: "unknown" });
      throw new Error("protected_installer_readback_unknown");
    }
    await this.authority.checkpoint(sequence, effectId, tenantId, {
      state: "applied",
      readback_sha256: digestJson(readback),
    });
    return readback as T;
  }
}

class WorkerKernelError extends Error {
  constructor(readonly code: string) {
    super("protected_installer_kernel_rejected");
  }
}

async function callWorkerKernel<T = unknown>(
  client: PoolClient,
  operation: string,
  request: unknown,
): Promise<T> {
  const result = await client.query<{
    result: { ok?: boolean; data?: T; error?: { code?: string } };
  }>(`select ${operation}($1::jsonb) as result`, [JSON.stringify(request)]);
  const envelope = result.rows[0]?.result;
  if (!envelope?.ok) throw new WorkerKernelError(envelope?.error?.code ?? "kernel_rejected");
  return envelope.data as T;
}

function rebindWorkerTransitionContract(value: unknown, customerId: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const contract = value as { predecessors?: Array<{ schema?: Record<string, unknown> }> };
  if (!Array.isArray(contract.predecessors)) return value;
  return {
    ...contract,
    predecessors: contract.predecessors.map((predecessor) => ({
      ...predecessor,
      schema: predecessor.schema
        ? { ...predecessor.schema, customer_id: customerId }
        : predecessor.schema,
    })),
  };
}

function verifyWorkerRelease(
  members: ReadonlyMap<string, Buffer>,
  context: WorkerContext,
  metadata: WorkerMetadata,
) {
  const manifest = (() => {
    try {
      return verifyCheckedReleaseMembers(members);
    } catch {
      return workerReject("protected_installer_release_invalid");
    }
  })();
  const hashMembers = {
    server_bindings: "data-server.ts",
    operations: "operation-manifest.json",
    bindings: "data-operations.ts",
    operation_docs: "data-operations.md",
    schema: "app-artifact.json",
    plan: "transition-plan.json",
    transition_contract: "transition-contract.json",
    bundle: "sql-bundle.sql",
    coverage: "runtime-coverage.json",
    sql_manifest: "sql-manifest.json",
    source_map: "cue-to-sql-source-map.json",
  } as const;
  for (const [key, name] of Object.entries(hashMembers)) {
    if (manifest.hashes[key] !== `sha256:${digestHex(members.get(name)!)}`)
      workerReject("protected_installer_release_identity_mismatch");
  }
  const manifestBytes = members.get("release-manifest.json")!;
  const artifactBytes = members.get("app-artifact.json")!;
  const bundleBytes = members.get("sql-bundle.sql")!;
  if (
    manifest.app !== context.app_id ||
    manifest.schema_version !== context.release.id ||
    metadata.app_id !== context.app_id ||
    metadata.release_id !== manifest.schema_version ||
    metadata.release_manifest_sha256 !== digestHex(manifestBytes) ||
    metadata.release_manifest_sha256 !== context.release.sha256 ||
    metadata.app_artifact_sha256 !== digestHex(artifactBytes) ||
    metadata.sql_bundle_sha256 !== digestHex(bundleBytes)
  )
    workerReject("protected_installer_release_identity_mismatch");
  return manifest;
}

function readWorkerRelease(directory: string): Map<string, Buffer> {
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
    workerReject("protected_installer_release_invalid");
  const names = readdirSync(directory).toSorted();
  if (
    names.length !== releaseNames.length ||
    names.some((name, index) => name !== releaseNames.toSorted()[index])
  )
    workerReject("protected_installer_release_invalid");
  const release = new Map<string, Buffer>();
  for (const name of releaseNames) {
    const file = path.join(directory, name);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      workerReject("protected_installer_release_invalid");
    release.set(name, readFileSync(file));
  }
  return release;
}

async function verifyBundleTransactionShape(bundle: string): Promise<void> {
  const parsed = await parse(bundle);
  const transactions = (parsed.stmts ?? []).filter(
    (statement) => "TransactionStmt" in (statement.stmt ?? {}),
  );
  if (
    transactions.length !== 2 ||
    [...bundle.matchAll(/^begin;\s*$/gimu)].length !== 1 ||
    [...bundle.matchAll(/^commit;\s*$/gimu)].length !== 1
  )
    workerReject("protected_installer_release_invalid");
}

function workerFailureCode(error: unknown, started: boolean): ProtectedInstallerFailureCode {
  const message = error instanceof Error ? error.message : "";
  if (!started) return "startup_rejected";
  if (message.includes("authority_denied")) return "authority_denied";
  if (message.includes("readback_unknown")) return "readback_unknown";
  if (message.includes("timeout")) return "timeout";
  if (message.includes("protocol")) return "protocol_failure";
  if (message.includes("checkpoint_unconfirmed")) return "protocol_failure";
  return "effect_failed";
}
