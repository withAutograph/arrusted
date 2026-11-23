import { describe, expect, it } from "vitest";
import {
  assertAuthDatabaseConnection,
  assertAuthDatabaseProvider,
  readAuthDatabaseResource,
  type AuthDatabaseResource,
} from "../database-resource";
import { readAuthEnvironment } from "../env";

const resource: AuthDatabaseResource = {
  version: 1,
  environment: "production",
  hostname: "ep-fixture.us-east-1.aws.neon.tech",
  port: 5432,
  database: "auth_store",
  schema: "public",
  runtimeRole: "auth_runtime",
  migratorRole: "auth_migrator",
  neon: { projectId: "project-fixture", branchId: "br-fixture" },
};
const url =
  "postgres://auth_runtime:secret@ep-fixture-pooler.us-east-1.aws.neon.tech/auth_store?sslmode=verify-full";

describe("reviewed Auth database resource", () => {
  it("keeps credentials separate and preserves direct/pooled resource identity", () => {
    expect(readAuthDatabaseResource(JSON.stringify(resource))).toEqual(resource);
    expect(() => assertAuthDatabaseConnection(url, resource, "runtime")).not.toThrow();
    expect(() =>
      assertAuthDatabaseConnection(
        url.replace("auth_runtime", "auth_migrator").replace("-pooler", ""),
        resource,
        "migrator",
      ),
    ).not.toThrow();
  });
  it.each([
    "",
    "null",
    JSON.stringify({ ...resource, password: "secret" }),
    JSON.stringify({ ...resource, runtimeRole: resource.migratorRole }),
    JSON.stringify({ ...resource, neon: undefined }),
    JSON.stringify({ ...resource, schema: "alternate" }),
  ])("rejects malformed or unsafe resource %s", (value) => {
    expect(() => readAuthDatabaseResource(value)).toThrow("Auth database preflight failed");
  });
  it.each([
    url.replace("auth_store", "platform_auth"),
    url.replace("ep-fixture", "ep-wrong"),
    url.replace("auth_runtime", "auth_migrator"),
    url.replace("verify-full", "require"),
    `${url}&host=evil.invalid`,
    `${url}&options=-csearch_path=evil`,
    `${url}&sslmode=disable`,
  ])("refuses connection drift without echoing credentials", (connection) => {
    expect(() => assertAuthDatabaseConnection(connection, resource, "runtime")).toThrow(
      /^Auth database preflight failed:/u,
    );
    try {
      assertAuthDatabaseConnection(connection, resource, "runtime");
    } catch (error) {
      expect(String(error)).not.toContain("secret");
    }
  });
  it("refuses pooled migration and wrong provider identity", () => {
    expect(() =>
      assertAuthDatabaseConnection(
        url.replace("auth_runtime", "auth_migrator"),
        resource,
        "migrator",
      ),
    ).toThrow("direct connection");
    expect(() => assertAuthDatabaseProvider(resource, "other-project", "br-fixture")).toThrow(
      "provider identity",
    );
    expect(() => assertAuthDatabaseProvider(resource, "project-fixture", "br-other")).toThrow(
      "provider identity",
    );
  });
  it("enrolls runtime without changing production URL normalization or closed signup", () => {
    const env = readAuthEnvironment({
      VERCEL_ENV: "production",
      AUTH_DATABASE_RESOURCE: JSON.stringify(resource),
      PLATFORM_AUTH_DATABASE_URL: url.replace("verify-full", "require"),
      BETTER_AUTH_URL: "https://apps.autograph.so",
      BETTER_AUTH_SECRET: "x".repeat(32),
      BETTER_AUTH_API_KEY: "fixture",
    });
    expect(env.databaseResource).toEqual(resource);
    expect(env.allowPublicSignUp).toBe(false);
  });
  it("rejects a resource from another environment", () => {
    expect(() =>
      readAuthEnvironment({
        AUTH_DATABASE_RESOURCE: JSON.stringify(resource),
        PLATFORM_AUTH_DATABASE_URL: url,
        BETTER_AUTH_URL: "http://localhost:3000",
        BETTER_AUTH_SECRET: "x".repeat(32),
      }),
    ).toThrow("environment mismatch");
  });
  it("preserves unenrolled and placeholder configurations, but a partial record cannot trigger fallback", () => {
    expect(readAuthEnvironment({}, { allowPlaceholderConfig: true }).usingPlaceholderConfig).toBe(
      true,
    );
    expect(() =>
      readAuthEnvironment({ AUTH_DATABASE_RESOURCE: "" }, { allowPlaceholderConfig: true }),
    ).toThrow();
    expect(
      readAuthEnvironment({
        PLATFORM_AUTH_DATABASE_URL: "postgres://legacy@127.0.0.1/auth_store",
        BETTER_AUTH_URL: "http://localhost:3000",
        BETTER_AUTH_SECRET: "x".repeat(32),
      }).databaseResource,
    ).toBeUndefined();
  });
  it("does not normalize non-Neon pooler-like hostnames", () => {
    const local = {
      ...resource,
      environment: "local" as const,
      neon: undefined,
      hostname: "db.example.com",
    };
    expect(() =>
      assertAuthDatabaseConnection(
        "postgres://auth_runtime:fixture@db-pooler.example.com/auth_store",
        local,
        "runtime",
      ),
    ).toThrow("connection identity mismatch");
  });
  it("requires runtime DML denial for operator-owned assignment, signup, and managed app tables", async () => {
    const statements: string[] = [];
    const database = {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql.startsWith("select pg_catalog.current_database()"))
          return {
            rows: [
              {
                database: resource.database,
                schema: resource.schema,
                role: resource.runtimeRole,
                login: resource.runtimeRole,
              },
            ],
          };
        if (sql.includes("as elevated"))
          return {
            rows: [
              {
                elevated: false,
                database_create: false,
                schema_create: false,
                owns_objects: false,
                migrator_member: false,
              },
            ],
          };
        if (sql.includes("relname as name"))
          return {
            rows: [
              "user",
              "session",
              "account",
              "verification",
              "organization",
              "member",
              "invitation",
              "app_actor_assignment",
              "app_signup_policy",
            ].map((name) => ({ name })),
          };
        return {
          rows: [
            {
              assignment_write: false,
              signup_policy_write: false,
              app_access_write: false,
              app_invitation_write: false,
            },
          ],
        };
      },
    };
    const { verifyAuthDatabaseResource } = await import("../database-resource");
    await expect(
      verifyAuthDatabaseResource(database, resource, "runtime"),
    ).resolves.toBeUndefined();
    const privilegeCheck = statements.at(-1)!;
    expect(privilegeCheck).toContain("public.app_actor_assignment");
    expect(privilegeCheck).toContain("public.app_signup_policy");
    expect(privilegeCheck).toContain("public.app_actor_access");
    expect(privilegeCheck).toContain("public.app_access_invitation");
    await expect(
      verifyAuthDatabaseResource(
        {
          query: async (sql: string) =>
            sql === privilegeCheck
              ? {
                  rows: [
                    {
                      assignment_write: false,
                      signup_policy_write: true,
                      app_access_write: false,
                      app_invitation_write: false,
                    },
                  ],
                }
              : sql.startsWith("select pg_catalog.current_database()")
                ? {
                    rows: [
                      {
                        database: resource.database,
                        schema: resource.schema,
                        role: resource.runtimeRole,
                        login: resource.runtimeRole,
                      },
                    ],
                  }
                : database.query(sql),
        },
        resource,
        "runtime",
      ),
    ).rejects.toThrow("runtime can mutate operator-owned Auth records");
  });
});
