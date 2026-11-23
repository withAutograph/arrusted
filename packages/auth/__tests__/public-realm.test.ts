import { generateKeyPairSync } from "node:crypto";
import type { verifyVercelOidcToken } from "@vercel/oidc";
import { describe, expect, it, vi } from "vitest";
import {
  issueRealmOperatorLinkProof,
  verifyRealmOperatorLinkProof,
  isEnrolledOperatorRealm,
  realmOperatorLinkConfigSchema,
} from "../operator-identity-link";
import { handoffRealmOperatorIdentityLink } from "../operator-identity-handoff";
import { captureOperatorNormalBrowserSession } from "../operator-browser-session";
import { publicSignupEnabledForEnvironment, readAuthEnvironment } from "../env";
import { produceRealmOperatorIdentityLink } from "../server";
import { createAuthRouteHandlers } from "../next";
import { currentAppSignupIntent } from "../signup-policy";
import {
  completeManagedAppInvitation,
  completeManagedAppSignup,
} from "../managed-app-access-callback";

const pair = generateKeyPairSync("ed25519");
const key = pair.privateKey.export({ type: "pkcs8", format: "pem" });
const resource = {
  version: 1 as const,
  environment: "preview" as const,
  hostname: "ep-isolated.neon.tech",
  port: 5432 as const,
  database: "auth_owned",
  schema: "public" as const,
  runtimeRole: "auth_runtime",
  migratorRole: "auth_migrator",
  neon: { projectId: "neon-owned", branchId: "br-owned" },
};
const publicRelease = {
  enrollmentRef: "11111111-1111-4111-a111-111111111111",
  operationRef: "22222222-2222-4222-a222-222222222222",
  planDigest: "c".repeat(64),
};
const enrollment = {
  version: 1 as const,
  kind: "public-isolated-realm-v1" as const,
  enrollmentRef: publicRelease.enrollmentRef,
  appId: "invoice-app",
  ownerSessionId: "builder-session",
  authority: {
    issuer: "https://builder.example/api/auth",
    audience: "https://builder.example/mcp",
    workspaceId: "workspace",
    ownerUserId: "owner",
  },
  publicOrigin: "https://app.example",
  project: { projectId: "prj_app", ownerId: "team_owned", environment: "production" as const },
  sourceBootstrap: {
    operationRef: "33333333-3333-4333-a333-333333333333",
    planDigest: "b".repeat(64),
    authResourceId: "auth-owned",
  },
  resource,
};
const sender = {
  issuer: "https://oidc.vercel.com/owned",
  audience: "https://vercel.com/owned",
  projectId: "prj_app",
  ownerId: "team_owned",
  environment: "production" as const,
  subject: "owner:owned:project:app:environment:production",
};
const { subject: _subject, ...attester } = sender;
const config = {
  publicEnrollment: enrollment,
  browserOrigin: enrollment.publicOrigin,
  builderCallbackOrigin: "https://builder.example",
  builderCallbackPath: "/api/hosted-operator/realm-identity" as const,
  operatorOrigin: "https://operator.example",
  identityHandoff: { sender },
  browserSessionCapture: { path: "/api/hosted-operator/realm-browser-session" as const, sender },
  readonlyAttesters: {
    builderProduction: attester,
    operatorPreview: { ...attester, projectId: "prj_operator", environment: "preview" as const },
  },
};
const environment = {
  VERCEL: "1",
  VERCEL_ENV: "production",
  VERCEL_PROJECT_ID: sender.projectId,
  PLATFORM_AUTH_DEPLOYMENT_PROFILE: "isolated-development",
  PLATFORM_PUBLIC_ORIGIN: enrollment.publicOrigin,
  PLATFORM_AUTH_TRUSTED_ORIGINS: enrollment.publicOrigin,
  PLATFORM_GATEWAY_IDENTITY_PRIVATE_KEY: key,
  PLATFORM_GATEWAY_IDENTITY_KEY_ID: "public-key",
  AUTH_DATABASE_RESOURCE: JSON.stringify(resource),
  PLATFORM_REALM_OPERATOR_LINK_CONFIG: JSON.stringify(config),
  PLATFORM_AUTH_DATABASE_URL:
    "postgres://auth_runtime:synthetic@ep-isolated.neon.tech/auth_owned?sslmode=verify-full",
  AUTH_PRODUCTION_DATABASE_IDENTITY: "ep-customer.neon.tech/auth_customer",
  BETTER_AUTH_URL: enrollment.publicOrigin,
  BETTER_AUTH_SECRET: "synthetic-new-public-app-auth-secret-1234567890",
};
const challenge = {
  publicRelease,
  nonce: "a".repeat(64),
  ownerSessionId: enrollment.ownerSessionId,
  bootstrapPlanDigest: "d".repeat(64),
  authResourceId: "auth-owned",
  organizationId: null,
};

describe("managed existing Production realm", () => {
  const managedResource = { ...resource, environment: "production" as const };
  const managedConfig = {
    ...config,
    publicEnrollment: undefined,
    browserSessionCapture: undefined,
    readonlyAttesters: undefined,
    managedProduction: {
      version: 1 as const,
      kind: "managed-production-realm-v1" as const,
      workspaceId: "workspace",
      repositoryId: "123",
      repositoryFullName: "owner/repo",
      authResourceId: "auth-owned",
      authorizedOrganizationIds: ["dev"],
      publicOrigin: enrollment.publicOrigin,
      project: enrollment.project,
      resource: managedResource,
    },
  };
  const managedEnvironment = {
    ...environment,
    BETTER_AUTH_API_KEY: "synthetic-infrastructure-key",
    AUTH_PRODUCTION_DATABASE_IDENTITY: `${managedResource.hostname}/${managedResource.database}`,
    PLATFORM_AUTH_DEPLOYMENT_PROFILE: "production",
    AUTH_DATABASE_RESOURCE: JSON.stringify(managedResource),
    PLATFORM_REALM_OPERATOR_LINK_CONFIG: JSON.stringify(managedConfig),
  };
  it("preserves legacy enrolled signup and its reviewed callback on a Production origin", async () => {
    try {
      for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value);
      vi.stubEnv("AUTH_RECOVERY_RESEND_API_KEY", undefined);
      vi.stubEnv("AUTH_RECOVERY_EMAIL_FROM", undefined);
      const handler = vi.fn(async () => Response.json({ appUrl: currentAppSignupIntent() }));
      const routes = createAuthRouteHandlers(
        { handler, options: { baseURL: enrollment.publicOrigin } },
        { canvasFrameOrigins: [] },
      );
      const callbackURL = `${enrollment.publicOrigin}/apps/legacy-fixture`;
      const response = await routes.POST(
        new Request(`${enrollment.publicOrigin}/api/auth/sign-up/email`, {
          method: "POST",
          headers: { origin: enrollment.publicOrigin, "content-type": "application/json" },
          body: JSON.stringify({
            email: "legacy@example.test",
            password: "fixture-password",
            callbackURL,
          }),
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ appUrl: callbackURL });
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps managed Production signup closed when its sender is unavailable", async () => {
    try {
      for (const [name, value] of Object.entries(managedEnvironment)) vi.stubEnv(name, value);
      vi.stubEnv("AUTH_RECOVERY_RESEND_API_KEY", undefined);
      vi.stubEnv("AUTH_RECOVERY_EMAIL_FROM", undefined);
      const handler = vi.fn(async () => Response.json({ unexpected: true }));
      const routes = createAuthRouteHandlers(
        { handler, options: { baseURL: enrollment.publicOrigin } },
        { canvasFrameOrigins: [] },
      );
      const response = await routes.POST(
        new Request(`${enrollment.publicOrigin}/api/auth/sign-up/email`, {
          method: "POST",
          headers: { origin: enrollment.publicOrigin, "content-type": "application/json" },
          body: JSON.stringify({ callbackURL: `${enrollment.publicOrigin}/apps/fixture` }),
        }),
      );
      expect(response.status).toBe(403);
      expect(handler).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("retains the Production resource and keeps generic password signup closed", () => {
    expect(
      isEnrolledOperatorRealm({
        environment: managedEnvironment,
        resource: managedResource,
        baseUrl: enrollment.publicOrigin,
      }),
    ).toBe(true);
    expect(publicSignupEnabledForEnvironment(managedEnvironment)).toBe(false);
    expect(() =>
      isEnrolledOperatorRealm({
        environment: { ...managedEnvironment, VERCEL_PROJECT_ID: "other" },
        resource: managedResource,
        baseUrl: enrollment.publicOrigin,
      }),
    ).toThrow();
    expect(() =>
      isEnrolledOperatorRealm({
        environment: managedEnvironment,
        resource,
        baseUrl: enrollment.publicOrigin,
      }),
    ).toThrow();
  });
  it("needs no Preview capture or attesters but keeps the Production sender bound", () => {
    expect(realmOperatorLinkConfigSchema.parse(managedConfig)).toMatchObject({
      identityHandoff: { sender },
    });
    for (const identityHandoff of [
      undefined,
      { sender: { ...sender, projectId: "other" } },
      { sender: { ...sender, ownerId: "other" } },
      { sender: { ...sender, environment: "preview" } },
    ]) {
      expect(() =>
        realmOperatorLinkConfigSchema.parse({ ...managedConfig, identityHandoff }),
      ).toThrow();
    }
    expect(() =>
      realmOperatorLinkConfigSchema.parse({
        ...managedConfig,
        browserSessionCapture: {
          ...config.browserSessionCapture,
          sender: { ...sender, projectId: "other" },
        },
      }),
    ).toThrow();
    expect(() =>
      realmOperatorLinkConfigSchema.parse({ ...config, readonlyAttesters: undefined }),
    ).toThrow();
    expect(() =>
      realmOperatorLinkConfigSchema.parse({ ...config, browserSessionCapture: undefined }),
    ).toThrow();
  });
  it("uses only native workload authority to finish the saved invitation", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ version: 1, status: "ready" }));
    await expect(
      completeManagedAppInvitation(
        {
          config: managedConfig,
          environment: managedEnvironment,
          invitationId: "66666666-6666-4666-a666-666666666666",
        },
        {
          context: () => ({ headers: { "x-vercel-oidc-token": "native.provider.token" } }),
          verifyToken: async () =>
            ({
              payload: {
                iss: sender.issuer,
                aud: sender.audience,
                sub: sender.subject,
                owner_id: sender.ownerId,
                project_id: sender.projectId,
                environment: sender.environment,
              },
            }) as never,
          fetch: fetcher,
        },
      ),
    ).resolves.toBe("ready");
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "https://operator.example/v1/repository-production/access/complete",
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      version: 1,
      invitationId: "66666666-6666-4666-a666-666666666666",
    });
  });
  it("sends only signup claim references through the same authenticated workload callback", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ version: 1, status: "pending" }));
    const request = {
      config: managedConfig,
      environment: managedEnvironment,
      policyId: "66666666-6666-4666-a666-666666666666",
      claimId: "77777777-7777-4777-a777-777777777777",
    };
    const verified = {
      protectedHeader: { alg: "RS256" },
      payload: {
        iss: sender.issuer,
        aud: sender.audience,
        sub: sender.subject,
        owner_id: sender.ownerId,
        project_id: sender.projectId,
        environment: sender.environment,
      },
    };
    const verifyToken = vi.fn<typeof verifyVercelOidcToken>().mockResolvedValue(verified);
    const io = {
      context: () => ({ headers: { "x-vercel-oidc-token": "native.provider.token" } }),
      verifyToken,
      fetch: fetcher,
    } satisfies NonNullable<Parameters<typeof completeManagedAppSignup>[1]>;
    expect(await completeManagedAppSignup(request, io)).toBe("pending");
    const destination = fetcher.mock.calls[0]?.[0];
    expect(destination instanceof URL ? destination.href : destination).toBe(
      "https://operator.example/v1/repository-production/access/complete",
    );
    const body = fetcher.mock.calls[0]?.[1]?.body;
    expect(typeof body === "string" && JSON.parse(body)).toEqual({
      version: 1,
      kind: "signup",
      policyId: request.policyId,
      claimId: request.claimId,
    });
    fetcher.mockClear();
    verifyToken.mockResolvedValue({
      ...verified,
      payload: { ...verified.payload, project_id: "wrong-project" },
    });
    await expect(completeManagedAppSignup(request, io)).rejects.toThrow(
      "app_access_completion_unavailable",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
const payload = {
  iss: sender.issuer,
  aud: sender.audience,
  sub: sender.subject,
  owner_id: sender.ownerId,
  project_id: sender.projectId,
  environment: sender.environment,
};
const native = {
  context: () => ({ headers: { "x-vercel-oidc-token": "native.provider.token" } }),
  verifyToken: async () => ({ payload }),
};

describe("explicit isolated public realm enrollment", () => {
  it("preserves the actual installer resource classification while delivery stays Production", () => {
    const env = readAuthEnvironment(environment);
    expect(env.databaseResource).toEqual(resource);
    expect(
      isEnrolledOperatorRealm({
        environment,
        resource: env.databaseResource,
        baseUrl: env.baseUrl,
      }),
    ).toBe(true);
    expect(env.allowPublicSignUp).toBe(true);
  });
  it("disables isolated signup when the native target does not match enrollment", () => {
    expect(
      publicSignupEnabledForEnvironment({ ...environment, VERCEL_TARGET_ENV: "preview" }),
    ).toBe(false);
  });

  it("rejects direct public proof issuance before reading the browser session on a foreign target", async () => {
    try {
      for (const [name, value] of Object.entries({
        ...environment,
        VERCEL_TARGET_ENV: "preview",
      })) {
        vi.stubEnv(name, value);
      }
      await expect(
        produceRealmOperatorIdentityLink(
          new Headers({ origin: enrollment.publicOrigin }),
          challenge,
        ),
      ).rejects.toThrow("realm_link_enrollment_mismatch");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    { VERCEL_ENV: "preview" },
    { VERCEL_PROJECT_ID: "foreign" },
    { PLATFORM_AUTH_DEPLOYMENT_PROFILE: undefined },
    { PLATFORM_GATEWAY_IDENTITY_KEY_ID: undefined },
    { AUTH_DATABASE_RESOURCE: JSON.stringify({ ...resource, database: "foreign" }) },
  ])("denies mismatched native or resource enrollment %j", (overrides) => {
    const env = { ...environment, ...overrides };
    expect(() =>
      isEnrolledOperatorRealm({
        environment: env,
        resource: env.AUTH_DATABASE_RESOURCE ? JSON.parse(env.AUTH_DATABASE_RESOURCE) : undefined,
        baseUrl: enrollment.publicOrigin,
      }),
    ).toThrow();
  });
  it("does not admit Production senders in legacy configs or cross-project public senders", () => {
    const { publicEnrollment: _enrollment, ...legacy } = config;
    expect(() => realmOperatorLinkConfigSchema.parse(legacy)).toThrow();
    expect(() =>
      realmOperatorLinkConfigSchema.parse({
        ...config,
        identityHandoff: { sender: { ...sender, projectId: "foreign" } },
      }),
    ).toThrow();
  });
  it("signs fresh public release correlation alongside unchanged installer/account plan correlation", () => {
    const identity = {
      version: 1 as const,
      actorId: "normal-user",
      sessionId: "normal-session",
      organizationId: null,
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    };
    const proof = issueRealmOperatorLinkProof({
      identity,
      resource,
      challenge,
      config,
      issuer: enrollment.publicOrigin,
      keyId: "public-key",
      privateKey: key,
    });
    expect(
      verifyRealmOperatorLinkProof({
        proof,
        issuer: enrollment.publicOrigin,
        audience: config.operatorOrigin,
        keyId: "public-key",
        privateKey: key,
      }),
    ).toMatchObject({
      publicRelease,
      resource,
      bootstrapPlanDigest: challenge.bootstrapPlanDigest,
    });
    expect(() =>
      issueRealmOperatorLinkProof({
        identity,
        resource,
        challenge: {
          ...challenge,
          publicRelease: {
            ...publicRelease,
            enrollmentRef: "44444444-4444-4444-a444-444444444444",
          },
        },
        config,
        issuer: enrollment.publicOrigin,
        keyId: "public-key",
        privateKey: key,
      }),
    ).toThrow("realm_link_scope_mismatch");
  });
  it("stages proof from the actual configured Production workload without changing its subject", async () => {
    const continuationUrl =
      "https://builder.example/api/hosted-operator/realm-identity?handoff=opaque";
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ version: 1, continuationUrl }));
    await expect(
      handoffRealmOperatorIdentityLink(
        {
          config,
          environment,
          linked: {
            callbackUrl: "https://builder.example/api/hosted-operator/realm-identity",
            nonce: challenge.nonce,
            proof: "private.signed.proof",
          },
        },
        { ...native, fetch: fetcher },
      ),
    ).resolves.toBe(continuationUrl);
    expect(fetcher).toHaveBeenCalledOnce();
    const denied = vi.fn<typeof fetch>();
    await expect(
      handoffRealmOperatorIdentityLink(
        {
          config,
          environment,
          linked: {
            callbackUrl: "https://builder.example/api/hosted-operator/realm-identity",
            nonce: challenge.nonce,
            proof: "private.signed.proof",
          },
        },
        {
          ...native,
          verifyToken: async () => ({ payload: { ...payload, environment: "preview" } }),
          fetch: denied,
        },
      ),
    ).rejects.toThrow();
    expect(denied).not.toHaveBeenCalled();
  });
  it("keeps normal cookie capture two-phase under Production native authority", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ authorized: true }))
      .mockResolvedValueOnce(Response.json({ captured: true }));
    await captureOperatorNormalBrowserSession(
      {
        config,
        environment,
        challenge: {
          ...challenge,
          browserSession: {
            operationRef: "55555555-5555-4555-a555-555555555555",
            participantProgramDigest: "e".repeat(64),
          },
        },
        proof: "private.signed.proof",
        normalCookie: {
          name: "__Secure-better-auth.session_token",
          value: "private-normal-cookie",
          domain: "app.example",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
          hostOnly: true,
        },
      },
      { ...native, fetch: fetcher },
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
