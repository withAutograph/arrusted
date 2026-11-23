use super::RuntimeSqlFunction;

pub(super) fn functions() -> Vec<RuntimeSqlFunction> {
    vec![
        function("kernel_admin_error(text,text,jsonb)", KERNEL_ADMIN_ERROR),
        function(
            "kernel_admin_validation_error(jsonb)",
            KERNEL_ADMIN_VALIDATION_ERROR,
        ),
        function(
            "kernel_admin_normalize_identifier(text)",
            KERNEL_ADMIN_NORMALIZE_IDENTIFIER,
        ),
        function("kernel_admin_sha256(text)", KERNEL_ADMIN_SHA256),
        function(
            "kernel_admin_bounded_identifier(text)",
            KERNEL_ADMIN_BOUNDED_IDENTIFIER,
        ),
        function(
            "kernel_admin_enum_match_key(text)",
            KERNEL_ADMIN_ENUM_MATCH_KEY,
        ),
        function(
            "kernel_admin_validate_enum_options(jsonb,boolean)",
            KERNEL_ADMIN_VALIDATE_ENUM_OPTIONS,
        ),
        function(
            "kernel_admin_custom_field_collision_issues(jsonb,jsonb)",
            KERNEL_ADMIN_CUSTOM_FIELD_COLLISION_ISSUES,
        ),
        function(
            "kernel_admin_apply_overlay(jsonb,jsonb)",
            KERNEL_ADMIN_APPLY_OVERLAY,
        ),
        function(
            "kernel_admin_materialization_error(jsonb,jsonb)",
            KERNEL_ADMIN_MATERIALIZATION_ERROR,
        ),
        function(
            "kernel_schema_revision_is_active_with_materialized_tables(jsonb)",
            KERNEL_SCHEMA_REVISION_IS_ACTIVE_WITH_MATERIALIZED_TABLES,
        ),
        function("kernel_record_agent_run(jsonb)", KERNEL_RECORD_AGENT_RUN),
        function(
            "kernel_update_agent_run_status(jsonb)",
            KERNEL_UPDATE_AGENT_RUN_STATUS,
        ),
    ]
}

fn function(signature: &'static str, sql: &str) -> RuntimeSqlFunction {
    RuntimeSqlFunction {
        signature,
        sql: sql.to_string(),
    }
}

const KERNEL_ADMIN_ERROR: &str = r#"
create or replace function kernel_admin_error(error_code text, error_message text, error_details jsonb default '[]'::jsonb)
returns jsonb
language sql
immutable
parallel safe
as $kernel$
  select jsonb_build_object(
    'ok', false,
    'error', jsonb_build_object(
      'code', error_code,
      'message', error_message,
      'details', coalesce(error_details, '[]'::jsonb)
    )
  )
$kernel$
"#;

const KERNEL_ADMIN_VALIDATION_ERROR: &str = r#"
create or replace function kernel_admin_validation_error(error_details jsonb)
returns jsonb
language sql
immutable
parallel safe
as $kernel$
  select kernel_admin_error(
    'contract_validation_failed',
    'Contract validation failed',
    error_details
  )
$kernel$
"#;

const KERNEL_ADMIN_NORMALIZE_IDENTIFIER: &str = r#"
create or replace function kernel_admin_normalize_identifier(raw_identifier text)
returns text
language plpgsql
immutable
parallel safe
as $kernel$
declare
  normalized text;
begin
  if raw_identifier is null
    or btrim(raw_identifier) = ''
    or raw_identifier ~ '[^A-Za-z0-9_[:space:]-]'
  then
    return null;
  end if;
  normalized := trim(both '_' from regexp_replace(lower(btrim(raw_identifier)), '[_[:space:]-]+', '_', 'g'));
  if normalized = '' or normalized !~ '^[a-z]' then
    return null;
  end if;
  return normalized;
end;
$kernel$
"#;

// An active custom field may not reuse a declared field or many-relation id of
// its model, retired declared fields included, compared after identifier
// normalization. Same rule and code as the compiler validator. Collisions that
// `prior_schema` already had are tolerated, so a tenant that already holds one
// can still activate and retire it; pass '{}' to report every collision.
const KERNEL_ADMIN_CUSTOM_FIELD_COLLISION_ISSUES: &str = r#"
create or replace function kernel_admin_custom_field_collision_issues(schema_json jsonb, prior_schema jsonb)
returns jsonb
language sql
immutable
parallel safe
security invoker
set search_path from current
as $kernel$
  with collisions as (
    select source.name, custom.value, custom.ordinal
    from (values ('current', schema_json), ('prior', prior_schema)) source(name, schema_value)
    cross join jsonb_array_elements(coalesce(source.schema_value->'custom_fields', '[]'::jsonb))
      with ordinality custom(value, ordinal)
    where coalesce(custom.value->>'lifecycle', 'active') = 'active'
      and exists (
        select 1
        from jsonb_array_elements(coalesce(source.schema_value->'models', '[]'::jsonb)) model(value)
        cross join jsonb_array_elements(
          coalesce(model.value->'fields', '[]'::jsonb) || coalesce(model.value->'many_relations', '[]'::jsonb)
        ) declared(value)
        where model.value->>'id' = custom.value->>'model_id'
          and kernel_admin_normalize_identifier(declared.value->>'id')
            = kernel_admin_normalize_identifier(custom.value->>'field_id')
      )
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'path', format('custom_fields[%s].field_id', incoming.ordinal - 1),
    'code', 'custom_field_declared_field_collision',
    'message', format('custom field `%s` collides with a declared field on model `%s`',
      incoming.value->>'field_id', incoming.value->>'model_id')
  ) order by incoming.ordinal), '[]'::jsonb)
  from collisions incoming
  where incoming.name = 'current'
    and not exists (
      select 1 from collisions earlier
      where earlier.name = 'prior'
        and earlier.value->>'model_id' = incoming.value->>'model_id'
        and kernel_admin_normalize_identifier(earlier.value->>'field_id')
          = kernel_admin_normalize_identifier(incoming.value->>'field_id')
    )
$kernel$
"#;

const KERNEL_ADMIN_SHA256: &str = r#"
create or replace function kernel_admin_sha256(input_value text)
returns text
language sql
immutable
strict
parallel safe
as $kernel$
  select encode(sha256(convert_to(input_value, 'UTF8')), 'hex')
$kernel$
"#;

const KERNEL_ADMIN_BOUNDED_IDENTIFIER: &str = r#"
create or replace function kernel_admin_bounded_identifier(raw_identifier text)
returns text
language sql
immutable
strict
parallel safe
as $kernel$
  select kernel_physical_identifier(raw_identifier)
$kernel$
"#;

const KERNEL_ADMIN_ENUM_MATCH_KEY: &str = r#"
create or replace function kernel_admin_enum_match_key(raw_value text)
returns text
language sql
immutable
parallel safe
as $kernel$
  select btrim(regexp_replace(lower(btrim(coalesce(raw_value, ''))), '[[:space:]_-]+', ' ', 'g'))
$kernel$
"#;

const KERNEL_ADMIN_VALIDATE_ENUM_OPTIONS: &str = r#"
create or replace function kernel_admin_validate_enum_options(options jsonb, custom_target boolean)
returns jsonb
language plpgsql
immutable
parallel safe
as $kernel$
declare
  issues jsonb := '[]'::jsonb;
  seen_ids jsonb := '{}'::jsonb;
  seen_keys jsonb := '{}'::jsonb;
  reported_keys jsonb := '{}'::jsonb;
  option_value jsonb;
  alias_value jsonb;
  option_index integer;
  alias_index integer;
  original_id text;
  normalized_id text;
  match_key text;
  prior_id text;
  duplicate_id_code text := case when custom_target then 'duplicate_custom_option_id' else 'duplicate_option_id' end;
  duplicate_alias_code text := case when custom_target then 'duplicate_custom_option_alias' else 'duplicate_option_alias' end;
begin
  if options is null or jsonb_typeof(options) <> 'array' then
    return jsonb_build_array(jsonb_build_object(
      'path', 'options', 'code', 'invalid_option_set',
      'message', 'enum option set must be supplied as a JSON array'
    ));
  end if;
  if jsonb_array_length(options) = 0 then
    return jsonb_build_array(jsonb_build_object(
      'path', 'options', 'code', 'empty_option_set',
      'message', 'enum option set must not be empty'
    ));
  end if;

  for option_value, option_index in
    select value, (ordinality - 1)::integer
    from jsonb_array_elements(options) with ordinality
  loop
    if jsonb_typeof(option_value) <> 'object' then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'path', format('options[%s]', option_index), 'code', 'invalid_option',
        'message', 'enum option must be a JSON object'
      ));
      continue;
    end if;
    original_id := option_value->>'id';
    normalized_id := kernel_admin_normalize_identifier(original_id);
    if normalized_id is null then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'path', format('options[%s].id', option_index), 'code', 'invalid_identifier',
        'message', 'enum option id must normalize to an identifier beginning with an ASCII letter'
      ));
      continue;
    end if;
    if coalesce(btrim(option_value->>'label'), '') = '' then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'path', format('options[%s].label', option_index), 'code', 'empty_value',
        'message', 'value must not be empty'
      ));
    end if;
    if seen_ids ? normalized_id then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'path', format('options[%s].id', option_index), 'code', duplicate_id_code,
        'message', format('enum option id `%s` is duplicated', original_id)
      ));
    else
      seen_ids := seen_ids || jsonb_build_object(normalized_id, original_id);
    end if;

    match_key := kernel_admin_enum_match_key(original_id);
    prior_id := seen_keys->>match_key;
    if prior_id is not null and prior_id <> original_id and not (reported_keys ? match_key) then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'path', format('options[%s].id', option_index), 'code', duplicate_alias_code,
        'message', format('enum option id `%s` collides with an existing option match key for option `%s`', original_id, prior_id)
      ));
      reported_keys := reported_keys || jsonb_build_object(match_key, true);
    elsif prior_id is null then
      seen_keys := seen_keys || jsonb_build_object(match_key, original_id);
    end if;

    match_key := kernel_admin_enum_match_key(option_value->>'label');
    if match_key <> '' then
      prior_id := seen_keys->>match_key;
      if prior_id is not null and prior_id <> original_id and not (reported_keys ? match_key) then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'path', format('options[%s].label', option_index), 'code', duplicate_alias_code,
          'message', format('enum option label `%s` is also declared for option `%s`', option_value->>'label', prior_id)
        ));
        reported_keys := reported_keys || jsonb_build_object(match_key, true);
      elsif prior_id is null then
        seen_keys := seen_keys || jsonb_build_object(match_key, original_id);
      end if;
    end if;

    if option_value ? 'aliases' and jsonb_typeof(option_value->'aliases') <> 'array' then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'path', format('options[%s].aliases', option_index), 'code', 'invalid_option_aliases',
        'message', 'enum option aliases must be a JSON array'
      ));
      continue;
    end if;
    for alias_value, alias_index in
      select value, (ordinality - 1)::integer
      from jsonb_array_elements(coalesce(option_value->'aliases', '[]'::jsonb)) with ordinality
    loop
      if jsonb_typeof(alias_value) <> 'string' then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'path', format('options[%s].aliases[%s]', option_index, alias_index),
          'code', 'invalid_option_alias', 'message', 'enum option alias must be a string'
        ));
        continue;
      end if;
      match_key := kernel_admin_enum_match_key(alias_value #>> '{}');
      if match_key = '' then
        continue;
      end if;
      prior_id := seen_keys->>match_key;
      if prior_id is not null and prior_id <> original_id and not (reported_keys ? match_key) then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'path', format('options[%s].aliases[%s]', option_index, alias_index),
          'code', duplicate_alias_code,
          'message', format('enum option alias `%s` is also declared for option `%s`', alias_value #>> '{}', prior_id)
        ));
        reported_keys := reported_keys || jsonb_build_object(match_key, true);
      elsif prior_id is null then
        seen_keys := seen_keys || jsonb_build_object(match_key, original_id);
      end if;
    end loop;
  end loop;
  return issues;
end;
$kernel$
"#;

const KERNEL_ADMIN_APPLY_OVERLAY: &str = r#"
create or replace function kernel_admin_apply_overlay(base_schema jsonb, revision_overlay jsonb)
returns jsonb
language plpgsql
immutable
parallel safe
as $kernel$
declare
  effective_schema jsonb := base_schema;
  overlay_entry jsonb;
  model_index integer;
  field_index integer;
  base_options jsonb;
  tenant_state jsonb;
  model_override jsonb;
  tenant_model jsonb;
  base_model jsonb;
  rebased_model jsonb;
  base_models jsonb;
  rebased_models jsonb;
  override_fields jsonb;
  base_field jsonb;
  override_field jsonb;
  tenant_field jsonb;
  rebased_field jsonb;
  rebased_fields jsonb;
  override_relations jsonb;
  base_relation jsonb;
  override_relation jsonb;
  tenant_relation jsonb;
  rebased_relation jsonb;
  rebased_relations jsonb;
  override_options jsonb;
  base_option jsonb;
  override_option jsonb;
  tenant_option jsonb;
  rebased_option jsonb;
  rebased_options jsonb;
  option_issues jsonb;
  base_custom_fields jsonb;
  rebased_custom_fields jsonb;
  custom_override jsonb;
  tenant_custom jsonb;
  base_custom jsonb;
  rebased_custom jsonb;
  target_model_id text;
  change_paths jsonb;
  path_prefix text;
  has_explicit_override boolean;
  has_tenant_children boolean;
begin
  for overlay_entry in
    select value from jsonb_array_elements(coalesce(revision_overlay->'declared_enum_option_additions', '[]'::jsonb))
  loop
    select (model_ord - 1)::integer, (field_ord - 1)::integer
    into model_index, field_index
    from jsonb_array_elements(effective_schema->'models') with ordinality as models(model_value, model_ord)
    cross join lateral jsonb_array_elements(model_value->'fields') with ordinality as fields(field_value, field_ord)
    where model_value->>'id' = overlay_entry->>'model_id'
      and field_value->>'id' = overlay_entry->>'field_id';
    if found then
      base_options := coalesce(effective_schema #> array['models', model_index::text, 'fields', field_index::text, 'option_set'], '[]'::jsonb);
      effective_schema := jsonb_set(
        effective_schema,
        array['models', model_index::text, 'fields', field_index::text, 'option_set'],
        base_options || coalesce(overlay_entry->'option_set', '[]'::jsonb),
        true
      );
    end if;
  end loop;

  for overlay_entry in
    select value from jsonb_array_elements(coalesce(revision_overlay->'custom_enum_option_sets', '[]'::jsonb))
  loop
    select (ordinality - 1)::integer
    into field_index
    from jsonb_array_elements(coalesce(effective_schema->'custom_fields', '[]'::jsonb)) with ordinality
    where value->>'model_id' = overlay_entry->>'model_id'
      and value->>'field_id' = overlay_entry->>'field_id'
      and coalesce(value->>'archived_at', '') = '';
    if found then
      effective_schema := jsonb_set(
        effective_schema,
        array['custom_fields', field_index::text, 'option_set'],
        coalesce(overlay_entry->'option_set', '[]'::jsonb),
        true
      );
    end if;
  end loop;

  tenant_state := revision_overlay->'tenant_schema';
  if tenant_state is null then
    return effective_schema;
  end if;
  if jsonb_typeof(tenant_state) is distinct from 'object'
    or jsonb_typeof(coalesce(tenant_state->'models', '[]'::jsonb)) is distinct from 'array'
    or jsonb_typeof(coalesce(tenant_state->'model_overrides', '[]'::jsonb)) is distinct from 'array'
    or jsonb_typeof(coalesce(tenant_state->'custom_fields', '[]'::jsonb)) is distinct from 'array'
    or jsonb_typeof(coalesce(tenant_state->'custom_field_overrides', '[]'::jsonb)) is distinct from 'array'
  then
    raise exception using
      errcode = '23514',
      message = 'tenant_schema_rebase_conflict',
      detail = jsonb_build_object(
        'path', 'customer_overlay.tenant_schema',
        'code', 'invalid_tenant_schema_overlay',
        'message', 'tenant schema overlay collections must be JSON arrays'
      )::text;
  end if;
  if not (tenant_state ? 'provenance_version')
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
          or value #>> '{}' !~ '^(models\.[a-z][a-z0-9_]*\.(label|display_field_id|lifecycle|fields\.[a-z][a-z0-9_]*\.(label|required|is_unique|lifecycle|options\.[a-z][a-z0-9_]*\.(label|aliases|lifecycle))|many_relations\.[a-z][a-z0-9_]*\.(label|lifecycle))|custom_fields\.[a-z][a-z0-9_]*\.(label|lifecycle|options\.[a-z][a-z0-9_]*\.(label|aliases|lifecycle)))$'
      )
      or jsonb_array_length(tenant_state->'change_paths') <> (
        select count(distinct value #>> '{}') from jsonb_array_elements(tenant_state->'change_paths')
      )
      or tenant_state->'change_paths' <> coalesce((
        select jsonb_agg(to_jsonb(path_value) order by path_value)
        from (
          select distinct value #>> '{}' as path_value
          from jsonb_array_elements(tenant_state->'change_paths')
        ) sorted_paths
      ), '[]'::jsonb)
    )
  then
    raise exception using
      errcode = '23514', message = 'tenant_schema_rebase_conflict',
      detail = jsonb_build_object(
        'path', 'customer_overlay.tenant_schema.change_paths',
        'code', 'invalid_tenant_override_provenance',
        'message', 'tenant schema provenance must use version 1 and sorted unique immutable-id leaf paths'
      )::text;
  end if;
  change_paths := coalesce(tenant_state->'change_paths', '[]'::jsonb);

  base_models := coalesce(effective_schema->'models', '[]'::jsonb);
  rebased_models := base_models;
  for model_override in
    select value from jsonb_array_elements(coalesce(tenant_state->'model_overrides', '[]'::jsonb))
  loop
    path_prefix := 'models.' || (model_override->>'id');
    has_explicit_override := exists (
      select 1 from jsonb_array_elements_text(change_paths) path(value)
      where value = path_prefix or value like path_prefix || '.%'
    );
    has_tenant_children := exists (
      select 1 from jsonb_array_elements(coalesce(model_override->'fields', '[]'::jsonb)) field(value)
      where value->>'origin' = 'tenant'
        or exists (
          select 1 from jsonb_array_elements(coalesce(value->'option_set', '[]'::jsonb)) option_item(option_value)
          where option_value->>'origin' = 'tenant'
        )
    ) or exists (
      select 1 from jsonb_array_elements(coalesce(model_override->'many_relations', '[]'::jsonb)) relation(value)
      where value->>'origin' = 'tenant'
    );
    select value, (ordinality - 1)::integer into base_model, model_index
    from jsonb_array_elements(base_models) with ordinality
    where value->>'id' = model_override->>'id';
    if coalesce(model_override->>'origin', 'app') <> 'app' then
      raise exception using
        errcode = '23514', message = 'tenant_schema_rebase_conflict',
        detail = jsonb_build_object(
          'path', path_prefix, 'code', 'invalid_app_model_override',
          'message', 'model_overrides may contain only app-owned models'
        )::text;
    end if;
    if not found then
      if not has_explicit_override and not has_tenant_children then
        continue;
      end if;
      raise exception using
        errcode = '23514', message = 'tenant_schema_rebase_conflict',
        detail = jsonb_build_object(
          'path', 'models.' || coalesce(model_override->>'id', '<missing>'),
          'code', 'app_model_removed',
          'message', 'an app-owned model with tenant state is absent from the new app base'
        )::text;
    end if;
    if (has_explicit_override or has_tenant_children)
      and base_model->>'kind' is distinct from model_override->>'kind'
    then
      raise exception using
        errcode = '23514', message = 'tenant_schema_rebase_conflict',
        detail = jsonb_build_object(
          'path', 'models.' || (model_override->>'id') || '.kind',
          'code', 'immutable_model_kind_changed',
          'message', 'an app-owned model kind changed while tenant state still references it'
        )::text;
    end if;
    if (
        change_paths ? (path_prefix || '.label')
        or change_paths ? (path_prefix || '.display_field_id')
        or change_paths ? (path_prefix || '.lifecycle')
        or has_tenant_children
      )
      and coalesce(model_override->>'management', 'fixed') = 'tenant_managed'
      and coalesce(base_model->>'management', 'fixed') <> 'tenant_managed'
    then
      raise exception using
        errcode = '23514', message = 'tenant_schema_rebase_conflict',
        detail = jsonb_build_object(
          'path', 'models.' || (model_override->>'id') || '.management',
          'code', 'tenant_management_revoked',
          'message', 'the new app base revokes management of a model with tenant-authored state'
        )::text;
    end if;

    override_fields := coalesce(model_override->'fields', '[]'::jsonb);
    rebased_fields := '[]'::jsonb;
    for base_field in select value from jsonb_array_elements(coalesce(base_model->'fields', '[]'::jsonb))
    loop
      override_field := null;
      select value into override_field
      from jsonb_array_elements(override_fields)
      where value->>'id' = base_field->>'id';
      if not found then
        rebased_fields := rebased_fields || jsonb_build_array(base_field);
        continue;
      end if;
      path_prefix := 'models.' || (model_override->>'id') || '.fields.' || (base_field->>'id');
      has_explicit_override := exists (
        select 1 from jsonb_array_elements_text(change_paths) path(value)
        where value = path_prefix or value like path_prefix || '.%'
      );
      has_tenant_children := exists (
        select 1 from jsonb_array_elements(coalesce(override_field->'option_set', '[]'::jsonb)) option_item(value)
        where value->>'origin' = 'tenant'
      );
      if coalesce(override_field->>'origin', 'app') <> 'app' then
        raise exception using
          errcode = '23514', message = 'tenant_schema_rebase_conflict',
          detail = jsonb_build_object(
            'path', 'models.' || (model_override->>'id') || '.fields.' || (base_field->>'id'),
            'code', 'field_id_collision',
            'message', 'the new app base reuses a tenant-created field identity'
          )::text;
      end if;
      if (has_explicit_override or has_tenant_children)
        and (
          base_field->>'type' is distinct from override_field->>'type'
          or coalesce(base_field->'target_model', 'null'::jsonb)
            is distinct from coalesce(override_field->'target_model', 'null'::jsonb)
        )
      then
        raise exception using
          errcode = '23514', message = 'tenant_schema_rebase_conflict',
          detail = jsonb_build_object(
            'path', 'models.' || (model_override->>'id') || '.fields.' || (base_field->>'id'),
            'code', 'immutable_field_contract_changed',
            'message', 'an app-owned field type or relation target changed while tenant state still references it'
          )::text;
      end if;
      if (has_explicit_override or has_tenant_children)
        and coalesce(override_field->>'management', 'fixed') = 'tenant_managed'
        and coalesce(base_field->>'management', 'fixed') <> 'tenant_managed'
      then
        raise exception using
          errcode = '23514', message = 'tenant_schema_rebase_conflict',
          detail = jsonb_build_object(
            'path', 'models.' || (model_override->>'id') || '.fields.' || (base_field->>'id') || '.management',
            'code', 'tenant_management_revoked',
            'message', 'the new app base revokes management of a field with tenant-authored state'
          )::text;
      end if;

      rebased_field := base_field;
      if change_paths ? (path_prefix || '.label') then
        rebased_field := jsonb_set(rebased_field, '{label}', override_field->'label', true);
      end if;
      if change_paths ? (path_prefix || '.required') then
        rebased_field := jsonb_set(rebased_field, '{required}', coalesce(override_field->'required', 'false'::jsonb), true);
      end if;
      if change_paths ? (path_prefix || '.is_unique') then
        rebased_field := jsonb_set(rebased_field, '{is_unique}', coalesce(override_field->'is_unique', 'false'::jsonb), true);
      end if;
      if change_paths ? (path_prefix || '.lifecycle') then
        rebased_field := jsonb_set(rebased_field, '{lifecycle}', to_jsonb(coalesce(override_field->>'lifecycle', 'active')), true);
      end if;
      if base_field->>'type' = 'enum' then
        base_options := coalesce(base_field->'option_set', '[]'::jsonb);
        override_options := coalesce(override_field->'option_set', '[]'::jsonb);
        rebased_options := '[]'::jsonb;
        for base_option in select value from jsonb_array_elements(base_options)
        loop
          path_prefix := 'models.' || (model_override->>'id') || '.fields.' || (base_field->>'id') || '.options.' || (base_option->>'id');
          override_option := null;
          select value into override_option
          from jsonb_array_elements(override_options)
          where value->>'id' = base_option->>'id';
          if not found then
            rebased_options := rebased_options || jsonb_build_array(base_option);
          elsif coalesce(override_option->>'origin', 'app') <> 'app' then
            raise exception using
              errcode = '23514', message = 'tenant_schema_rebase_conflict',
              detail = jsonb_build_object(
                'path', 'models.' || (model_override->>'id') || '.fields.' || (base_field->>'id') || '.options.' || (base_option->>'id'),
                'code', 'enum_option_id_collision',
                'message', 'the new app base reuses a tenant-created enum option identity'
              )::text;
          elsif exists (
              select 1 from jsonb_array_elements_text(change_paths) path(value)
              where value = path_prefix or value like path_prefix || '.%'
            )
            and coalesce(override_option->>'management', 'fixed') = 'tenant_managed'
            and coalesce(base_option->>'management', 'fixed') <> 'tenant_managed'
          then
            raise exception using
              errcode = '23514', message = 'tenant_schema_rebase_conflict',
              detail = jsonb_build_object(
                'path', 'models.' || (model_override->>'id') || '.fields.' || (base_field->>'id') || '.options.' || (base_option->>'id') || '.management',
                'code', 'tenant_management_revoked',
                'message', 'the new app base revokes management of an enum option with tenant-authored state'
              )::text;
          else
            rebased_option := base_option;
            if change_paths ? (path_prefix || '.label') then
              rebased_option := jsonb_set(rebased_option, '{label}', override_option->'label', true);
            end if;
            if change_paths ? (path_prefix || '.aliases') then
              rebased_option := jsonb_set(rebased_option, '{aliases}', coalesce(override_option->'aliases', '[]'::jsonb), true);
            end if;
            if change_paths ? (path_prefix || '.lifecycle') then
              rebased_option := jsonb_set(rebased_option, '{lifecycle}', to_jsonb(coalesce(override_option->>'lifecycle', 'active')), true);
            end if;
            rebased_options := rebased_options || jsonb_build_array(rebased_option);
          end if;
        end loop;
        for tenant_option in select value from jsonb_array_elements(override_options)
        loop
          if exists (select 1 from jsonb_array_elements(base_options) where value->>'id' = tenant_option->>'id') then
            continue;
          end if;
          path_prefix := 'models.' || (model_override->>'id') || '.fields.' || (base_field->>'id') || '.options.' || (tenant_option->>'id');
          if coalesce(tenant_option->>'origin', 'app') <> 'tenant'
            and exists (
              select 1 from jsonb_array_elements_text(change_paths) path(value)
              where value = path_prefix or value like path_prefix || '.%'
            )
          then
            raise exception using
              errcode = '23514', message = 'tenant_schema_rebase_conflict',
              detail = jsonb_build_object(
                'path', 'models.' || (model_override->>'id') || '.fields.' || (base_field->>'id') || '.options.' || (tenant_option->>'id'),
                'code', 'app_enum_option_removed',
                'message', 'an app-owned enum option with tenant state is absent from the new app base'
              )::text;
          elsif coalesce(tenant_option->>'origin', 'app') = 'tenant' then
            rebased_options := rebased_options || jsonb_build_array(tenant_option - 'retired_at');
          end if;
        end loop;
        option_issues := kernel_admin_validate_enum_options(rebased_options, false);
        if jsonb_array_length(option_issues) > 0 then
          raise exception using
            errcode = '23514', message = 'tenant_schema_rebase_conflict',
            detail = jsonb_build_object(
              'path', 'models.' || (model_override->>'id') || '.fields.' || (base_field->>'id') || '.option_set',
              'code', 'enum_option_rebase_collision',
              'message', 'new app enum options conflict with tenant labels or aliases',
              'issues', option_issues
            )::text;
        end if;
        rebased_field := jsonb_set(rebased_field, '{option_set}', rebased_options, true);
      end if;
      rebased_fields := rebased_fields || jsonb_build_array(rebased_field);
    end loop;
    for tenant_field in select value from jsonb_array_elements(override_fields)
    loop
      if exists (
        select 1 from jsonb_array_elements(coalesce(base_model->'fields', '[]'::jsonb))
        where value->>'id' = tenant_field->>'id'
      ) then
        continue;
      end if;
      path_prefix := 'models.' || (model_override->>'id') || '.fields.' || (tenant_field->>'id');
      has_explicit_override := exists (
        select 1 from jsonb_array_elements_text(change_paths) path(value)
        where value = path_prefix or value like path_prefix || '.%'
      );
      has_tenant_children := exists (
        select 1 from jsonb_array_elements(coalesce(tenant_field->'option_set', '[]'::jsonb)) option_item(value)
        where value->>'origin' = 'tenant'
      );
      if coalesce(tenant_field->>'origin', 'app') <> 'tenant'
        and (has_explicit_override or has_tenant_children)
      then
        raise exception using
          errcode = '23514', message = 'tenant_schema_rebase_conflict',
          detail = jsonb_build_object(
            'path', 'models.' || (model_override->>'id') || '.fields.' || (tenant_field->>'id'),
            'code', 'app_field_removed',
            'message', 'an app-owned field with tenant state is absent from the new app base'
          )::text;
      end if;
      if coalesce(tenant_field->>'origin', 'app') <> 'tenant' then
        continue;
      end if;
      if tenant_field->>'type' = 'enum' then
        option_issues := kernel_admin_validate_enum_options(coalesce(tenant_field->'option_set', '[]'::jsonb), false);
        if jsonb_array_length(option_issues) > 0 then
          raise exception using
            errcode = '23514', message = 'tenant_schema_rebase_conflict',
            detail = jsonb_build_object(
              'path', 'models.' || (model_override->>'id') || '.fields.' || (tenant_field->>'id') || '.option_set',
              'code', 'invalid_tenant_enum_options',
              'message', 'tenant-created enum options are invalid after app-base recomposition',
              'issues', option_issues
            )::text;
        end if;
      end if;
      rebased_fields := rebased_fields || jsonb_build_array(
        jsonb_set(tenant_field - 'retired_at', '{option_set}', coalesce(tenant_field->'option_set', '[]'::jsonb), true)
      );
    end loop;

    override_relations := coalesce(model_override->'many_relations', '[]'::jsonb);
    rebased_relations := '[]'::jsonb;
    for base_relation in select value from jsonb_array_elements(coalesce(base_model->'many_relations', '[]'::jsonb))
    loop
      path_prefix := 'models.' || (model_override->>'id') || '.many_relations.' || (base_relation->>'id');
      has_explicit_override := exists (
        select 1 from jsonb_array_elements_text(change_paths) path(value)
        where value = path_prefix or value like path_prefix || '.%'
      );
      override_relation := null;
      select value into override_relation
      from jsonb_array_elements(override_relations)
      where value->>'id' = base_relation->>'id';
      if not found then
        rebased_relations := rebased_relations || jsonb_build_array(base_relation);
      elsif coalesce(override_relation->>'origin', 'app') <> 'app' then
        raise exception using
          errcode = '23514', message = 'tenant_schema_rebase_conflict',
          detail = jsonb_build_object(
            'path', 'models.' || (model_override->>'id') || '.many_relations.' || (base_relation->>'id'),
            'code', 'relation_id_collision',
            'message', 'the new app base reuses a tenant-created relation identity'
          )::text;
      elsif has_explicit_override
        and base_relation->>'target_model' is distinct from override_relation->>'target_model'
      then
        raise exception using
          errcode = '23514', message = 'tenant_schema_rebase_conflict',
          detail = jsonb_build_object(
            'path', 'models.' || (model_override->>'id') || '.many_relations.' || (base_relation->>'id'),
            'code', 'immutable_relation_target_changed',
            'message', 'an app-owned relation target changed while tenant state still references it'
          )::text;
      elsif has_explicit_override
        and coalesce(override_relation->>'management', 'fixed') = 'tenant_managed'
        and coalesce(base_relation->>'management', 'fixed') <> 'tenant_managed'
      then
        raise exception using
          errcode = '23514', message = 'tenant_schema_rebase_conflict',
          detail = jsonb_build_object(
            'path', 'models.' || (model_override->>'id') || '.many_relations.' || (base_relation->>'id') || '.management',
            'code', 'tenant_management_revoked',
            'message', 'the new app base revokes management of a relation with tenant-authored state'
          )::text;
      else
        rebased_relation := base_relation;
        if change_paths ? (path_prefix || '.label') then
          rebased_relation := jsonb_set(rebased_relation, '{label}', override_relation->'label', true);
        end if;
        if change_paths ? (path_prefix || '.lifecycle') then
          rebased_relation := jsonb_set(rebased_relation, '{lifecycle}', to_jsonb(coalesce(override_relation->>'lifecycle', 'active')), true);
        end if;
        rebased_relations := rebased_relations || jsonb_build_array(rebased_relation);
      end if;
    end loop;
    for tenant_relation in select value from jsonb_array_elements(override_relations)
    loop
      if exists (
        select 1 from jsonb_array_elements(coalesce(base_model->'many_relations', '[]'::jsonb))
        where value->>'id' = tenant_relation->>'id'
      ) then
        continue;
      end if;
      path_prefix := 'models.' || (model_override->>'id') || '.many_relations.' || (tenant_relation->>'id');
      has_explicit_override := exists (
        select 1 from jsonb_array_elements_text(change_paths) path(value)
        where value = path_prefix or value like path_prefix || '.%'
      );
      if coalesce(tenant_relation->>'origin', 'app') <> 'tenant' and has_explicit_override then
        raise exception using
          errcode = '23514', message = 'tenant_schema_rebase_conflict',
          detail = jsonb_build_object(
            'path', 'models.' || (model_override->>'id') || '.many_relations.' || (tenant_relation->>'id'),
            'code', 'app_relation_removed',
            'message', 'an app-owned relation with tenant state is absent from the new app base'
          )::text;
      elsif coalesce(tenant_relation->>'origin', 'app') = 'tenant' then
        rebased_relations := rebased_relations || jsonb_build_array(tenant_relation - 'retired_at');
      end if;
    end loop;

    rebased_model := base_model;
    path_prefix := 'models.' || (model_override->>'id');
    if change_paths ? (path_prefix || '.label') then
      rebased_model := jsonb_set(rebased_model, '{label}', model_override->'label', true);
    end if;
    if change_paths ? (path_prefix || '.display_field_id') then
      rebased_model := jsonb_set(rebased_model, '{display_field_id}', coalesce(model_override->'display_field_id', 'null'::jsonb), true);
    end if;
    if change_paths ? (path_prefix || '.lifecycle') then
      rebased_model := jsonb_set(rebased_model, '{lifecycle}', to_jsonb(coalesce(model_override->>'lifecycle', 'active')), true);
    end if;
    rebased_model := jsonb_set(rebased_model, '{fields}', rebased_fields, true);
    rebased_model := jsonb_set(rebased_model, '{many_relations}', rebased_relations, true);
    rebased_models := jsonb_set(rebased_models, array[model_index::text], rebased_model);
  end loop;

  for tenant_model in
    select value from jsonb_array_elements(coalesce(tenant_state->'models', '[]'::jsonb))
  loop
    if coalesce(tenant_model->>'origin', '') <> 'tenant'
      or tenant_model->>'kind' <> 'lookup'
      or coalesce(tenant_model->>'management', '') <> 'tenant_managed'
    then
      raise exception using
        errcode = '23514', message = 'tenant_schema_rebase_conflict',
        detail = jsonb_build_object(
          'path', 'models.' || coalesce(tenant_model->>'id', '<missing>'),
          'code', 'invalid_tenant_model',
          'message', 'runtime-created models must remain tenant-managed lookup models'
        )::text;
    end if;
    if exists (select 1 from jsonb_array_elements(rebased_models) where value->>'id' = tenant_model->>'id') then
      raise exception using
        errcode = '23514', message = 'tenant_schema_rebase_conflict',
        detail = jsonb_build_object(
          'path', 'models.' || (tenant_model->>'id'),
          'code', 'model_id_collision',
          'message', 'the new app base reuses a tenant-created model identity'
        )::text;
    end if;
    rebased_fields := '[]'::jsonb;
    for tenant_field in select value from jsonb_array_elements(coalesce(tenant_model->'fields', '[]'::jsonb))
    loop
      if tenant_field->>'type' = 'enum' then
        option_issues := kernel_admin_validate_enum_options(coalesce(tenant_field->'option_set', '[]'::jsonb), false);
        if jsonb_array_length(option_issues) > 0 then
          raise exception using
            errcode = '23514', message = 'tenant_schema_rebase_conflict',
            detail = jsonb_build_object(
              'path', 'models.' || (tenant_model->>'id') || '.fields.' || (tenant_field->>'id') || '.option_set',
              'code', 'invalid_tenant_enum_options',
              'message', 'tenant-created enum options are invalid after app-base recomposition',
              'issues', option_issues
            )::text;
        end if;
      end if;
      rebased_fields := rebased_fields || jsonb_build_array(
        jsonb_set(tenant_field - 'retired_at', '{option_set}', coalesce(tenant_field->'option_set', '[]'::jsonb), true)
      );
    end loop;
    select coalesce(jsonb_agg(value - 'retired_at' order by ordinality), '[]'::jsonb)
    into rebased_relations
    from jsonb_array_elements(coalesce(tenant_model->'many_relations', '[]'::jsonb)) with ordinality;
    rebased_model := jsonb_set(tenant_model - 'retired_at', '{fields}', rebased_fields, true);
    rebased_model := jsonb_set(rebased_model, '{many_relations}', rebased_relations, true);
    rebased_models := rebased_models || jsonb_build_array(rebased_model);
  end loop;

  base_custom_fields := coalesce(effective_schema->'custom_fields', '[]'::jsonb);
  rebased_custom_fields := base_custom_fields;
  for custom_override in
    select value from jsonb_array_elements(coalesce(tenant_state->'custom_field_overrides', '[]'::jsonb))
  loop
    path_prefix := 'custom_fields.' || (custom_override->>'id');
    has_explicit_override := exists (
      select 1 from jsonb_array_elements_text(change_paths) path(value)
      where value = path_prefix or value like path_prefix || '.%'
    );
    has_tenant_children := exists (
      select 1 from jsonb_array_elements(coalesce(custom_override->'option_set', '[]'::jsonb)) option_item(value)
      where value->>'origin' = 'tenant'
    );
    select value, (ordinality - 1)::integer into base_custom, field_index
    from jsonb_array_elements(base_custom_fields) with ordinality
    where value->>'id' = custom_override->>'id';
    if coalesce(custom_override->>'origin', 'app') <> 'app' then
      raise exception using
        errcode = '23514', message = 'tenant_schema_rebase_conflict',
        detail = jsonb_build_object(
          'path', path_prefix, 'code', 'invalid_app_custom_field_override',
          'message', 'custom_field_overrides may contain only app-owned definitions'
        )::text;
    end if;
    if not found then
      if not has_explicit_override and not has_tenant_children then
        continue;
      end if;
      raise exception using
        errcode = '23514', message = 'tenant_schema_rebase_conflict',
        detail = jsonb_build_object(
          'path', 'custom_fields.' || coalesce(custom_override->>'id', '<missing>'),
          'code', 'app_custom_field_removed',
          'message', 'an app-owned custom field with tenant state is absent from the new app base'
        )::text;
    end if;
    if (has_explicit_override or has_tenant_children)
      and (
        base_custom->>'model_id' is distinct from custom_override->>'model_id'
        or base_custom->>'field_id' is distinct from custom_override->>'field_id'
        or base_custom->>'type' is distinct from custom_override->>'type'
        or coalesce(base_custom->'target_model_id', 'null'::jsonb)
          is distinct from coalesce(custom_override->'target_model_id', 'null'::jsonb)
      )
    then
      raise exception using
        errcode = '23514', message = 'tenant_schema_rebase_conflict',
        detail = jsonb_build_object(
          'path', 'custom_fields.' || (custom_override->>'id'),
          'code', 'immutable_custom_field_contract_changed',
          'message', 'an app-owned custom-field owner, identity, type, or relation target changed'
        )::text;
    end if;
    if (has_explicit_override or has_tenant_children)
      and coalesce(custom_override->>'management', 'fixed') = 'tenant_managed'
      and coalesce(base_custom->>'management', 'fixed') <> 'tenant_managed'
    then
      raise exception using
        errcode = '23514', message = 'tenant_schema_rebase_conflict',
        detail = jsonb_build_object(
          'path', 'custom_fields.' || (custom_override->>'id') || '.management',
          'code', 'tenant_management_revoked',
          'message', 'the new app base revokes management of a custom field with tenant-authored state'
        )::text;
    end if;
    rebased_custom := base_custom;
    if change_paths ? (path_prefix || '.label') then
      rebased_custom := jsonb_set(rebased_custom, '{label}', custom_override->'label', true);
    end if;
    if change_paths ? (path_prefix || '.lifecycle') then
      rebased_custom := jsonb_set(rebased_custom, '{lifecycle}', to_jsonb(coalesce(custom_override->>'lifecycle', 'active')), true);
      if coalesce(custom_override->>'lifecycle', 'active') = 'retired' then
        if coalesce(custom_override->>'archived_at', '') = '' then
          raise exception using
            errcode = '23514', message = 'tenant_schema_rebase_conflict',
            detail = jsonb_build_object(
              'path', 'custom_fields.' || (custom_override->>'id') || '.archived_at',
              'code', 'retired_custom_field_missing_archive_time',
              'message', 'retired custom fields must retain their archived_at timestamp'
            )::text;
        end if;
        rebased_custom := jsonb_set(rebased_custom, '{archived_at}', custom_override->'archived_at', true);
      else
        rebased_custom := rebased_custom - 'archived_at';
      end if;
    end if;
    if base_custom->>'type' = 'enum' then
      base_options := coalesce(base_custom->'option_set', '[]'::jsonb);
      override_options := coalesce(custom_override->'option_set', '[]'::jsonb);
      rebased_options := '[]'::jsonb;
      for base_option in select value from jsonb_array_elements(base_options)
      loop
        path_prefix := 'custom_fields.' || (custom_override->>'id') || '.options.' || (base_option->>'id');
        override_option := null;
        select value into override_option from jsonb_array_elements(override_options)
        where value->>'id' = base_option->>'id';
        if not found then
          rebased_options := rebased_options || jsonb_build_array(base_option);
        elsif coalesce(override_option->>'origin', 'app') <> 'app' then
          raise exception using
            errcode = '23514', message = 'tenant_schema_rebase_conflict',
            detail = jsonb_build_object(
              'path', 'custom_fields.' || (custom_override->>'id') || '.options.' || (base_option->>'id'),
              'code', 'enum_option_id_collision',
              'message', 'the new app base reuses a tenant-created custom enum option identity'
            )::text;
        elsif exists (
            select 1 from jsonb_array_elements_text(change_paths) path(value)
            where value = path_prefix or value like path_prefix || '.%'
          )
          and coalesce(override_option->>'management', 'fixed') = 'tenant_managed'
          and coalesce(base_option->>'management', 'fixed') <> 'tenant_managed'
        then
          raise exception using
            errcode = '23514', message = 'tenant_schema_rebase_conflict',
            detail = jsonb_build_object(
              'path', 'custom_fields.' || (custom_override->>'id') || '.options.' || (base_option->>'id') || '.management',
              'code', 'tenant_management_revoked',
              'message', 'the new app base revokes management of a custom enum option with tenant-authored state'
            )::text;
        else
          rebased_option := base_option;
          if change_paths ? (path_prefix || '.label') then
            rebased_option := jsonb_set(rebased_option, '{label}', override_option->'label', true);
          end if;
          if change_paths ? (path_prefix || '.aliases') then
            rebased_option := jsonb_set(rebased_option, '{aliases}', coalesce(override_option->'aliases', '[]'::jsonb), true);
          end if;
          if change_paths ? (path_prefix || '.lifecycle') then
            rebased_option := jsonb_set(rebased_option, '{lifecycle}', to_jsonb(coalesce(override_option->>'lifecycle', 'active')), true);
          end if;
          rebased_options := rebased_options || jsonb_build_array(rebased_option);
        end if;
      end loop;
      for tenant_option in select value from jsonb_array_elements(override_options)
      loop
        if exists (select 1 from jsonb_array_elements(base_options) where value->>'id' = tenant_option->>'id') then
          continue;
        end if;
        path_prefix := 'custom_fields.' || (custom_override->>'id') || '.options.' || (tenant_option->>'id');
        if coalesce(tenant_option->>'origin', 'app') <> 'tenant'
          and exists (
            select 1 from jsonb_array_elements_text(change_paths) path(value)
            where value = path_prefix or value like path_prefix || '.%'
          )
        then
          raise exception using
            errcode = '23514', message = 'tenant_schema_rebase_conflict',
            detail = jsonb_build_object(
              'path', 'custom_fields.' || (custom_override->>'id') || '.options.' || (tenant_option->>'id'),
              'code', 'app_enum_option_removed',
              'message', 'an app-owned custom enum option with tenant state is absent from the new app base'
            )::text;
        elsif coalesce(tenant_option->>'origin', 'app') = 'tenant' then
          rebased_options := rebased_options || jsonb_build_array(tenant_option - 'retired_at');
        end if;
      end loop;
      option_issues := kernel_admin_validate_enum_options(rebased_options, true);
      if jsonb_array_length(option_issues) > 0 then
        raise exception using
          errcode = '23514', message = 'tenant_schema_rebase_conflict',
          detail = jsonb_build_object(
            'path', 'custom_fields.' || (custom_override->>'id') || '.option_set',
            'code', 'enum_option_rebase_collision',
            'message', 'new app custom enum options conflict with tenant labels or aliases',
            'issues', option_issues
          )::text;
      end if;
      rebased_custom := jsonb_set(rebased_custom, '{option_set}', rebased_options, true);
    end if;
    rebased_custom_fields := jsonb_set(rebased_custom_fields, array[field_index::text], rebased_custom);
  end loop;

  for tenant_custom in
    select value from jsonb_array_elements(coalesce(tenant_state->'custom_fields', '[]'::jsonb))
  loop
    if coalesce(tenant_custom->>'origin', '') <> 'tenant'
      or coalesce(tenant_custom->>'management', '') <> 'tenant_managed'
    then
      raise exception using
        errcode = '23514', message = 'tenant_schema_rebase_conflict',
        detail = jsonb_build_object(
          'path', 'custom_fields.' || coalesce(tenant_custom->>'id', '<missing>'),
          'code', 'invalid_tenant_custom_field',
          'message', 'runtime-created custom fields must remain tenant-managed'
        )::text;
    end if;
    if exists (
      select 1 from jsonb_array_elements(rebased_custom_fields)
      where value->>'id' = tenant_custom->>'id'
        or (value->>'model_id' = tenant_custom->>'model_id' and value->>'field_id' = tenant_custom->>'field_id')
    ) then
      raise exception using
        errcode = '23514', message = 'tenant_schema_rebase_conflict',
        detail = jsonb_build_object(
          'path', 'custom_fields.' || (tenant_custom->>'id'),
          'code', 'custom_field_id_collision',
          'message', 'the new app base reuses a tenant-created custom-field identity'
        )::text;
    end if;
    if tenant_custom->>'type' = 'enum' then
      option_issues := kernel_admin_validate_enum_options(coalesce(tenant_custom->'option_set', '[]'::jsonb), true);
      if jsonb_array_length(option_issues) > 0 then
        raise exception using
          errcode = '23514', message = 'tenant_schema_rebase_conflict',
          detail = jsonb_build_object(
            'path', 'custom_fields.' || (tenant_custom->>'id') || '.option_set',
            'code', 'invalid_tenant_enum_options',
            'message', 'tenant-created custom enum options are invalid after app-base recomposition',
            'issues', option_issues
          )::text;
      end if;
    end if;
    if tenant_custom->>'lifecycle' = 'retired' and coalesce(tenant_custom->>'archived_at', '') = '' then
      raise exception using
        errcode = '23514', message = 'tenant_schema_rebase_conflict',
        detail = jsonb_build_object(
          'path', 'custom_fields.' || (tenant_custom->>'id') || '.archived_at',
          'code', 'retired_custom_field_missing_archive_time',
          'message', 'retired custom fields must retain their archived_at timestamp'
        )::text;
    end if;
    rebased_custom_fields := rebased_custom_fields || jsonb_build_array(tenant_custom - 'retired_at');
  end loop;

  for rebased_model in select value from jsonb_array_elements(rebased_models)
  loop
    if rebased_model->>'kind' = 'lookup' then
      if not exists (
        select 1 from jsonb_array_elements(coalesce(rebased_model->'fields', '[]'::jsonb))
        where value->>'id' = rebased_model->>'display_field_id'
          and value->>'type' = 'text'
          and coalesce((value->>'required')::boolean, false)
      ) then
        raise exception using
          errcode = '23514', message = 'tenant_schema_rebase_conflict',
          detail = jsonb_build_object(
            'path', 'models.' || (rebased_model->>'id') || '.display_field_id',
            'code', 'invalid_display_field',
            'message', 'lookup display field must remain a required text field after app-base recomposition'
          )::text;
      end if;
    end if;
    for rebased_field in select value from jsonb_array_elements(coalesce(rebased_model->'fields', '[]'::jsonb))
    loop
      target_model_id := rebased_field->>'target_model';
      if rebased_field->>'type' = 'relation'
        and not exists (select 1 from jsonb_array_elements(rebased_models) where value->>'id' = target_model_id)
      then
        raise exception using
          errcode = '23514', message = 'tenant_schema_rebase_conflict',
          detail = jsonb_build_object(
            'path', 'models.' || (rebased_model->>'id') || '.fields.' || (rebased_field->>'id') || '.target_model',
            'code', 'dangling_relation_target',
            'message', 'relation target is absent after app-base recomposition'
          )::text;
      end if;
    end loop;
    for rebased_relation in select value from jsonb_array_elements(coalesce(rebased_model->'many_relations', '[]'::jsonb))
    loop
      if not exists (
        select 1 from jsonb_array_elements(rebased_models)
        where value->>'id' = rebased_relation->>'target_model'
      ) then
        raise exception using
          errcode = '23514', message = 'tenant_schema_rebase_conflict',
          detail = jsonb_build_object(
            'path', 'models.' || (rebased_model->>'id') || '.many_relations.' || (rebased_relation->>'id') || '.target_model',
            'code', 'dangling_relation_target',
            'message', 'many-relation target is absent after app-base recomposition'
          )::text;
      end if;
    end loop;
  end loop;
  for rebased_custom in select value from jsonb_array_elements(rebased_custom_fields)
  loop
    base_model := null;
    select value into base_model
    from jsonb_array_elements(rebased_models)
    where value->>'id' = rebased_custom->>'model_id';
    if not found then
      raise exception using
        errcode = '23514', message = 'tenant_schema_rebase_conflict',
        detail = jsonb_build_object(
          'path', 'custom_fields.' || (rebased_custom->>'id') || '.model_id',
          'code', 'dangling_custom_field_model',
          'message', 'custom-field owner model is absent after app-base recomposition'
        )::text;
    end if;
    if not coalesce((base_model #>> '{extensions,typed_custom_fields}')::boolean, false)
      -- App-authored derived fields store nothing and need no tenant opt-in.
      and not (coalesce(rebased_custom->'expression', 'null'::jsonb) <> 'null'::jsonb
        and rebased_custom->>'origin' = 'app')
    then
      raise exception using
        errcode = '23514', message = 'tenant_schema_rebase_conflict',
        detail = jsonb_build_object(
          'path', 'custom_fields.' || (rebased_custom->>'id') || '.model_id',
          'code', 'custom_fields_not_enabled',
          'message', 'the new app base does not enable typed custom fields on the owning model'
        )::text;
    end if;
    if rebased_custom->>'type' = 'relation'
      and not exists (
        select 1 from jsonb_array_elements(rebased_models) where value->>'id' = rebased_custom->>'target_model_id'
      )
    then
      raise exception using
        errcode = '23514', message = 'tenant_schema_rebase_conflict',
        detail = jsonb_build_object(
          'path', 'custom_fields.' || (rebased_custom->>'id') || '.target_model_id',
          'code', 'dangling_relation_target',
          'message', 'custom relation target is absent after app-base recomposition'
        )::text;
    end if;
  end loop;

  select coalesce(jsonb_agg(jsonb_strip_nulls(value) order by ordinality), '[]'::jsonb)
  into rebased_custom_fields
  from jsonb_array_elements(rebased_custom_fields) with ordinality;
  effective_schema := jsonb_set(effective_schema, '{models}', rebased_models, true);
  effective_schema := jsonb_set(effective_schema, '{custom_fields}', rebased_custom_fields, true);
  return effective_schema;
end;
$kernel$
"#;

const KERNEL_ADMIN_MATERIALIZATION_ERROR: &str = r#"
create or replace function kernel_admin_materialization_error(expected_schema jsonb, active_row jsonb)
returns jsonb
language plpgsql
stable
as $kernel$
declare
  model_value jsonb;
  field_value jsonb;
  expected jsonb;
  expected_columns jsonb := '[
    {"table":"schema_revision","name":"id","type":"bigint","not_null":true},
    {"table":"schema_revision","name":"app_id","type":"text","not_null":true},
    {"table":"schema_revision","name":"customer_id","type":"text","not_null":true},
    {"table":"schema_revision","name":"version","type":"text","not_null":true},
    {"table":"schema_revision","name":"base_schema","type":"jsonb","not_null":true},
    {"table":"schema_revision","name":"customer_overlay","type":"jsonb","not_null":true},
    {"table":"schema_revision","name":"schema","type":"jsonb","not_null":true},
    {"table":"schema_revision","name":"created_at","type":"timestamp with time zone","not_null":true},
    {"table":"schema_revision","name":"activated_at","type":"timestamp with time zone","not_null":false},
    {"table":"schema_revision","name":"schema_hash","type":"text","not_null":false},
    {"table":"schema_revision","name":"materialization_source","type":"text","not_null":false},
    {"table":"schema_revision","name":"materialization_git_sha","type":"text","not_null":false},
    {"table":"schema_revision","name":"materialization_vercel_deployment_id","type":"text","not_null":false},
    {"table":"schema_revision","name":"materialization_vercel_environment","type":"text","not_null":false},
    {"table":"schema_revision","name":"materialization_vercel_git_ref","type":"text","not_null":false},
    {"table":"schema_revision","name":"materialized_at","type":"timestamp with time zone","not_null":false},
    {"table":"schema_activation_head","name":"app_id","type":"text","not_null":true},
    {"table":"schema_activation_head","name":"customer_id","type":"text","not_null":true},
    {"table":"schema_activation_head","name":"base_schema_version","type":"text","not_null":true},
    {"table":"schema_activation_head","name":"advanced_at","type":"timestamp with time zone","not_null":true},
    {"table":"change_set","name":"id","type":"bigint","not_null":true},
    {"table":"change_set","name":"app_id","type":"text","not_null":true},
    {"table":"change_set","name":"customer_id","type":"text","not_null":true},
    {"table":"change_set","name":"schema_revision_id","type":"bigint","not_null":true},
    {"table":"change_set","name":"created_with_mode","type":"text","not_null":true},
    {"table":"change_set","name":"status","type":"text","not_null":true},
    {"table":"change_set","name":"actor_id","type":"text","not_null":false},
    {"table":"change_set","name":"source_kind","type":"text","not_null":true},
    {"table":"change_set","name":"source_ref","type":"text","not_null":false},
    {"table":"change_set","name":"idempotency_key","type":"text","not_null":false},
    {"table":"change_set","name":"request_fingerprint","type":"text","not_null":false},
    {"table":"change_set","name":"change_type_id","type":"text","not_null":false},
    {"table":"change_set","name":"notes","type":"text","not_null":false},
    {"table":"change_set","name":"created_order","type":"bigint","not_null":true},
    {"table":"change_set","name":"applied_order","type":"bigint","not_null":false},
    {"table":"change_set","name":"created_at","type":"timestamp with time zone","not_null":true},
    {"table":"change_set","name":"applied_at","type":"timestamp with time zone","not_null":false},
    {"table":"agent_run","name":"id","type":"bigint","not_null":true},
    {"table":"agent_run","name":"app_id","type":"text","not_null":true},
    {"table":"agent_run","name":"customer_id","type":"text","not_null":true},
    {"table":"agent_run","name":"run_id","type":"text","not_null":true},
    {"table":"agent_run","name":"status","type":"text","not_null":true},
    {"table":"agent_run","name":"schema_revision_id","type":"bigint","not_null":true},
    {"table":"agent_run","name":"actor_id","type":"text","not_null":false},
    {"table":"agent_run","name":"agent_identity_id","type":"text","not_null":true},
    {"table":"agent_run","name":"execution_profile_id","type":"text","not_null":true},
    {"table":"agent_run","name":"source_artifacts","type":"jsonb","not_null":true},
    {"table":"agent_run","name":"alignment_decisions","type":"jsonb","not_null":true},
    {"table":"agent_run","name":"model_calls","type":"jsonb","not_null":true},
    {"table":"agent_run","name":"tool_calls","type":"jsonb","not_null":true},
    {"table":"agent_run","name":"token_usage","type":"jsonb","not_null":true},
    {"table":"agent_run","name":"validation_failures","type":"jsonb","not_null":true},
    {"table":"agent_run","name":"final_outputs","type":"jsonb","not_null":true},
    {"table":"agent_run","name":"approval_boundaries","type":"jsonb","not_null":true},
    {"table":"agent_run","name":"compiled_preview_ids","type":"jsonb","not_null":true},
    {"table":"agent_run","name":"created_at","type":"timestamp with time zone","not_null":true}
  ]'::jsonb;
  expected_constraints jsonb := '[
    {"table":"schema_revision","name":"schema_revision_pkey","type":"p","columns":["id"]},
    {"table":"schema_revision","name":"schema_revision_scope_version_key","type":"u","columns":["app_id","customer_id","version"]},
    {"table":"schema_activation_head","name":"schema_activation_head_pkey","type":"p","columns":["app_id","customer_id"]},
    {"table":"change_set","name":"change_set_pkey","type":"p","columns":["id"]},
    {"table":"change_set","name":"change_set_created_with_mode_check","type":"c","expression":"created_with_mode = ANY (ARRAY[''mainline''::text, ''draft''::text])"},
    {"table":"change_set","name":"change_set_status_check","type":"c","expression":"status = ANY (ARRAY[''draft''::text, ''mainline''::text, ''discarded''::text])"},
    {"table":"change_set","name":"change_set_applied_at_status_check","type":"c","expression":"(status = ''mainline''::text) = (applied_at IS NOT NULL)"},
    {"table":"change_set","name":"change_set_applied_order_status_check","type":"c","expression":"(status = ''mainline''::text) = (applied_order IS NOT NULL)"},
    {"table":"change_set","name":"change_set_schema_revision_tenant_fk","type":"f","columns":["schema_revision_id","app_id","customer_id"],"ref_table":"schema_revision","ref_columns":["id","app_id","customer_id"]},
    {"table":"agent_run","name":"agent_run_pkey","type":"p","columns":["id"]},
    {"table":"agent_run","name":"agent_run_scope_run_key","type":"u","columns":["app_id","customer_id","run_id"]},
    {"table":"agent_run","name":"agent_run_status_check","type":"c","expression":"status = ANY (ARRAY[''recorded''::text, ''completed''::text, ''validation_exhausted''::text, ''budget_exhausted''::text, ''runtime_error''::text, ''cancelled''::text])"},
    {"table":"agent_run","name":"agent_run_schema_revision_tenant_fk","type":"f","columns":["schema_revision_id","app_id","customer_id"],"ref_table":"schema_revision","ref_columns":["id","app_id","customer_id"]}
  ]'::jsonb;
  expected_indexes jsonb := '[
    {"table":"schema_revision","name":"schema_revision_tenant_id_idx","unique":true,"columns":["id","app_id","customer_id"]},
    {"table":"schema_revision","name":"schema_revision_active_idx","unique":true,"columns":["app_id","customer_id"],"predicate":"activated_at IS NOT NULL"},
    {"table":"change_set","name":"change_set_tenant_id_idx","unique":true,"columns":["id","app_id","customer_id"]},
    {"table":"change_set","name":"change_set_idempotency_idx","unique":true,"columns":["app_id","customer_id","idempotency_key"],"predicate":"idempotency_key IS NOT NULL"},
    {"table":"change_set","name":"change_set_pending_draft_idx","unique":false,"columns":["app_id","customer_id"],"predicate":"status = ''draft''::text AND applied_order IS NULL"},
    {"table":"agent_run","name":"agent_run_tenant_id_idx","unique":true,"columns":["id","app_id","customer_id"]}
  ]'::jsonb;
  policy_tables text[] := array['schema_revision', 'schema_activation_head', 'change_set', 'agent_run'];
  requested_table_name text;
  record_table_name text;
  version_table_name text;
  field_name text;
  field_type text;
  column_type text;
  target_table_name text;
  extra_table jsonb;
  assertion jsonb;
  assertion_kind text;
  object_name text;
  expected_definition text;
  actual_definition text;
  assertion_exists boolean;
  actual_type text;
  actual_not_null boolean;
  unexpected_table text;
  unexpected_column text;
  constraint_row record;
  index_row record;
  policy_row record;
  normalized_expected text;
  normalized_actual text;
begin
  foreach requested_table_name in array array['schema_revision', 'schema_activation_head', 'change_set', 'agent_run']
  loop
    if to_regclass(format('%I.%I', current_schema(), requested_table_name)) is null then
      return kernel_admin_error('schema_drift', 'Schema drift detected', jsonb_build_array(jsonb_build_object(
        'path', 'object', 'code', 'schema_drift', 'message', requested_table_name || ': required materialized table is missing'
      )));
    end if;
  end loop;
  for model_value in select value from jsonb_array_elements(coalesce(expected_schema->'models', '[]'::jsonb))
  loop
    requested_table_name := kernel_admin_normalize_identifier(model_value->>'id');
    if requested_table_name is null then
      return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
        'path', 'models.id', 'code', 'invalid_identifier', 'message', 'model id cannot be materialized'
      )));
    end if;
    record_table_name := kernel_admin_bounded_identifier(requested_table_name || '_record');
    version_table_name := kernel_admin_bounded_identifier(requested_table_name || '_version');
    policy_tables := policy_tables || array[record_table_name, version_table_name];
    expected_columns := expected_columns || jsonb_build_array(
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
      jsonb_build_object('table', version_table_name, 'name', 'custom_fields', 'type', 'jsonb', 'not_null', true)
    );
    expected_constraints := expected_constraints || jsonb_build_array(
      jsonb_build_object('table', record_table_name, 'name', kernel_admin_bounded_identifier(record_table_name || '_pkey'), 'type', 'p', 'columns', jsonb_build_array('id')),
      jsonb_build_object('table', record_table_name, 'name', kernel_admin_bounded_identifier(record_table_name || '_tenant_id_key'), 'type', 'u', 'columns', jsonb_build_array('id','app_id','customer_id')),
      jsonb_build_object(
        'table', version_table_name,
        'name', case when octet_length(version_table_name || '_pkey') <= 63
          then version_table_name || '_pkey' else left(version_table_name, 58) || '_pkey' end,
        'type', 'p', 'columns', jsonb_build_array('id')
      ),
      jsonb_build_object('table', version_table_name, 'name', kernel_admin_bounded_identifier(version_table_name || '_stage_check'), 'type', 'c', 'expression', 'stage = ANY (ARRAY[''draft''::text, ''mainline''::text, ''discarded''::text, ''reverted''::text])'),
      jsonb_build_object('table', version_table_name, 'name', kernel_admin_bounded_identifier(version_table_name || '_effective_range_check'), 'type', 'c', 'expression', 'effective_end IS NULL OR effective_end >= effective_start'),
      jsonb_build_object('table', version_table_name, 'name', kernel_admin_bounded_identifier(version_table_name || '_applied_at_stage_check'), 'type', 'c', 'expression', '(stage = ''mainline''::text) = (applied_at IS NOT NULL)'),
      jsonb_build_object('table', version_table_name, 'name', kernel_admin_bounded_identifier(version_table_name || '_record_event_exclusion_check'), 'type', 'c', 'expression', 'NOT (tombstones_record AND untombstones_record)'),
      jsonb_build_object('table', version_table_name, 'name', kernel_admin_bounded_identifier(version_table_name || '_record_tenant_fk'), 'type', 'f', 'columns', jsonb_build_array('record_id','app_id','customer_id'), 'ref_table', record_table_name, 'ref_columns', jsonb_build_array('id','app_id','customer_id')),
      jsonb_build_object('table', version_table_name, 'name', kernel_admin_bounded_identifier(version_table_name || '_change_set_tenant_fk'), 'type', 'f', 'columns', jsonb_build_array('change_set_id','app_id','customer_id'), 'ref_table', 'change_set', 'ref_columns', jsonb_build_array('id','app_id','customer_id'))
    );
    expected_indexes := expected_indexes || jsonb_build_array(
      jsonb_build_object('table', record_table_name, 'name', kernel_admin_bounded_identifier(record_table_name || '_external_key_idx'), 'unique', true, 'columns', jsonb_build_array('app_id','customer_id','external_key'), 'predicate', 'external_key IS NOT NULL'),
      jsonb_build_object('table', version_table_name, 'name', kernel_admin_bounded_identifier(version_table_name || '_lookup_idx'), 'unique', false, 'columns', jsonb_build_array('record_id','stage','effective_start')),
      jsonb_build_object('table', version_table_name, 'name', kernel_admin_bounded_identifier(version_table_name || '_source_record_ref_idx'), 'unique', false, 'columns', jsonb_build_array('app_id','customer_id','(provenance ->> ''source_record_ref''::text)'), 'predicate', 'provenance ? ''source_record_ref''::text'),
      jsonb_build_object('table', version_table_name, 'name', kernel_admin_bounded_identifier(version_table_name || '_change_set_idx'), 'unique', false, 'columns', jsonb_build_array('change_set_id')),
      jsonb_build_object('table', version_table_name, 'name', kernel_admin_bounded_identifier(version_table_name || '_change_set_value_once_idx'), 'unique', true, 'columns', jsonb_build_array('record_id','effective_start','change_set_id'), 'predicate', 'NOT tombstones_record AND NOT untombstones_record'),
      jsonb_build_object('table', version_table_name, 'name', kernel_admin_bounded_identifier(version_table_name || '_mainline_lifecycle_once_idx'), 'unique', true, 'columns', jsonb_build_array('record_id','effective_start','tombstones_record','untombstones_record'), 'predicate', 'stage = ''mainline''::text AND (tombstones_record OR untombstones_record)'),
      jsonb_build_object('table', version_table_name, 'name', kernel_admin_bounded_identifier(version_table_name || '_draft_idx'), 'unique', false, 'columns', jsonb_build_array('app_id','customer_id','record_id','effective_start'), 'predicate', 'stage = ''draft''::text')
    );

    for field_value in select value from jsonb_array_elements(coalesce(model_value->'fields', '[]'::jsonb))
    loop
      field_name := kernel_admin_normalize_identifier(field_value->>'id');
      field_type := field_value->>'type';
      if field_name is null then
        return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
          'path', 'models.fields.id', 'code', 'invalid_identifier', 'message', 'field id cannot be materialized'
        )));
      end if;
      if field_type = 'money_rate' then
        foreach expected in array array[
          jsonb_build_object('name', kernel_admin_bounded_identifier(field_name || '_amount'), 'type', 'numeric'),
          jsonb_build_object('name', kernel_admin_bounded_identifier(field_name || '_currency'), 'type', 'text'),
          jsonb_build_object('name', kernel_admin_bounded_identifier(field_name || '_period'), 'type', 'text')
        ] loop
          expected_columns := expected_columns || jsonb_build_array(jsonb_build_object(
            'table', version_table_name, 'name', expected->>'name', 'type', expected->>'type', 'not_null', false
          ));
          expected_constraints := expected_constraints || jsonb_build_array(jsonb_build_object(
            'table', version_table_name,
            'name', kernel_admin_bounded_identifier(version_table_name || '_' || (expected->>'name') || '_record_event_null_check'),
            'type', 'c', 'expression', 'NOT tombstones_record AND NOT untombstones_record OR ' || (expected->>'name') || ' IS NULL'
          ));
          if coalesce((field_value->>'required')::boolean, false) then
            expected_constraints := expected_constraints || jsonb_build_array(jsonb_build_object(
              'table', version_table_name,
              'name', kernel_admin_bounded_identifier(version_table_name || '_' || (expected->>'name') || '_required_check'),
              'type', 'c', 'expression', 'tombstones_record OR untombstones_record OR ' || (expected->>'name') || ' IS NOT NULL'
            ));
          end if;
        end loop;
        expected_constraints := expected_constraints || jsonb_build_array(
          jsonb_build_object(
            'table', version_table_name, 'name', kernel_admin_bounded_identifier(version_table_name || '_' || kernel_admin_bounded_identifier(field_name || '_amount') || '_all_or_none_check'), 'type', 'c',
            'expression', '(' || kernel_admin_bounded_identifier(field_name || '_amount') || ' IS NULL AND ' || kernel_admin_bounded_identifier(field_name || '_currency') || ' IS NULL AND ' || kernel_admin_bounded_identifier(field_name || '_period') || ' IS NULL) OR (' || kernel_admin_bounded_identifier(field_name || '_amount') || ' IS NOT NULL AND ' || kernel_admin_bounded_identifier(field_name || '_currency') || ' IS NOT NULL AND ' || kernel_admin_bounded_identifier(field_name || '_period') || ' IS NOT NULL)'
          ),
          jsonb_build_object(
            'table', version_table_name, 'name', kernel_admin_bounded_identifier(version_table_name || '_' || kernel_admin_bounded_identifier(field_name || '_period') || '_period_check'), 'type', 'c',
            'expression', kernel_admin_bounded_identifier(field_name || '_period') || ' IS NULL OR ' || kernel_admin_bounded_identifier(field_name || '_period') || ' = ANY (ARRAY[''hourly''::text, ''daily''::text, ''weekly''::text, ''monthly''::text, ''annual''::text])'
          )
        );
      else
        column_type := case field_type
          when 'text' then 'text' when 'iso_country' then 'text' when 'iso_currency' then 'text'
          when 'enum' then 'text' when 'number' then 'numeric' when 'bool' then 'boolean'
          when 'date' then 'date' when 'datetime' then 'timestamp with time zone'
          when 'relation' then 'uuid' when 'text_list' then 'text[]' when 'known_aliases' then 'text[]'
          when 'json' then 'jsonb' else null end;
        if column_type is null then
          return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
            'path', 'models.fields.type', 'code', 'unsupported_field_type', 'message', 'field type cannot be validated against the materialized catalog'
          )));
        end if;
        field_name := kernel_admin_bounded_identifier(field_name);
        expected_columns := expected_columns || jsonb_build_array(jsonb_build_object(
          'table', version_table_name, 'name', field_name, 'type', column_type, 'not_null', false
        ));
        expected_constraints := expected_constraints || jsonb_build_array(jsonb_build_object(
          'table', version_table_name,
          'name', kernel_admin_bounded_identifier(version_table_name || '_' || field_name || '_record_event_null_check'),
          'type', 'c', 'expression', 'NOT tombstones_record AND NOT untombstones_record OR ' || field_name || ' IS NULL'
        ));
        if coalesce((field_value->>'required')::boolean, false) then
          expected_constraints := expected_constraints || jsonb_build_array(jsonb_build_object(
            'table', version_table_name,
            'name', kernel_admin_bounded_identifier(version_table_name || '_' || field_name || '_required_check'),
            'type', 'c', 'expression', 'tombstones_record OR untombstones_record OR ' || field_name || ' IS NOT NULL'
          ));
        end if;
        if field_type = 'relation' then
          select kernel_admin_bounded_identifier(kernel_admin_normalize_identifier(target->>'id') || '_record')
          into target_table_name
          from jsonb_array_elements(expected_schema->'models') as targets(target)
          where target->>'id' = field_value->>'target_model';
          if not found then
            return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
              'path', 'models.fields.target_model', 'code', 'unknown_relation_target', 'message', 'relation target cannot be validated against the materialized catalog'
            )));
          end if;
          expected_constraints := expected_constraints || jsonb_build_array(jsonb_build_object(
            'table', version_table_name,
            'name', kernel_admin_bounded_identifier(version_table_name || '_' || field_name || '_tenant_fk'),
            'type', 'f', 'columns', jsonb_build_array(field_name,'app_id','customer_id'),
            'ref_table', target_table_name, 'ref_columns', jsonb_build_array('id','app_id','customer_id')
          ));
        end if;
        if coalesce((field_value->>'is_unique')::boolean, false) then
          expected_indexes := expected_indexes || jsonb_build_array(jsonb_build_object(
            'table', version_table_name,
            'name', kernel_admin_bounded_identifier(version_table_name || '_' || field_name || '_live_unique_idx'),
            'unique', true, 'columns', jsonb_build_array('app_id','customer_id',field_name),
            'predicate', 'stage = ''mainline''::text AND effective_end IS NULL AND ' || field_name || ' IS NOT NULL'
          ));
        end if;
      end if;
    end loop;
  end loop;

  for expected in select value from jsonb_array_elements(expected_columns)
  loop
    select format_type(attribute.atttypid, attribute.atttypmod), attribute.attnotnull
    into actual_type, actual_not_null
    from pg_attribute as attribute
    join pg_class as relation on relation.oid = attribute.attrelid
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = current_schema() and relation.relname = expected->>'table'
      and attribute.attname = expected->>'name' and attribute.attnum > 0 and not attribute.attisdropped;
    if not found then
      return kernel_admin_error('schema_drift', 'Schema drift detected', jsonb_build_array(jsonb_build_object(
        'path', 'object', 'code', 'schema_drift', 'message', (expected->>'table') || '.' || (expected->>'name') || ': required materialized column is missing'
      )));
    end if;
    if actual_type <> expected->>'type' or actual_not_null <> (expected->>'not_null')::boolean then
      return kernel_admin_error('schema_drift', 'Schema drift detected', jsonb_build_array(jsonb_build_object(
        'path', 'object', 'code', 'schema_drift', 'message', (expected->>'table') || '.' || (expected->>'name') || ': materialized column definition differs from the compiled catalog'
      )));
    end if;
  end loop;

  select relation.relname, attribute.attname
  into unexpected_table, unexpected_column
  from pg_attribute as attribute
  join pg_class as relation on relation.oid = attribute.attrelid
  join pg_namespace as namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = current_schema()
    and attribute.attnum > 0
    and not attribute.attisdropped
    and exists (
      select 1
      from jsonb_array_elements(expected_columns) as expected_table(value)
      where expected_table.value->>'table' = relation.relname
    )
    and not exists (
      select 1
      from jsonb_array_elements(expected_columns) as expected_column(value)
      where expected_column.value->>'table' = relation.relname
        and expected_column.value->>'name' = attribute.attname
    )
  order by relation.relname, attribute.attnum
  limit 1;
  if found then
    return kernel_admin_error('schema_drift', 'Schema drift detected', jsonb_build_array(jsonb_build_object(
      'path', 'object', 'code', 'schema_drift',
      'message', unexpected_table || '.' || unexpected_column || ': unexpected materialized column is present'
    )));
  end if;

  for expected in select value from jsonb_array_elements(expected_constraints)
  loop
    select constraint_value.contype::text as constraint_type, constraint_value.convalidated,
      pg_get_expr(constraint_value.conbin, constraint_value.conrelid, true) as expression,
      referenced_relation.relname as referenced_table,
      (select jsonb_agg(attribute.attname order by key_column.ordinality)
       from unnest(constraint_value.conkey) with ordinality as key_column(attnum, ordinality)
       join pg_attribute as attribute on attribute.attrelid = constraint_value.conrelid and attribute.attnum = key_column.attnum) as columns,
      (select jsonb_agg(attribute.attname order by key_column.ordinality)
       from unnest(constraint_value.confkey) with ordinality as key_column(attnum, ordinality)
       join pg_attribute as attribute on attribute.attrelid = constraint_value.confrelid and attribute.attnum = key_column.attnum) as referenced_columns
    into constraint_row
    from pg_constraint as constraint_value
    join pg_class as relation on relation.oid = constraint_value.conrelid
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    left join pg_class as referenced_relation on referenced_relation.oid = constraint_value.confrelid
    where namespace.nspname = current_schema() and relation.relname = expected->>'table'
      and constraint_value.conname = expected->>'name';
    if not found then
      return kernel_admin_error('schema_drift', 'Schema drift detected', jsonb_build_array(jsonb_build_object(
        'path', 'object', 'code', 'schema_drift', 'message', (expected->>'table') || '.' || (expected->>'name') || ': required materialized constraint is missing'
      )));
    end if;
    normalized_expected := regexp_replace(lower(coalesce(expected->>'expression', '')), '[[:space:]()"]', '', 'g');
    normalized_actual := regexp_replace(lower(coalesce(constraint_row.expression, '')), '[[:space:]()"]', '', 'g');
    if constraint_row.constraint_type <> expected->>'type'
      or not constraint_row.convalidated
      or (expected ? 'columns' and constraint_row.columns is distinct from expected->'columns')
      or (expected ? 'ref_table' and constraint_row.referenced_table is distinct from expected->>'ref_table')
      or (expected ? 'ref_columns' and constraint_row.referenced_columns is distinct from expected->'ref_columns')
      or (expected ? 'expression' and normalized_actual <> normalized_expected)
    then
      return kernel_admin_error('schema_drift', 'Schema drift detected', jsonb_build_array(jsonb_build_object(
        'path', 'object', 'code', 'schema_drift', 'message', (expected->>'table') || '.' || (expected->>'name') || ': materialized constraint definition or validation state differs from the compiled catalog'
      )));
    end if;
  end loop;

  for expected in select value from jsonb_array_elements(expected_indexes)
  loop
    select index_value.indisunique, index_value.indisvalid, index_value.indisready,
      pg_get_expr(index_value.indpred, index_value.indrelid, true) as predicate,
      (select jsonb_agg(coalesce(attribute.attname::text, pg_get_indexdef(index_value.indexrelid, key_column.ordinality::integer, true)) order by key_column.ordinality)
       from unnest(index_value.indkey::smallint[]) with ordinality as key_column(attnum, ordinality)
       left join pg_attribute as attribute on attribute.attrelid = index_value.indrelid and attribute.attnum = key_column.attnum
       where key_column.ordinality <= index_value.indnkeyatts) as columns
    into index_row
    from pg_index as index_value
    join pg_class as index_relation on index_relation.oid = index_value.indexrelid
    join pg_class as table_relation on table_relation.oid = index_value.indrelid
    join pg_namespace as namespace on namespace.oid = table_relation.relnamespace
    where namespace.nspname = current_schema() and table_relation.relname = expected->>'table'
      and index_relation.relname = expected->>'name';
    if not found then
      return kernel_admin_error('schema_drift', 'Schema drift detected', jsonb_build_array(jsonb_build_object(
        'path', 'object', 'code', 'schema_drift', 'message', (expected->>'table') || '.' || (expected->>'name') || ': required materialized index is missing'
      )));
    end if;
    normalized_expected := regexp_replace(lower(coalesce(expected->>'predicate', '')), '[[:space:]()"]', '', 'g');
    normalized_actual := regexp_replace(lower(coalesce(index_row.predicate, '')), '[[:space:]()"]', '', 'g');
    if index_row.indisunique <> (expected->>'unique')::boolean
      or not index_row.indisvalid or not index_row.indisready
      or index_row.columns is distinct from expected->'columns'
      or normalized_actual <> normalized_expected
    then
      return kernel_admin_error('schema_drift', 'Schema drift detected', jsonb_build_array(jsonb_build_object(
        'path', 'object', 'code', 'schema_drift', 'message', (expected->>'table') || '.' || (expected->>'name') || ': materialized index definition or readiness differs from the compiled catalog'
      )));
    end if;
  end loop;

  foreach requested_table_name in array policy_tables
  loop
    select relation.relrowsecurity, relation.relforcerowsecurity, policy.permissive, policy.cmd,
      policy.roles, policy.qual, policy.with_check
    into policy_row
    from pg_class as relation
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    left join pg_policies as policy on policy.schemaname = namespace.nspname
      and policy.tablename = relation.relname and policy.policyname = 'kernel_tenant_isolation'
    where namespace.nspname = current_schema() and relation.relname = requested_table_name;
    normalized_expected := regexp_replace(lower(
      'app_id, customer_id = SELECT scope.app_id, scope.customer_id FROM SELECT current_setting(''kernel.app_id''::text, true) AS app_id, current_setting(''kernel.customer_id''::text, true) AS customer_id scope WHERE kernel_principal_scope_authorized(''any''::text, scope.app_id, scope.customer_id, NULL::text)'
    ), '[[:space:]()"]', '', 'g');
    normalized_actual := regexp_replace(lower(coalesce(policy_row.qual, '')), '[[:space:]()"]', '', 'g');
    if not found or not policy_row.relrowsecurity or not policy_row.relforcerowsecurity
      or policy_row.permissive <> 'PERMISSIVE' or policy_row.cmd <> 'ALL'
      or policy_row.roles <> '{public}'::name[]
      or normalized_actual <> normalized_expected
      or regexp_replace(lower(coalesce(policy_row.with_check, '')), '[[:space:]()"]', '', 'g') <> normalized_expected
    then
      return kernel_admin_error('schema_drift', 'Schema drift detected', jsonb_build_array(jsonb_build_object(
        'path', 'object', 'code', 'schema_drift', 'message', requested_table_name || '.kernel_tenant_isolation: RLS or tenant policy differs from the compiled catalog'
      )));
    end if;
  end loop;
  if active_row ? 'materialized_tables' then
    if jsonb_typeof(active_row->'materialized_tables') <> 'array' then
      return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
        'path', 'materialized_tables', 'code', 'invalid_materialized_tables', 'message', 'materialized_tables must be a JSON array'
      )));
    end if;
    for extra_table in select value from jsonb_array_elements(active_row->'materialized_tables')
    loop
      if jsonb_typeof(extra_table) <> 'string' or (extra_table #>> '{}') !~ '^[A-Za-z][A-Za-z0-9_]*$' then
        return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
          'path', 'materialized_tables', 'code', 'invalid_materialized_table', 'message', 'materialized table names must be identifiers'
        )));
      end if;
      requested_table_name := extra_table #>> '{}';
      if to_regclass(format('%I.%I', current_schema(), requested_table_name)) is null then
        return kernel_admin_error('schema_drift', 'Schema drift detected', jsonb_build_array(jsonb_build_object(
          'path', 'object', 'code', 'schema_drift', 'message', requested_table_name || ': required materialized table is missing'
        )));
      end if;
    end loop;
  end if;
  if active_row ? 'materialized_assertions' then
    if jsonb_typeof(active_row->'materialized_assertions') <> 'array' then
      return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
        'path', 'materialized_assertions', 'code', 'invalid_materialized_assertions',
        'message', 'materialized_assertions must be a JSON array'
      )));
    end if;
    for assertion in select value from jsonb_array_elements(active_row->'materialized_assertions')
    loop
      assertion_kind := assertion->>'kind';
      requested_table_name := assertion->>'table';
      object_name := assertion->>'name';
      expected_definition := assertion->>'definition';
      if jsonb_typeof(assertion) <> 'object'
        or assertion_kind not in ('table', 'column', 'constraint', 'index', 'policy')
        or (assertion_kind <> 'index' and coalesce(requested_table_name, '') !~ '^[A-Za-z][A-Za-z0-9_]*$')
        or (assertion_kind <> 'table' and coalesce(object_name, '') !~ '^[A-Za-z][A-Za-z0-9_]*$')
      then
        return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
          'path', 'materialized_assertions', 'code', 'invalid_materialized_assertion',
          'message', 'materialized assertions require a supported kind and identifier names'
        )));
      end if;
      actual_definition := null;
      case assertion_kind
        when 'table' then
          assertion_exists := to_regclass(format('%I.%I', current_schema(), requested_table_name)) is not null;
        when 'column' then
          select exists (
            select 1 from information_schema.columns
            where table_schema = current_schema() and table_name = requested_table_name
              and column_name = object_name
          ) into assertion_exists;
          if assertion_exists and expected_definition is not null then
            select format('%s%s', data_type, case when is_nullable = 'YES' then ' nullable' else ' not null' end)
            into actual_definition
            from information_schema.columns
            where table_schema = current_schema() and table_name = requested_table_name
              and column_name = object_name;
          end if;
        when 'constraint' then
          select pg_get_constraintdef(catalog_constraint.oid, true)
          into actual_definition
          from pg_constraint as catalog_constraint
          join pg_class as relation on relation.oid = catalog_constraint.conrelid
          join pg_namespace as namespace on namespace.oid = relation.relnamespace
          where namespace.nspname = current_schema() and relation.relname = requested_table_name
            and catalog_constraint.conname = object_name and catalog_constraint.convalidated;
          assertion_exists := found;
        when 'index' then
          select indexes.indexdef into actual_definition
          from pg_indexes as indexes
          join pg_class as index_relation on index_relation.relname = indexes.indexname
          join pg_namespace as index_namespace on index_namespace.oid = index_relation.relnamespace and index_namespace.nspname = indexes.schemaname
          join pg_index as index_value on index_value.indexrelid = index_relation.oid
          where indexes.schemaname = current_schema() and indexes.indexname = object_name
            and (requested_table_name is null or indexes.tablename = requested_table_name)
            and index_value.indisvalid and index_value.indisready;
          assertion_exists := found;
        when 'policy' then
          select coalesce(qual, '') || '|' || coalesce(with_check, '')
          into actual_definition
          from pg_policies
          where schemaname = current_schema() and tablename = requested_table_name and policyname = object_name;
          assertion_exists := found;
      end case;
      if not assertion_exists then
        return kernel_admin_error('schema_drift', 'Schema drift detected', jsonb_build_array(jsonb_build_object(
          'path', 'object', 'code', 'schema_drift',
          'message', coalesce(requested_table_name || '.', '') || coalesce(object_name, requested_table_name) || ': required materialized object is missing'
        )));
      end if;
      if expected_definition is not null and actual_definition is distinct from expected_definition then
        return kernel_admin_error('schema_drift', 'Schema drift detected', jsonb_build_array(jsonb_build_object(
          'path', 'object', 'code', 'schema_drift',
          'message', coalesce(requested_table_name || '.', '') || coalesce(object_name, requested_table_name) || ': materialized definition differs from the compiled assertion'
        )));
      end if;
    end loop;
  end if;
  return null;
end;
$kernel$
"#;

const KERNEL_SCHEMA_REVISION_IS_ACTIVE_WITH_MATERIALIZED_TABLES: &str = r#"
create or replace function kernel_schema_revision_is_active_with_materialized_tables(request jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path from current
as $kernel$
declare
  expected_schema jsonb;
  request_app_id text;
  request_customer_id text;
  expected_revision_id bigint;
  expected_schema_hash text;
  active_id bigint;
  active_base_schema jsonb;
  active_schema jsonb;
  active_overlay jsonb;
  active_hash text;
  composed_schema jsonb;
  assertion_error jsonb;
begin
  if request is null or jsonb_typeof(request) <> 'object' then
    return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
      'path', 'request', 'code', 'invalid_request', 'message', 'request must be a JSON object'
    )));
  end if;
  expected_schema := case when request ? 'schema' then request->'schema' else request end;
  if expected_schema is null or jsonb_typeof(expected_schema) <> 'object' then
    return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
      'path', 'schema', 'code', 'invalid_schema', 'message', 'schema must be a JSON object'
    )));
  end if;
  request_app_id := expected_schema->>'app_id';
  request_customer_id := expected_schema->>'customer_id';
  if coalesce(btrim(request_app_id), '') = '' or coalesce(btrim(request_customer_id), '') = '' then
    return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
      'path', case when coalesce(btrim(request_app_id), '') = '' then 'app_id' else 'customer_id' end,
      'code', 'empty_scope_id', 'message', 'scope id must not be empty'
    )));
  end if;
  if not kernel_principal_scope_authorized(
    'runtime', request_app_id, request_customer_id, null
  ) then
    return kernel_authorize_scope(
      'runtime', request_app_id, request_customer_id, null
    );
  end if;
  if coalesce(btrim(expected_schema->>'version'), '') = '' then
    return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
      'path', 'version', 'code', 'empty_value', 'message', 'value must not be empty'
    )));
  end if;
  if jsonb_typeof(coalesce(expected_schema->'models', 'null'::jsonb)) <> 'array' then
    return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
      'path', 'models', 'code', 'invalid_models', 'message', 'models must be a JSON array'
    )));
  end if;
  if request ? 'expected_active_revision_id' then
    if jsonb_typeof(request->'expected_active_revision_id') <> 'number'
      or (request->>'expected_active_revision_id')::numeric <> trunc((request->>'expected_active_revision_id')::numeric)
      or (request->>'expected_active_revision_id')::numeric <= 0
    then
      return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
        'path', 'expected_active_revision_id', 'code', 'invalid_schema_revision_id', 'message', 'expected_active_revision_id must be a positive integer'
      )));
    end if;
    expected_revision_id := (request->>'expected_active_revision_id')::bigint;
  end if;
  expected_schema_hash := nullif(request->>'expected_schema_hash', '');

  perform set_config('kernel.app_id', request_app_id, true);
  perform set_config('kernel.customer_id', request_customer_id, true);

  select id, base_schema, schema, customer_overlay, schema_hash
  into active_id, active_base_schema, active_schema, active_overlay, active_hash
  from schema_revision
  where app_id = request_app_id and customer_id = request_customer_id and activated_at is not null
  for share;
  if not found then
    return jsonb_build_object('ok', true, 'data', false);
  end if;
  if expected_revision_id is not null and active_id <> expected_revision_id then
    return kernel_admin_error('stale_schema_revision', 'The supplied schema revision is not active', jsonb_build_array(jsonb_build_object(
      'path', 'schema_revision_id', 'code', 'stale_schema_revision',
      'message', format('Supplied schema_revision_id is %s; active schema_revision_id is %s', expected_revision_id, active_id)
    )));
  end if;
  if expected_schema_hash is not null and active_hash is distinct from expected_schema_hash then
    return kernel_admin_error('schema_revision_conflict', 'Schema revision already exists with different schema JSON', jsonb_build_array(
      jsonb_build_object('path', 'schema_revision.existing_schema_hash', 'code', 'schema_hash', 'message', coalesce(active_hash, '')),
      jsonb_build_object('path', 'schema_revision.current_schema_hash', 'code', 'schema_hash', 'message', expected_schema_hash)
    ));
  end if;
  if active_base_schema->>'version' <> expected_schema->>'version' then
    return jsonb_build_object('ok', true, 'data', false);
  end if;
  if active_base_schema <> expected_schema then
    return kernel_admin_error('schema_revision_conflict', 'Schema revision already exists with different schema JSON', jsonb_build_array(
      jsonb_build_object('path', 'schema_revision.existing_schema_hash', 'code', 'schema_hash', 'message', coalesce(active_hash, kernel_admin_sha256(kernel_canonical_json(active_base_schema)))),
      jsonb_build_object('path', 'schema_revision.current_schema_hash', 'code', 'schema_hash', 'message', coalesce(expected_schema_hash, kernel_admin_sha256(kernel_canonical_json(expected_schema))))
    ));
  end if;
  composed_schema := kernel_admin_apply_overlay(expected_schema, active_overlay);
  composed_schema := jsonb_set(composed_schema, '{version}', to_jsonb(active_schema->>'version'));
  if composed_schema <> active_schema then
    return kernel_admin_error('schema_revision_conflict', 'Schema revision already exists with different schema JSON', jsonb_build_array(
      jsonb_build_object('path', 'schema_revision.existing_schema_hash', 'code', 'schema_hash', 'message', coalesce(active_hash, kernel_admin_sha256(kernel_canonical_json(active_schema)))),
      jsonb_build_object('path', 'schema_revision.current_schema_hash', 'code', 'schema_hash', 'message', kernel_admin_sha256(kernel_canonical_json(composed_schema)))
    ));
  end if;
  assertion_error := kernel_admin_materialization_error(expected_schema, request);
  if assertion_error is not null then
    return assertion_error;
  end if;
  return jsonb_build_object('ok', true, 'data', true);
exception
  when others then
    return kernel_admin_error('database_error', 'Database operation failed', '[]'::jsonb);
end;
$kernel$
"#;

const KERNEL_RECORD_AGENT_RUN: &str = r#"
create or replace function kernel_record_agent_run(request jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path from current
as $kernel$
declare
  app_id_value text;
  customer_id_value text;
  run_id_value text;
  status_value text;
  supplied_revision_id bigint;
  active_revision_id bigint;
  existing agent_run%rowtype;
  inserted_id bigint;
  field_name text;
  expected_value jsonb;
  actual_value jsonb;
  array_field text;
  object_field text;
  policy_snapshot jsonb;
  validation_issues jsonb := '[]'::jsonb;
begin
  if request is null or jsonb_typeof(request) <> 'object' then
    return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
      'path', 'request', 'code', 'invalid_request', 'message', 'request must be a JSON object'
    )));
  end if;
  app_id_value := request->>'app_id';
  customer_id_value := request->>'customer_id';
  run_id_value := request->>'run_id';
  foreach field_name in array array['app_id', 'customer_id', 'run_id', 'agent_identity_id', 'execution_profile_id']
  loop
    if coalesce(btrim(request->>field_name), '') = '' then
      validation_issues := validation_issues || jsonb_build_array(jsonb_build_object(
        'path', field_name,
        'code', case when field_name in ('app_id', 'customer_id') then 'empty_scope_id' else 'empty_value' end,
        'message', case when field_name in ('app_id', 'customer_id') then 'scope id must not be empty' else 'value must not be empty' end
      ));
    end if;
  end loop;
  status_value := coalesce(request->>'status', 'recorded');
  if status_value not in ('recorded', 'completed', 'validation_exhausted', 'budget_exhausted', 'runtime_error', 'cancelled') then
    validation_issues := validation_issues || jsonb_build_array(jsonb_build_object(
      'path', 'status', 'code', 'invalid_agent_run_status', 'message', 'agent run status is not recognized'
    ));
  end if;
  if request ? 'schema_revision_id' and request->'schema_revision_id' <> 'null'::jsonb then
    if jsonb_typeof(request->'schema_revision_id') not in ('number', 'string')
      or (request->>'schema_revision_id') !~ '^[0-9]+$'
      or (request->>'schema_revision_id')::numeric <= 0
      or (request->>'schema_revision_id')::numeric > 9223372036854775807
    then
      validation_issues := validation_issues || jsonb_build_array(jsonb_build_object(
        'path', 'schema_revision_id', 'code', 'invalid_schema_revision_id', 'message', 'schema_revision_id must be positive when supplied'
      ));
    else
      supplied_revision_id := (request->>'schema_revision_id')::bigint;
    end if;
  end if;
  foreach array_field in array array['source_artifacts', 'alignment_decisions', 'model_calls', 'tool_calls', 'validation_failures', 'approval_boundaries', 'compiled_preview_ids']
  loop
    if request ? array_field and jsonb_typeof(request->array_field) is distinct from 'array' then
      validation_issues := validation_issues || jsonb_build_array(jsonb_build_object(
        'path', array_field, 'code', 'invalid_json_evidence',
        'message', 'agent run evidence field must be omitted for defaults or supplied as a JSON array'
      ));
    end if;
  end loop;
  foreach object_field in array array['token_usage', 'final_outputs']
  loop
    if request ? object_field and jsonb_typeof(request->object_field) is distinct from 'object' then
      validation_issues := validation_issues || jsonb_build_array(jsonb_build_object(
        'path', object_field, 'code', 'invalid_json_evidence',
        'message', 'agent run evidence field must be omitted for defaults or supplied as a JSON object'
      ));
    end if;
  end loop;
  if jsonb_array_length(validation_issues) > 0 then
    return kernel_admin_validation_error(validation_issues);
  end if;

  if not kernel_principal_scope_authorized(
    'runtime', app_id_value, customer_id_value, null
  ) then
    return kernel_authorize_scope(
      'runtime', app_id_value, customer_id_value, null
    );
  end if;

  perform set_config('kernel.app_id', app_id_value, true);
  perform set_config('kernel.customer_id', customer_id_value, true);
  perform pg_advisory_xact_lock_shared(hashtext(
    'postgres-schema:' || current_schema() || ':materialize-tenant:' || app_id_value || ':' || customer_id_value || ':schema-activation'
  )::bigint);
  select id into active_revision_id from schema_revision
  where app_id = app_id_value and customer_id = customer_id_value and activated_at is not null
  for share;
  if not found then
    select * into existing from agent_run
    where app_id = app_id_value and customer_id = customer_id_value and run_id = run_id_value;
    if not found then
      return kernel_admin_error('active_schema_missing', 'No active schema revision exists for this scope', jsonb_build_array(jsonb_build_object(
        'path', 'scope', 'code', 'active_schema_missing',
        'message', app_id_value || '/' || customer_id_value || ': materialize a schema before applying or reading records'
      )));
    end if;
  else
    policy_snapshot := kernel_policy_active_snapshot(app_id_value, customer_id_value);
    if coalesce((policy_snapshot->>'declared')::boolean, false) then
      perform kernel_policy_request_actor(app_id_value, customer_id_value);
      return kernel_admin_error(
        'unsupported_capability',
        'Agent-run record envelopes are unavailable for policy-enabled revisions',
        jsonb_build_array(jsonb_build_object(
          'path', 'capability', 'code', 'unsupported_capability',
          'message', 'use an application-owned policy-aware workflow record'
        ))
      );
    end if;
  end if;
  select * into existing from agent_run
  where app_id = app_id_value and customer_id = customer_id_value and run_id = run_id_value;
  if found then
    if supplied_revision_id is not null and supplied_revision_id <> existing.schema_revision_id then
      return kernel_admin_error('agent_run_schema_mismatch', format(
        'agent run `%s` was recorded against schema_revision_id `%s` not supplied schema_revision_id `%s`',
        run_id_value, existing.schema_revision_id, supplied_revision_id
      ), '[]'::jsonb);
    end if;
    foreach field_name in array array[
      'actor_id', 'agent_identity_id', 'execution_profile_id', 'source_artifacts',
      'alignment_decisions', 'model_calls', 'tool_calls', 'token_usage',
      'validation_failures', 'final_outputs', 'approval_boundaries', 'compiled_preview_ids'
    ]
    loop
      expected_value := case field_name
        when 'actor_id' then coalesce(request->'actor_id', 'null'::jsonb)
        when 'agent_identity_id' then to_jsonb(request->>'agent_identity_id')
        when 'execution_profile_id' then to_jsonb(request->>'execution_profile_id')
        when 'token_usage' then coalesce(request->field_name, '{}'::jsonb)
        when 'final_outputs' then coalesce(request->field_name, '{}'::jsonb)
        else coalesce(request->field_name, '[]'::jsonb)
      end;
      actual_value := case field_name
        when 'actor_id' then coalesce(to_jsonb(existing.actor_id), 'null'::jsonb)
        when 'agent_identity_id' then to_jsonb(existing.agent_identity_id)
        when 'execution_profile_id' then to_jsonb(existing.execution_profile_id)
        when 'source_artifacts' then existing.source_artifacts
        when 'alignment_decisions' then existing.alignment_decisions
        when 'model_calls' then existing.model_calls
        when 'tool_calls' then existing.tool_calls
        when 'token_usage' then existing.token_usage
        when 'validation_failures' then existing.validation_failures
        when 'final_outputs' then existing.final_outputs
        when 'approval_boundaries' then existing.approval_boundaries
        else existing.compiled_preview_ids
      end;
      if actual_value is distinct from expected_value then
        return kernel_admin_error('agent_run_conflict', format(
          'agent run `%s` is already recorded with different `%s`', run_id_value, field_name
        ), '[]'::jsonb);
      end if;
    end loop;
    return jsonb_build_object('ok', true, 'data', jsonb_build_object(
      'id', existing.id, 'run_id', run_id_value, 'schema_revision_id', existing.schema_revision_id
    ));
  end if;

  if supplied_revision_id is not null and supplied_revision_id <> active_revision_id then
    return kernel_admin_error('stale_schema_revision', 'The supplied schema revision is not active', jsonb_build_array(jsonb_build_object(
      'path', 'schema_revision_id', 'code', 'stale_schema_revision',
      'message', format('Supplied schema_revision_id is %s; active schema_revision_id is %s', supplied_revision_id, active_revision_id)
    )));
  end if;
  insert into agent_run (
    app_id, customer_id, run_id, status, schema_revision_id, actor_id,
    agent_identity_id, execution_profile_id, source_artifacts, alignment_decisions,
    model_calls, tool_calls, token_usage, validation_failures, final_outputs,
    approval_boundaries, compiled_preview_ids
  ) values (
    app_id_value, customer_id_value, run_id_value, status_value, active_revision_id,
    request->>'actor_id', request->>'agent_identity_id', request->>'execution_profile_id',
    coalesce(request->'source_artifacts', '[]'::jsonb), coalesce(request->'alignment_decisions', '[]'::jsonb),
    coalesce(request->'model_calls', '[]'::jsonb), coalesce(request->'tool_calls', '[]'::jsonb),
    coalesce(request->'token_usage', '{}'::jsonb), coalesce(request->'validation_failures', '[]'::jsonb),
    coalesce(request->'final_outputs', '{}'::jsonb), coalesce(request->'approval_boundaries', '[]'::jsonb),
    coalesce(request->'compiled_preview_ids', '[]'::jsonb)
  ) on conflict (app_id, customer_id, run_id) do nothing returning id into inserted_id;
  if inserted_id is null then
    return kernel_record_agent_run(request);
  end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'id', inserted_id, 'run_id', run_id_value, 'schema_revision_id', active_revision_id
  ));
exception
  when others then
    return kernel_admin_error('database_error', 'Database operation failed', '[]'::jsonb);
end;
$kernel$
"#;

const KERNEL_UPDATE_AGENT_RUN_STATUS: &str = r#"
create or replace function kernel_update_agent_run_status(request jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path from current
as $kernel$
declare
  app_id_value text;
  customer_id_value text;
  run_id_value text;
  status_value text;
  existing agent_run%rowtype;
  active_revision_id bigint;
  array_field text;
  object_field text;
  merged_model_calls jsonb;
  merged_tool_calls jsonb;
  merged_token_usage jsonb;
  merged_validation_failures jsonb;
  merged_final_outputs jsonb;
  policy_snapshot jsonb;
  validation_issues jsonb := '[]'::jsonb;
begin
  if request is null or jsonb_typeof(request) <> 'object' then
    return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
      'path', 'request', 'code', 'invalid_request', 'message', 'request must be a JSON object'
    )));
  end if;
  app_id_value := request->>'app_id';
  customer_id_value := request->>'customer_id';
  run_id_value := request->>'run_id';
  status_value := request->>'status';
  foreach array_field in array array['app_id', 'customer_id', 'run_id']
  loop
    if coalesce(btrim(request->>array_field), '') = '' then
      validation_issues := validation_issues || jsonb_build_array(jsonb_build_object(
        'path', array_field,
        'code', case when array_field in ('app_id', 'customer_id') then 'empty_scope_id' else 'empty_value' end,
        'message', case when array_field in ('app_id', 'customer_id') then 'scope id must not be empty' else 'value must not be empty' end
      ));
    end if;
  end loop;
  if status_value not in ('completed', 'validation_exhausted', 'budget_exhausted', 'runtime_error', 'cancelled') then
    validation_issues := validation_issues || jsonb_build_array(jsonb_build_object(
      'path', 'status', 'code', 'invalid_agent_run_status',
      'message', 'agent run status updates must move a recorded run to a terminal status'
    ));
  end if;
  foreach array_field in array array['model_calls', 'tool_calls', 'validation_failures']
  loop
    if request ? array_field and request->array_field <> 'null'::jsonb and jsonb_typeof(request->array_field) <> 'array' then
      validation_issues := validation_issues || jsonb_build_array(jsonb_build_object(
        'path', array_field, 'code', 'invalid_json_evidence',
        'message', 'agent run evidence field must be omitted or supplied as a JSON array'
      ));
    end if;
  end loop;
  foreach object_field in array array['token_usage', 'final_outputs']
  loop
    if request ? object_field and request->object_field <> 'null'::jsonb and jsonb_typeof(request->object_field) <> 'object' then
      validation_issues := validation_issues || jsonb_build_array(jsonb_build_object(
        'path', object_field, 'code', 'invalid_json_evidence',
        'message', 'agent run evidence field must be omitted or supplied as a JSON object'
      ));
    end if;
  end loop;
  if jsonb_array_length(validation_issues) > 0 then
    return kernel_admin_validation_error(validation_issues);
  end if;

  if not kernel_principal_scope_authorized(
    'runtime', app_id_value, customer_id_value, null
  ) then
    return kernel_authorize_scope(
      'runtime', app_id_value, customer_id_value, null
    );
  end if;

  perform set_config('kernel.app_id', app_id_value, true);
  perform set_config('kernel.customer_id', customer_id_value, true);
  perform pg_advisory_xact_lock_shared(hashtext(
    'postgres-schema:' || current_schema() || ':materialize-tenant:' || app_id_value || ':' || customer_id_value || ':schema-activation'
  )::bigint);
  select id into active_revision_id from schema_revision
  where app_id = app_id_value and customer_id = customer_id_value and activated_at is not null
  for share;
  select * into existing from agent_run
  where app_id = app_id_value and customer_id = customer_id_value and run_id = run_id_value
  for update;
  if active_revision_id is null then
    if existing.id is not null and existing.status = status_value then
      return jsonb_build_object('ok', true, 'data', jsonb_build_object(
        'id', existing.id, 'run_id', run_id_value, 'schema_revision_id', existing.schema_revision_id
      ));
    end if;
    return kernel_admin_error('active_schema_missing', 'No active schema revision exists for this scope', jsonb_build_array(jsonb_build_object(
      'path', 'scope', 'code', 'active_schema_missing',
      'message', app_id_value || '/' || customer_id_value || ': materialize a schema before applying or reading records'
    )));
  end if;
  policy_snapshot := kernel_policy_active_snapshot(app_id_value, customer_id_value);
  if coalesce((policy_snapshot->>'declared')::boolean, false) then
    perform kernel_policy_request_actor(app_id_value, customer_id_value);
    return kernel_admin_error(
      'unsupported_capability',
      'Agent-run status envelopes are unavailable for policy-enabled revisions',
      jsonb_build_array(jsonb_build_object(
        'path', 'capability', 'code', 'unsupported_capability',
        'message', 'use an application-owned policy-aware workflow record'
      ))
    );
  end if;
  if existing.id is null then
    return kernel_admin_error('agent_run_missing', format('agent run `%s` has not been recorded', run_id_value), '[]'::jsonb);
  end if;
  if existing.status = status_value then
    return jsonb_build_object('ok', true, 'data', jsonb_build_object(
      'id', existing.id, 'run_id', run_id_value, 'schema_revision_id', existing.schema_revision_id
    ));
  end if;
  if existing.status <> 'recorded' then
    return kernel_admin_error('agent_run_conflict', format(
      'agent run `%s` is already terminal with status `%s`', run_id_value, existing.status
    ), '[]'::jsonb);
  end if;
  merged_model_calls := existing.model_calls || coalesce(nullif(request->'model_calls', 'null'::jsonb), '[]'::jsonb);
  merged_tool_calls := existing.tool_calls || coalesce(nullif(request->'tool_calls', 'null'::jsonb), '[]'::jsonb);
  merged_validation_failures := existing.validation_failures || coalesce(nullif(request->'validation_failures', 'null'::jsonb), '[]'::jsonb);
  merged_token_usage := coalesce(nullif(request->'token_usage', 'null'::jsonb), '{}'::jsonb) || existing.token_usage;
  merged_final_outputs := coalesce(nullif(request->'final_outputs', 'null'::jsonb), '{}'::jsonb) || existing.final_outputs;
  update agent_run set
    status = status_value,
    model_calls = merged_model_calls,
    tool_calls = merged_tool_calls,
    token_usage = merged_token_usage,
    validation_failures = merged_validation_failures,
    final_outputs = merged_final_outputs
  where id = existing.id;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'id', existing.id, 'run_id', run_id_value, 'schema_revision_id', existing.schema_revision_id
  ));
exception
  when others then
    return kernel_admin_error('database_error', 'Database operation failed', '[]'::jsonb);
end;
$kernel$
"#;
