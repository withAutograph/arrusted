import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileSchema } from "../../../generated-app-runtime/compile-schema";
import {
  migrate,
  rehearse,
  runtimeRoles,
  undo,
  type MigrationInput,
} from "../../../../app/scripts/migrate";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function readOwnVersion(): string {
  for (const rel of ["../package.json", "./package.json"]) {
    const candidate = path.resolve(moduleDir, rel);
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { version?: string };
      if (parsed.version) return parsed.version;
    }
  }
  return "0.1.0-alpha.1";
}

function detectGitProvenance(cwd: string): { sourceCommit: string; sourceDirty: boolean } {
  const explicitCommit =
    process.env.SOURCE_COMMIT?.trim() || process.env.VERCEL_GIT_COMMIT_SHA?.trim();
  const explicitDirty = process.env.SOURCE_DIRTY === "true";
  if (explicitCommit) {
    return { sourceCommit: explicitCommit, sourceDirty: explicitDirty };
  }
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (commit) {
      const status = execFileSync("git", ["status", "--porcelain"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return { sourceCommit: commit, sourceDirty: status.length > 0 };
    }
  } catch {
    // Consumer directory may not have an initialized git commit yet.
  }
  return { sourceCommit: "local-workspace", sourceDirty: explicitDirty };
}

export async function runCoreCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    console.log(
      [
        "Usage:",
        "  arrusted compile [--schema <path>] [--out <dir>] [--catalog <file>]",
        "  arrusted migrate [apply] [--release <dir>] [--allow-retire] [--rebind-runtime-login]",
        "  arrusted migrate:undo",
        "  arrusted migrate:rehearse [--release <dir>] [--allow-retire] [--rebind-runtime-login]",
      ].join("\n"),
    );
    return;
  }

  if (subcommand === "compile") {
    let schemaPath = path.resolve(process.cwd(), "schema");
    let outDir = path.resolve(process.cwd(), ".generated/release");
    let catalogPath: string | undefined;
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i]!;
      const next = rest[i + 1];
      if (
        (arg === "--schema" || arg === "--out" || arg === "--catalog") &&
        next &&
        !next.startsWith("--")
      ) {
        i += 1;
        if (arg === "--schema") schemaPath = path.resolve(process.cwd(), next);
        else if (arg === "--out") outDir = path.resolve(process.cwd(), next);
        else if (arg === "--catalog") catalogPath = path.resolve(process.cwd(), next);
      } else {
        throw new Error(
          "Usage: arrusted compile [--schema <path>] [--out <dir>] [--catalog <file>]",
        );
      }
    }
    const { sourceCommit, sourceDirty } = detectGitProvenance(process.cwd());
    const compiled = compileSchema({
      schemaPath,
      outDir,
      ...(catalogPath ? { catalogPath } : {}),
      packageVersion: readOwnVersion(),
      runtimeModuleSpecifier: "@arrusted/core",
      sourceCommit,
      sourceDirty,
    });
    console.log(`Compiled ${compiled.app} ${compiled.version} into ${compiled.directory}`);
    return;
  }

  const normalizedCmd =
    subcommand === "migrate:undo"
      ? "undo"
      : subcommand === "migrate:rehearse"
        ? "rehearse"
        : subcommand === "migrate"
          ? "migrate"
          : undefined;
  if (!normalizedCmd) {
    throw new Error(`Unknown command: ${subcommand}`);
  }

  let mode: "apply" | "undo" | "rehearse" =
    normalizedCmd === "undo" ? "undo" : normalizedCmd === "rehearse" ? "rehearse" : "apply";
  let releaseDirectory = path.resolve(process.cwd(), ".generated/release");
  let explicitRelease = false;
  let allowRetire = false;
  let rebindRuntimeLogin = false;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (
      normalizedCmd === "migrate" &&
      i === 0 &&
      (arg === "apply" || arg === "undo" || arg === "rehearse")
    ) {
      mode = arg;
      continue;
    }
    if (arg === "--allow-retire") {
      allowRetire = true;
    } else if (arg === "--rebind-runtime-login") {
      rebindRuntimeLogin = true;
    } else if (arg === "--release" && rest[i + 1] && !rest[i + 1]!.startsWith("--")) {
      releaseDirectory = path.resolve(process.cwd(), rest[i + 1]!);
      explicitRelease = true;
      i += 1;
    } else {
      throw new Error(`Unknown migration option: ${arg}`);
    }
  }

  const databaseUrl = process.env.MIGRATION_DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("MIGRATION_DATABASE_URL is required.");
  }

  if (mode === "undo") {
    if (allowRetire) throw new Error("--allow-retire is not valid with undo.");
    if (rebindRuntimeLogin) throw new Error("--rebind-runtime-login is not valid with undo.");
    if (explicitRelease) throw new Error("--release is not valid with undo.");
    const result = await undo({ databaseUrl });
    console.log(
      `Database and applied-schema record restored (source commit ${result.sourceCommit}).`,
    );
    return;
  }

  const authSchema = process.env.AUTH_SCHEMA?.trim() || undefined;
  const kernelRole = process.env.APP_KERNEL_ROLE?.trim() || undefined;
  const appDatabaseUrl = process.env.APP_DATABASE_URL?.trim() || undefined;
  const authDatabaseUrl = process.env.AUTH_DATABASE_URL?.trim() || undefined;
  if (!appDatabaseUrl) {
    throw new Error("APP_DATABASE_URL is required.");
  }

  const baseInput: MigrationInput = {
    databaseUrl,
    releaseDirectory,
    ...runtimeRoles(databaseUrl, appDatabaseUrl, authDatabaseUrl),
    ...(authSchema ? { authSchema } : {}),
    ...(kernelRole ? { kernelRole } : {}),
    ...(allowRetire ? { allowRetire: true } : {}),
    ...(rebindRuntimeLogin ? { rebindRuntimeLogin: true } : {}),
  };

  if (mode === "rehearse") {
    const productionDatabaseUrl = process.env.PRODUCTION_APP_DATABASE_URL?.trim();
    if (!productionDatabaseUrl) {
      throw new Error("PRODUCTION_APP_DATABASE_URL is required for rehearsal.");
    }
    if (!appDatabaseUrl) {
      throw new Error("APP_DATABASE_URL is required for rehearsal.");
    }
    await rehearse({
      ...baseInput,
      runtimeDatabaseUrl: appDatabaseUrl,
      productionDatabaseUrl,
    });
    console.log("Migration rehearsal passed.");
    return;
  }

  const result = await migrate(baseInput);
  console.log(result.applied ? "Migration applied." : "Schema already up to date.");
}

if (import.meta.main) {
  runCoreCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
