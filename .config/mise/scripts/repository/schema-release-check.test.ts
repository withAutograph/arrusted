import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vite-plus/test";
import { checkRelease, generatedSchemaIndexText } from "./schema-release";

const hash = (value: string | Buffer) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const version = "2026-10-03.current-v3";
const script = ".config/mise/scripts/repository/schema-release.ts";
const source = "apps/fixture/schema/fixture.cue";
const retired = [{ kind: "field", model: "item", field: "obsolete", element: "obsolete" }];

function writeBundle(directory: string, tooling: string, retirements = retired): void {
  mkdirSync(directory, { recursive: true });
  const sources = { [source]: hash("package schema\n"), [script]: hash(tooling) };
  const artifact = { schema: { app_id: "fixture", version }, client: null };
  const members: Record<string, string> = {
    "app-artifact.json": json(artifact),
    "sql-manifest.json": "{}\n",
    "sql-bundle.sql": "-- controlled compiler output\n",
    "transition-plan.json": json({ checksum: hash(json(retirements)), retirements }),
    "transition-contract.json": "{}\n",
    "runtime-coverage.json": "{}\n",
    "cue-to-sql-source-map.json": json({ app: "fixture", sources }),
    "operation-manifest.json": "{}\n",
    "data-operations.ts": "export {};\n",
    "data-server.ts": "export {};\n",
    "data-operations.md": "Fixture\n",
  };
  const hashMembers = {
    server_bindings: "data-server.ts",
    operations: "operation-manifest.json",
    bindings: "data-operations.ts",
    operation_docs: "data-operations.md",
    schema: "app-artifact.json",
    plan: "transition-plan.json",
    transition_contract: "transition-contract.json",
    bundle: "sql-bundle.sql",
    coverage: "runtime-coverage.json",
    sql_manifest: "sql-manifest.json",
    source_map: "cue-to-sql-source-map.json",
  };
  for (const [name, bytes] of Object.entries(members)) {
    writeFileSync(path.join(directory, name), bytes);
  }
  writeFileSync(
    path.join(directory, "release-manifest.json"),
    json({
      app: "fixture",
      schema_version: version,
      sources,
      hashes: {
        source: hash(JSON.stringify(sources)),
        ...Object.fromEntries(
          Object.entries(hashMembers).map(([key, name]) => [key, hash(members[name]!)]),
        ),
        client: hash(JSON.stringify(artifact.client)),
      },
    }),
  );
}

function fixture(check: (root: string, checked: string, generated: string) => void): void {
  const root = mkdtempSync(path.join(tmpdir(), "historical-plan-check-"));
  const schema = path.join(root, "apps/fixture/schema");
  const checked = path.join(schema, "release", version);
  const generated = path.join(root, "generated");
  const previousProvider = process.env.VERCEL_MISE_BIN;
  const previousPlan = process.env.FIXTURE_HISTORICAL_PLAN;
  try {
    mkdirSync(schema, { recursive: true });
    writeFileSync(path.join(root, source), "package schema\n");
    writeFileSync(path.join(schema, "index.ts"), generatedSchemaIndexText(version));
    writeBundle(checked, "old tooling");
    writeBundle(generated, "new tooling", []);
    const oldest = path.join(schema, "release/2026-10-01.initial-v1");
    mkdirSync(oldest, { recursive: true });
    writeFileSync(path.join(oldest, "app-artifact.json"), "{}\n");
    // The compiler is a controlled subprocess at this orchestration boundary.
    // It returns a separately captured historical plan; no Rust/CUE is needed.
    const captured = path.join(root, "historical-plan.json");
    writeFileSync(captured, readFileSync(path.join(checked, "transition-plan.json")));
    const executable = path.join(root, "fixture-compiler");
    writeFileSync(executable, '#!/bin/sh\ncat "$FIXTURE_HISTORICAL_PLAN"\n', { mode: 0o755 });
    process.env.VERCEL_MISE_BIN = executable;
    process.env.FIXTURE_HISTORICAL_PLAN = captured;
    check(root, checked, generated);
  } finally {
    if (previousProvider === undefined) delete process.env.VERCEL_MISE_BIN;
    else process.env.VERCEL_MISE_BIN = previousProvider;
    if (previousPlan === undefined) delete process.env.FIXTURE_HISTORICAL_PLAN;
    else process.env.FIXTURE_HISTORICAL_PLAN = previousPlan;
    rmSync(root, { recursive: true, force: true });
  }
}

const release = (directory: string) => ({ app: "fixture", version, directory });
const snapshot = (directory: string) =>
  Object.fromEntries(
    readdirSync(directory).map((name) => [name, readFileSync(path.join(directory, name))]),
  );

test("checking a re-proven historical plan preserves every issued member byte", () => {
  fixture((root, checked, generated) => {
    const before = snapshot(checked);
    expect(checkRelease(release(generated), root)).toEqual([]);
    expect(snapshot(checked)).toEqual(before);
  });
});

test("a newly generated release must match the corrected plan", () => {
  fixture((root, checked, generated) => {
    writeBundle(checked, "new tooling");
    const failures = checkRelease(release(generated), root);
    expect(failures.some((failure) => failure.includes("transition-plan.json is stale"))).toBe(true);
    writeBundle(checked, "new tooling", []);
    expect(checkRelease(release(generated), root)).toEqual([]);
  });
});

test("an explicit external predecessor never falls back to historical selection", () => {
  fixture((root, _checked, generated) => {
    const failures = checkRelease(release(generated), root, [path.join(root, "canonical.json")]);
    expect(failures.some((failure) => failure.includes("transition-plan.json is stale"))).toBe(true);
  });
});

test("a different rechecksummed plan and unrelated compiler drift still fail", () => {
  fixture((root, checked, generated) => {
    writeBundle(checked, "old tooling", [{ ...retired[0]!, element: "other" }]);
    expect(
      checkRelease(release(generated), root).some((failure) =>
        failure.includes("transition-plan.json is stale"),
      ),
    ).toBe(true);
    writeBundle(checked, "old tooling");
    writeFileSync(path.join(generated, "sql-bundle.sql"), "-- changed compiler SQL\n");
    expect(
      checkRelease(release(generated), root).some((failure) =>
        failure.includes("sql-bundle.sql is stale"),
      ),
    ).toBe(true);
  });
});

test("a plan with an invalid issued checksum cannot use the historical exception", () => {
  fixture((root, checked, generated) => {
    writeFileSync(path.join(checked, "transition-plan.json"), "{}\n");
    expect(
      checkRelease(release(generated), root).some((failure) =>
        failure.startsWith("Invalid checked release:"),
      ),
    ).toBe(true);
  });
});
