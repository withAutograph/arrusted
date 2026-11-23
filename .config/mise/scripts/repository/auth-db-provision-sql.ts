import { readAuthCatalogAppIds } from "./auth-app-catalog";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { escapeLiteral, Pool } from "pg";
import { verifyAuthDatabaseResource } from "../../../../packages/auth/database-resource";

import { readAuthEnvironment } from "../../../../packages/auth/env";

const env = readAuthEnvironment(process.env, { databasePurpose: "migrator" });
if (env.databaseResource)
  throw new Error("Enrolled Auth provisioning requires the reviewed schema plan");
const databaseUrl = env.databaseUrl;

if (process.argv.length > 2) throw new Error("Auth provisioning does not accept a phase.");
const statements = await Promise.all(
  ["canonicalize-tenant-ids.sql", "provision-organizations.sql"].map((file) =>
    readFile(fileURLToPath(new URL(`../../../../packages/auth/${file}`, import.meta.url)), "utf8"),
  ),
);
const catalogAppIds = escapeLiteral(JSON.stringify(readAuthCatalogAppIds(process.env)));

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
try {
  if (env.databaseResource)
    await verifyAuthDatabaseResource(pool, env.databaseResource, "migrator");
  for (const statement of statements) {
    await pool.query(
      statement.replace("'__CATALOG_APP_IDS__'::jsonb", () => `${catalogAppIds}::jsonb`),
    );
  }
} finally {
  await pool.end();
}
