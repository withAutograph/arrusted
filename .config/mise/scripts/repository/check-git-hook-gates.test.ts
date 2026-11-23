import { describe, expect, test } from "vitest";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateGitHookGates } from "./check-git-hook-gates";

const config = readFileSync(
  fileURLToPath(new URL("../../../../.config/hk.pkl", import.meta.url)),
  "utf8",
);
const miseConfig = readFileSync(
  fileURLToPath(new URL("../../../../.config/mise/config.toml", import.meta.url)),
  "utf8",
);
const rustWrapper = readFileSync(
  fileURLToPath(new URL("run-affected-rust-validation.sh", import.meta.url)),
  "utf8",
);
const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const cleanShellEnvironment: NodeJS.ProcessEnv = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        entry[0] !== "BASH_ENV" &&
        !entry[0].startsWith("BASH_FUNC_mise") &&
        !entry[0].startsWith("GIT_"),
    ),
  ),
  NODE_ENV: process.env.NODE_ENV ?? "test",
};

function assertAffectedRustWrapperContract(source: string): void {
  const fixture = mkdtempSync(join(tmpdir(), "rust-validation-wrapper-"));
  try {
    const wrapper = join(fixture, "run-affected-rust-validation.sh");
    const mockMise = join(fixture, "mise");
    const log = join(fixture, "mise.log");
    writeFileSync(wrapper, source);
    writeFileSync(
      mockMise,
      [
        "#!/bin/sh",
        `printf '%s|%s|%s|%s\\n' "$TURBO_SCM_BASE" "$TURBO_SCM_HEAD" "$*" "\${GIT_DIR-unset}" >>"$RUST_WRAPPER_LOG"`,
        "",
      ].join("\n"),
    );
    chmodSync(wrapper, 0o755);
    chmodSync(mockMise, 0o755);
    const result = spawnSync("/bin/bash", [wrapper], {
      cwd: repositoryRoot,
      env: {
        ...cleanShellEnvironment,
        RUST_WRAPPER_LOG: log,
        HK_PR_BASE_REF: "origin/contract-base",
        PATH: `${fixture}${delimiter}${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`affected Rust wrapper failed: ${result.stderr}`);
    }
    if (!existsSync(log)) {
      throw new Error("affected Rust wrapper did not invoke mise");
    }
    expect(readFileSync(log, "utf8")).toBe(
      "origin/contract-base|HEAD|exec -- turbo run check lint --affected|unset\n",
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

function actionlintWorkflow(source: string): {
  output: string;
  status: number | null;
} {
  const fixture = mkdtempSync(join(tmpdir(), "actionlint-workflow-"));
  try {
    const workflow = join(fixture, "workflow.yml");
    writeFileSync(workflow, source);
    const result = spawnSync("mise", ["exec", "--no-deps", "--", "actionlint", workflow], {
      cwd: repositoryRoot,
      env: cleanShellEnvironment,
      encoding: "utf8",
    });
    return {
      output: `${String(result.stdout ?? "")}${String(result.stderr ?? "")}`,
      status: result.status,
    };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

describe("git hook gate topology", () => {
  test.each([
    [
      "workflow env dot syntax",
      [
        "name: Invalid workflow env",
        "on: [push]",
        "env:",
        "  RECEIPT_PATH: ${{ runner.temp }}/receipt.json",
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: echo invalid",
      ].join("\n"),
    ],
    [
      "job env bracket syntax",
      [
        "name: Invalid job env",
        "on: [push]",
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    env:",
        "      RECEIPT_PATH: \"${{ runner['temp'] }}/receipt.json\"",
        "    steps:",
        "      - run: echo invalid",
      ].join("\n"),
    ],
  ])("rejects runner context in %s through pinned actionlint", (_label, source) => {
    const result = actionlintWorkflow(source);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('context "runner" is not allowed');
  });

  test("allows runner context in step env through pinned actionlint", () => {
    const result = actionlintWorkflow(
      [
        "name: Valid step env",
        "on: [push]",
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - env:",
        "          RECEIPT_PATH: ${{ runner.temp }}/receipt.json",
        "        run: echo valid",
      ].join("\n"),
    );
    expect(result.status, result.output).toBe(0);
  });

  test("exposes Rust Clippy autofixes only through the hk fix hook", () => {
    expect(config).toContain(
      'check = "cargo clippy --workspace --all-targets --features kernel/testing -- -D warnings"',
    );
    expect(config).toContain(
      'fix = "cargo clippy --workspace --all-targets --features kernel/testing --fix --allow-dirty --allow-staged -- -D warnings"',
    );
    expect(config).toContain('      ...kernelLint\n    }\n  }\n  ["pre-commit"]');
    expect(config).not.toMatch(/\["pre-commit"\][\s\S]*?\.\.\.kernelLint/u);
    expect(config).not.toMatch(/\["check"\][\s\S]*?\.\.\.kernelLint/u);
    expect(config).not.toContain("--broken-code");
    expect(config).not.toContain("--fix-suggestions");
    expect(config).not.toContain("--fix-dangerously");
  });

  test("accepts the repository hook split", () => {
    expect(() => validateGitHookGates(config)).not.toThrow();
  });

  test("fails closed when pre-commit loses affected type checks", () => {
    const weakened = config.replace("      ...types\n", "");
    expect(() => validateGitHookGates(weakened)).toThrow("pre-commit must include types");
  });

  test.each([
    ["comment", "      // ...types"],
    ["string", '      local decoy = "...types"'],
  ])("rejects a required mapping found only in a %s", (_label, decoy) => {
    const weakened = config.replace("      ...types", decoy);
    expect(() => validateGitHookGates(weakened)).toThrow("pre-commit must include types");
  });

  test("keeps transport-blocking checks out of pre-push", () => {
    const prePush = config.indexOf('["pre-push"] {');
    for (const mapping of ["affectedRustCheck", "exhaustiveCheck", "tests"]) {
      const weakened = `${config.slice(0, prePush)}${config
        .slice(prePush)
        .replace("      ...types\n", `      ...types\n      ...${mapping}\n`)}`;
      expect(() => validateGitHookGates(weakened)).toThrow(
        `pre-push must not include transport-blocking ${mapping}`,
      );
    }
  });

  test("executes affected Rust validation with the exact Turbo closure", () => {
    expect(() => assertAffectedRustWrapperContract(rustWrapper)).not.toThrow();
  });

  test.each([
    [
      "exits before validation",
      rustWrapper.replace(
        "mise exec -- turbo run check lint --affected",
        "exit 0\nmise exec -- turbo run check lint --affected",
      ),
    ],
  ])("rejects a wrapper that %s", (_label, weakened) => {
    expect(() => assertAffectedRustWrapperContract(weakened)).toThrow();
  });

  test("fails closed when the wrapper leaves the hook gate trigger", () => {
    const weakened = config.replace(
      'glob = "{.config/hk.pkl,.config/mise/scripts/repository/check-git-hook-gates.{ts,test.ts},.config/mise/scripts/repository/run-affected-rust-validation.sh}"',
      'glob = "{.config/hk.pkl,.config/mise/scripts/repository/check-git-hook-gates.{ts,test.ts}}"',
    );
    expect(() => validateGitHookGates(weakened)).toThrow(
      "trigger when the affected Rust wrapper changes",
    );
  });

  test("fails closed when the GitHub Actions gate bypasses pinned mise actionlint", () => {
    const weakened = config.replace('check = "mise exec -- actionlint"', 'check = "actionlint"');
    expect(() => validateGitHookGates(weakened)).toThrow("run pinned actionlint through mise");
  });

  test("fails closed when workflows leave the GitHub Actions gate", () => {
    const weakened = config.replace(".github/workflows/**/*.{yml,yaml},", "");
    expect(() => validateGitHookGates(weakened)).toThrow(
      "cover workflows, local actions, and its owning contracts",
    );
  });

  test("fails closed when local actions leave the GitHub Actions gate", () => {
    const weakened = config.replace(".github/actions/**/*.{yml,yaml},", "");
    expect(() => validateGitHookGates(weakened)).toThrow(
      "cover workflows, local actions, and its owning contracts",
    );
  });

  test("keeps exhaustive Rust validation out of pre-push", () => {
    const prePush = config.indexOf('["pre-push"] {');
    const weakened =
      config.slice(0, prePush) +
      config.slice(prePush).replace("      ...types\n", "      ...rustCheck\n      ...types\n");
    expect(() => validateGitHookGates(weakened)).toThrow(
      "pre-push must not include transport-blocking rustCheck",
    );
  });

  test("fails closed when affected Konsistent checks omit module extensions", () => {
    const weakened = config.replace(",mts,cts,css}", ",css}");
    expect(() => validateGitHookGates(weakened)).toThrow(
      "affected Konsistent checks must cover every supported module extension",
    );
  });

  test("fails closed when application sources leave the Konsistent gate", () => {
    const weakened = config.replace(
      "packages/**/*.{js,jsx,ts,tsx,mjs,mts,cjs,cts}",
      "packages/**/*.ts",
    );
    expect(() => validateGitHookGates(weakened)).toThrow(
      "Konsistent gate must cover all governed application and package sources",
    );
  });

  test("ignores a commented decoy when the Konsistent command is disabled", () => {
    const command = 'check = "bash .config/mise/scripts/repository/check-konsistent-affected.sh {{ files }}"';
    const weakened = config.replace(command, `check = "true"\n    // ${command}`);
    expect(() => validateGitHookGates(weakened)).toThrow(
      "Konsistent gate must cover all governed application and package sources",
    );
  });
});
