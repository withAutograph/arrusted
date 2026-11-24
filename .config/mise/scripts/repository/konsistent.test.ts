import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../..");
const konsistent = path.join(repositoryRoot, "node_modules", ".bin", "konsistent");
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "workspace-konsistent-"));
  fixtureRoots.push(root);
  const config = JSON.parse(
    readFileSync(path.join(repositoryRoot, ".config", "konsistent.json"), "utf8"),
  ) as Record<string, unknown>;
  delete config.$schema;
  writeFixture(root, ".config/konsistent.json", `${JSON.stringify(config, null, 2)}\n`);
  for (const [relativePath, source] of Object.entries(files)) {
    writeFixture(root, relativePath, source);
  }
  return root;
}

function writeFixture(root: string, relativePath: string, source: string): void {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, source);
}

function check(root: string, paths: string[] = []): { exitCode: number; output: string } {
  const result = spawnSync(
    konsistent,
    [
      "check",
      "--config-path",
      ".config/konsistent.json",
      "--format",
      "json",
      ...paths.flatMap((p) => ["--paths", p]),
    ],
    { cwd: root, encoding: "utf8" },
  );
  return {
    exitCode: result.status ?? 1,
    output: `${result.stdout}${result.stderr}`,
  };
}

describe("Konsistent repository conventions", () => {
  it("checks changed source paths while leaving unrelated files out", () => {
    const root = fixture({
      "packages/kernel-client/index.ts": 'import type { Leaked } from "@modules/editable-grid";\n',
      "packages/unrelated/index.ts": "export const ok = true;\n",
    });
    expect(check(root, ["packages/unrelated/index.ts"]).exitCode).toBe(0);
    expect(check(root, ["packages/kernel-client/index.ts"]).exitCode).toBe(1);
  });
  it.each([
    {
      convention: "contracts-imports-are-type-only",
      path: "packages/contracts/index.ts",
      source: 'import { z } from "zod";\nexport type Identifier = string;\n',
    },
    {
      convention: "modules-direct-import-boundary",
      path: "packages/modules/source-import/index.ts",
      source:
        'import type { InstallIntegrationProps } from "@autograph/integrations/ampersand/prebuilt";\nexport type Leaked = InstallIntegrationProps;\n',
    },
    {
      convention: "modules-direct-import-boundary",
      path: "packages/modules/editable-grid/index.ts",
      source:
        'import { KernelClient } from "@contracts";\nexport const leaked = null as KernelClient | null;\n',
    },
    {
      convention: "modules-direct-import-boundary",
      path: "packages/modules/editable-grid/index.ts",
      source:
        'import { createFetchKernelClient } from "@kernel-client";\nexport const leaked = createFetchKernelClient;\n',
    },
    {
      convention: "engines-direct-import-boundary",
      path: "packages/engines/format/index.ts",
      source:
        'import type { Editor } from "@modules/editable-grid";\nexport type Leaked = Editor;\n',
    },
    {
      convention: "compositions-direct-import-boundary",
      path: "packages/design-systems/default/compositions/RecordBrowser.tsx",
      source:
        'import { createFetchKernelClient } from "@kernel-client";\nexport const leaked = createFetchKernelClient;\n',
    },
    {
      convention: "agent-foundation-direct-import-boundary",
      path: "packages/agent-foundation/index.ts",
      source:
        'import { KernelClient } from "@contracts";\nexport const leaked = null as KernelClient | null;\n',
    },
    {
      convention: "auth-direct-import-boundary",
      path: "packages/auth/index.ts",
      source:
        'import { Session } from "@contracts";\nexport const leaked = null as Session | null;\n',
    },
    {
      convention: "auth-direct-import-boundary",
      path: "packages/auth/server.ts",
      source:
        'import { createFetchKernelClient } from "@kernel-client";\nexport const leaked = createFetchKernelClient;\n',
    },
  ])("rejects syntax-local imports through $convention", ({ convention, path, source }) => {
    const root = fixture({ [path]: source });

    const result = check(root);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(`"conventionName": "${convention}"`);
  });

  it("rejects the expanded direct package boundaries", () => {
    const root = fixture({
      "packages/modules/example/hc.ts":
        'import type { Client } from "@hc-client";\nexport type Leaked = Client;\n',
      "packages/modules/example/vendor.ts":
        'import type { Client } from "@vendor-client";\nexport type Leaked = Client;\n',
      "packages/modules/example/hc-export.ts":
        'import type { Client } from "@autograph/hc/generated-client";\nexport type Leaked = Client;\n',
      "packages/modules/example/vendor-export.ts":
        'import type { Client } from "@autograph/vendor/generated-client";\nexport type Leaked = Client;\n',
      "packages/modules/example/vite.config.ts":
        'import { config } from "@autograph/vite-config/testing";\nexport const leaked = config;\n',
      "packages/kernel-client/index.ts":
        'import type { Editor } from "@modules/editable-grid";\nexport type Leaked = Editor;\n',
      "apps/hc/frontend/src/App.tsx":
        'import { requireUser } from "@autograph/auth/server";\nexport const leaked = requireUser;\n',
      "packages/platform-microfrontends/shell/components/Auth.jsx":
        'import { Button } from "@autograph/auth/components/ui/button";\nexport const leaked = Button;\n',
      "packages/microfrontends/src/neutral/transport.ts":
        'import { getVercelOidcToken } from "@vercel/oidc";\nexport const leaked = getVercelOidcToken;\n',
      "packages/microfrontends/src/neutral/policy.ts":
        'import { auth } from "better-auth";\nexport const leaked = auth;\n',
      "packages/microfrontends-shell/src/private-policy.ts":
        'import type { GatewayCatalog } from "@autograph/platform-microfrontends/catalog";\nexport type Leaked = GatewayCatalog;\n',
      "packages/microfrontends-shell/src/application-client.ts":
        'import type { Client } from "@hc-client";\nexport type Leaked = Client;\n',
      "apps/sample/runtime.ts":
        'import { policy } from "@autograph/platform-microfrontends/policy";\nexport const leaked = policy;\n',
    });

    const result = check(root);
    expect(result.exitCode).toBe(1);
    for (const convention of [
      "modules-direct-import-boundary",
      "kernel-client-direct-import-boundary",
    ])
      expect(result.output).toContain(`"conventionName": "${convention}"`);
    for (const filePath of [
      "packages/modules/example/hc.ts",
      "packages/modules/example/vendor.ts",
      "packages/modules/example/vite.config.ts",
      "packages/kernel-client/index.ts",
    ])
      expect(result.output).toContain(filePath);
  });
});
