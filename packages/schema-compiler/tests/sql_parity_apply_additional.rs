use std::collections::BTreeMap;
use std::env;
use support::trusted_human;

use chrono::NaiveDate;
use kernel::testing::{call_generated_sql, DbError, GeneratedSqlFunction};
use kernel::{
    connect_postgres, AppId, AppliedChangeSet, ApplyChangeSet, ApplyMode, CustomerId, ErrorDetail,
    ErrorEnvelope, ExternalKey, Field, FieldId, FieldType, FieldValue, KernelError, Model, ModelId,
    ModelKind, RecordId, RecordKey, RowVersionWrite, Schema, SchemaRevisionId, SchemaVersion,
};
use postgres::error::SqlState;
use postgres::Client;
use schema_compiler::{
    compile_sql_artifact_manifest, render_sql_artifact_bundle, CompiledManifest,
    NormalizedManifestExtras,
};
use uuid::Uuid;

mod support;

const APP_ID: &str = "core_app";

struct TestDatabase {
    client: Client,
    schema_name: String,
}

impl TestDatabase {
    fn connect(customer_id: &str) -> Option<Self> {
        let database_url = match env::var("KERNEL_TEST_DATABASE_URL") {
            Ok(url) => url,
            Err(env::VarError::NotPresent) => {
                eprintln!(
                    "skipping generated SQL apply parity test: KERNEL_TEST_DATABASE_URL is absent"
                );
                return None;
            }
            Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
        };
        let mut client = connect_postgres(&database_url).expect("connect to PostgreSQL");
        let schema_name = format!("kernel_apply_additional_{}", Uuid::new_v4().simple());
        client
            .batch_execute(&format!(
                "create schema \"{schema_name}\"; set search_path to \"{schema_name}\""
            ))
            .expect("create isolated generated SQL apply schema");

        let compiled = compiled_manifest(customer_id);
        let manifest =
            compile_sql_artifact_manifest(&compiled).expect("compile generated SQL artifacts");
        trusted_human::before_install(&mut client);
        client
            .batch_execute(&render_sql_artifact_bundle(&manifest))
            .unwrap_or_else(|error| panic!("install generated SQL apply bundle: {error}"));
        client
            .execute(
                r#"
                insert into schema_revision (
                  id, app_id, customer_id, version, base_schema, customer_overlay,
                  schema, activated_at, materialized_at
                ) values (1, $1, $2, $3, $4, '{}'::jsonb, $4, now(), now())
                "#,
                &[
                    &APP_ID,
                    &customer_id,
                    &compiled.schema.version.as_str(),
                    &serde_json::to_value(&compiled.schema).expect("serialize test schema"),
                ],
            )
            .expect("activate generated SQL apply schema");

        trusted_human::bind(&mut client, APP_ID, customer_id, "tester");
        Some(Self {
            client,
            schema_name,
        })
    }

    fn apply(&mut self, request: &ApplyChangeSet) -> Result<AppliedChangeSet, KernelError> {
        call_generated_sql(
            &mut self.client,
            GeneratedSqlFunction::ApplyChangeSet,
            request,
        )
    }

    fn record_id(&mut self, customer_id: &str, external_key: &str) -> RecordId {
        self.client
            .query_one(
                "select id from company_record where app_id = $1 and customer_id = $2 and external_key = $3",
                &[&APP_ID, &customer_id, &external_key],
            )
            .expect("read generated company record id")
            .get("id")
    }

    fn scope_residue(&mut self, customer_id: &str) -> i64 {
        self.client
            .query_one(
                r#"
                select
                  (select count(*) from employee_record where app_id = $1 and customer_id = $2)
                  + (select count(*) from company_record where app_id = $1 and customer_id = $2)
                  + (select count(*) from change_set where app_id = $1 and customer_id = $2)
                  + (select count(*) from employee_version where app_id = $1 and customer_id = $2)
                  + (select count(*) from company_version where app_id = $1 and customer_id = $2)
                "#,
                &[&APP_ID, &customer_id],
            )
            .expect("read generated apply residue")
            .get(0)
    }
}

impl Drop for TestDatabase {
    fn drop(&mut self) {
        support::drop_generated_sql_fixture(&mut self.client, &self.schema_name);
    }
}

#[test]
fn mainline_apply_replays_idempotent_requests_and_rejects_conflicts_match_generated_sql() {
    let customer_id = "customer_apply_idempotency";
    let Some(mut database) = TestDatabase::connect(customer_id) else {
        return;
    };
    let request = mainline_apply(
        customer_id,
        Some("company-idempotent"),
        vec![company_write("acme", "2026-05-01", Some("Acme"), false)],
    );

    let first = database.apply(&request).expect("apply initial request");
    let second = database.apply(&request).expect("replay exact request");
    assert_eq!(first, second);

    let mut explicit_revision = request.clone();
    explicit_revision.schema_revision_id = Some(first.schema_revision_id);
    assert_eq!(
        database
            .apply(&explicit_revision)
            .expect("replay with explicit revision"),
        first
    );

    let mut conflicting = request.clone();
    conflicting.writes[0].values = Some(text_values("Different"));
    assert_eq!(
        database
            .apply(&conflicting)
            .expect_err("conflicting replay must fail")
            .into_envelope(),
        KernelError::from(DbError::IdempotencyConflict {
            key: "company-idempotent".to_string(),
        })
        .into_envelope()
    );

    let mut stale_replay = request;
    stale_replay.schema_revision_id = Some(SchemaRevisionId::new(999));
    assert_eq!(
        database
            .apply(&stale_replay)
            .expect_err("stale explicit replay must fail")
            .into_envelope(),
        KernelError::from(DbError::IdempotencyConflict {
            key: "company-idempotent".to_string(),
        })
        .into_envelope()
    );
}

#[test]
fn mainline_apply_stores_change_set_notes_match_generated_sql() {
    let customer_id = "customer_apply_notes";
    let Some(mut database) = TestDatabase::connect(customer_id) else {
        return;
    };
    let mut request = mainline_apply(
        customer_id,
        Some("company-notes"),
        vec![company_write("acme", "2026-05-01", Some("Acme"), false)],
    );
    request.notes = Some("reviewed source upload".to_string());

    let applied = database.apply(&request).expect("apply noted change set");
    let notes: Option<String> = database
        .client
        .query_one("select notes from change_set where id = $1", &[&applied.id])
        .expect("read generated change-set notes")
        .get(0);
    assert_eq!(notes.as_deref(), Some("reviewed source upload"));
}

#[test]
fn mainline_apply_rejects_same_change_set_uuid_external_aliases_atomically_match_generated_sql() {
    let customer_id = "customer_apply_alias";
    let Some(mut database) = TestDatabase::connect(customer_id) else {
        return;
    };
    database
        .apply(&mainline_apply(
            customer_id,
            Some("alias-baseline"),
            vec![company_write("acme", "2026-04-01", Some("Acme"), false)],
        ))
        .expect("apply alias baseline");
    let record_id = database.record_id(customer_id, "acme");

    let error = database
        .apply(&mainline_apply(
            customer_id,
            Some("alias-duplicate"),
            vec![
                company_write("acme", "2026-05-01", Some("Acme External"), false),
                RowVersionWrite {
                    model_id: ModelId::from("company"),
                    record_key: Some(RecordKey::RecordId(record_id)),
                    new_record_id: None,
                    effective_start: date("2026-05-01"),
                    values: Some(text_values("Acme UUID")),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,
                    ..Default::default()
                },
            ],
        ))
        .expect_err("duplicate subject aliases must fail")
        .into_envelope();
    assert_eq!(
        error,
        KernelError::from(DbError::TimelineConflict {
            details: format!(
                "change set contains more than one ordinary value snapshot for record `{record_id}` at 2026-05-01"
            ),
        })
        .into_envelope()
    );
    let residue: i64 = database
        .client
        .query_one(
            r#"
            select
              (select count(*) from change_set where app_id = $1 and customer_id = $2 and idempotency_key = 'alias-duplicate')
              + (select count(*) from company_version where app_id = $1 and customer_id = $2 and effective_start = date '2026-05-01')
            "#,
            &[&APP_ID, &customer_id],
        )
        .expect("read alias rollback residue")
        .get(0);
    assert_eq!(residue, 0);
}

#[test]
fn mainline_apply_rejects_duplicate_lifecycle_rows_in_one_change_set_match_generated_sql() {
    let customer_id = "customer_apply_lifecycle_duplicate";
    let Some(mut database) = TestDatabase::connect(customer_id) else {
        return;
    };
    database
        .apply(&mainline_apply(
            customer_id,
            Some("lifecycle-duplicate-baseline"),
            vec![company_write("acme", "2026-04-01", Some("Acme"), false)],
        ))
        .expect("apply lifecycle baseline");
    let record_id = database.record_id(customer_id, "acme");
    let tombstone = company_write("acme", "2026-05-01", None, true);

    let error = database
        .apply(&mainline_apply(
            customer_id,
            Some("lifecycle-duplicate"),
            vec![tombstone.clone(), tombstone],
        ))
        .expect_err("duplicate lifecycle rows must fail")
        .into_envelope();
    assert_eq!(
        error,
        KernelError::from(DbError::TimelineConflict {
            details: format!(
                "change set contains more than one tombstone snapshot for record `{record_id}` at 2026-05-01"
            ),
        })
        .into_envelope()
    );
    let residue: i64 = database
        .client
        .query_one(
            "select count(*) from change_set where app_id = $1 and customer_id = $2 and idempotency_key = 'lifecycle-duplicate'",
            &[&APP_ID, &customer_id],
        )
        .expect("read lifecycle rollback residue")
        .get(0);
    assert_eq!(residue, 0);

    let tombstone = database
        .apply(&mainline_apply(
            customer_id,
            Some("lifecycle-database-first"),
            vec![company_write("acme", "2026-05-01", None, true)],
        ))
        .expect("apply first lifecycle row");
    let other = database
        .apply(&mainline_apply(
            customer_id,
            Some("lifecycle-database-other"),
            vec![company_write("beta", "2026-05-01", Some("Beta"), false)],
        ))
        .expect("apply unrelated ordinary row");
    let database_duplicate = database
        .client
        .execute(
            r#"
            insert into company_version (
              id, record_id, app_id, customer_id, stage, effective_start,
              change_set_id, applied_at, tombstones_record
            )
            select $1, record_id, app_id, customer_id, 'mainline', effective_start,
                   $2, now(), true
            from company_version
            where change_set_id = $3
            "#,
            &[&Uuid::new_v4(), &other.id, &tombstone.id],
        )
        .expect_err("database lifecycle uniqueness must reject duplicate");
    assert_eq!(database_duplicate.code(), Some(&SqlState::UNIQUE_VIOLATION));
}

#[test]
fn direct_mainline_planned_relation_is_input_order_independent_match_generated_sql() {
    let customer_id = "customer_apply_planned_relation";
    let Some(mut database) = TestDatabase::connect(customer_id) else {
        return;
    };
    let applied = database
        .apply(&mainline_apply(
            customer_id,
            Some("planned-relation-source-first"),
            vec![
                employee_write("alice", "2026-05-01", "Alice", "acme"),
                company_write("acme", "2026-05-01", Some("Acme"), false),
            ],
        ))
        .expect("apply source-first planned relation");

    let row = database
        .client
        .query_one(
            r#"
            select ev.employer, cr.id as company_id, ev.change_set_id
            from employee_version ev
            join employee_record er on er.id = ev.record_id
            join company_record cr
              on cr.app_id = ev.app_id
             and cr.customer_id = ev.customer_id
             and cr.external_key = 'acme'
            where ev.app_id = $1
              and ev.customer_id = $2
              and er.external_key = 'alice'
            "#,
            &[&APP_ID, &customer_id],
        )
        .expect("read planned relation result");
    assert_eq!(
        row.get::<_, RecordId>("employer"),
        row.get::<_, RecordId>("company_id")
    );
    assert_eq!(row.get::<_, i64>("change_set_id"), applied.id);
}

#[test]
fn invalid_planned_relation_rolls_back_all_reservations_match_generated_sql() {
    let customer_id = "customer_apply_planned_relation_rollback";
    let Some(mut database) = TestDatabase::connect(customer_id) else {
        return;
    };
    let error = database
        .apply(&mainline_apply(
            customer_id,
            Some("planned-relation-not-yet-visible"),
            vec![
                employee_write("alice", "2026-05-01", "Alice", "acme"),
                company_write("acme", "2026-06-01", Some("Acme"), false),
            ],
        ))
        .expect_err("future planned relation target must fail")
        .into_envelope();
    assert_record_state_error(
        error,
        "record_target_missing",
        " is not visible as of 2026-05-01",
    );
    assert_eq!(database.scope_residue(customer_id), 0);

    let tombstoned = database
        .apply(&mainline_apply(
            customer_id,
            Some("planned-relation-tombstoned"),
            vec![
                employee_write("alice", "2026-05-01", "Alice", "acme"),
                company_write("acme", "2026-05-01", Some("Acme"), false),
                company_write("acme", "2026-05-01", None, true),
            ],
        ))
        .expect_err("planned tombstone must hide relation target")
        .into_envelope();
    assert_record_state_error(
        tombstoned,
        "tombstoned_record",
        " is tombstoned as of 2026-05-01",
    );
    assert_eq!(database.scope_residue(customer_id), 0);
}

#[test]
fn ordinary_apply_rejects_reserved_revert_source_kind_match_generated_sql() {
    let customer_id = "customer_apply_reserved_source";
    let Some(mut database) = TestDatabase::connect(customer_id) else {
        return;
    };
    let mut request = mainline_apply(
        customer_id,
        Some("reserved-revert-source-kind"),
        vec![company_write("acme", "2026-05-01", Some("Acme"), false)],
    );
    request.source_kind = "revert".to_string();

    assert_eq!(
        database
            .apply(&request)
            .expect_err("reserved source kind must fail")
            .into_envelope(),
        KernelError::from(DbError::ReservedSourceKind {
            source_kind: "revert".to_string(),
        })
        .into_envelope()
    );
}

#[test]
fn mainline_apply_rejects_backdated_tombstone_before_later_mainline_match_generated_sql() {
    let customer_id = "customer_apply_backdated_tombstone";
    let Some(mut database) = TestDatabase::connect(customer_id) else {
        return;
    };
    database
        .apply(&mainline_apply(
            customer_id,
            Some("company-for-backdated-tombstone"),
            vec![company_write("acme", "2026-05-01", Some("Acme"), false)],
        ))
        .expect("apply later mainline version");
    let record_id = database.record_id(customer_id, "acme");

    assert_eq!(
        database
            .apply(&mainline_apply(
                customer_id,
                Some("company-backdated-tombstone"),
                vec![company_write("acme", "2026-04-01", None, true)],
            ))
            .expect_err("backdated tombstone must fail")
            .into_envelope(),
        KernelError::from(DbError::TimelineConflict {
            details: format!(
                "tombstone for record `{record_id}` at 2026-04-01 would precede a later mainline version"
            ),
        })
        .into_envelope()
    );
}

#[test]
fn mainline_apply_rejects_min_effective_start_without_panicking_match_generated_sql() {
    let customer_id = "customer_apply_min_date";
    let Some(mut database) = TestDatabase::connect(customer_id) else {
        return;
    };
    let mut write = company_write("acme", "2026-05-01", Some("Acme"), false);
    write.effective_start = NaiveDate::MIN;

    assert_eq!(
        database
            .apply(&mainline_apply(
                customer_id,
                Some("company-min-effective-start"),
                vec![write],
            ))
            .expect_err("minimum effective_start must fail")
            .into_envelope(),
        ErrorEnvelope {
            code: "contract_validation_failed".to_string(),
            message: "Contract validation failed".to_string(),
            details: vec![ErrorDetail {
                path: "writes[0].effective_start".to_string(),
                code: "effective_start_underflow".to_string(),
                message: "effective_start is too early to close a prior version range".to_string(),
            }],
        }
    );
}

fn assert_record_state_error(error: ErrorEnvelope, code: &str, suffix: &str) {
    assert_eq!(error.code, code);
    assert!(error.details.is_empty());
    let record_id = error
        .message
        .strip_prefix("record `")
        .and_then(|message| message.strip_suffix(suffix))
        .and_then(|message| message.strip_suffix('`'))
        .unwrap_or_else(|| panic!("unexpected {code} message: {}", error.message));
    RecordId::parse_str(record_id).expect("record-state error includes a record UUID");
}

fn compiled_manifest(customer_id: &str) -> CompiledManifest {
    CompiledManifest {
        schema: Schema {
            app_id: AppId::from(APP_ID),
            customer_id: CustomerId::from(customer_id),
            version: SchemaVersion::from("2026-08-04"),
            models: vec![
                Model {
                    id: ModelId::from("company"),
                    kind: ModelKind::Entity,
                    label: "Company".to_string(),
                    fields: vec![field("name", FieldType::Text, true, None)],
                    ..Default::default()
                },
                Model {
                    id: ModelId::from("employee"),
                    kind: ModelKind::Entity,
                    label: "Employee".to_string(),
                    fields: vec![
                        field("name", FieldType::Text, true, None),
                        field("employer", FieldType::Relation, true, Some("company")),
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

fn field(id: &str, field_type: FieldType, required: bool, target_model: Option<&str>) -> Field {
    Field {
        id: FieldId::from(id),
        label: id.to_string(),
        field_type,
        required,
        is_unique: false,
        target_model: target_model.map(ModelId::from),
        option_set: vec![],
        ..Default::default()
    }
}

fn mainline_apply(
    customer_id: &str,
    idempotency_key: Option<&str>,
    writes: Vec<RowVersionWrite>,
) -> ApplyChangeSet {
    ApplyChangeSet {
        app_id: AppId::from(APP_ID),
        customer_id: CustomerId::from(customer_id),
        schema_revision_id: None,
        actor_id: Some("tester".to_string()),
        source_kind: "test".to_string(),
        source_ref: None,
        idempotency_key: idempotency_key.map(str::to_string),
        change_type_id: None,
        notes: None,
        mode: ApplyMode::Mainline,
        writes,
    }
}

fn company_write(
    external_key: &str,
    effective_start: &str,
    name: Option<&str>,
    tombstones_record: bool,
) -> RowVersionWrite {
    RowVersionWrite {
        model_id: ModelId::from("company"),
        record_key: Some(RecordKey::ExternalKey(ExternalKey::from(external_key))),
        new_record_id: None,
        effective_start: date(effective_start),
        values: name.map(text_values),
        custom_fields: None,
        tombstones_record,
        provenance: None,
        ..Default::default()
    }
}

fn employee_write(
    external_key: &str,
    effective_start: &str,
    name: &str,
    employer: &str,
) -> RowVersionWrite {
    RowVersionWrite {
        model_id: ModelId::from("employee"),
        record_key: Some(RecordKey::ExternalKey(ExternalKey::from(external_key))),
        new_record_id: None,
        effective_start: date(effective_start),
        values: Some(BTreeMap::from([
            (FieldId::from("name"), FieldValue::Text(name.to_string())),
            (
                FieldId::from("employer"),
                FieldValue::Relation(RecordKey::ExternalKey(ExternalKey::from(employer))),
            ),
        ])),
        custom_fields: None,
        tombstones_record: false,
        provenance: None,
        ..Default::default()
    }
}

fn text_values(name: &str) -> BTreeMap<FieldId, FieldValue> {
    BTreeMap::from([(FieldId::from("name"), FieldValue::Text(name.to_string()))])
}

fn date(value: &str) -> NaiveDate {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").expect("valid parity test date")
}
