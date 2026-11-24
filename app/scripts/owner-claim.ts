import { existsSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { readAppConfig } from "./app-config";
import { ENV_MIGRATE, ENV_PROD_MIGRATE, readEnv } from "./local-secrets";
import { confirm } from "./production-gate";
import { SafeError, reportError } from "./safe-output";

/** Explicit upgrade recovery, never an automatic promotion at sign-in. */
export async function claimOwner(
  databaseUrl: string,
  email: string,
  organizationId = readAppConfig().organizationId,
) {
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `signup:${organizationId}`,
    ]);
    if (
      (
        await client.query(`select 1 from member where "organizationId"=$1 and role='owner'`, [
          organizationId,
        ])
      ).rowCount
    )
      throw new SafeError("An owner already exists; recovery was refused.");
    const result = await client.query(
      `update member set role='owner' where "organizationId"=$1
      and "userId" in (select id from "user" where lower(email)=$2) returning id`,
      [organizationId, email.trim().toLowerCase()],
    );
    if (result.rowCount !== 1)
      throw new SafeError("Choose exactly one existing deployment member.");
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const production = args.includes("--production");
    const positional = args.filter((a) => a !== "--production");
    const appDir = path.resolve(import.meta.dirname, "..");
    let databaseUrl = process.env.MIGRATION_DATABASE_URL;
    if (production) {
      const prodFile = path.join(appDir, ENV_PROD_MIGRATE);
      if (!existsSync(prodFile))
        throw new SafeError(
          `Missing ${ENV_PROD_MIGRATE}. Run bun run setup:env --production and edit it in a local editor first.`,
        );
      databaseUrl = readEnv(prodFile).MIGRATION_DATABASE_URL || undefined;
    } else if (!databaseUrl) {
      const localFile = path.join(appDir, ENV_MIGRATE);
      if (existsSync(localFile)) databaseUrl = readEnv(localFile).MIGRATION_DATABASE_URL;
    }
    if (positional.length !== 1 || !databaseUrl)
      throw new SafeError(
        "Usage: bun run owner:claim [--production] <existing-member-email>, with MIGRATION_DATABASE_URL configured locally.",
      );
    await confirm();
    await claimOwner(databaseUrl, positional[0]!);
    console.log("Existing member is now the owner.");
  } catch (error) {
    reportError(error, "Owner recovery");
    process.exitCode = 1;
  }
}
