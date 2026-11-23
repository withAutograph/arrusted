import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PlopTypes } from "@turbo/gen";
import { describe, expect, test } from "vite-plus/test";

import generator from "../config";

type PackageAnswers = PlopTypes.Answers & {
  packagePath: string;
  packageKind: "source" | "built";
  isBuiltPackage?: boolean;
  packageName?: string;
};

function packageActions(): PlopTypes.ActionType[] {
  let actions: PlopTypes.ActionType[] | undefined;
  generator({
    setGenerator(name: string, config: { actions: PlopTypes.ActionType[] }) {
      if (name === "package") actions = config.actions;
    },
  } as PlopTypes.NodePlopAPI);
  if (!actions) throw new Error("Package generator was not registered.");
  return actions;
}

function renderShape(template: string, answers: PackageAnswers): string {
  return template
    .replace(
      /\{\{#if isBuiltPackage\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/gu,
      (_, built, source) => (answers.isBuiltPackage ? built : (source ?? "")),
    )
    .replace(/\{\{\s*packageName\s*\}\}/gu, answers.packageName ?? "");
}

const templateRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../templates/package",
);
const repositoryRoot = path.resolve(templateRoot, "../../../../..");

function run(command: string, args: string[], cwd: string, env = process.env): string {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

describe("package generator shapes", () => {
  test.each(["source", "built"] as const)("generates the %s package contract", (kind) => {
    const actions = packageActions();
    const sanitize = actions[0];
    if (typeof sanitize !== "function") throw new Error("Missing package answer action.");
    const answers: PackageAnswers = {
      packagePath: `package-generator-${kind}-fixture`,
      packageKind: kind,
    };
    sanitize(answers, {} as PlopTypes.CustomActionConfig<string>, {} as PlopTypes.NodePlopAPI);

    const manifest = JSON.parse(
      renderShape(readFileSync(path.join(templateRoot, "package.json.hbs"), "utf8"), answers),
    ) as {
      name: string;
      exports: Record<string, unknown>;
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
      files?: string[];
    };
    const viteConfig = renderShape(
      readFileSync(path.join(templateRoot, "vite.config.ts.hbs"), "utf8"),
      answers,
    );
    const buildConfig = actions.find(
      (action): action is PlopTypes.AddActionConfig =>
        typeof action === "object" && action.type === "add",
    );

    expect(manifest.name).toBe(`@autograph/${answers.packagePath}`);
    expect(manifest.scripts.check).toBe("tsc -p tsconfig.json --noEmit");
    expect(manifest.scripts.test).toContain("vp test");
    expect(manifest.devDependencies).toEqual({
      "@types/node": "catalog:",
      typescript: "catalog:",
      "vite-plus": "catalog:",
    });
    if (kind === "built") {
      expect(buildConfig?.skip?.(answers)).toBe(false);
    } else {
      expect(typeof buildConfig?.skip?.(answers)).toBe("string");
    }

    if (kind === "source") {
      expect(manifest.exports["."]).toBe("./index.ts");
      expect(manifest.scripts.build).toBeUndefined();
      expect(manifest.files).toBeUndefined();
      expect(viteConfig).not.toContain("build:");
    } else {
      expect(manifest.exports["."]).toEqual({
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      });
      expect(manifest.scripts.build).toContain("tsc -p tsconfig.build.json");
      expect(manifest.files).toEqual(["dist"]);
      expect(viteConfig).toContain("build:");
      expect(readFileSync(path.join(templateRoot, "tsconfig.build.json.hbs"), "utf8")).toContain(
        '"emitDeclarationOnly": true',
      );
    }
  });

  test("Bun packs a built package with resolved catalog versions for an isolated consumer", () => {
    const actions = packageActions();
    const sanitize = actions[0];
    if (typeof sanitize !== "function") throw new Error("Missing package answer action.");
    const answers: PackageAnswers = {
      packagePath: "package-generator-pack-fixture",
      packageKind: "built",
    };
    sanitize(answers, {} as PlopTypes.CustomActionConfig<string>, {} as PlopTypes.NodePlopAPI);

    const fixtureRoot = mkdtempSync(path.join(tmpdir(), "package-generator-pack-"));
    try {
      const packageRoot = path.join(fixtureRoot, "packages", "proof");
      const outputRoot = path.join(fixtureRoot, "output");
      const consumerRoot = path.join(fixtureRoot, "consumer");
      mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
      mkdirSync(outputRoot);
      mkdirSync(consumerRoot);
      const catalog = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"))
        .catalog as Record<string, string>;
      writeFileSync(
        path.join(fixtureRoot, "package.json"),
        `${JSON.stringify({
          name: "package-generator-pack-proof-root",
          private: true,
          workspaces: ["packages/*"],
          catalog: {
            "@types/node": catalog["@types/node"],
            typescript: catalog.typescript,
            "vite-plus": catalog["vite-plus"],
          },
        })}\n`,
      );
      copyFileSync(path.join(repositoryRoot, "bun.lock"), path.join(fixtureRoot, "bun.lock"));
      writeFileSync(
        path.join(packageRoot, "package.json"),
        renderShape(readFileSync(path.join(templateRoot, "package.json.hbs"), "utf8"), answers),
      );
      writeFileSync(path.join(packageRoot, "dist", "index.js"), 'export const proof = "packed";\n');
      writeFileSync(
        path.join(packageRoot, "dist", "index.d.ts"),
        'export declare const proof: "packed";\n',
      );

      run("bun", ["pm", "pack", "--destination", outputRoot], packageRoot);
      const tarball = path.join(
        outputRoot,
        readdirSync(outputRoot).find((file) => file.endsWith(".tgz")) ?? "missing.tgz",
      );
      const packedManifest = JSON.parse(
        run("tar", ["-xOzf", tarball, "package/package.json"], fixtureRoot),
      ) as { devDependencies: Record<string, string> };
      expect(JSON.stringify(packedManifest)).not.toContain("catalog:");
      expect(packedManifest.devDependencies).toEqual({
        "@types/node": catalog["@types/node"],
        typescript: catalog.typescript,
        "vite-plus": catalog["vite-plus"],
      });

      writeFileSync(path.join(consumerRoot, "package.json"), '{"private":true,"type":"module"}\n');
      run("npm", ["install", "--offline", "--no-save", "--ignore-scripts", tarball], consumerRoot, {
        ...process.env,
        npm_config_cache: path.join(fixtureRoot, "npm-cache"),
      });
      expect(
        run(
          "node",
          [
            "--input-type=module",
            "-e",
            `import { proof } from "${answers.packageName}"; console.log(proof);`,
          ],
          consumerRoot,
        ).trim(),
      ).toBe("packed");
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
