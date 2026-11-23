import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { spawnSync } from "node:child_process";

import { checkRustDependencyPolicy } from "./check-rust-dependency-policy";
import { createContext } from "./source-analysis";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const check = (source: string): string[] => {
  const root = mkdtempSync(join(tmpdir(), "rust-policy-"));
  roots.push(root);
  mkdirSync(join(root, "apps/example"), { recursive: true });
  writeFileSync(join(root, "apps/example/lib.rs"), source);
  const context = createContext(root);
  checkRustDependencyPolicy(context);
  return context.violations;
};

test("accepts the public kernel facade", () => expect(check("use kernel::Kernel;\n")).toEqual([]));

test("rejects an internal kernel module", () => {
  expect(check("use kernel::db::Database;\n")).toContain(
    "apps/example/lib.rs: forbidden internal kernel import `kernel::db`",
  );
});

test("fails closed for an invalid explicit repository root", () => {
  const missing = join(tmpdir(), `missing-rust-policy-${process.pid}`);
  const result = spawnSync(
    "bun",
    [join(import.meta.dirname, "check-rust-dependency-policy.ts"), missing],
    {
      encoding: "utf8",
    },
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(`Invalid repository root: ${missing}`);
});
