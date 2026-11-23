import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { expect, test } from "vite-plus/test";
import {
  ProtectedInstallerLifecycle,
  ProtectedInstallerSpoolSession,
  ResourceBootstrapSpoolSession,
  digestResourceBootstrapContext,
  digestResourceBootstrapCredentials,
} from "../../protected-installer/node-spool";

test("shares Rust context digest and file-spool authority/lifecycle for resource-wide Auth effects", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "protected-node-spool-"));
  const spool = path.join(root, "spool");
  const runId = randomUUID();
  const startup = path.join(spool, "startup");
  for (const directory of [startup, path.join(spool, "requests"), path.join(spool, "responses")])
    mkdirSync(directory, { recursive: true });
  const context = {
    version: 1,
    operation: {
      operation_id: "auth-operation-1",
      approval_digest: "a".repeat(64),
      fence_generation: 1,
    },
    app_id: "auth",
    resource: {
      resource_id: "auth-resource-1",
      environment: "local",
      hostname: "127.0.0.1",
      port: 5432,
      database: "auth_test",
      schema: "public",
      migrator_role: "auth_migrator",
      runtime_role: "auth_runtime",
    },
    release: { id: "auth-schema-1", sha256: "a".repeat(64) },
    installer: { id: "auth-protected-installer-v1", sha256: "b".repeat(64) },
    tenant_targets: [],
  };
  writeFileSync(path.join(startup, "context.json"), JSON.stringify(context));
  writeFileSync(
    path.join(startup, "direct-database-url.json"),
    JSON.stringify("postgresql://auth_migrator:secret@127.0.0.1:5432/auth_test?sslmode=disable"),
  );
  writeFileSync(
    path.join(startup, "auth-schema-plan.json"),
    JSON.stringify({ version: 1, id: "plan-1" }),
  );
  writeFileSync(
    path.join(startup, "ready.json"),
    JSON.stringify({ version: 1, run_id: runId, frame_id: 0 }),
  );

  let session: ProtectedInstallerSpoolSession;
  const notices = new Writable({
    write(chunk, _encoding, callback) {
      try {
        const notice = JSON.parse(String(chunk)) as { kind: string; frame_id: number };
        if (notice.kind === "protected_installer_frame_ready") {
          const request = JSON.parse(
            readFileSync(path.join(spool, "requests", `${notice.frame_id}.json`), "utf8"),
          ) as {
            kind: string;
            operation_id: string;
            context_digest: string;
            fence_generation: number;
            sequence: number;
            effect_id: string;
          };
          const reply =
            request.kind === "authorize_effect"
              ? {
                  kind: "effect_authorized",
                  version: 1,
                  operation_id: request.operation_id,
                  context_digest: request.context_digest,
                  fence_generation: request.fence_generation,
                  sequence: request.sequence,
                  effect_id: request.effect_id,
                  allowed: true,
                }
              : {
                  kind: "checkpoint_recorded",
                  version: 1,
                  operation_id: request.operation_id,
                  context_digest: request.context_digest,
                  fence_generation: request.fence_generation,
                  sequence: request.sequence,
                  effect_id: request.effect_id,
                  recorded: true,
                };
          writeFileSync(
            path.join(spool, "responses", `${notice.frame_id}.json`),
            JSON.stringify(reply),
          );
          writeFileSync(
            path.join(spool, "responses", `${notice.frame_id}.ready`),
            JSON.stringify({ version: 1, run_id: runId, frame_id: notice.frame_id }),
          );
        }
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });
  session = new ProtectedInstallerSpoolSession({
    spoolDirectory: spool,
    runId,
    timeoutMs: 1000,
    notices,
  }).open();
  try {
    expect(session.contextDigest).toBe(
      createHash("sha256").update(JSON.stringify(context)).digest("hex"),
    );
    expect(session.context.tenant_targets).toEqual([]);
    expect(session.databaseUrl).toContain("auth_test");
    expect(JSON.parse(session.readStartupFile("auth-schema-plan.json").toString("utf8"))).toEqual({
      version: 1,
      id: "plan-1",
    });
    session.removeStartupFile("auth-schema-plan.json");
    session.lifecycle.started();
    const sequence = await session.authorize("auth.install_schema", null);
    expect(sequence).toBe(1);
    await session.checkpoint(sequence, "auth.install_schema", null, {
      state: "applied",
      readback_sha256: "c".repeat(64),
    });
    session.lifecycle.succeeded();
    const lifecycleKinds = [1, 2].map(
      (frameId) =>
        (
          JSON.parse(readFileSync(path.join(spool, "lifecycle", `${frameId}.json`), "utf8")) as {
            kind: string;
          }
        ).kind,
    );
    expect(lifecycleKinds).toEqual(["worker_started", "worker_succeeded"]);
    expect(readFileSync(path.join(spool, "requests", "1.json"), "utf8")).toContain(
      '"tenant_id":null',
    );
  } finally {
    session.close();
    expect(() => readFileSync(path.join(startup, "auth-schema-plan.json"))).toThrow();
    rmSync(root, { recursive: true, force: true });
  }
});

test("parses a separate resource-bootstrap context and preserves the default installer decoder", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "resource-bootstrap-spool-"));
  const startup = path.join(root, "startup");
  const requests = path.join(root, "requests");
  const responses = path.join(root, "responses");
  for (const directory of [startup, requests, responses]) mkdirSync(directory, { recursive: true });
  const runId = randomUUID();
  const credentials = {
    migratorPassword: "migrator-credential-that-is-long-enough-for-tests",
    runtimePassword: "runtime-credential-that-is-long-enough-for-tests",
  };
  const context = {
    kind: "neon_resource_bootstrap",
    version: 1,
    operation: {
      operation_id: randomUUID(),
      approval_digest: "a".repeat(64),
      fence_generation: 3,
    },
    app_id: "spend-review",
    resource: {
      scope: "app_database",
      resource_id: "resource-app-preview",
      environment: "preview",
      hostname: "ep-resource.us-east-1.aws.neon.tech",
      port: 5432,
      database: "spend_review_preview",
      migrator_role: "spend_review_migrator",
      runtime_role: "spend_review_runtime",
      maintenance_database: "neondb",
      bootstrap_role: "neondb_owner",
      provider_project_id: "project_fixture",
      provider_branch_id: "branch_fixture",
      provider_endpoint_id: "endpoint_fixture",
      credentials_sha256: digestResourceBootstrapCredentials(credentials),
    },
    release: { id: "release_fixture", sha256: "b".repeat(64) },
    installer: { id: "neon-resource-bootstrap-v1", sha256: "c".repeat(64) },
    tenant_targets: [],
  };
  writeFileSync(path.join(startup, "context.json"), JSON.stringify(context));
  writeFileSync(
    path.join(startup, "direct-database-url.json"),
    JSON.stringify(
      "postgresql://neondb_owner:secret@ep-resource.us-east-1.aws.neon.tech:5432/neondb?sslmode=verify-full",
    ),
  );
  writeFileSync(path.join(startup, "resource-credentials.json"), JSON.stringify(credentials));
  writeFileSync(
    path.join(startup, "ready.json"),
    JSON.stringify({ version: 1, run_id: runId, frame_id: 0 }),
  );
  const notices = new Writable({
    write(chunk, _encoding, callback) {
      try {
        const notice = JSON.parse(String(chunk)) as { kind: string; frame_id: number };
        if (notice.kind === "protected_installer_frame_ready") {
          const request = JSON.parse(
            readFileSync(path.join(requests, `${notice.frame_id}.json`), "utf8"),
          ) as {
            kind: string;
            operation_id: string;
            context_digest: string;
            fence_generation: number;
            sequence: number;
            effect_id: string;
          };
          const reply =
            request.kind === "authorize_effect"
              ? {
                  kind: "effect_authorized",
                  version: 1,
                  operation_id: request.operation_id,
                  context_digest: request.context_digest,
                  fence_generation: request.fence_generation,
                  sequence: request.sequence,
                  effect_id: request.effect_id,
                  allowed: true,
                }
              : {
                  kind: "checkpoint_recorded",
                  version: 1,
                  operation_id: request.operation_id,
                  context_digest: request.context_digest,
                  fence_generation: request.fence_generation,
                  sequence: request.sequence,
                  effect_id: request.effect_id,
                  recorded: true,
                };
          writeFileSync(path.join(responses, `${notice.frame_id}.json`), JSON.stringify(reply));
          writeFileSync(
            path.join(responses, `${notice.frame_id}.ready`),
            JSON.stringify({
              version: 1,
              run_id: runId,
              frame_id: notice.frame_id,
            }),
          );
        }
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });
  const session = new ResourceBootstrapSpoolSession({
    spoolDirectory: root,
    runId,
    timeoutMs: 1000,
    notices,
  }).open();
  try {
    expect(session.context.kind).toBe("neon_resource_bootstrap");
    expect(session.context.resource.scope).toBe("app_database");
    expect(session.contextDigest).toBe(digestResourceBootstrapContext(context));
    expect(session.databaseUrl).toContain("neondb_owner");
    expect(
      JSON.parse(session.readStartupFile("resource-credentials.json").toString("utf8")),
    ).toEqual(credentials);
    session.removeStartupFile("resource-credentials.json");
    const sequence = await session.authorize("resources:roles", null);
    await session.checkpoint(sequence, "resources:roles", null, {
      state: "applied",
      readback_sha256: "d".repeat(64),
    });
    expect(JSON.parse(readFileSync(path.join(requests, "1.json"), "utf8"))).toMatchObject({
      kind: "authorize_effect",
      app_id: "spend-review",
      resource_id: "resource-app-preview",
      effect_id: "resources:roles",
      tenant_id: null,
      installer_id: "neon-resource-bootstrap-v1",
    });
  } finally {
    session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("removes an orphan lifecycle fact and retries failure reporting after marker publication fails", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "protected-node-lifecycle-"));
  const spool = path.join(root, "spool");
  const lifecycleDirectory = path.join(spool, "lifecycle");
  mkdirSync(path.join(lifecycleDirectory, "1.ready"), { recursive: true });
  const lifecycle = new ProtectedInstallerLifecycle(
    spool,
    "lifecycle-retry",
    new Writable({ write: (_chunk, _encoding, callback) => callback() }),
  );
  try {
    expect(() => lifecycle.started()).toThrow("protected_installer_protocol_failed");
    expect(existsSync(path.join(lifecycleDirectory, "1.json"))).toBe(false);
    rmSync(path.join(lifecycleDirectory, "1.ready"), { recursive: true });

    lifecycle.failed("startup_rejected");
    const fact = JSON.parse(readFileSync(path.join(lifecycleDirectory, "1.json"), "utf8")) as {
      run_id: string;
      kind: string;
      failure_code: string;
    };
    expect(fact).toEqual({
      version: 1,
      run_id: "lifecycle-retry",
      kind: "worker_failed",
      failure_code: "startup_rejected",
    });
    expect(existsSync(path.join(lifecycleDirectory, "2.json"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects empty targets for generated apps while retaining Rust v1 Auth resource-wide shape", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "protected-node-spool-invalid-"));
  const startup = path.join(root, "startup");
  mkdirSync(startup, { recursive: true });
  const context = {
    version: 1,
    operation: {
      operation_id: "operation-1",
      approval_digest: "a".repeat(64),
      fence_generation: 1,
    },
    app_id: "spend-review",
    resource: {
      resource_id: "app-resource-1",
      environment: "local",
      hostname: "127.0.0.1",
      port: 5432,
      database: "spend_review",
      schema: "public",
      migrator_role: "spend_migrator",
      runtime_role: "spend_runtime",
    },
    release: { id: "release-1", sha256: "a".repeat(64) },
    installer: { id: "installer-1", sha256: "b".repeat(64) },
    tenant_targets: [],
  };
  const runId = randomUUID();
  writeFileSync(path.join(startup, "context.json"), JSON.stringify(context));
  writeFileSync(
    path.join(startup, "direct-database-url.json"),
    JSON.stringify(
      "postgresql://spend_migrator:secret@127.0.0.1:5432/spend_review?sslmode=disable",
    ),
  );
  writeFileSync(
    path.join(startup, "ready.json"),
    JSON.stringify({ version: 1, run_id: runId, frame_id: 0 }),
  );
  const session = new ProtectedInstallerSpoolSession({
    spoolDirectory: root,
    runId,
    timeoutMs: 1000,
  });
  try {
    expect(() => session.open()).toThrow();
  } finally {
    session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed when startup secret cleanup is denied without exposing the URL", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "protected-node-spool-cleanup-"));
  const startup = path.join(root, "startup");
  mkdirSync(startup, { recursive: true });
  const runId = randomUUID();
  const secretUrl = "postgresql://user:top-secret@127.0.0.1:5432/app?sslmode=disable";
  const context = {
    version: 1,
    operation: {
      operation_id: "operation-cleanup",
      approval_digest: "a".repeat(64),
      fence_generation: 1,
    },
    app_id: "spend-review",
    resource: {
      resource_id: "resource-cleanup",
      environment: "local",
      hostname: "127.0.0.1",
      port: 5432,
      database: "app",
      schema: "public",
      migrator_role: "migrator",
      runtime_role: "runtime",
    },
    release: { id: "release-cleanup", sha256: "a".repeat(64) },
    installer: { id: "installer-cleanup", sha256: "b".repeat(64) },
    tenant_targets: ["tenant-a"],
  };
  writeFileSync(path.join(startup, "context.json"), JSON.stringify(context));
  writeFileSync(path.join(startup, "direct-database-url.json"), JSON.stringify(secretUrl));
  writeFileSync(
    path.join(startup, "ready.json"),
    JSON.stringify({ version: 1, run_id: runId, frame_id: 0 }),
  );
  const session = new ProtectedInstallerSpoolSession({
    spoolDirectory: root,
    runId,
    timeoutMs: 1000,
  });
  try {
    chmodSync(startup, 0o500);
    let message = "";
    try {
      session.open();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("protected_installer_protocol_failed");
    expect(message).not.toContain(secretUrl);
  } finally {
    chmodSync(startup, 0o700);
    session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("resource bootstrap removes credentials on invalid startup context and marker", () => {
  for (const corrupt of ["context", "marker", "binding"]) {
    const root = mkdtempSync(path.join(os.tmpdir(), "resource-startup-rejected-"));
    const startup = path.join(root, "startup");
    mkdirSync(startup);
    const runId = randomUUID();
    const secret = "private-bootstrap-password";
    writeFileSync(
      path.join(startup, "resource-credentials.json"),
      JSON.stringify({ migratorPassword: secret, runtimePassword: secret }),
    );
    writeFileSync(
      path.join(startup, "context.json"),
      corrupt === "context"
        ? "invalid-json"
        : JSON.stringify({
            kind: "neon_resource_bootstrap",
            version: 1,
            operation: {
              operation_id: "operation",
              approval_digest: "a".repeat(64),
              fence_generation: 1,
            },
            app_id: "auth",
            resource: {
              scope: "auth_database",
              resource_id: "resource",
              environment: "local",
              hostname: "127.0.0.1",
              port: 5432,
              database: "auth_db",
              migrator_role: "auth_migrator",
              runtime_role: "auth_runtime",
              maintenance_database: "neondb",
              bootstrap_role: "owner",
              credentials_sha256: "b".repeat(64),
            },
            release: { id: "release", sha256: "a".repeat(64) },
            installer: { id: "installer", sha256: "a".repeat(64) },
            tenant_targets: [],
          }),
    );
    writeFileSync(
      path.join(startup, "direct-database-url.json"),
      corrupt === "binding"
        ? "invalid-json"
        : JSON.stringify("postgresql://owner:secret@127.0.0.1/neondb"),
    );
    writeFileSync(
      path.join(startup, "ready.json"),
      JSON.stringify({
        version: 1,
        run_id: corrupt === "marker" ? "wrong-run" : runId,
        frame_id: 0,
      }),
    );
    const session = new ResourceBootstrapSpoolSession({
      spoolDirectory: root,
      runId,
      timeoutMs: 100,
    });
    try {
      expect(() => session.open()).toThrow();
      expect(existsSync(path.join(startup, "resource-credentials.json"))).toBe(false);
      expect(existsSync(path.join(startup, "direct-database-url.json"))).toBe(false);
      expect(() => session.databaseUrl).toThrow();
    } finally {
      session.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("resource credential unlink failure stops startup and closes session state", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "resource-startup-unlink-"));
  const startup = path.join(root, "startup");
  mkdirSync(startup);
  // A directory cannot be unlinked as a startup credential file.
  mkdirSync(path.join(startup, "resource-credentials.json"));
  const session = new ResourceBootstrapSpoolSession({
    spoolDirectory: root,
    runId: randomUUID(),
    timeoutMs: 100,
  });
  try {
    expect(() => session.open()).toThrow("protected_installer_protocol_failed");
    expect(() => session.databaseUrl).toThrow();
    expect(() => session.close()).toThrow("protected_installer_protocol_failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
