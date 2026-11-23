create or replace function kernel_continue_app_base_schema_revision(request jsonb)
returns jsonb
language plpgsql
volatile
parallel unsafe
security invoker
set search_path from current
as $kernel$
<<installer_app_base_continuation>>
declare
  app_id text := request->>'app_id';
  release_id text := request->>'release_id';
  base_artifact_hash text := request->>'base_artifact_hash';
  targets jsonb := request->'targets';
  target jsonb;
  current_base_count integer;
  incompatible_base_count integer;
  schema_revision_id bigint;
  customer_id text;
  effective_artifact_hash text;
  expected_hash text;
  prepared record;
  active record;
  seed_result jsonb;
  target_seed_change_sets jsonb;
  activated_targets jsonb := '[]'::jsonb;
  all_idempotent boolean := true;
begin
  if coalesce(app_id, '') = '' or coalesce(release_id, '') = ''
    or not kernel_installer_valid_hash(base_artifact_hash)
    or jsonb_typeof(targets) is distinct from 'array'
    or jsonb_array_length(targets) = 0
  then
    return kernel_installer_error('contract_validation_failed', 'Contract validation failed', 'request', 'invalid_app_base_continuation', 'app_id, current release, base hash, and at least one target are required');
  end if;
  if exists (
    select 1 from jsonb_array_elements(targets) as item(value)
    group by value->>'customer_id' having count(*) > 1
  ) then
    return kernel_installer_error('contract_validation_failed', 'Contract validation failed', 'targets', 'duplicate_target', 'customer targets must be unique');
  end if;

  perform kernel_installer_lock_app(installer_app_base_continuation.app_id, true);
  -- This election is app-wide metadata, so read it under the compiler-owned
  -- catalog policy and clear that capability before target-specific work.
  perform set_config('kernel.app_id', app_id, true);
  perform set_config('kernel.customer_id', '', true);
  perform set_config('kernel.schema_catalog_read', 'on', true);
  select count(*)::integer,
         count(*) filter (
           where sir.base_artifact_hash is distinct from installer_app_base_continuation.base_artifact_hash
             or sr.base_schema->>'version' is distinct from installer_app_base_continuation.release_id
         )::integer
  into current_base_count, incompatible_base_count
  from schema_revision sr
  left join schema_installation_revision sir on sir.schema_revision_id = sr.id
  where sr.app_id = installer_app_base_continuation.app_id
    and sr.activated_at is not null;
  perform set_config('kernel.schema_catalog_read', 'off', true);
  if current_base_count = 0 then
    return kernel_installer_error('schema_activation_conflict', 'Schema activation conflict', 'release_id', 'current_base_required', 'only an already-active app-base release can be continued to a new target');
  end if;
  if incompatible_base_count <> 0 then
    return kernel_installer_error('schema_activation_conflict', 'Schema activation conflict', 'release_id', 'different_base_requires_group_activation', 'a different active base must use grouped app-base activation');
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
    perform kernel_installer_lock_tenant(
      installer_app_base_continuation.app_id,
      installer_app_base_continuation.customer_id
    );
  end loop;

  -- Validate every selected target before any activation write. A selected target
  -- is either new (no active revision and null predecessor hash) or an exact
  -- replay of its already-active app-base revision.
  for target in
    select value from jsonb_array_elements(targets) as item(value)
    order by value->>'customer_id'
  loop
    schema_revision_id := (target->>'schema_revision_id')::bigint;
    customer_id := target->>'customer_id';
    effective_artifact_hash := target->>'effective_artifact_hash';
    expected_hash := target->>'expected_active_effective_hash';
    perform set_config('kernel.app_id', app_id, true);
    perform set_config('kernel.customer_id', customer_id, true);
    select sir.*, sr.activated_at
    into prepared
    from schema_installation_revision sir
    join schema_revision sr on sr.id = sir.schema_revision_id
    where sir.schema_revision_id = installer_app_base_continuation.schema_revision_id
      and sir.app_id = installer_app_base_continuation.app_id
      and sir.customer_id = installer_app_base_continuation.customer_id
    for update of sir, sr;
    if not found
      or prepared.release_id is distinct from release_id
      or prepared.activation_kind is distinct from 'app_base'
      or prepared.base_artifact_hash is distinct from base_artifact_hash
      or prepared.effective_artifact_hash is distinct from effective_artifact_hash
      or prepared.expected_active_effective_hash is distinct from expected_hash
    then
      return kernel_installer_error('schema_activation_conflict', 'Schema activation conflict', 'targets', 'prepared_target_mismatch', 'a requested target does not match the prepared current app-base release');
    end if;
    if prepared.ready_at is null then
      return kernel_installer_error('schema_revision_not_ready', 'Schema revision is not ready', 'targets.' || customer_id, 'readiness_required', 'every continuation target must pass readiness validation');
    end if;
    select sr.id, sir.activation_kind, sir.release_id,
           sir.base_artifact_hash, sir.effective_artifact_hash
    into active
    from schema_revision sr
    left join schema_installation_revision sir on sir.schema_revision_id = sr.id
    where sr.app_id = installer_app_base_continuation.app_id
      and sr.customer_id = installer_app_base_continuation.customer_id
      and sr.activated_at is not null
    for update of sr;
    if active.id is not null then
      if active.id is distinct from schema_revision_id
        or active.activation_kind is distinct from 'app_base'
        or active.release_id is distinct from release_id
        or active.base_artifact_hash is distinct from base_artifact_hash
        or active.effective_artifact_hash is distinct from effective_artifact_hash
      then
        return kernel_installer_error('schema_activation_conflict', 'Schema activation conflict', 'targets.' || customer_id, 'target_has_different_active_revision', 'continuation cannot replace an active revision or tenant overlay');
      end if;
    elsif expected_hash is not null then
      return kernel_installer_error('schema_activation_conflict', 'Schema activation conflict', 'targets.' || customer_id, 'expected_hash_mismatch', 'the target no longer has the active revision recorded at preparation');
    end if;
  end loop;

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
      select sr.activated_at, sr.base_schema->>'version' as base_schema_version
      into prepared
      from schema_revision sr
      where sr.id = installer_app_base_continuation.schema_revision_id
        and sr.app_id = installer_app_base_continuation.app_id
        and sr.customer_id = installer_app_base_continuation.customer_id
      for update;
      insert into schema_activation_head (app_id, customer_id, base_schema_version)
      values (
        installer_app_base_continuation.app_id,
        installer_app_base_continuation.customer_id,
        coalesce(prepared.base_schema_version, installer_app_base_continuation.release_id)
      )
      on conflict on constraint schema_activation_head_pkey do update
        set base_schema_version = excluded.base_schema_version, advanced_at = now();
      if prepared.activated_at is null then
        all_idempotent := false;
        update schema_revision as revision
        set activated_at = now()
        where revision.id = installer_app_base_continuation.schema_revision_id
          and revision.app_id = installer_app_base_continuation.app_id
          and revision.customer_id = installer_app_base_continuation.customer_id;
        update schema_installation_revision as installation
        set activated_at = now()
        where installation.schema_revision_id = installer_app_base_continuation.schema_revision_id
          and installation.app_id = installer_app_base_continuation.app_id
          and installation.customer_id = installer_app_base_continuation.customer_id;
        insert into lookup_storage_authority(
          app_id, customer_id, model_id, schema_hash, authority,
          legacy_record_table, legacy_version_table, activated_at
        )
        select sr.app_id, sr.customer_id, model.value->>'id', sr.schema_hash,
               'generic', 'lookup_record', 'lookup_version', now()
        from schema_revision sr
        cross join lateral jsonb_array_elements(sr.schema->'models') model(value)
        where sr.id = installer_app_base_continuation.schema_revision_id
          and model.value->>'kind' = 'lookup'
          and not kernel_lookup_has_typed_history(sr.app_id, sr.customer_id, model.value->>'id')
        on conflict on constraint lookup_storage_authority_pkey do nothing;
        perform kernel_reconcile_lookup_foreign_key_targets(
          installer_app_base_continuation.app_id,
          installer_app_base_continuation.customer_id
        );
        select sir.seed_change_sets into target_seed_change_sets
        from schema_installation_revision sir
        where sir.schema_revision_id = installer_app_base_continuation.schema_revision_id;
        if jsonb_array_length(target_seed_change_sets) > 0 then
          seed_result := kernel_apply_seed_defaults(jsonb_build_object(
            'app_id', app_id, 'customer_id', customer_id,
            'schema_revision_id', schema_revision_id,
            'change_sets', target_seed_change_sets
          ));
          if coalesce((seed_result->>'ok')::boolean, false) is not true then
            raise exception using errcode = 'P0001', message = 'kernel seed activation failed';
          end if;
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
    return kernel_installer_error('database_error', 'Database operation failed', 'activation', 'continuation_failed', 'app-base continuation was rolled back for every selected target');
  end;

  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'activation_kind', 'app_base', 'app_id', app_id, 'release_id', release_id,
    'base_artifact_hash', base_artifact_hash, 'targets', activated_targets,
    'state', 'active', 'idempotent', all_idempotent
  ));
end;
$kernel$;
