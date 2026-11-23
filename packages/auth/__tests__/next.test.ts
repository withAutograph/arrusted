import { describe, expect, it } from "vite-plus/test";

import {
  createAuthRouteHandlers,
  hasSessionCookie,
  normalizeRouteOwnedGatewayHeaders,
  signupRedirectTarget,
} from "../next";
import { createAuth } from "../server";

const AUTH_DATABASE_URL = "postgres://auth@127.0.0.1/auth";
const AUTH_PRODUCTION_DATABASE_URL =
  "postgres://platform_auth_owner:secret@ep-production.us-east-2.aws.neon.tech/platform_auth?sslmode=require&channel_binding=require";
const AUTH_PRODUCTION_NATIVE_DATABASE_URL =
  "postgres://neondb_owner:secret@ep-production.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
const AUTH_PRODUCTION_DATABASE_IDENTITY = "ep-production.us-east-2.aws.neon.tech/platform_auth";
const AUTH_SECRET = "01234567890123456789012345678901";
const INFRASTRUCTURE_API_KEY = "better-auth-infrastructure-api-key";
const PUBLIC_PREVIEW_ORIGIN = "https://apps-pr-494-autographing.vercel.app";
const PRIVATE_SHELL_ORIGIN = "https://apps-shell-private-autographing.vercel.app";

function authEnvironment(overrides: Record<string, string | undefined> = {}) {
  return {
    PLATFORM_AUTH_DATABASE_URL:
      overrides.VERCEL_ENV === "production"
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
    ...overrides,
  };
}

async function expectDeniedHostRequest(request: Promise<Response>) {
  try {
    const response = await request;
    expect(response.status).toBeGreaterThanOrEqual(400);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/not in the allowed hosts list/);
  }
}

describe("hasSessionCookie", () => {
  it.each(["better-auth.session_token", "__Secure-better-auth.session_token"])(
    "recognizes the %s candidate session cookie",
    (cookieName) => {
      const request = new Request("https://shell.test", {
        headers: { cookie: `${cookieName}=candidate-token` },
      });

      expect(hasSessionCookie(request)).toBe(true);
    },
  );

  it("does not treat unrelated or missing cookies as a session", () => {
    expect(hasSessionCookie(new Request("https://shell.test"))).toBe(false);
    expect(
      hasSessionCookie(
        new Request("https://shell.test", {
          headers: { cookie: "unrelated=value" },
        }),
      ),
    ).toBe(false);
  });
});

describe("signup redirect target", () => {
  it.each(["/workspace?tab=home", "https://auth-preview.example.test/workspace?tab=home"])(
    "accepts canonical same-origin target %s for signup and existing-session continuation",
    async (callbackURL) => {
      for (const path of ["/api/auth/sign-up/email", "/api/auth/sign-in/email"]) {
        const request = new Request(`https://auth-preview.example.test${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ callbackURL }),
        });
        await expect(signupRedirectTarget(request)).resolves.toBe(
          "https://auth-preview.example.test/workspace?tab=home",
        );
      }
    },
  );

  it.each([
    "https://evil.example/workspace",
    "//evil.example/workspace",
    "https://user@auth-preview.example.test/workspace",
    "https://auth-preview.example.test/workspace#fragment",
  ])("rejects noncanonical callback target %s", async (callbackURL) => {
    const request = new Request("https://auth-preview.example.test/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callbackURL }),
    });
    await expect(signupRedirectTarget(request)).resolves.toBeUndefined();
  });
});

describe("normalizeRouteOwnedGatewayHeaders", () => {
  const privateServiceHost =
    "shell.334877305632436a367a6259794762547065455a65557958354f5077.services.vercel-infra.com";
  const publicOrigin = "https://apps.autograph.so";

  it("reconstructs exact Gateway-owned Production Shell headers", () => {
    const source = new Headers({
      host: privateServiceHost,
      "x-forwarded-host": privateServiceHost,
      "x-forwarded-proto": "https",
      "x-platform-public-origin": publicOrigin,
    });

    const normalized = normalizeRouteOwnedGatewayHeaders(source, publicOrigin, "shell");

    expect(normalized).not.toBe(source);
    expect(normalized.get("host")).toBe("apps.autograph.so");
    expect(normalized.get("x-forwarded-host")).toBe("apps.autograph.so");
    expect(normalized.get("x-forwarded-proto")).toBe("https");
  });

  it.each([
    ["missing public-origin receipt", undefined, privateServiceHost, "https"],
    ["foreign public-origin receipt", "https://attacker.example", privateServiceHost, "https"],
    ["wrong service", publicOrigin, privateServiceHost.replace(/^shell/u, "api"), "https"],
    ["lookalike service", publicOrigin, `${privateServiceHost}.evil`, "https"],
    ["invalid provider label", publicOrigin, "shell.bad_label.services.vercel-infra.com", "https"],
    ["wrong protocol", publicOrigin, privateServiceHost, "http"],
  ])("leaves %s unchanged", (_label, receipt, host, protocol) => {
    const source = new Headers({
      host,
      "x-forwarded-proto": protocol,
      ...(receipt ? { "x-platform-public-origin": receipt } : {}),
    });

    expect(normalizeRouteOwnedGatewayHeaders(source, publicOrigin, "shell")).toBe(source);
  });
});

describe("Route-owned gateway auth boundary", () => {
  it("accepts a branch Preview host through the configured wildcard policy", async () => {
    const previewHost = "apps-git-branch-team.vercel.app";
    const handlers = createAuthRouteHandlers({
      handler: async () => Response.json({ ok: true }),
      options: { baseURL: { allowedHosts: ["apps-*-team.vercel.app"] } },
    });

    const response = await handlers.POST(
      new Request(`https://${previewHost}/api/auth/sign-in/email`, { method: "POST" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("reconstructs an exact gateway-forwarded request on the public origin", async () => {
    const received: Request[] = [];
    const handlers = createAuthRouteHandlers(
      {
        handler: async (request) => {
          received.push(request);
          return Response.json({
            body: await request.text(),
            url: request.url,
          });
        },
        options: {},
      },
      { publicOrigin: PUBLIC_PREVIEW_ORIGIN },
    );
    const response = await handlers.POST(
      new Request(`${PRIVATE_SHELL_ORIGIN}/api/auth/sign-in/email?source=preview`, {
        body: "request-body",
        headers: {
          "x-forwarded-host": new URL(PUBLIC_PREVIEW_ORIGIN).host,
          "x-forwarded-proto": "https",
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      body: "request-body",
      url: `${PUBLIC_PREVIEW_ORIGIN}/api/auth/sign-in/email?source=preview`,
    });
    expect(received[0]?.headers.get("host")).toBe(new URL(PUBLIC_PREVIEW_ORIGIN).host);
  });

  it.each([
    ["wrong host", "apps-pr-494-autographing.vercel.app.evil", "https"],
    ["wrong protocol", "apps-pr-494-autographing.vercel.app", "http"],
  ])("does not trust a %s forwarding pair", async (_label, forwardedHost, forwardedProtocol) => {
    const received: Request[] = [];
    const handlers = createAuthRouteHandlers(
      {
        handler: async (request) => {
          received.push(request);
          return new Response(null, { status: 204 });
        },
        options: {},
      },
      { publicOrigin: PUBLIC_PREVIEW_ORIGIN },
    );
    const response = await handlers.GET(
      new Request(`${PRIVATE_SHELL_ORIGIN}/api/auth/session`, {
        headers: {
          "x-forwarded-host": forwardedHost,
          "x-forwarded-proto": forwardedProtocol,
        },
      }),
    );

    expect(response.status).toBe(204);
    expect(received[0]?.url).toBe(`${PRIVATE_SHELL_ORIGIN}/api/auth/session`);
  });

  it("reconstructs an exact Production request from its private Service origin", async () => {
    const received: Request[] = [];
    const handlers = createAuthRouteHandlers(
      {
        handler: async (request) => {
          received.push(request);
          return new Response(null, { status: 204 });
        },
        options: {},
      },
      { privateServiceName: "shell", publicOrigin: "https://apps.autograph.so" },
    );

    const response = await handlers.POST(
      new Request(
        "https://shell.334877305632436a367a6259794762547065455a65557958354f5077.services.vercel-infra.com/api/auth/sign-in/email",
        { body: "{}", method: "POST" },
      ),
    );

    expect(response.status).toBe(204);
    expect(received[0]?.url).toBe("https://apps.autograph.so/api/auth/sign-in/email");
    expect(received[0]?.headers.get("host")).toBe("apps.autograph.so");
    expect(received[0]?.headers.get("x-forwarded-host")).toBe("apps.autograph.so");
    expect(received[0]?.headers.get("x-forwarded-proto")).toBe("https");
  });

  it.each([
    "https://api.334877305632436a.services.vercel-infra.com/api/auth/sign-in/email",
    "https://shell.334877305632436a.services.vercel-infra.com.evil/api/auth/sign-in/email",
    "https://shell.bad_label.services.vercel-infra.com/api/auth/sign-in/email",
    "https://gateway-candidate.example/api/auth/sign-in/email",
  ])("does not reconstruct a non-matching Production Service origin: %s", async (url) => {
    const received: Request[] = [];
    const handlers = createAuthRouteHandlers(
      {
        handler: async (request) => {
          received.push(request);
          return new Response(null, { status: 204 });
        },
        options: {},
      },
      { privateServiceName: "shell", publicOrigin: "https://apps.autograph.so" },
    );

    await handlers.POST(new Request(url, { body: "{}", method: "POST" }));

    expect(received[0]?.url).toBe(url);
  });
});

describe("Infrastructure Dashboard route boundary", () => {
  it("reconstructs Dashboard requests without cloning a foreign Request instance", async () => {
    const received: Request[] = [];
    const handlers = createAuthRouteHandlers({
      handler: async (request) => {
        received.push(request);
        return Response.json({ body: await request.text() });
      },
      options: { plugins: [{ id: "dash" }] },
    });
    const createForeignRequest = () => {
      const source = new Request("https://apps.autograph.so/api/auth/dash/list-users", {
        body: "dashboard-payload",
        headers: { "x-forwarded-host": "dash.better-auth.com" },
        method: "POST",
      });
      const foreignRequest = Object.create(Request.prototype) as Request;
      for (const property of ["body", "headers", "method", "url"] as const) {
        Object.defineProperty(foreignRequest, property, {
          configurable: true,
          value: source[property],
        });
      }
      return foreignRequest;
    };

    // Constructing from the foreign instance is intentionally unsafe and can
    // consume its body before throwing, so keep that negative probe separate
    // from the fresh request passed to the route handler.
    expect(() => new Request(createForeignRequest())).toThrow(TypeError);

    const foreignRequest = createForeignRequest();
    const response = await handlers.POST(foreignRequest);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ body: "dashboard-payload" });
    expect(received).toHaveLength(1);
    expect(received[0]).not.toBe(foreignRequest);
    expect(received[0]?.headers.get("x-forwarded-host")).toBe("apps.autograph.so");
  });

  it.each(["host", "x-forwarded-host"])(
    "normalizes the Dashboard %s only for signed Production routes",
    async (header) => {
      const received: Request[] = [];
      const auth = {
        handler: async (request: Request) => {
          received.push(request);
          return new Response(null, { status: 401 });
        },
        options: {
          baseURL: { allowedHosts: ["apps.autograph.so"] },
          plugins: [{ id: "dash" }],
        },
      };
      const handlers = createAuthRouteHandlers(auth);
      const response = await handlers.GET(
        new Request("https://apps.autograph.so/api/auth/dash/list-users", {
          headers: { [header]: "dash.better-auth.com" },
        }),
      );

      expect(response.status).toBe(401);
      expect(received[0]?.headers.get(header)).toBe("apps.autograph.so");
    },
  );

  it.each(["host", "x-forwarded-host"])(
    "does not trust the Dashboard %s on non-Dashboard auth routes",
    async (header) => {
      const auth = createAuth({
        appName: "Test Auth",
        env: authEnvironment({ VERCEL_ENV: "production" }),
      });
      const handlers = createAuthRouteHandlers(auth);

      await expectDeniedHostRequest(
        handlers.POST(
          new Request("https://apps.autograph.so/api/auth/sign-in/email", {
            method: "POST",
            headers: {
              [header]: "dash.better-auth.com",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              email: "user@example.com",
              password: "password",
            }),
          }),
        ),
      );
    },
  );

  it.each(["https://apps-feature-autographing.vercel.app", "https://apps.autograph.so.evil"])(
    "does not normalize the Dashboard host for non-production URL %s",
    async (origin) => {
      const auth = createAuth({
        appName: "Test Auth",
        env: authEnvironment({ VERCEL_ENV: "production" }),
      });
      const handlers = createAuthRouteHandlers(auth);

      await expectDeniedHostRequest(
        handlers.GET(
          new Request(`${origin}/api/auth/dash/list-users`, {
            headers: { "x-forwarded-host": "dash.better-auth.com" },
          }),
        ),
      );
    },
  );

  it.each([
    ["host", "dash.better-auth.com.evil"],
    ["x-forwarded-host", "evil-dash.better-auth.com"],
  ])("rejects near-match Dashboard %s value %s", async (header, value) => {
    const auth = createAuth({
      appName: "Test Auth",
      env: authEnvironment({ VERCEL_ENV: "production" }),
    });
    const handlers = createAuthRouteHandlers(auth);

    await expectDeniedHostRequest(
      handlers.GET(
        new Request("https://apps.autograph.so/api/auth/dash/list-users", {
          headers: { [header]: value },
        }),
      ),
    );
  });

  it.each([
    ["local", "http://localhost:3000", {}],
    [
      "Preview",
      "https://apps-feature-autographing.vercel.app",
      {
        VERCEL_ENV: "preview",
        VERCEL_URL: "apps-feature-autographing.vercel.app",
      },
    ],
  ])("does not normalize the Dashboard forwarded host in %s", async (_label, origin, overrides) => {
    const auth = createAuth({
      appName: "Test Auth",
      env: authEnvironment(overrides),
    });
    const handlers = createAuthRouteHandlers(auth);

    await expectDeniedHostRequest(
      handlers.GET(
        new Request(`${origin}/api/auth/dash/list-users`, {
          headers: { "x-forwarded-host": "dash.better-auth.com" },
        }),
      ),
    );
  });
});
