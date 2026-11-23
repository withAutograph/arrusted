// @vitest-environment node
// Real restricted SQL path against test-owned PostgreSQL; no provider or hosted resources.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyAuthOperatorConnection } from "../../protected-installer/auth-operator";
import {
  claimManagedAppSignup,
  persistManagedAppSignupPolicy,
  prepareManagedAppSignupMember,
  readManagedAppSignupClaim,
} from "../managed-app-signup";
import type { ManagedProductionRealm } from "../public-realm-enrollment";
import { realm, startCluster, stopCluster } from "./agent-grant-fixture";

describe.skipIf(process.env.AUTH_AGENT_GRANT_POSTGRES !== "1")(
  "first-time managed signup restricted member preparation",
  () => {
    beforeAll(startCluster, 120_000);
    afterAll(stopCluster, 60_000);

    it.each([
      { storage: "none" as const, appRoles: [] },
      { storage: "postgres" as const, appRoles: ["member"] },
    ])(
      "prepares a first-time $storage app member without granting app access",
      async ({ storage, appRoles }) => {
        const f = await realm();
        await f.auth.$context;
        const role = `signup_operator_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
        const password = randomUUID();
        const runtimeRole = `signup_runtime_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
        await f.pool.query(
          `create role ${role} login password '${password}'; create role ${runtimeRole}; revoke create on schema public from public`,
        );
        await f.pool.query(
          (await readFile(new URL("../runtime-privileges.sql", import.meta.url), "utf8"))
            .replaceAll("__RUNTIME_ROLE_LITERAL__", `'${runtimeRole}'`)
            .replaceAll("__RUNTIME_ROLE__", `"${runtimeRole}"`),
        );
        await f.pool.query(
          await readFile(new URL("../operator-locks.sql", import.meta.url), "utf8"),
        );
        await f.pool.query(
          (await readFile(new URL("../operator-privileges.sql", import.meta.url), "utf8"))
            .replaceAll("__OPERATOR_ROLE_LITERAL__", `'${role}'`)
            .replaceAll("__OPERATOR_ROLE__", `"${role}"`),
        );
        const connection = new URL(f.env.PLATFORM_AUTH_DATABASE_URL);
        connection.username = role;
        connection.password = password;
        const operator = new Pool({ connectionString: connection.toString(), max: 1 });
        const scope = { appId: "first-signup-fixture", organizationId: "org-a" };
        // Logical Production realm, with all database calls using the owned local cluster.
        const managedRealm: ManagedProductionRealm = {
          version: 1,
          kind: "managed-production-realm-v1",
          workspaceId: "signup-workspace",
          repositoryId: "fixture",
          repositoryFullName: "fixture/owned",
          authResourceId: "fixture-auth",
          authorizedOrganizationIds: [scope.organizationId],
          publicOrigin: "https://signup-fixture.example.test",
          project: { projectId: "fixture", ownerId: "fixture", environment: "production" },
          resource: {
            version: 1,
            environment: "production",
            hostname: "fixture-auth.neon.tech",
            port: 5432,
            database: connection.pathname.slice(1),
            schema: "public",
            runtimeRole,
            migratorRole: "postgres",
            neon: { projectId: "fixture", branchId: "fixture" },
          },
        };
        const actorId = "first-signup-actor";
        const sessionId = "first-signup-session";
        await f.pool.query(
          `insert into public."user"(id,name,email,"emailVerified") values($1,'First signup','first-signup@example.test',true)`,
          [actorId],
        );
        await f.pool.query(
          `insert into public.session(id,"userId",token,"expiresAt","updatedAt") values($1,$2,'local-fixture-token',now()+interval '1 hour',now())`,
          [sessionId, actorId],
        );
        const policy = await persistManagedAppSignupPolicy(f.pool, managedRealm, {
          ...scope,
          policy: {
            version: 1,
            policyId: randomUUID(),
            eligibility: "public",
            appRoles,
            storage,
            appPath: "/first-signup-fixture",
          },
          operationRef: randomUUID(),
          planDigest: "a".repeat(64),
          fenceGeneration: 1,
        });
        const claim = await claimManagedAppSignup(f.pool, managedRealm, {
          policyId: policy.policyId,
          policyDigest: policy.policyDigest,
          actorId,
          sessionId,
        });
        expect(claim).toMatchObject({
          status: "verified",
          accessState: "absent",
          memberPrepared: false,
        });
        if (!claim) throw new Error("expected verified first-time claim");
        expect(
          (await f.pool.query(`select id from public.member where "userId"=$1`, [actorId])).rows,
        ).toHaveLength(0);
        expect(
          (
            await f.pool.query(`select "activeOrganizationId" from public.session where id=$1`, [
              sessionId,
            ])
          ).rows,
        ).toEqual([{ activeOrganizationId: null }]);
        const client = await operator.connect();
        try {
          await verifyAuthOperatorConnection(client, managedRealm.resource, role);
          const input = {
            client,
            realm: managedRealm,
            scope,
            actorId,
            authOperatorRole: role,
            proof: { policyId: policy.policyId, claimId: claim.id, scopeDigest: claim.scopeDigest },
            assertCurrent: async () => {},
          };
          for (const changed of [
            { actorId: "different-actor" },
            { scope: { ...scope, appId: "different-app" } },
            { scope: { ...scope, organizationId: "org-b" } },
          ]) {
            await expect(prepareManagedAppSignupMember({ ...input, ...changed })).rejects.toThrow();
          }
          expect(
            (await client.query(`select id from public.member where "userId"=$1`, [actorId])).rows,
          ).toHaveLength(0);
          const prepared = await prepareManagedAppSignupMember(input);
          expect(prepared).toMatchObject({
            status: "verified",
            accessState: "absent",
            memberPrepared: true,
          });
          expect(
            (
              await client.query(
                `select role from public.member where "organizationId"=$1 and "userId"=$2`,
                [scope.organizationId, actorId],
              )
            ).rows,
          ).toEqual([{ role: "member" }]);
          expect(
            (
              await client.query(`select "activeOrganizationId" from public.session where id=$1`, [
                sessionId,
              ])
            ).rows,
          ).toEqual([{ activeOrganizationId: scope.organizationId }]);
          expect(
            (
              await client.query(`select "appId" from public.app_actor_access where "actorId"=$1`, [
                actorId,
              ])
            ).rows,
          ).toHaveLength(0);
          expect(
            (
              await client.query(
                `select "appId" from public.app_actor_assignment where "actorId"=$1`,
                [actorId],
              )
            ).rows,
          ).toHaveLength(0);
          await expect(prepareManagedAppSignupMember(input)).resolves.toMatchObject({
            memberPrepared: true,
            accessState: "absent",
          });
          expect(
            (await readManagedAppSignupClaim(client, managedRealm, { ...scope, ...input.proof }))
              ?.memberPrepared,
          ).toBe(true);
          expect(
            (await client.query(`select id from public.member where "userId"=$1`, [actorId])).rows,
          ).toHaveLength(1);
        } finally {
          client.release();
          await operator.end();
        }
      },
      30_000,
    );
  },
);
