import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { verifyAuthOperatorConnection } from "../protected-installer/auth-operator";
import { z } from "zod";
import { authDatabaseResourceDigest } from "./signup-policy";
import { verifyAuthDatabaseResource, type AuthDatabaseResource } from "./database-resource";

const id = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const ownedOrganizationSpecSchema = z.strictObject({
  actorId: id,
  bootstrapPlanDigest: hash,
  identityNonceSha256: hash,
  identityCapture: z
    .strictObject({ capturedAt: z.string().datetime({ offset: true }), realmSessionId: id })
    .optional(),
  identityProof: z.strictObject({ reference: id, sha256: hash }),
  identityVerification: z.strictObject({
    audience: z.string().url(),
    issuer: z.string().url(),
    jwksUrl: z.string().url(),
    transportSource: z
      .strictObject({
        audience: z.string().url(),
        environment: z.enum(["preview", "production"]),
        issuer: z.string().url(),
        ownerId: id,
        projectId: id,
      })
      .optional(),
  }),
  kind: z.literal("create-owned-organization"),
  name: z.string().min(1).max(120),
  organizationId: id,
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/u),
});
export type OwnedOrganizationSpec = z.infer<typeof ownedOrganizationSpecSchema>;
/** The protected host authorizes this existing organization against its managed workspace. */
export const existingOrganizationMembershipSchema = ownedOrganizationSpecSchema
  .omit({ kind: true, name: true, slug: true })
  .extend({
    kind: z.literal("join-existing-organization"),
    workspaceId: id,
    membershipRole: z.literal("member"),
  });
export type ExistingOrganizationMembership = z.infer<typeof existingOrganizationMembershipSchema>;
/** The approved list stays intact. A protected invocation executes one exact listed organization. */
export const ownedOrganizationsSpecSchema = z
  .strictObject({
    kind: z.literal("create-owned-organizations"),
    organizations: z.array(ownedOrganizationSpecSchema).min(1),
  })
  .superRefine((spec, ctx) => {
    if (
      new Set(spec.organizations.map((organization) => organization.organizationId)).size !==
        spec.organizations.length ||
      new Set(spec.organizations.map((organization) => organization.slug)).size !==
        spec.organizations.length
    )
      ctx.addIssue({ code: "custom", message: "Approved organization identities must be unique." });
  });
export const ownedOrganizationMembershipSchema = z.union([
  ownedOrganizationSpecSchema,
  ownedOrganizationsSpecSchema,
  existingOrganizationMembershipSchema,
]);
export const ownedOrganizationTargetSchema = z.strictObject({ organizationId: id });
/** Selection conveys no authority: the full plan digest and selected signed owner proof remain required. */
export function selectOwnedOrganizationSpec(
  membershipInput: z.infer<typeof ownedOrganizationMembershipSchema>,
  targetInput?: unknown,
): OwnedOrganizationSpec | ExistingOrganizationMembership {
  const membership = ownedOrganizationMembershipSchema.parse(membershipInput);
  if (membership.kind !== "create-owned-organizations") {
    if (
      targetInput !== undefined &&
      ownedOrganizationTargetSchema.parse(targetInput).organizationId !== membership.organizationId
    )
      throw new Error("auth_membership_target_mismatch");
    return membership;
  }
  const target = ownedOrganizationTargetSchema.parse(targetInput);
  const selected = membership.organizations.find(
    (organization) => organization.organizationId === target.organizationId,
  );
  if (!selected) throw new Error("auth_membership_target_mismatch");
  return selected;
}

type ExistingMembershipInput = {
  client: PoolClient;
  resource: AuthDatabaseResource;
  spec: Pick<ExistingOrganizationMembership, "workspaceId" | "organizationId" | "actorId">;
  realmSessionId?: string;
  authOperatorRole?: string;
  invitationIdentity?: { invitationId: string; scopeDigest: string };
  creatorIdentityLink?: {
    invitationId: string;
    sourceInvitationId: string;
    sourceScopeDigest: string;
  };
  assertCurrent: () => Promise<void>;
};

async function verifyExistingMembershipConnection(input: ExistingMembershipInput) {
  if (input.authOperatorRole) {
    await verifyAuthOperatorConnection(input.client, input.resource, input.authOperatorRole);
  } else {
    if (input.resource.environment === "production") throw new Error("auth_operator_role_required");
    await verifyAuthDatabaseResource(input.client, input.resource, "migrator");
  }
}

/** No organization creation, ownership transfer, or app assignment happens here. */
export async function joinExistingRealmOrganization(
  input: ExistingMembershipInput,
): Promise<{ replayed: boolean; readbackSha256: string }> {
  const spec = existingOrganizationMembershipSchema
    .pick({
      workspaceId: true,
      organizationId: true,
      actorId: true,
    })
    .parse(input.spec);
  await input.assertCurrent();
  await verifyExistingMembershipConnection(input);
  await input.client.query("begin");
  let replayed = false;
  try {
    await lockExistingMembership(input, spec);
    const existing = await input.client.query(
      input.authOperatorRole
        ? "select id from public.lock_auth_operator_member($1,$2)"
        : `select id from public.member where "organizationId"=$1 and "userId"=$2 for share`,
      [spec.organizationId, spec.actorId],
    );
    if (existing.rows.length > 1) throw new Error("auth_membership_required");
    replayed = existing.rows.length === 1;
    if (!replayed) {
      const memberId = createHash("sha256")
        .update(JSON.stringify(["managed-membership-v1", spec.organizationId, spec.actorId]))
        .digest("hex");
      await input.client.query(
        input.authOperatorRole
          ? "select public.insert_auth_operator_member($1,$2,$3)"
          : `insert into public.member (id,"organizationId","userId",role,"createdAt")
         values ($1,$2,$3,'member',now())`,
        [memberId, spec.organizationId, spec.actorId],
      );
    }
    // The invitation selected this app's organization. Bind only the verified
    // accepting session, so first-time users can open it without an extra switch.
    if (input.realmSessionId) {
      const activated = await input.client.query(
        `update public.session set "activeOrganizationId"=$1,"updatedAt"=now()
         where id=$2 and "userId"=$3 and "expiresAt">clock_timestamp() returning id`,
        [spec.organizationId, input.realmSessionId, spec.actorId],
      );
      if (activated.rows.length !== 1) throw new Error("auth_identity_required");
    }
    await input.assertCurrent();
    await input.client.query("commit");
  } catch (error) {
    await input.client.query("rollback").catch(() => {});
    throw error;
  }
  const observed = await readExistingRealmOrganization(input);
  if (observed.status !== "applied") throw new Error("auth_membership_readback_unknown");
  return { replayed, readbackSha256: observed.readbackSha256 };
}

async function lockExistingMembership(
  input: ExistingMembershipInput,
  spec: ExistingMembershipInput["spec"],
) {
  const link = input.creatorIdentityLink;
  if (input.authOperatorRole) {
    const actor = await input.client.query(
      "select public.lock_auth_operator_user($1) as verified",
      [spec.actorId],
    );
    if (actor.rows[0]?.verified !== true) throw new Error("auth_identity_required");
  }
  if (Boolean(link) === Boolean(input.realmSessionId)) throw new Error("auth_identity_required");
  const identity = link
    ? await input.client.query(
        `select u.id from public."user" u
       join public.app_access_invitation target on target."verifiedActorId"=u.id
       join public.app_access_invitation source on source.id=target."linkedFromInvitationId"
       where u.id=$1 and u."emailVerified"=true and target.id=$2 and source.id=$3
         and source."scopeDigest"=$4 and source.status='accepted' and source."verifiedActorId"=u.id
         and target.status='verified' and target."expiresAt">clock_timestamp() and target."appId"<>source."appId"
         and target."workspaceId"=$5 and source."workspaceId"=$5
         and target."resourceDigest"=$6 and source."resourceDigest"=$6
         and target."organizationId"=$7 ${input.authOperatorRole ? "for share of target,source" : "for share of u,target,source"}`,
        [
          spec.actorId,
          link.invitationId,
          link.sourceInvitationId,
          link.sourceScopeDigest,
          spec.workspaceId,
          authDatabaseResourceDigest(input.resource),
          spec.organizationId,
        ],
      )
    : await input.client.query(
        `select s.id from public.session s join public."user" u on u.id=s."userId"
       where s.id=$1 and u.id=$2 and s."expiresAt">clock_timestamp() ${input.authOperatorRole ? "for share of s" : "for share of s,u"}`,
        [input.realmSessionId, spec.actorId],
      );
  if (identity.rows.length !== 1) throw new Error("auth_identity_required");
  if (input.invitationIdentity) {
    const invitation = await input.client.query(
      `select id from public.app_access_invitation where id=$1 and "scopeDigest"=$2
        and status='verified' and "expiresAt">clock_timestamp()
        and "workspaceId"=$3 and "resourceDigest"=$4 and "organizationId"=$5
        and "verifiedActorId"=$6 and "verifiedSessionId"=$7
        and exists (select 1 from public."user" where id=$6 and "emailVerified"=true) for share`,
      [
        input.invitationIdentity.invitationId,
        input.invitationIdentity.scopeDigest,
        spec.workspaceId,
        authDatabaseResourceDigest(input.resource),
        spec.organizationId,
        spec.actorId,
        input.realmSessionId,
      ],
    );
    if (invitation.rows.length !== 1) throw new Error("app_invitation_identity_required");
  }
  const organization = await input.client.query(
    `select id from public.organization where id=$1 for share`,
    [spec.organizationId],
  );
  if (organization.rows.length !== 1) throw new Error("auth_membership_required");
  await input.client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
    JSON.stringify(["managed-membership-v1", spec.organizationId, spec.actorId]),
  ]);
}

/** Reconcile an uncertain member insert without replaying or promoting it. */
export async function readExistingRealmOrganization(
  input: ExistingMembershipInput,
): Promise<{ status: "absent" | "applied"; readbackSha256: string }> {
  const spec = existingOrganizationMembershipSchema
    .pick({
      workspaceId: true,
      organizationId: true,
      actorId: true,
    })
    .parse(input.spec);
  await input.assertCurrent();
  await verifyExistingMembershipConnection(input);
  const result = await input.client.query(
    `select m.role from public.member m join public.organization o on o.id=m."organizationId"
     where m."organizationId"=$1 and m."userId"=$2`,
    [spec.organizationId, spec.actorId],
  );
  if (result.rows.length > 1) throw new Error("auth_membership_readback_unknown");
  const role: unknown = result.rows[0]?.role;
  if (result.rows.length === 1 && (typeof role !== "string" || role.length === 0))
    throw new Error("auth_membership_readback_unknown");
  const status = result.rows.length === 1 ? "applied" : "absent";
  await input.assertCurrent();
  return {
    status,
    readbackSha256: createHash("sha256")
      .update(JSON.stringify([spec.workspaceId, spec.organizationId, spec.actorId, status, role]))
      .digest("hex"),
  };
}
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
/** Called only by the fixed protected worker after signature/full-plan/fence verification. */
export async function createOwnedRealmOrganization(input: {
  client: PoolClient;
  resource: AuthDatabaseResource;
  spec: OwnedOrganizationSpec;
  ownerSessionId: string;
  planDigest: string;
  realmSessionId: string;
  assertCurrent: () => Promise<void>;
}): Promise<{ replayed: boolean; readbackSha256: string }> {
  const spec = ownedOrganizationSpecSchema.parse(input.spec);
  const marker = canonical({
    actorId: spec.actorId,
    identityProofSha256: spec.identityProof.sha256,
    ownerSessionId: input.ownerSessionId,
    planDigest: hash.parse(input.planDigest),
    purpose: "protected-owned-organization-v1",
    version: 1,
  });
  await input.assertCurrent();
  await verifyAuthDatabaseResource(input.client, input.resource, "migrator");
  await input.client.query("begin");
  try {
    // This lock serializes grants against normal logout/session deletion and user deletion.
    const identity = await input.client.query(
      `select s.id from public.session s join public."user" u on u.id=s."userId"
       where s.id=$1 and u.id=$2 and s."expiresAt">clock_timestamp() for share of s,u`,
      [input.realmSessionId, spec.actorId],
    );
    if (identity.rows.length !== 1) throw new Error("auth_identity_required");
    await input.client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `protected-owned-organization:${spec.organizationId}`,
    ]);
    const existing = await input.client.query(
      `select name,slug,metadata,"appIds" from public.organization where id=$1 for update`,
      [spec.organizationId],
    );
    const replayed = existing.rows.length === 1;
    if (replayed) {
      const row = existing.rows[0];
      if (row.metadata !== marker || row.name !== spec.name || row.slug !== spec.slug)
        throw new Error("auth_membership_required");
      const member = await input.client.query(
        `select role from public.member where "organizationId"=$1 and "userId"=$2 for share`,
        [spec.organizationId, spec.actorId],
      );
      if (member.rows.length !== 1 || member.rows[0].role !== "owner")
        throw new Error("auth_membership_required");
    } else {
      if (existing.rows.length !== 0) throw new Error("auth_membership_required");
      await input.client.query(
        `insert into public.organization (id,name,slug,"createdAt",metadata,"appIds") values ($1,$2,$3,now(),$4,'[]'::jsonb)`,
        [spec.organizationId, spec.name, spec.slug, marker],
      );
      const memberId = createHash("sha256")
        .update(canonical([spec.organizationId, spec.actorId, marker]))
        .digest("hex");
      await input.client.query(
        `insert into public.member (id,"organizationId","userId",role,"createdAt") values ($1,$2,$3,'owner',now())`,
        [memberId, spec.organizationId, spec.actorId],
      );
    }
    await input.assertCurrent();
    const currentIdentity = await input.client.query(
      `select s.id from public.session s join public."user" u on u.id=s."userId" where s.id=$1 and u.id=$2 and s."expiresAt">clock_timestamp() for share of s,u`,
      [input.realmSessionId, spec.actorId],
    );
    if (currentIdentity.rows.length !== 1) throw new Error("auth_identity_required");
    await input.client.query("commit");
    const observed = await input.client.query(
      `select o.name,o.slug,o.metadata,m.role,m."userId" as "actorId" from public.organization o
       join public.member m on m."organizationId"=o.id where o.id=$1 and m."userId"=$2`,
      [spec.organizationId, spec.actorId],
    );
    if (
      observed.rows.length !== 1 ||
      observed.rows[0].metadata !== marker ||
      observed.rows[0].name !== spec.name ||
      observed.rows[0].slug !== spec.slug ||
      observed.rows[0].role !== "owner"
    )
      throw new Error("auth_membership_readback_unknown");
    return {
      replayed,
      readbackSha256: createHash("sha256")
        .update(
          canonical({
            actorId: spec.actorId,
            marker,
            organizationId: spec.organizationId,
            role: "owner",
          }),
        )
        .digest("hex"),
    };
  } catch (error) {
    await input.client.query("rollback").catch(() => {});
    throw error;
  }
}

/** Fixed SELECT-only reconciliation; no effect authorization, mutation, or optimistic journal inference. */
export async function readOwnedRealmOrganization(
  input: Parameters<typeof createOwnedRealmOrganization>[0],
): Promise<{ status: "absent" | "applied"; readbackSha256: string }> {
  const spec = ownedOrganizationSpecSchema.parse(input.spec);
  const marker = canonical({
    actorId: spec.actorId,
    identityProofSha256: spec.identityProof.sha256,
    ownerSessionId: input.ownerSessionId,
    planDigest: hash.parse(input.planDigest),
    purpose: "protected-owned-organization-v1",
    version: 1,
  });
  await input.assertCurrent();
  await verifyAuthDatabaseResource(input.client, input.resource, "migrator");
  await input.client.query("begin");
  try {
    const identity = await input.client.query(
      `select s.id from public.session s join public."user" u on u.id=s."userId" where s.id=$1 and u.id=$2 and s."expiresAt">clock_timestamp() for share of s,u`,
      [input.realmSessionId, spec.actorId],
    );
    if (identity.rows.length !== 1) throw new Error("auth_identity_required");
    await input.client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `protected-owned-organization:${spec.organizationId}`,
    ]);
    const observed = await input.client.query(
      `select o.name,o.slug,o.metadata from public.organization o where o.id=$1 for share`,
      [spec.organizationId],
    );
    let status: "absent" | "applied" = "absent";
    if (observed.rows.length === 1) {
      const row = observed.rows[0];
      const member = await input.client.query(
        `select role from public.member where "organizationId"=$1 and "userId"=$2 for share`,
        [spec.organizationId, spec.actorId],
      );
      if (
        row.name !== spec.name ||
        row.slug !== spec.slug ||
        row.metadata !== marker ||
        member.rows.length !== 1 ||
        member.rows[0].role !== "owner"
      )
        throw new Error("auth_membership_readback_unknown");
      status = "applied";
    } else if (observed.rows.length !== 0) throw new Error("auth_membership_readback_unknown");
    await input.assertCurrent();
    const currentIdentity = await input.client.query(
      `select s.id from public.session s join public."user" u on u.id=s."userId" where s.id=$1 and u.id=$2 and s."expiresAt">clock_timestamp() for share of s,u`,
      [input.realmSessionId, spec.actorId],
    );
    if (currentIdentity.rows.length !== 1) throw new Error("auth_identity_required");
    await input.client.query("commit");
    return {
      status,
      readbackSha256: createHash("sha256")
        .update(
          canonical(
            status === "applied"
              ? {
                  actorId: spec.actorId,
                  marker,
                  organizationId: spec.organizationId,
                  role: "owner",
                }
              : { actorId: spec.actorId, organizationId: spec.organizationId, status },
          ),
        )
        .digest("hex"),
    };
  } catch (error) {
    await input.client.query("rollback").catch(() => {});
    throw error;
  }
}
