import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: packageRoot,
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: [path.join(packageRoot, "__tests__/**/*.test.ts")],
  },
});
