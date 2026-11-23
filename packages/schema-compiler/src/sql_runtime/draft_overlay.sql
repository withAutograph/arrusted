-- The select of each pending draft's version of a record effective at as_of
-- ($5), with its id, dates and lifecycle (a tombstone deletes the record),
-- the values (and many relations) it holds and the fields the
-- draft wrote for that record at or before that version's date (`written`, a
-- jsonb array of field ids), as recorded in its change set's `written_fields` when it was saved.
-- A draft that writes several dates keeps every field it wrote, as approving
-- it would publish them. Reads overlaying pending drafts and staging's no-op
-- check share it, so both agree on which fields a draft wrote. $1/$2 are the
-- app and customer; the value expressions and filters may use $3 (model id)
-- and $4 (schema).
create or replace function kernel_read_draft_versions_sql(
  draft_values_sql text,
  draft_custom_sql text,
  version_table text,
  draft_version_filter text
)
returns text
language sql
immutable
as $kernel$
  select format($drafts$
      select distinct on (dv.record_id,dv.change_set_id) dv.record_id,dv.change_set_id,dcs.created_order,
        dv.id version_id,dv.effective_start,dv.effective_end,dv.tombstones_record or dv.untombstones_record as lifecycle,
        (%1$s) draft_values,%2$s draft_custom,%5$s draft_relations,
        coalesce((select jsonb_agg(distinct written.field_id)
          from jsonb_each(dcs.written_fields->$3->(dv.record_id::text)) dated(effective_start,fields)
          cross join jsonb_array_elements_text(dated.fields) written(field_id)
          where dated.effective_start::date<=dv.effective_start),'[]'::jsonb) written
      from %3$I dv join change_set dcs on dcs.id=dv.change_set_id
        and dcs.app_id=dv.app_id and dcs.customer_id=dv.customer_id
        and dcs.status='draft' and dcs.applied_order is null
      where dv.app_id=$1 and dv.customer_id=$2 and dv.stage='draft' and dv.effective_start<=$5%4$s
      order by dv.record_id,dv.change_set_id,dv.effective_start desc,dv.tombstones_record desc,dv.untombstones_record desc,dv.id desc
$drafts$,draft_values_sql,draft_custom_sql,version_table,draft_version_filter,
    -- Only lookup versions store many relations.
    case when version_table='lookup_version' then 'coalesce(dv.many_relations,''{}''::jsonb)' else '''{}''::jsonb' end)
$kernel$;

-- A read row without an empty `pending_draft`: it is kept only when it names
-- the draft creating the record or at least one field's draft (staged values
-- and a select can leave it naming neither).
create or replace function kernel_read_pending_draft_row(row_image jsonb)
returns jsonb
language sql
immutable
as $kernel$
  select case when row_image ? 'pending_draft'
      and not row_image->'pending_draft' ? 'created'
      and coalesce(row_image#>'{pending_draft,fields}','{}'::jsonb)='{}'::jsonb
    then row_image-'pending_draft' else row_image end
$kernel$;
