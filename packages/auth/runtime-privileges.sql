-- Protected enrolled Auth host only. __RUNTIME_ROLE__ is an installer-quoted identifier.
drop function if exists public.enroll_app_signup_user(text,text,text,text);
create or replace function public.enroll_app_signup_user(requested_user text, requested_session text, requested_resource_digest text, requested_origin text, requested_path text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public
as $signup$
declare signup_policy public.app_signup_policy%rowtype; actor_email text; actor_email_verified boolean; membership text; session_bound boolean := false;
begin
  select * into signup_policy from public.app_signup_policy
    where "admissionMode"='legacy' and "resourceDigest"=requested_resource_digest and "origin"=requested_origin and "appPath"=requested_path
    limit 1;
  if not found then return jsonb_build_object('status','waiting_for_signup'); end if;
  select email,"emailVerified" into actor_email,actor_email_verified from public."user" where id=requested_user;
  if actor_email is null or signup_policy."membershipRole" <> 'member'
    or not exists(select 1 from public.organization where id=signup_policy."organizationId" and "appIds" @> jsonb_build_array(signup_policy."appId"))
    or signup_policy."eligibility"='approved-email' and (not actor_email_verified or not exists (
      select 1 from jsonb_array_elements_text(signup_policy."allowedEmails") e where lower(e)=lower(actor_email)
    )) then return jsonb_build_object('status','blocked'); end if;
  if exists (
    select 1 from jsonb_array_elements_text(signup_policy."appRoles") roles(role_name)
    join public.app_actor_assignment a on a."organizationId"=signup_policy."organizationId"
      and a."actorId"=requested_user and a."appId"=signup_policy."appId" and a.role=roles.role_name
    where not a.active
  ) then return jsonb_build_object('status','blocked'); end if;
  select id into membership from public.member where "organizationId"=signup_policy."organizationId" and "userId"=requested_user limit 1;
  if membership is null then
    insert into public.member(id,"organizationId","userId",role,"createdAt")
      values(signup_policy.id || ':' || requested_user || ':member',signup_policy."organizationId",requested_user,'member',now())
      on conflict(id) do nothing returning id into membership;
    if membership is null then
      select id into membership from public.member where "organizationId"=signup_policy."organizationId" and "userId"=requested_user limit 1;
    end if;
  end if;
  if membership is null then return jsonb_build_object('status','blocked'); end if;
  insert into public.app_actor_assignment("organizationId","actorId","appId",role)
    select signup_policy."organizationId",requested_user,signup_policy."appId",roles.role_name
      from jsonb_array_elements_text(signup_policy."appRoles") as roles(role_name)
    on conflict("organizationId","actorId","appId",role) do nothing;
  if exists (
    select 1 from jsonb_array_elements_text(signup_policy."appRoles") roles(role_name)
    where not exists (select 1 from public.app_actor_assignment a where a."organizationId"=signup_policy."organizationId"
      and a."actorId"=requested_user and a."appId"=signup_policy."appId" and a.role=roles.role_name and a.active)
  ) then raise exception 'signup_policy_role_inactive'; end if;
  if requested_session is not null then
    update public.session set "activeOrganizationId"=signup_policy."organizationId","updatedAt"=now()
      where "id"=requested_session and "userId"=requested_user and "expiresAt">clock_timestamp()
      returning true into session_bound;
  end if;
  return jsonb_build_object('status','membership_ready','appId',signup_policy."appId",
    'organizationId',signup_policy."organizationId","roles",signup_policy."appRoles",'sessionBound',coalesce(session_bound,false));
end;
$signup$;
revoke all on function public.enroll_app_signup_user(text,text,text,text,text) from public;

-- An invitation verifies identity only. The protected operator grants app access afterward.
create or replace function public.verify_app_access_invitation(
  requested_invitation text, requested_user text, requested_session text, requested_resource_digest text
) returns boolean language plpgsql security definer set search_path=pg_catalog,public
as $invitation$
declare verified boolean;
begin
  update public.app_access_invitation i
     set status=case when i.status='accepted' then 'accepted' else 'verified' end, "verifiedActorId"=requested_user,
         "verifiedSessionId"=requested_session, "verifiedAt"=now()
   where i.id=requested_invitation and i."signupPolicyId" is null and i."resourceDigest"=requested_resource_digest
     and (i.status='accepted' or (i.status in ('pending','verified') and i."expiresAt">clock_timestamp()))
     and (i."verifiedActorId" is null or i."verifiedActorId"=requested_user)
     and exists (
       select 1 from public."user" u join public.session s on s."userId"=u.id
       where u.id=requested_user and u."emailVerified" and lower(u.email)=lower(i.email)
         and s.id=requested_session and s."expiresAt">clock_timestamp()
     ) returning true into verified;
  return coalesce(verified,false);
end;
$invitation$;
revoke all on function public.verify_app_access_invitation(text,text,text,text) from public;

create or replace function public.record_app_invitation_delivery(
  requested_invitation text, requested_attempt text, requested_provider_id text
) returns boolean language plpgsql security definer set search_path=pg_catalog,public
as $delivery$
declare recorded boolean;
begin
  update public.app_access_invitation set "deliveryStatus"='sent', "deliveryProviderId"=requested_provider_id
   where id=requested_invitation and "deliveryAttemptId"=requested_attempt
     and "deliveryStatus" in ('sending','unknown','sent') and status='pending'
     and length(requested_provider_id)>0
   returning true into recorded;
  return coalesce(recorded,false);
end;
$delivery$;
revoke all on function public.record_app_invitation_delivery(text,text,text) from public;

-- A verified runtime can mint a frozen signup claim, never an app grant.
create or replace function public.claim_managed_app_signup(
  requested_policy text, requested_policy_digest text, requested_user text, requested_session text,
  requested_resource_digest text, requested_workspace text, requested_origin text
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $managed_signup$
declare
  policy public.app_signup_policy%rowtype;
  existing public.app_access_invitation%rowtype;
  actor_email text;
  claim_id text;
  claim_scope text;
begin
  select * into policy from public.app_signup_policy where id=requested_policy
    and "admissionMode"='managed-production' and "policyDigest"=requested_policy_digest
    and "resourceDigest"=requested_resource_digest and "workspaceId"=requested_workspace
    and origin=requested_origin and "membershipRole"='member' and "fenceGeneration">0 for share;
  if not found then return null; end if;
  -- This lock is shared with the protected frontend grant/revoke transaction.
  perform id from public.organization where id=policy."organizationId" for update;
  if not found then return null; end if;
  select lower(email) into actor_email from public."user" where id=requested_user and "emailVerified" for share;
  if not found then return null; end if;
  perform id from public.session where id=requested_session and "userId"=requested_user
    and "expiresAt">clock_timestamp() for share;
  if not found then return null; end if;
  if policy.eligibility='approved-email' and not exists(
    select 1 from jsonb_array_elements_text(policy."allowedEmails") e where lower(e)=actor_email
  ) then return null; end if;
  select * into existing from public.app_access_invitation where "workspaceId"=requested_workspace
    and "appId"=policy."appId" and "organizationId"=policy."organizationId" and "verifiedActorId"=requested_user
    and "signupPolicyId" is not null for update;
  if found then
    if existing."signupPolicyId"=policy.id and existing."signupPolicyDigest"=policy."policyDigest"
      and existing."verifiedSessionId"=requested_session and existing.email=actor_email
      and (existing.status='accepted' or (policy.enabled and existing.status='verified' and existing."expiresAt">clock_timestamp()))
      then return jsonb_build_object('id',existing.id,'appId',existing."appId",'organizationId',existing."organizationId"); end if;
    -- Only an unreserved proof may be renewed. The organization lock serializes
    -- this with protected reservation, which commits before any kernel write.
    if not policy.enabled or existing.status<>'verified' or existing."signupPolicyId"<>policy.id
      or existing."resourceDigest"<>requested_resource_digest
      or existing."signupGrantOperationRef" is not null or existing."signupGrantFence" is not null
      or jsonb_array_length(existing."signupGrantFences")<>0
      or exists(select 1 from public.app_actor_access where "organizationId"=policy."organizationId"
        and "actorId"=requested_user and "appId"=policy."appId")
      or exists(select 1 from public.app_actor_assignment where "organizationId"=policy."organizationId"
        and "actorId"=requested_user and "appId"=policy."appId") then return null; end if;
    -- A nonce invalidates even an expired same-session proof. Keep its stable
    -- row identity; Builder retains the old tuple in its renewal journal audit.
    claim_scope := encode(sha256(convert_to(jsonb_build_array('managed-signup-renew-v1',existing.id,policy.id,policy."policyDigest",
      requested_resource_digest,requested_workspace,policy."appId",policy."organizationId",requested_user,requested_session,gen_random_uuid())::text,'UTF8')),'hex');
    update public.app_access_invitation set email=actor_email,roles=policy."appRoles",
      "returnUrl"=policy.origin||policy."appPath","operationRef"=policy."operationRef","planDigest"=policy."planDigest",
      "scopeDigest"=claim_scope,"fenceGeneration"=policy."fenceGeneration","expiresAt"=clock_timestamp()+interval '1 hour',
      "verifiedSessionId"=requested_session,"verifiedAt"=clock_timestamp(),"signupPolicyDigest"=policy."policyDigest"
      where id=existing.id;
    return jsonb_build_object('id',existing.id,'appId',existing."appId",'organizationId',existing."organizationId");
  end if;
  if not policy.enabled or exists(select 1 from public.app_actor_access where "organizationId"=policy."organizationId"
    and "actorId"=requested_user and "appId"=policy."appId")
    or exists(select 1 from public.app_actor_assignment where "organizationId"=policy."organizationId"
    and "actorId"=requested_user and "appId"=policy."appId") then return null; end if;
  claim_id := gen_random_uuid()::text;
  claim_scope := encode(sha256(convert_to(jsonb_build_array('managed-signup-v1',claim_id,policy.id,policy."policyDigest",
    requested_resource_digest,requested_workspace,policy."appId",policy."organizationId",requested_user,requested_session)::text,'UTF8')),'hex');
  insert into public.app_access_invitation(id,"workspaceId","resourceDigest","appId","organizationId",email,roles,
    "returnUrl","operationRef","planDigest","scopeDigest","fenceGeneration",status,"expiresAt",
    "verifiedActorId","verifiedSessionId","verifiedAt","signupPolicyId","signupPolicyDigest")
    values(claim_id,requested_workspace,requested_resource_digest,policy."appId",policy."organizationId",actor_email,policy."appRoles",
      policy.origin||policy."appPath",policy."operationRef",policy."planDigest",claim_scope,policy."fenceGeneration",'verified',clock_timestamp()+interval '1 hour',
      requested_user,requested_session,clock_timestamp(),policy.id,policy."policyDigest");
  return jsonb_build_object('id',claim_id,'appId',policy."appId",'organizationId',policy."organizationId");
end;
$managed_signup$;
revoke all on function public.claim_managed_app_signup(text,text,text,text,text,text,text) from public;

grant usage on schema public to __RUNTIME_ROLE__;
-- IDs are text; the configured schema has no generated sequences.
-- Table-level REVOKE does not clear pre-existing column grants.
-- Inspect only this explicit profile, never every public table.
do $runtime_acl$
declare
  table_name text;
  columns_sql text;
begin
  foreach table_name in array array['user','session','account','verification','organization','member','invitation','app_actor_assignment','app_signup_policy','app_access_invitation','app_actor_access',
    'jwks','oauthClient','oauthResource','oauthClientResource','oauthRefreshToken','oauthAccessToken','oauthConsent','oauthClientAssertion','deviceCode'] loop
    if not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname=table_name and pg_get_userbyid(c.relowner)=current_user and c.relkind='r') then
      raise exception 'Auth runtime profile requires migrator-owned table %', table_name;
    end if;
    select string_agg(quote_ident(a.attname),',' order by a.attnum) into columns_sql
      from pg_attribute a where a.attrelid=format('public.%I',table_name)::regclass and a.attnum>0 and not a.attisdropped;
    execute format('revoke all (%s) on table public.%I from public, %I', columns_sql,table_name,__RUNTIME_ROLE_LITERAL__);
  end loop;
end
$runtime_acl$;
revoke all on table public."user", public.session, public.account, public.verification,
  public.organization, public.member, public.invitation, public.app_actor_assignment, public.app_signup_policy, public.app_access_invitation, public.app_actor_access
  from public, __RUNTIME_ROLE__;
grant select, insert, update on table public."user" to __RUNTIME_ROLE__;
grant select, insert, update, delete on table public.session, public.account,
  public.verification to __RUNTIME_ROLE__;
grant select on table public.organization, public.app_actor_assignment to __RUNTIME_ROLE__;
grant select on table public.app_signup_policy to __RUNTIME_ROLE__;
grant execute on function public.enroll_app_signup_user(text,text,text,text,text) to __RUNTIME_ROLE__;
grant execute on function public.claim_managed_app_signup(text,text,text,text,text,text,text) to __RUNTIME_ROLE__;
grant select on table public.app_access_invitation to __RUNTIME_ROLE__;
grant select on table public.app_actor_access to __RUNTIME_ROLE__;
grant execute on function public.verify_app_access_invitation(text,text,text,text) to __RUNTIME_ROLE__;
grant execute on function public.record_app_invitation_delivery(text,text,text) to __RUNTIME_ROLE__;
grant update (name, slug, logo) on table public.organization to __RUNTIME_ROLE__;
grant select, insert, delete on table public.member to __RUNTIME_ROLE__;
grant update (role) on table public.member to __RUNTIME_ROLE__;
-- Resend extends expiresAt directly; accept/reject/cancel transition status.
grant select, insert on table public.invitation to __RUNTIME_ROLE__;
grant update (status, "expiresAt") on table public.invitation to __RUNTIME_ROLE__;
-- Agent and canvas authorization server (jwt, oauth-provider, device
-- authorization): the runtime issues and revokes grants, clients, tokens,
-- device codes and its own signing keys.
revoke all on table public.jwks, public."oauthClient", public."oauthResource",
  public."oauthClientResource", public."oauthRefreshToken", public."oauthAccessToken",
  public."oauthConsent", public."oauthClientAssertion", public."deviceCode"
  from public, __RUNTIME_ROLE__;
grant select, insert, update, delete on table public.jwks, public."oauthClient",
  public."oauthResource", public."oauthClientResource", public."oauthRefreshToken",
  public."oauthAccessToken", public."oauthConsent", public."oauthClientAssertion",
  public."deviceCode"
  to __RUNTIME_ROLE__;
