import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { confirm, gateIO, loopback, type GateIO } from "./production-gate";
import { SafeError, redact, reportError } from "./safe-output";

export const ENV_LOCAL = ".env.local";
export const ENV_MIGRATE = ".env.migrate";
export const ENV_PROD_SECRETS = ".env.production.secrets";
export const ENV_PROD_MIGRATE = ".env.production.migrate";
export const NEON_ENV_KEYS = ["NEON_API_KEY", "NEON_PROJECT_ID", "NEON_BRANCH_ID"] as const;

export const secret = () => randomBytes(32).toString("base64url");

/** In production mode, Neon restore-point settings come only from .env.production.migrate. */
export function applyProductionNeonEnv(
  prodMigrate: Record<string, string>,
  targetEnv: Record<string, string | undefined> = process.env,
) {
  for (const key of NEON_ENV_KEYS) {
    if (prodMigrate[key]) targetEnv[key] = prodMigrate[key];
    else delete targetEnv[key];
  }
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost")
  );
}

export function readEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .flatMap((line) => {
        const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
        if (!match) return [];
        let value = match[2]!;
        if (value.startsWith('"')) {
          try {
            value = JSON.parse(value);
          } catch {
            throw new SafeError("Invalid local env file; inspect it in a local editor.");
          }
        } else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
        return [[match[1]!, value]];
      }),
  );
}

export function putEnv(
  file: string,
  values: Record<string, string>,
  replace = false,
  headerComment?: string,
) {
  const existing = readEnv(file);
  const existed = existsSync(file);
  let text = existed ? readFileSync(file, "utf8") : headerComment ? `${headerComment}\n` : "";
  const added: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (key in existing && !replace) continue;
    const line = `${key}=${JSON.stringify(value)}`;
    if (key in existing) text = text.replace(new RegExp(`^${key}=.*$`, "m"), () => line);
    else text += `${text.endsWith("\n") || !text ? "" : "\n"}${line}\n`;
    added.push(key);
  }
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
  return added;
}

export function setupEnv(directory: string, log = console.log, production = false) {
  if (production) {
    const runtime = path.join(directory, ENV_PROD_SECRETS);
    const migration = path.join(directory, ENV_PROD_MIGRATE);
    for (const name of putEnv(
      runtime,
      {
        APP_DATABASE_URL: "",
        BETTER_AUTH_URL: "",
        BETTER_AUTH_SECRET: secret(),
      },
      false,
      "# Production runtime values. Edit in a local editor; never paste into chat. Not auto-loaded by Next or Bun.",
    ))
      log(name);
    for (const name of putEnv(
      migration,
      {
        MIGRATION_DATABASE_URL: "",
      },
      false,
      "# Production migration owner URL. Edit in a local editor; never paste into chat or Next env files.",
    ))
      log(name);
    log(
      `Prepared ${ENV_PROD_SECRETS} and ${ENV_PROD_MIGRATE}. Fill APP_DATABASE_URL, BETTER_AUTH_URL, and MIGRATION_DATABASE_URL in a local editor; never paste them into chat.`,
    );
    return;
  }
  const password = secret();
  const runtime = path.join(directory, ENV_LOCAL);
  const migration = path.join(directory, ENV_MIGRATE);
  for (const name of putEnv(runtime, {
    APP_DATABASE_URL: `postgresql://starter_runtime:${password}@127.0.0.1:5432/starter`,
    BETTER_AUTH_URL: "http://localhost:3000",
    BETTER_AUTH_SECRET: secret(),
  }))
    log(name);
  for (const name of putEnv(migration, {
    MIGRATION_DATABASE_URL: `postgresql://postgres:${secret()}@127.0.0.1:5432/starter`,
  }))
    log(name);
}

function validatedOrigin(raw: string | undefined, envName: string, production: boolean): URL {
  if (!raw) throw new SafeError(`Configure BETTER_AUTH_URL in ${envName} in a local editor first.`);
  let origin: URL;
  try {
    origin = new URL(raw);
  } catch {
    throw new SafeError("BETTER_AUTH_URL must be an HTTP(S) origin without credentials.");
  }
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password)
    throw new SafeError("BETTER_AUTH_URL must be an HTTP(S) origin without credentials.");
  if (production) {
    if (origin.protocol !== "https:")
      throw new SafeError("Production BETTER_AUTH_URL must use https://.");
    if (isLoopbackHost(origin.hostname))
      throw new SafeError("Production BETTER_AUTH_URL must not use a loopback host.");
  }
  return origin;
}

export const runtimeVariables = [
  "APP_DATABASE_URL",
  "AUTH_DATABASE_URL",
  "BETTER_AUTH_URL",
  "BETTER_AUTH_SECRET",
  "CANVAS_FRAME_ORIGINS",
  "NEXT_PUBLIC_AG_GRID_LICENSE_KEY",
  "NEXT_PUBLIC_AG_CHARTS_LICENSE_KEY",
];

function vercelCwd(directory: string): string {
  if (existsSync(path.join(directory, ".vercel/project.json"))) return directory;
  const parent = path.resolve(directory, "..");
  if (existsSync(path.join(parent, ".vercel/project.json"))) return parent;
  return directory;
}

export async function pushSecrets(
  directory: string,
  io: GateIO = gateIO,
  send?: (name: string, value: string) => void,
) {
  const file = path.join(directory, ENV_PROD_SECRETS);
  if (!existsSync(file))
    throw new SafeError(
      `Missing ${ENV_PROD_SECRETS}. Run bun run setup:env --production and fill production values in a local editor first.`,
    );
  const env = readEnv(file);
  for (const name of ["APP_DATABASE_URL", "BETTER_AUTH_URL", "BETTER_AUTH_SECRET"])
    if (!env[name])
      throw new SafeError(`Configure ${name} in ${ENV_PROD_SECRETS} in a local editor first.`);
  validatedOrigin(env.BETTER_AUTH_URL, ENV_PROD_SECRETS, true);
  for (const dbVar of ["APP_DATABASE_URL", "AUTH_DATABASE_URL"] as const) {
    const value = env[dbVar];
    if (!value) continue;
    if (loopback(value))
      throw new SafeError(`${dbVar} must not target a loopback host for production.`);
  }
  if (env.BETTER_AUTH_SECRET!.length < 32)
    throw new SafeError("BETTER_AUTH_SECRET must contain at least 32 characters.");

  const sender =
    send ??
    ((name: string, value: string) => {
      const result = spawnSync("vercel", ["env", "add", name, "production", "--force"], {
        cwd: vercelCwd(directory),
        env: { ...process.env },
        input: value,
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (result.status !== 0) {
        const stderr = result.stderr?.toString("utf8").trim() ?? "";
        const detail = redact(stderr, { ...process.env, ...env });
        throw new SafeError(
          `Could not push ${name} (exit ${result.status ?? "unknown"})${detail ? `: ${detail}` : ""}.`,
        );
      }
    });

  io.log(
    `Send runtime variables from ${ENV_PROD_SECRETS} to Vercel production (--force). Migration and Neon credentials are excluded.`,
  );
  await confirm(io);
  for (const name of runtimeVariables)
    if (env[name]) {
      sender(name, env[name]!);
      io.log(name);
    }
}

if (import.meta.main) {
  const directory = path.resolve(import.meta.dirname, "..");
  let redactEnv: Record<string, string | undefined> = process.env;
  try {
    const [command, ...flags] = process.argv.slice(2);
    const production = flags.includes("--production");
    const extra = flags.filter((f) => f !== "--production");
    if (!command || extra.length > 0 || (command === "push" && production))
      throw new SafeError("Usage: setup:env [--production] or secrets:push.");
    if (command === "push") {
      const prodPath = path.join(directory, ENV_PROD_SECRETS);
      if (existsSync(prodPath)) redactEnv = { ...process.env, ...readEnv(prodPath) };
      await pushSecrets(directory);
    } else if (command === "setup") {
      setupEnv(directory, console.log, production);
    } else throw new SafeError("Unknown secrets command.");
  } catch (error) {
    reportError(error, "Secret operation", redactEnv);
    process.exitCode = 1;
  }
}
