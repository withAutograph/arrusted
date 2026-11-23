import { generateKeyPairSync } from "node:crypto";
import { memoryAdapter } from "@better-auth/memory-adapter";
import { betterAuth } from "better-auth";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { AuthConfigurationError, readAuthEnvironment } from "../env";
import type { AuthDatabase } from "../server";
import { createAuthOptions } from "../server";
import { isProtectedPreviewRealm } from "../operator-identity-link";
import { readNormalSignedRealmIdentity } from "../operator-identity";
const resource = {
  version: 1 as const,
  environment: "preview" as const,
  hostname: "ep-owned.neon.tech",
  port: 5432,
  database: "auth_owned",
  schema: "public" as const,
  runtimeRole: "auth_runtime",
  migratorRole: "auth_migrator",
  neon: { projectId: "owned-project", branchId: "owned-branch" },
};
const origin = "https://realm-owned.vercel.app";
const config = {
  browserOrigin: origin,
  builderCallbackOrigin: "https://builder.example",
  builderCallbackPath: "/api/hosted-operator/realm-identity",
  operatorOrigin: "https://operator.example",
};
const environment = {
  AUTH_DATABASE_RESOURCE: JSON.stringify(resource),
  BETTER_AUTH_SECRET: "normal-auth-fixture-secret-long-enough",
  BETTER_AUTH_URL: origin,
  PLATFORM_PUBLIC_ORIGIN: origin,
  VERCEL_ENV: "preview",
  VERCEL_DEPLOYMENT_ID: "dpl_fixture",
  AUTH_PRODUCTION_DATABASE_IDENTITY: "ep-production.neon.tech/auth_production",
  PLATFORM_AUTH_DATABASE_URL:
    "postgresql://auth_runtime:fixture@ep-owned.neon.tech/auth_owned?sslmode=verify-full",
  PLATFORM_AUTH_TRUSTED_ORIGINS: origin,
  PLATFORM_GATEWAY_IDENTITY_KEY_ID: "existing",
  PLATFORM_GATEWAY_IDENTITY_PRIVATE_KEY: generateKeyPairSync("ed25519")
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString(),
  PLATFORM_REALM_OPERATOR_LINK_CONFIG: JSON.stringify(config),
};
describe("normal first user in an empty protected Preview Realm", () => {
  it("uses actual ordinary signup and session while creating no organization or access", async () => {
    const pool = new Pool();
    const query = vi.fn<AuthDatabase["query"]>().mockResolvedValue({ rows: [] });
    Object.defineProperty(pool, "query", { value: query });
    const options = createAuthOptions({
      appName: "Fixture",
      databaseOverride: pool,
      env: environment,
    });
    const memory = {
      user: [],
      session: [],
      account: [],
      verification: [],
      organization: [],
      member: [],
    };
    const auth = betterAuth({ ...options, database: memoryAdapter(memory) });
    try {
      const response = await auth.handler(
        new Request(`${origin}/api/auth/sign-up/email`, {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({
            email: "new-human@example.test",
            name: "Normal fixture",
            password: "normal-password-long-enough",
          }),
        }),
      );
      expect(response.status).toBe(200);
      const cookie = response.headers.get("set-cookie")?.split(";")[0];
      expect(cookie).toBeDefined();
      const headers = new Headers({ cookie: cookie!, host: new URL(origin).host, origin });
      const session = await auth.api.getSession({
        headers,
        query: { disableRefresh: true, disableCookieCache: true },
      });
      expect(session?.user.email).toBe("new-human@example.test");
      expect(memory.organization).toHaveLength(0);
      expect(memory.member).toHaveLength(0);
      expect(
        query.mock.calls.some(
          ([sql]) => typeof sql === "string" && /insert|update|delete/iu.test(sql),
        ),
      ).toBe(false);
      const context = await auth.$context;
      const identityQuery = vi.fn(async () => ({
        rows: [
          {
            actorId: session!.user.id,
            sessionId: session!.session.id,
            organizationId: null,
            expiresAt: session!.session.expiresAt.toISOString(),
            version: 1,
          },
        ],
      }));
      expect(
        await readNormalSignedRealmIdentity({
          cookieName: context.authCookies.sessionToken.name,
          secret: context.secret,
          database: { query: identityQuery },
          headers,
          organizationId: null,
        }),
      ).toMatchObject({ actorId: session!.user.id, organizationId: null });
      expect(session?.user.emailVerified).toBe(false);
    } finally {
      await pool.end();
    }
  });
  it("preserves legacy membership hook and refuses unbound protected configuration", async () => {
    const pool = new Pool();
    const query = vi.fn<AuthDatabase["query"]>().mockResolvedValue({ rows: [] });
    const legacy = {
      ...environment,
      DATABASE_URL_UNPOOLED: environment.PLATFORM_AUTH_DATABASE_URL,
      PLATFORM_REALM_OPERATOR_LINK_CONFIG: undefined,
    };
    Object.defineProperty(pool, "query", { value: query });
    const options = createAuthOptions({ appName: "Fixture", databaseOverride: pool, env: legacy });
    try {
      await expect(options.databaseHooks.user.create.after({ id: "legacy-user" })).rejects.toThrow(
        "server-owned all-app signup organization",
      );
      expect(query).toHaveBeenCalledOnce();
      expect(() =>
        isProtectedPreviewRealm({ baseUrl: origin, environment, resource: undefined }),
      ).toThrow();
      expect(() =>
        isProtectedPreviewRealm({
          baseUrl: origin,
          environment: {
            ...environment,
            PLATFORM_AUTH_TRUSTED_ORIGINS: "https://unrelated.example",
          },
          resource,
        }),
      ).toThrow();
    } finally {
      await pool.end();
    }
  });
  it("retains the existing legacy all-apps membership when that profile is provisioned", async () => {
    const pool = new Pool();
    const query = vi
      .fn<AuthDatabase["query"]>()
      .mockResolvedValueOnce({
        rows: [{ id: "legacy-signup-org" }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: "legacy-member" }],
      })
      .mockResolvedValueOnce({ rows: [] });
    Object.defineProperty(pool, "query", { value: query });
    const options = createAuthOptions({
      appName: "Fixture",
      databaseOverride: pool,
      env: {
        ...environment,
        DATABASE_URL_UNPOOLED: environment.PLATFORM_AUTH_DATABASE_URL,
        PLATFORM_REALM_OPERATOR_LINK_CONFIG: undefined,
      },
    });
    try {
      await options.databaseHooks.user.create.after({ id: "legacy-user" });
      expect(query).toHaveBeenCalledTimes(3);
      expect(query.mock.calls[1]?.[1]).toEqual([
        "legacy-signup-org:legacy-user:owner",
        "legacy-signup-org",
        "legacy-user",
      ]);
    } finally {
      await pool.end();
    }
  });
});

it("accepts the existing normalized trailing-slash origin while preserving exact native enrollment", () => {
  expect(
    isProtectedPreviewRealm({
      baseUrl: `${origin}/`,
      environment: { ...environment, BETTER_AUTH_URL: `${origin}/` },
      resource,
    }),
  ).toBe(true);
  expect(readAuthEnvironment({ ...environment, BETTER_AUTH_URL: `${origin}/` }).baseUrl).toBe(
    origin,
  );
});
it.each([
  { PLATFORM_REALM_OPERATOR_LINK_CONFIG: "not-json" },
  { PLATFORM_REALM_OPERATOR_LINK_CONFIG: "{}" },
  { PLATFORM_GATEWAY_IDENTITY_PRIVATE_KEY: "not-a-native-key" },
])(
  "reports malformed enrolled configuration through the established Auth error boundary %j",
  (change) => {
    expect(() => readAuthEnvironment({ ...environment, ...change })).toThrow(
      AuthConfigurationError,
    );
    expect(() => readAuthEnvironment({ ...environment, ...change })).toThrow(
      "Protected Preview Realm enrollment configuration is invalid",
    );
  },
);
