#!/usr/bin/env bun
import { Pool } from "pg";

import { readAuthEnvironment } from "../../../../packages/auth/env";
import { parseOrganizationAppIds } from "../../../../packages/auth/server";
import { readAuthCatalogAppIds } from "./auth-app-catalog";

import {
  REQUIRED_AUTH_TABLES,
  verifyAuthDatabaseResource,
} from "../../../../packages/auth/database-resource";

// Historical canonical organizations remain part of the retained Auth migration SQL.
const REQUIRED_ORGANIZATION_ASSIGNMENTS = [
  { id: "hc", name: "HC", slug: "hc", appIds: ["hc"] },
  { id: "vendor", name: "Vendor", slug: "vendor", appIds: ["vendor", "integrations"] },
  {
    id: "dev",
    name: "Dev",
    slug: "dev",
    metadata: '{"signupAccess":"all-apps"}',
    appIds: readAuthCatalogAppIds(process.env),
  },
] as const;

const strict = process.argv.includes("--strict") || process.env.NODE_ENV === "production";
const identityOnly = process.argv.includes("--identity-only");
const unknownArguments = process.argv
  .slice(2)
  .filter((argument) => argument !== "--strict" && argument !== "--identity-only");
if (unknownArguments.length > 0) {
  throw new Error(`Auth schema check does not accept argument: ${unknownArguments[0]}`);
}

try {
  const env = readAuthEnvironment(process.env, {
    allowPlaceholderConfig: !strict,
    databasePurpose: "migrator",
  });
  const pool = new Pool({ connectionString: env.databaseUrl });
  try {
    if (env.databaseResource)
      await verifyAuthDatabaseResource(pool, env.databaseResource, "migrator");
    await checkAuthSchema(pool, env.databaseUrl, identityOnly);
  } finally {
    await pool.end();
  }
} catch (error) {
  if (isAuthConfigurationError(error)) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

async function checkAuthSchema(pool: Pool, databaseUrl: string, stopAfterIdentity: boolean) {
  const identityResult = await pool.query<{
    current_database: string;
    current_schema: string;
    current_user: string;
  }>(
    "select current_database() as current_database, current_schema() as current_schema, current_user as current_user",
  );
  const identity = identityResult.rows[0];
  if (identity?.current_schema !== "public") {
    throw new Error("The Auth database binding must resolve the public schema.");
  }
  const configured = new URL(databaseUrl);
  const configuredDatabase = decodeURIComponent(configured.pathname.slice(1));
  const configuredRole = decodeURIComponent(configured.username);
  if (
    process.env.VERCEL_ENV &&
    (identity?.current_database !== configuredDatabase || identity.current_user !== configuredRole)
  ) {
    throw new Error("The Auth database binding must resolve its configured database and role.");
  }
  if (stopAfterIdentity) {
    console.log("Auth database identity check passed for the provider-owned public schema.");
    return;
  }

  const tableResult = await pool.query<{ table_name: string }>(
    `
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_name = any($1::text[])
    `,
    [[...REQUIRED_AUTH_TABLES]],
  );
  const existingTables = new Set(tableResult.rows.map((row) => row.table_name));
  const missingTables = REQUIRED_AUTH_TABLES.filter((table) => !existingTables.has(table));
  if (missingTables.length > 0) {
    throw new Error(
      `Auth schema is missing table(s): ${missingTables.join(", ")}. Run mise run auth:db:provision before serving auth traffic.`,
    );
  }

  const appIdsColumn = await pool.query<{ data_type: string }>(
    `
      select data_type
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'organization'
        and column_name = 'appIds'
    `,
  );
  if (appIdsColumn.rows[0]?.data_type !== "jsonb") {
    throw new Error(
      "Auth organization.appIds must be a jsonb column. Run mise run auth:db:provision before serving auth traffic.",
    );
  }

  const accountIssuerColumn = await pool.query<{
    data_type: string;
    is_nullable: "NO" | "YES";
  }>(
    `
      select data_type, is_nullable
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'account'
        and column_name = 'issuer'
    `,
  );
  if (
    accountIssuerColumn.rows[0] &&
    (accountIssuerColumn.rows[0].data_type !== "text" ||
      accountIssuerColumn.rows[0].is_nullable !== "YES")
  ) {
    throw new Error(
      "Auth account.issuer must be a nullable legacy text column when present. Run mise run auth:db:provision before serving auth traffic.",
    );
  }

  const duplicateAccounts = await pool.query(
    `
      select 1
      from "public"."account"
      group by "providerId", "accountId"
      having count(*) > 1
      limit 1
    `,
  );
  if (duplicateAccounts.rowCount) {
    throw new Error(
      "Auth account identities must be unique by (providerId, accountId). Resolve duplicate accounts before serving auth traffic.",
    );
  }

  const assignmentResult = await pool.query<{
    id: string;
    name: string;
    slug: string;
    metadata: string | null;
    app_ids: unknown;
  }>(
    `
      select "id", "name", "slug", "metadata", "appIds" as app_ids
      from "public"."organization"
      where "id" = any($1::text[])
    `,
    [REQUIRED_ORGANIZATION_ASSIGNMENTS.map(({ id }) => id)],
  );
  const assignments = new Map(assignmentResult.rows.map((row) => [row.id, row]));
  const invalidAssignments = REQUIRED_ORGANIZATION_ASSIGNMENTS.filter((expected) => {
    const actual = assignments.get(expected.id);
    return (
      !actual ||
      actual.name !== expected.name ||
      actual.slug !== expected.slug ||
      actual.metadata !== ("metadata" in expected ? expected.metadata : null) ||
      !hasCanonicalAppIds(actual.app_ids, expected.appIds)
    );
  });
  if (invalidAssignments.length > 0) {
    throw new Error(
      `Auth organization assignment is missing or stale for: ${invalidAssignments.map(({ id }) => id).join(", ")}. Run mise run auth:db:provision before serving auth traffic.`,
    );
  }

  console.log(
    `Auth schema check passed for the provider-owned public schema with ${REQUIRED_AUTH_TABLES.length} required table(s) and ${REQUIRED_ORGANIZATION_ASSIGNMENTS.length} canonical organization assignment(s).`,
  );
}

function hasCanonicalAppIds(actual: unknown, expected: readonly string[]) {
  const parsed = parseOrganizationAppIds(actual);
  return parsed !== null && expected.every((appId) => parsed.includes(appId));
}

function isAuthConfigurationError(error: unknown): error is { message: string } {
  if (!error || typeof error !== "object") {
    return false;
  }
  return (
    "code" in error &&
    error.code === "auth_configuration_error" &&
    "message" in error &&
    typeof error.message === "string"
  );
}
