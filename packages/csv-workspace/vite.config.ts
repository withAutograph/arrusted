import path from "node:path";

import {
  jsdomTestDefaults,
  reactPlugins,
  resolveWithTsconfigPaths,
  workspaceRoots,
} from "@autograph/vite-config";
import { defineConfig } from "vite-plus";

const { repoRoot } = workspaceRoots(import.meta.url);

export default defineConfig({
  root: repoRoot,
  plugins: reactPlugins(),
  resolve: resolveWithTsconfigPaths(),
  server: {
    fs: { allow: [repoRoot] },
  },
  test: jsdomTestDefaults({
    include: [
      path.join(repoRoot, "packages/csv-workspace/**/*.test.{ts,tsx}"),
      path.join(repoRoot, "packages/agent-foundation/artifact-compute/**/*.test.{ts,tsx}"),
      path.join(repoRoot, "packages/modules/source-import/**/*.test.{ts,tsx}"),
      path.join(repoRoot, "packages/engines/import-classification/**/*.test.{ts,tsx}"),
    ],
    setupFiles: [path.join(repoRoot, "packages/csv-workspace/test-setup.ts")],
    pool: "threads",
    maxWorkers: 3,
    testTimeout: 15_000,
  }),
});
