import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { confirm, gateIO, loopback, type GateIO } from "./production-gate";
import { SafeError, redact, reportError } from "./safe-output";

export const ENV_LOCAL = ".env.local";
export const ENV_MIGRATE = ".env.migrate";
export const ENV_PROD_SECRETS = ".env.production.secrets";
export const ENV_PROD_MIGRATE = ".env.production.migrate";
export const OWNER_LINK_LOCAL = ".local/owner-setup.html";
export const OWNER_LINK_PROD = ".local/owner-setup.production.html";

export const secret = () => randomBytes(32).toString("base64url");
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");

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
        APP_OWNER_SETUP_HASH: digest(secret()),
        APP_ALLOW_SIGN_UP: "false",
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
    APP_OWNER_SETUP_HASH: digest(secret()),
    APP_ALLOW_SIGN_UP: "false",
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

/** Rotate APP_OWNER_SETUP_HASH and write a private 0600 link file without launching a browser. */
export function ownerSetup(
  directory: string,
  options: { production?: boolean; log?: (message: string) => void } = {},
) {
  const production = options.production ?? false;
  const log = options.log ?? console.log;
  const envName = production ? ENV_PROD_SECRETS : ENV_LOCAL;
  const file = path.join(directory, envName);
  const env = readEnv(file);
  const origin = validatedOrigin(env.BETTER_AUTH_URL, envName, production);
  const code = secret();
  putEnv(file, { APP_OWNER_SETUP_HASH: digest(code) }, true);
  const url = `${origin.origin}/auth/sign-in#setup=${code}`;
  const folder = path.join(directory, ".local");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(folder, 0o700);
  const linkFile = path.join(directory, production ? OWNER_LINK_PROD : OWNER_LINK_LOCAL);
  writeFileSync(
    linkFile,
    `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Owner setup</title><p><a href="${url.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">Set up owner account</a></p>\n`,
    { mode: 0o600 },
  );
  chmodSync(linkFile, 0o600);
  log(`Updated APP_OWNER_SETUP_HASH in ${envName}.`);
  log(`Saved private setup link file: ${linkFile}`);
  if (production) {
    log(
      "Next: run bun run secrets:push and bun run release, then run bun run owner:open --production once the app is live.",
    );
  } else {
    log("Next: start the app (bun run dev), then run bun run owner:open.");
  }
  log(
    "The link file stays until owner setup completes so reloading the tab does not lose the code. Delete it afterwards or re-run owner:open to delete it automatically once setup is complete.",
  );
  return { linkFile };
}

/** Open the private owner-setup HTML file (never the URL on argv) only when the app answers. */
export async function ownerOpen(
  directory: string,
  options: {
    production?: boolean;
    fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    open?: (filePath: string) => boolean;
    log?: (message: string) => void;
  } = {},
) {
  const production = options.production ?? false;
  const log = options.log ?? console.log;
  const fetchFn = options.fetch ?? fetch;
  const open =
    options.open ??
    ((filePath: string) => {
      // Pass ONLY the local file path to the browser launcher, never the setup URL or code.
      const command = process.platform === "darwin" ? "open" : "xdg-open";
      return spawnSync(command, [filePath], { stdio: "ignore" }).status === 0;
    });
  const envName = production ? ENV_PROD_SECRETS : ENV_LOCAL;
  const env = readEnv(path.join(directory, envName));
  const origin = validatedOrigin(env.BETTER_AUTH_URL, envName, production);
  const linkFile = path.join(directory, production ? OWNER_LINK_PROD : OWNER_LINK_LOCAL);
  if (!existsSync(linkFile))
    throw new SafeError(
      `No owner setup file found at ${linkFile}. Run bun run owner:setup${production ? " --production" : ""} first.`,
    );
  const hashCheck =
    env.APP_OWNER_SETUP_HASH && /^[a-f0-9]{64}$/.test(env.APP_OWNER_SETUP_HASH)
      ? digest(`owner-setup-hash-check:${env.APP_OWNER_SETUP_HASH}`)
      : undefined;
  let complete: boolean;
  let hashMatches: boolean | undefined;
  try {
    const response = await fetchFn(`${origin.origin}/api/auth/owner-setup-status`, {
      method: "GET",
      headers: hashCheck ? { "x-owner-setup-hash-check": hashCheck } : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { complete?: unknown; hashMatches?: unknown };
    if (typeof body?.complete !== "boolean") throw new Error("Unexpected status response");
    complete = body.complete;
    if (typeof body.hashMatches === "boolean") hashMatches = body.hashMatches;
  } catch {
    throw new SafeError(
      production
        ? `The app did not answer at ${origin.origin}. Run bun run secrets:push and bun run release first, then retry bun run owner:open --production.`
        : `The app did not answer at ${origin.origin}. Start the app (bun run dev) first, then retry bun run owner:open.`,
    );
  }
  if (complete) {
    rmSync(linkFile, { force: true });
    log(`Owner setup is already complete. Deleted ${linkFile}.`);
    return { status: "complete" as const };
  }
  if (hashMatches === false) {
    throw new SafeError(
      production
        ? `The deployed app at ${origin.origin} is not using the current APP_OWNER_SETUP_HASH from ${ENV_PROD_SECRETS}. Run bun run secrets:push and bun run release first, then retry bun run owner:open --production.`
        : `The running app at ${origin.origin} is not using the current APP_OWNER_SETUP_HASH from ${ENV_LOCAL}. Restart bun run dev, then retry bun run owner:open.`,
    );
  }
  if (open(linkFile)) {
    log(
      `Opened ${linkFile} in your browser. After completing setup, delete the file or re-run bun run owner:open${production ? " --production" : ""} to remove it.`,
    );
  } else {
    log(`Open this file yourself in your browser: ${linkFile}`);
  }
  return { status: "opened" as const, linkFile };
}

export const runtimeVariables = [
  "APP_DATABASE_URL",
  "AUTH_DATABASE_URL",
  "BETTER_AUTH_URL",
  "BETTER_AUTH_SECRET",
  "APP_OWNER_SETUP_HASH",
  "APP_ALLOW_SIGN_UP",
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
  for (const name of [
    "APP_DATABASE_URL",
    "BETTER_AUTH_URL",
    "BETTER_AUTH_SECRET",
    "APP_OWNER_SETUP_HASH",
  ])
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
  if (!/^[a-f0-9]{64}$/.test(env.APP_OWNER_SETUP_HASH!))
    throw new SafeError("APP_OWNER_SETUP_HASH must be a 64-character SHA-256 hex digest.");

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
  try {
    const directory = path.resolve(import.meta.dirname, "..");
    const [command, ...flags] = process.argv.slice(2);
    const production = flags.includes("--production");
    const extra = flags.filter((f) => f !== "--production");
    if (!command || extra.length > 0 || (command === "push" && production))
      throw new SafeError(
        "Usage: setup:env [--production], owner:setup [--production], owner:open [--production], or secrets:push.",
      );
    if (command === "setup") setupEnv(directory, console.log, production);
    else if (command === "owner") ownerSetup(directory, { production });
    else if (command === "open") await ownerOpen(directory, { production });
    else if (command === "push") await pushSecrets(directory);
    else throw new SafeError("Unknown secrets command.");
  } catch (error) {
    reportError(error, "Secret operation");
    process.exitCode = 1;
  }
}
