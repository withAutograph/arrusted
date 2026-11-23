import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { normalizedPrincipalRequestTarget } from "./identity";
import { verifyZoneRequestPrincipal, zoneRequestFailureDiagnostic } from "./zone-ingress";
import {
  vercelOperationalDeploymentContext,
  vercelOperationalEnvironment,
  vercelRouteCategoryForApplication,
} from "../hosting/vercel/observability";

export const VERIFIED_BODY_HEADER = "x-platform-verified-request-body";
export const VERIFIED_METHOD_HEADER = "x-platform-verified-request-method";
export const VERIFIED_TARGET_HEADER = "x-platform-verified-request-target";
const VERIFIED_HEADERS = [VERIFIED_BODY_HEADER, VERIFIED_METHOD_HEADER, VERIFIED_TARGET_HEADER];
type PublicVerification = Omit<
  Parameters<typeof verifyZoneRequestPrincipal>[0],
  "headers" | "method" | "path"
>;
type FailureStage = "request_target" | "principal" | "grants" | "body_proof" | "forward";
type FailureReason =
  | "unknown"
  | "target_invalid"
  | "grant_missing"
  | "body_proof_missing"
  | "body_proof_mismatch";
const GATEWAY_REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type PostIngressDiagnostic = { audience: string } & (
  | { phase: "entry" }
  | { phase: "return"; response: Response; publicHost: string; requestId: string }
);
type PostIngressDiagnosticRecord = ReturnType<typeof vercelOperationalDeploymentContext> & {
  event: "protected_next_action_diagnostic";
  outcome:
    | "proxy-post-entered"
    | "proxy-returned-public-host-override"
    | "proxy-returned-override-missing";
  appId: string;
  environment: ReturnType<typeof vercelOperationalEnvironment>;
  requestId?: string;
  status?: number;
};

function reportPostIngress(input: PostIngressDiagnostic): void {
  try {
    let outcome: PostIngressDiagnosticRecord["outcome"] = "proxy-post-entered";
    if (input.phase === "return") {
      const overridden = input.response.headers
        .get("x-middleware-override-headers")
        ?.split(",")
        .some((name) => name.trim().toLowerCase() === "x-forwarded-host");
      const publicHostOverride =
        overridden === true &&
        input.response.headers.get("x-middleware-request-x-forwarded-host") === input.publicHost;
      outcome = publicHostOverride
        ? "proxy-returned-public-host-override"
        : "proxy-returned-override-missing";
    }
    const event: PostIngressDiagnosticRecord = {
      event: "protected_next_action_diagnostic",
      outcome,
      appId: vercelRouteCategoryForApplication(input.audience),
      environment: vercelOperationalEnvironment(),
      ...vercelOperationalDeploymentContext(),
    };
    if (input.phase === "return") {
      event.status = input.response.status;
      if (GATEWAY_REQUEST_ID.test(input.requestId)) event.requestId = input.requestId;
    }
    console.info(JSON.stringify(event));
  } catch {
    // Private diagnostics never change verification, forwarding or denial.
  }
}

/**
 * Mandatory proxy for a protected Next host; business authorization stays in each action/DBTx.
 *
 * `agentPathname` is the one exact public pathname (an app's MCP route) whose
 * requests carry the Gateway's agent principal: there, and only there, the
 * proxy verifies an agent principal and refuses a human one. Every other
 * path (trailing slash, other case or encoding included) refuses an agent
 * principal, as before.
 *
 * `canvasPathnames` are the exact public pathnames of the app's canvas API
 * (the canvas in a chat): there, and only there, the proxy verifies a canvas
 * principal and refuses a human or agent one; everywhere else a canvas
 * principal is refused.
 */
export function createProtectedNextProxy(
  verification: PublicVerification,
  options: {
    requireAppActorGrants?: boolean;
    agentPathname?: string;
    canvasPathnames?: readonly string[];
  } = {},
) {
  return async (request: NextRequest) => {
    const headers = new Headers(request.headers);
    for (const name of VERIFIED_HEADERS) headers.delete(name);
    let stage: FailureStage = "request_target";
    try {
      const method = request.method.toUpperCase();
      if (method === "POST") reportPostIngress({ audience: verification.audience, phase: "entry" });
      // nextUrl.pathname removes basePath; Gateway signs the actual public request target.
      const url = new URL(request.url);
      const target = normalizedPrincipalRequestTarget(url.pathname, url.search);
      stage = "principal";
      const principal = await verifyZoneRequestPrincipal({
        ...verification,
        headers,
        method,
        path: target,
        ...(options.agentPathname !== undefined && url.pathname === options.agentPathname
          ? { agent: true }
          : {}),
        ...(options.canvasPathnames?.includes(url.pathname) === true ? { canvas: true } : {}),
      });
      stage = "grants";
      if (
        options.requireAppActorGrants !== false &&
        (principal.appActorGrants === undefined || principal.appActorGrants.length === 0) &&
        principal.appAccess === undefined
      )
        throw new Error("Protected app grant is required");
      headers.set(VERIFIED_METHOD_HEADER, method);
      headers.set(VERIFIED_TARGET_HEADER, target);
      stage = "body_proof";
      if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
        if (!principal.bodySha256) throw new Error("Signed request body is required");
        const bytes = new Uint8Array(await request.clone().arrayBuffer());
        const digest = createHash("sha256").update(bytes).digest("base64url");
        if (digest !== principal.bodySha256)
          throw new Error("Request body does not match Gateway principal");
        headers.set(VERIFIED_BODY_HEADER, digest);
      }
      // Forward internally; never reflect request headers or principal claims into the response.
      stage = "forward";
      // Native service ingress can replace the Gateway's forwarded host. Only
      // after verifying its principal and body restore the exact public issuer
      // for Next's own Server Action origin check; leave Origin unchanged.
      const publicHost = new URL(verification.publicOrigin).host;
      headers.set("x-forwarded-host", publicHost);
      const response = NextResponse.next({ request: { headers } });
      if (method === "POST") {
        reportPostIngress({
          audience: verification.audience,
          phase: "return",
          response,
          publicHost,
          requestId: principal.jti,
        });
      }
      return response;
    } catch (error) {
      reportIngressFailure(error, stage);
      return new NextResponse("Protected request denied", {
        status: 403,
        headers: { "cache-control": "no-store" },
      });
    }
  };
}

function reportIngressFailure(error: unknown, stage: FailureStage): void {
  try {
    const diagnostic = zoneRequestFailureDiagnostic(error);
    console.warn(
      "protected-next-ingress-denied",
      diagnostic ?? { stage, reason: failureReason(error) },
    );
  } catch {
    // Diagnostics must preserve the generic denial even when logging fails.
  }
}

function failureReason(error: unknown): FailureReason {
  if (!(error instanceof Error)) return "unknown";
  switch (error.message) {
    case "principal request pathname is invalid":
    case "principal request search is invalid":
      return "target_invalid";
    case "Protected app grant is required":
      return "grant_missing";
    case "Signed request body is required":
      return "body_proof_missing";
    case "Request body does not match Gateway principal":
      return "body_proof_mismatch";
    default:
      return "unknown";
  }
}

/** Server-only app session facts, derived from Gateway verification without realm SQL or a cookie secret. */
export async function readVerifiedNextAppSession(
  verification: PublicVerification,
  /** The canvas API's consumer: requires the canvas principal; every other refuses it. */
  consumer: { canvas?: boolean } = {},
) {
  const { headers: readHeaders } = await import("next/headers");
  const headers = new Headers(await readHeaders());
  const method = headers.get(VERIFIED_METHOD_HEADER);
  const target = headers.get(VERIFIED_TARGET_HEADER);
  if (!method || !target) throw new Error("Verified Next request ingress is unavailable");
  const principal = await verifyZoneRequestPrincipal({
    ...verification,
    headers,
    method,
    path: target,
    ...(consumer.canvas === true ? { canvas: true } : {}),
  });
  if (
    (principal.appActorGrants === undefined || principal.appActorGrants.length === 0) &&
    principal.appAccess === undefined
  )
    throw new Error("Protected app grant is required");
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    const bodySha256 = headers.get(VERIFIED_BODY_HEADER);
    if (!bodySha256 || principal.bodySha256 !== bodySha256)
      throw new Error("Verified Next action ingress is unavailable");
  }
  return Object.freeze({
    actorId: principal.sub,
    appId: principal.aud,
    grants: Object.freeze(
      (principal.appActorGrants ?? []).map((grant) => Object.freeze({ ...grant })),
    ),
    ...(principal.appAccess ? { appAccess: principal.appAccess } : {}),
    organizationId: principal.organizationId,
    organizationRole: principal.organizationRole,
  });
}

/** Read only after the mandatory proxy has stripped and re-created these headers. */
export function protectedNextActionRequest(headers: Headers) {
  const method = headers.get(VERIFIED_METHOD_HEADER);
  const target = headers.get(VERIFIED_TARGET_HEADER);
  const bodySha256 = headers.get(VERIFIED_BODY_HEADER);
  if (method !== "POST" || !target || !/^[A-Za-z0-9_-]{43}$/u.test(bodySha256 ?? ""))
    throw new Error("Verified Next action ingress is unavailable");
  return { bodySha256: bodySha256!, headers, method, target };
}
