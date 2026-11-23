#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import path from "node:path";

import { Pool } from "pg";
import { verifyAuthDatabaseResource } from "../../../../packages/auth/database-resource";

import { readAuthEnvironment } from "../../../../packages/auth/env";

if (process.argv.length > 2) {
  throw new Error("Auth account schema compatibility does not accept arguments.");
}

const env = readAuthEnvironment(process.env, { databasePurpose: "migrator" });
const databaseUrl = env.databaseUrl;
const migration = await readFile(
  path.join(import.meta.dir, "../../../../packages/auth/relax-account-issuer-v1.7.3.sql"),
  "utf8",
);
const pool = new Pool({ connectionString: databaseUrl, max: 1 });

try {
  if (env.databaseResource)
    await verifyAuthDatabaseResource(pool, env.databaseResource, "migrator");
  await pool.query(migration);
} finally {
  await pool.end();
}
