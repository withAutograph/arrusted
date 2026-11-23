// @vitest-environment node

import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  createPrincipalSigner,
  createPrincipalVerifier,
  normalizedPrincipalRequestTarget,
  requireVerifiedAppActorGrant,
  requireCurrentVerifiedAppActorGrant,
} from "../src/policy/identity";

describe("gateway principal", () => {
  it("keeps a bounded long-request principal valid through agent execution but rejects expiry and rebinding", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const options = { issuer: "https://apps.example.test", keyId: "long-request", privateKey };
    const signer = createPrincipalSigner({ ...options, lifetimeSeconds: 240 });
    const verifier = createPrincipalVerifier({
      issuer: options.issuer,
      keyId: options.keyId,
      publicKey,
      clockSkewSeconds: 0,
    });
    const claims = {
      aud: "vendor",
      sub: "actor",
      organizationId: "tenant",
      customerId: "tenant",
      organizationRole: "owner",
      method: "POST",
      path: "/vendor/api/csv-workspace/turn",
      jti: randomUUID(),
    };
    const now = new Date("2026-09-07T12:00:00Z");
    const token = signer.issue(claims, now);
    const expected = { audience: "vendor", method: "POST", path: claims.path };
    expect(verifier.verify(token, expected, new Date(now.getTime() + 210_000))).toMatchObject({
      sub: "actor",
      customerId: "tenant",
    });
    expect(() => verifier.verify(token, expected, new Date(now.getTime() + 240_000))).toThrow(
      "expired",
    );
    for (const mismatch of [{ audience: "hc" }, { method: "GET" }, { path: "/vendor/api/apply" }]) {
      expect(() =>
        verifier.verify(token, { ...expected, ...mismatch }, new Date(now.getTime() + 180_000)),
      ).toThrow();
    }
    expect(() => createPrincipalSigner({ ...options, lifetimeSeconds: 241 })).toThrow("lifetime");
    const [header, payload] = token.split(".");
    const claimsWithExcessLifetime = JSON.parse(Buffer.from(payload!, "base64url").toString());
    claimsWithExcessLifetime.exp += 1;
    const excessive = `${header}.${Buffer.from(JSON.stringify(claimsWithExcessLifetime)).toString("base64url")}`;
    const excessiveToken = `${excessive}.${sign(null, Buffer.from(excessive), privateKey).toString("base64url")}`;
    expect(() => verifier.verify(excessiveToken, expected, now)).toThrow("lifetime");
    const defaultToken = createPrincipalSigner(options).issue(claims, now);
    expect(() => verifier.verify(defaultToken, expected, new Date(now.getTime() + 60_000))).toThrow(
      "expired",
    );
  });

  it("binds an asymmetric principal to its app, method, path, and lifetime", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signer = createPrincipalSigner({
      issuer: "https://apps.example.test",
      keyId: "key-1",
      privateKey,
    });
    const verifier = createPrincipalVerifier({
      issuer: "https://apps.example.test",
      keyId: "key-1",
      publicKey,
    });
    const now = new Date("2026-07-19T12:00:00Z");
    const path = normalizedPrincipalRequestTarget("/hc/api/records-by-model/", "?model=position");
    const token = signer.issue(
      {
        aud: "hc",
        sub: "actor-1",
        organizationId: "customer-1",
        customerId: "customer-1",
        organizationRole: "owner",
        method: "post",
        path,
        jti: randomUUID(),
      },
      now,
    );

    expect(
      verifier.verify(
        token,
        {
          audience: "hc",
          method: "POST",
          path: "/hc/api/records-by-model?model=position",
        },
        now,
      ),
    ).toMatchObject({
      iss: "https://apps.example.test",
      aud: "hc",
      sub: "actor-1",
      organizationId: "customer-1",
      customerId: "customer-1",
      organizationRole: "owner",
      method: "POST",
      path: "/hc/api/records-by-model?model=position",
      iat: 1_784_462_400,
      exp: 1_784_462_460,
    });
    expect(() =>
      verifier.verify(
        token,
        {
          audience: "vendor",
          method: "POST",
          path: "/hc/api/records-by-model?model=position",
        },
        now,
      ),
    ).toThrow("audience");
    expect(() =>
      verifier.verify(
        token,
        {
          audience: "hc",
          method: "GET",
          path: "/hc/api/records-by-model?model=position",
        },
        now,
      ),
    ).toThrow("method");
    expect(() =>
      verifier.verify(
        token,
        { audience: "hc", method: "POST", path: "/hc/api/records-by-model-position" },
        now,
      ),
    ).toThrow("path");
    expect(() =>
      verifier.verify(
        token,
        {
          audience: "hc",
          method: "POST",
          path: "/hc/api/records-by-model?model=employee",
        },
        now,
      ),
    ).toThrow("path");
  });

  it("rejects tampering, unknown keys, wrong environments, and expired principals", () => {
    const first = generateKeyPairSync("ed25519");
    const second = generateKeyPairSync("ed25519");
    const signer = createPrincipalSigner({
      issuer: "https://apps.example.test",
      keyId: "key-1",
      privateKey: first.privateKey,
      lifetimeSeconds: 10,
    });
    const claims = {
      aud: "vendor",
      sub: "actor-1",
      organizationId: "customer-1",
      customerId: "customer-1",
      organizationRole: null,
      method: "GET",
      path: "/vendor",
      jti: randomUUID(),
    };
    const now = new Date("2026-07-19T12:00:00Z");
    const token = signer.issue(claims, now);
    const verifier = createPrincipalVerifier({
      issuer: "https://apps.example.test",
      keyId: "key-1",
      publicKey: first.publicKey,
      clockSkewSeconds: 0,
    });
    const otherVerifier = createPrincipalVerifier({
      issuer: "https://apps.example.test",
      keyId: "key-1",
      publicKey: second.publicKey,
    });
    const wrongEnvironmentVerifier = createPrincipalVerifier({
      issuer: "https://preview.example.test",
      keyId: "key-1",
      publicKey: first.publicKey,
    });
    const [header, payload, signature] = token.split(".") as [string, string, string];
    const tampered = `${header}.${payload}.${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;

    expect(() =>
      verifier.verify(tampered, { audience: "vendor", method: "GET", path: "/vendor" }, now),
    ).toThrow("signature");
    expect(() =>
      otherVerifier.verify(token, { audience: "vendor", method: "GET", path: "/vendor" }, now),
    ).toThrow("signature");
    expect(() =>
      wrongEnvironmentVerifier.verify(
        token,
        { audience: "vendor", method: "GET", path: "/vendor" },
        now,
      ),
    ).toThrow("issuer");
    expect(() =>
      verifier.verify(
        token,
        { audience: "vendor", method: "GET", path: "/vendor" },
        new Date("2026-07-19T12:00:10Z"),
      ),
    ).toThrow("expired");
    expect(() =>
      verifier.verify(
        token,
        { audience: "vendor", method: "GET", path: "/vendor" },
        new Date("2026-07-19T12:00:11Z"),
      ),
    ).toThrow("expired");
  });
});

it("signs explicit app-role fences and protected readers reject legacy or rebound principals", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signer = createPrincipalSigner({ issuer: "fixture", keyId: "fixture", privateKey });
  const verifier = createPrincipalVerifier({ issuer: "fixture", keyId: "fixture", publicKey });
  const claims = {
    aud: "spend-review",
    sub: "actor",
    organizationId: "tenant",
    customerId: "tenant",
    organizationRole: null,
    method: "POST",
    path: "/spend-review",
    jti: "request",
  };
  const expected = { audience: "spend-review", method: "POST", path: "/spend-review" };
  const principal = verifier.verify(
    signer.issue({ ...claims, appActorGrants: [{ role: "reviewer", fenceGeneration: 9 }] }),
    expected,
  );
  expect(
    requireVerifiedAppActorGrant(principal, {
      appId: "spend-review",
      actorId: "actor",
      organizationId: "tenant",
      role: "reviewer",
    }),
  ).toEqual({ role: "reviewer", fenceGeneration: 9 });
  const legacy = verifier.verify(signer.issue(claims), expected);
  expect(() =>
    requireVerifiedAppActorGrant(legacy, {
      appId: "spend-review",
      actorId: "actor",
      organizationId: "tenant",
      role: "reviewer",
    }),
  ).toThrow();
  for (const changed of [
    { appId: "vendor" },
    { actorId: "other" },
    { organizationId: "other" },
    { role: "owner" },
  ])
    expect(() =>
      requireVerifiedAppActorGrant(principal, {
        appId: "spend-review",
        actorId: "actor",
        organizationId: "tenant",
        role: "reviewer",
        ...changed,
      }),
    ).toThrow();
  for (const appActorGrants of [
    [{ role: "reviewer", fenceGeneration: -1 }],
    [{ role: "", fenceGeneration: 1 }],
    [{ role: "reviewer\nadmin", fenceGeneration: 1 }],
    [{ role: "reviewer", fenceGeneration: 0.5 }],
    [
      { role: "reviewer", fenceGeneration: 0 },
      { role: "reviewer", fenceGeneration: 1 },
    ],
  ])
    expect(() => signer.issue({ ...claims, appActorGrants })).toThrow();
});

it("rechecks the scoped current app binding and rejects revoke-before-Auth-revoke", async () => {
  const keys = generateKeyPairSync("ed25519");
  const signer = createPrincipalSigner({
    issuer: "fixture",
    keyId: "fixture",
    privateKey: keys.privateKey,
  });
  const verifier = createPrincipalVerifier({
    issuer: "fixture",
    keyId: "fixture",
    publicKey: keys.publicKey,
  });
  const scope = {
    appId: "spend-review",
    actorId: "actor",
    organizationId: "tenant",
    role: "reviewer",
  };
  const principal = verifier.verify(
    signer.issue({
      aud: scope.appId,
      sub: scope.actorId,
      organizationId: scope.organizationId,
      customerId: scope.organizationId,
      organizationRole: null,
      method: "POST",
      path: "/spend-review",
      jti: "request",
      appActorGrants: [{ role: "reviewer", fenceGeneration: 9 }],
    }),
    { audience: scope.appId, method: "POST", path: "/spend-review" },
  );
  await expect(
    requireCurrentVerifiedAppActorGrant(principal, scope, async (input) => {
      expect(input).toEqual(scope);
      return { ...scope, active: true, fenceGeneration: 9 };
    }),
  ).resolves.toEqual({ role: "reviewer", fenceGeneration: 9 });
  await expect(
    requireCurrentVerifiedAppActorGrant(principal, scope, async () => null),
  ).rejects.toThrow();
  for (const changed of [
    { active: false },
    { fenceGeneration: 10 },
    { fenceGeneration: 0.5 },
    { fenceGeneration: Number.MAX_SAFE_INTEGER + 1 },
    { organizationId: "foreign" },
    { appId: "vendor" },
    { actorId: "other" },
    { role: "owner" },
  ])
    await expect(
      requireCurrentVerifiedAppActorGrant(principal, scope, async () => ({
        ...scope,
        active: true,
        fenceGeneration: 9,
        ...changed,
      })),
    ).rejects.toThrow();
});
