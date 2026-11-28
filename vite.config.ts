import { reactDoctorLintDefaults, typeAwareLintOptions } from "@autograph/vite-config";
import { defineConfig } from "vite-plus";
import { configDefaults } from "vitest/config";

export default defineConfig({
  lint: {
    ...reactDoctorLintDefaults(),
    options: typeAwareLintOptions(),
  },
  test: {
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
});
