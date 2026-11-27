import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(pkgRoot, "../../..");
const distDir = path.join(pkgRoot, "dist");
const assetsDir = path.join(pkgRoot, "assets");

rmSync(distDir, { recursive: true, force: true });
rmSync(assetsDir, { recursive: true, force: true });
mkdirSync(assetsDir, { recursive: true });

cpSync(
  path.join(repoRoot, "packages/schema-compiler/cue/app-manifest.cue"),
  path.join(assetsDir, "app-manifest.cue"),
);
cpSync(
  path.join(repoRoot, "packages/schema-compiler/cue/app-selection.cue"),
  path.join(assetsDir, "app-selection.cue"),
);
cpSync(path.join(repoRoot, "packages/auth/schema.sql"), path.join(assetsDir, "schema.sql"));
cpSync(
  path.join(repoRoot, "packages/auth/single-organization-membership.sql"),
  path.join(assetsDir, "single-organization-membership.sql"),
);

const entries = [
  "src/index.ts",
  "src/data.ts",
  "src/artifact-helpers.ts",
  "src/actor-binding.ts",
  "src/errors.ts",
  "src/pool.ts",
  "src/server.ts",
  "src/client.ts",
  "src/routes.ts",
  "src/next.ts",
  "src/cli.ts",
];

const externals = [
  "pg",
  "zod",
  "@libpg-query/parser",
  "next",
  "react",
  "server-only",
  "client-only",
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

const tmpDtsDir = mkdtempSync(path.join(tmpdir(), "arrusted-core-dts-"));
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
        paths: {
          "@contracts": ["./packages/contracts/index.d.ts"],
          "@kernel-client": ["./packages/kernel-client/index.d.ts"],
          "@autograph/generated-app-runtime": ["./packages/generated-app-runtime/index.d.ts"],
          "@autograph/generated-app-runtime/*": ["./packages/generated-app-runtime/*"],
          "@autograph/work-session-tools": ["./packages/work-session-tools/index.d.ts"],
          "@autograph/work-session-tools/*": ["./packages/work-session-tools/*"],
          "@engines/*": ["./packages/engines/*"],
        },
      },
    }),
    "utf8",
  );
  const dtsEntries = entries.map((entry) =>
    path.join(tmpDtsDir, "packages/arrusted/core", entry.replace(/\.tsx?$/u, ".d.ts")),
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
