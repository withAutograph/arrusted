import { describe, expect, test } from "vitest";
import { createAmpersandConnectionSetup } from "../ampersand-connection";

function fixture(groupNamespace?: string) {
  let actor = { customerId: "tenant-a", appId: "spend", actorId: "actor-a" };
  const proofs = new Map<string, unknown>();
  const calls: { url: URL; request: RequestInit }[] = [];
  let connection: Record<string, unknown> | undefined;
  let authorizationUrl = "https://provider.example/authorize?state=private-oauth-state";
  let clock = 100000;
  let credentials = true;
  const adapter = createAmpersandConnectionSetup({
    projectId: "project-a",
    provider: "quickbooks",
    ...(groupNamespace === undefined ? {} : { groupNamespace }),
    authorizationOrigins: ["https://provider.example"],
    authorize: async () => actor,
    headers: async () => new Headers(credentials ? { "X-Api-Key": "private-provider-key" } : {}),
    now: () => clock,
    // Fixture signing port only. Production uses the platform's authenticated signing capability.
    proof: {
      seal: async (value) => {
        proofs.set("sealed-proof", value);
        return "sealed-proof";
      },
      open: async (value) => proofs.get(value),
    },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url, request: init ?? {} });
      if (url.pathname.endsWith("/oauth-connect")) return new Response(authorizationUrl);
      return Response.json(connection ? [connection] : []);
    },
  });
  return {
    adapter,
    calls,
    proofs,
    actor: (value: typeof actor) => {
      actor = value;
    },
    authorizationUrl: (value: string) => {
      authorizationUrl = value;
    },
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
    credentials: (enabled: boolean) => {
      credentials = enabled;
    },
    connected: (overrides: Record<string, unknown> = {}) => {
      const query = calls.find(({ request }) => request.method !== "POST")!.url.searchParams;
      connection = {
        id: "external-a",
        projectId: "project-a",
        provider: "quickbooks",
        group: { groupRef: query.get("groupRef") },
        consumer: { consumerRef: "actor-a" },
        status: "working",
        apiKey: "never-return-provider-data",
        ...overrides,
      };
    },
  };
}

describe("server-owned Ampersand OAuth connection setup", () => {
  test("uses a stable app-owned slot namespace independently of the provider name", async () => {
    const value = fixture("spend");
    const request = new Request("https://app.example");
    await value.adapter.prepare(request);
    const group = (value.proofs.get("sealed-proof") as { groupRef: string }).groupRef;
    expect(group).toMatch(/^tenant-a:spend:[0-9a-f-]{36}$/);
    value.connected();
    expect(await value.adapter.complete(request, "sealed-proof")).toMatchObject({
      status: "verified",
      externalGroupRef: group,
    });
  });
  test("returns only an approved authorization URL and sealed context, with all credentials server-side", async () => {
    const { adapter, calls, proofs } = fixture();
    const setup = await adapter.prepare(new Request("https://app.example"));
    expect(setup).toEqual({
      setupId: "sealed-proof",
      authorizationUrl: "https://provider.example/authorize?state=private-oauth-state",
    });
    expect(JSON.stringify(setup)).not.toContain("private-provider-key");
    expect(proofs.get(setup.setupId)).toMatchObject({
      purpose: "integration.connection-setup/v1",
    });
    const create = calls.find(({ request }) => request.method === "POST")!;
    expect(create.url.pathname).toBe("/v1/oauth-connect");
    expect(new Headers(create.request.headers).get("X-Api-Key")).toBe("private-provider-key");
    const body = JSON.parse(String(create.request.body));
    expect(body).toMatchObject({
      provider: "quickbooks",
      projectIdOrName: "project-a",
      consumerRef: "actor-a",
      enableCSRFProtection: false,
    });
    expect(body.groupRef).toMatch(/^tenant-a:connection:/u);
    expect(calls[0]!.url.searchParams.get("groupRef")).toBe(body.groupRef);
    expect(calls[0]!.url.searchParams.get("consumerRef")).toBe("actor-a");
  });
  test("waits for exact independently read connection, without accepting a browser connection identifier", async () => {
    const value = fixture();
    const request = new Request("https://app.example");
    await value.adapter.prepare(request);
    expect(await value.adapter.complete(request, "sealed-proof")).toEqual({ status: "pending" });
    value.connected();
    expect(await value.adapter.complete(request, "sealed-proof")).toEqual({
      status: "verified",
      externalConnectionId: "external-a",
      externalGroupRef: (value.proofs.get("sealed-proof") as { groupRef: string }).groupRef,
    });
    expect(JSON.stringify(await value.adapter.complete(request, "sealed-proof"))).not.toContain(
      "never-return-provider-data",
    );
    value.connected({ provider: "xero" });
    await expect(value.adapter.complete(request, "sealed-proof")).rejects.toThrow("forbidden");
  });
  test("rejects cross-tenant, cross-actor, unapproved URL and HTTP authorization destinations", async () => {
    const value = fixture();
    const request = new Request("https://app.example");
    await value.adapter.prepare(request);
    value.actor({ customerId: "tenant-b", appId: "spend", actorId: "actor-a" });
    await expect(value.adapter.complete(request, "sealed-proof")).rejects.toThrow("forbidden");
    value.actor({ customerId: "tenant-a", appId: "spend", actorId: "actor-b" });
    await expect(value.adapter.complete(request, "sealed-proof")).rejects.toThrow("forbidden");
    value.actor({ customerId: "tenant-a", appId: "another-app", actorId: "actor-a" });
    await expect(value.adapter.complete(request, "sealed-proof")).rejects.toThrow("forbidden");
    value.authorizationUrl("https://unapproved.example/authorize");
    await expect(value.adapter.prepare(request)).rejects.toThrow("invalid_authorization_url");
    value.authorizationUrl("http://provider.example/authorize");
    await expect(value.adapter.prepare(request)).rejects.toThrow("invalid_authorization_url");
  });
  test("rejects an expired setup proof before another provider read", async () => {
    const value = fixture();
    const request = new Request("https://app.example");
    await value.adapter.prepare(request);
    const calls = value.calls.length;
    value.advance(16 * 60 * 1000);
    await expect(value.adapter.complete(request, "sealed-proof")).rejects.toThrow("forbidden");
    expect(value.calls).toHaveLength(calls);
  });
  test("reports missing protected provider credentials without invoking the provider", async () => {
    const value = fixture();
    value.credentials(false);
    const request = new Request("https://app.example");
    expect(await value.adapter.availability(request)).toMatchObject({
      status: "unavailable",
      code: "provider_oauth_setup_unavailable",
    });
    await expect(value.adapter.prepare(request)).rejects.toThrow("setup_unavailable");
    expect(value.calls).toHaveLength(0);
  });
});
