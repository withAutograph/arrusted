import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterAll, expect, test } from "vite-plus/test";
import { createPlatformSchemaTestFixture } from "./platform-schema-test-fixture";
import { verifyCheckedRelease } from "../../../../packages/generated-app-runtime/server";
import {
  appInputPaths,
  externalTransitionPredecessors,
  transitionPredecessorArtifacts,
  buildCueToSqlSourceMap,
  buildGeneratedRelease,
  checkGeneratedSchemaIndex,
  compiler,
  checkGeneratedHcReleasePointer,
  discoverCompiledApps,
  generatedDataServerText,
  generatedHcReleasePointerText,
  generatedRustReleasePointerText,
  generatedSchemaIndexText,
  installCompiledReleases,
  isReleaseProvenanceOnlyChange,
  parseCompilerJson,
  syncGeneratedRustReleasePointer,
  type Release,
  writeGeneratedSchemaIndex,
} from "./schema-release";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../..");
const app = "spend-review";
const sourceRelativePath = "apps/spend-review/schema/spend-review.cue";
const fixtures = new Map<string, ReturnType<typeof createPlatformSchemaTestFixture>>();
const fixtureFor = (appId: string) => {
  let fixture = fixtures.get(appId);
  if (fixture === undefined) {
    fixture = createPlatformSchemaTestFixture(repositoryRoot, appId);
    fixtures.set(appId, fixture);
  }
  return fixture;
};
afterAll(() => {
  for (const fixture of fixtures.values()) rmSync(fixture.root, { recursive: true, force: true });
});
const sourcePath = fixtureFor(app).sourcePath;
const checkedRelease = fixtureFor(app).directory;
const checkedReleaseName = path.basename(checkedRelease);

function makeRoot(...releaseNames: string[]): string {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "schema-release-bridge-"));
  const fixtureSource = path.join(fixtureRoot, sourceRelativePath);
  mkdirSync(path.dirname(fixtureSource), { recursive: true });
  cpSync(sourcePath, fixtureSource);
  const packagePath = path.join(fixtureRoot, "apps", app, "package.json");
  mkdirSync(path.dirname(packagePath), { recursive: true });
  writeFileSync(packagePath, JSON.stringify({ dependencies: { next: "16.0.0" } }) + "\n");

  for (const releaseName of releaseNames) {
    cpSync(checkedRelease, path.join(fixtureRoot, "apps", app, "schema", "release", releaseName), {
      recursive: true,
    });
  }
  return fixtureRoot;
}

function cleanup(fixtureRoot: string): void {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

test("reports the compiler's CUE location and repair action when compilation fails", () => {
  const fixtureRoot = makeRoot();
  try {
    const executable = path.join(fixtureRoot, "failing-compiler");
    writeFileSync(
      executable,
      "#!/bin/sh\necho 'schema-compiler: apps/spend-review/schema/spend-review.cue:12:4: conflicting values' >&2\nexit 1\n",
      { mode: 0o755 },
    );
    expect(() => compiler(app, ["--app-artifact"], fixtureRoot, executable)).toThrow(
      /schema-compiler: apps\/spend-review\/schema\/spend-review\.cue:12:4: conflicting values[\s\S]*rerun the app's schema check/u,
    );
  } finally {
    cleanup(fixtureRoot);
  }
});

test("explains how to recover when the compiler toolchain cannot start", () => {
  const fixtureRoot = makeRoot();
  try {
    expect(() =>
      compiler(app, ["--app-artifact"], fixtureRoot, path.join(fixtureRoot, "missing-cargo")),
    ).toThrow(/ENOENT[\s\S]*`mise exec --locked --no-deps -- cargo --version`[\s\S]*--root/u);
  } finally {
    cleanup(fixtureRoot);
  }
});

test("runs cargo from the already-resolved environment without nested mise config loading", () => {
  const fixtureRoot = makeRoot();
  try {
    const executable = path.join(fixtureRoot, "cargo-fixture");
    writeFileSync(executable, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n", { mode: 0o755 });
    expect(compiler(app, ["--app-artifact"], fixtureRoot, executable)).toContain(
      "run\n--quiet\n-p\nschema-compiler",
    );
  } finally {
    cleanup(fixtureRoot);
  }
});

test("reproduces online plan and runtime bytes from the checked predecessor digest", () => {
  const fixture = createPlatformSchemaTestFixture(repositoryRoot, app);
  try {
    const artifact = path.join(fixture.directory, "app-artifact.json");
    const staged = path.join(fixture.root, "private", "app-artifact.json");
    mkdirSync(path.dirname(staged));
    cpSync(artifact, staged);
    const source = readFileSync(fixture.sourcePath, "utf8")
      .replace(fixture.version, "platform-fixture-v3")
      .replace("required:true}]}]", 'required:true},{id:"note",label:"Note",type:"text"}]}]');
    writeFileSync(fixture.sourcePath, source);
    const build = (predecessors: readonly string[] = []) =>
      buildGeneratedRelease(
        app,
        path.join(fixture.root, "next-release"),
        appInputPaths(app, fixture.root).map((input) => path.relative(fixture.root, input)),
        fixture.root,
        { ...process.env, CARGO_TARGET_DIR: path.join(repositoryRoot, "target") },
        predecessors,
      );
    const current = build([staged]);
    const plan = path.join(current.directory, "transition-plan.json");
    const bytes = readFileSync(plan);
    expect(JSON.parse(bytes.toString("utf8")).online_optional_text_addition).toMatchObject({
      kind: "optional-text-addition-v1",
      predecessor_artifact_sha256: createHash("sha256").update(readFileSync(staged)).digest("hex"),
      table: "item_version",
      column: "note",
      authorization_policy: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) },
    });
    cpSync(current.directory, path.join(path.dirname(fixture.directory), current.version), {
      recursive: true,
    });
    const runtimeMembers = ["operation-manifest.json", "data-operations.ts"];
    const runtime = runtimeMembers.map((name) => readFileSync(path.join(current.directory, name)));
    // Insert another eligible prior release after this plan was issued.
    writeFileSync(fixture.sourcePath, source.replace("platform-fixture-v3", "platform-fixture-v2"));
    const intervening = build([staged]);
    const checkedIntervening = path.join(path.dirname(fixture.directory), intervening.version);
    cpSync(intervening.directory, checkedIntervening, { recursive: true });
    writeFileSync(fixture.sourcePath, source);

    build();
    expect(readFileSync(plan)).toEqual(bytes);
    expect(runtimeMembers.map((name) => readFileSync(path.join(current.directory, name)))).toEqual(
      runtime,
    );
    build([path.join(checkedIntervening, "app-artifact.json"), staged]);
    expect(readFileSync(plan)).toEqual(bytes);
    expect(runtimeMembers.map((name) => readFileSync(path.join(current.directory, name)))).toEqual(
      runtime,
    );

    const duplicate = path.join(path.dirname(fixture.directory), "copied-release");
    cpSync(fixture.directory, duplicate, { recursive: true });
    expect(() => build([staged])).toThrow("ambiguous checked online schema predecessor");
    rmSync(duplicate, { recursive: true });
    rmSync(fixture.directory, { recursive: true });
    expect(() => build([staged])).toThrow("missing checked online schema predecessor");
  } finally {
    cleanup(fixture.root);
  }
}, 60_000);

test("the public schema release task forwards app and custom-root arguments", () => {
  const fixtureRoot = makeRoot();
  try {
    const result = spawnSync(
      "mise",
      ["run", "schema:release", "--", "check", "--app", app, "--root", fixtureRoot],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`--root '${fixtureRoot}'`);
    expect(result.stderr).toContain(`Schema compilation failed for ${app}`);
  } finally {
    cleanup(fixtureRoot);
  }
}, 60_000);

test("retains the final compiler error when noisy output exceeds the receipt limit", () => {
  const fixtureRoot = makeRoot();
  try {
    const executable = path.join(fixtureRoot, "noisy-compiler");
    writeFileSync(
      executable,
      "#!/bin/sh\nhead -c 14000 /dev/zero | tr '\\0' 'x' >&2\necho 'final CUE error: invalid field' >&2\nexit 1\n",
      { mode: 0o755 },
    );
    expect(() => compiler(app, ["--app-artifact"], fixtureRoot, executable)).toThrow(
      /compiler output characters omitted[\s\S]*final CUE error: invalid field/u,
    );
  } finally {
    cleanup(fixtureRoot);
  }
});

test("retains stderr's final CUE location even when stdout is also long", () => {
  const fixtureRoot = makeRoot();
  try {
    const executable = path.join(fixtureRoot, "noisy-both-streams");
    writeFileSync(
      executable,
      "#!/bin/sh\nhead -c 10000 /dev/zero | tr '\\0' 'x' >&2\necho 'apps/spend-review/schema/spend-review.cue:31:2: final error' >&2\nhead -c 10000 /dev/zero | tr '\\0' 'y'\nexit 1\n",
      { mode: 0o755 },
    );
    expect(() => compiler(app, ["--app-artifact"], fixtureRoot, executable)).toThrow(
      /apps\/spend-review\/schema\/spend-review\.cue:31:2: final error/u,
    );
  } finally {
    cleanup(fixtureRoot);
  }
});

test("preserves a bounded compiler excerpt when JSON output is malformed", () => {
  expect(() =>
    parseCompilerJson(
      app,
      "SQL manifest",
      "apps/spend-review/schema/spend-review.cue:9: malformed {",
    ),
  ).toThrow(
    /invalid JSON for spend-review during SQL manifest[\s\S]*Compiler output excerpt:[\s\S]*spend-review\.cue:9/u,
  );
});

test("names the missing CUE executable and its exact toolchain check", () => {
  const fixtureRoot = makeRoot();
  try {
    const executable = path.join(fixtureRoot, "missing-cue");
    writeFileSync(
      executable,
      "#!/bin/sh\necho 'schema-compiler: failed to run `cue`: No such file or directory' >&2\nexit 1\n",
      { mode: 0o755 },
    );
    expect(() => compiler(app, ["--app-artifact"], fixtureRoot, executable)).toThrow(
      /during --app-artifact[\s\S]*`mise exec --locked --no-deps -- cue version`/u,
    );
  } finally {
    cleanup(fixtureRoot);
  }
});

test("does not diagnose CUE permission errors as missing installation", () => {
  const fixtureRoot = makeRoot();
  try {
    const executable = path.join(fixtureRoot, "cue-permission");
    writeFileSync(
      executable,
      "#!/bin/sh\necho 'schema-compiler: failed to run `cue`: Permission denied' >&2\nexit 1\n",
      { mode: 0o755 },
    );
    expect(() => compiler(app, ["--app-artifact"], fixtureRoot, executable)).toThrow(
      /Permission denied[\s\S]*No CUE source location was reported/u,
    );
    expect(() => compiler(app, ["--app-artifact"], fixtureRoot, executable)).not.toThrow(
      /verify `mise exec --locked --no-deps -- cue version`/u,
    );
  } finally {
    cleanup(fixtureRoot);
  }
});

test("identifies the native compiler failure seen in hosted schema builds", () => {
  const fixtureRoot = makeRoot();
  try {
    const executable = path.join(fixtureRoot, "missing-cc");
    writeFileSync(
      executable,
      "#!/bin/sh\necho 'ToolNotFound: failed to find tool \"cc\"' >&2\nexit 1\n",
      { mode: 0o755 },
    );
    expect(() => compiler(app, ["--app-artifact"], fixtureRoot, executable)).toThrow(
      /ToolNotFound[\s\S]*Install a native C compiler[\s\S]*`cc --version`/u,
    );
  } finally {
    cleanup(fixtureRoot);
  }
});

test("reports a silent compiler signal with a next check", () => {
  const fixtureRoot = makeRoot();
  try {
    const executable = path.join(fixtureRoot, "silent-compiler");
    writeFileSync(executable, "#!/bin/sh\nkill -TERM $$\n", { mode: 0o755 });
    expect(() => compiler(app, ["--app-artifact"], fixtureRoot, executable)).toThrow(
      /signal SIGTERM[\s\S]*The compiler produced no diagnostic output[\s\S]*available disk\/memory/u,
    );
  } finally {
    cleanup(fixtureRoot);
  }
});

function releaseContents(releaseDirectory: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(releaseDirectory)
      .sort()
      .map((entry) => [entry, readFileSync(path.join(releaseDirectory, entry), "utf8")]),
  );
}

function markSourceStale(fixtureRoot: string, releaseName: string): void {
  const mapPath = path.join(
    fixtureRoot,
    "apps",
    app,
    "schema",
    "release",
    releaseName,
    "cue-to-sql-source-map.json",
  );
  const sourceMap = JSON.parse(readFileSync(mapPath, "utf8")) as {
    sources: Record<string, string>;
  };
  sourceMap.sources[sourceRelativePath] = "sha256:" + "0".repeat(64);
  writeFileSync(mapPath, JSON.stringify(sourceMap, null, 2) + "\n");
}

test("writes the exact static schema index without changing the checked release", () => {
  const fixtureRoot = makeRoot(checkedReleaseName);
  try {
    const fixtureRelease = path.join(
      fixtureRoot,
      "apps",
      app,
      "schema",
      "release",
      checkedReleaseName,
    );
    const contentsBefore = releaseContents(fixtureRelease);

    const indexPath = writeGeneratedSchemaIndex(app, fixtureRoot);
    const index = readFileSync(indexPath, "utf8");

    expect(index).toBe(generatedSchemaIndexText(checkedReleaseName));
    expect(index).toBe('export * from "./release/' + checkedReleaseName + '/data-server";\n');
    expect(index).not.toContain("server-only");
    expect(checkGeneratedSchemaIndex(app, checkedReleaseName, fixtureRoot)).toEqual([]);
    expect(releaseContents(fixtureRelease)).toEqual(contentsBefore);
  } finally {
    cleanup(fixtureRoot);
  }
});

test("discovers compiled apps from app-owned CUE sources and derives shared compiler inputs", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "schema-app-discovery-"));
  try {
    const cuePath = path.join(
      fixtureRoot,
      "apps",
      "purchase-ledger",
      "schema",
      "purchase-ledger.cue",
    );
    mkdirSync(path.dirname(cuePath), { recursive: true });
    writeFileSync(cuePath, "package schema\n");
    const appManifestPath = path.join(fixtureRoot, "packages/schema-compiler/cue/app-manifest.cue");
    const appSelectionPath = path.join(
      fixtureRoot,
      "packages/schema-compiler/cue/app-selection.cue",
    );
    const domainCatalogPath = path.join(fixtureRoot, "packages/domain-libs/catalog.json");
    mkdirSync(path.dirname(appManifestPath), { recursive: true });
    mkdirSync(path.dirname(domainCatalogPath), { recursive: true });
    writeFileSync(appManifestPath, "package schema\n");
    writeFileSync(appSelectionPath, "package schema\n");
    writeFileSync(domainCatalogPath, "{}\n");
    mkdirSync(path.join(fixtureRoot, "apps", "not-an-app"), {
      recursive: true,
    });

    expect(discoverCompiledApps(fixtureRoot)).toEqual(["purchase-ledger"]);
    expect(appInputPaths("purchase-ledger", fixtureRoot)).toEqual([
      appManifestPath,
      appSelectionPath,
      cuePath,
      domainCatalogPath,
    ]);
  } finally {
    cleanup(fixtureRoot);
  }
});

test("maps generated objects to exact CUE declarations without embedding SQL", () => {
  const map = buildCueToSqlSourceMap({
    app: "purchase-ledger",
    version: "2026-09-20",
    sourceFiles: {
      "apps/purchase-ledger/schema/purchase-ledger.cue": "sha256:test",
    },
    sourcePaths: ["apps/purchase-ledger/schema/purchase-ledger.cue"],
    artifact: {
      schema: {
        models: [{ id: "invoice", fields: [{ id: "amount" }, { id: "vendor" }] }],
      },
      extras: {
        constraints: [{ id: "invoice_amount_positive", model: "invoice" }],
      },
    },
    artifacts: [
      { kind: "table", name: "invoice_record" },
      { kind: "column", name: "invoice_version.amount" },
      {
        kind: "check_constraint",
        name: "invoice_version_invoice_amount_positive_constraint_check",
      },
      { kind: "function", name: "kernel_apply_change_set(jsonb)" },
    ],
  });
  expect(map.format_version).toBe(2);
  expect(map.sql_artifacts).toEqual([
    expect.objectContaining({
      origin: {
        source: "apps/purchase-ledger/schema/purchase-ledger.cue",
        path: "models.invoice",
        kind: "model",
      },
    }),
    expect.objectContaining({
      origin: {
        source: "apps/purchase-ledger/schema/purchase-ledger.cue",
        path: "models.invoice.fields.amount",
        kind: "field",
      },
    }),
    expect.objectContaining({
      origin: {
        source: "apps/purchase-ledger/schema/purchase-ledger.cue",
        path: "constraints.invoice_amount_positive.expression",
        kind: "constraint",
      },
    }),
    expect.objectContaining({
      origin: {
        source: "apps/purchase-ledger/schema/purchase-ledger.cue",
        path: "manifest",
        kind: "app",
      },
    }),
  ]);
  expect(JSON.stringify(map)).not.toContain("create table");
});

test("keeps frozen releases when only schema-tooling or app-package provenance changes", () => {
  const script = ".config/mise/scripts/repository/schema-release.ts";
  const packageManifest = `apps/${app}/package.json`;
  const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
  const sha256 = (value: string | Buffer) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`;
  const checkedMap = JSON.parse(
    readFileSync(path.join(checkedRelease, "cue-to-sql-source-map.json"), "utf8"),
  );
  const generatedMap = structuredClone(checkedMap);
  generatedMap.sources[script] = "sha256:changed-script";
  expect(
    isReleaseProvenanceOnlyChange(
      "cue-to-sql-source-map.json",
      bytes(checkedMap),
      bytes(generatedMap),
    ),
  ).toBe(true);
  generatedMap.sql_artifacts[0].origin.path = "wrong-origin";
  expect(
    isReleaseProvenanceOnlyChange(
      "cue-to-sql-source-map.json",
      bytes(checkedMap),
      bytes(generatedMap),
    ),
  ).toBe(false);

  const packageOnlyMap = structuredClone(checkedMap);
  packageOnlyMap.sources[packageManifest] = "sha256:changed-package";
  expect(
    isReleaseProvenanceOnlyChange(
      "cue-to-sql-source-map.json",
      bytes(checkedMap),
      bytes(packageOnlyMap),
    ),
  ).toBe(true);
  packageOnlyMap.sources["packages/schema-compiler/cue/app-selection.cue"] =
    "sha256:changed-compiler-input";
  expect(
    isReleaseProvenanceOnlyChange(
      "cue-to-sql-source-map.json",
      bytes(checkedMap),
      bytes(packageOnlyMap),
    ),
  ).toBe(false);

  const checkedManifest = JSON.parse(
    readFileSync(path.join(checkedRelease, "release-manifest.json"), "utf8"),
  );
  const generatedManifest = structuredClone(checkedManifest);
  generatedManifest.sources[script] = "sha256:changed-script";
  const scriptMap = structuredClone(checkedMap);
  scriptMap.sources[script] = "sha256:changed-script";
  const scriptMapBytes = bytes(scriptMap);
  generatedManifest.hashes.source = sha256(JSON.stringify(generatedManifest.sources));
  generatedManifest.hashes.source_map = sha256(scriptMapBytes);
  expect(
    isReleaseProvenanceOnlyChange(
      "release-manifest.json",
      bytes(checkedManifest),
      bytes(generatedManifest),
      scriptMapBytes,
    ),
  ).toBe(true);
  generatedManifest.hashes.bundle = "sha256:changed-bundle";
  expect(
    isReleaseProvenanceOnlyChange(
      "release-manifest.json",
      bytes(checkedManifest),
      bytes(generatedManifest),
      scriptMapBytes,
    ),
  ).toBe(false);

  const packageManifestRecord = structuredClone(checkedManifest);
  packageManifestRecord.sources[packageManifest] = "sha256:changed-package";
  const packageMap = structuredClone(checkedMap);
  packageMap.sources[packageManifest] = "sha256:changed-package";
  const packageMapBytes = bytes(packageMap);
  packageManifestRecord.hashes.source = sha256(JSON.stringify(packageManifestRecord.sources));
  packageManifestRecord.hashes.source_map = sha256(packageMapBytes);
  expect(
    isReleaseProvenanceOnlyChange(
      "release-manifest.json",
      bytes(checkedManifest),
      bytes(packageManifestRecord),
      packageMapBytes,
    ),
  ).toBe(true);
});

test("rejects a checked manifest whose sources disagree with its source map", () => {
  const fixtureRoot = makeRoot(checkedReleaseName);
  try {
    const releaseDirectory = path.join(
      fixtureRoot,
      "apps",
      app,
      "schema",
      "release",
      checkedReleaseName,
    );
    const manifestPath = path.join(releaseDirectory, "release-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.sources[".config/mise/scripts/repository/schema-release.ts"] = "sha256:forged";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => verifyCheckedRelease(releaseDirectory)).toThrow("source map disagrees");
  } finally {
    cleanup(fixtureRoot);
  }
});

test("emits the public server surface inside the release with a Next-only guard", () => {
  expect(generatedDataServerText(true)).toBe(
    'import "server-only";\n' +
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
      'export type { FormActionResult, FormError, FormErrorCode } from "@autograph/generated-app-runtime/errors";\n',
  );
  expect(generatedDataServerText(false)).toBe(
    generatedDataServerText(true).replace('import "server-only";\n', ""),
  );
});

test("escapes a release version when writing the schema index specifier", () => {
  expect(generatedSchemaIndexText('release-"quoted')).toBe(
    'export * from "./release/release-\\"quoted/data-server";\n',
  );
});

test("generates and checks the HC Rust release pointer for the selected release", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "schema-release-hc-pointer-"));
  try {
    const pointer = path.join(fixtureRoot, "apps/hc/src/schema_release.rs");
    mkdirSync(path.dirname(pointer), { recursive: true });
    const expected = generatedHcReleasePointerText("hc-v53");
    writeFileSync(pointer, expected);
    expect(checkGeneratedHcReleasePointer("hc-v53", fixtureRoot)).toEqual([]);
    expect(checkGeneratedHcReleasePointer("hc-v54", fixtureRoot)).toEqual([
      "apps/hc/src/schema_release.rs is stale; run `mise exec -- bun .config/mise/scripts/repository/schema-release.ts sync-rust-pointer --app hc`.",
    ]);
  } finally {
    cleanup(fixtureRoot);
  }
});

test("generates the Vendor Rust release pointer for the selected release", () => {
  expect(generatedRustReleasePointerText("vendor", "vendor-v54")).toBe(
    "// Generated by schema-compiler. Do not edit.\n" +
      'pub const VENDOR_RELEASE_MANIFEST: &str =\n    include_str!("../schema/release/vendor-v54/release-manifest.json");\n' +
      'pub const VENDOR_SQL_BUNDLE: &str = include_str!("../schema/release/vendor-v54/sql-bundle.sql");\n' +
      'pub const VENDOR_TRANSITION_CONTRACT: &str =\n    include_str!("../schema/release/vendor-v54/transition-contract.json");\n',
  );
});

test("syncs the Vendor Rust pointer from its checked release without changing release bytes", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "schema-release-vendor-pointer-"));
  const releaseDirectory = fixtureFor("vendor").directory;
  const releaseName = path.basename(releaseDirectory);
  const fixtureRelease = path.join(fixtureRoot, "apps/vendor/schema/release", releaseName);
  try {
    const fixtureSource = path.join(fixtureRoot, "apps/vendor/schema/vendor.cue");
    mkdirSync(path.dirname(fixtureSource), { recursive: true });
    cpSync(fixtureFor("vendor").sourcePath, fixtureSource);
    mkdirSync(path.dirname(fixtureRelease), { recursive: true });
    cpSync(releaseDirectory, fixtureRelease, { recursive: true });
    const manifestBefore = readFileSync(path.join(fixtureRelease, "release-manifest.json"));

    expect(syncGeneratedRustReleasePointer("vendor", fixtureRoot)).toBe(fixtureRelease);
    expect(readFileSync(path.join(fixtureRoot, "apps/vendor/src/schema_release.rs"), "utf8")).toBe(
      generatedRustReleasePointerText("vendor", releaseName),
    );
    expect(readFileSync(path.join(fixtureRelease, "release-manifest.json"))).toEqual(
      manifestBefore,
    );
  } finally {
    cleanup(fixtureRoot);
  }
}, 60_000);

test("rejects a missing or stale schema index", () => {
  const missingRoot = makeRoot(checkedReleaseName);
  try {
    expect(checkGeneratedSchemaIndex(app, checkedReleaseName, missingRoot)).toEqual([
      "apps/spend-review/schema/index.ts is missing; run schema:compile.",
    ]);
  } finally {
    cleanup(missingRoot);
  }

  const staleRoot = makeRoot(checkedReleaseName);
  try {
    const indexPath = writeGeneratedSchemaIndex(app, staleRoot);
    writeFileSync(indexPath, 'export * from "./release/wrong/data-server";\n');
    expect(checkGeneratedSchemaIndex(app, checkedReleaseName, staleRoot)).toEqual([
      "apps/spend-review/schema/index.ts is stale; run schema:compile.",
    ]);
  } finally {
    cleanup(staleRoot);
  }
});

test("runs schema index validation through the schema-release check command", () => {
  const result = spawnSync(
    "mise",
    [
      "exec",
      "--no-deps",
      "--",
      "bun",
      ".config/mise/scripts/repository/schema-release.ts",
      "check",
      "--app",
      app,
      "--root",
      fixtureFor(app).root,
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );

  expect(result.status, result.stderr).toBe(0);
  expect(checkGeneratedSchemaIndex(app, checkedReleaseName, fixtureFor(app).root)).toEqual([]);
}, 60_000);

test("rejects missing, ambiguous, stale, and tampered checked releases before using an index", () => {
  const missingRoot = makeRoot();
  try {
    expect(checkGeneratedSchemaIndex(app, checkedReleaseName, missingRoot)[0]).toContain(
      "must have exactly one checked release matching its CUE source",
    );
  } finally {
    cleanup(missingRoot);
  }

  const ambiguousRoot = makeRoot("candidate-a", "candidate-b");
  try {
    expect(checkGeneratedSchemaIndex(app, "candidate-a", ambiguousRoot)[0]).toContain(
      "must have exactly one checked release matching its CUE source",
    );
  } finally {
    cleanup(ambiguousRoot);
  }

  const staleRoot = makeRoot(checkedReleaseName);
  try {
    markSourceStale(staleRoot, checkedReleaseName);
    expect(checkGeneratedSchemaIndex(app, checkedReleaseName, staleRoot)[0]).toContain(
      "must have exactly one checked release matching its CUE source",
    );
  } finally {
    cleanup(staleRoot);
  }

  const tamperedRoot = makeRoot(checkedReleaseName);
  try {
    const bundlePath = path.join(
      tamperedRoot,
      "apps",
      app,
      "schema",
      "release",
      checkedReleaseName,
      "sql-bundle.sql",
    );
    writeFileSync(bundlePath, readFileSync(bundlePath, "utf8") + "\n-- corrupt\n");
    expect(checkGeneratedSchemaIndex(app, checkedReleaseName, tamperedRoot)[0]).toContain(
      "checksum",
    );
  } finally {
    cleanup(tamperedRoot);
  }
});

const rollbackApps = ["spend-review", "vendor", "hc"] as const;

function makeRollbackFixture(): { fixtureRoot: string; releases: Release[] } {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "schema-release-rollback-"));
  const buildRoot = path.join(fixtureRoot, "built");
  const releases = rollbackApps.map((appId) => {
    const sourceRelative = `apps/${appId}/schema/${appId}.cue`;
    const source = fixtureFor(appId).sourcePath;
    const release = fixtureFor(appId).directory;
    const version = path.basename(release);
    const fixtureSource = path.join(fixtureRoot, sourceRelative);
    const fixtureRelease = path.join(fixtureRoot, "apps", appId, "schema", "release", version);
    const builtRelease = path.join(buildRoot, appId, version);
    mkdirSync(path.dirname(fixtureSource), { recursive: true });
    cpSync(source, fixtureSource);
    cpSync(release, fixtureRelease, { recursive: true });
    cpSync(release, builtRelease, { recursive: true });
    writeFileSync(
      path.join(fixtureRoot, "apps", appId, "schema", "index.ts"),
      `export const previousIndex = ${JSON.stringify(appId)};\n`,
    );
    writeFileSync(
      path.join(fixtureRoot, "apps", appId, "schema", "generated-data.ts"),
      `export const previousLegacyPointer = ${JSON.stringify(appId)};\n`,
    );
    if (appId === "hc" || appId === "vendor") {
      const pointer = path.join(fixtureRoot, `apps/${appId}/src/schema_release.rs`);
      mkdirSync(path.dirname(pointer), { recursive: true });
      writeFileSync(
        pointer,
        generatedRustReleasePointerText(
          appId,
          appId === "hc" ? "previous-hc-release" : "previous-vendor-release",
        ),
      );
    }
    return { app: appId, version, directory: builtRelease };
  });
  return { fixtureRoot, releases };
}

function installedContents(fixtureRoot: string, release: Release): Record<string, string> {
  const releaseDirectory = path.join(
    fixtureRoot,
    "apps",
    release.app,
    "schema",
    "release",
    release.version,
  );
  return {
    ...Object.fromEntries(
      readdirSync(releaseDirectory)
        .sort()
        .map((name) => [
          `release/${release.app}/${name}`,
          readFileSync(path.join(releaseDirectory, name), "utf8"),
        ]),
    ),
    [`index/${release.app}`]: readFileSync(
      path.join(fixtureRoot, "apps", release.app, "schema", "index.ts"),
      "utf8",
    ),
    [`legacy/${release.app}`]: readFileSync(
      path.join(fixtureRoot, "apps", release.app, "schema", "generated-data.ts"),
      "utf8",
    ),
    ...(release.app === "hc" || release.app === "vendor"
      ? {
          [`pointer/${release.app}`]: readFileSync(
            path.join(fixtureRoot, `apps/${release.app}/src/schema_release.rs`),
            "utf8",
          ),
        }
      : {}),
  };
}

function changeFixtureArtifact(directory: string): void {
  const artifactPath = path.join(directory, "app-artifact.json");
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  artifact.extras = { ...artifact.extras, compiler_fixture: "changed-complete-artifact" };
  writeFileSync(artifactPath, JSON.stringify(artifact));
  const manifestPath = path.join(directory, "release-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.hashes.schema = `sha256:${createHash("sha256").update(readFileSync(artifactPath)).digest("hex")}`;
  writeFileSync(manifestPath, JSON.stringify(manifest));
}

test("retains the complete issued bundle when regenerated SQL differs for the same app artifact", () => {
  const fixtureRoot = makeRoot(checkedReleaseName);
  const directory = path.join(fixtureRoot, "generated");
  cpSync(checkedRelease, directory, { recursive: true });
  const release = { app, version: checkedReleaseName, directory };
  const target = path.join(fixtureRoot, "apps", app, "schema", "release", checkedReleaseName);
  const contents = () =>
    Object.fromEntries(
      readdirSync(target).map((name) => [name, readFileSync(path.join(target, name))]),
    );
  const before = contents();
  try {
    const bundlePath = path.join(directory, "sql-bundle.sql");
    writeFileSync(
      bundlePath,
      readFileSync(bundlePath, "utf8") + "\n-- changed compiler emission\n",
    );
    const manifestPath = path.join(directory, "release-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.hashes.bundle = `sha256:${createHash("sha256").update(readFileSync(bundlePath)).digest("hex")}`;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    verifyCheckedRelease(directory, path.join(fixtureRoot, sourceRelativePath));
    installCompiledReleases([release], fixtureRoot, {
      afterReleaseStaged() {
        throw new Error("An unchanged issued artifact must not be replaced");
      },
      beforeIndexInstall(selected) {
        expect(selected.directory).toBe(target);
      },
    });
    expect(contents()).toEqual(before);
    expect(readFileSync(path.join(fixtureRoot, "apps", app, "schema", "index.ts"), "utf8")).toBe(
      generatedSchemaIndexText(checkedReleaseName),
    );

    // The complete artifact, including extras, determines retention; a changed artifact installs.
    changeFixtureArtifact(directory);
    installCompiledReleases([release], fixtureRoot);
    expect(readFileSync(path.join(target, "app-artifact.json"))).toEqual(
      readFileSync(path.join(directory, "app-artifact.json")),
    );
    expect(readFileSync(path.join(target, "sql-bundle.sql"))).toEqual(readFileSync(bundlePath));
  } finally {
    cleanup(fixtureRoot);
  }
}, 60_000);

test("installs changed server adapters when Next is removed or added with the same app artifact", () => {
  const initial = createPlatformSchemaTestFixture(repositoryRoot, app);
  const fixtureRoot = initial.root;
  const artifact = readFileSync(path.join(initial.directory, "app-artifact.json"));
  try {
    for (const usesNext of [false, true]) {
      writeFileSync(
        path.join(fixtureRoot, "apps", app, "package.json"),
        JSON.stringify({ dependencies: usesNext ? { next: "16.0.0" } : {} }),
      );
      const generated = buildGeneratedRelease(
        app,
        path.join(fixtureRoot, usesNext ? "with-next" : "without-next"),
        appInputPaths(app, fixtureRoot).map((input) => path.relative(fixtureRoot, input)),
        fixtureRoot,
      );
      expect(readFileSync(path.join(generated.directory, "app-artifact.json"))).toEqual(artifact);
      const generatedAdapter = readFileSync(path.join(generated.directory, "data-server.ts"));
      expect(generatedAdapter.toString().includes('import "server-only";')).toBe(usesNext);
      expect(readFileSync(path.join(initial.directory, "data-server.ts"))).not.toEqual(
        generatedAdapter,
      );
      let staged = false;
      installCompiledReleases([generated], fixtureRoot, {
        afterReleaseStaged() {
          staged = true;
        },
      });
      expect(staged).toBe(true);
      expect(readFileSync(path.join(initial.directory, "data-server.ts"))).toEqual(
        generatedAdapter,
      );
      expect(readFileSync(path.join(initial.directory, "app-artifact.json"))).toEqual(artifact);
      verifyCheckedRelease(initial.directory, initial.sourcePath);
    }
  } finally {
    cleanup(fixtureRoot);
  }
}, 60_000);

test("retained later history does not replace an issued bundle and a newly compiled version installs", () => {
  const initial = createPlatformSchemaTestFixture(repositoryRoot, app);
  const fixtureRoot = initial.root;
  const later = createPlatformSchemaTestFixture(repositoryRoot, app, "platform-fixture-v2");
  const parent = path.join(fixtureRoot, "apps", app, "schema", "release");
  const target = path.join(parent, checkedReleaseName);
  const before = Object.fromEntries(
    readdirSync(target).map((name) => [name, readFileSync(path.join(target, name))]),
  );
  try {
    cpSync(later.directory, path.join(parent, later.version), { recursive: true });
    expect(transitionPredecessorArtifacts(app, checkedReleaseName, fixtureRoot)).toContain(
      path.join(parent, later.version, "app-artifact.json"),
    );
    const regenerated = buildGeneratedRelease(
      app,
      path.join(fixtureRoot, "regenerated"),
      appInputPaths(app, fixtureRoot).map((input) => path.relative(fixtureRoot, input)),
      fixtureRoot,
    );
    expect(
      JSON.parse(readFileSync(path.join(regenerated.directory, "app-artifact.json"), "utf8")),
    ).toEqual(JSON.parse(readFileSync(path.join(target, "app-artifact.json"), "utf8")));
    installCompiledReleases([regenerated], fixtureRoot);
    expect(
      Object.fromEntries(
        readdirSync(target).map((name) => [name, readFileSync(path.join(target, name))]),
      ),
    ).toEqual(before);
    rmSync(path.join(parent, later.version), { recursive: true });
    cpSync(later.sourcePath, path.join(fixtureRoot, sourceRelativePath));
    installCompiledReleases(
      [{ app, version: later.version, directory: later.directory }],
      fixtureRoot,
    );
    expect(
      verifyCheckedRelease(
        path.join(parent, later.version),
        path.join(fixtureRoot, sourceRelativePath),
      ).schema_version,
    ).toBe(later.version);
    expect(readFileSync(path.join(fixtureRoot, "apps", app, "schema", "index.ts"), "utf8")).toBe(
      generatedSchemaIndexText(later.version),
    );
    expect(
      Object.fromEntries(
        readdirSync(target).map((name) => [name, readFileSync(path.join(target, name))]),
      ),
    ).toEqual(before);
  } finally {
    cleanup(fixtureRoot);
    cleanup(later.root);
  }
}, 60_000);

test("rejects a prospective ambiguous schema index selection before changing repository files", () => {
  const { fixtureRoot, releases } = makeRollbackFixture();
  try {
    const before = releases.map((release) => installedContents(fixtureRoot, release));
    const first = releases[0]!;
    cpSync(
      first.directory,
      path.join(fixtureRoot, "apps", first.app, "schema", "release", "other-matching-release"),
      { recursive: true },
    );

    expect(() => installCompiledReleases(releases, fixtureRoot)).toThrow(
      "spend-review must have exactly one checked release matching its CUE source",
    );
    expect(releases.map((release) => installedContents(fixtureRoot, release))).toEqual(before);
  } finally {
    cleanup(fixtureRoot);
  }
}, 60_000);

test("validates every staged schema index release before changing repository files", () => {
  const { fixtureRoot, releases } = makeRollbackFixture();
  try {
    const before = releases.map((release) => installedContents(fixtureRoot, release));
    writeFileSync(
      path.join(releases[1]!.directory, "sql-bundle.sql"),
      readFileSync(path.join(releases[1]!.directory, "sql-bundle.sql"), "utf8") + "\n-- corrupt\n",
    );

    expect(() => installCompiledReleases(releases, fixtureRoot)).toThrow("checksum");
    expect(releases.map((release) => installedContents(fixtureRoot, release))).toEqual(before);
  } finally {
    cleanup(fixtureRoot);
  }
}, 60_000);

test("cleans a release staging directory after a staging failure", () => {
  const { fixtureRoot, releases } = makeRollbackFixture();
  try {
    const before = releases.map((release) => installedContents(fixtureRoot, release));
    const first = releases[0]!;
    changeFixtureArtifact(first.directory);

    expect(() =>
      installCompiledReleases(releases, fixtureRoot, {
        afterReleaseStaged(release) {
          if (release.app === first.app) throw new Error("release staging failed");
        },
      }),
    ).toThrow("release staging failed");

    const target = path.join(fixtureRoot, "apps", first.app, "schema", "release", first.version);
    expect(existsSync(`${target}.tmp`)).toBe(false);
    expect(releases.map((release) => installedContents(fixtureRoot, release))).toEqual(before);
  } finally {
    cleanup(fixtureRoot);
  }
});

test("installs one-line schema indexes and removes legacy generated-data pointers", () => {
  const { fixtureRoot, releases } = makeRollbackFixture();
  try {
    installCompiledReleases(releases, fixtureRoot);

    for (const release of releases) {
      const schemaDirectory = path.join(fixtureRoot, "apps", release.app, "schema");
      expect(readFileSync(path.join(schemaDirectory, "index.ts"), "utf8")).toBe(
        generatedSchemaIndexText(release.version),
      );
      expect(existsSync(path.join(schemaDirectory, "generated-data.ts"))).toBe(false);
    }
    for (const release of releases) {
      if (release.app !== "hc" && release.app !== "vendor") continue;
      expect(
        readFileSync(path.join(fixtureRoot, `apps/${release.app}/src/schema_release.rs`), "utf8"),
      ).toBe(generatedRustReleasePointerText(release.app, release.version));
    }
  } finally {
    cleanup(fixtureRoot);
  }
}, 60_000);

test("rolls back releases, indexes, and legacy pointers when the second app install fails", () => {
  const { fixtureRoot, releases } = makeRollbackFixture();
  try {
    const before = releases.map((release) => installedContents(fixtureRoot, release));

    expect(() =>
      installCompiledReleases(releases, fixtureRoot, {
        beforeIndexInstall(release) {
          if (release.app === "hc") throw new Error("second index write failed");
        },
      }),
    ).toThrow("second index write failed");

    expect(releases.map((release) => installedContents(fixtureRoot, release))).toEqual(before);
  } finally {
    cleanup(fixtureRoot);
  }
});

test("restores legacy generated-data pointers when removal fails", () => {
  const { fixtureRoot, releases } = makeRollbackFixture();
  try {
    const before = releases.map((release) => installedContents(fixtureRoot, release));

    expect(() =>
      installCompiledReleases(releases, fixtureRoot, {
        beforeLegacyPointerRemoval(release) {
          if (release.app === "hc") throw new Error("legacy pointer removal failed");
        },
      }),
    ).toThrow("legacy pointer removal failed");

    expect(releases.map((release) => installedContents(fixtureRoot, release))).toEqual(before);
  } finally {
    cleanup(fixtureRoot);
  }
});

test("formats long selected Rust release pointers with the standard formatter", () => {
  const pointer = generatedRustReleasePointerText("hc", "2026-10-07.protected-actor-binding-v59");
  expect(pointer).toContain("pub const HC_TRANSITION_CONTRACT: &str = include_str!(\n");
  expect(pointer).toContain(
    '    "../schema/release/2026-10-07.protected-actor-binding-v59/transition-contract.json"\n',
  );
});

test("external canonical predecessor retains the same release version outside mutable checkout", () => {
  const fixtureRoot = makeRoot();
  try {
    const external = path.join(fixtureRoot, "canonical-artifact.json");
    cpSync(path.join(checkedRelease, "app-artifact.json"), external);
    expect(externalTransitionPredecessors(JSON.stringify([external]), app)).toEqual([external]);
    expect(() => externalTransitionPredecessors(JSON.stringify([external]), "other-app")).toThrow(
      /selected app/,
    );
    expect(() => externalTransitionPredecessors(JSON.stringify([external]), undefined)).toThrow(
      /requires --app/,
    );
    expect(() => externalTransitionPredecessors("not json", app)).toThrow();
    expect(() => externalTransitionPredecessors('["relative.json"]', app)).toThrow(
      /absolute artifact paths/,
    );
    expect(
      transitionPredecessorArtifacts(app, checkedReleaseName, fixtureRoot, [external]),
    ).toEqual([external]);
    cpSync(
      checkedRelease,
      path.join(fixtureRoot, "apps", app, "schema", "release", checkedReleaseName),
      { recursive: true },
    );
    expect(
      transitionPredecessorArtifacts(app, "new-authored-version", fixtureRoot, [external])[0],
    ).toBe(external);
    expect(transitionPredecessorArtifacts(app, checkedReleaseName, fixtureRoot)).toEqual([]);
    writeFileSync(external, "not json");
    expect(() => externalTransitionPredecessors(JSON.stringify([external]), app)).toThrow();
  } finally {
    cleanup(fixtureRoot);
  }
});
