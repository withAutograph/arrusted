mod contracts;
mod db;
mod error;
mod expressions;
mod identifiers;
mod iso_codes;
mod postgres_connection;
mod sql_parity;

/// Canonical transport for databases installed by the generated SQL runtime.
/// These operations never fall back to the reference Rust storage implementation.
pub mod generated {
    pub use crate::contracts::SourceIdentityMatchPolicy;
    pub use crate::sql_parity::{
        apply_generated_sql_change_set_in_transaction, begin_generated_sql_tenant_transaction,
        call_generated_sql, decode_generated_sql_result,
        read_generated_sql_visible_record_for_update_in_transaction,
        read_generated_sql_visible_records_by_text_fields_in_transaction,
        read_generated_sql_visible_records_in_transaction, GeneratedSqlFunction,
    };
}
mod validation;

mod facade;

pub mod api {
    pub use crate::contracts::{
        AgentRunLedgerEntry, AgentRunStatus, AgentRunStatusUpdate, App, AppId, AppIdentity,
        ApplyChangeSet, ApplyMode, AtomicApplyDryRunRequest, ChangeSetDiff, ChangeSetDiffRequest,
        ChangeSetStatus, ChangeType, ChangeTypeId, CommitEnumOptionSetRevision,
        CustomFieldDefinition, CustomFieldDefinitionId, CustomFieldDiff, CustomFieldEntry,
        CustomFieldType, CustomFieldValue, CustomerId, EntityExtensionCapabilities,
        EnumAuditHydratedValue, EnumOption, EnumOptionId, EnumOptionSetTarget, ExternalKey, Field,
        FieldDiff, FieldHistoryEntry, FieldHistoryRequest, FieldId, FieldType, FieldValue,
        InstallerPrincipalScopeBindingRequest, InstallerPrincipalScopeBindingResult,
        LookupAliasTransferRequest, LookupHydrateRequest, LookupHydratedReference,
        LookupHydrationReference, LookupLabelSnapshot, LookupListRequest, LookupPageCursor,
        LookupRecordView, LookupReferenceCount, LookupReferenceCountRequest,
        LookupResolveBatchRequest, LookupResolvedRecord, LookupSetAvailabilityRequest,
        LookupSetAvailabilityResult, ManyRelationDefinition, Model, ModelId, ModelKind,
        MoneyRatePeriod, MoneyRateValue, PrincipalScopeCapability, QueryColumn, QueryResult,
        QueryVisibleSql, RecentActivityEntry, RecentActivityRequest, RecordDiff, RecordId,
        RecordKey, RecordMetadataLimits, RecordMetadataPatch, RecordOptionsRequest,
        RecordsByModelRequest, RevertChangeSet, RowVersionWrite, Schema, SchemaElementLifecycle,
        SchemaElementOrigin, SchemaManagementPolicy, SchemaRevisionId, SchemaVersion, SqlParam,
        TenantCreateModelInput, TenantSchemaAffectedReference, TenantSchemaOperation,
        TenantSchemaRevisionDryRunResult, TenantSchemaRevisionRequest, TenantSchemaRevisionResult,
        VersionStage, AGENT_SOURCE_KIND, LOOKUP_LIFECYCLE_FIELD_ID, RECORD_METADATA_FIELD_ID,
    };
    pub use crate::db::{
        ActiveSchemaRevision, AppliedChangeSet, DraftRecord, DraftSummary,
        ReadVisibleRecordsByModelRequest, SchemaRevisionProvenance, StoredAgentRun, VisibleRecord,
    };
    pub use crate::error::{
        ErrorDetail, ErrorEnvelope, KernelError, KernelErrorDto, ValidationError, ValidationIssue,
    };
    pub use crate::expressions::{
        Aggregate, Comparison, ConstraintExpr, DerivedExpr, TypedLiteral,
    };
    pub use crate::facade::{
        apply_change_set, apply_change_set_in_transaction, approve_draft_change_set,
        begin_tenant_transaction, change_set_diff, commit_enum_option_set_revision,
        discard_draft_change_set, ensure_schema_activation_head_policy, field_history,
        list_draft_change_sets, materialize_schema, materialize_schema_with_provenance,
        materialize_schema_with_provenance_guarded, preflight_schema_materialization,
        preflight_schema_materialization_guarded, query_visible_sql, read_active_schema_revision,
        read_draft_change_set, read_visible_record, read_visible_record_for_update_in_transaction,
        read_visible_records, read_visible_records_by_model,
        read_visible_records_by_text_fields_in_transaction, read_visible_records_in_transaction,
        recent_activity, reconcile_schema_materialization_policies, record_agent_run,
        revert_change_set, schema_hash, schema_revision_is_active_with_materialized_tables,
        update_agent_run_status, update_draft_notes, validate_change_set_dry_run,
        validate_change_sets_dry_run,
    };
    pub use crate::identifiers::{bounded_physical_identifier, normalize_identifier};
    pub use crate::iso_codes::{is_iso_3166_1_alpha_2, is_iso_4217_tender_currency};
    pub use crate::postgres_connection::{
        connect_postgres, describe_postgres_connection_target, postgres_connection_config,
        postgres_connection_targets_match, PostgresConnectionError, PostgresConnectionTarget,
    };
    pub use crate::sql_parity::{
        apply_generated_sql_change_set_in_transaction, begin_generated_sql_tenant_transaction,
        call_generated_sql, read_generated_sql_recent_activity,
        read_generated_sql_visible_record_for_update_in_transaction,
        read_generated_sql_visible_records,
        read_generated_sql_visible_records_by_text_fields_in_transaction,
        read_generated_sql_visible_records_in_transaction, GeneratedSqlFunction,
    };
    pub use crate::validation::{
        validate_agent_run_ledger_entry, validate_agent_run_status_update, validate_app,
        validate_apply_against_schema, validate_schema, validate_schema_revision,
    };
}

/// Internal test escape hatch for kernel integration tests.
///
/// Production consumers must use the public API facade, which returns
/// `KernelError`, not `DbError`.
#[cfg(feature = "testing")]
pub mod testing {
    pub use crate::db::{
        apply_change_set, apply_change_set_in_transaction, approve_draft_change_set,
        begin_tenant_transaction, change_set_diff, commit_enum_option_set_revision,
        discard_draft_change_set, field_history, list_draft_change_sets, materialize_schema,
        materialize_schema_with_provenance, preflight_schema_materialization, query_visible_sql,
        read_active_schema_revision, read_draft_change_set, read_visible_record,
        read_visible_record_for_update_in_transaction, read_visible_records,
        read_visible_records_by_model, read_visible_records_by_text_fields_in_transaction,
        read_visible_records_in_transaction, recent_activity,
        reconcile_schema_materialization_policies, record_agent_run, revert_change_set,
        schema_hash, schema_revision_is_active_with_materialized_tables, update_agent_run_status,
        update_draft_notes, validate_change_set_dry_run, validate_change_sets_dry_run, DbError,
        ReadVisibleRecordsByModelRequest, SchemaRevisionProvenance,
    };
    pub use crate::sql_parity::{
        apply_generated_sql_change_set_in_transaction, begin_generated_sql_tenant_transaction,
        call_generated_sql, decode_generated_sql_result,
        read_generated_sql_visible_record_for_update_in_transaction,
        read_generated_sql_visible_records_by_text_fields_in_transaction,
        read_generated_sql_visible_records_in_transaction, GeneratedSqlFunction,
    };
}

pub use api::*;
