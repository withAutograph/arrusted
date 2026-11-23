do $$
begin
  if to_regclass('public.account') is not null then
    if exists (
      select 1
      from "public"."account"
      group by "providerId", "accountId"
      having count(*) > 1
    ) then
      raise exception 'Auth account migration found duplicate (providerId, accountId) identities. Resolve the duplicate accounts before provisioning Better Auth 1.7.3.';
    end if;

    if exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'account'
        and column_name = 'issuer'
    ) then
      alter table "public"."account" alter column "issuer" drop not null;
    end if;

    create unique index if not exists "account_provider_id_account_id_uidx"
      on "public"."account" ("providerId", "accountId");
  end if;
end
$$;
