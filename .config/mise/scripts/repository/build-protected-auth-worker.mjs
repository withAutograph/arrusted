#!/usr/bin/env bun
import path from "node:path";
import { protectedParserAssetsPlugin } from "./protected-parser-assets.mjs";

const [outputDirectory] = process.argv.slice(2);
if (!outputDirectory) throw new Error("Expected protected Auth worker output directory");

const root = process.cwd();
const result = await Bun.build({
  entrypoints: [path.join(root, "packages/auth/protected-installer-worker.ts")],
  outdir: outputDirectory,
  target: "bun",
  plugins: [
    protectedParserAssetsPlugin(),
    {
      name: "auth-sql-assets",
      setup(build) {
        build.onResolve({ filter: /\.sql\?raw$/u }, ({ importer, path: specifier }) => ({
          path: path.resolve(path.dirname(importer), specifier.split("?")[0]),
          namespace: "auth-sql-asset",
        }));
        build.onLoad(
          { filter: /.*/u, namespace: "auth-sql-asset" },
          async ({ path: assetPath }) => ({
            contents: `export default ${JSON.stringify(await Bun.file(assetPath).text())};`,
            loader: "js",
          }),
        );
      },
    },
  ],
});
if (!result.success) throw new Error("Protected Auth worker bundle failed");
