// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Pool } from "pg";
import { createSingleOrganizationAuth } from "../single-organization";
import { addPerson, removePerson } from "../people";
import { authorize, register, type Realm } from "./agent-grant-fixture";

const testUrl = process.env.SINGLE_ORG_TEST_DATABASE_URL;
if (!testUrl && process.env.CI) throw new Error("SINGLE_ORG_TEST_DATABASE_URL is required in CI.");

const origin = "http://127.0.0.1:4555";
const secret = "people-test-auth-secret-at-least-32-chars";

describe.skipIf(!testUrl)("people add/remove and closed sign-up", () => {
  const database = `people_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool;
  let pool: Pool;
  let identity: ReturnType<typeof createSingleOrganizationAuth>;

  const post = (route: string, body: unknown, headers: Record<string, string> = {}) =>
    identity.auth.handler(
      new Request(`${origin}/api/auth${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, ...headers },
        body: JSON.stringify(body),
      }),
    );

  const cookieFrom = (res: Response) =>
    res.headers
      .getSetCookie()
      .map((s) => s.split(";")[0])
      .join("; ");

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      throw new Error("Local test database required");
    admin = new Pool({ connectionString: url.toString() });
    await admin.query(`create database ${database}`);
    url.pathname = `/${database}`;
    pool = new Pool({ connectionString: url.toString() });
    await pool.query(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
    await pool.query(`create table kernel_actor_membership (
      principal_name name, app_id text, customer_id text, actor_id text, role text,
      actor_kind text, active boolean, fence_generation bigint, bound_at timestamptz,
      primary key (principal_name,app_id,customer_id,actor_id,role))`);
    await pool.query(
      await readFile(new URL("../single-organization-membership.sql", import.meta.url), "utf8"),
    );
    await pool.query(`create trigger membership_projection after insert or update or delete on member
      for each row execute function autograph_sync_member('runtime','starter','starter')`);
    identity = createSingleOrganizationAuth({
      database: pool,
      origin,
      secret,
      appId: "starter",
      organizationId: "starter",
      name: "Starter",
    });
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${database} with (force)`);
      await admin.end();
    }
  });

  test("sign-up endpoint and /organization/* HTTP routes are refused", async () => {
    const signUp = await post("/sign-up/email", {
      name: "Outsider",
      email: "outsider@example.test",
      password: "test-password-123",
    });
    expect(signUp.ok).toBe(false);
    expect((await pool.query('select count(*)::int as n from "user"')).rows[0].n).toBe(0);

    const orgCreate = await post("/organization/create", { name: "Evil", slug: "evil" });
    expect(orgCreate.status).toBe(403);
  });

  test("add -> set-password link -> resetPassword -> sign in works with membership and token is single use", async () => {
    const added = await addPerson({
      pool,
      auth: identity.auth,
      organizationId: "starter",
      name: "Starter",
      origin,
      email: "  Alice@Example.Test ",
    });
    expect(added.created).toBe(true);
    expect(added.email).toBe("alice@example.test");
    expect(added.link).toBe(`${origin}/auth/set-password#token=${added.token}`);

    const token = new URLSearchParams(new URL(added.link).hash.slice(1)).get("token")!;
    const reset = await post("/reset-password", { token, newPassword: "first-password-123" });
    expect(reset.status).toBe(200);

    // Token is single use.
    const replay = await post("/reset-password", { token, newPassword: "second-password-123" });
    expect(replay.status).toBe(400);

    const signIn = await post("/sign-in/email", {
      email: "alice@example.test",
      password: "first-password-123",
    });
    expect(signIn.status).toBe(200);
    const cookie = cookieFrom(signIn);
    const session = await identity.session(new Headers({ cookie }));
    expect(session).toEqual({ actorId: added.userId, customerId: "starter" });
    expect(
      (
        await pool.query("select active, role from kernel_actor_membership where actor_id = $1", [
          added.userId,
        ])
      ).rows,
    ).toEqual([{ active: true, role: "member" }]);
  });

  test("re-adding an existing user invalidates the earlier unused link and resetting revokes old sessions", async () => {
    const signInBefore = await post("/sign-in/email", {
      email: "alice@example.test",
      password: "first-password-123",
    });
    expect(signInBefore.status).toBe(200);
    const oldCookie = cookieFrom(signInBefore);

    const firstReset = await addPerson({
      pool,
      auth: identity.auth,
      organizationId: "starter",
      name: "Starter",
      origin,
      email: "alice@example.test",
    });
    expect(firstReset.created).toBe(false);
    const secondReset = await addPerson({
      pool,
      auth: identity.auth,
      organizationId: "starter",
      name: "Starter",
      origin,
      email: "alice@example.test",
    });
    expect(secondReset.created).toBe(false);
    expect(secondReset.token).not.toBe(firstReset.token);

    // Earlier unused link was deleted.
    expect(
      (await post("/reset-password", { token: firstReset.token, newPassword: "should-fail-123" }))
        .status,
    ).toBe(400);

    // Latest link succeeds and revokes prior sessions.
    expect(
      (
        await post("/reset-password", {
          token: secondReset.token,
          newPassword: "updated-password-123",
        })
      ).status,
    ).toBe(200);
    await expect(identity.session(new Headers({ cookie: oldCookie }))).rejects.toMatchObject({
      status: 401,
    });
    const signInAfter = await post("/sign-in/email", {
      email: "alice@example.test",
      password: "updated-password-123",
    });
    expect(signInAfter.status).toBe(200);
  });

  test("remove ends sessions, sign-in, OAuth grants, kernel membership, and preserves shared oauthClient", async () => {
    const signIn = await post("/sign-in/email", {
      email: "alice@example.test",
      password: "updated-password-123",
    });
    expect(signIn.status).toBe(200);
    const cookie = cookieFrom(signIn);
    const { actorId } = await identity.session(new Headers({ cookie }));

    // Issue an unused reset link, an OAuth grant, a deviceCode, and an oauthClient owned by this user.
    const pendingLink = await addPerson({
      pool,
      auth: identity.auth,
      organizationId: "starter",
      name: "Starter",
      origin,
      email: "alice@example.test",
    });
    const realm = { pool, auth: identity.auth } as unknown as Realm;
    const registration = await register(realm);
    expect(registration.response.status, registration.text).toBe(201);
    const clientId = String(registration.json!.client_id);
    await pool.query('update "oauthClient" set "userId" = $1 where "clientId" = $2', [
      actorId,
      clientId,
    ]);
    const flow = await authorize(realm, {
      clientId,
      cookie,
      organizationId: "starter",
      resource: `${origin}/starter/api/mcp`,
    });
    expect(flow.token?.response.status, flow.token?.text ?? JSON.stringify(flow)).toBe(200);
    const agentToken = String(flow.token!.json!.access_token);
    expect((await identity.grant(agentToken, "work_session")).actor.actorId).toBe(actorId);

    await pool.query(
      `insert into "deviceCode" ("id","deviceCode","userCode","userId","expiresAt","status")
       values ('dc-1','dev-code','USER-1',$1,now()+interval '5 minutes','pending')`,
      [actorId],
    );

    expect(
      await removePerson({ pool, organizationId: "starter", email: "alice@example.test" }),
    ).toBe(true);
    expect(
      await removePerson({ pool, organizationId: "starter", email: "alice@example.test" }),
    ).toBe(false);

    await expect(identity.session(new Headers({ cookie }))).rejects.toMatchObject({ status: 401 });
    await expect(identity.grant(agentToken, "work_session")).rejects.toMatchObject({ status: 401 });
    expect(
      (
        await post("/sign-in/email", {
          email: "alice@example.test",
          password: "updated-password-123",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await post("/reset-password", {
          token: pendingLink.token,
          newPassword: "cannot-revive-123",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await pool.query("select active from kernel_actor_membership where actor_id = $1", [
          actorId,
        ])
      ).rows,
    ).toEqual([{ active: false }]);
    expect(
      (
        await pool.query('select count(*)::int as n from "deviceCode" where "userId" = $1', [
          actorId,
        ])
      ).rows[0].n,
    ).toBe(0);
    // Shared OAuth client row survives with userId cleared instead of cascading.
    expect(
      (await pool.query('select "userId" from "oauthClient" where "clientId" = $1', [clientId]))
        .rows,
    ).toEqual([{ userId: null }]);
  });

  test("addPerson repairs missing membership for an existing user and matches email by lower(email)", async () => {
    await pool.query(
      `insert into "user" ("id", "name", "email", "emailVerified")
       values ('mixed-case-user', 'Mixed', 'Mixed.Case@Example.Test', false)`,
    );
    const repaired = await addPerson({
      pool,
      auth: identity.auth,
      organizationId: "starter",
      name: "Starter",
      origin,
      email: "mixed.case@example.test",
    });
    expect(repaired.created).toBe(false);
    expect(repaired.userId).toBe("mixed-case-user");
    expect(
      (
        await pool.query(
          'select count(*)::int as n from "member" where "organizationId" = $1 and "userId" = $2',
          ["starter", "mixed-case-user"],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await pool.query("select active from kernel_actor_membership where actor_id = $1", [
          "mixed-case-user",
        ])
      ).rows,
    ).toEqual([{ active: true }]);

    // Re-running addPerson does not create a duplicate member row.
    await addPerson({
      pool,
      auth: identity.auth,
      organizationId: "starter",
      name: "Starter",
      origin,
      email: "MIXED.CASE@EXAMPLE.TEST",
    });
    expect(
      (
        await pool.query(
          'select count(*)::int as n from "member" where "organizationId" = $1 and "userId" = $2',
          ["starter", "mixed-case-user"],
        )
      ).rows[0].n,
    ).toBe(1);

    // removePerson matches the same user via lower(email).
    expect(
      await removePerson({ pool, organizationId: "starter", email: "mixed.case@example.test" }),
    ).toBe(true);
    expect(
      (await pool.query('select count(*)::int as n from "user" where id = $1', ["mixed-case-user"]))
        .rows[0].n,
    ).toBe(0);
  });
});
