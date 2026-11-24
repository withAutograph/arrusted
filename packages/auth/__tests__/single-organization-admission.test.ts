// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Pool } from "pg";
import { createSingleOrganizationAuth } from "../single-organization";
import { proofHash, singleOrganizationAdmission } from "../single-organization-admission";
import { claimOwner } from "../../../app/scripts/owner-claim";
import { authorize, register, type Realm } from "./agent-grant-fixture";

const testUrl = process.env.SINGLE_ORG_TEST_DATABASE_URL;
if (!testUrl && process.env.CI) throw new Error("SINGLE_ORG_TEST_DATABASE_URL is required in CI.");

const origin = "http://127.0.0.1:4555";
const AUTH_SECRET = "test-auth-secret-at-least-32-characters";

describe.skipIf(!testUrl)("closed deployment admission", () => {
  let admin: Pool, pool: Pool, identity: ReturnType<typeof createSingleOrganizationAuth>;
  let ownerCookie = "",
    ownerId = "",
    ownerEmail = "",
    memberCookie = "",
    memberId = "",
    memberRowId = "",
    memberAgentToken = "",
    openMemberId = "";
  const database = `admission_${randomUUID().replaceAll("-", "")}`;
  const make = (extra: Record<string, unknown> = {}) =>
    createSingleOrganizationAuth({
      database: pool,
      origin,
      secret: AUTH_SECRET,
      appId: "starter",
      organizationId: "starter",
      name: "Starter",
      ownerSetupHash: proofHash("setup-secret"),
      ...extra,
    });
  const post = (
    route: string,
    body: unknown,
    headers: Record<string, string> = {},
    auth = identity,
  ) =>
    auth.auth.handler(
      new Request(`${origin}/api/auth${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, ...headers },
        body: JSON.stringify(body),
      }),
    );
  const signup = (email: string, headers: Record<string, string> = {}, auth = identity) =>
    post(
      "/sign-up/email",
      { name: "Person", email, password: "test-password-long" },
      headers,
      auth,
    );
  const cookie = (r: Response) =>
    r.headers
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
    // Pre-seed organization metadata to verify owner setup merges rather than overwrites it.
    await pool.query(
      `insert into organization (id,name,slug,"createdAt",metadata) values ('starter','Starter','starter',now(),'{"existing":"keep"}')`,
    );
    // Set up kernel projection table and trigger so member removal tests verify kernel deactivation.
    await pool.query(`create table kernel_actor_membership (
      principal_name name, app_id text, customer_id text, actor_id text, role text,
      actor_kind text, active boolean, fence_generation bigint, bound_at timestamptz,
      primary key (principal_name,app_id,customer_id,actor_id,role))`);
    await pool.query(
      await readFile(new URL("../single-organization-membership.sql", import.meta.url), "utf8"),
    );
    await pool.query(`create trigger membership_projection after insert or update or delete on member
      for each row execute function autograph_sync_member('runtime','starter','starter')`);
    identity = make();
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${database} with (force)`);
      await admin.end();
    }
  });

  test("sign-up rejects bad method, missing proof, bad content-type, oversized and slow bodies before taking a pool connection", async () => {
    // 1. Direct proof on admission.handle: a pool that throws on connect/query and a handler that
    // throws if invoked prove no rejected request can ever touch the pool.
    const forbiddenPool = {
      connect() {
        throw new Error("pool.connect must not be called before validation");
      },
      query() {
        throw new Error("pool.query must not be called before validation");
      },
    } as unknown as Pool;
    const forbiddenHandler = async () => {
      throw new Error("inner handler must not be called before validation");
    };
    const direct = singleOrganizationAdmission({
      database: forbiddenPool,
      organizationId: "starter",
      name: "Starter",
      ownerSetupHash: proofHash("setup-secret"),
      bodyTimeoutMs: 50,
      connectTimeoutMs: 50,
    });
    expect(
      (
        await direct.handle(
          new Request(`${origin}/api/auth/sign-up/email`, { method: "GET" }),
          forbiddenHandler,
        )
      ).status,
    ).toBe(405);
    expect(
      (
        await direct.handle(
          new Request(`${origin}/api/auth/sign-up/email`, {
            method: "POST",
            headers: { "content-type": "application/json", origin },
            body: JSON.stringify({ name: "x", email: "x@example.test", password: "long-password" }),
          }),
          forbiddenHandler,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await direct.handle(
          new Request(`${origin}/api/auth/sign-up/email`, {
            method: "POST",
            headers: {
              "content-type": "text/plain",
              origin,
              "x-owner-setup": "setup-secret",
            },
            body: "name=x",
          }),
          forbiddenHandler,
        )
      ).status,
    ).toBe(415);
    expect(
      (
        await direct.handle(
          new Request(`${origin}/api/auth/sign-up/email`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin,
              "x-owner-setup": "setup-secret",
            },
            body: "{not-json",
          }),
          forbiddenHandler,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await direct.handle(
          new Request(`${origin}/api/auth/sign-up/email`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin,
              "x-owner-setup": "setup-secret",
            },
            body: JSON.stringify({
              name: "x".repeat(20 * 1024),
              email: "big@example.test",
              password: "test-password-long",
            }),
          }),
          forbiddenHandler,
        )
      ).status,
    ).toBe(413);
    expect(
      (
        await direct.handle(
          new Request(`${origin}/api/auth/sign-up/email`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin,
              "x-owner-setup": "setup-secret",
            },
            body: new ReadableStream<Uint8Array>({ start() {} }),
            duplex: "half",
          } as RequestInit),
          forbiddenHandler,
        )
      ).status,
    ).toBe(408);

    // 2. End-to-end through createSingleOrganizationAuth: wait for oauthProvider's one-time
    // startup resource seeding to finish, then verify 0 pool connects across every rejected call.
    let connects = 0;
    const connectStacks: string[] = [];
    let recordStacks = false;
    const countedPool = new Proxy(pool, {
      get(target, prop) {
        if (prop === "connect") {
          return (...args: unknown[]) => {
            connects++;
            if (recordStacks) connectStacks.push(new Error("unexpected pool.connect").stack ?? "");
            return (target.connect as Function).apply(target, args);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const guarded = make({ database: countedPool, bodyTimeoutMs: 50, connectTimeoutMs: 50 });
    await guarded.auth.$context;
    for (let i = 0, settled = 0, last = -1; i < 40 && settled < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      settled = connects === last ? settled + 1 : 0;
      last = connects;
    }
    connects = 0;
    recordStacks = true;

    const getRes = await guarded.auth.handler(
      new Request(`${origin}/api/auth/sign-up/email`, { method: "GET" }),
    );
    expect(getRes.status).toBe(405);
    expect(connects, connectStacks.join("\n---\n")).toBe(0);

    const noProof = await signup("noproof@example.test", {}, guarded);
    expect(noProof.status).toBe(403);
    expect(connects, connectStacks.join("\n---\n")).toBe(0);

    const badType = await guarded.auth.handler(
      new Request(`${origin}/api/auth/sign-up/email`, {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          origin,
          "x-owner-setup": "setup-secret",
        },
        body: "name=x",
      }),
    );
    expect(badType.status).toBe(415);
    expect(connects, connectStacks.join("\n---\n")).toBe(0);

    const oversized = await guarded.auth.handler(
      new Request(`${origin}/api/auth/sign-up/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          "x-owner-setup": "setup-secret",
        },
        body: JSON.stringify({
          name: "x".repeat(20 * 1024),
          email: "big@example.test",
          password: "test-password-long",
        }),
      }),
    );
    expect(oversized.status).toBe(413);
    expect(connects, connectStacks.join("\n---\n")).toBe(0);

    const slowBody = new ReadableStream<Uint8Array>({
      start() {
        // Intentionally never enqueue or close so the body timeout triggers.
      },
    });
    const timedOut = await guarded.auth.handler(
      new Request(`${origin}/api/auth/sign-up/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          "x-owner-setup": "setup-secret",
        },
        body: slowBody,
        duplex: "half",
      } as RequestInit),
    );
    expect(timedOut.status).toBe(408);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(connects, connectStacks.join("\n---\n")).toBe(0);

    // Connection acquisition timeout returns 500 cleanly without hanging.
    const hangingPool = new Proxy(pool, {
      get(target, prop) {
        if (prop === "connect") return () => new Promise(() => {});
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const hanging = make({ database: hangingPool, connectTimeoutMs: 50 });
    const errors: string[] = [];
    const prevError = console.error;
    console.error = (...args) => errors.push(args.map(String).join(" "));
    try {
      const connTimedOut = await signup(
        "timeout@example.test",
        { "x-owner-setup": "setup-secret" },
        hanging,
      );
      expect(connTimedOut.status).toBe(500);
    } finally {
      console.error = prevError;
    }
    expect(errors.join("\n")).toContain("timed out");
    expect(errors.join("\n")).not.toContain("setup-secret");
  });

  test("owner-setup-status reports false before setup and true after; constant-time hash check never leaks hash; metadata is merged not overwritten", async () => {
    const setupHash = proofHash("setup-secret");
    const matchingCheck = createHash("sha256")
      .update(`owner-setup-hash-check:${setupHash}`)
      .digest("hex");
    const wrongCheck = createHash("sha256")
      .update(`owner-setup-hash-check:${proofHash("stale-secret")}`)
      .digest("hex");

    const beforeStatus = await identity.auth.handler(
      new Request(`${origin}/api/auth/owner-setup-status`, { method: "GET" }),
    );
    expect(beforeStatus.status).toBe(200);
    const beforeText = await beforeStatus.text();
    expect(JSON.parse(beforeText)).toEqual({ complete: false });
    expect(beforeText).not.toContain(setupHash);
    expect(beforeText).not.toContain(setupHash.slice(0, 8));

    const matchStatus = await identity.auth.handler(
      new Request(`${origin}/api/auth/owner-setup-status`, {
        method: "GET",
        headers: { "x-owner-setup-hash-check": matchingCheck },
      }),
    );
    expect(matchStatus.status).toBe(200);
    const matchText = await matchStatus.text();
    expect(JSON.parse(matchText)).toEqual({ complete: false, hashMatches: true });
    expect(matchText).not.toContain(setupHash);
    expect(matchText).not.toContain(setupHash.slice(0, 8));

    const staleStatus = await identity.auth.handler(
      new Request(`${origin}/api/auth/owner-setup-status`, {
        method: "GET",
        headers: { "x-owner-setup-hash-check": wrongCheck },
      }),
    );
    expect(staleStatus.status).toBe(200);
    const staleText = await staleStatus.text();
    expect(JSON.parse(staleText)).toEqual({ complete: false, hashMatches: false });
    expect(staleText).not.toContain(setupHash);
    expect(staleText).not.toContain(setupHash.slice(0, 8));

    const postStatus = await identity.auth.handler(
      new Request(`${origin}/api/auth/owner-setup-status`, { method: "POST" }),
    );
    expect(postStatus.status).toBe(405);

    const missing = await signup(
      "none@example.test",
      {},
      make({ ownerSetupHash: undefined, allowSignUp: true }),
    );
    expect(missing.status).toBe(403);
    expect((await missing.json()).message).toContain("APP_OWNER_SETUP_HASH");
    expect((await signup("none@example.test")).status).toBe(403);
    expect((await signup("none@example.test", { "x-owner-setup": "wrong" })).status).toBe(403);
  });

  test("concurrent setup claims yield exactly one owner, merge metadata, and leave no orphan user", async () => {
    const responses = await Promise.all([
      signup("owner1@example.test", { "x-owner-setup": "setup-secret" }),
      signup("owner2@example.test", { "x-owner-setup": "setup-secret" }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 403]);
    const winner = responses.find((r) => r.ok)!;
    ownerCookie = cookie(winner);
    const winnerBody = await winner.json();
    ownerId = winnerBody.user.id;
    ownerEmail = winnerBody.user.email;
    expect((await pool.query("select role from member")).rows).toEqual([{ role: "owner" }]);
    expect((await pool.query('select count(*)::int n from "user"')).rows[0].n).toBe(1);

    const org = (await pool.query("select metadata from organization where id='starter'")).rows[0];
    expect(JSON.parse(org.metadata)).toEqual({ existing: "keep", ownerSetupComplete: true });

    const afterStatus = await identity.auth.handler(
      new Request(`${origin}/api/auth/owner-setup-status`, { method: "GET" }),
    );
    expect(afterStatus.status).toBe(200);
    expect(await afterStatus.json()).toEqual({ complete: true });

    expect(
      (
        await signup(
          "replay@example.test",
          { "x-owner-setup": "setup-secret" },
          make({ allowSignUp: true }),
        )
      ).status,
    ).toBe(403);
  });

  test("invitation hashes, email binding, atomic rollback on account AND member insert failure, logging redaction, use and replay", async () => {
    const headers = new Headers({ cookie: ownerCookie });
    const link = await identity.invite(headers, "Member@Example.test");
    const token = new URLSearchParams(new URL(link).hash.slice(1)).get("invite")!;
    const stored = (await pool.query("select * from invitation")).rows[0];
    expect(stored.id).toBe(proofHash(token));
    expect(JSON.stringify(stored)).not.toContain(token);
    expect((await signup("wrong@example.test", { "x-invitation": token })).status).toBe(403);
    expect((await signup("member@example.test", { "x-invitation": stored.id })).status).toBe(403);

    // 1. Failure injection at credential-account insertion (with secret URL, AUTH_SECRET, and pg DETAIL).
    await pool.query(
      `create function fail_account() returns trigger language plpgsql as $$ begin raise exception 'controlled failure postgresql://owner:secret-db-pw@db.example/db %', '${AUTH_SECRET}' using detail = 'secret detail postgresql://owner:detail-secret-pw@db.example/db'; end $$;
       create trigger fail_account before insert on account for each row execute function fail_account()`,
    );
    const logs: string[] = [];
    const prevError = console.error;
    console.error = (...args) => logs.push(args.map(String).join(" "));
    try {
      expect((await signup("member@example.test", { "x-invitation": token })).ok).toBe(false);
    } finally {
      console.error = prevError;
      await pool.query("drop trigger fail_account on account; drop function fail_account()");
    }
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join("\n")).toContain("controlled failure");
    expect(logs.join("\n")).toContain("[REDACTED]");
    expect(logs.join("\n")).not.toContain("secret-db-pw");
    expect(logs.join("\n")).not.toContain("detail-secret-pw");
    expect(logs.join("\n")).not.toContain(AUTH_SECRET);
    expect(logs.join("\n")).not.toContain(token);
    expect(
      (await pool.query('select 1 from "user" where email=$1', ["member@example.test"])).rowCount,
    ).toBe(0);
    expect(
      (await pool.query("select status from invitation where id=$1", [stored.id])).rows[0].status,
    ).toBe("pending");

    // 2. Failure injection at membership insertion (Better Auth post-transaction hook queue).
    await pool.query(
      `create function fail_member() returns trigger language plpgsql as $$ begin raise exception 'controlled member insert failure'; end $$;
       create trigger fail_member before insert on member for each row execute function fail_member()`,
    );
    try {
      expect((await signup("member@example.test", { "x-invitation": token })).ok).toBe(false);
    } finally {
      await pool.query("drop trigger fail_member on member; drop function fail_member()");
    }
    expect(
      (await pool.query('select 1 from "user" where email=$1', ["member@example.test"])).rowCount,
    ).toBe(0);
    expect((await pool.query("select count(*)::int n from account")).rows[0].n).toBe(1); // Only the owner's account exists.
    expect(
      (await pool.query("select status from invitation where id=$1", [stored.id])).rows[0].status,
    ).toBe("pending");

    // 3. Succeeds cleanly after failure clears, and replay is refused.
    const success = await signup("member@example.test", { "x-invitation": token });
    expect(success.status).toBe(200);
    memberCookie = cookie(success);
    memberId = (await success.json()).user.id;
    memberRowId = (await pool.query('select id from member where "userId"=$1', [memberId])).rows[0]
      .id;
    expect((await signup("member@example.test", { "x-invitation": token })).status).toBe(403);
  });

  test("concurrent use of one invitation admits exactly one user", async () => {
    const link = await identity.invite(
      new Headers({ cookie: ownerCookie }),
      "race-invite@example.test",
    );
    const token = new URLSearchParams(new URL(link).hash.slice(1)).get("invite")!;
    const responses = await Promise.all([
      signup("race-invite@example.test", { "x-invitation": token }),
      signup("race-invite@example.test", { "x-invitation": token }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 403]);
    expect(
      (
        await pool.query('select count(*)::int n from "user" where email=$1', [
          "race-invite@example.test",
        ])
      ).rows[0].n,
    ).toBe(1);
    expect(
      (await pool.query("select status from invitation where id=$1", [proofHash(token)])).rows[0]
        .status,
    ).toBe("accepted");
  });

  test("expired and revoked invitations cannot create accounts", async () => {
    for (const status of ["expired", "revoked"]) {
      const email = `${status}@example.test`;
      const link = await identity.invite(new Headers({ cookie: ownerCookie }), email);
      const token = new URLSearchParams(new URL(link).hash.slice(1)).get("invite")!;
      if (status === "expired")
        await pool.query(
          `update invitation set "expiresAt"=now()-interval '1 second' where id=$1`,
          [proofHash(token)],
        );
      else await identity.revoke(new Headers({ cookie: ownerCookie }), proofHash(token));
      expect((await signup(email, { "x-invitation": token })).status).toBe(403);
      expect((await pool.query('select 1 from "user" where email=$1', [email])).rowCount).toBe(0);
    }
  });

  test("members cannot create, read or revoke invitations or manage members; open signup must be explicit", async () => {
    const headers = new Headers({ cookie: memberCookie });
    await expect(identity.invite(headers, "outsider@example.test")).rejects.toMatchObject({
      code: "owner_required",
    });
    await expect(identity.invitations(headers)).rejects.toMatchObject({ code: "owner_required" });
    await expect(identity.members(headers)).rejects.toMatchObject({ code: "owner_required" });
    await expect(identity.revoke(headers, "anything")).rejects.toMatchObject({
      code: "owner_required",
    });
    await expect(identity.changeMember(headers, memberId, "promote")).rejects.toMatchObject({
      code: "owner_required",
    });
    await expect(identity.changeMember(headers, ownerId, "remove")).rejects.toMatchObject({
      code: "owner_required",
    });
    expect((await signup("outsider@example.test")).status).toBe(403);
    const openRes = await signup("open@example.test", {}, make({ allowSignUp: true }));
    expect(openRes.status).toBe(200);
    openMemberId = (await openRes.json()).user.id;
  });

  test("every installed organization endpoint returns 403 and the hook message for authenticated owner and member sessions with realistic bodies", async () => {
    const { organization } = await import("better-auth/plugins");
    const plugin = organization({});
    const routeBodies: Record<string, Record<string, unknown>> = {
      "/organization/create": { name: "Evil Org", slug: "evil-org" },
      "/organization/update": { organizationId: "starter", data: { name: "Evil", slug: "evil" } },
      "/organization/delete": { organizationId: "starter" },
      "/organization/set-active": { organizationId: "starter" },
      "/organization/invite-member": {
        email: "attacker@example.test",
        role: "member",
        organizationId: "starter",
      },
      "/organization/cancel-invitation": { invitationId: "inv-1" },
      "/organization/accept-invitation": { invitationId: "inv-1" },
      "/organization/reject-invitation": { invitationId: "inv-1" },
      "/organization/check-slug": { slug: "evil-slug" },
      "/organization/remove-member": {
        memberIdOrEmail: "member@example.test",
        organizationId: "starter",
      },
      "/organization/update-member-role": {
        memberId: memberRowId,
        role: "owner",
        organizationId: "starter",
      },
      "/organization/leave": { organizationId: "starter" },
      "/organization/has-permission": { permissions: { member: ["create"] } },
    };
    const fallbackBody = {
      organizationId: "starter",
      memberId: memberRowId,
      memberIdOrEmail: "member@example.test",
      userId: memberId,
      role: "member",
      email: "attacker@example.test",
      invitationId: "inv-1",
      name: "evil",
      slug: "evil",
      data: { name: "evil", slug: "evil" },
      permissions: { member: ["create"] },
    };

    for (const [name, endpoint] of Object.entries(plugin.endpoints)) {
      const route = endpoint.path;
      if (!route) {
        expect(name).toBe("addMember"); // server-only, no HTTP route
        const outsiderId = "outsider-add-member-test";
        await pool.query(
          `insert into "user" ("id","name","email","emailVerified") values ($1,'Outsider','outsider-add@example.test',false)`,
          [outsiderId],
        );
        try {
          await expect(
            identity.auth.api.addMember({
              body: { organizationId: "starter", userId: outsiderId, role: "owner" },
            }),
          ).rejects.toThrow("invitation");
        } finally {
          await pool.query('delete from "user" where id=$1', [outsiderId]);
        }
        continue;
      }
      const method = endpoint.options.method;
      const get = method === "GET" || (Array.isArray(method) && method.includes("GET"));
      for (const [actorLabel, actorCookie] of [
        ["owner", ownerCookie],
        ["member", memberCookie],
      ] as const) {
        const response = get
          ? await identity.auth.handler(
              new Request(`${origin}/api/auth${route}?organizationId=starter&id=inv-1`, {
                headers: { cookie: actorCookie, accept: "application/json" },
              }),
            )
          : await post(route, routeBodies[route] ?? fallbackBody, {
              cookie: actorCookie,
              accept: "application/json",
            });
        const body = await response.json().catch(() => ({}));
        expect(response.status, `${actorLabel} ${name} ${route}: ${JSON.stringify(body)}`).toBe(
          403,
        );
        expect(body.message, `${actorLabel} ${name} ${route}`).toBe(
          "Use the deployment's Members page.",
        );
      }
    }
    expect(
      (await pool.query('select role from member where "userId"=$1', [memberId])).rows[0].role,
    ).toBe("member");
  });

  test("Agent OAuth /auth/oauth/organization flow works for a plain member through the real handler", async () => {
    const realm = { pool, auth: identity.auth } as unknown as Realm;
    const registration = await register(realm);
    expect(registration.response.status, registration.text).toBe(201);
    const flow = await authorize(realm, {
      clientId: String(registration.json!.client_id),
      cookie: memberCookie,
      organizationId: "starter",
      resource: `${origin}/starter/api/mcp`,
    });
    expect(flow.organizationPage).toContain("/auth/oauth/organization");
    expect(flow.context.response.status, flow.context.text).toBe(200);
    expect(flow.context.json?.organizations).toEqual([{ id: "starter", name: "Starter" }]);
    expect(flow.pick.response.status, flow.pick.text).toBe(200);
    expect(flow.continued.response.status, flow.continued.text).toBe(200);
    expect(flow.token?.response.status, flow.token?.text ?? JSON.stringify(flow)).toBe(200);
    memberAgentToken = String(flow.token!.json!.access_token);
    const verified = await identity.grant(memberAgentToken, "work_session");
    expect(verified.actor.actorId).toBe(memberId);
    expect(verified.organizationId).toBe("starter");
  });

  test("owner can remove a member (revoking cookie, agent token, and kernel projection), cannot remove last owner, and can promote a second owner", async () => {
    const ownerHeaders = new Headers({ cookie: ownerCookie });
    // Cannot remove the sole owner.
    await expect(identity.changeMember(ownerHeaders, ownerId, "remove")).rejects.toThrow(
      "Cannot remove the last owner",
    );

    // Before removal: member's kernel projection is active, cookie and agent token both work.
    expect(
      (
        await pool.query(
          "select active,role,actor_kind from kernel_actor_membership where actor_id=$1",
          [memberId],
        )
      ).rows,
    ).toEqual([{ active: true, role: "member", actor_kind: "human" }]);

    // Remove the member.
    await identity.changeMember(ownerHeaders, memberId, "remove");

    // Cookie fails, agent token fails, and kernel projection is deactivated.
    await expect(identity.session(new Headers({ cookie: memberCookie }))).rejects.toMatchObject({
      status: 401,
    });
    await expect(identity.grant(memberAgentToken, "work_session")).rejects.toMatchObject({
      status: 401,
    });
    expect(
      (await pool.query("select active from kernel_actor_membership where actor_id=$1", [memberId]))
        .rows,
    ).toEqual([{ active: false }]);

    // Promote openMemberId to owner, then the original owner CAN be removed, leaving openMemberId as sole owner.
    await identity.changeMember(ownerHeaders, openMemberId, "promote");
    expect(
      (await pool.query('select role from member where "userId"=$1', [openMemberId])).rows[0].role,
    ).toBe("owner");
    // Both owner and member still project to fixed kernel role 'member'.
    expect(
      (
        await pool.query(
          "select distinct role,actor_kind from kernel_actor_membership where active=true",
        )
      ).rows,
    ).toEqual([{ role: "member", actor_kind: "human" }]);
  });

  test("removed member can be re-admitted only by signing in with their own password and presenting a valid invite; wrong user, existing member, expired, revoked, replay, and sign-up takeover are refused", async () => {
    const ownerHeaders = new Headers({ cookie: ownerCookie });
    const rejoinLink = await identity.invite(ownerHeaders, "member@example.test");
    const rejoinToken = new URLSearchParams(new URL(rejoinLink).hash.slice(1)).get("invite")!;

    // 1. Account takeover via /sign-up/email with a new password fails; invite stays pending.
    const takeover = await post(
      "/sign-up/email",
      { name: "Attacker", email: "member@example.test", password: "attacker-new-password" },
      { "x-invitation": rejoinToken },
    );
    expect(takeover.ok).toBe(false);
    expect(
      (await pool.query("select status from invitation where id=$1", [proofHash(rejoinToken)]))
        .rows[0].status,
    ).toBe("pending");

    // 2. Method, origin, missing header, and unauthenticated checks fail before attaching membership.
    expect(
      (
        await identity.auth.handler(
          new Request(`${origin}/api/auth/accept-member-invitation`, { method: "GET" }),
        )
      ).status,
    ).toBe(405);
    expect(
      (
        await identity.auth.handler(
          new Request(`${origin}/api/auth/accept-member-invitation`, {
            method: "POST",
            headers: { origin: "https://evil.example", "x-invitation": rejoinToken },
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await identity.auth.handler(
          new Request(`${origin}/api/auth/accept-member-invitation`, {
            method: "POST",
            headers: { origin },
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await identity.auth.handler(
          new Request(`${origin}/api/auth/accept-member-invitation`, {
            method: "POST",
            headers: { origin, "x-invitation": rejoinToken },
          }),
        )
      ).status,
    ).toBe(401);

    // 3. A different signed-in user who is not a member is refused by email; invite stays pending.
    const stranger = await signup("stranger@example.test", {}, make({ allowSignUp: true }));
    expect(stranger.status).toBe(200);
    const strangerCookie = cookie(stranger);
    await pool.query(
      `delete from member where "userId"=(select id from "user" where email='stranger@example.test')`,
    );
    const wrongUser = await identity.auth.handler(
      new Request(`${origin}/api/auth/accept-member-invitation`, {
        method: "POST",
        headers: { origin, cookie: strangerCookie, "x-invitation": rejoinToken },
      }),
    );
    expect(wrongUser.status).toBe(403);
    expect(
      (await pool.query("select status from invitation where id=$1", [proofHash(rejoinToken)]))
        .rows[0].status,
    ).toBe("pending");

    expect(
      (
        await pool.query(
          `select 1 from member m join "user" u on u.id=m."userId" where u.email='stranger@example.test'`,
        )
      ).rowCount,
    ).toBe(0);
    await pool.query(`delete from "user" where email='stranger@example.test'`);

    // 4. Existing member presenting a valid invite for their own email is refused (409); invite stays pending.
    const existingInviteLink = await identity.invite(ownerHeaders, ownerEmail);
    const existingInviteToken = new URLSearchParams(new URL(existingInviteLink).hash.slice(1)).get(
      "invite",
    )!;
    const existingRes = await identity.auth.handler(
      new Request(`${origin}/api/auth/accept-member-invitation`, {
        method: "POST",
        headers: { origin, cookie: ownerCookie, "x-invitation": existingInviteToken },
      }),
    );
    expect(existingRes.status).toBe(409);
    expect(
      (
        await pool.query("select status from invitation where id=$1", [
          proofHash(existingInviteToken),
        ])
      ).rows[0].status,
    ).toBe("pending");

    // 5. Password was NEVER reset by the invite; only the member's real password signs in.
    const badPwSignIn = await post("/sign-in/email", {
      email: "member@example.test",
      password: "attacker-new-password",
    });
    expect(badPwSignIn.ok).toBe(false);
    const realSignIn = await post("/sign-in/email", {
      email: "member@example.test",
      password: "test-password-long",
    });
    expect(realSignIn.status).toBe(200);
    const rejoinCookie = cookie(realSignIn);
    // Still memberless until the valid invite is accepted.
    await expect(identity.session(new Headers({ cookie: rejoinCookie }))).rejects.toMatchObject({
      status: 403,
    });

    // 6. Expired and revoked invitations are refused for the authenticated memberless user.
    for (const kind of ["expired", "revoked"] as const) {
      const link = await identity.invite(ownerHeaders, "member@example.test");
      const tok = new URLSearchParams(new URL(link).hash.slice(1)).get("invite")!;
      if (kind === "expired")
        await pool.query(
          `update invitation set "expiresAt"=now()-interval '1 second' where id=$1`,
          [proofHash(tok)],
        );
      else await identity.revoke(ownerHeaders, proofHash(tok));
      const res = await identity.auth.handler(
        new Request(`${origin}/api/auth/accept-member-invitation`, {
          method: "POST",
          headers: { origin, cookie: rejoinCookie, "x-invitation": tok },
        }),
      );
      expect(res.status, kind).toBe(403);
    }

    // 7. Valid invite presented by authenticated member@example.test restores membership + kernel projection.
    const accepted = await identity.auth.handler(
      new Request(`${origin}/api/auth/accept-member-invitation`, {
        method: "POST",
        headers: { origin, cookie: rejoinCookie, "x-invitation": rejoinToken },
      }),
    );
    expect(accepted.status).toBe(200);
    expect(
      (await pool.query('select role from member where "userId"=$1', [memberId])).rows,
    ).toEqual([{ role: "member" }]);
    expect(
      (await pool.query("select status from invitation where id=$1", [proofHash(rejoinToken)]))
        .rows[0].status,
    ).toBe("accepted");
    expect(
      (await pool.query("select active from kernel_actor_membership where actor_id=$1", [memberId]))
        .rows,
    ).toEqual([{ active: true }]);
    expect((await identity.session(new Headers({ cookie: rejoinCookie }))).actorId).toBe(memberId);

    // 8. Replay after removing the member again is refused (403).
    await identity.changeMember(ownerHeaders, memberId, "remove");
    const signInAgain = await post("/sign-in/email", {
      email: "member@example.test",
      password: "test-password-long",
    });
    expect(signInAgain.status).toBe(200);
    const replay = await identity.auth.handler(
      new Request(`${origin}/api/auth/accept-member-invitation`, {
        method: "POST",
        headers: { origin, cookie: cookie(signInAgain), "x-invitation": rejoinToken },
      }),
    );
    expect(replay.status).toBe(403);
    expect((await pool.query('select 1 from member where "userId"=$1', [memberId])).rowCount).toBe(
      0,
    );
  });

  test("existing members remain usable without owner; no_owner mentions owner:claim; recovery is explicit and refuses a second owner", async () => {
    await pool.query("update member set role='member'");
    expect((await identity.session(new Headers({ cookie: ownerCookie }))).actorId).toBe(ownerId);
    expect((await pool.query("select 1 from member where role='owner'")).rowCount).toBe(0);
    await expect(identity.members(new Headers({ cookie: ownerCookie }))).rejects.toMatchObject({
      code: "no_owner",
      message: expect.stringContaining("owner:claim"),
    });
    await claimOwner(pool.options.connectionString!, "open@example.test", "starter");
    await expect(claimOwner(pool.options.connectionString!, ownerEmail, "starter")).rejects.toThrow(
      "already exists",
    );
  });

  test("setup code stays consumed even if all memberships are removed", async () => {
    await pool.query("delete from member");
    expect((await signup("late@example.test", { "x-owner-setup": "setup-secret" })).status).toBe(
      403,
    );
    const status = await identity.auth.handler(
      new Request(`${origin}/api/auth/owner-setup-status`, { method: "GET" }),
    );
    expect(await status.json()).toEqual({ complete: true });
  });
});
