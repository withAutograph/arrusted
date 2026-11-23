// Test-owned Gateway principals for the canvas host: a signing key, its
// verifier, and the headers the Gateway forwards for one request.
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import {
  createPrincipalSigner,
  createPrincipalVerifier,
  PRINCIPAL_HEADER,
  REQUEST_TARGET_HEADER,
} from "@autograph/platform-microfrontends/identity";
import {
  VERIFIED_BODY_HEADER,
  VERIFIED_METHOD_HEADER,
  VERIFIED_TARGET_HEADER,
} from "@autograph/platform-microfrontends/next-request-ingress";

const keys = generateKeyPairSync("ed25519");
const signer = createPrincipalSigner({
  issuer: "https://gateway.example.test",
  keyId: "canvas-host",
  privateKey: keys.privateKey,
});
export const verifier = createPrincipalVerifier({
  issuer: "https://gateway.example.test",
  keyId: "canvas-host",
  publicKey: keys.publicKey,
});

export type Who = {
  actorId: string;
  customerId: string;
  /** App grants the Gateway signs for protected apps (the MCP route needs one). */
  grants?: { role: string; fenceGeneration: number }[];
  audience?: string;
  /** Present only on a signed Canvas person principal. */
  canvasGrant?: { id: string };
  /** Present only on the Gateway's agent principal (a verified bearer). */
  agentGrant?: { id: string; clientId: string };
};

/** The headers the Gateway forwards for `method target`, signed for `who`. */
export function gatewayHeaders(
  who: Who,
  method: string,
  target: string,
  bodySha256?: string,
): Headers {
  return new Headers({
    [PRINCIPAL_HEADER]: signer.issue({
      aud: who.audience ?? "canvas-host",
      sub: who.actorId,
      organizationId: who.customerId,
      customerId: who.customerId,
      organizationRole: "member",
      ...(who.grants === undefined ? {} : { appActorGrants: who.grants }),
      ...(who.agentGrant === undefined ? {} : { agentGrant: who.agentGrant }),
      ...(who.canvasGrant === undefined ? {} : { canvasGrant: who.canvasGrant }),
      method,
      path: target,
      ...(bodySha256 === undefined ? {} : { bodySha256 }),
      jti: randomUUID(),
    }),
    [REQUEST_TARGET_HEADER]: target,
  });
}

/**
 * A server action's headers after the app's mandatory proxy: the Gateway
 * signed the POST and its body digest, and the proxy verified both.
 */
export function actionHeaders(who: Who, target: string, body: string = randomUUID()): Headers {
  const digest = createHash("sha256").update(body).digest("base64url");
  const headers = gatewayHeaders(who, "POST", target, digest);
  headers.set(VERIFIED_METHOD_HEADER, "POST");
  headers.set(VERIFIED_TARGET_HEADER, target);
  headers.set(VERIFIED_BODY_HEADER, digest);
  return headers;
}

/** A page read's headers after the app's proxy verified its GET. */
export function pageHeaders(who: Who, target: string): Headers {
  const headers = gatewayHeaders(who, "GET", target);
  headers.set(VERIFIED_METHOD_HEADER, "GET");
  headers.set(VERIFIED_TARGET_HEADER, target);
  return headers;
}
