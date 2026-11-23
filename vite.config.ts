import { reactDoctorLintDefaults, typeAwareLintOptions } from "@autograph/vite-config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: {
    ...reactDoctorLintDefaults(),
    options: typeAwareLintOptions(),
  },
});
