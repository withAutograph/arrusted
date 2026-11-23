import { memoryAdapter } from "@better-auth/memory-adapter";
import { betterAuth } from "better-auth";
import { describe, expect, it, vi } from "vitest";
import { readNormalSignedRealmIdentity } from "../operator-identity";

const createNormalSession = async () => {
  const database = { user: [], session: [], account: [], verification: [] };
  const auth = betterAuth({
    baseURL: "http://localhost:3000",
    secret: "readonly-realm-fixture-secret-long-enough",
    database: memoryAdapter(database),
    emailAndPassword: { enabled: true },
  });
  const response = await auth.api.signUpEmail({
    body: {
      email: "realm@example.test",
      name: "Realm fixture",
      password: "fixture-password-long-enough",
    },
    asResponse: true,
  });
  const context = await auth.$context;
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Normal BetterAuth signup did not issue its session cookie");
  return { context, headers: new Headers({ cookie }) };
};
const identity = {
  actorId: "actual-realm-actor",
  expiresAt: "2099-01-01T00:00:00.000Z",
  organizationId: "owned-org",
  sessionId: "actual-session",
  version: 1,
};

describe("readonly normal signed Realm session", () => {
  it("accepts a normally issued BetterAuth cookie and performs one fixed SELECT", async () => {
    const { context, headers } = await createNormalSession();
    const query = vi.fn(async (_sql: string, _parameters: readonly unknown[]) => ({
      rows: [identity],
    }));
    expect(
      await readNormalSignedRealmIdentity({
        cookieName: context.authCookies.sessionToken.name,
        database: { query },
        headers,
        organizationId: "owned-org",
        secret: context.secret,
      }),
    ).toEqual(identity);
    expect(query).toHaveBeenCalledOnce();
    const [sql, parameters] = query.mock.calls[0] ?? [];
    expect(sql).toMatch(/^select /u);
    expect(sql).toContain('s."expiresAt">now()');
    expect(sql).not.toContain('"emailVerified"');
    expect(sql).toContain("'owner'=any");
    expect(parameters).toEqual([expect.any(String), "owned-org"]);
    expect(sql).not.toMatch(/insert|update|delete/iu);
  });
  it("reads identity-only normal sessions without inventing organization or email verification", async () => {
    const { context, headers } = await createNormalSession();
    const query = vi.fn(async (_sql: string, _parameters: readonly unknown[]) => ({
      rows: [{ ...identity, organizationId: null }],
    }));
    expect(
      await readNormalSignedRealmIdentity({
        cookieName: context.authCookies.sessionToken.name,
        database: { query },
        headers,
        organizationId: null,
        secret: context.secret,
      }),
    ).toEqual({ ...identity, organizationId: null });
    expect(query.mock.calls[0]?.[1]).toEqual([expect.any(String), null]);
    expect(query.mock.calls[0]?.[0]).not.toContain('"emailVerified"');
  });
  it("rejects unsigned, modified, and wrong-secret cookies before database access", async () => {
    const { context, headers } = await createNormalSession();
    const query = vi.fn(async (_sql: string, _parameters: readonly unknown[]) => ({ rows: [] }));
    for (const candidate of [
      new Headers(),
      new Headers({ cookie: `${context.authCookies.sessionToken.name}=unsigned` }),
      new Headers({ cookie: `${headers.get("cookie")}modified` }),
    ]) {
      expect(
        await readNormalSignedRealmIdentity({
          cookieName: context.authCookies.sessionToken.name,
          database: { query },
          headers: candidate,
          organizationId: "owned-org",
          secret: context.secret,
        }),
      ).toBeNull();
    }
    expect(
      await readNormalSignedRealmIdentity({
        cookieName: context.authCookies.sessionToken.name,
        database: { query },
        headers,
        organizationId: "owned-org",
        secret: "wrong-secret",
      }),
    ).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
  it("does not refresh, delete, or adopt absent or conflicting database identity", async () => {
    const { context, headers } = await createNormalSession();
    for (const rows of [[], [identity, identity], [{ ...identity, sessionId: null }]]) {
      const query = vi.fn(async (_sql: string, _parameters: readonly unknown[]) => ({ rows }));
      expect(
        await readNormalSignedRealmIdentity({
          cookieName: context.authCookies.sessionToken.name,
          database: { query },
          headers,
          organizationId: "other-org",
          secret: context.secret,
        }),
      ).toBeNull();
      expect(query).toHaveBeenCalledOnce();
      expect(query.mock.calls[0]?.[1]).toEqual([expect.any(String), "other-org"]);
    }
  });
});
