import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import {
  ENV_PROD_MIGRATE,
  ENV_PROD_SECRETS,
  applyProductionNeonEnv,
  readEnv,
} from "./local-secrets";
import { connectionTarget, migrate, runtimeRoles } from "./migrate";
import {
  confirm,
  gateIO,
  loopback,
  preflight,
  resolveAppName,
  resolveDeployCwd,
  type GateIO,
} from "./production-gate";
import { SafeError, redact, reportError } from "./safe-output";

const app = path.resolve(import.meta.dirname, "..");
const root = path.resolve(app, "..");

type Field = {
  id: string;
  name?: string;
  label?: string;
  required?: boolean;
  is_unique?: boolean;
  lifecycle?: string;
  type?: unknown;
};
type Model = Field & { fields: Field[] };
export type Schema = { models: Model[] };
type Artifact = {
  schema: Schema;
  extras?: {
    model_metadata?: { model: string; name?: string }[];
    field_metadata?: { model: string; field: string; name?: string }[];
  };
};
export function schemaForPlan(artifact: Artifact): Schema {
  return {
    models: artifact.schema.models
      .filter((model) => model.lifecycle !== "retired")
      .map((model) => ({
        ...model,
        name:
          artifact.extras?.model_metadata?.find((item) => item.model === model.id)?.name ??
          model.name,
        fields: model.fields
          .filter((field) => field.lifecycle !== "retired")
          .map((field) => ({
            ...field,
            name:
              artifact.extras?.field_metadata?.find(
                (item) => item.model === model.id && item.field === field.id,
              )?.name ?? field.name,
          })),
      })),
  };
}
export function schemaPlan(previous: Schema | undefined, next: Schema) {
  const lines: string[] = [];
  const name = (item: Field) => item.name ?? item.label ?? item.id;
  for (const model of next.models) {
    const old = previous?.models.find((m) => m.id === model.id);
    if (!old) lines.push(`Add table ${name(model)}; existing tables and records are kept.`);
    else if (name(old) !== name(model))
      lines.push(`Rename table ${name(old)} to ${name(model)}; existing data stays.`);
    for (const field of model.fields) {
      const before = old?.fields.find((f) => f.id === field.id);
      if (!before)
        lines.push(
          `Add field ${name(model)}.${name(field)}${field.required ? " (required; existing missing values stop migration, with no automatic fill)" : " (optional; existing records remain empty)"}.`,
        );
      else {
        if (name(before) !== name(field))
          lines.push(
            `Rename ${name(model)}.${name(before)} to ${name(field)}; existing values stay.`,
          );
        if (!before.required && field.required)
          lines.push(
            `Require ${name(model)}.${name(field)}; existing missing values stop migration; no automatic fill.`,
          );
        if (before.required && !field.required)
          lines.push(`Make ${name(model)}.${name(field)} optional; existing values stay.`);
        if (before.is_unique && !field.is_unique)
          lines.push(`Allow duplicate ${name(model)}.${name(field)} values; existing values stay.`);
        if (JSON.stringify(before.type) !== JSON.stringify(field.type))
          lines.push(
            `Change type of ${name(model)}.${name(field)} requested; types are immutable, so migration will refuse. Add a new field, copy values, then archive the old field.`,
          );
        if (!before.is_unique && field.is_unique)
          lines.push(
            `Require unique ${name(model)}.${name(field)}; existing duplicates stop migration.`,
          );
      }
    }
    for (const field of old?.fields ?? [])
      if (!model.fields.some((f) => f.id === field.id))
        lines.push(
          `Archive ${name(model)}.${name(field)}; historical values remain, hidden from active use. IDs cannot be reused.`,
        );
  }
  for (const model of previous?.models ?? [])
    if (!next.models.some((m) => m.id === model.id))
      lines.push(
        `Archive table ${name(model)}; history remains, hidden from active use. IDs cannot be reused.`,
      );
  return lines.length
    ? lines.join("\n")
    : "No table or field changes. Existing data stays unchanged; compiler/runtime updates may still apply.";
}
export async function appliedRelease(
  databaseUrl: string,
): Promise<{ release_hash: string; schema: Schema } | undefined> {
  const { url } = connectionTarget(databaseUrl);
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    if (
      !(await pool.query("select to_regclass('public.autograph_applied_schema') as present"))
        .rows[0]?.present
    )
      return;
    const row = (
      await pool.query(
        "select release_hash,artifact from autograph_applied_schema order by applied_at desc,id desc limit 1",
      )
    ).rows[0];
    return row
      ? { release_hash: row.release_hash, schema: schemaForPlan(JSON.parse(row.artifact)) }
      : undefined;
  } finally {
    await pool.end();
  }
}
export function compiled() {
  return {
    hash: createHash("sha256")
      .update(readFileSync(path.join(app, ".generated/release/release-manifest.json")))
      .digest("hex"),
    schema: schemaForPlan(
      JSON.parse(readFileSync(path.join(app, ".generated/release/app-artifact.json"), "utf8")),
    ),
  };
}
export interface ReleaseIO {
  gate: GateIO;
  plan(): Promise<string>;
  migrate(): Promise<void>;
  matches(): Promise<boolean>;
  deploy(): string | void;
}
export async function release(
  io: ReleaseIO,
  localOnly = false,
  options: { checkOnly?: boolean } = {},
) {
  await preflight(localOnly, io.gate, { requireTty: !options.checkOnly });
  io.gate.log("Computing schema plan…");
  io.gate.log(await io.plan());
  if (options.checkOnly) {
    io.gate.log("Check passed. No database migration or deployment was run.");
    return;
  }
  const appName = resolveAppName(io.gate);
  io.gate.log(
    `Create a restore point, apply the schema, verify the applied release, then deploy ${appName} to production.`,
  );
  await confirm(io.gate);
  io.gate.log("Creating restore point and applying database migration…");
  await io.migrate();
  io.gate.log("Verifying applied release matches compiled release…");
  if (!(await io.matches()))
    throw new SafeError(
      "Migration completed but the applied release differs from the compiled release. Deployment stopped; inspect locally before retrying.",
    );
  io.gate.log(`Deploying ${appName} to Vercel production…`);
  let deploymentUrl: string | void;
  try {
    deploymentUrl = io.deploy();
  } catch (error) {
    const detail =
      error instanceof Error && error.message ? ` Details: ${redact(error.message)}` : "";
    throw new SafeError(
      `Database migration succeeded; production deployment failed or its result is unknown.${detail} Existing deployment may still be serving. Retry bun run release from this same source, or run bun run migrate:undo --production to restore the recorded point (later data edits are lost), then restore the reported source commit and release it.`,
    );
  }
  io.gate.log(
    deploymentUrl
      ? `Production deployment live: ${deploymentUrl}`
      : "Production deployment completed.",
  );
}

export function resolveProductionEnv(
  appDir = app,
  targetEnv: Record<string, string | undefined> = process.env,
): {
  migrationDatabaseUrl?: string;
  appDatabaseUrl?: string;
  authDatabaseUrl?: string;
  secretEnv: Record<string, string | undefined>;
} {
  const prodSecretsPath = path.join(appDir, ENV_PROD_SECRETS);
  const prodMigratePath = path.join(appDir, ENV_PROD_MIGRATE);
  const hasProdSecrets = existsSync(prodSecretsPath);
  const hasProdMigrate = existsSync(prodMigratePath);
  const prodRuntime = hasProdSecrets ? readEnv(prodSecretsPath) : {};
  const prodMigrate = hasProdMigrate ? readEnv(prodMigratePath) : {};
  const secretEnv: Record<string, string | undefined> = {
    ...targetEnv,
    ...prodRuntime,
    ...prodMigrate,
  };
  applyProductionNeonEnv(prodMigrate, targetEnv);
  // When production files exist, read runtime DB URLs from them rather than .env.local.
  const migrationDatabaseUrl = hasProdMigrate
    ? prodMigrate.MIGRATION_DATABASE_URL || undefined
    : targetEnv.MIGRATION_DATABASE_URL;
  const appDatabaseUrl = hasProdSecrets
    ? prodRuntime.APP_DATABASE_URL || undefined
    : targetEnv.APP_DATABASE_URL;
  const authDatabaseUrl = hasProdSecrets
    ? prodRuntime.AUTH_DATABASE_URL || undefined
    : targetEnv.AUTH_DATABASE_URL;
  return {
    migrationDatabaseUrl,
    appDatabaseUrl,
    authDatabaseUrl,
    secretEnv,
  };
}

export function validateProductionDatabaseUrls(input: {
  migrationDatabaseUrl?: string;
  appDatabaseUrl?: string;
  authDatabaseUrl?: string;
}) {
  const { migrationDatabaseUrl, appDatabaseUrl, authDatabaseUrl } = input;
  if (!migrationDatabaseUrl || !appDatabaseUrl)
    throw new SafeError(
      `Configure MIGRATION_DATABASE_URL in ${ENV_PROD_MIGRATE} and APP_DATABASE_URL in ${ENV_PROD_SECRETS} in a local editor first.`,
    );
  for (const [name, value] of [
    ["MIGRATION_DATABASE_URL", migrationDatabaseUrl],
    ["APP_DATABASE_URL", appDatabaseUrl],
    ...(authDatabaseUrl ? ([["AUTH_DATABASE_URL", authDatabaseUrl]] as const) : []),
  ] as const) {
    if (loopback(value))
      throw new SafeError(`${name} must not target a loopback host for production.`);
  }
  return runtimeRoles(migrationDatabaseUrl, appDatabaseUrl, authDatabaseUrl);
}

if (import.meta.main) {
  let redactEnv: Record<string, string | undefined> = process.env;
  try {
    const args = process.argv.slice(2);
    const allowed = new Set(["--local-only-repo", "--check"]);
    if (args.some((a) => !allowed.has(a)) || new Set(args).size !== args.length)
      throw new SafeError("Usage: bun run release [--check] [--local-only-repo]");
    const checkOnly = args.includes("--check");
    const localOnly = args.includes("--local-only-repo");
    const env = resolveProductionEnv();
    redactEnv = env.secretEnv;
    const roles = validateProductionDatabaseUrls(env);
    const databaseUrl = env.migrationDatabaseUrl!;
    const deployCwd = resolveDeployCwd(app, root);
    await release(
      {
        gate: gateIO,
        plan: async () =>
          schemaPlan((await appliedRelease(databaseUrl))?.schema, compiled().schema),
        migrate: async () => {
          await migrate({
            databaseUrl,
            ...roles,
          });
        },
        matches: async () => (await appliedRelease(databaseUrl))?.release_hash === compiled().hash,
        deploy: () => {
          try {
            const stdout = execFileSync("vercel", ["deploy", "--prod"], {
              cwd: deployCwd,
              encoding: "utf8",
              stdio: ["ignore", "pipe", "pipe"],
            });
            const urls = stdout.match(/https:\/\/[^\s]+/g);
            return urls?.at(-1);
          } catch (error) {
            const err = error as { stderr?: Buffer | string; stdout?: Buffer | string };
            const output = [err.stderr, err.stdout]
              .map((p) =>
                Buffer.isBuffer(p) ? p.toString("utf8") : typeof p === "string" ? p : "",
              )
              .map((p) => p.trim())
              .filter(Boolean)
              .join("\n");
            throw new Error(redact(output || "vercel deploy failed", redactEnv));
          }
        },
      },
      localOnly,
      { checkOnly },
    );
  } catch (error) {
    reportError(error, "Release (deployment was not started unless reported above)", redactEnv);
    process.exitCode = 1;
  }
}
