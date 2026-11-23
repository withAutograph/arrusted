use std::collections::BTreeMap;
use std::env;
use support::trusted_human;

use chrono::NaiveDate;
use kernel::testing::{call_generated_sql, GeneratedSqlFunction};
use kernel::{
    connect_postgres, AppId, AppliedChangeSet, ApplyChangeSet, ApplyMode, ChangeType, ChangeTypeId,
    CustomerId, DraftRecord, DraftSummary, ErrorEnvelope, ExternalKey, Field, FieldId, FieldType,
    FieldValue, Model, ModelId, ModelKind, MoneyRatePeriod, MoneyRateValue, RecordKey,
    RowVersionWrite, Schema, SchemaVersion, VisibleRecord,
};
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

const APP_ID: &str = "draft_parity_app";
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
        let schema_name = format!("kernel_draft_parity_{}", Uuid::new_v4().simple());
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
    ) -> Result<T, kernel::KernelError> {
        call_generated_sql(&mut self.client, function, request)
    }

    fn apply(&mut self, request: &ApplyChangeSet) -> Result<AppliedChangeSet, kernel::KernelError> {
        self.call(GeneratedSqlFunction::ApplyChangeSet, request)
    }

    fn visible(&mut self, model: &str, as_of: &str) -> Vec<VisibleRecord> {
        self.call(
            GeneratedSqlFunction::ReadVisibleRecords,
            &json!({
                "app_id": APP_ID,
                "customer_id": CUSTOMER_ID,
                "model_id": model,
                "as_of": as_of,
            }),
        )
        .expect("read visible generated SQL records")
    }

    fn draft(&mut self, change_set_id: i64) -> Result<Vec<DraftRecord>, kernel::KernelError> {
        self.call(
            GeneratedSqlFunction::ReadDraftChangeSet,
            &draft_request(change_set_id),
        )
    }

    fn approve(&mut self, change_set_id: i64) -> Result<AppliedChangeSet, kernel::KernelError> {
        self.call(
            GeneratedSqlFunction::ApproveDraftChangeSet,
            &draft_request(change_set_id),
        )
    }

    fn discard(&mut self, change_set_id: i64) -> Result<AppliedChangeSet, kernel::KernelError> {
        self.call(
            GeneratedSqlFunction::DiscardDraftChangeSet,
            &draft_request(change_set_id),
        )
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        support::drop_generated_sql_fixture(&mut self.client, &self.schema_name);
    }
}

fn compiled_schema() -> CompiledManifest {
    let field = |id: &str, field_type: FieldType, required: bool| Field {
        id: FieldId::from(id),
        label: id.to_string(),
        field_type,
        required,
        is_unique: false,
        target_model: None,
        option_set: vec![],
        ..Default::default()
    };
    let mut employer = field("employer", FieldType::Relation, false);
    employer.target_model = Some(ModelId::from("company"));
    CompiledManifest {
        schema: Schema {
            app_id: AppId::from(APP_ID),
            customer_id: CustomerId::from(CUSTOMER_ID),
            version: SchemaVersion::from("2026-08-04.draft-parity"),
            models: vec![
                Model {
                    id: ModelId::from("company"),
                    kind: ModelKind::Entity,
                    label: "Company".to_string(),
                    fields: vec![field("name", FieldType::Text, true)],
                    ..Default::default()
                },
                Model {
                    id: ModelId::from("employee"),
                    kind: ModelKind::Entity,
                    label: "Employee".to_string(),
                    fields: vec![
                        field("name", FieldType::Text, true),
                        employer,
                        field("comp_rate", FieldType::MoneyRate, false),
                    ],
                    ..Default::default()
                },
            ],
            custom_fields: vec![],
            change_types: vec![ChangeType {
                id: ChangeTypeId::from("employee_update"),
                label: "Employee Update".to_string(),
                target_model: ModelId::from("employee"),
                is_import_default: false,
                touches: vec![FieldId::from("name")],
                required: vec![FieldId::from("name")],
            }],
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

fn date(value: &str) -> NaiveDate {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").expect("valid test date")
}

fn draft_request(change_set_id: i64) -> serde_json::Value {
    json!({
        "app_id": APP_ID,
        "customer_id": CUSTOMER_ID,
        "change_set_id": change_set_id,
            "actor_id": "tester",
    })
}

fn text_values(name: &str) -> BTreeMap<FieldId, FieldValue> {
    BTreeMap::from([(FieldId::from("name"), FieldValue::Text(name.to_string()))])
}

fn employee_values(name: &str, employer: RecordKey) -> BTreeMap<FieldId, FieldValue> {
    BTreeMap::from([
        (FieldId::from("name"), FieldValue::Text(name.to_string())),
        (FieldId::from("employer"), FieldValue::Relation(employer)),
        (
            FieldId::from("comp_rate"),
            FieldValue::MoneyRate(MoneyRateValue {
                amount: Decimal::new(12500, 2),
                currency: "USD".to_string(),
                period: MoneyRatePeriod::Hourly,
            }),
        ),
    ])
}

fn write(
    model: &str,
    external_key: &str,
    effective_start: &str,
    values: Option<BTreeMap<FieldId, FieldValue>>,
    tombstones_record: bool,
) -> RowVersionWrite {
    RowVersionWrite {
        model_id: ModelId::from(model),
        record_key: Some(RecordKey::ExternalKey(ExternalKey::from(external_key))),
        new_record_id: None,
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

fn assert_error(error: kernel::KernelError, code: &str, message: &str) {
    assert_eq!(
        error.into_envelope(),
        ErrorEnvelope {
            code: code.to_string(),
            message: message.to_string(),
            details: vec![],
        }
    );
}

#[test]
fn draft_apply_isolated_from_mainline_reads_and_explicitly_readable_via_generated_sql() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    let draft = fixture
        .apply(&apply_request(
            ApplyMode::Draft,
            "draft-company-acme",
            vec![write(
                "company",
                "acme",
                "2026-05-01",
                Some(text_values("Acme Draft")),
                false,
            )],
        ))
        .unwrap();

    assert!(fixture.visible("company", "2026-05-15").is_empty());
    let records = fixture.draft(draft.id).unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].external_key.as_deref(), Some("acme"));
    assert_eq!(
        records[0].values.get(&FieldId::from("name")),
        Some(&FieldValue::Text("Acme Draft".to_string()))
    );
    let row = fixture
        .client
        .query_one(
            "select status, applied_at from change_set where id=$1",
            &[&draft.id],
        )
        .unwrap();
    assert_eq!(row.get::<_, String>("status"), "draft");
    assert!(row
        .get::<_, Option<chrono::DateTime<chrono::Utc>>>("applied_at")
        .is_none());
}

#[test]
fn draft_approval_flips_to_mainline_and_normalizes_timeline_via_generated_sql() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    fixture
        .apply(&apply_request(
            ApplyMode::Mainline,
            "company-mainline-before-draft",
            vec![write(
                "company",
                "acme",
                "2026-05-01",
                Some(text_values("Acme")),
                false,
            )],
        ))
        .unwrap();
    let draft = fixture
        .apply(&apply_request(
            ApplyMode::Draft,
            "company-draft-approve",
            vec![write(
                "company",
                "acme",
                "2026-06-01",
                Some(text_values("Acme Approved")),
                false,
            )],
        ))
        .unwrap();

    assert_eq!(
        fixture.visible("company", "2026-06-15")[0]
            .values
            .get(&FieldId::from("name")),
        Some(&FieldValue::Text("Acme".to_string()))
    );
    let approved = fixture.approve(draft.id).unwrap();
    assert_eq!(approved.id, draft.id);
    assert_eq!(fixture.approve(draft.id).unwrap(), approved);
    assert_eq!(
        fixture.visible("company", "2026-06-15")[0]
            .values
            .get(&FieldId::from("name")),
        Some(&FieldValue::Text("Acme Approved".to_string()))
    );
    let prior_end: Option<NaiveDate> = fixture
        .client
        .query_one(
            "select effective_end from company_version where effective_start='2026-05-01' and stage='mainline'",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(prior_end, Some(date("2026-05-31")));
}

#[test]
fn draft_rows_compose_with_prior_rows_in_the_same_draft_via_generated_sql() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    fixture
        .apply(&apply_request(
            ApplyMode::Mainline,
            "draft-compose-company",
            vec![write(
                "company",
                "acme",
                "2026-05-01",
                Some(text_values("Acme")),
                false,
            )],
        ))
        .unwrap();
    fixture
        .apply(&apply_request(
            ApplyMode::Mainline,
            "draft-compose-employee",
            vec![write(
                "employee",
                "alice",
                "2026-05-01",
                Some(employee_values(
                    "Alice",
                    RecordKey::ExternalKey(ExternalKey::from("acme")),
                )),
                false,
            )],
        ))
        .unwrap();
    let rate = FieldValue::MoneyRate(MoneyRateValue {
        amount: Decimal::new(15000, 2),
        currency: "USD".to_string(),
        period: MoneyRatePeriod::Hourly,
    });
    let draft = fixture
        .apply(&apply_request(
            ApplyMode::Draft,
            "draft-compose-two-rows",
            vec![
                write(
                    "employee",
                    "alice",
                    "2026-06-01",
                    Some(BTreeMap::from([(FieldId::from("comp_rate"), rate.clone())])),
                    false,
                ),
                write(
                    "employee",
                    "alice",
                    "2026-07-01",
                    Some(BTreeMap::from([(
                        FieldId::from("name"),
                        FieldValue::Text("Alice July".to_string()),
                    )])),
                    false,
                ),
            ],
        ))
        .unwrap();

    let records = fixture.draft(draft.id).unwrap();
    let july = records
        .iter()
        .find(|record| record.effective_start == date("2026-07-01"))
        .unwrap();
    assert_eq!(july.values.get(&FieldId::from("comp_rate")), Some(&rate));
    assert_eq!(
        fixture.visible("employee", "2026-07-15")[0]
            .values
            .get(&FieldId::from("comp_rate")),
        Some(&FieldValue::MoneyRate(MoneyRateValue {
            amount: Decimal::new(12500, 2),
            currency: "USD".to_string(),
            period: MoneyRatePeriod::Hourly,
        }))
    );
    fixture.approve(draft.id).unwrap();
    let visible = fixture.visible("employee", "2026-07-15");
    assert_eq!(
        visible[0].values.get(&FieldId::from("name")),
        Some(&FieldValue::Text("Alice July".to_string()))
    );
    assert_eq!(
        visible[0].values.get(&FieldId::from("comp_rate")),
        Some(&rate)
    );
}

#[test]
fn draft_relation_writes_can_target_records_created_in_the_same_draft_via_generated_sql() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    let draft = fixture
        .apply(&apply_request(
            ApplyMode::Draft,
            "draft-related-new-records",
            vec![
                write(
                    "company",
                    "acme",
                    "2026-05-01",
                    Some(text_values("Acme")),
                    false,
                ),
                write(
                    "employee",
                    "alice",
                    "2026-05-01",
                    Some(employee_values(
                        "Alice",
                        RecordKey::ExternalKey(ExternalKey::from("acme")),
                    )),
                    false,
                ),
            ],
        ))
        .unwrap();
    let records = fixture.draft(draft.id).unwrap();
    let company = records
        .iter()
        .find(|record| record.model_id == ModelId::from("company"))
        .unwrap();
    let employee = records
        .iter()
        .find(|record| record.model_id == ModelId::from("employee"))
        .unwrap();
    let relation = FieldValue::Relation(RecordKey::RecordId(company.record_id));
    assert_eq!(
        employee.values.get(&FieldId::from("employer")),
        Some(&relation)
    );
    assert!(fixture.visible("employee", "2026-05-15").is_empty());
    fixture.approve(draft.id).unwrap();
    assert_eq!(
        fixture.visible("employee", "2026-05-15")[0]
            .values
            .get(&FieldId::from("employer")),
        Some(&relation)
    );
}

#[test]
fn draft_relation_writes_respect_same_draft_target_tombstones_via_generated_sql() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    fixture
        .apply(&apply_request(
            ApplyMode::Mainline,
            "mainline-company-for-draft-relation-tombstone",
            vec![write(
                "company",
                "acme",
                "2026-05-01",
                Some(text_values("Acme")),
                false,
            )],
        ))
        .unwrap();
    let error = fixture
        .apply(&apply_request(
            ApplyMode::Draft,
            "draft-relation-respects-target-tombstone",
            vec![
                write("company", "acme", "2026-05-01", None, true),
                write(
                    "employee",
                    "alice",
                    "2026-05-01",
                    Some(employee_values(
                        "Alice",
                        RecordKey::ExternalKey(ExternalKey::from("acme")),
                    )),
                    false,
                ),
            ],
        ))
        .unwrap_err();
    let envelope = error.into_envelope();
    assert_eq!(envelope.code, "tombstoned_record");
    assert!(envelope.message.starts_with("record `"), "{envelope:?}");
    assert!(
        envelope
            .message
            .ends_with("` is tombstoned as of 2026-05-01"),
        "{envelope:?}"
    );
    assert!(envelope.details.is_empty());
}

#[test]
fn draft_discard_hides_draft_and_is_idempotent_via_generated_sql() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    let draft = fixture
        .apply(&apply_request(
            ApplyMode::Draft,
            "company-draft-discard",
            vec![write(
                "company",
                "acme",
                "2026-05-01",
                Some(text_values("Acme Draft")),
                false,
            )],
        ))
        .unwrap();
    let discarded = fixture.discard(draft.id).unwrap();
    assert_eq!(fixture.discard(draft.id).unwrap(), discarded);
    assert_error(
        fixture.draft(draft.id).unwrap_err(),
        "draft_status_conflict",
        &format!(
            "change_set `{}` has status `discarded`, not `draft`",
            draft.id
        ),
    );
    assert!(fixture.visible("company", "2026-05-15").is_empty());
    let external_key_rows: i64 = fixture
        .client
        .query_one(
            "select count(*) from company_record where app_id=$1 and customer_id=$2 and external_key='acme'",
            &[&APP_ID, &CUSTOMER_ID],
        )
        .unwrap()
        .get(0);
    assert_eq!(external_key_rows, 0);
    fixture
        .apply(&apply_request(
            ApplyMode::Mainline,
            "draft-orphan-key-reuse",
            vec![write(
                "company",
                "acme",
                "2026-06-01",
                Some(text_values("Acme Fresh")),
                false,
            )],
        ))
        .unwrap();
}

#[test]
fn draft_discard_releases_external_key_on_orphan_records_via_generated_sql() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    let draft = fixture
        .apply(&apply_request(
            ApplyMode::Draft,
            "company-reserve-record",
            vec![write(
                "company",
                "acme",
                "2026-05-01",
                Some(text_values("Acme Draft")),
                false,
            )],
        ))
        .unwrap();
    let first_record_id: Uuid = fixture
        .client
        .query_one(
            "select id from company_record where external_key='acme'",
            &[],
        )
        .unwrap()
        .get(0);
    fixture.discard(draft.id).unwrap();
    assert!(fixture.visible("company", "2026-05-15").is_empty());
    let released_external_key: Option<String> = fixture
        .client
        .query_one(
            "select external_key from company_record where id=$1",
            &[&first_record_id],
        )
        .unwrap()
        .get(0);
    assert!(released_external_key.is_none());

    let second_draft = fixture
        .apply(&apply_request(
            ApplyMode::Draft,
            "company-second-draft-after-discard",
            vec![write(
                "company",
                "acme",
                "2026-05-01",
                Some(text_values("Acme Mainline")),
                false,
            )],
        ))
        .unwrap();
    assert_ne!(second_draft.id, draft.id);
}

#[test]
fn draft_discard_preserves_external_key_when_record_was_already_mainlined_via_generated_sql() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    fixture
        .apply(&apply_request(
            ApplyMode::Mainline,
            "company-mainlined-before-draft-discard",
            vec![write(
                "company",
                "acme",
                "2026-05-01",
                Some(text_values("Acme Mainline")),
                false,
            )],
        ))
        .unwrap();
    let draft = fixture
        .apply(&apply_request(
            ApplyMode::Draft,
            "company-mainlined-draft-discard",
            vec![write(
                "company",
                "acme",
                "2026-06-01",
                Some(text_values("Acme Draft")),
                false,
            )],
        ))
        .unwrap();
    fixture.discard(draft.id).unwrap();
    let external_key: Option<String> = fixture
        .client
        .query_one(
            "select external_key from company_record where external_key='acme'",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(external_key.as_deref(), Some("acme"));
    assert_eq!(fixture.visible("company", "2026-05-15").len(), 1);
}

#[test]
fn draft_approval_rejects_if_mainline_changed_after_draft_creation_via_generated_sql() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    fixture
        .apply(&apply_request(
            ApplyMode::Mainline,
            "company-before-stale-draft",
            vec![write(
                "company",
                "acme",
                "2026-05-01",
                Some(text_values("Acme")),
                false,
            )],
        ))
        .unwrap();
    let draft = fixture
        .apply(&apply_request(
            ApplyMode::Draft,
            "company-stale-draft",
            vec![write(
                "company",
                "acme",
                "2026-06-01",
                Some(text_values("Acme Draft")),
                false,
            )],
        ))
        .unwrap();
    let later = fixture
        .apply(&apply_request(
            ApplyMode::Mainline,
            "company-after-stale-draft",
            vec![write(
                "company",
                "acme",
                "2026-06-01",
                Some(text_values("Acme Same-Day Mainline")),
                false,
            )],
        ))
        .unwrap();
    let before: (i64, bool) = {
        let row = fixture
            .client
            .query_one(
                "select last_value,is_called from change_set_lifecycle_order_seq",
                &[],
            )
            .unwrap();
        (row.get(0), row.get(1))
    };
    assert_error(
        fixture.approve(draft.id).unwrap_err(),
        "stale_draft",
        &format!(
            "company:{} updated by change_set `{}`",
            fixture
                .client
                .query_one(
                    "select id from company_record where external_key='acme'",
                    &[]
                )
                .unwrap()
                .get::<_, Uuid>(0),
            later.id
        ),
    );
    let after: (i64, bool) = {
        let row = fixture
            .client
            .query_one(
                "select last_value,is_called from change_set_lifecycle_order_seq",
                &[],
            )
            .unwrap();
        (row.get(0), row.get(1))
    };
    assert_eq!(after, before);
    let state = fixture
        .client
        .query_one(
            "select status,applied_order from change_set where id=$1",
            &[&draft.id],
        )
        .unwrap();
    assert_eq!(state.get::<_, String>(0), "draft");
    assert!(state.get::<_, Option<i64>>(1).is_none());
}

#[test]
fn approving_an_ordinary_mainline_change_set_is_not_treated_as_idempotent_draft_approval_via_generated_sql(
) {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    let applied = fixture
        .apply(&apply_request(
            ApplyMode::Mainline,
            "company-mainline-not-draft",
            vec![write(
                "company",
                "acme",
                "2026-05-01",
                Some(text_values("Acme")),
                false,
            )],
        ))
        .unwrap();
    assert_error(
        fixture.approve(applied.id).unwrap_err(),
        "draft_status_conflict",
        &format!(
            "cannot approve change_set `{}` with status `mainline`",
            applied.id
        ),
    );
}

#[test]
fn draft_notes_update_only_while_draft_and_drafts_are_listed_via_generated_sql() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    let draft = fixture
        .apply(&apply_request(
            ApplyMode::Draft,
            "company-draft-notes",
            vec![write(
                "company",
                "acme",
                "2026-05-01",
                Some(text_values("Acme Draft")),
                false,
            )],
        ))
        .unwrap();
    let _: serde_json::Value = fixture
        .call(
            GeneratedSqlFunction::UpdateDraftNotes,
            &json!({
                "app_id": APP_ID,
                "customer_id": CUSTOMER_ID,
                "change_set_id": draft.id,
                "notes": "ready for approval",
            }),
        )
        .unwrap();
    let drafts: Vec<DraftSummary> = fixture
        .call(
            GeneratedSqlFunction::ListDraftChangeSets,
            &json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID}),
        )
        .unwrap();
    assert_eq!(drafts.len(), 1);
    assert_eq!(drafts[0].notes.as_deref(), Some("ready for approval"));
    fixture.approve(draft.id).unwrap();
    assert_error(
        fixture
            .call::<serde_json::Value>(
                GeneratedSqlFunction::UpdateDraftNotes,
                &json!({
                    "app_id": APP_ID,
                    "customer_id": CUSTOMER_ID,
                    "change_set_id": draft.id,
                    "notes": "too late",
                }),
            )
            .unwrap_err(),
        "draft_status_conflict",
        &format!(
            "cannot update notes for change_set `{}` with status `mainline`",
            draft.id
        ),
    );
}
