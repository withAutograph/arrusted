import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runProtectedAuthSchemaInstaller } from "../protected-installer-worker";
import { readApprovedAuthOperatorPlan } from "../approved-operator-plan";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
// Frozen wire fixture validated with Builder's actual hostedOperatorPlanSchema/operatorPlanDigest.
const legacyPlan = {
  access: [],
  action: "prepare",
  appDatabase: {
    database: "app",
    migratorRole: "app_owner",
    resourceId: "app-resource",
    runtimeRole: "app_runtime",
  },
  authDatabase: {
    database: "auth",
    migratorRole: "auth_owner",
    resourceId: "auth-resource",
    runtimeRole: "auth_runtime",
  },
  authSchema: {
    artifactRef: "auth-artifact",
    installer: { reference: "auth-protected-schema-v1", sha256: "d".repeat(64) },
    planDigest: "e".repeat(64),
    targetDigest: "f".repeat(64),
  },
  bootstrap: { endpointId: "ep-fixture", maintenanceDatabase: "neondb", role: "neondb_owner" },
  contextId: "synthetic-spec",
  cost: {
    class: "shared-recovery-group",
    description: "Synthetic digest proof",
    owner: "Synthetic owner",
  },
  deploymentBoundary: {
    app: { branch: "preview", environment: "preview", projectId: "prj_fixture" },
    authority: {
      audience: "https://builder.example/mcp",
      issuer: "https://builder.example/api/auth",
      ownerUserId: "synthetic-owner",
      workspaceId: "synthetic-workspace",
    },
    gateway: { branch: "preview", environment: "preview", projectId: "prj_gateway" },
    operator: { deploymentId: "dpl_operator", environment: "preview", projectId: "prj_operator" },
    teamId: "team_fixture",
    verification: {
      gatewayOrigin: "https://apps.example.test",
      jwksUrl: "https://apps.example.test/_platform/jwks.json",
      publicOrigin: "https://apps.example.test",
    },
  },
  effects: [
    {
      description: "Auth resource",
      id: "auth-resources",
      kind: "resources",
      resourceId: "auth-resource",
    },
    {
      description: "App resource",
      id: "app-resources",
      kind: "resources",
      resourceId: "app-resource",
    },
    { description: "Auth schema", id: "auth-schema", kind: "install" },
  ],
  installer: { reference: "app-worker", sha256: "a".repeat(64) },
  neon: {
    branchId: "br-fixture",
    connectionRef: "native-connection",
    endpoint: "ep-fixture.neon.tech",
    projectId: "neon-fixture",
    source: "synthetic-only",
  },
  publicGateway: {
    branch: "preview",
    origin: "https://apps.example.test",
    projectId: "prj_gateway",
  },
  release: { artifactRef: "release-artifact", id: "release", sha256: "b".repeat(64) },
  resourcesInstaller: { reference: "resources-worker", sha256: "c".repeat(64) },
  retention: { expiresAt: "2027-01-01T00:00:00Z", policy: "Retain shared Auth" },
  selection: {
    appId: "digest-probe",
    branch: "preview",
    environment: "preview",
    projectId: "prj_fixture",
    sessionId: "synthetic-session",
  },
  stage: "auth-bootstrap",
  version: 1,
};
const normalActorProgram = {
  version: 1,
  appId: "digest-probe",
  origin: "https://apps.example.test",
  actors: [
    {
      actorKey: "first",
      email: "first@example.test",
      name: "First",
      account: "create-email-password",
    },
    {
      actorKey: "second",
      email: "second@example.test",
      name: "Second",
      account: "create-email-password",
    },
  ],
  organizations: [
    { organizationId: "first-org", ownerActorKey: "first", name: "First org", slug: "first-org" },
    {
      organizationId: "second-org",
      ownerActorKey: "second",
      name: "Second org",
      slug: "second-org",
    },
  ],
  memberships: [
    { actorKey: "first", organizationId: "first-org", role: "owner" },
    { actorKey: "second", organizationId: "second-org", role: "owner" },
  ],
  appAccess: [
    { actorKey: "first", organizationId: "first-org", roles: ["member"] },
    { actorKey: "second", organizationId: "second-org", roles: ["member"] },
  ],
};
const {
  publicGateway,
  release,
  resourcesInstaller,
  retention,
  selection,
  stage,
  version,
  ...prefix
} = legacyPlan;
const multiActorPlan = {
  ...prefix,
  normalActorProgram,
  publicGateway,
  release,
  resourcesInstaller,
  retention,
  selection,
  stage,
  version,
};

const earlyStartup = (startupPayload: unknown) => {
  const directory = mkdtempSync(path.join(tmpdir(), "auth-startup-diagnostic-"));
  mkdirSync(path.join(directory, "startup"));
  const context = {
    version: 1,
    operation: {
      operation_id: "synthetic-operation",
      approval_digest: "a".repeat(64),
      fence_generation: 1,
    },
    app_id: "auth",
    resource: {
      resource_id: "synthetic-auth",
      environment: "local",
      hostname: "127.0.0.1",
      port: 5432,
      database: "auth_fixture",
      schema: "public",
      migrator_role: "auth_owner",
      runtime_role: "auth_runtime",
    },
    release: { id: "f".repeat(64), sha256: "e".repeat(64) },
    installer: { id: "auth-protected-schema-v1", sha256: "d".repeat(64) },
    tenant_targets: [],
  };
  for (const [name, value] of Object.entries({
    "context.json": context,
    "direct-database-url.json":
      "postgresql://auth_owner:private-startup-secret@127.0.0.1/auth_fixture?sslmode=disable",
    "ready.json": { version: 1, run_id: "auth-startup-fixture", frame_id: 0 },
    "auth-schema-plan.json": startupPayload,
  }))
    writeFileSync(path.join(directory, "startup", name), JSON.stringify(value), { mode: 0o600 });
  const notices: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, done) {
      notices.push(String(chunk));
      done();
    },
  });
  return { directory, notices, output };
};

describe("Auth approval wire and prestart failure", () => {
  it("preserves the frozen legacy producer approval", () => {
    const bytes = Buffer.from(JSON.stringify(legacyPlan));
    const approvedDigest = "3e97a44f39bf2c231fb5ba8f6d62a4c428f3d886229c2af09d5f5e95d1ae863c";
    expect(hash(bytes)).toBe(approvedDigest);
    expect(() => readApprovedAuthOperatorPlan(bytes, approvedDigest)).not.toThrow();
  });

  it("accepts approved participant wire order and rejects a changed full plan", () => {
    const bytes = Buffer.from(JSON.stringify(multiActorPlan));
    const approvedDigest = "91e2c9e27d79b79462933cc6cf702b1d71fa457c695866bd8cd74449267abcf9";
    expect(hash(bytes)).toBe(approvedDigest);
    expect(() => readApprovedAuthOperatorPlan(bytes, approvedDigest)).not.toThrow();
    const changed = Buffer.from(
      JSON.stringify({
        ...multiActorPlan,
        authDatabase: { ...legacyPlan.authDatabase, database: "other_auth" },
      }),
    );
    expect(() => readApprovedAuthOperatorPlan(changed, approvedDigest)).toThrow(
      "auth_operator_plan_mismatch",
    );
    const changedProgram = Buffer.from(
      JSON.stringify({
        ...multiActorPlan,
        normalActorProgram: { ...normalActorProgram, origin: "https://other.example.test" },
      }),
    );
    expect(() => readApprovedAuthOperatorPlan(changedProgram, approvedDigest)).toThrow(
      "auth_operator_plan_mismatch",
    );
  });

  it("retains the canonical full-plan ABI independently of startup object key order", () => {
    const wire = Buffer.from(
      '{"version":1,"action":"prepare","authSchema":{"targetDigest":"target","planDigest":"plan"},"extra":{"z":2,"a":1}}',
    );
    const canonicalWire = Buffer.from(
      '{"action":"prepare","authSchema":{"planDigest":"plan","targetDigest":"target"},"extra":{"a":1,"z":2},"version":1}',
    );
    const canonicalDigest = hash(canonicalWire);
    expect(hash(wire)).not.toBe(canonicalDigest);
    for (const approvedDigest of [canonicalDigest, hash(wire)]) {
      expect(readApprovedAuthOperatorPlan(wire, approvedDigest)).toMatchObject({
        plan: { version: 1, extra: { z: 2, a: 1 } },
        planDigest: approvedDigest,
      });
      const changed = Buffer.from(wire.toString().replace('"z":2', '"z":3'));
      expect(() => readApprovedAuthOperatorPlan(changed, approvedDigest)).toThrow(
        "auth_operator_plan_mismatch",
      );
    }
  });

  it("reports the actual payload rejection before pool construction or database access", async () => {
    const input = earlyStartup({ private: "private-startup-secret" });
    try {
      await expect(
        runProtectedAuthSchemaInstaller({
          spoolDirectory: input.directory,
          runId: "auth-startup-fixture",
          timeoutMs: 1000,
          notices: input.output,
        }),
      ).rejects.toThrow("protected_auth_worker_failed:startup_rejected");
      const fact: unknown = JSON.parse(
        readFileSync(path.join(input.directory, "lifecycle", "1.json"), "utf8"),
      );
      expect(fact).toMatchObject({
        kind: "worker_failed",
        failure_code: "startup_rejected",
        auth_startup: { stage: "startup_plan_parse" },
      });
      expect(JSON.stringify(fact)).not.toContain("private-startup-secret");
      expect(input.notices).toHaveLength(1);
    } finally {
      input.output.destroy();
      rmSync(input.directory, { recursive: true, force: true });
    }
  });

  it("retains only the closed domain code from an actual context mismatch before database access", async () => {
    const resource = {
      version: 1,
      environment: "local",
      hostname: "127.0.0.1",
      port: 5432,
      database: "other_auth",
      schema: "public",
      migratorRole: "auth_owner",
      runtimeRole: "auth_runtime",
    };
    const input = earlyStartup({
      version: 1,
      resource,
      schemaPlan: {
        version: 1,
        resource,
        toolchain: "better-auth@1.7.3",
        history: { version: 1, schema: "_auth_schema_history", tables: ["plan", "attempt"] },
        catalogAppIds: ["digest-probe"],
        targetDigest: "f".repeat(64),
        beforeSchemaHash: "b".repeat(64),
        effects: ["compatibility", "better-auth", "platform", "readiness"].map((owner) => ({
          owner,
          sql: "select 1",
          sha256: "c".repeat(64),
        })),
        planDigest: "e".repeat(64),
      },
    });
    try {
      await expect(
        runProtectedAuthSchemaInstaller({
          spoolDirectory: input.directory,
          runId: "auth-startup-fixture",
          timeoutMs: 1000,
          notices: input.output,
        }),
      ).rejects.toThrow("protected_auth_worker_failed:startup_rejected");
      const fact: unknown = JSON.parse(
        readFileSync(path.join(input.directory, "lifecycle", "1.json"), "utf8"),
      );
      expect(fact).toMatchObject({
        kind: "worker_failed",
        failure_code: "startup_rejected",
        auth_startup: { stage: "context_binding", domain_code: "auth_worker_context_mismatch" },
      });
      expect(JSON.stringify(fact)).not.toContain("private-startup-secret");
      expect(input.notices).toHaveLength(1);
    } finally {
      input.output.destroy();
      rmSync(input.directory, { recursive: true, force: true });
    }
  });
});
