import type { AppId, CustomerId } from "@contracts";

const INFRASTRUCTURE_DASHBOARD_PATH_PREFIX = "/api/auth/dash/";
const AUTH_BOUNDARY_ERROR_CODES = [
  "app_access_required",
  "auth_not_configured",
  "auth_required",
  "tenant_required",
] as const;
const AUTH_BOUNDARY_ERROR_STATUSES = [401, 403, 500] as const;

export type HeadersLike =
  | Headers
  | Iterable<readonly [string, string]>
  | Record<string, string | readonly string[] | undefined>
  | undefined;

export type AuthenticatedTenantScope = {
  appId: AppId;
  customerId: CustomerId;
  actorId: string;
};

export type AuthBoundaryErrorCode = (typeof AUTH_BOUNDARY_ERROR_CODES)[number];
export type AuthBoundaryErrorStatus = (typeof AUTH_BOUNDARY_ERROR_STATUSES)[number];
export type AuthBoundaryErrorDetails = {
  code: AuthBoundaryErrorCode;
  status: AuthBoundaryErrorStatus;
  message: string;
};

/** Pure request classification shared without loading the Better Auth server runtime. */
export function isInfrastructureDashboardBearerMutation(request: {
  headers: Headers;
  method: string;
  pathname: string;
}): boolean {
  if (!new Set(["DELETE", "PATCH", "POST", "PUT"]).has(request.method.toUpperCase())) {
    return false;
  }
  if (!request.pathname.startsWith(INFRASTRUCTURE_DASHBOARD_PATH_PREFIX)) return false;
  return /^Bearer [A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2}$/u.test(
    request.headers.get("authorization") ?? "",
  );
}

function isAuthBoundaryErrorCode(value: unknown): value is AuthBoundaryErrorCode {
  return AUTH_BOUNDARY_ERROR_CODES.some((code) => value === code);
}

function isAuthBoundaryErrorStatus(value: unknown): value is AuthBoundaryErrorStatus {
  return AUTH_BOUNDARY_ERROR_STATUSES.some((status) => value === status);
}

/** Pure helpers shared with server runtimes without loading Better Auth. */
export function authBoundaryErrorFromUnknown(error: unknown): AuthBoundaryErrorDetails | null {
  if (!error || typeof error !== "object") return null;
  if (
    !("code" in error) ||
    !isAuthBoundaryErrorCode(error.code) ||
    !("status" in error) ||
    !isAuthBoundaryErrorStatus(error.status) ||
    !("message" in error) ||
    typeof error.message !== "string"
  ) {
    return null;
  }
  return {
    code: error.code,
    status: error.status,
    message: error.message,
  };
}

export function toHeaders(headersLike: HeadersLike): Headers {
  if (headersLike instanceof Headers) {
    return headersLike;
  }
  const headers = new Headers();
  if (!headersLike) {
    return headers;
  }
  if (Symbol.iterator in headersLike) {
    for (const [key, value] of headersLike) {
      headers.set(key, value);
    }
    return headers;
  }
  for (const [key, value] of Object.entries(headersLike)) {
    if (Array.isArray(value)) {
      for (const headerValue of value) {
        headers.append(key, headerValue);
      }
    } else if (typeof value === "string") {
      headers.set(key, value);
    }
  }
  return headers;
}
