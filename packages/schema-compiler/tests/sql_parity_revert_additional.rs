use std::collections::{BTreeMap, BTreeSet};
use std::env;
use support::trusted_human;

use chrono::NaiveDate;
use kernel::testing::{call_generated_sql, GeneratedSqlFunction};
use kernel::{
    connect_postgres, AppId, AppliedChangeSet, ApplyChangeSet, ApplyMode, ChangeSetDiff,
    ChangeSetDiffRequest, CustomerId, ErrorEnvelope, ExternalKey, Field, FieldId, FieldType,
    FieldValue, KernelError, Model, ModelId, ModelKind, RecordKey, RevertChangeSet,
    RowVersionWrite, Schema, SchemaVersion, VisibleRecord,
};
use postgres::Client;
use schema_compiler::{
    compile_sql_artifact_manifest, render_sql_artifact_bundle, CompiledManifest,
    NormalizedManifestExtras,
};
use serde::Serialize;
use serde_json::json;
use uuid::Uuid;

mod support;

const APP_ID: &str = "revert_parity_app";
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
                eprintln!("skipping generated revert parity: KERNEL_TEST_DATABASE_URL is absent");
                return None;
            }
            Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
        };
        let compiled = compiled_schema();
        let manifest = compile_sql_artifact_manifest(&compiled).expect("compile SQL artifacts");
        let bundle = render_sql_artifact_bundle(&manifest);
        let mut client = connect_postgres(&database_url).expect("connect to PostgreSQL");
        let schema_name = format!("kernel_revert_parity_{}", Uuid::new_v4().simple());
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
        call_generated_sql(&mut self.client, function, request)
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

    fn revert(&mut self, change_set_id: i64, key: &str) -> Result<AppliedChangeSet, KernelError> {
        self.call(
            GeneratedSqlFunction::RevertChangeSet,
            &revert_request(change_set_id, key),
        )
    }

    fn approve(&mut self, change_set_id: i64) -> Result<AppliedChangeSet, KernelError> {
        self.call(
            GeneratedSqlFunction::ApproveDraftChangeSet,
            &json!({
                "app_id": APP_ID,
                "customer_id": CUSTOMER_ID,
                "change_set_id": change_set_id,
            "actor_id": "tester",
            }),
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

    fn diff(&mut self, change_set_id: i64) -> ChangeSetDiff {
        self.call(
            GeneratedSqlFunction::ChangeSetDiff,
            &ChangeSetDiffRequest {
                app_id: AppId::from(APP_ID),
                customer_id: CustomerId::from(CUSTOMER_ID),
                change_set_id,
                project: vec![],
            },
        )
        .expect("read generated SQL change-set diff")
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
            version: SchemaVersion::from("2026-08-04.revert-parity"),
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

fn date(value: &str) -> NaiveDate {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").expect("valid date")
}

fn values(entries: &[(&str, FieldValue)]) -> BTreeMap<FieldId, FieldValue> {
    entries
        .iter()
        .map(|(id, value)| (FieldId::from(*id), value.clone()))
        .collect()
}

fn text_values(name: &str) -> BTreeMap<FieldId, FieldValue> {
    values(&[("name", FieldValue::Text(name.to_string()))])
}

fn employee_values(
    name: &str,
    reference: Option<&str>,
    employer: Option<&str>,
) -> BTreeMap<FieldId, FieldValue> {
    let mut result = text_values(name);
    if let Some(reference) = reference {
        result.insert(
            FieldId::from("ref"),
            FieldValue::Text(reference.to_string()),
        );
    }
    if let Some(employer) = employer {
        result.insert(
            FieldId::from("employer"),
            FieldValue::Relation(RecordKey::ExternalKey(ExternalKey::from(employer))),
        );
    }
    result
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

fn revert_request(change_set_id: i64, key: &str) -> RevertChangeSet {
    RevertChangeSet {
        app_id: AppId::from(APP_ID),
        customer_id: CustomerId::from(CUSTOMER_ID),
        change_set_id,
        actor_id: Some("tester".to_string()),
        idempotency_key: Some(key.to_string()),
        notes: None,
    }
}

fn error_envelope(error: KernelError) -> ErrorEnvelope {
    error.into_envelope()
}

fn plain_error(code: &str, message: String) -> ErrorEnvelope {
    ErrorEnvelope {
        code: code.to_string(),
        message,
        details: vec![],
    }
}

#[test]
fn revert_mainline_update_marks_target_rows_and_restores_previous_snapshot_match_generated_sql() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    let original = fixture
        .apply(
            ApplyMode::Mainline,
            "revert-update-original",
            vec![write(
                "company",
                "acme",
                "2026-05-01",
                Some(text_values("Acme")),
                false,
            )],
        )
        .unwrap();
    let target = fixture
        .apply(
            ApplyMode::Mainline,
            "revert-update-target",
            vec![write(
                "company",
                "acme",
                "2026-06-01",
                Some(text_values("Acme Updated")),
                false,
            )],
        )
        .unwrap();

    let revert = fixture
        .revert(target.id, "revert-update-target-key")
        .unwrap();
    assert_ne!(revert.id, target.id);
    assert_eq!(
        fixture.visible("company", "2026-06-15")[0]
            .values
            .get(&FieldId::from("name")),
        Some(&FieldValue::Text("Acme".to_string()))
    );

    let target_change_set = fixture
        .client
        .query_one(
            "select status, applied_at is not null as applied from change_set where id=$1",
            &[&target.id],
        )
        .unwrap();
    assert_eq!(target_change_set.get::<_, String>("status"), "mainline");
    assert!(target_change_set.get::<_, bool>("applied"));
    let revert_change_set = fixture
        .client
        .query_one(
            "select status,source_kind,source_ref from change_set where id=$1",
            &[&revert.id],
        )
        .unwrap();
    assert_eq!(revert_change_set.get::<_, String>("status"), "mainline");
    assert_eq!(revert_change_set.get::<_, String>("source_kind"), "revert");
    assert_eq!(
        revert_change_set.get::<_, Option<String>>("source_ref"),
        Some(target.id.to_string())
    );
    let target_row = fixture
        .client
        .query_one(
            "select stage,applied_at is not null as applied from company_version where change_set_id=$1",
            &[&target.id],
        )
        .unwrap();
    assert_eq!(target_row.get::<_, String>("stage"), "reverted");
    assert!(!target_row.get::<_, bool>("applied"));
    let revert_version_count: i64 = fixture
        .client
        .query_one(
            "select count(*) from company_version where change_set_id=$1",
            &[&revert.id],
        )
        .unwrap()
        .get(0);
    assert_eq!(revert_version_count, 0);
    let mainline_change_sets: i64 = fixture
        .client
        .query_one(
            "select count(*) from change_set where status='mainline' and id in ($1,$2,$3)",
            &[&original.id, &target.id, &revert.id],
        )
        .unwrap()
        .get(0);
    assert_eq!(mainline_change_sets, 3);
}

#[test]
fn revert_multi_date_multi_record_target_normalizes_as_one_group_match_generated_sql() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    for (key, name) in [("acme", "Acme Base"), ("zenith", "Zenith Base")] {
        fixture
            .apply(
                ApplyMode::Mainline,
                &format!("revert-multi-base-{key}"),
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
    let target = fixture
        .apply(
            ApplyMode::Mainline,
            "revert-multi-target",
            vec![
                write(
                    "company",
                    "zenith",
                    "2026-05-01",
                    Some(text_values("Zenith May")),
                    false,
                ),
                write(
                    "company",
                    "acme",
                    "2026-06-01",
                    Some(text_values("Acme June")),
                    false,
                ),
                write(
                    "company",
                    "acme",
                    "2026-05-01",
                    Some(text_values("Acme May")),
                    false,
                ),
            ],
        )
        .unwrap();
    fixture
        .revert(target.id, "revert-multi-target-key")
        .unwrap();

    let visible = fixture.visible("company", "2026-07-01");
    let names = visible
        .iter()
        .map(|record| match &record.values[&FieldId::from("name")] {
            FieldValue::Text(name) => name.clone(),
            value => panic!("expected text name, got {value:?}"),
        })
        .collect::<BTreeSet<_>>();
    assert_eq!(
        names,
        BTreeSet::from(["Acme Base".to_string(), "Zenith Base".to_string()])
    );
    assert!(visible.iter().all(|record| record.effective_end.is_none()));
    let target_rows = fixture
        .client
        .query(
            "select stage from company_version where change_set_id=$1 order by effective_start,record_id",
            &[&target.id],
        )
        .unwrap();
    assert_eq!(target_rows.len(), 3);
    assert!(target_rows
        .iter()
        .all(|row| row.get::<_, String>("stage") == "reverted"));
}

#[test]
fn revert_relation_validation_rolls_back_the_complete_group_match_generated_sql() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    for key in ["acme", "zenith"] {
        fixture
            .apply(
                ApplyMode::Mainline,
                &format!("revert-invalid-company-{key}"),
                vec![write(
                    "company",
                    key,
                    "2026-05-01",
                    Some(text_values(key)),
                    false,
                )],
            )
            .unwrap();
    }
    let acme_id: Uuid = fixture
        .client
        .query_one(
            "select id from company_record where app_id=$1 and customer_id=$2 and external_key='acme'",
            &[&APP_ID, &CUSTOMER_ID],
        )
        .unwrap()
        .get(0);
    let zenith_id: Uuid = fixture
        .client
        .query_one(
            "select id from company_record where app_id=$1 and customer_id=$2 and external_key='zenith'",
            &[&APP_ID, &CUSTOMER_ID],
        )
        .unwrap()
        .get(0);
    fixture
        .apply(
            ApplyMode::Mainline,
            "revert-invalid-employee-acme",
            vec![write(
                "employee",
                "alice",
                "2026-05-01",
                Some(employee_values("Alice", None, Some("acme"))),
                false,
            )],
        )
        .unwrap();
    let target = fixture
        .apply(
            ApplyMode::Mainline,
            "revert-invalid-employee-zenith",
            vec![write(
                "employee",
                "alice",
                "2026-05-01",
                Some(employee_values("Alice", None, Some("zenith"))),
                false,
            )],
        )
        .unwrap();
    fixture
        .apply(
            ApplyMode::Mainline,
            "revert-invalid-tombstone-acme",
            vec![write("company", "acme", "2026-05-01", None, true)],
        )
        .unwrap();

    let error = error_envelope(
        fixture
            .revert(target.id, "revert-invalid-relation-target")
            .unwrap_err(),
    );
    assert_eq!(
        error,
        plain_error(
            "tombstoned_record",
            format!("record `{acme_id}` is tombstoned as of 2026-05-01"),
        )
    );
    assert_eq!(
        fixture.visible("employee", "2026-05-15")[0]
            .values
            .get(&FieldId::from("employer")),
        Some(&FieldValue::Relation(RecordKey::RecordId(zenith_id)))
    );
    let target_stage: String = fixture
        .client
        .query_one(
            "select stage from employee_version where change_set_id=$1",
            &[&target.id],
        )
        .unwrap()
        .get(0);
    assert_eq!(target_stage, "mainline");
    let failed_audit_count: i64 = fixture
        .client
        .query_one(
            "select count(*) from change_set where app_id=$1 and customer_id=$2 and idempotency_key='revert-invalid-relation-target'",
            &[&APP_ID, &CUSTOMER_ID],
        )
        .unwrap()
        .get(0);
    assert_eq!(failed_audit_count, 0);
}

#[test]
fn revert_tombstone_reopens_previous_mainline_row_match_generated_sql() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    fixture
        .apply(
            ApplyMode::Mainline,
            "revert-tombstone-original",
            vec![write(
                "company",
                "acme",
                "2026-05-01",
                Some(text_values("Acme")),
                false,
            )],
        )
        .unwrap();
    let tombstone = fixture
        .apply(
            ApplyMode::Mainline,
            "revert-tombstone-target",
            vec![write("company", "acme", "2026-06-01", None, true)],
        )
        .unwrap();
    assert!(fixture.visible("company", "2026-06-15").is_empty());
    let revert = fixture
        .revert(tombstone.id, "revert-tombstone-key")
        .unwrap();
    let diff = fixture.diff(revert.id);
    assert!(diff.records[0].before_tombstones_record);
    assert!(!diff.records[0].after_tombstones_record);
    assert_eq!(
        fixture.visible("company", "2026-06-15")[0]
            .values
            .get(&FieldId::from("name")),
        Some(&FieldValue::Text("Acme".to_string()))
    );
}

#[test]
fn revert_allows_multi_write_targets_from_the_same_change_set_match_generated_sql() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    fixture
        .apply(
            ApplyMode::Mainline,
            "revert-multi-row-original",
            vec![write(
                "company",
                "acme",
                "2026-04-01",
                Some(text_values("Acme Original")),
                false,
            )],
        )
        .unwrap();
    let target = fixture
        .apply(
            ApplyMode::Mainline,
            "revert-multi-row-target",
            vec![
                write(
                    "company",
                    "acme",
                    "2026-05-01",
                    Some(text_values("Acme May")),
                    false,
                ),
                write(
                    "company",
                    "acme",
                    "2026-06-01",
                    Some(text_values("Acme June")),
                    false,
                ),
            ],
        )
        .unwrap();
    fixture.revert(target.id, "revert-multi-row-key").unwrap();
    assert_eq!(
        fixture.visible("company", "2026-06-15")[0]
            .values
            .get(&FieldId::from("name")),
        Some(&FieldValue::Text("Acme Original".to_string()))
    );
}

#[test]
fn revert_record_creation_hides_the_created_record_match_generated_sql() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    let creation = fixture
        .apply(
            ApplyMode::Mainline,
            "revert-creation-target",
            vec![write(
                "company",
                "acme",
                "2026-05-01",
                Some(text_values("Acme")),
                false,
            )],
        )
        .unwrap();
    let created_visible = fixture.visible("company", "2026-05-15");
    assert_eq!(created_visible.len(), 1);
    let created_record_id = created_visible[0].record_id;
    let revert = fixture.revert(creation.id, "revert-creation-key").unwrap();
    let diff = fixture.diff(revert.id);
    assert!(!diff.records[0].before_tombstones_record);
    assert!(diff.records[0].after_tombstones_record);
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
        .apply(
            ApplyMode::Mainline,
            "revert-creation-new-record-after-release",
            vec![write(
                "company",
                "acme",
                "2026-06-01",
                Some(text_values("Acme Fresh")),
                false,
            )],
        )
        .unwrap();
    let fresh_visible = fixture.visible("company", "2026-06-15");
    assert_eq!(fresh_visible[0].external_key.as_deref(), Some("acme"));
    assert_ne!(fresh_visible[0].record_id, created_record_id);
}

#[test]
fn revert_rejects_tip_conflicts_and_revert_change_sets_match_generated_sql() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    fixture
        .apply(
            ApplyMode::Mainline,
            "revert-conflict-original",
            vec![write(
                "company",
                "acme",
                "2026-05-01",
                Some(text_values("Acme")),
                false,
            )],
        )
        .unwrap();
    let target = fixture
        .apply(
            ApplyMode::Mainline,
            "revert-conflict-target",
            vec![write(
                "company",
                "acme",
                "2026-06-01",
                Some(text_values("Acme June")),
                false,
            )],
        )
        .unwrap();
    let later = fixture
        .apply(
            ApplyMode::Mainline,
            "revert-conflict-later",
            vec![write(
                "company",
                "acme",
                "2026-07-01",
                Some(text_values("Acme July")),
                false,
            )],
        )
        .unwrap();
    let record_id: Uuid = fixture
        .client
        .query_one(
            "select id from company_record where app_id=$1 and customer_id=$2 and external_key='acme'",
            &[&APP_ID, &CUSTOMER_ID],
        )
        .unwrap()
        .get(0);
    assert_eq!(
        error_envelope(
            fixture
                .revert(target.id, "revert-conflict-key")
                .unwrap_err()
        ),
        plain_error(
            "revert_conflict",
            format!(
                "record `{record_id}` has a later mainline version at 2026-07-01 from change_set `{}`",
                later.id
            ),
        )
    );
    let revert = fixture.revert(later.id, "revert-later-key").unwrap();
    assert_eq!(
        error_envelope(
            fixture
                .revert(later.id, "revert-later-again-key")
                .unwrap_err()
        ),
        plain_error(
            "already_reverted",
            format!(
                "change_set `{}` has no mainline version rows to revert",
                later.id
            ),
        )
    );
    assert_eq!(
        error_envelope(fixture.revert(revert.id, "revert-revert-key").unwrap_err()),
        plain_error(
            "revert_conflict",
            format!("change_set `{}` is itself a revert", revert.id),
        )
    );
}

#[test]
fn revert_rejects_same_day_tip_conflicts_and_key_reuse_after_revert_match_generated_sql() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    let target = fixture
        .apply(
            ApplyMode::Mainline,
            "revert-same-day-target",
            vec![write(
                "company",
                "acme",
                "2026-05-01",
                Some(text_values("Acme")),
                false,
            )],
        )
        .unwrap();
    let tombstone = fixture
        .apply(
            ApplyMode::Mainline,
            "revert-same-day-tombstone",
            vec![write("company", "acme", "2026-05-01", None, true)],
        )
        .unwrap();
    let record_id: Uuid = fixture
        .client
        .query_one(
            "select id from company_record where app_id=$1 and customer_id=$2 and external_key='acme'",
            &[&APP_ID, &CUSTOMER_ID],
        )
        .unwrap()
        .get(0);
    assert_eq!(
        error_envelope(
            fixture
                .revert(target.id, "revert-same-day-conflict-key")
                .unwrap_err()
        ),
        plain_error(
            "revert_conflict",
            format!(
                "record `{record_id}` has a later mainline version at 2026-05-01 from change_set `{}`",
                tombstone.id
            ),
        )
    );
    let first = fixture
        .revert(tombstone.id, "revert-same-day-tombstone-key")
        .unwrap();
    let second = fixture
        .revert(tombstone.id, "revert-same-day-tombstone-key")
        .unwrap();
    assert_eq!(first, second);
    assert_eq!(
        error_envelope(
            fixture
                .revert(tombstone.id, "revert-same-day-tombstone-different-key")
                .unwrap_err()
        ),
        plain_error(
            "already_reverted",
            format!(
                "change_set `{}` has no mainline version rows to revert",
                tombstone.id
            ),
        )
    );
}

#[test]
fn stale_draft_approval_rejects_when_mainline_base_was_reverted_match_generated_sql() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    let base = fixture
        .apply(
            ApplyMode::Mainline,
            "revert-stales-draft-base",
            vec![write(
                "company",
                "acme",
                "2026-05-01",
                Some(text_values("Acme")),
                false,
            )],
        )
        .unwrap();
    let draft = fixture
        .apply(
            ApplyMode::Draft,
            "revert-stales-draft",
            vec![write(
                "company",
                "acme",
                "2026-06-01",
                Some(text_values("Acme Draft")),
                false,
            )],
        )
        .unwrap();
    let record_id: Uuid = fixture
        .client
        .query_one(
            "select id from company_record where app_id=$1 and customer_id=$2 and external_key='acme'",
            &[&APP_ID, &CUSTOMER_ID],
        )
        .unwrap()
        .get(0);
    let revert = fixture.revert(base.id, "revert-stales-draft-key").unwrap();
    assert_eq!(
        error_envelope(fixture.approve(draft.id).unwrap_err()),
        plain_error(
            "stale_draft",
            format!("company:{record_id} reverted by change_set `{}`", revert.id),
        )
    );
}

#[test]
fn revert_same_day_reopen_rejects_unique_field_conflicts_match_generated_sql() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    fixture
        .apply(
            ApplyMode::Mainline,
            "revert-unique-a-1",
            vec![write(
                "employee",
                "employee_a",
                "2026-01-01",
                Some(employee_values("Alice", Some("EMP-1"), None)),
                false,
            )],
        )
        .unwrap();
    let changed = fixture
        .apply(
            ApplyMode::Mainline,
            "revert-unique-a-2",
            vec![write(
                "employee",
                "employee_a",
                "2026-01-01",
                Some(employee_values("Alice", Some("EMP-2"), None)),
                false,
            )],
        )
        .unwrap();
    fixture
        .apply(
            ApplyMode::Mainline,
            "revert-unique-b",
            vec![write(
                "employee",
                "employee_b",
                "2026-03-01",
                Some(employee_values("Bob", Some("EMP-1"), None)),
                false,
            )],
        )
        .unwrap();

    let error = error_envelope(
        fixture
            .revert(changed.id, "revert-unique-conflict")
            .unwrap_err(),
    );
    assert_eq!(error.code, "unique_field_conflict");
    assert_eq!(error.message, "Unique field value already exists");
    assert_eq!(error.details.len(), 3);
    assert_eq!(error.details[0].path, "model");
    assert_eq!(error.details[0].code, "unique_field_conflict");
    assert_eq!(error.details[0].message, "employee");
    assert_eq!(error.details[1].path, "field");
    assert_eq!(error.details[1].code, "unique_field_conflict");
    assert_eq!(error.details[1].message, "ref");
    assert_eq!(error.details[2].path, "value");
    assert_eq!(error.details[2].code, "unique_field_conflict");
    assert_eq!(error.details[2].message, "EMP-1");
    let visible = fixture.visible("employee", "2026-03-15");
    let employee_a = visible
        .iter()
        .find(|record| record.external_key.as_deref() == Some("employee_a"))
        .unwrap();
    assert_eq!(
        employee_a.values.get(&FieldId::from("ref")),
        Some(&FieldValue::Text("EMP-2".to_string()))
    );
}
