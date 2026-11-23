import { readFileSync } from "node:fs";
import { Pool } from "pg";
import {
  assertAuthDatabaseConnection,
  type AuthDatabaseResource,
} from "../../../../packages/auth/database-resource";
import { createAuthSchemaOptions } from "./auth-enrolled-provision";
import { planAuthSchemaMigration, proposeEmptyAuthSchemaMigration } from "./auth-schema-history";

/** Private producer input: credentials stay in the trusted sandbox's separate file. */
export async function proposeAuthSchemaMigration(input: {
  resource: AuthDatabaseResource;
  catalogAppIds?: string[];
  authOperatorRole?: string;
  directMigrationUrlFile?: string;
}) {
  if (input.directMigrationUrlFile === undefined)
    return await proposeEmptyAuthSchemaMigration(input);
  const connectionString = readFileSync(input.directMigrationUrlFile, "utf8");
  assertAuthDatabaseConnection(connectionString, input.resource, "migrator");
  // The planner holds its advisory lock while Better Auth uses the second connection.
  const pool = new Pool({ connectionString, max: 2 });
  try {
    const schemaPlan = await planAuthSchemaMigration({
      pool,
      resource: input.resource,
      options: createAuthSchemaOptions(pool),
      ...(input.catalogAppIds === undefined ? {} : { catalogAppIds: input.catalogAppIds }),
      ...(input.authOperatorRole === undefined ? {} : { authOperatorRole: input.authOperatorRole }),
    });
    return { version: 1 as const, resource: input.resource, schemaPlan };
  } finally {
    await pool.end();
  }
}
