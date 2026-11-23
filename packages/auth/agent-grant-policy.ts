/**
 * Pure grant (OAuth) facts shared by the Auth realm, the Gateway and app
 * resource servers without loading the Better Auth runtime.
 *
 * One authorization server (the realm's Better Auth at `<origin>/api/auth`)
 * issues every token, of two kinds. An MCP agent's token (item 3b) is for an
 * app's MCP route, `<origin>/<appId>/api/mcp`, with scope `work_session`. The
 * canvas in a chat (item 5b) acts as the person on its own device sign-in:
 * one static public client, `autograph-canvas`, whose token is for the app's
 * canvas API, `<origin>/<appId>/api/canvas`, with scope `canvas`. Neither
 * client can obtain the other's scope or resource.
 */

/** The single resource scope: every work-session tool. */
export const AGENT_GRANT_SCOPE = "work_session";
/** `offline_access` only asks for a refresh token. */
export const AGENT_GRANT_SCOPES = [AGENT_GRANT_SCOPE, "offline_access"] as const;
/** Access tokens live 15 minutes; every call re-reads the grant anyway. */
export const AGENT_ACCESS_TOKEN_SECONDS = 900;
/** Refresh tokens live 30 days and rotate on every use. */
export const AGENT_REFRESH_TOKEN_SECONDS = 2_592_000;

/** Shell pages of the authorization flow. */
export const AGENT_GRANT_LOGIN_PAGE = "/auth/sign-in";
export const AGENT_GRANT_ORGANIZATION_PAGE = "/auth/oauth/organization";
export const AGENT_GRANT_CONSENT_PAGE = "/auth/oauth/consent";

/** The canvas's resource scope: the person's canvas operations, nothing else. */
export const CANVAS_GRANT_SCOPE = "canvas";
/** The canvas client's only scopes; `offline_access` asks for its refresh token. */
export const CANVAS_GRANT_SCOPES = [CANVAS_GRANT_SCOPE, "offline_access"] as const;
/** The one static public client of the canvas in a chat, per deployment. */
export const CANVAS_CLIENT_ID = "autograph-canvas";
/** The shell page where the person approves a canvas device sign-in. */
export const CANVAS_DEVICE_PAGE = "/auth/device";
/** A device sign-in lives 10 minutes; the frame polls every 5 seconds. */
export const CANVAS_DEVICE_CODE_SECONDS = 600;
export const CANVAS_DEVICE_POLL_SECONDS = 5;

/**
 * Realm endpoints that receive POSTs without a browser session (G1): servers
 * without an `Origin`, and the canvas frame's device sign-in and token poll.
 */
export const AGENT_GRANT_SERVER_ENDPOINTS = [
  "/api/auth/oauth2/token",
  "/api/auth/oauth2/register",
  "/api/auth/oauth2/revoke",
  "/api/auth/device/code",
] as const;

/** Realm endpoints the canvas frame calls cross-origin (CORS, no credentials). */
export const CANVAS_AUTH_ENDPOINTS = ["/api/auth/device/code", "/api/auth/oauth2/token"] as const;

const APP_ID = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/u;

function exactOrigin(publicOrigin: string): string {
  const url = new URL(publicOrigin);
  if (url.origin !== publicOrigin.replace(/\/$/u, "")) throw new Error("public origin is invalid");
  return url.origin;
}

function appIdOf(appId: string): string {
  if (!APP_ID.test(appId)) throw new Error("app id is invalid");
  return appId;
}

/** The authorization server issuer (`iss` and metadata). */
export function agentGrantIssuer(publicOrigin: string): string {
  return `${exactOrigin(publicOrigin)}/api/auth`;
}

/** The MCP route path of an app, mounted at `/<appId>`. */
export function agentResourcePath(appId: string): string {
  return `/${appIdOf(appId)}/api/mcp`;
}

/** The app's protected resource identifier (RFC 8707 `resource`, token `aud`). */
export function agentResourceIdentifier(publicOrigin: string, appId: string): string {
  return `${exactOrigin(publicOrigin)}${agentResourcePath(appId)}`;
}

/** The canvas API path of an app: the person's canvas operations. */
export function canvasResourcePath(appId: string): string {
  return `/${appIdOf(appId)}/api/canvas`;
}

/** The canvas API's session stream path of an app. */
export function canvasEventsPath(appId: string): string {
  return `${canvasResourcePath(appId)}/events`;
}

/** The app's canvas resource identifier (the canvas token's `aud`). */
export function canvasResourceIdentifier(publicOrigin: string, appId: string): string {
  return `${exactOrigin(publicOrigin)}${canvasResourcePath(appId)}`;
}

/** The app id of a canvas resource identifier on this origin, or null. */
export function canvasResourceAppId(publicOrigin: string, resource: string): string | null {
  const prefix = `${exactOrigin(publicOrigin)}/`;
  if (!resource.startsWith(prefix) || !resource.endsWith("/api/canvas")) return null;
  const appId = resource.slice(prefix.length, -"/api/canvas".length);
  return APP_ID.test(appId) ? appId : null;
}

/** The two grant kinds: an MCP agent's, and the canvas acting as the person. */
export type GrantKind = "work_session" | "canvas";

/** What fixes a token of one kind: its scope, its resource and its client. */
export function grantKindFacts(kind: GrantKind, publicOrigin: string, appId: string) {
  return kind === "canvas"
    ? { scope: CANVAS_GRANT_SCOPE, resource: canvasResourceIdentifier(publicOrigin, appId) }
    : { scope: AGENT_GRANT_SCOPE, resource: agentResourceIdentifier(publicOrigin, appId) };
}

/** Protected Resource Metadata (RFC 9728) for the app's MCP route, path-inserted. */
export function agentResourceMetadataUrl(publicOrigin: string, appId: string): string {
  return `${exactOrigin(publicOrigin)}/.well-known/oauth-protected-resource${agentResourcePath(appId)}`;
}

/** The app id of an agent resource identifier on this origin, or null. */
export function agentResourceAppId(publicOrigin: string, resource: string): string | null {
  const prefix = `${exactOrigin(publicOrigin)}/`;
  if (!resource.startsWith(prefix) || !resource.endsWith("/api/mcp")) return null;
  const appId = resource.slice(prefix.length, -"/api/mcp".length);
  return APP_ID.test(appId) ? appId : null;
}

/** The Protected Resource Metadata document for one enrolled app. */
export function agentResourceMetadata(publicOrigin: string, appId: string) {
  return {
    resource: agentResourceIdentifier(publicOrigin, appId),
    authorization_servers: [agentGrantIssuer(publicOrigin)],
    scopes_supported: [AGENT_GRANT_SCOPE],
    bearer_methods_supported: ["header"],
  };
}

/**
 * RFC 6750 / RFC 9728 challenge for an MCP request without a usable token:
 * `invalid_token` only when a token was sent.
 */
export function agentBearerChallenge(input: {
  publicOrigin: string;
  appId: string;
  error?: "invalid_token" | "insufficient_scope";
}): string {
  const parts = [
    `resource_metadata="${agentResourceMetadataUrl(input.publicOrigin, input.appId)}"`,
    `scope="${AGENT_GRANT_SCOPE}"`,
    ...(input.error === undefined ? [] : [`error="${input.error}"`]),
  ];
  return `Bearer ${parts.join(", ")}`;
}

/**
 * The compact bearer token of an `Authorization` header, or undefined. The
 * scheme is case-insensitive and followed by one or more spaces (RFC 7235
 * section 2.1, RFC 6750 section 2.1).
 */
export function bearerTokenFrom(authorization: string | null | undefined): string | undefined {
  const match = /^Bearer +([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/iu.exec(
    authorization?.trim() ?? "",
  );
  return match?.[1];
}

/** Whether a default-app request is one of the exact G1 server endpoints. */
export function isAgentGrantServerEndpoint(request: { method: string; pathname: string }): boolean {
  return (
    request.method.toUpperCase() === "POST" &&
    (AGENT_GRANT_SERVER_ENDPOINTS as readonly string[]).includes(request.pathname)
  );
}

/** The plain-words capability list a consent page shows. */
export const AGENT_GRANT_ALLOWED = [
  "Read records and aggregates in your canvas sessions",
  "Stage and unstage any staged value, yours too (you can restore yours)",
  "Change a session's as-of date and arrange its canvas",
  "Open, reply to and resolve threads, and propose changes",
  "Create working rules and tune any rule's parameters",
] as const;
export const AGENT_GRANT_DENIED = [
  "Save, publish or approve changes",
  "Revert or discard drafts, or change settings",
  "Write canonical records",
] as const;

/** Apps whose own name differs from the derived one. */
const APP_TITLES: ReadonlyMap<string, string> = new Map([["spend-review", "Spend Review"]]);

/**
 * `comp-canvas` → `Comp canvas`, `hc` → `HC`: the app as people name it. The
 * realm holds no app titles, so this matches the canvas's name in the chat and
 * keeps the app catalog's rule that two-letter words are acronyms; an app
 * named otherwise is listed in `APP_TITLES`.
 */
export function appDisplayName(appId: string): string {
  const title = APP_TITLES.get(appId);
  if (title !== undefined) return title;
  const words = appId
    .split(/[-_]/u)
    .map((word) => (word.length === 2 ? word.toUpperCase() : word))
    .join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** What a person without access to an app reads, with what to do next. */
export function appAccessMissing(appId: string): string {
  return `None of your organizations gives you access to ${appDisplayName(appId)}. Ask your Autograph admin to give you access.`;
}

/** What the person approves on the device page: the canvas acts as them. */
export function canvasGrantConsent(appName: string): string {
  return `Let ${appName} in this chat act as you: edit, Save, review and, if you approve drafts, approve and publish.`;
}
