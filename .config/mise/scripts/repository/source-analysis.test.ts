import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { resolveSourcePath } from "./source-analysis";
it("resolves native Node ESM output imports to actual TypeScript ESM sources", () => {
  const root = mkdtempSync(path.join(tmpdir(), "esm-source-resolution-"));
  try {
    const source = path.join(root, "entry.mts");
    expect(resolveSourcePath(path.join(root, "entry.mjs"))).toBeUndefined();
    writeFileSync(source, "export default {};\n");
    expect(resolveSourcePath(path.join(root, "entry.mjs"))).toBe(source);
    expect(resolveSourcePath(path.join(root, "missing.mjs"))).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
