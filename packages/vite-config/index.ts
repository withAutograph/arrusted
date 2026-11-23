import { reactDoctorLintDefaults } from "@autograph/oxlint-config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { configDefaults } from "vitest/config";
import type { UserConfig } from "vite-plus";

export function workspaceRoots(metaUrl: string, repoRootRelativePath = "../..") {
  const packageRoot = path.dirname(fileURLToPath(metaUrl));

  return {
    packageRoot,
    repoRoot: path.resolve(packageRoot, repoRootRelativePath),
  };
}

export function resolveWithTsconfigPaths() {
  return {
    tsconfigPaths: true,
  };
}

export function serverOnlyTestAlias() {
  return {
    "server-only": new URL("./server-only-test-stub.js", import.meta.url).pathname,
  };
}

export function nextAppVitestConfig() {
  return {
    plugins: reactPlugins(),
    resolve: {
      ...resolveWithTsconfigPaths(),
      alias: serverOnlyTestAlias(),
    },
    test: {
      ...jsdomTestDefaults({
        exclude: ["**/tests/e2e/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
      }),
    },
  } satisfies UserConfig;
}

export function generatedClientFmtDefaults(clientName: string): UserConfig["fmt"] {
  return {
    ignorePatterns: [`generated/${clientName}.js`, `generated/${clientName}.ts`],
  };
}

export function typeAwareLintOptions() {
  return {
    typeAware: true,
    typeCheck: true,
  } as const;
}

export function lintDefaults(): UserConfig["lint"] {
  return {
    plugins: ["eslint", "unicorn", "typescript", "oxc", "react"],
    ...reactDoctorLintDefaults(),
    options: typeAwareLintOptions(),
    rules: {
      "react/react-compiler": "error",
      ...reactDoctorLintDefaults().rules,
    },
  };
}

export function reactPlugins(options: { tailwind?: boolean } = {}) {
  return [react(), ...(options.tailwind === true ? [tailwindcss()] : [])];
}

export function jsdomTestDefaults(options: UserConfig["test"] = {}) {
  const { exclude, ...testOptions } = options ?? {};

  return {
    environment: "jsdom",
    restoreMocks: true,
    ...testOptions,
    ...(options?.include === undefined && exclude === undefined
      ? {}
      : { exclude: [...configDefaults.exclude, ...(exclude ?? [])] }),
  } satisfies UserConfig["test"];
}

export function nodeTestDefaults(options: { include: string[] }) {
  return {
    environment: "node",
    include: options.include,
  };
}

export { reactDoctorLintDefaults };
