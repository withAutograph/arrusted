-- Narrow identity locks and member-only insertion for the protected access operator.
-- The schema owner installs these; browser and PUBLIC principals receive no EXECUTE.
create or replace function public.lock_auth_operator_user(requested_actor text)
returns boolean language plpgsql security definer set search_path=pg_catalog,public
as $operator_user$
begin
  perform id from public."user" where id=requested_actor and "emailVerified"=true for share;
  return found;
end;
$operator_user$;
revoke all on function public.lock_auth_operator_user(text) from public;

create or replace function public.lock_auth_operator_member(requested_organization text, requested_actor text)
returns table(id text, role text) language sql security definer set search_path=pg_catalog,public
as $operator_member$
  select m.id,m.role from public.member m
    where m."organizationId"=requested_organization and m."userId"=requested_actor for share;
$operator_member$;
revoke all on function public.lock_auth_operator_member(text,text) from public;

create or replace function public.insert_auth_operator_member(requested_id text, requested_organization text, requested_actor text)
returns void language plpgsql security definer set search_path=pg_catalog,public
as $operator_insert$
begin
  if not public.lock_auth_operator_user(requested_actor) then
    raise exception 'auth_identity_required';
  end if;
  perform id from public.organization where id=requested_organization for share;
  if not found then raise exception 'auth_membership_required'; end if;
  -- Match the compact JSON lock key used by the existing membership worker.
  perform pg_advisory_xact_lock(hashtextextended(
    '["managed-membership-v1",'||to_json(requested_organization)::text||','||to_json(requested_actor)::text||']',0));
  if not exists(select 1 from public.member where "organizationId"=requested_organization and "userId"=requested_actor) then
    insert into public.member(id,"organizationId","userId",role,"createdAt")
      values(requested_id,requested_organization,requested_actor,'member',now());
  end if;
end;
$operator_insert$;
revoke all on function public.insert_auth_operator_member(text,text,text) from public;
