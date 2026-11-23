import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vite-plus/test";
import {
  transitionPlanPredecessorArtifact,
  transitionPredecessorArtifacts,
} from "./schema-release";

function withReleases(
  versions: string[],
  check: (root: string, artifact: (version: string) => string) => void,
): void {
  const root = mkdtempSync(path.join(tmpdir(), "schema-predecessor-"));
  const artifact = (version: string) =>
    path.join(root, "apps", "fixture", "schema", "release", version, "app-artifact.json");
  try {
    for (const version of versions) {
      mkdirSync(path.dirname(artifact(version)), { recursive: true });
      writeFileSync(artifact(version), JSON.stringify({ schema: { version } }));
    }
    check(root, artifact);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the plan uses the latest prior release rather than repeating an old retirement", () => {
  const oldest = "2026-10-01.initial-v1";
  const previous = "2026-10-02.retired-v2";
  const target = "2026-10-03.current-v3";
  withReleases([oldest, previous, target], (root, artifact) => {
    for (const version of [oldest, previous, target]) {
      writeFileSync(
        artifact(version),
        JSON.stringify({
          schema: {
            version,
            models: [{ id: "item", fields: version === oldest ? [{ id: "retired" }] : [] }],
          },
        }),
      );
    }
    const selected = transitionPlanPredecessorArtifact("fixture", target, root);
    expect(selected).toBe(artifact(previous));
    expect(JSON.parse(readFileSync(selected!, "utf8")).schema.models[0].fields).toEqual([]);
  });
});

test("same-day releases follow numeric cut order across different descriptions", () => {
  const previous = "2026-10-31.canvas-in-chat-v119";
  withReleases(["2026-10-31.canvas-parity-v111", previous], (root, artifact) => {
    expect(transitionPlanPredecessorArtifact("fixture", "2026-10-31.next-v120", root)).toBe(
      artifact(previous),
    );
  });
});

test("numeric cut order handles v9 and v10", () => {
  withReleases(["2026-10-31.release-v9", "2026-10-31.release-v10"], (root, artifact) => {
    expect(transitionPlanPredecessorArtifact("fixture", "2026-10-31.release-v11", root)).toBe(
      artifact("2026-10-31.release-v10"),
    );
  });
});

test("the release date takes precedence over the numeric suffix", () => {
  withReleases(["2026-10-30.release-v999", "2026-10-31.release-v2"], (root, artifact) => {
    expect(transitionPlanPredecessorArtifact("fixture", "2026-11-01.release-v3", root)).toBe(
      artifact("2026-10-31.release-v2"),
    );
  });
});

test("undated fixture versions also follow numeric cut order", () => {
  withReleases(["platform-fixture-v9", "platform-fixture-v10"], (root, artifact) => {
    expect(transitionPlanPredecessorArtifact("fixture", "platform-fixture-v11", root)).toBe(
      artifact("platform-fixture-v10"),
    );
  });
});

test("legacy dated releases without a numeric cut still precede later releases", () => {
  withReleases(["2026-08-24.tenant-managed-lookups"], (root, artifact) => {
    expect(transitionPlanPredecessorArtifact("fixture", "2026-10-31.release-v9", root)).toBe(
      artifact("2026-08-24.tenant-managed-lookups"),
    );
  });
});

test("an older target ignores itself and newer cuts while retaining the complete contract history", () => {
  const versions = [
    "2026-10-30.release-v8",
    "2026-10-31.release-v9",
    "2026-10-31.release-v10",
    "2026-11-01.release-v11",
  ];
  withReleases(versions, (root, artifact) => {
    const target = versions[2]!;
    expect(transitionPlanPredecessorArtifact("fixture", target, root)).toBe(
      artifact(versions[1]!),
    );
    expect(transitionPredecessorArtifacts("fixture", target, root)).toEqual(
      [versions[0]!, versions[1]!, versions[3]!].map(artifact),
    );
  });
});

test("a target with no older artifact has no plan predecessor even with future history", () => {
  withReleases(["2026-10-31.release-v9", "2026-11-01.release-v10"], (root, artifact) => {
    expect(transitionPlanPredecessorArtifact("fixture", "2026-10-31.release-v9", root)).toBe(
      undefined,
    );
    expect(transitionPredecessorArtifacts("fixture", "2026-10-31.release-v9", root)).toEqual([
      artifact("2026-11-01.release-v10"),
    ]);
  });
});

test("the first explicit external artifact wins regardless of its name or version", () => {
  withReleases(["2026-10-31.release-v9"], (root, artifact) => {
    const canonical = path.join(root, "canonical.json");
    const secondary = path.join(root, "secondary.json");
    for (const file of [canonical, secondary]) writeFileSync(file, "{}");
    const external = [canonical, secondary, canonical, artifact("2026-10-31.release-v9")];
    expect(
      transitionPlanPredecessorArtifact("fixture", "2026-10-31.release-v9", root, external),
    ).toBe(canonical);
    expect(
      transitionPredecessorArtifacts("fixture", "2026-10-31.release-v10", root, external),
    ).toEqual([canonical, secondary, artifact("2026-10-31.release-v9")]);
  });
});

test("missing history or an incomplete release directory supplies no plan predecessor", () => {
  withReleases([], (root, artifact) => {
    expect(transitionPlanPredecessorArtifact("fixture", "2026-10-31.release-v9", root)).toBe(
      undefined,
    );
    mkdirSync(path.dirname(artifact("2026-10-30.incomplete-v8")), { recursive: true });
    expect(transitionPlanPredecessorArtifact("fixture", "2026-10-31.release-v9", root)).toBe(
      undefined,
    );
    expect(transitionPredecessorArtifacts("fixture", "2026-10-31.release-v9", root)).toEqual([]);
  });
});

test("generated app dotted versions follow numeric cut order", () => {
  const previous = "2026-11-16.v10";
  withReleases(["2026-11-16.v9", previous], (root, artifact) => {
    expect(transitionPlanPredecessorArtifact("fixture", "2026-11-16.v11", root)).toBe(
      artifact(previous),
    );
  });
});
