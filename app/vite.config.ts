import { defineConfig } from "vite-plus";
export default defineConfig({
  test: {
    include: [
      "app/scripts/migrate.test.ts",
      "app/scripts/core-upgrade.test.ts",
      "app/scripts/schema-changes.test.ts",
      "app/scripts/records-import.test.ts",
    ],
    fileParallelism: false,
    testTimeout: 120000,
    hookTimeout: 240000,
  },
});
