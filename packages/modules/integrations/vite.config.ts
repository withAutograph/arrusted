import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(packageRoot, "../../..");

export default defineConfig({
  lint: { options: { typeAware: true, typeCheck: true } },
  resolve: {
    alias: {
      "@autograph/components": path.join(
        repoRoot,
        "packages/design-systems/core/components/index.ts",
      ),
    },
  },
  test: {
    environment: "jsdom",
    restoreMocks: true,
    include: [path.join(packageRoot, "__tests__/**/*.test.{ts,tsx}")],
    setupFiles: [path.join(packageRoot, "test-setup.ts")],
  },
});
