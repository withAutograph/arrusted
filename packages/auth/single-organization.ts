import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { organization } from "better-auth/plugins";
import type { Pool } from "pg";
import { createAgentGrantPlugins, requireGrantContext } from "./agent-grant";
import { agentGrantIssuer } from "./agent-grant-policy";
import { canvasFrameOrigins, readCanvasFrameOrigins } from "./canvas-frame";
import { emptySetAdapter } from "./empty-set-adapter";
import { errorMessage, redact } from "./redact";
import { proofHash, singleOrganizationAdmission } from "./single-organization-admission";

/** One deployment, one organization; OAuth consent remains separate from human sign-in. */
export function createSingleOrganizationAuth(input: {
  database: Pool;
  origin: string;
  secret: string;
  appId: string;
  organizationId: string;
  name: string;
  allowSignUp?: boolean;
  ownerSetupHash?: string;
  bodyTimeoutMs?: number;
  connectTimeoutMs?: number;
}) {
  const origin = new URL(input.origin);
  if (origin.origin !== input.origin || !["http:", "https:"].includes(origin.protocol))
    throw new Error("Auth origin must be an exact HTTP(S) origin.");
  if (input.secret.length < 32) throw new Error("Auth secret must contain at least 32 characters.");
  const redactEnv = (): Record<string, string | undefined> => ({
    ...process.env,
    AUTH_DATABASE_URL:
      typeof input.database.options?.connectionString === "string"
        ? input.database.options.connectionString
        : undefined,
    PGPASSWORD:
      typeof input.database.options?.password === "string"
        ? input.database.options.password
        : undefined,
    BETTER_AUTH_SECRET: input.secret,
    APP_OWNER_SETUP_HASH: input.ownerSetupHash,
  });
  const admission = singleOrganizationAdmission({ ...input, redactEnv });
  const auth = betterAuth({
    appName: input.name,
    baseURL: input.origin,
    database: admission.database,
    secret: input.secret,
    trustedOrigins: [
      input.origin,
      ...canvasFrameOrigins({
        publicOrigin: input.origin,
        appIds: [input.appId],
        configured: readCanvasFrameOrigins(),
      }),
    ],
    emailAndPassword: { enabled: true },
    logger: {
      level: "error",
      log: (_level, message, ...args) =>
        console.error(
          redact([message, ...args.map(errorMessage)].join(" "), admission.activeSecrets()),
        ),
    },
    hooks: { before: admission.before },
    databaseHooks: {
      user: {
        create: {
          after: admission.member,
        },
      },
      session: {
        create: {
          before: async (session) => ({
            data: { ...session, activeOrganizationId: input.organizationId },
          }),
        },
      },
    },
    plugins: [
      emptySetAdapter(),
      organization({
        organizationHooks: {
          beforeAddMember: async () => {
            throw new Error("Use the deployment's invitation flow.");
          },
        },
        allowUserToCreateOrganization: false,
        disableOrganizationDeletion: true,
        schema: {
          organization: {
            additionalFields: {
              metadata: { type: "string", required: false, input: false },
              appIds: { type: "json", required: false, input: false },
            },
          },
        },
      }),
      ...createAgentGrantPlugins({
        database: admission.database,
        publicOrigin: input.origin,
        appIds: [input.appId],
        singleOrganizationId: input.organizationId,
      }),
      nextCookies(),
    ],
  });
  const handler = auth.handler;
  auth.handler = async (request) => {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/auth/owner-setup-status") {
      if (request.method !== "GET") return Response.json({ message: "Use GET." }, { status: 405 });
      const result = await admission.database.query<{ complete: boolean }>(
        `select (
          exists(select 1 from member where "organizationId"=$1)
          or exists(
            select 1 from organization
            where id=$1 and metadata is not null and btrim(metadata) like '{%'
              and metadata::jsonb @> '{"ownerSetupComplete":true}'::jsonb
          )
        ) as complete`,
        [input.organizationId],
      );
      const complete = Boolean(result.rows[0]?.complete);
      const hashCheck = request.headers.get("x-owner-setup-hash-check")?.trim();
      if (hashCheck !== undefined) {
        const expected =
          input.ownerSetupHash && /^[a-f0-9]{64}$/.test(input.ownerSetupHash)
            ? createHash("sha256")
                .update(`owner-setup-hash-check:${input.ownerSetupHash}`)
                .digest("hex")
            : undefined;
        const hashMatches = Boolean(
          expected &&
          /^[a-f0-9]{64}$/.test(hashCheck) &&
          timingSafeEqual(Buffer.from(hashCheck, "hex"), Buffer.from(expected, "hex")),
        );
        return Response.json(
          { complete, hashMatches },
          { headers: { "cache-control": "no-store" } },
        );
      }
      return Response.json({ complete }, { headers: { "cache-control": "no-store" } });
    }
    if (pathname === "/api/auth/accept-member-invitation") {
      return admission.acceptInvitation(request, () =>
        auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } }),
      );
    }
    return admission.handle(request, handler);
  };
  const requireOwner = async (headers: Headers) => {
    const session = await auth.api.getSession({ headers, query: { disableCookieCache: true } });
    if (!session)
      throw Object.assign(new Error("Sign in to continue."), {
        status: 401,
        code: "auth_required",
      });
    const result = await input.database.query(
      `select 1 from member where "organizationId"=$1 and "userId"=$2 and role='owner'`,
      [input.organizationId, session.user.id],
    );
    if (!result.rowCount) {
      const owners = await input.database.query(
        `select 1 from member where "organizationId"=$1 and role='owner' limit 1`,
        [input.organizationId],
      );
      if (!owners.rowCount)
        throw Object.assign(
          new Error(
            "No owner exists yet. Ask the builder to run owner:claim in the builder terminal.",
          ),
          { status: 403, code: "no_owner" },
        );
      throw Object.assign(new Error("Only an owner can manage members."), {
        status: 403,
        code: "owner_required",
      });
    }
    return session.user.id;
  };
  const requireMember = async (actorId: string) => {
    const result = await input.database.query(
      `select "id" from "member" where "userId" = $1 and "organizationId" = $2 limit 1`,
      [actorId, input.organizationId],
    );
    if (result.rows.length !== 1)
      throw Object.assign(new Error("An active membership is required."), {
        status: 403,
        code: "app_access_required",
      });
  };
  return {
    auth,
    requireMember,
    async members(headers: Headers) {
      await requireOwner(headers);
      return (
        await input.database.query<{ id: string; email: string; role: string }>(
          `select m."userId" as id,u.email,m.role from member m join "user" u on u.id=m."userId" where m."organizationId"=$1 order by u.email`,
          [input.organizationId],
        )
      ).rows;
    },
    async changeMember(headers: Headers, userId: string, action: "remove" | "promote") {
      const actor = await requireOwner(headers);
      const client = await input.database.connect();
      try {
        await client.query("begin");
        // Shared with owner recovery and admission: no race can remove the last owner.
        await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
          `signup:${input.organizationId}`,
        ]);
        const rows = (
          await client.query<{ userId: string; role: string }>(
            'select "userId",role from member where "organizationId"=$1 for update',
            [input.organizationId],
          )
        ).rows;
        if (!rows.some((m) => m.userId === actor && m.role === "owner"))
          throw Object.assign(new Error("Only an owner can manage members."), {
            status: 403,
            code: "owner_required",
          });
        const target = rows.find((m) => m.userId === userId);
        if (!target) throw new Error("Member no longer exists.");
        if (action === "promote") {
          await client.query(
            `update member set role='owner' where "organizationId"=$1 and "userId"=$2`,
            [input.organizationId, userId],
          );
        } else {
          if (target.role === "owner" && rows.filter((m) => m.role === "owner").length === 1)
            throw new Error("Cannot remove the last owner.");
          await client.query('delete from member where "organizationId"=$1 and "userId"=$2', [
            input.organizationId,
            userId,
          ]);
          await client.query('delete from "oauthAccessToken" where "userId"=$1', [userId]);
          await client.query('delete from "oauthRefreshToken" where "userId"=$1', [userId]);
          await client.query('delete from "oauthConsent" where "userId"=$1', [userId]);
          await client.query('delete from "deviceCode" where "userId"=$1', [userId]);
          await client.query(
            `delete from "verification" v
             where v."value" like '{"type":"authorization_code"%'
               and (case when v."value" like '{"type":"authorization_code"%'
                     then v."value"::jsonb end) ->> 'userId' = $1`,
            [userId],
          );
          await client.query('delete from session where "userId"=$1', [userId]);
        }
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async invitations(headers: Headers) {
      await requireOwner(headers);
      return (
        await input.database.query<{ id: string; email: string; status: string; expiresAt: Date }>(
          'select id,email,status,"expiresAt" from invitation where "organizationId"=$1 order by "createdAt" desc',
          [input.organizationId],
        )
      ).rows;
    },
    async invite(headers: Headers, email: string) {
      const actor = await requireOwner(headers);
      email = email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email.");
      const secret = randomBytes(32).toString("base64url");
      await input.database.query(
        `insert into invitation (id,"organizationId",email,role,status,"expiresAt","inviterId")
        values ($1,$2,$3,'member','pending',now()+interval '7 days',$4)`,
        [proofHash(secret), input.organizationId, email, actor],
      );
      return `${input.origin}/auth/sign-in#invite=${secret}`;
    },
    async revoke(headers: Headers, id: string) {
      await requireOwner(headers);
      await input.database.query(
        `update invitation set status='revoked' where id=$1 and "organizationId"=$2 and status='pending'`,
        [id, input.organizationId],
      );
    },
    async session(headers: Headers) {
      // Disable the cookie cache: membership and the current session are read on every invocation.
      const session = await auth.api.getSession({ headers, query: { disableCookieCache: true } });
      if (!session)
        throw Object.assign(new Error("Sign in to continue."), {
          status: 401,
          code: "auth_required",
        });
      await requireMember(session.user.id);
      return { actorId: session.user.id, customerId: input.organizationId };
    },
    grant(token: string, kind: "work_session" | "canvas") {
      return requireGrantContext(
        { token, kind, appId: input.appId },
        {
          database: input.database,
          issuer: agentGrantIssuer(input.origin),
          singleOrganization: { id: input.organizationId, appId: input.appId },
        },
      );
    },
  };
}
