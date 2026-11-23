import { createPublicKey } from "node:crypto";

import {
  PRINCIPAL_HEADER,
  REQUEST_TARGET_HEADER,
  createPrincipalVerifier,
  principalTargetFailureDiagnostic,
  type GatewayPrincipal,
  type PrincipalTargetFailureDiagnostic,
} from "./identity";

type JwksSigningKey = JsonWebKey & { kid?: string };
type JwksDocument = { keys: readonly JwksSigningKey[] };
type CachedJwks = { expiresAt: number; request: Promise<JwksDocument> };

const JWKS_CACHE_TTL_MS = 60_000;
const JWKS_REQUEST_TIMEOUT_MS = 5_000;
const jwksRequests = new Map<string, CachedJwks>();
type FailureStage =
  | "principal_header"
  | "jwks_configuration"
  | "jwks_load"
  | "jwks_headers"
  | "jwks_fetch"
  | "jwks_response"
  | "jwks_body"
  | "jwks_document"
  | "signing_key"
  | "origin_configuration"
  | "principal_verification";
type FailureReason =
  | "unknown"
  | "principal_missing"
  | "principal_header_invalid"
  | "configuration_invalid"
  | "jwks_transport_unavailable"
  | "jwks_http_rejected"
  | "jwks_document_invalid"
  | "signing_key_unavailable"
  | "signature_invalid"
  | "issuer_invalid"
  | "audience_invalid"
  | "method_invalid"
  | "target_invalid"
  | "time_invalid"
  | "claims_invalid"
  | "grants_invalid"
  | "agent_lane_mismatch"
  | "canvas_lane_mismatch";
type FailureDiagnostic = Partial<PrincipalTargetFailureDiagnostic> & {
  stage: FailureStage;
  reason: FailureReason;
  jwksStatus?: number;
  jwksContentType?: "json" | "html" | "plain_text" | "missing" | "other";
};
const failureDiagnostics = new WeakMap<object, FailureDiagnostic>();

/** Private server diagnostics only; the original error is never replaced or serialized. */
export function zoneRequestFailureDiagnostic(error: unknown): FailureDiagnostic | undefined {
  return typeof error === "object" && error !== null ? failureDiagnostics.get(error) : undefined;
}

export async function verifyZoneRequestPrincipal(input: {
  audience: string;
  headers: Headers;
  method: string;
  path: string;
  publicOrigin: string;
  jwksUrl?: string;
  jwksTimeoutMs?: number;
  loadJwks?: (url: string) => Promise<unknown>;
  loadJwksHeaders?: (url: string) => Promise<HeadersInit>;
  /** Only an agent consumer sets this; every other consumer refuses agent principals. */
  agent?: boolean;
  /** Only a canvas API consumer sets this; every other consumer refuses canvas principals. */
  canvas?: boolean;
}): Promise<GatewayPrincipal> {
  let stage: FailureStage = "principal_header";
  try {
    const token = input.headers.get(PRINCIPAL_HEADER);
    if (!token) throw new Error("gateway principal header is required");
    const protectedHeader = principalProtectedHeader(token);
    const jwksUrl = input.jwksUrl ?? "http://gateway:3024/_platform/jwks.json";
    stage = "jwks_configuration";
    const jwksTimeoutMs = boundedJwksTimeout(input.jwksTimeoutMs);
    stage = "jwks_load";
    let document = parseJwks(
      await (input.loadJwks
        ? input.loadJwks(jwksUrl)
        : loadCachedJwks(jwksUrl, false, jwksTimeoutMs, input.loadJwksHeaders)),
    );
    let jwk = signingKey(document, protectedHeader.kid);
    if (!jwk) {
      document = parseJwks(
        await (input.loadJwks
          ? input.loadJwks(jwksUrl)
          : loadCachedJwks(jwksUrl, true, jwksTimeoutMs, input.loadJwksHeaders)),
      );
      jwk = signingKey(document, protectedHeader.kid);
    }
    stage = "signing_key";
    if (!jwk) throw new Error("gateway principal signing key is unavailable");
    stage = "origin_configuration";
    const issuer = exactOrigin(input.publicOrigin);
    stage = "signing_key";
    const publicKey = createPublicKey({ format: "jwk", key: jwk });
    stage = "principal_verification";
    return createPrincipalVerifier({
      issuer,
      keyId: protectedHeader.kid,
      publicKey,
    }).verify(token, {
      audience: input.audience,
      method: input.method,
      path: normalizedPath(input.path),
      ...(input.agent === true ? { agent: true } : {}),
      ...(input.canvas === true ? { canvas: true } : {}),
    });
  } catch (error) {
    try {
      rememberFailure(error, stage, undefined, input.headers);
    } catch {
      // Diagnostic input inspection cannot replace the original failure.
    }
    throw error;
  }
}

export function clearZoneJwksCache(): void {
  jwksRequests.clear();
}

async function loadCachedJwks(
  url: string,
  forceRefresh = false,
  timeoutMs = JWKS_REQUEST_TIMEOUT_MS,
  loadHeaders?: (url: string) => Promise<HeadersInit>,
): Promise<JwksDocument> {
  const now = Date.now();
  let cached = jwksRequests.get(url);
  if (forceRefresh || !cached || cached.expiresAt <= now) {
    const signal = AbortSignal.timeout(timeoutMs);
    let replacement: CachedJwks;
    let stage: FailureStage = "jwks_headers";
    let observedResponse: Response | undefined;
    const request = abortable(Promise.resolve(loadHeaders?.(url)), signal)
      .then((headers) => {
        stage = "jwks_fetch";
        return fetch(url, {
          cache: "no-store",
          headers,
          redirect: "error",
          signal,
        });
      })
      .then(async (response) => {
        observedResponse = response;
        stage = "jwks_response";
        if (!response.ok) throw new Error(`gateway JWKS request failed with ${response.status}`);
        stage = "jwks_body";
        const value: unknown = await response.json();
        stage = "jwks_document";
        return parseJwks(value);
      })
      .catch((error) => {
        rememberFailure(error, stage, observedResponse);
        if (jwksRequests.get(url) === replacement) jwksRequests.delete(url);
        throw error;
      });
    replacement = { expiresAt: now + JWKS_CACHE_TTL_MS, request };
    cached = replacement;
    jwksRequests.set(url, cached);
  }
  return cached.request;
}

function rememberFailure(
  error: unknown,
  stage: FailureStage,
  response?: Response,
  headers?: Headers,
): void {
  try {
    if (typeof error !== "object" || error === null || failureDiagnostics.has(error)) return;
    const reason = failureReason(error, response);
    let targetComparison: PrincipalTargetFailureDiagnostic | undefined;
    if (reason === "target_invalid" && headers) {
      try {
        targetComparison = principalTargetFailureDiagnostic(
          error,
          headers.get(REQUEST_TARGET_HEADER),
        );
      } catch {
        // Marker inspection cannot replace the existing failure diagnostic.
      }
    }
    failureDiagnostics.set(error, {
      stage,
      reason,
      ...targetComparison,
      ...(response
        ? { jwksStatus: response.status, jwksContentType: responseContentType(response) }
        : {}),
    });
  } catch {
    // Observability cannot replace the original failure.
  }
}

function responseContentType(response: Response): FailureDiagnostic["jwksContentType"] {
  const value = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!value) return "missing";
  if (value === "application/json" || value === "application/jwk-set+json") return "json";
  if (value === "text/html") return "html";
  if (value === "text/plain") return "plain_text";
  return "other";
}

function failureReason(error: unknown, response?: Response): FailureReason {
  if (!(error instanceof Error)) return "unknown";
  if (response && error.message === `gateway JWKS request failed with ${response.status}`)
    return "jwks_http_rejected";
  switch (error.message) {
    case "gateway principal header is required":
      return "principal_missing";
    case "gateway principal must be a compact JWS":
    case "gateway principal header is invalid":
      return "principal_header_invalid";
    case "gateway JWKS timeout must be between 1 and 30000 milliseconds":
    case "public origin must be an exact origin":
      return "configuration_invalid";
    case "Protected JWKS transport is unavailable":
      return "jwks_transport_unavailable";
    case "gateway JWKS response is invalid":
      return "jwks_document_invalid";
    case "gateway principal signing key is unavailable":
      return "signing_key_unavailable";
    case "gateway principal signature is invalid":
      return "signature_invalid";
    case "gateway principal issuer is invalid":
      return "issuer_invalid";
    case "gateway principal audience is invalid":
      return "audience_invalid";
    case "gateway principal method binding is invalid":
      return "method_invalid";
    case "gateway principal path binding is invalid":
      return "target_invalid";
    case "gateway principal is not active":
    case "gateway principal is expired":
    case "gateway principal lifetime is invalid":
      return "time_invalid";
    case "gateway principal contains invalid JSON":
    case "gateway principal payload is invalid":
    case "gateway principal iss is invalid":
    case "gateway principal aud is invalid":
    case "gateway principal sub is invalid":
    case "gateway principal organizationId is invalid":
    case "gateway principal customerId is invalid":
    case "gateway principal method is invalid":
    case "gateway principal path is invalid":
    case "gateway principal jti is invalid":
    case "gateway principal organizationRole is invalid":
    case "gateway principal timestamps are invalid":
    case "gateway principal body digest is invalid":
      return "claims_invalid";
    case "gateway app grants are invalid":
    case "gateway app grant is invalid":
    case "gateway app grants contain duplicate roles":
    case "gateway agent grant is invalid":
    case "gateway canvas grant is invalid":
    case "gateway principal carries two grants":
      return "grants_invalid";
    case "gateway principal is an agent grant":
    case "gateway principal is not an agent grant":
      return "agent_lane_mismatch";
    case "gateway principal is a canvas grant":
    case "gateway principal is not a canvas grant":
      return "canvas_lane_mismatch";
    default:
      return "unknown";
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function boundedJwksTimeout(value: number | undefined): number {
  const timeout = value ?? JWKS_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) {
    throw new Error("gateway JWKS timeout must be between 1 and 30000 milliseconds");
  }
  return timeout;
}

function signingKey(document: JwksDocument, keyId: string): JwksSigningKey | undefined {
  return document.keys.find((candidate) => candidate.kid === keyId && candidate.kty === "OKP");
}

function principalProtectedHeader(token: string): { kid: string } {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error("gateway principal must be a compact JWS");
  }
  const [encodedHeader] = parts as [string, string, string];
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
  } catch (error) {
    throw new Error("gateway principal header is invalid", { cause: error });
  }
  if (
    !isRecord(value) ||
    value.alg !== "EdDSA" ||
    value.typ !== "JWT" ||
    typeof value.kid !== "string" ||
    value.kid.length === 0
  ) {
    throw new Error("gateway principal header is invalid");
  }
  return { kid: value.kid };
}

function parseJwks(value: unknown): JwksDocument {
  if (!isRecord(value) || !Array.isArray(value.keys)) {
    throw new Error("gateway JWKS response is invalid");
  }
  return { keys: value.keys as JwksSigningKey[] };
}

function exactOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("public origin must be an exact origin");
  }
  return url.origin;
}

function normalizedPath(value: string): string {
  const path = value.startsWith("/") ? value : `/${value}`;
  return path === "/" ? path : path.replace(/\/+$/u, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
