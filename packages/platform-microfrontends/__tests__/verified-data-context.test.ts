// @vitest-environment node
import { createHash, generateKeyPairSync } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  createPrincipalSigner,
  createPrincipalVerifier,
  PRINCIPAL_HEADER,
} from "../src/policy/identity";
import {
  agentCapabilityAllowed,
  createVerifiedAgentDataContext,
  createVerifiedGatewayDataContext,
  createVerifiedNextActionDataContext,
  createVerifiedNextReadDataContext,
} from "../src/policy/verified-data-context";
import {
  VERIFIED_BODY_HEADER,
  VERIFIED_METHOD_HEADER,
  VERIFIED_TARGET_HEADER,
} from "../src/policy/next-request-ingress";

const actual = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({ headers: () => Promise.resolve(actual.headers) }));

const keys = generateKeyPairSync("ed25519");
const signer = createPrincipalSigner({
  issuer: "https://fixture.example",
  keyId: "fixture",
  privateKey: keys.privateKey,
});
const verifier = createPrincipalVerifier({
  issuer: "https://fixture.example",
  keyId: "fixture",
  publicKey: keys.publicKey,
});
const claims = {
  aud: "fixture-app",
  sub: "actor",
  organizationId: "tenant",
  customerId: "tenant",
  organizationRole: null,
  appActorGrants: [{ role: "member", fenceGeneration: 1 }],
  method: "GET",
  path: "/fixture-app",
  jti: "fixture-request",
};
const input = (token = signer.issue(claims)) => ({
  request: {
    kind: "server-request" as const,
    headers: new Headers({ [PRINCIPAL_HEADER]: token }),
    method: "GET",
    target: "/fixture-app",
  },
  verification: { kind: "public-key" as const, verifier },
  scope: { appId: "fixture-app", actorId: "actor", organizationId: "tenant" },
  role: "member",
  runtime: {
    databaseUrl:
      "postgresql://app_runtime:private-password@127.0.0.1:5432/app_fixture?sslmode=disable",
    database: "app_fixture",
    hostname: "127.0.0.1",
    port: 5432,
    runtimeRole: "app_runtime",
    environment: "local" as const,
  },
  sourceKind: "user",
  authorize: async () => {},
  verifyRelease: () => {},
});
it("creates a protected context without a realm URL or private signing key", async () => {
  const handle = await createVerifiedGatewayDataContext(input());
  try {
    expect(handle.context.scope).toEqual({ appId: "fixture-app", customerId: "tenant" });
  } finally {
    await handle.close();
  }
});
it("uses public JWKS verification and rejects a missing protected role claim", async () => {
  const selected = input();
  const handle = await createVerifiedGatewayDataContext({
    ...selected,
    verification: {
      kind: "public-jwks",
      options: {
        publicOrigin: "https://fixture.example",
        jwksUrl: "https://fixture.example/_platform/jwks.json",
        loadJwks: async () => ({
          keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid: "fixture" }],
        }),
      },
    },
  });
  await handle.close();
  await expect(
    createVerifiedGatewayDataContext(input(signer.issue({ ...claims, appActorGrants: undefined }))),
  ).rejects.toThrow("Protected Gateway data context");
});
it("checks the actual delegated body and cannot downgrade to the ordinary request mode", async () => {
  const body = new TextEncoder().encode("fixture-body");
  const token = signer.issue({
    ...claims,
    method: "POST",
    bodySha256: createHash("sha256").update(body).digest("base64url"),
  });
  const selected = {
    ...input(token),
    normalizedPayload: { value: "fixture-body" },
    request: { ...input(token).request, method: "POST" },
  };
  const handle = await createVerifiedGatewayDataContext({
    ...selected,
    request: { ...selected.request, kind: "delegated-api", body },
  });
  await handle.close();
  await expect(
    createVerifiedGatewayDataContext({
      ...selected,
      normalizedPayload: undefined,
      request: { ...selected.request, kind: "delegated-api", body },
    }),
  ).rejects.toThrow();
  await expect(
    createVerifiedGatewayDataContext({
      ...selected,
      request: {
        ...selected.request,
        kind: "delegated-api",
        body: new TextEncoder().encode("tampered"),
      },
    }),
  ).rejects.toThrow();
  await expect(createVerifiedGatewayDataContext(selected)).rejects.toThrow();
});
it.each([
  { change: { aud: "other" } },
  { change: { sub: "other" } },
  { change: { organizationId: "other", customerId: "other" } },
  { change: { method: "PATCH" } },
  { change: { path: "/other" } },
  { change: { appActorGrants: [{ role: "reviewer", fenceGeneration: 1 }] } },
  { change: { appActorGrants: [{ role: "member", fenceGeneration: 0 }] } },
])(
  "fails closed for caller scope, role, method, target or missing positive fence",
  async ({ change }) => {
    await expect(
      createVerifiedGatewayDataContext(input(signer.issue({ ...claims, ...change }))),
    ).rejects.toThrow();
  },
);

const agentDefinition = {
  models: [
    {
      id: "fixture_record",
      name: "fixtureRecord",
      fields: [],
      relations: [{ id: "children", name: "children", model: "fixture_record", through: "parent" }],
    },
  ],
};
it("the agent context allows only generated reads and agent work-session operations", async () => {
  const allowed = [
    "fixture_record.get",
    "fixture_record.list",
    "fixture_record.count",
    "fixture_record.aggregate",
    "fixture_record.history",
    "fixture_record.relations.children.list",
    "work_session.list",
    "work_session.create",
    "work_session.get_without_overlay",
    "work_session.entries",
    "work_session.stage",
    "work_session.unstage",
    "work_session.discard_source",
    "work_session.discard_turn",
    "work_session.thread_open",
    "work_session.thread_reply",
    "work_session.thread_resolve",
    "work_session.propose",
    "work_session.dismiss",
    "work_session.rule_create",
    "work_session.rule_parameters",
    "work_session.rule_remove",
    "work_session.update",
  ];
  const refused = [
    "fixture_record.create",
    "fixture_record.update",
    "fixture_record.delete",
    "fixture_record.relations.other.list",
    "other_record.list",
    "work_session.get",
    "work_session.duplicate",
    "work_session.pin",
    "work_session.archive",
    "work_session.unarchive",
    "work_session.pull",
    "work_session.save",
    "apply",
  ];
  for (const capability of allowed)
    expect(agentCapabilityAllowed(agentDefinition, capability), capability).toBe(true);
  for (const capability of refused)
    expect(agentCapabilityAllowed(agentDefinition, capability), capability).toBe(false);
  const delegated: string[] = [];
  const agentClaims = { ...claims, agentGrant: { id: "grant-1", clientId: "client-1" } };
  const { sourceKind: _sourceKind, ...base } = input(signer.issue(agentClaims));
  // A human principal never opens the agent context, and an agent principal
  // never opens a human one.
  await expect(
    createVerifiedAgentDataContext({
      ...input(),
      definition: agentDefinition,
      authorize: async () => {},
    }),
  ).rejects.toThrow("Protected Gateway data context");
  await expect(createVerifiedGatewayDataContext(input(signer.issue(agentClaims)))).rejects.toThrow(
    "Protected Gateway data context",
  );
  const handle = await createVerifiedAgentDataContext({
    ...base,
    definition: agentDefinition,
    authorize: async (capability) => {
      delegated.push(capability);
    },
  });
  try {
    expect(handle.agentGrant).toEqual({ id: "grant-1", clientId: "client-1" });
    expect(handle.role).toBe("member");
    const context = handle.contextForTurn("00000000-0000-4000-8000-0000000000a1");
    expect(context.scope).toEqual({ appId: "fixture-app", customerId: "tenant" });
    await context.authorize("work_session.stage");
    await expect(context.authorize("work_session.save")).rejects.toThrow(
      "authorization_denied: the agent context does not allow work_session.save",
    );
    await expect(context.authorize("fixture_record.update")).rejects.toThrow(
      "authorization_denied",
    );
    expect(delegated).toEqual(["work_session.stage"]);
    expect(() => handle.contextForTurn("not-a-turn")).toThrow("lowercase UUID");
  } finally {
    await handle.close();
  }
  await expect(
    createVerifiedAgentDataContext({
      ...base,
      definition: agentDefinition,
      ...input(signer.issue({ ...agentClaims, sub: "other" })),
    }),
  ).rejects.toThrow("Protected Gateway data context");
});

it("the Next page read and Server Action contexts refuse an agent principal", async () => {
  const agentGrant = { id: "grant-1", clientId: "client-1" };
  const { request: _request, ...base } = input();
  const read = (token: string) => {
    actual.headers = new Headers({
      [PRINCIPAL_HEADER]: token,
      [VERIFIED_METHOD_HEADER]: "GET",
      [VERIFIED_TARGET_HEADER]: "/fixture-app",
    });
    return createVerifiedNextReadDataContext(base);
  };
  const human = await read(signer.issue(claims));
  await human.close();
  await expect(read(signer.issue({ ...claims, agentGrant }))).rejects.toThrow(
    "Protected Gateway data context",
  );
  const payload = { title: "x" };
  const bodySha256 = createHash("sha256").update("signed-body").digest("base64url");
  const action = (token: string) => {
    actual.headers = new Headers({
      [PRINCIPAL_HEADER]: token,
      [VERIFIED_METHOD_HEADER]: "POST",
      [VERIFIED_TARGET_HEADER]: "/fixture-app",
      [VERIFIED_BODY_HEADER]: bodySha256,
    });
    return createVerifiedNextActionDataContext({ ...base, normalizedPayload: payload });
  };
  const posted = { ...claims, method: "POST", bodySha256 };
  const humanAction = await action(signer.issue(posted));
  await humanAction.close();
  await expect(action(signer.issue({ ...posted, agentGrant }))).rejects.toThrow(
    "Protected Gateway data context",
  );
});

it("accepts explicit app admission without a role and never substitutes it for a requested role", async () => {
  const token = signer.issue({
    ...claims,
    appActorGrants: undefined,
    appAccess: { fenceGeneration: 7 },
  });
  const handle = await createVerifiedGatewayDataContext({ ...input(token), role: null });
  await handle.close();
  await expect(createVerifiedGatewayDataContext(input(token))).rejects.toThrow(
    "Protected Gateway data context",
  );
  await expect(createVerifiedGatewayDataContext({ ...input(), role: null })).rejects.toThrow(
    "Protected Gateway data context",
  );
  for (const scope of [
    { appId: "other-app", actorId: "actor", organizationId: "tenant" },
    { appId: "fixture-app", actorId: "other-actor", organizationId: "tenant" },
    { appId: "fixture-app", actorId: "actor", organizationId: "other-tenant" },
  ]) {
    await expect(
      createVerifiedGatewayDataContext({ ...input(token), scope, role: null }),
    ).rejects.toThrow("Protected Gateway data context");
  }
});

it("requires roleless action body proof and normalized payload just like role-based access", async () => {
  const body = new TextEncoder().encode("roleless fixture");
  const token = signer.issue({
    ...claims,
    appActorGrants: undefined,
    appAccess: { fenceGeneration: 7 },
    method: "POST",
    bodySha256: createHash("sha256").update(body).digest("base64url"),
  });
  const selected = {
    ...input(token),
    role: null,
    normalizedPayload: { value: "roleless fixture" },
    request: { ...input(token).request, kind: "delegated-api" as const, method: "POST", body },
  };
  const handle = await createVerifiedGatewayDataContext(selected);
  await handle.close();
  await expect(
    createVerifiedGatewayDataContext({ ...selected, normalizedPayload: undefined }),
  ).rejects.toThrow("Protected Gateway data context");
  await expect(
    createVerifiedGatewayDataContext({
      ...selected,
      request: { ...selected.request, body: new Uint8Array() },
    }),
  ).rejects.toThrow("Protected Gateway data context");
});
