begin;

lock table "public"."organization", "public"."member", "public"."invitation", "public"."session" in share row exclusive mode;

-- Legacy unenrolled databases may not have the additive assignment table yet.
-- Lock it when present so remapping and canonicalization remain serialized.
do $$
begin
  if to_regclass('public.app_actor_assignment') is not null then
    execute 'lock table "public"."app_actor_assignment" in share row exclusive mode';
  end if;
end
$$;

do $$
begin
  if exists (select 1 from "public"."organization" where "id" = 'demo')
    and exists (select 1 from "public"."organization" where "id" = 'vendor') then
    raise exception 'Cannot canonicalize Better Auth organization demo: vendor already exists';
  end if;

  if exists (select 1 from "public"."organization" where "id" = 'customer_1')
    and exists (select 1 from "public"."organization" where "id" = 'dev') then
    raise exception 'Cannot canonicalize Better Auth organization customer_1: dev already exists';
  end if;
end
$$;

-- Release the canonical slug before copying a legacy organization that already
-- uses it. The transaction-scoped suffix keeps the temporary value unique, and
-- the source row is deleted before commit.
update "public"."organization"
set "slug" = concat('__platform_migrating_demo_', txid_current())
where "id" = 'demo'
  and "slug" = 'vendor';

insert into "public"."organization" ("id", "name", "slug", "logo", "createdAt", "metadata", "appIds")
select 'vendor', 'Vendor', 'vendor', "logo", "createdAt", "metadata",
       case when jsonb_typeof("appIds") = 'array' then "appIds" else '[]'::jsonb end
from "public"."organization"
where "id" = 'demo';

update "public"."member"
set "organizationId" = 'vendor'
where "organizationId" = 'demo';

update "public"."invitation"
set "organizationId" = 'vendor'
where "organizationId" = 'demo';

update "public"."session"
set "activeOrganizationId" = 'vendor',
    "updatedAt" = now()
where "activeOrganizationId" = 'demo';

-- Preserve explicit application grants while replacing the legacy organization
-- identifier. A duplicate destination key is a conflict and aborts this
-- transaction; never merge or overwrite an existing assignment implicitly.
do $$
begin
  if to_regclass('public.app_actor_assignment') is not null then
    execute 'update "public"."app_actor_assignment" set "organizationId" = ''vendor'' where "organizationId" = ''demo''';
  end if;
end
$$;

delete from "public"."organization"
where "id" = 'demo';

update "public"."organization"
set "slug" = concat('__platform_migrating_customer_1_', txid_current())
where "id" = 'customer_1'
  and "slug" = 'dev';

insert into "public"."organization" ("id", "name", "slug", "logo", "createdAt", "metadata", "appIds")
select 'dev', 'Dev', 'dev', "logo", "createdAt", "metadata",
       case when jsonb_typeof("appIds") = 'array' then "appIds" else '[]'::jsonb end
from "public"."organization"
where "id" = 'customer_1';

update "public"."member"
set "organizationId" = 'dev'
where "organizationId" = 'customer_1';

update "public"."invitation"
set "organizationId" = 'dev'
where "organizationId" = 'customer_1';

update "public"."session"
set "activeOrganizationId" = 'dev',
    "updatedAt" = now()
where "activeOrganizationId" = 'customer_1';

do $$
begin
  if to_regclass('public.app_actor_assignment') is not null then
    execute 'update "public"."app_actor_assignment" set "organizationId" = ''dev'' where "organizationId" = ''customer_1''';
  end if;
end
$$;

delete from "public"."organization"
where "id" = 'customer_1';

commit;
