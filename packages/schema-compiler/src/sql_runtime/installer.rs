use super::RuntimeSqlFunction;

pub(super) fn substrate_sql() -> &'static str {
    INSTALLER_SUBSTRATE.trim()
}

pub(super) fn functions() -> Vec<RuntimeSqlFunction> {
    vec![
        function(
            "kernel_installer_error(text,text,text,text,text)",
            KERNEL_INSTALLER_ERROR,
        ),
        function(
            "kernel_installer_valid_hash(text)",
            KERNEL_INSTALLER_VALID_HASH,
        ),
        function(
            "kernel_installer_schema_drift(text,text)",
            KERNEL_INSTALLER_SCHEMA_DRIFT,
        ),
        function(
            "kernel_installer_default_model_kind(jsonb)",
            KERNEL_INSTALLER_DEFAULT_MODEL_KIND,
        ),
        function(
            "kernel_installer_unique_drift(text,text,text[])",
            KERNEL_INSTALLER_UNIQUE_DRIFT,
        ),
        function(
            "kernel_installer_primary_key_drift(text,text,text[])",
            KERNEL_INSTALLER_PRIMARY_KEY_DRIFT,
        ),
        function(
            "kernel_installer_capability_role(text)",
            KERNEL_INSTALLER_CAPABILITY_ROLE,
        ),
        function(
            "kernel_principal_scope_authorized(text,text,text,text)",
            KERNEL_PRINCIPAL_SCOPE_AUTHORIZED,
        ),
        function(
            "kernel_authorize_scope(text,text,text,text)",
            KERNEL_AUTHORIZE_SCOPE,
        ),
        function(
            "kernel_bind_principal_scope(jsonb)",
            KERNEL_BIND_PRINCIPAL_SCOPE,
        ),
        function(
            "kernel_installer_fk_drift(text,text,text[],text,text[])",
            KERNEL_INSTALLER_FK_DRIFT,
        ),
        function(
            "kernel_installer_index_drift(text,text,boolean,text[],text)",
            KERNEL_INSTALLER_INDEX_DRIFT,
        ),
        function(
            "kernel_installer_check_drift(text,text,text)",
            KERNEL_INSTALLER_CHECK_DRIFT,
        ),
        function(
            "kernel_installer_materialized_assertions_drift(jsonb)",
            KERNEL_INSTALLER_MATERIALIZED_ASSERTIONS_DRIFT,
        ),
        function(
            "kernel_reconcile_lookup_foreign_key_targets(text,text)",
            KERNEL_RECONCILE_LOOKUP_FOREIGN_KEY_TARGETS,
        ),
        function(
            "kernel_installer_lock_app(text,boolean)",
            KERNEL_INSTALLER_LOCK_APP,
        ),
        installer_lock_tenant_compatibility_function(),
        function(
            "kernel_enforce_schema_activation_head()",
            KERNEL_ENFORCE_SCHEMA_ACTIVATION_HEAD,
        ),
        function(
            "kernel_prepare_schema_revision(jsonb)",
            KERNEL_PREPARE_SCHEMA_REVISION,
        ),
        function(
            "kernel_validate_schema_revision_readiness(jsonb)",
            KERNEL_VALIDATE_SCHEMA_REVISION_READINESS,
        ),
        function(
            "kernel_schema_revision_is_active(jsonb)",
            KERNEL_SCHEMA_REVISION_IS_ACTIVE,
        ),
        function(
            "kernel_read_runtime_release_observability(jsonb)",
            KERNEL_READ_RUNTIME_RELEASE_OBSERVABILITY,
        ),
        function(
            "kernel_validate_materialized_schema_revision(jsonb)",
            KERNEL_VALIDATE_MATERIALIZED_SCHEMA_REVISION,
        ),
        function(
            "kernel_repair_materialized_schema_revision(jsonb)",
            KERNEL_REPAIR_MATERIALIZED_SCHEMA_REVISION,
        ),
        function(
            "kernel_activate_tenant_schema_revision(jsonb)",
            KERNEL_ACTIVATE_TENANT_SCHEMA_REVISION,
        ),
        function(
            "kernel_activate_app_base_schema_revision(jsonb)",
            KERNEL_ACTIVATE_APP_BASE_SCHEMA_REVISION,
        ),
        function(
            "kernel_continue_app_base_schema_revision(jsonb)",
            include_str!("app_base_continuation.sql"),
        ),
        function(
            "kernel_sync_schema_constraint_identities(bigint)",
            KERNEL_SYNC_SCHEMA_CONSTRAINT_IDENTITIES,
        ),
        function(
            "kernel_constraint_identity_drift(jsonb)",
            KERNEL_CONSTRAINT_IDENTITY_DRIFT,
        ),
        function(
            "kernel_constraint_interval_rules(text,text,bigint)",
            KERNEL_CONSTRAINT_INTERVAL_RULES,
        ),
        function(
            "kernel_constraint_interval_isolation_error(text,text,bigint,text[])",
            KERNEL_CONSTRAINT_INTERVAL_ISOLATION_ERROR,
        ),
        function(
            "kernel_constraint_interval_lock(text,text,bigint,text[])",
            KERNEL_CONSTRAINT_INTERVAL_LOCK,
        ),
        function(
            "kernel_constraint_interval_violation(text,text,bigint,jsonb)",
            KERNEL_CONSTRAINT_INTERVAL_VIOLATION,
        ),
        function(
            "kernel_install_runtime_privileges()",
            KERNEL_INSTALL_RUNTIME_PRIVILEGES,
        ),
    ]
}

pub(super) fn privilege_installation_sql() -> &'static str {
    "select kernel_install_runtime_privileges()"
}

fn function(signature: &'static str, sql: &str) -> RuntimeSqlFunction {
    RuntimeSqlFunction {
        signature,
        sql: sql.trim().to_string(),
    }
}

const KERNEL_RECONCILE_LOOKUP_FOREIGN_KEY_TARGETS: &str = r#"
create or replace function kernel_reconcile_lookup_foreign_key_targets(
  requested_app_id text,
  requested_customer_id text
)
returns void
language plpgsql
volatile
security invoker
set search_path from current
as $kernel_installer$
declare
  foreign_key record;
  columns text[];
begin
  perform set_config('kernel.app_id', requested_app_id, true);
  perform set_config('kernel.customer_id', requested_customer_id, true);

  for foreign_key in
    select constraint_value.conrelid::regclass as relation,
           array_agg(attribute.attname order by key.position) as columns
    from pg_constraint constraint_value
    join unnest(constraint_value.conkey) with ordinality key(attnum, position) on true
    join pg_attribute attribute
      on attribute.attrelid = constraint_value.conrelid
     and attribute.attnum = key.attnum
    where constraint_value.contype = 'f'
      and constraint_value.confrelid = to_regclass('lookup_record')
    group by constraint_value.oid, constraint_value.conrelid
  loop
    columns := foreign_key.columns;
    if array_length(columns, 1) = 4
      and columns[1] = 'app_id'
      and columns[2] = 'customer_id'
      and columns[3] like '%_target_model'
    then
      execute format(
        'insert into lookup_record(app_id, customer_id, model_id, id, external_key) '
        || 'select $1, $2, source.%I, source.%I, null '
        || 'from %s source '
        || 'left join lookup_record target '
        || 'on target.app_id = $1 and target.customer_id = $2 '
        || 'and target.model_id = source.%I and target.id = source.%I '
        || 'where source.app_id = $1 and source.customer_id = $2 '
        || 'and source.%I is not null and target.id is null '
        || 'on conflict on constraint lookup_record_pkey do nothing',
        columns[3], columns[4], foreign_key.relation,
        columns[3], columns[4], columns[4]
      ) using requested_app_id, requested_customer_id;
    end if;
  end loop;
end;
$kernel_installer$;
"#;

fn installer_lock_tenant_compatibility_function() -> RuntimeSqlFunction {
    RuntimeSqlFunction {
        signature: "kernel_installer_lock_tenant(text,text)",
        sql: [
            KERNEL_INSTALLER_LOCK_TENANT,
            KERNEL_INSTALLER_ERROR,
            KERNEL_INSTALLER_VALID_HASH,
            KERNEL_INSTALLER_SCHEMA_DRIFT,
            KERNEL_INSTALLER_UNIQUE_DRIFT,
            KERNEL_INSTALLER_FK_DRIFT,
            KERNEL_INSTALLER_INDEX_DRIFT,
            KERNEL_INSTALLER_CHECK_DRIFT,
            KERNEL_INSTALLER_MATERIALIZED_ASSERTIONS_DRIFT,
            KERNEL_VALIDATE_MATERIALIZED_SCHEMA_REVISION,
            KERNEL_SCHEMA_REVISION_IS_ACTIVE_WITH_MATERIALIZED_TABLES,
            KERNEL_LOOKUP_AWARE_ADMIN_MATERIALIZATION_ERROR,
        ]
        .iter()
        .map(|sql| sql.trim())
        .collect::<Vec<_>>()
        .join("\n\n"),
    }
}

const INSTALLER_SUBSTRATE: &str = r#"
-- Historical pre-rework shapes are unsupported. Refuse before changing any
-- application data or replacing old function signatures; never reset tables.
do $legacy_schema_guard$
begin
  if (exists (
    select 1 from pg_attribute
    where attrelid = to_regclass(format('%I.work_session', current_schema()))
      and attname = 'forks' and not attisdropped
  ) and not exists (
    select 1 from pg_attribute
    where attrelid = to_regclass(format('%I.work_session_record', current_schema()))
      and attname = 'field_id' and not attisdropped
  )) or to_regclass(format('%I.app_setting', current_schema())) is not null then
    raise exception 'legacy_schema_upgrade_unsupported: existing data was preserved';
  end if;
end
$legacy_schema_guard$;
create table if not exists work_session (
 app_id text not null, customer_id text not null, id uuid not null, owner_id text not null,
 title text not null, as_of date not null, scope jsonb not null default '{}', layout jsonb not null default '{}',
 pinned boolean not null default false, status text not null default 'active' check(status in ('active','archived')),
 revision bigint not null default 1 check(revision>0), rules jsonb not null default '{}', threads jsonb not null default '{}',
 receipts jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 primary key(app_id,customer_id,id), check(octet_length(threads::text)<=8388608)
);
-- One staged entry per (session, model, record, field), with its provenance.
create table if not exists work_session_record (
 app_id text not null, customer_id text not null, session_id uuid not null,
 model_id text not null, record_id uuid not null, field_id text not null,
 value jsonb not null, baseline jsonb not null, base_version uuid not null,
 source text not null check(source in ('user','agent')), actor_id text not null,
 author_principal text not null, author_kind text not null check(author_kind in ('human','agent')),
 rule_id text, thread_id text, turn_id uuid, created_at timestamptz not null, updated_at timestamptz not null,
 primary key(app_id,customer_id,session_id,model_id,record_id,field_id),
 check(octet_length(value::text)+octet_length(baseline::text)<=1048576),
 foreign key(app_id,customer_id,session_id) references work_session(app_id,customer_id,id) on delete cascade
);
-- The agent turn that staged an entry (null for human edits); added in place
-- for sessions installed before turns.
alter table work_session_record add column if not exists turn_id uuid;
-- The staged value an agent overwrote ({value, author_kind, actor_id}), kept
-- for "agent replaced your edit" and Restore; and an agent's rule note.
alter table work_session_record add column if not exists replaced jsonb;
alter table work_session_record add column if not exists note text;
do $work_record_checks$
begin
  -- The overwritten value counts in the entry's 1 MiB bound.
  if not exists (select 1 from pg_constraint where conname = 'work_session_record_replaced_size'
      and conrelid = to_regclass(format('%I.work_session_record', current_schema()))) then
    alter table work_session_record add constraint work_session_record_replaced_size
      check(octet_length(value::text)+octet_length(baseline::text)+coalesce(octet_length(replaced::text),0)<=1048576);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'work_session_record_note_length'
      and conrelid = to_regclass(format('%I.work_session_record', current_schema()))) then
    alter table work_session_record add constraint work_session_record_note_length
      check(note is null or char_length(note)<=200);
  end if;
end
$work_record_checks$;
-- Rule re-evaluation and removal touch one rule's outputs.
create index if not exists work_session_record_rule on work_session_record(app_id,customer_id,session_id,rule_id) where rule_id is not null;
-- The selection of the session owner in the canvas (presence): no revision, no
-- receipt; at most 200 targets, owner-private like the session.
create table if not exists work_session_presence (
 app_id text not null, customer_id text not null, session_id uuid not null, actor_id text not null,
 selection jsonb not null default '[]' check(jsonb_typeof(selection)='array' and jsonb_array_length(selection)<=200),
 updated_at timestamptz not null default now(),
 primary key(app_id,customer_id,session_id,actor_id),
 foreign key(app_id,customer_id,session_id) references work_session(app_id,customer_id,id) on delete cascade
);
create table if not exists schema_constraint_identity_source (
  app_id text not null,
  schema_version text not null,
  catalog jsonb not null,
  primary key (app_id, schema_version),
  check (jsonb_typeof(catalog) = 'array')
);
create table if not exists schema_constraint_identity (
  schema_revision_id bigint primary key,
  app_id text not null,
  customer_id text not null,
  catalog jsonb not null,
  check (jsonb_typeof(catalog) = 'array')
);
create table if not exists schema_authorization_policy_source (
  app_id text not null,
  schema_version text not null,
  policy jsonb not null,
  policy_hash text not null,
  primary key (app_id, schema_version),
  check (jsonb_typeof(policy) = 'object'),
  check (policy_hash ~ '^[0-9a-f]{64}$')
);
create table if not exists schema_authorization_policy_expectation (
  app_id text not null,
  schema_version text not null,
  policy_declared boolean not null,
  policy_hash text,
  primary key (app_id, schema_version),
  check ((policy_declared and policy_hash ~ '^[0-9a-f]{64}$') or (not policy_declared and policy_hash is null))
);
create table if not exists schema_authorization_policy_snapshot (
  schema_revision_id bigint primary key,
  app_id text not null,
  customer_id text not null,
  policy jsonb,
  policy_hash text,
  unique (schema_revision_id, app_id, customer_id),
  check ((policy is null and policy_hash is null) or (jsonb_typeof(policy) = 'object' and policy_hash ~ '^[0-9a-f]{64}$'))
);
create table if not exists kernel_actor_membership (
  principal_name name not null,
  app_id text not null,
  customer_id text not null,
  actor_id text not null,
  role text not null,
  actor_kind text not null default 'agent' check(actor_kind in ('human','agent','service')),
  active boolean not null default true,
  fence_generation bigint not null default 0,
  bound_at timestamptz not null default now(),
  primary key (principal_name, app_id, customer_id, actor_id, role),
  check (btrim(app_id) <> '' and btrim(customer_id) <> '' and btrim(actor_id) <> '' and btrim(role) <> ''),
  constraint kernel_actor_membership_fence_generation_nonnegative check (fence_generation >= 0)
);
alter table kernel_actor_membership add column if not exists actor_kind text not null default 'agent' check(actor_kind in ('human','agent','service'));
alter table kernel_actor_membership
  add column if not exists fence_generation bigint not null default 0;
-- Reconcile the pre-generalization service kind without losing memberships or fences.
alter table kernel_actor_membership drop constraint if exists kernel_actor_membership_actor_kind_check;
update kernel_actor_membership set actor_kind='service' where actor_kind='integration_service';
alter table kernel_actor_membership add constraint kernel_actor_membership_actor_kind_check
  check (actor_kind in ('human','agent','service'));
do $fence_generation_constraint$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'kernel_actor_membership_fence_generation_nonnegative'
      and conrelid = 'kernel_actor_membership'::regclass
  ) then
    alter table kernel_actor_membership
      add constraint kernel_actor_membership_fence_generation_nonnegative
      check (fence_generation >= 0);
  end if;
end;
$fence_generation_constraint$;
create or replace function kernel_guard_actor_membership_fence()
returns trigger
language plpgsql
volatile
parallel unsafe
security invoker
set search_path from current
as $kernel$
begin
  if tg_op = 'UPDATE' then
    if new.fence_generation < old.fence_generation then
      raise exception using
        errcode = '42501',
        message = 'actor membership fence generation cannot decrease';
    end if;
    if old.fence_generation > 0
      and new.fence_generation = old.fence_generation
      and (new.active is distinct from old.active or new.actor_kind is distinct from old.actor_kind)
      -- Schema activation may close role-free admission without allocating a
      -- newer access-operation fence. The tombstone can never reopen at that
      -- generation; ordinary bind operations still reject conflicting intent.
      and not (
        tg_table_name = 'kernel_actor_access' and old.active and not new.active
        and new.actor_kind = old.actor_kind
        and new.principal_name = old.principal_name and new.app_id = old.app_id
        and new.customer_id = old.customer_id and new.actor_id = old.actor_id
      )
    then
      raise exception using
        errcode = '42501',
        message = 'changing fenced actor membership requires a higher generation';
    end if;
  end if;
  return new;
end;
$kernel$;
do $kernel_actor_membership_fence_trigger$
begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'kernel_actor_membership'::regclass
      and tgname = 'kernel_actor_membership_fence_guard'
      and not tgisinternal
  ) then
    create trigger kernel_actor_membership_fence_guard
      before insert or update on kernel_actor_membership
      for each row execute function kernel_guard_actor_membership_fence();
  end if;
end;
$kernel_actor_membership_fence_trigger$;
create table if not exists kernel_actor_access (
  principal_name name not null, app_id text not null, customer_id text not null, actor_id text not null,
  active boolean not null, actor_kind text not null check(actor_kind in ('human','agent')),
  fence_generation bigint not null check(fence_generation>0 and fence_generation<=9007199254740991),
  bound_at timestamptz not null default now(),
  primary key(principal_name,app_id,customer_id,actor_id),
  check(btrim(app_id)<>'' and btrim(customer_id)<>'' and btrim(actor_id)<>'')
);
do $kernel_actor_access_fence_trigger$
begin
  if not exists(select 1 from pg_trigger where tgrelid='kernel_actor_access'::regclass
    and tgname='kernel_actor_access_fence_guard' and not tgisinternal) then
    create trigger kernel_actor_access_fence_guard before insert or update on kernel_actor_access
      for each row execute function kernel_guard_actor_membership_fence();
  end if;
end;
$kernel_actor_access_fence_trigger$;
create table if not exists schema_installation_revision (
  schema_revision_id bigint primary key,
  app_id text not null,
  customer_id text not null,
  release_id text not null,
  activation_kind text not null,
  base_artifact_hash text not null,
  effective_artifact_hash text not null,
  materialization_plan_hash text not null,
  expected_active_effective_hash text,
  materialization_source text,
  materialization_git_sha text,
  materialization_vercel_deployment_id text,
  materialization_vercel_environment text,
  materialization_vercel_git_ref text,
  seed_change_sets jsonb not null default '[]',
  phase_plan jsonb not null,
  phase_results jsonb,
  prepared_at timestamptz not null default now(),
  ready_at timestamptz,
  activated_at timestamptz,
  constraint schema_installation_revision_scope_revision_key
    unique (schema_revision_id, app_id, customer_id),
  constraint schema_installation_revision_scope_effective_key
    unique (app_id, customer_id, effective_artifact_hash),
  constraint schema_installation_revision_activation_kind_check
    check (activation_kind in ('app_base', 'tenant_overlay')),
  constraint schema_installation_revision_base_hash_check
    check (base_artifact_hash ~ '^[0-9a-f]{64}$'),
  constraint schema_installation_revision_effective_hash_check
    check (effective_artifact_hash ~ '^[0-9a-f]{64}$'),
  constraint schema_installation_revision_plan_hash_check
    check (materialization_plan_hash ~ '^[0-9a-f]{64}$'),
  constraint schema_installation_revision_expected_hash_check
    check (
      expected_active_effective_hash is null
      or expected_active_effective_hash ~ '^[0-9a-f]{64}$'
    ),
  constraint schema_installation_revision_phase_plan_check
    check (jsonb_typeof(phase_plan) = 'array'),
  constraint schema_installation_revision_seed_change_sets_check
    check (jsonb_typeof(seed_change_sets) = 'array'),
  constraint schema_installation_revision_readiness_check
    check (
      (ready_at is null and phase_results is null)
      or (ready_at is not null and jsonb_typeof(phase_results) = 'array')
    )
);

create index if not exists schema_installation_revision_release_idx
  on schema_installation_revision (app_id, release_id, customer_id);

create table if not exists kernel_principal_scope (
  principal_name name not null,
  capability text not null,
  app_id text not null,
  customer_id text not null,
  actor_id text,
  active boolean not null default true,
  bound_at timestamptz not null default now(),
  constraint kernel_principal_scope_pkey
    primary key (principal_name, capability, app_id, customer_id),
  constraint kernel_principal_scope_capability_check
    check (capability in ('runtime', 'schema_admin')),
  constraint kernel_principal_scope_scope_check
    check (btrim(app_id) <> '' and btrim(customer_id) <> ''),
  constraint kernel_principal_scope_actor_check
    check (actor_id is null or btrim(actor_id) <> '')
);

alter table kernel_principal_scope
  add column if not exists actor_binding_required boolean not null default false;

create table if not exists kernel_http_request_admission (
  principal_name name not null, app_id text not null, customer_id text not null,
  jti text not null, identity jsonb not null, expires_at bigint,
  primary key (principal_name,app_id,customer_id,jti)
);
alter table kernel_http_request_admission add column if not exists expires_at bigint;
create index if not exists kernel_http_request_admission_expiry_scope_idx
  on kernel_http_request_admission(principal_name,app_id,customer_id,expires_at)
  where expires_at is not null;
create table if not exists kernel_http_operation_admission (
  principal_name name not null, app_id text not null, customer_id text not null,
  jti text not null, sequence bigint not null check(sequence>0),
  operation text not null, fingerprint text not null,
  primary key(principal_name,app_id,customer_id,jti,sequence),
  foreign key(principal_name,app_id,customer_id,jti) references kernel_http_request_admission
);
create table if not exists kernel_http_request_consumption (
  principal_name name not null, app_id text not null, customer_id text not null,
  jti text not null, owner_xid xid8 not null, executing boolean not null default false, executing_xid xid8,
  operation_count bigint,
  primary key(principal_name,app_id,customer_id,jti),
  foreign key(principal_name,app_id,customer_id,jti) references kernel_http_request_admission
);
alter table kernel_http_request_consumption add column if not exists executing_xid xid8;
create table if not exists kernel_http_operation_receipt (
  principal_name name not null, app_id text not null, customer_id text not null,
  jti text not null, sequence bigint not null,
  change_set_id bigint,
  primary key(principal_name,app_id,customer_id,jti,sequence),
  foreign key(principal_name,app_id,customer_id,jti,sequence) references kernel_http_operation_admission
);

alter table schema_installation_revision
  add column if not exists seed_change_sets jsonb not null default '[]';

do $kernel_install$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = to_regclass('schema_installation_revision')
      and conname = 'schema_installation_revision_seed_change_sets_check'
  ) then
    alter table schema_installation_revision
      add constraint schema_installation_revision_seed_change_sets_check
      check (jsonb_typeof(seed_change_sets) = 'array') not valid;
  end if;
  alter table schema_installation_revision
    validate constraint schema_installation_revision_seed_change_sets_check;
end
$kernel_install$;
"#;

const KERNEL_INSTALLER_ERROR: &str = r#"
create or replace function kernel_installer_error(
  error_code text,
  error_message text,
  error_path text,
  detail_code text,
  detail_message text
)
returns jsonb
language sql
immutable
parallel safe
security invoker
set search_path from current
as $kernel$
  select jsonb_build_object(
    'ok', false,
    'error', jsonb_build_object(
      'code', error_code,
      'message', error_message,
      'details', jsonb_build_array(jsonb_build_object(
        'path', error_path,
        'code', detail_code,
        'message', detail_message
      ))
    )
  )
$kernel$;
"#;

const KERNEL_INSTALLER_VALID_HASH: &str = r#"
create or replace function kernel_installer_valid_hash(value text)
returns boolean
language sql
immutable
parallel safe
security invoker
set search_path from current
as $kernel$
  select value is not null and value ~ '^[0-9a-f]{64}$'
$kernel$;
"#;

const KERNEL_INSTALLER_SCHEMA_DRIFT: &str = r#"
create or replace function kernel_installer_schema_drift(object_name text, drift_details text)
returns jsonb
language sql
immutable
parallel safe
security invoker
set search_path from current
as $kernel$
  select kernel_installer_error(
    'schema_drift',
    'Schema drift detected',
    'object',
    'schema_drift',
    object_name || ': ' || drift_details
  )
$kernel$;
"#;

const KERNEL_INSTALLER_DEFAULT_MODEL_KIND: &str = r#"
create or replace function kernel_installer_default_model_kind(schema_value jsonb)
returns jsonb
language sql
immutable
parallel safe
security invoker
set search_path from current
as $kernel$
  select case
    when jsonb_typeof(schema_value) <> 'object'
      or jsonb_typeof(schema_value->'models') <> 'array'
    then schema_value
    else jsonb_set(
      schema_value,
      '{models}',
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'kind', 'entity',
            'display_field_id', null,
            'origin', 'app',
            'management', 'fixed',
            'lifecycle', 'active',
            'extensions', jsonb_build_object(
              'typed_custom_fields', false,
              'record_metadata', null
            ),
            'many_relations', '[]'::jsonb
          )
          || model_value
          || jsonb_build_object(
            'fields', coalesce((
              select jsonb_agg(
                jsonb_build_object(
                  'is_unique', false,
                  'target_model', null,
                  'option_set', '[]'::jsonb,
                  'origin', 'app',
                  'management', 'fixed',
                  'lifecycle', 'active'
                )
                || field_value
                || jsonb_build_object(
                  'option_set', coalesce((
                    select jsonb_agg(
                      jsonb_build_object(
                        'aliases', '[]'::jsonb,
                        'origin', 'app',
                        'management', 'fixed',
                        'lifecycle', 'active'
                      ) || option_value
                      order by option_ordinality
                    )
                    from jsonb_array_elements(coalesce(field_value->'option_set', '[]'::jsonb))
                      with ordinality as options(option_value, option_ordinality)
                  ), '[]'::jsonb)
                )
                order by field_ordinality
              )
              from jsonb_array_elements(coalesce(model_value->'fields', '[]'::jsonb))
                with ordinality as fields(field_value, field_ordinality)
            ), '[]'::jsonb),
            'many_relations', coalesce((
              select jsonb_agg(
                jsonb_build_object(
                  'origin', 'app',
                  'management', 'fixed',
                  'lifecycle', 'active'
                ) || relation_value
                order by relation_ordinality
              )
              from jsonb_array_elements(coalesce(model_value->'many_relations', '[]'::jsonb))
                with ordinality as relations(relation_value, relation_ordinality)
            ), '[]'::jsonb)
          )
          order by model_ordinality
        )
        from jsonb_array_elements(schema_value->'models')
          with ordinality as models(model_value, model_ordinality)
      ), '[]'::jsonb),
      false
    )
  end
$kernel$;
"#;

const KERNEL_INSTALLER_UNIQUE_DRIFT: &str = r#"
create or replace function kernel_installer_unique_drift(
  table_name text,
  constraint_name text,
  expected_columns text[]
)
returns jsonb
language plpgsql
stable
parallel safe
security invoker
set search_path from current
as $kernel$
declare
  actual_columns text[];
  actual_type text;
  actual_deferrable boolean;
  actual_initially_deferred boolean;
  actual_validated boolean;
begin
  select constraint_value.contype::text,
         constraint_value.condeferrable,
         constraint_value.condeferred,
         constraint_value.convalidated,
         array(
           select attribute.attname
           from unnest(constraint_value.conkey) with ordinality as key_column(attnum, ordinality)
           join pg_attribute as attribute
             on attribute.attrelid = constraint_value.conrelid
            and attribute.attnum = key_column.attnum
           order by key_column.ordinality
         )
  into actual_type, actual_deferrable, actual_initially_deferred,
       actual_validated, actual_columns
  from pg_constraint as constraint_value
  where constraint_value.conrelid = to_regclass(format('%I.%I', current_schema(), table_name))
    and constraint_value.conname = constraint_name;
  if not found
    or actual_type <> 'u'
    or actual_columns is distinct from expected_columns
    or actual_deferrable
    or actual_initially_deferred
    or not actual_validated
  then
    return kernel_installer_schema_drift(
      table_name || '.' || constraint_name,
      'unique constraint contract differs from the compiled catalog'
    );
  end if;
  return null;
end;
$kernel$;
"#;

const KERNEL_INSTALLER_PRIMARY_KEY_DRIFT: &str = r#"
create or replace function kernel_installer_primary_key_drift(
  table_name text,
  constraint_name text,
  expected_columns text[]
)
returns jsonb
language plpgsql
stable
parallel safe
security invoker
set search_path from current
as $kernel$
declare
  actual_columns text[];
  actual_type text;
  actual_deferrable boolean;
  actual_initially_deferred boolean;
  actual_validated boolean;
begin
  select constraint_value.contype::text,
         constraint_value.condeferrable,
         constraint_value.condeferred,
         constraint_value.convalidated,
         array(
           select attribute.attname
           from unnest(constraint_value.conkey) with ordinality as key_column(attnum, ordinality)
           join pg_attribute as attribute
             on attribute.attrelid = constraint_value.conrelid
            and attribute.attnum = key_column.attnum
           order by key_column.ordinality
         )
  into actual_type, actual_deferrable, actual_initially_deferred,
       actual_validated, actual_columns
  from pg_constraint as constraint_value
  where constraint_value.conrelid = to_regclass(format('%I.%I', current_schema(), table_name))
    and constraint_value.conname = constraint_name;
  if not found
    or actual_type <> 'p'
    or actual_columns is distinct from expected_columns
    or actual_deferrable
    or actual_initially_deferred
    or not actual_validated
  then
    return kernel_installer_schema_drift(
      table_name || '.' || constraint_name,
      'primary key contract differs from the compiled catalog'
    );
  end if;
  return null;
end;
$kernel$;
"#;

const KERNEL_INSTALLER_CAPABILITY_ROLE: &str = r#"
create or replace function kernel_installer_capability_role(capability text)
returns text
language plpgsql
stable
parallel safe
security invoker
set search_path from current
as $kernel$
declare
  raw_identifier text;
  normalized text;
begin
  raw_identifier := case capability
    when 'execution_owner' then current_database() || '__' || current_schema() || '__kernel_execution_owner'
    when 'runtime' then current_database() || '__' || current_schema() || '__kernel_runtime'
    when 'schema_admin' then current_database() || '__' || current_schema() || '__kernel_schema_admin'
    when 'query' then current_database() || '__' || current_schema() || '__kernel_query'
    else null
  end;
  if raw_identifier is null then
    return null;
  end if;
  normalized := trim(both '_' from regexp_replace(
    regexp_replace(lower(btrim(raw_identifier)), '[_\-[:space:]]+', '_', 'g'),
    '[^a-z0-9_]', '', 'g'
  ));
  if octet_length(normalized) <= 63 then
    return normalized;
  end if;
  return left(normalized, 46) || '_' || left(pg_catalog.md5(normalized), 16);
end;
$kernel$;
"#;

const KERNEL_PRINCIPAL_SCOPE_AUTHORIZED: &str = r#"
create or replace function kernel_principal_scope_authorized(
  requested_capability text,
  requested_app_id text,
  requested_customer_id text,
  requested_actor_id text default null
)
returns boolean
language plpgsql
volatile
parallel unsafe
security invoker
set search_path from current
as $kernel$
declare
  execution_role text := kernel_installer_capability_role('execution_owner');
begin
  if requested_capability not in ('runtime', 'schema_admin', 'any')
    or coalesce(btrim(requested_app_id), '') = ''
    or coalesce(btrim(requested_customer_id), '') = ''
  then
    return false;
  end if;

  -- The installer/verifier owns the generated artifacts and may operate before
  -- application principals have been bound. Request-time callers never receive
  -- membership in the execution-owner role.
  if session_user = execution_role
    or coalesce(
      pg_has_role(session_user, pg_catalog.to_regrole(execution_role), 'SET'),
      false
    )
  then
    return true;
  end if;

  return exists (
    select 1
    from kernel_principal_scope binding
    where binding.principal_name = session_user::name
      and binding.active
      and binding.app_id = requested_app_id
      and binding.customer_id = requested_customer_id
      and (
        requested_capability = 'any'
        or binding.capability = requested_capability
      )
      and (
        requested_actor_id is null
        or binding.actor_id = requested_actor_id
      )
      and (
        binding.capability <> 'runtime'
        or binding.actor_id is null
        or binding.actor_id = nullif(current_setting('kernel.actor_id',true),'')
      )
      and pg_has_role(
        session_user,
        pg_catalog.to_regrole(kernel_installer_capability_role(binding.capability)),
        'MEMBER'
      )
      and (
        binding.capability <> 'runtime'
        or not binding.actor_binding_required
        or (nullif(current_setting('kernel.actor_role',true),'') is null
          and kernel_roleless_access_authorized(requested_app_id,requested_customer_id,
            coalesce(requested_actor_id,nullif(current_setting('kernel.actor_id',true),'')),
            nullif(current_setting('kernel.actor_fence_generation',true),'')))
        or exists (
          select 1 from kernel_actor_membership membership
          where membership.principal_name = session_user::name
            and membership.app_id = requested_app_id
            and membership.customer_id = requested_customer_id
            and membership.actor_id = coalesce(requested_actor_id, nullif(current_setting('kernel.actor_id',true),''))
            and membership.role = nullif(current_setting('kernel.actor_role',true),'')
            and membership.active
            and membership.fence_generation > 0
            and membership.fence_generation::text = nullif(current_setting('kernel.actor_fence_generation',true),'')
          for share of membership
        )
      )
  );
end;
$kernel$;
"#;

const KERNEL_AUTHORIZE_SCOPE: &str = r#"
create or replace function kernel_authorize_scope(
  requested_capability text,
  requested_app_id text,
  requested_customer_id text,
  requested_actor_id text default null
)
returns jsonb
language sql
volatile
parallel unsafe
security invoker
set search_path from current
as $kernel$
  select case
    when kernel_principal_scope_authorized(
      requested_capability,
      requested_app_id,
      requested_customer_id,
      requested_actor_id
    ) then null
    else jsonb_build_object(
      'ok', false,
      'error', jsonb_build_object(
        'code', 'authorization_denied',
        'message', 'Tenant scope is not authorized',
        'details', jsonb_build_array(jsonb_build_object(
          'path', 'scope',
          'code', 'tenant_scope_not_bound',
          'message', 'the authenticated database principal is not bound to the requested tenant and capability'
        ))
      )
    )
  end
$kernel$;
"#;

const KERNEL_BIND_PRINCIPAL_SCOPE: &str = r#"
create or replace function kernel_bind_principal_scope(request jsonb)
returns jsonb
language plpgsql
volatile
parallel unsafe
security invoker
set search_path from current
as $kernel$
declare
  principal_name text := request->>'principal_name';
  capability text := request->>'capability';
  app_id text := request->>'app_id';
  customer_id text := request->>'customer_id';
  actor_id text := nullif(request->>'actor_id', '');
  active boolean;
  execution_role text := kernel_installer_capability_role('execution_owner');
  capability_role text;
begin
  if session_user <> execution_role
    and not pg_has_role(session_user, execution_role, 'SET')
  then
    return kernel_authorize_scope('schema_admin', app_id, customer_id, actor_id);
  end if;
  if request is null
    or jsonb_typeof(request) <> 'object'
    or request - array[
      'principal_name', 'capability', 'app_id', 'customer_id', 'actor_id', 'active', 'actor_binding_required'
    ]::text[] <> '{}'::jsonb
    or coalesce(btrim(principal_name), '') = ''
    or capability not in ('runtime', 'schema_admin')
    or coalesce(btrim(app_id), '') = ''
    or coalesce(btrim(customer_id), '') = ''
    or (request ? 'active' and jsonb_typeof(request->'active') <> 'boolean')
    or (request ? 'actor_binding_required' and jsonb_typeof(request->'actor_binding_required') <> 'boolean')
    or (capability = 'schema_admin' and actor_id is null)
  then
    return kernel_installer_error(
      'contract_validation_failed',
      'Contract validation failed',
      'request',
      'invalid_principal_scope',
      'principal_name, capability, app_id, customer_id, and a schema-admin actor_id are required'
    );
  end if;
  if to_regrole(principal_name) is null then
    return kernel_installer_error(
      'contract_validation_failed', 'Contract validation failed',
      'principal_name', 'unknown_principal', 'database principal does not exist'
    );
  end if;
  capability_role := kernel_installer_capability_role(capability);
  if not pg_has_role(principal_name, capability_role, 'MEMBER') then
    return kernel_installer_error(
      'authorization_denied', 'Principal lacks capability role',
      'capability', 'capability_role_missing',
      'bind the generated capability role before binding tenant scope'
    );
  end if;
  active := case when request ? 'active' then (request->>'active')::boolean else true end;
  insert into kernel_principal_scope(
    principal_name, capability, app_id, customer_id, actor_id, active, bound_at, actor_binding_required
  ) values (
    principal_name::name, capability, app_id, customer_id, actor_id, active, now(), coalesce((request->>'actor_binding_required')::boolean,false)
  )
  on conflict on constraint kernel_principal_scope_pkey do update
  set actor_id = excluded.actor_id,
      actor_binding_required = kernel_principal_scope.actor_binding_required or excluded.actor_binding_required,
      active = excluded.active,
      bound_at = now();
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'principal_name', principal_name,
    'capability', capability,
    'app_id', app_id,
    'customer_id', customer_id,
    'actor_id', actor_id,
    'active', active
  ));
end;
$kernel$;
"#;

const KERNEL_INSTALLER_FK_DRIFT: &str = r#"
create or replace function kernel_installer_fk_drift(
  table_name text,
  constraint_name text,
  expected_columns text[],
  expected_referenced_table text,
  expected_referenced_columns text[]
)
returns jsonb
language plpgsql
stable
parallel safe
security invoker
set search_path from current
as $kernel$
declare
  actual_columns text[];
  actual_referenced_schema text;
  actual_referenced_table text;
  actual_referenced_columns text[];
  actual_type text;
  actual_update_action text;
  actual_delete_action text;
  actual_match_type text;
  actual_deferrable boolean;
  actual_initially_deferred boolean;
  actual_validated boolean;
begin
  select constraint_value.contype::text,
         referenced_namespace.nspname,
         referenced_relation.relname,
         constraint_value.confupdtype::text,
         constraint_value.confdeltype::text,
         constraint_value.confmatchtype::text,
         constraint_value.condeferrable,
         constraint_value.condeferred,
         constraint_value.convalidated,
         array(
           select attribute.attname
           from unnest(constraint_value.conkey) with ordinality as key_column(attnum, ordinality)
           join pg_attribute as attribute
             on attribute.attrelid = constraint_value.conrelid
            and attribute.attnum = key_column.attnum
           order by key_column.ordinality
         ),
         array(
           select attribute.attname
           from unnest(constraint_value.confkey) with ordinality as key_column(attnum, ordinality)
           join pg_attribute as attribute
             on attribute.attrelid = constraint_value.confrelid
            and attribute.attnum = key_column.attnum
           order by key_column.ordinality
         )
  into actual_type, actual_referenced_schema, actual_referenced_table,
       actual_update_action, actual_delete_action, actual_match_type,
       actual_deferrable, actual_initially_deferred, actual_validated,
       actual_columns, actual_referenced_columns
  from pg_constraint as constraint_value
  join pg_class as referenced_relation on referenced_relation.oid = constraint_value.confrelid
  join pg_namespace as referenced_namespace on referenced_namespace.oid = referenced_relation.relnamespace
  where constraint_value.conrelid = to_regclass(format('%I.%I', current_schema(), table_name))
    and constraint_value.conname = constraint_name;
  if not found
    or actual_type <> 'f'
    or actual_columns is distinct from expected_columns
    or actual_referenced_schema is distinct from current_schema()
    or actual_referenced_table is distinct from expected_referenced_table
    or actual_referenced_columns is distinct from expected_referenced_columns
    or actual_update_action <> 'a'
    or actual_delete_action <> 'a'
    or actual_match_type <> 's'
    or actual_deferrable
    or actual_initially_deferred
    or not actual_validated
  then
    return kernel_installer_schema_drift(
      table_name || '.' || constraint_name,
      'foreign key contract differs from the compiled catalog'
    );
  end if;
  return null;
end;
$kernel$;
"#;

const KERNEL_INSTALLER_INDEX_DRIFT: &str = r#"
create or replace function kernel_installer_index_drift(
  table_name text,
  index_name text,
  expected_unique boolean,
  expected_columns text[],
  expected_predicate text
)
returns jsonb
language plpgsql
stable
parallel safe
security invoker
set search_path from current
as $kernel$
declare
  actual_unique boolean;
  actual_valid boolean;
  actual_ready boolean;
  actual_columns text[];
  actual_predicate text;
  normalized_expected text;
  normalized_actual text;
begin
  select index_value.indisunique,
         index_value.indisvalid,
         index_value.indisready,
         array(
           select coalesce(attribute.attname::text, pg_get_indexdef(index_value.indexrelid, key_column.ordinality::integer, true))
           from unnest(index_value.indkey::smallint[]) with ordinality as key_column(attnum, ordinality)
           left join pg_attribute as attribute
             on attribute.attrelid = index_value.indrelid
            and attribute.attnum = key_column.attnum
           where key_column.ordinality <= index_value.indnkeyatts
           order by key_column.ordinality
         ),
         pg_get_expr(index_value.indpred, index_value.indrelid, true)
  into actual_unique, actual_valid, actual_ready, actual_columns, actual_predicate
  from pg_index as index_value
  join pg_class as index_relation on index_relation.oid = index_value.indexrelid
  join pg_class as table_relation on table_relation.oid = index_value.indrelid
  join pg_namespace as namespace on namespace.oid = table_relation.relnamespace
  where namespace.nspname = current_schema()
    and table_relation.relname = table_name
    and index_relation.relname = index_name;

  normalized_expected := regexp_replace(
    lower(coalesce(expected_predicate, '')),
    '[[:space:]()"]',
    '',
    'g'
  );
  normalized_actual := regexp_replace(
    lower(coalesce(actual_predicate, '')),
    '[[:space:]()"]',
    '',
    'g'
  );
  if not found then
    return kernel_installer_schema_drift(
      table_name || '.' || index_name,
      'required materialized index is missing'
    );
  end if;
  if actual_unique is distinct from expected_unique
    or not actual_valid
    or not actual_ready
    or actual_columns is distinct from expected_columns
    or normalized_actual <> normalized_expected
  then
    return kernel_installer_schema_drift(
      table_name || '.' || index_name,
      'materialized index definition or readiness differs from the compiled catalog'
    );
  end if;
  return null;
end;
$kernel$;
"#;

const KERNEL_INSTALLER_CHECK_DRIFT: &str = r#"
create or replace function kernel_installer_check_drift(
  table_name text,
  constraint_name text,
  expected_expression text
)
returns jsonb
language plpgsql
stable
parallel safe
security invoker
set search_path from current
as $kernel$
declare
  actual_type "char";
  actual_valid boolean;
  actual_expression text;
  normalized_expected text;
  normalized_actual text;
begin
  select constraint_value.contype,
         constraint_value.convalidated,
         pg_get_expr(constraint_value.conbin, constraint_value.conrelid, true)
  into actual_type, actual_valid, actual_expression
  from pg_constraint as constraint_value
  join pg_class as relation on relation.oid = constraint_value.conrelid
  join pg_namespace as namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = current_schema()
    and relation.relname = table_name
    and constraint_value.conname = constraint_name;

  if not found then
    return kernel_installer_schema_drift(
      table_name || '.' || constraint_name,
      'required materialized constraint is missing'
    );
  end if;
  normalized_expected := regexp_replace(
    lower(coalesce(expected_expression, '')),
    '[[:space:]()"]',
    '',
    'g'
  );
  normalized_actual := regexp_replace(
    lower(coalesce(actual_expression, '')),
    '[[:space:]()"]',
    '',
    'g'
  );
  if actual_type <> 'c'
    or not actual_valid
    or normalized_actual <> normalized_expected
  then
    return kernel_installer_schema_drift(
      table_name || '.' || constraint_name,
      'materialized constraint definition or validation state differs from the compiled catalog'
    );
  end if;
  return null;
end;
$kernel$;
"#;

const KERNEL_INSTALLER_MATERIALIZED_ASSERTIONS_DRIFT: &str = r#"
create or replace function kernel_installer_materialized_assertions_drift(request jsonb)
returns jsonb
language plpgsql
stable
parallel safe
security invoker
set search_path from current
as $kernel$
<<installer_materialized_assertions>>
declare
  table_value jsonb;
  assertion jsonb;
  assertion_kind text;
  table_name text;
  object_name text;
  expected_definition text;
  actual_definition text;
  assertion_exists boolean;
begin
  if request ? 'materialized_tables' then
    if jsonb_typeof(request->'materialized_tables') is distinct from 'array' then
      return kernel_installer_error('contract_validation_failed', 'Contract validation failed', 'materialized_tables', 'invalid_materialized_tables', 'materialized_tables must be a JSON array');
    end if;
    for table_value in select value from jsonb_array_elements(request->'materialized_tables')
    loop
      if jsonb_typeof(table_value) is distinct from 'string'
        or (table_value #>> '{}') !~ '^[A-Za-z][A-Za-z0-9_]*$'
      then
        return kernel_installer_error('contract_validation_failed', 'Contract validation failed', 'materialized_tables', 'invalid_materialized_table', 'materialized table names must be identifiers');
      end if;
      table_name := table_value #>> '{}';
      if to_regclass(format('%I.%I', current_schema(), table_name)) is null then
        return kernel_installer_schema_drift(table_name, 'required materialized table is missing');
      end if;
    end loop;
  end if;
  if not request ? 'materialized_assertions' then
    return null;
  end if;
  if jsonb_typeof(request->'materialized_assertions') is distinct from 'array' then
    return kernel_installer_error('contract_validation_failed', 'Contract validation failed', 'materialized_assertions', 'invalid_materialized_assertions', 'materialized_assertions must be a JSON array');
  end if;
  for assertion in select value from jsonb_array_elements(request->'materialized_assertions')
  loop
    assertion_kind := assertion->>'kind';
    table_name := assertion->>'table';
    object_name := assertion->>'name';
    expected_definition := assertion->>'definition';
    if jsonb_typeof(assertion) is distinct from 'object'
      or assertion_kind not in ('table', 'column', 'constraint', 'index', 'policy')
      or (assertion_kind <> 'index' and coalesce(table_name, '') !~ '^[A-Za-z][A-Za-z0-9_]*$')
      or (assertion_kind <> 'table' and coalesce(object_name, '') !~ '^[A-Za-z][A-Za-z0-9_]*$')
    then
      return kernel_installer_error('contract_validation_failed', 'Contract validation failed', 'materialized_assertions', 'invalid_materialized_assertion', 'materialized assertions require a supported kind and identifier names');
    end if;
    actual_definition := null;
    case assertion_kind
      when 'table' then
        assertion_exists := to_regclass(format('%I.%I', current_schema(), table_name)) is not null;
      when 'column' then
        select exists (
          select 1 from information_schema.columns
          where table_schema = current_schema()
            and information_schema.columns.table_name = installer_materialized_assertions.table_name
            and column_name = object_name
        ) into assertion_exists;
        if assertion_exists and expected_definition is not null then
          select format('%s%s', data_type, case when is_nullable = 'YES' then ' nullable' else ' not null' end)
          into actual_definition
          from information_schema.columns
          where table_schema = current_schema()
            and information_schema.columns.table_name = installer_materialized_assertions.table_name
            and column_name = object_name;
        end if;
      when 'constraint' then
        select pg_get_constraintdef(constraint_value.oid, true)
        into actual_definition
        from pg_constraint as constraint_value
        join pg_class as relation on relation.oid = constraint_value.conrelid
        join pg_namespace as namespace on namespace.oid = relation.relnamespace
        where namespace.nspname = current_schema()
          and relation.relname = table_name
          and constraint_value.conname = object_name
          and constraint_value.convalidated;
        assertion_exists := found;
      when 'index' then
        select index_value.indexdef into actual_definition
        from pg_indexes as index_value
        join pg_class as index_relation on index_relation.relname = index_value.indexname
        join pg_namespace as namespace
          on namespace.oid = index_relation.relnamespace
         and namespace.nspname = index_value.schemaname
        join pg_index as index_catalog on index_catalog.indexrelid = index_relation.oid
        where index_value.schemaname = current_schema()
          and index_value.indexname = object_name
          and (table_name is null or index_value.tablename = table_name)
          and index_catalog.indisvalid
          and index_catalog.indisready;
        assertion_exists := found;
      when 'policy' then
        select coalesce(qual, '') || '|' || coalesce(with_check, '')
        into actual_definition
        from pg_policies
        where schemaname = current_schema()
          and tablename = table_name
          and policyname = object_name;
        assertion_exists := found;
    end case;
    if not assertion_exists then
      return kernel_installer_schema_drift(
        coalesce(table_name || '.', '') || coalesce(object_name, table_name),
        'required materialized object is missing'
      );
    end if;
    if expected_definition is not null and actual_definition is distinct from expected_definition then
      return kernel_installer_schema_drift(
        coalesce(table_name || '.', '') || coalesce(object_name, table_name),
        'materialized definition differs from the compiled assertion'
      );
    end if;
  end loop;
  return null;
end;
$kernel$;
"#;

const KERNEL_INSTALLER_LOCK_APP: &str = r#"
create or replace function kernel_installer_repair_schema_revision_policies()
returns void
language plpgsql
volatile
parallel unsafe
security invoker
set search_path from current
as $kernel$
begin
  if exists (
    select 1 from pg_policies
    where schemaname = current_schema()
      and tablename = 'schema_revision'
      and policyname = 'kernel_tenant_isolation'
  ) then
    execute format(
      'alter policy kernel_tenant_isolation on %I.schema_revision using ((app_id, customer_id) = (select scope.app_id, scope.customer_id from (select current_setting(''kernel.app_id'', true) app_id, current_setting(''kernel.customer_id'', true) customer_id) scope where kernel_principal_scope_authorized(''any'', scope.app_id, scope.customer_id, null))) with check ((app_id, customer_id) = (select scope.app_id, scope.customer_id from (select current_setting(''kernel.app_id'', true) app_id, current_setting(''kernel.customer_id'', true) customer_id) scope where kernel_principal_scope_authorized(''any'', scope.app_id, scope.customer_id, null)))',
      current_schema()
    );
  else
    execute format(
      'create policy kernel_tenant_isolation on %I.schema_revision for all using ((app_id, customer_id) = (select scope.app_id, scope.customer_id from (select current_setting(''kernel.app_id'', true) app_id, current_setting(''kernel.customer_id'', true) customer_id) scope where kernel_principal_scope_authorized(''any'', scope.app_id, scope.customer_id, null))) with check ((app_id, customer_id) = (select scope.app_id, scope.customer_id from (select current_setting(''kernel.app_id'', true) app_id, current_setting(''kernel.customer_id'', true) customer_id) scope where kernel_principal_scope_authorized(''any'', scope.app_id, scope.customer_id, null)))',
      current_schema()
    );
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = current_schema()
      and tablename = 'schema_revision'
      and policyname = 'kernel_schema_catalog_read'
  ) then
    execute format(
      'alter policy kernel_schema_catalog_read on %I.schema_revision using (current_setting(''kernel.schema_catalog_read'', true) = ''on'' and kernel_principal_scope_authorized(''any'', app_id, customer_id, null))',
      current_schema()
    );
  else
    execute format(
      'create policy kernel_schema_catalog_read on %I.schema_revision for select using (current_setting(''kernel.schema_catalog_read'', true) = ''on'' and kernel_principal_scope_authorized(''any'', app_id, customer_id, null))',
      current_schema()
    );
  end if;
end;
$kernel$;

create or replace function kernel_installer_lock_app(app_id text, exclusive_lock boolean)
returns void
language plpgsql
volatile
parallel unsafe
security invoker
set search_path from current
as $kernel$
declare
  lock_name text := current_database() || ':' || current_schema() || ':kernel:installer:app:' || app_id;
begin
  if exclusive_lock then
    perform pg_advisory_xact_lock(hashtext(lock_name)::bigint);
  else
    perform pg_advisory_xact_lock_shared(hashtext(lock_name)::bigint);
  end if;
end;
$kernel$;

select kernel_installer_repair_schema_revision_policies();
"#;

const KERNEL_INSTALLER_LOCK_TENANT: &str = r#"
create or replace function kernel_installer_lock_tenant(app_id text, customer_id text)
returns void
language plpgsql
volatile
parallel unsafe
security invoker
set search_path from current
as $kernel$
declare
  lock_name text := 'postgres-schema:' || current_schema()
    || ':materialize-tenant:' || app_id || ':' || customer_id
    || ':schema-activation';
begin
  perform pg_advisory_xact_lock(hashtext(lock_name)::bigint);
end;
$kernel$;
"#;

const KERNEL_ENFORCE_SCHEMA_ACTIVATION_HEAD: &str = r#"
create or replace function kernel_enforce_schema_activation_head()
returns trigger
language plpgsql
security invoker
set search_path from current
as $activation_head$
declare
  required_base_schema_version text;
begin
  if new.activated_at is null then
    return new;
  end if;

  select base_schema_version
  into required_base_schema_version
  from schema_activation_head
  where app_id = new.app_id
    and customer_id = new.customer_id;

  if found
    and new.base_schema->>'version' is distinct from required_base_schema_version
  then
    raise exception
      'schema revision base version % is behind activation head % for app % customer %',
      new.base_schema->>'version',
      required_base_schema_version,
      new.app_id,
      new.customer_id
      using errcode = '23514',
            constraint = 'schema_revision_activation_head_check';
  end if;

  -- Close admissions in the activation transaction, before an old role-free
  -- token can reach schema or work-session entrypoints under a named policy.
  -- Read compiler-owned policy source directly: reading the active snapshot
  -- here would recurse through schema_revision's tenant-isolation policy.
  if exists (
    select 1 from schema_authorization_policy_source policy_source
    join schema_authorization_policy_expectation expectation
      on expectation.app_id = policy_source.app_id
      and expectation.schema_version = policy_source.schema_version
      and expectation.policy_declared
      and expectation.policy_hash = policy_source.policy_hash
    where policy_source.app_id = new.app_id
      and policy_source.schema_version = new.base_schema->>'version'
      and jsonb_array_length(policy_source.policy->'roles') > 0
  ) then
    update kernel_actor_access set active = false
    where app_id = new.app_id and customer_id = new.customer_id and active;
  end if;
  return new;
end;
$activation_head$;

do $kernel_install$
begin
  if not exists (
    select 1
    from pg_trigger as trigger_value
    where trigger_value.tgrelid = to_regclass('schema_revision')
      and trigger_value.tgname = 'schema_revision_activation_head'
      and not trigger_value.tgisinternal
  ) then
    execute 'create trigger schema_revision_activation_head
      before insert or update of activated_at, base_schema on schema_revision
      for each row execute function kernel_enforce_schema_activation_head()';
  end if;
end
$kernel_install$;
"#;

const KERNEL_PREPARE_SCHEMA_REVISION: &str = r#"
create or replace function kernel_prepare_schema_revision(request jsonb)
returns jsonb
language plpgsql
volatile
parallel unsafe
security invoker
set search_path from current
as $kernel$
<<installer_prepare>>
declare
  app_id text := request->>'app_id';
  customer_id text := request->>'customer_id';
  version text := request->>'version';
  release_id text := request->>'release_id';
  activation_kind text := request->>'activation_kind';
  schema_hash text := request->>'schema_hash';
  base_artifact_hash text := request->>'base_artifact_hash';
  effective_artifact_hash text := request->>'effective_artifact_hash';
  materialization_plan_hash text := request->>'materialization_plan_hash';
  expected_active_effective_hash text := request->>'expected_active_effective_hash';
  materialization_source text := request->>'materialization_source';
  materialization_git_sha text := request->>'materialization_git_sha';
  materialization_vercel_deployment_id text := request->>'materialization_vercel_deployment_id';
  materialization_vercel_environment text := request->>'materialization_vercel_environment';
  materialization_vercel_git_ref text := request->>'materialization_vercel_git_ref';
  base_schema jsonb := request->'base_schema';
  customer_overlay jsonb := request->'customer_overlay';
  effective_schema jsonb := request->'schema';
  seed_change_sets jsonb := coalesce(request->'seed_change_sets', '[]'::jsonb);
  phase_plan jsonb := request->'phase_plan';
  transition_contract jsonb := request->'transition_contract';
  has_transition_contract boolean := request ? 'transition_contract';
  phase jsonb;
  phase_index integer := 0;
  schema_revision_id bigint;
  existing record;
  active_same_base record;
  composed_active_schema jsonb;
begin
  if jsonb_typeof(request) is distinct from 'object' then
    return kernel_installer_error('contract_validation_failed', 'Contract validation failed', 'request', 'invalid_type', 'request must be an object');
  end if;
  if coalesce(app_id, '') = '' or coalesce(customer_id, '') = '' or coalesce(version, '') = ''
    or coalesce(release_id, '') = ''
  then
    return kernel_installer_error('contract_validation_failed', 'Contract validation failed', 'request', 'required', 'app_id, customer_id, version, and release_id are required');
  end if;
  if activation_kind not in ('app_base', 'tenant_overlay') then
    return kernel_installer_error('contract_validation_failed', 'Contract validation failed', 'activation_kind', 'invalid_activation_kind', 'activation_kind must be app_base or tenant_overlay');
  end if;
  if not kernel_installer_valid_hash(schema_hash)
    or not kernel_installer_valid_hash(base_artifact_hash)
    or not kernel_installer_valid_hash(effective_artifact_hash)
    or not kernel_installer_valid_hash(materialization_plan_hash)
  then
    return kernel_installer_error('contract_validation_failed', 'Contract validation failed', 'hashes', 'invalid_hash', 'schema and artifact hashes must be lowercase SHA-256 hex');
  end if;
  if not request ? 'expected_active_effective_hash'
    or (expected_active_effective_hash is not null and not kernel_installer_valid_hash(expected_active_effective_hash))
  then
    return kernel_installer_error('contract_validation_failed', 'Contract validation failed', 'expected_active_effective_hash', 'invalid_hash', 'expected_active_effective_hash must be null or lowercase SHA-256 hex');
  end if;
  if jsonb_typeof(base_schema) is distinct from 'object'
    or jsonb_typeof(customer_overlay) is distinct from 'object'
    or jsonb_typeof(effective_schema) is distinct from 'object'
    or effective_schema->>'app_id' is distinct from app_id
    or effective_schema->>'customer_id' is distinct from customer_id
    or effective_schema->>'version' is distinct from version
  then
    return kernel_installer_error('contract_validation_failed', 'Contract validation failed', 'schema', 'schema_scope_mismatch', 'effective schema identity must match app_id, customer_id, and version');
  end if;
  if jsonb_typeof(phase_plan) is distinct from 'array' then
    return kernel_installer_error('contract_validation_failed', 'Contract validation failed', 'phase_plan', 'invalid_type', 'phase_plan must be an array');
  end if;
  if jsonb_typeof(seed_change_sets) is distinct from 'array' then
    return kernel_installer_error('contract_validation_failed', 'Contract validation failed', 'seed_change_sets', 'invalid_type', 'seed_change_sets must be an array');
  end if;
  if has_transition_contract and (
    jsonb_typeof(transition_contract) is distinct from 'object'
    or jsonb_typeof(transition_contract->'predecessors') is distinct from 'array'
  )
  then
    return kernel_installer_error('contract_validation_failed', 'Contract validation failed', 'transition_contract', 'invalid_transition_contract', 'transition_contract must be the compiler-owned contract for this schema release');
  end if;
  if has_transition_contract and exists (
    select 1
    from jsonb_array_elements(transition_contract->'predecessors') as predecessor(value)
    where jsonb_typeof(predecessor.value) is distinct from 'object'
      or predecessor.value - array['version', 'schema']::text[] <> '{}'::jsonb
      or coalesce(predecessor.value->>'version', '') = ''
      or jsonb_typeof(predecessor.value->'schema') is distinct from 'object'
      or predecessor.value->'schema'->>'app_id' is distinct from app_id
      or predecessor.value->'schema'->>'version' is distinct from predecessor.value->>'version'
  ) then
    return kernel_installer_error('contract_validation_failed', 'Contract validation failed', 'transition_contract.predecessors', 'invalid_predecessor', 'each compiler transition predecessor must contain its exact scoped schema');
  end if;
  for phase in select value from jsonb_array_elements(phase_plan) loop
    if jsonb_typeof(phase) is distinct from 'object'
      or phase - array['id', 'kind', 'hash']::text[] <> '{}'::jsonb
      or coalesce(phase->>'id', '') !~ '^[a-z][a-z0-9_:-]*$'
      or phase->>'kind' not in ('transactional', 'backfill', 'validation', 'concurrent_index')
      or not kernel_installer_valid_hash(phase->>'hash')
    then
      return kernel_installer_error('contract_validation_failed', 'Contract validation failed', 'phase_plan[' || phase_index || ']', 'invalid_phase', 'each phase requires only id, kind, and a lowercase SHA-256 hash');
    end if;
    phase_index := phase_index + 1;
  end loop;
  if exists (
    select 1 from jsonb_array_elements(phase_plan) as item(value)
    group by value->>'id' having count(*) > 1
  ) then
    return kernel_installer_error('contract_validation_failed', 'Contract validation failed', 'phase_plan', 'duplicate_phase', 'phase ids must be unique');
  end if;

  perform set_config('kernel.app_id', app_id, true);
  perform set_config('kernel.customer_id', customer_id, true);
  perform kernel_installer_lock_app(app_id, false);
  perform kernel_installer_lock_tenant(app_id, customer_id);

  if not exists (
    select 1
    from schema_constraint_identity_source as source
    where source.app_id = installer_prepare.app_id
      and source.schema_version = installer_prepare.base_schema->>'version'
  ) then
    return kernel_installer_schema_drift(
      'schema_constraint_identity_source',
      'required compiler-owned constraint catalog is missing for the requested base schema'
    );
  end if;

  select sr.id, sr.version, sr.base_schema, sr.customer_overlay, sr.schema, sr.schema_hash,
         sir.activation_kind, sir.base_artifact_hash, sir.effective_artifact_hash,
         sir.seed_change_sets
  into active_same_base
  from schema_revision sr
  left join schema_installation_revision sir on sir.schema_revision_id = sr.id
  where sr.app_id = installer_prepare.app_id
    and sr.customer_id = installer_prepare.customer_id
    and sr.activated_at is not null
  for update of sr;
  if has_transition_contract and found
    and active_same_base.base_schema is distinct from base_schema
    and not exists (
      select 1
      from jsonb_array_elements(transition_contract->'predecessors') as predecessor(value)
      where jsonb_set(
              predecessor.value->'schema',
              '{customer_id}',
              to_jsonb(installer_prepare.customer_id)
            ) = kernel_installer_default_model_kind(active_same_base.base_schema)
    )
  then
    return kernel_installer_error(
      'schema_transition_conflict',
      'Schema transition conflict',
      'base_schema',
      'unsupported_predecessor',
      format(
        'the active base schema is not an exact compiler-owned transition predecessor (version %s; canonical SHA-256 %s)',
        coalesce(active_same_base.base_schema->>'version', '<missing>'),
        kernel_admin_sha256(kernel_canonical_json(active_same_base.base_schema))
      )
    );
  end if;
  if found
    and active_same_base.base_schema = base_schema
    and active_same_base.version is distinct from version
    and activation_kind = 'app_base'
    and active_same_base.seed_change_sets = seed_change_sets
    and effective_schema = base_schema
    and customer_overlay = '{}'::jsonb
    and version = base_schema->>'version'
  then
    if active_same_base.base_artifact_hash is distinct from base_artifact_hash then
      return kernel_installer_error('schema_revision_conflict', 'Schema revision conflict', 'base_artifact_hash', 'base_artifact_hash_mismatch', 'the active runtime overlay was compiled from a different base artifact');
    end if;
    if expected_active_effective_hash is not null
      and active_same_base.effective_artifact_hash is distinct from expected_active_effective_hash
    then
      return kernel_installer_error('schema_activation_conflict', 'Schema activation conflict', 'expected_active_effective_hash', 'expected_hash_mismatch', 'the active effective artifact hash changed before same-base materialization');
    end if;
    composed_active_schema := kernel_admin_apply_overlay(base_schema, active_same_base.customer_overlay);
    composed_active_schema := jsonb_set(
      composed_active_schema,
      '{version}',
      to_jsonb(active_same_base.schema->>'version')
    );
    if composed_active_schema is distinct from active_same_base.schema then
      return kernel_installer_error('schema_revision_conflict', 'Schema revision conflict', 'schema', 'effective_schema_mismatch', 'the active runtime overlay does not compose to the stored effective schema');
    end if;
    perform kernel_sync_schema_authorization_policy(active_same_base.id);
    insert into schema_activation_head (app_id, customer_id, base_schema_version)
    values (app_id, customer_id, coalesce(active_same_base.base_schema->>'version', active_same_base.version))
    on conflict on constraint schema_activation_head_pkey do update
      set base_schema_version = excluded.base_schema_version, advanced_at = now();
    return jsonb_build_object('ok', true, 'data', jsonb_build_object(
      'schema_revision_id', active_same_base.id,
      'app_id', app_id,
      'customer_id', customer_id,
      'activation_kind', active_same_base.activation_kind,
      'base_artifact_hash', active_same_base.base_artifact_hash,
      'effective_artifact_hash', active_same_base.effective_artifact_hash,
      'state', 'active',
      'idempotent', true
    ));
  end if;

  select sr.id, sr.activated_at, sr.base_schema, sr.customer_overlay, sr.schema, sr.schema_hash,
         sir.release_id, sir.activation_kind, sir.base_artifact_hash,
         sir.effective_artifact_hash, sir.materialization_plan_hash,
         sir.expected_active_effective_hash, sir.seed_change_sets, sir.phase_plan,
         sir.materialization_source as installation_materialization_source,
         sir.materialization_git_sha as installation_materialization_git_sha,
         sir.materialization_vercel_deployment_id as installation_materialization_vercel_deployment_id,
         sir.materialization_vercel_environment as installation_materialization_vercel_environment,
         sir.materialization_vercel_git_ref as installation_materialization_vercel_git_ref
  into existing
  from schema_revision sr
  left join schema_installation_revision sir on sir.schema_revision_id = sr.id
  where sr.app_id = installer_prepare.app_id
    and sr.customer_id = installer_prepare.customer_id
    and sr.version = installer_prepare.version
  for update of sr;

  if found then
    -- A pre-installer revision can be claimed only when every persisted schema
    -- value is exactly the generated candidate. This preserves the immutable
    -- installer identity without treating an arbitrary legacy revision as a
    -- compatible prepared revision.
    if existing.release_id is null
      and existing.base_schema is not distinct from base_schema
      and existing.customer_overlay is not distinct from customer_overlay
      and existing.schema is not distinct from effective_schema
      and existing.schema_hash is not distinct from schema_hash
    then
      begin
        insert into schema_installation_revision (
          schema_revision_id, app_id, customer_id, release_id, activation_kind,
          base_artifact_hash, effective_artifact_hash, materialization_plan_hash,
          expected_active_effective_hash, materialization_source,
          materialization_git_sha, materialization_vercel_deployment_id,
          materialization_vercel_environment, materialization_vercel_git_ref,
          seed_change_sets, phase_plan, ready_at, activated_at
        ) values (
          existing.id, installer_prepare.app_id, installer_prepare.customer_id,
          installer_prepare.release_id, installer_prepare.activation_kind,
          installer_prepare.base_artifact_hash,
          installer_prepare.effective_artifact_hash,
          installer_prepare.materialization_plan_hash,
          installer_prepare.expected_active_effective_hash,
          installer_prepare.materialization_source,
          installer_prepare.materialization_git_sha,
          installer_prepare.materialization_vercel_deployment_id,
          installer_prepare.materialization_vercel_environment,
          installer_prepare.materialization_vercel_git_ref,
          installer_prepare.seed_change_sets, installer_prepare.phase_plan,
          case when existing.activated_at is null then null else now() end,
          existing.activated_at
        );
      exception when others then
        return kernel_installer_error('database_error', 'Database operation failed', 'version', 'legacy_revision_claim_failed', 'the matching legacy revision could not be claimed by the installer');
      end;
      perform kernel_sync_schema_constraint_identities(existing.id);
      perform kernel_sync_schema_authorization_policy(existing.id);
      return jsonb_build_object('ok', true, 'data', jsonb_build_object(
        'schema_revision_id', existing.id,
        'app_id', app_id,
        'customer_id', customer_id,
        'activation_kind', activation_kind,
        'base_artifact_hash', base_artifact_hash,
        'effective_artifact_hash', effective_artifact_hash,
        'state', case when existing.activated_at is null then 'prepared' else 'active' end,
        'idempotent', false
      ));
    end if;
    if existing.release_id is null
      or existing.base_schema is distinct from base_schema
      or existing.customer_overlay is distinct from customer_overlay
      or existing.schema is distinct from effective_schema
      or existing.schema_hash is distinct from schema_hash
      or existing.release_id is distinct from release_id
      or existing.activation_kind is distinct from activation_kind
      or existing.base_artifact_hash is distinct from base_artifact_hash
      or existing.effective_artifact_hash is distinct from effective_artifact_hash
      or existing.materialization_plan_hash is distinct from materialization_plan_hash
      or existing.seed_change_sets is distinct from seed_change_sets
      or existing.phase_plan is distinct from phase_plan
    then
      return kernel_installer_error('schema_revision_conflict', 'Schema revision conflict', 'version', 'prepared_revision_mismatch', 'an incompatible revision already exists for this version');
    end if;
    if existing.activated_at is null and existing.release_id is not null then
      -- Deployment provenance identifies the attempt that prepared the
      -- revision, not the revision itself. A failed preview can be retried
      -- with a new Vercel deployment, so refresh supplied provenance while
      -- keeping the schema, release, and artifact identities immutable.
      update schema_installation_revision as sir
      set expected_active_effective_hash = installer_prepare.expected_active_effective_hash,
          materialization_source = case when request ? 'materialization_source' and installer_prepare.materialization_source is not null then installer_prepare.materialization_source else sir.materialization_source end,
          materialization_git_sha = case when request ? 'materialization_git_sha' and installer_prepare.materialization_git_sha is not null then installer_prepare.materialization_git_sha else sir.materialization_git_sha end,
          materialization_vercel_deployment_id = case when request ? 'materialization_vercel_deployment_id' and installer_prepare.materialization_vercel_deployment_id is not null then installer_prepare.materialization_vercel_deployment_id else sir.materialization_vercel_deployment_id end,
          materialization_vercel_environment = case when request ? 'materialization_vercel_environment' and installer_prepare.materialization_vercel_environment is not null then installer_prepare.materialization_vercel_environment else sir.materialization_vercel_environment end,
          materialization_vercel_git_ref = case when request ? 'materialization_vercel_git_ref' and installer_prepare.materialization_vercel_git_ref is not null then installer_prepare.materialization_vercel_git_ref else sir.materialization_vercel_git_ref end
      where sir.schema_revision_id = existing.id;
    end if;
    if existing.activated_at is not null then
      insert into schema_activation_head (app_id, customer_id, base_schema_version)
      values (app_id, customer_id, coalesce(existing.base_schema->>'version', version))
      on conflict on constraint schema_activation_head_pkey do update
        set base_schema_version = excluded.base_schema_version, advanced_at = now();
    end if;
    perform kernel_sync_schema_constraint_identities(existing.id);
    perform kernel_sync_schema_authorization_policy(existing.id);
    return jsonb_build_object('ok', true, 'data', jsonb_build_object(
      'schema_revision_id', existing.id,
      'app_id', app_id,
      'customer_id', customer_id,
      'activation_kind', activation_kind,
      'base_artifact_hash', base_artifact_hash,
      'effective_artifact_hash', effective_artifact_hash,
      'state', case when existing.activated_at is null then 'prepared' else 'active' end,
      'idempotent', true
    ));
  end if;

  begin
    insert into schema_revision (
      app_id, customer_id, version, base_schema, customer_overlay, schema,
      schema_hash, materialization_source
    ) values (
      installer_prepare.app_id, installer_prepare.customer_id, installer_prepare.version,
      installer_prepare.base_schema, installer_prepare.customer_overlay,
      installer_prepare.effective_schema, installer_prepare.schema_hash,
      coalesce(installer_prepare.materialization_source, 'generated_sql_installer')
    ) returning id into schema_revision_id;
    perform kernel_sync_schema_constraint_identities(schema_revision_id);
    perform kernel_sync_schema_authorization_policy(schema_revision_id);
    insert into schema_installation_revision (
      schema_revision_id, app_id, customer_id, release_id, activation_kind,
      base_artifact_hash, effective_artifact_hash, materialization_plan_hash,
      expected_active_effective_hash, materialization_source,
      materialization_git_sha, materialization_vercel_deployment_id,
      materialization_vercel_environment, materialization_vercel_git_ref,
      seed_change_sets, phase_plan
    ) values (
      installer_prepare.schema_revision_id, installer_prepare.app_id,
      installer_prepare.customer_id, installer_prepare.release_id,
      installer_prepare.activation_kind, installer_prepare.base_artifact_hash,
      installer_prepare.effective_artifact_hash,
      installer_prepare.materialization_plan_hash,
      installer_prepare.expected_active_effective_hash,
      installer_prepare.materialization_source,
      installer_prepare.materialization_git_sha,
      installer_prepare.materialization_vercel_deployment_id,
      installer_prepare.materialization_vercel_environment,
      installer_prepare.materialization_vercel_git_ref,
      installer_prepare.seed_change_sets,
      installer_prepare.phase_plan
    );
  exception when others then
    return kernel_installer_error('database_error', 'Database operation failed', 'prepare', 'prepare_failed', 'inactive schema revision preparation was rolled back');
  end;

  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'schema_revision_id', schema_revision_id,
    'app_id', app_id,
    'customer_id', customer_id,
    'activation_kind', activation_kind,
    'base_artifact_hash', base_artifact_hash,
    'effective_artifact_hash', effective_artifact_hash,
    'state', 'prepared',
    'idempotent', false
  ));
end;
$kernel$;
"#;

const KERNEL_VALIDATE_SCHEMA_REVISION_READINESS: &str = r#"
create or replace function kernel_validate_schema_revision_readiness(request jsonb)
returns jsonb
language plpgsql
volatile
parallel unsafe
security invoker
set search_path from current
as $kernel$
<<installer_readiness>>
declare
  app_id text := request->>'app_id';
  customer_id text := request->>'customer_id';
  schema_revision_id bigint;
  effective_artifact_hash text := request->>'effective_artifact_hash';
  materialization_plan_hash text := request->>'materialization_plan_hash';
  phase_results jsonb := request->'phase_results';
  prepared record;
  expected_phase jsonb;
  actual_phase jsonb;
  phase_index integer;
  interval_violation jsonb;
  custom_field_issues jsonb;
begin
  begin
    schema_revision_id := (request->>'schema_revision_id')::bigint;
  exception when others then
    return kernel_installer_error('contract_validation_failed', 'Contract validation failed', 'schema_revision_id', 'invalid_schema_revision_id', 'schema_revision_id must be a positive integer');
  end;
  if coalesce(schema_revision_id, 0) <= 0 or coalesce(app_id, '') = '' or coalesce(customer_id, '') = ''
    or not kernel_installer_valid_hash(effective_artifact_hash)
    or not kernel_installer_valid_hash(materialization_plan_hash)
    or jsonb_typeof(phase_results) is distinct from 'array'
  then
    return kernel_installer_error('contract_validation_failed', 'Contract validation failed', 'request', 'invalid_readiness_request', 'scope, hashes, revision id, and phase_results are required');
  end if;

  perform set_config('kernel.app_id', app_id, true);
  perform set_config('kernel.customer_id', customer_id, true);
  perform kernel_installer_lock_app(app_id, false);
  perform kernel_installer_lock_tenant(app_id, customer_id);
  -- Installation timestamps retain history; schema_revision owns current activation.
  select sir.*, sr.activated_at as current_activated_at
  into prepared
  from schema_installation_revision sir
  join schema_revision sr on sr.id = sir.schema_revision_id
  where sir.schema_revision_id = installer_readiness.schema_revision_id
    and sir.app_id = installer_readiness.app_id
    and sir.customer_id = installer_readiness.customer_id
  for update of sir, sr;
  if not found then
    return kernel_installer_error('schema_revision_missing', 'Schema revision not found', 'schema_revision_id', 'unknown_schema_revision', 'the prepared schema revision does not exist in this tenant scope');
  end if;
  if prepared.current_activated_at is not null then
    return kernel_installer_error('schema_revision_conflict', 'Schema revision conflict', 'schema_revision_id', 'revision_already_active', 'readiness cannot be changed after activation');
  end if;
  if prepared.effective_artifact_hash is distinct from effective_artifact_hash
    or prepared.materialization_plan_hash is distinct from materialization_plan_hash
  then
    return kernel_installer_error('schema_revision_conflict', 'Schema revision conflict', 'hashes', 'prepared_hash_mismatch', 'readiness hashes do not match the prepared revision');
  end if;
  if jsonb_array_length(prepared.phase_plan) <> jsonb_array_length(phase_results) then
    return kernel_installer_error('schema_revision_not_ready', 'Schema revision is not ready', 'phase_results', 'phase_count_mismatch', 'every compiler-authored materialization phase must be completed');
  end if;
  if jsonb_array_length(prepared.phase_plan) > 0 then
    for phase_index in 0..jsonb_array_length(prepared.phase_plan) - 1 loop
      expected_phase := prepared.phase_plan->phase_index;
      actual_phase := phase_results->phase_index;
      if jsonb_typeof(actual_phase) is distinct from 'object'
        or actual_phase - array['id', 'hash', 'status']::text[] <> '{}'::jsonb
        or actual_phase->>'id' is distinct from expected_phase->>'id'
        or actual_phase->>'hash' is distinct from expected_phase->>'hash'
        or actual_phase->>'status' is distinct from 'complete'
      then
        return kernel_installer_error('schema_revision_not_ready', 'Schema revision is not ready', 'phase_results[' || phase_index || ']', 'phase_validation_failed', 'phase identity, hash, order, and completion status must match the prepared plan');
      end if;
    end loop;
  end if;
  -- Custom fields must still fit the effective schema: a base release cannot
  -- newly declare a field an active custom field already uses, or retire or
  -- retype a field an active derived field reads. A collision the active
  -- revision already holds is tolerated so the tenant can still retire it.
  select kernel_admin_custom_field_collision_issues(sr.schema, coalesce((
      select active.schema from schema_revision active
      where active.app_id = installer_readiness.app_id
        and active.customer_id = installer_readiness.customer_id
        and active.activated_at is not null
    ), '{}'::jsonb)) || kernel_derived_schema_issues(sr.schema)
  into custom_field_issues
  from schema_revision sr where sr.id = installer_readiness.schema_revision_id;
  if jsonb_array_length(custom_field_issues) > 0 then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'schema_revision_not_ready',
      'message', 'Schema revision is not ready',
      'details', custom_field_issues
    ));
  end if;
  -- Cross-record interval rules validate existing live rows before activation.
  interval_violation := coalesce(
    kernel_constraint_interval_isolation_error(app_id, customer_id, schema_revision_id, null),
    kernel_constraint_interval_violation(app_id, customer_id, schema_revision_id, null)
  );
  if interval_violation is not null then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'schema_revision_not_ready',
      'message', 'Schema revision is not ready',
      'details', interval_violation->'details'
    ));
  end if;

  begin
    update schema_installation_revision as sir
    set phase_results = installer_readiness.phase_results,
        ready_at = coalesce(ready_at, now())
    where sir.schema_revision_id = installer_readiness.schema_revision_id;
    update schema_revision as sr
    set materialized_at = coalesce(materialized_at, now())
    where sr.id = installer_readiness.schema_revision_id;
  exception when others then
    return kernel_installer_error('database_error', 'Database operation failed', 'readiness', 'readiness_update_failed', 'readiness validation was rolled back');
  end;

  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'schema_revision_id', schema_revision_id,
    'app_id', app_id,
    'customer_id', customer_id,
    'effective_artifact_hash', effective_artifact_hash,
    'materialization_plan_hash', materialization_plan_hash,
    'state', 'ready'
  ));
end;
$kernel$;
"#;

const KERNEL_SCHEMA_REVISION_IS_ACTIVE: &str = r#"
create or replace function kernel_schema_revision_is_active(request jsonb)
returns jsonb
language plpgsql
volatile
parallel unsafe
security invoker
set search_path from current
as $kernel$
<<installer_active_check>>
declare
  app_id text := request->>'app_id';
  customer_id text := request->>'customer_id';
  version text := request->>'version';
  schema_hash text := request->>'schema_hash';
  effective_artifact_hash text := request->>'effective_artifact_hash';
  active boolean;
  schema_revision_id bigint;
begin
  if jsonb_typeof(request) is distinct from 'object'
    or coalesce(app_id, '') = ''
    or coalesce(customer_id, '') = ''
    or coalesce(version, '') = ''
    or not kernel_installer_valid_hash(schema_hash)
    or not kernel_installer_valid_hash(effective_artifact_hash)
  then
    return kernel_installer_error('contract_validation_failed', 'Contract validation failed', 'request', 'invalid_active_revision_request', 'scope, version, schema hash, and effective artifact hash are required');
  end if;

  perform set_config('kernel.app_id', app_id, true);
  perform set_config('kernel.customer_id', customer_id, true);

  select sr.id
  into schema_revision_id
  from schema_revision sr
  join schema_installation_revision sir on sir.schema_revision_id = sr.id
  where sr.app_id = installer_active_check.app_id
    and sr.customer_id = installer_active_check.customer_id
    and sr.version = installer_active_check.version
    and sr.schema_hash = installer_active_check.schema_hash
    and sir.effective_artifact_hash = installer_active_check.effective_artifact_hash
    and sir.ready_at is not null
    and sr.materialized_at is not null
    and sr.activated_at is not null;
  active := found;

  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'app_id', app_id,
    'customer_id', customer_id,
    'version', version,
    'schema_hash', schema_hash,
    'effective_artifact_hash', effective_artifact_hash,
    'active', active,
    'schema_revision_id', schema_revision_id
  ));
end;
$kernel$;
"#;

// This is intentionally a ledger reader, not an installer operation. It is
// granted to the generated runtime so an operator can diagnose a scoped
// release without acquiring an installer lock or changing activation state.
const KERNEL_READ_RUNTIME_RELEASE_OBSERVABILITY: &str = r#"
create or replace function kernel_read_runtime_release_observability(request jsonb)
returns jsonb
language plpgsql
volatile
parallel unsafe
security invoker
set search_path from current
as $kernel$
<<release_observability>>
declare
  app_id text := request->>'app_id';
  customer_id text := request->>'customer_id';
  authorization_result jsonb;
  active_revision record;
  release_rows jsonb;
  tenant_lock_hash bigint;
  tenant_lock_waiters bigint;
begin
  if request is null or jsonb_typeof(request) <> 'object'
    or request - array['app_id', 'customer_id'] <> '{}'::jsonb
    or coalesce(btrim(app_id), '') = ''
    or coalesce(btrim(customer_id), '') = ''
  then
    return kernel_installer_error(
      'contract_validation_failed', 'Contract validation failed', 'request',
      'invalid_release_observability_request',
      'only non-empty app_id and customer_id are required'
    );
  end if;

  authorization_result := kernel_authorize_scope('runtime', app_id, customer_id, null);
  if authorization_result is not null then
    return authorization_result;
  end if;
  perform set_config('kernel.app_id', app_id, true);
  perform set_config('kernel.customer_id', customer_id, true);

  -- This is the same deterministic advisory key used by the installer. Reading
  -- pg_locks does not acquire it, so this signal cannot delay or select an
  -- activation. Only the count for this authorized tenant key is returned.
  tenant_lock_hash := hashtext(
    'postgres-schema:' || current_schema()
      || ':materialize-tenant:' || app_id || ':' || customer_id
      || ':schema-activation'
  )::bigint;
  select count(*) into tenant_lock_waiters
  from pg_locks lock_row
  where lock_row.locktype = 'advisory'
    and not lock_row.granted
    and lock_row.classid = ((tenant_lock_hash >> 32) & 4294967295)::oid
    and lock_row.objid = (tenant_lock_hash & 4294967295)::oid
    and lock_row.objsubid = 1;

  select sr.id, sr.version, sr.base_schema->>'version' as base_version,
         sr.schema_hash, sir.release_id, sir.activation_kind,
         sir.base_artifact_hash, sir.effective_artifact_hash,
         sir.materialization_plan_hash, sr.activated_at
  into active_revision
  from schema_revision sr
  join schema_installation_revision sir on sir.schema_revision_id = sr.id
  where sr.app_id = release_observability.app_id
    and sr.customer_id = release_observability.customer_id
    and sr.activated_at is not null
  order by sr.activated_at desc, sr.id desc
  limit 1;

  select coalesce(jsonb_agg(snapshot order by (snapshot->>'schema_revision_id')::bigint), '[]'::jsonb)
  into release_rows
  from (
    select jsonb_build_object(
      'schema_revision_id', sr.id,
      'effective_revision', sr.version,
      'base_revision', sr.base_schema->>'version',
      'release_id', sir.release_id,
      'activation_kind', sir.activation_kind,
      'artifact_hashes', jsonb_build_object(
        'schema', sr.schema_hash,
        'base', sir.base_artifact_hash,
        'effective', sir.effective_artifact_hash,
        'materialization_plan', sir.materialization_plan_hash
      ),
      'timestamps', jsonb_build_object(
        'prepared_at', sir.prepared_at,
        'ready_at', sir.ready_at,
        'activated_at', sr.activated_at
      ),
      'preparation', jsonb_build_object(
        'state', case
          when sr.activated_at is not null then 'active'
          when sir.ready_at is not null then 'ready'
          else 'preparing'
        end,
        'phase_plan', sir.phase_plan,
        'phase_results', coalesce(sir.phase_results, '[]'::jsonb),
        'progress_source', 'readiness_ledger',
        'resumable_backfill', jsonb_build_object(
          'planned', coalesce((
            select count(*) from jsonb_array_elements(sir.phase_plan) phase
            where phase.value->>'kind' = 'backfill'
          ), 0),
          'complete', coalesce((
            select count(*) from jsonb_array_elements(coalesce(sir.phase_results, '[]'::jsonb)) phase
            where phase.value->>'status' = 'complete'
              and exists (
                select 1 from jsonb_array_elements(sir.phase_plan) planned
                where planned.value->>'id' = phase.value->>'id'
                  and planned.value->>'kind' = 'backfill'
              )
          ), 0)
        )
      ),
      'activation_cas', jsonb_build_object(
        'expected_active_effective_hash', sir.expected_active_effective_hash,
        'actual_active_effective_hash', active_revision.effective_artifact_hash,
        'status', case
          when sr.activated_at is not null then 'activated'
          when sir.expected_active_effective_hash is distinct from active_revision.effective_artifact_hash then 'would_conflict'
          else 'expected_hash_matches'
        end
      ),
      'drift_reconciliation', jsonb_build_object(
        'status', 'not_measured_by_snapshot',
        'readiness_recorded', sir.ready_at is not null
      ),
      'runtime_schema', jsonb_build_object(
        'status', case
          when sr.schema_hash = kernel_admin_sha256(kernel_canonical_json(sr.schema)) then 'stored_schema_hash_matches'
          else 'stored_schema_hash_mismatch'
        end,
        'stored_schema_hash', sr.schema_hash,
        'computed_schema_hash', kernel_admin_sha256(kernel_canonical_json(sr.schema))
      ),
      'forward_recovery', jsonb_build_object(
        'status', case
          when sr.activated_at is not null then 'active'
          when sir.ready_at is not null then 'prepared_candidate'
          else 'resume_preparation'
        end,
        'activation_authority', 'external_installer_only'
      ),
      'lock_waits', jsonb_build_object(
        'waiting_sessions', tenant_lock_waiters,
        'status', case when tenant_lock_waiters > 0 then 'waiting' else 'clear' end,
        'scope', 'tenant_schema_activation'
      )
    ) as snapshot
    from schema_revision sr
    join schema_installation_revision sir on sir.schema_revision_id = sr.id
    where sr.app_id = release_observability.app_id
      and sr.customer_id = release_observability.customer_id
  ) snapshots;

  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'app_id', app_id,
    'customer_id', customer_id,
    'active_schema_revision_id', active_revision.id,
    'active_base_revision', active_revision.base_version,
    'active_effective_revision', active_revision.version,
    'active_effective_artifact_hash', active_revision.effective_artifact_hash,
    'releases', release_rows
  ));
end;
$kernel$;
"#;

const KERNEL_VALIDATE_MATERIALIZED_SCHEMA_REVISION: &str = r#"
create or replace function kernel_validate_materialized_schema_revision(request jsonb)
returns jsonb
language plpgsql
volatile
parallel unsafe
security invoker
set search_path from current
as $kernel$
<<installer_catalog_validation>>
declare
  expected_schema jsonb := case when request ? 'schema' then request->'schema' else request end;
  expected_schema_hash text := request->>'expected_schema_hash';
  model_value jsonb;
  field_value jsonb;
  model_kind text;
  target_model_kind text;
  target_model_id text;
  normalized_model text;
  normalized_field text;
  record_table_name text;
  version_table_name text;
  relation_column_name text;
  relation_target_model_column text;
  relation_constraint_name text;
  relation_target_table_name text;
  legacy_index_name text;
  metadata_column text;
  actual_default text;
  actual_not_null boolean;
  actual_type text;
  expected_type text;
  expected_column text;
  required_constraint_name text;
  static_column jsonb;
  static_constraint_name text;
  static_constraint jsonb;
  static_index jsonb;
  drift jsonb;
  trigger_row record;
  competing_trigger_name text;
  policy_table_name text;
  policy_count bigint;
  policy_row record;
  source_policy_found boolean;
  privileged_object text;
  role_name text;
  role_row record;
  function_row record;
  execution_role text := kernel_installer_capability_role('execution_owner');
  runtime_role text := kernel_installer_capability_role('runtime');
  schema_admin_role text := kernel_installer_capability_role('schema_admin');
  query_role text := kernel_installer_capability_role('query');
  normalized_expected text;
  normalized_actual text;
  delegated_result jsonb;
  active_base_schema jsonb;
  active_effective_schema jsonb;
  active_overlay jsonb;
  active_schema_hash text;
  composed_schema jsonb;
begin
  if jsonb_typeof(request) is distinct from 'object'
    or jsonb_typeof(expected_schema) is distinct from 'object'
    or coalesce(expected_schema->>'app_id', '') = ''
    or coalesce(expected_schema->>'customer_id', '') = ''
    or coalesce(expected_schema->>'version', '') = ''
    or jsonb_typeof(expected_schema->'models') is distinct from 'array'
    or not kernel_installer_valid_hash(expected_schema_hash)
  then
    return kernel_installer_error('contract_validation_failed', 'Contract validation failed', 'request', 'invalid_materialized_schema_request', 'schema identity, models, and expected_schema_hash are required');
  end if;

  perform set_config('kernel.app_id', expected_schema->>'app_id', true);
  perform set_config('kernel.customer_id', expected_schema->>'customer_id', true);

  if to_regclass(format('%I.%I', current_schema(), 'change_set_lifecycle_order_seq')) is null then
    return kernel_installer_schema_drift('change_set_lifecycle_order_seq', 'required materialized sequence is missing');
  end if;
  if to_regclass(format('%I.%I', current_schema(), 'schema_revision')) is null then
    return kernel_installer_schema_drift('schema_revision', 'required materialized table is missing');
  end if;
  foreach policy_table_name in array array[
    'schema_activation_head', 'change_set', 'agent_run',
    'schema_constraint_identity_source', 'schema_constraint_identity',
    'lookup_record', 'lookup_version', 'lookup_value_projection',
    'lookup_alias_projection', 'lookup_relation_projection'
  ] loop
    if to_regclass(format('%I.%I', current_schema(), policy_table_name)) is null then
      return kernel_installer_schema_drift(
        policy_table_name,
        'required materialized table is missing'
      );
    end if;
  end loop;
  foreach metadata_column in array array[
    'schema_hash', 'materialization_source', 'materialization_git_sha',
    'materialization_vercel_deployment_id', 'materialization_vercel_environment',
    'materialization_vercel_git_ref', 'materialized_at'
  ] loop
    if not exists (
      select 1
      from information_schema.columns
      where table_schema = current_schema()
        and table_name = 'schema_revision'
        and column_name = metadata_column
    ) then
      return kernel_installer_schema_drift('schema_revision', 'required materialization metadata column is missing: ' || metadata_column);
    end if;
  end loop;
  for static_column in
    select value from jsonb_array_elements('[
      {"table":"schema_constraint_identity_source","column":"app_id","type":"text"},
      {"table":"schema_constraint_identity_source","column":"schema_version","type":"text"},
      {"table":"schema_constraint_identity_source","column":"catalog","type":"jsonb"},
      {"table":"schema_constraint_identity","column":"schema_revision_id","type":"bigint"},
      {"table":"schema_constraint_identity","column":"app_id","type":"text"},
      {"table":"schema_constraint_identity","column":"customer_id","type":"text"},
      {"table":"schema_constraint_identity","column":"catalog","type":"jsonb"}
    ]'::jsonb)
  loop
    select format_type(attribute.atttypid, attribute.atttypmod), attribute.attnotnull
    into actual_type, actual_not_null
    from pg_attribute as attribute
    where attribute.attrelid = to_regclass(format('%I.%I', current_schema(), static_column->>'table'))
      and attribute.attname = static_column->>'column'
      and attribute.attnum > 0
      and not attribute.attisdropped;
    if not found
      or actual_type <> static_column->>'type'
      or not actual_not_null
    then
      return kernel_installer_schema_drift(
        (static_column->>'table'),
        'required constraint catalog column is missing or has wrong type: ' || (static_column->>'column')
      );
    end if;
  end loop;
  drift := kernel_installer_primary_key_drift(
    'schema_constraint_identity_source',
    'schema_constraint_identity_source_pkey',
    array['app_id', 'schema_version']
  );
  if drift is not null then return drift; end if;
  drift := kernel_installer_primary_key_drift(
    'schema_constraint_identity',
    'schema_constraint_identity_pkey',
    array['schema_revision_id']
  );
  if drift is not null then return drift; end if;
  drift := kernel_installer_fk_drift(
    'schema_constraint_identity',
    'schema_constraint_identity_revision_tenant_fk',
    array['schema_revision_id', 'app_id', 'customer_id'],
    'schema_revision',
    array['id', 'app_id', 'customer_id']
  );
  if drift is not null then return drift; end if;

  if to_regprocedure('kernel_enforce_schema_activation_head()') is not null then
    select trigger_value.tgenabled, trigger_value.tgtype,
           trigger_value.tgqual is null as has_no_when_clause,
           procedure_value.proname
    into trigger_row
    from pg_trigger as trigger_value
    join pg_proc as procedure_value on procedure_value.oid = trigger_value.tgfoid
    where trigger_value.tgrelid = to_regclass(format('%I.%I', current_schema(), 'schema_revision'))
      and trigger_value.tgname = 'schema_revision_activation_head'
      and not trigger_value.tgisinternal;
    if not found
      or trigger_row.tgenabled <> 'O'
      or trigger_row.tgtype <> 23
      or not trigger_row.has_no_when_clause
      or trigger_row.proname <> 'kernel_enforce_schema_activation_head'
    then
      return kernel_installer_schema_drift(
        'schema_revision.schema_revision_activation_head',
        'activation-head trigger differs from the compiled catalog'
      );
    end if;

    select trigger_value.tgname
    into competing_trigger_name
    from pg_trigger as trigger_value
    where trigger_value.tgrelid = to_regclass(format('%I.%I', current_schema(), 'schema_revision'))
      and not trigger_value.tgisinternal
      and trigger_value.tgname <> 'schema_revision_activation_head'
      and (trigger_value.tgtype & 1) = 1
      and (trigger_value.tgtype & 2) = 2
      and ((trigger_value.tgtype & 4) = 4 or (trigger_value.tgtype & 16) = 16)
    order by trigger_value.tgname
    limit 1;
    if found then
      return kernel_installer_schema_drift(
        'schema_revision.' || competing_trigger_name,
        'competing BEFORE ROW INSERT/UPDATE trigger could mutate the revision after the activation-head check'
      );
    end if;
  end if;

  drift := kernel_installer_unique_drift(
    'schema_revision',
    'schema_revision_scope_version_key',
    array['app_id', 'customer_id', 'version']
  );
  if drift is not null then
    return drift;
  end if;
  drift := kernel_installer_fk_drift(
    'change_set',
    'change_set_schema_revision_tenant_fk',
    array['schema_revision_id', 'app_id', 'customer_id'],
    'schema_revision',
    array['id', 'app_id', 'customer_id']
  );
  if drift is not null then
    return drift;
  end if;

  select pg_get_expr(column_default.adbin, column_default.adrelid)
  into actual_default
  from pg_attrdef as column_default
  join pg_attribute as attribute
    on attribute.attrelid = column_default.adrelid
    and attribute.attnum = column_default.adnum
  where column_default.adrelid = to_regclass(format('%I.%I', current_schema(), 'change_set'))
    and attribute.attname = 'id';
  if not found
    or actual_default not like 'nextval(%'
    or pg_get_serial_sequence(format('%I.%I', current_schema(), 'change_set'), 'id') is null
  then
    return kernel_installer_schema_drift(
      'change_set',
      'sequence-backed column default differs from the compiled catalog'
    );
  end if;

  for static_constraint in
    select value from jsonb_array_elements('[
      {"table":"change_set","name":"change_set_created_with_mode_check","expression":"created_with_mode = ANY (ARRAY[''mainline''::text, ''draft''::text])"},
      {"table":"change_set","name":"change_set_status_check","expression":"status = ANY (ARRAY[''draft''::text, ''mainline''::text, ''discarded''::text])"},
      {"table":"change_set","name":"change_set_applied_at_status_check","expression":"(status = ''mainline''::text) = (applied_at IS NOT NULL)"},
      {"table":"change_set","name":"change_set_applied_order_status_check","expression":"(status = ''mainline''::text) = (applied_order IS NOT NULL)"},
      {"table":"agent_run","name":"agent_run_status_check","expression":"status = ANY (ARRAY[''recorded''::text, ''completed''::text, ''validation_exhausted''::text, ''budget_exhausted''::text, ''runtime_error''::text, ''cancelled''::text])"}
    ]'::jsonb)
  loop
    drift := kernel_installer_check_drift(
      static_constraint->>'table',
      static_constraint->>'name',
      static_constraint->>'expression'
    );
    if drift is not null then return drift; end if;
  end loop;

  for static_index in
    select value from jsonb_array_elements('[
      {"table":"schema_revision","name":"schema_revision_tenant_id_idx","unique":true,"columns":["id","app_id","customer_id"]},
      {"table":"schema_revision","name":"schema_revision_active_idx","unique":true,"columns":["app_id","customer_id"],"predicate":"activated_at IS NOT NULL"},
      {"table":"change_set","name":"change_set_tenant_id_idx","unique":true,"columns":["id","app_id","customer_id"]},
      {"table":"change_set","name":"change_set_idempotency_idx","unique":true,"columns":["app_id","customer_id","idempotency_key"],"predicate":"idempotency_key IS NOT NULL"},
      {"table":"change_set","name":"change_set_pending_draft_idx","unique":false,"columns":["app_id","customer_id"],"predicate":"status = ''draft''::text AND applied_order IS NULL"},
      {"table":"agent_run","name":"agent_run_tenant_id_idx","unique":true,"columns":["id","app_id","customer_id"]}
    ]'::jsonb)
  loop
    drift := kernel_installer_index_drift(
      static_index->>'table',
      static_index->>'name',
      (static_index->>'unique')::boolean,
      array(select jsonb_array_elements_text(static_index->'columns')),
      static_index->>'predicate'
    );
    if drift is not null then return drift; end if;
  end loop;

  foreach policy_table_name in array array[
    'lookup_record', 'lookup_version', 'lookup_value_projection',
    'lookup_alias_projection', 'lookup_relation_projection'
  ] loop
    if to_regclass(format('%I.%I', current_schema(), policy_table_name)) is null then
      return kernel_installer_schema_drift(
        policy_table_name,
        'required shared lookup table is missing'
      );
    end if;
  end loop;

  for metadata_column, actual_default in
    select expected.column_name, expected.default_value
    from (values
      ('custom_fields', '''[]''::jsonb'),
      ('metadata', '''{}''::jsonb'),
      ('many_relations', '''{}''::jsonb'),
      ('values', '''{}''::jsonb'),
      ('availability', '''active''::text'),
      ('tombstones_record', 'false'),
      ('untombstones_record', 'false')
    ) as expected(column_name, default_value)
  loop
    select pg_get_expr(column_default.adbin, column_default.adrelid), attribute.attnotnull
    into normalized_actual, actual_not_null
    from pg_attrdef as column_default
    join pg_attribute as attribute
      on attribute.attrelid = column_default.adrelid
     and attribute.attnum = column_default.adnum
    where column_default.adrelid = to_regclass(format('%I.%I', current_schema(), 'lookup_version'))
      and attribute.attname = metadata_column;
    if not found
      or not actual_not_null
      or regexp_replace(lower(normalized_actual), '[[:space:]()]', '', 'g')
        <> regexp_replace(lower(actual_default), '[[:space:]()]', '', 'g')
    then
      return kernel_installer_schema_drift(
        'lookup_version.' || metadata_column,
        'column default or nullability differs from the compiled catalog'
      );
    end if;
  end loop;

  select pg_get_expr(column_default.adbin, column_default.adrelid), attribute.attnotnull
  into actual_default, actual_not_null
  from pg_attrdef as column_default
  join pg_attribute as attribute
    on attribute.attrelid = column_default.adrelid
   and attribute.attnum = column_default.adnum
  where column_default.adrelid = to_regclass(format('%I.%I', current_schema(), 'lookup_alias_projection'))
    and attribute.attname = 'is_current';
  if not found or not actual_not_null
    or regexp_replace(lower(actual_default), '[[:space:]()]', '', 'g') <> 'false'
  then
    return kernel_installer_schema_drift(
      'lookup_alias_projection.is_current',
      'column default or nullability differs from the compiled catalog'
    );
  end if;

  for static_constraint in
    select value from jsonb_array_elements('[
      {"table":"lookup_version","name":"lookup_version_stage_check","expression":"stage = ANY (ARRAY[''draft''::text, ''mainline''::text, ''discarded''::text, ''reverted''::text])"},
      {"table":"lookup_version","name":"lookup_version_effective_range_check","expression":"effective_end IS NULL OR effective_end >= effective_start"},
      {"table":"lookup_version","name":"lookup_version_applied_at_stage_check","expression":"(stage = ''mainline''::text) = (applied_at IS NOT NULL)"},
      {"table":"lookup_version","name":"lookup_version_record_event_exclusion_check","expression":"NOT (tombstones_record AND untombstones_record)"},
      {"table":"lookup_version","name":"lookup_version_availability_check","expression":"availability = ANY (ARRAY[''active''::text, ''retired''::text])"},
      {"table":"lookup_version","name":"lookup_version_values_object_check","expression":"jsonb_typeof(values) = ''object''::text"},
      {"table":"lookup_version","name":"lookup_version_metadata_object_check","expression":"jsonb_typeof(metadata) = ''object''::text"},
      {"table":"lookup_version","name":"lookup_version_many_relations_object_check","expression":"jsonb_typeof(many_relations) = ''object''::text"},
      {"table":"lookup_alias_projection","name":"lookup_alias_projection_kind_check","expression":"kind = ANY (ARRAY[''display''::text, ''alias''::text])"},
      {"table":"lookup_relation_projection","name":"lookup_relation_projection_target_check","expression":"target_kind = ''lookup''::text AND lookup_target_model_id = target_model_id AND lookup_target_record_id = target_record_id OR target_kind = ''entity''::text AND lookup_target_model_id IS NULL AND lookup_target_record_id IS NULL"},
      {"table":"lookup_relation_projection","name":"lookup_relation_projection_kind_check","expression":"relation_kind = ANY (ARRAY[''scalar''::text, ''many''::text]) AND ordinal >= 0"}
    ]'::jsonb)
  loop
    drift := kernel_installer_check_drift(
      static_constraint->>'table',
      static_constraint->>'name',
      static_constraint->>'expression'
    );
    if drift is not null then return drift; end if;
  end loop;

  drift := kernel_installer_fk_drift(
    'lookup_version', 'lookup_version_record_fk',
    array['app_id', 'customer_id', 'model_id', 'record_id'],
    'lookup_record', array['app_id', 'customer_id', 'model_id', 'id']
  );
  if drift is not null then return drift; end if;
  drift := kernel_installer_fk_drift(
    'lookup_version', 'lookup_version_change_set_fk',
    array['change_set_id', 'app_id', 'customer_id'],
    'change_set', array['id', 'app_id', 'customer_id']
  );
  if drift is not null then return drift; end if;
  drift := kernel_installer_primary_key_drift(
    'lookup_version', 'lookup_version_pkey',
    array['app_id', 'customer_id', 'model_id', 'id']
  );
  if drift is not null then return drift; end if;
  drift := kernel_installer_primary_key_drift(
    'lookup_value_projection', 'lookup_value_projection_pkey',
    array['app_id', 'customer_id', 'model_id', 'version_id', 'field_id']
  );
  if drift is not null then return drift; end if;
  drift := kernel_installer_primary_key_drift(
    'lookup_alias_projection', 'lookup_alias_projection_pkey',
    array['app_id', 'customer_id', 'model_id', 'version_id', 'field_id', 'kind', 'ordinal']
  );
  if drift is not null then return drift; end if;
  drift := kernel_installer_primary_key_drift(
    'lookup_relation_projection', 'lookup_relation_projection_pkey',
    array['app_id', 'customer_id', 'source_model_id', 'version_id', 'field_id', 'ordinal']
  );
  if drift is not null then return drift; end if;
  drift := kernel_installer_fk_drift(
    'lookup_value_projection', 'lookup_value_projection_version_fk',
    array['app_id', 'customer_id', 'model_id', 'version_id'],
    'lookup_version', array['app_id', 'customer_id', 'model_id', 'id']
  );
  if drift is not null then return drift; end if;
  drift := kernel_installer_fk_drift(
    'lookup_alias_projection', 'lookup_alias_projection_version_fk',
    array['app_id', 'customer_id', 'model_id', 'version_id'],
    'lookup_version', array['app_id', 'customer_id', 'model_id', 'id']
  );
  if drift is not null then return drift; end if;
  drift := kernel_installer_fk_drift(
    'lookup_relation_projection', 'lookup_relation_projection_version_fk',
    array['app_id', 'customer_id', 'source_model_id', 'version_id'],
    'lookup_version', array['app_id', 'customer_id', 'model_id', 'id']
  );
  if drift is not null then return drift; end if;
  drift := kernel_installer_fk_drift(
    'lookup_relation_projection',
    'lookup_relation_projection_lookup_target_fk',
    array['app_id', 'customer_id', 'lookup_target_model_id', 'lookup_target_record_id'],
    'lookup_record',
    array['app_id', 'customer_id', 'model_id', 'id']
  );
  if drift is not null then return drift; end if;

  for static_index in
    select value from jsonb_array_elements('[
      {"table":"lookup_record","name":"lookup_record_external_key_idx","unique":true,"columns":["app_id","customer_id","model_id","external_key"],"predicate":"external_key IS NOT NULL"},
      {"table":"lookup_version","name":"lookup_version_lookup_idx","unique":false,"columns":["app_id","customer_id","model_id","record_id","stage","effective_start"]},
      {"table":"lookup_version","name":"lookup_version_change_set_idx","unique":false,"columns":["app_id","customer_id","change_set_id","model_id"]},
      {"table":"lookup_version","name":"lookup_version_change_set_value_once_idx","unique":true,"columns":["app_id","customer_id","model_id","record_id","effective_start","change_set_id"],"predicate":"NOT tombstones_record AND NOT untombstones_record"},
      {"table":"lookup_version","name":"lookup_version_mainline_lifecycle_once_idx","unique":true,"columns":["app_id","customer_id","model_id","record_id","effective_start","tombstones_record","untombstones_record"],"predicate":"stage = ''mainline''::text AND (tombstones_record OR untombstones_record)"},
      {"table":"lookup_version","name":"lookup_version_draft_idx","unique":false,"columns":["app_id","customer_id","model_id","record_id","effective_start"],"predicate":"stage = ''draft''::text"},
      {"table":"lookup_value_projection","name":"lookup_value_projection_text_idx","unique":false,"columns":["app_id","customer_id","model_id","field_id","text_value","record_id"]},
      {"table":"lookup_value_projection","name":"lookup_value_projection_number_idx","unique":false,"columns":["app_id","customer_id","model_id","field_id","number_value","record_id"],"predicate":"number_value IS NOT NULL"},
      {"table":"lookup_value_projection","name":"lookup_value_projection_bool_idx","unique":false,"columns":["app_id","customer_id","model_id","field_id","bool_value","record_id"],"predicate":"bool_value IS NOT NULL"},
      {"table":"lookup_value_projection","name":"lookup_value_projection_date_idx","unique":false,"columns":["app_id","customer_id","model_id","field_id","date_value","record_id"],"predicate":"date_value IS NOT NULL"},
      {"table":"lookup_alias_projection","name":"lookup_alias_projection_match_idx","unique":false,"columns":["app_id","customer_id","model_id","normalized_alias","record_id"],"predicate":"is_current"},
      {"table":"lookup_alias_projection","name":"lookup_alias_projection_record_idx","unique":false,"columns":["app_id","customer_id","model_id","record_id"],"predicate":"is_current"},
      {"table":"lookup_alias_projection","name":"lookup_alias_projection_display_page_idx","unique":false,"columns":["app_id","customer_id","model_id","normalized_alias","record_id","version_id"],"predicate":"kind = ''display''::text"},
      {"table":"lookup_alias_projection","name":"lookup_alias_projection_active_unique_idx","unique":true,"columns":["app_id","customer_id","model_id","normalized_alias"],"predicate":"is_current"},
      {"table":"lookup_relation_projection","name":"lookup_relation_projection_target_idx","unique":false,"columns":["app_id","customer_id","target_model_id","target_record_id","source_model_id","source_record_id"]}
    ]'::jsonb)
  loop
    drift := kernel_installer_index_drift(
      static_index->>'table',
      static_index->>'name',
      (static_index->>'unique')::boolean,
      array(select jsonb_array_elements_text(static_index->'columns')),
      static_index->>'predicate'
    );
    if drift is not null then return drift; end if;
  end loop;

  for model_value in
    select value from jsonb_array_elements(expected_schema->'models')
  loop
    normalized_model := kernel_admin_normalize_identifier(model_value->>'id');
    if normalized_model is null then
      return kernel_installer_error('contract_validation_failed', 'Contract validation failed', 'models.id', 'invalid_identifier', 'model id cannot be materialized');
    end if;
    model_kind := coalesce(model_value->>'kind', 'entity');
    if model_kind = 'lookup' then
      for field_value in select value from jsonb_array_elements(model_value->'fields')
      loop
        if coalesce(field_value->>'lifecycle', 'active') <> 'active' then continue; end if;
        if coalesce((field_value->>'required')::boolean, false) then
          drift := kernel_installer_check_drift('lookup_version',
            kernel_admin_bounded_identifier('lookup_version_' || (model_value->>'id') || '_' || (field_value->>'id') || '_required_check'),
            format('stage <> ''mainline''::text OR effective_end IS NOT NULL OR model_id <> %L::text OR tombstones_record OR untombstones_record OR values ? %L::text', model_value->>'id', field_value->>'id'));
          if drift is not null then return drift; end if;
        end if;
        if coalesce((field_value->>'is_unique')::boolean, false) then
          drift := kernel_installer_index_drift('lookup_version',
            kernel_admin_bounded_identifier((model_value->>'id') || '_version_' || (field_value->>'id') || '_live_unique_idx'), true,
            array['app_id', 'customer_id', format('(("values" -> %L::text) -> ''value''::text)', field_value->>'id')],
            format('model_id = %L::text AND stage = ''mainline''::text AND effective_end IS NULL AND ((values -> %L::text) -> ''value''::text) IS NOT NULL', model_value->>'id', field_value->>'id'));
          if drift is not null then return drift; end if;
        end if;
      end loop;
      continue;
    end if;
    record_table_name := kernel_admin_bounded_identifier(normalized_model || '_record');
    version_table_name := kernel_admin_bounded_identifier(normalized_model || '_version');
    if to_regclass(format('%I.%I', current_schema(), record_table_name)) is null then
      return kernel_installer_schema_drift(record_table_name, 'required materialized table is missing');
    end if;
    if to_regclass(format('%I.%I', current_schema(), version_table_name)) is null then
      return kernel_installer_schema_drift(version_table_name, 'required materialized table is missing');
    end if;

    for static_column in
      select value from jsonb_array_elements(jsonb_build_array(
        jsonb_build_object('table', record_table_name, 'name', 'id', 'type', 'uuid', 'not_null', true),
        jsonb_build_object('table', record_table_name, 'name', 'app_id', 'type', 'text', 'not_null', true),
        jsonb_build_object('table', record_table_name, 'name', 'customer_id', 'type', 'text', 'not_null', true),
        jsonb_build_object('table', record_table_name, 'name', 'external_key', 'type', 'text', 'not_null', false),
        jsonb_build_object('table', record_table_name, 'name', 'created_at', 'type', 'timestamp with time zone', 'not_null', true),
        jsonb_build_object('table', version_table_name, 'name', 'id', 'type', 'uuid', 'not_null', true),
        jsonb_build_object('table', version_table_name, 'name', 'record_id', 'type', 'uuid', 'not_null', true),
        jsonb_build_object('table', version_table_name, 'name', 'app_id', 'type', 'text', 'not_null', true),
        jsonb_build_object('table', version_table_name, 'name', 'customer_id', 'type', 'text', 'not_null', true),
        jsonb_build_object('table', version_table_name, 'name', 'stage', 'type', 'text', 'not_null', true),
        jsonb_build_object('table', version_table_name, 'name', 'effective_start', 'type', 'date', 'not_null', true),
        jsonb_build_object('table', version_table_name, 'name', 'effective_end', 'type', 'date', 'not_null', false),
        jsonb_build_object('table', version_table_name, 'name', 'change_set_id', 'type', 'bigint', 'not_null', true),
        jsonb_build_object('table', version_table_name, 'name', 'created_at', 'type', 'timestamp with time zone', 'not_null', true),
        jsonb_build_object('table', version_table_name, 'name', 'applied_at', 'type', 'timestamp with time zone', 'not_null', false),
        jsonb_build_object('table', version_table_name, 'name', 'tombstones_record', 'type', 'boolean', 'not_null', true),
        jsonb_build_object('table', version_table_name, 'name', 'untombstones_record', 'type', 'boolean', 'not_null', true),
        jsonb_build_object('table', version_table_name, 'name', 'provenance', 'type', 'jsonb', 'not_null', false),
        jsonb_build_object('table', version_table_name, 'name', 'custom_fields', 'type', 'jsonb', 'not_null', true),
        jsonb_build_object('table', version_table_name, 'name', 'metadata', 'type', 'jsonb', 'not_null', true)
      ))
    loop
      select format_type(attribute.atttypid, attribute.atttypmod), attribute.attnotnull
      into actual_type, actual_not_null
      from pg_attribute as attribute
      where attribute.attrelid = to_regclass(format('%I.%I', current_schema(), static_column->>'table'))
        and attribute.attname = static_column->>'name'
        and attribute.attnum > 0
        and not attribute.attisdropped;
      if not found then
        return kernel_installer_schema_drift(
          (static_column->>'table') || '.' || (static_column->>'name'),
          'required materialized column is missing'
        );
      end if;
      if actual_type <> static_column->>'type'
        or actual_not_null <> (static_column->>'not_null')::boolean
      then
        return kernel_installer_schema_drift(
          (static_column->>'table') || '.' || (static_column->>'name'),
          'materialized column definition differs from the compiled catalog'
        );
      end if;
    end loop;

    for field_value in
      select value from jsonb_array_elements(coalesce(model_value->'fields', '[]'::jsonb))
    loop
      normalized_field := kernel_admin_normalize_identifier(field_value->>'id');
      if normalized_field is null then
        return kernel_installer_error('contract_validation_failed', 'Contract validation failed', 'models.fields.id', 'invalid_identifier', 'field id cannot be materialized');
      end if;
      if field_value->>'type' = 'money_rate' then
        for expected_column, expected_type in
          select column_name, column_type from (values
            (kernel_admin_bounded_identifier(normalized_field || '_amount'), 'numeric'),
            (kernel_admin_bounded_identifier(normalized_field || '_currency'), 'text'),
            (kernel_admin_bounded_identifier(normalized_field || '_period'), 'text')
          ) as expected(column_name, column_type)
        loop
          select format_type(attribute.atttypid, attribute.atttypmod), attribute.attnotnull
          into actual_type, actual_not_null
          from pg_attribute as attribute
          where attribute.attrelid = to_regclass(format('%I.%I', current_schema(), version_table_name))
            and attribute.attname = expected_column
            and attribute.attnum > 0
            and not attribute.attisdropped;
          if not found then
            return kernel_installer_schema_drift(
              version_table_name || '.' || expected_column,
              'required materialized column is missing'
            );
          end if;
          if actual_type <> expected_type or actual_not_null then
            return kernel_installer_schema_drift(
              version_table_name || '.' || expected_column,
              'materialized column definition differs from the compiled catalog'
            );
          end if;
        end loop;
        continue;
      end if;
      expected_column := kernel_admin_bounded_identifier(normalized_field);
      expected_type := case field_value->>'type'
        when 'text' then 'text'
        when 'iso_country' then 'text'
        when 'iso_currency' then 'text'
        when 'enum' then 'text'
        when 'number' then 'numeric'
        when 'bool' then 'boolean'
        when 'date' then 'date'
        when 'datetime' then 'timestamp with time zone'
        when 'relation' then 'uuid'
        when 'text_list' then 'text[]'
        when 'known_aliases' then 'text[]'
        when 'json' then 'jsonb'
        else null
      end;
      if expected_type is null then
        return kernel_installer_error('contract_validation_failed', 'Contract validation failed', 'models.fields.type', 'unsupported_field_type', 'field type cannot be validated against the materialized catalog');
      end if;
      select format_type(attribute.atttypid, attribute.atttypmod), attribute.attnotnull
      into actual_type, actual_not_null
      from pg_attribute as attribute
      where attribute.attrelid = to_regclass(format('%I.%I', current_schema(), version_table_name))
        and attribute.attname = expected_column
        and attribute.attnum > 0
        and not attribute.attisdropped;
      if not found then
        return kernel_installer_schema_drift(
          version_table_name || '.' || expected_column,
          'required materialized column is missing'
        );
      end if;
      if actual_type <> expected_type or actual_not_null then
        return kernel_installer_schema_drift(
          version_table_name || '.' || expected_column,
          'materialized column definition differs from the compiled catalog'
        );
      end if;
    end loop;

    legacy_index_name := kernel_admin_bounded_identifier(version_table_name || '_mainline_unique_idx');
    if to_regclass(format('%I.%I', current_schema(), legacy_index_name)) is not null then
      return kernel_installer_schema_drift(
        version_table_name || '.' || legacy_index_name,
        'legacy mainline uniqueness index is still present'
      );
    end if;

    for metadata_column, normalized_expected in
      select expected.column_name, expected.default_value
      from (values
        ('custom_fields', '''[]''::jsonb'),
        ('metadata', '''{}''::jsonb')
      ) as expected(column_name, default_value)
    loop
      select pg_get_expr(column_default.adbin, column_default.adrelid), attribute.attnotnull
      into actual_default, actual_not_null
      from pg_attrdef as column_default
      join pg_attribute as attribute
        on attribute.attrelid = column_default.adrelid
       and attribute.attnum = column_default.adnum
      where column_default.adrelid = to_regclass(format('%I.%I', current_schema(), version_table_name))
        and attribute.attname = metadata_column;
      if not found
        or not actual_not_null
        or regexp_replace(lower(actual_default), '[[:space:]()]', '', 'g')
          <> regexp_replace(lower(normalized_expected), '[[:space:]()]', '', 'g')
      then
        if metadata_column = 'custom_fields' and found then
          return kernel_installer_schema_drift(
            version_table_name || '.custom_fields',
            'expected default `''[]''::jsonb`, found `' || actual_default || '`'
          );
        end if;
        return kernel_installer_schema_drift(
          version_table_name || '.' || metadata_column,
          'column default or nullability differs from the compiled catalog'
        );
      end if;
    end loop;
    for static_index in
      select value from jsonb_array_elements(jsonb_build_array(
        jsonb_build_object(
          'table', record_table_name,
          'name', kernel_admin_bounded_identifier(record_table_name || '_external_key_idx'),
          'unique', true,
          'columns', jsonb_build_array('app_id', 'customer_id', 'external_key'),
          'predicate', 'external_key IS NOT NULL'
        ),
        jsonb_build_object(
          'table', version_table_name,
          'name', kernel_admin_bounded_identifier(version_table_name || '_lookup_idx'),
          'unique', false,
          'columns', jsonb_build_array('record_id', 'stage', 'effective_start')
        ),
        jsonb_build_object(
          'table', version_table_name,
          'name', kernel_admin_bounded_identifier(version_table_name || '_source_record_ref_idx'),
          'unique', false,
          'columns', jsonb_build_array('app_id', 'customer_id', '(provenance ->> ''source_record_ref''::text)'),
          'predicate', 'provenance ? ''source_record_ref''::text'
        ),
        jsonb_build_object(
          'table', version_table_name,
          'name', kernel_admin_bounded_identifier(version_table_name || '_change_set_idx'),
          'unique', false,
          'columns', jsonb_build_array('change_set_id')
        ),
        jsonb_build_object(
          'table', version_table_name,
          'name', kernel_admin_bounded_identifier(version_table_name || '_change_set_value_once_idx'),
          'unique', true,
          'columns', jsonb_build_array('record_id', 'effective_start', 'change_set_id'),
          'predicate', 'NOT tombstones_record AND NOT untombstones_record'
        ),
        jsonb_build_object(
          'table', version_table_name,
          'name', kernel_admin_bounded_identifier(version_table_name || '_mainline_lifecycle_once_idx'),
          'unique', true,
          'columns', jsonb_build_array('record_id', 'effective_start', 'tombstones_record', 'untombstones_record'),
          'predicate', 'stage = ''mainline''::text AND (tombstones_record OR untombstones_record)'
        ),
        jsonb_build_object(
          'table', version_table_name,
          'name', kernel_admin_bounded_identifier(version_table_name || '_draft_idx'),
          'unique', false,
          'columns', jsonb_build_array('app_id', 'customer_id', 'record_id', 'effective_start'),
          'predicate', 'stage = ''draft''::text'
        )
      ))
    loop
      drift := kernel_installer_index_drift(
        static_index->>'table',
        static_index->>'name',
        (static_index->>'unique')::boolean,
        array(select jsonb_array_elements_text(static_index->'columns')),
        static_index->>'predicate'
      );
      if drift is not null then return drift; end if;
    end loop;

    for field_value in
      select value from jsonb_array_elements(coalesce(model_value->'fields', '[]'::jsonb))
    loop
      normalized_field := kernel_admin_normalize_identifier(field_value->>'id');
      if field_value->>'type' = 'money_rate' then
        for expected_column in
          select value from jsonb_array_elements_text(jsonb_build_array(
            kernel_admin_bounded_identifier(normalized_field || '_amount'),
            kernel_admin_bounded_identifier(normalized_field || '_currency'),
            kernel_admin_bounded_identifier(normalized_field || '_period')
          ))
        loop
          drift := kernel_installer_check_drift(
            version_table_name,
            kernel_admin_bounded_identifier(version_table_name || '_' || expected_column || '_record_event_null_check'),
            'NOT tombstones_record AND NOT untombstones_record OR ' || expected_column || ' IS NULL'
          );
          if drift is not null then return drift; end if;
          if coalesce((field_value->>'required')::boolean, false)
            and coalesce(field_value->>'lifecycle', 'active') = 'active'
          then
            drift := kernel_installer_check_drift(
              version_table_name,
              kernel_admin_bounded_identifier(version_table_name || '_' || expected_column || '_required_check'),
              'stage <> ''mainline''::text OR effective_end IS NOT NULL OR tombstones_record OR untombstones_record OR ' || expected_column || ' IS NOT NULL'
            );
            if drift is not null then return drift; end if;
          end if;
        end loop;
        drift := kernel_installer_check_drift(
          version_table_name,
          kernel_admin_bounded_identifier(
            version_table_name || '_' || kernel_admin_bounded_identifier(normalized_field || '_amount') || '_all_or_none_check'
          ),
          '(' || kernel_admin_bounded_identifier(normalized_field || '_amount') || ' IS NULL AND '
            || kernel_admin_bounded_identifier(normalized_field || '_currency') || ' IS NULL AND '
            || kernel_admin_bounded_identifier(normalized_field || '_period') || ' IS NULL) OR ('
            || kernel_admin_bounded_identifier(normalized_field || '_amount') || ' IS NOT NULL AND '
            || kernel_admin_bounded_identifier(normalized_field || '_currency') || ' IS NOT NULL AND '
            || kernel_admin_bounded_identifier(normalized_field || '_period') || ' IS NOT NULL)'
        );
        if drift is not null then return drift; end if;
        drift := kernel_installer_check_drift(
          version_table_name,
          kernel_admin_bounded_identifier(
            version_table_name || '_' || kernel_admin_bounded_identifier(normalized_field || '_period') || '_period_check'
          ),
          kernel_admin_bounded_identifier(normalized_field || '_period') || ' IS NULL OR '
            || kernel_admin_bounded_identifier(normalized_field || '_period')
            || ' = ANY (ARRAY[''hourly''::text, ''daily''::text, ''weekly''::text, ''monthly''::text, ''annual''::text])'
        );
        if drift is not null then return drift; end if;
        expected_column := kernel_admin_bounded_identifier(normalized_field || '_amount');
      else
        expected_column := kernel_admin_bounded_identifier(normalized_field);
        drift := kernel_installer_check_drift(
          version_table_name,
          kernel_admin_bounded_identifier(version_table_name || '_' || expected_column || '_record_event_null_check'),
          'NOT tombstones_record AND NOT untombstones_record OR ' || expected_column || ' IS NULL'
        );
        if drift is not null then return drift; end if;
        if coalesce((field_value->>'required')::boolean, false)
          and coalesce(field_value->>'lifecycle', 'active') = 'active'
        then
          drift := kernel_installer_check_drift(
            version_table_name,
            kernel_admin_bounded_identifier(version_table_name || '_' || expected_column || '_required_check'),
            'stage <> ''mainline''::text OR effective_end IS NOT NULL OR tombstones_record OR untombstones_record OR ' || expected_column || ' IS NOT NULL'
          );
          if drift is not null then return drift; end if;
        end if;
      end if;
      if coalesce((field_value->>'is_unique')::boolean, false) then
        drift := kernel_installer_index_drift(
          version_table_name,
          kernel_admin_bounded_identifier(version_table_name || '_' || expected_column || '_live_unique_idx'),
          true,
          array['app_id', 'customer_id', expected_column],
          'stage = ''mainline''::text AND effective_end IS NULL AND ' || expected_column || ' IS NOT NULL'
        );
        if drift is not null then return drift; end if;
      end if;
    end loop;

    foreach metadata_column in array array['tombstones_record', 'untombstones_record']
    loop
      select pg_get_expr(column_default.adbin, column_default.adrelid)
      into actual_default
      from pg_attrdef as column_default
      join pg_attribute as attribute
        on attribute.attrelid = column_default.adrelid
        and attribute.attnum = column_default.adnum
      where column_default.adrelid = to_regclass(
          format('%I.%I', current_schema(), installer_catalog_validation.version_table_name)
        )
        and attribute.attname = metadata_column;
      if not found or regexp_replace(lower(actual_default), '[[:space:]()]', '', 'g') <> 'false' then
        return kernel_installer_schema_drift(
          version_table_name,
          'materialized column default differs from the compiled catalog'
        );
      end if;
    end loop;

    drift := kernel_installer_unique_drift(
      record_table_name,
      kernel_admin_bounded_identifier(record_table_name || '_tenant_id_key'),
      array['id', 'app_id', 'customer_id']
    );
    if drift is not null then
      return drift;
    end if;
    drift := kernel_installer_fk_drift(
      version_table_name,
      kernel_admin_bounded_identifier(version_table_name || '_record_tenant_fk'),
      array['record_id', 'app_id', 'customer_id'],
      record_table_name,
      array['id', 'app_id', 'customer_id']
    );
    if drift is not null then
      return drift;
    end if;
    drift := kernel_installer_fk_drift(
      version_table_name,
      kernel_admin_bounded_identifier(version_table_name || '_change_set_tenant_fk'),
      array['change_set_id', 'app_id', 'customer_id'],
      'change_set',
      array['id', 'app_id', 'customer_id']
    );
    if drift is not null then
      return drift;
    end if;

    for field_value in
      select value
      from jsonb_array_elements(coalesce(model_value->'fields', '[]'::jsonb))
      where value->>'type' = 'relation'
    loop
      relation_column_name := kernel_admin_bounded_identifier(
        kernel_admin_normalize_identifier(field_value->>'id')
      );
      relation_constraint_name := kernel_admin_bounded_identifier(
        version_table_name || '_' || relation_column_name || '_tenant_fk'
      );
      select coalesce(target_model->>'kind', 'entity'),
             target_model->>'id',
             kernel_admin_bounded_identifier(
               kernel_admin_normalize_identifier(target_model->>'id') || '_record'
             )
      into target_model_kind, target_model_id, relation_target_table_name
      from jsonb_array_elements(expected_schema->'models') as target_models(target_model)
      where target_model->>'id' = field_value->>'target_model';
      if not found then
        return kernel_installer_error('contract_validation_failed', 'Contract validation failed', 'models.fields.target_model', 'unknown_relation_target', 'relation target cannot be validated against the materialized catalog');
      end if;
      if not exists (
        select 1
        from pg_constraint as constraint_value
        where constraint_value.conrelid = to_regclass(
            format('%I.%I', current_schema(), installer_catalog_validation.version_table_name)
          )
          and constraint_value.conname = relation_constraint_name
          and constraint_value.contype = 'f'
          and constraint_value.convalidated
      ) then
        return kernel_installer_schema_drift(
          version_table_name || '.' || relation_constraint_name,
          'required materialized relation constraint is missing or unvalidated'
        );
      end if;
      if target_model_kind = 'lookup' then
        relation_target_model_column := kernel_admin_bounded_identifier(
          relation_column_name || '_target_model'
        );
        select pg_get_expr(column_default.adbin, column_default.adrelid), attribute.attnotnull
        into actual_default, actual_not_null
        from pg_attrdef as column_default
        join pg_attribute as attribute
          on attribute.attrelid = column_default.adrelid
         and attribute.attnum = column_default.adnum
        where column_default.adrelid = to_regclass(format('%I.%I', current_schema(), version_table_name))
          and attribute.attname = relation_target_model_column;
        if not found or not actual_not_null
          or regexp_replace(lower(actual_default), '[[:space:]()]', '', 'g')
            <> regexp_replace(lower(quote_literal(target_model_id) || '::text'), '[[:space:]()]', '', 'g')
        then
          return kernel_installer_schema_drift(
            version_table_name || '.' || relation_target_model_column,
            'lookup target discriminator differs from the compiled catalog'
          );
        end if;
        required_constraint_name := kernel_admin_bounded_identifier(
          version_table_name || '_' || relation_column_name || '_target_model_check'
        );
        if not exists (
          select 1 from pg_constraint as constraint_value
          where constraint_value.conrelid = to_regclass(format('%I.%I', current_schema(), version_table_name))
            and constraint_value.conname = required_constraint_name
            and constraint_value.contype = 'c'
            and constraint_value.convalidated
        ) then
          return kernel_installer_schema_drift(
            version_table_name || '.' || required_constraint_name,
            'lookup target discriminator constraint is missing or unvalidated'
          );
        end if;
        drift := kernel_installer_check_drift(
          version_table_name,
          required_constraint_name,
          relation_target_model_column || ' = ' || quote_literal(target_model_id) || '::text'
        );
        if drift is not null then return drift; end if;
        drift := kernel_installer_fk_drift(
          version_table_name,
          relation_constraint_name,
          array['app_id', 'customer_id', relation_target_model_column, relation_column_name],
          'lookup_record',
          array['app_id', 'customer_id', 'model_id', 'id']
        );
      else
        drift := kernel_installer_fk_drift(
          version_table_name,
          relation_constraint_name,
          array[relation_column_name, 'app_id', 'customer_id'],
          relation_target_table_name,
          array['id', 'app_id', 'customer_id']
        );
      end if;
      if drift is not null then
        return drift;
      end if;
    end loop;

    for static_constraint in
      select value from jsonb_array_elements(jsonb_build_array(
        jsonb_build_object(
          'name', kernel_admin_bounded_identifier(version_table_name || '_stage_check'),
          'expression', 'stage = ANY (ARRAY[''draft''::text, ''mainline''::text, ''discarded''::text, ''reverted''::text])'
        ),
        jsonb_build_object(
          'name', kernel_admin_bounded_identifier(version_table_name || '_effective_range_check'),
          'expression', 'effective_end IS NULL OR effective_end >= effective_start'
        ),
        jsonb_build_object(
          'name', kernel_admin_bounded_identifier(version_table_name || '_applied_at_stage_check'),
          'expression', '(stage = ''mainline''::text) = (applied_at IS NOT NULL)'
        ),
        jsonb_build_object(
          'name', kernel_admin_bounded_identifier(version_table_name || '_record_event_exclusion_check'),
          'expression', 'NOT (tombstones_record AND untombstones_record)'
        ),
        jsonb_build_object(
          'name', kernel_admin_bounded_identifier(version_table_name || '_metadata_object_check'),
          'expression', 'jsonb_typeof(metadata) = ''object''::text'
        ),
        jsonb_build_object(
          'name', kernel_admin_bounded_identifier(version_table_name || '_metadata_limits_check'),
          'expression', case
            when model_value #> '{extensions,record_metadata}' is null
              or model_value #> '{extensions,record_metadata}' = 'null'::jsonb
            then 'metadata = ''{}''::jsonb'
            else 'octet_length(metadata::text) <= '
              || (model_value #>> '{extensions,record_metadata,max_bytes}')
          end
        )
      ))
    loop
      drift := kernel_installer_check_drift(
        version_table_name,
        static_constraint->>'name',
        static_constraint->>'expression'
      );
      if drift is not null then return drift; end if;
    end loop;
  end loop;

  foreach policy_table_name in array array[
    'schema_revision', 'schema_activation_head', 'change_set', 'agent_run',
    'schema_constraint_identity',
    'lookup_record', 'lookup_version', 'lookup_value_projection',
    'lookup_alias_projection', 'lookup_relation_projection'
  ] loop
    if not exists (
      select 1 from pg_policies as policy
      where policy.schemaname = current_schema()
        and policy.tablename = policy_table_name
        and policy.policyname = 'kernel_tenant_isolation'
    ) then
      return kernel_installer_schema_drift(
        policy_table_name || '.kernel_tenant_isolation',
        'RLS or tenant policy differs from the compiled catalog'
      );
    end if;
    select count(*) into policy_count
    from pg_policies as policy
    where policy.schemaname = current_schema()
      and policy.tablename = policy_table_name;
    if policy_count <> (case when policy_table_name = 'schema_revision' then 2 else 1 end) then
      return kernel_installer_schema_drift(
        policy_table_name || '.kernel_tenant_scope',
        'unexpected RLS policy differs from the compiled catalog'
      );
    end if;
    select relation.relrowsecurity, relation.relforcerowsecurity,
           policy.permissive, policy.cmd, policy.roles, policy.qual, policy.with_check
    into policy_row
    from pg_class as relation
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    join pg_policies as policy
      on policy.schemaname = namespace.nspname
     and policy.tablename = relation.relname
     and policy.policyname = 'kernel_tenant_isolation'
    where namespace.nspname = current_schema()
      and relation.relname = policy_table_name;
    normalized_expected := regexp_replace(lower(
      'app_id, customer_id = SELECT scope.app_id, scope.customer_id FROM SELECT current_setting(''kernel.app_id''::text, true) AS app_id, current_setting(''kernel.customer_id''::text, true) AS customer_id scope WHERE kernel_principal_scope_authorized(''any''::text, scope.app_id, scope.customer_id, NULL::text)' ||
      case
        when policy_table_name in (
          'change_set',
          'lookup_record', 'lookup_version', 'lookup_value_projection',
          'lookup_alias_projection', 'lookup_relation_projection'
        ) then ' AND kernel_policy_raw_table_access_allowed(CURRENT_USER, scope.app_id, scope.customer_id)'
        else ''
      end
    ), '[[:space:]()"]', '', 'g');
    normalized_actual := regexp_replace(lower(coalesce(policy_row.qual, '')), '[[:space:]()"]', '', 'g');
    if not found or not policy_row.relrowsecurity or not policy_row.relforcerowsecurity
      or policy_row.permissive <> 'PERMISSIVE' or policy_row.cmd <> 'ALL'
      or policy_row.roles <> '{public}'::name[]
      or normalized_actual <> normalized_expected
      or regexp_replace(lower(coalesce(policy_row.with_check, '')), '[[:space:]()"]', '', 'g') <> normalized_expected
    then
      return kernel_installer_schema_drift(
        policy_table_name || '.kernel_tenant_isolation',
        'RLS or tenant policy differs from the compiled catalog'
      );
    end if;
    if policy_table_name = 'schema_revision' then
      select policy.permissive, policy.cmd, policy.roles, policy.qual, policy.with_check
      into policy_row
      from pg_policies as policy
      where policy.schemaname = current_schema()
        and policy.tablename = 'schema_revision'
        and policy.policyname = 'kernel_schema_catalog_read';
      normalized_expected := regexp_replace(lower(
        'current_setting(''kernel.schema_catalog_read''::text, true) = ''on''::text AND kernel_principal_scope_authorized(''any''::text, app_id, customer_id, NULL::text)'
      ), '[[:space:]()"]', '', 'g');
      normalized_actual := regexp_replace(lower(coalesce(policy_row.qual, '')), '[[:space:]()"]', '', 'g');
      if not found or policy_row.permissive <> 'PERMISSIVE' or policy_row.cmd <> 'SELECT'
        or policy_row.roles <> '{public}'::name[]
        or normalized_actual <> normalized_expected
        or policy_row.with_check is not null
      then
        return kernel_installer_schema_drift(
          'schema_revision.kernel_schema_catalog_read',
          'catalog-read policy differs from the compiled catalog'
        );
      end if;
    end if;
  end loop;
  select relation.relrowsecurity, relation.relforcerowsecurity,
         policy.permissive, policy.cmd, policy.roles, policy.qual, policy.with_check
  into policy_row
  from pg_class as relation
  join pg_namespace as namespace on namespace.oid = relation.relnamespace
  join pg_policies as policy
    on policy.schemaname = namespace.nspname
   and policy.tablename = relation.relname
   and policy.policyname = 'kernel_app_catalog_isolation'
  where namespace.nspname = current_schema()
    and relation.relname = 'schema_constraint_identity_source';
  source_policy_found := found;
  select count(*) into policy_count
  from pg_policies as policy
  where policy.schemaname = current_schema()
    and policy.tablename = 'schema_constraint_identity_source';
  normalized_expected := regexp_replace(lower(
    'app_id = SELECT scope.app_id FROM SELECT current_setting(''kernel.app_id''::text, true) AS app_id, current_setting(''kernel.customer_id''::text, true) AS customer_id scope WHERE kernel_principal_scope_authorized(''any''::text, scope.app_id, scope.customer_id, NULL::text)'
  ), '[[:space:]()\"]', '', 'g');
  normalized_actual := regexp_replace(lower(coalesce(policy_row.qual, '')), '[[:space:]()\"]', '', 'g');
  if not source_policy_found or policy_count <> 1
    or not policy_row.relrowsecurity or not policy_row.relforcerowsecurity
    or policy_row.permissive <> 'PERMISSIVE' or policy_row.cmd <> 'ALL'
    or policy_row.roles <> '{public}'::name[]
    or normalized_actual <> normalized_expected
    or regexp_replace(lower(coalesce(policy_row.with_check, '')), '[[:space:]()\"]', '', 'g') <> normalized_expected
  then
    return kernel_installer_schema_drift(
      'schema_constraint_identity_source.kernel_app_catalog_isolation',
      'RLS or app catalog policy differs from the compiled catalog'
    );
  end if;
  for model_value in select value from jsonb_array_elements(expected_schema->'models')
  loop
    if coalesce(model_value->>'kind', 'entity') = 'lookup' then
      continue;
    end if;
    normalized_model := kernel_admin_normalize_identifier(model_value->>'id');
    foreach policy_table_name in array array[
      kernel_admin_bounded_identifier(normalized_model || '_record'),
      kernel_admin_bounded_identifier(normalized_model || '_version')
    ] loop
      if not exists (
        select 1 from pg_policies as policy
        where policy.schemaname = current_schema()
          and policy.tablename = policy_table_name
          and policy.policyname = 'kernel_tenant_isolation'
      ) then
        return kernel_installer_schema_drift(
          policy_table_name || '.kernel_tenant_isolation',
          'RLS or tenant policy differs from the compiled catalog'
        );
      end if;
      select count(*) into policy_count
      from pg_policies as policy
      where policy.schemaname = current_schema()
        and policy.tablename = policy_table_name;
      if policy_count <> 1 then
        return kernel_installer_schema_drift(
          policy_table_name || '.kernel_tenant_scope',
          'unexpected RLS policy differs from the compiled catalog'
        );
      end if;
      select relation.relrowsecurity, relation.relforcerowsecurity,
             policy.permissive, policy.cmd, policy.roles, policy.qual, policy.with_check
      into policy_row
      from pg_class as relation
      join pg_namespace as namespace on namespace.oid = relation.relnamespace
      join pg_policies as policy
        on policy.schemaname = namespace.nspname
       and policy.tablename = relation.relname
       and policy.policyname = 'kernel_tenant_isolation'
      where namespace.nspname = current_schema()
        and relation.relname = policy_table_name;
      normalized_expected := regexp_replace(lower(
        'app_id, customer_id = SELECT scope.app_id, scope.customer_id FROM SELECT current_setting(''kernel.app_id''::text, true) AS app_id, current_setting(''kernel.customer_id''::text, true) AS customer_id scope WHERE kernel_principal_scope_authorized(''any''::text, scope.app_id, scope.customer_id, NULL::text)' ||
        ' AND kernel_policy_raw_table_access_allowed(CURRENT_USER, scope.app_id, scope.customer_id)'
      ), '[[:space:]()"]', '', 'g');
      normalized_actual := regexp_replace(lower(coalesce(policy_row.qual, '')), '[[:space:]()"]', '', 'g');
      if not found or not policy_row.relrowsecurity or not policy_row.relforcerowsecurity
        or policy_row.permissive <> 'PERMISSIVE' or policy_row.cmd <> 'ALL'
        or policy_row.roles <> '{public}'::name[]
        or normalized_actual <> normalized_expected
        or regexp_replace(lower(coalesce(policy_row.with_check, '')), '[[:space:]()"]', '', 'g') <> normalized_expected
      then
        return kernel_installer_schema_drift(
          policy_table_name || '.kernel_tenant_isolation',
          'RLS or tenant policy differs from the compiled catalog'
        );
      end if;
    end loop;
  end loop;

  if to_regrole(query_role) is not null then
    select relation.relname
    into privileged_object
    from pg_class as relation
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = current_schema()
      and relation.relkind in ('r', 'p')
      and has_table_privilege(
        query_role,
        relation.oid,
        'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      )
    order by relation.relname
    limit 1;
    if found then
      return kernel_installer_schema_drift(
        privileged_object,
        'generated query role must not have direct table DML privileges'
      );
    end if;
    select relation.relname
    into privileged_object
    from pg_class as relation
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = current_schema()
      and case when relation.relkind = 'S'
        then has_sequence_privilege(query_role, relation.oid, 'USAGE,SELECT,UPDATE')
        else false
      end
    order by relation.relname
    limit 1;
    if found then
      return kernel_installer_schema_drift(
        privileged_object,
        'generated query role must not have direct sequence privileges'
      );
    end if;
  end if;

  foreach role_name in array array[
    execution_role, runtime_role, schema_admin_role, query_role
  ] loop
    select rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
    into role_row
    from pg_roles
    where rolname = role_name;
    if not found or role_row.rolcanlogin or role_row.rolsuper or role_row.rolcreatedb
      or role_row.rolcreaterole or role_row.rolreplication or role_row.rolbypassrls
    then
      return kernel_installer_schema_drift(
        role_name,
        'generated runtime role is missing or has unsafe attributes'
      );
    end if;
  end loop;

  foreach role_name in array array[runtime_role, schema_admin_role] loop
    -- These roles are NOLOGIN capabilities. CONNECT is checked for the login
    -- principal at connection startup and belongs to database provisioning,
    -- not the generated schema contract or its role-membership path.
    select relation.relname
    into privileged_object
    from pg_class as relation
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = current_schema()
      and relation.relkind in ('r', 'p')
      and has_table_privilege(
        role_name,
        relation.oid,
        'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      )
    order by relation.relname
    limit 1;
    if found then
      return kernel_installer_schema_drift(
        privileged_object,
        role_name || ' must not have direct table DML privileges'
      );
    end if;
    select relation.relname
    into privileged_object
    from pg_class as relation
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = current_schema()
      and case when relation.relkind = 'S'
        then has_sequence_privilege(role_name, relation.oid, 'USAGE,SELECT,UPDATE')
        else false
      end
    order by relation.relname
    limit 1;
    if found then
      return kernel_installer_schema_drift(
        privileged_object,
        role_name || ' must not have direct sequence privileges'
      );
    end if;
  end loop;

  select procedure.proname
  into privileged_object
  from pg_proc as procedure
  join pg_namespace as namespace on namespace.oid = procedure.pronamespace
  cross join lateral aclexplode(coalesce(
    procedure.proacl,
    acldefault('f', procedure.proowner)
  )) as privilege
  where namespace.nspname = current_schema()
    and procedure.proname like 'kernel\_%' escape '\'
    and privilege.grantee = 0
    and privilege.privilege_type = 'EXECUTE'
  order by procedure.proname
  limit 1;
  if found then
    return kernel_installer_schema_drift(
      privileged_object,
      'PUBLIC must not have execute privilege on generated kernel functions'
    );
  end if;

  policy_count := 0;
  for function_row in
    select procedure.oid, procedure.proname, procedure.prosecdef, procedure.proconfig,
           owner.rolname as owner_name, owner.rolcanlogin, owner.rolsuper,
           owner.rolcreatedb, owner.rolcreaterole, owner.rolreplication,
           owner.rolbypassrls
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    join pg_roles as owner on owner.oid = procedure.proowner
    where namespace.nspname = current_schema()
      and procedure.oid in (
        to_regprocedure(format('%I.kernel_apply_change_set(jsonb)', current_schema())),
        to_regprocedure(format('%I.kernel_dry_run_tenant_schema_revision(jsonb)', current_schema())),
        to_regprocedure(format('%I.kernel_commit_tenant_schema_revision(jsonb)', current_schema()))
      )
  loop
    policy_count := policy_count + 1;
    if not function_row.prosecdef
      or function_row.rolcanlogin or function_row.rolsuper
      or function_row.rolcreatedb or function_row.rolcreaterole
      or function_row.rolreplication or function_row.rolbypassrls
      or not function_row.proconfig @> array[
        format('search_path=%I, pg_catalog, pg_temp', current_schema())
      ]
    then
      return kernel_installer_schema_drift(
        function_row.proname,
        'generated entrypoint owner, security mode, or fixed search path differs from the compiled contract'
      );
    end if;
  end loop;
  if policy_count <> 3 then
    return kernel_installer_schema_drift(
      'generated_entrypoints',
      'required generated runtime or schema-admin entrypoint is missing'
    );
  end if;
  if has_function_privilege(
      runtime_role,
      to_regprocedure(format('%I.kernel_commit_tenant_schema_revision(jsonb)', current_schema())),
      'EXECUTE'
    )
    or has_function_privilege(
      runtime_role,
      to_regprocedure(format('%I.kernel_dry_run_tenant_schema_revision(jsonb)', current_schema())),
      'EXECUTE'
    )
    or not has_function_privilege(
      schema_admin_role,
      to_regprocedure(format('%I.kernel_commit_tenant_schema_revision(jsonb)', current_schema())),
      'EXECUTE'
    )
    or not has_function_privilege(
      schema_admin_role,
      to_regprocedure(format('%I.kernel_dry_run_tenant_schema_revision(jsonb)', current_schema())),
      'EXECUTE'
    )
  then
    return kernel_installer_schema_drift(
      'tenant_schema_revision',
      'tenant schema entrypoints require the distinct schema-specific schema-admin capability role'
    );
  end if;

  drift := kernel_constraint_identity_drift(expected_schema);
  if drift is not null then return drift; end if;

  select active_revision.base_schema, active_revision.schema,
         active_revision.customer_overlay, active_revision.schema_hash
  into active_base_schema, active_effective_schema, active_overlay, active_schema_hash
  from schema_revision as active_revision
  where active_revision.app_id = expected_schema->>'app_id'
    and active_revision.customer_id = expected_schema->>'customer_id'
    and active_revision.activated_at is not null;
  if not found then
    return jsonb_build_object('ok', true, 'data', false);
  end if;
  if active_schema_hash is distinct from expected_schema_hash then
    return kernel_admin_error('schema_revision_conflict', 'Schema revision already exists with different schema JSON', jsonb_build_array(
      jsonb_build_object('path', 'schema_revision.existing_schema_hash', 'code', 'schema_hash', 'message', coalesce(active_schema_hash, '')),
      jsonb_build_object('path', 'schema_revision.current_schema_hash', 'code', 'schema_hash', 'message', expected_schema_hash)
    ));
  end if;
  if active_base_schema = expected_schema then
    composed_schema := kernel_admin_apply_overlay(expected_schema, active_overlay);
    composed_schema := jsonb_set(
      composed_schema,
      '{version}',
      to_jsonb(active_effective_schema->>'version')
    );
    if composed_schema is distinct from active_effective_schema then
      return kernel_admin_error('schema_revision_conflict', 'Schema revision already exists with different schema JSON', jsonb_build_array(
        jsonb_build_object('path', 'schema_revision.existing_schema_hash', 'code', 'schema_hash', 'message', coalesce(active_schema_hash, kernel_admin_sha256(kernel_canonical_json(active_effective_schema)))),
        jsonb_build_object('path', 'schema_revision.current_schema_hash', 'code', 'schema_hash', 'message', kernel_admin_sha256(kernel_canonical_json(composed_schema)))
      ));
    end if;
  elsif active_effective_schema is distinct from expected_schema then
    return kernel_admin_error('schema_revision_conflict', 'Schema revision already exists with different schema JSON', jsonb_build_array(
      jsonb_build_object('path', 'schema_revision.existing_schema_hash', 'code', 'schema_hash', 'message', coalesce(active_schema_hash, kernel_admin_sha256(kernel_canonical_json(active_effective_schema)))),
      jsonb_build_object('path', 'schema_revision.current_schema_hash', 'code', 'schema_hash', 'message', expected_schema_hash)
    ));
  end if;
  drift := kernel_installer_materialized_assertions_drift(request);
  if drift is not null then
    return drift;
  end if;
  delegated_result := jsonb_build_object('ok', true, 'data', true);
  return delegated_result;
end;
$kernel$;
"#;

const KERNEL_SCHEMA_REVISION_IS_ACTIVE_WITH_MATERIALIZED_TABLES: &str = r#"
create or replace function kernel_schema_revision_is_active_with_materialized_tables(request jsonb)
returns jsonb
language plpgsql
volatile
parallel unsafe
security invoker
set search_path from current
as $kernel$
declare
  expected_schema jsonb := case when request ? 'schema' then request->'schema' else request end;
  expected_revision_id bigint;
  active_revision_id bigint;
  active_base_version text;
  active_schema_hash text;
  validation_request jsonb;
begin
  if jsonb_typeof(request) is distinct from 'object'
    or jsonb_typeof(expected_schema) is distinct from 'object'
    or coalesce(expected_schema->>'app_id', '') = ''
    or coalesce(expected_schema->>'customer_id', '') = ''
    or coalesce(expected_schema->>'version', '') = ''
    or jsonb_typeof(expected_schema->'models') is distinct from 'array'
  then
    return kernel_installer_error('contract_validation_failed', 'Contract validation failed', 'request', 'invalid_materialized_schema_request', 'schema identity and models are required');
  end if;
  if request ? 'expected_active_revision_id' then
    begin
      expected_revision_id := (request->>'expected_active_revision_id')::bigint;
    exception when others then
      return kernel_installer_error('contract_validation_failed', 'Contract validation failed', 'expected_active_revision_id', 'invalid_schema_revision_id', 'expected_active_revision_id must be a positive integer');
    end;
    if expected_revision_id <= 0 then
      return kernel_installer_error('contract_validation_failed', 'Contract validation failed', 'expected_active_revision_id', 'invalid_schema_revision_id', 'expected_active_revision_id must be a positive integer');
    end if;
  end if;

  perform set_config('kernel.app_id', expected_schema->>'app_id', true);
  perform set_config('kernel.customer_id', expected_schema->>'customer_id', true);
  select active_revision.id, active_revision.base_schema->>'version', active_revision.schema_hash
  into active_revision_id, active_base_version, active_schema_hash
  from schema_revision as active_revision
  where active_revision.app_id = expected_schema->>'app_id'
    and active_revision.customer_id = expected_schema->>'customer_id'
    and active_revision.activated_at is not null;
  if not found then
    return jsonb_build_object('ok', true, 'data', false);
  end if;
  if expected_revision_id is not null and expected_revision_id <> active_revision_id then
    return kernel_admin_error('stale_schema_revision', 'The supplied schema revision is not active', jsonb_build_array(jsonb_build_object(
      'path', 'schema_revision_id', 'code', 'stale_schema_revision',
      'message', format('Supplied schema_revision_id is %s; active schema_revision_id is %s', expected_revision_id, active_revision_id)
    )));
  end if;
  if active_base_version is distinct from expected_schema->>'version' then
    return jsonb_build_object('ok', true, 'data', false);
  end if;
  if nullif(request->>'expected_schema_hash', '') is not null
    and request->>'expected_schema_hash' is distinct from active_schema_hash
  then
    return kernel_admin_error('schema_revision_conflict', 'Schema revision already exists with different schema JSON', jsonb_build_array(
      jsonb_build_object('path', 'schema_revision.existing_schema_hash', 'code', 'schema_hash', 'message', coalesce(active_schema_hash, '')),
      jsonb_build_object('path', 'schema_revision.current_schema_hash', 'code', 'schema_hash', 'message', request->>'expected_schema_hash')
    ));
  end if;

  validation_request := request || jsonb_build_object(
    'schema', expected_schema,
    'expected_schema_hash', coalesce(
      active_schema_hash,
      kernel_admin_sha256(kernel_canonical_json(expected_schema))
    )
  );
  return kernel_validate_materialized_schema_revision(validation_request);
end;
$kernel$;
"#;

const KERNEL_LOOKUP_AWARE_ADMIN_MATERIALIZATION_ERROR: &str = r#"
create or replace function kernel_admin_materialization_error(expected_schema jsonb, active_row jsonb)
returns jsonb
language plpgsql
stable
parallel safe
security invoker
set search_path from current
as $kernel$
declare
  active_schema_hash text;
  validation_result jsonb;
begin
  perform set_config('kernel.app_id', expected_schema->>'app_id', true);
  perform set_config('kernel.customer_id', expected_schema->>'customer_id', true);
  select revision.schema_hash
  into active_schema_hash
  from schema_revision as revision
  where revision.app_id = expected_schema->>'app_id'
    and revision.customer_id = expected_schema->>'customer_id'
    and revision.activated_at is not null;
  active_schema_hash := coalesce(
    active_schema_hash,
    kernel_admin_sha256(kernel_canonical_json(expected_schema))
  );
  validation_result := kernel_validate_materialized_schema_revision(
    coalesce(active_row, '{}'::jsonb) || jsonb_build_object(
      'schema', expected_schema,
      'expected_schema_hash', active_schema_hash
    )
  );
  if coalesce((validation_result->>'ok')::boolean, false)
    and validation_result->'data' = 'true'::jsonb
  then
    return null;
  end if;
  return validation_result;
end;
$kernel$;
"#;

const KERNEL_REPAIR_MATERIALIZED_SCHEMA_REVISION: &str = r#"
create or replace function kernel_repair_materialized_schema_revision(request jsonb)
returns jsonb
language plpgsql
volatile
parallel unsafe
security invoker
set search_path from current
as $kernel$
<<installer_catalog_repair>>
declare
  expected_schema jsonb := case when request ? 'schema' then request->'schema' else request end;
  expected_schema_hash text := request->>'expected_schema_hash';
  app_id text := expected_schema->>'app_id';
  customer_id text := expected_schema->>'customer_id';
  active_revision_id bigint;
  active_base_schema jsonb;
  active_schema jsonb;
  normalized_base_schema jsonb;
  normalized_active_schema jsonb;
  model_value jsonb;
  normalized_model text;
  retained_scope record;
  previous_catalog_read text := current_setting('kernel.schema_catalog_read', true);
  record_table_name text;
  version_table_name text;
  legacy_index_name text;
  lookup_index_name text;
  source_ref_index_name text;
  change_set_index_name text;
  value_index_name text;
  lifecycle_index_name text;
  draft_index_name text;
  external_key_index_name text;
  table_name text;
  policy_name text;
  constraint_name text;
  competing_trigger_name text;
  lookup_keys_need_repair boolean;
  query_role text := kernel_installer_capability_role('query');
begin
  if jsonb_typeof(request) is distinct from 'object'
    or jsonb_typeof(expected_schema) is distinct from 'object'
    or coalesce(app_id, '') = ''
    or coalesce(customer_id, '') = ''
    or jsonb_typeof(expected_schema->'models') is distinct from 'array'
    or not kernel_installer_valid_hash(expected_schema_hash)
  then
    return kernel_installer_error('contract_validation_failed', 'Contract validation failed', 'request', 'invalid_materialized_schema_request', 'schema identity, models, and expected_schema_hash are required');
  end if;

  perform pg_advisory_xact_lock(hashtext(query_role)::bigint);
  perform set_config('kernel.app_id', app_id, true);
  perform set_config('kernel.customer_id', customer_id, true);
  perform kernel_installer_lock_app(app_id, true);
  perform kernel_installer_lock_tenant(app_id, customer_id);
  perform pg_advisory_xact_lock(hashtextextended(
    current_database() || ':' || current_schema() || ':kernel_lookup_substrate',
    0
  ));
  perform kernel_installer_repair_schema_revision_policies();
  select id, base_schema, schema
  into active_revision_id, active_base_schema, active_schema
  from schema_revision as active_revision
  where active_revision.app_id = installer_catalog_repair.app_id
    and active_revision.customer_id = installer_catalog_repair.customer_id
    and active_revision.activated_at is not null
  for update;
  if not found then
    return kernel_installer_error('active_schema_missing', 'No active schema revision exists for this scope', 'scope', 'active_schema_missing', app_id || '/' || customer_id || ': materialize a schema before validation or repair');
  end if;

  normalized_base_schema := kernel_installer_default_model_kind(active_base_schema);
  normalized_active_schema := kernel_installer_default_model_kind(active_schema);
  if active_base_schema is distinct from normalized_base_schema
    and normalized_base_schema = expected_schema
    and normalized_active_schema = expected_schema
  then
    update schema_revision
    set base_schema = expected_schema,
        schema = expected_schema,
        schema_hash = expected_schema_hash
    where id = active_revision_id;
  end if;

  if to_regclass(format('%I.%I', current_schema(), 'change_set_lifecycle_order_seq')) is null then
    return kernel_installer_schema_drift('change_set_lifecycle_order_seq', 'required materialized sequence is missing');
  end if;

  select trigger_value.tgname
  into competing_trigger_name
  from pg_trigger as trigger_value
  where trigger_value.tgrelid = to_regclass(format('%I.%I', current_schema(), 'schema_revision'))
    and not trigger_value.tgisinternal
    and trigger_value.tgname <> 'schema_revision_activation_head'
    and (trigger_value.tgtype & 1) = 1
    and (trigger_value.tgtype & 2) = 2
    and ((trigger_value.tgtype & 4) = 4 or (trigger_value.tgtype & 16) = 16)
  order by trigger_value.tgname
  limit 1;
  if found then
    return kernel_installer_schema_drift(
      'schema_revision.' || competing_trigger_name,
      'competing BEFORE ROW INSERT/UPDATE trigger could mutate the revision after the activation-head check'
    );
  end if;
  execute format(
    'drop trigger if exists schema_revision_activation_head on %I.schema_revision',
    current_schema()
  );
  execute format(
    'create trigger schema_revision_activation_head before insert or update of activated_at, base_schema on %I.schema_revision for each row execute function kernel_enforce_schema_activation_head()',
    current_schema()
  );

  foreach table_name in array array[
    'lookup_record', 'lookup_version', 'lookup_value_projection',
    'lookup_alias_projection', 'lookup_relation_projection'
  ] loop
    if to_regclass(format('%I.%I', current_schema(), table_name)) is null then
      return kernel_installer_schema_drift(
        table_name,
        'required shared lookup table is missing'
      );
    end if;
  end loop;

  lookup_keys_need_repair :=
    kernel_installer_primary_key_drift(
      'lookup_version', 'lookup_version_pkey',
      array['app_id', 'customer_id', 'model_id', 'id']
    ) is not null
    or kernel_installer_primary_key_drift(
      'lookup_value_projection', 'lookup_value_projection_pkey',
      array['app_id', 'customer_id', 'model_id', 'version_id', 'field_id']
    ) is not null
    or kernel_installer_primary_key_drift(
      'lookup_alias_projection', 'lookup_alias_projection_pkey',
      array['app_id', 'customer_id', 'model_id', 'version_id', 'field_id', 'kind', 'ordinal']
    ) is not null
    or kernel_installer_primary_key_drift(
      'lookup_relation_projection', 'lookup_relation_projection_pkey',
      array['app_id', 'customer_id', 'source_model_id', 'version_id', 'field_id', 'ordinal']
    ) is not null
    or kernel_installer_fk_drift(
      'lookup_value_projection', 'lookup_value_projection_version_fk',
      array['app_id', 'customer_id', 'model_id', 'version_id'],
      'lookup_version', array['app_id', 'customer_id', 'model_id', 'id']
    ) is not null
    or kernel_installer_fk_drift(
      'lookup_alias_projection', 'lookup_alias_projection_version_fk',
      array['app_id', 'customer_id', 'model_id', 'version_id'],
      'lookup_version', array['app_id', 'customer_id', 'model_id', 'id']
    ) is not null
    or kernel_installer_fk_drift(
      'lookup_relation_projection', 'lookup_relation_projection_version_fk',
      array['app_id', 'customer_id', 'source_model_id', 'version_id'],
      'lookup_version', array['app_id', 'customer_id', 'model_id', 'id']
    ) is not null;

  if lookup_keys_need_repair then
    foreach table_name in array array[
      'lookup_value_projection', 'lookup_alias_projection', 'lookup_relation_projection'
    ] loop
      execute format(
        'alter table %I.%I drop constraint if exists %I',
        current_schema(), table_name, table_name || '_version_fk'
      );
    end loop;

    if kernel_installer_primary_key_drift(
      'lookup_value_projection', 'lookup_value_projection_pkey',
      array['app_id', 'customer_id', 'model_id', 'version_id', 'field_id']
    ) is not null then
      execute format('alter table %I.lookup_value_projection drop constraint if exists lookup_value_projection_pkey', current_schema());
      execute format('alter table %I.lookup_value_projection add constraint lookup_value_projection_pkey primary key (app_id, customer_id, model_id, version_id, field_id)', current_schema());
    end if;
    if kernel_installer_primary_key_drift(
      'lookup_alias_projection', 'lookup_alias_projection_pkey',
      array['app_id', 'customer_id', 'model_id', 'version_id', 'field_id', 'kind', 'ordinal']
    ) is not null then
      execute format('alter table %I.lookup_alias_projection drop constraint if exists lookup_alias_projection_pkey', current_schema());
      execute format('alter table %I.lookup_alias_projection add constraint lookup_alias_projection_pkey primary key (app_id, customer_id, model_id, version_id, field_id, kind, ordinal)', current_schema());
    end if;
    if kernel_installer_primary_key_drift(
      'lookup_relation_projection', 'lookup_relation_projection_pkey',
      array['app_id', 'customer_id', 'source_model_id', 'version_id', 'field_id', 'ordinal']
    ) is not null then
      execute format('alter table %I.lookup_relation_projection drop constraint if exists lookup_relation_projection_pkey', current_schema());
      execute format('alter table %I.lookup_relation_projection add constraint lookup_relation_projection_pkey primary key (app_id, customer_id, source_model_id, version_id, field_id, ordinal)', current_schema());
    end if;
    if kernel_installer_primary_key_drift(
      'lookup_version', 'lookup_version_pkey',
      array['app_id', 'customer_id', 'model_id', 'id']
    ) is not null then
      execute format('alter table %I.lookup_version drop constraint if exists lookup_version_pkey', current_schema());
      execute format('alter table %I.lookup_version add constraint lookup_version_pkey primary key (app_id, customer_id, model_id, id)', current_schema());
    end if;

    execute format('alter table %I.lookup_value_projection add constraint lookup_value_projection_version_fk foreign key (app_id, customer_id, model_id, version_id) references %I.lookup_version (app_id, customer_id, model_id, id) not valid', current_schema(), current_schema());
    execute format('alter table %I.lookup_alias_projection add constraint lookup_alias_projection_version_fk foreign key (app_id, customer_id, model_id, version_id) references %I.lookup_version (app_id, customer_id, model_id, id) not valid', current_schema(), current_schema());
    execute format('alter table %I.lookup_relation_projection add constraint lookup_relation_projection_version_fk foreign key (app_id, customer_id, source_model_id, version_id) references %I.lookup_version (app_id, customer_id, model_id, id) not valid', current_schema(), current_schema());
    foreach table_name in array array[
      'lookup_value_projection', 'lookup_alias_projection', 'lookup_relation_projection'
    ] loop
      execute format(
        'alter table %I.%I validate constraint %I',
        current_schema(), table_name, table_name || '_version_fk'
      );
    end loop;
  end if;

  foreach table_name in array array[
    'lookup_record', 'lookup_version', 'lookup_value_projection',
    'lookup_alias_projection', 'lookup_relation_projection'
  ] loop
    execute format('alter table %I.%I enable row level security', current_schema(), table_name);
    execute format('alter table %I.%I force row level security', current_schema(), table_name);
    for policy_name in
      select policy.policyname
      from pg_policies as policy
      where policy.schemaname = current_schema()
        and policy.tablename = installer_catalog_repair.table_name
        and policy.policyname <> 'kernel_tenant_isolation'
      order by policy.policyname
    loop
      execute format('drop policy %I on %I.%I', policy_name, current_schema(), table_name);
    end loop;
    if exists (
      select 1 from pg_policies as policy
      where policy.schemaname = current_schema()
        and policy.tablename = installer_catalog_repair.table_name
        and policy.policyname = 'kernel_tenant_isolation'
    ) then
      execute format(
        'alter policy kernel_tenant_isolation on %I.%I using ((app_id, customer_id) = (select scope.app_id, scope.customer_id from (select current_setting(''kernel.app_id'', true) app_id, current_setting(''kernel.customer_id'', true) customer_id) scope where kernel_principal_scope_authorized(''any'', scope.app_id, scope.customer_id, null) and kernel_policy_raw_table_access_allowed(current_user::name, scope.app_id, scope.customer_id))) with check ((app_id, customer_id) = (select scope.app_id, scope.customer_id from (select current_setting(''kernel.app_id'', true) app_id, current_setting(''kernel.customer_id'', true) customer_id) scope where kernel_principal_scope_authorized(''any'', scope.app_id, scope.customer_id, null) and kernel_policy_raw_table_access_allowed(current_user::name, scope.app_id, scope.customer_id)))',
        current_schema(), table_name
      );
    else
      execute format(
        'create policy kernel_tenant_isolation on %I.%I using ((app_id, customer_id) = (select scope.app_id, scope.customer_id from (select current_setting(''kernel.app_id'', true) app_id, current_setting(''kernel.customer_id'', true) customer_id) scope where kernel_principal_scope_authorized(''any'', scope.app_id, scope.customer_id, null) and kernel_policy_raw_table_access_allowed(current_user::name, scope.app_id, scope.customer_id))) with check ((app_id, customer_id) = (select scope.app_id, scope.customer_id from (select current_setting(''kernel.app_id'', true) app_id, current_setting(''kernel.customer_id'', true) customer_id) scope where kernel_principal_scope_authorized(''any'', scope.app_id, scope.customer_id, null) and kernel_policy_raw_table_access_allowed(current_user::name, scope.app_id, scope.customer_id)))',
        current_schema(), table_name
      );
    end if;
    for constraint_name in
      select constraint_value.conname
      from pg_constraint as constraint_value
      where constraint_value.conrelid = to_regclass(
          format('%I.%I', current_schema(), installer_catalog_repair.table_name)
        )
        and constraint_value.contype in ('c', 'f')
        and not constraint_value.convalidated
      order by constraint_value.conname
    loop
      execute format(
        'alter table %I.%I validate constraint %I',
        current_schema(), table_name, constraint_name
      );
    end loop;
  end loop;

  execute format(
    'create unique index if not exists lookup_record_external_key_idx on %I.lookup_record (app_id, customer_id, model_id, external_key) where external_key is not null',
    current_schema()
  );
  execute format(
    'create index if not exists lookup_version_lookup_idx on %I.lookup_version (app_id, customer_id, model_id, record_id, stage, effective_start desc)',
    current_schema()
  );
  execute format(
    'create index if not exists lookup_version_change_set_idx on %I.lookup_version (app_id, customer_id, change_set_id, model_id)',
    current_schema()
  );
  execute format(
    'create unique index if not exists lookup_version_change_set_value_once_idx on %I.lookup_version (app_id, customer_id, model_id, record_id, effective_start, change_set_id) where not tombstones_record and not untombstones_record',
    current_schema()
  );
  execute format(
    'create unique index if not exists lookup_version_mainline_lifecycle_once_idx on %I.lookup_version (app_id, customer_id, model_id, record_id, effective_start, tombstones_record, untombstones_record) where stage = ''mainline'' and (tombstones_record or untombstones_record)',
    current_schema()
  );
  execute format(
    'create index if not exists lookup_version_draft_idx on %I.lookup_version (app_id, customer_id, model_id, record_id, effective_start desc) where stage = ''draft''',
    current_schema()
  );
  execute format(
    'create index if not exists lookup_value_projection_text_idx on %I.lookup_value_projection (app_id, customer_id, model_id, field_id, text_value, record_id)',
    current_schema()
  );
  execute format(
    'create index if not exists lookup_value_projection_number_idx on %I.lookup_value_projection (app_id, customer_id, model_id, field_id, number_value, record_id) where number_value is not null',
    current_schema()
  );
  execute format(
    'create index if not exists lookup_value_projection_bool_idx on %I.lookup_value_projection (app_id, customer_id, model_id, field_id, bool_value, record_id) where bool_value is not null',
    current_schema()
  );
  execute format(
    'create index if not exists lookup_value_projection_date_idx on %I.lookup_value_projection (app_id, customer_id, model_id, field_id, date_value, record_id) where date_value is not null',
    current_schema()
  );
  execute format(
    'create index if not exists lookup_alias_projection_match_idx on %I.lookup_alias_projection (app_id, customer_id, model_id, normalized_alias, record_id) where is_current',
    current_schema()
  );
  execute format(
    'create index if not exists lookup_alias_projection_record_idx on %I.lookup_alias_projection (app_id, customer_id, model_id, record_id) where is_current',
    current_schema()
  );
  execute format(
    'create index if not exists lookup_alias_projection_display_page_idx on %I.lookup_alias_projection (app_id, customer_id, model_id, normalized_alias, record_id, version_id) where kind = ''display''',
    current_schema()
  );
  execute format(
    'create unique index if not exists lookup_alias_projection_active_unique_idx on %I.lookup_alias_projection (app_id, customer_id, model_id, normalized_alias) where is_current',
    current_schema()
  );
  execute format(
    'create index if not exists lookup_relation_projection_target_idx on %I.lookup_relation_projection (app_id, customer_id, target_model_id, target_record_id, source_model_id, source_record_id)',
    current_schema()
  );

  if to_regrole(query_role) is not null then
    execute format('revoke all privileges on all tables in schema %I from %I', current_schema(), query_role);
    execute format('revoke all privileges on all sequences in schema %I from %I', current_schema(), query_role);
  end if;

  -- Foreign-key validation scans the shared physical table, not just the
  -- requested tenant. Enumerate retained scopes through the authorized schema
  -- catalog policy, then recover value-free identities under each scope's RLS.
  -- No history, values, lookup authority, or tenant revision is rewritten.
  perform set_config('kernel.schema_catalog_read', 'on', true);
  for retained_scope in
    select distinct revision.app_id, revision.customer_id
    from schema_revision as revision
    order by revision.app_id, revision.customer_id
  loop
    perform kernel_reconcile_lookup_foreign_key_targets(
      retained_scope.app_id, retained_scope.customer_id
    );
  end loop;
  perform set_config('kernel.schema_catalog_read', coalesce(previous_catalog_read, ''), true);
  perform set_config('kernel.app_id', app_id, true);
  perform set_config('kernel.customer_id', customer_id, true);
  for model_value in
    select value from jsonb_array_elements(expected_schema->'models')
  loop
    normalized_model := kernel_admin_normalize_identifier(model_value->>'id');
    if coalesce(model_value->>'kind', 'entity') = 'lookup' then
      continue;
    end if;
    record_table_name := kernel_admin_bounded_identifier(normalized_model || '_record');
    version_table_name := kernel_admin_bounded_identifier(normalized_model || '_version');
    if to_regclass(format('%I.%I', current_schema(), record_table_name)) is null then
      return kernel_installer_schema_drift(record_table_name, 'required materialized table is missing');
    end if;
    if to_regclass(format('%I.%I', current_schema(), version_table_name)) is null then
      return kernel_installer_schema_drift(version_table_name, 'required materialized table is missing');
    end if;

    external_key_index_name := kernel_admin_bounded_identifier(record_table_name || '_external_key_idx');
    lookup_index_name := kernel_admin_bounded_identifier(version_table_name || '_lookup_idx');
    source_ref_index_name := kernel_admin_bounded_identifier(version_table_name || '_source_record_ref_idx');
    change_set_index_name := kernel_admin_bounded_identifier(version_table_name || '_change_set_idx');
    value_index_name := kernel_admin_bounded_identifier(version_table_name || '_change_set_value_once_idx');
    lifecycle_index_name := kernel_admin_bounded_identifier(version_table_name || '_mainline_lifecycle_once_idx');
    draft_index_name := kernel_admin_bounded_identifier(version_table_name || '_draft_idx');
    legacy_index_name := kernel_admin_bounded_identifier(version_table_name || '_mainline_unique_idx');

    execute format('drop index if exists %I.%I', current_schema(), legacy_index_name);
    execute format(
      'create unique index if not exists %I on %I.%I (app_id, customer_id, external_key) where external_key is not null',
      external_key_index_name, current_schema(), record_table_name
    );
    execute format(
      'create index if not exists %I on %I.%I (record_id, stage, effective_start desc)',
      lookup_index_name, current_schema(), version_table_name
    );
    execute format(
      'create index if not exists %I on %I.%I (app_id, customer_id, (provenance->>''source_record_ref'')) where provenance ? ''source_record_ref''',
      source_ref_index_name, current_schema(), version_table_name
    );
    execute format(
      'create index if not exists %I on %I.%I (change_set_id)',
      change_set_index_name, current_schema(), version_table_name
    );
    execute format(
      'create unique index if not exists %I on %I.%I (record_id, effective_start, change_set_id) where not tombstones_record and not untombstones_record',
      value_index_name, current_schema(), version_table_name
    );
    execute format(
      'create unique index if not exists %I on %I.%I (record_id, effective_start, tombstones_record, untombstones_record) where stage = ''mainline'' and (tombstones_record or untombstones_record)',
      lifecycle_index_name, current_schema(), version_table_name
    );
    execute format(
      'create index if not exists %I on %I.%I (app_id, customer_id, record_id, effective_start desc) where stage = ''draft''',
      draft_index_name, current_schema(), version_table_name
    );

    foreach table_name in array array[record_table_name, version_table_name]
    loop
      execute format('alter table %I.%I enable row level security', current_schema(), table_name);
      execute format('alter table %I.%I force row level security', current_schema(), table_name);
      for policy_name in
        select policy.policyname
        from pg_policies as policy
        where policy.schemaname = current_schema()
          and policy.tablename = installer_catalog_repair.table_name
          and policy.policyname <> 'kernel_tenant_isolation'
        order by policy.policyname
      loop
        execute format('drop policy %I on %I.%I', policy_name, current_schema(), table_name);
      end loop;
      if exists (
        select 1 from pg_policies as policy
        where policy.schemaname = current_schema()
          and policy.tablename = installer_catalog_repair.table_name
          and policy.policyname = 'kernel_tenant_isolation'
      ) then
        execute format(
          'alter policy kernel_tenant_isolation on %I.%I using ((app_id, customer_id) = (select scope.app_id, scope.customer_id from (select current_setting(''kernel.app_id'', true) app_id, current_setting(''kernel.customer_id'', true) customer_id) scope where kernel_principal_scope_authorized(''any'', scope.app_id, scope.customer_id, null) and kernel_policy_raw_table_access_allowed(current_user::name, scope.app_id, scope.customer_id))) with check ((app_id, customer_id) = (select scope.app_id, scope.customer_id from (select current_setting(''kernel.app_id'', true) app_id, current_setting(''kernel.customer_id'', true) customer_id) scope where kernel_principal_scope_authorized(''any'', scope.app_id, scope.customer_id, null) and kernel_policy_raw_table_access_allowed(current_user::name, scope.app_id, scope.customer_id)))',
          current_schema(), table_name
        );
      else
        execute format(
          'create policy kernel_tenant_isolation on %I.%I using ((app_id, customer_id) = (select scope.app_id, scope.customer_id from (select current_setting(''kernel.app_id'', true) app_id, current_setting(''kernel.customer_id'', true) customer_id) scope where kernel_principal_scope_authorized(''any'', scope.app_id, scope.customer_id, null) and kernel_policy_raw_table_access_allowed(current_user::name, scope.app_id, scope.customer_id))) with check ((app_id, customer_id) = (select scope.app_id, scope.customer_id from (select current_setting(''kernel.app_id'', true) app_id, current_setting(''kernel.customer_id'', true) customer_id) scope where kernel_principal_scope_authorized(''any'', scope.app_id, scope.customer_id, null) and kernel_policy_raw_table_access_allowed(current_user::name, scope.app_id, scope.customer_id)))',
          current_schema(), table_name
        );
      end if;
      for constraint_name in
        select constraint_value.conname
        from pg_constraint as constraint_value
        where constraint_value.conrelid = to_regclass(
            format('%I.%I', current_schema(), installer_catalog_repair.table_name)
          )
          and constraint_value.contype in ('c', 'f')
          and not constraint_value.convalidated
        order by constraint_value.conname
      loop
        execute format(
          'alter table %I.%I validate constraint %I',
          current_schema(), table_name, constraint_name
        );
      end loop;
    end loop;
  end loop;

  execute format('alter table %I.change_set enable row level security', current_schema());
  execute format('alter table %I.change_set force row level security', current_schema());
  if exists (
    select 1
    from pg_policies
    where schemaname = current_schema()
      and tablename = 'change_set'
      and policyname = 'kernel_tenant_isolation'
  ) then
    execute format(
      'alter policy kernel_tenant_isolation on %I.change_set using ((app_id, customer_id) = (select scope.app_id, scope.customer_id from (select current_setting(''kernel.app_id'', true) app_id, current_setting(''kernel.customer_id'', true) customer_id) scope where kernel_principal_scope_authorized(''any'', scope.app_id, scope.customer_id, null) and kernel_policy_raw_table_access_allowed(current_user::name, scope.app_id, scope.customer_id))) with check ((app_id, customer_id) = (select scope.app_id, scope.customer_id from (select current_setting(''kernel.app_id'', true) app_id, current_setting(''kernel.customer_id'', true) customer_id) scope where kernel_principal_scope_authorized(''any'', scope.app_id, scope.customer_id, null) and kernel_policy_raw_table_access_allowed(current_user::name, scope.app_id, scope.customer_id)))',
      current_schema()
    );
  else
    execute format(
      'create policy kernel_tenant_isolation on %I.change_set using ((app_id, customer_id) = (select scope.app_id, scope.customer_id from (select current_setting(''kernel.app_id'', true) app_id, current_setting(''kernel.customer_id'', true) customer_id) scope where kernel_principal_scope_authorized(''any'', scope.app_id, scope.customer_id, null) and kernel_policy_raw_table_access_allowed(current_user::name, scope.app_id, scope.customer_id))) with check ((app_id, customer_id) = (select scope.app_id, scope.customer_id from (select current_setting(''kernel.app_id'', true) app_id, current_setting(''kernel.customer_id'', true) customer_id) scope where kernel_principal_scope_authorized(''any'', scope.app_id, scope.customer_id, null) and kernel_policy_raw_table_access_allowed(current_user::name, scope.app_id, scope.customer_id)))',
      current_schema()
    );
  end if;

  if to_regclass(format('%I.%I', current_schema(), 'agent_run')) is not null then
    if not exists (
      select 1 from pg_constraint as constraint_value
      join pg_class as relation on relation.oid = constraint_value.conrelid
      join pg_namespace as namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = current_schema()
        and relation.relname = 'agent_run'
        and constraint_value.conname = 'agent_run_status_check'
    ) then
      execute format(
        'alter table %I.agent_run add constraint agent_run_status_check check (status in (''recorded'',''completed'',''validation_exhausted'',''budget_exhausted'',''runtime_error'',''cancelled'')) not valid',
        current_schema()
      );
      execute format('alter table %I.agent_run validate constraint agent_run_status_check', current_schema());
    end if;
    if not exists (
      select 1 from pg_constraint as constraint_value
      join pg_class as relation on relation.oid = constraint_value.conrelid
      join pg_namespace as namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = current_schema()
        and relation.relname = 'agent_run'
        and constraint_value.conname = 'agent_run_schema_revision_tenant_fk'
    ) then
      execute format(
        'alter table %I.agent_run add constraint agent_run_schema_revision_tenant_fk foreign key (schema_revision_id, app_id, customer_id) references %I.schema_revision(id, app_id, customer_id) not valid',
        current_schema(), current_schema()
      );
      execute format('alter table %I.agent_run validate constraint agent_run_schema_revision_tenant_fk', current_schema());
    end if;
    execute format(
      'create unique index if not exists agent_run_tenant_id_idx on %I.agent_run (id, app_id, customer_id)',
      current_schema()
    );
    execute format('alter table %I.agent_run enable row level security', current_schema());
    execute format('alter table %I.agent_run force row level security', current_schema());
    for policy_name in
      select policy.policyname
      from pg_policies as policy
      where policy.schemaname = current_schema()
        and policy.tablename = 'agent_run'
        and policy.policyname <> 'kernel_tenant_isolation'
      order by policy.policyname
    loop
      execute format('drop policy %I on %I.agent_run', policy_name, current_schema());
    end loop;
    if exists (
      select 1 from pg_policies
      where schemaname = current_schema()
        and tablename = 'agent_run'
        and policyname = 'kernel_tenant_isolation'
    ) then
      execute format(
        'alter policy kernel_tenant_isolation on %I.agent_run using ((app_id, customer_id) = (select scope.app_id, scope.customer_id from (select current_setting(''kernel.app_id'', true) app_id, current_setting(''kernel.customer_id'', true) customer_id) scope where kernel_principal_scope_authorized(''any'', scope.app_id, scope.customer_id, null))) with check ((app_id, customer_id) = (select scope.app_id, scope.customer_id from (select current_setting(''kernel.app_id'', true) app_id, current_setting(''kernel.customer_id'', true) customer_id) scope where kernel_principal_scope_authorized(''any'', scope.app_id, scope.customer_id, null)))',
        current_schema()
      );
    else
      execute format(
        'create policy kernel_tenant_isolation on %I.agent_run using ((app_id, customer_id) = (select scope.app_id, scope.customer_id from (select current_setting(''kernel.app_id'', true) app_id, current_setting(''kernel.customer_id'', true) customer_id) scope where kernel_principal_scope_authorized(''any'', scope.app_id, scope.customer_id, null))) with check ((app_id, customer_id) = (select scope.app_id, scope.customer_id from (select current_setting(''kernel.app_id'', true) app_id, current_setting(''kernel.customer_id'', true) customer_id) scope where kernel_principal_scope_authorized(''any'', scope.app_id, scope.customer_id, null)))',
        current_schema()
      );
    end if;
  end if;

  foreach table_name in array array[
    'schema_revision', 'schema_activation_head', 'change_set', 'agent_run'
  ] loop
    if to_regclass(format('%I.%I', current_schema(), table_name)) is not null then
      for constraint_name in
        select constraint_value.conname
        from pg_constraint as constraint_value
        where constraint_value.conrelid = to_regclass(
            format('%I.%I', current_schema(), installer_catalog_repair.table_name)
          )
          and constraint_value.contype in ('c', 'f')
          and not constraint_value.convalidated
        order by constraint_value.conname
      loop
        execute format(
          'alter table %I.%I validate constraint %I',
          current_schema(), table_name, constraint_name
        );
      end loop;
    end if;
  end loop;

  perform kernel_install_runtime_privileges();
  return kernel_validate_materialized_schema_revision(request);
end;
$kernel$;
"#;

const KERNEL_ACTIVATE_TENANT_SCHEMA_REVISION: &str = r#"
create or replace function kernel_activate_tenant_schema_revision(request jsonb)
returns jsonb
language plpgsql
volatile
parallel unsafe
security invoker
set search_path from current
as $kernel$
<<installer_tenant_activation>>
declare
  app_id text := request->>'app_id';
  customer_id text := request->>'customer_id';
  schema_revision_id bigint;
  effective_artifact_hash text := request->>'effective_artifact_hash';
  expected_hash text := request->>'expected_active_effective_hash';
  prepared record;
  active_revision_id bigint;
  active_effective_hash text;
  seed_result jsonb;
  model_json jsonb;
  model_id text;
  has_typed_history boolean;
  interval_violation jsonb;
begin
  begin
    schema_revision_id := (request->>'schema_revision_id')::bigint;
  exception when others then
    return kernel_installer_error('contract_validation_failed', 'Contract validation failed', 'schema_revision_id', 'invalid_schema_revision_id', 'schema_revision_id must be a positive integer');
  end;
  if coalesce(schema_revision_id, 0) <= 0 or coalesce(app_id, '') = '' or coalesce(customer_id, '') = ''
    or not kernel_installer_valid_hash(effective_artifact_hash)
    or not request ? 'expected_active_effective_hash'
    or (expected_hash is not null and not kernel_installer_valid_hash(expected_hash))
  then
    return kernel_installer_error('contract_validation_failed', 'Contract validation failed', 'request', 'invalid_activation_request', 'scope, revision id, effective hash, and expected active hash are required');
  end if;

  perform set_config('kernel.app_id', app_id, true);
  perform set_config('kernel.customer_id', customer_id, true);
  perform kernel_installer_lock_app(app_id, false);
  perform kernel_installer_lock_tenant(app_id, customer_id);
  select sir.*, sr.activated_at, sr.base_schema->>'version' as base_schema_version,
         sr.schema as schema_json, sr.schema_hash as schema_hash
  into prepared
  from schema_installation_revision sir
  join schema_revision sr on sr.id = sir.schema_revision_id
  where sir.schema_revision_id = installer_tenant_activation.schema_revision_id
    and sir.app_id = installer_tenant_activation.app_id
    and sir.customer_id = installer_tenant_activation.customer_id
  for update of sir, sr;
  if not found then
    return kernel_installer_error('schema_revision_missing', 'Schema revision not found', 'schema_revision_id', 'unknown_schema_revision', 'the prepared schema revision does not exist in this tenant scope');
  end if;
  if prepared.activation_kind <> 'tenant_overlay' then
    return kernel_installer_error('activation_mode_mismatch', 'Activation mode mismatch', 'activation_kind', 'app_base_requires_group_activation', 'app-base revisions must use all-target activation');
  end if;
  if prepared.effective_artifact_hash is distinct from effective_artifact_hash
    or prepared.expected_active_effective_hash is distinct from expected_hash
  then
    return kernel_installer_error('schema_revision_conflict', 'Schema revision conflict', 'hashes', 'prepared_hash_mismatch', 'activation hashes do not match the prepared revision');
  end if;
  if prepared.activated_at is not null then
    return jsonb_build_object('ok', true, 'data', jsonb_build_object(
      'activation_kind', 'tenant_overlay', 'app_id', app_id, 'customer_id', customer_id,
      'schema_revision_id', schema_revision_id, 'effective_artifact_hash', effective_artifact_hash,
      'state', 'active', 'idempotent', true
    ));
  end if;
  if prepared.ready_at is null then
    return kernel_installer_error('schema_revision_not_ready', 'Schema revision is not ready', 'schema_revision_id', 'readiness_required', 'the prepared revision must pass readiness validation before activation');
  end if;
  -- Re-validate interval rules under the tenant activation lock so no write
  -- admitted after readiness can activate an overlapping state.
  interval_violation := coalesce(
    kernel_constraint_interval_isolation_error(app_id, customer_id, schema_revision_id, null),
    kernel_constraint_interval_violation(app_id, customer_id, schema_revision_id, null)
  );
  if interval_violation is not null then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'schema_revision_not_ready',
      'message', 'Schema revision is not ready',
      'details', interval_violation->'details'
    ));
  end if;

  select sr.id, sir.effective_artifact_hash
  into active_revision_id, active_effective_hash
  from schema_revision sr
  left join schema_installation_revision sir on sir.schema_revision_id = sr.id
  where sr.app_id = installer_tenant_activation.app_id
    and sr.customer_id = installer_tenant_activation.customer_id
    and sr.activated_at is not null
  for update of sr;
  if active_revision_id is not null and active_effective_hash is null and expected_hash is not null then
    return kernel_installer_error('schema_activation_conflict', 'Schema activation conflict', 'active_revision', 'active_revision_unmanaged', 'the active revision has no immutable installer artifact identity');
  end if;
  if active_effective_hash is distinct from expected_hash then
    return kernel_installer_error('schema_activation_conflict', 'Schema activation conflict', 'expected_active_effective_hash', 'expected_hash_mismatch', 'the active effective artifact hash changed before activation');
  end if;

  begin
    insert into schema_activation_head (app_id, customer_id, base_schema_version)
    values (
      installer_tenant_activation.app_id,
      installer_tenant_activation.customer_id,
      coalesce(prepared.base_schema_version, '')
    )
    on conflict on constraint schema_activation_head_pkey do update
      set base_schema_version = excluded.base_schema_version, advanced_at = now();
    update schema_revision as sr
    set activated_at = null
    where sr.app_id = installer_tenant_activation.app_id
      and sr.customer_id = installer_tenant_activation.customer_id
      and sr.activated_at is not null;
    update schema_revision as sr
    set activated_at = now()
    where sr.id = installer_tenant_activation.schema_revision_id;
    update schema_installation_revision as sir
    set activated_at = now()
    where sir.schema_revision_id = installer_tenant_activation.schema_revision_id;
    for model_json in
      select value from jsonb_array_elements(coalesce(prepared.schema_json->'models', '[]'::jsonb)) item(value)
      where coalesce(value->>'kind', 'entity') = 'lookup'
      order by value->>'id'
    loop
      model_id := model_json->>'id';
      has_typed_history := kernel_lookup_has_typed_history(
        installer_tenant_activation.app_id,
        installer_tenant_activation.customer_id,
        model_id
      );
      if not has_typed_history
      then
        insert into lookup_storage_authority(
          app_id, customer_id, model_id, schema_hash, authority,
          legacy_record_table, legacy_version_table, activated_at
        ) values (
          installer_tenant_activation.app_id,
          installer_tenant_activation.customer_id,
          model_id,
          prepared.schema_hash,
          'generic',
          'lookup_record',
          'lookup_version',
          now()
        )
        on conflict on constraint lookup_storage_authority_pkey do nothing;
      end if;
    end loop;
    -- Seed defaults can reference lookup identities retained by entity history.
    -- Reconcile those value-free generic shells after lookup authority is
    -- established and before generated seed writes validate their FKs.
    perform kernel_reconcile_lookup_foreign_key_targets(
      installer_tenant_activation.app_id,
      installer_tenant_activation.customer_id
    );
    if jsonb_array_length(prepared.seed_change_sets) > 0 then
      seed_result := kernel_apply_seed_defaults(jsonb_build_object(
        'app_id', installer_tenant_activation.app_id,
        'customer_id', installer_tenant_activation.customer_id,
        'schema_revision_id', installer_tenant_activation.schema_revision_id,
        'change_sets', prepared.seed_change_sets
      ));
      if coalesce((seed_result->>'ok')::boolean, false) is not true then
        raise exception using errcode = 'P0001', message = 'kernel seed activation failed';
      end if;
    end if;
  exception when others then
    if seed_result is not null
      and coalesce((seed_result->>'ok')::boolean, false) is not true
    then
      return seed_result;
    end if;
    return kernel_installer_error('database_error', 'Database operation failed', 'activation', 'activation_failed', 'tenant activation was rolled back');
  end;

  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'activation_kind', 'tenant_overlay', 'app_id', app_id, 'customer_id', customer_id,
    'schema_revision_id', schema_revision_id, 'effective_artifact_hash', effective_artifact_hash,
    'state', 'active', 'idempotent', false
  ));
end;
$kernel$;
"#;

const KERNEL_ACTIVATE_APP_BASE_SCHEMA_REVISION: &str = include_str!("app_base_activation.sql");

const KERNEL_INSTALL_RUNTIME_PRIVILEGES: &str = r#"
create or replace function kernel_install_runtime_privileges()
returns void
language plpgsql
volatile
parallel unsafe
security invoker
set search_path from current
as $kernel$
declare
  schema_name text := current_schema();
  role_name text;
  role_row record;
  execution_role text := kernel_installer_capability_role('execution_owner');
  runtime_role text := kernel_installer_capability_role('runtime');
  schema_admin_role text := kernel_installer_capability_role('schema_admin');
  query_role text := kernel_installer_capability_role('query');
  function_row record;
  entrypoint text;
  qualified_function text;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    current_database() || ':' || schema_name || ':kernel_generated_runtime_roles', 0
  ));
  foreach role_name in array array[
    execution_role, runtime_role, schema_admin_role, query_role
  ] loop
    if to_regrole(role_name) is null then
      execute format(
        'create role %I nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls',
        role_name
      );
    end if;
    select rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls

    into role_row
    from pg_roles
    where rolname = role_name;
    if role_row.rolcanlogin or role_row.rolsuper or role_row.rolcreatedb
      or role_row.rolcreaterole or role_row.rolreplication or role_row.rolbypassrls
    then
      raise exception using
        errcode = '42501',
        message = format('%s has unsafe role attributes', role_name);
    end if;
  end loop;

  if current_user <> execution_role
    and not pg_has_role(current_user, execution_role, 'SET')
  then
    execute format('grant %I to %I', execution_role, current_user);
  end if;

  alter table work_session enable row level security;
  alter table work_session force row level security;
  alter table work_session_record enable row level security;
  alter table work_session_record force row level security;
  drop policy if exists kernel_work_owner on work_session;
  create policy kernel_work_owner on work_session using (
    (app_id,customer_id,owner_id)=(select scope.app_id,scope.customer_id,scope.owner_id from (select current_setting('kernel.app_id',true) app_id,current_setting('kernel.customer_id',true) customer_id,nullif(current_setting('kernel.actor_id',true),'') owner_id) scope where kernel_principal_scope_authorized('runtime',scope.app_id,scope.customer_id,null))
  ) with check (
    (app_id,customer_id,owner_id)=(select scope.app_id,scope.customer_id,scope.owner_id from (select current_setting('kernel.app_id',true) app_id,current_setting('kernel.customer_id',true) customer_id,nullif(current_setting('kernel.actor_id',true),'') owner_id) scope where kernel_principal_scope_authorized('runtime',scope.app_id,scope.customer_id,null))
  );
  drop policy if exists kernel_work_owner on work_session_record;
  create policy kernel_work_owner on work_session_record using (
    exists(select 1 from work_session s where s.app_id=work_session_record.app_id and s.customer_id=work_session_record.customer_id and s.id=work_session_record.session_id)
  ) with check (
    exists(select 1 from work_session s where s.app_id=work_session_record.app_id and s.customer_id=work_session_record.customer_id and s.id=work_session_record.session_id)
  );
  alter table work_session_presence enable row level security;
  alter table work_session_presence force row level security;
  drop policy if exists kernel_work_owner on work_session_presence;
  create policy kernel_work_owner on work_session_presence using (
    actor_id=nullif(current_setting('kernel.actor_id',true),'')
    and exists(select 1 from work_session s where s.app_id=work_session_presence.app_id and s.customer_id=work_session_presence.customer_id and s.id=work_session_presence.session_id)
  ) with check (
    actor_id=nullif(current_setting('kernel.actor_id',true),'')
    and exists(select 1 from work_session s where s.app_id=work_session_presence.app_id and s.customer_id=work_session_presence.customer_id and s.id=work_session_presence.session_id)
  );
  execute format('grant usage, create on schema %I to %I', schema_name, execution_role);
  -- Database CONNECT is database-wide provisioning state. Login principals
  -- need it at connection startup; NOLOGIN capabilities do not. A tenant-schema
  -- installer must not rewrite the database ACL as independent schemas install.
  execute format('grant usage on schema %I to %I, %I', schema_name, runtime_role, schema_admin_role);
  execute format('revoke create on schema %I from %I, %I', schema_name, runtime_role, schema_admin_role);
  execute format('revoke insert, update, delete, truncate, references, trigger on all tables in schema %I from public', schema_name);
  execute format('revoke all privileges on all tables in schema %I from %I, %I, %I', schema_name, execution_role, runtime_role, schema_admin_role);
  execute format('revoke all privileges on all sequences in schema %I from public, %I, %I, %I', schema_name, execution_role, runtime_role, schema_admin_role);
  execute format('grant select, insert, update, delete, references, trigger on all tables in schema %I to %I', schema_name, execution_role);
  execute format('grant usage, select, update on all sequences in schema %I to %I', schema_name, execution_role);
  execute format('revoke execute on all functions in schema %I from public, %I, %I', schema_name, runtime_role, schema_admin_role);

  for function_row in
    select procedure.oid, procedure.proname,
           pg_get_function_identity_arguments(procedure.oid) as identity_arguments
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = schema_name
      and procedure.prokind = 'f'
      and procedure.proname like 'kernel\_%' escape '\'
    order by procedure.proname, procedure.oid
  loop
    qualified_function := format(
      '%I.%I(%s)', schema_name, function_row.proname, function_row.identity_arguments
    );
    execute format('alter function %s owner to %I', qualified_function, execution_role);
    execute format('alter function %s security invoker', qualified_function);
    execute format(
      'alter function %s set search_path to %I, pg_catalog, pg_temp',
      qualified_function, schema_name
    );
    execute format('grant execute on function %s to %I', qualified_function, execution_role);
  end loop;

  foreach entrypoint in array array[
    'kernel_admit_http_request(jsonb)',
    'kernel_admit_http_operation(jsonb)',
    'kernel_finish_http_request(jsonb)',
    'kernel_apply_change_set(jsonb)',
    'kernel_resolve_source_identities(jsonb)',
    'kernel_apply_change_set_in_transaction(jsonb)',
    'kernel_validate_materialized_schema_revision(jsonb)',
    'kernel_validate_change_set_dry_run(jsonb)',
    'kernel_validate_change_sets_dry_run(jsonb)',
    'kernel_list_draft_change_sets(jsonb)',
    'kernel_read_draft_change_set(jsonb)',
    'kernel_update_draft_notes(jsonb)',
    'kernel_discard_draft_change_set(jsonb)',
    'kernel_approve_draft_change_set(jsonb)',
    'kernel_draft_threads(jsonb)',
    'kernel_revert_change_set(jsonb)',
    'kernel_read_active_schema_revision(jsonb)',
    'kernel_read_runtime_release_observability(jsonb)',
    'kernel_read_actor_binding(jsonb)',
    'kernel_read_actor_access(jsonb)',
    'kernel_read_visible_records(jsonb)',
    'kernel_read_visible_record(jsonb)',
    'kernel_read_visible_records_by_text_fields(jsonb)',
    'kernel_read_visible_record_for_update(jsonb)',
    'kernel_read_visible_records_by_model(jsonb)',
    'kernel_data_query(jsonb)',
    'kernel_work_session(jsonb)',
    'kernel_query_visible_sql(jsonb)',
    'kernel_prepare_visible_query(jsonb)',
    'kernel_change_set_diff(jsonb)',
    'kernel_field_history(jsonb)',
    'kernel_recent_activity(jsonb)',
    'kernel_lookup_list(jsonb)',
    'kernel_lookup_resolve_batch(jsonb)',
    'kernel_lookup_hydrate(jsonb)',
    'kernel_lookup_reference_count(jsonb)',
    'kernel_lookup_set_availability(jsonb)',
    'kernel_lookup_transfer_alias(jsonb)',
    'kernel_record_agent_run(jsonb)',
    'kernel_update_agent_run_status(jsonb)',
    'kernel_schema_revision_is_active_with_materialized_tables(jsonb)'
  ] loop
    if to_regprocedure(format('%I.%s', schema_name, entrypoint)) is null then
      raise exception using
        errcode = '42883',
        message = format('required runtime entrypoint %s is missing', entrypoint);
    end if;
    execute format('alter function %I.%s security definer', schema_name, entrypoint);
    execute format('grant execute on function %I.%s to %I', schema_name, entrypoint, runtime_role);
  end loop;

  if to_regprocedure(format('%I.kernel_cleanup_visible_query()', schema_name)) is null then
    raise exception using
      errcode = '42883',
      message = 'required runtime entrypoint kernel_cleanup_visible_query() is missing';
  end if;
  execute format(
    'alter function %I.kernel_cleanup_visible_query() security invoker',
    schema_name
  );
  execute format(
    'grant execute on function %I.kernel_cleanup_visible_query() to %I',
    schema_name, runtime_role
  );

  foreach entrypoint in array array[
    'kernel_dry_run_tenant_schema_revision(jsonb)',
    'kernel_commit_tenant_schema_revision(jsonb)',
    'kernel_apply_seed_defaults(jsonb)',
    'kernel_bind_actor_membership(jsonb)',
    'kernel_bind_actor_access(jsonb)'
  ] loop
    if to_regprocedure(format('%I.%s', schema_name, entrypoint)) is null then
      raise exception using
        errcode = '42883',
        message = format('required schema-admin entrypoint %s is missing', entrypoint);
    end if;
    execute format('alter function %I.%s security definer', schema_name, entrypoint);
    execute format('grant execute on function %I.%s to %I', schema_name, entrypoint, schema_admin_role);
  end loop;

  if to_regprocedure(format('%I.kernel_policy_raw_table_access_allowed(name,text,text)', schema_name)) is null then
    raise exception using
      errcode = '42883',
      message = 'required runtime policy helper kernel_policy_raw_table_access_allowed is missing';
  end if;
  execute format(
    'alter function %I.kernel_policy_raw_table_access_allowed(name,text,text) security definer',
    schema_name
  );
  execute format(
    'grant execute on function %I.kernel_policy_raw_table_access_allowed(name,text,text) to %I',
    schema_name, runtime_role
  );

  if to_regrole(query_role) is not null then
    execute format(
      'grant execute on function %I.kernel_policy_raw_table_access_allowed(name,text,text) to %I',
      schema_name, query_role
    );
    execute format('grant %I to %I', query_role, runtime_role);
    execute format('grant usage on schema %I to %I', schema_name, query_role);
    execute format('revoke create on schema %I from %I', schema_name, query_role);
    execute format('revoke all privileges on all tables in schema %I from %I', schema_name, query_role);
    execute format('revoke all privileges on all sequences in schema %I from %I', schema_name, query_role);
    execute format(
      'alter function %I.kernel_validate_visible_query(jsonb) set search_path to pg_temp, %I, pg_catalog',
      schema_name, schema_name
    );
    execute format(
      'alter function %I.kernel_validate_visible_query(text) set search_path to pg_temp, %I, pg_catalog',
      schema_name, schema_name
    );
    execute format('grant execute on function %I.kernel_validate_visible_query(jsonb) to %I', schema_name, query_role);
    execute format('grant execute on function %I.kernel_validate_visible_query(text) to %I', schema_name, query_role);
    execute format(
      'alter function %I.kernel_principal_scope_authorized(text,text,text,text) security definer',
      schema_name
    );
    execute format(
      'grant execute on function %I.kernel_principal_scope_authorized(text,text,text,text) to %I',
      schema_name, query_role
    );
  end if;
end;
$kernel$;
"#;

const KERNEL_SYNC_SCHEMA_CONSTRAINT_IDENTITIES: &str = r#"
create or replace function kernel_sync_schema_constraint_identities(requested_revision_id bigint)
returns void
language plpgsql
volatile
security invoker
set search_path from current
as $kernel$
declare
  revision_row record;
  expected_catalog jsonb;
  actual_catalog jsonb;
begin
  select id, app_id, customer_id, base_schema->>'version' as base_version
  into strict revision_row from schema_revision where id = requested_revision_id for update;
  select catalog into expected_catalog from schema_constraint_identity_source as source
  where source.app_id = revision_row.app_id
    and source.schema_version = revision_row.base_version;
  if found then
    insert into schema_constraint_identity (schema_revision_id, app_id, customer_id, catalog)
    values (revision_row.id, revision_row.app_id, revision_row.customer_id, expected_catalog)
    on conflict do nothing;
  end if;
  select catalog into actual_catalog from schema_constraint_identity
  where schema_revision_id = revision_row.id;
  if actual_catalog is distinct from expected_catalog then
    raise exception using errcode = 'P0001', message = 'schema constraint catalog drift';
  end if;
end;
$kernel$;
"#;

const KERNEL_CONSTRAINT_IDENTITY_DRIFT: &str = r#"
create or replace function kernel_constraint_identity_drift(expected_schema jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path from current
as $kernel$
declare
  expected_catalog jsonb;
  actual_catalog jsonb;
  identity_value jsonb;
  active_row record;
begin
  select source.catalog into expected_catalog
  from schema_constraint_identity_source as source
  where source.app_id = expected_schema->>'app_id'
    and source.schema_version = expected_schema->>'version';
  select revision.id, revision.base_schema->>'version' as base_version into active_row
  from schema_revision as revision
  where revision.app_id = expected_schema->>'app_id'
    and revision.customer_id = expected_schema->>'customer_id'
    and revision.activated_at is not null;
  if found and active_row.base_version = expected_schema->>'version' then
    select snapshot.catalog into actual_catalog from schema_constraint_identity as snapshot
    where snapshot.schema_revision_id = active_row.id
      and snapshot.app_id = expected_schema->>'app_id'
      and snapshot.customer_id = expected_schema->>'customer_id';
    if actual_catalog is distinct from expected_catalog then
      return kernel_installer_schema_drift('schema_constraint_identity', 'constraint identities differ from the checked catalog');
    end if;
  end if;
  -- Legacy revisions have no catalog; they retain generic database errors.
  -- New generated releases persist even an empty catalog, so empty is not absent.
  for identity_value in select value from jsonb_array_elements(coalesce(expected_catalog, '[]'::jsonb)) loop
    -- Interval rules have no CHECK; their generated enforcement needs the
    -- model version table to carry every referenced field column.
    if identity_value->>'kind' = 'non_overlapping_intervals' then
      if exists (
        select 1 from jsonb_array_elements_text(identity_value->'field_ids') as item(field_id)
        where not exists (
          select 1 from pg_attribute as attribute
          join pg_class as relation on relation.oid = attribute.attrelid
          join pg_namespace as namespace on namespace.oid = relation.relnamespace
          where namespace.nspname = current_schema()
            and relation.relname = kernel_physical_identifier(kernel_physical_identifier(identity_value->>'model_id') || '_version')
            and attribute.attname = kernel_physical_identifier(item.field_id)
            and attribute.attnum > 0 and not attribute.attisdropped
        )
      ) then
        return kernel_installer_schema_drift('schema_constraint_identity', 'declared interval rule references a missing version column');
      end if;
      continue;
    end if;
    if not exists (
      select 1 from pg_constraint as constraint_value
      join pg_class as relation on relation.oid = constraint_value.conrelid
      join pg_namespace as namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = current_schema()
        and relation.relname = identity_value->>'table_name'
        and constraint_value.conname = identity_value->>'constraint_name'
        and constraint_value.contype = 'c' and constraint_value.convalidated
    ) then
      return kernel_installer_schema_drift('schema_constraint_identity', 'declared CHECK identity is missing or invalid');
    end if;
  end loop;
  return null;
end;
$kernel$;
"#;

// Cross-record interval rules are compiler-declared `non_overlapping_intervals`
// entries in a revision's constraint catalog. A null revision means the
// tenant's active revision, so draft approval and revert evaluate current rules.
const KERNEL_CONSTRAINT_INTERVAL_RULES: &str = r#"
create or replace function kernel_constraint_interval_rules(
  app_id text,
  customer_id text,
  schema_revision_id bigint
)
returns jsonb
language sql
stable
security invoker
set search_path from current
as $kernel$
  select jsonb_build_object(
    'schema', revision.schema,
    'rules', coalesce((
      select jsonb_agg(entry.value order by entry.value->>'model_id', entry.value->>'constraint_id')
      from schema_constraint_identity as snapshot
      cross join lateral jsonb_array_elements(snapshot.catalog) as entry(value)
      where snapshot.schema_revision_id = revision.id
        and snapshot.app_id = revision.app_id
        and snapshot.customer_id = revision.customer_id
        and entry.value->>'kind' = 'non_overlapping_intervals'
    ), '[]'::jsonb)
  )
  from schema_revision as revision
  where revision.app_id = $1
    and revision.customer_id = $2
    and (($3 is null and revision.activated_at is not null) or revision.id = $3)
$kernel$;
"#;

// Writers of a constrained model serialize per tenant and model before taking
// their canonical row locks, so concurrent transactions cannot each admit one
// half of an overlapping pair.
// Interval rules are validated against committed rows read after a lock, which
// only READ COMMITTED observes. Writers and installers call this first and
// report the returned envelope in their own error style; null means allowed.
// A null `model_ids` checks every rule (installer readiness and activation).
const KERNEL_CONSTRAINT_INTERVAL_ISOLATION_ERROR: &str = r#"
create or replace function kernel_constraint_interval_isolation_error(
  app_id text,
  customer_id text,
  schema_revision_id bigint,
  model_ids text[]
)
returns jsonb
language plpgsql
stable
security invoker
set search_path from current
as $kernel$
begin
  if current_setting('transaction_isolation') = 'read committed' or not exists (
    select 1
    from jsonb_array_elements(
      coalesce(kernel_constraint_interval_rules(app_id, customer_id, schema_revision_id)->'rules', '[]'::jsonb)
    ) as rule(value)
    where model_ids is null or rule.value->>'model_id' = any(model_ids)
  ) then
    return null;
  end if;
  return jsonb_build_object(
    'code', 'contract_validation_failed',
    'message', 'Contract validation failed',
    'details', jsonb_build_array(jsonb_build_object(
      'path', 'transaction',
      'code', 'interval_rule_requires_read_committed',
      'message', 'interval rules require a READ COMMITTED transaction'
    ))
  );
end;
$kernel$;
"#;

const KERNEL_CONSTRAINT_INTERVAL_LOCK: &str = r#"
create or replace function kernel_constraint_interval_lock(
  app_id text,
  customer_id text,
  schema_revision_id bigint,
  model_ids text[]
)
returns void
language plpgsql
volatile
security invoker
set search_path from current
as $kernel$
declare
  locked_model_id text;
begin
  for locked_model_id in
    select distinct rule.value->>'model_id'
    from jsonb_array_elements(
      coalesce(kernel_constraint_interval_rules(app_id, customer_id, schema_revision_id)->'rules', '[]'::jsonb)
    ) as rule(value)
    where rule.value->>'model_id' = any(model_ids)
    order by 1
  loop
    -- The lock serializes writers, but only READ COMMITTED re-reads committed
    -- rows after waiting; an older snapshot could miss a concurrent overlap.
    if current_setting('transaction_isolation') <> 'read committed' then
      raise exception using errcode = 'P0001', message = 'kernel_apply:' || jsonb_build_object(
        'code', 'contract_validation_failed',
        'message', 'Contract validation failed',
        'details', jsonb_build_array(jsonb_build_object(
          'path', 'transaction',
          'code', 'interval_rule_requires_read_committed',
          'message', 'writes to a model with an interval rule require a READ COMMITTED transaction'
        ))
      )::text;
    end if;
    perform pg_advisory_xact_lock(hashtextextended(
      'interval-exclusion' || E'\x1f' || app_id || E'\x1f' || customer_id || E'\x1f' || locked_model_id, 0
    ));
  end loop;
end;
$kernel$;
"#;

// Returns a `constraint_violation` envelope for the first overlapping pair of
// live mainline rows, or null. `record_scope` maps model IDs to the record IDs
// a write touched; null checks every live row (installer readiness). Messages
// use schema labels; details keep the stable model, constraint, and field IDs.
const KERNEL_CONSTRAINT_INTERVAL_VIOLATION: &str = r#"
create or replace function kernel_constraint_interval_violation(
  app_id text,
  customer_id text,
  schema_revision_id bigint,
  record_scope jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path from current
as $kernel$
declare
  loaded jsonb;
  rule jsonb;
  model jsonb;
  subject jsonb;
  scoped uuid[];
  subject_predicate text;
  start_column text;
  end_column text;
  overlap_pair jsonb;
  model_label text;
  start_label text;
  end_label text;
  subject_label text;
  message text;
begin
  loaded := kernel_constraint_interval_rules(app_id, customer_id, schema_revision_id);
  for rule in
    select value from jsonb_array_elements(coalesce(loaded->'rules', '[]'::jsonb)) as item(value)
    order by value->>'model_id', value->>'constraint_id'
  loop
    scoped := null;
    if record_scope is not null then
      select array_agg(distinct item.value::uuid) into scoped
      from jsonb_array_elements_text(coalesce(record_scope->(rule->>'model_id'), '[]'::jsonb)) as item(value);
      if scoped is null then continue; end if;
    end if;
    select value into model from jsonb_array_elements(loaded->'schema'->'models') as item(value)
    where value->>'id' = rule->>'model_id';
    if model is null then
      return jsonb_build_object('code', 'schema_drift', 'message', 'Schema drift detected',
        'details', jsonb_build_array(jsonb_build_object('path', 'constraint', 'code', 'schema_drift',
          'message', rule->>'constraint_id')));
    end if;
    start_column := quote_ident(kernel_physical_identifier(rule->>'start_field_id'));
    end_column := quote_ident(kernel_physical_identifier(rule->>'end_field_id'));
    for subject in select value from jsonb_array_elements(rule->'subject_field_ids') as item(value) loop
      select string_agg(format('a.%1$s = b.%1$s', quote_ident(kernel_physical_identifier(item.value))), ' and ' order by item.ordinal)
      into subject_predicate
      from jsonb_array_elements_text(subject) with ordinality as item(value, ordinal);
      overlap_pair := null;
      execute format(
        'with live as (
           select v.* from %1$s v join change_set cs
             on cs.id = v.change_set_id and cs.app_id = v.app_id and cs.customer_id = v.customer_id
           where v.app_id = $1 and v.customer_id = $2 and v.stage = ''mainline'' and v.effective_end is null
             and not v.tombstones_record and not v.untombstones_record
             and cs.status = ''mainline'' and cs.applied_order is not null
         )
         select jsonb_build_object(
           ''other_record_id'', b.record_id,
           ''start'', a.%2$s, ''end'', a.%3$s, ''other_start'', b.%2$s, ''other_end'', b.%3$s
         )
         from live a join live b on b.record_id <> a.record_id and %4$s
           and greatest(a.%2$s, b.%2$s) <= least(coalesce(a.%3$s, ''infinity''::date), coalesce(b.%3$s, ''infinity''::date))
         where $3::uuid[] is null or a.record_id = any($3)
         order by a.record_id, b.record_id
         limit 1',
        quote_ident(kernel_physical_identifier(kernel_physical_identifier(rule->>'model_id') || '_version')),
        start_column, end_column, subject_predicate
      ) using app_id, customer_id, scoped into overlap_pair;
      if overlap_pair is null then continue; end if;

      model_label := coalesce(model->>'label', rule->>'model_id');
      select coalesce(max(value->>'label') filter (where value->>'id' = rule->>'start_field_id'), rule->>'start_field_id'),
             coalesce(max(value->>'label') filter (where value->>'id' = rule->>'end_field_id'), rule->>'end_field_id')
      into start_label, end_label
      from jsonb_array_elements(model->'fields') as item(value);
      select string_agg(coalesce(field.value->>'label', item.value), ' and ' order by item.ordinal)
      into subject_label
      from jsonb_array_elements_text(subject) with ordinality as item(value, ordinal)
      left join lateral (
        select value from jsonb_array_elements(model->'fields') as candidate(value)
        where candidate.value->>'id' = item.value
      ) as field on true;
      message := format(
        '%s: %s (%s %s, %s %s) overlaps another %s with the same %s (%s %s, %s %s)',
        coalesce(rule->>'label', rule->>'constraint_id'),
        model_label, start_label, overlap_pair->>'start', end_label, coalesce(overlap_pair->>'end', 'none'),
        model_label, subject_label,
        start_label, overlap_pair->>'other_start', end_label, coalesce(overlap_pair->>'other_end', 'none')
      );
      return jsonb_build_object(
        'code', 'constraint_violation',
        'message', message,
        'details', jsonb_build_array(
          jsonb_build_object('path', 'interval', 'code', 'constraint_violation', 'message', message),
          jsonb_build_object('path', 'model', 'code', 'constraint_violation', 'message', rule->>'model_id'),
          jsonb_build_object('path', 'constraint', 'code', 'constraint_violation', 'message', rule->>'constraint_id')
        ) || coalesce((
          select jsonb_agg(jsonb_build_object('path', 'field', 'code', 'constraint_violation', 'message', item.value) order by item.ordinal)
          from jsonb_array_elements_text(rule->'field_ids') with ordinality as item(value, ordinal)
        ), '[]'::jsonb) || jsonb_build_array(
          jsonb_build_object('path', 'record', 'code', 'constraint_violation', 'message', overlap_pair->>'other_record_id')
        )
      );
    end loop;
  end loop;
  return null;
end;
$kernel$;
"#;
