create or replace function kernel_work_value(row_image jsonb, field_id text)
returns jsonb language sql immutable parallel safe as $kernel$
  select coalesce(
    row_image->'values'->field_id,
    (select value - 'field_id' from jsonb_array_elements(coalesce(row_image->'custom_fields', '[]')) where value->>'field_id' = field_id),
    'null'::jsonb
  )
$kernel$;

create or replace function kernel_work_same_value(a jsonb, b jsonb)
returns boolean language plpgsql immutable parallel safe as $kernel$
begin
  if a = b then return true; end if;
  if a->>'type' is distinct from b->>'type' then return false; end if;
  if a->>'type' = 'number' then return (a->>'value')::numeric = (b->>'value')::numeric; end if;
  if a->>'type' = 'money_rate' then
    return a#>'{value,currency}' = b#>'{value,currency}' and a#>'{value,period}' = b#>'{value,period}'
      and (a#>>'{value,amount}')::numeric = (b#>>'{value,amount}')::numeric;
  end if;
  return false;
end $kernel$;

-- A canonical lowercase UUID text as uuid, else null; lets target joins use
-- the record key index without failing on malformed input.
create or replace function kernel_work_uuid(value text)
returns uuid language sql immutable parallel safe as $kernel$
  select case when value ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then value::uuid end
$kernel$;

-- Working state is owned by a trusted actor and never versions canonical data.
create or replace function kernel_work_actor(request jsonb)
returns text language plpgsql volatile security invoker set search_path from current as $kernel$
begin
  perform kernel_read_scope_schema(request->>'app_id', request->>'customer_id');
  return kernel_policy_request_actor(request->>'app_id', request->>'customer_id');
end $kernel$;

-- Capture and authorize the canonical records behind one model's targets, at
-- the session date, in one indexed temporal query. With `targets` it returns
-- {images}: a private image per record for a work operation. Without targets it
-- reads the session's staged entries of that model and returns them as an
-- array, each annotated against current canonical truth, as get returns them.
create or replace function kernel_work_capture(request jsonb, session jsonb, model_id text, targets jsonb)
returns jsonb language plpgsql volatile security invoker set search_path from current as $kernel$
begin
  return kernel_work_capture(request, session, model_id, targets, false);
end $kernel$;

-- Private canonical images of a model's targets (or, with null targets, the
-- annotated staged entries). readable_only instead returns {readable: [...]},
-- the targets a fresh authorized read would show, without raising for the rest.
create or replace function kernel_work_capture(request jsonb, session jsonb, model_id text, targets jsonb, readable_only boolean)
returns jsonb language plpgsql volatile security invoker set search_path from current as $kernel$
declare
  schema_json jsonb := kernel_read_scope_schema(request->>'app_id', request->>'customer_id');
  model jsonb;
  table_name text;
  fields jsonb;
  policy jsonb;
  captured_grants jsonb;
  archived_fields jsonb;
  values_expression text;
  target_sql text;
  result_sql text;
  captured jsonb;
  denied boolean;
  custom_targets boolean;
  predicate_fields jsonb;
  declared_predicates boolean;
begin
  select value into model from jsonb_array_elements(schema_json->'models') where value->>'id' = model_id;
  if model is null then raise exception 'record_target_missing: unknown model'; end if;
  if targets is not null then
    if exists (
      select 1 from jsonb_array_elements(targets) e
      where kernel_work_uuid(e->>'record_id') is null
    ) then
      raise exception 'authorization_denied: staged record is not visible';
    end if;
    select coalesce(jsonb_agg(distinct value->>'field_id') filter (where value ? 'field_id'), '[]') into fields
    from jsonb_array_elements(targets);
  else
    select coalesce(jsonb_agg(distinct r.field_id), '[]') into fields
    from work_session_record r
    where r.app_id = request->>'app_id' and r.customer_id = request->>'customer_id'
      and r.session_id = (session->>'id')::uuid and r.model_id = kernel_work_capture.model_id;
  end if;
  fields := jsonb_build_array('$id', '$version') || fields;
  custom_targets := exists (
    select 1 from jsonb_array_elements(coalesce(schema_json->'custom_fields', '[]')) d
    where d->>'model_id' = kernel_work_capture.model_id and fields ? (d->>'field_id')
  );
  table_name := kernel_draft_version_table(model);
  if readable_only then
    -- Field grants are judged per target below; here only record read access.
    begin
      policy := kernel_policy_authorize_query(request->>'app_id', request->>'customer_id', model_id,
        jsonb_build_array('$id', '$version'));
    exception when others then
      if sqlerrm like 'authorization_denied%' then return jsonb_build_object('readable', '[]'::jsonb); end if;
      raise;
    end;
  else
    policy := kernel_policy_authorize_query(request->>'app_id', request->>'customer_id', model_id, fields);
  end if;
  captured_grants := case when policy is null then null else kernel_policy_capture_grants(policy, model_id, 'read') end;
  -- Record grants read only their predicate fields. When those are declared
  -- fields, the live record's values serve as its policy image.
  -- Predicate fields of every grant on the model (read and write), so a write
  -- check against this image sees canonical values for its predicates too.
  select coalesce(jsonb_agg(distinct grant_value.value#>>'{record,field}'), '[]'::jsonb) into predicate_fields
  from jsonb_array_elements(coalesce(kernel_policy_active_snapshot(request->>'app_id', request->>'customer_id')#>'{policy,grants}', '[]'::jsonb)) grant_value(value)
  where grant_value.value->>'model' = kernel_work_capture.model_id
    and grant_value.value#>>'{record,kind}' = 'actor_equals_field';
  declared_predicates := not exists (
    select 1 from jsonb_array_elements_text(predicate_fields) predicate(field_id)
    where not exists (select 1 from jsonb_array_elements(model->'fields') d where d->>'id' = predicate.field_id)
  );
  -- Each record's values are built from the staged fields and the predicate
  -- fields only.
  values_expression := case when model->>'kind' = 'lookup'
    then format('kernel_read_lookup_values(%L::jsonb,live.values,%L::jsonb)', model::text, (fields || predicate_fields)::text)
    else kernel_read_field_values_expression('live', model, fields || predicate_fields) end;
  if model->>'kind' = 'lookup' then
    perform kernel_read_assert_lookup_storage_authority(request->>'app_id', request->>'customer_id', model_id);
  end if;
  perform kernel_read_assert_mainline_order(table_name, request->>'app_id', request->>'customer_id');
  -- Archived or inactive custom fields keep their staged entries readable as
  -- gone. A declared field id always means the declared field, never a
  -- colliding custom definition.
  select coalesce(jsonb_agg(f->>'field_id'), '[]') into archived_fields
  from jsonb_array_elements(coalesce(schema_json->'custom_fields', '[]')) f
  where f->>'model_id' = kernel_work_capture.model_id
    and not exists (
      select 1 from jsonb_array_elements(kernel_active_custom_fields(schema_json, kernel_work_capture.model_id)) active
      where active->>'field_id' = f->>'field_id'
    )
    and not exists (
      select 1 from jsonb_array_elements(coalesce(model->'fields', '[]') || coalesce(model->'many_relations', '[]')) d
      where d->>'id' = f->>'field_id'
    );
  if exists (
    select 1 from jsonb_array_elements_text(fields) f
    where f not in ('$id', '$version', '$externalKey')
      and (exists (select 1 from jsonb_array_elements(coalesce(model->'derived_fields', '[]')) d where d->>'id' = f)
        or (not exists (select 1 from jsonb_array_elements(model->'fields') d where d->>'id' = f)
          and not exists (
            select 1 from jsonb_array_elements(coalesce(schema_json->'custom_fields', '[]')) d
            where d->>'model_id' = kernel_work_capture.model_id and d->>'field_id' = f
          )))
  ) then
    raise exception 'contract_validation_failed: unsupported select field';
  end if;
  if readable_only then
    target_sql := $sql$
      select kernel_work_uuid(entry->>'record_id') record_id,
        jsonb_build_array('$id', '$version') || coalesce(jsonb_agg(distinct entry->>'field_id') filter (where entry ? 'field_id'), '[]') fields
      from jsonb_array_elements($1) entry group by 1
    $sql$;
    result_sql := $sql$
      select jsonb_build_object('readable', coalesce(jsonb_agg(entry), '[]'::jsonb)), false
      from jsonb_array_elements($1) entry
      join record_images i on i.record_id = kernel_work_uuid(entry->>'record_id')
      where not (i.gone and i.image is null)
        and ($6 is null or kernel_policy_grants_record_allowed($6,
          jsonb_build_array('$id', '$version', entry->>'field_id'), i.policy_values))
    $sql$;
  elsif targets is not null then
    target_sql := $sql$
      select kernel_work_uuid(entry->>'record_id') record_id,
        jsonb_build_array('$id', '$version') || coalesce(jsonb_agg(distinct entry->>'field_id') filter (where entry ? 'field_id'), '[]') fields
      from jsonb_array_elements($1) entry group by 1
    $sql$;
    result_sql := $sql$
      select
        jsonb_build_object('images', coalesce(jsonb_object_agg(jsonb_build_array($5->>'id', record_id::text)::text,
          jsonb_build_object('record_id', record_id, 'version_id', version_id, 'values', record_values,
            'custom_fields', case when $11 then kernel_read_custom_fields($8, $5->>'id',
              case when gone then image->'custom_fields' else live_custom_fields end) else '[]'::jsonb end,
            'policy_values', policy_values, '_archived', $7)
          || case when gone then jsonb_build_object('gone', 'record_gone') else '{}'::jsonb end), '{}')),
        coalesce(bool_or(denied), false)
      from record_images
    $sql$;
  else
    target_sql := $sql$
      select r.record_id, jsonb_build_array('$id', '$version') || jsonb_agg(r.field_id) fields
      from work_session_record r
      where r.app_id = $2 and r.customer_id = $3 and r.session_id = $9 and r.model_id = $5->>'id'
      group by r.record_id
    $sql$;
    result_sql := $sql$
      select
        coalesce(jsonb_agg(
          jsonb_build_object(
            'model_id', r.model_id, 'record_id', r.record_id, 'field_id', r.field_id,
            'value', r.value, 'baseline', r.baseline, 'base_version', r.base_version,
            'source', r.source, 'actor_id', r.actor_id,
            'author_principal', r.author_principal, 'author_kind', r.author_kind,
            'created_at', r.created_at, 'updated_at', r.updated_at,
            'stale', a.gone_reason is not null or i.version_id is distinct from to_jsonb(r.base_version),
            'current_version', i.version_id, 'current_value', a.current_value)
          || case when r.rule_id is null then '{}'::jsonb else jsonb_build_object('rule_id', r.rule_id) end
          || case when r.thread_id is null then '{}'::jsonb else jsonb_build_object('thread_id', r.thread_id) end
          || case when r.turn_id is null then '{}'::jsonb else jsonb_build_object('turn_id', r.turn_id) end
          || case when r.replaced is null then '{}'::jsonb else jsonb_build_object('replaced', r.replaced) end
          || case when r.note is null then '{}'::jsonb else jsonb_build_object('note', r.note) end
          || case when a.gone_reason is null then '{}'::jsonb else jsonb_build_object('gone', a.gone_reason) end
          order by r.record_id, r.field_id), '[]'::jsonb),
        coalesce(bool_or(i.denied), false)
      from work_session_record r
      join record_images i on i.record_id = r.record_id
      cross join lateral (
        select case when i.gone then 'record_gone' when $7 ? r.field_id then 'field_archived' end gone_reason,
          case when i.gone or $7 ? r.field_id then 'null'::jsonb
            else coalesce(i.record_values->r.field_id, (
              select c - 'field_id' from jsonb_array_elements(coalesce(i.live_custom_fields, '[]')) c
              where c->>'field_id' = r.field_id), 'null'::jsonb) end current_value
      ) a
      where r.app_id = $2 and r.customer_id = $3 and r.session_id = $9 and r.model_id = $5->>'id'
    $sql$;
  end if;
  execute format($query$
    with targets as materialized (%4$s), images as materialized (
      select t.*, (%3$s) record_values, live.id live_id, live.custom_fields live_custom_fields,
        live.id is null or live.tombstones_record or live.untombstones_record gone,
        -- The full image is built only where it is read: for gone records and
        -- for policy images of custom predicate fields.
        case when live.id is null or live.tombstones_record or live.untombstones_record then to_jsonb(ordinary)
          when not $10 then to_jsonb(live) end image
      from targets t
      left join lateral (
        select v.* from %1$I v
        join change_set cs on cs.id = v.change_set_id and cs.app_id = v.app_id and cs.customer_id = v.customer_id
        where v.record_id = t.record_id and v.app_id = $2 and v.customer_id = $3 and v.stage = 'mainline'
          and cs.status = 'mainline' and cs.applied_order is not null
          and v.effective_start <= $4 and (v.effective_end is null or v.effective_end >= $4)%2$s
        order by v.effective_start desc, v.tombstones_record desc, v.untombstones_record desc, cs.applied_order desc, v.id desc
        limit 1
      ) live on true
      left join lateral (
        select v.* from %1$I v
        join change_set cs on cs.id = v.change_set_id and cs.app_id = v.app_id and cs.customer_id = v.customer_id
        where (live.id is null or live.tombstones_record or live.untombstones_record)
          and v.record_id = t.record_id and v.app_id = $2 and v.customer_id = $3 and v.stage = 'mainline'
          and cs.status = 'mainline' and cs.applied_order is not null
          and v.effective_start <= $4 and not v.tombstones_record and not v.untombstones_record%2$s
        order by (v.effective_end is null or v.effective_end >= $4) desc, v.effective_start desc, cs.applied_order desc, v.id desc
        limit 1
      ) ordinary on true
    ), record_images as materialized (
      select images.*,
        coalesce(to_jsonb(live_id), image->'id') version_id,
        policy.values policy_values,
        (gone and image is null) or ($6 is not null and not kernel_policy_grants_record_allowed($6, fields, policy.values)) denied
      from images
      -- Record predicates need a policy image; plain field grants do not.
      cross join lateral (
        select case when $6 is null then null
          when not gone and $10 then record_values
          else kernel_apply_policy_record_values(
            case when not gone then record_values else kernel_draft_record_values($5, image) end,
            image->'custom_fields', image->'metadata', image->'many_relations') end values
      ) policy
    )
    %5$s
  $query$, table_name, kernel_draft_model_filter(model, 'v'), values_expression, target_sql, result_sql)
  into captured, denied
  using targets, request->>'app_id', request->>'customer_id', (session->>'as_of')::date, model,
    captured_grants, archived_fields, schema_json, (session->>'id')::uuid, declared_predicates, custom_targets;
  if denied then raise exception 'authorization_denied: staged record is not visible'; end if;
  return captured;
end $kernel$;

-- Private canonical images of the requested targets, keyed by model and record.
create or replace function kernel_work_canonical_map(request jsonb, session jsonb, changes jsonb)
returns jsonb language plpgsql volatile security invoker set search_path from current as $kernel$
declare
  schema_json jsonb := kernel_read_scope_schema(request->>'app_id', request->>'customer_id');
  subject record;
  result jsonb := '{}'::jsonb;
begin
  if request->>'schema_version' is distinct from schema_json->>'version' then
    raise exception 'schema_drift: generated operation schema version is stale';
  end if;
  for subject in
    select value->>'model_id' model_id, jsonb_agg(value) entries from jsonb_array_elements(changes) group by 1
  loop
    result := result || (kernel_work_capture(request, session, subject.model_id, subject.entries)->'images');
  end loop;
  return result;
end $kernel$;

-- The targets (model_id, record_id, field_id) a fresh authorized read would
-- show; the rest are dropped without raising. Responses that report targets
-- the server discovered (bulk removals) pass them through this.
create or replace function kernel_work_readable(request jsonb, session jsonb, targets jsonb)
returns jsonb language plpgsql volatile security invoker set search_path from current as $kernel$
declare
  subject record;
  result jsonb := '[]'::jsonb;
begin
  for subject in
    select value->>'model_id' model_id, jsonb_agg(value) entries from jsonb_array_elements(coalesce(targets, '[]')) group by 1
  loop
    result := result || (kernel_work_capture(request, session, subject.model_id, subject.entries, true)->'readable');
  end loop;
  return result;
end $kernel$;

create or replace function kernel_work_canonical_image(image jsonb, change jsonb)
returns jsonb language sql immutable as $kernel$
  select case when image ? 'gone' or image->'_archived' ? (change->>'field_id') then
      (image - array['_archived', 'policy_values']) || jsonb_build_object('values', '{}'::jsonb, 'custom_fields', '[]'::jsonb)
        || case when image ? 'gone' then '{}'::jsonb else jsonb_build_object('gone', 'field_archived') end
    else image - '_archived' end
$kernel$;

-- One stored staged entry (`to_jsonb` of its row) as the wire entry.
create or replace function kernel_work_entry(stored jsonb)
returns jsonb language sql immutable parallel safe as $kernel$
  select stored - array['app_id', 'customer_id', 'session_id']
    - array_remove(array[
      case when stored->'rule_id' = 'null'::jsonb then 'rule_id' end,
      case when stored->'thread_id' = 'null'::jsonb then 'thread_id' end,
      case when stored->'turn_id' = 'null'::jsonb then 'turn_id' end,
      case when stored->'replaced' = 'null'::jsonb then 'replaced' end,
      case when stored->'note' = 'null'::jsonb then 'note' end], null)
$kernel$;

-- The owner's session: header, rules, threads and staged entries, read in one
-- statement so the revision and the overlay share a snapshot.
create or replace function kernel_work_state(request jsonb)
returns jsonb language plpgsql volatile security invoker set search_path from current as $kernel$
declare
  actor text := kernel_work_actor(request);
  state jsonb;
begin
  select (to_jsonb(s) - 'receipts') || jsonb_build_object('overlay', coalesce((
      select jsonb_agg(kernel_work_entry(to_jsonb(r)) order by r.model_id, r.record_id, r.field_id)
      from work_session_record r
      where r.app_id = s.app_id and r.customer_id = s.customer_id and r.session_id = s.id
    ), '[]'::jsonb))
  into state
  from work_session s
  where s.app_id = request->>'app_id' and s.customer_id = request->>'customer_id'
    and s.id = (request->>'session_id')::uuid and s.owner_id = actor;
  if state is null then raise exception 'authorization_denied: session is unavailable'; end if;
  return state;
end $kernel$;

-- Staged entries of one session for the given targets, or for one rule.
create or replace function kernel_work_entries(request jsonb, work_id uuid, targets jsonb, output_rule text)
returns jsonb language plpgsql stable security invoker set search_path from current as $kernel$
declare
  result jsonb;
  target record;
  hit jsonb;
  parts jsonb[] := array[]::jsonb[];
begin
  if output_rule is not null then
    select coalesce(jsonb_agg(kernel_work_entry(to_jsonb(r)) order by r.model_id, r.record_id, r.field_id), '[]')
    into result
    from work_session_record r
    where r.app_id = request->>'app_id' and r.customer_id = request->>'customer_id' and r.session_id = work_id
      and r.rule_id = output_rule;
  else
    -- One primary-key probe per target, so a small touch never scans the
    -- session however many entries it holds.
    for target in
      select distinct t->>'model_id' model_id, t->>'record_id' record_id, t->>'field_id' field_id
      from jsonb_array_elements(coalesce(targets, '[]'::jsonb)) t
      order by 1, 2, 3
    loop
      select kernel_work_entry(to_jsonb(r)) into hit
      from work_session_record r
      where r.app_id = request->>'app_id' and r.customer_id = request->>'customer_id' and r.session_id = work_id
        and r.model_id = target.model_id and r.record_id = kernel_work_uuid(target.record_id) and r.field_id = target.field_id;
      if hit is not null then parts := parts || hit; end if;
    end loop;
    result := to_jsonb(parts);
  end if;
  return result;
end $kernel$;

-- Get: the session authorized under current grants, with each staged entry,
-- proposal change and anchor annotated against current canonical truth. A
-- shared hold on the session's mutation lock keeps the header and the entries
-- of one revision together across statements. With `overlay: false` it skips
-- the entry capture and returns the header, rules and threads; entries are
-- then read in pages through `entries`.
create or replace function kernel_work_read(request jsonb)
returns jsonb language plpgsql volatile security invoker set search_path from current as $kernel$
declare
  actor text := kernel_work_actor(request);
  state jsonb;
  overlay jsonb := '[]'::jsonb;
  subject record;
  images jsonb;
  thread record;
  anchor_image jsonb;
begin
  perform pg_advisory_xact_lock_shared(hashtextextended((request->>'app_id') || ':' || (request->>'customer_id') || ':work:'
    || ((request->>'session_id')::uuid)::text, 0));
  select to_jsonb(s) - 'receipts' into state
  from work_session s
  where s.app_id = request->>'app_id' and s.customer_id = request->>'customer_id'
    and s.id = (request->>'session_id')::uuid and s.owner_id = actor;
  if state is null then raise exception 'authorization_denied: session is unavailable'; end if;
  if request->>'schema_version' is distinct from kernel_read_scope_schema(request->>'app_id', request->>'customer_id')->>'version' then
    raise exception 'schema_drift: generated operation schema version is stale';
  end if;
  if request ? 'overlay' and jsonb_typeof(request->'overlay') is distinct from 'boolean' then
    raise exception 'contract_validation_failed: overlay must be boolean';
  end if;
  -- The owner's selection (presence), as the canvas last wrote it.
  state := state || jsonb_build_object('presence', coalesce((
    select jsonb_build_object('selection', p.selection, 'updated_at', p.updated_at) from work_session_presence p
    where p.app_id = request->>'app_id' and p.customer_id = request->>'customer_id'
      and p.session_id = (state->>'id')::uuid and p.actor_id = actor), 'null'::jsonb));
  if coalesce((request->>'overlay')::boolean, true) then
    for subject in
      select distinct r.model_id from work_session_record r
      where r.app_id = request->>'app_id' and r.customer_id = request->>'customer_id' and r.session_id = (state->>'id')::uuid
      order by 1
    loop
      overlay := case when overlay = '[]'::jsonb then kernel_work_capture(request, state, subject.model_id, null)
        else overlay || kernel_work_capture(request, state, subject.model_id, null) end;
    end loop;
    state := state || jsonb_build_object('overlay', overlay);
  end if;
  -- Proposals and anchors are few; they use the same capture by target.
  images := kernel_work_canonical_map(request, state, (
    select coalesce(jsonb_agg(target), '[]'::jsonb) from (
      select e.value target from jsonb_each(state->'threads') t
        cross join lateral jsonb_array_elements(coalesce(t.value#>'{proposal,changes}', '[]')) e
      union all
      select t.value->'anchor' from jsonb_each(state->'threads') t where t.value->'anchor' ?& array['model_id', 'record_id']
    ) targets));
  for thread in select key, value from jsonb_each(state->'threads') loop
    if thread.value ? 'proposal' then
      state := jsonb_set(state, array['threads', thread.key, 'proposal', 'changes'], (
        select coalesce(jsonb_agg(entry || case when canonical ? 'gone' then jsonb_build_object('gone', canonical->'gone') else '{}'::jsonb end
          order by ordinal), '[]')
        from (
          select entry, ordinal,
            kernel_work_canonical_image(images->(jsonb_build_array(entry->>'model_id', entry->>'record_id')::text), entry) canonical
          from jsonb_array_elements(coalesce(thread.value#>'{proposal,changes}', '[]')) with ordinality e(entry, ordinal)
        ) annotated));
    end if;
    if thread.value->'anchor' ?& array['model_id', 'record_id'] then
      anchor_image := kernel_work_canonical_image(
        images->(jsonb_build_array(thread.value#>>'{anchor,model_id}', thread.value#>>'{anchor,record_id}')::text), thread.value->'anchor');
      if anchor_image ? 'gone' then
        state := jsonb_set(state, array['threads', thread.key, 'anchor'], thread.value->'anchor' || jsonb_build_object('gone', anchor_image->'gone'));
      end if;
    end if;
  end loop;
  return state;
end $kernel$;

-- A session's threads with every open save request resolved.
create or replace function kernel_work_resolve_save_requests(threads jsonb)
returns jsonb language sql immutable as $kernel$
  select coalesce(jsonb_object_agg(t.key, case
      when t.value->>'kind' = 'save_request' and not coalesce((t.value->>'resolved')::boolean, false)
      then t.value || jsonb_build_object('resolved', true) else t.value end), '{}'::jsonb)
  from jsonb_each(coalesce(threads, '{}'::jsonb)) t
$kernel$;

-- The prepared changes (see kernel_work_stage) that set a field back to its
-- canonical value while a pending draft wrote that field on that record, as
-- `[model_id, record_id, field_id]` text keys. A draft wrote a field exactly
-- when a read with pending drafts overlays it: the same draft versions and
-- written fields (kernel_read_draft_versions_sql), applying where the draft
-- version is at least as new as the canonical one.
create or replace function kernel_work_draft_changed(request jsonb, session jsonb, prepared jsonb)
returns jsonb language plpgsql volatile security invoker set search_path from current as $kernel$
declare
  schema_json jsonb;
  subject record;
  model jsonb;
  version_table text;
  found jsonb;
  result jsonb := '[]'::jsonb;
begin
  if not exists (
    select 1 from jsonb_array_elements(prepared) p
    where (p->>'unstage')::boolean and not p->'canonical' ? 'gone'
  ) or not exists (
    select 1 from change_set cs
    where cs.app_id = request->>'app_id' and cs.customer_id = request->>'customer_id'
      and cs.status = 'draft' and cs.applied_order is null
  ) then
    return result;
  end if;
  schema_json := kernel_read_scope_schema(request->>'app_id', request->>'customer_id');
  for subject in
    select p#>>'{change,model_id}' model_id,
      jsonb_agg(jsonb_build_object('record_id', p#>>'{change,record_id}', 'field_id', p#>>'{change,field_id}',
        'version_id', p#>>'{canonical,version_id}')) targets
    from jsonb_array_elements(prepared) p
    where (p->>'unstage')::boolean and not p->'canonical' ? 'gone'
    group by 1
  loop
    select value into model from jsonb_array_elements(schema_json->'models') where value->>'id' = subject.model_id;
    version_table := kernel_draft_version_table(model);
    execute format($sql$
      select coalesce(jsonb_agg(distinct jsonb_build_array($3, t->>'record_id', t->>'field_id')::text), '[]'::jsonb)
      from (%1$s) d
      join jsonb_array_elements($7) t on kernel_work_uuid(t->>'record_id') = d.record_id
      join %2$I cv on cv.id = (t->>'version_id')::uuid and d.effective_start >= cv.effective_start
      where not d.lifecycle and d.written ? (t->>'field_id')
    $sql$,
      kernel_read_draft_versions_sql('''{}''::jsonb', '''{}''::jsonb', version_table,
        case when model->>'kind' = 'lookup' then ' and dv.model_id=$3' else '' end || ' and dv.record_id=any($6)'),
      version_table)
    into found
    using request->>'app_id', request->>'customer_id', subject.model_id, schema_json, (session->>'as_of')::date,
      (select array_agg(distinct kernel_work_uuid(t->>'record_id')) from jsonb_array_elements(subject.targets) t),
      subject.targets;
    result := result || found;
  end loop;
  return result;
end $kernel$;

-- Stage changes as one row per target field. Provenance comes from the caller:
-- the acting principal for stage, the proposal for pull, the rule's author for
-- rule outputs. `turn_id` comes only from provenance (the agent context's
-- turn), never from a change; restaging moves an entry to the current turn. Each change is read- and write-authorized and validated by
-- canonical apply's field validation; a change to the current canonical value
-- removes the entry, unless a pending draft wrote that field on that record
-- or an agent makes it over a person's entry (kept, with the person's value
-- as `replaced`). Rule outputs skip fields holding any other entry, and the
-- rule's earlier outputs that this evaluation did not produce are removed.
-- When an agent overwrites a human's entry, the human's value and author are
-- kept as `replaced` (for Restore); a human's edit clears it. `note` (an
-- agent's rule note) comes from provenance and is replaced with each write.
-- With apply = false (proposals) nothing is written.
create or replace function kernel_work_stage(request jsonb, session jsonb, changes jsonb, provenance jsonb, apply boolean)
returns void language plpgsql volatile security invoker set search_path from current as $kernel$
declare
  schema_json jsonb := kernel_read_scope_schema(request->>'app_id', request->>'customer_id');
  work_id uuid := (session->>'id')::uuid;
  output_rule text := provenance->>'rule_id';
  images jsonb;
  prepared jsonb;
  policy jsonb;
  grants jsonb;
  issues jsonb;
  draft_kept jsonb;
begin
  if jsonb_typeof(changes) is distinct from 'array' or exists (
    select 1 from jsonb_array_elements(changes) c
    where jsonb_typeof(c) is distinct from 'object' or not (c ?& array['model_id', 'record_id', 'field_id', 'value'])
  ) then
    raise exception 'contract_validation_failed: invalid staged change';
  end if;
  -- Canonical images, including the canonical values of every record-grant
  -- predicate field, authorize writes; staged values never do.
  images := kernel_work_canonical_map(request, session, changes);
  -- The last change to a target wins. Each change carries its field definition
  -- and canonical image; a rule skips targets holding another entry.
  with latest as (
    select distinct on (c->>'model_id', c->>'record_id', c->>'field_id') c change
    from jsonb_array_elements(changes) with ordinality item(c, ordinal)
    order by c->>'model_id', c->>'record_id', c->>'field_id', ordinal desc
  ), models as materialized (
    -- Computed once per model, not once per change.
    select model_id, kernel_derived_environment(schema_json, model_id) environment
    from (select distinct change->>'model_id' model_id from latest) distinct_models
  ), resolved as (
    -- An agent never removes a person's edit: its change back to the
    -- canonical value over a person's entry (or over its own entry holding a
    -- person's replaced value) stays staged, so the person's value is kept as
    -- `replaced` and Restore brings it back.
    select change, m.environment->(change->>'field_id') field,
      provenance->>'author_kind' = 'agent' and (w.author_kind = 'human' or w.replaced->>'author_kind' = 'human') keeps_person,
      kernel_work_canonical_image(images->(jsonb_build_array(change->>'model_id', change->>'record_id')::text), change) canonical
    from latest
    join models m on m.model_id = change->>'model_id'
    left join work_session_record w
      on w.app_id = request->>'app_id' and w.customer_id = request->>'customer_id' and w.session_id = work_id
      and w.model_id = change->>'model_id' and w.record_id = (change->>'record_id')::uuid and w.field_id = change->>'field_id'
    where output_rule is null or w.rule_id is not distinct from output_rule or w.field_id is null
  )
  select coalesce(jsonb_agg(jsonb_build_object('change', change, 'field', field, 'canonical', canonical,
      'unstage', kernel_work_same_value(kernel_work_value(canonical, change->>'field_id'), change->'value')
        and not coalesce(keeps_person, false))), '[]')
  into prepared
  from resolved;
  -- Setting a field back to its canonical value is a no-op only when no
  -- pending draft wrote that field on that record; otherwise the entry is
  -- kept (and Save writes it), so reads with pending drafts show it.
  draft_kept := kernel_work_draft_changed(request, session, prepared);
  if jsonb_array_length(draft_kept) > 0 then
    select jsonb_agg(case when draft_kept ? jsonb_build_array(p#>>'{change,model_id}', p#>>'{change,record_id}', p#>>'{change,field_id}')::text
        then p || jsonb_build_object('unstage', false) else p end)
    into prepared from jsonb_array_elements(prepared) p;
  end if;
  if jsonb_array_length(prepared) = 0 then
    if apply and output_rule is not null then
      delete from work_session_record w
      where w.app_id = request->>'app_id' and w.customer_id = request->>'customer_id' and w.session_id = work_id
        and w.rule_id = output_rule;
    end if;
    return;
  end if;
  if exists (select 1 from jsonb_array_elements(prepared) p where p->'field' is null or p->'field' ? 'expression') then
    raise exception 'contract_validation_failed: unsupported staged field';
  end if;
  -- Rule outputs are typed derived values of the target field's type; they get
  -- the shared field-value checks (representation, enum options, ISO codes).
  -- Other changes use canonical apply's full write validation.
  if output_rule is not null then
    if exists (
      select 1 from jsonb_array_elements(prepared) p
      where p#>'{change,value}' <> 'null'::jsonb
        and kernel_apply_field_value_issue(p#>>'{field,type}', p#>'{field,option_set}', p#>'{change,value}') is not null
    ) then
      raise exception 'contract_validation_failed: rule output is not a valid value of its field';
    end if;
  else
  issues := kernel_apply_validation_issues(jsonb_build_object(
    'app_id', request->'app_id', 'customer_id', request->'customer_id',
    'writes', (
      select jsonb_agg(
        jsonb_build_object('model_id', p#>'{change,model_id}', 'effective_start', session->'as_of',
          'record_key', jsonb_build_object('type', 'record_id', 'value', p#>'{change,record_id}'))
        || case
          when p#>'{change,value}' = 'null'::jsonb and p#>>'{field,source}' = 'custom'
            then jsonb_build_object('clear_custom_fields', jsonb_build_array(p#>'{change,field_id}'))
          when p#>'{change,value}' = 'null'::jsonb
            then jsonb_build_object('clear_fields', jsonb_build_array(p#>'{change,field_id}'))
          when p#>>'{field,source}' = 'custom'
            then jsonb_build_object('custom_fields', jsonb_build_array(p#>'{change,value}' || jsonb_build_object('field_id', p#>'{change,field_id}')))
          else jsonb_build_object('values', jsonb_build_object(p#>>'{change,field_id}', p#>'{change,value}'))
        end)
      from jsonb_array_elements(prepared) p)
  ), schema_json);
  if jsonb_array_length(issues) > 0 then
    raise exception using errcode = 'AR001', message = jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'contract_validation_failed', 'message', 'Invalid staged value', 'details', issues))::text;
  end if;
  end if;
  if exists (
    select 1 from jsonb_array_elements(prepared) p
    where p#>'{change,value}' <> 'null'::jsonb and p#>>'{field,type}' = 'relation'
      and p#>>'{change,value,value,type}' is distinct from 'record_id'
  ) then
    raise exception 'contract_validation_failed: stage relations by immutable record id';
  end if;
  if exists (select 1 from jsonb_array_elements(prepared) p where p->'canonical' ? 'gone') then
    raise exception 'record_target_missing: staged target is gone';
  end if;
  -- The update grant applies to the canonical image and to the staged result.
  -- Field grants are checked once per field; record grants per record only
  -- when the grants have record predicates, and against the staged result only
  -- when the change sets a predicate field.
  policy := kernel_policy_active_snapshot(request->>'app_id', request->>'customer_id')->'policy';
  if policy is not null and policy <> 'null'::jsonb then
    select jsonb_object_agg(model_id, captured) into grants
    from (
      select model_id, captured || jsonb_build_object('predicates', (
          select coalesce(jsonb_agg(g#>>'{record,field}'), '[]'::jsonb) from jsonb_array_elements(captured->'grants') g
          where g#>>'{record,kind}' = 'actor_equals_field')) captured
      from (
        select model_id, kernel_policy_capture_grants(policy, model_id, 'update') captured
        from (select distinct p#>>'{change,model_id}' model_id from jsonb_array_elements(prepared) p) models
      ) captured_models
    ) models;
    if exists (
      select 1 from (
        select distinct p#>>'{change,model_id}' model_id, p#>>'{change,field_id}' field_id from jsonb_array_elements(prepared) p
      ) target
      where not kernel_policy_grants_fields_allowed(grants->target.model_id, jsonb_build_array(target.field_id))
    ) or exists (
      select 1 from jsonb_array_elements(prepared) p
      cross join lateral (select grants->(p#>>'{change,model_id}') captured, jsonb_build_array(p#>>'{change,field_id}') fields) g
      where jsonb_array_length(g.captured->'predicates') > 0
        and (not kernel_policy_grants_record_allowed(g.captured, g.fields, p#>'{canonical,policy_values}')
          or (g.captured->'predicates' ? (p#>>'{change,field_id}') and not kernel_policy_grants_record_allowed(g.captured, g.fields,
            p#>'{canonical,policy_values}' || jsonb_build_object(p#>>'{change,field_id}', p#>'{change,value}'))))
    ) then
      raise exception 'authorization_denied: staged write is not authorized';
    end if;
  end if;
  if not apply then return; end if;
  -- A change back to the saved value unstages, whoever staged the entry
  -- (an agent's over a person's entry was kept above).
  delete from work_session_record w
  using jsonb_array_elements(prepared) p
  where w.app_id = request->>'app_id' and w.customer_id = request->>'customer_id' and w.session_id = work_id
    and w.model_id = p#>>'{change,model_id}' and w.record_id = (p#>>'{change,record_id}')::uuid
    and w.field_id = p#>>'{change,field_id}' and (p->>'unstage')::boolean;
  if output_rule is not null then
    delete from work_session_record w
    where w.app_id = request->>'app_id' and w.customer_id = request->>'customer_id' and w.session_id = work_id
      and w.rule_id = output_rule
      and not exists (
        select 1 from jsonb_array_elements(prepared) p
        where w.model_id = p#>>'{change,model_id}' and w.record_id = (p#>>'{change,record_id}')::uuid
          and w.field_id = p#>>'{change,field_id}' and not (p->>'unstage')::boolean
      );
  end if;
  -- An entry keeps its first baseline, base version and creation time.
  insert into work_session_record as w (
    app_id, customer_id, session_id, model_id, record_id, field_id, value, baseline, base_version,
    source, actor_id, author_principal, author_kind, rule_id, thread_id, turn_id, note, created_at, updated_at
  )
  select request->>'app_id', request->>'customer_id', work_id,
    p#>>'{change,model_id}', (p#>>'{change,record_id}')::uuid, p#>>'{change,field_id}', p#>'{change,value}',
    kernel_work_value(p->'canonical', p#>>'{change,field_id}'), (p#>>'{canonical,version_id}')::uuid,
    provenance->>'source', provenance->>'actor_id', provenance->>'author_principal', provenance->>'author_kind',
    output_rule, coalesce(p#>>'{change,thread_id}', provenance->>'thread_id'), (provenance->>'turn_id')::uuid,
    provenance->>'note', clock_timestamp(), clock_timestamp()
  from jsonb_array_elements(prepared) p
  where not (p->>'unstage')::boolean
  on conflict (app_id, customer_id, session_id, model_id, record_id, field_id) do update set
    value = excluded.value, source = excluded.source, actor_id = excluded.actor_id,
    author_principal = excluded.author_principal, author_kind = excluded.author_kind,
    rule_id = excluded.rule_id, thread_id = excluded.thread_id, turn_id = excluded.turn_id, note = excluded.note,
    replaced = case
      when excluded.author_kind = 'human' then null
      when w.author_kind = 'human' then jsonb_build_object('value', w.value, 'author_kind', w.author_kind, 'actor_id', w.actor_id, 'author_principal', w.author_principal)
      else w.replaced end,
    updated_at = excluded.updated_at
  where (w.value, w.source, w.actor_id, w.author_principal, w.author_kind, w.rule_id, w.thread_id, w.turn_id, w.note)
    is distinct from (excluded.value, excluded.source, excluded.actor_id, excluded.author_principal,
      excluded.author_kind, excluded.rule_id, excluded.thread_id, excluded.turn_id, excluded.note);
end $kernel$;

-- One page of the session's staged entries in key order (model, record, field),
-- optionally filtered by model, source and turn. Entries a fresh authorized
-- read would not show are omitted and never named: the scan continues past them
-- in key order until the page fills or the entries end, and `next` is the key
-- of the last returned entry (null at the end). Returned entries are annotated
-- against current canonical truth as get annotates them.
create or replace function kernel_work_entries_page(request jsonb)
returns jsonb language plpgsql volatile security invoker set search_path from current as $kernel$
declare
  actor text := kernel_work_actor(request);
  state jsonb;
  after jsonb := request->'after';
  cursor_key jsonb;
  page_size integer;
  batch jsonb;
  batch_length integer;
  subject record;
  found_readable jsonb;
  readable jsonb := '[]'::jsonb;
  page jsonb;
  images jsonb;
  annotated jsonb;
begin
  if request ? 'limit' and (jsonb_typeof(request->'limit') is distinct from 'number'
    or request->>'limit' !~ '^[0-9]+$' or (request->>'limit')::numeric not between 1 and 1000) then
    raise exception 'contract_validation_failed: limit must be an integer from 1 to 1000';
  end if;
  page_size := coalesce((request->>'limit')::integer, 200);
  if (request ? 'model_id' and jsonb_typeof(request->'model_id') is distinct from 'string')
    or (request ? 'source' and coalesce(request->>'source', '') not in ('user', 'agent'))
    or (request ? 'turn_id' and kernel_work_uuid(request->>'turn_id') is null)
    or (after is not null and (jsonb_typeof(after) is distinct from 'object'
      or jsonb_typeof(after->'model_id') is distinct from 'string' or jsonb_typeof(after->'field_id') is distinct from 'string'
      or kernel_work_uuid(after->>'record_id') is null)) then
    raise exception 'contract_validation_failed: invalid entries page request';
  end if;
  perform pg_advisory_xact_lock_shared(hashtextextended((request->>'app_id') || ':' || (request->>'customer_id') || ':work:'
    || ((request->>'session_id')::uuid)::text, 0));
  select to_jsonb(s) - 'receipts' into state
  from work_session s
  where s.app_id = request->>'app_id' and s.customer_id = request->>'customer_id'
    and s.id = (request->>'session_id')::uuid and s.owner_id = actor;
  if state is null then raise exception 'authorization_denied: session is unavailable'; end if;
  if request->>'schema_version' is distinct from kernel_read_scope_schema(request->>'app_id', request->>'customer_id')->>'version' then
    raise exception 'schema_drift: generated operation schema version is stale';
  end if;
  cursor_key := after;
  -- Scan in key order until one readable entry past the page shows whether
  -- more follow, or the entries end. The scan position stays internal.
  loop
    select coalesce(jsonb_agg(kernel_work_entry(to_jsonb(r)) order by r.model_id, r.record_id, r.field_id), '[]'::jsonb)
    into batch
    from (
      select * from work_session_record r
      where r.app_id = request->>'app_id' and r.customer_id = request->>'customer_id' and r.session_id = (state->>'id')::uuid
        and (not request ? 'model_id' or r.model_id = request->>'model_id')
        and (not request ? 'source' or r.source = request->>'source')
        and (not request ? 'turn_id' or r.turn_id = (request->>'turn_id')::uuid)
        and (cursor_key is null or (r.model_id, r.record_id, r.field_id)
          > (cursor_key->>'model_id', (cursor_key->>'record_id')::uuid, cursor_key->>'field_id'))
      order by r.model_id, r.record_id, r.field_id
      limit page_size + 1
    ) r;
    batch_length := jsonb_array_length(batch);
    exit when batch_length = 0;
    for subject in
      select value->>'model_id' model_id, jsonb_agg(value) entries from jsonb_array_elements(batch) group by 1 order by 1
    loop
      found_readable := kernel_work_capture(request, state, subject.model_id, subject.entries, true)->'readable';
      readable := readable || found_readable;
    end loop;
    cursor_key := batch->-1;
    exit when jsonb_array_length(readable) > page_size or batch_length <= page_size;
  end loop;
  select coalesce(jsonb_agg(e order by ordinal), '[]'::jsonb) into page
  from (
    select e, row_number() over (order by e->>'model_id', (e->>'record_id')::uuid, e->>'field_id') ordinal
    from jsonb_array_elements(readable) item(e)
  ) ordered
  where ordinal <= page_size;
  images := kernel_work_canonical_map(request, state, page);
  select coalesce(jsonb_agg(entry
      || jsonb_build_object('stale', canonical ? 'gone' or canonical->'version_id' is distinct from entry->'base_version',
        'current_version', canonical->'version_id',
        'current_value', case when canonical ? 'gone' then 'null'::jsonb else kernel_work_value(canonical, entry->>'field_id') end)
      || case when canonical ? 'gone' then jsonb_build_object('gone', canonical->'gone') else '{}'::jsonb end
      order by ordinal), '[]'::jsonb)
  into annotated
  from (
    select entry, ordinal,
      kernel_work_canonical_image(images->(jsonb_build_array(entry->>'model_id', entry->>'record_id')::text), entry) canonical
    from jsonb_array_elements(page) with ordinality e(entry, ordinal)
  ) targets;
  return jsonb_build_object('revision', (state->>'revision')::bigint, 'entries', annotated,
    'has_more', jsonb_array_length(readable) > page_size,
    'next', case when jsonb_array_length(readable) > page_size then jsonb_build_object(
      'model_id', page->-1->'model_id', 'record_id', page->-1->'record_id', 'field_id', page->-1->'field_id') end);
end $kernel$;
