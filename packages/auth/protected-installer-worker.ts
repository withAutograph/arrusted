import {
  runProtectedAuthMembershipInstaller,
  runProtectedAuthMembershipReadback,
  runProtectedAuthSignupPolicyInstaller,
} from "./protected-membership-worker";
import {
  runProtectedAppAccess,
  runProtectedAppAccessReadback,
} from "./protected-app-access-worker";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { readApprovedAuthOperatorPlan } from "./approved-operator-plan";
import { Pool } from "pg";
import { z } from "zod";
import { verifyAuthSchemaReadiness } from "./schema-readiness";
import type { BetterAuthOptions } from "better-auth";
import {
  readAuthDatabaseResource,
  verifyAuthDatabaseResource,
  AuthDatabaseIdentityError,
  type AuthDatabaseResource,
} from "./database-resource";
import {
  ProtectedInstallerSpoolSession,
  authStartupDomainCodeSchema,
  type AuthStartupFailure,
  type AuthStartupStage,
  type ProtectedInstallerFailureCode,
} from "../protected-installer/node-spool";
import {
  applyAuthSchemaMigration,
  EMPTY_AUTH_PUBLIC_CATALOG_HASH,
  authSchemaHash,
  planAuthSchemaMigration,
  readAuthSchemaMigration,
  verifyAuthDesiredSchema,
  AuthSchemaMigrationError,
  type AuthSchemaPlan,
} from "../../.config/mise/scripts/repository/auth-schema-history";
import {
  createAuthSchemaOptions,
  provisionEnrolledAuthAccess,
} from "../../.config/mise/scripts/repository/auth-enrolled-provision";

export const AUTH_PROTECTED_INSTALLER_ID = "auth-protected-installer-v1";
export const AUTH_SCHEMA_ONLY_INSTALLER_ID = "auth-protected-schema-v1";
export const AUTH_SCHEMA_EFFECT = "auth:apply-schema-plan";
export const AUTH_ACCESS_EFFECT = "auth:provision-access";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const authSchemaPlanSchema = z.strictObject({
  version: z.literal(1),
  resource: z.unknown(),
  authOperatorRole: z.string().optional(),
  toolchain: z.literal("better-auth@1.7.3"),
  history: z.strictObject({
    version: z.literal(1),
    schema: z.literal("_auth_schema_history"),
    tables: z.tuple([z.literal("plan"), z.literal("attempt")]),
  }),
  catalogAppIds: z
    .array(z.string().min(1))
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length)
    .refine((ids) => ids.every((id, index) => index === 0 || ids[index - 1]! < id)),
  targetDigest: hash,
  beforeSchemaHash: hash,
  effects: z
    .array(
      z.strictObject({
        owner: z.enum([
          "compatibility",
          "preview-artifact",
          "better-auth",
          "platform",
          "readiness",
          "runtime-privileges",
          "operator-privileges",
        ]),
        sql: z.string(),
        sha256: hash,
      }),
    )
    .min(4),
  planDigest: hash,
});
const startupSchema = z.strictObject({
  version: z.literal(1),
  proposal: z.literal("new-empty").optional(),
  resource: z.unknown(),
  schemaPlan: authSchemaPlanSchema,
});

function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function parseStartup(session: ProtectedInstallerSpoolSession): {
  resource: AuthDatabaseResource;
  schemaPlan: AuthSchemaPlan;
  proposal?: "new-empty";
} {
  const parsed = startupSchema.parse(
    JSON.parse(session.readStartupFile("auth-schema-plan.json").toString("utf8")),
  );
  if (
    parsed.proposal === "new-empty" &&
    (parsed.schemaPlan.beforeSchemaHash !== EMPTY_AUTH_PUBLIC_CATALOG_HASH ||
      parsed.schemaPlan.effects.some((effect) => effect.owner === "preview-artifact"))
  )
    throw new Error("invalid_new_empty_auth_proposal");
  const resource = readAuthDatabaseResource(JSON.stringify(parsed.resource));
  if (!resource) throw new Error("invalid_auth_worker_startup");
  const schemaResource = readAuthDatabaseResource(JSON.stringify(parsed.schemaPlan.resource));
  if (!schemaResource || canonical(schemaResource) !== canonical(resource))
    throw new Error("auth_resource_mismatch");
  return { resource, schemaPlan: parsed.schemaPlan as AuthSchemaPlan, proposal: parsed.proposal };
}

function assertContextResource(
  session: ProtectedInstallerSpoolSession,
  resource: AuthDatabaseResource,
  schemaPlan: AuthSchemaPlan,
  installerId = AUTH_PROTECTED_INSTALLER_ID,
): void {
  const { context } = session;
  const target = context.resource;
  if (
    context.app_id !== "auth" ||
    context.tenant_targets.length !== 0 ||
    context.installer.id !== installerId ||
    context.release.id !== schemaPlan.targetDigest ||
    context.release.sha256 !== schemaPlan.planDigest ||
    target.environment !== resource.environment ||
    target.hostname !== resource.hostname ||
    target.port !== resource.port ||
    target.database !== resource.database ||
    target.schema !== resource.schema ||
    target.migrator_role !== resource.migratorRole ||
    target.runtime_role !== resource.runtimeRole ||
    target.provider_project_id !== resource.neon?.projectId ||
    target.provider_branch_id !== resource.neon?.branchId
  )
    throw new Error("auth_worker_context_mismatch");
}

async function verifySchemaReadback(input: {
  connectionString: string;
  resource: AuthDatabaseResource;
  options: Parameters<typeof verifyAuthDesiredSchema>[1];
  expectedHash: string;
  schemaPlan: AuthSchemaPlan;
}): Promise<string> {
  const independent = new Pool({ connectionString: input.connectionString, max: 1 });
  try {
    const client = await independent.connect();
    try {
      await verifyAuthDatabaseResource(client, input.resource, "migrator");
      await verifyAuthDesiredSchema(client, input.options);
      const observedHash = await authSchemaHash(client);
      if (observedHash !== input.expectedHash) throw new Error("auth_schema_readback_mismatch");
      const publicationAsset = input.schemaPlan.effects.find(
        (effect) => effect.owner === "readiness",
        "runtime-privileges",
      );
      if (!publicationAsset) throw new Error("auth_schema_readback_mismatch");
      await verifyAuthSchemaReadiness(client, {
        database: input.resource.database,
        targetDigest: input.schemaPlan.targetDigest,
        assetSha256: publicationAsset.sha256,
      });
      return sha256(
        canonical({
          resource: input.resource,
          schemaHash: observedHash,
        }),
      );
    } finally {
      client.release();
    }
  } finally {
    await independent.end();
  }
}

async function verifyAccessReadback(input: {
  connectionString: string;
  resource: AuthDatabaseResource;
  catalogAppIds: string[];
}): Promise<string> {
  const independent = new Pool({ connectionString: input.connectionString, max: 1 });
  try {
    const client = await independent.connect();
    try {
      await verifyAuthDatabaseResource(client, input.resource, "migrator");
      const organizations = (
        await client.query(
          `select id,name,slug,metadata,"appIds" from "organization"
           where id = any($1::text[]) order by id`,
          [["dev", "hc", "vendor"]],
        )
      ).rows;
      const expected = [
        {
          id: "dev",
          name: "Dev",
          slug: "dev",
          metadata: JSON.stringify({ signupAccess: "all-apps" }),
          appIds: input.catalogAppIds,
        },
        { id: "hc", name: "HC", slug: "hc", metadata: null, appIds: ["hc"] },
        {
          id: "vendor",
          name: "Vendor",
          slug: "vendor",
          metadata: null,
          appIds: ["vendor", "integrations"],
        },
      ];
      const organizationMismatch =
        organizations.length !== expected.length ||
        expected.some((required) => {
          const actual = organizations.find((organization) => organization.id === required.id);
          return (
            !actual ||
            actual.name !== required.name ||
            actual.slug !== required.slug ||
            canonical(actual.metadata) !== canonical(required.metadata) ||
            !Array.isArray(actual.appIds) ||
            !required.appIds.every((appId) => actual.appIds.includes(appId))
          );
        });
      if (organizationMismatch) {
        throw new Error("auth_organization_readback_mismatch");
      }
      const legacy = await client.query(
        `select id from "organization" where id = any($1::text[])
         union all
         select "organizationId" as id from "member" where "organizationId" = any($1::text[])
         union all
         select "organizationId" as id from "invitation" where "organizationId" = any($1::text[])
         union all
         select "activeOrganizationId" as id from "session" where "activeOrganizationId" = any($1::text[])
         union all
         select "organizationId" as id from "app_actor_assignment" where "organizationId" = any($1::text[])`,
        [["demo", "customer_1"]],
      );
      if (legacy.rowCount !== 0) throw new Error("auth_legacy_scope_readback_mismatch");
      const fence = await client.query(
        `select c.convalidated,pg_get_constraintdef(c.oid) as definition
         from pg_constraint c
         where c.conrelid='public.app_actor_assignment'::regclass
           and c.conname='app_actor_assignment_fence_generation_nonnegative'`,
      );
      const column = await client.query(
        `select is_nullable,column_default from information_schema.columns
         where table_schema='public' and table_name='app_actor_assignment'
           and column_name='fence_generation'`,
      );
      const invalidFences = await client.query(
        `select 1 from "app_actor_assignment" where "fence_generation" < 0 limit 1`,
      );
      if (
        fence.rowCount !== 1 ||
        fence.rows[0]?.convalidated !== true ||
        fence.rows[0]?.definition !== "CHECK ((fence_generation >= 0))" ||
        column.rows[0]?.is_nullable !== "NO" ||
        column.rows[0]?.column_default !== "0" ||
        invalidFences.rowCount !== 0
      )
        throw new Error("auth_assignment_readback_mismatch");
      return sha256(canonical({ organizations, fence: fence.rows[0], column: column.rows[0] }));
    } finally {
      client.release();
    }
  } finally {
    await independent.end();
  }
}

function isUnknownReadback(error: unknown): boolean {
  return error instanceof Error && /readback_mismatch/u.test(error.message);
}

async function recordUnknownReadback(
  session: ProtectedInstallerSpoolSession,
  sequence: number,
  effectId: string,
): Promise<never> {
  try {
    await session.checkpoint(sequence, effectId, null, { state: "unknown" });
  } catch (error) {
    if (!(error instanceof Error && error.message === "protected_installer_readback_unknown"))
      throw error;
  }
  throw new Error("auth_readback_unknown");
}

function readApprovedSchemaOnlyPlan(
  session: ProtectedInstallerSpoolSession,
  resource: AuthDatabaseResource,
  schemaPlan: AuthSchemaPlan,
): void {
  const { plan: raw } = readApprovedAuthOperatorPlan(
    session.readStartupFile("operator-plan.json"),
    session.context.operation.approval_digest,
  );
  const plan = z
    .object({
      version: z.literal(1),
      action: z.literal("prepare"),
      authDatabase: z.object({
        database: z.string(),
        resourceId: z.string(),
        migratorRole: z.string(),
        runtimeRole: z.string(),
      }),
      authSchema: z.object({
        planDigest: hash,
        targetDigest: hash,
        authOperatorRole: z.string().optional(),
      }),
      neon: z.object({
        endpoint: z.string(),
        projectId: z.string().optional(),
        branchId: z.string().optional(),
      }),
    })
    .parse(raw);
  const expected = session.context.resource;
  if (
    plan.authDatabase.resourceId !== expected.resource_id ||
    plan.authDatabase.database !== resource.database ||
    plan.authDatabase.migratorRole !== resource.migratorRole ||
    plan.authDatabase.runtimeRole !== resource.runtimeRole ||
    plan.neon.endpoint !== resource.hostname ||
    plan.neon.projectId !== resource.neon?.projectId ||
    plan.neon.branchId !== resource.neon?.branchId ||
    plan.authSchema.authOperatorRole !== schemaPlan.authOperatorRole ||
    plan.authSchema.planDigest !== schemaPlan.planDigest ||
    plan.authSchema.targetDigest !== schemaPlan.targetDigest
  )
    throw new Error("auth_operator_plan_mismatch");
  session.removeStartupFile("operator-plan.json");
}

const authStartupFailure = (stage: AuthStartupStage, error: unknown): AuthStartupFailure => {
  try {
    const codeValue: unknown = Object.getOwnPropertyDescriptor(error, "code")?.value;
    const messageValue: unknown = Object.getOwnPropertyDescriptor(error, "message")?.value;
    const code = authStartupDomainCodeSchema.safeParse(codeValue);
    const message = authStartupDomainCodeSchema.safeParse(messageValue);
    const domainCode = code.success ? code.data : message.success ? message.data : undefined;
    return { stage, ...(domainCode ? { domain_code: domainCode } : {}) };
  } catch {
    return { stage };
  }
};

/** Fixed, credential-free Auth adapter for the protected installer host. */
async function runAuthInstaller(
  input: {
    spoolDirectory: string;
    runId: string;
    timeoutMs: number;
    notices?: NodeJS.WritableStream;
  },
  protocol: "legacy" | "schema-only",
): Promise<void> {
  let session: ProtectedInstallerSpoolSession | undefined;
  let options: BetterAuthOptions | undefined;
  let pool: Pool | undefined;
  let started = false;
  let terminal = false;
  let failureCode: ProtectedInstallerFailureCode = "startup_rejected";
  let startupStage: AuthStartupStage = "spool_open";
  try {
    session = new ProtectedInstallerSpoolSession(input).open();
    startupStage = "startup_plan_parse";
    const { resource, schemaPlan, proposal } = parseStartup(session);
    startupStage = "context_binding";
    assertContextResource(
      session,
      resource,
      schemaPlan,
      protocol === "schema-only" ? AUTH_SCHEMA_ONLY_INSTALLER_ID : AUTH_PROTECTED_INSTALLER_ID,
    );
    startupStage = "approved_plan_binding";
    if (protocol === "schema-only") readApprovedSchemaOnlyPlan(session, resource, schemaPlan);
    else if (schemaPlan.authOperatorRole !== undefined)
      throw new Error("auth_operator_profile_requires_schema_only");
    session.removeStartupFile("auth-schema-plan.json");

    // The schema lock holds one connection while Better Auth introspection
    // acquires another from this same pool.
    startupStage = "schema_options";
    pool = new Pool({ connectionString: session.databaseUrl, max: 2 });
    options = createAuthSchemaOptions(pool);
    startupStage = "schema_replan";
    const previewEffects = schemaPlan.effects.filter(
      (effect) => effect.owner === "preview-artifact",
    );
    if (previewEffects.length > 1) throw new Error("invalid_auth_schema_plan");
    const planned = await planAuthSchemaMigration({
      pool,
      resource,
      requireNewEmptyPublicNamespace: proposal === "new-empty",
      catalogAppIds: schemaPlan.catalogAppIds,
      authOperatorRole: schemaPlan.authOperatorRole,
      options,
      ...(previewEffects[0] ? { previewSql: previewEffects[0].sql } : {}),
    });
    if (
      planned.planDigest !== schemaPlan.planDigest ||
      planned.targetDigest !== schemaPlan.targetDigest ||
      canonical(planned) !== canonical(schemaPlan)
    )
      throw new Error("auth_schema_plan_mismatch");
    startupStage = "migrator_preflight";
    const preflight = await pool.connect();
    try {
      await verifyAuthDatabaseResource(preflight, resource, "migrator");
    } finally {
      preflight.release();
    }

    session.lifecycle.started();
    started = true;

    failureCode = "authority_denied";
    const schemaSequence = await session.authorize(AUTH_SCHEMA_EFFECT, null);
    failureCode = "effect_failed";
    const schemaReceipt = await applyAuthSchemaMigration({
      pool,
      resource,
      requireNewEmptyPublicNamespace: proposal === "new-empty",
      catalogAppIds: schemaPlan.catalogAppIds,
      authOperatorRole: schemaPlan.authOperatorRole,
      options,
      ...(previewEffects[0] ? { previewSql: previewEffects[0].sql } : {}),
      approvedDigest: schemaPlan.planDigest,
    });
    failureCode = "readback_unknown";
    const schemaReadback = await verifySchemaReadback({
      connectionString: session.databaseUrl,
      resource,
      options,
      expectedHash: schemaReceipt.afterSchemaHash ?? "",
      schemaPlan,
    }).catch(async (error): Promise<string> => {
      const category =
        error instanceof AuthSchemaMigrationError
          ? error.code
          : error instanceof AuthDatabaseIdentityError
            ? error.code
            : "readback_failed";
      console.error(`Protected Auth schema readback failed: ${category}`);
      return recordUnknownReadback(session!, schemaSequence, AUTH_SCHEMA_EFFECT);
    });
    failureCode = "protocol_failure";
    await session.checkpoint(schemaSequence, AUTH_SCHEMA_EFFECT, null, {
      state: schemaReceipt.replayed ? "no_change" : "applied",
      readback_sha256: schemaReadback,
    });

    if (protocol === "schema-only") {
      session.lifecycle.succeeded();
      terminal = true;
      return;
    }
    failureCode = "authority_denied";
    const accessSequence = await session.authorize(AUTH_ACCESS_EFFECT, null);
    failureCode = "effect_failed";
    const provisioner = await pool.connect();
    try {
      await provisionEnrolledAuthAccess(provisioner, schemaPlan.catalogAppIds);
    } finally {
      provisioner.release();
    }
    failureCode = "readback_unknown";
    const accessReadback = await verifyAccessReadback({
      connectionString: session.databaseUrl,
      resource,
      catalogAppIds: schemaPlan.catalogAppIds,
    }).catch(async (error): Promise<string> => {
      const category =
        error instanceof Error && /^auth_[a-z_]+$/u.test(error.message)
          ? error.message
          : "access_readback_failed";
      console.error(`Protected Auth access readback failed: ${category}`);
      return recordUnknownReadback(session!, accessSequence, AUTH_ACCESS_EFFECT);
    });
    failureCode = "protocol_failure";
    await session.checkpoint(accessSequence, AUTH_ACCESS_EFFECT, null, {
      state: "applied",
      readback_sha256: accessReadback,
    });
    session.lifecycle.succeeded();
    terminal = true;
  } catch (error) {
    if (isUnknownReadback(error)) failureCode = "readback_unknown";
    if (session && !terminal) {
      try {
        session.lifecycle.failed(
          started ? failureCode : "startup_rejected",
          started ? undefined : authStartupFailure(startupStage, error),
        );
        terminal = true;
      } catch {
        // The relay still treats a missing terminal lifecycle notice as failure.
      }
    }
    throw new Error(`protected_auth_worker_failed:${failureCode}`);
  } finally {
    if (pool) await pool.end().catch(() => {});
    session?.close();
  }
}

export async function runProtectedAuthInstaller(
  input: Parameters<typeof runAuthInstaller>[0],
): Promise<void> {
  await runAuthInstaller(input, "legacy");
}
export async function runProtectedAuthSchemaInstaller(
  input: Parameters<typeof runAuthInstaller>[0],
): Promise<void> {
  await runAuthInstaller(input, "schema-only");
}

/** Read the original approved schema result; this command cannot authorize or repair effects. */
export async function runProtectedAuthSchemaReadback(
  input: Parameters<typeof runAuthInstaller>[0],
): Promise<void> {
  let session: ProtectedInstallerSpoolSession | undefined;
  let pool: Pool | undefined;
  let started = false;
  try {
    session = new ProtectedInstallerSpoolSession(input).open();
    const { resource, schemaPlan } = parseStartup(session);
    assertContextResource(session, resource, schemaPlan, AUTH_SCHEMA_ONLY_INSTALLER_ID);
    readApprovedSchemaOnlyPlan(session, resource, schemaPlan);
    const previewEffects = schemaPlan.effects.filter(
      (effect) => effect.owner === "preview-artifact",
    );
    if (previewEffects.length > 1) throw new Error("invalid_auth_schema_plan");
    session.removeStartupFile("auth-schema-plan.json");
    pool = new Pool({
      connectionString: session.databaseUrl,
      max: 2,
      options: "-c default_transaction_read_only=on",
    });
    session.lifecycle.started();
    started = true;
    await session.assertCurrent();
    const result = await readAuthSchemaMigration({
      pool,
      resource,
      options: createAuthSchemaOptions(pool),
      catalogAppIds: schemaPlan.catalogAppIds,
      authOperatorRole: schemaPlan.authOperatorRole,
      approvedPlan: schemaPlan,
      approvedDigest: schemaPlan.planDigest,
      ...(previewEffects[0] ? { previewSql: previewEffects[0].sql } : {}),
    });
    await session.assertCurrent();
    await writeFile(
      path.join(input.spoolDirectory, "readback.json"),
      JSON.stringify({
        version: 1,
        operation_id: session.context.operation.operation_id,
        context_digest: session.contextDigest,
        fence_generation: session.context.operation.fence_generation,
        status: "applied",
        readback_sha256: sha256(canonical(result)),
      }),
      { mode: 0o600, flag: "wx" },
    );
    session.lifecycle.succeeded();
  } catch {
    const failure = started ? "readback_unknown" : "startup_rejected";
    session?.lifecycle.failed(failure);
    throw new Error(`protected_auth_worker_failed:${failure}`);
  } finally {
    await pool?.end().catch(() => {});
    session?.close();
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (
    args.length !== 5 ||
    ![
      "auth-protected-migrate",
      "auth-protected-schema",
      "auth-protected-schema-readback",
      "auth-protected-membership",
      "auth-protected-signup-policy",
      "auth-protected-membership-readback",
      "auth-protected-app-access",
      "auth-protected-app-access-readback",
    ].includes(args[0] ?? "") ||
    args[1] !== "--file-spool" ||
    !args[2] ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(args[3] ?? "")
  ) {
    console.error("Auth protected installer failed: startup_rejected");
    process.exit(1);
  }
  const timeoutMs = Number(args[4]);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    console.error("Auth protected installer failed: startup_rejected");
    process.exit(1);
  }
  const run =
    args[0] === "auth-protected-app-access"
      ? runProtectedAppAccess
      : args[0] === "auth-protected-app-access-readback"
        ? runProtectedAppAccessReadback
        : args[0] === "auth-protected-membership-readback"
          ? runProtectedAuthMembershipReadback
          : args[0] === "auth-protected-membership"
            ? runProtectedAuthMembershipInstaller
            : args[0] === "auth-protected-signup-policy"
              ? runProtectedAuthSignupPolicyInstaller
              : args[0] === "auth-protected-schema"
                ? runProtectedAuthSchemaInstaller
                : args[0] === "auth-protected-schema-readback"
                  ? runProtectedAuthSchemaReadback
                  : runProtectedAuthInstaller;
  await run({ spoolDirectory: args[2]!, runId: args[3]!, timeoutMs }).catch((error) => {
    const failure =
      error instanceof Error && /^protected_auth_worker_failed:[a-z_]+$/u.test(error.message)
        ? error.message.slice("protected_auth_worker_failed:".length)
        : "effect_failed";
    console.error(`Auth protected installer failed: ${failure}`);
    process.exit(1);
  });
}
