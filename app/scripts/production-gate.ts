import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { readAppConfig } from "./app-config";
import { SafeError, redact } from "./safe-output";

const defaultApp = path.resolve(import.meta.dirname, "..");
const defaultRoot = path.resolve(defaultApp, "..");

const DISALLOWED_DB_QUERY_PARAMS = new Set(["host", "hostaddr", "service"]);

export function loopback(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SafeError("Database URL is malformed. Check the connection string syntax.");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol))
    throw new SafeError("Database URL must use postgres:// or postgresql://.");
  if (!parsed.hostname || !parsed.username || parsed.pathname.length < 2)
    throw new SafeError("Database URL must include a username, host, and database name.");
  for (const key of parsed.searchParams.keys()) {
    if (DISALLOWED_DB_QUERY_PARAMS.has(key.toLowerCase()))
      throw new SafeError(
        `Database URL must not set the "${key}" query parameter, which can override the target host.`,
      );
  }
  const host = parsed.hostname.toLowerCase();
  // Postgres decodes "%00" and similar after this check, which could reach another host.
  if (host.includes("%"))
    throw new SafeError("Database URL host must not contain percent-encoded characters.");
  return (
    !host.includes(",") &&
    (host === "localhost" ||
      host === "127.0.0.1" ||
      host === "[::1]" ||
      host === "::1" ||
      host.endsWith(".localhost"))
  );
}

function isValidVercelProject(filePath: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
      projectId?: unknown;
      orgId?: unknown;
    };
    return Boolean(parsed.projectId && parsed.orgId);
  } catch {
    return false;
  }
}

export function resolveDeployCwd(appDir = defaultApp, repoRoot = defaultRoot): string {
  if (isValidVercelProject(path.join(appDir, ".vercel/project.json"))) return appDir;
  if (isValidVercelProject(path.join(repoRoot, ".vercel/project.json"))) return repoRoot;
  return appDir;
}

export function hasVercelLink(appDir = defaultApp, repoRoot = defaultRoot): boolean {
  return (
    isValidVercelProject(path.join(appDir, ".vercel/project.json")) ||
    isValidVercelProject(path.join(repoRoot, ".vercel/project.json"))
  );
}

function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*" && pattern[i + 1] === "*") {
      out += ".*";
      i++;
    } else if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${out}$`);
}

function isIgnoredByVercelIgnore(content: string, relPath: string): boolean {
  const normalized = relPath.replaceAll("\\", "/").replace(/^\/+/, "");
  const segments = normalized.split("/");
  const parentDirs: string[] = [];
  for (let i = 1; i < segments.length; i++) parentDirs.push(segments.slice(0, i).join("/"));
  let ignored = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    const body = negated ? line.slice(1) : line;
    if (!body) continue;
    const dirOnly = body.endsWith("/");
    const withoutTrailing = dirOnly ? body.slice(0, -1) : body;
    const rooted = body.startsWith("/") || withoutTrailing.includes("/");
    const pattern = withoutTrailing.replace(/^\/+/, "");
    if (!pattern) continue;
    const regex = globToRegExp(pattern);
    const candidates = dirOnly ? parentDirs : [...parentDirs, normalized];
    const matched = candidates.some((candidate) =>
      rooted ? regex.test(candidate) : regex.test(candidate.split("/").at(-1)!),
    );
    if (matched) ignored = !negated;
  }
  return ignored;
}

const REQUIRED_IGNORED_APP_PATHS = [
  ".env",
  ".env.local",
  ".env.migrate",
  ".env.production.secrets",
  ".env.production.migrate",
  ".local/people/member.txt",
  ".local/restore-points/backup.sql",
];

const REQUIRED_IGNORED_ROOT_PATHS = [
  ".env",
  ".env.local",
  ".config/fnox/local.toml",
  "fnox.local.toml",
  ".config/pitchfork.local.toml",
  ".claude/settings.json",
  ".codex/config.toml",
  ".devin/state.json",
  "log/dev.log",
  "debug-1.log",
  ".scratch/tmp.txt",
  "target/debug/schema-compiler",
  ".cargo-target/debug/schema-compiler",
  ".turbo/cache.json",
];

/** Refuse deployment unless the .vercelignore at deployCwd excludes every secret/private file. */
export function checkVercelIgnore(appDir = defaultApp, repoRoot = defaultRoot): void {
  const deployCwd = resolveDeployCwd(appDir, repoRoot);
  const ignorePath = path.join(deployCwd, ".vercelignore");
  if (!existsSync(ignorePath))
    throw new SafeError(
      `Missing ${ignorePath}. Add .vercelignore covering .env, .env.*, and .local/ before deploying so secret files and restore points are never uploaded to Vercel.`,
    );
  const content = readFileSync(ignorePath, "utf8");
  const relApp = path.relative(deployCwd, appDir).replaceAll("\\", "/");
  const prefix = relApp && relApp !== "." ? `${relApp}/` : "";
  const required = [
    ...REQUIRED_IGNORED_APP_PATHS.map((file) => `${prefix}${file}`),
    ...(path.resolve(deployCwd) === path.resolve(repoRoot) ? REQUIRED_IGNORED_ROOT_PATHS : []),
  ];
  const uncovered = [...new Set(required)].filter((file) => !isIgnoredByVercelIgnore(content, file));
  if (uncovered.length > 0)
    throw new SafeError(
      `${ignorePath} does not ignore ${uncovered.join(", ")}. Update .vercelignore before deploying so secret files, local state, and restore points are never uploaded to Vercel.`,
    );
}

function commandOutput(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const err = error as { stdout?: Buffer | string; stderr?: Buffer | string };
  const parts = [err.stderr, err.stdout]
    .map((part) =>
      Buffer.isBuffer(part) ? part.toString("utf8") : typeof part === "string" ? part : "",
    )
    .map((part) => part.trim())
    .filter(Boolean);
  return redact(parts.join("\n"));
}

export interface GateIO {
  git(args: string[]): string;
  check(): void;
  linked(): boolean;
  checkVercelIgnore?(): void;
  sourceCommit(): string;
  appName?(): string;
  tty(): boolean;
  ask(prompt: string): Promise<string>;
  log(message: string): void;
}

export function createGateIO(
  options: {
    appDir?: string;
    repoRoot?: string;
    check?: () => void;
    tty?: () => boolean;
    ask?: (prompt: string) => Promise<string>;
    log?: (message: string) => void;
  } = {},
): GateIO {
  const appDir = options.appDir ?? defaultApp;
  const repoRoot = options.repoRoot ?? path.resolve(appDir, "..");
  return {
    git: (args) => {
      try {
        return execFileSync("git", args, {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
      } catch (error) {
        const detail = commandOutput(error);
        throw new Error(`git ${args[0] ?? "command"} failed${detail ? `: ${detail}` : "."}`, {
          cause: error,
        });
      }
    },
    check:
      options.check ??
      (() => {
        for (const command of ["compile", "check"]) {
          try {
            execFileSync(process.execPath, ["run", command], {
              cwd: appDir,
              encoding: "utf8",
              stdio: ["ignore", "pipe", "pipe"],
            });
          } catch (error) {
            const detail = commandOutput(error);
            throw new Error(`bun run ${command} failed${detail ? `:\n${detail}` : "."}`, {
              cause: error,
            });
          }
        }
      }),
    linked: () => hasVercelLink(appDir, repoRoot),
    checkVercelIgnore: () => checkVercelIgnore(appDir, repoRoot),
    sourceCommit: () =>
      JSON.parse(readFileSync(path.join(appDir, ".generated/build.json"), "utf8")).sourceCommit,
    appName: () => readAppConfig(appDir).name,
    tty: options.tty ?? (() => Boolean(process.stdin.isTTY && process.stdout.isTTY)),
    ask:
      options.ask ??
      (async (prompt) => {
        const reader = createInterface({ input: process.stdin, output: process.stdout });
        try {
          return await reader.question(prompt);
        } finally {
          reader.close();
        }
      }),
    log: options.log ?? ((message) => console.log(message)),
  };
}

export const gateIO: GateIO = createGateIO();

export function resolveAppName(io: GateIO = gateIO): string {
  return io.appName?.() ?? readAppConfig(defaultApp).name;
}

export async function confirm(io: GateIO = gateIO) {
  if (!io.tty())
    throw new SafeError(
      "A real terminal on stdin and stdout is required. Ask the human to run this command.",
    );
  const name = resolveAppName(io);
  if ((await io.ask(`Type the app name "${name}" to continue: `)) !== name)
    throw new SafeError("Confirmation did not match; nothing was changed.");
}

export async function preflight(
  localOnly = false,
  io: GateIO = gateIO,
  options: { requireTty?: boolean } = {},
) {
  if (options.requireTty !== false && !io.tty())
    throw new SafeError(
      "A real terminal on stdin and stdout is required. Ask the human to run this command.",
    );
  io.log("Checking git work tree and branch…");
  if (io.git(["status", "--porcelain", "--untracked-files=all"]))
    throw new SafeError("The work tree must be clean, including untracked files.");
  const remotes = io.git(["remote"]).split(/\s+/).filter(Boolean);
  const branch = io.git(["branch", "--show-current"]);
  if (remotes.length) {
    const remote = remotes.includes("origin") ? "origin" : remotes[0]!;
    io.log(`Fetching ${remote} and verifying HEAD matches the default branch…`);
    io.git(["fetch", remote]);
    // Query the remote HEAD after fetching; do not trust a stale local symbolic ref.
    const advertised = io.git(["ls-remote", "--symref", remote, "HEAD"]);
    const base = /^ref: refs\/heads\/([^\s]+)\s+HEAD/m.exec(advertised)?.[1];
    if (!base) throw new SafeError("Cannot determine the remote default branch.");
    if (branch !== base) throw new SafeError("Release requires the repository default branch.");
    const advertisedHead = /^([a-f0-9]+)\s+HEAD$/m.exec(advertised)?.[1];
    const head = io.git(["rev-parse", "HEAD"]);
    if (
      !advertisedHead ||
      head !== advertisedHead ||
      head !== io.git(["rev-parse", `refs/remotes/${remote}/${base}`])
    )
      throw new SafeError(
        "HEAD must equal the fetched remote default branch. Merge the PR and update locally first.",
      );
  } else {
    if (!localOnly)
      throw new SafeError(
        "No remote is configured. Use --local-only-repo only for an intentionally local repository.",
      );
    let base = "main";
    try {
      base = io.git(["config", "--get", "init.defaultBranch"]) || "main";
    } catch {}
    if (branch !== base) throw new SafeError("Release requires the repository default branch.");
    io.log("Local-only repository: remote merged-PR verification is unavailable.");
  }
  io.log("Checking Vercel project link…");
  if (!io.linked()) throw new SafeError("Link this app to its Vercel project before continuing.");
  io.log("Checking .vercelignore coverage…");
  io.checkVercelIgnore?.();
  io.log("Compiling schema and running type checks…");
  io.check();
  if (io.sourceCommit() !== io.git(["rev-parse", "HEAD"]))
    throw new SafeError("Compiled source commit does not equal HEAD.");
  if (io.git(["status", "--porcelain", "--untracked-files=all"]))
    throw new SafeError("Compile/check changed the work tree; review and commit before release.");
}

export async function productionGate(
  url: string,
  plan: string | (() => Promise<string>),
  localOnly = false,
  io: GateIO = gateIO,
) {
  if (loopback(url)) return;
  await preflight(localOnly, io);
  io.log(typeof plan === "string" ? plan : await plan());
  await confirm(io);
}
