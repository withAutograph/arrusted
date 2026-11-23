use super::RuntimeSqlFunction;

pub(super) fn functions() -> Vec<RuntimeSqlFunction> {
    vec![
        function(
            "kernel_lookup_migration_error(text,text,text)",
            &format!("{}\n{}", MIGRATION_SUBSTRATE, MIGRATION_ERROR),
        ),
        function(
            "kernel_lookup_migration_snapshot(jsonb,jsonb)",
            MIGRATION_SNAPSHOT,
        ),
        function(
            "kernel_lookup_migration_block_legacy_write()",
            BLOCK_LEGACY_WRITE,
        ),
        function(
            "kernel_lookup_migration_mark_generic_write()",
            MARK_GENERIC_WRITE,
        ),
        function(
            "kernel_lookup_storage_authority_error(text,text,text)",
            STORAGE_AUTHORITY_ERROR,
        ),
        function(
            "kernel_lookup_migration_model_evidence(text,text,text,jsonb)",
            MODEL_EVIDENCE,
        ),
        function("kernel_prepare_lookup_migration(jsonb)", PREPARE_MIGRATION),
        function(
            "kernel_validate_lookup_migration(jsonb)",
            VALIDATE_MIGRATION,
        ),
        function(
            "kernel_activate_lookup_migration(jsonb)",
            ACTIVATE_MIGRATION,
        ),
        function("kernel_lookup_migration_status(jsonb)", MIGRATION_STATUS),
    ]
}

fn function(signature: &'static str, sql: &str) -> RuntimeSqlFunction {
    RuntimeSqlFunction {
        signature,
        sql: sql.trim().to_string(),
    }
}

const MIGRATION_SUBSTRATE: &str = r#"
create table if not exists lookup_storage_authority (
  app_id text not null,
  customer_id text not null,
  model_id text not null,
  schema_hash text not null,
  authority text not null,
  legacy_record_table text not null,
  legacy_version_table text not null,
  activated_at timestamptz,
  first_generic_write_at timestamptz,
  constraint lookup_storage_authority_pkey
    primary key (app_id, customer_id, model_id),
  constraint lookup_storage_authority_kind_check
    check (authority in ('typed', 'generic')),
  constraint lookup_storage_authority_hash_check
    check (schema_hash ~ '^[0-9a-f]{64}$')
);

create table if not exists lookup_migration_revision (
  app_id text not null,
  customer_id text not null,
  schema_hash text not null,
  schema_revision_id bigint not null,
  status text not null default 'preparing',
  prepared_at timestamptz,
  activated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lookup_migration_revision_pkey
    primary key (app_id, customer_id, schema_hash),
  constraint lookup_migration_revision_status_check
    check (status in ('preparing', 'ready', 'active', 'failed')),
  constraint lookup_migration_revision_hash_check
    check (schema_hash ~ '^[0-9a-f]{64}$')
);

create table if not exists lookup_migration_phase (
  app_id text not null,
  customer_id text not null,
  schema_hash text not null,
  model_id text not null,
  phase text not null,
  status text not null default 'pending',
  cursor_id uuid,
  attempts bigint not null default 0,
  evidence jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  last_error text,
  constraint lookup_migration_phase_pkey
    primary key (app_id, customer_id, schema_hash, model_id, phase),
  constraint lookup_migration_phase_name_check
    check (phase in ('records', 'versions', 'projections', 'verify')),
  constraint lookup_migration_phase_status_check
    check (status in ('pending', 'running', 'complete', 'failed')),
  constraint lookup_migration_phase_evidence_check
    check (evidence is null or jsonb_typeof(evidence) = 'object')
);

do $kernel_lookup_migration$
declare table_name text;
begin
  foreach table_name in array array[
    'lookup_storage_authority',
    'lookup_migration_revision',
    'lookup_migration_phase'
  ] loop
    execute format('alter table %I enable row level security', table_name);
    execute format('alter table %I force row level security', table_name);
    if exists (
      select 1 from pg_policies
      where schemaname = current_schema()
        and tablename = table_name
        and policyname = 'kernel_tenant_isolation'
    ) then
      execute format(
        'alter policy kernel_tenant_isolation on %I using ((app_id, customer_id) = (select scope.app_id, scope.customer_id from (select current_setting(''kernel.app_id'', true) app_id, current_setting(''kernel.customer_id'', true) customer_id) scope where kernel_principal_scope_authorized(''any'', scope.app_id, scope.customer_id, null))) with check ((app_id, customer_id) = (select scope.app_id, scope.customer_id from (select current_setting(''kernel.app_id'', true) app_id, current_setting(''kernel.customer_id'', true) customer_id) scope where kernel_principal_scope_authorized(''any'', scope.app_id, scope.customer_id, null)))',
        table_name
      );
    else
      execute format(
        'create policy kernel_tenant_isolation on %I for all using ((app_id, customer_id) = (select scope.app_id, scope.customer_id from (select current_setting(''kernel.app_id'', true) app_id, current_setting(''kernel.customer_id'', true) customer_id) scope where kernel_principal_scope_authorized(''any'', scope.app_id, scope.customer_id, null))) with check ((app_id, customer_id) = (select scope.app_id, scope.customer_id from (select current_setting(''kernel.app_id'', true) app_id, current_setting(''kernel.customer_id'', true) customer_id) scope where kernel_principal_scope_authorized(''any'', scope.app_id, scope.customer_id, null)))',
        table_name
      );
    end if;
    execute format('revoke all on table %I from public', table_name);
  end loop;
end
$kernel_lookup_migration$;
"#;

const MIGRATION_ERROR: &str = r#"
create or replace function kernel_lookup_migration_error(
  error_code text,
  error_message text,
  detail_message text
)
returns jsonb
language sql
immutable
parallel safe
security invoker
set search_path from current
as $kernel_lookup_migration$
  select jsonb_build_object(
    'ok', false,
    'error', jsonb_build_object(
      'code', error_code,
      'message', error_message,
      'details', jsonb_build_array(jsonb_build_object(
        'path', 'lookup_migration',
        'code', error_code,
        'message', detail_message
      ))
    )
  )
$kernel_lookup_migration$;
"#;

const STORAGE_AUTHORITY_ERROR: &str = r#"
create or replace function kernel_lookup_storage_authority_error(
  requested_app_id text,
  requested_customer_id text,
  requested_model_id text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path from current
as $kernel_lookup_authority$
declare
  storage_authority text;
begin
  perform set_config('kernel.app_id', requested_app_id, true);
  perform set_config('kernel.customer_id', requested_customer_id, true);
  perform pg_advisory_xact_lock_shared(hashtext(
    'postgres-schema:' || current_schema() || ':materialize-tenant:' ||
    requested_app_id || ':' || requested_customer_id || ':lookup-migration'
  ));
  select authority.authority into storage_authority
  from lookup_storage_authority authority
  where authority.app_id = requested_app_id
    and authority.customer_id = requested_customer_id
    and authority.model_id = requested_model_id;
  if storage_authority = 'typed' then
    return jsonb_build_object(
      'code', 'lookup_storage_authority_mismatch',
      'message', 'Lookup storage authority mismatch',
      'details', jsonb_build_array(jsonb_build_object(
        'path', 'model_id',
        'code', 'lookup_storage_authority_mismatch',
        'message', format(
          'generic lookup storage is not authoritative for `%s/%s/%s`',
          requested_app_id, requested_customer_id, requested_model_id
        )
      ))
    );
  end if;
  return null;
end;
$kernel_lookup_authority$;
"#;

const MIGRATION_SNAPSHOT: &str = r#"
create or replace function kernel_lookup_migration_snapshot(row_json jsonb, model_json jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path from current
as $kernel_lookup_migration$
declare
  result jsonb := case
    when jsonb_typeof(row_json->'values') = 'object' then row_json->'values'
    else '{}'::jsonb
  end;
  field_json jsonb;
  field_id text;
  field_type text;
  identifier text;
  scalar jsonb;
  amount jsonb;
  currency jsonb;
  period jsonb;
begin
  if coalesce((row_json->>'tombstones_record')::boolean, false)
    or coalesce((row_json->>'untombstones_record')::boolean, false)
  then
    return '{}'::jsonb;
  end if;

  for field_json in
    select value
    from jsonb_array_elements(coalesce(model_json->'fields', '[]'::jsonb)) item(value)
    order by item.value->>'id'
  loop
    field_id := field_json->>'id';
    field_type := field_json->>'type';
    identifier := kernel_physical_identifier(field_id);

    if field_type = 'money_rate' then
      amount := row_json->kernel_physical_identifier(field_id || '_amount');
      currency := row_json->kernel_physical_identifier(field_id || '_currency');
      period := row_json->kernel_physical_identifier(field_id || '_period');
      if amount is not null and amount <> 'null'::jsonb then
        result := result || jsonb_build_object(field_id, jsonb_build_object(
          'type', 'money_rate',
          'value', jsonb_build_object(
            'amount', amount #>> '{}',
            'currency', currency #>> '{}',
            'period', period #>> '{}'
          )
        ));
      end if;
      continue;
    end if;

    scalar := row_json->identifier;
    if scalar is null or scalar = 'null'::jsonb then
      continue;
    end if;
    if field_type in ('text', 'iso_country', 'iso_currency') then
      result := result || jsonb_build_object(
        field_id, jsonb_build_object('type', 'text', 'value', scalar)
      );
    elsif field_type = 'enum' then
      result := result || jsonb_build_object(
        field_id, jsonb_build_object('type', 'enum', 'value', scalar)
      );
    elsif field_type = 'number' then
      result := result || jsonb_build_object(
        field_id, jsonb_build_object('type', 'number', 'value', scalar #>> '{}')
      );
    elsif field_type = 'bool' then
      result := result || jsonb_build_object(
        field_id, jsonb_build_object('type', 'bool', 'value', scalar)
      );
    elsif field_type = 'date' then
      result := result || jsonb_build_object(
        field_id, jsonb_build_object('type', 'date', 'value', scalar)
      );
    elsif field_type = 'datetime' then
      result := result || jsonb_build_object(
        field_id, jsonb_build_object('type', 'datetime', 'value', scalar)
      );
    elsif field_type = 'relation' then
      result := result || jsonb_build_object(field_id, jsonb_build_object(
        'type', 'relation',
        'value', jsonb_build_object('type', 'record_id', 'value', scalar)
      ));
    elsif field_type in ('text_list', 'known_aliases') then
      result := result || jsonb_build_object(
        field_id, jsonb_build_object('type', 'text_list', 'value', scalar)
      );
    elsif field_type = 'json' then
      result := result || jsonb_build_object(
        field_id, jsonb_build_object('type', 'json', 'value', scalar)
      );
    else
      raise exception 'unsupported lookup field type `%` for `%.%`',
        field_type, model_json->>'id', field_id;
    end if;
  end loop;
  return result;
end;
$kernel_lookup_migration$;
"#;

const BLOCK_LEGACY_WRITE: &str = r#"
create or replace function kernel_lookup_migration_block_legacy_write()
returns trigger
language plpgsql
volatile
security invoker
set search_path from current
as $kernel_lookup_migration$
begin
  raise exception using
    errcode = '55000',
    message = 'legacy_lookup_authority_retired: writes must use the generated lookup API';
end;
$kernel_lookup_migration$;
"#;

const MARK_GENERIC_WRITE: &str = r#"
create or replace function kernel_lookup_migration_mark_generic_write()
returns trigger
language plpgsql
volatile
security invoker
set search_path from current
as $kernel_lookup_migration$
begin
  update lookup_storage_authority
  set first_generic_write_at = coalesce(first_generic_write_at, clock_timestamp())
  where app_id = new.app_id
    and customer_id = new.customer_id
    and model_id = new.model_id
    and authority = 'generic';
  return new;
end;
$kernel_lookup_migration$;

do $kernel_lookup_migration$
begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = to_regclass(format('%I.lookup_version', current_schema()))
      and tgname = 'lookup_version_mark_generic_write'
      and not tgisinternal
  ) then
    create trigger lookup_version_mark_generic_write
      after insert on lookup_version
      for each row execute function kernel_lookup_migration_mark_generic_write();
  end if;
end
$kernel_lookup_migration$;
"#;

const MODEL_EVIDENCE: &str = r#"
create or replace function kernel_lookup_migration_model_evidence(
  requested_app_id text,
  requested_customer_id text,
  requested_model_id text,
  model_json jsonb
)
returns jsonb
language plpgsql
stable
security invoker
set search_path from current
as $kernel_lookup_migration$
declare
  record_table text := kernel_physical_identifier(requested_model_id || '_record');
  version_table text := kernel_physical_identifier(requested_model_id || '_version');
  source_record_count bigint;
  target_record_count bigint;
  source_version_count bigint;
  target_version_count bigint;
  source_record_hash text;
  target_record_hash text;
  source_history_hash text;
  target_history_hash text;
begin
  execute format($evidence$
    select count(*)::bigint, md5(coalesce(string_agg(canonical::text, E'\n' order by id), ''))
    from (
      select r.id, jsonb_build_object(
        'id', r.id,
        'external_key', r.external_key,
        'created_at', r.created_at
      ) canonical
      from %I r
      where r.app_id = $1 and r.customer_id = $2
    ) rows
  $evidence$, record_table)
  using requested_app_id, requested_customer_id
  into source_record_count, source_record_hash;

  select count(*)::bigint,
    md5(coalesce(string_agg(canonical::text, E'\n' order by id), ''))
  into target_record_count, target_record_hash
  from (
    select r.id, jsonb_build_object(
      'id', r.id,
      'external_key', r.external_key,
      'created_at', r.created_at
    ) canonical
    from lookup_record r
    where r.app_id = requested_app_id
      and r.customer_id = requested_customer_id
      and r.model_id = requested_model_id
  ) rows;

  execute format($evidence$
    select count(*)::bigint, md5(coalesce(string_agg(canonical::text, E'\n' order by id), ''))
    from (
      select v.id, jsonb_build_object(
        'id', v.id,
        'record_id', v.record_id,
        'stage', v.stage,
        'effective_start', v.effective_start,
        'effective_end', v.effective_end,
        'change_set_id', v.change_set_id,
        'created_at', v.created_at,
        'applied_at', v.applied_at,
        'applied_order', cs.applied_order,
        'tombstones_record', v.tombstones_record,
        'untombstones_record', v.untombstones_record,
        'availability', coalesce(to_jsonb(v)->>'availability', 'active'),
        'provenance', to_jsonb(v)->'provenance',
        'custom_fields', coalesce(to_jsonb(v)->'custom_fields', '[]'::jsonb),
        'metadata', coalesce(to_jsonb(v)->'metadata', '{}'::jsonb),
        'many_relations', coalesce(to_jsonb(v)->'many_relations', '{}'::jsonb),
        'values', kernel_lookup_migration_snapshot(to_jsonb(v), $3)
      ) canonical
      from %I v
      join change_set cs
        on cs.id = v.change_set_id
       and cs.app_id = v.app_id
       and cs.customer_id = v.customer_id
      where v.app_id = $1 and v.customer_id = $2
    ) rows
  $evidence$, version_table)
  using requested_app_id, requested_customer_id, model_json
  into source_version_count, source_history_hash;

  select count(*)::bigint,
    md5(coalesce(string_agg(canonical::text, E'\n' order by id), ''))
  into target_version_count, target_history_hash
  from (
    select v.id, jsonb_build_object(
      'id', v.id,
      'record_id', v.record_id,
      'stage', v.stage,
      'effective_start', v.effective_start,
      'effective_end', v.effective_end,
      'change_set_id', v.change_set_id,
      'created_at', v.created_at,
      'applied_at', v.applied_at,
      'applied_order', cs.applied_order,
      'tombstones_record', v.tombstones_record,
      'untombstones_record', v.untombstones_record,
      'availability', v.availability,
      'provenance', to_jsonb(v)->'provenance',
      'custom_fields', v.custom_fields,
      'metadata', v.metadata,
      'many_relations', v.many_relations,
      'values', v.values
    ) canonical
    from lookup_version v
    join change_set cs
      on cs.id = v.change_set_id
     and cs.app_id = v.app_id
     and cs.customer_id = v.customer_id
    where v.app_id = requested_app_id
      and v.customer_id = requested_customer_id
      and v.model_id = requested_model_id
  ) rows;

  return jsonb_build_object(
    'source_record_count', source_record_count,
    'target_record_count', target_record_count,
    'source_record_hash', source_record_hash,
    'target_record_hash', target_record_hash,
    'source_version_count', source_version_count,
    'target_version_count', target_version_count,
    'source_history_hash', source_history_hash,
    'target_history_hash', target_history_hash,
    'matches', source_record_count = target_record_count
      and source_version_count = target_version_count
      and source_record_hash = target_record_hash
      and source_history_hash = target_history_hash
  );
end;
$kernel_lookup_migration$;
"#;

const PREPARE_MIGRATION: &str = r#"
create or replace function kernel_prepare_lookup_migration(request jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path from current
as $kernel_lookup_migration$
#variable_conflict use_variable
<<prepare_lookup_migration>>
declare
  app_id text := request->>'app_id';
  customer_id text := request->>'customer_id';
  schema_revision_id bigint;
  expected_schema_hash text := request->>'expected_schema_hash';
  batch_size integer := 1000;
  schema_json jsonb;
  stored_schema_hash text;
  model_json jsonb;
  model_id text;
  record_table text;
  version_table text;
  authority_row record;
  expected_columns text[];
  target_model_column text;
  column_row record;
  has_data boolean;
  phase_row record;
  row_data jsonb;
  row_count integer;
  cursor_value uuid;
  snapshot jsonb;
  evidence jsonb;
  projected_is_current boolean;
  recovery_seeds jsonb;
  recovered_first_write timestamptz;
  recovery_has_typed_history boolean;
begin
  if request is null or jsonb_typeof(request) <> 'object'
    or request - array['app_id', 'customer_id', 'schema_revision_id', 'expected_schema_hash', 'batch_size'] <> '{}'::jsonb
    or app_id is null or btrim(app_id) = ''
    or customer_id is null or btrim(customer_id) = ''
    or jsonb_typeof(request->'schema_revision_id') is distinct from 'number'
    or (request->>'schema_revision_id')::numeric <> trunc((request->>'schema_revision_id')::numeric)
    or (request->>'schema_revision_id')::numeric <= 0
    or (request->>'schema_revision_id')::numeric > 9223372036854775807
    or (
      request ? 'batch_size' and (
        jsonb_typeof(request->'batch_size') <> 'number'
        or (request->>'batch_size')::numeric <> trunc((request->>'batch_size')::numeric)
        or (request->>'batch_size')::numeric < 1
        or (request->>'batch_size')::numeric > 10000
      )
    )
    or expected_schema_hash is null
    or expected_schema_hash !~ '^[0-9a-f]{64}$'
  then
    return kernel_lookup_migration_error(
      'contract_validation_failed',
      'Lookup migration request is invalid',
      'app_id, customer_id, schema_revision_id, and expected_schema_hash are required'
    );
  end if;
  schema_revision_id := (request->>'schema_revision_id')::bigint;
  if request ? 'batch_size' then
    batch_size := (request->>'batch_size')::integer;
  end if;

  perform set_config('kernel.app_id', app_id, true);
  perform set_config('kernel.customer_id', customer_id, true);
  perform pg_advisory_xact_lock(hashtext(
    'postgres-schema:' || current_schema() || ':materialize-tenant:' || app_id || ':' || customer_id || ':lookup-migration'
  ));

  select revision.schema, revision.schema_hash
  into schema_json, stored_schema_hash
  from schema_revision revision
  where revision.id = schema_revision_id
    and revision.app_id = app_id
    and revision.customer_id = customer_id
    and revision.activated_at is not null;
  if schema_json is null then
    return kernel_lookup_migration_error(
      'stale_schema_revision', 'The supplied schema revision is not active',
      'the requested tenant schema revision is not the active head'
    );
  end if;
  if stored_schema_hash is distinct from expected_schema_hash then
    return kernel_lookup_migration_error(
      'stale_schema_hash', 'Schema hash changed',
      'the requested schema hash does not match the persisted revision'
    );
  end if;

  insert into lookup_migration_revision(
    app_id, customer_id, schema_hash, schema_revision_id, status, updated_at
  ) values (
    app_id, customer_id, expected_schema_hash, schema_revision_id, 'preparing', now()
  )
  on conflict on constraint lookup_migration_revision_pkey do update
  set schema_revision_id = excluded.schema_revision_id,
      status = case
        when lookup_migration_revision.status = 'active' then 'active'
        else 'preparing'
      end,
      updated_at = now();

  for model_json in
    select value
    from jsonb_array_elements(coalesce(schema_json->'models', '[]'::jsonb)) item(value)
    where coalesce(value->>'kind', 'entity') = 'lookup'
    order by value->>'id'
  loop
    model_id := model_json->>'id';
    record_table := kernel_physical_identifier(model_id || '_record');
    version_table := kernel_physical_identifier(model_id || '_version');
    if record_table = 'lookup_record' or version_table = 'lookup_version' then
      return kernel_lookup_migration_error(
        'legacy_table_name_collision', 'Legacy lookup table name is ambiguous',
        format('lookup model `%s` collides with the generic substrate', model_id)
      );
    end if;

    select * into authority_row
    from lookup_storage_authority authority
    where authority.app_id = app_id
      and authority.customer_id = customer_id
      and authority.model_id = model_id;
    if not found and (
      exists(
        select 1 from lookup_record generic_record
        where generic_record.app_id = app_id
          and generic_record.customer_id = customer_id
          and generic_record.model_id = model_id
      ) or exists(
        select 1 from lookup_version generic_version
        where generic_version.app_id = app_id
          and generic_version.customer_id = customer_id
          and generic_version.model_id = model_id
      )
    ) then
      -- Older native installers omitted authority when empty legacy tables
      -- existed. Recover only history fully attributed to immutable applied seeds.
      -- Hold writers while checking provenance and publishing the missing authority.
      begin
      lock table lookup_record, lookup_version, lookup_storage_authority, installed_seed, change_set in share row exclusive mode nowait;
      recovery_has_typed_history := false;
      for target_model_column in select unnest(array[record_table, version_table]) loop
        if to_regclass(format('%I.%I', current_schema(), target_model_column)) is not null then
          execute format('lock table %I in share row exclusive mode nowait', target_model_column);
          execute format('select exists(select 1 from %I where app_id=$1 and customer_id=$2)', target_model_column)
            into has_data using app_id, customer_id;
          recovery_has_typed_history := recovery_has_typed_history or has_data;
        end if;
      end loop;
      recovery_seeds := null;
      if not recovery_has_typed_history then
        select installation.seed_change_sets into recovery_seeds
        from schema_installation_revision installation
        join schema_revision revision on revision.id=installation.schema_revision_id
        where installation.app_id=app_id and installation.customer_id=customer_id
          and installation.schema_revision_id=schema_revision_id
          and installation.activated_at is not null and revision.activated_at is not null
          and revision.app_id=app_id and revision.customer_id=customer_id
          and installation.effective_artifact_hash=expected_schema_hash
          and revision.schema_hash=expected_schema_hash
        for share of installation, revision nowait;
      end if;
      recovered_first_write := null;
      if recovery_seeds is not null then
        with seed_writes as (
          select template.value as template, write.value as seed_write,
            (template.value->'seed_record_ids'->>(write.ordinality::integer-1))::uuid as record_id
          from jsonb_array_elements(recovery_seeds) template(value)
          cross join lateral jsonb_array_elements(template.value->'writes') with ordinality write(value,ordinality)
          where write.value->>'model_id'=model_id
        ), verified as (
          select seed.record_id, ledger.change_set_id, changes.applied_at
          from seed_writes seed
          join installed_seed ledger on ledger.app_id=app_id and ledger.customer_id=customer_id
            and ledger.seed_identity=seed.template->>'seed_identity'
          join change_set changes on changes.id=ledger.change_set_id
            and changes.app_id=app_id and changes.customer_id=customer_id
          where ledger.install_status='applied'
            and ledger.payload_fingerprint=kernel_admin_sha256(kernel_canonical_json(seed.template))
            and ledger.source_idempotency_key=seed.template->>'idempotency_key'
            and ledger.seed_record_ids=array(select value::uuid from jsonb_array_elements_text(seed.template->'seed_record_ids'))
            and changes.schema_revision_id=schema_revision_id
            and changes.idempotency_key=ledger.source_idempotency_key
            and changes.status='mainline' and changes.applied_order is not null and changes.applied_at is not null
        )
        select min(verified.applied_at) into recovered_first_write
        from verified
        where not exists (
          select 1 from lookup_record record
          where record.app_id=app_id and record.customer_id=customer_id and record.model_id=model_id
            and not exists(select 1 from verified seed where seed.record_id=record.id)
        ) and not exists (
          select 1 from lookup_version version
          where version.app_id=app_id and version.customer_id=customer_id and version.model_id=model_id
            and (not exists(select 1 from verified seed where seed.record_id=version.record_id and seed.change_set_id=version.change_set_id)
              or not exists(select 1 from lookup_record record where record.app_id=app_id and record.customer_id=customer_id and record.model_id=model_id and record.id=version.record_id))
        ) and exists (
          select 1 from lookup_version version where version.app_id=app_id and version.customer_id=customer_id and version.model_id=model_id
        ) and (select count(*) from lookup_version version where version.app_id=app_id and version.customer_id=customer_id and version.model_id=model_id)=(select count(*) from verified)
          and (select count(*) from lookup_record record where record.app_id=app_id and record.customer_id=customer_id and record.model_id=model_id)=(select count(distinct record_id) from verified)
          and not exists(select 1 from lookup_storage_authority authority where authority.app_id=app_id and authority.customer_id=customer_id and authority.model_id=model_id);
      end if;
      if recovered_first_write is null then
        return kernel_lookup_migration_error(
          'lookup_migration_forward_only', 'Generic lookup authority is forward-only',
          format('lookup model `%s` already contains generic data without a typed authority row', model_id)
        );
      end if;
      insert into lookup_storage_authority(
        app_id,customer_id,model_id,schema_hash,authority,legacy_record_table,legacy_version_table,activated_at,first_generic_write_at
      ) values(app_id,customer_id,model_id,expected_schema_hash,'generic','lookup_record','lookup_version',now(),recovered_first_write)
      on conflict on constraint lookup_storage_authority_pkey do nothing;
      select * into authority_row from lookup_storage_authority authority
      where authority.app_id=app_id and authority.customer_id=customer_id and authority.model_id=model_id;
      exception when lock_not_available then
        return kernel_lookup_migration_error(
          'lookup_recovery_busy', 'Lookup authority recovery is busy',
          'another database writer is active; retry normal lookup preparation after it completes'
        );
      end;

    end if;
    if found and authority_row.authority = 'generic' then
      if authority_row.schema_hash <> expected_schema_hash then
        if exists(
          select 1
          from schema_installation_revision installation
          join schema_revision revision on revision.id = installation.schema_revision_id
          where installation.schema_revision_id = schema_revision_id
            and installation.app_id = app_id
            and installation.customer_id = customer_id
            and installation.activated_at is not null
            and installation.effective_artifact_hash = expected_schema_hash
            and revision.schema_hash = expected_schema_hash
            and exists (
              select 1
              from lookup_migration_revision prior_migration
              where prior_migration.app_id = app_id
                and prior_migration.customer_id = customer_id
                and prior_migration.schema_hash = authority_row.schema_hash
                and prior_migration.status = 'active'
            )
        ) or exists(
          select 1
          from schema_revision prior_revision
          where prior_revision.app_id = app_id
            and prior_revision.customer_id = customer_id
            and prior_revision.schema_hash = authority_row.schema_hash
            and kernel_installer_default_model_kind(prior_revision.schema) - 'version'
              = schema_json - 'version'
        ) then
          update lookup_storage_authority authority
          set schema_hash = expected_schema_hash
          where authority.app_id = app_id
            and authority.customer_id = customer_id
            and authority.model_id = model_id
            and authority.authority = 'generic'
            and authority.schema_hash = authority_row.schema_hash;
        else
          return kernel_lookup_migration_error(
            'lookup_migration_forward_only', 'Generic lookup authority is forward-only',
            format('lookup model `%s` is already generic under a different schema hash', model_id)
          );
        end if;
      end if;
      -- Recover absent identities before comparing the shadow, without
      -- rewriting existing identities, versions, or projections. Identity-only
      -- loss must not replay already-migrated history through current write
      -- validation. Retained typed tables may be gone after a completed release.
      if to_regclass(format('%I.%I', current_schema(), record_table)) is not null then
        execute format(
          'insert into lookup_record(app_id, customer_id, model_id, id, external_key, created_at) '
          || 'select $1, $2, $3, record.id, record.external_key, record.created_at '
          || 'from %I record '
          || 'where record.app_id = $1 and record.customer_id = $2 '
          || 'on conflict on constraint lookup_record_pkey do nothing',
          record_table
        ) using app_id, customer_id, model_id;
      end if;
      -- Generic authority remains forward-only after its first generic write.
      if authority_row.first_generic_write_at is not null then
        continue;
      end if;
      if to_regclass(format('%I.%I', current_schema(), record_table)) is null
        or to_regclass(format('%I.%I', current_schema(), version_table)) is null
      then
        return kernel_lookup_migration_error(
          'legacy_lookup_table_missing', 'Legacy lookup storage is missing',
          format('typed tables for lookup model `%s` are not available', model_id)
        );
      end if;
      evidence := kernel_lookup_migration_model_evidence(app_id, customer_id, model_id, model_json);
      if coalesce((evidence->>'matches')::boolean, false) then
        continue;
      end if;
      update lookup_migration_phase
      set status = 'pending', cursor_id = null, completed_at = null, last_error = null
      where lookup_migration_phase.app_id = app_id
        and lookup_migration_phase.customer_id = customer_id
        and lookup_migration_phase.schema_hash = expected_schema_hash
        and lookup_migration_phase.model_id = model_id;
    end if;

    if to_regclass(format('%I.%I', current_schema(), record_table)) is null
      or to_regclass(format('%I.%I', current_schema(), version_table)) is null
    then
      return kernel_lookup_migration_error(
        'legacy_lookup_table_missing', 'Legacy lookup storage is missing',
        format('typed tables for lookup model `%s` are not available', model_id)
      );
    end if;

    insert into lookup_storage_authority(
      app_id, customer_id, model_id, schema_hash, authority,
      legacy_record_table, legacy_version_table
    ) values (
      app_id, customer_id, model_id, expected_schema_hash, 'typed',
      record_table, version_table
    )
    on conflict on constraint lookup_storage_authority_pkey do update
    set schema_hash = excluded.schema_hash,
        legacy_record_table = excluded.legacy_record_table,
        legacy_version_table = excluded.legacy_version_table
    where lookup_storage_authority.authority = 'typed';

    expected_columns := array[
      'id', 'record_id', 'app_id', 'customer_id', 'stage', 'effective_start',
      'effective_end', 'change_set_id', 'created_at', 'applied_at',
      'tombstones_record', 'untombstones_record', 'provenance', 'custom_fields',
      'metadata', 'many_relations', 'availability', 'values'
    ];
    for column_row in
      select value
      from jsonb_array_elements(coalesce(model_json->'fields', '[]'::jsonb)) item(value)
    loop
      if column_row.value->>'type' = 'money_rate' then
        expected_columns := expected_columns || array[
          kernel_physical_identifier((column_row.value->>'id') || '_amount'),
          kernel_physical_identifier((column_row.value->>'id') || '_currency'),
          kernel_physical_identifier((column_row.value->>'id') || '_period')
        ];
      else
        expected_columns := expected_columns || kernel_physical_identifier(column_row.value->>'id');
      end if;
      if column_row.value->>'type' = 'relation' then
        target_model_column := kernel_physical_identifier((column_row.value->>'id') || '_target_model');
        expected_columns := expected_columns || target_model_column;
        if exists (
          select 1 from information_schema.columns
          where table_schema = current_schema() and table_name = version_table
            and column_name = target_model_column
        ) then
          execute format(
            'select exists(select 1 from %I where app_id = $1 and customer_id = $2 and %I is not null and %I <> $3)',
            version_table, target_model_column, target_model_column
          ) using app_id, customer_id, column_row.value->>'target_model' into has_data;
          if has_data then
            return kernel_lookup_migration_error(
              'legacy_relation_target_mismatch', 'Legacy relation target cannot be represented',
              format('relation `%s.%s` contains a target-model discriminator that differs from `%s`', model_id, column_row.value->>'id', column_row.value->>'target_model')
            );
          end if;
        end if;
      end if;
    end loop;
    for column_row in
      select column_name
      from information_schema.columns
      where table_schema = current_schema()
        and table_name = version_table
        and not (column_name = any(expected_columns))
      order by ordinal_position
    loop
      execute format(
        'select exists(select 1 from %I where app_id = $1 and customer_id = $2 and %I is not null)',
        version_table, column_row.column_name
      ) using app_id, customer_id into has_data;
      if has_data then
        return kernel_lookup_migration_error(
          'unclassified_legacy_column', 'Legacy lookup data cannot be represented',
          format('column `%s.%s` contains data but is absent from the logical lookup model', version_table, column_row.column_name)
        );
      end if;
    end loop;

    insert into lookup_migration_phase(
      app_id, customer_id, schema_hash, model_id, phase
    )
    select app_id, customer_id, expected_schema_hash, model_id, phase
    from unnest(array['records', 'versions', 'projections', 'verify']) phase
    on conflict do nothing;
  end loop;

  -- Establish typed authority before reconciliation. The reconciliation may
  -- create value-free generic identities retained by typed entity history;
  -- those identities are migration input, not evidence of prior generic
  -- authority.
  perform kernel_reconcile_lookup_foreign_key_targets(app_id, customer_id);

  -- Records for every model must exist before relation-bearing versions are copied.
  for model_json in
    select value from jsonb_array_elements(coalesce(schema_json->'models', '[]'::jsonb)) item(value)
    where coalesce(value->>'kind', 'entity') = 'lookup'
    order by value->>'id'
  loop
    model_id := model_json->>'id';
    select * into authority_row from lookup_storage_authority authority
    where authority.app_id = app_id and authority.customer_id = customer_id
      and authority.model_id = model_id;
    if authority_row.authority = 'generic' and authority_row.first_generic_write_at is not null then continue; end if;
    record_table := authority_row.legacy_record_table;
    select * into phase_row from lookup_migration_phase phase
    where phase.app_id = app_id and phase.customer_id = customer_id
      and phase.schema_hash = expected_schema_hash and phase.model_id = model_id
      and phase.phase = 'records';
    if phase_row.status = 'complete' then continue; end if;
    update lookup_migration_phase set status = 'running', attempts = attempts + 1,
      started_at = coalesce(started_at, now()), last_error = null
    where lookup_migration_phase.app_id = app_id
      and lookup_migration_phase.customer_id = customer_id
      and lookup_migration_phase.schema_hash = expected_schema_hash
      and lookup_migration_phase.model_id = model_id
      and phase = 'records';
    row_count := 0;
    cursor_value := phase_row.cursor_id;
    begin
      for row_data in execute format(
        'select to_jsonb(r) from %I r where r.app_id = $1 and r.customer_id = $2 and ($3::uuid is null or r.id > $3) order by r.id limit $4',
        record_table
      ) using app_id, customer_id, cursor_value, batch_size
      loop
        insert into lookup_record(app_id, customer_id, model_id, id, external_key, created_at)
        values (
          app_id, customer_id, model_id, (row_data->>'id')::uuid,
          row_data->>'external_key', (row_data->>'created_at')::timestamptz
        )
        on conflict on constraint lookup_record_pkey do update
        set external_key = excluded.external_key, created_at = excluded.created_at;
        cursor_value := (row_data->>'id')::uuid;
        row_count := row_count + 1;
      end loop;
      update lookup_migration_phase
      set cursor_id = cursor_value,
          status = case when row_count < batch_size then 'complete' else 'running' end,
          completed_at = case when row_count < batch_size then now() else null end
      where lookup_migration_phase.app_id = app_id
        and lookup_migration_phase.customer_id = customer_id
        and lookup_migration_phase.schema_hash = expected_schema_hash
        and lookup_migration_phase.model_id = model_id and phase = 'records';
    exception when others then
      update lookup_migration_phase set status = 'failed', last_error = sqlstate || ': ' || sqlerrm
      where lookup_migration_phase.app_id = app_id
        and lookup_migration_phase.customer_id = customer_id
        and lookup_migration_phase.schema_hash = expected_schema_hash
        and lookup_migration_phase.model_id = model_id and phase = 'records';
      update lookup_migration_revision set status = 'failed', updated_at = now()
      where lookup_migration_revision.app_id = app_id
        and lookup_migration_revision.customer_id = customer_id
        and lookup_migration_revision.schema_hash = expected_schema_hash;
      return kernel_lookup_migration_error(
        'lookup_record_backfill_failed', 'Lookup record backfill failed',
        format('lookup model `%s`: %s', model_id, sqlerrm)
      );
    end;
  end loop;
  if exists(
    select 1 from lookup_migration_phase
    where lookup_migration_phase.app_id = app_id
      and lookup_migration_phase.customer_id = customer_id
      and lookup_migration_phase.schema_hash = expected_schema_hash
      and phase = 'records' and status <> 'complete'
  ) then
    return jsonb_build_object('ok', true, 'data', jsonb_build_object(
      'ready', false, 'phase', 'records', 'schema_hash', expected_schema_hash
    ));
  end if;

  for model_json in
    select value from jsonb_array_elements(coalesce(schema_json->'models', '[]'::jsonb)) item(value)
    where coalesce(value->>'kind', 'entity') = 'lookup'
    order by value->>'id'
  loop
    model_id := model_json->>'id';
    select * into authority_row from lookup_storage_authority authority
    where authority.app_id = app_id and authority.customer_id = customer_id
      and authority.model_id = model_id;
    if authority_row.authority = 'generic' and authority_row.first_generic_write_at is not null then continue; end if;
    version_table := authority_row.legacy_version_table;
    select * into phase_row from lookup_migration_phase phase
    where phase.app_id = app_id and phase.customer_id = customer_id
      and phase.schema_hash = expected_schema_hash and phase.model_id = model_id
      and phase.phase = 'versions';
    if phase_row.status = 'complete' then continue; end if;
    update lookup_migration_phase set status = 'running', attempts = attempts + 1,
      started_at = coalesce(started_at, now()), last_error = null
    where lookup_migration_phase.app_id = app_id
      and lookup_migration_phase.customer_id = customer_id
      and lookup_migration_phase.schema_hash = expected_schema_hash
      and lookup_migration_phase.model_id = model_id and phase = 'versions';
    row_count := 0;
    cursor_value := phase_row.cursor_id;
    begin
      for row_data in execute format(
        'select to_jsonb(v) from %I v where v.app_id = $1 and v.customer_id = $2 and ($3::uuid is null or v.id > $3) order by v.id limit $4',
        version_table
      ) using app_id, customer_id, cursor_value, batch_size
      loop
        snapshot := kernel_lookup_migration_snapshot(row_data, model_json);
        insert into lookup_version(
          id, app_id, customer_id, model_id, record_id, stage,
          effective_start, effective_end, change_set_id, created_at, applied_at,
          tombstones_record, untombstones_record, availability, provenance,
          custom_fields, metadata, many_relations, values
        ) values (
          (row_data->>'id')::uuid, app_id, customer_id, model_id,
          (row_data->>'record_id')::uuid, row_data->>'stage',
          (row_data->>'effective_start')::date,
          (row_data->>'effective_end')::date,
          (row_data->>'change_set_id')::bigint,
          (row_data->>'created_at')::timestamptz,
          (row_data->>'applied_at')::timestamptz,
          coalesce((row_data->>'tombstones_record')::boolean, false),
          coalesce((row_data->>'untombstones_record')::boolean, false),
          coalesce(row_data->>'availability', 'active'),
          row_data->'provenance',
          coalesce(row_data->'custom_fields', '[]'::jsonb),
          coalesce(row_data->'metadata', '{}'::jsonb),
          coalesce(row_data->'many_relations', '{}'::jsonb),
          snapshot
        )
        on conflict on constraint lookup_version_pkey do update set
          record_id = excluded.record_id,
          stage = excluded.stage,
          effective_start = excluded.effective_start,
          effective_end = excluded.effective_end,
          change_set_id = excluded.change_set_id,
          created_at = excluded.created_at,
          applied_at = excluded.applied_at,
          tombstones_record = excluded.tombstones_record,
          untombstones_record = excluded.untombstones_record,
          availability = excluded.availability,
          provenance = excluded.provenance,
          custom_fields = excluded.custom_fields,
          metadata = excluded.metadata,
          many_relations = excluded.many_relations,
          values = excluded.values;
        cursor_value := (row_data->>'id')::uuid;
        row_count := row_count + 1;
      end loop;
      update lookup_migration_phase
      set cursor_id = cursor_value,
          status = case when row_count < batch_size then 'complete' else 'running' end,
          completed_at = case when row_count < batch_size then now() else null end
      where lookup_migration_phase.app_id = app_id
        and lookup_migration_phase.customer_id = customer_id
        and lookup_migration_phase.schema_hash = expected_schema_hash
        and lookup_migration_phase.model_id = model_id and phase = 'versions';
    exception when others then
      update lookup_migration_phase set status = 'failed', last_error = sqlstate || ': ' || sqlerrm
      where lookup_migration_phase.app_id = app_id
        and lookup_migration_phase.customer_id = customer_id
        and lookup_migration_phase.schema_hash = expected_schema_hash
        and lookup_migration_phase.model_id = model_id and phase = 'versions';
      update lookup_migration_revision set status = 'failed', updated_at = now()
      where lookup_migration_revision.app_id = app_id
        and lookup_migration_revision.customer_id = customer_id
        and lookup_migration_revision.schema_hash = expected_schema_hash;
      return kernel_lookup_migration_error(
        'lookup_version_backfill_failed', 'Lookup history backfill failed',
        format('lookup model `%s`: %s', model_id, sqlerrm)
      );
    end;
  end loop;
  if exists(
    select 1 from lookup_migration_phase
    where lookup_migration_phase.app_id = app_id
      and lookup_migration_phase.customer_id = customer_id
      and lookup_migration_phase.schema_hash = expected_schema_hash
      and phase = 'versions' and status <> 'complete'
  ) then
    return jsonb_build_object('ok', true, 'data', jsonb_build_object(
      'ready', false, 'phase', 'versions', 'schema_hash', expected_schema_hash
    ));
  end if;

  for model_json in
    select value from jsonb_array_elements(coalesce(schema_json->'models', '[]'::jsonb)) item(value)
    where coalesce(value->>'kind', 'entity') = 'lookup'
    order by value->>'id'
  loop
    model_id := model_json->>'id';
    select * into authority_row from lookup_storage_authority authority
    where authority.app_id = app_id and authority.customer_id = customer_id
      and authority.model_id = model_id;
    if authority_row.authority = 'generic' and authority_row.first_generic_write_at is not null then continue; end if;
    select * into phase_row from lookup_migration_phase phase
    where phase.app_id = app_id and phase.customer_id = customer_id
      and phase.schema_hash = expected_schema_hash and phase.model_id = model_id
      and phase.phase = 'projections';
    if phase_row.status = 'complete' then continue; end if;
    update lookup_migration_phase set status = 'running', attempts = attempts + 1,
      started_at = coalesce(started_at, now()), last_error = null
    where lookup_migration_phase.app_id = app_id
      and lookup_migration_phase.customer_id = customer_id
      and lookup_migration_phase.schema_hash = expected_schema_hash
      and lookup_migration_phase.model_id = model_id and phase = 'projections';
    row_count := 0;
    cursor_value := phase_row.cursor_id;
    begin
      for row_data in
        select to_jsonb(v)
        from lookup_version v
        where v.app_id = app_id and v.customer_id = customer_id
          and v.model_id = model_id
          and (cursor_value is null or v.id > cursor_value)
        order by v.id limit batch_size
      loop
        projected_is_current := false;
        perform kernel_apply_project_lookup_version(
          (row_data->>'id')::uuid, app_id, customer_id, model_id,
          (row_data->>'record_id')::uuid, schema_json, model_json,
          row_data->'values', row_data->'many_relations', projected_is_current
        );
        cursor_value := (row_data->>'id')::uuid;
        row_count := row_count + 1;
      end loop;
      update lookup_migration_phase
      set cursor_id = cursor_value,
          status = case when row_count < batch_size then 'complete' else 'running' end,
          completed_at = case when row_count < batch_size then now() else null end
      where lookup_migration_phase.app_id = app_id
        and lookup_migration_phase.customer_id = customer_id
        and lookup_migration_phase.schema_hash = expected_schema_hash
        and lookup_migration_phase.model_id = model_id and phase = 'projections';
    exception when others then
      update lookup_migration_phase set status = 'failed', last_error = sqlstate || ': ' || sqlerrm
      where lookup_migration_phase.app_id = app_id
        and lookup_migration_phase.customer_id = customer_id
        and lookup_migration_phase.schema_hash = expected_schema_hash
        and lookup_migration_phase.model_id = model_id and phase = 'projections';
      update lookup_migration_revision set status = 'failed', updated_at = now()
      where lookup_migration_revision.app_id = app_id
        and lookup_migration_revision.customer_id = customer_id
        and lookup_migration_revision.schema_hash = expected_schema_hash;
      return kernel_lookup_migration_error(
        'lookup_projection_backfill_failed', 'Lookup projection backfill failed',
        format('lookup model `%s`: %s', model_id, sqlerrm)
      );
    end;
  end loop;
  if exists(
    select 1 from lookup_migration_phase
    where lookup_migration_phase.app_id = app_id
      and lookup_migration_phase.customer_id = customer_id
      and lookup_migration_phase.schema_hash = expected_schema_hash
      and phase = 'projections' and status <> 'complete'
  ) then
    return jsonb_build_object('ok', true, 'data', jsonb_build_object(
      'ready', false, 'phase', 'projections', 'schema_hash', expected_schema_hash
    ));
  end if;

  begin
    update lookup_alias_projection alias_projection
    set is_current = false
    where alias_projection.app_id = app_id
      and alias_projection.customer_id = customer_id
      and alias_projection.model_id in (
        select value->>'id'
        from jsonb_array_elements(coalesce(schema_json->'models', '[]'::jsonb)) item(value)
        where coalesce(value->>'kind', 'entity') = 'lookup'
      );
    update lookup_alias_projection alias_projection
    set is_current = true
    where alias_projection.app_id = app_id
      and alias_projection.customer_id = customer_id
      and (alias_projection.model_id, alias_projection.version_id) in (
        select visible.model_id, visible.id
        from (
          select distinct on (version.model_id, version.record_id)
            version.id, version.model_id, version.record_id
          from lookup_version version
          join change_set changes
            on changes.id = version.change_set_id
           and changes.app_id = version.app_id
           and changes.customer_id = version.customer_id
          where version.app_id = app_id
            and version.customer_id = customer_id
            and version.stage = 'mainline'
            and changes.status = 'mainline'
            and changes.applied_order is not null
            and version.effective_start <= current_date
            and (version.effective_end is null or version.effective_end >= current_date)
            and not version.tombstones_record
            and not version.untombstones_record
            and version.availability = 'active'
          order by version.model_id, version.record_id,
            version.effective_start desc, changes.applied_order desc, version.id desc
        ) visible
      );
  exception when unique_violation then
    update lookup_migration_revision set status = 'failed', updated_at = now()
    where lookup_migration_revision.app_id = app_id
      and lookup_migration_revision.customer_id = customer_id
      and lookup_migration_revision.schema_hash = expected_schema_hash;
    return kernel_lookup_migration_error(
      'lookup_alias_ambiguity', 'Lookup aliases are ambiguous',
      'active normalized lookup names or aliases collide within a model'
    );
  end;

  for model_json in
    select value from jsonb_array_elements(coalesce(schema_json->'models', '[]'::jsonb)) item(value)
    where coalesce(value->>'kind', 'entity') = 'lookup'
    order by value->>'id'
  loop
    model_id := model_json->>'id';
    select * into authority_row from lookup_storage_authority authority
    where authority.app_id = app_id and authority.customer_id = customer_id
      and authority.model_id = model_id;
    if authority_row.authority = 'generic' and authority_row.first_generic_write_at is not null then continue; end if;
    evidence := kernel_lookup_migration_model_evidence(app_id, customer_id, model_id, model_json);
    update lookup_migration_phase
    set status = case when (evidence->>'matches')::boolean then 'complete' else 'failed' end,
        attempts = attempts + 1,
        started_at = coalesce(started_at, now()),
        completed_at = case when (evidence->>'matches')::boolean then now() else null end,
        evidence = prepare_lookup_migration.evidence,
        last_error = case when (evidence->>'matches')::boolean then null else 'canonical source and target evidence differs' end
    where lookup_migration_phase.app_id = app_id
      and lookup_migration_phase.customer_id = customer_id
      and lookup_migration_phase.schema_hash = expected_schema_hash
      and lookup_migration_phase.model_id = model_id and phase = 'verify';
    if not (evidence->>'matches')::boolean then
      update lookup_migration_revision set status = 'failed', updated_at = now()
      where lookup_migration_revision.app_id = app_id
        and lookup_migration_revision.customer_id = customer_id
        and lookup_migration_revision.schema_hash = expected_schema_hash;
      return kernel_lookup_migration_error(
        'lookup_migration_mismatch', 'Lookup migration evidence differs',
        format('lookup model `%s` record or history count/hash differs', model_id)
      );
    end if;
  end loop;

  update lookup_migration_revision
  set status = 'ready', prepared_at = coalesce(prepared_at, now()), updated_at = now()
  where lookup_migration_revision.app_id = app_id
    and lookup_migration_revision.customer_id = customer_id
    and lookup_migration_revision.schema_hash = expected_schema_hash
    and status <> 'active';
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'ready', true, 'phase', 'verify', 'schema_hash', expected_schema_hash
  ));
end;
$kernel_lookup_migration$;
"#;

const VALIDATE_MIGRATION: &str = r#"
create or replace function kernel_validate_lookup_migration(request jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path from current
as $kernel_lookup_migration$
#variable_conflict use_variable
declare
  app_id text := request->>'app_id';
  customer_id text := request->>'customer_id';
  schema_revision_id bigint;
  expected_schema_hash text := request->>'expected_schema_hash';
  schema_json jsonb;
  stored_schema_hash text;
  model_json jsonb;
  model_id text;
  authority_row record;
  evidence jsonb;
  model_results jsonb := '[]'::jsonb;
begin
  if request is null or jsonb_typeof(request) <> 'object'
    or request - array['app_id', 'customer_id', 'schema_revision_id', 'expected_schema_hash'] <> '{}'::jsonb
    or jsonb_typeof(request->'schema_revision_id') is distinct from 'number'
    or (request->>'schema_revision_id')::numeric <> trunc((request->>'schema_revision_id')::numeric)
    or (request->>'schema_revision_id')::numeric <= 0
    or (request->>'schema_revision_id')::numeric > 9223372036854775807
  then
    return kernel_lookup_migration_error(
      'contract_validation_failed', 'Lookup migration request is invalid',
      'validation accepts only app_id, customer_id, schema_revision_id, and expected_schema_hash'
    );
  end if;
  schema_revision_id := (request->>'schema_revision_id')::bigint;
  perform set_config('kernel.app_id', app_id, true);
  perform set_config('kernel.customer_id', customer_id, true);
  select revision.schema, revision.schema_hash
  into schema_json, stored_schema_hash
  from schema_revision revision
  where revision.id = schema_revision_id
    and revision.app_id = app_id
    and revision.customer_id = customer_id
    and revision.activated_at is not null;
  if schema_json is null or stored_schema_hash is distinct from expected_schema_hash then
    return kernel_lookup_migration_error(
      'stale_schema_hash', 'Schema revision or hash changed',
      'the requested schema revision cannot be validated'
    );
  end if;
  for model_json in
    select value from jsonb_array_elements(coalesce(schema_json->'models', '[]'::jsonb)) item(value)
    where coalesce(value->>'kind', 'entity') = 'lookup'
    order by value->>'id'
  loop
    model_id := model_json->>'id';
    select * into authority_row
    from lookup_storage_authority authority
    where authority.app_id = app_id
      and authority.customer_id = customer_id
      and authority.model_id = model_id;
    if authority_row.authority = 'generic'
      and authority_row.schema_hash = expected_schema_hash
      and authority_row.first_generic_write_at is not null
    then
      model_results := model_results || jsonb_build_array(
        jsonb_build_object('model_id', model_id, 'authority', 'generic', 'matches', true)
      );
      continue;
    end if;
    evidence := kernel_lookup_migration_model_evidence(app_id, customer_id, model_id, model_json);
    model_results := model_results || jsonb_build_array(
      jsonb_build_object('model_id', model_id, 'evidence', evidence)
    );
    if not coalesce((evidence->>'matches')::boolean, false) then
      return kernel_lookup_migration_error(
        'lookup_migration_mismatch', 'Lookup migration evidence differs',
        format('lookup model `%s` record or history count/hash differs', model_id)
      );
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'schema_hash', expected_schema_hash, 'models', model_results, 'matches', true
  ));
end;
$kernel_lookup_migration$;
"#;

const ACTIVATE_MIGRATION: &str = r#"
create or replace function kernel_activate_lookup_migration(request jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path from current
as $kernel_lookup_migration$
#variable_conflict use_variable
<<activate_lookup_migration>>
declare
  app_id text := request->>'app_id';
  customer_id text := request->>'customer_id';
  schema_revision_id bigint;
  expected_schema_hash text := request->>'expected_schema_hash';
  schema_json jsonb;
  stored_schema_hash text;
  migration_status text;
  model_json jsonb;
  model_id text;
  record_table text;
  version_table text;
  prepare_result jsonb;
  validate_result jsonb;
  attempts integer := 0;
begin
  if request is null or jsonb_typeof(request) <> 'object'
    or request - array['app_id', 'customer_id', 'schema_revision_id', 'expected_schema_hash'] <> '{}'::jsonb
    or jsonb_typeof(request->'schema_revision_id') is distinct from 'number'
    or (request->>'schema_revision_id')::numeric <> trunc((request->>'schema_revision_id')::numeric)
    or (request->>'schema_revision_id')::numeric <= 0
    or (request->>'schema_revision_id')::numeric > 9223372036854775807
    or expected_schema_hash is null or expected_schema_hash !~ '^[0-9a-f]{64}$'
  then
    return kernel_lookup_migration_error(
      'contract_validation_failed', 'Lookup activation request is invalid',
      'activation requires an exact schema revision and expected hash'
    );
  end if;
  schema_revision_id := (request->>'schema_revision_id')::bigint;
  perform set_config('kernel.app_id', app_id, true);
  perform set_config('kernel.customer_id', customer_id, true);
  perform pg_advisory_xact_lock(hashtext(
    'postgres-schema:' || current_schema() || ':materialize-tenant:' || app_id || ':' || customer_id || ':schema-activation'
  ));
  perform pg_advisory_xact_lock(hashtext(
    'postgres-schema:' || current_schema() || ':materialize-tenant:' || app_id || ':' || customer_id || ':lookup-migration'
  ));
  select revision.schema, revision.schema_hash
  into schema_json, stored_schema_hash
  from schema_revision revision
  where revision.id = schema_revision_id
    and revision.app_id = app_id
    and revision.customer_id = customer_id
    and revision.activated_at is not null;
  if schema_json is null or stored_schema_hash is distinct from expected_schema_hash then
    return kernel_lookup_migration_error(
      'stale_schema_hash', 'Schema revision or hash changed',
      'lookup authority was not changed'
    );
  end if;
  select status into migration_status
  from lookup_migration_revision revision
  where revision.app_id = app_id and revision.customer_id = customer_id
    and revision.schema_hash = expected_schema_hash;
  if migration_status = 'active' then
    return jsonb_build_object('ok', true, 'data', jsonb_build_object(
      'activated', true, 'idempotent', true, 'schema_hash', expected_schema_hash
    ));
  end if;
  if not exists(
    select 1
    from jsonb_array_elements(coalesce(schema_json->'models', '[]'::jsonb)) item(value)
    where coalesce(value->>'kind', 'entity') = 'lookup'
      and not exists(
        select 1 from lookup_storage_authority authority
        where authority.app_id = app_id
          and authority.customer_id = customer_id
          and authority.model_id = item.value->>'id'
          and authority.authority = 'generic'
          and authority.schema_hash = expected_schema_hash
      )
  ) then
    update lookup_migration_revision revision
    set status = 'active',
        prepared_at = coalesce(revision.prepared_at, now()),
        activated_at = coalesce(revision.activated_at, now()),
        updated_at = now()
    where revision.app_id = app_id
      and revision.customer_id = customer_id
      and revision.schema_hash = expected_schema_hash;
    return jsonb_build_object('ok', true, 'data', jsonb_build_object(
      'activated', true, 'idempotent', true, 'schema_hash', expected_schema_hash
    ));
  end if;
  if migration_status <> 'ready' then
    return kernel_lookup_migration_error(
      'lookup_migration_not_ready', 'Lookup migration is not ready',
      'prepare and validate the shadow copy before activation'
    );
  end if;

  begin
    execute 'lock table lookup_record in access exclusive mode';
    execute 'lock table lookup_version in access exclusive mode';
    execute 'lock table lookup_value_projection in access exclusive mode';
    execute 'lock table lookup_alias_projection in access exclusive mode';
    execute 'lock table lookup_relation_projection in access exclusive mode';
    for model_json in
      select value from jsonb_array_elements(coalesce(schema_json->'models', '[]'::jsonb)) item(value)
      where coalesce(value->>'kind', 'entity') = 'lookup'
      order by value->>'id'
    loop
      model_id := model_json->>'id';
      select legacy_record_table, legacy_version_table
      into record_table, version_table
      from lookup_storage_authority authority
      where authority.app_id = app_id and authority.customer_id = customer_id
        and authority.model_id = model_id and authority.authority = 'typed'
        and authority.schema_hash = expected_schema_hash;
      if record_table is null or version_table is null then
        raise exception 'typed authority for lookup model `%` is missing', model_id;
      end if;
      execute format('lock table %I in access exclusive mode', record_table);
      execute format('lock table %I in access exclusive mode', version_table);
      if not exists (
        select 1 from pg_trigger
        where tgrelid = to_regclass(format('%I.%I', current_schema(), record_table))
          and tgname = 'lookup_migration_write_block' and not tgisinternal
      ) then
        execute format(
          'create trigger lookup_migration_write_block before insert or update or delete or truncate on %I for each statement execute function kernel_lookup_migration_block_legacy_write()',
          record_table
        );
      end if;
      if not exists (
        select 1 from pg_trigger
        where tgrelid = to_regclass(format('%I.%I', current_schema(), version_table))
          and tgname = 'lookup_migration_write_block' and not tgisinternal
      ) then
        execute format(
          'create trigger lookup_migration_write_block before insert or update or delete or truncate on %I for each statement execute function kernel_lookup_migration_block_legacy_write()',
          version_table
        );
      end if;
    end loop;

    -- Reset cursors and replay under the barrier so late typed writes are included.
    update lookup_migration_phase
    set status = 'pending', cursor_id = null, completed_at = null, last_error = null
    where lookup_migration_phase.app_id = app_id
      and lookup_migration_phase.customer_id = customer_id
      and lookup_migration_phase.schema_hash = expected_schema_hash;
    update lookup_migration_revision set status = 'preparing', updated_at = now()
    where lookup_migration_revision.app_id = app_id
      and lookup_migration_revision.customer_id = customer_id
      and lookup_migration_revision.schema_hash = expected_schema_hash;
    loop
      attempts := attempts + 1;
      if attempts > 100000 then
        raise exception 'lookup migration catch-up exceeded the phase iteration bound';
      end if;
      prepare_result := kernel_prepare_lookup_migration(jsonb_build_object(
        'app_id', app_id,
        'customer_id', customer_id,
        'schema_revision_id', schema_revision_id,
        'expected_schema_hash', expected_schema_hash,
        'batch_size', 10000
      ));
      if not coalesce((prepare_result->>'ok')::boolean, false) then
        raise exception 'catch-up failed: %', prepare_result::text;
      end if;
      exit when coalesce((prepare_result#>>'{data,ready}')::boolean, false);
    end loop;
    validate_result := kernel_validate_lookup_migration(jsonb_build_object(
      'app_id', app_id,
      'customer_id', customer_id,
      'schema_revision_id', schema_revision_id,
      'expected_schema_hash', expected_schema_hash
    ));
    if not coalesce((validate_result->>'ok')::boolean, false) then
      raise exception 'final validation failed: %', validate_result::text;
    end if;

    update lookup_storage_authority
    set authority = 'generic', activated_at = now(), schema_hash = expected_schema_hash
    where lookup_storage_authority.app_id = app_id
      and lookup_storage_authority.customer_id = customer_id
      and lookup_storage_authority.schema_hash = expected_schema_hash
      and authority = 'typed';
    update lookup_migration_revision
    set status = 'active', activated_at = now(), updated_at = now()
    where lookup_migration_revision.app_id = app_id
      and lookup_migration_revision.customer_id = customer_id
      and lookup_migration_revision.schema_hash = expected_schema_hash;
  exception when others then
    return kernel_lookup_migration_error(
      'lookup_migration_activation_failed', 'Lookup authority activation failed',
      'typed authority remains active: ' || sqlerrm
    );
  end;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'activated', true, 'idempotent', false, 'schema_hash', expected_schema_hash,
    'catch_up_iterations', attempts
  ));
end;
$kernel_lookup_migration$;
"#;

const MIGRATION_STATUS: &str = r#"
create or replace function kernel_lookup_migration_status(request jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path from current
as $kernel_lookup_migration$
#variable_conflict use_variable
declare
  app_id text := request->>'app_id';
  customer_id text := request->>'customer_id';
  requested_schema_hash text := request->>'schema_hash';
  revision_json jsonb;
  phase_json jsonb;
  authority_json jsonb;
begin
  if request is null or jsonb_typeof(request) <> 'object'
    or request - array['app_id', 'customer_id', 'schema_hash'] <> '{}'::jsonb
  then
    return kernel_lookup_migration_error(
      'contract_validation_failed', 'Lookup migration status request is invalid',
      'status accepts only app_id, customer_id, and schema_hash'
    );
  end if;
  perform set_config('kernel.app_id', app_id, true);
  perform set_config('kernel.customer_id', customer_id, true);
  select to_jsonb(revision) into revision_json
  from lookup_migration_revision revision
  where revision.app_id = app_id and revision.customer_id = customer_id
    and revision.schema_hash = requested_schema_hash;
  select coalesce(jsonb_agg(to_jsonb(phase) order by phase.model_id, phase.phase), '[]'::jsonb)
  into phase_json
  from lookup_migration_phase phase
  where phase.app_id = app_id and phase.customer_id = customer_id
    and phase.schema_hash = requested_schema_hash;
  select coalesce(jsonb_agg(to_jsonb(authority) order by authority.model_id), '[]'::jsonb)
  into authority_json
  from lookup_storage_authority authority
  where authority.app_id = app_id and authority.customer_id = customer_id;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'revision', revision_json, 'phases', phase_json, 'authorities', authority_json
  ));
end;
$kernel_lookup_migration$;
"#;
