use std::collections::BTreeMap;
use std::env;
use support::trusted_human;

use chrono::NaiveDate;
use kernel::testing::{call_generated_sql, GeneratedSqlFunction};
use kernel::{
    connect_postgres, AgentRunLedgerEntry, AgentRunStatus, AgentRunStatusUpdate, AppId,
    AppliedChangeSet, ApplyChangeSet, ApplyMode, CustomerId, ErrorDetail, ErrorEnvelope,
    ExternalKey, Field, FieldId, FieldType, FieldValue, KernelError, Model, ModelId, ModelKind,
    RecordKey, RowVersionWrite, Schema, SchemaRevisionId, SchemaVersion, StoredAgentRun,
    AGENT_SOURCE_KIND,
};
use postgres::Client;
use schema_compiler::{
    compile_sql_artifact_manifest, render_sql_artifact_bundle, CompiledManifest,
    NormalizedManifestExtras,
};
use serde_json::{json, Value};
use uuid::Uuid;

mod support;

const APP_ID: &str = "core_app";
const CUSTOMER_ID: &str = "customer_a";

struct TestDatabase {
    client: Client,
    schema_name: String,
}

impl TestDatabase {
    fn connect() -> Option<Self> {
        let database_url = match env::var("KERNEL_TEST_DATABASE_URL") {
            Ok(url) => url,
            Err(env::VarError::NotPresent) => {
                eprintln!(
                    "skipping generated SQL agent contract parity test: KERNEL_TEST_DATABASE_URL is absent"
                );
                return None;
            }
            Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
        };
        let mut client = connect_postgres(&database_url).expect("connect to PostgreSQL");
        let schema_name = format!("kernel_agent_contracts_{}", Uuid::new_v4().simple());
        client
            .batch_execute(&format!(
                "create schema \"{schema_name}\"; set search_path to \"{schema_name}\""
            ))
            .expect("create isolated generated SQL agent schema");

        let compiled = compiled_manifest();
        let manifest =
            compile_sql_artifact_manifest(&compiled).expect("compile generated SQL artifacts");
        trusted_human::before_install(&mut client);
        client
            .batch_execute(&render_sql_artifact_bundle(&manifest))
            .unwrap_or_else(|error| panic!("install generated SQL agent bundle: {error}"));
        client
            .execute(
                r#"
                insert into schema_revision (
                  id, app_id, customer_id, version, base_schema, customer_overlay,
                  schema, schema_hash, materialization_source, materialized_at, activated_at
                ) values (1, $1, $2, $3, $4, '{}'::jsonb, $4, 'agent-contract-hash',
                  'agent-contract-parity', now(), now())
                "#,
                &[
                    &APP_ID,
                    &CUSTOMER_ID,
                    &compiled.schema.version.as_str(),
                    &serde_json::to_value(&compiled.schema).expect("serialize agent schema"),
                ],
            )
            .expect("activate generated SQL agent schema");

        trusted_human::bind(&mut client, APP_ID, CUSTOMER_ID, "agent");
        Some(Self {
            client,
            schema_name,
        })
    }

    fn record_agent_run(
        &mut self,
        run: &AgentRunLedgerEntry,
    ) -> Result<StoredAgentRun, KernelError> {
        call_generated_sql(&mut self.client, GeneratedSqlFunction::RecordAgentRun, run)
    }

    fn update_agent_run_status(
        &mut self,
        update: &AgentRunStatusUpdate,
    ) -> Result<StoredAgentRun, KernelError> {
        call_generated_sql(
            &mut self.client,
            GeneratedSqlFunction::UpdateAgentRunStatus,
            update,
        )
    }

    fn apply(&mut self, apply: &ApplyChangeSet) -> Result<AppliedChangeSet, KernelError> {
        GeneratedSqlFunction::ApplyChangeSet.call_top_level(&mut self.client, apply)
    }
}

impl Drop for TestDatabase {
    fn drop(&mut self) {
        support::drop_generated_sql_fixture(&mut self.client, &self.schema_name);
    }
}

#[test]
fn requires_agent_writes_to_reference_a_recorded_run_match_generated_sql() {
    let Some(mut database) = TestDatabase::connect() else {
        return;
    };
    let mut apply = agent_apply(None);

    assert_eq!(
        database
            .apply(&apply)
            .expect_err("agent apply without source_ref must fail")
            .into_envelope(),
        validation_envelope(vec![detail(
            "source_ref",
            "missing_agent_run_ref",
            "agent writes must include source_ref pointing at an agent run",
        )])
    );

    apply.source_ref = Some("run_1".to_string());
    assert_eq!(
        database
            .apply(&apply)
            .expect_err("agent apply must reference a persisted run")
            .into_envelope(),
        ErrorEnvelope {
            code: "agent_run_missing".to_string(),
            message: "agent run `run_1` has not been recorded".to_string(),
            details: vec![],
        }
    );

    let stored = database
        .record_agent_run(&agent_run("run_1"))
        .expect("record run through generated SQL API");
    assert_eq!(stored.run_id, "run_1");
    assert_eq!(stored.schema_revision_id, SchemaRevisionId::new(1));

    let applied = database
        .apply(&apply)
        .expect("recorded agent write applies through generated SQL API");
    let linkage = database
        .client
        .query_one(
            r#"
            select change_set.source_kind, change_set.source_ref, agent_run.schema_revision_id
            from change_set
            join agent_run
              on agent_run.app_id = change_set.app_id
             and agent_run.customer_id = change_set.customer_id
             and agent_run.run_id = change_set.source_ref
            where change_set.id = $1
            "#,
            &[&applied.id],
        )
        .expect("read persisted agent change-set linkage");
    assert_eq!(linkage.get::<_, String>(0), AGENT_SOURCE_KIND);
    assert_eq!(linkage.get::<_, String>(1), "run_1");
    assert_eq!(linkage.get::<_, i64>(2), 1);
}

#[test]
fn validates_agent_run_ledger_entries_match_generated_sql() {
    let Some(mut database) = TestDatabase::connect() else {
        return;
    };
    let entry = agent_run("run_full");
    let stored = database
        .record_agent_run(&entry)
        .expect("valid ledger entry records through generated SQL API");
    assert_eq!(stored.run_id, "run_full");
    assert_eq!(stored.schema_revision_id, SchemaRevisionId::new(1));

    let persisted = read_evidence(&mut database.client, "run_full");
    assert_eq!(persisted["status"], "recorded");
    assert_eq!(persisted["schema_revision_id"], 1);
    assert_eq!(persisted["source_artifacts"], entry.source_artifacts);
    assert_eq!(persisted["token_usage"], entry.token_usage);
    assert_eq!(persisted["compiled_preview_ids"], json!(["preview_1"]));

    let defaulted: AgentRunLedgerEntry = serde_json::from_value(json!({
        "app_id": APP_ID,
        "customer_id": CUSTOMER_ID,
        "run_id": "run_defaulted",
        "agent_identity_id": "csv_import_planner",
        "execution_profile_id": "planner"
    }))
    .expect("deserialize ledger defaults");
    database
        .record_agent_run(&defaulted)
        .expect("defaulted ledger entry records through generated SQL API");
    let defaults = read_evidence(&mut database.client, "run_defaulted");
    assert_eq!(defaults["source_artifacts"], json!([]));
    assert_eq!(defaults["alignment_decisions"], json!([]));
    assert_eq!(defaults["model_calls"], json!([]));
    assert_eq!(defaults["tool_calls"], json!([]));
    assert_eq!(defaults["token_usage"], json!({}));
    assert_eq!(defaults["validation_failures"], json!([]));
    assert_eq!(defaults["final_outputs"], json!({}));
    assert_eq!(defaults["approval_boundaries"], json!([]));
    assert_eq!(defaults["compiled_preview_ids"], json!([]));

    let mut null_evidence = entry.clone();
    null_evidence.run_id = "run_null_evidence".to_string();
    null_evidence.source_artifacts = Value::Null;
    assert_eq!(
        database
            .record_agent_run(&null_evidence)
            .expect_err("null array evidence must fail")
            .into_envelope(),
        validation_envelope(vec![detail(
            "source_artifacts",
            "invalid_json_evidence",
            "agent run evidence field must be omitted for defaults or supplied as a JSON array",
        )])
    );

    let mut wrong_container = entry.clone();
    wrong_container.run_id = "run_wrong_container".to_string();
    wrong_container.token_usage = json!([]);
    assert_eq!(
        database
            .record_agent_run(&wrong_container)
            .expect_err("array token usage must fail")
            .into_envelope(),
        validation_envelope(vec![detail(
            "token_usage",
            "invalid_json_evidence",
            "agent run evidence field must be omitted for defaults or supplied as a JSON object",
        )])
    );

    let mut invalid = entry.clone();
    invalid.run_id = " ".to_string();
    invalid.agent_identity_id = String::new();
    assert_eq!(
        database
            .record_agent_run(&invalid)
            .expect_err("empty run identity must fail")
            .into_envelope(),
        validation_envelope(vec![
            detail("run_id", "empty_value", "value must not be empty"),
            detail(
                "agent_identity_id",
                "empty_value",
                "value must not be empty",
            ),
        ])
    );

    let mut invalid_revision = entry.clone();
    invalid_revision.run_id = "run_invalid_revision".to_string();
    invalid_revision.schema_revision_id = Some(SchemaRevisionId::new(0));
    assert_eq!(
        database
            .record_agent_run(&invalid_revision)
            .expect_err("non-positive schema revision must fail")
            .into_envelope(),
        validation_envelope(vec![detail(
            "schema_revision_id",
            "invalid_schema_revision_id",
            "schema_revision_id must be positive when supplied",
        )])
    );

    let mut stale_revision = entry.clone();
    stale_revision.run_id = "run_stale_revision".to_string();
    stale_revision.schema_revision_id = Some(SchemaRevisionId::new(2));
    assert_eq!(
        database
            .record_agent_run(&stale_revision)
            .expect_err("stale schema provenance must fail")
            .into_envelope(),
        ErrorEnvelope {
            code: "stale_schema_revision".to_string(),
            message: "The supplied schema revision is not active".to_string(),
            details: vec![detail(
                "schema_revision_id",
                "stale_schema_revision",
                "Supplied schema_revision_id is 2; active schema_revision_id is 1",
            )],
        }
    );

    let mut budget_entry = agent_run("run_budget");
    budget_entry.token_usage = json!({});
    let budget_run = database
        .record_agent_run(&budget_entry)
        .expect("record budget fixture");
    let budget_update = AgentRunStatusUpdate {
        app_id: AppId::from(APP_ID),
        customer_id: CustomerId::from(CUSTOMER_ID),
        run_id: "run_budget".to_string(),
        status: AgentRunStatus::BudgetExhausted,
        model_calls: None,
        tool_calls: None,
        token_usage: Some(json!({"input": 120, "output": 30})),
        validation_failures: Some(json!([])),
        final_outputs: Some(json!({"status": "budget_exhausted"})),
    };
    assert_eq!(
        database
            .update_agent_run_status(&budget_update)
            .expect("budget exhaustion is a valid terminal status"),
        budget_run
    );
    let budget_evidence = read_evidence(&mut database.client, "run_budget");
    assert_eq!(budget_evidence["status"], "budget_exhausted");
    assert_eq!(
        budget_evidence["token_usage"],
        json!({"input": 120, "output": 30})
    );

    let invalid_update = AgentRunStatusUpdate {
        app_id: AppId::from(APP_ID),
        customer_id: CustomerId::from(CUSTOMER_ID),
        run_id: "run_full".to_string(),
        status: AgentRunStatus::Recorded,
        model_calls: None,
        tool_calls: None,
        token_usage: Some(json!([])),
        validation_failures: None,
        final_outputs: None,
    };
    assert_eq!(
        database
            .update_agent_run_status(&invalid_update)
            .expect_err("non-terminal status and malformed token evidence must fail")
            .into_envelope(),
        validation_envelope(vec![
            detail(
                "status",
                "invalid_agent_run_status",
                "agent run status updates must move a recorded run to a terminal status",
            ),
            detail(
                "token_usage",
                "invalid_json_evidence",
                "agent run evidence field must be omitted or supplied as a JSON object",
            ),
        ])
    );
}

fn agent_run(run_id: &str) -> AgentRunLedgerEntry {
    AgentRunLedgerEntry {
        app_id: AppId::from(APP_ID),
        customer_id: CustomerId::from(CUSTOMER_ID),
        run_id: run_id.to_string(),
        status: AgentRunStatus::Recorded,
        schema_revision_id: Some(SchemaRevisionId::new(1)),
        actor_id: Some("agent".to_string()),
        agent_identity_id: "csv_import_planner".to_string(),
        execution_profile_id: "planner".to_string(),
        source_artifacts: json!([{"artifact_id": "sha256:abc"}]),
        alignment_decisions: json!([]),
        model_calls: json!([]),
        tool_calls: json!([]),
        token_usage: json!({"input": 10, "output": 4}),
        validation_failures: json!([]),
        final_outputs: json!({"status": "drafted"}),
        approval_boundaries: json!([]),
        compiled_preview_ids: vec!["preview_1".to_string()],
    }
}

fn agent_apply(source_ref: Option<&str>) -> ApplyChangeSet {
    ApplyChangeSet {
        app_id: AppId::from(APP_ID),
        customer_id: CustomerId::from(CUSTOMER_ID),
        schema_revision_id: Some(SchemaRevisionId::new(1)),
        actor_id: Some("agent".to_string()),
        source_kind: AGENT_SOURCE_KIND.to_string(),
        source_ref: source_ref.map(str::to_string),
        idempotency_key: Some("agent-contract-apply".to_string()),
        change_type_id: None,
        notes: None,
        mode: ApplyMode::Draft,
        writes: vec![RowVersionWrite {
            model_id: ModelId::from("record"),
            new_record_id: None,
            record_key: Some(RecordKey::ExternalKey(ExternalKey::from("agent-record"))),
            effective_start: NaiveDate::from_ymd_opt(2026, 5, 4).expect("valid date"),
            values: Some(BTreeMap::from([(
                FieldId::from("display_name"),
                FieldValue::Text("Example".to_string()),
            )])),
            custom_fields: None,
            tombstones_record: false,
            provenance: None,
            ..Default::default()
        }],
    }
}

fn read_evidence(client: &mut Client, run_id: &str) -> Value {
    client
        .query_one(
            r#"
            select jsonb_build_object(
              'status', status,
              'schema_revision_id', schema_revision_id,
              'source_artifacts', source_artifacts,
              'alignment_decisions', alignment_decisions,
              'model_calls', model_calls,
              'tool_calls', tool_calls,
              'token_usage', token_usage,
              'validation_failures', validation_failures,
              'final_outputs', final_outputs,
              'approval_boundaries', approval_boundaries,
              'compiled_preview_ids', compiled_preview_ids
            )
            from agent_run
            where app_id = $1 and customer_id = $2 and run_id = $3
            "#,
            &[&APP_ID, &CUSTOMER_ID, &run_id],
        )
        .expect("read generated SQL agent evidence")
        .get(0)
}

fn validation_envelope(details: Vec<ErrorDetail>) -> ErrorEnvelope {
    ErrorEnvelope {
        code: "contract_validation_failed".to_string(),
        message: "Contract validation failed".to_string(),
        details,
    }
}

fn detail(path: &str, code: &str, message: &str) -> ErrorDetail {
    ErrorDetail {
        path: path.to_string(),
        code: code.to_string(),
        message: message.to_string(),
    }
}

fn compiled_manifest() -> CompiledManifest {
    CompiledManifest {
        schema: Schema {
            app_id: AppId::from(APP_ID),
            customer_id: CustomerId::from(CUSTOMER_ID),
            version: SchemaVersion::from("2026-08-04.agent-contracts"),
            models: vec![Model {
                id: ModelId::from("record"),
                kind: ModelKind::Entity,
                label: "Record".to_string(),
                fields: vec![Field {
                    id: FieldId::from("display_name"),
                    label: "Display Name".to_string(),
                    field_type: FieldType::Text,
                    required: true,
                    is_unique: false,
                    target_model: None,
                    option_set: vec![],
                    ..Default::default()
                }],
                ..Default::default()
            }],
            custom_fields: vec![],
            change_types: vec![],
        },
        extras: NormalizedManifestExtras {
            model_metadata: vec![],
            field_metadata: vec![],
            inverse_relations: vec![],
            many_relations: vec![],
            constraints: vec![],
            derived_fields: vec![],
            authorization_policy: None,
            seed_change_sets: vec![],
        },
    }
}
