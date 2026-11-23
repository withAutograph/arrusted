import tailwindcss from "@tailwindcss/vite";
import type { StorybookConfig } from "@storybook/react-vite";
import { mergeConfig } from "vite";

const config: StorybookConfig = {
  stories: [
    "../packages/design-systems/core/stories/**/*.stories.@(ts|tsx)",
    "../packages/dashboard-agent-evals/**/*.stories.@(ts|tsx)",
    "../packages/modules/**/*.stories.@(ts|tsx)",
    "../packages/canvas/**/*.stories.@(ts|tsx)",
  ],
  addons: [],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  core: {
    disableTelemetry: true,
  },
  async viteFinal(viteConfig) {
    return mergeConfig(viteConfig, {
      plugins: [tailwindcss()],
      resolve: {
        dedupe: ["react", "react-dom"],
        tsconfigPaths: true,
      },
      server: {
        watch: {
          ignored: ["**/.next/**", "**/storybook-static/**", "**/.scratch/**", "**/.obsidian/**"],
        },
      },
    });
  },
};

export default config;
