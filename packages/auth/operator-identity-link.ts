import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import {
  publicRealmEnrollmentSchema,
  publicRealmReleaseBindingSchema,
  managedProductionRealmSchema,
} from "./public-realm-enrollment";
import { readAuthDatabaseResource, type AuthDatabaseResource } from "./database-resource";
import type { RealmOperatorIdentity } from "./operator-identity";

export const AUTH_OPERATOR_LINK_PATH = "/api/auth/platform/operator-link";
export const REALM_OPERATOR_LINK_TYP = "platform-realm-operator-link+jwt";
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const origin = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
  });
export const realmBrowserSessionCorrelationSchema = z.strictObject({
  operationRef: z.uuid(),
  participantProgramDigest: digest,
});
const nativeAttester = z.strictObject({
  audience: z.string().url(),
  issuer: z.string().url(),
  ownerId: z.string().min(1),
  projectId: z.string().min(1),
});
const nativeSender = nativeAttester.extend({
  environment: z.enum(["preview", "production"]),
  subject: z.string().min(1),
});
export const realmOperatorLinkConfigSchema = z
  .strictObject({
    publicEnrollment: publicRealmEnrollmentSchema.optional(),
    managedProduction: managedProductionRealmSchema.optional(),
    browserOrigin: origin,
    builderCallbackOrigin: origin,
    builderCallbackPath: z.literal("/api/hosted-operator/realm-identity"),
    operatorOrigin: origin,
    identityHandoff: z.strictObject({ sender: nativeSender }).optional(),
    browserSessionCapture: z
      .strictObject({
        path: z.literal("/api/hosted-operator/realm-browser-session"),
        sender: nativeSender,
      })
      .optional(),
    readonlyAttesters: z
      .strictObject({
        builderProduction: nativeAttester.extend({ environment: z.literal("production") }),
        operatorPreview: nativeAttester.extend({ environment: z.literal("preview") }),
      })
      .optional(),
  })
  .superRefine((config, context) => {
    const enrollment = config.publicEnrollment ?? config.managedProduction;
    const senders = [config.identityHandoff?.sender, config.browserSessionCapture?.sender];
    const matchesProduction = (sender: (typeof senders)[number]) =>
      sender !== undefined &&
      sender.environment === "production" &&
      sender.projectId === enrollment?.project.projectId &&
      sender.ownerId === enrollment?.project.ownerId;
    const valid =
      !(config.publicEnrollment && config.managedProduction) &&
      (enrollment === undefined
        ? senders.every((sender) => sender === undefined || sender.environment === "preview")
        : config.browserOrigin === enrollment.publicOrigin &&
          (config.managedProduction !== undefined
            ? matchesProduction(senders[0]) &&
              (senders[1] === undefined || isDeepStrictEqual(senders[0], senders[1]))
            : config.readonlyAttesters !== undefined &&
              senders.every(matchesProduction) &&
              isDeepStrictEqual(senders[0], senders[1])));
    if (!valid)
      context.addIssue({
        code: "custom",
        message: "Realm enrollment and native sender must match",
      });
  });
export const realmOperatorLinkChallengeSchema = z.strictObject({
  publicRelease: publicRealmReleaseBindingSchema.optional(),
  nonce: digest,
  ownerSessionId: z.string().min(1).max(256),
  bootstrapPlanDigest: digest,
  authResourceId: z.string().min(1).max(256),
  organizationId: z.string().min(1).max(256).nullable(),
  browserSession: realmBrowserSessionCorrelationSchema.optional(),
});

/** Correlation input conveys no authorization. Only the owner callback's existing pending journal can accept this proof. */
export function issueRealmOperatorLinkProof(input: {
  identity: RealmOperatorIdentity;
  resource: AuthDatabaseResource;
  challenge: z.infer<typeof realmOperatorLinkChallengeSchema>;
  config: z.infer<typeof realmOperatorLinkConfigSchema>;
  issuer: string;
  keyId: string;
  privateKey: string;
  now?: Date;
  normalCookieSha256?: string;
}): string {
  const challenge = realmOperatorLinkChallengeSchema.parse(input.challenge);
  const config = realmOperatorLinkConfigSchema.parse(input.config);
  const issuer = origin.parse(input.issuer);
  if (config.managedProduction !== undefined) {
    const enrollment = config.managedProduction;
    if (
      challenge.publicRelease !== undefined ||
      challenge.authResourceId !== enrollment.authResourceId ||
      !isDeepStrictEqual(input.resource, enrollment.resource) ||
      issuer !== enrollment.publicOrigin ||
      (challenge.organizationId !== null &&
        !enrollment.authorizedOrganizationIds.includes(challenge.organizationId))
    )
      throw new Error("realm_link_scope_mismatch");
  }
  if (config.publicEnrollment !== undefined) {
    const enrollment = config.publicEnrollment;
    if (
      challenge.publicRelease?.enrollmentRef !== enrollment.enrollmentRef ||
      challenge.ownerSessionId !== enrollment.ownerSessionId ||
      challenge.authResourceId !== enrollment.sourceBootstrap.authResourceId ||
      !isDeepStrictEqual(input.resource, enrollment.resource) ||
      issuer !== enrollment.publicOrigin
    )
      throw new Error("realm_link_scope_mismatch");
  } else if (challenge.publicRelease !== undefined) throw new Error("realm_link_scope_mismatch");
  if (challenge.browserSession && !digest.safeParse(input.normalCookieSha256).success)
    throw new Error("realm_browser_session_binding_required");
  if (!challenge.browserSession && input.normalCookieSha256 !== undefined)
    throw new Error("realm_browser_session_binding_required");
  if (input.identity.organizationId !== challenge.organizationId)
    throw new Error("realm_link_scope_mismatch");
  const issuedAt = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const expiresAt = Math.min(
    issuedAt + 240,
    Math.floor(Date.parse(input.identity.expiresAt) / 1000),
  );
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt)
    throw new Error("realm_link_session_expired");
  const key = createPrivateKey(
    input.privateKey.includes("BEGIN PRIVATE KEY")
      ? input.privateKey.replaceAll("\\n", "\n")
      : Buffer.from(input.privateKey, "base64"),
  );
  if (key.asymmetricKeyType !== "ed25519") throw new Error("realm_link_key_invalid");
  const header = Buffer.from(
    JSON.stringify({ alg: "EdDSA", kid: input.keyId, typ: REALM_OPERATOR_LINK_TYP }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: issuer,
      aud: config.operatorOrigin,
      sub: input.identity.actorId,
      purpose: "realm-operator-link-v1",
      sessionId: input.identity.sessionId,
      organizationId: input.identity.organizationId,
      ownerSessionId: challenge.ownerSessionId,
      authResourceId: challenge.authResourceId,
      resource: input.resource,
      bootstrapPlanDigest: challenge.bootstrapPlanDigest,
      ...(challenge.publicRelease ? { publicRelease: challenge.publicRelease } : {}),
      ...(challenge.browserSession
        ? {
            browserSession: {
              ...challenge.browserSession,
              normalCookieSha256: input.normalCookieSha256,
            },
          }
        : {}),
      nonceSha256: createHash("sha256").update(challenge.nonce).digest("hex"),
      iat: issuedAt,
      exp: expiresAt,
    }),
  ).toString("base64url");
  const message = `${header}.${payload}`;
  return `${message}.${sign(null, Buffer.from(message), key).toString("base64url")}`;
}

export const realmOperatorLinkProofSchema = z.strictObject({
  iss: origin,
  aud: origin,
  sub: z.string().min(1),
  publicRelease: publicRealmReleaseBindingSchema.optional(),
  purpose: z.literal("realm-operator-link-v1"),
  ownerSessionId: z.string().min(1),
  sessionId: z.string().min(1),
  organizationId: z.string().min(1).nullable(),
  authResourceId: z.string().min(1),
  resource: z.unknown(),
  bootstrapPlanDigest: digest,
  nonceSha256: digest,
  browserSession: realmBrowserSessionCorrelationSchema
    .extend({ normalCookieSha256: digest })
    .optional(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().nonnegative(),
});
export function verifyRealmOperatorLinkProof(input: {
  proof: string;
  issuer: string;
  audience: string;
  keyId: string;
  privateKey: string;
  now?: Date;
}) {
  const key = createPrivateKey(
    input.privateKey.includes("BEGIN PRIVATE KEY")
      ? input.privateKey.replaceAll("\\n", "\n")
      : Buffer.from(input.privateKey, "base64"),
  );
  return verifyRealmOperatorLinkProofWithPublicKey({ ...input, publicKey: createPublicKey(key) });
}
export function verifyRealmOperatorLinkProofWithPublicKey(input: {
  proof: string;
  issuer: string;
  audience: string;
  keyId: string;
  publicKey: KeyObject;
  now?: Date;
}) {
  const parts = input.proof.split(".");
  if (parts.length !== 3) throw new Error("realm_link_proof_invalid");
  const [headerBytes, payloadBytes, signature] = parts;
  if (!headerBytes || !payloadBytes || !signature) throw new Error("realm_link_proof_invalid");
  const header = z
    .strictObject({
      alg: z.literal("EdDSA"),
      kid: z.literal(input.keyId),
      typ: z.literal(REALM_OPERATOR_LINK_TYP),
    })
    .parse(JSON.parse(Buffer.from(headerBytes, "base64url").toString("utf8")));
  if (
    input.publicKey.asymmetricKeyType !== "ed25519" ||
    !verify(
      null,
      Buffer.from(`${headerBytes}.${payloadBytes}`),
      input.publicKey,
      Buffer.from(signature, "base64url"),
    )
  )
    throw new Error("realm_link_proof_invalid");
  const claims = realmOperatorLinkProofSchema.parse(
    JSON.parse(Buffer.from(payloadBytes, "base64url").toString("utf8")),
  );
  const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (
    header.kid !== input.keyId ||
    claims.iss !== input.issuer ||
    claims.aud !== input.audience ||
    claims.iat > now ||
    claims.exp <= now ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > 240
  )
    throw new Error("realm_link_proof_invalid");
  return claims;
}

/** Narrow signup enrollment: reviewed link origins plus an authoritative enrolled Preview resource, never a query or boolean flag. */
export function isProtectedPreviewRealm(input: {
  environment: Readonly<Record<string, string | undefined>>;
  resource: AuthDatabaseResource | undefined;
  baseUrl: string;
}): boolean {
  const source = input.environment.PLATFORM_REALM_OPERATOR_LINK_CONFIG;
  if (source === undefined) return false;
  const config = realmOperatorLinkConfigSchema.parse(JSON.parse(source));
  const publicOrigin = new URL(input.baseUrl).origin;
  if (
    input.environment.VERCEL_ENV !== "preview" ||
    input.resource?.environment !== "preview" ||
    publicOrigin !== new URL(input.environment.PLATFORM_PUBLIC_ORIGIN ?? "").origin ||
    !input.environment.PLATFORM_GATEWAY_IDENTITY_PRIVATE_KEY ||
    !input.environment.PLATFORM_GATEWAY_IDENTITY_KEY_ID
  )
    throw new Error("realm_link_enrollment_mismatch");
  const configuredKey = input.environment.PLATFORM_GATEWAY_IDENTITY_PRIVATE_KEY;
  const key = createPrivateKey(
    configuredKey.includes("BEGIN PRIVATE KEY")
      ? configuredKey.replaceAll("\\n", "\n")
      : Buffer.from(configuredKey, "base64"),
  );
  if (key.asymmetricKeyType !== "ed25519") throw new Error("realm_link_enrollment_mismatch");
  const origins = (input.environment.PLATFORM_AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim());
  if (!origins.includes(config.browserOrigin) || !origins.includes(publicOrigin))
    throw new Error("realm_link_enrollment_mismatch");
  return true;
}

/** Public delivery is a new explicit enrollment, never a relabeled protected Preview. */
export function isEnrolledOperatorRealm(input: {
  environment: Readonly<Record<string, string | undefined>>;
  resource: AuthDatabaseResource | undefined;
  baseUrl: string;
}): boolean {
  const raw = input.environment.PLATFORM_REALM_OPERATOR_LINK_CONFIG;
  if (raw === undefined) return false;
  const config = realmOperatorLinkConfigSchema.parse(JSON.parse(raw));
  const enrollment = config.publicEnrollment ?? config.managedProduction;
  if (enrollment === undefined) return isProtectedPreviewRealm(input);
  const env = input.environment;
  const keyText = env.PLATFORM_GATEWAY_IDENTITY_PRIVATE_KEY;
  if (
    (config.managedProduction === undefined
      ? env.PLATFORM_AUTH_DEPLOYMENT_PROFILE !== "isolated-development"
      : ![undefined, "production"].includes(env.PLATFORM_AUTH_DEPLOYMENT_PROFILE)) ||
    env.VERCEL_ENV !== "production" ||
    (env.VERCEL_TARGET_ENV !== undefined && env.VERCEL_TARGET_ENV !== "production") ||
    env.VERCEL_PROJECT_ID !== enrollment.project.projectId ||
    input.baseUrl !== enrollment.publicOrigin ||
    env.PLATFORM_PUBLIC_ORIGIN !== enrollment.publicOrigin ||
    !isDeepStrictEqual(input.resource, enrollment.resource) ||
    !keyText ||
    !env.PLATFORM_GATEWAY_IDENTITY_KEY_ID
  )
    throw new Error("realm_link_enrollment_mismatch");
  const key = createPrivateKey(
    keyText.includes("BEGIN PRIVATE KEY")
      ? keyText.replaceAll("\\n", "\n")
      : Buffer.from(keyText, "base64"),
  );
  if (key.asymmetricKeyType !== "ed25519") throw new Error("realm_link_enrollment_mismatch");
  const trusted = (env.PLATFORM_AUTH_TRUSTED_ORIGINS ?? "").split(",").map((value) => value.trim());
  if (!trusted.includes(enrollment.publicOrigin)) throw new Error("realm_link_enrollment_mismatch");
  return true;
}

/** Provider request context still independently verifies the exact configured native sender. */
export function assertRealmNativeSenderEnvironment(
  config: z.infer<typeof realmOperatorLinkConfigSchema>,
  environment: Readonly<Record<string, string | undefined>>,
) {
  const expected =
    config.publicEnrollment === undefined && config.managedProduction === undefined
      ? "preview"
      : "production";
  if (
    environment.VERCEL_ENV !== expected ||
    (environment.VERCEL_TARGET_ENV && environment.VERCEL_TARGET_ENV !== expected)
  )
    throw new Error("realm_link_enrollment_mismatch");
  if (
    (config.publicEnrollment !== undefined || config.managedProduction !== undefined) &&
    !isEnrolledOperatorRealm({
      environment,
      resource: readAuthDatabaseResource(environment.AUTH_DATABASE_RESOURCE),
      baseUrl: config.browserOrigin,
    })
  )
    throw new Error("realm_link_enrollment_mismatch");
}
