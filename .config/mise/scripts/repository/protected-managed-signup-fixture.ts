import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import type { ManagedProductionRealm } from "../../../../packages/auth/public-realm-enrollment";
import { readManagedAppActorAccess } from "../../../../packages/auth/managed-app-access";
import {
  claimManagedAppSignup,
  completeManagedAppSignup,
  persistManagedAppSignupPolicy,
  readManagedAppSignupClaim,
  disableManagedAppSignupPolicy,
  type ManagedAppSignupRecordedGrant,
} from "../../../../packages/auth/managed-app-signup";
import {
  createProtectedGeneratedInstaller,
  type ProtectedGeneratedPlan,
  type ProtectedGeneratedConnections,
  type ProtectedInstallerTrust,
} from "../../../../packages/generated-app-runtime/protected-installer";

/** Test-owned local Auth/app databases and checked minimal release; no provider or configured resource. */
export async function exerciseManagedSignupGrant(input: {
  root: string;
  auth: Pool;
  app: Pool;
  plan: ProtectedGeneratedPlan;
  connections: ProtectedGeneratedConnections;
  trust: ProtectedInstallerTrust;
  releaseDirectory: string;
  authOperatorRole: string;
  appRoles?: readonly string[];
  observeWire?: (
    plan: ProtectedGeneratedPlan,
    receipt: ManagedAppSignupRecordedGrant,
    readbackOnly: boolean,
    releaseDirectory: string,
  ) => Promise<string | undefined>;
}) {
  const appRoles = [...(input.appRoles ?? ["fixture_primary"])];
  const actorId =
    appRoles.length === 0
      ? "managed-roleless-signup-fixture-actor"
      : "managed-signup-fixture-actor";
  const sessionId = `${actorId}-session`;
  const kernelTable = appRoles.length === 0 ? "kernel_actor_access" : "kernel_actor_membership";
  const organizationId = "org_fixture";
  const workspaceId = "signup-fixture-workspace";
  const policyId = randomUUID();
  const grantOperationRef = randomUUID();
  // The Production policy is logical fixture authority. All SQL connections remain the isolated local fixture.
  const realm: ManagedProductionRealm = {
    version: 1,
    kind: "managed-production-realm-v1",
    workspaceId,
    repositoryId: "fixture-repository",
    repositoryFullName: "fixture/owned",
    authResourceId: input.plan.auth.resourceId,
    authorizedOrganizationIds: [organizationId],
    publicOrigin: "https://signup-fixture.example.test",
    project: { projectId: "fixture-auth", ownerId: "fixture-team", environment: "production" },
    resource: {
      version: 1,
      environment: "production",
      hostname: input.plan.auth.hostname,
      port: 5432,
      database: input.plan.auth.database,
      schema: "public",
      runtimeRole: input.plan.auth.runtimeRole,
      migratorRole: input.plan.auth.migratorRole,
      neon: { projectId: "fixture-neon", branchId: "fixture-branch" },
    },
  };
  await input.auth.query(
    (await readFile(path.join(input.root, "packages/auth/runtime-privileges.sql"), "utf8"))
      .replaceAll("__RUNTIME_ROLE__", `"${input.plan.auth.runtimeRole}"`)
      .replaceAll("__RUNTIME_ROLE_LITERAL__", `'${input.plan.auth.runtimeRole}'`),
  );
  await input.auth.query(
    `insert into public."user"(id,name,email,"emailVerified") values($1,'Signup fixture','signup-fixture@example.test',true)`,
    [actorId],
  );
  await input.auth.query(
    `insert into public.member(id,"organizationId","userId",role,"createdAt") values($1,$2,$3,'member',now())`,
    [`${actorId}-member`, organizationId, actorId],
  );
  await input.auth.query(
    `insert into public.session(id,"userId",token,"expiresAt","updatedAt","activeOrganizationId") values($1,$2,'signup-fixture-session-token',now()+interval '1 hour',now(),$3)`,
    [sessionId, actorId, organizationId],
  );
  const scope = { appId: input.plan.appId, organizationId };
  const policy = await persistManagedAppSignupPolicy(input.auth, realm, {
    ...scope,
    policy: {
      version: 1,
      policyId,
      eligibility: "public",
      appRoles,
      storage: "postgres",
      appPath: `/${input.plan.appId}`,
    },
    operationRef: randomUUID(),
    planDigest: "a".repeat(64),
    fenceGeneration: 1,
  });
  const claim = await claimManagedAppSignup(input.auth, realm, {
    policyId,
    policyDigest: policy.policyDigest,
    actorId,
    sessionId,
  });
  assert.ok(claim);
  const proof = { policyId, claimId: claim.id, scopeDigest: claim.scopeDigest };
  const plan: ProtectedGeneratedPlan = {
    ...input.plan,
    authOperatorRole: input.authOperatorRole,
    workspaceId,
    signupClaim: proof,
    organizations: [{ organizationId, actors: [{ actorId, actorKind: "human", roles: appRoles }] }],
  };
  let interruptAfterKernel: number | undefined;
  let interruptAfterAuth: number | undefined;
  const installer = (generation: number, operationRef = grantOperationRef) =>
    createProtectedGeneratedInstaller({
      plan,
      trust: input.trust,
      connections: input.connections,
      releaseDirectory: input.releaseDirectory,
      fenceGeneration: generation,
      operationRef,
      assertCurrent: async () => {
        if (interruptAfterKernel !== generation && interruptAfterAuth !== generation) return;
        const kernel = await input.app.query(
          `select 1 from ${kernelTable} where principal_name=$1 and app_id=$2 and customer_id=$3 and actor_id=$4 and fence_generation=$5 and active`,
          [plan.app.runtimeRole, plan.appId, organizationId, actorId, generation],
        );
        const authority = await input.auth.query(
          `select active,"fenceGeneration" from public.app_actor_access where "appId"=$1 and "actorId"=$2`,
          [plan.appId, actorId],
        );
        if (
          interruptAfterKernel === generation &&
          kernel.rows.length === 1 &&
          authority.rows.length === 0
        )
          throw new Error("signup interrupted after kernel");
        if (
          interruptAfterAuth === generation &&
          kernel.rows.length === 1 &&
          authority.rows[0]?.active === true &&
          Number(authority.rows[0].fenceGeneration) === generation
        )
          throw new Error("signup interrupted after Auth");
      },
    });
  await assert.rejects(
    completeManagedAppSignup(input.auth, realm, {
      ...scope,
      ...proof,
      actorId,
      fenceGeneration: 2,
    }),
  );
  interruptAfterKernel = 2;
  await assert.rejects(installer(2).grant(), /signup interrupted after kernel/u);
  assert.deepEqual(
    (
      await input.auth.query(
        `select "signupGrantOperationRef","signupGrantFences" from public.app_access_invitation where id=$1`,
        [claim.id],
      )
    ).rows,
    [{ signupGrantOperationRef: grantOperationRef, signupGrantFences: [2] }],
  );
  assert.equal(
    await readManagedAppActorAccess(input.auth, { ...scope, workspaceId, actorId }),
    null,
  );
  interruptAfterKernel = 3;
  await assert.rejects(installer(3).grant(), /signup interrupted after kernel/u);
  interruptAfterKernel = undefined;
  await input.auth
    .query(`create function public.fail_signup_auth_fixture() returns trigger language plpgsql as $$
    begin raise exception 'signup Auth transaction fixture'; end $$;
    create trigger fail_signup_auth_fixture before insert or update on public.app_actor_access
      for each row execute function public.fail_signup_auth_fixture()`);
  try {
    await assert.rejects(installer(4).grant(), /signup Auth transaction fixture/u);
    assert.equal(
      await readManagedAppActorAccess(input.auth, { ...scope, workspaceId, actorId }),
      null,
    );
    assert.equal(
      (
        await input.auth.query(
          `select 1 from public.app_actor_assignment where "appId"=$1 and "actorId"=$2`,
          [plan.appId, actorId],
        )
      ).rows.length,
      0,
    );
  } finally {
    await input.auth.query(
      "drop trigger fail_signup_auth_fixture on public.app_actor_access; drop function public.fail_signup_auth_fixture()",
    );
  }
  interruptAfterAuth = 5;
  await assert.rejects(installer(5).grant(), /signup interrupted after Auth/u);
  assert.deepEqual(
    (
      await input.auth.query(
        `select active from public.app_actor_access where "appId"=$1 and "actorId"=$2`,
        [plan.appId, actorId],
      )
    ).rows,
    [{ active: true }],
  );
  assert.equal(
    (await readManagedAppSignupClaim(input.auth, realm, { ...scope, ...proof }))?.grantReserved,
    true,
  );
  assert.deepEqual(
    await readManagedAppActorAccess(input.auth, { ...scope, workspaceId, actorId }),
    { fenceGeneration: 5 },
  );
  assert.deepEqual(
    (
      await input.app.query(
        `select active,fence_generation from ${kernelTable} where principal_name=$1 and app_id=$2 and customer_id=$3 and actor_id=$4`,
        [plan.app.runtimeRole, plan.appId, organizationId, actorId],
      )
    ).rows,
    [{ active: true, fence_generation: "5" }],
  );
  interruptAfterAuth = 6;
  await assert.rejects(installer(6).grant(), /signup interrupted after Auth/u);
  interruptAfterAuth = undefined;
  await installer(7).grant();
  assert.equal(await installer(7).reconcileAccess(true), "applied");
  const admission = await input.auth.query(
    `select active,roles,"fenceGeneration" from public.app_actor_access where "appId"=$1 and "actorId"=$2`,
    [plan.appId, actorId],
  );
  assert.deepEqual(admission.rows, [{ active: true, roles: appRoles, fenceGeneration: "7" }]);
  await assert.rejects(installer(8, randomUUID()).grant(), /app_signup/u);
  await installer(8).grant();
  assert.equal(await installer(8).reconcileAccess(true), "applied");
  const receipt = { operationRef: grantOperationRef, fenceGeneration: 8 };
  for (const changed of [
    { appId: "unrelated-app" },
    { organizationId: "unrelated-org" },
    { workspaceId: "unrelated-workspace" },
  ]) {
    assert.equal(
      await readManagedAppActorAccess(input.auth, { ...scope, workspaceId, actorId, ...changed }),
      null,
    );
  }

  await input.auth.query(
    `update public.app_access_invitation set "expiresAt"=now()-interval '1 second' where id=$1`,
    [claim.id],
  );
  await input.auth.query(`delete from public.session where id=$1`, [sessionId]);
  await disableManagedAppSignupPolicy(input.auth, realm, {
    ...scope,
    policyId,
    policyDigest: policy.policyDigest,
    fenceGeneration: 2,
  });
  const expired = await readManagedAppSignupClaim(input.auth, realm, { ...scope, ...proof });
  assert.equal(expired?.status, "rejected");
  assert.deepEqual(expired?.recordedGrant, receipt);
  const observedState = async () => ({
    claim: (
      await input.auth.query(
        `select to_jsonb(i) value from public.app_access_invitation i where id=$1`,
        [claim.id],
      )
    ).rows,
    access: (
      await input.auth.query(
        `select to_jsonb(a) value from public.app_actor_access a where "actorId"=$1`,
        [actorId],
      )
    ).rows,
    assignments: (
      await input.auth.query(
        `select to_jsonb(a) value from public.app_actor_assignment a where "actorId"=$1`,
        [actorId],
      )
    ).rows,
    kernel: (
      await input.app.query(`select to_jsonb(m) value from ${kernelTable} m where actor_id=$1`, [
        actorId,
      ])
    ).rows,
  });
  const beforeObservation = await observedState();
  assert.equal(await installer(10, randomUUID()).observeSignupGrant(receipt), "applied");
  await input.app.query(
    "update kernel_principal_scope set actor_binding_required=false where principal_name=$1 and app_id=$2 and customer_id=$3 and capability='runtime'",
    [plan.app.runtimeRole, plan.appId, organizationId],
  );
  try {
    assert.equal(await installer(10).observeSignupGrant(receipt), "incomplete");
  } finally {
    await input.app.query(
      "update kernel_principal_scope set actor_binding_required=true where principal_name=$1 and app_id=$2 and customer_id=$3 and capability='runtime'",
      [plan.app.runtimeRole, plan.appId, organizationId],
    );
  }

  assert.equal(
    await installer(10).observeSignupGrant({ ...receipt, operationRef: randomUUID() }),
    "incomplete",
  );
  assert.equal(
    await installer(10).observeSignupGrant({ ...receipt, fenceGeneration: 7 }),
    "incomplete",
  );
  if (input.observeWire) {
    assert.equal(await input.observeWire(plan, receipt, true, input.releaseDirectory), "applied");
    assert.equal(
      await input.observeWire(
        plan,
        { ...receipt, operationRef: randomUUID() },
        true,
        input.releaseDirectory,
      ),
      "incomplete",
    );
    await input.observeWire(plan, receipt, false, input.releaseDirectory);
  }
  assert.deepEqual(await observedState(), beforeObservation);
  await assert.rejects(installer(10).grant(), /app_signup/u);
  // Existing generic cleanup closes opposite admission before original assignments/kernel rows.
  const { signupClaim: _claim, ...revokePlan } = plan;
  const freshRevoke = () =>
    createProtectedGeneratedInstaller({
      plan: revokePlan,
      trust: input.trust,
      connections: input.connections,
      releaseDirectory: input.releaseDirectory,
      fenceGeneration: 9,
      assertCurrent: async () => {},
    }).revoke();
  let authorityChecks = 0;
  const interruptedObserver = createProtectedGeneratedInstaller({
    plan,
    trust: input.trust,
    connections: input.connections,
    releaseDirectory: input.releaseDirectory,
    fenceGeneration: 10,
    operationRef: randomUUID(),
    readOnly: true,
    assertCurrent: async () => {
      authorityChecks++;
      if (authorityChecks === 2) {
        await freshRevoke();
        throw new Error("signup observer authority lost");
      }
    },
  });
  await assert.rejects(
    interruptedObserver.observeSignupGrant(receipt),
    /signup observer authority lost/u,
  );
  await assert.rejects(interruptedObserver.grant(), /readonly/u);
  assert.equal(
    (await readManagedAppSignupClaim(input.auth, realm, { ...scope, ...proof }))?.accessState,
    "revoked",
  );
  assert.deepEqual(
    (await readManagedAppSignupClaim(input.auth, realm, { ...scope, ...proof }))?.accessRevocation,
    { fenceGeneration: 9 },
  );
  await assert.rejects(installer(10).grant(), /app_signup/u);
  assert.equal(
    await readManagedAppActorAccess(input.auth, { ...scope, workspaceId, actorId }),
    null,
  );
  assert.equal(await installer(10).observeSignupGrant(receipt), "incomplete");
  assert.deepEqual(
    (
      await input.auth.query(
        `select active,roles,"fenceGeneration" from public.app_actor_access where "appId"=$1 and "actorId"=$2`,
        [plan.appId, actorId],
      )
    ).rows,
    [{ active: false, roles: [], fenceGeneration: "9" }],
  );
  const closed = await input.app.query(
    `select active from ${kernelTable} where principal_name=$1 and app_id=$2 and customer_id=$3 and actor_id=$4`,
    [plan.app.runtimeRole, plan.appId, organizationId, actorId],
  );
  assert.equal(
    closed.rows.every((row) => row.active === false),
    true,
  );
  // Only this helper's actor is removed; original fixture people and rows are untouched.
  await input.auth.query(`delete from public.app_access_invitation where id=$1`, [claim.id]);
  await input.auth.query(`delete from public.app_signup_policy where id=$1`, [policyId]);
  await input.auth.query(`delete from public.app_actor_access where "actorId"=$1`, [actorId]);
  await input.auth.query(`delete from public."user" where id=$1`, [actorId]);
  return 46;
}
