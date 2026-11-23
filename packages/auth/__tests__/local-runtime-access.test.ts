import { describe, expect, it } from "vitest";
import { readLocalAppAccessBinding } from "../local-runtime-access";
import { AuthConfigurationError, type AuthEnvironmentSource } from "../env";
import type { AuthDatabaseResource } from "../database-resource";

const secret = "credential-canary-must-stay-private";
const resource: AuthDatabaseResource = {
  version: 1,
  environment: "local",
  hostname: "127.0.0.1",
  port: 55432,
  database: "local_app_auth",
  schema: "public",
  runtimeRole: "local_auth_runtime",
  migratorRole: "local_auth_migrator",
};
const binding = { version: 1, workspaceId: "app-validation:local:fixture", resource };
const connection = `postgresql://${resource.runtimeRole}:${secret}@127.0.0.1:${resource.port}/${resource.database}?sslmode=disable`;
const environment = (): AuthEnvironmentSource => ({
  PLATFORM_LOCAL_APP_ACCESS: JSON.stringify(binding),
  PLATFORM_AUTH_DATABASE_URL: connection,
  BETTER_AUTH_URL: "http://localhost:3000",
  BETTER_AUTH_SECRET: "synthetic-auth-secret-for-local-fixture-only",
});

const expectClosedFailure = (source: AuthEnvironmentSource) => {
  let caught: unknown;
  try {
    readLocalAppAccessBinding(source);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AuthConfigurationError);
  expect(String(caught)).toBe(
    "AuthConfigurationError: Invalid auth configuration: Invalid local app access binding",
  );
  expect(JSON.stringify(caught)).not.toContain(secret);
  expect(String(caught)).not.toContain(connection);
};

describe("isolated local Auth app admission binding", () => {
  it("returns only the owned workspace and nonsecret local resource", () => {
    const result = readLocalAppAccessBinding(environment());
    expect(result).toEqual(binding);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(connection);
  });

  it("preserves absent local binding without interpreting Production realm configuration", () => {
    expect(
      readLocalAppAccessBinding({
        VERCEL_ENV: "production",
        PLATFORM_REALM_OPERATOR_LINK_CONFIG: "managed by the existing realm reader",
      }),
    ).toBeUndefined();
  });

  it.each([
    "",
    "null",
    "{",
    JSON.stringify({ ...binding, version: 2 }),
    JSON.stringify({ ...binding, workspaceId: "" }),
    JSON.stringify({ ...binding, password: secret }),
    JSON.stringify({ ...binding, resource: { ...resource, password: secret } }),
  ])("rejects malformed or credential-bearing local metadata without exposing it (%#)", (raw) => {
    expectClosedFailure({ ...environment(), PLATFORM_LOCAL_APP_ACCESS: raw });
  });

  it.each([
    {
      ...resource,
      environment: "production",
      hostname: "ep-test.neon.tech",
      neon: { projectId: "project", branchId: "branch" },
    },
    { ...resource, hostname: "remote.invalid" },
    { ...resource, hostname: "localhost" },
    { ...resource, neon: { projectId: "project", branchId: "branch" } },
    { ...resource, database: "another_auth" },
    { ...resource, runtimeRole: "another_runtime" },
    { ...resource, port: 55433 },
  ])("rejects a foreign or hosted resource (%#)", (selected) => {
    expectClosedFailure({
      ...environment(),
      PLATFORM_LOCAL_APP_ACCESS: JSON.stringify({ ...binding, resource: selected }),
    });
  });

  it.each([
    connection.replace(resource.runtimeRole, resource.migratorRole),
    connection.replace("127.0.0.1", "remote.invalid"),
    connection.replace("sslmode=disable", "sslmode=require"),
    connection.replace("?sslmode=disable", ""),
    `${connection}&sslmode=disable`,
    `${connection}&host=remote.invalid`,
    `${connection}&user=${resource.migratorRole}`,
    `${connection}&dbname=another_auth`,
    `${connection}&options=-csearch_path=other`,
    `${connection}#${secret}`,
  ])("rejects a nonruntime or overriding effective connection (%#)", (databaseUrl) => {
    expectClosedFailure({ ...environment(), PLATFORM_AUTH_DATABASE_URL: databaseUrl });
  });

  it.each([
    { PLATFORM_REALM_OPERATOR_LINK_CONFIG: "" },
    { PLATFORM_REALM_OPERATOR_LINK_CONFIG: JSON.stringify({ secret }) },
    { AUTH_PRODUCTION_DATABASE_IDENTITY: "ep-test.neon.tech/platform_auth" },
    { VERCEL_ENV: "production", BETTER_AUTH_API_KEY: "synthetic" },
  ])("does not mix local app access with deployed Auth authority (%#)", (mixed) => {
    expectClosedFailure({ ...environment(), ...mixed });
  });
});
