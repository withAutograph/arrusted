-- Apply one record's staged values to its canonical read image. `entries`
-- holds {field_id, value}; `environment` is the model's derived environment,
-- so entries for archived, inactive or derived fields are not applied.
create or replace function kernel_work_overlay_row(row_image jsonb, entries jsonb, environment jsonb)
returns jsonb language plpgsql immutable security invoker set search_path from current
as $kernel$
declare
  entry jsonb;
  target jsonb;
  field_id text;
  values_json jsonb := row_image->'values';
  custom_json jsonb := coalesce(row_image->'custom_fields', '[]'::jsonb);
begin
  for entry in select value from jsonb_array_elements(entries) loop
    field_id := entry->>'field_id';
    target := environment->field_id;
    if target is null or target ? 'expression' then continue; end if;
    if target->>'source' = 'custom' then
      custom_json := coalesce((
        select jsonb_agg(item) from jsonb_array_elements(custom_json) item where item->>'field_id' <> field_id
      ), '[]'::jsonb);
      if entry->'value' <> 'null'::jsonb then
        custom_json := custom_json || jsonb_build_array(entry->'value' || jsonb_build_object('field_id', field_id));
      end if;
    else
      values_json := values_json - field_id;
      if entry->'value' <> 'null'::jsonb then
        values_json := values_json || jsonb_build_object(field_id, entry->'value');
      end if;
    end if;
  end loop;
  return row_image || jsonb_build_object('values', values_json, 'custom_fields', custom_json);
end;
$kernel$
