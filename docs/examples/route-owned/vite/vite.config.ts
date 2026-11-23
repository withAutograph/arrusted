import path from "node:path";
import { microfrontends } from "@vercel/microfrontends/experimental/vite";
import {
  jsdomTestDefaults,
  lintDefaults,
  reactPlugins,
  resolveWithTsconfigPaths,
  workspaceRoots,
} from "@autograph/vite-config";
import { defineConfig } from "vite-plus";

const { packageRoot: appRoot, repoRoot } = workspaceRoots(import.meta.url, "../../../..");

export default defineConfig({
  root: path.join(appRoot, "frontend"),
  envDir: repoRoot,
  plugins: [...reactPlugins(), microfrontends()],
  resolve: resolveWithTsconfigPaths(),
  lint: lintDefaults(),
  server: {
    host: "127.0.0.1",
    strictPort: true,
    fs: { allow: [repoRoot] },
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3001",
      },
    },
  },
  test: jsdomTestDefaults({
    include: ["src/**/__tests__/**/*.test.{ts,tsx}"],
    setupFiles: ["src/__tests__/setup.ts"],
  }),
  build: {
    sourcemap: true,
  },
});
