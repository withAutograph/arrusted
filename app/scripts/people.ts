import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { addPerson, normalizeEmail, removePerson } from "../../packages/auth/people";
import { createSingleOrganizationAuth } from "../../packages/auth/single-organization";
import { readAppConfig } from "./app-config";
import {
  ENV_LOCAL,
  ENV_MIGRATE,
  ENV_PROD_MIGRATE,
  ENV_PROD_SECRETS,
  readEnv,
} from "./local-secrets";
import { confirm, loopback } from "./production-gate";
import { SafeError, reportError } from "./safe-output";

export function safeEmailFileName(email: string): string {
  return (
    email
      .replace(/[^a-z0-9._-]+/g, "_")
      .replace(/\.{2,}/g, "_")
      .replace(/^[._]+|[._]+$/g, "") || "person"
  );
}

export function writePersonLink(appDir: string, email: string, link: string): string {
  const localDir = path.join(appDir, ".local");
  const peopleDir = path.join(localDir, "people");
  mkdirSync(peopleDir, { recursive: true, mode: 0o700 });
  chmodSync(localDir, 0o700);
  chmodSync(peopleDir, 0o700);
  const filePath = path.join(peopleDir, `${safeEmailFileName(email)}.txt`);
  writeFileSync(filePath, `${link}\n`, { mode: 0o600 });
  chmodSync(filePath, 0o600);
  return filePath;
}

if (import.meta.main) {
  let redactEnv: Record<string, string | undefined> = process.env;
  try {
    const args = process.argv.slice(2);
    const flags = args.filter((a) => a.startsWith("-"));
    const production = flags.includes("--production");
    const positional = args.filter((a) => !a.startsWith("-"));
    if (
      flags.some((f) => f !== "--production") ||
      flags.length > 1 ||
      positional.length !== 2 ||
      !["add", "remove"].includes(positional[0]!)
    )
      throw new SafeError("Usage: bun run people <add|remove> <email> [--production]");
    const [action, rawEmail] = positional as ["add" | "remove", string];
    const email = normalizeEmail(rawEmail);
    const appDir = path.resolve(import.meta.dirname, "..");
    const config = readAppConfig(appDir);

    let databaseUrl: string | undefined;
    let origin: string | undefined;
    let secret: string | undefined;
    if (production) {
      const migratePath = path.join(appDir, ENV_PROD_MIGRATE);
      const secretsPath = path.join(appDir, ENV_PROD_SECRETS);
      if (!existsSync(migratePath) || !existsSync(secretsPath))
        throw new SafeError(
          `Missing ${ENV_PROD_MIGRATE} or ${ENV_PROD_SECRETS}. Run bun run setup:env --production and edit them in a local editor first.`,
        );
      const prodMigrate = readEnv(migratePath);
      const prodSecrets = readEnv(secretsPath);
      redactEnv = { ...process.env, ...prodSecrets, ...prodMigrate };
      databaseUrl = prodMigrate.MIGRATION_DATABASE_URL || undefined;
      origin = prodSecrets.BETTER_AUTH_URL || undefined;
      secret = prodSecrets.BETTER_AUTH_SECRET || undefined;
    } else {
      const localSecrets = readEnv(path.join(appDir, ENV_LOCAL));
      const localMigrate = readEnv(path.join(appDir, ENV_MIGRATE));
      redactEnv = { ...process.env, ...localSecrets, ...localMigrate };
      databaseUrl = process.env.MIGRATION_DATABASE_URL || localMigrate.MIGRATION_DATABASE_URL;
      origin = process.env.BETTER_AUTH_URL || localSecrets.BETTER_AUTH_URL;
      secret = process.env.BETTER_AUTH_SECRET || localSecrets.BETTER_AUTH_SECRET;
    }
    if (!databaseUrl || !origin || !secret)
      throw new SafeError(
        production
          ? `Configure MIGRATION_DATABASE_URL in ${ENV_PROD_MIGRATE}, and BETTER_AUTH_URL and BETTER_AUTH_SECRET in ${ENV_PROD_SECRETS}.`
          : `Configure MIGRATION_DATABASE_URL in ${ENV_MIGRATE}, and BETTER_AUTH_URL and BETTER_AUTH_SECRET in ${ENV_LOCAL}.`,
      );
    const isLocal = loopback(databaseUrl);
    if (production && isLocal)
      throw new SafeError("Production MIGRATION_DATABASE_URL must not target a loopback host.");
    if (production || !isLocal) {
      console.log(
        `${action === "add" ? "Add or reset sign-in link for" : "Remove"} ${email} in ${config.name}.`,
      );
      await confirm();
    }
    const parsed = new URL(databaseUrl);
    if (!parsed.searchParams.has("sslmode"))
      parsed.searchParams.set("sslmode", isLocal ? "disable" : "verify-full");
    const pool = new Pool({ connectionString: parsed.toString(), max: 2 });
    try {
      const { auth } = createSingleOrganizationAuth({
        database: pool,
        origin,
        secret,
        ...config,
      });
      if (action === "add") {
        const result = await addPerson({ pool, auth, origin, email });
        const filePath = writePersonLink(appDir, result.email, result.link);
        console.log(filePath);
        console.log(
          "Open this file yourself and send the link privately; it works once and expires in 7 days.",
        );
      } else {
        const removed = await removePerson({
          pool,
          organizationId: config.organizationId,
          email,
        });
        if (!removed) throw new SafeError("No person found with that email.");
        rmSync(path.join(appDir, ".local/people", `${safeEmailFileName(email)}.txt`), {
          force: true,
        });
        console.log(`Removed ${email}.`);
      }
    } finally {
      await pool.end();
    }
  } catch (error) {
    reportError(error, "People", redactEnv);
    process.exitCode = 1;
  }
}
