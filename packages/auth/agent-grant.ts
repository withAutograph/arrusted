/**
 * The realm's OAuth authorization server for MCP agents (item 3b) and for the
 * canvas in a chat (item 5b), and the one verifier every resource server uses.
 *
 * The shell's Better Auth issues every agent token through the maintained
 * `jwt`, `@better-auth/oauth-provider` and `@better-auth/cimd` plugins. A
 * grant is one consent row per user, client, app and organization: the
 * consent `referenceId` is the app and the organization the user picked for
 * this authorization request (`agentGrantReference`), so each app's grant is
 * independent. Every access token names its exact consent row (`grant`), and
 * the verifier accepts only that live row. The pick is bound to the one
 * authorization request (session + client + redirect + PKCE challenge +
 * resource), never to the browser session's active organization.
 *
 * The canvas in a chat signs in with the device authorization grant (RFC
 * 8628) as the one static public client `autograph-canvas`. The device page
 * picks the organization on the device code itself (keyed by its user code),
 * and approving it upserts the consent row (`canvasGrantReference`) before
 * the provider approves the code. The provider's device exchange carries no
 * consent reference, so the token endpoint binds it: the exchange reads the
 * approved code's consent row before the provider consumes the code, the
 * claims name that row, and the issued refresh row takes its reference, so
 * every refresh is bound as a 3b refresh is. Each client gets only its own
 * scope and resources.
 */
import { createHash, randomUUID } from "node:crypto";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import {
  DEVICE_CODE_GRANT_TYPE,
  getOAuthProviderApi,
  getOAuthProviderState,
  oauthDeviceAuthorization,
  oauthProvider,
  type OAuthProviderExtension,
} from "@better-auth/oauth-provider";
import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
  sessionMiddleware,
} from "better-auth/api";
import { verifyJwsAccessToken } from "better-auth/oauth2";
import { jwt } from "better-auth/plugins";
import { z } from "zod";

import {
  AGENT_ACCESS_TOKEN_SECONDS,
  AGENT_GRANT_CONSENT_PAGE,
  AGENT_GRANT_LOGIN_PAGE,
  AGENT_GRANT_ORGANIZATION_PAGE,
  AGENT_GRANT_SCOPES,
  AGENT_REFRESH_TOKEN_SECONDS,
  CANVAS_CLIENT_ID,
  CANVAS_DEVICE_CODE_SECONDS,
  CANVAS_DEVICE_PAGE,
  CANVAS_DEVICE_POLL_SECONDS,
  CANVAS_GRANT_SCOPE,
  CANVAS_GRANT_SCOPES,
  agentGrantIssuer,
  agentResourceAppId,
  agentResourceIdentifier,
  canvasResourceAppId,
  canvasResourceIdentifier,
  grantKindFacts,
  type GrantKind,
} from "./agent-grant-policy";

/** The SQL surface the agent grant reads (the Auth runtime pool). */
export type AgentGrantDatabase = {
  query(
    queryText: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
};

export type AgentGrantConfig = {
  /** The realm's exact public origin (`BETTER_AUTH_URL`). */
  publicOrigin: string;
  /** Trusted composition policy: the app ids that get an MCP resource. */
  appIds: readonly string[];
  database: AgentGrantDatabase;
  /** A single-deployment realm uses organization membership, without app assignments. */
  singleOrganizationId?: string;
  /** Test seam: the CIMD fetch transport (default: resolve-once pinned HTTPS). */
  fetchClientMetadata?: Parameters<typeof cimd>[0]["fetchClientMetadataResource"];
};

const PICK_PREFIX = "agent-grant-organization";
const PICK_SECONDS = 600;

/** An organization the user may grant to an agent for one app. */
export type AgentGrantOrganization = { id: string; name: string };

/** Organizations that grant `appId` and where the user holds an active app assignment. */
export async function eligibleAgentOrganizations(
  database: AgentGrantDatabase,
  input: { userId: string; appId: string; singleOrganizationId?: string },
): Promise<AgentGrantOrganization[]> {
  if (input.singleOrganizationId !== undefined) {
    const result = await database.query(
      `select o."id", o."name" from "organization" o
       where o."id" = $2 and exists (select 1 from "member" m
         where m."organizationId" = o."id" and m."userId" = $1)`,
      [input.userId, input.singleOrganizationId],
    );
    return result.rows.flatMap((row) =>
      typeof row.id === "string" && typeof row.name === "string"
        ? [{ id: row.id, name: row.name }]
        : [],
    );
  }
  const result = await database.query(
    `select o."id", o."name" from "organization" o
       join "member" m on m."organizationId" = o."id" and m."userId" = $1
      where o."appIds" @> jsonb_build_array($2::text)
        and exists (select 1 from "app_actor_assignment" a
          where a."organizationId" = o."id" and a."actorId" = $1 and a."appId" = $2 and a."active" = true)
      order by o."name", o."id"`,
    [input.userId, input.appId],
  );
  return result.rows.flatMap((row) =>
    typeof row.id === "string" && typeof row.name === "string"
      ? [{ id: row.id, name: row.name }]
      : [],
  );
}

function eligibleOrganizations(config: AgentGrantConfig, input: { userId: string; appId: string }) {
  return eligibleAgentOrganizations(config.database, {
    ...input,
    singleOrganizationId: config.singleOrganizationId,
  });
}

/**
 * The identity of one authorization request: every parameter the code is
 * bound to. A pick made for one request never applies to another.
 */
export function agentAuthorizationRequestKey(query: string): string {
  const params = new URLSearchParams(query);
  return createHash("sha256")
    .update(
      JSON.stringify([
        params.get("client_id"),
        params.get("redirect_uri"),
        params.get("code_challenge"),
        params.get("state"),
        [...params.getAll("resource")].sort(),
      ]),
    )
    .digest("base64url");
}

const pickIdentifier = (sessionId: string, query: string) =>
  `${PICK_PREFIX}:${sessionId}:${agentAuthorizationRequestKey(query)}`;

/**
 * The consent `referenceId` of one grant: the app and the organization,
 * encoded unambiguously. One consent row per user, client and reference, so
 * granting a second app never touches the first.
 */
export function agentGrantReference(appId: string, organizationId: string): string {
  return JSON.stringify([appId, organizationId]);
}

/**
 * The consent `referenceId` of a canvas grant: the person's canvas for the
 * app and organization. Its shape never parses as an agent reference.
 */
export function canvasGrantReference(appId: string, organizationId: string): string {
  return JSON.stringify([CANVAS_GRANT_SCOPE, appId, organizationId]);
}

/** The app and organization of a canvas consent `referenceId`, or null. */
export function parseCanvasGrantReference(
  referenceId: string | null | undefined,
): { appId: string; organizationId: string } | null {
  if (typeof referenceId !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(referenceId);
    if (
      Array.isArray(parsed) &&
      parsed.length === 3 &&
      parsed[0] === CANVAS_GRANT_SCOPE &&
      typeof parsed[1] === "string" &&
      typeof parsed[2] === "string" &&
      parsed[1].length > 0 &&
      parsed[2].length > 0 &&
      canvasGrantReference(parsed[1], parsed[2]) === referenceId
    )
      return { appId: parsed[1], organizationId: parsed[2] };
  } catch {
    // Not a canvas reference.
  }
  return null;
}

/** The consent `referenceId` of a grant of one kind. */
export function grantReference(kind: GrantKind, appId: string, organizationId: string): string {
  return kind === "canvas"
    ? canvasGrantReference(appId, organizationId)
    : agentGrantReference(appId, organizationId);
}

/** The app and organization of a consent `referenceId`, or null. */
export function parseAgentGrantReference(
  referenceId: string | null | undefined,
): { appId: string; organizationId: string } | null {
  if (typeof referenceId !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(referenceId);
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string" &&
      parsed[0].length > 0 &&
      parsed[1].length > 0 &&
      agentGrantReference(parsed[0], parsed[1]) === referenceId
    )
      return { appId: parsed[0], organizationId: parsed[1] };
  } catch {
    // Not a grant reference.
  }
  return null;
}

/** RFC 7591 client metadata a self-registering client may set; everything else is the server's. */
const REGISTRATION_METADATA = [
  "redirect_uris",
  "token_endpoint_auth_method",
  "grant_types",
  "response_types",
  "client_name",
  "client_uri",
  "logo_uri",
  "scope",
  "contacts",
  "tos_uri",
  "policy_uri",
  "software_id",
  "software_version",
  "application_type",
] as const;

const isLoopbackHttp = (url: URL) =>
  url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

const invalidClientMetadata = (description: string) =>
  new APIError("BAD_REQUEST", { error: "invalid_client_metadata", error_description: description });

/**
 * The registration body the provider sees: only the RFC 7591 metadata a
 * public MCP client needs, and no secret. The provider itself refuses
 * `skip_consent` at registration and requires PKCE for every public client;
 * `require_pkce` and everything else a client may not set (resources,
 * subject type, key material, logout channels) is dropped here. HTTP
 * redirects must be loopback; a client with only loopback HTTP redirects and
 * no `application_type` is native (RFC 8252).
 */
export function publicClientRegistration(body: Record<string, unknown>): Record<string, unknown> {
  if ((body.token_endpoint_auth_method ?? "none") !== "none")
    throw invalidClientMetadata(
      "only public clients (token_endpoint_auth_method none) may register",
    );
  const redirects = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  const parsed = redirects.map((uri) => {
    try {
      return new URL(String(uri));
    } catch {
      return null;
    }
  });
  if (parsed.some((url) => url !== null && url.protocol === "http:" && !isLoopbackHttp(url)))
    throw invalidClientMetadata("HTTP redirect URIs must be loopback");
  // The canvas scope belongs to the static canvas client alone.
  // A scope is a string or an array of strings; anything else is refused
  // before any metadata is copied. The canvas scope is found however it is
  // separated (whitespace or commas).
  const scope = body.scope;
  if (
    scope !== undefined &&
    typeof scope !== "string" &&
    !(Array.isArray(scope) && scope.every((item) => typeof item === "string"))
  )
    throw invalidClientMetadata("scope must be a string or an array of strings");
  const scopes = (scope === undefined ? [] : Array.isArray(scope) ? scope : [scope]).flatMap(
    (item: string) => item.split(/[\s,]+/u),
  );
  if (scopes.includes(CANVAS_GRANT_SCOPE))
    throw invalidClientMetadata(`the ${CANVAS_GRANT_SCOPE} scope is not available to this client`);
  const native =
    body.application_type === undefined &&
    parsed.length > 0 &&
    parsed.every((url) => url !== null && isLoopbackHttp(url));
  const metadata: Record<string, unknown> = {};
  for (const key of REGISTRATION_METADATA) if (key in body) metadata[key] = body[key];
  // The provider refuses this itself; keep its refusal visible to the client.
  if ("skip_consent" in body) metadata.skip_consent = body.skip_consent;
  return {
    ...metadata,
    token_endpoint_auth_method: "none",
    ...(native ? { application_type: "native" } : {}),
  };
}

/** The app the authorization request's (single) resource names, or null. */
function requestedApp(config: AgentGrantConfig, query: string): string | null {
  const resources = new URLSearchParams(query).getAll("resource");
  if (resources.length !== 1) return null;
  const appId = agentResourceAppId(config.publicOrigin, resources[0]!);
  return appId !== null && config.appIds.includes(appId) ? appId : null;
}

type PluginContext = {
  internalAdapter: {
    findVerificationValue(identifier: string): Promise<{ value: string; expiresAt: Date } | null>;
    createVerificationValue(data: {
      identifier: string;
      value: string;
      expiresAt: Date;
    }): Promise<unknown>;
  };
};

/** The request-context key the revocation hooks share. */
const REVOKED_GRANT = "agentGrantRevoked";
/** The request-context key for the consent row a presented code or refresh token was issued under. */
const CREDENTIAL_GRANT = "agentGrantCredentialConsent";
/** The request-context key for the canvas reference an approved device code was bound to. */
const DEVICE_REFERENCE = "canvasGrantDeviceReference";

type RevokedGrant = { userId: string; clientId: string; referenceId: string };

const isRevokedGrant = (value: unknown): value is RevokedGrant =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as RevokedGrant).userId === "string" &&
  typeof (value as RevokedGrant).clientId === "string" &&
  typeof (value as RevokedGrant).referenceId === "string";

/**
 * Delete one grant's refresh tokens, pending authorization codes and (for the
 * canvas) device codes.
 * Deleted, not marked revoked: replaying a revoked refresh token counts as
 * reuse, and the provider then invalidates every refresh token of this client
 * and user, other apps' grants included.
 */
async function sweepGrant(database: AgentGrantDatabase, grant: RevokedGrant) {
  await database.query(
    `delete from "oauthRefreshToken"
      where "userId" = $1 and "clientId" = $2 and "referenceId" = $3`,
    [grant.userId, grant.clientId, grant.referenceId],
  );
  await database.query(
    `delete from "verification" v
      where v."value" like '{"type":"authorization_code"%'
        and (case when v."value" like '{"type":"authorization_code"%'
              then v."value"::jsonb end)
            @> jsonb_build_object('userId', $1::text, 'referenceId', $3::text,
                 'query', jsonb_build_object('client_id', $2::text))`,
    [grant.userId, grant.clientId, grant.referenceId],
  );
  await database.query(
    `delete from "deviceCode"
      where "userId" = $1 and "oauthClientId" = $2 and "referenceId" = $3`,
    [grant.userId, grant.clientId, grant.referenceId],
  );
}

/**
 * The consent row an approved device code belongs to, read in one statement
 * with the code before the provider consumes it: the live row for the code's
 * person, client and canvas reference (set by the organization pick, and
 * upserted by the approval). Revocation deletes a grant's device codes, so a
 * code present here was approved under this row. Null when the code is not
 * approved or its consent is gone.
 */
async function deviceConsent(
  database: AgentGrantDatabase,
  deviceCode: string,
): Promise<{ id: string; referenceId: string } | null> {
  const result = await database.query(
    `select c."id", c."referenceId" from "deviceCode" d
       join "oauthConsent" c
         on c."userId" = d."userId" and c."clientId" = d."oauthClientId"
        and c."referenceId" = d."referenceId"
      where d."deviceCode" = $1 and d."status" = 'approved'`,
    [deviceCode],
  );
  const row = result.rows[0];
  return result.rows.length === 1 &&
    typeof row?.id === "string" &&
    typeof row.referenceId === "string"
    ? { id: row.id, referenceId: row.referenceId }
    : null;
}

/**
 * The consent row an authorization code belongs to, read in one statement
 * with the code itself before the provider consumes it: the live row for the
 * code's user, client and app + organization reference. Revocation deletes a
 * grant's codes, so a code present here was issued under this row. Empty when
 * the code or its consent is gone.
 */
async function codeConsent(database: AgentGrantDatabase, codeIdentifier: string) {
  const result = await database.query(
    `select c."id" from "verification" v
       join "oauthConsent" c
         on c."userId" = (v."value"::jsonb ->> 'userId')
        and c."clientId" = (v."value"::jsonb -> 'query' ->> 'client_id')
        and c."referenceId" = (v."value"::jsonb ->> 'referenceId')
      where v."identifier" = $1 and v."value" like '{"type":"authorization_code"%'`,
    [codeIdentifier],
  );
  const id = result.rows[0]?.id;
  return result.rows.length === 1 && typeof id === "string" ? id : "";
}

/**
 * The consent row a refresh token belongs to, read in one statement with the
 * refresh row before the provider loads it: the live row for its user, client
 * and app + organization reference. Revocation deletes a grant's refresh
 * tokens, so a token present here was issued under this row. Empty when the
 * token or its consent is gone.
 */
async function refreshConsent(database: AgentGrantDatabase, tokenIdentifier: string) {
  const result = await database.query(
    `select c."id" from "oauthRefreshToken" t
       join "oauthConsent" c
         on c."userId" = t."userId" and c."clientId" = t."clientId"
        and c."referenceId" = t."referenceId"
      where t."token" = $1`,
    [tokenIdentifier],
  );
  const id = result.rows[0]?.id;
  return result.rows.length === 1 && typeof id === "string" ? id : "";
}

/** The claims of a JWT access token, or an empty object for an opaque one. */
function accessTokenClaims(token: unknown): Record<string, unknown> {
  try {
    const payload = String(token).split(".")[1] ?? "";
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString());
    return claims !== null && typeof claims === "object" ? (claims as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Withdraw a token response: its new refresh row is deleted and nothing is released. */
async function withdrawIssuedTokens(
  ctx: Parameters<typeof getOAuthProviderApi>[0],
  config: AgentGrantConfig,
  options: ReturnType<typeof providerOptions>,
  response: Record<string, unknown>,
  error: APIError,
): Promise<never> {
  if (typeof response.refresh_token === "string")
    await config.database.query(`delete from "oauthRefreshToken" where "token" = $1`, [
      await getOAuthProviderApi(ctx, options as never).hashToken(
        response.refresh_token,
        "refresh_token",
      ),
    ]);
  throw error;
}

/**
 * Each client gets only its own scope: the canvas client only `canvas` (and
 * its refresh), always as a bound JWT; every other client never `canvas`.
 * The claims gate refuses the same on issuance; this holds it for the token
 * response as released, opaque tokens included.
 */
function scopeAllowed(clientId: unknown, response: Record<string, unknown>): boolean {
  const scopes = typeof response.scope === "string" ? response.scope.split(" ") : [];
  if (clientId !== CANVAS_CLIENT_ID) return !scopes.includes(CANVAS_GRANT_SCOPE);
  return (
    scopes.includes(CANVAS_GRANT_SCOPE) &&
    scopes.every((scope) => (CANVAS_GRANT_SCOPES as readonly string[]).includes(scope)) &&
    typeof accessTokenClaims(response.access_token).grant === "string"
  );
}

/**
 * Release a token response only if the consent row its access token names
 * (`grant`) still exists now, after the provider wrote the refresh row, and,
 * for a code, refresh or device exchange, is the row the presented credential
 * was issued under (`credentialGrant`).
 * Otherwise the new refresh row is deleted and the response refused. Each
 * statement commits on its own, so with the revocation's post-delete sweep
 * one side always sees the other (see the delete-consent after hook).
 */
async function releaseIssuedTokens(
  ctx: Parameters<typeof getOAuthProviderApi>[0],
  config: AgentGrantConfig,
  options: ReturnType<typeof providerOptions>,
  response: Record<string, unknown>,
  credentialGrant: string | null,
) {
  const grantId = accessTokenClaims(response.access_token).grant;
  // Not an agent or canvas token (no enrolled resource): nothing to bind.
  if (typeof grantId !== "string") return;
  const live = await config.database.query(`select 1 from "oauthConsent" where "id" = $1`, [
    grantId,
  ]);
  // A credential never inherits a grant made after it: revoking and granting
  // the same app and organization again while the exchange is in flight
  // leaves the claims naming the new row, not the credential's.
  if (live.rows.length === 1 && (credentialGrant === null || credentialGrant === grantId)) return;
  await withdrawIssuedTokens(
    ctx,
    config,
    options,
    response,
    new APIError("BAD_REQUEST", {
      error: "invalid_grant",
      error_description: "The grant was revoked.",
    }),
  );
}

/** The app of a canvas device request: exactly one enrolled canvas resource, or null. */
function requestedCanvasApp(config: AgentGrantConfig, resources: unknown): string | null {
  const list =
    typeof resources === "string" ? [resources] : Array.isArray(resources) ? resources : [];
  if (list.length !== 1 || typeof list[0] !== "string") return null;
  const appId = canvasResourceAppId(config.publicOrigin, list[0]);
  return appId !== null && config.appIds.includes(appId) ? appId : null;
}

/**
 * Seed the static canvas client: public, device and refresh grants only, the
 * canvas scopes only, no redirect. Configuration is the source of truth, so
 * every field is rewritten. Once per process; a failure is retried.
 */
function canvasClientSeeder(database: AgentGrantDatabase) {
  let seeded: Promise<void> | undefined;
  return () =>
    (seeded ??= database
      .query(
        `insert into "oauthClient" ("id", "clientId", "name", "scopes", "redirectUris",
           "tokenEndpointAuthMethod", "grantTypes", "responseTypes", "applicationType",
           "skipConsent", "disabled", "requirePKCE", "createdAt", "updatedAt")
         values ($1, $1, 'Autograph canvas', $2::jsonb, '[]'::jsonb, 'none', $3::jsonb,
           '[]'::jsonb, 'native', false, false, false, now(), now())
         on conflict ("clientId") do update set
           "name" = excluded."name", "scopes" = excluded."scopes",
           "redirectUris" = excluded."redirectUris",
           "tokenEndpointAuthMethod" = excluded."tokenEndpointAuthMethod",
           "grantTypes" = excluded."grantTypes", "responseTypes" = excluded."responseTypes",
           "applicationType" = excluded."applicationType", "skipConsent" = false,
           "disabled" = false, "clientSecret" = null, "clientDiscoveryId" = null,
           "userId" = null, "referenceId" = null, "updatedAt" = now()`,
        [
          CANVAS_CLIENT_ID,
          JSON.stringify(CANVAS_GRANT_SCOPES),
          JSON.stringify([DEVICE_CODE_GRANT_TYPE, "refresh_token"]),
        ],
      )
      .then(
        () => undefined,
        (error: unknown) => {
          seeded = undefined;
          throw error;
        },
      ));
}

/** A canvas device code, as its device page may act on it. */
type CanvasDeviceRequest = {
  id: string;
  appId: string;
  userId: string;
  referenceId: string | null;
};

const deviceRefusal = (description: string, status: "BAD_REQUEST" | "FORBIDDEN" = "BAD_REQUEST") =>
  new APIError(status, {
    error: status === "FORBIDDEN" ? "access_denied" : "invalid_request",
    error_description: description,
  });

/**
 * The pending canvas device code a user code names, claimed by this person:
 * an unclaimed code is claimed now (as the provider's `/device` does), one
 * claimed by someone else is refused. Codes are the provider's default
 * alphabet, so the user code is compared normalized.
 */
async function canvasDeviceRequest(
  config: AgentGrantConfig,
  userCode: string,
  userId: string,
): Promise<CanvasDeviceRequest> {
  const code = userCode.replace(/[^a-zA-Z0-9]/gu, "").toUpperCase();
  const read = async () =>
    (
      await config.database.query(
        `select "id", "userId", "status", "expiresAt", "oauthClientId", "resources",
                "referenceId" from "deviceCode" where "userCode" = $1`,
        [code],
      )
    ).rows[0];
  let row = await read();
  if (row === undefined || typeof row.id !== "string")
    throw deviceRefusal("This sign-in code is not valid.");
  if (!(row.expiresAt instanceof Date) || row.expiresAt <= new Date())
    throw deviceRefusal("This sign-in code has expired. Start again from the chat.");
  if (row.oauthClientId !== CANVAS_CLIENT_ID)
    throw deviceRefusal("This sign-in code is not for a canvas.");
  if (row.status !== "pending") throw deviceRefusal("This sign-in code was already used.");
  if (row.userId === null) {
    await config.database.query(
      `update "deviceCode" set "userId" = $2
        where "id" = $1 and "userId" is null and "status" = 'pending'`,
      [row.id, userId],
    );
    row = await read();
  }
  if (row?.userId !== userId)
    throw deviceRefusal("This sign-in code belongs to someone else.", "FORBIDDEN");
  const appId = requestedCanvasApp(config, stringList(row.resources));
  if (appId === null) throw deviceRefusal("This sign-in code names no canvas.");
  return {
    id: String(row.id),
    appId,
    userId,
    referenceId: typeof row.referenceId === "string" ? row.referenceId : null,
  };
}

/**
 * The organization pick and grant hygiene around the maintained provider:
 * the pick endpoint and page context, public-client-only registration, and
 * grant revocation (refresh tokens and pending codes, swept before and after
 * the consent row is deleted), and the token endpoint's release gate. For the
 * canvas: the static client, the device page's context and organization pick
 * (on the device code), the consent row its approval upserts, and the device
 * exchange's binding to that row.
 */
function agentGrantOrganizationPlugin(
  config: AgentGrantConfig,
  context: { current?: PluginContext },
  options: ReturnType<typeof providerOptions>,
): BetterAuthPlugin {
  const seedCanvasClient = canvasClientSeeder(config.database);
  const readOAuthQuery = async (): Promise<string> => {
    const state = await getOAuthProviderState();
    if (!state?.query) throw new APIError("BAD_REQUEST", { error: "invalid_request" });
    return state.query;
  };
  return {
    id: "agent-grant-organization",
    schema: {
      // One grant per user, client and app + organization reference: two
      // concurrent Allows cannot leave two rows (the verifier would refuse
      // both). Every agent consent has a user and a reference
      // (`consentReferenceId` throws without one), so both are required here,
      // which Better Auth needs for a unique index.
      oauthConsent: {
        fields: {
          userId: {
            type: "string",
            required: true,
            references: { model: "user", field: "id" },
            index: true,
          },
          referenceId: { type: "string", required: true },
        },
        indexes: [{ fields: ["clientId", "userId", "referenceId"], unique: true }],
      },
      // The canvas grant a device code is approved under: the app and the
      // organization the person picked on the device page.
      deviceCode: { fields: { referenceId: { type: "string", required: false } } },
    },
    init(ctx) {
      context.current = ctx as unknown as PluginContext;
    },
    rateLimit: [
      // Registration is unauthenticated: bound it per client address.
      { pathMatcher: (path) => path === "/oauth2/register", window: 60, max: 10 },
    ],
    hooks: {
      before: [
        {
          // A device sign-in is the canvas's only: the static client, one
          // enrolled canvas resource, the canvas scopes.
          matcher: (ctx) => ctx.path === "/device/code",
          handler: createAuthMiddleware(async (ctx) => {
            const body = (ctx.body ?? {}) as Record<string, unknown>;
            if (body.client_id !== CANVAS_CLIENT_ID)
              throw new APIError("BAD_REQUEST", {
                error: "unauthorized_client",
                error_description: "Only the canvas signs in with a device code.",
              });
            await seedCanvasClient();
            if (requestedCanvasApp(config, body.resource) === null)
              throw new APIError("BAD_REQUEST", {
                error: "invalid_target",
                error_description: "A device sign-in names exactly one canvas.",
              });
            const scopes = typeof body.scope === "string" ? body.scope.split(/\s+/u) : [];
            if (
              !scopes.includes(CANVAS_GRANT_SCOPE) ||
              scopes.some((scope) => !(CANVAS_GRANT_SCOPES as readonly string[]).includes(scope))
            )
              throw new APIError("BAD_REQUEST", {
                error: "invalid_scope",
                error_description: `A canvas signs in with the ${CANVAS_GRANT_SCOPE} scope only.`,
              });
          }),
        },
        {
          // Approving a canvas device code records the grant and approves the
          // code in one statement: the consent row for the person, the canvas
          // client and the app + organization they picked (still eligible
          // now), written only while the code is still pending under exactly
          // the reference validated here. A pick that lands in between
          // refuses this approval; a pick after it is refused. The hook
          // answers for the provider's approve, which would approve the code
          // whatever its reference.
          matcher: (ctx) => ctx.path === "/device/approve",
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx);
            const userCode = (ctx.body as { userCode?: unknown } | undefined)?.userCode;
            if (!session || typeof userCode !== "string") return;
            const request = await canvasDeviceRequest(config, userCode, session.user.id);
            const reference = parseCanvasGrantReference(request.referenceId);
            const organizations =
              reference === null || reference.appId !== request.appId
                ? []
                : await eligibleOrganizations(config, {
                    userId: session.user.id,
                    appId: request.appId,
                  });
            if (
              reference === null ||
              !organizations.some((organization) => organization.id === reference.organizationId)
            )
              throw deviceRefusal("Choose an organization for this canvas first.");
            const approved = await config.database.query(
              `with approved as (
                 update "deviceCode" set "status" = 'approved'
                  where "id" = $7 and "userId" = $3 and "status" = 'pending'
                    and "referenceId" = $4 and "expiresAt" > now()
                  returning 1)
               insert into "oauthConsent" ("id", "clientId", "userId", "referenceId", "scopes",
                 "resources", "createdAt", "updatedAt")
               select $1, $2, $3, $4, $5::jsonb, $6::jsonb, now(), now() from approved
               on conflict ("clientId", "userId", "referenceId") do update set
                 "scopes" = excluded."scopes", "resources" = excluded."resources",
                 "updatedAt" = now()
               returning "id"`,
              [
                randomUUID(),
                CANVAS_CLIENT_ID,
                session.user.id,
                request.referenceId,
                JSON.stringify(CANVAS_GRANT_SCOPES),
                JSON.stringify([canvasResourceIdentifier(config.publicOrigin, request.appId)]),
                request.id,
              ],
            );
            if (approved.rows.length !== 1)
              throw deviceRefusal(
                "The organization for this sign-in changed while approving. Check it and approve again.",
              );
            return ctx.json({ success: true });
          }),
        },
        {
          // Public clients only, from RFC 7591 metadata only. Hook context merges into the
          // request body, so the body is replaced in place: a key the client
          // sent outside the allowlist never reaches the provider. Pinned by
          // "registration takes RFC 7591 metadata only" in
          // __tests__/agent-grant.test.ts: a provider upgrade that stops
          // honouring the in-place body fails it.
          matcher: (ctx) => ctx.path === "/oauth2/register",
          handler: createAuthMiddleware(async (ctx) => {
            const body = (ctx.body ?? {}) as Record<string, unknown>;
            const registration = publicClientRegistration(body);
            for (const key of Object.keys(body)) delete body[key];
            Object.assign(body, registration);
            return { context: { body } };
          }),
        },
        {
          // A grant is only for a public client: a Client ID Metadata Document
          // may declare `private_key_jwt`; such a client never gets consent.
          matcher: (ctx) => ctx.path === "/oauth2/consent",
          handler: createAuthMiddleware(async (ctx) => {
            const query = (ctx.body as { oauth_query?: unknown } | undefined)?.oauth_query;
            if (typeof query !== "string") return;
            const clientId = new URLSearchParams(query).get("client_id");
            if (!clientId) return;
            const client = (await ctx.context.adapter.findOne({
              model: "oauthClient",
              where: [{ field: "clientId", value: clientId }],
            })) as { tokenEndpointAuthMethod?: unknown } | null;
            if (client !== null && (client.tokenEndpointAuthMethod ?? "none") !== "none")
              throw new APIError("BAD_REQUEST", {
                error: "unauthorized_client",
                error_description: "Only public clients may receive an agent grant.",
              });
          }),
        },
        {
          // Revoking a grant revokes that grant only: its refresh tokens and
          // any authorization code not yet exchanged (same user, client and
          // app + organization reference). The per-call grant read already
          // refuses its unexpired access tokens, which name the deleted row.
          // The sweep runs before the provider deletes the consent and again
          // after it (the after hook below): see `releaseIssuedTokens`.
          matcher: (ctx) => ctx.path === "/oauth2/delete-consent",
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx);
            const id = (ctx.body as { id?: unknown } | undefined)?.id;
            if (!session || typeof id !== "string") return;
            const consent = await config.database.query(
              `select "userId", "clientId", "referenceId" from "oauthConsent"
                where "id" = $1 and "userId" = $2`,
              [id, session.user.id],
            );
            const row = consent.rows[0];
            if (
              row === undefined ||
              typeof row.userId !== "string" ||
              typeof row.clientId !== "string" ||
              typeof row.referenceId !== "string"
            )
              return;
            const grant: RevokedGrant = {
              userId: row.userId,
              clientId: row.clientId,
              referenceId: row.referenceId,
            };
            await sweepGrant(config.database, grant);
            return { context: { [REVOKED_GRANT]: grant } };
          }),
        },
        {
          // Bind a code or refresh exchange to the consent row the presented
          // credential was issued under, read before the provider consumes or
          // loads it; the token after hook refuses a token naming any other
          // row. (No refresh-token prefix or format is configured, so the
          // presented refresh token is the stored token's preimage.)
          matcher: (ctx) => ctx.path === "/oauth2/token",
          handler: createAuthMiddleware(async (ctx) => {
            const body = (ctx.body ?? {}) as {
              grant_type?: unknown;
              code?: unknown;
              refresh_token?: unknown;
              device_code?: unknown;
              client_id?: unknown;
            };
            if (body.client_id === CANVAS_CLIENT_ID) await seedCanvasClient();
            const api = getOAuthProviderApi(ctx, options as never);
            let id: string;
            if (
              body.grant_type === DEVICE_CODE_GRANT_TYPE &&
              typeof body.device_code === "string"
            ) {
              // The device exchange carries no consent reference of its own:
              // the claims and the issued refresh row take this one.
              const bound = await deviceConsent(config.database, body.device_code);
              return {
                context: {
                  [CREDENTIAL_GRANT]: { id: bound?.id ?? "" },
                  [DEVICE_REFERENCE]: bound?.referenceId ?? null,
                },
              };
            }
            if (body.grant_type === "authorization_code" && typeof body.code === "string")
              id = await codeConsent(
                config.database,
                await api.hashToken(body.code, "authorization_code"),
              );
            else if (body.grant_type === "refresh_token" && typeof body.refresh_token === "string")
              id = await refreshConsent(
                config.database,
                await api.hashToken(body.refresh_token, "refresh_token"),
              );
            else return;
            return { context: { [CREDENTIAL_GRANT]: { id } } };
          }),
        },
      ],
      after: [
        {
          // The second sweep, after the consent row is gone. With
          // `releaseIssuedTokens` this closes the race with a concurrent
          // issuance: either that issuance's refresh row was committed before
          // this sweep (deleted here), or its consent check runs after the
          // delete committed (refused there).
          matcher: (ctx) => ctx.path === "/oauth2/delete-consent",
          handler: createAuthMiddleware(async (ctx) => {
            const grant = (ctx as unknown as Record<string, unknown>)[REVOKED_GRANT];
            if (isRevokedGrant(grant)) await sweepGrant(config.database, grant);
          }),
        },
        {
          // Tokens leave the token endpoint only for a consent row that is
          // still live after the refresh row was written. The issuance gate
          // (`agentGrantClaims`) runs before the provider rotates and inserts
          // the successor refresh row in separate statements; a revocation
          // that lands in between deletes the consent, and this read sees it.
          // The successor is then deleted and never released, so a refresh
          // credential only ever mints for the consent it was issued under.
          matcher: (ctx) => ctx.path === "/oauth2/token",
          handler: createAuthMiddleware(async (ctx) => {
            const returned = ctx.context.returned as Record<string, unknown> | undefined;
            if (
              returned === undefined ||
              returned === null ||
              typeof returned !== "object" ||
              typeof returned.access_token !== "string"
            )
              return;
            const body = (ctx.body ?? {}) as { grant_type?: unknown; client_id?: unknown };
            const claims = accessTokenClaims(returned.access_token);
            const clientId = claims.azp ?? claims.client_id ?? body.client_id;
            if (!scopeAllowed(clientId, returned))
              await withdrawIssuedTokens(
                ctx,
                config,
                options,
                returned,
                new APIError("BAD_REQUEST", {
                  error: "invalid_scope",
                  error_description: "This client cannot receive this scope.",
                }),
              );
            const context = ctx as unknown as Record<string, unknown>;
            const bound = context[CREDENTIAL_GRANT] as { id?: unknown } | undefined;
            const device = body.grant_type === DEVICE_CODE_GRANT_TYPE;
            // The device exchange's refresh row takes the canvas reference, so
            // its refreshes are bound and revoked like any other grant's. Set
            // before the release check: a revocation sweep after it finds it.
            const reference = context[DEVICE_REFERENCE];
            if (
              device &&
              typeof returned.refresh_token === "string" &&
              typeof reference === "string"
            )
              await config.database.query(
                `update "oauthRefreshToken" set "referenceId" = $2
                  where "token" = $1 and "referenceId" is null`,
                [
                  await getOAuthProviderApi(ctx, options as never).hashToken(
                    returned.refresh_token,
                    "refresh_token",
                  ),
                  reference,
                ],
              );
            // A code, refresh or device exchange without a bound row fails closed.
            const credentialGrant =
              body.grant_type === "authorization_code" ||
              body.grant_type === "refresh_token" ||
              device
                ? typeof bound?.id === "string"
                  ? bound.id
                  : ""
                : null;
            await releaseIssuedTokens(ctx, config, options, returned, credentialGrant);
          }),
        },
      ],
    },
    endpoints: {
      /** What the organization and consent pages show for this signed request. */
      agentGrantContext: createAuthEndpoint(
        "/agent-grant/context",
        {
          method: "POST",
          body: z.object({ oauth_query: z.string() }),
          use: [sessionMiddleware],
        },
        async (ctx) => {
          const query = await readOAuthQuery();
          const appId = requestedApp(config, query);
          if (appId === null) throw new APIError("BAD_REQUEST", { error: "invalid_target" });
          const session = ctx.context.session!;
          const organizations = await eligibleOrganizations(config, {
            userId: session.user.id,
            appId,
          });
          const pick = await context.current?.internalAdapter.findVerificationValue(
            pickIdentifier(session.session.id, query),
          );
          const picked =
            pick && pick.expiresAt > new Date()
              ? (organizations.find((organization) => organization.id === pick.value) ?? null)
              : null;
          const clientId = new URLSearchParams(query).get("client_id") ?? "";
          const client = (await ctx.context.adapter.findOne({
            model: "oauthClient",
            where: [{ field: "clientId", value: clientId }],
          })) as Record<string, unknown> | null;
          const metadataDocument = typeof client?.clientDiscoveryId === "string";
          return ctx.json({
            app: { id: appId, resource: agentResourceIdentifier(config.publicOrigin, appId) },
            client: {
              name: typeof client?.name === "string" ? client.name : null,
              uri: typeof client?.uri === "string" ? client.uri : null,
              // A Client ID Metadata Document client is identified by its HTTPS
              // domain; a dynamically registered client describes itself.
              verifiedDomain: metadataDocument ? new URL(clientId).host : null,
            },
            organizations,
            picked,
          });
        },
      ),
      /** Bind the chosen organization to this one authorization request. */
      agentGrantSelectOrganization: createAuthEndpoint(
        "/agent-grant/organization",
        {
          method: "POST",
          body: z.object({ oauth_query: z.string(), organizationId: z.string().min(1) }),
          use: [sessionMiddleware],
        },
        async (ctx) => {
          const query = await readOAuthQuery();
          const appId = requestedApp(config, query);
          if (appId === null) throw new APIError("BAD_REQUEST", { error: "invalid_target" });
          const session = ctx.context.session!;
          const organizations = await eligibleOrganizations(config, {
            userId: session.user.id,
            appId,
          });
          if (!organizations.some((organization) => organization.id === ctx.body.organizationId))
            throw new APIError("FORBIDDEN", {
              error: "access_denied",
              error_description: "This organization cannot grant this app.",
            });
          // One pick per request: a re-selection replaces the earlier one.
          const identifier = pickIdentifier(session.session.id, query);
          await ctx.context.internalAdapter.deleteVerificationByIdentifier(identifier);
          await ctx.context.internalAdapter.createVerificationValue({
            identifier,
            value: ctx.body.organizationId,
            expiresAt: new Date(Date.now() + PICK_SECONDS * 1000),
          });
          return ctx.json({ ok: true });
        },
      ),
      /** What the canvas device page shows for this user code (claiming it for this person). */
      canvasGrantContext: createAuthEndpoint(
        "/canvas-grant/context",
        {
          method: "POST",
          body: z.object({ user_code: z.string().min(1).max(64) }),
          use: [sessionMiddleware],
        },
        async (ctx) => {
          const session = ctx.context.session!;
          const request = await canvasDeviceRequest(config, ctx.body.user_code, session.user.id);
          const organizations = await eligibleOrganizations(config, {
            userId: session.user.id,
            appId: request.appId,
          });
          const reference = parseCanvasGrantReference(request.referenceId);
          return ctx.json({
            app: {
              id: request.appId,
              resource: canvasResourceIdentifier(config.publicOrigin, request.appId),
            },
            organizations,
            picked:
              reference === null
                ? null
                : (organizations.find(
                    (organization) => organization.id === reference.organizationId,
                  ) ?? null),
          });
        },
      ),
      /** Bind the chosen organization to this one canvas device code. */
      canvasGrantSelectOrganization: createAuthEndpoint(
        "/canvas-grant/organization",
        {
          method: "POST",
          body: z.object({
            user_code: z.string().min(1).max(64),
            organizationId: z.string().min(1),
          }),
          use: [sessionMiddleware],
        },
        async (ctx) => {
          const session = ctx.context.session!;
          const request = await canvasDeviceRequest(config, ctx.body.user_code, session.user.id);
          const organizations = await eligibleOrganizations(config, {
            userId: session.user.id,
            appId: request.appId,
          });
          if (!organizations.some((organization) => organization.id === ctx.body.organizationId))
            throw new APIError("FORBIDDEN", {
              error: "access_denied",
              error_description: "This organization cannot grant this app.",
            });
          // One pick per code: a re-selection replaces the earlier one, only
          // while the code is pending; once approved the pick stands.
          const picked = await config.database.query(
            `update "deviceCode" set "referenceId" = $3
              where "id" = $1 and "userId" = $2 and "status" = 'pending'
              returning "id"`,
            [
              request.id,
              session.user.id,
              canvasGrantReference(request.appId, ctx.body.organizationId),
            ],
          );
          if (picked.rows.length !== 1) throw deviceRefusal("This sign-in code was already used.");
          return ctx.json({ ok: true });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}

/** The app and the organization picked for the current signed authorization request, or null. */
async function pickedOrganization(
  config: AgentGrantConfig,
  context: { current?: PluginContext },
  sessionId: string,
  userId: string,
): Promise<{ appId: string; organizationId: string } | null> {
  const state = await getOAuthProviderState();
  if (!state?.query) return null;
  const appId = requestedApp(config, state.query);
  if (appId === null || context.current === undefined) return null;
  const pick = await context.current.internalAdapter.findVerificationValue(
    pickIdentifier(sessionId, state.query),
  );
  if (!pick || pick.expiresAt <= new Date()) return null;
  // Still eligible now, not only when it was picked.
  const organizations = await eligibleOrganizations(config, { userId, appId });
  return organizations.some((organization) => organization.id === pick.value)
    ? { appId, organizationId: pick.value }
    : null;
}

/**
 * Access-token claims for every agent and canvas token, and the issuance
 * gate: one enrolled app per token, a public client, the consent row for
 * exactly this user, client, app and organization, and a current assignment
 * there. Each client gets only its own kind: the canvas client only the
 * canvas scope and a canvas resource, every other client never either. The
 * token names that consent row (`grant`), so deleting the grant and granting
 * again never revives an older token. Throwing aborts issuance (code,
 * refresh and device grants alike).
 */
function agentGrantClaims(config: AgentGrantConfig): OAuthProviderExtension {
  return {
    claims: {
      accessToken: async ({
        ctx,
        user,
        client,
        referenceId,
        resources: requested,
        scopes,
        grantType,
      }) => {
        const resources = requested ?? [];
        const canvasClient = client.clientId === CANVAS_CLIENT_ID;
        const canvasRequested =
          scopes.includes(CANVAS_GRANT_SCOPE) ||
          resources.some((resource) => canvasResourceAppId(config.publicOrigin, resource) !== null);
        if (!canvasClient && canvasRequested)
          throw new APIError("FORBIDDEN", { error: "invalid_scope" });
        let appId: string | null | undefined;
        let reference: { appId: string; organizationId: string } | null;
        let bound = referenceId;
        if (canvasClient) {
          // The device exchange names no reference; the token endpoint bound
          // the approved code's (see the `/oauth2/token` before hook).
          if (bound === undefined && grantType === DEVICE_CODE_GRANT_TYPE) {
            const device = (ctx as unknown as Record<string, unknown>)[DEVICE_REFERENCE];
            bound = typeof device === "string" ? device : undefined;
          }
          if (
            scopes.length === 0 ||
            !scopes.includes(CANVAS_GRANT_SCOPE) ||
            scopes.some((scope) => !(CANVAS_GRANT_SCOPES as readonly string[]).includes(scope))
          )
            throw new APIError("FORBIDDEN", { error: "invalid_scope" });
          appId =
            resources.length === 1 ? canvasResourceAppId(config.publicOrigin, resources[0]!) : null;
          reference = parseCanvasGrantReference(bound);
        } else {
          const appIds = resources.map((resource) =>
            agentResourceAppId(config.publicOrigin, resource),
          );
          if (appIds.length === 0) return {};
          appId = appIds.length === 1 ? appIds[0] : null;
          reference = parseAgentGrantReference(bound);
        }
        if (
          appId === null ||
          appId === undefined ||
          !config.appIds.includes(appId) ||
          !user ||
          reference === null ||
          reference.appId !== appId ||
          (client.tokenEndpointAuthMethod ?? "none") !== "none"
        )
          throw new APIError("FORBIDDEN", { error: "invalid_grant" });
        const consent = await config.database.query(
          `select "id" from "oauthConsent"
            where "userId" = $1 and "clientId" = $2 and "referenceId" = $3 limit 2`,
          [user.id, client.clientId, bound],
        );
        const grantId = consent.rows[0]?.id;
        if (consent.rows.length !== 1 || typeof grantId !== "string")
          throw new APIError("FORBIDDEN", {
            error: "invalid_grant",
            error_description: "The grant was revoked.",
          });
        const organizations = await eligibleOrganizations(config, {
          userId: user.id,
          appId,
        });
        if (!organizations.some((organization) => organization.id === reference.organizationId))
          throw new APIError("FORBIDDEN", {
            error: "invalid_grant",
            error_description: "The organization no longer grants this app to this user.",
          });
        return { org: reference.organizationId, grant: grantId };
      },
    },
  };
}

/** The provider plugin options, shared by the runtime and the schema definition. */
function providerOptions(config: AgentGrantConfig, context: { current?: PluginContext }) {
  const resources = config.appIds.flatMap((appId) => [
    {
      identifier: agentResourceIdentifier(config.publicOrigin, appId),
      name: appId,
      // `offline_access` must stay in the token's scopes: the refresh token
      // inherits them, and only an `offline_access` refresh token rotates.
      allowedScopes: [...AGENT_GRANT_SCOPES],
      accessTokenTtl: AGENT_ACCESS_TOKEN_SECONDS,
    },
    {
      // The canvas in a chat, acting as the person.
      identifier: canvasResourceIdentifier(config.publicOrigin, appId),
      name: `${appId} canvas`,
      allowedScopes: [...CANVAS_GRANT_SCOPES],
      accessTokenTtl: AGENT_ACCESS_TOKEN_SECONDS,
    },
  ]);
  return {
    loginPage: AGENT_GRANT_LOGIN_PAGE,
    consentPage: AGENT_GRANT_CONSENT_PAGE,
    scopes: [...new Set([...AGENT_GRANT_SCOPES, ...CANVAS_GRANT_SCOPES])],
    clientRegistrationDefaultScopes: [...AGENT_GRANT_SCOPES],
    resources,
    // The configured list is the source of truth for enrolled apps.
    resourceSeedMode: "overwrite" as const,
    // The user's consent and app assignment are the gate, not client linkage.
    enforcePerClientResources: false,
    accessTokenExpiresIn: AGENT_ACCESS_TOKEN_SECONDS,
    refreshTokenExpiresIn: AGENT_REFRESH_TOKEN_SECONDS,
    refreshTokenReuseInterval: 0,
    codeExpiresIn: 600,
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    clientRegistrationRequirePKCE: true,
    postLogin: {
      page: AGENT_GRANT_ORGANIZATION_PAGE,
      // The organization page runs until this request has a current pick.
      shouldRedirect: async ({
        session,
        user,
      }: {
        session: { id: string };
        user: { id: string };
      }) => (await pickedOrganization(config, context, session.id, user.id)) === null,
      consentReferenceId: async ({
        session,
        user,
      }: {
        session: { id: string };
        user: { id: string };
      }) => {
        const picked = await pickedOrganization(config, context, session.id, user.id);
        if (picked === null)
          throw new APIError("BAD_REQUEST", {
            error: "invalid_request",
            error_description: "Choose an organization for this app first.",
          });
        // One consent row per app and organization: a new app is a new grant
        // (and a consent page), and never replaces another app's grant.
        return agentGrantReference(picked.appId, picked.organizationId);
      },
    },
    extensions: [agentGrantClaims(config)],
  };
}

/**
 * The plugins that make the realm the agents' authorization server. The
 * runtime enables them only when the trusted policy enrolls at least one app.
 */
export function createAgentGrantPlugins(config: AgentGrantConfig): BetterAuthPlugin[] {
  const context: { current?: PluginContext } = {};
  const options = providerOptions(config, context);
  return [
    jwt({
      jwt: { issuer: agentGrantIssuer(config.publicOrigin) },
      // Session JWT headers are not an app credential here.
      disableSettingJwtHeader: true,
    }),
    oauthProvider(options) as unknown as BetterAuthPlugin,
    // RFC 8628 for the canvas in a chat; the hooks above keep it the canvas
    // client's, and bind its exchange to the approved consent row.
    oauthDeviceAuthorization({
      verificationUri: CANVAS_DEVICE_PAGE,
      expiresIn: `${CANVAS_DEVICE_CODE_SECONDS}s`,
      interval: `${CANVAS_DEVICE_POLL_SECONDS}s`,
    }) as unknown as BetterAuthPlugin,
    cimd({
      fetchClientMetadataResource: config.fetchClientMetadata ?? fetchClientMetadataResource,
      metadataProfile: "mcp-2026-07-28",
    }) as unknown as BetterAuthPlugin,
    agentGrantOrganizationPlugin(config, context, options),
  ];
}

/**
 * Inert schema contributions of these plugins (tables only: no endpoints,
 * hooks or keys). The realm's schema always carries the tables, so the Auth
 * migration lane creates them; the runtime activates the plugins only for an
 * enrolled app.
 */
export function agentGrantSchemaPlugins(): BetterAuthPlugin[] {
  return createAgentGrantPlugins({
    publicOrigin: "https://auth.invalid",
    appIds: [],
    database: {
      query: () => Promise.reject(new Error("schema definition has no database")),
    },
  }).flatMap((plugin) =>
    plugin.schema === undefined ? [] : [{ id: `${plugin.id}-schema`, schema: plugin.schema }],
  );
}

/** A refused agent call: 401 `invalid_token` (re-authorize) or 403 (no access). */
export class AgentGrantError extends Error {
  constructor(
    readonly code: "auth_required" | "app_access_required",
    readonly status: 401 | 403,
    message: string,
  ) {
    super(message);
    this.name = "AgentGrantError";
  }
}

export type GrantContext = {
  /** Which grant: an MCP agent's (`work_session`) or the canvas acting as the person. */
  kind: GrantKind;
  actor: { actorId: string };
  organizationId: string;
  appId: string;
  grants: readonly { role: string; fenceGeneration: number }[];
  /** The consent id: the agent's conversation identity, or the canvas pairing. */
  grantId: string;
  clientId: string;
};

const invalidToken = (message = "The access token is not valid.") =>
  new AgentGrantError("auth_required", 401, message);
const noAccess = (message: string) => new AgentGrantError("app_access_required", 403, message);

const stringList = (value: unknown): string[] => {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return parsed === "" ? [] : String(value).split(/[\s,]+/u);
    }
  }
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
};

/**
 * The key-set cache entry per database. Better Auth caches a function key set
 * under `key` (refetching on an unknown `kid`, so a new key is accepted at
 * once); a fresh `key` object forces a refetch. An entry lives at most
 * `JWKS_CACHE_MS` and never past the soonest expiry of a key it holds, so an
 * expired key stops verifying when it expires.
 */
const jwksCache = new WeakMap<object, { key: object; until: number }>();
const JWKS_CACHE_MS = 60_000;

/**
 * The one verifier (Gateway in protected mode, the app in legacy mode), for
 * both grant kinds. `kind` fixes the scope, the resource (on the issuer's
 * origin), the client and the consent reference shape, so an agent token is
 * never a canvas token and back. It verifies the JWT against the realm's own
 * key set, then re-reads the grant, the organization membership and app, and
 * the app assignment on every call.
 */
export async function requireGrantContext(
  input: { token: string; appId: string; kind: GrantKind },
  deps: {
    database: AgentGrantDatabase;
    issuer: string;
    singleOrganization?: { id: string; appId: string };
  },
): Promise<GrantContext> {
  const { scope, resource } = grantKindFacts(input.kind, new URL(deps.issuer).origin, input.appId);
  let payload: Record<string, unknown>;
  try {
    // The realm's public keys, read where the jwt plugin keeps them.
    let entry = jwksCache.get(deps.database);
    if (entry === undefined || Date.now() >= entry.until) {
      entry = { key: {}, until: Date.now() + JWKS_CACHE_MS };
      jwksCache.set(deps.database, entry);
    }
    const cached = entry;
    payload = (await verifyJwsAccessToken(input.token, {
      jwksFetch: async () => {
        const rows = await deps.database.query(
          `select "id", "publicKey", "alg", "crv", "expiresAt" from "jwks"
            where "expiresAt" is null or "expiresAt" > now()`,
        );
        for (const row of rows.rows) {
          const expiresAt =
            row.expiresAt instanceof Date ? row.expiresAt.getTime() : Number.POSITIVE_INFINITY;
          cached.until = Math.min(cached.until, expiresAt);
        }
        return {
          keys: rows.rows.map((row) => ({
            ...(JSON.parse(String(row.publicKey)) as Record<string, unknown>),
            kid: String(row.id),
            ...(typeof row.alg === "string" ? { alg: row.alg } : { alg: "EdDSA" }),
            ...(typeof row.crv === "string" ? { crv: row.crv } : {}),
          })),
        } as never;
      },
      jwksCacheKey: cached.key,
      verifyOptions: { issuer: deps.issuer, audience: resource },
    })) as Record<string, unknown>;
  } catch {
    throw invalidToken();
  }
  const scopes = typeof payload.scope === "string" ? payload.scope.split(" ") : [];
  const userId = payload.sub;
  const clientId = typeof payload.azp === "string" ? payload.azp : payload.client_id;
  const organizationId = payload.org;
  const grantId = payload.grant;
  if (
    !scopes.includes(scope) ||
    typeof userId !== "string" ||
    typeof clientId !== "string" ||
    typeof organizationId !== "string" ||
    typeof grantId !== "string" ||
    userId.length === 0 ||
    clientId.length === 0 ||
    organizationId.length === 0 ||
    grantId.length === 0 ||
    // Each kind has its own client: the static canvas client, or an agent's.
    (input.kind === "canvas") !== (clientId === CANVAS_CLIENT_ID)
  )
    throw invalidToken();
  // The exact grant the token was issued for, now: a deleted consent refuses
  // even an unexpired token, and a later grant for the same app and
  // organization (a new row) never revives it.
  const consent = await deps.database.query(
    `select "id", "scopes", "resources" from "oauthConsent"
      where "id" = $1 and "userId" = $2 and "clientId" = $3 and "referenceId" = $4`,
    [grantId, userId, clientId, grantReference(input.kind, input.appId, organizationId)],
  );
  const grant = consent.rows[0];
  if (
    consent.rows.length !== 1 ||
    grant === undefined ||
    grant.id !== grantId ||
    !stringList(grant.scopes).includes(scope) ||
    !stringList(grant.resources).includes(resource)
  )
    throw invalidToken("The grant was revoked.");
  let grants: { role: string; fenceGeneration: number }[];
  if (deps.singleOrganization !== undefined) {
    if (
      organizationId !== deps.singleOrganization.id ||
      input.appId !== deps.singleOrganization.appId
    )
      throw noAccess("The token belongs to another deployment.");
    const memberships = await deps.database.query(
      `select "id" from "member" where "userId" = $1 and "organizationId" = $2 limit 1`,
      [userId, organizationId],
    );
    if (memberships.rows.length !== 1)
      throw noAccess("An active organization membership is required.");
    grants = [{ role: "member", fenceGeneration: 0 }];
  } else {
    // Membership and the organization's app, by id (no browser session).
    const access = await deps.database.query(
      `select o."appIds" @> jsonb_build_array($3::text) as app from "member" m
       join "organization" o on o."id" = m."organizationId"
      where m."userId" = $1 and m."organizationId" = $2 limit 1`,
      [userId, organizationId, input.appId],
    );
    if (access.rows.length !== 1) throw noAccess("An active organization membership is required.");
    if (access.rows[0]!.app !== true) throw noAccess("The organization cannot access this app.");
    const assignments = await deps.database.query(
      `select "role", "fence_generation"::text as generation from "app_actor_assignment"
      where "actorId" = $1 and "organizationId" = $2 and "appId" = $3 and "active" = true
      order by "role"`,
      [userId, organizationId, input.appId],
    );
    grants = assignments.rows.map((row) => {
      if (
        typeof row.role !== "string" ||
        !/^[a-z][a-z0-9_]*$/u.test(row.role) ||
        typeof row.generation !== "string" ||
        !/^[0-9]+$/u.test(row.generation) ||
        !Number.isSafeInteger(Number(row.generation))
      )
        throw new Error("App grant readback is invalid");
      return Object.freeze({ role: row.role, fenceGeneration: Number(row.generation) });
    });
    if (grants.length === 0) throw noAccess("An active app role is required.");
  }
  return Object.freeze({
    kind: input.kind,
    actor: Object.freeze({ actorId: userId }),
    organizationId,
    appId: input.appId,
    grants: Object.freeze(grants),
    grantId,
    clientId,
  });
}
