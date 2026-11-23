use std::collections::BTreeSet;
use std::env;

use kernel::{
    connect_postgres, AppId, CustomFieldDefinition, CustomFieldDefinitionId, CustomFieldType,
    CustomerId, EnumOption, EnumOptionId, Field, FieldId, FieldType, Model, ModelId, ModelKind,
    Schema, SchemaVersion,
};
use schema_compiler::{
    compile_sql_artifact_manifest, render_sql_artifact_bundle, CompiledManifest,
    NormalizedManifestExtras, SqlArtifactKind,
};
use serde_json::{json, Value};
use uuid::Uuid;

macro_rules! call {
    ($client:expr, $function:expr, $request:expr $(,)?) => {{
        let function = $function;
        assert!(matches!(
            function,
            "kernel_schema_revision_is_active_with_materialized_tables"
                | "kernel_record_agent_run"
                | "kernel_update_agent_run_status"
        ));
        $client
            .query_one(&format!("select {function}($1::jsonb)"), &[&$request])
            .map(|row| row.get::<_, Value>(0))
            .map_err(|error| format!("{function}: {error:?}"))
    }};
}

macro_rules! seed_active_schema {
    ($client:expr, $schema:expr, $schema_hash:expr $(,)?) => {{
        let seed = json!({"schema": $schema, "schema_hash": $schema_hash});
        $client
            .query_one(
                r#"
                insert into schema_revision (
                  app_id, customer_id, version, base_schema, customer_overlay, schema,
                  schema_hash, materialization_source, materialized_at, activated_at
                )
                select
                  seed->'schema'->>'app_id', seed->'schema'->>'customer_id',
                  seed->'schema'->>'version', seed->'schema', '{}'::jsonb, seed->'schema',
                  seed->>'schema_hash', 'test', now(), now()
                from (select $1::jsonb as seed) as input
                returning id
                "#,
                &[&seed],
            )
            .map_err(|error| format!("seed active schema: {error:?}"))
            .and_then(|row| {
                // Direct fixture seeding must finish the catalog synchronization
                // normally performed by the generated installer.
                let revision_id: i64 = row.get(0);
                $client
                    .query_one("select kernel_sync_schema_constraint_identities($1)", &[&revision_id])
                    .map(|_| ())
                    .map_err(|error| format!("sync seeded constraint catalog: {error:?}"))
            })
    }};
}

fn compiled_schema() -> CompiledManifest {
    CompiledManifest {
        schema: Schema {
            app_id: AppId::from("admin_app"),
            customer_id: CustomerId::from("tenant_a"),
            version: SchemaVersion::from("2026-08-04"),
            models: vec![Model {
                id: ModelId::from("company"),
                kind: ModelKind::Entity,
                label: "Company".to_string(),
                fields: vec![
                    Field {
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
                    },
                    Field {
                        id: FieldId::from("name"),
                        label: "Name".to_string(),
                        field_type: FieldType::Text,
                        required: true,
                        is_unique: true,
                        target_model: None,
                        option_set: vec![],
                        ..Default::default()
                    },
                    Field {
                        id: FieldId::from("parent"),
                        label: "Parent".to_string(),
                        field_type: FieldType::Relation,
                        required: false,
                        is_unique: false,
                        target_model: Some(ModelId::from("company")),
                        option_set: vec![],
                        ..Default::default()
                    },
                    Field {
                        id: FieldId::from("billing_rate"),
                        label: "Billing Rate".to_string(),
                        field_type: FieldType::MoneyRate,
                        required: true,
                        is_unique: false,
                        target_model: None,
                        option_set: vec![],
                        ..Default::default()
                    },
                ],
                extensions: kernel::EntityExtensionCapabilities {
                    typed_custom_fields: true,
                    ..Default::default()
                },
                ..Default::default()
            }],
            custom_fields: vec![CustomFieldDefinition {
                id: CustomFieldDefinitionId::from("company_shirt_size"),
                model_id: ModelId::from("company"),
                field_id: FieldId::from("shirt_size"),
                label: "Shirt Size".to_string(),
                field_type: CustomFieldType::Enum,
                target_model_id: None,
                option_set: vec![EnumOption {
                    id: EnumOptionId::from("small"),
                    label: "Small".to_string(),
                    aliases: vec![],
                    ..Default::default()
                }],
                archived_at: None,
                ..Default::default()
            }],
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

#[test]
fn admin_runtime_artifacts_are_family_prefixed_and_public_functions_return_envelopes() {
    let manifest = compile_sql_artifact_manifest(&compiled_schema()).unwrap();
    let functions = manifest
        .artifacts
        .iter()
        .filter(|artifact| artifact.kind == SqlArtifactKind::Function)
        .collect::<Vec<_>>();
    for signature in [
        "kernel_schema_revision_is_active_with_materialized_tables(jsonb)",
        "kernel_record_agent_run(jsonb)",
        "kernel_update_agent_run_status(jsonb)",
    ] {
        let artifact = functions
            .iter()
            .find(|artifact| artifact.name == signature)
            .unwrap_or_else(|| panic!("missing generated admin function {signature}"));
        assert!(artifact.sql.contains("returns jsonb"));
        if signature == "kernel_schema_revision_is_active_with_materialized_tables(jsonb)" {
            assert!(artifact.sql.contains("jsonb_build_object('ok'"));
        } else {
            let original = signature.trim_end_matches("(jsonb)");
            let private_signature = format!(
                "kernel_http_body_{}(jsonb)",
                original.trim_start_matches("kernel_")
            );
            let body = functions
                .iter()
                .find(|item| item.name == private_signature)
                .expect("private envelope body is included");
            assert!(body.sql.contains("returns jsonb"));
            assert!(body.sql.contains("jsonb_build_object('ok'"));
            assert!(artifact.sql.contains(&format!(
                "result := {}(request)",
                private_signature.trim_end_matches("(jsonb)")
            )));
            assert!(artifact
                .sql
                .contains("if guard->'ok'='false'::jsonb then return guard; end if"));
            assert!(artifact.sql.contains("return result;"));
            let guard = functions
                .iter()
                .find(|item| item.name == "kernel_http_mutation_guard(jsonb,text)")
                .expect("guard contract is included");
            assert!(guard
                .sql
                .contains("kernel_installer_error('authorization_denied'"));
        }
        assert!(!artifact.sql.contains("_result("));
    }
    assert!(functions
        .iter()
        .all(|artifact| artifact.name != "kernel_commit_enum_option_set_revision(jsonb)"));
    let admin_helpers = functions
        .iter()
        .filter(|artifact| artifact.name.starts_with("kernel_admin_"))
        .map(|artifact| artifact.name.as_str())
        .collect::<BTreeSet<_>>();
    assert_eq!(
        admin_helpers,
        BTreeSet::from([
            "kernel_admin_apply_overlay(jsonb,jsonb)",
            "kernel_admin_bounded_identifier(text)",
            "kernel_admin_custom_field_collision_issues(jsonb,jsonb)",
            "kernel_admin_enum_match_key(text)",
            "kernel_admin_error(text,text,jsonb)",
            "kernel_admin_materialization_error(jsonb,jsonb)",
            "kernel_admin_normalize_identifier(text)",
            "kernel_admin_sha256(text)",
            "kernel_admin_validate_enum_options(jsonb,boolean)",
            "kernel_admin_validation_error(jsonb)",
        ])
    );
}

#[test]
fn admin_runtime_matches_schema_and_agent_contracts_in_postgres() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let compiled = compiled_schema();
    let manifest = compile_sql_artifact_manifest(&compiled).unwrap();
    let bundle = render_sql_artifact_bundle(&manifest);
    let mut client = connect_postgres(&database_url).expect("connect to test PostgreSQL");
    let database_schema = format!("kernel_sql_admin_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            "create schema \"{database_schema}\"; set search_path to \"{database_schema}\""
        ))
        .expect("create isolated SQL admin schema");

    let result = (|| {
        client
            .batch_execute(&bundle)
            .map_err(|error| format!("install bundle: {error:?}"))?;
        let sha256_abc: String = client
            .query_one("select kernel_admin_sha256('abc')", &[])
            .map_err(|error| format!("SHA-256 helper: {error:?}"))?
            .get(0);
        assert_eq!(
            sha256_abc,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let overlength_identifier = "a".repeat(80);
        let identifier_row = client
            .query_one(
                "select kernel_admin_bounded_identifier($1), kernel_physical_identifier($1)",
                &[&overlength_identifier],
            )
            .map_err(|error| format!("bounded identifier helper: {error:?}"))?;
        assert_eq!(
            identifier_row.get::<_, String>(0),
            identifier_row.get::<_, String>(1)
        );
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
                    execute format(
                      'alter table %I validate constraint %I',
                      pending.table_name,
                      pending.conname
                    );
                  end loop;
                end
                $validation$;
                "#,
            )
            .map_err(|error| format!("validate generated constraints: {error:?}"))?;
        let tenant_a_schema = serde_json::to_value(&compiled.schema).unwrap();
        let tenant_a_hash = kernel::schema_hash(&compiled.schema);
        let mut tenant_b_schema = tenant_a_schema.clone();
        tenant_b_schema["customer_id"] = json!("tenant_b");
        let tenant_b_contract: Schema = serde_json::from_value(tenant_b_schema.clone()).unwrap();
        let tenant_b_hash = kernel::schema_hash(&tenant_b_contract);
        seed_active_schema!(&mut client, &tenant_a_schema, tenant_a_hash.clone())?;
        seed_active_schema!(&mut client, &tenant_b_schema, tenant_b_hash)?;

        let active = call!(
            &mut client,
            "kernel_schema_revision_is_active_with_materialized_tables",
            json!({
                "schema": tenant_a_schema,
                "expected_active_revision_id": 1,
                "expected_schema_hash": tenant_a_hash,
                "materialized_assertions": [{
                    "kind": "column", "table": "company_version", "name": "status",
                    "definition": "text nullable"
                }]
            }),
        )?;
        assert_eq!(active, json!({"ok": true, "data": true}));

        let catalog_request = json!({
            "schema": tenant_a_schema,
            "expected_active_revision_id": 1,
            "expected_schema_hash": tenant_a_hash,
        });
        client
            .batch_execute("alter table company_version alter column status type varchar")
            .map_err(|error| format!("mutate column type: {error:?}"))?;
        assert_error(
            &call!(
                &mut client,
                "kernel_schema_revision_is_active_with_materialized_tables",
                catalog_request.clone(),
            )?,
            "schema_drift",
        );
        client
            .batch_execute("alter table company_version alter column status type text")
            .map_err(|error| format!("restore column type: {error:?}"))?;
        client
            .batch_execute("alter table company_version drop column provenance")
            .map_err(|error| format!("drop expected column: {error:?}"))?;
        assert_error(
            &call!(
                &mut client,
                "kernel_schema_revision_is_active_with_materialized_tables",
                catalog_request.clone(),
            )?,
            "schema_drift",
        );
        client
            .batch_execute("alter table company_version add column provenance jsonb")
            .map_err(|error| format!("restore expected column: {error:?}"))?;
        // Dropping provenance also drops its dependent expression index. The
        // restored column alone must not satisfy the materialization contract.
        assert_error(
            &call!(
                &mut client,
                "kernel_schema_revision_is_active_with_materialized_tables",
                catalog_request.clone(),
            )?,
            "schema_drift",
        );
        client
            .batch_execute(
                "create index company_version_source_record_ref_idx on company_version \
                 (app_id, customer_id, (provenance->>'source_record_ref')) \
                 where provenance ? 'source_record_ref'",
            )
            .map_err(|error| format!("restore provenance expression index: {error:?}"))?;
        assert_eq!(
            call!(
                &mut client,
                "kernel_schema_revision_is_active_with_materialized_tables",
                catalog_request.clone(),
            )?,
            json!({"ok": true, "data": true})
        );

        client
            .batch_execute(
                r#"
                alter table company_version drop constraint company_version_status_record_event_null_check;
                alter table company_version add constraint company_version_status_record_event_null_check
                  check ((not tombstones_record and not untombstones_record) or status is null) not valid;
                "#,
            )
            .map_err(|error| format!("make constraint NOT VALID: {error:?}"))?;
        assert_error(
            &call!(
                &mut client,
                "kernel_schema_revision_is_active_with_materialized_tables",
                catalog_request.clone(),
            )?,
            "schema_drift",
        );
        client
            .batch_execute(
                "alter table company_version validate constraint company_version_status_record_event_null_check",
            )
            .map_err(|error| format!("validate restored constraint: {error:?}"))?;
        assert_eq!(
            call!(
                &mut client,
                "kernel_schema_revision_is_active_with_materialized_tables",
                catalog_request.clone(),
            )?,
            json!({"ok": true, "data": true})
        );

        client
            .batch_execute(
                r#"
                alter table company_version drop constraint company_version_status_record_event_null_check;
                alter table company_version add constraint company_version_status_record_event_null_check check (true);
                "#,
            )
            .map_err(|error| format!("mutate constraint definition: {error:?}"))?;
        assert_error(
            &call!(
                &mut client,
                "kernel_schema_revision_is_active_with_materialized_tables",
                catalog_request.clone(),
            )?,
            "schema_drift",
        );
        client
            .batch_execute(
                r#"
                alter table company_version drop constraint company_version_status_record_event_null_check;
                alter table company_version add constraint company_version_status_record_event_null_check
                  check ((not tombstones_record and not untombstones_record) or status is null);
                "#,
            )
            .map_err(|error| format!("restore constraint definition: {error:?}"))?;

        client
            .batch_execute(
                r#"
                alter table company_version drop constraint company_version_change_set_tenant_fk;
                alter table company_version add constraint company_version_change_set_tenant_fk
                  foreign key (change_set_id) references change_set (id);
                "#,
            )
            .map_err(|error| format!("mutate foreign key: {error:?}"))?;
        assert_error(
            &call!(
                &mut client,
                "kernel_schema_revision_is_active_with_materialized_tables",
                catalog_request.clone(),
            )?,
            "schema_drift",
        );
        client
            .batch_execute(
                r#"
                alter table company_version drop constraint company_version_change_set_tenant_fk;
                alter table company_version add constraint company_version_change_set_tenant_fk
                  foreign key (change_set_id, app_id, customer_id)
                  references change_set (id, app_id, customer_id);
                "#,
            )
            .map_err(|error| format!("restore foreign key: {error:?}"))?;

        client
            .batch_execute(
                r#"
                drop index company_version_lookup_idx;
                create index company_version_lookup_idx
                  on company_version (stage, record_id, effective_start desc);
                "#,
            )
            .map_err(|error| format!("mutate index: {error:?}"))?;
        assert_error(
            &call!(
                &mut client,
                "kernel_schema_revision_is_active_with_materialized_tables",
                catalog_request.clone(),
            )?,
            "schema_drift",
        );
        client
            .batch_execute(
                r#"
                drop index company_version_lookup_idx;
                create index company_version_lookup_idx
                  on company_version (record_id, stage, effective_start desc);
                "#,
            )
            .map_err(|error| format!("restore index: {error:?}"))?;

        client
            .batch_execute("alter table company_version disable row level security")
            .map_err(|error| format!("disable RLS: {error:?}"))?;
        assert_error(
            &call!(
                &mut client,
                "kernel_schema_revision_is_active_with_materialized_tables",
                catalog_request.clone(),
            )?,
            "schema_drift",
        );
        client
            .batch_execute("alter table company_version enable row level security")
            .map_err(|error| format!("restore RLS: {error:?}"))?;

        client
            .batch_execute(
                r#"
                drop policy kernel_tenant_isolation on company_version;
                create policy kernel_tenant_isolation on company_version for all
                  using (true) with check (true);
                "#,
            )
            .map_err(|error| format!("mutate tenant policy: {error:?}"))?;
        assert_error(
            &call!(
                &mut client,
                "kernel_schema_revision_is_active_with_materialized_tables",
                catalog_request.clone(),
            )?,
            "schema_drift",
        );
        client
            .batch_execute(
                r#"
                drop policy kernel_tenant_isolation on company_version;
                create policy kernel_tenant_isolation on company_version for all
                  using (
                    (app_id, customer_id) = (select scope.app_id, scope.customer_id from (select current_setting('kernel.app_id', true) app_id, current_setting('kernel.customer_id', true) customer_id) scope where kernel_principal_scope_authorized('any', scope.app_id, scope.customer_id, null) and kernel_policy_raw_table_access_allowed(current_user::name, scope.app_id, scope.customer_id))
                  )
                  with check (
                    (app_id, customer_id) = (select scope.app_id, scope.customer_id from (select current_setting('kernel.app_id', true) app_id, current_setting('kernel.customer_id', true) customer_id) scope where kernel_principal_scope_authorized('any', scope.app_id, scope.customer_id, null) and kernel_policy_raw_table_access_allowed(current_user::name, scope.app_id, scope.customer_id))
                  );
                "#,
            )
            .map_err(|error| format!("restore tenant policy: {error:?}"))?;
        assert_eq!(
            call!(
                &mut client,
                "kernel_schema_revision_is_active_with_materialized_tables",
                catalog_request,
            )?,
            json!({"ok": true, "data": true})
        );
        let structural_drift = call!(
            &mut client,
            "kernel_schema_revision_is_active_with_materialized_tables",
            json!({
                "schema": tenant_a_schema,
                "materialized_assertions": [{
                    "kind": "column", "table": "company_version", "name": "missing_column"
                }]
            }),
        )?;
        assert_error(&structural_drift, "schema_drift");
        let stale_hash = call!(
            &mut client,
            "kernel_schema_revision_is_active_with_materialized_tables",
            json!({"schema": tenant_a_schema, "expected_schema_hash": "stale"}),
        )?;
        assert_error(&stale_hash, "schema_revision_conflict");
        let mut future_schema = tenant_a_schema.clone();
        future_schema["version"] = json!("2026-08-05");
        assert_eq!(
            call!(
                &mut client,
                "kernel_schema_revision_is_active_with_materialized_tables",
                future_schema,
            )?,
            json!({"ok": true, "data": false})
        );

        let active_revision_id: i64 = client
            .query_one(
                "select id from schema_revision where app_id = 'admin_app' and customer_id = 'tenant_a' and activated_at is not null",
                &[],
            )
            .map_err(|error| error.to_string())?
            .get(0);
        let run = agent_run("tenant_a", "run-1", active_revision_id);
        let stored = call!(&mut client, "kernel_record_agent_run", run.clone())?;
        assert_eq!(stored["ok"], true);
        assert_eq!(stored["data"]["run_id"], "run-1");
        assert_eq!(
            call!(&mut client, "kernel_record_agent_run", run.clone())?,
            stored
        );
        let mut null_actor_run = agent_run("tenant_a", "run-null-actor", active_revision_id);
        null_actor_run["actor_id"] = Value::Null;
        let null_actor_stored = call!(
            &mut client,
            "kernel_record_agent_run",
            null_actor_run.clone()
        )?;
        assert_eq!(
            call!(&mut client, "kernel_record_agent_run", null_actor_run)?,
            null_actor_stored,
            "a null actor must replay idempotently"
        );
        let mut conflicting_run = run.clone();
        conflicting_run["execution_profile_id"] = json!("other-profile");
        assert_error(
            &call!(&mut client, "kernel_record_agent_run", conflicting_run)?,
            "agent_run_conflict",
        );
        let stale_run = call!(
            &mut client,
            "kernel_record_agent_run",
            agent_run("tenant_a", "run-stale", active_revision_id + 1),
        )?;
        assert_error(&stale_run, "stale_schema_revision");
        let tenant_isolation = call!(
            &mut client,
            "kernel_update_agent_run_status",
            json!({
                "app_id": "admin_app", "customer_id": "tenant_b", "run_id": "run-1",
                "status": "completed"
            }),
        )?;
        assert_error(&tenant_isolation, "agent_run_missing");

        let completed = call!(
            &mut client,
            "kernel_update_agent_run_status",
            json!({
                "app_id": "admin_app", "customer_id": "tenant_a", "run_id": "run-1",
                "status": "completed",
                "model_calls": [{"step": 2}],
                "token_usage": {"input_tokens": 99, "output_tokens": 4},
                "final_outputs": {"status": "completed", "text": "done"}
            }),
        )?;
        assert_eq!(completed["data"], stored["data"]);
        let evidence: (String, Value, Value, Value) = {
            let row = client
                .query_one(
                    "select status, model_calls, token_usage, final_outputs from agent_run where app_id = 'admin_app' and customer_id = 'tenant_a' and run_id = 'run-1'",
                    &[],
                )
                .map_err(|error| error.to_string())?;
            (row.get(0), row.get(1), row.get(2), row.get(3))
        };
        assert_eq!(evidence.0, "completed");
        assert_eq!(evidence.1, json!([{"step": 1}, {"step": 2}]));
        assert_eq!(evidence.2, json!({"input_tokens": 1, "output_tokens": 4}));
        assert_eq!(evidence.3, json!({"status": "recorded", "text": "done"}));
        let idempotent = call!(
            &mut client,
            "kernel_update_agent_run_status",
            json!({
                "app_id": "admin_app", "customer_id": "tenant_a", "run_id": "run-1",
                "status": "completed"
            }),
        )?;
        assert_eq!(idempotent["data"], stored["data"]);
        let invalid_transition = call!(
            &mut client,
            "kernel_update_agent_run_status",
            json!({
                "app_id": "admin_app", "customer_id": "tenant_a", "run_id": "run-1",
                "status": "runtime_error"
            }),
        )?;
        assert_error(&invalid_transition, "agent_run_conflict");
        let status: String = client
            .query_one(
                "select status from agent_run where app_id = 'admin_app' and customer_id = 'tenant_a' and run_id = 'run-1'",
                &[],
            )
            .map_err(|error| error.to_string())?
            .get(0);
        assert_eq!(status, "completed");
        Ok::<_, String>(())
    })();

    client.batch_execute("rollback").ok();
    client
        .batch_execute(&format!("drop schema \"{database_schema}\" cascade"))
        .expect("drop isolated SQL admin schema");
    result.expect("generated SQL admin runtime parity");
}

fn agent_run(customer_id: &str, run_id: &str, schema_revision_id: i64) -> Value {
    json!({
        "app_id": "admin_app",
        "customer_id": customer_id,
        "run_id": run_id,
        "status": "recorded",
        "schema_revision_id": schema_revision_id,
        "actor_id": "actor-1",
        "agent_identity_id": "agent-1",
        "execution_profile_id": "profile-1",
        "source_artifacts": [{"artifact": "input"}],
        "alignment_decisions": [],
        "model_calls": [{"step": 1}],
        "tool_calls": [],
        "token_usage": {"input_tokens": 1},
        "validation_failures": [],
        "final_outputs": {"status": "recorded"},
        "approval_boundaries": [],
        "compiled_preview_ids": ["preview-1"]
    })
}

fn assert_error(result: &Value, code: &str) {
    assert_eq!(result["ok"], false, "unexpected result: {result}");
    assert_eq!(result["error"]["code"], code, "unexpected result: {result}");
}

fn test_database_url() -> Option<String> {
    match env::var("KERNEL_TEST_DATABASE_URL") {
        Ok(url) => Some(url),
        Err(env::VarError::NotPresent) => {
            eprintln!("skipping SQL admin runtime test: KERNEL_TEST_DATABASE_URL is absent");
            None
        }
        Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
    }
}
