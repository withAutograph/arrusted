import { describe, expect, it } from "vitest";
import { readAuthEnvironment } from "../env";

const resource = {
  version: 1,
  environment: "isolated-development",
  hostname: "ep-isolated.neon.tech",
  port: 5432,
  database: "app_auth",
  schema: "public",
  runtimeRole: "auth_runtime",
  migratorRole: "auth_migrator",
  neon: { projectId: "synthetic-project", branchId: "br-isolated" },
};
const source = () => ({
  VERCEL_ENV: "production",
  PLATFORM_AUTH_DEPLOYMENT_PROFILE: "isolated-development",
  PLATFORM_AUTH_DATABASE_URL:
    "postgres://auth_runtime:synthetic@ep-isolated.neon.tech/app_auth?sslmode=verify-full",
  AUTH_DATABASE_RESOURCE: JSON.stringify(resource),
  AUTH_PRODUCTION_DATABASE_IDENTITY: "ep-production.neon.tech/customer_auth",
  BETTER_AUTH_URL: "https://apps-invoice.example",
  PLATFORM_PUBLIC_ORIGIN: "https://apps-invoice.example",
  PLATFORM_AUTH_TRUSTED_ORIGINS: "https://apps-invoice.example",
  BETTER_AUTH_SECRET: "synthetic-independent-app-secret-1234567890",
});

describe("isolated Auth resources with public Production delivery", () => {
  it("keeps the isolated origin and resource without admitting unenrolled signup", () => {
    const input = source();
    const env = readAuthEnvironment(input);
    expect(input.VERCEL_ENV).toBe("production");
    expect(env.databaseResource).toEqual(resource);
    expect(env.databaseUrl).toContain("auth_runtime");
    expect(env.allowedHosts).toEqual(["apps-invoice.example"]);
    expect(env.trustedOrigins).toEqual([input.PLATFORM_PUBLIC_ORIGIN]);
    expect(env.cookieDomain).toBeUndefined();
    expect(env.allowPublicSignUp).toBe(false);
    expect(env.google).toBeUndefined();
    expect(env.oAuthProxy).toBeUndefined();
    expect(env.infrastructure).toBeUndefined();
  });

  it("does not adopt ambient customer Production database or social credentials", () => {
    const env = readAuthEnvironment({
      ...source(),
      DATABASE_URL: "postgres://customer@ep-production.neon.tech/customer_auth",
      GOOGLE_CLIENT_ID: "foreign",
      GOOGLE_CLIENT_SECRET: "foreign",
    });
    expect(env.databaseResource?.environment).toBe("isolated-development");
    expect(env.databaseUrl).toContain("ep-isolated.neon.tech");
    expect(env.google).toBeUndefined();
  });

  it.each([
    { PLATFORM_AUTH_DEPLOYMENT_PROFILE: "unknown" },
    { AUTH_DATABASE_RESOURCE: undefined },
    { AUTH_DATABASE_RESOURCE: JSON.stringify({ ...resource, environment: "production" }) },
    {
      PLATFORM_AUTH_DATABASE_URL:
        "postgres://auth_migrator:synthetic@ep-isolated.neon.tech/app_auth?sslmode=verify-full",
    },
    {
      PLATFORM_AUTH_DATABASE_URL:
        "postgres://auth_runtime:synthetic@ep-isolated.neon.tech/foreign_db?sslmode=verify-full",
    },
    {
      PLATFORM_AUTH_DATABASE_URL:
        "postgres://auth_runtime:synthetic@ep-production-pooler.neon.tech/app_auth?sslmode=verify-full",
    },
    { AUTH_PRODUCTION_DATABASE_IDENTITY: undefined },
    {
      PLATFORM_AUTH_DATABASE_URL:
        "postgres://auth_runtime:synthetic@ep-isolated.neon.tech/app_auth?sslmode=disable",
    },
    { PLATFORM_AUTH_COOKIE_DOMAIN: ".example" },
    { PLATFORM_AUTH_TRUSTED_ORIGINS: "https://foreign.example" },
    {
      PLATFORM_PUBLIC_ORIGIN: "http://apps-invoice.example",
      BETTER_AUTH_URL: "http://apps-invoice.example",
    },
    { PLATFORM_PUBLIC_ORIGIN: "https://foreign.example" },
    { BETTER_AUTH_SECRET: "short" },
  ])("rejects unsafe or mismatched isolated configuration %j", (override) => {
    expect(() => readAuthEnvironment({ ...source(), ...override })).toThrow();
  });

  it("keeps existing Production Infrastructure requirements and signup policy without opt-in", () => {
    expect(() =>
      readAuthEnvironment({ ...source(), PLATFORM_AUTH_DEPLOYMENT_PROFILE: undefined }),
    ).toThrow("BETTER_AUTH_API_KEY is required");
  });
});
