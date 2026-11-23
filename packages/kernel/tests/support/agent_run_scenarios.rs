use std::collections::BTreeMap;

use chrono::NaiveDate;
use kernel::{
    AgentRunLedgerEntry, AgentRunStatus, AgentRunStatusUpdate, AppId, AppliedChangeSet,
    ApplyChangeSet, ApplyMode, CustomerId, ErrorEnvelope, Field, FieldId, FieldType, FieldValue,
    KernelError, Model, ModelId, ModelKind, RecordKey, RowVersionWrite, Schema, SchemaRevisionId,
    SchemaVersion, StoredAgentRun, AGENT_SOURCE_KIND,
};
use serde_json::Value;

type AgentRunMutation = fn(&mut AgentRunLedgerEntry);

#[derive(Debug, PartialEq)]
pub struct AgentRunEvidence {
    pub status: String,
    pub model_calls: Value,
    pub tool_calls: Value,
    pub token_usage: Value,
    pub validation_failures: Value,
    pub final_outputs: Value,
}

pub trait AgentRunBackend {
    fn materialize_schema(&mut self, schema: &Schema) -> Result<SchemaRevisionId, KernelError>;

    fn apply_change_set(&mut self, apply: &ApplyChangeSet)
        -> Result<AppliedChangeSet, KernelError>;

    fn record_agent_run(
        &mut self,
        run: &AgentRunLedgerEntry,
    ) -> Result<StoredAgentRun, KernelError>;

    fn update_agent_run_status(
        &mut self,
        update: &AgentRunStatusUpdate,
    ) -> Result<StoredAgentRun, KernelError>;

    fn read_agent_run_evidence(
        &mut self,
        app_id: &AppId,
        customer_id: &CustomerId,
        run_id: &str,
    ) -> AgentRunEvidence;

    fn read_change_set_source(&mut self, change_set_id: i64) -> (String, Option<String>);

    fn downgrade_agent_run_status_constraint(&mut self);

    fn record_agent_run_concurrently(
        &mut self,
        run: &AgentRunLedgerEntry,
    ) -> Vec<Result<StoredAgentRun, KernelError>>;
}

pub fn agent_runs_are_recorded_and_required_for_agent_writes(backend: &mut impl AgentRunBackend) {
    let customer_id = "customer_agent";
    let schema_revision_id = backend
        .materialize_schema(&test_schema(customer_id))
        .expect("materialize agent-run schema");

    let mut apply = mainline_apply(customer_id, "acme", "Acme");
    apply.source_kind = AGENT_SOURCE_KIND.to_string();
    apply.source_ref = Some("run_1".to_string());
    assert_error_code(
        backend
            .apply_change_set(&apply)
            .expect_err("unrecorded agent write must fail"),
        "agent_run_missing",
    );

    let mut reviewed_import = mainline_apply(customer_id, "importco", "ImportCo");
    reviewed_import.source_kind = "data_import".to_string();
    reviewed_import.source_ref = Some("unrecorded-agent-run-is-not-required".to_string());
    let import_applied = backend
        .apply_change_set(&reviewed_import)
        .expect("non-agent source does not require a run");
    assert_eq!(
        backend.read_change_set_source(import_applied.id),
        (
            "data_import".to_string(),
            Some("unrecorded-agent-run-is-not-required".to_string())
        )
    );

    let stored = backend
        .record_agent_run(&agent_run(customer_id, "run_1"))
        .expect("record agent run");
    assert_eq!(stored.run_id, "run_1");
    assert_eq!(stored.schema_revision_id, schema_revision_id);

    let applied = backend
        .apply_change_set(&apply)
        .expect("recorded agent write applies");
    assert_eq!(
        backend.read_change_set_source(applied.id),
        (AGENT_SOURCE_KIND.to_string(), Some("run_1".to_string()))
    );

    assert_eq!(
        backend
            .record_agent_run(&agent_run(customer_id, "run_1"))
            .expect("exact replay is idempotent"),
        stored
    );

    let mut conflicting = agent_run(customer_id, "run_1");
    conflicting.execution_profile_id = "writer".to_string();
    assert_error_code(
        backend
            .record_agent_run(&conflicting)
            .expect_err("changed execution profile must conflict"),
        "agent_run_conflict",
    );

    backend
        .record_agent_run(&agent_run(customer_id, "run_field_conflicts"))
        .expect("record conflict fixture");
    let conflict_cases: Vec<(&str, AgentRunMutation)> = vec![
        ("actor_id", |run| run.actor_id = Some("other".to_string())),
        ("agent_identity_id", |run| {
            run.agent_identity_id = "other_agent".to_string()
        }),
        ("execution_profile_id", |run| {
            run.execution_profile_id = "writer".to_string()
        }),
        ("source_artifacts", |run| {
            run.source_artifacts = serde_json::json!([{"artifact_id": "sha256:def"}])
        }),
        ("alignment_decisions", |run| {
            run.alignment_decisions = serde_json::json!([{"decision": "changed"}])
        }),
        ("model_calls", |run| {
            run.model_calls = serde_json::json!([{"model": "changed"}])
        }),
        ("tool_calls", |run| {
            run.tool_calls = serde_json::json!([{"tool": "changed"}])
        }),
        (
            "token_usage",
            |run| run.token_usage = serde_json::json!({"input_tokens": 11, "output_tokens": 4}),
        ),
        ("validation_failures", |run| {
            run.validation_failures = serde_json::json!([{"code": "changed"}])
        }),
        ("final_outputs", |run| {
            run.final_outputs = serde_json::json!({"status": "changed"})
        }),
        ("approval_boundaries", |run| {
            run.approval_boundaries = serde_json::json!([{"boundary": "changed"}])
        }),
        ("compiled_preview_ids", |run| {
            run.compiled_preview_ids = vec!["preview_2".to_string()]
        }),
    ];
    for (field, mutate) in conflict_cases {
        let mut conflicting = agent_run(customer_id, "run_field_conflicts");
        mutate(&mut conflicting);
        let conflict = backend.record_agent_run(&conflicting);
        assert!(conflict.is_err(), "{field} replay should conflict");
        assert_error_code(
            conflict.expect_err("checked conflicting replay result"),
            "agent_run_conflict",
        );
    }
}

pub fn agent_run_status_updates_are_terminal_and_idempotent(backend: &mut impl AgentRunBackend) {
    let customer_id = "customer_agent_status";
    backend
        .materialize_schema(&test_schema(customer_id))
        .expect("materialize agent-run status schema");
    let stored = backend
        .record_agent_run(&agent_run(customer_id, "run_status"))
        .expect("record status run");
    assert_eq!(
        backend
            .record_agent_run(&agent_run(customer_id, "run_status"))
            .expect("record replay"),
        stored
    );

    let update = AgentRunStatusUpdate {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from(customer_id),
        run_id: "run_status".to_string(),
        status: AgentRunStatus::Completed,
        model_calls: Some(serde_json::json!([{"step_number": 0, "model": "gpt-test"}])),
        tool_calls: Some(serde_json::json!([{"step_number": 0, "tool_calls": []}])),
        token_usage: Some(serde_json::json!({"input_tokens": 10, "output_tokens": 4})),
        validation_failures: Some(serde_json::json!([])),
        final_outputs: Some(serde_json::json!({"status": "completed", "text": "done"})),
    };
    assert_eq!(
        backend
            .update_agent_run_status(&update)
            .expect("complete agent run"),
        stored
    );
    let evidence = backend.read_agent_run_evidence(
        &AppId::from("core_app"),
        &CustomerId::from(customer_id),
        "run_status",
    );
    assert_eq!(evidence.status, "completed");
    assert_eq!(
        evidence.model_calls,
        serde_json::json!([{"step_number": 0, "model": "gpt-test"}])
    );
    assert_eq!(
        evidence.tool_calls,
        serde_json::json!([{"step_number": 0, "tool_calls": []}])
    );
    assert_eq!(
        evidence.token_usage,
        serde_json::json!({"input_tokens": 10, "output_tokens": 4})
    );
    assert_eq!(evidence.validation_failures, serde_json::json!([]));
    assert_eq!(
        evidence.final_outputs,
        serde_json::json!({"status": "drafted", "text": "done"})
    );

    assert_error_code(
        backend
            .record_agent_run(&agent_run(customer_id, "run_status"))
            .expect_err("recorded replay after terminal update must conflict"),
        "agent_run_conflict",
    );

    let mut terminal_replay = agent_run(customer_id, "run_status");
    terminal_replay.status = AgentRunStatus::RuntimeError;
    terminal_replay.model_calls = update.model_calls.clone().unwrap();
    terminal_replay.tool_calls = update.tool_calls.clone().unwrap();
    terminal_replay.token_usage = update.token_usage.clone().unwrap();
    terminal_replay.validation_failures = update.validation_failures.clone().unwrap();
    terminal_replay.final_outputs = evidence.final_outputs;
    assert_eq!(
        backend
            .record_agent_run(&terminal_replay)
            .expect("terminal replay retains identity semantics"),
        stored
    );
    assert_eq!(
        backend
            .update_agent_run_status(&update)
            .expect("same terminal update is idempotent"),
        stored
    );
    let conflicting = AgentRunStatusUpdate {
        status: AgentRunStatus::RuntimeError,
        ..update
    };
    assert_error_code(
        backend
            .update_agent_run_status(&conflicting)
            .expect_err("different terminal status must conflict"),
        "agent_run_conflict",
    );

    let mut seeded_run = agent_run(customer_id, "run_merge");
    seeded_run.model_calls = serde_json::json!([{"step_number": 0, "model": "seeded"}]);
    seeded_run.tool_calls = serde_json::json!([{"step_number": 0, "tool": "seeded"}]);
    seeded_run.token_usage = serde_json::json!({"input_tokens": 1});
    seeded_run.validation_failures = serde_json::json!([{"code": "seeded"}]);
    seeded_run.final_outputs = serde_json::json!({"status": "recorded", "text": "seeded"});
    let merge_stored = backend
        .record_agent_run(&seeded_run)
        .expect("record merge fixture");
    let merge_update = AgentRunStatusUpdate {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from(customer_id),
        run_id: "run_merge".to_string(),
        status: AgentRunStatus::ValidationExhausted,
        model_calls: Some(serde_json::json!([{"step_number": 1, "model": "repair"}])),
        tool_calls: Some(serde_json::json!([{"step_number": 1, "tool": "repair"}])),
        token_usage: Some(serde_json::json!({"input_tokens": 99, "output_tokens": 2})),
        validation_failures: Some(serde_json::json!([{"code": "repair_failed"}])),
        final_outputs: Some(serde_json::json!({
            "status": "validation_exhausted",
            "text": "replacement",
            "issues": []
        })),
    };
    assert_eq!(
        backend
            .update_agent_run_status(&merge_update)
            .expect("merge terminal evidence"),
        merge_stored
    );
    assert_eq!(
        backend.read_agent_run_evidence(
            &AppId::from("core_app"),
            &CustomerId::from(customer_id),
            "run_merge",
        ),
        AgentRunEvidence {
            status: "validation_exhausted".to_string(),
            model_calls: serde_json::json!([
                {"step_number": 0, "model": "seeded"},
                {"step_number": 1, "model": "repair"}
            ]),
            tool_calls: serde_json::json!([
                {"step_number": 0, "tool": "seeded"},
                {"step_number": 1, "tool": "repair"}
            ]),
            token_usage: serde_json::json!({"input_tokens": 1, "output_tokens": 2}),
            validation_failures: serde_json::json!([
                {"code": "seeded"},
                {"code": "repair_failed"}
            ]),
            final_outputs: serde_json::json!({
                "status": "recorded",
                "text": "seeded",
                "issues": []
            }),
        }
    );

    let cancelled = backend
        .record_agent_run(&agent_run(customer_id, "run_cancelled"))
        .expect("record cancelled fixture");
    let cancelled_update = AgentRunStatusUpdate {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from(customer_id),
        run_id: "run_cancelled".to_string(),
        status: AgentRunStatus::Cancelled,
        model_calls: None,
        tool_calls: None,
        token_usage: None,
        validation_failures: None,
        final_outputs: None,
    };
    assert_eq!(
        backend
            .update_agent_run_status(&cancelled_update)
            .expect("apply cancelled status"),
        cancelled
    );

    let budget_exhausted = backend
        .record_agent_run(&agent_run(customer_id, "run_budget_exhausted"))
        .expect("record budget-exhausted fixture");
    let budget_exhausted_update = AgentRunStatusUpdate {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from(customer_id),
        run_id: "run_budget_exhausted".to_string(),
        status: AgentRunStatus::BudgetExhausted,
        model_calls: Some(serde_json::json!([{"step_number": 0, "model": "gpt-test"}])),
        tool_calls: Some(serde_json::json!([{"step_number": 0, "tool_calls": []}])),
        token_usage: Some(serde_json::json!({"input_tokens": 10, "output_tokens": 4})),
        validation_failures: Some(serde_json::json!([
            {"code": "tool_call_budget_exceeded", "path": "budget.maxToolCalls"}
        ])),
        final_outputs: Some(serde_json::json!({
            "status": "budget_exhausted",
            "text": "partial",
            "budget_exhausted": {"tool_calls_used": 64, "max_tool_calls": 64}
        })),
    };
    assert_eq!(
        backend
            .update_agent_run_status(&budget_exhausted_update)
            .expect("apply budget-exhausted status"),
        budget_exhausted
    );
}

pub fn materialize_schema_upgrades_agent_run_status_check_for_budget_exhausted(
    backend: &mut impl AgentRunBackend,
) {
    let customer_id = "customer_agent_status_upgrade";
    let schema = test_schema(customer_id);
    backend
        .materialize_schema(&schema)
        .expect("materialize status-upgrade schema");
    backend.downgrade_agent_run_status_constraint();
    backend
        .materialize_schema(&schema)
        .expect("repair agent-run status constraint");
    let stored = backend
        .record_agent_run(&agent_run(customer_id, "run_budget_exhausted"))
        .expect("record budget-exhausted fixture");
    let update = AgentRunStatusUpdate {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from(customer_id),
        run_id: "run_budget_exhausted".to_string(),
        status: AgentRunStatus::BudgetExhausted,
        model_calls: None,
        tool_calls: None,
        token_usage: None,
        validation_failures: None,
        final_outputs: None,
    };
    assert_eq!(
        backend
            .update_agent_run_status(&update)
            .expect("budget-exhausted status works after upgrade"),
        stored
    );
}

pub fn agent_run_replay_survives_later_schema_activation(backend: &mut impl AgentRunBackend) {
    let customer_id = "customer_agent_replay";
    backend
        .materialize_schema(&single_model_schema(customer_id, "v1"))
        .expect("materialize v1 agent-run schema");
    let stored = backend
        .record_agent_run(&agent_run(customer_id, "run_replay"))
        .expect("record v1 agent run");
    let active_revision_id = backend
        .materialize_schema(&single_model_schema(customer_id, "v2"))
        .expect("activate v2 agent-run schema");

    assert_eq!(
        backend
            .record_agent_run(&agent_run(customer_id, "run_replay"))
            .expect("implicit replay resolves recorded revision"),
        stored
    );
    let mut explicit_replay = agent_run(customer_id, "run_replay");
    explicit_replay.schema_revision_id = Some(stored.schema_revision_id);
    assert_eq!(
        backend
            .record_agent_run(&explicit_replay)
            .expect("explicit recorded-revision replay"),
        stored
    );

    let mut wrong_revision_replay = agent_run(customer_id, "run_replay");
    wrong_revision_replay.schema_revision_id = Some(active_revision_id);
    assert_error_code(
        backend
            .record_agent_run(&wrong_revision_replay)
            .expect_err("existing run cannot be rebound to active revision"),
        "agent_run_schema_mismatch",
    );

    let mut stale_new_run = agent_run(customer_id, "run_stale_new");
    stale_new_run.schema_revision_id = Some(stored.schema_revision_id);
    assert_error_code(
        backend
            .record_agent_run(&stale_new_run)
            .expect_err("new run cannot use stale revision"),
        "stale_schema_revision",
    );
}

pub fn concurrent_agent_run_records_are_idempotent_or_conflicting(
    backend: &mut impl AgentRunBackend,
) {
    let customer_id = "customer_agent_concurrent";
    let schema_revision_id = backend
        .materialize_schema(&test_schema(customer_id))
        .expect("materialize concurrent agent-run schema");
    let results = backend.record_agent_run_concurrently(&agent_run(customer_id, "run_concurrent"));
    assert_eq!(results.len(), 2);
    let runs = results
        .into_iter()
        .map(|result| result.expect("concurrent identical run is idempotent"))
        .collect::<Vec<_>>();
    assert_eq!(runs[0].run_id, runs[1].run_id);
    assert_eq!(runs[0].schema_revision_id, schema_revision_id);
    assert_eq!(runs[1].schema_revision_id, schema_revision_id);
}

pub fn agent_run_provenance_fails_closed_when_schema_is_stale(backend: &mut impl AgentRunBackend) {
    let customer_id = "customer_agent_stale";
    backend
        .materialize_schema(&single_model_schema(customer_id, "v1"))
        .expect("materialize stale-provenance v1 schema");
    backend
        .record_agent_run(&agent_run(customer_id, "run_stale"))
        .expect("record stale-provenance run");
    backend
        .materialize_schema(&single_model_schema(customer_id, "v2"))
        .expect("activate stale-provenance v2 schema");

    let mut apply = mainline_apply(customer_id, "stale", "Stale");
    apply.source_kind = AGENT_SOURCE_KIND.to_string();
    apply.source_ref = Some("run_stale".to_string());
    assert_error_code(
        backend
            .apply_change_set(&apply)
            .expect_err("stale agent-run provenance must fail closed"),
        "agent_run_schema_mismatch",
    );
}

pub fn agent_run(customer_id: &str, run_id: &str) -> AgentRunLedgerEntry {
    AgentRunLedgerEntry {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from(customer_id),
        run_id: run_id.to_string(),
        status: AgentRunStatus::Recorded,
        schema_revision_id: None,
        actor_id: Some("agent".to_string()),
        agent_identity_id: "csv_import_planner".to_string(),
        execution_profile_id: "planner".to_string(),
        source_artifacts: serde_json::json!([{"artifact_id": "sha256:abc"}]),
        alignment_decisions: serde_json::json!([]),
        model_calls: serde_json::json!([]),
        tool_calls: serde_json::json!([]),
        token_usage: serde_json::json!({"input_tokens": 10, "output_tokens": 4}),
        validation_failures: serde_json::json!([]),
        final_outputs: serde_json::json!({"status": "drafted"}),
        approval_boundaries: serde_json::json!([]),
        compiled_preview_ids: vec!["preview_1".to_string()],
    }
}

fn test_schema(customer_id: &str) -> Schema {
    single_model_schema(customer_id, "2026-05-04")
}

fn single_model_schema(customer_id: &str, version: &str) -> Schema {
    Schema {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from(customer_id),
        version: SchemaVersion::from(version),
        models: vec![Model {
            id: ModelId::from("company"),
            kind: ModelKind::Entity,
            label: "Company".to_string(),
            fields: vec![Field {
                id: FieldId::from("name"),
                label: "Name".to_string(),
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
    }
}

fn mainline_apply(customer_id: &str, external_key: &str, name: &str) -> ApplyChangeSet {
    ApplyChangeSet {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from(customer_id),
        schema_revision_id: None,
        actor_id: Some("tester".to_string()),
        source_kind: "test".to_string(),
        source_ref: None,
        idempotency_key: Some(format!("agent-run-{external_key}")),
        change_type_id: None,
        notes: None,
        mode: ApplyMode::Mainline,
        writes: vec![RowVersionWrite {
            model_id: ModelId::from("company"),
            new_record_id: None,
            record_key: Some(RecordKey::ExternalKey(external_key.into())),
            effective_start: date("2026-01-01"),
            values: Some(BTreeMap::from([(
                FieldId::from("name"),
                FieldValue::Text(name.to_string()),
            )])),
            custom_fields: None,
            tombstones_record: false,
            provenance: None,
            ..Default::default()
        }],
    }
}

fn assert_error_code(error: KernelError, code: &str) {
    let ErrorEnvelope { code: actual, .. } = error.into_envelope();
    assert_eq!(actual, code);
}

fn date(value: &str) -> NaiveDate {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").unwrap()
}
