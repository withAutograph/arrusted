// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { persistManagedAppSignupPolicy } from "../managed-app-signup";
import type { ManagedProductionRealm } from "../public-realm-enrollment";
import { realm as createFixture, startCluster, stopCluster } from "./agent-grant-fixture";

const scope = { appId: "scope-policy", organizationId: "org-a" };
const managedRealm: ManagedProductionRealm = {
  version: 1,
  kind: "managed-production-realm-v1",
  workspaceId: "scope-policy-workspace",
  repositoryId: "fixture-repository",
  repositoryFullName: "fixture/scope-policy",
  authResourceId: "fixture-auth",
  authorizedOrganizationIds: [scope.organizationId],
  publicOrigin: "https://scope-policy.example.test",
  project: { projectId: "fixture-project", ownerId: "fixture-team", environment: "production" },
  resource: {
    version: 1,
    environment: "production",
    hostname: "scope-policy-auth.neon.tech",
    port: 5432,
    database: "scope_policy_auth",
    schema: "public",
    runtimeRole: "scope_policy_runtime",
    migratorRole: "scope_policy_migrator",
    neon: { projectId: "fixture-project", branchId: "fixture-branch" },
  },
};

describe.skipIf(process.env.AUTH_AGENT_GRANT_POSTGRES !== "1")(
  "managed signup policy scope before commit",
  () => {
    beforeAll(startCluster, 120_000);
    afterAll(stopCluster, 60_000);

    it.each([
      {
        name: "app ID beyond the existing reader boundary",
        appId: "a".repeat(257),
        organizationId: "org-a",
      },
      {
        name: "organization ID beyond the existing reader boundary",
        appId: "scope-policy",
        organizationId: "o".repeat(257),
      },
      { name: "empty app ID", appId: "", organizationId: "org-a" },
    ])(
      "rejects $name without retaining an unreadable policy",
      async ({ appId, organizationId }) => {
        const f = await createFixture();
        await f.auth.$context;
        const policy = {
          version: 1 as const,
          policyId: randomUUID(),
          eligibility: "public" as const,
          appRoles: [],
          storage: "none" as const,
          appPath: "/scope-policy",
        };
        const original = await persistManagedAppSignupPolicy(f.pool, managedRealm, {
          ...scope,
          policy,
          operationRef: randomUUID(),
          planDigest: "a".repeat(64),
          fenceGeneration: 1,
        });
        if (organizationId !== scope.organizationId) {
          await f.pool.query(
            `insert into public.organization(id,name,slug,"createdAt") values($1,$1,$1,now())`,
            [organizationId],
          );
        }
        const invalidPolicyId = randomUUID();
        await expect(
          persistManagedAppSignupPolicy(
            f.pool,
            { ...managedRealm, authorizedOrganizationIds: [scope.organizationId, organizationId] },
            {
              appId,
              organizationId,
              policy: { ...policy, policyId: invalidPolicyId, appPath: "/scope-policy/invalid" },
              operationRef: randomUUID(),
              planDigest: "b".repeat(64),
              fenceGeneration: 2,
            },
          ),
        ).rejects.toThrow();
        expect(
          (
            await f.pool.query(`select id from public.app_signup_policy where id=$1`, [
              invalidPolicyId,
            ])
          ).rows,
        ).toEqual([]);
        expect(
          await persistManagedAppSignupPolicy(f.pool, managedRealm, {
            ...scope,
            policy,
            operationRef: original.operationRef,
            planDigest: original.planDigest,
            fenceGeneration: original.fenceGeneration,
          }),
        ).toEqual(original);
      },
      30_000,
    );
  },
);
