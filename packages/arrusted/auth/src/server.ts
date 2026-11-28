import { randomBytes, randomUUID } from "node:crypto";
import { bindPoolToSearchPath, validSearchPath } from "@arrusted/core/pool";
import { betterAuth, type BetterAuthPlugin, type DBAdapter } from "better-auth";
import { hashPassword } from "better-auth/crypto";
import { nextCookies, toNextJsHandler } from "better-auth/next-js";
import { organization } from "better-auth/plugins";
import type { Pool } from "pg";

export { toNextJsHandler };

function emptySetAdapter(): BetterAuthPlugin {
  return {
    id: "empty-set-adapter",
    init(context) {
      const findMany = context.adapter.findMany.bind(context.adapter);
      context.adapter.findMany = async <T>(
        input: Parameters<DBAdapter["findMany"]>[0],
      ): Promise<T[]> => {
        const predicate = input.where?.[0];
        if (
          input.where?.length === 1 &&
          predicate?.operator === "in" &&
          Array.isArray(predicate.value) &&
          predicate.value.length === 0
        ) {
          return [];
        }
        return findMany<T>(input);
      };
    },
  };
}

export type AppAuthConfig = {
  database: Pool;
  /** Optional PostgreSQL schema owning this app's Better Auth tables (e.g. auth_crm). */
  authSchema?: string;
  origin: string;
  secret: string;
  appId: string;
  organizationId: string;
  name: string;
  /** Closed by default (false) so deployments stay invite/CLI-only unless opted in. */
  allowSignUp?: boolean;
};

export function createAppAuth(input: AppAuthConfig) {
  if (input.authSchema !== undefined && !validSearchPath.test(input.authSchema)) {
    throw new Error(
      "Auth schema must be 'public' or an 'auth_<app>' identifier (lowercase alphanumeric/underscore).",
    );
  }
  const database = bindPoolToSearchPath(input.database, input.authSchema);
  const origin = new URL(input.origin);
  if (origin.origin !== input.origin || !["http:", "https:"].includes(origin.protocol)) {
    throw new Error("Auth origin must be an exact HTTP(S) origin.");
  }
  if (input.secret.length < 32) {
    throw new Error("Auth secret must contain at least 32 characters.");
  }
  const allowSignUp = input.allowSignUp ?? false;

  const auth = betterAuth({
    appName: input.name,
    baseURL: input.origin,
    database,
    secret: input.secret,
    trustedOrigins: [input.origin],
    emailAndPassword: { enabled: true, disableSignUp: !allowSignUp },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await database.query(
              `with deployment as (
                 insert into "organization" ("id", "name", "slug", "createdAt")
                 values ($1, $2, $1, now()) on conflict ("id") do update set "id" = excluded."id"
                 returning "id")
               insert into "member" ("id", "organizationId", "userId", "role", "createdAt")
               select $3, "id", $4, 'member', now() from deployment
               on conflict do nothing`,
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
      nextCookies(),
    ],
  });

  const requireMember = async (actorId: string) => {
    const result = await database.query(
      `select "id" from "member" where "userId" = $1 and "organizationId" = $2 limit 1`,
      [actorId, input.organizationId],
    );
    if (result.rows.length !== 1) {
      throw Object.assign(new Error("An active membership is required."), {
        status: 403,
        code: "app_access_required",
      });
    }
  };

  return {
    auth,
    allowSignUp,
    requireMember,
    async session(headers: Headers) {
      const session = await auth.api.getSession({ headers, query: { disableCookieCache: true } });
      if (!session) {
        throw Object.assign(new Error("Sign in to continue."), {
          status: 401,
          code: "auth_required",
        });
      }
      await requireMember(session.user.id);
      return { actorId: session.user.id, customerId: input.organizationId };
    },
  };
}

export const createSingleOrganizationAuth = createAppAuth;

export type AddPersonInput = {
  database: Pool;
  authSchema?: string;
  organizationId: string;
  organizationName?: string;
  email: string;
  name?: string;
  password?: string;
  onGeneratedPassword?: (password: string, email: string) => void | Promise<void>;
};

export type AddPersonResult = {
  userId: string;
  email: string;
  organizationId: string;
  generatedPassword?: string;
};

export async function addPerson(input: AddPersonInput): Promise<AddPersonResult> {
  if (input.authSchema !== undefined && !validSearchPath.test(input.authSchema)) {
    throw new Error(
      "Auth schema must be 'public' or an 'auth_<app>' identifier (lowercase alphanumeric/underscore).",
    );
  }
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new Error(`Invalid email address: ${input.email}`);
  }
  const organizationId = input.organizationId.trim();
  if (!organizationId) {
    throw new Error("organizationId is required.");
  }
  if (input.password !== undefined && input.password.length < 8) {
    throw new Error("Password must contain at least 8 characters.");
  }
  if (input.password !== undefined && input.password.length > 128) {
    throw new Error("Password must contain at most 128 characters.");
  }
  const explicitName = input.name?.trim();
  const displayName = explicitName || email.split("@")[0]!;
  const orgName = input.organizationName?.trim() || organizationId;

  const database = bindPoolToSearchPath(input.database, input.authSchema);
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const userRes = await client.query<{ id: string }>(
      `insert into "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
       values ($1, $2, $3, true, now(), now())
       on conflict ("email") do update
         set "name" = case when $4::boolean then excluded."name" else "user"."name" end,
             "updatedAt" = now()
       returning "id"`,
      [randomUUID(), displayName, email, Boolean(explicitName)],
    );
    const userId = userRes.rows[0]!.id;

    let generatedPassword: string | undefined;
    const existingAccount = await client.query<{ id: string }>(
      `select "id" from "account" where "userId" = $1 and "providerId" = 'credential' limit 1`,
      [userId],
    );
    if (existingAccount.rows.length > 0) {
      if (input.password !== undefined) {
        const passwordHash = await hashPassword(input.password);
        await client.query(
          `update "account" set "password" = $1, "updatedAt" = now() where "id" = $2`,
          [passwordHash, existingAccount.rows[0]!.id],
        );
      }
    } else {
      generatedPassword =
        input.password === undefined ? randomBytes(18).toString("base64url") : undefined;
      const passwordHash = await hashPassword(input.password ?? generatedPassword!);
      await client.query(
        `insert into "account" ("id", "accountId", "providerId", "userId", "password", "createdAt", "updatedAt")
         values ($1, $2, 'credential', $2, $3, now(), now())`,
        [randomUUID(), userId, passwordHash],
      );
    }

    await client.query(
      `insert into "organization" ("id", "name", "slug", "createdAt")
       values ($1, $2, $1, now())
       on conflict ("id") do nothing`,
      [organizationId, orgName],
    );

    const existingMember = await client.query<{ id: string }>(
      `select "id" from "member" where "organizationId" = $1 and "userId" = $2 limit 1`,
      [organizationId, userId],
    );
    if (existingMember.rows.length === 0) {
      await client.query(
        `insert into "member" ("id", "organizationId", "userId", "role", "createdAt")
         values ($1, $2, $3, 'member', now())`,
        [randomUUID(), organizationId, userId],
      );
    }

    if (generatedPassword !== undefined) {
      await input.onGeneratedPassword?.(generatedPassword, email);
    }

    await client.query("COMMIT");
    return {
      userId,
      email,
      organizationId,
      ...(generatedPassword ? { generatedPassword } : {}),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export type RemovePersonInput = {
  database: Pool;
  authSchema?: string;
  organizationId: string;
  email: string;
};

export async function removePerson(
  input: RemovePersonInput,
): Promise<{ removed: boolean; userId?: string }> {
  if (input.authSchema !== undefined && !validSearchPath.test(input.authSchema)) {
    throw new Error(
      "Auth schema must be 'public' or an 'auth_<app>' identifier (lowercase alphanumeric/underscore).",
    );
  }
  const email = input.email.trim().toLowerCase();
  const organizationId = input.organizationId.trim();
  if (!organizationId) {
    throw new Error("organizationId is required.");
  }

  const database = bindPoolToSearchPath(input.database, input.authSchema);
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const userRes = await client.query<{ id: string }>(
      `select "id" from "user" where lower("email") = $1 limit 1`,
      [email],
    );
    const userId = userRes.rows[0]?.id;
    if (!userId) {
      await client.query("COMMIT");
      return { removed: false };
    }
    const deleted = await client.query(
      `delete from "member" where "userId" = $1 and "organizationId" = $2`,
      [userId, organizationId],
    );
    const removed = (deleted.rowCount ?? 0) > 0;
    if (removed) {
      await client.query(`delete from "session" where "userId" = $1`, [userId]);
    }
    await client.query("COMMIT");
    return { removed, userId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
