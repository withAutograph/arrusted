use std::collections::BTreeMap;
use std::env;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};
use support::trusted_human;

use chrono::{DateTime, NaiveDate, Utc};
use kernel::testing::{call_generated_sql, GeneratedSqlFunction};
use kernel::{
    connect_postgres, AppId, AppliedChangeSet, ApplyChangeSet, ApplyMode, ChangeType, ChangeTypeId,
    CustomerId, EnumOption, EnumOptionId, ErrorDetail, ErrorEnvelope, ExternalKey, Field, FieldId,
    FieldType, FieldValue, KernelError, Model, ModelId, ModelKind, MoneyRatePeriod, MoneyRateValue,
    RecordId, RecordKey, RowVersionWrite, Schema, SchemaRevisionId, SchemaVersion,
};
use postgres::error::SqlState;
use postgres::Client;
use rust_decimal::Decimal;
use schema_compiler::{
    compile_sql_artifact_manifest, render_sql_artifact_bundle, CompiledManifest,
    NormalizedManifestExtras,
};
use serde_json::{json, Value};
use uuid::Uuid;

mod support;

const APP_ID: &str = "core_app";

struct TestDatabase {
    client: Client,
    schema_name: String,
}

impl TestDatabase {
    fn connect(schema: Schema) -> Option<Self> {
        let database_url = match env::var("KERNEL_TEST_DATABASE_URL") {
            Ok(url) => url,
            Err(env::VarError::NotPresent) => {
                eprintln!(
                    "skipping generated SQL apply type parity test: KERNEL_TEST_DATABASE_URL is absent"
                );
                return None;
            }
            Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
        };
        let mut client = connect_postgres(&database_url).expect("connect to PostgreSQL");
        let schema_name = format!("kernel_apply_types_{}", Uuid::new_v4().simple());
        client
            .batch_execute(&format!(
                "create schema \"{schema_name}\"; set search_path to \"{schema_name}\""
            ))
            .expect("create isolated generated SQL type schema");

        let compiled = compiled_manifest(schema);
        let manifest =
            compile_sql_artifact_manifest(&compiled).expect("compile generated SQL artifacts");
        trusted_human::before_install(&mut client);
        client
            .batch_execute(&render_sql_artifact_bundle(&manifest))
            .unwrap_or_else(|error| panic!("install generated SQL type bundle: {error}"));
        client
            .execute(
                r#"
                insert into schema_revision (
                  id, app_id, customer_id, version, base_schema, customer_overlay,
                  schema, activated_at, materialized_at
                ) values (1, $1, $2, $3, $4, '{}'::jsonb, $4, now(), now())
                "#,
                &[
                    &compiled.schema.app_id.as_str(),
                    &compiled.schema.customer_id.as_str(),
                    &compiled.schema.version.as_str(),
                    &serde_json::to_value(&compiled.schema).expect("serialize test schema"),
                ],
            )
            .expect("activate generated SQL type schema");

        trusted_human::bind(
            &mut client,
            compiled.schema.app_id.as_str(),
            compiled.schema.customer_id.as_str(),
            "tester",
        );
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

    fn apply_json(&mut self, request: &Value) -> Result<AppliedChangeSet, KernelError> {
        call_generated_sql(
            &mut self.client,
            GeneratedSqlFunction::ApplyChangeSet,
            request,
        )
    }
}

impl Drop for TestDatabase {
    fn drop(&mut self) {
        support::drop_generated_sql_fixture(&mut self.client, &self.schema_name);
    }
}

#[test]
fn version_preconditions_use_the_locked_visible_baseline_match_generated_sql() {
    let customer_id = "customer_version_precondition";
    let Some(mut database) = TestDatabase::connect(valid_schema(customer_id)) else {
        return;
    };
    database
        .apply(&apply_request(
            customer_id,
            Some("version-create"),
            vec![model_write("record", "guarded", display_name("Initial"))],
        ))
        .expect("create guarded record");
    let baseline: RecordId = database
        .client
        .query_one(
            "select v.id from record_version v join record_record r on r.id = v.record_id where r.external_key = 'guarded' and v.stage = 'mainline'",
            &[],
        )
        .expect("read visible version token")
        .get(0);

    let mut current = model_write("record", "guarded", display_name("Current"));
    current.effective_start = date("2026-05-05");
    current.expected_version_id = Some(baseline);
    let current_request = apply_request(customer_id, Some("version-current"), vec![current]);
    let current_receipt = database
        .apply(&current_request)
        .expect("matching visible token applies");
    let mut later = model_write("record", "guarded", display_name("Later"));
    later.effective_start = date("2026-05-07");
    database
        .apply(&apply_request(
            customer_id,
            Some("version-later"),
            vec![later],
        ))
        .expect("later unguarded write applies");
    assert_eq!(
        database
            .apply(&current_request)
            .expect("exact replay wins before stale guard"),
        current_receipt
    );
    let mut changed_token = current_request.clone();
    changed_token.writes[0].expected_version_id = Some(Uuid::new_v4());
    assert_eq!(
        database
            .apply(&changed_token)
            .expect_err("same idempotency key with changed guard conflicts")
            .into_envelope()
            .code,
        "idempotency_conflict"
    );

    let mut stale = model_write("record", "guarded", display_name("Stale"));
    stale.effective_start = date("2026-05-06");
    // Reuse the token returned by the first visible snapshot: it was valid for
    // the initial write, but is stale after the guarded update above.
    stale.expected_version_id = Some(baseline);
    assert_eq!(
        database
            .apply(&apply_request(
                customer_id,
                Some("version-stale"),
                vec![stale]
            ))
            .expect_err("wrong visible token fails")
            .into_envelope(),
        ErrorEnvelope {
            code: "version_conflict".to_string(),
            message: "This record has changed. Reload and try again.".to_string(),
            details: vec![],
        }
    );

    let malformed = json!({
        "app_id": APP_ID, "customer_id": customer_id, "schema_revision_id": 1,
        "actor_id": "tester",
        "source_kind": "test", "idempotency_key": "version-malformed", "mode": "mainline",
        "writes": [{
            "model_id": "record", "record_key": {"type":"external_key","value":"guarded"},
            "effective_start": "2026-05-06", "expected_version_id": "not-a-uuid",
            "values": {"display_name":{"type":"text","value":"Malformed"}}
        }]
    });
    assert_validation(
        database
            .apply_json(&malformed)
            .expect_err("malformed token fails"),
        vec![detail(
            "writes[0].expected_version_id",
            "invalid_expected_version_id",
            "expected_version_id must be a UUID",
        )],
    );

    let draft = json!({
        "app_id": APP_ID, "customer_id": customer_id, "schema_revision_id": 1,
        "actor_id": "tester",
        "source_kind": "test", "idempotency_key": "version-draft", "mode": "draft",
        "writes": [{
            "model_id": "record", "record_key": {"type":"external_key","value":"guarded"},
            "effective_start": "2026-05-06", "expected_version_id": baseline.to_string(),
            "values": {"display_name":{"type":"text","value":"Draft"}}
        }]
    });
    assert_validation(
        database
            .apply_json(&draft)
            .expect_err("draft version guard fails"),
        vec![detail(
            "writes[0].expected_version_id",
            "version_precondition_requires_mainline",
            "version preconditions are supported only for mainline writes",
        )],
    );

    for key in [None, Some(Value::Null)] {
        let mut unaddressed = draft.clone();
        unaddressed["mode"] = json!("mainline");
        unaddressed["idempotency_key"] = json!("version-unaddressed");
        let write = unaddressed["writes"][0].as_object_mut().unwrap();
        write.remove("record_key");
        if let Some(key) = key {
            write.insert("record_key".to_string(), key);
        }
        assert_validation(
            database
                .apply_json(&unaddressed)
                .expect_err("implicit create guard fails"),
            vec![detail(
                "writes[0].expected_version_id",
                "create_version_precondition_forbidden",
                "new record writes cannot carry a version precondition",
            )],
        );
    }

    let missing = json!({
        "app_id": APP_ID, "customer_id": customer_id, "schema_revision_id": 1,
        "actor_id": "tester",
        "source_kind": "test", "idempotency_key": "version-missing", "mode": "mainline",
        "writes": [{
            "model_id": "record", "record_key": {"type":"external_key","value":"missing-guarded"},
            "effective_start": "2026-05-06", "expected_version_id": Uuid::new_v4().to_string(),
            "values": {"display_name":{"type":"text","value":"Missing"}}
        }]
    });
    assert_eq!(
        database
            .apply_json(&missing)
            .expect_err("missing guarded baseline fails")
            .into_envelope(),
        ErrorEnvelope {
            code: "version_conflict".to_string(),
            message: "This record has changed. Reload and try again.".to_string(),
            details: vec![],
        }
    );
    let persisted: i64 = database
        .client
        .query_one(
            "select count(*) from record_record where external_key = 'missing-guarded'",
            &[],
        )
        .expect("inspect rolled-back subject reservation")
        .get(0);
    assert_eq!(
        persisted, 0,
        "guard failure must not create an external-key subject"
    );
}

#[test]
fn guarded_batch_conflict_precedes_unguarded_sibling_drift_match_generated_sql() {
    let customer_id = "customer_version_batch_order";
    let Some(mut database) = TestDatabase::connect(valid_schema(customer_id)) else {
        return;
    };
    database
        .apply(&apply_request(
            customer_id,
            Some("batch-seed"),
            vec![
                model_write("record", "first", display_name("First")),
                model_write("record", "second", display_name("Second")),
            ],
        ))
        .expect("seed batch subjects");
    let subjects = database
        .client
        .query(
            "select id, external_key from record_record where external_key in ('first', 'second') order by id",
            &[],
        )
        .expect("read canonical lock order");
    assert_eq!(subjects.len(), 2);
    let unguarded_id: RecordId = subjects[0].get(0);
    let guarded_id: RecordId = subjects[1].get(0);
    let guarded_baseline: RecordId = database
        .client
        .query_one(
            "select id from record_version where record_id = $1 and stage = 'mainline'",
            &[&guarded_id],
        )
        .expect("read guarded baseline")
        .get(0);

    database
        .client
        .batch_execute("begin")
        .expect("begin blocker transaction");
    database
        .client
        .query_one(
            "select id from record_record where id = $1 for update",
            &[&unguarded_id],
        )
        .expect("hold first canonical record lock");

    let mut unguarded = model_write("record", "unused", display_name("Waiter unguarded"));
    unguarded.record_key = Some(RecordKey::RecordId(unguarded_id));
    unguarded.effective_start = date("2026-05-05");
    let mut guarded = model_write("record", "unused", display_name("Waiter guarded"));
    guarded.record_key = Some(RecordKey::RecordId(guarded_id));
    guarded.effective_start = date("2026-05-05");
    guarded.expected_version_id = Some(guarded_baseline);
    let waiter_request = apply_request(customer_id, Some("batch-waiter"), vec![guarded, unguarded]);
    let schema_name = database.schema_name.clone();
    let database_url = env::var("KERNEL_TEST_DATABASE_URL").expect("actual PostgreSQL URL");
    let (pid_tx, pid_rx) = mpsc::channel();
    let waiter = thread::spawn(move || {
        let mut client = connect_postgres(&database_url).expect("connect waiter");
        client
            .batch_execute(&format!("set search_path to \"{schema_name}\""))
            .expect("set waiter schema");
        trusted_human::select(&mut client, "tester");
        let pid: i32 = client
            .query_one("select pg_backend_pid()", &[])
            .expect("read waiter pid")
            .get(0);
        pid_tx.send(pid).expect("send waiter pid");
        call_generated_sql::<AppliedChangeSet>(
            &mut client,
            GeneratedSqlFunction::ApplyChangeSet,
            &waiter_request,
        )
    });
    let waiter_pid = pid_rx.recv().expect("receive waiter pid");
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let waiting = database
            .client
            .query_opt(
                "select wait_event_type from pg_stat_activity where pid = $1",
                &[&waiter_pid],
            )
            .expect("observe waiter lock");
        if waiting.is_some_and(|row| row.get::<_, Option<String>>(0).as_deref() == Some("Lock")) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "waiter did not reach the held record lock"
        );
        thread::sleep(Duration::from_millis(10));
    }

    let mut winner_unguarded = model_write("record", "unused", display_name("Winner unguarded"));
    winner_unguarded.record_key = Some(RecordKey::RecordId(unguarded_id));
    winner_unguarded.effective_start = date("2026-05-05");
    let mut winner_guarded = model_write("record", "unused", display_name("Winner guarded"));
    winner_guarded.record_key = Some(RecordKey::RecordId(guarded_id));
    winner_guarded.effective_start = date("2026-05-05");
    winner_guarded.expected_version_id = Some(guarded_baseline);
    database
        .apply(&apply_request(
            customer_id,
            Some("batch-winner"),
            vec![winner_unguarded, winner_guarded],
        ))
        .expect("winner changes both baselines while waiter is blocked");
    database
        .client
        .batch_execute("commit")
        .expect("release held record lock");

    assert_eq!(
        waiter
            .join()
            .expect("waiter joins")
            .expect_err("later guarded mismatch must win over generic sibling drift")
            .into_envelope(),
        ErrorEnvelope {
            code: "version_conflict".to_string(),
            message: "This record has changed. Reload and try again.".to_string(),
            details: vec![],
        }
    );
    let waiter_change_sets: i64 = database
        .client
        .query_one(
            "select count(*) from change_set where idempotency_key = 'batch-waiter'",
            &[],
        )
        .expect("inspect waiter rollback")
        .get(0);
    let waiter_versions: i64 = database
        .client
        .query_one(
            "select count(*) from record_version where display_name like 'Waiter %'",
            &[],
        )
        .expect("inspect waiter version rollback")
        .get(0);
    assert_eq!(
        waiter_change_sets, 0,
        "conflicted batch leaves no change-set receipt"
    );
    assert_eq!(
        waiter_versions, 0,
        "conflicted batch leaves no version rows"
    );
    let winner_values: Vec<String> = database.client.query(
        "select display_name from record_version where record_id in ($1, $2) and effective_start = '2026-05-05' order by record_id", &[&unguarded_id, &guarded_id]
    ).expect("read winner values").into_iter().map(|row| row.get(0)).collect();
    assert_eq!(winner_values.len(), 2);
    assert!(winner_values
        .iter()
        .all(|value| value.starts_with("Winner ")));
}

#[test]
fn guarded_same_record_multi_date_batch_uses_the_original_visible_baseline() {
    let customer_id = "customer_version_same_record_batch";
    let Some(mut database) = TestDatabase::connect(valid_schema(customer_id)) else {
        return;
    };
    database
        .apply(&apply_request(
            customer_id,
            Some("same-record-seed"),
            vec![model_write("record", "same", display_name("Initial"))],
        ))
        .expect("seed record");
    let baseline: RecordId = database.client.query_one(
        "select v.id from record_version v join record_record r on r.id=v.record_id where r.external_key='same' and v.stage='mainline'", &[]
    ).expect("read initial token").get(0);
    let mut first = model_write("record", "same", display_name("May"));
    first.effective_start = date("2026-05-05");
    first.expected_version_id = Some(baseline);
    let mut second = model_write("record", "same", display_name("June"));
    second.effective_start = date("2026-06-05");
    second.expected_version_id = Some(baseline);
    database
        .apply(&apply_request(
            customer_id,
            Some("same-record-guarded-batch"),
            vec![first, second],
        ))
        .expect("both dates use their original pre-apply baseline");
    let names: Vec<String> = database.client.query("select display_name from record_version v join record_record r on r.id=v.record_id where r.external_key='same' and v.effective_start in ('2026-05-05','2026-06-05') order by v.effective_start", &[]).expect("read batch versions").into_iter().map(|row| row.get(0)).collect();
    assert_eq!(names, vec!["May", "June"]);
}

#[test]
fn permits_repeated_versions_for_an_explicit_new_record_match_generated_sql() {
    let customer_id = "customer_repeated_explicit_new";
    let Some(mut database) = TestDatabase::connect(valid_schema(customer_id)) else {
        return;
    };
    let record_id = Uuid::parse_str("018f6bf3-1ea5-7812-9a5a-a1f5b04f0103").unwrap();
    let write = |effective_start: &str, name: &str| RowVersionWrite {
        model_id: ModelId::from("record"),
        record_key: None,
        new_record_id: Some(record_id),
        effective_start: date(effective_start),
        values: Some(display_name(name)),
        custom_fields: None,
        tombstones_record: false,
        provenance: None,
        ..Default::default()
    };

    database
        .apply(&apply_request(
            customer_id,
            None,
            vec![
                write("2026-05-04", "Initial"),
                write("2026-06-04", "Updated"),
            ],
        ))
        .expect("repeated explicit-new versions apply through generated SQL");

    let rows = database
        .client
        .query(
            "select display_name, effective_start, effective_end from record_version where record_id = $1 order by effective_start",
            &[&record_id],
        )
        .expect("read repeated explicit-new versions");
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].get::<_, String>("display_name"), "Initial");
    assert_eq!(
        rows[0].get::<_, Option<NaiveDate>>("effective_end"),
        Some(date("2026-06-03"))
    );
    assert_eq!(rows[1].get::<_, String>("display_name"), "Updated");
    assert_eq!(
        rows[1].get::<_, NaiveDate>("effective_start"),
        date("2026-06-04")
    );
}

#[test]
fn rejects_values_that_do_not_match_declared_field_type_match_generated_sql() {
    let customer_id = "customer_type_mismatch";
    let Some(mut database) = TestDatabase::connect(valid_schema(customer_id)) else {
        return;
    };
    assert_validation(
        database
            .apply(&apply_request(
                customer_id,
                None,
                vec![record_write(BTreeMap::from([(
                    FieldId::from("display_name"),
                    FieldValue::Bool(true),
                )]))],
            ))
            .expect_err("declared field type mismatch must fail"),
        vec![detail(
            "writes[0].values.display_name",
            "field_value_type_mismatch",
            "field `display_name` value does not match declared type",
        )],
    );
}

#[test]
fn validates_all_field_value_variants_against_declared_field_types_match_generated_sql() {
    let customer_id = "customer_all_field_types";
    let Some(mut database) = TestDatabase::connect(all_field_types_schema(customer_id)) else {
        return;
    };
    let relation_id = Uuid::parse_str("018f6bf3-1ea5-7812-9a5a-a1f5b04f0001").unwrap();
    database
        .apply(&apply_request(
            customer_id,
            Some("all-types-relation-target"),
            vec![RowVersionWrite {
                model_id: ModelId::from("record"),
                record_key: None,
                new_record_id: Some(relation_id),
                effective_start: date("2026-04-01"),
                values: Some(BTreeMap::from([(
                    FieldId::from("field_0"),
                    FieldValue::Text("target".to_string()),
                )])),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,
                ..Default::default()
            }],
        ))
        .expect("seed relation target");

    let datetime = DateTime::parse_from_rfc3339("2026-05-04T12:00:00Z")
        .unwrap()
        .with_timezone(&Utc);
    let values = BTreeMap::from([
        (
            FieldId::from("field_0"),
            FieldValue::Text("value".to_string()),
        ),
        (FieldId::from("field_1"), FieldValue::Text("US".to_string())),
        (
            FieldId::from("field_2"),
            FieldValue::Text("USD".to_string()),
        ),
        (
            FieldId::from("field_3"),
            FieldValue::Number(Decimal::new(125, 1)),
        ),
        (FieldId::from("field_4"), FieldValue::Bool(true)),
        (
            FieldId::from("field_5"),
            FieldValue::Date(date("2026-05-04")),
        ),
        (FieldId::from("field_6"), FieldValue::Datetime(datetime)),
        (
            FieldId::from("field_7"),
            FieldValue::Relation(RecordKey::RecordId(relation_id)),
        ),
        (
            FieldId::from("field_8"),
            FieldValue::TextList(vec!["a".to_string(), "b".to_string()]),
        ),
        (
            FieldId::from("field_9"),
            FieldValue::TextList(vec!["alias".to_string(), "alternate".to_string()]),
        ),
        (
            FieldId::from("field_10"),
            FieldValue::Json(json!({"key": "value"})),
        ),
        (
            FieldId::from("field_11"),
            FieldValue::MoneyRate(MoneyRateValue {
                amount: Decimal::new(10000, 2),
                currency: "USD".to_string(),
                period: MoneyRatePeriod::Annual,
            }),
        ),
        (
            FieldId::from("field_12"),
            FieldValue::Enum(EnumOptionId::from("active")),
        ),
    ]);
    database
        .apply(&apply_request(
            customer_id,
            Some("all-types-value"),
            vec![record_write(values)],
        ))
        .expect("all typed field variants apply through generated SQL");

    let row = database
        .client
        .query_one(
            r#"
            select field_0, field_1, field_2, field_3::text as field_3, field_4,
                   field_5, field_6, field_7, field_8, field_9, field_10,
                   field_11_amount::text as field_11_amount,
                   field_11_currency, field_11_period, field_12
            from record_version
            where record_id <> $1
            "#,
            &[&relation_id],
        )
        .expect("read all generated typed columns");
    assert_eq!(row.get::<_, String>("field_0"), "value");
    assert_eq!(row.get::<_, String>("field_1"), "US");
    assert_eq!(row.get::<_, String>("field_2"), "USD");
    assert_eq!(row.get::<_, String>("field_3"), "12.5");
    assert!(row.get::<_, bool>("field_4"));
    assert_eq!(row.get::<_, NaiveDate>("field_5"), date("2026-05-04"));
    assert_eq!(row.get::<_, DateTime<Utc>>("field_6"), datetime);
    assert_eq!(row.get::<_, RecordId>("field_7"), relation_id);
    assert_eq!(row.get::<_, Vec<String>>("field_8"), vec!["a", "b"]);
    assert_eq!(
        row.get::<_, Vec<String>>("field_9"),
        vec!["alias", "alternate"]
    );
    assert_eq!(row.get::<_, Value>("field_10"), json!({"key": "value"}));
    assert_eq!(row.get::<_, String>("field_11_amount"), "100.00");
    assert_eq!(row.get::<_, String>("field_11_currency"), "USD");
    assert_eq!(row.get::<_, String>("field_11_period"), "annual");
    assert_eq!(row.get::<_, String>("field_12"), "active");
}

#[test]
fn rejects_unknown_declared_enum_option_match_generated_sql() {
    let customer_id = "customer_unknown_enum";
    let mut schema = valid_schema(customer_id);
    schema.models[0].fields.push(enum_field("status"));
    let Some(mut database) = TestDatabase::connect(schema) else {
        return;
    };
    assert_validation(
        database
            .apply(&apply_request(
                customer_id,
                None,
                vec![record_write(BTreeMap::from([(
                    FieldId::from("status"),
                    FieldValue::Enum(EnumOptionId::from("inactive")),
                )]))],
            ))
            .expect_err("unknown enum option must fail"),
        vec![detail(
            "writes[0].values.status",
            "unknown_enum_option",
            "enum option `inactive` is not active for field `status`",
        )],
    );
}

#[test]
fn rejects_invalid_money_rate_values_match_generated_sql() {
    let customer_id = "customer_invalid_money";
    let mut schema = valid_schema(customer_id);
    schema.models[0]
        .fields
        .push(field("rate", FieldType::MoneyRate, false, None));
    let Some(mut database) = TestDatabase::connect(schema) else {
        return;
    };
    let expected = vec![detail(
        "writes[0].values.rate",
        "field_value_type_mismatch",
        "field `rate` value does not match declared type",
    )];
    for (case, value) in [
        (
            "non-tender-currency",
            json!({"amount": "100.00", "currency": "XXX", "period": "annual"}),
        ),
        (
            "unsupported-period",
            json!({"amount": "100.00", "currency": "USD", "period": "quarterly"}),
        ),
        (
            "numeric-amount",
            json!({"amount": 100.00, "currency": "USD", "period": "annual"}),
        ),
        (
            "excessive-scale",
            json!({"amount": "0.12345678901234567890123456789", "currency": "USD", "period": "annual"}),
        ),
        (
            "decimal-overflow",
            json!({"amount": "79228162514264337593543950336", "currency": "USD", "period": "annual"}),
        ),
    ] {
        assert_validation(
            database
                .apply_json(&raw_money_request(customer_id, case, value))
                .expect_err("invalid money-rate payload must fail"),
            expected.clone(),
        );
    }
}

#[test]
fn rejects_invalid_iso_country_and_currency_values_match_generated_sql() {
    let customer_id = "customer_invalid_iso";
    let mut schema = valid_schema(customer_id);
    schema.models[0].fields.extend([
        field("country", FieldType::IsoCountry, false, None),
        field("currency", FieldType::IsoCurrency, false, None),
    ]);
    let Some(mut database) = TestDatabase::connect(schema) else {
        return;
    };
    assert_validation(
        database
            .apply(&apply_request(
                customer_id,
                None,
                vec![record_write(BTreeMap::from([
                    (
                        FieldId::from("country"),
                        FieldValue::Text("USA".to_string()),
                    ),
                    (
                        FieldId::from("currency"),
                        FieldValue::Text("XXX".to_string()),
                    ),
                ]))],
            ))
            .expect_err("invalid canonical ISO values must fail"),
        vec![
            detail(
                "writes[0].values.country",
                "field_value_type_mismatch",
                "field `country` value does not match declared type",
            ),
            detail(
                "writes[0].values.currency",
                "field_value_type_mismatch",
                "field `currency` value does not match declared type",
            ),
        ],
    );
}

#[test]
fn rejects_invalid_record_keys_match_generated_sql() {
    let customer_id = "customer_invalid_record_key";
    let Some(mut database) = TestDatabase::connect(valid_schema(customer_id)) else {
        return;
    };
    let mut write = record_write(display_name("Example Record"));
    write.record_key = Some(RecordKey::ExternalKey(ExternalKey::from("  ")));
    assert_validation(
        database
            .apply(&apply_request(customer_id, None, vec![write]))
            .expect_err("blank external record key must fail"),
        vec![detail(
            "writes[0].record_key",
            "empty_external_key",
            "external record keys must not be empty",
        )],
    );
}

#[test]
fn rejects_change_type_model_mismatch_without_enforcing_touches_match_generated_sql() {
    let customer_id = "customer_change_type_mismatch";
    let mut schema = valid_schema(customer_id);
    schema.models.push(Model {
        id: ModelId::from("other_record"),
        kind: ModelKind::Entity,
        label: "Other Record".to_string(),
        fields: vec![field("display_name", FieldType::Text, false, None)],
        ..Default::default()
    });
    let Some(mut database) = TestDatabase::connect(schema) else {
        return;
    };
    let mut request = apply_request(
        customer_id,
        None,
        vec![RowVersionWrite {
            model_id: ModelId::from("other_record"),
            record_key: None,
            new_record_id: None,
            effective_start: date("2026-05-04"),
            values: Some(display_name("Other")),
            custom_fields: None,
            tombstones_record: false,
            provenance: None,
            ..Default::default()
        }],
    );
    request.mode = ApplyMode::Draft;
    request.change_type_id = Some(ChangeTypeId::from("record_update"));

    assert_validation(
        database
            .apply(&request)
            .expect_err("change type target mismatch must fail"),
        vec![detail(
            "writes[0].model_id",
            "change_type_model_mismatch",
            "write model_id `other_record` does not match change_type target_model `record`",
        )],
    );
}

#[test]
fn change_type_touches_and_required_are_descriptive_for_apply_match_generated_sql() {
    let customer_id = "customer_descriptive_change_type";
    let mut schema = valid_schema(customer_id);
    schema.models[0].fields.extend([
        field("required_note", FieldType::Text, false, None),
        field("review_note", FieldType::Text, false, None),
    ]);
    schema.change_types[0].touches = vec![FieldId::from("display_name")];
    schema.change_types[0].required = vec![FieldId::from("required_note")];
    let Some(mut database) = TestDatabase::connect(schema) else {
        return;
    };
    let mut baseline = model_write(
        "record",
        "record-1",
        BTreeMap::from([(
            FieldId::from("display_name"),
            FieldValue::Text("Existing".to_string()),
        )]),
    );
    baseline.effective_start = date("2026-04-01");
    database
        .apply(&apply_request(
            customer_id,
            Some("descriptive-change-type-baseline"),
            vec![baseline],
        ))
        .expect("seed required model field");
    let mut review_write = record_write(BTreeMap::from([(
        FieldId::from("review_note"),
        FieldValue::Text("Not listed in change_type.touches".to_string()),
    )]));
    review_write.record_key = Some(RecordKey::ExternalKey(ExternalKey::from("record-1")));
    let mut request = apply_request(customer_id, None, vec![review_write]);
    request.mode = ApplyMode::Draft;
    request.change_type_id = Some(ChangeTypeId::from("record_update"));

    let applied = database
        .apply(&request)
        .expect("descriptive change-type metadata must not reject apply");
    let review_note: Option<String> = database
        .client
        .query_one(
            "select review_note from record_version where change_set_id = $1",
            &[&applied.id],
        )
        .expect("read descriptive change-type draft")
        .get(0);
    assert_eq!(
        review_note.as_deref(),
        Some("Not listed in change_type.touches")
    );
}

#[test]
fn known_aliases_materializes_and_round_trips_as_text_list_match_generated_sql() {
    let customer_id = "customer_aliases";
    let schema = single_model_schema(
        customer_id,
        "department",
        vec![
            field("name", FieldType::Text, true, None),
            field("known_aliases", FieldType::KnownAliases, false, None),
        ],
    );
    let Some(mut database) = TestDatabase::connect(schema) else {
        return;
    };
    assert_column_type(
        &mut database.client,
        "department_version",
        "known_aliases",
        "ARRAY",
        "_text",
    );

    database
        .apply(&apply_request(
            customer_id,
            Some("department-aliases"),
            vec![model_write(
                "department",
                "engineering",
                BTreeMap::from([
                    (
                        FieldId::from("name"),
                        FieldValue::Text("Engineering".to_string()),
                    ),
                    (
                        FieldId::from("known_aliases"),
                        FieldValue::TextList(vec![
                            "Eng".to_string(),
                            "engineering team".to_string(),
                        ]),
                    ),
                ]),
            )],
        ))
        .expect("known aliases apply through generated SQL");
    assert_eq!(
        database
            .client
            .query_one("select known_aliases from department_version", &[])
            .expect("read generated known aliases")
            .get::<_, Vec<String>>(0),
        vec!["Eng", "engineering team"]
    );
}

#[test]
fn iso_fields_materialize_and_round_trip_as_text_match_generated_sql() {
    let customer_id = "customer_iso_fields";
    let schema = single_model_schema(
        customer_id,
        "employee",
        vec![
            field("name", FieldType::Text, true, None),
            field("country", FieldType::IsoCountry, false, None),
            field("currency", FieldType::IsoCurrency, false, None),
        ],
    );
    let Some(mut database) = TestDatabase::connect(schema) else {
        return;
    };
    for column in ["country", "currency"] {
        assert_column_type(
            &mut database.client,
            "employee_version",
            column,
            "text",
            "text",
        );
    }

    database
        .apply(&apply_request(
            customer_id,
            Some("employee-iso-fields"),
            vec![model_write(
                "employee",
                "alice",
                BTreeMap::from([
                    (FieldId::from("name"), FieldValue::Text("Alice".to_string())),
                    (FieldId::from("country"), FieldValue::Text("US".to_string())),
                    (
                        FieldId::from("currency"),
                        FieldValue::Text("USD".to_string()),
                    ),
                ]),
            )],
        ))
        .expect("canonical ISO values apply through generated SQL");
    let row = database
        .client
        .query_one("select country, currency from employee_version", &[])
        .expect("read generated ISO fields");
    assert_eq!(row.get::<_, String>("country"), "US");
    assert_eq!(row.get::<_, String>("currency"), "USD");
}

#[test]
fn money_rate_components_are_all_or_none_match_generated_sql() {
    let customer_id = "customer_money_components";
    let schema = single_model_schema(
        customer_id,
        "employee",
        vec![
            field("name", FieldType::Text, true, None),
            field("comp_rate", FieldType::MoneyRate, false, None),
        ],
    );
    let Some(mut database) = TestDatabase::connect(schema) else {
        return;
    };
    let applied = database
        .apply(&apply_request(
            customer_id,
            Some("money-anchor"),
            vec![model_write(
                "employee",
                "anchor",
                BTreeMap::from([(
                    FieldId::from("name"),
                    FieldValue::Text("Anchor".to_string()),
                )]),
            )],
        ))
        .expect("create generated money-rate anchor");
    let record_id = Uuid::parse_str("018f6bf3-1ea5-7812-9a5a-a1f5b04f0102").unwrap();
    database
        .client
        .execute(
            "insert into employee_record (id, app_id, customer_id, external_key) values ($1, $2, $3, 'partial')",
            &[&record_id, &APP_ID, &customer_id],
        )
        .expect("insert direct money-rate record");
    let blocked = database
        .client
        .execute(
            r#"
            insert into employee_version (
              id, record_id, app_id, customer_id, stage, effective_start,
              change_set_id, applied_at, name, comp_rate_amount
            ) values ($1, $2, $3, $4, 'mainline', date '2026-06-01', $5, now(), 'Alice', 100.00)
            "#,
            &[
                &Uuid::new_v4(),
                &record_id,
                &APP_ID,
                &customer_id,
                &applied.id,
            ],
        )
        .expect_err("partial money-rate tuple must violate generated check");
    assert_eq!(blocked.code(), Some(&SqlState::CHECK_VIOLATION));
}

fn assert_validation(error: KernelError, details: Vec<ErrorDetail>) {
    assert_eq!(
        error.into_envelope(),
        ErrorEnvelope {
            code: "contract_validation_failed".to_string(),
            message: "Contract validation failed".to_string(),
            details,
        }
    );
}

fn detail(path: &str, code: &str, message: &str) -> ErrorDetail {
    ErrorDetail {
        path: path.to_string(),
        code: code.to_string(),
        message: message.to_string(),
    }
}

fn compiled_manifest(schema: Schema) -> CompiledManifest {
    CompiledManifest {
        schema,
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

fn valid_schema(customer_id: &str) -> Schema {
    Schema {
        app_id: AppId::from(APP_ID),
        customer_id: CustomerId::from(customer_id),
        version: SchemaVersion::from("2026-05-04"),
        models: vec![Model {
            id: ModelId::from("record"),
            kind: ModelKind::Entity,
            label: "Record".to_string(),
            fields: vec![
                field("display_name", FieldType::Text, true, None),
                field("parent_record", FieldType::Relation, false, Some("record")),
            ],
            ..Default::default()
        }],
        custom_fields: vec![],
        change_types: vec![ChangeType {
            id: ChangeTypeId::from("record_update"),
            label: "Record Update".to_string(),
            target_model: ModelId::from("record"),
            is_import_default: false,
            touches: vec![
                FieldId::from("display_name"),
                FieldId::from("parent_record"),
            ],
            required: vec![FieldId::from("display_name")],
        }],
    }
}

fn all_field_types_schema(customer_id: &str) -> Schema {
    let types = [
        FieldType::Text,
        FieldType::IsoCountry,
        FieldType::IsoCurrency,
        FieldType::Number,
        FieldType::Bool,
        FieldType::Date,
        FieldType::Datetime,
        FieldType::Relation,
        FieldType::TextList,
        FieldType::KnownAliases,
        FieldType::Json,
        FieldType::MoneyRate,
        FieldType::Enum,
    ];
    Schema {
        app_id: AppId::from(APP_ID),
        customer_id: CustomerId::from(customer_id),
        version: SchemaVersion::from("2026-05-04"),
        models: vec![Model {
            id: ModelId::from("record"),
            kind: ModelKind::Entity,
            label: "Record".to_string(),
            fields: types
                .into_iter()
                .enumerate()
                .map(|(index, field_type)| {
                    let mut field = field(
                        &format!("field_{index}"),
                        field_type.clone(),
                        false,
                        matches!(field_type, FieldType::Relation).then_some("record"),
                    );
                    if matches!(field_type, FieldType::Enum) {
                        field.option_set = enum_field("unused").option_set;
                    }
                    field
                })
                .collect(),
            ..Default::default()
        }],
        custom_fields: vec![],
        change_types: vec![],
    }
}

fn single_model_schema(customer_id: &str, model_id: &str, fields: Vec<Field>) -> Schema {
    Schema {
        app_id: AppId::from(APP_ID),
        customer_id: CustomerId::from(customer_id),
        version: SchemaVersion::from("2026-06-27"),
        models: vec![Model {
            id: ModelId::from(model_id),
            kind: ModelKind::Entity,
            label: model_id.to_string(),
            fields,
            ..Default::default()
        }],
        custom_fields: vec![],
        change_types: vec![],
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

fn enum_field(id: &str) -> Field {
    Field {
        option_set: vec![EnumOption {
            id: EnumOptionId::from("active"),
            label: "Active".to_string(),
            aliases: vec!["current".to_string()],
            ..Default::default()
        }],
        ..field(id, FieldType::Enum, false, None)
    }
}

fn apply_request(
    customer_id: &str,
    idempotency_key: Option<&str>,
    writes: Vec<RowVersionWrite>,
) -> ApplyChangeSet {
    ApplyChangeSet {
        app_id: AppId::from(APP_ID),
        customer_id: CustomerId::from(customer_id),
        schema_revision_id: Some(SchemaRevisionId::new(1)),
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

fn record_write(values: BTreeMap<FieldId, FieldValue>) -> RowVersionWrite {
    RowVersionWrite {
        model_id: ModelId::from("record"),
        record_key: None,
        new_record_id: None,
        effective_start: date("2026-05-04"),
        values: Some(values),
        custom_fields: None,
        tombstones_record: false,
        provenance: None,
        ..Default::default()
    }
}

fn model_write(
    model_id: &str,
    external_key: &str,
    values: BTreeMap<FieldId, FieldValue>,
) -> RowVersionWrite {
    RowVersionWrite {
        model_id: ModelId::from(model_id),
        record_key: Some(RecordKey::ExternalKey(ExternalKey::from(external_key))),
        new_record_id: None,
        effective_start: date("2026-05-04"),
        values: Some(values),
        custom_fields: None,
        tombstones_record: false,
        provenance: None,
        ..Default::default()
    }
}

fn display_name(value: &str) -> BTreeMap<FieldId, FieldValue> {
    BTreeMap::from([(
        FieldId::from("display_name"),
        FieldValue::Text(value.to_string()),
    )])
}

fn raw_money_request(customer_id: &str, idempotency_key: &str, value: Value) -> Value {
    json!({
        "app_id": APP_ID,
        "customer_id": customer_id,
        "schema_revision_id": 1,
        "actor_id": "tester",
        "source_kind": "test",
        "idempotency_key": idempotency_key,
        "mode": "mainline",
        "writes": [{
            "model_id": "record",
            "record_key": null,
            "effective_start": "2026-05-04",
            "values": {
                "rate": {"type": "money_rate", "value": value}
            },
            "tombstones_record": false
        }]
    })
}

fn assert_column_type(
    client: &mut Client,
    table_name: &str,
    column_name: &str,
    data_type: &str,
    udt_name: &str,
) {
    let row = client
        .query_one(
            "select data_type, udt_name from information_schema.columns where table_schema = current_schema() and table_name = $1 and column_name = $2",
            &[&table_name, &column_name],
        )
        .expect("read generated column type");
    assert_eq!(row.get::<_, String>("data_type"), data_type);
    assert_eq!(row.get::<_, String>("udt_name"), udt_name);
}

fn date(value: &str) -> NaiveDate {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").expect("valid parity test date")
}
