import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { organization } from "better-auth/plugins";
import type { Pool } from "pg";
import { createAgentGrantPlugins, requireGrantContext } from "./agent-grant";
import { agentGrantIssuer } from "./agent-grant-policy";
import { canvasFrameOrigins, readCanvasFrameOrigins } from "./canvas-frame";
import { emptySetAdapter } from "./empty-set-adapter";

/** One deployment, one organization; OAuth consent remains separate from human sign-in. */
export function createSingleOrganizationAuth(input: {
  database: Pool;
  origin: string;
  secret: string;
  appId: string;
  organizationId: string;
  name: string;
  allowSignUp: boolean;
}) {
  const origin = new URL(input.origin);
  if (origin.origin !== input.origin || !["http:", "https:"].includes(origin.protocol))
    throw new Error("Auth origin must be an exact HTTP(S) origin.");
  if (input.secret.length < 32) throw new Error("Auth secret must contain at least 32 characters.");
  const auth = betterAuth({
    appName: input.name,
    baseURL: input.origin,
    database: input.database,
    secret: input.secret,
    trustedOrigins: [
      input.origin,
      ...canvasFrameOrigins({
        publicOrigin: input.origin,
        appIds: [input.appId],
        configured: readCanvasFrameOrigins(),
      }),
    ],
    emailAndPassword: { enabled: true, disableSignUp: !input.allowSignUp },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            // One statement creates the deployment organization on the first signup;
            // concurrent signups join the same row. No browser-supplied scope is accepted.
            await input.database.query(
              `with deployment as (
             insert into "organization" ("id", "name", "slug", "createdAt")
             values ($1, $2, $1, now()) on conflict ("id") do update set "id" = excluded."id"
             returning "id")
           insert into "member" ("id", "organizationId", "userId", "role", "createdAt")
           select $3, "id", $4, 'member', now() from deployment`,
              [input.organizationId, input.name, randomUUID(), user.id],
            );
          },
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
        database: input.database,
        publicOrigin: input.origin,
        appIds: [input.appId],
        singleOrganizationId: input.organizationId,
      }),
      nextCookies(),
    ],
  });
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
