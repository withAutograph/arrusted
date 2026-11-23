use std::env;
use std::sync::{Arc, Barrier};
use std::thread;

use chrono::NaiveDate;
use kernel::testing;
use kernel::{
    normalize_identifier, AgentRunLedgerEntry, AgentRunStatusUpdate, AppId, AppliedChangeSet,
    ApplyChangeSet, ChangeSetDiff, ChangeSetDiffRequest, CustomerId, DraftRecord,
    FieldHistoryEntry, FieldHistoryRequest, KernelError, ModelId, RecordId, RevertChangeSet,
    Schema, SchemaRevisionId, StoredAgentRun, VisibleRecord,
};
use postgres::{Client, NoTls};

use super::agent_run_scenarios::{AgentRunBackend, AgentRunEvidence};
use super::parity_scenarios::ParityBackend;

pub struct RustKernelBackend<'a> {
    client: &'a mut Client,
}

impl AgentRunBackend for RustKernelBackend<'_> {
    fn materialize_schema(&mut self, schema: &Schema) -> Result<SchemaRevisionId, KernelError> {
        testing::materialize_schema(self.client, schema).map_err(KernelError::from)
    }

    fn apply_change_set(
        &mut self,
        apply: &ApplyChangeSet,
    ) -> Result<AppliedChangeSet, KernelError> {
        testing::apply_change_set(self.client, apply).map_err(KernelError::from)
    }

    fn record_agent_run(
        &mut self,
        run: &AgentRunLedgerEntry,
    ) -> Result<StoredAgentRun, KernelError> {
        testing::record_agent_run(self.client, run).map_err(KernelError::from)
    }

    fn update_agent_run_status(
        &mut self,
        update: &AgentRunStatusUpdate,
    ) -> Result<StoredAgentRun, KernelError> {
        testing::update_agent_run_status(self.client, update).map_err(KernelError::from)
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
            .expect("read Rust-kernel agent-run evidence");
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
            .expect("read Rust-kernel change-set source");
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
            .expect("downgrade Rust-kernel agent-run status constraint");
    }

    fn record_agent_run_concurrently(
        &mut self,
        run: &AgentRunLedgerEntry,
    ) -> Vec<Result<StoredAgentRun, KernelError>> {
        let database_url = env::var("PLATFORM_TEST_DATABASE_URL")
            .expect("PLATFORM_TEST_DATABASE_URL is present for kernel test");
        let schema_name: String = self
            .client
            .query_one("select current_schema()", &[])
            .expect("read Rust-kernel parity schema")
            .get(0);
        let barrier = Arc::new(Barrier::new(2));
        (0..2)
            .map(|_| {
                let database_url = database_url.clone();
                let schema_name = schema_name.clone();
                let barrier = Arc::clone(&barrier);
                let run = run.clone();
                thread::spawn(move || {
                    let mut client = Client::connect(&database_url, NoTls)
                        .expect("connect concurrent Rust-kernel agent-run client");
                    client
                        .batch_execute(&format!(r#"set search_path to "{schema_name}""#))
                        .expect("set concurrent Rust-kernel search path");
                    barrier.wait();
                    testing::record_agent_run(&mut client, &run).map_err(KernelError::from)
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|handle| handle.join().expect("join Rust-kernel agent-run client"))
            .collect()
    }
}

impl<'a> RustKernelBackend<'a> {
    pub fn new(client: &'a mut Client) -> Self {
        Self { client }
    }
}

impl ParityBackend for RustKernelBackend<'_> {
    fn materialize_schema(&mut self, schema: &Schema) -> Result<SchemaRevisionId, KernelError> {
        testing::materialize_schema(self.client, schema).map_err(KernelError::from)
    }

    fn apply_change_set(
        &mut self,
        apply: &ApplyChangeSet,
    ) -> Result<AppliedChangeSet, KernelError> {
        testing::apply_change_set(self.client, apply).map_err(KernelError::from)
    }

    fn validate_change_set_dry_run(
        &mut self,
        apply: &ApplyChangeSet,
    ) -> Result<AppliedChangeSet, KernelError> {
        testing::validate_change_set_dry_run(self.client, apply).map_err(KernelError::from)
    }

    fn read_draft_change_set(
        &mut self,
        app_id: &AppId,
        customer_id: &CustomerId,
        change_set_id: i64,
    ) -> Result<Vec<DraftRecord>, KernelError> {
        testing::read_draft_change_set(self.client, app_id, customer_id, change_set_id)
            .map_err(KernelError::from)
    }

    fn approve_draft_change_set(
        &mut self,
        app_id: &AppId,
        customer_id: &CustomerId,
        change_set_id: i64,
    ) -> Result<AppliedChangeSet, KernelError> {
        testing::approve_draft_change_set(self.client, app_id, customer_id, change_set_id)
            .map_err(KernelError::from)
    }

    fn discard_draft_change_set(
        &mut self,
        app_id: &AppId,
        customer_id: &CustomerId,
        change_set_id: i64,
    ) -> Result<AppliedChangeSet, KernelError> {
        testing::discard_draft_change_set(self.client, app_id, customer_id, change_set_id)
            .map_err(KernelError::from)
    }

    fn revert_change_set(
        &mut self,
        request: &RevertChangeSet,
    ) -> Result<AppliedChangeSet, KernelError> {
        testing::revert_change_set(self.client, request).map_err(KernelError::from)
    }

    fn read_visible_records(
        &mut self,
        app_id: &AppId,
        customer_id: &CustomerId,
        model_id: &ModelId,
        as_of: NaiveDate,
    ) -> Result<Vec<VisibleRecord>, KernelError> {
        testing::read_visible_records(self.client, app_id, customer_id, model_id, as_of)
            .map_err(KernelError::from)
    }

    fn change_set_diff(
        &mut self,
        request: &ChangeSetDiffRequest,
    ) -> Result<ChangeSetDiff, KernelError> {
        testing::change_set_diff(self.client, request).map_err(KernelError::from)
    }

    fn field_history(
        &mut self,
        request: &FieldHistoryRequest,
    ) -> Result<Vec<FieldHistoryEntry>, KernelError> {
        testing::field_history(self.client, request).map_err(KernelError::from)
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
            .expect("invert Rust-kernel parity timestamps");
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
