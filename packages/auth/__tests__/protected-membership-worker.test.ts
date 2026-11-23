import { createHash, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueRealmOperatorLinkProof } from "../operator-identity-link";
import { appSignupPolicyDigest, authDatabaseResourceDigest } from "../signup-policy";
import {
  ownedOrganizationMembershipSchema,
  selectOwnedOrganizationSpec,
  type OwnedOrganizationSpec,
} from "../owned-organization";
import {
  runProtectedAuthMembershipInstaller,
  runProtectedAuthMembershipReadback,
  runProtectedAuthSignupPolicyInstaller,
} from "../protected-membership-worker";

const transport = vi.hoisted(() => ({
  files: new Map<string, string>(),
  context: {} as Record<string, unknown>,
  assertCurrent: vi.fn(async () => {}),
  authorize: vi.fn(async () => 1),
  checkpoint: vi.fn(async () => {}),
  started: vi.fn(),
  succeeded: vi.fn(),
  failed: vi.fn(),
  connect: vi.fn(async () => ({ release: vi.fn(), query: transport.databaseQuery })),
  close: vi.fn(),
  create: vi.fn(async (_input: unknown) => ({ replayed: false, readbackSha256: "c".repeat(64) })),
  read: vi.fn(async (_input: unknown) => ({ status: "applied", readbackSha256: "c".repeat(64) })),
  databaseQuery: vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({
    rows: [] as Record<string, unknown>[],
  })),
  writeFile: vi.fn(async (_path: string, _data: string, _options: unknown) => {}),
  verifyOidc: vi.fn(async () => {}),
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: { ...actual, writeFile: transport.writeFile },
    writeFile: transport.writeFile,
  };
});
vi.mock("@vercel/oidc", () => ({ verifyVercelOidcToken: transport.verifyOidc }));
vi.mock("pg", () => ({
  Pool: class {
    connect = transport.connect;
    end = vi.fn(async () => {});
  },
}));
vi.mock("../owned-organization", async (original) => ({
  ...(await original<typeof import("../owned-organization")>()),
  createOwnedRealmOrganization: transport.create,
  readOwnedRealmOrganization: transport.read,
}));
vi.mock("../../protected-installer/node-spool", () => ({
  ProtectedInstallerSpoolSession: class {
    context = transport.context;
    contextDigest = "context-digest";
    databaseUrl = "private-transport-binding";
    lifecycle = {
      started: transport.started,
      succeeded: transport.succeeded,
      failed: transport.failed,
    };
    assertCurrent = transport.assertCurrent;
    authorize = transport.authorize;
    checkpoint = transport.checkpoint;
    close = transport.close;
    open() {
      return this;
    }
    readStartupFile(name: string) {
      const value = transport.files.get(name);
      if (value === undefined) throw new Error("missing-startup-file");
      return Buffer.from(value);
    }
    removeStartupFile(name: string) {
      transport.files.delete(name);
    }
  },
}));

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const keys = generateKeyPairSync("ed25519");
const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid: "test-key" };
const resource = {
  version: 1 as const,
  environment: "preview" as const,
  hostname: "ep-test.neon.tech",
  port: 5432,
  database: "auth_test",
  schema: "public" as const,
  runtimeRole: "auth_runtime",
  migratorRole: "auth_migrator",
  neon: { projectId: "neon-project", branchId: "neon-branch" },
};
const source = {
  audience: "https://vercel.com/team",
  issuer: "https://oidc.vercel.com/team",
  ownerId: "team",
  projectId: "operator",
  environment: "preview" as const,
};
const makeOwner = (organizationId: string, environment: "preview" | "production" = "preview") => {
  const now = new Date();
  const proof = issueRealmOperatorLinkProof({
    identity: {
      version: 1,
      actorId: `owner-${organizationId}`,
      sessionId: `session-${organizationId}`,
      organizationId: null,
      expiresAt: new Date(now.getTime() + 60000).toISOString(),
    },
    resource: { ...resource, environment },
    challenge: {
      nonce: digest(organizationId),
      ownerSessionId: "builder-session",
      bootstrapPlanDigest: "a".repeat(64),
      authResourceId: "auth-resource",
      organizationId: null,
    },
    config: {
      browserOrigin: "https://realm.example",
      builderCallbackOrigin: "https://builder.example",
      builderCallbackPath: "/api/hosted-operator/realm-identity",
      operatorOrigin: "https://operator.example",
    },
    issuer: "https://realm.example",
    keyId: "test-key",
    privateKey: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    now,
  });
  const spec: OwnedOrganizationSpec = {
    kind: "create-owned-organization",
    organizationId,
    slug: organizationId,
    name: `Approved ${organizationId}`,
    actorId: `owner-${organizationId}`,
    bootstrapPlanDigest: "a".repeat(64),
    identityNonceSha256: digest(digest(organizationId)),
    identityProof: { reference: `private-${organizationId}`, sha256: digest(proof) },
    identityCapture: { capturedAt: now.toISOString(), realmSessionId: `session-${organizationId}` },
    identityVerification: {
      issuer: "https://realm.example",
      audience: "https://operator.example",
      jwksUrl: "https://realm.example/_platform/jwks.json",
      transportSource: { ...source, environment },
    },
  };
  return { spec, proof };
};
const owners = [makeOwner("first-org"), makeOwner("second-org")];
const productionOwners = [
  makeOwner("first-org", "production"),
  makeOwner("second-org", "production"),
];
function fixture(
  plural = true,
  selected = 1,
  representation: "canonical" | "wire" = "canonical",
  signupPolicy = false,
  effectId = "auth-membership",
  participantProgram = false,
  builderEffectIds = false,
  environment: "preview" | "production" = "preview",
) {
  const selectedOwners = environment === "production" ? productionOwners : owners;
  const selectedResource = { ...resource, environment };
  const membership = plural
    ? {
        kind: "create-owned-organizations" as const,
        organizations: selectedOwners.map(({ spec }) => spec),
      }
    : selectedOwners[selected]!.spec;
  const plan = {
    version: 1,
    action: "prepare",
    ...(!participantProgram ? { authMembership: membership } : {}),
    effects: [
      ...(!participantProgram
        ? [
            builderEffectIds
              ? { id: "auth-membership", kind: "auth-membership" }
              : { effectId: "auth-membership", kind: "auth-membership" },
          ]
        : []),
      ...(signupPolicy
        ? [
            builderEffectIds
              ? { id: "auth-signup-policy", kind: "auth-signup-policy" }
              : { effectId: "auth-signup-policy", kind: "auth-signup-policy" },
          ]
        : []),
    ],
    ...(signupPolicy
      ? {
          authSignupPolicy: {
            version: 1 as const,
            policyId: `policy-${selectedOwners[selected]!.spec.organizationId}`,
            authResourceId: "auth-resource",
            appId: "spend-review",
            origin: "https://realm.example",
            appPath: "/",
            organizationId: selectedOwners[selected]!.spec.organizationId,
            eligibility: "public" as const,
            membershipRole: "member" as const,
            appRoles: ["member"],
          },
        }
      : {}),
    ...(participantProgram
      ? {
          normalActorProgram: {
            appId: "spend-review",
            origin: "https://realm.example",
            organizations: [{ organizationId: selectedOwners[selected]!.spec.organizationId }],
            appAccess: [
              {
                organizationId: selectedOwners[selected]!.spec.organizationId,
                roles: ["member", "reviewer"],
              },
            ],
          },
        }
      : {}),
    selection: { sessionId: "builder-session" },
    authDatabase: {
      database: selectedResource.database,
      migratorRole: selectedResource.migratorRole,
      runtimeRole: selectedResource.runtimeRole,
      resourceId: "auth-resource",
    },
    neon: { endpoint: selectedResource.hostname, ...selectedResource.neon },
    deploymentBoundary: {
      teamId: "team",
      operator: { projectId: "operator", environment },
      verification: {
        publicOrigin: "https://realm.example",
        gatewayOrigin: "https://realm.example",
        jwksUrl: "https://realm.example/_platform/jwks.json",
      },
    },
    // The worker's parsed projection cannot replace this complete approved input.
    approvedParticipantProgram: {
      digest: "e".repeat(64),
      actorKeys: ["first-owner", "second-owner"],
    },
  };
  const planDigest = digest(
    representation === "canonical" ? canonical(plan) : JSON.stringify(plan),
  );
  transport.context = {
    installer: { id: "auth-owned-organization-v1" },
    app_id: "auth",
    tenant_targets: [],
    operation: { approval_digest: planDigest, operation_id: "operation", fence_generation: 3 },
    release: { id: planDigest, sha256: selectedOwners[selected]!.spec.identityProof.sha256 },
    resource: {
      resource_id: "auth-resource",
      database: selectedResource.database,
      environment: selectedResource.environment,
      schema: selectedResource.schema,
      hostname: selectedResource.hostname,
      port: selectedResource.port,
      migrator_role: selectedResource.migratorRole,
      runtime_role: selectedResource.runtimeRole,
      provider_project_id: selectedResource.neon.projectId,
      provider_branch_id: selectedResource.neon.branchId,
    },
  };
  transport.files.set("operator-plan.json", JSON.stringify(plan));
  transport.files.set("auth-database-resource.json", JSON.stringify(selectedResource));
  transport.files.set(
    "membership-effect.json",
    JSON.stringify({ version: 1, effectId, kind: effectId }),
  );
  transport.files.set(
    "realm-identity-proof.json",
    JSON.stringify({ proof: selectedOwners[selected]!.proof }),
  );
  transport.files.set(
    "gateway-readback-oidc.json",
    JSON.stringify({ token: "private-native-transport" }),
  );
  if (plural)
    transport.files.set(
      "membership-target.json",
      JSON.stringify({ organizationId: selectedOwners[selected]!.spec.organizationId }),
    );
  return { plan, planDigest };
}
const run = () =>
  runProtectedAuthMembershipInstaller({
    spoolDirectory: "/private/test-spool",
    runId: "test-run",
    timeoutMs: 1000,
  });
const runSignupPolicy = () =>
  runProtectedAuthSignupPolicyInstaller({
    spoolDirectory: "/private/test-spool",
    runId: "test-run",
    timeoutMs: 1000,
  });
beforeEach(() => {
  vi.clearAllMocks();
  transport.files.clear();
  transport.assertCurrent.mockResolvedValue();
  transport.verifyOidc.mockResolvedValue();
  transport.databaseQuery.mockResolvedValue({ rows: [] });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }))),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("immutable approved organization selection", () => {
  it("selects exactly one entry without changing the original list", () => {
    const input = {
      kind: "create-owned-organizations" as const,
      organizations: owners.map(({ spec }) => spec),
    };
    const before = canonical(input);
    expect(selectOwnedOrganizationSpec(input, { organizationId: "second-org" })).toEqual(
      owners[1]!.spec,
    );
    expect(canonical(input)).toBe(before);
  });
  it.each([
    { organizations: [] },
    { organizations: [owners[0]!.spec, owners[0]!.spec] },
    { organizations: [owners[0]!.spec, { ...owners[1]!.spec, slug: "first-org" }] },
  ])("rejects empty or ambiguous approved lists", ({ organizations }) => {
    expect(
      ownedOrganizationMembershipSchema.safeParse({
        kind: "create-owned-organizations",
        organizations,
      }).success,
    ).toBe(false);
  });
  it.each([
    undefined,
    {},
    { organizationId: "unapproved" },
    { organizationId: "first-org", actorId: "override" },
  ])("rejects missing, unapproved or expanded selectors", (target) => {
    expect(() =>
      selectOwnedOrganizationSpec(
        { kind: "create-owned-organizations", organizations: owners.map(({ spec }) => spec) },
        target,
      ),
    ).toThrow();
  });
  it("retains single-organization input and rejects a conflicting explicit selector", () => {
    expect(selectOwnedOrganizationSpec(owners[0]!.spec)).toEqual(owners[0]!.spec);
    expect(() =>
      selectOwnedOrganizationSpec(owners[0]!.spec, { organizationId: "second-org" }),
    ).toThrow();
  });
});

describe("Production worker authority separation", () => {
  const readback = () =>
    runProtectedAuthMembershipReadback({
      spoolDirectory: "/private/test-spool",
      runId: "test-run",
      timeoutMs: 1000,
    });

  it.each([false, true])(
    "retains separately approved owner organization work (readback=%s)",
    async (readOnly) => {
      fixture(true, 1, "canonical", false, "auth-membership", false, false, "production");
      await (readOnly ? readback() : run());
      expect(readOnly ? transport.read : transport.create).toHaveBeenCalledOnce();
      expect(transport.succeeded).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    "retains separately approved signup policy work (readback=%s)",
    async (readOnly) => {
      const { plan, planDigest } = fixture(
        true,
        1,
        "canonical",
        true,
        "auth-signup-policy",
        true,
        false,
        "production",
      );
      const policyDigest = appSignupPolicyDigest({
        ...plan.authSignupPolicy!,
        operationRef: "operation",
        planDigest,
        fenceGeneration: 3,
      });
      transport.databaseQuery.mockImplementation(async (sql, values) => {
        if (sql.includes("update public.organization"))
          return { rows: [{ appIds: ["spend-review"] }] };
        if (
          sql.includes('select 1 from "organization"') ||
          sql.includes("select 1 from public.organization")
        )
          return { rows: [{ ok: 1 }] };
        if (sql.includes('insert into "app_signup_policy"'))
          return { rows: [{ id: values?.[0], policyDigest: values?.[12] }] };
        if (sql.includes('select "policyDigest"'))
          return { rows: [{ policyDigest, fenceGeneration: 3 }] };
        return { rows: [] };
      });
      await (readOnly ? readback() : runSignupPolicy());
      expect(transport.succeeded).toHaveBeenCalledOnce();
      expect(transport.create).not.toHaveBeenCalled();
      if (readOnly) expect(transport.authorize).not.toHaveBeenCalled();
      else expect(transport.authorize).toHaveBeenCalledWith("auth-signup-policy", null);
    },
  );

  it.each([false, true])(
    "still rejects Production existing-org membership without its restricted role (readback=%s)",
    async (readOnly) => {
      const { plan } = fixture(
        false,
        1,
        "canonical",
        false,
        "auth-membership",
        false,
        false,
        "production",
      );
      const owner = productionOwners[1]!.spec;
      const approved = {
        ...plan,
        selection: { ...plan.selection, workspaceId: "builder-workspace" },
        authMembership: {
          kind: "join-existing-organization",
          workspaceId: "builder-workspace",
          membershipRole: "member",
          organizationId: owner.organizationId,
          actorId: owner.actorId,
          bootstrapPlanDigest: owner.bootstrapPlanDigest,
          identityNonceSha256: owner.identityNonceSha256,
          identityCapture: owner.identityCapture,
          identityProof: owner.identityProof,
          identityVerification: owner.identityVerification,
        },
      };
      const planDigest = digest(canonical(approved));
      transport.files.set("operator-plan.json", JSON.stringify(approved));
      transport.context.operation = {
        approval_digest: planDigest,
        operation_id: "operation",
        fence_generation: 3,
      };
      transport.context.release = { id: planDigest, sha256: owner.identityProof.sha256 };
      await expect(readOnly ? readback() : run()).rejects.toThrow(
        "protected_auth_worker_failed:startup_rejected",
      );
      expect(transport.connect).not.toHaveBeenCalled();
      expect(transport.authorize).not.toHaveBeenCalled();
    },
  );
});

describe("protected invocation over a full approved list", () => {
  it("persists the exact app signup policy under the approved operation and fence", async () => {
    const { planDigest } = fixture(true, 1, "canonical", true, "auth-signup-policy");
    transport.databaseQuery.mockImplementation(async (sql, values) => {
      if (sql.includes("update public.organization"))
        return { rows: [{ appIds: ["spend-review"] }] };
      if (sql.includes('select 1 from "organization"')) return { rows: [{ ok: 1 }] };
      if (sql.includes('insert into "app_signup_policy"'))
        return { rows: [{ id: values?.[0], policyDigest: values?.[12] }] };
      return { rows: [] };
    });
    await runSignupPolicy();
    const policyInsert = transport.databaseQuery.mock.calls.find(([sql]) =>
      sql.includes('insert into "app_signup_policy"'),
    );
    expect(policyInsert?.[1]).toMatchObject([
      "policy-second-org",
      "auth-resource",
      expect.any(String),
      "spend-review",
      "https://realm.example",
      "/",
      "second-org",
      "public",
      "[]",
      '["member"]',
      "operation",
      planDigest,
      expect.any(String),
      3,
    ]);
    expect(transport.authorize).toHaveBeenCalledWith("auth-signup-policy", null);
    expect(transport.checkpoint).toHaveBeenCalledWith(1, "auth-signup-policy", null, {
      state: "applied",
      readback_sha256: expect.any(String),
    });
  });

  it("accepts the raw Builder id/kind effects for participant-program signup policy without owner proof", async () => {
    const { planDigest, plan } = fixture(
      true,
      1,
      "canonical",
      true,
      "auth-signup-policy",
      true,
      true,
    );
    expect(plan.effects).toContainEqual({ id: "auth-signup-policy", kind: "auth-signup-policy" });
    expect(JSON.parse(transport.files.get("membership-effect.json")!)).toEqual({
      version: 1,
      effectId: "auth-signup-policy",
      kind: "auth-signup-policy",
    });
    transport.databaseQuery.mockImplementation(async (sql, values) => {
      if (sql.includes("update public.organization"))
        return { rows: [{ appIds: ["spend-review"] }] };
      if (sql.includes('select 1 from "organization"')) return { rows: [{ ok: 1 }] };
      if (sql.includes('insert into "app_signup_policy"'))
        return { rows: [{ id: values?.[0], policyDigest: values?.[12] }] };
      return { rows: [] };
    });
    await runSignupPolicy();
    expect(transport.authorize).toHaveBeenCalledWith("auth-signup-policy", null);
    expect(transport.checkpoint).toHaveBeenCalledWith(
      1,
      "auth-signup-policy",
      null,
      expect.objectContaining({ state: "applied" }),
    );
    expect(transport.verifyOidc).not.toHaveBeenCalled();
    expect(transport.create).not.toHaveBeenCalled();
    expect(
      transport.databaseQuery.mock.calls.some(([sql]) =>
        sql.includes('insert into "app_signup_policy"'),
      ),
    ).toBe(true);
    expect(planDigest).toBe(
      (transport.context.operation as { approval_digest: string }).approval_digest,
    );
  });

  it.each([0, 1])(
    "executes one selected normal signed owner under the complete plan digest",
    async (selected) => {
      const { planDigest } = fixture(true, selected);
      await run();
      expect(transport.create).toHaveBeenCalledOnce();
      expect(transport.create.mock.calls[0]?.[0]).toMatchObject({
        spec: owners[selected]!.spec,
        planDigest,
        ownerSessionId: "builder-session",
        realmSessionId: `session-${owners[selected]!.spec.organizationId}`,
      });
      expect(transport.authorize).toHaveBeenCalledWith("auth-membership", null);
      expect(transport.checkpoint).toHaveBeenCalledWith(1, "auth-membership", null, {
        state: "applied",
        readback_sha256: "c".repeat(64),
      });
      expect(transport.verifyOidc).toHaveBeenCalledWith("private-native-transport", source);
      expect(transport.assertCurrent).toHaveBeenCalledOnce();
      expect(transport.files.size).toBe(0);
      expect(transport.succeeded).toHaveBeenCalledOnce();
    },
  );
  it("checkpoints an idempotent organization replay without creating another target", async () => {
    fixture();
    transport.create.mockResolvedValueOnce({ replayed: true, readbackSha256: "c".repeat(64) });
    await run();
    expect(transport.create).toHaveBeenCalledOnce();
    expect(transport.checkpoint).toHaveBeenCalledWith(1, "auth-membership", null, {
      state: "no_change",
      readback_sha256: "c".repeat(64),
    });
  });
  it.each(["canonical", "wire"] as const)(
    "retains the accepted %s approval as the organization replay identity",
    async (representation) => {
      const { planDigest } = fixture(true, 1, representation);
      transport.create.mockResolvedValueOnce({ replayed: true, readbackSha256: "c".repeat(64) });
      await run();
      expect(transport.create.mock.calls[0]?.[0]).toMatchObject({ planDigest });
      expect(transport.checkpoint).toHaveBeenCalledWith(1, "auth-membership", null, {
        state: "no_change",
        readback_sha256: "c".repeat(64),
      });
    },
  );
  it("reads back membership before policy install, then reads back the selected signup policy", async () => {
    const first = fixture(true, 1, "canonical", true);
    await run();
    expect(transport.checkpoint).toHaveBeenCalledWith(
      1,
      "auth-membership",
      null,
      expect.objectContaining({ state: "applied" }),
    );

    fixture(true, 1, "canonical", true);
    transport.databaseQuery.mockClear();
    await runProtectedAuthMembershipReadback({
      spoolDirectory: "/private/test-spool",
      runId: "test-run",
      timeoutMs: 1000,
    });
    expect(transport.read).toHaveBeenCalledOnce();
    expect(transport.databaseQuery).not.toHaveBeenCalled();

    const policyPlan = fixture(true, 1, "canonical", true, "auth-signup-policy");
    const signupPolicy = {
      version: 1 as const,
      policyId: "policy-second-org",
      authResourceId: "auth-resource",
      appId: "spend-review",
      origin: "https://realm.example",
      appPath: "/",
      organizationId: "second-org",
      eligibility: "public" as const,
      membershipRole: "member" as const,
      appRoles: ["member"],
    };
    const policyDigest = appSignupPolicyDigest({
      ...signupPolicy,
      operationRef: "operation",
      planDigest: policyPlan.planDigest,
      fenceGeneration: 3,
    });
    transport.databaseQuery.mockImplementation(async (sql, values) => {
      if (sql.includes("update public.organization"))
        return { rows: [{ appIds: ["spend-review"] }] };
      if (sql.includes('select 1 from "organization"')) return { rows: [{ ok: 1 }] };
      if (sql.includes('insert into "app_signup_policy"'))
        return { rows: [{ id: values?.[0], policyDigest: values?.[12] }] };
      if (sql.includes('select "policyDigest"'))
        return { rows: [{ policyDigest, fenceGeneration: 3 }] };
      if (sql.includes("select 1 from public.organization")) return { rows: [{ ok: 1 }] };
      return { rows: [] };
    });
    await runSignupPolicy();
    expect(transport.checkpoint).toHaveBeenCalledWith(
      1,
      "auth-signup-policy",
      null,
      expect.objectContaining({ state: "applied" }),
    );

    fixture(true, 1, "canonical", true, "auth-signup-policy");
    transport.databaseQuery.mockImplementation(async (sql) => {
      if (sql.includes('select "policyDigest"'))
        return { rows: [{ policyDigest, fenceGeneration: 3 }] };
      if (sql.includes("select 1 from public.organization")) return { rows: [{ ok: 1 }] };
      return { rows: [] };
    });
    await runProtectedAuthMembershipReadback({
      spoolDirectory: "/private/test-spool",
      runId: "test-run",
      timeoutMs: 1000,
    });
    const policyReadback = transport.databaseQuery.mock.calls.find(([sql]) =>
      sql.includes('select "policyDigest"'),
    );
    expect(policyReadback?.[1]).toEqual([
      signupPolicy.policyId,
      signupPolicy.authResourceId,
      authDatabaseResourceDigest(resource),
      signupPolicy.appId,
      signupPolicy.origin,
      signupPolicy.appPath,
      signupPolicy.organizationId,
      "operation",
      policyPlan.planDigest,
    ]);
    expect(
      transport.databaseQuery.mock.calls.some(([sql]) =>
        sql.includes("select 1 from public.organization"),
      ),
    ).toBe(true);
    expect(JSON.parse(String(transport.writeFile.mock.calls.at(-1)?.[1]))).toMatchObject({
      status: "applied",
    });
    expect(first.planDigest).toBe(policyPlan.planDigest);
  });
  it.each(["canonical", "wire"] as const)(
    "rejects semantic tampering and sliced %s approvals before database access",
    async (representation) => {
      const { plan } = fixture(true, 1, representation);
      plan.approvedParticipantProgram.actorKeys.push("unapproved-actor");
      transport.files.set("operator-plan.json", JSON.stringify(plan));
      await expect(run()).rejects.toThrow("protected_auth_worker_failed:");
      expect(transport.connect).not.toHaveBeenCalled();
      const { plan: originalPlan } = fixture(true, 1, representation);
      const sliced = { ...originalPlan, authMembership: owners[1]!.spec };
      const slicedDigest = digest(
        representation === "canonical" ? canonical(sliced) : JSON.stringify(sliced),
      );
      transport.context.operation = { approval_digest: slicedDigest };
      transport.context.release = {
        id: slicedDigest,
        sha256: owners[1]!.spec.identityProof.sha256,
      };
      await expect(run()).rejects.toThrow("protected_auth_worker_failed:");
      expect(transport.connect).not.toHaveBeenCalled();
      expect(transport.create).not.toHaveBeenCalled();
    },
  );
  it.each(["canonical", "wire"] as const)(
    "rejects a release bound to the other representation of the same %s approved plan",
    async (representation) => {
      const { plan, planDigest } = fixture(true, 1, representation);
      const otherDigest = digest(
        representation === "wire" ? canonical(plan) : JSON.stringify(plan),
      );
      expect(otherDigest).not.toBe(planDigest);
      transport.context.release = { id: otherDigest, sha256: owners[1]!.spec.identityProof.sha256 };
      await expect(run()).rejects.toThrow("protected_auth_worker_failed:");
      expect(transport.connect).not.toHaveBeenCalled();
      expect(transport.create).not.toHaveBeenCalled();
    },
  );
  it.each(["canonical", "wire"] as const)(
    "keeps the legacy worker startup contract with %s approval",
    async (representation) => {
      fixture(false, 0, representation);
      await run();
      expect(transport.create).toHaveBeenCalledOnce();
      expect(transport.create.mock.calls[0]?.[0]).toMatchObject({ spec: owners[0]!.spec });
    },
  );
  it.each(["canonical", "wire"] as const)(
    "reconciles the selected organization with %s approval without authorizing an effect",
    async (representation) => {
      const { planDigest } = fixture(true, 1, representation);
      await runProtectedAuthMembershipReadback({
        spoolDirectory: "/private/test-spool",
        runId: "test-run",
        timeoutMs: 1000,
      });
      expect(transport.read.mock.calls[0]?.[0]).toMatchObject({
        spec: owners[1]!.spec,
        planDigest,
      });
      expect(transport.create).not.toHaveBeenCalled();
      expect(transport.authorize).not.toHaveBeenCalled();
      expect(transport.checkpoint).not.toHaveBeenCalled();
      expect(JSON.parse(String(transport.writeFile.mock.calls[0]?.[1]))).toMatchObject({
        status: "applied",
        readback_sha256: "c".repeat(64),
      });
    },
  );
  it.each([
    "missing-selector",
    "outside-list",
    "sliced-plan-digest",
    "wrong-proof-digest",
    "other-owner-proof",
    "swapped-actor",
    "revoked-fence",
    "native-token-denied",
  ])("denies %s before any database effect", async (change) => {
    const { plan } = fixture();
    if (change === "missing-selector") transport.files.delete("membership-target.json");
    if (change === "outside-list")
      transport.files.set(
        "membership-target.json",
        JSON.stringify({ organizationId: "third-org" }),
      );
    if (change === "sliced-plan-digest")
      transport.context.operation = {
        approval_digest: digest(canonical({ ...plan, authMembership: owners[1]!.spec })),
      };
    if (change === "wrong-proof-digest")
      transport.context.release = {
        id: digest(canonical(plan)),
        sha256: owners[0]!.spec.identityProof.sha256,
      };
    if (change === "other-owner-proof")
      transport.files.set("realm-identity-proof.json", JSON.stringify({ proof: owners[0]!.proof }));
    if (change === "swapped-actor") {
      plan.authMembership = {
        kind: "create-owned-organizations",
        organizations: [owners[0]!.spec, { ...owners[1]!.spec, actorId: "forged-owner" }],
      };
      transport.files.set("operator-plan.json", JSON.stringify(plan));
      const planDigest = digest(canonical(plan));
      transport.context.operation = { approval_digest: planDigest };
      transport.context.release = { id: planDigest, sha256: owners[1]!.spec.identityProof.sha256 };
    }
    if (change === "revoked-fence")
      transport.assertCurrent.mockRejectedValueOnce(
        new Error("protected_installer_authority_denied"),
      );
    if (change === "native-token-denied")
      transport.verifyOidc.mockRejectedValueOnce(new Error("native-token-denied"));
    await expect(run()).rejects.toThrow("protected_auth_worker_failed:");
    expect(transport.connect).not.toHaveBeenCalled();
    expect(transport.authorize).not.toHaveBeenCalled();
    expect(transport.create).not.toHaveBeenCalled();
    expect(transport.succeeded).not.toHaveBeenCalled();
  });
});
