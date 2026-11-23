-- Trusted migration asset. All state lives outside public Auth objects and private history.
create table if not exists _auth_schema_readiness.current_target (
  singleton boolean primary key default true check(singleton),
  state text not null check(state in ('pending','verified')),
  target_digest text not null check(target_digest ~ '^[a-f0-9]{64}$'),
  asset_sha256 text not null check(asset_sha256 ~ '^[a-f0-9]{64}$'),
  runtime_role text not null,
  catalog_fingerprint text check(catalog_fingerprint ~ '^[a-f0-9]{64}$'),
  verified_at timestamptz
);

create or replace function _auth_schema_readiness.normalized_acl(items aclitem[], object_type "char", owner_id oid)
returns jsonb language sql stable security definer set search_path to pg_catalog
as $readiness$
 select coalesce(jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),'grantee',case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,'privilege',a.privilege_type,'grantable',a.is_grantable) order by a.grantor,a.grantee,a.privilege_type,a.is_grantable),'[]')
 from aclexplode(coalesce(items,acldefault(object_type,owner_id))) a
$readiness$;

create or replace function _auth_schema_readiness.catalog_fingerprint(runtime_name text)
returns text language sql stable security definer set search_path to pg_catalog
as $readiness$
  select encode(sha256(convert_to(jsonb_build_array(
    (select coalesce(jsonb_agg(to_jsonb(x) order by table_schema,table_name,ordinal_position),'[]') from
      (select table_schema,table_name,column_name,ordinal_position,data_type,udt_name,is_nullable,column_default
       from information_schema.columns where table_schema in ('public','_auth_schema_readiness')) x),
    (select coalesce(jsonb_agg(to_jsonb(x) order by relname,conname),'[]') from
      (select c.relname,con.conname,con.contype,con.convalidated,pg_get_constraintdef(con.oid) definition
       from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public') x),
    (select coalesce(jsonb_agg(to_jsonb(x) order by relname,index_name),'[]') from
      (select c.relname,i.relname index_name,a.indisvalid,a.indisready,pg_get_indexdef(a.indexrelid) definition
       from pg_index a join pg_class c on c.oid=a.indrelid join pg_class i on i.oid=a.indexrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public') x),
    (select coalesce(jsonb_agg(to_jsonb(x) order by namespace,relname),'[]') from
      (select n.nspname namespace,c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) owner,case when c.relkind in ('r','p','v','m','f') then _auth_schema_readiness.normalized_acl(c.relacl,'r',c.relowner) when c.relkind='S' then _auth_schema_readiness.normalized_acl(c.relacl,'s',c.relowner) else '[]'::jsonb end acl
       from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','_auth_schema_history','_auth_schema_readiness')) x),
    (select coalesce(jsonb_agg(to_jsonb(x) order by relname,tgname),'[]') from
      (select c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid,true) definition,pg_get_functiondef(t.tgfoid) function_definition
       from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal) x),
    (select coalesce(jsonb_agg(to_jsonb(x) order by relname,polname),'[]') from
      (select c.relname,p.polname,p.polcmd,p.polpermissive,p.polroles::text roles,pg_get_expr(p.polqual,p.polrelid) using_expression,pg_get_expr(p.polwithcheck,p.polrelid) check_expression
       from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public') x),
    (select coalesce(jsonb_agg(to_jsonb(x) order by name),'[]') from
      (select nspname name,pg_get_userbyid(nspowner) owner,_auth_schema_readiness.normalized_acl(nspacl,'n',nspowner) acl from pg_namespace where nspname in ('public','_auth_schema_history','_auth_schema_readiness')) x),
    (select coalesce(jsonb_agg(to_jsonb(x) order by name),'[]') from
      (select datname name,pg_get_userbyid(datdba) owner,_auth_schema_readiness.normalized_acl(datacl,'d',datdba) acl from pg_database where datname=current_database()) x),
    (select coalesce(jsonb_agg(to_jsonb(x) order by signature),'[]') from
      (select p.oid::regprocedure::text signature,pg_get_userbyid(p.proowner) owner,_auth_schema_readiness.normalized_acl(p.proacl,'f',p.proowner) acl,pg_get_functiondef(p.oid) definition
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f') x),
    (select coalesce(jsonb_agg(to_jsonb(x) order by namespace,relname,attname),'[]') from
      (select n.nspname namespace,c.relname,a.attname,_auth_schema_readiness.normalized_acl(a.attacl,'c',c.relowner) acl
       from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
       where n.nspname in ('public','_auth_schema_history','_auth_schema_readiness') and a.attnum>0 and not a.attisdropped) x),
    (select coalesce(jsonb_agg(to_jsonb(x) order by rolname),'[]') from
      (select r.rolname,r.rolcanlogin,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,r.rolinherit
       from pg_roles r where pg_has_role(runtime_name,r.oid,'MEMBER')) x),
    (select coalesce(jsonb_agg(to_jsonb(x) order by granted,member,grantor),'[]') from
      (select g.rolname granted,r.rolname member,a.rolname grantor,m.admin_option,m.inherit_option,m.set_option
       from pg_auth_members m join pg_roles g on g.oid=m.roleid join pg_roles r on r.oid=m.member join pg_roles a on a.oid=m.grantor
       where pg_has_role(runtime_name,r.oid,'MEMBER')) x)
  )::text,'UTF8')),'hex')
$readiness$;

create or replace function _auth_schema_readiness.read_current()
returns jsonb language plpgsql volatile security definer set search_path to pg_catalog
as $readiness$
declare published _auth_schema_readiness.current_target%rowtype; observed text;
begin
  if not pg_try_advisory_xact_lock_shared(hashtext('platform:auth-schema:migration:v1')) then
    return jsonb_build_object('version',1,'algorithm','pg-jsonb-catalog-sha256-v1','database',current_database(),'status','migration_in_progress');
  end if;
  select * into published from _auth_schema_readiness.current_target where singleton;
  if not found or published.state <> 'verified' then
    return jsonb_build_object('version',1,'algorithm','pg-jsonb-catalog-sha256-v1','database',current_database(),'status','unverified');
  end if;
  -- A publication fact is not trustworthy if its runtime can rewrite it.
  if (session_user <> published.runtime_role and session_user <> pg_get_userbyid((select nspowner from pg_namespace where nspname='_auth_schema_readiness')))
    or has_schema_privilege(published.runtime_role,'_auth_schema_readiness','CREATE')
    or has_table_privilege(published.runtime_role,'_auth_schema_readiness.current_target','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    or has_any_column_privilege(published.runtime_role,'_auth_schema_readiness.current_target','SELECT,INSERT,UPDATE,REFERENCES')
    or has_schema_privilege(published.runtime_role,'_auth_schema_history','USAGE,CREATE') then
    return jsonb_build_object('version',1,'algorithm','pg-jsonb-catalog-sha256-v1','database',current_database(),'status','unverified');
  end if;
  observed := _auth_schema_readiness.catalog_fingerprint(published.runtime_role);
  return jsonb_build_object('version',1,'algorithm','pg-jsonb-catalog-sha256-v1','database',current_database(),
    'status',case when observed=published.catalog_fingerprint then 'verified' else 'catalog_drift' end,
    'targetDigest',published.target_digest,'assetSha256',published.asset_sha256,
    'publishedFingerprint',published.catalog_fingerprint,'observedFingerprint',observed);
end;
$readiness$;
