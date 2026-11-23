-- Generic transactional source-identity resolution. This function only locks and
-- resolves an ordinary apply request. The caller must keep the same transaction
-- through kernel_apply_change_set; resolution never persists records or receipts.
create or replace function kernel_resolve_source_identities(request jsonb)
returns jsonb language plpgsql volatile security invoker set search_path from current
as $kernel$
declare
  app text := request->>'app_id'; customer text := request->>'customer_id';
  active_schema jsonb; policy_snapshot jsonb; model jsonb; write jsonb;
  normalized jsonb := '[]'::jsonb; resolved jsonb := '[]'::jsonb;
  source_ref text; table_name text; target_ids uuid[]; target uuid; version_json jsonb;
  input_hash text; old_request jsonb; receipt_id bigint; receipt_revision bigint; receipt_status text; receipt_applied timestamptz;
  replay_only boolean := request->'replay_only'='true'::jsonb; apply_request jsonb; relation_entry record;
  relation_field jsonb; relation_model jsonb; relation_target uuid; relation_ids uuid[];
  mapped_field text; field jsonb; clear_policy text; custom_value jsonb;
  lock_model text; lock_refs text[]; locked_count bigint;
  source_actor_bound boolean := false;
  same_day_count integer := 0; same_day_id bigint; same_day_revision bigint; same_day_request jsonb;
  state text; caught_message text; caught_constraint text; caught_table text;
begin
  if app is null or customer is null
    or not kernel_principal_scope_authorized('runtime', app, customer, null)
    or request->>'actor_id' is distinct from nullif(current_setting('kernel.actor_id', true), '')
    or nullif(btrim(request->>'source_kind'),'') is null
    or request->>'mode' is distinct from 'mainline'
  then perform kernel_apply_fail('authorization_denied', 'Source identity scope is not authorized'); end if;
  perform set_config('kernel.app_id',app,true);
  perform set_config('kernel.customer_id',customer,true);
  -- Service provenance is provisioned by schema-admin, never asserted by the
  -- request source_kind. Hold its membership lock through write or replay.
  select true into source_actor_bound from kernel_actor_membership membership
    where membership.principal_name=session_user::name
      and membership.app_id=app and membership.customer_id=customer
      and membership.actor_id=request->>'actor_id' and membership.active
      and membership.actor_kind='service'
      and (nullif(current_setting('kernel.actor_role',true),'') is null or membership.role=current_setting('kernel.actor_role',true))
      and (nullif(current_setting('kernel.actor_fence_generation',true),'') is null or membership.fence_generation::text=current_setting('kernel.actor_fence_generation',true))
    order by membership.role limit 1 for share;
  if not coalesce(source_actor_bound,false) then perform kernel_apply_fail('authorization_denied','Source service identity is not authorized'); end if;
  -- An application may hold its own transaction-scoped lock while checking a
  -- maintenance receipt that fences a source installation. The caller owns
  -- the lock protocol and keeps this transaction open through the write.
  if request ? 'maintenance_fence' then
    if jsonb_typeof(request->'maintenance_fence') <> 'object'
      or nullif(request->'maintenance_fence'->>'source_kind','') is null
      or nullif(request->'maintenance_fence'->>'source_ref_prefix','') is null
      or length(request->'maintenance_fence'->>'source_ref_prefix') > 512
    then perform kernel_apply_fail('contract_validation_failed','Invalid source maintenance fence'); end if;
    if exists (select 1 from change_set cs where cs.app_id=app and cs.customer_id=customer
      and cs.source_kind=request->'maintenance_fence'->>'source_kind'
      and left(cs.source_ref,length(request->'maintenance_fence'->>'source_ref_prefix'))=request->'maintenance_fence'->>'source_ref_prefix'
      and cs.status='mainline' and cs.applied_at is not null)
    then perform kernel_apply_fail('source_fenced','Source installation has completed maintenance'); end if;
  end if;
  if nullif(request->>'idempotency_key','') is null
    or nullif(request->>'source_ref','') is null
    or octet_length(request::text) > 1048576
    or (request ? 'replay_only' and jsonb_typeof(request->'replay_only')<>'boolean')
    or (request ? 'source_input_hash' and coalesce(request->>'source_input_hash','') !~ '^[a-f0-9]{64}$')
    or (request ? 'same_day_receipt' and jsonb_typeof(request->'same_day_receipt') <> 'boolean')
  then perform kernel_apply_fail('contract_validation_failed', 'Invalid source identity envelope'); end if;
  policy_snapshot := kernel_policy_active_snapshot(app, customer);
  if not pg_try_advisory_xact_lock_shared(hashtext('postgres-schema:' || current_schema() || ':materialize-tenant:' || app || ':' || customer || ':schema-activation')::bigint) then raise exception using errcode='40001', message='source identity schema activation changed'; end if;
  policy_snapshot := kernel_policy_active_snapshot(app, customer);
  select schema into active_schema from schema_revision sr where sr.app_id=app and sr.customer_id=customer and sr.activated_at is not null;
  if coalesce((policy_snapshot->>'declared')::boolean,false) then perform kernel_policy_request_actor(app,customer); end if;
  perform pg_advisory_xact_lock(hashtext('idempotency:' || app || ':' || customer || ':' || (request->>'idempotency_key'))::bigint);
  select id, request_fingerprint::jsonb, schema_revision_id, status, applied_at
    into receipt_id, old_request, receipt_revision, receipt_status, receipt_applied from change_set cs
    where cs.app_id=app and cs.customer_id=customer and cs.idempotency_key=request->>'idempotency_key';
  if replay_only then
    if request ? 'writes' or coalesce(request->>'source_input_hash','') !~ '^[a-f0-9]{64}$'
    then perform kernel_apply_fail('contract_validation_failed','Invalid source replay lookup'); end if;
    if old_request is null then return jsonb_build_object('ok',true,'data',null); end if;
    -- Old native ingestion stored canonical writes but no input hash. Permit
    -- a receipt-only replay when the caller supplies the complete delivery,
    -- every source identity and payload match exactly, and the active service
    -- actor is authorized under current policy. No old actor or raw receipt
    -- request is returned for execution under the new principal.
    if request ? 'legacy_writes' and jsonb_typeof(request->'legacy_writes')='array'
      and jsonb_typeof(old_request->'writes')='array'
      and not exists(select 1 from jsonb_array_elements(old_request->'writes') w where w->'provenance' ? 'source_input_hash')
    then
      if receipt_status <> 'mainline' or receipt_applied is null
        or old_request->>'source_kind' is distinct from request->>'source_kind'
        or old_request->>'source_ref' is distinct from request->>'source_ref'
        or jsonb_array_length(request->'legacy_writes') not between 1 and 100
        or jsonb_array_length(request->'legacy_writes') <> jsonb_array_length(old_request->'writes')
        or exists (
          select 1 from jsonb_array_elements(request->'legacy_writes') incoming
          where (select count(*) from jsonb_array_elements(old_request->'writes') prior
            where prior->>'model_id'=incoming->>'model_id'
              and prior->>'effective_start'=incoming->>'effective_start'
              and nullif(incoming->'provenance'->>'source_record_ref','') is not null
              and prior->'provenance'->>'source_record_ref'=incoming->'provenance'->>'source_record_ref'
              and nullif(incoming->'provenance'->>'payload_hash','') is not null
              and prior->'provenance'->>'payload_hash'=incoming->'provenance'->>'payload_hash'
              and coalesce(prior->'values','{}'::jsonb) @> coalesce(incoming->'values','{}'::jsonb)
              and coalesce(prior->'provenance','{}'::jsonb) @> coalesce(incoming->'provenance','{}'::jsonb)
              and (prior - 'record_key' - 'new_record_id' - 'expected_version_id' - 'values' - 'provenance')
                = (incoming - 'record_key' - 'new_record_id' - 'expected_version_id' - 'values' - 'provenance')
          ) <> 1
        )
        or exists (select 1 from jsonb_array_elements(request->'legacy_writes') a
          group by a->>'model_id', a->'provenance'->>'source_record_ref' having count(*) > 1)
      then perform kernel_apply_fail('idempotency_conflict','Source delivery conflicts with its prior content'); end if;
      if coalesce((policy_snapshot->>'declared')::boolean,false) then
        perform kernel_apply_authorize_replay(receipt_id,app,customer,old_request,policy_snapshot->'policy',active_schema);
      end if;
      return jsonb_build_object('ok',true,'data',jsonb_build_object('legacy_receipt',jsonb_build_object('id',receipt_id,'schema_revision_id',receipt_revision)));
    end if;
    if old_request->>'actor_id' is distinct from request->>'actor_id'
      or old_request->>'source_kind' is distinct from request->>'source_kind'
      or old_request->>'source_ref' is distinct from request->>'source_ref'
      or exists(select 1 from jsonb_array_elements(old_request->'writes') w where w->'provenance'->>'source_input_hash' is distinct from request->>'source_input_hash')
    then perform kernel_apply_fail('idempotency_conflict','Source delivery conflicts with its prior content'); end if;
    if coalesce((policy_snapshot->>'declared')::boolean,false) then
      perform kernel_apply_authorize_replay(receipt_id,app,customer,old_request,policy_snapshot->'policy',active_schema);
    end if;
    return jsonb_build_object('ok',true,'data',old_request);
  end if;
  if jsonb_typeof(request->'writes') is distinct from 'array'
    or jsonb_array_length(request->'writes') not between 1 and 100
  then perform kernel_apply_fail('contract_validation_failed','Invalid source identity writes'); end if;
  for write in select value from jsonb_array_elements(request->'writes') loop
    source_ref := write->'provenance'->>'source_record_ref';
    if write ? 'record_key' or write ? 'expected_version_id'
      or nullif(source_ref,'') is null or length(source_ref)>256
      or coalesce(write->'provenance'->>'payload_hash','') !~ '^[a-f0-9]{64}$'
      or jsonb_typeof(write->'provenance'->'mapped_field_ids') is distinct from 'array'
      or coalesce(write->'provenance'->>'match_policy','') not in ('create_only','source_reference')
      or coalesce(write->'provenance'->>'clear_policy','') not in ('reject','preserve','clear')
    then perform kernel_apply_fail('contract_validation_failed','Invalid source identity write'); end if;
    if exists(select 1 from jsonb_array_elements(normalized) prior where prior->>'model_id'=write->>'model_id' and prior->'provenance'->>'source_record_ref'=source_ref)
    then perform kernel_apply_fail('contract_validation_failed','Duplicate source identity'); end if;
    normalized := normalized || jsonb_build_array(write);
  end loop;
  input_hash := kernel_admin_sha256(kernel_canonical_json(request));
  if old_request is not null then
    if exists(select 1 from jsonb_array_elements(old_request->'writes') w where w->'provenance'->>'source_resolution_hash' is distinct from input_hash)
      or jsonb_array_length(old_request->'writes')<>jsonb_array_length(normalized)
    then perform kernel_apply_fail('idempotency_conflict','Source delivery conflicts with its prior content'); end if;
    if coalesce((policy_snapshot->>'declared')::boolean,false) then
      perform kernel_apply_authorize_replay(receipt_id,app,customer,old_request,policy_snapshot->'policy',active_schema);
    end if;
    return jsonb_build_object('ok',true,'data',old_request);
  end if;
  -- Deterministic source lock order covers target rows and relation references.
  for source_ref in
    select distinct lock_ref from (
      select (w->>'model_id') || ':' || (w->'provenance'->>'source_record_ref') lock_ref from jsonb_array_elements(normalized) w
      union all
      select (r.value->>'model_id') || ':' || (r.value->>'source_record_ref') from jsonb_array_elements(normalized) w cross join lateral jsonb_each(coalesce(w->'provenance'->'relation_source_record_refs','{}'::jsonb)) r
    ) refs order by lock_ref
  loop perform pg_advisory_xact_lock(hashtext('source-identity:' || app || ':' || customer || ':' || source_ref)::bigint); end loop;
  -- Lock canonical subjects in the same model/UUID order as apply before
  -- reading versions. A serialization retry cannot silently refresh a planned
  -- version between matching and apply; ordinary guarded writers serialize here.
  for lock_model in select distinct model_id from (
    select w->>'model_id' model_id from jsonb_array_elements(normalized) w
    union all select r.value->>'model_id' from jsonb_array_elements(normalized) w cross join lateral jsonb_each(coalesce(w->'provenance'->'relation_source_record_refs','{}'::jsonb)) r
  ) models order by model_id loop
    select value into model from jsonb_array_elements(active_schema->'models') m(value) where value->>'id'=lock_model;
    if model is null or model->>'kind'='lookup' then perform kernel_apply_fail('contract_validation_failed', 'Unsupported source identity model'); end if;
    select array_agg(distinct ref) into lock_refs from (
      select w->'provenance'->>'source_record_ref' ref from jsonb_array_elements(normalized) w where w->>'model_id'=lock_model
      union all select r.value->>'source_record_ref' from jsonb_array_elements(normalized) w cross join lateral jsonb_each(coalesce(w->'provenance'->'relation_source_record_refs','{}'::jsonb)) r where r.value->>'model_id'=lock_model
    ) refs;
    table_name := quote_ident(kernel_apply_identifier(kernel_apply_identifier(lock_model) || '_version'));
    execute format('select count(*) from (select r.id from %s r where r.app_id=$1 and r.customer_id=$2 and exists(select 1 from %s v join change_set cs on cs.id=v.change_set_id and cs.app_id=v.app_id and cs.customer_id=v.customer_id where v.record_id=r.id and v.app_id=r.app_id and v.customer_id=r.customer_id and v.stage=''mainline'' and cs.status=''mainline'' and v.provenance ? ''source_record_ref'' and v.provenance->>''source_record_ref''=any($3)) order by r.id for update of r) locked',quote_ident(kernel_apply_identifier(kernel_apply_identifier(lock_model) || '_record')),table_name)
      using app,customer,lock_refs into locked_count;
  end loop;
  for write in select value from jsonb_array_elements(normalized) loop
    select value into model from jsonb_array_elements(active_schema->'models') m(value) where value->>'id'=write->>'model_id';
    if model is null or model->>'kind'='lookup' then perform kernel_apply_fail('contract_validation_failed', 'Unsupported source identity model'); end if;
    table_name := quote_ident(kernel_apply_identifier(kernel_apply_identifier(model->>'id') || '_version'));
    execute format('select array_agg(distinct v.record_id) from %s v join change_set cs on cs.id=v.change_set_id and cs.app_id=v.app_id and cs.customer_id=v.customer_id where v.app_id=$1 and v.customer_id=$2 and v.stage=''mainline'' and cs.status=''mainline'' and v.provenance ? ''source_record_ref'' and v.provenance->>''source_record_ref''=$3',table_name)
      using app,customer,write->'provenance'->>'source_record_ref' into target_ids;
    if coalesce(cardinality(target_ids),0)>1 then perform kernel_apply_fail('source_identity_ambiguous', 'Source identity source matches multiple records'); end if;
    target := target_ids[1];
    if target is not null then
      if write->'provenance'->>'match_policy'='create_only' then perform kernel_apply_fail('source_identity_exists', 'Source identity source already exists'); end if;
      execute format('select to_jsonb(v) from %s v join change_set cs on cs.id=v.change_set_id and cs.app_id=v.app_id and cs.customer_id=v.customer_id where v.app_id=$1 and v.customer_id=$2 and v.record_id=$3 and v.stage=''mainline'' and cs.status=''mainline'' and cs.applied_order is not null and v.effective_start <= $4 and (v.effective_end is null or v.effective_end >= $4) order by v.effective_start desc,v.tombstones_record desc,v.untombstones_record desc,cs.applied_order desc,v.id desc limit 1',table_name)
        using app,customer,target,(write->>'effective_start')::date into version_json;
      if version_json is null or coalesce((version_json->>'tombstones_record')::boolean,false) then perform kernel_apply_fail('record_target_missing', 'Source identity source is not visible'); end if;
      clear_policy := write->'provenance'->>'clear_policy';
      for mapped_field in select jsonb_array_elements_text(write->'provenance'->'mapped_field_ids') loop
        select value into field from jsonb_array_elements(model->'fields') f(value) where value->>'id'=mapped_field;
        if field is null then
          select value || jsonb_build_object('storage','custom') into field
          from jsonb_array_elements(coalesce(active_schema->'custom_fields','[]'::jsonb)) f(value)
          where value->>'model_id'=model->>'id' and value->>'field_id'=mapped_field
            and coalesce(value->>'lifecycle','active')='active';
        end if;
        if field is null then perform kernel_apply_fail('contract_validation_failed', 'Unknown source identity field'); end if;
        select c into custom_value from jsonb_array_elements(coalesce(nullif(write->'custom_fields','null'::jsonb),'[]'::jsonb)) c where c->>'field_id'=mapped_field;
        if not coalesce(write->'values','{}'::jsonb) ? mapped_field and custom_value is null and not coalesce(write->'provenance'->'relation_source_record_refs','{}'::jsonb) ? mapped_field then
          if clear_policy='reject' and (kernel_apply_snapshot(version_json,model) ? mapped_field or exists(select 1 from jsonb_array_elements(coalesce(nullif(version_json->'custom_fields','null'::jsonb),'[]'::jsonb)) current_value where current_value->>'field_id'=mapped_field)) then perform kernel_apply_fail('source_clear_rejected', 'Source identity field clearing is disabled'); end if;
          if clear_policy='clear' then
            if coalesce((field->>'required')::boolean,false) or field->'derived' is not null then perform kernel_apply_fail('contract_validation_failed', 'Source identity field cannot be cleared'); end if;
            if field->>'storage'='custom' then write := jsonb_set(write,'{clear_custom_fields}',coalesce(write->'clear_custom_fields','[]'::jsonb)||to_jsonb(mapped_field));
            else write := jsonb_set(write,'{clear_fields}',coalesce(write->'clear_fields','[]'::jsonb)||to_jsonb(mapped_field)); end if;
          end if;
        end if;
      end loop;
      write := (write-'new_record_id') || jsonb_build_object('record_key',jsonb_build_object('type','record_id','value',target),'expected_version_id',version_json->>'id');
    elsif coalesce((write->>'tombstones_record')::boolean,false) then perform kernel_apply_fail('record_target_missing', 'Source identity delete has no matching source'); end if;
    for relation_entry in select key,value from jsonb_each(coalesce(write->'provenance'->'relation_source_record_refs','{}'::jsonb)) loop
      select value into relation_field from jsonb_array_elements(model->'fields') f(value) where value->>'id'=relation_entry.key;
      if relation_field is null or relation_field->>'type'<>'relation' or relation_field->>'target_model' is distinct from relation_entry.value->>'model_id'
      then perform kernel_apply_fail('contract_validation_failed', 'Invalid source identity relation target'); end if;
      select value into relation_model from jsonb_array_elements(active_schema->'models') m(value) where value->>'id'=relation_entry.value->>'model_id';
      if relation_model is null or relation_model->>'kind'='lookup' then perform kernel_apply_fail('contract_validation_failed', 'Unsupported source identity relation'); end if;
      table_name := quote_ident(kernel_apply_identifier(kernel_apply_identifier(relation_model->>'id') || '_version'));
      execute format('select array_agg(distinct v.record_id) from %s v join change_set cs on cs.id=v.change_set_id and cs.app_id=v.app_id and cs.customer_id=v.customer_id where v.app_id=$1 and v.customer_id=$2 and v.stage=''mainline'' and cs.status=''mainline'' and v.provenance ? ''source_record_ref'' and v.provenance->>''source_record_ref''=$3',table_name)
        using app,customer,relation_entry.value->>'source_record_ref' into relation_ids;
      if coalesce(cardinality(relation_ids),0)>1 then perform kernel_apply_fail('source_identity_ambiguous', 'Source identity relation matches multiple records'); end if;
      relation_target := relation_ids[1];
      if relation_target is null then
        select (pending->>'new_record_id')::uuid into relation_target from jsonb_array_elements(normalized) pending where pending->>'model_id'=relation_entry.value->>'model_id' and pending->'provenance'->>'source_record_ref'=relation_entry.value->>'source_record_ref';
      end if;
      if relation_target is null then perform kernel_apply_fail('record_target_missing', 'Source identity relation source is missing'); end if;
      write := jsonb_set(write,'{values}',coalesce(write->'values','{}'::jsonb));
      write := jsonb_set(write,array['values',relation_entry.key],jsonb_build_object('type','relation','value',jsonb_build_object('type','record_id','value',relation_target)));
    end loop;
    if request->'same_day_receipt'='true'::jsonb and target is not null
      and version_json->>'effective_start'=write->>'effective_start'
      and version_json->'provenance'->>'source_record_ref'=write->'provenance'->>'source_record_ref'
    then
      if not (kernel_apply_snapshot(version_json,model) @> coalesce(nullif(write->'values','null'::jsonb),'{}'::jsonb))
        or version_json->'provenance'->>'payload_hash' is distinct from write->'provenance'->>'payload_hash'
        or coalesce(nullif(write->'custom_fields','null'::jsonb),'[]'::jsonb) <> '[]'::jsonb
      then perform kernel_apply_fail('source_same_day_conflict','Same-day source delivery differs from the existing version'); end if;
      if same_day_id is not null and same_day_id <> (version_json->>'change_set_id')::bigint
      then perform kernel_apply_fail('source_same_day_conflict','Same-day source batch spans multiple receipts'); end if;
      same_day_id := (version_json->>'change_set_id')::bigint;
      same_day_count := same_day_count + 1;
    end if;
    write := jsonb_set(write,'{provenance,source_resolution_hash}',to_jsonb(input_hash));
    resolved := resolved || jsonb_build_array(write);
  end loop;
  if same_day_count > 0 then
    select schema_revision_id, request_fingerprint::jsonb into same_day_revision,same_day_request
      from change_set where id=same_day_id and app_id=app and customer_id=customer and status='mainline' and applied_at is not null;
    if same_day_count <> jsonb_array_length(normalized) or same_day_request is null
      or jsonb_typeof(same_day_request->'writes') <> 'array'
      or jsonb_array_length(same_day_request->'writes') <> same_day_count
    then perform kernel_apply_fail('source_same_day_conflict','Same-day source batch does not match the original receipt'); end if;
    if coalesce((policy_snapshot->>'declared')::boolean,false) then
      perform kernel_apply_authorize_replay(same_day_id,app,customer,same_day_request,policy_snapshot->'policy',active_schema);
    end if;
    return jsonb_build_object('ok',true,'data',jsonb_build_object('legacy_receipt',jsonb_build_object('id',same_day_id,'schema_revision_id',same_day_revision)));
  end if;
  apply_request := request || jsonb_build_object('writes',resolved);
  if octet_length(apply_request::text)>1048576 then perform kernel_apply_fail('contract_validation_failed','Resolved source request exceeds 1 MiB'); end if;
  return jsonb_build_object('ok',true,'data',apply_request);
exception when serialization_failure then raise;
when others then
  get stacked diagnostics state=returned_sqlstate,caught_message=message_text,caught_constraint=constraint_name,caught_table=table_name;
  return jsonb_build_object('ok',false,'error',kernel_apply_error_envelope_v2(state,caught_message,caught_constraint,caught_table,request));
end;
$kernel$;
