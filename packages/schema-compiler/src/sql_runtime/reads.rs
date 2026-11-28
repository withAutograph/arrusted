use super::RuntimeSqlFunction;

pub(super) fn functions() -> Vec<RuntimeSqlFunction> {
    [
        (
            "kernel_read_physical_identifier(text)",
            READ_PHYSICAL_IDENTIFIER,
        ),
        ("kernel_read_error_envelope(text,text)", READ_ERROR_ENVELOPE),
        ("kernel_read_scope_schema(text,text)", READ_SCOPE_SCHEMA),
        (
            "kernel_read_custom_fields(jsonb,text,jsonb)",
            READ_CUSTOM_FIELDS,
        ),
        (
            "kernel_read_custom_field_map(jsonb,text,jsonb)",
            READ_CUSTOM_FIELD_MAP,
        ),
        (
            "kernel_read_field_values_expression(text,jsonb,jsonb)",
            READ_FIELD_VALUES_EXPRESSION,
        ),
        (
            "kernel_read_lookup_values(jsonb,jsonb,jsonb)",
            READ_LOOKUP_VALUES,
        ),
        (
            "kernel_read_assert_lookup_storage_authority(text,text,text)",
            READ_ASSERT_LOOKUP_STORAGE_AUTHORITY,
        ),
        (
            "kernel_read_assert_mainline_order(text,text,text)",
            READ_ASSERT_MAINLINE_ORDER,
        ),
        (
            "kernel_read_enum_audit_value(jsonb,jsonb,text,text,jsonb,bigint)",
            READ_ENUM_AUDIT_VALUE,
        ),
        (
            "kernel_read_visible_records_core(jsonb,boolean)",
            READ_VISIBLE_RECORDS_CORE,
        ),
        (
            "kernel_read_aggregate_bin(numeric,jsonb)",
            include_str!("aggregate_bin.sql"),
        ),
        (
            "kernel_read_aggregate_percentile(numeric[],numeric)",
            include_str!("aggregate_percentile.sql"),
        ),
        (
            "kernel_read_draft_versions_sql(text,text,text,text)",
            include_str!("draft_overlay.sql"),
        ),
        (
            "kernel_data_query_core(jsonb,jsonb,boolean)",
            include_str!("data_query.sql"),
        ),
        (
            "kernel_data_query_scan(jsonb,jsonb)",
            r#"
-- Private: every authorized row of one query, unpaginated, as read images.
-- Work rules and relation lookups use it; it is not a runtime entrypoint.
create or replace function kernel_data_query_scan(request jsonb, work jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path from current
as $kernel$
declare
  answer jsonb := kernel_data_query_core(request, work, true);
begin
  if answer->'ok' is distinct from 'true'::jsonb then
    raise exception '%: %', answer#>>'{error,code}', answer#>>'{error,message}';
  end if;
  return answer->'data';
end;
$kernel$;
"#,
        ),
        (
            "kernel_data_query(jsonb)",
            r#"
create or replace function kernel_data_query(request jsonb)
returns jsonb
language sql
volatile
security invoker
set search_path from current
as $kernel$
select kernel_data_query_core(request,null,false);
$kernel$;
"#,
        ),
        ("kernel_read_visible_records(jsonb)", READ_VISIBLE_RECORDS),
        ("kernel_read_visible_record(jsonb)", READ_VISIBLE_RECORD),
        (
            "kernel_read_visible_records_by_model(jsonb)",
            READ_VISIBLE_RECORDS_BY_MODEL,
        ),
        (
            "kernel_read_visible_records_by_text_fields(jsonb)",
            READ_VISIBLE_RECORDS_BY_TEXT_FIELDS,
        ),
        (
            "kernel_read_visible_record_for_update(jsonb)",
            READ_VISIBLE_RECORD_FOR_UPDATE,
        ),
        (
            "kernel_read_guarded_prepare_visible_query(jsonb)",
            READ_GUARDED_PREPARE_VISIBLE_QUERY,
        ),
        ("kernel_query_visible_sql(jsonb)", QUERY_VISIBLE_SQL),
        ("kernel_change_set_diff(jsonb)", CHANGE_SET_DIFF),
        ("kernel_field_history(jsonb)", FIELD_HISTORY),
        ("kernel_recent_activity(jsonb)", RECENT_ACTIVITY),
    ]
    .into_iter()
    .map(|(signature, sql)| RuntimeSqlFunction {
        signature,
        sql: sql.trim().to_string(),
    })
    .collect()
}

const READ_PHYSICAL_IDENTIFIER: &str = r#"
create or replace function kernel_read_physical_identifier(logical_id text)
returns text
language plpgsql
immutable
security invoker
set search_path from current
as $kernel$
declare
  normalized text;
begin
  if logical_id is null
     or btrim(logical_id) = ''
     or logical_id ~ '[^A-Za-z0-9_[:space:]-]' then
    raise exception 'contract_validation_failed: invalid identifier `%`', logical_id;
  end if;
  normalized := regexp_replace(lower(btrim(logical_id)), '[[:space:]_-]+', '_', 'g');
  normalized := btrim(normalized, '_');
  if normalized = '' or normalized !~ '^[a-z][a-z0-9_]*$' then
    raise exception 'contract_validation_failed: invalid identifier `%`', logical_id;
  end if;
  return kernel_physical_identifier(logical_id);
end;
$kernel$
"#;

const READ_ERROR_ENVELOPE: &str = r#"
create or replace function kernel_read_error_envelope(error_sqlstate text, error_message text)
returns jsonb
language plpgsql
stable
security invoker
set search_path from current
as $kernel$
declare
  error_code text;
  details text;
  drift_object text;
  drift_details text;
begin
  if error_message is not null and position(': ' in error_message) > 0 then
    error_code := split_part(error_message, ': ', 1);
    details := substring(error_message from length(error_code) + 3);
  end if;

  if error_code = 'active_schema_missing' then
    return jsonb_build_object(
      'code', 'active_schema_missing',
      'message', 'No active schema revision exists for this scope',
      'details', jsonb_build_array(jsonb_build_object(
        'path', 'scope',
        'code', 'active_schema_missing',
        'message', details || ': materialize a schema before applying or reading records'
      ))
    );
  elsif error_code = 'record_target_missing' then
    return jsonb_build_object(
      'code', 'record_target_missing', 'message', details, 'details', '[]'::jsonb
    );
  elsif error_code = 'schema_drift' then
    drift_object := split_part(details, '|', 1);
    drift_details := substring(details from length(drift_object) + 2);
    return jsonb_build_object(
      'code', 'schema_drift',
      'message', 'Schema drift detected',
      'details', jsonb_build_array(jsonb_build_object(
        'path', 'object',
        'code', 'schema_drift',
        'message', drift_object || ': ' || drift_details
      ))
    );
  elsif error_code = 'query_rejected' then
    return jsonb_build_object(
      'code', 'query_rejected', 'message', details, 'details', '[]'::jsonb
    );
  elsif error_code = 'query_timeout' then
    return jsonb_build_object(
      'code', 'query_timeout', 'message', details, 'details', '[]'::jsonb
    );
  elsif error_code = 'unsupported_capability' then
    return jsonb_build_object(
      'code', 'unsupported_capability', 'message', details, 'details', '[]'::jsonb
    );
  elsif error_code = 'authorization_denied' and (
    details like 'no applicable authorization grant permits %'
    or details like 'a historical snapshot is not authorized %'
  ) then
    -- A bound actor whose role grants don't cover the request: say so rather
    -- than reporting a tenant binding failure.
    return jsonb_build_object(
      'code', 'authorization_denied',
      'message', 'Read is not authorized by the current grants',
      'details', jsonb_build_array(jsonb_build_object(
        'path', 'grants',
        'code', 'grant_not_authorized',
        'message', details
      ))
    );
  elsif error_code = 'authorization_denied' then
    return jsonb_build_object(
      'code', 'authorization_denied',
      'message', 'Tenant scope is not authorized',
      'details', jsonb_build_array(jsonb_build_object(
        'path', 'scope',
        'code', 'tenant_scope_not_bound',
        'message', coalesce(details, 'the authenticated database principal is not bound to the requested tenant')
      ))
    );
  elsif error_code = 'lookup_storage_authority_mismatch' then
    return jsonb_build_object(
      'code', 'lookup_storage_authority_mismatch',
      'message', 'Lookup storage authority mismatch',
      'details', jsonb_build_array(jsonb_build_object(
        'path', 'model_id',
        'code', 'lookup_storage_authority_mismatch',
        'message', details
      ))
    );
  elsif error_code = 'contract_validation_failed'
        or error_sqlstate in ('22007', '22P02', '22023') then
    return jsonb_build_object(
      'code', 'contract_validation_failed',
      'message', 'Contract validation failed',
      'details', jsonb_build_array(jsonb_build_object(
        'path', 'request',
        'code', 'sql_contract_validation_failed',
        'message', coalesce(details, error_message, 'invalid generated SQL request')
      ))
    );
  end if;

  return jsonb_build_object(
    'code', 'database_error',
    'message', 'Database operation failed',
    'details', '[]'::jsonb
  );
end;
$kernel$
"#;

const READ_ASSERT_LOOKUP_STORAGE_AUTHORITY: &str = r#"
create or replace function kernel_read_assert_lookup_storage_authority(
  requested_app_id text,
  requested_customer_id text,
  requested_model_id text
)
returns void
language plpgsql
volatile
security invoker
set search_path from current
as $kernel$
declare
  authority_error jsonb;
  authority_exists boolean;
  generic_rows_exist boolean;
begin
  authority_error := kernel_lookup_storage_authority_error(
    requested_app_id, requested_customer_id, requested_model_id
  );
  if authority_error is not null then
    raise exception 'lookup_storage_authority_mismatch: %',
      authority_error#>>'{details,0,message}';
  end if;

  select exists(
    select 1
    from lookup_storage_authority authority
    where authority.app_id = requested_app_id
      and authority.customer_id = requested_customer_id
      and authority.model_id = requested_model_id
  ) into authority_exists;
  if authority_exists then
    return;
  end if;

  select exists(
    select 1
    from lookup_record record
    where record.app_id = requested_app_id
      and record.customer_id = requested_customer_id
      and record.model_id = requested_model_id
    union all
    select 1
    from lookup_version version
    where version.app_id = requested_app_id
      and version.customer_id = requested_customer_id
      and version.model_id = requested_model_id
  ) into generic_rows_exist;
  if generic_rows_exist then
    raise exception 'lookup_storage_authority_mismatch: generic lookup storage has rows but no authority is declared for `%/%/%`',
      requested_app_id, requested_customer_id, requested_model_id;
  end if;
end;
$kernel$
"#;

const READ_SCOPE_SCHEMA: &str = r#"
create or replace function kernel_read_scope_schema(request_app_id text, request_customer_id text)
returns jsonb
language plpgsql
stable
security invoker
set search_path from current
as $kernel$
declare
  active_schema jsonb;
begin
  if request_app_id is null or btrim(request_app_id) = ''
     or request_customer_id is null or btrim(request_customer_id) = '' then
    raise exception 'contract_validation_failed: app_id and customer_id are required';
  end if;
  if not kernel_principal_scope_authorized(
    'runtime', request_app_id, request_customer_id, null
  ) then
    raise exception 'authorization_denied: the authenticated database principal is not bound to the requested tenant and runtime capability';
  end if;
  perform set_config('kernel.app_id', request_app_id, true);
  perform set_config('kernel.customer_id', request_customer_id, true);
  select schema
  into active_schema
  from schema_revision
  where app_id = request_app_id
    and customer_id = request_customer_id
    and activated_at is not null;
  if active_schema is null then
    raise exception 'active_schema_missing: %/%', request_app_id, request_customer_id;
  end if;
  return active_schema;
end;
$kernel$
"#;

const READ_CUSTOM_FIELDS: &str = r#"
create or replace function kernel_read_custom_fields(
  request_schema jsonb,
  request_model_id text,
  stored_entries jsonb
)
returns jsonb
language sql
stable
security invoker
set search_path from current
as $kernel$
  -- A declared field or many-relation id, retired included, always means the
  -- declared element, so a stored custom value under that id is not returned.
  -- The declared ids are collected once per call, not once per entry.
  with declared as (
    select coalesce(jsonb_agg(declared.value->>'id'), '[]'::jsonb) ids
    from jsonb_array_elements(coalesce(request_schema->'models', '[]'::jsonb)) model(value)
    cross join jsonb_array_elements(
      coalesce(model.value->'fields', '[]'::jsonb) || coalesce(model.value->'many_relations', '[]'::jsonb)
    ) declared(value)
    where model.value->>'id' = request_model_id
      and stored_entries is not null and stored_entries <> '[]'::jsonb
  )
  select coalesce(jsonb_agg(entry.value order by entry.ordinal), '[]'::jsonb)
  from declared
  cross join jsonb_array_elements(coalesce(stored_entries, '[]'::jsonb))
       with ordinality as entry(value, ordinal)
  where not declared.ids ? (entry.value->>'field_id')
  and case
    when coalesce(entry.value->>'type', '') <> 'enum' then true
    else not exists (
      select 1
      from jsonb_array_elements(coalesce(request_schema->'custom_fields', '[]'::jsonb)) definition(value)
      where definition.value->>'model_id' = request_model_id
        and definition.value->>'field_id' = entry.value->>'field_id'
        and coalesce(definition.value->'archived_at', 'null'::jsonb) = 'null'::jsonb
        and definition.value->>'type' = 'enum'
        and not exists (
          select 1
          from jsonb_array_elements(coalesce(definition.value->'option_set', '[]'::jsonb)) option(value)
          where option.value->>'id' = entry.value->>'value'
        )
    )
  end;
$kernel$
"#;

const READ_CUSTOM_FIELD_MAP: &str = r#"
create or replace function kernel_read_custom_field_map(
  schema_json jsonb,
  model_id text,
  entries jsonb
)
returns jsonb
language plpgsql
stable
security invoker
set search_path from current
as $kernel$
declare
  result jsonb;
begin
  select coalesce(jsonb_object_agg(entry.value->>'field_id', entry.value - 'field_id'), '{}'::jsonb)
  into result
  from jsonb_array_elements(kernel_read_custom_fields(schema_json, model_id, entries)) entry(value);
  return result;
end;
$kernel$
"#;

const READ_FIELD_VALUES_EXPRESSION: &str = r#"
create or replace function kernel_read_field_values_expression(
  row_alias text,
  model jsonb,
  projection jsonb default '[]'::jsonb
)
returns text
language plpgsql
immutable
security invoker
set search_path from current
as $kernel$
declare
  field jsonb;
  field_id text;
  field_type text;
  field_identifier text;
  amount_identifier text;
  currency_identifier text;
  period_identifier text;
  expression text := '''{}''::jsonb';
begin
  if row_alias is null or row_alias !~ '^[a-z][a-z0-9_]*$' then
    raise exception 'contract_validation_failed: invalid SQL row alias `%`', row_alias;
  end if;
  for field in
    select field_value.value
    from jsonb_array_elements(model->'fields') with ordinality field_value(value, ordinal)
    where jsonb_array_length(coalesce(projection, '[]'::jsonb)) = 0
       or field_value.value->>'id' in (
         select jsonb_array_elements_text(projection)
       )
    order by field_value.ordinal
  loop
    field_id := field->>'id';
    field_type := field->>'type';
    field_identifier := kernel_read_physical_identifier(field_id);
    if field_type in ('text', 'iso_country', 'iso_currency') then
      expression := expression || format(
        ' || case when %1$s.%2$I is null then ''{}''::jsonb else jsonb_build_object(%3$L, jsonb_build_object(''type'', ''text'', ''value'', %1$s.%2$I)) end',
        row_alias, field_identifier, field_id
      );
    elsif field_type = 'number' then
      expression := expression || format(
        ' || case when %1$s.%2$I is null then ''{}''::jsonb else jsonb_build_object(%3$L, jsonb_build_object(''type'', ''number'', ''value'', %1$s.%2$I::text)) end',
        row_alias, field_identifier, field_id
      );
    elsif field_type = 'bool' then
      expression := expression || format(
        ' || case when %1$s.%2$I is null then ''{}''::jsonb else jsonb_build_object(%3$L, jsonb_build_object(''type'', ''bool'', ''value'', %1$s.%2$I)) end',
        row_alias, field_identifier, field_id
      );
    elsif field_type = 'date' then
      expression := expression || format(
        ' || case when %1$s.%2$I is null then ''{}''::jsonb else jsonb_build_object(%3$L, jsonb_build_object(''type'', ''date'', ''value'', to_char(%1$s.%2$I, ''YYYY-MM-DD''))) end',
        row_alias, field_identifier, field_id
      );
    elsif field_type = 'datetime' then
      expression := expression || format(
        ' || case when %1$s.%2$I is null then ''{}''::jsonb else jsonb_build_object(%3$L, jsonb_build_object(''type'', ''datetime'', ''value'', regexp_replace(to_char(%1$s.%2$I at time zone ''UTC'', ''YYYY-MM-DD"T"HH24:MI:SS.US"Z"''), ''\.000000Z$'', ''Z''))) end',
        row_alias, field_identifier, field_id
      );
    elsif field_type = 'relation' then
      expression := expression || format(
        ' || case when %1$s.%2$I is null then ''{}''::jsonb else jsonb_build_object(%3$L, jsonb_build_object(''type'', ''relation'', ''value'', jsonb_build_object(''type'', ''record_id'', ''value'', %1$s.%2$I))) end',
        row_alias, field_identifier, field_id
      );
    elsif field_type in ('text_list', 'known_aliases') then
      expression := expression || format(
        ' || case when %1$s.%2$I is null then ''{}''::jsonb else jsonb_build_object(%3$L, jsonb_build_object(''type'', ''text_list'', ''value'', %1$s.%2$I)) end',
        row_alias, field_identifier, field_id
      );
    elsif field_type = 'json' then
      expression := expression || format(
        ' || case when %1$s.%2$I is null then ''{}''::jsonb else jsonb_build_object(%3$L, jsonb_build_object(''type'', ''json'', ''value'', %1$s.%2$I)) end',
        row_alias, field_identifier, field_id
      );
    elsif field_type = 'enum' then
      expression := expression || format(
        ' || case when %1$s.%2$I is null or not exists (select 1 from jsonb_array_elements(%4$L::jsonb) option(value) where option.value->>''id'' = %1$s.%2$I) then ''{}''::jsonb else jsonb_build_object(%3$L, jsonb_build_object(''type'', ''enum'', ''value'', %1$s.%2$I)) end',
        row_alias, field_identifier, field_id, coalesce(field->'option_set', '[]'::jsonb)::text
      );
    elsif field_type = 'money_rate' then
      amount_identifier := kernel_read_physical_identifier(field_id || '_amount');
      currency_identifier := kernel_read_physical_identifier(field_id || '_currency');
      period_identifier := kernel_read_physical_identifier(field_id || '_period');
      expression := expression || format(
        ' || case when %1$s.%2$I is null or %1$s.%3$I is null or %1$s.%4$I is null then ''{}''::jsonb else jsonb_build_object(%5$L, jsonb_build_object(''type'', ''money_rate'', ''value'', jsonb_build_object(''amount'', %1$s.%2$I::text, ''currency'', %1$s.%3$I, ''period'', %1$s.%4$I))) end',
        row_alias, amount_identifier, currency_identifier, period_identifier, field_id
      );
    else
      raise exception 'schema_drift: %|unsupported field type `%`', field_id, field_type;
    end if;
  end loop;
  return expression;
end;
$kernel$
"#;

const READ_LOOKUP_VALUES: &str = r#"
create or replace function kernel_read_lookup_values(model jsonb, stored_values jsonb, projection jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path from current
as $kernel$
declare
  field jsonb;
  field_id text;
  typed_value jsonb;
  result jsonb := '{}'::jsonb;
begin
  for field in select value from jsonb_array_elements(coalesce(model->'fields','[]'::jsonb)) item(value) loop
    field_id := field->>'id';
    if jsonb_array_length(coalesce(projection,'[]'::jsonb))>0 and not (projection ? field_id) then continue; end if;
    typed_value := stored_values->field_id;
    if typed_value is null then continue; end if;
    if field->>'type'='enum' and not exists(
      select 1 from jsonb_array_elements(coalesce(field->'option_set','[]'::jsonb)) option(value)
      where value->>'id'=typed_value->>'value'
    ) then continue; end if;
    result := result || jsonb_build_object(field_id,typed_value);
  end loop;
  return result;
end;
$kernel$
"#;

const READ_ASSERT_MAINLINE_ORDER: &str = r#"
create or replace function kernel_read_assert_mainline_order(
  version_table text,
  request_app_id text,
  request_customer_id text
)
returns void
language plpgsql
stable
security invoker
set search_path from current
as $kernel$
declare
  drift record;
  query_sql text;
  status_display text;
  order_display text;
begin
  -- Version rows reference their tenant change set by foreign key, so drift
  -- can only come from an unapplied change set. Start from those few change
  -- sets and probe their rows by index instead of scanning every version.
  query_sql := format(
    'select v.id, v.change_set_id, cs.status, cs.applied_order from change_set cs join %I v on v.change_set_id = cs.id and v.app_id = cs.app_id and v.customer_id = cs.customer_id where cs.app_id = $1 and cs.customer_id = $2 and (cs.status <> ''mainline'' or cs.applied_order is null) and v.stage in (''mainline'', ''reverted'') limit 1',
    version_table
  );
  execute query_sql using request_app_id, request_customer_id into drift;
  if drift.id is null then return; end if;
  status_display := case when drift.status is null then 'None' else 'Some("' || drift.status || '")' end;
  order_display := case when drift.applied_order is null then 'None' else 'Some(' || drift.applied_order::text || ')' end;
  raise exception 'schema_drift: %|version `%` is mainline history but owning change_set `%` has status % and applied_order %',
    version_table, drift.id, drift.change_set_id, status_display, order_display;
end;
$kernel$
"#;

const READ_ENUM_AUDIT_VALUE: &str = r#"
create or replace function kernel_read_enum_audit_value(
  request_current_schema jsonb,
  request_event_schema jsonb,
  requested_model_id text,
  requested_field_id text,
  typed_value jsonb,
  event_schema_revision_id bigint
)
returns jsonb
language plpgsql
stable
security invoker
set search_path from current
as $kernel$
declare
  option_id text;
  event_fields jsonb;
  current_fields jsonb;
  event_field jsonb;
  current_field jsonb;
  event_option jsonb;
  current_option jsonb;
begin
  if typed_value is null or typed_value->>'type' <> 'enum' then
    return null;
  end if;
  option_id := typed_value->>'value';
  if option_id is null or btrim(option_id) = '' then
    raise exception 'schema_drift: enum|stored enum value for `%`.`%` has no option identity', requested_model_id, requested_field_id;
  end if;

  select coalesce(jsonb_agg(candidate.definition order by candidate.kind), '[]'::jsonb)
  into event_fields
  from (
    select 'declared' kind, field.value definition
    from jsonb_array_elements(coalesce(request_event_schema->'models', '[]'::jsonb)) model(value)
    cross join lateral jsonb_array_elements(coalesce(model.value->'fields', '[]'::jsonb)) field(value)
    where model.value->>'id' = requested_model_id and field.value->>'id' = requested_field_id
    union all
    select 'custom' kind, definition.value
    from jsonb_array_elements(coalesce(request_event_schema->'custom_fields', '[]'::jsonb)) definition(value)
    where definition.value->>'model_id' = requested_model_id
      and definition.value->>'field_id' = requested_field_id
  ) candidate;
  if jsonb_array_length(event_fields) <> 1 or event_fields->0->>'type' <> 'enum' then
    raise exception 'schema_drift: enum|enum field `%`.`%` is not declared in pinned schema revision `%`', requested_model_id, requested_field_id, event_schema_revision_id;
  end if;
  event_field := event_fields->0;
  select option.value into event_option
  from jsonb_array_elements(coalesce(event_field->'option_set', '[]'::jsonb)) option(value)
  where option.value->>'id' = option_id;
  if event_option is null then
    raise exception 'schema_drift: enum|enum option `%` is not declared for `%`.`%` in pinned schema revision `%`', option_id, requested_model_id, requested_field_id, event_schema_revision_id;
  end if;

  select coalesce(jsonb_agg(candidate.definition order by candidate.kind), '[]'::jsonb)
  into current_fields
  from (
    select 'declared' kind, field.value definition
    from jsonb_array_elements(coalesce(request_current_schema->'models', '[]'::jsonb)) model(value)
    cross join lateral jsonb_array_elements(coalesce(model.value->'fields', '[]'::jsonb)) field(value)
    where model.value->>'id' = requested_model_id and field.value->>'id' = requested_field_id
    union all
    select 'custom' kind, definition.value
    from jsonb_array_elements(coalesce(request_current_schema->'custom_fields', '[]'::jsonb)) definition(value)
    where definition.value->>'model_id' = requested_model_id
      and definition.value->>'field_id' = requested_field_id
  ) candidate;
  if jsonb_array_length(current_fields) > 1 then
    raise exception 'schema_drift: enum|active schema declares `%`.`%` more than once', requested_model_id, requested_field_id;
  end if;
  current_field := case when jsonb_array_length(current_fields) = 1
    and current_fields->0->>'type' = 'enum' then current_fields->0 else null end;
  if current_field is not null then
    select option.value into current_option
    from jsonb_array_elements(coalesce(current_field->'option_set', '[]'::jsonb)) option(value)
    where option.value->>'id' = option_id;
  end if;

  return jsonb_build_object(
    'option_id', option_id,
    'event_schema_revision_id', event_schema_revision_id,
    'current_label', current_option->>'label',
    'event_label', event_option->>'label'
  );
end;
$kernel$
"#;

const READ_VISIBLE_RECORDS_CORE: &str = r#"
create or replace function kernel_read_visible_records_core(request jsonb, lock_record boolean)
returns jsonb
language plpgsql
volatile
security invoker
set search_path from current
as $kernel$
declare
  request_app_id text;
  request_customer_id text;
  request_model_id text;
  request_as_of date;
  request_projection jsonb := coalesce(request->'fields', '[]'::jsonb);
  request_record_ids jsonb := coalesce(request->'record_ids', '[]'::jsonb);
  request_text_filters jsonb := coalesce(request->'field_filters', '{}'::jsonb);
  request_limit bigint;
  schema_json jsonb;
  model_json jsonb;
  model_identifier text;
  record_table text;
  version_table text;
  values_expression text;
  record_filter_sql text := '';
  text_filter_sql text := '';
  field_filter record;
  field_json jsonb;
  field_identifier text;
  query_sql text;
  result_json jsonb;
begin
  if request is null or jsonb_typeof(request) <> 'object' then
    raise exception 'contract_validation_failed: request must be a JSON object';
  end if;
  request_app_id := request->>'app_id';
  request_customer_id := request->>'customer_id';
  request_model_id := request->>'model_id';
  if request_model_id is null or btrim(request_model_id) = '' or request->>'as_of' is null then
    raise exception 'contract_validation_failed: model_id and as_of are required';
  end if;
  request_as_of := (request->>'as_of')::date;
  if request ? 'limit' and request->'limit' <> 'null'::jsonb then
    if jsonb_typeof(request->'limit') <> 'number'
       or request->>'limit' !~ '^[0-9]+$'
       or (request->>'limit')::numeric > 9223372036854775807
       or (request->>'limit')::numeric < 1 then
      raise exception 'contract_validation_failed: limit must be a positive integer';
    end if;
    request_limit := (request->>'limit')::bigint;
  end if;
  if jsonb_typeof(request_projection) <> 'array'
     or jsonb_typeof(request_record_ids) <> 'array'
     or jsonb_typeof(request_text_filters) <> 'object' then
    raise exception 'contract_validation_failed: fields and record_ids must be arrays and field_filters must be an object';
  end if;
  schema_json := kernel_read_scope_schema(request_app_id, request_customer_id);
  select model.value
  into model_json
  from jsonb_array_elements(schema_json->'models') model(value)
  where model.value->>'id' = request_model_id;
  if model_json is null then
    raise exception 'record_target_missing: model `%` is not declared in active schema', request_model_id;
  end if;
  if exists (
    select 1 from jsonb_array_elements_text(request_projection) projected(field_id)
    where not exists (
      select 1 from jsonb_array_elements(model_json->'fields') field(value)
      where field.value->>'id' = projected.field_id
    )
  ) then
    select projected.field_id into field_identifier
    from jsonb_array_elements_text(request_projection) projected(field_id)
    where not exists (
      select 1 from jsonb_array_elements(model_json->'fields') field(value)
      where field.value->>'id' = projected.field_id
    ) limit 1;
    raise exception 'record_target_missing: field `%` is not declared on model `%`', field_identifier, request_model_id;
  end if;
  if model_json->>'kind'='lookup' then
    perform kernel_read_assert_lookup_storage_authority(
      request_app_id, request_customer_id, request_model_id
    );
    record_table := 'lookup_record';
    version_table := 'lookup_version';
  else
    model_identifier := kernel_read_physical_identifier(request_model_id);
    record_table := kernel_read_physical_identifier(request_model_id || '_record');
    version_table := kernel_read_physical_identifier(request_model_id || '_version');
  end if;
  perform kernel_read_assert_mainline_order(version_table, request_app_id, request_customer_id);
  if jsonb_array_length(request_record_ids) > 0 then
    record_filter_sql := ' and r.id in (select value::uuid from jsonb_array_elements_text($4))';
  end if;
  for field_filter in select key, value #>> '{}' as value from jsonb_each(request_text_filters) loop
    select field.value into field_json
    from jsonb_array_elements(model_json->'fields') field(value)
    where field.value->>'id' = field_filter.key;
    if field_json is null then
      raise exception 'record_target_missing: field `%` is not declared on model `%`', field_filter.key, request_model_id;
    end if;
    if field_json->>'type' not in ('text', 'iso_country', 'iso_currency') then
      raise exception 'record_target_missing: field `%` on model `%` is not a text field', field_filter.key, request_model_id;
    end if;
    if model_json->>'kind'='lookup' then
      text_filter_sql := text_filter_sql || format(
        ' and v.values->%L->>''value'' = %L', field_filter.key, field_filter.value
      );
    else
      field_identifier := kernel_read_physical_identifier(field_filter.key);
      text_filter_sql := text_filter_sql || format(
        ' and v.%I = %L', field_identifier, field_filter.value
      );
    end if;
  end loop;
  if model_json->>'kind'='lookup' then
    query_sql := format(
      $query$
      select coalesce(jsonb_agg(visible.row_json order by visible.external_key nulls last,visible.record_id),'[]'::jsonb)
      from (
        select r.external_key,r.id record_id,jsonb_build_object(
          'record_id',r.id,'version_id',v.id,'external_key',r.external_key,
          'effective_start',to_char(v.effective_start,'YYYY-MM-DD'),
          'effective_end',case when v.effective_end is null then null else to_char(v.effective_end,'YYYY-MM-DD') end,
          'values',kernel_read_lookup_values($5,v.values,$7),
          'custom_fields',kernel_read_custom_fields($8,$3,v.custom_fields),
          'metadata',v.metadata,
          'many_relations',v.many_relations,
          'availability',v.availability
        ) row_json
        from lookup_record r
        join lateral (
          select v.* from lookup_version v join change_set cs
            on cs.id=v.change_set_id and cs.app_id=v.app_id and cs.customer_id=v.customer_id
           and cs.status='mainline' and cs.applied_order is not null
          where v.app_id=r.app_id and v.customer_id=r.customer_id and v.model_id=r.model_id
            and v.record_id=r.id and v.stage='mainline' and v.effective_start<=$6
            and (v.effective_end is null or v.effective_end>=$6)
          order by v.effective_start desc,v.tombstones_record desc,v.untombstones_record desc,
            cs.applied_order desc,v.id desc limit 1
        ) v on true
        where r.app_id=$1 and r.customer_id=$2 and r.model_id=$3%s%s
          and not v.tombstones_record and not v.untombstones_record
        order by r.external_key nulls last,r.id limit $9 %s
      ) visible
      $query$,
      record_filter_sql,text_filter_sql,case when lock_record then 'for update of r' else '' end
    );
    execute query_sql using request_app_id,request_customer_id,request_model_id,request_record_ids,
      model_json,request_as_of,request_projection,schema_json,request_limit into result_json;
    return coalesce(result_json,'[]'::jsonb);
  end if;
  values_expression := kernel_read_field_values_expression('v', model_json, request_projection);
  query_sql := format(
    $query$
    select coalesce(jsonb_agg(visible.row_json order by visible.external_key nulls last, visible.record_id), '[]'::jsonb)
    from (
      select r.external_key, r.id as record_id,
        jsonb_build_object(
          'record_id', r.id,
          'version_id', v.id,
          'external_key', r.external_key,
          'effective_start', to_char(v.effective_start, 'YYYY-MM-DD'),
          'effective_end', case when v.effective_end is null then null else to_char(v.effective_end, 'YYYY-MM-DD') end,
          'values', (%s),
          'custom_fields', kernel_read_custom_fields($5, $3, v.custom_fields),
          'metadata', coalesce(v.metadata, '{}'::jsonb)
        ) as row_json
      from %I r
      join lateral (
        select v.*
        from %I v
        join change_set cs
          on cs.id = v.change_set_id
         and cs.app_id = v.app_id
         and cs.customer_id = v.customer_id
         and cs.status = 'mainline'
         and cs.applied_order is not null
        where v.record_id = r.id
          and v.app_id = r.app_id
          and v.customer_id = r.customer_id
          and v.stage = 'mainline'
          and v.effective_start <= $6
          and (v.effective_end is null or v.effective_end >= $6)
        order by
          v.effective_start desc,
          v.tombstones_record desc,
          v.untombstones_record desc,
          cs.applied_order desc,
          v.id desc
        limit 1
      ) v on true
      where r.app_id = $1
        and r.customer_id = $2
        %s
        %s
        and not v.tombstones_record
        and not v.untombstones_record
      order by r.external_key nulls last, r.id
      limit $7
      %s
    ) visible
    $query$,
    values_expression,
    record_table,
    version_table,
    record_filter_sql,
    text_filter_sql,
    case when lock_record then 'for update of r' else '' end
  );
  execute query_sql
    using request_app_id, request_customer_id, request_model_id, request_record_ids, schema_json, request_as_of, request_limit
    into result_json;
  return coalesce(result_json, '[]'::jsonb);
end;
$kernel$
"#;

const READ_VISIBLE_RECORDS: &str = r#"
create or replace function kernel_read_visible_records(request jsonb)
returns jsonb language plpgsql volatile security invoker set search_path from current
as $kernel$
begin
  perform kernel_policy_reject_unsupported_capability(
    request->>'app_id', request->>'customer_id', 'legacy canonical record reads'
  );
  return jsonb_build_object('ok', true, 'data', kernel_read_visible_records_core(request, false));
exception when others then
  return jsonb_build_object('ok', false, 'error', kernel_read_error_envelope(sqlstate, sqlerrm));
end;
$kernel$
"#;

const READ_VISIBLE_RECORD: &str = r#"
create or replace function kernel_read_visible_record(request jsonb)
returns jsonb language plpgsql volatile security invoker set search_path from current
as $kernel$
declare records jsonb;
begin
  perform kernel_policy_reject_unsupported_capability(
    request->>'app_id', request->>'customer_id', 'legacy canonical record reads'
  );
  if request->>'record_id' is null then
    raise exception 'contract_validation_failed: record_id is required';
  end if;
  records := kernel_read_visible_records_core(
    request || jsonb_build_object('record_ids', jsonb_build_array(request->>'record_id')),
    false
  );
  return jsonb_build_object('ok', true, 'data', records->0);
exception when others then
  return jsonb_build_object('ok', false, 'error', kernel_read_error_envelope(sqlstate, sqlerrm));
end;
$kernel$
"#;

const READ_VISIBLE_RECORDS_BY_TEXT_FIELDS: &str = r#"
create or replace function kernel_read_visible_records_by_text_fields(request jsonb)
returns jsonb language plpgsql volatile security invoker set search_path from current
as $kernel$
begin
  perform kernel_policy_reject_unsupported_capability(
    request->>'app_id', request->>'customer_id', 'legacy canonical record reads'
  );
  return jsonb_build_object('ok', true, 'data', kernel_read_visible_records_core(request, false));
exception when others then
  return jsonb_build_object('ok', false, 'error', kernel_read_error_envelope(sqlstate, sqlerrm));
end;
$kernel$
"#;

const READ_VISIBLE_RECORD_FOR_UPDATE: &str = r#"
create or replace function kernel_read_visible_record_for_update(request jsonb)
returns jsonb language plpgsql volatile security invoker set search_path from current
as $kernel$
declare records jsonb;
begin
  perform kernel_policy_reject_unsupported_capability(
    request->>'app_id', request->>'customer_id', 'legacy canonical record reads'
  );
  if request->>'record_id' is null then
    raise exception 'contract_validation_failed: record_id is required';
  end if;
  records := kernel_read_visible_records_core(
    request || jsonb_build_object('record_ids', jsonb_build_array(request->>'record_id')),
    true
  );
  return jsonb_build_object('ok', true, 'data', records->0);
exception when others then
  return jsonb_build_object('ok', false, 'error', kernel_read_error_envelope(sqlstate, sqlerrm));
end;
$kernel$
"#;

const READ_VISIBLE_RECORDS_BY_MODEL: &str = r#"
create or replace function kernel_read_visible_records_by_model(request jsonb)
returns jsonb language plpgsql volatile security invoker set search_path from current
as $kernel$
declare
  model_id text;
  model_request jsonb;
  records_by_model jsonb := '{}'::jsonb;
begin
  perform kernel_policy_reject_unsupported_capability(
    request->>'app_id', request->>'customer_id', 'legacy canonical record reads'
  );
  if jsonb_typeof(coalesce(request->'model_ids', 'null'::jsonb)) <> 'array' then
    raise exception 'contract_validation_failed: model_ids must be an array';
  end if;
  if request ? 'limit_per_model' and request->'limit_per_model' <> 'null'::jsonb and (
    jsonb_typeof(request->'limit_per_model') <> 'number'
    or request->>'limit_per_model' !~ '^[0-9]+$'
    or (request->>'limit_per_model')::numeric > 9223372036854775807
    or (request->>'limit_per_model')::numeric < 1
  ) then
    raise exception 'contract_validation_failed: limit_per_model must be a positive integer';
  end if;
  for model_id in select jsonb_array_elements_text(request->'model_ids') loop
    model_request := jsonb_strip_nulls(jsonb_build_object(
      'app_id', request->>'app_id',
      'customer_id', request->>'customer_id',
      'model_id', model_id,
      'as_of', request->>'as_of',
      'fields', coalesce(request->'fields_by_model'->model_id, '[]'::jsonb),
      'record_ids', coalesce(request->'record_ids_by_model'->model_id, '[]'::jsonb),
      'limit', request->'limit_per_model'
    ));
    records_by_model := records_by_model || jsonb_build_object(
      model_id, kernel_read_visible_records_core(model_request, false)
    );
  end loop;
  return jsonb_build_object('ok', true, 'data', records_by_model);
exception when others then
  return jsonb_build_object('ok', false, 'error', kernel_read_error_envelope(sqlstate, sqlerrm));
end;
$kernel$
"#;

const QUERY_VISIBLE_SQL: &str = r#"
create or replace function kernel_query_visible_sql(request jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path from current
as $kernel$
begin
  return jsonb_build_object(
    'ok', false,
    'error', kernel_read_error_envelope(
      '0A000',
      'query_rejected: arbitrary SQL requires the generated same-session query protocol'
    )
  );
end;
$kernel$
"#;

const READ_GUARDED_PREPARE_VISIBLE_QUERY: &str = r#"
do $kernel$
begin
  if to_regprocedure('kernel_prepare_visible_query_unchecked(jsonb)') is null then
    alter function kernel_prepare_visible_query(jsonb)
      rename to kernel_prepare_visible_query_unchecked;
  end if;
end
$kernel$;

create or replace function kernel_read_guarded_prepare_visible_query(request jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path from current
as $kernel$
declare
  request_app_id text;
  request_customer_id text;
  active_schema jsonb;
  model_json jsonb;
begin
  if request is null or jsonb_typeof(request) <> 'object' then
    return kernel_prepare_visible_query_unchecked(request);
  end if;
  request_app_id := request->>'app_id';
  request_customer_id := request->>'customer_id';
  if request_app_id is null or btrim(request_app_id) = ''
     or request_customer_id is null or btrim(request_customer_id) = '' then
    return kernel_prepare_visible_query_unchecked(request);
  end if;

  perform set_config('kernel.app_id', request_app_id, true);
  perform set_config('kernel.customer_id', request_customer_id, true);
  select schema_revision.schema
  into active_schema
  from schema_revision
  where app_id = request_app_id
    and customer_id = request_customer_id
    and activated_at is not null;
  if active_schema is null then
    return kernel_prepare_visible_query_unchecked(request);
  end if;

  for model_json in
    select model.value
    from jsonb_array_elements(coalesce(active_schema->'models', '[]'::jsonb)) model(value)
    where coalesce(model.value->>'kind', 'entity') = 'lookup'
  loop
    perform kernel_read_assert_lookup_storage_authority(
      request_app_id, request_customer_id, model_json->>'id'
    );
  end loop;
  return kernel_prepare_visible_query_unchecked(request);
exception when others then
  return jsonb_build_object('ok', false, 'error', kernel_read_error_envelope(sqlstate, sqlerrm));
end;
$kernel$;

create or replace function kernel_prepare_visible_query(request jsonb)
returns jsonb
language sql
volatile
security invoker
set search_path from current
as $kernel$
  select kernel_read_guarded_prepare_visible_query(request)
$kernel$;
"#;

const CHANGE_SET_DIFF: &str = r#"
create or replace function kernel_change_set_diff(request jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path from current
as $kernel$
<<read_diff>>
declare
  app_id text;
  customer_id text;
  requested_change_set_id bigint;
  source_change_set_id bigint;
  source_schema_revision_id bigint;
  source_kind text;
  source_ref text;
  source_is_revert boolean;
  schema_json jsonb;
  active_schema_json jsonb;
  model_json jsonb;
  model_id text;
  model_identifier text;
  record_table text;
  version_table text;
  values_expression text;
  previous_values_expression text;
  version_many_expression text;
  previous_many_expression text;
  version_availability_expression text;
  previous_availability_expression text;
  version_filter text;
  candidate_filter text;
  record_filter text;
  record_join_filter text;
  query_sql text;
  version_row record;
  field_json jsonb;
  field_id text;
  before_values jsonb;
  after_values jsonb;
  before_custom jsonb;
  after_custom jsonb;
  before_metadata jsonb;
  after_metadata jsonb;
  before_many jsonb;
  after_many jsonb;
  before_availability text;
  after_availability text;
  before_value jsonb;
  after_value jsonb;
  before_enum jsonb;
  after_enum jsonb;
  fields_json jsonb;
  custom_json jsonb;
  custom_id text;
  relation_json jsonb;
  relation_id text;
  records_json jsonb := '[]'::jsonb;
  sorted_json jsonb;
begin
  if request is null or jsonb_typeof(request) <> 'object' then
    raise exception 'contract_validation_failed: request must be a JSON object';
  end if;
  app_id := request->>'app_id';
  customer_id := request->>'customer_id';
  requested_change_set_id := (request->>'change_set_id')::bigint;
  if app_id is null or btrim(app_id) = '' or customer_id is null or btrim(customer_id) = '' then
    raise exception 'contract_validation_failed: app_id and customer_id are required';
  end if;
  perform set_config('kernel.app_id', app_id, true);
  perform set_config('kernel.customer_id', customer_id, true);
  perform kernel_policy_reject_unsupported_capability(
    app_id, customer_id, 'change-set diff'
  );
  select schema_revision_id, change_set.source_kind, change_set.source_ref
  into source_schema_revision_id, source_kind, source_ref
  from change_set
  where id = requested_change_set_id
    and change_set.app_id = read_diff.app_id
    and change_set.customer_id = read_diff.customer_id;
  if source_schema_revision_id is null then
    raise exception 'record_target_missing: change_set `%` did not resolve', requested_change_set_id;
  end if;
  if source_kind = 'revert' then
    if source_ref is null or source_ref !~ '^-?[0-9]+$' then
      raise exception 'schema_drift: change_set.source_ref|revert change_set `%` source_ref is not a change_set id', requested_change_set_id;
    end if;
    source_change_set_id := source_ref::bigint;
  else
    source_change_set_id := requested_change_set_id;
  end if;
  source_is_revert := source_change_set_id <> requested_change_set_id;
  select schema into schema_json
  from schema_revision
  where id = source_schema_revision_id
    and schema_revision.app_id = read_diff.app_id
    and schema_revision.customer_id = read_diff.customer_id;
  if schema_json is null then
    raise exception 'schema_drift: change_set|change_set `%` pins missing schema revision `%`', requested_change_set_id, source_schema_revision_id;
  end if;
  active_schema_json := kernel_read_scope_schema(app_id, customer_id);

  for model_json in
    select model.value from jsonb_array_elements(schema_json->'models') with ordinality model(value, ordinal)
    order by model.ordinal
  loop
    model_id := model_json->>'id';
    if model_json->>'kind'='lookup' then
      perform kernel_read_assert_lookup_storage_authority(app_id, customer_id, model_id);
      record_table:='lookup_record'; version_table:='lookup_version';
      version_filter:=format(' and v.model_id=%L',model_id);
      candidate_filter:=format(' and candidate.model_id=%L',model_id);
      record_filter:=format(' and r.model_id=%L',model_id);
      record_join_filter:=' and r.model_id=v.model_id';
      values_expression:='kernel_read_lookup_values($6,v.values,''[]''::jsonb)';
      previous_values_expression:='kernel_read_lookup_values($6,p.values,''[]''::jsonb)';
      version_many_expression := 'coalesce(v.many_relations, ''{}''::jsonb)';
      previous_many_expression := 'coalesce(p.many_relations, ''{}''::jsonb)';
      version_availability_expression := 'case when v.id is null then null else coalesce(v.availability, ''active'') end';
      previous_availability_expression := 'case when p.id is null then null else coalesce(p.availability, ''active'') end';
    else
      model_identifier := kernel_read_physical_identifier(model_id);
      record_table := kernel_read_physical_identifier(model_id || '_record');
      version_table := kernel_read_physical_identifier(model_id || '_version');
      version_filter:=''; candidate_filter:=''; record_filter:=''; record_join_filter:='';
      values_expression := kernel_read_field_values_expression('v', model_json, '[]'::jsonb);
      previous_values_expression := kernel_read_field_values_expression('p', model_json, '[]'::jsonb);
      version_many_expression := '''{}''::jsonb';
      previous_many_expression := '''{}''::jsonb';
      version_availability_expression := 'null::text';
      previous_availability_expression := 'null::text';
    end if;
    perform kernel_read_assert_mainline_order(version_table, app_id, customer_id);
    query_sql := format(
      $query$
      select
        v.id version_id, v.change_set_id, v.record_id, r.external_key, v.stage,
        v.effective_start, v.effective_end, v.tombstones_record, v.untombstones_record,
        p.id is not null previous_exists,
        coalesce(p.tombstones_record, false) previous_tombstones_record,
        (%s) version_values, (%s) previous_values,
        kernel_read_custom_field_map($4, $5, v.custom_fields) version_custom,
        kernel_read_custom_field_map($4, $5, p.custom_fields) previous_custom,
        coalesce(v.metadata, '{}'::jsonb) version_metadata,
        coalesce(p.metadata, '{}'::jsonb) previous_metadata,
        (%s) version_many,
        (%s) previous_many,
        (%s) version_availability,
        (%s) previous_availability
      from %I v
      join %I r on r.id = v.record_id and r.app_id = v.app_id and r.customer_id = v.customer_id%s
      join change_set vcs on vcs.id = v.change_set_id and vcs.app_id = v.app_id and vcs.customer_id = v.customer_id
      left join lateral (
        select candidate.*
        from %I candidate
        join change_set pcs on pcs.id = candidate.change_set_id and pcs.app_id = candidate.app_id and pcs.customer_id = candidate.customer_id
        where candidate.record_id = v.record_id
          and candidate.app_id = v.app_id
          and candidate.customer_id = v.customer_id
          and candidate.id <> v.id
          %s
          and (
            (candidate.stage = 'mainline' and pcs.status = 'mainline' and pcs.applied_order is not null)
            or (v.stage = 'draft' and candidate.change_set_id = v.change_set_id and candidate.stage = 'draft' and pcs.status = 'draft' and pcs.applied_order is null)
          )
          and (
            candidate.effective_start,
            case when candidate.tombstones_record then 2 when candidate.untombstones_record then 1 else 0 end,
            case when candidate.stage = 'draft' then 1 else 0 end,
            case when candidate.stage = 'mainline' then pcs.applied_order else pcs.created_order end
          ) < (
            v.effective_start,
            case when v.tombstones_record then 2 when v.untombstones_record then 1 else 0 end,
            case when v.stage = 'draft' then 1 else 0 end,
            case when v.stage in ('mainline', 'reverted') then vcs.applied_order else vcs.created_order end
          )
        order by candidate.effective_start desc,
          candidate.tombstones_record desc,
          candidate.untombstones_record desc,
          case when candidate.stage = 'draft' then 1 else 0 end desc,
          case when candidate.stage = 'mainline' then pcs.applied_order else pcs.created_order end desc,
          candidate.id desc
        limit 1
      ) p on true
      where v.app_id = $1 and v.customer_id = $2 and v.change_set_id = $3
        %s
        %s
        and (
          (v.stage in ('mainline', 'reverted') and vcs.status = 'mainline' and vcs.applied_order is not null)
          or (v.stage = 'draft' and vcs.status = 'draft' and vcs.applied_order is null)
          or (v.stage = 'discarded' and vcs.status = 'discarded' and vcs.applied_order is null)
        )
      order by v.effective_start,
        v.tombstones_record,
        v.untombstones_record,
        case when v.stage = 'draft' then 1 else 0 end,
        case when v.stage in ('mainline', 'reverted') then vcs.applied_order else vcs.created_order end,
        v.id
      $query$,
      values_expression,previous_values_expression,
      version_many_expression,previous_many_expression,
      version_availability_expression,previous_availability_expression,
      version_table,record_table,record_join_filter,version_table,candidate_filter,version_filter,record_filter
    );
    for version_row in execute query_sql using app_id, customer_id, source_change_set_id, schema_json, model_id,model_json loop
      if source_is_revert then
        before_values := coalesce(version_row.version_values, '{}'::jsonb);
        after_values := coalesce(version_row.previous_values, '{}'::jsonb);
        before_custom := coalesce(version_row.version_custom, '{}'::jsonb);
        after_custom := coalesce(version_row.previous_custom, '{}'::jsonb);
        before_metadata := coalesce(version_row.version_metadata, '{}'::jsonb);
        after_metadata := coalesce(version_row.previous_metadata, '{}'::jsonb);
        before_many := coalesce(version_row.version_many, '{}'::jsonb);
        after_many := coalesce(version_row.previous_many, '{}'::jsonb);
        before_availability := version_row.version_availability;
        after_availability := version_row.previous_availability;
      else
        before_values := coalesce(version_row.previous_values, '{}'::jsonb);
        after_values := coalesce(version_row.version_values, '{}'::jsonb);
        before_custom := coalesce(version_row.previous_custom, '{}'::jsonb);
        after_custom := coalesce(version_row.version_custom, '{}'::jsonb);
        before_metadata := coalesce(version_row.previous_metadata, '{}'::jsonb);
        after_metadata := coalesce(version_row.version_metadata, '{}'::jsonb);
        before_many := coalesce(version_row.previous_many, '{}'::jsonb);
        after_many := coalesce(version_row.version_many, '{}'::jsonb);
        before_availability := version_row.previous_availability;
        after_availability := version_row.version_availability;
      end if;
      fields_json := '[]'::jsonb;
      for field_json in select field.value from jsonb_array_elements(model_json->'fields') with ordinality field(value, ordinal) order by field.ordinal loop
        field_id := field_json->>'id';
        if jsonb_array_length(coalesce(request->'project', '[]'::jsonb)) > 0
           and not (coalesce(request->'project', '[]'::jsonb) ? field_id) then
          continue;
        end if;
        before_value := before_values->field_id;
        after_value := after_values->field_id;
        if before_value is distinct from after_value then
          before_enum := kernel_read_enum_audit_value(
            active_schema_json, schema_json, model_id, field_id, before_value, source_schema_revision_id
          );
          after_enum := kernel_read_enum_audit_value(
            active_schema_json, schema_json, model_id, field_id, after_value, source_schema_revision_id
          );
          fields_json := fields_json || jsonb_build_array(
            jsonb_build_object('field_id', field_id, 'before', before_value, 'after', after_value)
            || case when before_enum is null then '{}'::jsonb else jsonb_build_object('before_enum', before_enum) end
            || case when after_enum is null then '{}'::jsonb else jsonb_build_object('after_enum', after_enum) end
          );
        end if;
      end loop;
      for relation_json in
        select relation.value
        from jsonb_array_elements(coalesce(model_json->'many_relations', '[]'::jsonb))
          with ordinality relation(value, ordinal)
        order by relation.ordinal
      loop
        relation_id := relation_json->>'id';
        if jsonb_array_length(coalesce(request->'project', '[]'::jsonb)) > 0
           and not (coalesce(request->'project', '[]'::jsonb) ? relation_id) then
          continue;
        end if;
        before_value := case
          when not version_row.previous_exists and not source_is_revert then null
          else jsonb_build_object(
            'type', 'relation_list',
            'value', coalesce((
              select jsonb_agg(jsonb_build_object('type', 'record_id', 'value', target.value) order by target.ordinal)
              from jsonb_array_elements_text(coalesce(before_many->relation_id, '[]'::jsonb))
                with ordinality target(value, ordinal)
            ), '[]'::jsonb)
          )
        end;
        after_value := case
          when source_is_revert and not version_row.previous_exists then null
          else jsonb_build_object(
            'type', 'relation_list',
            'value', coalesce((
              select jsonb_agg(jsonb_build_object('type', 'record_id', 'value', target.value) order by target.ordinal)
              from jsonb_array_elements_text(coalesce(after_many->relation_id, '[]'::jsonb))
                with ordinality target(value, ordinal)
            ), '[]'::jsonb)
          )
        end;
        if before_value is distinct from after_value then
          fields_json := fields_json || jsonb_build_array(jsonb_build_object(
            'field_id', relation_id, 'before', before_value, 'after', after_value
          ));
        end if;
      end loop;
      if model_json#>'{extensions,record_metadata}' is not null
         and model_json#>'{extensions,record_metadata}' <> 'null'::jsonb
         and (jsonb_array_length(coalesce(request->'project', '[]'::jsonb)) = 0
           or coalesce(request->'project', '[]'::jsonb) ? '__record_metadata')
         and before_metadata is distinct from after_metadata then
        fields_json := fields_json || jsonb_build_array(jsonb_build_object(
          'field_id', '__record_metadata',
          'before', jsonb_build_object('type', 'json', 'value', before_metadata),
          'after', jsonb_build_object('type', 'json', 'value', after_metadata)
        ));
      end if;
      if model_json->>'kind' = 'lookup'
         and (jsonb_array_length(coalesce(request->'project', '[]'::jsonb)) = 0
           or coalesce(request->'project', '[]'::jsonb) ? '__lookup_lifecycle')
         and before_availability is distinct from after_availability then
        fields_json := fields_json || jsonb_build_array(jsonb_build_object(
          'field_id', '__lookup_lifecycle',
          'before', case when before_availability is null then null else jsonb_build_object(
            'type', 'schema_lifecycle', 'value', before_availability
          ) end,
          'after', case when after_availability is null then null else jsonb_build_object(
            'type', 'schema_lifecycle', 'value', after_availability
          ) end
        ));
      end if;
      custom_json := '[]'::jsonb;
      for custom_id in
        select key from (
          select jsonb_object_keys(before_custom) key union select jsonb_object_keys(after_custom) key
        ) ids order by key
      loop
        if jsonb_array_length(coalesce(request->'project', '[]'::jsonb)) > 0
           and not (coalesce(request->'project', '[]'::jsonb) ? custom_id) then
          continue;
        end if;
        before_value := before_custom->custom_id;
        after_value := after_custom->custom_id;
        if before_value is distinct from after_value then
          before_enum := kernel_read_enum_audit_value(
            active_schema_json, schema_json, model_id, custom_id, before_value, source_schema_revision_id
          );
          after_enum := kernel_read_enum_audit_value(
            active_schema_json, schema_json, model_id, custom_id, after_value, source_schema_revision_id
          );
          custom_json := custom_json || jsonb_build_array(
            jsonb_build_object('field_id', custom_id, 'before', before_value, 'after', after_value)
            || case when before_enum is null then '{}'::jsonb else jsonb_build_object('before_enum', before_enum) end
            || case when after_enum is null then '{}'::jsonb else jsonb_build_object('after_enum', after_enum) end
          );
        end if;
      end loop;
      records_json := records_json || jsonb_build_array(jsonb_build_object(
        'model_id', model_id,
        'record_id', version_row.record_id,
        'external_key', version_row.external_key,
        'version_id', version_row.version_id,
        'change_set_id', version_row.change_set_id,
        'stage', version_row.stage,
        'effective_start', to_char(version_row.effective_start, 'YYYY-MM-DD'),
        'effective_end', case when version_row.effective_end is null then null else to_char(version_row.effective_end, 'YYYY-MM-DD') end,
        'before_tombstones_record', case when source_is_revert then version_row.tombstones_record else version_row.previous_tombstones_record end,
        'after_tombstones_record', case when source_is_revert then version_row.previous_tombstones_record or (not version_row.previous_exists and not version_row.tombstones_record) else version_row.tombstones_record end,
        'before_untombstones_record', case when source_is_revert then version_row.untombstones_record else false end,
        'after_untombstones_record', case when source_is_revert then false else version_row.untombstones_record end,
        'fields', fields_json,
        'custom_fields', custom_json
      ));
    end loop;
  end loop;
  select coalesce(jsonb_agg(record.value order by
    record.value->>'model_id',
    record.value->>'effective_start',
    record.value->>'record_id',
    (record.value->>'before_tombstones_record')::boolean or (record.value->>'after_tombstones_record')::boolean,
    (record.value->>'before_untombstones_record')::boolean or (record.value->>'after_untombstones_record')::boolean,
    record.value->>'version_id'
  ), '[]'::jsonb) into sorted_json from jsonb_array_elements(records_json) record(value);
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'change_set_id', requested_change_set_id,
    'source_change_set_id', source_change_set_id,
    'records', sorted_json
  ));
exception when others then
  return jsonb_build_object('ok', false, 'error', kernel_read_error_envelope(sqlstate, sqlerrm));
end;
$kernel$
"#;

const FIELD_HISTORY: &str = r#"
create or replace function kernel_field_history(request jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path from current
as $kernel$
declare
  app_id text;
  customer_id text;
  model_id text;
  record_id uuid;
  requested_field_id text;
  requested_as_of date;
  requested_limit bigint;
  requested_stages text[];
  schema_json jsonb;
  model_json jsonb;
  model_identifier text;
  version_table text;
  values_expression text;
  many_expression text;
  availability_expression text;
  version_filter text;
  query_sql text;
  history_row record;
  field_json jsonb;
  field_id text;
  requested_kind text;
  enum_value jsonb;
  policy_snapshot jsonb;
  history_required_fields jsonb;
  history_record_values jsonb;
  attribution_json jsonb;
  policy_declared boolean := false;
  history_candidates jsonb := '[]'::jsonb;
  row_fields jsonb;
  entry_value jsonb;
  entries_json jsonb := '[]'::jsonb;
begin
  if request is null or jsonb_typeof(request) <> 'object' then
    raise exception 'contract_validation_failed: request must be a JSON object';
  end if;
  app_id := request->>'app_id';
  customer_id := request->>'customer_id';
  model_id := request->>'model_id';
  record_id := (request->>'record_id')::uuid;
  requested_field_id := request->>'field_id';
  requested_limit := least(greatest(coalesce((request->>'limit')::bigint, 100), 1), 100);
  if request ? 'as_of' and request->'as_of' <> 'null'::jsonb then requested_as_of := (request->>'as_of')::date; end if;
  select coalesce(array_agg(stage.value order by stage.ordinal), array[]::text[])
  into requested_stages
  from jsonb_array_elements_text(coalesce(request->'stages', '[]'::jsonb)) with ordinality stage(value, ordinal);
  if cardinality(requested_stages) = 0 then requested_stages := array['mainline', 'reverted']; end if;
  schema_json := kernel_read_scope_schema(app_id, customer_id);
  select model.value into model_json
  from jsonb_array_elements(schema_json->'models') model(value)
  where model.value->>'id' = model_id;
  if model_json is null then
    raise exception 'record_target_missing: model `%` is not declared in active schema', model_id;
  end if;
  if model_json->>'kind' = 'lookup' then
    perform kernel_read_assert_lookup_storage_authority(app_id, customer_id, model_id);
  end if;
  if requested_field_id is not null then
    if exists (
      select 1 from jsonb_array_elements(model_json->'fields') field(value)
      where field.value->>'id' = requested_field_id
    ) then
      requested_kind := 'declared';
    elsif exists (
      select 1 from jsonb_array_elements(coalesce(model_json->'many_relations', '[]'::jsonb)) relation(value)
      where relation.value->>'id' = requested_field_id
    ) then
      requested_kind := 'many_relation';
    elsif exists (
      select 1 from jsonb_array_elements(coalesce(schema_json->'custom_fields', '[]'::jsonb)) definition(value)
      where definition.value->>'model_id' = model_id
        and definition.value->>'field_id' = requested_field_id
    ) then
      requested_kind := 'custom';
    elsif requested_field_id = '__record_metadata'
      and model_json#>'{extensions,record_metadata}' is not null
      and model_json#>'{extensions,record_metadata}' <> 'null'::jsonb then
      requested_kind := 'metadata';
    elsif requested_field_id = '__lookup_lifecycle' and model_json->>'kind' = 'lookup' then
      requested_kind := 'lifecycle';
    else
      raise exception 'record_target_missing: field `%` is not declared on model `%`', requested_field_id, model_id;
    end if;
  end if;
  if requested_kind in ('declared', 'custom', 'many_relation') then
    history_candidates := jsonb_build_array(jsonb_build_object('id', requested_field_id, 'kind', requested_kind));
  elsif requested_field_id is null then
    -- Unqualified history covers every declared field, many relation and
    -- active custom field; record metadata and lookup lifecycle stay explicit.
    select coalesce(jsonb_agg(candidate.value order by candidate.position), '[]'::jsonb)
    into history_candidates
    from (
      select jsonb_build_object('id', field.value->>'id', 'kind', 'declared') value, field.ordinal position
      from jsonb_array_elements(coalesce(model_json->'fields', '[]'::jsonb)) with ordinality field(value, ordinal)
      union all
      select jsonb_build_object('id', relation.value->>'id', 'kind', 'many_relation'), 1000000 + relation.ordinal
      from jsonb_array_elements(coalesce(model_json->'many_relations', '[]'::jsonb)) with ordinality relation(value, ordinal)
      union all
      select jsonb_build_object('id', definition.value->>'field_id', 'kind', 'custom'), 2000000 + definition.ordinal
      from jsonb_array_elements(coalesce(schema_json->'custom_fields', '[]'::jsonb)) with ordinality definition(value, ordinal)
      where definition.value->>'model_id' = model_id
        and coalesce(definition.value->>'lifecycle', 'active') = 'active'
        and coalesce(definition.value->'archived_at', 'null'::jsonb) = 'null'::jsonb
    ) candidate;
  end if;
  policy_snapshot := kernel_policy_active_snapshot(app_id, customer_id);
  policy_declared := coalesce((policy_snapshot->>'declared')::boolean, false);
  if policy_declared then
    perform kernel_policy_request_actor(app_id, customer_id);
    if requested_kind = 'lifecycle' or exists (
      select 1 from unnest(requested_stages) requested_stage
      where requested_stage not in ('mainline', 'reverted')
    ) then
      raise exception 'unsupported_capability: policy-enabled history supports canonical mainline and reverted images only';
    end if;
    if requested_kind = 'metadata' then
      history_required_fields := jsonb_build_array('$metadata');
    elsif requested_field_id is not null then
      history_required_fields := jsonb_build_array(requested_field_id);
    else
      -- Unqualified history needs a history grant on the model; fields the
      -- actor may not read are left out rather than failing the request.
      history_required_fields := '[]'::jsonb;
    end if;
    if not kernel_policy_required_fields_allowed(
      policy_snapshot->'policy', model_id, 'history', history_required_fields
    ) then
      raise exception 'authorization_denied: no applicable authorization grant permits the requested history fields';
    end if;
    if requested_field_id is null then
      select coalesce(jsonb_agg(candidate.value order by candidate.ordinal), '[]'::jsonb)
      into history_candidates
      from jsonb_array_elements(history_candidates) with ordinality candidate(value, ordinal)
      where kernel_policy_required_fields_allowed(
        policy_snapshot->'policy', model_id, 'history', jsonb_build_array(candidate.value->>'id')
      );
    end if;
  end if;
  if model_json->>'kind'='lookup' then
    version_table:='lookup_version';
    version_filter:=format(' and v.model_id=%L',model_id);
    values_expression:='kernel_read_lookup_values($7,v.values,''[]''::jsonb)';
    many_expression := 'coalesce(v.many_relations, ''{}''::jsonb)';
    availability_expression := 'coalesce(v.availability, ''active'')';
  else
    model_identifier := kernel_read_physical_identifier(model_id);
    version_table := kernel_read_physical_identifier(model_id || '_version');
    version_filter:='';
    values_expression := kernel_read_field_values_expression('v', model_json, '[]'::jsonb);
    many_expression := '''{}''::jsonb';
    availability_expression := 'null::text';
  end if;
  perform kernel_read_assert_mainline_order(version_table, app_id, customer_id);
  query_sql := format(
    $query$
    with eligible_snapshots as (
      select v.change_set_id, v.effective_start, v.stage, cs.schema_revision_id,
        bool_or(v.tombstones_record) tombstones_record,
        bool_or(v.untombstones_record) untombstones_record,
        case when v.stage in ('mainline', 'reverted') then cs.applied_order else cs.created_order end causal_order
      from %I v
      join change_set cs on cs.id = v.change_set_id and cs.app_id = v.app_id and cs.customer_id = v.customer_id
      where v.record_id = $1 and v.app_id = $2 and v.customer_id = $3
        %s
        and v.stage = any($4)
        and ($5::date is null or v.effective_start <= $5)
        and (
          (v.stage in ('mainline', 'reverted') and cs.status = 'mainline' and cs.applied_order is not null)
          or (v.stage = 'draft' and cs.status = 'draft' and cs.applied_order is null)
          or (v.stage = 'discarded' and cs.status = 'discarded' and cs.applied_order is null)
        )
      group by v.change_set_id, v.effective_start, v.stage, cs.schema_revision_id,
        cs.applied_order, cs.created_order
    ), selected_snapshots as (
      select * from eligible_snapshots
      order by effective_start desc, tombstones_record desc, untombstones_record desc, causal_order desc
      limit $6
    )
    select v.id version_id, v.change_set_id, v.stage, v.effective_start, v.effective_end,
      selected.schema_revision_id event_schema_revision_id, event_revision.schema event_schema,
      (select revert_cs.id from change_set revert_cs
       where revert_cs.app_id = v.app_id and revert_cs.customer_id = v.customer_id
         and revert_cs.status = 'mainline' and revert_cs.applied_order is not null
         and revert_cs.source_kind = 'revert' and revert_cs.source_ref = v.change_set_id::text
       order by revert_cs.applied_order desc, revert_cs.id desc limit 1) reverted_by,
      (%s) values,
      kernel_read_custom_field_map($8, $7->>'id', v.custom_fields) custom_values,
      coalesce(v.metadata, '{}'::jsonb) metadata,
      (%s) many_relations,
      (%s) availability,
      v.tombstones_record, v.untombstones_record,
      event_cs.actor_id, event_cs.source_kind, event_cs.source_ref, event_cs.notes,
      event_cs.applied_at change_set_applied_at
    from selected_snapshots selected
    join %I v on v.change_set_id = selected.change_set_id
      and v.effective_start = selected.effective_start
      and v.stage = selected.stage
      and v.record_id = $1 and v.app_id = $2 and v.customer_id = $3
      %s
    join change_set event_cs
      on event_cs.id = v.change_set_id
     and event_cs.app_id = v.app_id
     and event_cs.customer_id = v.customer_id
    left join schema_revision event_revision
      on event_revision.id = selected.schema_revision_id
     and event_revision.app_id = v.app_id
     and event_revision.customer_id = v.customer_id
    order by selected.effective_start, selected.tombstones_record, selected.untombstones_record,
      selected.causal_order, v.tombstones_record, v.untombstones_record, v.id
    $query$,
    version_table,version_filter,values_expression,many_expression,availability_expression,
    version_table,version_filter
  );
  for history_row in execute query_sql using record_id, app_id, customer_id, requested_stages, requested_as_of, requested_limit,model_json,schema_json loop
    if history_row.event_schema is null then
      raise exception 'schema_drift: change_set|change_set `%` pins missing schema revision `%`', history_row.change_set_id, history_row.event_schema_revision_id;
    end if;
    row_fields := history_candidates;
    if policy_declared then
      history_record_values := coalesce(history_row.values, '{}'::jsonb)
        || coalesce(history_row.custom_values, '{}'::jsonb)
        || coalesce(history_row.many_relations, '{}'::jsonb);
      if not kernel_policy_record_allowed(
        policy_snapshot->'policy', model_id, 'history', history_required_fields, history_record_values
      ) then
        raise exception 'authorization_denied: a historical snapshot is not authorized by the current policy';
      end if;
      if requested_field_id is null then
        -- A field the actor may not read in this otherwise authorized
        -- snapshot is emitted as withheld, never omitted, so every snapshot
        -- boundary stays visible even when no field is readable.
        select coalesce(jsonb_agg(
          candidate.value || jsonb_build_object('withheld', not kernel_policy_record_allowed(
            policy_snapshot->'policy', model_id, 'history',
            jsonb_build_array(candidate.value->>'id'), history_record_values
          ))
          order by candidate.ordinal
        ), '[]'::jsonb)
        into row_fields
        from jsonb_array_elements(history_candidates) with ordinality candidate(value, ordinal);
      end if;
    end if;
    -- Attribution and lifecycle come from the owning change set and the
    -- physical version row; they are emitted on every entry kind.
    attribution_json := jsonb_build_object(
      'withheld', false,
      'tombstones_record', history_row.tombstones_record,
      'untombstones_record', history_row.untombstones_record,
      'source_kind', history_row.source_kind,
      'source_ref', history_row.source_ref,
      -- Under a declared policy the free-text notes and actor identity are
      -- withheld (null); source kind, source ref and time stay visible.
      'actor_id', case when policy_declared then null else history_row.actor_id end,
      'notes', case when policy_declared then null else history_row.notes end,
      'applied_at', case when history_row.change_set_applied_at is null then null else regexp_replace(to_char(history_row.change_set_applied_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '\.000000Z$', 'Z') end
    );
    if requested_kind = 'metadata' then
      entries_json := entries_json || jsonb_build_array(jsonb_build_object(
        'version_id', history_row.version_id, 'change_set_id', history_row.change_set_id,
        'stage', history_row.stage, 'effective_start', to_char(history_row.effective_start, 'YYYY-MM-DD'),
        'effective_end', case when history_row.effective_end is null then null else to_char(history_row.effective_end, 'YYYY-MM-DD') end,
        'field_id', requested_field_id,
        'value', jsonb_build_object('type', 'json', 'value', history_row.metadata),
        'reverted_by', history_row.reverted_by
      ) || attribution_json);
      continue;
    elsif requested_kind = 'lifecycle' then
      entries_json := entries_json || jsonb_build_array(jsonb_build_object(
        'version_id', history_row.version_id, 'change_set_id', history_row.change_set_id,
        'stage', history_row.stage, 'effective_start', to_char(history_row.effective_start, 'YYYY-MM-DD'),
        'effective_end', case when history_row.effective_end is null then null else to_char(history_row.effective_end, 'YYYY-MM-DD') end,
        'field_id', requested_field_id,
        'value', jsonb_build_object('type', 'schema_lifecycle', 'value', history_row.availability),
        'reverted_by', history_row.reverted_by
      ) || attribution_json);
      continue;
    end if;
    for field_json in
      select candidate.value from jsonb_array_elements(row_fields) with ordinality candidate(value, ordinal)
      order by candidate.ordinal
    loop
      field_id := field_json->>'id';
      enum_value := null;
      if coalesce((field_json->>'withheld')::boolean, false) then
        entries_json := entries_json || jsonb_build_array(
          jsonb_build_object(
            'version_id', history_row.version_id,
            'change_set_id', history_row.change_set_id,
            'stage', history_row.stage,
            'effective_start', to_char(history_row.effective_start, 'YYYY-MM-DD'),
            'effective_end', case when history_row.effective_end is null then null else to_char(history_row.effective_end, 'YYYY-MM-DD') end,
            'field_id', field_id,
            'value', null,
            'reverted_by', history_row.reverted_by
          ) || attribution_json || jsonb_build_object('withheld', true)
        );
        continue;
      end if;
      if field_json->>'kind' = 'many_relation' then
        entry_value := jsonb_build_object('type', 'relation_list', 'value', coalesce((
          select jsonb_agg(jsonb_build_object('type', 'record_id', 'value', target.value) order by target.ordinal)
          from jsonb_array_elements_text(coalesce(history_row.many_relations->field_id, '[]'::jsonb))
            with ordinality target(value, ordinal)
        ), '[]'::jsonb));
      else
        if field_json->>'kind' = 'custom' then
          entry_value := history_row.custom_values->field_id;
        else
          entry_value := history_row.values->field_id;
        end if;
        enum_value := kernel_read_enum_audit_value(
          schema_json, history_row.event_schema, model_id, field_id,
          entry_value, history_row.event_schema_revision_id
        );
      end if;
      entries_json := entries_json || jsonb_build_array(
        jsonb_build_object(
          'version_id', history_row.version_id,
          'change_set_id', history_row.change_set_id,
          'stage', history_row.stage,
          'effective_start', to_char(history_row.effective_start, 'YYYY-MM-DD'),
          'effective_end', case when history_row.effective_end is null then null else to_char(history_row.effective_end, 'YYYY-MM-DD') end,
          'field_id', field_id,
          'value', entry_value,
          'reverted_by', history_row.reverted_by
        ) || attribution_json || case when enum_value is null then '{}'::jsonb else jsonb_build_object('enum_value', enum_value) end
      );
    end loop;
  end loop;
  return jsonb_build_object('ok', true, 'data', entries_json);
exception when others then
  return jsonb_build_object('ok', false, 'error', kernel_read_error_envelope(sqlstate, sqlerrm));
end;
$kernel$
"#;

const RECENT_ACTIVITY: &str = r#"
create or replace function kernel_recent_activity(request jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path from current
as $kernel$
<<read_activity>>
declare
  app_id text;
  customer_id text;
  requested_limit bigint;
  statuses text[];
  source_kinds text[];
  schema_json jsonb;
  activity_row record;
  model_json jsonb;
  model_identifier text;
  version_table text;
  model_filter text;
  version_change_set_id bigint;
  model_count bigint;
  touched_count bigint;
  query_sql text;
  entries_json jsonb := '[]'::jsonb;
begin
  if request is null or jsonb_typeof(request) <> 'object' then
    raise exception 'contract_validation_failed: request must be a JSON object';
  end if;
  app_id := request->>'app_id';
  customer_id := request->>'customer_id';
  requested_limit := least(greatest(coalesce((request->>'limit')::bigint, 50), 1), 100);
  select coalesce(array_agg(status.value order by status.ordinal), array[]::text[])
  into statuses
  from jsonb_array_elements_text(coalesce(request->'statuses', '[]'::jsonb)) with ordinality status(value, ordinal);
  if cardinality(statuses) = 0 then statuses := array['mainline', 'draft']; end if;
  select coalesce(array_agg(source.value order by source.ordinal), array[]::text[])
  into source_kinds
  from jsonb_array_elements_text(coalesce(request->'source_kinds', '[]'::jsonb)) with ordinality source(value, ordinal);
  schema_json := kernel_read_scope_schema(app_id, customer_id);
  perform kernel_policy_reject_unsupported_capability(
    app_id, customer_id, 'recent activity'
  );
  for activity_row in
    select id, status, actor_id, source_kind, source_ref, change_type_id, notes, created_at, applied_at
    from change_set
    where change_set.app_id = read_activity.app_id
      and change_set.customer_id = read_activity.customer_id
      and status = any(statuses)
      and (cardinality(source_kinds) = 0 or source_kind = any(source_kinds))
    order by case when status = 'mainline' then applied_order else created_order end desc, id desc
    limit requested_limit
  loop
    if activity_row.source_kind = 'revert' then
      if activity_row.source_ref is null or activity_row.source_ref !~ '^-?[0-9]+$' then
        raise exception 'schema_drift: change_set.source_ref|revert change_set `%` source_ref is not a change_set id', activity_row.id;
      end if;
      version_change_set_id := activity_row.source_ref::bigint;
    else
      version_change_set_id := activity_row.id;
    end if;
    touched_count := 0;
    for model_json in select model.value from jsonb_array_elements(schema_json->'models') model(value) loop
      if model_json->>'kind'='lookup' then
        perform kernel_read_assert_lookup_storage_authority(
          app_id, customer_id, model_json->>'id'
        );
        version_table:='lookup_version'; model_filter:=format(' and model_id=%L',model_json->>'id');
      else
        model_identifier := kernel_read_physical_identifier(model_json->>'id');
        version_table := kernel_read_physical_identifier((model_json->>'id') || '_version');
        model_filter:='';
      end if;
      query_sql := format(
        'select count(distinct record_id) from %I where app_id = $1 and customer_id = $2 and change_set_id = $3%s',
        version_table,
        model_filter || case when activity_row.source_kind = 'revert' then ' and stage = ''reverted''' else '' end
      );
      execute query_sql using app_id, customer_id, version_change_set_id into model_count;
      touched_count := touched_count + model_count;
    end loop;
    entries_json := entries_json || jsonb_build_array(jsonb_build_object(
      'change_set_id', activity_row.id,
      'status', activity_row.status,
      'actor_id', activity_row.actor_id,
      'source_kind', activity_row.source_kind,
      'source_ref', activity_row.source_ref,
      'change_type_id', activity_row.change_type_id,
      'notes', activity_row.notes,
      'created_at', regexp_replace(to_char(activity_row.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '\.000000Z$', 'Z'),
      'applied_at', case when activity_row.applied_at is null then null else regexp_replace(to_char(activity_row.applied_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '\.000000Z$', 'Z') end,
      'touched_record_count', touched_count
    ));
  end loop;
  return jsonb_build_object('ok', true, 'data', entries_json);
exception when others then
  return jsonb_build_object('ok', false, 'error', kernel_read_error_envelope(sqlstate, sqlerrm));
end;
$kernel$
"#;
