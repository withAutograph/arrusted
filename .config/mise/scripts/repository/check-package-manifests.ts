import { existsSync, readFileSync, readdirSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import { parseSync } from "oxc-parser";


type Manifest = {
  autograph?: { testTask?: unknown };
  bin?: unknown;
  name?: unknown;
  private?: unknown;
  catalog?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
  scripts?: Record<string, unknown>;
  exports?: unknown;
};

const exactVersion = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const exactAlias = /^npm:(?:@[^/]+\/)?[^@]+@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const dependencySections = ["dependencies", "devDependencies", "optionalDependencies"] as const;
const orderedSections = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];
const orderedScriptFamilies = [
  "dev",
  "check",
  "format",
  "lint",
  "test",
  "build",
  "prestart",
  "start",
];
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const excludedSourceDirectories = new Set([
  "__fixtures__",
  "coverage",
  "dist",
  "fixtures",
  "generated",
  "node_modules",
]);
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/u, "")));
const frameworkModules = new Set(["client-only", "server-only"]);
const testFile = /(?:^|\/)\S+\.(?:test|spec)\.[cm]?[jt]sx?$/u;

function testRunsOnce(command: string): boolean {
  return (
    !/(?:\bvp test\b|run-(?:next|vite)-microfrontend\.ts test\b)/u.test(command) ||
    /\s--run(?:\s|$)/u.test(command)
  );
}

function typeScriptNoEmit(config: string, visited = new Set<string>()): boolean | undefined {
  if (!existsSync(config) || visited.has(config)) return;
  visited.add(config);
  const value = JSON.parse(readFileSync(config, "utf8")) as {
    extends?: string;
    compilerOptions?: { noEmit?: boolean };
  };
  if (typeof value.compilerOptions?.noEmit === "boolean") return value.compilerOptions.noEmit;
  if (typeof value.extends !== "string") return;
  try {
    const parent = value.extends.startsWith(".")
      ? path.resolve(path.dirname(config), value.extends)
      : createRequire(config).resolve(value.extends);
    return typeScriptNoEmit(path.extname(parent) ? parent : `${parent}.json`, visited);
  } catch {
    return;
  }
}

function packageScriptOrderErrors(relative: string, scripts: Record<string, unknown>): string[] {
  const errors: string[] = [];
  let previousFamily = -1;
  let previousName = "";
  for (const name of Object.keys(scripts)) {
    const family = orderedScriptFamilies.indexOf(name.split(":")[0]);
    const rank = family < 0 ? orderedScriptFamilies.length : family;
    if (rank < previousFamily || (rank === previousFamily && family >= 0 && name < previousName)) {
      errors.push(`${relative} script ${name} is out of standard order after ${previousName}`);
    }
    previousFamily = rank;
    previousName = name;
  }
  return errors;
}

function packageScriptErrors(
  relative: string,
  root: string,
  scripts: Record<string, unknown>,
): string[] {
  const errors = packageScriptOrderErrors(relative, scripts);
  const packageRoot = path.dirname(path.join(root, relative));
  const config = path.join(packageRoot, "tsconfig.json");
  if (existsSync(config) && (typeof scripts.check !== "string" || scripts.check.trim() === "")) {
    errors.push(`${relative} needs a check script for its package-local tsconfig.json`);
  }
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== "string" || command.trim() === "") {
      errors.push(`${relative} script ${name} must be a non-empty command`);
    }
  }
  if (typeof scripts.test === "string" && !testRunsOnce(scripts.test)) {
    errors.push(`${relative} test script must run once with --run`);
  }
  const domainLibrary = /^packages\/domain-libs\/([^/]+)\/package\.json$/u.exec(relative);
  if (
    domainLibrary &&
    typeof scripts.test === "string" &&
    scripts.test.includes("--config ../vite.config.ts") &&
    !scripts.test.includes(`${domainLibrary[1]}/__tests__`)
  ) {
    errors.push(`${relative} shared test config must select only its own __tests__ directory`);
  }
  if (typeof scripts.build === "string") {
    if (
      /\s--noEmit(?:\s|$)/u.test(scripts.build) ||
      (/^tsc -p tsconfig\.json$/u.test(scripts.build) && typeScriptNoEmit(config) === true)
    ) {
      errors.push(
        `${relative} build script must emit artifacts; use check for no-emit TypeScript validation`,
      );
    }
    if (scripts.build === scripts.check) {
      errors.push(`${relative} build and check scripts must perform different operations`);
    }
  }
  if (typeof scripts.prepare === "string" && scripts.prepare === scripts.prepack) {
    errors.push(`${relative} prepare and prepack scripts must not repeat the same command`);
  }
  return errors;
}

function packageSourceFiles(directory: string, includeStyles = false): string[] {
  const files: string[] = [];
  const visit = (parent: string): void => {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!excludedSourceDirectories.has(entry.name) && !entry.name.startsWith(".")) {
          visit(path.join(parent, entry.name));
        }
      } else if (
        entry.isFile() &&
        (sourceExtensions.has(path.extname(entry.name)) ||
          (includeStyles && entry.name.endsWith(".css"))) &&
        !/\.stories\.[cm]?[jt]sx?$/u.test(entry.name)
      ) {
        files.push(path.join(parent, entry.name));
      }
    }
  };
  visit(directory);
  return files;
}

function packageTypeScriptConfigs(directory: string): string[] {
  const configs: string[] = [];
  const visit = (parent: string): void => {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!excludedSourceDirectories.has(entry.name) && !entry.name.startsWith(".")) {
          visit(path.join(parent, entry.name));
        }
      } else if (entry.isFile() && /^tsconfig(?:\.[a-z-]+)?\.json$/u.test(entry.name)) {
        configs.push(path.join(parent, entry.name));
      }
    }
  };
  visit(directory);
  return configs;
}

function importedModules(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const module = parseSync(file, text).module;
  const imports = module.staticImports.map((entry) => entry.moduleRequest.value);
  const exports = module.staticExports.flatMap((entry) =>
    entry.entries.flatMap((item) => item.moduleRequest?.value ?? []),
  );
  const dynamic = module.dynamicImports.flatMap((entry) => {
    const literal = text.slice(entry.moduleRequest.start, entry.moduleRequest.end);
    if (!/^['"][^'"]+['"]$/u.test(literal)) return [];
    return [literal.slice(1, -1)];
  });
  return [...new Set([...imports, ...exports, ...dynamic])];
}

function dependencyName(specifier: string): string | undefined {
  if (/^(?:[./#]|node:|bun:)/u.test(specifier) || builtins.has(specifier)) return;
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

function sourceAliases(root: string, relative: string): string[] {
  const aliases = new Set<string>();
  const visited = new Set<string>();
  const visit = (config: string): void => {
    if (!existsSync(config) || visited.has(config)) return;
    visited.add(config);
    const manifest = JSON.parse(readFileSync(config, "utf8")) as {
      extends?: string | string[];
      compilerOptions?: { paths?: Record<string, unknown> };
    };
    for (const alias of Object.keys(manifest.compilerOptions?.paths ?? {})) aliases.add(alias);
    for (const inherited of [manifest.extends]
      .flat()
      .filter((value): value is string => typeof value === "string")) {
      try {
        const parent = inherited.startsWith(".")
          ? path.resolve(path.dirname(config), inherited)
          : createRequire(config).resolve(inherited);
        visit(path.extname(parent) ? parent : `${parent}.json`);
      } catch {
        // Missing TypeScript presets are reported by the owning type check.
      }
    }
  };
  visit(path.join(root, "tsconfig.json"));
  visit(path.join(root, relative, "tsconfig.json"));
  return [...aliases];
}

function runtimeImports(file: string): string[] {
  const module = parseSync(file, readFileSync(file, "utf8")).module;
  return module.staticImports
    .filter((entry) => entry.entries.length === 0 || entry.entries.some((item) => !item.isType))
    .map((entry) => entry.moduleRequest.value);
}

function isRuntimePackageSource(packageRoot: string, source: string): boolean {
  const relative = path.relative(packageRoot, source);
  const filename = path.basename(source);
  return (
    !relative.startsWith(`scripts${path.sep}`) &&
    !relative.split(path.sep).includes("__tests__") &&
    !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(filename) &&
    !/^(?:test-setup|vitest\.setup|vite\.config|next\.config|playwright\.config)\.[cm]?[jt]sx?$/u.test(
      filename,
    )
  );
}

function matchesAlias(specifier: string, aliases: string[]): boolean {
  return aliases.some((alias) =>
    alias.endsWith("/*") ? specifier.startsWith(alias.slice(0, -1)) : specifier === alias,
  );
}

function readManifest(root: string, relative: string): Manifest {
  return JSON.parse(readFileSync(path.join(root, relative), "utf8")) as Manifest;
}

function exportTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  return Object.values(value).flatMap(exportTargets);
}

function packageExportErrors(root: string, relative: string, manifest: Manifest): string[] {
  const errors: string[] = [];
  const packageRoot = path.dirname(path.join(root, relative));
  const entries =
    typeof manifest.exports === "string"
      ? [[".", manifest.exports] as const]
      : manifest.exports && typeof manifest.exports === "object"
        ? Object.entries(manifest.exports)
        : [];
  for (const [entry, value] of entries) {
    const source =
      value && typeof value === "object" && "source" in value ? value.source : undefined;
    for (const target of exportTargets(value)) {
      if (!target.startsWith("./")) {
        errors.push(`${relative} export ${entry} target ${target} must be package-relative`);
        continue;
      }
      const resolved = path.resolve(packageRoot, target);
      if (!resolved.startsWith(`${packageRoot}${path.sep}`)) {
        errors.push(`${relative} export ${entry} target ${target} escapes its package`);
      } else if (target.startsWith("./dist/")) {
        if (
          typeof manifest.scripts?.build !== "string" ||
          typeof source !== "string" ||
          !existsSync(path.resolve(packageRoot, source))
        ) {
          errors.push(
            `${relative} generated export ${entry} target ${target} needs a build and existing source`,
          );
        }
      } else if (!existsSync(resolved)) {
        errors.push(`${relative} export ${entry} target ${target} does not exist`);
      }
    }
  }
  for (const target of exportTargets(manifest.bin)) {
    const resolved = path.resolve(packageRoot, target);
    if (
      !target.startsWith("./") ||
      !resolved.startsWith(`${packageRoot}${path.sep}`) ||
      !existsSync(resolved)
    ) {
      errors.push(`${relative} bin target ${target} must exist in its package`);
    }
  }
  return errors;
}

function workspaceManifests(root: string): string[] {
  const result = ["package.json"];
  const visit = (parent: string): void => {
    for (const entry of readdirSync(path.join(root, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const relative = `${parent}/${entry.name}`;
      const manifest = path.join(root, relative, "package.json");
      if (existsSync(manifest)) result.push(`${relative}/package.json`);
    }
  };
  if (existsSync(path.join(root, "apps"))) visit("apps");
  visit("packages");
  for (const entry of readdirSync(path.join(root, "packages"), { withFileTypes: true })) {
    if (entry.isDirectory()) visit(`packages/${entry.name}`);
  }
  result.push(".config/turbo/generators/package.json");
  return result.sort();
}

const scriptBinaries: Record<string, string[]> = {
  "@turbo/gen": ["turbo"],
  playwright: ["playwright"],
  typescript: ["tsc"],
  "vite-plus": ["vp"],
  vitest: ["vitest"],
};

export function likelyUnusedDependencies(root: string): string[] {
  const candidates: string[] = [];
  for (const relative of workspaceManifests(root)) {
    if (!relative.startsWith("packages/") && !relative.startsWith("apps/")) continue;
    const manifest = readManifest(root, relative);
    const directory = path.dirname(path.join(root, relative));
    const sourceFiles = packageSourceFiles(directory);
    const imports = new Set(
      sourceFiles.flatMap((file) =>
        importedModules(file)
          .map(dependencyName)
          .filter((name): name is string => !!name),
      ),
    );
    const sourceText = [
      ...packageSourceFiles(directory, true).map((file) => readFileSync(file, "utf8")),
      ...packageTypeScriptConfigs(directory).map((file) => readFileSync(file, "utf8")),
      JSON.stringify({
        ...manifest,
        dependencies: undefined,
        devDependencies: undefined,
        optionalDependencies: undefined,
        peerDependencies: undefined,
      }),
    ].join("\n");
    const scripts = Object.values(manifest.scripts ?? {})
      .filter((value): value is string => typeof value === "string")
      .join("\n");
    for (const section of dependencySections) {
      for (const name of Object.keys(manifest[section] ?? {})) {
        if (name.startsWith("@types/")) continue;
        const binaries = scriptBinaries[name] ?? [name.split("/").at(-1) ?? name];
        if (
          !imports.has(name) &&
          !sourceText.includes(name) &&
          !binaries.some((binary) =>
            new RegExp(
              `(?:^|[^\\w-])${binary.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?:$|[^\\w-])`,
              "u",
            ).test(scripts),
          )
        ) {
          candidates.push(`${relative} ${section}.${name}`);
        }
      }
    }
  }
  return candidates.sort();
}

export function checkPackageManifests(root: string): string[] {
  const errors: string[] = [];
  const rootManifest = readManifest(root, "package.json");
  const catalog = rootManifest.catalog ?? {};
  const directUse = new Map<string, Set<string>>();
  const manifests = workspaceManifests(root);
  const workspacePaths = new Map<string, string>();
  for (const relative of manifests) {
    const name = readManifest(root, relative).name;
    if (typeof name !== "string") continue;
    const previous = workspacePaths.get(name);
    if (previous) errors.push(`${relative} duplicates workspace name ${name} from ${previous}`);
    else workspacePaths.set(name, relative);
  }
  const workspaceNames = new Set(workspacePaths.keys());
  for (const [name, value] of Object.entries(catalog)) {
    if (typeof value !== "string" || (!exactVersion.test(value) && !exactAlias.test(value))) {
      errors.push(`package.json catalog ${name} must use an exact version or exact npm alias`);
    }
  }
  for (const relative of manifests) {
    const manifest = readManifest(root, relative);
    if (
      typeof manifest.name !== "string" ||
      manifest.name === "" ||
      typeof manifest.private !== "boolean"
    ) {
      errors.push(`${relative} must declare a name and private status`);
    }
    if (relative !== "package.json") {
      const keys = Object.keys(manifest);
      const sections = keys.filter((key) => orderedSections.includes(key));
      if (
        sections.join("\0") !== orderedSections.filter((key) => sections.includes(key)).join("\0")
      ) {
        errors.push(`${relative} dependency sections must follow standard order`);
      }
    }
    if (relative.startsWith("packages/") || relative === ".config/turbo/generators/package.json") {
      errors.push(...packageScriptErrors(relative, root, manifest.scripts ?? {}));
    } else if (relative.startsWith("apps/")) {
      errors.push(...packageScriptOrderErrors(relative, manifest.scripts ?? {}));
      if (typeof manifest.scripts?.test === "string" && !testRunsOnce(manifest.scripts.test)) {
        errors.push(`${relative} test script must run once with --run`);
      }
    }
    if (relative.startsWith("packages/") || relative.startsWith("apps/")) {
      errors.push(...packageExportErrors(root, relative, manifest));
    }
    for (const section of dependencySections) {
      const dependencies = manifest[section] ?? {};
      const names = Object.keys(dependencies);
      if (names.join("\0") !== [...names].sort().join("\0")) {
        errors.push(`${relative} ${section} keys must be sorted`);
      }
      for (const [name, value] of Object.entries(dependencies)) {
        if (typeof value !== "string" || value === "") {
          errors.push(`${relative} ${section}.${name} needs a dependency specifier`);
          continue;
        }
        if (value.startsWith("workspace:")) {
          if (value !== "workspace:*" || !workspaceNames.has(name)) {
            errors.push(
              `${relative} ${section}.${name} must reference an existing workspace with workspace:*`,
            );
          }
          continue;
        }
        if (workspaceNames.has(name)) {
          errors.push(`${relative} ${section}.${name} must use workspace:*`);
          continue;
        }
        const consumers = directUse.get(name) ?? new Set<string>();
        consumers.add(relative);
        directUse.set(name, consumers);
        if (Object.hasOwn(catalog, name) && value !== "catalog:") {
          errors.push(`${relative} ${section}.${name} must use the root catalog`);
        } else if (!Object.hasOwn(catalog, name) && value === "catalog:") {
          errors.push(`${relative} ${section}.${name} needs a root catalog pin`);
        }
      }
    }
    if (relative.startsWith("packages/") || relative.startsWith("apps/")) {
      const declared = new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}),
        ...Object.keys(manifest.optionalDependencies ?? {}),
      ]);
      const packageRoot = path.dirname(path.join(root, relative));
      const sourceFiles = packageSourceFiles(packageRoot);
      if (relative.startsWith("packages/")) {
        const tests = sourceFiles.filter((source) =>
          testFile.test(path.relative(packageRoot, source)),
        );
        const testTask = manifest.autograph?.testTask;
        if (tests.length > 0 && typeof manifest.scripts?.test !== "string") {
          const taskPath =
            typeof testTask === "string" && /^test:[a-z0-9-]+$/u.test(testTask)
              ? path.join(root, ".config/mise/tasks", ...testTask.split(":"))
              : null;
          const packagePath = path.dirname(relative);
          if (
            taskPath === null ||
            !existsSync(taskPath) ||
            !readFileSync(taskPath, "utf8").includes(`${packagePath}/`)
          ) {
            errors.push(
              `${relative} has tests but needs a test script or an owning repository test task`,
            );
          }
        } else if (testTask !== undefined) {
          errors.push(
            `${relative} must not declare a repository test task without package tests lacking a test script`,
          );
        }
      }
      const missing = new Map<string, string>();
      const runtimeDevOnly = new Map<string, string>();
      const aliases = sourceAliases(root, path.dirname(relative));
      for (const source of sourceFiles) {
        for (const specifier of importedModules(source)) {
          const name = dependencyName(specifier);
          if (
            !name ||
            (relative.startsWith("apps/") && frameworkModules.has(name)) ||
            name === manifest.name ||
            declared.has(name) ||
            (matchesAlias(specifier, aliases) && !workspaceNames.has(name))
          )
            continue;
          if (!missing.has(name)) missing.set(name, path.relative(root, source));
        }
        if (relative.startsWith("packages/") && isRuntimePackageSource(packageRoot, source)) {
          for (const specifier of runtimeImports(source)) {
            const name = dependencyName(specifier);
            if (
              name &&
              Object.hasOwn(manifest.devDependencies ?? {}, name) &&
              !Object.hasOwn(manifest.dependencies ?? {}, name) &&
              !Object.hasOwn(manifest.peerDependencies ?? {}, name) &&
              !Object.hasOwn(manifest.optionalDependencies ?? {}, name) &&
              !runtimeDevOnly.has(name)
            ) {
              runtimeDevOnly.set(name, path.relative(root, source));
            }
          }
        }
      }
      for (const [name, source] of missing) {
        errors.push(
          `${relative} imports ${name} in ${source} without a direct dependency declaration`,
        );
      }
      for (const [name, source] of runtimeDevOnly) {
        errors.push(
          `${relative} imports ${name} in ${source} but declares it only as a devDependency`,
        );
      }
    }
  }
  for (const [name, consumers] of directUse) {
    if (consumers.size > 1 && !Object.hasOwn(catalog, name)) {
      errors.push(`${name} is used by ${consumers.size} workspaces and needs a root catalog pin`);
    }
  }
  if (existsSync(path.join(root, ".storybook/package.json"))) {
    const storybook = readManifest(root, ".storybook/package.json");
    if (typeof storybook.name !== "string" || storybook.private !== true) {
      errors.push(".storybook/package.json must declare a name and private status");
    }
    errors.push(...packageScriptErrors(".storybook/package.json", root, storybook.scripts ?? {}));
    for (const [name, value] of Object.entries(storybook.devDependencies ?? {})) {
      if (Object.hasOwn(catalog, name) && value !== catalog[name]) {
        errors.push(
          `.storybook/package.json devDependencies.${name} must match the root catalog pin`,
        );
      }
    }
  }
  return errors.sort();
}

if (import.meta.main) {
  if (process.argv.includes("--report-unused")) {
    const candidates = likelyUnusedDependencies(process.cwd());
    for (const candidate of candidates) console.log(candidate);
    console.log(
      `${candidates.length} direct dependencies without a package-local source or script reference (advisory; review before removing)`,
    );
    process.exit(0);
  }
  const errors = checkPackageManifests(process.cwd());
  for (const error of errors) console.error(error);
  if (errors.length > 0) process.exitCode = 1;
}
