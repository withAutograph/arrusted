// @vitest-environment node
import { expect, it } from "vitest";
import {
  assertAuthOperatorConnection,
  verifyAuthOperatorConnection,
} from "../../protected-installer/auth-operator";

const resource = {
  environment: "production" as const,
  hostname: "ep-auth.neon.tech",
  port: 5432,
  database: "auth",
  schema: "public",
  migratorRole: "auth_owner",
  runtimeRole: "auth_runtime",
};
const connection = "postgres://auth_operator:private@ep-auth.neon.tech/auth?sslmode=verify-full";
const capabilities = {
  elevated: false,
  membership: false,
  delegated_role: false,
  owns_database: false,
  database_create: false,
  schema_create: false,
  owns_objects: false,
  sequence_access: false,
};
const privilege = {
  schema: "public",
  table: "app_actor_assignment",
  column: "active",
  select: true,
  insert: true,
  update: true,
  reference: false,
  other_write: false,
};
const helper = {
  schema: "public",
  name: "lock_auth_operator_member",
  owner: "auth_owner",
  arguments: "text, text",
  configuration: ["search_path=pg_catalog, public"],
};
function database(
  input: {
    identity?: Record<string, unknown>;
    capabilities?: Record<string, unknown>;
    privileges?: Record<string, unknown>[];
    functions?: Record<string, unknown>[];
  } = {},
) {
  const replies = [
    [
      {
        database: "auth",
        schema: "public",
        role: "auth_operator",
        login: "auth_operator",
        ...input.identity,
      },
    ],
    [{ ...capabilities, ...input.capabilities }],
    input.privileges ?? [privilege],
    input.functions ?? [helper],
  ];
  return { query: async () => ({ rows: replies.shift() ?? [] }) };
}

it("accepts the separate direct operational principal", async () => {
  expect(() => assertAuthOperatorConnection(connection, resource, "auth_operator")).not.toThrow();
  await expect(
    verifyAuthOperatorConnection(database(), resource, "auth_operator"),
  ).resolves.toBeUndefined();
});

it.each([
  connection.replace("auth_operator:", "auth_owner:"),
  connection.replace("auth_operator:", "auth_runtime:"),
  connection.replace("ep-auth.", "ep-auth-pooler."),
  connection.replace("/auth?", "/other?"),
  connection.replace("verify-full", "require"),
  `${connection}&sslmode=disable`,
  `${connection}&channel_binding=disable`,
  `${connection}&options=-crole=auth_owner`,
])("rejects an unapproved or overridden connection", (value) => {
  expect(() => assertAuthOperatorConnection(value, resource, "auth_operator")).toThrow();
});

it("keeps local transport explicit and cannot alias the schema or runtime role", () => {
  const local = { ...resource, environment: "local" as const, hostname: "127.0.0.1" };
  expect(() =>
    assertAuthOperatorConnection(
      "postgres://auth_operator@127.0.0.1/auth?sslmode=disable",
      local,
      "auth_operator",
    ),
  ).not.toThrow();
  for (const role of [resource.migratorRole, resource.runtimeRole])
    expect(() => assertAuthOperatorConnection(connection, resource, role)).toThrow();
});

it.each(Object.keys(capabilities))("rejects effective elevated capability %s", async (key) => {
  await expect(
    verifyAuthOperatorConnection(
      database({ capabilities: { [key]: true } }),
      resource,
      "auth_operator",
    ),
  ).rejects.toThrow();
});

it("rejects SET ROLE impersonation", async () => {
  await expect(
    verifyAuthOperatorConnection(
      database({ identity: { login: "auth_owner" } }),
      resource,
      "auth_operator",
    ),
  ).rejects.toThrow();
});

it.each([
  { table: "user", column: "emailVerified", update: true },
  { table: "session", column: "token", select: true },
  { table: "member", column: "role", insert: true },
  { table: "organization", column: "metadata", update: true },
  { table: "account", column: "password", select: true },
  { table: "app_actor_assignment", column: "role", update: true },
  { table: "app_actor_access", column: "workspaceId", update: true },
  { table: "app_access_invitation", column: "email", update: true },
  { table: "app_access_invitation", column: "id", other_write: true },
])("rejects privilege outside the operational surface: $table.$column", async (excess) => {
  const denied = { ...privilege, select: false, insert: false, update: false, ...excess };
  await expect(
    verifyAuthOperatorConnection(database({ privileges: [denied] }), resource, "auth_operator"),
  ).rejects.toThrow();
});

it.each([
  { schema: "other" },
  { arguments: "text, integer" },
  { owner: "auth_operator" },
  { configuration: ["search_path=public"] },
  { name: "unreviewed_admin_function" },
])("rejects a callable untrusted definer helper", async (change) => {
  await expect(
    verifyAuthOperatorConnection(
      database({ functions: [{ ...helper, ...change }] }),
      resource,
      "auth_operator",
    ),
  ).rejects.toThrow();
});
