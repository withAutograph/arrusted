-- Same-database projection of Better Auth membership into the kernel's actor
-- classification. Auth is the authority; there is no grant endpoint or fence.
do $$ begin
  if to_regclass('public.member') is not null then
    create unique index if not exists autograph_member_identity
      on public.member ("organizationId", "userId");
  end if;
end $$;

create or replace function public.autograph_sync_member()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public
as $membership$
declare
  actor text;
  role_name text;
  is_active boolean;
begin
  if (tg_table_schema <> 'public' and tg_table_schema not like 'auth\_%' escape '\')
    or tg_table_name <> 'member'
    or tg_nargs not in (3, 4) then
    raise exception 'Invalid membership trigger binding';
  end if;
  role_name := case when tg_nargs = 4 then tg_argv[3] else 'member' end;
  for actor in select distinct value from unnest(array[
    case when tg_op <> 'INSERT' and old."organizationId" = tg_argv[2] then old."userId" end,
    case when tg_op <> 'DELETE' and new."organizationId" = tg_argv[2] then new."userId" end
  ]) value where value is not null loop
    execute format(
      'select exists(select 1 from %I.member where "userId" = $1 and "organizationId" = $2)',
      tg_table_schema
    ) into is_active using actor, tg_argv[2];
    insert into public.kernel_actor_membership
      (principal_name, app_id, customer_id, actor_id, role, actor_kind, active, fence_generation)
    values (tg_argv[0]::name, tg_argv[1], tg_argv[2], actor, role_name, 'human', is_active, 0)
    on conflict (principal_name, app_id, customer_id, actor_id, role) do update
      set active = excluded.active, actor_kind = excluded.actor_kind, bound_at = now();
    -- Existing kernel guards still refuse changing any fenced membership.
  end loop;
  return null;
end
$membership$;
revoke all on function public.autograph_sync_member() from public;
