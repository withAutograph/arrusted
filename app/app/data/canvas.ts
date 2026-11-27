import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ResilientPool } from "./pool";
import { headers } from "next/headers";
import {
  createCanvasHost,
  createLegacyAgentSession,
  createLegacyCanvasPerson,
  runtimeFromDatabaseUrl,
  type CanvasDataOptions,
} from "@autograph/canvas-host/server";
import {
  createPostgresDataContext,
  type PostgresDataContext,
} from "@autograph/generated-app-runtime/postgres";
import { verifyCheckedRelease } from "@autograph/generated-app-runtime/release-verification";
import { agentBearerChallenge, agentResourceIdentifier } from "@autograph/auth/agent-grant-policy";
import { claudeFrameDomain } from "@autograph/auth/canvas-frame";
import { definition } from "../../.generated/release/data-operations";
import { appId, getIdentity, requiredEnv } from "./auth";

export { definition };
let pool: ResilientPool | undefined;
function dataPool() {
  return (pool ??= new ResilientPool({
    connectionString: requiredEnv("APP_DATABASE_URL"),
    max: 10,
  }));
}
function verifyRelease() {
  verifyCheckedRelease(
    path.resolve(process.cwd(), ".generated/release"),
    path.resolve(process.cwd(), "schema/app.cue"),
  );
}
async function currentScope() {
  const requestHeaders = await headers();
  return getIdentity().session(requestHeaders);
}
async function viewer(_options?: CanvasDataOptions) {
  return { scope: await currentScope(), roles: ["member"] };
}
async function context(readOnly: boolean) {
  const viewer = await currentScope();
  return createPostgresDataContext({
    pool: dataPool(),
    appId,
    ...viewer,
    readOnly,
    sourceKind: "human",
    verifyRelease,
    authorize: async () => {
      const current = await currentScope();
      if (current.actorId !== viewer.actorId)
        throw new Error("authorization_denied: session changed");
    },
  });
}
export async function withActionData<T>(
  run: (context: PostgresDataContext) => Promise<T>,
): Promise<T> {
  const data = await context(false);
  return data.requestTransaction(() => run(data));
}
async function tokenGrant(request: Request, kind: "work_session" | "canvas") {
  const token = request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/iu)?.[1];
  if (!token) return denied(401);
  try {
    return { token, grant: await getIdentity().grant(token, kind) };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "status" in error &&
      (error.status === 401 || error.status === 403)
    )
      return denied(error.status);
    throw error;
  }
}
function denied(status: number) {
  return Response.json(
    { error: status === 401 ? "auth_required" : "app_access_required" },
    {
      status,
      headers: {
        "cache-control": "no-store",
        ...(status === 401
          ? {
              "www-authenticate": agentBearerChallenge({
                publicOrigin: requiredEnv("BETTER_AUTH_URL"),
                appId,
              }),
            }
          : {}),
      },
    },
  );
}
export const canvas = createCanvasHost({
  appId,
  definition,
  roles: { member: "member", approver: "member" },
  data: {
    session: viewer,
    read: async (_options, run) => run({ context: await context(true) }),
    action: async (_payload, _options, run) => {
      const data = await context(false);
      return data.requestTransaction(() => run({ context: data }));
    },
    events: () => ({ runtime: runtimeFromDatabaseUrl(requiredEnv("APP_DATABASE_URL")) }),
    agent: () => ({
      kind: "legacy",
      open: async (request) => {
        const result = await tokenGrant(request, "work_session");
        if (result instanceof Response) return result;
        return createLegacyAgentSession({
          pool: dataPool(),
          appId,
          definition,
          verifyRelease,
          grant: {
            grantId: result.grant.grantId,
            actorId: result.grant.actor.actorId,
            organizationId: result.grant.organizationId,
          },
          recheck: async () => {
            await getIdentity().grant(result.token, "work_session");
          },
        });
      },
    }),
    person: async (request) => {
      const result = await tokenGrant(request, "canvas");
      if (result instanceof Response) return result;
      return createLegacyCanvasPerson({
        pool: dataPool(),
        appId,
        verifyRelease,
        grant: { actorId: result.grant.actor.actorId, organizationId: result.grant.organizationId },
        recheck: async () => {
          await getIdentity().grant(result.token, "canvas");
          return ["member"];
        },
      });
    },
    chat: async () => ({
      publicOrigin: requiredEnv("BETTER_AUTH_URL"),
      title: "Starter canvas",
      claudeDomain: claudeFrameDomain(
        agentResourceIdentifier(requiredEnv("BETTER_AUTH_URL"), appId),
      ),
      html: async () => {
        try {
          return readFileSync(
            path.resolve(process.cwd(), "../packages/canvas-host/dist/mcp-app.html"),
            "utf8",
          );
        } catch {
          return null;
        }
      },
      agGridLicenseKey: null,
      agChartsLicenseKey: null,
    }),
  },
});
