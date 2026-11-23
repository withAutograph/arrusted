// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createManagedAppInvitation,
  listManagedAppInvitations,
  readManagedAppInvitation,
  updateManagedAppInvitation,
  verifyManagedAppInvitation,
} from "../managed-app-invitations";
import { hasManagedAppRecord } from "../managed-app-access";
import { claimManagedAppSignup, persistManagedAppSignupPolicy } from "../managed-app-signup";
import { authDatabaseResourceDigest } from "../signup-policy";
import type { ManagedProductionRealm } from "../public-realm-enrollment";
import { realm as createFixture, startCluster, stopCluster } from "./agent-grant-fixture";

const scope = { appId: "invitation-boundary", organizationId: "org-a" };
const managedRealm: ManagedProductionRealm = {
  version: 1,
  kind: "managed-production-realm-v1",
  workspaceId: "invitation-boundary-workspace",
  repositoryId: "fixture-repository",
  repositoryFullName: "fixture/boundary",
  authResourceId: "fixture-auth",
  authorizedOrganizationIds: [scope.organizationId],
  publicOrigin: "https://boundary.example.test",
  project: { projectId: "fixture-project", ownerId: "fixture-team", environment: "production" },
  resource: {
    version: 1,
    environment: "production",
    hostname: "boundary-auth.neon.tech",
    port: 5432,
    database: "boundary_auth",
    schema: "public",
    runtimeRole: "boundary_runtime",
    migratorRole: "boundary_migrator",
    neon: { projectId: "fixture-project", branchId: "fixture-branch" },
  },
};

async function fixture() {
  const f = await createFixture();
  await f.auth.$context;
  await f.pool.query(
    `do $$ begin if not exists(select 1 from pg_roles where rolname='boundary_runtime') then create role boundary_runtime; end if; end $$`,
  );
  await f.pool.query(
    (await readFile(new URL("../runtime-privileges.sql", import.meta.url), "utf8"))
      .replaceAll("__RUNTIME_ROLE_LITERAL__", "'boundary_runtime'")
      .replaceAll("__RUNTIME_ROLE__", '"boundary_runtime"'),
  );
  const policy = await persistManagedAppSignupPolicy(f.pool, managedRealm, {
    ...scope,
    policy: {
      version: 1,
      policyId: randomUUID(),
      eligibility: "public",
      appRoles: [],
      storage: "none",
      appPath: `/${scope.appId}`,
    },
    operationRef: randomUUID(),
    planDigest: "a".repeat(64),
    fenceGeneration: 1,
  });
  const sessionId = randomUUID();
  await f.pool.query(
    `insert into public.session(id,"userId",token,"expiresAt","updatedAt","activeOrganizationId")
     values($1,$2,$3,now()+interval '1 hour',now(),$4)`,
    [sessionId, f.users.member, randomUUID(), scope.organizationId],
  );
  const claim = await claimManagedAppSignup(f.pool, managedRealm, {
    policyId: policy.policyId,
    policyDigest: policy.policyDigest,
    actorId: f.users.member,
    sessionId,
  });
  if (!claim) throw new Error("Expected a verified signup claim");
  return { ...f, claim, sessionId };
}

describe.skipIf(process.env.AUTH_AGENT_GRANT_POSTGRES !== "1")(
  "signup claims remain separate from private invitations",
  () => {
    beforeAll(startCluster, 120_000);
    afterAll(stopCluster, 60_000);

    it("hides a genuine signup claim from invitation reads and lists while retaining app protection", async () => {
      const f = await fixture();
      const invitation = await createManagedAppInvitation(
        f.pool,
        {
          ...scope,
          id: randomUUID(),
          workspaceId: managedRealm.workspaceId,
          email: "invitee@example.test",
          roles: [],
          returnUrl: `${managedRealm.publicOrigin}/${scope.appId}`,
          operationRef: randomUUID(),
          planDigest: "b".repeat(64),
          fenceGeneration: 1,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
        managedRealm,
        "https://builder.example.test",
      );
      expect(
        (await listManagedAppInvitations(f.pool, scope, managedRealm)).map(({ id }) => id),
      ).toEqual([invitation.id]);
      expect(await readManagedAppInvitation(f.pool, f.claim.id, managedRealm)).toBeNull();
      expect(await readManagedAppInvitation(f.pool, invitation.id, managedRealm)).toMatchObject({
        id: invitation.id,
      });
      expect(
        await verifyManagedAppInvitation(f.pool, managedRealm, {
          invitationId: f.claim.id,
          actorId: f.claim.actorId,
          sessionId: f.sessionId,
        }),
      ).toBeNull();
      await f.pool.query(`delete from public.app_access_invitation where id=$1`, [invitation.id]);
      expect(
        await hasManagedAppRecord(f.pool, {
          workspaceId: managedRealm.workspaceId,
          appId: scope.appId,
          resourceDigest: authDatabaseResourceDigest(managedRealm.resource),
        }),
      ).toBe(true);
    }, 30_000);

    it.each(["accept", "cancel", "renew"] as const)(
      "refuses to %s a verified signup claim through invitation management",
      async (action) => {
        const f = await fixture();
        const before = await f.pool.query(
          `select to_jsonb(i) as row from public.app_access_invitation i where id=$1`,
          [f.claim.id],
        );
        const transition = { id: f.claim.id, scopeDigest: f.claim.scopeDigest, fenceGeneration: 2 };
        const input =
          action === "accept"
            ? { ...transition, action, actorId: f.claim.actorId }
            : action === "renew"
              ? { ...transition, action, expiresAt: new Date(Date.now() + 7_200_000).toISOString() }
              : { ...transition, action };
        await expect(updateManagedAppInvitation(f.pool, managedRealm, input)).rejects.toThrow();
        expect(
          (
            await f.pool.query(
              `select to_jsonb(i) as row from public.app_access_invitation i where id=$1`,
              [f.claim.id],
            )
          ).rows,
        ).toEqual(before.rows);
      },
      30_000,
    );
  },
);
