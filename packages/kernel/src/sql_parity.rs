use std::collections::BTreeMap;

use chrono::NaiveDate;
use postgres::error::SqlState;
use postgres::GenericClient;
use postgres::{Client, Transaction};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use crate::contracts::{
    AppId, ApplyChangeSet, CustomerId, FieldId, ModelId, RecentActivityEntry,
    RecentActivityRequest, RecordId,
};
use crate::db::{AppliedChangeSet, VisibleRecord};
use crate::error::{ErrorEnvelope, KernelError, KernelErrorDto};

const DATABASE_ERROR_MESSAGE: &str = "Database operation failed";
const SERIALIZATION_ERROR_MESSAGE: &str = "Kernel serialization failed";
const APPLY_DEPENDENCY_DRIFT_MESSAGE: &str = "record apply dependency drift";

/// Canonical generated SQL entrypoints for installed runtime consumers and parity tests.
///
/// Each variant maps to a complete static statement. Request data is bound only
/// as `$1::jsonb`, so callers cannot influence a SQL identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum GeneratedSqlFunction {
    ApplyChangeSet,
    ApplyChangeSetInTransaction,
    ApplySeedDefaults,
    ApproveDraftChangeSet,
    ChangeSetDiff,
    CommitTenantSchemaRevision,
    DataQuery,
    DiscardDraftChangeSet,
    DryRunTenantSchemaRevision,
    FieldHistory,
    ListDraftChangeSets,
    LookupHydrate,
    LookupList,
    LookupReferenceCount,
    LookupResolveBatch,
    LookupSetAvailability,
    LookupTransferAlias,
    QueryVisibleSql,
    ReadActiveSchemaRevision,
    ReadDraftChangeSet,
    ReadVisibleRecord,
    ReadVisibleRecordForUpdate,
    ReadVisibleRecords,
    ReadVisibleRecordsByModel,
    ReadVisibleRecordsByTextFields,
    RecentActivity,
    RecordAgentRun,
    RevertChangeSet,
    UpdateAgentRunStatus,
    UpdateDraftNotes,
    ValidateChangeSetDryRun,
    ValidateChangeSetsDryRun,
}

impl GeneratedSqlFunction {
    pub const ALL: [Self; 32] = [
        Self::ApplyChangeSet,
        Self::ApplyChangeSetInTransaction,
        Self::ApplySeedDefaults,
        Self::ApproveDraftChangeSet,
        Self::ChangeSetDiff,
        Self::CommitTenantSchemaRevision,
        Self::DataQuery,
        Self::DiscardDraftChangeSet,
        Self::DryRunTenantSchemaRevision,
        Self::FieldHistory,
        Self::ListDraftChangeSets,
        Self::LookupHydrate,
        Self::LookupList,
        Self::LookupReferenceCount,
        Self::LookupResolveBatch,
        Self::LookupSetAvailability,
        Self::LookupTransferAlias,
        Self::QueryVisibleSql,
        Self::ReadActiveSchemaRevision,
        Self::ReadDraftChangeSet,
        Self::ReadVisibleRecord,
        Self::ReadVisibleRecordForUpdate,
        Self::ReadVisibleRecords,
        Self::ReadVisibleRecordsByModel,
        Self::ReadVisibleRecordsByTextFields,
        Self::RecentActivity,
        Self::RecordAgentRun,
        Self::RevertChangeSet,
        Self::UpdateAgentRunStatus,
        Self::UpdateDraftNotes,
        Self::ValidateChangeSetDryRun,
        Self::ValidateChangeSetsDryRun,
    ];

    pub const fn statement(self) -> &'static str {
        match self {
            Self::ApplyChangeSet => "select kernel_apply_change_set($1::jsonb)",
            Self::ApplyChangeSetInTransaction => {
                "select kernel_apply_change_set_in_transaction($1::jsonb)"
            }
            Self::ApplySeedDefaults => "select kernel_apply_seed_defaults($1::jsonb)",
            Self::ApproveDraftChangeSet => "select kernel_approve_draft_change_set($1::jsonb)",
            Self::ChangeSetDiff => "select kernel_change_set_diff($1::jsonb)",
            Self::CommitTenantSchemaRevision => {
                "select kernel_commit_tenant_schema_revision($1::jsonb)"
            }
            Self::DataQuery => "select kernel_data_query($1::jsonb)",
            Self::DiscardDraftChangeSet => "select kernel_discard_draft_change_set($1::jsonb)",
            Self::DryRunTenantSchemaRevision => {
                "select kernel_dry_run_tenant_schema_revision($1::jsonb)"
            }
            Self::FieldHistory => "select kernel_field_history($1::jsonb)",
            Self::ListDraftChangeSets => "select kernel_list_draft_change_sets($1::jsonb)",
            Self::LookupHydrate => "select kernel_lookup_hydrate($1::jsonb)",
            Self::LookupList => "select kernel_lookup_list($1::jsonb)",
            Self::LookupReferenceCount => "select kernel_lookup_reference_count($1::jsonb)",
            Self::LookupResolveBatch => "select kernel_lookup_resolve_batch($1::jsonb)",
            Self::LookupSetAvailability => "select kernel_lookup_set_availability($1::jsonb)",
            Self::LookupTransferAlias => "select kernel_lookup_transfer_alias($1::jsonb)",
            Self::QueryVisibleSql => "select kernel_query_visible_sql($1::jsonb)",
            Self::ReadActiveSchemaRevision => {
                "select kernel_read_active_schema_revision($1::jsonb)"
            }
            Self::ReadDraftChangeSet => "select kernel_read_draft_change_set($1::jsonb)",
            Self::ReadVisibleRecord => "select kernel_read_visible_record($1::jsonb)",
            Self::ReadVisibleRecordForUpdate => {
                "select kernel_read_visible_record_for_update($1::jsonb)"
            }
            Self::ReadVisibleRecords => "select kernel_read_visible_records($1::jsonb)",
            Self::ReadVisibleRecordsByModel => {
                "select kernel_read_visible_records_by_model($1::jsonb)"
            }
            Self::ReadVisibleRecordsByTextFields => {
                "select kernel_read_visible_records_by_text_fields($1::jsonb)"
            }
            Self::RecentActivity => "select kernel_recent_activity($1::jsonb)",
            Self::RecordAgentRun => "select kernel_record_agent_run($1::jsonb)",
            Self::RevertChangeSet => "select kernel_revert_change_set($1::jsonb)",
            Self::UpdateAgentRunStatus => "select kernel_update_agent_run_status($1::jsonb)",
            Self::UpdateDraftNotes => "select kernel_update_draft_notes($1::jsonb)",
            Self::ValidateChangeSetDryRun => "select kernel_validate_change_set_dry_run($1::jsonb)",
            Self::ValidateChangeSetsDryRun => {
                "select kernel_validate_change_sets_dry_run($1::jsonb)"
            }
        }
    }

    /// Calls a generated runtime entrypoint as a complete top-level operation.
    ///
    /// Apply, dry-run, and draft-approval operations retry only the kernel's
    /// exact dependency-drift signal. Every attempt owns a fresh PostgreSQL
    /// transaction, so a retry receives a new snapshot. Other serialization
    /// failures are returned without retrying.
    pub fn call_top_level<TResult>(
        self,
        client: &mut Client,
        request: &(impl Serialize + ?Sized),
    ) -> Result<TResult, KernelError>
    where
        TResult: DeserializeOwned,
    {
        self.call_top_level_with_actor(client, None, request)
    }

    /// Calls a generated runtime entrypoint as the host-authenticated actor.
    ///
    /// Each attempt binds `kernel.actor_id` transaction-locally, so declared
    /// authorization policies see the trusted actor and no binding outlives
    /// the operation. The protected role and fence bindings are cleared, as in
    /// the generated TypeScript data context without an `actorBinding`.
    pub fn call_top_level_as_actor<TResult>(
        self,
        client: &mut Client,
        actor_id: &str,
        request: &(impl Serialize + ?Sized),
    ) -> Result<TResult, KernelError>
    where
        TResult: DeserializeOwned,
    {
        self.call_top_level_with_actor(client, Some(actor_id), request)
    }

    fn call_top_level_with_actor<TResult>(
        self,
        client: &mut Client,
        actor_id: Option<&str>,
        request: &(impl Serialize + ?Sized),
    ) -> Result<TResult, KernelError>
    where
        TResult: DeserializeOwned,
    {
        let request = serde_json::to_value(request).map_err(request_serialization_error)?;

        loop {
            let mut transaction = client.transaction().map_err(transport_error)?;
            if let Some(actor_id) = actor_id {
                if let Err(error) = transaction.query_one(
                    "select set_config('kernel.actor_id', $1, true), set_config('kernel.actor_role', '', true), set_config('kernel.actor_fence_generation', '', true)",
                    &[&actor_id],
                ) {
                    let kernel_error = transport_error(error);
                    let _ = transaction.rollback();
                    return Err(kernel_error);
                }
            }
            let row = match transaction.query_one(self.statement(), &[&request]) {
                Ok(row) => row,
                Err(error)
                    if self.retries_apply_dependency_drift()
                        && is_apply_dependency_drift(&error) =>
                {
                    transaction.rollback().map_err(transport_error)?;
                    continue;
                }
                Err(error) => {
                    let kernel_error = transport_error(error);
                    let _ = transaction.rollback();
                    return Err(kernel_error);
                }
            };
            let envelope = match row.try_get::<_, Option<Value>>(0).map_err(transport_error) {
                Ok(Some(envelope)) => envelope,
                Ok(None) => {
                    let _ = transaction.rollback();
                    return Err(malformed_envelope_error());
                }
                Err(error) => {
                    let _ = transaction.rollback();
                    return Err(error);
                }
            };
            let result = match decode_generated_sql_result(envelope) {
                Ok(result) => result,
                Err(error) => {
                    let _ = transaction.rollback();
                    return Err(error);
                }
            };
            transaction.commit().map_err(transport_error)?;
            return Ok(result);
        }
    }

    /// Decodes untyped client JSON into the endpoint's generated request type
    /// before invoking PostgreSQL.
    ///
    /// This is the wire boundary used when an HTTP body or another untyped
    /// transport feeds a generated client. Strict serde contracts, including
    /// unknown-field rejection, are therefore enforced before SQL executes.
    pub fn call_json_top_level<TRequest, TResult>(
        self,
        client: &mut Client,
        request: Value,
    ) -> Result<TResult, KernelError>
    where
        TRequest: DeserializeOwned + Serialize,
        TResult: DeserializeOwned,
    {
        let request =
            serde_json::from_value::<TRequest>(request).map_err(request_serialization_error)?;
        self.call_top_level(client, &request)
    }

    const fn retries_apply_dependency_drift(self) -> bool {
        matches!(
            self,
            Self::ApplyChangeSet
                | Self::ApproveDraftChangeSet
                | Self::ValidateChangeSetDryRun
                | Self::ValidateChangeSetsDryRun
        )
    }
}

/// Begins a caller-owned transaction for generated SQL runtime operations.
///
/// Tenant scope and the schema-activation reader lock are transaction-local,
/// so both remain in force until the caller commits or rolls back.
pub fn begin_generated_sql_tenant_transaction<'a>(
    client: &'a mut Client,
    app_id: &AppId,
    customer_id: &CustomerId,
) -> Result<Transaction<'a>, KernelError> {
    let mut transaction = client.transaction().map_err(transport_error)?;
    transaction
        .query_one(
            "select set_config('kernel.app_id', $1, true)",
            &[&app_id.as_str()],
        )
        .map_err(transport_error)?;
    transaction
        .query_one(
            "select set_config('kernel.customer_id', $1, true)",
            &[&customer_id.as_str()],
        )
        .map_err(transport_error)?;
    transaction
        .query_one(
            "select set_config('platform.caller_owned_transaction', 'true', true)",
            &[],
        )
        .map_err(transport_error)?;
    transaction
        .query_one(
            r#"
            select pg_advisory_xact_lock_shared(
              hashtext(
                'postgres-schema:' || current_schema()
                || ':materialize-tenant:' || $1
                || ':' || $2
                || ':schema-activation'
              )::bigint
            )
            "#,
            &[&app_id.as_str(), &customer_id.as_str()],
        )
        .map_err(transport_error)?;
    Ok(transaction)
}

/// Applies a change set through generated SQL in a caller-owned transaction.
///
/// This uses the distinct non-retrying entrypoint. Both dependency-drift and
/// unrelated serialization failures abort the caller's transaction.
pub fn apply_generated_sql_change_set_in_transaction(
    transaction: &mut impl GenericClient,
    apply: &ApplyChangeSet,
) -> Result<AppliedChangeSet, KernelError> {
    call_generated_sql(
        transaction,
        GeneratedSqlFunction::ApplyChangeSetInTransaction,
        apply,
    )
}

/// Reads visible records through the generated PostgreSQL operation.
pub fn read_generated_sql_visible_records(
    client: &mut Client,
    app_id: &AppId,
    customer_id: &CustomerId,
    model_id: &ModelId,
    as_of: NaiveDate,
) -> Result<Vec<VisibleRecord>, KernelError> {
    GeneratedSqlFunction::ReadVisibleRecords.call_top_level(
        client,
        &VisibleRecordsRequest {
            app_id,
            customer_id,
            model_id,
            as_of,
        },
    )
}

/// Reads activity through the generated PostgreSQL operation.
pub fn read_generated_sql_recent_activity(
    client: &mut Client,
    request: &RecentActivityRequest,
) -> Result<Vec<RecentActivityEntry>, KernelError> {
    GeneratedSqlFunction::RecentActivity.call_top_level(client, request)
}

pub fn read_generated_sql_visible_records_in_transaction(
    transaction: &mut impl GenericClient,
    app_id: &AppId,
    customer_id: &CustomerId,
    model_id: &ModelId,
    as_of: NaiveDate,
) -> Result<Vec<VisibleRecord>, KernelError> {
    call_generated_sql(
        transaction,
        GeneratedSqlFunction::ReadVisibleRecords,
        &VisibleRecordsRequest {
            app_id,
            customer_id,
            model_id,
            as_of,
        },
    )
}

pub fn read_generated_sql_visible_records_by_text_fields_in_transaction(
    transaction: &mut impl GenericClient,
    app_id: &AppId,
    customer_id: &CustomerId,
    model_id: &ModelId,
    as_of: NaiveDate,
    field_filters: &BTreeMap<FieldId, String>,
) -> Result<Vec<VisibleRecord>, KernelError> {
    call_generated_sql(
        transaction,
        GeneratedSqlFunction::ReadVisibleRecordsByTextFields,
        &VisibleRecordsByTextFieldsRequest {
            app_id,
            customer_id,
            model_id,
            as_of,
            field_filters,
        },
    )
}

pub fn read_generated_sql_visible_record_for_update_in_transaction(
    transaction: &mut impl GenericClient,
    app_id: &AppId,
    customer_id: &CustomerId,
    model_id: &ModelId,
    record_id: &RecordId,
    as_of: NaiveDate,
) -> Result<Option<VisibleRecord>, KernelError> {
    call_generated_sql(
        transaction,
        GeneratedSqlFunction::ReadVisibleRecordForUpdate,
        &VisibleRecordForUpdateRequest {
            app_id,
            customer_id,
            model_id,
            record_id,
            as_of,
        },
    )
}

#[derive(Serialize)]
struct VisibleRecordsRequest<'a> {
    app_id: &'a AppId,
    customer_id: &'a CustomerId,
    model_id: &'a ModelId,
    as_of: NaiveDate,
}

#[derive(Serialize)]
struct VisibleRecordsByTextFieldsRequest<'a> {
    app_id: &'a AppId,
    customer_id: &'a CustomerId,
    model_id: &'a ModelId,
    as_of: NaiveDate,
    field_filters: &'a BTreeMap<FieldId, String>,
}

#[derive(Serialize)]
struct VisibleRecordForUpdateRequest<'a> {
    app_id: &'a AppId,
    customer_id: &'a CustomerId,
    model_id: &'a ModelId,
    record_id: &'a RecordId,
    as_of: NaiveDate,
}

/// Calls one generated SQL function on the supplied PostgreSQL session.
///
/// `GenericClient` deliberately permits both `Client` and `Transaction`, which
/// lets parity scenarios keep locks and all related calls on one session.
pub fn call_generated_sql<TResult>(
    client: &mut impl GenericClient,
    function: GeneratedSqlFunction,
    request: &(impl Serialize + ?Sized),
) -> Result<TResult, KernelError>
where
    TResult: DeserializeOwned,
{
    let request = serde_json::to_value(request).map_err(request_serialization_error)?;
    let row = client
        .query_one(function.statement(), &[&request])
        .map_err(transport_error)?;
    let envelope = row
        .try_get::<_, Option<Value>>(0)
        .map_err(transport_error)?
        .ok_or_else(malformed_envelope_error)?;

    decode_generated_sql_result(envelope)
}

pub fn decode_generated_sql_result<TResult>(envelope: Value) -> Result<TResult, KernelError>
where
    TResult: DeserializeOwned,
{
    decode_generated_sql_result_inner(envelope).map_err(|error| match error {
        DecodeError::Kernel(dto) => KernelError::from_dto(dto),
        DecodeError::Malformed(source) => KernelError::from_dto_with_source(
            KernelErrorDto::new("serialization_error", SERIALIZATION_ERROR_MESSAGE),
            source,
        ),
    })
}

fn decode_generated_sql_result_inner<TResult>(envelope: Value) -> Result<TResult, DecodeError>
where
    TResult: DeserializeOwned,
{
    let object = envelope.as_object().ok_or_else(|| {
        DecodeError::malformed("generated SQL result envelope must be a JSON object")
    })?;
    let ok = object.get("ok").and_then(Value::as_bool).ok_or_else(|| {
        DecodeError::malformed("generated SQL result envelope must contain a boolean ok field")
    })?;

    if ok {
        if object.len() != 2 || !object.contains_key("data") {
            return Err(DecodeError::malformed(
                "successful generated SQL result envelope must contain only ok and data",
            ));
        }
        serde_json::from_value(
            object
                .get("data")
                .expect("successful envelope contains data")
                .clone(),
        )
        .map_err(DecodeError::Malformed)
    } else {
        if object.len() != 2 || !object.contains_key("error") {
            return Err(DecodeError::malformed(
                "failed generated SQL result envelope must contain only ok and error",
            ));
        }
        let error = decode_error_envelope(
            object
                .get("error")
                .expect("failed envelope contains error")
                .clone(),
        )?;
        Err(DecodeError::Kernel(KernelErrorDto {
            code: error.code,
            message: error.message,
            details: error.details,
        }))
    }
}

fn decode_error_envelope(value: Value) -> Result<ErrorEnvelope, DecodeError> {
    validate_exact_error_envelope(&value)?;
    serde_json::from_value(value).map_err(DecodeError::Malformed)
}

fn validate_exact_error_envelope(value: &Value) -> Result<(), DecodeError> {
    let object = value
        .as_object()
        .ok_or_else(|| DecodeError::malformed("error envelope must be a JSON object"))?;
    if object.len() != 3
        || !object.contains_key("code")
        || !object.contains_key("message")
        || !object.contains_key("details")
    {
        return Err(DecodeError::malformed(
            "error envelope must contain only code, message, and details",
        ));
    }

    let details = object
        .get("details")
        .and_then(Value::as_array)
        .ok_or_else(|| DecodeError::malformed("error envelope details must be an array"))?;
    for detail in details {
        let detail = detail
            .as_object()
            .ok_or_else(|| DecodeError::malformed("error detail must be a JSON object"))?;
        if detail.len() != 3
            || !detail.contains_key("path")
            || !detail.contains_key("code")
            || !detail.contains_key("message")
        {
            return Err(DecodeError::malformed(
                "error detail must contain only path, code, and message",
            ));
        }
    }

    Ok(())
}

fn transport_error(error: postgres::Error) -> KernelError {
    KernelError::from_dto_with_source(
        KernelErrorDto::new("database_error", DATABASE_ERROR_MESSAGE),
        error,
    )
}

fn is_apply_dependency_drift(error: &postgres::Error) -> bool {
    error.code() == Some(&SqlState::T_R_SERIALIZATION_FAILURE)
        && error
            .as_db_error()
            .is_some_and(|error| error.message() == APPLY_DEPENDENCY_DRIFT_MESSAGE)
}

fn request_serialization_error(error: serde_json::Error) -> KernelError {
    KernelError::from_dto_with_source(
        KernelErrorDto::new("serialization_error", SERIALIZATION_ERROR_MESSAGE),
        error,
    )
}

fn malformed_envelope_error() -> KernelError {
    KernelError::from_dto(KernelErrorDto::new(
        "serialization_error",
        SERIALIZATION_ERROR_MESSAGE,
    ))
}

#[derive(Debug, thiserror::Error)]
enum DecodeError {
    #[error("generated kernel error: {0}")]
    Kernel(KernelErrorDto),
    #[error("malformed generated SQL result envelope: {0}")]
    Malformed(serde_json::Error),
}

impl DecodeError {
    fn malformed(message: &'static str) -> Self {
        Self::Malformed(<serde_json::Error as serde::de::Error>::custom(message))
    }
}
