import path from "node:path";
import { fileURLToPath } from "node:url";
import { jsdomTestDefaults, lintDefaults, reactPlugins } from "@autograph/vite-config";
import { defineConfig } from "vite-plus";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: packageRoot,
  plugins: reactPlugins(),
  lint: lintDefaults(),
  resolve: {
    tsconfigPaths: true,
  },
  test: jsdomTestDefaults({
    include: [path.join(packageRoot, "__tests__/**/*.test.{ts,tsx}")],
  }),
});
