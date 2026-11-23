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
      path.join(repoRoot, "packages/canvas/**/*.test.{ts,tsx}"),
      // Shared parts the canvas composes that no other package tests.
      path.join(repoRoot, "packages/design-systems/core/compositions/__tests__/*.test.{ts,tsx}"),
      path.join(repoRoot, "packages/modules/agent-chat/**/*.test.{ts,tsx}"),
    ],
    setupFiles: [path.join(repoRoot, "packages/canvas/test-setup.ts")],
    pool: "threads",
    maxWorkers: 3,
    testTimeout: 15_000,
  }),
});
