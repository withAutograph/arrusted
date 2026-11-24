#!/usr/bin/env bun

import path from "node:path";

export const POLICY_VALIDATOR_PATHS = new Set([
  ".config/mise/scripts/repository/check-git-hook-gates.test.ts",
  ".config/mise/scripts/repository/supply-chain-security.test.ts",
  ".config/mise/scripts/repository/__tests__/test-quality-policy.test.ts",
]);

const root = path.resolve(import.meta.dirname, "../../../..");
const testPatterns = ["**/*.test.{ts,tsx,js,jsx,mjs,cjs}", "**/*.spec.{ts,tsx,js,jsx,mjs,cjs}"];
const productionPath =
  /(?:\.github\/workflows|(?:apps|packages|scripts|turbo)\/|\.(?:json|tsx?|[cm]?[jt]s|css|ya?ml|toml|hbs|md|sql|sh))(?:["'`)]|$)/u;

export function findSourceInspectionViolations(
  files: readonly { relative: string; source: string }[],
): string[] {
  const violations: string[] = [];
  for (const { relative, source } of files) {
    if (POLICY_VALIDATOR_PATHS.has(relative)) continue;
    const executableSource = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
    const bindings = [
      ...executableSource.matchAll(
        /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:readFile(?:Sync)?|Bun\.file)\s*\(([\s\S]*?)\)/gu,
      ),
    ]
      .filter((match) => productionPath.test(match[2] ?? ""))
      .map((match) => match[1]);
    if (bindings.length === 0) continue;
    const rawAssertion = new RegExp(
      `(?:expect\\s*\\(\\s*(?:${bindings.join("|")})\\s*\\)|\\b(?:${bindings.join("|")})\\b)\\s*(?:\\.includes\\s*\\(|\\.match\\s*\\(|\\.(?:not\\.)?to(?:Contain|Match|Be)\\b)`,
      "u",
    );
    if (rawAssertion.test(executableSource)) violations.push(relative);
  }
  return violations;
}

if (import.meta.main) {
  const files: { relative: string; source: string }[] = [];
  for (const pattern of testPatterns) {
    for await (const relative of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) {
      files.push({ relative, source: await Bun.file(path.join(root, relative)).text() });
    }
  }
  const violations = findSourceInspectionViolations(files);
  if (violations.length > 0) {
    throw new Error(
      `Ordinary tests must not inspect production source text: ${violations.join(", ")}. ` +
        "Move a real policy checker to an explicitly allowlisted validation lane, or test behavior instead.",
    );
  }
}
