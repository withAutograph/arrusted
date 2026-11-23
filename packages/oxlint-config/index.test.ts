import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { advisoryReactDoctorConfig, nextAppOxlintDefaults, reactDoctorLintDefaults } from "./index";

describe("Oxlint config helpers", () => {
  it("composes Next presets and preserves app-owned ignore patterns", () => {
    const config = nextAppOxlintDefaults({ ignorePatterns: ["custom/generated/**"] });

    expect(config.extends).toHaveLength(5);
    expect(config.ignorePatterns).toContain("schema/index.ts");
    expect(config.ignorePatterns).toContain("schema/release/**");
    expect(config.ignorePatterns).toContain("custom/generated/**");
    expect(config.jsPlugins).toBeDefined();
    expect(config.settings).toBeDefined();
    expect(config.options.typeAware).toBe(true);
  });

  it("preserves disabled rules, rule options, and other lint severities in overrides", () => {
    const config = advisoryReactDoctorConfig({
      rules: { "react-doctor/example": ["error", { option: true }], "no-debugger": "error" },
      overrides: [{ files: ["*.tsx"], rules: { "react-doctor/example": [0, { option: false }] } }],
    });
    expect(config.rules["react-doctor/example"]).toEqual(["warn", { option: true }]);
    expect(config.rules["no-debugger"]).toBe("error");
    expect(config.overrides[0]?.rules["react-doctor/example"]).toEqual([0, { option: false }]);
  });

  it("keeps Doctor findings advisory while ordinary lint errors fail", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "doctor-lint-"));
    try {
      const require = createRequire(import.meta.url);
      const config = reactDoctorLintDefaults({ next: true });
      const configPath = path.join(directory, "vite.config.ts");
      writeFileSync(
        path.join(directory, "package.json"),
        JSON.stringify({ name: "doctor-lint-fixture", private: true, type: "module" }),
      );
      writeFileSync(
        configPath,
        "export default " +
          JSON.stringify({
            lint: {
              jsPlugins: [
                { name: "react-doctor", specifier: require.resolve("oxlint-plugin-react-doctor") },
              ],
              rules: { ...config.rules, "no-debugger": "error" },
            },
          }),
      );
      const source = path.join(directory, "Component.tsx");
      writeFileSync(
        source,
        'export function Component() { return <img src="/photo.png" alt="photo" />; }',
      );
      const environment = { ...process.env };
      delete environment.INIT_CWD;
      delete environment.npm_config_local_prefix;
      delete environment.npm_package_json;
      delete environment.npm_package_name;
      const lint = () =>
        spawnSync(
          path.resolve(import.meta.dirname, "../../node_modules/.bin/vp"),
          ["lint", "--no-ignore", "--threads", "1", source],
          { cwd: directory, env: environment, encoding: "utf8", timeout: 8_000 },
        );
      const advisory = lint();
      expect(advisory.status, advisory.stdout + advisory.stderr).toBe(0);
      expect(advisory.stdout + advisory.stderr).toContain("nextjs-no-img-element");
      writeFileSync(source, "debugger; export const value = 1;");
      const failure = lint();
      expect(failure.status).toBe(1);
      expect(failure.stdout + failure.stderr).toContain("no-debugger");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
