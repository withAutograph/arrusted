import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { PoolClient } from "pg";
import type { ManagedProductionRealm } from "./public-realm-enrollment";
import { authDatabaseResourceDigest, type SignupPolicyDatabase } from "./signup-policy";
import { joinExistingRealmOrganization } from "./owned-organization";

const id = z.string().min(1).max(256);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const roles = z
  .array(z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u))
  .refine((values) => new Set(values).size === values.length);
const appPath = z
  .string()
  .regex(/^\/(?!\/)[^\\\s#]*$/u)
  .refine((value) => {
    const url = new URL(value, "https://signup.invalid");
    return url.origin === "https://signup.invalid" && `${url.pathname}${url.search}` === value;
  });

/** Private approved app-catalog policy. Organization membership is always member. */
export const managedAppSignupPolicyInputSchema = z
  .strictObject({
    version: z.literal(1),
    policyId: z.uuid(),
    eligibility: z.enum(["public", "approved-email"]),
    allowedEmails: z.array(z.email().transform((value) => value.toLowerCase())).default([]),
    appRoles: roles,
    storage: z.enum(["none", "postgres"]),
    appPath,
  })
  .superRefine((policy, context) => {
    if (
      new Set(policy.allowedEmails).size !== policy.allowedEmails.length ||
      (policy.eligibility === "approved-email" && policy.allowedEmails.length === 0) ||
      (policy.eligibility === "public" && policy.allowedEmails.length !== 0)
    ) {
      context.addIssue({ code: "custom", message: "Invalid signup eligibility." });
    }
  });
export type ManagedAppSignupPolicy = z.output<typeof managedAppSignupPolicyInputSchema> & {
  policyDigest: string;
  workspaceId: string;
  resourceDigest: string;
  authResourceId: string;
  appId: string;
  organizationId: string;
  origin: string;
  returnUrl: string;
  enabled: boolean;
  operationRef: string;
  planDigest: string;
  fenceGeneration: number;
};
export const managedAppSignupClaimProofSchema = z.strictObject({
  policyId: z.uuid(),
  claimId: z.uuid(),
  scopeDigest: digest,
});
export type ManagedAppSignupClaimProof = z.infer<typeof managedAppSignupClaimProofSchema>;
export const managedAppSignupRecordedGrantSchema = z.strictObject({
  operationRef: z.uuid(),
  fenceGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type ManagedAppSignupRecordedGrant = z.infer<typeof managedAppSignupRecordedGrantSchema>;
export type ManagedAppSignupClaim = {
  id: string;
  policyId: string;
  policyDigest: string;
  scopeDigest: string;
  workspaceId: string;
  resourceDigest: string;
  appId: string;
  organizationId: string;
  actorId: string;
  sessionId: string;
  appRoles: string[];
  returnUrl: string;
  expiresAt: string;
  status: "verified" | "applied" | "rejected";
  accessState: "absent" | "active" | "revoked" | "changed";
  memberPrepared: boolean;
  grantReserved: boolean;
  recordedGrant?: ManagedAppSignupRecordedGrant;
  accessRevocation?: { fenceGeneration: number };
};
type Scope = { appId: string; organizationId: string };
function assertScope(realm: ManagedProductionRealm, scope: Scope) {
  if (!realm.authorizedOrganizationIds.includes(scope.organizationId)) {
    throw new Error("app_signup_scope_mismatch");
  }
}
function policyIdentity(
  policy: z.output<typeof managedAppSignupPolicyInputSchema>,
  realm: ManagedProductionRealm,
  scope: Scope,
) {
  assertScope(realm, scope);
  return {
    ...policy,
    allowedEmails: policy.allowedEmails.toSorted(),
    appRoles: policy.appRoles.toSorted(),
    workspaceId: realm.workspaceId,
    resourceDigest: authDatabaseResourceDigest(realm.resource),
    authResourceId: realm.authResourceId,
    ...scope,
    origin: realm.publicOrigin,
  };
}
function policyFromRow(
  row: Record<string, unknown>,
  realm: ManagedProductionRealm,
): ManagedAppSignupPolicy {
  const policy = managedAppSignupPolicyInputSchema.parse({
    version: 1,
    policyId: row.id,
    eligibility: row.eligibility,
    allowedEmails: row.allowedEmails,
    appRoles: row.appRoles,
    storage: row.signupStorage,
    appPath: row.appPath,
  });
  const scope = { appId: id.parse(row.appId), organizationId: id.parse(row.organizationId) };
  const identity = policyIdentity(policy, realm, scope);
  const policyDigest = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  if (
    row.admissionMode !== "managed-production" ||
    row.workspaceId !== identity.workspaceId ||
    row.resourceDigest !== identity.resourceDigest ||
    row.authResourceId !== identity.authResourceId ||
    row.origin !== identity.origin ||
    row.membershipRole !== "member" ||
    row.policyDigest !== policyDigest
  ) {
    throw new Error("app_signup_scope_mismatch");
  }
  return {
    ...identity,
    policyDigest,
    returnUrl: new URL(policy.appPath, identity.origin).toString(),
    enabled: z.boolean().parse(row.enabled),
    operationRef: z.uuid().parse(row.operationRef),
    planDigest: digest.parse(row.planDigest),
    fenceGeneration: z.number().int().positive().parse(Number(row.fenceGeneration)),
  };
}
export async function readManagedAppSignupPolicy(
  database: SignupPolicyDatabase,
  realm: ManagedProductionRealm,
  input: Scope & { policyId: string },
): Promise<ManagedAppSignupPolicy | null> {
  assertScope(realm, input);
  const found = await database.query(
    `select * from public.app_signup_policy where id=$1 and "admissionMode"='managed-production'
      and "workspaceId"=$2 and "resourceDigest"=$3 and "appId"=$4 and "organizationId"=$5`,
    [
      z.uuid().parse(input.policyId),
      realm.workspaceId,
      authDatabaseResourceDigest(realm.resource),
      input.appId,
      input.organizationId,
    ],
  );
  return found.rows.length === 1 ? policyFromRow(found.rows[0]!, realm) : null;
}
/** Protected Auth-management worker only; approved route revisions retain realm and app identity. */
export async function persistManagedAppSignupPolicy(
  database: SignupPolicyDatabase,
  realm: ManagedProductionRealm,
  input: Scope & {
    policy: z.input<typeof managedAppSignupPolicyInputSchema>;
    operationRef: string;
    planDigest: string;
    fenceGeneration: number;
  },
) {
  // Apply the reader's existing scope contract before any autocommitted write.
  // Explicit fields also keep transport metadata outside semantic policy identity.
  const scope = {
    appId: id.parse(input.appId),
    organizationId: id.parse(input.organizationId),
  };
  const exact = policyIdentity(managedAppSignupPolicyInputSchema.parse(input.policy), realm, scope);
  const policyDigest = createHash("sha256").update(JSON.stringify(exact)).digest("hex");
  const generation = z.number().int().positive().parse(input.fenceGeneration);
  const result = await database.query(
    `insert into public.app_signup_policy
      (id,"authResourceId","resourceDigest","appId",origin,"appPath","organizationId",eligibility,
       "allowedEmails","membershipRole","appRoles","operationRef","planDigest","policyDigest","fenceGeneration","createdAt","admissionMode","workspaceId",enabled,"signupStorage")
     values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'member',$10::jsonb,$11,$12,$13,$14,now(),'managed-production',$15,true,$16)
     on conflict(id) do update set "appPath"=excluded."appPath",eligibility=excluded.eligibility,"allowedEmails"=excluded."allowedEmails",
       "appRoles"=excluded."appRoles","signupStorage"=excluded."signupStorage","operationRef"=excluded."operationRef","planDigest"=excluded."planDigest",
       "policyDigest"=excluded."policyDigest","fenceGeneration"=excluded."fenceGeneration",enabled=true
     where app_signup_policy."admissionMode"='managed-production' and app_signup_policy."workspaceId"=excluded."workspaceId"
       and app_signup_policy."resourceDigest"=excluded."resourceDigest" and app_signup_policy."authResourceId"=excluded."authResourceId"
       and app_signup_policy."appId"=excluded."appId" and app_signup_policy."organizationId"=excluded."organizationId"
       and app_signup_policy.origin=excluded.origin
       and (app_signup_policy."fenceGeneration"<excluded."fenceGeneration" or
         (app_signup_policy."fenceGeneration"=excluded."fenceGeneration" and app_signup_policy."policyDigest"=excluded."policyDigest" and app_signup_policy.enabled
          and app_signup_policy."operationRef"=excluded."operationRef" and app_signup_policy."planDigest"=excluded."planDigest"))
     returning *`,
    [
      exact.policyId,
      realm.authResourceId,
      exact.resourceDigest,
      input.appId,
      realm.publicOrigin,
      exact.appPath,
      input.organizationId,
      exact.eligibility,
      JSON.stringify(exact.allowedEmails),
      JSON.stringify(exact.appRoles),
      z.uuid().parse(input.operationRef),
      digest.parse(input.planDigest),
      policyDigest,
      generation,
      realm.workspaceId,
      exact.storage,
    ],
  );
  if (result.rows.length !== 1) throw new Error("app_signup_policy_conflict");
  return policyFromRow(result.rows[0]!, realm);
}
export async function disableManagedAppSignupPolicy(
  database: SignupPolicyDatabase,
  realm: ManagedProductionRealm,
  input: Scope & { policyId: string; policyDigest: string; fenceGeneration: number },
) {
  const current = await readManagedAppSignupPolicy(database, realm, input);
  if (!current || current.policyDigest !== input.policyDigest)
    throw new Error("app_signup_scope_mismatch");
  const result = await database.query(
    `update public.app_signup_policy set enabled=false,"fenceGeneration"=$3
     where id=$1 and "policyDigest"=$2 and "admissionMode"='managed-production'
       and ("fenceGeneration"<$3 or ("fenceGeneration"=$3 and not enabled)) returning *`,
    [
      current.policyId,
      current.policyDigest,
      z.number().int().positive().parse(input.fenceGeneration),
    ],
  );
  if (result.rows.length !== 1) throw new Error("app_signup_policy_conflict");
  return policyFromRow(result.rows[0]!, realm);
}
/** Pre-create gate: caller redirects and email select no authority of their own. */
export async function resolveManagedAppSignupIntent(
  database: SignupPolicyDatabase,
  realm: ManagedProductionRealm,
  input: { appUrl: string; email?: string },
): Promise<ManagedAppSignupPolicy | null> {
  let url: URL;
  try {
    url = new URL(input.appUrl);
  } catch {
    return null;
  }
  if (url.origin !== realm.publicOrigin || url.username || url.password || url.hash) return null;
  const found = await database.query(
    `select * from public.app_signup_policy where "admissionMode"='managed-production' and enabled
      and "workspaceId"=$1 and "resourceDigest"=$2 and origin=$3 and "appPath"=$4 limit 2`,
    [
      realm.workspaceId,
      authDatabaseResourceDigest(realm.resource),
      realm.publicOrigin,
      `${url.pathname}${url.search}`,
    ],
  );
  if (found.rows.length !== 1) return null;
  const policy = policyFromRow(found.rows[0]!, realm);
  if (
    policy.eligibility === "approved-email" &&
    input.email !== undefined &&
    !policy.allowedEmails.includes(input.email.toLowerCase())
  )
    return null;
  return policy;
}
async function claimAccessState(
  database: SignupPolicyDatabase,
  claim: Pick<
    ManagedAppSignupClaim,
    "actorId" | "appId" | "organizationId" | "workspaceId" | "appRoles"
  > & { grantFence?: number },
) {
  const access = await database.query(
    `select active,"fenceGeneration",roles,"workspaceId" from public.app_actor_access
      where "organizationId"=$1 and "actorId"=$2 and "appId"=$3`,
    [claim.organizationId, claim.actorId, claim.appId],
  );
  const assignments = await database.query(
    `select active,fence_generation,role from public.app_actor_assignment where "organizationId"=$1 and "actorId"=$2 and "appId"=$3`,
    [claim.organizationId, claim.actorId, claim.appId],
  );
  if (
    access.rows.some((row) => row.active !== true) ||
    assignments.rows.some((row) => row.active !== true)
  )
    return "revoked" as const;
  if (access.rows.length === 0 && assignments.rows.length === 0) return "absent" as const;
  const row = access.rows[0];
  const observedRoles = assignments.rows.map((entry) => id.parse(entry.role)).toSorted();
  if (
    access.rows.length !== 1 ||
    row?.workspaceId !== claim.workspaceId ||
    Number(row.fenceGeneration) <= 0 ||
    (claim.grantFence !== undefined && Number(row.fenceGeneration) !== claim.grantFence) ||
    !isDeepStrictEqual(row.roles, claim.appRoles.toSorted()) ||
    !isDeepStrictEqual(observedRoles, claim.appRoles.toSorted()) ||
    assignments.rows.some(
      (entry) =>
        Number(entry.fence_generation) <= 0 ||
        (claim.grantFence !== undefined && Number(entry.fence_generation) !== claim.grantFence),
    )
  )
    return "changed" as const;
  return "active" as const;
}
/** A negative witness must close the positive admission and every retained role row together. */
async function claimAccessRevocation(
  database: SignupPolicyDatabase,
  claim: Pick<ManagedAppSignupClaim, "actorId" | "appId" | "organizationId" | "workspaceId">,
): Promise<{ fenceGeneration: number } | null> {
  const found = await database.query(
    `select a."fenceGeneration" from public.app_actor_access a
      where a."organizationId"=$1 and a."actorId"=$2 and a."appId"=$3 and a."workspaceId"=$4
        and a.active=false and a."fenceGeneration">0
        and not exists(select 1 from public.app_actor_assignment r
          where r."organizationId"=a."organizationId" and r."actorId"=a."actorId" and r."appId"=a."appId"
            and (r.active is distinct from false or r.fence_generation<>a."fenceGeneration"))`,
    [claim.organizationId, claim.actorId, claim.appId, claim.workspaceId],
  );
  const fence = z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .safeParse(Number(found.rows[0]?.fenceGeneration));
  return found.rows.length === 1 && fence.success ? { fenceGeneration: fence.data } : null;
}

function recordedGrantFromRow(row: Record<string, unknown>): ManagedAppSignupRecordedGrant | null {
  const receipt = managedAppSignupRecordedGrantSchema.safeParse({
    operationRef: row.signupGrantOperationRef,
    fenceGeneration: row.signupGrantFence == null ? undefined : Number(row.signupGrantFence),
  });
  const witnesses = z
    .array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
    .safeParse(row.signupGrantFences);
  return receipt.success &&
    witnesses.success &&
    witnesses.data.includes(receipt.data.fenceGeneration)
    ? receipt.data
    : null;
}

/** Observe an already committed grant. This never renews proof or grants membership/access. */
export async function readManagedAppSignupRecordedGrant(
  database: SignupPolicyDatabase,
  input: {
    proof: ManagedAppSignupClaimProof;
    workspaceId: string;
    appId: string;
    organizationId: string;
    authResourceId: string;
    storage: "none" | "postgres";
    actorId: string;
    appRoles: readonly string[];
    recordedGrant?: ManagedAppSignupRecordedGrant;
  },
): Promise<ManagedAppSignupRecordedGrant | null> {
  const proof = managedAppSignupClaimProofSchema.parse(input.proof);
  const found = await database.query(
    `select i.*,p."authResourceId",p."signupStorage" from public.app_access_invitation i
      join public.app_signup_policy p on p.id=i."signupPolicyId"
      where i.id=$1 and i."signupPolicyId"=$2 and i."scopeDigest"=$3 and i."workspaceId"=$4
        and i."appId"=$5 and i."organizationId"=$6 and i."verifiedActorId"=$7
        and i.status in ('verified','accepted') and p."admissionMode"='managed-production'
        and p."workspaceId"=i."workspaceId" and p."resourceDigest"=i."resourceDigest"
        and p."appId"=i."appId" and p."organizationId"=i."organizationId"
        and exists(select 1 from public.member m where m."organizationId"=i."organizationId" and m."userId"=i."verifiedActorId")`,
    [
      proof.claimId,
      proof.policyId,
      proof.scopeDigest,
      input.workspaceId,
      input.appId,
      input.organizationId,
      input.actorId,
    ],
  );
  const row = found.rows[0];
  if (
    found.rows.length !== 1 ||
    !row ||
    row.authResourceId !== input.authResourceId ||
    row.signupStorage !== input.storage ||
    !isDeepStrictEqual(row.roles, input.appRoles.toSorted())
  )
    return null;
  const receipt = recordedGrantFromRow(row);
  if (
    !receipt ||
    (input.recordedGrant &&
      !isDeepStrictEqual(receipt, managedAppSignupRecordedGrantSchema.parse(input.recordedGrant)))
  )
    return null;
  const state = await claimAccessState(database, {
    ...input,
    appRoles: [...input.appRoles],
    grantFence: receipt.fenceGeneration,
  });
  return state === "active" ? receipt : null;
}

export async function readManagedAppSignupClaim(
  database: SignupPolicyDatabase,
  realm: ManagedProductionRealm,
  input: Scope & { policyId: string; claimId: string },
): Promise<ManagedAppSignupClaim | null> {
  const policy = await readManagedAppSignupPolicy(database, realm, input);
  if (!policy) return null;
  const found = await database.query(
    `select i.*,exists(select 1 from public.member m where m."organizationId"=i."organizationId" and m."userId"=i."verifiedActorId") as "hasMember"
      from public.app_access_invitation i where id=$1 and "signupPolicyId"=$2 and "workspaceId"=$3
      and "resourceDigest"=$4 and "appId"=$5 and "organizationId"=$6`,
    [
      z.uuid().parse(input.claimId),
      policy.policyId,
      realm.workspaceId,
      policy.resourceDigest,
      input.appId,
      input.organizationId,
    ],
  );
  const row = found.rows[0];
  if (found.rows.length !== 1 || !row) return null;
  const base = {
    id: z.uuid().parse(row.id),
    policyId: policy.policyId,
    policyDigest: digest.parse(row.signupPolicyDigest),
    scopeDigest: digest.parse(row.scopeDigest),
    workspaceId: realm.workspaceId,
    resourceDigest: policy.resourceDigest,
    appId: input.appId,
    organizationId: input.organizationId,
    actorId: id.parse(row.verifiedActorId),
    sessionId: id.parse(row.verifiedSessionId),
    appRoles: roles.parse(row.roles),
    returnUrl: z.url().parse(row.returnUrl),
    expiresAt:
      row.expiresAt instanceof Date
        ? row.expiresAt.toISOString()
        : z.iso.datetime({ offset: true }).parse(row.expiresAt),
  };
  const accessState = await claimAccessState(database, {
    ...base,
    ...(row.signupGrantFence == null ? {} : { grantFence: Number(row.signupGrantFence) }),
  });
  const identity = await database.query(
    `select s."activeOrganizationId",exists(select 1 from public.member m where m."organizationId"=$3 and m."userId"=$2) as member
      from public.session s join public."user" u on u.id=s."userId"
      where s.id=$1 and u.id=$2 and u."emailVerified" and lower(u.email)=$4 and s."expiresAt">clock_timestamp()`,
    [base.sessionId, base.actorId, base.organizationId, row.email],
  );
  const exact =
    base.policyDigest === policy.policyDigest &&
    base.returnUrl === policy.returnUrl &&
    isDeepStrictEqual(base.appRoles.toSorted(), policy.appRoles) &&
    identity.rows.length === 1;
  const memberPrepared =
    identity.rows[0]?.member === true &&
    identity.rows[0]?.activeOrganizationId === base.organizationId;
  const grantFences = z
    .array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
    .parse(row.signupGrantFences);
  const grantReserved =
    row.signupGrantFence != null || row.signupGrantOperationRef != null || grantFences.length !== 0;
  const recordedGrant =
    accessState === "active" &&
    row.hasMember === true &&
    ["verified", "accepted"].includes(String(row.status))
      ? recordedGrantFromRow(row)
      : null;
  const accessRevocation =
    accessState === "revoked" ? await claimAccessRevocation(database, base) : null;
  const applied = exact && memberPrepared && row.status === "accepted" && accessState === "active";
  const verified =
    exact &&
    policy.enabled &&
    row.status === "verified" &&
    Date.parse(base.expiresAt) > Date.now() &&
    (accessState === "absent" || accessState === "active");
  return {
    ...base,
    status: applied ? "applied" : verified ? "verified" : "rejected",
    accessState,
    memberPrepared,
    grantReserved,
    ...(recordedGrant ? { recordedGrant } : {}),
    ...(accessRevocation ? { accessRevocation } : {}),
  };
}
/** Runtime can mint identity proof only; grants stay in the protected worker. */
export async function claimManagedAppSignup(
  database: SignupPolicyDatabase,
  realm: ManagedProductionRealm,
  input: { policyId: string; policyDigest: string; actorId: string; sessionId: string },
): Promise<ManagedAppSignupClaim | null> {
  const minted = await database.query(
    `select public.claim_managed_app_signup($1,$2,$3,$4,$5,$6,$7) as claim`,
    [
      z.uuid().parse(input.policyId),
      digest.parse(input.policyDigest),
      id.parse(input.actorId),
      id.parse(input.sessionId),
      authDatabaseResourceDigest(realm.resource),
      realm.workspaceId,
      realm.publicOrigin,
    ],
  );
  const row = z
    .object({ id: z.uuid(), appId: id, organizationId: id })
    .nullable()
    .safeParse(minted.rows[0]?.claim);
  if (!row.success || !row.data) return null;
  return await readManagedAppSignupClaim(database, realm, {
    ...row.data,
    policyId: input.policyId,
    claimId: row.data.id,
  });
}
export const managedAppSignupCompletionRequest = (claim: ManagedAppSignupClaim) => ({
  version: 1 as const,
  kind: "signup" as const,
  policyId: claim.policyId,
  claimId: claim.id,
});
export async function readManagedAppSignupAccess(
  database: SignupPolicyDatabase,
  realm: ManagedProductionRealm,
  input: { policyId: string; policyDigest: string; actorId: string; sessionId: string },
): Promise<{ status: "ready"; appUrl: string } | null> {
  const found = await database.query(
    `select id,"appId","organizationId" from public.app_access_invitation where "signupPolicyId"=$1 and "signupPolicyDigest"=$2
      and "verifiedActorId"=$3 and "verifiedSessionId"=$4 and "workspaceId"=$5 and "resourceDigest"=$6 and status='accepted'`,
    [
      input.policyId,
      input.policyDigest,
      input.actorId,
      input.sessionId,
      realm.workspaceId,
      authDatabaseResourceDigest(realm.resource),
    ],
  );
  const row = found.rows[0];
  if (found.rows.length !== 1 || !row) return null;
  const claim = await readManagedAppSignupClaim(database, realm, {
    policyId: input.policyId,
    claimId: z.uuid().parse(row.id),
    appId: id.parse(row.appId),
    organizationId: id.parse(row.organizationId),
  });
  return claim?.status === "applied" ? { status: "ready", appUrl: claim.returnUrl } : null;
}
/** The protected host must reconcile app grants before completing this frozen proof. */
export async function prepareManagedAppSignupMember(input: {
  client: PoolClient;
  realm: ManagedProductionRealm;
  scope: Scope;
  proof: ManagedAppSignupClaimProof;
  actorId: string;
  authOperatorRole: string;
  assertCurrent: () => Promise<void>;
}) {
  const claim = await readManagedAppSignupClaim(input.client, input.realm, {
    ...input.scope,
    ...input.proof,
  });
  if (
    !claim ||
    claim.status !== "verified" ||
    claim.accessState !== "absent" ||
    claim.actorId !== input.actorId ||
    claim.scopeDigest !== input.proof.scopeDigest
  ) {
    throw new Error("app_signup_claim_unavailable");
  }
  await joinExistingRealmOrganization({
    client: input.client,
    resource: input.realm.resource,
    authOperatorRole: input.authOperatorRole,
    spec: {
      workspaceId: input.realm.workspaceId,
      organizationId: input.scope.organizationId,
      actorId: claim.actorId,
    },
    realmSessionId: claim.sessionId,
    invitationIdentity: { invitationId: claim.id, scopeDigest: claim.scopeDigest },
    assertCurrent: input.assertCurrent,
  });
  const prepared = await readManagedAppSignupClaim(input.client, input.realm, {
    ...input.scope,
    ...input.proof,
  });
  if (
    !prepared ||
    !prepared.memberPrepared ||
    prepared.status !== "verified" ||
    prepared.accessState !== "absent"
  )
    throw new Error("app_signup_claim_unavailable");
  return prepared;
}
export async function completeManagedAppSignup(
  database: SignupPolicyDatabase,
  realm: ManagedProductionRealm,
  input: Scope & ManagedAppSignupClaimProof & { actorId: string; fenceGeneration: number },
) {
  const claim = await readManagedAppSignupClaim(database, realm, input);
  if (
    !claim ||
    claim.actorId !== input.actorId ||
    claim.scopeDigest !== input.scopeDigest ||
    !claim.memberPrepared ||
    claim.accessState !== "active" ||
    claim.status === "rejected"
  )
    throw new Error("app_signup_claim_unavailable");
  const updated = await database.query(
    `update public.app_access_invitation set status='accepted',"fenceGeneration"=$3 where id=$1 and "scopeDigest"=$2
      and "fenceGeneration"<=$3 and status in ('verified','accepted') returning id`,
    [claim.id, claim.scopeDigest, z.number().int().positive().parse(input.fenceGeneration)],
  );
  if (updated.rows.length !== 1) throw new Error("app_signup_claim_unavailable");
  return await readManagedAppSignupClaim(database, realm, input);
}

/** Called inside the existing org-locked grant transaction. No new claim can revive access history. */
export async function assertManagedAppSignupGrant(
  database: SignupPolicyDatabase,
  input: {
    proof: ManagedAppSignupClaimProof;
    workspaceId: string;
    appId: string;
    organizationId: string;
    authResourceId?: string;
    storage: "none" | "postgres";
    actorId: string;
    appRoles: readonly string[];
    fenceGeneration: number;
    operationRef: string;
  },
) {
  const proof = managedAppSignupClaimProofSchema.parse(input.proof);
  const rows = await database.query(
    `select i.*,p."authResourceId",p."signupStorage",p.enabled,p."policyDigest",p."appRoles" as "policyRoles"
      from public.app_access_invitation i join public.app_signup_policy p on p.id=i."signupPolicyId"
      where i.id=$1 and i."signupPolicyId"=$2 and i."scopeDigest"=$3 and i."workspaceId"=$4
        and i."appId"=$5 and i."organizationId"=$6 and i."verifiedActorId"=$7
        and p."admissionMode"='managed-production' and p."workspaceId"=i."workspaceId"
        and p."resourceDigest"=i."resourceDigest" and p."appId"=i."appId" and p."organizationId"=i."organizationId"
        and i.status='verified' and i."expiresAt">clock_timestamp() and p.enabled
        and i."signupPolicyDigest"=p."policyDigest"
        and exists(select 1 from public.session s join public."user" u on u.id=s."userId"
          where s.id=i."verifiedSessionId" and u.id=i."verifiedActorId" and u."emailVerified"
            and lower(u.email)=i.email and s."activeOrganizationId"=i."organizationId" and s."expiresAt">clock_timestamp()
            and exists(select 1 from public.member m where m."userId"=u.id and m."organizationId"=i."organizationId")) for update of i for share of p`,
    [
      proof.claimId,
      proof.policyId,
      proof.scopeDigest,
      input.workspaceId,
      input.appId,
      input.organizationId,
      input.actorId,
    ],
  );
  const row = rows.rows[0];
  if (
    rows.rows.length !== 1 ||
    !row ||
    row.signupStorage !== input.storage ||
    (input.authResourceId !== undefined && row.authResourceId !== input.authResourceId) ||
    !isDeepStrictEqual(row.roles, input.appRoles.toSorted()) ||
    !isDeepStrictEqual(row.policyRoles, row.roles)
  ) {
    throw new Error("app_signup_claim_unavailable");
  }
  const access = await database.query(
    `select active,"fenceGeneration" as fence_generation from public.app_actor_access where "organizationId"=$1 and "actorId"=$2 and "appId"=$3
      union all select active,fence_generation from public.app_actor_assignment where "organizationId"=$1 and "actorId"=$2 and "appId"=$3`,
    [input.organizationId, input.actorId, input.appId],
  );
  const generation = z.number().int().positive().parse(input.fenceGeneration);
  const operationRef = z.uuid().parse(input.operationRef);
  const witnessedFences = z
    .array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
    .parse(row.signupGrantFences);
  const ownedFences = [...new Set([...witnessedFences, generation])];
  const priorFence = row.signupGrantFence == null ? generation : Number(row.signupGrantFence);
  if (
    witnessedFences.some((fence) => fence > generation) ||
    (row.signupGrantFence == null
      ? access.rows.length !== 0
      : row.signupGrantOperationRef !== operationRef ||
        priorFence > generation ||
        access.rows.some(
          (entry) => entry.active !== true || !ownedFences.includes(Number(entry.fence_generation)),
        ))
  ) {
    throw new Error("app_signup_access_history");
  }
  const reserved = await database.query(
    `update public.app_access_invitation set "signupGrantFence"=coalesce("signupGrantFence",$2),
      "signupGrantOperationRef"=coalesce("signupGrantOperationRef",$3),
      "signupGrantFences"=$4::jsonb where id=$1
      and ("signupGrantOperationRef" is null or "signupGrantOperationRef"=$3) returning id`,
    [proof.claimId, generation, operationRef, JSON.stringify(ownedFences)],
  );
  if (reserved.rows.length !== 1) throw new Error("app_signup_claim_unavailable");
  return { ownedFences };
}

/** Commit ownership of the actual grant in the same Auth transaction that writes it. */
export async function recordManagedAppSignupGrant(
  database: SignupPolicyDatabase,
  input: {
    proof: ManagedAppSignupClaimProof;
    operationRef: string;
    fenceGeneration: number;
  },
) {
  const result = await database.query(
    `update public.app_access_invitation set "signupGrantFence"=$3 where id=$1 and "signupGrantOperationRef"=$2
      and "signupGrantFence"<=$3 and "signupGrantFences" @> jsonb_build_array($3::bigint) returning id`,
    [
      input.proof.claimId,
      z.uuid().parse(input.operationRef),
      z.number().int().positive().parse(input.fenceGeneration),
    ],
  );
  if (result.rows.length !== 1) throw new Error("app_signup_claim_unavailable");
}
