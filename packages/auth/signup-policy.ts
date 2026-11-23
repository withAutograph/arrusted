import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import type { AuthDatabaseResource } from "./database-resource";

const id = z.string().min(1).max(256);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const safeOrigin = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
  });
const safeAppPath = z
  .string()
  .regex(/^\/(?!\/)[^\\\s#]*$/u)
  .refine((value) => {
    const url = new URL(value, "https://policy.invalid");
    return url.origin === "https://policy.invalid" && !url.username && !url.password;
  });

/** Inputs are frozen in the approved Auth plan. The worker binds operation and plan digests. */
export const appSignupPolicySchema = z
  .strictObject({
    version: z.literal(1),
    policyId: id,
    authResourceId: id,
    appId: id,
    origin: safeOrigin,
    appPath: safeAppPath,
    organizationId: id,
    eligibility: z.enum(["public", "approved-email"]),
    allowedEmails: z.array(z.email()).optional(),
    membershipRole: z.literal("member"),
    appRoles: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u)).min(1),
  })
  .superRefine((policy, ctx) => {
    if (policy.eligibility === "approved-email" && !policy.allowedEmails?.length)
      ctx.addIssue({
        code: "custom",
        message: "Approved-email signup requires an eligibility list.",
      });
    if (
      new Set((policy.allowedEmails ?? []).map((email) => email.toLowerCase())).size !==
        (policy.allowedEmails ?? []).length ||
      new Set(policy.appRoles).size !== policy.appRoles.length
    )
      ctx.addIssue({ code: "custom", message: "Signup policy entries must be unique." });
  });
export type AppSignupPolicy = z.infer<typeof appSignupPolicySchema>;
export type BoundAppSignupPolicy = AppSignupPolicy & {
  operationRef: string;
  planDigest: string;
  fenceGeneration: number;
};
export const appSignupPolicyDigest = (policy: BoundAppSignupPolicy) =>
  createHash("sha256").update(JSON.stringify(policy)).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function authDatabaseResourceDigest(resource: AuthDatabaseResource) {
  return createHash("sha256").update(canonical(resource)).digest("hex");
}
const signupIntent = new AsyncLocalStorage<string>();
export function withAppSignupIntent<T>(target: string | undefined, operation: () => T): T {
  return target ? signupIntent.run(target, operation) : operation();
}
export const currentAppSignupIntent = () => signupIntent.getStore();

export interface SignupPolicyDatabase {
  query(query: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Called only by the already-authorized protected membership worker. */
export async function persistAppSignupPolicy(
  database: SignupPolicyDatabase,
  policyInput: AppSignupPolicy,
  binding: {
    operationRef: string;
    planDigest: string;
    fenceGeneration: number;
    resource: AuthDatabaseResource;
  },
) {
  const policy = appSignupPolicySchema.parse(policyInput);
  const bound = {
    ...policy,
    operationRef: binding.operationRef,
    planDigest: digest.parse(binding.planDigest),
    fenceGeneration: binding.fenceGeneration,
  };
  const policyDigest = appSignupPolicyDigest(bound);
  const approvedOrganization = await database.query(
    `select 1 from "organization" where "id"=$1 and "appIds" @> $2::jsonb`,
    [policy.organizationId, JSON.stringify([policy.appId])],
  );
  if (approvedOrganization.rows.length !== 1)
    throw new Error("signup_policy_organization_mismatch");
  const result = await database.query(
    `insert into "app_signup_policy" ("id","authResourceId","resourceDigest","appId","origin","appPath","organizationId","eligibility","allowedEmails","membershipRole","appRoles","operationRef","planDigest","policyDigest","fenceGeneration","createdAt")
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'member',$10::jsonb,$11,$12,$13,$14,now())
     on conflict ("id") do update set "authResourceId"=excluded."authResourceId", "resourceDigest"=excluded."resourceDigest",
       "appId"=excluded."appId", "origin"=excluded."origin", "appPath"=excluded."appPath", "organizationId"=excluded."organizationId",
       "eligibility"=excluded."eligibility", "allowedEmails"=excluded."allowedEmails", "membershipRole"=excluded."membershipRole",
       "appRoles"=excluded."appRoles", "operationRef"=excluded."operationRef", "planDigest"=excluded."planDigest",
       "policyDigest"=excluded."policyDigest", "fenceGeneration"=excluded."fenceGeneration", "createdAt"=now()
     where "app_signup_policy"."admissionMode"='legacy' and (excluded."fenceGeneration" > "app_signup_policy"."fenceGeneration"
        or (excluded."fenceGeneration" = "app_signup_policy"."fenceGeneration" and excluded."policyDigest" = "app_signup_policy"."policyDigest"))
     returning "id","policyDigest"`,
    [
      policy.policyId,
      policy.authResourceId,
      authDatabaseResourceDigest(binding.resource),
      policy.appId,
      policy.origin,
      policy.appPath,
      policy.organizationId,
      policy.eligibility,
      JSON.stringify(policy.allowedEmails ?? []),
      JSON.stringify(policy.appRoles),
      binding.operationRef,
      binding.planDigest,
      policyDigest,
      binding.fenceGeneration,
    ],
  );
  if (result.rows.length !== 1 || result.rows[0]?.policyDigest !== policyDigest)
    throw new Error("signup_policy_conflict");
  return { policyDigest };
}

export async function enrollAppSignupUser(
  database: SignupPolicyDatabase,
  input: {
    userId: string;
    sessionId: string;
    origin: string;
    resource: AuthDatabaseResource;
    appUrl?: string;
  },
) {
  if (!input.appUrl) return { status: "waiting_for_signup" as const };
  const target = new URL(input.appUrl);
  if (target.origin !== input.origin) return { status: "blocked" as const };
  const appPath = `${target.pathname}${target.search}`;
  const policies = await database.query(
    `select "id","organizationId","appId","eligibility","allowedEmails","membershipRole","appRoles" from "app_signup_policy" where "admissionMode"='legacy' and "resourceDigest"=$1 and "origin"=$2 and "appPath"=$3 order by "createdAt" desc limit 2`,
    [authDatabaseResourceDigest(input.resource), input.origin, appPath],
  );
  if (policies.rows.length === 0) return { status: "waiting_for_signup" as const };
  if (policies.rows.length !== 1) return { status: "blocked" as const };
  const enrollment = await database.query(
    `select public.enroll_app_signup_user($1,$2,$3,$4,$5) as result`,
    [
      input.userId,
      input.sessionId,
      authDatabaseResourceDigest(input.resource),
      input.origin,
      appPath,
    ],
  );
  const result = enrollment.rows[0]?.result;
  if (
    !result ||
    typeof result !== "object" ||
    (result as Record<string, unknown>).status !== "membership_ready"
  )
    return { status: "blocked" as const };
  const ready = result as {
    appId: string;
    organizationId: string;
    roles: string[];
    sessionBound?: boolean;
  };
  return {
    status: "membership_ready" as const,
    appId: ready.appId,
    organizationId: ready.organizationId,
    roles: ready.roles,
    sessionBound: ready.sessionBound === true,
  };
}

/** Private readback: `ready` requires the persisted session, membership, and every planned app role. */
export async function readAppSignupStatus(
  database: SignupPolicyDatabase,
  input: {
    userId?: string;
    sessionId?: string;
    origin: string;
    resource: AuthDatabaseResource;
    appUrl?: string;
  },
) {
  if (!input.appUrl) return { status: "waiting_for_signup" as const };
  const target = new URL(input.appUrl);
  if (target.origin !== input.origin) return { status: "blocked" as const };
  const appPath = `${target.pathname}${target.search}`;
  const found = await database.query(
    `select "id","appId","appPath","organizationId","appRoles","membershipRole" from "app_signup_policy" where "admissionMode"='legacy' and "resourceDigest"=$1 and "origin"=$2 and "appPath"=$3 order by "createdAt" desc limit 2`,
    [authDatabaseResourceDigest(input.resource), input.origin, appPath],
  );
  if (!found.rows.length) return { status: "waiting_for_signup" as const };
  if (found.rows.length !== 1) return { status: "blocked" as const };
  const policy = found.rows[0]!;
  const expectedRoles = Array.isArray(policy.appRoles)
    ? policy.appRoles.filter((role): role is string => typeof role === "string")
    : [];
  if (
    policy.membershipRole !== "member" ||
    typeof policy.organizationId !== "string" ||
    typeof policy.appId !== "string" ||
    typeof policy.appPath !== "string" ||
    expectedRoles.length === 0
  )
    return { status: "blocked" as const };
  const appUrl = new URL(policy.appPath, input.origin);
  if (appUrl.origin !== input.origin) return { status: "blocked" as const };
  const signupUrl = new URL("/auth/sign-up", input.origin);
  signupUrl.searchParams.set("redirectTo", appUrl.toString());
  if (!input.userId || !input.sessionId)
    return {
      status: "waiting_for_signup" as const,
      appId: policy.appId,
      appUrl: appUrl.toString(),
      signupUrl: signupUrl.toString(),
    };
  const session = await database.query(
    `select 1 from "session" where "id"=$1 and "userId"=$2 and "activeOrganizationId"=$3 and "expiresAt">now()`,
    [input.sessionId, input.userId, policy.organizationId],
  );
  const member = await database.query(
    `select 1 from "member" where "organizationId"=$1 and "userId"=$2`,
    [policy.organizationId, input.userId],
  );
  const assignments = await database.query(
    `select "role" from "app_actor_assignment" where "organizationId"=$1 and "actorId"=$2 and "appId"=$3 and active`,
    [policy.organizationId, input.userId, policy.appId],
  );
  const observed = assignments.rows
    .map((row) => row.role)
    .filter((role): role is string => typeof role === "string")
    .sort();
  if (
    session.rows.length !== 1 ||
    member.rows.length !== 1 ||
    expectedRoles.some((role) => !observed.includes(role))
  )
    return { status: "blocked" as const };
  return {
    status: "ready" as const,
    appId: policy.appId,
    organizationId: policy.organizationId,
    roles: observed,
    appUrl: appUrl.toString(),
  };
}
