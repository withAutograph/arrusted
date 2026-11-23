import path from "node:path";
import {
  nodeTestDefaults,
  resolveWithTsconfigPaths,
  typeAwareLintOptions,
  workspaceRoots,
} from "@autograph/vite-config";
import { defineConfig } from "vite-plus";

const { packageRoot: domainLibsRoot } = workspaceRoots(import.meta.url, "..");

export default defineConfig({
  root: domainLibsRoot,
  resolve: resolveWithTsconfigPaths(),
  lint: {
    options: typeAwareLintOptions(),
  },
  test: nodeTestDefaults({
    include: [path.join(domainLibsRoot, "*/__tests__/**/*.test.ts")],
  }),
});
