use super::RuntimeSqlFunction;

pub(super) fn functions() -> Vec<RuntimeSqlFunction> {
    vec![
        function("kernel_apply_identifier(text)", IDENTIFIER_SQL),
        function(
            "kernel_apply_normalize_lookup_label(text)",
            super::lookups::LOOKUP_NORMALIZE_LABEL,
        ),
        function(
            "kernel_apply_prepare_lookup_or_create(jsonb,jsonb)",
            super::lookups::LOOKUP_PREPARE_APPLY,
        ),
        function("kernel_apply_error_envelope(text,text)", ERROR_ENVELOPE_SQL),
        function(
            "kernel_apply_error_envelope(text,text,text,jsonb)",
            REQUEST_ERROR_ENVELOPE_SQL,
        ),
        function(
            "kernel_apply_error_envelope_v2(text,text,text,text,jsonb)",
            REQUEST_ERROR_ENVELOPE_V2_SQL,
        ),
        function("kernel_apply_fail(text,text,text,text,text)", FAIL_SQL),
        function(
            "kernel_apply_assert_lookup_storage_authority(text,text,text)",
            ASSERT_LOOKUP_STORAGE_AUTHORITY_SQL,
        ),
        function("kernel_apply_unique_fail(text,text,text)", UNIQUE_FAIL_SQL),
        function(
            "kernel_apply_typed_value_valid(jsonb,text)",
            TYPED_VALUE_VALID_SQL,
        ),
        function(
            "kernel_apply_metadata_valid(jsonb,jsonb)",
            METADATA_VALID_SQL,
        ),
        function(
            "kernel_apply_metadata_patch(jsonb,jsonb,jsonb,text)",
            METADATA_PATCH_SQL,
        ),
        function("kernel_apply_record_key_debug(jsonb)", RECORD_KEY_DEBUG_SQL),
        function(
            "kernel_apply_policy_record_values(jsonb,jsonb,jsonb,jsonb)",
            POLICY_RECORD_VALUES_SQL,
        ),
        function("kernel_apply_policy_write_fields(jsonb)", POLICY_WRITE_FIELDS_SQL),
        function(
            "kernel_apply_authorize_existing_target(jsonb,text,text,jsonb,text,uuid,date,boolean)",
            AUTHORIZE_EXISTING_TARGET_SQL,
        ),
        function(
            "kernel_apply_authorize_replay_relation_target(jsonb,text,text,jsonb,bigint,jsonb,text,uuid,boolean,date)",
            AUTHORIZE_REPLAY_RELATION_TARGET_SQL,
        ),
        function(
            "kernel_apply_authorize_replay(bigint,text,text,jsonb,jsonb,jsonb)",
            AUTHORIZE_REPLAY_SQL,
        ),
        function(
            "kernel_apply_field_value_issue(text,jsonb,jsonb)",
            &field_value_issue_sql(),
        ),
        function(
            "kernel_apply_validation_issues(jsonb,jsonb)",
            &validation_issues_sql(),
        ),
        function("kernel_apply_snapshot(jsonb,jsonb)", SNAPSHOT_SQL),
        function(
            "kernel_apply_validate_lookup_alias_reservations(text,text,text,uuid,jsonb,jsonb,jsonb)",
            VALIDATE_LOOKUP_ALIAS_RESERVATIONS_SQL,
        ),
        function(
            "kernel_apply_project_lookup_version_internal(uuid,text,text,text,uuid,jsonb,jsonb,jsonb,jsonb,boolean,jsonb)",
            PROJECT_LOOKUP_VERSION_SQL,
        ),
        function(
            "kernel_apply_project_lookup_version(uuid,text,text,text,uuid,jsonb,jsonb,jsonb,jsonb,boolean)",
            PROJECT_LOOKUP_VERSION_WRAPPER_SQL,
        ),
        function(
            "kernel_apply_execute_internal(jsonb,boolean,bigint,jsonb,boolean)",
            &execute_sql(),
        ),
        function(
            "kernel_apply_execute(jsonb,boolean,bigint)",
            EXECUTE_WRAPPER_SQL,
        ),
        function("kernel_apply_change_set(jsonb)", APPLY_SQL),
        function("kernel_resolve_source_identities(jsonb)", include_str!("source_identity.sql")),
        function(
            "kernel_apply_change_set_in_transaction(jsonb)",
            APPLY_IN_TRANSACTION_SQL,
        ),
        function("kernel_validate_change_set_dry_run(jsonb)", DRY_RUN_SQL),
        function(
            "kernel_validate_change_sets_dry_run(jsonb)",
            BATCH_DRY_RUN_SQL,
        ),
    ]
}

fn function(signature: &'static str, sql: &str) -> RuntimeSqlFunction {
    RuntimeSqlFunction {
        signature,
        sql: sql.trim().to_string(),
    }
}

fn execute_sql() -> String {
    EXECUTE_SQL_TEMPLATE
        .replace(
            "__KERNEL_COUNTRY_CODES__",
            &sql_string_array(2, kernel::is_iso_3166_1_alpha_2),
        )
        .replace(
            "__KERNEL_CURRENCY_CODES__",
            &sql_string_array(3, kernel::is_iso_4217_tender_currency),
        )
}

fn field_value_issue_sql() -> String {
    FIELD_VALUE_ISSUE_SQL_TEMPLATE
        .replace(
            "__KERNEL_COUNTRY_CODES__",
            &sql_string_array(2, kernel::is_iso_3166_1_alpha_2),
        )
        .replace(
            "__KERNEL_CURRENCY_CODES__",
            &sql_string_array(3, kernel::is_iso_4217_tender_currency),
        )
}

fn validation_issues_sql() -> String {
    VALIDATION_ISSUES_SQL_TEMPLATE
        .replace(
            "__KERNEL_COUNTRY_CODES__",
            &sql_string_array(2, kernel::is_iso_3166_1_alpha_2),
        )
        .replace(
            "__KERNEL_CURRENCY_CODES__",
            &sql_string_array(3, kernel::is_iso_4217_tender_currency),
        )
}

fn sql_string_array(width: usize, accepts: fn(&str) -> bool) -> String {
    let mut values = Vec::new();
    let mut candidate = vec![b'A'; width];
    loop {
        let value = String::from_utf8(candidate.clone()).expect("ASCII code candidate");
        if accepts(&value) {
            values.push(format!("'{value}'"));
        }
        let mut position = width;
        while position > 0 {
            position -= 1;
            if candidate[position] < b'Z' {
                candidate[position] += 1;
                for byte in &mut candidate[position + 1..] {
                    *byte = b'A';
                }
                break;
            }
        }
        if position == 0 && candidate[0] == b'Z' && candidate[1..].iter().all(|b| *b == b'Z') {
            let value = String::from_utf8(candidate.clone()).expect("ASCII code candidate");
            if accepts(&value) && !values.iter().any(|item| item == &format!("'{value}'")) {
                values.push(format!("'{value}'"));
            }
            break;
        }
    }
    format!("array[{}]::text[]", values.join(","))
}

const IDENTIFIER_SQL: &str = r#"
create or replace function kernel_apply_identifier(logical_id text)
returns text
language plpgsql
immutable
security invoker
set search_path from current
as $kernel_apply$
declare
  normalized text;
  candidate text;
begin
  normalized := regexp_replace(lower(btrim(logical_id)), '[[:space:]_-]+', '_', 'g');
  normalized := btrim(normalized, '_');
  if normalized is null or normalized = '' or normalized !~ '^[a-z][a-z0-9_]*$' then
    perform kernel_apply_fail(
      'schema_drift', 'Schema drift detected', 'object', 'schema_drift',
      coalesce(logical_id, '<null>') || ': invalid logical identifier'
    );
  end if;
  candidate := kernel_physical_identifier(normalized);
  return candidate;
end;
$kernel_apply$;
"#;

const FAIL_SQL: &str = r#"
create or replace function kernel_apply_fail(
  error_code text,
  error_message text,
  detail_path text default null,
  detail_code text default null,
  detail_message text default null
)
returns void
language plpgsql
volatile
security invoker
set search_path from current
as $kernel_apply$
declare
  envelope jsonb;
begin
  envelope := jsonb_build_object(
    'code', error_code,
    'message', error_message,
    'details', case when detail_path is null then '[]'::jsonb else jsonb_build_array(
      jsonb_build_object(
        'path', detail_path,
        'code', coalesce(detail_code, error_code),
        'message', coalesce(detail_message, error_message)
      )
    ) end
  );
  raise exception using errcode = 'P0001', message = 'kernel_apply:' || envelope::text;
end;
$kernel_apply$;
"#;

const ASSERT_LOOKUP_STORAGE_AUTHORITY_SQL: &str = r#"
create or replace function kernel_apply_assert_lookup_storage_authority(
  requested_app_id text,
  requested_customer_id text,
  requested_model_id text
)
returns void
language plpgsql
volatile
security invoker
set search_path from current
as $kernel_apply$
declare
  authority_error jsonb;
begin
  authority_error := kernel_lookup_storage_authority_error(
    requested_app_id, requested_customer_id, requested_model_id
  );
  if authority_error is not null then
    perform kernel_apply_fail(
      authority_error->>'code',
      authority_error->>'message',
      authority_error#>>'{details,0,path}',
      authority_error#>>'{details,0,code}',
      authority_error#>>'{details,0,message}'
    );
  end if;
end;
$kernel_apply$;
"#;

const ERROR_ENVELOPE_SQL: &str = r#"
create or replace function kernel_apply_error_envelope(error_sqlstate text, error_message text)
returns jsonb
language plpgsql
stable
security invoker
set search_path from current
as $kernel_apply$
declare
  payload text;
begin
  if error_message like 'kernel_apply:%' then
    payload := substring(error_message from length('kernel_apply:') + 1);
    return payload::jsonb;
  end if;
  -- Shared policy helpers raise a stable prefix instead of an apply envelope.
  -- Keep authorization failure safe and distinguish it from an unexpected fault.
  if error_sqlstate = 'P0001' and error_message like 'authorization_denied:%' then
    return jsonb_build_object(
      'code', 'authorization_denied',
      'message', 'This operation is not authorized',
      'details', '[]'::jsonb
    );
  end if;
  if error_sqlstate = 'P0001' and error_message like 'unsupported_capability:%' then
    return jsonb_build_object(
      'code', 'unsupported_capability',
      'message', 'This capability is not supported',
      'details', '[]'::jsonb
    );
  end if;
  if error_sqlstate = 'P0001' and error_message like 'active_schema_missing:%' then
    return jsonb_build_object(
      'code', 'active_schema_missing',
      'message', 'No active schema revision exists for this scope',
      'details', jsonb_build_array(jsonb_build_object(
        'path', 'scope', 'code', 'active_schema_missing',
        'message', 'materialize a schema before applying or reading records'
      ))
    );
  end if;
  if error_sqlstate = '23505' then
    return jsonb_build_object(
      'code', 'record_key_conflict',
      'message', 'Record key conflict',
      'details', '[]'::jsonb
    );
  end if;
  return jsonb_build_object(
    'code', 'database_error',
    'message', 'Database operation failed',
    'details', '[]'::jsonb
  );
end;
$kernel_apply$;
"#;

const REQUEST_ERROR_ENVELOPE_SQL: &str = r#"
create or replace function kernel_apply_error_envelope(
  error_sqlstate text,
  error_message text,
  error_constraint text,
  request jsonb
)
returns jsonb
language plpgsql
stable
security invoker
set search_path from current
as $kernel_apply$
declare
  active_schema jsonb;
  model jsonb;
  field jsonb;
  write jsonb;
  typed_value jsonb;
  model_id text;
  field_id text;
  field_type text;
  version_name text;
  column_name text;
  expected_constraint text;
  display_value text;
begin
  if error_sqlstate <> '23505' or error_constraint is null then
    return kernel_apply_error_envelope(error_sqlstate, error_message);
  end if;

  select schema into active_schema
  from schema_revision
  where app_id = request->>'app_id'
    and customer_id = request->>'customer_id'
    and activated_at is not null;

  for model in
    select value from jsonb_array_elements(coalesce(active_schema->'models','[]'::jsonb)) item(value)
  loop
    model_id := model->>'id';
    version_name := kernel_apply_identifier(kernel_apply_identifier(model_id) || '_version');
    for field in
      select value from jsonb_array_elements(coalesce(model->'fields','[]'::jsonb)) item(value)
      where coalesce((value->>'is_unique')::boolean,false)
    loop
      field_id := field->>'id';
      field_type := field->>'type';
      column_name := kernel_apply_identifier(field_id);
      if field_type = 'money_rate' then
        column_name := kernel_apply_identifier(column_name || '_amount');
      end if;
      expected_constraint := kernel_apply_identifier(
        version_name || '_' || column_name || '_live_unique_idx'
      );
      if error_constraint <> expected_constraint then
        continue;
      end if;

      select value into write
      from jsonb_array_elements(coalesce(request->'writes','[]'::jsonb)) item(value)
      where value->>'model_id' = model_id
        and jsonb_typeof(value->'values') = 'object'
        and value->'values' ? field_id
      limit 1;
      typed_value := write->'values'->field_id;
      display_value := case field_type
        when 'relation' then kernel_apply_record_key_debug(typed_value->'value')
        when 'text_list' then (
          select string_agg(value, ', ' order by ordinal)
          from jsonb_array_elements_text(typed_value->'value') with ordinality item(value,ordinal)
        )
        when 'known_aliases' then (
          select string_agg(value, ', ' order by ordinal)
          from jsonb_array_elements_text(typed_value->'value') with ordinality item(value,ordinal)
        )
        when 'json' then kernel_canonical_json(typed_value->'value')
        when 'money_rate' then
          (typed_value#>>'{value,amount}') || ' ' ||
          (typed_value#>>'{value,currency}') || ' ' ||
          initcap(typed_value#>>'{value,period}')
        else typed_value->>'value'
      end;
      return jsonb_build_object(
        'code','unique_field_conflict',
        'message','Unique field value already exists',
        'details',jsonb_build_array(
          jsonb_build_object('path','model','code','unique_field_conflict','message',model_id),
          jsonb_build_object('path','field','code','unique_field_conflict','message',field_id),
          jsonb_build_object('path','value','code','unique_field_conflict','message',coalesce(display_value,'<unknown>'))
        )
      );
    end loop;
  end loop;

  return kernel_apply_error_envelope(error_sqlstate, error_message);
end;
$kernel_apply$;
"#;

const REQUEST_ERROR_ENVELOPE_V2_SQL: &str = r#"
create or replace function kernel_apply_error_envelope_v2(
  error_sqlstate text,
  error_message text,
  error_constraint text,
  error_table text,
  request jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path from current
as $kernel_apply$
declare
  identity_row record;
  details jsonb;
begin
  if error_sqlstate = '23514'
    and error_constraint is not null
    and error_table is not null
  then
    -- The failed executor subtransaction rolls back its tenant settings.
    -- Restore scope before reading the RLS-protected diagnostic catalog.
    perform set_config('kernel.app_id', request->>'app_id', true);
    perform set_config('kernel.customer_id', request->>'customer_id', true);
    select identity_value->>'model_id' as model_id,
           identity_value->>'constraint_id' as constraint_id,
           identity_value->'field_ids' as field_ids
    into identity_row
    from schema_revision as revision
    join schema_constraint_identity as snapshot on snapshot.schema_revision_id = revision.id
      and snapshot.app_id = revision.app_id and snapshot.customer_id = revision.customer_id
    cross join lateral jsonb_array_elements(snapshot.catalog) as identity_item(identity_value)
    where revision.app_id = request->>'app_id'
      and revision.customer_id = request->>'customer_id'
      and revision.activated_at is not null
      and identity_value->>'table_name' = error_table
      and identity_value->>'constraint_name' = error_constraint;
    if found then
      details := jsonb_build_array(
        jsonb_build_object(
          'path', 'model',
          'code', 'constraint_violation',
          'message', identity_row.model_id
        ),
        jsonb_build_object(
          'path', 'constraint',
          'code', 'constraint_violation',
          'message', identity_row.constraint_id
        )
      ) || coalesce((
        select jsonb_agg(jsonb_build_object(
          'path', 'field',
          'code', 'constraint_violation',
          'message', value
        ))
        from jsonb_array_elements_text(identity_row.field_ids) as item(value)
      ), '[]'::jsonb);
      return jsonb_build_object(
        'code', 'constraint_violation',
        'message', 'A required rule was not satisfied',
        'details', details
      );
    end if;
  end if;
  return kernel_apply_error_envelope(error_sqlstate, error_message, error_constraint, request);
end;
$kernel_apply$;
"#;

const RECORD_KEY_DEBUG_SQL: &str = r#"
create or replace function kernel_apply_record_key_debug(record_key jsonb)
returns text
language sql
immutable
security invoker
set search_path from current
as $kernel_apply$
  select case record_key->>'type'
    when 'record_id' then 'RecordId(' || (record_key->>'value') || ')'
    when 'external_key' then 'ExternalKey(ExternalKey(' || to_jsonb(record_key->>'value')::text || '))'
    else record_key::text
  end
$kernel_apply$;
"#;

// The shared policy functions own grant semantics. These apply-local helpers
// reconstruct the canonical images and fields that an audited write exposes.
const POLICY_RECORD_VALUES_SQL: &str = r#"
create or replace function kernel_apply_policy_record_values(values_json jsonb, custom_fields_json jsonb, metadata_json jsonb, many_relations_json jsonb)
returns jsonb language sql immutable security invoker set search_path from current
as $kernel_apply$
  select coalesce(values_json, '{}'::jsonb)
    || coalesce((select jsonb_object_agg(item.value->>'field_id', item.value - 'field_id') from jsonb_array_elements(coalesce(custom_fields_json, '[]'::jsonb)) item(value)), '{}'::jsonb)
    || jsonb_build_object('$metadata', jsonb_build_object('type', 'json', 'value', coalesce(metadata_json, '{}'::jsonb)))
    || coalesce((select jsonb_object_agg(entry.key, jsonb_build_object('type', 'relation_list', 'value', entry.value)) from jsonb_each(coalesce(many_relations_json, '{}'::jsonb)) entry(key, value)), '{}'::jsonb)
$kernel_apply$;
"#;

const POLICY_WRITE_FIELDS_SQL: &str = r#"
create or replace function kernel_apply_policy_write_fields(write jsonb)
returns jsonb language sql immutable security invoker set search_path from current
as $kernel_apply$
  select coalesce(jsonb_agg(to_jsonb(field_id) order by field_id), '[]'::jsonb)
  from (
    select key as field_id from jsonb_each(case when jsonb_typeof(write->'values') = 'object' then write->'values' else '{}'::jsonb end) where key <> '__lookup_lifecycle'
    union select value->>'field_id' from jsonb_array_elements(case when jsonb_typeof(write->'custom_fields') = 'array' then write->'custom_fields' else '[]'::jsonb end)
    union select value from jsonb_array_elements_text(case when jsonb_typeof(write->'clear_fields') = 'array' then write->'clear_fields' else '[]'::jsonb end)
    union select value from jsonb_array_elements_text(case when jsonb_typeof(write->'clear_custom_fields') = 'array' then write->'clear_custom_fields' else '[]'::jsonb end)
    union select '$metadata' where write ? 'metadata_patch' and write->'metadata_patch' <> 'null'::jsonb
  ) requested(field_id)
$kernel_apply$;
"#;

const AUTHORIZE_EXISTING_TARGET_SQL: &str = r#"
create or replace function kernel_apply_authorize_existing_target(policy jsonb, app text, customer text, active_schema jsonb, target_model_id text, target_record_id uuid, as_of date, resolved_by_external_key boolean)
returns void language plpgsql volatile security invoker set search_path from current
as $kernel_apply$
declare target_model jsonb; version_table text; version_filter text := ''; version_json jsonb; required_fields jsonb := jsonb_build_array('$id'); target_values jsonb;
begin
  select value into target_model from jsonb_array_elements(coalesce(active_schema->'models', '[]'::jsonb)) item(value) where value->>'id' = target_model_id;
  if target_model is null then perform kernel_apply_fail('schema_drift', 'Schema drift detected', 'relation', 'unknown_target_model', target_model_id); end if;
  if resolved_by_external_key then required_fields := required_fields || jsonb_build_array('$externalKey'); end if;
  if target_model->>'kind' = 'lookup' then version_table := 'lookup_version'; version_filter := format(' and v.model_id=%L', target_model_id); else version_table := quote_ident(kernel_apply_identifier(kernel_apply_identifier(target_model_id) || '_version')); end if;
  execute format('select to_jsonb(v) from %s v join change_set cs on cs.id=v.change_set_id and cs.app_id=v.app_id and cs.customer_id=v.customer_id where v.record_id=$1 and v.app_id=$2 and v.customer_id=$3 and v.stage=''mainline'' and cs.status=''mainline'' and cs.applied_order is not null and v.effective_start <= $4 and (v.effective_end is null or v.effective_end >= $4)%s order by v.effective_start desc,v.tombstones_record desc,v.untombstones_record desc,cs.applied_order desc,v.id desc limit 1', version_table, version_filter) using target_record_id, app, customer, as_of into version_json;
  if version_json is null or coalesce((version_json->>'tombstones_record')::boolean, false) then perform kernel_apply_fail('record_target_missing', 'Relation target is not visible'); end if;
  target_values := kernel_apply_policy_record_values(kernel_apply_snapshot(version_json, target_model), version_json->'custom_fields', version_json->'metadata', version_json->'many_relations');
  if not kernel_policy_required_fields_allowed(policy, target_model_id, 'read', required_fields) or not kernel_policy_record_allowed(policy, target_model_id, 'read', required_fields, target_values) then
    perform kernel_apply_fail('authorization_denied', 'Relation target is not authorized', 'relation', 'relation_target_not_authorized', target_model_id);
  end if;
end;
$kernel_apply$;
"#;

const AUTHORIZE_REPLAY_RELATION_TARGET_SQL: &str = r#"
create or replace function kernel_apply_authorize_replay_relation_target(
  policy jsonb,
  app text,
  customer text,
  active_schema jsonb,
  replay_change_set_id bigint,
  replay_request jsonb,
  target_model_id text,
  target_record_id uuid,
  resolved_by_external_key boolean,
  as_of date
)
returns void language plpgsql volatile security invoker set search_path from current
as $kernel_apply$
declare
  target_model jsonb;
  target_version_table text;
  target_version_filter text := '';
  target_receipt_exists boolean := false;
  original_create_matches bigint := 0;
  created_in_replay boolean := false;
begin
  if target_record_id is null then
    perform kernel_apply_fail('schema_drift', 'Schema drift detected', 'idempotency_key', 'replay_relation_target_missing', target_model_id);
  end if;
  select value into target_model
  from jsonb_array_elements(coalesce(active_schema->'models', '[]'::jsonb)) item(value)
  where value->>'id' = target_model_id;
  if target_model is null then
    perform kernel_apply_fail('schema_drift', 'Schema drift detected', 'relation', 'unknown_target_model', target_model_id);
  end if;
  if target_model->>'kind' = 'lookup' then
    target_version_table := 'lookup_version';
    target_version_filter := format(' and v.model_id=%L', target_model_id);
  else
    target_version_table := quote_ident(kernel_apply_identifier(kernel_apply_identifier(target_model_id) || '_version'));
  end if;

  -- Target identity comes from the persisted receipt image. The authored key
  -- kind controls only whether the current policy must allow $externalKey.
  execute format(
    'select exists (select 1 from %s v where v.change_set_id=$1 and v.app_id=$2 and v.customer_id=$3 and v.record_id=$4%s)',
    target_version_table, target_version_filter
  ) using replay_change_set_id, app, customer, target_record_id into target_receipt_exists;
  -- Generated creates carry immutable new_record_id values. Only an original
  -- same-receipt create may supply a target without an independently readable
  -- row; external-key record subjects are rejected before persistence.
  select count(*) into original_create_matches
  from jsonb_array_elements(coalesce(replay_request->'writes', '[]'::jsonb)) write_value(value)
  where write_value.value->>'model_id' = target_model_id
    and coalesce((write_value.value->>'tombstones_record')::boolean, false) is false
    and write_value.value->>'new_record_id' = target_record_id::text;
  created_in_replay := target_receipt_exists and original_create_matches = 1;
  if created_in_replay then
    return;
  end if;
  perform kernel_apply_authorize_existing_target(
    policy, app, customer, active_schema, target_model_id, target_record_id, as_of,
    resolved_by_external_key
  );
end;
$kernel_apply$;
"#;

const AUTHORIZE_REPLAY_SQL: &str = r#"
create or replace function kernel_apply_authorize_replay(replay_change_set_id bigint, app text, customer text, replay_request jsonb, policy jsonb, active_schema jsonb)
returns void language plpgsql volatile security invoker set search_path from current
as $kernel_apply$
declare replay_set record; replay_schema jsonb; model jsonb; model_id text; version_table text; version_filter text := ''; row_json jsonb; old_row jsonb; old_values jsonb; new_values jsonb; fields jsonb; operation text;
  replay_write jsonb;
  replay_matches bigint;
  relation_field jsonb;
  target_record_id uuid;
  custom_definition jsonb;
  custom_entry jsonb;
  many_relation jsonb;
  many_target jsonb;
  original_target jsonb;
  relation_key jsonb;
  receipt_values jsonb;
  relation_as_of date;
begin
  select schema_revision_id, created_with_mode, status into replay_set from change_set where id = replay_change_set_id and app_id = app and customer_id = customer;
  if not found then perform kernel_apply_fail('schema_drift', 'Schema drift detected', 'idempotency_key', 'replay_change_set_missing', replay_change_set_id::text); end if;
  if replay_set.created_with_mode <> 'mainline' or replay_set.status <> 'mainline' then perform kernel_apply_fail('unsupported_capability', 'Policy-enabled replay does not support draft lifecycle receipts', 'mode', 'unsupported_policy_lifecycle', replay_set.created_with_mode); end if;
  select schema into replay_schema from schema_revision where id = replay_set.schema_revision_id and app_id = app and customer_id = customer;
  if replay_schema is null then perform kernel_apply_fail('schema_drift', 'Schema drift detected', 'schema_revision_id', 'replay_schema_missing', replay_set.schema_revision_id::text); end if;
  for model in select value from jsonb_array_elements(coalesce(replay_schema->'models', '[]'::jsonb)) item(value) loop
    model_id := model->>'id';
    if model->>'kind' = 'lookup' then version_table := 'lookup_version'; version_filter := format(' and v.model_id=%L', model_id); else version_table := quote_ident(kernel_apply_identifier(kernel_apply_identifier(model_id) || '_version')); version_filter := ''; end if;
    for row_json in execute format('select to_jsonb(v) from %s v where v.change_set_id=$1 and v.app_id=$2 and v.customer_id=$3%s order by v.effective_start,v.id', version_table, version_filter) using replay_change_set_id, app, customer loop
      select count(*), (jsonb_agg(request_write.value))->0
      into replay_matches, replay_write
      from jsonb_array_elements(coalesce(replay_request->'writes', '[]'::jsonb)) request_write(value)
      where request_write.value->>'model_id' = model_id
        and (
          request_write.value->>'new_record_id' = row_json->>'record_id'
          or (
            request_write.value->'record_key'->>'type' = 'record_id'
            and request_write.value->'record_key'->>'value' = row_json->>'record_id'
          )
        )
        and request_write.value->>'effective_start' = row_json->>'effective_start'
        and coalesce((request_write.value->>'tombstones_record')::boolean, false)
          = coalesce((row_json->>'tombstones_record')::boolean, false);
      if replay_matches <> 1 then
        perform kernel_apply_fail(
          'schema_drift', 'Schema drift detected', 'idempotency_key',
          'replay_request_subject_missing',
          'the stored change set cannot be mapped to one durable request subject'
        );
      end if;
      -- A later write closes effective_end on the historical row, so the old
      -- image is selected from preceding audit events rather than visibility at
      -- the replay date. Include preceding rows in this same receipt; a
      -- same-date ordinary event is the predecessor of its tombstone.
      execute format('select to_jsonb(v) from %s v join change_set cs on cs.id=v.change_set_id and cs.app_id=v.app_id and cs.customer_id=v.customer_id where v.record_id=$1 and v.app_id=$2 and v.customer_id=$3 and v.stage=''mainline'' and cs.status=''mainline'' and cs.applied_order is not null and (cs.applied_order < (select applied_order from change_set where id=$4) or (v.change_set_id=$4 and (v.effective_start < $5 or (v.effective_start = $5 and $6::boolean and not v.tombstones_record)))) and v.effective_start <= $5%s order by v.effective_start desc,v.tombstones_record desc,v.untombstones_record desc,cs.applied_order desc,v.id desc limit 1', version_table, version_filter) using (row_json->>'record_id')::uuid, app, customer, replay_change_set_id, (row_json->>'effective_start')::date, coalesce((row_json->>'tombstones_record')::boolean, false) into old_row;
      old_values := case when old_row is null then null else kernel_apply_policy_record_values(kernel_apply_snapshot(old_row, model), old_row->'custom_fields', old_row->'metadata', old_row->'many_relations') end;
      new_values := kernel_apply_policy_record_values(kernel_apply_snapshot(row_json, model), row_json->'custom_fields', row_json->'metadata', row_json->'many_relations');
      if coalesce((row_json->>'tombstones_record')::boolean, false) then operation := 'delete'; fields := '[]'::jsonb;
      elsif replay_write ? 'new_record_id' and replay_write->'new_record_id' <> 'null'::jsonb then operation := 'create'; fields := kernel_apply_policy_write_fields(replay_write);
      else operation := 'update'; fields := kernel_apply_policy_write_fields(replay_write); end if;
      if not kernel_policy_required_fields_allowed(policy, model_id, operation, fields)
        or (operation in ('update', 'delete') and not kernel_policy_record_allowed(policy, model_id, operation, fields, old_values))
        or (operation in ('create', 'update') and not kernel_policy_record_allowed(policy, model_id, operation, fields, new_values)) then
        perform kernel_apply_fail('authorization_denied', 'Replay is not authorized under the current policy', 'idempotency_key', 'replay_not_authorized', model_id);
      end if;
    end loop;
  end loop;

  -- Normalize only relation values that were supplied in the fingerprinted
  -- request. Pair each with its persisted receipt identity; never resolve an
  -- authored external key against mutable record or alias tables on replay.
  for model in select value from jsonb_array_elements(coalesce(replay_schema->'models', '[]'::jsonb)) item(value) loop
    model_id := model->>'id';
    if model->>'kind' = 'lookup' then
      version_table := 'lookup_version';
      version_filter := format(' and v.model_id=%L', model_id);
    else
      version_table := quote_ident(kernel_apply_identifier(kernel_apply_identifier(model_id) || '_version'));
      version_filter := '';
    end if;
    for row_json in execute format('select to_jsonb(v) from %s v where v.change_set_id=$1 and v.app_id=$2 and v.customer_id=$3%s order by v.effective_start,v.id', version_table, version_filter) using replay_change_set_id, app, customer loop
      select count(*), (jsonb_agg(request_write.value))->0
      into replay_matches, replay_write
      from jsonb_array_elements(coalesce(replay_request->'writes', '[]'::jsonb)) request_write(value)
      where request_write.value->>'model_id' = model_id
        and (
          request_write.value->>'new_record_id' = row_json->>'record_id'
          or (
            request_write.value->'record_key'->>'type' = 'record_id'
            and request_write.value->'record_key'->>'value' = row_json->>'record_id'
          )
        )
        and request_write.value->>'effective_start' = row_json->>'effective_start'
        and coalesce((request_write.value->>'tombstones_record')::boolean, false)
          = coalesce((row_json->>'tombstones_record')::boolean, false);
      if replay_matches <> 1 then
        perform kernel_apply_fail('schema_drift', 'Schema drift detected', 'idempotency_key', 'replay_request_subject_missing', 'the stored change set cannot be mapped to one durable request subject');
      end if;
      begin
        relation_as_of := (row_json->>'effective_start')::date;
      exception when others then
        perform kernel_apply_fail('schema_drift', 'Schema drift detected', 'idempotency_key', 'replay_relation_target_missing', model_id);
      end;
      receipt_values := kernel_apply_snapshot(row_json, model);

      for relation_field in
        select value from jsonb_array_elements(coalesce(model->'fields', '[]'::jsonb)) item(value)
        where value->>'type' = 'relation'
          and coalesce(replay_write->'values', '{}'::jsonb) ? (value->>'id')
      loop
        begin
          target_record_id := (receipt_values->(relation_field->>'id')->'value'->>'value')::uuid;
        exception when others then
          perform kernel_apply_fail('schema_drift', 'Schema drift detected', 'idempotency_key', 'replay_relation_target_missing', relation_field->>'id');
        end;
        perform kernel_apply_authorize_replay_relation_target(
          policy, app, customer, active_schema, replay_change_set_id, replay_request,
          relation_field->>'target_model', target_record_id,
          replay_write->'values'->(relation_field->>'id')->'value'->>'type' = 'external_key',
          relation_as_of
        );
      end loop;

      for custom_entry in
        select value from jsonb_array_elements(coalesce(replay_write->'custom_fields', '[]'::jsonb)) item(value)
      loop
        select value into custom_definition
        from jsonb_array_elements(coalesce(replay_schema->'custom_fields', '[]'::jsonb)) item(value)
        where value->>'model_id' = model_id and value->>'field_id' = custom_entry->>'field_id'
          and value->>'type' = 'relation';
        if custom_definition is null or custom_entry->>'type' <> 'relation' then continue; end if;
        select value into relation_key
        from jsonb_array_elements(coalesce(row_json->'custom_fields', '[]'::jsonb)) item(value)
        where value->>'field_id' = custom_entry->>'field_id';
        begin
          target_record_id := (relation_key->'value'->>'value')::uuid;
        exception when others then
          perform kernel_apply_fail('schema_drift', 'Schema drift detected', 'idempotency_key', 'replay_relation_target_missing', custom_entry->>'field_id');
        end;
        perform kernel_apply_authorize_replay_relation_target(
          policy, app, customer, active_schema, replay_change_set_id, replay_request,
          custom_definition->>'target_model_id', target_record_id,
          custom_entry->'value'->>'type' = 'external_key', relation_as_of
        );
      end loop;

      for many_relation in
        select value from jsonb_array_elements(coalesce(model->'many_relations', '[]'::jsonb)) item(value)
        where coalesce(replay_write->'values', '{}'::jsonb) ? (value->>'id')
      loop
        if replay_write->'values'->(many_relation->>'id')->>'type' <> 'relation_list'
          or jsonb_typeof(row_json->'many_relations'->(many_relation->>'id')) <> 'array'
          or jsonb_array_length(replay_write->'values'->(many_relation->>'id')->'value') <> jsonb_array_length(row_json->'many_relations'->(many_relation->>'id'))
        then
          perform kernel_apply_fail('schema_drift', 'Schema drift detected', 'idempotency_key', 'replay_relation_target_missing', many_relation->>'id');
        end if;
        for original_target, many_target in
          select original_item.value, persisted_item.value
          from jsonb_array_elements(replay_write->'values'->(many_relation->>'id')->'value') with ordinality original_item(value, ordinal)
          join jsonb_array_elements(row_json->'many_relations'->(many_relation->>'id')) with ordinality persisted_item(value, ordinal)
            using (ordinal)
          order by ordinal
        loop
          begin
            target_record_id := (case when jsonb_typeof(many_target)='string' then many_target#>>'{}' else many_target->>'value' end)::uuid;
          exception when others then
            perform kernel_apply_fail('schema_drift', 'Schema drift detected', 'idempotency_key', 'replay_relation_target_missing', many_relation->>'id');
          end;
          perform kernel_apply_authorize_replay_relation_target(
            policy, app, customer, active_schema, replay_change_set_id, replay_request,
            many_relation->>'target_model', target_record_id,
            case when jsonb_typeof(original_target)='object' then original_target->>'type'='external_key' else false end,
            relation_as_of
          );
        end loop;
      end loop;
    end loop;
  end loop;
end;
$kernel_apply$;
"#;

// The value checks of one typed field value, shared by write validation and
// working-session rule outputs: representation, active enum option, and ISO
// country and currency codes. Returns null, 'type_mismatch',
// 'unknown_enum_option' or 'retired_enum_option'.
const FIELD_VALUE_ISSUE_SQL_TEMPLATE: &str = r#"
create or replace function kernel_apply_field_value_issue(field_type text, option_set jsonb, typed_value jsonb)
returns text
language plpgsql
immutable
security invoker
set search_path from current
as $kernel_apply$
declare
  country_codes text[] := __KERNEL_COUNTRY_CODES__;
  currency_codes text[] := __KERNEL_CURRENCY_CODES__;
begin
  if not kernel_apply_typed_value_valid(typed_value, case
    when field_type in ('iso_country','iso_currency') then 'text'
    when field_type = 'known_aliases' then 'text_list'
    else field_type end) then
    return 'type_mismatch';
  end if;
  if field_type = 'enum' and not exists(
    select 1 from jsonb_array_elements(coalesce(option_set,'[]'::jsonb)) option(value)
    where value->>'id' = typed_value->>'value' and coalesce(value->>'lifecycle','active')='active'
  ) then
    return case when exists(
      select 1 from jsonb_array_elements(coalesce(option_set,'[]'::jsonb)) option(value)
      where value->>'id'=typed_value->>'value' and coalesce(value->>'lifecycle','active')='retired'
    ) then 'retired_enum_option' else 'unknown_enum_option' end;
  end if;
  if (field_type = 'iso_country' and not ((typed_value->>'value') = any(country_codes)))
    or (field_type = 'iso_currency' and not ((typed_value->>'value') = any(currency_codes)))
    or (field_type = 'money_rate' and not ((typed_value#>>'{value,currency}') = any(currency_codes))) then
    return 'type_mismatch';
  end if;
  return null;
end;
$kernel_apply$;
"#;

const VALIDATION_ISSUES_SQL_TEMPLATE: &str = r#"
create or replace function kernel_apply_validation_issues(request jsonb, active_schema jsonb)
returns jsonb
language plpgsql
immutable
security invoker
set search_path from current
as $kernel_apply$
declare
  issues jsonb := '[]'::jsonb;
  write jsonb;
  write_index bigint;
  write_path text;
  model jsonb;
  model_id text;
  record_key jsonb;
  has_record_key boolean;
  has_new_record_id boolean;
  tombstone boolean;
  values_json jsonb;
  custom_fields_json jsonb;
  clear_fields_json jsonb;
  clear_custom_fields_json jsonb;
  metadata_patch_json jsonb;
  field_entry record;
  field jsonb;
  field_id text;
  field_type text;
  expected_type text;
  typed_value jsonb;
  custom_entry jsonb;
  custom_index bigint;
  custom_path text;
  custom_definition jsonb;
  many_relation jsonb;
  duplicate_custom boolean;
  seen_custom jsonb;
  seen_clear jsonb;
  explicit_new_subjects jsonb := '{}'::jsonb;
  selected_change_type jsonb;
  issue_code text;
  issue_message text;
  country_codes text[] := __KERNEL_COUNTRY_CODES__;
  currency_codes text[] := __KERNEL_CURRENCY_CODES__;
begin
  if request->>'app_id' is distinct from active_schema->>'app_id' then
    issues := issues || jsonb_build_array(jsonb_build_object(
      'path','app_id','code','app_id_mismatch',
      'message','apply app_id must match schema app_id'
    ));
  end if;
  if request->>'customer_id' is distinct from active_schema->>'customer_id' then
    issues := issues || jsonb_build_array(jsonb_build_object(
      'path','customer_id','code','customer_id_mismatch',
      'message','apply customer_id must match schema customer_id'
    ));
  end if;

  if request ? 'change_type_id' and request->'change_type_id' <> 'null'::jsonb then
    select value into selected_change_type
    from jsonb_array_elements(coalesce(active_schema->'change_types','[]'::jsonb)) item(value)
    where value->>'id' = request->>'change_type_id';
    if selected_change_type is null then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'path','change_type_id','code','unknown_change_type',
        'message','change_type_id `' || (request->>'change_type_id') || '` is not declared in the active schema'
      ));
    end if;
  end if;

  for write in
    select value from jsonb_array_elements(coalesce(request->'writes','[]'::jsonb)) item(value)
  loop
    if write ? 'new_record_id' and write->'new_record_id' <> 'null'::jsonb then
      explicit_new_subjects := explicit_new_subjects || jsonb_build_object(
        (write->>'model_id') || ':' || (write->>'new_record_id'),
        true
      );
    end if;
  end loop;

  for write, write_index in
    select value, ordinal - 1
    from jsonb_array_elements(coalesce(request->'writes','[]'::jsonb))
      with ordinality item(value,ordinal)
  loop
    write_path := 'writes[' || write_index || ']';
    model_id := write->>'model_id';
    has_record_key := write ? 'record_key' and write->'record_key' <> 'null'::jsonb;
    has_new_record_id := write ? 'new_record_id' and write->'new_record_id' <> 'null'::jsonb;
    record_key := case when has_record_key then write->'record_key' else null end;
    if has_record_key and record_key->>'type' = 'record_id'
      and explicit_new_subjects ? (model_id || ':' || (record_key->>'value'))
    then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'path',write_path || '.record_key','code','mixed_new_record_subject_addressing',
        'message','all writes for an explicitly new record must identify the subject with new_record_id'
      ));
    end if;

    select value into model
    from jsonb_array_elements(coalesce(active_schema->'models','[]'::jsonb)) item(value)
    where value->>'id' = model_id;
    if model is null then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'path',write_path || '.model_id','code','unknown_write_model',
        'message','write model_id `' || coalesce(model_id,'') || '` is not declared in the active schema'
      ));
    elsif coalesce(model->>'lifecycle','active')<>'active' then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'path',write_path || '.model_id','code','retired_write_model',
        'message','model `' || model_id || '` is retired and cannot accept new writes'
      ));
    end if;

    if write->>'effective_start' in ('-infinity','-262143-01-01') then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'path',write_path || '.effective_start','code','effective_start_underflow',
        'message','effective_start is too early to close a prior version range'
      ));
    end if;

    if has_record_key and record_key->>'type' = 'external_key'
      and btrim(coalesce(record_key->>'value','')) = ''
    then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'path',write_path || '.record_key','code','empty_external_key',
        'message','external record keys must not be empty'
      ));
    end if;
    if has_record_key and has_new_record_id then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'path',write_path || '.new_record_id','code','conflicting_write_subject',
        'message','writes must identify either an existing subject or a new record, not both'
      ));
    end if;

    tombstone := coalesce((write->>'tombstones_record')::boolean,false);
    values_json := write->'values';
    custom_fields_json := write->'custom_fields';
    clear_fields_json := coalesce(write->'clear_fields','[]'::jsonb);
    clear_custom_fields_json := coalesce(write->'clear_custom_fields','[]'::jsonb);
    metadata_patch_json := write->'metadata_patch';
    if tombstone then
      if has_new_record_id then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'path',write_path || '.new_record_id','code','new_record_tombstone_forbidden',
          'message','tombstone writes must identify an existing record'
        ));
      elsif not has_record_key then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'path',write_path || '.record_key','code','missing_record_event_key',
          'message','tombstone writes must identify an existing record'
        ));
      end if;
      if values_json is not null and values_json <> 'null'::jsonb then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'path',write_path || '.values','code','record_event_values_forbidden',
          'message','tombstone writes must not carry typed values'
        ));
      end if;
      if custom_fields_json is not null and custom_fields_json <> 'null'::jsonb then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'path',write_path || '.custom_fields','code','record_event_custom_fields_forbidden',
          'message','tombstone writes must not carry custom field values'
        ));
      end if;
      if jsonb_array_length(clear_fields_json)>0 then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'path',write_path || '.clear_fields','code','record_event_clear_fields_forbidden',
          'message','tombstone writes must not clear typed values'
        ));
      end if;
      if jsonb_array_length(clear_custom_fields_json)>0 then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'path',write_path || '.clear_custom_fields','code','record_event_clear_custom_fields_forbidden',
          'message','tombstone writes must not clear custom field values'
        ));
      end if;
      if metadata_patch_json is not null and metadata_patch_json<>'null'::jsonb then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'path',write_path || '.metadata_patch','code','record_event_metadata_patch_forbidden',
          'message','tombstone writes must not patch record metadata'
        ));
      end if;
      continue;
    end if;

    if (values_json is null or values_json = 'null'::jsonb)
      and (custom_fields_json is null or custom_fields_json = 'null'::jsonb)
      and jsonb_array_length(clear_fields_json)=0
      and jsonb_array_length(clear_custom_fields_json)=0
      and (metadata_patch_json is null or metadata_patch_json='null'::jsonb)
    then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'path',write_path || '.values','code','missing_values',
        'message','ordinary row-version writes must include values, custom_fields, clear fields, or metadata_patch'
      ));
    elsif (jsonb_typeof(values_json) is distinct from 'object' or values_json = '{}'::jsonb)
      and (jsonb_typeof(custom_fields_json) is distinct from 'array' or custom_fields_json = '[]'::jsonb)
      and jsonb_array_length(clear_fields_json)=0
      and jsonb_array_length(clear_custom_fields_json)=0
      and (metadata_patch_json is null or metadata_patch_json='null'::jsonb)
    then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'path',write_path || '.values','code','empty_values',
        'message','ordinary row-version writes must include at least one value, clear field, or metadata patch'
      ));
    else
      if model is not null and jsonb_typeof(values_json) = 'object' then
        for field_entry in select key,value from jsonb_each(values_json) order by key loop
          field_id := field_entry.key;
          typed_value := field_entry.value;
          if field_id='__lookup_lifecycle' then
            if model->>'kind'<>'lookup'
              or jsonb_typeof(typed_value)<>'object'
              or typed_value->>'type'<>'schema_lifecycle'
              or typed_value->>'value' not in ('active','retired')
            then
              issues := issues || jsonb_build_array(jsonb_build_object(
                'path',write_path || '.values.' || field_id,'code','invalid_lookup_lifecycle_value',
                'message','the reserved lookup lifecycle value is valid only on lookup models and must use type schema_lifecycle'
              ));
            end if;
            continue;
          end if;
          select value into field
          from jsonb_array_elements(coalesce(model->'fields','[]'::jsonb)) item(value)
          where value->>'id' = field_id;
          if field is null then
            select value into many_relation
            from jsonb_array_elements(coalesce(model->'many_relations','[]'::jsonb)) item(value)
            where value->>'id'=field_id;
            if many_relation is not null then
              if coalesce(many_relation->>'lifecycle','active')<>'active' then
                issues := issues || jsonb_build_array(jsonb_build_object(
                  'path',write_path || '.values.' || field_id,'code','retired_many_relation',
                  'message','many relation `' || field_id || '` is retired and cannot accept new values'
                ));
              elsif jsonb_typeof(typed_value)<>'object'
                or typed_value->>'type'<>'relation_list'
                or jsonb_typeof(typed_value->'value')<>'array'
                or exists(
                  select 1 from jsonb_array_elements(coalesce(typed_value->'value','[]'::jsonb)) target(value)
                  where jsonb_typeof(value)<>'object'
                    or value->>'type' not in ('record_id','external_key')
                    or jsonb_typeof(value->'value')<>'string'
                    or btrim(value->>'value')=''
                )
              then
                issues := issues || jsonb_build_array(jsonb_build_object(
                  'path',write_path || '.values.' || field_id,'code','many_relation_value_type_mismatch',
                  'message','many relation `' || field_id || '` must use a relation_list value'
                ));
              elsif exists(
                select 1 from jsonb_array_elements(coalesce(active_schema->'models','[]'::jsonb)) target(value)
                where value->>'id'=many_relation->>'target_model'
                  and coalesce(value->>'lifecycle','active')<>'active'
              ) then
                issues := issues || jsonb_build_array(jsonb_build_object(
                  'path',write_path || '.values.' || field_id,'code','retired_relation_target_model',
                  'message','many relation `' || field_id || '` targets a retired model and cannot accept new values'
                ));
              end if;
              continue;
            end if;
            issues := issues || jsonb_build_array(jsonb_build_object(
              'path',write_path || '.values.' || field_id,'code','unknown_write_field',
              'message','field `' || field_id || '` is not declared on model `' || model_id || '`'
            ));
            continue;
          end if;
          if coalesce(field->>'lifecycle','active')<>'active' then
            issues := issues || jsonb_build_array(jsonb_build_object(
              'path',write_path || '.values.' || field_id,'code','retired_write_field',
              'message','field `' || field_id || '` is retired and cannot accept new values'
            ));
            continue;
          end if;
          field_type := field->>'type';
          issue_code := kernel_apply_field_value_issue(field_type, field->'option_set', typed_value);
          if issue_code = 'type_mismatch' then issue_code := 'field_value_type_mismatch'; end if;
          if issue_code is not null then
            issue_message := case issue_code
              when 'unknown_enum_option' then 'enum option `' || (typed_value->>'value') || '` is not active for field `' || field_id || '`'
              when 'retired_enum_option' then 'enum option `' || (typed_value->>'value') || '` is not active for field `' || field_id || '`'
              else 'field `' || field_id || '` value does not match declared type'
            end;
            issues := issues || jsonb_build_array(jsonb_build_object(
              'path',write_path || '.values.' || field_id,'code',issue_code,'message',issue_message
            ));
            continue;
          end if;
          if field_type = 'text' and coalesce((field->>'is_unique')::boolean,false)
            and btrim(typed_value->>'value') = ''
          then
            issues := issues || jsonb_build_array(jsonb_build_object(
              'path',write_path || '.values.' || field_id,'code','blank_unique_text_value',
              'message','unique text fields must be omitted instead of supplied as blank text'
            ));
          end if;
          if field_type='relation' and exists(
            select 1 from jsonb_array_elements(coalesce(active_schema->'models','[]'::jsonb)) target(value)
            where value->>'id'=field->>'target_model' and coalesce(value->>'lifecycle','active')<>'active'
          ) then
            issues := issues || jsonb_build_array(jsonb_build_object(
              'path',write_path || '.values.' || field_id,'code','retired_relation_target_model',
              'message','relation field `' || field_id || '` targets a retired model and cannot accept new values'
            ));
          end if;
        end loop;
      end if;

      if jsonb_typeof(custom_fields_json) = 'array' then
        if jsonb_array_length(custom_fields_json)>0
          and not coalesce((model#>>'{extensions,typed_custom_fields}')::boolean,false)
        then
          issues := issues || jsonb_build_array(jsonb_build_object(
            'path',write_path || '.custom_fields','code','custom_fields_not_enabled',
            'message','typed custom fields are not enabled for this model'
          ));
        end if;
        seen_custom := '{}'::jsonb;
        for custom_entry, custom_index in
          select value,ordinal - 1
          from jsonb_array_elements(custom_fields_json) with ordinality item(value,ordinal)
        loop
          if jsonb_typeof(custom_entry) <> 'object' or jsonb_typeof(custom_entry->'field_id') <> 'string' then
            continue;
          end if;
          field_id := custom_entry->>'field_id';
          custom_path := write_path || '.custom_fields[' || custom_index || ']';
          duplicate_custom := seen_custom ? field_id;
          seen_custom := seen_custom || jsonb_build_object(field_id,true);
          if duplicate_custom then
            issues := issues || jsonb_build_array(jsonb_build_object(
              'path',custom_path || '.field_id','code','duplicate_custom_field_value',
              'message','custom field `' || field_id || '` is duplicated in the write'
            ));
          end if;

          select value into custom_definition
          from jsonb_array_elements(coalesce(active_schema->'custom_fields','[]'::jsonb)) definition(value)
          where value->>'model_id' = model_id
            and value->>'field_id' = field_id
            and coalesce(value->>'lifecycle','active') = 'active';
          if custom_definition is null then
            if exists(
              select 1 from jsonb_array_elements(coalesce(active_schema->'custom_fields','[]'::jsonb)) definition(value)
              where value->>'model_id' = model_id and value->>'field_id' = field_id
                and coalesce(value->>'lifecycle','active') = 'retired'
            ) then
              issue_code := 'archived_custom_field';
              issue_message := 'custom field `' || field_id || '` is archived';
            elsif exists(
              select 1 from jsonb_array_elements(coalesce(active_schema->'custom_fields','[]'::jsonb)) definition(value)
              where value->>'field_id' = field_id and coalesce(value->>'lifecycle','active') = 'active'
            ) then
              issue_code := 'wrong_model_custom_field';
              issue_message := 'custom field `' || field_id || '` is not declared on model `' || model_id || '`';
            else
              issue_code := 'unknown_custom_field';
              issue_message := 'custom field `' || field_id || '` is not declared';
            end if;
            issues := issues || jsonb_build_array(jsonb_build_object(
              'path',custom_path || '.field_id','code',issue_code,'message',issue_message
            ));
            continue;
          end if;

          if coalesce(custom_definition->'expression','null'::jsonb) <> 'null'::jsonb then
            issues := issues || jsonb_build_array(jsonb_build_object(
              'path',custom_path || '.field_id','code','derived_field_read_only',
              'message','custom field `' || field_id || '` is derived and read-only'
            ));
            continue;
          end if;
          typed_value := custom_entry - 'field_id';
          field_type := custom_definition->>'type';
          issue_code := case kernel_apply_field_value_issue(field_type, custom_definition->'option_set', typed_value)
            when 'type_mismatch' then 'custom_field_value_type_mismatch'
            when 'unknown_enum_option' then 'unknown_custom_enum_option'
            when 'retired_enum_option' then 'retired_custom_enum_option' end;
          if issue_code is not null then
            null;
          elsif field_type='relation' and exists(
            select 1 from jsonb_array_elements(coalesce(active_schema->'models','[]'::jsonb)) target(value)
            where value->>'id'=custom_definition->>'target_model_id'
              and coalesce(value->>'lifecycle','active')<>'active'
          ) then
            issue_code := 'retired_relation_target_model';
          end if;
          if issue_code is not null then
            issue_message := case issue_code
              when 'unknown_custom_enum_option' then 'custom enum option `' || (typed_value->>'value') || '` is not active for custom field `' || field_id || '`'
              when 'retired_custom_enum_option' then 'custom enum option `' || (typed_value->>'value') || '` is not active for custom field `' || field_id || '`'
              when 'retired_relation_target_model' then 'custom relation field `' || field_id || '` targets a retired model and cannot accept new values'
              else 'custom field `' || field_id || '` value does not match declared type'
            end;
            issues := issues || jsonb_build_array(jsonb_build_object(
              'path',custom_path || '.value','code',issue_code,'message',issue_message
            ));
          end if;
        end loop;
      end if;
    end if;

    seen_clear := '{}'::jsonb;
    if jsonb_array_length(clear_custom_fields_json)>0
      and not coalesce((model#>>'{extensions,typed_custom_fields}')::boolean,false)
    then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'path',write_path || '.clear_custom_fields','code','custom_fields_not_enabled',
        'message','typed custom fields are not enabled for this model'
      ));
    end if;
    for field_id, custom_index in
      select value,ordinal-1 from jsonb_array_elements_text(clear_fields_json) with ordinality item(value,ordinal)
    loop
      if seen_clear ? field_id then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'path',write_path || '.clear_fields[' || custom_index || ']','code','duplicate_clear_field',
          'message','clear_fields contains a duplicate field'
        ));
      end if;
      seen_clear := seen_clear || jsonb_build_object(field_id,true);
      if jsonb_typeof(values_json)='object' and values_json ? field_id then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'path',write_path || '.clear_fields[' || custom_index || ']','code','set_and_clear_field',
          'message','a field cannot be set and cleared in the same write'
        ));
      end if;
      if field_id='__lookup_lifecycle' then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'path',write_path || '.clear_fields[' || custom_index || ']','code','lookup_lifecycle_clear_forbidden',
          'message','lookup lifecycle must be set to active or retired and cannot be cleared'
        ));
        continue;
      end if;
      select value into field from jsonb_array_elements(coalesce(model->'fields','[]'::jsonb)) item(value)
      where value->>'id'=field_id;
      if field is null then
        select value into many_relation
        from jsonb_array_elements(coalesce(model->'many_relations','[]'::jsonb)) item(value)
        where value->>'id'=field_id;
        if many_relation is null then
          issues := issues || jsonb_build_array(jsonb_build_object(
            'path',write_path || '.clear_fields[' || custom_index || ']','code','unknown_clear_field',
            'message','field `' || field_id || '` is not declared on model `' || model_id || '`'
          ));
        elsif coalesce(many_relation->>'lifecycle','active')<>'active' then
          issues := issues || jsonb_build_array(jsonb_build_object(
            'path',write_path || '.clear_fields[' || custom_index || ']','code','retired_many_relation_clear',
            'message','retired many relation `' || field_id || '` cannot be cleared'
          ));
        end if;
      elsif coalesce((field->>'required')::boolean,false) then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'path',write_path || '.clear_fields[' || custom_index || ']','code','required_field_clear',
          'message','required field `' || field_id || '` cannot be cleared'
        ));
      elsif coalesce(field->>'lifecycle','active')<>'active' then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'path',write_path || '.clear_fields[' || custom_index || ']','code','retired_field_clear',
          'message','retired field `' || field_id || '` cannot be cleared'
        ));
      end if;
    end loop;

    seen_clear := '{}'::jsonb;
    for field_id, custom_index in
      select value,ordinal-1 from jsonb_array_elements_text(clear_custom_fields_json) with ordinality item(value,ordinal)
    loop
      if seen_clear ? field_id then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'path',write_path || '.clear_custom_fields[' || custom_index || ']','code','duplicate_clear_custom_field',
          'message','clear_custom_fields contains a duplicate field'
        ));
      end if;
      seen_clear := seen_clear || jsonb_build_object(field_id,true);
      if jsonb_typeof(custom_fields_json)='array' and exists(
        select 1 from jsonb_array_elements(custom_fields_json) entry(value) where value->>'field_id'=field_id
      ) then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'path',write_path || '.clear_custom_fields[' || custom_index || ']','code','set_and_clear_custom_field',
          'message','a custom field cannot be set and cleared in the same write'
        ));
      end if;
      if exists(
        select 1 from jsonb_array_elements(coalesce(active_schema->'custom_fields','[]'::jsonb)) definition(value)
        where value->>'model_id'=model_id and value->>'field_id'=field_id
          and coalesce(value->>'lifecycle','active')='active'
          and coalesce(value->'expression','null'::jsonb) <> 'null'::jsonb
      ) then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'path',write_path || '.clear_custom_fields[' || custom_index || ']','code','derived_field_read_only',
          'message','custom field `' || field_id || '` is derived and read-only'
        ));
      elsif not exists(
        select 1 from jsonb_array_elements(coalesce(active_schema->'custom_fields','[]'::jsonb)) definition(value)
        where value->>'model_id'=model_id and value->>'field_id'=field_id
          and coalesce(value->>'lifecycle','active')='active'
      ) then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'path',write_path || '.clear_custom_fields[' || custom_index || ']','code','unknown_clear_custom_field',
          'message','active custom field `' || field_id || '` is not declared on model `' || model_id || '`'
        ));
      end if;
    end loop;

    if metadata_patch_json is not null and metadata_patch_json<>'null'::jsonb then
      if model#>'{extensions,record_metadata}' is null or model#>'{extensions,record_metadata}'='null'::jsonb then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'path',write_path || '.metadata_patch','code','record_metadata_not_enabled',
          'message','record metadata is not enabled for this model'
        ));
      elsif jsonb_typeof(metadata_patch_json)='object'
        and not coalesce((metadata_patch_json->>'clear')::boolean,false)
        and coalesce(metadata_patch_json->'set','{}'::jsonb)='{}'::jsonb
        and coalesce(metadata_patch_json->'remove','[]'::jsonb)='[]'::jsonb
      then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'path',write_path || '.metadata_patch','code','empty_metadata_patch',
          'message','metadata_patch must set, remove, or clear metadata'
        ));
      end if;
    end if;

  end loop;
  return issues;
end;
$kernel_apply$;
"#;

const UNIQUE_FAIL_SQL: &str = r#"
create or replace function kernel_apply_unique_fail(model_id text, field_id text, field_value text)
returns void
language plpgsql
volatile
security invoker
set search_path from current
as $kernel_apply$
declare envelope jsonb;
begin
  envelope := jsonb_build_object(
    'code','unique_field_conflict',
    'message','Unique field value already exists',
    'details',jsonb_build_array(
      jsonb_build_object('path','model','code','unique_field_conflict','message',model_id),
      jsonb_build_object('path','field','code','unique_field_conflict','message',field_id),
      jsonb_build_object('path','value','code','unique_field_conflict','message',field_value)
    )
  );
  raise exception using errcode='P0001',message='kernel_apply:' || envelope::text;
end;
$kernel_apply$;
"#;

const TYPED_VALUE_VALID_SQL: &str = r#"
create or replace function kernel_apply_typed_value_valid(typed_value jsonb, expected_type text)
returns boolean
language plpgsql
immutable
security invoker
set search_path from current
as $kernel_apply$
declare
  payload jsonb;
  scalar text;
  parsed_number numeric;
  parsed_date date;
  parsed_datetime timestamptz;
begin
  if jsonb_typeof(typed_value) <> 'object'
    or not (typed_value ?& array['type','value'])
    or typed_value - array['type','value'] <> '{}'::jsonb
    or typed_value->>'type' is distinct from expected_type
  then
    return false;
  end if;

  payload := typed_value->'value';
  if expected_type in ('text','enum') then
    return jsonb_typeof(payload) = 'string';
  elsif expected_type = 'number' then
    if jsonb_typeof(payload) <> 'string' then return false; end if;
    scalar := payload #>> '{}';
    if scalar !~ '^[+-]?[0-9][0-9_]*([.][0-9_]+)?([eE][+-]?[0-9]+)?$' then return false; end if;
    scalar := replace(scalar, '_', '');
    begin parsed_number := scalar::numeric;
    exception when others then return false;
    end;
    return scale(parsed_number) <= 28
      and abs(parsed_number) <= 79228162514264337593543950335::numeric;
  elsif expected_type = 'bool' then
    return jsonb_typeof(payload) = 'boolean';
  elsif expected_type = 'date' then
    if jsonb_typeof(payload) <> 'string' then return false; end if;
    scalar := payload #>> '{}';
    if scalar !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return false; end if;
    begin parsed_date := scalar::date;
    exception when others then return false;
    end;
    return to_char(parsed_date, 'YYYY-MM-DD') = scalar;
  elsif expected_type = 'datetime' then
    if jsonb_typeof(payload) <> 'string' then return false; end if;
    scalar := payload #>> '{}';
    if scalar !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$' then
      return false;
    end if;
    begin parsed_datetime := scalar::timestamptz;
    exception when others then return false;
    end;
    return parsed_datetime is not null and isfinite(parsed_datetime);
  elsif expected_type = 'text_list' then
    return jsonb_typeof(payload) = 'array'
      and not exists (
        select 1 from jsonb_array_elements(payload) item(value)
        where jsonb_typeof(value) <> 'string'
      );
  elsif expected_type = 'json' then
    return true;
  elsif expected_type = 'relation' then
    if jsonb_typeof(payload) <> 'object'
      or not (payload ?& array['type','value'])
      or payload - array['type','value'] <> '{}'::jsonb
      or jsonb_typeof(payload->'value') <> 'string'
      or payload->>'type' not in ('record_id','external_key')
    then
      return false;
    end if;
    if payload->>'type' = 'external_key' then
      return btrim(payload->>'value') <> '';
    end if;
    begin perform (payload->>'value')::uuid;
    exception when others then return false;
    end;
    return true;
  elsif expected_type = 'money_rate' then
    if jsonb_typeof(payload) <> 'object'
      or not (payload ?& array['amount','currency','period'])
      or payload - array['amount','currency','period'] <> '{}'::jsonb
      or jsonb_typeof(payload->'amount') <> 'string'
      or jsonb_typeof(payload->'currency') <> 'string'
      or jsonb_typeof(payload->'period') <> 'string'
      or payload->>'period' not in ('hourly','daily','weekly','monthly','annual')
    then
      return false;
    end if;
    scalar := payload->>'amount';
    if scalar !~ '^[+-]?[0-9][0-9_]*([.][0-9_]+)?([eE][+-]?[0-9]+)?$' then return false; end if;
    scalar := replace(scalar, '_', '');
    begin parsed_number := scalar::numeric;
    exception when others then return false;
    end;
    return scale(parsed_number) <= 28
      and abs(parsed_number) <= 79228162514264337593543950335::numeric;
  end if;
  return false;
end;
$kernel_apply$;
"#;

const METADATA_VALID_SQL: &str = r#"
create or replace function kernel_apply_metadata_valid(metadata jsonb, limits jsonb)
returns boolean
language plpgsql
immutable
security invoker
set search_path from current
as $kernel_apply$
declare
  key_count bigint;
begin
  if jsonb_typeof(metadata)<>'object' or jsonb_typeof(limits)<>'object' then return false; end if;
  if octet_length(metadata::text)>coalesce((limits->>'max_bytes')::bigint,0) then return false; end if;
  with recursive nodes(value,depth) as (
    select metadata,-1
    union all
    select child.value,nodes.depth+1
    from nodes
    cross join lateral (
      select value from jsonb_each(case when jsonb_typeof(nodes.value)='object' then nodes.value else '{}'::jsonb end)
      union all
      select value from jsonb_array_elements(case when jsonb_typeof(nodes.value)='array' then nodes.value else '[]'::jsonb end)
    ) child
  )
  select coalesce(sum((
    select count(*)
    from jsonb_object_keys(case when jsonb_typeof(nodes.value)='object' then nodes.value else '{}'::jsonb end)
  )),0)
  into key_count from nodes;
  if key_count>coalesce((limits->>'max_keys')::bigint,0) then return false; end if;
  if exists(
    with recursive nodes(value,depth) as (
      select metadata,-1
      union all
      select child.value,nodes.depth+1
      from nodes
      cross join lateral (
        select value from jsonb_each(case when jsonb_typeof(nodes.value)='object' then nodes.value else '{}'::jsonb end)
        union all
        select value from jsonb_array_elements(case when jsonb_typeof(nodes.value)='array' then nodes.value else '[]'::jsonb end)
      ) child
    )
    select 1 from nodes
    where depth>coalesce((limits->>'max_depth')::integer,0)
      or (jsonb_typeof(value)='array' and jsonb_array_length(value)>coalesce((limits->>'max_array_items')::integer,0))
      or (jsonb_typeof(value) not in ('array','object') and
          octet_length(case when jsonb_typeof(value)='string' then value#>>'{}' else value::text end)>
            coalesce((limits->>'max_scalar_bytes')::integer,0))
  ) then return false; end if;
  if exists(
    with recursive objects(value) as (
      select metadata
      union all
      select child.value from objects
      cross join lateral (
        select value from jsonb_each(case when jsonb_typeof(objects.value)='object' then objects.value else '{}'::jsonb end)
        union all
        select value from jsonb_array_elements(case when jsonb_typeof(objects.value)='array' then objects.value else '[]'::jsonb end)
      ) child
    )
    select 1 from objects
    cross join lateral jsonb_object_keys(case when jsonb_typeof(objects.value)='object' then objects.value else '{}'::jsonb end) key
    where btrim(key)='' or octet_length(key)>coalesce((limits->>'max_key_bytes')::integer,0)
  ) then return false; end if;
  return true;
exception when others then return false;
end;
$kernel_apply$;
"#;

const METADATA_PATCH_SQL: &str = r#"
create or replace function kernel_apply_metadata_patch(
  previous_metadata jsonb,
  patch jsonb,
  model jsonb,
  write_path text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path from current
as $kernel_apply$
declare
  limits jsonb := model#>'{extensions,record_metadata}';
  result jsonb := coalesce(previous_metadata,'{}'::jsonb);
  set_values jsonb;
  remove_values jsonb;
  remove_key text;
begin
  if patch is null or patch='null'::jsonb then
    if limits is null or limits='null'::jsonb then
      if result<>'{}'::jsonb then
        perform kernel_apply_fail('schema_drift','Schema drift detected',write_path,'record_metadata_not_enabled','stored record metadata exists on a model that does not enable metadata');
      end if;
      return result;
    end if;
    if not kernel_apply_metadata_valid(result,limits) then
      perform kernel_apply_fail('contract_validation_failed','Contract validation failed',write_path,'record_metadata_limits_exceeded','record metadata exceeds the model limits');
    end if;
    return result;
  end if;
  if limits is null or limits='null'::jsonb then
    perform kernel_apply_fail('contract_validation_failed','Contract validation failed',write_path,'record_metadata_not_enabled','record metadata is not enabled for this model');
  end if;
  if jsonb_typeof(patch)<>'object' or patch-array['clear','set','remove']<>'{}'::jsonb
    or (patch ? 'clear' and jsonb_typeof(patch->'clear')<>'boolean')
    or (patch ? 'set' and jsonb_typeof(patch->'set')<>'object')
    or (patch ? 'remove' and jsonb_typeof(patch->'remove')<>'array')
  then
    perform kernel_apply_fail('serialization_error','Kernel serialization failed');
  end if;
  set_values := coalesce(patch->'set','{}'::jsonb);
  remove_values := coalesce(patch->'remove','[]'::jsonb);
  if exists(select 1 from jsonb_array_elements(remove_values) item(value) where jsonb_typeof(value)<>'string') then
    perform kernel_apply_fail('serialization_error','Kernel serialization failed');
  end if;
  if not coalesce((patch->>'clear')::boolean,false) and set_values='{}'::jsonb and remove_values='[]'::jsonb then
    perform kernel_apply_fail('contract_validation_failed','Contract validation failed',write_path,'empty_metadata_patch','metadata_patch must set, remove, or clear metadata');
  end if;
  if exists(
    select 1 from jsonb_array_elements_text(remove_values) item(value)
    group by value having count(*)>1
  ) then
    perform kernel_apply_fail('contract_validation_failed','Contract validation failed',write_path || '.remove','duplicate_metadata_remove','metadata remove keys must be unique');
  end if;
  if exists(select 1 from jsonb_array_elements_text(remove_values) item(value) where set_values ? value) then
    perform kernel_apply_fail('contract_validation_failed','Contract validation failed',write_path || '.remove','set_and_remove_metadata_key','a metadata key cannot be set and removed in the same patch');
  end if;
  if coalesce((patch->>'clear')::boolean,false) then result := '{}'::jsonb; end if;
  for remove_key in select value from jsonb_array_elements_text(remove_values) item(value) loop
    result := result-remove_key;
  end loop;
  result := result || set_values;
  if not kernel_apply_metadata_valid(result,limits) then
    perform kernel_apply_fail('contract_validation_failed','Contract validation failed',write_path,'record_metadata_limits_exceeded','record metadata exceeds the model limits');
  end if;
  return result;
end;
$kernel_apply$;
"#;

const SNAPSHOT_SQL: &str = r#"
create or replace function kernel_apply_snapshot(row_json jsonb, model jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path from current
as $kernel_apply$
declare
  result jsonb := '{}'::jsonb;
  field jsonb;
  field_id text;
  field_type text;
  identifier text;
  scalar jsonb;
begin
  if row_json is null then
    return result;
  end if;
  if model->>'kind' = 'lookup' then
    if jsonb_typeof(row_json->'values') = 'object' then
      return row_json->'values';
    end if;
    return result;
  end if;
  for field in select value from jsonb_array_elements(coalesce(model->'fields', '[]'::jsonb)) loop
    field_id := field->>'id';
    field_type := field->>'type';
    identifier := kernel_apply_identifier(field_id);
    if field_type = 'money_rate' then
      if row_json->(identifier || '_amount') is not null and row_json->(identifier || '_amount') <> 'null'::jsonb then
        result := result || jsonb_build_object(field_id, jsonb_build_object(
          'type', 'money_rate',
          'value', jsonb_build_object(
            'amount', row_json->>(identifier || '_amount'),
            'currency', row_json->>(identifier || '_currency'),
            'period', row_json->>(identifier || '_period')
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
      result := result || jsonb_build_object(field_id, jsonb_build_object('type', 'text', 'value', scalar));
    elsif field_type = 'number' then
      result := result || jsonb_build_object(field_id, jsonb_build_object('type', 'number', 'value', scalar #>> '{}'));
    elsif field_type = 'bool' then
      result := result || jsonb_build_object(field_id, jsonb_build_object('type', 'bool', 'value', scalar));
    elsif field_type = 'date' then
      result := result || jsonb_build_object(field_id, jsonb_build_object('type', 'date', 'value', scalar));
    elsif field_type = 'datetime' then
      result := result || jsonb_build_object(field_id, jsonb_build_object('type', 'datetime', 'value', scalar));
    elsif field_type = 'relation' then
      result := result || jsonb_build_object(field_id, jsonb_build_object(
        'type', 'relation', 'value', jsonb_build_object('type', 'record_id', 'value', scalar)
      ));
    elsif field_type in ('text_list', 'known_aliases') then
      result := result || jsonb_build_object(field_id, jsonb_build_object('type', 'text_list', 'value', scalar));
    elsif field_type = 'json' then
      result := result || jsonb_build_object(field_id, jsonb_build_object('type', 'json', 'value', scalar));
    elsif field_type = 'enum' then
      result := result || jsonb_build_object(field_id, jsonb_build_object('type', 'enum', 'value', scalar));
    end if;
  end loop;
  return result;
end;
$kernel_apply$;
"#;

const VALIDATE_LOOKUP_ALIAS_RESERVATIONS_SQL: &str = r#"
create or replace function kernel_apply_validate_lookup_alias_reservations(
  requested_app_id text,
  requested_customer_id text,
  requested_model_id text,
  requested_record_id uuid,
  model jsonb,
  snapshot jsonb,
  alias_transfer jsonb
)
returns void
language plpgsql
volatile
security invoker
set search_path from current
as $kernel_apply$
declare
  storage_authority text;
  display_field_id text := coalesce(model->>'display_field_id','name');
  field jsonb;
  field_id text;
  field_type text;
  candidate_kind text;
  candidate_alias text;
  candidate_normalized text;
  candidate_ordinal integer;
  candidates jsonb := '[]'::jsonb;
  seen jsonb := '{}'::jsonb;
  active_owner uuid;
  reservation_owner uuid;
  transfer_allowed boolean;
begin
  select authority.authority into storage_authority
  from lookup_storage_authority authority
  where authority.app_id=requested_app_id
    and authority.customer_id=requested_customer_id
    and authority.model_id=requested_model_id;
  if storage_authority='typed' then return; end if;
  if jsonb_typeof(snapshot)<>'object' then return; end if;

  for field in
    select value from jsonb_array_elements(coalesce(model->'fields','[]'::jsonb)) item(value)
    where value->>'id'=display_field_id or value->>'type'='known_aliases'
    order by value->>'id'
  loop
    field_id:=field->>'id';
    field_type:=field->>'type';
    if field_id=display_field_id then
      if field_type<>'text' or snapshot->field_id is null then continue; end if;
      candidates:=candidates || jsonb_build_array(jsonb_build_object(
        'kind','display','field_id',field_id,'ordinal',0,
        'alias',snapshot#>>array[field_id,'value']
      ));
    elsif field_type='known_aliases' and jsonb_typeof(snapshot#>array[field_id,'value'])='array' then
      for candidate_alias,candidate_ordinal in
        select value,ordinal-1
        from jsonb_array_elements_text(snapshot#>array[field_id,'value']) with ordinality item(value,ordinal)
      loop
        candidates:=candidates || jsonb_build_array(jsonb_build_object(
          'kind','alias','field_id',field_id,'ordinal',candidate_ordinal,'alias',candidate_alias
        ));
      end loop;
    end if;
  end loop;

  for field in select value from jsonb_array_elements(candidates) item(value) loop
    candidate_kind:=field->>'kind';
    field_id:=field->>'field_id';
    candidate_alias:=field->>'alias';
    candidate_normalized:=kernel_apply_normalize_lookup_label(candidate_alias);
    if candidate_normalized is null then
      perform kernel_apply_fail(
        'contract_validation_failed','Contract validation failed',
        'values.' || field_id,'empty_lookup_alias','lookup labels and aliases must not be blank'
      );
    end if;
    if seen ? candidate_normalized then
      perform kernel_apply_fail(
        'lookup_alias_collision','Lookup alias collision','values.' || field_id,
        'duplicate_lookup_alias','display labels and known aliases must be normalized-unique within a lookup record'
      );
    end if;
    seen:=seen || jsonb_build_object(candidate_normalized,true);

    -- Display labels retain effective-dated lookup semantics. The active unique
    -- projection index prevents concurrent display collisions; permanent
    -- ownership and explicit transfer apply only to known aliases.
    if candidate_kind='display' then continue; end if;

    select projection.record_id into active_owner
    from lookup_alias_projection projection
    where projection.app_id=requested_app_id
      and projection.customer_id=requested_customer_id
      and projection.model_id=requested_model_id
      and projection.normalized_alias=candidate_normalized
      and projection.is_current
    order by projection.record_id
    limit 1;

    select projection.record_id into reservation_owner
    from lookup_alias_projection projection
    join lookup_version version
      on version.app_id=projection.app_id and version.customer_id=projection.customer_id
     and version.model_id=projection.model_id and version.id=projection.version_id
    join change_set changes
      on changes.id=version.change_set_id and changes.app_id=version.app_id
     and changes.customer_id=version.customer_id
    where projection.app_id=requested_app_id
      and projection.customer_id=requested_customer_id
      and projection.model_id=requested_model_id
      and projection.normalized_alias=candidate_normalized
      and version.stage='mainline' and changes.status='mainline'
      and changes.applied_order is not null
    order by changes.applied_order desc,version.effective_start desc,version.id desc,
      projection.kind,projection.ordinal
    limit 1;

    transfer_allowed:=candidate_kind='alias'
      and alias_transfer is not null
      and alias_transfer->>'app_id'=requested_app_id
      and alias_transfer->>'customer_id'=requested_customer_id
      and alias_transfer->>'model_id'=requested_model_id
      and (alias_transfer->>'target_record_id')::uuid=requested_record_id
      and alias_transfer->>'field_id'=field_id
      and alias_transfer->>'normalized_alias'=candidate_normalized
      and reservation_owner is not null
      and (alias_transfer->>'source_record_id')::uuid=reservation_owner;

    if active_owner is not null and active_owner<>requested_record_id
       and not (transfer_allowed and active_owner=reservation_owner)
    then
      perform kernel_apply_fail(
        'lookup_alias_collision','Lookup alias collision','values.' || field_id,
        'lookup_alias_collision','normalized lookup alias `' || candidate_normalized || '` is active on another record'
      );
    end if;
    if reservation_owner is not null and reservation_owner<>requested_record_id
       and not transfer_allowed
    then
      perform kernel_apply_fail(
        'lookup_alias_reserved','Lookup alias is permanently reserved','values.' || field_id,
        'lookup_alias_reserved','normalized lookup alias `' || candidate_normalized || '` is reserved to another record'
      );
    end if;
  end loop;
end;
$kernel_apply$;
"#;

const PROJECT_LOOKUP_VERSION_SQL: &str = r#"
create or replace function kernel_apply_project_lookup_version_internal(
  projected_version_id uuid,
  projected_app_id text,
  projected_customer_id text,
  projected_model_id text,
  projected_record_id uuid,
  schema_json jsonb,
  model jsonb,
  snapshot jsonb,
  many_snapshot jsonb,
  projected_is_current boolean,
  alias_transfer jsonb
)
returns void
language plpgsql
volatile
security invoker
set search_path from current
as $kernel_apply$
declare
  field jsonb;
  field_id text;
  field_type text;
  typed_value jsonb;
  display_field_id text := coalesce(model->>'display_field_id','name');
  target_model jsonb;
  target_kind text;
  many_relation jsonb;
  many_relation_id text;
  target_record_id uuid;
  item text;
  item_ordinal integer;
begin
  perform kernel_apply_validate_lookup_alias_reservations(
    projected_app_id,projected_customer_id,projected_model_id,projected_record_id,
    model,snapshot,alias_transfer
  );
  delete from lookup_value_projection
  where app_id = projected_app_id and customer_id = projected_customer_id
    and model_id = projected_model_id and version_id = projected_version_id;
  delete from lookup_alias_projection
  where app_id = projected_app_id and customer_id = projected_customer_id
    and model_id = projected_model_id and version_id = projected_version_id;
  delete from lookup_relation_projection
  where app_id = projected_app_id and customer_id = projected_customer_id
    and source_model_id = projected_model_id and version_id = projected_version_id;
  if jsonb_typeof(snapshot) <> 'object' then return; end if;

  for field in
    select value from jsonb_array_elements(coalesce(model->'fields', '[]'::jsonb)) item(value)
  loop
    field_id := field->>'id';
    field_type := field->>'type';
    typed_value := snapshot->field_id;
    if typed_value is null or typed_value = 'null'::jsonb then continue; end if;

    insert into lookup_value_projection(
      version_id,app_id,customer_id,model_id,record_id,field_id,value_type,
      text_value,number_value,bool_value,date_value,datetime_value,json_value,text_list_value
    ) values (
      projected_version_id,projected_app_id,projected_customer_id,projected_model_id,
      projected_record_id,field_id,field_type,
      case when field_type in ('text','iso_country','iso_currency','enum') then typed_value->>'value' end,
      case when field_type='number' then (typed_value->>'value')::numeric
           when field_type='money_rate' then (typed_value#>>'{value,amount}')::numeric end,
      case when field_type='bool' then (typed_value->>'value')::boolean end,
      case when field_type='date' then (typed_value->>'value')::date end,
      case when field_type='datetime' then (typed_value->>'value')::timestamptz end,
      case when field_type in ('json','money_rate','relation') then typed_value->'value' end,
      case when field_type in ('text_list','known_aliases')
        then array(select jsonb_array_elements_text(typed_value->'value')) end
    );

    if field_id=display_field_id and field_type='text' then
      insert into lookup_alias_projection(
        version_id,app_id,customer_id,model_id,record_id,field_id,ordinal,kind,
        alias,normalized_alias,is_current
      ) values (
        projected_version_id,projected_app_id,projected_customer_id,projected_model_id,
        projected_record_id,field_id,0,'display',typed_value->>'value',
        kernel_apply_normalize_lookup_label(typed_value->>'value'),
        projected_is_current
      );
    end if;

    if field_type='known_aliases' then
      item_ordinal := 0;
      for item in select value from jsonb_array_elements_text(typed_value->'value') loop
        insert into lookup_alias_projection(
          version_id,app_id,customer_id,model_id,record_id,field_id,ordinal,kind,
          alias,normalized_alias,is_current
        ) values (
          projected_version_id,projected_app_id,projected_customer_id,projected_model_id,
          projected_record_id,field_id,item_ordinal,'alias',item,
          kernel_apply_normalize_lookup_label(item),
          projected_is_current
        );
        item_ordinal := item_ordinal + 1;
      end loop;
    elsif field_type='relation' then
      select value into target_model from jsonb_array_elements(schema_json->'models') item(value)
      where value->>'id'=field->>'target_model';
      target_kind := target_model->>'kind';
      insert into lookup_relation_projection(
        version_id,app_id,customer_id,source_model_id,source_record_id,field_id,
        relation_kind,ordinal,target_kind,target_model_id,target_record_id,
        lookup_target_model_id,lookup_target_record_id
      ) values (
        projected_version_id,projected_app_id,projected_customer_id,projected_model_id,
        projected_record_id,field_id,'scalar',0,target_kind,field->>'target_model',
        (typed_value#>>'{value,value}')::uuid,
        case when target_kind='lookup' then field->>'target_model' end,
        case when target_kind='lookup' then (typed_value#>>'{value,value}')::uuid end
      );
    end if;
  end loop;

  for many_relation in
    select value from jsonb_array_elements(coalesce(model->'many_relations','[]'::jsonb)) item(value)
  loop
    many_relation_id := many_relation->>'id';
    select value into target_model from jsonb_array_elements(schema_json->'models') item(value)
    where value->>'id'=many_relation->>'target_model';
    target_kind := target_model->>'kind';
    item_ordinal := 0;
    for item in
      select value from jsonb_array_elements_text(coalesce(many_snapshot->many_relation_id,'[]'::jsonb))
    loop
      target_record_id := item::uuid;
      insert into lookup_relation_projection(
        version_id,app_id,customer_id,source_model_id,source_record_id,field_id,
        relation_kind,ordinal,target_kind,target_model_id,target_record_id,
        lookup_target_model_id,lookup_target_record_id
      ) values (
        projected_version_id,projected_app_id,projected_customer_id,projected_model_id,
        projected_record_id,many_relation_id,'many',item_ordinal,target_kind,
        many_relation->>'target_model',target_record_id,
        case when target_kind='lookup' then many_relation->>'target_model' end,
        case when target_kind='lookup' then target_record_id end
      );
      item_ordinal := item_ordinal + 1;
    end loop;
  end loop;
end;
$kernel_apply$;

revoke all on function kernel_apply_project_lookup_version_internal(
  uuid,text,text,text,uuid,jsonb,jsonb,jsonb,jsonb,boolean,jsonb
) from public;
"#;

const PROJECT_LOOKUP_VERSION_WRAPPER_SQL: &str = r#"
create or replace function kernel_apply_project_lookup_version(
  projected_version_id uuid,
  projected_app_id text,
  projected_customer_id text,
  projected_model_id text,
  projected_record_id uuid,
  schema_json jsonb,
  model jsonb,
  snapshot jsonb,
  many_snapshot jsonb,
  projected_is_current boolean
)
returns void
language sql
volatile
security definer
set search_path from current
as $kernel_apply$
  select kernel_apply_project_lookup_version_internal(
    projected_version_id,projected_app_id,projected_customer_id,projected_model_id,
    projected_record_id,schema_json,model,snapshot,many_snapshot,projected_is_current,null
  )
$kernel_apply$;
"#;

const EXECUTE_SQL_TEMPLATE: &str = r#"
create or replace function kernel_apply_execute_internal(
  request jsonb,
  is_dry_run boolean,
  synthetic_order bigint,
  alias_transfer jsonb,
  installer_seed boolean
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path from current
as $kernel_apply$
<<apply_runtime>>
declare
  country_codes constant text[] := __KERNEL_COUNTRY_CODES__;
  currency_codes constant text[] := __KERNEL_CURRENCY_CODES__;
  app_id text;
  customer_id text;
  supplied_revision bigint;
  active_revision bigint;
  active_schema jsonb;
  source_kind text;
  source_ref text;
  idempotency_key text;
  change_type_id text;
  request_mode text;
  writes jsonb;
  original_writes jsonb;
  fingerprint text;
  existing record;
  change_type jsonb;
  subject_map jsonb := '{}'::jsonb;
  new_subject_map jsonb := '{}'::jsonb;
  lock_map jsonb := '{}'::jsonb;
  baseline_map jsonb := '{}'::jsonb;
  rechecked_map jsonb := '{}'::jsonb;
  write jsonb;
  write_index bigint;
  model jsonb;
  target_model jsonb;
  model_id text;
  is_lookup boolean;
  target_is_lookup boolean;
  model_identifier text;
  record_table text;
  version_table text;
  version_model_filter text;
  record_key jsonb;
  record_key_type text;
  record_key_value text;
  record_id uuid;
  candidate_id uuid;
  subject_key text;
  query_sql text;
  row_json jsonb;
  rechecked_json jsonb;
  relation_field jsonb;
  relation_value jsonb;
  target_model_id text;
  target_identifier text;
  target_record_table text;
  target_record_id uuid;
  target_key text;
  effective_start date;
  tombstone boolean;
  values_json jsonb;
  custom_fields_json jsonb;
  clear_fields_json jsonb;
  clear_custom_fields_json jsonb;
  metadata_patch_json jsonb;
  metadata_json jsonb;
  availability text;
  many_relations_json jsonb;
  clear_many_relations jsonb;
  many_relations_snapshot jsonb;
  draft_written jsonb := '{}'::jsonb;
  many_relation jsonb;
  many_relation_id text;
  many_relation_value jsonb;
  many_target jsonb;
  many_target_index bigint;
  field_entry record;
  field jsonb;
  field_id text;
  field_type text;
  expected_value_type text;
  typed_value jsonb;
  custom_entry jsonb;
  custom_definition jsonb;
  custom_index bigint;
  custom_by_id jsonb;
  custom_output jsonb;
  predecessor_json jsonb;
  predecessor_id uuid;
  predecessor_start date;
  predecessor_end date;
  predecessor_tombstone boolean;
  snapshot jsonb;
  next_start date;
  effective_end date;
  stage text;
  applied_at timestamptz;
  lifecycle_order bigint;
  change_set_id bigint;
  version_id uuid;
  expected_version_id uuid;
  insert_columns text;
  insert_values text;
  duplicate_count bigint;
  visible_json jsonb;
  planned_json jsonb;
  planned_visible boolean;
  projection_is_current boolean;
  duplicate_custom boolean;
  unique_conflict boolean;
  validation_issues jsonb;
  policy_snapshot jsonb;
  policy jsonb;
  policy_declared boolean := false;
  request_actor text;
  integration_actor_bound boolean := false;
  policy_fields jsonb;
  policy_old_values jsonb;
  policy_new_values jsonb;
  policy_operation text;
  interval_scope jsonb;
  interval_violation jsonb;
begin
  if request is null or jsonb_typeof(request) <> 'object' then
    perform kernel_apply_fail('contract_validation_failed', 'Contract validation failed', 'request', 'invalid_request', 'request must be a JSON object');
  end if;
  app_id := request->>'app_id';
  customer_id := request->>'customer_id';
  source_kind := request->>'source_kind';
  source_ref := request->>'source_ref';
  idempotency_key := request->>'idempotency_key';
  change_type_id := request->>'change_type_id';
  request_mode := request->>'mode';
  writes := request->'writes';
  original_writes := writes;
  if request ? 'schema_revision_id' and request->'schema_revision_id' <> 'null'::jsonb then
    begin supplied_revision := (request->>'schema_revision_id')::bigint;
    exception when others then
      perform kernel_apply_fail('contract_validation_failed', 'Contract validation failed', 'schema_revision_id', 'invalid_schema_revision_id', 'schema_revision_id must be positive when supplied');
    end;
    if supplied_revision <= 0 then
      perform kernel_apply_fail('contract_validation_failed', 'Contract validation failed', 'schema_revision_id', 'invalid_schema_revision_id', 'schema_revision_id must be positive when supplied');
    end if;
  end if;
  if app_id is null or btrim(app_id) = '' then
    perform kernel_apply_fail('contract_validation_failed', 'Contract validation failed', 'app_id', 'empty_scope_id', 'scope id must not be empty');
  end if;
  if customer_id is null or btrim(customer_id) = '' then
    perform kernel_apply_fail('contract_validation_failed', 'Contract validation failed', 'customer_id', 'empty_scope_id', 'scope id must not be empty');
  end if;
  if not kernel_principal_scope_authorized('runtime', app_id, customer_id, null) then
    perform kernel_apply_fail(
      'authorization_denied', 'Tenant scope is not authorized',
      'scope', 'tenant_scope_not_bound',
      'the authenticated database principal is not bound to the requested tenant and runtime capability'
    );
  end if;
  if source_kind is null or btrim(source_kind) = '' then
    perform kernel_apply_fail('contract_validation_failed', 'Contract validation failed', 'source_kind', 'empty_value', 'value must not be empty');
  end if;
  if source_kind = 'system' and not installer_seed then
    perform kernel_apply_fail('reserved_source_kind', 'Source kind is reserved for installer seeds', 'source_kind', 'reserved_source_kind', 'system');
  end if;
  if source_kind = 'revert' then
    perform kernel_apply_fail('reserved_source_kind', 'Source kind is reserved for a kernel API', 'source_kind', 'reserved_source_kind', 'revert');
  end if;
  if source_kind = 'agent' and (source_ref is null or btrim(source_ref) = '') then
    perform kernel_apply_fail('contract_validation_failed', 'Contract validation failed', 'source_ref', 'missing_agent_run_ref', 'agent writes must include source_ref pointing at an agent run');
  end if;
  if request_mode not in ('mainline', 'draft') then
    perform kernel_apply_fail('serialization_error', 'Kernel serialization failed');
  end if;
  if jsonb_typeof(coalesce(writes, 'null'::jsonb)) <> 'array' or jsonb_array_length(writes) = 0 then
    perform kernel_apply_fail('contract_validation_failed', 'Contract validation failed', 'writes', 'empty_writes', 'apply must include at least one write');
  end if;

  perform set_config('kernel.app_id', app_id, true);
  perform set_config('kernel.customer_id', customer_id, true);

  -- Source matching consumes durable provenance written through ordinary apply
  -- as well as the fixed ingestion bridge. Reserve its identity namespace here,
  -- before receipt replay, so a human writer cannot seed or poison that index.
  -- Existing trusted Rust ingestion may keep its canonical subjects/provenance;
  -- its actor must have the same administrator-provisioned service membership.
  if lower(btrim(source_kind)) ~ '^integration($|_)' or exists (
    select 1 from jsonb_array_elements(writes) item(value)
    where coalesce(item.value->'provenance','{}'::jsonb) ?| array[
      'source_record_ref','relation_source_record_refs','source_resolution_hash','source_input_hash',
      'match_policy','clear_policy','mapped_field_ids'
    ]
  ) then
    if request->>'actor_id' is distinct from nullif(current_setting('kernel.actor_id',true),'')
    then perform kernel_apply_fail('authorization_denied','Integration service identity is not authorized'); end if;
    select true into integration_actor_bound from kernel_actor_membership membership
      where membership.principal_name=session_user::name
        and membership.app_id=apply_runtime.app_id and membership.customer_id=apply_runtime.customer_id
        and membership.actor_id=request->>'actor_id' and membership.active
        and membership.actor_kind='service'
        and (nullif(current_setting('kernel.actor_role',true),'') is null or membership.role=current_setting('kernel.actor_role',true))
        and (nullif(current_setting('kernel.actor_fence_generation',true),'') is null or membership.fence_generation::text=current_setting('kernel.actor_fence_generation',true))
      order by membership.role limit 1 for share;
    if not coalesce(integration_actor_bound,false)
    then perform kernel_apply_fail('authorization_denied','Integration service identity is not authorized'); end if;
  end if;

  -- The first lookup only classifies legacy behavior. A declared policy must
  -- be reloaded under the activation lock before a receipt or write is authorized.
  policy_snapshot := kernel_policy_active_snapshot(app_id, customer_id);
  policy_declared := coalesce((policy_snapshot->>'declared')::boolean, false);
  policy := policy_snapshot->'policy';
  if policy_declared then
    if not pg_try_advisory_xact_lock_shared(hashtext(
      'postgres-schema:' || current_schema() || ':materialize-tenant:' || app_id || ':' || customer_id || ':schema-activation'
    )::bigint) then
      raise exception using errcode='40001', message='record apply dependency drift';
    end if;
    policy_snapshot := kernel_policy_active_snapshot(app_id, customer_id);
    policy_declared := coalesce((policy_snapshot->>'declared')::boolean, false);
    if not policy_declared then
      perform kernel_apply_fail('schema_drift', 'Schema drift detected', 'scope', 'policy_activation_drift', 'policy classification changed while acquiring activation authority');
    end if;
    policy := policy_snapshot->'policy';
    select id, schema into active_revision, active_schema
    from schema_revision where schema_revision.app_id = apply_runtime.app_id
      and schema_revision.customer_id = apply_runtime.customer_id
      and activated_at is not null;
    if active_revision is null then
      perform kernel_apply_fail('active_schema_missing', 'No active schema revision exists for this scope', 'scope', 'active_schema_missing', app_id || '/' || customer_id || ': materialize a schema before applying or reading records');
    end if;
  end if;

  -- Only the revoked installer executor can supply this flag; no request field or GUC can.
  -- Scopes that declare an authorization policy take canonical authority from
  -- the trusted principal/tenant/actor binding; policy-less scopes do not
  -- require one yet (binding every app's writers is follow-up ad.51.5).
  if policy_declared and not installer_seed then
    request_actor := kernel_policy_request_actor(app_id, customer_id);
    if nullif(request->>'actor_id', '') is distinct from request_actor then
      perform kernel_apply_fail(
        'authorization_denied', 'Request actor is not authorized',
        'actor_id', 'actor_binding_mismatch',
        'request actor_id must match the trusted actor binding'
      );
    end if;
    -- Source writers separately prove administrator-provisioned service authority
    -- at the reserved source-identity gate. Agents never acquire that authority,
    -- and a context marked as agent is an agent whatever its membership says.
    if (kernel_request_marked_agent() or not (coalesce(integration_actor_bound,false) and coalesce((
      select bool_and(m.actor_kind='service') from kernel_actor_membership m
      where m.principal_name=session_user::name and m.app_id=apply_runtime.app_id
        and m.customer_id=apply_runtime.customer_id and m.actor_id=request_actor and m.active
    ),false))) and kernel_request_is_agent(app_id, customer_id, request_actor) then
      if request_mode='mainline' then
        perform kernel_apply_fail(
          'authorization_denied', 'Mainline apply requires human authority',
          'mode', 'agent_mainline_forbidden', 'mainline apply requires human authority'
        );
      end if;
      if source_kind<>'agent' then
        perform kernel_apply_fail(
          'authorization_denied', 'Agent drafts require agent-run provenance',
          'source_kind', 'agent_provenance_required', 'agent drafts must use source_kind agent'
        );
      end if;
    end if;
  end if;
  if policy_declared and request_mode='draft' then
    perform kernel_apply_fail(
      'unsupported_capability', 'Policy-enabled writes support mainline changes only',
      'mode', 'unsupported_policy_lifecycle', request_mode
    );
  end if;

  -- Policy-enabled generated writes require an immutable record subject. This
  -- runs before idempotency lookup so unsupported low-level subjects cannot
  -- persist a receipt or reach replay mapping.
  if policy_declared and not installer_seed and exists (
    select 1
    from jsonb_array_elements(writes) write_value(value)
    where write_value.value->'record_key'->>'type' = 'external_key'
  ) then
    perform kernel_apply_fail(
      'unsupported_capability', 'Policy-enabled writes require immutable record subjects',
      'writes', 'unsupported_policy_subject_address',
      'use new_record_id for creates or record_id for existing policy-enabled writes'
    );
  end if;
  if policy_declared and not installer_seed and exists (
    select 1
    from jsonb_array_elements(writes) write_value(value)
    where jsonb_typeof(write_value.value->'values') = 'object'
      and write_value.value->'values' ? '__lookup_lifecycle'
  ) then
    perform kernel_apply_fail(
      'unsupported_capability', 'Policy-enabled writes do not support lookup lifecycle changes',
      'writes', 'unsupported_policy_lifecycle',
      'lookup lifecycle changes do not have a policy-safe write image'
    );
  end if;

  if idempotency_key is not null then
    perform pg_advisory_xact_lock(hashtext('idempotency:' || app_id || ':' || customer_id || ':' || idempotency_key)::bigint);
    select id, schema_revision_id, request_fingerprint into existing
    from change_set where change_set.app_id = apply_runtime.app_id
      and change_set.customer_id = apply_runtime.customer_id
      and change_set.idempotency_key = apply_runtime.idempotency_key;
    if found then
      if supplied_revision is not null and supplied_revision <> existing.schema_revision_id then
        perform kernel_apply_fail(
          'idempotency_conflict', 'Idempotency key was reused for a different request',
          'idempotency_key', 'idempotency_conflict',
          'Key `' || idempotency_key || '` was reused; use a new idempotency key or replay the exact equivalent request'
        );
      end if;
      fingerprint := kernel_canonical_json(jsonb_build_object(
        'app_id', app_id, 'customer_id', customer_id,
        'schema_revision_id', existing.schema_revision_id,
        'actor_id', request->'actor_id', 'source_kind', source_kind,
        'source_ref', request->'source_ref', 'idempotency_key', request->'idempotency_key',
        'change_type_id', request->'change_type_id', 'notes', request->'notes',
        'mode', request_mode, 'writes', writes
      ));
      if existing.request_fingerprint is distinct from fingerprint then
        perform kernel_apply_fail(
          'idempotency_conflict', 'Idempotency key was reused for a different request',
          'idempotency_key', 'idempotency_conflict',
          'Key `' || idempotency_key || '` was reused; use a new idempotency key or replay the exact equivalent request'
        );
      end if;
      if policy_declared and not installer_seed then
        perform kernel_apply_authorize_replay(existing.id, app_id, customer_id, request, policy, active_schema);
      end if;
      return jsonb_build_object('id', existing.id, 'schema_revision_id', existing.schema_revision_id);
    end if;
  end if;

  -- Legacy exact replays preserve their historical no-activation-lock path.
  -- Policy-enabled calls already resolved the active revision under that lock.
  if not policy_declared then
    if not pg_try_advisory_xact_lock_shared(hashtext(
      'postgres-schema:' || current_schema() || ':materialize-tenant:' || app_id || ':' || customer_id || ':schema-activation'
    )::bigint) then
      raise exception using errcode='40001', message='record apply dependency drift';
    end if;
    -- Activation may have completed after the initial legacy classification.
    -- Retry the whole request so the policy path authorizes before any write.
    policy_snapshot := kernel_policy_active_snapshot(app_id, customer_id);
    if coalesce((policy_snapshot->>'declared')::boolean, false) then
      raise exception using errcode='40001', message='record apply dependency drift';
    end if;
    select id, schema into active_revision, active_schema
    from schema_revision where schema_revision.app_id = apply_runtime.app_id
      and schema_revision.customer_id = apply_runtime.customer_id
      and activated_at is not null;
    if active_revision is null then
      perform kernel_apply_fail('active_schema_missing', 'No active schema revision exists for this scope', 'scope', 'active_schema_missing', app_id || '/' || customer_id || ': materialize a schema before applying or reading records');
    end if;
  end if;
  if supplied_revision is not null and supplied_revision <> active_revision then
    perform kernel_apply_fail(
      'stale_schema_revision', 'The supplied schema revision is not active',
      'schema_revision_id', 'stale_schema_revision',
      'Supplied schema_revision_id is ' || supplied_revision || '; active schema_revision_id is ' || active_revision
    );
  end if;
  if source_kind = 'agent' then
    select schema_revision_id into supplied_revision from agent_run
    where agent_run.app_id = apply_runtime.app_id
      and agent_run.customer_id = apply_runtime.customer_id
      and run_id = source_ref;
    if not found then
      perform kernel_apply_fail('agent_run_missing', 'agent run `' || source_ref || '` has not been recorded');
    end if;
    if supplied_revision <> active_revision then
      perform kernel_apply_fail(
        'agent_run_schema_mismatch',
        'agent run `' || source_ref || '` was recorded against schema_revision_id `' || supplied_revision || '` but active schema_revision_id is `' || active_revision || '`'
      );
    end if;
  end if;
  if change_type_id is not null then
    select value into change_type from jsonb_array_elements(coalesce(active_schema->'change_types', '[]'::jsonb)) item(value)
    where value->>'id' = change_type_id;
  end if;

  request := kernel_apply_prepare_lookup_or_create(request,active_schema);
  writes := request->'writes';

  validation_issues := kernel_apply_validation_issues(request,active_schema);
  if jsonb_array_length(validation_issues) > 0 then
    raise exception using errcode='P0001',message='kernel_apply:' || jsonb_build_object(
      'code','contract_validation_failed',
      'message','Contract validation failed',
      'details',validation_issues
    )::text;
  end if;

  -- Mainline relation resolution is input-order independent. Reserve all
  -- external-key subjects before validating relation targets so a source can
  -- refer to a later write in the same change set. Drafts deliberately keep
  -- authored target-first semantics.
  if request_mode = 'mainline' then
    for write, write_index in
      select value, ordinal - 1
      from jsonb_array_elements(writes) with ordinality item(value, ordinal)
    loop
      record_key := write->'record_key';
      if jsonb_typeof(coalesce(record_key, 'null'::jsonb)) <> 'object'
        or record_key->>'type' <> 'external_key'
        or (write ? 'new_record_id' and write->'new_record_id' <> 'null'::jsonb)
        or coalesce((write->>'tombstones_record')::boolean, false)
      then
        continue;
      end if;

      model_id := write->>'model_id';
      select value into model
      from jsonb_array_elements(coalesce(active_schema->'models', '[]'::jsonb)) item(value)
      where value->>'id' = model_id;
      if model is null then
        continue;
      end if;

      record_key_value := record_key->>'value';
      if btrim(coalesce(record_key_value, '')) = '' then
        continue;
      end if;
      is_lookup := model->>'kind' = 'lookup';
      if is_lookup then
        perform kernel_apply_assert_lookup_storage_authority(app_id,customer_id,model_id);
      end if;
      if is_lookup then
        select id into record_id from lookup_record
        where lookup_record.app_id=apply_runtime.app_id
          and lookup_record.customer_id=apply_runtime.customer_id
          and lookup_record.model_id=apply_runtime.model_id
          and external_key=record_key_value;
      else
        model_identifier := kernel_apply_identifier(model_id);
        record_table := quote_ident(kernel_apply_identifier(model_identifier || '_record'));
        execute format(
          'select id from %s where app_id=$1 and customer_id=$2 and external_key=$3',
          record_table
        ) using app_id, customer_id, record_key_value into record_id;
      end if;
      if record_id is null then
        candidate_id := gen_random_uuid();
        if is_lookup then
          insert into lookup_record(app_id,customer_id,model_id,id,external_key)
          values(app_id,customer_id,model_id,candidate_id,record_key_value)
          on conflict do nothing returning id into record_id;
        else
          execute format(
            'insert into %s (id,app_id,customer_id,external_key) values ($1,$2,$3,$4) on conflict (app_id,customer_id,external_key) where external_key is not null do nothing returning id',
            record_table
          ) using candidate_id, app_id, customer_id, record_key_value into record_id;
        end if;
        if record_id is null then
          if is_lookup then
            select id into record_id from lookup_record
            where lookup_record.app_id=apply_runtime.app_id
              and lookup_record.customer_id=apply_runtime.customer_id
              and lookup_record.model_id=apply_runtime.model_id
              and external_key=record_key_value;
          else
            execute format(
              'select id from %s where app_id=$1 and customer_id=$2 and external_key=$3',
              record_table
            ) using app_id, customer_id, record_key_value into record_id;
          end if;
        end if;
      end if;
      subject_map := subject_map || jsonb_build_object(write_index::text, record_id::text);
      subject_map := subject_map || jsonb_build_object(
        model_id || ':external_key:' || record_key_value,
        record_id::text
      );
      subject_map := subject_map || jsonb_build_object(
        model_id || ':record_id:' || record_id,
        record_id::text
      );
      lock_map := lock_map || jsonb_build_object(
        model_id || ':' || record_id,
        jsonb_build_object('model_id', model_id, 'record_id', record_id)
      );
    end loop;
  end if;

  -- Validate each write and reserve every subject before taking the canonical lock set.
  for write, write_index in
    select value, ordinal - 1 from jsonb_array_elements(writes) with ordinality item(value, ordinal)
  loop
    model_id := write->>'model_id';
    select value into model from jsonb_array_elements(coalesce(active_schema->'models', '[]'::jsonb)) item(value)
    where value->>'id' = model_id;
    if model is null then
      perform kernel_apply_fail('contract_validation_failed', 'Contract validation failed', 'writes[' || write_index || '].model_id', 'unknown_write_model', 'write model_id `' || coalesce(model_id, '') || '` is not declared in the active schema');
    end if;
    if change_type is not null and model_id <> change_type->>'target_model'
      and not coalesce((write->>'__kernel_lookup_or_create')::boolean,false)
    then
      perform kernel_apply_fail('contract_validation_failed', 'Contract validation failed', 'writes[' || write_index || '].model_id', 'change_type_model_mismatch', 'write model_id `' || model_id || '` does not match change_type target_model `' || (change_type->>'target_model') || '`');
    end if;
    begin effective_start := (write->>'effective_start')::date;
    exception when others then
      perform kernel_apply_fail('serialization_error', 'Kernel serialization failed');
    end;
    if effective_start = date '-infinity' or write->>'effective_start' = '-262143-01-01' then
      perform kernel_apply_fail('contract_validation_failed', 'Contract validation failed', 'writes[' || write_index || '].effective_start', 'effective_start_underflow', 'effective_start is too early to close a prior version range');
    end if;
    tombstone := coalesce((write->>'tombstones_record')::boolean, false);
    values_json := write->'values';
    custom_fields_json := write->'custom_fields';
    clear_fields_json := coalesce(write->'clear_fields','[]'::jsonb);
    clear_custom_fields_json := coalesce(write->'clear_custom_fields','[]'::jsonb);
    metadata_patch_json := write->'metadata_patch';
    if write ?| array['metadata','lookup_availability','many_relations','clear_many_relations'] then
      perform kernel_apply_fail('serialization_error','Kernel serialization failed');
    end if;
    availability := case
      when jsonb_typeof(values_json)='object' and values_json ? '__lookup_lifecycle'
        then values_json#>>'{__lookup_lifecycle,value}'
      else null
    end;
    select jsonb_object_agg(key,value->'value') into many_relations_json
    from jsonb_each(case when jsonb_typeof(values_json)='object' then values_json else '{}'::jsonb end)
    where value->>'type'='relation_list';
    select jsonb_agg(item.value order by item.ordinal) into clear_many_relations
    from jsonb_array_elements_text(clear_fields_json) with ordinality item(value,ordinal)
    where exists(
      select 1 from jsonb_array_elements(coalesce(model->'many_relations','[]'::jsonb)) definition(value)
      where value->>'id'=item.value
    );
    if write ? 'record_key' and write->'record_key' <> 'null'::jsonb then record_key := write->'record_key'; else record_key := null; end if;
    if record_key is not null and write ? 'new_record_id' and write->'new_record_id' <> 'null'::jsonb then
      perform kernel_apply_fail('contract_validation_failed', 'Contract validation failed', 'writes[' || write_index || '].new_record_id', 'conflicting_write_subject', 'writes must identify either an existing subject or a new record, not both');
    end if;
    if write ? 'expected_version_id' and write->'expected_version_id' <> 'null'::jsonb then
      if request_mode <> 'mainline' then
        perform kernel_apply_fail('contract_validation_failed', 'Contract validation failed', 'writes[' || write_index || '].expected_version_id', 'version_precondition_requires_mainline', 'version preconditions are supported only for mainline writes');
      end if;
      if jsonb_typeof(write->'expected_version_id') <> 'string' then
        perform kernel_apply_fail('contract_validation_failed', 'Contract validation failed', 'writes[' || write_index || '].expected_version_id', 'invalid_expected_version_id', 'expected_version_id must be a UUID');
      end if;
      begin expected_version_id := (write->>'expected_version_id')::uuid;
      exception when others then
        perform kernel_apply_fail('contract_validation_failed', 'Contract validation failed', 'writes[' || write_index || '].expected_version_id', 'invalid_expected_version_id', 'expected_version_id must be a UUID');
      end;
      if (write ? 'new_record_id' and write->'new_record_id' <> 'null'::jsonb)
        or not (write ? 'record_key' and write->'record_key' <> 'null'::jsonb) then
        perform kernel_apply_fail('contract_validation_failed', 'Contract validation failed', 'writes[' || write_index || '].expected_version_id', 'create_version_precondition_forbidden', 'new record writes cannot carry a version precondition');
      end if;
    end if;
    if tombstone and (record_key is null or (write ? 'new_record_id' and write->'new_record_id' <> 'null'::jsonb)) then
      perform kernel_apply_fail('contract_validation_failed', 'Contract validation failed', 'writes[' || write_index || '].record_key', 'missing_record_event_key', 'tombstone writes must identify an existing record');
    end if;
    if tombstone and values_json is not null and values_json <> 'null'::jsonb then
      perform kernel_apply_fail('contract_validation_failed', 'Contract validation failed', 'writes[' || write_index || '].values', 'record_event_values_forbidden', 'tombstone writes must not carry typed values');
    end if;
    if tombstone and custom_fields_json is not null and custom_fields_json <> 'null'::jsonb then
      perform kernel_apply_fail('contract_validation_failed', 'Contract validation failed', 'writes[' || write_index || '].custom_fields', 'record_event_custom_fields_forbidden', 'tombstone writes must not carry custom field values');
    end if;
    if tombstone and jsonb_array_length(clear_fields_json)>0 then
      perform kernel_apply_fail('contract_validation_failed','Contract validation failed','writes[' || write_index || '].clear_fields','record_event_clear_fields_forbidden','tombstone writes must not clear typed values');
    end if;
    if tombstone and jsonb_array_length(clear_custom_fields_json)>0 then
      perform kernel_apply_fail('contract_validation_failed','Contract validation failed','writes[' || write_index || '].clear_custom_fields','record_event_clear_custom_fields_forbidden','tombstone writes must not clear custom field values');
    end if;
    if tombstone and metadata_patch_json is not null and metadata_patch_json<>'null'::jsonb then
      perform kernel_apply_fail('contract_validation_failed','Contract validation failed','writes[' || write_index || '].metadata_patch','record_event_metadata_patch_forbidden','tombstone writes must not patch record metadata');
    end if;
    if availability is not null and (model->>'kind'<>'lookup' or availability not in ('active','retired')) then
      perform kernel_apply_fail('contract_validation_failed','Contract validation failed','writes[' || write_index || '].values.__lookup_lifecycle','invalid_lookup_lifecycle_value','the reserved lookup lifecycle value is valid only on lookup models and must use type schema_lifecycle');
    end if;
    if (many_relations_json is not null or clear_many_relations is not null) and model->>'kind'<>'lookup' then
      perform kernel_apply_fail('contract_validation_failed','Contract validation failed','writes[' || write_index || '].values','invalid_lookup_many_relation','many relations are only valid for lookup models');
    end if;
    if many_relations_json is not null and jsonb_typeof(many_relations_json)<>'object' then
      perform kernel_apply_fail('contract_validation_failed','Contract validation failed','writes[' || write_index || '].values','invalid_lookup_many_relation','relation_list values must contain ordered target arrays');
    end if;
    if clear_many_relations is not null and jsonb_typeof(clear_many_relations)<>'array' then
      perform kernel_apply_fail('serialization_error','Kernel serialization failed');
    end if;
    for field_entry in select key,value from jsonb_each(coalesce(many_relations_json,'{}'::jsonb)) loop
      if jsonb_typeof(field_entry.value)<>'array' or not exists(
        select 1 from jsonb_array_elements(coalesce(model->'many_relations','[]'::jsonb)) definition(value)
        where value->>'id'=field_entry.key and coalesce(value->>'lifecycle','active')='active'
      ) then
        perform kernel_apply_fail('contract_validation_failed','Contract validation failed','writes[' || write_index || '].values.' || field_entry.key,'retired_many_relation','many relation `' || field_entry.key || '` is retired and cannot accept new values');
      end if;
      if coalesce(clear_many_relations,'[]'::jsonb) ? field_entry.key then
        perform kernel_apply_fail('contract_validation_failed','Contract validation failed','writes[' || write_index || '].values.' || field_entry.key,'conflicting_lookup_many_relation','many relation cannot be replaced and cleared in the same write');
      end if;
    end loop;
    if not tombstone and
       (jsonb_typeof(values_json) is distinct from 'object' or not exists(select 1 from jsonb_each(values_json))) and
       (jsonb_typeof(custom_fields_json) is distinct from 'array' or jsonb_array_length(custom_fields_json) = 0) and
       jsonb_array_length(clear_fields_json)=0 and jsonb_array_length(clear_custom_fields_json)=0
       and (metadata_patch_json is null or metadata_patch_json='null'::jsonb) then
      perform kernel_apply_fail('contract_validation_failed', 'Contract validation failed', 'writes[' || write_index || '].values', case when values_json is null and custom_fields_json is null then 'missing_values' else 'empty_values' end, 'ordinary row-version writes must include at least one value, clear field, or metadata patch');
    end if;
    if values_json is not null and values_json <> 'null'::jsonb and jsonb_typeof(values_json) <> 'object' then
      perform kernel_apply_fail('serialization_error', 'Kernel serialization failed');
    end if;
    if custom_fields_json is not null and custom_fields_json <> 'null'::jsonb and jsonb_typeof(custom_fields_json) <> 'array' then
      perform kernel_apply_fail('serialization_error', 'Kernel serialization failed');
    end if;
    for field_entry in select key,value from jsonb_each(case when jsonb_typeof(values_json)='object' then values_json else '{}'::jsonb end) loop
      field_id := field_entry.key;
      typed_value := field_entry.value;
      if field_id='__lookup_lifecycle' or typed_value->>'type'='relation_list' then
        continue;
      end if;
      select value into field from jsonb_array_elements(model->'fields') item(value) where value->>'id'=field_id;
      if field is null then
        continue;
      end if;
      field_type := field->>'type';
      expected_value_type := case when field_type in ('iso_country','iso_currency') then 'text' when field_type='known_aliases' then 'text_list' else field_type end;
      if not kernel_apply_typed_value_valid(typed_value,expected_value_type) then
        perform kernel_apply_fail('contract_validation_failed','Contract validation failed','writes[' || write_index || '].values.' || field_id,'field_value_type_mismatch','field `' || field_id || '` value does not match declared type');
      end if;
    end loop;
    for custom_entry, custom_index in
      select value,ordinal-1 from jsonb_array_elements(case when jsonb_typeof(custom_fields_json)='array' then custom_fields_json else '[]'::jsonb end) with ordinality item(value,ordinal)
    loop
      if jsonb_typeof(custom_entry) <> 'object'
        or not (custom_entry ?& array['field_id','type','value'])
        or custom_entry - array['field_id','type','value'] <> '{}'::jsonb
        or jsonb_typeof(custom_entry->'field_id') <> 'string'
      then
        perform kernel_apply_fail('serialization_error','Kernel serialization failed');
      end if;
      field_id := custom_entry->>'field_id';
      select value into custom_definition
      from jsonb_array_elements(coalesce(active_schema->'custom_fields','[]'::jsonb)) definition(value)
      where value->>'model_id'=model_id and value->>'field_id'=field_id
        and coalesce(value->>'lifecycle','active')='active';
      if custom_definition is not null
        and not kernel_apply_typed_value_valid(custom_entry - 'field_id',custom_definition->>'type')
      then
        perform kernel_apply_fail('contract_validation_failed','Contract validation failed','writes[' || write_index || '].custom_fields[' || custom_index || '].value','custom_field_value_type_mismatch','custom field `' || field_id || '` value does not match declared type');
      end if;
    end loop;

    is_lookup := model->>'kind' = 'lookup';
    if is_lookup then
      perform kernel_apply_assert_lookup_storage_authority(app_id,customer_id,model_id);
    end if;
    if is_lookup then
      record_table := 'lookup_record';
      version_table := 'lookup_version';
    else
      model_identifier := kernel_apply_identifier(model_id);
      record_table := quote_ident(kernel_apply_identifier(model_identifier || '_record'));
      version_table := quote_ident(kernel_apply_identifier(model_identifier || '_version'));
    end if;
    record_id := null;
    if write ? 'new_record_id' and write->'new_record_id' <> 'null'::jsonb then
      record_id := (write->>'new_record_id')::uuid;
      subject_key := model_id || ':record_id:' || record_id;
      if not new_subject_map ? subject_key then
        if is_lookup then
          insert into lookup_record(app_id,customer_id,model_id,id)
          values(app_id,customer_id,model_id,record_id)
          on conflict do nothing;
        else
          query_sql := format('insert into %s (id, app_id, customer_id) values ($1,$2,$3) on conflict (id) do nothing', record_table);
          execute query_sql using record_id, app_id, customer_id;
        end if;
        get diagnostics duplicate_count = row_count;
        if duplicate_count = 0 then
          if is_lookup then
            select exists(
              select 1 from lookup_version v where v.record_id=apply_runtime.record_id
                and v.app_id=apply_runtime.app_id and v.customer_id=apply_runtime.customer_id
                and v.model_id=apply_runtime.model_id and v.stage='discarded'
            ) and not exists(
              select 1 from lookup_version v where v.record_id=apply_runtime.record_id
                and v.app_id=apply_runtime.app_id and v.customer_id=apply_runtime.customer_id
                and v.model_id=apply_runtime.model_id and v.stage<>'discarded'
            ) into planned_visible;
          else
            query_sql := format(
              'select exists(select 1 from %1$s where record_id=$1 and app_id=$2 and customer_id=$3 and stage=''discarded'') and not exists(select 1 from %1$s where record_id=$1 and app_id=$2 and customer_id=$3 and stage<>''discarded'')',
              version_table
            );
            execute query_sql using record_id, app_id, customer_id into planned_visible;
          end if;
          if not coalesce(planned_visible, false) then
            perform kernel_apply_fail('record_key_conflict', 'record_id `' || record_id || '` already exists');
          end if;
        end if;
        new_subject_map := new_subject_map || jsonb_build_object(subject_key,true);
      end if;
    elsif record_key is not null then
      record_key_type := record_key->>'type';
      record_key_value := record_key->>'value';
      if record_key_type = 'record_id' then
        if is_lookup then
          select id into record_id from lookup_record
          where lookup_record.app_id=apply_runtime.app_id
            and lookup_record.customer_id=apply_runtime.customer_id
            and lookup_record.model_id=apply_runtime.model_id
            and id=record_key_value::uuid;
        else
          query_sql := format('select id from %s where app_id=$1 and customer_id=$2 and id=$3', record_table);
          execute query_sql using app_id, customer_id, record_key_value::uuid into record_id;
        end if;
      elsif record_key_type = 'external_key' then
        if btrim(coalesce(record_key_value, '')) = '' then
          perform kernel_apply_fail('contract_validation_failed', 'Contract validation failed', 'writes[' || write_index || '].record_key', 'empty_external_key', 'external record keys must not be empty');
        end if;
        if is_lookup then
          select id into record_id from lookup_record
          where lookup_record.app_id=apply_runtime.app_id
            and lookup_record.customer_id=apply_runtime.customer_id
            and lookup_record.model_id=apply_runtime.model_id
            and external_key=record_key_value;
        else
          query_sql := format('select id from %s where app_id=$1 and customer_id=$2 and external_key=$3', record_table);
          execute query_sql using app_id, customer_id, record_key_value into record_id;
        end if;
        if record_id is null and not tombstone then
          candidate_id := gen_random_uuid();
          if is_lookup then
            insert into lookup_record(app_id,customer_id,model_id,id,external_key)
            values(app_id,customer_id,model_id,candidate_id,record_key_value)
            on conflict do nothing returning id into record_id;
            if record_id is null then
              select id into record_id from lookup_record
              where lookup_record.app_id=apply_runtime.app_id
                and lookup_record.customer_id=apply_runtime.customer_id
                and lookup_record.model_id=apply_runtime.model_id
                and external_key=record_key_value;
            end if;
          else
            query_sql := format('insert into %s (id,app_id,customer_id,external_key) values ($1,$2,$3,$4) on conflict (app_id,customer_id,external_key) where external_key is not null do nothing returning id', record_table);
            execute query_sql using candidate_id, app_id, customer_id, record_key_value into record_id;
            if record_id is null then execute format('select id from %s where app_id=$1 and customer_id=$2 and external_key=$3', record_table) using app_id, customer_id, record_key_value into record_id; end if;
          end if;
        end if;
      else
        perform kernel_apply_fail('serialization_error', 'Kernel serialization failed');
      end if;
      if record_id is null then
        perform kernel_apply_fail('record_target_missing', 'record key `' || kernel_apply_record_key_debug(record_key) || '` did not resolve');
      end if;
    else
      record_id := gen_random_uuid();
      if is_lookup then
        insert into lookup_record(app_id,customer_id,model_id,id)
        values(app_id,customer_id,model_id,record_id);
      else
        execute format('insert into %s (id,app_id,customer_id) values ($1,$2,$3)', record_table) using record_id, app_id, customer_id;
      end if;
    end if;
    subject_map := subject_map || jsonb_build_object(write_index::text, record_id::text);
    subject_map := subject_map || jsonb_build_object(model_id || ':record_id:' || record_id, record_id::text);
    if record_key is not null and record_key->>'type' = 'external_key' then
      subject_map := subject_map || jsonb_build_object(model_id || ':external_key:' || (record_key->>'value'), record_id::text);
    end if;
    lock_map := lock_map || jsonb_build_object(model_id || ':' || record_id, jsonb_build_object('model_id', model_id, 'record_id', record_id));

    -- Capture the predecessor before locking; it is re-read after the canonical lock set.
    if is_lookup then
      select to_jsonb(v) || jsonb_build_object('__applied_order',cs.applied_order) into row_json
      from lookup_version v join change_set cs
        on cs.id=v.change_set_id and cs.app_id=v.app_id and cs.customer_id=v.customer_id
       and cs.status='mainline' and cs.applied_order is not null
      where v.record_id=apply_runtime.record_id and v.app_id=apply_runtime.app_id
        and v.customer_id=apply_runtime.customer_id and v.model_id=apply_runtime.model_id
        and v.stage='mainline' and v.effective_start <= apply_runtime.effective_start
        and (v.effective_end is null or v.effective_end >= apply_runtime.effective_start)
      order by v.effective_start desc,v.tombstones_record desc,v.untombstones_record desc,
        cs.applied_order desc,v.id desc limit 1;
    else
      query_sql := format(
        'select to_jsonb(v) || jsonb_build_object(''__applied_order'',cs.applied_order) from %s v join change_set cs on cs.id=v.change_set_id and cs.app_id=v.app_id and cs.customer_id=v.customer_id and cs.status=''mainline'' and cs.applied_order is not null where v.record_id=$1 and v.app_id=$2 and v.customer_id=$3 and v.stage=''mainline'' and v.effective_start <= $4 and (v.effective_end is null or v.effective_end >= $4) order by v.effective_start desc,v.tombstones_record desc,v.untombstones_record desc,cs.applied_order desc,v.id desc limit 1',
        version_table
      );
      execute query_sql using record_id, app_id, customer_id, effective_start into row_json;
    end if;
    baseline_map := baseline_map || jsonb_build_object(write_index::text, coalesce(row_json, 'null'::jsonb));

    -- Incoming and inherited relation targets join the canonical lock set.
    for relation_field in select value from jsonb_array_elements(coalesce(model->'fields', '[]'::jsonb)) item(value) where value->>'type' = 'relation' loop
      field_id := relation_field->>'id';
      target_model_id := relation_field->>'target_model';
      relation_value := case when values_json ? field_id then values_json->field_id else kernel_apply_snapshot(row_json, model)->field_id end;
      if relation_value is null then continue; end if;
      target_record_id := null;
      target_key := target_model_id || ':' || (relation_value->'value'->>'type') || ':' || (relation_value->'value'->>'value');
      if subject_map ? target_key then
        target_record_id := (subject_map->>target_key)::uuid;
      elsif relation_value->'value'->>'type' = 'record_id' and exists (
        select 1 from jsonb_array_elements(writes) planned(value)
        where value->>'model_id' = target_model_id
          and value->>'new_record_id' = relation_value->'value'->>'value'
      ) then
        target_record_id := (relation_value->'value'->>'value')::uuid;
      else
        select value into target_model
        from jsonb_array_elements(active_schema->'models') item(value)
        where value->>'id'=target_model_id;
        target_is_lookup := target_model->>'kind'='lookup';
        if target_is_lookup then
          perform kernel_apply_assert_lookup_storage_authority(app_id,customer_id,target_model_id);
        end if;
        if target_is_lookup then
          if relation_value->'value'->>'type'='record_id' then
            select id into target_record_id from lookup_record
            where lookup_record.app_id=apply_runtime.app_id and lookup_record.customer_id=apply_runtime.customer_id
              and lookup_record.model_id=target_model_id and id=(relation_value->'value'->>'value')::uuid;
          else
            select id into target_record_id from lookup_record
            where lookup_record.app_id=apply_runtime.app_id and lookup_record.customer_id=apply_runtime.customer_id
              and lookup_record.model_id=target_model_id and external_key=relation_value->'value'->>'value';
          end if;
        else
          target_identifier := kernel_apply_identifier(target_model_id);
          target_record_table := quote_ident(kernel_apply_identifier(target_identifier || '_record'));
          if relation_value->'value'->>'type' = 'record_id' then
            execute format('select id from %s where app_id=$1 and customer_id=$2 and id=$3', target_record_table) using app_id, customer_id, (relation_value->'value'->>'value')::uuid into target_record_id;
          else
            execute format('select id from %s where app_id=$1 and customer_id=$2 and external_key=$3', target_record_table) using app_id, customer_id, relation_value->'value'->>'value' into target_record_id;
          end if;
        end if;
      end if;
      if target_record_id is null then perform kernel_apply_fail('record_target_missing', 'record key `' || kernel_apply_record_key_debug(relation_value->'value') || '` did not resolve'); end if;
      lock_map := lock_map || jsonb_build_object(target_model_id || ':' || target_record_id, jsonb_build_object('model_id', target_model_id, 'record_id', target_record_id));
    end loop;
    for many_relation in
      select value from jsonb_array_elements(coalesce(model->'many_relations','[]'::jsonb)) item(value)
    loop
      many_relation_id := many_relation->>'id';
      if coalesce(clear_many_relations,'[]'::jsonb) ? many_relation_id then
        many_relation_value := '[]'::jsonb;
      elsif jsonb_typeof(many_relations_json)='object' and many_relations_json ? many_relation_id then
        many_relation_value := many_relations_json->many_relation_id;
      else
        many_relation_value := coalesce(row_json->'many_relations'->many_relation_id,'[]'::jsonb);
      end if;
      target_model_id := many_relation->>'target_model';
      select value into target_model from jsonb_array_elements(active_schema->'models') item(value)
      where value->>'id'=target_model_id;
      target_is_lookup := target_model->>'kind'='lookup';
      if target_is_lookup then
        perform kernel_apply_assert_lookup_storage_authority(app_id,customer_id,target_model_id);
      end if;
      for many_target in select value from jsonb_array_elements(many_relation_value) item(value) loop
        if jsonb_typeof(many_target)='string' then
          relation_value := jsonb_build_object('type','record_id','value',many_target#>>'{}');
        else
          relation_value := many_target;
        end if;
        target_key := target_model_id || ':' || (relation_value->>'type') || ':' || (relation_value->>'value');
        target_record_id := case when subject_map ? target_key then (subject_map->>target_key)::uuid else null end;
        if target_record_id is null then
          if target_is_lookup then
            if relation_value->>'type'='record_id' then
              select id into target_record_id from lookup_record
              where lookup_record.app_id=apply_runtime.app_id and lookup_record.customer_id=apply_runtime.customer_id
                and lookup_record.model_id=target_model_id and id=(relation_value->>'value')::uuid;
            else
              select id into target_record_id from lookup_record
              where lookup_record.app_id=apply_runtime.app_id and lookup_record.customer_id=apply_runtime.customer_id
                and lookup_record.model_id=target_model_id and external_key=relation_value->>'value';
            end if;
          else
            target_identifier := kernel_apply_identifier(target_model_id);
            target_record_table := quote_ident(kernel_apply_identifier(target_identifier || '_record'));
            if relation_value->>'type'='record_id' then
              execute format('select id from %s where app_id=$1 and customer_id=$2 and id=$3',target_record_table)
                using app_id,customer_id,(relation_value->>'value')::uuid into target_record_id;
            else
              execute format('select id from %s where app_id=$1 and customer_id=$2 and external_key=$3',target_record_table)
                using app_id,customer_id,relation_value->>'value' into target_record_id;
            end if;
          end if;
        end if;
        if target_record_id is null then
          perform kernel_apply_fail('record_target_missing','record key `' || kernel_apply_record_key_debug(relation_value) || '` did not resolve');
        end if;
        lock_map := lock_map || jsonb_build_object(target_model_id || ':' || target_record_id,jsonb_build_object('model_id',target_model_id,'record_id',target_record_id));
      end loop;
    end loop;
    for custom_entry in
      select value from jsonb_array_elements(
        coalesce(row_json->'custom_fields','[]'::jsonb) ||
        case when jsonb_typeof(custom_fields_json)='array' then custom_fields_json else '[]'::jsonb end
      ) item(value)
    loop
      select value into custom_definition
      from jsonb_array_elements(coalesce(active_schema->'custom_fields','[]'::jsonb)) definition(value)
      where value->>'model_id'=model_id
        and value->>'field_id'=custom_entry->>'field_id'
        and value->>'type'='relation'
        and coalesce(value->>'lifecycle','active')='active';
      if custom_definition is null or custom_entry->>'type' <> 'relation' then continue; end if;
      target_model_id := custom_definition->>'target_model_id';
      target_record_id := null;
      target_key := target_model_id || ':' || (custom_entry->'value'->>'type') || ':' || (custom_entry->'value'->>'value');
      if subject_map ? target_key then
        target_record_id := (subject_map->>target_key)::uuid;
      elsif custom_entry->'value'->>'type'='record_id' and exists (
        select 1 from jsonb_array_elements(writes) planned(value)
        where value->>'model_id'=target_model_id
          and value->>'new_record_id'=custom_entry->'value'->>'value'
      ) then
        target_record_id := (custom_entry->'value'->>'value')::uuid;
      else
        select value into target_model
        from jsonb_array_elements(active_schema->'models') item(value)
        where value->>'id'=target_model_id;
        target_is_lookup := target_model->>'kind'='lookup';
        if target_is_lookup then
          perform kernel_apply_assert_lookup_storage_authority(app_id,customer_id,target_model_id);
        end if;
        if target_is_lookup then
          if custom_entry->'value'->>'type'='record_id' then
            select id into target_record_id from lookup_record
            where lookup_record.app_id=apply_runtime.app_id and lookup_record.customer_id=apply_runtime.customer_id
              and lookup_record.model_id=target_model_id and id=(custom_entry->'value'->>'value')::uuid;
          else
            select id into target_record_id from lookup_record
            where lookup_record.app_id=apply_runtime.app_id and lookup_record.customer_id=apply_runtime.customer_id
              and lookup_record.model_id=target_model_id and external_key=custom_entry->'value'->>'value';
          end if;
        else
          target_identifier := kernel_apply_identifier(target_model_id);
          target_record_table := quote_ident(kernel_apply_identifier(target_identifier || '_record'));
          if custom_entry->'value'->>'type'='record_id' then
            execute format('select id from %s where app_id=$1 and customer_id=$2 and id=$3',target_record_table)
              using app_id,customer_id,(custom_entry->'value'->>'value')::uuid into target_record_id;
          else
            execute format('select id from %s where app_id=$1 and customer_id=$2 and external_key=$3',target_record_table)
              using app_id,customer_id,custom_entry->'value'->>'value' into target_record_id;
          end if;
        end if;
      end if;
      if target_record_id is null then
        perform kernel_apply_fail('record_target_missing','record key `' || kernel_apply_record_key_debug(custom_entry->'value') || '` did not resolve');
      end if;
      lock_map := lock_map || jsonb_build_object(target_model_id || ':' || target_record_id,jsonb_build_object('model_id',target_model_id,'record_id',target_record_id));
    end loop;
  end loop;

  select jsonb_build_object(
    'record_id',duplicates.record_id,
    'effective_start',duplicates.effective_start,
    'tombstones_record',duplicates.tombstones_record
  ) into row_json
  from (
    select
      subject_map->>(ordinal - 1)::text as record_id,
      value->>'effective_start' as effective_start,
      coalesce((value->>'tombstones_record')::boolean,false) as tombstones_record,
      ordinal,
      count(*) over (
        partition by
          subject_map->>(ordinal - 1)::text,
          value->>'effective_start',
          coalesce((value->>'tombstones_record')::boolean,false)
      ) as duplicate_count
    from jsonb_array_elements(writes) with ordinality item(value,ordinal)
  ) duplicates
  where duplicates.duplicate_count > 1
  order by duplicates.ordinal
  limit 1;
  if row_json is not null then
    perform kernel_apply_fail(
      'timeline_conflict',
      'change set contains more than one ' ||
      case when (row_json->>'tombstones_record')::boolean then 'tombstone' else 'ordinary value' end ||
      ' snapshot for record `' || (row_json->>'record_id') || '` at ' || (row_json->>'effective_start')
    );
  end if;

  -- Interval-rule model locks precede the canonical subject and relation locks.
  if request_mode = 'mainline' then
    interval_violation := kernel_constraint_interval_isolation_error(
      app_id, customer_id, active_revision,
      array(select distinct value->>'model_id' from jsonb_array_elements(writes) item(value))
    );
    if interval_violation is not null then
      raise exception using errcode='P0001', message='kernel_apply:' || interval_violation::text;
    end if;
    perform kernel_constraint_interval_lock(
      app_id, customer_id, active_revision,
      array(select distinct value->>'model_id' from jsonb_array_elements(writes) item(value))
    );
  end if;

  -- Canonical subject and relation locks precede lifecycle-order allocation.
  for row_json in select value from jsonb_each(lock_map) order by value->>'model_id', value->>'record_id' loop
    select value into model from jsonb_array_elements(active_schema->'models') item(value)
    where value->>'id'=row_json->>'model_id';
    if model->>'kind'='lookup' then
      select to_jsonb(r) into rechecked_json from lookup_record r
      where r.id=(row_json->>'record_id')::uuid and r.app_id=apply_runtime.app_id
        and r.customer_id=apply_runtime.customer_id and r.model_id=row_json->>'model_id'
      for update;
    else
      model_identifier := kernel_apply_identifier(row_json->>'model_id');
      record_table := quote_ident(kernel_apply_identifier(model_identifier || '_record'));
      execute format('select to_jsonb(r) from %s r where id=$1 and app_id=$2 and customer_id=$3 for update', record_table)
        using (row_json->>'record_id')::uuid, app_id, customer_id into rechecked_json;
    end if;
    if rechecked_json is null then
      raise exception using errcode='40001', message='record apply dependency drift';
    end if;
  end loop;
  -- Compare every guarded baseline first. This must precede generic drift
  -- checks so an unguarded sibling cannot hide a stale guarded write.
  for write, write_index in select value, ordinal - 1 from jsonb_array_elements(writes) with ordinality item(value, ordinal) loop
    model_id := write->>'model_id';
    select value into model from jsonb_array_elements(active_schema->'models') item(value)
    where value->>'id'=model_id;
    is_lookup := model->>'kind'='lookup';
    if is_lookup then
      perform kernel_apply_assert_lookup_storage_authority(app_id,customer_id,model_id);
    end if;
    if is_lookup then
      version_table := 'lookup_version';
    else
      model_identifier := kernel_apply_identifier(model_id);
      version_table := quote_ident(kernel_apply_identifier(model_identifier || '_version'));
    end if;
    record_id := (subject_map->>write_index::text)::uuid;
    effective_start := (write->>'effective_start')::date;
    if is_lookup then
      select to_jsonb(v) || jsonb_build_object('__applied_order',cs.applied_order) into rechecked_json
      from lookup_version v join change_set cs
        on cs.id=v.change_set_id and cs.app_id=v.app_id and cs.customer_id=v.customer_id
       and cs.status='mainline' and cs.applied_order is not null
      where v.record_id=apply_runtime.record_id and v.app_id=apply_runtime.app_id
        and v.customer_id=apply_runtime.customer_id and v.model_id=apply_runtime.model_id
        and v.stage='mainline' and v.effective_start <= apply_runtime.effective_start
        and (v.effective_end is null or v.effective_end >= apply_runtime.effective_start)
      order by v.effective_start desc,v.tombstones_record desc,v.untombstones_record desc,
        cs.applied_order desc,v.id desc limit 1;
    else
      execute format('select to_jsonb(v) || jsonb_build_object(''__applied_order'',cs.applied_order) from %s v join change_set cs on cs.id=v.change_set_id and cs.app_id=v.app_id and cs.customer_id=v.customer_id and cs.status=''mainline'' and cs.applied_order is not null where v.record_id=$1 and v.app_id=$2 and v.customer_id=$3 and v.stage=''mainline'' and v.effective_start <= $4 and (v.effective_end is null or v.effective_end >= $4) order by v.effective_start desc,v.tombstones_record desc,v.untombstones_record desc,cs.applied_order desc,v.id desc limit 1', version_table)
        using record_id, app_id, customer_id, effective_start into rechecked_json;
    end if;
    if not policy_declared and write ? 'expected_version_id' and write->'expected_version_id' <> 'null'::jsonb then
      expected_version_id := (write->>'expected_version_id')::uuid;
      if rechecked_json is null
        or (rechecked_json->>'id')::uuid is distinct from expected_version_id
      then
        perform kernel_apply_fail('version_conflict', 'This record has changed. Reload and try again.');
      end if;
    end if;
    rechecked_map := rechecked_map || jsonb_build_object(
      write_index::text, coalesce(rechecked_json, 'null'::jsonb)
    );
  end loop;
  if idempotency_key is not null and exists (
    select 1 from change_set where change_set.app_id=apply_runtime.app_id
      and change_set.customer_id=apply_runtime.customer_id
      and change_set.idempotency_key=apply_runtime.idempotency_key
  ) then
    raise exception using errcode='40001', message='record apply dependency drift';
  end if;
  if rechecked_map is distinct from baseline_map then
    raise exception using errcode='40001', message='record apply dependency drift';
  end if;

  fingerprint := kernel_canonical_json(jsonb_build_object(
    'app_id', app_id, 'customer_id', customer_id, 'schema_revision_id', active_revision,
    'actor_id', request->'actor_id', 'source_kind', source_kind,
    'source_ref', request->'source_ref', 'idempotency_key', request->'idempotency_key',
    'change_type_id', request->'change_type_id', 'notes', request->'notes',
    'mode', request_mode, 'writes', original_writes
  ));
  if is_dry_run then
    lifecycle_order := synthetic_order;
    change_set_id := -(floor(random() * 4503599627370495)::bigint + 1);
  else
    lifecycle_order := nextval('change_set_lifecycle_order_seq');
  end if;
  stage := request_mode;
  applied_at := case when request_mode = 'mainline' then clock_timestamp() else null end;
  if is_dry_run then
    insert into change_set(id,app_id,customer_id,schema_revision_id,created_with_mode,status,actor_id,source_kind,source_ref,idempotency_key,request_fingerprint,change_type_id,notes,created_order,applied_order,applied_at)
    values(change_set_id,app_id,customer_id,active_revision,request_mode,request_mode,request->>'actor_id',source_kind,source_ref,idempotency_key,fingerprint,change_type_id,request->>'notes',lifecycle_order,case when request_mode='mainline' then lifecycle_order end,applied_at);
  else
    insert into change_set(app_id,customer_id,schema_revision_id,created_with_mode,status,actor_id,source_kind,source_ref,idempotency_key,request_fingerprint,change_type_id,notes,created_order,applied_order,applied_at)
    values(app_id,customer_id,active_revision,request_mode,request_mode,request->>'actor_id',source_kind,source_ref,idempotency_key,fingerprint,change_type_id,request->>'notes',lifecycle_order,case when request_mode='mainline' then lifecycle_order end,applied_at)
    returning id into change_set_id;
    -- Open canvases re-read when published data or the scope's drafts change;
    -- delivered on commit, no data.
    perform pg_notify('kernel_canonical', app_id || ':' || customer_id);
  end if;

  -- Mainline uses canonical write ordering; drafts preserve authored target-first ordering.
  for write, write_index in
    select item.value, item.ordinal - 1
    from jsonb_array_elements(writes) with ordinality item(value, ordinal)
    order by case when request_mode='mainline' and alias_transfer is not null then
        case subject_map->>(item.ordinal - 1)::text
          when alias_transfer->>'source_record_id' then 0
          when alias_transfer->>'target_record_id' then 1
          else 2
        end
      else 0 end,
      case when request_mode='mainline' then item.value->>'model_id' else '' end,
      case when request_mode='mainline' then subject_map->>(item.ordinal - 1)::text else '' end,
      case when request_mode='mainline' then item.value->>'effective_start' else '' end,
      case when request_mode='mainline' and coalesce((item.value->>'tombstones_record')::boolean,false) then 1 else 0 end,
      item.ordinal
  loop
    model_id := write->>'model_id';
    select value into model from jsonb_array_elements(active_schema->'models') item(value) where value->>'id'=model_id;
    is_lookup := model->>'kind'='lookup';
    if is_lookup then
      perform kernel_apply_assert_lookup_storage_authority(app_id,customer_id,model_id);
    end if;
    if is_lookup then
      version_table := 'lookup_version';
      version_model_filter := format(' and model_id=%L',model_id);
    else
      model_identifier := kernel_apply_identifier(model_id);
      version_table := quote_ident(kernel_apply_identifier(model_identifier || '_version'));
      version_model_filter := '';
    end if;
    record_id := (subject_map->>write_index::text)::uuid;
    effective_start := (write->>'effective_start')::date;
    tombstone := coalesce((write->>'tombstones_record')::boolean,false);
    values_json := write->'values';
    custom_fields_json := write->'custom_fields';
    clear_fields_json := coalesce(write->'clear_fields','[]'::jsonb);
    clear_custom_fields_json := coalesce(write->'clear_custom_fields','[]'::jsonb);
    metadata_patch_json := write->'metadata_patch';
    availability := case
      when jsonb_typeof(values_json)='object' and values_json ? '__lookup_lifecycle'
        then values_json#>>'{__lookup_lifecycle,value}'
      else null
    end;
    select jsonb_object_agg(key,value->'value') into many_relations_json
    from jsonb_each(case when jsonb_typeof(values_json)='object' then values_json else '{}'::jsonb end)
    where value->>'type'='relation_list';
    select jsonb_agg(item.value order by item.ordinal) into clear_many_relations
    from jsonb_array_elements_text(clear_fields_json) with ordinality item(value,ordinal)
    where exists(
      select 1 from jsonb_array_elements(coalesce(model->'many_relations','[]'::jsonb)) definition(value)
      where value->>'id'=item.value
    );

    if request_mode='draft' then
      execute format('select exists(select 1 from %s where record_id=$1 and app_id=$2 and customer_id=$3 and change_set_id=$4 and stage=''draft'' and effective_start=$5 and tombstones_record=$6 and untombstones_record=false%s)',version_table,version_model_filter)
        using record_id,app_id,customer_id,change_set_id,effective_start,tombstone into planned_visible;
      if planned_visible then perform kernel_apply_fail('timeline_conflict','draft change_set `' || change_set_id || '` already has a version for record `' || record_id || '` at ' || effective_start); end if;
      execute format('select effective_start from %s where record_id=$1 and app_id=$2 and customer_id=$3 and change_set_id=$4 and stage=''draft'' and effective_start>$5%s order by effective_start limit 1',version_table,version_model_filter)
        using record_id,app_id,customer_id,change_set_id,effective_start into next_start;
      if next_start is not null then perform kernel_apply_fail('timeline_conflict','draft change_set `' || change_set_id || '` already has a later version for record `' || record_id || '` at ' || next_start || '; submit same-record draft writes in effective_start order'); end if;
    elsif tombstone then
      execute format('select exists(select 1 from %s where record_id=$1 and app_id=$2 and customer_id=$3 and stage=''mainline'' and effective_start=$4 and tombstones_record=true and untombstones_record=false%s)',version_table,version_model_filter)
        using record_id,app_id,customer_id,effective_start into planned_visible;
      if planned_visible then perform kernel_apply_fail('timeline_conflict','record `' || record_id || '` already has a mainline version at ' || effective_start); end if;
    end if;

    execute format('select to_jsonb(v) from %s v join change_set cs on cs.id=v.change_set_id and cs.app_id=v.app_id and cs.customer_id=v.customer_id where v.record_id=$1 and v.app_id=$2 and v.customer_id=$3 and v.effective_start <= $4 and ((v.stage=''mainline'' and cs.status=''mainline'' and cs.applied_order is not null) or ($5::bigint is not null and v.change_set_id=$5 and v.stage=''draft'' and cs.status=''draft'' and cs.applied_order is null))%s order by v.effective_start desc,v.tombstones_record desc,v.untombstones_record desc,case when v.stage=''draft'' then 1 else 0 end desc,case when v.stage in (''mainline'',''reverted'') then cs.applied_order else cs.created_order end desc,v.id desc limit 1',version_table,version_model_filter)
      using record_id,app_id,customer_id,effective_start,case when request_mode='draft' then change_set_id end into predecessor_json;
    predecessor_id := null; predecessor_start := null; predecessor_end := null; predecessor_tombstone := false;
    if predecessor_json is not null then
      predecessor_id := (predecessor_json->>'id')::uuid;
      predecessor_start := (predecessor_json->>'effective_start')::date;
      if predecessor_json->'effective_end' <> 'null'::jsonb then predecessor_end := (predecessor_json->>'effective_end')::date; end if;
    predecessor_tombstone := coalesce((predecessor_json->>'tombstones_record')::boolean,false);
    end if;
    if predecessor_tombstone and not tombstone then perform kernel_apply_fail('tombstoned_record','record `' || record_id || '` is tombstoned as of ' || effective_start); end if;
    snapshot := kernel_apply_snapshot(predecessor_json,model);
    for field_id in select jsonb_array_elements_text(clear_fields_json) loop
      if exists(
        select 1 from jsonb_array_elements(coalesce(model->'fields','[]'::jsonb)) definition(value)
        where value->>'id'=field_id
      ) then
        snapshot := snapshot-field_id;
      end if;
    end loop;
    metadata_json := case when tombstone then '{}'::jsonb else kernel_apply_metadata_patch(
      coalesce(predecessor_json->'metadata','{}'::jsonb),
      metadata_patch_json,
      model,
      'writes[' || write_index || '].metadata_patch'
    ) end;
    if is_lookup then
      availability := coalesce(availability,predecessor_json->>'availability','active');
      many_relations_snapshot := coalesce(predecessor_json->'many_relations','{}'::jsonb);
      for many_relation_id in select jsonb_array_elements_text(coalesce(clear_many_relations,'[]'::jsonb)) loop
        many_relations_snapshot := many_relations_snapshot || jsonb_build_object(many_relation_id,'[]'::jsonb);
      end loop;
    end if;
    custom_by_id := '{}'::jsonb;
    if predecessor_json is not null then
      for custom_entry in select value from jsonb_array_elements(coalesce(predecessor_json->'custom_fields','[]'::jsonb)) item(value) loop
        if exists(select 1 from jsonb_array_elements(coalesce(active_schema->'custom_fields','[]'::jsonb)) definition(value) where value->>'model_id'=model_id and value->>'field_id'=custom_entry->>'field_id' and coalesce(value->>'lifecycle','active')='active' and coalesce(value->>'archived_at','')='') then
          custom_by_id := custom_by_id || jsonb_build_object(custom_entry->>'field_id',custom_entry);
        end if;
      end loop;
    end if;
    for field_id in select jsonb_array_elements_text(clear_custom_fields_json) loop
      custom_by_id := custom_by_id-field_id;
    end loop;

    if not tombstone then
      for field_entry in select key,value from jsonb_each(case when jsonb_typeof(values_json)='object' then values_json else '{}'::jsonb end) loop
        field_id := field_entry.key; typed_value := field_entry.value;
        if field_id='__lookup_lifecycle' or typed_value->>'type'='relation_list' then
          continue;
        end if;
        select value into field from jsonb_array_elements(model->'fields') item(value) where value->>'id'=field_id;
        if field is null then perform kernel_apply_fail('contract_validation_failed','Contract validation failed','writes[' || write_index || '].values.' || field_id,'unknown_write_field','field `' || field_id || '` is not declared on model `' || model_id || '`'); end if;
        if coalesce(field->>'lifecycle','active')<>'active' then perform kernel_apply_fail('contract_validation_failed','Contract validation failed','writes[' || write_index || '].values.' || field_id,'retired_write_field','field `' || field_id || '` is retired and cannot accept new values'); end if;
        field_type := field->>'type'; expected_value_type := case when field_type in ('iso_country','iso_currency') then 'text' when field_type='known_aliases' then 'text_list' else field_type end;
        if typed_value->>'type' <> expected_value_type then perform kernel_apply_fail('contract_validation_failed','Contract validation failed','writes[' || write_index || '].values.' || field_id,'field_value_type_mismatch','field `' || field_id || '` value does not match declared type'); end if;
        if field_type='enum' and not exists(select 1 from jsonb_array_elements(coalesce(field->'option_set','[]'::jsonb)) option(value) where value->>'id'=typed_value->>'value' and coalesce(value->>'lifecycle','active')='active') then perform kernel_apply_fail('contract_validation_failed','Contract validation failed','writes[' || write_index || '].values.' || field_id,case when exists(select 1 from jsonb_array_elements(coalesce(field->'option_set','[]'::jsonb)) option(value) where value->>'id'=typed_value->>'value' and coalesce(value->>'lifecycle','active')='retired') then 'retired_enum_option' else 'unknown_enum_option' end,'enum option `' || (typed_value->>'value') || '` is not active for field `' || field_id || '`'); end if;
        if field_type='iso_country' and not ((typed_value->>'value')=any(country_codes)) then perform kernel_apply_fail('contract_validation_failed','Contract validation failed','writes[' || write_index || '].values.' || field_id,'field_value_type_mismatch','field `' || field_id || '` value does not match declared type'); end if;
        if field_type='iso_currency' and not ((typed_value->>'value')=any(currency_codes)) then perform kernel_apply_fail('contract_validation_failed','Contract validation failed','writes[' || write_index || '].values.' || field_id,'field_value_type_mismatch','field `' || field_id || '` value does not match declared type'); end if;
        if field_type='money_rate' and not ((typed_value#>>'{value,currency}')=any(currency_codes)) then perform kernel_apply_fail('contract_validation_failed','Contract validation failed','writes[' || write_index || '].values.' || field_id,'field_value_type_mismatch','field `' || field_id || '` value does not match declared type'); end if;
        if field_type='text' and coalesce((field->>'is_unique')::boolean,false) and btrim(typed_value->>'value')='' then perform kernel_apply_fail('contract_validation_failed','Contract validation failed','writes[' || write_index || '].values.' || field_id,'blank_unique_text_value','unique text fields must be omitted instead of supplied as blank text'); end if;
        if field_type='relation' then
          target_model_id := field->>'target_model'; target_key := target_model_id || ':' || (typed_value->'value'->>'type') || ':' || (typed_value->'value'->>'value');
          target_record_id := case when subject_map ? target_key then (subject_map->>target_key)::uuid else null end;
          select value into target_model from jsonb_array_elements(active_schema->'models') item(value) where value->>'id'=target_model_id;
          if coalesce(target_model->>'lifecycle','active')<>'active' then perform kernel_apply_fail('contract_validation_failed','Contract validation failed','writes[' || write_index || '].values.' || field_id,'retired_relation_target_model','relation field `' || field_id || '` targets a retired model and cannot accept new values'); end if;
          target_is_lookup := target_model->>'kind'='lookup';
          if target_is_lookup then
            perform kernel_apply_assert_lookup_storage_authority(app_id,customer_id,target_model_id);
          end if;
          if target_record_id is null then
            if target_is_lookup then
              if typed_value->'value'->>'type'='record_id' then
                select id into target_record_id from lookup_record
                where lookup_record.app_id=apply_runtime.app_id and lookup_record.customer_id=apply_runtime.customer_id
                  and lookup_record.model_id=target_model_id and id=(typed_value->'value'->>'value')::uuid;
              else
                select id into target_record_id from lookup_record
                where lookup_record.app_id=apply_runtime.app_id and lookup_record.customer_id=apply_runtime.customer_id
                  and lookup_record.model_id=target_model_id and external_key=typed_value->'value'->>'value';
              end if;
            else
              target_identifier := kernel_apply_identifier(target_model_id); target_record_table := quote_ident(kernel_apply_identifier(target_identifier || '_record'));
              if typed_value->'value'->>'type'='record_id' then execute format('select id from %s where app_id=$1 and customer_id=$2 and id=$3',target_record_table) using app_id,customer_id,(typed_value->'value'->>'value')::uuid into target_record_id;
              else execute format('select id from %s where app_id=$1 and customer_id=$2 and external_key=$3',target_record_table) using app_id,customer_id,typed_value->'value'->>'value' into target_record_id; end if;
            end if;
          end if;
          if target_record_id is null then perform kernel_apply_fail('record_target_missing','record key `' || kernel_apply_record_key_debug(typed_value->'value') || '` did not resolve'); end if;
          if policy_declared and not installer_seed and not exists (
            select 1 from jsonb_array_elements(writes) with ordinality pending(value,ordinal)
            where pending.value->>'model_id'=target_model_id
              and subject_map->>(pending.ordinal-1)::text=target_record_id::text
              and baseline_map->>(pending.ordinal-1)::text is null
          ) then
            perform kernel_apply_authorize_existing_target(
              policy, app_id, customer_id, active_schema, target_model_id, target_record_id,
              effective_start, typed_value->'value'->>'type'='external_key'
            );
          end if;
          if target_is_lookup then
            select to_jsonb(v) || jsonb_build_object('__lifecycle_order',case when v.stage in ('mainline','reverted') then cs.applied_order else cs.created_order end) into visible_json
            from lookup_version v join change_set cs on cs.id=v.change_set_id and cs.app_id=v.app_id and cs.customer_id=v.customer_id
            where v.record_id=target_record_id and v.app_id=apply_runtime.app_id and v.customer_id=apply_runtime.customer_id
              and v.model_id=target_model_id and v.effective_start <= apply_runtime.effective_start
              and ((v.stage='mainline' and cs.status='mainline' and cs.applied_order is not null)
                or (request_mode='draft' and v.change_set_id=apply_runtime.change_set_id and v.stage='draft' and cs.status='draft' and cs.applied_order is null))
            order by v.effective_start desc,v.tombstones_record desc,v.untombstones_record desc,
              case when v.stage='draft' then 1 else 0 end desc,
              case when v.stage in ('mainline','reverted') then cs.applied_order else cs.created_order end desc,v.id desc limit 1;
          else
            target_identifier := kernel_apply_identifier(target_model_id);
            execute format('select to_jsonb(v) || jsonb_build_object(''__lifecycle_order'',case when v.stage in (''mainline'',''reverted'') then cs.applied_order else cs.created_order end) from %s v join change_set cs on cs.id=v.change_set_id and cs.app_id=v.app_id and cs.customer_id=v.customer_id where v.record_id=$1 and v.app_id=$2 and v.customer_id=$3 and v.effective_start <= $4 and ((v.stage=''mainline'' and cs.status=''mainline'' and cs.applied_order is not null) or ($5::bigint is not null and v.change_set_id=$5 and v.stage=''draft'' and cs.status=''draft'' and cs.applied_order is null)) order by v.effective_start desc,v.tombstones_record desc,v.untombstones_record desc,case when v.stage=''draft'' then 1 else 0 end desc,case when v.stage in (''mainline'',''reverted'') then cs.applied_order else cs.created_order end desc,v.id desc limit 1',quote_ident(kernel_apply_identifier(target_identifier || '_version'))) using target_record_id,app_id,customer_id,effective_start,case when request_mode='draft' then change_set_id end into visible_json;
          end if;
          planned_json := null;
          planned_visible := false;
          if request_mode='mainline' then
            select value into planned_json
            from jsonb_array_elements(writes) with ordinality planned(value,ordinal)
            where value->>'model_id'=target_model_id
              and subject_map->>(ordinal-1)::text=target_record_id::text
              and (value->>'effective_start')::date <= effective_start
            order by (value->>'effective_start')::date desc,coalesce((value->>'tombstones_record')::boolean,false) desc
            limit 1;
            planned_visible := planned_json is not null and (
              visible_json is null or
              (
                (planned_json->>'effective_start')::date,
                case when coalesce((planned_json->>'tombstones_record')::boolean,false) then 2 else 0 end,
                9223372036854775807::bigint
              ) >= (
                (visible_json->>'effective_start')::date,
                case when coalesce((visible_json->>'tombstones_record')::boolean,false) then 2 when coalesce((visible_json->>'untombstones_record')::boolean,false) then 1 else 0 end,
                (visible_json->>'__lifecycle_order')::bigint
              )
            );
          end if;
          if planned_visible and coalesce((planned_json->>'tombstones_record')::boolean,false) then perform kernel_apply_fail('tombstoned_record','record `' || target_record_id || '` is tombstoned as of ' || effective_start); end if;
          if not planned_visible and visible_json is null then perform kernel_apply_fail('record_target_missing','record `' || target_record_id || '` is not visible as of ' || effective_start); end if;
          if not planned_visible and visible_json is not null and coalesce((visible_json->>'tombstones_record')::boolean,false) then perform kernel_apply_fail('tombstoned_record','record `' || target_record_id || '` is tombstoned as of ' || effective_start); end if;
          if target_is_lookup and planned_visible
             and coalesce(planned_json#>>'{values,__lookup_lifecycle,value}',visible_json->>'availability','active')<>'active'
          then perform kernel_apply_fail('record_target_missing','record `' || target_record_id || '` is retired as of ' || effective_start); end if;
          if target_is_lookup and not planned_visible and visible_json is not null
             and coalesce(visible_json->>'availability','active')<>'active'
          then perform kernel_apply_fail('record_target_missing','record `' || target_record_id || '` is retired as of ' || effective_start); end if;
          typed_value := jsonb_build_object('type','relation','value',jsonb_build_object('type','record_id','value',target_record_id));
        end if;
        snapshot := snapshot || jsonb_build_object(field_id,typed_value);
      end loop;

      for field_entry in select key,value from jsonb_each(coalesce(many_relations_json,'{}'::jsonb)) loop
        many_relation_id := field_entry.key;
        select value into many_relation from jsonb_array_elements(coalesce(model->'many_relations','[]'::jsonb)) item(value)
        where value->>'id'=many_relation_id;
        if coalesce(many_relation->>'lifecycle','active')<>'active' then
          perform kernel_apply_fail('contract_validation_failed','Contract validation failed','writes[' || write_index || '].values.' || many_relation_id,'retired_many_relation','many relation `' || many_relation_id || '` is retired and cannot accept new values');
        end if;
        target_model_id := many_relation->>'target_model';
        select value into target_model from jsonb_array_elements(active_schema->'models') item(value)
        where value->>'id'=target_model_id;
        if coalesce(target_model->>'lifecycle','active')<>'active' then
          perform kernel_apply_fail('contract_validation_failed','Contract validation failed','writes[' || write_index || '].values.' || many_relation_id,'retired_relation_target_model','many relation `' || many_relation_id || '` targets a retired model and cannot accept new values');
        end if;
        target_is_lookup := target_model->>'kind'='lookup';
        if target_is_lookup then
          perform kernel_apply_assert_lookup_storage_authority(app_id,customer_id,target_model_id);
        end if;
        many_relation_value := '[]'::jsonb;
        for many_target,many_target_index in
          select value,ordinal-1 from jsonb_array_elements(field_entry.value) with ordinality item(value,ordinal)
        loop
          if jsonb_typeof(many_target)<>'object' or many_target->>'type' not in ('record_id','external_key') then
            perform kernel_apply_fail('contract_validation_failed','Contract validation failed','writes[' || write_index || '].values.' || many_relation_id || '.value[' || many_target_index || ']','invalid_lookup_many_relation_target','many relation targets must be record_id or external_key objects');
          end if;
          target_key := target_model_id || ':' || (many_target->>'type') || ':' || (many_target->>'value');
          target_record_id := case when subject_map ? target_key then (subject_map->>target_key)::uuid else null end;
          if target_record_id is null then
            if target_is_lookup then
              if many_target->>'type'='record_id' then
                select id into target_record_id from lookup_record
                where lookup_record.app_id=apply_runtime.app_id and lookup_record.customer_id=apply_runtime.customer_id
                  and lookup_record.model_id=target_model_id and id=(many_target->>'value')::uuid;
              else
                select id into target_record_id from lookup_record
                where lookup_record.app_id=apply_runtime.app_id and lookup_record.customer_id=apply_runtime.customer_id
                  and lookup_record.model_id=target_model_id and external_key=many_target->>'value';
              end if;
            else
              target_identifier := kernel_apply_identifier(target_model_id);
              target_record_table := quote_ident(kernel_apply_identifier(target_identifier || '_record'));
              if many_target->>'type'='record_id' then
                execute format('select id from %s where app_id=$1 and customer_id=$2 and id=$3',target_record_table)
                  using app_id,customer_id,(many_target->>'value')::uuid into target_record_id;
              else
                execute format('select id from %s where app_id=$1 and customer_id=$2 and external_key=$3',target_record_table)
                  using app_id,customer_id,many_target->>'value' into target_record_id;
              end if;
            end if;
          end if;
          if target_record_id is null then
            perform kernel_apply_fail('record_target_missing','record key `' || kernel_apply_record_key_debug(many_target) || '` did not resolve');
          end if;
          if policy_declared and not installer_seed and not exists (
            select 1 from jsonb_array_elements(writes) with ordinality pending(value,ordinal)
            where pending.value->>'model_id'=target_model_id
              and subject_map->>(pending.ordinal-1)::text=target_record_id::text
              and baseline_map->>(pending.ordinal-1)::text is null
          ) then
            perform kernel_apply_authorize_existing_target(
              policy, app_id, customer_id, active_schema, target_model_id, target_record_id,
              effective_start, many_target->>'type'='external_key'
            );
          end if;
          select value into planned_json from jsonb_array_elements(writes) with ordinality planned(value,ordinal)
          where value->>'model_id'=target_model_id and subject_map->>(ordinal-1)::text=target_record_id::text
            and (value->>'effective_start')::date <= effective_start
          order by (value->>'effective_start')::date desc,coalesce((value->>'tombstones_record')::boolean,false) desc limit 1;
          if planned_json is not null then
            if target_is_lookup and planned_json#>>'{values,__lookup_lifecycle,value}' is null then
              select to_jsonb(v) into visible_json from lookup_version v join change_set cs
                on cs.id=v.change_set_id and cs.app_id=v.app_id and cs.customer_id=v.customer_id
              where v.app_id=apply_runtime.app_id and v.customer_id=apply_runtime.customer_id
                and v.model_id=target_model_id and v.record_id=target_record_id and v.stage='mainline'
                and cs.status='mainline' and cs.applied_order is not null and v.effective_start<=apply_runtime.effective_start
                and (v.effective_end is null or v.effective_end>=apply_runtime.effective_start)
              order by v.effective_start desc,v.tombstones_record desc,v.untombstones_record desc,cs.applied_order desc,v.id desc limit 1;
            end if;
            if coalesce((planned_json->>'tombstones_record')::boolean,false)
               or (target_is_lookup and coalesce(planned_json#>>'{values,__lookup_lifecycle,value}',visible_json->>'availability','active')<>'active')
            then perform kernel_apply_fail('record_target_missing','record `' || target_record_id || '` is unavailable as of ' || effective_start); end if;
          elsif target_is_lookup then
            select to_jsonb(v) into visible_json from lookup_version v join change_set cs
              on cs.id=v.change_set_id and cs.app_id=v.app_id and cs.customer_id=v.customer_id
            where v.app_id=apply_runtime.app_id and v.customer_id=apply_runtime.customer_id
              and v.model_id=target_model_id and v.record_id=target_record_id and v.stage='mainline'
              and cs.status='mainline' and cs.applied_order is not null and v.effective_start<=apply_runtime.effective_start
              and (v.effective_end is null or v.effective_end>=apply_runtime.effective_start)
            order by v.effective_start desc,v.tombstones_record desc,v.untombstones_record desc,cs.applied_order desc,v.id desc limit 1;
            if visible_json is null or coalesce((visible_json->>'tombstones_record')::boolean,false)
               or coalesce(visible_json->>'availability','active')<>'active'
            then perform kernel_apply_fail('record_target_missing','record `' || target_record_id || '` is unavailable as of ' || effective_start); end if;
          else
            target_identifier := kernel_apply_identifier(target_model_id);
            execute format('select to_jsonb(v) from %s v join change_set cs on cs.id=v.change_set_id and cs.app_id=v.app_id and cs.customer_id=v.customer_id where v.app_id=$1 and v.customer_id=$2 and v.record_id=$3 and v.stage=''mainline'' and cs.status=''mainline'' and cs.applied_order is not null and v.effective_start<=$4 and (v.effective_end is null or v.effective_end>=$4) order by v.effective_start desc,v.tombstones_record desc,v.untombstones_record desc,cs.applied_order desc,v.id desc limit 1',quote_ident(kernel_apply_identifier(target_identifier || '_version')))
              using app_id,customer_id,target_record_id,effective_start into visible_json;
            if visible_json is null or coalesce((visible_json->>'tombstones_record')::boolean,false) then perform kernel_apply_fail('record_target_missing','record `' || target_record_id || '` is unavailable as of ' || effective_start); end if;
          end if;
          if many_relation_value @> jsonb_build_array(target_record_id::text) then
            perform kernel_apply_fail('contract_validation_failed','Contract validation failed','writes[' || write_index || '].values.' || many_relation_id || '.value[' || many_target_index || ']','duplicate_lookup_many_relation_target','many relation targets must not repeat');
          end if;
          many_relation_value := many_relation_value || jsonb_build_array(target_record_id::text);
        end loop;
        many_relations_snapshot := many_relations_snapshot || jsonb_build_object(many_relation_id,many_relation_value);
      end loop;

      duplicate_custom := false;
      for custom_entry, custom_index in select value,ordinal-1 from jsonb_array_elements(case when jsonb_typeof(custom_fields_json)='array' then custom_fields_json else '[]'::jsonb end) with ordinality item(value,ordinal) loop
        field_id := custom_entry->>'field_id';
        if custom_by_id ? ('__incoming__' || field_id) then duplicate_custom := true; end if;
        custom_by_id := custom_by_id || jsonb_build_object('__incoming__' || field_id,true);
        if duplicate_custom then perform kernel_apply_fail('contract_validation_failed','Contract validation failed','writes[' || write_index || '].custom_fields[' || custom_index || '].field_id','duplicate_custom_field_value','custom field `' || field_id || '` is duplicated in the write'); end if;
        select value into custom_definition from jsonb_array_elements(coalesce(active_schema->'custom_fields','[]'::jsonb)) definition(value) where value->>'model_id'=model_id and value->>'field_id'=field_id and coalesce(value->>'lifecycle','active')='active';
        if custom_definition is null then perform kernel_apply_fail('contract_validation_failed','Contract validation failed','writes[' || write_index || '].custom_fields[' || custom_index || '].field_id','unknown_custom_field','custom field `' || field_id || '` is not declared'); end if;
        typed_value := custom_entry - 'field_id'; field_type := custom_definition->>'type';
        if typed_value->>'type' <> field_type then perform kernel_apply_fail('contract_validation_failed','Contract validation failed','writes[' || write_index || '].custom_fields[' || custom_index || '].value','custom_field_value_type_mismatch','custom field `' || field_id || '` value does not match declared type'); end if;
        if field_type='enum' and not exists(select 1 from jsonb_array_elements(coalesce(custom_definition->'option_set','[]'::jsonb)) option(value) where value->>'id'=typed_value->>'value' and coalesce(value->>'lifecycle','active')='active') then perform kernel_apply_fail('contract_validation_failed','Contract validation failed','writes[' || write_index || '].custom_fields[' || custom_index || '].value',case when exists(select 1 from jsonb_array_elements(coalesce(custom_definition->'option_set','[]'::jsonb)) option(value) where value->>'id'=typed_value->>'value' and coalesce(value->>'lifecycle','active')='retired') then 'retired_custom_enum_option' else 'unknown_custom_enum_option' end,'custom enum option `' || (typed_value->>'value') || '` is not active for custom field `' || field_id || '`'); end if;
        if field_type='money_rate' and not ((typed_value#>>'{value,currency}')=any(currency_codes)) then perform kernel_apply_fail('contract_validation_failed','Contract validation failed','writes[' || write_index || '].custom_fields[' || custom_index || '].value','custom_field_value_type_mismatch','custom field `' || field_id || '` value does not match declared type'); end if;
        if field_type='relation' then
          target_model_id := custom_definition->>'target_model_id'; target_key := target_model_id || ':' || (typed_value->'value'->>'type') || ':' || (typed_value->'value'->>'value'); target_record_id := case when subject_map ? target_key then (subject_map->>target_key)::uuid else null end;
          select value into target_model from jsonb_array_elements(active_schema->'models') item(value) where value->>'id'=target_model_id;
          if coalesce(target_model->>'lifecycle','active')<>'active' then perform kernel_apply_fail('contract_validation_failed','Contract validation failed','writes[' || write_index || '].custom_fields[' || custom_index || '].value','retired_relation_target_model','custom relation field `' || field_id || '` targets a retired model and cannot accept new values'); end if;
          target_is_lookup := target_model->>'kind'='lookup';
          if target_is_lookup then
            perform kernel_apply_assert_lookup_storage_authority(app_id,customer_id,target_model_id);
          end if;
          if target_record_id is null then
            if target_is_lookup then
              if typed_value->'value'->>'type'='record_id' then
                select id into target_record_id from lookup_record
                where lookup_record.app_id=apply_runtime.app_id and lookup_record.customer_id=apply_runtime.customer_id
                  and lookup_record.model_id=target_model_id and id=(typed_value->'value'->>'value')::uuid;
              else
                select id into target_record_id from lookup_record
                where lookup_record.app_id=apply_runtime.app_id and lookup_record.customer_id=apply_runtime.customer_id
                  and lookup_record.model_id=target_model_id and external_key=typed_value->'value'->>'value';
              end if;
            else
              target_identifier := kernel_apply_identifier(target_model_id); target_record_table := quote_ident(kernel_apply_identifier(target_identifier || '_record'));
              if typed_value->'value'->>'type'='record_id' then execute format('select id from %s where app_id=$1 and customer_id=$2 and id=$3',target_record_table) using app_id,customer_id,(typed_value->'value'->>'value')::uuid into target_record_id;
              else execute format('select id from %s where app_id=$1 and customer_id=$2 and external_key=$3',target_record_table) using app_id,customer_id,typed_value->'value'->>'value' into target_record_id; end if;
            end if;
          end if;
          if target_record_id is null then perform kernel_apply_fail('record_target_missing','record key `' || kernel_apply_record_key_debug(typed_value->'value') || '` did not resolve'); end if;
          if policy_declared and not installer_seed and not exists (
            select 1 from jsonb_array_elements(writes) with ordinality pending(value,ordinal)
            where pending.value->>'model_id'=target_model_id
              and subject_map->>(pending.ordinal-1)::text=target_record_id::text
              and baseline_map->>(pending.ordinal-1)::text is null
          ) then
            perform kernel_apply_authorize_existing_target(
              policy, app_id, customer_id, active_schema, target_model_id, target_record_id,
              effective_start, typed_value->'value'->>'type'='external_key'
            );
          end if;
          if target_is_lookup then
            select to_jsonb(v) || jsonb_build_object('__lifecycle_order',case when v.stage in ('mainline','reverted') then cs.applied_order else cs.created_order end) into visible_json
            from lookup_version v join change_set cs on cs.id=v.change_set_id and cs.app_id=v.app_id and cs.customer_id=v.customer_id
            where v.record_id=target_record_id and v.app_id=apply_runtime.app_id and v.customer_id=apply_runtime.customer_id
              and v.model_id=target_model_id and v.effective_start <= apply_runtime.effective_start
              and ((v.stage='mainline' and cs.status='mainline' and cs.applied_order is not null)
                or (request_mode='draft' and v.change_set_id=apply_runtime.change_set_id and v.stage='draft' and cs.status='draft' and cs.applied_order is null))
            order by v.effective_start desc,v.tombstones_record desc,v.untombstones_record desc,
              case when v.stage='draft' then 1 else 0 end desc,
              case when v.stage in ('mainline','reverted') then cs.applied_order else cs.created_order end desc,v.id desc limit 1;
          else
            target_identifier := kernel_apply_identifier(target_model_id);
            execute format('select to_jsonb(v) || jsonb_build_object(''__lifecycle_order'',case when v.stage in (''mainline'',''reverted'') then cs.applied_order else cs.created_order end) from %s v join change_set cs on cs.id=v.change_set_id and cs.app_id=v.app_id and cs.customer_id=v.customer_id where v.record_id=$1 and v.app_id=$2 and v.customer_id=$3 and v.effective_start <= $4 and ((v.stage=''mainline'' and cs.status=''mainline'' and cs.applied_order is not null) or ($5::bigint is not null and v.change_set_id=$5 and v.stage=''draft'' and cs.status=''draft'' and cs.applied_order is null)) order by v.effective_start desc,v.tombstones_record desc,v.untombstones_record desc,case when v.stage=''draft'' then 1 else 0 end desc,case when v.stage in (''mainline'',''reverted'') then cs.applied_order else cs.created_order end desc,v.id desc limit 1',quote_ident(kernel_apply_identifier(target_identifier || '_version'))) using target_record_id,app_id,customer_id,effective_start,case when request_mode='draft' then change_set_id end into visible_json;
          end if;
          planned_json := null;
          planned_visible := false;
          if request_mode='mainline' then
            select value into planned_json
            from jsonb_array_elements(writes) with ordinality planned(value,ordinal)
            where value->>'model_id'=target_model_id
              and subject_map->>(ordinal-1)::text=target_record_id::text
              and (value->>'effective_start')::date <= effective_start
            order by (value->>'effective_start')::date desc,coalesce((value->>'tombstones_record')::boolean,false) desc
            limit 1;
            planned_visible := planned_json is not null and (
              visible_json is null or
              (
                (planned_json->>'effective_start')::date,
                case when coalesce((planned_json->>'tombstones_record')::boolean,false) then 2 else 0 end,
                9223372036854775807::bigint
              ) >= (
                (visible_json->>'effective_start')::date,
                case when coalesce((visible_json->>'tombstones_record')::boolean,false) then 2 when coalesce((visible_json->>'untombstones_record')::boolean,false) then 1 else 0 end,
                (visible_json->>'__lifecycle_order')::bigint
              )
            );
          end if;
          if planned_visible and coalesce((planned_json->>'tombstones_record')::boolean,false) then perform kernel_apply_fail('tombstoned_record','record `' || target_record_id || '` is tombstoned as of ' || effective_start); end if;
          if not planned_visible and visible_json is null then perform kernel_apply_fail('record_target_missing','record `' || target_record_id || '` is not visible as of ' || effective_start); end if;
          if not planned_visible and visible_json is not null and coalesce((visible_json->>'tombstones_record')::boolean,false) then perform kernel_apply_fail('tombstoned_record','record `' || target_record_id || '` is tombstoned as of ' || effective_start); end if;
          if target_is_lookup and planned_visible
             and coalesce(planned_json#>>'{values,__lookup_lifecycle,value}',visible_json->>'availability','active')<>'active'
          then perform kernel_apply_fail('record_target_missing','record `' || target_record_id || '` is retired as of ' || effective_start); end if;
          if target_is_lookup and not planned_visible and visible_json is not null
             and coalesce(visible_json->>'availability','active')<>'active'
          then perform kernel_apply_fail('record_target_missing','record `' || target_record_id || '` is retired as of ' || effective_start); end if;
          typed_value := jsonb_build_object('type','relation','value',jsonb_build_object('type','record_id','value',target_record_id));
          custom_entry := jsonb_build_object('field_id',field_id) || typed_value;
        end if;
        custom_by_id := custom_by_id || jsonb_build_object(field_id,custom_entry);
      end loop;
    end if;
    custom_output := coalesce((select jsonb_agg(value order by key) from jsonb_each(custom_by_id) where key not like '__incoming__%'),'[]'::jsonb);

    if policy_declared and not installer_seed and request_mode='mainline' then
      policy_fields := kernel_apply_policy_write_fields(write);
      policy_old_values := case when predecessor_json is null then null else
        kernel_apply_policy_record_values(
          kernel_apply_snapshot(predecessor_json, model), predecessor_json->'custom_fields',
          predecessor_json->'metadata', predecessor_json->'many_relations'
        ) end;
      policy_new_values := kernel_apply_policy_record_values(
        snapshot, custom_output, metadata_json, many_relations_snapshot
      );
      if tombstone then
        policy_operation := 'delete';
        policy_fields := '[]'::jsonb;
      elsif write ? 'new_record_id' and write->'new_record_id' <> 'null'::jsonb then
        policy_operation := 'create';
      else
        policy_operation := 'update';
      end if;
      if not kernel_policy_required_fields_allowed(policy, model_id, policy_operation, policy_fields)
        or (policy_operation in ('update', 'delete') and not kernel_policy_record_allowed(policy, model_id, policy_operation, policy_fields, policy_old_values))
        or (policy_operation in ('create', 'update') and not kernel_policy_record_allowed(policy, model_id, policy_operation, policy_fields, policy_new_values))
      then
        perform kernel_apply_fail(
          'authorization_denied', 'Write is not authorized',
          'writes[' || write_index || ']', 'write_not_authorized', model_id
        );
      end if;
      if write ? 'expected_version_id' and write->'expected_version_id' <> 'null'::jsonb then
        expected_version_id := (write->>'expected_version_id')::uuid;
        rechecked_json := rechecked_map->write_index::text;
        if rechecked_json is null
          or (rechecked_json->>'id')::uuid is distinct from expected_version_id
        then
          perform kernel_apply_fail('version_conflict', 'This record has changed. Reload and try again.');
        end if;
      end if;
    end if;

    if request_mode='mainline' and not tombstone then
      for field in select value from jsonb_array_elements(model->'fields') item(value) where coalesce((value->>'is_unique')::boolean,false) loop
        field_id:=field->>'id'; field_type:=field->>'type'; typed_value:=snapshot->field_id;
        if typed_value is null then continue; end if;
        if is_lookup then
          select exists(
            select 1 from lookup_version v join change_set cs
              on cs.id=v.change_set_id and cs.app_id=v.app_id and cs.customer_id=v.customer_id
            where v.app_id=apply_runtime.app_id and v.customer_id=apply_runtime.customer_id
              and v.model_id=apply_runtime.model_id and v.record_id<>apply_runtime.record_id
              and v.stage='mainline' and v.effective_end is null and cs.status='mainline'
              and cs.applied_order is not null and v.values->field_id->'value'=typed_value->'value'
          ) into unique_conflict;
        else
          query_sql:=format(
            'select exists(select 1 from %s where app_id=$1 and customer_id=$2 and record_id<>$3 and stage=''mainline'' and effective_end is null and %s = $4%s)',
            version_table,
            quote_ident(kernel_apply_identifier(field_id)),
            case field_type when 'number' then '::numeric' when 'bool' then '::boolean' when 'date' then '::date' when 'datetime' then '::timestamptz' else '' end
          );
          execute query_sql using app_id,customer_id,record_id,typed_value->>'value' into unique_conflict;
        end if;
        if unique_conflict then perform kernel_apply_unique_fail(model_id,field_id,typed_value->>'value'); end if;
      end loop;
    end if;

    execute format('select effective_start from %s where record_id=$1 and app_id=$2 and customer_id=$3 and stage=''mainline'' and effective_start>$4%s order by effective_start limit 1',version_table,version_model_filter) using record_id,app_id,customer_id,effective_start into next_start;
    if tombstone and next_start is not null then perform kernel_apply_fail('timeline_conflict','tombstone for record `' || record_id || '` at ' || effective_start || ' would precede a later mainline version'); end if;
    if request_mode='mainline' then
      effective_end := case when predecessor_start=effective_start and not predecessor_tombstone then predecessor_end when next_start is not null then next_start-1 else null end;
      if predecessor_id is not null then execute format('update %s set effective_end=$4 where id=$1 and app_id=$2 and customer_id=$3 and stage=''mainline''%s',version_table,version_model_filter) using predecessor_id,app_id,customer_id,case when predecessor_start=effective_start and not predecessor_tombstone then effective_start else effective_start-1 end; end if;
    else effective_end := null; end if;

    version_id := gen_random_uuid();
    if is_lookup then
      projection_is_current := request_mode='mainline' and effective_end is null and not tombstone and availability='active';
      if projection_is_current then
        update lookup_alias_projection p set is_current=false
        where p.app_id=apply_runtime.app_id and p.customer_id=apply_runtime.customer_id
          and p.model_id=apply_runtime.model_id and p.record_id=apply_runtime.record_id and p.is_current;
      end if;
      insert into lookup_version(
        id,app_id,customer_id,model_id,record_id,stage,effective_start,effective_end,
        change_set_id,applied_at,tombstones_record,untombstones_record,availability,
        provenance,custom_fields,metadata,many_relations,values
      ) values (
        version_id,app_id,customer_id,model_id,record_id,request_mode,effective_start,effective_end,
        change_set_id,applied_at,tombstone,false,availability,
        case when write ? 'provenance' then write->'provenance' else null end,
        custom_output,coalesce(metadata_json,'{}'::jsonb),coalesce(many_relations_snapshot,'{}'::jsonb),
        case when tombstone then '{}'::jsonb else snapshot end
      );
      perform kernel_apply_project_lookup_version_internal(
        version_id,app_id,customer_id,model_id,record_id,active_schema,model,
        case when tombstone then '{}'::jsonb else snapshot end,
        case when tombstone then '{}'::jsonb else coalesce(many_relations_snapshot,'{}'::jsonb) end,
        projection_is_current,alias_transfer
      );
    else
      insert_columns := 'id,record_id,app_id,customer_id,stage,effective_start,effective_end,change_set_id,applied_at,tombstones_record,untombstones_record,provenance,custom_fields';
      insert_values := '$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,$11,$12';
      for field in select value from jsonb_array_elements(model->'fields') item(value) loop
        field_id:=field->>'id'; field_type:=field->>'type';
        if field_type='money_rate' then
          insert_columns:=insert_columns || ',' || quote_ident(kernel_apply_identifier(field_id || '_amount')) || ',' || quote_ident(kernel_apply_identifier(field_id || '_currency')) || ',' || quote_ident(kernel_apply_identifier(field_id || '_period'));
          insert_values:=insert_values || format(',case when $10 then null else ($13->%1$L->''value''->>''amount'')::numeric end,case when $10 then null else $13->%1$L->''value''->>''currency'' end,case when $10 then null else $13->%1$L->''value''->>''period'' end',field_id);
        else
          insert_columns:=insert_columns || ',' || quote_ident(kernel_apply_identifier(field_id));
          if field_type in ('text','iso_country','iso_currency','enum') then insert_values:=insert_values || format(',case when $10 then null else $13->%1$L->>''value'' end',field_id);
          elsif field_type='number' then insert_values:=insert_values || format(',case when $10 then null else ($13->%1$L->>''value'')::numeric end',field_id);
          elsif field_type='bool' then insert_values:=insert_values || format(',case when $10 then null else ($13->%1$L->>''value'')::boolean end',field_id);
          elsif field_type='date' then insert_values:=insert_values || format(',case when $10 then null else ($13->%1$L->>''value'')::date end',field_id);
          elsif field_type='datetime' then insert_values:=insert_values || format(',case when $10 then null else ($13->%1$L->>''value'')::timestamptz end',field_id);
          elsif field_type='relation' then insert_values:=insert_values || format(',case when $10 then null else ($13->%1$L->''value''->>''value'')::uuid end',field_id);
          elsif field_type in ('text_list','known_aliases') then insert_values:=insert_values || format(',case when $10 or not ($13 ? %1$L) then null else array(select jsonb_array_elements_text($13->%1$L->''value'')) end',field_id);
          elsif field_type='json' then insert_values:=insert_values || format(',case when $10 then null else $13->%1$L->''value'' end',field_id);
          else perform kernel_apply_fail('schema_drift','Schema drift detected','object','schema_drift',model_id || '.' || field_id || ': unsupported field type `' || field_type || '`'); end if;
        end if;
      end loop;
      insert_columns := insert_columns || ',metadata';
      insert_values := insert_values || ',$14';
      execute format('insert into %s (%s) values (%s)',version_table,insert_columns,insert_values)
        using version_id,record_id,app_id,customer_id,request_mode,effective_start,effective_end,change_set_id,applied_at,tombstone,case when write ? 'provenance' then write->'provenance' else null end,custom_output,snapshot,metadata_json;
    end if;
    -- A draft records the fields each write names (set or cleared, declared
    -- or custom), keyed model, record and effective start: reads with
    -- pending drafts overlay exactly these, whatever their values. A
    -- deletion (tombstone) names no field but still records its record and
    -- date, so those reads find the records a draft deletes.
    if request_mode='draft' then
      draft_written := draft_written || jsonb_build_object(model_id,
        coalesce(draft_written->model_id,'{}'::jsonb) || jsonb_build_object(record_id::text,
          coalesce(draft_written->model_id->(record_id::text),'{}'::jsonb) || jsonb_build_object(to_char(effective_start,'YYYY-MM-DD'),
            case when tombstone then coalesce(draft_written->model_id->(record_id::text)->to_char(effective_start,'YYYY-MM-DD'),'[]'::jsonb) else
            (select coalesce(jsonb_agg(distinct written.field_id order by written.field_id),'[]'::jsonb) from (
              select jsonb_object_keys(case when jsonb_typeof(values_json)='object' then values_json else '{}'::jsonb end) field_id
              union select jsonb_array_elements_text(clear_fields_json)
              union select item->>'field_id' from jsonb_array_elements(case when jsonb_typeof(custom_fields_json)='array' then custom_fields_json else '[]'::jsonb end) item
              union select jsonb_array_elements_text(clear_custom_fields_json)
            ) written where written.field_id<>'__lookup_lifecycle') end)));
    end if;
  end loop;
  if request_mode='draft' then
    update change_set set written_fields=draft_written
    where change_set.id=apply_runtime.change_set_id and change_set.app_id=apply_runtime.app_id
      and change_set.customer_id=apply_runtime.customer_id;
  end if;
  -- Cross-record interval rules evaluate the complete planned mainline state.
  if request_mode = 'mainline' then
    select jsonb_object_agg(scoped.model_id, scoped.record_ids) into interval_scope
    from (
      select item.value->>'model_id' as model_id,
             jsonb_agg(distinct subject_map->>(item.ordinal - 1)::text) as record_ids
      from jsonb_array_elements(writes) with ordinality item(value, ordinal)
      group by item.value->>'model_id'
    ) scoped;
    interval_violation := kernel_constraint_interval_violation(app_id, customer_id, active_revision, interval_scope);
    if interval_violation is not null then
      raise exception using errcode='P0001', message='kernel_apply:' || interval_violation::text;
    end if;
  end if;
  return jsonb_build_object('id',change_set_id,'schema_revision_id',active_revision);
end;
$kernel_apply$;

revoke all on function kernel_apply_execute_internal(jsonb,boolean,bigint,jsonb,boolean) from public;
"#;

const EXECUTE_WRAPPER_SQL: &str = r#"
create or replace function kernel_apply_execute(
  request jsonb,
  is_dry_run boolean,
  synthetic_order bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path from current
as $kernel_apply$
begin
  -- A work-session draft names the session it was saved from, and that
  -- session's owner lists it with its threads. Only work-session Save writes
  -- this provenance, through the revoked internal executor; every public
  -- apply path comes through here.
  if lower(btrim(coalesce(request->>'source_kind', ''))) = 'work_session' then
    perform kernel_apply_fail('reserved_source_kind', 'Source kind is reserved for a kernel API', 'source_kind', 'reserved_source_kind', 'work_session');
  end if;
  -- kernel_apply_prepare_lookup_or_create(request,active_schema) is enforced by the revoked internal executor.
  return kernel_apply_execute_internal(request,is_dry_run,synthetic_order,null,false);
end;
$kernel_apply$;
"#;

const APPLY_SQL: &str = r#"
create or replace function kernel_apply_change_set(request jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path from current
as $kernel_apply$
declare result jsonb; state text; caught_message text; caught_constraint text; caught_table text;
begin
  begin
    result := kernel_apply_execute(request,false,null);
    return jsonb_build_object('ok',true,'data',result);
  exception
    when serialization_failure then
      raise;
    when others then
      get stacked diagnostics state=returned_sqlstate,caught_message=message_text,caught_constraint=constraint_name,caught_table=table_name;
      return jsonb_build_object('ok',false,'error',kernel_apply_error_envelope_v2(state,caught_message,caught_constraint,caught_table,request));
  end;
end;
$kernel_apply$;
"#;

const APPLY_IN_TRANSACTION_SQL: &str = r#"
create or replace function kernel_apply_change_set_in_transaction(request jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path from current
as $kernel_apply$
declare result jsonb; state text; caught_message text; caught_constraint text; caught_table text;
begin
  begin
    if nullif(current_setting('platform.caller_owned_transaction', true), '') is distinct from 'true' then
      perform kernel_apply_fail(
        'contract_validation_failed', 'Contract validation failed',
        'transaction', 'caller_owned_transaction_required',
        'apply_change_set_in_transaction requires an explicit caller-owned transaction'
      );
    end if;
    result := kernel_apply_execute(request,false,null);
    return jsonb_build_object('ok',true,'data',result);
  exception
    when serialization_failure then
      raise;
    when others then
      get stacked diagnostics state=returned_sqlstate,caught_message=message_text,caught_constraint=constraint_name,caught_table=table_name;
      return jsonb_build_object('ok',false,'error',kernel_apply_error_envelope_v2(state,caught_message,caught_constraint,caught_table,request));
  end;
end;
$kernel_apply$;
"#;

const DRY_RUN_SQL: &str = r#"
create or replace function kernel_validate_change_set_dry_run(request jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path from current
as $kernel_apply$
declare result jsonb; lifecycle_order bigint; state text; caught_message text; caught_constraint text; caught_table text;
begin
  begin
    select coalesce(max(greatest(created_order,coalesce(applied_order,created_order))),0)+1 into lifecycle_order from change_set;
    result := kernel_apply_execute(request,true,lifecycle_order);
    raise exception using errcode='PDR01',message=result::text;
  exception when sqlstate 'PDR01' then
    get stacked diagnostics caught_message=message_text;
    return jsonb_build_object('ok',true,'data',caught_message::jsonb);
    when serialization_failure then
      raise;
    when others then
      get stacked diagnostics state=returned_sqlstate,caught_message=message_text,caught_constraint=constraint_name,caught_table=table_name;
      return jsonb_build_object('ok',false,'error',kernel_apply_error_envelope_v2(state,caught_message,caught_constraint,caught_table,request));
  end;
end;
$kernel_apply$;
"#;

const BATCH_DRY_RUN_SQL: &str = r#"
create or replace function kernel_validate_change_sets_dry_run(request jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path from current
as $kernel_apply$
declare changesets jsonb; first_app text; first_customer text; item jsonb; item_index bigint; results jsonb; lifecycle_order bigint; state text; caught_message text; caught_constraint text; caught_table text; envelope jsonb;
begin
  changesets := case when jsonb_typeof(request)='array' then request else request->'changesets' end;
  if jsonb_typeof(coalesce(changesets,'null'::jsonb)) <> 'array' or jsonb_array_length(changesets)=0 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','contract_validation_failed','message','Contract validation failed','details',jsonb_build_array(jsonb_build_object('path','changesets','code','empty_changesets','message','atomic dry-run must include at least one changeset'))));
  end if;
  first_app:=changesets->0->>'app_id'; first_customer:=changesets->0->>'customer_id';
  begin
    results:='[]'::jsonb;
    select coalesce(max(greatest(created_order,coalesce(applied_order,created_order))),0) into lifecycle_order from change_set;
    for item,item_index in select value,ordinal-1 from jsonb_array_elements(changesets) with ordinality entry(value,ordinal) loop
      if item->>'app_id' is distinct from first_app or item->>'customer_id' is distinct from first_customer then
        perform kernel_apply_fail('contract_validation_failed','Contract validation failed','changesets[' || item_index || ']','mixed_changeset_scope','all atomic dry-run changesets must share one app_id and customer_id');
      end if;
      lifecycle_order:=lifecycle_order+1;
      results:=results || jsonb_build_array(kernel_apply_execute(item,true,lifecycle_order));
    end loop;
    raise exception using errcode='PDR01',message=results::text;
  exception when sqlstate 'PDR01' then
    get stacked diagnostics caught_message=message_text;
    return jsonb_build_object('ok',true,'data',caught_message::jsonb);
    when serialization_failure then
      raise;
    when others then
      get stacked diagnostics state=returned_sqlstate,caught_message=message_text,caught_constraint=constraint_name,caught_table=table_name;
      envelope:=kernel_apply_error_envelope_v2(state,caught_message,caught_constraint,caught_table,item);
      if jsonb_array_length(envelope->'details')=0 then
        envelope:=jsonb_set(envelope,'{details}',jsonb_build_array(jsonb_build_object('path','changesets[' || coalesce(item_index,0) || ']','code',envelope->>'code','message',envelope->>'message')));
      else
        envelope:=jsonb_set(envelope,'{details}',(select jsonb_agg(jsonb_set(detail,'{path}',to_jsonb(case when detail->>'path' like 'changesets[%]%' then detail->>'path' else 'changesets[' || coalesce(item_index,0) || '].' || (detail->>'path') end))) from jsonb_array_elements(envelope->'details') detail));
      end if;
      return jsonb_build_object('ok',false,'error',envelope);
  end;
end;
$kernel_apply$;
"#;
