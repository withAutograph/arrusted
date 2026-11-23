use std::collections::BTreeMap;

use chrono::NaiveDate;
use postgres::{Client, GenericClient, Transaction};

use crate::contracts::{
    AgentRunLedgerEntry, AgentRunStatusUpdate, AppId, ApplyChangeSet, ChangeSetDiff,
    ChangeSetDiffRequest, CommitEnumOptionSetRevision, CustomerId, EnumOption, FieldHistoryEntry,
    FieldHistoryRequest, FieldId, ModelId, QueryResult, QueryVisibleSql, RecentActivityEntry,
    RecentActivityRequest, RecordId, RevertChangeSet, Schema, SchemaRevisionId,
};
use crate::db::{
    self, ActiveSchemaRevision, AppliedChangeSet, DraftRecord, DraftSummary,
    ReadVisibleRecordsByModelRequest, SchemaRevisionProvenance, StoredAgentRun, VisibleRecord,
};
use crate::error::KernelError;

pub fn materialize_schema(
    client: &mut Client,
    schema: &Schema,
) -> Result<SchemaRevisionId, KernelError> {
    db::materialize_schema(client, schema).map_err(KernelError::from)
}

pub fn preflight_schema_materialization(
    client: &mut Client,
    schema: &Schema,
) -> Result<(), KernelError> {
    db::preflight_schema_materialization(client, schema).map_err(KernelError::from)
}

pub fn reconcile_schema_materialization_policies(
    client: &mut Client,
    schema: &Schema,
) -> Result<(), KernelError> {
    db::reconcile_schema_materialization_policies(client, schema).map_err(KernelError::from)
}

pub fn ensure_schema_activation_head_policy(
    client: &mut Client,
    schema: &Schema,
) -> Result<(), KernelError> {
    db::ensure_schema_activation_head_policy(client, schema).map_err(KernelError::from)
}

pub fn preflight_schema_materialization_guarded<F>(
    client: &mut Client,
    schema: &Schema,
    guard: F,
) -> Result<(), KernelError>
where
    F: FnOnce(&mut Transaction<'_>) -> Result<(), KernelError>,
{
    db::preflight_schema_materialization_guarded(client, schema, guard)
}

pub fn materialize_schema_with_provenance(
    client: &mut Client,
    schema: &Schema,
    provenance: &SchemaRevisionProvenance,
) -> Result<SchemaRevisionId, KernelError> {
    db::materialize_schema_with_provenance(client, schema, Some(provenance))
        .map_err(KernelError::from)
}

pub fn materialize_schema_with_provenance_guarded<F>(
    client: &mut Client,
    schema: &Schema,
    provenance: &SchemaRevisionProvenance,
    guard: F,
) -> Result<SchemaRevisionId, KernelError>
where
    F: FnOnce(&mut Transaction<'_>) -> Result<(), KernelError>,
{
    db::materialize_schema_with_provenance_guarded(client, schema, Some(provenance), guard)
}

pub fn schema_hash(schema: &Schema) -> String {
    db::schema_hash(schema)
}

pub fn schema_revision_is_active_with_materialized_tables(
    client: &mut Client,
    schema: &Schema,
) -> Result<bool, KernelError> {
    db::schema_revision_is_active_with_materialized_tables(client, schema)
        .map_err(KernelError::from)
}

pub fn read_active_schema_revision(
    client: &mut Client,
    app_id: &AppId,
    customer_id: &CustomerId,
) -> Result<ActiveSchemaRevision, KernelError> {
    db::read_active_schema_revision(client, app_id, customer_id).map_err(KernelError::from)
}

pub fn commit_enum_option_set_revision(
    client: &mut Client,
    request: &CommitEnumOptionSetRevision,
) -> Result<Vec<EnumOption>, KernelError> {
    db::commit_enum_option_set_revision(client, request).map_err(KernelError::from)
}

pub fn apply_change_set(
    client: &mut Client,
    apply: &ApplyChangeSet,
) -> Result<AppliedChangeSet, KernelError> {
    db::apply_change_set(client, apply).map_err(KernelError::from)
}

pub fn begin_tenant_transaction<'a>(
    client: &'a mut Client,
    app_id: &AppId,
    customer_id: &CustomerId,
) -> Result<Transaction<'a>, KernelError> {
    db::begin_tenant_transaction(client, app_id, customer_id).map_err(KernelError::from)
}

pub fn apply_change_set_in_transaction(
    tx: &mut impl GenericClient,
    apply: &ApplyChangeSet,
) -> Result<AppliedChangeSet, KernelError> {
    db::apply_change_set_in_transaction(tx, apply).map_err(KernelError::from)
}

pub fn validate_change_set_dry_run(
    client: &mut Client,
    apply: &ApplyChangeSet,
) -> Result<AppliedChangeSet, KernelError> {
    db::validate_change_set_dry_run(client, apply).map_err(KernelError::from)
}

pub fn validate_change_sets_dry_run(
    client: &mut Client,
    applies: &[ApplyChangeSet],
) -> Result<Vec<AppliedChangeSet>, KernelError> {
    db::validate_change_sets_dry_run(client, applies).map_err(KernelError::from)
}

pub fn record_agent_run(
    client: &mut Client,
    run: &AgentRunLedgerEntry,
) -> Result<StoredAgentRun, KernelError> {
    db::record_agent_run(client, run).map_err(KernelError::from)
}

pub fn update_agent_run_status(
    client: &mut Client,
    update: &AgentRunStatusUpdate,
) -> Result<StoredAgentRun, KernelError> {
    db::update_agent_run_status(client, update).map_err(KernelError::from)
}

pub fn list_draft_change_sets(
    client: &mut Client,
    app_id: &AppId,
    customer_id: &CustomerId,
) -> Result<Vec<DraftSummary>, KernelError> {
    db::list_draft_change_sets(client, app_id, customer_id).map_err(KernelError::from)
}

pub fn read_draft_change_set(
    client: &mut Client,
    app_id: &AppId,
    customer_id: &CustomerId,
    change_set_id: i64,
) -> Result<Vec<DraftRecord>, KernelError> {
    db::read_draft_change_set(client, app_id, customer_id, change_set_id).map_err(KernelError::from)
}

pub fn approve_draft_change_set(
    client: &mut Client,
    app_id: &AppId,
    customer_id: &CustomerId,
    change_set_id: i64,
) -> Result<AppliedChangeSet, KernelError> {
    db::approve_draft_change_set(client, app_id, customer_id, change_set_id)
        .map_err(KernelError::from)
}

pub fn discard_draft_change_set(
    client: &mut Client,
    app_id: &AppId,
    customer_id: &CustomerId,
    change_set_id: i64,
) -> Result<AppliedChangeSet, KernelError> {
    db::discard_draft_change_set(client, app_id, customer_id, change_set_id)
        .map_err(KernelError::from)
}

pub fn revert_change_set(
    client: &mut Client,
    request: &RevertChangeSet,
) -> Result<AppliedChangeSet, KernelError> {
    db::revert_change_set(client, request).map_err(KernelError::from)
}

pub fn update_draft_notes(
    client: &mut Client,
    app_id: &AppId,
    customer_id: &CustomerId,
    change_set_id: i64,
    notes: Option<String>,
) -> Result<(), KernelError> {
    db::update_draft_notes(client, app_id, customer_id, change_set_id, notes)
        .map_err(KernelError::from)
}

pub fn read_visible_records(
    client: &mut Client,
    app_id: &AppId,
    customer_id: &CustomerId,
    model_id: &ModelId,
    as_of: NaiveDate,
) -> Result<Vec<VisibleRecord>, KernelError> {
    db::read_visible_records(client, app_id, customer_id, model_id, as_of)
        .map_err(KernelError::from)
}

pub fn read_visible_records_in_transaction(
    tx: &mut impl GenericClient,
    app_id: &AppId,
    customer_id: &CustomerId,
    model_id: &ModelId,
    as_of: NaiveDate,
) -> Result<Vec<VisibleRecord>, KernelError> {
    db::read_visible_records_in_transaction(tx, app_id, customer_id, model_id, as_of)
        .map_err(KernelError::from)
}

pub fn read_visible_records_by_text_fields_in_transaction(
    tx: &mut impl GenericClient,
    app_id: &AppId,
    customer_id: &CustomerId,
    model_id: &ModelId,
    as_of: NaiveDate,
    field_filters: &BTreeMap<FieldId, String>,
) -> Result<Vec<VisibleRecord>, KernelError> {
    db::read_visible_records_by_text_fields_in_transaction(
        tx,
        app_id,
        customer_id,
        model_id,
        as_of,
        field_filters,
    )
    .map_err(KernelError::from)
}

pub fn read_visible_record(
    client: &mut Client,
    app_id: &AppId,
    customer_id: &CustomerId,
    model_id: &ModelId,
    record_id: &RecordId,
    as_of: NaiveDate,
) -> Result<Option<VisibleRecord>, KernelError> {
    db::read_visible_record(client, app_id, customer_id, model_id, record_id, as_of)
        .map_err(KernelError::from)
}

pub fn read_visible_record_for_update_in_transaction(
    tx: &mut impl GenericClient,
    app_id: &AppId,
    customer_id: &CustomerId,
    model_id: &ModelId,
    record_id: &RecordId,
    as_of: NaiveDate,
) -> Result<Option<VisibleRecord>, KernelError> {
    db::read_visible_record_for_update_in_transaction(
        tx,
        app_id,
        customer_id,
        model_id,
        record_id,
        as_of,
    )
    .map_err(KernelError::from)
}

pub fn read_visible_records_by_model(
    client: &mut Client,
    app_id: &AppId,
    customer_id: &CustomerId,
    request: ReadVisibleRecordsByModelRequest<'_>,
) -> Result<BTreeMap<ModelId, Vec<VisibleRecord>>, KernelError> {
    db::read_visible_records_by_model(client, app_id, customer_id, request)
        .map_err(KernelError::from)
}

pub fn query_visible_sql(
    client: &mut Client,
    request: &QueryVisibleSql,
) -> Result<QueryResult, KernelError> {
    db::query_visible_sql(client, request).map_err(KernelError::from)
}

pub fn change_set_diff(
    client: &mut Client,
    request: &ChangeSetDiffRequest,
) -> Result<ChangeSetDiff, KernelError> {
    db::change_set_diff(client, request).map_err(KernelError::from)
}

pub fn field_history(
    client: &mut Client,
    request: &FieldHistoryRequest,
) -> Result<Vec<FieldHistoryEntry>, KernelError> {
    db::field_history(client, request).map_err(KernelError::from)
}

pub fn recent_activity(
    client: &mut Client,
    request: &RecentActivityRequest,
) -> Result<Vec<RecentActivityEntry>, KernelError> {
    db::recent_activity(client, request).map_err(KernelError::from)
}
