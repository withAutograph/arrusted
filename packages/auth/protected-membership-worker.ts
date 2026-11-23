import { assertAuthOperatorConnection } from "../protected-installer/auth-operator";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, createPublicKey } from "node:crypto";
import { verifyVercelOidcToken } from "@vercel/oidc";
import { Pool } from "pg";
import { z } from "zod";
import { readAuthDatabaseResource } from "./database-resource";
import {
  appSignupPolicyDigest,
  appSignupPolicySchema,
  authDatabaseResourceDigest,
  persistAppSignupPolicy,
} from "./signup-policy";
import { readApprovedAuthOperatorPlan } from "./approved-operator-plan";
import {
  verifyRealmOperatorLinkProofWithPublicKey,
  REALM_OPERATOR_LINK_TYP,
} from "./operator-identity-link";
import {
  createOwnedRealmOrganization,
  readOwnedRealmOrganization,
  joinExistingRealmOrganization,
  readExistingRealmOrganization,
  ownedOrganizationMembershipSchema,
  selectOwnedOrganizationSpec,
} from "./owned-organization";
import {
  ProtectedInstallerSpoolSession,
  type ProtectedInstallerFailureCode,
} from "../protected-installer/node-spool";

export const AUTH_OWNED_ORGANIZATION_INSTALLER_ID = "auth-owned-organization-v1";
export const AUTH_OWNED_ORGANIZATION_EFFECT = "auth-membership";
export const AUTH_APP_SIGNUP_POLICY_EFFECT = "auth-signup-policy";
const id = z.string().min(1).max(256);
const effectSchema = z
  .object({ effectId: id.optional(), id: id.optional(), kind: id })
  .passthrough()
  .superRefine((effect, context) => {
    if (!effect.effectId && !effect.id)
      context.addIssue({ code: "custom", message: "Approved effect requires an id." });
    if (effect.effectId && effect.id && effect.effectId !== effect.id)
      context.addIssue({ code: "custom", message: "Approved effect id aliases must match." });
  })
  .transform(({ effectId, id: approvedId, ...effect }) => ({
    ...effect,
    effectId: effectId ?? approvedId!,
  }));
const effectTargetSchema = z.strictObject({
  version: z.literal(1),
  effectId: id,
  kind: z.enum([AUTH_OWNED_ORGANIZATION_EFFECT, AUTH_APP_SIGNUP_POLICY_EFFECT]),
});
const normalActorProgramSchema = z
  .object({
    appId: id,
    origin: z.string().url(),
    organizations: z.array(z.object({ organizationId: id }).passthrough()).min(1),
    appAccess: z
      .array(z.object({ organizationId: id, roles: z.array(id) }).passthrough())
      .optional(),
  })
  .passthrough();
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const planSchema = z.object({
  version: z.literal(1),
  action: z.literal("prepare"),
  authMembership: ownedOrganizationMembershipSchema.optional(),
  authOperatorRole: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,62}$/u)
    .optional(),
  authSignupPolicy: appSignupPolicySchema.optional(),
  normalActorProgram: normalActorProgramSchema.optional(),
  effects: z.array(effectSchema).optional(),
  selection: z.object({ sessionId: id, workspaceId: id.optional() }),
  authDatabase: z.object({ database: id, migratorRole: id, runtimeRole: id, resourceId: id }),
  neon: z.object({ endpoint: id, projectId: id.optional(), branchId: id.optional() }),
  deploymentBoundary: z.object({
    teamId: id,
    operator: z.object({ projectId: id, environment: z.enum(["preview", "production"]) }),
    verification: z.object({
      publicOrigin: z.string().url(),
      gatewayOrigin: z.string().url(),
      jwksUrl: z.string().url(),
    }),
  }),
});
/** A separate fixed worker. Only a full owner-approved plan can authorize the organization/member effect. */
async function runMembershipWorker(
  input: {
    spoolDirectory: string;
    runId: string;
    timeoutMs: number;
    notices?: NodeJS.WritableStream;
  },
  readOnly: boolean,
  requiredEffect?: typeof AUTH_OWNED_ORGANIZATION_EFFECT | typeof AUTH_APP_SIGNUP_POLICY_EFFECT,
): Promise<void> {
  let session: ProtectedInstallerSpoolSession | undefined;
  let pool: Pool | undefined;
  let started = false;
  let failure: ProtectedInstallerFailureCode = "startup_rejected";
  try {
    session = new ProtectedInstallerSpoolSession(input).open();
    const { plan: raw, planDigest } = readApprovedAuthOperatorPlan(
      session.readStartupFile("operator-plan.json"),
      session.context.operation.approval_digest,
    );
    const plan = planSchema.parse(raw);
    const effectTarget = effectTargetSchema.parse(
      JSON.parse(session.readStartupFile("membership-effect.json").toString("utf8")),
    );
    // Dispatch is a closed worker kind; the complete declared ID retains organization scope.
    const selectedEffect = effectTarget.kind;
    if (!readOnly && requiredEffect !== selectedEffect)
      throw new Error("auth_membership_effect_mismatch");
    session.removeStartupFile("membership-effect.json");
    const declaredEffects = plan.effects ?? [];
    if (new Set(declaredEffects.map((effect) => effect.effectId)).size !== declaredEffects.length)
      throw new Error("auth_membership_effect_mismatch");
    const hasEffect = (effectId: string, kind = effectId) =>
      declaredEffects.some((effect) => effect.effectId === effectId && effect.kind === kind);
    if (!hasEffect(effectTarget.effectId, selectedEffect))
      throw new Error("auth_membership_effect_mismatch");
    if (
      !plan.authMembership &&
      (!plan.normalActorProgram ||
        !plan.authSignupPolicy ||
        !declaredEffects.some((effect) => effect.kind === AUTH_APP_SIGNUP_POLICY_EFFECT))
    )
      throw new Error("auth_membership_plan_mismatch");
    // Never slice/rewrite the approved plan. The launcher checkpoints each selected organization
    // independently and binds its consumed normal owner link in the live authority fence.
    const membership = plan.authMembership
      ? selectOwnedOrganizationSpec(
          plan.authMembership,
          plan.authMembership.kind === "create-owned-organizations"
            ? JSON.parse(session.readStartupFile("membership-target.json").toString("utf8"))
            : undefined,
        )
      : undefined;
    if (plan.authMembership?.kind === "create-owned-organizations")
      session.removeStartupFile("membership-target.json");
    const signupPolicy = plan.authSignupPolicy;
    if (
      membership?.kind === "join-existing-organization" &&
      membership.workspaceId !== plan.selection.workspaceId
    )
      throw new Error("auth_membership_workspace_mismatch");
    const targetOrganizationId = membership?.organizationId ?? signupPolicy?.organizationId;
    const namespaced = effectTarget.effectId !== selectedEffect;
    if (
      namespaced &&
      (targetOrganizationId === undefined ||
        effectTarget.effectId !== `${selectedEffect}:${targetOrganizationId}`)
    )
      throw new Error("auth_membership_effect_mismatch");
    // Companion effects may use either supported ID form in the same approved plan.
    // Compare declared full IDs to the canonical target; never normalize away its scope.
    const scopeEffects = (kind: string) =>
      declaredEffects
        .map((effect, index) => ({ effect, index }))
        .filter(
          ({ effect }) =>
            effect.kind === kind &&
            (effect.effectId === kind ||
              (targetOrganizationId !== undefined &&
                effect.effectId === `${kind}:${targetOrganizationId}`)),
        );
    const membershipEffects = scopeEffects(AUTH_OWNED_ORGANIZATION_EFFECT);
    const signupEffects = scopeEffects(AUTH_APP_SIGNUP_POLICY_EFFECT);
    if (
      signupPolicy &&
      (signupEffects.length === 0 || (membership && membershipEffects.length === 0))
    )
      throw new Error("auth_membership_effect_mismatch");
    if (
      membership &&
      signupPolicy &&
      membershipEffects.some((before) => signupEffects.some((after) => before.index > after.index))
    )
      throw new Error("auth_membership_effect_mismatch");

    const resource = readAuthDatabaseResource(
      session.readStartupFile("auth-database-resource.json").toString("utf8"),
    );
    if (!resource) throw new Error("auth_resource_required");
    const { context } = session;
    const matches = [
      context.installer.id === AUTH_OWNED_ORGANIZATION_INSTALLER_ID,
      context.app_id === "auth",
      context.tenant_targets.length === 0,
      context.operation.approval_digest === planDigest,
      context.release.id === planDigest,
      requiredEffect === AUTH_APP_SIGNUP_POLICY_EFFECT ||
        readOnly ||
        context.release.sha256 === membership?.identityProof.sha256,
      context.resource.resource_id === plan.authDatabase.resourceId,
      resource.database === plan.authDatabase.database,
      resource.runtimeRole === plan.authDatabase.runtimeRole,
      resource.migratorRole === plan.authDatabase.migratorRole,
      resource.hostname === plan.neon.endpoint,
      resource.neon?.projectId === plan.neon.projectId,
      resource.neon?.branchId === plan.neon.branchId,
      context.resource.database === resource.database,
      context.resource.environment === resource.environment,
      context.resource.schema === resource.schema,
      context.resource.hostname === resource.hostname,
      context.resource.port === resource.port,
      context.resource.migrator_role === resource.migratorRole,
      context.resource.runtime_role === resource.runtimeRole,
      context.resource.provider_project_id === resource.neon?.projectId,
      context.resource.provider_branch_id === resource.neon?.branchId,
    ].every(Boolean);
    if (!matches) throw new Error("auth_context_mismatch");
    if (
      selectedEffect === AUTH_OWNED_ORGANIZATION_EFFECT &&
      membership?.kind === "join-existing-organization" &&
      resource.environment === "production" &&
      !plan.authOperatorRole
    )
      throw new Error("auth_operator_role_required");
    if (plan.authOperatorRole) {
      if (membership?.kind !== "join-existing-organization" || signupPolicy)
        throw new Error("auth_operator_scope_mismatch");
      assertAuthOperatorConnection(session.databaseUrl, resource, plan.authOperatorRole);
    }
    if (
      signupPolicy &&
      (signupPolicy.authResourceId !== plan.authDatabase.resourceId ||
        signupPolicy.organizationId !== targetOrganizationId ||
        signupPolicy.appId === "auth" ||
        signupPolicy.origin !== new URL(plan.deploymentBoundary.verification.publicOrigin).origin)
    )
      throw new Error("auth_signup_policy_mismatch");
    if (plan.normalActorProgram && signupPolicy) {
      const normalActorProgram = normalActorProgramSchema.parse(plan.normalActorProgram);
      const organizationCount = normalActorProgram.organizations.filter(
        (organization) => organization.organizationId === signupPolicy.organizationId,
      ).length;
      const accessEntries =
        normalActorProgram.appAccess?.filter(
          (entry) =>
            entry.organizationId === signupPolicy.organizationId &&
            (!("appId" in entry) || entry.appId === signupPolicy.appId),
        ) ?? [];
      const approvedRoles = new Set(accessEntries.flatMap((entry) => entry.roles));
      if (
        normalActorProgram.appId !== signupPolicy.appId ||
        normalActorProgram.origin !== signupPolicy.origin ||
        organizationCount !== 1 ||
        accessEntries.length === 0 ||
        !signupPolicy.appRoles.every((role) => approvedRoles.has(role))
      )
        throw new Error("auth_signup_policy_mismatch");
    }
    if (selectedEffect === AUTH_APP_SIGNUP_POLICY_EFFECT) {
      if (!signupPolicy) throw new Error("auth_signup_policy_required");
      for (const name of [
        "operator-plan.json",
        "auth-database-resource.json",
        "membership-target.json",
        "realm-identity-proof.json",
        "gateway-readback-oidc.json",
      ])
        session.removeStartupFile(name);
      pool = new Pool({ connectionString: session.databaseUrl, max: 1 });
      if (!started) {
        session.lifecycle.started();
        started = true;
      }
      const client = await pool.connect();
      try {
        if (readOnly) {
          await session.assertCurrent();
          const expectedPolicyDigest = appSignupPolicyDigest({
            ...signupPolicy,
            operationRef: context.operation.operation_id,
            planDigest,
            fenceGeneration: context.operation.fence_generation,
          });
          const policyReadback = await client.query(
            `select "policyDigest","fenceGeneration" from public.app_signup_policy where id=$1 and "authResourceId"=$2
               and "resourceDigest"=$3 and "appId"=$4 and "origin"=$5 and "appPath"=$6
               and "organizationId"=$7 and "operationRef"=$8 and "planDigest"=$9`,
            [
              signupPolicy.policyId,
              signupPolicy.authResourceId,
              authDatabaseResourceDigest(resource),
              signupPolicy.appId,
              signupPolicy.origin,
              signupPolicy.appPath,
              signupPolicy.organizationId,
              context.operation.operation_id,
              planDigest,
            ],
          );
          const scopeReadback = await client.query(
            `select 1 from public.organization where id=$1 and "appIds" @> $2::jsonb`,
            [signupPolicy.organizationId, JSON.stringify([signupPolicy.appId])],
          );
          if (
            policyReadback.rows.length !== 1 ||
            policyReadback.rows[0]?.policyDigest !== expectedPolicyDigest ||
            Number(policyReadback.rows[0]?.fenceGeneration) !==
              context.operation.fence_generation ||
            scopeReadback.rows.length !== 1
          )
            throw new Error("auth_membership_readback_unknown");
          await writeFile(
            path.join(input.spoolDirectory, "readback.json"),
            JSON.stringify({
              version: 1,
              operation_id: context.operation.operation_id,
              context_digest: session.contextDigest,
              fence_generation: context.operation.fence_generation,
              status: "applied",
              readback_sha256: sha256(
                canonical({
                  appId: signupPolicy.appId,
                  organizationId: signupPolicy.organizationId,
                  policyDigest: expectedPolicyDigest,
                }),
              ),
            }),
            { mode: 0o600, flag: "wx" },
          );
          session.lifecycle.succeeded();
          return;
        }
        failure = "authority_denied";
        const sequence = await session.authorize(AUTH_APP_SIGNUP_POLICY_EFFECT, null);
        failure = "effect_failed";
        await session.assertCurrent();
        await client.query("begin");
        let policyDigest: string;
        try {
          await session.assertCurrent();
          const scope = await client.query(
            `update public.organization set "appIds"=(
               select coalesce(jsonb_agg(to_jsonb(app_id) order by app_id),'[]'::jsonb) from (
                 select distinct jsonb_array_elements_text(case when jsonb_typeof("appIds")='array' then "appIds" else '[]'::jsonb end) app_id
                 union select $2::text app_id
               ) scoped
             ) where id=$1 returning "appIds"`,
            [signupPolicy.organizationId, signupPolicy.appId],
          );
          if (
            scope.rows.length !== 1 ||
            !Array.isArray(scope.rows[0]?.appIds) ||
            !scope.rows[0]!.appIds.includes(signupPolicy.appId)
          )
            throw new Error("auth_signup_policy_scope_failed");
          const persisted = await persistAppSignupPolicy(client, signupPolicy, {
            operationRef: context.operation.operation_id,
            planDigest,
            fenceGeneration: context.operation.fence_generation,
            resource,
          });
          policyDigest = persisted.policyDigest;
          await session.assertCurrent();
          await client.query("commit");
        } catch (error) {
          await client.query("rollback").catch(() => {});
          throw error;
        }
        failure = "protocol_failure";
        await session.checkpoint(sequence, AUTH_APP_SIGNUP_POLICY_EFFECT, null, {
          state: "applied",
          readback_sha256: sha256(
            canonical({
              appId: signupPolicy.appId,
              organizationId: signupPolicy.organizationId,
              policyDigest,
            }),
          ),
        });
        session.lifecycle.succeeded();
        return;
      } finally {
        client.release();
      }
    }
    if (!membership) throw new Error("auth_membership_plan_mismatch");
    const proof = z
      .strictObject({ proof: z.string().min(1).max(16384) })
      .parse(
        JSON.parse(session.readStartupFile("realm-identity-proof.json").toString("utf8")),
      ).proof;
    if (sha256(proof) !== membership.identityProof.sha256) throw new Error("auth_proof_mismatch");
    const capture = membership.identityCapture;
    if (capture) {
      if (Date.parse(capture.capturedAt) > Date.now()) throw new Error("auth_capture_mismatch");
      // The host verifies this frozen plan against the actual consumed canonical link before returning the fence frame.
      session.lifecycle.started();
      started = true;
      failure = "authority_denied";
      await session.assertCurrent();
    }
    const verification = membership.identityVerification;
    const url = new URL(verification.jwksUrl);
    if (
      url.origin !== new URL(plan.deploymentBoundary.verification.gatewayOrigin).origin ||
      url.pathname !== "/_platform/jwks.json" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      verification.issuer !== plan.deploymentBoundary.verification.publicOrigin
    )
      throw new Error("auth_verifier_mismatch");
    const headers = new Headers();
    if (resource.environment === "local") {
      if (
        !["http:", "https:"].includes(url.protocol) ||
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )
        throw new Error("auth_verifier_mismatch");
    } else {
      if (url.protocol !== "https:") throw new Error("auth_verifier_mismatch");
      const token = z
        .strictObject({ token: z.string().min(1) })
        .parse(
          JSON.parse(session.readStartupFile("gateway-readback-oidc.json").toString("utf8")),
        ).token;
      session.removeStartupFile("gateway-readback-oidc.json");
      const source = verification.transportSource;
      if (
        !source ||
        source.ownerId !== plan.deploymentBoundary.teamId ||
        source.projectId !== plan.deploymentBoundary.operator.projectId ||
        source.environment !== plan.deploymentBoundary.operator.environment
      )
        throw new Error("auth_verifier_mismatch");
      await verifyVercelOidcToken(token, source);
      headers.set("x-vercel-trusted-oidc-idp-token", token);
    }
    const response = await fetch(url, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok || response.redirected) throw new Error("auth_verifier_unavailable");
    const headerBytes = proof.split(".")[0];
    if (!headerBytes) throw new Error("auth_proof_mismatch");
    const header = z
      .strictObject({ alg: z.literal("EdDSA"), kid: id, typ: z.literal(REALM_OPERATOR_LINK_TYP) })
      .parse(JSON.parse(Buffer.from(headerBytes, "base64url").toString("utf8")));
    const keys = z
      .object({
        keys: z.array(
          z
            .object({ kty: z.literal("OKP"), crv: z.literal("Ed25519"), x: z.string(), kid: id })
            .passthrough(),
        ),
      })
      .parse(await response.json())
      .keys.filter((key) => key.kid === header.kid);
    if (keys.length !== 1) throw new Error("auth_verifier_mismatch");
    const claims = verifyRealmOperatorLinkProofWithPublicKey({
      proof,
      issuer: verification.issuer,
      audience: verification.audience,
      keyId: header.kid,
      publicKey: createPublicKey({ key: keys[0]!, format: "jwk" }),
      ...(capture ? { now: new Date(capture.capturedAt) } : {}),
    });
    if (
      claims.sub !== membership.actorId ||
      (capture !== undefined && claims.sessionId !== capture.realmSessionId) ||
      claims.ownerSessionId !== plan.selection.sessionId ||
      claims.organizationId !== null ||
      claims.nonceSha256 !== membership.identityNonceSha256 ||
      claims.bootstrapPlanDigest !== membership.bootstrapPlanDigest ||
      claims.authResourceId !== plan.authDatabase.resourceId ||
      canonical(claims.resource) !== canonical(resource)
    )
      throw new Error("auth_proof_mismatch");
    session.removeStartupFile("operator-plan.json");
    session.removeStartupFile("auth-database-resource.json");
    session.removeStartupFile("realm-identity-proof.json");
    pool = new Pool({ connectionString: session.databaseUrl, max: 1 });
    if (!started) {
      session.lifecycle.started();
      started = true;
    }
    failure = "authority_denied";
    const sequence = readOnly ? undefined : await session.authorize(requiredEffect!, null);
    const client = await pool.connect();
    try {
      failure = "effect_failed";
      const effectInput = {
        client,
        resource,
        spec: membership,
        ownerSessionId: plan.selection.sessionId,
        planDigest,
        realmSessionId: claims.sessionId,
        ...(plan.authOperatorRole ? { authOperatorRole: plan.authOperatorRole } : {}),
        assertCurrent: async () => {
          await session!.assertCurrent();
        },
      };
      if (readOnly) {
        const observed =
          membership.kind === "join-existing-organization"
            ? await readExistingRealmOrganization({ ...effectInput, spec: membership })
            : await readOwnedRealmOrganization({ ...effectInput, spec: membership });
        let readbackSha256 = observed.readbackSha256;
        await writeFile(
          path.join(input.spoolDirectory, "readback.json"),
          JSON.stringify({
            version: 1,
            operation_id: context.operation.operation_id,
            context_digest: session.contextDigest,
            fence_generation: context.operation.fence_generation,
            status: observed.status,
            readback_sha256: readbackSha256,
          }),
          { mode: 0o600, flag: "wx" },
        );
        session.lifecycle.succeeded();
        return;
      }
      const receipt =
        membership.kind === "join-existing-organization"
          ? await joinExistingRealmOrganization({ ...effectInput, spec: membership })
          : await createOwnedRealmOrganization({ ...effectInput, spec: membership });
      failure = "protocol_failure";
      await session.checkpoint(sequence!, requiredEffect!, null, {
        state: receipt.replayed ? "no_change" : "applied",
        readback_sha256: receipt.readbackSha256,
      });
      session.lifecycle.succeeded();
    } finally {
      client.release();
    }
  } catch (error) {
    if (error instanceof Error && error.message === "auth_membership_readback_unknown")
      failure = "readback_unknown";
    if (error instanceof Error && error.message === "protected_installer_authority_denied")
      failure = "authority_denied";
    session?.lifecycle.failed(started ? failure : "startup_rejected");
    throw new Error(`protected_auth_worker_failed:${failure}`);
  } finally {
    await pool?.end().catch(() => {});
    session?.close();
  }
}

export async function runProtectedAuthMembershipInstaller(
  input: Parameters<typeof runMembershipWorker>[0],
): Promise<void> {
  await runMembershipWorker(input, false, AUTH_OWNED_ORGANIZATION_EFFECT);
}
export async function runProtectedAuthSignupPolicyInstaller(
  input: Parameters<typeof runMembershipWorker>[0],
): Promise<void> {
  await runMembershipWorker(input, false, AUTH_APP_SIGNUP_POLICY_EFFECT);
}
export async function runProtectedAuthMembershipReadback(
  input: Parameters<typeof runMembershipWorker>[0],
): Promise<void> {
  await runMembershipWorker(input, true);
}
