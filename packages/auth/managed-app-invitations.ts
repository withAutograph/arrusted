import { createHash } from "node:crypto";
import { magicLink } from "better-auth/plugins";
import { Resend } from "resend";
import { z } from "zod";
import type { PoolClient } from "pg";
import type { ManagedProductionRealm } from "./public-realm-enrollment";
import { authDatabaseResourceDigest, type SignupPolicyDatabase } from "./signup-policy";

export const AUTH_APP_INVITATION_ACCEPT_PATH = "/api/auth/platform/app-invitation/accept";
const id = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
// Whole-row JSON also supports the deployed schema before signupPolicyId exists.
const privateInvitationRow = `(to_jsonb(app_access_invitation)->>'signupPolicyId') is null`;
export const managedAppInvitationSchema = z.strictObject({
  id: z.uuid(),
  workspaceId: id,
  appId: id,
  organizationId: id,
  email: z.email().transform((value) => value.toLowerCase()),
  roles: z
    .array(id.refine((value) => !/[\p{Cc}]/u.test(value)))
    .refine((roles) => new Set(roles).size === roles.length),
  returnUrl: z.url(),
  operationRef: z.uuid(),
  planDigest: digest,
  fenceGeneration: z.number().int().positive(),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type ManagedAppInvitationInput = z.input<typeof managedAppInvitationSchema>;
export type ManagedAppInvitation = z.output<typeof managedAppInvitationSchema> & {
  resourceDigest: string;
  scopeDigest: string;
  status: "pending" | "verified" | "accepted" | "cancelled";
  verifiedActorId: string | null;
  verifiedSessionId: string | null;
  linkedFromInvitationId: string | null;
  deliveryStatus: "ready" | "sending" | "sent" | "unknown";
  deliveryAttemptId: string | null;
  deliveryProviderId: string | null;
};

function invitationScope(
  input: ManagedAppInvitationInput,
  realm: ManagedProductionRealm,
  builderOrigin: string,
) {
  const invitation = managedAppInvitationSchema.parse(input);
  const returnUrl = new URL(invitation.returnUrl);
  if (
    returnUrl.protocol !== "https:" ||
    invitation.workspaceId !== realm.workspaceId ||
    !realm.authorizedOrganizationIds.includes(invitation.organizationId) ||
    ![builderOrigin, realm.publicOrigin].includes(returnUrl.origin) ||
    returnUrl.pathname.startsWith("/api/") ||
    returnUrl.username ||
    returnUrl.password ||
    returnUrl.hash ||
    new Set(invitation.roles).size !== invitation.roles.length
  )
    throw new Error("app_invitation_scope_mismatch");
  const resourceDigest = authDatabaseResourceDigest(realm.resource);
  const { expiresAt: _expiresAt, fenceGeneration: _generation, ...identity } = invitation;
  const scopeDigest = createHash("sha256")
    .update(JSON.stringify({ ...identity, resourceDigest }))
    .digest("hex");
  return { ...invitation, resourceDigest, scopeDigest };
}

/** Protected operator only: a runtime role cannot insert or change invitation scope. */
export async function createManagedAppInvitation(
  database: SignupPolicyDatabase,
  input: ManagedAppInvitationInput,
  realm: ManagedProductionRealm,
  builderOrigin: string,
): Promise<ManagedAppInvitation> {
  const invitation = invitationScope(input, realm, builderOrigin);
  const result = await database.query(
    `insert into public.app_access_invitation
       (id,"workspaceId","resourceDigest","appId","organizationId",email,roles,"returnUrl",
        "operationRef","planDigest","scopeDigest","fenceGeneration","expiresAt")
     values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13)
     on conflict(id) do update set id=excluded.id
       where app_access_invitation."scopeDigest"=excluded."scopeDigest"
         and app_access_invitation."fenceGeneration"=excluded."fenceGeneration"
         and ${privateInvitationRow}
     returning *`,
    [
      invitation.id,
      invitation.workspaceId,
      invitation.resourceDigest,
      invitation.appId,
      invitation.organizationId,
      invitation.email,
      JSON.stringify(invitation.roles),
      invitation.returnUrl,
      invitation.operationRef,
      invitation.planDigest,
      invitation.scopeDigest,
      invitation.fenceGeneration,
      invitation.expiresAt,
    ],
  );
  if (result.rows.length !== 1) throw new Error("app_invitation_conflict");
  return invitationFromRow(result.rows[0]!);
}

function invitationFromRow(row: Record<string, unknown>): ManagedAppInvitation {
  return {
    ...managedAppInvitationSchema.parse({
      id: row.id,
      workspaceId: row.workspaceId,
      appId: row.appId,
      organizationId: row.organizationId,
      email: row.email,
      roles: row.roles,
      returnUrl: row.returnUrl,
      operationRef: row.operationRef,
      planDigest: row.planDigest,
      fenceGeneration: Number(row.fenceGeneration),
      expiresAt: row.expiresAt instanceof Date ? row.expiresAt.toISOString() : row.expiresAt,
    }),
    resourceDigest: digest.parse(row.resourceDigest),
    scopeDigest: digest.parse(row.scopeDigest),
    status: z.enum(["pending", "verified", "accepted", "cancelled"]).parse(row.status),
    verifiedActorId: id.nullable().parse(row.verifiedActorId),
    verifiedSessionId: id.nullable().parse(row.verifiedSessionId),
    linkedFromInvitationId: id.nullable().parse(row.linkedFromInvitationId ?? null),
    deliveryStatus: z.enum(["ready", "sending", "sent", "unknown"]).parse(row.deliveryStatus),
    deliveryAttemptId: id.nullable().parse(row.deliveryAttemptId),
    deliveryProviderId: id.nullable().parse(row.deliveryProviderId),
  };
}

export async function readManagedAppInvitation(
  database: SignupPolicyDatabase,
  invitationId: string,
  realm: ManagedProductionRealm,
): Promise<ManagedAppInvitation | null> {
  if (!z.uuid().safeParse(invitationId).success) return null;
  const result = await database.query(
    `select * from public.app_access_invitation
      where id=$1 and "workspaceId"=$2 and "resourceDigest"=$3 and ${privateInvitationRow}`,
    [invitationId, realm.workspaceId, authDatabaseResourceDigest(realm.resource)],
  );
  if (result.rows.length !== 1) return null;
  const invitation = invitationFromRow(result.rows[0]!);
  return realm.authorizedOrganizationIds.includes(invitation.organizationId) ? invitation : null;
}

export async function listManagedAppInvitations(
  database: SignupPolicyDatabase,
  scope: { appId: string; organizationId: string },
  realm: ManagedProductionRealm,
): Promise<ManagedAppInvitation[]> {
  if (!realm.authorizedOrganizationIds.includes(scope.organizationId))
    throw new Error("app_invitation_scope_mismatch");
  const result = await database.query(
    `select * from public.app_access_invitation where "workspaceId"=$1 and "resourceDigest"=$2
       and "appId"=$3 and "organizationId"=$4 and ${privateInvitationRow} order by "createdAt",id`,
    [
      realm.workspaceId,
      authDatabaseResourceDigest(realm.resource),
      scope.appId,
      scope.organizationId,
    ],
  );
  return result.rows.map(invitationFromRow);
}

/** Complete only after the protected host has reconciled the actual app grant. */
export async function updateManagedAppInvitation(
  database: SignupPolicyDatabase,
  realm: ManagedProductionRealm,
  input: { id: string; scopeDigest: string; fenceGeneration: number } & (
    | { action: "accept"; actorId: string }
    | { action: "cancel" }
    | { action: "renew"; expiresAt: string }
  ),
) {
  z.number().int().positive().parse(input.fenceGeneration);
  const found = await readManagedAppInvitation(database, input.id, realm);
  if (!found || found.scopeDigest !== input.scopeDigest)
    throw new Error("app_invitation_scope_mismatch");
  const result = await database.query(
    `update public.app_access_invitation
       set status=case when $4='accept' then 'accepted' when $4='cancel' then 'cancelled' else status end,
           "fenceGeneration"=$3, "expiresAt"=coalesce($6::timestamptz,"expiresAt"),
           "deliveryStatus"=case when $4='renew' then 'ready' else "deliveryStatus" end,
           "deliveryAttemptId"=case when $4='renew' then null else "deliveryAttemptId" end,
           "deliveryProviderId"=case when $4='renew' then null else "deliveryProviderId" end
     where id=$1 and "scopeDigest"=$2 and "fenceGeneration"<=$3
       and ${privateInvitationRow}
       and ($4<>'renew' or "fenceGeneration"<$3)
       and ($4<>'accept' or status='accepted' or "expiresAt">clock_timestamp())
       and (($4='accept' and status in ('verified','accepted') and "verifiedActorId"=$5)
         or ($4='cancel' and status in ('pending','verified','cancelled'))
         or ($4='renew' and status='pending'))
     returning *`,
    [
      input.id,
      input.scopeDigest,
      input.fenceGeneration,
      input.action,
      input.action === "accept" ? input.actorId : null,
      input.action === "renew" ? z.iso.datetime({ offset: true }).parse(input.expiresAt) : null,
    ],
  );
  if (result.rows.length !== 1) {
    const replay =
      input.action === "renew" ? await readManagedAppInvitation(database, input.id, realm) : null;
    if (
      input.action === "renew" &&
      replay &&
      replay.fenceGeneration === input.fenceGeneration &&
      replay.scopeDigest === input.scopeDigest &&
      Date.parse(replay.expiresAt) === Date.parse(input.expiresAt)
    )
      return replay;
    throw new Error("app_invitation_conflict");
  }
  return invitationFromRow(result.rows[0]!);
}

/** Protected host must bind this accepted source to the same authenticated Builder owner. */
export async function linkManagedCreatorIdentity(input: {
  client: PoolClient;
  realm: ManagedProductionRealm;
  invitationId: string;
  sourceInvitationId: string;
  sourceScopeDigest: string;
  actorId: string;
  authOperatorRole?: string;
  assertCurrent: () => Promise<void>;
}): Promise<ManagedAppInvitation> {
  const { client } = input;
  await input.assertCurrent();
  await client.query("begin");
  try {
    const locked = await client.query(
      `select id from public.app_access_invitation where id=any($1::text[]) order by id for update`,
      [[input.invitationId, input.sourceInvitationId]],
    );
    if (locked.rows.length !== 2) throw new Error("creator_identity_link_unavailable");
    const target = await readManagedAppInvitation(client, input.invitationId, input.realm);
    const source = await readManagedAppInvitation(client, input.sourceInvitationId, input.realm);
    const actor = await client.query(
      input.authOperatorRole
        ? "select $1::text as id where public.lock_auth_operator_user($1)"
        : 'select id from public."user" where id=$1 and "emailVerified"=true for share',
      [input.actorId],
    );
    if (
      !target ||
      !source ||
      source.status !== "accepted" ||
      source.scopeDigest !== input.sourceScopeDigest ||
      source.verifiedActorId !== input.actorId ||
      target.appId === source.appId ||
      actor.rows.length !== 1
    )
      throw new Error("creator_identity_link_unavailable");
    const replay =
      target.status === "verified" &&
      target.linkedFromInvitationId === source.id &&
      target.verifiedActorId === input.actorId;
    if (!replay) {
      if (
        target.status !== "pending" ||
        target.deliveryStatus !== "ready" ||
        target.linkedFromInvitationId !== null ||
        target.verifiedActorId !== null ||
        Date.parse(target.expiresAt) <= Date.now()
      )
        throw new Error("creator_identity_link_unavailable");
      // A previously granted or revoked app can never be restored by reusing onboarding.
      const existing = await client.query(
        `select 1 from public.app_actor_access where "organizationId"=$1 and "appId"=$2
         union all select 1 from public.app_actor_assignment where "organizationId"=$1 and "appId"=$2 limit 1`,
        [target.organizationId, target.appId],
      );
      if (existing.rows.length !== 0) throw new Error("creator_identity_link_unavailable");
      await client.query(
        `update public.app_access_invitation set status='verified',"verifiedActorId"=$2,
          "verifiedSessionId"=null,"verifiedAt"=now(),"linkedFromInvitationId"=$3 where id=$1
          and ${privateInvitationRow}`,
        [target.id, input.actorId, source.id],
      );
    }
    await input.assertCurrent();
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
  return (await readManagedAppInvitation(client, input.invitationId, input.realm))!;
}

export function appInvitationAcceptanceUrl(origin: string, invitationId: string) {
  const url = new URL(AUTH_APP_INVITATION_ACCEPT_PATH, origin);
  url.searchParams.set("invitationId", invitationId);
  return url.toString();
}

export function managedAppInvitationPlugin(input: {
  database: SignupPolicyDatabase;
  realm: ManagedProductionRealm;
  apiKey: string;
  from: string;
  send?: (
    message: { from: string; to: string; subject: string; text: string },
    idempotencyKey: string,
  ) => Promise<string>;
}) {
  const send =
    input.send ??
    (async (message, idempotencyKey) => {
      const result = await new Resend(input.apiKey).emails.send(message, { idempotencyKey });
      if (result.error || !result.data?.id) throw new Error("app_invitation_delivery_unavailable");
      return result.data.id;
    });
  return magicLink({
    storeToken: "hashed",
    disableSignUp: false,
    async sendMagicLink({ email, url, metadata }) {
      const invitation = await readManagedAppInvitation(
        input.database,
        String(metadata?.appInvitationId ?? ""),
        input.realm,
      );
      const verification = new URL(url);
      const callback =
        invitation && appInvitationAcceptanceUrl(input.realm.publicOrigin, invitation.id);
      if (
        !invitation ||
        invitation.status !== "pending" ||
        invitation.deliveryStatus !== "sending" ||
        !invitation.deliveryAttemptId ||
        invitation.deliveryAttemptId !== metadata?.deliveryAttemptId ||
        Date.parse(invitation.expiresAt) <= Date.now() ||
        invitation.email !== email.toLowerCase() ||
        verification.origin !== input.realm.publicOrigin ||
        verification.searchParams.get("callbackURL") !== callback ||
        (verification.searchParams.has("newUserCallbackURL") &&
          verification.searchParams.get("newUserCallbackURL") !== callback) ||
        verification.searchParams.has("errorCallbackURL")
      )
        throw new Error("app_invitation_unavailable");
      try {
        const providerId = await send(
          {
            from: input.from,
            to: invitation.email,
            subject: "Your app is waiting for you",
            text: `Sign in to finish setting up your access:\n${url}\n\nThis link can be used once.`,
          },
          `app-invitation/${invitation.id}/${invitation.deliveryAttemptId}`,
        );
        const recorded = await input.database.query(
          `select public.record_app_invitation_delivery($1,$2,$3) as recorded`,
          [invitation.id, invitation.deliveryAttemptId, providerId],
        );
        if (recorded.rows[0]?.recorded !== true)
          throw new Error("app_invitation_delivery_unavailable");
      } catch {
        throw new Error("app_invitation_delivery_unavailable");
      }
    },
  });
}

/** Cookie-authenticated callback; this never grants membership or app permissions. */
export async function verifyManagedAppInvitation(
  database: SignupPolicyDatabase,
  realm: ManagedProductionRealm,
  input: { invitationId: string; actorId: string; sessionId: string },
) {
  const invitation = await readManagedAppInvitation(database, input.invitationId, realm);
  if (!invitation) return null;
  const result = await database.query(
    `select public.verify_app_access_invitation($1,$2,$3,$4) as verified`,
    [invitation.id, input.actorId, input.sessionId, invitation.resourceDigest],
  );
  if (result.rows[0]?.verified !== true) return null;
  return invitation.returnUrl;
}
