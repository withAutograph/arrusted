import { defineConfig } from "vite-plus";
import { reactPlugins, resolveWithTsconfigPaths, workspaceRoots } from "./vite-config";

const { repoRoot } = workspaceRoots(import.meta.url, "..");

// These shared libraries previously ran through the deleted app test suites.
export default defineConfig({
  root: repoRoot,
  plugins: reactPlugins(),
  resolve: resolveWithTsconfigPaths(),
  test: {
    environment: "jsdom",
    restoreMocks: true,
    include: [
      "packages/agent-foundation/**/*.test.{ts,tsx}",
      "packages/design-systems/**/*.test.{ts,tsx}",
      "packages/engines/**/*.test.{ts,tsx}",
      "packages/kernel-client/**/*.test.{ts,tsx}",
      "packages/modules/**/*.test.{ts,tsx}",
      "packages/protected-installer/**/*.test.{ts,tsx}",
    ],
    setupFiles: ["packages/canvas/test-setup.ts"],
    maxWorkers: 2,
  },
});
