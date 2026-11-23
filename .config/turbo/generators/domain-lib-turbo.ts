import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const generatorFilePath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(generatorFilePath), "../../..");

type DomainLibTurboConfig = {
  extends: readonly string[];
  tasks: Record<string, { inputs: readonly string[]; outputs?: readonly string[] }>;
};

const domainLibTurboConfig = {
  extends: ["//"],
  tasks: {
    test: {
      inputs: [
        "$TURBO_DEFAULT$",
        "$TURBO_ROOT$/packages/domain-libs/vite.config.ts",
        "$TURBO_ROOT$/packages/**/*",
        "!$TURBO_ROOT$/packages/**/.turbo/**",
      ],
    },
    build: {
      inputs: [
        "$TURBO_DEFAULT$",
        "$TURBO_ROOT$/packages/**/*",
        "!$TURBO_ROOT$/packages/**/.turbo/**",
      ],
      outputs: [],
    },
  },
} as const satisfies DomainLibTurboConfig;

function domainLibTurboJson(): string {
  return `{
  "extends": ${formatInlineJsonArray(domainLibTurboConfig.extends)},
  "tasks": {
${formatTaskEntries(domainLibTurboConfig.tasks)}
  }
}
`;
}

function formatTaskEntries(tasks: DomainLibTurboConfig["tasks"]): string {
  return Object.entries(tasks)
    .map(([taskName, task]) => {
      const outputs = task.outputs === undefined ? "" : `,
      "outputs": ${formatInlineJsonArray(task.outputs)}`;
      return `    ${JSON.stringify(taskName)}: {
      "inputs": ${formatMultilineJsonArray(task.inputs, "      ")}${outputs}
    }`;
    })
    .join(",\n");
}

function formatInlineJsonArray(values: readonly string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

function formatMultilineJsonArray(values: readonly string[], indent: string): string {
  const lines = values.map((value) => `${indent}  ${JSON.stringify(value)}`);
  return `[\n${lines.join(",\n")}\n${indent}]`;
}

function domainLibPackageDirs(repoRoot: string): string[] {
  const domainLibRoot = path.join(repoRoot, "packages/domain-libs");
  if (!existsSync(domainLibRoot)) {
    throw new Error(`packages/domain-libs directory not found at ${domainLibRoot}`);
  }

  return readdirSync(domainLibRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(domainLibRoot, entry.name))
    .filter((entryPath) => existsSync(path.join(entryPath, "package.json")))
    .sort();
}

function domainLibTurboConfigPaths(root = repoRoot): string[] {
  return domainLibPackageDirs(root).map((packageDir) => path.join(packageDir, "turbo.json"));
}

function staleDomainLibTurboConfigPaths(root = repoRoot): string[] {
  // `--check` is semantic for object key order; `--write` remains the canonical formatter.
  const expected = stableStringify(domainLibTurboConfig);
  return domainLibTurboConfigPaths(root).filter((configPath) => {
    if (!existsSync(configPath)) return true;
    try {
      return stableStringify(JSON.parse(readFileSync(configPath, "utf8"))) !== expected;
    } catch {
      return true;
    }
  });
}

function writeDomainLibTurboConfigs(root = repoRoot): void {
  const expected = domainLibTurboJson();
  for (const configPath of domainLibTurboConfigPaths(root)) {
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, expected);
  }
}

function assertGeneratedJsonMatchesConfig(): void {
  if (stableStringify(JSON.parse(domainLibTurboJson())) !== stableStringify(domainLibTurboConfig)) {
    throw new Error("Domain-lib turbo generator output does not match the source config.");
  }
}

function stableStringify(value: unknown): string {
  // JSON-shaped values only. Object keys are unordered; array order is significant for Turbo inputs.
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export {
  domainLibTurboJson,
  stableStringify,
  staleDomainLibTurboConfigPaths,
  writeDomainLibTurboConfigs,
};

function isCliEntryPoint(): boolean {
  const entryPoint = process.argv[1];
  return entryPoint === undefined ? false : path.resolve(entryPoint) === generatorFilePath;
}

function runCli(): void {
  assertGeneratedJsonMatchesConfig();

  const mode = process.argv[2] ?? "--check";
  if (mode === "--write") {
    writeDomainLibTurboConfigs();
    return;
  }

  if (mode !== "--check") {
    throw new Error(`Unknown domain-lib turbo config mode: ${mode}`);
  }

  const stalePaths = staleDomainLibTurboConfigPaths();
  if (stalePaths.length > 0) {
    console.error("Stale domain-lib turbo configs. Regenerate with:");
    console.error("  mise exec -- bun .config/turbo/generators/domain-lib-turbo.ts --write");
    for (const configPath of stalePaths) {
      console.error(`  ${path.relative(repoRoot, configPath)}`);
    }
    process.exitCode = 1;
  }
}

if (isCliEntryPoint()) {
  runCli();
}
