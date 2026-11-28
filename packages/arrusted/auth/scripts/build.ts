import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(pkgRoot, "../../..");
const distDir = path.join(pkgRoot, "dist");

rmSync(distDir, { recursive: true, force: true });

const entries = ["src/index.ts", "src/server.ts", "src/client.ts", "src/cli.ts"];
const externals = [
  "@arrusted/core",
  "@arrusted/core/pool",
  "better-auth",
  "better-auth/crypto",
  "better-auth/next-js",
  "better-auth/plugins",
  "better-auth/react",
  "better-auth/client/plugins",
  "pg",
  "react",
  "zod",
];

function runChecked(cmd: string, args: string[]) {
  const result = spawnSync(cmd, args, {
    cwd: pkgRoot,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

runChecked("bunx", [
  "vp",
  "pack",
  ...entries,
  "--format",
  "esm",
  "--platform",
  "node",
  "--no-fixed-extension",
  "--no-dts",
  "--out-dir",
  "dist",
  "--no-config",
  "--no-fail-on-warn",
  ...externals.flatMap((ext) => ["--deps.never-bundle", ext]),
]);

const tmpDtsDir = mkdtempSync(path.join(tmpdir(), "arrusted-auth-dts-"));
try {
  runChecked("bunx", [
    "tsc",
    "--noEmit",
    "false",
    "--declaration",
    "--emitDeclarationOnly",
    "-p",
    "tsconfig.json",
    "--outDir",
    tmpDtsDir,
    "--rootDir",
    repoRoot,
    "--noCheck",
  ]);
  const dtsTsconfigPath = path.join(tmpDtsDir, "tsconfig.dts.json");
  writeFileSync(
    dtsTsconfigPath,
    JSON.stringify({
      compilerOptions: {
        moduleResolution: "bundler",
      },
    }),
    "utf8",
  );
  const dtsEntries = entries.map((entry) =>
    path.join(tmpDtsDir, "packages/arrusted/auth", entry.replace(/\.tsx?$/u, ".d.ts")),
  );
  runChecked("bunx", [
    "vp",
    "pack",
    ...dtsEntries,
    "--format",
    "esm",
    "--platform",
    "node",
    "--no-fixed-extension",
    "--dts.dtsInput",
    "--no-clean",
    "--out-dir",
    "dist",
    "--no-config",
    "--no-fail-on-warn",
    "--tsconfig",
    dtsTsconfigPath,
    ...externals.flatMap((ext) => ["--deps.never-bundle", ext]),
  ]);
} finally {
  rmSync(tmpDtsDir, { recursive: true, force: true });
}

const clientJsPath = path.join(distDir, "client.js");
const clientJs = readFileSync(clientJsPath, "utf8");
if (!clientJs.startsWith('"use client"') && !clientJs.startsWith("'use client'")) {
  writeFileSync(clientJsPath, `"use client";\n${clientJs}`, "utf8");
}
