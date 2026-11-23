use std::env;

use kernel::connect_postgres;
use postgres::Client;
use schema_compiler::{
    compile_manifest_json, compile_sql_artifact_manifest, render_sql_artifact_bundle,
    SqlArtifactKind,
};
use serde_json::{json, Value};
use uuid::Uuid;

mod support;

#[test]
fn materialize_schema_repairs_missing_contracts_before_fresh_validation_via_generated_installer() {
    let Some(mut harness) = Harness::new("repair_contracts") else {
        return;
    };
    let schema = harness.schema_for("tenant_a", "2026-08-04.base");
    harness.activate(&schema, hash('a'));
    harness
        .client
        .batch_execute(
            r#"
            drop index employee_version_change_set_value_once_idx;
            alter table employee_record disable row level security;
            "#,
        )
        .expect("introduce repairable catalog drift");

    assert_ok_true(&repair(&mut harness.client, &schema));
    assert_ok_true(&validate(&mut harness.client, &schema));
    let state: (bool, bool, bool) = harness
        .client
        .query_one(
            r#"
            select
              to_regclass(current_schema() || '.employee_version_change_set_value_once_idx') is not null,
              relation.relrowsecurity,
              relation.relforcerowsecurity
            from pg_class relation
            join pg_namespace namespace on namespace.oid = relation.relnamespace
            where namespace.nspname = current_schema() and relation.relname = 'employee_record'
            "#,
            &[],
        )
        .map(|row| (row.get(0), row.get(1), row.get(2)))
        .expect("read repaired contracts");
    assert_eq!(state, (true, true, true));
}

#[test]
fn materialize_schema_replaces_legacy_version_uniqueness_atomically_via_generated_installer() {
    let Some(mut harness) = Harness::new("legacy_repair") else {
        return;
    };
    let schema = harness.schema_for("tenant_a", "2026-08-04.base");
    harness.activate(&schema, hash('a'));
    harness
        .client
        .batch_execute(
            r#"
            drop index employee_version_change_set_value_once_idx;
            drop index employee_version_mainline_lifecycle_once_idx;
            create unique index employee_version_mainline_unique_idx
              on employee_version (
                record_id, effective_start, tombstones_record, untombstones_record
              )
              where stage = 'mainline';
            "#,
        )
        .expect("install legacy uniqueness contract");

    assert_ok_true(&repair(&mut harness.client, &schema));
    assert_ok_true(&repair(&mut harness.client, &schema));
    let indexes: Vec<String> = harness
        .client
        .query(
            r#"
            select indexname from pg_indexes
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
        .expect("read repaired version indexes")
        .into_iter()
        .map(|row| row.get(0))
        .collect();
    assert_eq!(
        indexes,
        [
            "employee_version_change_set_value_once_idx",
            "employee_version_mainline_lifecycle_once_idx",
        ]
    );
}

#[test]
fn materialized_contract_validation_rejects_legacy_version_index_via_generated_installer() {
    let Some(mut harness) = Harness::new("legacy_reject") else {
        return;
    };
    let schema = harness.schema_for("tenant_a", "2026-08-04.base");
    harness.activate(&schema, hash('a'));
    harness
        .client
        .batch_execute(
            r#"
            create unique index employee_version_mainline_unique_idx
              on employee_version (
                record_id, effective_start, tombstones_record, untombstones_record
              )
              where stage = 'mainline';
            "#,
        )
        .expect("install forbidden legacy uniqueness index");

    assert_schema_drift(
        &validate(&mut harness.client, &schema),
        "employee_version.employee_version_mainline_unique_idx",
        "legacy mainline uniqueness index is still present",
    );
}

#[test]
fn materialize_schema_rejects_custom_fields_default_drift_via_generated_installer() {
    let Some(mut harness) = Harness::new("custom_default") else {
        return;
    };
    let schema = harness.schema_for("tenant_a", "2026-08-04.base");
    harness.activate(&schema, hash('a'));
    harness
        .client
        .batch_execute(
            "alter table employee_version alter column custom_fields set default '{}'::jsonb",
        )
        .expect("drift custom_fields default");

    assert_schema_drift(
        &repair(&mut harness.client, &schema),
        "employee_version.custom_fields",
        "expected default `'[]'::jsonb`, found `'{}'::jsonb`",
    );
}

#[test]
fn materialize_schema_rejects_missing_model_table_after_revision_exists_via_generated_installer() {
    let Some(mut harness) = Harness::new("missing_model") else {
        return;
    };
    let schema = harness.schema_for("tenant_a", "2026-08-04.base");
    harness.activate(&schema, hash('a'));
    harness
        .client
        .batch_execute("drop table employee_version; drop table employee_record")
        .expect("remove materialized model tables");

    assert_schema_drift(
        &repair(&mut harness.client, &schema),
        "employee_record",
        "required materialized table is missing",
    );
}

#[test]
fn materialize_schema_rejects_missing_lifecycle_sequence_after_revision_exists_via_generated_installer(
) {
    let Some(mut harness) = Harness::new("missing_sequence") else {
        return;
    };
    let schema = harness.schema_for("tenant_a", "2026-08-04.base");
    harness.activate(&schema, hash('a'));
    harness
        .client
        .batch_execute("drop sequence change_set_lifecycle_order_seq cascade")
        .expect("remove lifecycle sequence");

    assert_schema_drift(
        &repair(&mut harness.client, &schema),
        "change_set_lifecycle_order_seq",
        "required materialized sequence is missing",
    );
}

#[test]
fn materialize_schema_accepts_appended_agent_run_status_column_via_generated_installer() {
    let Some(mut harness) = Harness::new("agent_status_order") else {
        return;
    };
    let schema = harness.schema_for("tenant_a", "2026-08-04.base");
    harness.activate(&schema, hash('a'));
    harness
        .client
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
        .expect("recreate legacy column-order agent_run");

    assert_ok_true(&repair(&mut harness.client, &schema));
    assert_ok_true(&validate(&mut harness.client, &schema));
}

#[test]
fn materialize_schema_accepts_new_base_version_with_legacy_active_schema_json_via_generated_installer(
) {
    let Some(mut harness) = Harness::new("legacy_next") else {
        return;
    };
    let base_schema = harness.schema_for("tenant_a", "2026-08-04.base");
    let active_id = harness.activate(&base_schema, hash('a'));
    let legacy_schema = without_model_kinds(&base_schema);
    harness
        .client
        .execute(
            "update schema_revision set base_schema = $1, schema = $1 where id = $2",
            &[&legacy_schema, &active_id],
        )
        .expect("store legacy active schema JSON");

    let mut next_schema = harness.schema_for("tenant_a", "2026-08-05.next");
    next_schema["models"][0]["label"] = json!("Renamed Company");
    let next_id = prepare_ready(
        &mut harness.client,
        &next_schema,
        "release-next",
        hash('b'),
        Some(hash('a')),
    );
    assert_ok(&activate_tenant(
        &mut harness.client,
        "tenant_a",
        next_id,
        hash('b'),
        Some(hash('a')),
    ));
    assert_ok_true(&validate(&mut harness.client, &next_schema));
}

#[test]
fn materialize_schema_repairs_same_revision_legacy_model_kind_json_via_generated_installer() {
    let Some(mut harness) = Harness::new("legacy_kind") else {
        return;
    };
    let schema = harness.schema_for("tenant_a", "2026-08-04.base");
    let revision_id = harness.activate(&schema, hash('a'));
    let legacy_schema = without_model_kinds(&schema);
    harness
        .client
        .execute(
            "update schema_revision set base_schema = $1, schema = $1 where id = $2",
            &[&legacy_schema, &revision_id],
        )
        .expect("store same-revision legacy schema JSON");

    assert_ok_true(&repair(&mut harness.client, &schema));
    assert_ok_true(&repair(&mut harness.client, &schema));
    let stored: (Value, Value) = harness
        .client
        .query_one(
            "select base_schema, schema from schema_revision where id = $1",
            &[&revision_id],
        )
        .map(|row| (row.get(0), row.get(1)))
        .expect("read repaired schema JSON");
    assert_eq!(stored, (schema.clone(), schema));
}

#[test]
fn schema_revision_validation_rejects_missing_metadata_columns_via_generated_installer() {
    let Some(mut harness) = Harness::new("missing_metadata") else {
        return;
    };
    let schema = harness.schema_for("tenant_a", "2026-08-04.base");
    harness.activate(&schema, hash('a'));
    harness
        .client
        .batch_execute("alter table schema_revision drop column materialization_git_sha")
        .expect("remove materialization metadata column");

    assert_schema_drift(
        &validate(&mut harness.client, &schema),
        "schema_revision",
        "required materialization metadata column is missing: materialization_git_sha",
    );
}

#[test]
fn schema_revision_validation_rejects_drifted_effective_schema_json_via_generated_installer() {
    let Some(mut harness) = Harness::new("schema_json_drift") else {
        return;
    };
    let schema = harness.schema_for("tenant_a", "2026-08-04.base");
    let revision_id = harness.activate(&schema, hash('a'));
    let mut drifted_schema = schema.clone();
    drifted_schema["models"][0]["label"] = json!("Drifted");
    harness
        .client
        .execute(
            "update schema_revision set schema = $1 where id = $2",
            &[&drifted_schema, &revision_id],
        )
        .expect("drift effective schema JSON");

    let result = validate(&mut harness.client, &schema);
    assert_eq!(
        result["ok"], false,
        "unexpected validation success: {result}"
    );
    assert_eq!(result["error"]["code"], "schema_revision_conflict");
    assert_eq!(
        result["error"]["details"][0]["path"],
        "schema_revision.existing_schema_hash"
    );
    assert_eq!(
        result["error"]["details"][1]["path"],
        "schema_revision.current_schema_hash"
    );
}

#[test]
fn schema_revision_validation_rejects_drifted_model_table_contracts_via_generated_installer() {
    let Some(mut harness) = Harness::new("model_column_drift") else {
        return;
    };
    let schema = harness.schema_for("tenant_a", "2026-08-04.base");
    harness.activate(&schema, hash('a'));
    harness
        .client
        .batch_execute("alter table employee_version drop column name")
        .expect("remove generated model column");

    assert_schema_drift(
        &validate(&mut harness.client, &schema),
        "employee_version.name",
        "required materialized column is missing",
    );
}

#[test]
fn schema_revision_validation_rejects_missing_relation_fk_and_version_check_via_generated_installer(
) {
    let Some(mut harness) = Harness::new("relation_constraint_drift") else {
        return;
    };
    let schema = harness.schema_for("tenant_a", "2026-08-04.base");
    harness.activate(&schema, hash('a'));
    harness
        .client
        .batch_execute(
            r#"
            alter table employee_version
              drop constraint employee_version_employer_tenant_fk;
            alter table employee_version
              drop constraint employee_version_stage_check;
            "#,
        )
        .expect("remove generated relation and stage contracts");

    assert_schema_drift(
        &validate(&mut harness.client, &schema),
        "employee_version.employee_version_employer_tenant_fk",
        "required materialized relation constraint is missing or unvalidated",
    );
}

struct Harness {
    client: Client,
    schema_name: String,
    schema_template: Value,
}

impl Harness {
    fn new(suffix: &str) -> Option<Self> {
        let database_url = test_database_url()?;
        let compiled = compile_manifest_json(&fixture_manifest().to_string())
            .expect("compile installer drift fixture");
        let schema_template = serde_json::to_value(&compiled.schema)
            .expect("serialize compiled schema for installer requests");
        let manifest =
            compile_sql_artifact_manifest(&compiled).expect("compile generated SQL bundle");
        let bundle = render_sql_artifact_bundle(&manifest);
        let schema_name = format!(
            "kernel_installer_drift_{suffix}_{}",
            Uuid::new_v4().simple()
        );
        let mut client = connect_postgres(&database_url).expect("connect to PostgreSQL");
        client
            .batch_execute(&format!(
                "create schema \"{schema_name}\"; set search_path to \"{schema_name}\""
            ))
            .expect("create isolated installer schema");
        support::trusted_human::before_install(&mut client);
        client
            .batch_execute(&bundle)
            .expect("install compiler-emitted SQL bundle");
        Some(Self {
            client,
            schema_name,
            schema_template,
        })
    }

    fn schema_for(&self, customer_id: &str, version: &str) -> Value {
        let mut schema = self.schema_template.clone();
        schema["app_id"] = json!("installer_app");
        schema["customer_id"] = json!(customer_id);
        schema["version"] = json!(version);
        schema
    }

    fn activate(&mut self, schema: &Value, effective_hash: String) -> i64 {
        let revision_id = prepare_ready(
            &mut self.client,
            schema,
            &format!("baseline-{}", schema["customer_id"].as_str().unwrap()),
            effective_hash.clone(),
            None,
        );
        assert_ok(&activate_tenant(
            &mut self.client,
            schema["customer_id"].as_str().unwrap(),
            revision_id,
            effective_hash,
            None,
        ));
        assert_ok_true(&repair(&mut self.client, schema));
        revision_id
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        support::drop_generated_sql_fixture(&mut self.client, &self.schema_name);
    }
}

fn fixture_manifest() -> Value {
    json!({
        "app_id": "installer_app",
        "customer_id": "bundle_customer",
        "version": "2026-08-04.bundle",
        "models": [
            {
                "id": "company",
                "kind": "entity",
                "label": "Company",
                "fields": [
                    {"id": "name", "label": "Name", "type": "text", "required": true}
                ]
            },
            {
                "id": "employee",
                "kind": "entity",
                "label": "Employee",
                "fields": [
                    {"id": "name", "label": "Name", "type": "text", "required": true},
                    {"id": "employer", "label": "Employer", "type": "relation", "target_model": "company"}
                ]
            }
        ],
        "change_types": [
            {"id": "company_update", "label": "Company Update", "model": "company", "required": ["name"]},
            {"id": "employee_update", "label": "Employee Update", "model": "employee", "required": ["name"]}
        ],
        "constraints": [],
        "seed_change_sets": []
    })
}

fn prepare_ready(
    client: &mut Client,
    schema: &Value,
    release_id: &str,
    effective_artifact_hash: String,
    expected_active_effective_hash: Option<String>,
) -> i64 {
    install_compiler_catalog_for_schema(client, schema);
    let customer_id = schema["customer_id"].as_str().unwrap();
    let prepared = call(
        client,
        "kernel_prepare_schema_revision",
        json!({
            "app_id": "installer_app",
            "customer_id": customer_id,
            "version": schema["version"],
            "release_id": release_id,
            "activation_kind": "tenant_overlay",
            "schema_hash": hash('8'),
            "base_artifact_hash": hash('1'),
            "effective_artifact_hash": effective_artifact_hash,
            "materialization_plan_hash": hash('9'),
            "expected_active_effective_hash": expected_active_effective_hash,
            "base_schema": schema,
            "customer_overlay": {},
            "schema": schema,
            "phase_plan": [],
        }),
    );
    let revision_id = revision_id(&prepared);
    assert_ok(&call(
        client,
        "kernel_validate_schema_revision_readiness",
        json!({
            "app_id": "installer_app",
            "customer_id": customer_id,
            "schema_revision_id": revision_id,
            "effective_artifact_hash": effective_artifact_hash,
            "materialization_plan_hash": hash('9'),
            "phase_results": [],
        }),
    ));
    revision_id
}

fn install_compiler_catalog_for_schema(client: &mut Client, schema: &Value) {
    let customer_id = schema["customer_id"].as_str().expect("fixture customer id");
    let version = schema["version"].as_str().expect("fixture schema version");
    let mut manifest = fixture_manifest();
    manifest["customer_id"] = json!(customer_id);
    manifest["version"] = json!(version);
    let compiled =
        compile_manifest_json(&manifest.to_string()).expect("compile fixture catalog source");
    let artifact = compile_sql_artifact_manifest(&compiled)
        .expect("compile fixture catalog artifact")
        .artifacts
        .into_iter()
        .find(|artifact| artifact.kind == SqlArtifactKind::ConstraintCatalog)
        .expect("compiler emits fixture constraint catalog");
    client
        .batch_execute(&artifact.sql)
        .expect("install compiler-derived fixture catalog");
}

fn activate_tenant(
    client: &mut Client,
    customer_id: &str,
    revision_id: i64,
    effective_artifact_hash: String,
    expected_active_effective_hash: Option<String>,
) -> Value {
    call(
        client,
        "kernel_activate_tenant_schema_revision",
        json!({
            "app_id": "installer_app",
            "customer_id": customer_id,
            "schema_revision_id": revision_id,
            "effective_artifact_hash": effective_artifact_hash,
            "expected_active_effective_hash": expected_active_effective_hash,
        }),
    )
}

fn validate(client: &mut Client, schema: &Value) -> Value {
    call(
        client,
        "kernel_validate_materialized_schema_revision",
        json!({"schema": schema, "expected_schema_hash": hash('8')}),
    )
}

fn repair(client: &mut Client, schema: &Value) -> Value {
    call(
        client,
        "kernel_repair_materialized_schema_revision",
        json!({"schema": schema, "expected_schema_hash": hash('8')}),
    )
}

fn call(client: &mut Client, function: &str, request: Value) -> Value {
    client
        .query_one(&format!("select {function}($1::jsonb)"), &[&request])
        .unwrap_or_else(|error| panic!("call {function}: {error:?}"))
        .get(0)
}

fn revision_id(result: &Value) -> i64 {
    assert_ok(result);
    result["data"]["schema_revision_id"]
        .as_i64()
        .expect("schema revision id")
}

fn assert_ok(result: &Value) {
    assert_eq!(result["ok"], true, "unexpected installer error: {result}");
}

fn assert_ok_true(result: &Value) {
    assert_ok(result);
    assert_eq!(
        result["data"], true,
        "unexpected validation result: {result}"
    );
}

fn assert_schema_drift(result: &Value, object: &str, details: &str) {
    assert_eq!(
        result["ok"], false,
        "unexpected validation success: {result}"
    );
    assert_eq!(result["error"]["code"], "schema_drift");
    assert_eq!(result["error"]["details"][0]["path"], "object");
    assert_eq!(result["error"]["details"][0]["code"], "schema_drift");
    assert_eq!(
        result["error"]["details"][0]["message"],
        format!("{object}: {details}")
    );
}

fn without_model_kinds(schema: &Value) -> Value {
    let mut legacy = schema.clone();
    for model in legacy["models"].as_array_mut().unwrap() {
        model.as_object_mut().unwrap().remove("kind");
    }
    legacy
}

fn hash(character: char) -> String {
    character.to_string().repeat(64)
}

fn test_database_url() -> Option<String> {
    match env::var("KERNEL_TEST_DATABASE_URL") {
        Ok(url) => Some(url),
        Err(env::VarError::NotPresent) => {
            eprintln!(
                "skipping generated installer drift parity: KERNEL_TEST_DATABASE_URL is absent"
            );
            None
        }
        Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
    }
}
