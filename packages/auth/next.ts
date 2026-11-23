import { ensureSessionServer, prefetchSessionServer } from "@better-auth-ui/core/server";
import { getSessionCookie } from "better-auth/cookies";
import { toNextJsHandler } from "better-auth/next-js";
import { withAppSignupIntent } from "./signup-policy";
import { AUTH_APP_INVITATION_ACCEPT_PATH } from "./managed-app-invitations";

import { hostMatches } from "./env";
import { CANVAS_AUTH_ENDPOINTS } from "./agent-grant-policy";
import { withCanvasFrameCors } from "./canvas-frame";
import {
  getAuth,
  acceptManagedAppInvitationForRequest,
  acceptManagedAppSignupForRequest,
  handleManagedAppSignupForRequest,
  realmCanvasFrameOrigins,
  AUTH_APP_SIGNUP_CONTINUE_PATH,
  AUTH_APP_SIGNUP_STATUS_PATH,
  continueAppSignupForRequest,
  INFRASTRUCTURE_DASHBOARD_ORIGIN,
  readAppSignupStatusForRequest,
  requireTenantScope,
  toHeaders,
  type HeadersLike,
  type TenantScopeGuardOptions,
} from "./server";

type AuthUiQueryClient = Parameters<typeof ensureSessionServer>[0];
type AuthRouteAuth = {
  handler(request: Request): Promise<Response>;
  options: {
    baseURL?: string | { allowedHosts?: readonly string[] };
    plugins?: ReadonlyArray<{ id?: string }>;
  };
};
type AuthRouteHandlerOptions = {
  privateServiceName?: string;
  publicOrigin?: string;
  /** The canvas frames' origins; defaults to the realm's (`realmCanvasFrameOrigins`). */
  canvasFrameOrigins?: readonly string[];
};

const INFRASTRUCTURE_DASHBOARD_HOST = new URL(INFRASTRUCTURE_DASHBOARD_ORIGIN).host;
const INFRASTRUCTURE_DASHBOARD_PATH_PREFIX = "/api/auth/dash/";
const PRODUCTION_AUTH_HOST = "apps.autograph.so";
const TRUSTED_PUBLIC_ORIGIN_HEADER = "x-platform-public-origin";

export function createAuthRouteHandlers(
  auth?: AuthRouteAuth,
  options: AuthRouteHandlerOptions = {},
) {
  const resolvedAuth = auth ?? getAuth();
  const infrastructureDashboardEnabled = resolvedAuth.options.plugins?.some(
    (plugin) => plugin.id === "dash",
  );
  const publicOrigin = options.publicOrigin ?? process.env.PLATFORM_PUBLIC_ORIGIN;

  // The canvas frame calls the device and token endpoints cross-origin, by
  // code or token only: CORS for its origins, preflight without a session.
  const handlers = toNextJsHandler((request) =>
    withCanvasFrameCors(
      request,
      {
        origins: options.canvasFrameOrigins ?? realmCanvasFrameOrigins(),
        paths: CANVAS_AUTH_ENDPOINTS,
      },
      handle,
    ),
  );
  // Preflight is the canvas frame's alone: any other auth path answers 403
  // here, without reaching the realm.
  const OPTIONS = async (request: Request) =>
    (CANVAS_AUTH_ENDPOINTS as readonly string[]).includes(new URL(request.url).pathname)
      ? await handlers.POST(request)
      : new Response(null, { status: 403, headers: { "cache-control": "no-store" } });
  return { ...handlers, OPTIONS };

  async function handle(request: Request): Promise<Response> {
    const normalized = ensureAllowedHost(
      normalizeInfrastructureDashboardRequest(
        normalizeRouteOwnedGatewayRequest(request, publicOrigin, options.privateServiceName),
        infrastructureDashboardEnabled === true,
      ),
      typeof resolvedAuth.options.baseURL === "string"
        ? undefined
        : resolvedAuth.options.baseURL?.allowedHosts,
    );
    const targetUrl = new URL(normalized.url);
    if (targetUrl.pathname === "/api/auth/sign-up/email" && normalized.method === "POST") {
      const managedResponse = await handleManagedAppSignupForRequest(normalized);
      if (managedResponse) return managedResponse;
    }
    if (targetUrl.pathname === AUTH_APP_SIGNUP_CONTINUE_PATH && normalized.method === "GET") {
      const result = targetUrl.searchParams.has("error")
        ? { status: "blocked" as const }
        : await acceptManagedAppSignupForRequest(normalized);
      const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
      if (result.status === "ready")
        return new Response(null, {
          status: 303,
          headers: { ...headers, location: result.appUrl },
        });
      if (result.status === "verification_required" || result.status === "sign_in_required") {
        const view = result.status === "verification_required" ? "verify-email" : "sign-in";
        const location = `/auth/${view}?redirectTo=${encodeURIComponent(result.appUrl)}`;
        return new Response(null, { status: 303, headers: { ...headers, location } });
      }
      if (result.status === "pending")
        return new Response(
          '<!doctype html><html><head><meta http-equiv="refresh" content="3"><title>Setting up your access</title></head><body><p>Finishing your access. This page will continue automatically.</p></body></html>',
          { status: 202, headers: { ...headers, "content-type": "text/html; charset=utf-8" } },
        );
      return new Response(
        "<!doctype html><html><head><title>Signup unavailable</title></head><body><h1>Signup is unavailable for this app</h1><p>Open the app’s latest signup link, or contact the person who shared the app.</p></body></html>",
        { status: 403, headers: { ...headers, "content-type": "text/html; charset=utf-8" } },
      );
    }
    if (new URL(normalized.url).pathname === AUTH_APP_INVITATION_ACCEPT_PATH) {
      if (normalized.method !== "GET")
        return new Response(null, { status: 405, headers: { allow: "GET" } });
      if (new URL(normalized.url).searchParams.has("error"))
        return new Response(
          "<!doctype html><html><head><title>Sign-in link unavailable</title></head><body><h1>This sign-in link is no longer available</h1><p>Open the latest invitation email, or ask the person who invited you for a new link.</p></body></html>",
          {
            status: 400,
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
              "referrer-policy": "no-referrer",
            },
          },
        );
      const target = await acceptManagedAppInvitationForRequest(
        normalized.headers,
        new URL(normalized.url).searchParams.get("invitationId") ?? "",
      );
      return target?.status === "ready"
        ? new Response(null, {
            status: 303,
            headers: {
              location: target.url,
              "cache-control": "no-store",
              "referrer-policy": "no-referrer",
            },
          })
        : target?.status === "pending"
          ? new Response(
              '<!doctype html><html><head><meta http-equiv="refresh" content="3"><title>Setting up your access</title></head><body><p>Finishing your access. This page will continue automatically.</p></body></html>',
              {
                status: 202,
                headers: {
                  "content-type": "text/html; charset=utf-8",
                  "cache-control": "no-store",
                  "referrer-policy": "no-referrer",
                },
              },
            )
          : target?.status === "verification_required"
            ? new Response(
                `<!doctype html><html><head><meta http-equiv="refresh" content="5"><title>Verify your email</title></head><body><h1>Check your email</h1><p>Use the secure sign-in link to finish setting up your access. You will continue automatically.</p><a href="/auth/sign-in?redirectTo=${encodeURIComponent(normalized.url)}">Sign in to an existing account</a></body></html>`,
                {
                  status: 200,
                  headers: {
                    "content-type": "text/html; charset=utf-8",
                    "cache-control": "no-store",
                    "referrer-policy": "no-referrer",
                  },
                },
              )
            : Response.json(
                {
                  status: "unavailable",
                  message:
                    "This invitation could not be completed. Open the latest invitation, or ask for a new link.",
                },
                { status: 403, headers: { "cache-control": "no-store" } },
              );
    }
    if (new URL(normalized.url).pathname === AUTH_APP_SIGNUP_STATUS_PATH) {
      if (normalized.method !== "GET")
        return new Response(null, { status: 405, headers: { allow: "GET" } });
      const status = await readAppSignupStatusForRequest(
        normalized.headers,
        new URL(normalized.url).searchParams.get("appUrl") ?? undefined,
      );
      return Response.json(status, { headers: { "cache-control": "private, no-store" } });
    }
    if (new URL(normalized.url).pathname === AUTH_APP_SIGNUP_CONTINUE_PATH) {
      if (normalized.method !== "POST")
        return new Response(null, { status: 405, headers: { allow: "POST" } });
      const body = await signupContinuationBody(normalized);
      if (!body)
        return Response.json(
          { status: "blocked" },
          { status: 400, headers: { "cache-control": "private, no-store" } },
        );
      const result = await continueAppSignupForRequest(
        normalized.headers,
        body,
        normalized.headers.get("origin"),
      );
      return Response.json(result, {
        status: result.status === "blocked" ? 403 : 200,
        headers: { "cache-control": "private, no-store" },
      });
    }
    const intent = await signupRedirectTarget(normalized);
    return withAppSignupIntent(intent, () => resolvedAuth.handler(normalized));
  }
}

async function signupContinuationBody(request: Request): Promise<string | undefined> {
  try {
    const text = await request.clone().text();
    if (new TextEncoder().encode(text).byteLength > 8192) return undefined;
    const value: unknown = JSON.parse(text);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !("appUrl" in value) ||
      typeof value.appUrl !== "string"
    )
      return undefined;
    const url = new URL(value.appUrl);
    if (
      !url.origin ||
      url.username ||
      url.password ||
      url.hash ||
      url.origin !== new URL(request.url).origin
    )
      return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export async function signupRedirectTarget(request: Request): Promise<string | undefined> {
  const url = new URL(request.url);
  if (
    request.method !== "POST" ||
    !["/api/auth/sign-up/email", "/api/auth/sign-in/email"].includes(url.pathname)
  )
    return undefined;
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return undefined;
  }
  if (
    !body ||
    typeof body !== "object" ||
    !("callbackURL" in body) ||
    typeof body.callbackURL !== "string"
  )
    return undefined;
  try {
    const target = new URL(body.callbackURL, url.origin);
    return target.origin === url.origin && !target.username && !target.password && !target.hash
      ? target.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function ensureAllowedHost(request: Request, allowedHosts: readonly string[] | undefined): Request {
  if (!allowedHosts || allowedHosts.length === 0) return request;
  const host = (
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    new URL(request.url).host
  )
    .trim()
    .toLowerCase();
  if (allowedHosts.some((allowedHost) => hostMatches(allowedHost.toLowerCase(), host)))
    return request;
  throw new Error(`Host ${host} is not in the allowed hosts list`);
}

export function normalizeRouteOwnedGatewayRequest(
  request: Request,
  configuredPublicOrigin: string | undefined,
  privateServiceName: string | undefined,
): Request {
  const publicOrigin = exactPublicOrigin(configuredPublicOrigin);
  if (!publicOrigin) return request;
  // Vercel exposes the private child URL as Request.url. Only the Gateway's
  // exact sanitized forwarding pair may restore the browser-visible origin.
  const forwardedHost = request.headers.get("x-forwarded-host")?.trim().toLowerCase();
  const forwardedProtocol = request.headers.get("x-forwarded-proto")?.trim().toLowerCase();
  const requestUrl = new URL(request.url);
  const exactProductionServiceRequest =
    publicOrigin.host === PRODUCTION_AUTH_HOST &&
    exactPrivateServiceHost(requestUrl, privateServiceName);
  if (
    !exactProductionServiceRequest &&
    (forwardedHost !== publicOrigin.host.toLowerCase() ||
      forwardedProtocol !== publicOrigin.protocol.slice(0, -1))
  ) {
    return request;
  }

  if (requestUrl.origin === publicOrigin.origin) return request;
  const normalizedUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, publicOrigin);
  const headers = new Headers(request.headers);
  headers.set("host", publicOrigin.host);
  headers.set("x-forwarded-host", publicOrigin.host);
  headers.set("x-forwarded-proto", publicOrigin.protocol.slice(0, -1));
  return rebuildRequestWithHeaders(request, headers, normalizedUrl);
}

export function normalizeRouteOwnedGatewayHeaders(
  source: Headers,
  configuredPublicOrigin: string | undefined,
  privateServiceName: string | undefined,
): Headers {
  const publicOrigin = exactPublicOrigin(configuredPublicOrigin);
  if (!publicOrigin || source.get(TRUSTED_PUBLIC_ORIGIN_HEADER) !== publicOrigin.origin) {
    return source;
  }

  const host = source.get("host")?.trim().toLowerCase();
  if (
    !host ||
    !exactPrivateServiceHostname(host, privateServiceName) ||
    source.get("x-forwarded-proto")?.trim().toLowerCase() !== publicOrigin.protocol.slice(0, -1)
  ) {
    return source;
  }

  const headers = new Headers(source);
  headers.set("host", publicOrigin.host);
  headers.set("x-forwarded-host", publicOrigin.host);
  headers.set("x-forwarded-proto", publicOrigin.protocol.slice(0, -1));
  return headers;
}

function exactPrivateServiceHost(requestUrl: URL, serviceName: string | undefined): boolean {
  if (
    !serviceName ||
    !/^[a-z][a-z0-9-]*$/u.test(serviceName) ||
    requestUrl.protocol !== "https:" ||
    requestUrl.port
  ) {
    return false;
  }
  return exactPrivateServiceHostname(requestUrl.hostname, serviceName);
}

function exactPrivateServiceHostname(hostname: string, serviceName: string | undefined): boolean {
  return Boolean(
    serviceName &&
    /^[a-z][a-z0-9-]*$/u.test(serviceName) &&
    new RegExp(`^${serviceName}\\.[a-z0-9]+\\.services\\.vercel-infra\\.com$`, "u").test(hostname),
  );
}

function exactPublicOrigin(value: string | undefined): URL | undefined {
  if (!value?.trim()) return undefined;
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("PLATFORM_PUBLIC_ORIGIN must be an exact HTTP or HTTPS origin");
  }
  return parsed;
}

function normalizeInfrastructureDashboardRequest(request: Request, enabled: boolean): Request {
  const requestUrl = new URL(request.url);
  if (
    !enabled ||
    requestUrl.host !== PRODUCTION_AUTH_HOST ||
    !requestUrl.pathname.startsWith(INFRASTRUCTURE_DASHBOARD_PATH_PREFIX)
  ) {
    return request;
  }

  const headers = new Headers(request.headers);
  let changed = false;
  for (const header of ["host", "x-forwarded-host"] as const) {
    if (headers.get(header)?.trim().toLowerCase() === INFRASTRUCTURE_DASHBOARD_HOST) {
      headers.set(header, PRODUCTION_AUTH_HOST);
      changed = true;
    }
  }

  return changed ? rebuildRequestWithHeaders(request, headers) : request;
}

type RequestInitWithDuplex = RequestInit & { duplex?: "half" };

function rebuildRequestWithHeaders(
  request: Request,
  headers: Headers,
  url: string | URL = request.url,
): Request {
  const init: RequestInitWithDuplex = {
    headers,
    method: request.method,
  };
  if (request.body !== null && request.method !== "GET" && request.method !== "HEAD") {
    // Node requires duplex when forwarding an existing request body stream.
    init.body = request.body;
    init.duplex = "half";
  }

  // Vercel can provide a Next request from a different bundled Request class.
  // Reconstruct from primitives so the receiving constructor never reads a
  // private field from the foreign request instance.
  return new Request(url, init);
}

export function hasSessionCookie(request: Request | Headers): boolean {
  return Boolean(getSessionCookie(request));
}

export async function requireNextTenantScope(
  headersLike: HeadersLike,
  options: TenantScopeGuardOptions,
) {
  return requireTenantScope(headersLike, options);
}

export function ensureNextAuthUiSession(queryClient: AuthUiQueryClient, headersLike: HeadersLike) {
  return ensureSessionServer(queryClient, getAuth(), {
    headers: toHeaders(headersLike),
  });
}

export function prefetchNextAuthUiSession(
  queryClient: AuthUiQueryClient,
  headersLike: HeadersLike,
) {
  return prefetchSessionServer(queryClient, getAuth(), {
    headers: toHeaders(headersLike),
  });
}
