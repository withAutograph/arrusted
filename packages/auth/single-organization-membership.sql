-- Same-database projection of Better Auth membership into the kernel's actor
-- classification. Auth is the authority; there is no grant endpoint or fence.
create unique index if not exists autograph_member_identity
  on public.member ("organizationId", "userId");

create or replace function public.autograph_sync_member()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public
as $membership$
declare actor text;
begin
  if tg_table_schema <> 'public' or tg_table_name <> 'member' or tg_nargs <> 3 then
    raise exception 'Invalid membership trigger binding';
  end if;
  for actor in select distinct value from unnest(array[
    case when tg_op <> 'INSERT' and old."organizationId" = tg_argv[2] then old."userId" end,
    case when tg_op <> 'DELETE' and new."organizationId" = tg_argv[2] then new."userId" end
  ]) value where value is not null loop
    insert into public.kernel_actor_membership
      (principal_name, app_id, customer_id, actor_id, role, actor_kind, active, fence_generation)
    values (tg_argv[0]::name, tg_argv[1], tg_argv[2], actor, 'member', 'human',
      exists(select 1 from public.member where "userId" = actor and "organizationId" = tg_argv[2]), 0)
    on conflict (principal_name, app_id, customer_id, actor_id, role) do update
      set active = excluded.active, actor_kind = excluded.actor_kind, bound_at = now();
    -- Existing kernel guards still refuse changing any fenced membership.
  end loop;
  return null;
end
$membership$;
revoke all on function public.autograph_sync_member() from public;
