import path from "node:path";
import { nodeTestDefaults, resolveWithTsconfigPaths, workspaceRoots } from "@autograph/vite-config";
import { defineConfig } from "vite-plus";
const { packageRoot } = workspaceRoots(import.meta.url);
export default defineConfig({
  root: packageRoot,
  resolve: resolveWithTsconfigPaths(),
  test: {
    ...nodeTestDefaults({ include: [path.join(packageRoot, "__tests__/**/*.test.ts")] }),
    testTimeout: 30_000,
  },
});
