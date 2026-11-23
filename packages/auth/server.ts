import { handoffRealmOperatorIdentityLink } from "./operator-identity-handoff";
import { readIntegrationActivationAuthority } from "./integration-activation-authority";
import {
  captureOperatorNormalBrowserSession,
  operatorNormalCookieDigest,
  readOperatorNormalCookie,
} from "./operator-browser-session";
export {
  verifyRealmCaptureNativeCaller,
  REALM_NATIVE_CAPTURE_CALLER_HEADER,
} from "./operator-identity-attestation";
export { realmOperatorLinkConfigSchema } from "./operator-identity-link";
import { verifyNativeRealmCaptureAttestation } from "./operator-identity-attestation";
import {
  assertRealmNativeSenderEnvironment,
  issueRealmOperatorLinkProof,
  isEnrolledOperatorRealm,
  verifyRealmOperatorLinkProof,
  realmOperatorLinkChallengeSchema,
  realmOperatorLinkConfigSchema,
} from "./operator-identity-link";
export {
  AUTH_OPERATOR_LINK_PATH,
  realmOperatorLinkChallengeSchema,
} from "./operator-identity-link";
import {
  readNormalRealmIdentityBySession,
  readNormalSignedRealmIdentity,
} from "./operator-identity";
export { AUTH_OPERATOR_IDENTITY_PATH } from "./operator-identity";
import type { AppId, CustomerId } from "@contracts";
import { dash } from "@better-auth/infra";
import { waitUntil } from "@vercel/functions";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { oAuthProxy, organization } from "better-auth/plugins";
import { Pool } from "pg";
import {
  readAuthDatabaseResource,
  assertAuthDatabaseConnection,
  verifyAuthDatabaseResource,
  type AuthDatabasePurpose,
  type AuthDatabaseResource,
} from "./database-resource";

import { AuthConfigurationError, readAuthEnvironment, type AuthEnvironmentSource } from "./env";
import { emptySetAdapter } from "./empty-set-adapter";
import {
  agentGrantSchemaPlugins,
  createAgentGrantPlugins,
  requireGrantContext as verifyGrant,
  type AgentGrantConfig,
  type GrantContext,
} from "./agent-grant";
import {
  agentGrantIssuer,
  agentResourceMetadata,
  agentResourcePath,
  appDisplayName,
  type GrantKind,
} from "./agent-grant-policy";
import { canvasFrameOrigins, readCanvasFrameOrigins } from "./canvas-frame";
import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
export {
  AgentGrantError,
  agentAuthorizationRequestKey,
  canvasGrantReference,
  eligibleAgentOrganizations,
} from "./agent-grant";
export type { AgentGrantOrganization, GrantContext } from "./agent-grant";
import { createPasswordRecoveryOptions } from "./password-recovery";
import { managedAppInvitationPlugin, verifyManagedAppInvitation } from "./managed-app-invitations";
import {
  completeManagedAppInvitation,
  completeManagedAppSignup,
} from "./managed-app-access-callback";
import {
  claimManagedAppSignup,
  readManagedAppSignupAccess,
  resolveManagedAppSignupIntent,
} from "./managed-app-signup";
import {
  createManagedSignupRequestHandler,
  createManagedSignupVerification,
  managedSignupContinuationUrl,
  readManagedSignupContinuation,
  managedSignupAppUrl,
  type ManagedSignupContinuation,
} from "./managed-signup-request";
export { AUTH_APP_SIGNUP_CONTINUE_PATH } from "./managed-signup-request";
import { passwordRecoveryEnabledForEnvironment } from "./env";
import { continueManagedSignup } from "./managed-signup-continuation";
import {
  authDatabaseResourceDigest,
  currentAppSignupIntent,
  enrollAppSignupUser,
  readAppSignupStatus,
} from "./signup-policy";
import { hasManagedAppRecord, readManagedAppActorAccess } from "./managed-app-access";
import { readLocalAppAccessBinding } from "./local-runtime-access";
import {
  isAppCreatedOrganizationMembership,
  readOrganizationMemberships,
  type OrganizationMembershipLoader,
} from "./organization-membership-access";
export { readAppSignupStatus } from "./signup-policy";
import {
  toHeaders,
  type AuthBoundaryErrorCode,
  type AuthBoundaryErrorStatus,
  type AuthenticatedTenantScope,
  type HeadersLike,
} from "./server-policy";
export {
  authBoundaryErrorFromUnknown,
  isInfrastructureDashboardBearerMutation,
  toHeaders,
} from "./server-policy";
export type {
  AuthBoundaryErrorCode,
  AuthBoundaryErrorDetails,
  AuthBoundaryErrorStatus,
  AuthenticatedTenantScope,
  HeadersLike,
} from "./server-policy";

export type AuthenticatedActor = {
  actorId: string;
  email: string | null;
  name: string | null;
};

export type AuthenticatedTenantContext = {
  actor: AuthenticatedActor;
  organization: AuthenticatedOrganization;
  scope: AuthenticatedTenantScope;
};

export type AuthIntrospectionPayload = AuthenticatedTenantScope & {
  organizationRole: string | null;
};

export const AUTH_INTROSPECTION_PATH = "/api/auth/platform/introspect";
export const AUTH_APP_SIGNUP_STATUS_PATH = "/api/auth/platform/signup-status";
export const INFRASTRUCTURE_DASHBOARD_ORIGIN = "https://dash.better-auth.com";

export type AuthSessionLoader = (headers: Headers) => Promise<unknown>;
export type OrganizationLoader = (headers: Headers) => Promise<unknown>;
export type TenantMembershipVerifier = (
  headers: Headers,
  scope: { actorId: string; organizationId: string },
) => Promise<boolean>;
export type AuthenticatedOrganization = {
  id: string;
  name: string;
  slug: string;
  appIds: readonly AppId[];
};

export type AuthenticatedUserOrganizationContext = {
  actor: AuthenticatedActor;
  activeOrganizationId: string | null;
  organizations: readonly AuthenticatedOrganization[];
};

export type AuthGuardOptions = {
  getSession?: AuthSessionLoader;
  listOrganizations?: OrganizationLoader;
  loadOrganizationMemberships?: OrganizationMembershipLoader;
  loadAppActorGrants?: AppActorGrantsLoader;
  loadAppAccess?: (
    input: Parameters<AppActorGrantsLoader>[0],
  ) => Promise<{ fenceGeneration: number } | null>;
  loadRolelessAppAccess?: (
    input: Parameters<AppActorGrantsLoader>[0],
  ) => Promise<{ fenceGeneration: number } | null>;
};

export type TenantScopeGuardOptions = AuthGuardOptions & {
  appId: AppId;
  customerId?: CustomerId;
  verifyTenantMembership?: TenantMembershipVerifier;
};

export type AppActorRolesLoader = (input: {
  actorId: string;
  appId: AppId;
  organizationId: string;
}) => Promise<readonly string[]>;

export type AppContextGuardOptions = TenantScopeGuardOptions & {
  requiredRole?: string;
  loadAppActorRoles?: AppActorRolesLoader;
  loadAppActorAccess?: (input: Parameters<AppActorRolesLoader>[0]) => Promise<boolean>;
};

export type AuthenticatedAppContext = AuthenticatedTenantContext & {
  roles: readonly string[];
};

export type CreateAuthOptions = {
  appName: string;
  databasePurpose?: AuthDatabasePurpose;
  env?: AuthEnvironmentSource;
  allowPlaceholderConfig?: boolean;
  /** Reuse an already validated migration connection without creating a runtime pool. */
  databaseOverride?: Pool;
  backgroundTasks?: NonNullable<BetterAuthOptions["advanced"]>["backgroundTasks"];
  /**
   * Trusted composition policy: the apps whose MCP route is an OAuth
   * resource of this realm. Empty or absent leaves the realm without the
   * agent authorization server.
   */
  agentAppIds?: readonly string[];
  /** Test seam for the CIMD metadata transport. */
  fetchClientMetadata?: AgentGrantConfig["fetchClientMetadata"];
};

function createOrganizationPlugin() {
  return organization({
    allowUserToCreateOrganization: false,
    disableOrganizationDeletion: true,
    schema: {
      organization: {
        additionalFields: {
          metadata: { type: "string", required: false, input: false },
          appIds: {
            type: "json",
            required: false,
            input: false,
          },
        },
      },
    },
  });
}

/** Source-only SQL definition; no realm URL, secret, native settings or database client. */
export function createAuthSchemaDefinitionOptions() {
  return {
    plugins: [createOrganizationPlugin(), ...(agentGrantSchemaPlugins() as never[])],
  };
}

/** The trusted policy's enrolled agent apps (`PLATFORM_GATEWAY_PROTECTED_APPLICATIONS`). */
export function readAgentAppIds(
  source: Record<string, string | undefined> = process.env,
): readonly string[] {
  const raw = source.PLATFORM_GATEWAY_PROTECTED_APPLICATIONS;
  if (raw === undefined || raw.trim() === "") return [];
  // An explicit empty list enrolls no app: the agent server stays off.
  if (/^\[\s*\]$/u.test(raw.trim())) return [];
  const parsed = parseOrganizationAppIds(raw);
  if (parsed === null)
    throw new AuthConfigurationError([
      "PLATFORM_GATEWAY_PROTECTED_APPLICATIONS must be a JSON array of app ids",
    ]);
  return parsed;
}

type ActiveOrganizationMembershipRow = { organizationId: string };

type AuthSessionCreatePayload = {
  id: string;
  activeOrganizationId?: string | null;
  userId: string;
} & Record<string, unknown>;

export type AuthDatabase = {
  query(
    queryText: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
};

export class AuthBoundaryError extends Error {
  readonly code: AuthBoundaryErrorCode;
  readonly status: AuthBoundaryErrorStatus;

  constructor(code: AuthBoundaryErrorCode, message: string, status: AuthBoundaryErrorStatus) {
    super(message);
    this.name = "AuthBoundaryError";
    this.code = code;
    this.status = status;
  }
}

let authInstance: ReturnType<typeof createAuth> | null = null;
let tenantPermissionDatabase: AuthDatabase | null = null;

export function createAuthOptions(options: CreateAuthOptions) {
  const appName = readAuthApplicationName({
    BETTER_AUTH_APP_NAME: options.appName,
  });
  const source = options.env ?? process.env;
  const env = readAuthEnvironment(options.env, {
    ...(options.allowPlaceholderConfig === undefined
      ? {}
      : { allowPlaceholderConfig: options.allowPlaceholderConfig }),
    databasePurpose: options.databasePurpose ?? "runtime",
  });
  const passwordRecovery = env.usingPlaceholderConfig
    ? undefined
    : createPasswordRecoveryOptions(source, appName);
  const onVercel = ["production", "preview", "development"].includes(source.VERCEL_ENV ?? "");
  const backgroundTasks: CreateAuthOptions["backgroundTasks"] =
    options.backgroundTasks ??
    (passwordRecovery
      ? {
          handler: onVercel
            ? waitUntil
            : (task) => {
                // The supported non-Vercel runtime is a persistent local Node server.
                void task.catch(() => {});
              },
        }
      : undefined);
  const protectedPreviewRealm = isEnrolledOperatorRealm({
    environment: options.env ?? process.env,
    resource: env.databaseResource,
    baseUrl: env.baseUrl,
  });
  const database =
    options.databaseOverride ??
    createAuthPool(env.databaseUrl, env.databaseResource, options.databasePurpose);
  const managedRealm = protectedPreviewRealm
    ? realmOperatorLinkConfigSchema.parse(JSON.parse(source.PLATFORM_REALM_OPERATOR_LINK_CONFIG!))
        .managedProduction
    : undefined;
  const managedVerification =
    managedRealm && !env.usingPlaceholderConfig
      ? createManagedSignupVerification({
          source,
          appName,
          origin: env.baseUrl,
          // Match Better Auth's effective signing secret while versioned keys rotate.
          secret: env.secrets?.[0]?.value ?? env.secret!,
          resolveIntent: (input) => resolveManagedAppSignupIntent(database, managedRealm, input),
        })
      : undefined;
  // The canvas frames' origins (configured, plus Claude's derived one per
  // enrolled app) may call the device and token endpoints.
  const frameOrigins = canvasFrameOrigins({
    publicOrigin: new URL(env.baseUrl).origin,
    appIds: options.agentAppIds ?? [],
    configured: readCanvasFrameOrigins(source),
  });
  const trustedOrigins = [
    ...env.trustedOrigins,
    ...(env.infrastructure ? [INFRASTRUCTURE_DASHBOARD_ORIGIN] : []),
    ...frameOrigins,
  ];

  return {
    appName,
    database,
    baseURL: {
      allowedHosts: protectedPreviewRealm
        ? [
            ...new Set([
              new URL(env.baseUrl).host,
              new URL(
                realmOperatorLinkConfigSchema.parse(
                  JSON.parse(
                    (options.env ?? process.env).PLATFORM_REALM_OPERATOR_LINK_CONFIG ?? "null",
                  ),
                ).browserOrigin,
              ).host,
            ]),
          ]
        : [...env.allowedHosts],
      protocol: "auto",
    },
    secret: env.secret,
    secrets: env.secrets ? [...env.secrets] : undefined,
    trustedOrigins: trustedOrigins.length > 0 ? [...new Set(trustedOrigins)] : undefined,
    advanced: {
      ...(backgroundTasks ? { backgroundTasks } : {}),
      disableOriginCheck: false,
      // The shell and gateway may run with different NODE_ENV values locally.
      // Bind the cookie name and Secure attribute to their shared auth origin.
      useSecureCookies: new URL(env.baseUrl).protocol === "https:",
      ...(env.cookieDomain
        ? {
            crossSubDomainCookies: {
              enabled: true,
              domain: env.cookieDomain,
            },
          }
        : {}),
      ...(env.trustedClientIpHeaders
        ? {
            ipAddress: {
              ipAddressHeaders: [...env.trustedClientIpHeaders],
            },
          }
        : {}),
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: !env.allowPublicSignUp,
      ...passwordRecovery,
    },
    ...(managedVerification ? { emailVerification: managedVerification } : {}),
    socialProviders: env.google
      ? {
          google: {
            clientId: env.google.clientId,
            clientSecret: env.google.clientSecret,
            disableImplicitSignUp: true,
            disableSignUp: true,
          },
        }
      : undefined,
    databaseHooks: {
      user: {
        create: {
          after: async (user: { id: string }) => {
            if (env.allowPublicSignUp && !protectedPreviewRealm) {
              await provisionPublicSignupMembership(database, user.id);
            }
          },
        },
      },
      session: {
        create: {
          before: async (session: AuthSessionCreatePayload) => {
            if (protectedPreviewRealm && !managedRealm) {
              const enrollment = await enrollAppSignupUser(database, {
                userId: session.userId,
                sessionId: session.id,
                origin: env.baseUrl,
                resource: env.databaseResource!,
                appUrl: currentAppSignupIntent(),
              });
              if (enrollment.status === "membership_ready") {
                return { data: { ...session, activeOrganizationId: enrollment.organizationId } };
              }
            }
            if (session.activeOrganizationId) {
              return { data: session };
            }
            const activeOrganizationId = await initialActiveOrganizationIdForUser(
              database,
              session.userId,
            );
            return activeOrganizationId
              ? { data: { ...session, activeOrganizationId } }
              : { data: session };
          },
        },
      },
    },
    plugins: [
      emptySetAdapter(),
      ...(managedRealm && source.AUTH_RECOVERY_RESEND_API_KEY && source.AUTH_RECOVERY_EMAIL_FROM
        ? [
            managedAppInvitationPlugin({
              database,
              realm: managedRealm,
              apiKey: source.AUTH_RECOVERY_RESEND_API_KEY,
              from: source.AUTH_RECOVERY_EMAIL_FROM,
            }),
          ]
        : []),
      ...(env.oAuthProxy
        ? [
            oAuthProxy({
              productionURL: env.oAuthProxy.productionUrl,
              secret: env.oAuthProxy.secret,
            }),
          ]
        : []),
      createOrganizationPlugin(),
      ...((options.agentAppIds ?? []).length > 0
        ? (createAgentGrantPlugins({
            publicOrigin: new URL(env.baseUrl).origin,
            appIds: options.agentAppIds ?? [],
            database,
            ...(options.fetchClientMetadata
              ? { fetchClientMetadata: options.fetchClientMetadata }
              : {}),
            // Untyped here: the agent endpoints are served over HTTP, and the
            // typed `auth.api` surface stays the realm's own.
          }) as never[])
        : // Not enrolled: only the tables, so the realm schema stays one definition.
          (agentGrantSchemaPlugins() as never[])),
      ...(env.infrastructure ? [dash({ apiKey: env.infrastructure.apiKey })] : []),
      nextCookies(),
    ],
  } satisfies BetterAuthOptions;
}

export function createAuth(options: CreateAuthOptions) {
  return betterAuth(createAuthOptions(options));
}

export async function provisionPublicSignupMembership(database: AuthDatabase, userId: string) {
  const signupOrganizationId = await serverOwnedSignupOrganizationId(database);
  const membership = await database.query(
    `
      insert into "member" ("id", "organizationId", "userId", "role", "createdAt")
      select $1, $2, $3, 'owner', now()
      where exists (
        select 1 from "organization" where "id" = $2
      )
      on conflict ("id") do update set "role" = excluded."role"
      returning "id"
    `,
    [`${signupOrganizationId}:${userId}:owner`, signupOrganizationId, userId],
  );
  if (membership.rows.length === 0) {
    throw new AuthConfigurationError([
      "The server-owned signup organization must exist before public signup is enabled",
    ]);
  }
  await database.query(
    `
      update "session"
      set "activeOrganizationId" = $1,
          "updatedAt" = now()
      where "userId" = $2
        and "activeOrganizationId" is null
    `,
    [signupOrganizationId, userId],
  );
}

async function serverOwnedSignupOrganizationId(database: AuthDatabase): Promise<string> {
  const organizations = await database.query(
    `
      select "id"
      from "organization"
      where "metadata" = $1
      order by "id" asc
      limit 2
    `,
    ['{"signupAccess":"all-apps"}'],
  );
  const organizationIds = organizations.rows
    .map((row) => row.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const [signupOrganizationId] = organizationIds;
  if (organizationIds.length !== 1 || !signupOrganizationId) {
    throw new AuthConfigurationError([
      "Exactly one server-owned all-app signup organization must be provisioned before public signup is enabled",
    ]);
  }
  return signupOrganizationId;
}

/**
 * The canvas frames' origins for this realm: `CANVAS_FRAME_ORIGINS` plus
 * Claude's derived frame origin for each enrolled app's MCP endpoint.
 */
export function realmCanvasFrameOrigins(
  source: Record<string, string | undefined> = process.env,
): readonly string[] {
  const appIds = readAgentAppIds(source);
  if (appIds.length === 0) return [];
  return canvasFrameOrigins({
    publicOrigin: new URL(readAuthEnvironment(source).baseUrl).origin,
    appIds,
    configured: readCanvasFrameOrigins(source),
  });
}

export function getAuth() {
  authInstance ??= createAuth({
    appName: readAuthApplicationName({
      // Keep this direct property access: Next replaces values declared in
      // next.config.ts only when it can statically identify process.env.NAME.
      BETTER_AUTH_APP_NAME: process.env.BETTER_AUTH_APP_NAME,
    }),
    agentAppIds: readAgentAppIds(),
  });
  return authInstance;
}

/**
 * Verify a bearer token of one grant kind for one app (an MCP agent's
 * `work_session`, or the canvas acting as the person) and re-read its grant,
 * membership, organization app and assignment (Gateway in protected mode,
 * the app itself in legacy mode). Throws `AgentGrantError` (401/403).
 */
export async function requireGrantContext(
  input: { token: string; appId: AppId; kind: GrantKind },
  deps?: { database?: AuthDatabase; issuer?: string },
): Promise<GrantContext> {
  return withAuthDatabaseReadRetry(() =>
    verifyGrant(input, {
      database: deps?.database ?? getTenantPermissionDatabase(),
      issuer: deps?.issuer ?? agentGrantIssuer(new URL(readAuthEnvironment().baseUrl).origin),
    }),
  );
}

/**
 * The shell's `/.well-known/*` answers for agents: Protected Resource
 * Metadata (RFC 9728) for each enrolled app's MCP route, and the
 * path-inserted Authorization Server Metadata (RFC 8414) of the realm's
 * issuer. Anything else, or a realm with no enrolled app, is 404.
 */
export async function agentWellKnownResponse(request: Request): Promise<Response> {
  const notFound = () =>
    new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  const appIds = readAgentAppIds();
  if (appIds.length === 0 || request.method !== "GET") return notFound();
  const { pathname } = new URL(request.url);
  const publicOrigin = new URL(readAuthEnvironment().baseUrl).origin;
  const resourcePrefix = "/.well-known/oauth-protected-resource";
  if (pathname.startsWith(`${resourcePrefix}/`)) {
    const appId = appIds.find(
      (candidate) => `${resourcePrefix}${agentResourcePath(candidate)}` === pathname,
    );
    if (appId === undefined) return notFound();
    return Response.json(agentResourceMetadata(publicOrigin, appId), {
      headers: { "cache-control": "public, max-age=300" },
    });
  }
  if (pathname === "/.well-known/oauth-authorization-server/api/auth")
    return oauthProviderAuthServerMetadata(
      getAuth() as unknown as Parameters<typeof oauthProviderAuthServerMetadata>[0],
    )(request);
  return notFound();
}

export function readAuthApplicationName(
  source: Record<string, string | undefined> = process.env,
): string {
  const appName = source.BETTER_AUTH_APP_NAME?.trim();
  if (!appName) {
    throw new AuthConfigurationError(["BETTER_AUTH_APP_NAME must be configured"]);
  }
  return appName;
}

export async function initialActiveOrganizationIdForUser(
  database: AuthDatabase,
  userId: string,
): Promise<string | null> {
  const memberships = await database.query(
    `
      select "organizationId"
      from "member"
      where "userId" = $1
      order by "createdAt" asc, "organizationId" asc
      limit 2
    `,
    [userId],
  );
  const membership = activeOrganizationMembershipRow(memberships.rows[0]);
  return memberships.rows.length === 1 ? (membership?.organizationId ?? null) : null;
}

/** Stage proof privately and return only the browser continuation. */
export async function stageRealmOperatorIdentityLink(linked: {
  callbackUrl: string;
  nonce: string;
  proof: string;
}): Promise<string> {
  const config = realmOperatorLinkConfigSchema.parse(
    JSON.parse(process.env.PLATFORM_REALM_OPERATOR_LINK_CONFIG ?? "null"),
  );
  return handoffRealmOperatorIdentityLink({ config, linked });
}

/** Server-only normal browser proof producer. Existing hosted Gateway key is required; no local key fallback. */
export async function produceRealmOperatorIdentityLink(headers: Headers, challengeInput: unknown) {
  const challenge = realmOperatorLinkChallengeSchema.parse(challengeInput);
  const config = realmOperatorLinkConfigSchema.parse(
    JSON.parse(process.env.PLATFORM_REALM_OPERATOR_LINK_CONFIG ?? "null"),
  );
  if (config.publicEnrollment !== undefined || config.managedProduction !== undefined) {
    assertRealmNativeSenderEnvironment(config, process.env);
  }
  const issuer = process.env.PLATFORM_PUBLIC_ORIGIN;
  if (!issuer || headers.get("origin") !== config.browserOrigin)
    throw new Error("realm_link_origin_required");
  const privateKey = process.env.PLATFORM_GATEWAY_IDENTITY_PRIVATE_KEY;
  const keyId = process.env.PLATFORM_GATEWAY_IDENTITY_KEY_ID;
  const resource = readAuthEnvironment().databaseResource;
  if (!privateKey || !keyId || !resource) throw new Error("realm_link_not_configured");
  const normalCookie = challenge.browserSession
    ? readOperatorNormalCookie({
        headers,
        origin: config.browserOrigin,
        cookie: (await getAuth().$context).authCookies.sessionToken,
      })
    : undefined;
  if (normalCookie && issuer !== config.browserOrigin)
    throw new Error("realm_browser_session_origin_required");
  const identity = await readRealmOperatorIdentity(headers, challenge.organizationId);
  if (identity === null)
    throw new AuthBoundaryError("auth_required", "Sign in normally to link your account.", 401);
  const proof = issueRealmOperatorLinkProof({
    identity,
    resource,
    challenge,
    config,
    issuer,
    keyId,
    privateKey,
    ...(normalCookie ? { normalCookieSha256: operatorNormalCookieDigest(normalCookie) } : {}),
  });
  if (normalCookie)
    await captureOperatorNormalBrowserSession({
      config,
      challenge,
      proof,
      normalCookie,
    });
  return {
    callbackUrl: `${config.builderCallbackOrigin}${config.builderCallbackPath}`,
    nonce: challenge.nonce,
    proof,
  };
}

type RealmIdentityReadbackStage =
  | "configuration"
  | "capture_attestation"
  | "signed_proof"
  | "capture_session"
  | "resource_scope"
  | "normal_session";
type RealmIdentityReadbackOutcome =
  | "rejected"
  | "native_caller_rejected"
  | "normal_session_not_current"
  | "read_error";

function reportRealmIdentityReadbackFailure(
  stage: RealmIdentityReadbackStage,
  outcome: RealmIdentityReadbackOutcome,
): void {
  try {
    console.error({ event: "auth.realm_identity_readback_failed", stage, outcome });
  } catch {
    // Diagnostics never replace the original authentication failure.
  }
}

/** A scoped proof authorizes only current readback of its own normal session and optional owned organization. */
export async function readbackRealmOperatorIdentityProof(
  proof: string,
  captureInput?: { attestation: unknown; headers: Headers },
) {
  let stage: RealmIdentityReadbackStage = "configuration";
  let outcome: RealmIdentityReadbackOutcome = "rejected";
  try {
    const config = realmOperatorLinkConfigSchema.parse(
      JSON.parse(process.env.PLATFORM_REALM_OPERATOR_LINK_CONFIG ?? "null"),
    );
    const issuer = process.env.PLATFORM_PUBLIC_ORIGIN;
    const privateKey = process.env.PLATFORM_GATEWAY_IDENTITY_PRIVATE_KEY;
    const keyId = process.env.PLATFORM_GATEWAY_IDENTITY_KEY_ID;
    const resource = readAuthEnvironment().databaseResource;
    if (!issuer || !privateKey || !keyId || !resource) throw new Error("realm_link_not_configured");
    stage = "capture_attestation";
    const captured = captureInput
      ? await verifyNativeRealmCaptureAttestation({ proof, ...captureInput, config })
      : undefined;
    stage = "signed_proof";
    const claims = verifyRealmOperatorLinkProof({
      proof,
      issuer,
      audience: config.operatorOrigin,
      keyId,
      privateKey,
      ...(captured ? { now: new Date(captured.capturedAt) } : {}),
    });
    if (config.publicEnrollment !== undefined) {
      if (
        claims.publicRelease?.enrollmentRef !== config.publicEnrollment.enrollmentRef ||
        claims.ownerSessionId !== config.publicEnrollment.ownerSessionId ||
        claims.authResourceId !== config.publicEnrollment.sourceBootstrap.authResourceId
      )
        throw new Error("realm_link_scope_mismatch");
    } else if (claims.publicRelease !== undefined) throw new Error("realm_link_scope_mismatch");
    stage = "capture_session";
    if (captured && captured.realmSessionId !== claims.sessionId)
      throw new Error("realm_capture_mismatch");
    stage = "resource_scope";
    const claimedResource = readAuthDatabaseResource(JSON.stringify(claims.resource));
    if (
      !claimedResource ||
      ![
        claimedResource.version === resource.version,
        claimedResource.environment === resource.environment,
        claimedResource.hostname === resource.hostname,
        claimedResource.port === resource.port,
        claimedResource.database === resource.database,
        claimedResource.schema === resource.schema,
        claimedResource.runtimeRole === resource.runtimeRole,
        claimedResource.migratorRole === resource.migratorRole,
        claimedResource.neon?.projectId === resource.neon?.projectId,
        claimedResource.neon?.branchId === resource.neon?.branchId,
      ].every(Boolean)
    )
      throw new Error("realm_link_resource_mismatch");
    stage = "normal_session";
    outcome = "read_error";
    const identity = await readNormalRealmIdentityBySession({
      database: getTenantPermissionDatabase(),
      actorId: claims.sub,
      realmSessionId: claims.sessionId,
      organizationId: claims.organizationId,
    });
    outcome = "normal_session_not_current";
    if (identity === null)
      throw new AuthBoundaryError("auth_required", "Normal session is no longer current.", 401);
    return { identity, resource };
  } catch (error) {
    try {
      if (stage === "capture_attestation" && error instanceof Error) {
        const message = Object.getOwnPropertyDescriptor(error, "message");
        if (
          message &&
          "value" in message &&
          message.value === "realm_capture_native_authority_required"
        ) {
          outcome = "native_caller_rejected";
        }
      }
      reportRealmIdentityReadbackFailure(stage, outcome);
    } catch {
      // Even hostile error descriptors cannot change the original failure.
    }
    throw error;
  }
}

/** Verify the ordinary Realm cookie without refreshing or deleting any session. */
export async function readRealmOperatorIdentity(headers: Headers, organizationId: string | null) {
  const context = await getAuth().$context;
  return readNormalSignedRealmIdentity({
    headers,
    organizationId,
    cookieName: context.authCookies.sessionToken.name,
    secret: context.secret,
    database: getTenantPermissionDatabase(),
  });
}

export async function requireUser(
  headersLike: HeadersLike,
  options: AuthGuardOptions = {},
): Promise<AuthenticatedActor> {
  const headers = toHeaders(headersLike);
  const session = await loadSession(headers, options.getSession);
  const actor = actorFromSession(session);
  if (!actor) {
    throw new AuthBoundaryError("auth_required", "Authentication is required.", 401);
  }
  return actor;
}

function managedSignupContext() {
  if (process.env.VERCEL_ENV !== "production") return null;
  const environment = readAuthEnvironment();
  if (
    !isEnrolledOperatorRealm({
      environment: process.env,
      resource: environment.databaseResource,
      baseUrl: environment.baseUrl,
    })
  )
    return null;
  const config = realmOperatorLinkConfigSchema.parse(
    JSON.parse(process.env.PLATFORM_REALM_OPERATOR_LINK_CONFIG!),
  );
  return config.managedProduction
    ? { config, realm: config.managedProduction, origin: environment.baseUrl }
    : null;
}

/** The regular Auth singleton stays signup-disabled in Production. */
export async function handleManagedAppSignupForRequest(request: Request): Promise<Response | null> {
  if (process.env.VERCEL_ENV !== "production") return null;
  const context = managedSignupContext();
  if (!context) return null;
  if (!passwordRecoveryEnabledForEnvironment())
    return Response.json({ code: "APP_SIGNUP_UNAVAILABLE" }, { status: 403 });
  return createManagedSignupRequestHandler({
    options: getAuth().options,
    origin: context.origin,
    resolveIntent: (input) =>
      resolveManagedAppSignupIntent(getTenantPermissionDatabase(), context.realm, input),
  })(request);
}

/** UI visibility is a policy read, never permission to create an account. */
export async function readManagedAppSignupPage(appUrl: string | undefined) {
  if (!appUrl || !passwordRecoveryEnabledForEnvironment()) return null;
  const context = managedSignupContext();
  if (!context) return null;
  const target = managedSignupAppUrl(appUrl, context.origin);
  const policy =
    target &&
    (await resolveManagedAppSignupIntent(getTenantPermissionDatabase(), context.realm, {
      appUrl: target,
    }));
  if (!policy) return null;
  return { appPath: policy.appPath };
}

function managedAppSignupForSession(
  context: NonNullable<ReturnType<typeof managedSignupContext>>,
  headers: Headers,
  appUrl: string | undefined,
  complete: boolean,
  continuation?: ManagedSignupContinuation,
) {
  const database = getTenantPermissionDatabase();
  return continueManagedSignup(
    { origin: context.origin, appUrl, complete, continuation },
    {
      loadSession: () => loadSession(headers).catch(() => null),
      resolveIntent: (input) => resolveManagedAppSignupIntent(database, context.realm, input),
      existingAccess: async (policy) => {
        try {
          const existing = await requireAppGrantContext(headers, {
            appId: policy.appId,
            customerId: policy.organizationId,
          });
          return {
            actorId: existing.scope.actorId,
            appId: existing.scope.appId,
            organizationId: existing.scope.customerId,
            generations: existing.grants.map((grant) => grant.fenceGeneration),
            ...(existing.appAccess
              ? { appAccessGeneration: existing.appAccess.fenceGeneration }
              : {}),
          };
        } catch (error) {
          if (error instanceof AuthBoundaryError && error.status === 403) return null;
          throw error;
        }
      },
      readAccess: (identity) => readManagedAppSignupAccess(database, context.realm, identity),
      claim: (identity) => claimManagedAppSignup(database, context.realm, identity),
      complete: (claim) => completeManagedAppSignup({ config: context.config, ...claim }),
      continuationUrl: async (identity) =>
        managedSignupContinuationUrl(
          {
            origin: context.origin,
            actorId: identity.actorId,
            policyId: identity.policyId,
            policyDigest: identity.policyDigest,
            appUrl: identity.appUrl,
          },
          (await getAuth().$context).secret,
        ),
    },
  );
}

export async function acceptManagedAppSignupForRequest(request: Request) {
  const context = managedSignupContext();
  if (!context) return { status: "blocked" as const };
  const continuation = await readManagedSignupContinuation(
    request,
    (await getAuth().$context).secret,
  );
  return continuation
    ? managedAppSignupForSession(context, request.headers, continuation.appUrl, true, continuation)
    : { status: "blocked" as const };
}

/** Safe public status and callback URLs; identity is always read from the Auth session cookie. */
export async function readAppSignupStatusForRequest(headersLike: HeadersLike, appUrl?: string) {
  const headers = toHeaders(headersLike);
  const managed = managedSignupContext();
  if (managed) return managedAppSignupForSession(managed, headers, appUrl, false);
  const environment = readAuthEnvironment();
  const resource = environment.databaseResource;
  if (
    !resource ||
    !isEnrolledOperatorRealm({ environment: process.env, resource, baseUrl: environment.baseUrl })
  )
    return { status: "blocked" as const };
  const sessionValue = await loadSession(headers).catch(() => null);
  const actor = actorFromSession(sessionValue);
  const sessionRecord =
    sessionValue && typeof sessionValue === "object" && "session" in sessionValue
      ? sessionValue.session
      : undefined;
  const sessionId =
    sessionRecord &&
    typeof sessionRecord === "object" &&
    "id" in sessionRecord &&
    typeof sessionRecord.id === "string"
      ? sessionRecord.id
      : undefined;
  return readAppSignupStatus(getTenantPermissionDatabase(), {
    ...(actor ? { userId: actor.actorId } : {}),
    ...(sessionId ? { sessionId } : {}),
    origin: environment.baseUrl,
    resource,
    ...(appUrl ? { appUrl } : {}),
  });
}

/** A one-use Auth link returns here with its own verified session, never a caller-supplied user id. */
export async function acceptManagedAppInvitationForRequest(
  headersLike: HeadersLike,
  invitationId: string,
): Promise<
  { status: "ready"; url: string } | { status: "pending" | "verification_required" } | null
> {
  const environment = readAuthEnvironment();
  if (
    !isEnrolledOperatorRealm({
      environment: process.env,
      resource: environment.databaseResource,
      baseUrl: environment.baseUrl,
    })
  )
    return null;
  const config = realmOperatorLinkConfigSchema.parse(
    JSON.parse(process.env.PLATFORM_REALM_OPERATOR_LINK_CONFIG!),
  );
  if (!config.managedProduction) return null;
  const session = await loadSession(toHeaders(headersLike));
  const actor = actorFromSession(session);
  const sessionId =
    session &&
    typeof session === "object" &&
    "session" in session &&
    session.session &&
    typeof session.session === "object" &&
    "id" in session.session
      ? session.session.id
      : undefined;
  if (!actor || typeof sessionId !== "string") return { status: "verification_required" };
  const target = await verifyManagedAppInvitation(
    getTenantPermissionDatabase(),
    config.managedProduction,
    {
      invitationId,
      actorId: actor.actorId,
      sessionId,
    },
  );
  if (
    !target ||
    ![config.builderCallbackOrigin, config.managedProduction.publicOrigin].includes(
      new URL(target).origin,
    )
  )
    return null;
  try {
    const status = await completeManagedAppInvitation({ config, invitationId });
    return status === "ready" ? { status, url: target } : { status };
  } catch {
    return { status: "pending" };
  }
}

/** Continue an installed app policy for the authenticated browser session only. */
export async function continueAppSignupForRequest(
  headersLike: HeadersLike,
  appUrl: string | undefined,
  requestOrigin: string | null,
) {
  const headers = toHeaders(headersLike);
  const managed = managedSignupContext();
  if (managed)
    return requestOrigin === managed.origin
      ? managedAppSignupForSession(managed, headers, appUrl, true)
      : { status: "blocked" as const };
  const environment = readAuthEnvironment();
  const resource = environment.databaseResource;
  if (
    !resource ||
    !isEnrolledOperatorRealm({
      environment: process.env,
      resource,
      baseUrl: environment.baseUrl,
    }) ||
    requestOrigin !== environment.baseUrl
  )
    return { status: "blocked" as const };
  const sessionValue = await loadSession(headers).catch(() => null);
  const actor = actorFromSession(sessionValue);
  const sessionRecord =
    sessionValue && typeof sessionValue === "object" && "session" in sessionValue
      ? sessionValue.session
      : undefined;
  const sessionId =
    sessionRecord &&
    typeof sessionRecord === "object" &&
    "id" in sessionRecord &&
    typeof sessionRecord.id === "string"
      ? sessionRecord.id
      : undefined;
  if (!actor || !sessionId) return { status: "blocked" as const };
  const enrollment = await enrollAppSignupUser(getTenantPermissionDatabase(), {
    userId: actor.actorId,
    sessionId,
    origin: environment.baseUrl,
    resource,
    ...(appUrl ? { appUrl } : {}),
  });
  if (enrollment.status !== "membership_ready" || !enrollment.sessionBound)
    return {
      status:
        enrollment.status === "waiting_for_signup"
          ? ("waiting_for_signup" as const)
          : ("blocked" as const),
    };
  return readAppSignupStatus(getTenantPermissionDatabase(), {
    userId: actor.actorId,
    sessionId,
    origin: environment.baseUrl,
    resource,
    ...(appUrl ? { appUrl } : {}),
  });
}

export async function requireUserOrganizationContext(
  headersLike: HeadersLike,
  options: AuthGuardOptions = {},
): Promise<AuthenticatedUserOrganizationContext> {
  const headers = toHeaders(headersLike);
  const session = await loadSession(headers, options.getSession);
  const actor = actorFromSession(session);
  if (!actor) {
    throw new AuthBoundaryError("auth_required", "Authentication is required.", 401);
  }

  const listed = normalizeOrganizations(
    options.listOrganizations
      ? await options.listOrganizations(headers)
      : await listUserOrganizations(headers),
  );
  const memberships = await organizationMembershipsFor(
    actor.actorId,
    listed.map((row) => row.id),
    options,
  );
  const readGrant = createAppGrantReader(options);
  const organizations: AuthenticatedOrganization[] = [];
  for (const organization of listed) {
    const member = memberships.get(organization.id);
    if (!member) continue;
    if (!isAppCreatedOrganizationMembership(member)) {
      organizations.push(organization);
      continue;
    }
    const choices = await Promise.all(
      organization.appIds.map(async (appId) => {
        try {
          await readGrant({ actorId: actor.actorId, appId, organizationId: organization.id }, true);
          return appId;
        } catch (error) {
          if (
            error instanceof AuthBoundaryError &&
            error.code === "app_access_required" &&
            error.status === 403
          )
            return null;
          throw error;
        }
      }),
    );
    organizations.push({ ...organization, appIds: choices.filter((appId) => appId !== null) });
  }
  const activeOrganizationId = activeOrganizationIdFromSession(session);
  return {
    actor,
    activeOrganizationId:
      activeOrganizationId && organizationListContains(organizations, activeOrganizationId)
        ? activeOrganizationId
        : null,
    organizations,
  };
}

export async function requireTenantScope(
  headersLike: HeadersLike,
  options: TenantScopeGuardOptions,
): Promise<AuthenticatedTenantScope> {
  return (await requireTenantContext(headersLike, options)).scope;
}

export type AppActorGrant = { role: string; fenceGeneration: number };
export type AppActorGrantsLoader = (input: {
  actorId: string;
  appId: AppId;
  organizationId: string;
}) => Promise<readonly AppActorGrant[]>;

/** Trusted Gateway only: verify the human/tenant, then read current app grants. */
type AppGrantAuthority = {
  roles: readonly string[];
  grants: readonly AppActorGrant[];
  appAccess?: { fenceGeneration: number };
};
type AppGrantReader = (
  scope: Parameters<AppActorGrantsLoader>[0],
  rolelessOnly?: boolean,
) => Promise<AppGrantAuthority>;

function createAppGrantReader(options: AuthGuardOptions): AppGrantReader {
  const reads = new Map<string, Promise<AppGrantAuthority>>();
  return (scope, rolelessOnly = false) => {
    const key = JSON.stringify([scope.actorId, scope.organizationId, scope.appId]);
    const scopedKey = `${key}:roleless-only`;
    let pending = reads.get(scopedKey) ?? (rolelessOnly ? undefined : reads.get(key));
    if (pending === undefined) {
      pending = readAppGrantAuthority(scope, options, rolelessOnly);
      reads.set(rolelessOnly ? scopedKey : key, pending);
    }
    return pending;
  };
}

async function readAppGrantAuthority(
  scope: Parameters<AppActorGrantsLoader>[0],
  options: AuthGuardOptions,
  rolelessOnly: boolean,
): Promise<AppGrantAuthority> {
  const grants = await (options.loadAppActorGrants ?? appActorGrants)({
    actorId: scope.actorId,
    appId: scope.appId,
    organizationId: scope.organizationId,
  });
  if (
    !Array.isArray(grants) ||
    grants.some(
      (grant) =>
        typeof grant.role !== "string" ||
        grant.role.length === 0 ||
        /[\p{Cc}]/u.test(grant.role) ||
        !Number.isSafeInteger(grant.fenceGeneration) ||
        grant.fenceGeneration < 0,
    ) ||
    new Set(grants.map((grant) => grant.role)).size !== grants.length
  )
    throw new Error("App grant readback is invalid");
  const readAccess = rolelessOnly
    ? (options.loadRolelessAppAccess ?? rolelessAppActorAccess)
    : (options.loadAppAccess ?? appActorAccess);
  const appAccess =
    grants.length === 0
      ? await readAccess({
          actorId: scope.actorId,
          appId: scope.appId,
          organizationId: scope.organizationId,
        })
      : null;
  if (
    appAccess &&
    (!Number.isSafeInteger(appAccess.fenceGeneration) || appAccess.fenceGeneration <= 0)
  )
    throw new Error("App access readback is invalid");
  if (grants.length === 0 && !appAccess)
    throw new AuthBoundaryError("app_access_required", "An active app role is required.", 403);
  return {
    roles: Object.freeze(grants.map((grant) => grant.role)),
    grants: Object.freeze(grants.map((grant) => Object.freeze({ ...grant }))),
    ...(appAccess ? { appAccess: Object.freeze(appAccess) } : {}),
  };
}

export async function requireAppGrantContext(
  headersLike: HeadersLike,
  options: TenantScopeGuardOptions,
): Promise<
  AuthenticatedAppContext & {
    grants: readonly AppActorGrant[];
    appAccess?: { fenceGeneration: number };
  }
> {
  const headers = toHeaders(headersLike);
  const readGrant = createAppGrantReader(options);
  const context = await tenantContextForSession(
    headers,
    await loadSession(headers, options.getSession),
    options,
    readGrant,
  );
  const grant = await readGrant({
    actorId: context.scope.actorId,
    appId: context.scope.appId,
    organizationId: context.scope.customerId,
  });
  return { ...context, ...grant };
}

/** Current actor/app/organization assignment read for the trusted Auth/Gateway host. */
export async function appActorGrants(input: {
  actorId: string;
  appId: AppId;
  organizationId: string;
}): Promise<readonly AppActorGrant[]> {
  const result = await withAuthDatabaseReadRetry(() =>
    getTenantPermissionDatabase().query(
      `select "role", "fence_generation"::text as generation from "app_actor_assignment"
     where "actorId"=$1 and "organizationId"=$2 and "appId"=$3 and "active"=true order by "role"`,
      [input.actorId, input.organizationId, input.appId],
    ),
  );
  return result.rows.map((row) => {
    if (
      typeof row.role !== "string" ||
      typeof row.generation !== "string" ||
      !/^[0-9]+$/u.test(row.generation) ||
      !Number.isSafeInteger(Number(row.generation))
    )
      throw new Error("App grant readback is invalid");
    return { role: row.role, fenceGeneration: Number(row.generation) };
  });
}

/**
 * The signed-in person's organizations that open `appId` for them: each
 * grants the app and holds an active app assignment for the person. Empty
 * when signed out. A person with several and no active organization (or an
 * active one that does not open the app) chooses one (Better Auth's
 * set-active); with exactly one, `requireAppContext` uses it without a choice.
 */
export async function appOrganizationChoices(
  headersLike: HeadersLike,
  options: AppContextGuardOptions,
): Promise<readonly AuthenticatedOrganization[]> {
  const headers = toHeaders(headersLike);
  const actor = actorFromSession(await loadSession(headers, options.getSession));
  return actor ? await appOrganizationsFor(headers, actor, options) : [];
}

async function appOrganizationsFor(
  headers: Headers,
  actor: AuthenticatedActor,
  options: AppContextGuardOptions,
  readGrant: AppGrantReader = createAppGrantReader(options),
): Promise<readonly AuthenticatedOrganization[]> {
  const organizations = normalizeOrganizations(
    options.listOrganizations
      ? await options.listOrganizations(headers)
      : await listUserOrganizations(headers),
  ).filter((organization) => organization.appIds.includes(options.appId));
  const memberships = await organizationMembershipsFor(
    actor.actorId,
    organizations.map((organization) => organization.id),
    options,
  );
  // One organization's failed lookup skips that organization; it does not
  // block choosing among the others.
  const assigned = await Promise.allSettled(
    organizations.map(async (organization) => {
      const member = memberships.get(organization.id);
      if (!member) return false;
      if (isAppCreatedOrganizationMembership(member)) {
        try {
          await readGrant(
            { actorId: actor.actorId, appId: options.appId, organizationId: organization.id },
            true,
          );
          return true;
        } catch (error) {
          if (
            error instanceof AuthBoundaryError &&
            error.code === "app_access_required" &&
            error.status === 403
          )
            return false;
          throw error;
        }
      }
      const roles = await (options.loadAppActorRoles ?? appActorRoles)({
        actorId: actor.actorId,
        appId: options.appId,
        organizationId: organization.id,
      });
      return (
        Array.isArray(roles) &&
        (roles.length > 0 ||
          (await (options.loadAppActorAccess ?? hasAppActorAccess)({
            actorId: actor.actorId,
            appId: options.appId,
            organizationId: organization.id,
          })))
      );
    }),
  );
  return organizations.filter((organization, index) => {
    const result = assigned[index]!;
    if (result.status === "fulfilled") return result.value;
    const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
    console.warn(
      `App assignment lookup failed for organization ${organization.id}; skipping it: ${reason}`,
    );
    return false;
  });
}

/**
 * Resolve current app assignments after verifying the human session and
 * organization. The organization is the named customer, else the session's
 * active one, else the only organization that opens the app for the person;
 * with several and none active, `tenant_required` (the person chooses). An
 * active organization that does not open the app for the person (it does not
 * grant the app, or they hold no role in it) is treated as none: the only
 * organization that does is used for this request (never persisted), several
 * ask the person to choose, and with none the refusal stays
 * `app_access_required`. A missing required role is never redirected.
 */
export async function requireAppContext(
  headersLike: HeadersLike,
  options: AppContextGuardOptions,
): Promise<AuthenticatedAppContext> {
  const headers = toHeaders(headersLike);
  const session = await loadSession(headers, options.getSession);
  const actor = actorFromSession(session);
  const readGrant = createAppGrantReader(options);
  const activeOrganizationId = activeOrganizationIdFromSession(session);
  let customerId = options.customerId;
  if (customerId === undefined && activeOrganizationId === null && actor) {
    const choices = await appOrganizationsFor(headers, actor, options, readGrant);
    if (choices.length === 1) customerId = choices[0]!.id as CustomerId;
  }
  try {
    return await appContextIn(headers, session, customerId, options, readGrant);
  } catch (error) {
    // Only the session's own active organization falls back, never a named one.
    if (
      options.customerId !== undefined ||
      customerId !== undefined ||
      activeOrganizationId === null ||
      !actor ||
      !(error instanceof AuthBoundaryError) ||
      error.code !== "app_access_required"
    )
      throw error;
    const opening = await appOrganizationsFor(headers, actor, options, readGrant);
    // The active organization opens the app: the refusal is its required role.
    if (opening.some((organization) => organization.id === activeOrganizationId)) throw error;
    if (opening.length === 1)
      return await appContextIn(headers, session, opening[0]!.id as CustomerId, options, readGrant);
    if (opening.length > 1)
      throw new AuthBoundaryError(
        "tenant_required",
        "Choose an organization that opens this app.",
        403,
      );
    throw error;
  }
}

/** The verified tenant context in `customerId` (else the active one) and its app roles. */
async function appContextIn(
  headers: Headers,
  session: unknown,
  customerId: CustomerId | undefined,
  options: AppContextGuardOptions,
  readGrant: AppGrantReader,
): Promise<AuthenticatedAppContext> {
  const context = await tenantContextForSession(
    headers,
    session,
    customerId === undefined ? options : { ...options, customerId },
    readGrant,
  );
  const roles = await (options.loadAppActorRoles ?? appActorRoles)({
    actorId: context.scope.actorId,
    appId: context.scope.appId,
    organizationId: context.scope.customerId,
  });
  if (
    !Array.isArray(roles) ||
    roles.some((role) => typeof role !== "string" || role.length === 0 || /[\p{Cc}]/u.test(role))
  ) {
    throw new Error("App role assignment response is invalid");
  }
  if (
    (roles.length === 0 &&
      !(await (options.loadAppActorAccess ?? hasAppActorAccess)({
        actorId: context.scope.actorId,
        appId: context.scope.appId,
        organizationId: context.scope.customerId,
      }))) ||
    (options.requiredRole !== undefined && !roles.includes(options.requiredRole))
  ) {
    throw new AuthBoundaryError("app_access_required", "An active app role is required.", 403);
  }
  return {
    ...context,
    roles: Object.freeze([...new Set(roles)].sort((left, right) => left.localeCompare(right))),
  };
}

export async function requireTenantContext(
  headersLike: HeadersLike,
  options: TenantScopeGuardOptions,
): Promise<AuthenticatedTenantContext> {
  const headers = toHeaders(headersLike);
  return await tenantContextForSession(
    headers,
    await loadSession(headers, options.getSession),
    options,
  );
}

async function tenantContextForSession(
  headers: Headers,
  session: unknown,
  options: TenantScopeGuardOptions,
  readGrant: AppGrantReader = createAppGrantReader(options),
): Promise<AuthenticatedTenantContext> {
  const actor = actorFromSession(session);
  if (!actor) {
    throw new AuthBoundaryError("auth_required", "Authentication is required.", 401);
  }
  const organizationId = options.customerId ?? activeOrganizationIdFromSession(session);
  if (!organizationId) {
    throw new AuthBoundaryError("tenant_required", "An active organization is required.", 403);
  }
  const isActiveMember = await verifyTenantMembership(
    headers,
    {
      actorId: actor.actorId,
      organizationId,
    },
    options.verifyTenantMembership,
  );
  if (!isActiveMember) {
    throw new AuthBoundaryError(
      "tenant_required",
      "An active organization membership is required.",
      403,
    );
  }
  const organizations = normalizeOrganizations(
    options.listOrganizations
      ? await options.listOrganizations(headers)
      : await listUserOrganizations(headers),
  );
  const activeOrganization = organizations.find(
    (organization) => organization.id === organizationId,
  );
  if (!activeOrganization?.appIds.includes(options.appId)) {
    // Shown as is (introspection, agent and canvas envelopes); the caller knows the ids.
    throw new AuthBoundaryError(
      "app_access_required",
      `Your organization doesn't have access to ${appDisplayName(options.appId)}. Ask your Autograph admin to give you access.`,
      403,
    );
  }
  const memberships = await organizationMembershipsFor(actor.actorId, [organizationId], options);
  const member = memberships.get(organizationId);
  if (!member) {
    throw new AuthBoundaryError(
      "tenant_required",
      "An active organization membership is required.",
      403,
    );
  }
  if (isAppCreatedOrganizationMembership(member)) {
    await readGrant({ actorId: actor.actorId, appId: options.appId, organizationId }, true);
  }
  return {
    actor,
    organization: activeOrganization,
    scope: {
      appId: options.appId,
      customerId: organizationId as CustomerId,
      actorId: actor.actorId,
    },
  };
}

export async function introspectTenantScope(
  headersLike: HeadersLike,
  options: TenantScopeGuardOptions & {
    loadOrganizationRole?: typeof organizationRoleForTenant;
  },
): Promise<AuthIntrospectionPayload> {
  const headers = toHeaders(headersLike);
  const scope = await requireTenantScope(headers, options);
  return {
    ...scope,
    organizationRole: await (options.loadOrganizationRole ?? organizationRoleForTenant)(
      scope.actorId,
      scope.customerId,
    ),
  };
}

async function loadSession(headers: Headers, getSession?: AuthSessionLoader): Promise<unknown> {
  try {
    return await withAuthDatabaseReadRetry(() =>
      getSession ? getSession(headers) : getAuth().api.getSession({ headers }),
    );
  } catch (error) {
    if (isAuthConfigurationError(error)) {
      throw new AuthBoundaryError("auth_not_configured", error.message, 500);
    }
    throw error;
  }
}

async function organizationMembershipsFor(
  actorId: string,
  organizationIds: readonly string[],
  options: AuthGuardOptions,
) {
  const memberships = new Map<string, Awaited<ReturnType<OrganizationMembershipLoader>>[number]>();
  if (organizationIds.length === 0) return memberships;
  const input = { actorId, organizationIds };
  const requestedOrganizationIds = new Set(organizationIds);
  const rows = await withAuthDatabaseReadRetry(() =>
    options.loadOrganizationMemberships
      ? options.loadOrganizationMemberships(input)
      : readOrganizationMemberships(getTenantPermissionDatabase(), input),
  );
  for (const row of rows) {
    if (
      row.actorId !== actorId ||
      !requestedOrganizationIds.has(row.organizationId) ||
      typeof row.id !== "string" ||
      row.id.length === 0 ||
      memberships.has(row.organizationId)
    ) {
      throw new Error("Organization membership readback is invalid");
    }
    memberships.set(row.organizationId, row);
  }
  return memberships;
}

async function verifyTenantMembership(
  headers: Headers,
  scope: { actorId: string; organizationId: string },
  verifier?: TenantMembershipVerifier,
): Promise<boolean> {
  try {
    if (verifier) {
      return await withAuthDatabaseReadRetry(() => verifier(headers, scope));
    }
    const auth = getAuth() as {
      api: {
        listOrganizations?: (input: { headers: Headers }) => Promise<unknown>;
      };
    };
    const listOrganizations = auth.api.listOrganizations;
    const organizations = listOrganizations
      ? await withAuthDatabaseReadRetry(() => listOrganizations({ headers }))
      : undefined;
    return organizationListContains(organizations, scope.organizationId);
  } catch (error) {
    if (isAuthConfigurationError(error)) {
      throw new AuthBoundaryError("auth_not_configured", error.message, 500);
    }
    throw error;
  }
}

async function listUserOrganizations(
  headers: Headers,
): Promise<readonly AuthenticatedOrganization[]> {
  try {
    const auth = getAuth() as {
      api: {
        listOrganizations?: (input: { headers: Headers }) => Promise<unknown>;
      };
    };
    const listOrganizations = auth.api.listOrganizations;
    return normalizeOrganizations(
      listOrganizations
        ? await withAuthDatabaseReadRetry(() => listOrganizations({ headers }))
        : undefined,
    );
  } catch (error) {
    if (isAuthConfigurationError(error)) {
      throw new AuthBoundaryError("auth_not_configured", error.message, 500);
    }
    throw error;
  }
}

export async function withAuthDatabaseReadRetry<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isTransientAuthDatabaseError(error)) throw error;
    return operation();
  }
}

function isTransientAuthDatabaseError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current === "object") {
      const code = "code" in current && typeof current.code === "string" ? current.code : "";
      if (["ECONNRESET", "EPIPE", "57P01", "57P02", "57P03"].includes(code)) return true;
      const message =
        "message" in current && typeof current.message === "string" ? current.message : "";
      if (/connection (?:terminated unexpectedly|reset|closed unexpectedly)/iu.test(message)) {
        return true;
      }
      current = "cause" in current ? current.cause : null;
      continue;
    }
    break;
  }
  return false;
}

export function parseOrganizationAppIds(value: unknown): readonly AppId[] | null {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const appIds: AppId[] = [];
  const seen = new Set<string>();
  for (const appId of parsed) {
    if (
      typeof appId !== "string" ||
      !/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/u.test(appId) ||
      seen.has(appId)
    ) {
      return null;
    }
    seen.add(appId);
    appIds.push(appId);
  }
  return appIds;
}

function normalizeOrganizations(organizations: unknown): readonly AuthenticatedOrganization[] {
  if (!Array.isArray(organizations)) return [];
  return organizations.flatMap((organization) => {
    if (!organization || typeof organization !== "object") return [];
    if (!("id" in organization) || typeof organization.id !== "string") return [];
    if (!("name" in organization) || typeof organization.name !== "string") return [];
    if (!("slug" in organization) || typeof organization.slug !== "string") return [];
    const appIds = "appIds" in organization ? parseOrganizationAppIds(organization.appIds) : null;
    return [
      {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        appIds: appIds ?? [],
      },
    ];
  });
}

export async function organizationRoleForTenant(
  actorId: string,
  organizationId: string,
): Promise<string | null> {
  const memberships = await withAuthDatabaseReadRetry(() =>
    getTenantPermissionDatabase().query(
      `
        select "role"
        from "member"
        where "userId" = $1 and "organizationId" = $2
        limit 1
      `,
      [actorId, organizationId],
    ),
  );
  const role = memberships.rows[0]?.role;
  return typeof role === "string" ? role : null;
}

/** Read-only authority check for the trusted Gateway, never a browser grant. */
export async function hasCurrentIntegrationActivationAuthority(input: {
  actorId: string;
  organizationId: string;
  appId: AppId;
}): Promise<boolean> {
  return withAuthDatabaseReadRetry(() =>
    readIntegrationActivationAuthority(input, async (sql, parameters) =>
      getTenantPermissionDatabase().query(sql, [...parameters]),
    ),
  );
}

/** Read an operator-installed app role only after the caller has verified tenant membership. */
export async function appActorRoles(input: {
  actorId: string;
  appId: AppId;
  organizationId: string;
}): Promise<readonly string[]> {
  const result = await withAuthDatabaseReadRetry(() =>
    getTenantPermissionDatabase().query(
      `select "role" from "app_actor_assignment"
       where "actorId" = $1 and "organizationId" = $2 and "appId" = $3
         and "active" = true order by "role"`,
      [input.actorId, input.organizationId, input.appId],
    ),
  );
  return result.rows.map((row) => row.role as string);
}

/** Role-less admission is a separate revocable fact, not an invented business role. */
export async function hasAppActorAccess(
  input: Parameters<AppActorRolesLoader>[0],
): Promise<boolean> {
  return (await appActorAccess(input)) !== null;
}

export async function appActorAccess(
  input: Parameters<AppActorRolesLoader>[0],
): Promise<{ fenceGeneration: number } | null> {
  return await readAppActorAccess(input, false);
}

async function rolelessAppActorAccess(input: Parameters<AppActorRolesLoader>[0]) {
  return await readAppActorAccess(input, true);
}

async function readAppActorAccess(
  input: Parameters<AppActorRolesLoader>[0],
  rolelessOnly: boolean,
): Promise<{ fenceGeneration: number } | null> {
  const local = readLocalAppAccessBinding();
  const raw = process.env.PLATFORM_REALM_OPERATOR_LINK_CONFIG;
  const realm =
    local ??
    (raw ? realmOperatorLinkConfigSchema.parse(JSON.parse(raw)).managedProduction : undefined);
  if (!realm) return null;
  return withAuthDatabaseReadRetry(() =>
    readManagedAppActorAccess(getTenantPermissionDatabase(), {
      ...input,
      workspaceId: realm.workspaceId,
      rolelessOnly,
    }),
  );
}

/** Any saved managed invitation keeps its app protected, including before the first grant. */
export async function isManagedApp(appId: string): Promise<boolean> {
  const local = readLocalAppAccessBinding();
  const raw = process.env.PLATFORM_REALM_OPERATOR_LINK_CONFIG;
  const realm =
    local ??
    (raw ? realmOperatorLinkConfigSchema.parse(JSON.parse(raw)).managedProduction : undefined);
  if (!realm) return false;
  return withAuthDatabaseReadRetry(() =>
    hasManagedAppRecord(getTenantPermissionDatabase(), {
      appId,
      workspaceId: realm.workspaceId,
      resourceDigest: authDatabaseResourceDigest(realm.resource),
    }),
  );
}

/** Read an operator-installed app role only after the caller has verified tenant membership. */
export async function hasAppActorAssignment(input: {
  actorId: string;
  appId: AppId;
  organizationId: string;
  role: string;
}): Promise<boolean> {
  const result = await withAuthDatabaseReadRetry(() =>
    getTenantPermissionDatabase().query(
      `select 1 from "app_actor_assignment"
       where "actorId" = $1 and "organizationId" = $2 and "appId" = $3
         and "role" = $4 and "active" = true limit 1`,
      [input.actorId, input.organizationId, input.appId, input.role],
    ),
  );
  return result.rows.length === 1;
}

/**
 * Display names of actors assigned to an app in one organization (current or
 * past assignment), for showing who authored that app's records. Ids with no
 * such assignment are omitted, so a name never crosses organizations.
 */
export async function appActorNames(input: {
  actorIds: readonly string[];
  appId: AppId;
  organizationId: string;
}): Promise<Readonly<Record<string, string>>> {
  if (input.actorIds.length === 0) return {};
  const result = await withAuthDatabaseReadRetry(() =>
    getTenantPermissionDatabase().query(
      `select u."id", u."name" from "user" u
       where u."id" = any($1::text[]) and exists (
         select 1 from "app_actor_assignment" a
         where a."actorId" = u."id" and a."organizationId" = $2 and a."appId" = $3)`,
      [[...input.actorIds], input.organizationId, input.appId],
    ),
  );
  return Object.fromEntries(
    result.rows.map((row) => [row.id as string, row.name as string] as const),
  );
}

function getTenantPermissionDatabase(): AuthDatabase {
  if (!tenantPermissionDatabase) {
    const env = readAuthEnvironment();
    tenantPermissionDatabase = createAuthPool(env.databaseUrl, env.databaseResource);
  }
  return tenantPermissionDatabase;
}

export function createAuthPool(
  connectionString: string,
  resource?: AuthDatabaseResource,
  purpose: AuthDatabasePurpose = "runtime",
): Pool {
  if (resource) assertAuthDatabaseConnection(connectionString, resource, purpose);
  const pool = new Pool({
    connectionString,
    ...(resource
      ? {
          onConnect: async (client) => {
            await verifyAuthDatabaseResource(client, resource, purpose);
          },
        }
      : {}),
  });
  pool.on("error", (error: Error & { code?: string }) => {
    const code = typeof error.code === "string" ? error.code : "unknown";
    console.error(`auth_database_idle_client_error code=${code}`);
  });
  return pool;
}

function activeOrganizationMembershipRow(
  row: Record<string, unknown> | undefined,
): ActiveOrganizationMembershipRow | null {
  return row !== undefined && typeof row.organizationId === "string"
    ? { organizationId: row.organizationId }
    : null;
}

function organizationListContains(organizations: unknown, organizationId: string): boolean {
  if (!Array.isArray(organizations)) {
    return false;
  }
  return organizations.some(
    (organization) =>
      organization &&
      typeof organization === "object" &&
      "id" in organization &&
      organization.id === organizationId,
  );
}

function isAuthConfigurationError(error: unknown): error is AuthConfigurationError {
  if (!error || typeof error !== "object") {
    return false;
  }
  return (
    "code" in error &&
    error.code === "auth_configuration_error" &&
    "message" in error &&
    typeof error.message === "string"
  );
}

function actorFromSession(session: unknown): AuthenticatedActor | null {
  if (!session || typeof session !== "object") {
    return null;
  }
  const user = "user" in session ? session.user : undefined;
  if (!user || typeof user !== "object" || !("id" in user) || typeof user.id !== "string") {
    return null;
  }
  return {
    actorId: user.id,
    email: "email" in user && typeof user.email === "string" ? user.email : null,
    name: "name" in user && typeof user.name === "string" ? user.name : null,
  };
}

function activeOrganizationIdFromSession(session: unknown): string | null {
  if (!session || typeof session !== "object" || !("session" in session)) {
    return null;
  }
  const sessionRecord = session.session;
  if (
    sessionRecord &&
    typeof sessionRecord === "object" &&
    "activeOrganizationId" in sessionRecord &&
    typeof sessionRecord.activeOrganizationId === "string" &&
    sessionRecord.activeOrganizationId.length > 0
  ) {
    return sessionRecord.activeOrganizationId;
  }
  return null;
}
