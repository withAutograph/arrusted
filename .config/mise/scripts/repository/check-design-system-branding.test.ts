import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";

import { checkDesignSystemBranding } from "./check-design-system-branding";
import { createContext } from "./source-analysis";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const checkFiles = (files: Record<string, string>): string[] => {
  const root = mkdtempSync(join(tmpdir(), "design-branding-"));
  roots.push(root);
  const core = join(root, "packages/design-systems/core");
  mkdirSync(core, { recursive: true });
  for (const [relative, source] of Object.entries(files)) {
    const target = join(core, relative);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, source);
  }
  const context = createContext(root);
  checkDesignSystemBranding(context);
  return context.violations;
};

const check = (source: string): string[] => checkFiles({ "Button.tsx": source });

test("accepts generic design-system content", () =>
  expect(check("export const Button = 1;\n")).toEqual([]));

test("rejects product identity in core design-system content", () => {
  expect(check('export const label = "Autograph";\n')).toContain(
    "packages/design-systems/core/Button.tsx: core design-system content must not contain product identity",
  );
});

test("allows package specifiers without treating them as product content", () =>
  expect(check('export { Button } from "@autograph/components";\n')).toEqual([]));

test("rejects product identity in paths and raster product assets", () => {
  expect(checkFiles({ "AutographButton.tsx": "export const Button = 1;\n" })).toContain(
    "packages/design-systems/core/AutographButton.tsx: core design-system pathnames must use generic purpose-based names",
  );
  expect(checkFiles({ "brand.png": "fixture" })).toContain(
    "packages/design-systems/core/brand.png: raster product assets belong in consuming app brand layers",
  );
});

test("requires referenced semantic tokens in both core and AON themes", () => {
  const violations = checkFiles({
    "Button.css": ".button { color: var(--missing-color); }\n",
    "tokens/theme.css": ":root { --present-color: black; }\n",
  });
  expect(violations).toContain(
    "packages/design-systems/core: runtime semantic token --missing-color is missing from the core theme",
  );
  expect(violations).toContain(
    "packages/design-systems/aon/tokens/theme.css: runtime semantic token --missing-color is missing from the AON implementation",
  );
});
