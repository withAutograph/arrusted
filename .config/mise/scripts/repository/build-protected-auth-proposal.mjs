#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { protectedParserAssetsPlugin } from "./protected-parser-assets.mjs";

const [outputFile, target = "bun-linux-x64"] = process.argv.slice(2);
if (!outputFile) throw new Error("Expected protected Auth proposal executable output path");
if (Bun.version !== "1.3.14") throw new Error("Auth proposal packaging requires Bun 1.3.14");
const root = process.cwd();
const result = await Bun.build({
  entrypoints: [path.join(root, ".config/mise/scripts/repository/auth-schema-proposal.ts")],
  target: "bun",
  compile: { target, outfile: outputFile },
  plugins: [
    protectedParserAssetsPlugin(),
    {
      name: "auth-proposal-owned-assets",
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
if (!result.success) throw new Error("Protected Auth proposal executable build failed");
const bytes = await readFile(outputFile);
process.stdout.write(
  `${JSON.stringify({ compiler: "bun@1.3.14", target, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length })}\n`,
);
