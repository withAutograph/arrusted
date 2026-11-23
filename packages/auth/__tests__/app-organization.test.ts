// A signed-in person with several organizations and no active one, through a
// real Better Auth email sign-in (no set-active call): the app opens in the
// only organization that grants it with an active assignment, and with
// several the person is asked to choose instead of being refused.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";

import { appOrganizationChoices, requireAppContext, type AppContextGuardOptions } from "../server";
import { readOrganizationMemberships } from "../organization-membership-access";
import {
  APP,
  APP2,
  ORIGIN,
  realm,
  signIn,
  startCluster,
  stopCluster,
  type Realm,
  USER_PASSWORD,
} from "./agent-grant-fixture";

/**
 * The repository's local user bootstrap (`mise run auth:user:bootstrap-local`,
 * which every local app runtime start runs) against this realm, for the member.
 */
const bootstrapLocal = (r: Realm) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(
      "bun",
      [
        path.resolve(
          import.meta.dirname,
          "../../../.config/mise/scripts/repository/auth-bootstrap-local.ts",
        ),
      ],
      {
        env: {
          ...process.env,
          PLATFORM_AUTH_DATABASE_URL: r.env.PLATFORM_AUTH_DATABASE_URL,
          PLATFORM_LOCAL_AUTH_EMAILS: "user-member@example.test",
          PLATFORM_LOCAL_AUTH_PASSWORD: USER_PASSWORD,
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`bootstrap-local failed: ${stderr}`)),
    );
  });

/** The session's stored active organization, read without refreshing it. */
const activeOf = async (r: Realm, cookie: string) => {
  const session = await r.auth.api.getSession({
    headers: browser(cookie),
    query: { disableRefresh: true },
  });
  return (
    (session?.session as { activeOrganizationId?: string | null } | undefined)
      ?.activeOrganizationId ?? null
  );
};

/** A browser request's headers on the realm's origin, with the session cookie when signed in. */
const browser = (cookie?: string) =>
  new Headers({ host: new URL(ORIGIN).host, origin: ORIGIN, ...(cookie ? { cookie } : {}) });

/** The guard as an app wires it, over this realm's Auth API and database. */
const guard = (r: Realm, appId: string): AppContextGuardOptions => ({
  appId: appId as AppContextGuardOptions["appId"],
  getSession: (headers) => r.auth.api.getSession({ headers }),
  listOrganizations: (headers) => r.auth.api.listOrganizations({ headers }),
  loadOrganizationMemberships: async (input) => await readOrganizationMemberships(r.pool, input),
  verifyTenantMembership: async (headers, scope) =>
    (await r.auth.api.listOrganizations({ headers })).some(
      (organization) => organization.id === scope.organizationId,
    ),
  loadAppActorRoles: async (input) =>
    (
      await r.pool.query(
        `select "role" from "app_actor_assignment"
         where "actorId"=$1 and "organizationId"=$2 and "appId"=$3 and "active"=true order by "role"`,
        [input.actorId, input.organizationId, input.appId],
      )
    ).rows.map((row) => row.role as string),
});

describe.skipIf(process.env.AUTH_AGENT_GRANT_POSTGRES !== "1")(
  "the app's organization for a person with several",
  () => {
    beforeAll(startCluster, 120_000);
    afterAll(stopCluster, 60_000);

    test("after a plain email sign-in the session has no active organization", async () => {
      const r = await realm();
      const { cookie, status } = await signIn(r, "user-member@example.test");
      assert.equal(status, 200);
      const session = await r.auth.api.getSession({ headers: browser(cookie) });
      // The organization plugin's session field.
      const active = (session?.session as { activeOrganizationId?: string | null } | undefined)
        ?.activeOrganizationId;
      assert.equal(active ?? null, null);
    }, 60_000);

    test("the only organization that opens the app is used without a choice", async () => {
      const r = await realm();
      const { cookie } = await signIn(r, "user-member@example.test");
      const headers = browser(cookie);
      // org-a and org-b grant APP, but only org-a grants APP2.
      const context = await requireAppContext(headers, guard(r, APP2));
      assert.equal(context.scope.customerId, "org-a");
      assert.deepEqual(context.roles, ["member"]);
      // An organization that grants the app without an active assignment is no choice.
      await r.pool.query(
        `update "app_actor_assignment" set "active"=false where "organizationId"='org-b'`,
      );
      assert.equal((await requireAppContext(headers, guard(r, APP))).scope.customerId, "org-a");
    }, 60_000);

    test("with several, the person is asked to choose; a chosen organization opens", async () => {
      const r = await realm();
      const { cookie } = await signIn(r, "user-member@example.test");
      const headers = browser(cookie);
      await assert.rejects(requireAppContext(headers, guard(r, APP)), {
        code: "tenant_required",
        status: 403,
      });
      const choices = await appOrganizationChoices(headers, guard(r, APP));
      assert.deepEqual(
        // The order is not part of the answer.
        choices.map((organization) => organization.id).toSorted(),
        ["org-a", "org-b"],
      );
      // The chooser sets the active organization through Better Auth.
      await r.auth.api.setActiveOrganization({ headers, body: { organizationId: "org-b" } });
      assert.equal((await requireAppContext(headers, guard(r, APP))).scope.customerId, "org-b");
    }, 60_000);

    test("concurrent reads keep the chosen organization while the local bootstrap runs", async () => {
      const r = await realm();
      const { cookie } = await signIn(r, "user-member@example.test");
      const headers = browser(cookie);
      await r.auth.api.setActiveOrganization({ headers, body: { organizationId: "org-b" } });
      // A second sign-in, which has not chosen an organization yet.
      const unchosen = await signIn(r, "user-member@example.test");
      const reads = () =>
        Promise.allSettled(
          Array.from({ length: 24 }, () => requireAppContext(headers, guard(r, APP))),
        );
      // The realm's \`dev\` organization grants every catalog app, the member
      // holds no app role there, and a live server shares the realm with
      // every local runtime start's bootstrap.
      const [during] = await Promise.all([reads(), bootstrapLocal(r)]);
      const after = await reads();
      for (const result of [...during, ...after]) {
        if (result.status === "rejected") throw result.reason;
        assert.equal(result.value.scope.customerId, "org-b");
      }
      // The member holds no app role in \`dev\`: a session without an
      // organization is left for each app's guard.
      assert.equal(await activeOf(r, unchosen.cookie), null);
    }, 60_000);

    test("the local bootstrap gives a session only an organization with an app role", async () => {
      const r = await realm();
      await r.pool.query(
        `insert into "app_actor_assignment" ("organizationId","actorId","appId","role","active","fence_generation")
         values ('dev',$1,$2,'member',true,1)`,
        [r.users.member, APP],
      );
      const chosen = await signIn(r, "user-member@example.test");
      await r.auth.api.setActiveOrganization({
        headers: browser(chosen.cookie),
        body: { organizationId: "org-b" },
      });
      const unchosen = await signIn(r, "user-member@example.test");
      await bootstrapLocal(r);
      assert.equal(await activeOf(r, unchosen.cookie), "dev");
      assert.equal(await activeOf(r, chosen.cookie), "org-b");
    }, 60_000);

    test("an active organization that does not open the app: the only one that does is used", async () => {
      const r = await realm();
      const { cookie } = await signIn(r, "user-member@example.test");
      const headers = browser(cookie);
      // org-c grants another app only; only org-a opens APP2.
      await r.auth.api.setActiveOrganization({ headers, body: { organizationId: "org-c" } });
      const context = await requireAppContext(headers, guard(r, APP2));
      assert.equal(context.scope.customerId, "org-a");
      assert.deepEqual(context.roles, ["member"]);
      // For this request only: the session keeps the person's choice.
      assert.equal(await activeOf(r, cookie), "org-c");
      // An organization that grants the app but holds no role for the person is no access either.
      await r.pool.query(
        `update "app_actor_assignment" set "active"=false where "organizationId"='org-b'`,
      );
      await r.auth.api.setActiveOrganization({ headers, body: { organizationId: "org-b" } });
      assert.equal((await requireAppContext(headers, guard(r, APP))).scope.customerId, "org-a");
      // A named organization is never redirected.
      await assert.rejects(
        requireAppContext(headers, { ...guard(r, APP), customerId: "org-b" as never }),
        { code: "app_access_required", status: 403 },
      );
    }, 60_000);

    test("an active organization that does not open the app, with several that do: the person chooses", async () => {
      const r = await realm();
      const { cookie } = await signIn(r, "user-member@example.test");
      const headers = browser(cookie);
      await r.auth.api.setActiveOrganization({ headers, body: { organizationId: "org-c" } });
      await assert.rejects(requireAppContext(headers, guard(r, APP)), {
        code: "tenant_required",
        status: 403,
      });
      assert.deepEqual(
        (await appOrganizationChoices(headers, guard(r, APP)))
          .map((organization) => organization.id)
          .toSorted(),
        ["org-a", "org-b"],
      );
    }, 60_000);

    test("an active organization that does not open the app, and none that does: refused", async () => {
      const r = await realm();
      const { cookie } = await signIn(r, "user-member@example.test");
      const headers = browser(cookie);
      await r.pool.query(`update "app_actor_assignment" set "active"=false`);
      await r.auth.api.setActiveOrganization({ headers, body: { organizationId: "org-c" } });
      await assert.rejects(requireAppContext(headers, guard(r, APP)), {
        code: "app_access_required",
        status: 403,
      });
    }, 60_000);

    test("a missing required role in an organization that opens the app is never redirected", async () => {
      const r = await realm();
      const { cookie } = await signIn(r, "user-member@example.test");
      const headers = browser(cookie);
      // Approver in org-a only; org-b is active and opens the app as member.
      await r.pool.query(
        `insert into "app_actor_assignment" ("organizationId","actorId","appId","role","active","fence_generation")
         values ('org-a',$1,$2,'approver',true,1)`,
        [r.users.member, APP],
      );
      await r.auth.api.setActiveOrganization({ headers, body: { organizationId: "org-b" } });
      await assert.rejects(
        requireAppContext(headers, { ...guard(r, APP), requiredRole: "approver" }),
        { code: "app_access_required", status: 403 },
      );
    }, 60_000);

    test("signed out there is no choice", async () => {
      const r = await realm();
      assert.deepEqual(await appOrganizationChoices(browser(), guard(r, APP)), []);
    }, 60_000);
  },
);
