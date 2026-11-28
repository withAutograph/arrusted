import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import {
  detectHostCliTarget,
  packArrustedPackage,
  resolveRepoSchemaCompiler,
  stageCliPackage,
  type SupportedCliTarget,
} from "../../.config/mise/scripts/repository/pack-arrusted-packages";

const databaseURL = process.env.KERNEL_TEST_DATABASE_URL;
const detectedHostCliTarget = detectHostCliTarget();
if (process.env.CI && !databaseURL) {
  throw new Error("KERNEL_TEST_DATABASE_URL is required in CI to exercise clean-machine.test.ts.");
}
if (process.env.CI && !detectedHostCliTarget) {
  throw new Error(
    `Unsupported host platform for clean-machine CLI verification: ${process.platform}-${process.arch}`,
  );
}
const suite = databaseURL && detectedHostCliTarget ? test : test.skip;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scratchRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "arrusted-clean-machine-")));
const tarballDir = path.join(scratchRoot, "tarballs");
const isolatedBinDir = path.join(scratchRoot, "isolated-bin");
const consumerDir = path.join(scratchRoot, "sunlight-crm-consumer");
const restoreDir = path.join(scratchRoot, "restore-points");

const database = `clean_${randomUUID().replaceAll("-", "").slice(0, 14)}`;
const crmRole = `${database}_crm_app`;
const rolePassword = "clean-machine-runtime-password-32chars";
const authSecret = "0123456789abcdef0123456789abcdef";

const adminUrl = new URL(databaseURL ?? "postgres://postgres@127.0.0.1:5432/postgres");
if (adminUrl.hostname === "localhost") adminUrl.hostname = "127.0.0.1";
const adminPool = new Pool({ connectionString: adminUrl.toString() });

const ownerUrl = new URL(adminUrl.toString());
ownerUrl.pathname = `/${database}`;
if (!ownerUrl.searchParams.has("sslmode")) ownerUrl.searchParams.set("sslmode", "disable");
const ownerDatabaseUrl = ownerUrl.toString();

const crmUrl = new URL(ownerDatabaseUrl);
crmUrl.username = crmRole;
crmUrl.password = rolePassword;
const crmDatabaseUrl = crmUrl.toString();

let createdDatabase = false;

function whichBinary(name: string): string {
  return execFileSync("which", [name], { encoding: "utf8" }).trim();
}

const hostCliTarget: SupportedCliTarget = detectedHostCliTarget ?? "darwin-arm64";
const otherCliTarget: SupportedCliTarget =
  hostCliTarget === "darwin-arm64" ? "linux-x64" : "darwin-arm64";

function hasSourceExportCondition(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "source" || hasSourceExportCondition(entry)) return true;
  }
  return false;
}

function makeCleanEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: extra.NODE_ENV ?? "development",
    HOME: process.env.HOME,
    USER: process.env.USER,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    PATH: `${isolatedBinDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    ...extra,
  };
}

function runClean(
  cmd: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string> },
): string {
  try {
    return execFileSync(cmd, args, {
      cwd: options.cwd,
      env: makeCleanEnvironment(options.env),
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      `Command failed: ${cmd} ${args.join(" ")}\nSTDOUT:\n${e.stdout ?? ""}\nSTDERR:\n${e.stderr ?? ""}\n${e.message ?? ""}`,
    );
  }
}

async function allocateFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate TCP port")));
        return;
      }
      const { port } = address;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForServer(origin: string, proc: ChildProcess): Promise<void> {
  let stderr = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`Next server exited early (${proc.exitCode}): ${stderr}`);
    }
    try {
      const res = await fetch(`${origin}/api/schema/active`, { redirect: "manual" });
      if (res.status > 0) return;
    } catch {
      // Server still booting.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for Next server at ${origin}. Stderr: ${stderr}`);
}

function consumerCueSchema(extraCompanyFields = ""): string {
  const extraGrant = extraCompanyFields ? ', "linkedin_url"' : "";
  return `package schema

manifest: #AppManifest & {
  app_id: "sunlight"
  customer_id: "sunlight"
  version: "ignored-authored-version"
  label: "Sunlight CRM"
  models: [
    {
      id: "company"
      kind: "entity"
      label: "Company"
      fields: [
        {id: "name", label: "Name", type: "text", required: true},
        {id: "domain", label: "Domain", type: "text"}${extraCompanyFields}
      ]
    },
    {
      id: "deal"
      kind: "entity"
      label: "Deal"
      fields: [
        {id: "title", label: "Title", type: "text", required: true},
        {id: "company", label: "Company", type: "relation", target_model: "company", required: true}
      ]
    }
  ]
  authorization: {
    roles: [
      {id: "crm_user", label: "CRM User"}
    ]
    grants: [
      {
        role: "crm_user"
        model: "company"
        operations: ["read", "create", "update", "history"]
        read_fields: ["$id", "$version", "name", "domain"${extraGrant}]
        write_fields: ["name", "domain"${extraGrant}]
        record: {kind: "all"}
      },
      {
        role: "crm_user"
        model: "deal"
        operations: ["read", "create", "update", "delete", "history"]
        read_fields: ["$id", "$version", "title", "company"]
        write_fields: ["title", "company"]
        record: {kind: "all"}
      }
    ]
  }
}
`;
}

function consumerPageTsx(tier: "basic" | "advanced"): string {
  const bootstrapImport =
    tier === "advanced"
      ? 'import { bootstrapAdvancedGrid } from "@arrusted/ui/grid-advanced";\n'
      : "";
  const uiBootstrapExport = tier === "basic" ? "  bootstrapBasicGrid,\n" : "";
  const bootstrapCall = tier === "advanced" ? "bootstrapAdvancedGrid();" : "bootstrapBasicGrid();";
  return `"use client";

import { useMemo } from "react";
import { useSession } from "@arrusted/auth/client";
${bootstrapImport}import { createFetchKernelClient, useActiveSchema } from "@arrusted/core/client";
import {
${uiBootstrapExport}  Button,
  EditableRowVersionGrid,
  useEditableRowVersionGrid,
  useRecordReads,
} from "@arrusted/ui";

${bootstrapCall}

export default function CrmGridPage() {
  const session = useSession();
  const client = useMemo(() => createFetchKernelClient(), []);
  const { schema } = useActiveSchema(client);
  const asOf = "2026-11-27";
  const reads = useRecordReads(client, "company", asOf);
  const { controller, surfaceProps } = useEditableRowVersionGrid({
    client,
    scope: { appId: "sunlight", customerId: "sunlight" },
    modelId: "company",
    model: "company",
    asOf,
    rows: reads.records,
    schema,
    changeTypeId: "manual_edit",
  });

  return (
    <div className="flex h-screen flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <span>User: {session.data?.user?.email ?? "signed-out"}</span>
        <Button onClick={() => void controller.save()} disabled={!controller.isDirty}>
          Save ({controller.dirtyCount})
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <EditableRowVersionGrid analytics="${tier}" {...surfaceProps} />
      </div>
    </div>
  );
}
`;
}

beforeAll(async () => {
  if (!databaseURL || !detectedHostCliTarget) return;
  mkdirSync(tarballDir, { recursive: true });
  mkdirSync(isolatedBinDir, { recursive: true });
  mkdirSync(consumerDir, { recursive: true });
  mkdirSync(restoreDir, { recursive: true });

  // Expose only standard consumer runtime/DB tools on isolated PATH (zero cargo, rustc, mise, cue, or schema-compiler).
  for (const tool of ["node", "bun", "psql", "pg_dump", "pg_restore", "git", "tar"]) {
    const target = whichBinary(tool);
    const wrapperPath = path.join(isolatedBinDir, tool);
    writeFileSync(wrapperPath, `#!/bin/sh\nexec "${target}" "$@"\n`);
    chmodSync(wrapperPath, 0o755);
  }

  const prebuiltDir = process.env.ARRUSTED_PREBUILT_TARBALL_DIR?.trim();
  if (prebuiltDir) {
    for (const entry of readdirSync(prebuiltDir)) {
      if (entry.endsWith(".tgz")) {
        cpSync(path.join(prebuiltDir, entry), path.join(tarballDir, entry));
      }
    }
  } else {
    const stagedPkgDir = stageCliPackage({
      repoRoot,
      target: hostCliTarget,
      compilerBinary: resolveRepoSchemaCompiler(repoRoot),
      cueBinary: whichBinary("cue"),
    });
    try {
      for (const pkg of [`cli-${hostCliTarget}`, "core", "auth", "ui"] as const) {
        packArrustedPackage({ repoRoot, packageName: pkg, outDir: tarballDir });
      }
    } finally {
      rmSync(path.join(stagedPkgDir, "bin"), { recursive: true, force: true });
    }
  }

  await adminPool.query(`create database "${database}"`);
  createdDatabase = true;
}, 180_000);

afterAll(async () => {
  try {
    if (createdDatabase) {
      await adminPool.query(
        `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
        [database],
      );
      await adminPool.query(`drop database if exists "${database}"`);
    }
    await adminPool.query(`drop role if exists "${crmRole}"`).catch(() => {});
  } finally {
    await adminPool.end();
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

suite(
  "clean-machine consumer installs tarballs outside repo and runs compile -> migrate -> people -> apply -> undo -> next build (basic & advanced)",
  async () => {
    // 1. Verify isolated PATH genuinely has NO cargo, rustc, mise, cue, or schema-compiler
    for (const forbidden of ["cargo", "rustc", "mise", "cue", "schema-compiler"]) {
      expect(() => runClean("/usr/bin/which", [forbidden], { cwd: consumerDir })).toThrow();
    }

    // 2. Inspect packed tarballs to guarantee zero leaked workspace:*, catalog:, or source export conditions
    const tgzFiles = readdirSync(tarballDir).filter((f) => f.endsWith(".tgz"));
    expect(tgzFiles.length).toBeGreaterThanOrEqual(4);
    const tarballByPkg: Record<string, string> = {};
    const hostCliPkgName = `@arrusted/cli-${hostCliTarget}`;
    const otherCliPkgName = `@arrusted/cli-${otherCliTarget}`;

    for (const file of tgzFiles) {
      const fullPath = path.join(tarballDir, file);
      const archiveEntries = execFileSync("tar", ["-tzf", fullPath], { encoding: "utf8" })
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      expect(archiveEntries).toContain("package/LICENSE");
      expect(archiveEntries.some((entry) => entry.includes("/._"))).toBe(false);

      const manifestRaw = execFileSync("tar", ["-xOf", fullPath, "package/package.json"], {
        encoding: "utf8",
      });
      const manifest = JSON.parse(manifestRaw) as {
        name: string;
        version: string;
        license: string;
        repository?: { type?: string; url?: string };
        exports?: unknown;
        scripts?: unknown;
        devDependencies?: unknown;
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      };
      expect(manifest.version).toBe("0.1.0-alpha.2");
      expect(manifest.license).toBe(
        manifest.name.startsWith("@arrusted/cli-") ? "MIT AND Apache-2.0" : "MIT",
      );
      expect(manifest.repository?.type).toBe("git");
      expect(manifest.repository?.url).toBe(
        "git+https://github.com/withAutograph/arrusted-development.git",
      );
      expect(manifest.scripts).toBeUndefined();
      expect(manifest.devDependencies).toBeUndefined();
      expect(hasSourceExportCondition(manifest.exports)).toBe(false);
      tarballByPkg[manifest.name] = fullPath;

      for (const section of [
        manifest.dependencies,
        manifest.peerDependencies,
        manifest.optionalDependencies,
      ]) {
        for (const [, spec] of Object.entries(section ?? {})) {
          expect(spec.startsWith("workspace:")).toBe(false);
          expect(spec.startsWith("catalog:")).toBe(false);
        }
      }

      if (manifest.name === "@arrusted/core") {
        expect(manifest.optionalDependencies).toEqual({
          "@arrusted/cli-darwin-arm64": "0.1.0-alpha.2",
          "@arrusted/cli-linux-x64": "0.1.0-alpha.2",
        });
      }
      if (manifest.name.startsWith("@arrusted/cli-")) {
        expect(archiveEntries).toContain("package/bin/schema-compiler");
        expect(archiveEntries).toContain("package/bin/cue");
        expect(archiveEntries).toContain("package/THIRD_PARTY_NOTICES.md");
      }
      if (manifest.name === "@arrusted/auth") {
        expect(manifest.peerDependencies?.["@arrusted/core"]).toBe(">=0.1.0-alpha.2 <0.2.0");
        expect(manifest.dependencies).toBeUndefined();
      }
      if (manifest.name === "@arrusted/ui") {
        expect(manifest.dependencies).not.toHaveProperty("ag-grid-enterprise");
        expect(manifest.peerDependencies?.["ag-grid-enterprise"]).toBe("33.3.0");
      }
    }
    expect(tarballByPkg[hostCliPkgName]).toBeTruthy();

    // 3. Scaffold a brand-new standalone Next.js 16 + Tailwind v4 app outside the monorepo
    //    WITHOUT ag-grid-enterprise installed (proving the MIT basic tier).
    const rootCatalog = (
      JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
        catalog: Record<string, string>;
      }
    ).catalog;

    writeFileSync(
      path.join(consumerDir, "package.json"),
      JSON.stringify(
        {
          name: "sunlight-crm-clean-consumer",
          version: "0.0.1",
          private: true,
          type: "module",
          scripts: {
            compile: "arrusted compile",
            migrate: "arrusted migrate",
            "migrate:undo": "arrusted migrate:undo",
            typecheck: "tsc --noEmit",
            build: "next build",
          },
          dependencies: {
            "@arrusted/core": `file:${tarballByPkg["@arrusted/core"]}`,
            "@arrusted/auth": `file:${tarballByPkg["@arrusted/auth"]}`,
            "@arrusted/ui": `file:${tarballByPkg["@arrusted/ui"]}`,
            "better-auth": rootCatalog["better-auth"],
            next: rootCatalog.next,
            pg: rootCatalog.pg,
            react: rootCatalog.react,
            "react-dom": rootCatalog["react-dom"],
            zod: rootCatalog.zod,
          },
          devDependencies: {
            "@tailwindcss/postcss": rootCatalog["@tailwindcss/postcss"],
            "@types/node": rootCatalog["@types/node"],
            "@types/pg": rootCatalog["@types/pg"],
            "@types/react": rootCatalog["@types/react"],
            "@types/react-dom": rootCatalog["@types/react-dom"],
            postcss: rootCatalog.postcss,
            tailwindcss: rootCatalog.tailwindcss,
            typescript: rootCatalog.typescript,
          },
          overrides: {
            "@arrusted/core": `file:${tarballByPkg["@arrusted/core"]}`,
            [hostCliPkgName]: `file:${tarballByPkg[hostCliPkgName]}`,
          },
        },
        null,
        2,
      ),
    );

    runClean(path.join(isolatedBinDir, "bun"), ["install"], { cwd: consumerDir });
    expect(existsSync(path.join(consumerDir, "node_modules/ag-grid-enterprise"))).toBe(false);
    expect(
      existsSync(path.join(consumerDir, "node_modules", hostCliPkgName, "bin/schema-compiler")),
    ).toBe(true);
    expect(existsSync(path.join(consumerDir, "node_modules", hostCliPkgName, "bin/cue"))).toBe(
      true,
    );
    expect(existsSync(path.join(consumerDir, "node_modules", otherCliPkgName))).toBe(false);

    // Initialize git commit in consumerDir so provenance + undo commit checks work realistically
    // (note: .local/ is intentionally omitted here to prove migrate & people add auto-create .local/.gitignore!)
    writeFileSync(path.join(consumerDir, ".gitignore"), "node_modules/\n.generated/\n.next/\n");
    runClean(path.join(isolatedBinDir, "git"), ["init"], { cwd: consumerDir });
    runClean(path.join(isolatedBinDir, "git"), ["config", "user.email", "dev@sunlight.test"], {
      cwd: consumerDir,
    });
    runClean(path.join(isolatedBinDir, "git"), ["config", "user.name", "Sunlight Dev"], {
      cwd: consumerDir,
    });

    mkdirSync(path.join(consumerDir, "schema"), { recursive: true });
    writeFileSync(path.join(consumerDir, "schema/app.cue"), consumerCueSchema());

    writeFileSync(
      path.join(consumerDir, "next.config.ts"),
      `import { nextAppConfig } from "@arrusted/core/next";
export default nextAppConfig();
`,
    );

    writeFileSync(
      path.join(consumerDir, "postcss.config.mjs"),
      `export default { plugins: { "@tailwindcss/postcss": {} } };\n`,
    );

    writeFileSync(
      path.join(consumerDir, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            lib: ["dom", "dom.iterable", "esnext"],
            allowJs: true,
            skipLibCheck: true,
            strict: true,
            noEmit: true,
            esModuleInterop: true,
            module: "esnext",
            moduleResolution: "bundler",
            resolveJsonModule: true,
            isolatedModules: true,
            jsx: "preserve",
            incremental: true,
            plugins: [{ name: "next" }],
          },
          include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
          exclude: ["node_modules"],
        },
        null,
        2,
      ),
    );

    // Write consumer server wiring + custom Next.js pages + API routes
    mkdirSync(path.join(consumerDir, "lib"), { recursive: true });
    writeFileSync(
      path.join(consumerDir, "lib/server.ts"),
      `import path from "node:path";
import { createAppAuth } from "@arrusted/auth/server";
import { createAppRoutes, createGeneratedAppRuntime, ResilientPool } from "@arrusted/core";
import { definition } from "../.generated/release/data-operations";

const releaseDirectory = path.join(process.cwd(), ".generated/release");
const databaseUrl = process.env.APP_DATABASE_URL ?? "postgres://placeholder:placeholder@127.0.0.1:5432/placeholder";
const origin = process.env.AUTH_ORIGIN ?? "http://127.0.0.1:3000";
const secret = process.env.AUTH_SECRET ?? "${authSecret}";

export const authPool = new ResilientPool({
  connectionString: databaseUrl,
  searchPath: "auth_crm",
  max: 2,
});

export const appAuth = createAppAuth({
  database: authPool,
  authSchema: "auth_crm",
  origin,
  secret,
  appId: "sunlight-crm",
  organizationId: "sunlight",
  name: "Sunlight CRM",
});

let cachedRuntime: ReturnType<typeof createGeneratedAppRuntime> | undefined;
export function getRuntime() {
  cachedRuntime ??= createGeneratedAppRuntime({
    databaseUrl,
    releaseDirectory,
    appId: "sunlight",
    customerId: "sunlight",
  });
  return cachedRuntime;
}

export function getRoutes() {
  return createAppRoutes({
    runtime: getRuntime(),
    definition,
    session: (headers) => appAuth.session(headers),
    releaseDirectory,
    role: "crm_user",
  });
}
`,
    );

    mkdirSync(path.join(consumerDir, "app/api/auth/[...all]"), { recursive: true });
    writeFileSync(
      path.join(consumerDir, "app/api/auth/[...all]/route.ts"),
      `import { toNextJsHandler } from "@arrusted/auth/server";
import { appAuth } from "../../../../lib/server";

export const { GET, POST } = toNextJsHandler(appAuth.auth);
`,
    );

    mkdirSync(path.join(consumerDir, "app/api/schema/active"), { recursive: true });
    writeFileSync(
      path.join(consumerDir, "app/api/schema/active/route.ts"),
      `import { getRoutes } from "../../../../lib/server";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return getRoutes().schemaActiveGET(request);
}
`,
    );

    mkdirSync(path.join(consumerDir, "app/api/records"), { recursive: true });
    writeFileSync(
      path.join(consumerDir, "app/api/records/route.ts"),
      `import { getRoutes } from "../../../lib/server";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return getRoutes().recordsGET(request);
}
`,
    );

    mkdirSync(path.join(consumerDir, "app/api/apply"), { recursive: true });
    writeFileSync(
      path.join(consumerDir, "app/api/apply/route.ts"),
      `import { getRoutes } from "../../../lib/server";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  return getRoutes().applyPOST(request);
}
`,
    );

    mkdirSync(path.join(consumerDir, "app/companies"), { recursive: true });
    writeFileSync(
      path.join(consumerDir, "app/companies/page.tsx"),
      `import { headers } from "next/headers";
import { createOperations } from "../../.generated/release/data-operations";
import { appAuth, getRuntime } from "../../lib/server";

export const dynamic = "force-dynamic";

export default async function CompaniesServerPage() {
  const { actorId } = await appAuth.session(await headers());
  const ops = createOperations(
    getRuntime().dataContext({
      actorId,
      sourceKind: "human",
      authorize: async () => {},
    }),
  );
  const companies = await ops.company.list({
    asOf: "2026-11-27",
    select: ["id", "$version", "name", "domain"],
  });
  return (
    <main className="p-6">
      <h1>Companies ({companies.length})</h1>
      <ul>
        {companies.map((c) => (
          <li key={c.id}>{c.name} - {c.domain ?? "no-domain"}</li>
        ))}
      </ul>
    </main>
  );
}
`,
    );

    writeFileSync(
      path.join(consumerDir, "app/globals.css"),
      `@import "tailwindcss";
@import "@arrusted/ui/styles.css";
`,
    );

    writeFileSync(
      path.join(consumerDir, "app/layout.tsx"),
      `import type { ReactNode } from "react";
import "./globals.css";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
    );

    writeFileSync(path.join(consumerDir, "app/page.tsx"), consumerPageTsx("basic"));

    // 4. Commit v1 in consumer git repo, run `arrusted compile` and `arrusted migrate`
    runClean(path.join(isolatedBinDir, "git"), ["add", "-A"], { cwd: consumerDir });
    runClean(path.join(isolatedBinDir, "git"), ["commit", "-m", "v1 initial consumer app"], {
      cwd: consumerDir,
    });

    const compileOut = runClean(path.join(consumerDir, "node_modules/.bin/arrusted"), ["compile"], {
      cwd: consumerDir,
    });
    expect(compileOut).toContain("Compiled sunlight build-");
    const buildMeta = JSON.parse(
      readFileSync(path.join(consumerDir, ".generated/build.json"), "utf8"),
    ) as { packageVersion?: string };
    expect(buildMeta.packageVersion).toBe("0.1.0-alpha.2");

    const migrationEnv = {
      MIGRATION_DATABASE_URL: ownerDatabaseUrl,
      APP_DATABASE_URL: crmDatabaseUrl,
      AUTH_DATABASE_URL: crmDatabaseUrl,
      AUTH_SCHEMA: "auth_crm",
      APP_KERNEL_ROLE: "crm_user",
      RESTORE_POINTS_DIR: restoreDir,
    };
    const migrateV1Out = runClean(
      path.join(consumerDir, "node_modules/.bin/arrusted"),
      ["migrate"],
      { cwd: consumerDir, env: migrationEnv },
    );
    expect(migrateV1Out).toContain("Migration applied.");
    expect(readFileSync(path.join(consumerDir, ".local/.gitignore"), "utf8")).toBe("*\n");

    // 5. Typecheck + Next.js production build (analytics="basic", NO ag-grid-enterprise!)
    runClean(path.join(consumerDir, "node_modules/.bin/tsc"), ["--noEmit"], {
      cwd: consumerDir,
    });
    runClean(path.join(consumerDir, "node_modules/.bin/next"), ["build"], {
      cwd: consumerDir,
      env: { NODE_ENV: "production" },
    });

    // 6. Boot the built Next.js server and exercise closed sign-up, people add/remove,
    //    /api/schema/active, /api/apply, /api/records, and Server Component /companies!
    const port = await allocateFreePort();
    const origin = `http://127.0.0.1:${port}`;
    const nextProc = spawn(
      path.join(consumerDir, "node_modules/.bin/next"),
      ["start", "-p", String(port), "-H", "127.0.0.1"],
      {
        cwd: consumerDir,
        env: makeCleanEnvironment({
          NODE_ENV: "production",
          APP_DATABASE_URL: crmDatabaseUrl,
          AUTH_ORIGIN: origin,
          AUTH_SECRET: authSecret,
        }),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    try {
      await waitForServer(origin, nextProc);

      // Closed sign-up by default: public sign-up endpoint is disabled
      const openSignUpRes = await fetch(`${origin}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: "intruder@sunlight.test",
          password: "Password1234!",
          name: "Intruder",
        }),
      });
      expect(openSignUpRes.ok).toBe(false);

      // Provision Alice via `arrusted-auth people add` (secret written to 0600 auth_crm--alice@sunlight.test.txt)
      const addOut = runClean(
        path.join(consumerDir, "node_modules/.bin/arrusted-auth"),
        [
          "people",
          "add",
          "alice@sunlight.test",
          "--name",
          "Alice Sunlight",
          "--org",
          "sunlight",
          "--schema",
          "auth_crm",
        ],
        {
          cwd: consumerDir,
          env: { AUTH_DATABASE_URL: crmDatabaseUrl },
        },
      );
      const aliceCredPath = path.join(
        consumerDir,
        ".local/credentials/auth_crm--alice@sunlight.test.txt",
      );
      expect(addOut).toContain(`Temporary password written to ${aliceCredPath}`);
      const alicePassword = readFileSync(aliceCredPath, "utf8").trim();
      expect(alicePassword.length).toBeGreaterThanOrEqual(16);
      expect(addOut).not.toContain(alicePassword);
      expect(statSync(aliceCredPath).mode & 0o777).toBe(0o600);

      // Provision Bob: secret is written to a 0600 file and never echoed to stdout
      const bobAddOut = runClean(
        path.join(consumerDir, "node_modules/.bin/arrusted-auth"),
        [
          "people",
          "add",
          "bob@sunlight.test",
          "--name",
          "Bob Sunlight",
          "--org",
          "sunlight",
          "--schema",
          "auth_crm",
        ],
        {
          cwd: consumerDir,
          env: { AUTH_DATABASE_URL: crmDatabaseUrl },
        },
      );
      const bobCredPath = path.join(
        consumerDir,
        ".local/credentials/auth_crm--bob@sunlight.test.txt",
      );
      expect(bobAddOut).toContain(`Temporary password written to ${bobCredPath}`);
      const bobPassword = readFileSync(bobCredPath, "utf8").trim();
      expect(bobPassword.length).toBeGreaterThanOrEqual(16);
      expect(bobAddOut).not.toContain(bobPassword);
      expect(statSync(bobCredPath).mode & 0o777).toBe(0o600);
      const bobSignInRes = await fetch(`${origin}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: "bob@sunlight.test",
          password: bobPassword,
        }),
      });
      expect(bobSignInRes.status).toBe(200);

      // Verify .local/.gitignore excludes restore-points & credentials from git status
      const gitPorcelain = runClean(path.join(isolatedBinDir, "git"), ["status", "--porcelain"], {
        cwd: consumerDir,
      });
      expect(gitPorcelain).not.toContain(".local");

      // Sign in as Alice
      const signInRes = await fetch(`${origin}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: "alice@sunlight.test",
          password: alicePassword,
        }),
      });
      expect(signInRes.status).toBe(200);
      const rawSetCookie = signInRes.headers.getSetCookie
        ? signInRes.headers
            .getSetCookie()
            .map((c) => c.split(";")[0])
            .join("; ")
        : (signInRes.headers.get("set-cookie") ?? "");
      expect(rawSetCookie).toContain("better-auth");

      // GET /api/schema/active
      const schemaRes = await fetch(`${origin}/api/schema/active`, {
        headers: { cookie: rawSetCookie },
      });
      expect(schemaRes.status).toBe(200);
      const schemaPayload = (await schemaRes.json()) as {
        schema: { models: Array<{ id: string }> };
      };
      expect(schemaPayload.schema.models.map((m) => m.id)).toEqual(["company", "deal"]);

      // POST /api/apply (create "Sunlight Labs" as EditableRowVersionGrid submits it)
      const applyRes = await fetch(`${origin}/api/apply`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: rawSetCookie,
          origin,
        },
        body: JSON.stringify({
          app_id: "sunlight",
          customer_id: "sunlight",
          actor_id: "client-placeholder",
          source_kind: "user",
          change_type_id: "manual_edit",
          idempotency_key: "clean-machine-create-1",
          writes: [
            {
              model_id: "company",
              effective_start: "2026-11-27",
              values: {
                name: { type: "text", value: "Sunlight Labs" },
                domain: { type: "text", value: "sunlight.example" },
              },
            },
          ],
        }),
      });
      expect(applyRes.status).toBe(200);

      // GET /api/records
      const recordsRes = await fetch(`${origin}/api/records?model_id=company&as_of=2026-11-27`, {
        headers: { cookie: rawSetCookie },
      });
      expect(recordsRes.status).toBe(200);
      const records = (await recordsRes.json()) as Array<{
        record_id: string;
        values: Record<string, { type: string; value: string }>;
      }>;
      expect(records).toHaveLength(1);
      expect(records[0]?.values.name?.value).toBe("Sunlight Labs");

      // GET /companies Server Component (proves generated data-operations.ts works in RSC!)
      const companiesHtmlRes = await fetch(`${origin}/companies`, {
        headers: { cookie: rawSetCookie },
      });
      expect(companiesHtmlRes.status).toBe(200);
      const companiesHtml = await companiesHtmlRes.text();
      expect(companiesHtml).toContain("Sunlight Labs");

      // `arrusted-auth people remove` revokes session & kernel membership immediately
      const removeOut = runClean(
        path.join(consumerDir, "node_modules/.bin/arrusted-auth"),
        ["people", "remove", "alice@sunlight.test", "--org", "sunlight", "--schema", "auth_crm"],
        {
          cwd: consumerDir,
          env: { AUTH_DATABASE_URL: crmDatabaseUrl },
        },
      );
      expect(removeOut).toContain("Removed alice@sunlight.test");

      const afterRemoveRes = await fetch(
        `${origin}/api/records?model_id=company&as_of=2026-11-27`,
        { headers: { cookie: rawSetCookie } },
      );
      expect([401, 403]).toContain(afterRemoveRes.status);
    } finally {
      nextProc.kill("SIGTERM");
    }

    // 7. Re-add Alice, evolve schema additively (v2), migrate, then undo back to v1!
    runClean(
      path.join(consumerDir, "node_modules/.bin/arrusted-auth"),
      ["people", "add", "alice@sunlight.test", "--org", "sunlight", "--schema", "auth_crm"],
      { cwd: consumerDir, env: { AUTH_DATABASE_URL: crmDatabaseUrl } },
    );

    writeFileSync(
      path.join(consumerDir, "schema/app.cue"),
      consumerCueSchema(',\n        {id: "linkedin_url", label: "LinkedIn", type: "text"}'),
    );
    runClean(path.join(isolatedBinDir, "git"), ["add", "schema/app.cue"], { cwd: consumerDir });
    runClean(path.join(isolatedBinDir, "git"), ["commit", "-m", "v2 add linkedin_url"], {
      cwd: consumerDir,
    });

    runClean(path.join(consumerDir, "node_modules/.bin/arrusted"), ["compile"], {
      cwd: consumerDir,
    });
    const migrateV2Out = runClean(
      path.join(consumerDir, "node_modules/.bin/arrusted"),
      ["migrate"],
      { cwd: consumerDir, env: migrationEnv },
    );
    expect(migrateV2Out).toContain("Migration applied.");

    // Revert CUE schema back to v1 commit & run `arrusted migrate:undo`
    runClean(path.join(isolatedBinDir, "git"), ["checkout", "HEAD~1", "--", "schema/app.cue"], {
      cwd: consumerDir,
    });
    runClean(path.join(isolatedBinDir, "git"), ["commit", "-m", "revert to v1 schema"], {
      cwd: consumerDir,
    });
    runClean(path.join(consumerDir, "node_modules/.bin/arrusted"), ["compile"], {
      cwd: consumerDir,
    });
    const undoOut = runClean(
      path.join(consumerDir, "node_modules/.bin/arrusted"),
      ["migrate:undo"],
      { cwd: consumerDir, env: migrationEnv },
    );
    expect(undoOut).toContain("Database and applied-schema record restored");

    // 8. Prove `analytics="advanced"` tier:
    //    - Install ag-grid-enterprise into consumer app
    //    - Without NEXT_PUBLIC_AG_GRID_LICENSE_KEY, `next build` fails closed in production!
    //    - With NEXT_PUBLIC_AG_GRID_LICENSE_KEY set, `tsc --noEmit` & `next build` succeed!
    runClean(
      path.join(isolatedBinDir, "bun"),
      ["add", `ag-grid-enterprise@${rootCatalog["ag-grid-enterprise"]}`],
      { cwd: consumerDir },
    );

    writeFileSync(path.join(consumerDir, "app/page.tsx"), consumerPageTsx("advanced"));

    runClean(path.join(consumerDir, "node_modules/.bin/tsc"), ["--noEmit"], {
      cwd: consumerDir,
    });

    expect(() =>
      runClean(path.join(consumerDir, "node_modules/.bin/next"), ["build"], {
        cwd: consumerDir,
        env: { NODE_ENV: "production", NEXT_PUBLIC_AG_GRID_LICENSE_KEY: "" },
      }),
    ).toThrow(/NEXT_PUBLIC_AG_GRID_LICENSE_KEY/);

    runClean(path.join(consumerDir, "node_modules/.bin/next"), ["build"], {
      cwd: consumerDir,
      env: {
        NODE_ENV: "production",
        NEXT_PUBLIC_AG_GRID_LICENSE_KEY: "test-production-license-key",
      },
    });
  },
  240_000,
);
