// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Pool } from "pg";
import { createSingleOrganizationAuth } from "../single-organization";
import { eligibleAgentOrganizations } from "../agent-grant";
import { addPerson } from "../people";
import { authorize, call, register, type Realm } from "./agent-grant-fixture";

// Explicitly opted-in local test server only; every run owns and removes its database.
const testUrl = process.env.SINGLE_ORG_TEST_DATABASE_URL;
if (!testUrl && process.env.CI) throw new Error("SINGLE_ORG_TEST_DATABASE_URL is required in CI.");
describe.skipIf(!testUrl)("single-organization sign-in and OAuth", () => {
  const name = `single_org_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool;
  let pool: Pool;
  let identity: ReturnType<typeof createSingleOrganizationAuth>;
  let cookie = "";
  let actorId = "";
  let token = "";
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      throw new Error("Local test database required");
    admin = new Pool({ connectionString: url.toString() });
    await admin.query(`create database ${name}`);
    url.pathname = `/${name}`;
    pool = new Pool({ connectionString: url.toString() });
    await pool.query(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
    identity = createSingleOrganizationAuth({
      database: pool,
      origin: "http://127.0.0.1:4555",
      secret: "single-organization-test-secret-000000",
      appId: "canvas",
      organizationId: "team",
      name: "Test team",
    });
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${name} with (force)`);
      await admin.end();
    }
  });
  test("added members share one organization and sessions require current membership", async () => {
    for (let index = 0; index < 2; index++) {
      const email = `member${index}@example.test`;
      const added = await addPerson({
        pool,
        auth: identity.auth,
        organizationId: "team",
        name: "Test team",
        origin: "http://127.0.0.1:4555",
        email,
      });
      const reset = await identity.auth.handler(
        new Request("http://127.0.0.1:4555/api/auth/reset-password", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://127.0.0.1:4555" },
          body: JSON.stringify({ token: added.token, newPassword: "test-password-123" }),
        }),
      );
      expect(reset.status).toBe(200);
      const response = await identity.auth.handler(
        new Request("http://127.0.0.1:4555/api/auth/sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://127.0.0.1:4555" },
          body: JSON.stringify({ email, password: "test-password-123" }),
        }),
      );
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(200);
      if (index === 0) {
        cookie = response.headers
          .getSetCookie()
          .map((item) => item.split(";")[0])
          .join("; ");
        actorId = body.user.id;
      }
    }
    expect(
      (await pool.query('select count(*)::int as count from "organization"')).rows[0].count,
    ).toBe(1);
    expect((await identity.session(new Headers({ cookie }))).customerId).toBe("team");
    await expect(identity.session(new Headers())).rejects.toMatchObject({ status: 401 });
    expect(
      await eligibleAgentOrganizations(pool, {
        appId: "canvas",
        userId: actorId,
        singleOrganizationId: "team",
      }),
    ).toEqual([{ id: "team", name: "Test team" }]);
    expect(
      await eligibleAgentOrganizations(pool, {
        appId: "canvas",
        userId: actorId,
        singleOrganizationId: "other",
      }),
    ).toEqual([]);
    // No app grants or fence tables were provisioned.
    expect(
      (await pool.query("select to_regclass('app_actor_assignment') as table_name")).rows[0]
        .table_name,
    ).toBeNull();
  });
  test("device pairing issues only a human canvas token for the same organization", async () => {
    const realm = { pool, auth: identity.auth } as unknown as Realm;
    const started = await call(realm, "POST", "/api/auth/device/code", {
      origin: false,
      form: {
        client_id: "autograph-canvas",
        scope: "canvas offline_access",
        resource: "http://127.0.0.1:4555/canvas/api/canvas",
      },
    });
    expect(started.response.status, started.text).toBe(200);
    const userCode = String(started.json!.user_code);
    const selected = await call(realm, "POST", "/api/auth/canvas-grant/organization", {
      cookie,
      body: { user_code: userCode, organizationId: "team" },
    });
    expect(selected.response.status, selected.text).toBe(200);
    const approved = await call(realm, "POST", "/api/auth/device/approve", {
      cookie,
      body: { userCode },
    });
    expect(approved.response.status, approved.text).toBe(200);
    const issued = await call(realm, "POST", "/api/auth/oauth2/token", {
      origin: false,
      form: {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: String(started.json!.device_code),
        client_id: "autograph-canvas",
      },
    });
    expect(issued.response.status, issued.text).toBe(200);
    const canvasToken = String(issued.json!.access_token);
    expect((await identity.grant(canvasToken, "canvas")).organizationId).toBe("team");
    await expect(identity.grant(canvasToken, "work_session")).rejects.toMatchObject({
      status: 401,
    });
  });
  test("PKCE OAuth works without app grants, and revocation closes browser and agent access", async () => {
    const realm = { pool, auth: identity.auth } as unknown as Realm;
    const registration = await register(realm);
    expect(registration.response.status, registration.text).toBe(201);
    const flow = await authorize(realm, {
      clientId: String(registration.json!.client_id),
      cookie,
      organizationId: "team",
    });
    expect(flow.token?.response.status, flow.token?.text ?? JSON.stringify(flow)).toBe(200);
    token = String(flow.token!.json!.access_token);
    expect((await identity.grant(token, "work_session")).actor.actorId).toBe(actorId);
    await expect(identity.grant(token, "canvas")).rejects.toMatchObject({ status: 401 });
    await pool.query('delete from "member" where "userId" = $1', [actorId]);
    await expect(identity.session(new Headers({ cookie }))).rejects.toMatchObject({ status: 403 });
    await expect(identity.grant(token, "work_session")).rejects.toMatchObject({ status: 403 });
    await pool.query(
      'insert into "member" ("id", "userId", "organizationId", "role", "createdAt") values ($1, $2, $3, $4, now())',
      [randomUUID(), actorId, "team", "member"],
    );
    await pool.query('delete from "oauthConsent" where "userId" = $1', [actorId]);
    await expect(identity.grant(token, "work_session")).rejects.toMatchObject({ status: 401 });
  });
});
