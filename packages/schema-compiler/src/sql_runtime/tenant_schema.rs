use super::RuntimeSqlFunction;

pub(super) fn functions() -> Vec<RuntimeSqlFunction> {
    vec![
        function(
            "kernel_tenant_schema_strip_option(jsonb)",
            KERNEL_TENANT_SCHEMA_STRIP_OPTION,
        ),
        function(
            "kernel_tenant_schema_strip_field(jsonb)",
            KERNEL_TENANT_SCHEMA_STRIP_FIELD,
        ),
        function(
            "kernel_tenant_schema_strip_many_relation(jsonb)",
            KERNEL_TENANT_SCHEMA_STRIP_MANY_RELATION,
        ),
        function(
            "kernel_tenant_schema_strip_model(jsonb)",
            KERNEL_TENANT_SCHEMA_STRIP_MODEL,
        ),
        function(
            "kernel_tenant_schema_strip_custom_field(jsonb)",
            KERNEL_TENANT_SCHEMA_STRIP_CUSTOM_FIELD,
        ),
        function(
            "kernel_tenant_schema_catalog(jsonb,jsonb)",
            KERNEL_TENANT_SCHEMA_CATALOG,
        ),
        function(
            "kernel_tenant_schema_validate_catalog(jsonb)",
            KERNEL_TENANT_SCHEMA_VALIDATE_CATALOG,
        ),
        function(
            "kernel_tenant_schema_scalar_issues(jsonb,text)",
            KERNEL_TENANT_SCHEMA_SCALAR_ISSUES,
        ),
        function(
            "kernel_tenant_schema_apply_operations(jsonb,jsonb,text,text,text)",
            KERNEL_TENANT_SCHEMA_APPLY_OPERATIONS,
        ),
        function(
            "kernel_tenant_schema_effective_schema(jsonb,jsonb,text)",
            KERNEL_TENANT_SCHEMA_EFFECTIVE_SCHEMA,
        ),
        function(
            "kernel_tenant_schema_overlay(jsonb,jsonb,jsonb)",
            KERNEL_TENANT_SCHEMA_OVERLAY,
        ),
        function(
            "kernel_tenant_schema_affected_references(text,text,jsonb,jsonb)",
            KERNEL_TENANT_SCHEMA_AFFECTED_REFERENCES,
        ),
        function(
            "kernel_tenant_schema_preparation_plan(jsonb,jsonb,jsonb)",
            KERNEL_TENANT_SCHEMA_PREPARATION_PLAN,
        ),
        function(
            "kernel_tenant_schema_run_preparation(text,text,jsonb)",
            KERNEL_TENANT_SCHEMA_RUN_PREPARATION,
        ),
        function(
            "kernel_tenant_schema_execute(jsonb,boolean)",
            KERNEL_TENANT_SCHEMA_EXECUTE,
        ),
        function(
            "kernel_dry_run_tenant_schema_revision(jsonb)",
            KERNEL_DRY_RUN_TENANT_SCHEMA_REVISION,
        ),
        function(
            "kernel_commit_tenant_schema_revision(jsonb)",
            KERNEL_COMMIT_TENANT_SCHEMA_REVISION,
        ),
    ]
}

fn function(signature: &'static str, sql: &str) -> RuntimeSqlFunction {
    RuntimeSqlFunction {
        signature,
        sql: sql.trim().to_string(),
    }
}

const KERNEL_TENANT_SCHEMA_SCALAR_ISSUES: &str = r#"
create or replace function kernel_tenant_schema_scalar_issues(
  input_value jsonb,
  path text default 'operations'
)
returns jsonb
language plpgsql
immutable
parallel safe
security invoker
set search_path from current
as $kernel$
declare
  entry record;
  item jsonb;
  ordinal integer := 0;
  child_path text;
  issues jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(input_value) = 'object' then
    for entry in
      select object_entry.key, object_entry.value
      from jsonb_each(input_value) as object_entry(key, value)
      order by object_entry.key
    loop
      child_path := path || '.' || entry.key;
      if entry.key in ('required', 'is_unique', 'typed_custom_fields')
        and entry.value <> 'null'::jsonb
        and jsonb_typeof(entry.value) <> 'boolean'
      then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'path', child_path,
          'code', 'invalid_boolean',
          'message', entry.key || ' must be a JSON boolean'
        ));
      elsif entry.key in (
        'max_bytes', 'max_depth', 'max_keys', 'max_key_bytes',
        'max_scalar_bytes', 'max_array_items'
      ) and entry.value <> 'null'::jsonb
        and jsonb_typeof(entry.value) <> 'number'
      then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'path', child_path,
          'code', 'invalid_number',
          'message', entry.key || ' must be a JSON number'
        ));
      end if;
      issues := issues || kernel_tenant_schema_scalar_issues(entry.value, child_path);
    end loop;
  elsif jsonb_typeof(input_value) = 'array' then
    for item in
      select array_item.value
      from jsonb_array_elements(input_value) as array_item(value)
    loop
      issues := issues || kernel_tenant_schema_scalar_issues(
        item,
        path || '[' || ordinal || ']'
      );
      ordinal := ordinal + 1;
    end loop;
  end if;
  return issues;
end;
$kernel$;
"#;

const KERNEL_TENANT_SCHEMA_STRIP_OPTION: &str = r#"
create or replace function kernel_tenant_schema_strip_option(option_value jsonb)
returns jsonb
language sql
immutable
parallel safe
security invoker
set search_path from current
as $kernel$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', option_value->>'id',
    'label', option_value->>'label',
    'aliases', coalesce(option_value->'aliases', '[]'::jsonb),
    'origin', coalesce(option_value->>'origin', 'app'),
    'management', coalesce(option_value->>'management', 'fixed'),
    'lifecycle', coalesce(option_value->>'lifecycle', 'active')
  ))
$kernel$;
"#;

const KERNEL_TENANT_SCHEMA_STRIP_FIELD: &str = r#"
create or replace function kernel_tenant_schema_strip_field(field_value jsonb)
returns jsonb
language sql
immutable
parallel safe
security invoker
set search_path from current
as $kernel$
  select jsonb_build_object(
    'id', field_value->>'id',
    'label', field_value->>'label',
    'type', field_value->>'type',
    'required', coalesce((field_value->>'required')::boolean, false),
    'is_unique', coalesce((field_value->>'is_unique')::boolean, false),
    'target_model', case
      when field_value ? 'target_model' and field_value->'target_model' <> 'null'::jsonb
        then to_jsonb(field_value->>'target_model')
      else 'null'::jsonb
    end,
    'option_set', coalesce((
      select jsonb_agg(kernel_tenant_schema_strip_option(option_item.value) order by option_item.ordinality)
      from jsonb_array_elements(coalesce(field_value->'option_set', '[]'::jsonb))
        with ordinality as option_item(value, ordinality)
    ), '[]'::jsonb),
    'origin', coalesce(field_value->>'origin', 'app'),
    'management', coalesce(field_value->>'management', 'fixed'),
    'lifecycle', coalesce(field_value->>'lifecycle', 'active')
  )
$kernel$;
"#;

const KERNEL_TENANT_SCHEMA_STRIP_MANY_RELATION: &str = r#"
create or replace function kernel_tenant_schema_strip_many_relation(relation_value jsonb)
returns jsonb
language sql
immutable
parallel safe
security invoker
set search_path from current
as $kernel$
  select jsonb_build_object(
    'id', relation_value->>'id',
    'label', relation_value->>'label',
    'target_model', relation_value->>'target_model',
    'origin', coalesce(relation_value->>'origin', 'app'),
    'management', coalesce(relation_value->>'management', 'fixed'),
    'lifecycle', coalesce(relation_value->>'lifecycle', 'active')
  )
$kernel$;
"#;

const KERNEL_TENANT_SCHEMA_STRIP_MODEL: &str = r#"
create or replace function kernel_tenant_schema_strip_model(model_value jsonb)
returns jsonb
language sql
immutable
parallel safe
security invoker
set search_path from current
as $kernel$
  select jsonb_build_object(
    'id', model_value->>'id',
    'kind', model_value->>'kind',
    'label', model_value->>'label',
    'display_field_id', case
      when model_value ? 'display_field_id' and model_value->'display_field_id' <> 'null'::jsonb
        then model_value->'display_field_id'
      else 'null'::jsonb
    end,
    'origin', coalesce(model_value->>'origin', 'app'),
    'management', coalesce(model_value->>'management', 'fixed'),
    'lifecycle', coalesce(model_value->>'lifecycle', 'active'),
    'extensions', coalesce(model_value->'extensions', '{}'::jsonb),
    'fields', coalesce((
      select jsonb_agg(kernel_tenant_schema_strip_field(field_item.value) order by field_item.ordinality)
      from jsonb_array_elements(coalesce(model_value->'fields', '[]'::jsonb))
        with ordinality as field_item(value, ordinality)
    ), '[]'::jsonb),
    'many_relations', coalesce((
      select jsonb_agg(kernel_tenant_schema_strip_many_relation(relation_item.value) order by relation_item.ordinality)
      from jsonb_array_elements(coalesce(model_value->'many_relations', '[]'::jsonb))
        with ordinality as relation_item(value, ordinality)
    ), '[]'::jsonb)
  )
$kernel$;
"#;

const KERNEL_TENANT_SCHEMA_STRIP_CUSTOM_FIELD: &str = r#"
create or replace function kernel_tenant_schema_strip_custom_field(field_value jsonb)
returns jsonb
language sql
immutable
parallel safe
security invoker
set search_path from current
as $kernel$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', field_value->>'id',
    'model_id', field_value->>'model_id',
    'field_id', field_value->>'field_id',
    'label', field_value->>'label',
    'type', field_value->>'type',
    'target_model_id', case
      when field_value ? 'target_model_id' and field_value->'target_model_id' <> 'null'::jsonb
        then to_jsonb(field_value->>'target_model_id')
      else 'null'::jsonb
    end,
    'option_set', coalesce((
      select jsonb_agg(kernel_tenant_schema_strip_option(option_item.value) order by option_item.ordinality)
      from jsonb_array_elements(coalesce(field_value->'option_set', '[]'::jsonb))
        with ordinality as option_item(value, ordinality)
    ), '[]'::jsonb),
    'expression', field_value->'expression',
    'origin', coalesce(field_value->>'origin', 'app'),
    'management', coalesce(field_value->>'management', 'fixed'),
    'lifecycle', coalesce(field_value->>'lifecycle', 'active'),
    'archived_at', case
      when coalesce(field_value->>'lifecycle', 'active') = 'retired'
        then field_value->'archived_at'
      else null
    end
  ))
$kernel$;
"#;

const KERNEL_TENANT_SCHEMA_CATALOG: &str = r#"
create or replace function kernel_tenant_schema_catalog(effective_schema jsonb, customer_overlay jsonb)
returns jsonb
language plpgsql
immutable
parallel safe
security invoker
set search_path from current
as $kernel$
declare
  tenant_state jsonb := coalesce(customer_overlay->'tenant_schema', '{}'::jsonb);
  catalog_models jsonb := '[]'::jsonb;
  catalog_custom_fields jsonb := '[]'::jsonb;
  model_value jsonb;
  field_value jsonb;
  relation_value jsonb;
  option_value jsonb;
  custom_value jsonb;
  decorated_fields jsonb;
  decorated_relations jsonb;
  decorated_options jsonb;
  decorated_model jsonb;
begin
  for model_value in
    select value from jsonb_array_elements(coalesce(effective_schema->'models', '[]'::jsonb))
  loop
    select value into decorated_model
    from jsonb_array_elements(coalesce(tenant_state->'models', '[]'::jsonb))
    where value->>'id' = model_value->>'id';
    if found then
      catalog_models := catalog_models || jsonb_build_array(decorated_model);
      continue;
    end if;

    decorated_fields := '[]'::jsonb;
    for field_value in select value from jsonb_array_elements(coalesce(model_value->'fields', '[]'::jsonb))
    loop
      decorated_options := '[]'::jsonb;
      for option_value in select value from jsonb_array_elements(coalesce(field_value->'option_set', '[]'::jsonb))
      loop
        decorated_options := decorated_options || jsonb_build_array(
          jsonb_build_object('origin', 'app', 'management', 'fixed', 'lifecycle', 'active') || option_value
        );
      end loop;
      decorated_fields := decorated_fields || jsonb_build_array(
        jsonb_build_object('origin', 'app', 'management', 'fixed', 'lifecycle', 'active')
          || field_value
          || jsonb_build_object('option_set', decorated_options)
      );
    end loop;
    decorated_relations := '[]'::jsonb;
    for relation_value in select value from jsonb_array_elements(coalesce(model_value->'many_relations', '[]'::jsonb))
    loop
      decorated_relations := decorated_relations || jsonb_build_array(
        jsonb_build_object('origin', 'app', 'management', 'fixed', 'lifecycle', 'active') || relation_value
      );
    end loop;
    decorated_model := model_value
      || jsonb_build_object(
        'origin', 'app',
        'management', coalesce(model_value->>'management', 'fixed'),
        'lifecycle', coalesce(model_value->>'lifecycle', 'active'),
        'display_field_id', model_value->>'display_field_id',
        'extensions', coalesce(model_value->'extensions', '{}'::jsonb),
        'fields', decorated_fields,
        'many_relations', decorated_relations
      );
    catalog_models := catalog_models || jsonb_build_array(decorated_model);
  end loop;

  for custom_value in
    select value from jsonb_array_elements(coalesce(effective_schema->'custom_fields', '[]'::jsonb))
  loop
    select value into field_value
    from jsonb_array_elements(coalesce(tenant_state->'custom_fields', '[]'::jsonb))
    where value->>'id' = custom_value->>'id';
    if found then
      catalog_custom_fields := catalog_custom_fields || jsonb_build_array(field_value);
    else
      decorated_options := '[]'::jsonb;
      for option_value in select value from jsonb_array_elements(coalesce(custom_value->'option_set', '[]'::jsonb))
      loop
        decorated_options := decorated_options || jsonb_build_array(
          jsonb_build_object('origin', 'app', 'management', 'fixed', 'lifecycle', 'active') || option_value
        );
      end loop;
      catalog_custom_fields := catalog_custom_fields || jsonb_build_array(
        jsonb_build_object(
            'origin', 'app',
            'management', coalesce(custom_value->>'management', 'fixed'),
            'lifecycle', coalesce(
              custom_value->>'lifecycle',
              case when coalesce(custom_value->>'archived_at', '') = '' then 'active' else 'retired' end
            )
          )
          || custom_value
          || jsonb_build_object('option_set', decorated_options)
      );
    end if;
  end loop;
  return jsonb_build_object('models', catalog_models, 'custom_fields', catalog_custom_fields);
end;
$kernel$;
"#;

const KERNEL_TENANT_SCHEMA_VALIDATE_CATALOG: &str = r#"
create or replace function kernel_tenant_schema_validate_catalog(catalog jsonb)
returns jsonb
language plpgsql
immutable
parallel safe
security invoker
set search_path from current
as $kernel$
declare
  issues jsonb := '[]'::jsonb;
  model_value jsonb;
  field_value jsonb;
  option_value jsonb;
  custom_value jsonb;
  relation_value jsonb;
  display_field jsonb;
  target_model jsonb;
  seen_keys jsonb;
  match_key text;
  prior_id text;
  alias_value jsonb;
  model_index integer;
  field_index integer;
  option_index integer;
  relation_index integer;
  alias_index integer;
  allowed_field_types text[] := array[
    'text', 'number', 'bool', 'date', 'datetime', 'relation', 'text_list',
    'known_aliases', 'json', 'enum', 'iso_country', 'iso_currency', 'money_rate'
  ];
  allowed_custom_types text[] := array[
    'text', 'number', 'bool', 'date', 'datetime', 'relation', 'text_list', 'enum', 'money_rate'
  ];
begin
  if jsonb_typeof(catalog) is distinct from 'object'
    or jsonb_typeof(catalog->'models') is distinct from 'array'
    or jsonb_typeof(catalog->'custom_fields') is distinct from 'array'
  then
    return jsonb_build_array(jsonb_build_object(
      'path', 'catalog', 'code', 'invalid_catalog', 'message', 'tenant schema catalog must contain model and custom-field arrays'
    ));
  end if;
  if exists (
    select 1 from jsonb_array_elements(catalog->'models')
    group by value->>'id' having count(*) > 1
  ) then
    issues := issues || jsonb_build_array(jsonb_build_object(
      'path', 'models', 'code', 'duplicate_model_id', 'message', 'model ids must be unique'
    ));
  end if;

  for model_value, model_index in
    select value, (ordinality - 1)::integer
    from jsonb_array_elements(catalog->'models') with ordinality
  loop
    if kernel_admin_normalize_identifier(model_value->>'id') is distinct from model_value->>'id' then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'path', format('models[%s].id', model_index), 'code', 'invalid_identifier',
        'message', 'model id must already be a normalized kernel identifier'
      ));
    end if;
    if coalesce(btrim(model_value->>'label'), '') = '' then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'path', format('models[%s].label', model_index), 'code', 'empty_value', 'message', 'model label must not be empty'
      ));
    end if;
    if model_value->>'origin' not in ('app', 'tenant')
      or model_value->>'management' not in ('fixed', 'tenant_managed')
      or model_value->>'lifecycle' not in ('active', 'retired')
    then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'path', format('models[%s]', model_index), 'code', 'invalid_schema_metadata',
        'message', 'model origin, management, and lifecycle metadata are invalid'
      ));
    end if;
    if model_value->>'origin' = 'tenant'
      and (model_value->>'kind' <> 'lookup' or model_value->>'management' <> 'tenant_managed')
    then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'path', format('models[%s]', model_index), 'code', 'invalid_tenant_model',
        'message', 'tenant-created models must be tenant-managed lookup models'
      ));
    end if;
    if jsonb_typeof(coalesce(model_value->'extensions', '{}'::jsonb)) is distinct from 'object'
      or jsonb_typeof(coalesce(model_value #> '{extensions,typed_custom_fields}', 'false'::jsonb)) is distinct from 'boolean'
    then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'path', format('models[%s].extensions', model_index), 'code', 'invalid_entity_extensions',
        'message', 'model extensions must use the compiled typed_custom_fields and record_metadata contract'
      ));
    end if;
    if model_value->>'kind' = 'lookup'
      and model_value #> '{extensions,record_metadata}' is not null
      and model_value #> '{extensions,record_metadata}' <> 'null'::jsonb
    then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'path', format('models[%s].extensions', model_index), 'code', 'lookup_extensions_forbidden',
        'message', 'lookup models cannot declare record metadata'
      ));
    end if;
    if model_value #> '{extensions,record_metadata}' is not null
      and model_value #> '{extensions,record_metadata}' <> 'null'::jsonb
      and (
        jsonb_typeof(model_value #> '{extensions,record_metadata}') <> 'object'
        or coalesce((model_value #>> '{extensions,record_metadata,max_bytes}')::numeric, 0) <= 0
        or coalesce((model_value #>> '{extensions,record_metadata,max_bytes}')::numeric, 65537) > 65536
        or coalesce((model_value #>> '{extensions,record_metadata,max_depth}')::numeric, 0) <= 0
        or coalesce((model_value #>> '{extensions,record_metadata,max_depth}')::numeric, 17) > 16
        or coalesce((model_value #>> '{extensions,record_metadata,max_keys}')::numeric, 0) <= 0
        or coalesce((model_value #>> '{extensions,record_metadata,max_keys}')::numeric, 257) > 256
        or coalesce((model_value #>> '{extensions,record_metadata,max_key_bytes}')::numeric, 0) <= 0
        or coalesce((model_value #>> '{extensions,record_metadata,max_key_bytes}')::numeric, 257) > 256
        or coalesce((model_value #>> '{extensions,record_metadata,max_scalar_bytes}')::numeric, 0) <= 0
        or coalesce((model_value #>> '{extensions,record_metadata,max_scalar_bytes}')::numeric, 16385) > 16384
        or coalesce((model_value #>> '{extensions,record_metadata,max_array_items}')::numeric, 0) <= 0
        or coalesce((model_value #>> '{extensions,record_metadata,max_array_items}')::numeric, 257) > 256
      )
    then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'path', format('models[%s].extensions.record_metadata', model_index), 'code', 'invalid_metadata_limits',
        'message', 'record metadata limits must be within compiled byte, depth, and key bounds'
      ));
    end if;
    if jsonb_typeof(model_value->'fields') is distinct from 'array' then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'path', format('models[%s].fields', model_index), 'code', 'invalid_fields', 'message', 'model fields must be an array'
      ));
      continue;
    end if;
    if exists (
      select 1 from jsonb_array_elements(model_value->'fields')
      group by value->>'id' having count(*) > 1
    ) then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'path', format('models[%s].fields', model_index), 'code', 'duplicate_field_id', 'message', 'field ids must be unique within a model'
      ));
    end if;
    if exists (
      select identity
      from (
        select value->>'id' as identity from jsonb_array_elements(model_value->'fields')
        union all
        select value->>'id' from jsonb_array_elements(
          case when jsonb_typeof(model_value->'many_relations') = 'array'
            then model_value->'many_relations' else '[]'::jsonb end
        )
      ) as identities
      group by identity having count(*) > 1
    ) then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'path', format('models[%s].many_relations', model_index), 'code', 'many_relation_id_collision',
        'message', 'many-relation ids must be unique and cannot collide with field ids'
      ));
    end if;

    for field_value, field_index in
      select value, (ordinality - 1)::integer
      from jsonb_array_elements(model_value->'fields') with ordinality
    loop
      if kernel_admin_normalize_identifier(field_value->>'id') is distinct from field_value->>'id' then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'path', format('models[%s].fields[%s].id', model_index, field_index), 'code', 'invalid_identifier',
          'message', 'field id must already be a normalized kernel identifier'
        ));
      end if;
      if coalesce(btrim(field_value->>'label'), '') = '' or not (field_value->>'type' = any(allowed_field_types)) then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'path', format('models[%s].fields[%s]', model_index, field_index), 'code', 'invalid_field',
          'message', 'field label and a supported type are required'
        ));
      end if;
      if field_value->>'origin' not in ('app', 'tenant')
        or field_value->>'management' not in ('fixed', 'tenant_managed')
        or field_value->>'lifecycle' not in ('active', 'retired')
      then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'path', format('models[%s].fields[%s]', model_index, field_index), 'code', 'invalid_schema_metadata',
          'message', 'field origin, management, and lifecycle metadata are invalid'
        ));
      end if;
      if field_value->>'type' = 'relation' then
        select value into target_model from jsonb_array_elements(catalog->'models')
        where value->>'id' = field_value->>'target_model';
        if not found then
          issues := issues || jsonb_build_array(jsonb_build_object(
            'path', format('models[%s].fields[%s].target_model', model_index, field_index),
            'code', 'unknown_relation_target', 'message', 'relation target model does not exist'
          ));
        end if;
      elsif coalesce(field_value->>'target_model', '') <> '' then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'path', format('models[%s].fields[%s].target_model', model_index, field_index),
          'code', 'unexpected_relation_target', 'message', 'only relation fields may declare target_model'
        ));
      end if;
      if field_value->>'type' = 'enum' then
        if jsonb_typeof(field_value->'option_set') is distinct from 'array' then
          issues := issues || jsonb_build_array(jsonb_build_object(
            'path', format('models[%s].fields[%s].option_set', model_index, field_index),
            'code', 'invalid_enum_options', 'message', 'enum option_set must be an array'
          ));
          continue;
        end if;
        seen_keys := '{}'::jsonb;
        for option_value, option_index in
          select value, (ordinality - 1)::integer
          from jsonb_array_elements(field_value->'option_set') with ordinality
        loop
          if kernel_admin_normalize_identifier(option_value->>'id') is distinct from option_value->>'id'
            or coalesce(btrim(option_value->>'label'), '') = ''
            or option_value->>'lifecycle' not in ('active', 'retired')
          then
            issues := issues || jsonb_build_array(jsonb_build_object(
              'path', format('models[%s].fields[%s].option_set[%s]', model_index, field_index, option_index),
              'code', 'invalid_enum_option', 'message', 'enum option identity, label, or lifecycle is invalid'
            ));
            continue;
          end if;
          if option_value->>'lifecycle' = 'active' then
            for match_key in
              select kernel_admin_enum_match_key(raw_value)
              from (
                select option_value->>'label' as raw_value
                union all
                select alias #>> '{}' from jsonb_array_elements(coalesce(option_value->'aliases', '[]'::jsonb)) as aliases(alias)
              ) as names
            loop
              if coalesce(match_key, '') = '' then
                issues := issues || jsonb_build_array(jsonb_build_object(
                  'path', format('models[%s].fields[%s].option_set[%s]', model_index, field_index, option_index),
                  'code', 'invalid_enum_alias', 'message', 'enum labels and aliases must normalize to a non-empty match key'
                ));
              else
                prior_id := seen_keys->>match_key;
                if prior_id is not null and prior_id <> option_value->>'id' then
                  issues := issues || jsonb_build_array(jsonb_build_object(
                    'path', format('models[%s].fields[%s].option_set[%s]', model_index, field_index, option_index),
                    'code', 'enum_alias_collision', 'message', format('normalized enum label or alias collides with option `%s`', prior_id)
                  ));
                else
                  seen_keys := seen_keys || jsonb_build_object(match_key, option_value->>'id');
                end if;
              end if;
            end loop;
          end if;
        end loop;
        if exists (
          select 1 from jsonb_array_elements(field_value->'option_set')
          group by value->>'id' having count(*) > 1
        ) then
          issues := issues || jsonb_build_array(jsonb_build_object(
            'path', format('models[%s].fields[%s].option_set', model_index, field_index),
            'code', 'duplicate_enum_option_id', 'message', 'enum option ids remain reserved after retirement'
          ));
        end if;
      elsif jsonb_array_length(coalesce(field_value->'option_set', '[]'::jsonb)) > 0 then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'path', format('models[%s].fields[%s].option_set', model_index, field_index),
          'code', 'unexpected_enum_options', 'message', 'only enum fields may declare option_set values'
        ));
      end if;
    end loop;

    if jsonb_typeof(coalesce(model_value->'many_relations', '[]'::jsonb)) is distinct from 'array' then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'path', format('models[%s].many_relations', model_index), 'code', 'invalid_many_relations',
        'message', 'model many_relations must be an array'
      ));
    else
      for relation_value, relation_index in
        select value, (ordinality - 1)::integer
        from jsonb_array_elements(coalesce(model_value->'many_relations', '[]'::jsonb)) with ordinality
      loop
        if kernel_admin_normalize_identifier(relation_value->>'id') is distinct from relation_value->>'id'
          or coalesce(btrim(relation_value->>'label'), '') = ''
          or coalesce(btrim(relation_value->>'target_model'), '') = ''
          or relation_value->>'origin' not in ('app', 'tenant')
          or relation_value->>'management' not in ('fixed', 'tenant_managed')
          or relation_value->>'lifecycle' not in ('active', 'retired')
        then
          issues := issues || jsonb_build_array(jsonb_build_object(
            'path', format('models[%s].many_relations[%s]', model_index, relation_index),
            'code', 'invalid_many_relation',
            'message', 'many relation identity, label, target, or schema metadata is invalid'
          ));
        end if;
        if not exists (
          select 1 from jsonb_array_elements(catalog->'models')
          where value->>'id' = relation_value->>'target_model'
        ) then
          issues := issues || jsonb_build_array(jsonb_build_object(
            'path', format('models[%s].many_relations[%s].target_model', model_index, relation_index),
            'code', 'unknown_many_relation_target', 'message', 'many-relation target model does not exist'
          ));
        end if;
      end loop;
    end if;

    if model_value->>'kind' = 'lookup' and model_value->>'lifecycle' = 'active' then
      select value into display_field from jsonb_array_elements(model_value->'fields')
      where value->>'id' = model_value->>'display_field_id'
        and value->>'type' = 'text'
        and coalesce((value->>'required')::boolean, false)
        and value->>'lifecycle' = 'active';
      if not found then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'path', format('models[%s].display_field_id', model_index), 'code', 'invalid_display_field',
          'message', 'active lookup display_field_id must reference an active required text field'
        ));
      end if;
    end if;
  end loop;

  if exists (
    select 1 from jsonb_array_elements(catalog->'custom_fields')
    group by value->>'id' having count(*) > 1
  ) or exists (
    select 1 from jsonb_array_elements(catalog->'custom_fields')
    group by value->>'model_id', value->>'field_id' having count(*) > 1
  ) then
    issues := issues || jsonb_build_array(jsonb_build_object(
      'path', 'custom_fields', 'code', 'duplicate_custom_field',
      'message', 'custom-field definition ids and model/field identities must be unique'
    ));
  end if;
  for custom_value, field_index in
    select value, (ordinality - 1)::integer
    from jsonb_array_elements(catalog->'custom_fields') with ordinality
  loop
    select value into model_value from jsonb_array_elements(catalog->'models')
    where value->>'id' = custom_value->>'model_id';
    if not found then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'path', format('custom_fields[%s].model_id', field_index), 'code', 'unknown_model',
        'message', 'custom field owner model does not exist'
      ));
    elsif not coalesce((model_value #>> '{extensions,typed_custom_fields}')::boolean, false)
      -- App-authored derived fields store nothing and need no tenant opt-in.
      and not (coalesce(custom_value->'expression', 'null'::jsonb) <> 'null'::jsonb and custom_value->>'origin' = 'app')
    then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'path', format('custom_fields[%s].model_id', field_index), 'code', 'custom_fields_not_enabled',
        'message', 'app-owned model has not opted into tenant custom fields'
      ));
    end if;
    if coalesce(custom_value->'expression', 'null'::jsonb) <> 'null'::jsonb and custom_value->>'lifecycle' = 'active' then
      issues := issues || kernel_derived_issues(
        kernel_derived_environment(catalog, custom_value->>'model_id'),
        custom_value->>'field_id', custom_value->'expression', custom_value->>'type',
        format('custom_fields[%s]', field_index)
      );
    end if;
    if kernel_admin_normalize_identifier(custom_value->>'id') is distinct from custom_value->>'id'
      or kernel_admin_normalize_identifier(custom_value->>'field_id') is distinct from custom_value->>'field_id'
      or coalesce(btrim(custom_value->>'label'), '') = ''
      or not (custom_value->>'type' = any(allowed_custom_types))
      or custom_value->>'origin' not in ('app', 'tenant')
      or custom_value->>'management' not in ('fixed', 'tenant_managed')
      or custom_value->>'lifecycle' not in ('active', 'retired')
    then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'path', format('custom_fields[%s]', field_index), 'code', 'invalid_custom_field',
        'message', 'custom-field identity, type, label, or schema metadata is invalid'
      ));
    end if;
    if custom_value ? 'archived_at' and custom_value->'archived_at' <> 'null'::jsonb
      and custom_value->>'lifecycle' <> 'retired'
    then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'path', format('custom_fields[%s].archived_at', field_index), 'code', 'archived_lifecycle_conflict',
        'message', 'deprecated archived_at input is accepted only when lifecycle is retired'
      ));
    end if;
    if custom_value->>'lifecycle' = 'retired'
      and (not (custom_value ? 'archived_at') or custom_value->'archived_at' = 'null'::jsonb)
    then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'path', format('custom_fields[%s].archived_at', field_index), 'code', 'custom_field_lifecycle_mismatch',
        'message', 'retired custom fields must retain archived_at'
      ));
    end if;
    if custom_value->>'type' = 'relation' then
      if not exists (
        select 1 from jsonb_array_elements(catalog->'models')
        where value->>'id' = custom_value->>'target_model_id'
      ) then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'path', format('custom_fields[%s].target_model_id', field_index), 'code', 'unknown_relation_target',
          'message', 'custom relation target model does not exist'
        ));
      end if;
    elsif coalesce(custom_value->>'target_model_id', '') <> '' then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'path', format('custom_fields[%s].target_model_id', field_index), 'code', 'unexpected_relation_target',
        'message', 'only relation custom fields may declare target_model_id'
      ));
    end if;
    if custom_value->>'type' = 'enum' then
      if jsonb_typeof(custom_value->'option_set') is distinct from 'array' then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'path', format('custom_fields[%s].option_set', field_index),
          'code', 'invalid_enum_options', 'message', 'custom enum option_set must be an array'
        ));
        continue;
      end if;
      if exists (
        select 1 from jsonb_array_elements(custom_value->'option_set')
        group by value->>'id' having count(*) > 1
      ) then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'path', format('custom_fields[%s].option_set', field_index),
          'code', 'duplicate_enum_option_id', 'message', 'enum option ids remain reserved after retirement'
        ));
      end if;
      seen_keys := '{}'::jsonb;
      for option_value, option_index in
        select value, (ordinality - 1)::integer
        from jsonb_array_elements(custom_value->'option_set') with ordinality
      loop
        if kernel_admin_normalize_identifier(option_value->>'id') is distinct from option_value->>'id'
          or coalesce(btrim(option_value->>'label'), '') = ''
          or option_value->>'lifecycle' not in ('active', 'retired')
        then
          issues := issues || jsonb_build_array(jsonb_build_object(
            'path', format('custom_fields[%s].option_set[%s]', field_index, option_index),
            'code', 'invalid_enum_option', 'message', 'enum option identity, label, or lifecycle is invalid'
          ));
          continue;
        end if;
        if option_value->>'lifecycle' = 'active' then
          for match_key in
            select kernel_admin_enum_match_key(raw_value)
            from (
              select option_value->>'label' as raw_value
              union all
              select alias #>> '{}' from jsonb_array_elements(coalesce(option_value->'aliases', '[]'::jsonb)) as aliases(alias)
            ) as names
          loop
            prior_id := seen_keys->>match_key;
            if coalesce(match_key, '') = '' then
              issues := issues || jsonb_build_array(jsonb_build_object(
                'path', format('custom_fields[%s].option_set[%s]', field_index, option_index),
                'code', 'invalid_enum_alias', 'message', 'enum labels and aliases must normalize to a non-empty match key'
              ));
            elsif prior_id is not null and prior_id <> option_value->>'id' then
              issues := issues || jsonb_build_array(jsonb_build_object(
                'path', format('custom_fields[%s].option_set[%s]', field_index, option_index),
                'code', 'enum_alias_collision', 'message', format('normalized enum label or alias collides with option `%s`', prior_id)
              ));
            else
              seen_keys := seen_keys || jsonb_build_object(match_key, option_value->>'id');
            end if;
          end loop;
        end if;
      end loop;
    elsif jsonb_array_length(coalesce(custom_value->'option_set', '[]'::jsonb)) > 0 then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'path', format('custom_fields[%s].option_set', field_index),
        'code', 'unexpected_enum_options', 'message', 'only enum custom fields may declare option_set values'
      ));
    end if;
  end loop;
  return issues;
end;
$kernel$;
"#;

const KERNEL_TENANT_SCHEMA_APPLY_OPERATIONS: &str = r#"
create or replace function kernel_tenant_schema_apply_operations(
  initial_catalog jsonb,
  operations jsonb,
  actor_id text,
  mutation_at text,
  identity_seed text
)
returns jsonb
language plpgsql
volatile
parallel unsafe
security invoker
set search_path from current
as $kernel$
declare
  catalog jsonb := initial_catalog;
  models jsonb := initial_catalog->'models';
  custom_fields jsonb := initial_catalog->'custom_fields';
  changes jsonb := '[]'::jsonb;
  operation jsonb;
  operation_index integer;
  operation_type text;
  model_id text;
  field_id text;
  option_id text;
  from_option_id text;
  to_option_id text;
  alias_text text;
  target_kind text;
  model_index integer;
  field_index integer;
  relation_index integer;
  custom_index integer;
  option_index integer;
  from_option_index integer;
  to_option_index integer;
  current_model jsonb;
  current_field jsonb;
  current_relation jsonb;
  current_option jsonb;
  target_option jsonb;
  current_custom jsonb;
  next_value jsonb;
  next_fields jsonb;
  next_relations jsonb;
  next_options jsonb;
  supplied jsonb;
  issues jsonb;
  path_value text;
  allowed_operation_keys text[];
begin
  for operation, operation_index in
    select value, (ordinality - 1)::integer
    from jsonb_array_elements(operations) with ordinality
  loop
    if jsonb_typeof(operation) is distinct from 'object' then
      return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
        'path', format('operations[%s]', operation_index), 'code', 'invalid_operation', 'message', 'operation must be a JSON object'
      )));
    end if;
    operation_type := operation->>'type';

    allowed_operation_keys := case operation_type
      when 'create_model' then array['type', 'model']
      when 'update_model' then array['type', 'model_id', 'label', 'management', 'extensions']
      when 'retire_model' then array['type', 'model_id']
      when 'restore_model' then array['type', 'model_id']
      when 'create_field' then array['type', 'model_id', 'field']
      when 'update_field' then array['type', 'model_id', 'field_id', 'label', 'required', 'is_unique', 'management']
      when 'retire_field' then array['type', 'model_id', 'field_id']
      when 'restore_field' then array['type', 'model_id', 'field_id']
      when 'create_many_relation' then array['type', 'model_id', 'relation']
      when 'update_many_relation' then array['type', 'model_id', 'relation_id', 'label', 'management']
      when 'retire_many_relation' then array['type', 'model_id', 'relation_id']
      when 'restore_many_relation' then array['type', 'model_id', 'relation_id']
      when 'create_enum_option' then array['type', 'model_id', 'field_id', 'option']
      when 'update_enum_option' then array['type', 'model_id', 'field_id', 'option_id', 'label', 'aliases', 'management']
      when 'retire_enum_option' then array['type', 'model_id', 'field_id', 'option_id']
      when 'restore_enum_option' then array['type', 'model_id', 'field_id', 'option_id']
      when 'transfer_enum_alias' then array['type', 'model_id', 'field_id', 'alias', 'from_option_id', 'to_option_id']
      when 'create_custom_field' then array['type', 'definition']
      when 'update_custom_field' then array['type', 'definition_id', 'label', 'management']
      when 'retire_custom_field' then array['type', 'definition_id']
      when 'restore_custom_field' then array['type', 'definition_id']
      else null
    end;
    if allowed_operation_keys is null then
      return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
        'path', format('operations[%s].type', operation_index), 'code', 'unknown_tenant_schema_operation',
        'message', format('unsupported tenant schema operation `%s`', coalesce(operation_type, ''))
      )));
    end if;
    path_value := null;
    select supplied_key into path_value
    from jsonb_object_keys(operation) as supplied_key
    where not (supplied_key = any(allowed_operation_keys))
    order by supplied_key
    limit 1;
    if path_value is not null then
      return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
        'path', format('operations[%s].%s', operation_index, path_value), 'code', 'unknown_field',
        'message', 'operation contains a field outside its typed contract'
      )));
    end if;

    if operation_type = 'create_model' then
      supplied := operation->'model';
      if jsonb_typeof(supplied) is distinct from 'object' then
        return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
          'path', format('operations[%s].model', operation_index), 'code', 'invalid_model', 'message', 'model must be an object'
        )));
      end if;
      path_value := null;
      select supplied_key into path_value
      from jsonb_object_keys(supplied) as supplied_key
      where supplied_key not in ('kind', 'label', 'display_field_id', 'fields', 'many_relations')
      order by supplied_key
      limit 1;
      if path_value is not null then
        return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
          'path', format('operations[%s].model.%s', operation_index, path_value), 'code', 'unknown_field',
          'message', 'model contains a server-owned or unknown field'
        )));
      end if;
      if jsonb_typeof(supplied->'kind') is distinct from 'string'
        or jsonb_typeof(supplied->'label') is distinct from 'string'
        or coalesce(btrim(supplied->>'label'), '') = ''
        or (supplied ? 'display_field_id' and supplied->'display_field_id' <> 'null'::jsonb
          and jsonb_typeof(supplied->'display_field_id') is distinct from 'string')
        or jsonb_typeof(supplied->'fields') is distinct from 'array'
        or (supplied ? 'many_relations' and jsonb_typeof(supplied->'many_relations') is distinct from 'array')
      then
        return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
          'path', format('operations[%s].model', operation_index), 'code', 'invalid_model',
          'message', 'model kind, label, display_field_id, fields, or many_relations has an invalid type'
        )));
      end if;
      model_id := 'lookup_' || substr(
        kernel_admin_sha256(identity_seed || ':' || operation_index::text),
        1,
        24
      );
      if supplied->>'kind' <> 'lookup' then
        return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
          'path', format('operations[%s].model.kind', operation_index), 'code', 'runtime_entity_model_forbidden',
          'message', 'only lookup models may be created at runtime'
        )));
      end if;
      if exists (select 1 from jsonb_array_elements(models) where value->>'id' = model_id) then
        return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
          'path', format('operations[%s].model', operation_index), 'code', 'generated_model_id_collision',
          'message', 'generated model identity is already reserved'
        )));
      end if;
      next_fields := '[]'::jsonb;
      for current_field in select value from jsonb_array_elements(coalesce(supplied->'fields', '[]'::jsonb))
      loop
        next_options := '[]'::jsonb;
        for current_option in select value from jsonb_array_elements(coalesce(current_field->'option_set', '[]'::jsonb))
        loop
          next_options := next_options || jsonb_build_array(
            current_option || jsonb_build_object('origin', 'tenant', 'management', 'tenant_managed', 'lifecycle', 'active')
          );
        end loop;
        next_fields := next_fields || jsonb_build_array(
          current_field
            || jsonb_build_object(
              'required', coalesce((current_field->>'required')::boolean, false),
              'is_unique', coalesce((current_field->>'is_unique')::boolean, false),
              'target_model', coalesce(current_field->'target_model', 'null'::jsonb),
              'origin', 'tenant', 'management', 'tenant_managed', 'lifecycle', 'active',
              'option_set', next_options
            )
        );
      end loop;
      next_relations := '[]'::jsonb;
      for current_relation in select value from jsonb_array_elements(coalesce(supplied->'many_relations', '[]'::jsonb))
      loop
        next_relations := next_relations || jsonb_build_array(
          current_relation || jsonb_build_object(
            'origin', 'tenant', 'management', 'tenant_managed', 'lifecycle', 'active'
          )
        );
      end loop;
      next_value := jsonb_build_object(
        'id', model_id,
        'kind', 'lookup',
        'label', supplied->>'label',
        'display_field_id', coalesce(supplied->'display_field_id', 'null'::jsonb),
        'origin', 'tenant',
        'management', 'tenant_managed',
        'lifecycle', 'active',
        'extensions', '{}'::jsonb,
        'fields', next_fields,
        'many_relations', next_relations
      );
      models := models || jsonb_build_array(next_value);
      changes := changes || jsonb_build_array(jsonb_build_object(
        'operation', operation_type, 'path', 'models.' || model_id, 'before', 'null'::jsonb, 'after', next_value,
        'actor_id', actor_id, 'reason', null, 'changed_at', mutation_at
      ));

    elsif operation_type in ('update_model', 'retire_model', 'restore_model') then
      model_id := operation->>'model_id';
      select value, (ordinality - 1)::integer into current_model, model_index
      from jsonb_array_elements(models) with ordinality where value->>'id' = model_id;
      if not found or current_model->>'kind' <> 'lookup' then
        return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
          'path', format('operations[%s].model_id', operation_index), 'code', 'unknown_lookup_model',
          'message', 'lookup model does not exist'
        )));
      end if;
      if current_model->>'management' <> 'tenant_managed' then
        return kernel_admin_error('schema_management_forbidden', 'Schema definition is fixed', jsonb_build_array(jsonb_build_object(
          'path', format('operations[%s].model_id', operation_index), 'code', 'fixed_definition',
          'message', 'app-owned fixed model cannot be changed by a tenant'
        )));
      end if;
      next_value := current_model;
      if operation_type = 'update_model' then
        supplied := operation - 'type' - 'model_id';
        if jsonb_typeof(supplied) is distinct from 'object' or exists (
          select 1 from jsonb_object_keys(supplied) as supplied_key(key_value)
          where key_value not in ('label', 'management', 'extensions')
        ) then
          return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
            'path', format('operations[%s].changes', operation_index), 'code', 'immutable_model_property',
            'message', 'lookup model update contains an unsupported or immutable property'
          )));
        end if;
        if supplied ? 'management' and supplied->>'management' <> 'tenant_managed' then
          return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
            'path', format('operations[%s].management', operation_index), 'code', 'invalid_management_transition',
            'message', 'tenant-managed definitions cannot be converted into fixed definitions'
          )));
        end if;
        if supplied ? 'extensions' and supplied->'extensions' is distinct from current_model->'extensions' then
          return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
            'path', format('operations[%s].extensions', operation_index), 'code', 'immutable_entity_extensions',
            'message', 'tenant schema mutations cannot change app-owned extension capabilities'
          )));
        end if;
        if supplied ? 'label' then next_value := jsonb_set(next_value, '{label}', supplied->'label'); end if;
      elsif operation_type = 'retire_model' then
        if current_model->>'lifecycle' <> 'active' then
          return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
            'path', format('operations[%s].model_id', operation_index), 'code', 'invalid_lifecycle_transition', 'message', 'only an active model can be retired'
          )));
        end if;
        next_value := next_value || jsonb_build_object('lifecycle', 'retired', 'retired_at', mutation_at);
      else
        if current_model->>'lifecycle' <> 'retired' then
          return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
            'path', format('operations[%s].model_id', operation_index), 'code', 'invalid_lifecycle_transition', 'message', 'only a retired model can be restored'
          )));
        end if;
        next_value := (next_value - 'retired_at') || jsonb_build_object('lifecycle', 'active');
      end if;
      models := jsonb_set(models, array[model_index::text], next_value);
      changes := changes || jsonb_build_array(jsonb_build_object(
        'operation', operation_type, 'path', 'models.' || model_id, 'before', current_model, 'after', next_value,
        'actor_id', actor_id, 'changed_at', mutation_at
      ));

    elsif operation_type in ('create_field', 'update_field', 'retire_field', 'restore_field') then
      model_id := operation->>'model_id';
      select value, (ordinality - 1)::integer into current_model, model_index
      from jsonb_array_elements(models) with ordinality where value->>'id' = model_id;
      if not found or current_model->>'kind' <> 'lookup' or current_model->>'lifecycle' <> 'active' then
        return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
          'path', format('operations[%s].model_id', operation_index), 'code', 'unknown_active_lookup_model',
          'message', 'an active lookup model is required'
        )));
      end if;
      next_fields := current_model->'fields';
      if operation_type = 'create_field' then
        if current_model->>'management' <> 'tenant_managed' then
          return kernel_admin_error('schema_management_forbidden', 'Schema definition is fixed', jsonb_build_array(jsonb_build_object(
            'path', format('operations[%s].model_id', operation_index), 'code', 'fixed_definition',
            'message', 'fixed lookup model does not accept tenant-created fields'
          )));
        end if;
        supplied := operation->'field';
        field_id := supplied->>'id';
        if jsonb_typeof(supplied) is distinct from 'object' then
          return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
            'path', format('operations[%s].field', operation_index), 'code', 'invalid_field', 'message', 'field must be an object'
          )));
        end if;
        if exists (select 1 from jsonb_array_elements(next_fields) where value->>'id' = field_id) then
          return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
            'path', format('operations[%s].field.id', operation_index), 'code', 'field_id_reserved',
            'message', 'field id already exists or remains reserved after retirement'
          )));
        end if;
        next_options := '[]'::jsonb;
        for current_option in select value from jsonb_array_elements(coalesce(supplied->'option_set', '[]'::jsonb))
        loop
          next_options := next_options || jsonb_build_array(
            current_option || jsonb_build_object('origin', 'tenant', 'management', 'tenant_managed', 'lifecycle', 'active')
          );
        end loop;
        next_value := supplied || jsonb_build_object(
          'required', coalesce((supplied->>'required')::boolean, false),
          'is_unique', coalesce((supplied->>'is_unique')::boolean, false),
          'target_model', coalesce(supplied->'target_model', 'null'::jsonb),
          'option_set', next_options,
          'origin', 'tenant', 'management', 'tenant_managed', 'lifecycle', 'active'
        );
        next_fields := next_fields || jsonb_build_array(next_value);
        current_field := null;
      else
        field_id := operation->>'field_id';
        select value, (ordinality - 1)::integer into current_field, field_index
        from jsonb_array_elements(next_fields) with ordinality where value->>'id' = field_id;
        if not found then
          return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
            'path', format('operations[%s].field_id', operation_index), 'code', 'unknown_lookup_field', 'message', 'lookup field does not exist'
          )));
        end if;
        if current_field->>'management' <> 'tenant_managed' then
          return kernel_admin_error('schema_management_forbidden', 'Schema definition is fixed', jsonb_build_array(jsonb_build_object(
            'path', format('operations[%s].field_id', operation_index), 'code', 'fixed_definition', 'message', 'lookup field is not tenant-manageable'
          )));
        end if;
        next_value := current_field;
        if operation_type = 'update_field' then
          supplied := operation - 'type' - 'model_id' - 'field_id';
          if jsonb_typeof(supplied) is distinct from 'object' then
            return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
              'path', format('operations[%s].changes', operation_index), 'code', 'invalid_field_update', 'message', 'field changes must be an object'
            )));
          end if;
          if supplied ? 'type' and supplied->>'type' is distinct from current_field->>'type' then
            return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
              'path', format('operations[%s].changes.type', operation_index), 'code', 'immutable_field_type', 'message', 'field type is immutable'
            )));
          end if;
          if supplied ? 'target_model' and supplied->'target_model' is distinct from current_field->'target_model' then
            return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
              'path', format('operations[%s].changes.target_model', operation_index), 'code', 'immutable_relation_target', 'message', 'relation target is immutable'
            )));
          end if;
          if exists (
            select 1 from jsonb_object_keys(supplied) as supplied_key(key_value)
            where key_value not in ('label', 'required', 'is_unique', 'management', 'type', 'target_model')
          ) then
            return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
              'path', format('operations[%s].changes', operation_index), 'code', 'immutable_field_property',
              'message', 'field update contains an unsupported or immutable property'
            )));
          end if;
          if supplied ? 'management' and supplied->>'management' <> 'tenant_managed' then
            return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
              'path', format('operations[%s].management', operation_index), 'code', 'invalid_management_transition',
              'message', 'tenant-managed definitions cannot be converted into fixed definitions'
            )));
          end if;
          if supplied ? 'label' then next_value := jsonb_set(next_value, '{label}', supplied->'label'); end if;
          if supplied ? 'required' then next_value := jsonb_set(next_value, '{required}', supplied->'required'); end if;
          if supplied ? 'is_unique' then next_value := jsonb_set(next_value, '{is_unique}', supplied->'is_unique'); end if;
        elsif operation_type = 'retire_field' then
          if current_model->>'display_field_id' = field_id then
            return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
              'path', format('operations[%s].field_id', operation_index), 'code', 'display_field_required',
              'message', 'the active display field cannot be retired'
            )));
          end if;
          if current_field->>'lifecycle' <> 'active' then
            return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
              'path', format('operations[%s].field_id', operation_index), 'code', 'invalid_lifecycle_transition', 'message', 'only an active field can be retired'
            )));
          end if;
          next_value := next_value || jsonb_build_object('lifecycle', 'retired', 'retired_at', mutation_at);
        else
          if current_field->>'lifecycle' <> 'retired' then
            return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
              'path', format('operations[%s].field_id', operation_index), 'code', 'invalid_lifecycle_transition', 'message', 'only a retired field can be restored'
            )));
          end if;
          next_value := (next_value - 'retired_at') || jsonb_build_object('lifecycle', 'active');
        end if;
        next_fields := jsonb_set(next_fields, array[field_index::text], next_value);
      end if;
      current_model := jsonb_set(current_model, '{fields}', next_fields);
      models := jsonb_set(models, array[model_index::text], current_model);
      changes := changes || jsonb_build_array(jsonb_build_object(
        'operation', operation_type, 'path', format('models.%s.fields.%s', model_id, field_id),
        'before', coalesce(current_field, 'null'::jsonb), 'after', next_value, 'actor_id', actor_id, 'changed_at', mutation_at
      ));

    elsif operation_type in ('create_many_relation', 'update_many_relation', 'retire_many_relation', 'restore_many_relation') then
      model_id := operation->>'model_id';
      select value, (ordinality - 1)::integer into current_model, model_index
      from jsonb_array_elements(models) with ordinality where value->>'id' = model_id;
      if not found or current_model->>'kind' <> 'lookup' or current_model->>'lifecycle' <> 'active' then
        return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
          'path', format('operations[%s].model_id', operation_index), 'code', 'unknown_active_lookup_model',
          'message', 'an active lookup model is required'
        )));
      end if;
      next_relations := coalesce(current_model->'many_relations', '[]'::jsonb);
      if operation_type = 'create_many_relation' then
        if current_model->>'management' <> 'tenant_managed' then
          return kernel_admin_error('schema_management_forbidden', 'Schema definition is fixed', jsonb_build_array(jsonb_build_object(
            'path', format('operations[%s].model_id', operation_index), 'code', 'fixed_definition',
            'message', 'fixed lookup model does not accept tenant-created many relations'
          )));
        end if;
        supplied := operation->'relation';
        field_id := supplied->>'id';
        if jsonb_typeof(supplied) is distinct from 'object' then
          return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
            'path', format('operations[%s].relation', operation_index), 'code', 'invalid_many_relation',
            'message', 'many relation must be an object'
          )));
        end if;
        if exists (select 1 from jsonb_array_elements(next_relations) where value->>'id' = field_id)
          or exists (select 1 from jsonb_array_elements(current_model->'fields') where value->>'id' = field_id)
        then
          return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
            'path', format('operations[%s].relation.id', operation_index), 'code', 'many_relation_id_reserved',
            'message', 'many-relation id already exists, collides with a field, or remains reserved after retirement'
          )));
        end if;
        next_value := supplied || jsonb_build_object(
          'origin', 'tenant', 'management', 'tenant_managed', 'lifecycle', 'active'
        );
        next_relations := next_relations || jsonb_build_array(next_value);
        current_relation := null;
      else
        field_id := operation->>'relation_id';
        select value, (ordinality - 1)::integer into current_relation, relation_index
        from jsonb_array_elements(next_relations) with ordinality where value->>'id' = field_id;
        if not found then
          return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
            'path', format('operations[%s].relation_id', operation_index), 'code', 'unknown_many_relation',
            'message', 'many relation does not exist'
          )));
        end if;
        if current_relation->>'management' <> 'tenant_managed' then
          return kernel_admin_error('schema_management_forbidden', 'Schema definition is fixed', jsonb_build_array(jsonb_build_object(
            'path', format('operations[%s].relation_id', operation_index), 'code', 'fixed_definition',
            'message', 'many relation is not tenant-manageable'
          )));
        end if;
        next_value := current_relation;
        if operation_type = 'update_many_relation' then
          supplied := operation - 'type' - 'model_id' - 'relation_id';
          if supplied ? 'target_model' and supplied->>'target_model' is distinct from current_relation->>'target_model' then
            return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
              'path', format('operations[%s].target_model', operation_index), 'code', 'immutable_relation_target',
              'message', 'many-relation target is immutable'
            )));
          end if;
          if exists (
            select 1 from jsonb_object_keys(supplied) as supplied_key(key_value)
            where key_value not in ('label', 'management', 'target_model')
          ) then
            return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
              'path', format('operations[%s]', operation_index), 'code', 'immutable_many_relation_property',
              'message', 'many-relation update contains an unsupported or immutable property'
            )));
          end if;
          if supplied ? 'management' and supplied->>'management' <> 'tenant_managed' then
            return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
              'path', format('operations[%s].management', operation_index), 'code', 'invalid_management_transition',
              'message', 'tenant-managed definitions cannot be converted into app-owned fixed definitions'
            )));
          end if;
          if supplied ? 'label' then next_value := jsonb_set(next_value, '{label}', supplied->'label'); end if;
        elsif operation_type = 'retire_many_relation' then
          if current_relation->>'lifecycle' <> 'active' then
            return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
              'path', format('operations[%s].relation_id', operation_index), 'code', 'invalid_lifecycle_transition',
              'message', 'only an active many relation can be retired'
            )));
          end if;
          next_value := next_value || jsonb_build_object('lifecycle', 'retired');
        else
          if current_relation->>'lifecycle' <> 'retired' then
            return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
              'path', format('operations[%s].relation_id', operation_index), 'code', 'invalid_lifecycle_transition',
              'message', 'only a retired many relation can be restored'
            )));
          end if;
          next_value := next_value || jsonb_build_object('lifecycle', 'active');
        end if;
        next_relations := jsonb_set(next_relations, array[relation_index::text], next_value);
      end if;
      current_model := jsonb_set(current_model, '{many_relations}', next_relations, true);
      models := jsonb_set(models, array[model_index::text], current_model);
      changes := changes || jsonb_build_array(jsonb_build_object(
        'operation', operation_type, 'path', format('models.%s.many_relations.%s', model_id, field_id),
        'before', coalesce(current_relation, 'null'::jsonb), 'after', next_value,
        'actor_id', actor_id, 'changed_at', mutation_at
      ));

    elsif operation_type in ('create_enum_option', 'update_enum_option', 'retire_enum_option', 'restore_enum_option', 'transfer_enum_alias') then
      model_id := operation->>'model_id';
      field_id := operation->>'field_id';
      target_kind := 'declared';
      select value, (ordinality - 1)::integer into current_model, model_index
      from jsonb_array_elements(models) with ordinality where value->>'id' = model_id;
      if found then
        next_fields := current_model->'fields';
        select value, (ordinality - 1)::integer into current_field, field_index
        from jsonb_array_elements(next_fields) with ordinality
        where value->>'id' = field_id and value->>'type' = 'enum';
      end if;
      if not found then
        target_kind := 'custom';
        select value, (ordinality - 1)::integer into current_field, custom_index
        from jsonb_array_elements(custom_fields) with ordinality
        where value->>'model_id' = model_id and value->>'field_id' = field_id and value->>'type' = 'enum';
        if not found then
          return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
            'path', format('operations[%s].field_id', operation_index), 'code', 'unknown_enum_target',
            'message', 'declared or custom enum target does not exist'
          )));
        end if;
      end if;
      if current_field->>'management' <> 'tenant_managed' then
        return kernel_admin_error('schema_management_forbidden', 'Schema definition is fixed', jsonb_build_array(jsonb_build_object(
          'path', format('operations[%s].field_id', operation_index), 'code', 'fixed_definition', 'message', 'enum option set is not tenant-manageable'
        )));
      end if;
      next_options := current_field->'option_set';
      if operation_type = 'transfer_enum_alias' then
        from_option_id := operation->>'from_option_id';
        to_option_id := operation->>'to_option_id';
        alias_text := operation->>'alias';
        select value, (ordinality - 1)::integer into current_option, from_option_index
        from jsonb_array_elements(next_options) with ordinality where value->>'id' = from_option_id;
        select value, (ordinality - 1)::integer into target_option, to_option_index
        from jsonb_array_elements(next_options) with ordinality where value->>'id' = to_option_id;
        if current_option is null or target_option is null or from_option_id = to_option_id
          or coalesce(kernel_admin_enum_match_key(alias_text), '') = ''
        then
          return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
            'path', format('operations[%s]', operation_index), 'code', 'invalid_alias_transfer',
            'message', 'alias transfer requires distinct existing source and target options plus a non-empty alias'
          )));
        end if;
        if current_option->>'management' <> 'tenant_managed' or target_option->>'management' <> 'tenant_managed' then
          return kernel_admin_error('schema_management_forbidden', 'Schema definition is fixed', jsonb_build_array(jsonb_build_object(
            'path', format('operations[%s]', operation_index), 'code', 'fixed_definition',
            'message', 'alias transfer requires tenant-managed source and target options'
          )));
        end if;
        if not exists (
          select 1 from jsonb_array_elements_text(coalesce(current_option->'aliases', '[]'::jsonb)) as source_alias(value)
          where kernel_admin_enum_match_key(value) = kernel_admin_enum_match_key(alias_text)
        ) then
          return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
            'path', format('operations[%s].alias', operation_index), 'code', 'alias_not_owned',
            'message', 'source option does not own the alias being transferred'
          )));
        end if;
        current_option := jsonb_set(current_option, '{aliases}', coalesce((
          select jsonb_agg(to_jsonb(value) order by ordinality)
          from jsonb_array_elements_text(coalesce(current_option->'aliases', '[]'::jsonb)) with ordinality as source_alias(value, ordinality)
          where kernel_admin_enum_match_key(value) <> kernel_admin_enum_match_key(alias_text)
        ), '[]'::jsonb));
        target_option := jsonb_set(target_option, '{aliases}', coalesce(target_option->'aliases', '[]'::jsonb) || to_jsonb(alias_text));
        next_options := jsonb_set(next_options, array[from_option_index::text], current_option);
        next_options := jsonb_set(next_options, array[to_option_index::text], target_option);
        next_value := target_option;
      elsif operation_type = 'create_enum_option' then
        supplied := operation->'option';
        option_id := supplied->>'id';
        if jsonb_typeof(supplied) is distinct from 'object' then
          return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
            'path', format('operations[%s].option', operation_index), 'code', 'invalid_enum_option', 'message', 'option must be an object'
          )));
        end if;
        if exists (select 1 from jsonb_array_elements(next_options) where value->>'id' = option_id) then
          return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
            'path', format('operations[%s].option.id', operation_index), 'code', 'enum_option_id_reserved',
            'message', 'enum option id already exists or remains reserved after retirement'
          )));
        end if;
        next_value := supplied || jsonb_build_object(
          'aliases', coalesce(supplied->'aliases', '[]'::jsonb),
          'origin', 'tenant', 'management', 'tenant_managed', 'lifecycle', 'active'
        );
        next_options := next_options || jsonb_build_array(next_value);
        current_option := null;
      else
        option_id := operation->>'option_id';
        select value, (ordinality - 1)::integer into current_option, option_index
        from jsonb_array_elements(next_options) with ordinality where value->>'id' = option_id;
        if not found then
          return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
            'path', format('operations[%s].option_id', operation_index), 'code', 'unknown_enum_option', 'message', 'enum option does not exist'
          )));
        end if;
        if current_option->>'management' <> 'tenant_managed' then
          return kernel_admin_error('schema_management_forbidden', 'Schema definition is fixed', jsonb_build_array(jsonb_build_object(
            'path', format('operations[%s].option_id', operation_index), 'code', 'fixed_definition', 'message', 'enum option is not tenant-manageable'
          )));
        end if;
        next_value := current_option;
        if operation_type = 'update_enum_option' then
          supplied := operation - 'type' - 'model_id' - 'field_id' - 'option_id';
          if jsonb_typeof(supplied) is distinct from 'object' or exists (
            select 1 from jsonb_object_keys(supplied) as supplied_key(key_value)
            where key_value not in ('label', 'aliases', 'management')
          ) then
            return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
              'path', format('operations[%s].changes', operation_index), 'code', 'immutable_enum_option_property',
              'message', 'enum option updates may only change label and aliases'
            )));
          end if;
          if supplied ? 'management' and supplied->>'management' <> 'tenant_managed' then
            return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
              'path', format('operations[%s].management', operation_index), 'code', 'invalid_management_transition',
              'message', 'tenant-managed definitions cannot be converted into fixed definitions'
            )));
          end if;
          if supplied ? 'label' then next_value := jsonb_set(next_value, '{label}', supplied->'label'); end if;
          if supplied ? 'aliases' then next_value := jsonb_set(next_value, '{aliases}', supplied->'aliases'); end if;
        elsif operation_type = 'retire_enum_option' then
          if current_option->>'lifecycle' <> 'active' then
            return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
              'path', format('operations[%s].option_id', operation_index), 'code', 'invalid_lifecycle_transition', 'message', 'only an active option can be retired'
            )));
          end if;
          next_value := next_value || jsonb_build_object('lifecycle', 'retired', 'retired_at', mutation_at);
        else
          if current_option->>'lifecycle' <> 'retired' then
            return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
              'path', format('operations[%s].option_id', operation_index), 'code', 'invalid_lifecycle_transition', 'message', 'only a retired option can be restored'
            )));
          end if;
          next_value := (next_value - 'retired_at') || jsonb_build_object('lifecycle', 'active');
        end if;
        next_options := jsonb_set(next_options, array[option_index::text], next_value);
      end if;
      current_field := jsonb_set(current_field, '{option_set}', next_options);
      if target_kind = 'declared' then
        next_fields := jsonb_set(next_fields, array[field_index::text], current_field);
        current_model := jsonb_set(current_model, '{fields}', next_fields);
        models := jsonb_set(models, array[model_index::text], current_model);
      else
        custom_fields := jsonb_set(custom_fields, array[custom_index::text], current_field);
      end if;
      changes := changes || jsonb_build_array(jsonb_build_object(
        'operation', operation_type,
        'path', format('%s.%s.%s.options.%s', target_kind, model_id, field_id, coalesce(option_id, alias_text)),
        'before', case when operation_type = 'transfer_enum_alias'
          then jsonb_build_object('from', from_option_id, 'to', to_option_id, 'alias', alias_text)
          else coalesce(current_option, 'null'::jsonb) end,
        'after', next_value,
        'actor_id', actor_id, 'changed_at', mutation_at
      ));

    elsif operation_type in ('create_custom_field', 'update_custom_field', 'retire_custom_field', 'restore_custom_field') then
      if operation_type = 'create_custom_field' then
        supplied := operation->'definition';
        if jsonb_typeof(supplied) is distinct from 'object' then
          return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
            'path', format('operations[%s].definition', operation_index), 'code', 'invalid_custom_field', 'message', 'custom field definition must be an object'
          )));
        end if;
        field_id := supplied->>'id';
        if exists (
          select 1 from jsonb_array_elements(custom_fields)
          where value->>'id' = field_id
            or (value->>'model_id' = supplied->>'model_id' and value->>'field_id' = supplied->>'field_id')
        ) then
          return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
            'path', format('operations[%s].definition.id', operation_index), 'code', 'custom_field_id_reserved',
            'message', 'custom-field identity already exists or remains reserved after retirement'
          )));
        end if;
        next_options := '[]'::jsonb;
        for current_option in select value from jsonb_array_elements(coalesce(supplied->'option_set', '[]'::jsonb))
        loop
          next_options := next_options || jsonb_build_array(
            current_option || jsonb_build_object('origin', 'tenant', 'management', 'tenant_managed', 'lifecycle', 'active')
          );
        end loop;
        next_value := supplied || jsonb_build_object(
          'target_model_id', coalesce(supplied->'target_model_id', 'null'::jsonb),
          'option_set', next_options,
          'origin', 'tenant', 'management', 'tenant_managed', 'lifecycle', 'active'
        );
        custom_fields := custom_fields || jsonb_build_array(next_value);
        current_custom := null;
        path_value := 'custom_fields.' || field_id;
      else
        field_id := operation->>'definition_id';
        select value, (ordinality - 1)::integer into current_custom, custom_index
        from jsonb_array_elements(custom_fields) with ordinality where value->>'id' = field_id;
        if not found then
          return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
            'path', format('operations[%s].field_id', operation_index), 'code', 'unknown_custom_field', 'message', 'custom field does not exist'
          )));
        end if;
        if current_custom->>'management' <> 'tenant_managed' then
          return kernel_admin_error('schema_management_forbidden', 'Schema definition is fixed', jsonb_build_array(jsonb_build_object(
            'path', format('operations[%s].field_id', operation_index), 'code', 'fixed_definition', 'message', 'custom field is not tenant-manageable'
          )));
        end if;
        next_value := current_custom;
        if operation_type = 'update_custom_field' then
          supplied := operation - 'type' - 'definition_id';
          if jsonb_typeof(supplied) is distinct from 'object' then
            return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
              'path', format('operations[%s].changes', operation_index), 'code', 'invalid_custom_field_update', 'message', 'custom-field changes must be an object'
            )));
          end if;
          if supplied ? 'type' and supplied->>'type' is distinct from current_custom->>'type' then
            return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
              'path', format('operations[%s].changes.type', operation_index), 'code', 'immutable_field_type', 'message', 'custom-field type is immutable'
            )));
          end if;
          if supplied ? 'target_model_id' and supplied->'target_model_id' is distinct from current_custom->'target_model_id' then
            return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
              'path', format('operations[%s].changes.target_model_id', operation_index), 'code', 'immutable_relation_target', 'message', 'custom relation target is immutable'
            )));
          end if;
          if exists (
            select 1 from jsonb_object_keys(supplied) as supplied_key(key_value)
            where key_value not in ('label', 'management', 'type', 'target_model_id')
          ) then
            return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
              'path', format('operations[%s].changes', operation_index), 'code', 'immutable_custom_field_property',
              'message', 'custom-field update contains an unsupported or immutable property'
            )));
          end if;
          if supplied ? 'management' and supplied->>'management' <> 'tenant_managed' then
            return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
              'path', format('operations[%s].management', operation_index), 'code', 'invalid_management_transition',
              'message', 'tenant-managed definitions cannot be converted into fixed definitions'
            )));
          end if;
          if supplied ? 'label' then next_value := jsonb_set(next_value, '{label}', supplied->'label'); end if;
        elsif operation_type = 'retire_custom_field' then
          if current_custom->>'lifecycle' <> 'active' then
            return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
              'path', format('operations[%s].field_id', operation_index), 'code', 'invalid_lifecycle_transition', 'message', 'only an active custom field can be retired'
            )));
          end if;
          next_value := next_value || jsonb_build_object(
            'lifecycle', 'retired',
            'archived_at', mutation_at
          );
        else
          if current_custom->>'lifecycle' <> 'retired' then
            return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
              'path', format('operations[%s].field_id', operation_index), 'code', 'invalid_lifecycle_transition', 'message', 'only a retired custom field can be restored'
            )));
          end if;
          next_value := (next_value - 'archived_at') || jsonb_build_object('lifecycle', 'active');
        end if;
        custom_fields := jsonb_set(custom_fields, array[custom_index::text], next_value);
        path_value := 'custom_fields.' || field_id;
      end if;
      changes := changes || jsonb_build_array(jsonb_build_object(
        'operation', operation_type, 'path', path_value,
        'before', coalesce(current_custom, 'null'::jsonb), 'after', next_value,
        'actor_id', actor_id, 'changed_at', mutation_at
      ));
    else
      return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
        'path', format('operations[%s].type', operation_index), 'code', 'unknown_tenant_schema_operation',
        'message', format('unsupported tenant schema operation `%s`', coalesce(operation_type, ''))
      )));
    end if;
  end loop;

  catalog := jsonb_build_object('models', models, 'custom_fields', custom_fields);
  -- A revision may not add a custom/declared field-id collision, but it must
  -- still be able to keep or retire one the active catalog already holds.
  issues := kernel_tenant_schema_validate_catalog(catalog)
    || kernel_admin_custom_field_collision_issues(catalog, initial_catalog);
  if jsonb_array_length(issues) > 0 then
    return kernel_admin_validation_error(issues);
  end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('catalog', catalog, 'changes', changes));
exception
  when invalid_text_representation or numeric_value_out_of_range then
    return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
      'path', 'operations', 'code', 'invalid_value', 'message', 'operation contains a value with an invalid type'
    )));
end;
$kernel$;
"#;

const KERNEL_TENANT_SCHEMA_EFFECTIVE_SCHEMA: &str = r#"
create or replace function kernel_tenant_schema_effective_schema(active_schema jsonb, catalog jsonb, next_version text)
returns jsonb
language plpgsql
immutable
parallel safe
security invoker
set search_path from current
as $kernel$
declare
  effective jsonb := active_schema;
  models jsonb;
  custom_fields jsonb;
begin
  select coalesce(jsonb_agg(kernel_tenant_schema_strip_model(value) order by ordinality), '[]'::jsonb)
  into models from jsonb_array_elements(catalog->'models') with ordinality;
  select coalesce(jsonb_agg(kernel_tenant_schema_strip_custom_field(value) order by ordinality), '[]'::jsonb)
  into custom_fields from jsonb_array_elements(catalog->'custom_fields') with ordinality;
  effective := jsonb_set(effective, '{models}', models);
  effective := jsonb_set(effective, '{custom_fields}', custom_fields, true);
  effective := jsonb_set(effective, '{version}', to_jsonb(next_version));
  return effective;
end;
$kernel$;
"#;

const KERNEL_TENANT_SCHEMA_OVERLAY: &str = r#"
create or replace function kernel_tenant_schema_overlay(active_overlay jsonb, catalog jsonb, operations jsonb)
returns jsonb
language plpgsql
immutable
parallel safe
security invoker
set search_path from current
as $kernel$
declare
  tenant_state jsonb := coalesce(active_overlay->'tenant_schema', '{}'::jsonb);
  change_paths jsonb := coalesce(tenant_state->'change_paths', '[]'::jsonb);
  operation jsonb;
  operation_type text;
  model_id text;
  field_id text;
  option_id text;
  definition_id text;
  target_prefix text;
  property_name text;
begin
  if jsonb_typeof(operations) is distinct from 'array' then
    raise exception using
      errcode = '23514', message = 'tenant_schema_overlay_invalid',
      detail = jsonb_build_object(
        'path', 'operations', 'code', 'invalid_operations',
        'message', 'tenant schema overlay provenance requires an operation array'
      )::text;
  end if;
  if tenant_state <> '{}'::jsonb
    and not (tenant_state ? 'provenance_version')
    and (
      jsonb_array_length(coalesce(tenant_state->'model_overrides', '[]'::jsonb)) > 0
      or jsonb_array_length(coalesce(tenant_state->'custom_field_overrides', '[]'::jsonb)) > 0
    )
  then
    raise exception using
      errcode = '23514', message = 'tenant_schema_rebase_conflict',
      detail = jsonb_build_object(
        'path', 'customer_overlay.tenant_schema',
        'code', 'legacy_tenant_overlay_requires_provenance',
        'message', 'review the legacy app overrides, record provenance_version 1 and explicit immutable-id change_paths, then retry'
      )::text,
      hint = 'Prepare a tenant-overlay revision that retains the reviewed definitions, adds provenance_version 1 and sorted change_paths, and activates through the normal expected-hash CAS';
  end if;
  if tenant_state ? 'provenance_version'
    and (
      tenant_state->>'provenance_version' <> '1'
      or jsonb_typeof(tenant_state->'change_paths') is distinct from 'array'
      or exists (
        select 1 from jsonb_array_elements(tenant_state->'change_paths') item(value)
        where jsonb_typeof(value) <> 'string'
      )
    )
  then
    raise exception using
      errcode = '23514', message = 'tenant_schema_rebase_conflict',
      detail = jsonb_build_object(
        'path', 'customer_overlay.tenant_schema.change_paths',
        'code', 'invalid_tenant_override_provenance',
        'message', 'tenant schema provenance must use version 1 and an array of immutable-id change paths'
      )::text;
  end if;

  for operation in select value from jsonb_array_elements(operations)
  loop
    operation_type := operation->>'type';
    model_id := operation->>'model_id';
    field_id := operation->>'field_id';
    option_id := operation->>'option_id';
    definition_id := operation->>'definition_id';
    if operation_type = 'update_model' then
      foreach property_name in array array['label']
      loop
        if operation ? property_name then
          change_paths := change_paths || to_jsonb('models.' || model_id || '.' || property_name);
        end if;
      end loop;
    elsif operation_type in ('retire_model', 'restore_model') then
      change_paths := change_paths || to_jsonb('models.' || model_id || '.lifecycle');
    elsif operation_type = 'update_field' then
      foreach property_name in array array['label', 'required', 'is_unique']
      loop
        if operation ? property_name then
          change_paths := change_paths || to_jsonb(
            'models.' || model_id || '.fields.' || field_id || '.' || property_name
          );
        end if;
      end loop;
    elsif operation_type in ('retire_field', 'restore_field') then
      change_paths := change_paths || to_jsonb(
        'models.' || model_id || '.fields.' || field_id || '.lifecycle'
      );
    elsif operation_type = 'update_many_relation' then
      if operation ? 'label' then
        change_paths := change_paths || to_jsonb(
          'models.' || model_id || '.many_relations.' || (operation->>'relation_id') || '.label'
        );
      end if;
    elsif operation_type in ('retire_many_relation', 'restore_many_relation') then
      change_paths := change_paths || to_jsonb(
        'models.' || model_id || '.many_relations.' || (operation->>'relation_id') || '.lifecycle'
      );
    elsif operation_type in ('update_enum_option', 'retire_enum_option', 'restore_enum_option', 'transfer_enum_alias') then
      if exists (
        select 1 from jsonb_array_elements(coalesce(catalog->'custom_fields', '[]'::jsonb))
        where value->>'model_id' = model_id and value->>'field_id' = field_id
      ) then
        select value->>'id' into definition_id
        from jsonb_array_elements(coalesce(catalog->'custom_fields', '[]'::jsonb))
        where value->>'model_id' = model_id and value->>'field_id' = field_id;
        target_prefix := 'custom_fields.' || definition_id || '.options.';
      else
        target_prefix := 'models.' || model_id || '.fields.' || field_id || '.options.';
      end if;
      if operation_type = 'update_enum_option' then
        foreach property_name in array array['label', 'aliases']
        loop
          if operation ? property_name then
            change_paths := change_paths || to_jsonb(target_prefix || option_id || '.' || property_name);
          end if;
        end loop;
      elsif operation_type in ('retire_enum_option', 'restore_enum_option') then
        change_paths := change_paths || to_jsonb(target_prefix || option_id || '.lifecycle');
      else
        change_paths := change_paths || to_jsonb(target_prefix || (operation->>'from_option_id') || '.aliases');
        change_paths := change_paths || to_jsonb(target_prefix || (operation->>'to_option_id') || '.aliases');
      end if;
    elsif operation_type = 'update_custom_field' then
      foreach property_name in array array['label']
      loop
        if operation ? property_name then
          change_paths := change_paths || to_jsonb(
            'custom_fields.' || definition_id || '.' || property_name
          );
        end if;
      end loop;
    elsif operation_type in ('retire_custom_field', 'restore_custom_field') then
      change_paths := change_paths || to_jsonb(
        'custom_fields.' || definition_id || '.lifecycle'
      );
    end if;
  end loop;
  select coalesce(jsonb_agg(to_jsonb(path_value) order by path_value), '[]'::jsonb)
  into change_paths
  from (
    select distinct value #>> '{}' as path_value
    from jsonb_array_elements(change_paths)
  ) paths;

  return jsonb_set(
    coalesce(active_overlay, '{}'::jsonb),
    '{tenant_schema}',
    jsonb_build_object(
      'provenance_version', 1,
      'change_paths', change_paths,
      'models', coalesce((
        select jsonb_agg(value order by ordinality)
        from jsonb_array_elements(catalog->'models') with ordinality
        where value->>'origin' = 'tenant'
      ), '[]'::jsonb),
      'model_overrides', coalesce((
        select jsonb_agg(value order by ordinality)
        from jsonb_array_elements(catalog->'models') with ordinality
        where value->>'origin' = 'app'
          and (
            value->>'management' <> 'fixed'
            or value->>'lifecycle' <> 'active'
            or coalesce(value->>'display_field_id', '') <> ''
            or coalesce((value #>> '{extensions,typed_custom_fields}')::boolean, false)
            or exists (
              select 1 from jsonb_array_elements(coalesce(value->'fields', '[]'::jsonb)) as field(field_value)
              where field_value->>'management' <> 'fixed' or field_value->>'lifecycle' <> 'active'
            )
            or exists (
              select 1 from jsonb_array_elements(coalesce(value->'many_relations', '[]'::jsonb)) as relation(relation_value)
              where relation_value->>'management' <> 'fixed' or relation_value->>'lifecycle' <> 'active'
            )
          )
      ), '[]'::jsonb),
      'custom_fields', coalesce((
        select jsonb_agg(value order by ordinality)
        from jsonb_array_elements(catalog->'custom_fields') with ordinality
        where value->>'origin' = 'tenant'
      ), '[]'::jsonb),
      'custom_field_overrides', coalesce((
        select jsonb_agg(value order by ordinality)
        from jsonb_array_elements(catalog->'custom_fields') with ordinality
        where value->>'origin' = 'app'
          and (
            value->>'management' <> 'fixed'
            or value->>'lifecycle' <> 'active'
            or exists (
              select 1 from jsonb_array_elements(coalesce(value->'option_set', '[]'::jsonb)) as option(option_value)
              where option_value->>'management' <> 'fixed' or option_value->>'lifecycle' <> 'active'
            )
          )
      ), '[]'::jsonb)
    ),
    true
  );
end;
$kernel$;
"#;

const KERNEL_TENANT_SCHEMA_AFFECTED_REFERENCES: &str = r#"
create or replace function kernel_tenant_schema_affected_references(
  scope_app_id text,
  scope_customer_id text,
  catalog jsonb,
  operations jsonb
)
returns jsonb
language plpgsql
stable
parallel safe
security invoker
set search_path from current
as $kernel$
<<affected_reference_scan>>
declare
  result jsonb := '[]'::jsonb;
  operation jsonb;
  operation_type text;
  model_id text;
  field_id text;
  option_id text;
  definition jsonb;
  source_model jsonb;
  relation_field jsonb;
  relation_definition jsonb;
  source_kind text;
  version_table text;
  relation_column text;
  query_sql text;
  additional_count bigint;
  visible_count bigint;
  historical_count bigint;
begin
  for operation in select value from jsonb_array_elements(operations)
  loop
    operation_type := operation->>'type';
    model_id := operation->>'model_id';
    field_id := operation->>'field_id';
    option_id := operation->>'option_id';
    visible_count := 0;
    historical_count := 0;

    if operation_type = 'retire_model' then
      select count(*) into historical_count
      from lookup_relation_projection projection
      where projection.app_id = scope_app_id
        and projection.customer_id = scope_customer_id
        and projection.target_model_id = affected_reference_scan.model_id;
      with visible_versions as (
        select distinct on (version.model_id, version.record_id) version.model_id, version.id
        from lookup_version version
        join change_set changes
          on changes.id = version.change_set_id
         and changes.app_id = version.app_id
         and changes.customer_id = version.customer_id
         and changes.status = 'mainline'
         and changes.applied_order is not null
        where version.app_id = scope_app_id
          and version.customer_id = scope_customer_id
          and version.stage = 'mainline'
          and version.effective_start <= current_date
          and (version.effective_end is null or version.effective_end >= current_date)
        order by version.model_id, version.record_id, version.effective_start desc,
          version.tombstones_record desc, version.untombstones_record desc,
          changes.applied_order desc, version.id desc
      )
      select count(*) into visible_count
      from lookup_relation_projection projection
      join visible_versions visible
        on visible.model_id = projection.source_model_id
       and visible.id = projection.version_id
      where projection.app_id = scope_app_id
        and projection.customer_id = scope_customer_id
        and projection.target_model_id = affected_reference_scan.model_id;

      for source_model in
        select value
        from jsonb_array_elements(catalog->'models') item(value)
        where value->>'kind' = 'entity'
      loop
        version_table := kernel_read_physical_identifier(source_model->>'id' || '_version');
        for relation_field in
          select value
          from jsonb_array_elements(coalesce(source_model->'fields', '[]'::jsonb)) item(value)
          where value->>'type' = 'relation'
            and value->>'target_model' = affected_reference_scan.model_id
        loop
          relation_column := kernel_read_physical_identifier(relation_field->>'id');
          query_sql := format(
            'select count(*) from %I version where version.app_id=$1 and version.customer_id=$2 and version.%I is not null',
            version_table, relation_column
          );
          execute query_sql using scope_app_id, scope_customer_id into additional_count;
          historical_count := historical_count + additional_count;
          query_sql := format(
            $query$
            with visible_versions as (
              select distinct on (version.record_id) version.*
              from %I version
              join change_set changes
                on changes.id=version.change_set_id
               and changes.app_id=version.app_id
               and changes.customer_id=version.customer_id
               and changes.status='mainline'
               and changes.applied_order is not null
              where version.app_id=$1 and version.customer_id=$2
                and version.stage='mainline'
                and version.effective_start <= current_date
                and (version.effective_end is null or version.effective_end >= current_date)
              order by version.record_id,version.effective_start desc,
                version.tombstones_record desc,version.untombstones_record desc,
                changes.applied_order desc,version.id desc
            )
            select count(*) from visible_versions version
            where not version.tombstones_record and not version.untombstones_record
              and version.%I is not null
            $query$,
            version_table, relation_column
          );
          execute query_sql using scope_app_id, scope_customer_id into additional_count;
          visible_count := visible_count + additional_count;
        end loop;
      end loop;

      for relation_definition in
        select value
        from jsonb_array_elements(coalesce(catalog->'custom_fields', '[]'::jsonb)) item(value)
        where value->>'type' = 'relation'
          and value->>'target_model_id' = affected_reference_scan.model_id
      loop
        select value->>'kind' into source_kind
        from jsonb_array_elements(catalog->'models') item(value)
        where value->>'id' = relation_definition->>'model_id';
        if source_kind = 'lookup' then
          select count(*) into additional_count
          from lookup_version version
          cross join lateral jsonb_array_elements(coalesce(version.custom_fields, '[]'::jsonb)) custom(value)
          where version.app_id = scope_app_id
            and version.customer_id = scope_customer_id
            and version.model_id = relation_definition->>'model_id'
            and custom.value->>'field_id' = relation_definition->>'field_id';
          historical_count := historical_count + additional_count;
          with visible_versions as (
            select distinct on (version.record_id) version.*
            from lookup_version version
            join change_set changes
              on changes.id=version.change_set_id
             and changes.app_id=version.app_id
             and changes.customer_id=version.customer_id
             and changes.status='mainline'
             and changes.applied_order is not null
            where version.app_id=scope_app_id
              and version.customer_id=scope_customer_id
              and version.model_id=relation_definition->>'model_id'
              and version.stage='mainline'
              and version.effective_start <= current_date
              and (version.effective_end is null or version.effective_end >= current_date)
            order by version.record_id,version.effective_start desc,
              version.tombstones_record desc,version.untombstones_record desc,
              changes.applied_order desc,version.id desc
          )
          select count(*) into additional_count
          from visible_versions version
          cross join lateral jsonb_array_elements(coalesce(version.custom_fields, '[]'::jsonb)) custom(value)
          where not version.tombstones_record and not version.untombstones_record
            and custom.value->>'field_id' = relation_definition->>'field_id';
          visible_count := visible_count + additional_count;
        elsif source_kind = 'entity' then
          version_table := kernel_read_physical_identifier(
            (relation_definition->>'model_id') || '_version'
          );
          query_sql := format(
            $query$
            select count(*) from %I version
            cross join lateral jsonb_array_elements(coalesce(version.custom_fields,'[]'::jsonb)) custom(value)
            where version.app_id=$1 and version.customer_id=$2
              and custom.value->>'field_id'=$3
            $query$,
            version_table
          );
          execute query_sql using scope_app_id, scope_customer_id,
            relation_definition->>'field_id' into additional_count;
          historical_count := historical_count + additional_count;
          query_sql := format(
            $query$
            with visible_versions as (
              select distinct on (version.record_id) version.*
              from %I version
              join change_set changes
                on changes.id=version.change_set_id
               and changes.app_id=version.app_id
               and changes.customer_id=version.customer_id
               and changes.status='mainline'
               and changes.applied_order is not null
              where version.app_id=$1 and version.customer_id=$2
                and version.stage='mainline'
                and version.effective_start <= current_date
                and (version.effective_end is null or version.effective_end >= current_date)
              order by version.record_id,version.effective_start desc,
                version.tombstones_record desc,version.untombstones_record desc,
                changes.applied_order desc,version.id desc
            )
            select count(*) from visible_versions version
            cross join lateral jsonb_array_elements(coalesce(version.custom_fields,'[]'::jsonb)) custom(value)
            where not version.tombstones_record and not version.untombstones_record
              and custom.value->>'field_id'=$3
            $query$,
            version_table
          );
          execute query_sql using scope_app_id, scope_customer_id,
            relation_definition->>'field_id' into additional_count;
          visible_count := visible_count + additional_count;
        end if;
      end loop;
    elsif operation_type in ('retire_field', 'retire_many_relation') then
      field_id := coalesce(field_id, operation->>'relation_id');
      select count(*) into historical_count
      from (
        select projection.model_id, projection.version_id
        from lookup_value_projection projection
        where projection.app_id = scope_app_id
          and projection.customer_id = scope_customer_id
          and projection.model_id = affected_reference_scan.model_id
          and projection.field_id = affected_reference_scan.field_id
          and affected_reference_scan.operation_type = 'retire_field'
        union all
        select projection.source_model_id as model_id, projection.version_id
        from lookup_relation_projection projection
        where projection.app_id = scope_app_id
          and projection.customer_id = scope_customer_id
          and projection.source_model_id = affected_reference_scan.model_id
          and projection.field_id = affected_reference_scan.field_id
          and affected_reference_scan.operation_type = 'retire_many_relation'
      ) reference_rows;
      with visible_versions as (
        select distinct on (version.model_id, version.record_id) version.model_id, version.id
        from lookup_version version
        join change_set changes
          on changes.id = version.change_set_id
         and changes.app_id = version.app_id
         and changes.customer_id = version.customer_id
         and changes.status = 'mainline'
         and changes.applied_order is not null
        where version.app_id = scope_app_id
          and version.customer_id = scope_customer_id
          and version.model_id = affected_reference_scan.model_id
          and version.stage = 'mainline'
          and version.effective_start <= current_date
          and (version.effective_end is null or version.effective_end >= current_date)
        order by version.model_id, version.record_id, version.effective_start desc,
          version.tombstones_record desc, version.untombstones_record desc,
          changes.applied_order desc, version.id desc
      ), reference_rows as (
        select projection.model_id, projection.version_id
        from lookup_value_projection projection
        where projection.app_id = scope_app_id
          and projection.customer_id = scope_customer_id
          and projection.model_id = affected_reference_scan.model_id
          and projection.field_id = affected_reference_scan.field_id
          and affected_reference_scan.operation_type = 'retire_field'
        union all
        select projection.source_model_id as model_id, projection.version_id
        from lookup_relation_projection projection
        where projection.app_id = scope_app_id
          and projection.customer_id = scope_customer_id
          and projection.source_model_id = affected_reference_scan.model_id
          and projection.field_id = affected_reference_scan.field_id
          and affected_reference_scan.operation_type = 'retire_many_relation'
      )
      select count(*) into visible_count
      from reference_rows
      join visible_versions visible
        on visible.model_id = reference_rows.model_id
       and visible.id = reference_rows.version_id;
    elsif operation_type = 'retire_enum_option' then
      select count(*) into historical_count
      from lookup_value_projection projection
      where projection.app_id = scope_app_id
        and projection.customer_id = scope_customer_id
        and projection.model_id = affected_reference_scan.model_id
        and projection.field_id = affected_reference_scan.field_id
        and projection.text_value = affected_reference_scan.option_id;
      with visible_versions as (
        select distinct on (version.record_id) version.model_id, version.id
        from lookup_version version
        join change_set changes
          on changes.id = version.change_set_id
         and changes.app_id = version.app_id
         and changes.customer_id = version.customer_id
         and changes.status = 'mainline'
         and changes.applied_order is not null
        where version.app_id = scope_app_id
          and version.customer_id = scope_customer_id
          and version.model_id = affected_reference_scan.model_id
          and version.stage = 'mainline'
          and version.effective_start <= current_date
          and (version.effective_end is null or version.effective_end >= current_date)
        order by version.record_id, version.effective_start desc,
          version.tombstones_record desc, version.untombstones_record desc,
          changes.applied_order desc, version.id desc
      )
      select count(*) into visible_count
      from lookup_value_projection projection
      join visible_versions visible
        on visible.model_id = projection.model_id
       and visible.id = projection.version_id
      where projection.app_id = scope_app_id
        and projection.customer_id = scope_customer_id
        and projection.model_id = affected_reference_scan.model_id
        and projection.field_id = affected_reference_scan.field_id
        and projection.text_value = affected_reference_scan.option_id;

      select field.value into definition
      from jsonb_array_elements(catalog->'models') model(value)
      cross join lateral jsonb_array_elements(coalesce(model.value->'fields', '[]'::jsonb)) field(value)
      where model.value->>'id' = affected_reference_scan.model_id
        and field.value->>'id' = affected_reference_scan.field_id
        and field.value->>'type' = 'enum';
      if definition is not null then
        select value->>'kind' into source_kind
        from jsonb_array_elements(catalog->'models') item(value)
        where value->>'id' = affected_reference_scan.model_id;
        if source_kind = 'entity' then
          version_table := kernel_read_physical_identifier(affected_reference_scan.model_id || '_version');
          relation_column := kernel_read_physical_identifier(affected_reference_scan.field_id);
          query_sql := format(
            'select count(*) from %I version where version.app_id=$1 and version.customer_id=$2 and version.%I=$3',
            version_table, relation_column
          );
          execute query_sql using scope_app_id, scope_customer_id, option_id into additional_count;
          historical_count := historical_count + additional_count;
          query_sql := format(
            $query$
            with visible_versions as (
              select distinct on (version.record_id) version.*
              from %I version
              join change_set changes
                on changes.id=version.change_set_id
               and changes.app_id=version.app_id
               and changes.customer_id=version.customer_id
               and changes.status='mainline'
               and changes.applied_order is not null
              where version.app_id=$1 and version.customer_id=$2
                and version.stage='mainline'
                and version.effective_start <= current_date
                and (version.effective_end is null or version.effective_end >= current_date)
              order by version.record_id,version.effective_start desc,
                version.tombstones_record desc,version.untombstones_record desc,
                changes.applied_order desc,version.id desc
            )
            select count(*) from visible_versions version
            where not version.tombstones_record and not version.untombstones_record
              and version.%I=$3
            $query$,
            version_table, relation_column
          );
          execute query_sql using scope_app_id, scope_customer_id, option_id into additional_count;
          visible_count := visible_count + additional_count;
        end if;
      else
        select value into definition
        from jsonb_array_elements(coalesce(catalog->'custom_fields', '[]'::jsonb)) item(value)
        where value->>'model_id' = affected_reference_scan.model_id
          and value->>'field_id' = affected_reference_scan.field_id
          and value->>'type' = 'enum';
        if definition is not null then
          select value->>'kind' into source_kind
          from jsonb_array_elements(catalog->'models') item(value)
          where value->>'id' = affected_reference_scan.model_id;
          if source_kind = 'lookup' then
            select count(*) into additional_count
            from lookup_version version
            cross join lateral jsonb_array_elements(coalesce(version.custom_fields, '[]'::jsonb)) custom(value)
            where version.app_id = scope_app_id
              and version.customer_id = scope_customer_id
              and version.model_id = affected_reference_scan.model_id
              and custom.value->>'field_id' = affected_reference_scan.field_id
              and custom.value->>'type' = 'enum'
              and custom.value->>'value' = affected_reference_scan.option_id;
            historical_count := historical_count + additional_count;
            with visible_versions as (
              select distinct on (version.record_id) version.*
              from lookup_version version
              join change_set changes
                on changes.id=version.change_set_id
               and changes.app_id=version.app_id
               and changes.customer_id=version.customer_id
               and changes.status='mainline'
               and changes.applied_order is not null
              where version.app_id=scope_app_id
                and version.customer_id=scope_customer_id
                and version.model_id=affected_reference_scan.model_id
                and version.stage='mainline'
                and version.effective_start <= current_date
                and (version.effective_end is null or version.effective_end >= current_date)
              order by version.record_id,version.effective_start desc,
                version.tombstones_record desc,version.untombstones_record desc,
                changes.applied_order desc,version.id desc
            )
            select count(*) into additional_count
            from visible_versions version
            cross join lateral jsonb_array_elements(coalesce(version.custom_fields, '[]'::jsonb)) custom(value)
            where not version.tombstones_record and not version.untombstones_record
              and custom.value->>'field_id' = affected_reference_scan.field_id
              and custom.value->>'type' = 'enum'
              and custom.value->>'value' = affected_reference_scan.option_id;
            visible_count := visible_count + additional_count;
          elsif source_kind = 'entity' then
            version_table := kernel_read_physical_identifier(affected_reference_scan.model_id || '_version');
            query_sql := format(
              $query$
              select count(*) from %I version
              cross join lateral jsonb_array_elements(coalesce(version.custom_fields,'[]'::jsonb)) custom(value)
              where version.app_id=$1 and version.customer_id=$2
                and custom.value->>'field_id'=$3 and custom.value->>'type'='enum'
                and custom.value->>'value'=$4
              $query$,
              version_table
            );
            execute query_sql using scope_app_id, scope_customer_id, field_id, option_id into additional_count;
            historical_count := historical_count + additional_count;
            query_sql := format(
              $query$
              with visible_versions as (
                select distinct on (version.record_id) version.*
                from %I version
                join change_set changes
                  on changes.id=version.change_set_id
                 and changes.app_id=version.app_id
                 and changes.customer_id=version.customer_id
                 and changes.status='mainline'
                 and changes.applied_order is not null
                where version.app_id=$1 and version.customer_id=$2
                  and version.stage='mainline'
                  and version.effective_start <= current_date
                  and (version.effective_end is null or version.effective_end >= current_date)
                order by version.record_id,version.effective_start desc,
                  version.tombstones_record desc,version.untombstones_record desc,
                  changes.applied_order desc,version.id desc
              )
              select count(*) from visible_versions version
              cross join lateral jsonb_array_elements(coalesce(version.custom_fields,'[]'::jsonb)) custom(value)
              where not version.tombstones_record and not version.untombstones_record
                and custom.value->>'field_id'=$3 and custom.value->>'type'='enum'
                and custom.value->>'value'=$4
              $query$,
              version_table
            );
            execute query_sql using scope_app_id, scope_customer_id, field_id, option_id into additional_count;
            visible_count := visible_count + additional_count;
          end if;
        end if;
      end if;
    elsif operation_type = 'retire_custom_field' then
      select value into definition
      from jsonb_array_elements(coalesce(catalog->'custom_fields', '[]'::jsonb)) item(value)
      where value->>'id' = operation->>'definition_id';
      model_id := definition->>'model_id';
      field_id := definition->>'field_id';
      select value->>'kind' into source_kind
      from jsonb_array_elements(catalog->'models') item(value)
      where value->>'id' = affected_reference_scan.model_id;
      if source_kind = 'lookup' then
        select count(*) into historical_count
        from lookup_version version
        cross join lateral jsonb_array_elements(coalesce(version.custom_fields, '[]'::jsonb)) custom(value)
        where version.app_id = scope_app_id
          and version.customer_id = scope_customer_id
          and version.model_id = affected_reference_scan.model_id
          and custom.value->>'field_id' = affected_reference_scan.field_id;
        with visible_versions as (
          select distinct on (version.record_id) version.*
          from lookup_version version
          join change_set changes
            on changes.id = version.change_set_id
           and changes.app_id = version.app_id
           and changes.customer_id = version.customer_id
           and changes.status = 'mainline'
           and changes.applied_order is not null
          where version.app_id = scope_app_id
            and version.customer_id = scope_customer_id
            and version.model_id = affected_reference_scan.model_id
            and version.stage = 'mainline'
            and version.effective_start <= current_date
            and (version.effective_end is null or version.effective_end >= current_date)
          order by version.record_id, version.effective_start desc,
            version.tombstones_record desc, version.untombstones_record desc,
            changes.applied_order desc, version.id desc
        )
        select count(*) into visible_count
        from visible_versions version
        cross join lateral jsonb_array_elements(coalesce(version.custom_fields, '[]'::jsonb)) custom(value)
        where not version.tombstones_record and not version.untombstones_record
          and custom.value->>'field_id' = affected_reference_scan.field_id;
      elsif source_kind = 'entity' then
        version_table := kernel_read_physical_identifier(
          affected_reference_scan.model_id || '_version'
        );
        query_sql := format(
          $query$
          select count(*) from %I version
          cross join lateral jsonb_array_elements(coalesce(version.custom_fields,'[]'::jsonb)) custom(value)
          where version.app_id=$1 and version.customer_id=$2
            and custom.value->>'field_id'=$3
          $query$,
          version_table
        );
        execute query_sql using scope_app_id, scope_customer_id,
          affected_reference_scan.field_id into historical_count;
        query_sql := format(
          $query$
          with visible_versions as (
            select distinct on (version.record_id) version.*
            from %I version
            join change_set changes
              on changes.id=version.change_set_id
             and changes.app_id=version.app_id
             and changes.customer_id=version.customer_id
             and changes.status='mainline'
             and changes.applied_order is not null
            where version.app_id=$1 and version.customer_id=$2
              and version.stage='mainline'
              and version.effective_start <= current_date
              and (version.effective_end is null or version.effective_end >= current_date)
            order by version.record_id,version.effective_start desc,
              version.tombstones_record desc,version.untombstones_record desc,
              changes.applied_order desc,version.id desc
          )
          select count(*) from visible_versions version
          cross join lateral jsonb_array_elements(coalesce(version.custom_fields,'[]'::jsonb)) custom(value)
          where not version.tombstones_record and not version.untombstones_record
            and custom.value->>'field_id'=$3
          $query$,
          version_table
        );
        execute query_sql using scope_app_id, scope_customer_id,
          affected_reference_scan.field_id into visible_count;
      end if;
    else
      continue;
    end if;

    result := result || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'model_id', model_id,
      'field_id', field_id,
      'option_id', option_id,
      'visible_reference_count', visible_count,
      'historical_reference_count', historical_count
    )));
  end loop;
  return result;
end;
$kernel$;
"#;

const KERNEL_TENANT_SCHEMA_PREPARATION_PLAN: &str = r#"
create or replace function kernel_tenant_schema_preparation_plan(
  initial_catalog jsonb,
  next_catalog jsonb,
  operations jsonb
)
returns jsonb
language plpgsql
immutable
parallel safe
security invoker
set search_path from current
as $kernel$
declare
  plan jsonb := '[]'::jsonb;
  operation jsonb;
  operation_type text;
  model_id text;
  field_id text;
  before_field jsonb;
  after_field jsonb;
begin
  for operation in select value from jsonb_array_elements(operations)
  loop
    operation_type := operation->>'type';
    if operation_type not in ('create_field', 'update_field', 'restore_field') then
      continue;
    end if;
    model_id := operation->>'model_id';
    field_id := coalesce(operation->>'field_id', operation#>>'{field,id}');
    select field.value into before_field
    from jsonb_array_elements(initial_catalog->'models') model(value)
    cross join lateral jsonb_array_elements(model.value->'fields') field(value)
    where model.value->>'id' = model_id and field.value->>'id' = field_id;
    select field.value into after_field
    from jsonb_array_elements(next_catalog->'models') model(value)
    cross join lateral jsonb_array_elements(model.value->'fields') field(value)
    where model.value->>'id' = model_id and field.value->>'id' = field_id;

    if coalesce((after_field->>'required')::boolean, false)
      and (
        before_field is null
        or not coalesce((before_field->>'required')::boolean, false)
        or coalesce(before_field->>'lifecycle', 'active') <> 'active'
      )
    then
      plan := plan || jsonb_build_array(jsonb_build_object(
        'id', 'required:' || model_id || ':' || field_id,
        'kind', 'validate_required_lookup_field',
        'model_id', model_id,
        'field_id', field_id
      ));
    end if;
    if coalesce((after_field->>'is_unique')::boolean, false)
      and (
        before_field is null
        or not coalesce((before_field->>'is_unique')::boolean, false)
        or coalesce(before_field->>'lifecycle', 'active') <> 'active'
      )
    then
      plan := plan || jsonb_build_array(jsonb_build_object(
        'id', 'unique:' || model_id || ':' || field_id,
        'kind', 'validate_unique_lookup_field',
        'model_id', model_id,
        'field_id', field_id
      ));
    end if;
  end loop;
  return plan;
end;
$kernel$;
"#;

const KERNEL_TENANT_SCHEMA_RUN_PREPARATION: &str = r#"
create or replace function kernel_tenant_schema_run_preparation(
  scope_app_id text,
  scope_customer_id text,
  phase_plan jsonb
)
returns jsonb
language plpgsql
stable
parallel safe
security invoker
set search_path from current
as $kernel$
<<run_preparation>>
declare
  results jsonb := '[]'::jsonb;
  phase jsonb;
  phase_kind text;
  model_id text;
  field_id text;
  invalid_count bigint;
begin
  for phase in
    select value from jsonb_array_elements(phase_plan)
    where value->>'kind' <> 'tenant_schema_mutation'
  loop
    phase_kind := phase->>'kind';
    model_id := phase->>'model_id';
    field_id := phase->>'field_id';
    if phase_kind = 'validate_required_lookup_field' then
      with mainline_versions as (
        select version.*, changes.applied_order
        from lookup_version version
        join change_set changes
          on changes.id = version.change_set_id
         and changes.app_id = version.app_id
         and changes.customer_id = version.customer_id
         and changes.status = 'mainline'
         and changes.applied_order is not null
        where version.app_id = scope_app_id
          and version.customer_id = scope_customer_id
          and version.model_id = run_preparation.model_id
          and version.stage = 'mainline'
      ), temporal_boundaries as (
        select effective_start as boundary_date from mainline_versions
        union
        select effective_end + 1 from mainline_versions where effective_end is not null
      ), visible_versions as (
        select distinct on (boundary.boundary_date, version.record_id)
          boundary.boundary_date, version.*
        from temporal_boundaries boundary
        join mainline_versions version
          on version.effective_start <= boundary.boundary_date
         and (version.effective_end is null or version.effective_end >= boundary.boundary_date)
        order by boundary.boundary_date, version.record_id, version.effective_start desc,
          version.tombstones_record desc, version.untombstones_record desc,
          version.applied_order desc, version.id desc
      )
      select count(*) into invalid_count
      from visible_versions version
      where not version.tombstones_record
        and (
          not (version.values ? run_preparation.field_id)
          or version.values->run_preparation.field_id = 'null'::jsonb
        );
      if invalid_count > 0 then
        return kernel_admin_error(
          'schema_preparation_failed',
          'Tenant schema preparation did not validate',
          jsonb_build_array(jsonb_build_object(
            'path', 'operations',
            'code', 'required_field_backfill_required',
            'message', format('field `%s.%s` is missing from %s visible lookup record(s)', model_id, field_id, invalid_count),
            'model_id', model_id,
            'field_id', field_id,
            'invalid_record_count', invalid_count
          ))
        );
      end if;
    elsif phase_kind = 'validate_unique_lookup_field' then
      with mainline_versions as (
        select version.*, changes.applied_order
        from lookup_version version
        join change_set changes
          on changes.id = version.change_set_id
         and changes.app_id = version.app_id
         and changes.customer_id = version.customer_id
         and changes.status = 'mainline'
         and changes.applied_order is not null
        where version.app_id = scope_app_id
          and version.customer_id = scope_customer_id
          and version.model_id = run_preparation.model_id
          and version.stage = 'mainline'
      ), temporal_boundaries as (
        select effective_start as boundary_date from mainline_versions
        union
        select effective_end + 1 from mainline_versions where effective_end is not null
      ), visible_versions as (
        select distinct on (boundary.boundary_date, version.record_id)
          boundary.boundary_date, version.*
        from temporal_boundaries boundary
        join mainline_versions version
          on version.effective_start <= boundary.boundary_date
         and (version.effective_end is null or version.effective_end >= boundary.boundary_date)
        order by boundary.boundary_date, version.record_id, version.effective_start desc,
          version.tombstones_record desc, version.untombstones_record desc,
          version.applied_order desc, version.id desc
      )
      select coalesce(sum(duplicate_count - 1), 0) into invalid_count
      from (
        select count(*) as duplicate_count
        from visible_versions version
        where not version.tombstones_record
          and version.values ? run_preparation.field_id
          and version.values->run_preparation.field_id <> 'null'::jsonb
        group by version.boundary_date, version.values->run_preparation.field_id
        having count(*) > 1
      ) duplicates;
      if invalid_count > 0 then
        return kernel_admin_error(
          'schema_preparation_failed',
          'Tenant schema preparation did not validate',
          jsonb_build_array(jsonb_build_object(
            'path', 'operations',
            'code', 'unique_field_conflicts',
            'message', format('field `%s.%s` has %s conflicting visible lookup record value(s)', model_id, field_id, invalid_count),
            'model_id', model_id,
            'field_id', field_id,
            'invalid_record_count', invalid_count
          ))
        );
      end if;
    else
      return kernel_admin_error(
        'schema_preparation_failed',
        'Tenant schema preparation contains an unsupported phase',
        jsonb_build_array(jsonb_build_object(
          'path', 'phase_plan', 'code', 'unsupported_preparation_phase', 'message', coalesce(phase_kind, '<missing>')
        ))
      );
    end if;
    results := results || jsonb_build_array(phase || jsonb_build_object(
      'status', 'validated', 'invalid_record_count', 0
    ));
  end loop;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('phase_results', results));
end;
$kernel$;
"#;

const KERNEL_TENANT_SCHEMA_EXECUTE: &str = r#"
create or replace function kernel_tenant_schema_execute(request jsonb, dry_run boolean)
returns jsonb
language plpgsql
volatile
parallel unsafe
security invoker
set search_path from current
as $kernel$
<<tenant_schema_execution>>
declare
  app_id text;
  customer_id text;
  actor_id text;
  reason text;
  idempotency_key text;
  expected_revision_id bigint;
  expected_effective_hash text;
  request_fingerprint text;
  authorization_result jsonb;
  scalar_issues jsonb;
  active_id bigint;
  active_base jsonb;
  active_overlay jsonb;
  active_schema jsonb;
  active_schema_hash text;
  active_base_hash text;
  active_effective_hash text;
  catalog jsonb;
  operation_result jsonb;
  next_catalog jsonb;
  changes jsonb;
  next_overlay jsonb;
  next_schema jsonb;
  next_version text;
  next_hash text;
  next_revision_id bigint;
  next_number bigint;
  plan_hash text;
  ledger_row record;
  replay_result jsonb;
  affected_references jsonb := '[]'::jsonb;
  preparation_plan jsonb := '[]'::jsonb;
  preparation_result jsonb;
  preparation_results jsonb := '[]'::jsonb;
  audit_phase jsonb;
  is_resume boolean := false;
  mutation_at text := to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
begin
  if jsonb_typeof(request) is distinct from 'object' then
    return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
      'path', 'request', 'code', 'invalid_request', 'message', 'request must be a JSON object'
    )));
  end if;
  if exists (
    select 1 from jsonb_object_keys(request) as supplied(key)
    where supplied.key not in (
      'app_id', 'customer_id', 'actor_id', 'reason', 'idempotency_key',
      'expected_revision_id', 'expected_effective_hash', 'operations'
    )
  ) then
    return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
      'path', 'request', 'code', 'unknown_field', 'message', 'request contains a field outside the tenant schema revision contract'
    )));
  end if;
  app_id := request->>'app_id';
  customer_id := request->>'customer_id';
  actor_id := request->>'actor_id';
  reason := request->>'reason';
  idempotency_key := request->>'idempotency_key';
  expected_effective_hash := request->>'expected_effective_hash';
  if coalesce(btrim(app_id), '') = '' or coalesce(btrim(customer_id), '') = ''
    or coalesce(btrim(actor_id), '') = '' or coalesce(btrim(reason), '') = ''
    or coalesce(btrim(idempotency_key), '') = ''
  then
    return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
      'path', 'request', 'code', 'required',
      'message', 'app_id, customer_id, actor_id, reason, and idempotency_key are required'
    )));
  end if;
  if jsonb_typeof(request->'expected_revision_id') not in ('number', 'string')
    or (request->>'expected_revision_id')::numeric <> trunc((request->>'expected_revision_id')::numeric)
    or (request->>'expected_revision_id')::numeric <= 0
    or (request->>'expected_revision_id')::numeric > 9223372036854775807
  then
    return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
      'path', 'expected_revision_id', 'code', 'invalid_schema_revision_id', 'message', 'expected_revision_id must be a positive integer'
    )));
  end if;
  expected_revision_id := (request->>'expected_revision_id')::bigint;
  if expected_effective_hash is null or expected_effective_hash !~ '^[0-9a-f]{64}$' then
    return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
      'path', 'expected_effective_hash', 'code', 'invalid_schema_hash', 'message', 'expected_effective_hash must be a lowercase SHA-256 hash'
    )));
  end if;
  if jsonb_typeof(request->'operations') is distinct from 'array' or jsonb_array_length(request->'operations') = 0 then
    return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
      'path', 'operations', 'code', 'invalid_operations', 'message', 'at least one typed tenant schema operation is required'
    )));
  end if;
  scalar_issues := kernel_tenant_schema_scalar_issues(request->'operations', 'operations');
  if jsonb_array_length(scalar_issues) > 0 then
    return kernel_admin_validation_error(scalar_issues);
  end if;
  authorization_result := kernel_authorize_scope(
    'schema_admin', app_id, customer_id, actor_id
  );
  if authorization_result is not null then
    return authorization_result;
  end if;
  perform set_config('kernel.app_id', app_id, true);
  perform set_config('kernel.customer_id', customer_id, true);

  request_fingerprint := kernel_admin_sha256(kernel_canonical_json(request));
  perform kernel_installer_lock_app(app_id, false);
  perform pg_advisory_xact_lock(hashtext(
    'postgres-schema:' || current_schema() || ':materialize-tenant:'
      || app_id || ':' || customer_id || ':schema-activation'
  )::bigint);

  if not dry_run then
    select sr.id as schema_revision_id,
           sr.schema,
           sir.effective_artifact_hash,
           sir.phase_plan,
           sir.phase_results->0->'result' as result,
           coalesce(
             sir.phase_plan->0->>'request_fingerprint',
             sir.phase_results->0->>'request_fingerprint'
           ) as fingerprint,
           sir.activated_at
    into ledger_row
    from schema_installation_revision sir
    join schema_revision sr on sr.id = sir.schema_revision_id
    where sir.app_id = tenant_schema_execution.app_id
      and sir.customer_id = tenant_schema_execution.customer_id
      and sir.release_id = 'tenant-schema:' || tenant_schema_execution.idempotency_key
    order by sir.schema_revision_id desc
    limit 1;
    if found then
      if ledger_row.fingerprint is distinct from request_fingerprint then
        return kernel_admin_error('idempotency_conflict', 'Idempotency key was reused for a different request', jsonb_build_array(jsonb_build_object(
          'path', 'idempotency_key', 'code', 'idempotency_conflict',
          'message', 'use a new idempotency key or replay the exact request'
        )));
      end if;
      if ledger_row.activated_at is not null then
        return jsonb_build_object('ok', true, 'data', ledger_row.result);
      end if;
      is_resume := true;
    end if;
  end if;

  select sr.id, sr.base_schema, sr.customer_overlay, sr.schema, sr.schema_hash,
         coalesce(sir.base_artifact_hash, kernel_admin_sha256(kernel_canonical_json(sr.base_schema))),
         coalesce(sir.effective_artifact_hash, sr.schema_hash, kernel_admin_sha256(kernel_canonical_json(sr.schema)))
  into active_id, active_base, active_overlay, active_schema, active_schema_hash,
       active_base_hash, active_effective_hash
  from schema_revision sr
  left join schema_installation_revision sir on sir.schema_revision_id = sr.id
  where sr.app_id = tenant_schema_execution.app_id
    and sr.customer_id = tenant_schema_execution.customer_id
    and sr.activated_at is not null
  for update of sr;
  if not found then
    return kernel_admin_error('active_schema_missing', 'No active schema revision exists for this scope', jsonb_build_array(jsonb_build_object(
      'path', 'scope', 'code', 'active_schema_missing', 'message', app_id || '/' || customer_id || ': materialize a schema first'
    )));
  end if;
  if active_id <> expected_revision_id then
    return kernel_admin_error('stale_schema_revision', 'The supplied schema revision is not active', jsonb_build_array(jsonb_build_object(
      'path', 'expected_revision_id', 'code', 'stale_schema_revision',
      'message', format('Supplied schema_revision_id is %s; active schema_revision_id is %s', expected_revision_id, active_id)
    )));
  end if;
  if active_effective_hash is distinct from expected_effective_hash then
    return kernel_admin_error('schema_activation_conflict', 'Schema activation conflict', jsonb_build_array(jsonb_build_object(
      'path', 'expected_effective_hash', 'code', 'expected_hash_mismatch',
      'message', 'active effective schema hash changed before tenant schema mutation'
    )));
  end if;

  catalog := kernel_tenant_schema_catalog(active_schema, active_overlay);
  if is_resume then
    next_revision_id := ledger_row.schema_revision_id;
    next_schema := ledger_row.schema;
    next_hash := ledger_row.effective_artifact_hash;
    preparation_plan := ledger_row.phase_plan;
  else
    operation_result := kernel_tenant_schema_apply_operations(
      catalog,
      request->'operations',
      actor_id,
      mutation_at,
      app_id || ':' || customer_id || ':' || idempotency_key
    );
    if not coalesce((operation_result->>'ok')::boolean, false) then
      return operation_result;
    end if;
    next_catalog := operation_result->'data'->'catalog';
    changes := operation_result->'data'->'changes';
    affected_references := kernel_tenant_schema_affected_references(
      app_id, customer_id, catalog, request->'operations'
    );
    preparation_plan := kernel_tenant_schema_preparation_plan(
      catalog, next_catalog, request->'operations'
    );
    select count(*) + 1 into next_number
    from schema_revision
    where schema_revision.app_id = tenant_schema_execution.app_id
      and schema_revision.customer_id = tenant_schema_execution.customer_id
      and schema_revision.materialization_source = 'kernel.commit_tenant_schema_revision';
    next_version := (active_base->>'version') || '+ts' || next_number::text;
    next_overlay := kernel_tenant_schema_overlay(active_overlay, next_catalog, request->'operations');
    next_schema := kernel_tenant_schema_effective_schema(active_schema, next_catalog, next_version);
    next_hash := kernel_admin_sha256(kernel_canonical_json(next_schema));

    if dry_run then
      preparation_result := kernel_tenant_schema_run_preparation(
        app_id, customer_id, preparation_plan
      );
      if not coalesce((preparation_result->>'ok')::boolean, false) then
        return preparation_result;
      end if;
      return jsonb_build_object('ok', true, 'data', jsonb_build_object(
        'baseline_revision_id', active_id,
        'candidate_effective_hash', next_hash,
        'candidate_schema', next_schema,
        'affected_references', affected_references
      ));
    end if;

    insert into schema_revision (
      app_id, customer_id, version, base_schema, customer_overlay, schema, schema_hash,
      materialization_source, materialized_at
    ) values (
      tenant_schema_execution.app_id, tenant_schema_execution.customer_id,
      next_version, active_base, next_overlay, next_schema, next_hash,
      'kernel.commit_tenant_schema_revision', now()
    ) returning id into next_revision_id;
    -- Tenant overlays cannot author declared constraints. Copy the active
    -- compiler-produced identities to the new effective revision so an
    -- extension never consults a mutable source catalog or stale revision.
    insert into schema_constraint_identity (schema_revision_id, app_id, customer_id, catalog)
    select next_revision_id, identity_value.app_id, identity_value.customer_id, identity_value.catalog
    from schema_constraint_identity as identity_value
    where identity_value.schema_revision_id = active_id;
    audit_phase := jsonb_build_object(
      'kind', 'tenant_schema_mutation',
      'request_fingerprint', request_fingerprint,
      'actor_id', actor_id,
      'reason', reason,
      'before', jsonb_build_object('schema_revision_id', active_id, 'effective_hash', active_effective_hash),
      'after', jsonb_build_object('schema_revision_id', next_revision_id, 'effective_hash', next_hash),
      'changes', changes,
      'affected_references', affected_references
    );
    preparation_plan := jsonb_build_array(audit_phase) || preparation_plan;
    plan_hash := kernel_admin_sha256(kernel_canonical_json(preparation_plan));
    insert into schema_installation_revision (
      schema_revision_id, app_id, customer_id, release_id, activation_kind,
      base_artifact_hash, effective_artifact_hash, materialization_plan_hash,
      expected_active_effective_hash, phase_plan, phase_results,
      prepared_at, ready_at, activated_at
    ) values (
      next_revision_id, tenant_schema_execution.app_id, tenant_schema_execution.customer_id,
      'tenant-schema:' || tenant_schema_execution.idempotency_key, 'tenant_overlay',
      active_base_hash, next_hash, plan_hash, active_effective_hash,
      preparation_plan, null, now(), null, null
    );
  end if;

  preparation_result := kernel_tenant_schema_run_preparation(
    app_id, customer_id, preparation_plan
  );
  if not coalesce((preparation_result->>'ok')::boolean, false) then
    audit_phase := preparation_plan->0 || jsonb_build_object(
      'last_failed_preparation', preparation_result->'error'
    );
    preparation_plan := jsonb_set(preparation_plan, '{0}', audit_phase);
    update schema_installation_revision
    set phase_plan = preparation_plan,
        materialization_plan_hash = kernel_admin_sha256(kernel_canonical_json(preparation_plan))
    where schema_revision_id = next_revision_id
      and ready_at is null
      and activated_at is null;
    return preparation_result;
  end if;
  preparation_results := coalesce(preparation_result->'data'->'phase_results', '[]'::jsonb);
  replay_result := jsonb_build_object(
    'schema_revision_id', next_revision_id,
    'effective_hash', next_hash,
    'schema', next_schema
  );
  audit_phase := preparation_plan->0 || jsonb_build_object('result', replay_result, 'status', 'validated');
  update schema_installation_revision
  set phase_results = jsonb_build_array(audit_phase) || preparation_results,
      ready_at = now(),
      activated_at = now()
  where schema_revision_id = next_revision_id;
  update schema_revision set activated_at = null
  where schema_revision.app_id = tenant_schema_execution.app_id
    and schema_revision.customer_id = tenant_schema_execution.customer_id
    and schema_revision.id <> next_revision_id and schema_revision.activated_at is not null;
  update schema_revision set activated_at = now() where schema_revision.id = next_revision_id;
  return jsonb_build_object('ok', true, 'data', replay_result);
exception
  when unique_violation then
    return kernel_admin_error('schema_revision_conflict', 'Schema revision already exists with conflicting identity', '[]'::jsonb);
  when serialization_failure or deadlock_detected then
    raise;
  when others then
    return kernel_admin_error('database_error', 'Database operation failed', '[]'::jsonb);
end;
$kernel$;
"#;

const KERNEL_DRY_RUN_TENANT_SCHEMA_REVISION: &str = r#"
create or replace function kernel_dry_run_tenant_schema_revision(request jsonb)
returns jsonb
language sql
volatile
parallel unsafe
security invoker
set search_path from current
as $kernel$
  select kernel_tenant_schema_execute(request, true)
$kernel$;
"#;

const KERNEL_COMMIT_TENANT_SCHEMA_REVISION: &str = r#"
create or replace function kernel_commit_tenant_schema_revision(request jsonb)
returns jsonb
language sql
volatile
parallel unsafe
security invoker
set search_path from current
as $kernel$
  select kernel_tenant_schema_execute(request, false)
$kernel$;
"#;
