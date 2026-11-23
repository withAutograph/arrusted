use super::RuntimeSqlFunction;

pub(super) fn functions() -> Vec<RuntimeSqlFunction> {
    vec![RuntimeSqlFunction {
        signature: "kernel_apply_seed_defaults(jsonb)",
        sql: [
            INSTALLED_SEED_SUBSTRATE.trim(),
            KERNEL_APPLY_SEED_DEFAULTS.trim(),
        ]
        .join("\n\n"),
    }]
}

const INSTALLED_SEED_SUBSTRATE: &str = r#"
create table if not exists installed_seed (
  app_id text not null,
  customer_id text not null,
  seed_identity text not null,
  seed_record_ids uuid[] not null,
  payload_fingerprint text not null,
  source_idempotency_key text not null,
  install_status text not null,
  change_set_id bigint,
  result jsonb not null,
  installed_at timestamptz not null default now(),
  constraint installed_seed_pkey primary key (app_id, customer_id, seed_identity),
  constraint installed_seed_identity_check check (seed_identity ~ '^[0-9a-f]{64}$'),
  constraint installed_seed_payload_fingerprint_check check (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint installed_seed_status_check check (install_status in ('applied', 'skipped_existing')),
  constraint installed_seed_result_check check (jsonb_typeof(result) = 'object')
);

alter table installed_seed enable row level security;
alter table installed_seed force row level security;

do $kernel_seed_policy$
begin
  if exists (
    select 1 from pg_policies
    where schemaname = current_schema()
      and tablename = 'installed_seed'
      and policyname = 'kernel_tenant_isolation'
  ) then
    alter policy kernel_tenant_isolation on installed_seed
      using (
        (app_id, customer_id) = (select scope.app_id, scope.customer_id from (select current_setting('kernel.app_id', true) app_id, current_setting('kernel.customer_id', true) customer_id) scope where kernel_principal_scope_authorized('any', scope.app_id, scope.customer_id, null))
      )
      with check (
        (app_id, customer_id) = (select scope.app_id, scope.customer_id from (select current_setting('kernel.app_id', true) app_id, current_setting('kernel.customer_id', true) customer_id) scope where kernel_principal_scope_authorized('any', scope.app_id, scope.customer_id, null))
      );
  else
    create policy kernel_tenant_isolation on installed_seed
      for all
      using (
        (app_id, customer_id) = (select scope.app_id, scope.customer_id from (select current_setting('kernel.app_id', true) app_id, current_setting('kernel.customer_id', true) customer_id) scope where kernel_principal_scope_authorized('any', scope.app_id, scope.customer_id, null))
      )
      with check (
        (app_id, customer_id) = (select scope.app_id, scope.customer_id from (select current_setting('kernel.app_id', true) app_id, current_setting('kernel.customer_id', true) customer_id) scope where kernel_principal_scope_authorized('any', scope.app_id, scope.customer_id, null))
      );
  end if;
end
$kernel_seed_policy$;
"#;

const KERNEL_APPLY_SEED_DEFAULTS: &str = r#"
create or replace function kernel_apply_seed_defaults(request jsonb)
returns jsonb
language plpgsql
volatile
parallel unsafe
security invoker
set search_path from current
as $kernel$
<<seed_defaults>>
declare
  requested_app_id text := request->>'app_id';
  requested_customer_id text := request->>'customer_id';
  schema_revision_id jsonb := coalesce(request->'schema_revision_id', 'null'::jsonb);
  templates jsonb := request->'change_sets';
  template jsonb;
  template_index integer := 0;
  current_seed_identity text;
  seed_record_ids jsonb;
  seed_record_id uuid;
  payload_fingerprint text;
  active_schema jsonb;
  model jsonb;
  current_model_id text;
  model_is_lookup boolean;
  record_table_name text;
  write jsonb;
  write_index integer;
  record_key jsonb;
  record_key_type text;
  record_key_value text;
  subject_exists boolean;
  reserved_count integer;
  apply_request jsonb;
  apply_result jsonb;
  installed_result jsonb;
  recovering_skip boolean;
  had_prior_change_history boolean;
  allocation_collision boolean;
  scoped_subject_exists boolean;
  allocated_record_id uuid;
  seed_result jsonb;
  applied_results jsonb := '[]'::jsonb;
  seed_results jsonb := '[]'::jsonb;
  applied_count integer := 0;
  skipped_count integer := 0;
  failure jsonb;
  failure_state text; failure_message text; failure_constraint text; failure_table text;
begin
  if jsonb_typeof(request) is distinct from 'object' then
    return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
      'path', 'request', 'code', 'invalid_type', 'message', 'request must be a JSON object'
    )));
  end if;
  if request - array['app_id', 'customer_id', 'schema_revision_id', 'change_sets']::text[] <> '{}'::jsonb then
    return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
      'path', 'request', 'code', 'unknown_field', 'message', 'seed request contains an unknown field'
    )));
  end if;
  if coalesce(btrim(requested_app_id), '') = '' or coalesce(btrim(requested_customer_id), '') = '' then
    return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
      'path', 'scope', 'code', 'required', 'message', 'app_id and customer_id are required'
    )));
  end if;
  if jsonb_typeof(templates) is distinct from 'array' then
    return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
      'path', 'change_sets', 'code', 'invalid_type', 'message', 'change_sets must be an array'
    )));
  end if;
  if not kernel_principal_scope_authorized(
    'schema_admin', requested_app_id, requested_customer_id, null
  ) then
    return kernel_authorize_scope(
      'schema_admin', requested_app_id, requested_customer_id, null
    );
  end if;

  perform set_config('kernel.app_id', requested_app_id, true);
  perform set_config('kernel.customer_id', requested_customer_id, true);

  select sr.schema
  into active_schema
  from schema_revision sr
  where sr.app_id = requested_app_id
    and sr.customer_id = requested_customer_id
    and (
      (schema_revision_id <> 'null'::jsonb and sr.id = (schema_revision_id #>> '{}')::bigint)
      or (schema_revision_id = 'null'::jsonb and sr.activated_at is not null)
    )
  order by sr.activated_at desc nulls last, sr.id desc
  limit 1;
  if active_schema is null then
    return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
      'path', 'schema_revision_id', 'code', 'unknown_schema_revision',
      'message', 'schema revision does not exist in the requested tenant scope'
    )));
  end if;

  -- Validate the complete compiler-owned batch before the first seed can reserve a subject.
  for template in select value from jsonb_array_elements(templates)
  loop
    if jsonb_typeof(template) is distinct from 'object'
      or template - array[
        'seed_identity', 'seed_record_ids', 'actor_id', 'source_kind', 'idempotency_key',
        'change_type_id', 'notes', 'writes'
      ]::text[] <> '{}'::jsonb
    then
      return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
        'path', format('change_sets[%s]', template_index),
        'code', 'invalid_seed_template',
        'message', 'seed templates must contain only compiler-owned change-set fields'
      )));
    end if;
    current_seed_identity := template->>'seed_identity';
    seed_record_ids := template->'seed_record_ids';
    if current_seed_identity is null or current_seed_identity !~ '^[0-9a-f]{64}$' then
      return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
        'path', format('change_sets[%s].seed_identity', template_index),
        'code', 'invalid_seed_identity', 'message', 'seed identity must be compiler-derived SHA-256 hex'
      )));
    end if;
    if jsonb_typeof(seed_record_ids) is distinct from 'array'
      or jsonb_typeof(template->'writes') is distinct from 'array'
      or jsonb_array_length(seed_record_ids) <> jsonb_array_length(template->'writes')
      or jsonb_array_length(seed_record_ids) = 0
    then
      return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
        'path', format('change_sets[%s].seed_record_ids', template_index),
        'code', 'invalid_seed_record_ids', 'message', 'seed record ids must align one-to-one with writes'
      )));
    end if;
    begin
      perform (value #>> '{}')::uuid from jsonb_array_elements(seed_record_ids);
    exception when invalid_text_representation then
      return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
        'path', format('change_sets[%s].seed_record_ids', template_index),
        'code', 'invalid_seed_record_id', 'message', 'seed record ids must be UUIDs'
      )));
    end;
    write_index := 0;
    for write in select value from jsonb_array_elements(template->'writes')
    loop
      current_model_id := write->>'model_id';
      select value into model
      from jsonb_array_elements(coalesce(active_schema->'models', '[]'::jsonb)) entry(value)
      where value->>'id' = current_model_id;
      if model is null then
        return kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
          'path', format('change_sets[%s].writes[%s].model_id', template_index, write_index),
          'code', 'unknown_seed_model', 'message', 'seed write model is not present in the selected schema revision'
        )));
      end if;
      write_index := write_index + 1;
    end loop;
    template_index := template_index + 1;
  end loop;

  -- Freeze pre-batch history under the normal activation/write boundary. A
  -- recovered template must not disqualify later templates in this transaction.
  perform kernel_installer_lock_tenant(requested_app_id, requested_customer_id);
  select exists(select 1 from change_set cs where cs.app_id=requested_app_id
    and cs.customer_id=requested_customer_id) into had_prior_change_history;
  template_index := 0;
  begin
  for template in select value from jsonb_array_elements(templates)
  loop
    current_seed_identity := template->>'seed_identity';
    seed_record_ids := template->'seed_record_ids';

    perform pg_advisory_xact_lock(hashtextextended(
      'kernel:seed:' || requested_app_id || ':' || requested_customer_id || ':' || current_seed_identity, 0
    ));
    payload_fingerprint := kernel_admin_sha256(kernel_canonical_json(template));
    select ledger.result, (ledger.install_status='skipped_existing'
      and ledger.change_set_id is null
      and ledger.payload_fingerprint=seed_defaults.payload_fingerprint
      and ledger.source_idempotency_key=template->>'idempotency_key'
      and ledger.seed_record_ids=array(select value::uuid from jsonb_array_elements_text(seed_defaults.seed_record_ids))
      and not had_prior_change_history
      and exists(select 1 from schema_installation_revision installation
        where installation.app_id=requested_app_id and installation.customer_id=requested_customer_id
          and installation.activated_at=ledger.installed_at
          and installation.activation_kind in ('app_base','tenant_overlay')
          and installation.seed_change_sets @> jsonb_build_array(template)
          and not exists(select 1 from schema_revision earlier
            where earlier.app_id=requested_app_id and earlier.customer_id=requested_customer_id
              and earlier.id < installation.schema_revision_id)))
    into installed_result, recovering_skip
    from installed_seed ledger
    where ledger.app_id = requested_app_id
      and ledger.customer_id = requested_customer_id
      and ledger.seed_identity = current_seed_identity;
    if found and not recovering_skip then
      seed_results := seed_results || jsonb_build_array(
        installed_result || jsonb_build_object('status', 'already_installed')
      );
      skipped_count := skipped_count + 1;
      template_index := template_index + 1;
      continue;
    end if;

    payload_fingerprint := kernel_admin_sha256(kernel_canonical_json(template));
    subject_exists := false;
    write_index := 0;
    for write in select value from jsonb_array_elements(template->'writes')
    loop
      current_model_id := write->>'model_id';
      select value into model
      from jsonb_array_elements(coalesce(active_schema->'models', '[]'::jsonb)) entry(value)
      where value->>'id' = current_model_id;
      model_is_lookup := model->>'kind' = 'lookup';
      record_table_name := kernel_apply_identifier(current_model_id || '_record');
      seed_record_id := (seed_record_ids->>write_index)::uuid;
      record_key := write->'record_key';
      record_key_type := record_key->>'type';
      record_key_value := record_key->>'value';

      if model_is_lookup then
        select exists(
          select 1 from lookup_record record
          where record.app_id = requested_app_id
            and record.customer_id = requested_customer_id
            and record.model_id = current_model_id
            and (
              record.id = seed_record_id
              or (record_key_type = 'external_key' and record.external_key = record_key_value)
            )
        ) into subject_exists;
      else
        execute format(
          'select exists(select 1 from %I where app_id=$1 and customer_id=$2 and (id=$3 or ($4=''external_key'' and external_key=$5)))',
          record_table_name
        ) using requested_app_id, requested_customer_id, seed_record_id, record_key_type, record_key_value
          into subject_exists;
      end if;
      exit when subject_exists;
      write_index := write_index + 1;
    end loop;

    if subject_exists and recovering_skip then
      seed_results := seed_results || jsonb_build_array(installed_result || jsonb_build_object('status','already_installed'));
      skipped_count := skipped_count + 1;
      template_index := template_index + 1;
      continue;
    end if;
    if subject_exists then
      seed_result := jsonb_build_object(
        'seed_identity', current_seed_identity,
        'seed_record_ids', seed_record_ids,
        'status', 'skipped_existing',
        'change_set', null
      );
      insert into installed_seed (
        app_id, customer_id, seed_identity, seed_record_ids, payload_fingerprint,
        source_idempotency_key, install_status, change_set_id, result
      ) values (
        requested_app_id, requested_customer_id, current_seed_identity,
        array(select (value #>> '{}')::uuid from jsonb_array_elements(seed_record_ids)),
        payload_fingerprint, template->>'idempotency_key', 'skipped_existing', null, seed_result
      );
      seed_results := seed_results || jsonb_build_array(seed_result);
      skipped_count := skipped_count + 1;
      template_index := template_index + 1;
      continue;
    end if;

    begin
      allocation_collision := false;
      write_index := 0;
      for write in select value from jsonb_array_elements(template->'writes')
      loop
        record_key := write->'record_key';
        if jsonb_typeof(coalesce(record_key, 'null'::jsonb)) = 'object' then
          current_model_id := write->>'model_id';
          select value into model
          from jsonb_array_elements(active_schema->'models') entry(value)
          where value->>'id' = current_model_id;
          model_is_lookup := model->>'kind' = 'lookup';
          record_table_name := kernel_apply_identifier(current_model_id || '_record');
          seed_record_id := (seed_record_ids->>write_index)::uuid;
          record_key_type := record_key->>'type';
          record_key_value := record_key->>'value';
          if model_is_lookup then
            insert into lookup_record (app_id, customer_id, model_id, id, external_key)
            values (
              requested_app_id, requested_customer_id, current_model_id, seed_record_id,
              case when record_key_type = 'external_key' then record_key_value else null end
            )
            on conflict do nothing;
          else
            execute format(
              'insert into %I (id,app_id,customer_id,external_key) values ($1,$2,$3,$4) on conflict do nothing',
              record_table_name
            ) using seed_record_id, requested_app_id, requested_customer_id,
              case when record_key_type = 'external_key' then record_key_value else null end;
          end if;
          get diagnostics reserved_count = row_count;
          if reserved_count <> 1 then
            -- A global primary-key collision can be invisible under tenant RLS.
            -- A scoped external key still wins: never replace customer defaults.
            if model_is_lookup then
              select exists(select 1 from lookup_record where app_id=requested_app_id
                and customer_id=requested_customer_id and model_id=current_model_id
                and (id=seed_record_id or external_key=record_key_value)) into scoped_subject_exists;
            else
              execute format('select exists(select 1 from %I where app_id=$1 and customer_id=$2 and (id=$3 or external_key=$4))', record_table_name)
                using requested_app_id, requested_customer_id, seed_record_id, record_key_value into scoped_subject_exists;
            end if;
            if scoped_subject_exists then
              raise exception using errcode = 'P0002', message = 'seed subject was created concurrently';
            end if;
            if record_key_type <> 'external_key' then
              failure := kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
                'path', 'change_sets', 'code', 'seed_record_id_collision',
                'message', 'Explicit record-id seed conflicts with an existing global record identity')));
              raise exception using errcode = 'P0001', message = 'kernel seed defaults failed';
            end if;
            allocation_collision := true;
            allocated_record_id := substr(kernel_admin_sha256(kernel_canonical_json(jsonb_build_array(
              'kernel:scoped-seed-record:v1', requested_app_id, requested_customer_id, current_model_id, seed_record_id
            ))), 1, 32)::uuid;
            if model_is_lookup then
              insert into lookup_record(app_id,customer_id,model_id,id,external_key)
                values(requested_app_id,requested_customer_id,current_model_id,allocated_record_id,record_key_value)
                on conflict do nothing;
            else
              execute format('insert into %I(id,app_id,customer_id,external_key) values($1,$2,$3,$4) on conflict do nothing', record_table_name)
                using allocated_record_id,requested_app_id,requested_customer_id,record_key_value;
            end if;
            get diagnostics reserved_count = row_count;
            if reserved_count <> 1 then
              failure := kernel_admin_validation_error(jsonb_build_array(jsonb_build_object(
                'path', 'change_sets', 'code', 'seed_allocation_conflict',
                'message', 'Scoped seed allocation conflicted; retry after inspecting the selected subject')));
              raise exception using errcode = 'P0001', message = 'kernel seed defaults failed';
            end if;
            seed_record_ids := jsonb_set(seed_record_ids, array[write_index::text], to_jsonb(allocated_record_id));
          end if;
        end if;
        write_index := write_index + 1;
      end loop;

      if recovering_skip and not allocation_collision then
        raise exception using errcode='P0003', message='historical skip has no proven allocation conflict';
      end if;
      apply_request := jsonb_build_object(
        'app_id', requested_app_id,
        'customer_id', requested_customer_id,
        'schema_revision_id', schema_revision_id,
        'actor_id', template->'actor_id',
        'source_kind', template->'source_kind',
        'idempotency_key', template->'idempotency_key',
        'change_type_id', coalesce(template->'change_type_id', 'null'::jsonb),
        'notes', coalesce(template->'notes', 'null'::jsonb),
        'mode', 'mainline',
        'writes', template->'writes'
      );
      begin
        apply_result := jsonb_build_object('ok',true,'data',
          kernel_apply_execute_internal(apply_request,false,null,null,true));
      exception
        when serialization_failure then raise;
        when others then
          -- Preserve the public apply error envelope while keeping seed authority private.
          get stacked diagnostics failure_state=returned_sqlstate,failure_message=message_text,
            failure_constraint=constraint_name,failure_table=table_name;
          apply_result := jsonb_build_object('ok',false,'error',kernel_apply_error_envelope_v2(
            failure_state,failure_message,failure_constraint,failure_table,apply_request));
      end;
      if coalesce((apply_result->>'ok')::boolean, false) is not true then
        failure := apply_result;
        raise exception using errcode = 'P0001', message = 'kernel seed defaults failed';
      end if;
      seed_result := jsonb_build_object(
        'seed_identity', current_seed_identity,
        'seed_record_ids', seed_record_ids,
        'status', 'applied',
        'change_set', apply_result->'data'
      );
      insert into installed_seed (
        app_id, customer_id, seed_identity, seed_record_ids, payload_fingerprint,
        source_idempotency_key, install_status, change_set_id, result
      ) values (
        requested_app_id, requested_customer_id, current_seed_identity,
        array(select (value #>> '{}')::uuid from jsonb_array_elements(seed_record_ids)),
        payload_fingerprint, template->>'idempotency_key', 'applied',
        (apply_result->'data'->>'id')::bigint, seed_result
      ) on conflict (app_id,customer_id,seed_identity) do update set
        seed_record_ids=excluded.seed_record_ids, install_status=excluded.install_status,
        change_set_id=excluded.change_set_id, result=excluded.result;
      applied_results := applied_results || jsonb_build_array(apply_result->'data');
      seed_results := seed_results || jsonb_build_array(seed_result);
      applied_count := applied_count + 1;
    exception
      when sqlstate 'P0001' then
        raise;
      when sqlstate 'P0003' then
        seed_results := seed_results || jsonb_build_array(installed_result || jsonb_build_object('status','already_installed'));
        skipped_count := skipped_count + 1;
      when sqlstate 'P0002' then
        seed_record_ids := template->'seed_record_ids';
        seed_result := jsonb_build_object(
          'seed_identity', current_seed_identity,
          'seed_record_ids', seed_record_ids,
          'status', 'skipped_existing',
          'change_set', null
        );
        insert into installed_seed (
          app_id, customer_id, seed_identity, seed_record_ids, payload_fingerprint,
          source_idempotency_key, install_status, change_set_id, result
        ) values (
          requested_app_id, requested_customer_id, current_seed_identity,
          array(select (value #>> '{}')::uuid from jsonb_array_elements(seed_record_ids)),
          payload_fingerprint, template->>'idempotency_key', 'skipped_existing', null, seed_result
        ) on conflict (app_id,customer_id,seed_identity) do nothing;
        seed_results := seed_results || jsonb_build_array(seed_result);
        skipped_count := skipped_count + 1;
    end;
    template_index := template_index + 1;
  end loop;
  exception when sqlstate 'P0001' then
    return failure;
  end;

  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'change_sets', applied_results,
    'seeds', seed_results,
    'applied_count', applied_count,
    'skipped_count', skipped_count
  ));
end;
$kernel$;
"#;
