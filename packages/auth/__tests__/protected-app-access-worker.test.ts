// @vitest-environment node
import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import {
  runProtectedAppAccess,
  runProtectedAppAccessReadback,
} from "../protected-app-access-worker";
import { authDatabaseResourceDigest } from "../signup-policy";

const state = vi.hoisted(() => ({
  context: {} as Record<string, unknown>,
  databaseUrl: "postgres://auth_operator:private@ep-auth.neon.tech/auth?sslmode=verify-full",
  verifyOperator: vi.fn(async () => {}),
  files: new Map<string, string>(),
  query: vi.fn(),
  authorize: vi.fn(async () => 1),
  checkpoint: vi.fn(async () => {}),
  assertCurrent: vi.fn(async () => {}),
  write: vi.fn(async (_path: string, _data: string, _options: unknown) => {}),
}));
vi.mock("node:fs/promises", () => ({ writeFile: state.write }));
vi.mock("../../protected-installer/auth-operator", async (original) => ({
  ...(await original<typeof import("../../protected-installer/auth-operator")>()),
  verifyAuthOperatorConnection: state.verifyOperator,
}));
vi.mock("pg", () => ({
  Pool: class {
    connect = async () => ({ query: state.query, release: () => {} });
    end = async () => {};
  },
}));
vi.mock("../../protected-installer/node-spool", () => ({
  ProtectedInstallerSpoolSession: class {
    context = state.context;
    contextDigest = "context";
    databaseUrl = state.databaseUrl;
    lifecycle = { started: () => {}, succeeded: () => {}, failed: () => {} };
    open() {
      return this;
    }
    close() {}
    authorize = state.authorize;
    checkpoint = state.checkpoint;
    assertCurrent = state.assertCurrent;
    readStartupFile(name: string) {
      return Buffer.from(state.files.get(name)!);
    }
    removeStartupFile(name: string) {
      state.files.delete(name);
    }
  },
}));

const resource = {
  version: 1,
  environment: "production",
  hostname: "ep-auth.neon.tech",
  port: 5432,
  database: "auth",
  schema: "public",
  runtimeRole: "auth_runtime",
  migratorRole: "auth_migrator",
  neon: { projectId: "neon", branchId: "branch" },
} as const;
const realm = {
  version: 1,
  kind: "managed-production-realm-v1",
  workspaceId: "workspace",
  repositoryId: "123",
  repositoryFullName: "owner/repo",
  authResourceId: "auth",
  authorizedOrganizationIds: ["dev"],
  publicOrigin: "https://apps.example",
  project: { projectId: "prj_apps", ownerId: "team", environment: "production" },
  resource,
};
const row = {
  id: "11111111-1111-4111-a111-111111111111",
  workspaceId: "workspace",
  appId: "requests",
  organizationId: "dev",
  email: "person@example.test",
  roles: [],
  returnUrl: "https://apps.example/requests",
  operationRef: "22222222-2222-4222-a222-222222222222",
  planDigest: "b".repeat(64),
  scopeDigest: "c".repeat(64),
  fenceGeneration: 1,
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  status: "pending",
  resourceDigest: authDatabaseResourceDigest(resource),
  verifiedActorId: null,
  verifiedSessionId: null,
  deliveryStatus: "ready",
  deliveryAttemptId: null as string | null,
  deliveryProviderId: null,
};
function prepare(
  request: Record<string, unknown>,
  scope = { appId: "requests", organizationId: "dev" },
) {
  const plan = {
    authOperatorRole: "auth_operator",
    authAppAccess: { version: 1, realm, builderOrigin: "https://builder.example", scope, request },
    effects: [{ id: "auth-app-invitation", kind: "auth-app-invitation" }],
  };
  const wire = JSON.stringify(plan);
  state.context = {
    app_id: "auth",
    installer: { id: "auth-app-access-v1" },
    operation: {
      operation_id: row.operationRef,
      approval_digest: createHash("sha256").update(wire).digest("hex"),
      fence_generation: 3,
    },
    resource: {
      resource_id: "auth",
      environment: "production",
      hostname: resource.hostname,
      port: resource.port,
      schema: resource.schema,
      database: resource.database,
      migrator_role: resource.migratorRole,
      runtime_role: resource.runtimeRole,
      provider_project_id: "neon",
      provider_branch_id: "branch",
    },
  };
  state.files.set("operator-plan.json", wire);
  state.files.set("auth-database-resource.json", JSON.stringify(resource));
}
const input = { spoolDirectory: "/private/test", runId: "test", timeoutMs: 1000 };
beforeEach(() => {
  vi.clearAllMocks();
  state.assertCurrent.mockReset().mockResolvedValue();
  state.files.clear();
  state.databaseUrl = "postgres://auth_operator:private@ep-auth.neon.tech/auth?sslmode=verify-full";
  state.verifyOperator.mockReset().mockResolvedValue();
  vi.unstubAllGlobals();
});

it("reads the same invitation through a newer operation without replaying its original writes", async () => {
  prepare({ action: "read", invitationId: row.id });
  state.query.mockResolvedValue({ rows: [row] });
  await runProtectedAppAccessReadback(input);
  expect(state.authorize).not.toHaveBeenCalled();
  const result = JSON.parse(String(state.write.mock.calls[0]?.[1]));
  expect(result.result.id).toBe(row.id);
  expect(result.result.fenceGeneration).toBe(1);
});

it("rejects cross-app invitation lookup and writes on the read-only entry point", async () => {
  prepare({ action: "read", invitationId: row.id }, { appId: "other", organizationId: "dev" });
  state.query.mockResolvedValue({ rows: [row] });
  await expect(runProtectedAppAccessReadback(input)).rejects.toThrow();
  expect(state.authorize).not.toHaveBeenCalled();
  prepare({ action: "cancel", invitationId: row.id, scopeDigest: row.scopeDigest });
  await expect(runProtectedAppAccessReadback(input)).rejects.toThrow();
  expect(state.authorize).not.toHaveBeenCalled();
});

it("does not issue another magic link after a lost send response", async () => {
  const saved = { ...row };
  state.query.mockImplementation(async (sql: string, values?: unknown[]) => {
    if (sql.includes("set \"deliveryStatus\"='sending'")) {
      if (saved.deliveryStatus !== "ready") return { rows: [] };
      saved.deliveryStatus = "sending";
      saved.deliveryAttemptId = String(values?.[1]);
      return { rows: [{ id: saved.id }] };
    }
    if (sql.includes("set \"deliveryStatus\"='unknown'")) {
      saved.deliveryStatus = "unknown";
      return { rows: [] };
    }
    return { rows: [{ ...saved }] };
  });
  const fetcher = vi.fn().mockRejectedValue(new Error("response lost"));
  vi.stubGlobal("fetch", fetcher);
  prepare({ action: "send", invitationId: row.id });
  await runProtectedAppAccess(input);
  prepare({ action: "send", invitationId: row.id });
  await runProtectedAppAccess(input);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(saved.deliveryStatus).toBe("unknown");
  expect(JSON.parse(String(state.write.mock.calls.at(-1)?.[1])).result.status).toBe(
    "delivery_unknown",
  );
});

it("releases a known-unsent delivery reservation when the approval becomes stale before send", async () => {
  const saved = { ...row };
  state.query.mockImplementation(async (sql: string, values?: unknown[]) => {
    if (sql.includes("set \"deliveryStatus\"='sending'")) {
      saved.deliveryStatus = "sending";
      saved.deliveryAttemptId = String(values?.[1]);
      return { rows: [{ id: saved.id }] };
    }
    if (sql.includes("set \"deliveryStatus\"='ready'")) {
      saved.deliveryStatus = "ready";
      saved.deliveryAttemptId = null;
      return { rows: [] };
    }
    return { rows: [{ ...saved }] };
  });
  state.assertCurrent.mockImplementation(async () => {
    if (saved.deliveryStatus === "sending") throw new Error("stale approval");
  });
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  prepare({ action: "send", invitationId: row.id });
  await expect(runProtectedAppAccess(input)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  expect(saved.deliveryStatus).toBe("ready");
  expect(saved.deliveryAttemptId).toBeNull();
});

it("binds the restricted role to the full approved plan before a database effect", async () => {
  prepare({ action: "list" });
  state.query.mockResolvedValue({ rows: [] });
  await runProtectedAppAccessReadback(input);
  expect(state.verifyOperator).toHaveBeenCalledWith(expect.anything(), resource, "auth_operator");
  prepare({ action: "list" });
  state.databaseUrl = state.databaseUrl.replace("auth_operator:", "auth_migrator:");
  await expect(runProtectedAppAccessReadback(input)).rejects.toThrow();
  expect(state.authorize).not.toHaveBeenCalled();
});

it("rejects a missing or changed approved operator role", async () => {
  prepare({ action: "list" });
  const plan = JSON.parse(state.files.get("operator-plan.json")!);
  delete plan.authOperatorRole;
  const wire = JSON.stringify(plan);
  state.files.set("operator-plan.json", wire);
  (state.context.operation as Record<string, unknown>).approval_digest = createHash("sha256")
    .update(wire)
    .digest("hex");
  await expect(runProtectedAppAccessReadback(input)).rejects.toThrow();
  expect(state.verifyOperator).not.toHaveBeenCalled();
  prepare({ action: "list" });
  state.files.set(
    "operator-plan.json",
    state.files.get("operator-plan.json")!.replace("auth_operator", "other_operator"),
  );
  await expect(runProtectedAppAccessReadback(input)).rejects.toThrow();
  expect(state.verifyOperator).not.toHaveBeenCalled();
});

it("checks the connection identity after accepting a newly approved operator role", async () => {
  const approveOtherRole = () => {
    prepare({ action: "list" });
    const plan = JSON.parse(state.files.get("operator-plan.json")!);
    plan.authOperatorRole = "other_operator";
    const wire = JSON.stringify(plan);
    state.files.set("operator-plan.json", wire);
    (state.context.operation as Record<string, unknown>).approval_digest = createHash("sha256")
      .update(wire)
      .digest("hex");
  };
  approveOtherRole();
  await expect(runProtectedAppAccessReadback(input)).rejects.toThrow(
    "protected_auth_worker_failed:startup_rejected",
  );
  expect(state.verifyOperator).not.toHaveBeenCalled();
  expect(state.query).not.toHaveBeenCalled();
  expect(state.authorize).not.toHaveBeenCalled();

  // The same correctly approved role reaches the database verifier when the login matches.
  approveOtherRole();
  state.databaseUrl = state.databaseUrl.replace("auth_operator:", "other_operator:");
  state.query.mockResolvedValue({ rows: [] });
  await runProtectedAppAccessReadback(input);
  expect(state.verifyOperator).toHaveBeenCalledWith(expect.anything(), resource, "other_operator");
});

it.each(["read-signup-policy", "read-signup"])(
  "reads absent %s under the protected scope without authorizing a write",
  async (action) => {
    prepare({
      action,
      policyId: row.operationRef,
      ...(action === "read-signup" ? { claimId: row.id } : {}),
    });
    state.query.mockResolvedValue({ rows: [] });
    await runProtectedAppAccessReadback(input);
    expect(state.authorize).not.toHaveBeenCalled();
    expect(JSON.parse(String(state.write.mock.calls[0]?.[1])).result).toBeNull();
  },
);

it("rejects policy installation through the read-only worker before SQL", async () => {
  prepare({
    action: "set-signup-policy",
    policy: {
      version: 1,
      policyId: row.operationRef,
      eligibility: "public",
      appRoles: [],
      storage: "none",
      appPath: "/requests",
    },
  });
  await expect(runProtectedAppAccessReadback(input)).rejects.toThrow("startup_rejected");
  expect(state.query).not.toHaveBeenCalled();
  expect(state.authorize).not.toHaveBeenCalled();
});

it("requires the current lease and approved route before changing signup policy", async () => {
  const request = {
    action: "set-signup-policy",
    policy: {
      version: 1,
      policyId: row.operationRef,
      eligibility: "public",
      appRoles: [],
      storage: "none",
      appPath: "/requests/inbox",
    },
  };
  prepare(request);
  state.assertCurrent.mockRejectedValueOnce(new Error("stale lease"));
  await expect(runProtectedAppAccess(input)).rejects.toThrow();
  expect(state.query).not.toHaveBeenCalled();
  expect(state.authorize).not.toHaveBeenCalled();

  for (const [approved, changed] of [
    ["/requests/inbox", "/requests/unapproved"],
    ['"repositoryId":"123"', '"repositoryId":"foreign"'],
  ] as const) {
    prepare(request);
    state.files.set(
      "operator-plan.json",
      state.files.get("operator-plan.json")!.replace(approved, changed),
    );
    await expect(runProtectedAppAccess(input)).rejects.toThrow("startup_rejected");
    expect(state.query).not.toHaveBeenCalled();
    expect(state.authorize).not.toHaveBeenCalled();
  }
});
