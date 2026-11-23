import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";

import { checkWorkspaceImports } from "./check-workspace-imports";
import { createContext } from "./source-analysis";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const fixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), "workspace-imports-"));
  roots.push(root);
  mkdirSync(join(root, "packages/contracts"), { recursive: true });
  writeFileSync(join(root, "packages/contracts/package.json"), '{"name":"@autograph/contracts"}\n');
  writeFileSync(join(root, "packages/contracts/index.ts"), "export type Id = string;\n");
  return root;
};

test("accepts a resolved workspace import", () => {
  const root = fixture();
  mkdirSync(join(root, "apps/consumer"), { recursive: true });
  writeFileSync(
    join(root, "apps/consumer/index.ts"),
    'import type { Id } from "@autograph/contracts";\nexport type ConsumerId = Id;\n',
  );
  const context = createContext(root);
  checkWorkspaceImports(context);
  expect(context.violations).toEqual([]);
});

test("rejects a malformed workspace manifest", () => {
  const root = fixture();
  writeFileSync(join(root, "packages/contracts/package.json"), "{not-json\n");
  const context = createContext(root);
  checkWorkspaceImports(context);
  expect(context.violations[0]).toContain(
    "packages/contracts/package.json: invalid workspace manifest:",
  );
});

test("rejects an unresolved workspace import", () => {
  const root = fixture();
  writeFileSync(
    join(root, "packages/contracts/index.ts"),
    'export type { Missing } from "./missing";\n',
  );
  const context = createContext(root);
  checkWorkspaceImports(context);
  expect(context.violations).toContain(
    "packages/contracts/index.ts: internal import `./missing` does not resolve",
  );
});

test("accepts a declared generated runtime export when its source target exists", () => {
  const root = fixture();
  mkdirSync(join(root, "packages/contracts/scripts"), { recursive: true });
  mkdirSync(join(root, "packages/contracts/src"), { recursive: true });
  writeFileSync(
    join(root, "packages/contracts/package.json"),
    JSON.stringify({
      name: "@autograph/contracts",
      exports: {
        "./runtime": {
          source: "./src/runtime.ts",
          default: "./dist/runtime.mjs",
        },
      },
    }),
  );
  writeFileSync(join(root, "packages/contracts/src/runtime.ts"), "export const runtime = true;\n");
  writeFileSync(
    join(root, "packages/contracts/scripts/cli.mjs"),
    'import { runtime } from "../dist/runtime.mjs";\nvoid runtime;\n',
  );

  const context = createContext(root);
  checkWorkspaceImports(context);

  expect(context.violations).toEqual([]);
});

test("rejects a generated runtime export without a resolvable source target", () => {
  const root = fixture();
  mkdirSync(join(root, "packages/contracts/scripts"), { recursive: true });
  writeFileSync(
    join(root, "packages/contracts/package.json"),
    JSON.stringify({
      name: "@autograph/contracts",
      exports: {
        "./runtime": {
          source: "./src/missing.ts",
          default: "./dist/runtime.mjs",
        },
      },
    }),
  );
  writeFileSync(
    join(root, "packages/contracts/scripts/cli.mjs"),
    'import { runtime } from "../dist/runtime.mjs";\nvoid runtime;\n',
  );

  const context = createContext(root);
  checkWorkspaceImports(context);

  expect(context.violations).toContain(
    "packages/contracts/scripts/cli.mjs: internal import `../dist/runtime.mjs` does not resolve",
  );
});

test("CSV workspace accepts public composition and rejects private and domain coupling", () => {
  const root = fixture();
  for (const directory of [
    "packages/csv-workspace",
    "apps/consumer",
    "packages/domain-libs/laboratory",
  ])
    mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(
    join(root, "packages/csv-workspace/package.json"),
    JSON.stringify({
      name: "@autograph/csv-workspace",
      exports: { ".": "./index.ts", "./server": "./server.ts" },
    }),
  );
  writeFileSync(join(root, "packages/csv-workspace/index.ts"), "export const Workspace = true;");
  writeFileSync(join(root, "packages/csv-workspace/server.ts"), "export const install = true;");
  writeFileSync(
    join(root, "packages/domain-libs/laboratory/index.ts"),
    "export const model = true;",
  );
  const consumer = join(root, "apps/consumer/index.ts");
  writeFileSync(
    consumer,
    'import { Workspace } from "@autograph/csv-workspace"; import { install } from "@autograph/csv-workspace/server";',
  );
  const valid = createContext(root);
  checkWorkspaceImports(valid);
  expect(valid.violations).toEqual([]);
  writeFileSync(consumer, 'import { install } from "../../packages/csv-workspace/server";');
  writeFileSync(
    join(root, "packages/csv-workspace/server.ts"),
    'import { model } from "../domain-libs/laboratory"; export const install = model;',
  );
  const invalid = createContext(root);
  checkWorkspaceImports(invalid);
  expect(invalid.violations).toHaveLength(2);
  expect(invalid.violations.some((value) => value.includes("public client or server export"))).toBe(
    true,
  );
  expect(
    invalid.violations.some((value) => value.includes("receives domain and app context")),
  ).toBe(true);
});
