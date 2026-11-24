import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { APIError, createAuthMiddleware } from "better-auth/api";
import type { Pool, PoolClient } from "pg";
import { errorMessage, redact } from "./redact";

export const proofHash = (secret: string) => createHash("sha256").update(secret).digest("hex");
const denied = (message = "A valid setup or invitation link is required.") =>
  new APIError("FORBIDDEN", { message });

const MAX_SIGNUP_BODY_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;

function sanitizeDbError(error: unknown, env: Record<string, string | undefined>): Error {
  const rawMessage =
    error instanceof Error
      ? error.message
      : error &&
          typeof error === "object" &&
          "message" in error &&
          typeof error.message === "string"
        ? error.message
        : errorMessage(error);
  const clean = new Error(redact(rawMessage, env));
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string")
    (clean as Error & { code?: string }).code = error.code;
  return clean;
}

function wrapClient(
  client: PoolClient,
  getSecrets: () => Record<string, string | undefined>,
  nestedTransactions: boolean,
): PoolClient {
  return new Proxy(client, {
    get(c, p) {
      if (p === "query")
        return (sql: string | { text?: string }, ...args: unknown[]) => {
          const text =
            typeof sql === "string"
              ? sql
              : sql && typeof sql === "object" && "text" in sql && typeof sql.text === "string"
                ? sql.text
                : "";
          const nested = nestedTransactions
            ? /^begin(?: transaction)?$/i.test(text)
              ? "savepoint better_auth_signup"
              : /^commit$/i.test(text)
                ? "release savepoint better_auth_signup"
                : /^rollback$/i.test(text)
                  ? "rollback to savepoint better_auth_signup"
                  : undefined
            : undefined;
          const last = args[args.length - 1];
          if (typeof last === "function") {
            const cb = last as (err: unknown, res?: unknown) => void;
            const wrappedArgs = [
              ...args.slice(0, -1),
              (err: unknown, res: unknown) =>
                cb(err ? sanitizeDbError(err, getSecrets()) : err, res),
            ];
            return (c.query as Function).call(c, nested ?? sql, ...wrappedArgs);
          }
          try {
            const result = (c.query as Function).call(c, nested ?? sql, ...args);
            if (result && typeof (result as PromiseLike<unknown>).then === "function")
              return (result as Promise<unknown>).catch((error: unknown) => {
                throw sanitizeDbError(error, getSecrets());
              });
            return result;
          } catch (error) {
            throw sanitizeDbError(error, getSecrets());
          }
        };
      if (nestedTransactions && p === "release") return () => {};
      const value = Reflect.get(c, p);
      return typeof value === "function" ? value.bind(c) : value;
    },
  });
}

/** One transaction spans Better Auth's user, account, session and membership writes.
 * Direct internal API signup calls fail closed: admission requires this request scope.
 */
export function singleOrganizationAdmission(input: {
  database: Pool;
  organizationId: string;
  name: string;
  origin?: string;
  allowSignUp?: boolean;
  ownerSetupHash?: string;
  redactEnv?: () => Record<string, string | undefined>;
  bodyTimeoutMs?: number;
  connectTimeoutMs?: number;
}) {
  const scope = new AsyncLocalStorage<{
    client: PoolClient;
    rawClient: PoolClient;
    role?: string;
    released: boolean;
    secrets: () => Record<string, string | undefined>;
  }>();
  const redactEnv = input.redactEnv ?? (() => process.env);
  const activeScope = () => {
    const current = scope.getStore();
    return current && !current.released ? current : undefined;
  };
  const activeSecrets = () => activeScope()?.secrets() ?? redactEnv();
  const bodyTimeoutMs = input.bodyTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const connectTimeoutMs = input.connectTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const database = new Proxy(input.database, {
    get(target, property) {
      const current = activeScope();
      if (current && property === "connect")
        return async () => wrapClient(current.rawClient, current.secrets, true);
      if (current && property === "query") return current.client.query;
      if (property === "connect")
        return (...args: unknown[]) => {
          const last = args[args.length - 1];
          if (typeof last === "function") {
            const cb = last as (err: unknown, c?: PoolClient, done?: unknown) => void;
            return (target.connect as Function).call(
              target,
              ...args.slice(0, -1),
              (err: unknown, c?: PoolClient, done?: unknown) =>
                cb(
                  err ? sanitizeDbError(err, activeSecrets()) : err,
                  c ? wrapClient(c, activeSecrets, false) : c,
                  done,
                ),
            );
          }
          try {
            return (target.connect as Function).apply(target, args).then(
              (c: PoolClient) => wrapClient(c, activeSecrets, false),
              (error: unknown) => {
                throw sanitizeDbError(error, activeSecrets());
              },
            );
          } catch (error) {
            throw sanitizeDbError(error, activeSecrets());
          }
        };
      if (property === "query")
        return (...args: unknown[]) => {
          const last = args[args.length - 1];
          if (typeof last === "function") {
            const cb = last as (err: unknown, res?: unknown) => void;
            return (target.query as Function).call(
              target,
              ...args.slice(0, -1),
              (err: unknown, res: unknown) =>
                cb(err ? sanitizeDbError(err, activeSecrets()) : err, res),
            );
          }
          try {
            const result = (target.query as Function).apply(target, args);
            if (result && typeof (result as PromiseLike<unknown>).then === "function")
              return (result as Promise<unknown>).catch((error: unknown) => {
                throw sanitizeDbError(error, activeSecrets());
              });
            return result;
          } catch (error) {
            throw sanitizeDbError(error, activeSecrets());
          }
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    database,
    activeSecrets,
    before: createAuthMiddleware(async (ctx) => {
      // This deployment uses its own bounded membership UI. Block ALL plugin routes,
      // including reads of invitation IDs and optional future mutation endpoints.
      // AgentGrantPage uses /agent-grant/* and /oauth2/*, never /organization/*.
      if (ctx.path?.startsWith("/organization/"))
        throw denied("Use the deployment's Members page.");
      if (ctx.path !== "/sign-up/email") return;
      const current = activeScope();
      if (!current) throw denied();
      const client = current.client;
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        `signup:${input.organizationId}`,
      ]);
      const members = await client.query('select 1 from member where "organizationId"=$1 limit 1', [
        input.organizationId,
      ]);
      const setup = ctx.headers?.get("x-owner-setup") ?? "";
      const invite = ctx.headers?.get("x-invitation") ?? "";
      if (!members.rowCount) {
        const used = await client.query(
          `select 1 from organization
           where id=$1 and metadata is not null and btrim(metadata) like '{%'
             and metadata::jsonb @> $2::jsonb`,
          [input.organizationId, '{"ownerSetupComplete":true}'],
        );
        if (used.rowCount)
          throw denied(
            "Owner setup has already been completed. Restore an existing membership locally.",
          );
        if (!input.ownerSetupHash || !/^[a-f0-9]{64}$/.test(input.ownerSetupHash))
          throw denied(
            "Owner setup is not configured. Run owner:setup and configure APP_OWNER_SETUP_HASH.",
          );
        if (
          !timingSafeEqual(
            Buffer.from(proofHash(setup), "hex"),
            Buffer.from(input.ownerSetupHash, "hex"),
          )
        )
          throw denied();
        current.role = "owner";
      } else {
        if (setup) throw denied("Owner setup has already been completed.");
        if (invite) {
          const result = await client.query(
            `update invitation set status='accepted'
            where id=$1 and "organizationId"=$2 and lower(email)=$3 and status='pending'
            and "expiresAt">now() returning id`,
            [
              proofHash(invite),
              input.organizationId,
              String(ctx.body?.email ?? "")
                .trim()
                .toLowerCase(),
            ],
          );
          if (!result.rowCount)
            throw denied(
              "This invitation is invalid, expired, revoked, used, or for another email.",
            );
        } else if (input.allowSignUp !== true) throw denied();
        current.role = "member";
      }
    }),
    async member(user: { id: string }) {
      const current = activeScope();
      if (!current?.role) throw denied();
      await current.client.query(
        `with deployment as (
        insert into organization (id,name,slug,"createdAt") values ($1,$2,$1,now())
        on conflict (id) do update set id=excluded.id returning id)
        insert into member (id,"organizationId","userId",role,"createdAt")
        select $3,id,$4,$5,now() from deployment`,
        [input.organizationId, input.name, randomBytes(24).toString("hex"), user.id, current.role],
      );
      if (current.role === "owner")
        await current.client.query(
          `update organization
           set metadata=(coalesce(nullif(btrim(metadata), '')::jsonb, '{}'::jsonb) || $2::jsonb)::text
           where id=$1`,
          [input.organizationId, '{"ownerSetupComplete":true}'],
        );
    },
    async handle(request: Request, handler: (request: Request) => Promise<Response>) {
      if (new URL(request.url).pathname !== "/api/auth/sign-up/email") return handler(request);
      if (request.method !== "POST")
        return Response.json({ message: "Use POST." }, { status: 405 });
      if (
        !input.allowSignUp &&
        !request.headers.get("x-owner-setup") &&
        !request.headers.get("x-invitation")
      )
        return Response.json(
          { message: "A valid setup or invitation link is required." },
          { status: 403 },
        );
      if (
        request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/json"
      )
        return Response.json({ message: "Use application/json." }, { status: 415 });
      // Bound both bytes and time BEFORE acquiring a pooled connection.
      const reader = request.body?.getReader();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let body: string;
      try {
        body = await Promise.race([
          (async () => {
            const chunks: Uint8Array[] = [];
            let size = 0;
            while (reader) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > MAX_SIGNUP_BODY_BYTES)
                throw Object.assign(new Error("Body exceeds 16 KB."), { status: 413 });
              chunks.push(value);
            }
            const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
              throw Object.assign(new Error("JSON object required."), { status: 400 });
            // Better Auth must return JSON, never a form redirect that looks successful.
            const normalized = { ...(parsed as Record<string, unknown>) };
            delete normalized.callbackURL;
            return JSON.stringify(normalized);
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(Object.assign(new Error("Body timed out."), { status: 408 })),
              bodyTimeoutMs,
            );
          }),
        ]);
      } catch (error) {
        void reader?.cancel().catch(() => {});
        const status =
          error &&
          typeof error === "object" &&
          "status" in error &&
          typeof error.status === "number"
            ? error.status
            : 400;
        const message =
          status === 413
            ? "Request body exceeds 16 KB."
            : status === 408
              ? "Request body timed out."
              : "Invalid JSON body.";
        return Response.json({ message }, { status });
      } finally {
        clearTimeout(timer);
      }
      const headers = new Headers(request.headers);
      headers.set("accept", "application/json");
      headers.delete("content-length");
      request = new Request(request.url, { method: "POST", headers, body });
      const requestSecrets = () => ({
        ...redactEnv(),
        SIGNUP_SETUP_TOKEN: request.headers.get("x-owner-setup") ?? undefined,
        SIGNUP_INVITE_TOKEN: request.headers.get("x-invitation") ?? undefined,
      });
      let client: PoolClient | undefined;
      let store:
        | {
            client: PoolClient;
            rawClient: PoolClient;
            role?: string;
            released: boolean;
            secrets: () => Record<string, string | undefined>;
          }
        | undefined;
      let acquireTimer: ReturnType<typeof setTimeout> | undefined;
      let expired = false;
      try {
        const pendingConnect = input.database.connect().then(
          (connection) => {
            if (expired) {
              connection.release();
              return undefined;
            }
            return connection;
          },
          (error) => {
            if (expired) return undefined;
            throw error;
          },
        );
        client = await Promise.race([
          pendingConnect.then((connection) => {
            if (!connection) throw new Error("Connection acquisition timed out.");
            return connection;
          }),
          new Promise<never>((_, reject) => {
            acquireTimer = setTimeout(() => {
              expired = true;
              reject(new Error("Connection acquisition timed out."));
            }, connectTimeoutMs);
          }),
        ]);
        clearTimeout(acquireTimer);
        await client.query("begin");
        const safeClient = wrapClient(client, requestSecrets, false);
        store = {
          client: safeClient,
          rawClient: client,
          released: false,
          secrets: requestSecrets,
        };
        const response = await scope.run(store, () => handler(request));
        const result = response.headers.get("content-type")?.includes("application/json")
          ? await response
              .clone()
              .json()
              .catch(() => null)
          : null;
        const success =
          response.status >= 200 &&
          response.status < 300 &&
          typeof result?.user?.id === "string" &&
          typeof result?.token === "string";
        await client.query(success ? "commit" : "rollback");
        store.released = true;
        if (response.status >= 500)
          console.error(
            redact(`Sign-up failed: ${result?.message ?? response.status}`, requestSecrets()),
          );
        if (!success && response.status < 400)
          return Response.json({ message: "Account creation did not complete." }, { status: 500 });
        return response;
      } catch (error) {
        await client?.query("rollback").catch(() => {});
        console.error(redact(`Sign-up failed: ${errorMessage(error)}`, requestSecrets()));
        return Response.json(
          { message: "Account creation failed. Please retry." },
          { status: 500 },
        );
      } finally {
        clearTimeout(acquireTimer);
        if (store) store.released = true;
        client?.release();
      }
    },
    /** Attach membership to an existing memberless user who authenticated with their own password. */
    async acceptInvitation(
      request: Request,
      getSession: () => Promise<{ user: { id: string } } | null>,
    ) {
      if (request.method !== "POST")
        return Response.json({ message: "Use POST." }, { status: 405 });
      const reqOrigin = request.headers.get("origin");
      if (reqOrigin && input.origin && reqOrigin !== input.origin)
        return Response.json({ message: "Invalid origin." }, { status: 403 });
      const invite = request.headers.get("x-invitation")?.trim() ?? "";
      if (!invite)
        return Response.json({ message: "A valid invitation link is required." }, { status: 403 });
      const session = await getSession();
      if (!session) return Response.json({ message: "Sign in to continue." }, { status: 401 });
      const requestSecrets = () => ({
        ...redactEnv(),
        SIGNUP_INVITE_TOKEN: invite,
      });
      let client: PoolClient | undefined;
      let acquireTimer: ReturnType<typeof setTimeout> | undefined;
      let expired = false;
      try {
        const pendingConnect = input.database.connect().then(
          (connection) => {
            if (expired) {
              connection.release();
              return undefined;
            }
            return connection;
          },
          (error) => {
            if (expired) return undefined;
            throw error;
          },
        );
        client = await Promise.race([
          pendingConnect.then((connection) => {
            if (!connection) throw new Error("Connection acquisition timed out.");
            return connection;
          }),
          new Promise<never>((_, reject) => {
            acquireTimer = setTimeout(() => {
              expired = true;
              reject(new Error("Connection acquisition timed out."));
            }, connectTimeoutMs);
          }),
        ]);
        clearTimeout(acquireTimer);
        await client.query("begin");
        await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
          `signup:${input.organizationId}`,
        ]);
        const userRow = (
          await client.query<{ email: string }>('select email from "user" where id=$1 limit 1', [
            session.user.id,
          ])
        ).rows[0];
        if (!userRow?.email) {
          await client.query("rollback");
          return Response.json({ message: "Sign in to continue." }, { status: 401 });
        }
        const existingMember = await client.query(
          'select 1 from member where "organizationId"=$1 and "userId"=$2 limit 1',
          [input.organizationId, session.user.id],
        );
        if (existingMember.rowCount) {
          await client.query("rollback");
          return Response.json(
            { message: "You are already a member of this workspace." },
            { status: 409 },
          );
        }
        const orgExists = await client.query("select 1 from organization where id=$1 limit 1", [
          input.organizationId,
        ]);
        if (!orgExists.rowCount) {
          await client.query("rollback");
          return Response.json(
            { message: "Owner setup has not been completed yet." },
            { status: 403 },
          );
        }
        const consumed = await client.query(
          `update invitation set status='accepted'
           where id=$1 and "organizationId"=$2 and lower(email)=$3 and status='pending'
             and "expiresAt">now()
           returning id`,
          [proofHash(invite), input.organizationId, userRow.email.trim().toLowerCase()],
        );
        if (!consumed.rowCount) {
          await client.query("rollback");
          return Response.json(
            {
              message: "This invitation is invalid, expired, revoked, used, or for another email.",
            },
            { status: 403 },
          );
        }
        await client.query(
          `insert into member (id,"organizationId","userId",role,"createdAt")
           values ($1,$2,$3,'member',now())`,
          [randomBytes(24).toString("hex"), input.organizationId, session.user.id],
        );
        await client.query("commit");
        return Response.json({ ok: true });
      } catch (error) {
        await client?.query("rollback").catch(() => {});
        console.error(
          redact(`Invitation acceptance failed: ${errorMessage(error)}`, requestSecrets()),
        );
        return Response.json(
          { message: "Invitation could not be accepted. Please retry." },
          { status: 500 },
        );
      } finally {
        clearTimeout(acquireTimer);
        client?.release();
      }
    },
  };
}
