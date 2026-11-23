-- The enrolled Production Auth operator can manage app access without schema ownership.
-- The migration planner quotes the approved role before applying this asset.
do $operator_acl$
declare
  operator_oid oid;
begin
  select oid into operator_oid from pg_catalog.pg_roles
    where rolname=__OPERATOR_ROLE_LITERAL__ and not (rolsuper or rolcreatedb
      or rolcreaterole or rolreplication or rolbypassrls);
  -- PostgreSQL records an administration-only edge for a non-superuser role creator.
  if operator_oid is null or operator_oid=(current_user::regrole)::oid
    or exists(select 1 from pg_catalog.pg_auth_members
      where member=operator_oid or (roleid=operator_oid and not (
        member=(current_user::regrole)::oid and admin_option and not inherit_option and not set_option)))
    or pg_catalog.has_database_privilege(operator_oid,current_database(),'CREATE')
    or exists(select 1 from pg_catalog.pg_namespace n
      where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
        and pg_catalog.has_schema_privilege(operator_oid,n.oid,'CREATE'))
    or exists(select 1 from pg_catalog.pg_class where relowner=operator_oid)
    or exists(select 1 from pg_catalog.pg_proc where proowner=operator_oid)
    or exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where n.nspname !~ '^pg_' and n.nspname<>'information_schema'
        and case when c.relkind='S' then pg_catalog.has_sequence_privilege(operator_oid,c.oid,'USAGE,SELECT,UPDATE') else false end)
  then raise exception 'Invalid restricted Auth operator role'; end if;

  execute format('grant connect on database %I to %I',current_database(),__OPERATOR_ROLE_LITERAL__);
end
$operator_acl$;

grant usage on schema public to __OPERATOR_ROLE__;
grant select (id,name,email,"emailVerified") on public."user" to __OPERATOR_ROLE__;
grant select (id,"userId","expiresAt","activeOrganizationId"), update ("activeOrganizationId","updatedAt")
  on public.session to __OPERATOR_ROLE__;
grant select (id,"organizationId","userId",role) on public.member to __OPERATOR_ROLE__;
grant select (id,"appIds"), update ("appIds") on public.organization to __OPERATOR_ROLE__;

grant select, insert ("organizationId","actorId","appId",role,active,fence_generation),
  update (active,fence_generation,"assignedAt") on public.app_actor_assignment to __OPERATOR_ROLE__;
grant select, insert ("organizationId","actorId","appId","workspaceId",active,"fenceGeneration",roles),
  update (active,"fenceGeneration",roles) on public.app_actor_access to __OPERATOR_ROLE__;
grant select, insert (id,"workspaceId","resourceDigest","appId","organizationId",email,roles,"returnUrl",
  "operationRef","planDigest","scopeDigest","fenceGeneration","expiresAt"),
  update (id,status,"fenceGeneration","expiresAt","deliveryStatus","deliveryAttemptId","deliveryProviderId",
    "verifiedActorId","verifiedSessionId","verifiedAt","linkedFromInvitationId","signupGrantFence","signupGrantOperationRef","signupGrantFences")
  on public.app_access_invitation to __OPERATOR_ROLE__;

grant execute on function public.lock_auth_operator_user(text),
  public.lock_auth_operator_member(text,text),
  public.insert_auth_operator_member(text,text,text) to __OPERATOR_ROLE__;

-- Exact managed signup policies remain inaccessible to runtime writes.
grant select, insert (id,"authResourceId","resourceDigest","appId",origin,"appPath","organizationId",eligibility,
  "allowedEmails","membershipRole","appRoles","operationRef","planDigest","policyDigest","fenceGeneration","createdAt",
  "admissionMode","workspaceId",enabled,"signupStorage"),
  update ("appPath",eligibility,"allowedEmails","appRoles","signupStorage","operationRef","planDigest","policyDigest","fenceGeneration",enabled)
  on public.app_signup_policy to __OPERATOR_ROLE__;
