import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { buildReleaseFixture } from "./release-fixture";
import { checkedReleaseDirectory, resolveGeneratedDiagnostic } from "../server";
import { generatedAppRuntimeExcludes, generatedAppRuntimeFiles } from "../release";

const sourceRelativePath = "apps/release-fixture/schema/release-fixture.cue";
let fixture: ReturnType<typeof buildReleaseFixture>;
beforeAll(() => {
  fixture = buildReleaseFixture();
}, 180_000);
afterAll(() => fixture?.cleanup());

function makeRoot(...releaseNames: string[]): string {
  const root = mkdtempSync(path.join(tmpdir(), "release-selection-"));
  const sourceDestination = path.join(root, sourceRelativePath);
  mkdirSync(path.dirname(sourceDestination), { recursive: true });
  cpSync(fixture.sourceCue, sourceDestination);
  for (const releaseName of releaseNames)
    cpSync(
      fixture.releaseDirectory,
      path.join(root, "apps/release-fixture/schema/release", releaseName),
      {
        recursive: true,
      },
    );
  return root;
}

function sourceMapPath(root: string, releaseName: string): string {
  return path.join(
    root,
    "apps/release-fixture/schema/release",
    releaseName,
    "cue-to-sql-source-map.json",
  );
}

function markSourceStale(root: string, releaseName: string): void {
  const mapPath = sourceMapPath(root, releaseName);
  const sourceMap = JSON.parse(readFileSync(mapPath, "utf8")) as {
    sources: Record<string, string>;
  };
  sourceMap.sources[sourceRelativePath] = `sha256:${"0".repeat(64)}`;
  writeFileSync(mapPath, `${JSON.stringify(sourceMap, null, 2)}\n`);
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

test("selects the sole release matching the current app CUE source", () => {
  const root = makeRoot("release-fixture-v1", "historical-v0");
  try {
    markSourceStale(root, "historical-v0");
    expect(checkedReleaseDirectory(root, "release-fixture")).toBe(
      path.join(root, "apps/release-fixture/schema/release/release-fixture-v1"),
    );
  } finally {
    cleanup(root);
  }
});

test("traces the CUE and matching release without historical releases", () => {
  const root = makeRoot("selected", "historical");
  try {
    markSourceStale(root, "historical");
    expect(generatedAppRuntimeFiles(root, "release-fixture")).toEqual([
      "./schema/release-fixture.cue",
      "./schema/release/selected/**/*",
    ]);
    expect(generatedAppRuntimeExcludes(root, "release-fixture")).toEqual([
      "./schema/release/historical/**/*",
    ]);
  } finally {
    cleanup(root);
  }
});

test("fails when no release matches or more than one release matches", () => {
  const staleRoot = makeRoot("historical-v0");
  try {
    markSourceStale(staleRoot, "historical-v0");
    expect(() => checkedReleaseDirectory(staleRoot, "release-fixture")).toThrow(
      "must have exactly one checked release matching its CUE source",
    );
  } finally {
    cleanup(staleRoot);
  }

  const ambiguousRoot = makeRoot("candidate-a", "candidate-b");
  try {
    expect(() => checkedReleaseDirectory(ambiguousRoot, "release-fixture")).toThrow(
      "must have exactly one checked release matching its CUE source",
    );
  } finally {
    cleanup(ambiguousRoot);
  }
});

test("verifies the selected release bundle before returning it", () => {
  const root = makeRoot("candidate");
  try {
    const bundlePath = path.join(
      root,
      "apps/release-fixture/schema/release/candidate/sql-bundle.sql",
    );
    writeFileSync(bundlePath, `${readFileSync(bundlePath, "utf8")}\n-- corrupt\n`);
    expect(() => checkedReleaseDirectory(root, "release-fixture")).toThrow("checksum");
  } finally {
    cleanup(root);
  }
});

test("normalizes trusted generated diagnostics to CUE origins without database text", () => {
  const root = mkdtempSync(path.join(tmpdir(), "generated-diagnostic-"));
  try {
    writeFileSync(
      path.join(root, "cue-to-sql-source-map.json"),
      JSON.stringify({
        sql_artifacts: [
          {
            kind: "check_constraint",
            name: "invoice_version_invoice_amount_positive_constraint_check",
            origin: {
              source: "apps/purchase-ledger/schema/purchase-ledger.cue",
              path: "constraints.invoice_amount_positive.expression",
              kind: "constraint",
            },
          },
        ],
      }),
    );
    const result = resolveGeneratedDiagnostic(root, {
      code: "constraint_violation",
      details: [{ message: "invoice_amount_positive" }],
    });
    expect(result).toEqual({
      code: "constraint_violation",
      origin: {
        source: "apps/purchase-ledger/schema/purchase-ledger.cue",
        path: "constraints.invoice_amount_positive.expression",
        kind: "constraint",
      },
    });
    expect(JSON.stringify(result)).not.toContain("private SQL");
  } finally {
    cleanup(root);
  }
});

test.each(["app", "schema_version"])("rejects altered release %s identity", (field) => {
  const root = makeRoot("candidate");
  try {
    const manifestPath = path.join(
      root,
      "apps/release-fixture/schema/release/candidate/release-manifest.json",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest[field] = "forged-identity";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => checkedReleaseDirectory(root, "release-fixture")).toThrow("identity disagrees");
  } finally {
    cleanup(root);
  }
});
