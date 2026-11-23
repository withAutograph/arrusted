// @vitest-environment node
import "next/dist/server/node-environment-baseline";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { WebNextRequest, WebNextResponse } from "next/dist/server/base-http/web";
import { NextRequestHint } from "next/dist/server/web/adapter";
import { handleAction, parseHostHeader } from "next/dist/server/app-render/action-handler";
import { setManifestsSingleton } from "next/dist/server/app-render/manifests-singleton";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPrincipalSigner, PRINCIPAL_HEADER } from "../src/policy/identity";
import { createProtectedNextProxy } from "../src/policy/next-request-ingress";
import { nextAppConfig } from "../../next-config/index.js";

const publicOrigin = "https://gateway.example.test:8443";
const serviceHost = "sample.deployment-fixture.services.vercel-infra.com";
const requestTarget = "/sample?cursor=a%2Fb";
const actionId = "00".repeat(21);
const body = new TextEncoder().encode(
  `--fixture\r\nContent-Disposition: form-data; name=$ACTION_ID_${actionId}\r\n\r\n\r\n--fixture\r\nContent-Disposition: form-data; name=note\r\n\r\nSynthetic note\r\n--fixture--\r\n`,
);
const signer = createPrincipalSigner({
  issuer: publicOrigin,
  keyId: "action-origin-fixture",
  privateKey: generateKeyPairSync("ed25519").privateKey,
});
const publicJwk = {
  ...signer.publicKey.export({ format: "jwk" }),
  kid: "action-origin-fixture",
  alg: "EdDSA",
  use: "sig",
};
const proxy = createProtectedNextProxy({
  audience: "sample",
  publicOrigin,
  loadJwks: async () => ({ keys: [publicJwk] }),
});

function token(admission: "named" | "roleless" = "named") {
  return signer.issue({
    aud: "sample",
    sub: "actor",
    customerId: "organization",
    organizationId: "organization",
    organizationRole: null,
    ...(admission === "named"
      ? { appActorGrants: [{ role: "requester", fenceGeneration: 1 }] }
      : { appAccess: { fenceGeneration: 1 } }),
    jti: "action-origin-request",
    method: "POST",
    path: requestTarget,
    bodySha256: createHash("sha256").update(body).digest("base64url"),
  });
}

function request(
  options: { origin?: string; principal?: string; bytes?: Uint8Array<ArrayBuffer> } = {},
) {
  return new NextRequest(`https://${serviceHost}${requestTarget}`, {
    method: "POST",
    body: options.bytes ?? body,
    headers: {
      host: serviceHost,
      "x-forwarded-host": serviceHost,
      "content-type": "multipart/form-data; boundary=fixture",
      origin: options.origin ?? publicOrigin,
      [PRINCIPAL_HEADER]: options.principal ?? token(),
    },
  });
}

/** Apply NextResponse.next's request-header overrides as Next's router does. */
function forwardedHeaders(response: Response) {
  const headers = new Headers();
  for (const name of response.headers.get("x-middleware-override-headers")?.split(",") ?? []) {
    const value = response.headers.get(`x-middleware-request-${name}`);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

function nextAction(
  headers: Headers,
  serverActions?: Parameters<typeof handleAction>[0]["serverActions"],
) {
  const decodeAction = vi.fn((_data: FormData) => null);
  // The multipart decoder is a controlled render dependency. The real pinned
  // Next handler owns the origin check and body parsing before reaching it.
  const input = {
    req: new WebNextRequest(
      new NextRequestHint({
        input: `https://${serviceHost}${requestTarget}`,
        page: "/sample/page",
        init: { method: "POST", headers, body },
      }),
    ),
    res: new WebNextResponse(),
    ComponentMod: {
      createTemporaryReferenceSet: () => new Set(),
      decodeAction,
    },
    generateFlight: vi.fn(),
    workStore: {},
    requestStore: {},
    ctx: { renderOpts: { page: "/sample/page" } },
    metadata: {},
    serverActions,
  };
  return {
    decodeAction,
    result: handleAction(input as unknown as Parameters<typeof handleAction>[0]),
  };
}

const configFixtures = new Set<string>();
function trustedServerActions(trustedPublicOrigin?: string) {
  const fixture = mkdtempSync(path.join(tmpdir(), "next-native-action-origin-"));
  configFixtures.add(fixture);
  writeFileSync(
    path.join(fixture, "package.json"),
    JSON.stringify({ name: "native-action-fixture" }),
  );
  vi.spyOn(process, "cwd").mockReturnValue(fixture);
  return nextAppConfig({}, { trustedPublicOrigin }).experimental?.serverActions;
}

beforeEach(() => {
  // Both Next runtime adapters use the same action-origin guard. The Web
  // adapter allows the actual body parser without a built application fixture.
  vi.stubEnv("NEXT_RUNTIME", "edge");
  setManifestsSingleton({
    page: "/sample/page",
    clientReferenceManifest: {
      moduleLoading: { prefix: "" },
      clientModules: {},
      rscModuleMapping: {},
      edgeRscModuleMapping: {},
      ssrModuleMapping: {},
      edgeSSRModuleMapping: {},
      entryCSSFiles: {},
    },
    serverActionsManifest: {
      encryptionKey: "unused-test-key",
      node: {},
      edge: {
        [actionId]: { workers: { "app/sample/page": { moduleId: "fixture", async: false } } },
      },
    },
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const fixture of configFixtures) rmSync(fixture, { recursive: true, force: true });
  configFixtures.clear();
});

describe("protected native Services Server Action origin", () => {
  it("reproduces Next's pre-action rejection of the provider's internal forwarded host", async () => {
    const action = nextAction(request().headers);
    await expect(action.result).rejects.toThrow("Invalid Server Actions request.");
    expect(action.decodeAction).not.toHaveBeenCalled();
  });

  it("accepts the explicit trusted public origin even when the native renderer receives the service host", async () => {
    const headers = request().headers;
    const configured = trustedServerActions(publicOrigin);
    const action = nextAction(headers, configured);
    await expect(action.result).resolves.toBeNull();
    expect(action.decodeAction).toHaveBeenCalledOnce();
    expect(configured?.allowedOrigins).toEqual([new URL(publicOrigin).host]);
    expect(parseHostHeader(Object.fromEntries(headers))?.value).toBe(serviceHost);
  });

  it("keeps the native host mismatch denied when the factory has no trusted origin input", async () => {
    const action = nextAction(request().headers, trustedServerActions());
    await expect(action.result).rejects.toThrow("Invalid Server Actions request.");
    expect(action.decodeAction).not.toHaveBeenCalled();
  });

  it.each([
    "https://foreign.example.test",
    "https://other.gateway.example.test:8443",
    "https://gateway.example.test:8444",
    "null",
  ])("still rejects foreign origin %s with the exact public origin configured", async (origin) => {
    const action = nextAction(request({ origin }).headers, trustedServerActions(publicOrigin));
    await expect(action.result).rejects.toThrow("Invalid Server Actions request.");
    expect(action.decodeAction).not.toHaveBeenCalled();
  });

  it.each(["named", "roleless"] as const)(
    "restores the exact public host after verified %s admission without changing the browser origin or body",
    async (admission) => {
      const incoming = request({ principal: token(admission) });
      const response = await proxy(incoming);
      expect(response.status).toBe(200);
      const headers = forwardedHeaders(response);
      const action = nextAction(headers);
      await expect(action.result).resolves.toBeNull();
      expect(action.decodeAction).toHaveBeenCalledOnce();
      expect(action.decodeAction.mock.calls[0]?.[0]).toBeInstanceOf(FormData);
      expect(parseHostHeader(Object.fromEntries(headers))).toEqual({
        type: "x-forwarded-host",
        value: new URL(publicOrigin).host,
      });
      expect(headers.get("origin")).toBe(publicOrigin);
      expect(new Uint8Array(await incoming.arrayBuffer())).toEqual(body);
    },
  );

  it.each(["https://foreign.example.test", "null"])(
    "preserves Next's rejection of foreign browser origin %s even with a valid signed request",
    async (origin) => {
      const response = await proxy(request({ origin }));
      expect(response.status).toBe(200);
      const headers = forwardedHeaders(response);
      expect(headers.get("origin")).toBe(origin);
      const action = nextAction(headers);
      await expect(action.result).rejects.toThrow("Invalid Server Actions request.");
      expect(action.decodeAction).not.toHaveBeenCalled();
    },
  );

  it("denies a forged principal before forwarding a normalized host", async () => {
    const response = await proxy(request({ principal: "forged" }));
    expect(response.status).toBe(403);
    expect(response.headers.get("x-middleware-override-headers")).toBeNull();
  });

  it("denies changed bytes before forwarding a normalized host", async () => {
    const response = await proxy(request({ bytes: new TextEncoder().encode("changed") }));
    expect(response.status).toBe(403);
    expect(response.headers.get("x-middleware-override-headers")).toBeNull();
  });
});
