use super::RuntimeSqlFunction;

pub(super) fn functions() -> Vec<RuntimeSqlFunction> {
    vec![
        RuntimeSqlFunction {
            signature: "kernel_lookup_has_typed_history(text,text,text)",
            sql: KERNEL_LOOKUP_HAS_TYPED_HISTORY.trim().to_string(),
        },
        RuntimeSqlFunction {
            signature: "kernel_canonical_json(jsonb)",
            sql: KERNEL_CANONICAL_JSON.trim().to_string(),
        },
        RuntimeSqlFunction {
            signature: "kernel_physical_identifier(text)",
            sql: KERNEL_PHYSICAL_IDENTIFIER.trim().to_string(),
        },
        RuntimeSqlFunction {
            signature: "kernel_shared_lookup_values_bootstrap(jsonb,jsonb,jsonb)",
            sql: KERNEL_SHARED_LOOKUP_VALUES_BOOTSTRAP.trim().to_string(),
        },
        RuntimeSqlFunction {
            signature: "kernel_shared_draft_field_values_bootstrap(jsonb,jsonb)",
            sql: KERNEL_SHARED_DRAFT_FIELD_VALUES_BOOTSTRAP
                .trim()
                .to_string(),
        },
        RuntimeSqlFunction {
            signature: "kernel_cleanup_generated_visible_query()",
            sql: KERNEL_CLEANUP_GENERATED_VISIBLE_QUERY.trim().to_string(),
        },
        RuntimeSqlFunction {
            signature: "kernel_cleanup_visible_query()",
            sql: KERNEL_CLEANUP_VISIBLE_QUERY.trim().to_string(),
        },
        RuntimeSqlFunction {
            signature: "kernel_prepare_visible_query(jsonb)",
            sql: KERNEL_PREPARE_VISIBLE_QUERY.trim().to_string(),
        },
        RuntimeSqlFunction {
            signature: "kernel_validate_visible_query(jsonb)",
            sql: KERNEL_VALIDATE_VISIBLE_QUERY_REQUEST.trim().to_string(),
        },
        RuntimeSqlFunction {
            signature: "kernel_validate_visible_query(text)",
            sql: KERNEL_VALIDATE_VISIBLE_QUERY.trim().to_string(),
        },
        RuntimeSqlFunction {
            signature: "kernel_policy_reject_unsupported_capability(text,text,text)",
            sql: KERNEL_POLICY_REJECT_UNSUPPORTED_CAPABILITY
                .trim()
                .to_string(),
        },
    ]
}

const KERNEL_CANONICAL_JSON: &str = r#"
create or replace function kernel_canonical_json(value jsonb)
returns text
language sql
immutable
strict
parallel safe
security invoker
set search_path from current
as $kernel$
  select case jsonb_typeof(value)
    when 'object' then
      '{' || coalesce((
        select string_agg(
          to_json(entry.key)::text || ':' || kernel_canonical_json(entry.value),
          ',' order by entry.key
        )
        from jsonb_each(value) as entry(key, value)
      ), '') || '}'
    when 'array' then
      '[' || coalesce((
        select string_agg(
          kernel_canonical_json(entry.value),
          ',' order by entry.ordinality
        )
        from jsonb_array_elements(value) with ordinality as entry(value, ordinality)
      ), '') || ']'
    else value::text
  end
$kernel$;
"#;

// Compatibility endpoints that return raw records cannot preserve the
// compiled authorization contract. Policy-absent issued releases retain them.
const KERNEL_POLICY_REJECT_UNSUPPORTED_CAPABILITY: &str = r#"
create or replace function kernel_policy_reject_unsupported_capability(
  app_id text,
  customer_id text,
  capability text
)
returns void
language plpgsql
volatile
security invoker
set search_path from current
as $kernel$
declare
  snapshot jsonb;
begin
  if app_id is null or btrim(app_id) = ''
     or customer_id is null or btrim(customer_id) = '' then
    return;
  end if;
  perform set_config('kernel.app_id', app_id, true);
  perform set_config('kernel.customer_id', customer_id, true);
  if not exists (
    select 1
    from schema_revision revision
    where revision.app_id = $1
      and revision.customer_id = $2
      and revision.activated_at is not null
  ) then
    return;
  end if;
  snapshot := kernel_policy_active_snapshot(app_id, customer_id);
  if coalesce((snapshot->>'declared')::boolean, false) then
    perform kernel_policy_request_actor(app_id, customer_id);
    raise exception 'unsupported_capability: %', capability;
  end if;
end;
$kernel$
"#;

const KERNEL_PHYSICAL_IDENTIFIER: &str = r#"
create or replace function kernel_fnv1a64_hex(value text)
returns text
language plpgsql
immutable
strict
parallel safe
security invoker
set search_path from current
as $kernel$
declare
  bytes bytea := convert_to(value, 'UTF8');
  hash bigint := -3750763034362895579;
  unsigned_hash numeric;
  position integer;
begin
  if octet_length(bytes) > 0 then
    for position in 0..octet_length(bytes) - 1 loop
      hash := hash # get_byte(bytes, position)::bigint;
      unsigned_hash := case
        when hash < 0 then hash::numeric + 18446744073709551616
        else hash::numeric
      end;
      unsigned_hash := mod(unsigned_hash * 1099511628211, 18446744073709551616);
      hash := case
        when unsigned_hash >= 9223372036854775808
          then (unsigned_hash - 18446744073709551616)::bigint
        else unsigned_hash::bigint
      end;
    end loop;
  end if;
  return lpad(to_hex(hash), 16, '0');
end
$kernel$;

create or replace function kernel_physical_identifier(value text)
returns text
language plpgsql
immutable
strict
parallel safe
security invoker
set search_path from current
as $kernel$
declare
  normalized text;
begin
  normalized := trim(both '_' from regexp_replace(
    regexp_replace(lower(btrim(value)), '[_\-[:space:]]+', '_', 'g'),
    '[^a-z0-9_]', '', 'g'
  ));
  if octet_length(normalized) <= 63 then
    return normalized;
  end if;
  return left(normalized, 46) || '_' || kernel_fnv1a64_hex(normalized);
end
$kernel$;
"#;

// Draft and lookup functions are installed before the richer read helpers. This
// declaration provides their parse-time dependency; reads.rs replaces it in the
// same transactional bundle before the API becomes visible.
const KERNEL_SHARED_LOOKUP_VALUES_BOOTSTRAP: &str = r#"
create or replace function kernel_read_lookup_values(
  model jsonb,
  stored_values jsonb,
  projection jsonb
)
returns jsonb
language sql
stable
security invoker
set search_path from current
as $kernel$
  select coalesce(stored_values, '{}'::jsonb)
$kernel$;
"#;

const KERNEL_SHARED_DRAFT_FIELD_VALUES_BOOTSTRAP: &str = r#"
create or replace function kernel_draft_field_values(model jsonb, row_data jsonb)
returns jsonb
language sql
immutable
parallel safe
security invoker
set search_path from current
as $kernel$
  select '{}'::jsonb
$kernel$;
"#;

const KERNEL_PREPARE_VISIBLE_QUERY: &str = r#"
do $kernel$
declare
  schema_name text := current_schema();
  query_role text := kernel_installer_capability_role('query');
begin
  if to_regrole(query_role) is not null then
    if exists (
      select 1
      from pg_roles
      where rolname = query_role
        and (rolcanlogin or rolbypassrls)
    ) then
      raise exception 'generated query role must be NOLOGIN NOBYPASSRLS';
    end if;
    execute format('grant usage on schema %I to %I', schema_name, query_role);
    execute format(
      'revoke all privileges on all tables in schema %I from %I',
      schema_name, query_role
    );
    execute format(
      'revoke all privileges on all sequences in schema %I from %I',
      schema_name, query_role
    );
  end if;
end
$kernel$;

create or replace function kernel_prepare_visible_query(request jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path from current
as $kernel$
declare
  request_app_id text;
  request_customer_id text;
  request_as_of date;
  policy_snapshot jsonb;
  active_schema jsonb;
  source_schema text := current_schema();
  query_role text := kernel_installer_capability_role('query');
  model_json jsonb;
  model_id text;
  model_kind text;
  field_json jsonb;
  field_id text;
  field_type text;
  field_identifier text;
  projection_sql text;
  record_table text;
  version_table text;
begin
  if request is null or jsonb_typeof(request) <> 'object' then
    return jsonb_build_object(
      'ok', false,
      'error', jsonb_build_object(
        'code', 'contract_validation_failed',
        'message', 'request must be a JSON object'
      )
    );
  end if;
  request_app_id := request->>'app_id';
  request_customer_id := request->>'customer_id';
  if request_app_id is null or btrim(request_app_id) = ''
     or request_customer_id is null or btrim(request_customer_id) = '' then
    return jsonb_build_object(
      'ok', false,
      'error', jsonb_build_object(
        'code', 'contract_validation_failed',
        'message', 'app_id and customer_id are required'
      )
    );
  end if;
  if request ? 'as_of' and request->>'as_of' is not null then
    request_as_of := (request->>'as_of')::date;
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
    return jsonb_build_object(
      'ok', false,
      'error', jsonb_build_object(
        'code', 'active_schema_missing',
        'message', 'No active schema revision exists for this scope'
      )
    );
  end if;

  policy_snapshot := kernel_policy_active_snapshot(request_app_id, request_customer_id);
  if coalesce((policy_snapshot->>'declared')::boolean, false) then
    perform kernel_policy_request_actor(request_app_id, request_customer_id);
    return jsonb_build_object(
      'ok', false,
      'error', jsonb_build_object(
        'code', 'unsupported_capability',
        'message', 'The legacy prepared visible-query protocol is unavailable for policy-enabled revisions'
      )
    );
  end if;

  begin
    execute 'deallocate kernel_visible_query_validation';
  exception when invalid_sql_statement_name then
    null;
  end;

  execute format(
    'create temp view change_set as select * from %I.change_set where app_id = %L and customer_id = %L',
    source_schema,
    request_app_id,
    request_customer_id
  );
  if to_regrole(query_role) is not null then
    execute format('grant select on pg_temp.change_set to %I', query_role);
  end if;

  for model_json in
    select model.value
    from jsonb_array_elements(active_schema->'models') with ordinality model(value, ordinal)
    order by model.ordinal
  loop
    model_id := model_json->>'id';
    model_kind := coalesce(model_json->>'kind', 'entity');
    record_table := kernel_physical_identifier(model_id || '_record');
    version_table := kernel_physical_identifier(model_id || '_version');
    if model_kind = 'lookup' then
      projection_sql := 'v.*';
      for field_json in
        select field.value
        from jsonb_array_elements(coalesce(model_json->'fields', '[]'::jsonb))
          with ordinality as field(value, ordinal)
        where coalesce(field.value->>'lifecycle', 'active') = 'active'
        order by field.ordinal
      loop
        field_id := field_json->>'id';
        field_type := field_json->>'type';
        field_identifier := kernel_physical_identifier(field_id);
        case
          when field_type in ('text', 'enum', 'iso_country', 'iso_currency') then
            projection_sql := projection_sql || format(
              ', v.values->%L->>''value'' as %I', field_id, field_identifier
            );
          when field_type = 'number' then
            projection_sql := projection_sql || format(
              ', (v.values->%L->>''value'')::numeric as %I', field_id, field_identifier
            );
          when field_type = 'bool' then
            projection_sql := projection_sql || format(
              ', (v.values->%L->>''value'')::boolean as %I', field_id, field_identifier
            );
          when field_type = 'date' then
            projection_sql := projection_sql || format(
              ', (v.values->%L->>''value'')::date as %I', field_id, field_identifier
            );
          when field_type = 'datetime' then
            projection_sql := projection_sql || format(
              ', (v.values->%L->>''value'')::timestamptz as %I', field_id, field_identifier
            );
          when field_type = 'relation' then
            projection_sql := projection_sql || format(
              ', (v.values #>> array[%L,''value'',''value''])::uuid as %I',
              field_id, field_identifier
            );
          when field_type in ('text_list', 'known_aliases') then
            projection_sql := projection_sql || format(
              ', array(select jsonb_array_elements_text(coalesce(v.values->%L->''value'',''[]''::jsonb))) as %I',
              field_id, field_identifier
            );
          when field_type = 'json' then
            projection_sql := projection_sql || format(
              ', v.values->%L->''value'' as %I', field_id, field_identifier
            );
          when field_type = 'money_rate' then
            projection_sql := projection_sql || format(
              ', (v.values #>> array[%L,''value'',''amount''])::numeric as %I',
              field_id, kernel_physical_identifier(field_id || '_amount')
            );
            projection_sql := projection_sql || format(
              ', v.values #>> array[%L,''value'',''currency''] as %I',
              field_id, kernel_physical_identifier(field_id || '_currency')
            );
            projection_sql := projection_sql || format(
              ', v.values #>> array[%L,''value'',''period''] as %I',
              field_id, kernel_physical_identifier(field_id || '_period')
            );
          else
            return jsonb_build_object(
              'ok', false,
              'error', jsonb_build_object(
                'code', 'schema_drift',
                'message', format('lookup field `%s.%s` has unsupported type `%s`', model_id, field_id, field_type)
              )
            );
        end case;
      end loop;

      execute format(
        $query$
        create temp view %I as
        with visible_version as (
          select distinct on (v.record_id) v.*
          from %I.lookup_version v
          join %I.change_set changes
            on changes.id = v.change_set_id
           and changes.app_id = v.app_id
           and changes.customer_id = v.customer_id
          where v.app_id = %L
            and v.customer_id = %L
            and v.model_id = %L
            and v.stage = 'mainline'
            and changes.status = 'mainline'
            and changes.applied_order is not null
            and v.effective_start <= coalesce(%L::date, current_date)
            and (v.effective_end is null or v.effective_end >= coalesce(%L::date, current_date))
          order by v.record_id, v.effective_start desc,
            v.tombstones_record desc, v.untombstones_record desc,
            changes.applied_order desc, v.id desc
        )
        select r.*
        from %I.lookup_record r
        join visible_version v
          on v.app_id = r.app_id
         and v.customer_id = r.customer_id
         and v.model_id = r.model_id
         and v.record_id = r.id
        where r.app_id = %L
          and r.customer_id = %L
          and r.model_id = %L
          and not v.tombstones_record
          and not v.untombstones_record
          and v.availability = 'active'
        $query$,
        record_table,
        source_schema,
        source_schema,
        request_app_id,
        request_customer_id,
        model_id,
        request_as_of,
        request_as_of,
        source_schema,
        request_app_id,
        request_customer_id,
        model_id
      );
      execute format(
        $query$
        create temp view %I as
        select %s
        from (
          select distinct on (lookup_version.record_id) lookup_version.*
          from %I.lookup_version
          join %I.change_set changes
            on changes.id = lookup_version.change_set_id
           and changes.app_id = lookup_version.app_id
           and changes.customer_id = lookup_version.customer_id
          where lookup_version.app_id = %L
            and lookup_version.customer_id = %L
            and lookup_version.model_id = %L
            and lookup_version.stage = 'mainline'
            and changes.status = 'mainline'
            and changes.applied_order is not null
            and lookup_version.effective_start <= coalesce(%L::date, current_date)
            and (lookup_version.effective_end is null or lookup_version.effective_end >= coalesce(%L::date, current_date))
          order by lookup_version.record_id, lookup_version.effective_start desc,
            lookup_version.tombstones_record desc, lookup_version.untombstones_record desc,
            changes.applied_order desc, lookup_version.id desc
        ) v
        where not v.tombstones_record
          and not v.untombstones_record
          and v.availability = 'active'
        $query$,
        version_table,
        projection_sql,
        source_schema,
        source_schema,
        request_app_id,
        request_customer_id,
        model_id,
        request_as_of,
        request_as_of
      );
      if to_regrole(query_role) is not null then
        execute format('grant select on pg_temp.%I to %I', record_table, query_role);
        execute format('grant select on pg_temp.%I to %I', version_table, query_role);
      end if;
      continue;
    end if;
    if request_as_of is null then
      execute format(
        'create temp view %I as select * from %I.%I where app_id = %L and customer_id = %L',
        record_table,
        source_schema,
        record_table,
        request_app_id,
        request_customer_id
      );
      execute format(
        'create temp view %I as select * from %I.%I where app_id = %L and customer_id = %L',
        version_table,
        source_schema,
        version_table,
        request_app_id,
        request_customer_id
      );
    else
      execute format(
        $query$
        create temp view %I as
        with visible_version as (
          select distinct on (version.record_id) version.*
          from %I.%I version
          join %I.change_set changes
            on changes.id = version.change_set_id
           and changes.app_id = version.app_id
           and changes.customer_id = version.customer_id
          where version.app_id = %L
            and version.customer_id = %L
            and version.stage = 'mainline'
            and changes.status = 'mainline'
            and changes.applied_order is not null
            and version.effective_start <= %L::date
            and (version.effective_end is null or version.effective_end >= %L::date)
          order by version.record_id, version.effective_start desc, changes.applied_order desc, version.id desc
        )
        select record.*
        from %I.%I record
        join visible_version version on version.record_id = record.id
        where record.app_id = %L
          and record.customer_id = %L
          and not version.tombstones_record
          and not version.untombstones_record
        $query$,
        record_table,
        source_schema,
        version_table,
        source_schema,
        request_app_id,
        request_customer_id,
        request_as_of,
        request_as_of,
        source_schema,
        record_table,
        request_app_id,
        request_customer_id
      );
      execute format(
        $query$
        create temp view %I as
        select *
        from (
          select distinct on (version.record_id) version.*
          from %I.%I version
          join %I.change_set changes
            on changes.id = version.change_set_id
           and changes.app_id = version.app_id
           and changes.customer_id = version.customer_id
          where version.app_id = %L
            and version.customer_id = %L
            and version.stage = 'mainline'
            and changes.status = 'mainline'
            and changes.applied_order is not null
            and version.effective_start <= %L::date
            and (version.effective_end is null or version.effective_end >= %L::date)
          order by version.record_id, version.effective_start desc, changes.applied_order desc, version.id desc
        ) visible_version
        where not tombstones_record and not untombstones_record
        $query$,
        version_table,
        source_schema,
        version_table,
        source_schema,
        request_app_id,
        request_customer_id,
        request_as_of,
        request_as_of
      );
    end if;
    if to_regrole(query_role) is not null then
      execute format('grant select on pg_temp.%I to %I', record_table, query_role);
      execute format('grant select on pg_temp.%I to %I', version_table, query_role);
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'schema', source_schema,
    'query_role', query_role
  ));
exception when others then
  return jsonb_build_object(
    'ok', false,
    'error', jsonb_build_object('code', 'query_rejected', 'message', sqlerrm)
  );
end;
$kernel$;
"#;

const KERNEL_VALIDATE_VISIBLE_QUERY_REQUEST: &str = r#"
create or replace function kernel_validate_visible_query(request jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path from current
as $kernel$
declare
  statement text;
  params jsonb;
  param jsonb;
  param_type text;
  param_value text;
  prepared_types text := '';
  prepared_values text := '';
  prepare_sql text;
  explain_sql text;
  plan jsonb;
  operation text;
  scoped_app_id text := nullif(current_setting('kernel.app_id', true), '');
  scoped_customer_id text := nullif(current_setting('kernel.customer_id', true), '');
begin
  if scoped_app_id is not null and scoped_customer_id is not null
    and not kernel_policy_raw_table_access_allowed(
      current_user::name, scoped_app_id, scoped_customer_id
    )
  then
    return jsonb_build_object(
      'ok', false,
      'error', jsonb_build_object(
        'code', 'unsupported_capability',
        'message', 'The legacy prepared visible-query protocol is unavailable for policy-enabled revisions'
      )
    );
  end if;
  if request is null or jsonb_typeof(request) <> 'object' then
    return jsonb_build_object(
      'ok', false,
      'error', jsonb_build_object('code', 'query_rejected', 'message', 'query validation request must be an object')
    );
  end if;
  statement := request->>'sql';
  params := coalesce(request->'params', '[]'::jsonb);
  if jsonb_typeof(params) <> 'array' then
    return jsonb_build_object(
      'ok', false,
      'error', jsonb_build_object('code', 'query_rejected', 'message', 'query params must be an array')
    );
  end if;
  if statement is null or btrim(statement) = '' then
    return jsonb_build_object(
      'ok', false,
      'error', jsonb_build_object('code', 'query_rejected', 'message', 'SQL must not be empty')
    );
  end if;
  if statement ~* '(^|[^a-z0-9_])set_config[[:space:]]*\(' then
    return jsonb_build_object(
      'ok', false,
      'error', jsonb_build_object('code', 'query_rejected', 'message', 'SQL must not call set_config')
    );
  end if;

  for param in select value from jsonb_array_elements(params) with ordinality entry(value, ordinal) order by ordinal
  loop
    if jsonb_typeof(param) <> 'object' or not (param ? 'type') or not (param ? 'value') then
      return jsonb_build_object(
        'ok', false,
        'error', jsonb_build_object('code', 'query_rejected', 'message', 'each query parameter requires type and value')
      );
    end if;
    param_type := param->>'type';
    param_value := param #>> '{value}';
    if param_value is null then
      return jsonb_build_object(
        'ok', false,
        'error', jsonb_build_object('code', 'query_rejected', 'message', 'query parameters cannot be null')
      );
    end if;
    prepared_types := prepared_types || case when prepared_types = '' then '' else ', ' end;
    prepared_values := prepared_values || case when prepared_values = '' then '' else ', ' end;
    case param_type
      when 'text' then
        prepared_types := prepared_types || 'text';
        prepared_values := prepared_values || format('%L::text', param_value);
      when 'int' then
        perform param_value::bigint;
        prepared_types := prepared_types || 'bigint';
        prepared_values := prepared_values || format('%L::bigint', param_value);
      when 'number' then
        perform param_value::numeric;
        prepared_types := prepared_types || 'numeric';
        prepared_values := prepared_values || format('%L::numeric', param_value);
      when 'bool' then
        perform param_value::boolean;
        prepared_types := prepared_types || 'boolean';
        prepared_values := prepared_values || format('%L::boolean', param_value);
      when 'date' then
        perform param_value::date;
        prepared_types := prepared_types || 'date';
        prepared_values := prepared_values || format('%L::date', param_value);
      when 'json' then
        prepared_types := prepared_types || 'jsonb';
        prepared_values := prepared_values || format('%L::jsonb', (param->'value')::text);
      else
        return jsonb_build_object(
          'ok', false,
          'error', jsonb_build_object('code', 'query_rejected', 'message', 'unsupported query parameter type `' || param_type || '`')
        );
    end case;
  end loop;

  begin
    begin
      execute 'deallocate kernel_visible_query_validation';
    exception when invalid_sql_statement_name then
      null;
    end;
    prepare_sql := 'prepare kernel_visible_query_validation';
    if prepared_types <> '' then
      prepare_sql := prepare_sql || ' (' || prepared_types || ')';
    end if;
    execute prepare_sql || ' as ' || statement;
    explain_sql := 'explain (format json, verbose true) execute kernel_visible_query_validation';
    if prepared_values <> '' then
      explain_sql := explain_sql || '(' || prepared_values || ')';
    end if;
    execute explain_sql into plan;
    execute 'deallocate kernel_visible_query_validation';
  exception when others then
    begin
      execute 'deallocate kernel_visible_query_validation';
    exception when invalid_sql_statement_name then
      null;
    end;
    return jsonb_build_object(
      'ok', false,
      'error', jsonb_build_object(
        'code', case when sqlstate = '57014' then 'query_timeout' else 'query_rejected' end,
        'message', sqlerrm
      )
    );
  end;
  operation := plan #>> '{0,Plan,Operation}';
  if operation is not null and operation <> 'Select' then
    return jsonb_build_object(
      'ok', false,
      'error', jsonb_build_object('code', 'query_rejected', 'message', 'SQL must be one SELECT statement')
    );
  end if;
  if plan::text ~ '"Schema"[[:space:]]*:[[:space:]]*"(pg_catalog|information_schema)"' then
    return jsonb_build_object(
      'ok', false,
      'error', jsonb_build_object(
        'code', 'query_rejected',
        'message', 'SQL must not reference Postgres catalog objects'
      )
    );
  end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object());
exception when others then
  begin
    execute 'deallocate kernel_visible_query_validation';
  exception when invalid_sql_statement_name then
    null;
  end;
  return jsonb_build_object(
    'ok', false,
    'error', jsonb_build_object(
      'code', case when sqlstate = '57014' then 'query_timeout' else 'query_rejected' end,
      'message', sqlerrm
    )
  );
end;
$kernel$;
"#;

const KERNEL_VALIDATE_VISIBLE_QUERY: &str = r#"
create or replace function kernel_validate_visible_query(statement text)
returns jsonb
language sql
volatile
security invoker
set search_path from current
as $kernel$
  select kernel_validate_visible_query(
    jsonb_build_object('sql', statement, 'params', '[]'::jsonb)
  )
$kernel$;
"#;

const KERNEL_CLEANUP_VISIBLE_QUERY: &str = r#"
create or replace function kernel_cleanup_visible_query()
returns void
language plpgsql
volatile
security invoker
set search_path from current
as $kernel$
declare
  relation record;
begin
  begin
    execute 'deallocate kernel_visible_query_validation';
  exception when invalid_sql_statement_name then
    null;
  end;
  for relation in
    select namespace.nspname as schema_name, class.relname as relation_name
    from pg_catalog.pg_class as class
    join pg_catalog.pg_namespace as namespace on namespace.oid = class.relnamespace
    where class.relkind = 'v'
      and class.relnamespace = pg_catalog.pg_my_temp_schema()
      and class.relowner = current_user::regrole
  loop
    execute pg_catalog.format(
      'drop view if exists %I.%I cascade',
      relation.schema_name,
      relation.relation_name
    );
  end loop;
end;
$kernel$;
"#;

const KERNEL_CLEANUP_GENERATED_VISIBLE_QUERY: &str = r#"
create or replace function kernel_cleanup_generated_visible_query()
returns void
language plpgsql
volatile
security invoker
set search_path from current
as $kernel$
declare
  relation record;
begin
  begin
    execute 'deallocate kernel_visible_query_validation';
  exception when invalid_sql_statement_name then
    null;
  end;
  for relation in
    select namespace.nspname as schema_name, class.relname as relation_name
    from pg_catalog.pg_class as class
    join pg_catalog.pg_namespace as namespace on namespace.oid = class.relnamespace
    where class.relkind = 'v'
      and class.relnamespace = pg_catalog.pg_my_temp_schema()
      and class.relowner = current_user::regrole
  loop
    execute pg_catalog.format(
      'drop view if exists %I.%I cascade',
      relation.schema_name,
      relation.relation_name
    );
  end loop;
end;
$kernel$;
"#;

// Read-only relation discovery belongs to the shared runtime. Public installer
// activation functions call this helper without embedding dynamic SQL.
const KERNEL_LOOKUP_HAS_TYPED_HISTORY: &str = r#"
create or replace function kernel_lookup_has_typed_history(
  requested_app_id text,
  requested_customer_id text,
  requested_model_id text
)
returns boolean
language plpgsql
stable
security invoker
set search_path from current
as $kernel$
declare
  legacy_table text;
  table_has_typed_history boolean;
begin
  foreach legacy_table in array array[
    kernel_physical_identifier(requested_model_id || '_record'),
    kernel_physical_identifier(requested_model_id || '_version')
  ] loop
    if to_regclass(format('%I.%I', current_schema(), legacy_table)) is not null then
      execute format(
        'select exists(select 1 from %I.%I where app_id=$1 and customer_id=$2)',
        current_schema(), legacy_table
      ) into table_has_typed_history using requested_app_id, requested_customer_id;
      if table_has_typed_history then
        return true;
      end if;
    end if;
  end loop;
  return false;
end;
$kernel$;
"#;
