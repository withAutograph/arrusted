import { describe, expect, it } from "vitest";
import { verifyNativeRealmCaptureAttestation } from "../operator-identity-attestation";
const policy = {
  issuer: "https://oidc.vercel.com/owned-team",
  audience: "https://vercel.com/owned-team",
  ownerId: "owned-team",
};
const config = {
  browserOrigin: "https://realm.example",
  builderCallbackOrigin: "https://builder.example",
  builderCallbackPath: "/api/hosted-operator/realm-identity" as const,
  operatorOrigin: "https://operator.example",
  readonlyAttesters: {
    builderProduction: {
      ...policy,
      projectId: "owned-builder",
      environment: "production" as const,
    },
    operatorPreview: { ...policy, projectId: "owned-operator", environment: "preview" as const },
  },
};
const attestation = {
  version: 1,
  purpose: "realm-captured-link-readback-v1",
  capturedAt: new Date(Date.now() - 600000).toISOString(),
  realmSessionId: "normal-session",
  proofSha256: "a".repeat(64),
};
describe("native captured Realm readback admission", () => {
  it("never accepts a browser timestamp or an unconfigured native capture authority", async () => {
    await expect(
      verifyNativeRealmCaptureAttestation({
        proof: "signed-proof",
        attestation,
        headers: new Headers(),
        config,
      }),
    ).rejects.toThrow("realm_capture_native_authority_required");
    await expect(
      verifyNativeRealmCaptureAttestation({
        proof: "signed-proof",
        attestation,
        headers: new Headers({ "x-platform-realm-capture-oidc": "untrusted" }),
        config: { ...config, readonlyAttesters: undefined },
      }),
    ).rejects.toThrow("realm_capture_native_authority_required");
  });
  it.each([
    { project_id: "other-project" },
    { owner_id: "other-team" },
    { environment: "preview" },
    { iss: "https://untrusted.example" },
  ])("rejects unmatched native routing scope before any SDK/native request %j", async (change) => {
    const payload = {
      iss: policy.issuer,
      aud: policy.audience,
      owner_id: policy.ownerId,
      project_id: "owned-builder",
      environment: "production",
      ...change,
    };
    const hint = `${Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.untrusted`;
    await expect(
      verifyNativeRealmCaptureAttestation({
        proof: "signed-proof",
        attestation,
        headers: new Headers({ "x-platform-realm-capture-oidc": hint }),
        config,
      }),
    ).rejects.toThrow("realm_capture_native_authority_required");
  });
});
