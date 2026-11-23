#!/usr/bin/env bun
import path from "node:path";
import { protectedParserAssetsPlugin } from "./protected-parser-assets.mjs";

const [outputDirectory] = process.argv.slice(2);
if (!outputDirectory) throw new Error("Expected Neon resource bootstrap worker output directory");

const root = process.cwd();
const result = await Bun.build({
  entrypoints: [path.join(root, "packages/provisioning/neon-resource-bootstrap-worker.ts")],
  outdir: outputDirectory,
  target: "bun",
  plugins: [protectedParserAssetsPlugin()],
});
if (!result.success) throw new Error("Neon resource bootstrap worker bundle failed");
