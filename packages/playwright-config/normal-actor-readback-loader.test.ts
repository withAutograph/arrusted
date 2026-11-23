import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const cli = path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js");
const helper = path.join(import.meta.dirname, "normal-actor-readback.js");

it.each(["commonjs", "module"])(
  "the real Playwright CLI loads readback from a %s app without fixture IO",
  async (type) => {
    const scratch = path.join(import.meta.dirname, ".scratch");
    await mkdir(scratch, { recursive: true });
    const root = await mkdtemp(path.join(scratch, "normal-readback-loader-"));
    try {
      await writeFile(path.join(root, "package.json"), JSON.stringify({ type }));
      await writeFile(
        path.join(root, "playwright.config.ts"),
        "export default { testDir: '.', reporter: 'list' };\n",
      );
      await writeFile(
        path.join(root, "readback.spec.ts"),
        `import { test, expect } from 'playwright/test';
import { withNormalActorReadback } from ${JSON.stringify(helper)};
test('readback helper graph', async () => { expect(typeof withNormalActorReadback).toBe('function'); });\n`,
      );
      const result = spawnSync(
        process.execPath,
        [cli, "test", "--config", path.join(root, "playwright.config.ts"), "--list"],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            NODE_ENV: "test",
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            APP_TEST_IDENTITIES_FILE: "/nonexistent/no-fixture-read-while-loading",
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("readback helper graph");
      expect(result.stderr).not.toContain("import.meta");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
