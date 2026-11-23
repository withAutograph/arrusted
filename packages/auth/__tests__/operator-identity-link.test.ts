import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  issueRealmOperatorLinkProof,
  verifyRealmOperatorLinkProof,
} from "../operator-identity-link";

const { privateKey } = generateKeyPairSync("ed25519");
const key = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const now = new Date("2026-10-08T00:00:00Z");
const input = {
  identity: {
    actorId: "normally-signed-in-realm-user",
    sessionId: "normal-session",
    organizationId: null,
    expiresAt: "2026-10-08T00:10:00Z",
    version: 1 as const,
  },
  resource: {
    version: 1 as const,
    environment: "preview" as const,
    hostname: "ep-owned.neon.tech",
    port: 5432,
    database: "auth_owned",
    schema: "public" as const,
    runtimeRole: "auth_runtime",
    migratorRole: "auth_migrator",
    neon: { projectId: "owned-project", branchId: "owned-branch" },
  },
  challenge: {
    nonce: "a".repeat(64),
    ownerSessionId: "public-builder-session",
    bootstrapPlanDigest: "b".repeat(64),
    authResourceId: "auth-resource",
    organizationId: null,
  },
  config: {
    builderCallbackOrigin: "https://builder.example",
    builderCallbackPath: "/api/hosted-operator/realm-identity" as const,
    browserOrigin: "https://public.example",
    operatorOrigin: "https://operator.example",
  },
  issuer: "https://public.example",
  keyId: "existing-gateway-key",
  privateKey: key,
  now,
};
const verify = (
  proof: string,
  changes: Partial<Parameters<typeof verifyRealmOperatorLinkProof>[0]> = {},
) =>
  verifyRealmOperatorLinkProof({
    proof,
    issuer: input.issuer,
    audience: input.config.operatorOrigin,
    keyId: input.keyId,
    privateKey: key,
    now,
    ...changes,
  });

describe("separate scoped Realm browser link proof", () => {
  it("binds identity-only normal session, native resource, nonce and owner without app grants", () => {
    const proof = issueRealmOperatorLinkProof(input);
    expect(JSON.parse(Buffer.from(proof.split(".")[0]!, "base64url").toString("utf8")).typ).toBe(
      "platform-realm-operator-link+jwt",
    );
    const claims = verify(proof);
    expect(claims).toMatchObject({
      sub: input.identity.actorId,
      ownerSessionId: input.challenge.ownerSessionId,
      organizationId: null,
      resource: input.resource,
      purpose: "realm-operator-link-v1",
    });
    expect(claims.nonceSha256).not.toBe(input.challenge.nonce);
    expect(claims).not.toHaveProperty("appActorGrants");
    expect(claims).not.toHaveProperty("role");
    expect(claims).not.toHaveProperty("emailVerified");
    expect(claims.exp - claims.iat).toBe(240);
  });
  it("signs exact operation and frozen program with the cookie digest while keeping cookie bytes private", () => {
    const browserSession = {
      operationRef: "da2f2a9a-21ce-4a33-9107-d88ae5f353d6",
      participantProgramDigest: "c".repeat(64),
    };
    const proof = issueRealmOperatorLinkProof({
      ...input,
      challenge: { ...input.challenge, browserSession },
      normalCookieSha256: "d".repeat(64),
    });
    expect(verify(proof).browserSession).toEqual({
      ...browserSession,
      normalCookieSha256: "d".repeat(64),
    });
    expect(verify(issueRealmOperatorLinkProof(input))).not.toHaveProperty("browserSession");
    expect(() =>
      issueRealmOperatorLinkProof({ ...input, challenge: { ...input.challenge, browserSession } }),
    ).toThrow("realm_browser_session_binding_required");
    expect(() =>
      issueRealmOperatorLinkProof({ ...input, normalCookieSha256: "d".repeat(64) }),
    ).toThrow("realm_browser_session_binding_required");
  });
  it("refuses tampering, wrong audience, issuer, key and expiry", () => {
    const proof = issueRealmOperatorLinkProof(input);
    const pieces = proof.split(".");
    pieces[1] = Buffer.from(JSON.stringify({ ...verify(proof), sub: "other-actor" })).toString(
      "base64url",
    );
    expect(() => verify(pieces.join("."))).toThrow();
    expect(() => verify(proof, { audience: "https://other.example" })).toThrow();
    expect(() => verify(proof, { issuer: "https://other.example" })).toThrow();
    expect(() => verify(proof, { keyId: "other-key" })).toThrow();
    expect(() => verify(proof, { now: new Date("2026-10-08T00:04:00Z") })).toThrow();
    expect(() =>
      issueRealmOperatorLinkProof({
        ...input,
        challenge: { ...input.challenge, organizationId: "foreign-org" },
      }),
    ).toThrow();
  });
});
