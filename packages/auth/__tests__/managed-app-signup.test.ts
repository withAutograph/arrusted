// @vitest-environment node
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { verifyAuthOperatorConnection } from "../../protected-installer/auth-operator";
import {
  claimManagedAppSignup,
  completeManagedAppSignup,
  disableManagedAppSignupPolicy,
  persistManagedAppSignupPolicy,
  readManagedAppSignupAccess,
  readManagedAppSignupClaim,
  resolveManagedAppSignupIntent,
  managedAppSignupPolicyInputSchema,
  assertManagedAppSignupGrant,
  readManagedAppSignupRecordedGrant,
} from "../managed-app-signup";
import { setManagedFrontendAccess } from "../managed-app-access";
import { authDatabaseResourceDigest } from "../signup-policy";
import { startCluster, stopCluster, realm as createFixture } from "./agent-grant-fixture";
import type { ManagedProductionRealm } from "../public-realm-enrollment";

const scope = { appId: "signup-fixture", organizationId: "org-a" };
const operationRef = randomUUID();
const grantOperationRef = randomUUID();
const policyInput = {
  version: 1 as const,
  policyId: randomUUID(),
  eligibility: "public" as const,
  appRoles: [],
  storage: "none" as const,
  appPath: "/signup-fixture",
};
const managedRealm: ManagedProductionRealm = {
  version: 1,
  kind: "managed-production-realm-v1",
  workspaceId: "signup-workspace",
  repositoryId: "123",
  repositoryFullName: "owner/fixture",
  authResourceId: "fixture-auth",
  authorizedOrganizationIds: ["org-a"],
  publicOrigin: "https://apps.example.test",
  project: { projectId: "fixture-project", ownerId: "fixture-team", environment: "production" },
  resource: {
    version: 1,
    environment: "production",
    hostname: "fixture-auth.neon.tech",
    port: 5432,
    database: "auth_fixture",
    schema: "public",
    runtimeRole: "signup_runtime",
    migratorRole: "auth_migrator",
    neon: { projectId: "neon-fixture", branchId: "branch-fixture" },
  },
};
async function setup(
  input: Partial<Parameters<typeof persistManagedAppSignupPolicy>[2]["policy"]> = {},
) {
  const fixture = await createFixture();
  await fixture.pool.query(
    `do $$ begin if not exists(select 1 from pg_roles where rolname='signup_runtime') then create role signup_runtime; end if; end $$`,
  );
  const runtimeSql = await readFile(new URL("../runtime-privileges.sql", import.meta.url), "utf8");
  await fixture.pool.query(
    runtimeSql
      .replaceAll("__RUNTIME_ROLE_LITERAL__", "'signup_runtime'")
      .replaceAll("__RUNTIME_ROLE__", '"signup_runtime"'),
  );
  await fixture.pool.query(
    `insert into public.session(id,"userId",token,"expiresAt","updatedAt","activeOrganizationId") values('signup-session','user-member','fixture-token',now()+interval '1 hour',now(),'org-a')`,
  );
  const policy = await persistManagedAppSignupPolicy(fixture.pool, managedRealm, {
    ...scope,
    policy: { ...policyInput, ...input },
    operationRef,
    planDigest: "a".repeat(64),
    fenceGeneration: 1,
  });
  const identity = {
    policyId: policy.policyId,
    policyDigest: policy.policyDigest,
    actorId: "user-member",
    sessionId: "signup-session",
  };
  const claim = () => claimManagedAppSignup(fixture.pool, managedRealm, identity);
  return { ...fixture, policy, identity, claim };
}
async function grant(
  fixture: Awaited<ReturnType<typeof setup>>,
  generation = 2,
  op = grantOperationRef,
) {
  const claim = await fixture.claim();
  if (!claim) throw new Error("Expected verified claim");
  const client = await fixture.pool.connect();
  try {
    await setManagedFrontendAccess(
      client,
      {
        ...scope,
        workspaceId: managedRealm.workspaceId,
        actorId: claim.actorId,
        roles: claim.appRoles,
        active: true,
        fenceGeneration: generation,
        operationRef: op,
        signupClaim: {
          policyId: claim.policyId,
          claimId: claim.id,
          scopeDigest: claim.scopeDigest,
        },
      },
      async () => {},
    );
  } finally {
    client.release();
  }
  return claim;
}
describe("managed signup schema", () => {
  it("allows explicit domain roles and existing roleless admission for both storage modes", () => {
    expect(managedAppSignupPolicyInputSchema.safeParse(policyInput).success).toBe(true);
    expect(
      managedAppSignupPolicyInputSchema.safeParse({ ...policyInput, storage: "postgres" }).success,
    ).toBe(true);
    expect(
      managedAppSignupPolicyInputSchema.safeParse({ ...policyInput, appRoles: ["asset_owner"] })
        .success,
    ).toBe(true);
    for (const patch of [
      { appRoles: ["invalid role"] },
      { appRoles: ["reader", "reader"] },
      { appPath: "//foreign.test" },
    ]) {
      expect(
        managedAppSignupPolicyInputSchema.safeParse({ ...policyInput, ...patch }).success,
      ).toBe(false);
    }
  });
});
describe.skipIf(process.env.AUTH_AGENT_GRANT_POSTGRES !== "1")(
  "managed signup PostgreSQL authority",
  () => {
    beforeAll(startCluster, 120_000);
    afterAll(stopCluster, 60_000);
    it("revises the entry route with restricted operator credentials and invalidates old claims", async () => {
      const f = await setup();
      const oldClaim = await f.claim();
      if (!oldClaim) throw new Error("Expected original claim");
      const operatorRole = `signup_operator_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const password = randomUUID();
      await f.pool.query(`create role ${operatorRole} login password '${password}'`);
      await f.pool.query(`revoke create on schema public from public`);
      await f.pool.query(await readFile(new URL("../operator-locks.sql", import.meta.url), "utf8"));
      await f.pool.query(
        (await readFile(new URL("../operator-privileges.sql", import.meta.url), "utf8"))
          .replaceAll("__OPERATOR_ROLE_LITERAL__", `'${operatorRole}'`)
          .replaceAll("__OPERATOR_ROLE__", `"${operatorRole}"`),
      );
      const connection = new URL(f.env.PLATFORM_AUTH_DATABASE_URL);
      connection.username = operatorRole;
      connection.password = password;
      const operator = new Pool({ connectionString: connection.toString(), max: 1 });
      const client = await operator.connect();
      const revision = {
        ...scope,
        policy: { ...policyInput, appPath: "/signup-fixture/inbox" },
        operationRef: randomUUID(),
        planDigest: "b".repeat(64),
        fenceGeneration: 2,
      };
      try {
        await verifyAuthOperatorConnection(
          client,
          {
            environment: "local",
            hostname: connection.hostname,
            port: Number(connection.port),
            database: connection.pathname.slice(1),
            schema: "public",
            migratorRole: "postgres",
            runtimeRole: "signup_runtime",
          },
          operatorRole,
        );
        const revised = await persistManagedAppSignupPolicy(client, managedRealm, revision);
        expect(revised).toMatchObject({
          ...scope,
          policyId: f.policy.policyId,
          appPath: revision.policy.appPath,
          returnUrl: `${managedRealm.publicOrigin}${revision.policy.appPath}`,
          operationRef: revision.operationRef,
          planDigest: revision.planDigest,
          fenceGeneration: 2,
        });
        expect(revised.policyDigest).not.toBe(f.policy.policyDigest);
        expect(await persistManagedAppSignupPolicy(client, managedRealm, revision)).toEqual(
          revised,
        );
        expect(
          await resolveManagedAppSignupIntent(f.pool, managedRealm, { appUrl: f.policy.returnUrl }),
        ).toBeNull();
        expect(
          await resolveManagedAppSignupIntent(f.pool, managedRealm, { appUrl: revised.returnUrl }),
        ).toEqual(revised);
        expect(await f.claim()).toBeNull();
        expect(
          await readManagedAppSignupClaim(f.pool, managedRealm, {
            ...scope,
            policyId: oldClaim.policyId,
            claimId: oldClaim.id,
          }),
        ).toMatchObject({ status: "rejected" });
        await f.pool.query(
          `insert into public.session(id,"userId",token,"expiresAt","updatedAt") values('revised-signup-session','user-other','revised-token',now()+interval '1 hour',now())`,
        );
        expect(
          await claimManagedAppSignup(f.pool, managedRealm, {
            policyId: revised.policyId,
            policyDigest: revised.policyDigest,
            actorId: "user-other",
            sessionId: "revised-signup-session",
          }),
        ).toMatchObject({ status: "verified", returnUrl: revised.returnUrl });
        await expect(
          client.query(`update public.app_signup_policy set "organizationId"='org-b'`),
        ).rejects.toThrow(/permission denied/u);
      } finally {
        client.release();
        await operator.end();
      }
    }, 30_000);
    it("accepts exact retries but refuses stale fences, changed equal-fence approvals and foreign policy identity", async () => {
      const f = await setup();
      const original = {
        ...scope,
        policy: policyInput,
        operationRef,
        planDigest: "a".repeat(64),
        fenceGeneration: 1,
      };
      expect(await persistManagedAppSignupPolicy(f.pool, managedRealm, original)).toEqual(f.policy);
      const revised = {
        ...original,
        policy: { ...policyInput, appPath: "/signup-fixture/inbox" },
        operationRef: randomUUID(),
        planDigest: "b".repeat(64),
        fenceGeneration: 3,
      };
      const current = await persistManagedAppSignupPolicy(f.pool, managedRealm, revised);
      for (const stale of [
        { ...original, fenceGeneration: 2 },
        { ...original, fenceGeneration: 3 },
        { ...revised, operationRef: randomUUID() },
        { ...revised, planDigest: "c".repeat(64) },
        { ...revised, appId: "another-app", fenceGeneration: 4 },
        { ...revised, organizationId: "org-b", fenceGeneration: 4 },
      ]) {
        await expect(
          persistManagedAppSignupPolicy(
            f.pool,
            { ...managedRealm, authorizedOrganizationIds: ["org-a", "org-b"] },
            stale,
          ),
        ).rejects.toThrow("app_signup_policy_conflict");
      }
      for (const foreign of [
        { ...managedRealm, workspaceId: "foreign-workspace" },
        { ...managedRealm, authResourceId: "foreign-auth" },
        { ...managedRealm, publicOrigin: "https://foreign.example.test" },
        { ...managedRealm, resource: { ...managedRealm.resource, database: "foreign_database" } },
      ]) {
        await expect(
          persistManagedAppSignupPolicy(f.pool, foreign, { ...revised, fenceGeneration: 4 }),
        ).rejects.toThrow("app_signup_policy_conflict");
      }
      expect(await persistManagedAppSignupPolicy(f.pool, managedRealm, revised)).toEqual(current);
    }, 30_000);
    it("mints one verified same-session claim without membership or access grants", async () => {
      const f = await setup();
      const claim = await f.claim();
      expect(claim).toMatchObject({
        ...scope,
        actorId: "user-member",
        sessionId: "signup-session",
        status: "verified",
        accessState: "absent",
        memberPrepared: true,
        appRoles: [],
      });
      expect((await f.claim())?.id).toBe(claim?.id);
      expect(
        (
          await f.pool.query(`select public.enroll_app_signup_user($1,$2,$3,$4,$5) as result`, [
            f.identity.actorId,
            f.identity.sessionId,
            authDatabaseResourceDigest(managedRealm.resource),
            managedRealm.publicOrigin,
            f.policy.appPath,
          ])
        ).rows[0]?.result,
      ).toEqual({ status: "waiting_for_signup" });
      expect(
        await claimManagedAppSignup(f.pool, managedRealm, { ...f.identity, sessionId: "missing" }),
      ).toBeNull();
      expect(
        await claimManagedAppSignup(f.pool, managedRealm, { ...f.identity, actorId: "user-other" }),
      ).toBeNull();
      expect(
        (
          await f.pool.query(`select 1 from public.app_actor_access where "appId"=$1`, [
            scope.appId,
          ])
        ).rows,
      ).toEqual([]);
      expect(
        (
          await f.pool.query(`select 1 from public.app_actor_assignment where "appId"=$1`, [
            scope.appId,
          ])
        ).rows,
      ).toEqual([]);
    }, 30_000);
    it("checks real email verification, live session, policy identity, email list and exact origin before a new claim", async () => {
      const f = await setup();
      expect(
        await resolveManagedAppSignupIntent(f.pool, managedRealm, {
          appUrl: "https://foreign.test/signup-fixture",
        }),
      ).toBeNull();
      expect(
        await resolveManagedAppSignupIntent(f.pool, managedRealm, { appUrl: f.policy.returnUrl }),
      ).toMatchObject({ policyId: f.policy.policyId });
      await f.pool.query(`update public."user" set "emailVerified"=false where id='user-member'`);
      expect(await f.claim()).toBeNull();
      await f.pool.query(`update public."user" set "emailVerified"=true where id='user-member'`);
      await f.pool.query(
        `update public.session set "expiresAt"=now()-interval '1 minute' where id='signup-session'`,
      );
      expect(await f.claim()).toBeNull();
      expect(
        await claimManagedAppSignup(f.pool, managedRealm, {
          ...f.identity,
          policyDigest: "b".repeat(64),
        }),
      ).toBeNull();
    }, 30_000);
    it("binds approved-email eligibility and refuses a cancelled claim or foreign grant operation", async () => {
      const denied = await setup({
        eligibility: "approved-email",
        allowedEmails: ["another@example.test"],
      });
      expect(await denied.claim()).toBeNull();
      expect(
        await resolveManagedAppSignupIntent(denied.pool, managedRealm, {
          appUrl: denied.policy.returnUrl,
          email: "user-member@example.test",
        }),
      ).toBeNull();
      const accepted = await setup({
        eligibility: "approved-email",
        allowedEmails: ["USER-MEMBER@example.test"],
      });
      const claim = await grant(accepted);
      await expect(grant(accepted, 3, randomUUID())).rejects.toThrow();
      if (!claim) throw new Error("Expected claim");
      await accepted.pool.query(
        `update public.app_access_invitation set status='cancelled' where id=$1`,
        [claim.id],
      );
      expect(await accepted.claim()).toBeNull();
      await expect(grant(accepted, 3)).rejects.toThrow();
    }, 30_000);
    it("the runtime can claim but cannot write policy or positive app authority", async () => {
      const f = await setup();
      const client = await f.pool.connect();
      try {
        await client.query("set role signup_runtime");
        expect(await claimManagedAppSignup(client, managedRealm, f.identity)).toMatchObject({
          status: "verified",
        });
        await expect(
          client.query(`update public.app_signup_policy set enabled=false`),
        ).rejects.toThrow(/permission denied/u);
        await expect(
          client.query(
            `insert into public.app_actor_access values('org-a','user-member','signup-fixture','signup-workspace',true,'[]',1)`,
          ),
        ).rejects.toThrow(/permission denied/u);
      } finally {
        await client.query("reset role");
        client.release();
      }
    }, 30_000);
    it("requires protected positive admission before completion and reconciles the same claim at a newer fence", async () => {
      const f = await setup();
      const claim = await f.claim();
      if (!claim) throw new Error("Expected claim");
      const proof = {
        ...scope,
        policyId: claim.policyId,
        claimId: claim.id,
        scopeDigest: claim.scopeDigest,
        actorId: claim.actorId,
        fenceGeneration: 2,
      };
      await expect(completeManagedAppSignup(f.pool, managedRealm, proof)).rejects.toThrow();
      await grant(f, 2);
      await grant(f, 3);
      expect(
        await completeManagedAppSignup(f.pool, managedRealm, { ...proof, fenceGeneration: 3 }),
      ).toMatchObject({ status: "applied", accessState: "active" });
      expect(await readManagedAppSignupAccess(f.pool, managedRealm, f.identity)).toEqual({
        status: "ready",
        appUrl: f.policy.returnUrl,
      });
      expect((await f.claim())?.id).toBe(claim.id);
    }, 30_000);
    it("cannot restore revoked or established access with a fresh claim or a higher fence", async () => {
      const f = await setup();
      await f.pool.query(
        `insert into public.app_actor_access("organizationId","actorId","appId","workspaceId",active,roles,"fenceGeneration") values('org-a','user-member',$1,$2,false,'[]',2)`,
        [scope.appId, managedRealm.workspaceId],
      );
      expect(await f.claim()).toBeNull();
      await f.pool.query(`update public.app_actor_access set active=true`);
      expect(await f.claim()).toBeNull();
      const pending = await setup();
      const claim = await grant(pending);
      await pending.pool.query(
        `update public.app_actor_access set active=false,"fenceGeneration"=3`,
      );
      expect(
        await readManagedAppSignupClaim(pending.pool, managedRealm, {
          ...scope,
          policyId: claim.policyId,
          claimId: claim.id,
        }),
      ).toMatchObject({ status: "rejected", accessState: "revoked" });
      await expect(grant(pending, 4)).rejects.toThrow();
      expect(
        await readManagedAppSignupAccess(pending.pool, managedRealm, pending.identity),
      ).toBeNull();
    }, 30_000);
    it("disabling retains the policy tombstone and existing access, and stops new claims", async () => {
      const f = await setup();
      const claim = await grant(f);
      await completeManagedAppSignup(f.pool, managedRealm, {
        ...scope,
        policyId: claim.policyId,
        claimId: claim.id,
        scopeDigest: claim.scopeDigest,
        actorId: claim.actorId,
        fenceGeneration: 2,
      });
      expect(
        await disableManagedAppSignupPolicy(f.pool, managedRealm, {
          ...scope,
          policyId: f.policy.policyId,
          policyDigest: f.policy.policyDigest,
          fenceGeneration: 3,
        }),
      ).toMatchObject({ enabled: false, policyDigest: f.policy.policyDigest });
      expect(
        await resolveManagedAppSignupIntent(f.pool, managedRealm, { appUrl: f.policy.returnUrl }),
      ).toBeNull();
      expect(await readManagedAppSignupAccess(f.pool, managedRealm, f.identity)).toMatchObject({
        status: "ready",
      });
      await f.pool.query(
        `insert into public.session(id,"userId",token,"expiresAt","updatedAt") values('disabled-policy-session','user-other','disabled-policy-token',now()+interval '1 hour',now())`,
      );
      expect(
        await claimManagedAppSignup(f.pool, managedRealm, {
          ...f.identity,
          actorId: "user-other",
          sessionId: "disabled-policy-session",
        }),
      ).toBeNull();
      const unrelated = await f.pool.query(
        `select active from public.app_actor_assignment where "appId"='canvas'`,
      );
      expect(unrelated.rows.every((row) => row.active === true)).toBe(true);
    }, 30_000);
    it("renews only a never-granted expired claim and invalidates its original proof", async () => {
      const f = await setup();
      const claim = await f.claim();
      if (!claim) throw new Error("Expected claim");
      await f.pool.query(
        `update public.app_access_invitation set "expiresAt"=now()-interval '1 second' where id=$1`,
        [claim.id],
      );
      const renewed = await f.claim();
      expect(renewed).toMatchObject({
        id: claim.id,
        status: "verified",
        accessState: "absent",
        grantReserved: false,
      });
      expect(renewed?.scopeDigest).not.toBe(claim.scopeDigest);
      expect(
        await readManagedAppSignupClaim(f.pool, managedRealm, {
          ...scope,
          policyId: claim.policyId,
          claimId: claim.id,
        }),
      ).toMatchObject({ status: "verified", grantReserved: false });
      const client = await f.pool.connect();
      try {
        await expect(
          setManagedFrontendAccess(
            client,
            {
              ...scope,
              workspaceId: managedRealm.workspaceId,
              actorId: claim.actorId,
              roles: claim.appRoles,
              active: true,
              fenceGeneration: 2,
              operationRef: grantOperationRef,
              signupClaim: {
                policyId: claim.policyId,
                claimId: claim.id,
                scopeDigest: claim.scopeDigest,
              },
            },
            async () => {},
          ),
        ).rejects.toThrow("app_signup_claim_unavailable");
      } finally {
        client.release();
      }
      expect((await f.claim())?.grantReserved).toBe(false);
      expect(
        await claimManagedAppSignup(
          f.pool,
          { ...managedRealm, workspaceId: "foreign" },
          f.identity,
        ),
      ).toBeNull();
    }, 30_000);
    it("renews a never-granted claim for a new verified session or current approved route", async () => {
      const f = await setup();
      const claim = await f.claim();
      if (!claim) throw new Error("Expected claim");
      await f.pool.query(`delete from public.session where id='signup-session'`);
      await f.pool.query(
        `insert into public.session(id,"userId",token,"expiresAt","updatedAt") values('renewed-session','user-member','renewed-token',now()+interval '1 hour',now())`,
      );
      const newIdentity = { ...f.identity, sessionId: "renewed-session" };
      const rebound = await claimManagedAppSignup(f.pool, managedRealm, newIdentity);
      expect(rebound).toMatchObject({
        id: claim.id,
        status: "verified",
        sessionId: "renewed-session",
        grantReserved: false,
      });
      expect(rebound?.scopeDigest).not.toBe(claim.scopeDigest);
      const revision = await persistManagedAppSignupPolicy(f.pool, managedRealm, {
        ...scope,
        policy: { ...policyInput, appPath: "/signup-fixture/current" },
        operationRef: randomUUID(),
        planDigest: "d".repeat(64),
        fenceGeneration: 3,
      });
      const revised = await claimManagedAppSignup(f.pool, managedRealm, {
        ...newIdentity,
        policyDigest: revision.policyDigest,
      });
      expect(revised).toMatchObject({
        id: claim.id,
        status: "verified",
        policyDigest: revision.policyDigest,
        returnUrl: revision.returnUrl,
        grantReserved: false,
      });
      expect(revised?.scopeDigest).not.toBe(rebound?.scopeDigest);
    }, 30_000);
    it("keeps reserved, cancelled and access-history claims immutable instead of renewing them", async () => {
      const f = await setup();
      const claim = await f.claim();
      if (!claim) throw new Error("Expected claim");
      const client = await f.pool.connect();
      try {
        await client.query("begin");
        await client.query("select id from public.organization where id=$1 for update", [
          scope.organizationId,
        ]);
        await assertManagedAppSignupGrant(client, {
          ...scope,
          proof: { policyId: claim.policyId, claimId: claim.id, scopeDigest: claim.scopeDigest },
          workspaceId: managedRealm.workspaceId,
          storage: "none",
          actorId: claim.actorId,
          appRoles: claim.appRoles,
          fenceGeneration: 2,
          operationRef: grantOperationRef,
        });
        await client.query("commit");
      } finally {
        client.release();
      }
      await f.pool.query(
        `update public.app_access_invitation set "expiresAt"=now()-interval '1 second' where id=$1`,
        [claim.id],
      );
      expect(await f.claim()).toBeNull();
      expect(
        await readManagedAppSignupClaim(f.pool, managedRealm, {
          ...scope,
          policyId: claim.policyId,
          claimId: claim.id,
        }),
      ).toMatchObject({
        id: claim.id,
        status: "rejected",
        accessState: "absent",
        grantReserved: true,
        scopeDigest: claim.scopeDigest,
      });
      const cancelled = await setup();
      const cancelledClaim = await cancelled.claim();
      if (!cancelledClaim) throw new Error("Expected cancelled claim");
      await cancelled.pool.query(
        `update public.app_access_invitation set status='cancelled' where id=$1`,
        [cancelledClaim.id],
      );
      expect(await cancelled.claim()).toBeNull();
      const revoked = await setup();
      const revokedClaim = await revoked.claim();
      if (!revokedClaim) throw new Error("Expected never-granted claim");
      await revoked.pool.query(
        `update public.app_access_invitation set "expiresAt"=now()-interval '1 second' where id=$1`,
        [revokedClaim.id],
      );
      await revoked.pool.query(
        `insert into public.app_actor_access("organizationId","actorId","appId","workspaceId",active,roles,"fenceGeneration") values('org-a','user-member',$1,$2,false,'[]',2)`,
        [scope.appId, managedRealm.workspaceId],
      );
      expect(await revoked.claim()).toBeNull();
    }, 30_000);
    it("serializes never-granted renewal behind the committed protected reservation", async () => {
      const f = await setup();
      const claim = await f.claim();
      if (!claim) throw new Error("Expected claim");
      await f.pool.query(
        `insert into public.session(id,"userId",token,"expiresAt","updatedAt") values('racing-session','user-member','racing-token',now()+interval '1 hour',now())`,
      );
      const owner = await f.pool.connect();
      const renewer = await f.pool.connect();
      let renewal: ReturnType<typeof claimManagedAppSignup> | undefined;
      try {
        await owner.query("begin");
        await owner.query("select id from public.organization where id=$1 for update", [
          scope.organizationId,
        ]);
        await assertManagedAppSignupGrant(owner, {
          ...scope,
          proof: { policyId: claim.policyId, claimId: claim.id, scopeDigest: claim.scopeDigest },
          workspaceId: managedRealm.workspaceId,
          storage: "none",
          actorId: claim.actorId,
          appRoles: claim.appRoles,
          fenceGeneration: 2,
          operationRef: grantOperationRef,
        });
        const pid = (await renewer.query("select pg_backend_pid() as pid")).rows[0]!.pid;
        renewal = claimManagedAppSignup(renewer, managedRealm, {
          ...f.identity,
          sessionId: "racing-session",
        });
        const deadline = Date.now() + 5000;
        let blocked = false;
        while (Date.now() < deadline) {
          const activity = await f.pool.query(
            "select wait_event_type from pg_stat_activity where pid=$1",
            [pid],
          );
          if (activity.rows[0]?.wait_event_type === "Lock") {
            blocked = true;
            break;
          }
        }
        expect(blocked).toBe(true);
        await owner.query("commit");
        expect(await renewal).toBeNull();
        expect(await f.claim()).toMatchObject({
          id: claim.id,
          scopeDigest: claim.scopeDigest,
          grantReserved: true,
        });
      } finally {
        await owner.query("rollback");
        await renewal;
        owner.release();
        renewer.release();
      }
    }, 30_000);
    it("observes an existing Auth-only grant after expiry, sign-out and signup disablement without granting", async () => {
      const f = await setup();
      const claim = await grant(f);
      const proof = { policyId: claim.policyId, claimId: claim.id, scopeDigest: claim.scopeDigest };
      const receipt = { operationRef: grantOperationRef, fenceGeneration: 2 };
      await f.pool.query(
        `update public.app_access_invitation set "expiresAt"=now()-interval '1 second' where id=$1`,
        [claim.id],
      );
      await f.pool.query(`delete from public.session where id='signup-session'`);
      await disableManagedAppSignupPolicy(f.pool, managedRealm, {
        ...scope,
        policyId: claim.policyId,
        policyDigest: claim.policyDigest,
        fenceGeneration: 3,
      });
      expect(
        await readManagedAppSignupClaim(f.pool, managedRealm, { ...scope, ...proof }),
      ).toMatchObject({
        status: "rejected",
        accessState: "active",
        recordedGrant: receipt,
        grantReserved: true,
      });
      const snapshot = async () => ({
        claim: (
          await f.pool.query(
            `select to_jsonb(i) value from public.app_access_invitation i where id=$1`,
            [claim.id],
          )
        ).rows,
        access: (
          await f.pool.query(
            `select to_jsonb(a) value from public.app_actor_access a where "actorId"=$1`,
            [claim.actorId],
          )
        ).rows,
      });
      const before = await snapshot();
      const readonlyPool = new Pool({
        connectionString: f.env.PLATFORM_AUTH_DATABASE_URL,
        max: 1,
        options: "-c default_transaction_read_only=on",
      });
      const input = {
        ...scope,
        proof,
        workspaceId: managedRealm.workspaceId,
        authResourceId: managedRealm.authResourceId,
        storage: "none" as const,
        actorId: claim.actorId,
        appRoles: claim.appRoles,
        recordedGrant: receipt,
      };
      try {
        expect(await readManagedAppSignupRecordedGrant(readonlyPool, input)).toEqual(receipt);
        for (const changed of [
          { actorId: "user-other" },
          { workspaceId: "foreign" },
          { authResourceId: "foreign" },
          { appRoles: ["other"] },
          { recordedGrant: { ...receipt, operationRef: randomUUID() } },
          { recordedGrant: { ...receipt, fenceGeneration: 3 } },
        ]) {
          expect(
            await readManagedAppSignupRecordedGrant(readonlyPool, { ...input, ...changed }),
          ).toBeNull();
        }
      } finally {
        await readonlyPool.end();
      }
      expect(await snapshot()).toEqual(before);
      const client = await f.pool.connect();
      try {
        await setManagedFrontendAccess(
          client,
          {
            ...scope,
            workspaceId: managedRealm.workspaceId,
            actorId: claim.actorId,
            roles: [],
            active: false,
            fenceGeneration: 3,
          },
          async () => {},
        );
      } finally {
        client.release();
      }
      expect(await readManagedAppSignupRecordedGrant(f.pool, input)).toBeNull();
      expect(
        (await readManagedAppSignupClaim(f.pool, managedRealm, { ...scope, ...proof }))
          ?.recordedGrant,
      ).toBeUndefined();
      await expect(grant(f, 4)).rejects.toThrow();
    }, 30_000);
    it("proves revocation only when admission and every assignment are inactive at the same fence", async () => {
      const f = await setup({ appRoles: ["viewer"] });
      const claim = await grant(f);
      const read = () =>
        readManagedAppSignupClaim(f.pool, managedRealm, {
          ...scope,
          policyId: claim.policyId,
          claimId: claim.id,
        });
      // Assignment closure alone leaves positive app admission active.
      await f.pool.query(
        `update public.app_actor_assignment set active=false,fence_generation=3 where "appId"=$1 and "actorId"=$2`,
        [scope.appId, claim.actorId],
      );
      expect(await read()).toMatchObject({ accessState: "revoked" });
      expect((await read())?.accessRevocation).toBeUndefined();
      const revoke = async (fenceGeneration: number, roles = claim.appRoles) => {
        const client = await f.pool.connect();
        try {
          await setManagedFrontendAccess(
            client,
            {
              ...scope,
              workspaceId: managedRealm.workspaceId,
              actorId: claim.actorId,
              roles,
              active: false,
              fenceGeneration,
            },
            async () => {},
          );
        } finally {
          client.release();
        }
      };
      await revoke(3);
      await f.pool.query(
        `update public.app_access_invitation set "expiresAt"=now()-interval '1 second' where id=$1`,
        [claim.id],
      );
      await f.pool.query(`delete from public.session where id='signup-session'`);
      expect(await read()).toMatchObject({
        status: "rejected",
        accessRevocation: { fenceGeneration: 3 },
      });
      await f.pool.query(
        `update public.app_actor_assignment set fence_generation=4 where "appId"=$1 and "actorId"=$2`,
        [scope.appId, claim.actorId],
      );
      expect((await read())?.accessRevocation).toBeUndefined();
      await revoke(4);
      expect((await read())?.accessRevocation).toEqual({ fenceGeneration: 4 });
      await revoke(5, []);
      expect((await read())?.accessRevocation).toEqual({ fenceGeneration: 5 });
      await f.pool.query(
        `update public.app_actor_access set "workspaceId"='foreign' where "appId"=$1 and "actorId"=$2`,
        [scope.appId, claim.actorId],
      );
      expect((await read())?.accessRevocation).toBeUndefined();
    }, 30_000);
    it("does not let the frontend writer satisfy a roleless PostgreSQL signup", async () => {
      const f = await setup({ storage: "postgres", appRoles: [] });
      const claim = await f.claim();
      expect(claim).toMatchObject({ status: "verified", grantReserved: false, appRoles: [] });
      await expect(grant(f)).rejects.toThrow("app_signup_claim_unavailable");
      expect((await f.claim())?.grantReserved).toBe(false);
    }, 30_000);
  },
);
