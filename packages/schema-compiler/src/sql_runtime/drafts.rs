use super::RuntimeSqlFunction;

pub(super) fn functions() -> Vec<RuntimeSqlFunction> {
    vec![
        RuntimeSqlFunction {
            signature: "kernel_draft_runtime_helpers",
            sql: DRAFT_RUNTIME_HELPERS.to_string(),
        },
        RuntimeSqlFunction {
            signature: "kernel_list_draft_change_sets(jsonb)",
            sql: LIST_DRAFT_CHANGE_SETS.to_string(),
        },
        RuntimeSqlFunction {
            signature: "kernel_read_draft_change_set(jsonb)",
            sql: READ_DRAFT_CHANGE_SET.to_string(),
        },
        RuntimeSqlFunction {
            signature: "kernel_update_draft_notes(jsonb)",
            sql: UPDATE_DRAFT_NOTES.to_string(),
        },
        RuntimeSqlFunction {
            signature: "kernel_discard_draft_change_set(jsonb)",
            sql: DISCARD_DRAFT_CHANGE_SET.to_string(),
        },
        RuntimeSqlFunction {
            signature: "kernel_approve_draft_change_set(jsonb)",
            sql: APPROVE_DRAFT_CHANGE_SET.to_string(),
        },
        RuntimeSqlFunction {
            signature: "kernel_draft_threads(jsonb)",
            sql: DRAFT_THREADS.to_string(),
        },
        RuntimeSqlFunction {
            signature: "kernel_revert_change_set(jsonb)",
            sql: REVERT_CHANGE_SET.to_string(),
        },
    ]
}

const DRAFT_RUNTIME_HELPERS: &str = r#"
create or replace function kernel_draft_ok(data jsonb)
returns jsonb language sql immutable parallel safe
as $kernel$ select jsonb_build_object('ok', true, 'data', data) $kernel$;

create or replace function kernel_draft_error(code text, message text, details jsonb default '[]'::jsonb)
returns jsonb language sql immutable parallel safe
as $kernel$
  select jsonb_build_object(
    'ok', false,
    'error', jsonb_build_object('code', code, 'message', message, 'details', details)
  )
$kernel$;

create or replace function kernel_draft_fail(code text, message text, details jsonb default '[]'::jsonb)
returns void language plpgsql volatile
as $kernel$
begin
  raise exception using
    errcode = 'AR001',
    message = kernel_draft_error(code, message, details)::text;
end
$kernel$;

create or replace function kernel_draft_contract_error(path text, code text, message text)
returns jsonb language sql immutable parallel safe
as $kernel$
  select kernel_draft_error(
    'contract_validation_failed',
    'Contract validation failed',
    jsonb_build_array(jsonb_build_object('path', path, 'code', code, 'message', message))
  )
$kernel$;

create or replace function kernel_draft_require_scope(app_id text, customer_id text)
returns void language plpgsql volatile
as $kernel$
declare
  policy_snapshot jsonb;
begin
  if not kernel_principal_scope_authorized('runtime', app_id, customer_id, null) then
    perform kernel_draft_fail(
      'authorization_denied',
      'Tenant scope is not authorized',
      jsonb_build_array(jsonb_build_object(
        'path', 'scope',
        'code', 'tenant_scope_not_bound',
        'message', 'the authenticated database principal is not bound to the requested tenant and runtime capability'
      ))
    );
  end if;
  perform set_config('kernel.app_id', app_id, true);
  perform set_config('kernel.customer_id', customer_id, true);
  perform pg_advisory_xact_lock_shared(hashtext(
    'postgres-schema:' || current_schema() || ':materialize-tenant:' || app_id || ':' || customer_id || ':schema-activation'
  )::bigint);
  if not exists (
    select 1 from schema_revision
    where schema_revision.app_id = kernel_draft_require_scope.app_id
      and schema_revision.customer_id = kernel_draft_require_scope.customer_id
      and activated_at is not null
  ) then
    perform kernel_draft_fail(
      'active_schema_missing',
      'No active schema revision exists for this scope',
      jsonb_build_array(jsonb_build_object(
        'path', 'scope', 'code', 'active_schema_missing',
        'message', app_id || '/' || customer_id || ': materialize a schema before applying or reading records'
      ))
    );
  end if;
  policy_snapshot := kernel_policy_active_snapshot(app_id, customer_id);
  if coalesce((policy_snapshot->>'declared')::boolean, false) then
    perform kernel_policy_request_actor(app_id, customer_id);
    perform kernel_draft_fail(
      'unsupported_capability',
      'Draft and revert lifecycle endpoints are unavailable for policy-enabled revisions',
      jsonb_build_array(jsonb_build_object(
        'path', 'capability',
        'code', 'unsupported_capability',
        'message', 'use the generated authorization-aware change-set API'
      ))
    );
  end if;
end
$kernel$;

create or replace function kernel_draft_assert_lookup_storage_authority(
  requested_app_id text,
  requested_customer_id text,
  requested_model_id text
)
returns void language plpgsql volatile
as $kernel$
declare authority_error jsonb;
begin
  authority_error:=kernel_lookup_storage_authority_error(
    requested_app_id,requested_customer_id,requested_model_id
  );
  if authority_error is not null then
    perform kernel_draft_fail(
      authority_error->>'code',authority_error->>'message',authority_error->'details'
    );
  end if;
end
$kernel$;

create or replace function kernel_draft_assert_schema_lookup_authority(
  schema_json jsonb,
  requested_app_id text,
  requested_customer_id text
)
returns void language plpgsql volatile
as $kernel$
declare model jsonb;
begin
  for model in
    select value from jsonb_array_elements(coalesce(schema_json->'models','[]'::jsonb)) item(value)
    where value->>'kind'='lookup'
    order by value->>'id'
  loop
    perform kernel_draft_assert_lookup_storage_authority(
      requested_app_id,requested_customer_id,model->>'id'
    );
  end loop;
end
$kernel$;

create or replace function kernel_draft_normalize_identifier(value text)
returns text language sql immutable parallel safe
as $kernel$
  select trim(both '_' from regexp_replace(
    regexp_replace(lower(btrim(value)), '[_\-[:space:]]+', '_', 'g'),
    '[^a-z0-9_]', '', 'g'
  ))
$kernel$;

create or replace function kernel_draft_table(model_id text, suffix text)
returns text language sql immutable parallel safe
as $kernel$
  select kernel_physical_identifier(
    kernel_draft_normalize_identifier(model_id) || '_' || suffix
  )
$kernel$;

create or replace function kernel_draft_version_table(model jsonb)
returns text language sql immutable parallel safe
as $kernel$
  select case when model->>'kind' = 'lookup'
    then 'lookup_version'
    else kernel_draft_table(model->>'id', 'version')
  end
$kernel$;

create or replace function kernel_draft_record_table(model jsonb)
returns text language sql immutable parallel safe
as $kernel$
  select case when model->>'kind' = 'lookup'
    then 'lookup_record'
    else kernel_draft_table(model->>'id', 'record')
  end
$kernel$;

create or replace function kernel_draft_model_filter(model jsonb, table_alias text default '')
returns text language sql immutable parallel safe
as $kernel$
  select case when model->>'kind' = 'lookup' then
    ' and ' || case when table_alias = '' then '' else quote_ident(table_alias) || '.' end ||
    'model_id = ' || quote_literal(model->>'id')
  else '' end
$kernel$;

create or replace function kernel_draft_record_values(model jsonb, row_data jsonb)
returns jsonb language sql immutable parallel safe
as $kernel$
  select case when model->>'kind' = 'lookup'
    then kernel_read_lookup_values(model, coalesce(row_data->'values', '{}'::jsonb), '[]'::jsonb)
    else kernel_draft_field_values(model, row_data)
  end
$kernel$;

create or replace function kernel_draft_field_values(model jsonb, row_data jsonb)
returns jsonb language plpgsql immutable parallel safe
as $kernel$
declare
  field jsonb;
  field_id text;
  field_type text;
  amount text;
  currency text;
  period text;
  raw jsonb;
  values_json jsonb := '{}'::jsonb;
begin
  for field in select value from jsonb_array_elements(coalesce(model->'fields', '[]'::jsonb)) loop
    field_id := field->>'id';
    field_type := field->>'type';
    if field_type = 'money_rate' then
      amount := row_data->>(field_id || '_amount');
      currency := row_data->>(field_id || '_currency');
      period := row_data->>(field_id || '_period');
      if amount is not null and currency is not null and period is not null then
        values_json := values_json || jsonb_build_object(
          field_id,
          jsonb_build_object(
            'type', 'money_rate',
            'value', jsonb_build_object('amount', amount, 'currency', currency, 'period', period)
          )
        );
      end if;
      continue;
    end if;

    raw := row_data->field_id;
    if raw is null or raw = 'null'::jsonb then
      continue;
    end if;
    values_json := values_json || jsonb_build_object(
      field_id,
      case field_type
        when 'number' then jsonb_build_object('type', 'number', 'value', row_data->>field_id)
        when 'bool' then jsonb_build_object('type', 'bool', 'value', raw)
        when 'date' then jsonb_build_object('type', 'date', 'value', row_data->>field_id)
        when 'datetime' then jsonb_build_object('type', 'datetime', 'value', row_data->>field_id)
        when 'relation' then jsonb_build_object(
          'type', 'relation',
          'value', jsonb_build_object('type', 'record_id', 'value', row_data->>field_id)
        )
        when 'text_list' then jsonb_build_object('type', 'text_list', 'value', raw)
        when 'known_aliases' then jsonb_build_object('type', 'text_list', 'value', raw)
        when 'json' then jsonb_build_object('type', 'json', 'value', raw)
        when 'enum' then jsonb_build_object('type', 'enum', 'value', row_data->>field_id)
        else jsonb_build_object('type', 'text', 'value', row_data->>field_id)
      end
    );
  end loop;
  return values_json;
end
$kernel$;

create or replace function kernel_draft_revert_fingerprint(request jsonb, revision_id bigint)
returns text language sql immutable parallel safe
as $kernel$
  select kernel_canonical_json(jsonb_build_object(
    'app_id', request->'app_id',
    'customer_id', request->'customer_id',
    'schema_revision_id', to_jsonb(revision_id),
    'actor_id', coalesce(request->'actor_id', 'null'::jsonb),
    'source_kind', 'revert',
    'source_ref', (request->>'change_set_id'),
    'idempotency_key', coalesce(request->'idempotency_key', 'null'::jsonb),
    'change_type_id', null,
    'notes', coalesce(request->'notes', 'null'::jsonb),
    'mode', 'mainline',
    'revert_target_change_set_id', request->'change_set_id'
  ))
$kernel$;

create or replace function kernel_draft_active_schema(app_id text, customer_id text, revision_id bigint)
returns jsonb language plpgsql stable
as $kernel$
<<kernel_draft_api>>
declare
  result jsonb;
begin
  select schema into result
  from schema_revision
  where id = revision_id
    and schema_revision.app_id = kernel_draft_active_schema.app_id
    and schema_revision.customer_id = kernel_draft_active_schema.customer_id;
  if result is null then
    perform kernel_draft_fail(
      'active_schema_missing',
      'No active schema revision exists for this scope',
      jsonb_build_array(jsonb_build_object(
        'path', 'scope',
        'code', 'active_schema_missing',
        'message', app_id || '/' || customer_id || ': materialize a schema before applying or reading records'
      ))
    );
  end if;
  return result;
end
$kernel$;

create or replace function kernel_draft_visible_state(
  schema_json jsonb,
  target_model_id text,
  app_id text,
  customer_id text,
  record_id uuid,
  as_of date,
  draft_change_set_id bigint
)
returns integer language plpgsql stable
as $kernel$
declare
  target_model jsonb;
  version_table text;
  model_filter text;
  tombstone boolean;
  affected bigint;
begin
  select value into target_model
  from jsonb_array_elements(coalesce(schema_json->'models', '[]'::jsonb)) item(value)
  where value->>'id' = target_model_id;
  if target_model is null then return 0; end if;
  version_table := kernel_draft_version_table(target_model);
  model_filter := kernel_draft_model_filter(target_model, 'v');
  execute format(
    'select v.tombstones_record from %I v join change_set cs on cs.id = v.change_set_id and cs.app_id = v.app_id and cs.customer_id = v.customer_id where v.app_id = $1 and v.customer_id = $2 and v.record_id = $3%s and v.effective_start <= $4 and ((v.stage = ''mainline'' and cs.status = ''mainline'' and cs.applied_order is not null) or ($5::bigint is not null and v.change_set_id = $5 and v.stage = ''draft'' and cs.status = ''draft'' and cs.applied_order is null)) order by v.effective_start desc, case when v.tombstones_record then 2 when v.untombstones_record then 1 else 0 end desc, case when v.stage = ''draft'' then 1 else 0 end desc, case when v.stage = ''mainline'' then cs.applied_order else cs.created_order end desc, v.id desc limit 1',
    version_table, model_filter
  ) into tombstone using app_id, customer_id, record_id, as_of, draft_change_set_id;
  get diagnostics affected = row_count;
  if affected=0 then return 0; end if;
  if tombstone then return 2; end if;
  return 1;
end
$kernel$;

create or replace function kernel_draft_validate_relations(
  schema_json jsonb,
  model jsonb,
  row_data jsonb,
  app_id text,
  customer_id text,
  as_of date,
  draft_change_set_id bigint
)
returns void language plpgsql stable
as $kernel$
declare
  field jsonb;
  target_model text;
  target_id uuid;
  state integer;
  custom_entry jsonb;
  custom_definition jsonb;
begin
  for field in
    select value from jsonb_array_elements(coalesce(model->'fields', '[]'::jsonb))
    where value->>'type' = 'relation' and case when model->>'kind'='lookup'
      then row_data->'values' ? (value->>'id') and row_data#>>array['values',value->>'id','value','value'] is not null
      else row_data ? (value->>'id') and row_data->>(value->>'id') is not null
    end
  loop
    target_model := field->>'target_model';
    target_id := case when model->>'kind' = 'lookup'
      then (row_data#>>array['values', field->>'id', 'value', 'value'])::uuid
      else (row_data->>(field->>'id'))::uuid
    end;
    state := kernel_draft_visible_state(
      schema_json, target_model, app_id, customer_id, target_id, as_of,
      draft_change_set_id
    );
    if state = 2 then
      perform kernel_draft_fail('tombstoned_record', format('record `%s` is tombstoned as of %s', target_id, as_of));
    elsif state = 0 then
      perform kernel_draft_fail('record_target_missing', format('record `%s` is not visible as of %s', target_id, as_of));
    end if;
  end loop;

  if model->>'kind'='lookup' then
    for field in select value from jsonb_array_elements(coalesce(model->'many_relations','[]'::jsonb)) loop
      for custom_entry in
        select to_jsonb(value) from jsonb_array_elements_text(
          coalesce(row_data->'many_relations'->(field->>'id'),'[]'::jsonb)
        ) item(value)
      loop
        target_model := field->>'target_model';
        target_id := (custom_entry#>>'{}')::uuid;
        state := kernel_draft_visible_state(
          schema_json,target_model,app_id,customer_id,target_id,as_of,draft_change_set_id
        );
        if state=2 then
          perform kernel_draft_fail('tombstoned_record',format('record `%s` is tombstoned as of %s',target_id,as_of));
        elsif state=0 then
          perform kernel_draft_fail('record_target_missing',format('record `%s` is not visible as of %s',target_id,as_of));
        end if;
      end loop;
    end loop;
  end if;

  for custom_entry in select value from jsonb_array_elements(coalesce(row_data->'custom_fields', '[]'::jsonb)) loop
    if custom_entry->>'type' <> 'relation' then continue; end if;
    select value into custom_definition
    from jsonb_array_elements(coalesce(schema_json->'custom_fields', '[]'::jsonb))
    where value->>'model_id' = model->>'id'
      and value->>'field_id' = custom_entry->>'field_id'
      and coalesce(value->>'archived_at', '') = '';
    if custom_definition is null then
      perform kernel_draft_fail(
        'schema_drift',
        'Schema drift detected',
        jsonb_build_array(jsonb_build_object(
          'path', 'object', 'code', 'schema_drift',
          'message', (model->>'id') || '.' || (custom_entry->>'field_id') || ': restored custom relation definition is missing'
        ))
      );
    end if;
    target_model := custom_definition->>'target_model_id';
    target_id := (custom_entry#>>'{value,value}')::uuid;
    state := kernel_draft_visible_state(
      schema_json, target_model, app_id, customer_id, target_id, as_of,
      draft_change_set_id
    );
    if state = 2 then
      perform kernel_draft_fail('tombstoned_record', format('record `%s` is tombstoned as of %s', target_id, as_of));
    elsif state = 0 then
      perform kernel_draft_fail('record_target_missing', format('record `%s` is not visible as of %s', target_id, as_of));
    end if;
  end loop;
end
$kernel$;

create or replace function kernel_draft_relation_targets(
  schema_json jsonb,
  model jsonb,
  row_data jsonb
)
returns jsonb language plpgsql immutable parallel safe
as $kernel$
declare
  field jsonb;
  custom_entry jsonb;
  custom_definition jsonb;
  targets jsonb := '[]'::jsonb;
begin
  for field in
    select value from jsonb_array_elements(coalesce(model->'fields', '[]'::jsonb))
    where value->>'type'='relation' and case when model->>'kind'='lookup'
      then row_data->'values' ? (value->>'id') and row_data#>>array['values',value->>'id','value','value'] is not null
      else row_data ? (value->>'id') and row_data->>(value->>'id') is not null
    end
  loop
    targets := targets || jsonb_build_array(jsonb_build_object(
      'model_id', field->>'target_model',
      'record_id', case when model->>'kind' = 'lookup'
        then row_data#>>array['values', field->>'id', 'value', 'value']
        else row_data->>(field->>'id')
      end
    ));
  end loop;
  if model->>'kind' = 'lookup' then
    for field in select value from jsonb_array_elements(coalesce(model->'many_relations','[]'::jsonb)) loop
      for custom_entry in
        select to_jsonb(value) from jsonb_array_elements_text(
          coalesce(row_data->'many_relations'->(field->>'id'),'[]'::jsonb)
        ) item(value)
      loop
        targets := targets || jsonb_build_array(jsonb_build_object(
          'model_id',field->>'target_model','record_id',custom_entry#>>'{}'
        ));
      end loop;
    end loop;
  end if;
  for custom_entry in select value from jsonb_array_elements(coalesce(row_data->'custom_fields','[]'::jsonb)) loop
    if custom_entry->>'type'<>'relation' then continue; end if;
    select value into custom_definition
    from jsonb_array_elements(coalesce(schema_json->'custom_fields','[]'::jsonb))
    where value->>'model_id'=model->>'id'
      and value->>'field_id'=custom_entry->>'field_id'
      and coalesce(value->>'archived_at','')='';
    if custom_definition is not null then
      targets := targets || jsonb_build_array(jsonb_build_object(
        'model_id', custom_definition->>'target_model_id',
        'record_id', custom_entry#>>'{value,value}'
      ));
    end if;
  end loop;
  return targets;
end
$kernel$;

create or replace function kernel_draft_validate_unique(
  model jsonb,
  row_data jsonb,
  version_table text,
  app_id text,
  customer_id text,
  record_id uuid
)
returns void language plpgsql stable
as $kernel$
declare
  field jsonb;
  field_id text;
  field_type text;
  column_name text;
  value_text text;
  cast_type text;
  conflict_value text;
begin
  for field in
    select value from jsonb_array_elements(coalesce(model->'fields', '[]'::jsonb))
    where coalesce((value->>'is_unique')::boolean, false)
  loop
    field_id := field->>'id';
    field_type := field->>'type';
    column_name := kernel_physical_identifier(field_id);
    value_text := case when model->>'kind'='lookup'
      then row_data#>>array['values',field_id,'value'] else row_data->>column_name end;
    if value_text is null then continue; end if;
    cast_type := case field_type
      when 'number' then 'numeric'
      when 'bool' then 'boolean'
      when 'date' then 'date'
      when 'datetime' then 'timestamptz'
      when 'relation' then 'uuid'
      else 'text'
    end;
    if model->>'kind'='lookup' then
      execute format(
        'select values->%L->>''value'' from lookup_version where app_id=$1 and customer_id=$2 and model_id=%L and record_id<>$3 and stage=''mainline'' and effective_end is null and values->%L->>''value''=$4 limit 1',
        field_id, model->>'id', field_id
      ) into conflict_value using app_id, customer_id, record_id, value_text;
    else
      execute format(
        'select %I::text from %I where app_id=$1 and customer_id=$2 and record_id<>$3 and stage=''mainline'' and effective_end is null and %I = $4::%s limit 1',
        column_name, version_table, column_name, cast_type
      ) into conflict_value using app_id, customer_id, record_id, value_text;
    end if;
    if conflict_value is not null then
      perform kernel_draft_fail(
        'unique_field_conflict',
        'Unique field value already exists',
        jsonb_build_array(
          jsonb_build_object('path','model','code','unique_field_conflict','message',model->>'id'),
          jsonb_build_object('path','field','code','unique_field_conflict','message',field_id),
          jsonb_build_object('path','value','code','unique_field_conflict','message',value_text)
        )
      );
    end if;
  end loop;
end
$kernel$;

create or replace function kernel_draft_unique_error(model jsonb, row_data jsonb)
returns jsonb language plpgsql immutable parallel safe
as $kernel$
declare field jsonb; field_id text; column_name text; value_text text;
begin
  select value into field
  from jsonb_array_elements(coalesce(model->'fields','[]'::jsonb))
  where coalesce((value->>'is_unique')::boolean,false)
    and case when model->>'kind'='lookup'
      then row_data->'values' ? (value->>'id') and row_data#>>array['values',value->>'id','value'] is not null
      else row_data ? kernel_physical_identifier(value->>'id') and row_data->>kernel_physical_identifier(value->>'id') is not null
    end
  order by value->>'id' limit 1;
  if field is null then return kernel_draft_error('database_error','Database operation failed'); end if;
  field_id:=field->>'id'; column_name:=kernel_physical_identifier(field_id);
  value_text:=case when model->>'kind'='lookup' then row_data#>>array['values',field_id,'value'] else row_data->>column_name end;
  return kernel_draft_error(
    'unique_field_conflict','Unique field value already exists',
    jsonb_build_array(
      jsonb_build_object('path','model','code','unique_field_conflict','message',model->>'id'),
      jsonb_build_object('path','field','code','unique_field_conflict','message',field_id),
      jsonb_build_object('path','value','code','unique_field_conflict','message',value_text)
    )
  );
end
$kernel$;
"#;

const LIST_DRAFT_CHANGE_SETS: &str = r#"
create or replace function kernel_list_draft_change_sets(request jsonb)
returns jsonb language plpgsql volatile security invoker set search_path from current
as $kernel$
<<kernel_draft_api>>
declare app_id text; customer_id text; listed_status text; result jsonb;
begin
  if request is null or jsonb_typeof(request) <> 'object' then
    return kernel_draft_contract_error('request', 'invalid_request', 'request must be a JSON object');
  end if;
  app_id := request->>'app_id'; customer_id := request->>'customer_id';
  if app_id is null or btrim(app_id) = '' then return kernel_draft_contract_error('app_id', 'required', 'app_id is required'); end if;
  if customer_id is null or btrim(customer_id) = '' then return kernel_draft_contract_error('customer_id', 'required', 'customer_id is required'); end if;
  -- Pending drafts by default; `discarded` lists rejected drafts, which keep
  -- their rows (stage `discarded`) and notes.
  listed_status := coalesce(request->>'status', 'draft');
  if listed_status not in ('draft', 'discarded') then
    return kernel_draft_contract_error('status', 'invalid', 'status must be draft or discarded');
  end if;
  perform kernel_draft_require_scope(app_id, customer_id);
  perform set_config('kernel.app_id', app_id, true);
  perform set_config('kernel.customer_id', customer_id, true);
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'schema_revision_id', schema_revision_id, 'actor_id', actor_id,
    'source_kind', source_kind, 'source_ref', source_ref, 'change_type_id', change_type_id,
    'notes', notes, 'entry_notes', entry_notes, 'created_at', created_at
  ) order by created_order desc, id desc), '[]'::jsonb) into result
  from change_set where change_set.app_id = kernel_draft_api.app_id
    and change_set.customer_id = kernel_draft_api.customer_id and status = listed_status;
  return kernel_draft_ok(result);
exception when others then
  if sqlstate = 'AR001' then return sqlerrm::jsonb; end if;
  return kernel_draft_error('database_error', 'Database operation failed');
end
$kernel$;
"#;

const READ_DRAFT_CHANGE_SET: &str = r#"
create or replace function kernel_read_draft_change_set(request jsonb)
returns jsonb language plpgsql volatile security invoker set search_path from current
as $kernel$
<<kernel_draft_api>>
declare
  app_id text; customer_id text; change_set_id bigint; revision_id bigint; current_status text;
  schema_json jsonb; model jsonb; row_data jsonb; records jsonb := '[]'::jsonb;
  version_table text; record_table text; version_filter text; record_filter text;
begin
  if request is null or jsonb_typeof(request) <> 'object' then return kernel_draft_contract_error('request', 'invalid_request', 'request must be a JSON object'); end if;
  app_id := request->>'app_id'; customer_id := request->>'customer_id';
  if app_id is null or btrim(app_id) = '' then return kernel_draft_contract_error('app_id', 'required', 'app_id is required'); end if;
  if customer_id is null or btrim(customer_id) = '' then return kernel_draft_contract_error('customer_id', 'required', 'customer_id is required'); end if;
  begin change_set_id := (request->>'change_set_id')::bigint; exception when others then return kernel_draft_contract_error('change_set_id', 'invalid', 'change_set_id must be an integer'); end;
  perform kernel_draft_require_scope(app_id, customer_id);
  perform set_config('kernel.app_id', app_id, true); perform set_config('kernel.customer_id', customer_id, true);
  select schema_revision_id, status into revision_id, current_status from change_set
  where id = change_set_id and change_set.app_id = kernel_draft_api.app_id and change_set.customer_id = kernel_draft_api.customer_id;
  if not found then perform kernel_draft_fail('record_target_missing', format('change_set `%s` did not resolve', change_set_id)); end if;
  if current_status <> 'draft' then perform kernel_draft_fail('draft_status_conflict', format('change_set `%s` has status `%s`, not `draft`', change_set_id, current_status)); end if;
  schema_json := kernel_draft_active_schema(app_id, customer_id, revision_id);
  perform kernel_draft_assert_schema_lookup_authority(schema_json,app_id,customer_id);
  for model in select value from jsonb_array_elements(schema_json->'models') loop
    version_table := kernel_draft_version_table(model); record_table := kernel_draft_record_table(model);
    version_filter := kernel_draft_model_filter(model,'v'); record_filter := kernel_draft_model_filter(model,'r');
    for row_data in execute format(
      'select to_jsonb(v) || jsonb_build_object(''external_key'', r.external_key) from %I v join %I r on r.id=v.record_id and r.app_id=v.app_id and r.customer_id=v.customer_id%s%s where v.app_id=$1 and v.customer_id=$2 and v.change_set_id=$3 and v.stage=''draft''%s order by v.effective_start, v.tombstones_record, v.untombstones_record, v.id',
      version_table, record_table,
      case when model->>'kind'='lookup' then ' and r.model_id=v.model_id' else '' end,
      record_filter, version_filter
    ) using app_id, customer_id, change_set_id loop
      records := records || jsonb_build_array(jsonb_build_object(
        'change_set_id', change_set_id, 'model_id', model->>'id', 'record_id', row_data->'record_id',
        'external_key', row_data->'external_key', 'effective_start', row_data->'effective_start',
        'effective_end', row_data->'effective_end', 'tombstones_record', row_data->'tombstones_record',
        'untombstones_record', row_data->'untombstones_record',
        'values', kernel_draft_record_values(model, row_data),
        'custom_fields', kernel_read_custom_fields(
          schema_json,
          model->>'id',
          coalesce(row_data->'custom_fields', '[]'::jsonb)
        ),
        'metadata',coalesce(row_data->'metadata','{}'::jsonb),
        'many_relations',coalesce(row_data->'many_relations','{}'::jsonb),
        'availability',case when model->>'kind'='lookup' then row_data->'availability' else null end
      ));
    end loop;
  end loop;
  return kernel_draft_ok(records);
exception when others then
  if sqlstate = 'AR001' then return sqlerrm::jsonb; end if;
  return kernel_draft_error('database_error', 'Database operation failed');
end
$kernel$;
"#;

const UPDATE_DRAFT_NOTES: &str = r#"
create or replace function kernel_update_draft_notes(request jsonb)
returns jsonb language plpgsql volatile security invoker set search_path from current
as $kernel$
<<kernel_draft_api>>
declare app_id text; customer_id text; change_set_id bigint; current_status text;
begin
  if request is null or jsonb_typeof(request) <> 'object' then return kernel_draft_contract_error('request', 'invalid_request', 'request must be a JSON object'); end if;
  app_id := request->>'app_id'; customer_id := request->>'customer_id';
  if app_id is null or btrim(app_id) = '' then return kernel_draft_contract_error('app_id', 'required', 'app_id is required'); end if;
  if customer_id is null or btrim(customer_id) = '' then return kernel_draft_contract_error('customer_id', 'required', 'customer_id is required'); end if;
  begin change_set_id := (request->>'change_set_id')::bigint; exception when others then return kernel_draft_contract_error('change_set_id', 'invalid', 'change_set_id must be an integer'); end;
  perform kernel_draft_require_scope(app_id, customer_id);
  perform set_config('kernel.app_id', app_id, true); perform set_config('kernel.customer_id', customer_id, true);
  select status into current_status from change_set where id=change_set_id and change_set.app_id=kernel_draft_api.app_id and change_set.customer_id=kernel_draft_api.customer_id for update;
  if not found then perform kernel_draft_fail('record_target_missing', format('change_set `%s` did not resolve', change_set_id)); end if;
  if current_status <> 'draft' then perform kernel_draft_fail('draft_status_conflict', format('cannot update notes for change_set `%s` with status `%s`', change_set_id, current_status)); end if;
  update change_set set notes = case when request ? 'notes' and request->'notes' <> 'null'::jsonb then request->>'notes' else null end
  where id=change_set_id and change_set.app_id=kernel_draft_api.app_id and change_set.customer_id=kernel_draft_api.customer_id and status='draft';
  return kernel_draft_ok('null'::jsonb);
exception when others then
  if sqlstate = 'AR001' then return sqlerrm::jsonb; end if;
  return kernel_draft_error('database_error', 'Database operation failed');
end
$kernel$;
"#;

const DISCARD_DRAFT_CHANGE_SET: &str = r#"
create or replace function kernel_discard_draft_change_set(request jsonb)
returns jsonb language plpgsql volatile security invoker set search_path from current
as $kernel$
<<kernel_draft_api>>
declare app_id text; customer_id text; change_set_id bigint; revision_id bigint; current_status text; schema_json jsonb; model jsonb; version_table text; record_table text; version_filter text; record_filter text;
begin
  if request is null or jsonb_typeof(request) <> 'object' then return kernel_draft_contract_error('request', 'invalid_request', 'request must be a JSON object'); end if;
  app_id := request->>'app_id'; customer_id := request->>'customer_id';
  if app_id is null or btrim(app_id) = '' then return kernel_draft_contract_error('app_id', 'required', 'app_id is required'); end if;
  if customer_id is null or btrim(customer_id) = '' then return kernel_draft_contract_error('customer_id', 'required', 'customer_id is required'); end if;
  begin change_set_id := (request->>'change_set_id')::bigint; exception when others then return kernel_draft_contract_error('change_set_id', 'invalid', 'change_set_id must be an integer'); end;
  perform kernel_draft_require_scope(app_id, customer_id);
  perform set_config('kernel.app_id', app_id, true); perform set_config('kernel.customer_id', customer_id, true);
  select schema_revision_id, status into revision_id, current_status from change_set where id=change_set_id and change_set.app_id=kernel_draft_api.app_id and change_set.customer_id=kernel_draft_api.customer_id for update;
  if not found then perform kernel_draft_fail('record_target_missing', format('change_set `%s` did not resolve', change_set_id)); end if;
  if current_status = 'discarded' then return kernel_draft_ok(jsonb_build_object('id', change_set_id, 'schema_revision_id', revision_id)); end if;
  if current_status <> 'draft' then perform kernel_draft_fail('draft_status_conflict', format('cannot discard change_set `%s` with status `%s`', change_set_id, current_status)); end if;
  schema_json := kernel_draft_active_schema(app_id, customer_id, revision_id);
  perform kernel_draft_assert_schema_lookup_authority(schema_json,app_id,customer_id);
  for model in select value from jsonb_array_elements(schema_json->'models') loop
    version_table := kernel_draft_version_table(model); record_table := kernel_draft_record_table(model);
    version_filter := kernel_draft_model_filter(model,''); record_filter := kernel_draft_model_filter(model,'r');
    execute format('update %I set stage=''discarded'' where change_set_id=$1 and app_id=$2 and customer_id=$3 and stage=''draft''%s', version_table, version_filter) using change_set_id, app_id, customer_id;
    execute format('update %I r set external_key=null where r.app_id=$1 and r.customer_id=$2%s and r.external_key is not null and exists (select 1 from %I d where d.record_id=r.id and d.app_id=r.app_id and d.customer_id=r.customer_id%s and d.change_set_id=$3 and d.stage=''discarded'') and not exists (select 1 from %I a where a.record_id=r.id and a.app_id=r.app_id and a.customer_id=r.customer_id%s and a.stage in (''draft'',''mainline''))', record_table, record_filter, version_table, kernel_draft_model_filter(model,'d'), version_table, kernel_draft_model_filter(model,'a')) using app_id, customer_id, change_set_id;
  end loop;
  update change_set set status='discarded' where id=change_set_id and change_set.app_id=kernel_draft_api.app_id and change_set.customer_id=kernel_draft_api.customer_id and status='draft';
  -- Open review surfaces re-read the scope's drafts; delivered on commit, no data.
  perform pg_notify('kernel_canonical', kernel_draft_api.app_id || ':' || kernel_draft_api.customer_id);
  return kernel_draft_ok(jsonb_build_object('id', change_set_id, 'schema_revision_id', revision_id));
exception when others then
  if sqlstate = 'AR001' then return sqlerrm::jsonb; end if;
  return kernel_draft_error('database_error', 'Database operation failed');
end
$kernel$;
"#;

// A draft's review threads, in the work-session thread shape
// ({id, anchor, resolved, messages}). Draft Save copies a session's open
// threads here. Anyone who may read the tenant's drafts reads, replies and
// resolves (an agent too; the host decides who may resolve a draft's threads). Threads stay with the change set whatever
// its status. Replies and resolutions are replay-safe by `request_id`. Only a
// session's owner lists the drafts it saved (`by_session`); the host decides
// who else may read a draft by id.
const DRAFT_THREADS: &str = r#"
-- A thread receipt is its actor's: another actor replaying a known request id
-- with the same body is a conflict, never the original answer. The protected
-- replay guard checks the same fingerprint.
create or replace function kernel_draft_thread_fingerprint(actor text, request jsonb)
returns text language sql immutable parallel safe
as $kernel$
  select encode(sha256(convert_to(kernel_canonical_json(
    jsonb_build_object('actor', actor, 'request', request)), 'UTF8')), 'hex')
$kernel$;

create or replace function kernel_draft_threads(request jsonb)
returns jsonb language plpgsql volatile security invoker set search_path from current
as $kernel$
<<kernel_draft_api>>
declare
  app_id text; customer_id text; op text; change_set_id bigint; session_key uuid;
  actor text; agent boolean; guard jsonb; fingerprint text; stored record;
  thread_key text; thread jsonb; thread_map jsonb; receipts jsonb; replay boolean := false; result jsonb;
begin
  if request is null or jsonb_typeof(request) <> 'object' then return kernel_draft_contract_error('request', 'invalid_request', 'request must be a JSON object'); end if;
  app_id := request->>'app_id'; customer_id := request->>'customer_id'; op := request->>'operation';
  if app_id is null or btrim(app_id) = '' then return kernel_draft_contract_error('app_id', 'required', 'app_id is required'); end if;
  if customer_id is null or btrim(customer_id) = '' then return kernel_draft_contract_error('customer_id', 'required', 'customer_id is required'); end if;
  if op is null or op not in ('get', 'by_session', 'reply', 'resolve') then
    return kernel_draft_contract_error('operation', 'invalid', 'operation must be get, by_session, reply or resolve');
  end if;
  perform kernel_draft_require_scope(app_id, customer_id);
  if op = 'by_session' then
    -- The change sets a session saved (draft or mainline), newest first, each
    -- with its threads.
    session_key := kernel_work_uuid(request->>'session_id');
    if session_key is null then return kernel_draft_contract_error('session_id', 'invalid', 'session_id must be a lowercase UUID'); end if;
    -- A session is its owner's alone (as work-session get): only the owner
    -- lists the drafts it saved.
    actor := kernel_policy_request_actor(app_id, customer_id);
    if not exists (select 1 from work_session s where s.app_id = kernel_draft_api.app_id
        and s.customer_id = kernel_draft_api.customer_id and s.id = session_key and s.owner_id = actor) then
      perform kernel_draft_fail('authorization_denied', 'session is unavailable');
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'status', c.status, 'notes', c.notes,
        'entry_notes', c.entry_notes, 'created_at', c.created_at, 'threads', c.threads) order by c.created_order desc, c.id desc), '[]'::jsonb)
    into result
    from change_set c
    where c.app_id = kernel_draft_api.app_id and c.customer_id = kernel_draft_api.customer_id
      and c.source_kind = 'work_session' and c.source_ref = session_key::text;
    return kernel_draft_ok(result);
  end if;
  begin change_set_id := (request->>'change_set_id')::bigint; exception when others then return kernel_draft_contract_error('change_set_id', 'invalid', 'change_set_id must be an integer'); end;
  if change_set_id is null then return kernel_draft_contract_error('change_set_id', 'required', 'change_set_id is required'); end if;
  if op = 'get' then
    select jsonb_build_object('id', c.id, 'status', c.status, 'notes', c.notes, 'entry_notes', c.entry_notes, 'created_at', c.created_at,
        'source_kind', c.source_kind, 'source_ref', c.source_ref, 'threads', c.threads)
    into result
    from change_set c
    where c.id = change_set_id and c.app_id = kernel_draft_api.app_id and c.customer_id = kernel_draft_api.customer_id;
    if result is null then perform kernel_draft_fail('record_target_missing', format('change_set `%s` did not resolve', change_set_id)); end if;
    return kernel_draft_ok(result);
  end if;
  if coalesce(btrim(request->>'request_id'), '') = '' then return kernel_draft_contract_error('request_id', 'required', 'request_id is required'); end if;
  thread_key := request->>'thread_id';
  if coalesce(thread_key, '') = '' then return kernel_draft_contract_error('thread_id', 'required', 'thread_id is required'); end if;
  if op = 'reply' and (jsonb_typeof(request->'message') is distinct from 'string' or btrim(request->>'message') = '') then
    return kernel_draft_contract_error('message', 'required', 'message must be nonempty text');
  end if;
  actor := kernel_policy_request_actor(app_id, customer_id);
  agent := kernel_request_is_agent(app_id, customer_id, actor);
  guard := kernel_http_mutation_guard(request, 'kernel_draft_threads');
  if (guard->'ok') = 'false'::jsonb then return guard; end if;
  fingerprint := kernel_draft_thread_fingerprint(actor, request);
  select c.threads, c.thread_receipts into stored
  from change_set c
  where c.id = change_set_id and c.app_id = kernel_draft_api.app_id and c.customer_id = kernel_draft_api.customer_id
  for update;
  if not found then perform kernel_draft_fail('record_target_missing', format('change_set `%s` did not resolve', change_set_id)); end if;
  if stored.thread_receipts ? (request->>'request_id') then
    -- A replay repeats no effect: it answers from the current thread.
    if stored.thread_receipts->(request->>'request_id')->>'fingerprint' is distinct from fingerprint then
      perform kernel_draft_fail('idempotency_conflict', 'request id was reused');
    end if;
    replay := true;
  end if;
  thread_map := stored.threads;
  thread := thread_map->thread_key;
  if thread is null then perform kernel_draft_fail('record_target_missing', 'thread unavailable'); end if;
  if not replay then
    if op = 'reply' then
      thread := jsonb_set(thread, '{messages}', coalesce(thread->'messages', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
        'id', request->>'request_id', 'actor_id', actor, 'author_kind', case when agent then 'agent' else 'human' end,
        'message', request->'message', 'created_at', clock_timestamp())));
    else
      thread := thread || jsonb_build_object('resolved', true);
    end if;
    thread_map := jsonb_set(thread_map, array[thread_key], thread);
    receipts := stored.thread_receipts || jsonb_build_object(request->>'request_id', jsonb_build_object('fingerprint', fingerprint));
    -- Receipts count toward the cap, so neither grows without bound.
    if octet_length(thread_map::text) + octet_length(receipts::text) > 8388608 then
      return kernel_draft_contract_error('threads', 'too_large', 'draft threads exceed 8 MiB');
    end if;
    update change_set c set threads = thread_map, thread_receipts = receipts
    where c.id = change_set_id and c.app_id = kernel_draft_api.app_id and c.customer_id = kernel_draft_api.customer_id;
    -- Open review cards and the author's Comments pane re-read; delivered on
    -- commit, no data. The scope's channel reaches both, whatever session
    -- each canvas has open.
    perform pg_notify('kernel_canonical', kernel_draft_api.app_id || ':' || kernel_draft_api.customer_id);
  end if;
  result := kernel_draft_ok(case when op = 'reply'
    then jsonb_build_object('message', (
      select m from jsonb_array_elements(thread->'messages') m where m->>'id' = request->>'request_id' limit 1))
    else jsonb_build_object('thread', thread) end);
  perform kernel_http_mutation_record(request, guard, result);
  return result;
exception when serialization_failure then raise;
when others then
  if sqlstate = 'AR001' then return sqlerrm::jsonb; end if;
  if split_part(sqlerrm, ':', 1) = 'authorization_denied' then
    return kernel_draft_error('authorization_denied', btrim(substring(sqlerrm from position(':' in sqlerrm) + 1)));
  end if;
  return kernel_draft_error('database_error', 'Database operation failed');
end
$kernel$;
"#;

const APPROVE_DRAFT_CHANGE_SET: &str = r#"
create or replace function kernel_approve_draft_change_set(request jsonb)
returns jsonb language plpgsql volatile security invoker set search_path from current
as $kernel$
<<kernel_draft_api>>
declare
  app_id text; customer_id text; change_set_id bigint; revision_id bigint; current_status text; created_mode text;
  draft_created_order bigint; applied_order bigint; schema_json jsonb; model jsonb; row_data jsonb;
  version_table text; record_table text; version_filter text; record_filter text; lock_model jsonb;
  draft_rows jsonb := '[]'::jsonb; item jsonb; other jsonb; field jsonb; conflict_id bigint;
  predecessor record; next_start date; other_next_start date; new_end date; stale_details text[] := '{}';
  lock_set jsonb := '[]'::jsonb; relation_target jsonb; column_name text; value_text text; affected bigint;
  interval_scope jsonb; interval_violation jsonb; request_actor text;
begin
  if request is null or jsonb_typeof(request) <> 'object' then return kernel_draft_contract_error('request', 'invalid_request', 'request must be a JSON object'); end if;
  app_id := request->>'app_id'; customer_id := request->>'customer_id';
  if app_id is null or btrim(app_id) = '' then return kernel_draft_contract_error('app_id', 'required', 'app_id is required'); end if;
  if customer_id is null or btrim(customer_id) = '' then return kernel_draft_contract_error('customer_id', 'required', 'customer_id is required'); end if;
  begin change_set_id := (request->>'change_set_id')::bigint; exception when others then return kernel_draft_contract_error('change_set_id', 'invalid', 'change_set_id must be an integer'); end;
  perform kernel_draft_require_scope(app_id, customer_id);
  perform set_config('kernel.app_id', app_id, true); perform set_config('kernel.customer_id', customer_id, true);
  -- A context marked as agent never approves, on any app (the mutation guard
  -- refuses it first; this holds for every caller of the body).
  if kernel_request_marked_agent() then
    perform kernel_draft_fail('authorization_denied', 'Draft approval requires human authority');
  end if;
  -- Only scopes that declare an authorization policy bind the actor here
  -- (binding every app's writers is follow-up ad.51.5).
  if coalesce((kernel_policy_active_snapshot(app_id, customer_id)->>'declared')::boolean, false) then
    begin
      request_actor := kernel_policy_request_actor(app_id, customer_id);
    exception when raise_exception then
      if sqlerrm like 'authorization_denied:%' then
        perform kernel_draft_fail('authorization_denied', 'A trusted actor binding is required');
      end if;
      raise;
    end;
    if nullif(request->>'actor_id', '') is distinct from request_actor
      or kernel_request_is_agent(app_id, customer_id, request_actor) then
      perform kernel_draft_fail('authorization_denied', 'Draft approval requires human authority');
    end if;
  end if;
  select schema_revision_id, status, created_with_mode, created_order into revision_id, current_status, created_mode, draft_created_order
  from change_set where id=change_set_id and change_set.app_id=kernel_draft_api.app_id and change_set.customer_id=kernel_draft_api.customer_id for update;
  if not found then perform kernel_draft_fail('record_target_missing', format('change_set `%s` did not resolve', change_set_id)); end if;
  if current_status='mainline' and created_mode='draft' then return kernel_draft_ok(jsonb_build_object('id', change_set_id, 'schema_revision_id', revision_id)); end if;
  if current_status <> 'draft' then perform kernel_draft_fail('draft_status_conflict', format('cannot approve change_set `%s` with status `%s`', change_set_id, current_status)); end if;
  schema_json := kernel_draft_active_schema(app_id, customer_id, revision_id);
  perform kernel_draft_assert_schema_lookup_authority(schema_json,app_id,customer_id);

  for model in select value from jsonb_array_elements(schema_json->'models') loop
    version_table := kernel_draft_version_table(model);
    version_filter := kernel_draft_model_filter(model,'v');
    for row_data in execute format('select to_jsonb(v) from %I v where app_id=$1 and customer_id=$2 and change_set_id=$3 and stage=''draft''%s order by effective_start, tombstones_record, untombstones_record, id for update', version_table, version_filter) using app_id, customer_id, change_set_id loop
      draft_rows := draft_rows || jsonb_build_array(jsonb_build_object('model', model, 'row', row_data, 'version_table', version_table));
      lock_set := lock_set || jsonb_build_array(jsonb_build_object('model_id',model->>'id','record_id',row_data->>'record_id'));
      for relation_target in select value from jsonb_array_elements(kernel_draft_relation_targets(schema_json,model,row_data)) loop
        lock_set := lock_set || jsonb_build_array(relation_target);
      end loop;
    end loop;
  end loop;
  if jsonb_array_length(draft_rows)=0 then perform kernel_draft_fail('draft_status_conflict', format('change_set `%s` has no draft version rows', change_set_id)); end if;
  select jsonb_object_agg(scoped.model_id, scoped.record_ids) into interval_scope
  from (
    select value->'model'->>'id' as model_id, jsonb_agg(distinct value->'row'->>'record_id') as record_ids
    from jsonb_array_elements(draft_rows) group by value->'model'->>'id'
  ) scoped;
  -- Interval-rule model locks precede the canonical subject locks.
  interval_violation := kernel_constraint_interval_isolation_error(app_id, customer_id, null, array(select jsonb_object_keys(interval_scope)));
  if interval_violation is not null then perform kernel_draft_fail(interval_violation->>'code', interval_violation->>'message', interval_violation->'details'); end if;
  perform kernel_constraint_interval_lock(app_id, customer_id, null, array(select jsonb_object_keys(interval_scope)));

  -- Canonical subject locks precede validation and causal-order allocation.
  for item in select value from (select distinct value from jsonb_array_elements(lock_set)) locks order by value->>'model_id', value->>'record_id' loop
    select value into lock_model from jsonb_array_elements(schema_json->'models') candidate(value)
    where value->>'id'=item->>'model_id';
    if lock_model is null then perform kernel_draft_fail('schema_drift','Schema drift detected'); end if;
    record_table := kernel_draft_record_table(lock_model); record_filter:=kernel_draft_model_filter(lock_model,'');
    execute format('select 1 from %I where id=$1 and app_id=$2 and customer_id=$3%s for update', record_table,record_filter)
      using (item->>'record_id')::uuid, app_id, customer_id;
  end loop;

  for item in select value from jsonb_array_elements(draft_rows) order by value->'model'->>'id', value->'row'->>'record_id', (value->'row'->>'effective_start')::date, value->'row'->>'id' loop
    model := item->'model'; row_data := item->'row'; version_table := item->>'version_table';
    version_filter:=kernel_draft_model_filter(model,'v');
    conflict_id := null;
    execute format('select cs.id from %I v join change_set cs on cs.id=v.change_set_id and cs.app_id=v.app_id and cs.customer_id=v.customer_id where v.record_id=$1 and v.app_id=$2 and v.customer_id=$3%s and v.stage=''mainline'' and v.change_set_id<>$4 and cs.applied_order>$5 order by cs.applied_order, cs.id limit 1', version_table,version_filter)
      into conflict_id using (row_data->>'record_id')::uuid, app_id, customer_id, change_set_id, draft_created_order;
    if conflict_id is not null then stale_details := array_append(stale_details, format('%s:%s updated by change_set `%s`', model->>'id', row_data->>'record_id', conflict_id)); end if;
    conflict_id := null;
    execute format('select rcs.id from %I v join change_set rcs on rcs.app_id=v.app_id and rcs.customer_id=v.customer_id and rcs.source_kind=''revert'' and rcs.source_ref=v.change_set_id::text where v.record_id=$1 and v.app_id=$2 and v.customer_id=$3%s and v.stage=''reverted'' and v.change_set_id<>$4 and rcs.status=''mainline'' and rcs.applied_order>$5 order by rcs.applied_order, rcs.id limit 1', version_table,version_filter)
      into conflict_id using (row_data->>'record_id')::uuid, app_id, customer_id, change_set_id, draft_created_order;
    if conflict_id is not null then stale_details := array_append(stale_details, format('%s:%s reverted by change_set `%s`', model->>'id', row_data->>'record_id', conflict_id)); end if;
    if (row_data->>'tombstones_record')::boolean and exists(
      select 1 from jsonb_array_elements(draft_rows) later where later->'model'->>'id'=model->>'id' and later->'row'->>'record_id'=row_data->>'record_id' and (later->'row'->>'effective_start')::date>(row_data->>'effective_start')::date
    ) then perform kernel_draft_fail('timeline_conflict', format('draft tombstone for `%s:%s` at %s would precede a later draft version', model->>'id', row_data->>'record_id', row_data->>'effective_start')); end if;
    if (row_data->>'tombstones_record')::boolean or (row_data->>'untombstones_record')::boolean then
      conflict_id := null;
      execute format('select change_set_id from %I v where record_id=$1 and app_id=$2 and customer_id=$3%s and stage=''mainline'' and effective_start=$4 and tombstones_record=$5 and untombstones_record=$6 limit 1', version_table,version_filter)
        into conflict_id using (row_data->>'record_id')::uuid, app_id, customer_id, (row_data->>'effective_start')::date, (row_data->>'tombstones_record')::boolean, (row_data->>'untombstones_record')::boolean;
      if conflict_id is not null then perform kernel_draft_fail('timeline_conflict', format('record `%s` already has a mainline version at %s', row_data->>'record_id', row_data->>'effective_start')); end if;
    end if;
    execute format('select effective_start from %I v where record_id=$1 and app_id=$2 and customer_id=$3%s and stage=''mainline'' and effective_start>$4 order by effective_start limit 1', version_table,version_filter)
      into next_start using (row_data->>'record_id')::uuid, app_id, customer_id, (row_data->>'effective_start')::date;
    if (row_data->>'tombstones_record')::boolean and next_start is not null then perform kernel_draft_fail('timeline_conflict', format('tombstone for record `%s` at %s would precede a later mainline version', row_data->>'record_id', row_data->>'effective_start')); end if;
    perform kernel_draft_validate_relations(schema_json, model, row_data, app_id, customer_id, (row_data->>'effective_start')::date, change_set_id);
    if next_start is null and not (row_data->>'tombstones_record')::boolean then
      perform kernel_draft_validate_unique(model, row_data, version_table, app_id, customer_id, (row_data->>'record_id')::uuid);
      if not exists(select 1 from jsonb_array_elements(draft_rows) later where later->'model'->>'id'=model->>'id' and later->'row'->>'record_id'=row_data->>'record_id' and (later->'row'->>'effective_start')::date>(row_data->>'effective_start')::date) then
        for other in select value from jsonb_array_elements(draft_rows)
          where value->'model'->>'id'=model->>'id'
            and value->'row'->>'record_id'<>row_data->>'record_id'
            and not (value->'row'->>'tombstones_record')::boolean
            and not exists(select 1 from jsonb_array_elements(draft_rows) later where later->'model'->>'id'=model->>'id' and later->'row'->>'record_id'=value->'row'->>'record_id' and (later->'row'->>'effective_start')::date>(value->'row'->>'effective_start')::date)
        loop
          execute format('select effective_start from %I v where record_id=$1 and app_id=$2 and customer_id=$3%s and stage=''mainline'' and effective_start>$4 order by effective_start limit 1',version_table,version_filter)
            into other_next_start using (other->'row'->>'record_id')::uuid,app_id,customer_id,(other->'row'->>'effective_start')::date;
          if other_next_start is not null then continue; end if;
          for field in select value from jsonb_array_elements(coalesce(model->'fields','[]'::jsonb)) where coalesce((value->>'is_unique')::boolean,false) loop
            column_name:=kernel_physical_identifier(field->>'id');
            if (case when model->>'kind'='lookup' then row_data->'values'->(field->>'id') else row_data->column_name end) is not null
              and (case when model->>'kind'='lookup' then row_data->'values'->(field->>'id') else row_data->column_name end)
                =(case when model->>'kind'='lookup' then other->'row'->'values'->(field->>'id') else other->'row'->column_name end) then
              value_text:=case when model->>'kind'='lookup' then row_data#>>array['values',field->>'id','value'] else row_data->>column_name end;
              perform kernel_draft_fail('unique_field_conflict','Unique field value already exists',jsonb_build_array(
                jsonb_build_object('path','model','code','unique_field_conflict','message',model->>'id'),
                jsonb_build_object('path','field','code','unique_field_conflict','message',field->>'id'),
                jsonb_build_object('path','value','code','unique_field_conflict','message',value_text)
              ));
            end if;
          end loop;
        end loop;
      end if;
    end if;
  end loop;
  if cardinality(stale_details)>0 then select array_agg(distinct value order by value) into stale_details from unnest(stale_details) value; perform kernel_draft_fail('stale_draft', array_to_string(stale_details, '; ')); end if;

  applied_order := nextval('change_set_lifecycle_order_seq');
  update change_set set status='mainline', applied_order=kernel_draft_api.applied_order, applied_at=now()
  where id=change_set_id and change_set.app_id=kernel_draft_api.app_id and change_set.customer_id=kernel_draft_api.customer_id and status='draft';
  if not found then perform kernel_draft_fail('draft_status_conflict', format('draft change_set `%s` changed during approval', change_set_id)); end if;
  perform pg_notify('kernel_canonical', kernel_draft_api.app_id || ':' || kernel_draft_api.customer_id);

  for item in select value from jsonb_array_elements(draft_rows) order by value->'model'->>'id', value->'row'->>'record_id', (value->'row'->>'effective_start')::date, value->'row'->>'id' loop
    model:=item->'model'; row_data:=item->'row'; version_table:=item->>'version_table'; version_filter:=kernel_draft_model_filter(model,'v');
    execute format('select v.id, v.effective_start, v.effective_end, v.tombstones_record, v.untombstones_record from %I v join change_set cs on cs.id=v.change_set_id and cs.app_id=v.app_id and cs.customer_id=v.customer_id where v.record_id=$1 and v.app_id=$2 and v.customer_id=$3%s and v.stage=''mainline'' and v.id<>$4 and v.effective_start<=$5 order by v.effective_start desc, case when v.tombstones_record then 2 when v.untombstones_record then 1 else 0 end desc, cs.applied_order desc, v.id desc limit 1', version_table,version_filter)
      into predecessor using (row_data->>'record_id')::uuid, app_id, customer_id, (row_data->>'id')::uuid, (row_data->>'effective_start')::date;
    execute format('select effective_start from %I v where record_id=$1 and app_id=$2 and customer_id=$3%s and stage=''mainline'' and id<>$4 and effective_start>$5 order by effective_start limit 1', version_table,version_filter)
      into next_start using (row_data->>'record_id')::uuid, app_id, customer_id, (row_data->>'id')::uuid, (row_data->>'effective_start')::date;
    if predecessor.id is not null and predecessor.effective_start=(row_data->>'effective_start')::date and not predecessor.tombstones_record and not predecessor.untombstones_record then new_end:=predecessor.effective_end; else new_end:=case when next_start is null then null else next_start-1 end; end if;
    if predecessor.id is not null then
      execute format('update %I set effective_end=case when effective_start=$2 then $2 else $2-1 end where id=$1 and app_id=$3 and customer_id=$4 and stage=''mainline''%s', version_table, kernel_draft_model_filter(model,''))
        using predecessor.id, (row_data->>'effective_start')::date, app_id, customer_id;
    end if;
    execute format('update %I set stage=''mainline'', effective_end=$2, applied_at=now() where id=$1 and app_id=$3 and customer_id=$4 and stage=''draft''%s', version_table, kernel_draft_model_filter(model,''))
      using (row_data->>'id')::uuid, new_end, app_id, customer_id;
    get diagnostics affected = row_count;
    if affected<>1 then perform kernel_draft_fail('schema_drift', 'Schema drift detected', jsonb_build_array(jsonb_build_object('path','object','code','schema_drift','message',version_table || ': draft version changed during approval'))); end if;
    if model->>'kind'='lookup' then
      if new_end is null and not (row_data->>'tombstones_record')::boolean and coalesce(row_data->>'availability','active')='active' then
        update lookup_alias_projection projection set is_current=false
        where projection.app_id=kernel_draft_api.app_id and projection.customer_id=kernel_draft_api.customer_id
          and projection.model_id=model->>'id' and projection.record_id=(row_data->>'record_id')::uuid and projection.is_current;
      end if;
      perform kernel_apply_project_lookup_version(
        (row_data->>'id')::uuid,app_id,customer_id,model->>'id',(row_data->>'record_id')::uuid,
        schema_json,model,coalesce(row_data->'values','{}'::jsonb),coalesce(row_data->'many_relations','{}'::jsonb),
        new_end is null and not (row_data->>'tombstones_record')::boolean and coalesce(row_data->>'availability','active')='active'
      );
    end if;
  end loop;
  interval_violation := kernel_constraint_interval_violation(app_id, customer_id, null, interval_scope);
  if interval_violation is not null then perform kernel_draft_fail(interval_violation->>'code', interval_violation->>'message', interval_violation->'details'); end if;
  return kernel_draft_ok(jsonb_build_object('id', change_set_id, 'schema_revision_id', revision_id));
exception when unique_violation then return kernel_draft_unique_error(model,row_data);
when serialization_failure then raise;
when others then
  if sqlstate='AR001' then return sqlerrm::jsonb; end if;
  return kernel_draft_error('database_error', 'Database operation failed');
end
$kernel$;
"#;

const REVERT_CHANGE_SET: &str = r#"
create or replace function kernel_revert_change_set(request jsonb)
returns jsonb language plpgsql volatile security invoker set search_path from current
as $kernel$
<<kernel_draft_api>>
declare
  app_id text; customer_id text; target_id bigint; revision_id bigint; target_status text; target_source text; target_order bigint;
  schema_json jsonb; model jsonb; lock_model jsonb; version_table text; record_table text;
  version_filter text; record_filter text; row_data jsonb; item jsonb;
  target_rows jsonb := '[]'::jsonb; target_subjects jsonb := '{}'::jsonb; timeline_row record;
  lock_set jsonb := '[]'::jsonb; relation_target jsonb; rechecked_rows jsonb := '[]'::jsonb;
  conflict_start date; conflict_change_set_id bigint;
  idempotency_key_value text; existing record; fingerprint text; revert_id bigint; lifecycle integer; created_order bigint; affected bigint;
  interval_scope jsonb; interval_violation jsonb; request_actor text;
begin
  if request is null or jsonb_typeof(request) <> 'object' then return kernel_draft_contract_error('request', 'invalid_request', 'request must be a JSON object'); end if;
  app_id:=request->>'app_id'; customer_id:=request->>'customer_id'; idempotency_key_value:=request->>'idempotency_key';
  if app_id is null or btrim(app_id)='' then return kernel_draft_contract_error('app_id','required','app_id is required'); end if;
  if customer_id is null or btrim(customer_id)='' then return kernel_draft_contract_error('customer_id','required','customer_id is required'); end if;
  begin target_id:=(request->>'change_set_id')::bigint; exception when others then return kernel_draft_contract_error('change_set_id','invalid','change_set_id must be an integer'); end;
  perform kernel_draft_require_scope(app_id, customer_id);
  perform set_config('kernel.app_id', app_id, true); perform set_config('kernel.customer_id', customer_id, true);
  -- A context marked as agent never reverts, on any app (the mutation guard
  -- refuses it first; this holds for every caller of the body).
  if kernel_request_marked_agent() then
    perform kernel_draft_fail('authorization_denied', 'Revert requires human authority');
  end if;
  -- Only scopes that declare an authorization policy bind the actor here
  -- (binding every app's writers is follow-up ad.51.5).
  if coalesce((kernel_policy_active_snapshot(app_id, customer_id)->>'declared')::boolean, false) then
    begin
      request_actor := kernel_policy_request_actor(app_id, customer_id);
    exception when raise_exception then
      if sqlerrm like 'authorization_denied:%' then
        perform kernel_draft_fail('authorization_denied', 'A trusted actor binding is required');
      end if;
      raise;
    end;
    if nullif(request->>'actor_id', '') is distinct from request_actor
      or kernel_request_is_agent(app_id, customer_id, request_actor) then
      perform kernel_draft_fail('authorization_denied', 'Revert requires human authority');
    end if;
  end if;

  if idempotency_key_value is not null then
    perform pg_advisory_xact_lock(hashtextextended(app_id || E'\x1f' || customer_id || E'\x1f' || idempotency_key_value, 0));
    select id, schema_revision_id, request_fingerprint into existing from change_set where change_set.app_id=kernel_draft_api.app_id and change_set.customer_id=kernel_draft_api.customer_id and idempotency_key=idempotency_key_value;
    if found then
      fingerprint:=kernel_draft_revert_fingerprint(request, existing.schema_revision_id);
      if existing.request_fingerprint is distinct from fingerprint then
        perform kernel_draft_fail('idempotency_conflict','Idempotency key was reused for a different request',jsonb_build_array(jsonb_build_object('path','idempotency_key','code','idempotency_conflict','message',format('Key `%s` was reused; use a new idempotency key or replay the exact equivalent request',idempotency_key_value))));
      end if;
      return kernel_draft_ok(jsonb_build_object('id',existing.id,'schema_revision_id',existing.schema_revision_id));
    end if;
  end if;
  select schema_revision_id,status,source_kind,applied_order into revision_id,target_status,target_source,target_order from change_set
  where id=target_id and change_set.app_id=kernel_draft_api.app_id and change_set.customer_id=kernel_draft_api.customer_id for update;
  if not found then perform kernel_draft_fail('record_target_missing',format('change_set `%s` did not resolve',target_id)); end if;
  if target_status<>'mainline' then perform kernel_draft_fail('revert_conflict',format('change_set `%s` has status `%s`, not `mainline`',target_id,target_status)); end if;
  if target_source='revert' then perform kernel_draft_fail('revert_conflict',format('change_set `%s` is itself a revert',target_id)); end if;
  if target_order is null then perform kernel_draft_fail('schema_drift','Schema drift detected',jsonb_build_array(jsonb_build_object('path','object','code','schema_drift','message',format('change_set.applied_order: mainline change_set `%s` has no applied_order',target_id)))); end if;
  schema_json:=kernel_draft_active_schema(app_id,customer_id,revision_id);
  perform kernel_draft_assert_schema_lookup_authority(schema_json,app_id,customer_id);
  for model in select value from jsonb_array_elements(schema_json->'models') loop
    version_table:=kernel_draft_version_table(model); version_filter:=kernel_draft_model_filter(model,'v');
    for row_data in execute format('select to_jsonb(v) from %I v where app_id=$1 and customer_id=$2 and change_set_id=$3 and stage=''mainline''%s order by effective_start,tombstones_record,untombstones_record,id',version_table,version_filter) using app_id,customer_id,target_id loop
      target_rows:=target_rows || jsonb_build_array(jsonb_build_object('model',model,'row',row_data,'version_table',version_table));
      target_subjects:=target_subjects || jsonb_build_object((model->>'id') || ':' || (row_data->>'record_id'), jsonb_build_object('model',model,'record_id',row_data->'record_id','version_table',version_table));
      lock_set:=lock_set || jsonb_build_array(jsonb_build_object('model_id',model->>'id','record_id',row_data->>'record_id'));
    end loop;
  end loop;
  if jsonb_array_length(target_rows)=0 then perform kernel_draft_fail('already_reverted',format('change_set `%s` has no mainline version rows to revert',target_id)); end if;
  select jsonb_object_agg(scoped.model_id, scoped.record_ids) into interval_scope
  from (
    select value->'model'->>'id' as model_id, jsonb_agg(distinct value->>'record_id') as record_ids
    from jsonb_each(target_subjects) subject(key, value) group by value->'model'->>'id'
  ) scoped;
  -- Interval-rule model locks precede the canonical subject locks.
  interval_violation := kernel_constraint_interval_isolation_error(app_id, customer_id, null, array(select jsonb_object_keys(interval_scope)));
  if interval_violation is not null then perform kernel_draft_fail(interval_violation->>'code', interval_violation->>'message', interval_violation->'details'); end if;
  perform kernel_constraint_interval_lock(app_id, customer_id, null, array(select jsonb_object_keys(interval_scope)));

  for item in select value from jsonb_each(target_subjects) order by key loop
    model:=item->'model'; version_table:=item->>'version_table'; version_filter:=kernel_draft_model_filter(model,'v');
    for row_data in execute format('select row_data from (select to_jsonb(v) row_data,v.effective_start,lead(v.effective_start) over(order by v.effective_start,case when v.tombstones_record then 2 when v.untombstones_record then 1 else 0 end,cs.applied_order,v.id) next_start from %I v join change_set cs on cs.id=v.change_set_id and cs.app_id=v.app_id and cs.customer_id=v.customer_id where v.record_id=$1 and v.app_id=$2 and v.customer_id=$3%s and v.stage=''mainline'' and v.change_set_id<>$4 and cs.status=''mainline'' and cs.applied_order is not null) timeline where next_start is null or next_start<>effective_start order by effective_start',version_table,version_filter) using (item->>'record_id')::uuid,app_id,customer_id,target_id loop
      for relation_target in select value from jsonb_array_elements(kernel_draft_relation_targets(schema_json,model,row_data)) loop
        lock_set:=lock_set || jsonb_build_array(relation_target);
      end loop;
    end loop;
  end loop;
  for item in select value from (select distinct value from jsonb_array_elements(lock_set)) locks order by value->>'model_id',value->>'record_id' loop
    select value into lock_model from jsonb_array_elements(schema_json->'models') candidate(value)
    where value->>'id'=item->>'model_id';
    if lock_model is null then perform kernel_draft_fail('schema_drift','Schema drift detected'); end if;
    record_table:=kernel_draft_record_table(lock_model); record_filter:=kernel_draft_model_filter(lock_model,'');
    execute format('select 1 from %I where id=$1 and app_id=$2 and customer_id=$3%s for update',record_table,record_filter) using (item->>'record_id')::uuid,app_id,customer_id;
  end loop;
  for model in select value from jsonb_array_elements(schema_json->'models') loop
    version_table:=kernel_draft_version_table(model); version_filter:=kernel_draft_model_filter(model,'v');
    for row_data in execute format('select to_jsonb(v) from %I v where app_id=$1 and customer_id=$2 and change_set_id=$3 and stage=''mainline''%s order by effective_start,tombstones_record,untombstones_record,id',version_table,version_filter) using app_id,customer_id,target_id loop
      rechecked_rows:=rechecked_rows || jsonb_build_array(jsonb_build_object('model',model,'row',row_data,'version_table',version_table));
    end loop;
  end loop;
  if rechecked_rows<>target_rows then
    perform kernel_draft_fail('database_error','Database operation failed');
  end if;
  for item in select value from jsonb_array_elements(target_rows) loop
    model:=item->'model'; row_data:=item->'row'; version_table:=item->>'version_table'; version_filter:=kernel_draft_model_filter(model,'v'); lifecycle:=case when (row_data->>'tombstones_record')::boolean then 2 when (row_data->>'untombstones_record')::boolean then 1 else 0 end;
    conflict_start := null; conflict_change_set_id := null;
    execute format('select v.effective_start,v.change_set_id from %I v join change_set cs on cs.id=v.change_set_id and cs.app_id=v.app_id and cs.customer_id=v.customer_id and cs.status=''mainline'' and cs.applied_order is not null where v.record_id=$1 and v.app_id=$2 and v.customer_id=$3%s and v.stage=''mainline'' and v.change_set_id<>$4 and (v.effective_start>$5 or (v.effective_start=$5 and (case when v.tombstones_record then 2 when v.untombstones_record then 1 else 0 end>$6 or (case when v.tombstones_record then 2 when v.untombstones_record then 1 else 0 end=$6 and cs.applied_order>$7)))) order by v.effective_start, v.tombstones_record desc, v.untombstones_record desc, cs.applied_order, v.id limit 1',version_table,version_filter)
      into conflict_start, conflict_change_set_id using (row_data->>'record_id')::uuid,app_id,customer_id,target_id,(row_data->>'effective_start')::date,lifecycle,target_order;
    if conflict_change_set_id is not null then perform kernel_draft_fail('revert_conflict',format('record `%s` has a later mainline version at %s from change_set `%s`',row_data->>'record_id',conflict_start,conflict_change_set_id)); end if;
  end loop;

  fingerprint:=kernel_draft_revert_fingerprint(request,revision_id); created_order:=nextval('change_set_lifecycle_order_seq');
  insert into change_set(app_id,customer_id,schema_revision_id,created_with_mode,status,actor_id,source_kind,source_ref,idempotency_key,request_fingerprint,change_type_id,notes,created_order,applied_order,applied_at)
  values(app_id,customer_id,revision_id,'mainline','mainline',request->>'actor_id','revert',target_id::text,idempotency_key_value,fingerprint,null,request->>'notes',created_order,created_order,now()) returning id into revert_id;
  perform pg_notify('kernel_canonical', app_id || ':' || customer_id);
  for item in select value from jsonb_array_elements(target_rows) loop
    model:=item->'model'; row_data:=item->'row'; version_table:=item->>'version_table';
    execute format('update %I set stage=''reverted'',applied_at=null where id=$1 and app_id=$2 and customer_id=$3 and stage=''mainline''%s',version_table,kernel_draft_model_filter(model,'')) using (row_data->>'id')::uuid,app_id,customer_id;
    get diagnostics affected = row_count;
    if affected<>1 then perform kernel_draft_fail('schema_drift','Schema drift detected',jsonb_build_array(jsonb_build_object('path','object','code','schema_drift','message',format('%s: revert target version `%s` was not a live mainline row',version_table,row_data->>'id')))); end if;
    if model->>'kind'='lookup' then
      update lookup_alias_projection projection set is_current=false
      where projection.app_id=kernel_draft_api.app_id and projection.customer_id=kernel_draft_api.customer_id
        and projection.model_id=model->>'id' and projection.version_id=(row_data->>'id')::uuid;
    end if;
  end loop;
  for item in select value from jsonb_each(target_subjects) order by key loop
    model:=item->'model'; version_table:=item->>'version_table'; version_filter:=kernel_draft_model_filter(model,'v');
    for timeline_row in execute format('select v.id,to_jsonb(v) row_data,v.effective_start,lead(v.effective_start) over(order by v.effective_start,case when v.tombstones_record then 2 when v.untombstones_record then 1 else 0 end,cs.applied_order,v.id) next_start from %I v join change_set cs on cs.id=v.change_set_id and cs.app_id=v.app_id and cs.customer_id=v.customer_id where v.record_id=$1 and v.app_id=$2 and v.customer_id=$3%s and v.stage=''mainline'' and cs.status=''mainline'' and cs.applied_order is not null order by v.effective_start,case when v.tombstones_record then 2 when v.untombstones_record then 1 else 0 end,cs.applied_order,v.id',version_table,version_filter) using (item->>'record_id')::uuid,app_id,customer_id loop
      row_data:=timeline_row.row_data;
      execute format('update %I set effective_end=$2 where id=$1 and app_id=$3 and customer_id=$4 and stage=''mainline''%s',version_table,kernel_draft_model_filter(model,''))
        using timeline_row.id,case when timeline_row.next_start is null then null when timeline_row.next_start=timeline_row.effective_start then timeline_row.effective_start else timeline_row.next_start-1 end,app_id,customer_id;
    end loop;
    for row_data in execute format('select row_data from (select to_jsonb(v) row_data, v.effective_start, lead(v.effective_start) over(order by v.effective_start,case when v.tombstones_record then 2 when v.untombstones_record then 1 else 0 end,cs.applied_order,v.id) next_start from %I v join change_set cs on cs.id=v.change_set_id and cs.app_id=v.app_id and cs.customer_id=v.customer_id where v.record_id=$1 and v.app_id=$2 and v.customer_id=$3%s and v.stage=''mainline'' and cs.status=''mainline'' and cs.applied_order is not null) timeline where next_start is null or next_start<>effective_start order by effective_start',version_table,version_filter) using (item->>'record_id')::uuid,app_id,customer_id loop
      perform kernel_draft_validate_relations(schema_json,model,row_data,app_id,customer_id,(row_data->>'effective_start')::date,null);
    end loop;
    execute format('select to_jsonb(v) from %I v join change_set cs on cs.id=v.change_set_id and cs.app_id=v.app_id and cs.customer_id=v.customer_id where v.record_id=$1 and v.app_id=$2 and v.customer_id=$3%s and v.stage=''mainline'' and cs.status=''mainline'' and cs.applied_order is not null order by v.effective_start desc,case when v.tombstones_record then 2 when v.untombstones_record then 1 else 0 end desc,cs.applied_order desc,v.id desc limit 1',version_table,version_filter) into row_data using (item->>'record_id')::uuid,app_id,customer_id;
    if row_data is not null and not (row_data->>'tombstones_record')::boolean then
      perform kernel_draft_validate_unique(model,row_data,version_table,app_id,customer_id,(item->>'record_id')::uuid);
    end if;
    if model->>'kind'='lookup' and row_data is not null then
      update lookup_alias_projection projection set is_current=false
      where projection.app_id=kernel_draft_api.app_id and projection.customer_id=kernel_draft_api.customer_id
        and projection.model_id=model->>'id' and projection.record_id=(item->>'record_id')::uuid and projection.is_current;
      perform kernel_apply_project_lookup_version(
        (row_data->>'id')::uuid,app_id,customer_id,model->>'id',(item->>'record_id')::uuid,
        schema_json,model,coalesce(row_data->'values','{}'::jsonb),coalesce(row_data->'many_relations','{}'::jsonb),
        not (row_data->>'tombstones_record')::boolean and coalesce(row_data->>'availability','active')='active'
      );
    end if;
    record_table:=kernel_draft_record_table(model); record_filter:=kernel_draft_model_filter(model,'r');
    execute format('update %I r set external_key=null where r.id=$1 and r.app_id=$2 and r.customer_id=$3%s and r.external_key is not null and not exists(select 1 from %I v where v.record_id=r.id and v.app_id=r.app_id and v.customer_id=r.customer_id%s and v.stage in (''draft'',''mainline''))',record_table,record_filter,version_table,kernel_draft_model_filter(model,'v')) using (item->>'record_id')::uuid,app_id,customer_id;
  end loop;
  interval_violation := kernel_constraint_interval_violation(app_id, customer_id, null, interval_scope);
  if interval_violation is not null then perform kernel_draft_fail(interval_violation->>'code', interval_violation->>'message', interval_violation->'details'); end if;
  return kernel_draft_ok(jsonb_build_object('id',revert_id,'schema_revision_id',revision_id));
exception when unique_violation then return kernel_draft_unique_error(model,row_data);
when others then
  if sqlstate='AR001' then return sqlerrm::jsonb; end if;
  return kernel_draft_error('database_error','Database operation failed');
end
$kernel$;
"#;
