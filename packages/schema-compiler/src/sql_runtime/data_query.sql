create or replace function kernel_data_query_core(request jsonb, work_state jsonb, work_rule_scan boolean)
returns jsonb
language plpgsql
volatile
security invoker
set search_path from current
as $kernel$
declare
  schema_json jsonb;
  work_owner text;
  work_as_of text;
  rule_type text;
  relation_node jsonb;
  relation_ctes text := '';
  model_json jsonb;
  query_fields jsonb;
  select_fields jsonb;
  source_sql text;
  record_table text;
  version_table text;
  values_expression text;
  lookup_filter text := '';
  request_date date;
  filter jsonb;
  filter_index integer := -1;
  ordering jsonb;
  field_json jsonb;
  field_id text;
  expression text;
  predicate text := 'true';
  ordering_sql text := '';
  group_expression text := 'jsonb_build_array()';
  grouping jsonb;
  metric jsonb;
  aggregate_groups jsonb;
  aggregate_metrics jsonb;
  money_fields jsonb := '[]'::jsonb;
  metric_sql text := '';
  units_sql text := '';
  header_unit_sql text;
  group_order_sql text := '';
  total_metric_sql text := '';
  metric_expression text;
  total_metric_expression text;
  value_expression text;
  unit_expression text;
  eligible_predicate text := 'true';
  edge jsonb;
  previous_edge numeric;
  money_bins boolean := false;
  grouping_index integer := -1;
  metric_index integer := -1;
  query_sql text;
  result jsonb;
  select_ids jsonb;
  authorization_policy jsonb;
  authorization_grants jsonb;
  authorization_fields jsonb;
  response_expression text := 'r';
  page_size integer;
  page_offset integer;
  op text;
  field_type text;
  relation_source jsonb;
  relation_json jsonb;
  source_model_json jsonb;
  source_record_id uuid;
  source_record_table text;
  source_version_table text;
  source_values_expression text;
  source_lookup_filter text := '';
  source_navigation_sql text;
  source_navigation_allowed boolean;
  relation_through text;
  relation_predicate text := 'true';
  search_query text;
  search_fields jsonb;
  search_grade text;
  retired_filter text := '';
  record_filter text := '';
  derived_environment jsonb;
  derived_entries_sql text := '';
  computed jsonb;
  computed_index integer := -1;
  computed_issues jsonb;
  computed_fields jsonb := '[]'::jsonb;
  requested_fields jsonb;
  value_projection jsonb;
  predicate_fields text[];
  custom_expression text := 'kernel_read_custom_fields($4,$3,v.custom_fields)';
  derived_ids jsonb;
  include_drafts boolean := false;
  drafts_requested boolean := false;
  draft_relation_ids jsonb;
  draft_values_projection jsonb := '[]'::jsonb;
  draft_values_sql text;
  draft_version_filter text := '';
  draft_custom_sql text := 'kernel_read_custom_field_map($4,$3,dv.custom_fields)';
  draft_ctes text;
  draft_overlay_sql text := '';
begin
  if request is null or jsonb_typeof(request) <> 'object'
    or octet_length(request::text)>1048576
    or jsonb_typeof(coalesce(request->'where','[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(request->'where','[]'::jsonb)) > 20
    or jsonb_typeof(coalesce(request->'order_by','[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(request->'order_by','[]'::jsonb)) > 5
    or coalesce(request->>'kind','list') not in ('list','aggregate')
    or (request ? 'exclude_retired' and jsonb_typeof(request->'exclude_retired') <> 'boolean')
    or (request ? 'include_pending_drafts' and jsonb_typeof(request->'include_pending_drafts') <> 'boolean') then
    raise exception 'contract_validation_failed: invalid bounded data query';
  end if;
  if (request ? 'limit' and request->'limit' <> 'null'::jsonb and (jsonb_typeof(request->'limit') <> 'number' or request->>'limit' !~ '^[0-9]+$'))
    or (request ? 'offset' and request->'offset' <> 'null'::jsonb and (jsonb_typeof(request->'offset') <> 'number' or request->>'offset' !~ '^[0-9]+$'))
    or (request ? 'limit' and request->'limit' <> 'null'::jsonb and (request->>'limit')::numeric not between 1 and 100)
    or (request ? 'offset' and request->'offset' <> 'null'::jsonb and (request->>'offset')::numeric not between 0 and 10000) then
    raise exception 'contract_validation_failed: invalid bounded data query';
  end if;
  drafts_requested := coalesce((request->>'include_pending_drafts')::boolean,false);
  page_size := coalesce((request->>'limit')::integer, 50);
  page_offset := coalesce((request->>'offset')::integer, 0);
  if request->>'as_of' is null then raise exception 'contract_validation_failed: as_of is required'; end if;
  request_date := (request->>'as_of')::date;
  schema_json := kernel_read_scope_schema(request->>'app_id',request->>'customer_id');
  if request->>'schema_version' is distinct from schema_json->>'version' then raise exception 'schema_drift: generated operation schema version is stale'; end if;
  select value into model_json from jsonb_array_elements(schema_json->'models') where value->>'id'=request->>'model_id';
  if model_json is null then raise exception 'record_target_missing: unknown model'; end if;
  -- Pending drafts cost nothing when no pending draft wrote this model: the
  -- read takes the plain mainline path (related-model reads still ask).
  include_drafts := drafts_requested and exists (
    select 1 from change_set cs
    where cs.app_id=request->>'app_id' and cs.customer_id=request->>'customer_id'
      and cs.status='draft' and cs.applied_order is null and cs.written_fields ? (request->>'model_id'));
  if request ? 'relation_source' then
    relation_source := request->'relation_source';
    if jsonb_typeof(relation_source) <> 'object'
      or relation_source - array['model_id','relation_id','record_id'] <> '{}'::jsonb
      or not (relation_source ?& array['model_id','relation_id','record_id'])
      or exists (
        select 1 from jsonb_each(relation_source) item(key,value)
        where jsonb_typeof(item.value) <> 'string' or item.value = '""'::jsonb
      ) then
      raise exception 'contract_validation_failed: invalid relation source';
    end if;
    begin
      source_record_id := (relation_source->>'record_id')::uuid;
    exception when invalid_text_representation then
      raise exception 'contract_validation_failed: relation source record id must be a canonical UUID';
    end;
    if source_record_id::text is distinct from relation_source->>'record_id' then
      raise exception 'contract_validation_failed: relation source record id must be a canonical UUID';
    end if;
  end if;
  -- `work_state` is the private work reference: {session_id} from a public
  -- `work` selector, plus the rule being evaluated and its excluded outputs
  -- when a work rule scans the overlay.
  if request ? 'work' then
    if work_state is not null
      or jsonb_typeof(request->'work') is distinct from 'object'
      or (request->'work') - 'session_id' <> '{}'::jsonb
      or not (request->'work' ? 'session_id') then
      raise exception 'contract_validation_failed: invalid work reference';
    end if;
    work_state := jsonb_build_object('session_id', request#>>'{work,session_id}');
  end if;
  if work_state is not null then
    work_owner := kernel_work_actor(request);
    select s.as_of::text into work_as_of from work_session s
    where s.app_id = request->>'app_id' and s.customer_id = request->>'customer_id'
      and s.id = (work_state->>'session_id')::uuid and s.owner_id = work_owner;
    if not found then raise exception 'authorization_denied: session is unavailable'; end if;
    if work_as_of is distinct from request->>'as_of' then
      raise exception 'contract_validation_failed: work query must use the session as_of';
    end if;
  end if;
  -- Derived custom fields are read-only custom fields whose values are
  -- evaluated from their expression over each authorized read image.
  derived_environment := kernel_derived_environment(schema_json,request->>'model_id');
  -- A declared field or many-relation id, retired included, always resolves to
  -- the declared element; kernel_active_custom_fields leaves out a custom
  -- definition reusing one.
  query_fields := (model_json->'fields') || kernel_active_custom_fields(schema_json,request->>'model_id');
  -- A work rule's value and condition are evaluated as derived values of the
  -- scanned rows, with the rule's parameters in scope.
  if work_state ? 'rule' then
    rule_type := derived_environment->(work_state#>>'{rule,field_id}')->>'type';
    derived_environment := derived_environment || jsonb_build_object(
      '$parameters', coalesce(work_state#>'{rule,parameters}','{}'::jsonb),
      '$rule_value', jsonb_build_object('type', rule_type, 'source', 'custom', 'expression', work_state#>'{rule,value}'))
      || case when work_state->'rule' ? 'condition' then jsonb_build_object('$rule_condition',
        jsonb_build_object('type', 'bool', 'source', 'custom', 'expression', work_state#>'{rule,condition}')) else '{}'::jsonb end;
  end if;
  -- Computed columns are per-query derived fields in the same AST: named,
  -- typed and validated like derived custom fields, never stored, and
  -- visible only to this request.
  if request ? 'computed' then
    if jsonb_typeof(request->'computed') is distinct from 'array' or jsonb_array_length(request->'computed') not between 1 and 8 then
      raise exception 'contract_validation_failed: computed must be an array of 1 to 8 columns';
    end if;
    for computed in select value from jsonb_array_elements(request->'computed') loop
      if jsonb_typeof(computed) is distinct from 'object' or computed - array['id','type','expression'] <> '{}'::jsonb
        or not computed ?& array['id','type','expression'] or jsonb_typeof(computed->'id') is distinct from 'string'
        or jsonb_typeof(computed->'type') is distinct from 'string' or computed->>'id' !~ '^[a-z][a-z0-9_]{0,62}$' then
        raise exception 'contract_validation_failed: invalid computed column';
      end if;
      if derived_environment ? (computed->>'id')
        or exists (select 1 from jsonb_array_elements(coalesce(model_json->'fields','[]'::jsonb)||coalesce(model_json->'many_relations','[]'::jsonb)) value where value->>'id'=computed->>'id')
        or exists (select 1 from jsonb_array_elements(coalesce(schema_json->'custom_fields','[]'::jsonb)) value where value->>'model_id'=request->>'model_id' and value->>'field_id'=computed->>'id') then
        raise exception 'contract_validation_failed: computed column `%` reuses a field or computed column id', computed->>'id';
      end if;
      derived_environment := derived_environment || jsonb_build_object(computed->>'id',
        jsonb_build_object('type',computed->>'type','source','computed','expression',computed->'expression'));
      computed_fields := computed_fields || jsonb_build_array(jsonb_build_object('id',computed->>'id','type',computed->>'type','custom',true));
    end loop;
    for computed in select value from jsonb_array_elements(request->'computed') loop
      computed_index := computed_index + 1;
      computed_issues := kernel_derived_issues(derived_environment,computed->>'id',computed->'expression',computed->>'type',format('computed[%s]',computed_index));
      if jsonb_array_length(computed_issues) > 0 then
        raise exception 'contract_validation_failed: computed column `%`: %: %', computed->>'id', computed_issues->0->>'code', computed_issues->0->>'message';
      end if;
    end loop;
  end if;
  query_fields := query_fields || computed_fields;
  select_fields := query_fields || coalesce(model_json->'many_relations','[]'::jsonb);
  if request ? 'select' then
    if request->>'kind' = 'aggregate' then
      raise exception 'contract_validation_failed: select is not supported for aggregate';
    end if;
    if jsonb_typeof(request->'select') <> 'array' or jsonb_array_length(request->'select') = 0
      or exists (select 1 from jsonb_array_elements(request->'select') value where jsonb_typeof(value) <> 'string')
      or exists (select 1 from jsonb_array_elements_text(request->'select') value group by value having count(*) > 1) then
      raise exception 'contract_validation_failed: invalid select';
    end if;
    select_ids := request->'select';
    for field_id in select value from jsonb_array_elements_text(select_ids) loop
      if field_id not in ('$id','$externalKey','$version')
        and not exists (select 1 from jsonb_array_elements(select_fields) value where value->>'id'=field_id) then
        raise exception 'contract_validation_failed: unsupported select field';
      end if;
    end loop;
    response_expression := format(
      '(case when %1$L::jsonb ? ''$id'' then jsonb_build_object(''record_id'',r->''record_id'') else ''{}''::jsonb end || case when %1$L::jsonb ? ''$version'' then jsonb_build_object(''version_id'',r->''version_id'') else ''{}''::jsonb end || case when %1$L::jsonb ? ''$externalKey'' then jsonb_build_object(''external_key'',r->''external_key'') else ''{}''::jsonb end || case when exists (select 1 from jsonb_each(r->''values'') where %1$L::jsonb ? key) then jsonb_build_object(''values'',(select jsonb_object_agg(key,value) from jsonb_each(r->''values'') where %1$L::jsonb ? key)) else ''{}''::jsonb end || case when exists (select 1 from jsonb_array_elements(r->''custom_fields'') where %1$L::jsonb ? (value->>''field_id'')) then jsonb_build_object(''custom_fields'',(select jsonb_agg(value) from jsonb_array_elements(r->''custom_fields'') where %1$L::jsonb ? (value->>''field_id''))) else ''{}''::jsonb end || case when exists (select 1 from jsonb_each(r->''many_relations'') where %1$L::jsonb ? key) then jsonb_build_object(''many_relations'',(select jsonb_object_agg(key,value) from jsonb_each(r->''many_relations'') where %1$L::jsonb ? key)) else ''{}''::jsonb end || case when r->''pending_draft'' is not null then kernel_read_pending_draft_row(jsonb_build_object(''pending_draft'',(r->''pending_draft'')||jsonb_build_object(''fields'',coalesce((select jsonb_object_agg(key,value) from jsonb_each(r->''pending_draft''->''fields'') where %1$L::jsonb ? key),''{}''::jsonb)))) else ''{}''::jsonb end)',
      select_ids::text
    );
  end if;
  if request->>'kind' = 'aggregate' then
    aggregate_groups := coalesce(request->'group_by','[]'::jsonb);
    aggregate_metrics := request->'metrics';
    if jsonb_typeof(aggregate_groups) is distinct from 'array'
      or jsonb_array_length(aggregate_groups)>2
      or jsonb_typeof(aggregate_metrics) is distinct from 'array'
      or jsonb_array_length(aggregate_metrics) not between 1 and 8
      or request ?| array['limit','offset','order_by'] then
      raise exception 'contract_validation_failed: invalid aggregate query';
    end if;
    for grouping in select value from jsonb_array_elements(aggregate_groups) loop
      grouping_index := grouping_index + 1;
      field_id := case when jsonb_typeof(grouping)='string' then grouping #>> '{}' else grouping->>'field' end;
      select value into field_json from jsonb_array_elements(query_fields) where value->>'id'=field_id;
      field_type := field_json->>'type';
      if field_json is null then raise exception 'contract_validation_failed: unsupported group field'; end if;
      value_expression := case when field_json->>'custom'='true'
        then format('(kernel_read_custom_field_map($4,$3,r->''custom_fields'')->%L->''value'')',field_id)
        else format('(r->''values''->%L->''value'')',field_id) end;
      if jsonb_typeof(grouping)='object' then
        if grouping - array['field','bins','unit'] <> '{}'::jsonb
          or not (grouping ?& array['field','bins'])
          or jsonb_typeof(grouping->'field') is distinct from 'string'
          or field_type not in ('number','money_rate')
          or jsonb_typeof(grouping->'bins') is distinct from 'object'
          or (grouping->'bins') - array['edges'] <> '{}'::jsonb
          or jsonb_typeof(grouping#>'{bins,edges}') is distinct from 'array'
          or jsonb_array_length(grouping#>'{bins,edges}') not between 2 and 51 then
          raise exception 'contract_validation_failed: invalid aggregate bins';
        end if;
        previous_edge := null;
        for edge in select value from jsonb_array_elements(grouping#>'{bins,edges}') loop
          if jsonb_typeof(edge)<>'string' or (edge #>> '{}') !~ '^-?[0-9]+([.][0-9]+)?$' then
            raise exception 'contract_validation_failed: bin edges must be decimal strings';
          end if;
          if previous_edge is not null and (edge #>> '{}')::numeric <= previous_edge then
            raise exception 'contract_validation_failed: bin edges must ascend';
          end if;
          previous_edge := (edge #>> '{}')::numeric;
        end loop;
        if field_type='money_rate' then
          if jsonb_typeof(grouping->'unit') is distinct from 'object'
            or (grouping->'unit') - array['currency','period'] <> '{}'::jsonb
            or not (grouping->'unit' ?& array['currency','period'])
            or jsonb_typeof(grouping#>'{unit,currency}') is distinct from 'string'
            or jsonb_typeof(grouping#>'{unit,period}') is distinct from 'string'
            or grouping#>>'{unit,currency}' !~ '^[A-Z]{3}$'
            or grouping#>>'{unit,period}' not in ('hourly','daily','weekly','monthly','annual') then
            raise exception 'contract_validation_failed: money bins require a unit';
          end if;
          money_bins := true;
          unit_expression := format('case when %1$s is null then null else %1$s - ''amount'' end',value_expression);
          eligible_predicate := eligible_predicate || format(' and (%s is null or %s = $11->''group_by''->%s->''unit'')',value_expression,unit_expression,grouping_index);
          value_expression := format('(%s->>''amount'')::numeric',value_expression);
        else
          if grouping ? 'unit' then raise exception 'contract_validation_failed: number bins do not take a unit'; end if;
          value_expression := format('(%s#>>''{}'')::numeric',value_expression);
        end if;
        expression := format('kernel_read_aggregate_bin(%s,$11->''group_by''->%s->''bins''->''edges'')',value_expression,grouping_index);
      elsif jsonb_typeof(grouping)='string' and field_type in ('text','enum','bool','date','iso_country','iso_currency','relation','number') then
        expression := case
          when field_type='relation' then format('%s->''value''',value_expression)
          when field_type='number' then format('to_jsonb(trim_scale((%s#>>''{}'')::numeric)::text)',value_expression)
          else value_expression end;
      else
        raise exception 'contract_validation_failed: unsupported group field';
      end if;
      if group_order_sql <> '' then group_order_sql := group_order_sql || ','; end if;
      if jsonb_typeof(grouping)='object' then
        group_order_sql := group_order_sql || format('case when key->%1$s = ''"below"''::jsonb then 0 when jsonb_typeof(key->%1$s)=''object'' then 1 when key->%1$s = ''"above"''::jsonb then 2 else 3 end,(key->%1$s->>''from'')::numeric',grouping_index);
      elsif field_type='enum' then
        group_order_sql := group_order_sql || format('(select ordinal from jsonb_array_elements(%L::jsonb) with ordinality as options(option,ordinal) where option->>''id''=key->>%s) nulls last',field_json->'option_set',grouping_index);
      else
        group_order_sql := group_order_sql || format('(key->>%s)%s nulls last',grouping_index,case field_type when 'number' then '::numeric' when 'date' then '::date' when 'bool' then '::boolean' else '' end);
      end if;
      group_expression := group_expression || format(' || jsonb_build_array(%s)',expression);
    end loop;
    for metric in select value from jsonb_array_elements(aggregate_metrics) loop
      metric_index := metric_index + 1;
      op := metric->>'fn';
      header_unit_sql := 'null::jsonb';
      if jsonb_typeof(metric) is distinct from 'object'
        or metric - array['fn','field','p'] <> '{}'::jsonb
        or op is null or op not in ('count','count_distinct','sum','avg','min','max','median','percentile') then
        raise exception 'contract_validation_failed: unsupported aggregate metric';
      end if;
      if op='count' then
        if metric ?| array['field','p'] then raise exception 'contract_validation_failed: count takes no field'; end if;
        metric_expression := 'count(*)::text'; total_metric_expression := metric_expression;
      else
        field_id := metric->>'field';
        select value into field_json from jsonb_array_elements(query_fields) where value->>'id'=field_id;
        field_type := field_json->>'type';
        if jsonb_typeof(metric->'field') is distinct from 'string' or field_json is null or field_type not in ('number','money_rate') then
          raise exception 'contract_validation_failed: metric requires a number or money-rate field';
        end if;
        if op='percentile' then
          if jsonb_typeof(metric->'p') is distinct from 'number' or (metric->>'p')::numeric not between 0 and 1 then
            raise exception 'contract_validation_failed: percentile requires p between zero and one';
          end if;
        elsif metric ? 'p' then raise exception 'contract_validation_failed: only percentile takes p'; end if;
        value_expression := case when field_json->>'custom'='true'
          then format('(kernel_read_custom_field_map($4,$3,r->''custom_fields'')->%L->''value'')',field_id)
          else format('(r->''values''->%L->''value'')',field_id) end;
        if field_type='money_rate' then
          unit_expression := format('case when %1$s is null then null else %1$s - ''amount'' end',value_expression);
          if not money_fields ? field_id then
            money_fields := money_fields || jsonb_build_array(field_id);
            group_expression := group_expression || format(' || jsonb_build_array(jsonb_build_object(''unit'',%s))',unit_expression);
          end if;
          value_expression := format('(%s->>''amount'')::numeric',value_expression);
        else value_expression := format('(%s#>>''{}'')::numeric',value_expression); end if;
        metric_expression := case
          when op='count_distinct' then format('count(distinct %s)::text',value_expression)
          when op in ('median','percentile') then format('kernel_read_aggregate_percentile(array_agg(%1$s order by %1$s) filter (where %1$s is not null),%2$s)::text',value_expression,case when op='median' then '0.5::numeric' else format('($11->''metrics''->%s->>''p'')::numeric',metric_index) end)
          else format('%s(%s)::text',op,value_expression) end;
        total_metric_expression := metric_expression;
        if field_type='money_rate' then
          header_unit_sql := format('case when count(distinct %1$s)=1 then min((%1$s)::text)::jsonb else null end',unit_expression);
          total_metric_expression := format('case when count(distinct %s) <= 1 then %s else null end',unit_expression,metric_expression);
        end if;
      end if;
      units_sql := units_sql || case when units_sql='' then '' else ',' end || header_unit_sql;
      metric_sql := metric_sql || case when metric_sql='' then '' else ',' end || metric_expression;
      total_metric_sql := total_metric_sql || case when total_metric_sql='' then '' else ',' end || total_metric_expression;
    end loop;
  elsif request ?| array['group_by','metrics'] then
    raise exception 'contract_validation_failed: grouping and metrics require aggregate';
  end if;
  for filter in select value from jsonb_array_elements(coalesce(request->'where','[]'::jsonb)) loop
    filter_index := filter_index + 1;
    field_id := filter->>'field';
    op := filter->>'op';
    select value into field_json from jsonb_array_elements(query_fields) where value->>'id'=field_id;
    if field_id in ('$id','$externalKey') then
      expression := format('r->>%L',case when field_id='$id' then 'record_id' else 'external_key' end);
      field_type := 'text';
    elsif field_json is not null and field_json->>'type' in ('text','number','bool','date','datetime','enum','iso_country','iso_currency','relation') then
      field_type := field_json->>'type';
      expression := case when field_json->>'custom'='true' then format('(kernel_read_custom_field_map($4,$3,r->''custom_fields'')->%L%s)',field_id,case when field_type='relation' then '->''value''->>''value''' else '->>''value''' end) when field_type='relation' then format('r->''values''->%L->''value''->>''value''',field_id)
        else format('r->''values''->%L->>''value''',field_id) end;
    else raise exception 'contract_validation_failed: unsupported query field'; end if;
    if op='isNull' then
      predicate := predicate || format(' and (%s) is null',expression);
    elsif op='contains' and field_type='text' and jsonb_typeof(filter->'value')='string' then
      predicate := predicate || format(' and strpos((%s),($11->''where''->%s->>''value''))>0',expression,filter_index);
    elsif op in ('eq','ne','lt','lte','gt','gte') and jsonb_typeof(filter->'value') in ('string','boolean') then
      if field_type='bool' and op not in ('eq','ne') then raise exception 'contract_validation_failed: bool supports equality only'; end if;
      predicate := predicate || format(' and (%s)::%s %s ($11->''where''->%s->>''value'')::%s',expression,
        case field_type when 'number' then 'numeric' when 'date' then 'date' when 'datetime' then 'timestamptz' when 'bool' then 'boolean' else 'text' end,
        case op when 'eq' then '=' when 'ne' then '<>' when 'lt' then '<' when 'lte' then '<=' when 'gt' then '>' else '>=' end,
        filter_index,case field_type when 'number' then 'numeric' when 'date' then 'date' when 'datetime' then 'timestamptz' when 'bool' then 'boolean' else 'text' end);
    else raise exception 'contract_validation_failed: unsupported query operator or value'; end if;
    -- Immutable IDs can be restricted before temporal selection and overlay.
    -- Keep the public text predicate too: noncanonical UUID spellings still do not match.
    if field_id='$id' and op='eq' and jsonb_typeof(filter->'value')='string' then
      if filter->>'value' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        record_filter:=record_filter||format(' and r.id=($11->''where''->%s->>''value'')::uuid',filter_index);
      else record_filter:=record_filter||' and false'; end if;
    end if;
  end loop;
  -- Search: records whose declared text, list-of-text or alias fields match
  -- the query (see kernel_search_grade), best grade first.
  if request ? 'search' then
    -- A query must be a JSON string of at most 200 characters; anything else
    -- leaves search_query null and is rejected below.
    if jsonb_typeof(request->'search'->'query') = 'string'
      and char_length(request->'search'->>'query') <= 200
    then
      search_query := kernel_search_normalize(request->'search'->>'query');
    end if;
    search_fields := request->'search'->'fields';
    if jsonb_typeof(request->'search') <> 'object'
      or (request->'search') - array['query','fields'] <> '{}'::jsonb
      or search_query is null
      or jsonb_typeof(search_fields) is distinct from 'array'
      or jsonb_array_length(search_fields) not between 1 and 10
      or exists (
        select 1 from jsonb_array_elements(search_fields) item(value)
        where jsonb_typeof(item.value) <> 'string'
          or not exists (
            select 1 from jsonb_array_elements(model_json->'fields') field(value)
            where field.value->>'id' = item.value #>> '{}'
              and field.value->>'type' in ('text','text_list','known_aliases')
          )
      ) then
      raise exception 'contract_validation_failed: invalid search';
    end if;
    search_grade := 'kernel_search_record_grade($12,r->''values'',$11->''search''->''fields'')';
    predicate := predicate || format(' and %s is not null',search_grade);
    ordering_sql := search_grade || ' asc,';
  end if;
  if coalesce((request->>'exclude_retired')::boolean,false) and model_json->>'kind'='lookup' then
    retired_filter := ' and v.availability=''active''';
  end if;
  for ordering in select value from jsonb_array_elements(coalesce(request->'order_by','[]'::jsonb)) loop
    field_id := ordering->>'field';
    select value into field_json from jsonb_array_elements(query_fields) where value->>'id'=field_id;
    if field_id in ('$id','$externalKey') then
      expression := format('r->>%L',case when field_id='$id' then 'record_id' else 'external_key' end);
    elsif field_json->>'type' in ('text','number','bool','date','datetime','enum','iso_country','iso_currency') then
      expression := case when field_json->>'custom'='true' then format('(kernel_read_custom_field_map($4,$3,r->''custom_fields'')->%L->>''value'')',field_id) else format('(r->''values''->%L->>''value'')',field_id) end;
      expression := format('(%s)::%s',expression,
        case field_json->>'type' when 'number' then 'numeric' when 'datetime' then 'timestamptz' else 'text' end);
    else raise exception 'contract_validation_failed: unsupported order field'; end if;
    if ordering->>'direction' not in ('asc','desc') then raise exception 'contract_validation_failed: unsupported direction'; end if;
    ordering_sql := ordering_sql || expression || ' ' || (ordering->>'direction') || ' nulls last,';
  end loop;
  ordering_sql := ordering_sql || 'r->>''record_id'' asc';
  -- Query canonical row versions directly. Filtering, aggregates and pagination
  -- execute before JSON aggregation; no full collection crosses the transport.
  if model_json->>'kind'='lookup' then
    perform kernel_read_assert_lookup_storage_authority(request->>'app_id',request->>'customer_id',request->>'model_id');
    record_table := 'lookup_record'; version_table := 'lookup_version';
    lookup_filter := ' and r.model_id=$3 and v.model_id=r.model_id';
    values_expression := format('kernel_read_lookup_values(%L::jsonb,v.values,''[]''::jsonb)',model_json::text);
  else
    record_table := kernel_read_physical_identifier((request->>'model_id') || '_record');
    version_table := kernel_read_physical_identifier((request->>'model_id') || '_version');
    values_expression := kernel_read_field_values_expression('v',model_json,'[]'::jsonb);
  end if;
  perform kernel_read_assert_mainline_order(version_table,request->>'app_id',request->>'customer_id');
  if request->>'kind' = 'aggregate' then
    authorization_fields := '[]'::jsonb;
  elsif request ? 'select' then
    authorization_fields := select_ids;
  else
    authorization_fields := coalesce((
      select jsonb_agg(value->>'id' order by value->>'id')
      from jsonb_array_elements(select_fields) item(value)
    ),'[]'::jsonb) || jsonb_build_array('$id','$externalKey','$version','$effectiveStart','$effectiveEnd','$metadata');
  end if;
  for filter in select value from jsonb_array_elements(coalesce(request->'where','[]'::jsonb)) loop
    authorization_fields := authorization_fields || jsonb_build_array(filter->>'field');
  end loop;
  for ordering in select value from jsonb_array_elements(coalesce(request->'order_by','[]'::jsonb)) loop
    authorization_fields := authorization_fields || jsonb_build_array(ordering->>'field');
  end loop;
  for grouping in select value from jsonb_array_elements(coalesce(aggregate_groups,'[]'::jsonb)) loop
    authorization_fields := authorization_fields || jsonb_build_array(case when jsonb_typeof(grouping)='string' then grouping #>> '{}' else grouping->>'field' end);
  end loop;
  for metric in select value from jsonb_array_elements(coalesce(aggregate_metrics,'[]'::jsonb)) loop
    if metric ? 'field' then authorization_fields := authorization_fields || jsonb_build_array(metric->>'field'); end if;
  end loop;
  if search_fields is not null then authorization_fields := authorization_fields || search_fields; end if;
  -- Every field the request reads; only these derived fields are evaluated.
  if work_state ? 'rule' then
    authorization_fields := authorization_fields || jsonb_build_array('$rule_value')
      || case when work_state->'rule' ? 'condition' then jsonb_build_array('$rule_condition') else '[]'::jsonb end;
  end if;
  requested_fields := authorization_fields;
  -- A derived value is readable exactly when every stored field its
  -- expression reads is readable, so it is authorized through those fields.
  select coalesce(jsonb_agg(item.value),'[]'::jsonb) into authorization_fields
  from (
    select to_jsonb(requested.field_id) as value
    from jsonb_array_elements_text(authorization_fields) requested(field_id)
    where not coalesce(derived_environment->requested.field_id ? 'expression',false)
    union all
    select reference.value
    from jsonb_array_elements_text(authorization_fields) requested(field_id)
    cross join lateral jsonb_array_elements(kernel_derived_references(jsonb_build_object('type','field','field',requested.field_id),derived_environment,'[]'::jsonb)) reference(value)
    where derived_environment->requested.field_id ? 'expression'
  ) item;
  authorization_policy := kernel_policy_authorize_query(request->>'app_id',request->>'customer_id',request->>'model_id',authorization_fields);
  if authorization_policy is not null then authorization_grants:=kernel_policy_capture_grants(authorization_policy,request->>'model_id','read'); end if;
  if relation_source is not null then
    if authorization_policy is null then
      raise exception 'contract_validation_failed: relation source requires a policy-enabled schema';
    end if;
    select value into relation_json
    from jsonb_array_elements(coalesce(authorization_policy->'relations','[]'::jsonb))
    where value->>'model' = relation_source->>'model_id'
      and value->>'id' = relation_source->>'relation_id'
      and value->>'target_model' = request->>'model_id';
    if relation_json is null or coalesce(relation_json->>'through','') = '' then
      raise exception 'authorization_denied: relation navigation is not declared for this target model';
    end if;
    relation_through := relation_json->>'through';
    select value into source_model_json
    from jsonb_array_elements(schema_json->'models')
    where value->>'id' = relation_source->>'model_id';
    if source_model_json is null then
      raise exception 'authorization_denied: relation source model is not present in the active schema';
    end if;
    if source_model_json->>'kind' = 'lookup' then
      perform kernel_read_assert_lookup_storage_authority(request->>'app_id',request->>'customer_id',relation_source->>'model_id');
      source_record_table := 'lookup_record'; source_version_table := 'lookup_version';
      source_lookup_filter := ' and r.model_id=$3 and v.model_id=r.model_id';
      source_values_expression := format('kernel_read_lookup_values(%L::jsonb,v.values,''[]''::jsonb)',source_model_json::text);
    else
      source_record_table := kernel_read_physical_identifier((relation_source->>'model_id') || '_record');
      source_version_table := kernel_read_physical_identifier((relation_source->>'model_id') || '_version');
      source_values_expression := kernel_read_field_values_expression('v',source_model_json,'[]'::jsonb);
    end if;
    perform kernel_read_assert_mainline_order(source_version_table,request->>'app_id',request->>'customer_id');
    -- With pending drafts (when one wrote the source model), the source
    -- record is navigated from as the read previews it: a record a pending
    -- draft creates can be navigated from and one it deletes cannot. Record
    -- grants apply to the canonical image (a created record's draft image)
    -- and to the overlaid one, as for the read's own rows.
    if drafts_requested and exists (
      select 1 from change_set cs
      where cs.app_id=request->>'app_id' and cs.customer_id=request->>'customer_id'
        and cs.status='draft' and cs.applied_order is null and cs.written_fields ? (relation_source->>'model_id')) then
      source_navigation_sql := format($navigation$
      with source_mainline as materialized (
        select v.effective_start,v.tombstones_record or v.untombstones_record as lifecycle,
          (%1$s) as mainline_values,kernel_read_custom_fields($4,$3,v.custom_fields) as custom_fields
        from %2$I r join lateral (
          select v.* from %3$I v join change_set cs on cs.id=v.change_set_id
            and cs.app_id=v.app_id and cs.customer_id=v.customer_id
            and cs.status='mainline' and cs.applied_order is not null
          where v.record_id=r.id and v.app_id=r.app_id and v.customer_id=r.customer_id
            and v.stage='mainline' and v.effective_start<=$5 and (v.effective_end is null or v.effective_end>=$5)%4$s
          order by v.effective_start desc,v.tombstones_record desc,v.untombstones_record desc,cs.applied_order desc,v.id desc limit 1
        ) v on true
        where r.app_id=$1 and r.customer_id=$2 and r.id=$10::uuid
      ),
      source_applicable as materialized (
        select d.* from (%5$s) d
        where case when exists (select 1 from source_mainline m where not m.lifecycle)
          then d.effective_start>=(select m.effective_start from source_mainline m)
          else not exists (
            select 1 from %3$I v join change_set cs on cs.id=v.change_set_id
              and cs.app_id=v.app_id and cs.customer_id=v.customer_id
              and cs.status='mainline' and cs.applied_order is not null
            where v.record_id=$10::uuid and v.app_id=$1 and v.customer_id=$2 and v.stage='mainline'%6$s) end
      ),
      source_drafted as materialized (
        select coalesce(
            (select not d.lifecycle from source_applicable d order by d.created_order desc,d.change_set_id desc limit 1),
            exists (select 1 from source_mainline m where not m.lifecycle)) as visible,
          (select m.mainline_values from source_mainline m where not m.lifecycle) as mainline_values,
          (coalesce((select m.mainline_values from source_mainline m where not m.lifecycle),'{}'::jsonb)
            - coalesce((select array_agg(distinct w.field_id) from source_applicable d
                cross join jsonb_array_elements_text(d.written) w(field_id) where not d.lifecycle),'{}'::text[]))
          || coalesce((select jsonb_object_agg(f.field_id,f.value) from (
              select distinct on (w.field_id) w.field_id,d.draft_values->w.field_id as value
              from source_applicable d cross join jsonb_array_elements_text(d.written) w(field_id)
              where not d.lifecycle order by w.field_id,d.created_order desc,d.change_set_id desc) f
            where f.value is not null),'{}'::jsonb) as drafted_values,
          coalesce((select m.custom_fields from source_mainline m where not m.lifecycle),'[]'::jsonb) as custom_fields
      ),
      source_image as materialized (
        select coalesce(s.mainline_values,s.drafted_values) as canonical_values,
          case when $13::jsonb is null then jsonb_build_object('values',s.drafted_values)
            else kernel_work_overlay_row(
              jsonb_build_object('record_id',$10::uuid,'values',s.drafted_values,'custom_fields',s.custom_fields),
              coalesce((select jsonb_agg(jsonb_build_object('field_id',w.field_id,'value',w.value)) from work_session_record w
                where w.app_id=$1 and w.customer_id=$2 and w.session_id=($13->>'session_id')::uuid and w.model_id=$3 and w.record_id=$10::uuid
                  and coalesce(w.rule_id<>$13->>'exclude_rule_id',true)),'[]'::jsonb),
              kernel_derived_environment($4,$3)) end as values
        from source_drafted s where s.visible
      )$navigation$,source_values_expression,source_record_table,source_version_table,source_lookup_filter,
        kernel_read_draft_versions_sql(
          case when source_model_json->>'kind'='lookup'
            then format('kernel_read_lookup_values(%L::jsonb,dv.values,''[]''::jsonb)',source_model_json::text)
            else kernel_read_field_values_expression('dv',source_model_json,'[]'::jsonb) end,
          '''{}''::jsonb',source_version_table,
          case when source_model_json->>'kind'='lookup' then ' and dv.model_id=$3' else '' end || ' and dv.record_id=$10::uuid'),
        case when source_model_json->>'kind'='lookup' then ' and v.model_id=$3' else '' end);
    else
      source_navigation_sql := format($navigation$
      with source_image as materialized (
        select (%1$s) as canonical_values,
          case when $13::jsonb is null then jsonb_build_object('values',(%1$s))
            else kernel_work_overlay_row(
              jsonb_build_object('record_id',r.id,'values',(%1$s),'custom_fields',kernel_read_custom_fields($4,$3,v.custom_fields)),
              coalesce((select jsonb_agg(jsonb_build_object('field_id',w.field_id,'value',w.value)) from work_session_record w
                where w.app_id=$1 and w.customer_id=$2 and w.session_id=($13->>'session_id')::uuid and w.model_id=$3 and w.record_id=r.id
                  and coalesce(w.rule_id<>$13->>'exclude_rule_id',true)),'[]'::jsonb),
              kernel_derived_environment($4,$3)) end as values
        from %2$I r join lateral (
          select v.* from %3$I v join change_set cs on cs.id=v.change_set_id
            and cs.app_id=v.app_id and cs.customer_id=v.customer_id
            and cs.status='mainline' and cs.applied_order is not null
          where v.record_id=r.id and v.app_id=r.app_id and v.customer_id=r.customer_id
            and v.stage='mainline' and v.effective_start<=$5 and (v.effective_end is null or v.effective_end>=$5)%4$s
          order by v.effective_start desc,v.tombstones_record desc,v.untombstones_record desc,cs.applied_order desc,v.id desc limit 1
        ) v on true
        where r.app_id=$1 and r.customer_id=$2 and r.id=$10::uuid
          and not v.tombstones_record and not v.untombstones_record
      )$navigation$,source_values_expression,source_record_table,source_version_table,source_lookup_filter);
    end if;
    source_navigation_sql := source_navigation_sql || $navigation$
      select exists (
        select 1 from source_image
        where exists (
          select 1
          from kernel_actor_membership membership
          join jsonb_array_elements(coalesce($8->'grants','[]'::jsonb)) grant_value(value)
            on grant_value.value->>'role'=membership.role
          where membership.principal_name=session_user::name and membership.active
            and membership.app_id=$1 and membership.customer_id=$2
            and membership.actor_id=nullif(current_setting('kernel.actor_id',true),'')
            and grant_value.value->>'model'=$3 and grant_value.value->'operations' ? 'read'
            and coalesce(grant_value.value->'read_relations','[]'::jsonb) ? $11
            and (grant_value.value->'record'->>'kind'='all' or (
              grant_value.value->'record'->>'kind'='actor_equals_field'
              and source_image.values->'values'->(grant_value.value->'record'->>'field')->>'value'
                = nullif(current_setting('kernel.actor_id',true),'')
              and source_image.canonical_values->(grant_value.value->'record'->>'field')->>'value'
                = nullif(current_setting('kernel.actor_id',true),'')
            ))
        )
      )
    $navigation$;
    execute source_navigation_sql
      using request->>'app_id',request->>'customer_id',relation_source->>'model_id',schema_json,request_date,
        null::integer,null::integer,authorization_policy,authorization_fields,source_record_id::text,relation_source->>'relation_id',request,work_state
      into source_navigation_allowed;
    if not coalesce(source_navigation_allowed,false) then
      raise exception 'authorization_denied: source record or relation navigation is not authorized';
    end if;
    select value into field_json from jsonb_array_elements(query_fields) where value->>'id'=relation_through;
    if field_json is null or field_json->>'type' <> 'relation'
      or field_json->>'target_model' is distinct from relation_source->>'model_id' then
      raise exception 'schema_drift: relation navigation through field is not a supported target relation';
    end if;
    relation_predicate := case when field_json->>'custom'='true'
      then format('(kernel_read_custom_field_map($4,$3,policy_source.r->''custom_fields'')->%L->''value''->>''value'')=$10',relation_through)
      else format('policy_source.r->''values''->%L->''value''->>''value''=$10',relation_through)
    end;
  end if;
  select coalesce(array_agg(distinct grant_value.value#>>'{record,field}'),'{}'::text[]) into predicate_fields
  from jsonb_array_elements(coalesce(authorization_grants->'grants','[]'::jsonb)) grant_value(value)
  where grant_value.value#>>'{record,kind}' = 'actor_equals_field';
  -- A projected request (aggregate, select or private scan) builds each row
  -- from the fields it reads, the record-predicate fields of its grants and
  -- its relation navigation field, instead of every field of the model.
  if request->>'kind' = 'aggregate' or request ? 'select' or work_rule_scan then
    select coalesce(jsonb_agg(distinct projected.field_id), '[]'::jsonb) into value_projection
    from (
      select jsonb_array_elements_text(authorization_fields) field_id
      union select grant_value.value#>>'{record,field}'
      from jsonb_array_elements(coalesce(authorization_grants->'grants','[]'::jsonb)) grant_value(value)
      where grant_value.value#>>'{record,kind}' = 'actor_equals_field'
      union select relation_through where relation_through is not null
    ) projected
    where projected.field_id not like '$%';
    -- A projected row omits unread fields; staged values for them do not apply.
    values_expression := case
      when jsonb_array_length(value_projection) = 0 then '''{}''::jsonb'
      when model_json->>'kind' = 'lookup' then format('kernel_read_lookup_values(%L::jsonb,v.values,%L::jsonb)',model_json::text,value_projection::text)
      else kernel_read_field_values_expression('v',model_json,value_projection) end;
    if not exists (
      select 1 from jsonb_array_elements_text(value_projection) projected(field_id)
      where derived_environment->projected.field_id->>'source' = 'custom'
    ) then
      custom_expression := '''[]''::jsonb';
    end if;
  end if;
  for field_id, field_json in
    select requested.field_id, derived_environment->requested.field_id
    from (
      select definition.value->>'field_id' field_id, definition.ordinal
      from jsonb_array_elements(coalesce(schema_json->'custom_fields','[]'::jsonb)) with ordinality definition(value,ordinal)
      where definition.value->>'model_id'=request->>'model_id'
      union all
      select rule_field, 0 from unnest(array['$rule_value','$rule_condition']) rule_field
    ) requested
    where derived_environment->requested.field_id ? 'expression'
      and requested_fields ? requested.field_id
    order by requested.ordinal
  loop
    derived_entries_sql := derived_entries_sql || format(' || kernel_derived_entry(%L,%L,%s)',field_id,field_json->>'type',
      kernel_derived_value_sql(field_json->'expression',derived_environment,
        'authorized_source.r->''values''->%L->''value''','derived_source.custom_map->%L->''value''',
        '(select lookup_values from %1$I)->(authorized_source.r->''values''->%2$L->''value''->>''value'')'));
  end loop;
  -- Each relation lookup reads its related model once through this same
  -- authorized query and overlay. A lookup is evaluated only when a derived
  -- value uses it.
  for relation_node in
    select distinct node from jsonb_path_query(derived_environment, 'lax $.** ? (@.type == "relation_field")') node
  loop
    relation_ctes := relation_ctes || format($lookup$,
      %I as materialized (
        select coalesce(jsonb_object_agg(image->>'record_id',kernel_work_value(image,%L)->'value'),'{}'::jsonb) lookup_values
        from jsonb_array_elements(kernel_data_query_scan(%L::jsonb,$13::jsonb - 'rule')) image
      )$lookup$,
      'derived_relation_' || md5((relation_node->>'relation') || '.' || (relation_node->>'field')),
      relation_node->>'field',
      jsonb_build_object('app_id',request->'app_id','customer_id',request->'customer_id','schema_version',request->'schema_version',
        'as_of',request->'as_of','kind','list','select',jsonb_build_array('$id',relation_node->>'field'),
        'include_pending_drafts',to_jsonb(drafts_requested),
        'model_id',derived_environment->(relation_node->>'relation')->'target_model'));
  end loop;
  -- Like derived fields, only requested computed columns are evaluated; a
  -- column another one reads is expanded inline, never evaluated separately.
  for computed in select value from jsonb_array_elements(coalesce(request->'computed','[]'::jsonb))
    where requested_fields ? (value->>'id') loop
    derived_entries_sql := derived_entries_sql || format(' || kernel_derived_entry(%L,%L,%s)',computed->>'id',computed->>'type',
      kernel_derived_value_sql(computed->'expression',derived_environment,
        'authorized_source.r->''values''->%L->''value''','derived_source.custom_map->%L->''value''',
        '(select lookup_values from %1$I)->(authorized_source.r->''values''->%2$L->''value''->>''value'')'));
  end loop;
  select coalesce(jsonb_agg(entry.key),'[]'::jsonb) into derived_ids
  from jsonb_each(derived_environment) entry where entry.value ? 'expression';
  -- Pending drafts (include_pending_drafts): a preview of every unapproved,
  -- undiscarded draft change set in the scope, whoever saved it, composed in
  -- save order between mainline and the session's staged entries. Each
  -- draft's version effective at as_of applies only when it is at least as
  -- new as the canonical version read or, for a record with no mainline
  -- version at all, as the record's creation (a draft dated before a
  -- record's first mainline version applies to none). The latest saved
  -- draft wins per field it wrote (recorded at Save) and decides whether the
  -- record shows (a deletion hides it; any other version shows it, so a
  -- draft creation appears). Each read row says what came from a pending draft
  -- (`pending_draft`: the draft that creates it, and per field the draft
  -- whose value shows).
  if include_drafts then
    if value_projection is not null then draft_values_projection := value_projection; end if;
    if value_projection is not null and jsonb_array_length(value_projection) = 0 then
      draft_values_sql := '''{}''::jsonb';
    elsif model_json->>'kind' = 'lookup' then
      draft_values_sql := format('kernel_read_lookup_values(%L::jsonb,dv.values,%L::jsonb)',model_json::text,draft_values_projection::text);
      draft_version_filter := ' and dv.model_id=$3';
    else
      draft_values_sql := kernel_read_field_values_expression('dv',model_json,draft_values_projection);
    end if;
    if custom_expression = '''[]''::jsonb' then
      draft_custom_sql := '''{}''::jsonb';
    end if;
    -- Only records a pending draft wrote are candidates, within the read's
    -- records (a get or relation lookup reads one), through the draft index
    -- on (record, effective date).
    draft_version_filter := draft_version_filter || ' and dv.record_id in (select record_id from draft_candidates)';
    -- Many relations (lookup models) a draft wrote replace the canonical list.
    select coalesce(jsonb_agg(relation.value->>'id'),'[]'::jsonb) into draft_relation_ids
    from jsonb_array_elements(coalesce(model_json->'many_relations','[]'::jsonb)) relation(value);
    draft_ctes := format($candidates$, draft_candidates as materialized (
      select r.id record_id,r.external_key from %I r
      where r.app_id=$1 and r.customer_id=$2%s%s
        and r.id in (select written.record_id::uuid from change_set cs
          cross join jsonb_object_keys(cs.written_fields->$3) written(record_id)
          where cs.app_id=$1 and cs.customer_id=$2 and cs.status='draft' and cs.applied_order is null
            and cs.written_fields ? $3)
    )$candidates$,record_table,case when model_json->>'kind'='lookup' then ' and r.model_id=$3' else '' end,record_filter)
    -- Each pending draft's version effective at as_of and the fields it
    -- wrote (shared with staging's no-op check).
      || ', draft_versions as materialized ('
      || kernel_read_draft_versions_sql(draft_values_sql,draft_custom_sql,version_table,draft_version_filter)
      || format($applicable$),
    draft_applicable as materialized (
      -- The draft versions the preview applies; `shown` when mainline shows
      -- the record, else the version creates it (no mainline version at all).
      select d.*,c.record_id is not null as shown
      from draft_versions d left join canonical_source c on c.record_id=d.record_id
      where case when c.record_id is not null then d.effective_start>=(c.r->>'effective_start')::date
        else not exists (
          select 1 from %I v join change_set cs on cs.id=v.change_set_id
            and cs.app_id=v.app_id and cs.customer_id=v.customer_id
            and cs.status='mainline' and cs.applied_order is not null
          where v.record_id=d.record_id and v.app_id=$1 and v.customer_id=$2
            and v.stage='mainline'%s) end
    ),
    draft_lifecycle as materialized (
      -- The latest saved applicable draft decides whether its record shows;
      -- a record mainline does not show is created by the earliest saved
      -- applicable draft that does not delete it.
      select distinct on (record_id) record_id,lifecycle,shown,version_id,effective_start,effective_end,
        first_value(change_set_id) over (partition by record_id order by lifecycle,created_order,change_set_id) creator
      from draft_applicable
      order by record_id,created_order desc,change_set_id desc
    ),$applicable$,version_table,case when model_json->>'kind'='lookup' then ' and v.model_id=$3' else '' end)
      || $drafts$
    draft_changes as materialized (
      -- The latest saved draft's value of each field it wrote; a written
      -- field the draft version does not hold was cleared.
      select distinct on (d.record_id,change.field_id) d.record_id,change.field_id,change.source,change.value,d.change_set_id
      from draft_applicable d
      cross join lateral (
        select written.field_id,field.value->>'source' source,
          coalesce(case when field.value->>'source'='base' then d.draft_values else d.draft_custom end->written.field_id,'null'::jsonb) value
        from jsonb_array_elements_text(d.written) written(field_id)
        join jsonb_each($15) field on field.key=written.field_id
        where field.value->>'source' in ('base','custom') and not field.value ? 'expression'$drafts$
      || case when jsonb_array_length(draft_relation_ids)=0 then '' else format($relations$
        union all
        select written.field_id,'relation',coalesce(d.draft_relations->written.field_id,'[]'::jsonb)
        from jsonb_array_elements_text(d.written) written(field_id)
        where %L::jsonb ? written.field_id$relations$,draft_relation_ids::text) end
      || $drafts$
      ) change
      where not d.lifecycle and (change.source='relation' or $16::jsonb is null or $16 ? change.field_id)
      order by d.record_id,change.field_id,d.created_order desc,d.change_set_id desc
    ),
    draft_records as materialized (
      select record_id,
        coalesce(jsonb_object_agg(field_id,value) filter (where source='base' and value<>'null'::jsonb),'{}'::jsonb) base_set,
        coalesce(array_agg(field_id) filter (where source='base'),'{}'::text[]) base_keys,
        coalesce(jsonb_agg(value||jsonb_build_object('field_id',field_id)) filter (where source='custom' and value<>'null'::jsonb),'[]'::jsonb) custom_set,
        array_agg(field_id) filter (where source='custom') custom_keys,
        jsonb_object_agg(field_id,value) filter (where source='relation') relation_set,
        jsonb_object_agg(field_id,change_set_id) sources
      from draft_changes group by record_id
    ),
    -- Pending drafts overlay mainline; staged entries then overlay both.
    -- Read once, by policy_source, so it is inlined rather than materialized.
    -- A created record's grants are checked on its draft image, as it has
    -- no canonical one.
    drafted_source as (
      select c.record_id,case when d.record_id is null then c.r
        else c.r||jsonb_build_object(
          'values',((c.r->'values')-d.base_keys)||d.base_set,
          'custom_fields',case when d.custom_keys is null then c.r->'custom_fields'
            else coalesce((select jsonb_agg(item) from jsonb_array_elements(c.r->'custom_fields') item
              where not (item->>'field_id'=any(d.custom_keys))),'[]'::jsonb)||d.custom_set end,
          'many_relations',coalesce(c.r->'many_relations','{}'::jsonb)||coalesce(d.relation_set,'{}'::jsonb),
          'pending_draft',jsonb_build_object('fields',d.sources)) end as r,
        c.r as canonical,coalesce(d.base_keys,'{}'::text[]) as draft_keys
      from canonical_source c left join draft_records d on d.record_id=c.record_id
        left join draft_lifecycle l on l.record_id=c.record_id
      where not coalesce(l.lifecycle,false)
      union all
      select created.record_id,created.r,created.r,created.draft_keys from (
        select l.record_id,jsonb_build_object('record_id',l.record_id,'version_id',l.version_id,'external_key',k.external_key,
          'effective_start',to_char(l.effective_start,'YYYY-MM-DD'),'effective_end',to_char(l.effective_end,'YYYY-MM-DD'),
          'values',coalesce(d.base_set,'{}'::jsonb),'custom_fields',coalesce(d.custom_set,'[]'::jsonb),
          'metadata','{}'::jsonb,'many_relations',coalesce(d.relation_set,'{}'::jsonb),
          'pending_draft',jsonb_build_object('created',l.creator,'fields',coalesce(d.sources,'{}'::jsonb))) r,
          coalesce(d.base_keys,'{}'::text[]) draft_keys
        from draft_lifecycle l join draft_candidates k on k.record_id=l.record_id
          left join draft_records d on d.record_id=l.record_id
        where not l.shown and not l.lifecycle
      ) created
    )$drafts$;
    -- A staged value replaces a draft's: that field no longer comes from it
    -- (and a row left naming no draft carries no `pending_draft`).
    draft_overlay_sql := $overlay$ || case when c.r ? 'pending_draft' then jsonb_build_object('pending_draft',
            (c.r->'pending_draft')||jsonb_build_object('fields',((c.r#>'{pending_draft,fields}')-o.base_keys)-coalesce(o.custom_keys,'{}'::text[])))
            else '{}'::jsonb end$overlay$;
  else
    draft_ctes := '';
  end if;
  source_sql := format($query$
    with overlay_records as materialized (
      -- Each staged record's values, split by declared and custom field, so
      -- the overlay is applied with plain JSON operators. Entries for
      -- archived, inactive or derived fields are not applied.
      select w.record_id,
        coalesce(jsonb_object_agg(w.field_id,w.value) filter (where f.source='base' and w.value<>'null'::jsonb),'{}'::jsonb) base_set,
        coalesce(array_agg(w.field_id) filter (where f.source='base'),'{}'::text[]) base_keys,
        coalesce(jsonb_agg(w.value||jsonb_build_object('field_id',w.field_id)) filter (where f.source='custom' and w.value<>'null'::jsonb),'[]'::jsonb) custom_set,
        array_agg(w.field_id) filter (where f.source='custom') custom_keys
      from work_session_record w
      join (
        select field.key field_id,field.value->>'source' source from jsonb_each($15) field
        where field.value->>'source' in ('base','custom') and not field.value ? 'expression'
      ) f on f.field_id=w.field_id
      where $13::jsonb is not null and w.app_id=$1 and w.customer_id=$2 and w.session_id=($13->>'session_id')::uuid
        and w.model_id=$3 and coalesce(w.rule_id<>$13->>'exclude_rule_id',true)
        and ($16::jsonb is null or $16 ? w.field_id)
      group by w.record_id
    )%s, canonical_source as materialized (
    select r.id record_id,jsonb_build_object('record_id',r.id,'version_id',v.id,'external_key',r.external_key,
      'effective_start',to_char(v.effective_start,'YYYY-MM-DD'),
      'effective_end',case when v.effective_end is null then null else to_char(v.effective_end,'YYYY-MM-DD') end,
      'values',(%s),'custom_fields',%s,
      'metadata',coalesce(v.metadata,'{}'::jsonb),'many_relations',%s) as r
    from %I r join lateral (
      select v.* from %I v join change_set cs on cs.id=v.change_set_id
        and cs.app_id=v.app_id and cs.customer_id=v.customer_id
        and cs.status='mainline' and cs.applied_order is not null
      where v.record_id=r.id and v.app_id=r.app_id and v.customer_id=r.customer_id
        and v.stage='mainline' and v.effective_start<=$5 and (v.effective_end is null or v.effective_end>=$5)%s
      order by v.effective_start desc,v.tombstones_record desc,v.untombstones_record desc,cs.applied_order desc,v.id desc limit 1
    ) v on true
    where r.app_id=$1 and r.customer_id=$2 and not v.tombstones_record and not v.untombstones_record%s
    )%s,
    policy_source as materialized (
      select case when o.record_id is null then c.r
        else %s(c.r||jsonb_build_object(
          'values',((c.r->'values')-o.base_keys)||o.base_set,
          'custom_fields',case when o.custom_keys is null then c.r->'custom_fields'
            else coalesce((select jsonb_agg(item) from jsonb_array_elements(c.r->'custom_fields') item
              where not (item->>'field_id'=any(o.custom_keys))),'[]'::jsonb)||o.custom_set end)%s) end as r,
        %s as overlaid
      from %s c left join overlay_records o on o.record_id=c.record_id
      where %s
    ),
    -- Record grants apply to the canonical image above and, when staged or
    -- draft values change a record-predicate field, to the overlaid image too.
    authorized_source as materialized (
      select r from policy_source
      where (not policy_source.overlaid or %s) and (%s)
    )
    select %s from authorized_source%s
  $query$,relation_ctes,values_expression,custom_expression,
    -- Only models with many relations store them; avoid a whole-row conversion otherwise.
    case when model_json->>'kind'='lookup' or jsonb_array_length(coalesce(model_json->'many_relations','[]'::jsonb))>0
      then 'coalesce(to_jsonb(v)->''many_relations'',''{}''::jsonb)' else '''{}''::jsonb' end,
    record_table,version_table,lookup_filter,retired_filter||record_filter,draft_ctes,
    case when include_drafts then 'kernel_read_pending_draft_row' else '' end,draft_overlay_sql,
    -- An image is overlaid when staged or draft values change a record-predicate field.
    case when include_drafts then 'coalesce((o.base_keys||c.draft_keys)&&$17,c.draft_keys&&$17,false)'
      else 'coalesce(o.base_keys&&$17,false)' end,
    case when include_drafts then 'drafted_source' else 'canonical_source' end,
    -- Record grants as one per-query predicate (see kernel_policy_grants_record_sql).
    -- The canonical image is checked on the mainline row (before any overlay).
    case when authorization_policy is null then 'true'
      else kernel_policy_grants_record_sql(authorization_grants,authorization_fields,
        case when include_drafts then 'c.canonical->''values''' else 'c.r->''values''' end) end,
    case when authorization_policy is null then 'true'
      else kernel_policy_grants_record_sql(authorization_grants,authorization_fields,'policy_source.r->''values''') end,
    relation_predicate,
    -- A stored entry never surfaces under a derived or computed id: only the
    -- evaluated value (or nothing, for null) is returned under that id. A
    -- request that reads no derived id returns no entry under one (select
    -- and projection keep only read fields), so it skips this per-row filter.
    case when derived_entries_sql='' then 'r'
      else format('authorized_source.r || jsonb_build_object(''custom_fields'',coalesce((select jsonb_agg(stored.value order by stored.ordinal) from jsonb_array_elements(authorized_source.r->''custom_fields'') with ordinality stored(value,ordinal) where not %L::jsonb ? (stored.value->>''field_id'')),''[]''::jsonb)%s) as r',derived_ids::text,derived_entries_sql) end,
    case when derived_entries_sql='' then ''
      else ' cross join lateral (select kernel_read_custom_field_map($4,$3,authorized_source.r->''custom_fields'') as custom_map) derived_source' end);
  if request->>'kind'='aggregate' then
    group_order_sql := group_order_sql || case when group_order_sql='' then '' else ',' end || 'key';
    query_sql := format($aggregate$
      with visible as materialized (select r from (%s) source where %s),
      eligible as materialized (select r from visible where %s),
      -- CASE below evaluates metrics only after this bounded key count succeeds.
      group_limit as (select count(*) as n from (select distinct %s as key from eligible limit 101) keys),
      grouped as (
        select %s as key,jsonb_build_array(%s) as metrics
        from eligible group by 1 order by 1 limit 101
      )
      select case when (select n from group_limit)>100 then null else jsonb_build_object(
        'as_of',$5,'units',(select jsonb_build_array(%s) from eligible group by ()),
        'groups',coalesce((select jsonb_agg(to_jsonb(grouped) order by %s) from grouped),'[]'::jsonb),
        'total',(select jsonb_build_object('metrics',jsonb_build_array(%s)) from eligible)
      ) %s end
    $aggregate$,source_sql,predicate,eligible_predicate,group_expression,group_expression,metric_sql,units_sql,group_order_sql,total_metric_sql,
      case when money_bins then ' || jsonb_build_object(''other_units'',(select count(*)::text from visible where not (' || eligible_predicate || ')))' else '' end);
    execute query_sql using request->>'app_id',request->>'customer_id',request->>'model_id',schema_json,request_date,null::integer,null::integer,authorization_policy,authorization_fields,source_record_id::text,request,search_query,work_state,authorization_grants,derived_environment,value_projection,predicate_fields into result;
    if result is null then raise exception 'query_rejected: group limit exceeded'; end if;
  else
    -- A private scan returns every row unordered; pages are ordered.
    query_sql := format('select coalesce(jsonb_agg(%s),''[]''::jsonb) from (select r from (%s) visible where %s %s) p',case when work_rule_scan then 'r' else replace(response_expression,'r->','p.r->') end,source_sql,predicate,case when work_rule_scan then '' else 'order by '||ordering_sql||' limit $6 offset $7' end);
    execute query_sql using request->>'app_id',request->>'customer_id',request->>'model_id',schema_json,request_date,page_size,page_offset,authorization_policy,authorization_fields,source_record_id::text,request,search_query,work_state,authorization_grants,derived_environment,value_projection,predicate_fields into result;
  end if;
  return jsonb_build_object('ok',true,'data',result);
exception when others then
  return jsonb_build_object('ok',false,'error',kernel_read_error_envelope(sqlstate,sqlerrm));
end;
$kernel$
