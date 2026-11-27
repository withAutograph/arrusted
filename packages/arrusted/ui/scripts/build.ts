import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(pkgRoot, "../../..");
const distDir = path.join(pkgRoot, "dist");

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const entries = ["src/index.tsx", "src/grid-basic.ts", "src/grid-advanced.ts"];
const externals = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "@heroicons/react",
  "@heroicons/react/24/outline",
  "@heroicons/react/24/solid",
  "ag-grid-community",
  "ag-grid-enterprise",
  "ag-grid-react",
  "react-day-picker",
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
  "neutral",
  "--no-fixed-extension",
  "--no-dts",
  "--out-dir",
  "dist",
  "--no-config",
  "--no-fail-on-warn",
  ...externals.flatMap((ext) => ["--deps.never-bundle", ext]),
]);

const tmpDtsDir = mkdtempSync(path.join(tmpdir(), "arrusted-ui-dts-"));
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
          "@autograph/components": ["./packages/design-systems/core/components/index.d.ts"],
          "@autograph/compositions": ["./packages/design-systems/core/compositions/index.d.ts"],
          "@autograph/icons": ["./packages/design-systems/core/icons/index.d.ts"],
          "@engines/*": ["./packages/engines/*"],
          "@modules/*": ["./packages/modules/*"],
        },
      },
    }),
    "utf8",
  );
  const dtsEntries = entries.map((entry) =>
    path.join(tmpDtsDir, "packages/arrusted/ui", entry.replace(/\.tsx?$/u, ".d.ts")),
  );
  runChecked("bunx", [
    "vp",
    "pack",
    ...dtsEntries,
    "--format",
    "esm",
    "--platform",
    "neutral",
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
rmSync(path.join(distDir, "style.css"), { force: true });

const indexJsPath = path.join(distDir, "index.js");
const indexJs = readFileSync(indexJsPath, "utf8");
if (indexJs.includes("ag-grid-enterprise")) {
  throw new Error(
    "Build invariant violated: @arrusted/ui dist/index.js must not import ag-grid-enterprise.",
  );
}
if (!indexJs.startsWith('"use client"') && !indexJs.startsWith("'use client'")) {
  writeFileSync(indexJsPath, `"use client";\n${indexJs}`, "utf8");
}

const themeCssRaw = readFileSync(
  path.join(repoRoot, "packages/design-systems/core/tokens/theme.css"),
  "utf8",
);
const themeCssBody = themeCssRaw.replace(/^@import\s+["']tailwindcss["'];\s*/u, "");

const gridCssFiles = [
  "dirty-glyph.css",
  "diff-cell.css",
  "invalid-cell.css",
  "cell-editor-mount.css",
  "row-meta-row.css",
  "header-chrome.css",
].map((file) => readFileSync(path.join(repoRoot, "packages/modules/editable-grid", file), "utf8"));

const bundledStyles = [
  '@source "./**/*.js";',
  themeCssBody.trim(),
  ...gridCssFiles.map((css) => css.trim()),
  "",
].join("\n\n");

writeFileSync(path.join(distDir, "styles.css"), bundledStyles, "utf8");
