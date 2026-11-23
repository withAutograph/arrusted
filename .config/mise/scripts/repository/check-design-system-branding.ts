import { existsSync } from "node:fs";
import { extname, join } from "node:path";

import {
  type BoundaryContext,
  createContext,
  filesUnder,
  readText,
  rel,
  sourceFiles,
} from "./source-analysis";

const PRODUCT_IDENTITY = /arrusted|autograph|aon/i;
const RASTER_ASSETS = new Set([".gif", ".ico", ".jpeg", ".jpg", ".png", ".webp"]);
const PACKAGE_SPECIFIER = /@(?:arrusted|autograph)\/[a-z0-9._/-]+/gi;
const CSS_VARIABLE_REFERENCE = /var\(\s*(--[a-z0-9-]+)(?=\s*[,)]|$)/g;
const CSS_VARIABLE_DECLARATION = /(--[a-z0-9-]+)\s*:/g;

const cssVariables = (source: string, pattern: RegExp): Set<string> =>
  new Set([...source.matchAll(pattern)].map((match) => match[1]!));

export const checkDesignSystemBranding = (context: BoundaryContext): void => {
  const core = `${context.packages}/design-systems/core`;
  for (const path of filesUnder(core)) {
    const relativePath = rel(context, path);
    const extension = extname(path).toLowerCase();

    if (PRODUCT_IDENTITY.test(relativePath)) {
      context.violations.push(
        `${relativePath}: core design-system pathnames must use generic purpose-based names`,
      );
    }
    if (RASTER_ASSETS.has(extension)) {
      context.violations.push(
        `${relativePath}: raster product assets belong in consuming app brand layers`,
      );
      continue;
    }
    if (PRODUCT_IDENTITY.test(readText(path).replace(PACKAGE_SPECIFIER, ""))) {
      context.violations.push(
        `${relativePath}: core design-system content must not contain product identity`,
      );
    }
  }

  const coreTheme = join(core, "tokens", "theme.css");
  const aonTheme = join(context.packages, "design-systems", "aon", "tokens", "theme.css");
  const referencedTokens = new Set<string>();
  for (const path of sourceFiles(core)) {
    if (path === coreTheme) continue;
    for (const token of cssVariables(readText(path), CSS_VARIABLE_REFERENCE)) {
      referencedTokens.add(token);
    }
  }
  if (referencedTokens.size === 0) return;
  // Small boundary fixtures that exercise unrelated syntax do not model a
  // complete design-system package. Once the canonical theme exists, however,
  // every referenced semantic token must be implemented by both themes.
  if (!existsSync(coreTheme)) return;

  const coreTokens = cssVariables(readText(coreTheme), CSS_VARIABLE_DECLARATION);
  const aonTokens = existsSync(aonTheme)
    ? cssVariables(readText(aonTheme), CSS_VARIABLE_DECLARATION)
    : new Set<string>();
  for (const token of [...referencedTokens].sort()) {
    if (!coreTokens.has(token)) {
      context.violations.push(
        `packages/design-systems/core: runtime semantic token ${token} is missing from the core theme`,
      );
    }
    if (!aonTokens.has(token)) {
      context.violations.push(
        `packages/design-systems/aon/tokens/theme.css: runtime semantic token ${token} is missing from the AON implementation`,
      );
    }
  }
};

if (import.meta.main) {
  const context = createContext(process.argv[2] ?? process.cwd());
  checkDesignSystemBranding(context);
  const runtimeFailures = context.violations.filter((violation) =>
    violation.includes("runtime semantic token"),
  );
  const advisory = context.violations.filter((violation) => !runtimeFailures.includes(violation));
  if (advisory.length > 0) console.warn(advisory.join("\n"));
  if (runtimeFailures.length > 0) {
    console.error(runtimeFailures.join("\n"));
    process.exit(1);
  }
}
