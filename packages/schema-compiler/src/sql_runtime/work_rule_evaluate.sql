-- A rule is a target field, an optional boolean condition and a value, both
-- derived expressions over the rule's model with named parameters. It is
-- evaluated by the ordinary authorized query over the session's overlay,
-- excluding the rule's own earlier outputs, and its results are staged with
-- the rule author's provenance. A null value or a false or null condition
-- produces no output. Returns {overlaps}: per other rule, the records whose
-- target field that rule already holds, so this rule skipped them.
create or replace function kernel_work_rule_evaluate(request jsonb, session jsonb, rule jsonb)
returns jsonb language plpgsql volatile security invoker set search_path from current as $kernel$
declare
  schema_json jsonb := kernel_read_scope_schema(request->>'app_id', request->>'customer_id');
  parameters jsonb := coalesce(rule->'parameters', '{}'::jsonb);
  environment jsonb;
  target jsonb;
  expression jsonb;
  expected text;
  path text;
  inferred jsonb;
  outputs jsonb;
  collisions jsonb;
begin
  if jsonb_typeof(rule) is distinct from 'object'
    or rule - array['id', 'description', 'model_id', 'field_id', 'condition', 'value', 'parameters', 'author_principal', 'author_kind'] <> '{}'::jsonb
    or not (rule ?& array['id', 'model_id', 'field_id', 'value'])
    or jsonb_typeof(parameters) is distinct from 'object'
    or not exists (select 1 from jsonb_array_elements(schema_json->'models') where value->>'id' = rule->>'model_id')
  then
    raise exception 'contract_validation_failed: invalid work rule';
  end if;
  environment := kernel_derived_environment(schema_json, rule->>'model_id');
  target := environment->(rule->>'field_id');
  if target is null or target ? 'expression' or target->>'type' not in ('text', 'number', 'bool', 'date', 'datetime', 'money_rate') then
    raise exception 'contract_validation_failed: invalid rule target';
  end if;
  -- Parameter values are typed like field values (the shared field-value
  -- checks, including ISO currency codes), with canonical decimals.
  if exists (
    select 1 from jsonb_each(parameters) p
    where p.key !~ '^[A-Za-z_][A-Za-z0-9_]*$'
      or p.value->>'type' is null
      or p.value->>'type' not in ('text', 'number', 'bool', 'date', 'datetime', 'money_rate')
      or kernel_apply_field_value_issue(p.value->>'type', null, p.value) is not null
      or (p.value->>'type' = 'number' and p.value->>'value' !~ '^-?[0-9]+([.][0-9]+)?$')
      or (p.value->>'type' = 'money_rate' and (p.value#>>'{value,amount}' !~ '^-?[0-9]+([.][0-9]+)?$'
        or p.value#>>'{value,currency}' !~ '^[A-Z]{3}$'))
  ) then
    raise exception 'contract_validation_failed: invalid rule parameter';
  end if;
  environment := environment || jsonb_build_object('$parameters', parameters);
  for expression, expected, path in
    select rule->'value', target->>'type', 'rule.value'
    union all select rule->'condition', 'bool', 'rule.condition' where rule ? 'condition'
  loop
    inferred := kernel_derived_infer(expression, environment, '[]'::jsonb, 1, 0);
    if inferred ? 'code' or inferred->>'type' is distinct from expected then
      raise exception using errcode = 'AR001', message = jsonb_build_object('ok', false, 'error', jsonb_build_object(
        'code', 'contract_validation_failed', 'message', 'Invalid work rule', 'details', jsonb_build_array(jsonb_build_object(
          'path', path, 'code', coalesce(inferred->>'code', 'type_mismatch'),
          'message', coalesce(inferred->>'message', format('expression type `%s` does not match `%s`', inferred->>'type', expected))))))::text;
    end if;
  end loop;
  select coalesce(jsonb_agg(jsonb_build_object(
      'model_id', rule->'model_id', 'record_id', image->'record_id', 'field_id', rule->'field_id',
      'value', jsonb_build_object('type', target->>'type', 'value', computed.value))), '[]'::jsonb)
  into outputs
  from jsonb_array_elements(kernel_data_query_scan(
    jsonb_build_object('app_id', request->'app_id', 'customer_id', request->'customer_id',
      'schema_version', request->'schema_version', 'as_of', session->'as_of',
      'model_id', rule->'model_id', 'kind', 'list', 'select', jsonb_build_array('$id')),
    jsonb_build_object('session_id', session->'id', 'exclude_rule_id', rule->'id', 'rule', rule)
  )) image
  cross join lateral (
    select
      (select e->'value' from jsonb_array_elements(image->'custom_fields') e where e->>'field_id' = '$rule_value') value,
      (select e->'value' from jsonb_array_elements(image->'custom_fields') e where e->>'field_id' = '$rule_condition') condition
  ) computed
  where computed.value is not null and (not rule ? 'condition' or computed.condition = 'true'::jsonb);
  -- Only cells that actually collided are reported; the first rule keeps them.
  select coalesce(jsonb_agg(jsonb_build_object('rule_id', held.rule_id, 'records', held.records) order by held.rule_id), '[]')
  into collisions
  from (
    select w.rule_id, count(*) records
    from jsonb_array_elements(outputs) o
    join work_session_record w
      on w.app_id = request->>'app_id' and w.customer_id = request->>'customer_id'
      and w.session_id = (session->>'id')::uuid and w.model_id = o->>'model_id'
      and w.record_id = (o->>'record_id')::uuid and w.field_id = o->>'field_id'
    where w.rule_id <> rule->>'id'
    group by w.rule_id
  ) held;
  perform kernel_work_stage(request, session, outputs, jsonb_build_object(
    'source', case when rule->>'author_kind' = 'agent' then 'agent' else 'user' end,
    'actor_id', session->>'owner_id', 'author_principal', rule->>'author_principal',
    'author_kind', rule->>'author_kind', 'rule_id', rule->>'id',
    -- An agent-owned rule restaged by its agent moves its outputs to the
    -- current turn; a human's evaluation leaves them without a turn.
    'turn_id', case when rule->>'author_kind' = 'agent' then kernel_request_turn_id() end), true);
  return jsonb_build_object('overlaps', collisions);
end $kernel$;
