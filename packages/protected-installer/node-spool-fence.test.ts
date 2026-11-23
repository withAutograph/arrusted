import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { ProtectedInstallerLifecycle, ProtectedInstallerSpoolSession } from "./node-spool";

const context = {
  version: 1,
  operation: {
    operation_id: "fixture-operation",
    approval_digest: "a".repeat(64),
    fence_generation: 3,
  },
  app_id: "spend-review",
  resource: {
    resource_id: "owned-app",
    environment: "local",
    hostname: "127.0.0.1",
    port: 5432,
    database: "app_fixture",
    schema: "public",
    migrator_role: "app_migrator",
    runtime_role: "app_runtime",
  },
  release: { id: "v19", sha256: "b".repeat(64) },
  installer: { id: "fixture-worker", sha256: "c".repeat(64) },
  tenant_targets: ["fixture-org"],
};
const digest = createHash("sha256").update(JSON.stringify(context)).digest("hex");
const fixture = (options: { denied?: boolean; foreign?: boolean } = {}) => {
  const directory = mkdtempSync(path.join(tmpdir(), "owned-fence-spool-"));
  for (const name of ["startup", "requests", "responses", "lifecycle"])
    mkdirSync(path.join(directory, name), { mode: 0o700 });
  const write = (file: string, value: unknown) =>
    writeFileSync(path.join(directory, file), JSON.stringify(value), { mode: 0o600 });
  write("startup/context.json", context);
  write(
    "startup/direct-database-url.json",
    "postgres://app_migrator:fixture@127.0.0.1/app_fixture?sslmode=disable",
  );
  write("startup/ready.json", { version: 1, run_id: "fixture-run", frame_id: 0 });
  const requests: Record<string, unknown>[] = [];
  const notices = new Writable({
    write(chunk, _encoding, done) {
      try {
        const notice = JSON.parse(String(chunk));
        if (notice.kind === "protected_installer_frame_ready") {
          const request = JSON.parse(
            readFileSync(path.join(directory, `requests/${notice.frame_id}.json`), "utf8"),
          );
          requests.push(request);
          const reply = {
            kind: request.kind === "check_fence" ? "fence_current" : "effect_authorized",
            version: 1,
            operation_id: request.operation_id,
            context_digest: options.foreign ? "d".repeat(64) : request.context_digest,
            fence_generation: request.fence_generation,
            ...(request.kind === "check_fence"
              ? { current: !options.denied }
              : {
                  sequence: request.sequence,
                  effect_id: request.effect_id,
                  allowed: true,
                }),
          };
          write(`responses/${notice.frame_id}.json`, reply);
          write(`responses/${notice.frame_id}.ready`, {
            version: 1,
            run_id: "fixture-run",
            frame_id: notice.frame_id,
          });
        }
        done();
      } catch (error) {
        done(error as Error);
      }
    },
  });
  const session = new ProtectedInstallerSpoolSession({
    spoolDirectory: directory,
    runId: "fixture-run",
    timeoutMs: 1000,
    notices,
  }).open();
  return {
    requests,
    session,
    close() {
      session.close();
      notices.destroy();
      rmSync(directory, { recursive: true, force: true });
    },
  };
};

describe("explicit protected worker fence check", () => {
  it("binds every fresh check to approved identity without effect sequence or receipt", async () => {
    const owned = fixture();
    try {
      await owned.session.assertCurrent();
      await owned.session.assertCurrent();
      expect(owned.requests).toHaveLength(2);
      expect(owned.requests[0]).toMatchObject({
        kind: "check_fence",
        context_digest: digest,
        app_id: context.app_id,
        approval_digest: context.operation.approval_digest,
        resource_id: context.resource.resource_id,
        installer_sha256: context.installer.sha256,
        fence_generation: 3,
      });
      expect(owned.requests[0]).not.toHaveProperty("effect_id");
      expect(owned.requests[0]).not.toHaveProperty("sequence");
      expect(owned.requests[0]).not.toHaveProperty("receipt");
      expect(await owned.session.authorize("access.grant", null)).toBe(1);
      await owned.session.assertCurrent();
    } finally {
      owned.close();
    }
  });
  it.each([{ denied: true }, { foreign: true }])(
    "fails closed and cannot continue after denial %j",
    async (options) => {
      const owned = fixture(options);
      try {
        await expect(owned.session.assertCurrent()).rejects.toThrow();
        await expect(owned.session.authorize("access.grant", null)).rejects.toThrow();
        expect(owned.requests).toHaveLength(1);
      } finally {
        owned.close();
      }
    },
  );
});

describe("advisory Auth prestart lifecycle metadata", () => {
  const failureFact = (
    metadata?: unknown,
    options: { started?: boolean; code?: "startup_rejected" | "effect_failed" } = {},
  ) => {
    const directory = mkdtempSync(path.join(tmpdir(), "auth-lifecycle-"));
    const notices: string[] = [];
    const output = new Writable({
      write(chunk, _encoding, done) {
        notices.push(String(chunk));
        done();
      },
    });
    const lifecycle = new ProtectedInstallerLifecycle(directory, "fixture-run", output);
    try {
      if (options.started) lifecycle.started();
      // Exercise the real JavaScript boundary with malformed advisory data, without changing its typed API.
      const publishFailure = lifecycle.failed.bind(lifecycle);
      Reflect.apply(publishFailure, undefined, [options.code ?? "startup_rejected", metadata]);
      const index = options.started ? 2 : 1;
      const fact: unknown = JSON.parse(
        readFileSync(path.join(directory, "lifecycle", `${index}.json`), "utf8"),
      );
      const marker: unknown = JSON.parse(
        readFileSync(path.join(directory, "lifecycle", `${index}.ready`), "utf8"),
      );
      expect(marker).toMatchObject({ run_id: "fixture-run", frame_id: index });
      expect(notices).toHaveLength(index);
      expect(() => lifecycle.failed("startup_rejected")).toThrow(
        "protected_installer_protocol_failed",
      );
      return fact;
    } finally {
      output.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
  };

  it("preserves legacy failed(code) facts", () => {
    expect(failureFact()).toEqual({
      version: 1,
      run_id: "fixture-run",
      kind: "worker_failed",
      failure_code: "startup_rejected",
    });
  });

  it("retains only closed Auth failure metadata", () => {
    const fact = failureFact({
      stage: "approved_plan_binding",
      domain_code: "auth_operator_plan_mismatch",
      private: "private-diagnostic-secret",
    });
    expect(fact).toMatchObject({
      auth_startup: { stage: "approved_plan_binding", domain_code: "auth_operator_plan_mismatch" },
    });
    expect(JSON.stringify(fact)).not.toContain("private-diagnostic-secret");
  });

  it.each([
    undefined,
    null,
    { stage: "future-stage", domain_code: "auth_operator_plan_mismatch" },
    new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("private-diagnostic-secret");
        },
      },
    ),
  ])("publishes the existing failure despite unknown or hostile metadata", (metadata) => {
    expect(failureFact(metadata)).toEqual({
      version: 1,
      run_id: "fixture-run",
      kind: "worker_failed",
      failure_code: "startup_rejected",
    });
  });

  it("omits unknown codes while retaining the known stage", () => {
    const fact = failureFact({ stage: "schema_replan", domain_code: "private-diagnostic-secret" });
    expect(fact).toMatchObject({ auth_startup: { stage: "schema_replan" } });
    expect(fact).not.toHaveProperty("auth_startup.domain_code");
  });

  it.each([{ started: true }, { code: "effect_failed" as const }])(
    "does not add prestart metadata to another lifecycle boundary",
    (options) => {
      expect(failureFact({ stage: "schema_replan" }, options)).not.toHaveProperty("auth_startup");
    },
  );
});
