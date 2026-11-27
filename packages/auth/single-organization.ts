import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { organization } from "better-auth/plugins";
import type { Pool, PoolClient } from "pg";
import { createAgentGrantPlugins, requireGrantContext } from "./agent-grant";
import { agentGrantIssuer } from "./agent-grant-policy";
import { canvasFrameOrigins, readCanvasFrameOrigins } from "./canvas-frame";
import { emptySetAdapter } from "./empty-set-adapter";

type WrappedAuthClientEntry = {
  proxy: PoolClient;
  reset: () => void;
};

function stripLeadingSqlComments(sql: string): string {
  return sql.replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/gu, "");
}

function wrapAuthClient(
  rawClient: PoolClient,
  targetSearchPath: string,
  cache: WeakMap<PoolClient, WrappedAuthClientEntry>,
): PoolClient {
  let existing = cache.get(rawClient);
  if (!existing) {
    let inTx = false;
    let broken = false;
    let queue: Promise<unknown> = Promise.resolve();
    const rawQuery = rawClient.query.bind(rawClient) as (...args: unknown[]) => Promise<unknown>;

    const executeScoped = async (forwardArgs: unknown[]): Promise<unknown> => {
      const first = forwardArgs[0];
      if (
        first !== null &&
        typeof first === "object" &&
        typeof (first as { submit?: unknown }).submit === "function"
      ) {
        throw new Error("Submittable cursor queries are not supported on an authSchema pool.");
      }
      const callArgs =
        forwardArgs.length === 2 && forwardArgs[1] === undefined ? [forwardArgs[0]] : forwardArgs;
      const sqlText =
        typeof first === "string"
          ? first
          : first !== null &&
              typeof first === "object" &&
              typeof (first as { text?: unknown }).text === "string"
            ? (first as { text: string }).text
            : "";
      const stripped = stripLeadingSqlComments(sqlText);
      const isBegin = /^(?:begin|start\s+transaction)\b/iu.test(stripped);
      const isCommitOrEnd = /^(?:commit|end)\b/iu.test(stripped);
      const isFullRollback = /^rollback\b/iu.test(stripped) && !/^rollback\s+to\b/iu.test(stripped);

      if (isBegin) {
        const res = await rawQuery(...callArgs);
        inTx = true;
        try {
          await rawQuery("select pg_catalog.set_config('search_path', $1, true)", [
            targetSearchPath,
          ]);
        } catch (err) {
          inTx = false;
          await rawQuery("rollback").catch(() => {
            broken = true;
          });
          throw err;
        }
        return res;
      }

      if (inTx) {
        if (isCommitOrEnd || isFullRollback) {
          inTx = false;
        }
        return await rawQuery(...callArgs);
      }

      if (isCommitOrEnd || isFullRollback) {
        return await rawQuery(...callArgs);
      }

      await rawQuery("begin");
      try {
        await rawQuery("select pg_catalog.set_config('search_path', $1, true)", [targetSearchPath]);
        const res = await rawQuery(...callArgs);
        await rawQuery("commit");
        return res;
      } catch (err) {
        try {
          await rawQuery("rollback");
        } catch {
          broken = true;
        }
        throw err;
      }
    };

    const query = (...args: unknown[]) => {
      const last = args[args.length - 1];
      const callback =
        typeof last === "function" &&
        !(args.length === 1 && typeof (last as { submit?: unknown }).submit === "function")
          ? (last as (err: Error | undefined, result?: unknown) => void)
          : undefined;
      const forwardArgs = callback ? args.slice(0, -1) : args;
      const run = queue.then(
        () => executeScoped(forwardArgs),
        () => executeScoped(forwardArgs),
      );
      queue = run.then(
        () => undefined,
        () => undefined,
      );
      if (callback) {
        run.then(
          (res) => callback(undefined, res),
          (err) => callback(err as Error),
        );
        return undefined;
      }
      return run;
    };

    const release = (err?: boolean | Error) => {
      const discard = err ?? (inTx || broken ? true : undefined);
      inTx = false;
      broken = false;
      rawClient.release(discard);
    };

    const proxy = new Proxy(rawClient, {
      get(target, prop) {
        if (prop === "query") return query;
        if (prop === "release") return release;
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    existing = {
      proxy,
      reset: () => {
        inTx = false;
        broken = false;
      },
    };
    cache.set(rawClient, existing);
  } else {
    existing.reset();
  }
  return existing.proxy;
}

function bindPoolToAuthSchema(pool: Pool, authSchema: string | undefined): Pool {
  if (authSchema === undefined) return pool;
  const existing = (pool as { configuredSearchPath?: string }).configuredSearchPath;
  if (existing !== undefined) {
    if (existing !== authSchema) {
      throw new Error(
        `Database pool searchPath ('${existing}') disagrees with authSchema ('${authSchema}').`,
      );
    }
    return pool;
  }
  const wrappedClients = new WeakMap<PoolClient, WrappedAuthClientEntry>();
  const targetSearchPath = `${authSchema}, pg_catalog`;
  const acquire = async (): Promise<PoolClient> => {
    const client = await pool.connect();
    return wrapAuthClient(client, targetSearchPath, wrappedClients);
  };
  const connect = (
    callback?: (
      err: Error | undefined,
      client: PoolClient | undefined,
      done: (release?: unknown) => void,
    ) => void,
  ): Promise<PoolClient> | void => {
    if (callback) {
      acquire().then(
        (client) =>
          callback(undefined, client, (release) =>
            client.release(release as boolean | Error | undefined),
          ),
        (err) => callback(err as Error, undefined, () => {}),
      );
      return;
    }
    return acquire();
  };
  const query = (...args: unknown[]) => {
    const last = args[args.length - 1];
    const callback =
      typeof last === "function" &&
      !(args.length === 1 && typeof (last as { submit?: unknown }).submit === "function")
        ? (last as (err: Error | undefined, result?: unknown) => void)
        : undefined;
    const forwardArgs = callback ? args.slice(0, -1) : args;
    const run = (async () => {
      const client = await acquire();
      let releaseErr: Error | boolean | undefined;
      const onError = (err: Error) => {
        releaseErr = err;
      };
      client.on("error", onError);
      try {
        return await (client.query as (...a: unknown[]) => Promise<unknown>)(...forwardArgs);
      } finally {
        client.removeListener("error", onError);
        client.release(releaseErr);
      }
    })();
    if (callback) {
      run.then(
        (res) => callback(undefined, res),
        (err) => callback(err as Error),
      );
      return undefined;
    }
    return run;
  };
  return new Proxy(pool, {
    get(target, prop) {
      if (prop === "configuredSearchPath") return authSchema;
      if (prop === "connect") return connect;
      if (prop === "query") return query;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** One deployment, one organization; OAuth consent remains separate from human sign-in. */
export function createSingleOrganizationAuth(input: {
  database: Pool;
  /** Optional PostgreSQL schema owning this app's Better Auth tables (e.g. auth_crm). */
  authSchema?: string;
  origin: string;
  secret: string;
  appId: string;
  organizationId: string;
  name: string;
  allowSignUp: boolean;
}) {
  if (
    input.authSchema !== undefined &&
    !/^(?:public|auth_[a-z0-9_]{1,57})$/.test(input.authSchema)
  ) {
    throw new Error(
      "Auth schema must be 'public' or an 'auth_<app>' identifier (lowercase alphanumeric/underscore).",
    );
  }
  const database = bindPoolToAuthSchema(input.database, input.authSchema);
  const origin = new URL(input.origin);
  if (origin.origin !== input.origin || !["http:", "https:"].includes(origin.protocol))
    throw new Error("Auth origin must be an exact HTTP(S) origin.");
  if (input.secret.length < 32) throw new Error("Auth secret must contain at least 32 characters.");
  const auth = betterAuth({
    appName: input.name,
    baseURL: input.origin,
    database,
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
            await database.query(
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
        database,
        publicOrigin: input.origin,
        appIds: [input.appId],
        singleOrganizationId: input.organizationId,
      }),
      nextCookies(),
    ],
  });
  const requireMember = async (actorId: string) => {
    const result = await database.query(
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
          database,
          issuer: agentGrantIssuer(input.origin),
          singleOrganization: { id: input.organizationId, appId: input.appId },
        },
      );
    },
  };
}
