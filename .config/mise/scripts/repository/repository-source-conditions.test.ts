/// <reference types="node" />
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vite-plus/test";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../..");
const implementations = ".config/mise/scripts/repository";
const program = `import { value } from "@fixture/live-package";
import { spawnSync } from "node:child_process";
const child = spawnSync("bun", ["${implementations}/child.ts"], {
  cwd: process.cwd(), env: process.env, encoding: "utf8",
});
if (child.status !== 0) {
  process.stderr.write(child.stderr);
  process.exit(child.status ?? 1);
}
console.log(JSON.stringify({ parent: value, child: JSON.parse(child.stdout).value }));
`;

test.each(["repository:exec"])(
  "%s selects current source before startup and in child Bun processes without dist artifacts",
  () => {
    const root = mkdtempSync(path.join(tmpdir(), "repository-source-conditions-"));
    const binaryRoot = path.join(root, "bin");
    const packageRoot = path.join(root, "packages/live-package");
    const source = path.join(packageRoot, "source.ts");
    const implementationRoot = path.join(root, implementations);
    mkdirSync(binaryRoot, { recursive: true });
    mkdirSync(packageRoot, { recursive: true });
    mkdirSync(implementationRoot, { recursive: true });
    mkdirSync(path.join(root, "node_modules/@fixture"), { recursive: true });
    writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@fixture/live-package",
        type: "module",
        exports: {
          ".": {
            source: { "fixture-parent": "./source.ts", default: "./dist/caller-option-missing.js" },
            default: "./dist/index.js",
          },
        },
      }),
    );
    symlinkSync(packageRoot, path.join(root, "node_modules/@fixture/live-package"));
    writeFileSync(source, 'export const value = "initial-source";\n');
    for (const name of ["repository-probe.ts"]) {
      writeFileSync(path.join(implementationRoot, name), program);
    }
    writeFileSync(
      path.join(implementationRoot, "child.ts"),
      'import { value } from "@fixture/live-package"; console.log(JSON.stringify({ value }));\n',
    );
    const mise = path.join(binaryRoot, "mise");
    // Keep the real repository task's exec boundary, without installing tools or
    // evaluating unrelated local configuration in this controlled fixture.
    writeFileSync(
      mise,
      '#!/usr/bin/env bash\nset -eu\n[ "$1" = exec ]\nshift\n[ "$1" = -- ]\nshift\nexec "$@"\n',
    );
    chmodSync(mise, 0o700);
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${binaryRoot}:${process.env.PATH ?? ""}`,
      MISE_MONOREPO_ROOT: root,
      MISE_PROJECT_ROOT: root,
    };
    environment.BUN_OPTIONS = "--conditions=fixture-parent";
    const entry = "repository-probe.ts";
    try {
      expect(existsSync(path.join(packageRoot, "dist/index.js"))).toBe(false);
      const ordinary = spawnSync("bun", [path.join(implementationRoot, entry)], {
        cwd: root,
        env: environment,
        encoding: "utf8",
      });
      expect(ordinary.status).not.toBe(0);
      const command = [
        path.join(repositoryRoot, ".config/mise/tasks/repository/exec"),
        "repository-probe.ts",
      ];
      const run = () =>
        spawnSync("bash", command, { cwd: root, env: environment, encoding: "utf8" });
      const initial = run();
      expect(initial.status, initial.stderr).toBe(0);
      expect(JSON.parse(initial.stdout)).toEqual({
        parent: "initial-source",
        child: "initial-source",
      });
      writeFileSync(source, 'export const value = "edited-source";\n');
      const edited = run();
      expect(edited.status, edited.stderr).toBe(0);
      expect(JSON.parse(edited.stdout)).toEqual({
        parent: "edited-source",
        child: "edited-source",
      });
      expect(existsSync(path.join(packageRoot, "dist/index.js"))).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test("Turbo strict check and test retain source resolution and private toolchain paths", () => {
  const root = mkdtempSync(path.join(tmpdir(), "turbo-source-conditions-"));
  const packageRoot = path.join(root, "packages/live-package");
  const appRoot = path.join(root, "packages/consumer");
  const source = path.join(packageRoot, "source.ts");
  const child = path.join(appRoot, "child.ts");
  const repositoryConfig = JSON.parse(
    readFileSync(path.join(repositoryRoot, "turbo.json"), "utf8"),
  );
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(appRoot, { recursive: true });
  mkdirSync(path.join(root, "node_modules/@fixture"), { recursive: true });
  const writeJson = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value));
  writeJson(path.join(root, "package.json"), {
    name: "turbo-source-condition-fixture",
    private: true,
    packageManager: "bun@1.3.14",
    workspaces: ["packages/*"],
  });
  writeJson(path.join(packageRoot, "package.json"), {
    name: "@fixture/live-package",
    version: "1.0.0",
    type: "module",
    exports: {
      ".": {
        source: { "fixture-parent": "./source.ts", default: "./dist/caller-option-missing.js" },
        default: "./dist/index.js",
      },
    },
  });
  writeJson(path.join(appRoot, "package.json"), {
    name: "@fixture/consumer",
    version: "1.0.0",
    scripts: { check: "bun check.ts", test: "bun check.ts" },
    dependencies: { "@fixture/live-package": "workspace:*" },
  });
  writeJson(path.join(root, "turbo.json"), {
    globalEnv: repositoryConfig.globalEnv,
    globalPassThroughEnv: repositoryConfig.globalPassThroughEnv,
    tasks: {
      check: { cache: false, passThroughEnv: repositoryConfig.tasks.check.passThroughEnv },
      test: { cache: false, passThroughEnv: repositoryConfig.tasks.test.passThroughEnv },
    },
  });
  symlinkSync(packageRoot, path.join(root, "node_modules/@fixture/live-package"));
  writeFileSync(source, 'export const value = "initial-source";\n');
  writeFileSync(
    child,
    'import { value } from "@fixture/live-package"; console.log(JSON.stringify({ value }));\n',
  );
  writeFileSync(
    path.join(appRoot, "check.ts"),
    `import { value } from "@fixture/live-package";
import { spawnSync } from "node:child_process";
const child = spawnSync("bun", ["child.ts"], { cwd: process.cwd(), env: process.env, encoding: "utf8" });
if (child.status !== 0) { process.stderr.write(child.stderr); process.exit(child.status ?? 1); }
console.log(JSON.stringify({ parent: value, child: JSON.parse(child.stdout).value }));
console.log(JSON.stringify({
  cargo: process.env.CARGO_HOME,
  miseCargo: process.env.MISE_CARGO_HOME,
  miseData: process.env.MISE_DATA_DIR,
  miseRustup: process.env.MISE_RUSTUP_HOME,
  rustup: process.env.RUSTUP_HOME,
  secret: process.env.BUILDER_FIXTURE_SECRET,
}));
`,
  );
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    BUN_OPTIONS: "--conditions=fixture-parent --conditions=source",
    TURBO_TELEMETRY_DISABLED: "1",
    TURBO_CACHE: "local:",
    CARGO_HOME: path.join(root, "cargo"),
    MISE_CARGO_HOME: path.join(root, "cargo"),
    MISE_DATA_DIR: path.join(root, "mise"),
    MISE_RUSTUP_HOME: path.join(root, "rustup"),
    RUSTUP_HOME: path.join(root, "rustup"),
    BUILDER_FIXTURE_SECRET: "synthetic-secret",
  };
  delete environment.TURBO_TOKEN;
  delete environment.TURBO_TEAM;
  try {
    for (const task of ["check", "test"]) {
      const run = () =>
        spawnSync(
          path.join(repositoryRoot, "node_modules/.bin/turbo"),
          ["run", task, "--ui=stream", "--only", "--env-mode=strict", "--filter=@fixture/consumer"],
          { cwd: root, env: environment, encoding: "utf8" },
        );
      writeFileSync(source, 'export const value = "initial-source";\n');
      const initial = run();
      expect(initial.status, initial.stderr + initial.stdout).toBe(0);
      expect(initial.stdout).toContain(
        JSON.stringify({
          cargo: environment.CARGO_HOME,
          miseCargo: environment.MISE_CARGO_HOME,
          miseData: environment.MISE_DATA_DIR,
          miseRustup: environment.MISE_RUSTUP_HOME,
          rustup: environment.RUSTUP_HOME,
        }),
      );
      expect(initial.stdout).not.toContain("synthetic-secret");
      expect(initial.stdout).toContain(
        JSON.stringify({ parent: "initial-source", child: "initial-source" }),
      );
      writeFileSync(source, 'export const value = "edited-source";\n');
      const edited = run();
      expect(edited.status, edited.stderr + edited.stdout).toBe(0);
      expect(edited.stdout).toContain(
        JSON.stringify({ parent: "edited-source", child: "edited-source" }),
      );
      expect(existsSync(path.join(packageRoot, "dist/index.js"))).toBe(false);
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
