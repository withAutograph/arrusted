import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { buildGeneratedRelease } from "../../.config/mise/scripts/repository/schema-release";
import { verifyCheckedRelease } from "../../packages/generated-app-runtime/release-verification";

export const repositoryRoot = path.resolve(import.meta.dirname, "../..");
export const sourceCue = path.join(repositoryRoot, "app/schema/app.cue");
export const releaseDirectory = path.join(repositoryRoot, "app/.generated/release");

function sourceFiles(directory: string): string[] {
  return readdirSync(path.join(repositoryRoot, directory), { withFileTypes: true }).flatMap(
    (entry) =>
      entry.isDirectory()
        ? sourceFiles(`${directory}/${entry.name}`)
        : [`${directory}/${entry.name}`],
  );
}

/** Build only: no database URL, credentials, or provider clients are consumed. */
export function compileApp(
  options: {
    source?: string;
    outputDirectory?: string;
    predecessors?: readonly string[];
  } = {},
) {
  const source = path.resolve(options.source ?? sourceCue);
  const output = path.resolve(options.outputDirectory ?? releaseDirectory);
  const hasGit = existsSync(path.join(repositoryRoot, ".git"));
  const explicitSourceCommit = process.env.SOURCE_COMMIT?.trim();
  if (!hasGit && !explicitSourceCommit)
    throw new Error("SOURCE_COMMIT is required when compiling a source archive without .git.");
  const sourceCommit =
    explicitSourceCommit ||
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  const sourceDirty = hasGit
    ? execFileSync("git", ["status", "--porcelain"], {
        cwd: repositoryRoot,
        encoding: "utf8",
      }).trim().length > 0
    : process.env.SOURCE_DIRTY === "true";
  const inputs = [
    "packages/schema-compiler/cue/app-manifest.cue",
    ...(options.source === undefined
      ? [
          "packages/schema-compiler/cue/app-selection.cue",
          "packages/domain-libs/catalog.json",
          ...readdirSync(path.dirname(source))
            .filter((name) => name.endsWith(".cue"))
            .sort()
            .map((name) => path.relative(repositoryRoot, path.join(path.dirname(source), name))),
        ]
      : [path.relative(repositoryRoot, source)]),
  ];
  // Any compiler/kernel upgrade gets a new deterministic schema identity, even
  // when the app's CUE is unchanged. Recompiling identical inputs is a no-op.
  const sources = [
    ...new Set([
      ...inputs,
      "Cargo.lock",
      "Cargo.toml",
      "packages/schema-compiler/Cargo.toml",
      "packages/kernel/Cargo.toml",
      "packages/auth/schema.sql",
      "packages/auth/single-organization-membership.sql",
      ".config/mise/scripts/repository/schema-release.ts",
      "app/scripts/compile.ts",
      ...sourceFiles("packages/schema-compiler/src"),
      ...sourceFiles("packages/kernel/src"),
    ]),
  ].sort();
  const hash = createHash("sha256");
  for (const name of sources)
    hash
      .update(name)
      .update("\0")
      .update(readFileSync(path.join(repositoryRoot, name)))
      .update("\0");
  const compilerHash = hash.digest("hex");
  const version = `build-${compilerHash}`;
  mkdirSync(path.dirname(output), { recursive: true });
  const temporary = mkdtempSync(path.join(path.dirname(output), ".compile-"));
  const backup = path.join(temporary, "previous");
  try {
    const built = buildGeneratedRelease(
      "starter",
      temporary,
      inputs,
      repositoryRoot,
      { ...process.env, CARGO_TARGET_DIR: path.join(repositoryRoot, "target") },
      options.predecessors ?? [],
      { schemaVersion: version, sourcePaths: sources, nextApp: true },
    );
    verifyCheckedRelease(built.directory, source);
    if (existsSync(output)) renameSync(output, backup);
    try {
      renameSync(built.directory, output);
    } catch (error) {
      if (existsSync(backup)) renameSync(backup, output);
      throw error;
    }
    const compilerBinary = readFileSync(path.join(repositoryRoot, "target/debug/schema-compiler"));
    const compilerBinaryHash = createHash("sha256").update(compilerBinary).digest("hex");
    writeFileSync(path.join(path.dirname(output), "schema-compiler"), compilerBinary, {
      mode: 0o755,
    });
    const releaseHash = createHash("sha256")
      .update(readFileSync(path.join(output, "release-manifest.json")))
      .digest("hex");
    writeFileSync(
      path.join(path.dirname(output), "build.json"),
      JSON.stringify(
        { sourceCommit, sourceDirty, compilerHash, compilerBinaryHash, releaseHash },
        null,
        2,
      ) + "\n",
    );
    return { ...built, directory: output };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  if (process.argv.length > 2) throw new Error("usage: bun app/scripts/compile.ts");
  const release = compileApp();
  console.log(`Compiled ${release.app} ${release.version} into ${release.directory}`);
}
