use super::RuntimeSqlFunction;

pub(super) fn functions() -> Vec<RuntimeSqlFunction> {
    [
        ("kernel_lookup_list(jsonb)", LOOKUP_LIST),
        (
            "kernel_lookup_label_at(text,text,text,uuid,date,bigint,bigint)",
            LOOKUP_LABEL_AT,
        ),
        ("kernel_lookup_resolve_batch(jsonb)", LOOKUP_RESOLVE_BATCH),
        ("kernel_lookup_hydrate(jsonb)", LOOKUP_HYDRATE),
        (
            "kernel_lookup_reference_count(jsonb)",
            LOOKUP_REFERENCE_COUNT,
        ),
        (
            "kernel_lookup_set_availability(jsonb)",
            LOOKUP_SET_AVAILABILITY,
        ),
        (
            "kernel_lookup_transfer_error(text,text,text,text)",
            LOOKUP_TRANSFER_ERROR,
        ),
        ("kernel_lookup_transfer_alias(jsonb)", LOOKUP_TRANSFER_ALIAS),
    ]
    .into_iter()
    .map(|(signature, sql)| RuntimeSqlFunction {
        signature,
        sql: sql.trim().to_string(),
    })
    .collect()
}

pub(super) const LOOKUP_NORMALIZE_LABEL: &str = r#"
create or replace function kernel_apply_normalize_lookup_label(label text)
returns text
language sql
immutable
strict
parallel safe
security invoker
set search_path from current
as $kernel_lookup$
  select nullif(lower(regexp_replace(btrim(label), '[[:space:]_-]+', '_', 'g')), '')
$kernel_lookup$
"#;

pub(super) const LOOKUP_PREPARE_APPLY: &str = r#"
create or replace function kernel_apply_prepare_lookup_or_create(request jsonb, active_schema jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path from current
as $kernel_lookup$
<<kernel_apply_prepare_lookup_or_create>>
declare
  app_id text := request->>'app_id';
  customer_id text := request->>'customer_id';
  writes jsonb := request->'writes';
  intents jsonb := '[]'::jsonb;
  intent_map jsonb := '{}'::jsonb;
  lock_map jsonb := '{}'::jsonb;
  resolved_map jsonb := '{}'::jsonb;
  created_map jsonb := '{}'::jsonb;
  generated_writes jsonb := '[]'::jsonb;
  write jsonb;
  write_index bigint;
  source_model jsonb;
  field_entry record;
  relation_definition jsonb;
  custom_entry jsonb;
  custom_index bigint;
  relation_key jsonb;
  target_index bigint;
  target_model_id text;
  intent jsonb;
  payload jsonb;
  target_model jsonb;
  display_field_id text;
  normalized_label text;
  label_key text;
  intent_key text;
  intent_effective_start date;
  existing_intent jsonb;
  intent_contract jsonb;
  candidate_ids uuid[];
  candidate_count integer;
  resolved_record_id uuid;
  reserved_record_id uuid;
  create_values jsonb;
  generated_write jsonb;
  patch_path text[];
begin
  if jsonb_typeof(coalesce(writes,'null'::jsonb))<>'array' then return request; end if;

  select value,ordinal-1 into write,write_index
  from jsonb_array_elements(writes) with ordinality item(value,ordinal)
  where exists(
    select 1 from jsonb_object_keys(case when jsonb_typeof(value)='object' then value else '{}'::jsonb end) key
    where key like '\_\_kernel\_%' escape '\'
  )
  order by ordinal
  limit 1;
  if write is not null then
    perform kernel_apply_fail(
      'contract_validation_failed','Contract validation failed','writes[' || write_index || ']',
      'reserved_internal_apply_field','caller-supplied __kernel_ fields are forbidden'
    );
  end if;

  for write,write_index in
    select value,ordinal-1 from jsonb_array_elements(writes) with ordinality item(value,ordinal)
  loop
    select value into source_model from jsonb_array_elements(coalesce(active_schema->'models','[]'::jsonb)) item(value)
    where value->>'id'=write->>'model_id';
    if source_model is null then continue; end if;

    for field_entry in
      select key,value from jsonb_each(case when jsonb_typeof(write->'values')='object' then write->'values' else '{}'::jsonb end)
    loop
      relation_key:=field_entry.value->'value';
      if field_entry.value->>'type'='relation' and relation_key->>'type'='lookup_or_create' then
        select value into relation_definition from jsonb_array_elements(coalesce(source_model->'fields','[]'::jsonb)) item(value)
        where value->>'id'=field_entry.key and value->>'type'='relation';
        if relation_definition is null then continue; end if;
        intents:=intents || jsonb_build_array(jsonb_build_object(
          'target_model_id',relation_definition->>'target_model','payload',relation_key->'value',
          'effective_start',write->>'effective_start','provenance',write->'provenance',
          'path',jsonb_build_array(write_index::text,'values',field_entry.key,'value'),
          'path_label','writes[' || write_index || '].values.' || field_entry.key
        ));
      elsif field_entry.value->>'type'='relation_list' and jsonb_typeof(field_entry.value->'value')='array' then
        select value into relation_definition from jsonb_array_elements(coalesce(source_model->'many_relations','[]'::jsonb)) item(value)
        where value->>'id'=field_entry.key;
        if relation_definition is null then continue; end if;
        for relation_key,target_index in
          select value,ordinal-1 from jsonb_array_elements(field_entry.value->'value') with ordinality target(value,ordinal)
        loop
          if relation_key->>'type'<>'lookup_or_create' then continue; end if;
          intents:=intents || jsonb_build_array(jsonb_build_object(
            'target_model_id',relation_definition->>'target_model','payload',relation_key->'value',
            'effective_start',write->>'effective_start','provenance',write->'provenance',
            'path',jsonb_build_array(write_index::text,'values',field_entry.key,'value',target_index::text),
            'path_label','writes[' || write_index || '].values.' || field_entry.key || '[' || target_index || ']'
          ));
        end loop;
      end if;
    end loop;

    for custom_entry,custom_index in
      select value,ordinal-1 from jsonb_array_elements(case when jsonb_typeof(write->'custom_fields')='array' then write->'custom_fields' else '[]'::jsonb end)
        with ordinality item(value,ordinal)
    loop
      relation_key:=custom_entry->'value';
      if custom_entry->>'type'<>'relation' or relation_key->>'type'<>'lookup_or_create' then continue; end if;
      select value into relation_definition from jsonb_array_elements(coalesce(active_schema->'custom_fields','[]'::jsonb)) item(value)
      where value->>'model_id'=write->>'model_id' and value->>'field_id'=custom_entry->>'field_id'
        and value->>'type'='relation';
      if relation_definition is null then continue; end if;
      intents:=intents || jsonb_build_array(jsonb_build_object(
        'target_model_id',relation_definition->>'target_model_id','payload',relation_key->'value',
        'effective_start',write->>'effective_start','provenance',write->'provenance',
        'path',jsonb_build_array(write_index::text,'custom_fields',custom_index::text,'value'),
        'path_label','writes[' || write_index || '].custom_fields[' || custom_index || '].value'
      ));
    end loop;
  end loop;

  if jsonb_array_length(intents)=0 then return request; end if;

  for intent in select value from jsonb_array_elements(intents) item(value) loop
    payload:=intent->'payload';
    if jsonb_typeof(payload)<>'object'
      or not (payload ? 'label')
      or payload-array['label','values']<>'{}'::jsonb
      or jsonb_typeof(payload->'label')<>'string'
      or (payload ? 'values' and jsonb_typeof(payload->'values')<>'object')
    then
      perform kernel_apply_fail(
        'contract_validation_failed','Contract validation failed',intent->>'path_label',
        'invalid_lookup_or_create','lookup_or_create requires a nonblank label and optional typed values object'
      );
    end if;
    normalized_label:=kernel_apply_normalize_lookup_label(payload->>'label');
    if normalized_label is null then
      perform kernel_apply_fail(
        'contract_validation_failed','Contract validation failed',intent->>'path_label',
        'empty_lookup_match_label','lookup_or_create label must not be blank'
      );
    end if;
    target_model_id:=intent->>'target_model_id';
    select value into target_model from jsonb_array_elements(coalesce(active_schema->'models','[]'::jsonb)) item(value)
    where value->>'id'=target_model_id;
    if target_model is null or target_model->>'kind'<>'lookup' then
      perform kernel_apply_fail(
        'contract_validation_failed','Contract validation failed',intent->>'path_label',
        'lookup_or_create_target_not_lookup','lookup_or_create is valid only for relations targeting lookup models'
      );
    end if;
    if coalesce(target_model->>'lifecycle','active')<>'active' then
      perform kernel_apply_fail(
        'contract_validation_failed','Contract validation failed',intent->>'path_label',
        'retired_relation_target_model','lookup_or_create cannot target a retired lookup model'
      );
    end if;
    perform kernel_apply_assert_lookup_storage_authority(app_id,customer_id,target_model_id);
    display_field_id:=target_model->>'display_field_id';
    if display_field_id is null then
      perform kernel_apply_fail('schema_drift','Schema drift detected',intent->>'path_label','lookup_display_field_missing','lookup model has no display_field_id');
    end if;
    if coalesce(payload->'values','{}'::jsonb) ? display_field_id then
      perform kernel_apply_fail(
        'contract_validation_failed','Contract validation failed',intent->>'path_label' || '.values.' || display_field_id,
        'lookup_display_value_conflict','lookup_or_create derives the display field from label; values must not also supply it'
      );
    end if;
    label_key:=target_model_id || ':' || normalized_label;
    intent_key:=label_key || ':' || (intent->>'effective_start');
    intent_contract:=jsonb_build_object(
      'label',payload->>'label','values',coalesce(payload->'values','{}'::jsonb),
      'effective_start',intent->>'effective_start'
    );
    existing_intent:=intent_map->intent_key;
    if existing_intent is not null and existing_intent->'contract' is distinct from intent_contract then
      perform kernel_apply_fail(
        'contract_validation_failed','Contract validation failed',intent->>'path_label',
        'lookup_create_intent_conflict','one change set cannot supply different create payloads for the same normalized lookup label'
      );
    elsif existing_intent is null then
      intent_map:=intent_map || jsonb_build_object(intent_key,jsonb_build_object(
        'target_model_id',target_model_id,'normalized_label',normalized_label,
        'display_field_id',display_field_id,'contract',intent_contract,
        'provenance',intent->'provenance','path_label',intent->>'path_label',
        'label_key',label_key
      ));
      lock_map:=lock_map || jsonb_build_object(label_key,true);
    end if;
  end loop;

  for label_key,intent in select key,value from jsonb_each(lock_map) order by key loop
    perform pg_advisory_xact_lock(hashtextextended(
      'lookup-normalized:' || current_schema() || ':' || app_id || ':' || customer_id || ':' || label_key,0
    ));
  end loop;

  for intent_key,intent in
    select key,value from jsonb_each(intent_map)
    order by value->>'target_model_id',value->>'normalized_label',value#>>'{contract,effective_start}',key
  loop
    target_model_id:=intent->>'target_model_id';
    normalized_label:=intent->>'normalized_label';
    label_key:=intent->>'label_key';
    intent_effective_start:=(intent#>>'{contract,effective_start}')::date;
    candidate_ids:=null;
    with visible_versions as (
      select distinct on (version.record_id)
        version.id,version.record_id,version.availability,
        version.tombstones_record,version.untombstones_record
      from lookup_version version
      join change_set changes
        on changes.id=version.change_set_id and changes.app_id=version.app_id
       and changes.customer_id=version.customer_id
      where version.app_id=kernel_apply_prepare_lookup_or_create.app_id
        and version.customer_id=kernel_apply_prepare_lookup_or_create.customer_id
        and version.model_id=target_model_id and version.stage='mainline'
        and changes.status='mainline' and changes.applied_order is not null
        and version.effective_start<=intent_effective_start
        and (version.effective_end is null or version.effective_end>=intent_effective_start)
      order by version.record_id,version.effective_start desc,version.tombstones_record desc,
        version.untombstones_record desc,changes.applied_order desc,version.id desc
    )
    select array_agg(candidate.record_id order by candidate.record_id) into candidate_ids
    from (
      select distinct projection.record_id
      from visible_versions visible
      join lookup_alias_projection projection
        on projection.app_id=kernel_apply_prepare_lookup_or_create.app_id
       and projection.customer_id=kernel_apply_prepare_lookup_or_create.customer_id
       and projection.model_id=target_model_id and projection.version_id=visible.id
      where projection.normalized_alias=normalized_label
        and visible.availability='active'
        and not visible.tombstones_record and not visible.untombstones_record
    ) candidate;
    candidate_count:=coalesce(cardinality(candidate_ids),0);
    if candidate_count>1 then
      perform kernel_apply_fail(
        'lookup_match_ambiguous','Normalized lookup match is ambiguous',intent->>'path_label',
        'lookup_match_ambiguous','more than one active lookup record owns normalized label `' || normalized_label || '`'
      );
    end if;
    resolved_record_id:=case when candidate_count=1 then candidate_ids[1] else null end;
    if resolved_record_id is null then
      reserved_record_id:=null;
      select projection.record_id into reserved_record_id
      from lookup_alias_projection projection
      join lookup_version version
        on version.app_id=projection.app_id and version.customer_id=projection.customer_id
       and version.model_id=projection.model_id and version.id=projection.version_id
      join change_set changes
        on changes.id=version.change_set_id and changes.app_id=version.app_id
       and changes.customer_id=version.customer_id
      where projection.app_id=kernel_apply_prepare_lookup_or_create.app_id
        and projection.customer_id=kernel_apply_prepare_lookup_or_create.customer_id
        and projection.model_id=target_model_id and projection.normalized_alias=normalized_label
        and version.stage<>'discarded' and changes.status in ('mainline','draft')
      order by projection.record_id
      limit 1;
      if reserved_record_id is not null then
        perform kernel_apply_fail(
          'lookup_label_reserved','Lookup label is reserved',intent->>'path_label',
          'lookup_label_reserved','normalized label `' || normalized_label || '` belongs to a retired, tombstoned, renamed, or pending-draft lookup record'
        );
      end if;

      existing_intent:=created_map->label_key;
      if existing_intent is not null then
        if existing_intent->'contract' is distinct from ((intent->'contract')-'effective_start'::text) then
          perform kernel_apply_fail(
            'contract_validation_failed','Contract validation failed',intent->>'path_label',
            'lookup_create_intent_conflict','temporal lookup create intents for one normalized label must use the same create payload'
          );
        end if;
        resolved_record_id:=(existing_intent->>'record_id')::uuid;
      else
        resolved_record_id:=gen_random_uuid();
        create_values:=coalesce(intent#>'{contract,values}','{}'::jsonb) || jsonb_build_object(
          intent->>'display_field_id',jsonb_build_object('type','text','value',intent#>>'{contract,label}')
        );
        generated_write:=jsonb_build_object(
          'model_id',target_model_id,'new_record_id',resolved_record_id,
          'effective_start',intent#>>'{contract,effective_start}','values',create_values,
          '__kernel_lookup_or_create',true
        );
        if intent ? 'provenance' and intent->'provenance'<>'null'::jsonb then
          generated_write:=generated_write || jsonb_build_object('provenance',intent->'provenance');
        end if;
        generated_writes:=generated_writes || jsonb_build_array(generated_write);
        created_map:=created_map || jsonb_build_object(label_key,jsonb_build_object(
          'record_id',resolved_record_id,'contract',(intent->'contract')-'effective_start'::text
        ));
      end if;
    end if;
    resolved_map:=resolved_map || jsonb_build_object(intent_key,resolved_record_id::text);
  end loop;

  for intent in select value from jsonb_array_elements(intents) item(value) loop
    normalized_label:=kernel_apply_normalize_lookup_label(intent#>>'{payload,label}');
    intent_key:=(intent->>'target_model_id') || ':' || normalized_label || ':' || (intent->>'effective_start');
    resolved_record_id:=(resolved_map->>intent_key)::uuid;
    select array_agg(value order by ordinal) into patch_path
    from jsonb_array_elements_text(intent->'path') with ordinality part(value,ordinal);
    writes:=jsonb_set(
      writes,patch_path,
      jsonb_build_object('type','record_id','value',resolved_record_id),false
    );
  end loop;

  return jsonb_set(request,'{writes}',generated_writes || writes,false);
end;
$kernel_lookup$
"#;

const LOOKUP_LABEL_AT: &str = r#"
create or replace function kernel_lookup_label_at(
  requested_app_id text,
  requested_customer_id text,
  requested_model_id text,
  requested_record_id uuid,
  requested_as_of date,
  maximum_applied_order bigint default null,
  pinned_schema_revision_id bigint default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path from current
as $kernel_lookup$
declare
  schema_json jsonb;
  model_json jsonb;
  display_field_id text;
  label_version record;
  authority_error jsonb;
begin
  perform set_config('kernel.app_id',requested_app_id,true);
  perform set_config('kernel.customer_id',requested_customer_id,true);
  if pinned_schema_revision_id is null then
    schema_json:=kernel_read_scope_schema(requested_app_id,requested_customer_id);
  else
    select schema into schema_json from schema_revision
    where id=pinned_schema_revision_id and app_id=requested_app_id and customer_id=requested_customer_id;
    if schema_json is null then raise exception 'active_schema_missing: %/%',requested_app_id,requested_customer_id; end if;
  end if;
  select value into model_json from jsonb_array_elements(schema_json->'models') item(value)
  where value->>'id'=requested_model_id and value->>'kind'='lookup';
  if model_json is null then raise exception 'record_target_missing: lookup model `%` did not resolve',requested_model_id; end if;
  authority_error:=kernel_lookup_storage_authority_error(
    requested_app_id,requested_customer_id,requested_model_id
  );
  if authority_error is not null then
    return jsonb_build_object('ok',false,'error',authority_error);
  end if;
  display_field_id:=coalesce(model_json->>'display_field_id','name');
  select v.id,v.change_set_id,v.effective_start,v.availability,v.tombstones_record,
         coalesce(v.values->display_field_id->>'value',requested_record_id::text) label,
         cs.applied_order
  into label_version
  from lookup_version v join change_set cs
    on cs.id=v.change_set_id and cs.app_id=v.app_id and cs.customer_id=v.customer_id
  where v.app_id=requested_app_id and v.customer_id=requested_customer_id
    and v.model_id=requested_model_id and v.record_id=requested_record_id
    and v.stage='mainline' and cs.status='mainline' and cs.applied_order is not null
    and v.effective_start<=requested_as_of
    and (v.effective_end is null or v.effective_end>=requested_as_of)
    and (maximum_applied_order is null or cs.applied_order<=maximum_applied_order)
  order by v.effective_start desc,v.tombstones_record desc,v.untombstones_record desc,
    cs.applied_order desc,v.id desc limit 1;
  if label_version.id is null or label_version.tombstones_record then return null; end if;
  return jsonb_build_object(
    'model_id',requested_model_id,'record_id',requested_record_id,'label',label_version.label,
    'availability',label_version.availability,'retired',label_version.availability='retired',
    'effective_start',to_char(label_version.effective_start,'YYYY-MM-DD'),
    'change_set_id',label_version.change_set_id,'applied_order',label_version.applied_order,
    'schema_revision_id',pinned_schema_revision_id
  );
end;
$kernel_lookup$
"#;

const LOOKUP_LIST: &str = r#"
create or replace function kernel_lookup_list(request jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path from current
as $kernel_lookup$
<<kernel_lookup_list>>
declare
  app_id text := request->>'app_id';
  customer_id text := request->>'customer_id';
  model_id text := request->>'model_id';
  requested_as_of date := coalesce((request->>'as_of')::date,current_date);
  requested_limit integer := least(greatest(coalesce((request->>'limit')::integer,50),1),100);
  include_retired boolean := coalesce((request->>'include_retired')::boolean,false);
  query_value text := kernel_apply_normalize_lookup_label(coalesce(request->>'query',''));
  after_label text := request#>>'{after,normalized_label}';
  after_id uuid := nullif(request#>>'{after,record_id}','')::uuid;
  schema_json jsonb;
  model_json jsonb;
  display_field_id text;
  rows_json jsonb;
  authority_error jsonb;
begin
  if request is null or jsonb_typeof(request)<>'object' or app_id is null or customer_id is null or model_id is null then
    return jsonb_build_object('ok',false,'error',kernel_read_error_envelope('22023','contract_validation_failed: app_id, customer_id, and model_id are required'));
  end if;
  schema_json := kernel_read_scope_schema(app_id,customer_id);
  perform kernel_policy_reject_unsupported_capability(
    app_id, customer_id, 'legacy lookup list'
  );
  select value into model_json from jsonb_array_elements(schema_json->'models') item(value)
  where value->>'id'=model_id and value->>'kind'='lookup'
    and coalesce(value->>'lifecycle','active')='active';
  if model_json is null then
    return jsonb_build_object('ok',false,'error',kernel_read_error_envelope('P0001','record_target_missing: lookup model `' || model_id || '` did not resolve'));
  end if;
  authority_error:=kernel_lookup_storage_authority_error(app_id,customer_id,model_id);
  if authority_error is not null then
    return jsonb_build_object('ok',false,'error',authority_error);
  end if;
  display_field_id := coalesce(model_json->>'display_field_id','name');
  select coalesce(jsonb_agg(row_json order by normalized_label,record_id),'[]'::jsonb) into rows_json
  from (
    select display.record_id,display.normalized_alias normalized_label,
      jsonb_build_object(
        'model_id',kernel_lookup_list.model_id,'record_id',r.id,'external_key',r.external_key,
        'label',coalesce(v.values->display_field_id->>'value',r.id::text),
        'normalized_label',display.normalized_alias,
        'availability',v.availability,'effective_start',to_char(v.effective_start,'YYYY-MM-DD'),
        'effective_end',case when v.effective_end is null then null else to_char(v.effective_end,'YYYY-MM-DD') end,
        'values',kernel_read_lookup_values(model_json,v.values,'[]'::jsonb),
        'custom_fields',kernel_read_custom_fields(schema_json,kernel_lookup_list.model_id,v.custom_fields),
        'metadata',v.metadata,'many_relations',v.many_relations
      ) row_json
    from lookup_alias_projection display
    join lookup_version v
      on v.app_id=display.app_id and v.customer_id=display.customer_id
     and v.model_id=display.model_id and v.id=display.version_id
    join change_set cs
      on cs.id=v.change_set_id and cs.app_id=v.app_id and cs.customer_id=v.customer_id
     and cs.status='mainline' and cs.applied_order is not null
    join lookup_record r
      on r.app_id=v.app_id and r.customer_id=v.customer_id
     and r.model_id=v.model_id and r.id=v.record_id
    where display.app_id=kernel_lookup_list.app_id
      and display.customer_id=kernel_lookup_list.customer_id
      and display.model_id=kernel_lookup_list.model_id and display.kind='display'
      and v.stage='mainline' and v.effective_start<=requested_as_of
      and (v.effective_end is null or v.effective_end>=requested_as_of)
      and not v.tombstones_record and not v.untombstones_record
      and not exists(
        select 1 from lookup_version later
        join change_set later_changes
          on later_changes.id=later.change_set_id and later_changes.app_id=later.app_id
         and later_changes.customer_id=later.customer_id and later_changes.status='mainline'
         and later_changes.applied_order is not null
        where later.app_id=v.app_id and later.customer_id=v.customer_id
          and later.model_id=v.model_id and later.record_id=v.record_id and later.stage='mainline'
          and later.effective_start<=requested_as_of
          and (later.effective_end is null or later.effective_end>=requested_as_of)
          and (later.effective_start,later.tombstones_record,later.untombstones_record,
               later_changes.applied_order,later.id)
              > (v.effective_start,v.tombstones_record,v.untombstones_record,cs.applied_order,v.id)
      )
      and (include_retired or v.availability='active')
      and (query_value is null or exists(
        select 1 from lookup_alias_projection alias
        where alias.app_id=v.app_id and alias.customer_id=v.customer_id
          and alias.model_id=v.model_id and alias.version_id=v.id
          and alias.normalized_alias like query_value || '%'
      ))
      and (after_id is null or (
        display.normalized_alias,display.record_id
      ) > (coalesce(after_label,''),after_id))
    order by display.normalized_alias,display.record_id
    limit requested_limit
  ) listed;
  return jsonb_build_object('ok',true,'data',rows_json);
exception when others then
  return jsonb_build_object('ok',false,'error',kernel_read_error_envelope(sqlstate,sqlerrm));
end;
$kernel_lookup$
"#;

const LOOKUP_RESOLVE_BATCH: &str = r#"
create or replace function kernel_lookup_resolve_batch(request jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path from current
as $kernel_lookup$
<<kernel_lookup_resolve_batch>>
declare
  app_id text := request->>'app_id';
  customer_id text := request->>'customer_id';
  model_id text := request->>'model_id';
  requested_as_of date := coalesce((request->>'as_of')::date,current_date);
  record_ids jsonb := coalesce(request->'record_ids','[]'::jsonb);
  schema_json jsonb;
  model_json jsonb;
  display_field_id text;
  rows_json jsonb;
  authority_error jsonb;
begin
  if jsonb_typeof(record_ids)<>'array' or jsonb_array_length(record_ids)>500 then
    raise exception 'contract_validation_failed: record_ids must be an array of at most 500 IDs';
  end if;
  schema_json := kernel_read_scope_schema(app_id,customer_id);
  perform kernel_policy_reject_unsupported_capability(
    app_id, customer_id, 'legacy lookup batch resolution'
  );
  select value into model_json from jsonb_array_elements(schema_json->'models') item(value)
  where value->>'id'=model_id and value->>'kind'='lookup';
  if model_json is null then raise exception 'record_target_missing: lookup model `%` did not resolve',model_id; end if;
  authority_error:=kernel_lookup_storage_authority_error(app_id,customer_id,model_id);
  if authority_error is not null then
    return jsonb_build_object('ok',false,'error',authority_error);
  end if;
  display_field_id := coalesce(model_json->>'display_field_id','name');
  select coalesce(jsonb_agg(jsonb_build_object(
    'model_id',kernel_lookup_resolve_batch.model_id,'record_id',r.id,'external_key',r.external_key,
    'label',coalesce(v.values->display_field_id->>'value',r.id::text),'availability',v.availability,
    'current_label',(kernel_lookup_label_at(kernel_lookup_resolve_batch.app_id,kernel_lookup_resolve_batch.customer_id,kernel_lookup_resolve_batch.model_id,r.id,current_date,null,null))->>'label',
    'current_availability',(kernel_lookup_label_at(kernel_lookup_resolve_batch.app_id,kernel_lookup_resolve_batch.customer_id,kernel_lookup_resolve_batch.model_id,r.id,current_date,null,null))->>'availability',
    'values',kernel_read_lookup_values(model_json,v.values,'[]'::jsonb),
    'custom_fields',kernel_read_custom_fields(schema_json,kernel_lookup_resolve_batch.model_id,v.custom_fields),
    'metadata',v.metadata,'many_relations',v.many_relations
  ) order by requested.ordinal),'[]'::jsonb) into rows_json
  from jsonb_array_elements_text(record_ids) with ordinality requested(id,ordinal)
  join lookup_record r on r.app_id=kernel_lookup_resolve_batch.app_id
    and r.customer_id=kernel_lookup_resolve_batch.customer_id and r.model_id=kernel_lookup_resolve_batch.model_id
    and r.id=requested.id::uuid
  join lateral (
    select v.* from lookup_version v join change_set cs
      on cs.id=v.change_set_id and cs.app_id=v.app_id and cs.customer_id=v.customer_id
     and cs.status='mainline' and cs.applied_order is not null
    where v.app_id=r.app_id and v.customer_id=r.customer_id and v.model_id=r.model_id and v.record_id=r.id
      and v.stage='mainline' and v.effective_start<=requested_as_of
      and (v.effective_end is null or v.effective_end>=requested_as_of)
    order by v.effective_start desc,v.tombstones_record desc,v.untombstones_record desc,cs.applied_order desc,v.id desc limit 1
  ) v on true
  where not v.tombstones_record and not v.untombstones_record;
  return jsonb_build_object('ok',true,'data',rows_json);
exception when others then
  return jsonb_build_object('ok',false,'error',kernel_read_error_envelope(sqlstate,sqlerrm));
end;
$kernel_lookup$
"#;

const LOOKUP_HYDRATE: &str = r#"
create or replace function kernel_lookup_hydrate(request jsonb)
returns jsonb language plpgsql volatile security invoker set search_path from current
as $kernel_lookup$
declare
  reference jsonb;
  hydrated jsonb := '[]'::jsonb;
  resolved jsonb;
  current_snapshot jsonb;
  event_snapshot jsonb;
  event_change_set_id bigint;
  event_applied_order bigint;
  event_schema_revision_id bigint;
  event_effective_start date;
begin
  if jsonb_typeof(coalesce(request->'references','null'::jsonb))<>'array' or jsonb_array_length(request->'references')>500 then
    raise exception 'contract_validation_failed: references must be an array of at most 500 items';
  end if;
  perform kernel_read_scope_schema(request->>'app_id',request->>'customer_id');
  perform kernel_policy_reject_unsupported_capability(
    request->>'app_id', request->>'customer_id', 'legacy lookup hydration'
  );
  for reference in select value from jsonb_array_elements(request->'references') item(value) loop
    event_change_set_id:=coalesce((reference->>'event_change_set_id')::bigint,(request->>'event_change_set_id')::bigint);
    event_applied_order:=null; event_schema_revision_id:=null;
    if event_change_set_id is not null then
      select applied_order,schema_revision_id into event_applied_order,event_schema_revision_id
      from change_set where id=event_change_set_id and app_id=request->>'app_id' and customer_id=request->>'customer_id';
      if event_schema_revision_id is null then
        raise exception 'record_target_missing: event change_set `%` did not resolve',event_change_set_id;
      end if;
    end if;
    event_effective_start:=coalesce(
      (reference->>'effective_start')::date,(reference->>'as_of')::date,
      (request->>'as_of')::date,current_date
    );
    resolved := kernel_lookup_resolve_batch(jsonb_build_object(
      'app_id',request->>'app_id','customer_id',request->>'customer_id',
      'as_of',coalesce(reference->'as_of',request->'as_of'),
      'model_id',reference->>'model_id','record_ids',jsonb_build_array(reference->>'record_id')
    ));
    if not coalesce((resolved->>'ok')::boolean,false) then return resolved; end if;
    current_snapshot:=kernel_lookup_label_at(
      request->>'app_id',request->>'customer_id',reference->>'model_id',(reference->>'record_id')::uuid,
      current_date,null,null
    );
    event_snapshot:=kernel_lookup_label_at(
      request->>'app_id',request->>'customer_id',reference->>'model_id',(reference->>'record_id')::uuid,
      event_effective_start,event_applied_order,event_schema_revision_id
    );
    hydrated := hydrated || jsonb_build_array(jsonb_build_object(
      'model_id',reference->>'model_id','record_id',reference->>'record_id',
      'resolved',resolved->'data'->0,'current',current_snapshot,'event',event_snapshot
    ));
  end loop;
  return jsonb_build_object('ok',true,'data',hydrated);
exception when others then return jsonb_build_object('ok',false,'error',kernel_read_error_envelope(sqlstate,sqlerrm)); end;
$kernel_lookup$
"#;

const LOOKUP_REFERENCE_COUNT: &str = r#"
create or replace function kernel_lookup_reference_count(request jsonb)
returns jsonb language plpgsql volatile security invoker set search_path from current
as $kernel_lookup$
<<kernel_lookup_reference_count>>
declare app_id text:=request->>'app_id'; customer_id text:=request->>'customer_id';
  model_id text:=request->>'model_id'; record_id uuid:=(request->>'record_id')::uuid;
  requested_as_of date:=coalesce((request->>'as_of')::date,current_date); total bigint;
  schema_json jsonb; source_model jsonb; relation_field jsonb; custom_definition jsonb;
  source_model_id text; source_record_id uuid; version_table text; relation_column text; query_sql text;
  seen jsonb:='{}'::jsonb;
  authority_error jsonb;
begin
  schema_json:=kernel_read_scope_schema(app_id,customer_id);
  perform kernel_policy_reject_unsupported_capability(
    app_id, customer_id, 'lookup reference counts'
  );
  authority_error:=kernel_lookup_storage_authority_error(app_id,customer_id,model_id);
  if authority_error is not null then
    return jsonb_build_object('ok',false,'error',authority_error);
  end if;
  for source_model in
    select value from jsonb_array_elements(schema_json->'models') item(value)
    where value->>'kind'='lookup'
  loop
    authority_error:=kernel_lookup_storage_authority_error(
      app_id,customer_id,source_model->>'id'
    );
    if authority_error is not null then
      return jsonb_build_object('ok',false,'error',authority_error);
    end if;
  end loop;
  if not exists(select 1 from lookup_record r where r.app_id=kernel_lookup_reference_count.app_id
    and r.customer_id=kernel_lookup_reference_count.customer_id and r.model_id=kernel_lookup_reference_count.model_id
    and r.id=kernel_lookup_reference_count.record_id) then
    raise exception 'record_target_missing: lookup record did not resolve';
  end if;
  for source_model_id,source_record_id in
    with visible_versions as (
      select distinct on (v.model_id,v.record_id) v.model_id,v.id,v.record_id,v.tombstones_record,v.untombstones_record
      from lookup_version v join change_set cs
        on cs.id=v.change_set_id and cs.app_id=v.app_id and cs.customer_id=v.customer_id
       and cs.status='mainline' and cs.applied_order is not null
      where v.app_id=kernel_lookup_reference_count.app_id
        and v.customer_id=kernel_lookup_reference_count.customer_id
        and v.stage='mainline' and v.effective_start<=requested_as_of
        and (v.effective_end is null or v.effective_end>=requested_as_of)
      order by v.model_id,v.record_id,v.effective_start desc,v.tombstones_record desc,
        v.untombstones_record desc,cs.applied_order desc,v.id desc
    )
    select distinct edge.source_model_id,edge.source_record_id
    from lookup_relation_projection edge join visible_versions visible
      on visible.model_id=edge.source_model_id and visible.id=edge.version_id
    where edge.app_id=kernel_lookup_reference_count.app_id
      and edge.customer_id=kernel_lookup_reference_count.customer_id
      and edge.target_model_id=kernel_lookup_reference_count.model_id
      and edge.target_record_id=kernel_lookup_reference_count.record_id
      and not visible.tombstones_record and not visible.untombstones_record
  loop
    seen:=seen || jsonb_build_object(source_model_id || ':' || source_record_id,true);
  end loop;

  for source_model in
    select value from jsonb_array_elements(schema_json->'models') item(value)
    where value->>'kind'='entity'
  loop
    source_model_id:=source_model->>'id';
    version_table:=kernel_read_physical_identifier(source_model_id || '_version');
    for relation_field in
      select value from jsonb_array_elements(coalesce(source_model->'fields','[]'::jsonb)) item(value)
      where value->>'type'='relation' and value->>'target_model'=kernel_lookup_reference_count.model_id
    loop
      relation_column:=kernel_read_physical_identifier(relation_field->>'id');
      query_sql:=format(
        $query$
        with visible_versions as (
          select distinct on (version.record_id) version.*
          from %I version join change_set changes
            on changes.id=version.change_set_id and changes.app_id=version.app_id
           and changes.customer_id=version.customer_id and changes.status='mainline'
           and changes.applied_order is not null
          where version.app_id=$1 and version.customer_id=$2 and version.stage='mainline'
            and version.effective_start<=$3 and (version.effective_end is null or version.effective_end>=$3)
          order by version.record_id,version.effective_start desc,version.tombstones_record desc,
            version.untombstones_record desc,changes.applied_order desc,version.id desc
        )
        select version.record_id from visible_versions version
        where not version.tombstones_record and not version.untombstones_record and version.%I=$4
        $query$,
        version_table,relation_column
      );
      for source_record_id in execute query_sql using app_id,customer_id,requested_as_of,record_id loop
        seen:=seen || jsonb_build_object(source_model_id || ':' || source_record_id,true);
      end loop;
    end loop;

    for custom_definition in
      select value from jsonb_array_elements(coalesce(schema_json->'custom_fields','[]'::jsonb)) item(value)
      where value->>'model_id'=source_model_id and value->>'type'='relation'
        and value->>'target_model_id'=kernel_lookup_reference_count.model_id
    loop
      query_sql:=format(
        $query$
        with visible_versions as (
          select distinct on (version.record_id) version.*
          from %I version join change_set changes
            on changes.id=version.change_set_id and changes.app_id=version.app_id
           and changes.customer_id=version.customer_id and changes.status='mainline'
           and changes.applied_order is not null
          where version.app_id=$1 and version.customer_id=$2 and version.stage='mainline'
            and version.effective_start<=$3 and (version.effective_end is null or version.effective_end>=$3)
          order by version.record_id,version.effective_start desc,version.tombstones_record desc,
            version.untombstones_record desc,changes.applied_order desc,version.id desc
        )
        select distinct version.record_id from visible_versions version
        cross join lateral jsonb_array_elements(coalesce(version.custom_fields,'[]'::jsonb)) custom(value)
        where not version.tombstones_record and not version.untombstones_record
          and custom.value->>'field_id'=$4 and custom.value->>'type'='relation'
          and custom.value#>>'{value,value}'=$5
        $query$,
        version_table
      );
      for source_record_id in execute query_sql using app_id,customer_id,requested_as_of,
        custom_definition->>'field_id',record_id::text
      loop
        seen:=seen || jsonb_build_object(source_model_id || ':' || source_record_id,true);
      end loop;
    end loop;
  end loop;
  -- Custom relation values on opted-in lookup models live in lookup_version.
  for source_model_id,source_record_id in
    with visible_versions as (
      select distinct on (v.model_id,v.record_id) v.*
      from lookup_version v join change_set cs
        on cs.id=v.change_set_id and cs.app_id=v.app_id and cs.customer_id=v.customer_id
       and cs.status='mainline' and cs.applied_order is not null
      where v.app_id=kernel_lookup_reference_count.app_id
        and v.customer_id=kernel_lookup_reference_count.customer_id
        and v.stage='mainline' and v.effective_start<=requested_as_of
        and (v.effective_end is null or v.effective_end>=requested_as_of)
      order by v.model_id,v.record_id,v.effective_start desc,v.tombstones_record desc,
        v.untombstones_record desc,cs.applied_order desc,v.id desc
    )
    select distinct version.model_id,version.record_id
    from visible_versions version
    join jsonb_array_elements(coalesce(schema_json->'custom_fields','[]'::jsonb)) definition(value)
      on definition.value->>'model_id'=version.model_id and definition.value->>'type'='relation'
     and definition.value->>'target_model_id'=kernel_lookup_reference_count.model_id
    cross join lateral jsonb_array_elements(coalesce(version.custom_fields,'[]'::jsonb)) custom(value)
    where not version.tombstones_record and not version.untombstones_record
      and custom.value->>'field_id'=definition.value->>'field_id' and custom.value->>'type'='relation'
      and custom.value#>>'{value,value}'=kernel_lookup_reference_count.record_id::text
  loop
    seen:=seen || jsonb_build_object(source_model_id || ':' || source_record_id,true);
  end loop;
  select count(*) into total from jsonb_object_keys(seen);
  return jsonb_build_object('ok',true,'data',jsonb_build_object('count',total));
exception when others then return jsonb_build_object('ok',false,'error',kernel_read_error_envelope(sqlstate,sqlerrm)); end;
$kernel_lookup$
"#;

const LOOKUP_SET_AVAILABILITY: &str = r#"
create or replace function kernel_lookup_set_availability(request jsonb)
returns jsonb language plpgsql volatile security invoker set search_path from current
as $kernel_lookup$
declare
  app_id text;
  customer_id text;
  model_id text;
  record_id uuid;
  availability text;
  effective_start date;
  schema_revision_id bigint;
  actor_id text;
  source_kind text;
  source_ref text;
  idempotency_key text;
  reason text;
  unknown_key text;
  validation_path text;
  validation_code text;
  validation_message text;
  authorization_result jsonb;
  schema_json jsonb;
  model_json jsonb;
  apply_request jsonb;
  authority_error jsonb;
begin
  if jsonb_typeof(request) is distinct from 'object' then
    validation_path := 'request';
    validation_code := 'invalid_request';
    validation_message := 'request must be a JSON object';
  else
    select supplied_key into unknown_key
    from jsonb_object_keys(request) as supplied_key
    where supplied_key not in (
      'app_id','customer_id','model_id','record_id','availability','effective_start',
      'schema_revision_id','actor_id','source_kind','source_ref','idempotency_key','reason'
    )
    order by supplied_key
    limit 1;
    if unknown_key is not null then
      validation_path := unknown_key;
      validation_code := 'unknown_field';
      validation_message := 'request contains a field outside the lookup availability contract';
    elsif jsonb_typeof(request->'app_id') is distinct from 'string'
      or jsonb_typeof(request->'customer_id') is distinct from 'string'
      or jsonb_typeof(request->'model_id') is distinct from 'string'
      or jsonb_typeof(request->'record_id') is distinct from 'string'
      or jsonb_typeof(request->'availability') is distinct from 'string'
      or jsonb_typeof(request->'effective_start') is distinct from 'string'
      or jsonb_typeof(request->'actor_id') is distinct from 'string'
      or jsonb_typeof(request->'idempotency_key') is distinct from 'string'
      or jsonb_typeof(request->'reason') is distinct from 'string'
      or (request ? 'source_kind' and request->'source_kind' <> 'null'::jsonb
        and jsonb_typeof(request->'source_kind') is distinct from 'string')
      or (request ? 'source_ref' and request->'source_ref' <> 'null'::jsonb
        and jsonb_typeof(request->'source_ref') is distinct from 'string')
    then
      validation_path := 'request';
      validation_code := 'invalid_field_type';
      validation_message := 'lookup availability request fields have invalid JSON types';
    elsif coalesce(btrim(request->>'app_id'), '') = ''
      or coalesce(btrim(request->>'customer_id'), '') = ''
      or coalesce(btrim(request->>'model_id'), '') = ''
      or coalesce(btrim(request->>'actor_id'), '') = ''
      or coalesce(btrim(request->>'idempotency_key'), '') = ''
      or coalesce(btrim(request->>'reason'), '') = ''
    then
      validation_path := 'request';
      validation_code := 'required';
      validation_message := 'scope, record, actor, idempotency key, and reason are required';
    elsif request->>'availability' not in ('active','retired') then
      validation_path := 'availability';
      validation_code := 'invalid_lifecycle';
      validation_message := 'availability must be active or retired';
    elsif request->>'effective_start' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      validation_path := 'effective_start';
      validation_code := 'invalid_date';
      validation_message := 'effective_start must use YYYY-MM-DD';
    elsif request ? 'schema_revision_id' and request->'schema_revision_id' <> 'null'::jsonb
      and (
        jsonb_typeof(request->'schema_revision_id') is distinct from 'number'
        or request->>'schema_revision_id' !~ '^[1-9][0-9]*$'
        or (request->>'schema_revision_id')::numeric > 9223372036854775807
      )
    then
      validation_path := 'schema_revision_id';
      validation_code := 'invalid_schema_revision_id';
      validation_message := 'schema_revision_id must be a positive integer when supplied';
    end if;
  end if;
  if validation_code is not null then
    return jsonb_build_object(
      'ok',false,
      'error',jsonb_build_object(
        'code','contract_validation_failed',
        'message','Contract validation failed',
        'details',jsonb_build_array(jsonb_build_object(
          'path',validation_path,'code',validation_code,'message',validation_message
        ))
      )
    );
  end if;

  app_id := request->>'app_id';
  customer_id := request->>'customer_id';
  perform kernel_policy_reject_unsupported_capability(
    app_id, customer_id, 'lookup availability lifecycle'
  );
  model_id := request->>'model_id';
  availability := request->>'availability';
  actor_id := request->>'actor_id';
  source_kind := coalesce(request->>'source_kind','lookup_admin');
  source_ref := request->>'source_ref';
  idempotency_key := request->>'idempotency_key';
  reason := request->>'reason';
  begin
    record_id := (request->>'record_id')::uuid;
  exception when invalid_text_representation then
    return jsonb_build_object('ok',false,'error',jsonb_build_object(
      'code','contract_validation_failed','message','Contract validation failed',
      'details',jsonb_build_array(jsonb_build_object(
        'path','record_id','code','invalid_record_id','message','record_id must be a UUID'
      ))
    ));
  end;
  begin
    effective_start := (request->>'effective_start')::date;
  exception when datetime_field_overflow or invalid_datetime_format then
    return jsonb_build_object('ok',false,'error',jsonb_build_object(
      'code','contract_validation_failed','message','Contract validation failed',
      'details',jsonb_build_array(jsonb_build_object(
        'path','effective_start','code','invalid_date','message','effective_start must be a valid date'
      ))
    ));
  end;
  if request ? 'schema_revision_id' and request->'schema_revision_id' <> 'null'::jsonb then
    schema_revision_id := (request->>'schema_revision_id')::bigint;
  end if;

  authorization_result := kernel_authorize_scope('runtime', app_id, customer_id, null);
  if authorization_result is not null then
    return authorization_result;
  end if;
  perform set_config('kernel.app_id', app_id, true);
  perform set_config('kernel.customer_id', customer_id, true);
  schema_json := kernel_read_scope_schema(app_id, customer_id);
  select value into model_json
  from jsonb_array_elements(schema_json->'models') item(value)
  where value->>'id' = model_id
    and value->>'kind' = 'lookup'
    and coalesce(value->>'lifecycle','active') = 'active';
  if model_json is null then
    return jsonb_build_object('ok',false,'error',kernel_read_error_envelope(
      'P0001','record_target_missing: lookup model `' || model_id || '` did not resolve'
    ));
  end if;
  authority_error:=kernel_lookup_storage_authority_error(
    app_id,customer_id,model_id
  );
  if authority_error is not null then
    return jsonb_build_object('ok',false,'error',authority_error);
  end if;
  apply_request := jsonb_build_object(
    'app_id',app_id,'customer_id',customer_id,
    'schema_revision_id',schema_revision_id,'actor_id',actor_id,
    'source_kind',source_kind,'source_ref',source_ref,
    'idempotency_key',idempotency_key,'notes',reason,'mode','mainline',
    'writes',jsonb_build_array(jsonb_build_object(
      'model_id',model_id,'record_key',jsonb_build_object('type','record_id','value',record_id),
      'effective_start',effective_start,'values',jsonb_build_object(
        '__lookup_lifecycle',jsonb_build_object('type','schema_lifecycle','value',availability)
      )
    ))
  );
  return kernel_apply_change_set(apply_request);
exception when others then return jsonb_build_object('ok',false,'error',kernel_read_error_envelope(sqlstate,sqlerrm)); end;
$kernel_lookup$
"#;

const LOOKUP_TRANSFER_ERROR: &str = r#"
create or replace function kernel_lookup_transfer_error(
  error_code text,
  error_message text,
  detail_path text,
  detail_message text
)
returns jsonb
language sql
immutable
parallel safe
security invoker
set search_path from current
as $kernel_lookup$
  select jsonb_build_object(
    'ok',false,
    'error',jsonb_build_object(
      'code',error_code,'message',error_message,
      'details',jsonb_build_array(jsonb_build_object(
        'path',detail_path,'code',error_code,'message',detail_message
      ))
    )
  )
$kernel_lookup$;
"#;

const LOOKUP_TRANSFER_ALIAS: &str = r#"
create or replace function kernel_lookup_transfer_alias(request jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path from current
as $kernel_lookup_transfer$
<<kernel_lookup_transfer_alias>>
declare
  app_id text := request->>'app_id';
  customer_id text := request->>'customer_id';
  model_id text := request->>'model_id';
  source_record_id uuid;
  target_record_id uuid;
  expected_source_version_id uuid;
  expected_target_version_id uuid;
  effective_start date;
  supplied_revision_id bigint;
  active_revision_id bigint;
  schema_json jsonb;
  model_json jsonb;
  requested_normalized_alias text;
  authority_error jsonb;
  transfer_identity text;
  existing record;
  locked_record_id uuid;
  locked_record_count integer := 0;
  source_version jsonb;
  target_version jsonb;
  field_json jsonb;
  alias_field_id text;
  alias_field_count integer := 0;
  source_alias text;
  source_aliases jsonb;
  target_aliases jsonb;
  reservation_owner uuid;
  apply_request jsonb;
  transfer_descriptor jsonb;
  apply_result jsonb;
begin
  if request is null or jsonb_typeof(request)<>'object' then
    return kernel_lookup_transfer_error(
      'contract_validation_failed','Contract validation failed','request',
      'lookup alias transfer request must be an object'
    );
  end if;
  if request-array[
    'app_id','customer_id','model_id','source_record_id','target_record_id','alias',
    'effective_start','expected_source_version_id','expected_target_version_id',
    'schema_revision_id','actor_id','idempotency_key','reason'
  ]<>'{}'::jsonb then
    return kernel_lookup_transfer_error(
      'contract_validation_failed','Contract validation failed','request',
      case when exists(
        select 1 from jsonb_object_keys(request) key where key like '\_\_kernel\_%' escape '\'
      ) then 'reserved_internal_apply_field: caller-supplied __kernel_ fields are forbidden'
      else 'lookup alias transfer request contains unknown fields' end
    );
  end if;
  if not request ?& array[
    'app_id','customer_id','model_id','source_record_id','target_record_id','alias',
    'effective_start','expected_source_version_id','expected_target_version_id',
    'schema_revision_id','actor_id','idempotency_key','reason'
  ] or exists(
    select 1
    from jsonb_each(request) entry(key,value)
    where key=any(array[
      'app_id','customer_id','model_id','source_record_id','target_record_id','alias',
      'effective_start','expected_source_version_id','expected_target_version_id',
      'schema_revision_id','actor_id','idempotency_key','reason'
    ]) and (value='null'::jsonb or btrim(value#>>'{}')='')
  ) then
    return kernel_lookup_transfer_error(
      'contract_validation_failed','Contract validation failed','request',
      'all lookup alias transfer fields are required and must not be null or blank'
    );
  end if;
  if btrim(coalesce(app_id,''))='' or btrim(coalesce(customer_id,''))=''
    or btrim(coalesce(model_id,''))='' or btrim(coalesce(request->>'alias',''))=''
    or btrim(coalesce(request->>'actor_id',''))=''
    or btrim(coalesce(request->>'idempotency_key',''))=''
    or btrim(coalesce(request->>'reason',''))=''
  then
    return kernel_lookup_transfer_error(
      'contract_validation_failed','Contract validation failed','request',
      'app, customer, model, alias, actor, idempotency key, and reason are required'
    );
  end if;
  begin
    source_record_id:=(request->>'source_record_id')::uuid;
    target_record_id:=(request->>'target_record_id')::uuid;
    expected_source_version_id:=(request->>'expected_source_version_id')::uuid;
    expected_target_version_id:=(request->>'expected_target_version_id')::uuid;
    effective_start:=(request->>'effective_start')::date;
    if request ? 'schema_revision_id' and request->'schema_revision_id'<>'null'::jsonb then
      supplied_revision_id:=(request->>'schema_revision_id')::bigint;
    end if;
  exception when others then
    return kernel_lookup_transfer_error(
      'contract_validation_failed','Contract validation failed','request',
      'record IDs, expected version IDs, effective_start, or schema_revision_id are invalid'
    );
  end;
  if supplied_revision_id<=0 then
    return kernel_lookup_transfer_error(
      'contract_validation_failed','Contract validation failed','schema_revision_id',
      'schema_revision_id must be positive'
    );
  end if;
  if source_record_id=target_record_id then
    return kernel_lookup_transfer_error(
      'lookup_alias_transfer_same_record','Lookup alias transfer is invalid','target_record_id',
      'source and target records must be distinct'
    );
  end if;
  if not kernel_principal_scope_authorized('runtime', app_id, customer_id, null) then
    return kernel_authorize_scope('runtime', app_id, customer_id, null);
  end if;
  perform kernel_policy_reject_unsupported_capability(
    app_id, customer_id, 'lookup alias transfer lifecycle'
  );

  perform set_config('kernel.app_id',app_id,true);
  perform set_config('kernel.customer_id',customer_id,true);
  transfer_identity:='lookup-alias-transfer:' || kernel_canonical_json(request);
  perform pg_advisory_xact_lock(hashtext(
    'idempotency:' || app_id || ':' || customer_id || ':' || (request->>'idempotency_key')
  )::bigint);
  select id,schema_revision_id,source_kind,source_ref into existing
  from change_set
  where change_set.app_id=kernel_lookup_transfer_alias.app_id
    and change_set.customer_id=kernel_lookup_transfer_alias.customer_id
    and idempotency_key=request->>'idempotency_key';
  if found then
    if existing.source_kind='lookup_alias_transfer'
      and existing.source_ref=transfer_identity
    then
      return jsonb_build_object('ok',true,'data',jsonb_build_object(
        'id',existing.id,'schema_revision_id',existing.schema_revision_id
      ));
    end if;
    return kernel_lookup_transfer_error(
      'idempotency_conflict','Idempotency key was reused for a different request',
      'idempotency_key','use a new idempotency key or replay the exact transfer request'
    );
  end if;

  if effective_start<>current_date then
    return kernel_lookup_transfer_error(
      'lookup_alias_transfer_effective_date_conflict','Lookup alias transfer date is invalid',
      'effective_start','alias transfers must take effect on the current database date'
    );
  end if;
  requested_normalized_alias:=kernel_apply_normalize_lookup_label(request->>'alias');
  if requested_normalized_alias is null then
    return kernel_lookup_transfer_error(
      'contract_validation_failed','Contract validation failed','alias',
      'lookup alias must not normalize to an empty value'
    );
  end if;

  perform pg_advisory_xact_lock_shared(hashtext(
    'postgres-schema:' || current_schema() || ':materialize-tenant:' ||
    app_id || ':' || customer_id || ':schema-activation'
  )::bigint);
  select revision.id,revision.schema into active_revision_id,schema_json
  from schema_revision revision
  where revision.app_id=kernel_lookup_transfer_alias.app_id
    and revision.customer_id=kernel_lookup_transfer_alias.customer_id
    and revision.activated_at is not null;
  if active_revision_id is null then
    return kernel_lookup_transfer_error(
      'active_schema_missing','No active schema revision exists for this scope','scope',
      app_id || '/' || customer_id || ': materialize a schema before transferring aliases'
    );
  end if;
  if supplied_revision_id is not null and supplied_revision_id<>active_revision_id then
    return kernel_lookup_transfer_error(
      'stale_schema_revision','The supplied schema revision is not active','schema_revision_id',
      'alias transfer must be retried against the active schema revision'
    );
  end if;
  select value into model_json
  from jsonb_array_elements(coalesce(schema_json->'models','[]'::jsonb)) item(value)
  where value->>'id'=model_id and value->>'kind'='lookup';
  if model_json is null then
    return kernel_lookup_transfer_error(
      'record_target_missing','Lookup model did not resolve','model_id',
      'lookup model `' || model_id || '` is not active in this scope'
    );
  end if;
  if coalesce(model_json->>'lifecycle','active')<>'active' then
    return kernel_lookup_transfer_error(
      'retired_relation_target_model','Lookup model is retired','model_id',
      'aliases cannot be transferred on a retired lookup model'
    );
  end if;
  authority_error:=kernel_lookup_storage_authority_error(app_id,customer_id,model_id);
  if authority_error is not null then
    return jsonb_build_object('ok',false,'error',authority_error);
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'lookup-normalized:' || current_schema() || ':' || app_id || ':' ||
    customer_id || ':' || model_id || ':' || requested_normalized_alias,0
  ));
  for locked_record_id in
    select record.id from lookup_record record
    where record.app_id=kernel_lookup_transfer_alias.app_id
      and record.customer_id=kernel_lookup_transfer_alias.customer_id
      and record.model_id=kernel_lookup_transfer_alias.model_id
      and record.id in (source_record_id,target_record_id)
    order by record.id
    for update
  loop
    locked_record_count:=locked_record_count+1;
  end loop;
  if locked_record_count<>2 then
    if not exists(
      select 1 from lookup_record record
      where record.app_id=kernel_lookup_transfer_alias.app_id
        and record.customer_id=kernel_lookup_transfer_alias.customer_id
        and record.model_id=kernel_lookup_transfer_alias.model_id
        and record.id=source_record_id
    ) then
      return kernel_lookup_transfer_error(
        'lookup_alias_transfer_source_missing','Lookup alias source did not resolve',
        'source_record_id','source record is missing from the requested app, customer, or model'
      );
    end if;
    return kernel_lookup_transfer_error(
      'lookup_alias_transfer_target_missing','Lookup alias target did not resolve',
      'target_record_id','target record is missing from the requested app, customer, or model'
    );
  end if;
  if exists(
    select 1 from lookup_version version join change_set changes
      on changes.id=version.change_set_id and changes.app_id=version.app_id
     and changes.customer_id=version.customer_id
    where version.app_id=kernel_lookup_transfer_alias.app_id
      and version.customer_id=kernel_lookup_transfer_alias.customer_id
      and version.model_id=kernel_lookup_transfer_alias.model_id
      and version.record_id in (source_record_id,target_record_id)
      and version.stage='mainline' and changes.status='mainline'
      and changes.applied_order is not null and version.effective_start>current_date
  ) then
    return kernel_lookup_transfer_error(
      'lookup_alias_transfer_timeline_conflict','Lookup alias transfer timeline is stale',
      'effective_start','source or target has a future-effective version; resolve that timeline first'
    );
  end if;

  select to_jsonb(version) into source_version
  from lookup_version version join change_set changes
    on changes.id=version.change_set_id and changes.app_id=version.app_id
   and changes.customer_id=version.customer_id
  where version.app_id=kernel_lookup_transfer_alias.app_id
    and version.customer_id=kernel_lookup_transfer_alias.customer_id
    and version.model_id=kernel_lookup_transfer_alias.model_id
    and version.record_id=source_record_id and version.stage='mainline'
    and changes.status='mainline' and changes.applied_order is not null
    and version.effective_start<=current_date
    and (version.effective_end is null or version.effective_end>=current_date)
  order by version.effective_start desc,version.tombstones_record desc,
    version.untombstones_record desc,changes.applied_order desc,version.id desc limit 1;
  select to_jsonb(version) into target_version
  from lookup_version version join change_set changes
    on changes.id=version.change_set_id and changes.app_id=version.app_id
   and changes.customer_id=version.customer_id
  where version.app_id=kernel_lookup_transfer_alias.app_id
    and version.customer_id=kernel_lookup_transfer_alias.customer_id
    and version.model_id=kernel_lookup_transfer_alias.model_id
    and version.record_id=target_record_id and version.stage='mainline'
    and changes.status='mainline' and changes.applied_order is not null
    and version.effective_start<=current_date
    and (version.effective_end is null or version.effective_end>=current_date)
  order by version.effective_start desc,version.tombstones_record desc,
    version.untombstones_record desc,changes.applied_order desc,version.id desc limit 1;
  if source_version is null or coalesce((source_version->>'tombstones_record')::boolean,false)
    or coalesce(source_version->>'availability','active')<>'active'
  then
    return kernel_lookup_transfer_error(
      'lookup_alias_transfer_source_inactive','Lookup alias source is not active',
      'source_record_id','source must have an active visible lookup version today'
    );
  end if;
  if target_version is null or coalesce((target_version->>'tombstones_record')::boolean,false)
    or coalesce(target_version->>'availability','active')<>'active'
  then
    return kernel_lookup_transfer_error(
      'lookup_alias_transfer_target_inactive','Lookup alias target is not active',
      'target_record_id','target must have an active visible lookup version today'
    );
  end if;
  if (source_version->>'id')::uuid<>expected_source_version_id then
    return kernel_lookup_transfer_error(
      'lookup_alias_transfer_stale_source','Lookup alias source changed',
      'expected_source_version_id','reload the source record and retry the transfer'
    );
  end if;
  if (target_version->>'id')::uuid<>expected_target_version_id then
    return kernel_lookup_transfer_error(
      'lookup_alias_transfer_stale_target','Lookup alias target changed',
      'expected_target_version_id','reload the target record and retry the transfer'
    );
  end if;
  if exists(
    select 1 from lookup_alias_projection projection
    join lookup_version version
      on version.app_id=projection.app_id and version.customer_id=projection.customer_id
     and version.model_id=projection.model_id and version.id=projection.version_id
    join change_set changes
      on changes.id=version.change_set_id and changes.app_id=version.app_id
     and changes.customer_id=version.customer_id
    where projection.app_id=kernel_lookup_transfer_alias.app_id
      and projection.customer_id=kernel_lookup_transfer_alias.customer_id
      and projection.model_id=kernel_lookup_transfer_alias.model_id
      and projection.normalized_alias=requested_normalized_alias and projection.kind='display'
      and version.stage in ('mainline','reverted') and changes.status='mainline'
  ) then
    return kernel_lookup_transfer_error(
      'lookup_alias_transfer_canonical_forbidden','Canonical lookup labels cannot be transferred',
      'alias','the normalized value has been used as a canonical display label'
    );
  end if;

  for field_json in
    select value from jsonb_array_elements(coalesce(model_json->'fields','[]'::jsonb)) item(value)
    where value->>'type'='known_aliases'
    order by value->>'id'
  loop
    if exists(
      select 1 from jsonb_array_elements_text(
        coalesce(source_version#>array['values',field_json->>'id','value'],'[]'::jsonb)
      ) alias(value)
      where kernel_apply_normalize_lookup_label(value)=requested_normalized_alias
    ) then
      alias_field_count:=alias_field_count+1;
      alias_field_id:=field_json->>'id';
      select value into source_alias
      from jsonb_array_elements_text(
        source_version#>array['values',alias_field_id,'value']
      ) alias(value)
      where kernel_apply_normalize_lookup_label(value)=requested_normalized_alias
      order by value limit 1;
    end if;
  end loop;
  if alias_field_count=0 then
    return kernel_lookup_transfer_error(
      'lookup_alias_transfer_not_owned','Lookup alias is not owned by the source',
      'alias','the source current version does not contain this known_aliases value'
    );
  elsif alias_field_count<>1 then
    return kernel_lookup_transfer_error(
      'lookup_alias_transfer_ambiguous_field','Lookup alias field is ambiguous',
      'alias','the normalized alias appears in more than one known_aliases field'
    );
  end if;

  select projection.record_id into reservation_owner
  from lookup_alias_projection projection
  join lookup_version version
    on version.app_id=projection.app_id and version.customer_id=projection.customer_id
   and version.model_id=projection.model_id and version.id=projection.version_id
  join change_set changes
    on changes.id=version.change_set_id and changes.app_id=version.app_id
   and changes.customer_id=version.customer_id
  where projection.app_id=kernel_lookup_transfer_alias.app_id
    and projection.customer_id=kernel_lookup_transfer_alias.customer_id
    and projection.model_id=kernel_lookup_transfer_alias.model_id
    and projection.normalized_alias=requested_normalized_alias
    and version.stage='mainline' and changes.status='mainline'
    and changes.applied_order is not null
  order by changes.applied_order desc,version.effective_start desc,version.id desc,
    projection.kind,projection.ordinal limit 1;
  if reservation_owner is distinct from source_record_id then
    return kernel_lookup_transfer_error(
      'lookup_alias_transfer_not_owned','Lookup alias reservation is not owned by the source',
      'alias','historical reservation ownership changed; reload and retry'
    );
  end if;
  if exists(
    select 1 from lookup_alias_projection projection
    where projection.app_id=kernel_lookup_transfer_alias.app_id
      and projection.customer_id=kernel_lookup_transfer_alias.customer_id
      and projection.model_id=kernel_lookup_transfer_alias.model_id
      and projection.normalized_alias=requested_normalized_alias and projection.is_current
      and projection.record_id<>source_record_id
  ) then
    return kernel_lookup_transfer_error(
      'lookup_alias_collision','Lookup alias collision','alias',
      'the normalized alias is active on a record other than the source'
    );
  end if;

  select coalesce(jsonb_agg(value order by ordinal),'[]'::jsonb) into source_aliases
  from jsonb_array_elements_text(
    source_version#>array['values',alias_field_id,'value']
  ) with ordinality alias(value,ordinal)
  where kernel_apply_normalize_lookup_label(value)<>requested_normalized_alias;
  target_aliases:=coalesce(
    target_version#>array['values',alias_field_id,'value'],'[]'::jsonb
  );
  if exists(
    select 1 from jsonb_array_elements_text(target_aliases) alias(value)
    where kernel_apply_normalize_lookup_label(value)=requested_normalized_alias
  ) then
    return kernel_lookup_transfer_error(
      'lookup_alias_collision','Lookup alias collision','target_record_id',
      'target already contains the normalized alias'
    );
  end if;
  target_aliases:=target_aliases || to_jsonb(source_alias);

  apply_request:=jsonb_build_object(
    'app_id',app_id,'customer_id',customer_id,'schema_revision_id',active_revision_id,
    'actor_id',request->'actor_id','source_kind','lookup_alias_transfer',
    'source_ref',transfer_identity,'idempotency_key',request->'idempotency_key',
    'notes',request->'reason','mode','mainline','writes',jsonb_build_array(
      jsonb_build_object(
        'model_id',model_id,
        'record_key',jsonb_build_object('type','record_id','value',source_record_id),
        'effective_start',to_char(effective_start,'YYYY-MM-DD'),
        'values',jsonb_build_object(alias_field_id,jsonb_build_object(
          'type','text_list','value',source_aliases
        ))
      ),
      jsonb_build_object(
        'model_id',model_id,
        'record_key',jsonb_build_object('type','record_id','value',target_record_id),
        'effective_start',to_char(effective_start,'YYYY-MM-DD'),
        'values',jsonb_build_object(alias_field_id,jsonb_build_object(
          'type','text_list','value',target_aliases
        ))
      )
    )
  );
  transfer_descriptor:=jsonb_build_object(
    'app_id',app_id,'customer_id',customer_id,'model_id',model_id,
    'source_record_id',source_record_id,'target_record_id',target_record_id,
    'field_id',alias_field_id,'normalized_alias',requested_normalized_alias
  );
  apply_result:=kernel_apply_execute_internal(apply_request,false,null,transfer_descriptor,false);
  return jsonb_build_object('ok',true,'data',apply_result);
exception when others then
  return jsonb_build_object(
    'ok',false,
    'error',kernel_apply_error_envelope(sqlstate,sqlerrm,null,coalesce(apply_request,request))
  );
end;
$kernel_lookup_transfer$;
"#;
