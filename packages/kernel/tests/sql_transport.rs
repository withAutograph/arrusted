use std::collections::BTreeMap;
use std::env;

use chrono::NaiveDate;
use kernel::testing::{
    apply_generated_sql_change_set_in_transaction, begin_generated_sql_tenant_transaction,
    call_generated_sql, decode_generated_sql_result,
    read_generated_sql_visible_record_for_update_in_transaction,
    read_generated_sql_visible_records_by_text_fields_in_transaction,
    read_generated_sql_visible_records_in_transaction, GeneratedSqlFunction,
};
use kernel::{
    ActiveSchemaRevision, AppId, AppliedChangeSet, ApplyChangeSet, ApplyMode, CustomerId,
    ErrorDetail, ErrorEnvelope, FieldId, ModelId, SchemaRevisionId,
};
use postgres::error::SqlState;
use postgres::{Client, NoTls};
use serde::Serialize;
use serde_json::{json, Value};
use uuid::Uuid;

#[test]
fn generated_sql_function_mapping_is_static_and_complete() {
    let expected = BTreeMap::from([
        (
            GeneratedSqlFunction::ApplyChangeSet,
            "select kernel_apply_change_set($1::jsonb)",
        ),
        (
            GeneratedSqlFunction::ApplyChangeSetInTransaction,
            "select kernel_apply_change_set_in_transaction($1::jsonb)",
        ),
        (
            GeneratedSqlFunction::ApplySeedDefaults,
            "select kernel_apply_seed_defaults($1::jsonb)",
        ),
        (
            GeneratedSqlFunction::ApproveDraftChangeSet,
            "select kernel_approve_draft_change_set($1::jsonb)",
        ),
        (
            GeneratedSqlFunction::ChangeSetDiff,
            "select kernel_change_set_diff($1::jsonb)",
        ),
        (
            GeneratedSqlFunction::CommitTenantSchemaRevision,
            "select kernel_commit_tenant_schema_revision($1::jsonb)",
        ),
        (
            GeneratedSqlFunction::DataQuery,
            "select kernel_data_query($1::jsonb)",
        ),
        (
            GeneratedSqlFunction::DiscardDraftChangeSet,
            "select kernel_discard_draft_change_set($1::jsonb)",
        ),
        (
            GeneratedSqlFunction::DryRunTenantSchemaRevision,
            "select kernel_dry_run_tenant_schema_revision($1::jsonb)",
        ),
        (
            GeneratedSqlFunction::FieldHistory,
            "select kernel_field_history($1::jsonb)",
        ),
        (
            GeneratedSqlFunction::ListDraftChangeSets,
            "select kernel_list_draft_change_sets($1::jsonb)",
        ),
        (
            GeneratedSqlFunction::LookupHydrate,
            "select kernel_lookup_hydrate($1::jsonb)",
        ),
        (
            GeneratedSqlFunction::LookupList,
            "select kernel_lookup_list($1::jsonb)",
        ),
        (
            GeneratedSqlFunction::LookupReferenceCount,
            "select kernel_lookup_reference_count($1::jsonb)",
        ),
        (
            GeneratedSqlFunction::LookupResolveBatch,
            "select kernel_lookup_resolve_batch($1::jsonb)",
        ),
        (
            GeneratedSqlFunction::LookupSetAvailability,
            "select kernel_lookup_set_availability($1::jsonb)",
        ),
        (
            GeneratedSqlFunction::LookupTransferAlias,
            "select kernel_lookup_transfer_alias($1::jsonb)",
        ),
        (
            GeneratedSqlFunction::QueryVisibleSql,
            "select kernel_query_visible_sql($1::jsonb)",
        ),
        (
            GeneratedSqlFunction::ReadActiveSchemaRevision,
            "select kernel_read_active_schema_revision($1::jsonb)",
        ),
        (
            GeneratedSqlFunction::ReadDraftChangeSet,
            "select kernel_read_draft_change_set($1::jsonb)",
        ),
        (
            GeneratedSqlFunction::ReadVisibleRecord,
            "select kernel_read_visible_record($1::jsonb)",
        ),
        (
            GeneratedSqlFunction::ReadVisibleRecordForUpdate,
            "select kernel_read_visible_record_for_update($1::jsonb)",
        ),
        (
            GeneratedSqlFunction::ReadVisibleRecords,
            "select kernel_read_visible_records($1::jsonb)",
        ),
        (
            GeneratedSqlFunction::ReadVisibleRecordsByModel,
            "select kernel_read_visible_records_by_model($1::jsonb)",
        ),
        (
            GeneratedSqlFunction::ReadVisibleRecordsByTextFields,
            "select kernel_read_visible_records_by_text_fields($1::jsonb)",
        ),
        (
            GeneratedSqlFunction::RecentActivity,
            "select kernel_recent_activity($1::jsonb)",
        ),
        (
            GeneratedSqlFunction::RecordAgentRun,
            "select kernel_record_agent_run($1::jsonb)",
        ),
        (
            GeneratedSqlFunction::RevertChangeSet,
            "select kernel_revert_change_set($1::jsonb)",
        ),
        (
            GeneratedSqlFunction::UpdateAgentRunStatus,
            "select kernel_update_agent_run_status($1::jsonb)",
        ),
        (
            GeneratedSqlFunction::UpdateDraftNotes,
            "select kernel_update_draft_notes($1::jsonb)",
        ),
        (
            GeneratedSqlFunction::ValidateChangeSetDryRun,
            "select kernel_validate_change_set_dry_run($1::jsonb)",
        ),
        (
            GeneratedSqlFunction::ValidateChangeSetsDryRun,
            "select kernel_validate_change_sets_dry_run($1::jsonb)",
        ),
    ]);

    assert_eq!(GeneratedSqlFunction::ALL.len(), expected.len());
    for function in GeneratedSqlFunction::ALL {
        assert_eq!(function.statement(), expected[&function]);
        assert!(function.statement().ends_with("($1::jsonb)"));
    }
}

#[test]
fn successful_envelope_decodes_data() {
    let decoded: Value = decode_generated_sql_result(json!({
        "ok": true,
        "data": {"record_id": "record-1", "visible": true}
    }))
    .unwrap();

    assert_eq!(decoded, json!({"record_id": "record-1", "visible": true}));
}

#[test]
fn active_schema_revision_envelope_decodes_to_the_current_facade_dto() {
    let decoded: ActiveSchemaRevision = decode_generated_sql_result(json!({
        "ok": true,
        "data": {
            "schema_revision_id": 7,
            "schema": {
                "app_id": "core_app",
                "customer_id": "customer_a",
                "version": "2026-08-04",
                "models": []
            },
            "effective_hash": "a".repeat(64)
        }
    }))
    .unwrap();

    assert_eq!(decoded.schema_revision_id, SchemaRevisionId::new(7));
    assert_eq!(decoded.effective_hash, "a".repeat(64));
    assert_eq!(decoded.schema.app_id.as_str(), "core_app");
    assert_eq!(decoded.schema.customer_id.as_str(), "customer_a");
}

#[test]
fn negative_envelope_decodes_without_losing_error_fields() {
    let expected = ErrorEnvelope {
        code: "idempotency_conflict".to_string(),
        message: "Idempotency key was reused for a different request".to_string(),
        details: vec![ErrorDetail {
            path: "idempotency_key".to_string(),
            code: "idempotency_conflict".to_string(),
            message: "request-1".to_string(),
        }],
    };
    let error = decode_generated_sql_result::<Value>(json!({
        "ok": false,
        "error": expected
    }))
    .unwrap_err();

    assert_eq!(error.into_envelope(), expected);
}

#[test]
fn malformed_envelopes_fail_closed_with_the_existing_serialization_error() {
    let malformed = [
        Value::Null,
        json!({"data": {}}),
        json!({"ok": true}),
        json!({"ok": true, "data": {}, "error": {}}),
        json!({"ok": false, "error": {"code": "x", "message": "y"}}),
        json!({
            "ok": false,
            "error": {"code": "x", "message": "y", "details": [], "extra": true}
        }),
    ];

    for envelope in malformed {
        let error = decode_generated_sql_result::<Value>(envelope).unwrap_err();
        assert_eq!(
            error.into_envelope(),
            ErrorEnvelope {
                code: "serialization_error".to_string(),
                message: "Kernel serialization failed".to_string(),
                details: Vec::new(),
            }
        );
    }
}

#[test]
fn database_transport_is_parameterized_and_works_in_a_transaction() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let mut client = Client::connect(&database_url, NoTls).expect("connect to test PostgreSQL");
    let schema = format!("kernel_sql_parity_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            r#"
            create schema {schema};
            set search_path to {schema};

            create function kernel_read_active_schema_revision(request jsonb)
            returns jsonb
            language sql
            as $$
              select jsonb_build_object('ok', true, 'data', request)
            $$;
            "#
        ))
        .expect("install transport fixture");

    #[derive(Serialize)]
    struct InjectionRequest<'a> {
        value: &'a str,
    }
    let injection = InjectionRequest {
        value: "kernel_read_active_schema_revision); drop schema public cascade; --",
    };
    let mut transaction = client.transaction().expect("begin transaction");
    let decoded: Value = call_generated_sql(
        &mut transaction,
        GeneratedSqlFunction::ReadActiveSchemaRevision,
        &injection,
    )
    .expect("call generated SQL through transaction");
    transaction.rollback().expect("roll back transaction");

    assert_eq!(decoded, serde_json::to_value(injection).unwrap());
    client
        .batch_execute(&format!("drop schema {schema} cascade"))
        .expect("drop transport fixture");
}

#[test]
fn database_transport_errors_preserve_the_existing_database_error() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let mut client = Client::connect(&database_url, NoTls).expect("connect to test PostgreSQL");
    let schema = format!("kernel_sql_parity_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            "create schema {schema}; set search_path to {schema}"
        ))
        .expect("install isolated search path");

    let error = call_generated_sql::<Value>(
        &mut client,
        GeneratedSqlFunction::RecordAgentRun,
        &json!({}),
    )
    .unwrap_err();

    assert_eq!(
        error.into_envelope(),
        ErrorEnvelope {
            code: "database_error".to_string(),
            message: "Database operation failed".to_string(),
            details: Vec::new(),
        }
    );
    client
        .batch_execute(&format!("drop schema {schema} cascade"))
        .expect("drop transport fixture");
}

#[test]
fn generated_tenant_transaction_sets_scope_and_holds_the_activation_reader_lock() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let mut client = Client::connect(&database_url, NoTls).expect("connect to test PostgreSQL");
    let schema = install_transaction_protocol_fixture(&mut client);
    let app_id = AppId::from("core_app");
    let customer_id = CustomerId::from("customer_scope");
    let mut contender = connect_to_schema(&database_url, &schema);

    let mut transaction =
        begin_generated_sql_tenant_transaction(&mut client, &app_id, &customer_id)
            .expect("begin generated SQL tenant transaction");
    let scope = transaction
        .query_one(
            "select current_setting('kernel.app_id'), current_setting('kernel.customer_id')",
            &[],
        )
        .expect("read tenant scope");
    assert_eq!(scope.get::<_, String>(0), app_id.as_str());
    assert_eq!(scope.get::<_, String>(1), customer_id.as_str());

    let lock_name = format!(
        "postgres-schema:{schema}:materialize-tenant:{app_id}:{customer_id}:schema-activation"
    );
    let acquired: bool = contender
        .query_one(
            "select pg_try_advisory_lock(hashtext($1)::bigint)",
            &[&lock_name],
        )
        .expect("try competing activation writer lock")
        .get(0);
    assert!(!acquired, "reader lock must block activation writers");

    transaction
        .rollback()
        .expect("roll back tenant transaction");
    let acquired: bool = contender
        .query_one(
            "select pg_try_advisory_lock(hashtext($1)::bigint)",
            &[&lock_name],
        )
        .expect("acquire activation writer lock after rollback")
        .get(0);
    assert!(acquired, "rollback must release the activation reader lock");
    contender
        .query_one(
            "select pg_advisory_unlock(hashtext($1)::bigint)",
            &[&lock_name],
        )
        .expect("release competing activation writer lock");

    drop_schema(&mut client, &schema);
}

#[test]
fn caller_owned_generated_apply_uses_the_nonretrying_entrypoint_and_rolls_back() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let mut client = Client::connect(&database_url, NoTls).expect("connect to test PostgreSQL");
    let schema = install_transaction_protocol_fixture(&mut client);
    let app_id = AppId::from("core_app");
    let customer_id = CustomerId::from("customer_apply_transaction");
    let mut transaction =
        begin_generated_sql_tenant_transaction(&mut client, &app_id, &customer_id)
            .expect("begin generated SQL tenant transaction");

    let applied = apply_generated_sql_change_set_in_transaction(
        &mut transaction,
        &test_apply_change_set(&customer_id, "success"),
    )
    .expect("apply through caller-owned generated SQL entrypoint");
    assert_eq!(applied.id, 1);
    let entrypoint: String = transaction
        .query_one("select entrypoint from protocol_apply_attempt", &[])
        .expect("read invoked apply entrypoint")
        .get(0);
    assert_eq!(entrypoint, "caller-owned");
    transaction
        .execute(
            "insert into protocol_effect (value) values ('adjacent-work')",
            &[],
        )
        .expect("write adjacent caller work");
    transaction
        .rollback()
        .expect("roll back tenant transaction");
    let effects: i64 = client
        .query_one("select count(*) from protocol_effect", &[])
        .expect("count committed protocol effects")
        .get(0);
    let attempts: i64 = client
        .query_one("select count(*) from protocol_apply_attempt", &[])
        .expect("count committed apply attempts")
        .get(0);
    assert_eq!(effects, 0);
    assert_eq!(attempts, 0);

    drop_schema(&mut client, &schema);
}

#[test]
fn caller_owned_generated_apply_does_not_retry_serialization_failures() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let mut client = Client::connect(&database_url, NoTls).expect("connect to test PostgreSQL");
    let schema = install_transaction_protocol_fixture(&mut client);
    let app_id = AppId::from("core_app");
    let customer_id = CustomerId::from("customer_apply_serialization");

    for source_kind in ["dependency-drift", "unrelated-serialization"] {
        let mut transaction =
            begin_generated_sql_tenant_transaction(&mut client, &app_id, &customer_id)
                .expect("begin generated SQL tenant transaction");
        let error = apply_generated_sql_change_set_in_transaction(
            &mut transaction,
            &test_apply_change_set(&customer_id, source_kind),
        )
        .expect_err("serialization failure must escape the non-retrying entrypoint");
        assert_eq!(
            error.into_envelope(),
            ErrorEnvelope {
                code: "database_error".to_string(),
                message: "Database operation failed".to_string(),
                details: Vec::new(),
            }
        );
        let aborted = transaction
            .query_one("select 1", &[])
            .expect_err("serialization failure must abort caller transaction");
        assert_eq!(aborted.code(), Some(&SqlState::IN_FAILED_SQL_TRANSACTION));
        transaction
            .rollback()
            .expect("roll back aborted caller transaction");
    }

    drop_schema(&mut client, &schema);
}

#[test]
fn generated_top_level_write_protocol_retries_only_exact_dependency_drift() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let mut client = Client::connect(&database_url, NoTls).expect("connect to test PostgreSQL");
    let schema = install_transaction_protocol_fixture(&mut client);
    let customer_id = CustomerId::from("customer_top_level_retry");
    let apply = test_apply_change_set(&customer_id, "dependency-drift-once");

    let applied: AppliedChangeSet = GeneratedSqlFunction::ApplyChangeSet
        .call_top_level(&mut client, &apply)
        .expect("retry top-level apply in a fresh transaction");
    assert_eq!(applied.id, 1);
    let dry_run: AppliedChangeSet = GeneratedSqlFunction::ValidateChangeSetDryRun
        .call_top_level(&mut client, &apply)
        .expect("retry single dry-run in a fresh transaction");
    assert_eq!(dry_run.id, 2);
    let batch: Vec<AppliedChangeSet> = GeneratedSqlFunction::ValidateChangeSetsDryRun
        .call_top_level(&mut client, &json!({"changesets":[apply]}))
        .expect("retry batch dry-run in a fresh transaction");
    assert_eq!(batch.len(), 1);
    let approval: AppliedChangeSet = GeneratedSqlFunction::ApproveDraftChangeSet
        .call_top_level(
            &mut client,
            &json!({
                "app_id":"core_app",
                "customer_id":customer_id,
                "change_set_id":4,
                "source_kind":"dependency-drift-once"
            }),
        )
        .expect("retry draft approval in a fresh transaction");
    assert_eq!(approval.id, 4);

    for sequence in [
        "protocol_top_level_apply_attempt",
        "protocol_single_dry_run_attempt",
        "protocol_batch_dry_run_attempt",
        "protocol_draft_approval_attempt",
    ] {
        let attempts: i64 = client
            .query_one(&format!("select last_value from {sequence}"), &[])
            .expect("read top-level attempt count")
            .get(0);
        assert_eq!(attempts, 2, "{sequence} must receive a fresh second call");
    }

    drop_schema(&mut client, &schema);
}

#[test]
fn generated_top_level_write_protocol_does_not_retry_unrelated_40001() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let mut client = Client::connect(&database_url, NoTls).expect("connect to test PostgreSQL");
    let schema = install_transaction_protocol_fixture(&mut client);
    let customer_id = CustomerId::from("customer_top_level_unrelated");
    let apply = test_apply_change_set(&customer_id, "unrelated-serialization");
    let calls = [
        (
            GeneratedSqlFunction::ApplyChangeSet,
            serde_json::to_value(&apply).unwrap(),
            "protocol_top_level_apply_attempt",
        ),
        (
            GeneratedSqlFunction::ValidateChangeSetDryRun,
            serde_json::to_value(&apply).unwrap(),
            "protocol_single_dry_run_attempt",
        ),
        (
            GeneratedSqlFunction::ValidateChangeSetsDryRun,
            json!({"changesets":[apply]}),
            "protocol_batch_dry_run_attempt",
        ),
        (
            GeneratedSqlFunction::ApproveDraftChangeSet,
            json!({
                "app_id":"core_app",
                "customer_id":customer_id,
                "change_set_id":4,
                "source_kind":"unrelated-serialization"
            }),
            "protocol_draft_approval_attempt",
        ),
    ];

    for (function, request, sequence) in calls {
        let error = function
            .call_top_level::<Value>(&mut client, &request)
            .expect_err("unrelated serialization failures must not retry");
        assert_eq!(
            error.into_envelope(),
            ErrorEnvelope {
                code: "database_error".to_string(),
                message: "Database operation failed".to_string(),
                details: Vec::new(),
            }
        );
        let attempts: i64 = client
            .query_one(&format!("select last_value from {sequence}"), &[])
            .expect("read one-shot attempt count")
            .get(0);
        assert_eq!(attempts, 1, "{sequence} must not be retried");
    }

    drop_schema(&mut client, &schema);
}

#[test]
fn generated_visible_reads_share_scope_and_caller_rollback() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let mut client = Client::connect(&database_url, NoTls).expect("connect to test PostgreSQL");
    let schema = install_transaction_protocol_fixture(&mut client);
    let app_id = AppId::from("core_app");
    let customer_id = CustomerId::from("customer_visible_reads");
    let model_id = ModelId::from("company");
    let as_of = date("2026-08-04");
    let mut transaction =
        begin_generated_sql_tenant_transaction(&mut client, &app_id, &customer_id)
            .expect("begin generated SQL tenant transaction");

    let records = read_generated_sql_visible_records_in_transaction(
        &mut transaction,
        &app_id,
        &customer_id,
        &model_id,
        as_of,
    )
    .expect("read visible records through generated SQL");
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].external_key.as_deref(), Some("visible"));

    let filters = BTreeMap::from([(FieldId::from("name"), "Acme".to_string())]);
    let filtered = read_generated_sql_visible_records_by_text_fields_in_transaction(
        &mut transaction,
        &app_id,
        &customer_id,
        &model_id,
        as_of,
        &filters,
    )
    .expect("read filtered visible records through generated SQL");
    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].external_key.as_deref(), Some("Acme"));

    transaction
        .execute(
            "insert into protocol_effect (value) values ('rolled-back')",
            &[],
        )
        .expect("write adjacent caller-owned work");
    transaction
        .rollback()
        .expect("roll back caller transaction");
    let persisted: i64 = client
        .query_one("select count(*) from protocol_effect", &[])
        .expect("count committed effects")
        .get(0);
    assert_eq!(
        persisted, 0,
        "caller rollback must cover the whole session protocol"
    );

    drop_schema(&mut client, &schema);
}

#[test]
fn generated_for_update_read_holds_row_lock_until_rollback_or_commit() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let mut client = Client::connect(&database_url, NoTls).expect("connect to test PostgreSQL");
    let schema = install_transaction_protocol_fixture(&mut client);
    let mut contender = connect_to_schema(&database_url, &schema);
    contender
        .batch_execute("set lock_timeout = '100ms'")
        .expect("set bounded row lock wait");
    let app_id = AppId::from("core_app");
    let customer_id = CustomerId::from("customer_lock_lifetime");
    let model_id = ModelId::from("company");
    let record_id = Uuid::parse_str("018f6bf3-1ea5-7812-9a5a-a1f5b04f0001").unwrap();

    let mut rollback_transaction =
        begin_generated_sql_tenant_transaction(&mut client, &app_id, &customer_id)
            .expect("begin rollback transaction");
    let record = read_generated_sql_visible_record_for_update_in_transaction(
        &mut rollback_transaction,
        &app_id,
        &customer_id,
        &model_id,
        &record_id,
        date("2026-08-04"),
    )
    .expect("lock visible record through generated SQL");
    assert_eq!(record.expect("visible record").record_id, record_id);
    assert_row_lock_is_held(&mut contender);
    rollback_transaction
        .rollback()
        .expect("roll back row lock transaction");
    contender
        .execute(
            "update protocol_record set value = 'after-rollback' where id = 1",
            &[],
        )
        .expect("rollback releases row lock");

    let mut commit_transaction =
        begin_generated_sql_tenant_transaction(&mut client, &app_id, &customer_id)
            .expect("begin commit transaction");
    read_generated_sql_visible_record_for_update_in_transaction(
        &mut commit_transaction,
        &app_id,
        &customer_id,
        &model_id,
        &record_id,
        date("2026-08-04"),
    )
    .expect("lock visible record through generated SQL");
    assert_row_lock_is_held(&mut contender);
    commit_transaction
        .commit()
        .expect("commit row lock transaction");
    contender
        .execute(
            "update protocol_record set value = 'after-commit' where id = 1",
            &[],
        )
        .expect("commit releases row lock");

    drop_schema(&mut client, &schema);
}

fn install_transaction_protocol_fixture(client: &mut Client) -> String {
    let schema = format!("kernel_sql_protocol_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            r#"
            create schema {schema};
            set search_path to {schema};

            create table protocol_apply_attempt (
              id bigserial primary key,
              entrypoint text not null
            );
            create table protocol_effect (value text not null);
            create table protocol_record (
              id bigint primary key,
              value text not null
            );
            insert into protocol_record (id, value) values (1, 'initial');

            create sequence protocol_top_level_apply_attempt;
            create sequence protocol_single_dry_run_attempt;
            create sequence protocol_batch_dry_run_attempt;
            create sequence protocol_draft_approval_attempt;

            create function kernel_apply_change_set(request jsonb)
            returns jsonb
            language plpgsql
            as $$
            declare attempt bigint;
            begin
              attempt := nextval('protocol_top_level_apply_attempt');
              if request->>'source_kind' = 'dependency-drift-once' and attempt = 1 then
                raise exception 'record apply dependency drift' using errcode = '40001';
              end if;
              if request->>'source_kind' = 'unrelated-serialization' then
                raise exception 'unrelated serialization failure' using errcode = '40001';
              end if;
              insert into protocol_apply_attempt (entrypoint) values ('autocommit');
              return jsonb_build_object(
                'ok', true,
                'data', jsonb_build_object('id', 1, 'schema_revision_id', 1)
              );
            end
            $$;

            create function kernel_validate_change_set_dry_run(request jsonb)
            returns jsonb
            language plpgsql
            as $$
            declare attempt bigint;
            begin
              attempt := nextval('protocol_single_dry_run_attempt');
              if request->>'source_kind' = 'dependency-drift-once' and attempt = 1 then
                raise exception 'record apply dependency drift' using errcode = '40001';
              end if;
              if request->>'source_kind' = 'unrelated-serialization' then
                raise exception 'unrelated serialization failure' using errcode = '40001';
              end if;
              return jsonb_build_object(
                'ok', true,
                'data', jsonb_build_object('id', 2, 'schema_revision_id', 1)
              );
            end
            $$;

            create function kernel_validate_change_sets_dry_run(request jsonb)
            returns jsonb
            language plpgsql
            as $$
            declare attempt bigint; source_kind text;
            begin
              attempt := nextval('protocol_batch_dry_run_attempt');
              source_kind := request->'changesets'->0->>'source_kind';
              if source_kind = 'dependency-drift-once' and attempt = 1 then
                raise exception 'record apply dependency drift' using errcode = '40001';
              end if;
              if source_kind = 'unrelated-serialization' then
                raise exception 'unrelated serialization failure' using errcode = '40001';
              end if;
              return jsonb_build_object(
                'ok', true,
                'data', jsonb_build_array(
                  jsonb_build_object('id', 3, 'schema_revision_id', 1)
                )
              );
            end
            $$;

            create function kernel_approve_draft_change_set(request jsonb)
            returns jsonb
            language plpgsql
            as $$
            declare attempt bigint;
            begin
              attempt := nextval('protocol_draft_approval_attempt');
              if request->>'source_kind' = 'dependency-drift-once' and attempt = 1 then
                raise exception 'record apply dependency drift' using errcode = '40001';
              end if;
              if request->>'source_kind' = 'unrelated-serialization' then
                raise exception 'unrelated serialization failure' using errcode = '40001';
              end if;
              return jsonb_build_object(
                'ok', true,
                'data', jsonb_build_object('id', 4, 'schema_revision_id', 1)
              );
            end
            $$;

            create function kernel_apply_change_set_in_transaction(request jsonb)
            returns jsonb
            language plpgsql
            as $$
            begin
              if request->>'source_kind' = 'dependency-drift' then
                raise exception 'record apply dependency drift' using errcode = '40001';
              end if;
              if request->>'source_kind' = 'unrelated-serialization' then
                raise exception 'unrelated serialization failure' using errcode = '40001';
              end if;
              insert into protocol_apply_attempt (entrypoint) values ('caller-owned');
              insert into protocol_effect (value) values ('generated-apply');
              return jsonb_build_object(
                'ok', true,
                'data', jsonb_build_object('id', 1, 'schema_revision_id', 1)
              );
            end
            $$;

            create function kernel_read_visible_records(request jsonb)
            returns jsonb
            language sql
            as $$
              select jsonb_build_object(
                'ok', true,
                'data', jsonb_build_array(
                  jsonb_build_object(
                    'record_id', '018f6bf3-1ea5-7812-9a5a-a1f5b04f0001',
                    'external_key', 'visible',
                    'effective_start', '2026-05-01',
                    'effective_end', null,
                    'values', jsonb_build_object(),
                    'custom_fields', jsonb_build_array()
                  )
                )
              )
            $$;

            create function kernel_read_visible_records_by_text_fields(request jsonb)
            returns jsonb
            language sql
            as $$
              select jsonb_build_object(
                'ok', true,
                'data', jsonb_build_array(
                  jsonb_build_object(
                    'record_id', '018f6bf3-1ea5-7812-9a5a-a1f5b04f0001',
                    'external_key', request->'field_filters'->>'name',
                    'effective_start', '2026-05-01',
                    'effective_end', null,
                    'values', jsonb_build_object(),
                    'custom_fields', jsonb_build_array()
                  )
                )
              )
            $$;

            create function kernel_read_visible_record_for_update(request jsonb)
            returns jsonb
            language plpgsql
            as $$
            begin
              perform 1 from protocol_record where id = 1 for update;
              return jsonb_build_object(
                'ok', true,
                'data', jsonb_build_object(
                  'record_id', request->>'record_id',
                  'external_key', 'locked',
                  'effective_start', '2026-05-01',
                  'effective_end', null,
                  'values', jsonb_build_object(),
                  'custom_fields', jsonb_build_array()
                )
              );
            end
            $$;
            "#
        ))
        .expect("install generated SQL transaction protocol fixture");
    schema
}

fn connect_to_schema(database_url: &str, schema: &str) -> Client {
    let mut client = Client::connect(database_url, NoTls).expect("connect to test PostgreSQL");
    client
        .batch_execute(&format!("set search_path to {schema}"))
        .expect("select test schema");
    client
}

fn drop_schema(client: &mut Client, schema: &str) {
    client
        .batch_execute(&format!("drop schema {schema} cascade"))
        .expect("drop generated SQL transaction protocol fixture");
}

fn test_apply_change_set(customer_id: &CustomerId, source_kind: &str) -> ApplyChangeSet {
    ApplyChangeSet {
        app_id: AppId::from("core_app"),
        customer_id: customer_id.clone(),
        schema_revision_id: None,
        actor_id: None,
        source_kind: source_kind.to_string(),
        source_ref: None,
        idempotency_key: Some("protocol-test".to_string()),
        change_type_id: None,
        notes: None,
        mode: ApplyMode::Mainline,
        writes: Vec::new(),
    }
}

fn assert_row_lock_is_held(contender: &mut Client) {
    let error = contender
        .execute(
            "update protocol_record set value = 'blocked' where id = 1",
            &[],
        )
        .expect_err("FOR UPDATE lock must survive the generated function call");
    assert_eq!(error.code(), Some(&SqlState::LOCK_NOT_AVAILABLE));
}

fn date(value: &str) -> NaiveDate {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").expect("valid test date")
}

fn test_database_url() -> Option<String> {
    match env::var("KERNEL_TEST_DATABASE_URL") {
        Ok(url) => Some(url),
        Err(env::VarError::NotPresent) => {
            eprintln!("skipping PostgreSQL transport test: KERNEL_TEST_DATABASE_URL is absent");
            None
        }
        Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
    }
}
