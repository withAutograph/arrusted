// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyAuthOperatorConnection } from "../../protected-installer/auth-operator";
import {
  createManagedAppInvitation,
  listManagedAppInvitations,
  readManagedAppInvitation,
  updateManagedAppInvitation,
} from "../managed-app-invitations";
import { listManagedAppMembers, setManagedFrontendAccess } from "../managed-app-access";
import type { ManagedProductionRealm } from "../public-realm-enrollment";
import { realm, startCluster, stopCluster } from "./agent-grant-fixture";

describe.skipIf(process.env.AUTH_AGENT_GRANT_POSTGRES !== "1")(
  "restricted operator before managed-signup migration",
  () => {
    beforeAll(startCluster, 120_000);
    afterAll(stopCluster, 60_000);

    it("runs existing private invitation and frontend access commands without the new schema or privileges", async () => {
      const f = await realm();
      // Model the currently installed schema, not a partly applied signup upgrade.
      await f.pool.query(`
        alter table public.app_signup_policy
          drop column "admissionMode", drop column "workspaceId", drop column enabled,
          drop column "signupStorage";
        alter table public.app_access_invitation
          drop column "signupPolicyId", drop column "signupPolicyDigest",
          drop column "signupGrantFence", drop column "signupGrantOperationRef",
          drop column "signupGrantFences";
        revoke create on schema public from public;
      `);
      const operatorRole = `upgrade_operator_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const password = randomUUID();
      await f.pool.query(`create role ${operatorRole} login password '${password}'`);
      await f.pool.query(await readFile(new URL("../operator-locks.sql", import.meta.url), "utf8"));
      // The pre-upgrade app-access profile has no policy writes or signup-fence columns.
      await f.pool.query(`
        grant connect on database ${f.pool.options.database ?? new URL(f.env.PLATFORM_AUTH_DATABASE_URL).pathname.slice(1)} to ${operatorRole};
        grant usage on schema public to ${operatorRole};
        grant select (id,name,email,"emailVerified") on public."user" to ${operatorRole};
        grant select (id,"userId","expiresAt","activeOrganizationId"),
          update ("activeOrganizationId","updatedAt") on public.session to ${operatorRole};
        grant select (id,"organizationId","userId",role) on public.member to ${operatorRole};
        grant select (id,"appIds"), update ("appIds") on public.organization to ${operatorRole};
        grant select, insert ("organizationId","actorId","appId",role,active,fence_generation),
          update (active,fence_generation,"assignedAt") on public.app_actor_assignment to ${operatorRole};
        grant select, insert ("organizationId","actorId","appId","workspaceId",active,"fenceGeneration",roles),
          update (active,"fenceGeneration",roles) on public.app_actor_access to ${operatorRole};
        grant select, insert (id,"workspaceId","resourceDigest","appId","organizationId",email,roles,"returnUrl",
          "operationRef","planDigest","scopeDigest","fenceGeneration","expiresAt"),
          update (id,status,"fenceGeneration","expiresAt","deliveryStatus","deliveryAttemptId","deliveryProviderId",
            "verifiedActorId","verifiedSessionId","verifiedAt","linkedFromInvitationId")
          on public.app_access_invitation to ${operatorRole};
        grant execute on function public.lock_auth_operator_user(text),
          public.lock_auth_operator_member(text,text), public.insert_auth_operator_member(text,text,text)
          to ${operatorRole};
      `);
      const connection = new URL(f.env.PLATFORM_AUTH_DATABASE_URL);
      connection.username = operatorRole;
      connection.password = password;
      const operator = new Pool({ connectionString: connection.toString(), max: 1 });
      const resource = {
        version: 1 as const,
        environment: "local" as const,
        hostname: connection.hostname,
        port: Number(connection.port),
        database: connection.pathname.slice(1),
        schema: "public" as const,
        migratorRole: "postgres",
        runtimeRole: "fixture_auth_runtime",
      };
      const managedRealm: ManagedProductionRealm = {
        version: 1,
        kind: "managed-production-realm-v1",
        workspaceId: "upgrade-workspace",
        repositoryId: "upgrade-repository",
        repositoryFullName: "fixture/upgrade",
        authResourceId: "upgrade-auth",
        authorizedOrganizationIds: ["org-a"],
        publicOrigin: "https://upgrade.example.test",
        project: { projectId: "fixture-auth", ownerId: "fixture-team", environment: "production" },
        resource: {
          ...resource,
          environment: "production",
          hostname: "upgrade-auth.neon.tech",
          port: 5432,
          neon: { projectId: "fixture-neon", branchId: "fixture-branch" },
        },
      };
      const scope = {
        workspaceId: managedRealm.workspaceId,
        organizationId: "org-a",
        appId: "upgrade-private-app",
      };
      const before = await f.pool.query(
        `select id,"organizationId","userId",role from public.member order by id`,
      );
      const client = await operator.connect();
      try {
        await expect(
          verifyAuthOperatorConnection(client, resource, operatorRole),
        ).resolves.toBeUndefined();
        expect(
          (
            await client.query(
              `select has_table_privilege(current_user,'public.app_signup_policy','INSERT') as allowed`,
            )
          ).rows[0]?.allowed,
        ).toBe(false);
        const invitation = await createManagedAppInvitation(
          client,
          {
            ...scope,
            id: randomUUID(),
            email: "user-member@example.test",
            roles: [],
            returnUrl: `${managedRealm.publicOrigin}/${scope.appId}`,
            operationRef: randomUUID(),
            planDigest: "a".repeat(64),
            fenceGeneration: 1,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          },
          managedRealm,
          "https://builder.example.test",
        );
        expect(invitation.status).toBe("pending");
        expect(await readManagedAppInvitation(client, invitation.id, managedRealm)).toMatchObject({
          id: invitation.id,
          status: "pending",
        });
        expect(
          (await listManagedAppInvitations(client, scope, managedRealm)).map(({ id }) => id),
        ).toEqual([invitation.id]);
        expect(
          await updateManagedAppInvitation(client, managedRealm, {
            id: invitation.id,
            scopeDigest: invitation.scopeDigest,
            fenceGeneration: 2,
            action: "cancel",
          }),
        ).toMatchObject({ id: invitation.id, status: "cancelled" });
        const access = {
          ...scope,
          actorId: f.users.member,
          roles: [],
          authOperatorRole: operatorRole,
        };
        await setManagedFrontendAccess(
          client,
          { ...access, active: true, fenceGeneration: 2 },
          async () => {},
        );
        expect(await listManagedAppMembers(client, scope)).toEqual([
          { id: f.users.member, name: "User 0", email: "user-member@example.test", roles: [] },
        ]);
        await setManagedFrontendAccess(
          client,
          { ...access, active: false, fenceGeneration: 3 },
          async () => {},
        );
        expect(await listManagedAppMembers(client, scope)).toEqual([]);
        expect(
          (
            await f.pool.query(
              `select id,"organizationId","userId",role from public.member order by id`,
            )
          ).rows,
        ).toEqual(before.rows);

        // Supporting both rollout profiles must not relax the maximum privilege check.
        await f.pool.query(`grant update ("emailVerified") on public."user" to ${operatorRole}`);
        await expect(verifyAuthOperatorConnection(client, resource, operatorRole)).rejects.toThrow(
          "auth_operator_identity_or_privilege_mismatch",
        );
      } finally {
        client.release();
        await operator.end();
      }
    }, 30_000);
  },
);
