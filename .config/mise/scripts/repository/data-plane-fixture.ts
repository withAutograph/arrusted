import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildGeneratedRelease } from "./schema-release";

const mode = process.argv[2];
if (mode !== "compile" && mode !== "check")
  throw new Error("usage: data-plane-fixture.ts <compile|check>");
const directory = mkdtempSync(path.join(tmpdir(), "data-plane-fixture-"));
try {
  const release = buildGeneratedRelease("asset-register", directory, [
    "packages/schema-compiler/cue/app-manifest.cue",
    "packages/generated-app-runtime/__tests__/asset-register.cue",
  ]);
  const generated = readFileSync(path.join(release.directory, "data-operations.ts"));
  const target = "packages/generated-app-runtime/__tests__/asset-operations.generated.ts";
  if (mode === "compile") writeFileSync(target, generated);
  else if (!existsSync(target) || !generated.equals(readFileSync(target)))
    throw new Error("Generated data-plane fixture is stale; run mise run schema:compile");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
