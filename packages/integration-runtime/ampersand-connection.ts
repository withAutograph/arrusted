import { randomUUID } from "node:crypto";
import type { ConnectionSetupAdapter } from "./connection-setup";

export type ConnectionSetupScope = { customerId: string; appId: string; actorId: string };
export type ConnectionSetupProof = ConnectionSetupScope & {
  purpose: "integration.connection-setup/v1";
  provider: string;
  projectId: string;
  groupRef: string;
  expiresAt: number;
};

export class ConnectionSetupError extends Error {
  constructor(
    public readonly code:
      | "setup_unavailable"
      | "forbidden"
      | "provider_failed"
      | "invalid_authorization_url"
      | "ambiguous_connection",
  ) {
    super(code);
  }
}

/** Official POST /oauth-connect flow; no SDK JWT or API key enters the browser.
 * https://docs.ampersand.ai/reference/oauth/generate-oauth-authorization-url
 */
export function createAmpersandConnectionSetup(options: {
  projectId: string;
  provider: string;
  /** Stable application-owned namespace for a fresh connection slot. */
  groupNamespace?: string;
  providerAppId?: string;
  providerWorkspaceRef?: string;
  /** Approved public OAuth setup metadata; credentials remain in the protected provider app. */
  providerMetadata?: Readonly<Record<string, { value: string; source: "input" }>>;
  /** Approved provider-owned OAuth origins, e.g. the exact Intuit authorization origin. */
  authorizationOrigins: readonly string[];
  /** Authenticate and authorize connection creation for this exact app/tenant/actor. */
  authorize(request: Request): Promise<ConnectionSetupScope>;
  /** Protected platform credential lookup; never supplied by browser input or app metadata. */
  headers(request: Request): Promise<HeadersInit>;
  /** Existing platform signing capability. The proof is purpose/identity/expiry bound. */
  proof: {
    seal(value: ConnectionSetupProof): Promise<string>;
    open(value: string): Promise<unknown>;
  };
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}): ConnectionSetupAdapter {
  if (typeof window !== "undefined") throw new Error("Connection setup is server-only");
  const fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  function fail(code: ConnectionSetupError["code"]): never {
    throw new ConnectionSetupError(code);
  }
  let configured = Boolean(
    options.projectId &&
    options.provider &&
    options.authorizationOrigins.length &&
    /^[a-z][a-z0-9-]{0,63}$/.test(options.groupNamespace ?? "connection"),
  );
  const groupNamespace = options.groupNamespace ?? "connection";
  const origins = new Set<string>();
  for (const origin of options.authorizationOrigins) {
    try {
      const url = new URL(origin);
      if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password)
        configured = false;
      else origins.add(url.origin);
    } catch {
      configured = false;
    }
  }
  const api = async (request: Request, route: string, init: RequestInit = {}) => {
    const headers = new Headers(await options.headers(request));
    if (!headers.has("X-Api-Key") && !headers.has("Authorization")) fail("setup_unavailable");
    if (init.body) headers.set("Content-Type", "application/json");
    let result: Response;
    try {
      result = await fetcher(`https://api.withampersand.com/v1${route}`, {
        ...init,
        headers,
        redirect: "error",
        cache: "no-store",
      });
    } catch {
      return fail("provider_failed");
    }
    if (!result.ok) fail("provider_failed");
    return result;
  };
  const readConnections = async (
    request: Request,
    scope: ConnectionSetupProof,
  ): Promise<unknown[]> => {
    const query = new URLSearchParams({
      provider: options.provider,
      groupRef: scope.groupRef,
      consumerRef: scope.actorId,
    });
    const response = await api(
      request,
      `/projects/${encodeURIComponent(options.projectId)}/connections?${query}`,
    );
    const result: unknown = await response.json();
    if (!Array.isArray(result)) fail("provider_failed");
    return result;
  };
  return {
    async availability(request) {
      try {
        await options.authorize(request);
        const headers = new Headers(await options.headers(request));
        if (configured && (headers.has("X-Api-Key") || headers.has("Authorization")))
          return { status: "available" };
      } catch {
        /* Protected configuration failures disclose no provider details. */
      }
      return {
        status: "unavailable",
        code: "provider_oauth_setup_unavailable",
        reason: "Secure provider sign-in is not configured for this app.",
      };
    },
    async prepare(request) {
      if (!configured) fail("setup_unavailable");
      const scope = await options.authorize(request);
      const proof: ConnectionSetupProof = {
        ...scope,
        purpose: "integration.connection-setup/v1",
        provider: options.provider,
        projectId: options.projectId,
        groupRef: `${scope.customerId}:${groupNamespace}:${randomUUID()}`,
        expiresAt: now() + 15 * 60 * 1000,
      };
      // Only this fresh exact slot is queried. No project-wide enumeration or existing-account UI.
      if ((await readConnections(request, proof)).length !== 0) fail("ambiguous_connection");
      const response = await api(request, "/oauth-connect", {
        method: "POST",
        body: JSON.stringify({
          projectIdOrName: options.projectId,
          provider: options.provider,
          groupRef: proof.groupRef,
          consumerRef: scope.actorId,
          ...(options.providerAppId ? { providerAppId: options.providerAppId } : {}),
          ...(options.providerWorkspaceRef
            ? { providerWorkspaceRef: options.providerWorkspaceRef }
            : {}),
          ...(options.providerMetadata ? { providerMetadata: options.providerMetadata } : {}),
          // Official manual-API flow; browser SDK CSRF-cookie transport is not used.
          enableCSRFProtection: false,
        }),
      });
      const authorizationUrl = (await response.text()).trim();
      let url: URL;
      try {
        url = new URL(authorizationUrl);
      } catch {
        return fail("invalid_authorization_url");
      }
      if (url.protocol !== "https:" || url.username || url.password || !origins.has(url.origin))
        fail("invalid_authorization_url");
      return { setupId: await options.proof.seal(proof), authorizationUrl };
    },
    async complete(request, setupId) {
      if (!configured) fail("setup_unavailable");
      const actor = await options.authorize(request);
      if (typeof setupId !== "string" || !setupId) fail("forbidden");
      let raw: unknown;
      try {
        raw = await options.proof.open(setupId);
      } catch {
        return fail("forbidden");
      }
      if (!raw || typeof raw !== "object") fail("forbidden");
      const scope = raw as Partial<ConnectionSetupProof>;
      if (
        scope.purpose !== "integration.connection-setup/v1" ||
        scope.provider !== options.provider ||
        scope.projectId !== options.projectId ||
        scope.customerId !== actor.customerId ||
        scope.appId !== actor.appId ||
        scope.actorId !== actor.actorId ||
        typeof scope.groupRef !== "string" ||
        !scope.groupRef.startsWith(`${actor.customerId}:${groupNamespace}:`) ||
        typeof scope.expiresAt !== "number" ||
        !Number.isSafeInteger(scope.expiresAt) ||
        scope.expiresAt <= now()
      )
        fail("forbidden");
      const rows = await readConnections(request, scope as ConnectionSetupProof);
      if (rows.length === 0) return { status: "pending" };
      if (rows.length !== 1) fail("ambiguous_connection");
      const row = rows[0] as {
        id?: unknown;
        projectId?: unknown;
        provider?: unknown;
        group?: { groupRef?: unknown };
        consumer?: { consumerRef?: unknown };
        status?: unknown;
        providerApp?: { id?: unknown };
      };
      if (
        !row ||
        typeof row.id !== "string" ||
        !row.id ||
        row.projectId !== options.projectId ||
        row.provider !== options.provider ||
        row.group?.groupRef !== scope.groupRef ||
        row.consumer?.consumerRef !== actor.actorId ||
        (options.providerAppId !== undefined && row.providerApp?.id !== options.providerAppId)
      )
        fail("forbidden");
      if (row.status !== "created" && row.status !== "working") return { status: "pending" };
      return { status: "verified", externalConnectionId: row.id, externalGroupRef: scope.groupRef };
    },
  };
}
