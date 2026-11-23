import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

declare const Bun: {
  TOML: { parse(value: string): unknown };
  file(path: string): { text(): Promise<string> };
  spawnSync(
    command: string[],
    options: { cwd: string; stderr: "pipe"; stdout: "pipe" },
  ): { exitCode: number; stderr: { toString(): string }; stdout: { toString(): string } };
};

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const rustHomes = {
  CARGO_HOME: {
    miseOverride: "MISE_CARGO_HOME",
    defaultPath: resolve(homedir(), ".cargo"),
  },
  RUSTUP_HOME: {
    miseOverride: "MISE_RUSTUP_HOME",
    defaultPath: resolve(homedir(), ".rustup"),
  },
} as const;

type RustHome = keyof typeof rustHomes;

const forbiddenEnvironmentKeys = new Set([
  ...Object.keys(rustHomes),
  ...Object.values(rustHomes).map(({ miseOverride }) => miseOverride),
]);

function isInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
  );
}

async function canonicalizeWithMissingSegments(path: string): Promise<string> {
  let existingAncestor = resolve(path);
  const missingSegments: string[] = [];

  while (true) {
    try {
      return resolve(await realpath(existingAncestor), ...missingSegments.reverse());
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }

      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) {
        throw error;
      }
      missingSegments.push(basename(existingAncestor));
      existingAncestor = parent;
    }
  }
}

function fail(message: string): never {
  throw new Error(`mise Rust cache path check failed: ${message}`);
}

function trackedMiseConfigs(): string[] {
  const result = Bun.spawnSync(
    [
      "git",
      "ls-files",
      "-z",
      "--",
      ":(glob)**/mise*.toml",
      ":(glob)**/.mise*.toml",
      ":(glob)**/mise/**/*.toml",
      ":(glob)**/.mise/**/*.toml",
      ":(glob)**/.config/mise/**/*.toml",
    ],
    { cwd: repositoryRoot, stderr: "pipe", stdout: "pipe" },
  );
  if (result.exitCode !== 0) {
    fail(
      `could not list tracked mise configs: ${result.stderr.toString().trim() || "unknown error"}`,
    );
  }

  return result.stdout.toString().split("\0").filter(Boolean);
}

async function readConfig(path: string): Promise<Record<string, unknown>> {
  const config = Bun.TOML.parse(await Bun.file(resolve(repositoryRoot, path)).text());
  return config as Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function assertNoRustHomesInEnvironment(configPath: string, value: unknown, path: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoRustHomesInEnvironment(configPath, entry, [...path, String(index)]),
    );
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    const entryPath = [...path, key];
    if (forbiddenEnvironmentKeys.has(key)) {
      fail(`${configPath}: ${entryPath.join(".")} must be omitted from repository config`);
    }
    assertNoRustHomesInEnvironment(configPath, entry, entryPath);
  }
}

function assertNoConfiguredEnvironmentOverrides(
  configPath: string,
  value: unknown,
  path: string[] = [],
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoConfiguredEnvironmentOverrides(configPath, entry, [...path, String(index)]),
    );
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    const entryPath = [...path, key];
    if (key === "env") {
      assertNoRustHomesInEnvironment(configPath, entry, entryPath);
    }
    assertNoConfiguredEnvironmentOverrides(configPath, entry, entryPath);
  }
}

async function assertNoLiteralToolchainTrees(): Promise<void> {
  const literalDirectories = new Set(["~", "{{ xdg_data_home }}"]);
  const paths = new Set<string>();
  for (const arguments_ of [
    ["--cached", "--others", "--exclude-standard"],
    ["--others", "--ignored", "--exclude-standard", "--directory"],
  ]) {
    const result = Bun.spawnSync(["git", "ls-files", "-z", ...arguments_], {
      cwd: repositoryRoot,
      stderr: "pipe",
      stdout: "pipe",
    });
    if (result.exitCode !== 0) {
      fail(
        `could not inspect repository paths for literal toolchain trees: ${result.stderr.toString().trim() || "unknown error"}`,
      );
    }
    for (const path of result.stdout.toString().split("\0").filter(Boolean)) {
      paths.add(path);
    }
  }

  for (const path of [...paths].sort()) {
    const literalDirectory = path.split("/").find((segment) => literalDirectories.has(segment));
    if (literalDirectory !== undefined) {
      fail(`repository-local literal ${literalDirectory}/ directory exists at ${path}`);
    }
  }
}

async function main(): Promise<void> {
  for (const configPath of trackedMiseConfigs()) {
    const config = await readConfig(configPath);
    const rustSettings = record(record(config.settings).rust);
    assertNoConfiguredEnvironmentOverrides(configPath, config);

    for (const variable of Object.keys(rustHomes) as RustHome[]) {
      const setting = variable === "CARGO_HOME" ? "cargo_home" : "rustup_home";
      if (setting in rustSettings) {
        fail(
          `${configPath}: [settings.rust].${setting} must be omitted so mise uses its host/user default`,
        );
      }
    }
  }

  const canonicalRepositoryRoot = await canonicalizeWithMissingSegments(repositoryRoot);
  for (const variable of Object.keys(rustHomes) as RustHome[]) {
    const { defaultPath, miseOverride } = rustHomes[variable];
    const resolvedPath = process.env[miseOverride] ?? process.env[variable] ?? defaultPath;
    if (!isAbsolute(resolvedPath)) {
      fail(`${variable} resolved to non-absolute path ${JSON.stringify(resolvedPath)}`);
    }
    const canonicalResolvedPath = await canonicalizeWithMissingSegments(resolvedPath);
    if (isInside(canonicalRepositoryRoot, canonicalResolvedPath)) {
      fail(`${variable} resolved inside the repository: ${resolvedPath}`);
    }

    console.log(
      `${variable}: ${resolvedPath} (${process.env[miseOverride] || process.env[variable] ? "host override" : "mise default"})`,
    );
  }

  await assertNoLiteralToolchainTrees();
}

await main();
