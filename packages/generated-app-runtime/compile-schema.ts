import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyCheckedRelease } from "./release-verification";

const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(runtimeDir, "../..");
const moduleRequire = createRequire(import.meta.url);
const formatVersion = 1;

function resolveBundledOrRepoAsset(bundledName: string, repoRelativePath: string): string {
  const bundled = path.resolve(runtimeDir, "../assets", bundledName);
  if (existsSync(bundled)) return bundled;
  return path.join(defaultRepoRoot, repoRelativePath);
}

export function resolvePlatformCliBinary(
  binaryName: "schema-compiler" | "cue",
): string | undefined {
  const pkgName = `@arrusted/cli-${process.platform}-${process.arch}/package.json`;
  try {
    const pkgJsonPath = moduleRequire.resolve(pkgName);
    const exeName = process.platform === "win32" ? `${binaryName}.exe` : binaryName;
    const candidate = path.join(path.dirname(pkgJsonPath), "bin", exeName);
    if (existsSync(candidate)) return candidate;
  } catch {
    // Optional platform binary package is not installed; fall back to env/monorepo/PATH.
  }
  return undefined;
}

const releaseMembers = [
  "app-artifact.json",
  "sql-manifest.json",
  "sql-bundle.sql",
  "transition-plan.json",
  "transition-contract.json",
  "runtime-coverage.json",
  "cue-to-sql-source-map.json",
  "release-manifest.json",
  "operation-manifest.json",
  "data-operations.ts",
  "data-operations.md",
  "data-server.ts",
] as const;
const releaseMemberSet = new Set<string>(releaseMembers);

type CueOrigin = {
  source: string;
  path: string;
  kind: "app" | "model" | "field" | "constraint" | "migration";
};

type SqlManifest = {
  checksum: string;
  source_checksum: string;
  format_version: number;
  constraint_expression_coverage: unknown;
  runtime_api_capabilities: unknown;
  artifacts: Array<{ kind: string; name: string; sql: string }>;
};

export type CompileSchemaOptions = {
  /** Path to a schema directory containing *.cue files, or a single *.cue file. */
  schemaPath: string;
  /** Output directory for the 12 generated release artifacts (e.g. .generated/release). */
  outDir: string;
  /** Optional domain-libs catalog.json path when using #SelectedAppManifest. */
  catalogPath?: string;
  /** Optional explicit schema_version override (must not start with `build-`); defaults to deterministic `build-${buildHash}`. */
  schemaVersion?: string;
  /** Optional predecessor app-artifact.json files for additive transition planning. */
  predecessors?: readonly string[];
  /** Optional package version recorded in release-manifest.json and build metadata (excluded from portable buildHash). */
  packageVersion?: string;
  /** Git commit or build provenance recorded in build metadata. */
  sourceCommit?: string;
  /** Whether the working tree had uncommitted changes when compiled. */
  sourceDirty?: boolean;
  /** Emit `import "server-only"` in data-server.ts (default: true). */
  nextApp?: boolean;
  /** Optional explicit path to the prebuilt schema-compiler binary. */
  compilerBinary?: string;
  /** Optional explicit path to the prebuilt cue binary. */
  cueBinary?: string;
  /** Optional explicit path to app-manifest.cue. */
  appManifestCuePath?: string;
  /** Optional explicit path to app-selection.cue. */
  appSelectionCuePath?: string;
  /** Optional explicit path to Better Auth schema.sql. */
  authSchemaSqlPath?: string;
  /** Optional explicit path to single-organization-membership.sql. */
  membershipSqlPath?: string;
  /** Optional runtime module specifier emitted in data-server.ts. */
  runtimeModuleSpecifier?: string;
};

export type CompiledSchemaResult = {
  app: string;
  customerId: string;
  version: string;
  buildHash: string;
  releaseHash: string;
  directory: string;
};

const sha256Hex = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");
const sha256Prefixed = (value: string | Buffer): string => `sha256:${sha256Hex(value)}`;
const normalizeLfTextHash = (bytes: Buffer): string =>
  sha256Prefixed(bytes.toString("utf8").replace(/\r\n/gu, "\n"));

function writeJson(filename: string, value: unknown): void {
  writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
}

function generatedDataServerText(nextApp: boolean, runtimePkg: string): string {
  return (
    (nextApp ? 'import "server-only";\n' : "") +
    'export { createOperations, definition } from "./data-operations";\n' +
    'export type * from "./data-operations";\n' +
    `export { readPostgresAppActorBinding } from "${runtimePkg}/actor-binding";\n` +
    `export type { AppActorBinding } from "${runtimePkg}/actor-binding";\n` +
    "export type {\n" +
    "  CanonicalRecordKey,\n" +
    "  DataWrite,\n" +
    "  QueryInput,\n" +
    "  WriteOptions,\n" +
    `} from "${runtimePkg}/data";\n` +
    `export type { FormActionResult, FormError, FormErrorCode } from "${runtimePkg}/errors";\n`
  );
}

let monorepoCompilerReady = false;

function resolveCompilerInvocation(
  explicitBinary?: string,
  explicitCueBinary?: string,
): {
  executable: string;
  prefixArgs: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
} {
  const configuredCue = explicitCueBinary?.trim() || process.env.ARRUSTED_CUE_BIN?.trim();
  if (configuredCue) {
    const resolvedCue = path.resolve(configuredCue);
    const cueBase = path.basename(resolvedCue);
    if (!existsSync(resolvedCue) || (cueBase !== "cue" && cueBase !== "cue.exe")) {
      throw new Error(`Configured cue binary must exist and be named 'cue': ${resolvedCue}`);
    }
  }
  const cueBin = configuredCue || resolvePlatformCliBinary("cue");
  const baseEnv: NodeJS.ProcessEnv = cueBin
    ? {
        ...process.env,
        PATH: `${path.dirname(path.resolve(cueBin))}${path.delimiter}${process.env.PATH ?? ""}`,
      }
    : process.env;
  const envBinary = process.env.ARRUSTED_SCHEMA_COMPILER_BIN?.trim();
  if (explicitBinary || envBinary) {
    const resolved = path.resolve((explicitBinary ?? envBinary)!);
    if (!existsSync(resolved)) {
      throw new Error(`Configured schema-compiler binary does not exist: ${resolved}`);
    }
    return { executable: resolved, prefixArgs: [], cwd: process.cwd(), env: baseEnv };
  }
  const platformCompiler = resolvePlatformCliBinary("schema-compiler");
  if (platformCompiler) {
    return { executable: platformCompiler, prefixArgs: [], cwd: process.cwd(), env: baseEnv };
  }
  const cargoToml = path.join(defaultRepoRoot, "Cargo.toml");
  if (existsSync(cargoToml)) {
    const debugBin = path.join(defaultRepoRoot, "target/debug/schema-compiler");
    const cargoEnv = { ...baseEnv, CARGO_TARGET_DIR: path.join(defaultRepoRoot, "target") };
    if (!monorepoCompilerReady) {
      const build = spawnSync("cargo", ["build", "--quiet", "-p", "schema-compiler"], {
        cwd: defaultRepoRoot,
        encoding: "utf8",
        env: cargoEnv,
      });
      if (build.status !== 0) {
        throw new Error(
          `Failed to build schema-compiler: ${build.stderr?.trim() || build.error?.message || "unknown error"}`,
        );
      }
      monorepoCompilerReady = true;
    }
    if (existsSync(debugBin)) {
      return { executable: debugBin, prefixArgs: [], cwd: process.cwd(), env: baseEnv };
    }
    return {
      executable: "cargo",
      prefixArgs: ["run", "--quiet", "-p", "schema-compiler", "--"],
      cwd: defaultRepoRoot,
      env: cargoEnv,
    };
  }
  return { executable: "schema-compiler", prefixArgs: [], cwd: process.cwd(), env: baseEnv };
}

function runCompiler(
  invocation: ReturnType<typeof resolveCompilerInvocation>,
  args: string[],
): string {
  const phase =
    args.find(
      (arg) =>
        arg.startsWith("--") &&
        arg !== "--compiled-artifact" &&
        arg !== "--previous-compiled-artifact",
    ) ?? "manifest";
  const result = spawnSync(invocation.executable, [...invocation.prefixArgs, ...args], {
    cwd: invocation.cwd,
    encoding: "utf8",
    env: invocation.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      throw new Error(
        `No prebuilt @arrusted/cli-${process.platform}-${process.arch} binary is available for ${process.platform}-${process.arch} (supported in 0.1: darwin-arm64, linux-x64). Set ARRUSTED_SCHEMA_COMPILER_BIN and ARRUSTED_CUE_BIN to local binary paths, or install schema-compiler and cue on PATH.`,
      );
    }
    const details = [result.stderr?.trim(), result.stdout?.trim()].filter(Boolean).join("\n");
    if (/failed to run `cue export`.*No such file or directory/iu.test(details)) {
      throw new Error(
        `Could not locate 'cue' for ${process.platform}-${process.arch} (prebuilt packages in 0.1 cover darwin-arm64 and linux-x64). Set ARRUSTED_CUE_BIN to a local cue binary or install cue on PATH.`,
      );
    }
    throw new Error(
      `Schema compilation failed during ${phase} (exit ${result.status ?? "unavailable"}).\n` +
        (details || result.error?.message || "The compiler produced no diagnostic output."),
    );
  }
  return result.stdout;
}

function collectCueInputs(schemaPath: string): { files: string[]; primaryCue: string } {
  const resolved = path.resolve(schemaPath);
  if (!existsSync(resolved)) {
    throw new Error(`Schema path does not exist: ${resolved}`);
  }
  const stat = statSync(resolved);
  if (stat.isFile()) {
    if (resolved.endsWith(".sql")) {
      throw new Error("App-authored SQL is not a supported schema compiler input.");
    }
    return { files: [resolved], primaryCue: resolved };
  }
  const entries = readdirSync(resolved).sort();
  if (entries.some((name) => name.endsWith(".sql"))) {
    throw new Error("App-authored SQL is not a supported schema compiler input.");
  }
  const cueFiles = entries.flatMap((name) =>
    name.endsWith(".cue") ? [path.join(resolved, name)] : [],
  );
  if (cueFiles.length === 0) {
    throw new Error(`No .cue files found in ${resolved}`);
  }
  const appCue = cueFiles.find((file) => path.basename(file) === "app.cue") ?? cueFiles[0]!;
  return { files: cueFiles, primaryCue: appCue };
}

function logicalCueKey(filePath: string): string {
  return path.basename(filePath);
}

function assertSafeOutputDirectory(outDir: string): void {
  if (!existsSync(outDir)) return;
  const stat = statSync(outDir);
  if (!stat.isDirectory()) {
    throw new Error(`Compile output path is not a directory: ${outDir}`);
  }
  const entries = readdirSync(outDir);
  if (entries.length === 0) return;
  const onlyReleaseFiles =
    entries.includes("release-manifest.json") &&
    entries.every(
      (entry) => releaseMemberSet.has(entry) && statSync(path.join(outDir, entry)).isFile(),
    );
  if (!onlyReleaseFiles) {
    throw new Error(
      `Refusing to overwrite non-empty directory '${outDir}' because it contains files not owned by compileSchema(). Choose an empty directory or an existing generated release directory.`,
    );
  }
}

export function resolveBuildMetadataPath(outDir: string): string {
  const resolved = path.resolve(outDir);
  return path.basename(resolved) === "release"
    ? path.join(path.dirname(resolved), "build.json")
    : `${resolved}.build.json`;
}

function buildCueToSqlSourceMap(input: {
  app: string;
  version: string;
  sourceFiles: Record<string, string>;
  primaryCueKey: string;
  artifact: {
    schema: { models: Array<{ id: string; fields: Array<{ id: string }> }> };
    extras?: { constraints?: Array<{ id: string; model: string }> };
  };
  artifacts: Array<{ kind: string; name: string }>;
}) {
  const source = input.primaryCueKey;
  const appOrigin: CueOrigin = { source, path: "manifest", kind: "app" };
  const constraints = input.artifact.extras?.constraints ?? [];
  const modelOrigins = input.artifact.schema.models.map((model) => ({
    model,
    prefix: `${model.id}_`,
  }));
  const originFor = (artifact: { kind: string; name: string }): CueOrigin => {
    const matchingConstraints = constraints.filter((entry) => {
      const prefix = entry.id.slice(0, 20);
      return (
        artifact.name.includes(`_${entry.id}_constraint`) ||
        artifact.name.endsWith(`_${entry.id}_check`) ||
        artifact.name.includes(`_${prefix}`)
      );
    });
    const constraint = matchingConstraints.length === 1 ? matchingConstraints[0] : undefined;
    if (constraint) {
      return {
        source,
        path: `constraints.${constraint.id}.expression`,
        kind: "constraint",
      };
    }
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

/** Rewrite only emitted runtime import specifiers so model labels/literals remain untouched. */
export function rewriteRuntimeImports(typescript: string, runtimePkg: string): string {
  if (runtimePkg === "@autograph/generated-app-runtime") return typescript;
  return typescript.replace(
    /^((?:import|export)(?:\s+type)?\s+(?:\{[^;]*?\}|\*\s+as\s+\w+|\*)\s+from\s+)"@autograph\/generated-app-runtime\/([^"\r\n]+)";$/gmu,
    `$1"${runtimePkg}/$2";`,
  );
}

/** Pure current-state CUE -> SQL + TypeScript codegen with portable build identity. */
export function compileSchema(options: CompileSchemaOptions): CompiledSchemaResult {
  const explicitSchemaVersion = options.schemaVersion?.trim();
  if (explicitSchemaVersion !== undefined) {
    if (explicitSchemaVersion.length === 0) {
      throw new Error("Explicit schemaVersion must not be empty.");
    }
    if (explicitSchemaVersion.startsWith("build-")) {
      throw new Error("Explicit schemaVersion must not use the reserved 'build-' prefix.");
    }
  }
  const outDir = path.resolve(options.outDir);
  assertSafeOutputDirectory(outDir);
  const metadataPath = resolveBuildMetadataPath(outDir);
  if (existsSync(metadataPath) && statSync(metadataPath).isDirectory()) {
    throw new Error(`Build metadata path is a directory: ${metadataPath}`);
  }

  const { files: cueFiles, primaryCue } = collectCueInputs(options.schemaPath);
  const appManifestCue = path.resolve(
    options.appManifestCuePath ??
      resolveBundledOrRepoAsset(
        "app-manifest.cue",
        "packages/schema-compiler/cue/app-manifest.cue",
      ),
  );
  const authSchemaSql = path.resolve(
    options.authSchemaSqlPath ??
      resolveBundledOrRepoAsset("schema.sql", "packages/auth/schema.sql"),
  );
  const membershipSql = path.resolve(
    options.membershipSqlPath ??
      resolveBundledOrRepoAsset(
        "single-organization-membership.sql",
        "packages/auth/single-organization-membership.sql",
      ),
  );
  let resolvedSelectionCue: string | undefined;
  let resolvedCatalogPath: string | undefined;
  if (options.catalogPath !== undefined) {
    const selectionCue = path.resolve(
      options.appSelectionCuePath ??
        resolveBundledOrRepoAsset(
          "app-selection.cue",
          "packages/schema-compiler/cue/app-selection.cue",
        ),
    );
    if (existsSync(selectionCue)) {
      resolvedSelectionCue = selectionCue;
    }
    resolvedCatalogPath = path.resolve(options.catalogPath);
  }
  const invocation = resolveCompilerInvocation(options.compilerBinary, options.cueBinary);
  const pkgJsonCandidate = path.join(runtimeDir, "package.json");
  const parentPkgJsonCandidate = path.resolve(runtimeDir, "../package.json");
  const resolvedPkgJson = existsSync(pkgJsonCandidate)
    ? pkgJsonCandidate
    : existsSync(parentPkgJsonCandidate)
      ? parentPkgJsonCandidate
      : undefined;
  const packageVersion =
    options.packageVersion ??
    (resolvedPkgJson
      ? (JSON.parse(readFileSync(resolvedPkgJson, "utf8")) as { version?: string }).version
      : undefined) ??
    "0.0.0";
  const runtimePkg = options.runtimeModuleSpecifier ?? "@autograph/generated-app-runtime";
  const nextApp = options.nextApp ?? true;

  mkdirSync(path.dirname(outDir), { recursive: true });
  const stagingRoot = mkdtempSync(path.join(path.dirname(outDir), ".compile-"));
  const backupDir = path.join(stagingRoot, "previous-release");
  const backupMetadataPath = path.join(stagingRoot, "previous-build.json");

  try {
    // 0. Snapshot every compiler & SQL input once so probe, hashes, and final compile read identical bytes.
    const inputSnapshotDir = path.join(stagingRoot, "inputs");
    const cueSnapshotDir = path.join(inputSnapshotDir, "schema");
    mkdirSync(cueSnapshotDir, { recursive: true });

    const stagedAppManifestCue = path.join(inputSnapshotDir, "app-manifest.cue");
    const appManifestBytes = readFileSync(appManifestCue);
    writeFileSync(stagedAppManifestCue, appManifestBytes);

    const stagedExtraInputs: string[] = [];
    let selectionBytes: Buffer | undefined;
    if (resolvedSelectionCue !== undefined) {
      const stagedSelection = path.join(inputSnapshotDir, "app-selection.cue");
      selectionBytes = readFileSync(resolvedSelectionCue);
      writeFileSync(stagedSelection, selectionBytes);
      stagedExtraInputs.push(stagedSelection);
    }
    let catalogBytes: Buffer | undefined;
    if (resolvedCatalogPath !== undefined) {
      const stagedCatalog = path.join(inputSnapshotDir, "catalog.json");
      catalogBytes = readFileSync(resolvedCatalogPath);
      writeFileSync(stagedCatalog, catalogBytes);
      stagedExtraInputs.push(stagedCatalog);
    }
    const stagedCueFiles: Array<{ key: string; stagedPath: string; bytes: Buffer }> = cueFiles.map(
      (file) => {
        const key = logicalCueKey(file);
        const stagedPath = path.join(cueSnapshotDir, key);
        const bytes = readFileSync(file);
        writeFileSync(stagedPath, bytes);
        return { key, stagedPath, bytes };
      },
    );
    const authSchemaBytes = readFileSync(authSchemaSql);
    const membershipBytes = readFileSync(membershipSql);
    const primaryCueKey = logicalCueKey(primaryCue);
    const stagedPrimaryCue =
      stagedCueFiles.find((entry) => entry.key === primaryCueKey)?.stagedPath ??
      stagedCueFiles[0]!.stagedPath;
    const compilerInputs = [
      stagedAppManifestCue,
      ...stagedExtraInputs,
      ...stagedCueFiles.map((entry) => entry.stagedPath),
    ];

    const predecessors = (options.predecessors ?? []).map((pred, idx) => {
      const stagedPred = path.join(inputSnapshotDir, `pred-${idx}.json`);
      cpSync(path.resolve(pred), stagedPred);
      return stagedPred;
    });

    // 1. Probe pass to compute a portable, platform-, directory-, and line-ending-independent buildHash
    // covering adapter options, normalized CUE manifest, data-plane bindings, emitted SQL runtime, and auth SQL
    // (excluding raw CUE text and packageVersion so comment-only edits and patch bumps keep the same version).
    const probeVersion = "build-probe";
    const probeArtifactRaw = runCompiler(invocation, [
      "--app-artifact",
      "--schema-version",
      probeVersion,
      ...compilerInputs,
    ]);
    const probeArtifactPath = path.join(stagingRoot, "probe-artifact.json");
    writeFileSync(probeArtifactPath, probeArtifactRaw);
    const probeSqlManifestRaw = runCompiler(invocation, [
      "--sql-manifest",
      "--compiled-artifact",
      probeArtifactPath,
    ]);
    const probeDataPlane = JSON.parse(
      runCompiler(invocation, ["--data-plane", "--compiled-artifact", probeArtifactPath]),
    ) as {
      manifest: Record<string, unknown>;
      typescript: string;
    };
    const probeArtifact = JSON.parse(probeArtifactRaw) as {
      schema: Record<string, unknown>;
      extras?: unknown;
      client?: unknown;
    };
    const probeSqlManifest = JSON.parse(probeSqlManifestRaw) as SqlManifest;
    const { version: _ignoredVersion, ...versionlessSchema } = probeArtifact.schema;
    const { schemaVersion: _ignoredDataPlaneVersion, ...versionlessDataPlaneManifest } =
      probeDataPlane.manifest;
    const normalizedProbeTypescript = probeDataPlane.typescript.replaceAll(
      JSON.stringify(probeVersion),
      '"__BUILD_PROBE__"',
    );

    const sourceEntries: Array<[string, string]> = [
      ["packages/schema-compiler/cue/app-manifest.cue", sha256Prefixed(appManifestBytes)],
      ...(selectionBytes !== undefined
        ? [
            ["packages/schema-compiler/cue/app-selection.cue", sha256Prefixed(selectionBytes)] as [
              string,
              string,
            ],
          ]
        : []),
      ...(catalogBytes !== undefined
        ? [["catalog.json", sha256Prefixed(catalogBytes)] as [string, string]]
        : []),
      ...stagedCueFiles.map(
        (entry) => [entry.key, sha256Prefixed(entry.bytes)] as [string, string],
      ),
      ["packages/auth/schema.sql", sha256Prefixed(authSchemaBytes)],
      ["packages/auth/single-organization-membership.sql", sha256Prefixed(membershipBytes)],
    ];
    const sourceFiles = Object.fromEntries(sourceEntries);

    const sqlSources = {
      "packages/auth/schema.sql": normalizeLfTextHash(authSchemaBytes),
      "packages/auth/single-organization-membership.sql": normalizeLfTextHash(membershipBytes),
    };

    const buildHash = sha256Hex(
      JSON.stringify({
        nextApp,
        runtimePkg,
        schema: versionlessSchema,
        extras: probeArtifact.extras ?? null,
        client: probeArtifact.client ?? null,
        dataPlaneManifest: versionlessDataPlaneManifest,
        dataPlaneTypescriptSha256: sha256Hex(normalizedProbeTypescript),
        sqlArtifacts: probeSqlManifest.artifacts.map((entry) => ({
          kind: entry.kind,
          name: entry.name,
          sql: entry.sql,
        })),
        sqlSources,
      }),
    );
    const version = explicitSchemaVersion ?? `build-${buildHash}`;

    // 2. Emit final current-state bundle for `version` from the staged input snapshot
    const stagedRelease = path.join(stagingRoot, "release");
    mkdirSync(stagedRelease, { recursive: true });

    const appArtifactRaw = runCompiler(invocation, [
      "--app-artifact",
      "--schema-version",
      version,
      ...compilerInputs,
    ]);
    const artifact = JSON.parse(appArtifactRaw) as {
      schema: {
        app_id: string;
        customer_id: string;
        version: string;
        models: Array<{ id: string; fields: Array<{ id: string }> }>;
      };
      extras?: { constraints?: Array<{ id: string; model: string }> };
      client?: unknown;
    };
    const app = artifact.schema.app_id;
    const artifactPath = path.join(stagedRelease, "app-artifact.json");
    writeJson(artifactPath, artifact);

    const compiledArgs = ["--compiled-artifact", artifactPath];
    const dataPlane = JSON.parse(
      runCompiler(invocation, [
        "--data-plane",
        ...compiledArgs,
        ...(predecessors[0] === undefined ? [] : ["--previous-compiled-artifact", predecessors[0]]),
      ]),
    ) as {
      manifest: unknown;
      typescript: string;
      documentation: string;
    };
    writeJson(path.join(stagedRelease, "operation-manifest.json"), dataPlane.manifest);
    const rewrittenTypescript = rewriteRuntimeImports(dataPlane.typescript, runtimePkg);
    writeFileSync(path.join(stagedRelease, "data-operations.ts"), rewrittenTypescript);
    writeFileSync(path.join(stagedRelease, "data-operations.md"), dataPlane.documentation);
    writeFileSync(
      path.join(stagedRelease, "data-server.ts"),
      generatedDataServerText(nextApp, runtimePkg),
    );

    const sqlManifest = JSON.parse(
      runCompiler(invocation, ["--sql-manifest", ...compiledArgs]),
    ) as SqlManifest;
    const sqlBundle = runCompiler(invocation, ["--sql-bundle", ...compiledArgs]);
    const transitionPlan = JSON.parse(
      runCompiler(invocation, [
        "--sql-transition-plan",
        ...compiledArgs,
        ...(predecessors[0] === undefined ? [] : ["--previous-compiled-artifact", predecessors[0]]),
      ]),
    ) as unknown;
    const transitionContract = JSON.parse(
      runCompiler(invocation, [
        "--schema-transition-contract",
        ...compiledArgs,
        ...predecessors.flatMap((file) => ["--previous-compiled-artifact", file]),
      ]),
    ) as unknown;

    const coverage = {
      format_version: formatVersion,
      constraint_expression_coverage: sqlManifest.constraint_expression_coverage,
      runtime_api_capabilities: sqlManifest.runtime_api_capabilities,
    };
    const sourceMap = buildCueToSqlSourceMap({
      app,
      version,
      sourceFiles,
      primaryCueKey,
      artifact,
      artifacts: sqlManifest.artifacts,
    });

    writeJson(path.join(stagedRelease, "sql-manifest.json"), sqlManifest);
    writeFileSync(path.join(stagedRelease, "sql-bundle.sql"), sqlBundle);
    writeJson(path.join(stagedRelease, "transition-plan.json"), transitionPlan);
    writeJson(path.join(stagedRelease, "transition-contract.json"), transitionContract);
    writeJson(path.join(stagedRelease, "runtime-coverage.json"), coverage);
    writeJson(path.join(stagedRelease, "cue-to-sql-source-map.json"), sourceMap);

    const hashes = Object.fromEntries(
      releaseMembers.flatMap((name) =>
        name === "release-manifest.json"
          ? []
          : [[name, sha256Prefixed(readFileSync(path.join(stagedRelease, name)))] as const],
      ),
    );
    writeJson(path.join(stagedRelease, "release-manifest.json"), {
      format_version: formatVersion,
      app,
      schema_version: version,
      compiler: { name: "schema-compiler", version: packageVersion },
      formatting: {
        json: "serde_json_pretty_v1",
        sql: "schema_compiler_bundle_v1",
      },
      sources: sourceFiles,
      hashes: {
        source: sha256Prefixed(JSON.stringify(sourceFiles)),
        schema: hashes["app-artifact.json"],
        plan: hashes["transition-plan.json"],
        transition_contract: hashes["transition-contract.json"],
        bundle: hashes["sql-bundle.sql"],
        client: sha256Prefixed(JSON.stringify(artifact.client ?? null)),
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
        expected_hash: sqlManifest.checksum,
        source_hash: sqlManifest.source_checksum,
        sql_manifest_format_version: sqlManifest.format_version,
      },
    });

    verifyCheckedRelease(stagedRelease, stagedPrimaryCue);
    const releaseHash = sha256Hex(readFileSync(path.join(stagedRelease, "release-manifest.json")));

    const stagedMetadataPath = path.join(stagingRoot, "staged-build.json");
    writeJson(stagedMetadataPath, {
      sourceCommit: options.sourceCommit ?? "",
      sourceDirty: options.sourceDirty ?? false,
      buildHash,
      packageVersion,
      releaseHash,
    });

    const hadRelease = existsSync(outDir);
    const hadMetadata = existsSync(metadataPath);
    if (hadRelease) renameSync(outDir, backupDir);
    if (hadMetadata) renameSync(metadataPath, backupMetadataPath);
    try {
      renameSync(stagedRelease, outDir);
      renameSync(stagedMetadataPath, metadataPath);
    } catch (error) {
      if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
      if (existsSync(metadataPath)) rmSync(metadataPath, { force: true });
      if (hadRelease && existsSync(backupDir)) renameSync(backupDir, outDir);
      if (hadMetadata && existsSync(backupMetadataPath))
        renameSync(backupMetadataPath, metadataPath);
      throw error;
    }

    return {
      app,
      customerId: artifact.schema.customer_id,
      version,
      buildHash,
      releaseHash,
      directory: outDir,
    };
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}
