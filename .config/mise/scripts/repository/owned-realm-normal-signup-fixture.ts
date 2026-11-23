import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { betterAuth } from "better-auth";
import { Pool } from "pg";
import {
  readNormalSignedRealmIdentity,
  readNormalRealmIdentityBySession,
} from "../../../../packages/auth/operator-identity";
import type { AuthDatabaseResource } from "../../../../packages/auth/database-resource";
import { checkCompiledMembershipWorker } from "./owned-realm-membership-worker-fixture";
/** Native BetterAuth on actual disposable PG; distinct from hosted Preview enrollment and human sign-in proof. */
export async function checkNormalSignupToCompiledMembership(input: {
  root: string;
  resource: AuthDatabaseResource;
  connection: string;
  runtimeConnection: string;
}): Promise<number> {
  const pool = new Pool({ connectionString: input.connection });
  const runtime = new Pool({ connectionString: input.runtimeConnection });
  const origin = "https://owned-realm.example";
  try {
    await pool.query(await readFile(path.resolve("packages/auth/schema.sql"), "utf8"));
    const platform = (
      await readFile(path.resolve("packages/auth/provision-organizations.sql"), "utf8")
    ).replaceAll("__CATALOG_APP_IDS__", JSON.stringify(["owned-signup-fixture"]));
    await pool.query(platform);
    // This disposable realm starts without organizations; remove only the platform's known seeds.
    await pool.query("delete from public.organization where id = any($1::text[])", [
      ["hc", "vendor", "dev"],
    ]);
    const privileges = (
      await readFile(path.resolve("packages/auth/runtime-privileges.sql"), "utf8")
    )
      .replaceAll("__RUNTIME_ROLE_LITERAL__", "'auth_runtime'")
      .replaceAll("__RUNTIME_ROLE__", '"auth_runtime"');
    await pool.query(privileges);
    const auth = betterAuth({
      database: runtime,
      baseURL: origin,
      secret: "owned-normal-auth-secret-with-required-length",
      emailAndPassword: { enabled: true },
      trustedOrigins: [origin],
    });

    const response = await auth.handler(
      new Request(`${origin}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Owned fixture",
          email: "owned-fixture@example.test",
          password: "normal-fixture-password-long-enough",
        }),
      }),
    );
    assert.equal(response.status, 200, "native normal signup");
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie, "native issued cookie");
    const headers = new Headers({ cookie, origin, host: new URL(origin).host });
    const current = await auth.api.getSession({
      headers,
      query: { disableRefresh: true, disableCookieCache: true },
    });
    assert.ok(current, "native normal session");
    assert.equal(current.user.emailVerified, false, "ordinary policy does not invent email proof");
    const context = await auth.$context;
    const identity = await readNormalSignedRealmIdentity({
      headers,
      organizationId: null,
      cookieName: context.authCookies.sessionToken.name,
      secret: context.secret,
      database: { query: async (sql, values) => runtime.query(sql, [...values]) },
    });
    assert.ok(identity);
    assert.equal(identity.actorId, current.user.id);
    assert.equal(identity.sessionId, current.session.id);
    assert.equal(identity.organizationId, null);
    const reader = {
      query: async (sql: string, values: readonly unknown[]) => runtime.query(sql, [...values]),
    };
    assert.deepEqual(
      await readNormalRealmIdentityBySession({
        database: reader,
        actorId: identity.actorId,
        realmSessionId: identity.sessionId,
        organizationId: null,
      }),
      identity,
    );
    assert.equal(
      await readNormalRealmIdentityBySession({
        database: reader,
        actorId: "foreign-actor",
        realmSessionId: identity.sessionId,
        organizationId: null,
      }),
      null,
    );
    assert.equal(
      (await pool.query("select count(*)::int as count from organization")).rows[0].count,
      0,
    );
    assert.equal((await pool.query("select count(*)::int as count from member")).rows[0].count, 0);
    assert.equal(
      await readNormalSignedRealmIdentity({
        headers: new Headers({ cookie: `${cookie}tampered` }),
        organizationId: null,
        cookieName: context.authCookies.sessionToken.name,
        secret: context.secret,
        database: {
          query: async () => {
            throw new Error("tampered cookie reached database");
          },
        },
      }),
      null,
    );
    const before = (await pool.query('select id,token,"expiresAt" from session')).rows;
    const compiled = await checkCompiledMembershipWorker({
      ...input,
      owner: pool,
      identity,
      revokeSession: async () => {
        assert.deepEqual(
          (await pool.query('select id,token,"expiresAt" from session')).rows,
          before,
          "membership preserves session until actual normal logout",
        );
        await auth.api.signOut({ headers });
      },
    });
    assert.deepEqual(
      (await pool.query('select id,token,"expiresAt" from session')).rows,
      [],
      "actual normal logout removes session",
    );
    assert.equal(
      (await pool.query('select count(*)::int as count from "user"')).rows[0].count,
      1,
      "membership preserves normal user",
    );
    return compiled + 10;
  } finally {
    await runtime.end();
    await pool.end();
  }
}
