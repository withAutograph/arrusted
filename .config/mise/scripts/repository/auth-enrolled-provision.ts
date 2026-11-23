#!/usr/bin/env bun
import { readAuthCatalogAppIds } from "./auth-app-catalog";
import { parse } from "@libpg-query/parser";
import { escapeLiteral, Pool } from "pg";
import type { PoolClient } from "pg";
import { createAuthOptions } from "../../../../packages/auth/server";
// @ts-ignore The Vite and Bun worker bundlers resolve the SQL raw suffix.
import canonicalizationSql from "../../../../packages/auth/canonicalize-tenant-ids.sql?raw";
// @ts-ignore The Vite and Bun worker bundlers resolve the SQL raw suffix.
import provisionOrganizationsSql from "../../../../packages/auth/provision-organizations.sql?raw";
import { readAuthEnvironment } from "../../../../packages/auth/env";
import type { BetterAuthOptions } from "better-auth";
import {
  applyAuthSchemaMigration,
  originalParsedStatement,
  planAuthSchemaMigration,
} from "./auth-schema-history";

/** Canonicalization and organization upsert either both commit or both roll back. */
export async function provisionEnrolledAuthAccess(
  client: PoolClient,
  catalogAppIds: string[],
): Promise<void> {
  await client.query("begin");
  try {
    const canonicalSource = canonicalizationSql;
    if (!/^begin;\s*/iu.test(canonicalSource) || !/\s*commit;\s*$/iu.test(canonicalSource))
      throw new Error("Unexpected canonicalization transaction boundary");
    const canonicalSql = canonicalSource
      .replace(/^begin;\s*/iu, "")
      .replace(/\s*commit;\s*$/iu, "");
    const canonicalStatements = await parse(canonicalSql);
    if (
      (canonicalStatements.stmts ?? []).some(
        (statement) => "TransactionStmt" in (statement.stmt ?? {}),
      )
    )
      throw new Error("Nested canonicalization transaction is forbidden");
    await client.query(canonicalSql);
    const source = provisionOrganizationsSql;
    const parsed = await parse(source);
    const parsedStatements = parsed.stmts ?? [];
    if (
      parsedStatements.some((statement) => {
        const node = statement.stmt ?? {};
        return !(
          "CreateStmt" in node ||
          "IndexStmt" in node ||
          "AlterTableStmt" in node ||
          "InsertStmt" in node ||
          "TransactionStmt" in node
        );
      })
    )
      throw new Error("Unexpected access provisioning statements");
    const statements = parsedStatements.filter(
      (statement) => "InsertStmt" in (statement.stmt ?? {}),
    );
    if (statements.length !== 1) throw new Error("Unexpected access provisioning statements");
    // Enrolled databases do not run the bootstrap SQL file wholesale. Apply its
    // additive assignment-table DDL in this migration transaction before the
    // organization upsert so existing Auth resources gain the same fence fields
    // as newly provisioned databases.
    for (const statement of parsedStatements) {
      const node = statement.stmt ?? {};
      if ("TransactionStmt" in node || "InsertStmt" in node) continue;
      await client.query(originalParsedStatement(source, statement));
    }
    await client.query(
      originalParsedStatement(source, statements[0]!).replace(
        "'__CATALOG_APP_IDS__'::jsonb",
        () => `${escapeLiteral(JSON.stringify(catalogAppIds))}::jsonb`,
      ),
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

/**
 * Build the fixed Auth schema model without loading provider credentials or
 * deployment-specific runtime settings. Optional identity providers do not
 * contribute PostgreSQL schema; both planning and protected execution use this
 * same model.
 */
export function createAuthSchemaOptions(database: Pool): BetterAuthOptions {
  return createAuthOptions({
    appName: "Autograph",
    databasePurpose: "migrator",
    allowPlaceholderConfig: true,
    env: {},
    databaseOverride: database,
  });
}

async function main() {
  const [operation] = process.argv.slice(2);
  if (!["plan", "apply"].includes(operation ?? "") || process.argv.length !== 3)
    throw new Error("Enrolled Auth schema operation requires plan or apply");
  const env = readAuthEnvironment(process.env, { databasePurpose: "migrator" });
  if (!env.databaseResource)
    throw new Error("Auth schema history requires AUTH_DATABASE_RESOURCE enrollment");
  const authOperatorRole = process.env.AUTH_MANAGED_OPERATOR_ROLE;
  if (operation === "apply" && authOperatorRole !== undefined)
    throw new Error(
      "Production Auth operator permissions require the protected schema-only worker",
    );
  if (process.env.AUTH_SCHEMA_PREVIEW_ARTIFACT_FILE)
    throw new Error("Preview deployment artifacts are not supported by this provisioning command");
  const catalogAppIds = readAuthCatalogAppIds(process.env);
  // Planning holds one connection for the advisory lock while Better Auth
  // introspection uses options.database through another pooled connection.
  const pool = new Pool({ connectionString: env.databaseUrl, max: 2 });
  const options = createAuthSchemaOptions(pool);
  const input = {
    pool,
    options,
    resource: env.databaseResource,
    catalogAppIds,
    authOperatorRole,
  };
  try {
    const result =
      operation === "plan"
        ? await planAuthSchemaMigration(input)
        : await applyAuthSchemaMigration({
            ...input,
            approvedDigest: process.env.AUTH_SCHEMA_MIGRATION_PLAN_DIGEST ?? "",
            // Existing access provisioning remains its own authority and is replayable after schema verification.
            afterSchema: (client) => provisionEnrolledAuthAccess(client, catalogAppIds),
          });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await pool.end();
  }
}
if (import.meta.main)
  await main().catch((error) => {
    // Driver messages can contain connection detail or DDL values. Output only controlled categories.
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "invalid_enrolled_schema_operation";
    console.error(`Auth schema operation failed: ${code}`);
    process.exit(1);
  });
