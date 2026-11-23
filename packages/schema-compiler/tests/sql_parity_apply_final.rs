use std::collections::BTreeMap;
use std::env;
use std::thread;
use support::trusted_human;

use chrono::NaiveDate;
use kernel::testing::{call_generated_sql, DbError, GeneratedSqlFunction};
use kernel::{
    connect_postgres, AppId, AppliedChangeSet, ApplyChangeSet, ApplyMode, CustomFieldDefinition,
    CustomFieldDefinitionId, CustomFieldEntry, CustomFieldType, CustomFieldValue, CustomerId,
    ExternalKey, Field, FieldId, FieldType, FieldValue, KernelError, Model, ModelId, ModelKind,
    MoneyRatePeriod, MoneyRateValue, RecordId, RecordKey, RowVersionWrite, Schema, SchemaVersion,
};
use postgres::error::SqlState;
use postgres::Client;
use rust_decimal::Decimal;
use schema_compiler::{
    compile_sql_artifact_manifest, render_sql_artifact_bundle, CompiledManifest,
    NormalizedManifestExtras,
};
use uuid::Uuid;

mod support;

const APP_ID: &str = "core_app";

struct TestDatabase {
    client: Client,
    database_url: String,
    schema_name: String,
}

impl TestDatabase {
    fn connect(schema: Schema) -> Option<Self> {
        let database_url = match env::var("KERNEL_TEST_DATABASE_URL") {
            Ok(url) => url,
            Err(env::VarError::NotPresent) => {
                eprintln!(
                    "skipping generated SQL final apply parity test: KERNEL_TEST_DATABASE_URL is absent"
                );
                return None;
            }
            Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
        };
        let mut client = connect_postgres(&database_url).expect("connect to PostgreSQL");
        let schema_name = format!("kernel_apply_final_{}", Uuid::new_v4().simple());
        client
            .batch_execute(&format!(
                "create schema \"{schema_name}\"; set search_path to \"{schema_name}\""
            ))
            .expect("create isolated generated SQL final apply schema");

        let compiled = compiled_manifest(schema.clone());
        let manifest =
            compile_sql_artifact_manifest(&compiled).expect("compile generated SQL artifacts");
        trusted_human::before_install(&mut client);
        client
            .batch_execute(&render_sql_artifact_bundle(&manifest))
            .unwrap_or_else(|error| panic!("install generated SQL final apply bundle: {error}"));

        let mut database = Self {
            client,
            database_url,
            schema_name,
        };
        database.activate_schema(&schema);
        Some(database)
    }

    fn activate_schema(&mut self, schema: &Schema) -> i64 {
        trusted_human::bind(
            &mut self.client,
            schema.app_id.as_str(),
            schema.customer_id.as_str(),
            "tester",
        );
        self.client
            .execute(
                "update schema_revision set activated_at = null where app_id = $1 and customer_id = $2 and activated_at is not null",
                &[&schema.app_id.as_str(), &schema.customer_id.as_str()],
            )
            .expect("deactivate prior generated SQL schema revision");
        self.client
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
                    &serde_json::to_value(schema).expect("serialize generated SQL schema"),
                ],
            )
            .expect("activate generated SQL schema revision")
            .get("id")
    }

    fn apply(&mut self, request: &ApplyChangeSet) -> Result<AppliedChangeSet, KernelError> {
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
fn unique_field_indexes_enforce_live_mainline_values_match_generated_sql() {
    let customer_id = "customer_unique";
    let Some(mut database) = TestDatabase::connect(unique_ref_schema(customer_id)) else {
        return;
    };

    let indexes = database
        .client
        .query(
            r#"
            select i.relname, ix.indisunique, pg_get_expr(ix.indpred, ix.indrelid) as predicate
            from pg_index ix
            join pg_class i on i.oid = ix.indexrelid
            where i.relname = 'employee_version_ref_live_unique_idx'
              and ix.indrelid = 'employee_version'::regclass
            "#,
            &[],
        )
        .expect("read generated live unique index");
    assert_eq!(indexes.len(), 1);
    assert!(indexes[0].get::<_, bool>("indisunique"));
    assert_eq!(
        indexes[0].get::<_, String>("predicate"),
        "((stage = 'mainline'::text) AND (effective_end IS NULL) AND (ref IS NOT NULL))"
    );

    database
        .apply(&mainline_apply(
            customer_id,
            Some("unique_a"),
            vec![employee_write(
                "employee_a",
                "2026-01-01",
                Some(ref_values(Some("EMP-1"), "Alice")),
                false,
            )],
        ))
        .expect("apply first unique value");
    let duplicate = database
        .apply(&mainline_apply(
            customer_id,
            Some("unique_b"),
            vec![employee_write(
                "employee_b",
                "2026-01-01",
                Some(ref_values(Some("EMP-1"), "Bob")),
                false,
            )],
        ))
        .expect_err("reject duplicate unique value");
    assert_eq!(
        duplicate.into_envelope(),
        KernelError::from(DbError::UniqueFieldConflict {
            model: "employee".to_string(),
            field: "ref".to_string(),
            value: "EMP-1".to_string(),
        })
        .into_envelope()
    );

    database
        .apply(&mainline_apply(
            customer_id,
            Some("unique_same_record"),
            vec![employee_write(
                "employee_a",
                "2026-01-01",
                Some(ref_values(Some("EMP-1"), "Alice Updated")),
                false,
            )],
        ))
        .expect("reuse unique value on the same record");
    let counts = database
        .client
        .query_one(
            r#"
            select
              count(*) filter (where effective_end is null) as live_count,
              count(*) filter (where effective_start = date '2026-01-01') as retained_count
            from employee_version
            where stage = 'mainline'
              and record_id = (select id from employee_record where external_key = 'employee_a')
            "#,
            &[],
        )
        .expect("read retained unique versions");
    assert_eq!(counts.get::<_, i64>("live_count"), 1);
    assert_eq!(counts.get::<_, i64>("retained_count"), 2);

    for (key, employee) in [
        ("unique_null_a", "employee_c"),
        ("unique_null_b", "employee_d"),
    ] {
        database
            .apply(&mainline_apply(
                customer_id,
                Some(key),
                vec![employee_write(
                    employee,
                    "2026-01-01",
                    Some(ref_values(None, employee)),
                    false,
                )],
            ))
            .expect("allow multiple omitted unique values");
    }
}

#[test]
fn numeric_unique_field_precheck_uses_typed_comparison_match_generated_sql() {
    let customer_id = "customer_numeric_unique";
    let Some(mut database) = TestDatabase::connect(unique_score_schema(customer_id)) else {
        return;
    };
    database
        .apply(&mainline_apply(
            customer_id,
            Some("numeric_unique_a"),
            vec![employee_write(
                "employee_a",
                "2026-01-01",
                Some(score_values(42, "Alice")),
                false,
            )],
        ))
        .expect("apply first numeric unique value");
    let duplicate = database
        .apply(&mainline_apply(
            customer_id,
            Some("numeric_unique_b"),
            vec![employee_write(
                "employee_b",
                "2026-01-01",
                Some(score_values(42, "Bob")),
                false,
            )],
        ))
        .expect_err("reject duplicate numeric unique value");
    assert_eq!(
        duplicate.into_envelope(),
        KernelError::from(DbError::UniqueFieldConflict {
            model: "employee".to_string(),
            field: "score".to_string(),
            value: "42".to_string(),
        })
        .into_envelope()
    );
}

#[test]
fn unique_field_value_is_reusable_after_tombstone_match_generated_sql() {
    let customer_id = "customer_tombstone_unique";
    let Some(mut database) = TestDatabase::connect(unique_ref_schema(customer_id)) else {
        return;
    };
    database
        .apply(&mainline_apply(
            customer_id,
            Some("tombstone_unique_a"),
            vec![employee_write(
                "employee_a",
                "2026-01-01",
                Some(ref_values(Some("EMP-1"), "Alice")),
                false,
            )],
        ))
        .expect("apply unique value before tombstone");
    database
        .apply(&mainline_apply(
            customer_id,
            Some("tombstone_unique_a_delete"),
            vec![employee_write("employee_a", "2026-02-01", None, true)],
        ))
        .expect("tombstone unique value owner");
    database
        .apply(&mainline_apply(
            customer_id,
            Some("tombstone_unique_b"),
            vec![employee_write(
                "employee_b",
                "2026-03-01",
                Some(ref_values(Some("EMP-1"), "Bob")),
                false,
            )],
        ))
        .expect("reuse unique value after tombstone");
}

#[test]
fn mainline_apply_retains_distinct_same_day_values_in_applied_order_match_generated_sql() {
    let customer_id = "customer_same_day_values";
    let Some(mut database) = TestDatabase::connect(test_schema(customer_id)) else {
        return;
    };
    let first = database
        .apply(&company_apply(
            customer_id,
            "same-day-first",
            "2026-05-01",
            Some("Acme"),
            false,
        ))
        .expect("apply first same-day value");
    let second = database
        .apply(&company_apply(
            customer_id,
            "same-day-second",
            "2026-05-01",
            Some("Acme Updated"),
            false,
        ))
        .expect("apply second same-day value");

    let rows = same_day_rows(&mut database.client, customer_id);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].get::<_, String>("name"), "Acme");
    assert_eq!(
        rows[0].get::<_, Option<NaiveDate>>("effective_end"),
        Some(date("2026-05-01"))
    );
    assert_eq!(rows[1].get::<_, String>("name"), "Acme Updated");
    assert_eq!(rows[1].get::<_, Option<NaiveDate>>("effective_end"), None);
    assert!(rows[0].get::<_, i64>("applied_order") < rows[1].get::<_, i64>("applied_order"));
    assert_eq!(rows[0].get::<_, i64>("change_set_id"), first.id);
    assert_eq!(rows[1].get::<_, i64>("change_set_id"), second.id);

    let duplicate = database
        .client
        .execute(
            r#"
            insert into company_version (
              id, record_id, app_id, customer_id, stage, effective_start,
              change_set_id, applied_at, name
            )
            select $1, record_id, app_id, customer_id, 'mainline', effective_start,
                   change_set_id, now(), 'duplicate'
            from company_version where change_set_id = $2
            "#,
            &[&Uuid::new_v4(), &first.id],
        )
        .expect_err("same change set cannot own duplicate same-day versions");
    assert_eq!(duplicate.code(), Some(&SqlState::UNIQUE_VIOLATION));
}

#[test]
fn later_date_write_closes_applied_order_winner_when_timestamps_are_inverted_match_generated_sql() {
    let customer_id = "customer_same_day_inverted_timestamps";
    let Some(mut database) = TestDatabase::connect(test_schema(customer_id)) else {
        return;
    };
    let first = database
        .apply(&company_apply(
            customer_id,
            "inverted-first",
            "2026-05-01",
            Some("Acme First"),
            false,
        ))
        .expect("apply first same-day value");
    let winner = database
        .apply(&company_apply(
            customer_id,
            "inverted-winner",
            "2026-05-01",
            Some("Acme Winner"),
            false,
        ))
        .expect("apply same-day winner");
    database
        .client
        .execute(
            r#"
            update company_version
            set created_at = case change_set_id
              when $1 then timestamptz '2026-05-02 00:00:00+00'
              when $2 then timestamptz '2026-05-01 00:00:00+00'
            end
            where change_set_id = any($3)
            "#,
            &[&first.id, &winner.id, &vec![first.id, winner.id]],
        )
        .expect("invert generated version timestamps");
    let later = database
        .apply(&company_apply(
            customer_id,
            "inverted-later",
            "2026-06-01",
            Some("Acme Later"),
            false,
        ))
        .expect("apply later-date value");

    let rows = database
        .client
        .query(
            r#"
            select v.change_set_id, v.effective_end
            from company_version v
            join change_set cs on cs.id = v.change_set_id and cs.app_id = v.app_id and cs.customer_id = v.customer_id
            where v.app_id = $1 and v.customer_id = $2
            order by cs.applied_order
            "#,
            &[&APP_ID, &customer_id],
        )
        .expect("read inverted timestamp versions");
    assert_eq!(rows.len(), 3);
    assert_eq!(
        (
            rows[0].get::<_, i64>(0),
            rows[0].get::<_, Option<NaiveDate>>(1)
        ),
        (first.id, Some(date("2026-05-01")))
    );
    assert_eq!(
        (
            rows[1].get::<_, i64>(0),
            rows[1].get::<_, Option<NaiveDate>>(1)
        ),
        (winner.id, Some(date("2026-05-31")))
    );
    assert_eq!(
        (
            rows[2].get::<_, i64>(0),
            rows[2].get::<_, Option<NaiveDate>>(1)
        ),
        (later.id, None)
    );
}

#[test]
fn same_day_partial_write_inherits_declared_and_custom_snapshot_fields_match_generated_sql() {
    let customer_id = "customer_same_day_overlay";
    let Some(mut database) = TestDatabase::connect(custom_fields_schema(customer_id)) else {
        return;
    };
    seed_company(&mut database, customer_id);
    database
        .apply(&mainline_apply(
            customer_id,
            Some("overlay-base"),
            vec![employee_snapshot_write(
                "2026-05-01",
                "Alice",
                "Original",
                Some(42),
            )],
        ))
        .expect("apply employee snapshot");
    let update = database
        .apply(&mainline_apply(
            customer_id,
            Some("overlay-update"),
            vec![RowVersionWrite {
                model_id: ModelId::from("employee"),
                record_key: Some(external_key("alice")),
                new_record_id: None,
                effective_start: date("2026-05-01"),
                values: Some(text_values("Alice Updated")),
                custom_fields: Some(vec![custom_field_entry(
                    "nickname",
                    CustomFieldValue::Text("Updated".to_string()),
                )]),
                tombstones_record: false,
                provenance: None,
                ..Default::default()
            }],
        ))
        .expect("apply same-day partial employee snapshot");
    assert_employee_snapshot(&mut database.client, update.id, "2026-05-01");
}

#[test]
fn later_write_in_one_change_set_inherits_the_earlier_planned_snapshot_match_generated_sql() {
    let customer_id = "customer_planned_snapshot_overlay";
    let Some(mut database) = TestDatabase::connect(custom_fields_schema(customer_id)) else {
        return;
    };
    seed_company(&mut database, customer_id);
    let later_partial = RowVersionWrite {
        model_id: ModelId::from("employee"),
        record_key: Some(external_key("alice")),
        new_record_id: None,
        effective_start: date("2026-06-01"),
        values: Some(text_values("Alice Updated")),
        custom_fields: Some(vec![custom_field_entry(
            "nickname",
            CustomFieldValue::Text("Updated".to_string()),
        )]),
        tombstones_record: false,
        provenance: None,
        ..Default::default()
    };
    let applied = database
        .apply(&mainline_apply(
            customer_id,
            Some("planned-snapshot-writes"),
            vec![
                later_partial,
                employee_snapshot_write("2026-05-01", "Alice", "Original", Some(42)),
            ],
        ))
        .expect("apply reverse-authored planned snapshots");
    assert_employee_snapshot(&mut database.client, applied.id, "2026-06-01");
}

#[test]
fn same_day_successor_inherits_the_next_effective_date_boundary_match_generated_sql() {
    let customer_id = "customer_same_day_boundary";
    let Some(mut database) = TestDatabase::connect(test_schema(customer_id)) else {
        return;
    };
    database
        .apply(&company_apply(
            customer_id,
            "boundary-base",
            "2026-05-01",
            Some("Acme"),
            false,
        ))
        .unwrap();
    database
        .apply(&company_apply(
            customer_id,
            "boundary-future",
            "2026-07-01",
            Some("Acme Future"),
            false,
        ))
        .unwrap();
    let successor = database
        .apply(&company_apply(
            customer_id,
            "boundary-successor",
            "2026-05-01",
            Some("Acme Corrected"),
            false,
        ))
        .unwrap();

    let rows = database.client.query(
        r#"
        select v.change_set_id, v.effective_end
        from company_version v
        join change_set cs on cs.id=v.change_set_id and cs.app_id=v.app_id and cs.customer_id=v.customer_id
        where v.app_id=$1 and v.customer_id=$2 and v.effective_start=date '2026-05-01'
        order by cs.applied_order
        "#,
        &[&APP_ID, &customer_id],
    ).expect("read inherited successor boundaries");
    assert_eq!(rows.len(), 2);
    assert_eq!(
        rows[0].get::<_, Option<NaiveDate>>("effective_end"),
        Some(date("2026-05-01"))
    );
    assert_eq!(rows[1].get::<_, i64>("change_set_id"), successor.id);
    assert_eq!(
        rows[1].get::<_, Option<NaiveDate>>("effective_end"),
        Some(date("2026-06-30"))
    );
}

#[test]
fn mainline_apply_allows_value_and_tombstone_at_same_effective_start_match_generated_sql() {
    let customer_id = "customer_same_day_tombstone";
    let Some(mut database) = TestDatabase::connect(test_schema(customer_id)) else {
        return;
    };
    database
        .apply(&company_apply(
            customer_id,
            "same-day-value",
            "2026-05-01",
            Some("Acme"),
            false,
        ))
        .unwrap();
    database
        .apply(&company_apply(
            customer_id,
            "same-day-tombstone",
            "2026-05-01",
            None,
            true,
        ))
        .unwrap();

    let visible: bool = database.client.query_one(
        r#"
        select coalesce((
          select not v.tombstones_record
          from company_version v
          join change_set cs on cs.id=v.change_set_id and cs.app_id=v.app_id and cs.customer_id=v.customer_id
          join company_record r on r.id=v.record_id and r.app_id=v.app_id and r.customer_id=v.customer_id
          where v.app_id=$1 and v.customer_id=$2 and r.external_key='acme'
            and v.stage='mainline' and v.effective_start <= date '2026-05-01'
            and (v.effective_end is null or v.effective_end >= date '2026-05-01')
          order by v.effective_start desc, v.tombstones_record desc, v.untombstones_record desc, cs.applied_order desc, v.id desc
          limit 1
        ), false)
        "#,
        &[&APP_ID, &customer_id],
    ).expect("read same-day lifecycle winner").get(0);
    assert!(!visible);
}

#[test]
fn mainline_apply_replays_idempotent_request_after_schema_activation_changes_match_generated_sql() {
    let customer_id = "customer_schema_activation_replay";
    let schema = test_schema(customer_id);
    let Some(mut database) = TestDatabase::connect(schema.clone()) else {
        return;
    };
    let request = company_apply(
        customer_id,
        "before-schema-change",
        "2026-05-01",
        Some("Acme"),
        false,
    );
    let first = database
        .apply(&request)
        .expect("apply before schema activation change");
    let mut next_schema = schema;
    next_schema.version = SchemaVersion::from("2026-06-01");
    next_schema.models[0].label = "Company V2".to_string();
    database.activate_schema(&next_schema);

    let database_url = database.database_url.clone();
    let schema_name = database.schema_name.clone();
    let replay_request = request.clone();
    let mut lock = database
        .client
        .transaction()
        .expect("start schema activation lock");
    let lock_name = format!(
        "postgres-schema:{schema_name}:materialize-tenant:{APP_ID}:{customer_id}:schema-activation"
    );
    lock.query_one(
        "select pg_advisory_xact_lock(hashtext($1)::bigint)",
        &[&lock_name],
    )
    .expect("hold schema activation lock");
    let replay = thread::spawn(move || {
        let mut client = connect_postgres(&database_url).expect("connect replay client");
        client
            .batch_execute(&format!(
                "set search_path to \"{schema_name}\"; set statement_timeout = '2s'"
            ))
            .expect("configure replay client");
        trusted_human::select(&mut client, "tester");
        call_generated_sql(
            &mut client,
            GeneratedSqlFunction::ApplyChangeSet,
            &replay_request,
        )
    });
    let second = replay
        .join()
        .expect("join schema replay")
        .expect("idempotent replay bypasses schema activation lock");
    lock.rollback().expect("release schema activation lock");
    assert_eq!(first, second);
}

#[test]
fn mainline_apply_rejects_missing_and_cross_tenant_relation_targets_match_generated_sql() {
    let customer_a = "customer_relation_a";
    let customer_b = "customer_relation_b";
    let Some(mut database) = TestDatabase::connect(test_schema(customer_a)) else {
        return;
    };
    database.activate_schema(&test_schema(customer_b));
    database
        .apply(&company_apply(
            customer_b,
            "company-b",
            "2026-05-01",
            Some("Acme B"),
            false,
        ))
        .unwrap();

    let missing = database
        .apply(&mainline_apply(
            customer_a,
            Some("employee-missing-relation"),
            vec![employee_write_with_employer(
                "alice",
                "2026-05-01",
                "Alice",
                "acme",
            )],
        ))
        .expect_err("cross-tenant relation must not resolve");
    assert_eq!(
        missing.into_envelope(),
        KernelError::from(DbError::RecordTargetMissing {
            details: "record key `ExternalKey(ExternalKey(\"acme\"))` did not resolve".to_string(),
        })
        .into_envelope()
    );

    database
        .apply(&company_apply_for_key(
            customer_a,
            "future-company",
            "future",
            "2026-06-01",
            Some("Future"),
            false,
        ))
        .unwrap();
    let future_record_id: RecordId = database.client.query_one(
        "select id from company_record where app_id=$1 and customer_id=$2 and external_key='future'",
        &[&APP_ID, &customer_a],
    ).expect("read future relation target id").get(0);
    let future = database
        .apply(&mainline_apply(
            customer_a,
            Some("employee-future-relation"),
            vec![employee_write_with_employer(
                "bob",
                "2026-05-01",
                "Bob",
                "future",
            )],
        ))
        .expect_err("future relation target must not resolve as of write date");
    assert_eq!(
        future.into_envelope(),
        KernelError::from(DbError::RecordTargetMissing {
            details: format!("record `{future_record_id}` is not visible as of 2026-05-01"),
        })
        .into_envelope()
    );
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

fn test_schema(customer_id: &str) -> Schema {
    Schema {
        app_id: AppId::from(APP_ID),
        customer_id: CustomerId::from(customer_id),
        version: SchemaVersion::from("2026-05-04"),
        models: vec![
            Model {
                id: ModelId::from("company"),
                kind: ModelKind::Entity,
                label: "Company".to_string(),
                fields: vec![field("name", FieldType::Text, true, false, None)],
                ..Default::default()
            },
            Model {
                id: ModelId::from("employee"),
                kind: ModelKind::Entity,
                label: "Employee".to_string(),
                fields: vec![
                    field("name", FieldType::Text, true, false, None),
                    field(
                        "employer",
                        FieldType::Relation,
                        false,
                        false,
                        Some("company"),
                    ),
                    field("comp_rate", FieldType::MoneyRate, false, false, None),
                ],
                ..Default::default()
            },
        ],
        custom_fields: vec![],
        change_types: vec![],
    }
}

fn unique_ref_schema(customer_id: &str) -> Schema {
    Schema {
        app_id: AppId::from(APP_ID),
        customer_id: CustomerId::from(customer_id),
        version: SchemaVersion::from("2026-06-20"),
        models: vec![Model {
            id: ModelId::from("employee"),
            kind: ModelKind::Entity,
            label: "Employee".to_string(),
            fields: vec![
                field("ref", FieldType::Text, false, true, None),
                field("name", FieldType::Text, true, false, None),
            ],
            ..Default::default()
        }],
        custom_fields: vec![],
        change_types: vec![],
    }
}

fn unique_score_schema(customer_id: &str) -> Schema {
    let mut schema = unique_ref_schema(customer_id);
    schema.models[0].fields[0] = field("score", FieldType::Number, false, true, None);
    schema
}

fn custom_fields_schema(customer_id: &str) -> Schema {
    let mut schema = test_schema(customer_id);
    schema
        .models
        .iter_mut()
        .find(|model| model.id == ModelId::from("employee"))
        .expect("employee model")
        .extensions
        .typed_custom_fields = true;
    schema.custom_fields = vec![
        CustomFieldDefinition {
            id: CustomFieldDefinitionId::from("employee_nickname"),
            model_id: ModelId::from("employee"),
            field_id: FieldId::from("nickname"),
            label: "nickname".to_string(),
            field_type: CustomFieldType::Text,
            target_model_id: None,
            option_set: vec![],
            archived_at: None,
            ..Default::default()
        },
        CustomFieldDefinition {
            id: CustomFieldDefinitionId::from("employee_score"),
            model_id: ModelId::from("employee"),
            field_id: FieldId::from("score"),
            label: "score".to_string(),
            field_type: CustomFieldType::Number,
            target_model_id: None,
            option_set: vec![],
            archived_at: None,
            ..Default::default()
        },
    ];
    schema
}

fn field(
    id: &str,
    field_type: FieldType,
    required: bool,
    is_unique: bool,
    target: Option<&str>,
) -> Field {
    Field {
        id: FieldId::from(id),
        label: id.to_string(),
        field_type,
        required,
        is_unique,
        target_model: target.map(ModelId::from),
        option_set: vec![],
        ..Default::default()
    }
}

fn date(value: &str) -> NaiveDate {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").expect("valid fixture date")
}

fn external_key(value: &str) -> RecordKey {
    RecordKey::ExternalKey(ExternalKey::from(value))
}

fn text_values(name: &str) -> BTreeMap<FieldId, FieldValue> {
    BTreeMap::from([(FieldId::from("name"), FieldValue::Text(name.to_string()))])
}

fn ref_values(value: Option<&str>, name: &str) -> BTreeMap<FieldId, FieldValue> {
    let mut values = text_values(name);
    if let Some(value) = value {
        values.insert(FieldId::from("ref"), FieldValue::Text(value.to_string()));
    }
    values
}

fn score_values(value: i64, name: &str) -> BTreeMap<FieldId, FieldValue> {
    let mut values = text_values(name);
    values.insert(
        FieldId::from("score"),
        FieldValue::Number(Decimal::new(value, 0)),
    );
    values
}

fn employee_write(
    key: &str,
    effective_start: &str,
    values: Option<BTreeMap<FieldId, FieldValue>>,
    tombstones_record: bool,
) -> RowVersionWrite {
    RowVersionWrite {
        model_id: ModelId::from("employee"),
        record_key: Some(external_key(key)),
        new_record_id: None,
        effective_start: date(effective_start),
        values,
        custom_fields: None,
        tombstones_record,
        provenance: None,
        ..Default::default()
    }
}

fn employee_write_with_employer(
    key: &str,
    start: &str,
    name: &str,
    employer: &str,
) -> RowVersionWrite {
    RowVersionWrite {
        values: Some(employee_values(name, external_key(employer))),
        ..employee_write(key, start, None, false)
    }
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

fn custom_field_entry(field_id: &str, value: CustomFieldValue) -> CustomFieldEntry {
    CustomFieldEntry {
        field_id: FieldId::from(field_id),
        value,
    }
}

fn employee_snapshot_write(
    start: &str,
    name: &str,
    nickname: &str,
    score: Option<i64>,
) -> RowVersionWrite {
    let mut values = employee_values("Alice", external_key("acme"));
    values.insert(FieldId::from("name"), FieldValue::Text(name.to_string()));
    let mut custom_fields = vec![custom_field_entry(
        "nickname",
        CustomFieldValue::Text(nickname.to_string()),
    )];
    if let Some(score) = score {
        custom_fields.push(custom_field_entry(
            "score",
            CustomFieldValue::Number(Decimal::new(score, 0)),
        ));
    }
    RowVersionWrite {
        model_id: ModelId::from("employee"),
        record_key: Some(external_key("alice")),
        new_record_id: None,
        effective_start: date(start),
        values: Some(values),
        custom_fields: Some(custom_fields),
        tombstones_record: false,
        provenance: None,
        ..Default::default()
    }
}

fn mainline_apply(
    customer_id: &str,
    key: Option<&str>,
    writes: Vec<RowVersionWrite>,
) -> ApplyChangeSet {
    ApplyChangeSet {
        app_id: AppId::from(APP_ID),
        customer_id: CustomerId::from(customer_id),
        schema_revision_id: None,
        actor_id: Some("tester".to_string()),
        source_kind: "test".to_string(),
        source_ref: None,
        idempotency_key: key.map(str::to_string),
        change_type_id: None,
        notes: None,
        mode: ApplyMode::Mainline,
        writes,
    }
}

fn company_apply(
    customer_id: &str,
    key: &str,
    effective_start: &str,
    name: Option<&str>,
    tombstones_record: bool,
) -> ApplyChangeSet {
    company_apply_for_key(
        customer_id,
        key,
        "acme",
        effective_start,
        name,
        tombstones_record,
    )
}

fn company_apply_for_key(
    customer_id: &str,
    key: &str,
    record_key: &str,
    effective_start: &str,
    name: Option<&str>,
    tombstones_record: bool,
) -> ApplyChangeSet {
    mainline_apply(
        customer_id,
        Some(key),
        vec![RowVersionWrite {
            model_id: ModelId::from("company"),
            record_key: Some(external_key(record_key)),
            new_record_id: None,
            effective_start: date(effective_start),
            values: name.map(text_values),
            custom_fields: None,
            tombstones_record,
            provenance: None,
            ..Default::default()
        }],
    )
}

fn seed_company(database: &mut TestDatabase, customer_id: &str) {
    database
        .apply(&company_apply(
            customer_id,
            "seed-company",
            "2026-05-01",
            Some("Acme"),
            false,
        ))
        .expect("seed generated SQL company");
}

fn assert_employee_snapshot(client: &mut Client, change_set_id: i64, effective_start: &str) {
    let row = client
        .query_one(
            r#"
            select name, employer, comp_rate_amount::text as comp_rate_amount, custom_fields
            from employee_version
            where change_set_id=$1 and effective_start=$2
            "#,
            &[&change_set_id, &date(effective_start)],
        )
        .expect("read generated SQL employee snapshot");
    assert_eq!(row.get::<_, String>("name"), "Alice Updated");
    assert!(row.get::<_, Option<RecordId>>("employer").is_some());
    assert_eq!(
        row.get::<_, Option<String>>("comp_rate_amount").as_deref(),
        Some("125.00")
    );
    let custom_fields: Vec<CustomFieldEntry> =
        serde_json::from_value(row.get("custom_fields")).expect("decode generated custom fields");
    assert_eq!(
        custom_fields
            .iter()
            .find(|entry| entry.field_id == FieldId::from("nickname"))
            .map(|entry| &entry.value),
        Some(&CustomFieldValue::Text("Updated".to_string()))
    );
    assert_eq!(
        custom_fields
            .iter()
            .find(|entry| entry.field_id == FieldId::from("score"))
            .map(|entry| &entry.value),
        Some(&CustomFieldValue::Number(Decimal::new(42, 0)))
    );
}

fn same_day_rows(client: &mut Client, customer_id: &str) -> Vec<postgres::Row> {
    client
        .query(
            r#"
            select v.name, v.effective_end, cs.id as change_set_id, cs.applied_order
            from company_version v
            join company_record r on r.id=v.record_id and r.app_id=v.app_id and r.customer_id=v.customer_id
            join change_set cs on cs.id=v.change_set_id and cs.app_id=v.app_id and cs.customer_id=v.customer_id
            where v.app_id=$1 and v.customer_id=$2 and r.external_key='acme'
              and v.effective_start=date '2026-05-01'
              and not v.tombstones_record and not v.untombstones_record
            order by cs.applied_order
            "#,
            &[&APP_ID, &customer_id],
        )
        .expect("read same-day generated SQL versions")
}
