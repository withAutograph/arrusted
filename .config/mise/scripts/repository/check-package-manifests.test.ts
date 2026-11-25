import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { checkPackageManifests, likelyUnusedDependencies } from "./check-package-manifests";

const roots: string[] = [];

function writeManifest(root: string, relative: string, value: unknown): void {
  const destination = path.join(root, relative);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "package-manifests-"));
  roots.push(root);
  writeManifest(root, "package.json", {
    name: "workspace",
    private: true,
    catalog: JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../../../package.json"), "utf8")).catalog,
    dependencies: { react: "catalog:" },
  });
  writeManifest(root, "apps/example/package.json", {
    name: "@example/app",
    private: true,
    dependencies: { next: "catalog:", react: "catalog:" },
  });
  writeManifest(root, "packages/lib/package.json", {
    name: "@example/lib",
    private: true,
    peerDependencies: { react: ">=18.0.0 <20.0.0" },
  });
  writeManifest(root, ".config/turbo/generators/package.json", {
    name: "@example/generator",
    private: true,
  });
  writeManifest(root, ".config/turbo/generators/templates/app/package.json.hbs", {
    name: "{{ packageName }}",
    private: true,
    scripts: { check: "vp check" },
  });
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("accepts catalog references and broader library peer compatibility", () => {
  expect(checkPackageManifests(fixture())).toEqual([]);
});

test("permits an app-owned dependency used by only one workspace", () => {
  const root = fixture();
  writeManifest(root, "apps/example/package.json", {
    name: "@example/app",
    private: true,
    dependencies: { next: "catalog:", react: "catalog:", valibot: "1.0.0" },
  });
  expect(checkPackageManifests(root)).toEqual([]);
});

test("keeps dependency sections in their standard order", () => {
  const root = fixture();
  writeManifest(root, "apps/example/package.json", {
    name: "@example/app",
    private: true,
    devDependencies: { react: "catalog:" },
    dependencies: { next: "catalog:" },
    postcss: { plugins: {} },
  });
  expect(checkPackageManifests(root)).toEqual(
    expect.arrayContaining([
      "apps/example/package.json dependency sections must follow standard order",
    ]),
  );
});

test("keeps test scripts together before build and start", () => {
  const root = fixture();
  writeManifest(root, "apps/example/package.json", {
    name: "@example/app",
    private: true,
    scripts: {
      test: "vp test --run",
      build: "next build",
      "test:e2e": "playwright test",
    },
    dependencies: { next: "catalog:", react: "catalog:" },
  });
  expect(checkPackageManifests(root)).toContain(
    "apps/example/package.json script test:e2e is out of standard order after build",
  );
});

test("rejects duplicated versions for catalogued packages and missing catalog pins", () => {
  const root = fixture();
  writeManifest(root, "apps/example/package.json", {
    name: "@example/app",
    private: true,
    dependencies: { next: "16.3.3", react: "catalog:", unknown: "catalog:" },
  });
  expect(checkPackageManifests(root)).toEqual(
    expect.arrayContaining([
      "apps/example/package.json dependencies.next must use the root catalog",
      "apps/example/package.json dependencies.unknown needs a root catalog pin",
    ]),
  );
});

test("requires a catalog pin when a new external package is shared", () => {
  const root = fixture();
  for (const relative of ["apps/example/package.json", "packages/lib/package.json"]) {
    const file = path.join(root, relative);
    const manifest = JSON.parse(readFileSync(file, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    manifest.dependencies = { ...manifest.dependencies, valibot: "1.0.0" };
    writeManifest(root, relative, manifest);
  }
  expect(checkPackageManifests(root)).toContain(
    "valibot is used by 2 workspaces and needs a root catalog pin",
  );
});

test("requires unique workspace names and resolvable workspace references", () => {
  const root = fixture();
  writeManifest(root, "packages/other/package.json", {
    name: "@example/lib",
    private: true,
  });
  writeManifest(root, "apps/example/package.json", {
    name: "@example/app",
    private: true,
    dependencies: {
      "@example/lib": "workspace:*",
      "@example/missing": "workspace:*",
      next: "catalog:",
      react: "catalog:",
    },
  });
  expect(checkPackageManifests(root)).toEqual(
    expect.arrayContaining([
      "packages/other/package.json duplicates workspace name @example/lib from packages/lib/package.json",
      "apps/example/package.json dependencies.@example/missing must reference an existing workspace with workspace:*",
    ]),
  );
});

test("requires local packages to use workspace:* and rejects unsupported workspace ranges", () => {
  const root = fixture();
  writeManifest(root, "apps/example/package.json", {
    name: "@example/app",
    private: true,
    dependencies: {
      "@example/lib": "0.0.0",
      next: "catalog:",
      react: "catalog:",
    },
    devDependencies: { "@example/generator": "workspace:^" },
  });
  expect(checkPackageManifests(root)).toEqual(
    expect.arrayContaining([
      "apps/example/package.json dependencies.@example/lib must use workspace:*",
      "apps/example/package.json devDependencies.@example/generator must reference an existing workspace with workspace:*",
    ]),
  );
});

test("checks every package export and bin target, including unused exports", () => {
  const root = fixture();
  writeManifest(root, "packages/lib/package.json", {
    name: "@example/lib",
    private: true,
    exports: { ".": "./index.ts", "./unused": "./missing.ts" },
    bin: { example: "./missing-cli.mjs" },
  });
  writeFileSync(path.join(root, "packages/lib/index.ts"), "export const value = 1;\n");
  expect(checkPackageManifests(root)).toEqual(
    expect.arrayContaining([
      "packages/lib/package.json export ./unused target ./missing.ts does not exist",
      "packages/lib/package.json bin target ./missing-cli.mjs must exist in its package",
    ]),
  );
});

test("allows generated dist exports only with a build and existing source", () => {
  const root = fixture();
  writeFileSync(path.join(root, "packages/lib/index.ts"), "export const value = 1;\n");
  writeManifest(root, "packages/lib/package.json", {
    name: "@example/lib",
    private: true,
    scripts: { build: "bun build index.ts --outfile=dist/index.mjs" },
    exports: { ".": { source: "./index.ts", default: "./dist/index.mjs" } },
  });
  expect(checkPackageManifests(root)).toEqual([]);
  rmSync(path.join(root, "packages/lib/index.ts"));
  expect(checkPackageManifests(root)).toContain(
    "packages/lib/package.json generated export . target ./dist/index.mjs needs a build and existing source",
  );
});

test("reports likely unused direct dependencies without failing manifest validation", () => {
  const root = fixture();
  writeManifest(root, "packages/lib/package.json", {
    name: "@example/lib",
    private: true,
    dependencies: { lodash: "catalog:", valibot: "1.0.0" },
  });
  writeFileSync(
    path.join(root, "packages/lib/index.ts"),
    'import { z } from "valibot";\nexport { z };\n',
  );
  expect(checkPackageManifests(root)).toEqual([]);
  expect(likelyUnusedDependencies(root)).toContain("packages/lib/package.json dependencies.lodash");
  expect(likelyUnusedDependencies(root)).not.toContain(
    "packages/lib/package.json dependencies.valibot",
  );
});

test("recognizes dependencies referenced by a package TypeScript preset", () => {
  const root = fixture();
  writeManifest(root, "packages/lib/package.json", {
    name: "@example/lib",
    private: true,
    devDependencies: { "@example/typescript-config": "workspace:*" },
  });
  writeManifest(root, "packages/lib/nested/tsconfig.json", {
    extends: "@example/typescript-config/base.json",
  });
  expect(likelyUnusedDependencies(root)).not.toContain(
    "packages/lib/package.json devDependencies.@example/typescript-config",
  );
});

test("requires direct declarations for package source imports", () => {
  const root = fixture();
  writeFileSync(
    path.join(root, "packages/lib/index.ts"),
    'import { parse } from "zod";\nexport * from "lodash";\n// import "ignored-comment"\nexport const value = parse;\n',
  );
  expect(checkPackageManifests(root)).toEqual(
    expect.arrayContaining([
      "packages/lib/package.json imports zod in packages/lib/index.ts without a direct dependency declaration",
      "packages/lib/package.json imports lodash in packages/lib/index.ts without a direct dependency declaration",
    ]),
  );
  expect(checkPackageManifests(root).join("\n")).not.toContain("ignored-comment");
});

test("requires direct app imports while allowing local aliases and framework markers", () => {
  const root = fixture();
  writeManifest(root, "apps/example/tsconfig.json", {
    compilerOptions: { paths: { "@/*": ["./*"] } },
  });
  writeFileSync(
    path.join(root, "apps/example/index.ts"),
    'import "server-only";\nimport "@/local";\nimport { value } from "@example/lib";\nimport { z } from "zod";\nexport { value, z };\n',
  );
  expect(checkPackageManifests(root)).toEqual(
    expect.arrayContaining([
      "apps/example/package.json imports @example/lib in apps/example/index.ts without a direct dependency declaration",
      "apps/example/package.json imports zod in apps/example/index.ts without a direct dependency declaration",
    ]),
  );
  expect(checkPackageManifests(root)).toHaveLength(2);
});

test("accepts aliases inherited through a TypeScript preset", () => {
  const root = fixture();
  writeManifest(root, ".config/typescript/workspace-paths.json", {
    compilerOptions: { paths: { "@contracts": ["../../packages/contracts/index.ts"] } },
  });
  writeManifest(root, "apps/example/tsconfig.json", {
    extends: "../../.config/typescript/workspace-paths.json",
  });
  writeFileSync(
    path.join(root, "apps/example/index.ts"),
    'import type { Contract } from "@contracts";\nexport type Value = Contract;\n',
  );
  expect(checkPackageManifests(root)).toEqual([]);
});

test("requires runtime package imports outside devDependencies", () => {
  const root = fixture();
  writeManifest(root, "packages/lib/package.json", {
    name: "@example/lib",
    private: true,
    devDependencies: { valibot: "1.0.0", "vite-plus": "catalog:" },
    peerDependencies: { react: ">=18.0.0 <20.0.0" },
  });
  writeFileSync(
    path.join(root, "packages/lib/index.ts"),
    'import { z } from "valibot";\nimport type { UserConfig } from "vite-plus";\nexport { z };\nexport type Config = UserConfig;\n',
  );
  expect(checkPackageManifests(root)).toEqual([
    "packages/lib/package.json imports valibot in packages/lib/index.ts but declares it only as a devDependency",
  ]);
});

test("requires package test imports to have local development dependencies", () => {
  const root = fixture();
  const tests = path.join(root, "packages/lib/__tests__");
  mkdirSync(tests, { recursive: true });
  writeFileSync(
    path.join(tests, "index.test.ts"),
    'import { test } from "vitest";\ntest("ok", () => {});\n',
  );
  expect(checkPackageManifests(root)).toContain(
    "packages/lib/package.json imports vitest in packages/lib/__tests__/index.test.ts without a direct dependency declaration",
  );
});

test("requires package tests to be reachable from a package script or an owning task", () => {
  const root = fixture();
  writeFileSync(
    path.join(root, "packages/lib/index.test.ts"),
    'import { test } from "vitest";\ntest("ok", () => {});\n',
  );
  writeManifest(root, "packages/lib/package.json", {
    name: "@example/lib",
    private: true,
    devDependencies: { vitest: "catalog:" },
  });
  expect(checkPackageManifests(root)).toContain(
    "packages/lib/package.json has tests but needs a test script or an owning repository test task",
  );
  const task = path.join(root, ".config/mise/tasks/test/lib");
  mkdirSync(path.dirname(task), { recursive: true });
  writeFileSync(task, "exec bun x vitest run packages/lib/index.test.ts\n");
  writeManifest(root, "packages/lib/package.json", {
    name: "@example/lib",
    private: true,
    autograph: { testTask: "test:lib" },
    devDependencies: { vitest: "catalog:" },
  });
  expect(checkPackageManifests(root)).toEqual([]);
});

test("accepts source imports satisfied by peers and ignores type-only path aliases", () => {
  const root = fixture();
  writeManifest(root, "tsconfig.json", {
    compilerOptions: { paths: { "@contracts": ["./packages/contracts/index.ts"] } },
  });
  writeFileSync(
    path.join(root, "packages/lib/index.ts"),
    'import type { ReactNode } from "react";\nimport type { Contract } from "@contracts";\nexport type Value = ReactNode | Contract;\n',
  );
  expect(checkPackageManifests(root)).toEqual([]);
});

test("requires a package-local check when a package owns a TypeScript project", () => {
  const root = fixture();
  writeManifest(root, "packages/lib/tsconfig.json", { compilerOptions: { noEmit: true } });
  expect(checkPackageManifests(root)).toContain(
    "packages/lib/package.json needs a check script for its package-local tsconfig.json",
  );
});

test("checks generator and standalone Storybook TypeScript lifecycles", () => {
  const root = fixture();
  writeManifest(root, ".config/turbo/generators/tsconfig.json", {});
  writeManifest(root, ".storybook/package.json", {
    name: "@example/storybook",
    private: true,
    scripts: { build: "storybook build" },
  });
  writeManifest(root, ".storybook/tsconfig.json", {});
  expect(checkPackageManifests(root)).toEqual(
    expect.arrayContaining([
      ".config/turbo/generators/package.json needs a check script for its package-local tsconfig.json",
      ".storybook/package.json needs a check script for its package-local tsconfig.json",
    ]),
  );
});

test("keeps standalone Storybook pins aligned with the root catalog", () => {
  const root = fixture();
  writeManifest(root, ".storybook/package.json", {
    name: "@example/storybook",
    private: true,
    devDependencies: { "vite-plus": "0.2.6" },
  });
  expect(checkPackageManifests(root)).toContain(
    ".storybook/package.json devDependencies.vite-plus must match the root catalog pin",
  );
});

test("rejects a build that only type checks through an inherited noEmit config", () => {
  const root = fixture();
  writeManifest(root, "packages/tsconfig.shared.json", { compilerOptions: { noEmit: true } });
  writeManifest(root, "packages/lib/tsconfig.json", { extends: "../tsconfig.shared.json" });
  writeManifest(root, "packages/lib/package.json", {
    name: "@example/lib",
    private: true,
    scripts: { check: "tsc -p tsconfig.json --noEmit", build: "tsc -p tsconfig.json" },
  });
  expect(checkPackageManifests(root)).toContain(
    "packages/lib/package.json build script must emit artifacts; use check for no-emit TypeScript validation",
  );
});

test("requires one-shot package tests and avoids duplicate pack builds", () => {
  const root = fixture();
  writeManifest(root, "packages/lib/package.json", {
    name: "@example/lib",
    private: true,
    scripts: {
      test: "vp test --config vite.config.ts",
      prepare: "bun run build",
      prepack: "bun run build",
    },
  });
  expect(checkPackageManifests(root)).toEqual(
    expect.arrayContaining([
      "packages/lib/package.json test script must run once with --run",
      "packages/lib/package.json prepare and prepack scripts must not repeat the same command",
    ]),
  );
});
