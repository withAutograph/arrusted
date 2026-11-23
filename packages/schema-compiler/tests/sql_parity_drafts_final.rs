use std::collections::BTreeMap;
use std::env;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};
use support::trusted_human;

use chrono::NaiveDate;
use kernel::testing::{
    apply_generated_sql_change_set_in_transaction, begin_generated_sql_tenant_transaction,
    GeneratedSqlFunction,
};
use kernel::{
    connect_postgres, AppId, AppliedChangeSet, ApplyChangeSet, ApplyMode, CustomerId, ErrorDetail,
    ErrorEnvelope, ExternalKey, Field, FieldId, FieldType, FieldValue, KernelError, Model, ModelId,
    ModelKind, MoneyRatePeriod, MoneyRateValue, RecordKey, RowVersionWrite, Schema, SchemaVersion,
    VisibleRecord,
};
use postgres::error::SqlState;
use postgres::Client;
use rust_decimal::Decimal;
use schema_compiler::{
    compile_sql_artifact_manifest, render_sql_artifact_bundle, CompiledManifest,
    NormalizedManifestExtras,
};
use serde::Serialize;
use serde_json::json;
use uuid::Uuid;

mod support;

const APP_ID: &str = "draft_final_app";
const CUSTOMER_ID: &str = "tenant_a";

struct Fixture {
    client: Client,
    schema_name: String,
}

impl Fixture {
    fn connect() -> Option<Self> {
        let database_url = match env::var("KERNEL_TEST_DATABASE_URL") {
            Ok(value) => value,
            Err(env::VarError::NotPresent) => {
                eprintln!("skipping generated draft parity: KERNEL_TEST_DATABASE_URL is absent");
                return None;
            }
            Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
        };
        let compiled = compiled_schema();
        let manifest = compile_sql_artifact_manifest(&compiled).expect("compile SQL artifacts");
        let bundle = render_sql_artifact_bundle(&manifest);
        let mut client = connect_postgres(&database_url).expect("connect to PostgreSQL");
        let schema_name = format!("kernel_draft_final_{}", Uuid::new_v4().simple());
        client
            .batch_execute(&format!(
                "create schema \"{schema_name}\"; set search_path to \"{schema_name}\""
            ))
            .expect("create fixture schema");
        trusted_human::before_install(&mut client);
        client
            .batch_execute(&bundle)
            .expect("install generated SQL bundle");
        let schema_json = serde_json::to_value(&compiled.schema).expect("serialize schema");
        client
            .execute(
                "insert into schema_revision(app_id,customer_id,version,base_schema,customer_overlay,schema,activated_at,materialized_at) values($1,$2,$3,$4,'{}',$4,now(),now())",
                &[&APP_ID, &CUSTOMER_ID, &compiled.schema.version.as_str(), &schema_json],
            )
            .expect("activate generated schema revision");
        trusted_human::bind(&mut client, APP_ID, CUSTOMER_ID, "tester");
        Some(Self {
            client,
            schema_name,
        })
    }

    fn call<T: serde::de::DeserializeOwned>(
        &mut self,
        function: GeneratedSqlFunction,
        request: &(impl Serialize + ?Sized),
    ) -> Result<T, KernelError> {
        function.call_top_level(&mut self.client, request)
    }

    fn apply(
        &mut self,
        mode: ApplyMode,
        key: &str,
        writes: Vec<RowVersionWrite>,
    ) -> Result<AppliedChangeSet, KernelError> {
        self.call(
            GeneratedSqlFunction::ApplyChangeSet,
            &apply_request(mode, key, writes),
        )
    }

    fn approve(&mut self, change_set_id: i64) -> Result<AppliedChangeSet, KernelError> {
        self.call(
            GeneratedSqlFunction::ApproveDraftChangeSet,
            &draft_request(change_set_id),
        )
    }

    fn discard(&mut self, change_set_id: i64) -> Result<AppliedChangeSet, KernelError> {
        self.call(
            GeneratedSqlFunction::DiscardDraftChangeSet,
            &draft_request(change_set_id),
        )
    }

    fn visible(&mut self, model_id: &str, as_of: &str) -> Vec<VisibleRecord> {
        self.call(
            GeneratedSqlFunction::ReadVisibleRecords,
            &json!({
                "app_id": APP_ID,
                "customer_id": CUSTOMER_ID,
                "model_id": model_id,
                "as_of": as_of,
            }),
        )
        .expect("read visible generated SQL records")
    }

    fn lifecycle_sequence(&mut self) -> (i64, bool) {
        let row = self
            .client
            .query_one(
                "select last_value,is_called from change_set_lifecycle_order_seq",
                &[],
            )
            .expect("read lifecycle sequence");
        (row.get(0), row.get(1))
    }

    fn record_id(&mut self, model_id: &str, external_key: &str) -> Uuid {
        self.client
            .query_one(
                &format!(
                    "select id from {model_id}_record where app_id=$1 and customer_id=$2 and external_key=$3"
                ),
                &[&APP_ID, &CUSTOMER_ID, &external_key],
            )
            .expect("read record id")
            .get(0)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        support::drop_generated_sql_fixture(&mut self.client, &self.schema_name);
    }
}

fn compiled_schema() -> CompiledManifest {
    let field = |id: &str, field_type: FieldType, required: bool, is_unique: bool| Field {
        id: FieldId::from(id),
        label: id.to_string(),
        field_type,
        required,
        is_unique,
        target_model: None,
        option_set: vec![],
        ..Default::default()
    };
    let mut employer = field("employer", FieldType::Relation, false, false);
    employer.target_model = Some(ModelId::from("company"));
    CompiledManifest {
        schema: Schema {
            app_id: AppId::from(APP_ID),
            customer_id: CustomerId::from(CUSTOMER_ID),
            version: SchemaVersion::from("2026-08-04.draft-final"),
            models: vec![
                Model {
                    id: ModelId::from("company"),
                    kind: ModelKind::Entity,
                    label: "Company".to_string(),
                    fields: vec![field("name", FieldType::Text, true, false)],
                    ..Default::default()
                },
                Model {
                    id: ModelId::from("employee"),
                    kind: ModelKind::Entity,
                    label: "Employee".to_string(),
                    fields: vec![
                        field("name", FieldType::Text, true, false),
                        field("ref", FieldType::Text, false, true),
                        employer,
                        field("comp_rate", FieldType::MoneyRate, false, false),
                    ],
                    ..Default::default()
                },
            ],
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

fn connect_to_schema(schema_name: &str) -> Client {
    let database_url = env::var("KERNEL_TEST_DATABASE_URL").expect("test database URL");
    let mut client = connect_postgres(&database_url).expect("connect concurrent PostgreSQL client");
    client
        .batch_execute(&format!("set search_path to \"{schema_name}\""))
        .expect("set generated SQL search path");
    trusted_human::select(&mut client, "tester");
    client
}

fn date(value: &str) -> NaiveDate {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").expect("valid date")
}

fn text_values(name: &str) -> BTreeMap<FieldId, FieldValue> {
    BTreeMap::from([(FieldId::from("name"), FieldValue::Text(name.to_string()))])
}

fn employee_values(
    name: &str,
    reference: Option<&str>,
    employer: Option<&str>,
) -> BTreeMap<FieldId, FieldValue> {
    let mut values = text_values(name);
    if let Some(reference) = reference {
        values.insert(
            FieldId::from("ref"),
            FieldValue::Text(reference.to_string()),
        );
    }
    if let Some(employer) = employer {
        values.insert(
            FieldId::from("employer"),
            FieldValue::Relation(RecordKey::ExternalKey(ExternalKey::from(employer))),
        );
    }
    values
}

fn compensation(amount: i64) -> FieldValue {
    FieldValue::MoneyRate(MoneyRateValue {
        amount: Decimal::new(amount, 2),
        currency: "USD".to_string(),
        period: MoneyRatePeriod::Hourly,
    })
}

fn write(
    model_id: &str,
    external_key: &str,
    effective_start: &str,
    values: Option<BTreeMap<FieldId, FieldValue>>,
    tombstones_record: bool,
) -> RowVersionWrite {
    RowVersionWrite {
        model_id: ModelId::from(model_id),
        new_record_id: None,
        record_key: Some(RecordKey::ExternalKey(ExternalKey::from(external_key))),
        effective_start: date(effective_start),
        values,
        custom_fields: None,
        tombstones_record,
        provenance: None,
        ..Default::default()
    }
}

fn apply_request(mode: ApplyMode, key: &str, writes: Vec<RowVersionWrite>) -> ApplyChangeSet {
    ApplyChangeSet {
        app_id: AppId::from(APP_ID),
        customer_id: CustomerId::from(CUSTOMER_ID),
        schema_revision_id: None,
        actor_id: Some("tester".to_string()),
        source_kind: "test".to_string(),
        source_ref: None,
        idempotency_key: Some(key.to_string()),
        change_type_id: None,
        notes: None,
        mode,
        writes,
    }
}

fn draft_request(change_set_id: i64) -> serde_json::Value {
    json!({
        "app_id": APP_ID,
        "customer_id": CUSTOMER_ID,
        "change_set_id": change_set_id,
            "actor_id": "tester",
    })
}

fn plain_error(code: &str, message: String) -> ErrorEnvelope {
    ErrorEnvelope {
        code: code.to_string(),
        message,
        details: vec![],
    }
}

fn unique_error(value: &str) -> ErrorEnvelope {
    ErrorEnvelope {
        code: "unique_field_conflict".to_string(),
        message: "Unique field value already exists".to_string(),
        details: vec![
            ErrorDetail {
                path: "model".to_string(),
                code: "unique_field_conflict".to_string(),
                message: "employee".to_string(),
            },
            ErrorDetail {
                path: "field".to_string(),
                code: "unique_field_conflict".to_string(),
                message: "ref".to_string(),
            },
            ErrorDetail {
                path: "value".to_string(),
                code: "unique_field_conflict".to_string(),
                message: value.to_string(),
            },
        ],
    }
}

fn wait_until_blocked(transaction: &mut postgres::Transaction<'_>, pid: i32, label: &str) {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let waiting: bool = transaction
            .query_one(
                "select exists(select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock')",
                &[&pid],
            )
            .expect("inspect waiting generated SQL backend")
            .get(0);
        if waiting {
            return;
        }
        assert!(Instant::now() < deadline, "{label} never reached lock");
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn draft_save_rechecks_its_locked_baseline_and_approval_promotes_same_day_history_match_generated_sql(
) {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    fixture
        .apply(
            ApplyMode::Mainline,
            "draft-locked-baseline",
            vec![
                write(
                    "company",
                    "acme",
                    "2026-04-01",
                    Some(text_values("Acme")),
                    false,
                ),
                write(
                    "employee",
                    "alice",
                    "2026-04-01",
                    Some(employee_values("Alice", None, Some("acme"))),
                    false,
                ),
            ],
        )
        .unwrap();

    let schema_name = fixture.schema_name.clone();
    let mut direct_tx = begin_generated_sql_tenant_transaction(
        &mut fixture.client,
        &AppId::from(APP_ID),
        &CustomerId::from(CUSTOMER_ID),
    )
    .unwrap();
    let direct = apply_generated_sql_change_set_in_transaction(
        &mut direct_tx,
        &apply_request(
            ApplyMode::Mainline,
            "mainline-before-draft-lock-baseline",
            vec![write(
                "employee",
                "alice",
                "2026-05-01",
                Some(BTreeMap::from([(
                    FieldId::from("comp_rate"),
                    compensation(15000),
                )])),
                false,
            )],
        ),
    )
    .unwrap();

    let (pid_sender, pid_receiver) = mpsc::channel();
    let draft_thread = thread::spawn(move || {
        let mut client = connect_to_schema(&schema_name);
        let pid: i32 = client
            .query_one("select pg_backend_pid()", &[])
            .unwrap()
            .get(0);
        pid_sender.send(pid).unwrap();
        GeneratedSqlFunction::ApplyChangeSet.call_top_level::<AppliedChangeSet>(
            &mut client,
            &apply_request(
                ApplyMode::Draft,
                "draft-after-locked-baseline",
                vec![write(
                    "employee",
                    "alice",
                    "2026-05-01",
                    Some(text_values("Alice Draft")),
                    false,
                )],
            ),
        )
    });
    let draft_pid = pid_receiver.recv().unwrap();
    wait_until_blocked(&mut direct_tx, draft_pid, "draft apply");
    direct_tx.commit().unwrap();
    let draft = draft_thread.join().unwrap().unwrap();

    let draft_records: Vec<kernel::DraftRecord> = fixture
        .call(
            GeneratedSqlFunction::ReadDraftChangeSet,
            &draft_request(draft.id),
        )
        .unwrap();
    assert_eq!(draft_records.len(), 1);
    assert_eq!(
        draft_records[0].values.get(&FieldId::from("comp_rate")),
        Some(&compensation(15000))
    );
    let orders = fixture
        .client
        .query_one(
            "select (select applied_order from change_set where id=$1) direct_order,created_order,applied_order from change_set where id=$2",
            &[&direct.id, &draft.id],
        )
        .unwrap();
    let direct_order: i64 = orders.get("direct_order");
    let draft_created_order: i64 = orders.get("created_order");
    assert!(direct_order < draft_created_order);
    assert!(orders.get::<_, Option<i64>>("applied_order").is_none());

    fixture.approve(draft.id).unwrap();
    let draft_applied_order: i64 = fixture
        .client
        .query_one(
            "select applied_order from change_set where id=$1",
            &[&draft.id],
        )
        .unwrap()
        .get(0);
    assert!(draft_created_order < draft_applied_order);
    let history = fixture
        .client
        .query(
            "select v.change_set_id,cs.applied_order,v.effective_end from employee_version v join employee_record r on r.id=v.record_id join change_set cs on cs.id=v.change_set_id where r.app_id=$1 and r.customer_id=$2 and r.external_key='alice' and v.stage='mainline' and v.effective_start=date '2026-05-01' order by cs.applied_order",
            &[&APP_ID, &CUSTOMER_ID],
        )
        .unwrap();
    assert_eq!(history.len(), 2);
    assert_eq!(history[0].get::<_, i64>("change_set_id"), direct.id);
    assert_eq!(
        history[0].get::<_, Option<NaiveDate>>("effective_end"),
        Some(date("2026-05-01"))
    );
    assert_eq!(history[1].get::<_, i64>("change_set_id"), draft.id);
    assert_eq!(
        history[1].get::<_, i64>("applied_order"),
        draft_applied_order
    );
    assert!(history[1]
        .get::<_, Option<NaiveDate>>("effective_end")
        .is_none());
    let visible = fixture.visible("employee", "2026-05-15");
    assert_eq!(
        visible[0].values.get(&FieldId::from("name")),
        Some(&FieldValue::Text("Alice Draft".to_string()))
    );
    assert_eq!(
        visible[0].values.get(&FieldId::from("comp_rate")),
        Some(&compensation(15000))
    );
}

#[test]
fn draft_approval_locks_inherited_relation_targets_before_allocating_order_match_generated_sql() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    fixture
        .apply(
            ApplyMode::Mainline,
            "draft-approval-relation-baseline",
            vec![
                write(
                    "company",
                    "acme",
                    "2026-04-01",
                    Some(text_values("Acme")),
                    false,
                ),
                write(
                    "company",
                    "beta",
                    "2026-04-01",
                    Some(text_values("Beta")),
                    false,
                ),
                write(
                    "employee",
                    "alice",
                    "2026-04-01",
                    Some(employee_values("Alice", None, Some("acme"))),
                    false,
                ),
            ],
        )
        .unwrap();
    let draft = fixture
        .apply(
            ApplyMode::Draft,
            "draft-approval-inherited-relation",
            vec![write(
                "employee",
                "alice",
                "2026-05-01",
                Some(text_values("Alice Draft")),
                false,
            )],
        )
        .unwrap();

    let schema_name = fixture.schema_name.clone();
    let waiting_schema_name = schema_name.clone();
    let mut blocker = begin_generated_sql_tenant_transaction(
        &mut fixture.client,
        &AppId::from(APP_ID),
        &CustomerId::from(CUSTOMER_ID),
    )
    .unwrap();
    blocker
        .query_one(
            "select id from company_record where app_id=$1 and customer_id=$2 and external_key='acme' for update",
            &[&APP_ID, &CUSTOMER_ID],
        )
        .unwrap();
    let (pid_sender, pid_receiver) = mpsc::channel();
    let approving = thread::spawn(move || {
        let mut client = connect_to_schema(&waiting_schema_name);
        let pid: i32 = client
            .query_one("select pg_backend_pid()", &[])
            .unwrap()
            .get(0);
        pid_sender.send(pid).unwrap();
        GeneratedSqlFunction::ApproveDraftChangeSet
            .call_top_level::<AppliedChangeSet>(&mut client, &draft_request(draft.id))
    });
    let waiting_pid = pid_receiver.recv().unwrap();
    wait_until_blocked(&mut blocker, waiting_pid, "draft approval");

    let beta = {
        let mut client = connect_to_schema(&schema_name);
        GeneratedSqlFunction::ApplyChangeSet
            .call_top_level::<AppliedChangeSet>(
                &mut client,
                &apply_request(
                    ApplyMode::Mainline,
                    "mainline-while-draft-approval-waits",
                    vec![write(
                        "company",
                        "beta",
                        "2026-05-01",
                        Some(text_values("Beta Updated")),
                        false,
                    )],
                ),
            )
            .unwrap()
    };
    blocker.commit().unwrap();
    approving.join().unwrap().unwrap();
    let rows = fixture
        .client
        .query(
            "select id,created_order,applied_order from change_set where id=any($1) order by applied_order",
            &[&vec![draft.id, beta.id]],
        )
        .unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].get::<_, i64>("id"), beta.id);
    assert_eq!(rows[1].get::<_, i64>("id"), draft.id);
    assert_ne!(
        rows[1].get::<_, i64>("created_order"),
        rows[1].get::<_, i64>("applied_order")
    );
}

#[test]
fn draft_apply_rejects_unapprovalable_same_day_and_tombstone_timelines_match_generated_sql() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    for (key, name) in [("acme", "Acme"), ("beta", "Beta"), ("gamma", "Gamma")] {
        fixture
            .apply(
                ApplyMode::Mainline,
                &format!("draft-timeline-baseline-{key}"),
                vec![write(
                    "company",
                    key,
                    "2026-04-01",
                    Some(text_values(name)),
                    false,
                )],
            )
            .unwrap();
    }
    let acme_id = fixture.record_id("company", "acme");
    let duplicate = fixture
        .apply(
            ApplyMode::Draft,
            "draft-duplicate-same-day",
            vec![
                write(
                    "company",
                    "acme",
                    "2026-05-01",
                    Some(text_values("Acme One")),
                    false,
                ),
                write(
                    "company",
                    "acme",
                    "2026-05-01",
                    Some(text_values("Acme Two")),
                    false,
                ),
            ],
        )
        .unwrap_err()
        .into_envelope();
    assert_eq!(
        duplicate,
        plain_error(
            "timeline_conflict",
            format!(
                "change set contains more than one ordinary value snapshot for record `{acme_id}` at 2026-05-01"
            ),
        )
    );

    let constrained = fixture
        .apply(
            ApplyMode::Draft,
            "draft-database-duplicate",
            vec![write(
                "company",
                "acme",
                "2026-05-01",
                Some(text_values("Database constrained")),
                false,
            )],
        )
        .unwrap();
    let database_duplicate = fixture
        .client
        .execute(
            "insert into company_version(id,record_id,app_id,customer_id,stage,effective_start,change_set_id,name) select $1,record_id,app_id,customer_id,stage,effective_start,change_set_id,'database duplicate' from company_version where change_set_id=$2",
            &[&Uuid::new_v4(), &constrained.id],
        )
        .unwrap_err();
    assert_eq!(database_duplicate.code(), Some(&SqlState::UNIQUE_VIOLATION));

    let beta_id = fixture.record_id("company", "beta");
    let tombstone = fixture
        .apply(
            ApplyMode::Draft,
            "draft-tombstone-before-later-value",
            vec![
                write("company", "beta", "2026-06-01", None, true),
                write(
                    "company",
                    "beta",
                    "2026-07-01",
                    Some(text_values("Beta Later")),
                    false,
                ),
            ],
        )
        .unwrap_err()
        .into_envelope();
    assert_eq!(
        tombstone,
        plain_error(
            "tombstoned_record",
            format!("record `{beta_id}` is tombstoned as of 2026-07-01"),
        )
    );

    let gamma_id = fixture.record_id("company", "gamma");
    let id_sequence = fixture
        .client
        .query_one("select last_value,is_called from change_set_id_seq", &[])
        .unwrap();
    let last_id: i64 = id_sequence.get(0);
    let next_change_set_id = if id_sequence.get::<_, bool>(1) {
        last_id + 1
    } else {
        last_id
    };
    let out_of_order = fixture
        .apply(
            ApplyMode::Draft,
            "draft-out-of-order",
            vec![
                write(
                    "company",
                    "gamma",
                    "2026-07-01",
                    Some(text_values("Gamma Later")),
                    false,
                ),
                write(
                    "company",
                    "gamma",
                    "2026-06-01",
                    Some(text_values("Gamma Earlier")),
                    false,
                ),
            ],
        )
        .unwrap_err()
        .into_envelope();
    assert_eq!(
        out_of_order,
        plain_error(
            "timeline_conflict",
            format!(
                "draft change_set `{next_change_set_id}` already has a later version for record `{gamma_id}` at 2026-07-01; submit same-record draft writes in effective_start order"
            ),
        )
    );
}

#[test]
fn dry_runs_use_local_orders_and_discard_does_not_create_causal_residue_match_generated_sql() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    fixture
        .apply(
            ApplyMode::Mainline,
            "dry-run-baseline",
            vec![write(
                "employee",
                "alice",
                "2026-05-01",
                Some(employee_values("Alice", Some("employee-a"), None)),
                false,
            )],
        )
        .unwrap();
    let sequence_before_dry = fixture.lifecycle_sequence();
    let dry_draft: AppliedChangeSet = fixture
        .call(
            GeneratedSqlFunction::ValidateChangeSetDryRun,
            &apply_request(
                ApplyMode::Draft,
                "dry-run-same-day-draft",
                vec![write(
                    "employee",
                    "alice",
                    "2026-05-01",
                    Some(text_values("Alice Draft")),
                    false,
                )],
            ),
        )
        .unwrap();
    assert!(dry_draft.id < 0);
    let dry_batch: Vec<AppliedChangeSet> = fixture
        .call(
            GeneratedSqlFunction::ValidateChangeSetsDryRun,
            &vec![
                apply_request(
                    ApplyMode::Mainline,
                    "dry-run-batch-create",
                    vec![write(
                        "employee",
                        "bob",
                        "2026-05-01",
                        Some(employee_values("Bob", Some("employee-b"), None)),
                        false,
                    )],
                ),
                apply_request(
                    ApplyMode::Mainline,
                    "dry-run-batch-same-day-update",
                    vec![write(
                        "employee",
                        "bob",
                        "2026-05-01",
                        Some(text_values("Bob Updated")),
                        false,
                    )],
                ),
            ],
        )
        .unwrap();
    assert_eq!(dry_batch.len(), 2);
    assert!(dry_batch.iter().all(|change_set| change_set.id < 0));
    assert_ne!(dry_batch[0].id, dry_batch[1].id);
    assert_eq!(fixture.lifecycle_sequence(), sequence_before_dry);
    let durable: (i64, i64, i64) = {
        let row = fixture
            .client
            .query_one(
                "select (select count(*) from change_set where app_id=$1 and customer_id=$2),(select count(*) from employee_record where app_id=$1 and customer_id=$2),(select count(*) from employee_version where app_id=$1 and customer_id=$2)",
                &[&APP_ID, &CUSTOMER_ID],
            )
            .unwrap();
        (row.get(0), row.get(1), row.get(2))
    };
    assert_eq!(durable, (1, 1, 1));

    let discarded_draft = fixture
        .apply(
            ApplyMode::Draft,
            "discard-without-causal-order",
            vec![write(
                "employee",
                "charlie",
                "2026-06-01",
                Some(employee_values("Charlie", Some("employee-c"), None)),
                false,
            )],
        )
        .unwrap();
    let sequence_before_discard = fixture.lifecycle_sequence();
    fixture.discard(discarded_draft.id).unwrap();
    assert_eq!(fixture.lifecycle_sequence(), sequence_before_discard);
    let discarded = fixture
        .client
        .query_one(
            "select status,applied_order from change_set where id=$1",
            &[&discarded_draft.id],
        )
        .unwrap();
    assert_eq!(discarded.get::<_, String>("status"), "discarded");
    assert!(discarded.get::<_, Option<i64>>("applied_order").is_none());
    let charlie_residue: i64 = fixture
        .client
        .query_one(
            "select (select count(*) from employee_record where app_id=$1 and customer_id=$2 and external_key='charlie')+(select count(*) from employee_version where app_id=$1 and customer_id=$2 and change_set_id=$3 and stage='mainline')",
            &[&APP_ID, &CUSTOMER_ID, &discarded_draft.id],
        )
        .unwrap()
        .get(0);
    assert_eq!(charlie_residue, 0);
    let discarded_versions: i64 = fixture
        .client
        .query_one(
            "select count(*) from employee_version where change_set_id=$1 and stage='discarded' and applied_at is null",
            &[&discarded_draft.id],
        )
        .unwrap()
        .get(0);
    assert_eq!(discarded_versions, 1);
}

#[test]
fn draft_approval_rejects_if_an_older_draft_was_approved_after_this_draft_was_created_match_generated_sql(
) {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    fixture
        .apply(
            ApplyMode::Mainline,
            "company-before-two-drafts",
            vec![write(
                "company",
                "acme",
                "2026-05-01",
                Some(text_values("Acme")),
                false,
            )],
        )
        .unwrap();
    let older_draft = fixture
        .apply(
            ApplyMode::Draft,
            "company-older-draft",
            vec![write(
                "company",
                "acme",
                "2026-06-01",
                Some(text_values("Acme Older Draft")),
                false,
            )],
        )
        .unwrap();
    let newer_draft = fixture
        .apply(
            ApplyMode::Draft,
            "company-newer-draft",
            vec![write(
                "company",
                "acme",
                "2026-07-01",
                Some(text_values("Acme Newer Draft")),
                false,
            )],
        )
        .unwrap();
    fixture.approve(older_draft.id).unwrap();
    let record_id = fixture.record_id("company", "acme");
    assert_eq!(
        fixture.approve(newer_draft.id).unwrap_err().into_envelope(),
        plain_error(
            "stale_draft",
            format!(
                "company:{record_id} updated by change_set `{}`",
                older_draft.id
            ),
        )
    );
}

#[test]
fn draft_approval_rejects_unique_field_conflicts_match_generated_sql() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    fixture
        .apply(
            ApplyMode::Mainline,
            "draft-unique-mainline",
            vec![write(
                "employee",
                "employee_a",
                "2026-01-01",
                Some(employee_values("Alice", Some("EMP-1"), None)),
                false,
            )],
        )
        .unwrap();
    let draft = fixture
        .apply(
            ApplyMode::Draft,
            "draft-unique-duplicate",
            vec![write(
                "employee",
                "employee_b",
                "2026-01-01",
                Some(employee_values("Bob", Some("EMP-1"), None)),
                false,
            )],
        )
        .unwrap();
    let sequence_before = fixture.lifecycle_sequence();
    assert_eq!(
        fixture.approve(draft.id).unwrap_err().into_envelope(),
        unique_error("EMP-1")
    );
    assert_eq!(fixture.lifecycle_sequence(), sequence_before);
}

#[test]
fn draft_approval_validates_internal_live_unique_conflicts_before_ordering_match_generated_sql() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    let draft = fixture
        .apply(
            ApplyMode::Draft,
            "draft-internal-unique-conflict",
            vec![
                write(
                    "employee",
                    "employee_a",
                    "2026-01-01",
                    Some(employee_values("Alice", Some("EMP-1"), None)),
                    false,
                ),
                write(
                    "employee",
                    "employee_b",
                    "2026-01-01",
                    Some(employee_values("Bob", Some("EMP-1"), None)),
                    false,
                ),
            ],
        )
        .unwrap();
    let sequence_before = fixture.lifecycle_sequence();
    assert_eq!(
        fixture.approve(draft.id).unwrap_err().into_envelope(),
        unique_error("EMP-1")
    );
    assert_eq!(fixture.lifecycle_sequence(), sequence_before);
    let state = fixture
        .client
        .query_one(
            "select status,applied_order from change_set where id=$1",
            &[&draft.id],
        )
        .unwrap();
    assert_eq!(state.get::<_, String>("status"), "draft");
    assert!(state.get::<_, Option<i64>>("applied_order").is_none());
}
