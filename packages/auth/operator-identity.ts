import { constantTimeEqual, makeSignature } from "better-auth/crypto";
import { parseCookies } from "better-auth/cookies";
import { z } from "zod";

export const AUTH_OPERATOR_IDENTITY_PATH = "/api/auth/platform/operator-identity";
export const realmOperatorIdentitySchema = z.strictObject({
  version: z.literal(1),
  actorId: z.string().min(1),
  sessionId: z.string().min(1),
  organizationId: z.string().min(1).nullable(),
  expiresAt: z.string().datetime({ offset: true }),
});
export type RealmOperatorIdentity = z.infer<typeof realmOperatorIdentitySchema>;

/** The Auth host supplies its existing normal cookie configuration and resource-verified runtime database. */
export async function readNormalSignedRealmIdentity(input: {
  headers: Headers;
  organizationId: string | null;
  cookieName: string;
  secret: string;
  database: {
    query(query: string, values: readonly unknown[]): Promise<{ rows: unknown[] }>;
  };
}): Promise<RealmOperatorIdentity | null> {
  const cookie = parseCookies(input.headers.get("cookie") ?? "").get(input.cookieName);
  if (!cookie) return null;
  const split = cookie.lastIndexOf(".");
  if (split <= 0) return null;
  const token = cookie.slice(0, split);
  const signature = cookie.slice(split + 1);
  if (!constantTimeEqual(signature, await makeSignature(token, input.secret))) return null;
  // One fixed SELECT: no session refresh, expiry cleanup, user creation, or membership mutation.
  const result = await input.database.query(
    `select s.id as "sessionId", u.id as "actorId", m."organizationId" as "organizationId",
      to_char(s."expiresAt" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt",
      1 as version
     from public.session s join public."user" u on u.id=s."userId"
     left join public.member m on m."userId"=u.id and m."organizationId"=$2
     left join public.organization o on o.id=m."organizationId"
     where s.token=$1 and s."expiresAt">now() 
       and ($2::text is null or (o.id=$2 and 'owner'=any(string_to_array(m.role, ','))))`,
    [token, input.organizationId],
  );
  if (result.rows.length !== 1) return null;
  const parsed = realmOperatorIdentitySchema.safeParse(result.rows[0]);
  return parsed.success ? parsed.data : null;
}

/** Fixed live readback after a scoped signature/canonical-capture authority check; never refreshes or deletes sessions. */
export async function readNormalRealmIdentityBySession(input: {
  database: { query(query: string, values: readonly unknown[]): Promise<{ rows: unknown[] }> };
  actorId: string;
  realmSessionId: string;
  organizationId: string | null;
}): Promise<RealmOperatorIdentity | null> {
  const scope = z
    .strictObject({
      actorId: z.string().min(1).max(512),
      realmSessionId: z.string().min(1).max(512),
      organizationId: z.string().min(1).max(512).nullable(),
    })
    .parse({
      actorId: input.actorId,
      realmSessionId: input.realmSessionId,
      organizationId: input.organizationId,
    });
  const result = await input.database.query(
    `select s.id as "sessionId", u.id as "actorId", m."organizationId" as "organizationId",
       to_char(s."expiresAt" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt", 1 as version
     from public.session s join public."user" u on u.id=s."userId"
     left join public.member m on m."userId"=u.id and m."organizationId"=$3
     left join public.organization o on o.id=m."organizationId"
     where s.id=$1 and u.id=$2 and s."expiresAt">now()
       and ($3::text is null or (o.id=$3 and 'owner'=any(string_to_array(m.role, ','))))`,
    [scope.realmSessionId, scope.actorId, scope.organizationId],
  );
  if (result.rows.length !== 1) return null;
  const parsed = realmOperatorIdentitySchema.safeParse(result.rows[0]);
  return parsed.success ? parsed.data : null;
}
