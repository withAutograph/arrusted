import { test, expect } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import {
  checkBuildOutput,
  confirm,
  createGateIO,
  loopback,
  preflight,
  productionGate,
  requireNonLoopback,
  type GateIO,
} from "./production-gate";
import {
  appliedRelease,
  buildPrebuilt,
  release,
  resolveProductionEnv,
  schemaForPlan,
  schemaPlan,
  validateProductionDatabaseUrls,
} from "./release";
import {
  ENV_LOCAL,
  ENV_MIGRATE,
  ENV_PROD_MIGRATE,
  ENV_PROD_SECRETS,
  applyProductionNeonEnv,
  pushSecrets,
  putEnv,
  readEnv,
  setupEnv,
  validatedOrigin,
} from "./local-secrets";
import { safeEmailFileName, writePersonLink } from "./people";
import { SafeError, redact, reportError } from "./safe-output";

const pgTestUrl =
  process.env.SAFETY_TEST_DATABASE_URL ??
  process.env.SINGLE_ORG_TEST_DATABASE_URL ??
  process.env.TEST_DATABASE_URL ??
  process.env.KERNEL_TEST_DATABASE_URL;
if (!pgTestUrl && process.env.CI)
  throw new Error("SAFETY_TEST_DATABASE_URL (or SINGLE_ORG_TEST_DATABASE_URL) is required in CI.");
const pgTest = pgTestUrl ? test : test.skip;

function fake(overrides: Partial<GateIO> = {}): GateIO {
  return {
    git: (args) => {
      if (args[0] === "remote") return "origin";
      if (args[0] === "branch") return "main";
      if (args[0] === "ls-remote") return "ref: refs/heads/main\tHEAD\n123\tHEAD";
      if (args[0] === "rev-parse") return "123";
      return "";
    },
    check() {},
    linked: () => true,
    sourceCommit: () => "123",
    appName: () => "Starter",
    tty: () => true,
    ask: async () => "Starter",
    log() {},
    ...overrides,
  };
}

test("preflight rejects dirty, untracked, feature, unpushed, fetch failure, missing link and provenance", async () => {
  for (const [, args, value] of [
    ["dirty", "status", " M file"],
    ["untracked", "status", "?? file"],
    ["feature", "branch", "feat/safe-defaults"],
  ])
    await expect(
      preflight(false, fake({ git: (a) => (a[0] === args ? value! : fake().git(a)) })),
    ).rejects.toThrow();
  await expect(
    preflight(
      false,
      fake({ git: (a) => (a[0] === "rev-parse" && a[1] === "HEAD" ? "456" : fake().git(a)) }),
    ),
  ).rejects.toThrow("HEAD");
  await expect(
    preflight(
      false,
      fake({
        git: (a) => {
          if (a[0] === "fetch") throw Error("network");
          return fake().git(a);
        },
      }),
    ),
  ).rejects.toThrow();
  await expect(
    preflight(
      false,
      fake({
        git: (a) =>
          a[0] === "ls-remote" ? "ref: refs/heads/main\tHEAD\n456\tHEAD" : fake().git(a),
      }),
    ),
  ).rejects.toThrow("HEAD");
  await expect(preflight(false, fake({ linked: () => false }))).rejects.toThrow("Vercel");
  await expect(preflight(false, fake({ sourceCommit: () => "old" }))).rejects.toThrow(
    "source commit",
  );
  await expect(
    preflight(
      false,
      fake({
        check: () => {
          throw Error("check failed");
        },
      }),
    ),
  ).rejects.toThrow();
});

test("no remote requires explicit local-only mode, default branch, and dynamic app name confirmation", async () => {
  const io = fake({ git: (a) => (a[0] === "remote" ? "" : fake().git(a)) });
  await expect(preflight(false, io)).rejects.toThrow("No remote");
  await preflight(true, io);
  await confirm(io);
  await expect(confirm(fake({ tty: () => false }))).rejects.toThrow("terminal");
  await expect(confirm(fake({ ask: async () => "yes" }))).rejects.toThrow("match");
  await expect(preflight(false, fake({ tty: () => false }))).rejects.toThrow("terminal");

  // App name is read from app config / io.appName, not hardcoded to "Starter".
  let askedPrompt = "";
  const customIo = fake({
    appName: () => "Acme CRM",
    ask: async (p) => {
      askedPrompt = p;
      return "Acme CRM";
    },
  });
  await confirm(customIo);
  expect(askedPrompt).toContain("Acme CRM");
  await expect(confirm({ ...customIo, ask: async () => "Starter" })).rejects.toThrow("match");
});

test("real gateIO against real temp git repos with bare remote: ok, repo-level link, dirty, untracked, feature branch, unpushed, behind", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "real-gate-"));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.test",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.test",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    const bare = path.join(root, "remote.git");
    const repo = path.join(root, "repo");
    const other = path.join(root, "other");
    mkdirSync(bare);
    git(bare, "init", "--bare", "--initial-branch=main");
    git(root, "clone", bare, repo);
    git(repo, "checkout", "-b", "main");
    const appDir = path.join(repo, "app");
    mkdirSync(path.join(appDir, "schema"), { recursive: true });
    mkdirSync(path.join(appDir, ".generated"), { recursive: true });
    writeFileSync(
      path.join(appDir, "schema/app.cue"),
      'package schema\nmanifest: { app_id: "acme", customer_id: "acme", label: "Acme App" }\n',
    );
    writeFileSync(path.join(repo, ".gitignore"), "app/.generated/\n.vercel/\napp/.vercel/\n");
    writeFileSync(path.join(repo, "tracked.txt"), "v1\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "initial");
    git(repo, "push", "-u", "origin", "main");
    const head = git(repo, "rev-parse", "HEAD");
    writeFileSync(
      path.join(appDir, ".generated/build.json"),
      JSON.stringify({ sourceCommit: head }),
    );
    mkdirSync(path.join(appDir, ".vercel"), { recursive: true });
    writeFileSync(
      path.join(appDir, ".vercel/project.json"),
      JSON.stringify({ projectId: "prj_1", orgId: "team_1" }),
    );

    const io = createGateIO({
      appDir,
      repoRoot: repo,
      check: () => {},
      tty: () => true,
      log: () => {},
    });
    expect(io.appName?.()).toBe("Acme App");

    // 1. ok (with app-level Vercel link)
    await preflight(false, io);

    // 2. ok (with repo-level Vercel link)
    rmSync(path.join(appDir, ".vercel"), { recursive: true, force: true });
    await expect(preflight(false, io)).rejects.toThrow("Vercel");
    mkdirSync(path.join(repo, ".vercel"), { recursive: true });
    writeFileSync(
      path.join(repo, ".vercel/project.json"),
      JSON.stringify({ projectId: "prj_1", orgId: "team_1" }),
    );
    await preflight(false, io);

    // 3. dirty tracked file
    writeFileSync(path.join(repo, "tracked.txt"), "dirty\n");
    await expect(preflight(false, io)).rejects.toThrow("clean");
    writeFileSync(path.join(repo, "tracked.txt"), "v1\n");

    // 4. untracked file
    writeFileSync(path.join(repo, "untracked.txt"), "hi\n");
    await expect(preflight(false, io)).rejects.toThrow("clean");
    rmSync(path.join(repo, "untracked.txt"));

    // 5. feature branch
    git(repo, "checkout", "-b", "feat/other");
    await expect(preflight(false, io)).rejects.toThrow("default branch");
    git(repo, "checkout", "main");

    // 6. unpushed commit
    writeFileSync(path.join(repo, "tracked.txt"), "v2\n");
    git(repo, "add", "tracked.txt");
    git(repo, "commit", "-m", "unpushed");
    await expect(preflight(false, io)).rejects.toThrow("HEAD");
    git(repo, "reset", "--hard", "origin/main");

    // 7. behind remote
    git(root, "clone", bare, other);
    writeFileSync(path.join(other, "tracked.txt"), "remote-v2\n");
    git(other, "add", "tracked.txt");
    git(other, "commit", "-m", "remote ahead");
    git(other, "push", "origin", "main");
    await expect(preflight(false, io)).rejects.toThrow("HEAD");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkBuildOutput accepts clean output (including .env.example) and refuses .env* or .local in files or .vc-config.json filePathMap", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "build-output-check-"));
  try {
    expect(() => checkBuildOutput(dir)).toThrow(/\.vercel\/output/);
    const funcDir = path.join(dir, ".vercel/output/functions/index.func");
    mkdirSync(funcDir, { recursive: true });
    writeFileSync(path.join(funcDir, ".env.example"), "APP_DATABASE_URL=\n");
    writeFileSync(path.join(funcDir, ".env.migrate.example"), "MIGRATION_DATABASE_URL=\n");
    writeFileSync(
      path.join(funcDir, ".vc-config.json"),
      JSON.stringify({
        filePathMap: {
          "app/.env.example": "app/.env.example",
          "app/index.js": "app/index.js",
        },
      }),
    );
    checkBuildOutput(dir);

    // File path containing .env.* (non-example) is refused.
    const leakedEnv = path.join(funcDir, ".env.production.secrets");
    writeFileSync(leakedEnv, "SECRET=1\n");
    expect(() => checkBuildOutput(dir)).toThrow(/\.env\.production\.secrets/);
    rmSync(leakedEnv);

    // File path containing .local segment is refused.
    mkdirSync(path.join(funcDir, ".local/people"), { recursive: true });
    writeFileSync(path.join(funcDir, ".local/people/alice.txt"), "link\n");
    expect(() => checkBuildOutput(dir)).toThrow(/\.local/);
    rmSync(path.join(funcDir, ".local"), { recursive: true, force: true });

    // filePathMap value containing .env is refused.
    writeFileSync(
      path.join(funcDir, ".vc-config.json"),
      JSON.stringify({ filePathMap: { "safe.txt": "app/.env" } }),
    );
    expect(() => checkBuildOutput(dir)).toThrow(/app\/\.env/);

    // filePathMap key containing .local is refused.
    writeFileSync(
      path.join(funcDir, ".vc-config.json"),
      JSON.stringify({ filePathMap: { ".local/restore-points/a.dump": "safe.txt" } }),
    );
    expect(() => checkBuildOutput(dir)).toThrow(/\.local\/restore-points\/a\.dump/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hosted mutation gate confirms; loopback accepts legitimate Postgres params and refuses host overrides with accurate messages", async () => {
  let prompts = 0;
  const io = fake({
    ask: async () => {
      prompts++;
      return "Starter";
    },
  });
  await productionGate("postgresql://user@localhost/db", "plan", false, io);
  expect(prompts).toBe(0);
  await productionGate("postgresql://user@db.example/db", "plan", false, io);
  expect(prompts).toBe(1);
  expect(
    loopback(
      "postgresql://user:pass@ep-cool.us-east-2.aws.neon.tech/neondb?sslmode=require&options=endpoint%3Dep-cool&application_name=starter",
    ),
  ).toBe(false);
  expect(
    loopback(
      "postgresql://user@localhost/db?options=-c%20search_path%3Dpublic&application_name=dev",
    ),
  ).toBe(true);
  expect(() => loopback("invalid")).toThrow(/malformed/i);
  expect(() => loopback("postgresql://user@localhost/db?host=production.example")).toThrow(/host/i);
  expect(() => loopback("postgresql://user@localhost/db?hostaddr=198.51.100.1")).toThrow(
    /hostaddr/i,
  );
  expect(() => loopback("postgresql://user@localhost/db?service=prod")).toThrow(/service/i);
  expect(() => loopback("postgres://user:pw@prod.example.com%00.localhost/db")).toThrow(
    /percent-encoded/i,
  );
  expect(() => loopback("https://user@localhost/db")).toThrow(/postgres:\/\//i);
});

test("release order, local build before confirm/migrate, release --check (requires TTY/runs build/no side effects), and failure safety", async () => {
  const calls: string[] = [];
  const logs: string[] = [];
  const io = {
    gate: fake({
      check: () => {
        calls.push("check");
      },
      ask: async () => {
        calls.push("confirm");
        return "Starter";
      },
      log: (m) => {
        logs.push(m);
      },
    }),
    plan: async () => {
      calls.push("plan");
      return "Add field Note.summary (optional; existing records remain empty).";
    },
    build: () => {
      calls.push("build");
    },
    migrate: async () => {
      calls.push("migrate");
    },
    matches: async () => {
      calls.push("verify");
      return true;
    },
    deploy: () => {
      calls.push("deploy");
      return "https://starter-prod.vercel.app";
    },
  };

  // --check mode requires a real TTY just like release.
  await expect(
    release({ ...io, gate: { ...io.gate, tty: () => false } }, false, { checkOnly: true }),
  ).rejects.toThrow("terminal");
  expect(calls).toEqual([]);

  // --check mode with TTY runs preflight + plan + local build, never confirms/migrates/deploys.
  await release(io, false, { checkOnly: true });
  expect(calls).toEqual(["check", "plan", "build"]);
  expect(logs.join("\n")).toContain("Add field Note.summary");
  expect(logs.join("\n")).toContain("No database migration or deployment was run");

  // Failed build stops release before confirmation or migration.
  calls.length = 0;
  await expect(
    release({
      ...io,
      build: () => {
        calls.push("build");
        throw new SafeError("Build output contains private path: .env");
      },
    }),
  ).rejects.toThrow("private path");
  expect(calls).toEqual(["check", "plan", "build"]);

  // Full release: builds locally before confirmation, then migrates, verifies, deploys.
  calls.length = 0;
  logs.length = 0;
  await release(io);
  expect(calls).toEqual(["check", "plan", "build", "confirm", "migrate", "verify", "deploy"]);
  expect(logs.join("\n")).toContain("https://starter-prod.vercel.app");
  expect(logs.join("\n")).toContain("Creating restore point and applying database migration");

  calls.length = 0;
  await expect(
    release({
      ...io,
      migrate: async () => {
        throw Error("failed");
      },
    }),
  ).rejects.toThrow();
  expect(calls).not.toContain("deploy");
  await expect(release({ ...io, matches: async () => false })).rejects.toThrow("differs");
  expect(calls).not.toContain("deploy");
  await expect(
    release({
      ...io,
      deploy: () => {
        throw Error("vercel deploy failed");
      },
    }),
  ).rejects.toThrow("Database migration succeeded");
});

test("buildPrebuilt runs vercel pull then build, deletes pulled .vercel/.env* files, validates output, and redacts failures", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "prebuilt-vercel-"));
  const previous = {
    PATH: process.env.PATH,
    CAPTURE_ARGS: process.env.CAPTURE_ARGS,
    FAKE_MODE: process.env.FAKE_MODE,
  };
  try {
    const argsFile = path.join(dir, "args");
    mkdirSync(path.join(dir, ".vercel"), { recursive: true });
    writeFileSync(
      path.join(dir, "vercel"),
      [
        "#!/bin/sh",
        'printf "%s\\n" "$*" >> "$CAPTURE_ARGS"',
        'if [ "$1" = "pull" ]; then',
        '  printf "SECRET=top-secret-value-123456\\n" > .vercel/.env.production.local',
        "  exit 0",
        "fi",
        'if [ "$FAKE_MODE" = "fail-build" ]; then',
        '  echo "build failed with postgresql://owner:super-secret-pw@db.example/app" >&2',
        "  exit 1",
        "fi",
        "mkdir -p .vercel/output/functions/index.func",
        'printf \'{"filePathMap":{"app/page.js":"app/page.js"}}\' > .vercel/output/functions/index.func/.vc-config.json',
        'if [ "$FAKE_MODE" = "leak-output" ]; then',
        '  printf "SECRET=1\\n" > .vercel/output/functions/index.func/.env.local',
        "fi",
      ].join("\n") + "\n",
      { mode: 0o700 },
    );
    process.env.PATH = `${dir}:${previous.PATH ?? ""}`;
    process.env.CAPTURE_ARGS = argsFile;

    // 1. Clean build succeeds and removes pulled .vercel/.env.production.local.
    process.env.FAKE_MODE = "ok";
    buildPrebuilt(dir);
    expect(readFileSync(argsFile, "utf8").trim().split("\n")).toEqual([
      "pull --yes --environment production",
      "build --prod",
    ]);
    expect(existsSync(path.join(dir, ".vercel/.env.production.local"))).toBe(false);

    // 2. Failed build still removes pulled .vercel/.env.production.local and redacts stderr.
    process.env.FAKE_MODE = "fail-build";
    let caught: unknown;
    try {
      buildPrebuilt(dir);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain("super-secret-pw");
    expect((caught as Error).message).toContain("[REDACTED]");
    expect(existsSync(path.join(dir, ".vercel/.env.production.local"))).toBe(false);

    // 3. Build output containing .env.local is refused by checkBuildOutput.
    process.env.FAKE_MODE = "leak-output";
    expect(() => buildPrebuilt(dir)).toThrow(/\.env\.local/);
    expect(existsSync(path.join(dir, ".vercel/.env.production.local"))).toBe(false);
  } finally {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release validates production DB URLs (refuses loopback, same role, mismatched target, pooler) and appliedRelease uses connectionTarget", async () => {
  const mig = "postgresql://owner:owner-secret-pw@ep-prod.neon.tech/app?sslmode=verify-full";
  const app = "postgresql://runtime:runtime-secret-pw@ep-prod.neon.tech/app?sslmode=verify-full";
  expect(
    validateProductionDatabaseUrls({ migrationDatabaseUrl: mig, appDatabaseUrl: app }),
  ).toMatchObject({ runtimeRole: "runtime", authRole: "runtime" });

  // Loopback production URLs refused.
  expect(() =>
    validateProductionDatabaseUrls({
      migrationDatabaseUrl: "postgresql://owner:pw@127.0.0.1:5432/app",
      appDatabaseUrl: app,
    }),
  ).toThrow(/loopback/i);
  expect(() =>
    validateProductionDatabaseUrls({
      migrationDatabaseUrl: mig,
      appDatabaseUrl: "postgresql://runtime:pw@localhost:5432/app",
    }),
  ).toThrow(/loopback/i);

  // Same login as migrator refused via runtimeRoles.
  expect(() =>
    validateProductionDatabaseUrls({
      migrationDatabaseUrl: mig,
      appDatabaseUrl:
        "postgresql://owner:runtime-secret-pw@ep-prod.neon.tech/app?sslmode=verify-full",
    }),
  ).toThrow(/separate unprivileged/);

  // Pooler or mismatched database refused via connectionTarget/runtimeRoles.
  expect(() =>
    validateProductionDatabaseUrls({
      migrationDatabaseUrl:
        "postgresql://owner:owner-secret-pw@ep-prod-pooler.neon.tech/app?sslmode=verify-full",
      appDatabaseUrl: app,
    }),
  ).toThrow(/protected_installer_identity_mismatch/);
  expect(() =>
    validateProductionDatabaseUrls({
      migrationDatabaseUrl: mig,
      appDatabaseUrl:
        "postgresql://runtime:runtime-secret-pw@ep-prod.neon.tech/other_db?sslmode=verify-full",
    }),
  ).toThrow(/protected_installer_identity_mismatch/);

  // appliedRelease validates URL via connectionTarget before opening a Pool.
  await expect(
    appliedRelease("postgresql://owner:pw@ep-prod-pooler.neon.tech/app?sslmode=verify-full"),
  ).rejects.toThrow(/protected_installer_identity_mismatch/);

  // Shared production validators used across release, migrate, records-import, people, and secrets:push.
  expect(() =>
    requireNonLoopback("MIGRATION_DATABASE_URL", "postgresql://owner:pw@localhost:5432/app"),
  ).toThrow(/loopback/i);
  requireNonLoopback("MIGRATION_DATABASE_URL", mig);
  expect(() => validatedOrigin("http://app.example.com", ENV_PROD_SECRETS, true)).toThrow(
    "https://",
  );
  expect(() => validatedOrigin("https://localhost:3000", ENV_PROD_SECRETS, true)).toThrow(
    "loopback",
  );
  expect(validatedOrigin("https://app.example.com", ENV_PROD_SECRETS, true).origin).toBe(
    "https://app.example.com",
  );
});

test("production mode reads NEON_* exclusively from .env.production.migrate and deletes inherited values when absent", () => {
  const target: Record<string, string | undefined> = {
    NEON_API_KEY: "inherited-key",
    NEON_PROJECT_ID: "inherited-proj",
    NEON_BRANCH_ID: "inherited-branch",
    UNRELATED: "keep",
  };
  applyProductionNeonEnv({}, target);
  expect(target.NEON_API_KEY).toBeUndefined();
  expect(target.NEON_PROJECT_ID).toBeUndefined();
  expect(target.NEON_BRANCH_ID).toBeUndefined();
  expect(target.UNRELATED).toBe("keep");

  applyProductionNeonEnv({ NEON_API_KEY: "prod-key", NEON_PROJECT_ID: "prod-proj" }, target);
  expect(target.NEON_API_KEY).toBe("prod-key");
  expect(target.NEON_PROJECT_ID).toBe("prod-proj");
  expect(target.NEON_BRANCH_ID).toBeUndefined();

  const dir = mkdtempSync(path.join(tmpdir(), "neon-env-test-"));
  try {
    putEnv(path.join(dir, ENV_PROD_MIGRATE), {
      MIGRATION_DATABASE_URL: "postgresql://owner:pw@ep.neon.tech/app?sslmode=verify-full",
    });
    const envObj: Record<string, string | undefined> = {
      NEON_API_KEY: "stale-local-key",
      NEON_PROJECT_ID: "stale-proj",
      NEON_BRANCH_ID: "stale-branch",
    };
    const resolved = resolveProductionEnv(dir, envObj);
    expect(envObj.NEON_API_KEY).toBeUndefined();
    expect(envObj.NEON_PROJECT_ID).toBeUndefined();
    expect(envObj.NEON_BRANCH_ID).toBeUndefined();
    // Redact map still retained the inherited secret for error redaction.
    expect(resolved.secretEnv.NEON_API_KEY).toBe("stale-local-key");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schema plan describes additions, renames, archives, required fields and no changes", () => {
  const old = {
    models: [
      {
        id: "a",
        label: "Old",
        fields: [
          { id: "x", label: "X" },
          { id: "gone", label: "Gone" },
        ],
      },
      { id: "gone", label: "Gone table", fields: [] },
    ],
  };
  const next = {
    models: [
      {
        id: "a",
        label: "New",
        fields: [
          { id: "x", label: "Renamed", required: true },
          { id: "new", label: "Added" },
        ],
      },
      { id: "new", label: "New table", fields: [] },
    ],
  };
  const text = schemaPlan(old, next);
  for (const expected of [
    "Rename table",
    "Rename New.X",
    "Require",
    "Archive New.Gone",
    "Archive table",
    "Add field",
    "Add table",
  ])
    expect(text).toContain(expected);
  expect(schemaPlan(next, next)).toContain("No table or field changes");
});

test("writePersonLink writes mode 0600 file inside mode 0700 .local/people directory", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "people-link-test-"));
  try {
    const file = writePersonLink(
      dir,
      "alice@example.test",
      "http://localhost:3000/auth/set-password#token=abc",
    );
    expect(file).toBe(path.join(dir, ".local/people/alice_example.test.txt"));
    expect(statSync(path.join(dir, ".local/people")).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toBe("http://localhost:3000/auth/set-password#token=abc\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("production secrets stay separate from .env.local; secrets:push refuses loopback/http, excludes migration/neon, and uses --force", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "prod-secrets-test-"));
  const output: string[] = [];
  try {
    setupEnv(dir, (s) => output.push(s), false);
    const localFile = path.join(dir, ENV_LOCAL);
    const localBefore = readFileSync(localFile, "utf8");

    // Without .env.production.secrets, secrets:push refuses even though .env.local exists.
    await expect(pushSecrets(dir, fake(), () => {})).rejects.toThrow(ENV_PROD_SECRETS);

    // setup:env --production prepares .env.production.secrets and .env.production.migrate without touching .env.local.
    setupEnv(dir, (s) => output.push(s), true);
    expect(readFileSync(localFile, "utf8")).toBe(localBefore);
    const prodFile = path.join(dir, ENV_PROD_SECRETS);
    const prodMigrateFile = path.join(dir, ENV_PROD_MIGRATE);
    expect(statSync(prodFile).mode & 0o777).toBe(0o600);
    expect(statSync(prodMigrateFile).mode & 0o777).toBe(0o600);

    // Non-https origin refused.
    putEnv(
      prodFile,
      {
        APP_DATABASE_URL:
          "postgresql://runtime:prod-secret-pass-32-chars-long-00@ep.neon.tech/app?sslmode=verify-full",
        BETTER_AUTH_URL: "http://app.example.com",
      },
      true,
    );
    await expect(pushSecrets(dir, fake(), () => {})).rejects.toThrow("https://");

    // Loopback BETTER_AUTH_URL refused.
    putEnv(prodFile, { BETTER_AUTH_URL: "https://localhost:3000" }, true);
    await expect(pushSecrets(dir, fake(), () => {})).rejects.toThrow("loopback");

    // Loopback APP_DATABASE_URL refused.
    putEnv(
      prodFile,
      {
        BETTER_AUTH_URL: "https://app.example.com",
        APP_DATABASE_URL:
          "postgresql://runtime:prod-secret-pass-32-chars-long-00@127.0.0.1:5432/app",
      },
      true,
    );
    await expect(pushSecrets(dir, fake(), () => {})).rejects.toThrow("loopback");

    // Valid production values succeed, excluding MIGRATION_DATABASE_URL and NEON_API_KEY.
    putEnv(
      prodFile,
      {
        APP_DATABASE_URL:
          "postgresql://runtime:prod-secret-pass-32-chars-long-00@ep.neon.tech/app?sslmode=verify-full",
        BETTER_AUTH_URL: "https://app.example.com",
        MIGRATION_DATABASE_URL: "postgresql://owner:owner-secret@ep.neon.tech/app",
        NEON_API_KEY: "neon-secret",
      },
      true,
    );
    const sent: [string, string][] = [];
    await pushSecrets(dir, fake({ log: (s) => output.push(s) }), (name, value) => {
      sent.push([name, value]);
    });
    expect(sent.map(([name]) => name)).toContain("APP_DATABASE_URL");
    expect(sent.map(([name]) => name)).not.toContain("MIGRATION_DATABASE_URL");
    expect(sent.map(([name]) => name)).not.toContain("NEON_API_KEY");

    // Non-TTY refused.
    let didSend = false;
    await expect(
      pushSecrets(dir, fake({ tty: () => false }), () => {
        didSend = true;
      }),
    ).rejects.toThrow("terminal");
    expect(didSend).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("error redaction strips URL credentials, env secrets, and token fragments while preserving refusals and record IDs", () => {
  const env = {
    APP_DATABASE_URL: "postgresql://owner:private-password@db.example/app",
    BETTER_AUTH_SECRET: "super-secret-auth-key-32-characters-long",
    NEON_API_KEY: "provider-token",
  };
  const output: string[] = [];
  const previous = console.error;
  console.error = (message) => {
    output.push(String(message));
  };
  try {
    reportError(
      new Error(
        `Failed postgresql://owner:private-password@db.example/app with provider-token and ${env.BETTER_AUTH_SECRET} and https://app.example/auth/set-password#token=tok456`,
      ),
      "Migration",
      env,
    );
    reportError(
      new Error("Field detail cannot change type from text to number. Add a new field instead."),
      "Migration",
      env,
    );
    reportError(
      new Error("Required constraint failed for records: 11111111-2222-3333-4444-555555555555"),
      "Migration",
      env,
    );
    reportError(new Error("Row 3: duplicate external key in this file."), "Import", env);
    reportError(new SafeError("APP_DATABASE_URL is required."), "Migration", env);
    // PG error with secret-bearing detail property must print code + redacted message, NOT detail.
    const pgErr = Object.assign(new Error('password authentication failed for user "owner"'), {
      code: "28P01",
      detail: "connection postgresql://owner:private-password@db.example/app secret-row-data",
    });
    reportError(pgErr, "Migration", env);
  } finally {
    console.error = previous;
  }
  const combined = output.join("\n");
  expect(combined).not.toContain("private-password");
  expect(combined).not.toContain("provider-token");
  expect(combined).not.toContain(env.BETTER_AUTH_SECRET);
  expect(combined).not.toContain("tok456");
  expect(combined).not.toContain("secret-row-data");
  expect(combined).toContain("Field detail cannot change type");
  expect(combined).toContain("11111111-2222-3333-4444-555555555555");
  expect(combined).toContain("Row 3: duplicate external key");
  expect(combined).toContain("28P01: password authentication failed");
});

pgTest(
  "real PostgreSQL connection failures print pg code and redacted message without leaking URL password",
  async () => {
    if (!pgTestUrl) throw new Error("Database URL required.");
    const base = new URL(pgTestUrl);
    const missingDbUrl = new URL(base);
    if (!base.password) missingDbUrl.password = "real-pg-secret-pw-1";
    missingDbUrl.pathname = "/nonexistent_safety_test_db_xyz";

    const badUserUrl = new URL(base);
    badUserUrl.username = "no_such_safety_role_xyz";
    badUserUrl.password = "real-pg-secret-pw-2";
    badUserUrl.pathname = "/postgres";

    const cases: [string, string, string[]][] = [
      [missingDbUrl.toString(), missingDbUrl.password, ["3D000"]],
      [badUserUrl.toString(), "real-pg-secret-pw-2", ["28000", "28P01"]],
    ];
    if (base.password) {
      const badPassUrl = new URL(base);
      badPassUrl.password = "wrong-real-pg-secret-pw";
      badPassUrl.pathname = "/postgres";
      cases.push([badPassUrl.toString(), "wrong-real-pg-secret-pw", ["28P01"]]);
    }

    for (const [url, secretPw, expectedCodes] of cases) {
      const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 3000 });
      let caught: unknown;
      try {
        await pool.query("select 1");
      } catch (error) {
        caught = error;
      } finally {
        await pool.end().catch(() => {});
      }
      expect(caught).toBeInstanceOf(Error);
      const output: string[] = [];
      const prev = console.error;
      console.error = (m) => output.push(String(m));
      try {
        reportError(caught, "Migration", { MIGRATION_DATABASE_URL: url });
      } finally {
        console.error = prev;
      }
      const text = output.join("\n");
      expect(
        expectedCodes.some((code) => text.includes(`${code}:`)),
        text,
      ).toBe(true);
      expect(text).not.toContain(secretPw);
      expect(text).not.toContain(url);
    }
  },
);

pgTest(
  "real CLI scripts reach PostgreSQL, preserve pg error codes, and redact real URL passwords",
  () => {
    if (!pgTestUrl) throw new Error("Database URL required.");
    const base = new URL(pgTestUrl);
    const missingDbUrl = new URL(base);
    if (!base.password) missingDbUrl.password = "real-cli-pg-secret-pw-1";
    missingDbUrl.pathname = "/nonexistent_cli_safety_db_xyz";

    const cases: [string, string, string][] = [
      [missingDbUrl.toString(), missingDbUrl.password, "3D000:"],
    ];
    if (base.password) {
      const badPassUrl = new URL(base);
      badPassUrl.password = "real-cli-wrong-pg-secret-pw";
      badPassUrl.pathname = "/postgres";
      cases.push([badPassUrl.toString(), "real-cli-wrong-pg-secret-pw", "28P01:"]);
    }

    for (const [url, secretPw, expectedCode] of cases) {
      const result = spawnSync(
        process.execPath,
        [path.join(import.meta.dirname, "migrate.ts"), "undo"],
        {
          env: { ...process.env, MIGRATION_DATABASE_URL: url },
          encoding: "utf8",
        },
      );
      const combined = result.stdout + result.stderr;
      expect(result.status).not.toBe(0);
      expect(combined).toContain(expectedCode);
      expect(combined).not.toContain(secretPw);
      expect(combined).not.toContain(url);
    }
  },
);

pgTest(
  "people CLI adds then removes a user against isolated PostgreSQL without printing the link",
  async () => {
    if (!pgTestUrl) throw new Error("Database URL required.");
    expect(loopback(pgTestUrl)).toBe(true);
    const dbName = `people_cli_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const email = `cli-${randomUUID().slice(0, 8)}@example.test`;
    const appDir = path.resolve(import.meta.dirname, "..");
    const linkFile = path.join(appDir, ".local/people", `${safeEmailFileName(email)}.txt`);
    const admin = new Pool({ connectionString: pgTestUrl });
    const target = new URL(pgTestUrl);
    target.pathname = `/${dbName}`;
    const targetUrl = target.toString();
    let pool: Pool | undefined;
    let created = false;
    try {
      await admin.query(`create database "${dbName}"`);
      created = true;
      pool = new Pool({ connectionString: targetUrl });
      await pool.query(readFileSync(path.resolve(appDir, "../packages/auth/schema.sql"), "utf8"));
      const cliEnv = {
        ...process.env,
        MIGRATION_DATABASE_URL: targetUrl,
        BETTER_AUTH_URL: "http://127.0.0.1:3000",
        BETTER_AUTH_SECRET: "people-cli-test-secret-at-least-32-chars",
      };

      const add = spawnSync(
        process.execPath,
        [path.join(import.meta.dirname, "people.ts"), "add", email],
        { env: cliEnv, encoding: "utf8" },
      );
      expect(add.status, add.stderr).toBe(0);
      expect(add.stdout).toContain(linkFile);
      expect(add.stdout + add.stderr).not.toContain("#token=");
      expect(readFileSync(linkFile, "utf8")).toMatch(
        /^http:\/\/127\.0\.0\.1:3000\/auth\/set-password#token=.+\n$/,
      );
      expect(
        (
          await pool.query('select count(*)::int as n from "member" where "organizationId" = $1', [
            "starter",
          ])
        ).rows[0].n,
      ).toBe(1);

      const remove = spawnSync(
        process.execPath,
        [path.join(import.meta.dirname, "people.ts"), "remove", email],
        { env: cliEnv, encoding: "utf8" },
      );
      expect(remove.status, remove.stderr).toBe(0);
      expect(existsSync(linkFile)).toBe(false);
      expect((await pool.query('select count(*)::int as n from "user"')).rows[0].n).toBe(0);
    } finally {
      rmSync(linkFile, { force: true });
      await pool?.end();
      if (created) await admin.query(`drop database if exists "${dbName}" with (force)`);
      await admin.end();
    }
  },
);

test("real CLI failures redact supplied secrets without contacting a provider", () => {
  const sentinel = "generated-private-secret-for-output-test";
  const environment = {
    ...process.env,
    MIGRATION_DATABASE_URL: sentinel,
    APP_DATABASE_URL: sentinel,
    BETTER_AUTH_URL: "http://localhost:3000",
    BETTER_AUTH_SECRET: sentinel,
    NEON_API_KEY: sentinel,
  };
  for (const [script, args] of [
    ["migrate.ts", ["apply"]],
    ["migrate.ts", ["undo"]],
    ["migrate.ts", ["rehearse"]],
    ["records-import.ts", ["notes", "missing.csv"]],
    ["release.ts", []],
    ["release.ts", ["--check"]],
    ["serve.ts", []],
    ["people.ts", ["add", "member@example.test"]],
  ] as const) {
    const result = spawnSync(process.execPath, [path.join(import.meta.dirname, script), ...args], {
      env: environment,
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain(sentinel);
  }
});

test("startup never migrates hosted targets, refuses pending migrations, allows matching release", async () => {
  const { prepareStartup } = await import("./serve");
  let applied = 0;
  const input = {
    databaseUrl: "postgresql://user@db.example/db",
    matches: async () => false,
    migrate: async () => {
      applied++;
    },
  };
  await expect(prepareStartup(input)).rejects.toThrow("Pending migrations");
  expect(applied).toBe(0);
  await prepareStartup({ ...input, matches: async () => true });
  expect(applied).toBe(0);
  await prepareStartup({ ...input, databaseUrl: "postgresql://user@127.0.0.1/db" });
  expect(applied).toBe(1);
});

test("setup and secrets:push CLI output excludes generated values", () => {
  const root = mkdtempSync(path.join(tmpdir(), "secret-cli-test-"));
  try {
    const appDir = path.join(root, "app");
    const scripts = path.join(appDir, "scripts");
    const schemaDir = path.join(appDir, "schema");
    const authPkg = path.join(root, "packages/auth");
    mkdirSync(scripts, { recursive: true });
    mkdirSync(schemaDir, { recursive: true });
    mkdirSync(authPkg, { recursive: true });
    for (const file of [
      "local-secrets.ts",
      "production-gate.ts",
      "safe-output.ts",
      "app-config.ts",
    ])
      copyFileSync(path.join(import.meta.dirname, file), path.join(scripts, file));
    copyFileSync(
      path.join(import.meta.dirname, "../schema/app.cue"),
      path.join(schemaDir, "app.cue"),
    );
    copyFileSync(
      path.join(import.meta.dirname, "../../packages/auth/redact.ts"),
      path.join(authPkg, "redact.ts"),
    );

    let output = "";
    for (const [args, expectedStatus] of [
      [["setup"], 0],
      [["setup", "--production"], 0],
      [["push"], 1],
    ] as const) {
      const result = spawnSync(
        process.execPath,
        [path.join(scripts, "local-secrets.ts"), ...args],
        { encoding: "utf8", env: { PATH: "", TMPDIR: tmpdir() } },
      );
      expect(result.status, `${args.join(" ")}: ${result.stderr}`).toBe(expectedStatus);
      output += result.stdout + result.stderr;
    }
    const env = readEnv(path.join(appDir, ENV_LOCAL));
    const migration = readEnv(path.join(appDir, ENV_MIGRATE));
    const prod = readEnv(path.join(appDir, ENV_PROD_SECRETS));
    for (const value of [
      env.BETTER_AUTH_SECRET!,
      env.APP_DATABASE_URL!,
      migration.MIGRATION_DATABASE_URL!,
      prod.BETTER_AUTH_SECRET!,
    ])
      expect(output).not.toContain(value);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("schema plan reads public renames and retired fields from applied artifacts", () => {
  const artifact = {
    schema: {
      models: [
        {
          id: "note",
          label: "Note",
          fields: [
            { id: "title", label: "Title" },
            { id: "old", lifecycle: "retired" },
          ],
        },
      ],
    },
    extras: {
      model_metadata: [{ model: "note", name: "memo" }],
      field_metadata: [{ model: "note", field: "title", name: "heading" }],
    },
  };
  const next = schemaForPlan(artifact);
  expect(next.models[0]!.fields).toHaveLength(1);
  const plan = schemaPlan(artifact.schema, next);
  expect(plan).toContain("Rename table Note to memo");
  expect(plan).toContain("Rename memo.Title to heading");
  expect(plan).toContain("Archive memo.old");
});

test("Vercel adapter sends values only on stdin, uses --force, and redacts/suppresses child output", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-vercel-"));
  const previous = {
    PATH: process.env.PATH,
    CAPTURE_ARGS: process.env.CAPTURE_ARGS,
    CAPTURE_INPUT: process.env.CAPTURE_INPUT,
  };
  try {
    setupEnv(dir, () => {}, true);
    putEnv(
      path.join(dir, ENV_PROD_SECRETS),
      {
        APP_DATABASE_URL:
          "postgresql://starter_runtime:prod-pass-at-least-32-characters-long@ep-db.neon.tech/app?sslmode=verify-full",
        BETTER_AUTH_URL: "https://starter.example.com",
      },
      true,
    );
    const args = path.join(dir, "args");
    const input = path.join(dir, "input");
    writeFileSync(
      path.join(dir, "vercel"),
      '#!/bin/sh\nprintf "%s\\n" "$@" >> "$CAPTURE_ARGS"\n/bin/cat >> "$CAPTURE_INPUT"\n/bin/cat "$CAPTURE_INPUT"\n/bin/cat "$CAPTURE_INPUT" >&2\n',
      { mode: 0o700 },
    );
    process.env.PATH = dir;
    process.env.CAPTURE_ARGS = args;
    process.env.CAPTURE_INPUT = input;
    const output: string[] = [];
    await pushSecrets(dir, fake({ log: (message) => output.push(message) }));
    const env = readEnv(path.join(dir, ENV_PROD_SECRETS));
    for (const value of [env.APP_DATABASE_URL!, env.BETTER_AUTH_SECRET!]) {
      expect(readFileSync(args, "utf8")).not.toContain(value);
      expect(readFileSync(input, "utf8")).toContain(value);
      expect(output.join("\n")).not.toContain(value);
    }
    expect(readFileSync(args, "utf8")).toContain("env\nadd\nAPP_DATABASE_URL\nproduction\n--force");
  } finally {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("redact helper handles URL credentials (including raw slash), password= forms, bearer tokens, token fragments, and avoids over-redacting unrelated or short env values", () => {
  expect(
    redact(
      "failed postgresql://u:p/with/slash@host/db Bearer tok123 https://x.test/auth/set-password#token=t1",
    ),
  ).toBe(
    "failed postgresql://[REDACTED]@host/db Bearer [REDACTED] https://x.test/auth/set-password#token=[REDACTED]",
  );
  expect(
    redact(
      "connect host=db.example user=owner password=my-secret-pw dbname=app and password='two words'",
    ),
  ).toBe(
    "connect host=db.example user=owner password=[REDACTED] dbname=app and password=[REDACTED]",
  );
  // Unrelated env vars (SSH_CONNECTION, GIT_COMMIT_HASH) and short/default 'postgres' password do not garble errors.
  const noisyEnv = {
    SSH_CONNECTION: "10.0.0.1 12345 10.0.0.2 22",
    GIT_COMMIT_HASH: "deadbeef12345678",
    APP_DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
    PGPASSWORD: "postgres",
    BETTER_AUTH_SECRET: "real-auth-secret-at-least-32-characters",
    NEON_API_KEY: "napi_secret_key_value",
  };
  const message =
    'database "postgres" failed on 10.0.0.1 12345 10.0.0.2 22 at commit deadbeef12345678; leaked real-auth-secret-at-least-32-characters napi_secret_key_value ' +
    "postgresql://postgres:postgres@127.0.0.1:5432/postgres https://app.example/users/alice@example.com";
  const redacted = redact(message, noisyEnv);
  expect(redacted).toContain('database "postgres" failed');
  expect(redacted).toContain("10.0.0.1 12345 10.0.0.2 22");
  expect(redacted).toContain("deadbeef12345678");
  expect(redacted).toContain("https://app.example/users/alice@example.com");
  expect(redacted).not.toContain("real-auth-secret-at-least-32-characters");
  expect(redacted).not.toContain("napi_secret_key_value");
  expect(redacted).not.toContain("postgresql://postgres:postgres@");
});
