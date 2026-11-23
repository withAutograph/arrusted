import { isEnrolledOperatorRealm, isProtectedPreviewRealm } from "./operator-identity-link";
import {
  assertAuthDatabaseConnection,
  readAuthDatabaseResource,
  type AuthDatabasePurpose,
  type AuthDatabaseResource,
} from "./database-resource";
import authHostPolicy from "./auth-host-policy.json" with { type: "json" };

export const PLACEHOLDER_AUTH_DATABASE_URL = "postgres://postgres@127.0.0.1/auth";
export const PLACEHOLDER_BETTER_AUTH_URL = "http://localhost:3000";
export const PLACEHOLDER_BETTER_AUTH_SECRET = "local-apps-auth-placeholder-secret-00000000";

export const AUTH_VERCEL_PREVIEW_HOSTS = authHostPolicy.vercelPreview;
export const AUTH_PRODUCTION_HOSTS = authHostPolicy.production;
export const AUTH_LOCAL_HOSTS = authHostPolicy.local;
export const AUTH_PRODUCTION_CANDIDATE_GATEWAY_HOST = "apps-?????????-autographing.vercel.app";

export type AuthSecretVersion = {
  version: number;
  value: string;
};

export type AuthEnvironment = {
  databaseUrl: string;
  databaseResource?: AuthDatabaseResource;
  baseUrl: string;
  infrastructure?: {
    apiKey: string;
  };
  secret?: string;
  secrets?: readonly AuthSecretVersion[];
  trustedOrigins: readonly string[];
  allowedHosts: readonly string[];
  cookieDomain?: string;
  trustedClientIpHeaders?: readonly string[];
  allowPublicSignUp: boolean;
  google?: {
    clientId: string;
    clientSecret: string;
  };
  oAuthProxy?: {
    productionUrl: string;
    secret: string;
  };
  usingPlaceholderConfig: boolean;
};

export type AuthEnvironmentSource = Record<string, string | undefined>;

/** Server-only capability; ordinary sign-in does not require an email sender. */
export function passwordRecoveryEnabledForEnvironment(
  source: AuthEnvironmentSource = process.env,
): boolean {
  return Boolean(
    source.AUTH_RECOVERY_RESEND_API_KEY?.trim() &&
    source.AUTH_RECOVERY_EMAIL_FROM?.trim().match(/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u),
  );
}

export type ReadAuthEnvironmentOptions = {
  allowPlaceholderConfig?: boolean;
  databasePurpose?: AuthDatabasePurpose;
};

export class AuthConfigurationError extends Error {
  readonly code = "auth_configuration_error";
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid auth configuration: ${issues.join("; ")}`);
    this.name = "AuthConfigurationError";
    this.issues = issues;
  }
}

export function readAuthEnvironment(
  source: AuthEnvironmentSource = process.env,
  options: ReadAuthEnvironmentOptions = {},
): AuthEnvironment {
  const isolatedDevelopment = source.PLATFORM_AUTH_DEPLOYMENT_PROFILE === "isolated-development";
  const hasExplicitConfig = hasAnyAuthEnv(source);
  const usingPlaceholderConfig = Boolean(options.allowPlaceholderConfig && !hasExplicitConfig);
  const resolvedDatabase = resolveAuthDatabaseUrl(
    source,
    usingPlaceholderConfig ? PLACEHOLDER_AUTH_DATABASE_URL : "",
  );
  const databaseUrl = resolvedDatabase.value;
  const configuredBaseUrl =
    source.BETTER_AUTH_URL ?? (usingPlaceholderConfig ? PLACEHOLDER_BETTER_AUTH_URL : "");
  const currentAuthOrigin = resolveCurrentAuthOrigin(source, configuredBaseUrl);
  const baseUrl = currentAuthOrigin.value;
  const infrastructureApiKey = source.BETTER_AUTH_API_KEY?.trim();
  const secret =
    source.BETTER_AUTH_SECRET ??
    (usingPlaceholderConfig ? PLACEHOLDER_BETTER_AUTH_SECRET : undefined);
  const secrets = parseVersionedSecrets(source.BETTER_AUTH_SECRETS);
  const trustedOrigins = parseTrustedOrigins(source.PLATFORM_AUTH_TRUSTED_ORIGINS);
  const allowedHosts = allowedHostsForEnvironment(source);
  const cookieDomain = parseCookieDomain(source.PLATFORM_AUTH_COOKIE_DOMAIN);
  const trustedClientIpHeaders = isVercelEnvironment(source.VERCEL_ENV)
    ? ["x-vercel-forwarded-for"]
    : undefined;
  const allowPublicSignUp = publicSignupEnabledForEnvironment(source);
  const googleSignInEnabled = source.VERCEL_ENV !== "preview" && !isolatedDevelopment;
  const google = parseGoogleProvider(source);
  const oAuthProxy = parseOAuthProxy(source);

  const issues = [
    ...validateDeploymentProfile(source),
    ...resolvedDatabase.issues,
    ...currentAuthOrigin.issues,
    ...validateAuthUrl(baseUrl),
    ...(source.VERCEL_ENV === "production" && !isolatedDevelopment
      ? validateRequired("BETTER_AUTH_API_KEY", infrastructureApiKey ?? "")
      : []),
    ...validateCookieDomain(cookieDomain, baseUrl),
    ...validateDedicatedAuthDatabase(databaseUrl, source.VERCEL_ENV),
    ...validateAmbientPostgresOptions(source.PGOPTIONS),
    ...validateDatabaseTls(databaseUrl, source.VERCEL_ENV),
    ...validateSecrets(secret, secrets),
    ...(googleSignInEnabled ? validateGoogleProvider(google) : []),
    ...(googleSignInEnabled ? validateOAuthProxy(oAuthProxy, google, secret, secrets) : []),
  ];

  if (issues.length > 0) {
    throw new AuthConfigurationError(issues);
  }

  const databaseResource = readAuthDatabaseResource(source.AUTH_DATABASE_RESOURCE);
  if (isolatedDevelopment && !databaseResource) {
    throw new AuthConfigurationError(["Isolated-development Auth requires AUTH_DATABASE_RESOURCE"]);
  }
  if (databaseResource) {
    const environment = isolatedDevelopment
      ? "isolated-development"
      : source.VERCEL_ENV === "production" || source.VERCEL_ENV === "preview"
        ? source.VERCEL_ENV
        : "local";
    if (
      isolatedDevelopment
        ? !["preview", "isolated-development"].includes(databaseResource.environment)
        : databaseResource.environment !== environment
    )
      throw new AuthConfigurationError(["Auth database resource environment mismatch"]);
    if (
      environment === "production" &&
      source.AUTH_PRODUCTION_DATABASE_IDENTITY &&
      source.AUTH_PRODUCTION_DATABASE_IDENTITY.trim() !==
        `${databaseResource.hostname}/${databaseResource.database}`
    ) {
      throw new AuthConfigurationError([
        "Auth resource conflicts with reviewed Production database identity",
      ]);
    }
    assertAuthDatabaseConnection(
      databaseUrl,
      databaseResource,
      options.databasePurpose ?? "runtime",
    );
  }

  return {
    databaseUrl,
    ...(databaseResource ? { databaseResource } : {}),
    baseUrl,
    ...(source.VERCEL_ENV === "production" && !isolatedDevelopment && infrastructureApiKey
      ? { infrastructure: { apiKey: infrastructureApiKey } }
      : {}),
    ...(secret === undefined ? {} : { secret }),
    ...(secrets === undefined ? {} : { secrets }),
    trustedOrigins,
    allowedHosts,
    ...(cookieDomain === undefined ? {} : { cookieDomain }),
    ...(trustedClientIpHeaders === undefined ? {} : { trustedClientIpHeaders }),
    allowPublicSignUp,
    // Preview and explicit isolated-development databases do not contain
    // customer Production-linked identities. Omit the provider instead of exposing an unusable
    // sign-in path or allowing social user creation.
    ...(googleSignInEnabled && google.ready ? { google: google.ready } : {}),
    ...(googleSignInEnabled && google.ready && oAuthProxy.ready
      ? { oAuthProxy: oAuthProxy.ready }
      : {}),
    usingPlaceholderConfig,
  };
}

/** Only the exact enrolled public realm may select its isolated browser origin. */
export function enrolledPublicRealmOrigin(source: AuthEnvironmentSource): string | undefined {
  if (
    source.PLATFORM_AUTH_DEPLOYMENT_PROFILE !== "isolated-development" ||
    source.VERCEL_ENV !== "production"
  )
    return undefined;
  try {
    const baseUrl = source.BETTER_AUTH_URL;
    return baseUrl &&
      isEnrolledOperatorRealm({
        environment: source,
        resource: readAuthDatabaseResource(source.AUTH_DATABASE_RESOURCE),
        baseUrl,
      })
      ? baseUrl
      : undefined;
  } catch {
    return undefined;
  }
}

export function publicSignupEnabledForEnvironment(source: AuthEnvironmentSource): boolean {
  return source.PLATFORM_AUTH_DEPLOYMENT_PROFILE === "isolated-development"
    ? enrolledPublicRealmOrigin(source) !== undefined
    : source.VERCEL_ENV !== "production";
}

/** Resource profile never changes the provider-owned Vercel delivery environment. */
function validateDeploymentProfile(source: AuthEnvironmentSource): readonly string[] {
  const profile = source.PLATFORM_AUTH_DEPLOYMENT_PROFILE;
  if (profile === undefined || profile === "production") return [];
  if (profile !== "isolated-development")
    return ["PLATFORM_AUTH_DEPLOYMENT_PROFILE must be production or isolated-development"];
  const origin = exactConfiguredOrigin(
    source.PLATFORM_PUBLIC_ORIGIN ?? "",
    "PLATFORM_PUBLIC_ORIGIN",
  );
  const issues = [...origin.issues];
  if (origin.value && !origin.value.startsWith("https://"))
    issues.push("Isolated-development Auth requires an HTTPS public origin");
  if (source.PLATFORM_AUTH_COOKIE_DOMAIN?.trim())
    issues.push("Isolated-development Auth requires host-only cookies");
  if (
    parseTrustedOrigins(source.PLATFORM_AUTH_TRUSTED_ORIGINS).some(
      (value) => value !== origin.value,
    )
  )
    issues.push("Isolated-development Auth trusts only its exact public origin");
  return issues;
}

function allowedHostsForEnvironment(source: AuthEnvironmentSource): readonly string[] {
  if (source.PLATFORM_AUTH_DEPLOYMENT_PROFILE === "isolated-development") {
    try {
      return [new URL(source.PLATFORM_PUBLIC_ORIGIN ?? "").hostname];
    } catch {
      return [];
    }
  }
  if (source.VERCEL_ENV === "production") {
    const deploymentHost = exactProductionDeploymentHost(source.VERCEL_URL);
    if (!deploymentHost) return AUTH_PRODUCTION_HOSTS;
    return [
      ...AUTH_PRODUCTION_HOSTS,
      deploymentHost,
      ...(isExactProductionShellDeploymentHost(deploymentHost)
        ? [AUTH_PRODUCTION_CANDIDATE_GATEWAY_HOST]
        : []),
    ];
  }
  if (source.VERCEL_ENV === "preview") return AUTH_VERCEL_PREVIEW_HOSTS;
  // Private Sandbox previews, and a local runtime served through a tunnel
  // (not on Vercel), use the exact server-configured HTTPS origin. This
  // extends host routing only; sessions, assignments and database checks remain required.
  const configured = safeAuthOrigin(source.BETTER_AUTH_URL);
  const configuredHost =
    configured?.protocol === "https:" &&
    configured.origin === source.BETTER_AUTH_URL?.replace(/\/$/u, "") &&
    (/^[a-z0-9-]+\.vercel\.run$/u.test(configured.hostname) ||
      (source.VERCEL !== "1" && source.VERCEL_ENV === undefined))
      ? configured.host
      : undefined;
  return configuredHost ? [...AUTH_LOCAL_HOSTS, configuredHost] : AUTH_LOCAL_HOSTS;
}

function safeAuthOrigin(value: string | undefined): URL | undefined {
  try {
    return value ? new URL(value) : undefined;
  } catch {
    return undefined;
  }
}

function isExactProductionShellDeploymentHost(host: string): boolean {
  return /^apps-shell-[a-z0-9]{9}-autographing\.vercel\.app$/u.test(host);
}

function exactProductionDeploymentHost(value: string | undefined): string | undefined {
  const host = value?.trim().toLowerCase();
  const [projectLabel] = host?.split(".") ?? [];
  if (
    !host ||
    !projectLabel ||
    projectLabel.length > 63 ||
    !/^apps-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-autographing\.vercel\.app$/u.test(host)
  ) {
    return undefined;
  }
  return host;
}

function isVercelEnvironment(value: string | undefined): boolean {
  return value === "production" || value === "preview" || value === "development";
}

type ResolvedAuthDatabase = {
  value: string;
  issues: readonly string[];
};

function resolveAuthDatabaseUrl(
  source: AuthEnvironmentSource,
  fallback: string,
): ResolvedAuthDatabase {
  if (source.PLATFORM_AUTH_DEPLOYMENT_PROFILE === "isolated-development") {
    const configured = parseDatabaseUrl(source.PLATFORM_AUTH_DATABASE_URL);
    if (!configured) {
      return {
        value: "",
        issues: ["PLATFORM_AUTH_DATABASE_URL is required for isolated-development Auth"],
      };
    }
    const productionIdentity = source.AUTH_PRODUCTION_DATABASE_IDENTITY?.trim();
    if (
      !productionIdentity ||
      !/^[a-z0-9.-]+\.neon\.tech\/[a-zA-Z0-9_.-]+$/u.test(productionIdentity)
    ) {
      return {
        value: "",
        issues: ["AUTH_PRODUCTION_DATABASE_IDENTITY must be a Neon hostname/database pair"],
      };
    }
    if (
      normalizeNeonEndpoint(configured.hostname) ===
      normalizeNeonEndpoint(productionIdentity.slice(0, productionIdentity.indexOf("/")))
    ) {
      return {
        value: "",
        issues: ["Isolated-development Auth refuses the production Neon endpoint"],
      };
    }
    return { value: normalizeVercelDatabaseTls(configured).toString(), issues: [] };
  }
  if (source.VERCEL_ENV === "preview") {
    if (!source.VERCEL_DEPLOYMENT_ID?.trim()) {
      return {
        value: "",
        issues: ["VERCEL_DEPLOYMENT_ID is required for Vercel preview auth"],
      };
    }
    let protectedRealm: boolean;
    try {
      protectedRealm = isProtectedPreviewRealm({
        environment: source,
        resource: readAuthDatabaseResource(source.AUTH_DATABASE_RESOURCE),
        baseUrl: source.BETTER_AUTH_URL ?? "",
      });
    } catch {
      return { value: "", issues: ["Protected Preview Realm enrollment configuration is invalid"] };
    }
    const previewUrl = parseDatabaseUrl(
      protectedRealm ? source.PLATFORM_AUTH_DATABASE_URL : source.DATABASE_URL_UNPOOLED,
    );
    if (!previewUrl) {
      return {
        value: "",
        issues: [
          protectedRealm
            ? "PLATFORM_AUTH_DATABASE_URL is required for protected Preview Auth"
            : "DATABASE_URL_UNPOOLED is required for Vercel preview auth",
        ],
      };
    }
    if (!previewUrl.hostname.endsWith(".neon.tech")) {
      return {
        value: "",
        issues: ["Vercel preview auth requires DATABASE_URL_UNPOOLED from Neon"],
      };
    }
    const productionIdentity = source.AUTH_PRODUCTION_DATABASE_IDENTITY?.trim();
    if (
      !productionIdentity ||
      !/^[a-z0-9.-]+\.neon\.tech\/[a-zA-Z0-9_.-]+$/u.test(productionIdentity)
    ) {
      return {
        value: "",
        issues: ["AUTH_PRODUCTION_DATABASE_IDENTITY must be a Neon hostname/database pair"],
      };
    }
    if (
      normalizeNeonEndpoint(previewUrl.hostname) ===
      normalizeNeonEndpoint(productionIdentity.slice(0, productionIdentity.indexOf("/")))
    ) {
      return {
        value: "",
        issues: ["Vercel preview auth refuses the production Neon endpoint"],
      };
    }
    const boundAuthUrl = source.PLATFORM_AUTH_DATABASE_URL
      ? parseDatabaseUrl(source.PLATFORM_AUTH_DATABASE_URL)
      : previewUrl;
    if (
      !boundAuthUrl ||
      normalizeNeonEndpoint(boundAuthUrl.hostname) !== normalizeNeonEndpoint(previewUrl.hostname)
    ) {
      return {
        value: "",
        issues: ["PLATFORM_AUTH_DATABASE_URL must use the isolated native Preview Neon endpoint"],
      };
    }
    return {
      value: normalizeVercelDatabaseTls(boundAuthUrl).toString(),
      issues: [],
    };
  }
  if (source.VERCEL_ENV === "production") {
    const configured = parseDatabaseUrl(source.PLATFORM_AUTH_DATABASE_URL);
    const value = configured
      ? normalizeVercelDatabaseTls(configured).toString()
      : (source.PLATFORM_AUTH_DATABASE_URL ?? "");
    return {
      value,
      issues: validateRequired("PLATFORM_AUTH_DATABASE_URL", value),
    };
  }

  const value = source.PLATFORM_AUTH_DATABASE_URL ?? fallback;
  return {
    value,
    issues: validateRequired("PLATFORM_AUTH_DATABASE_URL", value),
  };
}

function parseDatabaseUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return isPostgresDatabaseUrl(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isPostgresDatabaseUrl(parsed: URL): boolean {
  if (!isPostgresProtocol(parsed) || parsed.pathname.length <= 1) {
    return false;
  }
  return Boolean(parsed.hostname) || isUnixSocketConnection(parsed);
}

function isPostgresProtocol(parsed: URL): boolean {
  return ["postgres:", "postgresql:"].includes(parsed.protocol);
}

function isUnixSocketConnection(parsed: URL): boolean {
  const socketDirectory = parsed.searchParams.get("host");
  return socketDirectory?.startsWith("/") ?? false;
}

function validateDatabaseTls(databaseUrl: string, vercelEnvironment: string | undefined): string[] {
  if (vercelEnvironment !== "preview" && vercelEnvironment !== "production") return [];
  const parsed = parseDatabaseUrl(databaseUrl);
  if (!parsed) return [];
  const sslModes = parsed.searchParams.getAll("sslmode");
  return sslModes.length === 1 && sslModes[0] === "verify-full"
    ? []
    : ["Vercel auth database connections require sslmode=verify-full"];
}

function normalizeNeonEndpoint(hostname: string): string {
  return hostname.replace(/-pooler(?=\.)/u, "").toLowerCase();
}

function normalizeVercelDatabaseTls(url: URL): URL {
  const normalized = new URL(url);
  const sslModes = normalized.searchParams.getAll("sslmode");
  if (
    normalized.hostname.endsWith(".neon.tech") &&
    sslModes.length === 1 &&
    sslModes[0] === "require"
  ) {
    // Neon's native Vercel binding emits sslmode=require. pg 8 currently treats
    // that as verify-full, but normalizing it explicitly preserves hostname
    // verification when pg 9 adopts libpq's weaker `require` semantics.
    normalized.searchParams.set("sslmode", "verify-full");
  }
  return normalized;
}

function parseCookieDomain(value: string | undefined): string | undefined {
  const domain = value?.trim();
  return domain ? domain.toLowerCase() : undefined;
}

function validateCookieDomain(domain: string | undefined, baseUrl: string): readonly string[] {
  if (!domain) {
    return [];
  }
  if (!domain.startsWith(".")) {
    return ["PLATFORM_AUTH_COOKIE_DOMAIN must be a parent domain beginning with `.`"];
  }
  if (domain.includes("/") || domain.includes(":") || domain.includes(",")) {
    return ["PLATFORM_AUTH_COOKIE_DOMAIN must be a domain, not a URL"];
  }
  const cookieRoot = domain.slice(1);
  if (!cookieRoot || cookieRoot === "localhost") {
    return ["PLATFORM_AUTH_COOKIE_DOMAIN must be a registrable parent domain"];
  }
  if (!baseUrl) {
    return [];
  }
  try {
    const baseHost = new URL(baseUrl).hostname.toLowerCase();
    return baseHost === cookieRoot || baseHost.endsWith(domain)
      ? []
      : ["PLATFORM_AUTH_COOKIE_DOMAIN must contain BETTER_AUTH_URL's host"];
  } catch {
    return [];
  }
}

export function hasAnyAuthEnv(source: AuthEnvironmentSource): boolean {
  return Boolean(
    source.PLATFORM_AUTH_DEPLOYMENT_PROFILE ||
    source.AUTH_DATABASE_RESOURCE !== undefined ||
    source.PLATFORM_AUTH_DATABASE_URL ||
    source.DATABASE_URL ||
    source.DATABASE_URL_UNPOOLED ||
    source.BETTER_AUTH_URL ||
    source.BETTER_AUTH_SECRET ||
    source.BETTER_AUTH_SECRETS ||
    source.GOOGLE_CLIENT_ID ||
    source.GOOGLE_CLIENT_SECRET ||
    source.OAUTH_PROXY_PRODUCTION_URL ||
    source.OAUTH_PROXY_SECRET,
  );
}

/** Presentation-only origin resolution; optional Auth links never require database credentials. */
export function authUiOriginForEnvironment(
  source: AuthEnvironmentSource = process.env,
): string | undefined {
  const resolved = resolveCurrentAuthOrigin(source, source.BETTER_AUTH_URL ?? "");
  if (resolved.issues.length > 0) return undefined;
  const exact = exactConfiguredOrigin(resolved.value, "BETTER_AUTH_URL");
  return exact.issues.length === 0 ? exact.value : undefined;
}

type ResolvedCurrentAuthOrigin = {
  value: string;
  issues: readonly string[];
};

function resolveCurrentAuthOrigin(
  source: AuthEnvironmentSource,
  configuredBaseUrl: string,
): ResolvedCurrentAuthOrigin {
  const publicOrigin = source.PLATFORM_PUBLIC_ORIGIN?.trim();
  if (publicOrigin) {
    const configuredOrigin = exactConfiguredOrigin(configuredBaseUrl, "BETTER_AUTH_URL");
    const resolvedPublicOrigin = exactConfiguredOrigin(publicOrigin, "PLATFORM_PUBLIC_ORIGIN");
    const issues = [...configuredOrigin.issues, ...resolvedPublicOrigin.issues];
    if (issues.length === 0 && configuredOrigin.value !== resolvedPublicOrigin.value) {
      issues.push("BETTER_AUTH_URL must equal PLATFORM_PUBLIC_ORIGIN for route-owned auth");
    }
    if (
      issues.length === 0 &&
      (source.VERCEL_ENV === "preview" || source.VERCEL_ENV === "production") &&
      new URL(configuredOrigin.value).protocol !== "https:"
    ) {
      issues.push("Route-owned Vercel auth origins must use HTTPS");
    }
    return { value: issues.length === 0 ? configuredOrigin.value : "", issues };
  }

  if (source.VERCEL_ENV !== "preview") {
    return {
      value: configuredBaseUrl,
      issues: validateRequired("BETTER_AUTH_URL", configuredBaseUrl),
    };
  }

  const vercelUrl = source.VERCEL_URL?.trim();
  if (!vercelUrl) {
    return {
      value: "",
      issues: ["VERCEL_URL is required for Vercel preview auth"],
    };
  }
  try {
    const parsed = new URL(vercelUrl.startsWith("https://") ? vercelUrl : `https://${vercelUrl}`);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return {
        value: "",
        issues: [
          "VERCEL_URL must identify an HTTPS deployment origin without credentials, path, query, or fragment",
        ],
      };
    }
    if (!AUTH_VERCEL_PREVIEW_HOSTS.some((pattern) => hostMatches(pattern, parsed.hostname))) {
      return {
        value: "",
        issues: ["VERCEL_URL must match an allowed Vercel preview host"],
      };
    }
    return { value: parsed.origin, issues: [] };
  } catch {
    return {
      value: "",
      issues: ["VERCEL_URL must be a valid Vercel deployment host"],
    };
  }
}

function exactConfiguredOrigin(value: string, name: string): ResolvedCurrentAuthOrigin {
  if (!value) return { value: "", issues: [`${name} is required for route-owned auth`] };
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return {
        value: "",
        issues: [`${name} must be an exact HTTP or HTTPS origin for route-owned auth`],
      };
    }
    return { value: parsed.origin, issues: [] };
  } catch {
    return {
      value: "",
      issues: [`${name} must be a valid origin for route-owned auth`],
    };
  }
}

export function hostMatches(pattern: string, host: string): boolean {
  const wildcardIndex = pattern.indexOf("*");
  if (wildcardIndex === -1) return host === pattern;
  if (pattern.indexOf("*", wildcardIndex + 1) !== -1) return false;
  const prefix = pattern.slice(0, wildcardIndex);
  const suffix = pattern.slice(wildcardIndex + 1);
  return (
    host.startsWith(prefix) && host.endsWith(suffix) && host.length > prefix.length + suffix.length
  );
}

export function parseTrustedOrigins(value: string | undefined): readonly string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export function parseVersionedSecrets(
  value: string | undefined,
): readonly AuthSecretVersion[] | undefined {
  if (!value) {
    return undefined;
  }
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const separatorIndex = entry.indexOf(":");
      if (separatorIndex <= 0) {
        return { version: Number.NaN, value: "" };
      }
      return {
        version: Number(entry.slice(0, separatorIndex)),
        value: entry.slice(separatorIndex + 1),
      };
    });
  return entries;
}

function validateRequired(name: string, value: string): readonly string[] {
  return value ? [] : [`${name} is required`];
}

function validateAuthUrl(value: string): readonly string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return ["BETTER_AUTH_URL must use http or https"];
    }
    return [];
  } catch {
    return ["BETTER_AUTH_URL must be a valid URL"];
  }
}

function validateDedicatedAuthDatabase(
  databaseUrl: string,
  vercelEnvironment: string | undefined,
): readonly string[] {
  if (!databaseUrl) {
    return [];
  }
  const databaseVariable =
    vercelEnvironment === "preview"
      ? "DATABASE_URL_UNPOOLED"
      : vercelEnvironment === "production"
        ? "PLATFORM_AUTH_DATABASE_URL"
        : "Auth database URL";
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return [`${databaseVariable} must be a valid PostgreSQL URL`];
  }
  if (!isPostgresProtocol(parsed) || (!parsed.hostname && !isUnixSocketConnection(parsed))) {
    return [`${databaseVariable} must be a valid PostgreSQL URL`];
  }
  for (const [key, value] of parsed.searchParams) {
    if (
      key.toLowerCase() === "search_path" ||
      (key.toLowerCase() === "options" && /search_path/iu.test(value))
    ) {
      return [`${databaseVariable} must not override PostgreSQL search_path`];
    }
  }
  const isVercel = vercelEnvironment === "preview" || vercelEnvironment === "production";
  if (isVercel && !parsed.hostname.endsWith(".neon.tech")) {
    return ["Vercel auth database connections must come from Neon"];
  }
  let database = "";
  let role = "";
  try {
    database = decodeURIComponent(parsed.pathname.slice(1));
    role = decodeURIComponent(parsed.username);
  } catch {
    return ["Vercel auth database connections must name a database and role"];
  }
  if (isVercel && (!/^[a-zA-Z0-9_.-]+$/u.test(database) || !/^[a-zA-Z0-9_.-]+$/u.test(role))) {
    return ["Vercel auth database connections must name a database and role"];
  }
  if (isVercel) {
    const allowedParameters = new Set(["channel_binding", "sslmode"]);
    if ([...parsed.searchParams.keys()].some((key) => !allowedParameters.has(key))) {
      return ["Vercel auth database URL query parameters may only be sslmode and channel_binding"];
    }
    const channelBindings = parsed.searchParams.getAll("channel_binding");
    if (
      channelBindings.length > 1 ||
      (channelBindings.length === 1 && channelBindings[0] !== "require")
    ) {
      return ["Vercel auth database channel_binding must be require when present"];
    }
  }
  return [];
}

function validateAmbientPostgresOptions(options: string | undefined): readonly string[] {
  return /search_path/iu.test(options ?? "")
    ? ["PGOPTIONS must not override PostgreSQL search_path for Auth"]
    : [];
}

function validateSecrets(
  secret: string | undefined,
  secrets: readonly AuthSecretVersion[] | undefined,
): readonly string[] {
  if (!secret && (!secrets || secrets.length === 0)) {
    return ["BETTER_AUTH_SECRET or BETTER_AUTH_SECRETS is required"];
  }
  const issues: string[] = [];
  if (secret && secret.length < 32) {
    issues.push("BETTER_AUTH_SECRET must be at least 32 characters");
  }
  for (const entry of secrets ?? []) {
    if (!Number.isInteger(entry.version) || entry.version <= 0) {
      issues.push("BETTER_AUTH_SECRETS entries must use positive integer versions");
    }
    if (entry.value.length < 32) {
      issues.push("BETTER_AUTH_SECRETS values must be at least 32 characters");
    }
  }
  return issues;
}

type ParsedGoogleProvider =
  | { ready: { clientId: string; clientSecret: string } }
  | { ready?: undefined; missing: "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET" }
  | { ready?: undefined; missing?: undefined };

function parseGoogleProvider(source: AuthEnvironmentSource): ParsedGoogleProvider {
  const clientId = source.GOOGLE_CLIENT_ID;
  const clientSecret = source.GOOGLE_CLIENT_SECRET;

  if (!clientId && !clientSecret) {
    return {};
  }
  if (!clientId) {
    return { missing: "GOOGLE_CLIENT_ID" };
  }
  if (!clientSecret) {
    return { missing: "GOOGLE_CLIENT_SECRET" };
  }
  return { ready: { clientId, clientSecret } };
}

function validateGoogleProvider(provider: ParsedGoogleProvider): readonly string[] {
  return "missing" in provider && provider.missing
    ? [`${provider.missing} is required when configuring Google auth`]
    : [];
}

type ParsedOAuthProxy =
  | { ready: { productionUrl: string; secret: string } }
  | {
      ready?: undefined;
      productionUrl?: string;
      secret?: string;
    };

function parseOAuthProxy(source: AuthEnvironmentSource): ParsedOAuthProxy {
  const productionUrl = source.OAUTH_PROXY_PRODUCTION_URL?.trim();
  const secret = source.OAUTH_PROXY_SECRET?.trim();
  return productionUrl && secret
    ? { ready: { productionUrl, secret } }
    : {
        ...(productionUrl === undefined ? {} : { productionUrl }),
        ...(secret === undefined ? {} : { secret }),
      };
}

function validateOAuthProxy(
  proxy: ParsedOAuthProxy,
  google: ParsedGoogleProvider,
  authSecret: string | undefined,
  authSecrets: readonly AuthSecretVersion[] | undefined,
): readonly string[] {
  if (!google.ready) {
    return [];
  }

  const issues: string[] = [];
  const productionUrl = proxy.ready
    ? proxy.ready.productionUrl
    : "productionUrl" in proxy
      ? proxy.productionUrl
      : undefined;
  const proxySecret = proxy.ready
    ? proxy.ready.secret
    : "secret" in proxy
      ? proxy.secret
      : undefined;
  if (!productionUrl) {
    issues.push("OAUTH_PROXY_PRODUCTION_URL is required when configuring Google auth");
  } else {
    try {
      const parsed = new URL(productionUrl);
      if (parsed.protocol !== "https:") {
        issues.push("OAUTH_PROXY_PRODUCTION_URL must use https");
      }
      if (parsed.origin !== "https://apps.autograph.so") {
        issues.push("OAUTH_PROXY_PRODUCTION_URL must be https://apps.autograph.so");
      }
      if (
        parsed.username ||
        parsed.password ||
        parsed.pathname !== "/" ||
        parsed.search ||
        parsed.hash
      ) {
        issues.push(
          "OAUTH_PROXY_PRODUCTION_URL must be an origin without credentials, path, query, or fragment",
        );
      }
    } catch {
      issues.push("OAUTH_PROXY_PRODUCTION_URL must be a valid URL");
    }
  }
  if (!proxySecret) {
    issues.push("OAUTH_PROXY_SECRET is required when configuring Google auth");
  } else {
    if (proxySecret.length < 32) {
      issues.push("OAUTH_PROXY_SECRET must be at least 32 characters");
    }
    if (proxySecret === authSecret || authSecrets?.some((entry) => entry.value === proxySecret)) {
      issues.push("OAUTH_PROXY_SECRET must not reuse Better Auth secret material");
    }
  }
  return issues;
}
