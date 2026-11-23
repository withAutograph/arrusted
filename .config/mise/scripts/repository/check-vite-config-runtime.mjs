import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const sourcePath = path.resolve("packages/vite-config/index.ts");
const runtimePath = path.resolve("packages/vite-config/index.js");
const targetRoot = path.resolve("target");
await mkdir(targetRoot, { recursive: true });
const tempRoot = await mkdtemp(path.join(targetRoot, "vite-config-runtime-"));
const tempRuntimePath = path.join(tempRoot, "index.js");

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    throw new Error(`${command} failed`);
  }
}

try {
  run("tsc", [
    "--ignoreConfig",
    sourcePath,
    "--target",
    "ES2024",
    "--module",
    "ESNext",
    "--moduleResolution",
    "Bundler",
    "--skipLibCheck",
    "--esModuleInterop",
    "--allowSyntheticDefaultImports",
    "--noEmit",
    "false",
    "--outDir",
    tempRoot,
  ]);
  run("vp", ["fmt", tempRuntimePath]);

  const generated = await readFile(tempRuntimePath, "utf8");

  if (process.argv.includes("--write")) {
    await writeFile(runtimePath, generated);
  } else {
    let runtime;
    try {
      runtime = await readFile(runtimePath, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        runtime = undefined;
      } else {
        throw error;
      }
    }

    if (runtime !== generated) {
      console.error(
        "packages/vite-config/index.js is stale; run " +
          "`mise exec -- node .config/mise/scripts/repository/check-vite-config-runtime.mjs --write`",
      );
      process.exitCode = 1;
    } else {
      run(process.execPath, ["--check", runtimePath]);
    }
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
