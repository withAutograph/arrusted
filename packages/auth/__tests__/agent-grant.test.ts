// @vitest-environment node
// The realm as the agents' OAuth authorization server, over a private
// PostgreSQL cluster with the realm's real schema: discovery, public-client
// registration (DCR and CIMD, public clients and RFC 7591 metadata only), the
// authorization-code flow with PKCE and the organization picked for the grant
// only, one independent grant per app and organization, token claims bound to
// the exact consent row, refresh rotation and family revocation, issuance
// refusal, and the per-call verifier with every refusal it owns.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { afterAll, beforeAll, describe, test } from "vitest";

import { agentAuthorizationRequestKey, requireGrantContext } from "../server";
import { agentGrantReference } from "../agent-grant";
import { agentBearerChallenge, agentResourceIdentifier } from "../agent-grant-policy";
import {
  APP,
  APP2,
  authorize,
  call,
  ISSUER,
  ORIGIN,
  RESOURCE,
  RESOURCE2,
  realm,
  register,
  signIn,
  startCluster,
  stopCluster,
  type Realm,
} from "./agent-grant-fixture";

const verify = (r: Realm, token: string, appId = APP) =>
  requireGrantContext({ token, appId, kind: "work_session" }, { database: r.pool, issuer: ISSUER });

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as { code?: string; status?: number };
  }
  assert.fail("expected a refusal");
};

const claims = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;

/** A key the test controls, published in the realm's key table, to forge exact claims. */
async function forger(r: Realm) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const kid = `test-${Math.random().toString(36).slice(2)}`;
  await r.pool.query(
    `insert into "jwks" ("id","publicKey","privateKey","createdAt","alg","crv") values ($1,$2,'unused',now(),'EdDSA','Ed25519')`,
    [kid, JSON.stringify(publicKey.export({ format: "jwk" }))],
  );
  return (payload: Record<string, unknown>, key = privateKey) => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const input = `${encode({ alg: "EdDSA", kid, typ: "at+jwt" })}.${encode(payload)}`;
    return `${input}.${sign(null, Buffer.from(input), key).toString("base64url")}`;
  };
}

describe.skipIf(process.env.AUTH_AGENT_GRANT_POSTGRES !== "1")(
  "agent grant over PostgreSQL",
  () => {
    beforeAll(startCluster, 120_000);
    afterAll(stopCluster, 60_000);

    test("discovery advertises the issuer, both registration paths, PKCE S256 and the scopes", async () => {
      const r = await realm();
      const { json } = await call(r, "GET", "/api/auth/.well-known/oauth-authorization-server");
      assert.equal(json?.issuer, ISSUER);
      assert.equal(json?.registration_endpoint, `${ISSUER}/oauth2/register`);
      assert.equal(json?.client_id_metadata_document_supported, true);
      assert.deepEqual(json?.code_challenge_methods_supported, ["S256"]);
      assert.deepEqual(json?.scopes_supported, ["work_session", "offline_access", "canvas"]);
      // The token endpoint is POST only.
      const get = await call(r, "GET", "/api/auth/oauth2/token");
      assert.ok(get.response.status >= 400 && get.response.status < 500, get.text);
      assert.equal(get.json?.access_token, undefined);
      assert.equal(
        agentBearerChallenge({ publicOrigin: ORIGIN, appId: APP, error: "invalid_token" }),
        `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/${APP}/api/mcp", scope="work_session", error="invalid_token"`,
      );
    }, 60_000);

    test("a realm without enrolled apps has no authorization server", async () => {
      const r = await realm({ appIds: [] });
      const { response } = await register(r);
      assert.equal(response.status, 404);
    }, 60_000);

    test("registration admits public clients only; loopback HTTP redirects make a native client", async () => {
      const r = await realm();
      const native = await register(r);
      assert.equal(native.response.status, 201, native.text);
      assert.equal(native.json?.application_type, "native");
      assert.equal(native.json?.token_endpoint_auth_method, "none");
      assert.equal(native.json?.client_secret, undefined);
      const confidential = await register(r, { token_endpoint_auth_method: "client_secret_basic" });
      assert.equal(confidential.response.status, 400);
      // A web client still needs HTTPS redirects.
      const web = await register(r, {
        application_type: "web",
        redirect_uris: ["http://localhost:4000/callback"],
      });
      assert.equal(web.response.status, 400);
      const hosted = await register(r, {
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      });
      assert.equal(hosted.response.status, 201, hosted.text);
      // A native client still may not use a non-loopback HTTP redirect.
      for (const body of [
        { application_type: "native", redirect_uris: ["http://agent.example.com/callback"] },
        { redirect_uris: ["http://localhost:4000/cb", "http://agent.example.com/cb"] },
      ]) {
        const refused = await register(r, body);
        assert.equal(refused.response.status, 400, JSON.stringify(body));
      }
    }, 60_000);

    test("registration takes RFC 7591 metadata only: privileged client fields are the server's", async () => {
      const r = await realm();
      // The provider refuses a client that asks to skip consent.
      const skipping = await register(r, { skip_consent: true });
      assert.equal(skipping.response.status, 400, skipping.text);
      assert.equal(skipping.json?.client_id, undefined);
      // Everything else outside the public-client metadata never reaches it.
      const privileged = await register(r, {
        require_pkce: false,
        enable_end_session: true,
        disabled: true,
        reference_id: "org-a",
        subject_type: "pairwise",
        dpop_bound_access_tokens: true,
        metadata: { trusted: true },
        resources: [RESOURCE],
        jwks_uri: "https://agent.example.com/jwks.json",
        backchannel_logout_uri: "https://agent.example.com/logout",
      });
      assert.equal(privileged.response.status, 201, privileged.text);
      const row = (
        await r.pool.query(`select * from "oauthClient" where "clientId" = $1`, [
          String(privileged.json?.client_id),
        ])
      ).rows[0];
      assert.notEqual(row.skipConsent, true);
      assert.notEqual(row.requirePKCE, false);
      assert.notEqual(row.disabled, true);
      assert.equal(row.tokenEndpointAuthMethod, "none");
      assert.equal(row.clientSecret, null);
      for (const column of [
        "enableEndSession",
        "referenceId",
        "subjectType",
        "dpopBoundAccessTokens",
        "jwksUri",
        "backchannelLogoutUri",
        "metadata",
      ])
        assert.ok(row[column] === null || row[column] === false, `${column}: ${row[column]}`);
      const links = await r.pool.query(`select * from "oauthClientResource"`);
      assert.equal(links.rows.length, 0);
      // PKCE stays required: a token request without a verifier is refused.
      const { cookie: memberCookie } = await signIn(r, "user-member@example.test");
      const unverified = await authorize(r, {
        clientId: String(privileged.json?.client_id),
        cookie: memberCookie,
        organizationId: "org-a",
        omitVerifier: true,
      });
      assert.ok(unverified.code);
      assert.equal(unverified.token?.response.status, 400, unverified.token?.text ?? "");
      assert.equal(unverified.token?.json?.access_token, undefined);
      // A new client always meets the consent page.
      const flow = await authorize(r, {
        clientId: String(privileged.json?.client_id),
        cookie: memberCookie,
        organizationId: "org-b",
      });
      assert.ok(flow.next.startsWith("/auth/oauth/consent?"), flow.next);
    }, 60_000);

    test("the grant binds the picked organization, never the session's active organization", async () => {
      const r = await realm();
      const client = String((await register(r)).json?.client_id);
      const { cookie } = await signIn(r, "user-member@example.test");
      await call(r, "POST", "/api/auth/organization/set-active", {
        cookie,
        body: { organizationId: "org-a" },
      });
      const flow = await authorize(r, { clientId: client, cookie, organizationId: "org-b" });
      assert.ok(
        flow.organizationPage.startsWith("/auth/oauth/organization?"),
        flow.organizationPage,
      );
      // Only organizations that grant the app and assign the user are offered.
      assert.deepEqual(
        (flow.context.json?.organizations as { id: string }[]).map((o) => o.id),
        ["org-a", "org-b"],
      );
      assert.equal((flow.context.json?.client as { verifiedDomain: unknown }).verifiedDomain, null);
      assert.ok(flow.next.startsWith("/auth/oauth/consent?"), flow.next);
      assert.equal(flow.token?.response.status, 200, flow.token?.text ?? "");
      const access = String(flow.token?.json?.access_token);
      const payload = claims(access);
      assert.equal(payload.aud, RESOURCE);
      assert.equal(payload.iss, ISSUER);
      assert.equal(payload.sub, r.users.member);
      assert.equal(payload.azp, client);
      assert.equal(payload.org, "org-b");
      assert.equal(payload.scope, "work_session offline_access");
      assert.equal(Number(payload.exp) - Number(payload.iat), 900);
      assert.equal(typeof flow.token?.json?.refresh_token, "string");
      const consent = await r.pool.query(`select * from "oauthConsent"`);
      assert.equal(consent.rows.length, 1);
      assert.equal(consent.rows[0].referenceId, agentGrantReference(APP, "org-b"));
      assert.equal(consent.rows[0].referenceId, JSON.stringify([APP, "org-b"]));
      // The token names its exact consent row.
      assert.equal(payload.grant, consent.rows[0].id);
      const session = await r.pool.query(`select "activeOrganizationId" from "session"`);
      assert.deepEqual(
        session.rows.map((row) => row.activeOrganizationId),
        ["org-a"],
      );
      const context = await verify(r, access);
      assert.equal(context.organizationId, "org-b");
      assert.equal(context.grantId, consent.rows[0].id);
      assert.equal(context.clientId, client);
      assert.deepEqual(context.grants, [{ role: "member", fenceGeneration: 1 }]);
    }, 60_000);

    test("a pick binds one authorization request; an ineligible organization is refused", async () => {
      const r = await realm();
      const client = String((await register(r)).json?.client_id);
      const { cookie } = await signIn(r, "user-member@example.test");
      const ineligible = await authorize(r, { clientId: client, cookie, organizationId: "org-c" });
      assert.equal(ineligible.pick.response.status, 403);
      // Without a pick for this request the flow returns to the organization page.
      assert.ok(ineligible.next.startsWith("/auth/oauth/organization?"), ineligible.next);
      assert.equal(ineligible.code, null);
      const a = new URLSearchParams({ client_id: "c", code_challenge: "1", resource: RESOURCE });
      const b = new URLSearchParams({ client_id: "c", code_challenge: "2", resource: RESOURCE });
      assert.notEqual(agentAuthorizationRequestKey(`${a}`), agentAuthorizationRequestKey(`${b}`));
    }, 60_000);

    test("PKCE: a wrong code_verifier is refused; an unknown resource never gets a code", async () => {
      const r = await realm();
      const client = String((await register(r)).json?.client_id);
      const { cookie } = await signIn(r, "user-member@example.test");
      const flow = await authorize(r, { clientId: client, cookie, organizationId: "org-a" });
      assert.equal(flow.token?.response.status, 200);
      const again = await authorize(r, { clientId: client, cookie, organizationId: "org-a" });
      assert.ok(again.code);
      const wrong = await call(r, "POST", "/api/auth/oauth2/token", {
        origin: false,
        form: {
          grant_type: "authorization_code",
          code: again.code!,
          redirect_uri: "http://localhost:51234/callback",
          client_id: client,
          code_verifier: flow.verifier,
          resource: RESOURCE,
        },
      });
      assert.equal(wrong.response.status, 400, wrong.text);
      const other = await authorize(r, {
        clientId: client,
        cookie,
        organizationId: "org-a",
        resource: agentResourceIdentifier(ORIGIN, "not-enrolled"),
      });
      assert.equal(other.code, null);
      assert.match(other.organizationPage, /invalid_target|error/u);
    }, 60_000);

    test("refresh rotates; a reused refresh token is refused; issuance stops when access ends", async () => {
      const r = await realm();
      const client = String((await register(r)).json?.client_id);
      const { cookie } = await signIn(r, "user-member@example.test");
      const flow = await authorize(r, { clientId: client, cookie, organizationId: "org-a" });
      const first = String(flow.token?.json?.refresh_token);
      const refresh = (token: string) =>
        call(r, "POST", "/api/auth/oauth2/token", {
          origin: false,
          form: {
            grant_type: "refresh_token",
            refresh_token: token,
            client_id: client,
            resource: RESOURCE,
          },
        });
      const rotated = await refresh(first);
      assert.equal(rotated.response.status, 200, rotated.text);
      const second = String(rotated.json?.refresh_token);
      assert.notEqual(second, first);
      assert.equal(claims(String(rotated.json?.access_token)).org, "org-a");
      const reused = await refresh(first);
      assert.equal(reused.response.status, 400, reused.text);
      assert.equal(reused.json?.error, "invalid_grant", reused.text);
      assert.equal(reused.json?.access_token, undefined);
      // Reuse revokes the family: the rotated token is dead too.
      const family = await refresh(second);
      assert.equal(family.response.status, 400, family.text);
      assert.equal(family.json?.error, "invalid_grant", family.text);
      assert.equal(family.json?.access_token, undefined);
      assert.equal(family.json?.refresh_token, undefined);
      // A refresh token never mints a token for another resource.
      const fresh = await authorize(r, { clientId: client, cookie, organizationId: "org-a" });
      const other = await call(r, "POST", "/api/auth/oauth2/token", {
        origin: false,
        form: {
          grant_type: "refresh_token",
          refresh_token: String(fresh.token?.json?.refresh_token),
          client_id: client,
          resource: RESOURCE2,
        },
      });
      assert.equal(other.response.status, 400, other.text);
      assert.equal(other.json?.access_token, undefined);
      // Issuance stops when access ends.
      const third = await authorize(r, { clientId: client, cookie, organizationId: "org-a" });
      await r.pool.query(
        `update "app_actor_assignment" set "active" = false where "actorId" = $1 and "organizationId" = 'org-a'`,
        [r.users.member],
      );
      const refused = await refresh(String(third.token?.json?.refresh_token));
      assert.ok(refused.response.status >= 400 && refused.response.status < 500, refused.text);
      assert.equal(refused.json?.access_token, undefined);
    }, 60_000);

    test("revoking the grant refuses the unexpired token and revokes its refresh tokens", async () => {
      const r = await realm();
      const client = String((await register(r)).json?.client_id);
      const { cookie } = await signIn(r, "user-member@example.test");
      const flow = await authorize(r, { clientId: client, cookie, organizationId: "org-a" });
      const access = String(flow.token?.json?.access_token);
      const grant = await verify(r, access);
      const listed = await call(r, "GET", "/api/auth/oauth2/get-consents", { cookie });
      assert.ok(JSON.stringify(listed.json).includes(grant.grantId), listed.text);
      const deleted = await call(r, "POST", "/api/auth/oauth2/delete-consent", {
        cookie,
        body: { id: grant.grantId },
      });
      assert.equal(deleted.response.status, 200, deleted.text);
      const error = await refusal(verify(r, access));
      assert.equal(error.status, 401);
      const remaining = await r.pool.query(`select "id" from "oauthRefreshToken"`);
      assert.equal(remaining.rows.length, 0);
      const refresh = await call(r, "POST", "/api/auth/oauth2/token", {
        origin: false,
        form: {
          grant_type: "refresh_token",
          refresh_token: String(flow.token?.json?.refresh_token),
          client_id: client,
          resource: RESOURCE,
        },
      });
      assert.equal(refresh.response.status, 400, refresh.text);
      // Granting the same app and organization again is a new grant: the
      // deleted grant's token stays refused, the new one works.
      const again = await authorize(r, { clientId: client, cookie, organizationId: "org-a" });
      assert.equal(again.token?.response.status, 200, again.token?.text ?? "");
      const renewed = await verify(r, String(again.token?.json?.access_token));
      assert.notEqual(renewed.grantId, grant.grantId);
      assert.equal((await refusal(verify(r, access))).status, 401);
    }, 60_000);

    test("delete refuses an authorization code issued before it, and only that grant's", async () => {
      const r = await realm();
      const client = String((await register(r)).json?.client_id);
      const { cookie } = await signIn(r, "user-member@example.test");
      const first = await authorize(r, { clientId: client, cookie, organizationId: "org-a" });
      const grantId = String(claims(String(first.token?.json?.access_token)).grant);
      // Another app's grant, with its own pending code.
      await authorize(r, {
        clientId: client,
        cookie,
        organizationId: "org-a",
        resource: RESOURCE2,
      });
      const otherPending = await authorize(r, {
        clientId: client,
        cookie,
        organizationId: "org-a",
        resource: RESOURCE2,
        stopBeforeExchange: true,
      });
      // A second request on the same grant: consent exists, a code is issued
      // and not exchanged.
      const pending = await authorize(r, {
        clientId: client,
        cookie,
        organizationId: "org-a",
        stopBeforeExchange: true,
      });
      assert.ok(pending.code);
      assert.equal(pending.token, null);
      const codes = async () =>
        (
          await r.pool.query(
            `select count(*)::int as n from "verification" where "value" like '{"type":"authorization_code"%'`,
          )
        ).rows[0]!.n as number;
      assert.equal(await codes(), 2);
      const deleted = await call(r, "POST", "/api/auth/oauth2/delete-consent", {
        cookie,
        body: { id: grantId },
      });
      assert.equal(deleted.response.status, 200, deleted.text);
      // Only this grant's pending code is gone.
      assert.equal(await codes(), 1);
      // Granting the same app and organization again does not revive it.
      const again = await authorize(r, { clientId: client, cookie, organizationId: "org-a" });
      assert.equal(again.token?.response.status, 200, again.token?.text ?? "");
      const exchange = (flow: typeof pending, resource: string) =>
        call(r, "POST", "/api/auth/oauth2/token", {
          origin: false,
          form: {
            grant_type: "authorization_code",
            code: flow.code!,
            redirect_uri: "http://localhost:51234/callback",
            client_id: client,
            code_verifier: flow.verifier,
            resource,
          },
        });
      const late = await exchange(pending, RESOURCE);
      assert.equal(late.response.status, 400, late.text);
      assert.equal(late.json?.access_token, undefined);
      // The other app's pending code still works.
      const kept = await exchange(otherPending, RESOURCE2);
      assert.equal(kept.response.status, 200, kept.text);
    }, 60_000);

    test("a refresh racing revocation never mints for the grant given again", async () => {
      const r = await realm();
      const client = String((await register(r)).json?.client_id);
      const { cookie } = await signIn(r, "user-member@example.test");
      const flow = await authorize(r, { clientId: client, cookie, organizationId: "org-a" });
      const grantId = String(claims(String(flow.token?.json?.access_token)).grant);
      // A gate on the refresh table: while armed, a new refresh row waits,
      // written but uncommitted, until the test releases its advisory lock.
      // The provider writes it after the issuance check and the rotation.
      await r.pool.query(`
        create table test_refresh_gate (armed boolean not null);
        insert into test_refresh_gate values (false);
        create function test_hold_refresh() returns trigger language plpgsql as $$
        begin
          if (select armed from test_refresh_gate) then
            perform pg_advisory_xact_lock_shared(4242);
          end if;
          return new;
        end $$;
        create trigger test_hold_refresh after insert on "oauthRefreshToken"
          for each row execute function test_hold_refresh();`);
      const holder = await r.pool.connect();
      try {
        await holder.query(`select pg_advisory_lock(4242)`);
        await r.pool.query(`update test_refresh_gate set armed = true`);
        // 1. The refresh passes the issuance check, rotates, writes its successor, waits.
        const racing = call(r, "POST", "/api/auth/oauth2/token", {
          origin: false,
          form: {
            grant_type: "refresh_token",
            refresh_token: String(flow.token?.json?.refresh_token),
            client_id: client,
            resource: RESOURCE,
          },
        });
        for (let attempt = 0; ; attempt++) {
          const waiting = await r.pool.query(
            `select 1 from pg_locks where locktype = 'advisory' and not granted`,
          );
          if (waiting.rows.length > 0) break;
          assert.ok(attempt < 200, "the refresh never reached its successor insert");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const rotated = await r.pool.query(
          `select "revoked" from "oauthRefreshToken" where "revoked" is not null`,
        );
        assert.equal(rotated.rows.length, 1, "the original refresh token was rotated");
        await r.pool.query(`update test_refresh_gate set armed = false`);
        // 2. The grant is revoked meanwhile.
        const deleted = await call(r, "POST", "/api/auth/oauth2/delete-consent", {
          cookie,
          body: { id: grantId },
        });
        assert.equal(deleted.response.status, 200, deleted.text);
        // 3. The same app
        const again = await authorize(r, { clientId: client, cookie, organizationId: "org-a" });
        assert.equal(again.token?.response.status, 200, again.token?.text ?? "");
        const newGrant = String(claims(String(again.token?.json?.access_token)).grant);
        assert.notEqual(newGrant, grantId);
        // 4. The successor commits
        await holder.query(`select pg_advisory_unlock(4242)`);
        const raced = await racing;
        assert.equal(raced.response.status, 400, raced.text);
        assert.equal(raced.json?.error, "invalid_grant", raced.text);
        assert.equal(raced.json?.access_token, undefined);
        assert.equal(raced.json?.refresh_token, undefined);
        // No refresh credential of the revoked grant survives: the only row
        // left is the new grant's own.
        const rows = await r.pool.query(`select "token" from "oauthRefreshToken"`);
        assert.equal(rows.rows.length, 1);
        const renewed = await call(r, "POST", "/api/auth/oauth2/token", {
          origin: false,
          form: {
            grant_type: "refresh_token",
            refresh_token: String(again.token?.json?.refresh_token),
            client_id: client,
            resource: RESOURCE,
          },
        });
        assert.equal(renewed.response.status, 200, renewed.text);
        assert.equal(claims(String(renewed.json?.access_token)).grant, newGrant);
      } finally {
        holder.release();
      }
    }, 60_000);

    test("a code exchange racing revocation never mints for the grant given again", async () => {
      const r = await realm();
      const client = String((await register(r)).json?.client_id);
      const { cookie } = await signIn(r, "user-member@example.test");
      const first = await authorize(r, { clientId: client, cookie, organizationId: "org-a" });
      const grantId = String(claims(String(first.token?.json?.access_token)).grant);
      const pending = await authorize(r, {
        clientId: client,
        cookie,
        organizationId: "org-a",
        stopBeforeExchange: true,
      });
      assert.ok(pending.code);
      // Hold the exchange at the issuance check's consent read: the provider
      // has consumed the code by then.
      const query = r.pool.query.bind(r.pool) as (...args: unknown[]) => Promise<unknown>;
      let armed = true;
      let reached!: () => void;
      const atCheck = new Promise<void>((resolve) => (reached = resolve));
      let resume!: () => void;
      const resumed = new Promise<void>((resolve) => (resume = resolve));
      (r.pool as unknown as { query: unknown }).query = async (...args: unknown[]) => {
        if (armed && String(args[0]).includes(`"referenceId" = $3 limit 2`)) {
          armed = false;
          reached();
          await resumed;
        }
        return await query(...args);
      };
      try {
        const racing = call(r, "POST", "/api/auth/oauth2/token", {
          origin: false,
          form: {
            grant_type: "authorization_code",
            code: pending.code!,
            redirect_uri: "http://localhost:51234/callback",
            client_id: client,
            code_verifier: pending.verifier,
            resource: RESOURCE,
          },
        });
        await atCheck;
        const consumed = await r.pool.query(
          `select 1 from "verification" where "value" like '{"type":"authorization_code"%'`,
        );
        assert.equal(consumed.rows.length, 0, "the code was consumed");
        // The grant is revoked, then the same app and organization granted again.
        const deleted = await call(r, "POST", "/api/auth/oauth2/delete-consent", {
          cookie,
          body: { id: grantId },
        });
        assert.equal(deleted.response.status, 200, deleted.text);
        const again = await authorize(r, { clientId: client, cookie, organizationId: "org-a" });
        assert.equal(again.token?.response.status, 200, again.token?.text ?? "");
        const newGrant = String(claims(String(again.token?.json?.access_token)).grant);
        assert.notEqual(newGrant, grantId);
        resume();
        const raced = await racing;
        assert.equal(raced.response.status, 400, raced.text);
        assert.equal(raced.json?.error, "invalid_grant", raced.text);
        assert.equal(raced.json?.access_token, undefined);
        assert.equal(raced.json?.refresh_token, undefined);
        // The only refresh credential left is the new grant's own.
        const rows = await r.pool.query(`select "token" from "oauthRefreshToken"`);
        assert.equal(rows.rows.length, 1);
      } finally {
        resume();
        (r.pool as unknown as { query: unknown }).query = query;
      }
    }, 60_000);

    test("a refresh loaded before revocation never mints for the grant given again", async () => {
      const r = await realm();
      const client = String((await register(r)).json?.client_id);
      const { cookie } = await signIn(r, "user-member@example.test");
      const first = await authorize(r, { clientId: client, cookie, organizationId: "org-a" });
      const grantId = String(claims(String(first.token?.json?.access_token)).grant);
      // Hold the refresh at the issuance check's consent read: the provider
      // has loaded the refresh row by then.
      const query = r.pool.query.bind(r.pool) as (...args: unknown[]) => Promise<unknown>;
      let armed = true;
      let reached!: () => void;
      const atCheck = new Promise<void>((resolve) => (reached = resolve));
      let resume!: () => void;
      const resumed = new Promise<void>((resolve) => (resume = resolve));
      (r.pool as unknown as { query: unknown }).query = async (...args: unknown[]) => {
        if (armed && String(args[0]).includes(`"referenceId" = $3 limit 2`)) {
          armed = false;
          reached();
          await resumed;
        }
        return await query(...args);
      };
      try {
        const racing = call(r, "POST", "/api/auth/oauth2/token", {
          origin: false,
          form: {
            grant_type: "refresh_token",
            refresh_token: String(first.token?.json?.refresh_token),
            client_id: client,
            resource: RESOURCE,
          },
        });
        await atCheck;
        await r.pool.query(`create table test_loaded_refresh as select * from "oauthRefreshToken"`);
        const loaded = await r.pool.query(`select 1 from test_loaded_refresh`);
        assert.equal(loaded.rows.length, 1);
        const deleted = await call(r, "POST", "/api/auth/oauth2/delete-consent", {
          cookie,
          body: { id: grantId },
        });
        assert.equal(deleted.response.status, 200, deleted.text);
        const again = await authorize(r, { clientId: client, cookie, organizationId: "org-a" });
        assert.equal(again.token?.response.status, 200, again.token?.text ?? "");
        const newGrant = String(claims(String(again.token?.json?.access_token)).grant);
        assert.notEqual(newGrant, grantId);
        // The sweep deleted the loaded row, so the provider's conditional
        // rotation would refuse on its own. Put it back: the binding alone
        // must refuse a credential issued under the revoked grant.
        await r.pool.query(`insert into "oauthRefreshToken" select * from test_loaded_refresh`);
        resume();
        const raced = await racing;
        assert.equal(raced.response.status, 400, raced.text);
        assert.equal(raced.json?.error, "invalid_grant", raced.text);
        assert.equal(raced.json?.access_token, undefined);
        assert.equal(raced.json?.refresh_token, undefined);
        // Nothing new was released: the restored (now rotated) row and the
        // new grant's own are the only refresh rows.
        const rows = await r.pool.query(
          `select "id" from "oauthRefreshToken" where "revoked" is null`,
        );
        assert.equal(rows.rows.length, 1);
      } finally {
        resume();
        (r.pool as unknown as { query: unknown }).query = query;
      }
    }, 60_000);

    test("a rotated key verifies at once and an expired key stops verifying", async () => {
      const r = await realm();
      const client = String((await register(r)).json?.client_id);
      const { cookie } = await signIn(r, "user-member@example.test");
      const flow = await authorize(r, { clientId: client, cookie, organizationId: "org-a" });
      const access = String(flow.token?.json?.access_token);
      // The realm's key set is now cached.
      await verify(r, access);
      // A new key: its first token verifies without waiting for the cache.
      const forge = await forger(r);
      await r.pool.query(
        `update "jwks" set "expiresAt" = now() + interval '1500 milliseconds' where "privateKey" = 'unused'`,
      );
      const rotated = forge(claims(access));
      assert.equal((await verify(r, rotated)).grantId, claims(access).grant);
      // Past its expiry the key no longer verifies; the realm's own still does.
      await new Promise((resolve) => setTimeout(resolve, 1700));
      assert.equal((await refusal(verify(r, rotated))).status, 401);
      assert.equal((await verify(r, access)).grantId, claims(access).grant);
    }, 60_000);

    test("two apps granted to one client in one organization are independent grants", async () => {
      const r = await realm();
      const client = String((await register(r)).json?.client_id);
      const { cookie } = await signIn(r, "user-member@example.test");
      const a = await authorize(r, { clientId: client, cookie, organizationId: "org-a" });
      const b = await authorize(r, {
        clientId: client,
        cookie,
        organizationId: "org-a",
        resource: RESOURCE2,
      });
      // The second app is a new grant: it went through the consent page.
      assert.ok(b.next.startsWith("/auth/oauth/consent?"), b.next);
      assert.equal(b.token?.response.status, 200, b.token?.text ?? "");
      const accessA = String(a.token?.json?.access_token);
      const accessB = String(b.token?.json?.access_token);
      const grantA = await verify(r, accessA);
      const grantB = await verify(r, accessB, APP2);
      assert.notEqual(grantA.grantId, grantB.grantId);
      assert.equal(grantA.organizationId, "org-a");
      assert.equal(grantB.organizationId, "org-a");
      // Neither token reaches the other app.
      assert.equal((await refusal(verify(r, accessA, APP2))).status, 401);
      assert.equal((await refusal(verify(r, accessB))).status, 401);
      const rows = await r.pool.query(`select "referenceId" from "oauthConsent" order by 1`);
      assert.deepEqual(
        rows.rows.map((row) => row.referenceId),
        [agentGrantReference(APP, "org-a"), agentGrantReference(APP2, "org-a")].sort(),
      );
      // Revoking app A leaves app B, its token and its refresh token.
      const deleted = await call(r, "POST", "/api/auth/oauth2/delete-consent", {
        cookie,
        body: { id: grantA.grantId },
      });
      assert.equal(deleted.response.status, 200, deleted.text);
      assert.equal((await refusal(verify(r, accessA))).status, 401);
      assert.equal((await verify(r, accessB, APP2)).grantId, grantB.grantId);
      const refresh = (token: unknown, resource: string) =>
        call(r, "POST", "/api/auth/oauth2/token", {
          origin: false,
          form: {
            grant_type: "refresh_token",
            refresh_token: String(token),
            client_id: client,
            resource,
          },
        });
      assert.equal((await refresh(a.token?.json?.refresh_token, RESOURCE)).response.status, 400);
      const rotatedB = await refresh(b.token?.json?.refresh_token, RESOURCE2);
      assert.equal(rotatedB.response.status, 200, rotatedB.text);
      assert.equal(claims(String(rotatedB.json?.access_token)).grant, grantB.grantId);
    }, 60_000);

    test("concurrent Allows for one request leave one grant", async () => {
      const r = await realm();
      const client = String((await register(r)).json?.client_id);
      const { cookie } = await signIn(r, "user-member@example.test");
      // Stop at the consent page, then accept it twice at once.
      const flow = await authorize(r, {
        clientId: client,
        cookie,
        organizationId: "org-a",
        stopAtConsent: true,
      });
      assert.ok(flow.next.startsWith("/auth/oauth/consent?"), flow.next);
      const oauthQuery = new URL(flow.next, ORIGIN).search.slice(1);
      const accept = () =>
        call(r, "POST", "/api/auth/oauth2/consent", {
          cookie,
          body: { accept: true, oauth_query: oauthQuery },
        });
      const answers = await Promise.all([accept(), accept(), accept()]);
      assert.ok(
        answers.some((answer) => String(answer.json?.url ?? "").includes("code=")),
        answers.map((answer) => answer.text).join("\n"),
      );
      const rows = await r.pool.query(`select "id" from "oauthConsent"`);
      assert.equal(rows.rows.length, 1);
    }, 60_000);

    test("re-picking an organization keeps one pick; an expired pick returns to the page", async () => {
      const r = await realm();
      const client = String((await register(r)).json?.client_id);
      const { cookie } = await signIn(r, "user-member@example.test");
      const flow = await authorize(r, {
        clientId: client,
        cookie,
        organizationId: "org-a",
        stopAtConsent: true,
      });
      const oauthQuery = new URL(flow.organizationPage, ORIGIN).search.slice(1);
      const pick = (organizationId: string) =>
        call(r, "POST", "/api/auth/agent-grant/organization", {
          cookie,
          body: { oauth_query: oauthQuery, organizationId },
        });
      assert.equal((await pick("org-b")).response.status, 200);
      const picks = await r.pool.query(
        `select "identifier", "value" from "verification" where "identifier" like 'agent-grant-organization:%'`,
      );
      assert.deepEqual(
        picks.rows.map((row) => row.value),
        ["org-b"],
      );
      const context = await call(r, "POST", "/api/auth/agent-grant/context", {
        cookie,
        body: { oauth_query: oauthQuery },
      });
      assert.equal((context.json?.picked as { id: string } | null)?.id, "org-b");
      // Past its lifetime the pick is gone: the flow returns to the page.
      await r.pool.query(
        `update "verification" set "expiresAt" = now() - interval '1 minute' where "identifier" like 'agent-grant-organization:%'`,
      );
      const continued = await call(r, "POST", "/api/auth/oauth2/continue", {
        cookie,
        body: { oauth_query: oauthQuery, postLogin: true },
      });
      assert.ok(
        String(continued.json?.url ?? "").startsWith("/auth/oauth/organization?"),
        continued.text,
      );
    }, 60_000);

    test("the verifier refuses wrong audience, issuer, signature, scope, expiry, org and lost access", async () => {
      const r = await realm();
      const client = String((await register(r)).json?.client_id);
      const { cookie } = await signIn(r, "user-member@example.test");
      const flow = await authorize(r, { clientId: client, cookie, organizationId: "org-a" });
      const access = String(flow.token?.json?.access_token);
      const forge = await forger(r);
      const now = Math.floor(Date.now() / 1000);
      const grantId = String(claims(access).grant);
      const good = {
        iss: ISSUER,
        aud: RESOURCE,
        sub: r.users.member,
        azp: client,
        client_id: client,
        org: "org-a",
        grant: grantId,
        scope: "work_session",
        iat: now,
        exp: now + 600,
      };
      assert.equal((await verify(r, forge(good))).organizationId, "org-a");
      const status = async (token: string, appId = APP) =>
        (await refusal(verify(r, token, appId))).status;
      // Another app's resource, or this token presented to another app.
      assert.equal(await status(access, "other-app"), 401);
      assert.equal(
        await status(forge({ ...good, aud: agentResourceIdentifier(ORIGIN, "x") })),
        401,
      );
      assert.equal(await status(forge({ ...good, iss: "https://elsewhere.test/api/auth" })), 401);
      assert.equal(
        await status(forge(good, generateKeyPairSync("ed25519").privateKey)),
        401,
        "signature",
      );
      assert.equal(await status(`${access.slice(0, -4)}AAAA`), 401);
      assert.equal(await status(forge({ ...good, scope: "offline_access" })), 401);
      assert.equal(await status(forge({ ...good, exp: now - 120, iat: now - 1000 })), 401);
      // An org claim the user never granted names no consent.
      assert.equal(await status(forge({ ...good, org: "org-b" })), 401);
      // A token without a grant, or naming another row, is refused.
      const { grant: _grant, ...withoutGrant } = good;
      assert.equal(await status(forge(withoutGrant)), 401);
      assert.equal(await status(forge({ ...good, grant: "another-grant" })), 401);
      // Assignment inactive, app removed from the organization, membership removed.
      await r.pool.query(
        `update "app_actor_assignment" set "active" = false where "organizationId" = 'org-a'`,
      );
      assert.equal(await status(access), 403);
      await r.pool.query(
        `update "app_actor_assignment" set "active" = true where "organizationId" = 'org-a'`,
      );
      assert.equal((await verify(r, access)).organizationId, "org-a");
      await r.pool.query(
        `update "organization" set "appIds" = '["other-app"]' where "id" = 'org-a'`,
      );
      assert.equal(await status(access), 403);
      await r.pool.query(`update "organization" set "appIds" = $1::jsonb where "id" = 'org-a'`, [
        JSON.stringify([APP]),
      ]);
      await r.pool.query(
        `delete from "member" where "organizationId" = 'org-a' and "userId" = $1`,
        [r.users.member],
      );
      assert.equal(await status(access), 403);
    }, 60_000);

    test("a Client ID Metadata Document client is identified by its verified domain", async () => {
      const clientId = "https://agent.example.com/oauth/client.json";
      const r = await realm();
      const { createAuth } = await import("../server");
      const auth = createAuth({
        appName: "Agent grant test",
        env: r.env,
        databaseOverride: r.pool,
        agentAppIds: [APP],
        fetchClientMetadata: async (input) => {
          assert.equal(String(input instanceof Request ? input.url : input), clientId);
          return Response.json(
            {
              client_id: clientId,
              client_name: "Metadata agent",
              client_uri: "https://agent.example.com",
              redirect_uris: ["http://localhost:51234/callback"],
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              token_endpoint_auth_method: "none",
            },
            { headers: { "cache-control": "max-age=60" } },
          );
        },
      });
      const withCimd = { ...r, auth };
      const { cookie } = await signIn(withCimd, "user-member@example.test");
      const flow = await authorize(withCimd, { clientId, cookie, organizationId: "org-a" });
      assert.equal(
        (flow.context.json?.client as { verifiedDomain: unknown }).verifiedDomain,
        "agent.example.com",
        flow.context.text,
      );
      assert.equal(flow.token?.response.status, 200, flow.token?.text ?? "");
      assert.equal(claims(String(flow.token?.json?.access_token)).azp, clientId);
    }, 60_000);

    test("a Client ID Metadata Document client with a private key never gets a grant", async () => {
      const clientId = "https://agent.example.com/oauth/confidential.json";
      const r = await realm();
      const { createAuth } = await import("../server");
      const { publicKey } = generateKeyPairSync("ed25519");
      const auth = createAuth({
        appName: "Agent grant test",
        env: r.env,
        databaseOverride: r.pool,
        agentAppIds: [APP],
        fetchClientMetadata: async () =>
          Response.json(
            {
              client_id: clientId,
              client_name: "Confidential agent",
              redirect_uris: ["http://localhost:51234/callback"],
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              token_endpoint_auth_method: "private_key_jwt",
              jwks: { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k", alg: "EdDSA" }] },
            },
            { headers: { "cache-control": "max-age=60" } },
          ),
      });
      const withCimd = { ...r, auth };
      const { cookie } = await signIn(withCimd, "user-member@example.test");
      const flow = await authorize(withCimd, {
        clientId,
        cookie,
        organizationId: "org-a",
        stopAtConsent: true,
      });
      assert.ok(flow.next.startsWith("/auth/oauth/consent?"), flow.next);
      const consent = await call(withCimd, "POST", "/api/auth/oauth2/consent", {
        cookie,
        body: { accept: true, oauth_query: new URL(flow.next, ORIGIN).search.slice(1) },
      });
      assert.equal(consent.response.status, 400, consent.text);
      assert.equal(consent.json?.error, "unauthorized_client", consent.text);
      const rows = await r.pool.query(`select "id" from "oauthConsent"`);
      assert.equal(rows.rows.length, 0);
    }, 60_000);
  },
);
