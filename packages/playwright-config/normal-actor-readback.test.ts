import { beforeEach, expect, it, vi } from "vitest";
import type { DataContext } from "@autograph/generated-app-runtime/data";
import { NormalActorReadbackError, withNormalActorReadback } from "./normal-actor-readback.js";

const state = vi.hoisted(() => ({
  rolePrivileged: false,
  authPolicyWritable: false,
  wrongMarker: false,
  authAssigned: true,
  authAdmitted: true,
  authAdmissionWritable: false,
  authAdmissionFence: 4,
  authAdmissionRoles: [] as string[],
  kernelAssigned: true,
  fence: 4,
  activeRelease: "release-one",
  closed: 0,
  callbacks: 0,
  privateChanged: false,
  queryFailure: false,
  operations: [] as Array<{ operation: string; payload: Record<string, unknown> }>,
}));
const fixture = vi.hoisted(() => ({
  plan: {
    version: 1,
    appId: "review",
    environment: "local",
    runtimeId: "owned-runtime",
    database: "owned_app",
    authDatabase: "owned_auth",
    principal: "app_runtime",
    authPrincipal: "auth_runtime",
    authScope: "context",
    roles: ["reviewer"],
    tenants: ["tenant-one", "tenant-two"],
    releaseId: "release-one",
    artifactHash: "artifact-sha",
  },
  identity: {
    actorKey: "member",
    actorId: "member",
    organizationId: "tenant-one",
    roles: ["reviewer"],
    role: "reviewer" as string | null,
    access: undefined as "admitted" | "unassigned" | undefined,
    storageState: "/private/state",
  },
  appRuntimeUrl: "postgresql://app_runtime:private-password@127.0.0.1:15432/owned_app",
  authRuntimeUrl: "postgresql://auth_runtime:private-auth@127.0.0.1:15432/owned_auth",
}));
vi.mock("./normal-actor-private-fixture.js", () => ({
  readProtectedNormalActorFixture: async () => ({
    ...fixture,
    assertCurrent: async () => {
      if (state.privateChanged) throw new Error("private fixture bytes changed");
    },
  }),
}));
vi.mock("@autograph/generated-app-runtime/release-verification", () => ({
  verifyCheckedRelease: () => ({
    app: "review",
    schema_version: "release-one",
    hashes: { schema: "artifact-sha" },
  }),
}));
vi.mock("pg", () => ({
  Pool: class {
    readonly auth: boolean;
    readonly options = {};
    constructor(input: { connectionString: string }) {
      this.auth = new URL(input.connectionString).pathname === "/owned_auth";
    }
    on() {}
    async end() {
      state.closed += 1;
    }
    async connect() {
      return { query: this.query.bind(this), release() {} };
    }
    async query(sql: string, parameters: string[] = []) {
      if (state.queryFailure) throw new Error("private-password must never escape");
      if (sql.includes("from pg_roles"))
        return {
          rows: [
            {
              principal: this.auth ? "auth_runtime" : "app_runtime",
              login: this.auth ? "auth_runtime" : "app_runtime",
              database: this.auth ? "owned_auth" : "owned_app",
              rolsuper: state.rolePrivileged,
              rolcreatedb: false,
              rolcreaterole: false,
              rolreplication: false,
              rolbypassrls: false,
              role_marker: state.wrongMarker
                ? "foreign-resource"
                : this.auth
                  ? "app-validation-context:local:owned-runtime"
                  : "app-validation:owned-runtime:review",
              database_marker: this.auth
                ? "app-validation-context:local:owned-runtime"
                : "app-validation:owned-runtime:review",
            },
          ],
        };
      if (sql.includes("has_table_privilege"))
        return {
          rows: [
            {
              assignment_writable: state.authPolicyWritable,
              policy_writable: false,
              admission_writable: state.authAdmissionWritable,
            },
          ],
        };
      if (sql.includes("from public.app_actor_access")) {
        expect(parameters).toEqual([
          "review",
          "tenant-one",
          "member",
          "app-validation-context:local:owned-runtime",
        ]);
        return {
          rows: state.authAdmitted
            ? [{ roles: state.authAdmissionRoles, fenceGeneration: state.authAdmissionFence }]
            : [],
        };
      }
      if (sql.includes("from public.app_actor_assignment"))
        return { rows: state.authAssigned ? [{ role: "reviewer" }] : [] };
      const operation = /select (kernel_[a-z_]+)\(/u.exec(sql)?.[1];
      if (!operation) return { rows: [] };
      const payload = JSON.parse(parameters[0]!);
      state.operations.push({ operation, payload });
      const data =
        operation === "kernel_read_actor_access"
          ? state.kernelAssigned
            ? {
                active: true,
                actorId: "member",
                appId: "review",
                organizationId: "tenant-one",
                fenceGeneration: state.fence,
              }
            : null
          : operation === "kernel_read_actor_binding"
            ? state.kernelAssigned
              ? {
                  active: true,
                  actorId: "member",
                  appId: "review",
                  organizationId: "tenant-one",
                  role: "reviewer",
                  fenceGeneration: state.fence,
                }
              : null
            : operation === "kernel_read_active_schema_revision"
              ? { schema: { version: state.activeRelease } }
              : { id: "fixture-bill", paymentStatus: "paid" };
      return { rows: [{ result: { ok: true, data } }] };
    }
  },
}));

const input = {
  appId: "review",
  selector: { actorKey: "member", organizationId: "tenant-one" },
  baseURL: "https://owned.vercel.run",
};
beforeEach(() => {
  Object.assign(state, {
    rolePrivileged: false,
    authPolicyWritable: false,
    wrongMarker: false,
    authAssigned: true,
    authAdmitted: true,
    authAdmissionWritable: false,
    authAdmissionFence: 4,
    authAdmissionRoles: [],
    kernelAssigned: true,
    fence: 4,
    activeRelease: "release-one",
    closed: 0,
    callbacks: 0,
    privateChanged: false,
    queryFailure: false,
    operations: [],
  });
  fixture.identity.roles = ["reviewer"];
  fixture.identity.role = "reviewer";
  fixture.identity.access = undefined;
  fixture.plan.roles = ["reviewer"];
  fixture.appRuntimeUrl = "postgresql://app_runtime:private-password@127.0.0.1:15432/owned_app";
});
const roleless = () => {
  fixture.plan.roles = [];
  fixture.identity.roles = [];
  fixture.identity.role = null;
  fixture.identity.access = "admitted";
};
it("reads persisted app data for an explicitly admitted roleless actor", async () => {
  roleless();
  await withNormalActorReadback(input, async (context) => {
    state.callbacks += 1;
    const row = await context.transaction(
      async (session) => await session.call("kernel_read_visible_record", { model_id: "bill" }),
    );
    expect(row).toMatchObject({ paymentStatus: "paid" });
  });
  expect(state.callbacks).toBe(1);
  expect(state.operations.some(({ operation }) => operation === "kernel_read_actor_access")).toBe(
    true,
  );
  expect(state.operations.some(({ operation }) => operation === "kernel_read_actor_binding")).toBe(
    false,
  );
  expect(state.closed).toBe(2);
});
it.each([
  "unassigned",
  "legacy-empty",
  "named-catalog",
  "missing-admission",
  "mismatched-fence",
  "revoked",
  "named-admission",
  "writable-admission",
] as const)("denies roleless %s without exposing a read context", async (kind) => {
  roleless();
  if (kind === "unassigned") fixture.identity.access = "unassigned";
  if (kind === "legacy-empty") fixture.identity.access = undefined;
  if (kind === "named-catalog") fixture.plan.roles = ["reviewer"];
  if (kind === "missing-admission") state.authAdmitted = false;
  if (kind === "mismatched-fence") state.authAdmissionFence = 3;
  if (kind === "revoked") state.kernelAssigned = false;
  if (kind === "named-admission") state.authAdmissionRoles = ["reviewer"];
  if (kind === "writable-admission") state.authAdmissionWritable = true;
  await expect(
    withNormalActorReadback(input, async () => {
      state.callbacks += 1;
    }),
  ).rejects.toThrow("Normal actor readback failed");
  expect(state.callbacks).toBe(0);
});
it("rechecks roleless admission revocation and bounds backend failures", async () => {
  roleless();
  await expect(
    withNormalActorReadback(input, async (context) => {
      state.authAdmitted = false;
      await context.transaction(
        async (session) => await session.call("kernel_read_visible_record", {}),
      );
    }),
  ).rejects.toMatchObject({
    code: "actor_not_authorized",
    message: "Normal actor readback failed (actor_not_authorized).",
  });
  state.authAdmitted = true;
  state.queryFailure = true;
  await expect(withNormalActorReadback(input, async () => {})).rejects.toMatchObject({
    code: "readback_unavailable",
    message: "Normal actor readback failed (readback_unavailable).",
  });
});
it("reads persisted app data independently through current restricted scope without returning it", async () => {
  const result = await withNormalActorReadback(input, async (context) => {
    state.callbacks += 1;
    const row = await context.transaction(
      async (session) => await session.call("kernel_read_visible_record", { model_id: "bill" }),
    );
    expect(row).toMatchObject({ paymentStatus: "paid" });
    expect(context.scope).toEqual({ appId: "review", customerId: "tenant-one" });
  });
  expect(result).toBeUndefined();
  expect(state.closed).toBe(2);
  expect(state.callbacks).toBe(1);
  expect(
    state.operations.find((entry) => entry.operation === "kernel_read_visible_record")?.payload,
  ).toMatchObject({ app_id: "review", customer_id: "tenant-one", actor_id: "member" });
});
it.each(["auth", "kernel", "unassigned", "privileged", "release", "auth-policy", "marker"])(
  "denies %s before exposing the read context",
  async (kind) => {
    if (kind === "auth") state.authAssigned = false;
    if (kind === "kernel") state.kernelAssigned = false;
    if (kind === "unassigned") fixture.identity.roles = [];
    if (kind === "privileged") state.rolePrivileged = true;
    if (kind === "release") state.activeRelease = "other-release";
    if (kind === "auth-policy") state.authPolicyWritable = true;
    if (kind === "marker") state.wrongMarker = true;
    await expect(
      withNormalActorReadback(input, async () => {
        state.callbacks += 1;
      }),
    ).rejects.toThrow("Normal actor readback failed");
    expect(state.callbacks).toBe(0);
  },
);
it("refuses a remote database even when supplied in the private fixture", async () => {
  fixture.appRuntimeUrl =
    "postgresql://app_runtime:private-password@remote.neon.tech:5432/owned_app";
  await expect(withNormalActorReadback(input, async () => {})).rejects.toThrow(
    "runtime_unavailable",
  );
  expect(state.operations).toHaveLength(0);
});
it("rejects a different app before opening a database", async () => {
  await expect(
    withNormalActorReadback({ ...input, appId: "foreign-app" }, async () => {}),
  ).rejects.toThrow("actor_not_authorized");
  expect(state.operations).toHaveLength(0);
});
it("rejects mutation entrypoints before dispatching them", async () => {
  await expect(
    withNormalActorReadback(input, async (context) => {
      await context.transaction(
        async (session) => await session.call("kernel_apply_change_set", {}),
      );
    }),
  ).rejects.toThrow("readback_unavailable");
  expect(state.operations.some((entry) => entry.operation === "kernel_apply_change_set")).toBe(
    false,
  );
});
it("rechecks actual authority during the callback and closes a retained context", async () => {
  let retained: DataContext | undefined;
  await expect(
    withNormalActorReadback(input, async (context) => {
      retained = context;
      state.authAssigned = false;
      await context.transaction(
        async (session) => await session.call("kernel_read_visible_record", {}),
      );
    }),
  ).rejects.toThrow("actor_not_authorized");
  await expect(retained!.authorize("data.read")).rejects.toThrow("scope_closed");
  expect(state.closed).toBe(2);
});
it("bounds backend failures instead of exposing credentials", async () => {
  state.queryFailure = true;
  await expect(withNormalActorReadback(input, async () => {})).rejects.toThrow(
    "readback_unavailable",
  );
  expect(state.closed).toBe(2);
});
it("normalizes callback-created typed errors instead of retaining private codes or mutated messages", async () => {
  const probe = "postgresql://private:credential@example.invalid/db record-payload";
  const untrusted: unknown = Reflect.construct(NormalActorReadbackError, [probe]);
  await expect(
    withNormalActorReadback(input, async () => {
      throw untrusted;
    }),
  ).rejects.toMatchObject({
    code: "readback_unavailable",
    message: "Normal actor readback failed (readback_unavailable).",
  });
  const changed = new NormalActorReadbackError("runtime_unavailable");
  changed.message = probe;
  Object.defineProperty(changed, "code", {
    get() {
      throw new Error(probe);
    },
  });
  await expect(
    withNormalActorReadback(input, async () => {
      throw changed;
    }),
  ).rejects.toMatchObject({
    code: "runtime_unavailable",
    message: "Normal actor readback failed (runtime_unavailable).",
  });
});

it("rejects the next read if the installed release changes inside the callback", async () => {
  await expect(
    withNormalActorReadback(input, async (context) => {
      await context.transaction(async (session) => {
        await session.call("kernel_read_visible_record", { record_id: "fixture-bill" });
        state.activeRelease = "release-two";
        await session.call("kernel_read_visible_record", { record_id: "fixture-bill" });
      });
    }),
  ).rejects.toMatchObject({ code: "release_unavailable" });
  expect(
    state.operations.filter(({ operation }) => operation === "kernel_read_visible_record"),
  ).toHaveLength(1);
});
