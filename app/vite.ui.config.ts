import { defineConfig } from "vite-plus";
import { reactPlugins, resolveWithTsconfigPaths, jsdomTestDefaults } from "@autograph/vite-config";
export default defineConfig({
  plugins: reactPlugins(),
  resolve: resolveWithTsconfigPaths(),
  test: jsdomTestDefaults({ include: ["app/features/**/*.test.tsx"] }),
});
