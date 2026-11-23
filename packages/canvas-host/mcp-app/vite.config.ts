// The canvas in a chat as one self-contained HTML document: everything
// inlined, so the frame loads nothing but the app's API.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reactPlugins, resolveWithTsconfigPaths } from "@autograph/vite-config";
import { defineConfig } from "vite-plus";
import { viteSingleFile } from "vite-plugin-singlefile";

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.dirname(appRoot);

export default defineConfig({
  root: appRoot,
  resolve: resolveWithTsconfigPaths(),
  plugins: [
    ...reactPlugins({ tailwind: true }),
    viteSingleFile(),
    {
      // One document beside the package's other outputs: `dist/mcp-app.html`.
      name: "canvas-mcp-app-name",
      enforce: "post",
      generateBundle(_options, bundle) {
        const page = bundle["index.html"];
        if (page !== undefined) page.fileName = "mcp-app.html";
      },
    },
  ],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: path.join(packageRoot, "dist"),
    emptyOutDir: false,
    rollupOptions: { input: path.join(appRoot, "index.html") },
  },
});
