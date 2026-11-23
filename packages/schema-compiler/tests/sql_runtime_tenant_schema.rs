#[path = "support/trusted_human.rs"]
mod trusted_human;
use std::env;

use kernel::{
    connect_postgres, schema_hash, validate_schema, Schema, TenantSchemaRevisionDryRunResult,
    TenantSchemaRevisionResult,
};
use schema_compiler::{
    compile_sql_artifact_manifest, render_sql_artifact_bundle, CompiledManifest,
    NormalizedManifestExtras,
};
use serde_json::{json, Value};
use uuid::Uuid;

fn compiled_schema(customer_id: &str) -> CompiledManifest {
    let schema: Schema = serde_json::from_value(json!({
        "app_id": "tenant_schema_app",
        "customer_id": customer_id,
        "version": "2026-08-05",
        "models": [
            {
                "id": "company",
                "kind": "entity",
                "label": "Company",
                "origin": "app",
                "management": "fixed",
                "lifecycle": "active",
                "extensions": {
                    "typed_custom_fields": true,
                    "record_metadata": {
                        "max_bytes": 65536,
                        "max_depth": 16,
                        "max_keys": 256,
                        "max_key_bytes": 256,
                        "max_scalar_bytes": 16384,
                        "max_array_items": 256
                    }
                },
                "fields": [{
                    "id": "name", "label": "Name", "type": "text",
                    "required": true, "is_unique": true,
                    "origin": "app", "management": "fixed", "lifecycle": "active"
                }, {
                    "id": "country", "label": "Country", "type": "relation",
                    "required": false, "is_unique": false, "target_model": "country",
                    "origin": "app", "management": "fixed", "lifecycle": "active"
                }],
                "many_relations": []
            },
            {
                "id": "country",
                "kind": "lookup",
                "label": "Country",
                "display_field_id": "name",
                "origin": "app",
                "management": "tenant_managed",
                "lifecycle": "active",
                "extensions": {"typed_custom_fields": true},
                "fields": [{
                    "id": "name", "label": "Name", "type": "text",
                    "required": true, "is_unique": true,
                    "origin": "app", "management": "fixed", "lifecycle": "active"
                }],
                "many_relations": []
            },
            {
                "id": "currency",
                "kind": "lookup",
                "label": "Currency",
                "display_field_id": "name",
                "origin": "app",
                "management": "fixed",
                "lifecycle": "active",
                "extensions": {},
                "fields": [{
                    "id": "name", "label": "Name", "type": "text",
                    "required": true, "is_unique": true,
                    "origin": "app", "management": "fixed", "lifecycle": "active"
                }],
                "many_relations": []
            }
        ],
        "custom_fields": [],
        "change_types": []
    }))
    .expect("valid tenant schema fixture");
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

fn isolated_tenant_schema_sql() -> String {
    let source = include_str!("../src/sql_runtime/tenant_schema.rs");
    let mut remaining = source;
    let mut sql = String::new();
    while let Some(constant_start) = remaining.find("const KERNEL_") {
        remaining = &remaining[constant_start..];
        let value_start = remaining.find("= r#\"").expect("SQL constant value") + 5;
        remaining = &remaining[value_start..];
        let value_end = remaining.find("\"#;").expect("SQL constant terminator");
        sql.push_str(&remaining[..value_end]);
        sql.push_str(";\n");
        remaining = &remaining[value_end + 3..];
    }
    sql
}

fn error_code(value: &Value) -> &str {
    value["error"]["code"].as_str().expect("error code")
}

#[test]
fn tenant_schema_sql_is_storage_neutral_and_uses_the_apply_activation_lock() {
    let source = include_str!("../src/sql_runtime/tenant_schema.rs");
    assert!(source.contains("kernel_dry_run_tenant_schema_revision(jsonb)"));
    assert!(source.contains("kernel_commit_tenant_schema_revision(jsonb)"));
    assert!(source.contains("kernel_authorize_scope"));
    assert!(!source.contains("kernel.tenant_schema_admin"));
    assert!(source.contains("kernel_tenant_schema_affected_references"));
    assert!(source.contains("kernel_tenant_schema_preparation_plan"));
    assert!(source.contains("kernel_tenant_schema_run_preparation"));
    assert!(source.contains("not in ('number', 'string')"));
    assert!(source.contains("required_field_backfill_required"));
    assert!(source.contains("unique_field_conflicts"));
    assert!(source.contains(":materialize-tenant:"));
    assert!(source.contains(":schema-activation"));
    assert!(source.contains("tenant_managed"));
    assert!(source.contains("many_relations"));
    assert!(source.contains("execute query_sql using"));
    for forbidden in ["create table", "alter table", "drop table", "drop column"] {
        assert!(!source.to_ascii_lowercase().contains(forbidden));
    }
}

#[test]
fn tenant_schema_runtime_enforces_admin_cas_replay_lifecycle_and_isolation_on_pg17() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let tenant_a = compiled_schema("tenant_a");
    let manifest = compile_sql_artifact_manifest(&tenant_a).expect("compile SQL bundle");
    let bundle = render_sql_artifact_bundle(&manifest);
    let mut client = connect_postgres(&database_url).expect("connect to PostgreSQL");
    let version: i32 = client
        .query_one("show server_version_num", &[])
        .expect("read PostgreSQL version")
        .get::<_, String>(0)
        .parse()
        .expect("numeric PostgreSQL version");
    assert!(
        version >= 170_000,
        "tenant schema SQL requires PostgreSQL 17"
    );
    let database_schema = format!("kernel_tenant_schema_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            "create schema \"{database_schema}\"; set search_path to \"{database_schema}\""
        ))
        .expect("create isolated schema");
    trusted_human::before_install(&mut client);

    let result = (|| -> Result<(), String> {
        client
            .batch_execute(&bundle)
            .map_err(|error| format!("install generated bundle: {error:?}"))?;
        client
            .batch_execute(&isolated_tenant_schema_sql())
            .map_err(|error| format!("install tenant schema runtime: {error:?}"))?;
        let tenant_b = compiled_schema("tenant_b");
        let (tenant_a_revision, tenant_a_hash) =
            seed_active_schema(&mut client, &tenant_a.schema, "base-a")?;
        let (tenant_b_revision, _tenant_b_hash) =
            seed_active_schema(&mut client, &tenant_b.schema, "base-b")?;

        set_trusted_scope(&mut client, "tenant_a", "admin_a")?;
        let create_request = json!({
            "app_id": "tenant_schema_app",
            "customer_id": "tenant_a",
            "actor_id": "admin_a",
            "reason": "create tenant vocabulary",
            "idempotency_key": "tenant-schema-create-1",
            "expected_revision_id": tenant_a_revision.to_string(),
            "expected_effective_hash": tenant_a_hash,
            "operations": [
                {
                    "type": "create_model",
                    "model": {
                        "kind": "lookup",
                        "label": "Vendor Category",
                        "display_field_id": "name",
                        "fields": [
                            {
                                "id": "name", "label": "Name", "type": "text",
                                "required": true, "is_unique": true,
                                "origin": "app", "management": "fixed", "lifecycle": "retired"
                            },
                            {
                                "id": "status", "label": "Status", "type": "enum",
                                "required": false, "is_unique": false,
                                "option_set": [
                                    {"id": "active", "label": "Active", "aliases": ["current"]},
                                    {"id": "pending", "label": "Pending", "aliases": []}
                                ]
                            }
                        ],
                        "many_relations": [{
                            "id": "companies", "label": "Companies", "target_model": "company",
                            "origin": "app", "management": "fixed", "lifecycle": "retired"
                        }]
                    }
                },
                {
                    "type": "create_custom_field",
                    "definition": {
                        "id": "company_tier", "model_id": "company", "field_id": "tier",
                        "label": "Tier", "type": "text", "option_set": [],
                        "origin": "app", "management": "fixed", "lifecycle": "retired"
                    }
                }
            ]
        });

        let revision_count_before: i64 = client
            .query_one("select count(*) from schema_revision", &[])
            .map_err(|error| format!("count revisions: {error:?}"))?
            .get(0);
        let dry_run = call(
            &mut client,
            "kernel_dry_run_tenant_schema_revision",
            &create_request,
        )?;
        assert_eq!(dry_run["ok"], true, "{dry_run}");
        let dry_result: TenantSchemaRevisionDryRunResult =
            serde_json::from_value(dry_run["data"].clone()).expect("typed dry-run result");
        assert_eq!(dry_result.baseline_revision_id.get(), tenant_a_revision);
        let dry_run_model_id = dry_result
            .candidate_schema
            .models
            .iter()
            .find(|model| model.label == "Vendor Category")
            .expect("dry-run runtime lookup identity")
            .id
            .to_string();
        assert!(dry_run_model_id.starts_with("lookup_"));
        assert_ne!(dry_run_model_id, "lookup_0001");
        let revision_count_after: i64 = client
            .query_one("select count(*) from schema_revision", &[])
            .map_err(|error| format!("count revisions after dry run: {error:?}"))?
            .get(0);
        assert_eq!(revision_count_before, revision_count_after);

        let committed = call(
            &mut client,
            "kernel_commit_tenant_schema_revision",
            &create_request,
        )?;
        assert_eq!(committed["ok"], true, "{committed}");
        let committed_result: TenantSchemaRevisionResult =
            serde_json::from_value(committed["data"].clone()).expect("typed commit result");
        let runtime_model = committed["data"]["schema"]["models"]
            .as_array()
            .and_then(|models| {
                models
                    .iter()
                    .find(|model| model["label"] == "Vendor Category")
            })
            .expect("runtime lookup model");
        let runtime_model_id = runtime_model["id"]
            .as_str()
            .expect("committed runtime lookup identity")
            .to_string();
        assert_eq!(runtime_model_id, dry_run_model_id);
        assert_eq!(runtime_model["origin"], "tenant");
        assert_eq!(runtime_model["management"], "tenant_managed");
        assert_eq!(runtime_model["lifecycle"], "active");
        assert_eq!(
            runtime_model["many_relations"][0]["management"],
            "tenant_managed"
        );
        assert_eq!(
            runtime_model["fields"][1]["option_set"][0]["lifecycle"],
            "active"
        );
        assert!(committed["data"]["schema"]["custom_fields"][0]
            .get("archived_at")
            .is_none());

        let replay = call(
            &mut client,
            "kernel_commit_tenant_schema_revision",
            &create_request,
        )?;
        assert_eq!(
            replay, committed,
            "idempotent replay returns the original result"
        );
        let mut conflicting_replay = create_request.clone();
        conflicting_replay["reason"] = json!("different payload");
        assert_eq!(
            error_code(&call(
                &mut client,
                "kernel_commit_tenant_schema_revision",
                &conflicting_replay,
            )?),
            "idempotency_conflict"
        );

        let stale = request_for(
            tenant_a_revision,
            &tenant_a_hash,
            "stale-1",
            json!([{"type": "retire_model", "model_id": &runtime_model_id}]),
        );
        assert_eq!(
            error_code(&call(
                &mut client,
                "kernel_commit_tenant_schema_revision",
                &stale
            )?),
            "stale_schema_revision"
        );

        let current_revision = committed_result.schema_revision_id.get();
        let current_hash = committed_result.effective_hash.clone();
        let fixed_edit = request_for(
            current_revision,
            &current_hash,
            "fixed-edit-1",
            json!([{"type": "update_model", "model_id": "currency", "label": "Currencies"}]),
        );
        assert_eq!(
            error_code(&call(
                &mut client,
                "kernel_commit_tenant_schema_revision",
                &fixed_edit
            )?),
            "schema_management_forbidden"
        );

        // Custom fields follow each model's opt-in, lookup or entity alike.
        let lookup_custom_field = |key: &str, model_id: &str| {
            request_for(
                current_revision,
                &current_hash,
                key,
                json!([{
                    "type": "create_custom_field",
                    "definition": {
                        "id": format!("{model_id}_region"), "model_id": model_id,
                        "field_id": "region", "label": "Region", "type": "text", "option_set": []
                    }
                }]),
            )
        };
        let opted_in = call(
            &mut client,
            "kernel_dry_run_tenant_schema_revision",
            &lookup_custom_field("lookup-custom-field-1", "country"),
        )?;
        assert_eq!(opted_in["ok"], true, "{opted_in}");
        let opted_out = call(
            &mut client,
            "kernel_dry_run_tenant_schema_revision",
            &lookup_custom_field("lookup-custom-field-2", "currency"),
        )?;
        assert_eq!(error_code(&opted_out), "contract_validation_failed");
        assert!(
            opted_out["error"]["details"]
                .as_array()
                .is_some_and(|details| details
                    .iter()
                    .any(|detail| detail["code"] == "custom_fields_not_enabled")),
            "{opted_out}"
        );

        let immutable_display = request_for(
            current_revision,
            &current_hash,
            "immutable-display-1",
            json!([{
                "type": "update_model",
                "model_id": &runtime_model_id,
                "display_field_id": "status"
            }]),
        );
        assert_eq!(
            error_code(&call(
                &mut client,
                "kernel_dry_run_tenant_schema_revision",
                &immutable_display
            )?),
            "contract_validation_failed"
        );

        let caller_owned_identity = request_for(
            current_revision,
            &current_hash,
            "caller-owned-model-id-1",
            json!([{
                "type": "create_model",
                "model": {
                    "id": "caller_selected_id",
                    "kind": "lookup",
                    "label": "Caller Identity",
                    "display_field_id": "name",
                    "fields": [{
                        "id": "name", "label": "Name", "type": "text",
                        "required": true, "is_unique": true
                    }]
                }
            }]),
        );
        let caller_owned_identity_result = call(
            &mut client,
            "kernel_dry_run_tenant_schema_revision",
            &caller_owned_identity,
        )?;
        assert_eq!(
            error_code(&caller_owned_identity_result),
            "contract_validation_failed"
        );
        assert_eq!(
            caller_owned_identity_result["error"]["details"][0]["code"],
            "unknown_field"
        );

        let unknown_operation_key = request_for(
            current_revision,
            &current_hash,
            "unknown-operation-key-1",
            json!([{
                "type": "retire_model",
                "model_id": &runtime_model_id,
                "label": "not part of retire_model"
            }]),
        );
        let unknown_operation_key_result = call(
            &mut client,
            "kernel_dry_run_tenant_schema_revision",
            &unknown_operation_key,
        )?;
        assert_eq!(
            error_code(&unknown_operation_key_result),
            "contract_validation_failed"
        );
        assert_eq!(
            unknown_operation_key_result["error"]["details"][0]["code"],
            "unknown_field"
        );

        let malformed_boolean = request_for(
            current_revision,
            &current_hash,
            "malformed-boolean-1",
            json!([{
                "type": "create_field",
                "model_id": &runtime_model_id,
                "field": {
                    "id": "bad_flag", "label": "Bad flag", "type": "text",
                    "required": "yes", "is_unique": false
                }
            }]),
        );
        let malformed_boolean_result = call(
            &mut client,
            "kernel_dry_run_tenant_schema_revision",
            &malformed_boolean,
        )?;
        assert_eq!(
            error_code(&malformed_boolean_result),
            "contract_validation_failed"
        );
        assert_eq!(
            malformed_boolean_result["error"]["details"][0]["code"],
            "invalid_boolean"
        );

        let immutable_target = request_for(
            current_revision,
            &current_hash,
            "immutable-relation-1",
            json!([{
                "type": "update_many_relation", "model_id": &runtime_model_id,
                "relation_id": "companies", "target_model": "country"
            }]),
        );
        assert_eq!(
            error_code(&call(
                &mut client,
                "kernel_dry_run_tenant_schema_revision",
                &immutable_target
            )?),
            "contract_validation_failed"
        );

        let transfer = request_for(
            current_revision,
            &current_hash,
            "alias-transfer-1",
            json!([{
                "type": "transfer_enum_alias", "model_id": &runtime_model_id, "field_id": "status",
                "alias": "current", "from_option_id": "active", "to_option_id": "pending"
            }]),
        );
        let transferred = call(
            &mut client,
            "kernel_commit_tenant_schema_revision",
            &transfer,
        )?;
        assert_eq!(transferred["ok"], true, "{transferred}");
        let transferred_result: TenantSchemaRevisionResult =
            serde_json::from_value(transferred["data"].clone()).expect("typed transfer result");
        let audit_kind: String = client
            .query_one(
                "select phase_results->0->'changes'->0->>'operation' from schema_installation_revision where schema_revision_id = $1",
                &[&transferred_result.schema_revision_id.get()],
            )
            .map_err(|error| format!("read alias transfer audit: {error:?}"))?
            .get(0);
        assert_eq!(audit_kind, "transfer_enum_alias");

        let retire = request_for(
            transferred_result.schema_revision_id.get(),
            &transferred_result.effective_hash,
            "retire-relation-1",
            json!([{"type": "retire_many_relation", "model_id": &runtime_model_id, "relation_id": "companies"}]),
        );
        let retired = call(&mut client, "kernel_commit_tenant_schema_revision", &retire)?;
        assert_eq!(
            retired["data"]["schema"]["models"]
                .as_array()
                .and_then(|models| models.iter().find(|model| model["id"] == runtime_model_id))
                .expect("retired runtime model")["many_relations"][0]["lifecycle"],
            "retired"
        );
        let retired_result: TenantSchemaRevisionResult =
            serde_json::from_value(retired["data"].clone()).expect("typed retirement result");
        let restore = request_for(
            retired_result.schema_revision_id.get(),
            &retired_result.effective_hash,
            "restore-relation-1",
            json!([{"type": "restore_many_relation", "model_id": &runtime_model_id, "relation_id": "companies"}]),
        );
        let restored = call(
            &mut client,
            "kernel_commit_tenant_schema_revision",
            &restore,
        )?;
        assert_eq!(
            restored["data"]["schema"]["models"]
                .as_array()
                .and_then(|models| models.iter().find(|model| model["id"] == runtime_model_id))
                .expect("restored runtime model")["many_relations"][0]["lifecycle"],
            "active"
        );
        let restored_result: TenantSchemaRevisionResult =
            serde_json::from_value(restored["data"].clone()).expect("typed restoration result");
        let runtime_model = restored["data"]["schema"]["models"]
            .as_array()
            .and_then(|models| models.iter().find(|model| model["id"] == runtime_model_id))
            .expect("restored runtime lookup model")
            .clone();
        let version_ids = seed_visible_lookup_versions(
            &mut client,
            restored_result.schema_revision_id.get(),
            &restored["data"]["schema"],
            &runtime_model,
        )?;
        seed_visible_entity_version(&mut client, restored_result.schema_revision_id.get())?;

        let typed_relation_impact = request_for(
            restored_result.schema_revision_id.get(),
            &restored_result.effective_hash,
            "retire-country-impact-1",
            json!([{"type": "retire_model", "model_id": "country"}]),
        );
        let typed_relation_dry_run = call(
            &mut client,
            "kernel_dry_run_tenant_schema_revision",
            &typed_relation_impact,
        )?;
        assert_eq!(
            typed_relation_dry_run["ok"], true,
            "{typed_relation_dry_run}"
        );
        assert_eq!(
            typed_relation_dry_run["data"]["affected_references"],
            json!([{
                "model_id": "country",
                "visible_reference_count": 1,
                "historical_reference_count": 1
            }])
        );

        let typed_custom_impact = request_for(
            restored_result.schema_revision_id.get(),
            &restored_result.effective_hash,
            "retire-company-tier-impact-1",
            json!([{"type": "retire_custom_field", "definition_id": "company_tier"}]),
        );
        let typed_custom_dry_run = call(
            &mut client,
            "kernel_dry_run_tenant_schema_revision",
            &typed_custom_impact,
        )?;
        assert_eq!(typed_custom_dry_run["ok"], true, "{typed_custom_dry_run}");
        assert_eq!(
            typed_custom_dry_run["data"]["affected_references"],
            json!([{
                "model_id": "company",
                "field_id": "tier",
                "visible_reference_count": 1,
                "historical_reference_count": 1
            }])
        );

        let enum_impact = request_for(
            restored_result.schema_revision_id.get(),
            &restored_result.effective_hash,
            "retire-enum-impact-1",
            json!([{
                "type": "retire_enum_option", "model_id": &runtime_model_id,
                "field_id": "status", "option_id": "active"
            }]),
        );
        let enum_dry_run = call(
            &mut client,
            "kernel_dry_run_tenant_schema_revision",
            &enum_impact,
        )?;
        assert_eq!(enum_dry_run["ok"], true, "{enum_dry_run}");
        assert_eq!(
            enum_dry_run["data"]["affected_references"],
            json!([{
                "model_id": runtime_model_id,
                "field_id": "status",
                "option_id": "active",
                "visible_reference_count": 2,
                "historical_reference_count": 2
            }])
        );

        let relation_impact = request_for(
            restored_result.schema_revision_id.get(),
            &restored_result.effective_hash,
            "retire-relation-impact-1",
            json!([{
                "type": "retire_many_relation", "model_id": &runtime_model_id,
                "relation_id": "companies"
            }]),
        );
        let relation_dry_run = call(
            &mut client,
            "kernel_dry_run_tenant_schema_revision",
            &relation_impact,
        )?;
        assert_eq!(relation_dry_run["ok"], true, "{relation_dry_run}");
        assert_eq!(
            relation_dry_run["data"]["affected_references"][0]["visible_reference_count"],
            2
        );
        assert_eq!(
            relation_dry_run["data"]["affected_references"][0]["historical_reference_count"],
            2
        );

        let required_field = request_for(
            restored_result.schema_revision_id.get(),
            &restored_result.effective_hash,
            "required-code-1",
            json!([{
                "type": "create_field",
                "model_id": &runtime_model_id,
                "field": {
                    "id": "code", "label": "Code", "type": "text",
                    "required": true, "is_unique": false,
                    "origin": "app", "management": "fixed", "lifecycle": "retired"
                }
            }]),
        );
        let revision_count_before_required: i64 = client
            .query_one("select count(*) from schema_revision", &[])
            .map_err(|error| format!("count revisions before required dry-run: {error:?}"))?
            .get(0);
        let required_dry_run = call(
            &mut client,
            "kernel_dry_run_tenant_schema_revision",
            &required_field,
        )?;
        assert_eq!(error_code(&required_dry_run), "schema_preparation_failed");
        assert_eq!(
            required_dry_run["error"]["details"][0]["code"],
            "required_field_backfill_required"
        );
        let revision_count_after_required_dry_run: i64 = client
            .query_one("select count(*) from schema_revision", &[])
            .map_err(|error| format!("count revisions after required dry-run: {error:?}"))?
            .get(0);
        assert_eq!(
            revision_count_before_required, revision_count_after_required_dry_run,
            "dry-run must not persist a candidate or ledger"
        );

        let required_failed = call(
            &mut client,
            "kernel_commit_tenant_schema_revision",
            &required_field,
        )?;
        assert_eq!(error_code(&required_failed), "schema_preparation_failed");
        let pending_required_row = client
            .query_one(
                r#"
                select sir.schema_revision_id, sir.ready_at is null, sr.activated_at is null,
                       sir.phase_plan->1->>'kind'
                from schema_installation_revision sir
                join schema_revision sr on sr.id = sir.schema_revision_id
                where sir.app_id = 'tenant_schema_app'
                  and sir.customer_id = 'tenant_a'
                  and sir.release_id = 'tenant-schema:required-code-1'
                "#,
                &[],
            )
            .map_err(|error| format!("read pending required preparation: {error:?}"))?;
        let pending_required: (i64, bool, bool, String) = (
            pending_required_row.get(0),
            pending_required_row.get(1),
            pending_required_row.get(2),
            pending_required_row.get(3),
        );
        assert!(pending_required.1, "failed preparation is not ready");
        assert!(pending_required.2, "failed preparation is not active");
        assert_eq!(pending_required.3, "validate_required_lookup_field");
        let active_after_required_failure: i64 = client
            .query_one(
                "select id from schema_revision where app_id='tenant_schema_app' and customer_id='tenant_a' and activated_at is not null",
                &[],
            )
            .map_err(|error| format!("read active revision after failed preparation: {error:?}"))?
            .get(0);
        assert_eq!(
            active_after_required_failure,
            restored_result.schema_revision_id.get()
        );

        let optional_field = request_for(
            restored_result.schema_revision_id.get(),
            &restored_result.effective_hash,
            "optional-code-1",
            json!([{
                "type": "create_field",
                "model_id": &runtime_model_id,
                "field": {
                    "id": "code", "label": "Code", "type": "text",
                    "required": false, "is_unique": false,
                    "origin": "tenant", "management": "tenant_managed", "lifecycle": "active"
                }
            }]),
        );
        let optional_committed = call(
            &mut client,
            "kernel_commit_tenant_schema_revision",
            &optional_field,
        )?;
        assert_eq!(optional_committed["ok"], true, "{optional_committed}");
        let optional_result: TenantSchemaRevisionResult =
            serde_json::from_value(optional_committed["data"].clone())
                .expect("typed optional-field result");
        for (index, version_id) in version_ids.iter().enumerate() {
            backfill_lookup_text_via_generated_apply(
                &mut client,
                optional_result.schema_revision_id.get(),
                &runtime_model_id,
                *version_id,
                "code",
                "duplicate",
                &format!("backfill-current-code-{index}"),
            )?;
        }
        let future_required_version =
            clone_lookup_version_at_offset(&mut client, version_ids[0], 30, None)?;
        let required_field = request_for(
            optional_result.schema_revision_id.get(),
            &optional_result.effective_hash,
            "required-code-2",
            json!([{
                "type": "update_field", "model_id": &runtime_model_id,
                "field_id": "code", "required": true
            }]),
        );
        let required_future_failed = call(
            &mut client,
            "kernel_commit_tenant_schema_revision",
            &required_field,
        )?;
        assert_eq!(
            error_code(&required_future_failed),
            "schema_preparation_failed"
        );
        assert_eq!(
            required_future_failed["error"]["details"][0]["invalid_record_count"],
            1
        );
        let pending_required_after_backfill: i64 = client
            .query_one(
                "select schema_revision_id from schema_installation_revision where app_id='tenant_schema_app' and customer_id='tenant_a' and release_id='tenant-schema:required-code-2'",
                &[],
            )
            .map_err(|error| format!("read pending required tightening: {error:?}"))?
            .get(0);
        let persisted_failure: Value = client
            .query_one(
                "select phase_plan->0->'last_failed_preparation' from schema_installation_revision where schema_revision_id=$1",
                &[&pending_required_after_backfill],
            )
            .map_err(|error| format!("read persisted preparation failure: {error:?}"))?
            .get(0);
        assert_eq!(persisted_failure, required_future_failed["error"]);
        backfill_lookup_text_via_generated_apply(
            &mut client,
            optional_result.schema_revision_id.get(),
            &runtime_model_id,
            future_required_version,
            "code",
            "duplicate",
            "backfill-future-code",
        )?;
        let required_committed = call(
            &mut client,
            "kernel_commit_tenant_schema_revision",
            &required_field,
        )?;
        assert_eq!(required_committed["ok"], true, "{required_committed}");
        let required_result: TenantSchemaRevisionResult =
            serde_json::from_value(required_committed["data"].clone())
                .expect("typed required-field result");
        assert_eq!(
            required_result.schema_revision_id.get(),
            pending_required_after_backfill,
            "retry resumes the prepared revision instead of creating another"
        );

        let unique_field = request_for(
            required_result.schema_revision_id.get(),
            &required_result.effective_hash,
            "unique-code-1",
            json!([{
                "type": "update_field", "model_id": &runtime_model_id,
                "field_id": "code", "is_unique": true
            }]),
        );
        backfill_lookup_text_via_generated_apply(
            &mut client,
            required_result.schema_revision_id.get(),
            &runtime_model_id,
            version_ids[1],
            "code",
            "distinct",
            "make-current-code-unique",
        )?;
        let future_unique_version =
            clone_lookup_version_at_offset(&mut client, version_ids[1], 60, Some("duplicate"))?;
        let unique_failed = call(
            &mut client,
            "kernel_commit_tenant_schema_revision",
            &unique_field,
        )?;
        assert_eq!(error_code(&unique_failed), "schema_preparation_failed");
        assert_eq!(
            unique_failed["error"]["details"][0]["code"],
            "unique_field_conflicts"
        );
        backfill_lookup_text_via_generated_apply(
            &mut client,
            required_result.schema_revision_id.get(),
            &runtime_model_id,
            future_unique_version,
            "code",
            "future-distinct",
            "make-future-code-unique",
        )?;
        let unique_committed = call(
            &mut client,
            "kernel_commit_tenant_schema_revision",
            &unique_field,
        )?;
        assert_eq!(unique_committed["ok"], true, "{unique_committed}");
        let unique_result: TenantSchemaRevisionResult =
            serde_json::from_value(unique_committed["data"].clone())
                .expect("typed unique-field result");

        let retire_custom = request_for(
            unique_result.schema_revision_id.get(),
            &unique_result.effective_hash,
            "retire-company-tier-1",
            json!([{"type": "retire_custom_field", "definition_id": "company_tier"}]),
        );
        let retired_custom = call(
            &mut client,
            "kernel_commit_tenant_schema_revision",
            &retire_custom,
        )?;
        assert_eq!(retired_custom["ok"], true, "{retired_custom}");
        let retired_custom_result: TenantSchemaRevisionResult =
            serde_json::from_value(retired_custom["data"].clone())
                .expect("typed custom-field retirement result");
        let retired_definition = retired_custom_result
            .schema
            .custom_fields
            .iter()
            .find(|definition| definition.id.as_str() == "company_tier")
            .expect("retired custom-field definition");
        assert!(retired_definition.archived_at.is_some());
        validate_schema(&retired_custom_result.schema)
            .expect("tenant retirement produces a valid kernel schema");

        let restore_custom = request_for(
            retired_custom_result.schema_revision_id.get(),
            &retired_custom_result.effective_hash,
            "restore-company-tier-1",
            json!([{"type": "restore_custom_field", "definition_id": "company_tier"}]),
        );
        let restored_custom = call(
            &mut client,
            "kernel_commit_tenant_schema_revision",
            &restore_custom,
        )?;
        let restored_custom_result: TenantSchemaRevisionResult =
            serde_json::from_value(restored_custom["data"].clone())
                .expect("typed custom-field restoration result");
        assert!(restored_custom_result
            .schema
            .custom_fields
            .iter()
            .any(|definition| {
                definition.id.as_str() == "company_tier"
                    && definition.archived_at.is_none()
                    && definition.lifecycle == kernel::SchemaElementLifecycle::Active
            }));
        validate_schema(&restored_custom_result.schema)
            .expect("tenant restoration produces a valid kernel schema");

        let retire_model = request_for(
            restored_custom_result.schema_revision_id.get(),
            &restored_custom_result.effective_hash,
            "retire-runtime-model-1",
            json!([{"type": "retire_model", "model_id": &runtime_model_id}]),
        );
        let retired_model = call(
            &mut client,
            "kernel_commit_tenant_schema_revision",
            &retire_model,
        )?;
        assert_eq!(retired_model["ok"], true, "{retired_model}");
        let retired_model_result: TenantSchemaRevisionResult =
            serde_json::from_value(retired_model["data"].clone())
                .expect("typed lookup-model retirement result");
        let hidden_list = call(
            &mut client,
            "kernel_lookup_list",
            &json!({
                "app_id": "tenant_schema_app",
                "customer_id": "tenant_a",
                "model_id": runtime_model_id,
                "limit": 10
            }),
        )?;
        assert_eq!(hidden_list["ok"], false);
        assert_eq!(error_code(&hidden_list), "record_target_missing");
        let historical_record_id: Uuid = client
            .query_one(
                "select record_id from lookup_version where id=$1",
                &[&version_ids[0]],
            )
            .map_err(|error| format!("read retired-model record id: {error:?}"))?
            .get(0);
        let historical_resolution = call(
            &mut client,
            "kernel_lookup_resolve_batch",
            &json!({
                "app_id": "tenant_schema_app",
                "customer_id": "tenant_a",
                "model_id": runtime_model_id,
                "record_ids": [historical_record_id]
            }),
        )?;
        assert_eq!(historical_resolution["ok"], true, "{historical_resolution}");
        assert_eq!(
            historical_resolution["data"][0]["record_id"],
            historical_record_id.to_string()
        );

        let restore_model = request_for(
            retired_model_result.schema_revision_id.get(),
            &retired_model_result.effective_hash,
            "restore-runtime-model-1",
            json!([{"type": "restore_model", "model_id": &runtime_model_id}]),
        );
        let restored_model = call(
            &mut client,
            "kernel_commit_tenant_schema_revision",
            &restore_model,
        )?;
        assert_eq!(restored_model["ok"], true, "{restored_model}");
        let visible_list = call(
            &mut client,
            "kernel_lookup_list",
            &json!({
                "app_id": "tenant_schema_app",
                "customer_id": "tenant_a",
                "model_id": runtime_model_id,
                "limit": 10
            }),
        )?;
        assert_eq!(visible_list["ok"], true, "{visible_list}");

        set_trusted_scope(&mut client, "tenant_a", "admin_a")?;
        let tenant_b_models: i32 = client
            .query_one(
                "select jsonb_array_length(schema->'models') from schema_revision where id = $1",
                &[&tenant_b_revision],
            )
            .map_err(|error| format!("read tenant B schema: {error:?}"))?
            .get(0);
        assert_eq!(tenant_b_models, 3);

        let original_schema: Value = client
            .query_one(
                "select schema from schema_revision where id = $1",
                &[&tenant_a_revision],
            )
            .map_err(|error| format!("read original pinned revision: {error:?}"))?
            .get(0);
        assert_eq!(original_schema["version"], "2026-08-05");
        assert_eq!(original_schema["models"].as_array().unwrap().len(), 3);
        Ok(())
    })();

    let _ = client.batch_execute("rollback");
    let cleanup = trusted_human::drop_fixture(&mut client, &database_schema);
    if result.is_ok() {
        cleanup.expect("drop isolated tenant schema test schema");
    }
    result.expect("tenant schema PostgreSQL contract");
}

fn request_for(revision: i64, hash: &str, key: &str, operations: Value) -> Value {
    json!({
        "app_id": "tenant_schema_app",
        "customer_id": "tenant_a",
        "actor_id": "admin_a",
        "reason": key,
        "idempotency_key": key,
        "expected_revision_id": revision,
        "expected_effective_hash": hash,
        "operations": operations
    })
}

fn call(client: &mut postgres::Client, function: &str, request: &Value) -> Result<Value, String> {
    assert!(matches!(
        function,
        "kernel_dry_run_tenant_schema_revision"
            | "kernel_commit_tenant_schema_revision"
            | "kernel_lookup_list"
            | "kernel_lookup_resolve_batch"
    ));
    client
        .query_one(&format!("select {function}($1::jsonb)"), &[request])
        .map(|row| row.get(0))
        .map_err(|error| format!("call {function}: {error:?}"))
}

fn seed_active_schema(
    client: &mut postgres::Client,
    schema: &Schema,
    release_id: &str,
) -> Result<(i64, String), String> {
    let schema_json = serde_json::to_value(schema).expect("serialize schema");
    let hash = schema_hash(schema);
    let revision_id: i64 = client
        .query_one(
            r#"
            insert into schema_revision (
              app_id, customer_id, version, base_schema, customer_overlay, schema,
              schema_hash, materialization_source, materialized_at, activated_at
            ) values ($1, $2, $3, $4, '{}'::jsonb, $4, $5, 'test', now(), now())
            returning id
            "#,
            &[
                &schema.app_id.as_str(),
                &schema.customer_id.as_str(),
                &schema.version.as_str(),
                &schema_json,
                &hash,
            ],
        )
        .map_err(|error| format!("seed schema revision: {error:?}"))?
        .get(0);
    client
        .execute(
            r#"
            insert into schema_installation_revision (
              schema_revision_id, app_id, customer_id, release_id, activation_kind,
              base_artifact_hash, effective_artifact_hash, materialization_plan_hash,
              expected_active_effective_hash, phase_plan, phase_results,
              prepared_at, ready_at, activated_at
            ) values ($1, $2, $3, $4, 'tenant_overlay', $5, $5,
              kernel_admin_sha256(kernel_canonical_json('[]'::jsonb)), null,
              '[]'::jsonb, '[]'::jsonb, now(), now(), now())
            "#,
            &[
                &revision_id,
                &schema.app_id.as_str(),
                &schema.customer_id.as_str(),
                &release_id,
                &hash,
            ],
        )
        .map_err(|error| format!("seed installation revision: {error:?}"))?;
    Ok((revision_id, hash))
}

fn seed_visible_lookup_versions(
    client: &mut postgres::Client,
    schema_revision_id: i64,
    schema: &Value,
    model: &Value,
) -> Result<Vec<Uuid>, String> {
    let change_set_id: i64 = client
        .query_one(
            r#"
            insert into change_set (
              app_id, customer_id, schema_revision_id, created_with_mode, status,
              actor_id, source_kind, idempotency_key, created_order, applied_order, applied_at
            ) values (
              'tenant_schema_app', 'tenant_a', $1, 'mainline', 'mainline',
              'admin_a', 'test', 'tenant-schema-lookup-fixture',
              nextval('change_set_lifecycle_order_seq'),
              nextval('change_set_lifecycle_order_seq'), now()
            ) returning id
            "#,
            &[&schema_revision_id],
        )
        .map_err(|error| format!("seed lookup fixture change set: {error:?}"))?
        .get(0);
    let mut version_ids = Vec::new();
    for (index, name) in ["Alpha", "Beta"].into_iter().enumerate() {
        let record_id = Uuid::new_v4();
        let version_id = Uuid::new_v4();
        let target_id = Uuid::new_v4();
        let values = json!({
            "name": {"type": "text", "value": name},
            "status": {"type": "enum", "value": "active"}
        });
        let many_relations = json!({"companies": [target_id.to_string()]});
        client
            .execute(
                "insert into company_record(id,app_id,customer_id,external_key) values ($1,'tenant_schema_app','tenant_a',$2)",
                &[&target_id, &format!("lookup-company-{index}")],
            )
            .map_err(|error| format!("seed lookup relation target: {error:?}"))?;
        client
            .execute(
                "insert into lookup_record(app_id,customer_id,model_id,id,external_key) values ('tenant_schema_app','tenant_a',$1,$2,$3)",
                &[&model["id"].as_str().expect("lookup model id"), &record_id, &format!("lookup-{index}")],
            )
            .map_err(|error| format!("seed lookup record: {error:?}"))?;
        client
            .execute(
                r#"
                insert into lookup_version(
                  id,app_id,customer_id,model_id,record_id,stage,effective_start,
                  change_set_id,applied_at,availability,custom_fields,metadata,many_relations,values
                ) values (
                  $1,'tenant_schema_app','tenant_a',$2,$3,'mainline',current_date,
                  $4,now(),'active','[]'::jsonb,'{}'::jsonb,$5,$6
                )
                "#,
                &[
                    &version_id,
                    &model["id"].as_str().expect("lookup model id"),
                    &record_id,
                    &change_set_id,
                    &many_relations,
                    &values,
                ],
            )
            .map_err(|error| format!("seed lookup version: {error:?}"))?;
        client
            .query_one(
                "select kernel_apply_project_lookup_version($1,$2,$3,$4,$5,$6,$7,$8,$9,true)",
                &[
                    &version_id,
                    &"tenant_schema_app",
                    &"tenant_a",
                    &model["id"].as_str().expect("lookup model id"),
                    &record_id,
                    schema,
                    model,
                    &values,
                    &many_relations,
                ],
            )
            .map_err(|error| format!("project lookup fixture: {error:?}"))?;
        version_ids.push(version_id);
    }
    Ok(version_ids)
}

fn seed_visible_entity_version(
    client: &mut postgres::Client,
    schema_revision_id: i64,
) -> Result<(), String> {
    let country_id = Uuid::new_v4();
    let company_id = Uuid::new_v4();
    let version_id = Uuid::new_v4();
    client
        .execute(
            "insert into lookup_record(app_id,customer_id,model_id,id,external_key) values ('tenant_schema_app','tenant_a','country',$1,'country-us')",
            &[&country_id],
        )
        .map_err(|error| format!("seed typed relation lookup target: {error:?}"))?;
    let change_set_id: i64 = client
        .query_one(
            r#"
            insert into change_set (
              app_id, customer_id, schema_revision_id, created_with_mode, status,
              actor_id, source_kind, idempotency_key, created_order, applied_order, applied_at
            ) values (
              'tenant_schema_app', 'tenant_a', $1, 'mainline', 'mainline',
              'admin_a', 'test', 'tenant-schema-entity-fixture',
              nextval('change_set_lifecycle_order_seq'),
              nextval('change_set_lifecycle_order_seq'), now()
            ) returning id
            "#,
            &[&schema_revision_id],
        )
        .map_err(|error| format!("seed entity fixture change set: {error:?}"))?
        .get(0);
    client
        .execute(
            "insert into company_record(id,app_id,customer_id,external_key) values ($1,'tenant_schema_app','tenant_a','company-one')",
            &[&company_id],
        )
        .map_err(|error| format!("seed company record: {error:?}"))?;
    client
        .execute(
            r#"
            insert into company_version(
              id,record_id,app_id,customer_id,stage,effective_start,change_set_id,
              applied_at,custom_fields,metadata,name,country
            ) values (
              $1,$2,'tenant_schema_app','tenant_a','mainline',current_date,$3,now(),
              '[{"field_id":"tier","type":"text","value":"Gold"}]'::jsonb,
              '{}'::jsonb,'Company One',$4
            )
            "#,
            &[&version_id, &company_id, &change_set_id, &country_id],
        )
        .map_err(|error| format!("seed company version: {error:?}"))?;
    Ok(())
}

fn backfill_lookup_text_via_generated_apply(
    client: &mut postgres::Client,
    schema_revision_id: i64,
    model_id: &str,
    source_version_id: Uuid,
    field_id: &str,
    value: &str,
    idempotency_key: &str,
) -> Result<(), String> {
    let row = client
        .query_one(
            "select version.record_id, version.effective_start, record.external_key from lookup_version version join lookup_record record on record.app_id=version.app_id and record.customer_id=version.customer_id and record.model_id=version.model_id and record.id=version.record_id where version.app_id='tenant_schema_app' and version.customer_id='tenant_a' and version.model_id=$1 and version.id=$2",
            &[&model_id, &source_version_id],
        )
        .map_err(|error| format!("read lookup backfill target: {error:?}"))?;
    let record_id: Uuid = row.get(0);
    let effective_start: chrono::NaiveDate = row.get(1);
    let external_key: Option<String> = row.get(2);
    let values = serde_json::Map::from_iter([(
        field_id.to_string(),
        json!({"type": "text", "value": value}),
    )]);
    let request = json!({
        "app_id": "tenant_schema_app",
        "customer_id": "tenant_a",
        "schema_revision_id": schema_revision_id,
        "actor_id": "admin_a",
        "source_kind": "tenant-schema-backfill",
        "idempotency_key": idempotency_key,
        "change_type_id": null,
        "notes": "Audited lookup field backfill before schema tightening",
        "mode": "mainline",
        "writes": [{
            "model_id": model_id,
            "record_key": match external_key {
                Some(value) => json!({"type": "external_key", "value": value}),
                None => json!({"type": "record_id", "value": record_id}),
            },
            "effective_start": effective_start,
            "values": values
        }]
    });
    trusted_human::bind(client, "tenant_schema_app", "tenant_a", "admin_a");
    let result: Value = client
        .query_one("select kernel_apply_change_set($1::jsonb)", &[&request])
        .map_err(|error| format!("call generated lookup backfill: {error:?}"))?
        .get(0);
    if result["ok"] != true {
        return Err(format!("generated lookup backfill failed: {result}"));
    }
    Ok(())
}

fn clone_lookup_version_at_offset(
    client: &mut postgres::Client,
    source_version_id: Uuid,
    days: i32,
    code: Option<&str>,
) -> Result<Uuid, String> {
    let version_id = Uuid::new_v4();
    client
        .query_one(
            r#"
            insert into lookup_version(
              id,app_id,customer_id,model_id,record_id,stage,effective_start,effective_end,
              change_set_id,applied_at,tombstones_record,untombstones_record,availability,
              provenance,custom_fields,metadata,many_relations,values
            )
            select $2,app_id,customer_id,model_id,record_id,stage,current_date+$3::integer,null,
              change_set_id,now(),false,false,availability,provenance,custom_fields,metadata,many_relations,
              case when $4::text is null
                then values-'code'
                else values || jsonb_build_object('code',jsonb_build_object('type','text','value',$4::text))
              end
            from lookup_version where id=$1
            returning id
            "#,
            &[&source_version_id, &version_id, &days, &code],
        )
        .map(|row| row.get(0))
        .map_err(|error| format!("clone future lookup version: {error:?}"))
}

fn set_trusted_scope(
    client: &mut postgres::Client,
    customer_id: &str,
    actor_id: &str,
) -> Result<(), String> {
    client
        .query_one(
            "select set_config('kernel.app_id',$1,false), set_config('kernel.customer_id',$2,false), set_config('kernel.actor_id',$3,false)",
            &[&"tenant_schema_app", &customer_id, &actor_id],
        )
        .map_err(|error| format!("set trusted scope: {error:?}"))?;
    Ok(())
}

fn test_database_url() -> Option<String> {
    match env::var("KERNEL_TEST_DATABASE_URL") {
        Ok(value) if !value.trim().is_empty() => Some(value),
        Ok(_) | Err(env::VarError::NotPresent) => {
            eprintln!("skipping tenant schema SQL test: KERNEL_TEST_DATABASE_URL is absent");
            None
        }
        Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
    }
}
