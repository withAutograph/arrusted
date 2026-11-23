import type { PoolClient } from "pg";
import type { SignupPolicyDatabase } from "./signup-policy";
import {
  assertManagedAppSignupGrant,
  recordManagedAppSignupGrant,
  type ManagedAppSignupClaimProof,
} from "./managed-app-signup";

type Scope = { workspaceId: string; appId: string; organizationId: string };

export async function readManagedAppActorAccess(
  database: SignupPolicyDatabase,
  input: Scope & { actorId: string; rolelessOnly?: boolean },
): Promise<{ fenceGeneration: number } | null> {
  const result = await database.query(
    `select "fenceGeneration" from public.app_actor_access where "actorId"=$1 and "organizationId"=$2
      and "appId"=$3 and "workspaceId"=$4 and active and "fenceGeneration">0
      and (not $5::boolean or roles='[]'::jsonb)`,
    [
      input.actorId,
      input.organizationId,
      input.appId,
      input.workspaceId,
      input.rolelessOnly ?? false,
    ],
  );
  return result.rows.length === 1
    ? { fenceGeneration: Number(result.rows[0]!.fenceGeneration) }
    : null;
}

export async function hasManagedAppRecord(
  database: SignupPolicyDatabase,
  input: { appId: string; workspaceId: string; resourceDigest: string },
): Promise<boolean> {
  const result = await database.query(
    `select 1 where exists(select 1 from public.app_access_invitation where "appId"=$1 and "workspaceId"=$2 and "resourceDigest"=$3)
      or exists(select 1 from public.app_actor_access where "appId"=$1 and "workspaceId"=$2)`,
    [input.appId, input.workspaceId, input.resourceDigest],
  );
  return result.rows.length === 1;
}

export async function listManagedAppMembers(database: SignupPolicyDatabase, scope: Scope) {
  const result = await database.query(
    `select u.id,u.name,u.email,coalesce((
       select jsonb_agg(a.role order by a.role) from public.app_actor_assignment a
        where a."actorId"=u.id and a."organizationId"=$2 and a."appId"=$3 and a.active
     ),'[]'::jsonb) as roles from public."user" u
     join public.member m on m."userId"=u.id and m."organizationId"=$2
     where exists(select 1 from public.app_actor_access x where x."actorId"=u.id
       and x."organizationId"=$2 and x."appId"=$3 and x."workspaceId"=$1 and x.active)
       or exists(select 1 from public.app_actor_assignment a where a."actorId"=u.id
         and a."organizationId"=$2 and a."appId"=$3 and a.active)
     order by u.name,u.id`,
    [scope.workspaceId, scope.organizationId, scope.appId],
  );
  return result.rows;
}

/** Auth-only app admission. Data-backed roles still require the generated installer. */
export async function setManagedFrontendAccess(
  client: PoolClient,
  input: Scope & {
    actorId: string;
    roles: string[];
    active: boolean;
    fenceGeneration: number;
    authOperatorRole?: string;
    signupClaim?: ManagedAppSignupClaimProof;
    operationRef?: string;
  },
  assertCurrent: () => Promise<void>,
) {
  if (!Number.isSafeInteger(input.fenceGeneration) || input.fenceGeneration <= 0)
    throw new Error("app_access_fence_required");
  await assertCurrent();
  await client.query("begin");
  try {
    // Serialize projection updates across actors so the final revoke cannot hide a concurrent grant.
    await client.query(`select id from public.organization where id=$1 for update`, [
      input.organizationId,
    ]);
    if (input.signupClaim) {
      if (!input.active) throw new Error("app_signup_claim_unavailable");
      await assertManagedAppSignupGrant(client, {
        ...input,
        operationRef: input.operationRef ?? "",
        proof: input.signupClaim,
        storage: "none",
        appRoles: input.roles,
      });
    }
    const member = await client.query(
      input.authOperatorRole
        ? "select id from public.lock_auth_operator_member($1,$2)"
        : `select id from public.member where "organizationId"=$1 and "userId"=$2 for share`,
      [input.organizationId, input.actorId],
    );
    if (input.active && member.rows.length !== 1) throw new Error("app_access_membership_required");
    const result = await client.query(
      `insert into public.app_actor_access("organizationId","actorId","appId","workspaceId",active,"fenceGeneration",roles)
       values($1,$2,$3,$4,$5,$6,$7::jsonb)
       on conflict("organizationId","actorId","appId") do update set active=excluded.active,"fenceGeneration"=excluded."fenceGeneration",roles=excluded.roles
       where app_actor_access."workspaceId"=excluded."workspaceId" and
         (app_actor_access."fenceGeneration"<excluded."fenceGeneration" or
          (app_actor_access."fenceGeneration"=excluded."fenceGeneration" and app_actor_access.active=excluded.active and app_actor_access.roles=excluded.roles))
       returning active`,
      [
        input.organizationId,
        input.actorId,
        input.appId,
        input.workspaceId,
        input.active,
        input.fenceGeneration,
        JSON.stringify([...input.roles].sort()),
      ],
    );
    if (result.rows.length !== 1) throw new Error("app_access_stale_fence");
    const newer = await client.query(
      `select 1 from public.app_actor_assignment where "organizationId"=$1 and "actorId"=$2
        and "appId"=$3 and fence_generation>$4`,
      [input.organizationId, input.actorId, input.appId, input.fenceGeneration],
    );
    if (newer.rows.length > 0) throw new Error("app_access_stale_fence");
    // Existing role rows are retained as fenced tombstones so stale grants cannot revive them.
    await client.query(
      `update public.app_actor_assignment set active=false,fence_generation=$4
        where "organizationId"=$1 and "actorId"=$2 and "appId"=$3 and fence_generation<=$4`,
      [input.organizationId, input.actorId, input.appId, input.fenceGeneration],
    );
    if (input.active) {
      for (const role of input.roles) {
        const assignment = await client.query(
          `insert into public.app_actor_assignment("organizationId","actorId","appId",role,active,fence_generation)
           values($1,$2,$3,$4,true,$5) on conflict("organizationId","actorId","appId",role) do update
           set active=true,fence_generation=excluded.fence_generation
           where app_actor_assignment.fence_generation<=excluded.fence_generation returning role`,
          [input.organizationId, input.actorId, input.appId, role, input.fenceGeneration],
        );
        if (assignment.rows.length !== 1) throw new Error("app_access_stale_fence");
      }
    }
    await client.query(
      `update public.organization set "appIds"=case when
        exists(select 1 from public.app_actor_access where "organizationId"=$1 and "appId"=$2 and active)
        or exists(select 1 from public.app_actor_assignment where "organizationId"=$1 and "appId"=$2 and active)
        then (select jsonb_agg(distinct app) from jsonb_array_elements(coalesce("appIds",'[]'::jsonb)||to_jsonb($2::text)) app)
        else (select coalesce(jsonb_agg(app),'[]'::jsonb) from jsonb_array_elements(coalesce("appIds",'[]'::jsonb)) app where app<>to_jsonb($2::text)) end
        where id=$1`,
      [input.organizationId, input.appId],
    );
    if (input.signupClaim) {
      await recordManagedAppSignupGrant(client, {
        proof: input.signupClaim,
        operationRef: input.operationRef ?? "",
        fenceGeneration: input.fenceGeneration,
      });
    }
    await assertCurrent();
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
  await assertCurrent();
  return { actorId: input.actorId, active: input.active, roles: input.active ? input.roles : [] };
}
