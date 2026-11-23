use super::trusted_human;
use std::env;
use std::sync::{Arc, Barrier};
use std::thread;

use chrono::NaiveDate;
use kernel::testing::{call_generated_sql, GeneratedSqlFunction};
use kernel::{
    connect_postgres, normalize_identifier, AgentRunLedgerEntry, AgentRunStatusUpdate, AppId,
    AppliedChangeSet, ApplyChangeSet, ChangeSetDiff, ChangeSetDiffRequest, CustomerId, DraftRecord,
    FieldHistoryEntry, FieldHistoryRequest, KernelError, ModelId, RecordId, RevertChangeSet,
    Schema, SchemaRevisionId, StoredAgentRun, VisibleRecord,
};
use postgres::Client;
use schema_compiler::{
    compile_sql_artifact_manifest, render_sql_artifact_bundle, CompiledManifest,
    NormalizedManifestExtras,
};
use serde_json::json;
use uuid::Uuid;

use super::agent_run_scenarios::{AgentRunBackend, AgentRunEvidence};
use super::parity_scenarios::ParityBackend;

pub struct GeneratedSqlBackend {
    client: Client,
    schema_name: String,
}

impl AgentRunBackend for GeneratedSqlBackend {
    fn materialize_schema(&mut self, schema: &Schema) -> Result<SchemaRevisionId, KernelError> {
        ParityBackend::materialize_schema(self, schema)
    }

    fn apply_change_set(
        &mut self,
        apply: &ApplyChangeSet,
    ) -> Result<AppliedChangeSet, KernelError> {
        ParityBackend::apply_change_set(self, apply)
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

    fn read_agent_run_evidence(
        &mut self,
        app_id: &AppId,
        customer_id: &CustomerId,
        run_id: &str,
    ) -> AgentRunEvidence {
        let row = self
            .client
            .query_one(
                r#"
                select status, model_calls, tool_calls, token_usage,
                       validation_failures, final_outputs
                from agent_run
                where app_id = $1 and customer_id = $2 and run_id = $3
                "#,
                &[&app_id.as_str(), &customer_id.as_str(), &run_id],
            )
            .expect("read generated-SQL agent-run evidence");
        AgentRunEvidence {
            status: row.get("status"),
            model_calls: row.get("model_calls"),
            tool_calls: row.get("tool_calls"),
            token_usage: row.get("token_usage"),
            validation_failures: row.get("validation_failures"),
            final_outputs: row.get("final_outputs"),
        }
    }

    fn read_change_set_source(&mut self, change_set_id: i64) -> (String, Option<String>) {
        let row = self
            .client
            .query_one(
                "select source_kind, source_ref from change_set where id = $1",
                &[&change_set_id],
            )
            .expect("read generated-SQL change-set source");
        (row.get("source_kind"), row.get("source_ref"))
    }

    fn downgrade_agent_run_status_constraint(&mut self) {
        self.client
            .batch_execute(
                r#"
                alter table agent_run drop constraint agent_run_status_check;
                alter table agent_run add constraint agent_run_status_check
                  check (status in ('recorded', 'completed', 'validation_exhausted', 'runtime_error'));
                "#,
            )
            .expect("downgrade generated-SQL agent-run status constraint");
    }

    fn record_agent_run_concurrently(
        &mut self,
        run: &AgentRunLedgerEntry,
    ) -> Vec<Result<StoredAgentRun, KernelError>> {
        let database_url = env::var("KERNEL_TEST_DATABASE_URL")
            .expect("KERNEL_TEST_DATABASE_URL is present for parity test");
        let barrier = Arc::new(Barrier::new(2));
        (0..2)
            .map(|_| {
                let database_url = database_url.clone();
                let schema_name = self.schema_name.clone();
                let barrier = Arc::clone(&barrier);
                let run = run.clone();
                thread::spawn(move || {
                    let mut client = connect_postgres(&database_url)
                        .expect("connect concurrent generated-SQL agent-run client");
                    barrier.wait();
                    // The managed-Neon URL may use transaction pooling, where a
                    // session-scoped search path is not retained by the next
                    // statement. Keep fixture schema selection in the same
                    // transaction as the generated operation.
                    client
                        .batch_execute(&format!(
                            r#"begin; set local search_path to "{schema_name}""#
                        ))
                        .expect("begin concurrent generated-SQL fixture transaction");
                    match call_generated_sql(
                        &mut client,
                        GeneratedSqlFunction::RecordAgentRun,
                        &run,
                    ) {
                        Ok(record) => {
                            client
                                .batch_execute("commit")
                                .expect("commit concurrent generated-SQL fixture transaction");
                            Ok(record)
                        }
                        Err(error) => {
                            client.batch_execute("rollback").expect(
                                "roll back failed concurrent generated-SQL fixture transaction",
                            );
                            Err(error)
                        }
                    }
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|handle| handle.join().expect("join generated-SQL agent-run client"))
            .collect()
    }
}

impl GeneratedSqlBackend {
    // Individual parity integration-test crates select only the helpers they
    // exercise. Keep the shared fixture constructor available to the suites
    // that use it without making a TLS-specific suite fail its dead-code gate.
    #[allow(dead_code)]
    pub fn connect() -> Option<Self> {
        let database_url = match env::var("KERNEL_TEST_DATABASE_URL") {
            Ok(url) => url,
            Err(env::VarError::NotPresent) => {
                eprintln!("skipping generated SQL parity test: KERNEL_TEST_DATABASE_URL is absent");
                return None;
            }
            Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
        };
        let mut client = connect_postgres(&database_url).expect("connect to test PostgreSQL");
        let schema_name = format!("kernel_parity_{}", Uuid::new_v4().simple());
        client
            .batch_execute(&format!(
                "create schema \"{schema_name}\"; set search_path to \"{schema_name}\""
            ))
            .expect("create isolated generated SQL parity schema");
        Some(Self {
            client,
            schema_name,
        })
    }
}

impl ParityBackend for GeneratedSqlBackend {
    fn materialize_schema(&mut self, schema: &Schema) -> Result<SchemaRevisionId, KernelError> {
        let compiled = CompiledManifest {
            schema: schema.clone(),
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
        };
        let manifest = compile_sql_artifact_manifest(&compiled)
            .unwrap_or_else(|error| panic!("compile generated SQL parity bundle: {error}"));
        trusted_human::before_install(&mut self.client);
        self.client
            .batch_execute(&render_sql_artifact_bundle(&manifest))
            .unwrap_or_else(|error| panic!("install generated SQL parity bundle: {error:?}"));
        trusted_human::grant_capability(&mut self.client, "query");
        let schema_json = serde_json::to_value(schema)
            .unwrap_or_else(|error| panic!("serialize generated SQL parity schema: {error}"));
        let mut transaction = self
            .client
            .transaction()
            .unwrap_or_else(|error| panic!("begin generated SQL schema activation: {error}"));
        transaction
            .execute(
                "update schema_revision set activated_at = null where app_id = $1 and customer_id = $2 and activated_at is not null",
                &[&schema.app_id.as_str(), &schema.customer_id.as_str()],
            )
            .unwrap_or_else(|error| panic!("deactivate generated SQL schema revision: {error}"));
        let revision_id: i64 = transaction
            .query_one(
                r#"
                insert into schema_revision (
                  app_id, customer_id, version, base_schema, customer_overlay,
                  schema, activated_at, materialized_at
                ) values ($1, $2, $3, $4, '{}'::jsonb, $4, now(), now())
                on conflict (app_id, customer_id, version) do update set
                  activated_at = excluded.activated_at,
                  materialized_at = excluded.materialized_at
                where schema_revision.schema = excluded.schema
                returning id
                "#,
                &[
                    &schema.app_id.as_str(),
                    &schema.customer_id.as_str(),
                    &schema.version.as_str(),
                    &schema_json,
                ],
            )
            .unwrap_or_else(|error| panic!("activate generated SQL parity schema: {error:?}"))
            .get(0);
        transaction
            .commit()
            .unwrap_or_else(|error| panic!("commit generated SQL schema activation: {error}"));
        trusted_human::bind(
            &mut self.client,
            schema.app_id.as_str(),
            schema.customer_id.as_str(),
            "tester",
        );
        Ok(SchemaRevisionId::new(revision_id))
    }

    fn apply_change_set(
        &mut self,
        apply: &ApplyChangeSet,
    ) -> Result<AppliedChangeSet, KernelError> {
        call_generated_sql(
            &mut self.client,
            GeneratedSqlFunction::ApplyChangeSet,
            apply,
        )
    }

    fn validate_change_set_dry_run(
        &mut self,
        apply: &ApplyChangeSet,
    ) -> Result<AppliedChangeSet, KernelError> {
        call_generated_sql(
            &mut self.client,
            GeneratedSqlFunction::ValidateChangeSetDryRun,
            apply,
        )
    }

    fn read_draft_change_set(
        &mut self,
        app_id: &AppId,
        customer_id: &CustomerId,
        change_set_id: i64,
    ) -> Result<Vec<DraftRecord>, KernelError> {
        call_generated_sql(
            &mut self.client,
            GeneratedSqlFunction::ReadDraftChangeSet,
            &json!({
                "app_id": app_id,
                "customer_id": customer_id,
                "change_set_id": change_set_id,
            }),
        )
    }

    fn approve_draft_change_set(
        &mut self,
        app_id: &AppId,
        customer_id: &CustomerId,
        change_set_id: i64,
    ) -> Result<AppliedChangeSet, KernelError> {
        call_generated_sql(
            &mut self.client,
            GeneratedSqlFunction::ApproveDraftChangeSet,
            &json!({
                "actor_id": "tester",
                "app_id": app_id,
                "customer_id": customer_id,
                "change_set_id": change_set_id,
            }),
        )
    }

    fn discard_draft_change_set(
        &mut self,
        app_id: &AppId,
        customer_id: &CustomerId,
        change_set_id: i64,
    ) -> Result<AppliedChangeSet, KernelError> {
        call_generated_sql(
            &mut self.client,
            GeneratedSqlFunction::DiscardDraftChangeSet,
            &json!({
                "app_id": app_id,
                "customer_id": customer_id,
                "change_set_id": change_set_id,
            }),
        )
    }

    fn revert_change_set(
        &mut self,
        request: &RevertChangeSet,
    ) -> Result<AppliedChangeSet, KernelError> {
        call_generated_sql(
            &mut self.client,
            GeneratedSqlFunction::RevertChangeSet,
            request,
        )
    }

    fn read_visible_records(
        &mut self,
        app_id: &AppId,
        customer_id: &CustomerId,
        model_id: &ModelId,
        as_of: NaiveDate,
    ) -> Result<Vec<VisibleRecord>, KernelError> {
        call_generated_sql(
            &mut self.client,
            GeneratedSqlFunction::ReadVisibleRecords,
            &json!({
                "app_id": app_id,
                "customer_id": customer_id,
                "model_id": model_id,
                "as_of": as_of,
            }),
        )
    }

    fn change_set_diff(
        &mut self,
        request: &ChangeSetDiffRequest,
    ) -> Result<ChangeSetDiff, KernelError> {
        call_generated_sql(
            &mut self.client,
            GeneratedSqlFunction::ChangeSetDiff,
            request,
        )
    }

    fn field_history(
        &mut self,
        request: &FieldHistoryRequest,
    ) -> Result<Vec<FieldHistoryEntry>, KernelError> {
        call_generated_sql(
            &mut self.client,
            GeneratedSqlFunction::FieldHistory,
            request,
        )
    }

    fn invert_version_created_at(&mut self, change_set_ids: &[i64]) {
        assert_eq!(change_set_ids.len(), 2);
        self.client
            .execute(
                r#"
                update company_version
                set created_at = case change_set_id
                  when $1 then timestamptz '2026-05-02 00:00:00+00'
                  when $2 then timestamptz '2026-05-01 00:00:00+00'
                end
                where change_set_id = any($3)
                "#,
                &[&change_set_ids[0], &change_set_ids[1], &change_set_ids],
            )
            .expect("invert generated-SQL parity timestamps");
    }

    fn count_record_subjects(
        &mut self,
        app_id: &AppId,
        customer_id: &CustomerId,
        subjects: &[(ModelId, RecordId)],
    ) -> i64 {
        subjects
            .iter()
            .map(|(model_id, record_id)| {
                let model_identifier = normalize_identifier(model_id.as_str())
                    .expect("parity model identifier is valid");
                self.client
                    .query_one(
                        &format!(
                            "select count(*) from {model_identifier}_record where id = $1 and app_id = $2 and customer_id = $3"
                        ),
                        &[&record_id, &app_id.as_str(), &customer_id.as_str()],
                    )
                    .expect("count parity record subjects")
                    .get::<_, i64>(0)
            })
            .sum()
    }

    fn count_change_sets_by_idempotency_key(
        &mut self,
        app_id: &AppId,
        customer_id: &CustomerId,
        idempotency_key: &str,
    ) -> i64 {
        self.client
            .query_one(
                "select count(*) from change_set where app_id = $1 and customer_id = $2 and idempotency_key = $3",
                &[&app_id.as_str(), &customer_id.as_str(), &idempotency_key],
            )
            .expect("count parity change sets")
            .get(0)
    }
}

impl Drop for GeneratedSqlBackend {
    fn drop(&mut self) {
        let _ = trusted_human::drop_fixture(&mut self.client, &self.schema_name);
    }
}
