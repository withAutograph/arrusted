#[path = "support/trusted_human.rs"]
mod trusted_human;
use std::collections::BTreeMap;
use std::env;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use kernel::testing::GeneratedSqlFunction;
use kernel::{
    connect_postgres, AppId, AppliedChangeSet, ApplyChangeSet, ApplyMode, ChangeType, ChangeTypeId,
    CustomFieldDefinition, CustomFieldDefinitionId, CustomFieldEntry, CustomFieldType,
    CustomFieldValue, CustomerId, EnumOption, EnumOptionId, Field, FieldId, FieldType, FieldValue,
    Model, ModelId, ModelKind, RecordKey, RowVersionWrite, Schema, SchemaElementLifecycle,
    SchemaVersion,
};
use schema_compiler::{
    compile_sql_artifact_manifest, render_sql_artifact_bundle, CompiledManifest,
    NormalizedManifestExtras, SqlArtifactKind,
};
use serde_json::{json, Value};
use uuid::Uuid;

fn field(id: &str, field_type: FieldType, required: bool) -> Field {
    Field {
        id: FieldId::from(id),
        label: id.to_string(),
        field_type,
        required,
        is_unique: false,
        target_model: None,
        option_set: vec![],
        ..Default::default()
    }
}

fn compiled(customer_id: &str) -> CompiledManifest {
    let mut company_name = field("name", FieldType::Text, true);
    company_name.is_unique = true;
    let mut status = field("status", FieldType::Enum, false);
    status.option_set = vec![
        EnumOption {
            id: EnumOptionId::from("active"),
            label: "Active".to_string(),
            aliases: vec![],
            ..Default::default()
        },
        EnumOption {
            id: EnumOptionId::from("inactive"),
            label: "Inactive".to_string(),
            aliases: vec![],
            ..Default::default()
        },
    ];
    let mut employer = field("employer", FieldType::Relation, true);
    employer.target_model = Some(ModelId::from("company"));
    let mut assignment_company = field("company", FieldType::Relation, true);
    assignment_company.target_model = Some(ModelId::from("company"));
    CompiledManifest {
        schema: Schema {
            app_id: AppId::from("sql_apply"),
            customer_id: CustomerId::from(customer_id),
            version: SchemaVersion::from("2026-08-04"),
            models: vec![
                Model {
                    id: ModelId::from("company"),
                    kind: ModelKind::Entity,
                    label: "Company".to_string(),
                    fields: vec![
                        company_name,
                        status,
                        field("country", FieldType::IsoCountry, false),
                        field("currency", FieldType::IsoCurrency, false),
                        field("payload", FieldType::Json, false),
                        field("revenue", FieldType::Number, false),
                        field("enabled", FieldType::Bool, false),
                        field("founded", FieldType::Date, false),
                        field("observed_at", FieldType::Datetime, false),
                        field("aliases", FieldType::TextList, false),
                        field("rate", FieldType::MoneyRate, false),
                    ],
                    extensions: kernel::EntityExtensionCapabilities {
                        typed_custom_fields: true,
                        ..Default::default()
                    },
                    ..Default::default()
                },
                Model {
                    id: ModelId::from("employee"),
                    kind: ModelKind::Entity,
                    label: "Employee".to_string(),
                    fields: vec![field("name", FieldType::Text, true), employer],
                    extensions: kernel::EntityExtensionCapabilities {
                        typed_custom_fields: true,
                        ..Default::default()
                    },
                    ..Default::default()
                },
                Model {
                    id: ModelId::from("assignment"),
                    kind: ModelKind::Entity,
                    label: "Assignment".to_string(),
                    fields: vec![field("label", FieldType::Text, true), assignment_company],
                    ..Default::default()
                },
            ],
            custom_fields: vec![
                custom_field("nickname", CustomFieldType::Text),
                custom_field("score", CustomFieldType::Number),
                custom_field("verified", CustomFieldType::Bool),
                custom_field("start_date", CustomFieldType::Date),
                custom_field("updated_at", CustomFieldType::Datetime),
                custom_field("tags", CustomFieldType::TextList),
                CustomFieldDefinition {
                    target_model_id: Some(ModelId::from("company")),
                    ..custom_field("favorite_company", CustomFieldType::Relation)
                },
                CustomFieldDefinition {
                    option_set: vec![EnumOption {
                        id: EnumOptionId::from("senior"),
                        label: "Senior".to_string(),
                        aliases: vec![],
                        ..Default::default()
                    }],
                    ..custom_field("level", CustomFieldType::Enum)
                },
                custom_field("billing_rate", CustomFieldType::MoneyRate),
            ],
            change_types: vec![ChangeType {
                id: ChangeTypeId::from("company_update"),
                label: "Company Update".to_string(),
                target_model: ModelId::from("company"),
                is_import_default: false,
                touches: vec![],
                required: vec![],
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

fn custom_field(field_id: &str, field_type: CustomFieldType) -> CustomFieldDefinition {
    CustomFieldDefinition {
        id: CustomFieldDefinitionId::from(format!("employee_{field_id}")),
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

fn write(
    model_id: &str,
    record_id: Uuid,
    effective_start: &str,
    values: BTreeMap<FieldId, FieldValue>,
) -> RowVersionWrite {
    RowVersionWrite {
        model_id: ModelId::from(model_id),
        record_key: None,
        new_record_id: Some(record_id),
        effective_start: effective_start.parse().unwrap(),
        values: Some(values),
        custom_fields: None,
        tombstones_record: false,
        provenance: None,
        ..Default::default()
    }
}

fn external_write(
    model_id: &str,
    external_key: &str,
    effective_start: &str,
    values: BTreeMap<FieldId, FieldValue>,
) -> RowVersionWrite {
    RowVersionWrite {
        model_id: ModelId::from(model_id),
        record_key: Some(RecordKey::ExternalKey(external_key.into())),
        new_record_id: None,
        effective_start: effective_start.parse().unwrap(),
        values: Some(values),
        custom_fields: None,
        tombstones_record: false,
        provenance: None,
        ..Default::default()
    }
}

fn apply_request(customer_id: &str, writes: Vec<RowVersionWrite>, key: &str) -> ApplyChangeSet {
    ApplyChangeSet {
        app_id: AppId::from("sql_apply"),
        customer_id: CustomerId::from(customer_id),
        schema_revision_id: Some(kernel::SchemaRevisionId::new(1)),
        actor_id: Some("fixture-actor".to_string()),
        source_kind: "fixture".to_string(),
        source_ref: Some("fixture-source".to_string()),
        idempotency_key: Some(key.to_string()),
        change_type_id: None,
        notes: Some("fixture notes".to_string()),
        mode: ApplyMode::Mainline,
        writes,
    }
}

macro_rules! test_database {
    ($compiled:expr) => {{
        let database_url = match env::var("KERNEL_TEST_DATABASE_URL") {
            Ok(url) => url,
            Err(env::VarError::NotPresent) => {
                eprintln!("skipping generated SQL apply test: KERNEL_TEST_DATABASE_URL is absent");
                return;
            }
            Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
        };
        let mut client = connect_postgres(&database_url).expect("connect to PostgreSQL");
        let schema_name = format!("kernel_apply_{}", Uuid::new_v4().simple());
        client
            .batch_execute(&format!(
                "create schema \"{schema_name}\"; set search_path to \"{schema_name}\""
            ))
            .unwrap();
        let mut manifest = compile_sql_artifact_manifest($compiled).unwrap();
        manifest.artifacts.retain(|artifact| {
            artifact.kind != SqlArtifactKind::Function
                || artifact.name == "kernel_canonical_json(jsonb)"
                || artifact.name == "kernel_physical_identifier(text)"
                || artifact.name == "kernel_installer_capability_role(text)"
                || artifact.name == "kernel_principal_scope_authorized(text,text,text,text)"
                || artifact.name == "kernel_cleanup_generated_visible_query()"
                || artifact.name == "kernel_admin_sha256(text)"
                || artifact.name.starts_with("kernel_bind_")
                || artifact.name.starts_with("kernel_policy_")
                || artifact.name.starts_with("kernel_request_")
                || artifact.name.starts_with("kernel_apply_")
                || artifact.name.starts_with("kernel_constraint_interval_")
                // Public wrappers require the real private bodies and fixed HTTP helpers,
                // even when this selective fixture exercises explicit legacy scopes.
                || artifact.name.starts_with("kernel_http_")
                || artifact.name.starts_with("kernel_admit_http_")
                || artifact.name == "kernel_finish_http_request(jsonb)"
                || artifact.name == "kernel_prune_expired_http_requests(text,text)"
                || artifact.name == "kernel_installer_error(text,text,text,text,text)"
                || artifact.name == "kernel_authorize_scope(text,text,text,text)"
                || artifact.name.starts_with("kernel_validate_change_set")
        });
        trusted_human::before_install(&mut client);
        client
            .batch_execute(&render_sql_artifact_bundle(&manifest))
            .unwrap_or_else(|error| panic!("install generated apply bundle failed: {error}"));
        client
            .batch_execute(
                r#"
                do $kernel_test$
                declare role_name text := kernel_installer_capability_role('execution_owner');
                begin
                  if pg_catalog.to_regrole(role_name) is null then
                    execute pg_catalog.format(
                      'create role %I nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls',
                      role_name
                    );
                  end if;
                end
                $kernel_test$;
                "#,
            )
            .expect("establish generated execution-owner identity");
        trusted_human::grant_capability(&mut client, "execution_owner");
        client
            .execute(
                r#"
                insert into schema_revision (
                  id, app_id, customer_id, version, base_schema, customer_overlay,
                  schema, activated_at
                ) values (1, $1, $2, $3, $4, '{}'::jsonb, $4, now())
                "#,
                &[
                    &$compiled.schema.app_id.as_str(),
                    &$compiled.schema.customer_id.as_str(),
                    &$compiled.schema.version.as_str(),
                    &serde_json::to_value(&$compiled.schema).unwrap(),
                ],
            )
            .unwrap();
        trusted_human::bind(&mut client, $compiled.schema.app_id.as_str(), $compiled.schema.customer_id.as_str(), "fixture-actor");
        (client, schema_name)
    }};
}

macro_rules! drop_test_database {
    ($client:expr, $schema_name:expr) => {{
        trusted_human::drop_fixture(&mut $client, &$schema_name).unwrap();
    }};
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => value.to_string(),
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(object) => {
            let mut entries = object.iter().collect::<Vec<_>>();
            entries.sort_by_key(|(key, _)| *key);
            format!(
                "{{{}}}",
                entries
                    .into_iter()
                    .map(|(key, value)| format!("{}:{}", json!(key), canonical_json(value)))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

#[test]
fn generated_apply_family_is_deterministic_namespaced_and_security_invoker() {
    let first = compile_sql_artifact_manifest(&compiled("artifact")).unwrap();
    let second = compile_sql_artifact_manifest(&compiled("artifact")).unwrap();
    assert_eq!(first, second);
    let functions = first
        .artifacts
        .iter()
        .filter(|artifact| {
            artifact.kind == SqlArtifactKind::Function
                && (artifact.name.starts_with("kernel_apply_")
                    || artifact.name.starts_with("kernel_http_body_apply_")
                    || artifact.name.starts_with("kernel_validate_change_set"))
        })
        .collect::<Vec<_>>();
    assert!(functions
        .iter()
        .any(|artifact| artifact.name == "kernel_apply_change_set(jsonb)"));
    assert!(functions
        .iter()
        .any(|artifact| { artifact.name == "kernel_validate_change_set_dry_run(jsonb)" }));
    assert!(functions
        .iter()
        .any(|artifact| { artifact.name == "kernel_validate_change_sets_dry_run(jsonb)" }));
    assert!(!functions
        .iter()
        .any(|artifact| artifact.name.contains("canonical")));
    let transaction_apply = functions
        .iter()
        .find(|artifact| artifact.name == "kernel_apply_change_set_in_transaction(jsonb)")
        .expect("generated caller-owned transaction entrypoint");
    assert!(transaction_apply
        .sql
        .contains("kernel_http_mutation_guard(request,'kernel_apply_change_set_in_transaction')"));
    assert_eq!(
        transaction_apply
            .sql
            .matches("kernel_http_body_apply_change_set_in_transaction(request)")
            .count(),
        1
    );
    let transaction_apply = functions
        .iter()
        .find(|artifact| artifact.name == "kernel_http_body_apply_change_set_in_transaction(jsonb)")
        .expect("private unchanged caller-owned transaction body");
    assert_eq!(
        transaction_apply
            .sql
            .matches("kernel_apply_execute(request,false,null)")
            .count(),
        1
    );
    assert!(transaction_apply
        .sql
        .contains("when serialization_failure then\n      raise;"));
    assert!(transaction_apply
        .sql
        .contains("current_setting('platform.caller_owned_transaction', true)"));
    assert!(transaction_apply
        .sql
        .contains("caller_owned_transaction_required"));
    assert!(!transaction_apply.sql.contains("loop"));
    assert_eq!(
        functions
            .iter()
            .filter(|artifact| {
                matches!(
                    artifact.name.as_str(),
                    "kernel_http_body_apply_change_set(jsonb)"
                        | "kernel_http_body_apply_change_set_in_transaction(jsonb)"
                        | "kernel_validate_change_set_dry_run(jsonb)"
                        | "kernel_validate_change_sets_dry_run(jsonb)"
                ) && artifact
                    .sql
                    .contains("when serialization_failure then\n      raise;")
            })
            .count(),
        4
    );
    assert!(!functions.iter().any(|artifact| {
        matches!(
            artifact.name.as_str(),
            "kernel_apply_change_set(jsonb)"
                | "kernel_apply_change_set_in_transaction(jsonb)"
                | "kernel_validate_change_set_dry_run(jsonb)"
                | "kernel_validate_change_sets_dry_run(jsonb)"
        ) && artifact.sql.contains("  loop\n")
    }));
    assert!(!functions
        .iter()
        .any(|artifact| artifact.sql.contains("v.created_at")));
    assert!(functions
        .iter()
        .find(|artifact| artifact.name == "kernel_apply_identifier(text)")
        .is_some_and(|artifact| artifact
            .sql
            .contains("kernel_physical_identifier(normalized)")));
    for artifact in functions {
        if matches!(
            artifact.name.as_str(),
            "kernel_apply_project_lookup_version(uuid,text,text,text,uuid,jsonb,jsonb,jsonb,jsonb,boolean)"
                | "kernel_apply_execute(jsonb,boolean,bigint)"
        ) {
            assert!(artifact.sql.contains("security definer"), "{}", artifact.name);
        } else {
            assert!(artifact.sql.contains("security invoker"), "{}", artifact.name);
        }
        assert!(
            artifact.sql.contains("set search_path from current"),
            "{}",
            artifact.name
        );
    }
}

#[test]
fn generated_apply_replays_rust_canonical_fingerprint_and_keeps_same_day_history() {
    let compiled = compiled("canonical");
    let (mut client, schema_name) = test_database!(&compiled);
    let company_id = Uuid::parse_str("018f6bf3-1ea5-7812-9a5a-a1f5b04f2000").unwrap();
    let employee_id = Uuid::parse_str("018f6bf3-1ea5-7812-9a5a-a1f5b04f2001").unwrap();
    let mut employee_write = write(
        "employee",
        employee_id,
        "2026-05-01",
        BTreeMap::from([
            (FieldId::from("name"), FieldValue::Text("Alice".to_string())),
            (
                FieldId::from("employer"),
                FieldValue::Relation(RecordKey::RecordId(company_id)),
            ),
        ]),
    );
    employee_write.custom_fields = Some(vec![CustomFieldEntry {
        field_id: FieldId::from("nickname"),
        value: CustomFieldValue::Text("Al".to_string()),
    }]);
    employee_write.provenance = Some(json!({
        "archive_delivery_ref":"opaque-delivery-1",
        "nested":{"z":3,"a":["one","two"]}
    }));
    let request = apply_request(
        "canonical",
        vec![
            employee_write,
            write(
                "company",
                company_id,
                "2026-05-01",
                BTreeMap::from([
                    (FieldId::from("name"), FieldValue::Text("Acme".to_string())),
                    (
                        FieldId::from("status"),
                        FieldValue::Enum(EnumOptionId::from("active")),
                    ),
                    (FieldId::from("country"), FieldValue::Text("US".to_string())),
                    (
                        FieldId::from("currency"),
                        FieldValue::Text("USD".to_string()),
                    ),
                    (
                        FieldId::from("payload"),
                        FieldValue::Json(json!({"nested":{"b":2,"a":[true,null]}})),
                    ),
                ]),
            ),
        ],
        "canonical-nested",
    );
    let request_json = serde_json::to_value(&request).unwrap();
    let response: Value = client
        .query_one(
            "select kernel_apply_change_set($1::jsonb)",
            &[&request_json],
        )
        .unwrap()
        .get(0);
    assert_eq!(response["ok"], true, "{response:#}");
    let change_set_id = response["data"]["id"].as_i64().unwrap();

    let expected = canonical_json(&json!({
        "app_id": request.app_id,
        "customer_id": request.customer_id,
        "schema_revision_id": 1,
        "actor_id": request.actor_id,
        "source_kind": request.source_kind,
        "source_ref": request.source_ref,
        "idempotency_key": request.idempotency_key,
        "change_type_id": request.change_type_id,
        "notes": request.notes,
        "mode": request.mode,
        "writes": request.writes,
    }));
    let stored: String = client
        .query_one(
            "select request_fingerprint from change_set where id=$1",
            &[&change_set_id],
        )
        .unwrap()
        .get(0);
    assert_eq!(stored, expected);

    let replay: Value = client
        .query_one(
            "select kernel_apply_change_set($1::jsonb)",
            &[&request_json],
        )
        .unwrap()
        .get(0);
    assert_eq!(replay, response);
    // The canonical dry-run protocol distinguishes an exact replay from synthetic validation.
    let dry_replay: Value = client
        .query_one(
            "select kernel_validate_change_set_dry_run($1::jsonb)",
            &[&request_json],
        )
        .unwrap()
        .get(0);
    assert_eq!(dry_replay, response);
    assert!(dry_replay["data"]["id"].as_i64().unwrap() > 0);

    let same_day = apply_request(
        "canonical",
        vec![RowVersionWrite {
            model_id: ModelId::from("company"),
            record_key: Some(RecordKey::RecordId(company_id)),
            new_record_id: None,
            effective_start: "2026-05-01".parse().unwrap(),
            values: Some(BTreeMap::from([(
                FieldId::from("name"),
                FieldValue::Text("Acme Updated".to_string()),
            )])),
            custom_fields: None,
            tombstones_record: false,
            provenance: Some(json!({"archive_delivery_ref":"opaque-1"})),
            ..Default::default()
        }],
        "same-day-update",
    );
    let updated: Value = client
        .query_one(
            "select kernel_apply_change_set($1::jsonb)",
            &[&serde_json::to_value(same_day).unwrap()],
        )
        .unwrap()
        .get(0);
    assert_eq!(updated["ok"], true);
    let rows = client
        .query(
            r#"
            select v.name, v.effective_end, cs.applied_order
            from company_version v join change_set cs on cs.id=v.change_set_id
            where v.record_id=$1 order by cs.applied_order
            "#,
            &[&company_id],
        )
        .unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].get::<_, String>("name"), "Acme");
    assert_eq!(rows[1].get::<_, String>("name"), "Acme Updated");
    assert_eq!(
        rows[0].get::<_, Option<chrono::NaiveDate>>("effective_end"),
        Some("2026-05-01".parse().unwrap())
    );
    assert!(rows[0].get::<_, i64>("applied_order") < rows[1].get("applied_order"));
    drop_test_database!(client, schema_name);
}

#[test]
fn generated_dry_runs_are_atomic_synthetic_and_batch_scoped() {
    let compiled = compiled("dry_run");
    let (mut client, schema_name) = test_database!(&compiled);
    let company_id = Uuid::new_v4();
    let request = apply_request(
        "dry_run",
        vec![write(
            "company",
            company_id,
            "2026-05-01",
            BTreeMap::from([(
                FieldId::from("name"),
                FieldValue::Text("Dry Acme".to_string()),
            )]),
        )],
        "dry-single",
    );
    let before_row = client
        .query_one(
            "select last_value,is_called from change_set_lifecycle_order_seq",
            &[],
        )
        .unwrap();
    let before = (before_row.get::<_, i64>(0), before_row.get::<_, bool>(1));
    let response: Value = client
        .query_one(
            "select kernel_validate_change_set_dry_run($1::jsonb)",
            &[&serde_json::to_value(&request).unwrap()],
        )
        .unwrap()
        .get(0);
    assert_eq!(response["ok"], true, "{response:#}");
    assert!(response["data"]["id"].as_i64().unwrap() < 0);
    let residue: i64 = client
        .query_one(
            "select (select count(*) from change_set)+(select count(*) from company_record)+(select count(*) from company_version)",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(residue, 0);
    let after_row = client
        .query_one(
            "select last_value,is_called from change_set_lifecycle_order_seq",
            &[],
        )
        .unwrap();
    let after = (after_row.get::<_, i64>(0), after_row.get::<_, bool>(1));
    assert_eq!(after, before);

    let employee_id = Uuid::new_v4();
    let employee = apply_request(
        "dry_run",
        vec![write(
            "employee",
            employee_id,
            "2026-05-01",
            BTreeMap::from([
                (FieldId::from("name"), FieldValue::Text("Alice".to_string())),
                (
                    FieldId::from("employer"),
                    FieldValue::Relation(RecordKey::RecordId(company_id)),
                ),
            ]),
        )],
        "dry-employee",
    );
    let batch: Value = client
        .query_one(
            "select kernel_validate_change_sets_dry_run($1::jsonb)",
            &[&json!({"app_id":"sql_apply","customer_id":"dry_run","changesets":[request,employee]})],
        )
        .unwrap()
        .get(0);
    assert_eq!(batch["ok"], true, "{batch:#}");
    assert_eq!(batch["data"].as_array().unwrap().len(), 2);
    assert!(batch["data"]
        .as_array()
        .unwrap()
        .iter()
        .all(|item| item["id"].as_i64().unwrap() < 0));
    let residue: i64 = client
        .query_one(
            "select (select count(*) from change_set)+(select count(*) from company_record)+(select count(*) from employee_record)",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(residue, 0);
    drop_test_database!(client, schema_name);
}

#[test]
fn generated_draft_requires_target_first_relations_and_rolls_back_source_first() {
    let compiled = compiled("draft_order");
    let (mut client, schema_name) = test_database!(&compiled);
    let company_id = Uuid::new_v4();
    let employee_id = Uuid::new_v4();
    let source = write(
        "employee",
        employee_id,
        "2026-05-01",
        BTreeMap::from([
            (FieldId::from("name"), FieldValue::Text("Alice".to_string())),
            (
                FieldId::from("employer"),
                FieldValue::Relation(RecordKey::RecordId(company_id)),
            ),
        ]),
    );
    let target = write(
        "company",
        company_id,
        "2026-05-01",
        BTreeMap::from([(FieldId::from("name"), FieldValue::Text("Acme".to_string()))]),
    );
    let mut source_first = apply_request(
        "draft_order",
        vec![source.clone(), target.clone()],
        "draft-source-first",
    );
    source_first.mode = ApplyMode::Draft;
    let rejected: Value = client
        .query_one(
            "select kernel_apply_change_set($1::jsonb)",
            &[&serde_json::to_value(source_first).unwrap()],
        )
        .unwrap()
        .get(0);
    assert_eq!(rejected["ok"], false);
    assert_eq!(rejected["error"]["code"], "record_target_missing");
    let residue: i64 = client
        .query_one(
            "select (select count(*) from change_set)+(select count(*) from company_record)+(select count(*) from employee_record)",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(residue, 0);

    let mut target_first = apply_request("draft_order", vec![target, source], "draft-target-first");
    target_first.mode = ApplyMode::Draft;
    let accepted: Value = client
        .query_one(
            "select kernel_apply_change_set($1::jsonb)",
            &[&serde_json::to_value(target_first).unwrap()],
        )
        .unwrap()
        .get(0);
    assert_eq!(accepted["ok"], true, "{accepted:#}");
    let draft_rows: i64 = client
        .query_one(
            "select (select count(*) from company_version where stage='draft')+(select count(*) from employee_version where stage='draft')",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(draft_rows, 2);
    drop_test_database!(client, schema_name);
}

#[test]
fn generated_mainline_reserves_external_subjects_before_relation_resolution() {
    let fixture = compiled("external_order");
    let (mut client, schema_name) = test_database!(&fixture);
    let source = external_write(
        "employee",
        "alice",
        "2026-05-01",
        BTreeMap::from([
            (FieldId::from("name"), FieldValue::Text("Alice".to_string())),
            (
                FieldId::from("employer"),
                FieldValue::Relation(RecordKey::ExternalKey("acme".into())),
            ),
        ]),
    );
    let target = external_write(
        "company",
        "acme",
        "2026-05-01",
        BTreeMap::from([(FieldId::from("name"), FieldValue::Text("Acme".to_string()))]),
    );
    let accepted: Value = client
        .query_one(
            "select kernel_apply_change_set($1::jsonb)",
            &[&serde_json::to_value(apply_request(
                "external_order",
                vec![source, target],
                "external-source-first",
            ))
            .unwrap()],
        )
        .unwrap()
        .get(0);
    assert_eq!(accepted["ok"], true, "{accepted:#}");
    let relation_matches: bool = client
        .query_one(
            r#"
            select employee.employer = company.id
            from employee_version employee
            join company_record company
              on company.app_id = employee.app_id
             and company.customer_id = employee.customer_id
             and company.external_key = 'acme'
            "#,
            &[],
        )
        .unwrap()
        .get(0);
    assert!(relation_matches);
    drop_test_database!(client, schema_name);

    let fixture = compiled("external_future");
    let (mut client, schema_name) = test_database!(&fixture);
    let source = external_write(
        "employee",
        "alice",
        "2026-05-01",
        BTreeMap::from([
            (FieldId::from("name"), FieldValue::Text("Alice".to_string())),
            (
                FieldId::from("employer"),
                FieldValue::Relation(RecordKey::ExternalKey("acme".into())),
            ),
        ]),
    );
    let future_target = external_write(
        "company",
        "acme",
        "2026-06-01",
        BTreeMap::from([(FieldId::from("name"), FieldValue::Text("Acme".to_string()))]),
    );
    let rejected: Value = client
        .query_one(
            "select kernel_apply_change_set($1::jsonb)",
            &[&serde_json::to_value(apply_request(
                "external_future",
                vec![source, future_target],
                "external-not-visible",
            ))
            .unwrap()],
        )
        .unwrap()
        .get(0);
    assert_eq!(rejected["ok"], false, "{rejected:#}");
    assert_eq!(rejected["error"]["code"], "record_target_missing");
    let residue: i64 = client
        .query_one(
            "select (select count(*) from change_set)+(select count(*) from company_record)+(select count(*) from employee_record)",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(residue, 0);
    drop_test_database!(client, schema_name);
}

#[test]
fn generated_apply_validates_complete_tagged_value_shapes_before_persistence() {
    let fixture = compiled("typed_values");
    let (mut client, schema_name) = test_database!(&fixture);
    let company_id = Uuid::new_v4();
    let employee_id = Uuid::new_v4();

    let mut company = serde_json::to_value(apply_request(
        "typed_values",
        vec![write(
            "company",
            company_id,
            "2026-05-01",
            BTreeMap::from([(FieldId::from("name"), FieldValue::Text("Acme".into()))]),
        )],
        "typed-company",
    ))
    .unwrap();
    company["writes"][0]["values"] = json!({
        "name":{"type":"text","value":"Acme"},
        "status":{"type":"enum","value":"active"},
        "country":{"type":"text","value":"US"},
        "currency":{"type":"text","value":"USD"},
        "payload":{"type":"json","value":{"nested":[true,null]}},
        "revenue":{"type":"number","value":"1234.50"},
        "enabled":{"type":"bool","value":true},
        "founded":{"type":"date","value":"2026-05-01"},
        "observed_at":{"type":"datetime","value":"2026-05-01T12:30:45.123Z"},
        "aliases":{"type":"text_list","value":["Acme","ACME"]},
        "rate":{"type":"money_rate","value":{"amount":"125.25","currency":"USD","period":"hourly"}}
    });
    let company_response: Value = client
        .query_one("select kernel_apply_change_set($1::jsonb)", &[&company])
        .unwrap()
        .get(0);
    assert_eq!(company_response["ok"], true, "{company_response:#}");

    let mut employee = serde_json::to_value(apply_request(
        "typed_values",
        vec![write(
            "employee",
            employee_id,
            "2026-05-01",
            BTreeMap::from([
                (FieldId::from("name"), FieldValue::Text("Alice".into())),
                (
                    FieldId::from("employer"),
                    FieldValue::Relation(RecordKey::RecordId(company_id)),
                ),
            ]),
        )],
        "typed-employee",
    ))
    .unwrap();
    employee["writes"][0]["custom_fields"] = json!([
        {"field_id":"nickname","type":"text","value":"Al"},
        {"field_id":"score","type":"number","value":"9.5"},
        {"field_id":"verified","type":"bool","value":true},
        {"field_id":"start_date","type":"date","value":"2026-05-01"},
        {"field_id":"updated_at","type":"datetime","value":"2026-05-01T12:30:45+00:00"},
        {"field_id":"tags","type":"text_list","value":["finance","owner"]},
        {"field_id":"favorite_company","type":"relation","value":{"type":"record_id","value":company_id}},
        {"field_id":"level","type":"enum","value":"senior"},
        {"field_id":"billing_rate","type":"money_rate","value":{"amount":"250","currency":"USD","period":"daily"}}
    ]);
    let employee_response: Value = client
        .query_one("select kernel_apply_change_set($1::jsonb)", &[&employee])
        .unwrap()
        .get(0);
    assert_eq!(employee_response["ok"], true, "{employee_response:#}");
    let stored_custom_count: i64 = client
        .query_one(
            "select jsonb_array_length(custom_fields)::bigint from employee_version where record_id=$1",
            &[&employee_id],
        )
        .unwrap()
        .get(0);
    assert_eq!(stored_custom_count, 9);

    let malformed_regular = vec![
        ("name", json!({"type":"text","value":7})),
        ("name", json!({"type":"text","value":"Bad","extra":true})),
        ("revenue", json!({"type":"number","value":12.5})),
        ("revenue", json!({"type":"number","value":"not-decimal"})),
        ("enabled", json!({"type":"bool","value":"true"})),
        ("founded", json!({"type":"date","value":"2026-02-30"})),
        (
            "observed_at",
            json!({"type":"datetime","value":"2026-05-01T12:30:45"}),
        ),
        ("aliases", json!({"type":"text_list","value":["valid",7]})),
        ("status", json!({"type":"enum","value":true})),
        (
            "rate",
            json!({"type":"money_rate","value":{"amount":"10","currency":"USD"}}),
        ),
        (
            "payload",
            json!({"type":"json","value":{},"unexpected":true}),
        ),
        (
            "employer",
            json!({"type":"relation","value":{"type":"record_id","value":"not-a-uuid"}}),
        ),
    ];
    for (index, (field_id, malformed)) in malformed_regular.into_iter().enumerate() {
        let model_id = if field_id == "employer" {
            "employee"
        } else {
            "company"
        };
        let mut values = json!({"name":{"type":"text","value":"Invalid"}});
        values[field_id] = malformed;
        let mut request = serde_json::to_value(apply_request(
            "typed_values",
            vec![write(
                model_id,
                Uuid::new_v4(),
                "2026-06-01",
                BTreeMap::from([(
                    FieldId::from("name"),
                    FieldValue::Text("placeholder".into()),
                )]),
            )],
            &format!("malformed-regular-{index}"),
        ))
        .unwrap();
        request["writes"][0]["values"] = values;
        let response: Value = client
            .query_one("select kernel_apply_change_set($1::jsonb)", &[&request])
            .unwrap()
            .get(0);
        assert_eq!(response["ok"], false, "field={field_id}: {response:#}");
        assert_eq!(
            response["error"]["code"], "contract_validation_failed",
            "field={field_id}: {response:#}"
        );
        assert_eq!(
            response["error"]["details"][0]["code"], "field_value_type_mismatch",
            "field={field_id}: {response:#}"
        );
    }

    let malformed_custom = vec![
        ("nickname", json!({"type":"text","value":7})),
        ("score", json!({"type":"number","value":7})),
        ("verified", json!({"type":"bool","value":"true"})),
        ("start_date", json!({"type":"date","value":"2026-02-30"})),
        ("updated_at", json!({"type":"datetime","value":"yesterday"})),
        ("tags", json!({"type":"text_list","value":[false]})),
        (
            "favorite_company",
            json!({"type":"relation","value":{"type":"external_key","value":" "}}),
        ),
        ("level", json!({"type":"enum","value":1})),
        (
            "billing_rate",
            json!({"type":"money_rate","value":{"amount":"10","currency":"USD","period":"daily","extra":true}}),
        ),
    ];
    for (index, (field_id, malformed)) in malformed_custom.into_iter().enumerate() {
        let mut request = serde_json::to_value(apply_request(
            "typed_values",
            vec![write(
                "employee",
                Uuid::new_v4(),
                "2026-06-01",
                BTreeMap::from([
                    (FieldId::from("name"), FieldValue::Text("Invalid".into())),
                    (
                        FieldId::from("employer"),
                        FieldValue::Relation(RecordKey::RecordId(company_id)),
                    ),
                ]),
            )],
            &format!("malformed-custom-{index}"),
        ))
        .unwrap();
        let mut custom_entry = malformed;
        custom_entry["field_id"] = json!(field_id);
        request["writes"][0]["custom_fields"] = json!([custom_entry]);
        let response: Value = client
            .query_one("select kernel_apply_change_set($1::jsonb)", &[&request])
            .unwrap()
            .get(0);
        assert_eq!(response["ok"], false, "field={field_id}: {response:#}");
        assert_eq!(
            response["error"]["details"][0]["code"], "custom_field_value_type_mismatch",
            "field={field_id}: {response:#}"
        );
    }

    let persisted_invalid_rows: i64 = client
        .query_one(
            "select count(*) from change_set where idempotency_key like 'malformed-%'",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(persisted_invalid_rows, 0);
    drop_test_database!(client, schema_name);
}

#[test]
fn generated_mainline_planned_relations_respect_same_day_tombstone_winner() {
    let fixture = compiled("planned_tombstone");
    let (mut client, schema_name) = test_database!(&fixture);
    let source = external_write(
        "assignment",
        "assignment-1",
        "2026-05-01",
        BTreeMap::from([
            (FieldId::from("label"), FieldValue::Text("Owner".into())),
            (
                FieldId::from("company"),
                FieldValue::Relation(RecordKey::ExternalKey("acme".into())),
            ),
        ]),
    );
    let target = external_write(
        "company",
        "acme",
        "2026-05-01",
        BTreeMap::from([(FieldId::from("name"), FieldValue::Text("Acme".into()))]),
    );
    let tombstone = RowVersionWrite {
        model_id: ModelId::from("company"),
        record_key: Some(RecordKey::ExternalKey("acme".into())),
        new_record_id: None,
        effective_start: "2026-05-01".parse().unwrap(),
        values: None,
        custom_fields: None,
        tombstones_record: true,
        provenance: None,
        ..Default::default()
    };
    let response: Value = client
        .query_one(
            "select kernel_apply_change_set($1::jsonb)",
            &[&serde_json::to_value(apply_request(
                "planned_tombstone",
                vec![source, target, tombstone],
                "planned-same-day-tombstone",
            ))
            .unwrap()],
        )
        .unwrap()
        .get(0);
    assert_eq!(response["ok"], false, "{response:#}");
    assert_eq!(response["error"]["code"], "tombstoned_record");
    let residue: i64 = client
        .query_one(
            "select (select count(*) from change_set)+(select count(*) from company_record)+(select count(*) from assignment_record)",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(residue, 0);
    drop_test_database!(client, schema_name);
}

#[test]
fn generated_apply_and_dry_runs_rethrow_every_serialization_failure() {
    let fixture = compiled("unrelated_40001");
    let (mut client, schema_name) = test_database!(&fixture);
    client
        .batch_execute(
            r#"
            create function reject_change_set_with_40001()
            returns trigger language plpgsql as $$
            declare failure_message text;
            begin
              failure_message := current_setting('kernel.test_40001_message');
              raise exception using errcode='40001', message=failure_message;
            end
            $$;
            create trigger reject_change_set_with_40001
            before insert on change_set
            for each row execute function reject_change_set_with_40001();
            "#,
        )
        .unwrap();
    let request = serde_json::to_value(apply_request(
        "unrelated_40001",
        vec![write(
            "company",
            Uuid::new_v4(),
            "2026-05-01",
            BTreeMap::from([(FieldId::from("name"), FieldValue::Text("Acme".into()))]),
        )],
        "unrelated-40001",
    ))
    .unwrap();
    let batch_request = json!({"changesets":[request.clone()]});
    for message in [
        "record apply dependency drift",
        "unrelated serialization failure",
    ] {
        client
            .query_one(
                "select set_config('kernel.test_40001_message',$1,false)",
                &[&message],
            )
            .unwrap();
        for (statement, request) in [
            ("select kernel_apply_change_set($1::jsonb)", &request),
            (
                "select kernel_validate_change_set_dry_run($1::jsonb)",
                &request,
            ),
            (
                "select kernel_validate_change_sets_dry_run($1::jsonb)",
                &batch_request,
            ),
        ] {
            let error = client.query_one(statement, &[request]).unwrap_err();
            let database_error = error.as_db_error().unwrap();
            assert_eq!(database_error.code().code(), "40001");
            assert_eq!(database_error.message(), message);
        }
    }
    drop_test_database!(client, schema_name);
}

#[test]
fn generated_apply_uses_version_id_not_created_at_for_fully_tied_predecessors() {
    let fixture = compiled("version_id_tie");
    let (mut client, schema_name) = test_database!(&fixture);
    let record_id = Uuid::new_v4();
    let baseline: Value = client
        .query_one(
            "select kernel_apply_change_set($1::jsonb)",
            &[&serde_json::to_value(apply_request(
                "version_id_tie",
                vec![write(
                    "company",
                    record_id,
                    "2026-05-01",
                    BTreeMap::from([(FieldId::from("name"), FieldValue::Text("Base".into()))]),
                )],
                "version-id-baseline",
            ))
            .unwrap()],
        )
        .unwrap()
        .get(0);
    assert_eq!(baseline["ok"], true, "{baseline:#}");
    let change_set_id = baseline["data"]["id"].as_i64().unwrap();
    let lower_id = Uuid::parse_str("00000000-0000-4000-8000-000000000001").unwrap();
    let higher_id = Uuid::parse_str("ffffffff-ffff-4fff-bfff-ffffffffffff").unwrap();
    client
        .execute(
            "delete from company_version where record_id=$1",
            &[&record_id],
        )
        .unwrap();
    client
        .batch_execute("drop index company_version_change_set_value_once_idx")
        .unwrap();
    client
        .execute(
            r#"
            insert into company_version (
              id,record_id,app_id,customer_id,stage,effective_start,effective_end,
              change_set_id,created_at,applied_at,tombstones_record,untombstones_record,
              custom_fields,name
            ) values
              ($1,$3,'sql_apply','version_id_tie','mainline','2026-05-01',null,$4,'2100-01-01Z',now(),false,false,'[]','Created At Winner'),
              ($2,$3,'sql_apply','version_id_tie','mainline','2026-05-01',null,$4,'2000-01-01Z',now(),false,false,'[]','Version Id Winner')
            "#,
            &[&lower_id, &higher_id, &record_id, &change_set_id],
        )
        .unwrap();

    let response: Value = client
        .query_one(
            "select kernel_apply_change_set($1::jsonb)",
            &[&serde_json::to_value(apply_request(
                "version_id_tie",
                vec![RowVersionWrite {
                    model_id: ModelId::from("company"),
                    record_key: Some(RecordKey::RecordId(record_id)),
                    new_record_id: None,
                    effective_start: "2026-05-01".parse().unwrap(),
                    values: Some(BTreeMap::from([(
                        FieldId::from("payload"),
                        FieldValue::Json(json!({"updated":true})),
                    )])),
                    custom_fields: None,
                    tombstones_record: false,
                    provenance: None,
                    ..Default::default()
                }],
                "version-id-update",
            ))
            .unwrap()],
        )
        .unwrap()
        .get(0);
    assert_eq!(response["ok"], true, "{response:#}");
    let applied_change_set_id = response["data"]["id"].as_i64().unwrap();
    let inherited_name: String = client
        .query_one(
            "select name from company_version where change_set_id=$1",
            &[&applied_change_set_id],
        )
        .unwrap()
        .get(0);
    assert_eq!(inherited_name, "Version Id Winner");
    drop_test_database!(client, schema_name);
}

#[test]
fn generated_mainline_serializes_same_subject_before_allocating_order() {
    let compiled = compiled("concurrent");
    let (mut client, schema_name) = test_database!(&compiled);
    let company_id = Uuid::new_v4();
    let baseline = apply_request(
        "concurrent",
        vec![write(
            "company",
            company_id,
            "2026-05-01",
            BTreeMap::from([(
                FieldId::from("name"),
                FieldValue::Text("Baseline".to_string()),
            )]),
        )],
        "concurrent-baseline",
    );
    let baseline_response: Value = client
        .query_one(
            "select kernel_apply_change_set($1::jsonb)",
            &[&serde_json::to_value(baseline).unwrap()],
        )
        .unwrap()
        .get(0);
    assert_eq!(baseline_response["ok"], true, "{baseline_response:#}");

    let update = |name: &str, key: &str| {
        apply_request(
            "concurrent",
            vec![RowVersionWrite {
                model_id: ModelId::from("company"),
                record_key: Some(RecordKey::RecordId(company_id)),
                new_record_id: None,
                effective_start: "2026-05-01".parse().unwrap(),
                values: Some(BTreeMap::from([(
                    FieldId::from("name"),
                    FieldValue::Text(name.to_string()),
                )])),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,
                ..Default::default()
            }],
            key,
        )
    };
    let first = update("First", "concurrent-first");
    let second = update("Second", "concurrent-second");
    let mut transaction = client.transaction().unwrap();
    let first_response: Value = transaction
        .query_one(
            "select kernel_apply_change_set($1::jsonb)",
            &[&serde_json::to_value(first).unwrap()],
        )
        .unwrap()
        .get(0);
    assert_eq!(first_response["ok"], true, "{first_response:#}");

    let database_url = env::var("KERNEL_TEST_DATABASE_URL").unwrap();
    let contender_schema = schema_name.clone();
    let (started_tx, started_rx) = mpsc::channel();
    let (result_tx, result_rx) = mpsc::channel();
    let contender = thread::spawn(move || {
        let mut contender = connect_postgres(&database_url).unwrap();
        contender
            .batch_execute(&format!("set search_path to \"{contender_schema}\""))
            .unwrap();
        trusted_human::select(&mut contender, "fixture-actor");
        started_tx.send(()).unwrap();
        let result: AppliedChangeSet = GeneratedSqlFunction::ApplyChangeSet
            .call_top_level(&mut contender, &second)
            .unwrap();
        result_tx.send(result).unwrap();
    });
    started_rx.recv().unwrap();
    assert!(result_rx.recv_timeout(Duration::from_millis(100)).is_err());
    transaction.commit().unwrap();
    let second_response = result_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    contender.join().unwrap();
    assert_eq!(second_response.id, 3);

    let orders = client
        .query(
            "select applied_order from change_set where customer_id='concurrent' order by applied_order",
            &[],
        )
        .unwrap()
        .into_iter()
        .map(|row| row.get::<_, i64>(0))
        .collect::<Vec<_>>();
    assert_eq!(orders, vec![1, 2, 3]);
    drop_test_database!(client, schema_name);
}

#[test]
fn generated_apply_maps_live_unique_races_but_not_other_23505_constraints() {
    let fixture = compiled("unique_race");
    let (mut client, schema_name) = test_database!(&fixture);
    let first = apply_request(
        "unique_race",
        vec![write(
            "company",
            Uuid::new_v4(),
            "2026-05-01",
            BTreeMap::from([(FieldId::from("name"), FieldValue::Text("Racing Co".into()))]),
        )],
        "unique-race-first",
    );
    let second = apply_request(
        "unique_race",
        vec![write(
            "company",
            Uuid::new_v4(),
            "2026-05-01",
            BTreeMap::from([(FieldId::from("name"), FieldValue::Text("Racing Co".into()))]),
        )],
        "unique-race-second",
    );

    let mut transaction = client.transaction().unwrap();
    let first_response: Value = transaction
        .query_one(
            "select kernel_apply_change_set($1::jsonb)",
            &[&serde_json::to_value(first).unwrap()],
        )
        .unwrap()
        .get(0);
    assert_eq!(first_response["ok"], true, "{first_response:#}");

    let database_url = env::var("KERNEL_TEST_DATABASE_URL").unwrap();
    let contender_schema = schema_name.clone();
    let second_json = serde_json::to_value(second).unwrap();
    let (started_tx, started_rx) = mpsc::channel();
    let (result_tx, result_rx) = mpsc::channel();
    let contender = thread::spawn(move || {
        let mut contender = connect_postgres(&database_url).unwrap();
        contender
            .batch_execute(&format!("set search_path to \"{contender_schema}\""))
            .unwrap();
        trusted_human::select(&mut contender, "fixture-actor");
        started_tx.send(()).unwrap();
        let response: Value = contender
            .query_one("select kernel_apply_change_set($1::jsonb)", &[&second_json])
            .unwrap()
            .get(0);
        result_tx.send(response).unwrap();
    });
    started_rx.recv().unwrap();
    assert!(result_rx.recv_timeout(Duration::from_millis(100)).is_err());
    transaction.commit().unwrap();
    let raced_response = result_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    contender.join().unwrap();
    assert_eq!(raced_response["ok"], false, "{raced_response:#}");
    assert_eq!(
        raced_response["error"],
        json!({
            "code":"unique_field_conflict",
            "message":"Unique field value already exists",
            "details":[
                {"path":"model","code":"unique_field_conflict","message":"company"},
                {"path":"field","code":"unique_field_conflict","message":"name"},
                {"path":"value","code":"unique_field_conflict","message":"Racing Co"}
            ]
        })
    );

    client
        .batch_execute(
            r#"
            create function reject_version_with_record_key_23505()
            returns trigger language plpgsql as $$
            begin
              raise exception using
                errcode='23505',
                message='simulated external-key conflict',
                constraint='company_record_external_key_idx';
            end
            $$;
            create trigger reject_version_with_record_key_23505
            before insert on company_version
            for each row execute function reject_version_with_record_key_23505();
            "#,
        )
        .unwrap();
    let record_key_response: Value = client
        .query_one(
            "select kernel_apply_change_set($1::jsonb)",
            &[&serde_json::to_value(apply_request(
                "unique_race",
                vec![external_write(
                    "company",
                    "external-conflict",
                    "2026-06-01",
                    BTreeMap::from([(FieldId::from("name"), FieldValue::Text("Other Co".into()))]),
                )],
                "external-index-conflict",
            ))
            .unwrap()],
        )
        .unwrap()
        .get(0);
    assert_eq!(record_key_response["ok"], false, "{record_key_response:#}");
    assert_eq!(
        record_key_response["error"],
        json!({
            "code":"record_key_conflict",
            "message":"Record key conflict",
            "details":[]
        })
    );
    drop_test_database!(client, schema_name);
}

#[test]
fn generated_transaction_apply_is_one_shot_and_rethrows_every_40001() {
    let fixture = compiled("transaction_apply");
    let (mut client, schema_name) = test_database!(&fixture);
    let invalid = apply_request(
        "transaction_apply",
        vec![write(
            "company",
            Uuid::new_v4(),
            "2026-05-01",
            BTreeMap::from([(
                FieldId::from("status"),
                FieldValue::Enum(EnumOptionId::from("unknown")),
            )]),
        )],
        "transaction-structured-error",
    );
    let expected = kernel::validate_apply_against_schema(&invalid, &fixture.schema)
        .unwrap_err()
        .into_envelope();
    let rejected_without_transaction: Value = client
        .query_one(
            "select kernel_apply_change_set_in_transaction($1::jsonb)",
            &[&serde_json::to_value(&invalid).unwrap()],
        )
        .unwrap()
        .get(0);
    assert_eq!(rejected_without_transaction["ok"], false);
    assert_eq!(
        rejected_without_transaction["error"]["details"][0]["code"],
        "caller_owned_transaction_required"
    );

    let mut transaction = client.transaction().unwrap();
    transaction
        .query_one(
            "select set_config('platform.caller_owned_transaction', 'true', true)",
            &[],
        )
        .unwrap();
    let structured: Value = transaction
        .query_one(
            "select kernel_apply_change_set_in_transaction($1::jsonb)",
            &[&serde_json::to_value(&invalid).unwrap()],
        )
        .unwrap()
        .get(0);
    assert_eq!(structured["ok"], false, "{structured:#}");
    assert_eq!(structured["error"], serde_json::to_value(expected).unwrap());
    transaction.rollback().unwrap();

    client
        .batch_execute(
            r#"
            create function reject_transaction_apply_with_40001()
            returns trigger language plpgsql as $$
            begin
              raise exception using errcode='40001', message='record apply dependency drift';
            end
            $$;
            create trigger reject_transaction_apply_with_40001
            before insert on change_set
            for each row execute function reject_transaction_apply_with_40001();
            "#,
        )
        .unwrap();
    let valid = apply_request(
        "transaction_apply",
        vec![write(
            "company",
            Uuid::new_v4(),
            "2026-05-01",
            BTreeMap::from([(FieldId::from("name"), FieldValue::Text("Acme".into()))]),
        )],
        "transaction-rethrow",
    );
    let mut transaction = client.transaction().unwrap();
    transaction
        .query_one(
            "select set_config('platform.caller_owned_transaction', 'true', true)",
            &[],
        )
        .unwrap();
    let error = transaction
        .query_one(
            "select kernel_apply_change_set_in_transaction($1::jsonb)",
            &[&serde_json::to_value(valid).unwrap()],
        )
        .unwrap_err();
    let database_error = error.as_db_error().unwrap();
    assert_eq!(database_error.code().code(), "40001");
    assert_eq!(database_error.message(), "record apply dependency drift");
    transaction.rollback().unwrap();
    drop_test_database!(client, schema_name);
}

#[test]
fn generated_apply_returns_current_negative_envelopes_and_rolls_back_reservations() {
    let compiled = compiled("negative");
    let (mut client, schema_name) = test_database!(&compiled);
    let request = apply_request(
        "negative",
        vec![write(
            "company",
            Uuid::new_v4(),
            "2026-05-01",
            BTreeMap::from([(
                FieldId::from("status"),
                FieldValue::Enum(EnumOptionId::from("unknown")),
            )]),
        )],
        "invalid-enum",
    );
    let expected_error = kernel::validate_apply_against_schema(&request, &compiled.schema)
        .unwrap_err()
        .into_envelope();
    let response: Value = client
        .query_one(
            "select kernel_apply_change_set($1::jsonb)",
            &[&serde_json::to_value(&request).unwrap()],
        )
        .unwrap()
        .get(0);
    assert_eq!(response["ok"], false);
    assert_eq!(
        response["error"]["code"], "contract_validation_failed",
        "{response:#}"
    );
    assert_eq!(
        response["error"],
        serde_json::to_value(expected_error).unwrap()
    );
    let residue: i64 = client
        .query_one(
            "select (select count(*) from change_set)+(select count(*) from company_record)+(select count(*) from company_version)",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(residue, 0);

    let first = apply_request(
        "negative",
        vec![write(
            "company",
            Uuid::new_v4(),
            "2026-05-01",
            BTreeMap::from([(
                FieldId::from("name"),
                FieldValue::Text("Unique Co".to_string()),
            )]),
        )],
        "unique-first",
    );
    let first_response: Value = client
        .query_one(
            "select kernel_apply_change_set($1::jsonb)",
            &[&serde_json::to_value(first).unwrap()],
        )
        .unwrap()
        .get(0);
    assert_eq!(first_response["ok"], true, "{first_response:#}");
    let duplicate = apply_request(
        "negative",
        vec![write(
            "company",
            Uuid::new_v4(),
            "2026-05-01",
            BTreeMap::from([(
                FieldId::from("name"),
                FieldValue::Text("Unique Co".to_string()),
            )]),
        )],
        "unique-second",
    );
    let duplicate_response: Value = client
        .query_one(
            "select kernel_apply_change_set($1::jsonb)",
            &[&serde_json::to_value(duplicate).unwrap()],
        )
        .unwrap()
        .get(0);
    assert_eq!(duplicate_response["ok"], false);
    assert_eq!(duplicate_response["error"]["code"], "unique_field_conflict");
    assert_eq!(
        duplicate_response["error"]["details"],
        json!([
            {"path":"model","code":"unique_field_conflict","message":"company"},
            {"path":"field","code":"unique_field_conflict","message":"name"},
            {"path":"value","code":"unique_field_conflict","message":"Unique Co"}
        ])
    );

    let mixed: Value = client
        .query_one(
            "select kernel_validate_change_sets_dry_run($1::jsonb)",
            &[&json!({"changesets":[
                serde_json::to_value(apply_request("negative",vec![write("company",Uuid::new_v4(),"2026-05-01",BTreeMap::from([(FieldId::from("name"),FieldValue::Text("A".to_string()))]))],"mixed-a")).unwrap(),
                serde_json::to_value(apply_request("other",vec![write("company",Uuid::new_v4(),"2026-05-01",BTreeMap::from([(FieldId::from("name"),FieldValue::Text("B".to_string()))]))],"mixed-b")).unwrap()
            ]})],
        )
        .unwrap()
        .get(0);
    assert_eq!(mixed["ok"], false);
    assert_eq!(mixed["error"]["details"][0]["path"], "changesets[1]");
    assert_eq!(
        mixed["error"]["details"][0]["code"],
        "mixed_changeset_scope"
    );
    drop_test_database!(client, schema_name);
}

#[test]
fn generated_apply_accumulates_subject_tombstone_and_custom_field_issues_in_rust_order() {
    let mut fixture = compiled("accumulated_validation");
    let mut archived = custom_field("legacy", CustomFieldType::Text);
    archived.archived_at = Some("2026-01-01T00:00:00Z".parse().unwrap());
    archived.lifecycle = SchemaElementLifecycle::Retired;
    fixture.schema.custom_fields.push(archived);
    fixture.schema.custom_fields.push(CustomFieldDefinition {
        id: CustomFieldDefinitionId::from("company_company_only"),
        model_id: ModelId::from("company"),
        field_id: FieldId::from("company_only"),
        label: "company_only".to_string(),
        field_type: CustomFieldType::Text,
        target_model_id: None,
        option_set: vec![],
        archived_at: None,
        ..Default::default()
    });
    let (mut client, schema_name) = test_database!(&fixture);
    let tombstone_id = Uuid::new_v4();
    let employee_id = Uuid::new_v4();
    let request = apply_request(
        "accumulated_validation",
        vec![
            RowVersionWrite {
                model_id: ModelId::from("company"),
                record_key: Some(RecordKey::ExternalKey("existing".into())),
                new_record_id: Some(tombstone_id),
                effective_start: "2026-05-01".parse().unwrap(),
                values: Some(BTreeMap::from([(
                    FieldId::from("name"),
                    FieldValue::Text("Forbidden".into()),
                )])),
                custom_fields: Some(vec![]),
                tombstones_record: true,
                provenance: None,
                ..Default::default()
            },
            RowVersionWrite {
                model_id: ModelId::from("employee"),
                record_key: None,
                new_record_id: Some(employee_id),
                effective_start: "2026-05-01".parse().unwrap(),
                values: Some(BTreeMap::from([(
                    FieldId::from("name"),
                    FieldValue::Text("Alice".into()),
                )])),
                custom_fields: Some(vec![
                    CustomFieldEntry {
                        field_id: FieldId::from("legacy"),
                        value: CustomFieldValue::Text("old".into()),
                    },
                    CustomFieldEntry {
                        field_id: FieldId::from("company_only"),
                        value: CustomFieldValue::Text("wrong".into()),
                    },
                    CustomFieldEntry {
                        field_id: FieldId::from("not_declared"),
                        value: CustomFieldValue::Text("unknown".into()),
                    },
                ]),
                tombstones_record: false,
                provenance: None,
                ..Default::default()
            },
        ],
        "accumulated-validation",
    );
    let expected = kernel::validate_apply_against_schema(&request, &fixture.schema)
        .unwrap_err()
        .into_envelope();
    let response: Value = client
        .query_one(
            "select kernel_apply_change_set($1::jsonb)",
            &[&serde_json::to_value(&request).unwrap()],
        )
        .unwrap()
        .get(0);
    assert_eq!(response["ok"], false, "{response:#}");
    assert_eq!(response["error"], serde_json::to_value(expected).unwrap());
    assert_eq!(
        response["error"]["details"]
            .as_array()
            .unwrap()
            .iter()
            .map(|detail| detail["code"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec![
            "conflicting_write_subject",
            "new_record_tombstone_forbidden",
            "record_event_values_forbidden",
            "record_event_custom_fields_forbidden",
            "archived_custom_field",
            "wrong_model_custom_field",
            "unknown_custom_field",
        ]
    );
    let residue: i64 = client
        .query_one(
            "select (select count(*) from change_set)+(select count(*) from company_record)+(select count(*) from employee_record)",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(residue, 0);
    drop_test_database!(client, schema_name);
}

#[test]
fn generated_apply_formats_record_target_keys_like_rust_debug() {
    let fixture = compiled("record_key_debug");
    let (mut client, schema_name) = test_database!(&fixture);
    let missing_id = Uuid::new_v4();
    for (index, key) in [
        RecordKey::RecordId(missing_id),
        RecordKey::ExternalKey("missing-company".into()),
    ]
    .into_iter()
    .enumerate()
    {
        let request = apply_request(
            "record_key_debug",
            vec![write(
                "employee",
                Uuid::new_v4(),
                "2026-05-01",
                BTreeMap::from([
                    (FieldId::from("name"), FieldValue::Text("Alice".into())),
                    (FieldId::from("employer"), FieldValue::Relation(key.clone())),
                ]),
            )],
            &format!("missing-relation-{index}"),
        );
        let response: Value = client
            .query_one(
                "select kernel_apply_change_set($1::jsonb)",
                &[&serde_json::to_value(request).unwrap()],
            )
            .unwrap()
            .get(0);
        assert_eq!(response["ok"], false, "{response:#}");
        assert_eq!(response["error"]["code"], "record_target_missing");
        assert_eq!(
            response["error"]["message"],
            format!("record key `{key:?}` did not resolve")
        );
    }
    drop_test_database!(client, schema_name);
}
