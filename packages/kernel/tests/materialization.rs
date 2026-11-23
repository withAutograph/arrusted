use chrono::{DateTime, NaiveDate, Utc};
use kernel::testing::{
    apply_change_set, apply_change_set_in_transaction, approve_draft_change_set,
    begin_tenant_transaction, change_set_diff, commit_enum_option_set_revision,
    discard_draft_change_set, field_history, list_draft_change_sets, materialize_schema,
    materialize_schema_with_provenance, preflight_schema_materialization, query_visible_sql,
    read_draft_change_set, read_visible_records, recent_activity,
    reconcile_schema_materialization_policies, revert_change_set, schema_hash,
    schema_revision_is_active_with_materialized_tables, update_draft_notes,
    validate_change_set_dry_run, validate_change_sets_dry_run, DbError,
};
use kernel::{
    materialize_schema_with_provenance_guarded, preflight_schema_materialization_guarded, AppId,
    ApplyChangeSet, ApplyMode, ChangeSetDiffRequest, ChangeSetStatus, ChangeType, ChangeTypeId,
    CommitEnumOptionSetRevision, CustomFieldDefinition, CustomFieldDefinitionId, CustomFieldDiff,
    CustomFieldEntry, CustomFieldType, CustomFieldValue, CustomerId, EnumOption, EnumOptionId,
    EnumOptionSetTarget, ExternalKey, Field, FieldHistoryRequest, FieldId, FieldType, FieldValue,
    Model, ModelId, ModelKind, MoneyRatePeriod, MoneyRateValue, QueryVisibleSql,
    RecentActivityRequest, RecordId, RecordKey, RevertChangeSet, RowVersionWrite, Schema,
    SchemaElementLifecycle, SchemaRevisionId, SchemaRevisionProvenance, SchemaVersion, SqlParam,
    VersionStage,
};
use postgres::fallible_iterator::FallibleIterator;
use postgres::{Client, NoTls};
use rust_decimal::Decimal;
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Barrier};
use std::thread;
use std::time::{Duration as StdDuration, Instant, SystemTime, UNIX_EPOCH};

mod support;

use support::parity_scenarios::explicit_new_subject_mainline_uses_exact_uuid_and_resolves_reverse_order_relation as assert_explicit_new_subject_mainline;
use support::rust_backend::RustKernelBackend;

static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

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
            },
            Model {
                id: ModelId::from("employee"),
                kind: ModelKind::Entity,
                label: "Employee".to_string(),
                fields: vec![
                    Field {
                        id: FieldId::from("name"),
                        label: "Name".to_string(),
                        field_type: FieldType::Text,
                        required: true,
                        is_unique: false,
                        target_model: None,
                        option_set: vec![],

                        ..Default::default()
                    },
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

fn single_model_schema(customer_id: &str, model_id: &str) -> Schema {
    single_model_schema_with_version(customer_id, model_id, "2026-05-04")
}

fn single_model_schema_with_version(customer_id: &str, model_id: &str, version: &str) -> Schema {
    Schema {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from(customer_id),
        version: SchemaVersion::from(version),
        models: vec![Model {
            id: ModelId::from(model_id),
            kind: ModelKind::Entity,
            label: model_id.to_string(),
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

fn unique_ref_schema(customer_id: &str) -> Schema {
    Schema {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from(customer_id),
        version: SchemaVersion::from("2026-06-20"),
        models: vec![Model {
            id: ModelId::from("employee"),
            kind: ModelKind::Entity,
            label: "Employee".to_string(),
            fields: vec![
                Field {
                    id: FieldId::from("ref"),
                    label: "Ref".to_string(),
                    field_type: FieldType::Text,
                    required: false,
                    is_unique: true,
                    target_model: None,
                    option_set: vec![],

                    ..Default::default()
                },
                Field {
                    id: FieldId::from("name"),
                    label: "Name".to_string(),
                    field_type: FieldType::Text,
                    required: true,
                    is_unique: false,
                    target_model: None,
                    option_set: vec![],

                    ..Default::default()
                },
            ],

            ..Default::default()
        }],
        custom_fields: vec![],
        change_types: vec![],
    }
}

fn unique_score_schema(customer_id: &str) -> Schema {
    let mut schema = unique_ref_schema(customer_id);
    let score = &mut schema.models[0].fields[0];
    score.id = FieldId::from("score");
    score.label = "Score".to_string();
    score.field_type = FieldType::Number;
    schema
}

fn custom_field_definition(
    id: &str,
    field_id: &str,
    field_type: CustomFieldType,
) -> CustomFieldDefinition {
    CustomFieldDefinition {
        id: CustomFieldDefinitionId::from(id),
        model_id: ModelId::from("employee"),
        field_id: FieldId::from(field_id),
        label: field_id.to_string(),
        field_type,
        target_model_id: None,
        option_set: vec![],
        archived_at: None,

        ..Default::default()
    }
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
        custom_field_definition("employee_nickname", "nickname", CustomFieldType::Text),
        custom_field_definition("employee_score", "score", CustomFieldType::Number),
        custom_field_definition("employee_remote", "remote", CustomFieldType::Bool),
        custom_field_definition("employee_start_date", "start_date", CustomFieldType::Date),
        custom_field_definition(
            "employee_reviewed_at",
            "reviewed_at",
            CustomFieldType::Datetime,
        ),
        CustomFieldDefinition {
            target_model_id: Some(ModelId::from("company")),
            ..custom_field_definition(
                "employee_home_company",
                "home_company",
                CustomFieldType::Relation,
            )
        },
        custom_field_definition("employee_skills", "skills", CustomFieldType::TextList),
        CustomFieldDefinition {
            option_set: vec![
                EnumOption {
                    id: EnumOptionId::from("small"),
                    label: "Small".to_string(),
                    aliases: vec![],

                    ..Default::default()
                },
                EnumOption {
                    id: EnumOptionId::from("large"),
                    label: "Large".to_string(),
                    aliases: vec![],

                    ..Default::default()
                },
            ],
            ..custom_field_definition("employee_shirt_size", "shirt_size", CustomFieldType::Enum)
        },
        custom_field_definition("employee_bonus", "bonus", CustomFieldType::MoneyRate),
        CustomFieldDefinition {
            archived_at: Some(
                DateTime::parse_from_rfc3339("2026-06-01T00:00:00Z")
                    .unwrap()
                    .with_timezone(&Utc),
            ),
            lifecycle: SchemaElementLifecycle::Retired,
            ..custom_field_definition("employee_old_code", "old_code", CustomFieldType::Text)
        },
    ];
    schema
}

fn custom_field_entry(field_id: &str, value: CustomFieldValue) -> CustomFieldEntry {
    CustomFieldEntry {
        field_id: FieldId::from(field_id),
        value,
    }
}

fn all_custom_field_entries(home_company: &str) -> Vec<CustomFieldEntry> {
    vec![
        custom_field_entry("nickname", CustomFieldValue::Text("Al".to_string())),
        custom_field_entry("score", CustomFieldValue::Number(Decimal::new(42, 0))),
        custom_field_entry("remote", CustomFieldValue::Bool(true)),
        custom_field_entry("start_date", CustomFieldValue::Date(date("2026-05-01"))),
        custom_field_entry(
            "reviewed_at",
            CustomFieldValue::Datetime(
                DateTime::parse_from_rfc3339("2026-05-01T12:34:56Z")
                    .unwrap()
                    .with_timezone(&Utc),
            ),
        ),
        custom_field_entry(
            "home_company",
            CustomFieldValue::Relation(RecordKey::ExternalKey(ExternalKey::from(home_company))),
        ),
        custom_field_entry(
            "skills",
            CustomFieldValue::TextList(vec!["rust".to_string(), "sql".to_string()]),
        ),
        custom_field_entry(
            "shirt_size",
            CustomFieldValue::Enum(EnumOptionId::from("large")),
        ),
        custom_field_entry(
            "bonus",
            CustomFieldValue::MoneyRate(MoneyRateValue {
                amount: Decimal::new(150000, 2),
                currency: "USD".to_string(),
                period: MoneyRatePeriod::Annual,
            }),
        ),
    ]
}

fn custom_value<'a>(
    entries: &'a [CustomFieldEntry],
    field_id: &str,
) -> Option<&'a CustomFieldValue> {
    entries
        .iter()
        .find(|entry| entry.field_id == FieldId::from(field_id))
        .map(|entry| &entry.value)
}

fn validation_codes(error: DbError) -> Vec<&'static str> {
    match error {
        DbError::Validation(error) => error.issues.into_iter().map(|issue| issue.code).collect(),
        error => panic!("expected validation error, got {error:?}"),
    }
}

fn declared_enum_schema(customer_id: &str) -> Schema {
    let mut schema = test_schema(customer_id);
    let employee = schema
        .models
        .iter_mut()
        .find(|model| model.id == ModelId::from("employee"))
        .expect("employee model exists");
    employee.fields.push(Field {
        id: FieldId::from("status"),
        label: "Status".to_string(),
        field_type: FieldType::Enum,
        required: false,
        is_unique: false,
        target_model: None,
        option_set: vec![
            EnumOption {
                id: EnumOptionId::from("active"),
                label: "Active".to_string(),
                aliases: vec!["current".to_string()],

                ..Default::default()
            },
            EnumOption {
                id: EnumOptionId::from("inactive"),
                label: "Inactive".to_string(),
                aliases: vec![],

                ..Default::default()
            },
        ],

        ..Default::default()
    });
    schema
}

struct TestDb {
    client: Client,
    schema_name: String,
    role_name: String,
}

impl TestDb {
    fn connect() -> Option<Self> {
        let database_url = env::var("PLATFORM_TEST_DATABASE_URL").ok()?;
        let mut client = Client::connect(&database_url, NoTls).unwrap_or_else(|error| {
            panic!("PLATFORM_TEST_DATABASE_URL is set but connection failed: {error}")
        });
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let process_id = std::process::id();
        let counter = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let schema_name = format!("platform_test_{suffix}_{process_id}_{counter}");
        let role_name = format!("platform_rls_{suffix}_{process_id}_{counter}");
        client
            .batch_execute(&format!(
                r#"
                create schema "{schema_name}";
                create role "{role_name}";
                set search_path to "{schema_name}";
                "#
            ))
            .unwrap();
        Some(Self {
            client,
            schema_name,
            role_name,
        })
    }

    fn connect_owned_by_non_bypass_role() -> Option<Self> {
        let database_url = env::var("PLATFORM_TEST_DATABASE_URL").ok()?;
        let mut client = Client::connect(&database_url, NoTls).unwrap_or_else(|error| {
            panic!("PLATFORM_TEST_DATABASE_URL is set but connection failed: {error}")
        });
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let process_id = std::process::id();
        let counter = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let schema_name = format!("platform_test_{suffix}_{process_id}_{counter}");
        let role_name = format!("platform_rls_{suffix}_{process_id}_{counter}");
        client
            .batch_execute(&format!(
                r#"
                do $$
                begin
                  perform pg_advisory_xact_lock(hashtext('kernel_query'));
                  if not exists (select 1 from pg_roles where rolname = 'kernel_query') then
                    create role kernel_query nologin;
                  end if;
                exception when duplicate_object then
                  null;
                end
                $$;
                create role "{role_name}";
                grant kernel_query to "{role_name}";
                create schema "{schema_name}" authorization "{role_name}";
                set search_path to "{schema_name}";
                set role "{role_name}";
                "#
            ))
            .unwrap();
        Some(Self {
            client,
            schema_name,
            role_name,
        })
    }

    fn grant_role_access(&mut self) {
        self.client
            .batch_execute(&format!(
                r#"
                grant usage on schema "{schema}" to "{role}";
                grant select, insert, update, delete on all tables in schema "{schema}" to "{role}";
                grant usage, select on all sequences in schema "{schema}" to "{role}";
                "#,
                schema = self.schema_name,
                role = self.role_name,
            ))
            .unwrap();
    }
}

fn connect_to_test_schema(schema_name: &str) -> Client {
    let database_url = env::var("PLATFORM_TEST_DATABASE_URL").unwrap();
    let mut client = Client::connect(&database_url, NoTls).unwrap_or_else(|error| {
        panic!("PLATFORM_TEST_DATABASE_URL is set but connection failed: {error}")
    });
    client
        .batch_execute(&format!(r#"set search_path to "{schema_name}";"#))
        .unwrap();
    client
}

fn wait_for_backend_lock(observer: &mut Client, pid: i32, query_fragment: &str, description: &str) {
    let deadline = Instant::now() + StdDuration::from_secs(2);
    loop {
        let activity = observer
            .query_opt(
                "select state, wait_event_type, wait_event, query from pg_stat_activity where pid = $1",
                &[&pid],
            )
            .unwrap();
        if activity.as_ref().is_some_and(|row| {
            row.get::<_, Option<String>>("wait_event_type").as_deref() == Some("Lock")
                && row.get::<_, String>("query").contains(query_fragment)
        }) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "{description} did not reach the expected lock wait: activity={activity:?}"
        );
        thread::sleep(StdDuration::from_millis(10));
    }
}

impl Drop for TestDb {
    fn drop(&mut self) {
        let _ = self.client.batch_execute("reset role;");
        let _ = self.client.batch_execute(&format!(
            r#"drop schema if exists "{}" cascade;"#,
            self.schema_name
        ));
        let _ = self
            .client
            .batch_execute(&format!(r#"drop role if exists "{}";"#, self.role_name));
    }
}

fn date(value: &str) -> NaiveDate {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").unwrap()
}

fn text_values(name: &str) -> BTreeMap<FieldId, FieldValue> {
    let mut values = BTreeMap::new();
    values.insert(FieldId::from("name"), FieldValue::Text(name.to_string()));
    values
}

fn ref_values(ref_value: Option<&str>, name: &str) -> BTreeMap<FieldId, FieldValue> {
    let mut values = text_values(name);
    if let Some(ref_value) = ref_value {
        values.insert(
            FieldId::from("ref"),
            FieldValue::Text(ref_value.to_string()),
        );
    }
    values
}

fn score_values(score: i64, name: &str) -> BTreeMap<FieldId, FieldValue> {
    let mut values = text_values(name);
    values.insert(
        FieldId::from("score"),
        FieldValue::Number(Decimal::new(score, 0)),
    );
    values
}

fn employee_write(
    external_key: &str,
    effective_start: &str,
    values: Option<BTreeMap<FieldId, FieldValue>>,
    tombstones_record: bool,
) -> RowVersionWrite {
    RowVersionWrite {
        model_id: ModelId::from("employee"),
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

fn employee_values(name: &str, employer: RecordKey) -> BTreeMap<FieldId, FieldValue> {
    let mut values = BTreeMap::new();
    values.insert(FieldId::from("name"), FieldValue::Text(name.to_string()));
    values.insert(FieldId::from("employer"), FieldValue::Relation(employer));
    values.insert(
        FieldId::from("comp_rate"),
        FieldValue::MoneyRate(MoneyRateValue {
            amount: Decimal::new(12500, 2),
            currency: "USD".to_string(),
            period: MoneyRatePeriod::Hourly,
        }),
    );
    values
}

fn mainline_apply(
    customer_id: &str,
    key: Option<&str>,
    writes: Vec<RowVersionWrite>,
) -> ApplyChangeSet {
    ApplyChangeSet {
        app_id: AppId::from("core_app"),
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

fn draft_apply(
    customer_id: &str,
    key: Option<&str>,
    writes: Vec<RowVersionWrite>,
) -> ApplyChangeSet {
    let mut apply = mainline_apply(customer_id, key, writes);
    apply.mode = ApplyMode::Draft;
    apply
}

fn explicit_new_write(
    model_id: &str,
    record_id: RecordId,
    values: BTreeMap<FieldId, FieldValue>,
) -> RowVersionWrite {
    RowVersionWrite {
        model_id: ModelId::from(model_id),
        new_record_id: Some(record_id),
        record_key: None,
        effective_start: date("2026-05-01"),
        values: Some(values),
        custom_fields: None,
        tombstones_record: false,
        provenance: None,
        ..Default::default()
    }
}

fn revert_request(customer_id: &str, change_set_id: i64, key: Option<&str>) -> RevertChangeSet {
    RevertChangeSet {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from(customer_id),
        change_set_id,
        actor_id: Some("tester".to_string()),
        idempotency_key: key.map(str::to_string),
        notes: None,
    }
}

#[test]
fn explicit_new_subject_mainline_uses_exact_uuid_and_resolves_reverse_order_relation() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let _legacy_fixture_constructor = explicit_new_write;
    let mut backend = RustKernelBackend::new(&mut db.client);
    assert_explicit_new_subject_mainline(&mut backend);
}

#[test]
fn explicit_new_subject_draft_ordering_approval_and_revert_preserve_exact_uuid() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let mut backend = RustKernelBackend::new(&mut db.client);
    support::parity_scenarios::explicit_new_subject_draft_ordering_approval_and_revert_preserve_exact_uuid(
        &mut backend,
    );
}

#[test]
fn explicit_new_subject_can_be_reused_after_draft_discard() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let mut backend = RustKernelBackend::new(&mut db.client);
    support::parity_scenarios::explicit_new_subject_can_be_reused_after_draft_discard(&mut backend);
}

#[test]
fn explicit_new_subject_rejects_uuid_collision_and_cross_tenant_relation() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let mut backend = RustKernelBackend::new(&mut db.client);
    support::parity_scenarios::explicit_new_subject_rejects_uuid_collision_and_cross_tenant_relation(
        &mut backend,
    );
}

#[test]
fn explicit_new_subject_planned_visibility_preserves_as_of_date() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let mut backend = RustKernelBackend::new(&mut db.client);
    support::parity_scenarios::explicit_new_subject_planned_visibility_preserves_as_of_date(
        &mut backend,
    );
}

fn sql_query(customer_id: &str, sql: &str, params: Vec<SqlParam>) -> QueryVisibleSql {
    QueryVisibleSql {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from(customer_id),
        as_of: None,
        sql: sql.to_string(),
        params,
        statement_timeout_ms: None,
    }
}

fn install_persisted_workbench_views(db: &mut TestDb, customer_id: &str, as_of: NaiveDate) {
    // Recreate the session residue that remains if workbench cleanup is
    // interrupted after its transaction commits.
    db.client
        .batch_execute(&format!(
            r#"
            create temp view change_set as
              select *
              from "{schema}".change_set
              where app_id = 'core_app' and customer_id = '{customer_id}';

            create temp view company_record as
              select *
              from "{schema}".company_record
              where app_id = 'core_app' and customer_id = '{customer_id}';

            create temp view company_version as
              select *
              from "{schema}".company_version
              where app_id = 'core_app'
                and customer_id = '{customer_id}'
                and effective_start <= date '{as_of}'
                and (effective_end is null or effective_end >= date '{as_of}')
              union all
              select *
              from "{schema}".company_version
              where false;
            "#,
            schema = db.schema_name,
        ))
        .unwrap();
}

#[test]
fn materialize_schema_is_idempotent_and_creates_row_version_tables() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_a");

    let first = materialize_schema(&mut db.client, &schema).unwrap();
    let second = materialize_schema(&mut db.client, &schema).unwrap();
    assert_eq!(first, second);
    assert!(schema_revision_is_active_with_materialized_tables(&mut db.client, &schema).unwrap());

    let table_count: i64 = db
        .client
        .query_one(
            "select count(*) from information_schema.tables where table_schema = current_schema() and table_name in ('schema_revision', 'change_set', 'agent_run', 'employee_record', 'employee_version', 'company_record', 'company_version')",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(table_count, 7);

    let money_columns: Vec<String> = db
        .client
        .query(
            "select column_name from information_schema.columns where table_schema = current_schema() and table_name = 'employee_version' and column_name like 'comp_rate_%' order by column_name",
            &[],
        )
        .unwrap()
        .into_iter()
        .map(|row| row.get(0))
        .collect();
    assert_eq!(
        money_columns,
        vec!["comp_rate_amount", "comp_rate_currency", "comp_rate_period"]
    );

    let change_set_note_columns: Vec<String> = db
        .client
        .query(
            "select column_name from information_schema.columns where table_schema = current_schema() and table_name = 'change_set' and column_name in ('notes', 'reason') order by column_name",
            &[],
        )
        .unwrap()
        .into_iter()
        .map(|row| row.get(0))
        .collect();
    assert_eq!(change_set_note_columns, vec!["notes"]);

    let custom_fields_default: String = db
        .client
        .query_one(
            r#"
            select pg_get_expr(d.adbin, d.adrelid)
            from pg_attrdef d
            join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
            join pg_class c on c.oid = d.adrelid
            join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = current_schema()
              and c.relname = 'employee_version'
              and a.attname = 'custom_fields'
            "#,
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(custom_fields_default, "'[]'::jsonb");
}

#[test]
fn materialize_schema_creates_substrate_tables_on_fresh_database() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };

    let revision_id =
        materialize_schema(&mut db.client, &test_schema("customer_fresh_materialize")).unwrap();

    assert!(revision_id.get() > 0);
}

#[test]
fn guarded_materialization_advances_activation_head_and_blocks_old_activation() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let customer_id = "customer_forward_only";
    let legacy_schema = declared_enum_schema(customer_id);
    materialize_schema(&mut db.client, &legacy_schema).unwrap();

    let mut current_schema = legacy_schema.clone();
    current_schema.version = SchemaVersion::from("2026-07-16.current");
    let current_revision_id = materialize_schema_with_provenance_guarded(
        &mut db.client,
        &current_schema,
        &SchemaRevisionProvenance::default(),
        |_| Ok(()),
    )
    .unwrap();

    let head: String = db
        .client
        .query_one(
            r#"
            select base_schema_version
            from schema_activation_head
            where app_id = $1 and customer_id = $2
            "#,
            &[&current_schema.app_id.as_str(), &customer_id],
        )
        .unwrap()
        .get(0);
    assert_eq!(head, current_schema.version.as_str());

    let options = commit_enum_option_set_revision(
        &mut db.client,
        &CommitEnumOptionSetRevision {
            app_id: current_schema.app_id.clone(),
            customer_id: current_schema.customer_id.clone(),
            baseline_revision_id: current_revision_id,
            target: EnumOptionSetTarget::Declared {
                model_id: ModelId::from("employee"),
                field_id: FieldId::from("status"),
            },
            options: vec![
                EnumOption {
                    id: EnumOptionId::from("active"),
                    label: "Active".to_string(),
                    aliases: vec!["current".to_string()],

                    ..Default::default()
                },
                EnumOption {
                    id: EnumOptionId::from("inactive"),
                    label: "Inactive".to_string(),
                    aliases: vec![],

                    ..Default::default()
                },
                EnumOption {
                    id: EnumOptionId::from("leave"),
                    label: "Leave".to_string(),
                    aliases: vec![],

                    ..Default::default()
                },
            ],
        },
    )
    .unwrap();
    assert_eq!(options.last().unwrap().id, EnumOptionId::from("leave"));

    let preflight_downgrade =
        preflight_schema_materialization(&mut db.client, &legacy_schema).unwrap_err();
    assert!(matches!(preflight_downgrade, DbError::SchemaDrift { .. }));
    let ordinary_downgrade = materialize_schema(&mut db.client, &legacy_schema).unwrap_err();
    assert!(matches!(ordinary_downgrade, DbError::SchemaDrift { .. }));

    let mut old_activation = db.client.transaction().unwrap();
    old_activation
        .query_one(
            "select set_config('platform.app_id', $1, true)",
            &[&legacy_schema.app_id.as_str()],
        )
        .unwrap();
    old_activation
        .batch_execute("alter table employee_version add column old_binary_attempt text;")
        .unwrap();
    old_activation
        .query_one(
            "select set_config('platform.customer_id', $1, true)",
            &[&legacy_schema.customer_id.as_str()],
        )
        .unwrap();
    old_activation
        .execute(
            "update schema_revision set activated_at = null where app_id = $1 and customer_id = $2",
            &[
                &legacy_schema.app_id.as_str(),
                &legacy_schema.customer_id.as_str(),
            ],
        )
        .unwrap();
    let error = old_activation
        .execute(
            "update schema_revision set activated_at = coalesce(activated_at, now()) where app_id = $1 and customer_id = $2 and version = $3",
            &[
                &legacy_schema.app_id.as_str(),
                &legacy_schema.customer_id.as_str(),
                &legacy_schema.version.as_str(),
            ],
        )
        .unwrap_err();
    assert_eq!(
        error.code(),
        Some(&postgres::error::SqlState::CHECK_VIOLATION)
    );
    drop(old_activation);

    let rolled_back_column: i64 = db
        .client
        .query_one(
            r#"
            select count(*)
            from information_schema.columns
            where table_schema = current_schema()
              and table_name = 'employee_version'
              and column_name = 'old_binary_attempt'
            "#,
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(rolled_back_column, 0);

    let active_base_version: String = db
        .client
        .query_one(
            r#"
            select base_schema ->> 'version'
            from schema_revision
            where app_id = $1 and customer_id = $2 and activated_at is not null
            "#,
            &[
                &current_schema.app_id.as_str(),
                &current_schema.customer_id.as_str(),
            ],
        )
        .unwrap()
        .get(0);
    assert_eq!(active_base_version, current_schema.version.as_str());

    let mut next_schema = current_schema.clone();
    next_schema.version = SchemaVersion::from("2026-07-17.next");
    preflight_schema_materialization_guarded(&mut db.client, &next_schema, |transaction| {
        let active_base_version: String = transaction
            .query_one(
                "select base_schema ->> 'version' from schema_revision where app_id = $1 and customer_id = $2 and activated_at is not null",
                &[&current_schema.app_id.as_str(), &current_schema.customer_id.as_str()],
            )
            .unwrap()
            .get(0);
        assert_eq!(active_base_version, current_schema.version.as_str());
        Ok(())
    })
    .unwrap();
    let state_after_preflight_row = db
        .client
        .query_one(
            r#"
            select head.base_schema_version,
                   count(revision.id) filter (where revision.version = $3)
            from schema_activation_head head
            left join schema_revision revision
              on revision.app_id = head.app_id and revision.customer_id = head.customer_id
            where head.app_id = $1 and head.customer_id = $2
            group by head.base_schema_version
            "#,
            &[
                &current_schema.app_id.as_str(),
                &current_schema.customer_id.as_str(),
                &next_schema.version.as_str(),
            ],
        )
        .unwrap();
    let state_after_preflight: (String, i64) = (
        state_after_preflight_row.get(0),
        state_after_preflight_row.get(1),
    );
    assert_eq!(
        state_after_preflight,
        (current_schema.version.as_str().to_string(), 0)
    );

    materialize_schema_with_provenance_guarded(
        &mut db.client,
        &next_schema,
        &SchemaRevisionProvenance::default(),
        |transaction| {
            let active_base_version: String = transaction
                .query_one(
                    "select base_schema ->> 'version' from schema_revision where app_id = $1 and customer_id = $2 and activated_at is not null",
                    &[&current_schema.app_id.as_str(), &current_schema.customer_id.as_str()],
                )
                .unwrap()
                .get(0);
            assert_eq!(active_base_version, current_schema.version.as_str());
            Ok(())
        },
    )
    .unwrap();
    assert!(
        schema_revision_is_active_with_materialized_tables(&mut db.client, &next_schema).unwrap()
    );
    let ordinary_previous_preflight =
        preflight_schema_materialization(&mut db.client, &current_schema).unwrap_err();
    assert!(matches!(
        ordinary_previous_preflight,
        DbError::SchemaDrift { .. }
    ));
}

#[test]
fn activation_head_trigger_drift_fails_validation_and_guarded_materialization_repairs_it() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_activation_trigger_repair");
    materialize_schema_with_provenance_guarded(
        &mut db.client,
        &schema,
        &SchemaRevisionProvenance::default(),
        |_| Ok(()),
    )
    .unwrap();
    db.client
        .batch_execute(
            "alter table schema_revision disable trigger schema_revision_activation_head;",
        )
        .unwrap();

    let error =
        schema_revision_is_active_with_materialized_tables(&mut db.client, &schema).unwrap_err();
    assert!(matches!(
        error,
        DbError::SchemaDrift { object, .. }
            if object == "schema_revision.schema_revision_activation_head"
    ));

    materialize_schema_with_provenance_guarded(
        &mut db.client,
        &schema,
        &SchemaRevisionProvenance::default(),
        |_| Ok(()),
    )
    .unwrap();
    assert!(schema_revision_is_active_with_materialized_tables(&mut db.client, &schema).unwrap());

    db.client
        .batch_execute(
            r#"
            drop trigger schema_revision_activation_head on schema_revision;
            create trigger schema_revision_activation_head
              before insert or update of activated_at, base_schema on schema_revision
              for each row when (false)
              execute function platform_enforce_schema_activation_head();
            "#,
        )
        .unwrap();
    let error =
        schema_revision_is_active_with_materialized_tables(&mut db.client, &schema).unwrap_err();
    assert!(matches!(
        error,
        DbError::SchemaDrift { object, .. }
            if object == "schema_revision.schema_revision_activation_head"
    ));

    materialize_schema_with_provenance_guarded(
        &mut db.client,
        &schema,
        &SchemaRevisionProvenance::default(),
        |_| Ok(()),
    )
    .unwrap();
    let trigger_when_is_null: bool = db
        .client
        .query_one(
            r#"
            select trigger.tgqual is null
            from pg_trigger trigger
            join pg_class relation on relation.oid = trigger.tgrelid
            join pg_namespace namespace on namespace.oid = relation.relnamespace
            where namespace.nspname = current_schema()
              and relation.relname = 'schema_revision'
              and trigger.tgname = 'schema_revision_activation_head'
            "#,
            &[],
        )
        .unwrap()
        .get(0);
    assert!(trigger_when_is_null);
    assert!(schema_revision_is_active_with_materialized_tables(&mut db.client, &schema).unwrap());
}

#[test]
fn activation_head_trigger_respects_forced_rls_without_mutating_tenant_scope() {
    let Some(mut db) = TestDb::connect_owned_by_non_bypass_role() else {
        return;
    };
    let schema = test_schema("customer_activation_scope");
    materialize_schema_with_provenance_guarded(
        &mut db.client,
        &schema,
        &SchemaRevisionProvenance::default(),
        |_| Ok(()),
    )
    .unwrap();

    let wrong_customer_id = "customer_wrong_scope";
    let mut transaction = db.client.transaction().unwrap();
    transaction
        .query_one(
            "select set_config('platform.app_id', $1, true)",
            &[&schema.app_id.as_str()],
        )
        .unwrap();
    transaction
        .query_one(
            "select set_config('platform.customer_id', $1, true)",
            &[&schema.customer_id.as_str()],
        )
        .unwrap();

    transaction
        .batch_execute("savepoint wrong_insert;")
        .unwrap();
    let insert_error = transaction
        .execute(
            r#"
            insert into schema_revision (
              app_id, customer_id, version, base_schema, customer_overlay, schema,
              schema_hash, activated_at
            )
            select $1, $2, 'wrong-scope-insert', base_schema, customer_overlay, schema,
                   schema_hash, now()
            from schema_revision
            where app_id = $1 and customer_id = $3 and activated_at is not null
            "#,
            &[
                &schema.app_id.as_str(),
                &wrong_customer_id,
                &schema.customer_id.as_str(),
            ],
        )
        .unwrap_err();
    assert_eq!(
        insert_error.code(),
        Some(&postgres::error::SqlState::INSUFFICIENT_PRIVILEGE)
    );
    transaction
        .batch_execute("rollback to savepoint wrong_insert; release savepoint wrong_insert;")
        .unwrap();
    let scope_after_insert_row = transaction
        .query_one(
            "select current_setting('platform.app_id'), current_setting('platform.customer_id')",
            &[],
        )
        .unwrap();
    let scope_after_insert: (String, String) =
        (scope_after_insert_row.get(0), scope_after_insert_row.get(1));
    assert_eq!(
        scope_after_insert,
        (
            schema.app_id.as_str().to_string(),
            schema.customer_id.as_str().to_string()
        )
    );

    transaction
        .batch_execute("savepoint wrong_update;")
        .unwrap();
    let update_error = transaction
        .execute(
            r#"
            update schema_revision
            set customer_id = $3, version = 'wrong-scope-update'
            where app_id = $1 and customer_id = $2 and activated_at is not null
            "#,
            &[
                &schema.app_id.as_str(),
                &schema.customer_id.as_str(),
                &wrong_customer_id,
            ],
        )
        .unwrap_err();
    assert_eq!(
        update_error.code(),
        Some(&postgres::error::SqlState::INSUFFICIENT_PRIVILEGE)
    );
    transaction
        .batch_execute("rollback to savepoint wrong_update; release savepoint wrong_update;")
        .unwrap();
    let scope_after_update_row = transaction
        .query_one(
            "select current_setting('platform.app_id'), current_setting('platform.customer_id')",
            &[],
        )
        .unwrap();
    let scope_after_update: (String, String) =
        (scope_after_update_row.get(0), scope_after_update_row.get(1));
    assert_eq!(scope_after_update, scope_after_insert);
    transaction.rollback().unwrap();
}

#[test]
fn activation_head_rejects_competing_before_row_revision_triggers() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_competing_activation_trigger");
    materialize_schema_with_provenance_guarded(
        &mut db.client,
        &schema,
        &SchemaRevisionProvenance::default(),
        |_| Ok(()),
    )
    .unwrap();
    db.client
        .batch_execute(
            r#"
            create function zz_observe_schema_revision()
            returns trigger
            language plpgsql
            as $$
            begin
              return null;
            end;
            $$;
            create trigger zz_observe_schema_revision
              after insert or update on schema_revision
              for each statement execute function zz_observe_schema_revision();

            create function zz_rewrite_schema_revision_base()
            returns trigger
            language plpgsql
            as $$
            begin
              new.base_schema = jsonb_set(
                new.base_schema,
                '{version}',
                to_jsonb('bypassed'::text)
              );
              return new;
            end;
            $$;
            create trigger zz_rewrite_schema_revision_base
              before insert or update on schema_revision
              for each row execute function zz_rewrite_schema_revision_base();
            "#,
        )
        .unwrap();

    db.client
        .batch_execute("drop trigger zz_rewrite_schema_revision_base on schema_revision;")
        .unwrap();
    assert!(schema_revision_is_active_with_materialized_tables(&mut db.client, &schema).unwrap());
    db.client
        .batch_execute(
            r#"
            create trigger zz_rewrite_schema_revision_base
              before insert or update on schema_revision
              for each row execute function zz_rewrite_schema_revision_base();
            "#,
        )
        .unwrap();

    let error =
        schema_revision_is_active_with_materialized_tables(&mut db.client, &schema).unwrap_err();
    assert!(matches!(
        error,
        DbError::SchemaDrift { object, .. }
            if object == "schema_revision.zz_rewrite_schema_revision_base"
    ));
    let materialization_error = materialize_schema_with_provenance_guarded(
        &mut db.client,
        &schema,
        &SchemaRevisionProvenance::default(),
        |_| Ok(()),
    )
    .unwrap_err()
    .into_envelope();
    assert_eq!(materialization_error.code, "schema_drift");

    db.client
        .batch_execute(
            r#"
            drop trigger zz_rewrite_schema_revision_base on schema_revision;
            drop function zz_rewrite_schema_revision_base();
            drop trigger zz_observe_schema_revision on schema_revision;
            drop function zz_observe_schema_revision();
            "#,
        )
        .unwrap();
    materialize_schema_with_provenance_guarded(
        &mut db.client,
        &schema,
        &SchemaRevisionProvenance::default(),
        |_| Ok(()),
    )
    .unwrap();
    assert!(schema_revision_is_active_with_materialized_tables(&mut db.client, &schema).unwrap());
}

#[test]
fn activation_head_is_tenant_scoped_and_does_not_fence_unselected_tenants() {
    let Some(mut db) = TestDb::connect_owned_by_non_bypass_role() else {
        return;
    };
    let fenced_schema = test_schema("customer_fenced");
    materialize_schema_with_provenance_guarded(
        &mut db.client,
        &fenced_schema,
        &SchemaRevisionProvenance::default(),
        |_| Ok(()),
    )
    .unwrap();

    let mut other_schema = test_schema("customer_unfenced");
    other_schema.version = SchemaVersion::from("2026-04-01.older-but-independent");
    materialize_schema(&mut db.client, &other_schema).unwrap();

    let mut other_tenant = db.client.transaction().unwrap();
    other_tenant
        .query_one(
            "select set_config('platform.app_id', $1, true)",
            &[&other_schema.app_id.as_str()],
        )
        .unwrap();
    other_tenant
        .query_one(
            "select set_config('platform.customer_id', $1, true)",
            &[&other_schema.customer_id.as_str()],
        )
        .unwrap();
    let visible_heads: i64 = other_tenant
        .query_one("select count(*) from schema_activation_head", &[])
        .unwrap()
        .get(0);
    assert_eq!(visible_heads, 0);
    other_tenant.commit().unwrap();

    assert!(
        schema_revision_is_active_with_materialized_tables(&mut db.client, &other_schema,).unwrap()
    );
}

#[test]
fn materialize_schema_repairs_missing_contracts_before_fresh_validation() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_repair_then_validate");
    let revision_id = materialize_schema(&mut db.client, &schema).unwrap();

    db.client
        .batch_execute(
            r#"
            drop index employee_version_change_set_value_once_idx;
            alter table employee_record disable row level security;
            "#,
        )
        .unwrap();

    let repaired_revision_id = materialize_schema(&mut db.client, &schema).unwrap();
    assert_eq!(repaired_revision_id, revision_id);
    assert!(schema_revision_is_active_with_materialized_tables(&mut db.client, &schema).unwrap());
}

#[test]
fn policy_reconciliation_repairs_legacy_preview_state_before_strict_validation() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_preview_policy_repair");
    materialize_schema(&mut db.client, &schema).unwrap();
    db.client
        .batch_execute("drop policy platform_tenant_scope on company_record;")
        .unwrap();

    let drift =
        schema_revision_is_active_with_materialized_tables(&mut db.client, &schema).unwrap_err();
    assert!(matches!(
        drift,
        DbError::SchemaDrift { object, .. }
            if object == "company_record.platform_tenant_scope"
    ));

    reconcile_schema_materialization_policies(&mut db.client, &schema).unwrap();
    reconcile_schema_materialization_policies(&mut db.client, &schema).unwrap();
    assert!(schema_revision_is_active_with_materialized_tables(&mut db.client, &schema).unwrap());
}

#[test]
fn policy_reconciliation_replaces_additional_legacy_policies() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_preview_legacy_policy_repair");
    materialize_schema(&mut db.client, &schema).unwrap();
    db.client
        .batch_execute(
            "create policy legacy_tenant_scope on company_record for all using (true) with check (true);",
        )
        .unwrap();

    let drift =
        schema_revision_is_active_with_materialized_tables(&mut db.client, &schema).unwrap_err();
    assert!(matches!(
        drift,
        DbError::SchemaDrift { object, .. }
            if object == "company_record.platform_tenant_scope"
    ));

    reconcile_schema_materialization_policies(&mut db.client, &schema).unwrap();
    assert!(schema_revision_is_active_with_materialized_tables(&mut db.client, &schema).unwrap());
    let policy_names = db
        .client
        .query(
            "select policyname from pg_policies where schemaname = current_schema() and tablename = 'company_record' order by policyname",
            &[],
        )
        .unwrap()
        .into_iter()
        .map(|row| row.get::<_, String>(0))
        .collect::<Vec<_>>();
    assert_eq!(policy_names, vec!["platform_tenant_scope"]);
}

#[test]
fn policy_reconciliation_reports_missing_kernel_tables_as_schema_drift() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_preview_policy_repair_missing_table");
    materialize_schema(&mut db.client, &schema).unwrap();
    db.client
        .batch_execute(
            r#"
            alter table company_version drop constraint company_version_change_set_tenant_fk;
            alter table employee_version drop constraint employee_version_change_set_tenant_fk;
            drop table change_set;
            "#,
        )
        .unwrap();

    let drift = reconcile_schema_materialization_policies(&mut db.client, &schema).unwrap_err();
    assert!(matches!(
        drift,
        DbError::SchemaDrift { object, details }
            if object == "change_set" && details == "missing table"
    ));
}

#[test]
fn materialize_schema_replaces_legacy_version_uniqueness_atomically() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_version_index_transition");
    materialize_schema(&mut db.client, &schema).unwrap();
    db.client
        .batch_execute(
            r#"
            drop index employee_version_change_set_value_once_idx;
            drop index employee_version_mainline_lifecycle_once_idx;
            create unique index employee_version_mainline_unique_idx
              on employee_version (
                record_id,
                effective_start,
                tombstones_record,
                untombstones_record
              )
              where stage = 'mainline';
            "#,
        )
        .unwrap();

    materialize_schema(&mut db.client, &schema).unwrap();
    let indexes = db
        .client
        .query(
            r#"
            select indexname
            from pg_indexes
            where schemaname = current_schema()
              and tablename = 'employee_version'
              and indexname in (
                'employee_version_mainline_unique_idx',
                'employee_version_change_set_value_once_idx',
                'employee_version_mainline_lifecycle_once_idx'
              )
            order by indexname
            "#,
            &[],
        )
        .unwrap()
        .into_iter()
        .map(|row| row.get::<_, String>("indexname"))
        .collect::<Vec<_>>();
    assert_eq!(
        indexes,
        vec![
            "employee_version_change_set_value_once_idx".to_string(),
            "employee_version_mainline_lifecycle_once_idx".to_string(),
        ]
    );
    assert!(schema_revision_is_active_with_materialized_tables(&mut db.client, &schema).unwrap());
}

#[test]
fn materialized_contract_validation_rejects_legacy_version_index() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_legacy_index_drift");
    materialize_schema(&mut db.client, &schema).unwrap();
    db.client
        .batch_execute(
            r#"
            create unique index employee_version_mainline_unique_idx
              on employee_version (
                record_id,
                effective_start,
                tombstones_record,
                untombstones_record
              )
              where stage = 'mainline';
            "#,
        )
        .unwrap();

    let error =
        schema_revision_is_active_with_materialized_tables(&mut db.client, &schema).unwrap_err();
    assert!(matches!(
        error,
        DbError::SchemaDrift { object, .. }
            if object == "employee_version.employee_version_mainline_unique_idx"
    ));
}

#[test]
fn materialize_schema_rejects_custom_fields_default_drift() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_a");
    materialize_schema(&mut db.client, &schema).unwrap();

    db.client
        .batch_execute(
            "alter table employee_version alter column custom_fields set default '{}'::jsonb;",
        )
        .unwrap();

    let error = materialize_schema(&mut db.client, &schema).unwrap_err();
    assert!(matches!(error, DbError::SchemaDrift { .. }));
}

#[test]
fn materialize_schema_rejects_missing_model_table_after_revision_exists() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_a");
    materialize_schema(&mut db.client, &schema).unwrap();

    db.client
        .batch_execute(
            r#"
            drop table employee_version;
            drop table employee_record;
            "#,
        )
        .unwrap();

    let error = materialize_schema(&mut db.client, &schema).unwrap_err();
    assert!(matches!(
        &error,
        DbError::SchemaDrift { object, .. } if object == "employee_record"
    ));
}

#[test]
fn materialize_schema_rejects_missing_lifecycle_sequence_after_revision_exists() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_a");
    materialize_schema(&mut db.client, &schema).unwrap();

    db.client
        .batch_execute("drop sequence change_set_lifecycle_order_seq cascade;")
        .unwrap();

    let error = materialize_schema(&mut db.client, &schema).unwrap_err();
    assert!(matches!(
        &error,
        DbError::SchemaDrift { object, .. } if object == "change_set_lifecycle_order_seq"
    ));
}

#[test]
fn materialize_schema_accepts_appended_agent_run_status_column() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_agent_status_column_order");
    materialize_schema(&mut db.client, &schema).unwrap();

    db.client
        .batch_execute(
            r#"
            drop table agent_run;

            create table agent_run (
              id bigserial,
              app_id text not null,
              customer_id text not null,
              run_id text not null,
              schema_revision_id bigint not null,
              actor_id text,
              agent_identity_id text not null,
              execution_profile_id text not null,
              source_artifacts jsonb not null default '[]',
              alignment_decisions jsonb not null default '[]',
              model_calls jsonb not null default '[]',
              tool_calls jsonb not null default '[]',
              token_usage jsonb not null default '{}',
              validation_failures jsonb not null default '[]',
              final_outputs jsonb not null default '{}',
              approval_boundaries jsonb not null default '[]',
              compiled_preview_ids jsonb not null default '[]',
              created_at timestamptz not null default now(),
              status text not null default 'recorded',
              constraint agent_run_pkey primary key (id),
              constraint agent_run_scope_run_key unique (app_id, customer_id, run_id)
            );
            "#,
        )
        .unwrap();

    materialize_schema(&mut db.client, &schema).unwrap();
    assert!(schema_revision_is_active_with_materialized_tables(&mut db.client, &schema).unwrap());
}

#[test]
fn materialize_schema_drops_removed_version_field_column() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let mut original_schema = single_model_schema("customer_removed_field_column", "company");
    let company = original_schema
        .models
        .iter_mut()
        .find(|model| model.id == ModelId::from("company"))
        .expect("company model exists");
    company.fields.push(Field {
        id: FieldId::from("slug"),
        label: "Slug".to_string(),
        field_type: FieldType::Text,
        required: false,
        is_unique: false,
        target_model: None,
        option_set: vec![],

        ..Default::default()
    });
    materialize_schema(&mut db.client, &original_schema).unwrap();

    let replacement_schema =
        single_model_schema_with_version("customer_removed_field_column", "company", "2026-05-05");
    materialize_schema(&mut db.client, &replacement_schema).unwrap();
    assert!(schema_revision_is_active_with_materialized_tables(
        &mut db.client,
        &replacement_schema
    )
    .unwrap());
    let slug_exists: bool = db
        .client
        .query_one(
            r#"
            select exists (
              select 1
              from information_schema.columns
              where table_schema = current_schema()
                and table_name = 'company_version'
                and column_name = 'slug'
            )
            "#,
            &[],
        )
        .unwrap()
        .get(0);
    assert!(!slug_exists);
}

#[test]
fn materialize_schema_allows_renamed_field_when_old_field_had_different_type() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let mut original_schema = test_schema("customer_renamed_field_type");
    let original_employee = original_schema
        .models
        .iter_mut()
        .find(|model| model.id == ModelId::from("employee"))
        .expect("employee model exists");
    original_employee.fields.push(Field {
        id: FieldId::from("status"),
        label: "Status".to_string(),
        field_type: FieldType::Relation,
        required: false,
        is_unique: false,
        target_model: Some(ModelId::from("company")),
        option_set: vec![],

        ..Default::default()
    });
    materialize_schema(&mut db.client, &original_schema).unwrap();

    let mut replacement_schema = test_schema("customer_renamed_field_type");
    replacement_schema.version = SchemaVersion::from("2026-05-05");
    let replacement_employee = replacement_schema
        .models
        .iter_mut()
        .find(|model| model.id == ModelId::from("employee"))
        .expect("employee model exists");
    replacement_employee.fields.push(Field {
        id: FieldId::from("employment_status"),
        label: "Employment Status".to_string(),
        field_type: FieldType::Enum,
        required: false,
        is_unique: false,
        target_model: None,
        option_set: vec![EnumOption {
            id: EnumOptionId::from("active"),
            label: "Active".to_string(),
            aliases: vec![],

            ..Default::default()
        }],

        ..Default::default()
    });

    materialize_schema(&mut db.client, &replacement_schema).unwrap();
    assert!(schema_revision_is_active_with_materialized_tables(
        &mut db.client,
        &replacement_schema
    )
    .unwrap());
    let columns = db
        .client
        .query(
            r#"
            select column_name, data_type
            from information_schema.columns
            where table_schema = current_schema()
              and table_name = 'employee_version'
              and column_name in ('status', 'employment_status')
            order by column_name
            "#,
            &[],
        )
        .unwrap()
        .into_iter()
        .map(|row| {
            (
                row.get::<_, String>("column_name"),
                row.get::<_, String>("data_type"),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        columns,
        vec![("employment_status".to_string(), "text".to_string())]
    );
}

#[test]
fn materialize_schema_allows_multiple_renamed_status_fields_with_old_relation_columns() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let mut original_schema = test_schema("customer_renamed_status_fields");
    let employee = original_schema
        .models
        .iter_mut()
        .find(|model| model.id == ModelId::from("employee"))
        .expect("employee model exists");
    employee.fields.push(Field {
        id: FieldId::from("status"),
        label: "Status".to_string(),
        field_type: FieldType::Relation,
        required: false,
        is_unique: false,
        target_model: Some(ModelId::from("company")),
        option_set: vec![],

        ..Default::default()
    });
    original_schema.models.push(Model {
        id: ModelId::from("position"),
        kind: ModelKind::Entity,
        label: "Position".to_string(),
        fields: vec![
            Field {
                id: FieldId::from("name"),
                label: "Name".to_string(),
                field_type: FieldType::Text,
                required: true,
                is_unique: false,
                target_model: None,
                option_set: vec![],

                ..Default::default()
            },
            Field {
                id: FieldId::from("status"),
                label: "Status".to_string(),
                field_type: FieldType::Relation,
                required: false,
                is_unique: false,
                target_model: Some(ModelId::from("company")),
                option_set: vec![],

                ..Default::default()
            },
        ],

        ..Default::default()
    });
    materialize_schema(&mut db.client, &original_schema).unwrap();

    let mut replacement_schema = test_schema("customer_renamed_status_fields");
    replacement_schema.version = SchemaVersion::from("2026-05-05");
    let replacement_employee = replacement_schema
        .models
        .iter_mut()
        .find(|model| model.id == ModelId::from("employee"))
        .expect("employee model exists");
    replacement_employee.fields.push(Field {
        id: FieldId::from("employment_status"),
        label: "Employment Status".to_string(),
        field_type: FieldType::Enum,
        required: false,
        is_unique: false,
        target_model: None,
        option_set: vec![EnumOption {
            id: EnumOptionId::from("active"),
            label: "Active".to_string(),
            aliases: vec![],

            ..Default::default()
        }],

        ..Default::default()
    });
    replacement_schema.models.push(Model {
        id: ModelId::from("position"),
        kind: ModelKind::Entity,
        label: "Position".to_string(),
        fields: vec![
            Field {
                id: FieldId::from("name"),
                label: "Name".to_string(),
                field_type: FieldType::Text,
                required: true,
                is_unique: false,
                target_model: None,
                option_set: vec![],

                ..Default::default()
            },
            Field {
                id: FieldId::from("position_status"),
                label: "Position Status".to_string(),
                field_type: FieldType::Enum,
                required: false,
                is_unique: false,
                target_model: None,
                option_set: vec![EnumOption {
                    id: EnumOptionId::from("open"),
                    label: "Open".to_string(),
                    aliases: vec![],

                    ..Default::default()
                }],

                ..Default::default()
            },
        ],

        ..Default::default()
    });

    materialize_schema(&mut db.client, &replacement_schema).unwrap();
    for (table_name, expected_column) in [
        ("employee_version", "employment_status"),
        ("position_version", "position_status"),
    ] {
        let columns = db
            .client
            .query(
                r#"
                select column_name, data_type
                from information_schema.columns
                where table_schema = current_schema()
                  and table_name = $1
                  and column_name in ('status', 'employment_status', 'position_status')
                order by column_name
                "#,
                &[&table_name],
            )
            .unwrap()
            .into_iter()
            .map(|row| {
                (
                    row.get::<_, String>("column_name"),
                    row.get::<_, String>("data_type"),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            columns,
            vec![(expected_column.to_string(), "text".to_string())]
        );
    }
}

#[test]
fn materialize_schema_preserves_columns_declared_by_sibling_active_schema() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let hc_schema = test_schema("customer_shared_hc");
    let mut vendor_schema = single_model_schema("customer_shared_vendor", "employee");
    vendor_schema.app_id = AppId::from("vendor_app");

    materialize_schema(&mut db.client, &hc_schema).unwrap();
    materialize_schema(&mut db.client, &vendor_schema).unwrap();

    assert!(
        schema_revision_is_active_with_materialized_tables(&mut db.client, &hc_schema).unwrap()
    );
    assert!(
        schema_revision_is_active_with_materialized_tables(&mut db.client, &vendor_schema).unwrap()
    );
    for column_name in [
        "employer",
        "comp_rate_amount",
        "comp_rate_currency",
        "comp_rate_period",
    ] {
        let exists: bool = db
            .client
            .query_one(
                r#"
                select exists (
                  select 1
                  from information_schema.columns
                  where table_schema = current_schema()
                    and table_name = 'employee_version'
                    and column_name = $1
                )
                "#,
                &[&column_name],
            )
            .unwrap()
            .get(0);
        assert!(exists, "{column_name} should remain for the HC schema");
    }
}

#[test]
fn materialize_schema_rejects_required_columns_declared_only_by_sibling_schema() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let mut hc_schema = test_schema("customer_required_shared_hc");
    let employee = hc_schema
        .models
        .iter_mut()
        .find(|model| model.id == ModelId::from("employee"))
        .expect("employee model exists");
    employee.fields.push(Field {
        id: FieldId::from("title"),
        label: "Title".to_string(),
        field_type: FieldType::Text,
        required: true,
        is_unique: false,
        target_model: None,
        option_set: vec![],

        ..Default::default()
    });
    let mut vendor_schema = single_model_schema("customer_required_shared_vendor", "employee");
    vendor_schema.app_id = AppId::from("vendor_app");

    materialize_schema(&mut db.client, &hc_schema).unwrap();

    let error = materialize_schema(&mut db.client, &vendor_schema).unwrap_err();
    assert!(
        matches!(error, DbError::SchemaDrift { .. }),
        "sibling-only required columns should block subset materialization, got {error:?}"
    );
}

#[test]
fn materialize_schema_rejects_local_required_or_unique_columns_not_shared_by_sibling_schema() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let mut vendor_schema = single_model_schema("customer_local_mismatch_vendor", "employee");
    vendor_schema.app_id = AppId::from("vendor_app");
    vendor_schema.models[0].fields.push(Field {
        id: FieldId::from("title"),
        label: "Title".to_string(),
        field_type: FieldType::Text,
        required: false,
        is_unique: false,
        target_model: None,
        option_set: vec![],

        ..Default::default()
    });
    let mut hc_required_schema = test_schema("customer_local_required_hc");
    let required_employee = hc_required_schema
        .models
        .iter_mut()
        .find(|model| model.id == ModelId::from("employee"))
        .expect("employee model exists");
    required_employee.fields.push(Field {
        id: FieldId::from("title"),
        label: "Title".to_string(),
        field_type: FieldType::Text,
        required: true,
        is_unique: false,
        target_model: None,
        option_set: vec![],

        ..Default::default()
    });
    let mut hc_unique_schema = test_schema("customer_local_unique_hc");
    let unique_employee = hc_unique_schema
        .models
        .iter_mut()
        .find(|model| model.id == ModelId::from("employee"))
        .expect("employee model exists");
    unique_employee.fields.push(Field {
        id: FieldId::from("title"),
        label: "Title".to_string(),
        field_type: FieldType::Text,
        required: false,
        is_unique: true,
        target_model: None,
        option_set: vec![],

        ..Default::default()
    });

    materialize_schema(&mut db.client, &vendor_schema).unwrap();

    let required_error = materialize_schema(&mut db.client, &hc_required_schema).unwrap_err();
    assert!(
        matches!(required_error, DbError::SchemaDrift { .. }),
        "local required columns unsupported by siblings should fail, got {required_error:?}"
    );
    let unique_error = materialize_schema(&mut db.client, &hc_unique_schema).unwrap_err();
    assert!(
        matches!(unique_error, DbError::SchemaDrift { .. }),
        "local unique columns unsupported by siblings should fail, got {unique_error:?}"
    );
}

#[test]
fn materialization_preflight_rejects_coordinated_contract_changes_without_writing() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let mut active = single_model_schema("active_customer", "employee");
    active.app_id = AppId::from("vendor_app");
    active.models[0].fields.push(Field {
        id: FieldId::from("title"),
        label: "Title".to_string(),
        field_type: FieldType::Text,
        required: false,
        is_unique: false,
        target_model: None,
        option_set: vec![],

        ..Default::default()
    });
    materialize_schema(&mut db.client, &active).unwrap();

    let mut proposed = active.clone();
    proposed.customer_id = CustomerId::from("proposed_customer");
    preflight_schema_materialization(&mut db.client, &proposed).unwrap();

    proposed.models[0]
        .fields
        .iter_mut()
        .find(|field| field.id == FieldId::from("title"))
        .unwrap()
        .required = true;
    let error = preflight_schema_materialization(&mut db.client, &proposed).unwrap_err();
    let message = error.to_string();
    assert!(message.contains("coordinated schema migration required"));
    assert!(message.contains("vendor_app/active_customer"));

    proposed.models[0]
        .fields
        .iter_mut()
        .find(|field| field.id == FieldId::from("title"))
        .unwrap()
        .required = false;
    proposed.models[0]
        .fields
        .iter_mut()
        .find(|field| field.id == FieldId::from("title"))
        .unwrap()
        .is_unique = true;
    let unique_error = preflight_schema_materialization(&mut db.client, &proposed).unwrap_err();
    assert!(unique_error.to_string().contains("unique columns differ"));

    let revision_count: i64 = db
        .client
        .query_one("select count(*) from schema_revision", &[])
        .unwrap()
        .get(0);
    assert_eq!(
        revision_count, 1,
        "preflight must not create schema revisions"
    );
}

#[test]
fn materialize_schema_drops_stale_required_and_unique_artifacts_for_retained_sibling_column() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let mut vendor_schema = single_model_schema("customer_retained_optional_vendor", "employee");
    vendor_schema.app_id = AppId::from("vendor_app");
    vendor_schema.models[0].fields.push(Field {
        id: FieldId::from("title"),
        label: "Title".to_string(),
        field_type: FieldType::Text,
        required: false,
        is_unique: false,
        target_model: None,
        option_set: vec![],

        ..Default::default()
    });

    materialize_schema(&mut db.client, &vendor_schema).unwrap();
    db.client
        .batch_execute(
            r#"
            alter table employee_version
              add constraint employee_version_title_required_check
              check (tombstones_record or untombstones_record or title is not null);
            create unique index employee_version_title_live_unique_idx
              on employee_version (app_id, customer_id, title)
              where stage = 'mainline' and effective_end is null and title is not null;
            "#,
        )
        .unwrap();

    let mut replacement_hc_schema = test_schema("customer_retained_required_hc");
    replacement_hc_schema.version = SchemaVersion::from("2026-05-05");
    materialize_schema(&mut db.client, &replacement_hc_schema).unwrap();

    let title_exists: bool = db
        .client
        .query_one(
            r#"
            select exists (
              select 1
              from information_schema.columns
              where table_schema = current_schema()
                and table_name = 'employee_version'
                and column_name = 'title'
            )
            "#,
            &[],
        )
        .unwrap()
        .get(0);
    assert!(title_exists);
    let stale_required_exists: bool = db
        .client
        .query_one(
            r#"
            select exists (
              select 1
              from pg_constraint c
              join pg_class r on r.oid = c.conrelid
              join pg_namespace n on n.oid = r.relnamespace
              where n.nspname = current_schema()
                and r.relname = 'employee_version'
                and c.conname = 'employee_version_title_required_check'
            )
            "#,
            &[],
        )
        .unwrap()
        .get(0);
    assert!(!stale_required_exists);
    let stale_unique_exists: bool = db
        .client
        .query_one(
            r#"
            select exists (
              select 1
              from pg_class i
              join pg_namespace n on n.oid = i.relnamespace
              where n.nspname = current_schema()
                and i.relkind = 'i'
                and i.relname = 'employee_version_title_live_unique_idx'
            )
            "#,
            &[],
        )
        .unwrap()
        .get(0);
    assert!(!stale_unique_exists);
}

#[test]
fn custom_fields_round_trip_all_supported_types_and_resolve_relations() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let _legacy_fixture_constructor = all_custom_field_entries;
    let mut backend = RustKernelBackend::new(&mut db.client);
    support::parity_scenarios::custom_fields_round_trip_all_supported_types_and_resolve_relations(
        &mut backend,
    );
}

#[test]
fn custom_field_enum_orphan_options_render_null_by_omission() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let mut backend = RustKernelBackend::new(&mut db.client);
    support::parity_scenarios::custom_field_enum_orphan_options_render_null_by_omission(
        &mut backend,
    );
}

#[test]
fn custom_fields_reject_missing_and_cross_tenant_relation_targets() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let mut backend = RustKernelBackend::new(&mut db.client);
    support::parity_scenarios::custom_fields_reject_missing_and_cross_tenant_relation_targets(
        &mut backend,
    );
}

#[test]
fn custom_fields_follow_draft_approval_discard_and_revert_lifecycle() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let mut backend = RustKernelBackend::new(&mut db.client);
    support::parity_scenarios::custom_fields_follow_draft_approval_discard_and_revert_lifecycle(
        &mut backend,
    );
}

#[test]
fn change_set_diff_covers_custom_field_create_update_projection_and_revert() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let _legacy_diff_type = None::<CustomFieldDiff>;
    let mut backend = RustKernelBackend::new(&mut db.client);
    support::parity_scenarios::change_set_diff_covers_custom_field_create_update_projection_and_revert(
        &mut backend,
    );
}

#[test]
fn custom_fields_omit_inherit_and_archived_definitions_stop_carrying_forward() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let mut backend = RustKernelBackend::new(&mut db.client);
    support::parity_scenarios::custom_fields_omit_inherit_and_archived_definitions_stop_carrying_forward(
        &mut backend,
    );
}

#[test]
fn unique_field_indexes_enforce_live_mainline_values() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = unique_ref_schema("customer_unique");
    materialize_schema(&mut db.client, &schema).unwrap();

    let indexes: Vec<(String, bool, String)> = db
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
        .unwrap()
        .into_iter()
        .map(|row| {
            (
                row.get("relname"),
                row.get("indisunique"),
                row.get("predicate"),
            )
        })
        .collect();
    assert_eq!(indexes.len(), 1);
    assert!(indexes[0].1);
    assert_eq!(
        indexes[0].2,
        "((stage = 'mainline'::text) AND (effective_end IS NULL) AND (ref IS NOT NULL))"
    );

    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_unique",
            Some("unique_a"),
            vec![employee_write(
                "employee_a",
                "2026-01-01",
                Some(ref_values(Some("EMP-1"), "Alice")),
                false,
            )],
        ),
    )
    .unwrap();
    let duplicate = apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_unique",
            Some("unique_b"),
            vec![employee_write(
                "employee_b",
                "2026-01-01",
                Some(ref_values(Some("EMP-1"), "Bob")),
                false,
            )],
        ),
    )
    .unwrap_err();
    assert!(matches!(
        duplicate,
        DbError::UniqueFieldConflict { model, field, value }
            if model == "employee" && field == "ref" && value == "EMP-1"
    ));

    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_unique",
            Some("unique_same_record"),
            vec![employee_write(
                "employee_a",
                "2026-01-01",
                Some(ref_values(Some("EMP-1"), "Alice Updated")),
                false,
            )],
        ),
    )
    .unwrap();
    let live_count: i64 = db
        .client
        .query_one(
            "select count(*) from employee_version where stage = 'mainline' and effective_end is null and record_id = (select id from employee_record where external_key = 'employee_a')",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(live_count, 1);
    let retained_count: i64 = db
        .client
        .query_one(
            "select count(*) from employee_version where stage = 'mainline' and effective_start = date '2026-01-01' and record_id = (select id from employee_record where external_key = 'employee_a')",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(retained_count, 2);

    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_unique",
            Some("unique_null_a"),
            vec![employee_write(
                "employee_c",
                "2026-01-01",
                Some(ref_values(None, "No Ref A")),
                false,
            )],
        ),
    )
    .unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_unique",
            Some("unique_null_b"),
            vec![employee_write(
                "employee_d",
                "2026-01-01",
                Some(ref_values(None, "No Ref B")),
                false,
            )],
        ),
    )
    .unwrap();
}

#[test]
fn numeric_unique_field_precheck_uses_typed_comparison() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = unique_score_schema("customer_numeric_unique");
    materialize_schema(&mut db.client, &schema).unwrap();

    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_numeric_unique",
            Some("numeric_unique_a"),
            vec![employee_write(
                "employee_a",
                "2026-01-01",
                Some(score_values(42, "Alice")),
                false,
            )],
        ),
    )
    .unwrap();

    let duplicate = apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_numeric_unique",
            Some("numeric_unique_b"),
            vec![employee_write(
                "employee_b",
                "2026-01-01",
                Some(score_values(42, "Bob")),
                false,
            )],
        ),
    )
    .unwrap_err();
    assert!(matches!(
        duplicate,
        DbError::UniqueFieldConflict { model, field, value }
            if model == "employee" && field == "score" && value == "42"
    ));
}

#[test]
fn unique_field_value_is_reusable_after_tombstone() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = unique_ref_schema("customer_tombstone_unique");
    materialize_schema(&mut db.client, &schema).unwrap();

    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_tombstone_unique",
            Some("tombstone_unique_a"),
            vec![employee_write(
                "employee_a",
                "2026-01-01",
                Some(ref_values(Some("EMP-1"), "Alice")),
                false,
            )],
        ),
    )
    .unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_tombstone_unique",
            Some("tombstone_unique_a_delete"),
            vec![employee_write("employee_a", "2026-02-01", None, true)],
        ),
    )
    .unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_tombstone_unique",
            Some("tombstone_unique_b"),
            vec![employee_write(
                "employee_b",
                "2026-03-01",
                Some(ref_values(Some("EMP-1"), "Bob")),
                false,
            )],
        ),
    )
    .unwrap();
}

#[test]
fn draft_approval_rejects_unique_field_conflicts() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = unique_ref_schema("customer_draft_unique");
    materialize_schema(&mut db.client, &schema).unwrap();

    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_draft_unique",
            Some("draft_unique_mainline"),
            vec![employee_write(
                "employee_a",
                "2026-01-01",
                Some(ref_values(Some("EMP-1"), "Alice")),
                false,
            )],
        ),
    )
    .unwrap();
    let draft = apply_change_set(
        &mut db.client,
        &draft_apply(
            "customer_draft_unique",
            Some("draft_unique_duplicate"),
            vec![employee_write(
                "employee_b",
                "2026-01-01",
                Some(ref_values(Some("EMP-1"), "Bob")),
                false,
            )],
        ),
    )
    .unwrap();
    let sequence_before_approval = db
        .client
        .query_one(
            "select last_value, is_called from change_set_lifecycle_order_seq",
            &[],
        )
        .unwrap();
    let sequence_before_approval: (i64, bool) = (
        sequence_before_approval.get(0),
        sequence_before_approval.get(1),
    );
    let error = approve_draft_change_set(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_draft_unique"),
        draft.id,
    )
    .unwrap_err();
    assert!(matches!(
        error,
        DbError::UniqueFieldConflict { model, field, value }
            if model == "employee" && field == "ref" && value == "EMP-1"
    ));
    let sequence_after_approval = db
        .client
        .query_one(
            "select last_value, is_called from change_set_lifecycle_order_seq",
            &[],
        )
        .unwrap();
    let sequence_after_approval: (i64, bool) = (
        sequence_after_approval.get(0),
        sequence_after_approval.get(1),
    );
    assert_eq!(sequence_after_approval, sequence_before_approval);
}

#[test]
fn draft_approval_validates_internal_live_unique_conflicts_before_ordering() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let customer_id = "customer_draft_internal_unique";
    materialize_schema(&mut db.client, &unique_ref_schema(customer_id)).unwrap();
    let draft = apply_change_set(
        &mut db.client,
        &draft_apply(
            customer_id,
            Some("draft-internal-unique-conflict"),
            vec![
                employee_write(
                    "employee_a",
                    "2026-01-01",
                    Some(ref_values(Some("EMP-1"), "Alice")),
                    false,
                ),
                employee_write(
                    "employee_b",
                    "2026-01-01",
                    Some(ref_values(Some("EMP-1"), "Bob")),
                    false,
                ),
            ],
        ),
    )
    .unwrap();
    let sequence_before_approval = db
        .client
        .query_one(
            "select last_value, is_called from change_set_lifecycle_order_seq",
            &[],
        )
        .unwrap();
    let sequence_before_approval: (i64, bool) = (
        sequence_before_approval.get(0),
        sequence_before_approval.get(1),
    );

    let error = approve_draft_change_set(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from(customer_id),
        draft.id,
    )
    .unwrap_err();
    assert!(matches!(
        error,
        DbError::UniqueFieldConflict { model, field, value }
            if model == "employee" && field == "ref" && value == "EMP-1"
    ));
    let sequence_after_approval = db
        .client
        .query_one(
            "select last_value, is_called from change_set_lifecycle_order_seq",
            &[],
        )
        .unwrap();
    let sequence_after_approval: (i64, bool) = (
        sequence_after_approval.get(0),
        sequence_after_approval.get(1),
    );
    assert_eq!(sequence_after_approval, sequence_before_approval);
    let state = db
        .client
        .query_one(
            "select status, applied_order from change_set where id = $1",
            &[&draft.id],
        )
        .unwrap();
    assert_eq!(state.get::<_, String>("status"), "draft");
    assert!(state.get::<_, Option<i64>>("applied_order").is_none());
}

#[test]
fn revert_same_day_reopen_rejects_unique_field_conflicts() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = unique_ref_schema("customer_revert_unique");
    materialize_schema(&mut db.client, &schema).unwrap();

    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_revert_unique",
            Some("revert_unique_a_1"),
            vec![employee_write(
                "employee_a",
                "2026-01-01",
                Some(ref_values(Some("EMP-1"), "Alice")),
                false,
            )],
        ),
    )
    .unwrap();
    let changed = apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_revert_unique",
            Some("revert_unique_a_2"),
            vec![employee_write(
                "employee_a",
                "2026-01-01",
                Some(ref_values(Some("EMP-2"), "Alice")),
                false,
            )],
        ),
    )
    .unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_revert_unique",
            Some("revert_unique_b"),
            vec![employee_write(
                "employee_b",
                "2026-03-01",
                Some(ref_values(Some("EMP-1"), "Bob")),
                false,
            )],
        ),
    )
    .unwrap();

    let error = revert_change_set(
        &mut db.client,
        &revert_request(
            "customer_revert_unique",
            changed.id,
            Some("revert_unique_conflict"),
        ),
    )
    .unwrap_err();
    assert!(matches!(
        error,
        DbError::UniqueFieldConflict { model, field, value }
            if model == "employee" && field == "ref" && value == "EMP-1"
    ));
    let visible = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_revert_unique"),
        &ModelId::from("employee"),
        date("2026-03-15"),
    )
    .unwrap();
    let employee_a = visible
        .iter()
        .find(|record| record.external_key.as_deref() == Some("employee_a"))
        .unwrap();
    assert_eq!(
        employee_a.values.get(&FieldId::from("ref")),
        Some(&FieldValue::Text("EMP-2".to_string()))
    );
}

#[test]
fn materialize_schema_rejects_unique_index_drift() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = unique_ref_schema("customer_unique_drift");
    materialize_schema(&mut db.client, &schema).unwrap();

    db.client
        .batch_execute(
            r#"
            drop index employee_version_ref_live_unique_idx;
            create index employee_version_ref_live_unique_idx
              on employee_version (app_id, customer_id, ref);
            "#,
        )
        .unwrap();

    let error = materialize_schema(&mut db.client, &schema).unwrap_err();
    assert!(matches!(
        error,
        DbError::SchemaDrift { object, .. }
            if object == "employee_version.employee_version_ref_live_unique_idx"
    ));
}

#[test]
fn materialize_schema_rejects_removed_change_set_reason_column() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_a");
    materialize_schema(&mut db.client, &schema).unwrap();

    db.client
        .batch_execute("alter table change_set rename column notes to reason;")
        .unwrap();
    let error = materialize_schema(&mut db.client, &schema).unwrap_err();
    assert!(matches!(
        &error,
        DbError::SchemaDrift { object, .. } if object == "change_set.reason"
    ));
}

#[test]
fn agent_runs_are_recorded_and_required_for_agent_writes() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let mut backend = RustKernelBackend::new(&mut db.client);
    support::agent_run_scenarios::agent_runs_are_recorded_and_required_for_agent_writes(
        &mut backend,
    );
}

#[test]
fn agent_run_status_updates_are_terminal_and_idempotent() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let mut backend = RustKernelBackend::new(&mut db.client);
    support::agent_run_scenarios::agent_run_status_updates_are_terminal_and_idempotent(
        &mut backend,
    );
}

#[test]
fn materialize_schema_upgrades_agent_run_status_check_for_budget_exhausted() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let mut backend = RustKernelBackend::new(&mut db.client);
    support::agent_run_scenarios::materialize_schema_upgrades_agent_run_status_check_for_budget_exhausted(
        &mut backend,
    );
}

#[test]
fn agent_run_replay_survives_later_schema_activation() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let mut backend = RustKernelBackend::new(&mut db.client);
    support::agent_run_scenarios::agent_run_replay_survives_later_schema_activation(&mut backend);
}

#[test]
fn concurrent_agent_run_records_are_idempotent_or_conflicting() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let mut backend = RustKernelBackend::new(&mut db.client);
    support::agent_run_scenarios::concurrent_agent_run_records_are_idempotent_or_conflicting(
        &mut backend,
    );
}

#[test]
fn agent_run_provenance_fails_closed_when_schema_is_stale() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let mut backend = RustKernelBackend::new(&mut db.client);
    support::agent_run_scenarios::agent_run_provenance_fails_closed_when_schema_is_stale(
        &mut backend,
    );
}

#[test]
fn materialize_schema_rejects_removed_reverted_change_set_status_rows() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_a");
    materialize_schema(&mut db.client, &schema).unwrap();

    db.client
        .batch_execute(
            r#"
            alter table change_set drop constraint change_set_status_check;
            alter table change_set add constraint change_set_status_check
              check (status in ('draft', 'mainline', 'discarded', 'reverted'));
            insert into change_set (app_id, customer_id, schema_revision_id, created_with_mode, status, source_kind, created_order)
            select app_id, customer_id, id, 'draft', 'reverted', 'removed-status-test', nextval('change_set_lifecycle_order_seq')
            from schema_revision
            where customer_id = 'customer_a';
            "#,
        )
        .unwrap();

    let error = materialize_schema(&mut db.client, &schema).unwrap_err();
    assert!(matches!(
        &error,
        DbError::SchemaDrift { object, .. } if object == "change_set.status"
    ));
}

#[test]
fn materialize_schema_rejects_removed_reverted_change_set_status_check() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_a");
    materialize_schema(&mut db.client, &schema).unwrap();

    db.client
        .batch_execute(
            r#"
            alter table change_set drop constraint change_set_status_check;
            alter table change_set add constraint change_set_status_check
              check (status in ('draft', 'mainline', 'discarded', 'reverted'));
            "#,
        )
        .unwrap();

    let error = materialize_schema(&mut db.client, &schema).unwrap_err();
    assert!(matches!(
        &error,
        DbError::SchemaDrift { object, .. } if object == "change_set.status"
    ));
}

#[test]
fn materialize_schema_rejects_same_revision_with_different_schema_json() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let mut schema = test_schema("customer_a");
    materialize_schema(&mut db.client, &schema).unwrap();
    let existing_hash = schema_hash(&schema);

    schema.models[0].label = "Changed Company".to_string();
    let current_hash = schema_hash(&schema);
    let error = materialize_schema(&mut db.client, &schema).unwrap_err();
    assert!(matches!(
        error,
        DbError::SchemaRevisionConflict {
            existing_hash: actual_existing_hash,
            current_hash: actual_current_hash,
        } if actual_existing_hash == existing_hash && actual_current_hash == current_hash
    ));
}

#[test]
fn schema_revision_validation_returns_false_for_new_base_version() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_a");
    materialize_schema(&mut db.client, &schema).unwrap();

    let mut next_schema = schema.clone();
    next_schema.version = SchemaVersion::from("2026-05-05");
    next_schema.models[0].label = "Renamed Company".to_string();

    assert!(
        !schema_revision_is_active_with_materialized_tables(&mut db.client, &next_schema).unwrap()
    );
}

#[test]
fn materialize_schema_accepts_new_base_version_with_legacy_active_schema_json() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_legacy_active");
    materialize_schema(&mut db.client, &schema).unwrap();

    let mut legacy_schema_json = serde_json::to_value(&schema).expect("schema serializes");
    legacy_schema_json["models"][0]
        .as_object_mut()
        .expect("model serializes as object")
        .remove("kind");
    db.client
        .execute(
            r#"
            update schema_revision
            set base_schema = $1,
                schema = $1
            where app_id = $2
              and customer_id = $3
              and activated_at is not null
            "#,
            &[
                &legacy_schema_json,
                &schema.app_id.as_str(),
                &schema.customer_id.as_str(),
            ],
        )
        .unwrap();

    let mut next_schema = schema.clone();
    next_schema.version = SchemaVersion::from("2026-05-05");
    next_schema.models[0].label = "Renamed Company".to_string();

    materialize_schema(&mut db.client, &next_schema).unwrap();
    assert!(
        schema_revision_is_active_with_materialized_tables(&mut db.client, &next_schema).unwrap()
    );
}

#[test]
fn materialize_schema_repairs_same_revision_legacy_model_kind_json() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_legacy_model_kind");
    materialize_schema(&mut db.client, &schema).unwrap();

    let mut legacy_schema_json = serde_json::to_value(&schema).expect("schema serializes");
    for model in legacy_schema_json["models"]
        .as_array_mut()
        .expect("models serialize as an array")
    {
        model
            .as_object_mut()
            .expect("model serializes as object")
            .remove("kind");
    }
    db.client
        .execute(
            r#"
            update schema_revision
            set base_schema = $1,
                schema = $1
            where app_id = $2
              and customer_id = $3
              and activated_at is not null
            "#,
            &[
                &legacy_schema_json,
                &schema.app_id.as_str(),
                &schema.customer_id.as_str(),
            ],
        )
        .unwrap();

    materialize_schema(&mut db.client, &schema).unwrap();

    let row = db
        .client
        .query_one(
            r#"
            select base_schema, schema
            from schema_revision
            where app_id = $1
              and customer_id = $2
              and activated_at is not null
            "#,
            &[&schema.app_id.as_str(), &schema.customer_id.as_str()],
        )
        .unwrap();
    let stored_base_schema: serde_json::Value = row.get("base_schema");
    let stored_schema: serde_json::Value = row.get("schema");
    assert_eq!(
        stored_base_schema,
        serde_json::to_value(&schema).expect("schema serializes")
    );
    assert_eq!(
        stored_schema,
        serde_json::to_value(&schema).expect("schema serializes")
    );
    assert!(schema_revision_is_active_with_materialized_tables(&mut db.client, &schema).unwrap());
}

#[test]
fn schema_revision_validation_rejects_missing_metadata_columns() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_a");
    materialize_schema(&mut db.client, &schema).unwrap();
    db.client
        .batch_execute("alter table schema_revision drop column schema_hash;")
        .unwrap();

    let error =
        schema_revision_is_active_with_materialized_tables(&mut db.client, &schema).unwrap_err();
    assert!(matches!(
        &error,
        DbError::SchemaDrift { object, .. } if object == "schema_revision"
    ));
}

#[test]
fn schema_revision_validation_rejects_drifted_effective_schema_json() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_a");
    materialize_schema(&mut db.client, &schema).unwrap();
    let mut drifted_schema_json: serde_json::Value =
        serde_json::to_value(&schema).expect("schema serializes");
    drifted_schema_json["models"][0]["label"] = serde_json::Value::String("Drifted".to_string());
    db.client
        .execute(
            "update schema_revision set schema = $1 where activated_at is not null",
            &[&drifted_schema_json],
        )
        .unwrap();

    let error =
        schema_revision_is_active_with_materialized_tables(&mut db.client, &schema).unwrap_err();
    assert!(matches!(error, DbError::SchemaRevisionConflict { .. }));
}

#[test]
fn schema_revision_validation_rejects_drifted_model_table_contracts() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_a");
    materialize_schema(&mut db.client, &schema).unwrap();
    db.client
        .batch_execute("alter table employee_version drop column name;")
        .unwrap();

    let error =
        schema_revision_is_active_with_materialized_tables(&mut db.client, &schema).unwrap_err();
    assert!(matches!(
        &error,
        DbError::SchemaDrift { object, .. } if object.starts_with("employee_version")
    ));
}

#[test]
fn schema_revision_validation_rejects_missing_relation_fk_and_version_check() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_a");
    materialize_schema(&mut db.client, &schema).unwrap();
    db.client
        .batch_execute(
            r#"
            alter table employee_version drop constraint employee_version_employer_tenant_fk;
            alter table employee_version drop constraint employee_version_stage_check;
            "#,
        )
        .unwrap();

    let error =
        schema_revision_is_active_with_materialized_tables(&mut db.client, &schema).unwrap_err();
    assert!(matches!(
        &error,
        DbError::SchemaDrift { object, .. } if object == "employee_version.employee_version_employer_tenant_fk"
    ));
}

#[test]
fn materialize_schema_records_revision_hash_and_provenance() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_a");
    let provenance = SchemaRevisionProvenance {
        materialization_source: Some("test-materialize".to_string()),
        git_sha: Some("abc123".to_string()),
        vercel_deployment_id: Some("dpl_test".to_string()),
        vercel_environment: Some("preview".to_string()),
        vercel_git_ref: Some("feature/test".to_string()),
    };

    materialize_schema_with_provenance(&mut db.client, &schema, Some(&provenance)).unwrap();

    let row = db
        .client
        .query_one(
            r#"
            select
              schema_hash,
              materialization_source,
              materialization_git_sha,
              materialization_vercel_deployment_id,
              materialization_vercel_environment,
              materialization_vercel_git_ref,
              materialized_at is not null as has_materialized_at
            from schema_revision
            where app_id = $1 and customer_id = $2 and version = $3
            "#,
            &[
                &schema.app_id.as_str(),
                &schema.customer_id.as_str(),
                &schema.version.as_str(),
            ],
        )
        .unwrap();

    assert_eq!(row.get::<_, String>("schema_hash"), schema_hash(&schema));
    assert_eq!(
        row.get::<_, Option<String>>("materialization_source"),
        provenance.materialization_source
    );
    assert_eq!(
        row.get::<_, Option<String>>("materialization_git_sha"),
        provenance.git_sha
    );
    assert_eq!(
        row.get::<_, Option<String>>("materialization_vercel_deployment_id"),
        provenance.vercel_deployment_id
    );
    assert_eq!(
        row.get::<_, Option<String>>("materialization_vercel_environment"),
        provenance.vercel_environment
    );
    assert_eq!(
        row.get::<_, Option<String>>("materialization_vercel_git_ref"),
        provenance.vercel_git_ref
    );
    assert!(row.get::<_, bool>("has_materialized_at"));
}

#[test]
fn materialize_schema_without_provenance_preserves_existing_revision_provenance() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_a");
    let provenance = SchemaRevisionProvenance {
        materialization_source: Some("test-materialize".to_string()),
        git_sha: Some("abc123".to_string()),
        vercel_deployment_id: Some("dpl_test".to_string()),
        vercel_environment: Some("preview".to_string()),
        vercel_git_ref: Some("feature/test".to_string()),
    };

    materialize_schema_with_provenance(&mut db.client, &schema, Some(&provenance)).unwrap();
    materialize_schema(&mut db.client, &schema).unwrap();

    let row = db
        .client
        .query_one(
            r#"
            select
              materialization_source,
              materialization_git_sha,
              materialization_vercel_deployment_id,
              materialization_vercel_environment,
              materialization_vercel_git_ref
            from schema_revision
            where app_id = $1 and customer_id = $2 and version = $3
            "#,
            &[
                &schema.app_id.as_str(),
                &schema.customer_id.as_str(),
                &schema.version.as_str(),
            ],
        )
        .unwrap();

    assert_eq!(
        row.get::<_, Option<String>>("materialization_source"),
        provenance.materialization_source
    );
    assert_eq!(
        row.get::<_, Option<String>>("materialization_git_sha"),
        provenance.git_sha
    );
    assert_eq!(
        row.get::<_, Option<String>>("materialization_vercel_deployment_id"),
        provenance.vercel_deployment_id
    );
    assert_eq!(
        row.get::<_, Option<String>>("materialization_vercel_environment"),
        provenance.vercel_environment
    );
    assert_eq!(
        row.get::<_, Option<String>>("materialization_vercel_git_ref"),
        provenance.vercel_git_ref
    );
}

#[test]
fn materialize_schema_after_runtime_overlay_preserves_runtime_revision_hash() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = declared_enum_schema("customer_runtime_hash");
    let baseline_revision_id = materialize_schema(&mut db.client, &schema).unwrap();
    commit_enum_option_set_revision(
        &mut db.client,
        &CommitEnumOptionSetRevision {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from("customer_runtime_hash"),
            baseline_revision_id,
            target: EnumOptionSetTarget::Declared {
                model_id: ModelId::from("employee"),
                field_id: FieldId::from("status"),
            },
            options: vec![
                EnumOption {
                    id: EnumOptionId::from("active"),
                    label: "Active".to_string(),
                    aliases: vec!["current".to_string()],

                    ..Default::default()
                },
                EnumOption {
                    id: EnumOptionId::from("inactive"),
                    label: "Inactive".to_string(),
                    aliases: vec![],

                    ..Default::default()
                },
                EnumOption {
                    id: EnumOptionId::from("leave"),
                    label: "Leave".to_string(),
                    aliases: vec![],

                    ..Default::default()
                },
            ],
        },
    )
    .unwrap();
    let before = db
        .client
        .query_one(
            "select version, schema_hash, schema from schema_revision where activated_at is not null",
            &[],
        )
        .unwrap();
    let runtime_version = before.get::<_, String>("version");
    let runtime_hash = before.get::<_, String>("schema_hash");
    let runtime_schema_json = before.get::<_, serde_json::Value>("schema");
    assert_ne!(runtime_version, schema.version.as_str());
    assert_ne!(runtime_hash, schema_hash(&schema));

    materialize_schema_with_provenance(
        &mut db.client,
        &schema,
        Some(&SchemaRevisionProvenance {
            materialization_source: Some("test-runtime-overlay-rematerialize".to_string()),
            git_sha: None,
            vercel_deployment_id: None,
            vercel_environment: None,
            vercel_git_ref: None,
        }),
    )
    .unwrap();

    let after = db
        .client
        .query_one(
            "select version, schema_hash, schema from schema_revision where activated_at is not null",
            &[],
        )
        .unwrap();
    assert_eq!(after.get::<_, String>("version"), runtime_version);
    assert_eq!(after.get::<_, String>("schema_hash"), runtime_hash);
    assert_eq!(
        after.get::<_, serde_json::Value>("schema"),
        runtime_schema_json
    );
}

#[test]
fn materialize_schema_sets_tenant_scope_before_forced_rls_writes() {
    let Some(mut db) = TestDb::connect_owned_by_non_bypass_role() else {
        return;
    };
    let schema = test_schema("customer_a");

    materialize_schema(&mut db.client, &schema).unwrap();
    db.client
        .query_one(
            "select set_config('platform.app_id', $1, false)",
            &[&"core_app"],
        )
        .unwrap();
    db.client
        .query_one(
            "select set_config('platform.customer_id', $1, false)",
            &[&"customer_a"],
        )
        .unwrap();
    let count: i64 = db
        .client
        .query_one("select count(*) from schema_revision", &[])
        .unwrap()
        .get(0);
    assert_eq!(count, 1);
}

#[test]
fn concurrent_materialize_schema_serializes_shared_substrate_ddl() {
    let Some(db) = TestDb::connect() else {
        return;
    };
    let schema_name = db.schema_name.clone();
    let first_schema_name = schema_name.clone();
    let second_schema_name = schema_name.clone();
    let barrier = Arc::new(Barrier::new(2));
    let first_barrier = Arc::clone(&barrier);
    let second_barrier = Arc::clone(&barrier);

    let first = thread::spawn(move || {
        let mut client = connect_to_test_schema(&first_schema_name);
        first_barrier.wait();
        materialize_schema(&mut client, &single_model_schema("customer_a", "contract"))
            .map(|_| ())
            .map_err(|error| format!("{error:?}"))
    });
    let second = thread::spawn(move || {
        let mut client = connect_to_test_schema(&second_schema_name);
        second_barrier.wait();
        materialize_schema(&mut client, &single_model_schema("customer_b", "invoice"))
            .map(|_| ())
            .map_err(|error| format!("{error:?}"))
    });

    first.join().unwrap().unwrap();
    second.join().unwrap().unwrap();
}

#[test]
fn concurrent_materialization_acquires_query_role_before_catalog_relations() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let customer_id = "customer_query_role_lock_order";
    let baseline = test_schema(customer_id);
    materialize_schema(&mut db.client, &baseline).unwrap();

    let mut target = baseline;
    target.version = SchemaVersion::from("2026-08-05.query-role-order");
    let mut materializer_client = connect_to_test_schema(&db.schema_name);
    let materializer_pid: i32 = materializer_client
        .query_one("select pg_backend_pid()", &[])
        .unwrap()
        .get(0);
    let mut blocker = connect_to_test_schema(&db.schema_name);
    let mut blocker = blocker.transaction().unwrap();
    blocker
        .query_one(
            "select pg_advisory_xact_lock(hashtext('kernel_query'))",
            &[],
        )
        .unwrap();
    let materializer = thread::spawn(move || {
        materialize_schema(&mut materializer_client, &target)
            .map(|_| ())
            .map_err(|error| format!("{error:?}"))
    });
    wait_for_backend_lock(
        &mut db.client,
        materializer_pid,
        "pg_advisory_xact_lock",
        "materializer",
    );

    let relation_lock = blocker.batch_execute("lock table change_set in access share mode");
    let blocker_result = blocker.commit();
    let materializer_result = materializer.join().unwrap();

    relation_lock.expect("query-role wait must precede materialization relation locks");
    blocker_result.unwrap();
    materializer_result.unwrap();
}

#[test]
fn concurrent_apply_acquires_activation_lock_before_schema_relations() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let customer_id = "customer_activation_lock_order";
    let baseline = test_schema(customer_id);
    materialize_schema(&mut db.client, &baseline).unwrap();

    let mut target = baseline;
    target.version = SchemaVersion::from("2026-08-05.activation-order");
    let mut materializer_client = connect_to_test_schema(&db.schema_name);
    let (guard_locked_tx, guard_locked_rx) = mpsc::channel();
    let (release_guard_tx, release_guard_rx) = mpsc::channel();
    let materializer = thread::spawn(move || {
        materialize_schema_with_provenance_guarded(
            &mut materializer_client,
            &target,
            &SchemaRevisionProvenance::default(),
            |_| {
                guard_locked_tx.send(()).unwrap();
                release_guard_rx.recv().unwrap();
                Ok(())
            },
        )
        .map(|_| ())
        .map_err(|error| format!("{error:?}"))
    });
    guard_locked_rx
        .recv_timeout(StdDuration::from_secs(2))
        .expect("guarded materializer acquires the activation writer lock");

    let schema_name = db.schema_name.clone();
    let (writer_pid_tx, writer_pid_rx) = mpsc::channel();
    let writer = thread::spawn(move || {
        let mut client = connect_to_test_schema(&schema_name);
        let pid: i32 = client
            .query_one("select pg_backend_pid()", &[])
            .unwrap()
            .get(0);
        writer_pid_tx.send(pid).unwrap();
        apply_change_set(
            &mut client,
            &mainline_apply(
                customer_id,
                Some("activation-lock-order-write"),
                vec![RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                    effective_start: date("2026-08-05"),
                    values: Some(text_values("Acme")),
                    custom_fields: None,
                    clear_fields: vec![],
                    clear_custom_fields: vec![],
                    metadata_patch: None,
                    expected_version_id: None,
                    tombstones_record: false,
                    provenance: None,
                }],
            ),
        )
        .map(|_| ())
        .map_err(|error| format!("{error:?}"))
    });
    let writer_pid = writer_pid_rx.recv().unwrap();
    wait_for_backend_lock(
        &mut db.client,
        writer_pid,
        "pg_advisory_xact_lock_shared",
        "writer",
    );

    release_guard_tx.send(()).unwrap();
    let materializer_result = materializer.join().unwrap();
    let writer_result = writer.join().unwrap();

    materializer_result.unwrap();
    writer_result.unwrap();
}

#[test]
fn caller_owned_apply_rejects_autocommit_client_before_relation_work() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let customer_id = "customer_caller_owned_transaction_required";
    materialize_schema(&mut db.client, &test_schema(customer_id)).unwrap();

    let error = apply_change_set_in_transaction(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("caller-owned-without-transaction"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-08-05"),
                values: Some(text_values("Acme")),
                custom_fields: None,
                clear_fields: vec![],
                clear_custom_fields: vec![],
                metadata_patch: None,
                expected_version_id: None,
                tombstones_record: false,
                provenance: None,
            }],
        ),
    )
    .unwrap_err();
    assert_eq!(
        validation_codes(error),
        vec!["caller_owned_transaction_required"]
    );
    let change_sets: i64 = db
        .client
        .query_one(
            "select count(*) from change_set where app_id = 'core_app' and customer_id = $1",
            &[&customer_id],
        )
        .unwrap()
        .get(0);
    assert_eq!(change_sets, 0);
}

#[test]
fn caller_owned_apply_holds_activation_reader_until_outer_transaction_ends() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let customer_id = "customer_caller_owned_activation_lifetime";
    let baseline = test_schema(customer_id);
    materialize_schema(&mut db.client, &baseline).unwrap();
    let mut observer = connect_to_test_schema(&db.schema_name);

    let mut outer = begin_tenant_transaction(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from(customer_id),
    )
    .unwrap();
    apply_change_set_in_transaction(
        &mut outer,
        &mainline_apply(
            customer_id,
            Some("caller-owned-activation-lifetime"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-08-05"),
                values: Some(text_values("Acme")),
                custom_fields: None,
                clear_fields: vec![],
                clear_custom_fields: vec![],
                metadata_patch: None,
                expected_version_id: None,
                tombstones_record: false,
                provenance: None,
            }],
        ),
    )
    .unwrap();

    let mut target = baseline;
    target.version = SchemaVersion::from("2026-08-05.caller-owned-lock-lifetime");
    let mut materializer_client = connect_to_test_schema(&db.schema_name);
    let materializer_pid: i32 = materializer_client
        .query_one("select pg_backend_pid()", &[])
        .unwrap()
        .get(0);
    let (guard_entered_tx, guard_entered_rx) = mpsc::channel();
    let materializer = thread::spawn(move || {
        materialize_schema_with_provenance_guarded(
            &mut materializer_client,
            &target,
            &SchemaRevisionProvenance::default(),
            |_| {
                guard_entered_tx.send(()).unwrap();
                Ok(())
            },
        )
        .map(|_| ())
        .map_err(|error| format!("{error:?}"))
    });
    wait_for_backend_lock(
        &mut observer,
        materializer_pid,
        "pg_advisory_xact_lock",
        "materializer waiting for caller-owned activation reader",
    );
    assert!(matches!(
        guard_entered_rx.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));

    outer.commit().unwrap();
    guard_entered_rx
        .recv_timeout(StdDuration::from_secs(2))
        .expect("materializer proceeds after the caller-owned transaction commits");
    materializer.join().unwrap().unwrap();
}

#[test]
fn independent_postgres_schemas_materialize_while_peer_is_guarded() {
    let Some(mut first_db) = TestDb::connect() else {
        return;
    };
    let Some(mut second_db) = TestDb::connect() else {
        return;
    };
    let mut first_target = test_schema("customer_independent_first");
    let mut second_target = test_schema("customer_independent_second");
    materialize_schema(&mut first_db.client, &first_target).unwrap();
    materialize_schema(&mut second_db.client, &second_target).unwrap();
    first_target.version = SchemaVersion::from("2026-08-05.independent-first");
    second_target.version = SchemaVersion::from("2026-08-05.independent-second");

    let mut first_client = connect_to_test_schema(&first_db.schema_name);
    let (guard_locked_tx, guard_locked_rx) = mpsc::channel();
    let (release_guard_tx, release_guard_rx) = mpsc::channel();
    let first = thread::spawn(move || {
        materialize_schema_with_provenance_guarded(
            &mut first_client,
            &first_target,
            &SchemaRevisionProvenance::default(),
            |_| {
                guard_locked_tx.send(()).unwrap();
                release_guard_rx.recv().unwrap();
                Ok(())
            },
        )
        .map(|_| ())
        .map_err(|error| format!("{error:?}"))
    });
    guard_locked_rx
        .recv_timeout(StdDuration::from_secs(2))
        .expect("first schema reaches its guarded materialization section");

    let mut second_client = connect_to_test_schema(&second_db.schema_name);
    let (second_done_tx, second_done_rx) = mpsc::channel();
    let second = thread::spawn(move || {
        let result = materialize_schema(&mut second_client, &second_target)
            .map(|_| ())
            .map_err(|error| format!("{error:?}"));
        second_done_tx.send(result).unwrap();
    });
    second_done_rx
        .recv_timeout(StdDuration::from_secs(5))
        .expect("independent schema materialization must not wait for its guarded peer")
        .unwrap();

    release_guard_tx.send(()).unwrap();
    first.join().unwrap().unwrap();
    second.join().unwrap();
}

#[test]
fn concurrent_materialize_schema_serializes_same_tenant_activation() {
    let Some(db) = TestDb::connect() else {
        return;
    };
    let schema_name = db.schema_name.clone();
    let first_schema_name = schema_name.clone();
    let second_schema_name = schema_name.clone();
    let barrier = Arc::new(Barrier::new(2));
    let first_barrier = Arc::clone(&barrier);
    let second_barrier = Arc::clone(&barrier);

    let first = thread::spawn(move || {
        let mut client = connect_to_test_schema(&first_schema_name);
        first_barrier.wait();
        materialize_schema(
            &mut client,
            &single_model_schema_with_version("customer_a", "contract", "2026-05-04"),
        )
        .map(|_| ())
        .map_err(|error| format!("{error:?}"))
    });
    let second = thread::spawn(move || {
        let mut client = connect_to_test_schema(&second_schema_name);
        second_barrier.wait();
        materialize_schema(
            &mut client,
            &single_model_schema_with_version("customer_a", "invoice", "2026-05-05"),
        )
        .map(|_| ())
        .map_err(|error| format!("{error:?}"))
    });

    first.join().unwrap().unwrap();
    second.join().unwrap().unwrap();
}

#[test]
fn mainline_apply_creates_updates_backdates_and_reads_visible_snapshots() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_a");
    materialize_schema(&mut db.client, &schema).unwrap();

    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("company-create"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("employee-create"),
            vec![RowVersionWrite {
                model_id: ModelId::from("employee"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alice"))),
                effective_start: date("2026-05-01"),
                values: Some(employee_values(
                    "Alice",
                    RecordKey::ExternalKey(ExternalKey::from("acme")),
                )),
                custom_fields: None,
                tombstones_record: false,
                provenance: Some(serde_json::json!({"source": "unit"})),

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("employee-update"),
            vec![RowVersionWrite {
                model_id: ModelId::from("employee"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alice"))),
                effective_start: date("2026-06-01"),
                values: Some(text_values("Alicia")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("employee-backdate"),
            vec![RowVersionWrite {
                model_id: ModelId::from("employee"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alice"))),
                effective_start: date("2026-04-01"),
                values: Some(text_values("A.")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    let april = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        &ModelId::from("employee"),
        date("2026-04-15"),
    )
    .unwrap();
    assert_eq!(april.len(), 1);
    assert_eq!(
        april[0].values.get(&FieldId::from("name")),
        Some(&FieldValue::Text("A.".to_string()))
    );

    let may = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        &ModelId::from("employee"),
        date("2026-05-15"),
    )
    .unwrap();
    assert_eq!(
        may[0].values.get(&FieldId::from("name")),
        Some(&FieldValue::Text("Alice".to_string()))
    );

    let june = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        &ModelId::from("employee"),
        date("2026-06-15"),
    )
    .unwrap();
    assert_eq!(
        june[0].values.get(&FieldId::from("name")),
        Some(&FieldValue::Text("Alicia".to_string()))
    );
    assert!(june[0].values.contains_key(&FieldId::from("employer")));
    assert!(june[0].values.contains_key(&FieldId::from("comp_rate")));
}

#[test]
fn known_aliases_materializes_and_round_trips_as_text_list() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = Schema {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from("customer_aliases"),
        version: SchemaVersion::from("2026-05-04"),
        models: vec![Model {
            id: ModelId::from("department"),
            kind: ModelKind::Entity,
            label: "Department".to_string(),
            fields: vec![
                Field {
                    id: FieldId::from("name"),
                    label: "Name".to_string(),
                    field_type: FieldType::Text,
                    required: true,
                    is_unique: false,
                    target_model: None,
                    option_set: vec![],

                    ..Default::default()
                },
                Field {
                    id: FieldId::from("known_aliases"),
                    label: "Aliases".to_string(),
                    field_type: FieldType::KnownAliases,
                    required: false,
                    is_unique: false,
                    target_model: None,
                    option_set: vec![],

                    ..Default::default()
                },
            ],

            ..Default::default()
        }],
        custom_fields: vec![],
        change_types: vec![],
    };
    materialize_schema(&mut db.client, &schema).unwrap();

    let alias_column = db
        .client
        .query_one(
            "select data_type, udt_name from information_schema.columns where table_schema = current_schema() and table_name = 'department_version' and column_name = 'known_aliases'",
            &[],
        )
        .unwrap();
    assert_eq!(alias_column.get::<_, String>("data_type"), "ARRAY");
    assert_eq!(alias_column.get::<_, String>("udt_name"), "_text");

    let mut values = text_values("Engineering");
    values.insert(
        FieldId::from("known_aliases"),
        FieldValue::TextList(vec!["Eng".to_string(), "engineering team".to_string()]),
    );
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_aliases",
            Some("department-aliases"),
            vec![RowVersionWrite {
                model_id: ModelId::from("department"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("engineering"))),
                effective_start: date("2026-05-01"),
                values: Some(values),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    let visible = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_aliases"),
        &ModelId::from("department"),
        date("2026-05-15"),
    )
    .unwrap();
    assert_eq!(visible.len(), 1);
    assert_eq!(
        visible[0].values.get(&FieldId::from("known_aliases")),
        Some(&FieldValue::TextList(vec![
            "Eng".to_string(),
            "engineering team".to_string(),
        ]))
    );
}

#[test]
fn iso_fields_materialize_and_round_trip_as_text() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = Schema {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from("customer_iso_fields"),
        version: SchemaVersion::from("2026-06-27"),
        models: vec![Model {
            id: ModelId::from("employee"),
            kind: ModelKind::Entity,
            label: "Employee".to_string(),
            fields: vec![
                Field {
                    id: FieldId::from("name"),
                    label: "Name".to_string(),
                    field_type: FieldType::Text,
                    required: true,
                    is_unique: false,
                    target_model: None,
                    option_set: vec![],

                    ..Default::default()
                },
                Field {
                    id: FieldId::from("country"),
                    label: "Country".to_string(),
                    field_type: FieldType::IsoCountry,
                    required: false,
                    is_unique: false,
                    target_model: None,
                    option_set: vec![],

                    ..Default::default()
                },
                Field {
                    id: FieldId::from("currency"),
                    label: "Currency".to_string(),
                    field_type: FieldType::IsoCurrency,
                    required: false,
                    is_unique: false,
                    target_model: None,
                    option_set: vec![],

                    ..Default::default()
                },
            ],

            ..Default::default()
        }],
        custom_fields: vec![],
        change_types: vec![],
    };
    materialize_schema(&mut db.client, &schema).unwrap();

    for column_name in ["country", "currency"] {
        let column = db
            .client
            .query_one(
                "select data_type, udt_name from information_schema.columns where table_schema = current_schema() and table_name = 'employee_version' and column_name = $1",
                &[&column_name],
            )
            .unwrap();
        assert_eq!(column.get::<_, String>("data_type"), "text");
        assert_eq!(column.get::<_, String>("udt_name"), "text");
    }

    let mut values = text_values("Alice");
    values.insert(FieldId::from("country"), FieldValue::Text("US".to_string()));
    values.insert(
        FieldId::from("currency"),
        FieldValue::Text("USD".to_string()),
    );
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_iso_fields",
            Some("employee-iso-fields"),
            vec![RowVersionWrite {
                model_id: ModelId::from("employee"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alice"))),
                effective_start: date("2026-06-27"),
                values: Some(values),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    let visible = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_iso_fields"),
        &ModelId::from("employee"),
        date("2026-06-27"),
    )
    .unwrap();
    assert_eq!(visible.len(), 1);
    assert_eq!(
        visible[0].values.get(&FieldId::from("country")),
        Some(&FieldValue::Text("US".to_string()))
    );
    assert_eq!(
        visible[0].values.get(&FieldId::from("currency")),
        Some(&FieldValue::Text("USD".to_string()))
    );
}

#[test]
fn enum_field_materializes_round_trips_and_orphan_options_render_null() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };

    let enum_options = vec![
        EnumOption {
            id: EnumOptionId::from("active"),
            label: "Active".to_string(),
            aliases: vec!["current".to_string()],

            ..Default::default()
        },
        EnumOption {
            id: EnumOptionId::from("inactive"),
            label: "Inactive".to_string(),
            aliases: vec![],

            ..Default::default()
        },
    ];
    let schema = Schema {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from("customer_enum"),
        version: SchemaVersion::from("2026-05-04"),
        models: vec![Model {
            id: ModelId::from("employee"),
            kind: ModelKind::Entity,
            label: "Employee".to_string(),
            fields: vec![
                Field {
                    id: FieldId::from("name"),
                    label: "Name".to_string(),
                    field_type: FieldType::Text,
                    required: true,
                    is_unique: false,
                    target_model: None,
                    option_set: vec![],

                    ..Default::default()
                },
                Field {
                    id: FieldId::from("status"),
                    label: "Status".to_string(),
                    field_type: FieldType::Enum,
                    required: false,
                    is_unique: false,
                    target_model: None,
                    option_set: enum_options,

                    ..Default::default()
                },
            ],

            ..Default::default()
        }],
        custom_fields: vec![],
        change_types: vec![],
    };
    materialize_schema(&mut db.client, &schema).unwrap();

    let status_column = db
        .client
        .query_one(
            "select data_type, udt_name from information_schema.columns where table_schema = current_schema() and table_name = 'employee_version' and column_name = 'status'",
            &[],
        )
        .unwrap();
    assert_eq!(status_column.get::<_, String>("data_type"), "text");
    assert_eq!(status_column.get::<_, String>("udt_name"), "text");

    let mut values = text_values("Alice");
    values.insert(
        FieldId::from("status"),
        FieldValue::Enum(EnumOptionId::from("active")),
    );
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_enum",
            Some("employee-enum"),
            vec![RowVersionWrite {
                model_id: ModelId::from("employee"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alice"))),
                effective_start: date("2026-05-01"),
                values: Some(values),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    let visible = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_enum"),
        &ModelId::from("employee"),
        date("2026-05-15"),
    )
    .unwrap();
    assert_eq!(
        visible[0].values.get(&FieldId::from("status")),
        Some(&FieldValue::Enum(EnumOptionId::from("active")))
    );

    let mut orphaning_schema = schema;
    orphaning_schema.version = SchemaVersion::from("2026-05-05");
    orphaning_schema.models[0].fields[1].option_set = vec![EnumOption {
        id: EnumOptionId::from("inactive"),
        label: "Inactive".to_string(),
        aliases: vec![],

        ..Default::default()
    }];
    materialize_schema(&mut db.client, &orphaning_schema).unwrap();

    let visible_after_orphan = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_enum"),
        &ModelId::from("employee"),
        date("2026-05-15"),
    )
    .unwrap();
    assert!(!visible_after_orphan[0]
        .values
        .contains_key(&FieldId::from("status")));
}

#[test]
fn enum_option_set_revision_declared_overlay_normalizes_and_accepts_new_option() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };

    let schema = declared_enum_schema("customer_declared_runtime_enum");
    let baseline_revision_id = materialize_schema(&mut db.client, &schema).unwrap();
    let returned = commit_enum_option_set_revision(
        &mut db.client,
        &CommitEnumOptionSetRevision {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from("customer_declared_runtime_enum"),
            baseline_revision_id,
            target: EnumOptionSetTarget::Declared {
                model_id: ModelId::from("employee"),
                field_id: FieldId::from("status"),
            },
            options: vec![
                EnumOption {
                    id: EnumOptionId::from("active"),
                    label: "Active".to_string(),
                    aliases: vec!["current".to_string()],

                    ..Default::default()
                },
                EnumOption {
                    id: EnumOptionId::from("inactive"),
                    label: "Inactive".to_string(),
                    aliases: vec![],

                    ..Default::default()
                },
                EnumOption {
                    id: EnumOptionId::from("On Leave"),
                    label: "On Leave".to_string(),
                    aliases: vec!["leave".to_string()],

                    ..Default::default()
                },
            ],
        },
    )
    .unwrap();
    assert_eq!(
        returned
            .iter()
            .map(|option| option.id.as_str())
            .collect::<Vec<_>>(),
        vec!["active", "inactive", "on_leave"]
    );

    let active_version: String = db
        .client
        .query_one(
            "select version from schema_revision where activated_at is not null",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(active_version, "2026-05-04+r1");

    let mut values = text_values("Alice");
    values.insert(
        FieldId::from("status"),
        FieldValue::Enum(EnumOptionId::from("on_leave")),
    );
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_declared_runtime_enum",
            Some("employee-runtime-enum"),
            vec![RowVersionWrite {
                model_id: ModelId::from("employee"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alice"))),
                effective_start: date("2026-05-01"),
                values: Some(values),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    let visible = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_declared_runtime_enum"),
        &ModelId::from("employee"),
        date("2026-05-15"),
    )
    .unwrap();
    assert_eq!(
        visible[0].values.get(&FieldId::from("status")),
        Some(&FieldValue::Enum(EnumOptionId::from("on_leave")))
    );
}

// A custom field that an older runtime let reuse a declared field id stays
// writable: native writes tolerate collisions the active revision already
// has, while a new base still may not add one.
#[test]
fn enum_option_set_revision_tolerates_only_existing_custom_field_collisions() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let customer_id = "customer_existing_collision";
    let schema = custom_fields_schema(customer_id);
    let baseline_revision_id = materialize_schema(&mut db.client, &schema).unwrap();
    let existing = custom_field_definition("employee_employer", "employer", CustomFieldType::Text);
    let existing_json = serde_json::to_value(&existing).expect("custom field serializes");
    db.client
        .execute(
            "update schema_revision set
               base_schema = jsonb_set(base_schema, '{custom_fields}', base_schema->'custom_fields' || jsonb_build_array($1::jsonb)),
               schema = jsonb_set(schema, '{custom_fields}', schema->'custom_fields' || jsonb_build_array($1::jsonb))
             where id = $2",
            &[&existing_json, &baseline_revision_id.get()],
        )
        .unwrap();

    let returned = commit_enum_option_set_revision(
        &mut db.client,
        &CommitEnumOptionSetRevision {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from(customer_id),
            baseline_revision_id,
            target: EnumOptionSetTarget::Custom {
                model_id: ModelId::from("employee"),
                field_id: FieldId::from("shirt_size"),
            },
            options: vec![EnumOption {
                id: EnumOptionId::from("medium"),
                label: "Medium".to_string(),
                aliases: vec![],

                ..Default::default()
            }],
        },
    )
    .unwrap();
    assert_eq!(returned[0].id, EnumOptionId::from("medium"));

    let mut colliding_base = schema.clone();
    colliding_base.version = SchemaVersion::from("2026-05-05");
    colliding_base.custom_fields.push(custom_field_definition(
        "employee_comp_rate",
        "comp_rate",
        CustomFieldType::Number,
    ));
    assert_eq!(
        validation_codes(materialize_schema(&mut db.client, &colliding_base).unwrap_err()),
        vec!["custom_field_declared_field_collision"]
    );
}

#[test]
fn enum_option_set_revision_does_not_repair_unrelated_stale_version_columns() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };

    let schema = declared_enum_schema("customer_declared_runtime_enum_no_repair");
    let baseline_revision_id = materialize_schema(&mut db.client, &schema).unwrap();
    db.client
        .batch_execute("alter table company_version add column stale_runtime_edit_probe text;")
        .unwrap();

    let error = commit_enum_option_set_revision(
        &mut db.client,
        &CommitEnumOptionSetRevision {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from("customer_declared_runtime_enum_no_repair"),
            baseline_revision_id,
            target: EnumOptionSetTarget::Declared {
                model_id: ModelId::from("employee"),
                field_id: FieldId::from("status"),
            },
            options: vec![
                EnumOption {
                    id: EnumOptionId::from("active"),
                    label: "Active".to_string(),
                    aliases: vec!["current".to_string()],

                    ..Default::default()
                },
                EnumOption {
                    id: EnumOptionId::from("inactive"),
                    label: "Inactive".to_string(),
                    aliases: vec![],

                    ..Default::default()
                },
                EnumOption {
                    id: EnumOptionId::from("contractor"),
                    label: "Contractor".to_string(),
                    aliases: vec![],

                    ..Default::default()
                },
            ],
        },
    )
    .unwrap_err();
    assert!(
        matches!(error, DbError::SchemaDrift { .. }),
        "runtime enum edits should fail closed on storage drift, got {error:?}"
    );
    let stale_column_exists: bool = db
        .client
        .query_one(
            r#"
            select exists (
              select 1
              from information_schema.columns
              where table_schema = current_schema()
                and table_name = 'company_version'
                and column_name = 'stale_runtime_edit_probe'
            )
            "#,
            &[],
        )
        .unwrap()
        .get(0);
    assert!(stale_column_exists);
}

#[test]
fn enum_option_set_revision_custom_overlay_normalizes_and_accepts_new_option() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };

    let schema = custom_fields_schema("customer_custom_runtime_enum");
    let baseline_revision_id = materialize_schema(&mut db.client, &schema).unwrap();
    let returned = commit_enum_option_set_revision(
        &mut db.client,
        &CommitEnumOptionSetRevision {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from("customer_custom_runtime_enum"),
            baseline_revision_id,
            target: EnumOptionSetTarget::Custom {
                model_id: ModelId::from("employee"),
                field_id: FieldId::from("shirt_size"),
            },
            options: vec![EnumOption {
                id: EnumOptionId::from("Extra Large"),
                label: "Extra Large".to_string(),
                aliases: vec!["xl".to_string()],

                ..Default::default()
            }],
        },
    )
    .unwrap();
    assert_eq!(returned[0].id, EnumOptionId::from("extra_large"));

    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_custom_runtime_enum",
            Some("runtime-custom-company"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_custom_runtime_enum",
            Some("runtime-custom-employee"),
            vec![RowVersionWrite {
                model_id: ModelId::from("employee"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alice"))),
                effective_start: date("2026-05-01"),
                values: Some(employee_values(
                    "Alice",
                    RecordKey::ExternalKey(ExternalKey::from("acme")),
                )),
                custom_fields: Some(vec![custom_field_entry(
                    "shirt_size",
                    CustomFieldValue::Enum(EnumOptionId::from("extra_large")),
                )]),
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
}

#[test]
fn enum_option_set_revision_customer_removal_renders_declared_addition_and_custom_values_null() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };

    let mut schema = declared_enum_schema("customer_runtime_orphan");
    schema.custom_fields = custom_fields_schema("customer_runtime_orphan").custom_fields;
    schema
        .models
        .iter_mut()
        .find(|model| model.id == ModelId::from("employee"))
        .expect("employee model")
        .extensions
        .typed_custom_fields = true;
    let baseline_revision_id = materialize_schema(&mut db.client, &schema).unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_runtime_orphan",
            Some("runtime-orphan-company"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    let first_runtime_options = commit_enum_option_set_revision(
        &mut db.client,
        &CommitEnumOptionSetRevision {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from("customer_runtime_orphan"),
            baseline_revision_id,
            target: EnumOptionSetTarget::Declared {
                model_id: ModelId::from("employee"),
                field_id: FieldId::from("status"),
            },
            options: vec![
                EnumOption {
                    id: EnumOptionId::from("active"),
                    label: "Active".to_string(),
                    aliases: vec!["current".to_string()],

                    ..Default::default()
                },
                EnumOption {
                    id: EnumOptionId::from("inactive"),
                    label: "Inactive".to_string(),
                    aliases: vec![],

                    ..Default::default()
                },
                EnumOption {
                    id: EnumOptionId::from("contractor"),
                    label: "Contractor".to_string(),
                    aliases: vec![],

                    ..Default::default()
                },
            ],
        },
    )
    .unwrap();
    assert_eq!(
        first_runtime_options
            .iter()
            .map(|option| option.id.as_str())
            .collect::<Vec<_>>(),
        vec!["active", "inactive", "contractor"]
    );

    let mut values = employee_values("Alice", RecordKey::ExternalKey(ExternalKey::from("acme")));
    values.insert(
        FieldId::from("status"),
        FieldValue::Enum(EnumOptionId::from("contractor")),
    );
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_runtime_orphan",
            Some("runtime-orphan-employee"),
            vec![RowVersionWrite {
                model_id: ModelId::from("employee"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alice"))),
                effective_start: date("2026-05-01"),
                values: Some(values),
                custom_fields: Some(vec![custom_field_entry(
                    "shirt_size",
                    CustomFieldValue::Enum(EnumOptionId::from("large")),
                )]),
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    let runtime_revision_id: i64 = db
        .client
        .query_one(
            "select id from schema_revision where activated_at is not null",
            &[],
        )
        .unwrap()
        .get(0);
    commit_enum_option_set_revision(
        &mut db.client,
        &CommitEnumOptionSetRevision {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from("customer_runtime_orphan"),
            baseline_revision_id: SchemaRevisionId::new(runtime_revision_id),
            target: EnumOptionSetTarget::Declared {
                model_id: ModelId::from("employee"),
                field_id: FieldId::from("status"),
            },
            options: vec![
                EnumOption {
                    id: EnumOptionId::from("active"),
                    label: "Active".to_string(),
                    aliases: vec!["current".to_string()],

                    ..Default::default()
                },
                EnumOption {
                    id: EnumOptionId::from("inactive"),
                    label: "Inactive".to_string(),
                    aliases: vec![],

                    ..Default::default()
                },
            ],
        },
    )
    .unwrap();
    let runtime_revision_id: i64 = db
        .client
        .query_one(
            "select id from schema_revision where activated_at is not null",
            &[],
        )
        .unwrap()
        .get(0);
    commit_enum_option_set_revision(
        &mut db.client,
        &CommitEnumOptionSetRevision {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from("customer_runtime_orphan"),
            baseline_revision_id: SchemaRevisionId::new(runtime_revision_id),
            target: EnumOptionSetTarget::Custom {
                model_id: ModelId::from("employee"),
                field_id: FieldId::from("shirt_size"),
            },
            options: vec![EnumOption {
                id: EnumOptionId::from("small"),
                label: "Small".to_string(),
                aliases: vec![],

                ..Default::default()
            }],
        },
    )
    .unwrap();

    let visible_after_orphan = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_runtime_orphan"),
        &ModelId::from("employee"),
        date("2026-05-15"),
    )
    .unwrap();
    assert!(!visible_after_orphan[0]
        .values
        .contains_key(&FieldId::from("status")));
    assert_eq!(
        custom_value(&visible_after_orphan[0].custom_fields, "shirt_size"),
        None
    );
}

#[test]
fn enum_option_set_revision_declared_overlay_keeps_later_base_options() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };

    let schema = declared_enum_schema("customer_runtime_base_drift");
    let baseline_revision_id = materialize_schema(&mut db.client, &schema).unwrap();
    commit_enum_option_set_revision(
        &mut db.client,
        &CommitEnumOptionSetRevision {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from("customer_runtime_base_drift"),
            baseline_revision_id,
            target: EnumOptionSetTarget::Declared {
                model_id: ModelId::from("employee"),
                field_id: FieldId::from("status"),
            },
            options: vec![
                EnumOption {
                    id: EnumOptionId::from("active"),
                    label: "Active".to_string(),
                    aliases: vec!["current".to_string()],

                    ..Default::default()
                },
                EnumOption {
                    id: EnumOptionId::from("inactive"),
                    label: "Inactive".to_string(),
                    aliases: vec![],

                    ..Default::default()
                },
                EnumOption {
                    id: EnumOptionId::from("contractor"),
                    label: "Contractor".to_string(),
                    aliases: vec![],

                    ..Default::default()
                },
            ],
        },
    )
    .unwrap();

    let mut next_base = schema;
    next_base.version = SchemaVersion::from("2026-05-05");
    next_base.models[1].fields[3].option_set.push(EnumOption {
        id: EnumOptionId::from("suspended"),
        label: "Suspended".to_string(),
        aliases: vec![],

        ..Default::default()
    });
    materialize_schema(&mut db.client, &next_base).unwrap();

    let active_schema_json: serde_json::Value = db
        .client
        .query_one(
            "select schema from schema_revision where activated_at is not null",
            &[],
        )
        .unwrap()
        .get(0);
    let active_schema: Schema = serde_json::from_value(active_schema_json).unwrap();
    let status = active_schema.models[1]
        .fields
        .iter()
        .find(|field| field.id == FieldId::from("status"))
        .unwrap();
    assert_eq!(
        status
            .option_set
            .iter()
            .map(|option| option.id.as_str())
            .collect::<Vec<_>>(),
        vec!["active", "inactive", "suspended", "contractor"]
    );
}

#[test]
fn materialize_same_base_version_preserves_active_runtime_overlay() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };

    let schema = declared_enum_schema("customer_runtime_rematerialize");
    let baseline_revision_id = materialize_schema(&mut db.client, &schema).unwrap();
    let runtime_options = commit_enum_option_set_revision(
        &mut db.client,
        &CommitEnumOptionSetRevision {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from("customer_runtime_rematerialize"),
            baseline_revision_id,
            target: EnumOptionSetTarget::Declared {
                model_id: ModelId::from("employee"),
                field_id: FieldId::from("status"),
            },
            options: vec![
                EnumOption {
                    id: EnumOptionId::from("active"),
                    label: "Active".to_string(),
                    aliases: vec!["current".to_string()],

                    ..Default::default()
                },
                EnumOption {
                    id: EnumOptionId::from("inactive"),
                    label: "Inactive".to_string(),
                    aliases: vec![],

                    ..Default::default()
                },
                EnumOption {
                    id: EnumOptionId::from("contractor"),
                    label: "Contractor".to_string(),
                    aliases: vec![],

                    ..Default::default()
                },
            ],
        },
    )
    .unwrap();
    assert_eq!(runtime_options[2].id, EnumOptionId::from("contractor"));
    let active_runtime_revision: i64 = db
        .client
        .query_one(
            "select id from schema_revision where activated_at is not null",
            &[],
        )
        .unwrap()
        .get(0);

    let rematerialized_revision = materialize_schema(&mut db.client, &schema).unwrap();
    assert_eq!(
        rematerialized_revision,
        SchemaRevisionId::new(active_runtime_revision)
    );

    let active_schema_json: serde_json::Value = db
        .client
        .query_one(
            "select schema from schema_revision where activated_at is not null",
            &[],
        )
        .unwrap()
        .get(0);
    let active_schema: Schema = serde_json::from_value(active_schema_json).unwrap();
    let status = active_schema.models[1]
        .fields
        .iter()
        .find(|field| field.id == FieldId::from("status"))
        .unwrap();
    assert_eq!(
        status
            .option_set
            .iter()
            .map(|option| option.id.as_str())
            .collect::<Vec<_>>(),
        vec!["active", "inactive", "contractor"]
    );
}

#[test]
fn enum_option_set_revision_rejects_declared_base_removal_and_alias_collisions() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };

    let schema = declared_enum_schema("customer_runtime_declared_rejects");
    let baseline_revision_id = materialize_schema(&mut db.client, &schema).unwrap();
    let removed_base = commit_enum_option_set_revision(
        &mut db.client,
        &CommitEnumOptionSetRevision {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from("customer_runtime_declared_rejects"),
            baseline_revision_id,
            target: EnumOptionSetTarget::Declared {
                model_id: ModelId::from("employee"),
                field_id: FieldId::from("status"),
            },
            options: vec![EnumOption {
                id: EnumOptionId::from("inactive"),
                label: "Inactive".to_string(),
                aliases: vec![],

                ..Default::default()
            }],
        },
    )
    .unwrap_err();
    assert_eq!(
        validation_codes(removed_base),
        vec!["declared_base_option_removed"]
    );

    let modified_base = commit_enum_option_set_revision(
        &mut db.client,
        &CommitEnumOptionSetRevision {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from("customer_runtime_declared_rejects"),
            baseline_revision_id,
            target: EnumOptionSetTarget::Declared {
                model_id: ModelId::from("employee"),
                field_id: FieldId::from("status"),
            },
            options: vec![
                EnumOption {
                    id: EnumOptionId::from("active"),
                    label: "Currently Active".to_string(),
                    aliases: vec!["current".to_string()],

                    ..Default::default()
                },
                EnumOption {
                    id: EnumOptionId::from("inactive"),
                    label: "Inactive".to_string(),
                    aliases: vec![],

                    ..Default::default()
                },
            ],
        },
    )
    .unwrap_err();
    assert_eq!(
        validation_codes(modified_base),
        vec!["declared_base_option_modified"]
    );

    let alias_collision = commit_enum_option_set_revision(
        &mut db.client,
        &CommitEnumOptionSetRevision {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from("customer_runtime_declared_rejects"),
            baseline_revision_id,
            target: EnumOptionSetTarget::Declared {
                model_id: ModelId::from("employee"),
                field_id: FieldId::from("status"),
            },
            options: vec![
                EnumOption {
                    id: EnumOptionId::from("active"),
                    label: "Active".to_string(),
                    aliases: vec!["current".to_string()],

                    ..Default::default()
                },
                EnumOption {
                    id: EnumOptionId::from("inactive"),
                    label: "Inactive".to_string(),
                    aliases: vec![],

                    ..Default::default()
                },
                EnumOption {
                    id: EnumOptionId::from("contractor"),
                    label: "Contractor".to_string(),
                    aliases: vec!["INACTIVE".to_string()],

                    ..Default::default()
                },
            ],
        },
    )
    .unwrap_err();
    assert_eq!(
        validation_codes(alias_collision),
        vec!["duplicate_option_alias"]
    );

    let alias_before_id_collision = commit_enum_option_set_revision(
        &mut db.client,
        &CommitEnumOptionSetRevision {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from("customer_runtime_declared_rejects"),
            baseline_revision_id,
            target: EnumOptionSetTarget::Declared {
                model_id: ModelId::from("employee"),
                field_id: FieldId::from("status"),
            },
            options: vec![
                EnumOption {
                    id: EnumOptionId::from("active"),
                    label: "Active".to_string(),
                    aliases: vec!["current".to_string()],

                    ..Default::default()
                },
                EnumOption {
                    id: EnumOptionId::from("inactive"),
                    label: "Inactive".to_string(),
                    aliases: vec![],

                    ..Default::default()
                },
                EnumOption {
                    id: EnumOptionId::from("on_leave"),
                    label: "On Leave".to_string(),
                    aliases: vec!["temporary".to_string()],

                    ..Default::default()
                },
                EnumOption {
                    id: EnumOptionId::from("temporary"),
                    label: "Temporary".to_string(),
                    aliases: vec![],

                    ..Default::default()
                },
            ],
        },
    )
    .unwrap_err();
    assert_eq!(
        validation_codes(alias_before_id_collision),
        vec!["duplicate_option_alias"]
    );

    let normalized_match_key_collision = commit_enum_option_set_revision(
        &mut db.client,
        &CommitEnumOptionSetRevision {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from("customer_runtime_declared_rejects"),
            baseline_revision_id,
            target: EnumOptionSetTarget::Declared {
                model_id: ModelId::from("employee"),
                field_id: FieldId::from("status"),
            },
            options: vec![
                EnumOption {
                    id: EnumOptionId::from("active"),
                    label: "Active".to_string(),
                    aliases: vec!["current".to_string()],

                    ..Default::default()
                },
                EnumOption {
                    id: EnumOptionId::from("inactive"),
                    label: "Inactive".to_string(),
                    aliases: vec![],

                    ..Default::default()
                },
                EnumOption {
                    id: EnumOptionId::from("contractor"),
                    label: "Contractor".to_string(),
                    aliases: vec!["on leave".to_string()],

                    ..Default::default()
                },
                EnumOption {
                    id: EnumOptionId::from("on_leave"),
                    label: "On Leave".to_string(),
                    aliases: vec![],

                    ..Default::default()
                },
            ],
        },
    )
    .unwrap_err();
    assert_eq!(
        validation_codes(normalized_match_key_collision),
        vec!["duplicate_option_alias"]
    );

    let label_match_key_collision = commit_enum_option_set_revision(
        &mut db.client,
        &CommitEnumOptionSetRevision {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from("customer_runtime_declared_rejects"),
            baseline_revision_id,
            target: EnumOptionSetTarget::Declared {
                model_id: ModelId::from("employee"),
                field_id: FieldId::from("status"),
            },
            options: vec![
                EnumOption {
                    id: EnumOptionId::from("active"),
                    label: "Active".to_string(),
                    aliases: vec!["current".to_string()],

                    ..Default::default()
                },
                EnumOption {
                    id: EnumOptionId::from("inactive"),
                    label: "Inactive".to_string(),
                    aliases: vec![],

                    ..Default::default()
                },
                EnumOption {
                    id: EnumOptionId::from("on_leave"),
                    label: "On Leave".to_string(),
                    aliases: vec![],

                    ..Default::default()
                },
                EnumOption {
                    id: EnumOptionId::from("on_leave_alt"),
                    label: "on-leave".to_string(),
                    aliases: vec![],

                    ..Default::default()
                },
            ],
        },
    )
    .unwrap_err();
    assert_eq!(
        validation_codes(label_match_key_collision),
        vec!["duplicate_option_alias"]
    );
}

#[test]
fn enum_option_set_revision_rejects_custom_alias_collisions() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };

    let schema = custom_fields_schema("customer_runtime_custom_alias_collision");
    let baseline_revision_id = materialize_schema(&mut db.client, &schema).unwrap();
    let error = commit_enum_option_set_revision(
        &mut db.client,
        &CommitEnumOptionSetRevision {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from("customer_runtime_custom_alias_collision"),
            baseline_revision_id,
            target: EnumOptionSetTarget::Custom {
                model_id: ModelId::from("employee"),
                field_id: FieldId::from("shirt_size"),
            },
            options: vec![
                EnumOption {
                    id: EnumOptionId::from("small"),
                    label: "Small".to_string(),
                    aliases: vec!["s".to_string()],

                    ..Default::default()
                },
                EnumOption {
                    id: EnumOptionId::from("large"),
                    label: "Large".to_string(),
                    aliases: vec!["SMALL".to_string()],

                    ..Default::default()
                },
            ],
        },
    )
    .unwrap_err();
    assert_eq!(
        validation_codes(error),
        vec!["duplicate_custom_option_alias"]
    );

    let alias_before_id_error = commit_enum_option_set_revision(
        &mut db.client,
        &CommitEnumOptionSetRevision {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from("customer_runtime_custom_alias_collision"),
            baseline_revision_id,
            target: EnumOptionSetTarget::Custom {
                model_id: ModelId::from("employee"),
                field_id: FieldId::from("shirt_size"),
            },
            options: vec![
                EnumOption {
                    id: EnumOptionId::from("medium"),
                    label: "Medium".to_string(),
                    aliases: vec!["large size".to_string()],

                    ..Default::default()
                },
                EnumOption {
                    id: EnumOptionId::from("large_size"),
                    label: "Large".to_string(),
                    aliases: vec![],

                    ..Default::default()
                },
            ],
        },
    )
    .unwrap_err();
    assert_eq!(
        validation_codes(alias_before_id_error),
        vec!["duplicate_custom_option_alias"]
    );

    let alias_match_key_collision = commit_enum_option_set_revision(
        &mut db.client,
        &CommitEnumOptionSetRevision {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from("customer_runtime_custom_alias_collision"),
            baseline_revision_id,
            target: EnumOptionSetTarget::Custom {
                model_id: ModelId::from("employee"),
                field_id: FieldId::from("shirt_size"),
            },
            options: vec![
                EnumOption {
                    id: EnumOptionId::from("medium"),
                    label: "Medium".to_string(),
                    aliases: vec!["on_hold".to_string()],

                    ..Default::default()
                },
                EnumOption {
                    id: EnumOptionId::from("large"),
                    label: "Large".to_string(),
                    aliases: vec!["on-hold".to_string()],

                    ..Default::default()
                },
            ],
        },
    )
    .unwrap_err();
    assert_eq!(
        validation_codes(alias_match_key_collision),
        vec!["duplicate_custom_option_alias"]
    );
}

#[test]
fn enum_option_set_revision_rejects_stale_baseline_and_invalid_targets() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };

    let schema = declared_enum_schema("customer_runtime_rejects");
    let baseline_revision_id = materialize_schema(&mut db.client, &schema).unwrap();
    commit_enum_option_set_revision(
        &mut db.client,
        &CommitEnumOptionSetRevision {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from("customer_runtime_rejects"),
            baseline_revision_id,
            target: EnumOptionSetTarget::Declared {
                model_id: ModelId::from("employee"),
                field_id: FieldId::from("status"),
            },
            options: vec![
                EnumOption {
                    id: EnumOptionId::from("active"),
                    label: "Active".to_string(),
                    aliases: vec!["current".to_string()],

                    ..Default::default()
                },
                EnumOption {
                    id: EnumOptionId::from("inactive"),
                    label: "Inactive".to_string(),
                    aliases: vec![],

                    ..Default::default()
                },
                EnumOption {
                    id: EnumOptionId::from("paused"),
                    label: "Paused".to_string(),
                    aliases: vec![],

                    ..Default::default()
                },
            ],
        },
    )
    .unwrap();
    let stale = commit_enum_option_set_revision(
        &mut db.client,
        &CommitEnumOptionSetRevision {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from("customer_runtime_rejects"),
            baseline_revision_id,
            target: EnumOptionSetTarget::Declared {
                model_id: ModelId::from("employee"),
                field_id: FieldId::from("status"),
            },
            options: vec![EnumOption {
                id: EnumOptionId::from("active"),
                label: "Active".to_string(),
                aliases: vec![],

                ..Default::default()
            }],
        },
    )
    .unwrap_err();
    assert!(matches!(stale, DbError::StaleSchemaRevision { .. }));

    let active_revision_id: i64 = db
        .client
        .query_one(
            "select id from schema_revision where activated_at is not null",
            &[],
        )
        .unwrap()
        .get(0);
    let invalid_target = commit_enum_option_set_revision(
        &mut db.client,
        &CommitEnumOptionSetRevision {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from("customer_runtime_rejects"),
            baseline_revision_id: SchemaRevisionId::new(active_revision_id),
            target: EnumOptionSetTarget::Declared {
                model_id: ModelId::from("employee"),
                field_id: FieldId::from("name"),
            },
            options: vec![EnumOption {
                id: EnumOptionId::from("active"),
                label: "Active".to_string(),
                aliases: vec![],

                ..Default::default()
            }],
        },
    )
    .unwrap_err();
    assert!(matches!(invalid_target, DbError::Validation(_)));
}

#[test]
fn mainline_apply_replays_idempotent_requests_and_rejects_conflicts() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();
    let apply = mainline_apply(
        "customer_a",
        Some("company-idempotent"),
        vec![RowVersionWrite {
            model_id: ModelId::from("company"),
            new_record_id: None,
            record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
            effective_start: date("2026-05-01"),
            values: Some(text_values("Acme")),
            custom_fields: None,
            tombstones_record: false,
            provenance: None,

            ..Default::default()
        }],
    );

    let first = apply_change_set(&mut db.client, &apply).unwrap();
    let second = apply_change_set(&mut db.client, &apply).unwrap();
    assert_eq!(first, second);

    let mut replay_with_explicit_revision = apply.clone();
    replay_with_explicit_revision.schema_revision_id = Some(first.schema_revision_id);
    let explicit_replay = apply_change_set(&mut db.client, &replay_with_explicit_revision).unwrap();
    assert_eq!(first, explicit_replay);

    let mut conflicting = apply;
    conflicting.writes[0].values.as_mut().unwrap().insert(
        FieldId::from("name"),
        FieldValue::Text("Different".to_string()),
    );
    let error = apply_change_set(&mut db.client, &conflicting).unwrap_err();
    assert!(matches!(error, DbError::IdempotencyConflict { .. }));

    let mut stale_replay = conflicting;
    stale_replay.writes[0]
        .values
        .as_mut()
        .unwrap()
        .insert(FieldId::from("name"), FieldValue::Text("Acme".to_string()));
    stale_replay.schema_revision_id = Some(SchemaRevisionId::new(999));
    let error = apply_change_set(&mut db.client, &stale_replay).unwrap_err();
    assert!(matches!(error, DbError::IdempotencyConflict { .. }));
}

#[test]
fn mainline_apply_stores_change_set_notes() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();
    let mut apply = mainline_apply(
        "customer_a",
        Some("company-notes"),
        vec![RowVersionWrite {
            model_id: ModelId::from("company"),
            new_record_id: None,
            record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
            effective_start: date("2026-05-01"),
            values: Some(text_values("Acme")),
            custom_fields: None,
            tombstones_record: false,
            provenance: None,

            ..Default::default()
        }],
    );
    apply.notes = Some("reviewed source upload".to_string());

    let applied = apply_change_set(&mut db.client, &apply).unwrap();
    let notes: Option<String> = db
        .client
        .query_one("select notes from change_set where id = $1", &[&applied.id])
        .unwrap()
        .get(0);
    assert_eq!(notes.as_deref(), Some("reviewed source upload"));
}

#[test]
fn draft_apply_isolated_from_mainline_reads_and_explicitly_readable() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();

    let draft = apply_change_set(
        &mut db.client,
        &draft_apply(
            "customer_a",
            Some("draft-company-acme"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme Draft")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    let mainline = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        &ModelId::from("company"),
        date("2026-05-15"),
    )
    .unwrap();
    assert!(mainline.is_empty());

    let draft_records = read_draft_change_set(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        draft.id,
    )
    .unwrap();
    assert_eq!(draft_records.len(), 1);
    assert_eq!(draft_records[0].external_key.as_deref(), Some("acme"));
    assert_eq!(
        draft_records[0].values.get(&FieldId::from("name")),
        Some(&FieldValue::Text("Acme Draft".to_string()))
    );

    let status: String = db
        .client
        .query_one("select status from change_set where id = $1", &[&draft.id])
        .unwrap()
        .get(0);
    assert_eq!(status, "draft");
    let applied_at: Option<chrono::DateTime<chrono::Utc>> = db
        .client
        .query_one(
            "select applied_at from change_set where id = $1",
            &[&draft.id],
        )
        .unwrap()
        .get(0);
    assert!(applied_at.is_none());
}

#[test]
fn draft_approval_flips_to_mainline_and_normalizes_timeline() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();

    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("company-mainline-before-draft"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    let draft = apply_change_set(
        &mut db.client,
        &draft_apply(
            "customer_a",
            Some("company-draft-approve"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-06-01"),
                values: Some(text_values("Acme Approved")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    let before = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        &ModelId::from("company"),
        date("2026-06-15"),
    )
    .unwrap();
    assert_eq!(
        before[0].values.get(&FieldId::from("name")),
        Some(&FieldValue::Text("Acme".to_string()))
    );

    let approved = approve_draft_change_set(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        draft.id,
    )
    .unwrap();
    assert_eq!(approved.id, draft.id);
    let replay = approve_draft_change_set(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        draft.id,
    )
    .unwrap();
    assert_eq!(replay, approved);

    let after = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        &ModelId::from("company"),
        date("2026-06-15"),
    )
    .unwrap();
    assert_eq!(
        after[0].values.get(&FieldId::from("name")),
        Some(&FieldValue::Text("Acme Approved".to_string()))
    );
    let prior_end: Option<NaiveDate> = db
        .client
        .query_one(
            "select effective_end from company_version where effective_start = $1 and stage = 'mainline'",
            &[&date("2026-05-01")],
        )
        .unwrap()
        .get(0);
    assert_eq!(prior_end, Some(date("2026-05-31")));
}

#[test]
fn draft_save_rechecks_its_locked_baseline_and_approval_promotes_same_day_history() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let customer_id = "customer_draft_locked_baseline";
    materialize_schema(&mut db.client, &test_schema(customer_id)).unwrap();

    apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("draft-locked-baseline"),
            vec![
                RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                    effective_start: date("2026-04-01"),
                    values: Some(text_values("Acme")),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                },
                RowVersionWrite {
                    model_id: ModelId::from("employee"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alice"))),
                    effective_start: date("2026-04-01"),
                    values: Some(employee_values(
                        "Alice",
                        RecordKey::ExternalKey(ExternalKey::from("acme")),
                    )),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                },
            ],
        ),
    )
    .unwrap();

    let draft_schema_name = db.schema_name.clone();
    let mut direct_tx = begin_tenant_transaction(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from(customer_id),
    )
    .unwrap();
    let mut values = BTreeMap::new();
    values.insert(
        FieldId::from("comp_rate"),
        FieldValue::MoneyRate(MoneyRateValue {
            amount: Decimal::new(15000, 2),
            currency: "USD".to_string(),
            period: MoneyRatePeriod::Hourly,
        }),
    );
    let direct = apply_change_set_in_transaction(
        &mut direct_tx,
        &mainline_apply(
            customer_id,
            Some("mainline-before-draft-lock-baseline"),
            vec![RowVersionWrite {
                model_id: ModelId::from("employee"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alice"))),
                effective_start: date("2026-05-01"),
                values: Some(values),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    let (draft_pid_sender, draft_pid_receiver) = mpsc::channel();
    let draft_thread = thread::spawn(move || {
        let mut client = connect_to_test_schema(&draft_schema_name);
        let pid: i32 = client
            .query_one("select pg_backend_pid()", &[])
            .unwrap()
            .get(0);
        draft_pid_sender.send(pid).unwrap();
        apply_change_set(
            &mut client,
            &draft_apply(
                "customer_draft_locked_baseline",
                Some("draft-after-locked-baseline"),
                vec![RowVersionWrite {
                    model_id: ModelId::from("employee"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alice"))),
                    effective_start: date("2026-05-01"),
                    values: Some(text_values("Alice Draft")),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                }],
            ),
        )
        .map_err(|error| format!("{error:?}"))
    });
    let draft_pid = draft_pid_receiver.recv().unwrap();
    let deadline = Instant::now() + StdDuration::from_secs(2);
    loop {
        let is_waiting: bool = direct_tx
            .query_one(
                "select exists (select 1 from pg_stat_activity where pid = $1 and wait_event_type = 'Lock')",
                &[&draft_pid],
            )
            .unwrap()
            .get(0);
        if is_waiting {
            break;
        }
        if Instant::now() >= deadline {
            if draft_thread.is_finished() {
                let completed = draft_thread.join();
                panic!("draft apply exited before the canonical lock set: {completed:?}");
            }
            let activity = direct_tx
                .query_opt(
                    "select state, wait_event_type, wait_event, query from pg_stat_activity where pid = $1",
                    &[&draft_pid],
                )
                .unwrap();
            panic!("draft apply never reached the canonical lock set: activity={activity:?}");
        }
        thread::sleep(StdDuration::from_millis(10));
    }

    direct_tx.commit().unwrap();
    let draft = draft_thread.join().unwrap().unwrap();

    let draft_records = read_draft_change_set(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from(customer_id),
        draft.id,
    )
    .unwrap();
    assert_eq!(draft_records.len(), 1);
    assert_eq!(
        draft_records[0].values.get(&FieldId::from("comp_rate")),
        Some(&FieldValue::MoneyRate(MoneyRateValue {
            amount: Decimal::new(15000, 2),
            currency: "USD".to_string(),
            period: MoneyRatePeriod::Hourly,
        }))
    );

    let orders = db
        .client
        .query_one(
            r#"
            select
              (select applied_order from change_set where id = $1) as direct_order,
              created_order as draft_created_order,
              applied_order as draft_applied_order
            from change_set
            where id = $2
            "#,
            &[&direct.id, &draft.id],
        )
        .unwrap();
    let direct_order: i64 = orders.get("direct_order");
    let draft_created_order: i64 = orders.get("draft_created_order");
    assert!(direct_order < draft_created_order);
    assert!(orders
        .get::<_, Option<i64>>("draft_applied_order")
        .is_none());

    approve_draft_change_set(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from(customer_id),
        draft.id,
    )
    .unwrap();
    let draft_applied_order: i64 = db
        .client
        .query_one(
            "select applied_order from change_set where id = $1",
            &[&draft.id],
        )
        .unwrap()
        .get(0);
    assert!(draft_created_order < draft_applied_order);

    let same_day_history = db
        .client
        .query(
            r#"
            select v.change_set_id, cs.applied_order, v.effective_end
            from employee_version v
            join employee_record r on r.id = v.record_id
            join change_set cs on cs.id = v.change_set_id
            where r.app_id = 'core_app'
              and r.customer_id = 'customer_draft_locked_baseline'
              and r.external_key = 'alice'
              and v.stage = 'mainline'
              and v.effective_start = date '2026-05-01'
            order by cs.applied_order
            "#,
            &[],
        )
        .unwrap();
    assert_eq!(same_day_history.len(), 2);
    assert_eq!(
        same_day_history[0].get::<_, i64>("change_set_id"),
        direct.id
    );
    assert_eq!(
        same_day_history[0].get::<_, Option<NaiveDate>>("effective_end"),
        Some(date("2026-05-01"))
    );
    assert_eq!(same_day_history[1].get::<_, i64>("change_set_id"), draft.id);
    assert_eq!(
        same_day_history[1].get::<_, i64>("applied_order"),
        draft_applied_order
    );
    assert!(same_day_history[1]
        .get::<_, Option<NaiveDate>>("effective_end")
        .is_none());

    let visible = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from(customer_id),
        &ModelId::from("employee"),
        date("2026-05-15"),
    )
    .unwrap();
    assert_eq!(
        visible[0].values.get(&FieldId::from("name")),
        Some(&FieldValue::Text("Alice Draft".to_string()))
    );
    assert_eq!(
        visible[0].values.get(&FieldId::from("comp_rate")),
        Some(&FieldValue::MoneyRate(MoneyRateValue {
            amount: Decimal::new(15000, 2),
            currency: "USD".to_string(),
            period: MoneyRatePeriod::Hourly,
        }))
    );
}

#[test]
fn draft_approval_locks_inherited_relation_targets_before_allocating_order() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let customer_id = "customer_draft_approval_relation_lock";
    materialize_schema(&mut db.client, &test_schema(customer_id)).unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("draft-approval-relation-baseline"),
            vec![
                RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                    effective_start: date("2026-04-01"),
                    values: Some(text_values("Acme")),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                },
                RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("beta"))),
                    effective_start: date("2026-04-01"),
                    values: Some(text_values("Beta")),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                },
                RowVersionWrite {
                    model_id: ModelId::from("employee"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alice"))),
                    effective_start: date("2026-04-01"),
                    values: Some(employee_values(
                        "Alice",
                        RecordKey::ExternalKey(ExternalKey::from("acme")),
                    )),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                },
            ],
        ),
    )
    .unwrap();
    let draft = apply_change_set(
        &mut db.client,
        &draft_apply(
            customer_id,
            Some("draft-approval-inherited-relation"),
            vec![RowVersionWrite {
                model_id: ModelId::from("employee"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alice"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Alice Draft")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    let schema_name = db.schema_name.clone();
    let waiting_schema_name = schema_name.clone();
    let mut blocker = begin_tenant_transaction(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from(customer_id),
    )
    .unwrap();
    blocker
        .query_one(
            "select id from company_record where app_id = 'core_app' and customer_id = 'customer_draft_approval_relation_lock' and external_key = 'acme' for update",
            &[],
        )
        .unwrap();

    let (pid_sender, pid_receiver) = mpsc::channel();
    let approving = thread::spawn(move || {
        let mut client = connect_to_test_schema(&waiting_schema_name);
        let pid: i32 = client
            .query_one("select pg_backend_pid()", &[])
            .unwrap()
            .get(0);
        pid_sender.send(pid).unwrap();
        approve_draft_change_set(
            &mut client,
            &AppId::from("core_app"),
            &CustomerId::from("customer_draft_approval_relation_lock"),
            draft.id,
        )
        .map_err(|error| format!("{error:?}"))
    });
    let waiting_pid = pid_receiver.recv().unwrap();
    let deadline = Instant::now() + StdDuration::from_secs(2);
    loop {
        let is_waiting: bool = blocker
            .query_one(
                "select exists (select 1 from pg_stat_activity where pid = $1 and wait_event_type = 'Lock')",
                &[&waiting_pid],
            )
            .unwrap()
            .get(0);
        if is_waiting {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "draft approval never reached the inherited relation target lock"
        );
        thread::sleep(StdDuration::from_millis(10));
    }

    let beta = {
        let mut client = connect_to_test_schema(&schema_name);
        apply_change_set(
            &mut client,
            &mainline_apply(
                customer_id,
                Some("mainline-while-draft-approval-waits"),
                vec![RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("beta"))),
                    effective_start: date("2026-05-01"),
                    values: Some(text_values("Beta Updated")),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                }],
            ),
        )
        .unwrap()
    };
    blocker.commit().unwrap();
    approving.join().unwrap().unwrap();

    let rows = db
        .client
        .query(
            "select id, created_order, applied_order from change_set where id = any($1) order by applied_order",
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
fn draft_rows_compose_with_prior_rows_in_the_same_draft() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();

    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("draft-compose-company"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("draft-compose-employee"),
            vec![RowVersionWrite {
                model_id: ModelId::from("employee"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alice"))),
                effective_start: date("2026-05-01"),
                values: Some(employee_values(
                    "Alice",
                    RecordKey::ExternalKey(ExternalKey::from("acme")),
                )),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    let mut rate_update = BTreeMap::new();
    rate_update.insert(
        FieldId::from("comp_rate"),
        FieldValue::MoneyRate(MoneyRateValue {
            amount: Decimal::new(15000, 2),
            currency: "USD".to_string(),
            period: MoneyRatePeriod::Hourly,
        }),
    );
    let mut name_update = BTreeMap::new();
    name_update.insert(
        FieldId::from("name"),
        FieldValue::Text("Alice July".to_string()),
    );
    let draft = apply_change_set(
        &mut db.client,
        &draft_apply(
            "customer_a",
            Some("draft-compose-two-rows"),
            vec![
                RowVersionWrite {
                    model_id: ModelId::from("employee"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alice"))),
                    effective_start: date("2026-06-01"),
                    values: Some(rate_update),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                },
                RowVersionWrite {
                    model_id: ModelId::from("employee"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alice"))),
                    effective_start: date("2026-07-01"),
                    values: Some(name_update),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                },
            ],
        ),
    )
    .unwrap();

    let draft_records = read_draft_change_set(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        draft.id,
    )
    .unwrap();
    let july = draft_records
        .iter()
        .find(|record| {
            record.model_id == ModelId::from("employee")
                && record.effective_start == date("2026-07-01")
        })
        .unwrap();
    assert_eq!(
        july.values.get(&FieldId::from("comp_rate")),
        Some(&FieldValue::MoneyRate(MoneyRateValue {
            amount: Decimal::new(15000, 2),
            currency: "USD".to_string(),
            period: MoneyRatePeriod::Hourly,
        }))
    );

    let before_approval = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        &ModelId::from("employee"),
        date("2026-07-15"),
    )
    .unwrap();
    assert_eq!(
        before_approval[0].values.get(&FieldId::from("comp_rate")),
        Some(&FieldValue::MoneyRate(MoneyRateValue {
            amount: Decimal::new(12500, 2),
            currency: "USD".to_string(),
            period: MoneyRatePeriod::Hourly,
        }))
    );

    approve_draft_change_set(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        draft.id,
    )
    .unwrap();
    let after_approval = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        &ModelId::from("employee"),
        date("2026-07-15"),
    )
    .unwrap();
    assert_eq!(
        after_approval[0].values.get(&FieldId::from("name")),
        Some(&FieldValue::Text("Alice July".to_string()))
    );
    assert_eq!(
        after_approval[0].values.get(&FieldId::from("comp_rate")),
        Some(&FieldValue::MoneyRate(MoneyRateValue {
            amount: Decimal::new(15000, 2),
            currency: "USD".to_string(),
            period: MoneyRatePeriod::Hourly,
        }))
    );
}

#[test]
fn draft_relation_writes_can_target_records_created_in_the_same_draft() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();

    let draft = apply_change_set(
        &mut db.client,
        &draft_apply(
            "customer_a",
            Some("draft-related-new-records"),
            vec![
                RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                    effective_start: date("2026-05-01"),
                    values: Some(text_values("Acme")),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                },
                RowVersionWrite {
                    model_id: ModelId::from("employee"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alice"))),
                    effective_start: date("2026-05-01"),
                    values: Some(employee_values(
                        "Alice",
                        RecordKey::ExternalKey(ExternalKey::from("acme")),
                    )),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                },
            ],
        ),
    )
    .unwrap();

    let draft_records = read_draft_change_set(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        draft.id,
    )
    .unwrap();
    let employee = draft_records
        .iter()
        .find(|record| record.model_id == ModelId::from("employee"))
        .unwrap();
    let company = draft_records
        .iter()
        .find(|record| record.model_id == ModelId::from("company"))
        .unwrap();
    assert_eq!(
        employee.values.get(&FieldId::from("employer")),
        Some(&FieldValue::Relation(RecordKey::RecordId(
            company.record_id
        )))
    );

    let mainline_before = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        &ModelId::from("employee"),
        date("2026-05-15"),
    )
    .unwrap();
    assert!(mainline_before.is_empty());

    approve_draft_change_set(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        draft.id,
    )
    .unwrap();
    let mainline_after = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        &ModelId::from("employee"),
        date("2026-05-15"),
    )
    .unwrap();
    assert_eq!(
        mainline_after[0].values.get(&FieldId::from("employer")),
        Some(&FieldValue::Relation(RecordKey::RecordId(
            company.record_id
        )))
    );
}

#[test]
fn draft_relation_writes_respect_same_draft_target_tombstones() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();

    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("mainline-company-for-draft-relation-tombstone"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    let error = apply_change_set(
        &mut db.client,
        &draft_apply(
            "customer_a",
            Some("draft-relation-respects-target-tombstone"),
            vec![
                RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                    effective_start: date("2026-05-01"),
                    values: None,
                    custom_fields: None,
                    tombstones_record: true,
                    provenance: None,

                    ..Default::default()
                },
                RowVersionWrite {
                    model_id: ModelId::from("employee"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alice"))),
                    effective_start: date("2026-05-01"),
                    values: Some(employee_values(
                        "Alice",
                        RecordKey::ExternalKey(ExternalKey::from("acme")),
                    )),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                },
            ],
        ),
    )
    .unwrap_err();
    assert!(matches!(error, DbError::TombstonedRecord { .. }));
}

#[test]
fn draft_apply_rejects_unapprovalable_same_day_and_tombstone_timelines() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();

    let duplicate = apply_change_set(
        &mut db.client,
        &draft_apply(
            "customer_a",
            Some("draft-duplicate-same-day"),
            vec![
                RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                    effective_start: date("2026-05-01"),
                    values: Some(text_values("Acme One")),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                },
                RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                    effective_start: date("2026-05-01"),
                    values: Some(text_values("Acme Two")),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                },
            ],
        ),
    )
    .unwrap_err();
    assert!(matches!(duplicate, DbError::TimelineConflict { .. }));

    let constrained = apply_change_set(
        &mut db.client,
        &draft_apply(
            "customer_a",
            Some("draft-database-duplicate"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from(
                    "database-duplicate",
                ))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Database constrained")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    let database_duplicate = db
        .client
        .execute(
            r#"
            insert into company_version (
              id,
              record_id,
              app_id,
              customer_id,
              stage,
              effective_start,
              change_set_id,
              name
            )
            select
              $1,
              record_id,
              app_id,
              customer_id,
              stage,
              effective_start,
              change_set_id,
              'database duplicate'
            from company_version
            where change_set_id = $2
            "#,
            &[&uuid::Uuid::new_v4(), &constrained.id],
        )
        .unwrap_err();
    assert_eq!(
        database_duplicate.code(),
        Some(&postgres::error::SqlState::UNIQUE_VIOLATION)
    );

    let tombstone_before_later_value = apply_change_set(
        &mut db.client,
        &draft_apply(
            "customer_a",
            Some("draft-tombstone-before-later-value"),
            vec![
                RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("beta"))),
                    effective_start: date("2026-05-01"),
                    values: Some(text_values("Beta")),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                },
                RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("beta"))),
                    effective_start: date("2026-06-01"),
                    values: None,
                    custom_fields: None,
                    tombstones_record: true,
                    provenance: None,

                    ..Default::default()
                },
                RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("beta"))),
                    effective_start: date("2026-07-01"),
                    values: Some(text_values("Beta Later")),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                },
            ],
        ),
    )
    .unwrap_err();
    assert!(matches!(
        tombstone_before_later_value,
        DbError::TombstonedRecord { .. } | DbError::TimelineConflict { .. }
    ));

    let out_of_order = apply_change_set(
        &mut db.client,
        &draft_apply(
            "customer_a",
            Some("draft-out-of-order"),
            vec![
                RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("gamma"))),
                    effective_start: date("2026-07-01"),
                    values: Some(text_values("Gamma Later")),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                },
                RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("gamma"))),
                    effective_start: date("2026-06-01"),
                    values: Some(text_values("Gamma Earlier")),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                },
            ],
        ),
    )
    .unwrap_err();
    assert!(matches!(out_of_order, DbError::TimelineConflict { .. }));
}

#[test]
fn draft_discard_hides_draft_and_is_idempotent() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();
    let draft = apply_change_set(
        &mut db.client,
        &draft_apply(
            "customer_a",
            Some("company-draft-discard"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme Draft")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    let discarded = discard_draft_change_set(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        draft.id,
    )
    .unwrap();
    let replay = discard_draft_change_set(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        draft.id,
    )
    .unwrap();
    assert_eq!(discarded, replay);

    let error = read_draft_change_set(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        draft.id,
    )
    .unwrap_err();
    assert!(matches!(error, DbError::DraftStatusConflict { .. }));
    let visible = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        &ModelId::from("company"),
        date("2026-05-15"),
    )
    .unwrap();
    assert!(visible.is_empty());

    let external_key_rows: i64 = db
        .client
        .query_one(
            "select count(*) from company_record where app_id = 'core_app' and customer_id = 'customer_a' and external_key = 'acme'",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(external_key_rows, 0);

    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("draft-orphan-key-reuse"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-06-01"),
                values: Some(text_values("Acme Fresh")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
}

#[test]
fn dry_runs_use_local_orders_and_discard_does_not_create_causal_residue() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let customer_id = "customer_dry_run_local_orders";
    materialize_schema(&mut db.client, &unique_ref_schema(customer_id)).unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("dry-run-baseline"),
            vec![employee_write(
                "alice",
                "2026-05-01",
                Some(ref_values(Some("employee-a"), "Alice")),
                false,
            )],
        ),
    )
    .unwrap();

    let sequence_before_dry_row = db
        .client
        .query_one(
            "select last_value, is_called from change_set_lifecycle_order_seq",
            &[],
        )
        .unwrap();
    let sequence_before_dry: (i64, bool) = (
        sequence_before_dry_row.get(0),
        sequence_before_dry_row.get(1),
    );
    let dry_draft = validate_change_set_dry_run(
        &mut db.client,
        &draft_apply(
            customer_id,
            Some("dry-run-same-day-draft"),
            vec![employee_write(
                "alice",
                "2026-05-01",
                Some(text_values("Alice Draft")),
                false,
            )],
        ),
    )
    .unwrap();
    assert!(dry_draft.id < 0);

    let dry_batch = validate_change_sets_dry_run(
        &mut db.client,
        &[
            mainline_apply(
                customer_id,
                Some("dry-run-batch-create"),
                vec![employee_write(
                    "bob",
                    "2026-05-01",
                    Some(ref_values(Some("employee-b"), "Bob")),
                    false,
                )],
            ),
            mainline_apply(
                customer_id,
                Some("dry-run-batch-same-day-update"),
                vec![employee_write(
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

    let sequence_after_dry_row = db
        .client
        .query_one(
            "select last_value, is_called from change_set_lifecycle_order_seq",
            &[],
        )
        .unwrap();
    let sequence_after_dry: (i64, bool) =
        (sequence_after_dry_row.get(0), sequence_after_dry_row.get(1));
    assert_eq!(sequence_after_dry, sequence_before_dry);
    let durable_rows_after_dry_row = db
        .client
        .query_one(
            r#"
            select
              (select count(*) from change_set where app_id = 'core_app' and customer_id = 'customer_dry_run_local_orders'),
              (select count(*) from employee_record where app_id = 'core_app' and customer_id = 'customer_dry_run_local_orders'),
              (select count(*) from employee_version where app_id = 'core_app' and customer_id = 'customer_dry_run_local_orders')
            "#,
            &[],
        )
        .unwrap();
    let durable_rows_after_dry: (i64, i64, i64) = (
        durable_rows_after_dry_row.get(0),
        durable_rows_after_dry_row.get(1),
        durable_rows_after_dry_row.get(2),
    );
    assert_eq!(durable_rows_after_dry, (1, 1, 1));

    let discarded_draft = apply_change_set(
        &mut db.client,
        &draft_apply(
            customer_id,
            Some("discard-without-causal-order"),
            vec![employee_write(
                "charlie",
                "2026-06-01",
                Some(ref_values(Some("employee-c"), "Charlie")),
                false,
            )],
        ),
    )
    .unwrap();
    let sequence_before_discard_row = db
        .client
        .query_one(
            "select last_value, is_called from change_set_lifecycle_order_seq",
            &[],
        )
        .unwrap();
    let sequence_before_discard: (i64, bool) = (
        sequence_before_discard_row.get(0),
        sequence_before_discard_row.get(1),
    );
    discard_draft_change_set(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from(customer_id),
        discarded_draft.id,
    )
    .unwrap();
    let sequence_after_discard_row = db
        .client
        .query_one(
            "select last_value, is_called from change_set_lifecycle_order_seq",
            &[],
        )
        .unwrap();
    let sequence_after_discard: (i64, bool) = (
        sequence_after_discard_row.get(0),
        sequence_after_discard_row.get(1),
    );
    assert_eq!(sequence_after_discard, sequence_before_discard);

    let discarded = db
        .client
        .query_one(
            "select status, applied_order from change_set where id = $1",
            &[&discarded_draft.id],
        )
        .unwrap();
    assert_eq!(discarded.get::<_, String>("status"), "discarded");
    assert!(discarded.get::<_, Option<i64>>("applied_order").is_none());
    let charlie_residue: i64 = db
        .client
        .query_one(
            r#"
            select
              (select count(*) from employee_record where app_id = 'core_app' and customer_id = 'customer_dry_run_local_orders' and external_key = 'charlie')
              + (select count(*) from employee_version where app_id = 'core_app' and customer_id = 'customer_dry_run_local_orders' and change_set_id = $1 and stage = 'mainline')
            "#,
            &[&discarded_draft.id],
        )
        .unwrap()
        .get(0);
    assert_eq!(charlie_residue, 0);
    let discarded_versions: i64 = db
        .client
        .query_one(
            "select count(*) from employee_version where change_set_id = $1 and stage = 'discarded' and applied_at is null",
            &[&discarded_draft.id],
        )
        .unwrap()
        .get(0);
    assert_eq!(discarded_versions, 1);
}

#[test]
fn draft_approval_rejects_if_mainline_changed_after_draft_creation() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("company-before-stale-draft"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    let draft = apply_change_set(
        &mut db.client,
        &draft_apply(
            "customer_a",
            Some("company-stale-draft"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-06-01"),
                values: Some(text_values("Acme Draft")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("company-after-stale-draft"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-06-01"),
                values: Some(text_values("Acme Same-Day Mainline")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    let sequence_before_approval = db
        .client
        .query_one(
            "select last_value, is_called from change_set_lifecycle_order_seq",
            &[],
        )
        .unwrap();
    let sequence_before_approval: (i64, bool) = (
        sequence_before_approval.get(0),
        sequence_before_approval.get(1),
    );

    let error = approve_draft_change_set(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        draft.id,
    )
    .unwrap_err();
    assert!(matches!(error, DbError::StaleDraft { .. }));
    let sequence_after_approval = db
        .client
        .query_one(
            "select last_value, is_called from change_set_lifecycle_order_seq",
            &[],
        )
        .unwrap();
    let sequence_after_approval: (i64, bool) = (
        sequence_after_approval.get(0),
        sequence_after_approval.get(1),
    );
    assert_eq!(sequence_after_approval, sequence_before_approval);
    let draft_state = db
        .client
        .query_one(
            "select status, applied_order from change_set where id = $1",
            &[&draft.id],
        )
        .unwrap();
    assert_eq!(draft_state.get::<_, String>("status"), "draft");
    assert!(draft_state.get::<_, Option<i64>>("applied_order").is_none());
}

#[test]
fn draft_approval_rejects_if_an_older_draft_was_approved_after_this_draft_was_created() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("company-before-two-drafts"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    let older_draft = apply_change_set(
        &mut db.client,
        &draft_apply(
            "customer_a",
            Some("company-older-draft"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-06-01"),
                values: Some(text_values("Acme Older Draft")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    let newer_draft = apply_change_set(
        &mut db.client,
        &draft_apply(
            "customer_a",
            Some("company-newer-draft"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-07-01"),
                values: Some(text_values("Acme Newer Draft")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    std::thread::sleep(StdDuration::from_millis(2));
    approve_draft_change_set(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        older_draft.id,
    )
    .unwrap();

    let error = approve_draft_change_set(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        newer_draft.id,
    )
    .unwrap_err();
    assert!(matches!(error, DbError::StaleDraft { .. }));
}

#[test]
fn approving_an_ordinary_mainline_change_set_is_not_treated_as_idempotent_draft_approval() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();
    let applied = apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("company-mainline-not-draft"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    let error = approve_draft_change_set(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        applied.id,
    )
    .unwrap_err();
    assert!(matches!(error, DbError::DraftStatusConflict { .. }));
}

#[test]
fn draft_discard_releases_external_key_on_orphan_records() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();
    let draft = apply_change_set(
        &mut db.client,
        &draft_apply(
            "customer_a",
            Some("company-reserve-record"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme Draft")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    let first_record_id: uuid::Uuid = db
        .client
        .query_one(
            "select id from company_record where external_key = 'acme'",
            &[],
        )
        .unwrap()
        .get(0);
    discard_draft_change_set(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        draft.id,
    )
    .unwrap();
    let visible = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        &ModelId::from("company"),
        date("2026-05-15"),
    )
    .unwrap();
    assert!(visible.is_empty());
    let released_external_key: Option<String> = db
        .client
        .query_one(
            "select external_key from company_record where id = $1",
            &[&first_record_id],
        )
        .unwrap()
        .get(0);
    assert!(released_external_key.is_none());

    let second_draft = apply_change_set(
        &mut db.client,
        &draft_apply(
            "customer_a",
            Some("company-second-draft-after-discard"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme Mainline")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    assert_ne!(second_draft.id, draft.id);
}

#[test]
fn draft_discard_preserves_external_key_when_record_was_already_mainlined() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("company-mainlined-before-draft-discard"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme Mainline")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    let draft = apply_change_set(
        &mut db.client,
        &draft_apply(
            "customer_a",
            Some("company-mainlined-draft-discard"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-06-01"),
                values: Some(text_values("Acme Draft")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    discard_draft_change_set(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        draft.id,
    )
    .unwrap();

    let external_key: Option<String> = db
        .client
        .query_one(
            "select external_key from company_record where external_key = 'acme'",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(external_key.as_deref(), Some("acme"));
    let records = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        &ModelId::from("company"),
        date("2026-05-15"),
    )
    .unwrap();
    assert_eq!(records.len(), 1);
}

#[test]
fn draft_notes_update_only_while_draft_and_drafts_are_listed() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();
    let draft = apply_change_set(
        &mut db.client,
        &draft_apply(
            "customer_a",
            Some("company-draft-notes"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme Draft")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    update_draft_notes(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        draft.id,
        Some("ready for approval".to_string()),
    )
    .unwrap();
    let drafts = list_draft_change_sets(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
    )
    .unwrap();
    assert_eq!(drafts.len(), 1);
    assert_eq!(drafts[0].notes.as_deref(), Some("ready for approval"));

    approve_draft_change_set(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        draft.id,
    )
    .unwrap();
    let error = update_draft_notes(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        draft.id,
        Some("too late".to_string()),
    )
    .unwrap_err();
    assert!(matches!(error, DbError::DraftStatusConflict { .. }));
}

#[test]
fn mainline_apply_retains_distinct_same_day_values_in_applied_order() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();

    let first = apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("company-same-day-first"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    let second = apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("company-same-day-second"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme Updated")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    let rows = db
        .client
        .query(
            r#"
            select v.name, v.effective_end, cs.id as change_set_id, cs.applied_order
            from company_version v
            join company_record r
              on r.id = v.record_id
             and r.app_id = v.app_id
             and r.customer_id = v.customer_id
            join change_set cs
              on cs.id = v.change_set_id
             and cs.app_id = v.app_id
             and cs.customer_id = v.customer_id
            where v.app_id = 'core_app'
              and v.customer_id = 'customer_a'
              and r.external_key = 'acme'
              and v.effective_start = date '2026-05-01'
              and not v.tombstones_record
              and not v.untombstones_record
            order by cs.applied_order
            "#,
            &[],
        )
        .unwrap();
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

    let duplicate = db
        .client
        .execute(
            r#"
            insert into company_version (
              id,
              record_id,
              app_id,
              customer_id,
              stage,
              effective_start,
              change_set_id,
              applied_at,
              name
            )
            select
              $1,
              record_id,
              app_id,
              customer_id,
              'mainline',
              effective_start,
              change_set_id,
              now(),
              'duplicate'
            from company_version
            where change_set_id = $2
            "#,
            &[&uuid::Uuid::new_v4(), &first.id],
        )
        .unwrap_err();
    assert_eq!(
        duplicate.code(),
        Some(&postgres::error::SqlState::UNIQUE_VIOLATION)
    );
}

#[test]
fn same_day_values_follow_application_order_shared_parity() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let mut backend = RustKernelBackend::new(&mut db.client);
    support::parity_scenarios::same_day_values_follow_application_order(&mut backend);
}

#[test]
fn same_day_read_history_and_diff_shared_parity() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let mut backend = RustKernelBackend::new(&mut db.client);
    support::parity_scenarios::same_day_read_history_and_diff_share_application_order(&mut backend);
}

#[test]
fn same_day_inverted_timestamps_shared_parity() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let mut backend = RustKernelBackend::new(&mut db.client);
    support::parity_scenarios::later_date_closes_same_day_winner_despite_inverted_timestamps(
        &mut backend,
    );
}

#[test]
fn same_day_partial_snapshot_shared_parity() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let mut backend = RustKernelBackend::new(&mut db.client);
    support::parity_scenarios::same_day_partial_write_carries_declared_and_custom_snapshot(
        &mut backend,
    );
}

#[test]
fn same_day_successor_boundary_shared_parity() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let mut backend = RustKernelBackend::new(&mut db.client);
    support::parity_scenarios::same_day_successor_inherits_next_effective_boundary(&mut backend);
}

#[test]
fn same_day_lifecycle_precedence_shared_parity() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let mut backend = RustKernelBackend::new(&mut db.client);
    support::parity_scenarios::same_day_lifecycle_precedes_ordinary_values(&mut backend);
}

#[test]
fn same_day_dry_run_shared_parity() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let mut backend = RustKernelBackend::new(&mut db.client);
    support::parity_scenarios::same_day_dry_run_has_no_durable_effect(&mut backend);
}

#[test]
fn same_day_draft_rejection_and_promotion_shared_parity() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let mut backend = RustKernelBackend::new(&mut db.client);
    support::parity_scenarios::same_day_draft_rejection_and_promotion(&mut backend);
}

#[test]
fn same_day_revert_predecessor_walk_shared_parity() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let mut backend = RustKernelBackend::new(&mut db.client);
    support::parity_scenarios::revert_same_day_walks_immediate_predecessors(&mut backend);
}

#[test]
fn same_day_relation_restoration_shared_parity() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let mut backend = RustKernelBackend::new(&mut db.client);
    support::parity_scenarios::revert_same_day_restores_declared_and_custom_relations(&mut backend);
}

#[test]
fn same_day_atomic_rollback_shared_parity() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let mut backend = RustKernelBackend::new(&mut db.client);
    support::parity_scenarios::duplicate_same_day_write_rolls_back_atomically(&mut backend);
}

#[test]
fn same_day_read_query_history_and_diff_share_applied_order() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let customer_id = "customer_same_day_readers";
    materialize_schema(&mut db.client, &test_schema(customer_id)).unwrap();
    let mut change_sets = Vec::new();
    for (index, name) in ["Acme A", "Acme B", "Acme C"].into_iter().enumerate() {
        change_sets.push(
            apply_change_set(
                &mut db.client,
                &mainline_apply(
                    customer_id,
                    Some(&format!("same-day-reader-{index}")),
                    vec![RowVersionWrite {
                        model_id: ModelId::from("company"),
                        new_record_id: None,
                        record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                        effective_start: date("2026-05-01"),
                        values: Some(text_values(name)),
                        custom_fields: None,
                        tombstones_record: false,
                        provenance: None,

                        ..Default::default()
                    }],
                ),
            )
            .unwrap(),
        );
    }

    db.client
        .execute(
            r#"
            update company_version
            set created_at = case change_set_id
              when $1 then timestamptz '2026-05-03 00:00:00+00'
              when $2 then timestamptz '2026-05-02 00:00:00+00'
              when $3 then timestamptz '2026-05-01 00:00:00+00'
            end
            where change_set_id = any($4)
            "#,
            &[
                &change_sets[0].id,
                &change_sets[1].id,
                &change_sets[2].id,
                &change_sets
                    .iter()
                    .map(|change_set| change_set.id)
                    .collect::<Vec<_>>(),
            ],
        )
        .unwrap();

    let visible = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from(customer_id),
        &ModelId::from("company"),
        date("2026-05-01"),
    )
    .unwrap();
    assert_eq!(visible.len(), 1);
    assert_eq!(
        visible[0].values.get(&FieldId::from("name")),
        Some(&FieldValue::Text("Acme C".to_string()))
    );

    let query = query_visible_sql(
        &mut db.client,
        &QueryVisibleSql {
            as_of: Some(date("2026-05-01")),
            ..sql_query(
                customer_id,
                "select name, change_set_id from company_version",
                vec![],
            )
        },
    )
    .unwrap();
    assert_eq!(
        query.rows,
        vec![vec![
            serde_json::json!("Acme C"),
            serde_json::json!(change_sets[2].id)
        ]]
    );

    let history = field_history(
        &mut db.client,
        &FieldHistoryRequest {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from(customer_id),
            model_id: ModelId::from("company"),
            record_id: visible[0].record_id,
            field_id: Some(FieldId::from("name")),
            as_of: None,
            limit: Some(3),
            stages: vec![],
        },
    )
    .unwrap();
    assert_eq!(
        history
            .iter()
            .map(|entry| (entry.change_set_id, entry.value.clone()))
            .collect::<Vec<_>>(),
        vec![
            (
                change_sets[0].id,
                Some(FieldValue::Text("Acme A".to_string()))
            ),
            (
                change_sets[1].id,
                Some(FieldValue::Text("Acme B".to_string()))
            ),
            (
                change_sets[2].id,
                Some(FieldValue::Text("Acme C".to_string()))
            ),
        ]
    );

    let diff = change_set_diff(
        &mut db.client,
        &ChangeSetDiffRequest {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from(customer_id),
            change_set_id: change_sets[2].id,
            project: vec![FieldId::from("name")],
        },
    )
    .unwrap();
    assert_eq!(
        diff.records[0].fields,
        vec![kernel::FieldDiff {
            field_id: FieldId::from("name"),
            before: Some(FieldValue::Text("Acme B".to_string())),
            after: Some(FieldValue::Text("Acme C".to_string())),
            before_enum: None,
            after_enum: None,
        }]
    );

    let applied_after_query = apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("same-day-reader-after-query"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme D")),
                custom_fields: None,
                clear_fields: vec![],
                clear_custom_fields: vec![],
                metadata_patch: None,
                expected_version_id: None,
                tombstones_record: false,
                provenance: None,
            }],
        ),
    )
    .unwrap();
    let applied_diff = change_set_diff(
        &mut db.client,
        &ChangeSetDiffRequest {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from(customer_id),
            change_set_id: applied_after_query.id,
            project: vec![FieldId::from("name")],
        },
    )
    .unwrap();
    assert_eq!(
        applied_diff.records[0].fields,
        vec![kernel::FieldDiff {
            field_id: FieldId::from("name"),
            before: Some(FieldValue::Text("Acme C".to_string())),
            after: Some(FieldValue::Text("Acme D".to_string())),
            before_enum: None,
            after_enum: None,
        }]
    );

    let revert = revert_change_set(
        &mut db.client,
        &revert_request(
            customer_id,
            applied_after_query.id,
            Some("same-day-reader-revert-after-query"),
        ),
    )
    .unwrap();
    let visible_after_revert = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from(customer_id),
        &ModelId::from("company"),
        date("2026-05-01"),
    )
    .unwrap();
    assert_eq!(
        visible_after_revert[0].values.get(&FieldId::from("name")),
        Some(&FieldValue::Text("Acme C".to_string()))
    );

    let history_after_revert = field_history(
        &mut db.client,
        &FieldHistoryRequest {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from(customer_id),
            model_id: ModelId::from("company"),
            record_id: visible[0].record_id,
            field_id: Some(FieldId::from("name")),
            as_of: None,
            limit: Some(4),
            stages: vec![],
        },
    )
    .unwrap();
    assert_eq!(
        history_after_revert
            .iter()
            .map(|entry| (
                entry.change_set_id,
                entry.stage.clone(),
                entry.value.clone(),
                entry.reverted_by,
            ))
            .collect::<Vec<_>>(),
        vec![
            (
                change_sets[0].id,
                VersionStage::Mainline,
                Some(FieldValue::Text("Acme A".to_string())),
                None,
            ),
            (
                change_sets[1].id,
                VersionStage::Mainline,
                Some(FieldValue::Text("Acme B".to_string())),
                None,
            ),
            (
                change_sets[2].id,
                VersionStage::Mainline,
                Some(FieldValue::Text("Acme C".to_string())),
                None,
            ),
            (
                applied_after_query.id,
                VersionStage::Reverted,
                Some(FieldValue::Text("Acme D".to_string())),
                Some(revert.id),
            ),
        ]
    );
}

#[test]
fn internal_kernel_transactions_drop_persisted_workbench_views() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let customer_id = "customer_workbench_isolation";
    materialize_schema(&mut db.client, &test_schema(customer_id)).unwrap();
    materialize_schema(&mut db.client, &test_schema("customer_workbench_other")).unwrap();

    let first = apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("workbench-isolation-first"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme A")),
                custom_fields: None,
                clear_fields: vec![],
                clear_custom_fields: vec![],
                metadata_patch: None,
                expected_version_id: None,
                tombstones_record: false,
                provenance: None,
            }],
        ),
    )
    .unwrap();
    let second = apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("workbench-isolation-second"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-06-01"),
                values: Some(text_values("Acme B")),
                custom_fields: None,
                clear_fields: vec![],
                clear_custom_fields: vec![],
                metadata_patch: None,
                expected_version_id: None,
                tombstones_record: false,
                provenance: None,
            }],
        ),
    )
    .unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_workbench_other",
            Some("workbench-isolation-other"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("other"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Other Tenant")),
                custom_fields: None,
                clear_fields: vec![],
                clear_custom_fields: vec![],
                metadata_patch: None,
                expected_version_id: None,
                tombstones_record: false,
                provenance: None,
            }],
        ),
    )
    .unwrap();

    let workbench = query_visible_sql(
        &mut db.client,
        &QueryVisibleSql {
            as_of: Some(date("2026-05-15")),
            ..sql_query(
                customer_id,
                "select name from company_version order by name",
                vec![],
            )
        },
    )
    .unwrap();
    assert_eq!(workbench.rows, vec![vec![serde_json::json!("Acme A")]]);

    install_persisted_workbench_views(&mut db, customer_id, date("2026-05-15"));
    let visible = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from(customer_id),
        &ModelId::from("company"),
        date("2026-06-15"),
    )
    .unwrap();
    assert_eq!(visible.len(), 1);
    assert_eq!(
        visible[0].values.get(&FieldId::from("name")),
        Some(&FieldValue::Text("Acme B".to_string()))
    );

    install_persisted_workbench_views(&mut db, customer_id, date("2026-05-15"));
    let diff = change_set_diff(
        &mut db.client,
        &ChangeSetDiffRequest {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from(customer_id),
            change_set_id: second.id,
            project: vec![FieldId::from("name")],
        },
    )
    .unwrap();
    assert_eq!(diff.records.len(), 1);
    assert_eq!(
        diff.records[0].fields,
        vec![kernel::FieldDiff {
            field_id: FieldId::from("name"),
            before: Some(FieldValue::Text("Acme A".to_string())),
            after: Some(FieldValue::Text("Acme B".to_string())),
            before_enum: None,
            after_enum: None,
        }]
    );

    install_persisted_workbench_views(&mut db, customer_id, date("2026-05-15"));
    let history = field_history(
        &mut db.client,
        &FieldHistoryRequest {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from(customer_id),
            model_id: ModelId::from("company"),
            record_id: visible[0].record_id,
            field_id: Some(FieldId::from("name")),
            as_of: None,
            limit: None,
            stages: vec![],
        },
    )
    .unwrap();
    assert_eq!(
        history
            .iter()
            .map(|entry| (entry.change_set_id, entry.value.clone()))
            .collect::<Vec<_>>(),
        vec![
            (first.id, Some(FieldValue::Text("Acme A".to_string()))),
            (second.id, Some(FieldValue::Text("Acme B".to_string()))),
        ]
    );

    install_persisted_workbench_views(&mut db, customer_id, date("2026-05-15"));
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("workbench-isolation-third"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-07-01"),
                values: Some(text_values("Acme C")),
                custom_fields: None,
                clear_fields: vec![],
                clear_custom_fields: vec![],
                metadata_patch: None,
                expected_version_id: None,
                tombstones_record: false,
                provenance: None,
            }],
        ),
    )
    .unwrap();

    for _ in 0..2 {
        let repeated = query_visible_sql(
            &mut db.client,
            &QueryVisibleSql {
                as_of: Some(date("2026-07-15")),
                ..sql_query(
                    customer_id,
                    "select name from company_version order by name",
                    vec![],
                )
            },
        )
        .unwrap();
        assert_eq!(repeated.rows, vec![vec![serde_json::json!("Acme C")]]);
    }
}

#[test]
fn visible_reader_rejects_mainline_version_without_applied_order_owner() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let customer_id = "customer_mainline_order_drift";
    materialize_schema(&mut db.client, &test_schema(customer_id)).unwrap();
    let draft = apply_change_set(
        &mut db.client,
        &draft_apply(
            customer_id,
            Some("mainline-order-drift"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    db.client
        .execute(
            "update company_version set stage = 'mainline', applied_at = now() where change_set_id = $1",
            &[&draft.id],
        )
        .unwrap();

    let error = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from(customer_id),
        &ModelId::from("company"),
        date("2026-05-01"),
    )
    .unwrap_err();
    assert!(matches!(error, DbError::SchemaDrift { .. }));
}

#[test]
fn later_date_write_closes_applied_order_winner_when_timestamps_are_inverted() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let customer_id = "customer_same_day_inverted_timestamps";
    materialize_schema(&mut db.client, &test_schema(customer_id)).unwrap();

    let first = apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("same-day-inverted-first"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme First")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    let winner = apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("same-day-inverted-winner"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme Winner")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    db.client
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
        .unwrap();

    let later = apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("same-day-inverted-later"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-06-01"),
                values: Some(text_values("Acme Later")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    let rows = db
        .client
        .query(
            r#"
            select v.change_set_id, v.effective_end
            from company_version v
            join change_set cs
              on cs.id = v.change_set_id
             and cs.app_id = v.app_id
             and cs.customer_id = v.customer_id
            where v.app_id = 'core_app'
              and v.customer_id = $1
            order by cs.applied_order
            "#,
            &[&customer_id],
        )
        .unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0].get::<_, i64>("change_set_id"), first.id);
    assert_eq!(
        rows[0].get::<_, Option<NaiveDate>>("effective_end"),
        Some(date("2026-05-01"))
    );
    assert_eq!(rows[1].get::<_, i64>("change_set_id"), winner.id);
    assert_eq!(
        rows[1].get::<_, Option<NaiveDate>>("effective_end"),
        Some(date("2026-05-31"))
    );
    assert_eq!(rows[2].get::<_, i64>("change_set_id"), later.id);
    assert_eq!(rows[2].get::<_, Option<NaiveDate>>("effective_end"), None);
}

#[test]
fn same_day_partial_write_inherits_declared_and_custom_snapshot_fields() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let customer_id = "customer_same_day_overlay";
    materialize_schema(&mut db.client, &custom_fields_schema(customer_id)).unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("same-day-overlay-company"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("same-day-overlay-base"),
            vec![RowVersionWrite {
                model_id: ModelId::from("employee"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alice"))),
                effective_start: date("2026-05-01"),
                values: Some(employee_values(
                    "Alice",
                    RecordKey::ExternalKey(ExternalKey::from("acme")),
                )),
                custom_fields: Some(vec![
                    custom_field_entry("nickname", CustomFieldValue::Text("Original".to_string())),
                    custom_field_entry("score", CustomFieldValue::Number(Decimal::new(42, 0))),
                ]),
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    let update = apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("same-day-overlay-update"),
            vec![RowVersionWrite {
                model_id: ModelId::from("employee"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alice"))),
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
        ),
    )
    .unwrap();

    let row = db
        .client
        .query_one(
            r#"
            select name, employer, comp_rate_amount::text as comp_rate_amount, custom_fields
            from employee_version
            where change_set_id = $1
            "#,
            &[&update.id],
        )
        .unwrap();
    assert_eq!(row.get::<_, String>("name"), "Alice Updated");
    assert!(row.get::<_, Option<RecordId>>("employer").is_some());
    assert_eq!(
        row.get::<_, Option<String>>("comp_rate_amount").as_deref(),
        Some("125.00")
    );
    let custom_fields: Vec<CustomFieldEntry> =
        serde_json::from_value(row.get("custom_fields")).unwrap();
    assert_eq!(
        custom_value(&custom_fields, "nickname"),
        Some(&CustomFieldValue::Text("Updated".to_string()))
    );
    assert_eq!(
        custom_value(&custom_fields, "score"),
        Some(&CustomFieldValue::Number(Decimal::new(42, 0)))
    );
}

#[test]
fn later_write_in_one_change_set_inherits_the_earlier_planned_snapshot() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let customer_id = "customer_planned_snapshot_overlay";
    materialize_schema(&mut db.client, &custom_fields_schema(customer_id)).unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("planned-snapshot-company"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    let applied = apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("planned-snapshot-writes"),
            vec![
                RowVersionWrite {
                    model_id: ModelId::from("employee"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alice"))),
                    effective_start: date("2026-06-01"),
                    values: Some(text_values("Alice Updated")),
                    custom_fields: Some(vec![custom_field_entry(
                        "nickname",
                        CustomFieldValue::Text("Updated".to_string()),
                    )]),
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                },
                RowVersionWrite {
                    model_id: ModelId::from("employee"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alice"))),
                    effective_start: date("2026-05-01"),
                    values: Some(employee_values(
                        "Alice",
                        RecordKey::ExternalKey(ExternalKey::from("acme")),
                    )),
                    custom_fields: Some(vec![
                        custom_field_entry(
                            "nickname",
                            CustomFieldValue::Text("Original".to_string()),
                        ),
                        custom_field_entry("score", CustomFieldValue::Number(Decimal::new(42, 0))),
                    ]),
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                },
            ],
        ),
    )
    .unwrap();

    let row = db
        .client
        .query_one(
            r#"
            select name, employer, custom_fields
            from employee_version
            where change_set_id = $1 and effective_start = date '2026-06-01'
            "#,
            &[&applied.id],
        )
        .unwrap();
    assert_eq!(row.get::<_, String>("name"), "Alice Updated");
    assert!(row.get::<_, Option<RecordId>>("employer").is_some());
    let custom_fields: Vec<CustomFieldEntry> =
        serde_json::from_value(row.get("custom_fields")).unwrap();
    assert_eq!(
        custom_value(&custom_fields, "nickname"),
        Some(&CustomFieldValue::Text("Updated".to_string()))
    );
    assert_eq!(
        custom_value(&custom_fields, "score"),
        Some(&CustomFieldValue::Number(Decimal::new(42, 0)))
    );
}

#[test]
fn same_day_successor_inherits_the_next_effective_date_boundary() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let customer_id = "customer_same_day_boundary";
    materialize_schema(&mut db.client, &test_schema(customer_id)).unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("same-day-boundary-base"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("same-day-boundary-future"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-07-01"),
                values: Some(text_values("Acme Future")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    let successor = apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("same-day-boundary-successor"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme Corrected")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    let boundaries = db
        .client
        .query(
            r#"
            select v.change_set_id, v.effective_end
            from company_version v
            join change_set cs
              on cs.id = v.change_set_id
             and cs.app_id = v.app_id
             and cs.customer_id = v.customer_id
            where v.app_id = 'core_app'
              and v.customer_id = 'customer_same_day_boundary'
              and v.effective_start = date '2026-05-01'
            order by cs.applied_order
            "#,
            &[],
        )
        .unwrap();
    assert_eq!(boundaries.len(), 2);
    assert_eq!(
        boundaries[0].get::<_, Option<NaiveDate>>("effective_end"),
        Some(date("2026-05-01"))
    );
    assert_eq!(
        boundaries[1].get::<_, Option<NaiveDate>>("effective_end"),
        Some(date("2026-06-30"))
    );
    assert_eq!(boundaries[1].get::<_, i64>("change_set_id"), successor.id);
}

#[test]
fn mainline_apply_rejects_same_change_set_uuid_external_aliases_atomically() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_alias")).unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_alias",
            Some("alias-baseline"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-04-01"),
                values: Some(text_values("Acme")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    let record_id: RecordId = db
        .client
        .query_one(
            "select id from company_record where app_id = 'core_app' and customer_id = 'customer_alias' and external_key = 'acme'",
            &[],
        )
        .unwrap()
        .get("id");

    let error = apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_alias",
            Some("alias-duplicate"),
            vec![
                RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                    effective_start: date("2026-05-01"),
                    values: Some(text_values("Acme External")),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                },
                RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::RecordId(record_id)),
                    effective_start: date("2026-05-01"),
                    values: Some(text_values("Acme UUID")),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                },
            ],
        ),
    )
    .unwrap_err();
    assert!(matches!(error, DbError::TimelineConflict { .. }));
    let residue: i64 = db
        .client
        .query_one(
            r#"
            select
              (select count(*) from change_set where app_id = 'core_app' and customer_id = 'customer_alias' and idempotency_key = 'alias-duplicate')
              + (select count(*) from company_version where app_id = 'core_app' and customer_id = 'customer_alias' and effective_start = date '2026-05-01')
            "#,
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(residue, 0);
}

#[test]
fn mainline_apply_rejects_duplicate_lifecycle_rows_in_one_change_set() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let customer_id = "customer_lifecycle_duplicate";
    materialize_schema(&mut db.client, &test_schema(customer_id)).unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("lifecycle-duplicate-baseline"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-04-01"),
                values: Some(text_values("Acme")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    let tombstone = RowVersionWrite {
        model_id: ModelId::from("company"),
        new_record_id: None,
        record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
        effective_start: date("2026-05-01"),
        values: None,
        custom_fields: None,
        tombstones_record: true,
        provenance: None,
        ..Default::default()
    };
    let error = apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("lifecycle-duplicate"),
            vec![tombstone.clone(), tombstone],
        ),
    )
    .unwrap_err();
    assert!(matches!(error, DbError::TimelineConflict { .. }));
    let residue: i64 = db
        .client
        .query_one(
            "select count(*) from change_set where app_id = 'core_app' and customer_id = 'customer_lifecycle_duplicate' and idempotency_key = 'lifecycle-duplicate'",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(residue, 0);

    let tombstone = apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("lifecycle-database-first"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: None,
                custom_fields: None,
                tombstones_record: true,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    let other = apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("lifecycle-database-other"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("beta"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Beta")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    let database_duplicate = db
        .client
        .execute(
            r#"
            insert into company_version (
              id,
              record_id,
              app_id,
              customer_id,
              stage,
              effective_start,
              change_set_id,
              applied_at,
              tombstones_record
            )
            select
              $1,
              record_id,
              app_id,
              customer_id,
              'mainline',
              effective_start,
              $2,
              now(),
              true
            from company_version
            where change_set_id = $3
            "#,
            &[&uuid::Uuid::new_v4(), &other.id, &tombstone.id],
        )
        .unwrap_err();
    assert_eq!(
        database_duplicate.code(),
        Some(&postgres::error::SqlState::UNIQUE_VIOLATION)
    );
}

#[test]
fn direct_mainline_planned_relation_is_input_order_independent() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_planned_relation")).unwrap();

    let applied = apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_planned_relation",
            Some("planned-relation-source-first"),
            vec![
                RowVersionWrite {
                    model_id: ModelId::from("employee"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alice"))),
                    effective_start: date("2026-05-01"),
                    values: Some(employee_values(
                        "Alice",
                        RecordKey::ExternalKey(ExternalKey::from("acme")),
                    )),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                },
                RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                    effective_start: date("2026-05-01"),
                    values: Some(text_values("Acme")),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                },
            ],
        ),
    )
    .unwrap();

    let row = db
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
            where ev.app_id = 'core_app'
              and ev.customer_id = 'customer_planned_relation'
              and er.external_key = 'alice'
            "#,
            &[],
        )
        .unwrap();
    assert_eq!(
        row.get::<_, RecordId>("employer"),
        row.get::<_, RecordId>("company_id")
    );
    assert_eq!(row.get::<_, i64>("change_set_id"), applied.id);
}

#[test]
fn invalid_planned_relation_rolls_back_all_reservations() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(
        &mut db.client,
        &test_schema("customer_planned_relation_rollback"),
    )
    .unwrap();

    let error = apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_planned_relation_rollback",
            Some("planned-relation-not-yet-visible"),
            vec![
                RowVersionWrite {
                    model_id: ModelId::from("employee"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alice"))),
                    effective_start: date("2026-05-01"),
                    values: Some(employee_values(
                        "Alice",
                        RecordKey::ExternalKey(ExternalKey::from("acme")),
                    )),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                },
                RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                    effective_start: date("2026-06-01"),
                    values: Some(text_values("Acme")),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                },
            ],
        ),
    )
    .unwrap_err();
    assert!(matches!(error, DbError::RecordTargetMissing { .. }));
    let residue: i64 = db
        .client
        .query_one(
            r#"
            select
              (select count(*) from employee_record where app_id = 'core_app' and customer_id = 'customer_planned_relation_rollback')
              + (select count(*) from company_record where app_id = 'core_app' and customer_id = 'customer_planned_relation_rollback')
              + (select count(*) from change_set where app_id = 'core_app' and customer_id = 'customer_planned_relation_rollback')
              + (select count(*) from employee_version where app_id = 'core_app' and customer_id = 'customer_planned_relation_rollback')
              + (select count(*) from company_version where app_id = 'core_app' and customer_id = 'customer_planned_relation_rollback')
            "#,
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(residue, 0);

    let tombstoned = apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_planned_relation_rollback",
            Some("planned-relation-tombstoned"),
            vec![
                RowVersionWrite {
                    model_id: ModelId::from("employee"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alice"))),
                    effective_start: date("2026-05-01"),
                    values: Some(employee_values(
                        "Alice",
                        RecordKey::ExternalKey(ExternalKey::from("acme")),
                    )),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                },
                RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                    effective_start: date("2026-05-01"),
                    values: Some(text_values("Acme")),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                },
                RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                    effective_start: date("2026-05-01"),
                    values: None,
                    custom_fields: None,
                    tombstones_record: true,
                    provenance: None,

                    ..Default::default()
                },
            ],
        ),
    )
    .unwrap_err();
    assert!(matches!(tombstoned, DbError::TombstonedRecord { .. }));
    let tombstoned_residue: i64 = db
        .client
        .query_one(
            r#"
            select
              (select count(*) from employee_record where app_id = 'core_app' and customer_id = 'customer_planned_relation_rollback')
              + (select count(*) from company_record where app_id = 'core_app' and customer_id = 'customer_planned_relation_rollback')
              + (select count(*) from change_set where app_id = 'core_app' and customer_id = 'customer_planned_relation_rollback')
              + (select count(*) from employee_version where app_id = 'core_app' and customer_id = 'customer_planned_relation_rollback')
              + (select count(*) from company_version where app_id = 'core_app' and customer_id = 'customer_planned_relation_rollback')
            "#,
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(tombstoned_residue, 0);
}

#[test]
fn overlapping_mainline_requests_lock_records_canonically_before_ordering() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let customer_id = "customer_canonical_apply_locks";
    materialize_schema(&mut db.client, &test_schema(customer_id)).unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("canonical-lock-baseline"),
            vec![
                RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alpha"))),
                    effective_start: date("2026-04-01"),
                    values: Some(text_values("Alpha")),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                },
                RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("beta"))),
                    effective_start: date("2026-04-01"),
                    values: Some(text_values("Beta")),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                },
            ],
        ),
    )
    .unwrap();

    let schema_name = db.schema_name.clone();
    let first_schema_name = schema_name.clone();
    let second_schema_name = schema_name;
    let barrier = Arc::new(Barrier::new(2));
    let first_barrier = Arc::clone(&barrier);
    let second_barrier = Arc::clone(&barrier);
    let first = thread::spawn(move || {
        let mut client = connect_to_test_schema(&first_schema_name);
        client
            .batch_execute("set statement_timeout = '10s'")
            .unwrap();
        first_barrier.wait();
        apply_change_set(
            &mut client,
            &mainline_apply(
                "customer_canonical_apply_locks",
                Some("canonical-lock-first"),
                vec![
                    RowVersionWrite {
                        model_id: ModelId::from("company"),
                        new_record_id: None,
                        record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alpha"))),
                        effective_start: date("2026-05-01"),
                        values: Some(text_values("Alpha First")),
                        custom_fields: None,
                        tombstones_record: false,
                        provenance: None,

                        ..Default::default()
                    },
                    RowVersionWrite {
                        model_id: ModelId::from("company"),
                        new_record_id: None,
                        record_key: Some(RecordKey::ExternalKey(ExternalKey::from("beta"))),
                        effective_start: date("2026-05-01"),
                        values: Some(text_values("Beta First")),
                        custom_fields: None,
                        tombstones_record: false,
                        provenance: None,

                        ..Default::default()
                    },
                ],
            ),
        )
        .map_err(|error| format!("{error:?}"))
    });
    let second = thread::spawn(move || {
        let mut client = connect_to_test_schema(&second_schema_name);
        client
            .batch_execute("set statement_timeout = '10s'")
            .unwrap();
        second_barrier.wait();
        apply_change_set(
            &mut client,
            &mainline_apply(
                "customer_canonical_apply_locks",
                Some("canonical-lock-second"),
                vec![
                    RowVersionWrite {
                        model_id: ModelId::from("company"),
                        new_record_id: None,
                        record_key: Some(RecordKey::ExternalKey(ExternalKey::from("beta"))),
                        effective_start: date("2026-05-01"),
                        values: Some(text_values("Beta Second")),
                        custom_fields: None,
                        tombstones_record: false,
                        provenance: None,

                        ..Default::default()
                    },
                    RowVersionWrite {
                        model_id: ModelId::from("company"),
                        new_record_id: None,
                        record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alpha"))),
                        effective_start: date("2026-05-01"),
                        values: Some(text_values("Alpha Second")),
                        custom_fields: None,
                        tombstones_record: false,
                        provenance: None,

                        ..Default::default()
                    },
                ],
            ),
        )
        .map_err(|error| format!("{error:?}"))
    });
    let first = first.join().unwrap().unwrap();
    let second = second.join().unwrap().unwrap();
    assert_ne!(first.id, second.id);

    let rows = db
        .client
        .query(
            r#"
            select idempotency_key, applied_order
            from change_set
            where app_id = 'core_app'
              and customer_id = 'customer_canonical_apply_locks'
              and idempotency_key in ('canonical-lock-first', 'canonical-lock-second')
            order by applied_order
            "#,
            &[],
        )
        .unwrap();
    assert_eq!(rows.len(), 2);
    assert!(rows[0].get::<_, i64>("applied_order") < rows[1].get::<_, i64>("applied_order"));
}

#[test]
fn applied_order_is_allocated_after_the_subject_lock_is_acquired() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let customer_id = "customer_post_lock_order";
    materialize_schema(&mut db.client, &test_schema(customer_id)).unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("post-lock-order-baseline"),
            vec![
                RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alpha"))),
                    effective_start: date("2026-04-01"),
                    values: Some(text_values("Alpha")),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                },
                RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("beta"))),
                    effective_start: date("2026-04-01"),
                    values: Some(text_values("Beta")),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                },
            ],
        ),
    )
    .unwrap();

    let schema_name = db.schema_name.clone();
    let waiting_schema_name = schema_name.clone();
    let mut blocker = begin_tenant_transaction(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from(customer_id),
    )
    .unwrap();
    blocker
        .query_one(
            "select id from company_record where app_id = 'core_app' and customer_id = 'customer_post_lock_order' and external_key = 'alpha' for update",
            &[],
        )
        .unwrap();

    let (pid_sender, pid_receiver) = mpsc::channel();
    let waiting = thread::spawn(move || {
        let mut client = connect_to_test_schema(&waiting_schema_name);
        let pid: i32 = client
            .query_one("select pg_backend_pid()", &[])
            .unwrap()
            .get(0);
        pid_sender.send(pid).unwrap();
        apply_change_set(
            &mut client,
            &mainline_apply(
                "customer_post_lock_order",
                Some("post-lock-order-alpha"),
                vec![RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alpha"))),
                    effective_start: date("2026-05-01"),
                    values: Some(text_values("Alpha Updated")),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                }],
            ),
        )
        .map_err(|error| format!("{error:?}"))
    });
    let waiting_pid = pid_receiver.recv().unwrap();
    let deadline = Instant::now() + StdDuration::from_secs(2);
    loop {
        let is_waiting: bool = blocker
            .query_one(
                "select exists (select 1 from pg_stat_activity where pid = $1 and wait_event_type = 'Lock')",
                &[&waiting_pid],
            )
            .unwrap()
            .get(0);
        if is_waiting {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "waiting apply never reached the subject lock"
        );
        thread::sleep(StdDuration::from_millis(10));
    }

    let beta = {
        let mut client = connect_to_test_schema(&schema_name);
        apply_change_set(
            &mut client,
            &mainline_apply(
                customer_id,
                Some("post-lock-order-beta"),
                vec![RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("beta"))),
                    effective_start: date("2026-05-01"),
                    values: Some(text_values("Beta Updated")),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                }],
            ),
        )
        .unwrap()
    };
    blocker.commit().unwrap();
    let alpha = waiting.join().unwrap().unwrap();

    let rows = db
        .client
        .query(
            "select id, applied_order from change_set where id = any($1) order by applied_order",
            &[&vec![alpha.id, beta.id]],
        )
        .unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].get::<_, i64>("id"), beta.id);
    assert_eq!(rows[1].get::<_, i64>("id"), alpha.id);
}

#[test]
fn caller_owned_apply_aborts_the_outer_transaction_on_dependency_drift() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let customer_id = "customer_caller_owned_drift";
    materialize_schema(&mut db.client, &test_schema(customer_id)).unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("caller-owned-drift-baseline"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-04-01"),
                values: Some(text_values("Acme")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    let schema_name = db.schema_name.clone();
    let mut blocker = begin_tenant_transaction(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from(customer_id),
    )
    .unwrap();
    blocker
        .query_one(
            "select id from company_record where app_id = 'core_app' and customer_id = 'customer_caller_owned_drift' and external_key = 'acme' for update",
            &[],
        )
        .unwrap();

    let (pid_sender, pid_receiver) = mpsc::channel();
    let waiting = thread::spawn(move || {
        let mut client = connect_to_test_schema(&schema_name);
        let mut tx = begin_tenant_transaction(
            &mut client,
            &AppId::from("core_app"),
            &CustomerId::from("customer_caller_owned_drift"),
        )
        .unwrap();
        let pid: i32 = tx.query_one("select pg_backend_pid()", &[]).unwrap().get(0);
        pid_sender.send(pid).unwrap();
        let error = apply_change_set_in_transaction(
            &mut tx,
            &mainline_apply(
                "customer_caller_owned_drift",
                Some("caller-owned-drift-waiter"),
                vec![RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                    effective_start: date("2026-05-01"),
                    values: Some(text_values("Acme Waiting")),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                }],
            ),
        )
        .unwrap_err();
        assert!(matches!(
            &error,
            DbError::Postgres(error)
                if error.code() == Some(&postgres::error::SqlState::T_R_SERIALIZATION_FAILURE)
        ));
        let aborted = tx.query_one("select 1", &[]).unwrap_err();
        assert_eq!(
            aborted.code(),
            Some(&postgres::error::SqlState::IN_FAILED_SQL_TRANSACTION)
        );
    });
    let waiting_pid = pid_receiver.recv().unwrap();
    let deadline = Instant::now() + StdDuration::from_secs(2);
    loop {
        let is_waiting: bool = blocker
            .query_one(
                "select exists (select 1 from pg_stat_activity where pid = $1 and wait_event_type = 'Lock')",
                &[&waiting_pid],
            )
            .unwrap()
            .get(0);
        if is_waiting {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "caller-owned apply never reached the record lock"
        );
        thread::sleep(StdDuration::from_millis(10));
    }

    apply_change_set_in_transaction(
        &mut blocker,
        &mainline_apply(
            customer_id,
            Some("caller-owned-drift-blocker"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme Blocker")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    blocker.commit().unwrap();
    waiting.join().unwrap();

    let waiter_residue: i64 = db
        .client
        .query_one(
            "select count(*) from change_set where app_id = 'core_app' and customer_id = 'customer_caller_owned_drift' and idempotency_key = 'caller-owned-drift-waiter'",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(waiter_residue, 0);
}

#[test]
fn mainline_apply_requires_visible_version_and_replays_before_preconditions() {
    let customer_id = "customer_version_preconditions";
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema(customer_id)).unwrap();

    apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("version-create"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Initial")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,
                ..Default::default()
            }],
        ),
    )
    .unwrap();
    let initial_version_id = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from(customer_id),
        &ModelId::from("company"),
        date("2026-05-01"),
    )
    .unwrap()
    .into_iter()
    .next()
    .expect("initial record is visible")
    .version_id
    .expect("visible records expose their version token");

    let guarded = mainline_apply(
        customer_id,
        Some("version-guarded"),
        vec![RowVersionWrite {
            model_id: ModelId::from("company"),
            new_record_id: None,
            record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
            effective_start: date("2026-05-05"),
            values: Some(text_values("Guarded")),
            custom_fields: None,
            tombstones_record: false,
            provenance: None,
            expected_version_id: Some(initial_version_id),
            ..Default::default()
        }],
    );
    let applied = apply_change_set(&mut db.client, &guarded).unwrap();

    apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("version-later"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-07"),
                values: Some(text_values("Later")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,
                ..Default::default()
            }],
        ),
    )
    .unwrap();
    assert_eq!(
        apply_change_set(&mut db.client, &guarded).unwrap(),
        applied,
        "an exact replay returns its receipt before checking a now-stale guard"
    );

    let mut changed_token = guarded.clone();
    changed_token.writes[0].expected_version_id = Some(uuid::Uuid::new_v4());
    assert!(matches!(
        apply_change_set(&mut db.client, &changed_token)
            .expect_err("changing a guard changes the idempotency fingerprint"),
        DbError::IdempotencyConflict { .. }
    ));

    let error = apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("version-stale"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-06"),
                values: Some(text_values("Stale")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,
                expected_version_id: Some(initial_version_id),
                ..Default::default()
            }],
        ),
    )
    .expect_err("the original date-specific token is stale after the guarded update");
    assert!(matches!(error, DbError::VersionConflict));
}

#[test]
fn mainline_apply_allows_value_and_tombstone_at_same_effective_start() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();

    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("company-same-day-value"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("company-same-day-tombstone"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: None,
                custom_fields: None,
                tombstones_record: true,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    let records = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        &ModelId::from("company"),
        date("2026-05-01"),
    )
    .unwrap();
    assert!(records.is_empty());
}

#[test]
fn mainline_apply_replays_idempotent_request_after_schema_activation_changes() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();
    let apply = mainline_apply(
        "customer_a",
        Some("company-before-schema-change"),
        vec![RowVersionWrite {
            model_id: ModelId::from("company"),
            new_record_id: None,
            record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
            effective_start: date("2026-05-01"),
            values: Some(text_values("Acme")),
            custom_fields: None,
            tombstones_record: false,
            provenance: None,

            ..Default::default()
        }],
    );

    let first = apply_change_set(&mut db.client, &apply).unwrap();
    let mut next_schema = test_schema("customer_a");
    next_schema.version = SchemaVersion::from("2026-06-01");
    next_schema.models[0].label = "Company V2".to_string();
    materialize_schema(&mut db.client, &next_schema).unwrap();

    let schema_name = db.schema_name.clone();
    let replay_apply = apply.clone();
    let mut schema_lock = db.client.transaction().unwrap();
    let lock_name = format!(
        "postgres-schema:{schema_name}:materialize-tenant:core_app:customer_a:schema-activation"
    );
    schema_lock
        .query_one(
            "select pg_advisory_xact_lock(hashtext($1)::bigint)",
            &[&lock_name],
        )
        .unwrap();
    let replay = thread::spawn(move || {
        let mut client = connect_to_test_schema(&schema_name);
        client
            .batch_execute("set statement_timeout = '2s'")
            .unwrap();
        apply_change_set(&mut client, &replay_apply).map_err(|error| format!("{error:?}"))
    });
    let second = replay.join().unwrap().unwrap();
    schema_lock.rollback().unwrap();
    assert_eq!(first, second);
}

#[test]
fn mainline_apply_rejects_missing_and_cross_tenant_relation_targets() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();
    materialize_schema(&mut db.client, &test_schema("customer_b")).unwrap();

    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_b",
            Some("company-b"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme B")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    let missing = mainline_apply(
        "customer_a",
        Some("employee-missing-relation"),
        vec![RowVersionWrite {
            model_id: ModelId::from("employee"),
            new_record_id: None,
            record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alice"))),
            effective_start: date("2026-05-01"),
            values: Some(employee_values(
                "Alice",
                RecordKey::ExternalKey(ExternalKey::from("acme")),
            )),
            custom_fields: None,
            tombstones_record: false,
            provenance: None,

            ..Default::default()
        }],
    );
    let error = apply_change_set(&mut db.client, &missing).unwrap_err();
    assert!(matches!(error, DbError::RecordTargetMissing { .. }));

    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("future-company"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("future"))),
                effective_start: date("2026-06-01"),
                values: Some(text_values("Future")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    let future_target = mainline_apply(
        "customer_a",
        Some("employee-future-relation"),
        vec![RowVersionWrite {
            model_id: ModelId::from("employee"),
            new_record_id: None,
            record_key: Some(RecordKey::ExternalKey(ExternalKey::from("bob"))),
            effective_start: date("2026-05-01"),
            values: Some(employee_values(
                "Bob",
                RecordKey::ExternalKey(ExternalKey::from("future")),
            )),
            custom_fields: None,
            tombstones_record: false,
            provenance: None,

            ..Default::default()
        }],
    );
    let error = apply_change_set(&mut db.client, &future_target).unwrap_err();
    assert!(matches!(error, DbError::RecordTargetMissing { .. }));
}

#[test]
fn mainline_apply_tombstones_hide_records_from_visible_reads() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("company-create-for-delete"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("company-delete"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-06-01"),
                values: None,
                custom_fields: None,
                tombstones_record: true,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    let before = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        &ModelId::from("company"),
        date("2026-05-15"),
    )
    .unwrap();
    assert_eq!(before.len(), 1);

    let after = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        &ModelId::from("company"),
        date("2026-06-15"),
    )
    .unwrap();
    assert!(after.is_empty());
}

#[test]
fn query_visible_sql_filters_projects_joins_aggregates_and_windows() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("sql-company-acme"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("sql-employee-alice"),
            vec![RowVersionWrite {
                model_id: ModelId::from("employee"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alice"))),
                effective_start: date("2026-05-01"),
                values: Some(employee_values(
                    "Alice",
                    RecordKey::ExternalKey(ExternalKey::from("acme")),
                )),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    let result = query_visible_sql(
        &mut db.client,
        &sql_query(
            "customer_a",
            r#"
            select
              er.external_key as employee_key,
              ev.name as employee_name,
              cr.external_key as company_key,
              ev.comp_rate_amount as hourly_rate,
              count(*) over () as visible_count
            from employee_record er
            join employee_version ev on ev.record_id = er.id
            join company_record cr on cr.id = ev.employer
            join company_version cv on cv.record_id = cr.id
            where ev.stage = 'mainline'
              and ev.effective_start <= $1
              and (ev.effective_end is null or ev.effective_end >= $1)
              and ev.comp_rate_amount >= $2
              and not ev.tombstones_record
              and cv.stage = 'mainline'
            order by er.external_key
            "#,
            vec![
                SqlParam::Date(date("2026-05-15")),
                SqlParam::Number(Decimal::new(12500, 2)),
            ],
        ),
    )
    .unwrap();
    assert_eq!(
        result
            .columns
            .iter()
            .map(|column| column.name.as_str())
            .collect::<Vec<_>>(),
        vec![
            "employee_key",
            "employee_name",
            "company_key",
            "hourly_rate",
            "visible_count"
        ]
    );
    assert_eq!(
        result.rows,
        vec![vec![
            serde_json::json!("alice"),
            serde_json::json!("Alice"),
            serde_json::json!("acme"),
            serde_json::json!(125.00),
            serde_json::json!(1)
        ]]
    );
}

#[test]
fn query_visible_sql_allows_model_tables_with_pg_prefix() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = Schema {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from("customer_a"),
        version: SchemaVersion::from("2026-05-04"),
        models: vec![Model {
            id: ModelId::from("pg_data"),
            kind: ModelKind::Entity,
            label: "PG Data".to_string(),
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
        change_types: vec![ChangeType {
            id: ChangeTypeId::from("pg_data_update"),
            label: "PG Data Update".to_string(),
            target_model: ModelId::from("pg_data"),
            is_import_default: false,
            touches: vec![],
            required: vec![],
        }],
    };
    materialize_schema(&mut db.client, &schema).unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("sql-pg-data"),
            vec![RowVersionWrite {
                model_id: ModelId::from("pg_data"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alpha"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Alpha")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    let result = query_visible_sql(
        &mut db.client,
        &sql_query(
            "customer_a",
            r#"
            select r.external_key, v.name
            from pg_data_record r
            join pg_data_version v on v.record_id = r.id
            where v.stage = 'mainline'
            "#,
            vec![],
        ),
    )
    .unwrap();
    assert_eq!(
        result.rows,
        vec![vec![serde_json::json!("alpha"), serde_json::json!("Alpha")]]
    );
}

#[test]
fn query_visible_sql_reads_drafts_change_sets_and_respects_rls() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();
    materialize_schema(&mut db.client, &test_schema("customer_b")).unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("sql-rls-company-a"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme-a"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme A")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_b",
            Some("sql-rls-company-b"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme-b"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme B")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    let draft = apply_change_set(
        &mut db.client,
        &draft_apply(
            "customer_a",
            Some("sql-draft-company-a"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("draft-a"))),
                effective_start: date("2026-06-01"),
                values: Some(text_values("Draft A")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    let raw_records = query_visible_sql(
        &mut db.client,
        &sql_query(
            "customer_a",
            "select external_key from company_record order by external_key",
            vec![],
        ),
    )
    .unwrap();
    assert_eq!(
        raw_records.rows,
        vec![
            vec![serde_json::json!("acme-a")],
            vec![serde_json::json!("draft-a")]
        ]
    );

    let draft_rows = query_visible_sql(
        &mut db.client,
        &sql_query(
            "customer_a",
            "select stage, name from company_version where change_set_id = $1 and stage = 'draft'",
            vec![SqlParam::Int(draft.id)],
        ),
    )
    .unwrap();
    assert_eq!(
        draft_rows.rows,
        vec![vec![
            serde_json::json!("draft"),
            serde_json::json!("Draft A")
        ]]
    );

    let change_sets = query_visible_sql(
        &mut db.client,
        &sql_query(
            "customer_a",
            "select count(*) as count from change_set",
            vec![],
        ),
    )
    .unwrap();
    assert_eq!(change_sets.rows, vec![vec![serde_json::json!(2)]]);
}

#[test]
fn query_visible_sql_sets_tenant_scope_before_schema_resolution_for_non_bypass_roles() {
    let Some(mut db) = TestDb::connect_owned_by_non_bypass_role() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("sql-non-bypass-company"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    let result = query_visible_sql(
        &mut db.client,
        &sql_query(
            "customer_a",
            "select external_key from company_record",
            vec![],
        ),
    )
    .unwrap();
    assert_eq!(result.rows, vec![vec![serde_json::json!("acme")]]);
}

#[test]
fn query_visible_sql_drops_stale_temp_views_before_preparing_request_views() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();
    db.client
        .batch_execute("create temp view stale_query_view as select 1 as value;")
        .unwrap();

    query_visible_sql(
        &mut db.client,
        &sql_query("customer_a", "select count(*) from company_record", vec![]),
    )
    .unwrap();

    let stale_view: Option<String> = db
        .client
        .query_one("select to_regclass('pg_temp.stale_query_view')::text", &[])
        .unwrap()
        .get(0);
    assert!(stale_view.is_none());
    for view_name in ["change_set", "company_record", "company_version"] {
        let query_view: Option<String> = db
            .client
            .query_one("select to_regclass('pg_temp.' || $1)::text", &[&view_name])
            .unwrap()
            .get(0);
        assert!(
            query_view.is_none(),
            "temporary query view `{view_name}` leaked"
        );
    }

    db.client
        .batch_execute("create temp view stale_query_view as select 1 as value;")
        .unwrap();
    let rejected = query_visible_sql(
        &mut db.client,
        &sql_query("customer_a", "delete from change_set", vec![]),
    )
    .unwrap_err();
    assert!(matches!(rejected, DbError::QueryRejected { .. }));
    for view_name in [
        "stale_query_view",
        "change_set",
        "company_record",
        "company_version",
    ] {
        let query_view: Option<String> = db
            .client
            .query_one("select to_regclass('pg_temp.' || $1)::text", &[&view_name])
            .unwrap()
            .get(0);
        assert!(
            query_view.is_none(),
            "temporary query view `{view_name}` leaked after rejection"
        );
    }
}

#[test]
fn query_visible_sql_rejects_unsafe_sql_and_read_role_has_no_write_grants() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();

    for sql in [
        "select 1; select 2",
        "insert into company_record (id) values (gen_random_uuid())",
        "create table query_escape (id int)",
        "update change_set set notes = 'bad'",
        "delete from change_set",
        "select set_config('platform.customer_id', 'customer_b', true)",
        "select count(*) from pg_catalog.pg_tables",
        "select count(*) from pg_tables",
        "select count(*) from information_schema.tables",
    ] {
        let error =
            query_visible_sql(&mut db.client, &sql_query("customer_a", sql, vec![])).unwrap_err();
        assert!(matches!(error, DbError::QueryRejected { .. }));
    }
    let schema_qualified_base_table =
        format!("select count(*) from {}.company_record", db.schema_name);
    let error = query_visible_sql(
        &mut db.client,
        &sql_query("customer_a", &schema_qualified_base_table, vec![]),
    )
    .unwrap_err();
    assert!(matches!(error, DbError::QueryRejected { .. }));

    let incidental_catalog_name = query_visible_sql(
        &mut db.client,
        &sql_query("customer_a", "select 'pg_foo' as label", vec![]),
    )
    .unwrap();
    assert_eq!(
        incidental_catalog_name.rows,
        vec![vec![serde_json::json!("pg_foo")]]
    );

    let error = query_visible_sql(
        &mut db.client,
        &QueryVisibleSql {
            statement_timeout_ms: Some(0),
            ..sql_query("customer_a", "select pg_sleep(1)", vec![])
        },
    )
    .unwrap_err();
    assert!(
        matches!(error, DbError::QueryTimeout { .. }),
        "expected query timeout, got {error:?}"
    );

    let role_error = db
        .client
        .batch_execute(
            r#"
            begin;
            set local role kernel_query;
            insert into change_set (app_id, customer_id, schema_revision_id, created_with_mode, status, source_kind, created_order)
            values ('core_app', 'customer_a', 1, 'mainline', 'mainline', 'test', 1);
            "#,
        )
        .unwrap_err();
    assert_eq!(
        role_error.code(),
        Some(&postgres::error::SqlState::INSUFFICIENT_PRIVILEGE)
    );
    db.client.batch_execute("rollback; reset role;").unwrap();

    let agent_role_error = db
        .client
        .batch_execute(
            r#"
            begin;
            set local role kernel_query;
            insert into agent_run (
              app_id,
              customer_id,
              run_id,
              schema_revision_id,
              agent_identity_id,
              execution_profile_id
            )
            values ('core_app', 'customer_a', 'run_denied', 1, 'agent', 'profile');
            "#,
        )
        .unwrap_err();
    assert_eq!(
        agent_role_error.code(),
        Some(&postgres::error::SqlState::INSUFFICIENT_PRIVILEGE)
    );
    db.client.batch_execute("rollback; reset role;").unwrap();
}

#[test]
fn change_set_diff_covers_mainline_draft_and_projection() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();
    let create = apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("diff-create-acme"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    let create_diff = change_set_diff(
        &mut db.client,
        &ChangeSetDiffRequest {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from("customer_a"),
            change_set_id: create.id,
            project: vec![],
        },
    )
    .unwrap();
    assert_eq!(create_diff.records.len(), 1);
    assert_eq!(create_diff.records[0].stage, VersionStage::Mainline);
    assert_eq!(create_diff.records[0].external_key.as_deref(), Some("acme"));
    assert_eq!(create_diff.records[0].fields[0].before, None,);
    assert_eq!(
        create_diff.records[0].fields[0].after,
        Some(FieldValue::Text("Acme".to_string()))
    );

    let update = apply_change_set(
        &mut db.client,
        &draft_apply(
            "customer_a",
            Some("diff-draft-acme"),
            vec![
                RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                    effective_start: date("2026-06-01"),
                    values: Some(text_values("Acme Draft")),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                },
                RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                    effective_start: date("2026-07-01"),
                    values: Some(text_values("Acme Draft Later")),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                },
            ],
        ),
    )
    .unwrap();
    let draft_diff = change_set_diff(
        &mut db.client,
        &ChangeSetDiffRequest {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from("customer_a"),
            change_set_id: update.id,
            project: vec![FieldId::from("name")],
        },
    )
    .unwrap();
    assert_eq!(draft_diff.records.len(), 2);
    assert_eq!(draft_diff.records[0].stage, VersionStage::Draft);
    assert_eq!(
        draft_diff.records[0].fields,
        vec![kernel::FieldDiff {
            field_id: FieldId::from("name"),
            before: Some(FieldValue::Text("Acme".to_string())),
            after: Some(FieldValue::Text("Acme Draft".to_string())),
            before_enum: None,
            after_enum: None,
        }]
    );
    assert_eq!(
        draft_diff.records[1].fields,
        vec![kernel::FieldDiff {
            field_id: FieldId::from("name"),
            before: Some(FieldValue::Text("Acme Draft".to_string())),
            after: Some(FieldValue::Text("Acme Draft Later".to_string())),
            before_enum: None,
            after_enum: None,
        }]
    );

    let other_tenant_diff = change_set_diff(
        &mut db.client,
        &ChangeSetDiffRequest {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from("customer_b"),
            change_set_id: create.id,
            project: vec![],
        },
    )
    .unwrap_err();
    assert!(matches!(
        other_tenant_diff,
        DbError::RecordTargetMissing { .. }
    ));
}

#[test]
fn change_set_diff_allows_backdated_draft_before_first_visible_version() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let customer_id = "customer_diff_priorless";
    let record_key = ExternalKey::from("diff-priorless-acme");
    materialize_schema(&mut db.client, &test_schema(customer_id)).unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("diff-priorless-baseline"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(record_key.clone())),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    let draft = apply_change_set(
        &mut db.client,
        &draft_apply(
            customer_id,
            Some("diff-priorless-draft"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(record_key)),
                effective_start: date("2026-03-31"),
                values: Some(text_values("Acme Backdated")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    // Same effective-time corner as docs/known-footguns.md's back-dated
    // imports entry: the draft lands beneath a later visible version, but its
    // review diff still needs a typed create-shaped before-state.
    let draft_diff = change_set_diff(
        &mut db.client,
        &ChangeSetDiffRequest {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from(customer_id),
            change_set_id: draft.id,
            project: vec![FieldId::from("name")],
        },
    )
    .unwrap();
    assert_eq!(draft_diff.records.len(), 1);
    assert_eq!(draft_diff.records[0].stage, VersionStage::Draft);
    assert_eq!(draft_diff.records[0].effective_start, date("2026-03-31"));
    assert_eq!(
        draft_diff.records[0].fields,
        vec![kernel::FieldDiff {
            field_id: FieldId::from("name"),
            before: None,
            after: Some(FieldValue::Text("Acme Backdated".to_string())),
            before_enum: None,
            after_enum: None,
        }]
    );

    let approval = approve_draft_change_set(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from(customer_id),
        draft.id,
    )
    .unwrap();
    assert_eq!(approval.id, draft.id);

    let april = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from(customer_id),
        &ModelId::from("company"),
        date("2026-04-15"),
    )
    .unwrap();
    assert_eq!(
        april[0].values.get(&FieldId::from("name")),
        Some(&FieldValue::Text("Acme Backdated".to_string()))
    );
    let may = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from(customer_id),
        &ModelId::from("company"),
        date("2026-05-15"),
    )
    .unwrap();
    assert_eq!(
        may[0].values.get(&FieldId::from("name")),
        Some(&FieldValue::Text("Acme".to_string()))
    );
}

#[test]
fn change_set_diff_allows_backdated_draft_sandwiched_between_mainline_versions() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let customer_id = "customer_diff_sandwich";
    let record_key = ExternalKey::from("diff-sandwich-acme");
    materialize_schema(&mut db.client, &test_schema(customer_id)).unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("diff-sandwich-baseline"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(record_key.clone())),
                effective_start: date("2026-03-01"),
                values: Some(text_values("Acme T1")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("diff-sandwich-later-mainline"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(record_key.clone())),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme T3")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    let draft = apply_change_set(
        &mut db.client,
        &draft_apply(
            customer_id,
            Some("diff-sandwich-draft"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(record_key)),
                effective_start: date("2026-03-31"),
                values: Some(text_values("Acme T2 Draft")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    let draft_diff = change_set_diff(
        &mut db.client,
        &ChangeSetDiffRequest {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from(customer_id),
            change_set_id: draft.id,
            project: vec![FieldId::from("name")],
        },
    )
    .unwrap();
    assert_eq!(draft_diff.records.len(), 1);
    assert_eq!(draft_diff.records[0].stage, VersionStage::Draft);
    assert_eq!(draft_diff.records[0].effective_start, date("2026-03-31"));
    assert_eq!(
        draft_diff.records[0].fields,
        vec![kernel::FieldDiff {
            field_id: FieldId::from("name"),
            before: Some(FieldValue::Text("Acme T1".to_string())),
            after: Some(FieldValue::Text("Acme T2 Draft".to_string())),
            before_enum: None,
            after_enum: None,
        }]
    );

    let approval = approve_draft_change_set(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from(customer_id),
        draft.id,
    )
    .unwrap();
    assert_eq!(approval.id, draft.id);

    let march = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from(customer_id),
        &ModelId::from("company"),
        date("2026-03-15"),
    )
    .unwrap();
    assert_eq!(
        march[0].values.get(&FieldId::from("name")),
        Some(&FieldValue::Text("Acme T1".to_string()))
    );
    let april = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from(customer_id),
        &ModelId::from("company"),
        date("2026-04-15"),
    )
    .unwrap();
    assert_eq!(
        april[0].values.get(&FieldId::from("name")),
        Some(&FieldValue::Text("Acme T2 Draft".to_string()))
    );
    let may = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from(customer_id),
        &ModelId::from("company"),
        date("2026-05-15"),
    )
    .unwrap();
    assert_eq!(
        may[0].values.get(&FieldId::from("name")),
        Some(&FieldValue::Text("Acme T3".to_string()))
    );
}

#[test]
fn history_and_diff_annotate_reverted_rows_and_revert_audit_effect() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("history-revert-create"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    let target = apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("history-revert-update"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-06-01"),
                values: Some(text_values("Acme Updated")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    let record_id: uuid::Uuid = db
        .client
        .query_one(
            "select id from company_record where external_key = 'acme'",
            &[],
        )
        .unwrap()
        .get(0);
    let revert = revert_change_set(
        &mut db.client,
        &revert_request("customer_a", target.id, Some("history-revert-update-key")),
    )
    .unwrap();

    let target_diff = change_set_diff(
        &mut db.client,
        &ChangeSetDiffRequest {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from("customer_a"),
            change_set_id: target.id,
            project: vec![],
        },
    )
    .unwrap();
    assert_eq!(target_diff.records[0].stage, VersionStage::Reverted);
    assert_eq!(
        target_diff.records[0].fields[0].after,
        Some(FieldValue::Text("Acme Updated".to_string()))
    );

    let revert_diff = change_set_diff(
        &mut db.client,
        &ChangeSetDiffRequest {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from("customer_a"),
            change_set_id: revert.id,
            project: vec![],
        },
    )
    .unwrap();
    assert_eq!(revert_diff.change_set_id, revert.id);
    assert_eq!(revert_diff.source_change_set_id, target.id);
    assert_eq!(
        revert_diff.records[0].fields[0].before,
        Some(FieldValue::Text("Acme Updated".to_string()))
    );
    assert_eq!(
        revert_diff.records[0].fields[0].after,
        Some(FieldValue::Text("Acme".to_string()))
    );

    let history = field_history(
        &mut db.client,
        &FieldHistoryRequest {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from("customer_a"),
            model_id: ModelId::from("company"),
            record_id,
            field_id: Some(FieldId::from("name")),
            as_of: None,
            limit: None,
            stages: vec![],
        },
    )
    .unwrap();
    assert_eq!(history.len(), 2);
    assert_eq!(history[0].stage, VersionStage::Mainline);
    assert_eq!(history[0].reverted_by, None);
    assert_eq!(history[1].stage, VersionStage::Reverted);
    assert_eq!(history[1].reverted_by, Some(revert.id));

    let draft = apply_change_set(
        &mut db.client,
        &draft_apply(
            "customer_a",
            Some("history-draft"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-07-01"),
                values: Some(text_values("Acme Draft")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    let draft_history = field_history(
        &mut db.client,
        &FieldHistoryRequest {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from("customer_a"),
            model_id: ModelId::from("company"),
            record_id,
            field_id: Some(FieldId::from("name")),
            as_of: None,
            limit: None,
            stages: vec![VersionStage::Draft],
        },
    )
    .unwrap();
    assert_eq!(draft_history.len(), 1);
    assert_eq!(draft_history[0].change_set_id, draft.id);
    assert_eq!(
        draft_history[0].value,
        Some(FieldValue::Text("Acme Draft".to_string()))
    );
}

#[test]
fn field_history_limit_returns_newest_snapshots_in_chronological_order() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let customer_id = "customer_history_limit";
    materialize_schema(&mut db.client, &test_schema(customer_id)).unwrap();

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
        apply_change_set(
            &mut db.client,
            &mainline_apply(
                customer_id,
                Some(&format!("history-limit-{index}")),
                vec![RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("bounded"))),
                    effective_start: date(effective_start),
                    values: Some(text_values(&format!("Bounded {index}"))),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                }],
            ),
        )
        .unwrap();
    }

    let record_id = db
        .client
        .query_one(
            "select id from company_record where external_key = 'bounded'",
            &[],
        )
        .unwrap()
        .get(0);
    let history = field_history(
        &mut db.client,
        &FieldHistoryRequest {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from(customer_id),
            model_id: ModelId::from("company"),
            record_id,
            field_id: Some(FieldId::from("name")),
            as_of: Some(date("2026-04-01")),
            limit: Some(2),
            stages: vec![],
        },
    )
    .unwrap();

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
fn field_history_limit_counts_logical_snapshots_not_physical_rows() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let customer_id = "customer_history_logical_limit";
    materialize_schema(&mut db.client, &test_schema(customer_id)).unwrap();

    apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("history-logical-baseline"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("logical"))),
                effective_start: date("2026-01-01"),
                values: Some(text_values("Logical baseline")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    let latest = apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("history-logical-latest"),
            vec![
                RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("logical"))),
                    effective_start: date("2026-02-01"),
                    values: Some(text_values("Logical latest")),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                },
                RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("logical"))),
                    effective_start: date("2026-02-01"),
                    values: None,
                    custom_fields: None,
                    tombstones_record: true,
                    provenance: None,

                    ..Default::default()
                },
            ],
        ),
    )
    .unwrap();
    let record_id = db
        .client
        .query_one(
            "select id from company_record where external_key = 'logical'",
            &[],
        )
        .unwrap()
        .get(0);
    let history = field_history(
        &mut db.client,
        &FieldHistoryRequest {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from(customer_id),
            model_id: ModelId::from("company"),
            record_id,
            field_id: Some(FieldId::from("name")),
            as_of: None,
            limit: Some(1),
            stages: vec![],
        },
    )
    .unwrap();

    assert_eq!(history.len(), 2);
    assert!(history.iter().all(|entry| entry.change_set_id == latest.id));
    assert!(history
        .iter()
        .all(|entry| entry.effective_start == date("2026-02-01")));
}

#[test]
fn field_history_limit_breaks_same_effective_date_ties_by_applied_order() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let customer_id = "customer_history_same_date_limit";
    materialize_schema(&mut db.client, &test_schema(customer_id)).unwrap();
    let mut change_set_ids = Vec::new();

    for index in 0..3 {
        let change_set = apply_change_set(
            &mut db.client,
            &mainline_apply(
                customer_id,
                Some(&format!("history-same-date-{index}")),
                vec![RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("same-date"))),
                    effective_start: date("2026-05-01"),
                    values: Some(text_values(&format!("Same date {index}"))),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                }],
            ),
        )
        .unwrap();
        change_set_ids.push(change_set.id);
    }

    let record_id = db
        .client
        .query_one(
            "select id from company_record where external_key = 'same-date'",
            &[],
        )
        .unwrap()
        .get(0);
    let history = field_history(
        &mut db.client,
        &FieldHistoryRequest {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from(customer_id),
            model_id: ModelId::from("company"),
            record_id,
            field_id: Some(FieldId::from("name")),
            as_of: None,
            limit: Some(2),
            stages: vec![],
        },
    )
    .unwrap();

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
fn recent_activity_filters_and_counts_touched_records() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();
    let company = apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("activity-company"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    let draft = apply_change_set(
        &mut db.client,
        &draft_apply(
            "customer_a",
            Some("activity-draft"),
            vec![RowVersionWrite {
                model_id: ModelId::from("employee"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alice"))),
                effective_start: date("2026-05-01"),
                values: Some(employee_values(
                    "Alice",
                    RecordKey::ExternalKey(ExternalKey::from("acme")),
                )),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    let revert = revert_change_set(
        &mut db.client,
        &revert_request("customer_a", company.id, Some("activity-revert")),
    )
    .unwrap();

    let activity = recent_activity(
        &mut db.client,
        &RecentActivityRequest {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from("customer_a"),
            limit: Some(10),
            statuses: vec![],
            source_kinds: vec![],
        },
    )
    .unwrap();
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

    let revert_only = recent_activity(
        &mut db.client,
        &RecentActivityRequest {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from("customer_a"),
            limit: None,
            statuses: vec![ChangeSetStatus::Mainline],
            source_kinds: vec!["revert".to_string()],
        },
    )
    .unwrap();
    assert_eq!(revert_only.len(), 1);
    assert_eq!(revert_only[0].change_set_id, revert.id);
}

#[test]
fn revert_mainline_update_marks_target_rows_and_restores_previous_snapshot() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();

    let original = apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("revert-update-original"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    let target = apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("revert-update-target"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-06-01"),
                values: Some(text_values("Acme Updated")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    let revert = revert_change_set(
        &mut db.client,
        &revert_request("customer_a", target.id, Some("revert-update-target-key")),
    )
    .unwrap();
    assert_ne!(revert.id, target.id);

    let visible = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        &ModelId::from("company"),
        date("2026-06-15"),
    )
    .unwrap();
    assert_eq!(
        visible[0].values.get(&FieldId::from("name")),
        Some(&FieldValue::Text("Acme".to_string()))
    );

    let target_change_set = db
        .client
        .query_one(
            "select status, applied_at is not null as applied from change_set where id = $1",
            &[&target.id],
        )
        .unwrap();
    assert_eq!(target_change_set.get::<_, String>("status"), "mainline");
    assert!(target_change_set.get::<_, bool>("applied"));

    let revert_change_set = db
        .client
        .query_one(
            "select status, source_kind, source_ref from change_set where id = $1",
            &[&revert.id],
        )
        .unwrap();
    assert_eq!(revert_change_set.get::<_, String>("status"), "mainline");
    assert_eq!(revert_change_set.get::<_, String>("source_kind"), "revert");
    assert_eq!(
        revert_change_set.get::<_, Option<String>>("source_ref"),
        Some(target.id.to_string())
    );

    let version_rows = db
        .client
        .query(
            "select stage, applied_at is not null as applied from company_version where change_set_id = $1",
            &[&target.id],
        )
        .unwrap();
    assert_eq!(version_rows[0].get::<_, String>("stage"), "reverted");
    assert!(!version_rows[0].get::<_, bool>("applied"));

    let revert_version_count: i64 = db
        .client
        .query_one(
            "select count(*) from company_version where change_set_id = $1",
            &[&revert.id],
        )
        .unwrap()
        .get(0);
    assert_eq!(revert_version_count, 0);

    let mainline_change_sets: i64 = db
        .client
        .query_one(
            "select count(*) from change_set where status = 'mainline' and id in ($1, $2, $3)",
            &[&original.id, &target.id, &revert.id],
        )
        .unwrap()
        .get(0);
    assert_eq!(mainline_change_sets, 3);
}

#[test]
fn revert_same_day_tips_walk_immediate_predecessors_and_retain_audit_rows() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let customer_id = "customer_revert_same_day_walk";
    materialize_schema(&mut db.client, &test_schema(customer_id)).unwrap();

    let mut versions = Vec::new();
    for (index, name) in ["Acme One", "Acme Two", "Acme Three"]
        .into_iter()
        .enumerate()
    {
        versions.push(
            apply_change_set(
                &mut db.client,
                &mainline_apply(
                    customer_id,
                    Some(&format!("revert-same-day-walk-{index}")),
                    vec![RowVersionWrite {
                        model_id: ModelId::from("company"),
                        new_record_id: None,
                        record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                        effective_start: date("2026-05-01"),
                        values: Some(text_values(name)),
                        custom_fields: None,
                        tombstones_record: false,
                        provenance: None,

                        ..Default::default()
                    }],
                ),
            )
            .unwrap(),
        );
    }

    let non_tip = revert_change_set(
        &mut db.client,
        &revert_request(
            customer_id,
            versions[1].id,
            Some("revert-same-day-walk-non-tip"),
        ),
    )
    .unwrap_err();
    assert!(matches!(non_tip, DbError::RevertConflict { .. }));

    let third_revert = revert_change_set(
        &mut db.client,
        &revert_request(
            customer_id,
            versions[2].id,
            Some("revert-same-day-walk-third"),
        ),
    )
    .unwrap();
    let after_third = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from(customer_id),
        &ModelId::from("company"),
        date("2026-05-15"),
    )
    .unwrap();
    assert_eq!(
        after_third[0].values.get(&FieldId::from("name")),
        Some(&FieldValue::Text("Acme Two".to_string()))
    );
    assert_eq!(after_third[0].effective_end, None);

    let second_revert = revert_change_set(
        &mut db.client,
        &revert_request(
            customer_id,
            versions[1].id,
            Some("revert-same-day-walk-second"),
        ),
    )
    .unwrap();
    let after_second = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from(customer_id),
        &ModelId::from("company"),
        date("2026-05-15"),
    )
    .unwrap();
    assert_eq!(
        after_second[0].values.get(&FieldId::from("name")),
        Some(&FieldValue::Text("Acme One".to_string()))
    );
    assert_eq!(after_second[0].effective_end, None);

    let retained = db
        .client
        .query(
            r#"
            select v.change_set_id, v.stage, v.effective_end
            from company_version v
            join change_set cs on cs.id = v.change_set_id
            where v.app_id = 'core_app'
              and v.customer_id = $1
              and v.record_id = (
                select id from company_record
                where app_id = 'core_app'
                  and customer_id = $1
                  and external_key = 'acme'
              )
            order by cs.applied_order
            "#,
            &[&customer_id],
        )
        .unwrap();
    assert_eq!(retained.len(), 3);
    assert_eq!(retained[0].get::<_, String>("stage"), "mainline");
    assert_eq!(
        retained[0].get::<_, Option<NaiveDate>>("effective_end"),
        None
    );
    assert_eq!(retained[1].get::<_, String>("stage"), "reverted");
    assert_eq!(retained[2].get::<_, String>("stage"), "reverted");

    for revert in [third_revert, second_revert] {
        let audit = db
            .client
            .query_one(
                r#"
                select created_order = applied_order as orders_match,
                       (select count(*) from company_version where change_set_id = $1) as version_count
                from change_set
                where id = $1 and source_kind = 'revert'
                "#,
                &[&revert.id],
            )
            .unwrap();
        assert!(audit.get::<_, bool>("orders_match"));
        assert_eq!(audit.get::<_, i64>("version_count"), 0);
    }
}

#[test]
fn revert_multi_date_multi_record_target_normalizes_as_one_group() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let customer_id = "customer_revert_multi_timeline";
    materialize_schema(&mut db.client, &test_schema(customer_id)).unwrap();

    for (external_key, name) in [("acme", "Acme Base"), ("zenith", "Zenith Base")] {
        apply_change_set(
            &mut db.client,
            &mainline_apply(
                customer_id,
                Some(&format!("revert-multi-base-{external_key}")),
                vec![RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from(external_key))),
                    effective_start: date("2026-04-01"),
                    values: Some(text_values(name)),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                }],
            ),
        )
        .unwrap();
    }
    let target = apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("revert-multi-target"),
            vec![
                RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("zenith"))),
                    effective_start: date("2026-05-01"),
                    values: Some(text_values("Zenith May")),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                },
                RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                    effective_start: date("2026-06-01"),
                    values: Some(text_values("Acme June")),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                },
                RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                    effective_start: date("2026-05-01"),
                    values: Some(text_values("Acme May")),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                },
            ],
        ),
    )
    .unwrap();

    revert_change_set(
        &mut db.client,
        &revert_request(customer_id, target.id, Some("revert-multi-target-key")),
    )
    .unwrap();

    let visible = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from(customer_id),
        &ModelId::from("company"),
        date("2026-07-01"),
    )
    .unwrap();
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

    let target_rows = db
        .client
        .query(
            "select stage from company_version where change_set_id = $1 order by effective_start, record_id",
            &[&target.id],
        )
        .unwrap();
    assert_eq!(target_rows.len(), 3);
    assert!(target_rows
        .iter()
        .all(|row| row.get::<_, String>("stage") == "reverted"));
}

#[test]
fn revert_same_day_restores_declared_and_custom_relations() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let customer_id = "customer_revert_same_day_relations";
    materialize_schema(&mut db.client, &custom_fields_schema(customer_id)).unwrap();

    for external_key in ["acme", "zenith"] {
        apply_change_set(
            &mut db.client,
            &mainline_apply(
                customer_id,
                Some(&format!("revert-relation-company-{external_key}")),
                vec![RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from(external_key))),
                    effective_start: date("2026-05-01"),
                    values: Some(text_values(external_key)),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                }],
            ),
        )
        .unwrap();
    }
    let acme_id = db
        .client
        .query_one(
            "select id from company_record where app_id = 'core_app' and customer_id = $1 and external_key = 'acme'",
            &[&customer_id],
        )
        .unwrap()
        .get(0);

    apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("revert-relation-employee-acme"),
            vec![RowVersionWrite {
                model_id: ModelId::from("employee"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alice"))),
                effective_start: date("2026-05-01"),
                values: Some(employee_values(
                    "Alice",
                    RecordKey::ExternalKey(ExternalKey::from("acme")),
                )),
                custom_fields: Some(vec![custom_field_entry(
                    "home_company",
                    CustomFieldValue::Relation(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                )]),
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    let target = apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("revert-relation-employee-zenith"),
            vec![RowVersionWrite {
                model_id: ModelId::from("employee"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alice"))),
                effective_start: date("2026-05-01"),
                values: Some(employee_values(
                    "Alice",
                    RecordKey::ExternalKey(ExternalKey::from("zenith")),
                )),
                custom_fields: Some(vec![custom_field_entry(
                    "home_company",
                    CustomFieldValue::Relation(RecordKey::ExternalKey(ExternalKey::from("zenith"))),
                )]),
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    revert_change_set(
        &mut db.client,
        &revert_request(
            customer_id,
            target.id,
            Some("revert-relation-employee-target"),
        ),
    )
    .unwrap();
    let visible = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from(customer_id),
        &ModelId::from("employee"),
        date("2026-05-15"),
    )
    .unwrap();
    assert_eq!(
        visible[0].values.get(&FieldId::from("employer")),
        Some(&FieldValue::Relation(RecordKey::RecordId(acme_id)))
    );
    assert_eq!(
        custom_value(&visible[0].custom_fields, "home_company"),
        Some(&CustomFieldValue::Relation(RecordKey::RecordId(acme_id)))
    );
}

#[test]
fn revert_relation_validation_rolls_back_the_complete_group() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let customer_id = "customer_revert_relation_rollback";
    materialize_schema(&mut db.client, &custom_fields_schema(customer_id)).unwrap();

    for external_key in ["acme", "zenith"] {
        apply_change_set(
            &mut db.client,
            &mainline_apply(
                customer_id,
                Some(&format!("revert-invalid-company-{external_key}")),
                vec![RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from(external_key))),
                    effective_start: date("2026-05-01"),
                    values: Some(text_values(external_key)),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                }],
            ),
        )
        .unwrap();
    }
    let zenith_id = db
        .client
        .query_one(
            "select id from company_record where app_id = 'core_app' and customer_id = $1 and external_key = 'zenith'",
            &[&customer_id],
        )
        .unwrap()
        .get(0);

    apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("revert-invalid-employee-acme"),
            vec![RowVersionWrite {
                model_id: ModelId::from("employee"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alice"))),
                effective_start: date("2026-05-01"),
                values: Some(employee_values(
                    "Alice",
                    RecordKey::ExternalKey(ExternalKey::from("acme")),
                )),
                custom_fields: Some(vec![custom_field_entry(
                    "home_company",
                    CustomFieldValue::Relation(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                )]),
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    let target = apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("revert-invalid-employee-zenith"),
            vec![RowVersionWrite {
                model_id: ModelId::from("employee"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alice"))),
                effective_start: date("2026-05-01"),
                values: Some(employee_values(
                    "Alice",
                    RecordKey::ExternalKey(ExternalKey::from("zenith")),
                )),
                custom_fields: Some(vec![custom_field_entry(
                    "home_company",
                    CustomFieldValue::Relation(RecordKey::ExternalKey(ExternalKey::from("zenith"))),
                )]),
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("revert-invalid-tombstone-acme"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: None,
                custom_fields: None,
                tombstones_record: true,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    let error = revert_change_set(
        &mut db.client,
        &revert_request(
            customer_id,
            target.id,
            Some("revert-invalid-relation-target"),
        ),
    )
    .unwrap_err();
    assert!(matches!(error, DbError::TombstonedRecord { .. }));

    let visible = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from(customer_id),
        &ModelId::from("employee"),
        date("2026-05-15"),
    )
    .unwrap();
    assert_eq!(
        visible[0].values.get(&FieldId::from("employer")),
        Some(&FieldValue::Relation(RecordKey::RecordId(zenith_id)))
    );
    let target_stage: String = db
        .client
        .query_one(
            "select stage from employee_version where change_set_id = $1",
            &[&target.id],
        )
        .unwrap()
        .get(0);
    assert_eq!(target_stage, "mainline");
    let failed_audit_count: i64 = db
        .client
        .query_one(
            "select count(*) from change_set where app_id = 'core_app' and customer_id = $1 and idempotency_key = 'revert-invalid-relation-target'",
            &[&customer_id],
        )
        .unwrap()
        .get(0);
    assert_eq!(failed_audit_count, 0);
}

#[test]
fn revert_tombstone_reopens_previous_mainline_row() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();

    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("revert-tombstone-original"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    let tombstone = apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("revert-tombstone-target"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-06-01"),
                values: None,
                custom_fields: None,
                tombstones_record: true,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    assert!(read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        &ModelId::from("company"),
        date("2026-06-15"),
    )
    .unwrap()
    .is_empty());
    let revert = revert_change_set(
        &mut db.client,
        &revert_request("customer_a", tombstone.id, Some("revert-tombstone-key")),
    )
    .unwrap();
    let revert_diff = change_set_diff(
        &mut db.client,
        &ChangeSetDiffRequest {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from("customer_a"),
            change_set_id: revert.id,
            project: vec![],
        },
    )
    .unwrap();
    assert!(revert_diff.records[0].before_tombstones_record);
    assert!(!revert_diff.records[0].after_tombstones_record);
    let visible = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        &ModelId::from("company"),
        date("2026-06-15"),
    )
    .unwrap();
    assert_eq!(
        visible[0].values.get(&FieldId::from("name")),
        Some(&FieldValue::Text("Acme".to_string()))
    );
}

#[test]
fn revert_allows_multi_write_targets_from_the_same_change_set() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();

    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("revert-multi-row-original"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-04-01"),
                values: Some(text_values("Acme Original")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    let target = apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("revert-multi-row-target"),
            vec![
                RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                    effective_start: date("2026-05-01"),
                    values: Some(text_values("Acme May")),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                },
                RowVersionWrite {
                    model_id: ModelId::from("company"),
                    new_record_id: None,
                    record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                    effective_start: date("2026-06-01"),
                    values: Some(text_values("Acme June")),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,

                    ..Default::default()
                },
            ],
        ),
    )
    .unwrap();

    revert_change_set(
        &mut db.client,
        &revert_request("customer_a", target.id, Some("revert-multi-row-key")),
    )
    .unwrap();
    let visible = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        &ModelId::from("company"),
        date("2026-06-15"),
    )
    .unwrap();
    assert_eq!(
        visible[0].values.get(&FieldId::from("name")),
        Some(&FieldValue::Text("Acme Original".to_string()))
    );
}

#[test]
fn revert_record_creation_hides_the_created_record() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();

    let creation = apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("revert-creation-target"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    let created_visible = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        &ModelId::from("company"),
        date("2026-05-15"),
    )
    .unwrap();
    assert_eq!(created_visible.len(), 1);
    let created_record_id = created_visible[0].record_id;

    let revert = revert_change_set(
        &mut db.client,
        &revert_request("customer_a", creation.id, Some("revert-creation-key")),
    )
    .unwrap();
    let revert_diff = change_set_diff(
        &mut db.client,
        &ChangeSetDiffRequest {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from("customer_a"),
            change_set_id: revert.id,
            project: vec![],
        },
    )
    .unwrap();
    assert!(!revert_diff.records[0].before_tombstones_record);
    assert!(revert_diff.records[0].after_tombstones_record);

    let visible = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        &ModelId::from("company"),
        date("2026-05-15"),
    )
    .unwrap();
    assert!(visible.is_empty());

    let external_key_rows: i64 = db
        .client
        .query_one(
            "select count(*) from company_record where app_id = 'core_app' and customer_id = 'customer_a' and external_key = 'acme'",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(external_key_rows, 0);

    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("revert-creation-new-record-after-release"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-06-01"),
                values: Some(text_values("Acme Fresh")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    let fresh_visible = read_visible_records(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        &ModelId::from("company"),
        date("2026-06-15"),
    )
    .unwrap();
    assert_eq!(fresh_visible[0].external_key.as_deref(), Some("acme"));
    assert_ne!(fresh_visible[0].record_id, created_record_id);
}

#[test]
fn revert_rejects_tip_conflicts_and_revert_change_sets() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();

    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("revert-conflict-original"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    let target = apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("revert-conflict-target"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-06-01"),
                values: Some(text_values("Acme June")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    let later = apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("revert-conflict-later"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-07-01"),
                values: Some(text_values("Acme July")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    let conflict = revert_change_set(
        &mut db.client,
        &revert_request("customer_a", target.id, Some("revert-conflict-key")),
    )
    .unwrap_err();
    assert!(matches!(conflict, DbError::RevertConflict { .. }));

    let revert = revert_change_set(
        &mut db.client,
        &revert_request("customer_a", later.id, Some("revert-later-key")),
    )
    .unwrap();
    let already_reverted = revert_change_set(
        &mut db.client,
        &revert_request("customer_a", later.id, Some("revert-later-again-key")),
    )
    .unwrap_err();
    assert!(matches!(already_reverted, DbError::AlreadyReverted { .. }));

    let revert_revert = revert_change_set(
        &mut db.client,
        &revert_request("customer_a", revert.id, Some("revert-revert-key")),
    )
    .unwrap_err();
    assert!(matches!(revert_revert, DbError::RevertConflict { .. }));
}

#[test]
fn revert_rejects_same_day_tip_conflicts_and_key_reuse_after_revert() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();

    let target = apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("revert-same-day-target"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    let same_day_tombstone = apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("revert-same-day-tombstone"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: None,
                custom_fields: None,
                tombstones_record: true,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    let conflict = revert_change_set(
        &mut db.client,
        &revert_request(
            "customer_a",
            target.id,
            Some("revert-same-day-conflict-key"),
        ),
    )
    .unwrap_err();
    assert!(matches!(conflict, DbError::RevertConflict { .. }));

    let first = revert_change_set(
        &mut db.client,
        &revert_request(
            "customer_a",
            same_day_tombstone.id,
            Some("revert-same-day-tombstone-key"),
        ),
    )
    .unwrap();
    let second = revert_change_set(
        &mut db.client,
        &revert_request(
            "customer_a",
            same_day_tombstone.id,
            Some("revert-same-day-tombstone-key"),
        ),
    )
    .unwrap();
    assert_eq!(first, second);

    let third = revert_change_set(
        &mut db.client,
        &revert_request(
            "customer_a",
            same_day_tombstone.id,
            Some("revert-same-day-tombstone-different-key"),
        ),
    )
    .unwrap_err();
    assert!(matches!(third, DbError::AlreadyReverted { .. }));
}

#[test]
fn ordinary_apply_rejects_reserved_revert_source_kind() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();

    let mut apply = mainline_apply(
        "customer_a",
        Some("reserved-revert-source-kind"),
        vec![RowVersionWrite {
            model_id: ModelId::from("company"),
            new_record_id: None,
            record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
            effective_start: date("2026-05-01"),
            values: Some(text_values("Acme")),
            custom_fields: None,
            tombstones_record: false,
            provenance: None,

            ..Default::default()
        }],
    );
    apply.source_kind = "revert".to_string();

    let error = apply_change_set(&mut db.client, &apply).unwrap_err();
    assert!(matches!(error, DbError::ReservedSourceKind { .. }));
}

#[test]
fn stale_draft_approval_rejects_when_mainline_base_was_reverted() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();

    let base = apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("revert-stales-draft-base"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    let draft = apply_change_set(
        &mut db.client,
        &draft_apply(
            "customer_a",
            Some("revert-stales-draft"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-06-01"),
                values: Some(text_values("Acme Draft")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();
    revert_change_set(
        &mut db.client,
        &revert_request("customer_a", base.id, Some("revert-stales-draft-key")),
    )
    .unwrap();

    let stale = approve_draft_change_set(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from("customer_a"),
        draft.id,
    )
    .unwrap_err();
    assert!(matches!(stale, DbError::StaleDraft { .. }));
}

#[test]
fn mainline_apply_rejects_backdated_tombstone_before_later_mainline() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();
    apply_change_set(
        &mut db.client,
        &mainline_apply(
            "customer_a",
            Some("company-for-backdated-tombstone"),
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                new_record_id: None,
                record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
                effective_start: date("2026-05-01"),
                values: Some(text_values("Acme")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        ),
    )
    .unwrap();

    let tombstone = mainline_apply(
        "customer_a",
        Some("company-backdated-tombstone"),
        vec![RowVersionWrite {
            model_id: ModelId::from("company"),
            new_record_id: None,
            record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
            effective_start: date("2026-04-01"),
            values: None,
            custom_fields: None,
            tombstones_record: true,
            provenance: None,

            ..Default::default()
        }],
    );
    let error = apply_change_set(&mut db.client, &tombstone).unwrap_err();
    assert!(matches!(error, DbError::TimelineConflict { .. }));
}

#[test]
fn mainline_apply_rejects_min_effective_start_without_panicking() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();

    let apply = mainline_apply(
        "customer_a",
        Some("company-min-effective-start"),
        vec![RowVersionWrite {
            model_id: ModelId::from("company"),
            new_record_id: None,
            record_key: Some(RecordKey::ExternalKey(ExternalKey::from("acme"))),
            effective_start: NaiveDate::MIN,
            values: Some(text_values("Acme")),
            custom_fields: None,
            tombstones_record: false,
            provenance: None,

            ..Default::default()
        }],
    );
    let error = apply_change_set(&mut db.client, &apply).unwrap_err();
    assert!(matches!(error, DbError::Validation(_)));
}

#[test]
fn materialize_schema_rejects_semantic_check_drift() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_a");
    materialize_schema(&mut db.client, &schema).unwrap();

    db.client
        .batch_execute(
            r#"
            alter table employee_version drop constraint employee_version_stage_check;
            alter table employee_version add constraint employee_version_stage_check
              check (stage in ('draft', 'mainline', 'discarded', 'reverted', 'broken'));
            "#,
        )
        .unwrap();

    let error = materialize_schema(&mut db.client, &schema).unwrap_err();
    assert!(matches!(
        error,
        DbError::SchemaDrift { object, .. }
            if object == "employee_version.employee_version_stage_check"
    ));
}

#[test]
fn materialize_schema_rejects_wrong_index_order() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_a");
    materialize_schema(&mut db.client, &schema).unwrap();

    db.client
        .batch_execute(
            r#"
            drop index employee_version_change_set_value_once_idx;
            create unique index employee_version_change_set_value_once_idx
              on employee_version (effective_start, record_id, change_set_id)
              where not tombstones_record and not untombstones_record;
            "#,
        )
        .unwrap();

    let error = materialize_schema(&mut db.client, &schema).unwrap_err();
    assert!(matches!(
        error,
        DbError::SchemaDrift { object, .. }
            if object == "employee_version.employee_version_change_set_value_once_idx"
    ));
}

#[test]
fn materialize_schema_rejects_static_index_drift() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_a");
    materialize_schema(&mut db.client, &schema).unwrap();

    db.client
        .batch_execute(
            r#"
            drop index schema_revision_active_idx;
            create unique index schema_revision_active_idx
              on schema_revision (customer_id, app_id)
              where activated_at is not null;
            "#,
        )
        .unwrap();

    let error = materialize_schema(&mut db.client, &schema).unwrap_err();
    assert!(matches!(
        error,
        DbError::SchemaDrift { object, .. }
            if object == "schema_revision.schema_revision_active_idx"
    ));
}

#[test]
fn materialize_schema_rejects_index_on_wrong_table() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_a");
    materialize_schema(&mut db.client, &schema).unwrap();

    db.client
        .batch_execute(
            r#"
            drop index schema_revision_active_idx;
            create table index_probe (
              app_id text not null,
              customer_id text not null,
              activated_at timestamptz
            );
            create unique index schema_revision_active_idx
              on index_probe (app_id, customer_id)
              where activated_at is not null;
            "#,
        )
        .unwrap();

    let error = materialize_schema(&mut db.client, &schema).unwrap_err();
    assert!(matches!(
        error,
        DbError::SchemaDrift { object, .. }
            if object == "schema_revision.schema_revision_active_idx"
    ));
}

#[test]
fn materialize_schema_rejects_core_unique_constraint_drift() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_a");
    materialize_schema(&mut db.client, &schema).unwrap();

    db.client
        .batch_execute(
            r#"
            alter table schema_revision drop constraint schema_revision_scope_version_key;
            alter table schema_revision add constraint schema_revision_scope_version_key
              unique (customer_id, app_id, version);
            "#,
        )
        .unwrap();

    let error = materialize_schema(&mut db.client, &schema).unwrap_err();
    assert!(matches!(
        error,
        DbError::SchemaDrift { object, .. }
            if object == "schema_revision.schema_revision_scope_version_key"
    ));
}

#[test]
fn materialize_schema_rejects_core_foreign_key_drift() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_a");
    materialize_schema(&mut db.client, &schema).unwrap();

    db.client
        .batch_execute(
            r#"
            alter table employee_version drop constraint employee_version_change_set_tenant_fk;
            alter table employee_version add constraint employee_version_change_set_tenant_fk
              foreign key (change_set_id) references change_set(id);
            "#,
        )
        .unwrap();

    let error = materialize_schema(&mut db.client, &schema).unwrap_err();
    assert!(matches!(
        error,
        DbError::SchemaDrift { object, .. }
            if object == "employee_version.employee_version_change_set_tenant_fk"
    ));
}

#[test]
fn materialize_schema_rejects_core_unique_deferrability_drift() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_a");
    materialize_schema(&mut db.client, &schema).unwrap();

    db.client
        .batch_execute(
            r#"
            alter table schema_revision drop constraint schema_revision_scope_version_key;
            alter table schema_revision add constraint schema_revision_scope_version_key
              unique (app_id, customer_id, version) deferrable initially immediate;
            "#,
        )
        .unwrap();

    let error = materialize_schema(&mut db.client, &schema).unwrap_err();
    assert!(matches!(
        error,
        DbError::SchemaDrift { object, .. }
            if object == "schema_revision.schema_revision_scope_version_key"
    ));
}

#[test]
fn materialize_schema_rejects_core_foreign_key_schema_drift() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_a");
    materialize_schema(&mut db.client, &schema).unwrap();

    let other_schema = format!("{}_other", db.schema_name);
    db.client
        .batch_execute(&format!(
            r#"
            create schema "{other_schema}";
            create table "{other_schema}".change_set (
              id bigint not null,
              app_id text not null,
              customer_id text not null,
              unique (id, app_id, customer_id)
            );
            alter table employee_version drop constraint employee_version_change_set_tenant_fk;
            alter table employee_version add constraint employee_version_change_set_tenant_fk
              foreign key (change_set_id, app_id, customer_id)
              references "{other_schema}".change_set(id, app_id, customer_id);
            "#
        ))
        .unwrap();

    let error = materialize_schema(&mut db.client, &schema).unwrap_err();
    let _ = db.client.batch_execute(&format!(
        r#"drop schema if exists "{other_schema}" cascade;"#
    ));
    assert!(matches!(error, DbError::SchemaDrift { .. }));
}

#[test]
fn materialize_schema_rejects_core_foreign_key_action_drift() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_a");
    materialize_schema(&mut db.client, &schema).unwrap();

    db.client
        .batch_execute(
            r#"
            alter table employee_version drop constraint employee_version_change_set_tenant_fk;
            alter table employee_version add constraint employee_version_change_set_tenant_fk
              foreign key (change_set_id, app_id, customer_id)
              references change_set(id, app_id, customer_id)
              on delete cascade;
            "#,
        )
        .unwrap();

    let error = materialize_schema(&mut db.client, &schema).unwrap_err();
    assert!(matches!(error, DbError::SchemaDrift { .. }));
}

#[test]
fn materialize_schema_rejects_default_drift() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_a");
    materialize_schema(&mut db.client, &schema).unwrap();

    db.client
        .batch_execute(
            "alter table employee_version alter column tombstones_record set default true;",
        )
        .unwrap();

    let error = materialize_schema(&mut db.client, &schema).unwrap_err();
    assert!(matches!(
        error,
        DbError::SchemaDrift { object, .. } if object == "employee_version"
    ));
}

#[test]
fn materialize_schema_rejects_sequence_default_drift() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_a");
    materialize_schema(&mut db.client, &schema).unwrap();

    db.client
        .batch_execute("alter table change_set alter column id set default 1;")
        .unwrap();

    let error = materialize_schema(&mut db.client, &schema).unwrap_err();
    assert!(matches!(
        error,
        DbError::SchemaDrift { object, .. } if object == "change_set"
    ));
}

#[test]
fn materialize_schema_repairs_extra_rls_policy_drift() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_a");
    let revision_id = materialize_schema(&mut db.client, &schema).unwrap();

    db.client
        .batch_execute(
            "create policy bypass_policy on company_record using (true) with check (true);",
        )
        .unwrap();

    let repaired_revision_id = materialize_schema(&mut db.client, &schema).unwrap();
    assert_eq!(repaired_revision_id, revision_id);
    let policy_names = db
        .client
        .query(
            "select policyname from pg_policies where schemaname = current_schema() and tablename = 'company_record' order by policyname",
            &[],
        )
        .unwrap()
        .into_iter()
        .map(|row| row.get::<_, String>(0))
        .collect::<Vec<_>>();
    assert_eq!(policy_names, vec!["platform_tenant_scope"]);
}

#[test]
fn materialize_schema_probe_helpers_do_not_drop_permanent_tables() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    db.client
        .batch_execute(
            r#"
            create table platform_check_expr_probe (marker text);
            create table platform_index_predicate_probe (marker text);
            create table platform_policy_probe (marker text);
            create table platform_default_probe (marker text);
            "#,
        )
        .unwrap();

    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();

    let table_count: i64 = db
        .client
        .query_one(
            "select count(*) from information_schema.tables where table_schema = current_schema() and table_name in ('platform_check_expr_probe', 'platform_index_predicate_probe', 'platform_policy_probe', 'platform_default_probe')",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(table_count, 4);
}

#[test]
fn money_rate_components_are_all_or_none() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let schema = test_schema("customer_a");
    materialize_schema(&mut db.client, &schema).unwrap();

    db.client
        .batch_execute(
            r#"
            insert into company_record (id, app_id, customer_id, external_key)
            values ('018f6bf3-1ea5-7812-9a5a-a1f5b04f0101', 'core_app', 'customer_a', 'a');
            insert into employee_record (id, app_id, customer_id, external_key)
            values ('018f6bf3-1ea5-7812-9a5a-a1f5b04f0102', 'core_app', 'customer_a', 'e');
            insert into change_set (app_id, customer_id, schema_revision_id, created_with_mode, status, source_kind, created_order, applied_order, applied_at)
            select app_id, customer_id, id, 'mainline', 'mainline', 'test', nextval('change_set_lifecycle_order_seq'), nextval('change_set_lifecycle_order_seq'), now()
            from schema_revision
            where customer_id = 'customer_a';
            "#,
        )
        .unwrap();
    let change_set_id: i64 = db
        .client
        .query_one(
            "select id from change_set where customer_id = 'customer_a'",
            &[],
        )
        .unwrap()
        .get(0);

    let blocked = db.client.execute(
        "insert into employee_version (id, record_id, app_id, customer_id, stage, effective_start, change_set_id, applied_at, name, comp_rate_amount)
         values ('018f6bf3-1ea5-7812-9a5a-a1f5b04f0103', '018f6bf3-1ea5-7812-9a5a-a1f5b04f0102', 'core_app', 'customer_a', 'mainline', '2026-05-04', $1, now(), 'Alice', 100.00)",
        &[&change_set_id],
    );
    assert!(blocked.is_err());
}

#[test]
fn materialize_schema_rolls_back_partial_model_tables_on_failure() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    db.client
        .batch_execute("create table employee_record (id text primary key);")
        .unwrap();
    let schema = test_schema("customer_a");

    let error = materialize_schema(&mut db.client, &schema).unwrap_err();
    assert!(matches!(error, DbError::SchemaDrift { .. }));

    let first_created: bool = db
        .client
        .query_one("select to_regclass('company_record') is not null", &[])
        .unwrap()
        .get(0);
    assert!(!first_created);
}

#[test]
fn rls_hides_and_blocks_cross_customer_rows_for_non_owner_role() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();
    materialize_schema(&mut db.client, &test_schema("customer_b")).unwrap();

    db.client
        .batch_execute(
            r#"
            insert into company_record (id, app_id, customer_id, external_key)
            values
              ('018f6bf3-1ea5-7812-9a5a-a1f5b04f0001', 'core_app', 'customer_a', 'a'),
              ('018f6bf3-1ea5-7812-9a5a-a1f5b04f0002', 'core_app', 'customer_b', 'b');
            insert into employee_record (id, app_id, customer_id, external_key)
            values
              ('018f6bf3-1ea5-7812-9a5a-a1f5b04f0003', 'core_app', 'customer_a', 'ea'),
              ('018f6bf3-1ea5-7812-9a5a-a1f5b04f0004', 'core_app', 'customer_b', 'eb');
            insert into change_set (app_id, customer_id, schema_revision_id, created_with_mode, status, source_kind, created_order, applied_order, applied_at)
            select app_id, customer_id, id, 'mainline', 'mainline', 'test', nextval('change_set_lifecycle_order_seq'), nextval('change_set_lifecycle_order_seq'), now()
            from schema_revision;
            insert into employee_version (id, record_id, app_id, customer_id, stage, effective_start, change_set_id, applied_at, name)
            select
              case customer_id
                when 'customer_a' then '018f6bf3-1ea5-7812-9a5a-a1f5b04f0005'::uuid
                else '018f6bf3-1ea5-7812-9a5a-a1f5b04f0006'::uuid
              end,
              case customer_id
                when 'customer_a' then '018f6bf3-1ea5-7812-9a5a-a1f5b04f0003'::uuid
                else '018f6bf3-1ea5-7812-9a5a-a1f5b04f0004'::uuid
              end,
              app_id,
              customer_id,
              'mainline',
              '2026-05-04',
              id,
              now(),
              customer_id
            from change_set;
            "#,
        )
        .unwrap();
    db.grant_role_access();

    let mut tx = db.client.transaction().unwrap();
    tx.execute(&format!("set role \"{}\"", db.role_name), &[])
        .unwrap();
    tx.execute(
        "select set_config('platform.app_id', 'core_app', true)",
        &[],
    )
    .unwrap();
    tx.execute(
        "select set_config('platform.customer_id', 'customer_a', true)",
        &[],
    )
    .unwrap();

    for table in [
        "schema_revision",
        "change_set",
        "company_record",
        "employee_record",
        "employee_version",
    ] {
        let visible: i64 = tx
            .query_one(&format!("select count(*) from {table}"), &[])
            .unwrap()
            .get(0);
        assert_eq!(visible, 1, "{table} should expose only the tenant row");
    }

    let updated = tx
        .execute(
            "update company_record set external_key = 'blocked' where customer_id = 'customer_b'",
            &[],
        )
        .unwrap();
    assert_eq!(updated, 0);

    let deleted = tx
        .execute(
            "delete from employee_version where customer_id = 'customer_b'",
            &[],
        )
        .unwrap();
    assert_eq!(deleted, 0);

    let blocked = tx.execute(
        "insert into company_record (id, app_id, customer_id) values ('018f6bf3-1ea5-7812-9a5a-a1f5b04f0007', 'core_app', 'customer_b')",
        &[],
    );
    assert!(blocked.is_err());
    tx.rollback().unwrap();
}

#[test]
fn tenant_scoped_foreign_keys_reject_cross_customer_links() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    materialize_schema(&mut db.client, &test_schema("customer_a")).unwrap();
    materialize_schema(&mut db.client, &test_schema("customer_b")).unwrap();

    db.client
        .batch_execute(
            r#"
            insert into company_record (id, app_id, customer_id, external_key)
            values ('018f6bf3-1ea5-7812-9a5a-a1f5b04f0002', 'core_app', 'customer_b', 'b');
            insert into employee_record (id, app_id, customer_id, external_key)
            values ('018f6bf3-1ea5-7812-9a5a-a1f5b04f0011', 'core_app', 'customer_a', 'a');

            insert into change_set (app_id, customer_id, schema_revision_id, created_with_mode, status, source_kind, created_order, applied_order, applied_at)
            select app_id, customer_id, id, 'mainline', 'mainline', 'test', nextval('change_set_lifecycle_order_seq'), nextval('change_set_lifecycle_order_seq'), now()
            from schema_revision
            where customer_id = 'customer_a';
            "#,
        )
        .unwrap();

    let change_set_id: i64 = db
        .client
        .query_one(
            "select id from change_set where customer_id = 'customer_a'",
            &[],
        )
        .unwrap()
        .get(0);
    let blocked = db.client.execute(
        "insert into employee_version (id, record_id, employer, app_id, customer_id, stage, effective_start, change_set_id, applied_at, name)
         values ('018f6bf3-1ea5-7812-9a5a-a1f5b04f0010', '018f6bf3-1ea5-7812-9a5a-a1f5b04f0011', '018f6bf3-1ea5-7812-9a5a-a1f5b04f0002', 'core_app', 'customer_a', 'mainline', '2026-05-04', $1, now(), 'Alice')",
        &[&change_set_id],
    );
    assert!(blocked.is_err());
}

#[test]
fn published_writes_notify_their_scope_on_commit() {
    let Some(mut db) = TestDb::connect() else {
        return;
    };
    let customer_id = "customer_canonical_notify";
    materialize_schema(&mut db.client, &test_schema(customer_id)).unwrap();
    // Tests share the database, so keep only this connection's notifications.
    let own: i32 = db
        .client
        .query_one("select pg_backend_pid()", &[])
        .unwrap()
        .get(0);
    db.client.batch_execute("listen kernel_canonical").unwrap();
    let first = apply_change_set(
        &mut db.client,
        &mainline_apply(
            customer_id,
            Some("notify_mainline"),
            vec![employee_write(
                "employee_a",
                "2026-01-01",
                Some(text_values("Alice")),
                false,
            )],
        ),
    )
    .unwrap();
    // A draft writes nothing published until it is approved, but open review
    // surfaces learn of it, so it notifies too.
    let draft = apply_change_set(
        &mut db.client,
        &draft_apply(
            customer_id,
            Some("notify_draft"),
            vec![employee_write(
                "employee_b",
                "2026-02-01",
                Some(text_values("Bob")),
                false,
            )],
        ),
    )
    .unwrap();
    approve_draft_change_set(
        &mut db.client,
        &AppId::from("core_app"),
        &CustomerId::from(customer_id),
        draft.id,
    )
    .unwrap();
    revert_change_set(
        &mut db.client,
        &revert_request(customer_id, first.id, Some("notify_revert")),
    )
    .unwrap();
    let payloads: Vec<String> = db
        .client
        .notifications()
        .iter()
        .filter(|n| Ok(n.process_id() == own && n.channel() == "kernel_canonical"))
        .map(|n| Ok(n.payload().to_owned()))
        .collect()
        .unwrap();
    assert_eq!(payloads, vec![format!("core_app:{customer_id}"); 4]);
}
