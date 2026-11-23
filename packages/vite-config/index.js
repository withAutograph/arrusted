import { reactDoctorLintDefaults } from "@autograph/oxlint-config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { configDefaults } from "vitest/config";
export function workspaceRoots(metaUrl, repoRootRelativePath = "../..") {
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
  };
}
export function generatedClientFmtDefaults(clientName) {
  return {
    ignorePatterns: [`generated/${clientName}.js`, `generated/${clientName}.ts`],
  };
}
export function typeAwareLintOptions() {
  return {
    typeAware: true,
    typeCheck: true,
  };
}
export function lintDefaults() {
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
export function reactPlugins(options = {}) {
  return [react(), ...(options.tailwind === true ? [tailwindcss()] : [])];
}
export function jsdomTestDefaults(options = {}) {
  const { exclude, ...testOptions } = options ?? {};
  return {
    environment: "jsdom",
    restoreMocks: true,
    ...testOptions,
    ...(options?.include === undefined && exclude === undefined
      ? {}
      : { exclude: [...configDefaults.exclude, ...(exclude ?? [])] }),
  };
}
export function nodeTestDefaults(options) {
  return {
    environment: "node",
    include: options.include,
  };
}
export { reactDoctorLintDefaults };
