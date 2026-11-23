import {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign,
  verify,
} from "node:crypto";

export const PRINCIPAL_HEADER = "x-platform-principal";
export const REQUEST_TARGET_HEADER = "x-platform-request-target";

type PrincipalTargetPathKind = "next-static" | "prefixed-next-static" | "other";
export type PrincipalTargetFailureDiagnostic = {
  targetPathnameEqual: boolean;
  targetSearchEqual: boolean;
  targetSearchWithoutDeploymentEqual: boolean;
  signedTargetHasDeploymentQuery: boolean;
  expectedTargetHasDeploymentQuery: boolean;
  signedTargetPathKind: PrincipalTargetPathKind;
  expectedTargetPathKind: PrincipalTargetPathKind;
  targetHeaderPresent: boolean;
  targetHeaderMatchesSigned: boolean;
  targetHeaderMatchesExpected: boolean;
};
type PrincipalTargetComparison = Omit<
  PrincipalTargetFailureDiagnostic,
  "targetHeaderPresent" | "targetHeaderMatchesSigned" | "targetHeaderMatchesExpected"
>;
const principalTargetFailures = new WeakMap<
  object,
  {
    comparison: PrincipalTargetComparison;
    signedTargetSha256: string;
    expectedTargetSha256: string;
  }
>();

/** Returns only bounded facts; target bytes and private comparison hashes never leave this module. */
export function principalTargetFailureDiagnostic(
  error: unknown,
  requestTargetHeader: string | null,
): PrincipalTargetFailureDiagnostic | undefined {
  try {
    if (typeof error !== "object" || error === null) return undefined;
    const failure = principalTargetFailures.get(error);
    if (!failure) return undefined;
    const targetHeaderPresent = requestTargetHeader !== null;
    const targetHeaderSha256 = targetHeaderPresent
      ? principalTargetSha256(requestTargetHeader)
      : undefined;
    return {
      ...failure.comparison,
      targetHeaderPresent,
      targetHeaderMatchesSigned: targetHeaderSha256 === failure.signedTargetSha256,
      targetHeaderMatchesExpected: targetHeaderSha256 === failure.expectedTargetSha256,
    };
  } catch {
    return undefined;
  }
}

export function normalizedPrincipalRequestTarget(pathname: string, search = ""): string {
  if (!pathname.startsWith("/") || pathname.startsWith("//") || pathname.includes("\\")) {
    throw new Error("principal request pathname is invalid");
  }
  if (search && !search.startsWith("?")) throw new Error("principal request search is invalid");
  const normalizedPathname = pathname === "/" ? pathname : pathname.replace(/\/+$/u, "");
  return `${normalizedPathname}${search}`;
}

export type AppActorGrantClaim = { role: string; fenceGeneration: number };
export type AppAccessClaim = { fenceGeneration: number };
/**
 * An MCP agent's OAuth grant (the consent id and the OAuth client): present
 * only on principals the Gateway signs for a verified bearer token on an
 * app's MCP route. Human consumers refuse such principals.
 */
export type AgentGrantClaim = { id: string; clientId: string };
/**
 * The canvas in a chat's grant (the consent id): present only on principals
 * the Gateway signs for a verified canvas bearer token on an app's canvas
 * API paths. It acts as the person; every other consumer refuses it.
 */
export type CanvasGrantClaim = { id: string };

export type GatewayPrincipal = {
  /** Signed complete entity-body binding for protected mutation ingress or API delegation. */
  bodySha256?: string;
  /** Present only after fresh trusted Auth app-assignment verification. */
  appActorGrants?: readonly AppActorGrantClaim[];
  /** Independent app admission for apps without business roles. Outer claims bind actor/app/tenant. */
  appAccess?: AppAccessClaim;
  /** Present only for a verified agent bearer token; never on a human principal. */
  agentGrant?: AgentGrantClaim;
  /** Present only for a verified canvas bearer token, on the canvas API paths. */
  canvasGrant?: CanvasGrantClaim;
  iss: string;
  aud: string;
  sub: string;
  organizationId: string;
  customerId: string;
  organizationRole: string | null;
  method: string;
  path: string;
  iat: number;
  exp: number;
  jti: string;
};

export type PrincipalSigner = {
  issue(claims: Omit<GatewayPrincipal, "iss" | "iat" | "exp">, now?: Date): string;
  publicKey: KeyObject;
};

export type PrincipalVerifier = {
  verify(
    token: string,
    expected: {
      audience: string;
      method: string;
      path: string;
      /** True only for an agent consumer, which requires `agentGrant`; humans refuse it. */
      agent?: boolean;
      /** True only for a canvas API consumer, which requires `canvasGrant`; others refuse it. */
      canvas?: boolean;
    },
    now?: Date,
  ): GatewayPrincipal;
};

export function createPrincipalSigner(options: {
  issuer: string;
  keyId: string;
  privateKey: KeyObject | string | Buffer;
  lifetimeSeconds?: number;
}): PrincipalSigner {
  const privateKey = asPrivateKey(options.privateKey);
  const publicKey = createPublicKey(privateKey.export({ format: "pem", type: "pkcs8" }));
  const lifetimeSeconds = options.lifetimeSeconds ?? 60;
  if (!Number.isSafeInteger(lifetimeSeconds) || lifetimeSeconds < 10 || lifetimeSeconds > 240) {
    throw new Error("gateway principal lifetime must be between 10 and 240 seconds");
  }
  return {
    publicKey,
    issue(claims, now = new Date()) {
      if (claims.agentGrant !== undefined && claims.canvasGrant !== undefined)
        throw new Error("gateway principal carries two grants");
      const issuedAt = Math.floor(now.getTime() / 1000);
      const header = encodeJson({ alg: "EdDSA", kid: options.keyId, typ: "JWT" });
      const payload = encodeJson({
        iss: options.issuer,
        aud: claims.aud,
        sub: claims.sub,
        organizationId: claims.organizationId,
        customerId: claims.customerId,
        organizationRole: claims.organizationRole,
        ...(claims.bodySha256 === undefined
          ? {}
          : { bodySha256: parseBodySha256(claims.bodySha256) }),
        ...(claims.appActorGrants === undefined
          ? {}
          : { appActorGrants: parseAppActorGrantClaims(claims.appActorGrants) }),
        ...(claims.appAccess === undefined
          ? {}
          : { appAccess: parseAppAccessClaim(claims.appAccess) }),
        ...(claims.agentGrant === undefined
          ? {}
          : { agentGrant: parseAgentGrantClaim(claims.agentGrant) }),
        ...(claims.canvasGrant === undefined
          ? {}
          : { canvasGrant: parseCanvasGrantClaim(claims.canvasGrant) }),
        method: claims.method.toUpperCase(),
        path: claims.path,
        iat: issuedAt,
        exp: issuedAt + lifetimeSeconds,
        jti: claims.jti,
      } satisfies GatewayPrincipal);
      const signingInput = `${header}.${payload}`;
      const signature = sign(null, Buffer.from(signingInput), privateKey).toString("base64url");
      return `${signingInput}.${signature}`;
    },
  };
}

export function createPrincipalVerifier(options: {
  issuer: string;
  keyId: string;
  publicKey: KeyObject | string | Buffer;
  clockSkewSeconds?: number;
}): PrincipalVerifier {
  const publicKey = asPublicKey(options.publicKey);
  const clockSkewSeconds = options.clockSkewSeconds ?? 5;
  return {
    verify(token, expected, now = new Date()) {
      const parts = token.split(".");
      if (parts.length !== 3) throw new Error("gateway principal must be a compact JWS");
      const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
      const header: unknown = decodeJson(encodedHeader);
      if (
        !isRecord(header) ||
        header.alg !== "EdDSA" ||
        header.typ !== "JWT" ||
        header.kid !== options.keyId
      ) {
        throw new Error("gateway principal header is invalid");
      }
      const valid = verify(
        null,
        Buffer.from(`${encodedHeader}.${encodedPayload}`),
        publicKey,
        Buffer.from(encodedSignature, "base64url"),
      );
      if (!valid) throw new Error("gateway principal signature is invalid");
      const payload = parseClaims(decodeJson(encodedPayload));
      const timestamp = Math.floor(now.getTime() / 1000);
      if (payload.iss !== options.issuer) throw new Error("gateway principal issuer is invalid");
      if (payload.aud !== expected.audience)
        throw new Error("gateway principal audience is invalid");
      if (payload.method !== expected.method.toUpperCase()) {
        throw new Error("gateway principal method binding is invalid");
      }
      if (payload.path !== expected.path) {
        const error = new Error("gateway principal path binding is invalid");
        try {
          rememberPrincipalTargetFailure(error, payload.path, expected.path);
        } catch {
          // Diagnostics cannot replace the original binding failure.
        }
        throw error;
      }
      if (payload.iat > timestamp + clockSkewSeconds)
        throw new Error("gateway principal is not active");
      if (payload.exp <= timestamp - clockSkewSeconds)
        throw new Error("gateway principal is expired");
      if (payload.exp - payload.iat > 240) throw new Error("gateway principal lifetime is invalid");
      if (expected.agent === true && expected.canvas === true)
        throw new Error("gateway principal consumer is invalid");
      if (payload.agentGrant !== undefined && payload.canvasGrant !== undefined)
        throw new Error("gateway principal carries two grants");
      if (expected.agent === true) {
        if (payload.agentGrant === undefined)
          throw new Error("gateway principal is not an agent grant");
      } else if (payload.agentGrant !== undefined) {
        // An agent token never drives a human route, page or action.
        throw new Error("gateway principal is an agent grant");
      }
      if (expected.canvas === true) {
        if (payload.canvasGrant === undefined)
          throw new Error("gateway principal is not a canvas grant");
      } else if (payload.canvasGrant !== undefined) {
        // The canvas in a chat reaches its canvas API paths only.
        throw new Error("gateway principal is a canvas grant");
      }
      return payload;
    },
  };
}

function rememberPrincipalTargetFailure(
  error: Error,
  signedTarget: string,
  expectedTarget: string,
) {
  const signed = principalTargetParts(signedTarget);
  const expected = principalTargetParts(expectedTarget);
  principalTargetFailures.set(error, {
    comparison: {
      targetPathnameEqual: signed.pathname === expected.pathname,
      targetSearchEqual: signed.search === expected.search,
      targetSearchWithoutDeploymentEqual:
        signed.searchWithoutDeployment === expected.searchWithoutDeployment,
      signedTargetHasDeploymentQuery: signed.hasDeploymentQuery,
      expectedTargetHasDeploymentQuery: expected.hasDeploymentQuery,
      signedTargetPathKind: principalTargetPathKind(signed.pathname),
      expectedTargetPathKind: principalTargetPathKind(expected.pathname),
    },
    signedTargetSha256: principalTargetSha256(signedTarget),
    expectedTargetSha256: principalTargetSha256(expectedTarget),
  });
}

function principalTargetParts(target: string) {
  const queryStart = target.indexOf("?");
  const pathname = queryStart === -1 ? target : target.slice(0, queryStart);
  const search = queryStart === -1 ? "" : target.slice(queryStart);
  const remaining: string[] = [];
  let hasDeploymentQuery = false;
  if (search) {
    for (const entry of search.slice(1).split("&")) {
      if (new URLSearchParams(`?${entry}`).has("dpl")) hasDeploymentQuery = true;
      else remaining.push(entry);
    }
  }
  return {
    pathname,
    search,
    hasDeploymentQuery,
    // Preserve the bytes and order of every remaining query entry.
    searchWithoutDeployment: hasDeploymentQuery
      ? remaining.length > 0
        ? `?${remaining.join("&")}`
        : ""
      : search,
  };
}

function principalTargetPathKind(pathname: string): PrincipalTargetPathKind {
  if (/^\/_next\/static(?:\/|$)/u.test(pathname)) return "next-static";
  if (/^\/.+\/_next\/static(?:\/|$)/u.test(pathname)) return "prefixed-next-static";
  return "other";
}

function principalTargetSha256(target: string): string {
  return createHash("sha256").update(target).digest("base64url");
}

function parseClaims(value: unknown): GatewayPrincipal {
  if (!isRecord(value)) throw new Error("gateway principal payload is invalid");
  for (const key of [
    "iss",
    "aud",
    "sub",
    "organizationId",
    "customerId",
    "method",
    "path",
    "jti",
  ] as const) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new Error(`gateway principal ${key} is invalid`);
    }
  }
  if (value.organizationRole !== null && typeof value.organizationRole !== "string") {
    throw new Error("gateway principal organizationRole is invalid");
  }
  if (!Number.isSafeInteger(value.iat) || !Number.isSafeInteger(value.exp)) {
    throw new Error("gateway principal timestamps are invalid");
  }
  if (value.bodySha256 !== undefined) value.bodySha256 = parseBodySha256(value.bodySha256);
  if (value.appActorGrants !== undefined) {
    value.appActorGrants = parseAppActorGrantClaims(value.appActorGrants);
  }
  if (value.appAccess !== undefined) value.appAccess = parseAppAccessClaim(value.appAccess);
  if (value.agentGrant !== undefined) value.agentGrant = parseAgentGrantClaim(value.agentGrant);
  if (value.canvasGrant !== undefined) value.canvasGrant = parseCanvasGrantClaim(value.canvasGrant);
  return value as GatewayPrincipal;
}

function parseCanvasGrantClaim(value: unknown): CanvasGrantClaim {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== "id") ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > 256
  )
    throw new Error("gateway canvas grant is invalid");
  return Object.freeze({ id: value.id });
}

function parseAgentGrantClaim(value: unknown): AgentGrantClaim {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== "id" && key !== "clientId") ||
    typeof value.id !== "string" ||
    typeof value.clientId !== "string" ||
    value.id.length === 0 ||
    value.id.length > 256 ||
    value.clientId.length === 0 ||
    value.clientId.length > 2048
  )
    throw new Error("gateway agent grant is invalid");
  return Object.freeze({ id: value.id, clientId: value.clientId });
}

function parseAppAccessClaim(value: unknown): AppAccessClaim {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== "fenceGeneration") ||
    !Number.isSafeInteger(value.fenceGeneration) ||
    Number(value.fenceGeneration) <= 0
  )
    throw new Error("gateway app access is invalid");
  return Object.freeze({ fenceGeneration: Number(value.fenceGeneration) });
}

function parseAppActorGrantClaims(value: unknown): readonly AppActorGrantClaim[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("gateway app grants are invalid");
  const grants = value.map((grant: unknown) => {
    if (
      !isRecord(grant) ||
      Object.keys(grant).some((key) => !["role", "fenceGeneration"].includes(key)) ||
      typeof grant.role !== "string" ||
      grant.role.length === 0 ||
      /[\p{Cc}]/u.test(grant.role) ||
      !Number.isSafeInteger(grant.fenceGeneration) ||
      Number(grant.fenceGeneration) < 0
    )
      throw new Error("gateway app grant is invalid");
    return Object.freeze({ role: grant.role, fenceGeneration: Number(grant.fenceGeneration) });
  });
  if (new Set(grants.map((grant) => grant.role)).size !== grants.length)
    throw new Error("gateway app grants contain duplicate roles");
  return Object.freeze(grants);
}

/** Call only with a public-key-verified principal, then compare its fence to current app DB authority before a mutation. */
export function requireVerifiedAppActorGrant(
  principal: GatewayPrincipal,
  input: {
    appId: string;
    actorId: string;
    organizationId: string;
    role: string;
  },
): AppActorGrantClaim {
  if (
    principal.aud !== input.appId ||
    principal.sub !== input.actorId ||
    principal.customerId !== input.organizationId ||
    principal.organizationId !== input.organizationId ||
    principal.appActorGrants === undefined
  )
    throw new Error("protected app grant is missing or mismatched");
  const grant = parseAppActorGrantClaims(principal.appActorGrants).find(
    (candidate) => candidate.role === input.role,
  );
  if (!grant) throw new Error("protected app role is not granted");
  return grant;
}

/** Explicit app admission has no business-role authority. Verify the signature before calling. */
export function requireVerifiedAppAccess(
  principal: GatewayPrincipal,
  input: { appId: string; actorId: string; organizationId: string },
): AppAccessClaim {
  if (
    principal.aud !== input.appId ||
    principal.sub !== input.actorId ||
    principal.customerId !== input.organizationId ||
    principal.organizationId !== input.organizationId ||
    principal.appAccess === undefined
  )
    throw new Error("protected app access is missing or mismatched");
  return parseAppAccessClaim(principal.appAccess);
}

export type AppActorGrantScope = {
  appId: string;
  actorId: string;
  organizationId: string;
  role: string;
};
export type CurrentAppActorBinding = AppActorGrantScope & {
  active: boolean;
  fenceGeneration: number;
};

/** The caller verifies the public signature first and supplies its own app DB binding reader inside mutation authorization. */
export async function requireCurrentVerifiedAppActorGrant(
  principal: GatewayPrincipal,
  scope: AppActorGrantScope,
  readCurrentBinding: (scope: AppActorGrantScope) => Promise<CurrentAppActorBinding | null>,
): Promise<AppActorGrantClaim> {
  const frozenScope = Object.freeze({ ...scope });
  const claim = requireVerifiedAppActorGrant(principal, frozenScope);
  const binding = await readCurrentBinding(frozenScope);
  if (
    !binding ||
    binding.active !== true ||
    binding.appId !== frozenScope.appId ||
    binding.actorId !== frozenScope.actorId ||
    binding.organizationId !== frozenScope.organizationId ||
    binding.role !== frozenScope.role ||
    !Number.isSafeInteger(binding.fenceGeneration) ||
    binding.fenceGeneration !== claim.fenceGeneration
  )
    throw new Error("protected app binding is closed or superseded");
  return claim;
}

function parseBodySha256(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(value) ||
    Buffer.from(value, "base64url").toString("base64url") !== value
  )
    throw new Error("gateway principal body digest is invalid");
  return value;
}

/** Public-key verification for a protected delegated API request; nonce consumption and current app binding remain required at mutation commit. */
export function verifyProtectedAppApiPrincipal(input: {
  verifier: PrincipalVerifier;
  token: string;
  appId: string;
  method: string;
  path: string;
  body: Uint8Array;
}): GatewayPrincipal {
  const principal = input.verifier.verify(input.token, {
    audience: input.appId,
    method: input.method,
    path: input.path,
  });
  if (
    principal.appActorGrants === undefined ||
    principal.bodySha256 !== createHash("sha256").update(input.body).digest("base64url")
  )
    throw new Error("protected delegated app principal is incomplete or rebound");
  parseAppActorGrantClaims(principal.appActorGrants);
  return principal;
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeJson(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch (error) {
    throw new Error("gateway principal contains invalid JSON", { cause: error });
  }
}

function asPrivateKey(value: KeyObject | string | Buffer): KeyObject {
  return value instanceof KeyObject ? value : createPrivateKey(value);
}

function asPublicKey(value: KeyObject | string | Buffer): KeyObject {
  return value instanceof KeyObject ? value : createPublicKey(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
