import { runInNewContext } from "node:vm";
import { memoryAdapter } from "@better-auth/memory-adapter";
import { betterAuth } from "better-auth";
import { symmetricDecrypt } from "better-auth/crypto";
import { describe, expect, it } from "vitest";

import {
  AUTH_LOCAL_HOSTS,
  AUTH_PRODUCTION_CANDIDATE_GATEWAY_HOST,
  AUTH_PRODUCTION_HOSTS,
  AUTH_VERCEL_PREVIEW_HOSTS,
  AuthConfigurationError,
  hostMatches,
  readAuthEnvironment,
  publicSignupEnabledForEnvironment,
} from "../env";
import { bearerTokenFrom } from "../agent-grant-policy";
import {
  AuthBoundaryError,
  authBoundaryErrorFromUnknown,
  createAuth as createSharedAuth,
  createAuthPool,
  initialActiveOrganizationIdForUser,
  isInfrastructureDashboardBearerMutation,
  introspectTenantScope,
  parseOrganizationAppIds,
  provisionPublicSignupMembership,
  readAgentAppIds,
  readAuthApplicationName,
  requireTenantContext,
  requireTenantScope,
  requireUser,
  requireUserOrganizationContext,
} from "../server";

const legacyMemberships = async (input: { actorId: string; organizationIds: readonly string[] }) =>
  input.organizationIds.map((organizationId) => ({
    id: `legacy:${organizationId}:${input.actorId}`,
    organizationId,
    actorId: input.actorId,
  }));

const configuredRuntimePreviewHost = AUTH_VERCEL_PREVIEW_HOSTS.find((host) =>
  host.includes("*"),
)?.replace("*", "runtime");
if (configuredRuntimePreviewHost === undefined)
  throw new Error("The native Preview fixture requires a configured Preview host");

describe("private Sandbox auth host", () => {
  it("allows only the exact configured private Sandbox origin without changing authenticated authority", () => {
    const env = readAuthEnvironment({
      PLATFORM_AUTH_DATABASE_URL: "postgres://auth@127.0.0.1/auth",
      BETTER_AUTH_URL: "https://owned-private.vercel.run",
      BETTER_AUTH_SECRET: "01234567890123456789012345678901",
    });
    expect(
      env.allowedHosts.some((pattern) => hostMatches(pattern, "owned-private.vercel.run")),
    ).toBe(true);
    expect(
      env.allowedHosts.some((pattern) => hostMatches(pattern, "other-private.vercel.run")),
    ).toBe(false);
    expect(env.allowedHosts.some((pattern) => hostMatches(pattern, "forged.example.test"))).toBe(
      false,
    );
  });

  it("allows a local runtime's exact HTTPS tunnel origin off Vercel only", () => {
    const source = {
      PLATFORM_AUTH_DATABASE_URL: "postgres://auth@127.0.0.1/auth",
      BETTER_AUTH_URL: "https://tunnel-a.trycloudflare.com",
      BETTER_AUTH_SECRET: "01234567890123456789012345678901",
    };
    const allowed = (env: Record<string, string>, host: string) =>
      readAuthEnvironment(env).allowedHosts.some((pattern) => hostMatches(pattern, host));
    expect(allowed(source, "tunnel-a.trycloudflare.com")).toBe(true);
    expect(allowed(source, "tunnel-b.trycloudflare.com")).toBe(false);
    expect(allowed({ ...source, VERCEL_ENV: "development" }, "tunnel-a.trycloudflare.com")).toBe(
      false,
    );
    expect(
      allowed(
        { ...source, BETTER_AUTH_URL: "http://tunnel-a.trycloudflare.com" },
        "tunnel-a.trycloudflare.com",
      ),
    ).toBe(false);
  });
});

describe("Better Auth Infrastructure Dashboard mutation boundary", () => {
  const request = (
    overrides: {
      authorization?: string;
      method?: string;
      pathname?: string;
    } = {},
  ) =>
    isInfrastructureDashboardBearerMutation({
      headers: new Headers(
        overrides.authorization ? { authorization: overrides.authorization } : undefined,
      ),
      method: overrides.method ?? "POST",
      pathname: overrides.pathname ?? "/api/auth/dash/create-user",
    });

  it("recognizes only exact Dashboard mutation paths with a compact bearer JWT", () => {
    expect(request({ authorization: "Bearer header.payload.signature" })).toBe(true);
    expect(
      request({
        authorization: "Bearer header.payload.signature",
        method: "GET",
      }),
    ).toBe(false);
    expect(
      request({
        authorization: "Bearer header.payload.signature",
        method: "PATCH",
      }),
    ).toBe(true);
    expect(
      request({
        authorization: "Bearer header.payload.signature",
        pathname: "/api/auth/dash-evil/create-user",
      }),
    ).toBe(false);
    expect(
      request({
        authorization: "Bearer header.payload.signature",
        pathname: "/api/auth/sign-in/email",
      }),
    ).toBe(false);
  });

  it.each([undefined, "", "Bearer", "Bearer token", "Basic header.payload.signature"])(
    "rejects a missing or malformed Dashboard bearer: %s",
    (authorization) => {
      expect(request({ authorization })).toBe(false);
    },
  );
});

const AUTH_DATABASE_URL = "postgres://auth@127.0.0.1/auth";
const AUTH_PRODUCTION_DATABASE_URL =
  "postgres://platform_auth_owner:secret@ep-production.us-east-2.aws.neon.tech/platform_auth?sslmode=require&channel_binding=require";
const AUTH_PRODUCTION_NATIVE_DATABASE_URL =
  "postgres://neondb_owner:secret@ep-production.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
const AUTH_PRODUCTION_DATABASE_IDENTITY = "ep-production.us-east-2.aws.neon.tech/platform_auth";
const AUTH_SECRET = "01234567890123456789012345678901";
const INFRASTRUCTURE_API_KEY = "better-auth-infrastructure-api-key";
const OAUTH_PROXY_SECRET = "proxy-secret-012345678901234567890";

function createAuth(
  options: Omit<Parameters<typeof createSharedAuth>[0], "appName"> & {
    appName?: string;
  },
) {
  return createSharedAuth({ appName: "Test Auth", ...options });
}

function googleAuthEnvironment(overrides: Record<string, string | undefined> = {}) {
  const production = overrides.VERCEL_ENV === "production";
  return {
    PLATFORM_AUTH_DATABASE_URL: production
      ? AUTH_PRODUCTION_DATABASE_URL
      : overrides.VERCEL_ENV === "preview"
        ? "postgres://auth:secret@ep-preview.us-east-2.aws.neon.tech/auth?sslmode=verify-full"
        : AUTH_DATABASE_URL,
    DATABASE_URL: AUTH_PRODUCTION_NATIVE_DATABASE_URL,
    DATABASE_URL_UNPOOLED:
      "postgres://neondb_owner:secret@ep-preview.us-east-2.aws.neon.tech/neondb?sslmode=require",
    AUTH_PRODUCTION_DATABASE_IDENTITY,
    VERCEL_DEPLOYMENT_ID: "dpl_preview",
    BETTER_AUTH_URL: "http://localhost:3000",
    BETTER_AUTH_SECRET: AUTH_SECRET,
    BETTER_AUTH_API_KEY: INFRASTRUCTURE_API_KEY,
    GOOGLE_CLIENT_ID: "google-client-id",
    GOOGLE_CLIENT_SECRET: "google-client-secret",
    OAUTH_PROXY_PRODUCTION_URL: "https://apps.autograph.so",
    OAUTH_PROXY_SECRET,
    ...overrides,
  };
}

async function createTestAuth(env: Record<string, string | undefined>) {
  const configuredAuth = createAuth({ appName: "Test Auth", env });
  const { database: _database, ...options } = configuredAuth.options;
  return betterAuth(options);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function previewHostFixture(): string {
  const wildcardHost = AUTH_VERCEL_PREVIEW_HOSTS.find((host) => host.includes("*"));
  if (!wildcardHost) throw new Error("Preview host policy must include a wildcard host.");
  return wildcardHost.replace("*", "feature");
}

describe("shared auth package", () => {
  it("uses the newest versioned signing secret ahead of the legacy secret during rotation", async () => {
    const current = "current-versioned-auth-secret-0123456789";
    const previous = "previous-versioned-auth-secret-01234567";
    const environment = googleAuthEnvironment({
      BETTER_AUTH_SECRETS: `2:${current},1:${previous}`,
    });
    const configured = createSharedAuth({ appName: "Rotation fixture", env: environment });
    const auth = betterAuth({ ...configured.options, database: memoryAdapter({}) });
    expect((await auth.$context).secret).toBe(current);
    expect(readAuthEnvironment(environment).secrets?.[0]?.value).toBe((await auth.$context).secret);
    expect((await auth.$context).secret).not.toBe(environment.BETTER_AUTH_SECRET);
  });
  it.each([
    ["local", {}, true],
    ["Vercel Development", { VERCEL_ENV: "development" }, true],
    ["Preview", { VERCEL_ENV: "preview" }, true],
    ["Production", { VERCEL_ENV: "production" }, false],
  ])("applies the public signup policy to %s", (_label, source, expected) => {
    expect(publicSignupEnabledForEnvironment(source)).toBe(expected);
  });

  it("provisions one server-owned all-app membership idempotently for a public signup", async () => {
    const queries: Array<{
      text: string;
      values: readonly unknown[] | undefined;
    }> = [];
    const database = {
      query: async (text: string, values?: readonly unknown[]) => {
        queries.push({ text, values });
        return text.includes('select "id"\n      from "organization"')
          ? { rows: [{ id: "dev" }] }
          : { rows: [{ id: "dev:signup-user:owner" }] };
      },
    };

    await provisionPublicSignupMembership(database, "signup-user");
    await provisionPublicSignupMembership(database, "signup-user");

    const membershipQueries = queries.filter((query) =>
      query.text.includes('insert into "member"'),
    );
    const sessionQueries = queries.filter((query) => query.text.includes('update "session"'));
    expect(membershipQueries).toHaveLength(2);
    expect(membershipQueries[0]?.values).toEqual(["dev:signup-user:owner", "dev", "signup-user"]);
    expect(membershipQueries[0]?.text).toContain('on conflict ("id") do update');
    expect(sessionQueries).toHaveLength(2);
    expect(sessionQueries[0]?.values).toEqual(["dev", "signup-user"]);
    expect(sessionQueries[0]?.text).toContain('and "activeOrganizationId" is null');
  });

  it("fails closed when the server-owned signup organization is absent or ambiguous", async () => {
    const database = {
      query: async () => ({ rows: [] }),
    };

    await expect(provisionPublicSignupMembership(database, "signup-user")).rejects.toThrow(
      AuthConfigurationError,
    );
  });

  it("accepts the sign-in form fallback as POST and rejects credentials sent with GET", async () => {
    const database: Record<string, Record<string, unknown>[]> = {
      account: [],
      session: [],
      user: [],
      verification: [],
    };
    const auth = betterAuth({
      baseURL: "http://localhost:3000",
      database: memoryAdapter(database),
      emailAndPassword: { enabled: true },
    });
    const email = "form-fallback@example.test";
    const password = "test-password";

    await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, name: "Form Fallback", password }),
      }),
    );

    const getResponse = await auth.handler(
      new Request(
        `http://localhost:3000/api/auth/sign-in/email?email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`,
      ),
    );
    const postResponse = await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "http://localhost:3000",
        },
        body: new URLSearchParams({
          callbackURL: "/",
          email,
          password,
        }),
      }),
    );

    expect(getResponse.status).toBe(404);
    expect(postResponse.status).toBe(200);
    expect(postResponse.headers.get("location")).toBe("/");
    expect(postResponse.headers.get("set-cookie")).toContain("better-auth.session_token");
  });

  it("handles idle PostgreSQL client errors without an unhandled pool error", async () => {
    const pool = createAuthPool(AUTH_DATABASE_URL);
    expect(pool.listenerCount("error")).toBeGreaterThan(0);
    await pool.end();
  });

  describe("auth boundary error narrowing", () => {
    it("accepts class instances and structurally equivalent cross-realm objects", () => {
      expect(
        authBoundaryErrorFromUnknown(
          new AuthBoundaryError("auth_required", "Authentication is required.", 401),
        ),
      ).toEqual({
        code: "auth_required",
        message: "Authentication is required.",
        status: 401,
      });

      const plainObject = runInNewContext(`({
        code: "app_access_required",
        message: "Active organization cannot access this app.",
        status: 403,
      })`);
      expect(authBoundaryErrorFromUnknown(plainObject)).toEqual({
        code: "app_access_required",
        message: "Active organization cannot access this app.",
        status: 403,
      });
    });

    it.each([
      ["unknown code", { code: "permission_denied", message: "denied", status: 403 }],
      ["non-string code", { code: 403, message: "denied", status: 403 }],
      ["unknown status", { code: "auth_required", message: "denied", status: 418 }],
      ["string status", { code: "auth_required", message: "denied", status: "401" }],
      ["non-string message", { code: "auth_required", message: null, status: 401 }],
      ["missing message", { code: "auth_required", status: 401 }],
    ])("rejects a malformed %s", (_label, value) => {
      expect(authBoundaryErrorFromUnknown(value)).toBeNull();
    });
  });

  it.each([
    ["local", { env: googleAuthEnvironment() }],
    ["Vercel Production", { env: googleAuthEnvironment({ VERCEL_ENV: "production" }) }],
    [
      "Vercel Preview",
      {
        env: googleAuthEnvironment({
          VERCEL_ENV: "preview",
          VERCEL_URL: "apps-feature-autographing.vercel.app",
        }),
      },
    ],
    ["Vercel Development", { env: googleAuthEnvironment({ VERCEL_ENV: "development" }) }],
    ["schema tooling", { env: {}, allowPlaceholderConfig: true }],
  ])("uses the Autograph application name in %s", (_label, options) => {
    const configuredAuth = createAuth({
      appName: "Autograph",
      ...options,
    });

    expect(configuredAuth.options.appName).toBe("Autograph");
  });

  it("loads the application name from generic server configuration", () => {
    expect(readAuthApplicationName({ BETTER_AUTH_APP_NAME: " Autograph " })).toBe("Autograph");
  });

  it.each([undefined, "", "   "])(
    "rejects a missing or blank application name at the constructor boundary (%s)",
    (appName) => {
      expect(() =>
        createSharedAuth({
          appName: appName as string,
          allowPlaceholderConfig: true,
          env: {},
        }),
      ).toThrow(new AuthConfigurationError(["BETTER_AUTH_APP_NAME must be configured"]));
    },
  );

  it("configures the organization app assignment as server-owned", () => {
    const configuredAuth = createAuth({
      env: googleAuthEnvironment({
        GOOGLE_CLIENT_ID: undefined,
        GOOGLE_CLIENT_SECRET: undefined,
        OAUTH_PROXY_PRODUCTION_URL: undefined,
        OAUTH_PROXY_SECRET: undefined,
      }),
    });
    const plugin = configuredAuth.options.plugins?.find(
      (candidate) => candidate.id === "organization",
    );
    const fields = plugin?.schema?.organization?.fields as
      | Record<string, { type: string; required?: boolean; input?: boolean }>
      | undefined;

    expect(fields?.appIds).toMatchObject({
      type: "json",
      required: false,
      input: false,
    });
  });

  it.each([
    ["local HTTP", "http://localhost:3000", false],
    ["deployed HTTPS", "https://apps.autograph.so", true],
  ])(
    "derives %s secure-cookie behavior from the configured auth origin",
    (_label, baseUrl, expected) => {
      const configuredAuth = createAuth({
        env: googleAuthEnvironment({
          BETTER_AUTH_URL: baseUrl,
          GOOGLE_CLIENT_ID: undefined,
          GOOGLE_CLIENT_SECRET: undefined,
          OAUTH_PROXY_PRODUCTION_URL: undefined,
          OAUTH_PROXY_SECRET: undefined,
        }),
      });

      expect(configuredAuth.options.advanced?.useSecureCookies).toBe(expected);
    },
  );

  it("preserves cross-subdomain cookie configuration with secure HTTPS cookies", () => {
    const configuredAuth = createAuth({
      env: googleAuthEnvironment({
        PLATFORM_AUTH_COOKIE_DOMAIN: ".autograph.so",
        BETTER_AUTH_URL: "https://auth.autograph.so",
        GOOGLE_CLIENT_ID: undefined,
        GOOGLE_CLIENT_SECRET: undefined,
        OAUTH_PROXY_PRODUCTION_URL: undefined,
        OAUTH_PROXY_SECRET: undefined,
      }),
    });

    expect(configuredAuth.options.advanced).toMatchObject({
      crossSubDomainCookies: {
        domain: ".autograph.so",
        enabled: true,
      },
      useSecureCookies: true,
    });
  });

  it("registers Dashboard after organization only for Vercel Production", () => {
    const configuredAuth = createAuth({
      env: googleAuthEnvironment({
        VERCEL_ENV: "production",
        VERCEL_URL: "apps-production-candidate-autographing.vercel.app",
      }),
    });
    const pluginIds = configuredAuth.options.plugins?.map((plugin) => plugin.id) ?? [];

    expect(pluginIds).toContain("dash");
    expect(pluginIds.indexOf("dash")).toBeGreaterThan(pluginIds.indexOf("organization"));
    expect(pluginIds).not.toContain("sentinel");
    expect(configuredAuth.options.baseURL).toEqual({
      allowedHosts: [...AUTH_PRODUCTION_HOSTS, "apps-production-candidate-autographing.vercel.app"],
      protocol: "auto",
    });
    expect(
      configuredAuth.options.plugins?.find((plugin) => plugin.id === "dash")?.options,
    ).not.toHaveProperty("activityTracking.enabled", true);
  });

  it.each([
    ["local", {}, AUTH_LOCAL_HOSTS],
    [
      "Preview",
      {
        VERCEL_ENV: "preview",
        VERCEL_URL: "apps-feature-autographing.vercel.app",
      },
      AUTH_VERCEL_PREVIEW_HOSTS,
    ],
  ])("omits Dashboard in %s even when an API key is present", (_label, overrides, allowedHosts) => {
    const configuredAuth = createAuth({
      env: googleAuthEnvironment(overrides),
    });

    expect(configuredAuth.options.plugins?.map((plugin) => plugin.id)).not.toContain("dash");
    expect(configuredAuth.options.baseURL).toEqual({
      allowedHosts: [...allowedHosts],
      protocol: "auto",
    });
  });

  it("does not persist appIds supplied by a client organization update", async () => {
    const configuredAuth = createAuth({
      env: googleAuthEnvironment({
        GOOGLE_CLIENT_ID: undefined,
        GOOGLE_CLIENT_SECRET: undefined,
        OAUTH_PROXY_PRODUCTION_URL: undefined,
        OAUTH_PROXY_SECRET: undefined,
      }),
    });
    const plugin = configuredAuth.options.plugins?.find(
      (candidate) => candidate.id === "organization",
    );
    if (!plugin) throw new Error("Organization plugin is required for this test.");
    const database: Record<string, Record<string, unknown>[]> = {
      account: [],
      invitation: [],
      member: [],
      organization: [],
      session: [],
      user: [],
      verification: [],
    };
    const auth = betterAuth({
      baseURL: "http://localhost:3000",
      database: memoryAdapter(database),
      emailAndPassword: { enabled: true },
      plugins: [plugin],
    });
    const signUpResponse = await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "client-update@example.test",
          name: "Client Update",
          password: "test-password",
        }),
      }),
    );
    const signUp = (await signUpResponse.json()) as { user?: { id?: string } };
    const userId = signUp.user?.id;
    const sessionCookie = signUpResponse.headers.get("set-cookie")?.split(";", 1)[0];
    if (!userId || !sessionCookie) throw new Error("Failed to create the client test session.");
    const created = await auth.api.createOrganization({
      body: {
        name: "Client Protected",
        slug: "client-protected",
        userId,
      },
    });
    if (!created) throw new Error("Failed to create the organization test fixture.");

    const response = await auth.handler(
      new Request("http://localhost:3000/api/auth/organization/update", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: sessionCookie },
        body: JSON.stringify({
          organizationId: created.id,
          data: { name: "Client Updated", appIds: ["hc"] },
        }),
      }),
    );
    const persisted = database.organization?.find((row) => row.id === created.id);

    expect(response.status).toBe(200);
    expect(persisted).toMatchObject({ name: "Client Updated" });
    expect(persisted?.appIds).not.toEqual(["hc"]);

    if (!persisted) throw new Error("Failed to read the organization test fixture.");
    persisted.appIds = ["hc"];
    const listed = await auth.api.listOrganizations({
      headers: new Headers({ cookie: sessionCookie }),
    });
    expect(listed).toEqual([expect.objectContaining({ id: created.id, appIds: ["hc"] })]);
  });

  it.each([
    ["array", ["hc", "dev"], ["hc", "dev"]],
    ["serialized array", '["hc","vendor"]', ["hc", "vendor"]],
  ])("parses a valid %s app assignment", (_label, value, expected) => {
    expect(parseOrganizationAppIds(value)).toEqual(expected);
  });

  it.each([
    ["missing", undefined],
    ["malformed JSON", '["hc"'],
    ["non-array JSON", '{"app":"hc"}'],
    ["empty array", []],
    ["empty string entry", [""]],
    ["non-string entry", ["hc", 1]],
    ["duplicate entry", ["hc", "hc"]],
    ["unknown format", ["HC App"]],
  ])("rejects a %s app assignment", (_label, value) => {
    expect(parseOrganizationAppIds(value)).toBeNull();
  });

  it("fails closed when required auth environment is missing", () => {
    expect(() => readAuthEnvironment({})).toThrow(AuthConfigurationError);
  });

  it.each([undefined, "", "   "])(
    "requires a non-blank Infrastructure API key in Vercel Production",
    (apiKey) => {
      expect(() =>
        readAuthEnvironment(
          googleAuthEnvironment({
            BETTER_AUTH_API_KEY: apiKey,
            VERCEL_ENV: "production",
          }),
        ),
      ).toThrow(/BETTER_AUTH_API_KEY is required/);
    },
  );

  it("exposes Infrastructure configuration only in Vercel Production", () => {
    expect(
      readAuthEnvironment(googleAuthEnvironment({ VERCEL_ENV: "production" })).infrastructure,
    ).toEqual({ apiKey: INFRASTRUCTURE_API_KEY });
    expect(readAuthEnvironment(googleAuthEnvironment()).infrastructure).toBeUndefined();

    const productionAuth = createAuth({
      env: googleAuthEnvironment({ VERCEL_ENV: "production" }),
    });
    expect(productionAuth.options.trustedOrigins).toContain("https://dash.better-auth.com");
  });

  it.each(["production", "preview", "development"])(
    "trusts only Vercel's client IP header in Vercel %s",
    (vercelEnvironment) => {
      const configuredAuth = createAuth({
        env: googleAuthEnvironment({
          VERCEL_ENV: vercelEnvironment,
          VERCEL_URL:
            vercelEnvironment === "preview" ? "apps-feature-autographing.vercel.app" : undefined,
        }),
      });

      expect(configuredAuth.options.advanced?.ipAddress).toEqual({
        ipAddressHeaders: ["x-vercel-forwarded-for"],
      });
    },
  );

  it.each([[undefined], ["test"], ["staging"]])(
    "does not trust forwarded IP headers outside Vercel (%s)",
    (vercelEnvironment) => {
      const configuredAuth = createAuth({
        env: googleAuthEnvironment({ VERCEL_ENV: vercelEnvironment }),
      });

      expect(configuredAuth.options.advanced?.ipAddress).toBeUndefined();
    },
  );

  it("composes Vercel client IP trust with cross-subdomain cookies", () => {
    const configuredAuth = createAuth({
      env: googleAuthEnvironment({
        PLATFORM_AUTH_COOKIE_DOMAIN: ".autograph.so",
        BETTER_AUTH_URL: "https://apps.autograph.so",
        VERCEL_ENV: "development",
      }),
    });

    expect(configuredAuth.options.advanced).toEqual({
      disableOriginCheck: false,
      crossSubDomainCookies: {
        domain: ".autograph.so",
        enabled: true,
      },
      ipAddress: {
        ipAddressHeaders: ["x-vercel-forwarded-for"],
      },
      useSecureCookies: true,
    });
  });

  it("records only the trusted Vercel client IP header on new sessions", async () => {
    const database: Record<string, Record<string, unknown>[]> = {
      account: [],
      session: [],
      user: [],
      verification: [],
    };
    const auth = betterAuth({
      advanced: {
        ipAddress: {
          ipAddressHeaders: ["x-vercel-forwarded-for"],
        },
      },
      baseURL: "http://localhost:3000",
      database: memoryAdapter(database),
      emailAndPassword: { enabled: true },
    });

    const response = await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "198.51.100.10",
          "x-vercel-forwarded-for": "203.0.113.20",
        },
        body: JSON.stringify({
          email: "trusted-ip@example.test",
          name: "Trusted IP",
          password: "test-password",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(database.session).toHaveLength(1);
    expect(database.session?.[0]?.ipAddress).toBe("203.0.113.20");
  });

  it.each([
    ["missing", {}],
    ["malformed", { "x-vercel-forwarded-for": "not-an-ip-address" }],
    ["multiple", { "x-vercel-forwarded-for": "203.0.113.20, 198.51.100.10" }],
  ])(
    "never falls back to a generic forwarded IP when the Vercel header is %s",
    async (_label, trustedHeader) => {
      const database: Record<string, Record<string, unknown>[]> = {
        account: [],
        session: [],
        user: [],
        verification: [],
      };
      const auth = betterAuth({
        advanced: {
          ipAddress: {
            ipAddressHeaders: ["x-vercel-forwarded-for"],
          },
        },
        baseURL: "http://localhost:3000",
        database: memoryAdapter(database),
        emailAndPassword: { enabled: true },
      });

      const response = await auth.handler(
        new Request("http://localhost:3000/api/auth/sign-up/email", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": "198.51.100.10",
            ...trustedHeader,
          },
          body: JSON.stringify({
            email: `${_label}-trusted-ip@example.test`,
            name: `${_label} trusted IP`,
            password: "test-password",
          }),
        }),
      );

      expect(response.status).toBe(200);
      expect(database.session).toHaveLength(1);
      expect(database.session?.[0]?.ipAddress).toBe("127.0.0.1");
    },
  );

  it.each([
    ["onboarding validation", "/api/auth/dash/validate"],
    ["user administration", "/api/auth/dash/list-users"],
    ["current-user audit logs", "/api/auth/events/audit-logs"],
    ["organization audit logs", "/api/auth/events/all-audit-logs"],
  ])("rejects unsigned Dashboard %s requests", async (_label, path) => {
    const auth = await createTestAuth(googleAuthEnvironment({ VERCEL_ENV: "production" }));

    const response = await auth.handler(new Request(`https://apps.autograph.so${path}`));

    expect(response.status).toBe(401);
  });

  it("allows explicit placeholder config only for schema tooling", () => {
    const env = readAuthEnvironment({}, { allowPlaceholderConfig: true });

    expect(env.usingPlaceholderConfig).toBe(true);
    expect(env.databaseUrl).toContain("/auth");
    expect(env.allowedHosts).toEqual(AUTH_LOCAL_HOSTS);
  });

  it("keeps placeholder config available when only optional auth settings are set", () => {
    const env = readAuthEnvironment(
      {
        PLATFORM_AUTH_TRUSTED_ORIGINS: "http://localhost:3000",
      },
      { allowPlaceholderConfig: true },
    );

    expect(env.usingPlaceholderConfig).toBe(true);
    expect(env.trustedOrigins).toEqual(["http://localhost:3000"]);
    expect(env.allowPublicSignUp).toBe(true);
  });

  it("uses the dedicated platform Auth binding in Production", () => {
    const env = readAuthEnvironment({
      VERCEL_ENV: "production",
      DATABASE_URL:
        "postgres://neondb_owner@ep-production.neon.tech/neondb?sslmode=require&channel_binding=require",
      PLATFORM_AUTH_DATABASE_URL:
        "postgres://platform_auth_owner@ep-production.neon.tech/platform_auth?sslmode=require&channel_binding=require",
      BETTER_AUTH_URL: "https://apps.autograph.so",
      BETTER_AUTH_SECRET: "01234567890123456789012345678901",
      BETTER_AUTH_API_KEY: INFRASTRUCTURE_API_KEY,
    });

    const database = new URL(env.databaseUrl);
    expect(database.username).toBe("platform_auth_owner");
    expect(database.pathname).toBe("/platform_auth");
    expect(database.searchParams.getAll("sslmode")).toEqual(["verify-full"]);
    expect(database.searchParams.get("channel_binding")).toBe("require");
  });

  it("requires the dedicated platform Auth binding in Production", () => {
    expect(() =>
      readAuthEnvironment({
        VERCEL_ENV: "production",
        DATABASE_URL:
          "postgres://neondb_owner@ep-production.neon.tech/neondb?sslmode=require&channel_binding=require",
        BETTER_AUTH_URL: "https://apps.autograph.so",
        BETTER_AUTH_SECRET: "01234567890123456789012345678901",
        BETTER_AUTH_API_KEY: INFRASTRUCTURE_API_KEY,
      }),
    ).toThrow("PLATFORM_AUTH_DATABASE_URL is required");
  });

  it.each([
    [
      "a non-Neon host",
      "postgres://owner@database.example.test/neondb?sslmode=verify-full",
      /must come from Neon/,
    ],
    [
      "an unnamed database",
      "postgres://neondb_owner@ep-production.neon.tech/?sslmode=verify-full",
      /must name a database and role/,
    ],
    [
      "an unnamed role",
      "postgres://ep-production.neon.tech/neondb?sslmode=verify-full",
      /must name a database and role/,
    ],
    [
      "a query-parameter host override",
      "postgres://neondb_owner@ep-production.neon.tech/neondb?sslmode=require&host=evil.example.test",
      /may only be sslmode and channel_binding/,
    ],
    [
      "a query-parameter role override",
      "postgres://neondb_owner@ep-production.neon.tech/neondb?sslmode=require&user=other_owner",
      /may only be sslmode and channel_binding/,
    ],
    [
      "a query-parameter TLS override",
      "postgres://neondb_owner@ep-production.neon.tech/neondb?sslmode=require&sslrootcert=/tmp/foreign-ca",
      /may only be sslmode and channel_binding/,
    ],
    [
      "a weakened channel binding",
      "postgres://neondb_owner@ep-production.neon.tech/neondb?sslmode=require&channel_binding=disable",
      /channel_binding must be require/,
    ],
  ])("rejects a Vercel Auth binding with %s", (_label, databaseUrl, expected) => {
    expect(() =>
      readAuthEnvironment({
        VERCEL_ENV: "production",
        PLATFORM_AUTH_DATABASE_URL: databaseUrl,
        BETTER_AUTH_URL: "https://apps.autograph.so",
        BETTER_AUTH_SECRET: "01234567890123456789012345678901",
        BETTER_AUTH_API_KEY: INFRASTRUCTURE_API_KEY,
      }),
    ).toThrow(expected);
  });

  it("accepts a local dedicated auth database without a search_path option", () => {
    const env = readAuthEnvironment({
      PLATFORM_AUTH_DATABASE_URL: "postgres://postgres@127.0.0.1/auth",
      BETTER_AUTH_URL: "https://auth.example.com",
      BETTER_AUTH_SECRET: "01234567890123456789012345678901",
    });

    expect(env.databaseUrl).toBe("postgres://postgres@127.0.0.1/auth");
  });

  it("accepts a local dedicated auth database over an absolute Unix socket", () => {
    const env = readAuthEnvironment({
      PLATFORM_AUTH_DATABASE_URL: "postgres:///auth?host=%2Fvar%2Frun%2Fpostgresql&sslmode=disable",
      BETTER_AUTH_URL: "https://auth.example.com",
      BETTER_AUTH_SECRET: "01234567890123456789012345678901",
    });

    expect(env.databaseUrl).toContain("host=%2Fvar%2Frun%2Fpostgresql");
  });

  it("rejects a hostname-less auth database URL without an absolute Unix socket", () => {
    expect(() =>
      readAuthEnvironment({
        PLATFORM_AUTH_DATABASE_URL: "postgres:///auth?host=localhost",
        BETTER_AUTH_URL: "https://auth.example.com",
        BETTER_AUTH_SECRET: "01234567890123456789012345678901",
      }),
    ).toThrow(/valid PostgreSQL URL/);
  });

  it.each([
    "postgres://auth@ep-production.neon.tech/auth?search_path=auth&sslmode=verify-full",
    "postgres://auth@ep-production.neon.tech/auth?options=-csearch_path%3Dauth&sslmode=verify-full",
  ])("rejects a legacy Auth search_path override: %s", (databaseUrl) => {
    expect(() =>
      readAuthEnvironment({
        VERCEL_ENV: "production",
        PLATFORM_AUTH_DATABASE_URL: databaseUrl,
        BETTER_AUTH_URL: "https://apps.autograph.so",
        BETTER_AUTH_SECRET: "01234567890123456789012345678901",
        BETTER_AUTH_API_KEY: INFRASTRUCTURE_API_KEY,
      }),
    ).toThrow("PLATFORM_AUTH_DATABASE_URL must not override PostgreSQL search_path");
  });

  it("rejects an ambient PostgreSQL search_path override", () => {
    expect(() =>
      readAuthEnvironment({
        VERCEL_ENV: "production",
        PLATFORM_AUTH_DATABASE_URL:
          "postgres://auth@ep-production.neon.tech/auth?sslmode=verify-full",
        BETTER_AUTH_URL: "https://apps.autograph.so",
        BETTER_AUTH_SECRET: "01234567890123456789012345678901",
        BETTER_AUTH_API_KEY: INFRASTRUCTURE_API_KEY,
        PGOPTIONS: "-c search_path=auth",
      }),
    ).toThrow("PGOPTIONS must not override PostgreSQL search_path");
  });

  it.each(["postgres://owner:secret@127.0.0.1/neondb", "postgres://owner:secret@[::1]/neondb"])(
    "rejects a loopback database in Vercel Production: %s",
    (databaseUrl) => {
      expect(() =>
        readAuthEnvironment(
          googleAuthEnvironment({
            VERCEL_ENV: "production",
            PLATFORM_AUTH_DATABASE_URL: databaseUrl,
            BETTER_AUTH_URL: "https://apps.autograph.so",
          }),
        ),
      ).toThrow(/must come from Neon/);
    },
  );

  it("derives preview runtime auth from the native Neon binding and ignores the retired key", () => {
    const env = readAuthEnvironment({
      VERCEL_ENV: "preview",
      VERCEL_DEPLOYMENT_ID: "dpl_preview",
      VERCEL_URL: configuredRuntimePreviewHost,
      DATABASE_URL_UNPOOLED:
        "postgres://neondb_owner:secret@ep-preview.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
      RETIRED_PREVIEW_DATABASE_URL_UNPOOLED:
        "postgres://auth:secret@ep-production.us-east-2.aws.neon.tech/auth",
      AUTH_PRODUCTION_DATABASE_IDENTITY,
      BETTER_AUTH_SECRET: "01234567890123456789012345678901",
    });

    const database = new URL(env.databaseUrl);
    expect(database.hostname).toBe("ep-preview.us-east-2.aws.neon.tech");
    expect(database.pathname).toBe("/neondb");
    expect(database.searchParams.getAll("sslmode")).toEqual(["verify-full"]);
    expect(database.searchParams.get("channel_binding")).toBe("require");
  });

  it("uses restricted auth credentials on the isolated native Preview endpoint", () => {
    const env = readAuthEnvironment(
      googleAuthEnvironment({
        VERCEL_ENV: "preview",
        VERCEL_URL: configuredRuntimePreviewHost,
        BETTER_AUTH_URL: `https://${configuredRuntimePreviewHost}`,
      }),
    );
    const url = new URL(env.databaseUrl);
    expect(url.username).toBe("auth");
    expect(url.pathname).toBe("/auth");
    expect(() =>
      readAuthEnvironment(
        googleAuthEnvironment({
          VERCEL_ENV: "preview",
          PLATFORM_AUTH_DATABASE_URL: AUTH_PRODUCTION_DATABASE_URL,
        }),
      ),
    ).toThrow(/isolated native Preview/);
  });

  it("rejects duplicate sslmode values even when the first is verify-full", () => {
    expect(() =>
      readAuthEnvironment({
        VERCEL_ENV: "production",
        PLATFORM_AUTH_DATABASE_URL:
          "postgres://auth:secret@ep-production.us-east-2.aws.neon.tech/auth?sslmode=verify-full&sslmode=disable",
        BETTER_AUTH_URL: "https://apps.autograph.so",
        BETTER_AUTH_SECRET: "01234567890123456789012345678901",
      }),
    ).toThrow("sslmode=verify-full");
  });

  it.each([
    ["missing deployment identity", { VERCEL_DEPLOYMENT_ID: undefined }, /VERCEL_DEPLOYMENT_ID/],
    ["missing URL", { DATABASE_URL_UNPOOLED: undefined }, /DATABASE_URL_UNPOOLED/],
    ["malformed URL", { DATABASE_URL_UNPOOLED: "not-a-url" }, /DATABASE_URL_UNPOOLED/],
    [
      "unnamed database",
      {
        DATABASE_URL_UNPOOLED: "postgres://preview:secret@ep-preview.us-east-2.aws.neon.tech/",
      },
      /DATABASE_URL_UNPOOLED/,
    ],
    [
      "unnamed database without trailing slash",
      {
        DATABASE_URL_UNPOOLED: "postgres://preview:secret@ep-preview.us-east-2.aws.neon.tech",
      },
      /DATABASE_URL_UNPOOLED/,
    ],
    [
      "non-Neon database",
      {
        DATABASE_URL_UNPOOLED: "postgres://auth:secret@database.example.test/auth",
      },
      /from Neon/,
    ],
    [
      "production database",
      {
        DATABASE_URL_UNPOOLED:
          "postgres://neondb_owner:secret@ep-production.us-east-2.aws.neon.tech/neondb?sslmode=require",
      },
      /production Neon endpoint/,
    ],
    [
      "production endpoint with another database",
      {
        DATABASE_URL_UNPOOLED:
          "postgres://neondb_owner:secret@ep-production.us-east-2.aws.neon.tech/other_database?sslmode=require",
      },
      /production Neon endpoint/,
    ],
    [
      "pooled production endpoint with an encoded database",
      {
        DATABASE_URL_UNPOOLED:
          "postgres://neondb_owner:secret@ep-production-pooler.us-east-2.aws.neon.tech/%6Eeondb?sslmode=require",
      },
      /production Neon endpoint/,
    ],
    [
      "query-parameter production host override",
      {
        DATABASE_URL_UNPOOLED:
          "postgres://neondb_owner:secret@ep-preview.us-east-2.aws.neon.tech/neondb?sslmode=require&host=ep-production.us-east-2.aws.neon.tech",
      },
      /may only be sslmode and channel_binding/,
    ],
  ])("rejects preview runtime auth with %s", (_label, overrides, expected) => {
    expect(() =>
      readAuthEnvironment({
        VERCEL_ENV: "preview",
        VERCEL_DEPLOYMENT_ID: "dpl_preview",
        VERCEL_URL: configuredRuntimePreviewHost,
        DATABASE_URL_UNPOOLED:
          "postgres://neondb_owner:secret@ep-preview.us-east-2.aws.neon.tech/neondb?sslmode=require",
        AUTH_PRODUCTION_DATABASE_IDENTITY,
        BETTER_AUTH_SECRET: "01234567890123456789012345678901",
        ...overrides,
      }),
    ).toThrow(expected);
  });

  it("accepts an explicit parent cookie domain for stable preview auth", () => {
    const env = readAuthEnvironment({
      PLATFORM_AUTH_DATABASE_URL: "postgres://postgres@127.0.0.1/auth",
      PLATFORM_AUTH_COOKIE_DOMAIN: ".autograph.so",
      BETTER_AUTH_URL: "https://auth.autograph.so",
      BETTER_AUTH_SECRET: "01234567890123456789012345678901",
    });

    expect(env.cookieDomain).toBe(".autograph.so");
  });

  it("rejects cookie domains that do not contain the auth host", () => {
    expect(() =>
      readAuthEnvironment({
        PLATFORM_AUTH_DATABASE_URL: "postgres://postgres@127.0.0.1/auth",
        PLATFORM_AUTH_COOKIE_DOMAIN: ".example.com",
        BETTER_AUTH_URL: "https://auth.autograph.so",
        BETTER_AUTH_SECRET: "01234567890123456789012345678901",
      }),
    ).toThrow(/PLATFORM_AUTH_COOKIE_DOMAIN/);
  });

  it("enables Google auth when both OAuth credentials are configured", () => {
    const env = readAuthEnvironment(googleAuthEnvironment());

    expect(env.google).toEqual({
      clientId: "google-client-id",
      clientSecret: "google-client-secret",
    });
    expect(env.oAuthProxy).toEqual({
      productionUrl: "https://apps.autograph.so",
      secret: OAUTH_PROXY_SECRET,
    });
    expect(env.allowPublicSignUp).toBe(true);
  });

  it.each([
    ["locally", undefined],
    ["in Vercel Development", "development"],
  ])("enables email signup %s while keeping Google sign-in-only", (_label, vercelEnvironment) => {
    const configuredAuth = createAuth({
      env: googleAuthEnvironment({ VERCEL_ENV: vercelEnvironment }),
    });

    expect(configuredAuth.options.emailAndPassword).toMatchObject({
      disableSignUp: false,
      enabled: true,
    });
    expect(configuredAuth.options.socialProviders?.google).toMatchObject({
      disableImplicitSignUp: true,
      disableSignUp: true,
    });
  });

  it("enables email signup and omits Google entirely in Preview", () => {
    const previewHost = previewHostFixture();
    const configuredAuth = createAuth({
      env: googleAuthEnvironment({
        VERCEL_ENV: "preview",
        VERCEL_URL: previewHost,
      }),
    });

    expect(configuredAuth.options.emailAndPassword).toMatchObject({
      disableSignUp: false,
      enabled: true,
    });
    expect(configuredAuth.options.socialProviders).toBeUndefined();
    expect(configuredAuth.options.plugins?.map((plugin) => plugin.id)).not.toContain("oauth-proxy");
  });

  it("keeps email and Google signup disabled in Production", () => {
    const configuredAuth = createAuth({
      env: googleAuthEnvironment({ VERCEL_ENV: "production" }),
    });

    expect(configuredAuth.options.emailAndPassword).toMatchObject({
      disableSignUp: true,
      enabled: true,
    });
    expect(configuredAuth.options.socialProviders?.google).toMatchObject({
      disableImplicitSignUp: true,
      disableSignUp: true,
    });
  });

  it("keeps Google signup guards enabled when the browser requests signup", async () => {
    const origin = "http://localhost:3000";
    const auth = await createTestAuth(googleAuthEnvironment());

    const response = await auth.handler(
      new Request(`${origin}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          provider: "google",
          callbackURL: `${origin}/`,
          requestSignUp: true,
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(auth.options.socialProviders?.google).toMatchObject({
      disableImplicitSignUp: true,
      disableSignUp: true,
    });
  });

  it("derives the preview auth origin from VERCEL_URL without BETTER_AUTH_URL", () => {
    const env = readAuthEnvironment(
      googleAuthEnvironment({
        BETTER_AUTH_URL: undefined,
        VERCEL_ENV: "preview",
        VERCEL_URL: "apps-feature-autographing.vercel.app",
      }),
    );

    expect(env.baseUrl).toBe("https://apps-feature-autographing.vercel.app");
  });

  it("uses the route-owned public origin instead of the private Vercel child origin", () => {
    const publicOrigin = "https://apps-pr-494-autographing.vercel.app";
    const env = readAuthEnvironment(
      googleAuthEnvironment({
        PLATFORM_ORIGIN: "http://gateway:3024",
        PLATFORM_PUBLIC_ORIGIN: publicOrigin,
        BETTER_AUTH_URL: publicOrigin,
        VERCEL_ENV: "preview",
        VERCEL_URL: "apps-shell-private-autographing.vercel.app",
      }),
    );

    expect(env.baseUrl).toBe(publicOrigin);
  });

  it("rejects mismatched route-owned public and auth origins", () => {
    expect(() =>
      readAuthEnvironment(
        googleAuthEnvironment({
          PLATFORM_ORIGIN: "http://gateway:3024",
          PLATFORM_PUBLIC_ORIGIN: "https://apps-pr-494-autographing.vercel.app",
          BETTER_AUTH_URL: "https://apps-shell-private-autographing.vercel.app",
          VERCEL_ENV: "preview",
          VERCEL_URL: "apps-shell-private-autographing.vercel.app",
        }),
      ),
    ).toThrow(/BETTER_AUTH_URL must equal PLATFORM_PUBLIC_ORIGIN/);
  });

  it("rejects an HTTP route-owned Vercel origin", () => {
    expect(() =>
      readAuthEnvironment(
        googleAuthEnvironment({
          PLATFORM_ORIGIN: "http://gateway:3024",
          PLATFORM_PUBLIC_ORIGIN: "http://apps-pr-494-autographing.vercel.app",
          BETTER_AUTH_URL: "http://apps-pr-494-autographing.vercel.app",
          VERCEL_ENV: "preview",
          VERCEL_URL: "apps-shell-private-autographing.vercel.app",
        }),
      ),
    ).toThrow(/Route-owned Vercel auth origins must use HTTPS/);
  });

  it("derives Better Auth and preview validation hosts from one host policy", () => {
    expect(AUTH_VERCEL_PREVIEW_HOSTS).toEqual([
      "apps-autographing.vercel.app",
      "apps-*-autographing.vercel.app",
    ]);
    expect(AUTH_VERCEL_PREVIEW_HOSTS).toContain("apps-*-autographing.vercel.app");
    expect(
      hostMatches("apps-*-autographing.vercel.app", "apps-feature-autographing.vercel.app"),
    ).toBe(true);
    expect(hostMatches("apps-*-autographing.vercel.app", "foreign.vercel.app")).toBe(false);
  });

  it.each([
    ["Vercel Production", "production", AUTH_PRODUCTION_HOSTS],
    ["Vercel Preview", "preview", AUTH_VERCEL_PREVIEW_HOSTS],
    ["Vercel Development", "development", AUTH_LOCAL_HOSTS],
    ["local and non-Vercel", undefined, AUTH_LOCAL_HOSTS],
  ])("limits Better Auth base hosts in %s", (_label, vercelEnvironment, expectedHosts) => {
    const env = readAuthEnvironment(
      googleAuthEnvironment({
        VERCEL_ENV: vercelEnvironment,
        VERCEL_URL:
          vercelEnvironment === "preview" ? "apps-feature-autographing.vercel.app" : undefined,
      }),
    );

    expect(env.allowedHosts).toEqual(expectedHosts);
  });

  it("allows the exact current Production deployment host", () => {
    const env = readAuthEnvironment(
      googleAuthEnvironment({
        PLATFORM_PUBLIC_ORIGIN: "https://apps.autograph.so",
        BETTER_AUTH_URL: "https://apps.autograph.so",
        VERCEL_ENV: "production",
        VERCEL_URL: "apps-i3c9q2qxg-autographing.vercel.app",
      }),
    );

    expect(env.allowedHosts).toEqual([
      ...AUTH_PRODUCTION_HOSTS,
      "apps-i3c9q2qxg-autographing.vercel.app",
    ]);
    expect(env.allowedHosts).not.toContain("apps-*-autographing.vercel.app");
    expect(env.baseUrl).toBe("https://apps.autograph.so");
  });

  it("allows the bounded immutable Gateway candidate pattern only from the Production Shell", () => {
    const shell = readAuthEnvironment(
      googleAuthEnvironment({
        PLATFORM_PUBLIC_ORIGIN: "https://apps.autograph.so",
        BETTER_AUTH_URL: "https://apps.autograph.so",
        VERCEL_ENV: "production",
        VERCEL_URL: "apps-shell-i3c9q2qxg-autographing.vercel.app",
      }),
    );
    const api = readAuthEnvironment(
      googleAuthEnvironment({
        PLATFORM_PUBLIC_ORIGIN: "https://apps.autograph.so",
        BETTER_AUTH_URL: "https://apps.autograph.so",
        VERCEL_ENV: "production",
        VERCEL_URL: "apps-dev-api-i3c9q2qxg-autographing.vercel.app",
      }),
    );
    const prefixedSibling = readAuthEnvironment(
      googleAuthEnvironment({
        PLATFORM_PUBLIC_ORIGIN: "https://apps.autograph.so",
        BETTER_AUTH_URL: "https://apps.autograph.so",
        VERCEL_ENV: "production",
        VERCEL_URL: "apps-shell-shadow-i3c9q2qxg-autographing.vercel.app",
      }),
    );

    expect(shell.allowedHosts).toContain(AUTH_PRODUCTION_CANDIDATE_GATEWAY_HOST);
    expect(api.allowedHosts).not.toContain(AUTH_PRODUCTION_CANDIDATE_GATEWAY_HOST);
    expect(prefixedSibling.allowedHosts).not.toContain(AUTH_PRODUCTION_CANDIDATE_GATEWAY_HOST);
  });

  it.each([
    "foreign-project-autographing.vercel.app",
    "apps-candidate-foreign-team.vercel.app",
    "https://apps-candidate-autographing.vercel.app",
    "apps-candidate-autographing.vercel.app/path",
    "apps-*-autographing.vercel.app",
    "apps-candidate?-autographing.vercel.app",
    "apps-candidate_\n-autographing.vercel.app",
    `apps-${"a".repeat(46)}-autographing.vercel.app`,
  ])("does not trust a foreign or malformed Production VERCEL_URL: %s", (vercelUrl) => {
    const env = readAuthEnvironment(
      googleAuthEnvironment({
        VERCEL_ENV: "production",
        VERCEL_URL: vercelUrl,
      }),
    );

    expect(env.allowedHosts).toEqual(AUTH_PRODUCTION_HOSTS);
  });

  it("reaches normal auth handling on a bounded immutable Gateway candidate via the Shell", async () => {
    const candidateOrigin = "https://apps-i3c9q2qxg-autographing.vercel.app";
    const auth = await createTestAuth(
      googleAuthEnvironment({
        PLATFORM_PUBLIC_ORIGIN: "https://apps.autograph.so",
        BETTER_AUTH_URL: "https://apps.autograph.so",
        VERCEL_ENV: "production",
        VERCEL_URL: "apps-shell-i3c9q2qxg-autographing.vercel.app",
      }),
    );

    const response = await auth.handler(
      new Request(`${candidateOrigin}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: candidateOrigin,
        },
        body: JSON.stringify({
          email: "candidate-qa@example.invalid",
          password: "invalid-password",
        }),
      }),
    );

    expect(response.status).toBe(401);
  });

  it.each([
    "https://apps-feature-autographing.vercel.app",
    "https://apps-i3c9q2qxg-foreign-team.vercel.app",
  ])("rejects an unbounded or foreign Production Gateway candidate: %s", async (origin) => {
    const auth = await createTestAuth(
      googleAuthEnvironment({
        PLATFORM_PUBLIC_ORIGIN: "https://apps.autograph.so",
        BETTER_AUTH_URL: "https://apps.autograph.so",
        VERCEL_ENV: "production",
        VERCEL_URL: "apps-shell-i3c9q2qxg-autographing.vercel.app",
      }),
    );

    await expect(
      auth.handler(
        new Request(`${origin}/api/auth/sign-in/email`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin,
          },
          body: JSON.stringify({
            email: "candidate-qa@example.invalid",
            password: "invalid-password",
          }),
        }),
      ),
    ).rejects.toThrow(/not in the allowed hosts list/);
  });

  it.each([
    [
      "Vercel Production",
      { VERCEL_ENV: "production" },
      "https://apps.autograph.so",
      "https://apps.autograph.so",
      "http://localhost:3000",
    ],
    [
      "Vercel Preview",
      {
        VERCEL_ENV: "preview",
        VERCEL_URL: "apps-feature-autographing.vercel.app",
      },
      "https://apps-feature-autographing.vercel.app",
      "https://apps-feature-autographing.vercel.app",
      "https://apps.autograph.so",
    ],
    [
      "Vercel Development",
      { VERCEL_ENV: "development" },
      "http://localhost:3000",
      "http://localhost:3000",
      "https://apps-feature-autographing.vercel.app",
    ],
  ])(
    "accepts only the environment-scoped origin in %s",
    async (_label, overrides, requestOrigin, allowedOrigin, rejectedOrigin) => {
      const auth = await createTestAuth(googleAuthEnvironment(overrides));
      const signIn = (origin: string) =>
        auth.handler(
          new Request(`${requestOrigin}/api/auth/sign-in/email`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              cookie: "better-auth.session_token=invalid",
              origin,
            },
            body: JSON.stringify({
              email: "origin-test@example.invalid",
              password: "invalid-password",
            }),
          }),
        );

      expect((await signIn(allowedOrigin)).status).toBe(401);
      expect((await signIn(rejectedOrigin)).status).toBe(403);
    },
  );

  it.each([
    [
      "missing proxy URL and secret",
      { OAUTH_PROXY_PRODUCTION_URL: undefined, OAUTH_PROXY_SECRET: undefined },
      /OAUTH_PROXY_PRODUCTION_URL.*OAUTH_PROXY_SECRET/,
    ],
    ["missing proxy URL", { OAUTH_PROXY_PRODUCTION_URL: undefined }, /OAUTH_PROXY_PRODUCTION_URL/],
    ["missing proxy secret", { OAUTH_PROXY_SECRET: undefined }, /OAUTH_PROXY_SECRET/],
    ["short proxy secret", { OAUTH_PROXY_SECRET: "too-short" }, /at least 32 characters/],
    [
      "non-HTTPS proxy URL",
      { OAUTH_PROXY_PRODUCTION_URL: "http://apps.autograph.so" },
      /must use https/,
    ],
    [
      "foreign proxy URL",
      { OAUTH_PROXY_PRODUCTION_URL: "https://auth.example.test" },
      /must be https:\/\/apps\.autograph\.so/,
    ],
    [
      "path-bearing proxy URL",
      { OAUTH_PROXY_PRODUCTION_URL: "https://apps.autograph.so/oauth" },
      /must be an origin/,
    ],
    [
      "reused Better Auth secret",
      { OAUTH_PROXY_SECRET: AUTH_SECRET },
      /must not reuse Better Auth secret material/,
    ],
    [
      "reused versioned Better Auth secret",
      {
        BETTER_AUTH_SECRET: undefined,
        BETTER_AUTH_SECRETS: `1:${OAUTH_PROXY_SECRET}`,
      },
      /must not reuse Better Auth secret material/,
    ],
  ])("fails closed for Google auth with %s", (_label, overrides, expected) => {
    const source = googleAuthEnvironment(overrides);
    expect(() => readAuthEnvironment(source)).toThrow(expected);
  });

  it("requires VERCEL_URL for preview auth instead of falling back to BETTER_AUTH_URL", () => {
    expect(() =>
      readAuthEnvironment(
        googleAuthEnvironment({
          VERCEL_ENV: "preview",
          VERCEL_URL: undefined,
        }),
      ),
    ).toThrow(/VERCEL_URL is required/);
  });

  it.each([
    ["foreign host", "foreign-preview.vercel.app"],
    ["HTTP origin", "http://apps-feature-autographing.vercel.app"],
    ["path", "apps-feature-autographing.vercel.app/path"],
    ["port", "apps-feature-autographing.vercel.app:8443"],
  ])("rejects a preview VERCEL_URL with %s", (_label, vercelUrl) => {
    expect(() =>
      readAuthEnvironment(
        googleAuthEnvironment({
          VERCEL_ENV: "preview",
          VERCEL_URL: vercelUrl,
        }),
      ),
    ).toThrow(/VERCEL_URL/);
  });

  it.each([
    ["local", undefined],
    ["production", "production"],
  ])("keeps %s BETTER_AUTH_URL behavior", (_label, vercelEnvironment) => {
    const env = readAuthEnvironment(
      googleAuthEnvironment({
        BETTER_AUTH_URL: "https://configured.example.test",
        VERCEL_ENV: vercelEnvironment,
        VERCEL_URL: "apps-ignored-autographing.vercel.app",
      }),
    );

    expect(env.baseUrl).toBe("https://configured.example.test");
  });

  it("rejects partial Google auth configuration", () => {
    expect(() =>
      readAuthEnvironment({
        PLATFORM_AUTH_DATABASE_URL: "postgres://postgres@127.0.0.1/auth",
        BETTER_AUTH_URL: "http://localhost:3000",
        BETTER_AUTH_SECRET: "01234567890123456789012345678901",
        GOOGLE_CLIENT_ID: "google-client-id",
      }),
    ).toThrow(/GOOGLE_CLIENT_SECRET/);
  });

  it("ignores Google configuration in Preview because the provider is disabled", () => {
    const env = readAuthEnvironment(
      googleAuthEnvironment({
        GOOGLE_CLIENT_SECRET: undefined,
        OAUTH_PROXY_PRODUCTION_URL: undefined,
        OAUTH_PROXY_SECRET: undefined,
        VERCEL_ENV: "preview",
        VERCEL_URL: "apps-feature-autographing.vercel.app",
      }),
    );

    expect(env.google).toBeUndefined();
    expect(env.oAuthProxy).toBeUndefined();
  });

  it.each([
    ["production", "https://apps.autograph.so", { VERCEL_ENV: "production" }],
    ["localhost", "http://localhost:4173", { BETTER_AUTH_URL: "http://localhost:4173" }],
    ["IPv4 loopback", "http://127.0.0.1:4173", { BETTER_AUTH_URL: "http://127.0.0.1:4173" }],
    ["Local apps", "http://apps.localhost", { BETTER_AUTH_URL: "http://apps.localhost" }],
    [
      "Local apps wildcard",
      "http://feature.apps.localhost",
      {
        BETTER_AUTH_URL: "http://feature.apps.localhost",
      },
    ],
    [
      "Local proxy",
      "http://apps.localhost:8080",
      { BETTER_AUTH_URL: "http://apps.localhost:8080" },
    ],
    [
      "Local proxy wildcard",
      "http://feature.apps.localhost:8080",
      {
        BETTER_AUTH_URL: "http://feature.apps.localhost:8080",
      },
    ],
  ])(
    "uses the production Google callback from the allowed %s host",
    async (_label, origin, overrides) => {
      const auth = await createTestAuth(
        googleAuthEnvironment({
          BETTER_AUTH_URL: origin,
          ...overrides,
        }),
      );
      const response = await auth.handler(
        new Request(`${origin}/api/auth/sign-in/social`, {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify({
            provider: "google",
            callbackURL: `${origin}/`,
          }),
        }),
      );
      const payload = (await response.json()) as { url?: string };
      const authorizationUrl = new URL(payload.url ?? "invalid:");
      const proxy = auth.options.plugins?.find((plugin) => plugin.id === "oauth-proxy");

      expect(response.status).toBe(200);
      expect(proxy?.options).toMatchObject({
        productionURL: "https://apps.autograph.so",
      });
      expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
        "https://apps.autograph.so/api/auth/callback/google",
      );
      const state = authorizationUrl.searchParams.get("state") ?? "";
      if (_label === "production") {
        await expect(symmetricDecrypt({ key: OAUTH_PROXY_SECRET, data: state })).rejects.toThrow();
      } else {
        const proxyState = JSON.parse(
          await symmetricDecrypt({ key: OAUTH_PROXY_SECRET, data: state }),
        ) as { isOAuthProxy?: boolean; stateCookie?: string };
        expect(proxyState.isOAuthProxy).toBe(true);
        const stateData = JSON.parse(
          await symmetricDecrypt({
            key: OAUTH_PROXY_SECRET,
            data: proxyState.stateCookie ?? "",
          }),
        ) as { callbackURL?: string };
        expect(stateData.callbackURL).toMatch(
          new RegExp(`^${escapeRegExp(origin)}/api/auth/callback/google/oauth-proxy\\?`),
        );
      }
    },
  );

  it("rejects Google initiation in Preview even when the browser requests signup", async () => {
    const previewHost = previewHostFixture();
    const origin = `https://${previewHost}`;
    const auth = await createTestAuth(
      googleAuthEnvironment({
        BETTER_AUTH_URL: undefined,
        VERCEL_ENV: "preview",
        VERCEL_URL: previewHost,
      }),
    );

    const response = await auth.handler(
      new Request(`${origin}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          provider: "google",
          callbackURL: `${origin}/`,
          requestSignUp: true,
        }),
      }),
    );

    expect(response.status).toBe(404);
    expect(auth.options.socialProviders).toBeUndefined();
  });

  it("returns a local OAuth profile to the allowed request origin rather than BETTER_AUTH_URL", async () => {
    const requestOrigin = "http://feature.apps.localhost:8080";
    const auth = await createTestAuth(
      googleAuthEnvironment({ BETTER_AUTH_URL: "http://localhost:3000" }),
    );

    const response = await auth.handler(
      new Request(`${requestOrigin}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: requestOrigin },
        body: JSON.stringify({
          provider: "google",
          callbackURL: `${requestOrigin}/`,
        }),
      }),
    );
    const payload = (await response.json()) as { url?: string };
    const state = new URL(payload.url ?? "invalid:").searchParams.get("state") ?? "";
    const proxyState = JSON.parse(
      await symmetricDecrypt({ key: OAUTH_PROXY_SECRET, data: state }),
    ) as { stateCookie?: string };
    const stateData = JSON.parse(
      await symmetricDecrypt({
        key: OAUTH_PROXY_SECRET,
        data: proxyState.stateCookie ?? "",
      }),
    ) as { callbackURL?: string };

    expect(stateData.callbackURL).toMatch(
      /^http:\/\/feature\.apps\.localhost:8080\/api\/auth\/callback\/google\/oauth-proxy\?/,
    );
  });

  it("preserves explicit trusted origins without using them as a dynamic base URL fallback", async () => {
    const auth = createAuth({
      env: googleAuthEnvironment({
        PLATFORM_AUTH_TRUSTED_ORIGINS: "https://trusted.example.test",
      }),
    });

    expect(auth.options.baseURL).toEqual({
      allowedHosts: [...AUTH_LOCAL_HOSTS],
      protocol: "auto",
    });
    expect(auth.options.trustedOrigins).toEqual(["https://trusted.example.test"]);

    await expect(
      auth.handler(
        new Request("https://foreign.example.test/api/auth/sign-in/social", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://trusted.example.test",
          },
          body: JSON.stringify({
            provider: "google",
            callbackURL: "https://trusted.example.test/",
          }),
        }),
      ),
    ).rejects.toThrow(/not in the allowed hosts list/);
  });

  it("rejects non-Postgres auth database URLs", () => {
    expect(() =>
      readAuthEnvironment({
        PLATFORM_AUTH_DATABASE_URL: "https://example.com/auth",
        BETTER_AUTH_URL: "http://localhost:3000",
        BETTER_AUTH_SECRET: "01234567890123456789012345678901",
      }),
    ).toThrow(/valid PostgreSQL URL/);
  });

  it("rejects Better Auth URLs that do not use http or https", () => {
    expect(() =>
      readAuthEnvironment({
        PLATFORM_AUTH_DATABASE_URL: "postgres://postgres@127.0.0.1/auth",
        BETTER_AUTH_URL: "javascript:alert(1)",
        BETTER_AUTH_SECRET: "01234567890123456789012345678901",
      }),
    ).toThrow(/http or https/);
  });

  it("fails closed when no session is present", async () => {
    await expect(
      requireUser(undefined, {
        getSession: async () => null,
      }),
    ).rejects.toMatchObject({
      code: "auth_required",
      status: 401,
    } satisfies Partial<AuthBoundaryError>);
  });

  it("retries one transient serverless connection failure while loading a session", async () => {
    let attempts = 0;
    await expect(
      requireUser(undefined, {
        getSession: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("Connection terminated unexpectedly");
          return { user: { id: "user_1", email: "user@example.com" } };
        },
      }),
    ).resolves.toMatchObject({ actorId: "user_1" });
    expect(attempts).toBe(2);
  });

  it("does not retry non-transient auth failures", async () => {
    let attempts = 0;
    await expect(
      requireUser(undefined, {
        getSession: async () => {
          attempts += 1;
          throw new Error("relation session does not exist");
        },
      }),
    ).rejects.toThrow("relation session does not exist");
    expect(attempts).toBe(1);
  });

  it("returns the active Better Auth organization when it remains a membership", async () => {
    await expect(
      requireUserOrganizationContext(undefined, {
        getSession: async () => ({
          user: { id: "user_1", email: "user@example.com", name: "User One" },
          session: { activeOrganizationId: "customer_1" },
        }),
        loadOrganizationMemberships: legacyMemberships,
        listOrganizations: async () => [
          {
            id: "customer_1",
            name: "Customer 1",
            slug: "customer-1",
            appIds: ["hc"],
          },
          {
            id: "customer_2",
            name: "Customer 2",
            slug: "customer-2",
            appIds: ["vendor"],
          },
        ],
      }),
    ).resolves.toMatchObject({
      activeOrganizationId: "customer_1",
      organizations: [
        {
          id: "customer_1",
          name: "Customer 1",
          slug: "customer-1",
          appIds: ["hc"],
        },
        {
          id: "customer_2",
          name: "Customer 2",
          slug: "customer-2",
          appIds: ["vendor"],
        },
      ],
    });
  });

  it("requires selection when the session organization is no longer a membership", async () => {
    await expect(
      requireUserOrganizationContext(undefined, {
        getSession: async () => ({
          user: { id: "user_1", email: "user@example.com", name: "User One" },
          session: { activeOrganizationId: "removed_customer" },
        }),
        loadOrganizationMemberships: legacyMemberships,
        listOrganizations: async () => [
          {
            id: "customer_1",
            name: "Customer 1",
            slug: "customer-1",
            appIds: ["hc"],
          },
        ],
      }),
    ).resolves.toMatchObject({ activeOrganizationId: null });
  });

  it("keeps an organization with a malformed assignment as zero-app access", async () => {
    await expect(
      requireUserOrganizationContext(undefined, {
        getSession: async () => ({
          user: { id: "user_1" },
          session: { activeOrganizationId: "customer_1" },
        }),
        loadOrganizationMemberships: legacyMemberships,
        listOrganizations: async () => [
          {
            id: "customer_1",
            name: "Customer 1",
            slug: "customer-1",
            appIds: '["hc"',
          },
        ],
      }),
    ).resolves.toMatchObject({
      activeOrganizationId: "customer_1",
      organizations: [{ id: "customer_1", appIds: [] }],
    });
  });

  it("selects a single organization as the initial active organization", async () => {
    const database = {
      query: async (_query: string, params: unknown[]) => {
        expect(params).toEqual(["user_1"]);
        return { rows: [{ organizationId: "customer_1" }] };
      },
    };

    await expect(initialActiveOrganizationIdForUser(database, "user_1")).resolves.toBe(
      "customer_1",
    );
  });

  it("does not select an initial active organization for ambiguous memberships", async () => {
    const database = {
      query: async () => ({
        rows: [{ organizationId: "customer_1" }, { organizationId: "customer_2" }],
      }),
    };

    await expect(initialActiveOrganizationIdForUser(database, "user_1")).resolves.toBeNull();
  });

  it("fails closed when the session has no active organization", async () => {
    await expect(
      requireTenantScope(undefined, {
        appId: "hc",
        getSession: async () => ({
          user: { id: "user_1", email: "user@example.com", name: "User One" },
          session: { id: "session_1" },
        }),
      }),
    ).rejects.toMatchObject({
      code: "tenant_required",
      status: 403,
    } satisfies Partial<AuthBoundaryError>);
  });

  it.each([
    ["hc", ["hc"], "hc", true],
    ["hc", ["hc"], "dev", false],
    ["hc", ["hc"], "vendor", false],
    ["hc", ["hc"], "integrations", false],
    ["vendor", ["vendor", "integrations"], "hc", false],
    ["vendor", ["vendor", "integrations"], "dev", false],
    ["vendor", ["vendor", "integrations"], "vendor", true],
    ["vendor", ["vendor", "integrations"], "integrations", true],
    ["dev", ["hc", "vendor", "integrations"], "hc", true],
    ["dev", ["hc", "vendor", "integrations"], "dev", false],
    ["dev", ["hc", "vendor", "integrations"], "vendor", true],
    ["dev", ["hc", "vendor", "integrations"], "integrations", true],
  ] as const)(
    "%s organization introspection for %s assignment and %s app resolves allowed=%s",
    async (organizationId, appIds, appId, allowed) => {
      const request = introspectTenantScope(new Headers(), {
        appId,
        customerId: organizationId,
        getSession: async () => ({
          user: { id: "user_1", email: "user@example.com", name: "User One" },
          session: { activeOrganizationId: organizationId },
        }),
        verifyTenantMembership: async () => true,
        loadOrganizationMemberships: legacyMemberships,
        listOrganizations: async () => [
          {
            id: organizationId,
            name: organizationId,
            slug: organizationId,
            appIds,
          },
        ],
        loadOrganizationRole: async () => "member",
      });

      if (allowed) {
        await expect(request).resolves.toMatchObject({
          appId,
          customerId: organizationId,
        });
      } else {
        await expect(request).rejects.toMatchObject({
          code: "app_access_required",
          status: 403,
        } satisfies Partial<AuthBoundaryError>);
      }
    },
  );

  it("maps the active organization id to customer_id and preserves app_id", async () => {
    const scope = await requireTenantScope(new Headers(), {
      appId: "hc",
      getSession: async () => ({
        user: { id: "user_1", email: "user@example.com", name: "User One" },
        session: { id: "session_1", activeOrganizationId: "customer_1" },
      }),
      verifyTenantMembership: async (_headers, membership) =>
        membership.actorId === "user_1" && membership.organizationId === "customer_1",
      loadOrganizationMemberships: legacyMemberships,
      listOrganizations: async () => [
        {
          id: "customer_1",
          name: "Customer 1",
          slug: "customer-1",
          appIds: ["hc"],
        },
      ],
    });

    expect(scope).toEqual({
      appId: "hc",
      customerId: "customer_1",
      actorId: "user_1",
    });
  });

  it.each([
    ["missing", undefined],
    ["malformed", '["hc"'],
    ["non-array", { app: "hc" }],
    ["empty string", [""]],
    ["non-string", ["hc", 1]],
    ["duplicate", ["hc", "hc"]],
    ["unknown format", ["HC App"]],
    ["different app", ["vendor"]],
  ])("denies tenant access for a %s organization app assignment", async (_label, appIds) => {
    await expect(
      requireTenantScope(new Headers(), {
        appId: "hc",
        getSession: async () => ({
          user: { id: "user_1", email: "user@example.com", name: "User One" },
          session: { id: "session_1", activeOrganizationId: "customer_1" },
        }),
        verifyTenantMembership: async () => true,
        loadOrganizationMemberships: legacyMemberships,
        listOrganizations: async () => [
          {
            id: "customer_1",
            name: "Customer 1",
            slug: "customer-1",
            appIds,
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "app_access_required",
      status: 403,
    } satisfies Partial<AuthBoundaryError>);
  });

  it("tells a person without app access the app's name and what to do next", async () => {
    await expect(
      requireTenantScope(new Headers(), {
        appId: "comp-canvas" as never,
        getSession: async () => ({
          user: { id: "user_1", email: "user@example.com", name: "User One" },
          session: { id: "session_1", activeOrganizationId: "customer_1" },
        }),
        verifyTenantMembership: async () => true,
        loadOrganizationMemberships: legacyMemberships,
        listOrganizations: async () => [
          { id: "customer_1", name: "Customer 1", slug: "customer-1", appIds: ["hc"] },
        ],
      }),
    ).rejects.toMatchObject({
      code: "app_access_required",
      message:
        "Your organization doesn't have access to Comp canvas. Ask your Autograph admin to give you access.",
      status: 403,
    } satisfies Partial<AuthBoundaryError>);
  });

  it("retries one transient membership read without weakening the tenant check", async () => {
    let attempts = 0;
    await expect(
      requireTenantScope(new Headers(), {
        appId: "hc",
        getSession: async () => ({
          user: { id: "user_1", email: "user@example.com", name: "User One" },
          session: { id: "session_1", activeOrganizationId: "customer_1" },
        }),
        verifyTenantMembership: async () => {
          attempts += 1;
          if (attempts === 1)
            throw Object.assign(new Error("socket reset"), {
              code: "ECONNRESET",
            });
          return true;
        },
        loadOrganizationMemberships: legacyMemberships,
        listOrganizations: async () => [
          {
            id: "customer_1",
            name: "Customer 1",
            slug: "customer-1",
            appIds: ["hc"],
          },
        ],
      }),
    ).resolves.toMatchObject({ customerId: "customer_1" });
    expect(attempts).toBe(2);
  });

  it("returns actor and tenant scope from one session load", async () => {
    let sessionLoads = 0;
    const context = await requireTenantContext(new Headers(), {
      appId: "vendor",
      getSession: async () => {
        sessionLoads += 1;
        return {
          user: { id: "user_1", email: "user@example.com", name: "User One" },
          session: { id: "session_1", activeOrganizationId: "customer_1" },
        };
      },
      verifyTenantMembership: async () => true,
      loadOrganizationMemberships: legacyMemberships,
      listOrganizations: async () => [
        {
          id: "customer_1",
          name: "Customer 1",
          slug: "customer-1",
          appIds: ["vendor"],
        },
      ],
    });

    expect(sessionLoads).toBe(1);
    expect(context).toEqual({
      actor: { actorId: "user_1", email: "user@example.com", name: "User One" },
      organization: {
        id: "customer_1",
        name: "Customer 1",
        slug: "customer-1",
        appIds: ["vendor"],
      },
      scope: { appId: "vendor", customerId: "customer_1", actorId: "user_1" },
    });
  });

  it("returns the stable framework-neutral auth introspection payload", async () => {
    const scope = await introspectTenantScope(new Headers(), {
      appId: "dev",
      customerId: "customer_1",
      getSession: async () => ({
        user: { id: "user_1", email: "user@example.com", name: "User One" },
        session: { id: "session_1", activeOrganizationId: "customer_1" },
      }),
      verifyTenantMembership: async (_headers, membership) =>
        membership.actorId === "user_1" && membership.organizationId === "customer_1",
      loadOrganizationMemberships: legacyMemberships,
      listOrganizations: async () => [
        {
          id: "customer_1",
          name: "Customer 1",
          slug: "customer-1",
          appIds: ["dev"],
        },
      ],
      loadOrganizationRole: async () => "admin",
    });

    expect(scope).toEqual({
      appId: "dev",
      customerId: "customer_1",
      actorId: "user_1",
      organizationRole: "admin",
    });
  });

  it("returns the authenticated organization role without app policy", async () => {
    const scope = await introspectTenantScope(new Headers(), {
      appId: "dev",
      customerId: "customer_1",
      getSession: async () => ({
        user: { id: "user_1", email: "user@example.com", name: "User One" },
        session: { id: "session_1", activeOrganizationId: "customer_1" },
      }),
      verifyTenantMembership: async () => true,
      loadOrganizationMemberships: legacyMemberships,
      listOrganizations: async () => [
        {
          id: "customer_1",
          name: "Customer 1",
          slug: "customer-1",
          appIds: ["dev"],
        },
      ],
      loadOrganizationRole: async () => "member",
    });

    expect(scope).toEqual({
      appId: "dev",
      customerId: "customer_1",
      actorId: "user_1",
      organizationRole: "member",
    });
  });

  it("preserves a missing organization role", async () => {
    const scope = await introspectTenantScope(new Headers(), {
      appId: "vendor",
      customerId: "customer_1",
      getSession: async () => ({
        user: { id: "user_1", email: "user@example.com", name: "User One" },
        session: { id: "session_1", activeOrganizationId: "customer_1" },
      }),
      verifyTenantMembership: async () => true,
      loadOrganizationMemberships: legacyMemberships,
      listOrganizations: async () => [
        {
          id: "customer_1",
          name: "Customer 1",
          slug: "customer-1",
          appIds: ["vendor"],
        },
      ],
      loadOrganizationRole: async () => null,
    });

    expect(scope).toEqual({
      appId: "vendor",
      customerId: "customer_1",
      actorId: "user_1",
      organizationRole: null,
    });
  });

  it("uses an explicit slug customer scope independently of session-active organization", async () => {
    const membershipChecks: string[] = [];
    await expect(
      introspectTenantScope(new Headers(), {
        appId: "vendor",
        customerId: "vendor",
        getSession: async () => ({
          user: { id: "user_1", email: "user@example.com", name: "User One" },
          session: { id: "session_1", activeOrganizationId: "dev" },
        }),
        verifyTenantMembership: async (_headers, membership) => {
          membershipChecks.push(membership.organizationId);
          return true;
        },
        loadOrganizationMemberships: legacyMemberships,
        listOrganizations: async () => [
          { id: "vendor", name: "Vendor", slug: "vendor", appIds: ["vendor"] },
        ],
        loadOrganizationRole: async () => "member",
      }),
    ).resolves.toMatchObject({ appId: "vendor", customerId: "vendor" });
    expect(membershipChecks).toEqual(["vendor"]);
  });

  it("fails closed when active organization membership is stale", async () => {
    await expect(
      requireTenantScope(new Headers(), {
        appId: "hc",
        getSession: async () => ({
          user: { id: "user_1", email: "user@example.com", name: "User One" },
          session: { id: "session_1", activeOrganizationId: "customer_1" },
        }),
        verifyTenantMembership: async () => false,
      }),
    ).rejects.toMatchObject({
      code: "tenant_required",
      status: 403,
    } satisfies Partial<AuthBoundaryError>);
  });
});

describe("agent server enrollment and bearer parsing", () => {
  it("starts with no agent app for an unset, blank or explicitly empty policy", () => {
    expect(readAgentAppIds({})).toEqual([]);
    expect(readAgentAppIds({ PLATFORM_GATEWAY_PROTECTED_APPLICATIONS: " " })).toEqual([]);
    expect(readAgentAppIds({ PLATFORM_GATEWAY_PROTECTED_APPLICATIONS: "[]" })).toEqual([]);
    expect(readAgentAppIds({ PLATFORM_GATEWAY_PROTECTED_APPLICATIONS: " [ ] " })).toEqual([]);
    expect(readAgentAppIds({ PLATFORM_GATEWAY_PROTECTED_APPLICATIONS: '["canvas"]' })).toEqual([
      "canvas",
    ]);
    expect(() => readAgentAppIds({ PLATFORM_GATEWAY_PROTECTED_APPLICATIONS: "canvas" })).toThrow(
      AuthConfigurationError,
    );
  });

  it("accepts the bearer scheme in any case with one or more spaces", () => {
    const token = "aaa.bbb.ccc";
    for (const header of [
      `Bearer ${token}`,
      `bearer ${token}`,
      `BEARER ${token}`,
      `Bearer   ${token}`,
    ])
      expect(bearerTokenFrom(header)).toBe(token);
    for (const header of [`Bearer${token}`, `Basic ${token}`, `Bearer ${token} extra`, "", null])
      expect(bearerTokenFrom(header)).toBeUndefined();
  });
});
