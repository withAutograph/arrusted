import { createHash } from "node:crypto";
import { verifyVercelOidcToken } from "@vercel/oidc";
import { z } from "zod";
import { realmOperatorLinkConfigSchema } from "./operator-identity-link";
export const realmCaptureReadbackAttestationSchema = z.strictObject({
  version: z.literal(1),
  purpose: z.literal("realm-captured-link-readback-v1"),
  capturedAt: z.string().datetime({ offset: true }),
  realmSessionId: z.string().min(1).max(256),
  proofSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
export const REALM_NATIVE_CAPTURE_CALLER_HEADER = "x-platform-realm-capture-oidc";
export async function verifyRealmCaptureNativeCaller(input: {
  headers: Headers;
  config: z.infer<typeof realmOperatorLinkConfigSchema>;
  headerName?: "x-vercel-trusted-oidc-idp-token" | "x-platform-realm-capture-oidc";
}): Promise<string> {
  const config = realmOperatorLinkConfigSchema.parse(input.config);
  const token = input.headers.get(input.headerName ?? REALM_NATIVE_CAPTURE_CALLER_HEADER);
  if (
    !config.readonlyAttesters ||
    !token ||
    token.length > 16384 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)
  )
    throw new Error("realm_capture_native_authority_required");
  const hint = z
    .object({
      iss: z.string(),
      aud: z.string(),
      owner_id: z.string(),
      project_id: z.string(),
      environment: z.string(),
    })
    .parse(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")));
  const candidates = Object.values(config.readonlyAttesters).filter((policy) =>
    [
      policy.issuer === hint.iss,
      policy.audience === hint.aud,
      policy.ownerId === hint.owner_id,
      policy.projectId === hint.project_id,
      policy.environment === hint.environment,
    ].every(Boolean),
  );
  if (candidates.length !== 1) throw new Error("realm_capture_native_authority_required");
  await verifyVercelOidcToken(token, candidates[0]!).catch(() => {
    throw new Error("realm_capture_native_authority_required");
  });
  return token;
}
/** No browser can choose a verification time. Only the two configured native workloads can attest their actual consumed journal. */
export async function verifyNativeRealmCaptureAttestation(input: {
  proof: string;
  attestation: unknown;
  headers: Headers;
  config: z.infer<typeof realmOperatorLinkConfigSchema>;
}) {
  await verifyRealmCaptureNativeCaller(input);
  const attestation = realmCaptureReadbackAttestationSchema.parse(input.attestation);
  if (
    attestation.proofSha256 !== createHash("sha256").update(input.proof).digest("hex") ||
    Date.parse(attestation.capturedAt) > Date.now()
  )
    throw new Error("realm_capture_mismatch");
  return attestation;
}
