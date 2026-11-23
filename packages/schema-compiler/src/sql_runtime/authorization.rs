use super::RuntimeSqlFunction;

pub(super) fn functions() -> Vec<RuntimeSqlFunction> {
    [
        ("kernel_read_actor_access(jsonb)", KERNEL_READ_ACTOR_ACCESS),
        ("kernel_bind_actor_access(jsonb)", KERNEL_BIND_ACTOR_ACCESS),
        (
            "kernel_roleless_access_authorized(text,text,text,text)",
            KERNEL_ROLELESS_ACCESS_AUTHORIZED,
        ),
        (
            "kernel_read_actor_binding(jsonb)",
            KERNEL_READ_ACTOR_BINDING,
        ),
        (
            "kernel_bind_actor_membership(jsonb)",
            KERNEL_BIND_ACTOR_MEMBERSHIP,
        ),
        (
            "kernel_sync_schema_authorization_policy(bigint)",
            KERNEL_SYNC_SCHEMA_AUTHORIZATION_POLICY,
        ),
        (
            "kernel_policy_active_snapshot(text,text)",
            KERNEL_POLICY_ACTIVE_SNAPSHOT,
        ),
        (
            "kernel_policy_request_actor(text,text)",
            KERNEL_POLICY_REQUEST_ACTOR,
        ),
        ("kernel_request_marked_agent()", KERNEL_REQUEST_MARKED_AGENT),
        (
            "kernel_request_is_agent(text,text,text)",
            KERNEL_REQUEST_IS_AGENT,
        ),
        ("kernel_request_turn_id()", KERNEL_REQUEST_TURN_ID),
        (
            "kernel_policy_capture_grants(jsonb,text,text)",
            KERNEL_POLICY_CAPTURE_GRANTS,
        ),
        (
            "kernel_policy_grants_fields_allowed(jsonb,jsonb)",
            KERNEL_POLICY_GRANTS_FIELDS_ALLOWED,
        ),
        (
            "kernel_policy_grants_record_allowed(jsonb,jsonb,jsonb)",
            KERNEL_POLICY_GRANTS_RECORD_ALLOWED,
        ),
        (
            "kernel_policy_grants_record_sql(jsonb,jsonb,text)",
            KERNEL_POLICY_GRANTS_RECORD_SQL,
        ),
        (
            "kernel_policy_required_fields_allowed(jsonb,text,text,jsonb)",
            KERNEL_POLICY_REQUIRED_FIELDS_ALLOWED,
        ),
        (
            "kernel_policy_record_allowed(jsonb,text,text,jsonb,jsonb)",
            KERNEL_POLICY_RECORD_ALLOWED,
        ),
        (
            "kernel_policy_authorize_query(text,text,text,jsonb)",
            KERNEL_POLICY_AUTHORIZE_QUERY,
        ),
        (
            "kernel_policy_raw_table_access_allowed(name,text,text)",
            KERNEL_POLICY_RAW_TABLE_ACCESS_ALLOWED,
        ),
    ]
    .into_iter()
    .map(|(signature, sql)| RuntimeSqlFunction {
        signature,
        sql: sql.trim().to_string(),
    })
    .collect()
}

const KERNEL_ROLELESS_ACCESS_AUTHORIZED: &str = r#"
create or replace function kernel_roleless_access_authorized(app text, customer text, actor text, generation text)
returns boolean language plpgsql volatile parallel unsafe security invoker set search_path from current
as $kernel$
begin
  -- Named-role schema activation atomically closes these admissions. Keep the
  -- request boundary free of schema snapshot reads, whose tenant RLS calls us.
  -- Every data operation also evaluates the current schema policy.
  perform 1 from kernel_actor_access a
    where a.principal_name=session_user::name and a.app_id=app and a.customer_id=customer
      and a.actor_id=actor and a.active and a.fence_generation>0
      and a.fence_generation::text=generation for share of a;
  return found;
end;
$kernel$;
"#;

const KERNEL_READ_ACTOR_ACCESS: &str = r#"
create or replace function kernel_read_actor_access(request jsonb)
returns jsonb language plpgsql stable parallel safe security invoker set search_path from current
as $kernel$
declare app text:=request->>'app_id'; customer text:=request->>'customer_id'; actor text:=request->>'actor_id'; binding jsonb;
begin
  if request is null or jsonb_typeof(request)<>'object' or request-array['app_id','customer_id','actor_id']::text[]<>'{}'::jsonb or jsonb_typeof(request->'app_id')<>'string' or jsonb_typeof(request->'customer_id')<>'string' or jsonb_typeof(request->'actor_id')<>'string' or coalesce(btrim(app),'')='' or coalesce(btrim(customer),'')='' or coalesce(btrim(actor),'')='' then
    return kernel_installer_error('contract_validation_failed','Contract validation failed','request','invalid_actor_access','app_id, customer_id and actor_id are required');
  end if;
  if not exists(select 1 from kernel_principal_scope s where s.principal_name=session_user::name and s.active and s.capability='runtime' and s.app_id=app and s.customer_id=customer and (s.actor_id is null or s.actor_id=actor) and pg_has_role(session_user,pg_catalog.to_regrole(kernel_installer_capability_role('runtime')),'MEMBER')) then return kernel_installer_error('authorization_denied','Runtime scope is not authorized','request','scope_mismatch','the current runtime principal is not bound to this app and organization'); end if;
  select jsonb_build_object('appId',a.app_id,'actorId',a.actor_id,'organizationId',a.customer_id,'active',a.active,'fenceGeneration',a.fence_generation)
  into binding from kernel_actor_access a
  where a.principal_name=session_user::name and a.app_id=app and a.customer_id=customer and a.actor_id=actor;
  return jsonb_build_object('ok',true,'data',binding);
end;
$kernel$;
"#;

const KERNEL_BIND_ACTOR_ACCESS: &str = r#"
create or replace function kernel_bind_actor_access(request jsonb)
returns jsonb language plpgsql volatile parallel unsafe security invoker set search_path from current
as $kernel$
declare principal text:=request->>'principal_name'; app text:=request->>'app_id'; customer text:=request->>'customer_id'; actor text:=request->>'actor_id'; active_value boolean; actor_kind_value text:=request->>'actor_kind'; generation bigint; applied record; runtime_role text:=kernel_installer_capability_role('runtime');
begin
  if request is null or jsonb_typeof(request)<>'object' or request-array['principal_name','app_id','customer_id','actor_id','active','fence_generation','actor_kind']::text[]<>'{}'::jsonb or coalesce(btrim(principal),'')='' or coalesce(btrim(app),'')='' or coalesce(btrim(customer),'')='' or coalesce(btrim(actor),'')='' or jsonb_typeof(request->'active') is distinct from 'boolean' or coalesce(actor_kind_value,'') not in ('human','agent') or jsonb_typeof(request->'fence_generation') is distinct from 'number' or coalesce(request->>'fence_generation','') !~ '^[1-9][0-9]*$' then
    return kernel_installer_error('contract_validation_failed','Contract validation failed','request','invalid_actor_access','principal, scope, actor kind, active and positive fence generation are required');
  end if;
  if (request->>'fence_generation')::numeric>9007199254740991 then return kernel_installer_error('contract_validation_failed','Contract validation failed','fence_generation','invalid_fence_generation','a positive safe integer is required'); end if;
  generation:=(request->>'fence_generation')::bigint; active_value:=(request->>'active')::boolean;
  if not kernel_principal_scope_authorized('schema_admin',app,customer,null) then return kernel_authorize_scope('schema_admin',app,customer,null); end if;
  if to_regrole(principal) is null then return kernel_installer_error('contract_validation_failed','Contract validation failed','principal_name','unknown_principal','database principal does not exist'); end if;
  if not pg_has_role(principal,pg_catalog.to_regrole(runtime_role),'MEMBER') then return kernel_installer_error('authorization_denied','Principal lacks runtime capability role','principal_name','runtime_capability_role_missing','bind the runtime capability first'); end if;
  perform set_config('kernel.app_id',app,true); perform set_config('kernel.customer_id',customer,true);
  if active_value and coalesce(jsonb_array_length(kernel_policy_active_snapshot(app,customer)->'policy'->'roles'),0)<>0 then return kernel_installer_error('authorization_denied','Named business roles are required','request','role_policy_required','role-less admission cannot replace named policy grants'); end if;
  insert into kernel_actor_access(principal_name,app_id,customer_id,actor_id,active,actor_kind,fence_generation,bound_at)
    values(principal::name,app,customer,actor,active_value,actor_kind_value,generation,now())
    on conflict on constraint kernel_actor_access_pkey do update set active=excluded.active,actor_kind=excluded.actor_kind,fence_generation=excluded.fence_generation,
      bound_at=case when kernel_actor_access.fence_generation<excluded.fence_generation then now() else kernel_actor_access.bound_at end
    where kernel_actor_access.fence_generation<excluded.fence_generation or
      (kernel_actor_access.fence_generation=excluded.fence_generation and kernel_actor_access.active=excluded.active and kernel_actor_access.actor_kind=excluded.actor_kind)
    returning active,fence_generation,actor_kind into applied;
  if not found then return kernel_installer_error('authorization_denied','Actor access fence rejected the write','fence_generation','stale_or_conflicting_generation','a newer operation or conflicting intent owns this admission'); end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('principal_name',principal,'app_id',app,'customer_id',customer,'actor_id',actor,'active',applied.active,'fence_generation',applied.fence_generation,'actor_kind',applied.actor_kind));
end;
$kernel$;
"#;

const KERNEL_READ_ACTOR_BINDING: &str = r#"
create or replace function kernel_read_actor_binding(request jsonb)
returns jsonb language plpgsql stable parallel safe security invoker set search_path from current
as $kernel$
declare app text:=request->>'app_id'; customer text:=request->>'customer_id'; actor text:=request->>'actor_id'; role_name text:=request->>'role'; binding jsonb;
begin
  if request is null or jsonb_typeof(request)<>'object' or request-array['app_id','customer_id','actor_id','role']::text[]<>'{}'::jsonb or jsonb_typeof(request->'app_id')<>'string' or jsonb_typeof(request->'customer_id')<>'string' or jsonb_typeof(request->'actor_id')<>'string' or jsonb_typeof(request->'role')<>'string' or coalesce(btrim(app),'')='' or coalesce(btrim(customer),'')='' or coalesce(btrim(actor),'')='' or coalesce(btrim(role_name),'')='' then
    return kernel_installer_error('contract_validation_failed','Contract validation failed','request','invalid_actor_binding','app_id, customer_id, actor_id and role are required');
  end if;
  if not exists(select 1 from kernel_principal_scope s where s.principal_name=session_user::name and s.active and s.capability='runtime' and s.app_id=app and s.customer_id=customer and (s.actor_id is null or s.actor_id=actor) and pg_has_role(session_user,pg_catalog.to_regrole(kernel_installer_capability_role('runtime')),'MEMBER')) then return kernel_installer_error('authorization_denied','Runtime scope is not authorized','request','scope_mismatch','the current runtime principal is not bound to this app and organization'); end if;
  select jsonb_build_object('appId',m.app_id,'actorId',m.actor_id,'organizationId',m.customer_id,'role',m.role,'active',m.active,'fenceGeneration',m.fence_generation)
  into binding from kernel_actor_membership m
  where m.principal_name=session_user::name and m.app_id=app and m.customer_id=customer and m.actor_id=actor and m.role=role_name;
  return jsonb_build_object('ok',true,'data',binding);
end;
$kernel$;
"#;

const KERNEL_BIND_ACTOR_MEMBERSHIP: &str = r#"
create or replace function kernel_bind_actor_membership(request jsonb)
returns jsonb language plpgsql volatile parallel unsafe security invoker set search_path from current
as $kernel$
declare principal text:=request->>'principal_name'; app text:=request->>'app_id'; customer text:=request->>'customer_id'; actor text:=request->>'actor_id'; role_name text:=request->>'role'; active_value boolean:=true; actor_kind_value text:=coalesce(request->>'actor_kind','agent'); fence_generation_value bigint:=0; requested_generation numeric; applied record; runtime_role text:=kernel_installer_capability_role('runtime');
begin
  if request is null or jsonb_typeof(request)<>'object' or request-array['principal_name','app_id','customer_id','actor_id','role','active','fence_generation','actor_kind']::text[]<>'{}'::jsonb or coalesce(btrim(principal),'')='' or coalesce(btrim(app),'')='' or coalesce(btrim(customer),'')='' or coalesce(btrim(actor),'')='' or coalesce(btrim(role_name),'')='' or (request?'active' and jsonb_typeof(request->'active')<>'boolean') or actor_kind_value not in ('human','agent','service') or (request?'actor_kind' and jsonb_typeof(request->'actor_kind')<>'string') then
    return kernel_installer_error('contract_validation_failed','Contract validation failed','request','invalid_actor_membership','principal_name, app_id, customer_id, actor_id, role, and optional boolean active and nonnegative integer fence_generation are required');
  end if;
  if request?'active' then active_value := (request->>'active')::boolean; end if;
  if request?'fence_generation' then
    if jsonb_typeof(request->'fence_generation')<>'number' or (request->>'fence_generation') !~ '^(0|[1-9][0-9]*)$' then
      return kernel_installer_error('contract_validation_failed','Contract validation failed','fence_generation','invalid_fence_generation','fence_generation must be a nonnegative safe integer');
    end if;
    requested_generation := (request->>'fence_generation')::numeric;
    if requested_generation > 9007199254740991 then
      return kernel_installer_error('contract_validation_failed','Contract validation failed','fence_generation','invalid_fence_generation','fence_generation must be a nonnegative safe integer');
    end if;
    fence_generation_value := requested_generation::bigint;
  end if;
  if not kernel_principal_scope_authorized('schema_admin',app,customer,null) then return kernel_authorize_scope('schema_admin',app,customer,null); end if;
  if to_regrole(principal) is null then return kernel_installer_error('contract_validation_failed','Contract validation failed','principal_name','unknown_principal','database principal does not exist'); end if;
  if not pg_has_role(principal,pg_catalog.to_regrole(runtime_role),'MEMBER') then return kernel_installer_error('authorization_denied','Principal lacks runtime capability role','principal_name','runtime_capability_role_missing','bind the generated runtime capability role before binding actor membership'); end if;
  insert into kernel_actor_membership(principal_name,app_id,customer_id,actor_id,role,active,actor_kind,fence_generation,bound_at) values(principal::name,app,customer,actor,role_name,active_value,actor_kind_value,fence_generation_value,now())
  on conflict on constraint kernel_actor_membership_pkey do update
    set active=excluded.active,
        actor_kind=excluded.actor_kind,
        fence_generation=excluded.fence_generation,
        bound_at=case when excluded.fence_generation=0 or kernel_actor_membership.fence_generation<excluded.fence_generation then now() else kernel_actor_membership.bound_at end
    where (excluded.fence_generation=0 and kernel_actor_membership.fence_generation=0)
       or kernel_actor_membership.fence_generation<excluded.fence_generation
       or (kernel_actor_membership.fence_generation=excluded.fence_generation and kernel_actor_membership.active=excluded.active and kernel_actor_membership.actor_kind=excluded.actor_kind)
  returning active,fence_generation,actor_kind into applied;
  if not found then
    return kernel_installer_error('authorization_denied','Actor membership fence rejected the write','fence_generation','stale_or_conflicting_generation','a newer operation or conflicting intent already owns this membership');
  end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('principal_name',principal,'app_id',app,'customer_id',customer,'actor_id',actor,'role',role_name,'active',applied.active,'fence_generation',applied.fence_generation,'actor_kind',applied.actor_kind));
end;
$kernel$;
"#;

const KERNEL_SYNC_SCHEMA_AUTHORIZATION_POLICY: &str = r#"
create or replace function kernel_sync_schema_authorization_policy(requested_revision_id bigint)
returns void
language plpgsql
volatile
parallel unsafe
security invoker
set search_path from current
as $kernel$
declare
  revision_row record;
  expected_row record;
  source_row record;
  snapshot_row record;
  expectation_found boolean := false;
  expected_policy_declared boolean := false;
  revision_marker_present boolean := false;
  revision_policy_declared boolean := null;
begin
  select *, base_schema->>'version' as base_version
  into strict revision_row
  from schema_revision
  where id = requested_revision_id
  for update;

  revision_marker_present := to_jsonb(revision_row) ? 'authorization_policy_declared';
  if revision_marker_present then
    revision_policy_declared := (to_jsonb(revision_row)->>'authorization_policy_declared')::boolean;
  end if;

  select policy_declared, policy_hash
  into expected_row
  from schema_authorization_policy_expectation
  where app_id = revision_row.app_id
    and schema_version = revision_row.base_version;
  expectation_found := found;
  if expectation_found then
    expected_policy_declared := expected_row.policy_declared;
    if not revision_marker_present then
      raise exception 'schema_drift: authorization policy expectation requires a revision policy marker';
    end if;
    if revision_policy_declared is not null
      and revision_policy_declared is distinct from expected_policy_declared
    then
      raise exception 'schema_drift: authorization policy marker differs from release expectation';
    end if;
    update schema_revision
    set authorization_policy_declared = expected_policy_declared
    where id = revision_row.id;
  end if;

  if not expectation_found then
    if revision_policy_declared then
      raise exception 'schema_drift: active declared policy marker exists without a release expectation';
    end if;
    -- A historical issued release predates all policy artifacts. Do not add a
    -- snapshot during a later installer upgrade: absence is its legacy proof.
    if exists (
      select 1
      from schema_authorization_policy_source
      where app_id = revision_row.app_id
        and schema_version = revision_row.base_version
    ) or exists (
      select 1
      from schema_authorization_policy_snapshot
      where schema_revision_id = revision_row.id
        and app_id = revision_row.app_id
        and customer_id = revision_row.customer_id
    ) then
      raise exception 'schema_drift: authorization policy artifacts exist without a release expectation';
    end if;
    return;
  elsif not expected_policy_declared then
    if expected_row.policy_hash is not null then
      raise exception 'schema_drift: authorization policy expectation has a hash while policy is undeclared';
    end if;
    insert into schema_authorization_policy_snapshot(
      schema_revision_id, app_id, customer_id, policy, policy_hash
    ) values (
      revision_row.id, revision_row.app_id, revision_row.customer_id, null, null
    ) on conflict do nothing;
  else
    if expected_row.policy_hash is null
      or expected_row.policy_hash !~ '^[0-9a-f]{64}$'
    then
      raise exception 'schema_drift: declared authorization policy expectation is malformed';
    end if;
    select policy, policy_hash
    into source_row
    from schema_authorization_policy_source
    where app_id = revision_row.app_id
      and schema_version = revision_row.base_version;
    if not found
      or source_row.policy_hash is distinct from expected_row.policy_hash
      or source_row.policy_hash !~ '^[0-9a-f]{64}$'
      or kernel_admin_sha256(kernel_canonical_json(source_row.policy))
        is distinct from source_row.policy_hash
    then
      raise exception 'schema_drift: declared authorization policy source is missing or altered';
    end if;
    insert into schema_authorization_policy_snapshot(
      schema_revision_id, app_id, customer_id, policy, policy_hash
    ) values (
      revision_row.id, revision_row.app_id, revision_row.customer_id,
      source_row.policy, source_row.policy_hash
    ) on conflict do nothing;
  end if;

  select policy, policy_hash
  into snapshot_row
  from schema_authorization_policy_snapshot
  where schema_revision_id = revision_row.id
    and app_id = revision_row.app_id
    and customer_id = revision_row.customer_id;
  if not found
    or (
      expected_policy_declared
      and (
        snapshot_row.policy is null
        or snapshot_row.policy_hash is distinct from expected_row.policy_hash
        or kernel_admin_sha256(kernel_canonical_json(snapshot_row.policy))
          is distinct from snapshot_row.policy_hash
      )
    )
    or (
      not expected_policy_declared
      and (snapshot_row.policy is not null or snapshot_row.policy_hash is not null)
    )
  then
    raise exception 'schema_drift: authorization policy snapshot differs from release expectation';
  end if;

  -- Reconcile already-active revisions installed before activation closed
  -- role-free admissions. Pending preparation must leave current access intact.
  if revision_row.activated_at is not null
    and coalesce(jsonb_array_length(snapshot_row.policy->'roles'), 0) > 0
  then
    update kernel_actor_access set active = false
    where app_id = revision_row.app_id and customer_id = revision_row.customer_id and active;
  end if;
end;
$kernel$;
"#;

const KERNEL_POLICY_ACTIVE_SNAPSHOT: &str = r#"
create or replace function kernel_policy_active_snapshot(app text, customer text)
returns jsonb
language plpgsql
stable
parallel safe
security invoker
set search_path from current
as $kernel$
declare
  active_row record;
  expected_row record;
  source_row record;
  snapshot_row record;
  expectation_found boolean := false;
  source_found boolean := false;
  snapshot_found boolean := false;
  active_marker_present boolean := false;
  active_policy_declared boolean := null;
begin
  select *, base_schema->>'version' as base_version
  into active_row
  from schema_revision
  where app_id = app
    and customer_id = customer
    and activated_at is not null;
  if not found then
    raise exception 'active_schema_missing: %/%', app, customer;
  end if;
  active_marker_present := to_jsonb(active_row) ? 'authorization_policy_declared';
  if active_marker_present then
    active_policy_declared := (to_jsonb(active_row)->>'authorization_policy_declared')::boolean;
  end if;

  select policy_declared, policy_hash
  into expected_row
  from schema_authorization_policy_expectation
  where app_id = app and schema_version = active_row.base_version;
  expectation_found := found;
  select policy, policy_hash
  into source_row
  from schema_authorization_policy_source
  where app_id = app and schema_version = active_row.base_version;
  source_found := found;
  select policy, policy_hash
  into snapshot_row
  from schema_authorization_policy_snapshot
  where schema_revision_id = active_row.id
    and app_id = app and customer_id = customer;
  snapshot_found := found;

  -- Pre-substrate issued revisions have none of the three policy artifacts.
  if not expectation_found and not source_found and not snapshot_found then
    if active_policy_declared then
      raise exception 'schema_drift: active declared policy marker exists without authorization policy artifacts';
    end if;
    return jsonb_build_object('declared', false, 'policy', null);
  end if;
  if not expectation_found then
    raise exception 'schema_drift: authorization policy source or snapshot exists without a release expectation';
  end if;
  if active_marker_present
    and active_policy_declared is not null
    and active_policy_declared is distinct from expected_row.policy_declared
  then
    raise exception 'schema_drift: authorization policy marker differs from release expectation';
  end if;
  if expected_row.policy_declared then
    if not source_found
      or not snapshot_found
      or expected_row.policy_hash is null
      or source_row.policy_hash is distinct from expected_row.policy_hash
      or snapshot_row.policy is null
      or snapshot_row.policy_hash is distinct from expected_row.policy_hash
      or kernel_admin_sha256(kernel_canonical_json(source_row.policy))
        is distinct from source_row.policy_hash
      or kernel_admin_sha256(kernel_canonical_json(snapshot_row.policy))
        is distinct from snapshot_row.policy_hash
    then
      raise exception 'schema_drift: active authorization policy source or snapshot is altered';
    end if;
    return jsonb_build_object('declared', true, 'policy', snapshot_row.policy);
  end if;
  if expected_row.policy_hash is not null
    or source_found
    or (
      snapshot_found
      and (snapshot_row.policy is not null or snapshot_row.policy_hash is not null)
    )
  then
    raise exception 'schema_drift: legacy authorization policy artifacts are altered';
  end if;
  return jsonb_build_object('declared', false, 'policy', null);
end;
$kernel$;
"#;

const KERNEL_POLICY_REQUEST_ACTOR: &str = r#"
create or replace function kernel_policy_request_actor(app text, customer text)
returns text language plpgsql volatile parallel unsafe security invoker set search_path from current
as $kernel$
declare actor text:=nullif(current_setting('kernel.actor_id',true),''); runtime_role text:=kernel_installer_capability_role('runtime'); requested_role text:=nullif(current_setting('kernel.actor_role',true),''); requested_fence text:=nullif(current_setting('kernel.actor_fence_generation',true),'');
begin
  if actor is null then raise exception 'authorization_denied: a trusted actor binding is required'; end if;
  if not exists(select 1 from kernel_principal_scope scope where scope.principal_name=session_user::name and scope.capability='runtime' and scope.active and scope.app_id=app and scope.customer_id=customer and (scope.actor_id is null or scope.actor_id=actor) and pg_has_role(session_user,pg_catalog.to_regrole(runtime_role),'MEMBER')) then raise exception 'authorization_denied: runtime principal scope is not authorized'; end if;
  if requested_role is null and kernel_roleless_access_authorized(app,customer,actor,requested_fence) then return actor; end if;
  if not exists(select 1 from kernel_actor_membership membership where membership.principal_name=session_user::name and membership.active and membership.app_id=app and membership.customer_id=customer and membership.actor_id=actor) then raise exception 'authorization_denied: actor membership is not authorized'; end if;
  if requested_role is not null or requested_fence is not null or exists(select 1 from kernel_principal_scope s where s.principal_name=session_user::name and s.capability='runtime' and s.app_id=app and s.customer_id=customer and s.actor_binding_required) then
    if requested_role is null or requested_fence is null or requested_fence !~ '^[1-9][0-9]*$' or not exists(select 1 from kernel_actor_membership m where m.principal_name=session_user::name and m.active and m.app_id=app and m.customer_id=customer and m.actor_id=actor and m.role=requested_role and m.fence_generation::text=requested_fence for share of m) then
      raise exception 'authorization_denied: actor binding fence is no longer current';
    end if;
  end if;
  return actor;
end;
$kernel$;
"#;

// The platform agent context marks its transaction with
// `kernel.actor_kind = 'agent'`. The mark can only make a caller an agent:
// any other value is ignored, and trusted membership still decides who is human.
const KERNEL_REQUEST_MARKED_AGENT: &str = r#"
create or replace function kernel_request_marked_agent()
returns boolean language plpgsql stable parallel unsafe security invoker set search_path from current
as $kernel$
begin
  return coalesce(nullif(current_setting('kernel.actor_kind',true),'')='agent',false);
end;
$kernel$;
"#;

// A caller is an agent when its context is marked as agent or its trusted
// membership is not human (omitted classification is agent).
const KERNEL_REQUEST_IS_AGENT: &str = r#"
create or replace function kernel_request_is_agent(app text, customer text, actor text)
returns boolean language plpgsql stable parallel unsafe security invoker set search_path from current
as $kernel$
declare admission_is_agent boolean;
begin
  if kernel_request_marked_agent() then return true; end if;
  if nullif(current_setting('kernel.actor_role',true),'') is null then
    select a.actor_kind<>'human' into admission_is_agent from kernel_actor_access a
      where a.principal_name=session_user::name and a.app_id=app and a.customer_id=customer
        and a.actor_id=actor and a.active and a.fence_generation>0
        and a.fence_generation::text=nullif(current_setting('kernel.actor_fence_generation',true),'');
    if found then return admission_is_agent; end if;
  end if;
  return coalesce((
    select not bool_and(m.actor_kind='human') from kernel_actor_membership m
    where m.principal_name=session_user::name and m.app_id=app and m.customer_id=customer
      and m.actor_id=actor and m.active
  ), true);
end;
$kernel$;
"#;

// The agent turn of a marked caller (`kernel.turn_id`), else null. Only the
// context sets it; request input never supplies a turn.
const KERNEL_REQUEST_TURN_ID: &str = r#"
create or replace function kernel_request_turn_id()
returns uuid language plpgsql stable parallel unsafe security invoker set search_path from current
as $kernel$
declare turn text:=nullif(current_setting('kernel.turn_id',true),'');
begin
  if not kernel_request_marked_agent() or turn is null then return null; end if;
  if turn !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'contract_validation_failed: agent turn id must be a lowercase UUID';
  end if;
  return turn::uuid;
end;
$kernel$;
"#;

const KERNEL_POLICY_CAPTURE_GRANTS: &str = r#"
create or replace function kernel_policy_capture_grants(policy jsonb, model_id text, operation text)
returns jsonb language sql stable parallel safe security invoker set search_path from current
as $kernel$
 select jsonb_build_object('actor_id',nullif(current_setting('kernel.actor_id',true),''),'operation',operation,
  'grants',coalesce(jsonb_agg(grant_value.value),'[]'::jsonb))
 from kernel_actor_membership membership
 join jsonb_array_elements(coalesce(policy->'grants','[]'::jsonb)) grant_value(value)
  on grant_value.value->>'role'=membership.role
 where membership.principal_name=session_user::name and membership.active
  and membership.app_id=current_setting('kernel.app_id',true)
  and membership.customer_id=current_setting('kernel.customer_id',true)
  and membership.actor_id=nullif(current_setting('kernel.actor_id',true),'')
  and grant_value.value->>'model'=model_id
  and grant_value.value->'operations' ? operation
$kernel$;
"#;

const KERNEL_POLICY_GRANTS_FIELDS_ALLOWED: &str = r#"
create or replace function kernel_policy_grants_fields_allowed(captured jsonb, required_fields jsonb)
returns boolean language plpgsql immutable parallel safe security invoker set search_path from current
as $kernel$
declare grants jsonb:=coalesce(captured->'grants','[]'::jsonb); grant_count integer:=jsonb_array_length(grants);
 operation text:=captured->>'operation'; allowed_fields jsonb:='[]'::jsonb; i integer;
 required_count integer:=jsonb_array_length(coalesce(required_fields,'[]'::jsonb));
begin
 if grant_count=0 then return false; end if;
 if operation='delete' or required_count=0 then return true; end if;
 for i in 0..grant_count-1 loop
  if operation in ('read','history') then allowed_fields:=allowed_fields||coalesce(grants->i->'read_fields','[]'::jsonb);
  elsif operation in ('create','update') then allowed_fields:=allowed_fields||coalesce(grants->i->'write_fields','[]'::jsonb); end if;
 end loop;
 return coalesce(required_fields,'[]'::jsonb)<@allowed_fields;
end $kernel$;
"#;

const KERNEL_POLICY_GRANTS_RECORD_ALLOWED: &str = r#"
create or replace function kernel_policy_grants_record_allowed(captured jsonb, required_fields jsonb, record_values jsonb)
returns boolean language plpgsql immutable parallel safe security invoker set search_path from current
as $kernel$
declare grants jsonb:=coalesce(captured->'grants','[]'::jsonb); grant_count integer:=jsonb_array_length(grants);
 matched jsonb:='[]'::jsonb; grant_value jsonb; i integer;
begin
 for i in 0..grant_count-1 loop
  grant_value:=grants->i;
  if grant_value->'record'->>'kind'='all' or (
   grant_value->'record'->>'kind'='actor_equals_field'
   and record_values->(grant_value->'record'->>'field')->>'value'=captured->>'actor_id'
  ) then matched:=matched||jsonb_build_array(grant_value); end if;
 end loop;
 return kernel_policy_grants_fields_allowed(captured||jsonb_build_object('grants',matched),required_fields);
end $kernel$;
"#;

// The same rule as kernel_policy_grants_record_allowed, specialized once per
// query into a SQL predicate over `values_sql`, so a scan does not call the
// policy function for every row: some captured grant matches the record, and
// every required field is granted by a matching grant.
const KERNEL_POLICY_GRANTS_RECORD_SQL: &str = r#"
create or replace function kernel_policy_grants_record_sql(captured jsonb, required_fields jsonb, values_sql text)
returns text language plpgsql immutable parallel safe security invoker set search_path from current
as $kernel$
declare grants jsonb:=coalesce(captured->'grants','[]'::jsonb); matches text[]:=array[]::text[]; grant_value jsonb;
 field_id text; covering text[]; result text; i integer;
begin
 for i in 0..jsonb_array_length(grants)-1 loop
  grant_value:=grants->i;
  matches:=matches||case
   when grant_value->'record'->>'kind'='all' then 'true'
   when grant_value->'record'->>'kind'='actor_equals_field' then
    format('coalesce((%s)->%L->>''value''=%L,false)',values_sql,grant_value->'record'->>'field',captured->>'actor_id')
   else 'false' end;
 end loop;
 if cardinality(matches)=0 then return 'false'; end if;
 result:='('||array_to_string(matches,' or ')||')';
 if captured->>'operation'='delete' then return result; end if;
 for field_id in select jsonb_array_elements_text(coalesce(required_fields,'[]'::jsonb)) loop
  covering:=array[]::text[];
  for i in 0..jsonb_array_length(grants)-1 loop
   if coalesce(grants->i->case when captured->>'operation' in ('read','history') then 'read_fields' else 'write_fields' end,'[]'::jsonb)?field_id
     and captured->>'operation' in ('read','history','create','update') then
    covering:=covering||matches[i+1];
   end if;
  end loop;
  if cardinality(covering)=0 then return 'false'; end if;
  result:=result||' and ('||array_to_string(covering,' or ')||')';
 end loop;
 return result;
end $kernel$;
"#;

const KERNEL_POLICY_REQUIRED_FIELDS_ALLOWED: &str = r#"
create or replace function kernel_policy_required_fields_allowed(policy jsonb, model_id text, operation text, required_fields jsonb)
returns boolean language sql stable parallel safe security invoker set search_path from current
as $kernel$
 select kernel_policy_grants_fields_allowed(kernel_policy_capture_grants(policy,model_id,operation),required_fields)
$kernel$;
"#;

const KERNEL_POLICY_RECORD_ALLOWED: &str = r#"
create or replace function kernel_policy_record_allowed(policy jsonb, model_id text, operation text, required_fields jsonb, record_values jsonb)
returns boolean language sql stable parallel safe security invoker set search_path from current
as $kernel$
 select kernel_policy_grants_record_allowed(kernel_policy_capture_grants(policy,model_id,operation),required_fields,record_values)
$kernel$;
"#;

const KERNEL_POLICY_AUTHORIZE_QUERY: &str = r#"
create or replace function kernel_policy_authorize_query(
  app text,
  customer text,
  model_id text,
  required_fields jsonb
)
returns jsonb
language plpgsql
stable
parallel safe
security invoker
set search_path from current
as $kernel$
declare
  snapshot jsonb;
begin
  if jsonb_typeof(required_fields) is distinct from 'array'
    or exists (
      select 1
      from jsonb_array_elements(required_fields) item(value)
      where jsonb_typeof(item.value) <> 'string'
    )
  then
    raise exception 'contract_validation_failed: authorization field set must be an array of strings';
  end if;
  snapshot := kernel_policy_active_snapshot(app, customer);
  if not coalesce((snapshot->>'declared')::boolean, false) then
    return null;
  end if;
  perform kernel_policy_request_actor(app, customer);
  if not kernel_policy_required_fields_allowed(
    snapshot->'policy',
    model_id,
    'read',
    required_fields
  ) then
    raise exception 'authorization_denied: no applicable authorization grant permits the requested fields';
  end if;
  return snapshot->'policy';
end;
$kernel$;
"#;

const KERNEL_POLICY_RAW_TABLE_ACCESS_ALLOWED: &str = r#"
create or replace function kernel_policy_raw_table_access_allowed(
  access_role name,
  app text,
  customer text
)
returns boolean
language plpgsql
stable
parallel safe
security invoker
set search_path from current
as $kernel$
declare
  snapshot jsonb;
begin
  if access_role::text = kernel_installer_capability_role('execution_owner') then
    return true;
  end if;
  if not exists (
    select 1
    from schema_revision revision
    where revision.app_id = $2
      and revision.customer_id = $3
      and revision.activated_at is not null
  ) then
    return false;
  end if;
  snapshot := kernel_policy_active_snapshot(app, customer);
  if not coalesce((snapshot->>'declared')::boolean, false) then
    return true;
  end if;
  return false;
end;
$kernel$;
"#;
