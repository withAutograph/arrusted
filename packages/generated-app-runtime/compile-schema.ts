import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
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
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyCheckedRelease } from "./release-verification";

const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(runtimeDir, "../..");
const formatVersion = 1;

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
  /** Optional explicit schema_version override; defaults to deterministic `build-${buildHash}`. */
  schemaVersion?: string;
  /** Optional predecessor app-artifact.json files for additive transition planning. */
  predecessors?: readonly string[];
  /** Package version mixed into the portable buildHash so runtime/SQL upgrades produce new hashes. */
  packageVersion?: string;
  /** Git commit or build provenance recorded in ../build.json. */
  sourceCommit?: string;
  /** Whether the working tree had uncommitted changes when compiled. */
  sourceDirty?: boolean;
  /** Emit `import "server-only"` in data-server.ts (default: true). */
  nextApp?: boolean;
  /** Optional explicit path to the prebuilt schema-compiler binary. */
  compilerBinary?: string;
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

function resolveCompilerInvocation(explicitBinary?: string): {
  executable: string;
  prefixArgs: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
} {
  const envBinary = process.env.ARRUSTED_SCHEMA_COMPILER_BIN?.trim();
  if (explicitBinary || envBinary) {
    const resolved = path.resolve((explicitBinary ?? envBinary)!);
    if (!existsSync(resolved)) {
      throw new Error(`Configured schema-compiler binary does not exist: ${resolved}`);
    }
    return { executable: resolved, prefixArgs: [], cwd: process.cwd(), env: process.env };
  }
  const cargoToml = path.join(defaultRepoRoot, "Cargo.toml");
  const debugBin = path.join(defaultRepoRoot, "target/debug/schema-compiler");
  const cargoEnv = { ...process.env, CARGO_TARGET_DIR: path.join(defaultRepoRoot, "target") };
  if (existsSync(cargoToml) && !monorepoCompilerReady) {
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
    return { executable: debugBin, prefixArgs: [], cwd: process.cwd(), env: process.env };
  }
  return {
    executable: "cargo",
    prefixArgs: ["run", "--quiet", "-p", "schema-compiler", "--"],
    cwd: defaultRepoRoot,
    env: cargoEnv,
  };
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
    const details = [result.stderr?.trim(), result.stdout?.trim()].filter(Boolean).join("\n");
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

/** Pure current-state CUE -> SQL + TypeScript codegen with portable build identity. */
export function compileSchema(options: CompileSchemaOptions): CompiledSchemaResult {
  const outDir = path.resolve(options.outDir);
  const { files: cueFiles, primaryCue } = collectCueInputs(options.schemaPath);
  const appManifestCue = path.resolve(
    options.appManifestCuePath ??
      path.join(defaultRepoRoot, "packages/schema-compiler/cue/app-manifest.cue"),
  );
  const authSchemaSql = path.resolve(
    options.authSchemaSqlPath ?? path.join(defaultRepoRoot, "packages/auth/schema.sql"),
  );
  const membershipSql = path.resolve(
    options.membershipSqlPath ??
      path.join(defaultRepoRoot, "packages/auth/single-organization-membership.sql"),
  );
  const extraInputs: string[] = [];
  let resolvedSelectionCue: string | undefined;
  if (options.catalogPath !== undefined) {
    const selectionCue = path.resolve(
      options.appSelectionCuePath ??
        path.join(defaultRepoRoot, "packages/schema-compiler/cue/app-selection.cue"),
    );
    if (existsSync(selectionCue)) {
      resolvedSelectionCue = selectionCue;
      extraInputs.push(selectionCue);
    }
    extraInputs.push(path.resolve(options.catalogPath));
  }
  const compilerInputs = [appManifestCue, ...extraInputs, ...cueFiles];
  const invocation = resolveCompilerInvocation(options.compilerBinary);
  const packageVersion =
    options.packageVersion ??
    (
      JSON.parse(readFileSync(path.join(runtimeDir, "package.json"), "utf8")) as {
        version?: string;
      }
    ).version ??
    "0.0.0";
  const runtimePkg = options.runtimeModuleSpecifier ?? "@autograph/generated-app-runtime";
  const nextApp = options.nextApp ?? true;

  mkdirSync(path.dirname(outDir), { recursive: true });
  const stagingRoot = mkdtempSync(path.join(path.dirname(outDir), ".compile-"));
  const backupDir = path.join(stagingRoot, "previous");

  try {
    // 1. Probe pass to compute a portable, platform- and directory-independent buildHash
    // from packageVersion + normalized CUE manifest + emitted SQL runtime + auth SQL checksums.
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
    const probeArtifact = JSON.parse(probeArtifactRaw) as {
      schema: Record<string, unknown>;
      extras?: unknown;
      client?: unknown;
    };
    const probeSqlManifest = JSON.parse(probeSqlManifestRaw) as SqlManifest;
    const { version: _ignoredVersion, ...versionlessSchema } = probeArtifact.schema;

    const primaryCueKey = logicalCueKey(primaryCue);
    const sourceEntries: Array<[string, string]> = [
      [
        "packages/schema-compiler/cue/app-manifest.cue",
        sha256Prefixed(readFileSync(appManifestCue)),
      ],
      ...(resolvedSelectionCue !== undefined
        ? [
            [
              "packages/schema-compiler/cue/app-selection.cue",
              sha256Prefixed(readFileSync(resolvedSelectionCue)),
            ] as [string, string],
          ]
        : []),
      ...(options.catalogPath !== undefined
        ? [["catalog.json", sha256Prefixed(readFileSync(options.catalogPath))] as [string, string]]
        : []),
      ...cueFiles.map(
        (file) => [logicalCueKey(file), sha256Prefixed(readFileSync(file))] as [string, string],
      ),
      ["packages/auth/schema.sql", sha256Prefixed(readFileSync(authSchemaSql))],
      [
        "packages/auth/single-organization-membership.sql",
        sha256Prefixed(readFileSync(membershipSql)),
      ],
    ];
    const sourceFiles = Object.fromEntries(sourceEntries);

    const buildHash = sha256Hex(
      JSON.stringify({
        packageVersion,
        nextApp,
        runtimePkg,
        schema: versionlessSchema,
        extras: probeArtifact.extras ?? null,
        client: probeArtifact.client ?? null,
        sqlArtifacts: probeSqlManifest.artifacts.map((entry) => ({
          kind: entry.kind,
          name: entry.name,
          sql: entry.sql,
        })),
        sources: sourceFiles,
      }),
    );
    const version = options.schemaVersion ?? `build-${buildHash}`;

    // 2. Emit final current-state bundle for `version`
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
    const predecessors = options.predecessors ?? [];
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
    writeFileSync(path.join(stagedRelease, "data-operations.ts"), dataPlane.typescript);
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

    verifyCheckedRelease(stagedRelease, primaryCue);
    const releaseHash = sha256Hex(readFileSync(path.join(stagedRelease, "release-manifest.json")));

    if (existsSync(outDir)) renameSync(outDir, backupDir);
    try {
      renameSync(stagedRelease, outDir);
    } catch (error) {
      if (existsSync(backupDir)) renameSync(backupDir, outDir);
      throw error;
    }

    // Remove any legacy adjacent host binary file left by pre-portable builds so migrate never sees stale artifacts.
    const adjacentCompiler = path.join(path.dirname(outDir), "schema-compiler");
    if (statSync(adjacentCompiler, { throwIfNoEntry: false })?.isFile()) {
      rmSync(adjacentCompiler, { force: true });
    }
    writeJson(path.join(path.dirname(outDir), "build.json"), {
      sourceCommit: options.sourceCommit ?? "untracked",
      sourceDirty: options.sourceDirty ?? false,
      buildHash,
      packageVersion,
      releaseHash,
    });

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
