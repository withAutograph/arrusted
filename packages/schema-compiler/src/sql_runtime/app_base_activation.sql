create or replace function kernel_activate_app_base_schema_revision(request jsonb)
returns jsonb
language plpgsql
volatile
parallel unsafe
security invoker
set search_path from current
as $kernel$
<<installer_app_activation>>
declare
  app_id text := request->>'app_id';
  release_id text := request->>'release_id';
  base_artifact_hash text := request->>'base_artifact_hash';
  targets jsonb := request->'targets';
  target jsonb;
  target_count integer;
  prepared_count integer;
  active_target_count integer := 0;
  schema_revision_id bigint;
  customer_id text;
  effective_artifact_hash text;
  expected_hash text;
  prepared record;
  active_revision_id bigint;
  active_effective_hash text;
  activated_targets jsonb := '[]'::jsonb;
  target_seed_change_sets jsonb;
  seed_result jsonb;
  interval_violation jsonb;
begin
  if coalesce(app_id, '') = '' or coalesce(release_id, '') = ''
    or not kernel_installer_valid_hash(base_artifact_hash)
    or jsonb_typeof(targets) is distinct from 'array'
    or jsonb_array_length(targets) = 0
  then
    return kernel_installer_error('contract_validation_failed', 'Contract validation failed', 'request', 'invalid_app_base_activation', 'app_id, release_id, base hash, and at least one target are required');
  end if;
  if exists (
    select 1 from jsonb_array_elements(targets) as item(value)
    group by value->>'customer_id' having count(*) > 1
  ) then
    return kernel_installer_error('contract_validation_failed', 'Contract validation failed', 'targets', 'duplicate_target', 'customer targets must be unique');
  end if;

  perform kernel_installer_lock_app(app_id, true);
  target_count := jsonb_array_length(targets);
  select count(*)::integer into prepared_count
  from schema_installation_revision sir
  where sir.app_id = installer_app_activation.app_id
    and sir.release_id = installer_app_activation.release_id
    and sir.activation_kind = 'app_base'
    and sir.base_artifact_hash = installer_app_activation.base_artifact_hash;
  if prepared_count <> target_count then
    return kernel_installer_error('schema_activation_conflict', 'Schema activation conflict', 'targets', 'target_set_mismatch', 'the request must contain every prepared target for this app-base release');
  end if;

  for target in
    select value from jsonb_array_elements(targets) as item(value)
    order by value->>'customer_id'
  loop
    begin
      schema_revision_id := (target->>'schema_revision_id')::bigint;
    exception when others then
      return kernel_installer_error('contract_validation_failed', 'Contract validation failed', 'targets.schema_revision_id', 'invalid_schema_revision_id', 'every target revision id must be a positive integer');
    end;
    customer_id := target->>'customer_id';
    effective_artifact_hash := target->>'effective_artifact_hash';
    expected_hash := target->>'expected_active_effective_hash';
    if coalesce(schema_revision_id, 0) <= 0 or coalesce(customer_id, '') = ''
      or not kernel_installer_valid_hash(effective_artifact_hash)
      or not target ? 'expected_active_effective_hash'
      or (expected_hash is not null and not kernel_installer_valid_hash(expected_hash))
    then
      return kernel_installer_error('contract_validation_failed', 'Contract validation failed', 'targets', 'invalid_target', 'each target requires customer, revision, effective hash, and expected active hash');
    end if;
    perform kernel_installer_lock_tenant(app_id, customer_id);
  end loop;

  for target in
    select value from jsonb_array_elements(targets) as item(value)
    order by value->>'customer_id'
  loop
    schema_revision_id := (target->>'schema_revision_id')::bigint;
    customer_id := target->>'customer_id';
    effective_artifact_hash := target->>'effective_artifact_hash';
    expected_hash := target->>'expected_active_effective_hash';
    -- The prepared row joins schema_revision under FORCE RLS. Establish the
    -- exact authorized target scope before locking or reading either row.
    perform set_config('kernel.app_id', app_id, true);
    perform set_config('kernel.customer_id', customer_id, true);
    -- Installation timestamps retain history; schema_revision owns current activation.
    select sir.*, sr.activated_at as current_activated_at, sr.base_schema->>'version' as base_schema_version
    into prepared
    from schema_installation_revision sir
    join schema_revision sr on sr.id = sir.schema_revision_id
    where sir.schema_revision_id = installer_app_activation.schema_revision_id
      and sir.app_id = installer_app_activation.app_id
      and sir.customer_id = installer_app_activation.customer_id
    for update of sir, sr;
    if not found
      or prepared.release_id is distinct from release_id
      or prepared.activation_kind is distinct from 'app_base'
      or prepared.base_artifact_hash is distinct from base_artifact_hash
      or prepared.effective_artifact_hash is distinct from effective_artifact_hash
      or prepared.expected_active_effective_hash is distinct from expected_hash
    then
      return kernel_installer_error('schema_activation_conflict', 'Schema activation conflict', 'targets', 'prepared_target_mismatch', 'a requested target does not match the prepared app-base release');
    end if;
    if prepared.current_activated_at is not null then
      active_target_count := active_target_count + 1;
      continue;
    end if;
    if prepared.ready_at is null then
      return kernel_installer_error('schema_revision_not_ready', 'Schema revision is not ready', 'targets.' || customer_id, 'readiness_required', 'every target must pass readiness validation before app-base activation');
    end if;
    -- Re-validate interval rules under the exclusive activation lock so no
    -- write admitted after readiness can activate an overlapping state.
    perform set_config('kernel.app_id', app_id, true);
    perform set_config('kernel.customer_id', customer_id, true);
    interval_violation := coalesce(
      kernel_constraint_interval_isolation_error(app_id, customer_id, schema_revision_id, null),
      kernel_constraint_interval_violation(app_id, customer_id, schema_revision_id, null)
    );
    if interval_violation is not null then
      return jsonb_build_object('ok', false, 'error', jsonb_build_object(
        'code', 'schema_revision_not_ready',
        'message', 'Schema revision is not ready',
        'details', interval_violation->'details'
      ));
    end if;
    select sr.id, sir.effective_artifact_hash
    into active_revision_id, active_effective_hash
    from schema_revision sr
    left join schema_installation_revision sir on sir.schema_revision_id = sr.id
    where sr.app_id = installer_app_activation.app_id
      and sr.customer_id = installer_app_activation.customer_id
      and sr.activated_at is not null
    for update of sr;
    if active_revision_id is not null and active_effective_hash is null then
      return kernel_installer_error('schema_activation_conflict', 'Schema activation conflict', 'targets.' || customer_id, 'active_revision_unmanaged', 'an active target has no immutable installer artifact identity');
    end if;
    if active_effective_hash is distinct from expected_hash then
      return kernel_installer_error('schema_activation_conflict', 'Schema activation conflict', 'targets.' || customer_id, 'expected_hash_mismatch', 'an active effective artifact hash changed before activation');
    end if;
  end loop;
  if active_target_count > 0 then
    if active_target_count = target_count then
      -- The activation head is compiler-owned derived state. Reconcile it on
      -- replay so an otherwise-active immutable release restores the declared
      -- catalog instead of accepting or preserving drift.
      for target in
        select value from jsonb_array_elements(targets) as item(value)
        order by value->>'customer_id'
      loop
        schema_revision_id := (target->>'schema_revision_id')::bigint;
        customer_id := target->>'customer_id';
        perform set_config('kernel.app_id', app_id, true);
        perform set_config('kernel.customer_id', customer_id, true);
        insert into schema_activation_head (app_id, customer_id, base_schema_version)
        select installer_app_activation.app_id, installer_app_activation.customer_id,
               coalesce(sr.base_schema->>'version', sr.version)
        from schema_revision sr where sr.id = installer_app_activation.schema_revision_id
        on conflict on constraint schema_activation_head_pkey do update
          set base_schema_version = excluded.base_schema_version, advanced_at = now();
      end loop;
      return jsonb_build_object('ok', true, 'data', jsonb_build_object(
        'activation_kind', 'app_base', 'app_id', app_id, 'release_id', release_id,
        'base_artifact_hash', base_artifact_hash, 'targets', targets,
        'state', 'active', 'idempotent', true
      ));
    end if;
  end if;

  begin
    for target in
      select value from jsonb_array_elements(targets) as item(value)
      order by value->>'customer_id'
    loop
      schema_revision_id := (target->>'schema_revision_id')::bigint;
      customer_id := target->>'customer_id';
      effective_artifact_hash := target->>'effective_artifact_hash';
      perform set_config('kernel.app_id', app_id, true);
      perform set_config('kernel.customer_id', customer_id, true);
      -- A previously activated target is an exact current-release replay. Keep its
      -- active head, timestamps, seeds and business history unchanged while the
      -- remaining approved targets advance atomically.
      if exists(select 1 from schema_revision sr where sr.id=installer_app_activation.schema_revision_id and sr.activated_at is not null) then
        activated_targets := activated_targets || jsonb_build_array(jsonb_build_object(
          'customer_id',customer_id,'schema_revision_id',schema_revision_id,
          'effective_artifact_hash',effective_artifact_hash
        ));
        continue;
      end if;
      insert into schema_activation_head (app_id, customer_id, base_schema_version)
      select installer_app_activation.app_id, installer_app_activation.customer_id,
             coalesce(sr.base_schema->>'version', sr.version)
      from schema_revision sr where sr.id = installer_app_activation.schema_revision_id
      on conflict on constraint schema_activation_head_pkey do update
        set base_schema_version = excluded.base_schema_version, advanced_at = now();
      update schema_revision as sr
      set activated_at = null
      where sr.app_id = installer_app_activation.app_id
        and sr.customer_id = installer_app_activation.customer_id
        and sr.activated_at is not null;
      update schema_revision as sr
      set activated_at = now()
      where sr.id = installer_app_activation.schema_revision_id;
      update schema_installation_revision as sir
      set activated_at = now()
      where sir.schema_revision_id = installer_app_activation.schema_revision_id;
      -- Fresh app-base lookup models have the same generic storage authority
      -- as fresh tenant-overlay models. Establish it before seed writes.
      insert into lookup_storage_authority(
        app_id, customer_id, model_id, schema_hash, authority,
        legacy_record_table, legacy_version_table, activated_at
      )
      select sr.app_id, sr.customer_id, model.value->>'id', sr.schema_hash,
             'generic', 'lookup_record', 'lookup_version', now()
      from schema_revision sr
      cross join lateral jsonb_array_elements(sr.schema->'models') model(value)
      where sr.id = installer_app_activation.schema_revision_id
        and model.value->>'kind' = 'lookup'
        and not kernel_lookup_has_typed_history(sr.app_id, sr.customer_id, model.value->>'id')
      on conflict on constraint lookup_storage_authority_pkey do nothing;
      perform kernel_reconcile_lookup_foreign_key_targets(
        installer_app_activation.app_id, installer_app_activation.customer_id
      );
      select sir.seed_change_sets
      into target_seed_change_sets
      from schema_installation_revision as sir
      where sir.schema_revision_id = installer_app_activation.schema_revision_id;
      if jsonb_array_length(target_seed_change_sets) > 0 then
        seed_result := kernel_apply_seed_defaults(jsonb_build_object(
          'app_id', installer_app_activation.app_id,
          'customer_id', installer_app_activation.customer_id,
          'schema_revision_id', installer_app_activation.schema_revision_id,
          'change_sets', target_seed_change_sets
        ));
        if coalesce((seed_result->>'ok')::boolean, false) is not true then
          raise exception using errcode = 'P0001', message = 'kernel seed activation failed';
        end if;
      end if;
      activated_targets := activated_targets || jsonb_build_array(jsonb_build_object(
        'customer_id', customer_id,
        'schema_revision_id', schema_revision_id,
        'effective_artifact_hash', effective_artifact_hash
      ));
    end loop;
  exception when others then
    if seed_result is not null
      and coalesce((seed_result->>'ok')::boolean, false) is not true
    then
      return seed_result;
    end if;
    return kernel_installer_error('database_error', 'Database operation failed', 'activation', 'activation_failed', 'app-base activation was rolled back for every target');
  end;

  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'activation_kind', 'app_base', 'app_id', app_id, 'release_id', release_id,
    'base_artifact_hash', base_artifact_hash, 'targets', activated_targets,
    'state', 'active', 'idempotent', false
  ));

end;
$kernel$;
