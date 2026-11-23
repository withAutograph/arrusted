import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import {
  checkedReleaseDirectory,
  verifyCheckedRelease,
} from "../../../../packages/generated-app-runtime/release";
import { schemaCompilerCommand } from "./schema-compiler-command";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const vpBin = path.join(root, "node_modules/.bin/vp");
const formatVersion = 1;
const dataArtifactNames = [
  "operation-manifest.json",
  "data-operations.ts",
  "data-operations.md",
  "data-server.ts",
] as const;
const artifactNames = [
  "app-artifact.json",
  "sql-manifest.json",
  "sql-bundle.sql",
  "transition-plan.json",
  "transition-contract.json",
  "runtime-coverage.json",
  "cue-to-sql-source-map.json",
  "release-manifest.json",
] as const;

type App = string;
type SqlManifest = {
  checksum: string;
  source_checksum: string;
  format_version: number;
  constraint_expression_coverage: unknown;
  runtime_api_capabilities: unknown;
  artifacts: Array<{ kind: string; name: string }>;
};

type CueOrigin = {
  source: string;
  path: string;
  kind: "app" | "model" | "field" | "constraint" | "migration";
};

export type Release = { app: App; version: string; directory: string };
export type GeneratedBuildOptions = {
  schemaVersion?: string;
  sourcePaths?: readonly string[];
  nextApp?: boolean;
};

type StagedSchemaIndex = { app: App; path: string; stagingPath: string };
export type RustReleaseApp = "hc" | "vendor";
type InstalledState = {
  releaseTarget: string;
  releaseBackup: string | undefined;
  indexTarget: string;
  indexBackup: Buffer | undefined;
  legacyPointerTarget: string;
  legacyPointerBackup: Buffer | undefined;
  rustReleasePointerTarget: string | undefined;
  rustReleasePointerBackup: Buffer | undefined;
};

export type ReleaseInstallHooks = {
  afterReleaseStaged?: (release: Release) => void;
  beforeIndexInstall?: (release: Release) => void;
  beforeLegacyPointerRemoval?: (release: Release) => void;
};

const generatedReleaseInputs: Record<App, string[]> = {};

if (import.meta.main) main();

/** Compiler test/tooling entrypoint for a schema outside the application catalog. */
export function buildGeneratedRelease(
  app: string,
  outputRoot: string,
  inputs: string[],
  repositoryRoot = root,
  compilerEnvironment = process.env,
  predecessors: readonly string[] = [],
  options: GeneratedBuildOptions = {},
): Release {
  generatedReleaseInputs[app] = inputs;
  return buildRelease(app, outputRoot, repositoryRoot, predecessors, compilerEnvironment, options);
}

export function appInputPaths(app: App, repositoryRoot = root): string[] {
  const generatedInputs = generatedReleaseInputs[app];
  if (generatedInputs !== undefined) {
    return generatedInputs.map((input) => path.join(repositoryRoot, input));
  }
  const appCue = path.join(repositoryRoot, "apps", app, "schema", `${app}.cue`);
  if (!existsSync(appCue)) throw new Error(`apps/${app}/schema/${app}.cue is required`);
  return [
    path.join(repositoryRoot, "packages/schema-compiler/cue/app-manifest.cue"),
    path.join(repositoryRoot, "packages/schema-compiler/cue/app-selection.cue"),
    appCue,
    path.join(repositoryRoot, "packages/domain-libs/catalog.json"),
  ].filter(existsSync);
}

export function discoverCompiledApps(repositoryRoot = root): App[] {
  const appsRoot = path.join(repositoryRoot, "apps");
  if (!existsSync(appsRoot)) return [];
  return readdirSync(appsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((app) => existsSync(path.join(appsRoot, app, "schema", `${app}.cue`)))
    .toSorted();
}

function main(): void {
  const command = process.argv[2];
  if (command !== "compile" && command !== "check" && command !== "sync-rust-pointer") {
    throw new Error(
      "usage: schema-release.ts <compile|check|sync-rust-pointer> [--app <app>] [--root <root>]",
    );
  }
  let selectedApp: App | undefined;
  let repositoryRoot = root;
  for (let index = 3; index < process.argv.length; index += 1) {
    const argument = process.argv[index];
    if (argument === "--app" || argument === "--root") {
      const value = process.argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      index += 1;
      if (argument === "--app") selectedApp = value;
      else repositoryRoot = path.resolve(value);
    } else throw new Error(`unknown argument ${argument}`);
  }

  if (command === "sync-rust-pointer") {
    if (selectedApp === undefined || !isRustReleaseApp(selectedApp)) {
      throw new Error("sync-rust-pointer requires --app hc or --app vendor");
    }
    syncGeneratedRustReleasePointer(selectedApp, repositoryRoot);
    return;
  }

  const externalPredecessors = externalTransitionPredecessors(
    process.env.APP_SCHEMA_TRANSITION_PREDECESSOR_FILES,
    selectedApp,
  );
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "schema-release-"));
  try {
    // Every app is discovered from its app-owned CUE source. Only historical
    // transition predecessors remain explicitly inventoried above.
    const apps = selectedApp === undefined ? discoverCompiledApps(repositoryRoot) : [selectedApp];
    const releases = apps.map((app) => {
      try {
        return buildRelease(app, temporaryRoot, repositoryRoot, externalPredecessors);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (detail.startsWith("Schema compilation failed")) throw error;
        throw new Error(
          `Schema release generation failed for ${app}.\n${detail}\n` +
            `Inspect the error above and retry with: ${schemaRetryCommand(app, repositoryRoot)}`,
          { cause: error },
        );
      }
    });
    if (command === "compile") {
      installCompiledReleases(releases, repositoryRoot);
      return;
    }
    const failures = releases.flatMap((release) =>
      checkRelease(release, repositoryRoot, externalPredecessors),
    );
    if (failures.length > 0) {
      for (const failure of failures) console.error(failure);
      process.exitCode = 1;
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function buildRelease(
  app: App,
  outputRoot: string,
  repositoryRoot = root,
  externalPredecessors: readonly string[] = [],
  compilerEnvironment = process.env,
  options: GeneratedBuildOptions = {},
): Release {
  const compile = (args: string[]) =>
    compiler(app, args, repositoryRoot, undefined, compilerEnvironment);
  const appArtifact = compile([
    "--app-artifact",
    ...(options.schemaVersion === undefined ? [] : ["--schema-version", options.schemaVersion]),
  ]);
  const artifact = parseCompilerJson<{
    schema: { version: string; models: Array<{ id: string; fields: Array<{ id: string }> }> };
    extras?: { constraints?: Array<{ id: string; model: string }> };
    client?: unknown;
  }>(app, "app artifact", appArtifact);
  const version = artifact.schema.version;
  const directory = path.join(outputRoot, app, version);
  mkdirSync(directory, { recursive: true });
  const sourcePaths = [
    ...appInputPaths(app, repositoryRoot).map((input) => path.relative(repositoryRoot, input)),
    ".config/mise/scripts/repository/schema-release.ts",
    ...(options.sourcePaths ?? []),
  ];
  const packagePath = `apps/${app}/package.json`;
  const packageFile = path.join(repositoryRoot, packagePath);
  const isNextApp = options.nextApp ?? appUsesNext(app, repositoryRoot);
  if (existsSync(packageFile)) sourcePaths.push(packagePath);
  assertNoAppAuthoredSql(appInputPaths(app, repositoryRoot));
  writeFileSync(path.join(directory, "app-artifact.json"), appArtifact);

  const compiledArgs = ["--compiled-artifact", path.join(directory, "app-artifact.json")];
  const retainedPlan = readRetainedTransitionPlan(app, version, repositoryRoot);
  const retainedPredecessor = checkedOnlineTransitionPredecessor(
    app,
    version,
    repositoryRoot,
    retainedPlan,
  );
  const planPredecessor =
    retainedPredecessor ??
    transitionPlanPredecessorArtifact(app, version, repositoryRoot, externalPredecessors);
  const runtimePredecessor = checkedDataPlanePredecessor(
    app,
    version,
    repositoryRoot,
    planPredecessor,
  );
  const members = releaseMembers();
  {
    const data = parseCompilerJson<{
      manifest: unknown;
      typescript: string;
      documentation: string;
    }>(
      app,
      "generated data operations",
      compile([
        "--data-plane",
        ...compiledArgs,
        ...(runtimePredecessor === undefined
          ? []
          : ["--previous-compiled-artifact", runtimePredecessor]),
      ]),
    );
    writeJson(path.join(directory, "operation-manifest.json"), data.manifest);
    writeFileSync(path.join(directory, "data-operations.ts"), data.typescript);
    writeFileSync(path.join(directory, "data-operations.md"), data.documentation);
    writeFileSync(path.join(directory, "data-server.ts"), generatedDataServerText(isNextApp));
  }
  const sqlManifest = compile(["--sql-manifest", ...compiledArgs]);
  const sqlBundle = compile(["--sql-bundle", ...compiledArgs]);
  const previous = transitionPredecessorArtifacts(
    app,
    version,
    repositoryRoot,
    externalPredecessors,
  );
  const transitionPlan = compile([
    "--sql-transition-plan",
    ...compiledArgs,
    ...(planPredecessor === undefined ? [] : ["--previous-compiled-artifact", planPredecessor]),
    ...onlineTransitionPlanArguments(app, repositoryRoot, planPredecessor, retainedPlan),
  ]);
  const transitionInputs = [
    ...previous,
    ...compilerOwnedTransitionArtifacts(app, appArtifact, outputRoot),
  ];
  const transitionContract = compile([
    "--schema-transition-contract",
    ...compiledArgs,
    ...transitionInputs.flatMap((artifactPath) => ["--previous-compiled-artifact", artifactPath]),
  ]);
  const manifest = parseCompilerJson<SqlManifest>(app, "SQL manifest", sqlManifest);
  const sourceFiles = Object.fromEntries(
    sourcePaths.map((source) => [source, sha256File(path.join(repositoryRoot, source))]),
  );
  const coverage = {
    format_version: formatVersion,
    constraint_expression_coverage: manifest.constraint_expression_coverage,
    runtime_api_capabilities: manifest.runtime_api_capabilities,
  };
  const sourceMap = buildCueToSqlSourceMap({
    app,
    version,
    sourceFiles,
    sourcePaths,
    artifact,
    artifacts: manifest.artifacts,
  });
  writeJson(path.join(directory, "sql-manifest.json"), manifest);
  writeFileSync(path.join(directory, "sql-bundle.sql"), sqlBundle);
  writeJson(
    path.join(directory, "transition-plan.json"),
    parseCompilerJson(app, "transition plan", transitionPlan),
  );
  writeJson(
    path.join(directory, "transition-contract.json"),
    parseCompilerJson(app, "transition contract", transitionContract),
  );
  writeJson(path.join(directory, "runtime-coverage.json"), coverage);
  writeJson(path.join(directory, "cue-to-sql-source-map.json"), sourceMap);
  formatJson(
    members
      .filter(
        (name) =>
          (name.endsWith(".json") || name.endsWith(".ts") || name.endsWith(".md")) &&
          name !== "release-manifest.json",
      )
      .map((name) => path.join(directory, name)),
  );

  const hashes = Object.fromEntries(
    members
      .filter((name) => name !== "release-manifest.json")
      .map((name) => [name, sha256File(path.join(directory, name))]),
  );
  writeJson(path.join(directory, "release-manifest.json"), {
    format_version: formatVersion,
    app,
    schema_version: version,
    compiler: compilerVersion(repositoryRoot, compilerEnvironment),
    formatting: {
      json: "serde_json_pretty_v1",
      sql: "schema_compiler_bundle_v1",
    },
    sources: sourceFiles,
    hashes: {
      source: sha256(JSON.stringify(sourceFiles)),
      schema: hashes["app-artifact.json"],
      plan: hashes["transition-plan.json"],
      transition_contract: hashes["transition-contract.json"],
      bundle: hashes["sql-bundle.sql"],
      client: sha256(JSON.stringify(artifact.client ?? null)),
      coverage: hashes["runtime-coverage.json"],
      sql_manifest: hashes["sql-manifest.json"],
      source_map: hashes["cue-to-sql-source-map.json"],
      operations: hashes["operation-manifest.json"],
      bindings: hashes["data-operations.ts"],
      operation_docs: hashes["data-operations.md"],
      server_bindings: hashes["data-server.ts"],
    },
    installer: {
      input: "sql-bundle.sql",
      expected_hash: manifest.checksum,
      source_hash: manifest.source_checksum,
      sql_manifest_format_version: manifest.format_version,
    },
  });
  formatJson([path.join(directory, "release-manifest.json")]);
  return { app, version, directory };
}

export function parseCompilerJson<T>(app: App, stage: string, value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    const excerpt = boundedCompilerOutput(value.trim(), 2_000);
    throw new Error(
      `The schema compiler produced invalid JSON for ${app} during ${stage}: ${error instanceof Error ? error.message : String(error)}. ` +
        "Rerun this stage directly and inspect its output; if CUE export succeeds, this is a compiler output defect." +
        (excerpt ? `\nCompiler output excerpt:\n${excerpt}` : ""),
      { cause: error },
    );
  }
}

/**
 * Keep the checked map compact and semantic: SQL text stays in sql-manifest.json,
 * while this map records the authored CUE declaration that owns each generated
 * object. The same stable object identity is used by trusted diagnostic mapping.
 */
export function buildCueToSqlSourceMap(input: {
  app: string;
  version: string;
  sourceFiles: Record<string, string>;
  sourcePaths: readonly string[];
  artifact: {
    schema: { models: Array<{ id: string; fields: Array<{ id: string }> }> };
    extras?: { constraints?: Array<{ id: string; model: string }> };
  };
  artifacts: Array<{ kind: string; name: string }>;
}): {
  format_version: number;
  app: string;
  version: string;
  sources: Record<string, string>;
  sql_artifacts: Array<{ kind: string; name: string; origin: CueOrigin }>;
  migrations: Array<{ version: string; origin: CueOrigin }>;
} {
  const appSource = `apps/${input.app}/schema/${input.app}.cue`;
  const source =
    input.sourceFiles[appSource] === undefined
      ? (input.sourcePaths.find((source) => source.endsWith("/schema/app.cue")) ??
        input.sourcePaths[0]!)
      : appSource;
  const appOrigin: CueOrigin = { source, path: "manifest", kind: "app" };
  const constraints = input.artifact.extras?.constraints ?? [];
  const modelOrigins = input.artifact.schema.models.map((model) => ({
    model,
    prefix: `${model.id}_`,
  }));
  const originFor = (artifact: { kind: string; name: string }): CueOrigin => {
    // PostgreSQL identifiers can truncate the authored constraint ID and add a
    // stable hash. Match its deterministic leading segment only when unique.
    const matchingConstraints = constraints.filter((entry) => {
      const prefix = entry.id.slice(0, 20);
      return (
        artifact.name.includes(`_${entry.id}_constraint`) ||
        artifact.name.endsWith(`_${entry.id}_check`) ||
        artifact.name.includes(`_${prefix}`)
      );
    });
    const constraint = matchingConstraints.length === 1 ? matchingConstraints[0] : undefined;
    if (constraint)
      return {
        source,
        path: `constraints.${constraint.id}.expression`,
        kind: "constraint",
      };
    const owner = modelOrigins.find(
      ({ model, prefix }) =>
        artifact.name === `${model.id}_record` ||
        artifact.name === `${model.id}_version` ||
        artifact.name.startsWith(prefix),
    )?.model;
    if (!owner) return appOrigin;
    const field = owner.fields.find(
      (entry) => artifact.name.includes(`_${entry.id}`) || artifact.name.includes(`.${entry.id}`),
    );
    return field
      ? { source, path: `models.${owner.id}.fields.${field.id}`, kind: "field" }
      : { source, path: `models.${owner.id}`, kind: "model" };
  };
  return {
    format_version: 2,
    app: input.app,
    version: input.version,
    sources: input.sourceFiles,
    sql_artifacts: input.artifacts.map((artifact) => ({
      kind: artifact.kind,
      name: artifact.name,
      origin: originFor(artifact),
    })),
    migrations: [
      {
        version: input.version,
        origin: { source, path: "version", kind: "migration" },
      },
    ],
  };
}

function compilerOwnedTransitionArtifacts(
  app: App,
  appArtifact: string,
  outputRoot: string,
): string[] {
  if (app !== "vendor") return [];
  const artifact = JSON.parse(appArtifact) as {
    schema: {
      version: string;
      models: Array<{ id: string }>;
      change_types: unknown[];
    };
  };
  const foundation = structuredClone(artifact);
  foundation.schema.version = "2026-07-16.vendor-analytics-foundation";
  foundation.schema.models = foundation.schema.models.filter(
    (model) => !["vendor_identity_mapping", "vendor_review_resolution"].includes(model.id),
  );
  foundation.schema.change_types = [];
  const foundationPath = path.join(outputRoot, "vendor-analytics-foundation.json");
  writeJson(foundationPath, foundation);

  return [foundationPath];
}

export function compiler(
  app: App,
  args: string[],
  repositoryRoot = root,
  executable?: string,
  compilerEnvironment = process.env,
): string {
  const inputArgs = args.includes("--compiled-artifact") ? [] : appInputPaths(app, repositoryRoot);
  const cargoArgs = ["run", "--quiet", "-p", "schema-compiler", "--", ...args, ...inputArgs];
  const invocation =
    executable !== undefined
      ? { executable, args: cargoArgs, env: compilerEnvironment }
      : schemaCompilerCommand(cargoArgs, compilerEnvironment);
  const phase =
    args.find(
      (arg) =>
        arg.startsWith("--") &&
        arg !== "--compiled-artifact" &&
        arg !== "--previous-compiled-artifact",
    ) ?? "manifest";
  const diagnosticsEnabled =
    compilerEnvironment.SCHEMA_COMPILER_DIAGNOSTICS === "1" && app === "runtime-trace-fixture";
  const startedAt = Date.now();
  if (diagnosticsEnabled) {
    console.error(JSON.stringify({
      event: "schema_compiler_start",
      app,
      phase,
      cwd: repositoryRoot,
      cargoTargetDir: compilerEnvironment.CARGO_TARGET_DIR ?? null,
      at: new Date(startedAt).toISOString(),
    }));
  }
  const result = spawnSync(invocation.executable, invocation.args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: invocation.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (diagnosticsEnabled) {
    console.error(JSON.stringify({
      event: "schema_compiler_end",
      app,
      phase,
      elapsedMs: Date.now() - startedAt,
      status: result.status,
      signal: result.signal,
      errorCode: result.error && "code" in result.error ? result.error.code : null,
      stdoutBytes: Buffer.byteLength(result.stdout ?? ""),
      stderrBytes: Buffer.byteLength(result.stderr ?? ""),
    }));
  }
  if (result.error || result.status !== 0) {
    const output = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    const details = [
      boundedCompilerOutput(result.stderr?.trim() ?? "", 9_000),
      boundedCompilerOutput(result.stdout?.trim() ?? "", 3_000),
    ]
      .filter(Boolean)
      .join("\n");
    const cueFailure =
      /(?:failed to run `cue`:.*(?:No such file|not found|ENOENT)|cue:.*(?:not found|not installed)|command not found: cue)/iu.test(
        output,
      );
    const nativeCompilerFailure =
      /(?:linker\s+[`"']?cc[`"']?\s+not found|ToolNotFound:.*(?:"cc"|\bcc\b)|(?:cc|gcc):?\s*(?:command not found|not found|not installed))/iu.test(
        output,
      );
    const toolchainFailure =
      /(?:mise|cargo|rustc):?\s*(?:command not found|not found|not installed|not configured|No such file)/iu.test(
        output,
      ) || result.error?.message.includes("ENOENT");
    const cueLocation = /\.cue:\d+(?::\d+)?/u.test(output);
    const guidance = cueFailure
      ? "Install the repository's locked mise tools and verify `mise exec --locked --no-deps -- cue version` succeeds."
      : nativeCompilerFailure
        ? "Install a native C compiler in the build environment and verify `cc --version` succeeds before rerunning the schema check."
        : toolchainFailure
          ? "Install the repository's locked mise tools, then verify `mise exec --locked --no-deps -- cargo --version` succeeds."
          : cueLocation
            ? "Read the compiler error and its CUE file location above, correct the app-owned schema or its inputs, then rerun the app's schema check."
            : output
              ? "No CUE source location was reported. Inspect the named compiler phase and error above; if the app inputs are valid, investigate the compiler implementation or environment for that phase."
              : "The compiler returned no output. Check the process signal and available disk/memory, then rerun the schema check to capture the first failing stage.";
    throw new Error(
      `Schema compilation failed for ${app} during ${phase} (exit ${result.status ?? "unavailable"}${result.signal ? `, signal ${result.signal}` : ""}).\n` +
        `${details || result.error?.message || "The compiler produced no diagnostic output."}\n` +
        `${guidance}\nRetry: ${schemaRetryCommand(app, repositoryRoot)}`,
    );
  }
  return result.stdout;
}

function boundedCompilerOutput(output: string, limit = 12_000): string {
  if (output.length <= limit) return output;
  const head = output.slice(0, limit / 2);
  const tail = output.slice(-limit / 2);
  return `${head}\n[${output.length - limit} compiler output characters omitted; showing beginning and end]\n${tail}`;
}

function schemaRetryCommand(app: App, repositoryRoot: string): string {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return `mise run schema:release -- check --app ${quote(app)}${repositoryRoot === root ? "" : ` --root ${quote(repositoryRoot)}`}`;
}

/** Caller-owned canonical predecessors are compiler inputs, never mutable source provenance. */
export function externalTransitionPredecessors(
  value: string | undefined,
  selectedApp: string | undefined,
): string[] {
  if (value === undefined) return [];
  if (selectedApp === undefined)
    throw new Error("APP_SCHEMA_TRANSITION_PREDECESSOR_FILES requires --app");
  const files: unknown = JSON.parse(value);
  if (
    !Array.isArray(files) ||
    files.some((file) => typeof file !== "string" || !path.isAbsolute(file) || !existsSync(file))
  ) {
    throw new Error(
      "APP_SCHEMA_TRANSITION_PREDECESSOR_FILES must be a JSON array of existing absolute artifact paths",
    );
  }
  const paths = [...new Set(files as string[])];
  for (const file of paths) {
    const artifact = JSON.parse(readFileSync(file, "utf8"));
    if (artifact?.schema?.app_id !== selectedApp) {
      throw new Error("External transition predecessor must belong to the selected app");
    }
  }
  // The compiler validates the full normalized artifact contract when it consumes these paths.
  return paths;
}

export function transitionPredecessorArtifacts(
  app: App,
  version: string,
  repositoryRoot: string,
  external: readonly string[] = [],
): string[] {
  return [...new Set([...external, ...priorReleaseArtifacts(app, version, repositoryRoot)])];
}

/** A plan has one prior cut; the transition contract retains every historical shape. */
export function transitionPlanPredecessorArtifact(
  app: App,
  version: string,
  repositoryRoot: string,
  external: readonly string[] = [],
): string | undefined {
  if (external.length > 0) return external[0];
  return priorReleaseArtifacts(app, version, repositoryRoot)
    .map((artifact) => ({ artifact, version: path.basename(path.dirname(artifact)) }))
    .filter((candidate) => compareReleaseCutOrder(candidate.version, version) < 0)
    .sort((left, right) => compareReleaseCutOrder(right.version, left.version))[0]?.artifact;
}

type CheckedTransitionPlan = {
  online_optional_text_addition?: {
    kind?: string;
    predecessor_artifact_sha256?: string;
  };
};

function readRetainedTransitionPlan(
  app: App,
  version: string,
  repositoryRoot: string,
): CheckedTransitionPlan | undefined {
  const directory = path.join(repositoryRoot, "apps", app, "schema", "release", version);
  const checkedPlan = path.join(directory, "transition-plan.json");
  if (!existsSync(checkedPlan)) return undefined;
  const retained = JSON.parse(readFileSync(checkedPlan, "utf8")) as CheckedTransitionPlan;
  if (retained.online_optional_text_addition?.kind === "optional-text-addition-v1") {
    const checked = verifyCheckedRelease(directory);
    if (checked.app !== app || checked.schema_version !== version) {
      throw new Error(`${app} ${version} has an invalid checked online schema plan identity`);
    }
  }
  return retained;
}

function checkedOnlineTransitionPredecessor(
  app: App,
  version: string,
  repositoryRoot: string,
  retained: CheckedTransitionPlan | undefined,
): string | undefined {
  const online = retained?.online_optional_text_addition;
  if (online?.kind !== "optional-text-addition-v1") return undefined;
  const digest = online.predecessor_artifact_sha256;
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error(`${app} ${version} has an invalid checked online schema predecessor digest`);
  }
  const matches = priorReleaseArtifacts(app, version, repositoryRoot).filter(
    (artifact) => sha256File(artifact) === `sha256:${digest}`,
  );
  if (matches.length !== 1) {
    const reason = matches.length === 0 ? "missing" : "ambiguous";
    throw new Error(`${app} ${version} has a ${reason} checked online schema predecessor`);
  }
  const predecessor = matches[0]!;
  const directory = path.dirname(predecessor);
  const checked = verifyCheckedRelease(directory);
  if (checked.app !== app || checked.schema_version !== path.basename(directory)) {
    throw new Error(`${app} ${version} has an invalid checked online schema predecessor identity`);
  }
  return predecessor;
}

/** Preserve issued data bindings while reproducing the evidence carried by newer checked cuts. */
function checkedDataPlanePredecessor(
  app: App,
  version: string,
  repositoryRoot: string,
  predecessor: string | undefined,
): string | undefined {
  if (predecessor === undefined) return undefined;
  const operations = path.join(
    repositoryRoot,
    "apps",
    app,
    "schema",
    "release",
    version,
    "operation-manifest.json",
  );
  if (!existsSync(operations)) return predecessor;
  const retained = JSON.parse(readFileSync(operations, "utf8")) as {
    predecessorCompatibility?: { kind?: string };
  };
  return retained.predecessorCompatibility?.kind === "optional-text-addition-v1"
    ? predecessor
    : undefined;
}

/** Reproduce opt-in for an existing cut without rewriting previously issued plans. */
function onlineTransitionPlanArguments(
  app: App,
  repositoryRoot: string,
  predecessor: string | undefined,
  retained: CheckedTransitionPlan | undefined,
): string[] {
  if (predecessor === undefined) return [];
  if (retained !== undefined) {
    return retained.online_optional_text_addition?.kind === "optional-text-addition-v1"
      ? ["--previous-sql-manifest", path.join(path.dirname(predecessor), "sql-manifest.json")]
      : [];
  }
  const releases = path.join(repositoryRoot, "apps", app, "schema", "release");
  // Builder may pass its privately staged predecessor artifact and restore the
  // same immutable release to the app tree. The release label alone is insufficient.
  const prior = parseCompilerJson<{ schema?: { version?: string } }>(
    app,
    "checked predecessor artifact",
    readFileSync(predecessor, "utf8"),
  );
  const priorVersion = prior.schema?.version;
  if (
    priorVersion === undefined ||
    path.basename(priorVersion) !== priorVersion ||
    [".", "..", ""].includes(priorVersion)
  )
    return [];
  const checkedDirectory = path.join(releases, priorVersion);
  const checkedArtifact = path.join(checkedDirectory, "app-artifact.json");
  const checkedSqlManifest = path.join(checkedDirectory, "sql-manifest.json");
  if (
    !existsSync(checkedArtifact) ||
    !existsSync(checkedSqlManifest) ||
    sha256File(predecessor) !== sha256File(checkedArtifact)
  )
    return [];
  verifyCheckedRelease(checkedDirectory);
  return ["--previous-sql-manifest", checkedSqlManifest];
}

function compareReleaseCutOrder(left: string, right: string): number {
  const date = (version: string) => /^\d{4}-\d{2}-\d{2}/u.exec(version)?.[0] ?? "";
  const leftDate = date(left);
  const rightDate = date(right);
  if (leftDate !== rightDate) return leftDate < rightDate ? -1 : 1;
  // Descriptions can change between cuts; v10 follows v9 on the same date.
  const cut = (version: string) => Number(/[.-]v(\d+)$/u.exec(version)?.[1] ?? 0);
  const cutOrder = cut(left) - cut(right);
  if (cutOrder !== 0) return cutOrder;
  return left < right ? -1 : left > right ? 1 : 0;
}

function priorReleaseArtifacts(app: App, version: string, repositoryRoot = root): string[] {
  const releases = path.join(repositoryRoot, "apps", app, "schema", "release");
  if (!existsSync(releases)) return [];
  return readdirSync(releases, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== version)
    .map((entry) => entry.name)
    .sort()
    .map((candidate) => path.join(releases, candidate, "app-artifact.json"))
    .filter(existsSync);
}

export function installCompiledReleases(
  releases: readonly Release[],
  repositoryRoot = root,
  hooks: ReleaseInstallHooks = {},
): void {
  const stagingRoot = mkdtempSync(path.join(tmpdir(), "schema-release-install-"));
  try {
    const indexes = stageSchemaIndexes(releases, repositoryRoot, stagingRoot);
    // Validate every generated member before considering a retained release.
    // The index depends only on the app/version, which retention does not change.
    const selected = releases.map((release) => retainedReleaseForInstall(release, repositoryRoot));
    const installed = snapshotInstalledState(selected, indexes, repositoryRoot, stagingRoot);
    try {
      for (const release of selected) {
        if (release.directory !== releaseTargetPath(release, repositoryRoot)) {
          replaceRelease(release, repositoryRoot, hooks);
        }
        hooks.beforeIndexInstall?.(release);
        installSchemaIndex(indexes.get(release.app)!);
        if (isRustReleaseApp(release.app)) {
          installGeneratedRustReleasePointer(release.app, release.version, repositoryRoot);
        }
        console.log(`wrote ${path.relative(root, releaseTargetPath(release, repositoryRoot))}`);
      }
      for (const release of releases) {
        hooks.beforeLegacyPointerRemoval?.(release);
        removeLegacyGeneratedDataPointer(release.app, repositoryRoot);
      }
    } catch (error) {
      try {
        restoreInstalledState(installed);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "schema release install and rollback both failed",
        );
      }
      throw error;
    }
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

/** Retain issued compiler output only while its complete app artifact and server adapter match. */
function retainedReleaseForInstall(release: Release, repositoryRoot: string): Release {
  const target = releaseTargetPath(release, repositoryRoot);
  if (!existsSync(target)) return release;
  try {
    verifyCheckedRelease(
      target,
      path.join(repositoryRoot, "apps", release.app, "schema", `${release.app}.cue`),
    );
    const artifact = (directory: string) =>
      JSON.parse(readFileSync(path.join(directory, "app-artifact.json"), "utf8"));
    const serverAdapter = (directory: string) =>
      readFileSync(path.join(directory, "data-server.ts"));
    if (
      isDeepStrictEqual(artifact(target), artifact(release.directory)) &&
      serverAdapter(target).equals(serverAdapter(release.directory))
    ) {
      return { ...release, directory: target };
    }
  } catch {
    // An absent, stale or invalid checked bundle retains the existing generation/install path.
  }
  return release;
}

function stageSchemaIndexes(
  releases: readonly Release[],
  repositoryRoot: string,
  stagingRoot: string,
): Map<App, StagedSchemaIndex> {
  const indexes = new Map<App, StagedSchemaIndex>();
  for (const release of releases) {
    if (indexes.has(release.app)) throw new Error(`duplicate compiled release for ${release.app}`);
    const sourceCue = path.join(
      repositoryRoot,
      "apps",
      release.app,
      "schema",
      `${release.app}.cue`,
    );
    if (!existsSync(sourceCue))
      throw new Error(`apps/${release.app}/schema/${release.app}.cue is required`);
    const manifest = verifyCheckedRelease(release.directory, sourceCue);
    if (manifest.app !== release.app) {
      throw new Error(`generated release belongs to another application: ${release.app}`);
    }
    if (manifest.schema_version !== release.version) {
      throw new Error(`generated release version does not match its manifest: ${release.app}`);
    }
    validateProspectiveReleaseSelection(release, sourceCue, repositoryRoot);
    const indexPath = generatedSchemaIndexPath(release.app, repositoryRoot);
    const stagingPath = path.join(stagingRoot, `${release.app}-index.ts`);
    writeFileSync(stagingPath, generatedSchemaIndexText(release.version));
    indexes.set(release.app, {
      app: release.app,
      path: indexPath,
      stagingPath,
    });
  }
  return indexes;
}

function validateProspectiveReleaseSelection(
  release: Release,
  sourceCue: string,
  repositoryRoot: string,
): void {
  const parent = path.join(repositoryRoot, "apps", release.app, "schema", "release");
  const sourceName = `apps/${release.app}/schema/${release.app}.cue`;
  const sourceHash = sha256File(sourceCue);
  const matchingVersions = existsSync(parent)
    ? readdirSync(parent, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() &&
            entry.name !== release.version &&
            existsSync(path.join(parent, entry.name, "release-manifest.json")),
        )
        .filter((entry) => {
          const sourceMap = JSON.parse(
            readFileSync(path.join(parent, entry.name, "cue-to-sql-source-map.json"), "utf8"),
          ) as { sources?: Record<string, string> };
          return sourceMap.sources?.[sourceName] === sourceHash;
        })
        .map((entry) => entry.name)
    : [];
  if (matchingVersions.length > 0) {
    throw new Error(`${release.app} must have exactly one checked release matching its CUE source`);
  }
}

function snapshotInstalledState(
  releases: readonly Release[],
  indexes: Map<App, StagedSchemaIndex>,
  repositoryRoot: string,
  stagingRoot: string,
): InstalledState[] {
  return releases.map((release) => {
    const releaseTarget = releaseTargetPath(release, repositoryRoot);
    const releaseBackup = path.join(stagingRoot, `${release.app}-${release.version}-release`);
    if (existsSync(releaseTarget)) cpSync(releaseTarget, releaseBackup, { recursive: true });
    const indexTarget = indexes.get(release.app)!.path;
    const legacyPointerTarget = legacyGeneratedDataPointerPath(release.app, repositoryRoot);
    const rustReleasePointerTarget = isRustReleaseApp(release.app)
      ? generatedRustReleasePointerPath(release.app, repositoryRoot)
      : undefined;
    return {
      releaseTarget,
      releaseBackup: existsSync(releaseTarget) ? releaseBackup : undefined,
      indexTarget,
      indexBackup: existsSync(indexTarget) ? readFileSync(indexTarget) : undefined,
      legacyPointerTarget,
      legacyPointerBackup: existsSync(legacyPointerTarget)
        ? readFileSync(legacyPointerTarget)
        : undefined,
      rustReleasePointerTarget,
      rustReleasePointerBackup:
        rustReleasePointerTarget !== undefined && existsSync(rustReleasePointerTarget)
          ? readFileSync(rustReleasePointerTarget)
          : undefined,
    };
  });
}

function releaseTargetPath(release: Release, repositoryRoot: string): string {
  return path.join(repositoryRoot, "apps", release.app, "schema", "release", release.version);
}

function replaceRelease(
  release: Release,
  repositoryRoot = root,
  hooks: ReleaseInstallHooks = {},
): void {
  const target = releaseTargetPath(release, repositoryRoot);
  const staging = `${target}.tmp`;
  rmSync(staging, { recursive: true, force: true });
  try {
    cpSync(release.directory, staging, { recursive: true });
    hooks.afterReleaseStaged?.(release);
    rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function installSchemaIndex(index: StagedSchemaIndex): void {
  const staging = `${index.path}.tmp`;
  rmSync(staging, { force: true });
  try {
    cpSync(index.stagingPath, staging);
    renameSync(staging, index.path);
  } finally {
    rmSync(staging, { force: true });
  }
}

function removeLegacyGeneratedDataPointer(app: App, repositoryRoot: string): void {
  rmSync(legacyGeneratedDataPointerPath(app, repositoryRoot), { force: true });
}

function restoreInstalledState(installed: readonly InstalledState[]): void {
  for (const state of installed.toReversed()) {
    rmSync(state.releaseTarget, { recursive: true, force: true });
    if (state.releaseBackup !== undefined)
      cpSync(state.releaseBackup, state.releaseTarget, { recursive: true });
    if (state.indexBackup === undefined) rmSync(state.indexTarget, { force: true });
    else writeFileSync(state.indexTarget, state.indexBackup);
    if (state.legacyPointerBackup === undefined) rmSync(state.legacyPointerTarget, { force: true });
    else writeFileSync(state.legacyPointerTarget, state.legacyPointerBackup);
    if (state.rustReleasePointerTarget !== undefined) {
      if (state.rustReleasePointerBackup === undefined)
        rmSync(state.rustReleasePointerTarget, { force: true });
      else writeFileSync(state.rustReleasePointerTarget, state.rustReleasePointerBackup);
    }
  }
}

export function checkRelease(
  release: Release,
  repositoryRoot = root,
  externalPredecessors: readonly string[] = [],
): string[] {
  const target = path.join(
    repositoryRoot,
    "apps",
    release.app,
    "schema",
    "release",
    release.version,
  );
  if (!existsSync(target))
    return [`${path.relative(root, target)} is missing; run \`mise run schema:compile\`.`];
  const actual = new Set(readdirSync(target));
  const members = releaseMembers();
  const expected = new Set<string>(members);
  const unexpected = [...actual].filter((name) => !expected.has(name));
  const failures = unexpected.map(
    (name) => `${path.relative(root, target)}/${name} is not a release artifact.`,
  );
  let historicalPlan = false;
  try {
    const checkedManifest = verifyCheckedRelease(
      target,
      path.join(repositoryRoot, "apps", release.app, "schema", `${release.app}.cue`),
    );
    const generatedManifest = JSON.parse(
      readFileSync(path.join(release.directory, "release-manifest.json"), "utf8"),
    );
    const script = ".config/mise/scripts/repository/schema-release.ts";
    const checkedPlan = readFileSync(path.join(target, "transition-plan.json"));
    if (
      externalPredecessors.length === 0 &&
      typeof checkedManifest.sources[script] === "string" &&
      checkedManifest.sources[script] !== generatedManifest.sources[script] &&
      !checkedPlan.equals(readFileSync(path.join(release.directory, "transition-plan.json")))
    ) {
      // Re-prove an issued plan using its historical oldest-first selection.
      // Generation always uses the corrected selector; external authority never falls back.
      const historicalPredecessor = priorReleaseArtifacts(
        release.app,
        release.version,
        repositoryRoot,
      )[0];
      const recompiled = compiler(
        release.app,
        [
          "--sql-transition-plan",
          "--compiled-artifact",
          path.join(release.directory, "app-artifact.json"),
          ...(historicalPredecessor === undefined
            ? []
            : ["--previous-compiled-artifact", historicalPredecessor]),
        ],
        repositoryRoot,
      );
      historicalPlan = isDeepStrictEqual(
        JSON.parse(checkedPlan.toString("utf8")),
        parseCompilerJson(release.app, "historical transition plan", recompiled),
      );
    }
  } catch (error) {
    failures.push(
      `Invalid checked release: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const name of members) {
    let generated = readFileSync(path.join(release.directory, name));
    const checked = path.join(target, name);
    if (historicalPlan && name === "transition-plan.json") continue;
    if (historicalPlan && name === "release-manifest.json") {
      const manifest = JSON.parse(generated.toString("utf8"));
      manifest.hashes.plan = sha256File(path.join(target, "transition-plan.json"));
      generated = Buffer.from(JSON.stringify(manifest));
    }
    if (!existsSync(checked)) {
      failures.push(`${path.relative(root, checked)} is missing; run \`mise run schema:compile\`.`);
    } else if (
      !readFileSync(checked).equals(generated) &&
      !isReleaseProvenanceOnlyChange(
        name,
        readFileSync(checked),
        generated,
        name === "release-manifest.json"
          ? readFileSync(path.join(release.directory, "cue-to-sql-source-map.json"))
          : undefined,
      )
    ) {
      failures.push(`${path.relative(root, checked)} is stale; run \`mise run schema:compile\`.`);
    }
  }
  return [
    ...failures,
    ...checkGeneratedSchemaIndex(release.app, release.version, repositoryRoot),
    ...(isRustReleaseApp(release.app)
      ? checkGeneratedRustReleasePointer(release.app, release.version, repositoryRoot)
      : []),
  ];
}

export function generatedHcReleasePointerText(version: string): string {
  return generatedRustReleasePointerText("hc", version);
}

export function generatedRustReleasePointerText(app: RustReleaseApp, version: string): string {
  const directory = `../schema/release/${version}`;
  const prefix = app === "hc" ? "HC" : "VENDOR";
  const artifact =
    app === "hc"
      ? [
          "#[cfg(test)]",
          "pub const HC_APP_ARTIFACT: &str =",
          `    include_str!(\"${directory}/app-artifact.json\");`,
        ]
      : [];
  const pointer = [
    "// Generated by schema-compiler. Do not edit.",
    ...artifact,
    `pub const ${prefix}_RELEASE_MANIFEST: &str =`,
    `    include_str!(\"${directory}/release-manifest.json\");`,
    `pub const ${prefix}_SQL_BUNDLE: &str =`,
    `    include_str!(\"${directory}/sql-bundle.sql\");`,
    `pub const ${prefix}_TRANSITION_CONTRACT: &str =`,
    `    include_str!(\"${directory}/transition-contract.json\");`,
    "",
  ].join("\n");
  const args = ["--emit", "stdout", "--edition", "2021"];
  const providerMise = process.env.VERCEL_MISE_BIN;
  return execFileSync(
    providerMise ?? "rustfmt",
    providerMise ? ["exec", "--locked", "--", "rustfmt", ...args] : args,
    {
      cwd: root,
      encoding: "utf8",
      env: providerMise ? { ...process.env, MISE_ENABLE_TOOLS: "rust" } : process.env,
      input: pointer,
    },
  );
}

function isRustReleaseApp(app: App): app is RustReleaseApp {
  return app === "hc" || app === "vendor";
}

function generatedRustReleasePointerPath(app: RustReleaseApp, repositoryRoot: string): string {
  return path.join(repositoryRoot, `apps/${app}/src/schema_release.rs`);
}

function installGeneratedRustReleasePointer(
  app: RustReleaseApp,
  version: string,
  repositoryRoot: string,
): void {
  const target = generatedRustReleasePointerPath(app, repositoryRoot);
  const staging = `${target}.tmp`;
  mkdirSync(path.dirname(target), { recursive: true });
  try {
    writeFileSync(staging, generatedRustReleasePointerText(app, version));
    renameSync(staging, target);
  } finally {
    rmSync(staging, { force: true });
  }
}

export function syncGeneratedRustReleasePointer(
  app: RustReleaseApp,
  repositoryRoot = root,
): string {
  const releaseDirectory = checkedReleaseDirectory(repositoryRoot, app);
  const version = path.basename(releaseDirectory);
  installGeneratedRustReleasePointer(app, version, repositoryRoot);
  return releaseDirectory;
}

export function checkGeneratedHcReleasePointer(version: string, repositoryRoot = root): string[] {
  return checkGeneratedRustReleasePointer("hc", version, repositoryRoot);
}

export function checkGeneratedRustReleasePointer(
  app: RustReleaseApp,
  version: string,
  repositoryRoot = root,
): string[] {
  const target = generatedRustReleasePointerPath(app, repositoryRoot);
  const relative = path.relative(repositoryRoot, target);
  const repair = `mise exec -- bun .config/mise/scripts/repository/schema-release.ts sync-rust-pointer --app ${app}`;
  if (!existsSync(target)) return [`${relative} is missing; run \`${repair}\`.`];
  return readFileSync(target, "utf8") === generatedRustReleasePointerText(app, version)
    ? []
    : [`${relative} is stale; run \`${repair}\`.`];
}

/** A frozen release keeps historical source hashes when generated outputs are otherwise identical. */
export function isReleaseProvenanceOnlyChange(
  name: string,
  checkedBytes: Buffer,
  generatedBytes: Buffer,
  generatedSourceMapBytes?: Buffer,
): boolean {
  if (name !== "cue-to-sql-source-map.json" && name !== "release-manifest.json") return false;
  const script = ".config/mise/scripts/repository/schema-release.ts";
  try {
    const checked = JSON.parse(checkedBytes.toString("utf8"));
    const generated = JSON.parse(generatedBytes.toString("utf8"));
    const app = checked.app;
    if (typeof app !== "string" || generated.app !== app) return false;
    const checkedSources = checked.sources;
    const generatedSources = generated.sources;
    if (typeof checkedSources !== "object" || checkedSources === null) return false;
    if (typeof generatedSources !== "object" || generatedSources === null) return false;
    const packageManifest = `apps/${app}/package.json`;
    const allowedSources = new Set([script, packageManifest]);
    const sourceNames = new Set([...Object.keys(checkedSources), ...Object.keys(generatedSources)]);
    const changedSources = [...sourceNames].filter(
      (source) => checkedSources[source] !== generatedSources[source],
    );
    if (
      changedSources.length === 0 ||
      changedSources.some((source) => !allowedSources.has(source)) ||
      changedSources.some(
        (source) =>
          typeof checkedSources[source] !== "string" ||
          typeof generatedSources[source] !== "string",
      )
    ) {
      return false;
    }
    if (name === "release-manifest.json") {
      if (generatedSourceMapBytes === undefined) return false;
      if (generated.hashes?.source !== sha256(JSON.stringify(generatedSources))) return false;
      if (generated.hashes?.source_map !== sha256(generatedSourceMapBytes)) return false;
    }
    for (const source of changedSources) generatedSources[source] = checkedSources[source];
    if (name === "release-manifest.json") {
      generated.hashes.source = checked.hashes.source;
      generated.hashes.source_map = checked.hashes.source_map;
    }
    return JSON.stringify(checked) === JSON.stringify(generated);
  } catch {
    return false;
  }
}

function appUsesNext(app: App, repositoryRoot: string): boolean {
  const packageFile = path.join(repositoryRoot, "apps", app, "package.json");
  return (
    existsSync(packageFile) &&
    Boolean(JSON.parse(readFileSync(packageFile, "utf8")).dependencies?.next)
  );
}

function generatedSchemaIndexPath(app: App, repositoryRoot: string): string {
  return path.join(repositoryRoot, "apps", app, "schema", "index.ts");
}

function legacyGeneratedDataPointerPath(app: App, repositoryRoot: string): string {
  return path.join(repositoryRoot, "apps", app, "schema", "generated-data.ts");
}

export function generatedDataServerText(isNextApp: boolean): string {
  return (
    (isNextApp ? 'import "server-only";\n' : "") +
    'export { createOperations, definition } from "./data-operations";\n' +
    'export type * from "./data-operations";\n' +
    'export { readPostgresAppActorBinding } from "@autograph/generated-app-runtime/actor-binding";\n' +
    'export type { AppActorBinding } from "@autograph/generated-app-runtime/actor-binding";\n' +
    "export type {\n" +
    "  CanonicalRecordKey,\n" +
    "  DataWrite,\n" +
    "  QueryInput,\n" +
    "  WriteOptions,\n" +
    '} from "@autograph/generated-app-runtime/data";\n' +
    'export type { FormActionResult, FormError, FormErrorCode } from "@autograph/generated-app-runtime/errors";\n'
  );
}

export function generatedSchemaIndexText(version: string): string {
  return "export * from " + JSON.stringify("./release/" + version + "/data-server") + ";\n";
}

export function writeGeneratedSchemaIndex(app: App, repositoryRoot = root): string {
  const releaseDirectory = checkedReleaseDirectory(repositoryRoot, app);
  const indexPath = generatedSchemaIndexPath(app, repositoryRoot);
  writeFileSync(indexPath, generatedSchemaIndexText(path.basename(releaseDirectory)));
  return indexPath;
}

export function checkGeneratedSchemaIndex(
  app: App,
  expectedVersion: string,
  repositoryRoot = root,
): string[] {
  let selectedVersion: string;
  try {
    selectedVersion = path.basename(checkedReleaseDirectory(repositoryRoot, app));
  } catch (error) {
    return [
      app +
        " schema index cannot select a checked release: " +
        (error instanceof Error ? error.message : String(error)),
    ];
  }

  const indexPath = generatedSchemaIndexPath(app, repositoryRoot);
  const relativeIndexPath = path.relative(repositoryRoot, indexPath);
  if (selectedVersion !== expectedVersion) {
    return [
      relativeIndexPath + " selects " + selectedVersion + "; expected " + expectedVersion + ".",
    ];
  }

  if (!existsSync(indexPath)) {
    return [relativeIndexPath + " is missing; run schema:compile."];
  }

  const expected = generatedSchemaIndexText(selectedVersion);
  if (readFileSync(indexPath, "utf8") !== expected) {
    return [relativeIndexPath + " is stale; run schema:compile."];
  }

  return [];
}

function compilerVersion(
  repositoryRoot = root,
  compilerEnvironment = process.env,
): {
  name: string;
  version: string;
} {
  const invocation = schemaCompilerCommand(
    ["metadata", "--no-deps", "--format-version", "1"],
    compilerEnvironment,
  );
  const metadata = JSON.parse(
    execFileSync(invocation.executable, invocation.args, {
      cwd: repositoryRoot,
      env: invocation.env,
      encoding: "utf8",
    }),
  ) as { packages: Array<{ name: string; version: string }> };
  const compiler = metadata.packages.find((pkg) => pkg.name === "schema-compiler");
  if (!compiler) throw new Error("schema-compiler package is absent from cargo metadata");
  return { name: compiler.name, version: compiler.version };
}

function assertNoAppAuthoredSql(sources: readonly string[]): void {
  if (sources.some((source) => source.endsWith(".sql"))) {
    throw new Error("app-authored SQL is not a supported release compiler input");
  }
}

function writeJson(filename: string, value: unknown): void {
  writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
}

function formatJson(files: readonly string[]): void {
  const diagnosticsEnabled =
    process.env.SCHEMA_COMPILER_DIAGNOSTICS === "1" &&
    files.some((file) => file.includes("runtime-trace-fixture"));
  const startedAt = Date.now();
  if (diagnosticsEnabled) {
    console.error(JSON.stringify({
      event: "schema_format_start",
      fileCount: files.length,
      firstFile: files[0] ? path.basename(files[0]) : null,
      at: new Date(startedAt).toISOString(),
    }));
  }
  try {
    execFileSync(vpBin, ["format", ...files], { cwd: root, stdio: "inherit" });
  } catch (error) {
    if (diagnosticsEnabled) {
      console.error(JSON.stringify({
        event: "schema_format_end",
        elapsedMs: Date.now() - startedAt,
        outcome: "failure",
        errorCode: error && typeof error === "object" && "code" in error ? error.code : null,
        signal: error && typeof error === "object" && "signal" in error ? error.signal : null,
      }));
    }
    throw error;
  }
  if (diagnosticsEnabled) {
    console.error(JSON.stringify({
      event: "schema_format_end",
      elapsedMs: Date.now() - startedAt,
      outcome: "success",
    }));
  }
}

function sha256File(filename: string): string {
  return sha256(readFileSync(filename));
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function releaseMembers(): readonly string[] {
  return [...artifactNames, ...dataArtifactNames];
}
