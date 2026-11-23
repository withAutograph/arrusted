#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { protectedParserAssetsPlugin } from "./protected-parser-assets.mjs";

const [outputFile, target = "bun-linux-x64"] = process.argv.slice(2);
if (!outputFile) throw new Error("Expected protected generated-app executable output path");
const result = await Bun.build({
  entrypoints: [path.join(process.cwd(), "packages/generated-app-runtime/protected-installer-worker.ts")],
  target: "bun",
  compile: { target, outfile: outputFile },
  plugins: [protectedParserAssetsPlugin()],
});
if (!result.success) throw new Error("Protected generated-app executable build failed");
const bytes = await readFile(outputFile);
process.stdout.write(
  `${JSON.stringify({ compiler: `bun@${Bun.version}`, target, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length })}\n`,
);
