import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { compileSchema } from "../../packages/generated-app-runtime/compile-schema";

export const repositoryRoot = path.resolve(import.meta.dirname, "../..");
export const sourceCue = path.join(repositoryRoot, "app/schema/app.cue");
export const releaseDirectory = path.join(repositoryRoot, "app/.generated/release");

/** Build only: no database URL, credentials, or provider clients are consumed. */
export function compileApp(
  options: {
    source?: string;
    outputDirectory?: string;
    catalogPath?: string;
    predecessors?: readonly string[];
  } = {},
) {
  const source = path.resolve(options.source ?? path.dirname(sourceCue));
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

  const defaultCatalog = path.join(repositoryRoot, "packages/domain-libs/catalog.json");
  const catalogPath =
    options.catalogPath ??
    (options.source === undefined && existsSync(defaultCatalog) ? defaultCatalog : undefined);

  return compileSchema({
    schemaPath: source,
    outDir: output,
    ...(catalogPath ? { catalogPath } : {}),
    ...(options.predecessors ? { predecessors: options.predecessors } : {}),
    sourceCommit,
    sourceDirty,
  });
}

if (import.meta.main) {
  let source: string | undefined;
  let outputDirectory: string | undefined;
  let catalogPath: string | undefined;
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    const next = process.argv[i + 1];
    if (
      (arg === "--schema" || arg === "--out" || arg === "--catalog") &&
      next &&
      !next.startsWith("--")
    ) {
      i += 1;
      if (arg === "--schema") source = next;
      else if (arg === "--out") outputDirectory = next;
      else if (arg === "--catalog") catalogPath = next;
    } else {
      throw new Error(
        "usage: bun app/scripts/compile.ts [--schema <path>] [--out <dir>] [--catalog <file>]",
      );
    }
  }
  const release = compileApp({
    ...(source ? { source } : {}),
    ...(outputDirectory ? { outputDirectory } : {}),
    ...(catalogPath ? { catalogPath } : {}),
  });
  console.log(`Compiled ${release.app} ${release.version} into ${release.directory}`);
}
