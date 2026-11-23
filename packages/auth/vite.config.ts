import path from "node:path";

import { jsdomTestDefaults, workspaceRoots } from "@autograph/vite-config";
import { defineConfig } from "vite-plus";

const { packageRoot } = workspaceRoots(import.meta.url);

export default defineConfig({
  test: jsdomTestDefaults({
    include: [path.join(packageRoot, "__tests__/**/*.test.{ts,tsx}")],
    setupFiles: [path.join(packageRoot, "test-setup.ts")],
  }),
});
