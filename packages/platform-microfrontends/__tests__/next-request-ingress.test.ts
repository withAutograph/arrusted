// @vitest-environment node
import { createHash, generateKeyPairSync } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPrincipalSigner, PRINCIPAL_HEADER } from "../src/policy/identity";
import {
  createProtectedNextProxy,
  protectedNextActionRequest,
  readVerifiedNextAppSession,
  VERIFIED_BODY_HEADER,
  VERIFIED_METHOD_HEADER,
  VERIFIED_TARGET_HEADER,
} from "../src/policy/next-request-ingress";

const actual = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({ headers: () => Promise.resolve(actual.headers) }));

const issuer = "https://gateway.example.test";
const signer = createPrincipalSigner({
  issuer,
  keyId: "fixture",
  privateKey: generateKeyPairSync("ed25519").privateKey,
});
const publicJwk = {
  ...signer.publicKey.export({ format: "jwk" }),
  kid: "fixture",
  alg: "EdDSA",
  use: "sig",
};
const proxy = createProtectedNextProxy({
  audience: "sample",
  publicOrigin: issuer,
  loadJwks: async () => ({ keys: [publicJwk] }),
});
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("base64url");
const principal = (
  body: Uint8Array,
  method = "POST",
  target = "/sample?cursor=a%2Fb",
  jti = "request-1",
) =>
  signer.issue({
    aud: "sample",
    sub: "actor",
    customerId: "organization",
    organizationId: "organization",
    organizationRole: null,
    appActorGrants: [{ role: "requester", fenceGeneration: 1 }],
    jti,
    method,
    path: target,
    ...(method === "GET" ? {} : { bodySha256: digest(body) }),
  });

describe("mandatory protected Next request proxy", () => {
  it("accepts independently signed app admission without inventing a role", async () => {
    const token = signer.issue({
      aud: "sample",
      sub: "actor",
      customerId: "organization",
      organizationId: "organization",
      organizationRole: null,
      appAccess: { fenceGeneration: 4 },
      jti: "access-only",
      method: "GET",
      path: "/sample",
    });
    const response = await proxy(
      new NextRequest("http://app.internal/sample", {
        headers: { [PRINCIPAL_HEADER]: token },
      }),
    );
    expect(response.status).toBe(200);
    actual.headers = new Headers({
      [PRINCIPAL_HEADER]: token,
      [VERIFIED_METHOD_HEADER]: "GET",
      [VERIFIED_TARGET_HEADER]: "/sample",
    });
    await expect(
      readVerifiedNextAppSession({
        audience: "sample",
        publicOrigin: issuer,
        loadJwks: async () => ({ keys: [publicJwk] }),
      }),
    ).resolves.toMatchObject({
      grants: [],
      appAccess: { fenceGeneration: 4 },
      actorId: "actor",
    });
    for (const fenceGeneration of [0, -1, 0.5])
      expect(() =>
        signer.issue({
          aud: "sample",
          sub: "actor",
          customerId: "organization",
          organizationId: "organization",
          organizationRole: null,
          appAccess: { fenceGeneration },
          jti: "invalid",
          method: "GET",
          path: "/sample",
        }),
      ).toThrow();
  });
  it("accepts an organization-managed action without app grants only when its signed body matches", async () => {
    const body = new TextEncoder().encode("amount=20");
    const token = signer.issue({
      aud: "sample",
      sub: "actor",
      customerId: "organization",
      organizationId: "organization",
      organizationRole: "owner",
      jti: "organization-request",
      method: "POST",
      path: "/sample",
      bodySha256: digest(body),
    });
    const organizationProxy = createProtectedNextProxy(
      {
        audience: "sample",
        publicOrigin: issuer,
        loadJwks: async () => ({ keys: [publicJwk] }),
      },
      { requireAppActorGrants: false },
    );
    const request = (bytes: Uint8Array) =>
      new NextRequest("http://app.internal/sample", {
        method: "POST",
        body: new TextDecoder().decode(bytes),
        headers: { [PRINCIPAL_HEADER]: token },
      });
    expect((await organizationProxy(request(body))).status).toBe(200);
    expect((await organizationProxy(request(new TextEncoder().encode("amount=200")))).status).toBe(
      403,
    );
    expect((await proxy(request(body))).status).toBe(403);
  });
  it("checks complete multipart bytes and replaces caller verification headers internally", async () => {
    const body = new TextEncoder().encode(
      "--boundary\r\nContent-Disposition: form-data; name=amount\r\n\r\n20\r\n--boundary--\r\n",
    );
    const response = await proxy(
      new NextRequest("http://app.internal/sample?cursor=a%2Fb", {
        method: "POST",
        body,
        headers: {
          [PRINCIPAL_HEADER]: principal(body),
          [VERIFIED_BODY_HEADER]: "caller",
          [VERIFIED_METHOD_HEADER]: "DELETE",
          [VERIFIED_TARGET_HEADER]: "/other",
        },
      }),
    );
    expect(response.status).toBe(200);
    const forwarded = new Headers();
    for (const name of [VERIFIED_BODY_HEADER, VERIFIED_METHOD_HEADER, VERIFIED_TARGET_HEADER])
      forwarded.set(name, response.headers.get(`x-middleware-request-${name}`)!);
    expect(protectedNextActionRequest(forwarded)).toMatchObject({
      bodySha256: digest(body),
      method: "POST",
      target: "/sample?cursor=a%2Fb",
    });
    expect(response.headers.get(PRINCIPAL_HEADER)).toBeNull();
  });
  it("denies changed or partial bodies even when the caller forges the verification marker", async () => {
    const original = new TextEncoder().encode("amount=20");
    for (const body of [new TextEncoder().encode("amount=200"), original.slice(0, 5)]) {
      const response = await proxy(
        new NextRequest("http://app.internal/sample?cursor=a%2Fb", {
          method: "POST",
          body,
          headers: {
            [PRINCIPAL_HEADER]: principal(original),
            [VERIFIED_BODY_HEADER]: digest(original),
          },
        }),
      );
      expect(response.status).toBe(403);
      expect(response.headers.get("x-middleware-next")).toBeNull();
    }
  });
  it("uses the actual public target when Next removes a native basePath from nextUrl", async () => {
    const body = new TextEncoder().encode("amount=20");
    const request = new NextRequest("http://app.internal/sample?cursor=a%2Fb", {
      method: "POST",
      body,
      headers: { [PRINCIPAL_HEADER]: principal(body) },
      nextConfig: { basePath: "/sample" },
    });
    expect(request.nextUrl.pathname).toBe("/");
    expect((await proxy(request)).status).toBe(200);
  });
  it("denies missing, forged, method-swapped and target-swapped principals", async () => {
    const body = new TextEncoder().encode("amount=20");
    for (const token of [
      undefined,
      "forged",
      principal(body, "GET"),
      principal(body, "POST", "/sample/other"),
    ]) {
      const response = await proxy(
        new NextRequest("http://app.internal/sample?cursor=a%2Fb", {
          method: "POST",
          body,
          headers: token === undefined ? {} : { [PRINCIPAL_HEADER]: token },
        }),
      );
      expect(response.status).toBe(403);
    }
  });
  it("allows a signed read without publishing mutation verification markers", async () => {
    const response = await proxy(
      new NextRequest("http://app.internal/sample?cursor=a%2Fb", {
        headers: {
          [PRINCIPAL_HEADER]: principal(new Uint8Array(), "GET"),
          [VERIFIED_BODY_HEADER]: "caller",
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get(`x-middleware-request-${VERIFIED_BODY_HEADER}`)).toBeNull();
    expect(() => protectedNextActionRequest(new Headers())).toThrow("ingress is unavailable");
  });
  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "reads the verified app session for %s while keeping Server Actions POST-only",
    async (method) => {
      const body = new TextEncoder().encode("amount=20");
      const token = principal(body, method);
      const response = await proxy(
        new NextRequest("http://app.internal/sample?cursor=a%2Fb", {
          method,
          body,
          headers: { [PRINCIPAL_HEADER]: token },
        }),
      );
      expect(response.status).toBe(200);
      actual.headers = new Headers({ [PRINCIPAL_HEADER]: token });
      for (const name of [VERIFIED_METHOD_HEADER, VERIFIED_TARGET_HEADER, VERIFIED_BODY_HEADER])
        actual.headers.set(name, response.headers.get(`x-middleware-request-${name}`)!);
      const verification = {
        audience: "sample",
        publicOrigin: issuer,
        loadJwks: async () => ({ keys: [publicJwk] }),
      };
      expect(await readVerifiedNextAppSession(verification)).toMatchObject({
        actorId: "actor",
        appId: "sample",
      });
      if (method !== "POST") expect(() => protectedNextActionRequest(actual.headers)).toThrow();
      for (const marker of [undefined, digest(new TextEncoder().encode("changed"))]) {
        if (marker === undefined) actual.headers.delete(VERIFIED_BODY_HEADER);
        else actual.headers.set(VERIFIED_BODY_HEADER, marker);
        await expect(readVerifiedNextAppSession(verification)).rejects.toThrow(
          "ingress is unavailable",
        );
      }
    },
  );
  it("derives an immutable app session from actual verified server headers without realm credentials", async () => {
    const token = principal(new Uint8Array(), "GET");
    const response = await proxy(
      new NextRequest("http://app.internal/sample?cursor=a%2Fb", {
        headers: { [PRINCIPAL_HEADER]: token },
      }),
    );
    actual.headers = new Headers({ [PRINCIPAL_HEADER]: token });
    for (const name of [VERIFIED_METHOD_HEADER, VERIFIED_TARGET_HEADER])
      actual.headers.set(name, response.headers.get(`x-middleware-request-${name}`)!);
    const session = await readVerifiedNextAppSession({
      audience: "sample",
      publicOrigin: issuer,
      loadJwks: async () => ({ keys: [publicJwk] }),
    });
    expect(session).toMatchObject({
      actorId: "actor",
      appId: "sample",
      organizationId: "organization",
      grants: [{ role: "requester", fenceGeneration: 1 }],
    });
    expect(Object.isFrozen(session)).toBe(true);
    expect(Object.isFrozen(session.grants[0])).toBe(true);
    actual.headers = new Headers({ [PRINCIPAL_HEADER]: token });
    await expect(
      readVerifiedNextAppSession({
        audience: "sample",
        publicOrigin: issuer,
        loadJwks: async () => ({ keys: [publicJwk] }),
      }),
    ).rejects.toThrow("request ingress is unavailable");
  });
  it("verifies the agent principal on the exact MCP path only; every other path stays human", async () => {
    const mcpProxy = createProtectedNextProxy(
      { audience: "sample", publicOrigin: issuer, loadJwks: async () => ({ keys: [publicJwk] }) },
      { agentPathname: "/sample/api/mcp" },
    );
    const body = new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"method":"ping"}');
    const signed = (target: string, agent: boolean, bytes = body) =>
      signer.issue({
        aud: "sample",
        sub: "actor",
        customerId: "organization",
        organizationId: "organization",
        organizationRole: null,
        appActorGrants: [{ role: "member", fenceGeneration: 1 }],
        ...(agent ? { agentGrant: { id: "grant-1", clientId: "client-1" } } : {}),
        jti: `request-${target}`,
        method: "POST",
        path: target,
        bodySha256: digest(bytes),
      });
    const send = (url: string, token: string, bytes = body) =>
      mcpProxy(
        new NextRequest(url, {
          method: "POST",
          body: new TextDecoder().decode(bytes),
          headers: { [PRINCIPAL_HEADER]: token },
        }),
      );
    // The agent principal on the MCP path, with its signed body.
    const allowed = await send(
      "http://app.internal/sample/api/mcp",
      signed("/sample/api/mcp", true),
    );
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get(`x-middleware-request-${VERIFIED_BODY_HEADER}`)).toBe(digest(body));
    // Its body digest still binds the bytes.
    const changed = new TextEncoder().encode('{"jsonrpc":"2.0","id":2,"method":"ping"}');
    expect(
      (await send("http://app.internal/sample/api/mcp", signed("/sample/api/mcp", true), changed))
        .status,
    ).toBe(403);
    // A human principal on the MCP path is refused.
    expect(
      (await send("http://app.internal/sample/api/mcp", signed("/sample/api/mcp", false))).status,
    ).toBe(403);
    // The agent principal anywhere else is refused, and a human one still passes.
    expect(
      (await send("http://app.internal/sample/api/read", signed("/sample/api/read", true))).status,
    ).toBe(403);
    expect(
      (await send("http://app.internal/sample/api/read", signed("/sample/api/read", false))).status,
    ).toBe(200);
    // Variants of the MCP path are not the MCP path: the human lane.
    for (const [url, target] of [
      ["http://app.internal/sample/api/mcp/", "/sample/api/mcp"],
      ["http://app.internal/sample/api/MCP", "/sample/api/MCP"],
      ["http://app.internal/sample/api/mcp%2F", "/sample/api/mcp%2F"],
      // Signed for its own path, so the refusal is the agent restriction.
      ["http://app.internal/sample//api/mcp", "/sample//api/mcp"],
    ] as const) {
      expect((await send(url, signed(target, true))).status, url).toBe(403);
      expect((await send(url, signed(target, false))).status, url).toBe(200);
    }
  });
  it("verifies the canvas principal on the exact canvas paths only; elsewhere it is refused", async () => {
    const canvasPaths = ["/sample/api/canvas", "/sample/api/canvas/events"];
    const appProxy = createProtectedNextProxy(
      { audience: "sample", publicOrigin: issuer, loadJwks: async () => ({ keys: [publicJwk] }) },
      { agentPathname: "/sample/api/mcp", canvasPathnames: canvasPaths },
    );
    const body = new TextEncoder().encode('{"call":"viewer"}');
    const signed = (target: string, grant: "canvas" | "agent" | "human", method = "POST") =>
      signer.issue({
        aud: "sample",
        sub: "actor",
        customerId: "organization",
        organizationId: "organization",
        organizationRole: null,
        appActorGrants: [{ role: "member", fenceGeneration: 1 }],
        ...(grant === "canvas" ? { canvasGrant: { id: "grant-1" } } : {}),
        ...(grant === "agent" ? { agentGrant: { id: "grant-1", clientId: "client-1" } } : {}),
        jti: `request-${target}-${grant}-${method}`,
        method,
        path: target,
        ...(method === "GET" ? {} : { bodySha256: digest(body) }),
      });
    const send = (url: string, token: string, method = "POST") =>
      appProxy(
        new NextRequest(url, {
          method,
          ...(method === "GET" ? {} : { body: new TextDecoder().decode(body) }),
          headers: { [PRINCIPAL_HEADER]: token },
        }),
      );
    // The canvas principal on the canvas API and its stream.
    expect(
      (await send("http://app.internal/sample/api/canvas", signed("/sample/api/canvas", "canvas")))
        .status,
    ).toBe(200);
    const target = "/sample/api/canvas/events?session_id=s";
    expect(
      (await send(`http://app.internal${target}`, signed(target, "canvas", "GET"), "GET")).status,
    ).toBe(200);
    // Agent or plain human principals there are refused.
    for (const grant of ["agent", "human"] as const)
      expect(
        (await send("http://app.internal/sample/api/canvas", signed("/sample/api/canvas", grant)))
          .status,
        grant,
      ).toBe(403);
    // The canvas principal anywhere else is refused: human routes and the MCP route.
    for (const path of ["/sample/api/read", "/sample/api/mcp", "/sample/api/canvas/", "/sample"])
      expect((await send(`http://app.internal${path}`, signed(path, "canvas"))).status, path).toBe(
        403,
      );
    // A principal with both grants is never signed.
    expect(() =>
      signer.issue({
        aud: "sample",
        sub: "actor",
        customerId: "organization",
        organizationId: "organization",
        organizationRole: null,
        canvasGrant: { id: "g" },
        agentGrant: { id: "g", clientId: "c" },
        jti: "both",
        method: "GET",
        path: "/sample/api/canvas",
      }),
    ).toThrow("two grants");
  });
});

describe("private protected POST ingress diagnostics", () => {
  const requestId = "8d02f88a-4c02-45ef-9c42-5a38ea54052b";
  const sourceSha = "a".repeat(40);
  const body = new TextEncoder().encode("private-body-canary");
  const target = "/sample?private=query-canary";
  const signed = (jti = requestId) => principal(body, "POST", target, jti);
  const request = (token = signed(), bytes = body) =>
    new NextRequest(`http://private-host-canary.invalid${target}`, {
      method: "POST",
      body: bytes,
      headers: {
        [PRINCIPAL_HEADER]: token,
        "x-platform-principal-jti": "unverified-correlation-canary",
        "x-request-id": "d6b8ad00-a733-47cc-989b-cd580a97d4dd",
        "x-forwarded-host": "private-forwarded-host-canary.invalid",
        origin: "https://private-origin-canary.invalid",
        cookie: "private-cookie-canary",
        authorization: "Bearer private-credential-canary",
        "next-action": "private-action-id-canary",
      },
    });
  const baseEvent = {
    event: "protected_next_action_diagnostic",
    appId: "sample",
    environment: "production",
    deploymentId: "dpl_ingressfixture",
    sourceSha,
  };
  const capture = () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const lines = () =>
      log.mock.calls.map(([line]) => {
        if (typeof line !== "string") throw new Error("Expected one serialized private diagnostic");
        return line;
      });
    return { lines, events: () => lines().map((line): unknown => JSON.parse(line)) };
  };

  beforeEach(() => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", baseEvent.deploymentId);
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", sourceSha);
    vi.stubEnv("DATABASE_URL", "postgresql://private-database-credential-canary.invalid");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("records entry and the actual returned public host override without request values", async () => {
    const captured = capture();
    const token = signed();
    const incoming = request(token);
    const response = await proxy(incoming);
    expect(response.status).toBe(200);
    expect(captured.events()).toEqual([
      { ...baseEvent, outcome: "proxy-post-entered" },
      {
        ...baseEvent,
        outcome: "proxy-returned-public-host-override",
        requestId,
        status: 200,
      },
    ]);
    const logged = captured.lines().join("\n");
    for (const canary of [
      token,
      "private-",
      "unverified-correlation-canary",
      "d6b8ad00-a733-47cc-989b-cd580a97d4dd",
      "query-canary",
    ]) {
      expect(logged).not.toContain(canary);
    }
    expect(response.headers.get("x-middleware-request-origin")).toBe(
      incoming.headers.get("origin"),
    );
    expect(response.headers.get(`x-middleware-request-${VERIFIED_BODY_HEADER}`)).toBe(digest(body));
    expect(new Uint8Array(await incoming.arrayBuffer())).toEqual(body);
    expect(response.headers.has("x-platform-ingress-diagnostic")).toBe(false);
  });

  it.each(["not-a-uuid-canary", `${requestId}-invalid`])(
    "omits a non-UUID verified correlation without rejecting the request (%s)",
    async (jti) => {
      const captured = capture();
      expect((await proxy(request(signed(jti)))).status).toBe(200);
      expect(captured.events()).toContainEqual({
        ...baseEvent,
        outcome: "proxy-returned-public-host-override",
        status: 200,
      });
      expect(captured.lines().join("\n")).not.toContain(jti);
    },
  );

  it.each(["membership", "value"] as const)(
    "reports an incomplete actual NextResponse override (%s) without changing its result",
    async (missing) => {
      const captured = capture();
      const next = NextResponse.next.bind(NextResponse);
      let actualResponse: NextResponse | undefined;
      vi.spyOn(NextResponse, "next").mockImplementationOnce((init) => {
        actualResponse = next(init);
        if (missing === "membership") {
          actualResponse.headers.set(
            "x-middleware-override-headers",
            actualResponse.headers
              .get("x-middleware-override-headers")!
              .split(",")
              .filter((name) => name.trim() !== "x-forwarded-host")
              .join(","),
          );
        } else {
          actualResponse.headers.set(
            "x-middleware-request-x-forwarded-host",
            "private-override-canary.invalid",
          );
        }
        return actualResponse;
      });
      const result = await proxy(request());
      expect(result).toBe(actualResponse);
      expect(result.status).toBe(200);
      expect(captured.events()).toContainEqual({
        ...baseEvent,
        outcome: "proxy-returned-override-missing",
        requestId,
        status: 200,
      });
      expect(captured.lines().join("\n")).not.toContain("private-");
    },
  );

  it("records no returned event or unverified correlation on a forged principal", async () => {
    const captured = capture();
    const denial = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await proxy(request("private-forged-token-canary"))).status).toBe(403);
    expect(captured.events()).toEqual([{ ...baseEvent, outcome: "proxy-post-entered" }]);
    expect(denial).toHaveBeenCalledWith(
      "protected-next-ingress-denied",
      expect.objectContaining({ stage: "principal_header" }),
    );
    expect(captured.lines().join("\n")).not.toContain("private-");
  });

  it("does not add POST diagnostics for an ordinary verified read", async () => {
    const captured = capture();
    const response = await proxy(
      new NextRequest("http://app.internal/sample?cursor=a%2Fb", {
        headers: { [PRINCIPAL_HEADER]: principal(new Uint8Array(), "GET") },
      }),
    );
    expect(response.status).toBe(200);
    expect(captured.events()).toEqual([]);
  });

  it("preserves acceptance and the existing denial when logging throws", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {
      throw new Error("private-logger-error-canary");
    });
    const denial = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const accepted = await proxy(request());
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get(`x-middleware-request-${VERIFIED_BODY_HEADER}`)).toBe(digest(body));
    expect((await proxy(request("private-forged-token-canary"))).status).toBe(403);
    expect((await proxy(request(signed(), new TextEncoder().encode("changed")))).status).toBe(403);
    expect(denial).toHaveBeenCalledWith(
      "protected-next-ingress-denied",
      expect.objectContaining({ stage: "body_proof", reason: "body_proof_mismatch" }),
    );
  });
});
