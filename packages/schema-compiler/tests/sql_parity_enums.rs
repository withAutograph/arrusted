use std::collections::BTreeMap;
use std::env;
use support::trusted_human;

use chrono::NaiveDate;
use kernel::testing::{call_generated_sql, GeneratedSqlFunction};
use kernel::{
    connect_postgres, schema_hash, ActiveSchemaRevision, AppId, ApplyChangeSet, ApplyMode,
    CustomFieldDefinition, CustomFieldDefinitionId, CustomFieldEntry, CustomFieldType,
    CustomFieldValue, CustomerId, EnumOption, EnumOptionId, Field, FieldId, FieldType, FieldValue,
    Model, ModelId, ModelKind, RecordKey, RowVersionWrite, Schema, SchemaManagementPolicy,
    SchemaVersion, VisibleRecord,
};
use postgres::Client;
use schema_compiler::{
    compile_sql_artifact_manifest, render_sql_artifact_bundle, CompiledManifest,
    NormalizedManifestExtras,
};
use serde_json::{json, Value};
use uuid::Uuid;

mod support;

const MATERIALIZATION_PLAN_HASH: &str =
    "9999999999999999999999999999999999999999999999999999999999999999";

#[test]
fn declared_enum_value_round_trips_orphans_by_omission_and_lookup_kind_is_preserved() {
    let Some(mut db) = EnumSqlDb::new("enum_round_trip") else {
        return;
    };

    let status_column: (String, String) = db
        .client
        .query_one(
            "select data_type, udt_name from information_schema.columns where table_schema = current_schema() and table_name = 'employee_version' and column_name = 'status'",
            &[],
        )
        .map(|row| (row.get(0), row.get(1)))
        .expect("read generated enum column type");
    assert_eq!(status_column, ("text".to_string(), "text".to_string()));

    db.apply(
        "employee-enum",
        "employee",
        "alice",
        values([
            ("name", FieldValue::Text("Alice".to_string())),
            ("status", FieldValue::Enum(EnumOptionId::from("active"))),
        ]),
        None,
    );
    db.apply(
        "lookup-row",
        "department",
        "engineering",
        values([("name", FieldValue::Text("Engineering".to_string()))]),
        None,
    );

    let employee = db.visible("employee");
    assert_eq!(
        employee[0].values.get(&FieldId::from("status")),
        Some(&FieldValue::Enum(EnumOptionId::from("active")))
    );
    let lookup = db.visible("department");
    assert_eq!(
        lookup[0].values.get(&FieldId::from("name")),
        Some(&FieldValue::Text("Engineering".to_string()))
    );
    let active: ActiveSchemaRevision = call_generated_sql(
        &mut db.client,
        GeneratedSqlFunction::ReadActiveSchemaRevision,
        &json!({"app_id": "enum_app", "customer_id": db.customer_id}),
    )
    .expect("read active schema through generated API");
    assert_eq!(
        active
            .schema
            .models
            .iter()
            .find(|model| model.id == ModelId::from("department"))
            .map(|model| model.kind),
        Some(ModelKind::Lookup)
    );

    let mut orphaning_base = db.base_schema.clone();
    orphaning_base.version = SchemaVersion::from("2026-08-05");
    enum_field_mut(&mut orphaning_base).option_set = vec![option("inactive", "Inactive", &[])];
    db.activate_compiled_base(orphaning_base);

    let employee = db.visible("employee");
    assert!(!employee[0].values.contains_key(&FieldId::from("status")));
}

#[test]
fn declared_enum_create_accepts_new_values_through_tenant_schema_revision() {
    let Some(mut db) = EnumSqlDb::new("declared_create") else {
        return;
    };
    let before_catalog: Value = db.client.query_one(
        "select catalog from schema_constraint_identity join schema_revision on schema_revision.id = schema_revision_id where schema_revision.activated_at is not null", &[]
    ).expect("read checked constraint identities").get(0);
    assert!(!before_catalog.as_array().unwrap().is_empty());
    let result = db.commit_operation(json!({
        "type": "create_enum_option",
        "model_id": "employee",
        "field_id": "status",
        "option": option_json("on_leave", "On Leave", &["leave"]),
    }));
    assert_eq!(result["ok"], true, "unexpected create result: {result}");
    assert_eq!(db.active_version(), "2026-08-04+ts1");
    let after_catalog: Value = db.client.query_one(
        "select catalog from schema_constraint_identity join schema_revision on schema_revision.id = schema_revision_id where schema_revision.activated_at is not null", &[]
    ).expect("read inherited constraint identities").get(0);
    assert_eq!(
        after_catalog, before_catalog,
        "tenant extensions preserve checked constraint identities"
    );
    assert_eq!(
        db.active_declared_option_ids(),
        vec!["active", "inactive", "on_leave"]
    );
    let created = db.active_option("employee", "status", "on_leave");
    assert_eq!(created["origin"], "tenant");
    assert_eq!(created["management"], "tenant_managed");
    assert_eq!(created["lifecycle"], "active");

    db.apply(
        "declared-new-option",
        "employee",
        "alice",
        values([
            ("name", FieldValue::Text("Alice".to_string())),
            ("status", FieldValue::Enum(EnumOptionId::from("on_leave"))),
        ]),
        None,
    );
    assert_eq!(
        db.visible("employee")[0]
            .values
            .get(&FieldId::from("status")),
        Some(&FieldValue::Enum(EnumOptionId::from("on_leave")))
    );
}

#[test]
fn generated_materialization_validation_fails_closed_on_unrelated_storage_drift() {
    let Some(mut db) = EnumSqlDb::new("enum_storage_drift") else {
        return;
    };
    db.client
        .batch_execute("alter table company_version alter column metadata set default '[]'::jsonb")
        .expect("introduce unrelated storage drift");
    let active_schema: Value = db
        .client
        .query_one(
            "select schema from schema_revision where app_id = 'enum_app' and customer_id = $1 and activated_at is not null",
            &[&db.customer_id],
        )
        .expect("read active schema for drift validation")
        .get(0);
    let result = db.call(
        "kernel_schema_revision_is_active_with_materialized_tables",
        json!({"schema": active_schema}),
    );
    assert_error(&result, "schema_drift", &["schema_drift"]);
    let stale_default: String = db
        .client
        .query_one(
            r#"
            select pg_get_expr(default_value.adbin, default_value.adrelid)
            from pg_attrdef default_value
            join pg_attribute attribute
              on attribute.attrelid = default_value.adrelid
             and attribute.attnum = default_value.adnum
            where default_value.adrelid = 'company_version'::regclass
              and attribute.attname = 'metadata'
            "#,
            &[],
        )
        .expect("check stale metadata default")
        .get(0);
    assert_eq!(stale_default, "'[]'::jsonb");
}

#[test]
fn custom_enum_create_accepts_new_values_through_tenant_schema_revision() {
    let Some(mut db) = EnumSqlDb::new("custom_create") else {
        return;
    };
    let result = db.commit_operation(json!({
        "type": "create_enum_option",
        "model_id": "employee",
        "field_id": "shirt_size",
        "option": option_json("extra_large", "Extra Large", &["xl"]),
    }));
    assert_eq!(result["ok"], true, "unexpected custom create: {result}");
    db.apply(
        "custom-new-option",
        "employee",
        "alice",
        values([("name", FieldValue::Text("Alice".to_string()))]),
        Some(vec![CustomFieldEntry {
            field_id: FieldId::from("shirt_size"),
            value: CustomFieldValue::Enum(EnumOptionId::from("extra_large")),
        }]),
    );
    assert_eq!(
        db.visible("employee")[0].custom_fields,
        vec![CustomFieldEntry {
            field_id: FieldId::from("shirt_size"),
            value: CustomFieldValue::Enum(EnumOptionId::from("extra_large")),
        }]
    );
}

#[test]
fn retiring_tenant_options_preserves_existing_values_and_rejects_new_selection() {
    let Some(mut db) = EnumSqlDb::new("tenant_retirement") else {
        return;
    };
    assert_eq!(
        db.commit_operations(json!([
            {
                "type": "create_enum_option",
                "model_id": "employee",
                "field_id": "status",
                "option": option_json("contractor", "Contractor", &[]),
            },
            {
                "type": "create_enum_option",
                "model_id": "employee",
                "field_id": "shirt_size",
                "option": option_json("tenant_large", "Tenant Large", &[]),
            }
        ]))["ok"],
        true
    );
    db.apply(
        "runtime-retirement",
        "employee",
        "alice",
        values([
            ("name", FieldValue::Text("Alice".to_string())),
            ("status", FieldValue::Enum(EnumOptionId::from("contractor"))),
        ]),
        Some(vec![CustomFieldEntry {
            field_id: FieldId::from("shirt_size"),
            value: CustomFieldValue::Enum(EnumOptionId::from("tenant_large")),
        }]),
    );

    let retired = db.commit_operations(json!([
        {
            "type": "retire_enum_option",
            "model_id": "employee",
            "field_id": "status",
            "option_id": "contractor",
        },
        {
            "type": "retire_enum_option",
            "model_id": "employee",
            "field_id": "shirt_size",
            "option_id": "tenant_large",
        }
    ]));
    assert_eq!(retired["ok"], true, "unexpected retirement: {retired}");

    let visible = db.visible("employee");
    assert_eq!(
        visible[0].values.get(&FieldId::from("status")),
        Some(&FieldValue::Enum(EnumOptionId::from("contractor")))
    );
    assert_eq!(
        visible[0].custom_fields,
        vec![CustomFieldEntry {
            field_id: FieldId::from("shirt_size"),
            value: CustomFieldValue::Enum(EnumOptionId::from("tenant_large")),
        }]
    );
    assert_eq!(
        db.active_option("employee", "status", "contractor")["lifecycle"],
        "retired"
    );
    let rejected = db.apply_envelope(
        "retired-option-rejected",
        "bob",
        FieldValue::Enum(EnumOptionId::from("contractor")),
    );
    assert_error(
        &rejected,
        "contract_validation_failed",
        &["retired_enum_option"],
    );
}

#[test]
fn declared_overlay_is_composed_after_later_base_options() {
    let Some(mut db) = EnumSqlDb::new("later_base") else {
        return;
    };
    assert_eq!(
        db.commit_operation(json!({
            "type": "create_enum_option",
            "model_id": "employee",
            "field_id": "status",
            "option": option_json("contractor", "Contractor", &[]),
        }))["ok"],
        true
    );
    let mut later_base = db.base_schema.clone();
    later_base.version = SchemaVersion::from("2026-08-05");
    enum_field_mut(&mut later_base)
        .option_set
        .push(option("suspended", "Suspended", &[]));
    db.activate_compiled_base(later_base);

    assert_eq!(
        db.active_declared_option_ids(),
        vec!["active", "inactive", "suspended", "contractor"]
    );
}

#[test]
fn same_base_probe_preserves_the_active_runtime_overlay_revision() {
    let Some(mut db) = EnumSqlDb::new("same_base") else {
        return;
    };
    assert_eq!(
        db.commit_operation(json!({
            "type": "create_enum_option",
            "model_id": "employee",
            "field_id": "status",
            "option": option_json("contractor", "Contractor", &[]),
        }))["ok"],
        true
    );
    let active_revision = db.active_revision_id();
    let (active_schema, recomposed_schema): (Value, Value) = db
        .client
        .query_one(
            r#"
            select schema,
                   jsonb_set(
                     kernel_admin_apply_overlay(base_schema, customer_overlay),
                     '{version}',
                     to_jsonb(schema->>'version')
                   )
            from schema_revision
            where app_id = 'enum_app' and customer_id = $1 and activated_at is not null
            "#,
            &[&db.customer_id],
        )
        .map(|row| (row.get(0), row.get(1)))
        .expect("compare active enum overlay composition");
    assert_eq!(
        recomposed_schema, active_schema,
        "tenant overlay did not recompose"
    );
    let result = db.call(
        "kernel_schema_revision_is_active_with_materialized_tables",
        json!({"schema": db.base_schema}),
    );
    assert_eq!(result, json!({"ok": true, "data": true}));
    assert_eq!(db.active_revision_id(), active_revision);
    assert_eq!(
        db.active_declared_option_ids(),
        vec!["active", "inactive", "contractor"]
    );
}

#[test]
fn declared_enum_operations_reject_fixed_changes_reserved_ids_and_alias_collisions() {
    let Some(mut db) = EnumSqlDb::new("declared_rejections") else {
        return;
    };

    for operation in [
        json!({
            "type": "update_enum_option",
            "model_id": "employee",
            "field_id": "status",
            "option_id": "active",
            "label": "Currently Active",
        }),
        json!({
            "type": "retire_enum_option",
            "model_id": "employee",
            "field_id": "status",
            "option_id": "inactive",
        }),
        json!({
            "type": "create_enum_option",
            "model_id": "employee",
            "field_id": "fixed_status",
            "option": option_json("paused", "Paused", &[]),
        }),
    ] {
        let baseline = db.active_revision_id();
        let result = db.commit_operation(operation);
        assert_error(
            &result,
            "schema_management_forbidden",
            &["fixed_definition"],
        );
        assert_eq!(db.active_revision_id(), baseline);
    }

    for option_value in [
        option_json("active", "Other Active", &[]),
        option_json("contractor", "Contractor", &["INACTIVE"]),
        option_json("temporary", "Temporary", &["CURRENT"]),
        option_json("inactive_alt", "inactive", &[]),
        option_json("active_alt", "Active Alt", &["Active"]),
    ] {
        let baseline = db.active_revision_id();
        let result = db.commit_operation(json!({
            "type": "create_enum_option",
            "model_id": "employee",
            "field_id": "status",
            "option": option_value,
        }));
        let expected = if result["error"]["details"][0]["code"] == "enum_option_id_reserved" {
            "enum_option_id_reserved"
        } else {
            "enum_alias_collision"
        };
        assert_error(&result, "contract_validation_failed", &[expected]);
        assert_eq!(db.active_revision_id(), baseline);
    }

    assert_eq!(
        db.commit_operation(json!({
            "type": "create_enum_option",
            "model_id": "employee",
            "field_id": "status",
            "option": option_json("seasonal", "Seasonal", &[]),
        }))["ok"],
        true
    );
    assert_eq!(
        db.commit_operation(json!({
            "type": "retire_enum_option",
            "model_id": "employee",
            "field_id": "status",
            "option_id": "seasonal",
        }))["ok"],
        true
    );
    let reserved = db.commit_operation(json!({
        "type": "create_enum_option",
        "model_id": "employee",
        "field_id": "status",
        "option": option_json("seasonal", "Seasonal Again", &[]),
    }));
    assert_error(
        &reserved,
        "contract_validation_failed",
        &["enum_option_id_reserved"],
    );
}

#[test]
fn custom_enum_operations_reject_alias_collisions() {
    let Some(mut db) = EnumSqlDb::new("custom_rejections") else {
        return;
    };
    for option_value in [
        option_json("medium", "Medium", &["SMALL"]),
        option_json("large_size", "large", &[]),
        option_json("on_hold", "On Hold", &["large"]),
    ] {
        let baseline = db.active_revision_id();
        let result = db.commit_operation(json!({
            "type": "create_enum_option",
            "model_id": "employee",
            "field_id": "shirt_size",
            "option": option_value,
        }));
        assert_error(
            &result,
            "contract_validation_failed",
            &["enum_alias_collision"],
        );
        assert_eq!(db.active_revision_id(), baseline);
    }
}

#[test]
fn enum_operations_enforce_revision_and_hash_cas_invalid_targets_and_idempotency() {
    let Some(mut db) = EnumSqlDb::new("cas_and_idempotency") else {
        return;
    };
    let (baseline, baseline_hash) = db.active_revision();
    let first_request = db.request(
        baseline,
        &baseline_hash,
        "enum-idempotent",
        json!([{
            "type": "create_enum_option",
            "model_id": "employee",
            "field_id": "status",
            "option": option_json("paused", "Paused", &[]),
        }]),
    );
    let first = db.call_tenant_request(first_request.clone());
    assert_eq!(first["ok"], true, "unexpected first commit: {first}");
    assert_eq!(db.call_tenant_request(first_request.clone()), first);

    let mut conflicting = first_request;
    conflicting["operations"][0]["option"]["label"] = json!("Different");
    let conflict = db.call_tenant_request(conflicting);
    assert_error(&conflict, "idempotency_conflict", &["idempotency_conflict"]);

    let (active, active_hash) = db.active_revision();
    let stale = db.call_tenant_request(db.request(
        baseline,
        &active_hash,
        "enum-stale",
        json!([{
            "type": "create_enum_option",
            "model_id": "employee",
            "field_id": "status",
            "option": option_json("stale", "Stale", &[]),
        }]),
    ));
    assert_eq!(stale["error"]["code"], "stale_schema_revision");
    assert_eq!(stale["error"]["details"][0]["path"], "expected_revision_id");
    assert_eq!(
        stale["error"]["details"][0]["message"],
        format!("Supplied schema_revision_id is {baseline}; active schema_revision_id is {active}")
    );

    let stale_hash = db.call_tenant_request(db.request(
        active,
        &"0".repeat(64),
        "enum-stale-hash",
        json!([{
            "type": "create_enum_option",
            "model_id": "employee",
            "field_id": "status",
            "option": option_json("hash_mismatch", "Hash Mismatch", &[]),
        }]),
    ));
    assert_error(
        &stale_hash,
        "schema_activation_conflict",
        &["expected_hash_mismatch"],
    );

    let invalid = db.call_tenant_request(db.request(
        active,
        &active_hash,
        "enum-invalid-target",
        json!([{
            "type": "create_enum_option",
            "model_id": "employee",
            "field_id": "name",
            "option": option_json("invalid", "Invalid", &[]),
        }]),
    ));
    assert_error(
        &invalid,
        "contract_validation_failed",
        &["unknown_enum_target"],
    );
}

#[test]
fn enum_update_retire_restore_and_explicit_alias_transfer_are_audited_typed_operations() {
    let Some(mut db) = EnumSqlDb::new("typed_lifecycle") else {
        return;
    };
    assert_eq!(
        db.commit_operations(json!([
            {
                "type": "create_enum_option",
                "model_id": "employee",
                "field_id": "status",
                "option": option_json("contractor", "Contractor", &["shared"]),
            },
            {
                "type": "create_enum_option",
                "model_id": "employee",
                "field_id": "status",
                "option": option_json("consultant", "Consultant", &[]),
            }
        ]))["ok"],
        true
    );
    let updated = db.commit_operation(json!({
        "type": "update_enum_option",
        "model_id": "employee",
        "field_id": "status",
        "option_id": "contractor",
        "label": "Independent Contractor",
        "aliases": ["shared", "legacy"],
    }));
    assert_eq!(updated["ok"], true, "unexpected update: {updated}");
    let transferred = db.commit_operation(json!({
        "type": "transfer_enum_alias",
        "model_id": "employee",
        "field_id": "status",
        "alias": "shared",
        "from_option_id": "contractor",
        "to_option_id": "consultant",
    }));
    assert_eq!(
        transferred["ok"], true,
        "unexpected transfer: {transferred}"
    );
    assert_eq!(
        db.active_option("employee", "status", "contractor")["aliases"],
        json!(["legacy"])
    );
    assert_eq!(
        db.active_option("employee", "status", "consultant")["aliases"],
        json!(["shared"])
    );

    let missing_alias = db.commit_operation(json!({
        "type": "transfer_enum_alias",
        "model_id": "employee",
        "field_id": "status",
        "alias": "not-owned",
        "from_option_id": "contractor",
        "to_option_id": "consultant",
    }));
    assert_error(
        &missing_alias,
        "contract_validation_failed",
        &["alias_not_owned"],
    );

    assert_eq!(
        db.commit_operation(json!({
            "type": "retire_enum_option",
            "model_id": "employee",
            "field_id": "status",
            "option_id": "contractor",
        }))["ok"],
        true
    );
    assert_eq!(
        db.commit_operation(json!({
            "type": "restore_enum_option",
            "model_id": "employee",
            "field_id": "status",
            "option_id": "contractor",
        }))["ok"],
        true
    );
    let restore_active = db.commit_operation(json!({
        "type": "restore_enum_option",
        "model_id": "employee",
        "field_id": "status",
        "option_id": "contractor",
    }));
    assert_error(
        &restore_active,
        "contract_validation_failed",
        &["invalid_lifecycle_transition"],
    );

    let audited_operations: Vec<String> = db
        .client
        .query(
            r#"
            select change->>'operation'
            from schema_installation_revision installation
            cross join lateral jsonb_array_elements(installation.phase_plan->0->'changes') change
            where installation.app_id = 'enum_app'
              and installation.customer_id = $1
              and installation.activation_kind = 'tenant_overlay'
            order by installation.schema_revision_id, change->>'operation'
            "#,
            &[&db.customer_id],
        )
        .expect("read enum mutation audit")
        .into_iter()
        .map(|row| row.get(0))
        .collect();
    for operation in [
        "create_enum_option",
        "update_enum_option",
        "transfer_enum_alias",
        "retire_enum_option",
        "restore_enum_option",
    ] {
        assert!(
            audited_operations.iter().any(|value| value == operation),
            "missing audited operation {operation}: {audited_operations:?}"
        );
    }
}

fn compiled_manifest_for_base(schema: &Schema) -> CompiledManifest {
    CompiledManifest {
        schema: schema.clone(),
        extras: NormalizedManifestExtras {
            model_metadata: vec![],
            field_metadata: vec![],
            inverse_relations: vec![],
            many_relations: vec![],
            constraints: serde_json::from_value(json!([{
                "id": "employee_name_present", "model": "employee", "label": "Employee name",
                "authority": "authoritative", "message": "Employee name is required",
                "expression": {"type": "text_length", "field": "name", "min": 1}
            }]))
            .expect("declared enum fixture constraint"),
            derived_fields: vec![],
            authorization_policy: None,
            seed_change_sets: vec![],
        },
    }
}

struct EnumSqlDb {
    client: Client,
    schema_name: String,
    customer_id: String,
    base_schema: Schema,
    mutation_sequence: u64,
}

impl EnumSqlDb {
    fn new(customer_suffix: &str) -> Option<Self> {
        let database_url = match env::var("KERNEL_TEST_DATABASE_URL") {
            Ok(value) => value,
            Err(env::VarError::NotPresent) => {
                eprintln!("skipping generated enum parity: KERNEL_TEST_DATABASE_URL is absent");
                return None;
            }
            Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
        };
        let customer_id = format!("customer_{customer_suffix}");
        let base_schema = enum_schema(&customer_id);
        let compiled = compiled_manifest_for_base(&base_schema);
        let manifest = compile_sql_artifact_manifest(&compiled).expect("compile enum SQL bundle");
        let schema_name = format!("kernel_enum_{}", Uuid::new_v4().simple());
        let mut client = connect_postgres(&database_url).expect("connect enum parity PostgreSQL");
        client
            .batch_execute(&format!(
                "create schema \"{schema_name}\"; set search_path to \"{schema_name}\""
            ))
            .expect("create isolated enum schema");
        trusted_human::before_install(&mut client);
        client
            .batch_execute(&render_sql_artifact_bundle(&manifest))
            .expect("install compiler-emitted SQL bundle");
        validate_pending_constraints(&mut client);

        let mut db = Self {
            client,
            schema_name,
            customer_id,
            base_schema: base_schema.clone(),
            mutation_sequence: 0,
        };
        db.activate_revision(&base_schema, &json!({}), &base_schema, None);
        Some(db)
    }

    fn call(&mut self, function: &str, request: Value) -> Value {
        self.client
            .query_one(&format!("select {function}($1::jsonb)"), &[&request])
            .unwrap_or_else(|error| panic!("call {function}: {error:?}"))
            .get(0)
    }

    fn active_revision_id(&mut self) -> i64 {
        self.client
            .query_one(
                "select id from schema_revision where app_id = 'enum_app' and customer_id = $1 and activated_at is not null",
                &[&self.customer_id],
            )
            .expect("read active enum revision")
            .get(0)
    }

    fn active_revision(&mut self) -> (i64, String) {
        self.client
            .query_one(
                r#"
                select revision.id, coalesce(
                  installation.effective_artifact_hash,
                  revision.schema_hash
                )
                from schema_revision revision
                left join schema_installation_revision installation
                  on installation.schema_revision_id = revision.id
                where revision.app_id = 'enum_app'
                  and revision.customer_id = $1
                  and revision.activated_at is not null
                "#,
                &[&self.customer_id],
            )
            .map(|row| (row.get(0), row.get(1)))
            .expect("read active enum revision CAS state")
    }

    fn active_version(&mut self) -> String {
        self.client
            .query_one(
                "select version from schema_revision where app_id = 'enum_app' and customer_id = $1 and activated_at is not null",
                &[&self.customer_id],
            )
            .expect("read active enum version")
            .get(0)
    }

    fn request(
        &self,
        baseline: i64,
        expected_hash: &str,
        idempotency_key: &str,
        operations: Value,
    ) -> Value {
        json!({
            "app_id": "enum_app",
            "customer_id": self.customer_id,
            "actor_id": "enum-admin",
            "reason": idempotency_key,
            "idempotency_key": idempotency_key,
            "expected_revision_id": baseline,
            "expected_effective_hash": expected_hash,
            "operations": operations,
        })
    }

    fn call_tenant_request(&mut self, request: Value) -> Value {
        self.client
            .query_one(
                r#"
                select set_config('kernel.app_id', 'enum_app', false),
                       set_config('kernel.customer_id', $1, false),
                       set_config('kernel.actor_id', 'enum-admin', false),
                       set_config('kernel.tenant_schema_admin', 'on', false)
                "#,
                &[&self.customer_id],
            )
            .expect("set trusted tenant schema scope");
        self.call("kernel_commit_tenant_schema_revision", request)
    }

    fn commit_operations(&mut self, operations: Value) -> Value {
        let (baseline, expected_hash) = self.active_revision();
        self.mutation_sequence += 1;
        let key = format!("enum-mutation-{}", self.mutation_sequence);
        let request = self.request(baseline, &expected_hash, &key, operations);
        self.call_tenant_request(request)
    }

    fn commit_operation(&mut self, operation: Value) -> Value {
        self.commit_operations(json!([operation]))
    }

    fn apply(
        &mut self,
        idempotency_key: &str,
        model_id: &str,
        external_key: &str,
        values: BTreeMap<FieldId, FieldValue>,
        custom_fields: Option<Vec<CustomFieldEntry>>,
    ) {
        trusted_human::bind(
            &mut self.client,
            "enum_app",
            &self.customer_id,
            "enum-parity",
        );
        let apply = ApplyChangeSet {
            app_id: AppId::from("enum_app"),
            customer_id: CustomerId::from(self.customer_id.clone()),
            schema_revision_id: None,
            actor_id: Some("enum-parity".to_string()),
            source_kind: "test".to_string(),
            source_ref: None,
            idempotency_key: Some(idempotency_key.to_string()),
            change_type_id: None,
            notes: None,
            mode: ApplyMode::Mainline,
            writes: vec![RowVersionWrite {
                model_id: ModelId::from(model_id),
                record_key: Some(RecordKey::ExternalKey(external_key.into())),
                new_record_id: None,
                effective_start: date("2026-08-01"),
                values: Some(values),
                custom_fields,
                tombstones_record: false,
                provenance: None,
                ..Default::default()
            }],
        };
        call_generated_sql::<kernel::AppliedChangeSet>(
            &mut self.client,
            GeneratedSqlFunction::ApplyChangeSet,
            &apply,
        )
        .expect("apply through generated enum API");
    }

    fn apply_envelope(
        &mut self,
        idempotency_key: &str,
        external_key: &str,
        status: FieldValue,
    ) -> Value {
        trusted_human::bind(
            &mut self.client,
            "enum_app",
            &self.customer_id,
            "enum-parity",
        );
        let apply = ApplyChangeSet {
            app_id: AppId::from("enum_app"),
            customer_id: CustomerId::from(self.customer_id.clone()),
            schema_revision_id: None,
            actor_id: Some("enum-parity".to_string()),
            source_kind: "test".to_string(),
            source_ref: None,
            idempotency_key: Some(idempotency_key.to_string()),
            change_type_id: None,
            notes: None,
            mode: ApplyMode::Mainline,
            writes: vec![RowVersionWrite {
                model_id: ModelId::from("employee"),
                record_key: Some(RecordKey::ExternalKey(external_key.into())),
                new_record_id: None,
                effective_start: date("2026-08-01"),
                values: Some(values([
                    ("name", FieldValue::Text("Bob".to_string())),
                    ("status", status),
                ])),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,
                ..Default::default()
            }],
        };
        self.call(
            "kernel_apply_change_set",
            serde_json::to_value(apply).expect("serialize rejected enum apply"),
        )
    }

    fn visible(&mut self, model_id: &str) -> Vec<VisibleRecord> {
        call_generated_sql(
            &mut self.client,
            GeneratedSqlFunction::ReadVisibleRecords,
            &json!({
                "app_id": "enum_app",
                "customer_id": self.customer_id,
                "model_id": model_id,
                "as_of": "2026-08-15",
            }),
        )
        .expect("read through generated enum API")
    }

    fn activate_compiled_base(&mut self, next_base: Schema) {
        let overlay: Value = self
            .client
            .query_one(
                "select customer_overlay from schema_revision where app_id = 'enum_app' and customer_id = $1 and activated_at is not null",
                &[&self.customer_id],
            )
            .expect("read active customer overlay")
            .get(0);
        let effective_json: Value = self
            .client
            .query_one(
                "select kernel_admin_apply_overlay($1::jsonb, $2::jsonb)",
                &[
                    &serde_json::to_value(&next_base).expect("serialize next base"),
                    &overlay,
                ],
            )
            .expect("compose later base through generated SQL")
            .get(0);
        let effective: Schema =
            serde_json::from_value(effective_json).expect("decode composed effective schema");
        let expected: String = self
            .client
            .query_one(
                r#"
                select installation.effective_artifact_hash
                from schema_revision as revision
                join schema_installation_revision as installation
                  on installation.schema_revision_id = revision.id
                where revision.app_id = 'enum_app' and revision.customer_id = $1
                  and revision.activated_at is not null
                "#,
                &[&self.customer_id],
            )
            .expect("read active effective artifact hash")
            .get(0);
        self.activate_revision(&next_base, &overlay, &effective, Some(expected));
        self.base_schema = next_base;
    }

    fn activate_revision(
        &mut self,
        base: &Schema,
        overlay: &Value,
        effective: &Schema,
        expected_active_hash: Option<String>,
    ) {
        let base_hash = schema_hash(base);
        let effective_hash = schema_hash(effective);
        let compiled = compiled_manifest_for_base(base);
        trusted_human::before_install(&mut self.client);
        self.client
            .batch_execute(&render_sql_artifact_bundle(
                &compile_sql_artifact_manifest(&compiled)
                    .expect("compile target base catalog bundle"),
            ))
            .expect("install compiler-emitted target base catalog bundle");
        let prepare = self.call(
            "kernel_prepare_schema_revision",
            json!({
                "app_id": "enum_app",
                "customer_id": self.customer_id,
                "version": effective.version,
                "release_id": format!("enum-parity-{}", effective.version),
                "activation_kind": "tenant_overlay",
                "schema_hash": effective_hash,
                "base_artifact_hash": base_hash,
                "effective_artifact_hash": effective_hash,
                "materialization_plan_hash": MATERIALIZATION_PLAN_HASH,
                "expected_active_effective_hash": expected_active_hash,
                "base_schema": base,
                "customer_overlay": overlay,
                "schema": effective,
                "phase_plan": [],
            }),
        );
        assert_eq!(prepare["ok"], true, "prepare failed: {prepare}");
        let revision_id = prepare["data"]["schema_revision_id"]
            .as_i64()
            .expect("prepared revision id");
        let ready = self.call(
            "kernel_validate_schema_revision_readiness",
            json!({
                "app_id": "enum_app",
                "customer_id": self.customer_id,
                "schema_revision_id": revision_id,
                "effective_artifact_hash": effective_hash,
                "materialization_plan_hash": MATERIALIZATION_PLAN_HASH,
                "phase_results": [],
            }),
        );
        assert_eq!(ready["ok"], true, "readiness failed: {ready}");
        let activated = self.call(
            "kernel_activate_tenant_schema_revision",
            json!({
                "app_id": "enum_app",
                "customer_id": self.customer_id,
                "schema_revision_id": revision_id,
                "effective_artifact_hash": effective_hash,
                "expected_active_effective_hash": expected_active_hash,
            }),
        );
        assert_eq!(activated["ok"], true, "activation failed: {activated}");
    }

    fn active_declared_option_ids(&mut self) -> Vec<String> {
        self.client
            .query_one(
                r#"
                select schema
                from schema_revision
                where app_id = 'enum_app' and customer_id = $1 and activated_at is not null
                "#,
                &[&self.customer_id],
            )
            .map(|row| row.get::<_, Value>(0))
            .expect("read active schema")["models"]
            .as_array()
            .expect("models")
            .iter()
            .find(|model| model["id"] == "employee")
            .expect("employee model")["fields"]
            .as_array()
            .expect("fields")
            .iter()
            .find(|field| field["id"] == "status")
            .expect("status field")["option_set"]
            .as_array()
            .expect("option set")
            .iter()
            .map(|option| option["id"].as_str().expect("option id").to_string())
            .collect()
    }

    fn active_option(&mut self, model_id: &str, field_id: &str, option_id: &str) -> Value {
        let schema: Value = self
            .client
            .query_one(
                "select schema from schema_revision where app_id = 'enum_app' and customer_id = $1 and activated_at is not null",
                &[&self.customer_id],
            )
            .expect("read active enum schema")
            .get(0);
        schema["models"]
            .as_array()
            .expect("models")
            .iter()
            .find(|model| model["id"] == model_id)
            .expect("enum model")["fields"]
            .as_array()
            .expect("fields")
            .iter()
            .find(|field| field["id"] == field_id)
            .expect("enum field")["option_set"]
            .as_array()
            .expect("option set")
            .iter()
            .find(|option| option["id"] == option_id)
            .expect("enum option")
            .clone()
    }
}

impl Drop for EnumSqlDb {
    fn drop(&mut self) {
        support::drop_generated_sql_fixture(&mut self.client, &self.schema_name);
    }
}

fn enum_schema(customer_id: &str) -> Schema {
    Schema {
        app_id: AppId::from("enum_app"),
        customer_id: CustomerId::from(customer_id),
        version: SchemaVersion::from("2026-08-04"),
        models: vec![
            model("company", ModelKind::Entity, false),
            Model {
                id: ModelId::from("employee"),
                kind: ModelKind::Entity,
                label: "Employee".to_string(),
                fields: vec![
                    text_field("name", true, false),
                    Field {
                        id: FieldId::from("status"),
                        label: "Status".to_string(),
                        field_type: FieldType::Enum,
                        required: false,
                        is_unique: false,
                        target_model: None,
                        option_set: vec![
                            option("active", "Active", &["current"]),
                            option("inactive", "Inactive", &[]),
                        ],
                        management: SchemaManagementPolicy::TenantManaged,
                        ..Default::default()
                    },
                    Field {
                        id: FieldId::from("fixed_status"),
                        label: "Fixed Status".to_string(),
                        field_type: FieldType::Enum,
                        required: false,
                        is_unique: false,
                        target_model: None,
                        option_set: vec![option("open", "Open", &[])],
                        ..Default::default()
                    },
                ],
                extensions: kernel::EntityExtensionCapabilities {
                    typed_custom_fields: true,
                    ..Default::default()
                },
                ..Default::default()
            },
            model("department", ModelKind::Lookup, true),
        ],
        custom_fields: vec![CustomFieldDefinition {
            id: CustomFieldDefinitionId::from("employee_shirt_size"),
            model_id: ModelId::from("employee"),
            field_id: FieldId::from("shirt_size"),
            label: "Shirt Size".to_string(),
            field_type: CustomFieldType::Enum,
            target_model_id: None,
            option_set: vec![option("small", "Small", &[]), option("large", "Large", &[])],
            archived_at: None,
            management: SchemaManagementPolicy::TenantManaged,
            ..Default::default()
        }],
        change_types: vec![],
    }
}

fn model(id: &str, kind: ModelKind, unique_name: bool) -> Model {
    Model {
        id: ModelId::from(id),
        kind,
        label: id.to_string(),
        display_field_id: (kind == ModelKind::Lookup).then(|| FieldId::from("name")),
        fields: vec![text_field("name", true, unique_name)],
        ..Default::default()
    }
}

fn text_field(id: &str, required: bool, is_unique: bool) -> Field {
    Field {
        id: FieldId::from(id),
        label: id.to_string(),
        field_type: FieldType::Text,
        required,
        is_unique,
        target_model: None,
        option_set: vec![],
        ..Default::default()
    }
}

fn enum_field_mut(schema: &mut Schema) -> &mut Field {
    schema
        .models
        .iter_mut()
        .find(|model| model.id == ModelId::from("employee"))
        .expect("employee model")
        .fields
        .iter_mut()
        .find(|field| field.id == FieldId::from("status"))
        .expect("status field")
}

fn option(id: &str, label: &str, aliases: &[&str]) -> EnumOption {
    EnumOption {
        id: EnumOptionId::from(id),
        label: label.to_string(),
        aliases: aliases.iter().map(|alias| (*alias).to_string()).collect(),
        ..Default::default()
    }
}

fn option_json(id: &str, label: &str, aliases: &[&str]) -> Value {
    serde_json::to_value(option(id, label, aliases)).expect("serialize enum option")
}

fn values<const N: usize>(entries: [(&str, FieldValue); N]) -> BTreeMap<FieldId, FieldValue> {
    entries
        .into_iter()
        .map(|(field, value)| (FieldId::from(field), value))
        .collect()
}

fn date(value: &str) -> NaiveDate {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").expect("valid test date")
}

fn assert_error(result: &Value, code: &str, detail_codes: &[&str]) {
    assert_eq!(result["ok"], false, "expected error envelope: {result}");
    assert_eq!(result["error"]["code"], code, "unexpected error: {result}");
    assert_eq!(
        result["error"]["message"],
        if code == "contract_validation_failed" {
            "Contract validation failed"
        } else if code == "schema_drift" {
            "Schema drift detected"
        } else if code == "schema_management_forbidden" {
            "Schema definition is fixed"
        } else if code == "idempotency_conflict" {
            "Idempotency key was reused for a different request"
        } else if code == "schema_activation_conflict" {
            "Schema activation conflict"
        } else {
            panic!("add exact message for {code}")
        }
    );
    assert_eq!(
        result["error"]["details"]
            .as_array()
            .expect("error details")
            .iter()
            .map(|detail| detail["code"].as_str().expect("detail code"))
            .collect::<Vec<_>>(),
        detail_codes
    );
}

fn validate_pending_constraints(client: &mut Client) {
    client
        .batch_execute(
            r#"
            do $validation$
            declare pending record;
            begin
              for pending in
                select relation.relname as table_name, constraint_value.conname
                from pg_constraint as constraint_value
                join pg_class as relation on relation.oid = constraint_value.conrelid
                join pg_namespace as namespace on namespace.oid = relation.relnamespace
                where namespace.nspname = current_schema() and not constraint_value.convalidated
              loop
                execute format('alter table %I validate constraint %I', pending.table_name, pending.conname);
              end loop;
            end
            $validation$;
            "#,
        )
        .expect("validate generated constraints");
}
