import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "vite-plus/test";

import {
  domainLibTurboJson,
  stableStringify,
  staleDomainLibTurboConfigPaths,
  writeDomainLibTurboConfigs,
} from "../domain-lib-turbo";

function withFixtureRepo(test: (root: string) => void): void {
  const root = mkdtempSync(path.join(tmpdir(), "domain-lib-turbo-"));
  try {
    const packageRoot = path.join(root, "packages/domain-libs", "employee");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@domain-libs/employee" }));
    test(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function writeTurboConfig(root: string, value: unknown): void {
  const configPath = path.join(root, "packages/domain-libs", "employee", "turbo.json");
  writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`);
}

function expectedConfig(): Record<string, unknown> {
  return JSON.parse(domainLibTurboJson()) as Record<string, unknown>;
}

describe("domain-lib turbo config generator", () => {
  it("reports missing configs as stale", () => {
    withFixtureRepo((root) => {
      assert.deepEqual(staleDomainLibTurboConfigPaths(root), [
        path.join(root, "packages/domain-libs", "employee", "turbo.json"),
      ]);
    });
  });

  it("reports stale config values as stale", () => {
    withFixtureRepo((root) => {
      const config = expectedConfig();
      writeTurboConfig(root, {
        ...config,
        extends: [],
      });

      assert.deepEqual(staleDomainLibTurboConfigPaths(root), [
        path.join(root, "packages/domain-libs", "employee", "turbo.json"),
      ]);
    });
  });

  it("treats input array order as semantically significant", () => {
    withFixtureRepo((root) => {
      const config = expectedConfig();
      const tasks = config.tasks as Record<string, { inputs: string[] }>;
      const testTask = tasks.test;
      assert(testTask);
      writeTurboConfig(root, {
        ...config,
        tasks: {
          ...tasks,
          test: {
            ...testTask,
            inputs: [...testTask.inputs].reverse(),
          },
        },
      });

      assert.deepEqual(staleDomainLibTurboConfigPaths(root), [
        path.join(root, "packages/domain-libs", "employee", "turbo.json"),
      ]);
    });
  });

  it("ignores object key ordering when checking semantic freshness", () => {
    withFixtureRepo((root) => {
      const config = expectedConfig();
      const tasks = config.tasks as Record<string, unknown>;
      writeTurboConfig(root, {
        tasks: {
          build: tasks.build,
          test: tasks.test,
        },
        extends: config.extends,
      });

      assert.deepEqual(staleDomainLibTurboConfigPaths(root), []);
      assert.equal(stableStringify(JSON.parse(readFileSync(
        path.join(root, "packages/domain-libs", "employee", "turbo.json"),
        "utf8",
      ))), stableStringify(config));
    });
  });

  it("writes configs that pass the check", () => {
    withFixtureRepo((root) => {
      writeDomainLibTurboConfigs(root);

      assert.equal(
        readFileSync(path.join(root, "packages/domain-libs", "employee", "turbo.json"), "utf8"),
        domainLibTurboJson(),
      );
      assert.deepEqual(staleDomainLibTurboConfigPaths(root), []);
    });
  });
});
