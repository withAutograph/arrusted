import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildGeneratedRelease } from "../../../.config/mise/scripts/repository/schema-release";

/** A real compiled release from a minimal test-owned app, independent of deployable apps. */
export function buildReleaseFixture() {
  const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
  const root = mkdtempSync(path.join(tmpdir(), "generated-release-fixture-"));
  const appId = "release-fixture";
  const sourceRelativePath = `apps/${appId}/schema/${appId}.cue`;
  const sourceCue = path.join(root, sourceRelativePath);
  try {
    // Reuse compiler sources read-only; every fixture artifact stays in its own root.
    for (const name of ["Cargo.toml", "Cargo.lock", "packages", ".config"])
      symlinkSync(path.join(repositoryRoot, name), path.join(root, name));
    mkdirSync(path.dirname(sourceCue), { recursive: true });
    writeFileSync(
      sourceCue,
      `package schema
manifest: #AppManifest & {
  app_id: "release-fixture"
  customer_id: "fixture-customer"
  version: "release-fixture-v1"
  label: "Release fixture"
  models: [{
    id: "item", kind: "entity", label: "Item"
    fields: [{id: "title", label: "Title", type: "text", required: true}]
  }]
}
`,
    );
    const release = buildGeneratedRelease(
      appId,
      path.join(root, "compiled"),
      ["packages/schema-compiler/cue/app-manifest.cue", sourceRelativePath],
      root,
      { ...process.env, CARGO_TARGET_DIR: path.join(repositoryRoot, "target") },
    );
    return {
      root,
      appId,
      sourceRelativePath,
      sourceCue,
      releaseDirectory: release.directory,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
