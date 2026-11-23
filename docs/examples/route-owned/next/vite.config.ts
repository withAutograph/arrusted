import { jsdomTestDefaults, reactPlugins, resolveWithTsconfigPaths } from "@autograph/vite-config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: reactPlugins(),
  resolve: resolveWithTsconfigPaths(),
  test: jsdomTestDefaults({
    include: ["app/**/__tests__/**/*.test.{ts,tsx}"],
    setupFiles: ["app/__tests__/setup.ts"],
  }),
});
