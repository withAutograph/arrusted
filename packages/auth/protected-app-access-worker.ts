import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { ProtectedInstallerSpoolSession } from "../protected-installer/node-spool";
import { readApprovedAuthOperatorPlan } from "./approved-operator-plan";
import { readAuthDatabaseResource } from "./database-resource";
import {
  assertAuthOperatorConnection,
  verifyAuthOperatorConnection,
} from "../protected-installer/auth-operator";
import { managedProductionRealmSchema } from "./public-realm-enrollment";
import { joinExistingRealmOrganization } from "./owned-organization";
import { listManagedAppMembers, setManagedFrontendAccess } from "./managed-app-access";
import {
  appInvitationAcceptanceUrl,
  createManagedAppInvitation,
  listManagedAppInvitations,
  linkManagedCreatorIdentity,
  managedAppInvitationSchema,
  readManagedAppInvitation,
  updateManagedAppInvitation,
} from "./managed-app-invitations";

import {
  managedAppSignupPolicyInputSchema,
  managedAppSignupClaimProofSchema,
  persistManagedAppSignupPolicy,
  readManagedAppSignupPolicy,
  disableManagedAppSignupPolicy,
  readManagedAppSignupClaim,
  prepareManagedAppSignupMember,
  completeManagedAppSignup,
} from "./managed-app-signup";

export const AUTH_APP_ACCESS_INSTALLER_ID = "auth-app-access-v1";
export const AUTH_APP_INVITATION_EFFECT = "auth-app-invitation";
const id = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const invitationId = { invitationId: z.uuid() };
const transition = { ...invitationId, scopeDigest: digest };
export const managedAppAccessOperationSchema = z.strictObject({
  version: z.literal(1),
  realm: managedProductionRealmSchema,
  builderOrigin: z.url(),
  scope: z.strictObject({ appId: id, organizationId: id }),
  request: z.discriminatedUnion("action", [
    z.strictObject({ action: z.literal("list") }),
    z.strictObject({ action: z.literal("list-members") }),
    z.strictObject({
      action: z.literal("set-signup-policy"),
      policy: managedAppSignupPolicyInputSchema,
    }),
    z.strictObject({ action: z.literal("read-signup-policy"), policyId: z.uuid() }),
    z.strictObject({
      action: z.literal("disable-signup-policy"),
      policyId: z.uuid(),
      policyDigest: digest,
    }),
    z.strictObject({ action: z.literal("read-signup"), policyId: z.uuid(), claimId: z.uuid() }),
    z.strictObject({
      action: z.literal("prepare-signup-member"),
      ...managedAppSignupClaimProofSchema.shape,
      actorId: id,
    }),
    z.strictObject({
      action: z.literal("complete-signup"),
      ...managedAppSignupClaimProofSchema.shape,
      actorId: id,
    }),
    z.strictObject({
      action: z.literal("set-access"),
      actorId: id,
      roles: managedAppInvitationSchema.shape.roles,
      active: z.boolean(),
      signupClaim: managedAppSignupClaimProofSchema.optional(),
    }),
    z.strictObject({ action: z.literal("read"), ...invitationId }),
    z.strictObject({ action: z.literal("send"), ...invitationId }),
    z.strictObject({
      action: z.literal("link-creator"),
      ...invitationId,
      sourceInvitationId: z.uuid(),
      sourceScopeDigest: digest,
      actorId: id,
    }),
    z.strictObject({
      action: z.literal("create"),
      invitation: managedAppInvitationSchema.pick({
        id: true,
        email: true,
        roles: true,
        expiresAt: true,
        returnUrl: true,
      }),
    }),
    z.strictObject({
      action: z.literal("renew"),
      ...transition,
      expiresAt: z.iso.datetime({ offset: true }),
    }),
    z.strictObject({ action: z.literal("cancel"), ...transition }),
    z.strictObject({ action: z.literal("complete"), ...transition, actorId: id }),
    z.strictObject({ action: z.literal("prepare-member"), ...transition, actorId: id }),
  ]),
});

async function runAppAccessWorker(
  input: {
    spoolDirectory: string;
    runId: string;
    timeoutMs: number;
    notices?: NodeJS.WritableStream;
  },
  readOnly: boolean,
) {
  let session: ProtectedInstallerSpoolSession | undefined;
  let pool: Pool | undefined;
  let started = false;
  try {
    session = new ProtectedInstallerSpoolSession(input).open();
    const { context } = session;
    const { plan, planDigest } = readApprovedAuthOperatorPlan(
      session.readStartupFile("operator-plan.json"),
      context.operation.approval_digest,
    );
    const parsed = z
      .object({
        authAppAccess: managedAppAccessOperationSchema,
        authOperatorRole: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u),
        effects: z
          .array(z.object({ id: id.optional(), effectId: id.optional(), kind: id }))
          .optional(),
      })
      .parse(plan);
    const { realm, builderOrigin, scope, request } = parsed.authAppAccess;
    const resource = readAuthDatabaseResource(
      session.readStartupFile("auth-database-resource.json").toString("utf8"),
    );
    if (
      !resource ||
      context.installer.id !== AUTH_APP_ACCESS_INSTALLER_ID ||
      context.app_id !== "auth" ||
      context.resource.resource_id !== realm.authResourceId ||
      context.resource.environment !== "production" ||
      context.resource.hostname !== realm.resource.hostname ||
      context.resource.port !== realm.resource.port ||
      context.resource.database !== realm.resource.database ||
      context.resource.schema !== realm.resource.schema ||
      context.resource.migrator_role !== realm.resource.migratorRole ||
      context.resource.runtime_role !== realm.resource.runtimeRole ||
      context.resource.provider_project_id !== realm.resource.neon.projectId ||
      context.resource.provider_branch_id !== realm.resource.neon.branchId ||
      !isDeepStrictEqual(resource, realm.resource) ||
      !realm.authorizedOrganizationIds.includes(scope.organizationId) ||
      new URL(builderOrigin).origin !== builderOrigin ||
      new URL(builderOrigin).protocol !== "https:"
    )
      throw new Error("app_access_scope_mismatch");
    const query =
      request.action === "list" ||
      request.action === "read" ||
      request.action === "list-members" ||
      request.action === "read-signup-policy" ||
      request.action === "read-signup";
    if (readOnly && !query) throw new Error("app_access_readonly_required");
    if (
      !query &&
      !parsed.effects?.some(
        (effect) =>
          effect.kind === AUTH_APP_INVITATION_EFFECT &&
          (effect.id ?? effect.effectId) === AUTH_APP_INVITATION_EFFECT,
      )
    )
      throw new Error("app_access_effect_required");
    session.removeStartupFile("operator-plan.json");
    session.removeStartupFile("auth-database-resource.json");
    assertAuthOperatorConnection(session.databaseUrl, resource, parsed.authOperatorRole);
    pool = new Pool({
      connectionString: session.databaseUrl,
      max: 1,
      ...(readOnly ? { options: "-c default_transaction_read_only=on" } : {}),
    });
    const client = await pool.connect();
    try {
      session.lifecycle.started();
      started = true;
      await session.assertCurrent();
      await verifyAuthOperatorConnection(client, resource, parsed.authOperatorRole);
      if ("invitationId" in request) {
        const invitation = await readManagedAppInvitation(client, request.invitationId, realm);
        if (
          invitation &&
          (invitation.appId !== scope.appId || invitation.organizationId !== scope.organizationId)
        )
          throw new Error("app_access_scope_mismatch");
      }
      const sequence = query
        ? undefined
        : await session.authorize(AUTH_APP_INVITATION_EFFECT, null);
      let result: unknown;
      if (request.action === "set-signup-policy") {
        result = await persistManagedAppSignupPolicy(client, realm, {
          ...scope,
          policy: request.policy,
          operationRef: context.operation.operation_id,
          planDigest,
          fenceGeneration: context.operation.fence_generation,
        });
      } else if (request.action === "read-signup-policy") {
        result = await readManagedAppSignupPolicy(client, realm, {
          ...scope,
          policyId: request.policyId,
        });
      } else if (request.action === "disable-signup-policy") {
        result = await disableManagedAppSignupPolicy(client, realm, {
          ...scope,
          ...request,
          fenceGeneration: context.operation.fence_generation,
        });
      } else if (request.action === "read-signup") {
        result = await readManagedAppSignupClaim(client, realm, { ...scope, ...request });
      } else if (request.action === "prepare-signup-member") {
        result = await prepareManagedAppSignupMember({
          client,
          realm,
          scope,
          proof: request,
          actorId: request.actorId,
          authOperatorRole: parsed.authOperatorRole,
          assertCurrent: () => session!.assertCurrent(),
        });
      } else if (request.action === "complete-signup") {
        result = await completeManagedAppSignup(client, realm, {
          ...scope,
          ...request,
          fenceGeneration: context.operation.fence_generation,
        });
      } else if (request.action === "list") {
        result = await listManagedAppInvitations(client, scope, realm);
      } else if (request.action === "list-members") {
        result = await listManagedAppMembers(client, { ...scope, workspaceId: realm.workspaceId });
      } else if (request.action === "set-access") {
        result = await setManagedFrontendAccess(
          client,
          {
            ...scope,
            workspaceId: realm.workspaceId,
            authOperatorRole: parsed.authOperatorRole,
            ...request,
            operationRef: context.operation.operation_id,
            fenceGeneration: context.operation.fence_generation,
          },
          () => session!.assertCurrent(),
        );
      } else if (request.action === "read") {
        result = await readManagedAppInvitation(client, request.invitationId, realm);
      } else if (request.action === "create") {
        result = await createManagedAppInvitation(
          client,
          {
            ...request.invitation,
            ...scope,
            workspaceId: realm.workspaceId,
            operationRef: context.operation.operation_id,
            planDigest,
            fenceGeneration: context.operation.fence_generation,
          },
          realm,
          builderOrigin,
        );
      } else if (request.action === "link-creator") {
        result = await linkManagedCreatorIdentity({
          client,
          realm,
          authOperatorRole: parsed.authOperatorRole,
          ...request,
          assertCurrent: () => session!.assertCurrent(),
        });
      } else if (request.action === "send") {
        const invitation = await readManagedAppInvitation(client, request.invitationId, realm);
        if (!invitation || invitation.status !== "pending")
          throw new Error("app_invitation_unavailable");
        const attemptId = context.operation.operation_id;
        const reserved = await client.query(
          `update public.app_access_invitation set "deliveryStatus"='sending',"deliveryAttemptId"=$2
            where id=$1 and status='pending' and "deliveryStatus"='ready' returning id`,
          [invitation.id, attemptId],
        );
        // Reserving the attempt precedes token creation. An uncertain response never creates another token.
        if (reserved.rows.length === 1) {
          try {
            await session.assertCurrent();
          } catch (error) {
            // No provider request started, so release only this known-unsent attempt.
            await client.query(
              `update public.app_access_invitation set "deliveryStatus"='ready',"deliveryAttemptId"=null
                where id=$1 and "deliveryAttemptId"=$2 and "deliveryStatus"='sending'`,
              [invitation.id, attemptId],
            );
            throw error;
          }
          try {
            await fetch(new URL("/api/auth/sign-in/magic-link", realm.publicOrigin), {
              method: "POST",
              redirect: "error",
              signal: AbortSignal.timeout(20_000),
              headers: { "content-type": "application/json", origin: realm.publicOrigin },
              body: JSON.stringify({
                email: invitation.email,
                callbackURL: appInvitationAcceptanceUrl(realm.publicOrigin, invitation.id),
                metadata: { appInvitationId: invitation.id, deliveryAttemptId: attemptId },
              }),
            });
          } catch {
            // The runtime may still record the provider receipt; read the durable attempt below.
          }
          await client.query(
            `update public.app_access_invitation set "deliveryStatus"='unknown'
              where id=$1 and "deliveryAttemptId"=$2 and "deliveryStatus"='sending'`,
            [invitation.id, attemptId],
          );
        }
        const observed = await readManagedAppInvitation(client, invitation.id, realm);
        result = {
          id: invitation.id,
          status: observed?.deliveryStatus === "sent" ? "sent" : "delivery_unknown",
          deliveryAttemptId: observed?.deliveryAttemptId ?? attemptId,
        };
      } else if (request.action === "prepare-member") {
        const invitation = await readManagedAppInvitation(client, request.invitationId, realm);
        if (
          !invitation ||
          invitation.status !== "verified" ||
          invitation.scopeDigest !== request.scopeDigest ||
          invitation.verifiedActorId !== request.actorId ||
          (!invitation.verifiedSessionId && !invitation.linkedFromInvitationId)
        )
          throw new Error("app_invitation_identity_required");
        const source = invitation.linkedFromInvitationId
          ? await readManagedAppInvitation(client, invitation.linkedFromInvitationId, realm)
          : null;
        if (invitation.linkedFromInvitationId && !source)
          throw new Error("app_invitation_identity_required");
        result = await joinExistingRealmOrganization({
          client,
          resource,
          authOperatorRole: parsed.authOperatorRole,
          spec: {
            workspaceId: realm.workspaceId,
            organizationId: scope.organizationId,
            actorId: request.actorId,
          },
          ...(source
            ? {
                creatorIdentityLink: {
                  invitationId: invitation.id,
                  sourceInvitationId: source.id,
                  sourceScopeDigest: source.scopeDigest,
                },
              }
            : {
                realmSessionId: invitation.verifiedSessionId!,
                invitationIdentity: {
                  invitationId: invitation.id,
                  scopeDigest: invitation.scopeDigest,
                },
              }),
          assertCurrent: () => session!.assertCurrent(),
        });
      } else {
        const common = {
          id: request.invitationId,
          scopeDigest: request.scopeDigest,
          fenceGeneration: context.operation.fence_generation,
        };
        result = await updateManagedAppInvitation(
          client,
          realm,
          request.action === "complete"
            ? { ...common, action: "accept", actorId: request.actorId }
            : request.action === "renew"
              ? { ...common, action: "renew", expiresAt: request.expiresAt }
              : { ...common, action: "cancel" },
        );
      }
      await session.assertCurrent();
      const resultDigest = createHash("sha256").update(JSON.stringify(result)).digest("hex");
      if (sequence !== undefined)
        await session.checkpoint(sequence, AUTH_APP_INVITATION_EFFECT, null, {
          state: "applied",
          readback_sha256: resultDigest,
        });
      await writeFile(
        path.join(input.spoolDirectory, "readback.json"),
        JSON.stringify({
          version: 1,
          operation_id: context.operation.operation_id,
          context_digest: session.contextDigest,
          fence_generation: context.operation.fence_generation,
          status: "applied",
          readback_sha256: resultDigest,
          result,
        }),
        { mode: 0o600, flag: "wx" },
      );
      session.lifecycle.succeeded();
    } finally {
      client.release();
    }
  } catch {
    session?.lifecycle.failed(started ? "effect_failed" : "startup_rejected");
    throw new Error(
      `protected_auth_worker_failed:${started ? "effect_failed" : "startup_rejected"}`,
    );
  } finally {
    await pool?.end().catch(() => {});
    session?.close();
  }
}

export const runProtectedAppAccess = (input: Parameters<typeof runAppAccessWorker>[0]) =>
  runAppAccessWorker(input, false);
export const runProtectedAppAccessReadback = (input: Parameters<typeof runAppAccessWorker>[0]) =>
  runAppAccessWorker(input, true);
