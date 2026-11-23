use std::collections::BTreeMap;
use std::env;
use support::trusted_human;

use chrono::NaiveDate;
use kernel::testing::{call_generated_sql, GeneratedSqlFunction};
use kernel::{
    connect_postgres, AppId, AppliedChangeSet, ApplyChangeSet, ApplyMode, ChangeSetDiff,
    ChangeSetDiffRequest, ChangeSetStatus, ChangeType, ChangeTypeId, CustomerId, ExternalKey,
    Field, FieldDiff, FieldHistoryEntry, FieldHistoryRequest, FieldId, FieldType, FieldValue,
    Model, ModelId, ModelKind, MoneyRatePeriod, MoneyRateValue, RecentActivityEntry,
    RecentActivityRequest, RecordId, RecordKey, RevertChangeSet, RowVersionWrite, Schema,
    SchemaVersion, VersionStage, VisibleRecord,
};
use postgres::Client;
use rust_decimal::Decimal;
use schema_compiler::{
    compile_sql_artifact_manifest, render_sql_artifact_bundle, CompiledManifest,
    NormalizedManifestExtras,
};
use serde_json::json;
use uuid::Uuid;

mod support;

struct GeneratedReadFixture {
    client: Client,
    schema_name: String,
    customer_id: CustomerId,
}

impl GeneratedReadFixture {
    fn connect(customer_id: &str) -> Option<Self> {
        let database_url = match env::var("KERNEL_TEST_DATABASE_URL") {
            Ok(url) => url,
            Err(env::VarError::NotPresent) => {
                eprintln!(
                    "skipping generated SQL read parity test: KERNEL_TEST_DATABASE_URL is absent"
                );
                return None;
            }
            Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
        };
        let mut client = connect_postgres(&database_url)
            .unwrap_or_else(|error| panic!("connect generated SQL read parity database: {error}"));
        let schema_name = format!("kernel_read_parity_{}", Uuid::new_v4().simple());
        client
            .batch_execute(&format!(
                r#"create schema "{schema_name}"; set search_path to "{schema_name}""#
            ))
            .expect("create generated SQL read parity schema");

        let schema = test_schema(customer_id);
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
        let manifest = compile_sql_artifact_manifest(&compiled).expect("compile generated SQL");
        trusted_human::before_install(&mut client);
        client
            .batch_execute(&render_sql_artifact_bundle(&manifest))
            .expect("install generated SQL");
        let schema_json = serde_json::to_value(&schema).expect("serialize schema");
        let revision_id: i64 = client
            .query_one(
                r#"
                insert into schema_revision (
                  app_id, customer_id, version, base_schema, customer_overlay,
                  schema, activated_at, materialized_at
                ) values ($1, $2, $3, $4, '{}'::jsonb, $4, now(), now())
                returning id
                "#,
                &[
                    &schema.app_id.as_str(),
                    &schema.customer_id.as_str(),
                    &schema.version.as_str(),
                    &schema_json,
                ],
            )
            .expect("activate generated SQL schema")
            .get(0);
        assert!(revision_id > 0);

        trusted_human::bind(
            &mut client,
            compiled.schema.app_id.as_str(),
            customer_id,
            "tester",
        );
        Some(Self {
            client,
            schema_name,
            customer_id: CustomerId::from(customer_id),
        })
    }

    fn apply(
        &mut self,
        mode: ApplyMode,
        idempotency_key: &str,
        writes: Vec<RowVersionWrite>,
    ) -> AppliedChangeSet {
        call_generated_sql(
            &mut self.client,
            GeneratedSqlFunction::ApplyChangeSet,
            &ApplyChangeSet {
                app_id: AppId::from("core_app"),
                customer_id: self.customer_id.clone(),
                schema_revision_id: None,
                actor_id: Some("tester".to_string()),
                source_kind: "test".to_string(),
                source_ref: None,
                idempotency_key: Some(idempotency_key.to_string()),
                change_type_id: None,
                notes: None,
                mode,
                writes,
            },
        )
        .expect("generated SQL apply")
    }

    fn read(&mut self, model_id: &str, as_of: &str) -> Vec<VisibleRecord> {
        call_generated_sql(
            &mut self.client,
            GeneratedSqlFunction::ReadVisibleRecords,
            &json!({
                "app_id": "core_app",
                "customer_id": self.customer_id,
                "model_id": model_id,
                "as_of": as_of,
            }),
        )
        .expect("generated SQL visible read")
    }

    fn diff(&mut self, change_set_id: i64, project: Vec<FieldId>) -> ChangeSetDiff {
        call_generated_sql(
            &mut self.client,
            GeneratedSqlFunction::ChangeSetDiff,
            &ChangeSetDiffRequest {
                app_id: AppId::from("core_app"),
                customer_id: self.customer_id.clone(),
                change_set_id,
                project,
            },
        )
        .expect("generated SQL change-set diff")
    }

    fn history(
        &mut self,
        record_id: RecordId,
        as_of: Option<&str>,
        limit: Option<i64>,
    ) -> Vec<FieldHistoryEntry> {
        call_generated_sql(
            &mut self.client,
            GeneratedSqlFunction::FieldHistory,
            &FieldHistoryRequest {
                app_id: AppId::from("core_app"),
                customer_id: self.customer_id.clone(),
                model_id: ModelId::from("company"),
                record_id,
                field_id: Some(FieldId::from("name")),
                as_of: as_of.map(date),
                limit,
                stages: vec![],
            },
        )
        .expect("generated SQL field history")
    }

    fn record_id(&mut self, model_id: &str, external_key: &str) -> RecordId {
        self.client
            .query_one(
                &format!("select id from {model_id}_record where external_key = $1"),
                &[&external_key],
            )
            .expect("read generated record id")
            .get(0)
    }
}

impl Drop for GeneratedReadFixture {
    fn drop(&mut self) {
        support::drop_generated_sql_fixture(&mut self.client, &self.schema_name);
    }
}

fn test_schema(customer_id: &str) -> Schema {
    Schema {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from(customer_id),
        version: SchemaVersion::from("2026-05-04"),
        models: vec![
            Model {
                id: ModelId::from("company"),
                kind: ModelKind::Entity,
                label: "Company".to_string(),
                fields: vec![text_field("name", true)],
                ..Default::default()
            },
            Model {
                id: ModelId::from("employee"),
                kind: ModelKind::Entity,
                label: "Employee".to_string(),
                fields: vec![
                    text_field("name", true),
                    Field {
                        id: FieldId::from("employer"),
                        label: "Employer".to_string(),
                        field_type: FieldType::Relation,
                        required: false,
                        is_unique: false,
                        target_model: Some(ModelId::from("company")),
                        option_set: vec![],
                        ..Default::default()
                    },
                    Field {
                        id: FieldId::from("comp_rate"),
                        label: "Comp Rate".to_string(),
                        field_type: FieldType::MoneyRate,
                        required: false,
                        is_unique: false,
                        target_model: None,
                        option_set: vec![],
                        ..Default::default()
                    },
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
    }
}

fn text_field(id: &str, required: bool) -> Field {
    Field {
        id: FieldId::from(id),
        label: id.to_string(),
        field_type: FieldType::Text,
        required,
        is_unique: false,
        target_model: None,
        option_set: vec![],
        ..Default::default()
    }
}

fn date(value: &str) -> NaiveDate {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").expect("valid test date")
}

fn text_values(name: &str) -> BTreeMap<FieldId, FieldValue> {
    BTreeMap::from([(FieldId::from("name"), FieldValue::Text(name.to_string()))])
}

fn employee_values(name: &str, employer: &str) -> BTreeMap<FieldId, FieldValue> {
    BTreeMap::from([
        (FieldId::from("name"), FieldValue::Text(name.to_string())),
        (
            FieldId::from("employer"),
            FieldValue::Relation(RecordKey::ExternalKey(ExternalKey::from(employer))),
        ),
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

fn field_name(record: &VisibleRecord) -> Option<&FieldValue> {
    record.values.get(&FieldId::from("name"))
}

#[test]
fn mainline_apply_creates_updates_backdates_and_reads_visible_snapshots_match_generated_sql() {
    let Some(mut db) = GeneratedReadFixture::connect("customer_read_snapshots") else {
        return;
    };
    db.apply(
        ApplyMode::Mainline,
        "company-create",
        vec![write(
            "company",
            "acme",
            "2026-05-01",
            Some(text_values("Acme")),
            false,
        )],
    );
    db.apply(
        ApplyMode::Mainline,
        "employee-create",
        vec![write(
            "employee",
            "alice",
            "2026-05-01",
            Some(employee_values("Alice", "acme")),
            false,
        )],
    );
    db.apply(
        ApplyMode::Mainline,
        "employee-update",
        vec![write(
            "employee",
            "alice",
            "2026-06-01",
            Some(text_values("Alicia")),
            false,
        )],
    );
    db.apply(
        ApplyMode::Mainline,
        "employee-backdate",
        vec![write(
            "employee",
            "alice",
            "2026-04-01",
            Some(text_values("A.")),
            false,
        )],
    );

    let april = db.read("employee", "2026-04-15");
    assert_eq!(april.len(), 1);
    assert_eq!(
        field_name(&april[0]),
        Some(&FieldValue::Text("A.".to_string()))
    );
    let may = db.read("employee", "2026-05-15");
    assert_eq!(
        field_name(&may[0]),
        Some(&FieldValue::Text("Alice".to_string()))
    );
    let june = db.read("employee", "2026-06-15");
    assert_eq!(
        field_name(&june[0]),
        Some(&FieldValue::Text("Alicia".to_string()))
    );
    assert!(june[0].values.contains_key(&FieldId::from("employer")));
    assert!(june[0].values.contains_key(&FieldId::from("comp_rate")));
    assert!(
        june[0].version_id.is_some(),
        "canonical entity reads expose a version token"
    );
}

#[test]
fn visible_reader_rejects_mainline_version_without_applied_order_owner_match_generated_sql() {
    let Some(mut db) = GeneratedReadFixture::connect("customer_mainline_order_drift") else {
        return;
    };
    let draft = db.apply(
        ApplyMode::Draft,
        "mainline-order-drift",
        vec![write(
            "company",
            "acme",
            "2026-05-01",
            Some(text_values("Acme")),
            false,
        )],
    );
    db.client
        .execute(
            "update company_version set stage = 'mainline', applied_at = now() where change_set_id = $1",
            &[&draft.id],
        )
        .expect("inject mainline ordering drift");

    let error = call_generated_sql::<Vec<VisibleRecord>>(
        &mut db.client,
        GeneratedSqlFunction::ReadVisibleRecords,
        &json!({
            "app_id": "core_app",
            "customer_id": "customer_mainline_order_drift",
            "model_id": "company",
            "as_of": "2026-05-01",
        }),
    )
    .expect_err("mainline row owned by draft must fail closed");
    assert_eq!(error.into_envelope().code, "schema_drift");
}

#[test]
fn mainline_apply_tombstones_hide_records_from_visible_reads_match_generated_sql() {
    let Some(mut db) = GeneratedReadFixture::connect("customer_tombstones") else {
        return;
    };
    db.apply(
        ApplyMode::Mainline,
        "company-create-for-delete",
        vec![write(
            "company",
            "acme",
            "2026-05-01",
            Some(text_values("Acme")),
            false,
        )],
    );
    db.apply(
        ApplyMode::Mainline,
        "company-delete",
        vec![write("company", "acme", "2026-06-01", None, true)],
    );

    assert_eq!(db.read("company", "2026-05-15").len(), 1);
    assert!(db.read("company", "2026-06-15").is_empty());
}

#[test]
fn change_set_diff_covers_mainline_draft_and_projection_match_generated_sql() {
    let Some(mut db) = GeneratedReadFixture::connect("customer_diff") else {
        return;
    };
    let create = db.apply(
        ApplyMode::Mainline,
        "diff-create-acme",
        vec![write(
            "company",
            "acme",
            "2026-05-01",
            Some(text_values("Acme")),
            false,
        )],
    );
    let create_diff = db.diff(create.id, vec![]);
    assert_eq!(create_diff.records.len(), 1);
    assert_eq!(create_diff.records[0].stage, VersionStage::Mainline);
    assert_eq!(create_diff.records[0].external_key.as_deref(), Some("acme"));
    assert_eq!(create_diff.records[0].fields[0].before, None);
    assert_eq!(
        create_diff.records[0].fields[0].after,
        Some(FieldValue::Text("Acme".to_string()))
    );

    let update = db.apply(
        ApplyMode::Draft,
        "diff-draft-acme",
        vec![
            write(
                "company",
                "acme",
                "2026-06-01",
                Some(text_values("Acme Draft")),
                false,
            ),
            write(
                "company",
                "acme",
                "2026-07-01",
                Some(text_values("Acme Draft Later")),
                false,
            ),
        ],
    );
    let draft_diff = db.diff(update.id, vec![FieldId::from("name")]);
    assert_eq!(draft_diff.records.len(), 2);
    assert_eq!(draft_diff.records[0].stage, VersionStage::Draft);
    assert_eq!(
        draft_diff.records[0].fields,
        vec![FieldDiff {
            field_id: FieldId::from("name"),
            before: Some(FieldValue::Text("Acme".to_string())),
            after: Some(FieldValue::Text("Acme Draft".to_string())),
            before_enum: None,
            after_enum: None,
        }]
    );
    assert_eq!(
        draft_diff.records[1].fields,
        vec![FieldDiff {
            field_id: FieldId::from("name"),
            before: Some(FieldValue::Text("Acme Draft".to_string())),
            after: Some(FieldValue::Text("Acme Draft Later".to_string())),
            before_enum: None,
            after_enum: None,
        }]
    );

    let error = call_generated_sql::<ChangeSetDiff>(
        &mut db.client,
        GeneratedSqlFunction::ChangeSetDiff,
        &ChangeSetDiffRequest {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from("customer_b"),
            change_set_id: create.id,
            project: vec![],
        },
    )
    .expect_err("cross-tenant change-set diff must fail closed");
    assert_eq!(error.into_envelope().code, "record_target_missing");
}

#[test]
fn change_set_diff_allows_backdated_draft_before_first_visible_version_match_generated_sql() {
    let Some(mut db) = GeneratedReadFixture::connect("customer_diff_priorless") else {
        return;
    };
    db.apply(
        ApplyMode::Mainline,
        "diff-priorless-baseline",
        vec![write(
            "company",
            "diff-priorless-acme",
            "2026-05-01",
            Some(text_values("Acme")),
            false,
        )],
    );
    let draft = db.apply(
        ApplyMode::Draft,
        "diff-priorless-draft",
        vec![write(
            "company",
            "diff-priorless-acme",
            "2026-03-31",
            Some(text_values("Acme Backdated")),
            false,
        )],
    );
    let draft_diff = db.diff(draft.id, vec![FieldId::from("name")]);
    assert_eq!(draft_diff.records.len(), 1);
    assert_eq!(draft_diff.records[0].stage, VersionStage::Draft);
    assert_eq!(draft_diff.records[0].effective_start, date("2026-03-31"));
    assert_eq!(
        draft_diff.records[0].fields,
        vec![FieldDiff {
            field_id: FieldId::from("name"),
            before: None,
            after: Some(FieldValue::Text("Acme Backdated".to_string())),
            before_enum: None,
            after_enum: None,
        }]
    );
    let approved: AppliedChangeSet = call_generated_sql(
        &mut db.client,
        GeneratedSqlFunction::ApproveDraftChangeSet,
        &json!({"actor_id":"tester",
            "app_id": "core_app",
            "customer_id": "customer_diff_priorless",
            "change_set_id": draft.id,
        }),
    )
    .expect("approve backdated draft");
    assert_eq!(approved.id, draft.id);
    assert_eq!(
        field_name(&db.read("company", "2026-04-15")[0]),
        Some(&FieldValue::Text("Acme Backdated".to_string()))
    );
    assert_eq!(
        field_name(&db.read("company", "2026-05-15")[0]),
        Some(&FieldValue::Text("Acme".to_string()))
    );
}

#[test]
fn change_set_diff_allows_backdated_draft_sandwiched_between_mainline_versions_match_generated_sql()
{
    let Some(mut db) = GeneratedReadFixture::connect("customer_diff_sandwich") else {
        return;
    };
    db.apply(
        ApplyMode::Mainline,
        "diff-sandwich-baseline",
        vec![write(
            "company",
            "diff-sandwich-acme",
            "2026-03-01",
            Some(text_values("Acme T1")),
            false,
        )],
    );
    db.apply(
        ApplyMode::Mainline,
        "diff-sandwich-later-mainline",
        vec![write(
            "company",
            "diff-sandwich-acme",
            "2026-05-01",
            Some(text_values("Acme T3")),
            false,
        )],
    );
    let draft = db.apply(
        ApplyMode::Draft,
        "diff-sandwich-draft",
        vec![write(
            "company",
            "diff-sandwich-acme",
            "2026-03-31",
            Some(text_values("Acme T2 Draft")),
            false,
        )],
    );
    let draft_diff = db.diff(draft.id, vec![FieldId::from("name")]);
    assert_eq!(draft_diff.records.len(), 1);
    assert_eq!(draft_diff.records[0].stage, VersionStage::Draft);
    assert_eq!(draft_diff.records[0].effective_start, date("2026-03-31"));
    assert_eq!(
        draft_diff.records[0].fields,
        vec![FieldDiff {
            field_id: FieldId::from("name"),
            before: Some(FieldValue::Text("Acme T1".to_string())),
            after: Some(FieldValue::Text("Acme T2 Draft".to_string())),
            before_enum: None,
            after_enum: None,
        }]
    );
    let approved: AppliedChangeSet = call_generated_sql(
        &mut db.client,
        GeneratedSqlFunction::ApproveDraftChangeSet,
        &json!({"actor_id":"tester",
            "app_id": "core_app",
            "customer_id": "customer_diff_sandwich",
            "change_set_id": draft.id,
        }),
    )
    .expect("approve sandwiched draft");
    assert_eq!(approved.id, draft.id);
    for (as_of, expected) in [
        ("2026-03-15", "Acme T1"),
        ("2026-04-15", "Acme T2 Draft"),
        ("2026-05-15", "Acme T3"),
    ] {
        assert_eq!(
            field_name(&db.read("company", as_of)[0]),
            Some(&FieldValue::Text(expected.to_string()))
        );
    }
}

#[test]
fn field_history_limit_returns_newest_snapshots_in_chronological_order_match_generated_sql() {
    let Some(mut db) = GeneratedReadFixture::connect("customer_history_limit") else {
        return;
    };
    for (index, effective_start) in [
        "2026-01-01",
        "2026-02-01",
        "2026-03-01",
        "2026-04-01",
        "2030-01-01",
    ]
    .into_iter()
    .enumerate()
    {
        db.apply(
            ApplyMode::Mainline,
            &format!("history-limit-{index}"),
            vec![write(
                "company",
                "bounded",
                effective_start,
                Some(text_values(&format!("Bounded {index}"))),
                false,
            )],
        );
    }
    let record_id = db.record_id("company", "bounded");
    let history = db.history(record_id, Some("2026-04-01"), Some(2));
    assert_eq!(history.len(), 2);
    assert_eq!(
        history
            .iter()
            .map(|entry| entry.effective_start)
            .collect::<Vec<_>>(),
        vec![date("2026-03-01"), date("2026-04-01")]
    );
    assert_eq!(
        history
            .iter()
            .map(|entry| entry.value.clone())
            .collect::<Vec<_>>(),
        vec![
            Some(FieldValue::Text("Bounded 2".to_string())),
            Some(FieldValue::Text("Bounded 3".to_string())),
        ]
    );
    assert!(history
        .iter()
        .all(|entry| entry.effective_start != date("2026-02-01")));
    assert!(history
        .iter()
        .all(|entry| entry.effective_start != date("2030-01-01")));
}

#[test]
fn field_history_limit_counts_logical_snapshots_not_physical_rows_match_generated_sql() {
    let Some(mut db) = GeneratedReadFixture::connect("customer_history_logical_limit") else {
        return;
    };
    db.apply(
        ApplyMode::Mainline,
        "history-logical-baseline",
        vec![write(
            "company",
            "logical",
            "2026-01-01",
            Some(text_values("Logical baseline")),
            false,
        )],
    );
    let latest = db.apply(
        ApplyMode::Mainline,
        "history-logical-latest",
        vec![
            write(
                "company",
                "logical",
                "2026-02-01",
                Some(text_values("Logical latest")),
                false,
            ),
            write("company", "logical", "2026-02-01", None, true),
        ],
    );
    let record_id = db.record_id("company", "logical");
    let history = db.history(record_id, None, Some(1));
    assert_eq!(history.len(), 2);
    assert!(history.iter().all(|entry| entry.change_set_id == latest.id));
    assert!(history
        .iter()
        .all(|entry| entry.effective_start == date("2026-02-01")));
}

#[test]
fn field_history_limit_breaks_same_effective_date_ties_by_applied_order_match_generated_sql() {
    let Some(mut db) = GeneratedReadFixture::connect("customer_history_same_date_limit") else {
        return;
    };
    let mut change_set_ids = Vec::new();
    for index in 0..3 {
        let change_set = db.apply(
            ApplyMode::Mainline,
            &format!("history-same-date-{index}"),
            vec![write(
                "company",
                "same-date",
                "2026-05-01",
                Some(text_values(&format!("Same date {index}"))),
                false,
            )],
        );
        change_set_ids.push(change_set.id);
    }
    let record_id = db.record_id("company", "same-date");
    let history = db.history(record_id, None, Some(2));
    assert_eq!(history.len(), 2);
    assert_eq!(
        history
            .iter()
            .map(|entry| entry.change_set_id)
            .collect::<Vec<_>>(),
        change_set_ids[1..].to_vec()
    );
    assert!(history
        .iter()
        .all(|entry| entry.effective_start == date("2026-05-01")));
}

#[test]
fn recent_activity_filters_and_counts_touched_records_match_generated_sql() {
    let Some(mut db) = GeneratedReadFixture::connect("customer_activity") else {
        return;
    };
    let company = db.apply(
        ApplyMode::Mainline,
        "activity-company",
        vec![write(
            "company",
            "acme",
            "2026-05-01",
            Some(text_values("Acme")),
            false,
        )],
    );
    let draft = db.apply(
        ApplyMode::Draft,
        "activity-draft",
        vec![write(
            "employee",
            "alice",
            "2026-05-01",
            Some(employee_values("Alice", "acme")),
            false,
        )],
    );
    let revert: AppliedChangeSet = call_generated_sql(
        &mut db.client,
        GeneratedSqlFunction::RevertChangeSet,
        &RevertChangeSet {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from("customer_activity"),
            change_set_id: company.id,
            actor_id: Some("tester".to_string()),
            idempotency_key: Some("activity-revert".to_string()),
            notes: None,
        },
    )
    .expect("generated SQL revert");

    let activity: Vec<RecentActivityEntry> = call_generated_sql(
        &mut db.client,
        GeneratedSqlFunction::RecentActivity,
        &RecentActivityRequest {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from("customer_activity"),
            limit: Some(10),
            statuses: vec![],
            source_kinds: vec![],
        },
    )
    .expect("generated SQL recent activity");
    assert_eq!(
        activity
            .iter()
            .map(|entry| entry.change_set_id)
            .collect::<Vec<_>>(),
        vec![revert.id, draft.id, company.id]
    );
    assert_eq!(activity[0].source_kind, "revert");
    assert_eq!(activity[0].source_ref, Some(company.id.to_string()));
    assert_eq!(activity[0].touched_record_count, 1);
    assert_eq!(activity[1].status, ChangeSetStatus::Draft);
    assert_eq!(activity[1].touched_record_count, 1);

    let revert_only: Vec<RecentActivityEntry> = call_generated_sql(
        &mut db.client,
        GeneratedSqlFunction::RecentActivity,
        &RecentActivityRequest {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from("customer_activity"),
            limit: None,
            statuses: vec![ChangeSetStatus::Mainline],
            source_kinds: vec!["revert".to_string()],
        },
    )
    .expect("generated SQL filtered recent activity");
    assert_eq!(revert_only.len(), 1);
    assert_eq!(revert_only[0].change_set_id, revert.id);
}
