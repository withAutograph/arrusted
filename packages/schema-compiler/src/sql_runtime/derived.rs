//! Derived-expression validation and lowering for the generated runtime.
//!
//! Derived custom-field definitions carry the compiler's `DerivedExpr` AST.
//! These functions infer and check its types against the active schema and
//! lower it to SQL over one read image. The rules mirror
//! `DerivedScope::infer` in the compiler; parity tests run the same fixture
//! set through both. Working-session rules use the same AST, inference and
//! lowering, adding `$parameters` to the environment; derived fields have no
//! parameters and reject them.

use super::RuntimeSqlFunction;

pub(super) fn functions() -> Vec<RuntimeSqlFunction> {
    [
        (
            "kernel_active_custom_fields(jsonb,text)",
            ACTIVE_CUSTOM_FIELDS,
        ),
        ("kernel_derived_divide(numeric,numeric)", DERIVED_DIVIDE),
        (
            "kernel_derived_compare(jsonb,jsonb,text,text)",
            DERIVED_COMPARE,
        ),
        ("kernel_derived_money(numeric,text,text)", DERIVED_MONEY),
        (
            "kernel_derived_money_combine(jsonb,jsonb,integer)",
            DERIVED_MONEY_COMBINE,
        ),
        (
            "kernel_derived_money_ratio(jsonb,jsonb)",
            DERIVED_MONEY_RATIO,
        ),
        (
            "kernel_derived_money_scale(jsonb,numeric,boolean)",
            DERIVED_MONEY_SCALE,
        ),
        (
            "kernel_derived_money_normalize(jsonb,text)",
            DERIVED_MONEY_NORMALIZE,
        ),
        (
            "kernel_derived_bound(numeric,numeric,boolean)",
            DERIVED_BOUND,
        ),
        (
            "kernel_derived_money_bound(jsonb,jsonb,boolean)",
            DERIVED_MONEY_BOUND,
        ),
        (
            "kernel_derived_environment(jsonb,text)",
            DERIVED_ENVIRONMENT,
        ),
        (
            "kernel_derived_infer(jsonb,jsonb,jsonb,integer,integer)",
            DERIVED_INFER,
        ),
        (
            "kernel_derived_issues(jsonb,text,jsonb,text,text)",
            DERIVED_ISSUES,
        ),
        (
            "kernel_derived_typed_sql(jsonb,jsonb,text,text,text,jsonb)",
            DERIVED_TYPED_SQL,
        ),
        (
            "kernel_derived_value_sql(jsonb,jsonb,text,text,text)",
            DERIVED_VALUE_SQL,
        ),
        (
            "kernel_derived_references(jsonb,jsonb,jsonb)",
            DERIVED_REFERENCES,
        ),
        ("kernel_derived_entry(text,text,jsonb)", DERIVED_ENTRY),
        ("kernel_derived_schema_issues(jsonb)", DERIVED_SCHEMA_ISSUES),
    ]
    .into_iter()
    .map(|(signature, sql)| RuntimeSqlFunction {
        signature,
        sql: sql.trim().to_string(),
    })
    .collect()
}

// Active custom field definitions of one model, shaped like declared fields
// (`id` is the field id). Every runtime path that resolves custom fields uses
// this one effective-lifecycle rule. A definition that reuses any declared
// field or many-relation id of the model, retired ones included, is left out,
// so a custom definition can never stand in for a declared element.
const ACTIVE_CUSTOM_FIELDS: &str = r#"
create or replace function kernel_active_custom_fields(schema_json jsonb, model_id text)
returns jsonb
language sql
immutable
parallel safe
security invoker
set search_path from current
as $kernel$
  select coalesce(jsonb_agg(
    custom.value || jsonb_build_object('id', custom.value->>'field_id', 'custom', true)
    order by custom.ordinal
  ), '[]'::jsonb)
  from jsonb_array_elements(coalesce(schema_json->'custom_fields', '[]'::jsonb)) with ordinality custom(value, ordinal)
  where custom.value->>'model_id' = model_id
    and coalesce(custom.value->>'lifecycle', 'active') = 'active'
    and coalesce(custom.value->'archived_at', 'null'::jsonb) = 'null'::jsonb
    and not exists (
      select 1
      from jsonb_array_elements(coalesce(schema_json->'models', '[]'::jsonb)) model(value)
      cross join jsonb_array_elements(
        coalesce(model.value->'fields', '[]'::jsonb) || coalesce(model.value->'many_relations', '[]'::jsonb)
      ) declared(value)
      where model.value->>'id' = model_id and declared.value->>'id' = custom.value->>'field_id'
    )
$kernel$
"#;

// Exact when the quotient terminates; otherwise 28 significant digits rounded
// half-even. Division by zero is null. This is the repository's decimal
// division rule (see the currency engine) and the TypeScript evaluator's.
const DERIVED_DIVIDE: &str = r#"
create or replace function kernel_derived_divide(dividend numeric, divisor numeric)
returns numeric
language plpgsql
immutable
strict
parallel safe
security invoker
set search_path from current
as $kernel$
declare
  numerator numeric;
  denominator numeric;
  common numeric;
  residual numeric;
  twos integer := 0;
  fives integer := 0;
  exponent integer;
  result_scale integer;
  quotient numeric;
  twice_remainder numeric;
begin
  if divisor = 0 then return null; end if;
  if dividend = 0 then return 0; end if;
  numerator := trunc(abs(dividend) * ('1e' || (scale(dividend) + scale(divisor)))::numeric);
  denominator := trunc(abs(divisor) * ('1e' || (scale(dividend) + scale(divisor)))::numeric);
  common := gcd(numerator, denominator);
  numerator := div(numerator, common);
  denominator := div(denominator, common);
  residual := denominator;
  while mod(residual, 2) = 0 loop residual := div(residual, 2); twos := twos + 1; end loop;
  while mod(residual, 5) = 0 loop residual := div(residual, 5); fives := fives + 1; end loop;
  if residual = 1 then
    result_scale := greatest(twos, fives);
    quotient := numerator * power(2::numeric, result_scale - twos) * power(5::numeric, result_scale - fives);
  else
    exponent := length(numerator::text) - length(denominator::text);
    if (exponent >= 0 and numerator < denominator * ('1e' || exponent)::numeric)
      or (exponent < 0 and numerator * ('1e' || (-exponent))::numeric < denominator) then
      exponent := exponent - 1;
    end if;
    result_scale := 27 - exponent;
    if result_scale >= 0 then
      numerator := numerator * ('1e' || result_scale)::numeric;
    else
      denominator := denominator * ('1e' || (-result_scale))::numeric;
    end if;
    quotient := div(numerator, denominator);
    twice_remainder := 2 * mod(numerator, denominator);
    if twice_remainder > denominator or (twice_remainder = denominator and mod(quotient, 2) <> 0) then
      quotient := quotient + 1;
    end if;
  end if;
  quotient := (trunc(quotient)::text || 'e' || (-result_scale))::numeric;
  return case when (dividend < 0) <> (divisor < 0) then -quotient else quotient end;
end;
$kernel$
"#;

const DERIVED_MONEY: &str = r#"
create or replace function kernel_derived_money(amount numeric, currency text, period text)
returns jsonb
language sql
immutable
parallel safe
security invoker
set search_path from current
as $kernel$
  select case when amount is null then null else jsonb_build_object(
    'amount', trim_scale(amount)::text, 'currency', currency, 'period', period
  ) end
$kernel$
"#;

// Money adds only within one currency and period; a unit mismatch is null.
const DERIVED_MONEY_COMBINE: &str = r#"
create or replace function kernel_derived_money_combine(left_value jsonb, right_value jsonb, sign integer)
returns jsonb
language sql
immutable
parallel safe
security invoker
set search_path from current
as $kernel$
  select case
    when left_value is null or right_value is null
      or left_value->>'currency' is distinct from right_value->>'currency'
      or left_value->>'period' is distinct from right_value->>'period'
      then null
    else kernel_derived_money(
      (left_value->>'amount')::numeric + sign * (right_value->>'amount')::numeric,
      left_value->>'currency', left_value->>'period'
    )
  end
$kernel$
"#;

const DERIVED_MONEY_RATIO: &str = r#"
create or replace function kernel_derived_money_ratio(dividend jsonb, divisor jsonb)
returns numeric
language sql
immutable
parallel safe
security invoker
set search_path from current
as $kernel$
  select case when dividend is null or divisor is null
      or dividend->>'currency' is distinct from divisor->>'currency'
      or dividend->>'period' is distinct from divisor->>'period' then null
    else kernel_derived_divide((dividend->>'amount')::numeric, (divisor->>'amount')::numeric) end
$kernel$
"#;

const DERIVED_MONEY_SCALE: &str = r#"
create or replace function kernel_derived_money_scale(money_value jsonb, factor numeric, divide boolean)
returns jsonb
language sql
immutable
parallel safe
security invoker
set search_path from current
as $kernel$
  select case when money_value is null or factor is null then null else kernel_derived_money(
    case when divide then kernel_derived_divide((money_value->>'amount')::numeric, factor)
      else (money_value->>'amount')::numeric * factor end,
    money_value->>'currency', money_value->>'period'
  ) end
$kernel$
"#;

// min (greatest = false) or max of two numbers; null when either is null.
const DERIVED_BOUND: &str = r#"
create or replace function kernel_derived_bound(left_value numeric, right_value numeric, greatest_value boolean)
returns numeric
language sql
immutable
strict
parallel safe
security invoker
set search_path from current
as $kernel$
  select case when greatest_value then greatest(left_value, right_value) else least(left_value, right_value) end
$kernel$
"#;

// min or max of two money values of one unit; a unit mismatch is null.
const DERIVED_MONEY_BOUND: &str = r#"
create or replace function kernel_derived_money_bound(left_value jsonb, right_value jsonb, greatest_value boolean)
returns jsonb
language sql
immutable
parallel safe
security invoker
set search_path from current
as $kernel$
  select case
    when left_value is null or right_value is null
      or left_value->>'currency' is distinct from right_value->>'currency'
      or left_value->>'period' is distinct from right_value->>'period'
      then null
    else kernel_derived_money(
      kernel_derived_bound((left_value->>'amount')::numeric, (right_value->>'amount')::numeric, greatest_value),
      left_value->>'currency', left_value->>'period'
    )
  end
$kernel$
"#;

// Comparison of two non-number values of one type. Money compares amounts
// within one currency and period; a unit mismatch or a null operand is null.
const DERIVED_COMPARE: &str = r#"
create or replace function kernel_derived_compare(left_value jsonb, right_value jsonb, op text, value_type text)
returns boolean
language plpgsql
immutable
parallel safe
security invoker
set search_path from current
as $kernel$
declare
  difference integer;
begin
  if left_value is null or right_value is null then return null; end if;
  if value_type = 'money_rate' then
    if left_value->>'currency' is distinct from right_value->>'currency'
      or left_value->>'period' is distinct from right_value->>'period' then
      return null;
    end if;
    difference := sign((left_value->>'amount')::numeric - (right_value->>'amount')::numeric);
  elsif value_type = 'date' then
    difference := sign((left_value#>>'{}')::date - (right_value#>>'{}')::date);
  elsif value_type = 'datetime' then
    difference := case when (left_value#>>'{}')::timestamptz < (right_value#>>'{}')::timestamptz then -1
      when (left_value#>>'{}')::timestamptz > (right_value#>>'{}')::timestamptz then 1 else 0 end;
  else
    difference := case when left_value = right_value then 0 else 1 end;
  end if;
  return case op
    when 'eq' then difference = 0 when 'not_eq' then difference <> 0
    when 'lt' then difference < 0 when 'lte' then difference <= 0
    when 'gt' then difference > 0 else difference >= 0 end;
end;
$kernel$
"#;

// Periods per year: 2080 working hours, 260 working days, 52 weeks, 12 months.
const DERIVED_MONEY_NORMALIZE: &str = r#"
create or replace function kernel_derived_money_normalize(money_value jsonb, target_period text)
returns jsonb
language sql
immutable
parallel safe
security invoker
set search_path from current
as $kernel$
  with factor(period, per_year) as (
    values ('hourly', 2080::numeric), ('daily', 260), ('weekly', 52), ('monthly', 12), ('annual', 1)
  )
  select case when money_value is null then null else kernel_derived_money(
    kernel_derived_divide(
      (money_value->>'amount')::numeric * (select per_year from factor where period = money_value->>'period'),
      (select per_year from factor where period = target_period)
    ),
    money_value->>'currency', target_period
  ) end
$kernel$
"#;

// Fields a derived expression on `model_id` may reference: active declared
// fields and active custom fields (stored or derived) of the same model. A
// declared relation also lists the active stored fields of its target model,
// which `relation_field` may read. Custom fields come from
// kernel_active_custom_fields, so a declared id always means the declared field.
const DERIVED_ENVIRONMENT: &str = r#"
create or replace function kernel_derived_environment(schema_json jsonb, model_id text)
returns jsonb
language sql
immutable
parallel safe
security invoker
set search_path from current
as $kernel$
  select coalesce((
    select jsonb_object_agg(field.value->>'id', jsonb_strip_nulls(jsonb_build_object(
      'type', field.value->>'type', 'source', 'base', 'target_model', field.value->>'target_model',
      'target_fields', case when field.value->>'type' = 'relation' then (
        select coalesce(jsonb_object_agg(target_field.value->>'id', target_field.value->>'type'), '{}'::jsonb)
        from jsonb_array_elements(coalesce(schema_json->'models', '[]'::jsonb)) target(value)
        cross join jsonb_array_elements(
          coalesce(target.value->'fields', '[]'::jsonb) || kernel_active_custom_fields(schema_json, target.value->>'id')
        ) target_field(value)
        where target.value->>'id' = field.value->>'target_model'
          and coalesce(target_field.value->>'lifecycle', 'active') = 'active'
          and coalesce(target_field.value->'expression', 'null'::jsonb) = 'null'::jsonb
      ) end
    )))
    from jsonb_array_elements(coalesce(schema_json->'models', '[]'::jsonb)) model(value)
    cross join jsonb_array_elements(coalesce(model.value->'fields', '[]'::jsonb)) field(value)
    where model.value->>'id' = model_id and coalesce(field.value->>'lifecycle', 'active') = 'active'
  ), '{}'::jsonb) || coalesce((
    select jsonb_object_agg(custom.value->>'id', jsonb_strip_nulls(jsonb_build_object(
      'type', custom.value->>'type', 'source', 'custom',
      'expression', nullif(custom.value->'expression', 'null'::jsonb)
    )))
    from jsonb_array_elements(kernel_active_custom_fields(schema_json, model_id)) custom(value)
  ), '{}'::jsonb)
$kernel$
"#;

// Returns {"type", "nodes"} or {"code", "message"}. Referenced derived fields
// are expanded; `visiting` holds the derived fields on the current path.
const DERIVED_INFER: &str = r#"
create or replace function kernel_derived_infer(
  expression jsonb,
  environment jsonb,
  visiting jsonb,
  depth integer,
  nodes integer
)
returns jsonb
language plpgsql
immutable
parallel safe
security invoker
set search_path from current
as $kernel$
declare
  node_type text;
  target jsonb;
  item jsonb;
  result jsonb;
  left_type text;
  right_type text;
  expected text;
  literal jsonb;
  invalid constant jsonb := jsonb_build_object('code', 'invalid_derived_expression', 'message', 'derived expression node is malformed');
begin
  nodes := nodes + 1;
  if nodes > 256 or depth > 32 then
    return jsonb_build_object('code', 'derived_expression_too_large', 'message',
      'derived expressions are limited to 256 nodes and depth 32 after expanding referenced derived fields');
  end if;
  if jsonb_typeof(expression) is distinct from 'object' or jsonb_typeof(expression->'type') is distinct from 'string' then
    return invalid;
  end if;
  node_type := expression->>'type';
  if node_type = 'field' then
    if expression - array['type', 'field'] <> '{}'::jsonb or jsonb_typeof(expression->'field') is distinct from 'string' then
      return invalid;
    end if;
    target := environment->(expression->>'field');
    if target is null then
      return jsonb_build_object('code', 'unknown_field', 'message', format('field `%s` is not an active field on the model', expression->>'field'));
    end if;
    if not target ? 'expression' then
      return jsonb_build_object('type', target->>'type', 'nodes', nodes);
    end if;
    if visiting ? (expression->>'field') then
      return jsonb_build_object('code', 'derived_cycle', 'message', format('derived field `%s` references itself', expression->>'field'));
    end if;
    return kernel_derived_infer(target->'expression', environment, visiting || jsonb_build_array(expression->>'field'), depth + 1, nodes);
  elsif node_type = 'literal' then
    literal := expression->'value';
    if expression - array['type', 'value'] <> '{}'::jsonb or jsonb_typeof(literal) is distinct from 'object'
      or jsonb_typeof(literal->'type') is distinct from 'string' or not literal ? 'value' or literal - array['type', 'value'] <> '{}'::jsonb then
      return invalid;
    end if;
    if literal->>'type' in ('enum', 'iso_country', 'iso_currency') then
      return jsonb_build_object('code', 'unsupported_derived_type', 'message', 'derived literals are text, number, bool, date, or datetime');
    end if;
    if literal->>'type' not in ('text', 'number', 'bool', 'date', 'datetime') then
      return invalid;
    end if;
    if not kernel_apply_typed_value_valid(literal, literal->>'type')
      or (literal->>'type' = 'number' and (literal->>'value' !~ '^-?[0-9]+([.][0-9]+)?$'
        or ltrim(replace(literal->>'value', '.', ''), '-')::numeric > 79228162514264337593543950335))
      -- Clock ranges the compiler also accepts: hour 00-23 (PostgreSQL alone
      -- would take 24:00:00); seconds up to 60 and offsets up to 15:59.
      or (literal->>'type' = 'datetime' and substr(literal->>'value', 12, 2)::integer > 23) then
      return jsonb_build_object('code', 'type_mismatch', 'message', 'derived literal value is invalid');
    end if;
    return jsonb_build_object('type', literal->>'type', 'nodes', nodes);
  elsif node_type in ('coalesce', 'concat') then
    if expression - array['type', 'expressions'] <> '{}'::jsonb or jsonb_typeof(expression->'expressions') is distinct from 'array' then
      return invalid;
    end if;
    if jsonb_array_length(expression->'expressions') = 0 then
      return jsonb_build_object('code', 'empty_derived_expression', 'message', format('%s must contain at least one expression', node_type));
    end if;
    expected := case when node_type = 'concat' then 'text' end;
    for item in select value from jsonb_array_elements(expression->'expressions') loop
      result := kernel_derived_infer(item, environment, visiting, depth + 1, nodes);
      if result ? 'code' then return result; end if;
      nodes := (result->>'nodes')::integer;
      if expected is null then
        expected := result->>'type';
      elsif result->>'type' <> expected then
        return jsonb_build_object('code', 'type_mismatch', 'message',
          case when node_type = 'concat' then 'concat expressions must be text' else 'coalesce expressions must have one type' end);
      end if;
    end loop;
    return jsonb_build_object('type', expected, 'nodes', nodes);
  elsif node_type in ('add', 'subtract', 'multiply', 'divide') then
    if expression - array['type', 'left', 'right'] <> '{}'::jsonb or not expression ?& array['left', 'right'] then
      return invalid;
    end if;
    result := kernel_derived_infer(expression->'left', environment, visiting, depth + 1, nodes);
    if result ? 'code' then return result; end if;
    left_type := result->>'type';
    result := kernel_derived_infer(expression->'right', environment, visiting, depth + 1, (result->>'nodes')::integer);
    if result ? 'code' then return result; end if;
    right_type := result->>'type';
    nodes := (result->>'nodes')::integer;
    if node_type in ('add', 'subtract') then
      if left_type = right_type and left_type in ('number', 'money_rate') then
        return jsonb_build_object('type', left_type, 'nodes', nodes);
      end if;
      return jsonb_build_object('code', 'type_mismatch', 'message', 'add/subtract requires matching number or money_rate operands');
    end if;
    -- A ratio of two amounts of one unit is a number (null on a unit mismatch).
    if (left_type = 'number' and right_type = 'number')
      or (node_type = 'divide' and left_type = 'money_rate' and right_type = 'money_rate') then
      return jsonb_build_object('type', 'number', 'nodes', nodes);
    end if;
    if (node_type = 'multiply' and ((left_type = 'money_rate' and right_type = 'number') or (left_type = 'number' and right_type = 'money_rate')))
      or (node_type = 'divide' and left_type = 'money_rate' and right_type = 'number') then
      return jsonb_build_object('type', 'money_rate', 'nodes', nodes);
    end if;
    return jsonb_build_object('code', 'type_mismatch', 'message', 'multiply/divide operands are not a supported number or money_rate combination');
  elsif node_type = 'normalize_money_rate' then
    if expression - array['type', 'expression', 'period'] <> '{}'::jsonb or not expression ? 'expression'
      or expression->>'period' is null or expression->>'period' not in ('hourly', 'daily', 'weekly', 'monthly', 'annual') then
      return invalid;
    end if;
    result := kernel_derived_infer(expression->'expression', environment, visiting, depth + 1, nodes);
    if result ? 'code' then return result; end if;
    if result->>'type' <> 'money_rate' then
      return jsonb_build_object('code', 'type_mismatch', 'message', 'normalize_money_rate requires money_rate input');
    end if;
    return result;
  elsif node_type = 'relation_field' then
    if expression - array['type', 'relation', 'field'] <> '{}'::jsonb
      or jsonb_typeof(expression->'relation') is distinct from 'string'
      or jsonb_typeof(expression->'field') is distinct from 'string' then
      return invalid;
    end if;
    target := environment->(expression->>'relation');
    if target->>'type' is distinct from 'relation' or not target ? 'target_fields' then
      return jsonb_build_object('code', 'unknown_field', 'message',
        format('`%s` is not an active relation field on the model', expression->>'relation'));
    end if;
    if not target->'target_fields' ? (expression->>'field') then
      return jsonb_build_object('code', 'unknown_field', 'message',
        format('field `%s` is not an active stored field on the related model', expression->>'field'));
    end if;
    return jsonb_build_object('type', target->'target_fields'->>(expression->>'field'), 'nodes', nodes);
  elsif node_type = 'parameter' then
    if expression - array['type', 'parameter'] <> '{}'::jsonb or jsonb_typeof(expression->'parameter') is distinct from 'string' then
      return invalid;
    end if;
    if not environment ? '$parameters' then
      return jsonb_build_object('code', 'unsupported_derived_expression', 'message',
        'parameters are valid only in working-session rules');
    end if;
    target := environment->'$parameters'->(expression->>'parameter');
    if target is null then
      return jsonb_build_object('code', 'unknown_parameter', 'message', format('parameter `%s` has no value', expression->>'parameter'));
    end if;
    return jsonb_build_object('type', target->>'type', 'nodes', nodes);
  elsif node_type = 'compare' then
    if expression - array['type', 'op', 'left', 'right'] <> '{}'::jsonb or not expression ?& array['left', 'right']
      or expression->>'op' is null or expression->>'op' not in ('eq', 'not_eq', 'lt', 'lte', 'gt', 'gte') then
      return invalid;
    end if;
    result := kernel_derived_infer(expression->'left', environment, visiting, depth + 1, nodes);
    if result ? 'code' then return result; end if;
    left_type := result->>'type';
    result := kernel_derived_infer(expression->'right', environment, visiting, depth + 1, (result->>'nodes')::integer);
    if result ? 'code' then return result; end if;
    if left_type <> result->>'type' or left_type not in ('text', 'number', 'bool', 'date', 'datetime', 'money_rate')
      or (expression->>'op' not in ('eq', 'not_eq') and left_type not in ('number', 'date', 'datetime', 'money_rate')) then
      return jsonb_build_object('code', 'type_mismatch', 'message', 'compare requires matching comparable operands');
    end if;
    return jsonb_build_object('type', 'bool', 'nodes', result->'nodes');
  elsif node_type = 'if' then
    if expression - array['type', 'condition', 'then', 'else'] <> '{}'::jsonb or not expression ?& array['condition', 'then', 'else'] then
      return invalid;
    end if;
    result := kernel_derived_infer(expression->'condition', environment, visiting, depth + 1, nodes);
    if result ? 'code' then return result; end if;
    if result->>'type' <> 'bool' then
      return jsonb_build_object('code', 'type_mismatch', 'message', 'if condition must be bool');
    end if;
    result := kernel_derived_infer(expression->'then', environment, visiting, depth + 1, (result->>'nodes')::integer);
    if result ? 'code' then return result; end if;
    left_type := result->>'type';
    result := kernel_derived_infer(expression->'else', environment, visiting, depth + 1, (result->>'nodes')::integer);
    if result ? 'code' then return result; end if;
    if result->>'type' <> left_type then
      return jsonb_build_object('code', 'type_mismatch', 'message', 'if branches must have one type');
    end if;
    return result;
  elsif node_type in ('min', 'max', 'clamp') then
    if (node_type = 'clamp' and (expression - array['type', 'expression', 'min', 'max'] <> '{}'::jsonb or not expression ?& array['expression', 'min', 'max']))
      or (node_type <> 'clamp' and (expression - array['type', 'left', 'right'] <> '{}'::jsonb or not expression ?& array['left', 'right'])) then
      return invalid;
    end if;
    for item in select operand.value from jsonb_array_elements(case when node_type = 'clamp'
      then jsonb_build_array(expression->'expression', expression->'min', expression->'max')
      else jsonb_build_array(expression->'left', expression->'right') end) operand(value) loop
      result := kernel_derived_infer(item, environment, visiting, depth + 1, nodes);
      if result ? 'code' then return result; end if;
      nodes := (result->>'nodes')::integer;
      if (expected is not null and result->>'type' <> expected) or result->>'type' not in ('number', 'money_rate') then
        return jsonb_build_object('code', 'type_mismatch', 'message',
          format('%s requires matching number or money_rate operands', case when node_type = 'clamp' then 'clamp' else 'min/max' end));
      end if;
      expected := result->>'type';
    end loop;
    return jsonb_build_object('type', expected, 'nodes', nodes);
  elsif node_type = 'inverse_aggregate' then
    return jsonb_build_object('code', 'unsupported_derived_expression', 'message',
      'inverse_aggregate is not evaluated by the SQL runtime');
  end if;
  return jsonb_build_object('code', 'unsupported_derived_expression', 'message', format('derived expression type `%s` is not supported', node_type));
end;
$kernel$
"#;

// Issues for one derived definition: the expression must type-check against
// the environment and evaluate to the declared, supported type.
const DERIVED_ISSUES: &str = r#"
create or replace function kernel_derived_issues(
  environment jsonb,
  field_id text,
  expression jsonb,
  declared_type text,
  path text
)
returns jsonb
language plpgsql
immutable
parallel safe
security invoker
set search_path from current
as $kernel$
declare
  result jsonb;
begin
  if declared_type is null or declared_type not in ('text', 'number', 'bool', 'date', 'datetime', 'money_rate') then
    return jsonb_build_array(jsonb_build_object('path', path || '.type', 'code', 'unsupported_derived_type',
      'message', 'derived fields evaluate to text, number, bool, date, datetime, or money_rate'));
  end if;
  result := kernel_derived_infer(expression, environment, jsonb_build_array(field_id), 1, 0);
  if result ? 'code' then
    return jsonb_build_array(jsonb_build_object('path', path || '.expression', 'code', result->>'code', 'message', result->>'message'));
  end if;
  if result->>'type' not in ('text', 'number', 'bool', 'date', 'datetime', 'money_rate') then
    return jsonb_build_array(jsonb_build_object('path', path || '.type', 'code', 'unsupported_derived_type',
      'message', 'derived fields evaluate to text, number, bool, date, datetime, or money_rate'));
  end if;
  if result->>'type' <> declared_type then
    return jsonb_build_array(jsonb_build_object('path', path || '.type', 'code', 'type_mismatch',
      'message', format('declared type `%s` does not match expression type `%s`', declared_type, result->>'type')));
  end if;
  return '[]'::jsonb;
end;
$kernel$
"#;

// Lowers a validated expression to {"type", "sql"}. Number SQL is numeric;
// money SQL is a {amount, currency, period} jsonb value; other types are jsonb
// scalars. Base and custom accessors are format() templates taking a field id.
// The relation accessor takes a lookup identifier, the relation id and the
// related field id, and yields that field's value on the related record.
// `visiting` holds the derived fields on the current path, so a stored cycle
// fails as schema drift instead of recursing without bound.
const DERIVED_TYPED_SQL: &str = r#"
create or replace function kernel_derived_typed_sql(
  expression jsonb,
  environment jsonb,
  base_accessor text,
  custom_accessor text,
  relation_accessor text,
  visiting jsonb
)
returns jsonb
language plpgsql
immutable
parallel safe
security invoker
set search_path from current
as $kernel$
declare
  node_type text := expression->>'type';
  target jsonb;
  accessor text;
  left_sql jsonb;
  right_sql jsonb;
  parts text[] := array[]::text[];
  result_type text;
  item jsonb;
  lowered jsonb;
  condition_sql jsonb;
begin
  if node_type = 'field' then
    target := environment->(expression->>'field');
    if target is null then
      raise exception 'schema_drift: derived field references an inactive field';
    end if;
    if target ? 'expression' then
      if visiting ? (expression->>'field') then
        raise exception 'schema_drift: derived field references itself';
      end if;
      return kernel_derived_typed_sql(target->'expression', environment, base_accessor, custom_accessor, relation_accessor,
        visiting || jsonb_build_array(expression->>'field'));
    end if;
    result_type := target->>'type';
    accessor := format('nullif(%s,''null''::jsonb)',
      format(case when target->>'source' = 'base' then base_accessor else custom_accessor end, expression->>'field'));
  elsif node_type = 'literal' then
    return jsonb_build_object('type', expression#>>'{value,type}', 'sql',
      case when expression#>>'{value,type}' = 'number' then format('%L::numeric', expression#>>'{value,value}')
        else format('%L::jsonb', expression#>'{value,value}') end);
  elsif node_type in ('coalesce', 'concat') then
    for item in select value from jsonb_array_elements(expression->'expressions') loop
      lowered := kernel_derived_typed_sql(item, environment, base_accessor, custom_accessor, relation_accessor, visiting);
      result_type := lowered->>'type';
      parts := parts || case when node_type = 'concat' then format('(%s#>>''{}'')', lowered->>'sql') else lowered->>'sql' end;
    end loop;
    if node_type = 'concat' then
      return jsonb_build_object('type', 'text', 'sql', format('to_jsonb(%s)', array_to_string(parts, '||')));
    end if;
    return jsonb_build_object('type', result_type, 'sql', format('coalesce(%s)', array_to_string(parts, ',')));
  elsif node_type in ('add', 'subtract', 'multiply', 'divide') then
    left_sql := kernel_derived_typed_sql(expression->'left', environment, base_accessor, custom_accessor, relation_accessor, visiting);
    right_sql := kernel_derived_typed_sql(expression->'right', environment, base_accessor, custom_accessor, relation_accessor, visiting);
    if left_sql->>'type' = 'number' and right_sql->>'type' = 'number' then
      return jsonb_build_object('type', 'number', 'sql', case node_type
        when 'add' then format('(%s+%s)', left_sql->>'sql', right_sql->>'sql')
        when 'subtract' then format('(%s-%s)', left_sql->>'sql', right_sql->>'sql')
        when 'multiply' then format('(%s*%s)', left_sql->>'sql', right_sql->>'sql')
        else format('kernel_derived_divide(%s,%s)', left_sql->>'sql', right_sql->>'sql') end);
    end if;
    if node_type = 'divide' and left_sql->>'type' = 'money_rate' and right_sql->>'type' = 'money_rate' then
      return jsonb_build_object('type', 'number', 'sql', format('kernel_derived_money_ratio(%s,%s)', left_sql->>'sql', right_sql->>'sql'));
    end if;
    return jsonb_build_object('type', 'money_rate', 'sql', case
      when node_type in ('add', 'subtract') then format('kernel_derived_money_combine(%s,%s,%s)', left_sql->>'sql', right_sql->>'sql', case when node_type = 'add' then 1 else -1 end)
      when left_sql->>'type' = 'money_rate' then format('kernel_derived_money_scale(%s,%s,%L)', left_sql->>'sql', right_sql->>'sql', node_type = 'divide')
      else format('kernel_derived_money_scale(%s,%s,false)', right_sql->>'sql', left_sql->>'sql') end);
  elsif node_type = 'normalize_money_rate' then
    lowered := kernel_derived_typed_sql(expression->'expression', environment, base_accessor, custom_accessor, relation_accessor, visiting);
    return jsonb_build_object('type', 'money_rate', 'sql',
      format('kernel_derived_money_normalize(%s,%L)', lowered->>'sql', expression->>'period'));
  elsif node_type = 'relation_field' then
    if relation_accessor is null then
      raise exception 'contract_validation_failed: relation_field is not available here';
    end if;
    result_type := environment->(expression->>'relation')->'target_fields'->>(expression->>'field');
    accessor := format('nullif(%s,''null''::jsonb)', format(relation_accessor,
      'derived_relation_' || md5((expression->>'relation') || '.' || (expression->>'field')),
      expression->>'relation', expression->>'field'));
  elsif node_type = 'parameter' then
    target := environment->'$parameters'->(expression->>'parameter');
    result_type := target->>'type';
    accessor := format('%L::jsonb', target->'value');
  elsif node_type = 'compare' then
    left_sql := kernel_derived_typed_sql(expression->'left', environment, base_accessor, custom_accessor, relation_accessor, visiting);
    right_sql := kernel_derived_typed_sql(expression->'right', environment, base_accessor, custom_accessor, relation_accessor, visiting);
    return jsonb_build_object('type', 'bool', 'sql', case when left_sql->>'type' = 'number'
      then format('to_jsonb(%s %s %s)', left_sql->>'sql',
        case expression->>'op' when 'eq' then '=' when 'not_eq' then '<>' when 'lt' then '<'
          when 'lte' then '<=' when 'gt' then '>' else '>=' end, right_sql->>'sql')
      else format('to_jsonb(kernel_derived_compare(%s,%s,%L,%L))', left_sql->>'sql', right_sql->>'sql',
        expression->>'op', left_sql->>'type') end);
  elsif node_type = 'if' then
    condition_sql := kernel_derived_typed_sql(expression->'condition', environment, base_accessor, custom_accessor, relation_accessor, visiting);
    left_sql := kernel_derived_typed_sql(expression->'then', environment, base_accessor, custom_accessor, relation_accessor, visiting);
    right_sql := kernel_derived_typed_sql(expression->'else', environment, base_accessor, custom_accessor, relation_accessor, visiting);
    return jsonb_build_object('type', left_sql->>'type', 'sql', format('(case when %s = ''true''::jsonb then %s else %s end)',
      condition_sql->>'sql', left_sql->>'sql', right_sql->>'sql'));
  elsif node_type in ('min', 'max') then
    left_sql := kernel_derived_typed_sql(expression->'left', environment, base_accessor, custom_accessor, relation_accessor, visiting);
    right_sql := kernel_derived_typed_sql(expression->'right', environment, base_accessor, custom_accessor, relation_accessor, visiting);
    return jsonb_build_object('type', left_sql->>'type', 'sql', format('%s(%s,%s,%L)',
      case when left_sql->>'type' = 'number' then 'kernel_derived_bound' else 'kernel_derived_money_bound' end,
      left_sql->>'sql', right_sql->>'sql', node_type = 'max'));
  elsif node_type = 'clamp' then
    -- clamp(x, lo, hi) = max(lo, min(x, hi)).
    return kernel_derived_typed_sql(jsonb_build_object('type', 'max', 'left', expression->'min',
      'right', jsonb_build_object('type', 'min', 'left', expression->'expression', 'right', expression->'max')),
      environment, base_accessor, custom_accessor, relation_accessor, visiting);
  end if;
  -- A typed value read by `field`, `relation_field` or `parameter`, as one
  -- read value: stored numbers follow the apply contract, where `_`
  -- separators are ignored, and money amounts are canonical decimals.
  if accessor is not null then
    return jsonb_build_object('type', result_type, 'sql', case result_type
      when 'number' then format('replace(%s#>>''{}'',''_'','''')::numeric', accessor)
      when 'money_rate' then format('kernel_derived_money(replace(%1$s->>''amount'',''_'','''')::numeric,%1$s->>''currency'',%1$s->>''period'')', accessor)
      else accessor end);
  end if;
  raise exception 'contract_validation_failed: unsupported derived expression';
end;
$kernel$
"#;

// SQL for the read value of a derived expression: the `value` member of a
// typed field value, with numbers as canonical decimal strings.
const DERIVED_VALUE_SQL: &str = r#"
create or replace function kernel_derived_value_sql(
  expression jsonb,
  environment jsonb,
  base_accessor text,
  custom_accessor text,
  relation_accessor text
)
returns text
language plpgsql
immutable
parallel safe
security invoker
set search_path from current
as $kernel$
declare
  lowered jsonb := kernel_derived_typed_sql(expression, environment, base_accessor, custom_accessor, relation_accessor, '[]'::jsonb);
begin
  return case when lowered->>'type' = 'number'
    then format('to_jsonb(trim_scale(%s)::text)', lowered->>'sql')
    else lowered->>'sql' end;
end;
$kernel$
"#;

// Stored fields a derived expression reads, with derived references expanded.
// A relation lookup reads its relation field here; the related field is
// authorized by the lookup's own query on the related model. `visiting`
// guards against a stored cycle, as in kernel_derived_typed_sql.
const DERIVED_REFERENCES: &str = r#"
create or replace function kernel_derived_references(expression jsonb, environment jsonb, visiting jsonb)
returns jsonb
language plpgsql
immutable
parallel safe
security invoker
set search_path from current
as $kernel$
declare
  result jsonb := '[]'::jsonb;
  child jsonb;
  target jsonb;
begin
  if expression->>'type' = 'field' then
    target := environment->(expression->>'field');
    if target ? 'expression' then
      if visiting ? (expression->>'field') then
        raise exception 'schema_drift: derived field references itself';
      end if;
      return kernel_derived_references(target->'expression', environment,
        visiting || jsonb_build_array(expression->>'field'));
    end if;
    return jsonb_build_array(expression->>'field');
  end if;
  if expression->>'type' = 'relation_field' then
    return jsonb_build_array(expression->>'relation');
  end if;
  for child in
    select value from jsonb_array_elements(coalesce(expression->'expressions', '[]'::jsonb))
    union all select expression->key from unnest(array['left', 'right', 'condition', 'then', 'else', 'min', 'max', 'expression']) key
      where jsonb_typeof(expression->key) = 'object'
  loop
    result := result || kernel_derived_references(child, environment, visiting);
  end loop;
  return result;
end;
$kernel$
"#;

const DERIVED_ENTRY: &str = r#"
create or replace function kernel_derived_entry(field_id text, field_type text, value jsonb)
returns jsonb
language sql
immutable
parallel safe
security invoker
set search_path from current
as $kernel$
  select case when value is null or value = 'null'::jsonb then '[]'::jsonb
    else jsonb_build_array(jsonb_build_object('field_id', field_id, 'type', field_type, 'value', value)) end
$kernel$
"#;

// Issues for every active derived definition of an effective schema, so a
// release or overlay cannot activate a derived field it no longer satisfies.
const DERIVED_SCHEMA_ISSUES: &str = r#"
create or replace function kernel_derived_schema_issues(schema_json jsonb)
returns jsonb
language sql
immutable
parallel safe
security invoker
set search_path from current
as $kernel$
  select coalesce(jsonb_agg(issue.value order by definition.ordinal), '[]'::jsonb)
  from jsonb_array_elements(coalesce(schema_json->'custom_fields', '[]'::jsonb)) with ordinality definition(value, ordinal)
  cross join lateral jsonb_array_elements(kernel_derived_issues(
    kernel_derived_environment(schema_json, definition.value->>'model_id'),
    definition.value->>'field_id', definition.value->'expression', definition.value->>'type',
    format('custom_fields.%s', definition.value->>'id')
  )) issue(value)
  where coalesce(definition.value->'expression', 'null'::jsonb) <> 'null'::jsonb
    and coalesce(definition.value->>'lifecycle', 'active') = 'active'
    and coalesce(definition.value->'archived_at', 'null'::jsonb) = 'null'::jsonb
$kernel$
"#;
