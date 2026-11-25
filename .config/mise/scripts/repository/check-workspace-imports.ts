import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type BoundaryContext,
  importReferences,
  isUnder,
  rel,
  resolveLocalImport,
  resolveSourcePath,
  sourceFiles,
  createContext,
  filesUnder,
} from "./source-analysis";

type Workspace = {
  dirs: Map<string, string>;
  exports: Map<string, string>;
  generatedExports: Map<string, string>;
  withExports: Set<string>;
};

const workspace = (context: BoundaryContext): Workspace => {
  const dirs = new Map<string, string>(),
    exports = new Map<string, string>(),
    generatedExports = new Map<string, string>(),
    withExports = new Set<string>();
  for (const root of [join(context.root, "apps"), context.packages]) {
    if (!existsSync(root)) continue;
    const manifests = filesUnder(root).filter((path) => basename(path) === "package.json");
    for (const manifest of manifests) {
      if (
        manifest.includes("/node_modules/") ||
        manifest.includes("/.next/") ||
        manifest.includes("/dist/")
      )
        continue;
      let payload: any;
      try {
        payload = JSON.parse(readFileSync(manifest, "utf8"));
      } catch (error) {
        context.violations.push(
          `${rel(context, manifest)}: invalid workspace manifest: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      if (typeof payload.name !== "string") continue;
      const directory = dirname(manifest);
      dirs.set(payload.name, directory);
      if (payload.exports === undefined) continue;
      withExports.add(payload.name);
      if (typeof payload.exports === "string")
        exports.set(`${payload.name}\0`, join(directory, payload.exports));
      else if (payload.exports && typeof payload.exports === "object")
        for (const [key, value] of Object.entries(payload.exports)) {
          const subpath = key === "." ? "" : key.startsWith("./") ? key.slice(2) : undefined;
          if (subpath === undefined) continue;
          const target =
            typeof value === "string"
              ? value
              : value && typeof value === "object"
                ? ["source", "types", "import", "default"]
                    .map((condition) => (value as any)[condition])
                    .find((entry) => typeof entry === "string")
                : undefined;
          if (target) exports.set(`${payload.name}\0${subpath}`, join(directory, target));
          if (value && typeof value === "object") {
            const source = (value as any).source;
            const runtime = [(value as any).import, (value as any).default].find(
              (entry) => typeof entry === "string",
            );
            const sourcePath =
              typeof source === "string" ? resolveSourcePath(join(directory, source)) : undefined;
            if (sourcePath && typeof runtime === "string")
              generatedExports.set(join(directory, runtime), sourcePath);
          }
        }
    }
  }
  return { dirs, exports, generatedExports, withExports };
};

const exactAliases = (context: BoundaryContext): Record<string, string> => ({
  "@contracts": join(context.packages, "contracts/index.ts"),
  "@kernel-client": join(context.packages, "kernel-client/index.ts"),
  "@agent-foundation": join(context.packages, "agent-foundation/index.ts"),
  "@autograph/components": join(context.packages, "design-systems/core/components/index.ts"),
  "@autograph/compositions": join(context.packages, "design-systems/core/compositions/index.ts"),
  "@autograph/icons": join(context.packages, "design-systems/core/icons/index.ts"),
});

const packageMatch = (
  workspaces: Workspace,
  specifier: string,
): [string, string, string] | undefined => {
  const names = [...workspaces.dirs.keys()].filter(
    (name) => specifier === name || specifier.startsWith(`${name}/`),
  );
  if (!names.length) return undefined;
  const name = names.sort((a, b) => b.length - a.length)[0]!;
  return [name, workspaces.dirs.get(name)!, specifier.slice(name.length).replace(/^\//, "")];
};

const isInternal = (
  context: BoundaryContext,
  workspaces: Workspace,
  specifier: string,
): boolean => {
  const aliases = exactAliases(context);
  return (
    specifier.startsWith(".") ||
    specifier in aliases ||
    Object.keys(aliases).some((alias) => specifier.startsWith(`${alias}/`)) ||
    specifier.startsWith("@engines/") ||
    specifier.startsWith("@modules/") ||
    packageMatch(workspaces, specifier) !== undefined
  );
};

const resolveImport = (
  context: BoundaryContext,
  workspaces: Workspace,
  source: string,
  specifier: string,
): string | undefined => {
  const local = resolveLocalImport(source, specifier);
  if (local) return local;
  if (specifier.startsWith("."))
    return workspaces.generatedExports.get(join(dirname(source), specifier));
  const aliases = exactAliases(context);
  if (specifier in aliases) return resolveSourcePath(aliases[specifier]!);
  for (const [alias, target] of Object.entries(aliases))
    if (specifier.startsWith(`${alias}/`))
      return resolveSourcePath(join(dirname(target), specifier.slice(alias.length + 1)));
  for (const [prefix, root] of [
    ["@engines/", join(context.packages, "engines")],
    ["@modules/", join(context.packages, "modules")],
  ] as const)
    if (specifier.startsWith(prefix))
      return resolveSourcePath(join(root, specifier.slice(prefix.length)));
  const packageInfo = packageMatch(workspaces, specifier);
  if (!packageInfo) return undefined;
  const [name, directory, subpath] = packageInfo;
  const target = workspaces.exports.get(`${name}\0${subpath}`);
  if (target) return resolveSourcePath(target);
  if (workspaces.withExports.has(name)) return undefined;
  return resolveSourcePath(join(directory, subpath));
};

export const checkWorkspaceImports = (context: BoundaryContext): void => {
  const workspaces = workspace(context);
  const csvWorkspaceRoot = join(context.packages, "csv-workspace");
  const publicCsvWorkspaceImports = new Set([
    "@autograph/csv-workspace",
    "@autograph/csv-workspace/server",
    "@autograph/csv-workspace/mapping",
    "@autograph/csv-workspace/draft",
  ]);
  const scanned = [
    ...sourceFiles(context.packages).filter(
      (path) => !path.startsWith(join(context.packages, "rust-auth")) || !path.endsWith(".rs"),
    ),
    ...sourceFiles(join(context.root, "apps")),
  ];
  for (const path of scanned) {
    const relativePath = rel(context, path);
    for (const entry of importReferences(readFileSync(path, "utf8"))) {
      const resolved = resolveImport(context, workspaces, path, entry.specifier);
      if (isInternal(context, workspaces, entry.specifier) && !resolved) {
        context.violations.push(
          `${relativePath}: internal import \`${entry.specifier}\` does not resolve`,
        );
        continue;
      }
      if (resolved && !isUnder(resolved, context.root)) {
        context.violations.push(
          `${relativePath}: internal import \`${entry.specifier}\` resolves outside repository root`,
        );
        continue;
      }
      if (
        resolved &&
        isUnder(resolved, csvWorkspaceRoot) &&
        !isUnder(path, csvWorkspaceRoot) &&
        !publicCsvWorkspaceImports.has(entry.specifier)
      ) {
        context.violations.push(
          `${relativePath}: consume the CSV workspace through its public client or server export, not \`${entry.specifier}\``,
        );
      }
      if (
        resolved &&
        isUnder(path, csvWorkspaceRoot) &&
        (isUnder(resolved, context.domainLibs) || isUnder(resolved, join(context.root, "apps")))
      ) {
        context.violations.push(
          `${relativePath}: the CSV workspace receives domain and app context from its consumer, not \`${entry.specifier}\``,
        );
      }
    }
  }
};

if (import.meta.main) {
  const context = createContext(process.argv[2] ?? process.cwd());
  checkWorkspaceImports(context);
  if (context.violations.length > 0) {
    console.error(context.violations.join("\n"));
    process.exit(1);
  }
}
