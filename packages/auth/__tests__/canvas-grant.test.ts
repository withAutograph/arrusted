// @vitest-environment node
// The canvas in a chat signing in as the person (item 5b), over a private
// PostgreSQL cluster with the realm's real schema and the realm's real route
// handlers: the device authorization grant from a foreign frame origin (CORS
// and trustedOrigins from CANVAS_FRAME_ORIGINS), the device page's
// organization pick keyed by the user code, Approve recording the consent row
// before the code is approved, the device exchange bound to that row, refresh
// rotation staying bound, revocation, and each client limited to its own
// scope and resources.
import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, test } from "vitest";

import {
  CANVAS_AUTH_ENDPOINTS,
  CANVAS_CLIENT_ID,
  canvasResourceIdentifier,
} from "../agent-grant-policy";
import { canvasGrantReference } from "../agent-grant";
import { claudeFrameOrigin, readCanvasFrameOrigins } from "../canvas-frame";
import { createAuthRouteHandlers } from "../next";
import { requireGrantContext } from "../server";
import {
  APP,
  authorize,
  call,
  ISSUER,
  ORIGIN,
  realm,
  register,
  signIn,
  startCluster,
  stopCluster,
  type Realm,
} from "./agent-grant-fixture";

const FRAME = "https://frame.chat.example";
const CANVAS = canvasResourceIdentifier(ORIGIN, APP);
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const claims = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;

/** The realm behind its real route handlers, configured with one operator frame origin. */
async function canvasRealm() {
  const r = await realm({ env: { CANVAS_FRAME_ORIGINS: FRAME } });
  const routes = createAuthRouteHandlers(r.auth as never, {
    canvasFrameOrigins: [FRAME, claudeFrameOrigin(ORIGIN, APP)],
  });
  const handler = (request: Request) =>
    (routes[request.method as keyof typeof routes] as (request: Request) => Promise<Response>)(
      request,
    );
  /** One call as the frame: cross-origin, no cookies. */
  const frame = (method: string, path: string, form?: Record<string, string>, origin = FRAME) =>
    call(r, method, path, { origin, handler, ...(form ? { form } : {}) });
  return { r, handler, frame };
}

const startDevice = (
  frame: Awaited<ReturnType<typeof canvasRealm>>["frame"],
  overrides: Record<string, string> = {},
) =>
  frame("POST", "/api/auth/device/code", {
    client_id: CANVAS_CLIENT_ID,
    scope: "canvas offline_access",
    resource: CANVAS,
    ...overrides,
  });

/** Polling is rate-limited per code; a test polls again without waiting. */
const allowPoll = (r: Realm) => r.pool.query(`update "deviceCode" set "lastPolledAt" = null`);

const verify = (r: Realm, token: string, kind: "canvas" | "work_session" = "canvas") =>
  requireGrantContext({ token, appId: APP, kind }, { database: r.pool, issuer: ISSUER });

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as { status?: number };
  }
  assert.fail("expected a refusal");
};

/** The device flow through Approve, as the frame and the signed-in person. */
async function pair(
  setup: Awaited<ReturnType<typeof canvasRealm>>,
  organizationId: string,
  email = "user-member@example.test",
) {
  const { r, frame } = setup;
  const started = await startDevice(frame);
  assert.equal(started.response.status, 200, started.text);
  const userCode = String(started.json?.user_code);
  const deviceCode = String(started.json?.device_code);
  const { cookie } = await signIn(r, email);
  const context = await call(r, "POST", "/api/auth/canvas-grant/context", {
    cookie,
    body: { user_code: userCode },
  });
  const pick = await call(r, "POST", "/api/auth/canvas-grant/organization", {
    cookie,
    body: { user_code: userCode, organizationId },
  });
  const approve = await call(r, "POST", "/api/auth/device/approve", {
    cookie,
    body: { userCode },
  });
  await allowPoll(r);
  const token = await frame("POST", "/api/auth/oauth2/token", {
    grant_type: DEVICE_GRANT,
    device_code: deviceCode,
    client_id: CANVAS_CLIENT_ID,
  });
  return { started, userCode, deviceCode, cookie, context, pick, approve, token };
}

describe.skipIf(process.env.AUTH_AGENT_GRANT_POSTGRES !== "1")(
  "canvas device sign-in over PostgreSQL",
  () => {
    beforeAll(startCluster, 120_000);
    afterAll(stopCluster, 60_000);

    test("frame origins: configured plus Claude's derived one, trusted by the realm", async () => {
      const { r } = await canvasRealm();
      assert.deepEqual(readCanvasFrameOrigins({ CANVAS_FRAME_ORIGINS: `${FRAME}, ${FRAME}/` }), [
        FRAME,
      ]);
      assert.throws(() => readCanvasFrameOrigins({ CANVAS_FRAME_ORIGINS: "http://frame.test" }));
      assert.throws(() => readCanvasFrameOrigins({ CANVAS_FRAME_ORIGINS: `${FRAME}/path` }));
      const claude = claudeFrameOrigin(ORIGIN, APP);
      assert.match(claude, /^https:\/\/[0-9a-f]{32}\.claudemcpcontent\.com$/u);
      const trusted = r.auth.options.trustedOrigins as string[];
      assert.ok(trusted.includes(FRAME));
      assert.ok(trusted.includes(claude));
    }, 60_000);

    test("CORS answers the frame on the device and token endpoints only, without credentials", async () => {
      const { frame } = await canvasRealm();
      for (const path of CANVAS_AUTH_ENDPOINTS) {
        const preflight = await frame("OPTIONS", path);
        assert.equal(preflight.response.status, 204, path);
        assert.equal(preflight.response.headers.get("access-control-allow-origin"), FRAME);
        assert.match(
          String(preflight.response.headers.get("access-control-allow-headers")),
          /authorization/u,
        );
        assert.equal(preflight.response.headers.get("access-control-allow-credentials"), null);
        // An origin not on the list gets no allowance.
        const foreign = await frame("OPTIONS", path, undefined, "https://evil.example");
        assert.equal(foreign.response.status, 403);
        assert.equal(foreign.response.headers.get("access-control-allow-origin"), null);
      }
      // A preflight on any other auth path is refused outright, from any origin.
      for (const origin of [FRAME, "https://evil.example"]) {
        const preflight = await frame("OPTIONS", "/api/auth/oauth2/register", undefined, origin);
        assert.equal(preflight.response.status, 403);
        assert.equal(preflight.response.headers.get("access-control-allow-origin"), null);
      }
      // Another realm endpoint gets no CORS from the frame.
      const other = await frame("POST", "/api/auth/oauth2/register", {});
      assert.equal(other.response.headers.get("access-control-allow-origin"), null);
      // A refusal still carries the frame's CORS, so the frame can read it.
      const refused = await startDevice(frame, { client_id: "someone-else" });
      assert.equal(refused.response.status, 400);
      assert.equal(refused.json?.error, "unauthorized_client");
      assert.equal(refused.response.headers.get("access-control-allow-origin"), FRAME);
    }, 60_000);

    test("device sign-in issues a canvas token bound to the picked organization's consent row", async () => {
      const setup = await canvasRealm();
      const { r, frame } = setup;
      const flow = await pair(setup, "org-b");
      assert.equal(flow.started.response.headers.get("access-control-allow-origin"), FRAME);
      assert.equal(
        flow.started.json?.verification_uri_complete,
        `${ORIGIN}/auth/device?user_code=${flow.userCode}`,
      );
      assert.equal(flow.started.json?.interval, 5);
      assert.equal(flow.started.json?.expires_in, 600);
      assert.deepEqual(flow.context.json?.app, { id: APP, resource: CANVAS });
      assert.deepEqual(
        (flow.context.json?.organizations as { id: string }[]).map((org) => org.id),
        ["org-a", "org-b"],
      );
      assert.equal(flow.pick.response.status, 200, flow.pick.text);
      assert.equal(flow.approve.response.status, 200, flow.approve.text);
      assert.equal(flow.token.response.status, 200, flow.token.text);
      assert.equal(flow.token.response.headers.get("access-control-allow-origin"), FRAME);
      const access = String(flow.token.json?.access_token);
      const consent = await r.pool.query(
        `select "id", "scopes", "resources" from "oauthConsent"
          where "clientId" = $1 and "userId" = $2 and "referenceId" = $3`,
        [CANVAS_CLIENT_ID, r.users.member, canvasGrantReference(APP, "org-b")],
      );
      assert.equal(consent.rows.length, 1);
      assert.deepEqual(consent.rows[0]!.resources, [CANVAS]);
      const token = claims(access);
      assert.equal(token.aud, CANVAS);
      assert.equal(token.sub, r.users.member);
      assert.equal(token.azp, CANVAS_CLIENT_ID);
      assert.equal(token.org, "org-b");
      assert.equal(token.grant, consent.rows[0]!.id);
      assert.equal(token.scope, "canvas offline_access");
      assert.equal(Number(token.exp) - Number(token.iat), 900);
      // The verifier accepts it as a canvas token only.
      const context = await verify(r, access);
      assert.equal(context.kind, "canvas");
      assert.equal(context.organizationId, "org-b");
      assert.equal(context.grantId, token.grant);
      assert.equal((await refusal(verify(r, access, "work_session"))).status, 401);
      // The device code is spent.
      await allowPoll(r);
      const replay = await frame("POST", "/api/auth/oauth2/token", {
        grant_type: DEVICE_GRANT,
        device_code: flow.deviceCode,
        client_id: CANVAS_CLIENT_ID,
      });
      assert.equal(replay.response.status, 400);
      assert.equal(replay.json?.access_token, undefined);
    }, 60_000);

    test("refresh rotates and stays bound to the same consent row; revocation ends it", async () => {
      const setup = await canvasRealm();
      const { r, frame } = setup;
      const flow = await pair(setup, "org-a");
      const first = String(flow.token.json?.refresh_token);
      const grant = claims(String(flow.token.json?.access_token)).grant;
      // The device exchange's refresh row carries the grant's reference.
      const rows = await r.pool.query(`select "referenceId" from "oauthRefreshToken"`);
      assert.deepEqual(
        rows.rows.map((row) => row.referenceId),
        [canvasGrantReference(APP, "org-a")],
      );
      const refresh = (token: string) =>
        frame("POST", "/api/auth/oauth2/token", {
          grant_type: "refresh_token",
          refresh_token: token,
          client_id: CANVAS_CLIENT_ID,
        });
      const rotated = await refresh(first);
      assert.equal(rotated.response.status, 200, rotated.text);
      assert.equal(rotated.response.headers.get("access-control-allow-origin"), FRAME);
      const second = String(rotated.json?.refresh_token);
      assert.notEqual(second, first);
      const renewed = claims(String(rotated.json?.access_token));
      assert.equal(renewed.grant, grant);
      assert.equal(renewed.org, "org-a");
      assert.equal(renewed.aud, CANVAS);
      assert.equal(renewed.scope, "canvas offline_access");
      assert.equal((await verify(r, String(rotated.json?.access_token))).grantId, grant);
      const third = await refresh(second);
      assert.equal(claims(String(third.json?.access_token)).grant, grant);
      const access = String(third.json?.access_token);
      // A rotated token replayed is refused and ends the family, as for agents.
      assert.equal((await refresh(first)).json?.access_token, undefined);
      assert.equal(
        (await refresh(String(third.json?.refresh_token))).json?.access_token,
        undefined,
      );
      // Revoking the grant ends every unexpired token and any new pairing's refresh.
      assert.equal((await verify(r, access)).grantId, grant);
      const revoked = await call(r, "POST", "/api/auth/oauth2/delete-consent", {
        cookie: flow.cookie,
        body: { id: grant },
      });
      assert.equal(revoked.response.status, 200, revoked.text);
      assert.equal((await refusal(verify(r, access))).status, 401);
      assert.equal(
        (
          await r.pool.query(`select 1 from "oauthRefreshToken" where "referenceId" = $1`, [
            canvasGrantReference(APP, "org-a"),
          ])
        ).rows.length,
        0,
      );
    }, 60_000);

    test("a canvas token stops when the app assignment or the membership goes", async () => {
      const setup = await canvasRealm();
      const { r } = setup;
      const flow = await pair(setup, "org-a");
      const access = String(flow.token.json?.access_token);
      assert.equal((await verify(r, access)).organizationId, "org-a");
      // The app assignment goes inactive: refused; back: accepted again.
      await r.pool.query(
        `update "app_actor_assignment" set "active" = false
          where "organizationId" = 'org-a' and "actorId" = $1`,
        [r.users.member],
      );
      assert.equal((await refusal(verify(r, access))).status, 403);
      await r.pool.query(
        `update "app_actor_assignment" set "active" = true
          where "organizationId" = 'org-a' and "actorId" = $1`,
        [r.users.member],
      );
      assert.equal((await verify(r, access)).organizationId, "org-a");
      // The membership goes: refused.
      await r.pool.query(
        `delete from "member" where "organizationId" = 'org-a' and "userId" = $1`,
        [r.users.member],
      );
      assert.equal((await refusal(verify(r, access))).status, 403);
    }, 60_000);

    test("a grant revoked between Approve and the poll never mints", async () => {
      const setup = await canvasRealm();
      const { r, frame } = setup;
      const started = await startDevice(frame);
      const userCode = String(started.json?.user_code);
      const { cookie } = await signIn(r, "user-member@example.test");
      for (const [path, body] of [
        ["/api/auth/canvas-grant/context", { user_code: userCode }],
        ["/api/auth/canvas-grant/organization", { user_code: userCode, organizationId: "org-a" }],
        ["/api/auth/device/approve", { userCode }],
      ] as const)
        assert.equal((await call(r, "POST", path, { cookie, body })).response.status, 200, path);
      const consent = await r.pool.query(`select "id" from "oauthConsent"`);
      // A consent row deleted outside the revocation hooks: the exchange binds none.
      await r.pool.query(`delete from "oauthConsent" where "id" = $1`, [consent.rows[0]!.id]);
      await allowPoll(r);
      const token = await frame("POST", "/api/auth/oauth2/token", {
        grant_type: DEVICE_GRANT,
        device_code: String(started.json?.device_code),
        client_id: CANVAS_CLIENT_ID,
      });
      assert.equal(token.response.status >= 400, true, token.text);
      assert.equal(token.json?.access_token, undefined);
      assert.equal((await r.pool.query(`select 1 from "oauthRefreshToken"`)).rows.length, 0);
    }, 60_000);

    test("approval needs an eligible organization pick on this person's code", async () => {
      const setup = await canvasRealm();
      const { r, frame } = setup;
      const started = await startDevice(frame);
      const userCode = String(started.json?.user_code);
      const { cookie } = await signIn(r, "user-member@example.test");
      // No pick: Approve refuses and records no grant.
      await call(r, "POST", "/api/auth/canvas-grant/context", {
        cookie,
        body: { user_code: userCode },
      });
      const early = await call(r, "POST", "/api/auth/device/approve", {
        cookie,
        body: { userCode },
      });
      assert.equal(early.response.status, 400, early.text);
      assert.equal((await r.pool.query(`select 1 from "oauthConsent"`)).rows.length, 0);
      // An organization that does not grant the app is refused.
      const ineligible = await call(r, "POST", "/api/auth/canvas-grant/organization", {
        cookie,
        body: { user_code: userCode, organizationId: "org-c" },
      });
      assert.equal(ineligible.response.status, 403);
      // Someone else cannot act on this person's code.
      const other = await signIn(r, "user-other@example.test");
      const stolen = await call(r, "POST", "/api/auth/canvas-grant/context", {
        cookie: other.cookie,
        body: { user_code: userCode },
      });
      assert.equal(stolen.response.status, 403);
      // An access lost after the pick is refused at Approve.
      await call(r, "POST", "/api/auth/canvas-grant/organization", {
        cookie,
        body: { user_code: userCode, organizationId: "org-a" },
      });
      await r.pool.query(
        `update "app_actor_assignment" set "active" = false where "organizationId" = 'org-a'`,
      );
      const lost = await call(r, "POST", "/api/auth/device/approve", {
        cookie,
        body: { userCode },
      });
      assert.equal(lost.response.status, 400, lost.text);
      assert.equal((await r.pool.query(`select 1 from "oauthConsent"`)).rows.length, 0);
    }, 60_000);

    test("Approve binds the organization it validated; a pick racing it refuses the approval", async () => {
      const setup = await canvasRealm();
      const { r, frame } = setup;
      const started = await startDevice(frame);
      const userCode = String(started.json?.user_code);
      const deviceCode = String(started.json?.device_code);
      const { cookie } = await signIn(r, "user-member@example.test");
      const pick = (organizationId: string) =>
        call(r, "POST", "/api/auth/canvas-grant/organization", {
          cookie,
          body: { user_code: userCode, organizationId },
        });
      const approve = () =>
        call(r, "POST", "/api/auth/device/approve", { cookie, body: { userCode } });
      await call(r, "POST", "/api/auth/canvas-grant/context", {
        cookie,
        body: { user_code: userCode },
      });
      assert.equal((await pick("org-a")).response.status, 200);
      // Approve validates org-a, then waits to write (the consent table is held);
      // meanwhile the person picks org-b.
      const holder = await r.pool.connect();
      try {
        await holder.query("begin");
        await holder.query(`lock table "oauthConsent" in access exclusive mode`);
        const approving = approve();
        for (let waited = 0; ; waited += 1) {
          const blocked = await r.pool.query(
            `select 1 from pg_locks where not granted and relation = '"oauthConsent"'::regclass`,
          );
          if (blocked.rows.length > 0) break;
          if (waited > 200) assert.fail("Approve never reached its write");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.equal((await pick("org-b")).response.status, 200);
        await holder.query("commit");
        const raced = await approving;
        assert.equal(raced.response.status, 400, raced.text);
        assert.match(String(raced.json?.error_description), /changed while approving/u);
      } finally {
        holder.release();
      }
      // Nothing was granted or approved under either organization.
      assert.equal((await r.pool.query(`select 1 from "oauthConsent"`)).rows.length, 0);
      const pending = await r.pool.query(
        `select "status", "referenceId" from "deviceCode" where "deviceCode" = $1`,
        [deviceCode],
      );
      assert.deepEqual(pending.rows[0], {
        status: "pending",
        referenceId: canvasGrantReference(APP, "org-b"),
      });
      // Approving again grants the organization now picked, and the token carries it.
      assert.equal((await approve()).response.status, 200);
      const consent = await r.pool.query(`select "referenceId" from "oauthConsent"`);
      assert.deepEqual(
        consent.rows.map((row) => row.referenceId),
        [canvasGrantReference(APP, "org-b")],
      );
      // Once approved, the pick stands: a later pick is refused and changes nothing.
      const late = await pick("org-a");
      assert.equal(late.response.status, 400, late.text);
      await allowPoll(r);
      const token = await frame("POST", "/api/auth/oauth2/token", {
        grant_type: DEVICE_GRANT,
        device_code: deviceCode,
        client_id: CANVAS_CLIENT_ID,
      });
      assert.equal(token.response.status, 200, token.text);
      assert.equal(claims(String(token.json?.access_token)).org, "org-b");
    }, 60_000);

    test("each client gets only its own scope and resources", async () => {
      const setup = await canvasRealm();
      const { r, frame } = setup;
      // The canvas client cannot ask for the agent's scope or resource.
      const agentScope = await startDevice(frame, { scope: "work_session offline_access" });
      assert.equal(agentScope.response.status, 400);
      const agentResource = await startDevice(frame, {
        resource: `${ORIGIN}/${APP}/api/mcp`,
      });
      assert.equal(agentResource.response.status, 400);
      const noResource = await startDevice(frame, { resource: "" });
      assert.equal(noResource.response.status, 400);
      // Another client cannot register for, or sign in with, the canvas.
      // In any scope shape: a space-separated string or an array of them.
      for (const scope of [
        "canvas offline_access",
        "offline_access  canvas",
        ["offline_access", "canvas"],
        ["offline_access canvas"],
        "offline_access,canvas",
        ["offline_access,canvas"],
        // Not a string or an array of strings: refused whatever it holds.
        [["canvas"]],
        { scope: "canvas" },
        ["offline_access", { canvas: true }],
        42,
      ]) {
        const registered = await register(r, { scope });
        assert.equal(
          registered.response.status,
          400,
          `${JSON.stringify(scope)}: ${registered.text}`,
        );
        assert.equal(registered.json?.error, "invalid_client_metadata");
      }
      const client = String((await register(r)).json?.client_id);
      const device = await startDevice(frame, { client_id: client });
      assert.equal(device.response.status, 400);
      // Nor obtain a canvas resource through the authorization code flow.
      const { cookie } = await signIn(r, "user-member@example.test");
      const flow = await authorize(r, {
        clientId: client,
        cookie,
        organizationId: "org-a",
        resource: CANVAS,
      });
      assert.equal(flow.token?.json?.access_token, undefined);
      // A canvas token is refused as an agent token, and an agent token as a canvas token.
      const agent = await authorize(r, { clientId: client, cookie, organizationId: "org-a" });
      const agentToken = String(agent.token?.json?.access_token);
      assert.equal((await refusal(verify(r, agentToken, "canvas"))).status, 401);
      assert.equal((await verify(r, agentToken, "work_session")).kind, "work_session");
    }, 60_000);
  },
);
