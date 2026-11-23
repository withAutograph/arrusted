import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";

import { findTaskOwnershipViolations } from "./check-mise-task-ownership";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const fixture = (taskPath: string, taskAlias = "", app = "hc", quote = '"') => {
  const root = mkdtempSync(join(tmpdir(), "mise-task-ownership-"));
  roots.push(root);
  mkdirSync(join(root, "apps", app), { recursive: true });
  writeFileSync(join(root, "apps", app, "package.json"), "{}\n");
  const taskFile = join(root, ".config/mise/tasks", taskPath);
  mkdirSync(dirname(taskFile), { recursive: true });
  writeFileSync(taskFile, "#!/bin/sh\n");
  writeFileSync(
    join(root, ".config/mise/config.toml"),
    taskAlias ? `[tasks.${quote}${taskAlias}${quote}]\nrun = "true"\n` : "",
  );
  return root;
};

test("rejects app-owned root task paths and aliases", () => {
  expect(findTaskOwnershipViolations(fixture("generate/hc-client", "hc:materialize"))).toEqual([
    ".config/mise/tasks/generate/hc-client",
    ".config/mise/config.toml task alias hc:materialize",
  ]);
});

test("rejects single-quoted app-owned root aliases", () => {
  expect(findTaskOwnershipViolations(fixture("repository/check", "hc:materialize", "hc", "'"))).toEqual([
    ".config/mise/config.toml task alias hc:materialize",
  ]);
});

test("rejects provider-owned root task paths", () => {
  expect(findTaskOwnershipViolations(fixture("ampersand/verify"))).toEqual([
    ".config/mise/tasks/ampersand/verify",
  ]);
});

test("rejects the former Spend Review root-task shape", () => {
  expect(
    findTaskOwnershipViolations(fixture("spend-review/reset", "spend-review:reset", "spend-review")),
  ).toEqual([
    ".config/mise/tasks/spend-review/reset",
    ".config/mise/config.toml task alias spend-review:reset",
  ]);
});

test("allows repository-owned task paths and aliases", () => {
  expect(findTaskOwnershipViolations(fixture("repository/check", "check:tooling-layout"))).toEqual([]);
});

test("fails closed when the root mise task inputs are missing", () => {
  const root = mkdtempSync(join(tmpdir(), "mise-task-ownership-missing-"));
  roots.push(root);

  expect(findTaskOwnershipViolations(root)).toEqual([
    ".config/mise/tasks (missing)",
    ".config/mise/config.toml (missing)",
  ]);
});
