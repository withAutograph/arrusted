// @vitest-environment node

import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPrincipalSigner } from "../src/policy/identity";
import {
  clearZoneJwksCache,
  verifyZoneRequestPrincipal,
  zoneRequestFailureDiagnostic,
} from "../src/policy/zone-ingress";

afterEach(() => {
  clearZoneJwksCache();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("framework-neutral zone ingress", () => {
  it("classifies agent-lane refusals for the denial log", async () => {
    const keys = generateKeyPairSync("ed25519");
    const signer = createPrincipalSigner({
      issuer: "https://apps.example.test",
      keyId: "gateway-1",
      privateKey: keys.privateKey,
    });
    const loadJwks = async () => ({
      keys: [
        {
          ...signer.publicKey.export({ format: "jwk" }),
          alg: "EdDSA",
          kid: "gateway-1",
          use: "sig",
        },
      ],
    });
    const claims = {
      aud: "sample",
      sub: "actor-1",
      organizationId: "organization-1",
      customerId: "customer-1",
      organizationRole: null,
      method: "POST",
      path: "/sample/api/mcp",
      jti: "request-1",
    };
    // The signer refuses a malformed agent grant, so re-sign its payload by hand.
    const resign = (token: string, change: Record<string, unknown>) => {
      const [header, payload] = token.split(".");
      const body = Buffer.from(
        JSON.stringify({
          ...JSON.parse(Buffer.from(payload!, "base64url").toString()),
          ...change,
        }),
      ).toString("base64url");
      const input = `${header}.${body}`;
      return `${input}.${sign(null, Buffer.from(input), keys.privateKey).toString("base64url")}`;
    };
    const reason = async (
      payload: Record<string, unknown>,
      agent: boolean,
      change?: Record<string, unknown>,
    ) => {
      const issued = signer.issue(payload as never);
      try {
        await verifyZoneRequestPrincipal({
          audience: "sample",
          headers: new Headers({
            "x-platform-principal": change ? resign(issued, change) : issued,
          }),
          method: "POST",
          path: "/sample/api/mcp",
          publicOrigin: "https://apps.example.test",
          loadJwks,
          agent,
        });
      } catch (error) {
        return zoneRequestFailureDiagnostic(error)?.reason;
      }
      return "verified";
    };
    const agentGrant = { id: "grant-1", clientId: "client-1" };
    expect(await reason({ ...claims, agentGrant }, true)).toBe("verified");
    expect(await reason(claims, true)).toBe("agent_lane_mismatch");
    expect(await reason({ ...claims, agentGrant }, false)).toBe("agent_lane_mismatch");
    expect(await reason({ ...claims, agentGrant }, true, { agentGrant: { id: "" } })).toBe(
      "grants_invalid",
    );
  });

  it("verifies the gateway signature, audience, method, and normalized path", async () => {
    const keys = generateKeyPairSync("ed25519");
    const signer = createPrincipalSigner({
      issuer: "https://apps.example.test",
      keyId: "gateway-1",
      privateKey: keys.privateKey,
    });
    const token = signer.issue({
      aud: "sample",
      sub: "actor-1",
      organizationId: "organization-1",
      customerId: "customer-1",
      organizationRole: "admin",
      method: "GET",
      path: "/sample/integrations",
      jti: "request-1",
    });
    const headers = new Headers({ "x-platform-principal": token });
    const loadJwks = async () => ({
      keys: [
        {
          ...signer.publicKey.export({ format: "jwk" }),
          alg: "EdDSA",
          kid: "gateway-1",
          use: "sig",
        },
      ],
    });

    await expect(
      verifyZoneRequestPrincipal({
        audience: "sample",
        headers,
        method: "GET",
        path: "/sample/integrations/",
        publicOrigin: "https://apps.example.test",
        loadJwks,
      }),
    ).resolves.toMatchObject({ sub: "actor-1", customerId: "customer-1" });
    await expect(
      verifyZoneRequestPrincipal({
        audience: "other",
        headers,
        method: "GET",
        path: "/sample/integrations",
        publicOrigin: "https://apps.example.test",
        loadJwks,
      }),
    ).rejects.toThrow("audience is invalid");
  });

  it("rejects missing, malformed, and unknown signing identities", async () => {
    const base = {
      audience: "sample",
      method: "GET",
      path: "/sample",
      publicOrigin: "https://apps.example.test",
    };
    await expect(
      verifyZoneRequestPrincipal({
        ...base,
        headers: new Headers(),
        loadJwks: async () => ({ keys: [] }),
      }),
    ).rejects.toThrow("header is required");
    await expect(
      verifyZoneRequestPrincipal({
        ...base,
        headers: new Headers({ "x-platform-principal": "not-a-token" }),
        loadJwks: async () => ({ keys: [] }),
      }),
    ).rejects.toThrow("compact JWS");

    const keys = generateKeyPairSync("ed25519");
    const signer = createPrincipalSigner({
      issuer: base.publicOrigin,
      keyId: "unknown",
      privateKey: keys.privateKey,
    });
    const token = signer.issue({
      aud: base.audience,
      sub: "actor-1",
      organizationId: "organization-1",
      customerId: "customer-1",
      organizationRole: null,
      method: base.method,
      path: base.path,
      jti: "request-unknown",
    });
    await expect(
      verifyZoneRequestPrincipal({
        ...base,
        headers: new Headers({ "x-platform-principal": token }),
        loadJwks: async () => ({ keys: [] }),
      }),
    ).rejects.toThrow("signing key is unavailable");
  });

  it("refreshes JWKS once when the gateway rotates to an unknown key id", async () => {
    const oldKeys = generateKeyPairSync("ed25519");
    const newKeys = generateKeyPairSync("ed25519");
    const oldSigner = createPrincipalSigner({
      issuer: "https://apps.example.test",
      keyId: "gateway-old",
      privateKey: oldKeys.privateKey,
    });
    const newSigner = createPrincipalSigner({
      issuer: "https://apps.example.test",
      keyId: "gateway-new",
      privateKey: newKeys.privateKey,
    });
    const token = newSigner.issue({
      aud: "sample",
      sub: "actor-1",
      organizationId: "organization-1",
      customerId: "customer-1",
      organizationRole: "admin",
      method: "GET",
      path: "/sample",
      jti: "request-rotation",
    });
    let loads = 0;
    const loadJwks = async () => ({
      keys: [
        {
          ...(loads++ === 0
            ? oldSigner.publicKey.export({ format: "jwk" })
            : newSigner.publicKey.export({ format: "jwk" })),
          alg: "EdDSA",
          kid: loads === 1 ? "gateway-old" : "gateway-new",
          use: "sig",
        },
      ],
    });

    await expect(
      verifyZoneRequestPrincipal({
        audience: "sample",
        headers: new Headers({ "x-platform-principal": token }),
        method: "GET",
        path: "/sample",
        publicOrigin: "https://apps.example.test",
        loadJwks,
      }),
    ).resolves.toMatchObject({ jti: "request-rotation" });
    expect(loads).toBe(2);
  });

  it("bounds cached JWKS network requests", async () => {
    const keys = generateKeyPairSync("ed25519");
    const signer = createPrincipalSigner({
      issuer: "https://apps.example.test",
      keyId: "gateway-timeout",
      privateKey: keys.privateKey,
    });
    const token = signer.issue({
      aud: "sample",
      sub: "actor-1",
      organizationId: "organization-1",
      customerId: "customer-1",
      organizationRole: null,
      method: "GET",
      path: "/sample",
      jti: "request-timeout",
    });
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(
        JSON.stringify({
          keys: [
            {
              ...signer.publicKey.export({ format: "jwk" }),
              alg: "EdDSA",
              kid: "gateway-timeout",
              use: "sig",
            },
          ],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", request);
    const loadJwksHeaders = vi.fn(async () => ({
      "x-vercel-trusted-oidc-idp-token": "protected-origin-token",
    }));

    await expect(
      verifyZoneRequestPrincipal({
        audience: "sample",
        headers: new Headers({ "x-platform-principal": token }),
        method: "GET",
        path: "/sample",
        publicOrigin: "https://apps.example.test",
        jwksUrl: "http://gateway:3024/_platform/jwks.json",
        loadJwksHeaders,
      }),
    ).resolves.toMatchObject({ jti: "request-timeout" });
    expect(request).toHaveBeenCalledOnce();
    expect(loadJwksHeaders).toHaveBeenCalledOnce();
    expect(
      new Headers(request.mock.calls[0]?.[1]?.headers).get("x-vercel-trusted-oidc-idp-token"),
    ).toBe("protected-origin-token");
  });

  it("aborts a hanging JWKS request at the configured bound", async () => {
    const keys = generateKeyPairSync("ed25519");
    const signer = createPrincipalSigner({
      issuer: "https://apps.example.test",
      keyId: "gateway-hang",
      privateKey: keys.privateKey,
    });
    const token = signer.issue({
      aud: "sample",
      sub: "actor-1",
      organizationId: "organization-1",
      customerId: "customer-1",
      organizationRole: null,
      method: "GET",
      path: "/sample",
      jti: "request-hang",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string, init?: RequestInit): Promise<Response> =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      ),
    );

    await expect(
      verifyZoneRequestPrincipal({
        audience: "sample",
        headers: new Headers({ "x-platform-principal": token }),
        method: "GET",
        path: "/sample",
        publicOrigin: "https://apps.example.test",
        jwksUrl: "http://gateway:3024/_platform/jwks.json",
        jwksTimeoutMs: 1,
      }),
    ).rejects.toBeDefined();
  });

  it("bounds protected-origin header acquisition before the JWKS request", async () => {
    const keys = generateKeyPairSync("ed25519");
    const signer = createPrincipalSigner({
      issuer: "https://apps.example.test",
      keyId: "gateway-header-hang",
      privateKey: keys.privateKey,
    });
    const token = signer.issue({
      aud: "sample",
      sub: "actor-1",
      organizationId: "organization-1",
      customerId: "customer-1",
      organizationRole: null,
      method: "GET",
      path: "/sample",
      jti: "request-header-hang",
    });
    const request = vi.fn();
    vi.stubGlobal("fetch", request);

    await expect(
      verifyZoneRequestPrincipal({
        audience: "sample",
        headers: new Headers({ "x-platform-principal": token }),
        method: "GET",
        path: "/sample",
        publicOrigin: "https://apps.example.test",
        jwksUrl: "https://gateway-protected.example.test/_platform/jwks.json",
        jwksTimeoutMs: 1,
        loadJwksHeaders: async () => new Promise<HeadersInit>(() => {}),
      }),
    ).rejects.toBeDefined();
    expect(request).not.toHaveBeenCalled();
  });

  it("does not let an expired request failure evict its replacement", async () => {
    const keys = generateKeyPairSync("ed25519");
    const signer = createPrincipalSigner({
      issuer: "https://apps.example.test",
      keyId: "gateway-replacement",
      privateKey: keys.privateKey,
    });
    const token = signer.issue({
      aud: "sample",
      sub: "actor-1",
      organizationId: "organization-1",
      customerId: "customer-1",
      organizationRole: null,
      method: "GET",
      path: "/sample",
      jti: "request-replacement",
    });
    let rejectExpired!: (error: Error) => void;
    const request = vi
      .fn()
      .mockImplementationOnce(
        async () =>
          new Promise<Response>((_resolve, reject) => {
            rejectExpired = reject;
          }),
      )
      .mockResolvedValue(
        Response.json({
          keys: [
            {
              ...signer.publicKey.export({ format: "jwk" }),
              alg: "EdDSA",
              kid: "gateway-replacement",
              use: "sig",
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", request);
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const input = {
      audience: "sample",
      headers: new Headers({ "x-platform-principal": token }),
      method: "GET",
      path: "/sample",
      publicOrigin: "https://apps.example.test",
      jwksUrl: "https://gateway-protected.example.test/_platform/jwks.json",
    };
    const expired = verifyZoneRequestPrincipal(input);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    now.mockReturnValue(60_001);

    await expect(verifyZoneRequestPrincipal(input)).resolves.toMatchObject({
      jti: "request-replacement",
    });
    rejectExpired(new Error("expired JWKS request failed"));
    await expect(expired).rejects.toThrow("expired JWKS request failed");
    await expect(verifyZoneRequestPrincipal(input)).resolves.toMatchObject({
      jti: "request-replacement",
    });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
