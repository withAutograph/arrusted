#[path = "support/trusted_human.rs"]
mod trusted_human;
use std::env;

use kernel::{
    connect_postgres, AppId, ChangeSetDiff, ChangeSetDiffRequest, CustomerId, EnumOption,
    EnumOptionId, Field, FieldHistoryEntry, FieldHistoryRequest, FieldId, FieldType, Model,
    ModelId, ModelKind, Schema, SchemaVersion,
};
use schema_compiler::{
    compile_sql_artifact_manifest, render_sql_artifact_bundle, CompiledManifest,
    NormalizedManifestExtras, SqlArtifactKind,
};
use serde_json::{json, Value};
use uuid::Uuid;

macro_rules! call {
    ($client:expr, $function:expr, $request:expr $(,)?) => {{
        let statement = match $function {
            "kernel_read_visible_records" => "select kernel_read_visible_records($1::jsonb)",
            "kernel_read_visible_record" => "select kernel_read_visible_record($1::jsonb)",
            "kernel_read_visible_records_by_model" => {
                "select kernel_read_visible_records_by_model($1::jsonb)"
            }
            "kernel_read_visible_records_by_text_fields" => {
                "select kernel_read_visible_records_by_text_fields($1::jsonb)"
            }
            "kernel_read_visible_record_for_update" => {
                "select kernel_read_visible_record_for_update($1::jsonb)"
            }
            "kernel_query_visible_sql" => "select kernel_query_visible_sql($1::jsonb)",
            "kernel_change_set_diff" => "select kernel_change_set_diff($1::jsonb)",
            "kernel_field_history" => "select kernel_field_history($1::jsonb)",
            "kernel_recent_activity" => "select kernel_recent_activity($1::jsonb)",
            _ => panic!("unsupported generated read test function"),
        };
        $client
            .query_one(statement, &[&$request])
            .map_err(|error| format!("{statement}: {error:?}"))?
            .try_get::<_, Value>(0)
            .map_err(|error| format!("{statement}: {error:?}"))
    }};
}

macro_rules! temp_view_count {
    ($client:expr) => {{
        $client
            .query_one(
                "select count(*) from pg_class where relkind = 'v' and relnamespace = pg_my_temp_schema()",
                &[],
            )
            .map_err(|error| error.to_string())?
            .get::<_, i64>(0)
    }};
}

fn compiled_schema() -> CompiledManifest {
    let field = |id: &str, field_type: FieldType| Field {
        id: FieldId::from(id),
        label: id.to_string(),
        field_type,
        required: false,
        is_unique: false,
        target_model: None,
        option_set: vec![],
        ..Default::default()
    };
    let mut status = field("status", FieldType::Enum);
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
    CompiledManifest {
        schema: Schema {
            app_id: AppId::from("read_app"),
            customer_id: CustomerId::from("tenant_a"),
            version: SchemaVersion::from("2026-08-04"),
            models: vec![
                Model {
                    id: ModelId::from("company"),
                    kind: ModelKind::Entity,
                    label: "Company".to_string(),
                    fields: vec![
                        field("name", FieldType::Text),
                        field("score", FieldType::Number),
                        field("observed_at", FieldType::Datetime),
                        field("rate", FieldType::MoneyRate),
                        status,
                    ],
                    ..Default::default()
                },
                Model {
                    id: ModelId::from("region"),
                    kind: ModelKind::Lookup,
                    label: "Region".to_string(),
                    display_field_id: Some(FieldId::from("name")),
                    fields: vec![Field {
                        required: true,
                        ..field("name", FieldType::Text)
                    }],
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

#[test]
fn read_runtime_artifacts_cover_the_family_and_same_day_authority() {
    let manifest = compile_sql_artifact_manifest(&compiled_schema()).unwrap();
    let functions = manifest
        .artifacts
        .iter()
        .filter(|artifact| artifact.kind == SqlArtifactKind::Function)
        .collect::<Vec<_>>();
    for signature in [
        "kernel_read_visible_records(jsonb)",
        "kernel_read_visible_record(jsonb)",
        "kernel_read_visible_records_by_model(jsonb)",
        "kernel_read_visible_records_by_text_fields(jsonb)",
        "kernel_read_visible_record_for_update(jsonb)",
        "kernel_query_visible_sql(jsonb)",
        "kernel_change_set_diff(jsonb)",
        "kernel_field_history(jsonb)",
        "kernel_recent_activity(jsonb)",
    ] {
        let function = functions
            .iter()
            .find(|artifact| artifact.name == signature)
            .unwrap_or_else(|| panic!("missing generated read function {signature}"));
        assert!(function.sql.contains("'ok'"));
        assert!(!function.sql.contains("_result("));
    }
    let family_sql = functions
        .iter()
        .filter(|artifact| {
            artifact.name.starts_with("kernel_read_")
                || [
                    "kernel_query_visible_sql(jsonb)",
                    "kernel_change_set_diff(jsonb)",
                    "kernel_field_history(jsonb)",
                    "kernel_recent_activity(jsonb)",
                ]
                .contains(&artifact.name.as_str())
        })
        .map(|artifact| artifact.sql.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(family_sql.contains("v.effective_start desc"));
    assert!(family_sql.contains("v.tombstones_record desc"));
    assert!(family_sql.contains("v.untombstones_record desc"));
    assert!(family_sql.contains("cs.applied_order desc"));
    assert!(family_sql.contains("v.id desc"));
    assert!(!family_sql.contains("v.created_at desc"));
    assert!(!family_sql.contains("kernel_read_query_param_literal"));
    assert!(!family_sql.contains("kernel_read_query_sql_with_literals"));

    let grouped_read = functions
        .iter()
        .find(|artifact| artifact.name == "kernel_read_visible_records_by_model(jsonb)")
        .expect("generated grouped read boundary");
    assert!(grouped_read.sql.contains("limit_per_model"));
    assert!(grouped_read
        .sql
        .contains("limit_per_model must be a positive integer"));
    assert!(grouped_read
        .sql
        .contains("'limit', request->'limit_per_model'"));

    let query_function = functions
        .iter()
        .find(|artifact| artifact.name == "kernel_query_visible_sql(jsonb)")
        .expect("generated query boundary");
    assert!(query_function
        .sql
        .contains("arbitrary SQL requires the generated same-session query protocol"));
    for unsafe_fragment in [
        "execute ",
        "set_config(",
        "set local role",
        "grant select",
        "create role",
        "create temp",
        "pg_temp",
        "statement_timeout",
        "transaction_read_only",
        "work_mem",
        "kernel_read_scope_schema",
    ] {
        assert!(
            !query_function
                .sql
                .to_ascii_lowercase()
                .contains(unsafe_fragment),
            "query boundary must not contain `{unsafe_fragment}`"
        );
    }
    for removed_helper in [
        "kernel_read_drop_query_temp_views()",
        "kernel_read_query_param_literal(jsonb)",
        "kernel_read_query_sql_with_literals(text,jsonb)",
        "kernel_read_query_plan_references_catalog(jsonb,text[])",
    ] {
        assert!(
            functions
                .iter()
                .all(|artifact| artifact.name != removed_helper),
            "unsafe direct-query helper `{removed_helper}` must not be emitted"
        );
    }

    let identifier_function = functions
        .iter()
        .find(|artifact| artifact.name == "kernel_read_physical_identifier(text)")
        .expect("generated identifier boundary");
    assert!(!identifier_function.sql.contains("sha256"));
    assert!(identifier_function
        .sql
        .contains("kernel_physical_identifier(logical_id)"));
}

#[test]
fn direct_sql_query_boundary_rejects_without_executing_or_provisioning() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let manifest = compile_sql_artifact_manifest(&compiled_schema()).unwrap();
    let function_sql = |signature: &str| {
        manifest
            .artifacts
            .iter()
            .find(|artifact| {
                artifact.kind == SqlArtifactKind::Function && artifact.name == signature
            })
            .unwrap_or_else(|| panic!("missing generated function {signature}"))
            .sql
            .as_str()
    };
    let mut client = connect_postgres(&database_url).expect("connect to test PostgreSQL");
    let database_schema = format!("kernel_sql_query_boundary_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            "create schema \"{database_schema}\"; set search_path to \"{database_schema}\";\n{};\n{};\n{};\n{};\n{};",
            function_sql("kernel_physical_identifier(text)"),
            function_sql("kernel_cleanup_generated_visible_query()"),
            function_sql("kernel_read_error_envelope(text,text)"),
            function_sql("kernel_read_physical_identifier(text)"),
            function_sql("kernel_query_visible_sql(jsonb)"),
        ))
        .expect("install isolated query boundary");
    trusted_human::before_install(&mut client);

    let result = (|| {
        let before: Option<String> = client
            .query_one(
                "select current_setting('kernel.query_protocol_probe', true)",
                &[],
            )
            .map_err(|error| error.to_string())?
            .get(0);
        let rejected = call!(
            &mut client,
            "kernel_query_visible_sql",
            json!({
                "app_id": "read_app",
                "customer_id": "tenant_a",
                "sql": "select set_config('kernel.query_protocol_probe', 'executed', false)",
                "params": [{"type": "text", "value": "ignored"}],
                "statement_timeout_ms": 5000
            }),
        )?;
        assert_error(&rejected, "query_rejected");
        assert_eq!(
            rejected["error"]["message"],
            "arbitrary SQL requires the generated same-session query protocol"
        );
        let after: Option<String> = client
            .query_one(
                "select current_setting('kernel.query_protocol_probe', true)",
                &[],
            )
            .map_err(|error| error.to_string())?
            .get(0);
        assert_eq!(after, before, "rejected SQL must not execute");
        for removed_helper in [
            "kernel_read_drop_query_temp_views()",
            "kernel_read_query_param_literal(jsonb)",
            "kernel_read_query_sql_with_literals(text,jsonb)",
            "kernel_read_query_plan_references_catalog(jsonb,text[])",
        ] {
            let installed: Option<String> = client
                .query_one("select to_regprocedure($1)::text", &[&removed_helper])
                .map_err(|error| error.to_string())?
                .get(0);
            assert_eq!(installed, None, "unsafe helper must not be installed");
        }

        let overlength_identifier = "a".repeat(64);
        let identifier_row = client
            .query_one(
                "select kernel_read_physical_identifier($1), kernel_physical_identifier($1)",
                &[&overlength_identifier],
            )
            .expect("derive the compiler-compatible overlength identifier");
        assert_eq!(
            identifier_row.get::<_, String>(0),
            identifier_row.get::<_, String>(1)
        );
        Ok::<_, String>(())
    })();

    trusted_human::drop_fixture(&mut client, &database_schema)
        .expect("drop isolated query boundary schema");
    result.expect("generated query boundary rejects direct execution");
}

#[test]
fn custom_enum_projection_follows_the_active_option_set_revision() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let manifest = compile_sql_artifact_manifest(&compiled_schema()).unwrap();
    let function_sql = |signature: &str| {
        manifest
            .artifacts
            .iter()
            .find(|artifact| {
                artifact.kind == SqlArtifactKind::Function && artifact.name == signature
            })
            .unwrap_or_else(|| panic!("missing generated function {signature}"))
            .sql
            .as_str()
    };
    let mut client = connect_postgres(&database_url).expect("connect to test PostgreSQL");
    let database_schema = format!("kernel_sql_custom_enum_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            r#"
            create schema "{database_schema}";
            set search_path to "{database_schema}";
            create table schema_revision (
              app_id text not null,
              customer_id text not null,
              schema jsonb not null,
              activated_at timestamptz
            );
            create table kernel_principal_scope (
              principal_name name not null,
              capability text not null,
              app_id text not null,
              customer_id text not null,
              actor_id text,
              active boolean not null default true
            );
            {};
            {};
            {};
            {};
            "#,
            function_sql("kernel_installer_capability_role(text)"),
            function_sql("kernel_principal_scope_authorized(text,text,text,text)"),
            function_sql("kernel_read_scope_schema(text,text)"),
            function_sql("kernel_read_custom_fields(jsonb,text,jsonb)"),
        ))
        .expect("install isolated custom-field projection");
    trusted_human::before_install(&mut client);
    establish_generated_execution_owner(&mut client)
        .expect("establish generated execution-owner identity");

    let result = (|| {
        let entries = json!([
            {"field_id": "shirt_size", "type": "enum", "value": "large"},
            {"field_id": "nickname", "type": "text", "value": "Al"}
        ]);
        let schema_with_large = json!({
            "custom_fields": [{
                "id": "employee_shirt_size",
                "model_id": "employee",
                "field_id": "shirt_size",
                "label": "Shirt size",
                "type": "enum",
                "option_set": [
                    {"id": "small", "label": "Small", "aliases": []},
                    {"id": "large", "label": "Large", "aliases": []}
                ],
                "archived_at": null
            }]
        });
        let schema_without_large = json!({
            "custom_fields": [{
                "id": "employee_shirt_size",
                "model_id": "employee",
                "field_id": "shirt_size",
                "label": "Shirt size",
                "type": "enum",
                "option_set": [{"id": "small", "label": "Small", "aliases": []}],
                "archived_at": null
            }]
        });
        let archived_definition = json!({
            "custom_fields": [{
                "id": "employee_shirt_size",
                "model_id": "employee",
                "field_id": "shirt_size",
                "label": "Shirt size",
                "type": "enum",
                "option_set": [{"id": "small", "label": "Small", "aliases": []}],
                "archived_at": "2026-08-04T00:00:00Z"
            }]
        });
        client
            .execute(
                "insert into schema_revision values ('read_app', 'tenant_a', $1, now())",
                &[&schema_with_large],
            )
            .map_err(|error| error.to_string())?;
        let project_active = |client: &mut postgres::Client, values: &Value| {
            client
                .query_one(
                    "select kernel_read_custom_fields(kernel_read_scope_schema('read_app', 'tenant_a'), 'employee', $1::jsonb)",
                    &[values],
                )
                .map(|row| row.get::<_, Value>(0))
                .map_err(|error| error.to_string())
        };
        let project_schema = |client: &mut postgres::Client, schema: &Value, values: &Value| {
            client
                .query_one(
                    "select kernel_read_custom_fields($1::jsonb, 'employee', $2::jsonb)",
                    &[schema, values],
                )
                .map(|row| row.get::<_, Value>(0))
                .map_err(|error| error.to_string())
        };

        assert_eq!(project_active(&mut client, &entries)?, entries);
        client
            .execute(
                "update schema_revision set activated_at = null where app_id = 'read_app' and customer_id = 'tenant_a' and activated_at is not null",
                &[],
            )
            .map_err(|error| error.to_string())?;
        client
            .execute(
                "insert into schema_revision values ('read_app', 'tenant_a', $1, now())",
                &[&schema_without_large],
            )
            .map_err(|error| error.to_string())?;
        assert_eq!(
            project_active(&mut client, &entries)?,
            json!([{"field_id": "nickname", "type": "text", "value": "Al"}])
        );
        assert_eq!(
            project_schema(&mut client, &json!({"custom_fields": []}), &entries)?,
            entries
        );
        assert_eq!(
            project_schema(&mut client, &archived_definition, &entries)?,
            entries
        );
        assert_eq!(
            project_schema(&mut client, &schema_without_large, &json!([]))?,
            json!([])
        );
        Ok::<_, String>(())
    })();

    trusted_human::drop_fixture(&mut client, &database_schema)
        .expect("drop isolated custom-field projection schema");
    result.expect("custom enum projection follows active option revisions");
}

#[test]
fn generated_reads_queries_locks_and_audit_outputs_match_postgres_contracts() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let compiled = compiled_schema();
    let bundle = render_sql_artifact_bundle(&compile_sql_artifact_manifest(&compiled).unwrap());
    let mut client = connect_postgres(&database_url).expect("connect to test PostgreSQL");
    let database_schema = format!("kernel_sql_reads_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            "create schema \"{database_schema}\"; set search_path to \"{database_schema}\""
        ))
        .expect("create isolated read schema");
    trusted_human::before_install(&mut client);

    let result = (|| {
        client
            .batch_execute(&bundle)
            .map_err(|error| format!("bundle install: {error:?}"))?;
        crate::seed_fixture!(&mut client, &compiled.schema)
            .map_err(|error| format!("fixture seed: {error}"))?;

        let visible = call!(
            &mut client,
            "kernel_read_visible_records",
            json!({
                "app_id": "read_app", "customer_id": "tenant_a",
                "model_id": "company", "as_of": "2026-08-04"
            }),
        )?;
        assert_eq!(visible["ok"], true);
        assert_eq!(visible["data"].as_array().unwrap().len(), 1);
        assert_eq!(visible["data"][0]["values"]["name"]["value"], "Beta");
        assert_eq!(visible["data"][0]["values"]["score"]["value"], "20");
        assert_eq!(
            visible["data"][0]["values"]["observed_at"]["value"],
            "2026-08-04T11:00:00Z"
        );
        assert_eq!(
            visible["data"][0]["values"]["rate"]["value"]["amount"],
            "125"
        );

        let one = call!(
            &mut client,
            "kernel_read_visible_record",
            json!({
                "app_id": "read_app", "customer_id": "tenant_a", "model_id": "company",
                "record_id": "00000000-0000-0000-0000-000000000101", "as_of": "2026-08-04"
            }),
        )?;
        assert_eq!(one["data"]["values"]["name"]["value"], "Beta");
        let filtered = call!(
            &mut client,
            "kernel_read_visible_records_by_text_fields",
            json!({
                "app_id": "read_app", "customer_id": "tenant_a", "model_id": "company",
                "as_of": "2026-08-04", "field_filters": {"name": "Beta"}
            }),
        )?;
        assert_eq!(filtered["data"].as_array().unwrap().len(), 1);
        let rejected_filter = call!(
            &mut client,
            "kernel_read_visible_records_by_text_fields",
            json!({
                "app_id": "read_app", "customer_id": "tenant_a", "model_id": "company",
                "as_of": "2026-08-04", "field_filters": {"score": "20"}
            }),
        )?;
        assert_error(&rejected_filter, "record_target_missing");

        let by_model = call!(
            &mut client,
            "kernel_read_visible_records_by_model",
            json!({
                "app_id": "read_app", "customer_id": "tenant_a", "as_of": "2026-08-04",
                "model_ids": ["company", "region"],
                "fields_by_model": {"company": ["name"]},
                "record_ids_by_model": {"company": ["00000000-0000-0000-0000-000000000101"]}
            }),
        )?;
        assert_eq!(
            by_model["data"]["company"][0]["values"]["name"]["value"],
            "Beta"
        );
        assert!(by_model["data"]["company"][0]["values"]
            .get("score")
            .is_none());
        assert_eq!(by_model["data"]["region"], json!([]));

        let diff = call!(
            &mut client,
            "kernel_change_set_diff",
            json!({
                "app_id": "read_app", "customer_id": "tenant_a", "change_set_id": 102,
                "project": ["name", "score"]
            }),
        )?;
        assert_eq!(diff["ok"], true, "unexpected diff result: {diff}");
        assert_eq!(
            diff["data"]["records"][0]["fields"][0]["before"]["value"],
            "Alpha"
        );
        assert_eq!(
            diff["data"]["records"][0]["fields"][0]["after"]["value"],
            "Beta"
        );

        let history = call!(
            &mut client,
            "kernel_field_history",
            json!({
                "app_id": "read_app", "customer_id": "tenant_a", "model_id": "company",
                "record_id": "00000000-0000-0000-0000-000000000101",
                "field_id": "name", "limit": 2
            }),
        )?;
        assert_eq!(history["data"][0]["value"]["value"], "Alpha");
        assert_eq!(history["data"][1]["value"]["value"], "Beta");
        assert_eq!(history["data"][0]["actor_id"], "actor-a");
        assert_eq!(history["data"][0]["source_kind"], "fixture");
        assert_eq!(history["data"][0]["source_ref"], "source-a");
        assert_eq!(history["data"][0]["notes"], "first");
        assert_eq!(history["data"][0]["applied_at"], "2026-08-04T12:00:00Z");
        assert_eq!(history["data"][0]["tombstones_record"], false);
        assert_eq!(history["data"][0]["untombstones_record"], false);
        assert_eq!(history["data"][1]["actor_id"], "actor-b");
        let typed: Vec<FieldHistoryEntry> = serde_json::from_value(history["data"].clone())
            .map_err(|error| format!("history entries decode: {error}"))?;
        assert_eq!(typed[1].source_ref.as_deref(), Some("source-b"));

        let activity = call!(
            &mut client,
            "kernel_recent_activity",
            json!({"app_id": "read_app", "customer_id": "tenant_a", "limit": 2}),
        )?;
        assert_eq!(activity["data"][0]["change_set_id"], 102);
        assert_eq!(activity["data"][0]["touched_record_count"], 3);
        assert_eq!(activity["data"][0]["source_kind"], "fixture");

        let rejected_query = call!(
            &mut client,
            "kernel_query_visible_sql",
            json!({
                "app_id": "read_app", "customer_id": "tenant_a", "as_of": "2026-08-04",
                "sql": "select name, score::text as score from company_version where name = $1 order by name",
                "params": [{"type": "text", "value": "Beta"}]
            }),
        )?;
        assert_error(&rejected_query, "query_rejected");
        assert_eq!(
            rejected_query["error"]["message"],
            "arbitrary SQL requires the generated same-session query protocol"
        );
        assert_eq!(temp_view_count!(&mut client), 0);

        let overlength_identifier = "a".repeat(64);
        let identifier_row = client
            .query_one(
                "select kernel_read_physical_identifier($1), kernel_physical_identifier($1)",
                &[&overlength_identifier],
            )
            .map_err(|error| error.to_string())?;
        assert_eq!(
            identifier_row.get::<_, String>(0),
            identifier_row.get::<_, String>(1)
        );

        for unsafe_sql in [
            "select * from pg_catalog.pg_class",
            "select set_config('kernel.customer_id', 'tenant_b', true)",
            "select 1; select 2",
            "delete from company_record returning id",
        ] {
            let rejected = call!(
                &mut client,
                "kernel_query_visible_sql",
                json!({
                    "app_id": "read_app", "customer_id": "tenant_a", "sql": unsafe_sql
                }),
            )?;
            assert_error(&rejected, "query_rejected");
            assert_eq!(temp_view_count!(&mut client), 0);
        }

        let tenant_b = call!(
            &mut client,
            "kernel_read_visible_records",
            json!({
                "app_id": "read_app", "customer_id": "tenant_b",
                "model_id": "company", "as_of": "2026-08-04"
            }),
        )?;
        assert_eq!(tenant_b["data"].as_array().unwrap().len(), 1);
        assert_eq!(
            tenant_b["data"][0]["values"]["name"]["value"],
            "Other Tenant"
        );

        let second_record_id = Uuid::new_v4();
        let second_apply = client
            .query_one(
                "select kernel_apply_change_set($1::jsonb)",
                &[&json!({
                    "app_id": "read_app", "customer_id": "tenant_a",
                    "actor_id": "fixture", "source_kind": "fixture",
                    "idempotency_key": "grouped-limit-second-company", "mode": "mainline",
                    "writes": [{
                        "model_id": "company", "new_record_id": second_record_id,
                        "effective_start": "2026-08-04",
                        "values": {"name": {"type": "text", "value": "Zulu"}}
                    }]
                })],
            )
            .map_err(|error| error.to_string())?
            .get::<_, Value>(0);
        assert_eq!(second_apply["ok"], true, "{second_apply:#}");

        let grouped = call!(
            &mut client,
            "kernel_read_visible_records_by_model",
            json!({
                "app_id": "read_app", "customer_id": "tenant_a", "as_of": "2026-08-04",
                "model_ids": ["company", "region"], "limit_per_model": 1
            }),
        )?;
        assert_eq!(grouped["ok"], true, "{grouped:#}");
        assert_eq!(grouped["data"]["company"].as_array().unwrap().len(), 1);
        assert_eq!(grouped["data"]["region"].as_array().unwrap().len(), 0);
        assert_eq!(
            grouped["data"]["company"][0]["record_id"],
            "00000000-0000-0000-0000-000000000101"
        );

        for invalid_limit in [json!(0), json!(-1), json!(1.5), json!("1")] {
            let rejected = call!(
                &mut client,
                "kernel_read_visible_records_by_model",
                json!({
                    "app_id": "read_app", "customer_id": "tenant_a",
                    "as_of": "2026-08-04", "model_ids": ["company"],
                    "limit_per_model": invalid_limit
                }),
            )?;
            assert_error(&rejected, "contract_validation_failed");
        }

        let malformed = call!(&mut client, "kernel_read_visible_records", json!([]))?;
        assert_error(&malformed, "contract_validation_failed");
        crate::assert_record_lock!(&database_url, &database_schema)
            .map_err(|error| format!("record lock: {error}"))?;
        Ok::<_, String>(())
    })();

    let _ = client.batch_execute("rollback");
    trusted_human::drop_fixture(&mut client, &database_schema).expect("drop isolated read schema");
    result.expect("generated read runtime parity fixture");
}

#[test]
fn field_history_entries_carry_attribution_lifecycle_and_revert_marks() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let compiled = compiled_schema();
    let bundle = render_sql_artifact_bundle(&compile_sql_artifact_manifest(&compiled).unwrap());
    let mut client = connect_postgres(&database_url).expect("connect to test PostgreSQL");
    let database_schema = format!("kernel_sql_history_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            "create schema \"{database_schema}\"; set search_path to \"{database_schema}\""
        ))
        .expect("create isolated history schema");
    trusted_human::before_install(&mut client);

    let result = (|| {
        client
            .batch_execute(&bundle)
            .map_err(|error| format!("bundle install: {error:?}"))?;
        crate::seed_fixture!(&mut client, &compiled.schema)
            .map_err(|error| format!("fixture seed: {error}"))?;
        client
            .batch_execute(
                r#"
                set kernel.app_id = 'read_app'; set kernel.customer_id = 'tenant_a';
                insert into lookup_storage_authority(
                  app_id,customer_id,model_id,schema_hash,authority,activated_at,
                  legacy_record_table,legacy_version_table
                ) values('read_app','tenant_a','region',repeat('a',64),'generic',now(),
                  'region_record','region_version');
                "#,
            )
            .map_err(|error| format!("lookup authority: {error:?}"))?;
        let mut run = |function: &str, request: Value| -> Result<Value, String> {
            if let Some(actor) = request["actor_id"].as_str() {
                trusted_human::select(&mut client, actor);
            }
            let value = client
                .query_one(&format!("select {function}($1::jsonb)"), &[&request])
                .map_err(|error| format!("{function}: {error:?}"))?
                .get::<_, Value>(0);
            if value["ok"] != true {
                return Err(format!("{function} failed: {value:#}"));
            }
            Ok(value["data"].clone())
        };
        let company = Uuid::new_v4();
        let region = Uuid::new_v4();
        let name_write = |subject: Uuid, create: bool, date: &str, name: &str| {
            let mut write = json!({
                "model_id": "company", "effective_start": date,
                "values": {"name": {"type": "text", "value": name}}
            });
            if create {
                write["new_record_id"] = json!(subject);
            } else {
                write["record_key"] = json!({"type": "record_id", "value": subject});
            }
            write
        };
        let envelope = |key: &str, extra: Value, writes: Value| {
            let mut apply = json!({
                "app_id": "read_app", "customer_id": "tenant_a", "mode": "mainline",
                "actor_id": "importer", "source_kind": "import",
                "idempotency_key": key, "writes": writes
            });
            for (field, value) in extra.as_object().unwrap() {
                apply[field] = value.clone();
            }
            apply
        };

        run(
            "kernel_apply_change_set",
            envelope(
                "history-import",
                json!({"source_ref": "payroll.csv", "notes": "initial load"}),
                json!([name_write(company, true, "2026-01-01", "Acme")]),
            ),
        )?;
        run(
            "kernel_record_agent_run",
            json!({
                "app_id": "read_app", "customer_id": "tenant_a", "run_id": "history-run",
                "agent_identity_id": "fixture", "execution_profile_id": "fixture"
            }),
        )?;
        run(
            "kernel_apply_change_set",
            envelope(
                "history-agent",
                json!({"actor_id": "alice", "source_kind": "agent", "source_ref": "history-run"}),
                json!([name_write(company, false, "2026-02-01", "Acme Corp")]),
            ),
        )?;
        let tombstone = run(
            "kernel_apply_change_set",
            envelope(
                "history-tombstone",
                json!({"actor_id": "alice", "source_kind": "ui"}),
                json!([{
                    "model_id": "company", "effective_start": "2026-03-01",
                    "record_key": {"type": "record_id", "value": company},
                    "tombstones_record": true
                }]),
            ),
        )?;
        // The generated runtime restores a deleted record by reverting the
        // tombstone; apply never writes `untombstones_record` rows.
        let restore = run(
            "kernel_revert_change_set",
            json!({
                "app_id": "read_app", "customer_id": "tenant_a",
                "change_set_id": tombstone["id"], "actor_id": "carol",
                "idempotency_key": "history-restore"
            }),
        )?;
        let mistaken = run(
            "kernel_apply_change_set",
            envelope(
                "history-mistake",
                json!({"actor_id": "bob", "source_kind": "ui"}),
                json!([name_write(company, false, "2026-05-01", "Mistake")]),
            ),
        )?;
        let revert = run(
            "kernel_revert_change_set",
            json!({
                "app_id": "read_app", "customer_id": "tenant_a",
                "change_set_id": mistaken["id"], "actor_id": "carol",
                "idempotency_key": "history-revert"
            }),
        )?;
        run(
            "kernel_apply_change_set",
            envelope(
                "history-draft",
                json!({"actor_id": "dana", "source_kind": "ui", "mode": "draft"}),
                json!([name_write(company, false, "2026-06-01", "Draft Only")]),
            ),
        )?;

        let history = run(
            "kernel_field_history",
            json!({
                "app_id": "read_app", "customer_id": "tenant_a", "model_id": "company",
                "record_id": company, "field_id": "name"
            }),
        )?;
        let entries: Vec<FieldHistoryEntry> = serde_json::from_value(history.clone())
            .map_err(|error| format!("history decode: {error}: {history:#}"))?;
        let observed: Vec<_> = entries
            .iter()
            .map(|entry| {
                (
                    entry.effective_start.to_string(),
                    format!("{:?}", entry.stage),
                    entry.source_kind.clone(),
                    entry.source_ref.clone(),
                    entry.actor_id.clone(),
                    entry.tombstones_record,
                    entry.untombstones_record,
                )
            })
            .collect();
        let row =
            |date: &str, stage: &str, kind: &str, source: Option<&str>, actor: &str, tomb: bool| {
                (
                    date.to_string(),
                    stage.to_string(),
                    kind.to_string(),
                    source.map(str::to_string),
                    Some(actor.to_string()),
                    tomb,
                    false,
                )
            };
        assert_eq!(
            observed,
            vec![
                row(
                    "2026-01-01",
                    "Mainline",
                    "import",
                    Some("payroll.csv"),
                    "importer",
                    false
                ),
                row(
                    "2026-02-01",
                    "Mainline",
                    "agent",
                    Some("history-run"),
                    "alice",
                    false
                ),
                row("2026-03-01", "Reverted", "ui", None, "alice", true),
                row("2026-05-01", "Reverted", "ui", None, "bob", false),
            ],
            "drafts are excluded by default and every entry carries attribution"
        );
        assert_eq!(entries[0].notes.as_deref(), Some("initial load"));
        assert!(entries[2].value.is_none(), "a tombstone carries no value");
        assert_eq!(
            entries[2].reverted_by,
            Some(restore["id"].as_i64().unwrap())
        );
        assert_eq!(entries[3].reverted_by, Some(revert["id"].as_i64().unwrap()));
        assert!(
            entries.iter().all(|entry| entry.applied_at.is_some()),
            "reverted entries keep their change set's recorded time"
        );

        let drafts = run(
            "kernel_field_history",
            json!({
                "app_id": "read_app", "customer_id": "tenant_a", "model_id": "company",
                "record_id": company, "field_id": "name", "stages": ["draft"]
            }),
        )?;
        assert_eq!(drafts.as_array().map(Vec::len), Some(1));
        assert_eq!(drafts[0]["source_kind"], "ui");
        assert_eq!(drafts[0]["applied_at"], Value::Null);

        run(
            "kernel_apply_change_set",
            envelope(
                "history-region",
                json!({"source_ref": "regions.csv"}),
                json!([{
                    "model_id": "region", "new_record_id": region, "effective_start": "2026-01-01",
                    "values": {"name": {"type": "text", "value": "EMEA"}}
                }]),
            ),
        )?;
        let lookup_history = run(
            "kernel_field_history",
            json!({
                "app_id": "read_app", "customer_id": "tenant_a", "model_id": "region",
                "record_id": region, "field_id": "name"
            }),
        )?;
        assert_eq!(lookup_history[0]["value"]["value"], "EMEA");
        assert_eq!(lookup_history[0]["source_ref"], "regions.csv");
        assert_eq!(lookup_history[0]["tombstones_record"], false);
        Ok::<_, String>(())
    })();

    let _ = client.batch_execute("rollback");
    trusted_human::drop_fixture(&mut client, &database_schema)
        .expect("drop isolated history schema");
    result.expect("generated field history attribution fixture");
}

#[test]
fn generic_lookup_read_and_audit_surfaces_fail_closed_on_storage_authority() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let compiled = compiled_schema();
    let bundle = render_sql_artifact_bundle(&compile_sql_artifact_manifest(&compiled).unwrap());
    let mut client = connect_postgres(&database_url).expect("connect to test PostgreSQL");
    let version: i32 = client
        .query_one("show server_version_num", &[])
        .expect("read PostgreSQL version")
        .get::<_, String>(0)
        .parse()
        .expect("numeric PostgreSQL version");
    assert!(
        version >= 170_000,
        "read authority parity requires PostgreSQL 17"
    );
    let database_schema = format!("kernel_sql_read_authority_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            "create schema \"{database_schema}\"; set search_path to \"{database_schema}\""
        ))
        .expect("create isolated read-authority schema");
    trusted_human::before_install(&mut client);

    let result = (|| {
        client
            .batch_execute(&bundle)
            .map_err(|error| format!("bundle install: {error:?}"))?;
        crate::seed_fixture!(&mut client, &compiled.schema)
            .map_err(|error| format!("fixture seed: {error}"))?;

        let call_json = |client: &mut postgres::Client, function: &str, request: Value| {
            client
                .query_one(&format!("select {function}($1::jsonb)"), &[&request])
                .map(|row| row.get::<_, Value>(0))
                .map_err(|error| format!("call {function}: {error:?}"))
        };
        let set_authority = |client: &mut postgres::Client,
                             customer_id: &str,
                             model_id: &str,
                             authority: &str|
         -> Result<(), String> {
            client
                .query_one(
                    "select set_config('kernel.app_id','read_app',false),set_config('kernel.customer_id',$1,false)",
                    &[&customer_id],
                )
                .map_err(|error| error.to_string())?;
            client
                .execute(
                    r#"
                    insert into lookup_storage_authority(
                      app_id,customer_id,model_id,schema_hash,authority,
                      legacy_record_table,legacy_version_table
                    ) values('read_app',$1,$2,repeat('a',64),$3,$2 || '_record',$2 || '_version')
                    on conflict(app_id,customer_id,model_id) do update
                    set authority=excluded.authority,
                        activated_at=case when excluded.authority='generic' then now() else null end
                    "#,
                    &[&customer_id, &model_id, &authority],
                )
                .map_err(|error| error.to_string())?;
            Ok(())
        };
        let visible_request = json!({
            "app_id":"read_app","customer_id":"tenant_a","model_id":"region",
            "as_of":"2026-08-05"
        });
        let prepare_request = json!({
            "app_id":"read_app","customer_id":"tenant_a","as_of":"2026-08-05"
        });

        // Generic rows in another model and tenant must not affect an empty model in this scope.
        client
            .query_one(
                "select set_config('kernel.app_id','read_app',false),set_config('kernel.customer_id','tenant_a',false)",
                &[],
            )
            .map_err(|error| error.to_string())?;
        client
            .execute(
                "insert into lookup_record(id,app_id,customer_id,model_id,external_key) values($1,'read_app','tenant_a','unrelated_lookup','unrelated')",
                &[&Uuid::new_v4()],
            )
            .map_err(|error| error.to_string())?;
        let tenant_b_apply = call_json(
            &mut client,
            "kernel_apply_change_set",
            json!({
                "app_id":"read_app","customer_id":"tenant_b","actor_id":"fixture",
                "source_kind":"fixture","idempotency_key":"tenant-b-region","mode":"mainline",
                "writes":[{"model_id":"region","new_record_id":Uuid::new_v4(),
                  "effective_start":"2026-08-05","values":{"name":{"type":"text","value":"West"}}}]
            }),
        )?;
        assert_eq!(tenant_b_apply["ok"], true, "{tenant_b_apply:#}");
        assert_eq!(
            call_json(
                &mut client,
                "kernel_read_visible_records",
                visible_request.clone()
            )?["ok"],
            true
        );
        assert_eq!(
            call_json(
                &mut client,
                "kernel_prepare_visible_query",
                prepare_request.clone()
            )?["ok"],
            true
        );

        let region_record_id = Uuid::new_v4();
        let applied = call_json(
            &mut client,
            "kernel_apply_change_set",
            json!({
                "app_id":"read_app","customer_id":"tenant_a","actor_id":"fixture",
                "source_kind":"fixture","idempotency_key":"tenant-a-region","mode":"mainline",
                "writes":[{"model_id":"region","new_record_id":region_record_id,
                  "effective_start":"2026-08-05","values":{"name":{"type":"text","value":"East"}}}]
            }),
        )?;
        assert_eq!(applied["ok"], true, "{applied:#}");
        let change_set_id = applied["data"]["id"]
            .as_i64()
            .expect("lookup change set id");
        let diff_request = json!({
            "app_id":"read_app","customer_id":"tenant_a","change_set_id":change_set_id
        });
        let history_request = json!({
            "app_id":"read_app","customer_id":"tenant_a","model_id":"region",
            "record_id":region_record_id,"field_id":"name"
        });
        let activity_request = json!({"app_id":"read_app","customer_id":"tenant_a"});
        let by_model_request = json!({
            "app_id":"read_app","customer_id":"tenant_a","as_of":"2026-08-05",
            "model_ids":["region"]
        });

        for (function, request) in [
            ("kernel_read_visible_records", visible_request.clone()),
            (
                "kernel_read_visible_records_by_model",
                by_model_request.clone(),
            ),
            ("kernel_change_set_diff", diff_request.clone()),
            ("kernel_field_history", history_request.clone()),
            ("kernel_recent_activity", activity_request.clone()),
            ("kernel_prepare_visible_query", prepare_request.clone()),
        ] {
            assert_error(
                &call_json(&mut client, function, request)?,
                "lookup_storage_authority_mismatch",
            );
        }

        set_authority(&mut client, "tenant_a", "region", "generic")?;
        for (function, request) in [
            ("kernel_read_visible_records", visible_request.clone()),
            (
                "kernel_read_visible_records_by_model",
                by_model_request.clone(),
            ),
            ("kernel_change_set_diff", diff_request.clone()),
            ("kernel_field_history", history_request.clone()),
            ("kernel_recent_activity", activity_request.clone()),
            ("kernel_prepare_visible_query", prepare_request.clone()),
        ] {
            let response = call_json(&mut client, function, request)?;
            assert_eq!(response["ok"], true, "{function}: {response:#}");
        }

        set_authority(&mut client, "tenant_a", "unrelated_lookup", "typed")?;
        set_authority(&mut client, "tenant_b", "region", "typed")?;
        assert_eq!(
            call_json(
                &mut client,
                "kernel_read_visible_records",
                visible_request.clone()
            )?["ok"],
            true
        );
        assert_eq!(
            call_json(
                &mut client,
                "kernel_prepare_visible_query",
                prepare_request.clone()
            )?["ok"],
            true
        );

        set_authority(&mut client, "tenant_a", "region", "typed")?;
        for (function, request) in [
            ("kernel_read_visible_records", visible_request),
            ("kernel_read_visible_records_by_model", by_model_request),
            ("kernel_change_set_diff", diff_request),
            ("kernel_field_history", history_request),
            ("kernel_recent_activity", activity_request),
            ("kernel_prepare_visible_query", prepare_request),
        ] {
            assert_error(
                &call_json(&mut client, function, request)?,
                "lookup_storage_authority_mismatch",
            );
        }

        let entity_visible = call_json(
            &mut client,
            "kernel_read_visible_records_by_model",
            json!({
                "app_id":"read_app","customer_id":"tenant_a","as_of":"2026-08-04",
                "model_ids":["company"]
            }),
        )?;
        assert_eq!(entity_visible["ok"], true, "{entity_visible:#}");
        let enum_history = call_json(
            &mut client,
            "kernel_field_history",
            json!({
                "app_id":"read_app","customer_id":"tenant_a","model_id":"company",
                "record_id":"00000000-0000-0000-0000-000000000101","field_id":"status"
            }),
        )?;
        assert_eq!(enum_history["ok"], true, "{enum_history:#}");
        assert!(enum_history["data"].as_array().is_some_and(|entries| {
            entries.iter().all(|entry| {
                entry["enum_value"]["event_label"] == "Active"
                    && entry["enum_value"]["current_label"] == "Active"
            })
        }));

        Ok::<_, String>(())
    })();

    trusted_human::drop_fixture(&mut client, &database_schema)
        .expect("drop isolated read-authority schema");
    result.expect("generated reads enforce lookup authority");
}

#[test]
fn enum_audit_hydration_uses_each_event_change_sets_pinned_revision() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let compiled = compiled_schema();
    let bundle = render_sql_artifact_bundle(&compile_sql_artifact_manifest(&compiled).unwrap());
    let mut client = connect_postgres(&database_url).expect("connect to test PostgreSQL");
    let database_schema = format!("kernel_sql_enum_audit_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            "create schema \"{database_schema}\"; set search_path to \"{database_schema}\""
        ))
        .expect("create isolated enum audit schema");
    trusted_human::before_install(&mut client);

    let result = (|| {
        client
            .batch_execute(&bundle)
            .map_err(|error| format!("bundle install: {error:?}"))?;
        crate::seed_fixture!(&mut client, &compiled.schema)
            .map_err(|error| format!("fixture seed: {error}"))?;

        let mut original_schema =
            serde_json::to_value(&compiled.schema).map_err(|error| error.to_string())?;
        original_schema["models"]
            .as_array_mut()
            .expect("schema models")
            .retain(|model| model["id"] == "company");
        original_schema["custom_fields"] = json!([{
            "id": "company_priority",
            "model_id": "company",
            "field_id": "priority",
            "label": "Priority",
            "type": "enum",
            "option_set": [{
                "id": "hot",
                "label": "Hot",
                "aliases": [],
                "origin": "app",
                "management": "tenant_managed",
                "lifecycle": "active"
            }],
            "archived_at": null,
            "origin": "app",
            "management": "tenant_managed",
            "lifecycle": "active"
        }]);
        client
            .execute(
                "update schema_revision set base_schema=$1, schema=$1 where id=1 and app_id='read_app' and customer_id='tenant_a'",
                &[&original_schema],
            )
            .map_err(|error| error.to_string())?;

        let mut renamed_schema = original_schema.clone();
        set_declared_enum_option(
            &mut renamed_schema,
            "company",
            "status",
            "active",
            "Enabled",
            "active",
        );
        set_custom_enum_option(
            &mut renamed_schema,
            "company",
            "priority",
            "hot",
            "Urgent",
            "active",
        );
        let mut current_schema = renamed_schema.clone();
        set_declared_enum_option(
            &mut current_schema,
            "company",
            "status",
            "active",
            "Enabled",
            "retired",
        );
        set_custom_enum_option(
            &mut current_schema,
            "company",
            "priority",
            "hot",
            "Urgent",
            "retired",
        );

        client
            .execute(
                "update schema_revision set activated_at=null where app_id='read_app' and customer_id='tenant_a'",
                &[],
            )
            .map_err(|error| error.to_string())?;
        client
            .execute(
                "insert into schema_revision (id,app_id,customer_id,version,base_schema,customer_overlay,schema,materialized_at) values (3,'read_app','tenant_a','2026-08-04.renamed',$1,'{}',$1,now())",
                &[&renamed_schema],
            )
            .map_err(|error| error.to_string())?;
        client
            .execute(
                "insert into schema_revision (id,app_id,customer_id,version,base_schema,customer_overlay,schema,activated_at,materialized_at) values (4,'read_app','tenant_a','2026-08-04.retired',$1,'{}',$1,now(),now())",
                &[&current_schema],
            )
            .map_err(|error| error.to_string())?;
        client
            .batch_execute(
                r#"
                set kernel.app_id = 'read_app'; set kernel.customer_id = 'tenant_a';
                insert into change_set (
                  id,app_id,customer_id,schema_revision_id,created_with_mode,status,source_kind,
                  created_order,applied_order,created_at,applied_at
                ) values (
                  103,'read_app','tenant_a',3,'mainline','mainline','fixture',3,3,
                  '2026-08-04 13:00:00+00','2026-08-04 13:00:00+00'
                );
                insert into company_version (
                  id,record_id,app_id,customer_id,stage,effective_start,change_set_id,applied_at,
                  name,score,status,custom_fields,tombstones_record,untombstones_record
                ) values (
                  '00000000-0000-0000-0000-000000000207',
                  '00000000-0000-0000-0000-000000000101',
                  'read_app','tenant_a','mainline','2026-08-04',103,
                  '2026-08-04 13:00:00+00','Gamma',30,'active',
                  '[{"field_id":"priority","type":"enum","value":"hot"}]',false,false
                );
                "#,
            )
            .map_err(|error| format!("seed renamed enum event: {error:?}"))?;

        let helper_probe: Value = client
            .query_one(
                "select kernel_read_enum_audit_value($1::jsonb,$2::jsonb,'company','status',$3::jsonb,1)",
                &[
                    &current_schema,
                    &original_schema,
                    &json!({"type":"enum","value":"active"}),
                ],
            )
            .map_err(|error| format!("probe enum audit helper: {error:?}"))?
            .get(0);
        assert_eq!(helper_probe["event_label"], "Active");

        let original_diff_request = ChangeSetDiffRequest {
            app_id: AppId::from("read_app"),
            customer_id: CustomerId::from("tenant_a"),
            change_set_id: 101,
            project: vec![],
        };
        let original_diff_result = call!(
            &mut client,
            "kernel_change_set_diff",
            serde_json::to_value(&original_diff_request).map_err(|error| error.to_string())?,
        )?;
        assert_eq!(original_diff_result["ok"], true, "{original_diff_result:#}");
        let original_diff: ChangeSetDiff =
            serde_json::from_value(original_diff_result["data"].clone())
                .map_err(|error| format!("decode enum change-set diff: {error}"))?;
        let rust_original_diff =
            kernel::testing::change_set_diff(&mut client, &original_diff_request)
                .map_err(|error| format!("Rust enum change-set diff: {error:?}"))?;
        assert_eq!(original_diff, rust_original_diff);
        let original_status = original_diff
            .records
            .iter()
            .find(|record| record.record_id.to_string() == "00000000-0000-0000-0000-000000000101")
            .and_then(|record| {
                record
                    .fields
                    .iter()
                    .find(|field| field.field_id.as_str() == "status")
            })
            .and_then(|field| field.after_enum.as_ref())
            .expect("original enum diff hydration");
        assert_eq!(original_status.option_id.as_str(), "active");
        assert_eq!(original_status.event_schema_revision_id.get(), 1);
        assert_eq!(original_status.event_label, "Active");
        assert_eq!(original_status.current_label.as_deref(), Some("Enabled"));

        let renamed_diff_request = ChangeSetDiffRequest {
            change_set_id: 103,
            ..original_diff_request.clone()
        };
        let renamed_diff_result = call!(
            &mut client,
            "kernel_change_set_diff",
            serde_json::to_value(&renamed_diff_request).map_err(|error| error.to_string())?,
        )?;
        let renamed_diff: ChangeSetDiff =
            serde_json::from_value(renamed_diff_result["data"].clone())
                .map_err(|error| format!("decode renamed enum diff: {error}"))?;
        let rust_renamed_diff =
            kernel::testing::change_set_diff(&mut client, &renamed_diff_request)
                .map_err(|error| format!("Rust renamed enum diff: {error:?}"))?;
        assert_eq!(renamed_diff, rust_renamed_diff);
        let renamed_priority = renamed_diff.records[0]
            .custom_fields
            .iter()
            .find(|field| field.field_id.as_str() == "priority")
            .and_then(|field| field.after_enum.as_ref())
            .expect("renamed custom enum diff hydration");
        assert_eq!(renamed_priority.option_id.as_str(), "hot");
        assert_eq!(renamed_priority.event_schema_revision_id.get(), 3);
        assert_eq!(renamed_priority.event_label, "Urgent");
        assert_eq!(renamed_priority.current_label.as_deref(), Some("Urgent"));

        let history_request = FieldHistoryRequest {
            app_id: AppId::from("read_app"),
            customer_id: CustomerId::from("tenant_a"),
            model_id: ModelId::from("company"),
            record_id: "00000000-0000-0000-0000-000000000101"
                .parse()
                .expect("record fixture id"),
            field_id: Some(FieldId::from("status")),
            as_of: None,
            limit: Some(10),
            stages: vec![],
        };
        let history = call!(
            &mut client,
            "kernel_field_history",
            serde_json::to_value(&history_request).map_err(|error| error.to_string())?,
        )?;
        assert_eq!(history["ok"], true, "{history:#}");
        let history_entries: Vec<FieldHistoryEntry> =
            serde_json::from_value(history["data"].clone())
                .map_err(|error| format!("decode enum field history: {error}"))?;
        let rust_history = kernel::testing::field_history(&mut client, &history_request)
            .map_err(|error| format!("Rust enum field history: {error:?}"))?;
        assert_eq!(history_entries, rust_history);
        assert_eq!(history_entries.len(), 3);
        assert!(history_entries.iter().all(|entry| {
            entry.value == Some(kernel::FieldValue::Enum(EnumOptionId::from("active")))
        }));
        let original_history = history_entries[0]
            .enum_value
            .as_ref()
            .expect("original history enum hydration");
        assert_eq!(original_history.event_schema_revision_id.get(), 1);
        assert_eq!(original_history.event_label, "Active");
        assert_eq!(original_history.current_label.as_deref(), Some("Enabled"));
        let renamed_history = history_entries[2]
            .enum_value
            .as_ref()
            .expect("renamed history enum hydration");
        assert_eq!(renamed_history.event_schema_revision_id.get(), 3);
        assert_eq!(renamed_history.event_label, "Enabled");
        assert_eq!(renamed_history.current_label.as_deref(), Some("Enabled"));

        let custom_history = call!(
            &mut client,
            "kernel_field_history",
            json!({
                "app_id":"read_app","customer_id":"tenant_a","model_id":"company",
                "record_id":"00000000-0000-0000-0000-000000000101",
                "field_id":"priority","limit":10
            }),
        )?;
        let custom_history_entries: Vec<FieldHistoryEntry> =
            serde_json::from_value(custom_history["data"].clone())
                .map_err(|error| format!("decode custom enum history: {error}"))?;
        let custom_enum = custom_history_entries
            .last()
            .and_then(|entry| entry.enum_value.as_ref())
            .expect("custom enum history hydration");
        assert_eq!(custom_enum.event_label, "Urgent");
        assert_eq!(custom_enum.current_label.as_deref(), Some("Urgent"));
        let visible = call!(
            &mut client,
            "kernel_read_visible_record",
            json!({
                "app_id":"read_app","customer_id":"tenant_a","model_id":"company",
                "record_id":"00000000-0000-0000-0000-000000000101","as_of":"2026-08-04"
            }),
        )?;
        assert_eq!(
            visible["data"]["values"]["status"],
            json!({"type":"enum","value":"active"})
        );
        assert!(visible["data"]["values"]["status"]
            .get("current_label")
            .is_none());

        client
            .batch_execute(
                r#"
                alter table change_set drop constraint change_set_schema_revision_tenant_fk;
                insert into change_set (
                  id,app_id,customer_id,schema_revision_id,created_with_mode,status,source_kind,
                  created_order,applied_order,created_at,applied_at
                ) values (104,'read_app','tenant_a',999999,'mainline','mainline','fixture',4,4,now(),now());
                "#,
            )
            .map_err(|error| format!("seed missing revision event: {error:?}"))?;
        let missing_revision = call!(
            &mut client,
            "kernel_change_set_diff",
            json!({"app_id":"read_app","customer_id":"tenant_a","change_set_id":104}),
        )?;
        assert_error(&missing_revision, "schema_drift");
        assert_eq!(missing_revision["error"]["details"][0]["path"], "object");
        assert!(missing_revision["error"]["details"][0]["message"]
            .as_str()
            .is_some_and(|message| message.contains("pins missing schema revision `999999`")));

        Ok::<_, String>(())
    })();

    let _ = client.batch_execute("rollback");
    trusted_human::drop_fixture(&mut client, &database_schema)
        .expect("drop isolated enum audit schema");
    result.expect("event-pinned enum audit hydration");
}

fn set_declared_enum_option(
    schema: &mut Value,
    model_id: &str,
    field_id: &str,
    option_id: &str,
    label: &str,
    lifecycle: &str,
) {
    let option = schema["models"]
        .as_array_mut()
        .and_then(|models| models.iter_mut().find(|model| model["id"] == model_id))
        .and_then(|model| model["fields"].as_array_mut())
        .and_then(|fields| fields.iter_mut().find(|field| field["id"] == field_id))
        .and_then(|field| field["option_set"].as_array_mut())
        .and_then(|options| options.iter_mut().find(|option| option["id"] == option_id))
        .expect("declared enum option fixture");
    option["label"] = json!(label);
    option["lifecycle"] = json!(lifecycle);
}

fn set_custom_enum_option(
    schema: &mut Value,
    model_id: &str,
    field_id: &str,
    option_id: &str,
    label: &str,
    lifecycle: &str,
) {
    let option = schema["custom_fields"]
        .as_array_mut()
        .and_then(|definitions| {
            definitions.iter_mut().find(|definition| {
                definition["model_id"] == model_id && definition["field_id"] == field_id
            })
        })
        .and_then(|definition| definition["option_set"].as_array_mut())
        .and_then(|options| options.iter_mut().find(|option| option["id"] == option_id))
        .expect("custom enum option fixture");
    option["label"] = json!(label);
    option["lifecycle"] = json!(lifecycle);
}

#[macro_export]
macro_rules! seed_fixture {
    ($client:expr, $schema:expr) => {{
    (|| {
    let client = &mut *$client;
    let schema = $schema;
    for customer in ["tenant_a", "tenant_b"] {
        for actor in ["fixture", "importer", "alice", "bob", "carol", "dana"] { trusted_human::bind(client, "read_app", customer, actor); }
    }
    trusted_human::select(client, "fixture");
    let tenant_a = serde_json::to_value(schema).unwrap();
    let mut tenant_b = tenant_a.clone();
    tenant_b["customer_id"] = json!("tenant_b");
    for (revision_id, customer_id, schema_json) in
        [(1_i64, "tenant_a", tenant_a), (2_i64, "tenant_b", tenant_b)]
    {
        client
            .execute(
                "select set_config('kernel.app_id', 'read_app', false), set_config('kernel.customer_id', $1, false)",
                &[&customer_id],
            )
            .map_err(|error| error.to_string())?;
        client
            .execute(
                "insert into schema_revision (id, app_id, customer_id, version, base_schema, customer_overlay, schema, activated_at) values ($1, 'read_app', $2, '2026-08-04', $3, '{}', $3, now())",
                &[&revision_id, &customer_id, &schema_json],
            )
            .map_err(|error| error.to_string())?;
    }
    client
        .batch_execute(
            r#"
            set kernel.app_id = 'read_app'; set kernel.customer_id = 'tenant_a';
            insert into change_set (id, app_id, customer_id, schema_revision_id, created_with_mode, status, actor_id, source_kind, source_ref, notes, created_order, applied_order, created_at, applied_at) values
              (101, 'read_app', 'tenant_a', 1, 'mainline', 'mainline', 'actor-a', 'fixture', 'source-a', 'first', 1, 1, '2026-08-04 12:00:00+00', '2026-08-04 12:00:00+00'),
              (102, 'read_app', 'tenant_a', 1, 'mainline', 'mainline', 'actor-b', 'fixture', 'source-b', 'second', 2, 2, '2026-08-04 11:00:00+00', '2026-08-04 11:00:00+00');
            insert into company_record (id, app_id, customer_id, external_key) values
              ('00000000-0000-0000-0000-000000000101', 'read_app', 'tenant_a', 'acme'),
              ('00000000-0000-0000-0000-000000000102', 'read_app', 'tenant_a', 'tombstoned'),
              ('00000000-0000-0000-0000-000000000103', 'read_app', 'tenant_a', 'untombstoned');
            insert into company_version (id, record_id, app_id, customer_id, stage, effective_start, change_set_id, applied_at, name, score, observed_at, rate_amount, rate_currency, rate_period, status, tombstones_record, untombstones_record) values
              ('00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000101', 'read_app', 'tenant_a', 'mainline', '2026-08-04', 101, '2026-08-04 12:00:00+00', 'Alpha', 10, '2026-08-04 12:00:00+00', 100, 'USD', 'hourly', 'active', false, false),
              ('00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000101', 'read_app', 'tenant_a', 'mainline', '2026-08-04', 102, '2026-08-04 11:00:00+00', 'Beta', 20, '2026-08-04 11:00:00+00', 125, 'USD', 'hourly', 'active', false, false),
              ('00000000-0000-0000-0000-000000000203', '00000000-0000-0000-0000-000000000102', 'read_app', 'tenant_a', 'mainline', '2026-08-04', 101, '2026-08-04 12:00:00+00', 'Hidden by tombstone', 1, null, null, null, null, 'active', false, false),
              ('00000000-0000-0000-0000-000000000204', '00000000-0000-0000-0000-000000000102', 'read_app', 'tenant_a', 'mainline', '2026-08-04', 102, '2026-08-04 11:00:00+00', null, null, null, null, null, null, null, true, false),
              ('00000000-0000-0000-0000-000000000205', '00000000-0000-0000-0000-000000000103', 'read_app', 'tenant_a', 'mainline', '2026-08-04', 101, '2026-08-04 12:00:00+00', 'Hidden by untombstone event', 1, null, null, null, null, 'active', false, false),
              ('00000000-0000-0000-0000-000000000206', '00000000-0000-0000-0000-000000000103', 'read_app', 'tenant_a', 'mainline', '2026-08-04', 102, '2026-08-04 11:00:00+00', null, null, null, null, null, null, null, false, true);

            set kernel.customer_id = 'tenant_b';
            insert into change_set (id, app_id, customer_id, schema_revision_id, created_with_mode, status, source_kind, created_order, applied_order, applied_at) values
              (201, 'read_app', 'tenant_b', 2, 'mainline', 'mainline', 'fixture', 3, 3, now());
            insert into company_record (id, app_id, customer_id, external_key) values
              ('00000000-0000-0000-0000-000000000301', 'read_app', 'tenant_b', 'other');
            insert into company_version (id, record_id, app_id, customer_id, stage, effective_start, change_set_id, applied_at, name, score, status) values
              ('00000000-0000-0000-0000-000000000302', '00000000-0000-0000-0000-000000000301', 'read_app', 'tenant_b', 'mainline', '2026-08-04', 201, now(), 'Other Tenant', 99, 'inactive');
            "#,
        )
        .map_err(|error| format!("{error:?}"))?;
    Ok::<_, String>(())
    })()
    }};
}

#[macro_export]
macro_rules! assert_record_lock {
    ($database_url:expr, $database_schema:expr) => {{
    (|| {
    let database_url = $database_url;
    let database_schema = $database_schema;
    let mut locker = connect_postgres(database_url).map_err(|error| error.to_string())?;
    let mut contender = connect_postgres(database_url).map_err(|error| error.to_string())?;
    locker
        .batch_execute(&format!("set search_path to \"{database_schema}\""))
        .map_err(|error| error.to_string())?;
    contender
        .batch_execute(&format!(
            "set search_path to \"{database_schema}\"; set lock_timeout = '100ms'; set kernel.app_id = 'read_app'; set kernel.customer_id = 'tenant_a'"
        ))
        .map_err(|error| error.to_string())?;
    let mut transaction = locker.transaction().map_err(|error| error.to_string())?;
    let locked = call!(
        &mut transaction,
        "kernel_read_visible_record_for_update",
        json!({
            "app_id": "read_app", "customer_id": "tenant_a", "model_id": "company",
            "record_id": "00000000-0000-0000-0000-000000000101", "as_of": "2026-08-04"
        }),
    )?;
    assert_eq!(locked["ok"], true);
    let error = contender
        .query_one(
            "select id from company_record where id = '00000000-0000-0000-0000-000000000101' for update",
            &[],
        )
        .expect_err("generated locking read holds the record lock on its caller transaction");
    assert_eq!(
        error.as_db_error().map(|error| error.code().code()),
        Some("55P03")
    );
    transaction.rollback().map_err(|error| error.to_string())?;
    Ok::<_, String>(())
    })()
    }};
}

fn assert_error(value: &Value, code: &str) {
    assert_eq!(value["ok"], false, "unexpected success: {value}");
    assert_eq!(value["error"]["code"], code, "unexpected error: {value}");
}

fn test_database_url() -> Option<String> {
    match env::var("KERNEL_TEST_DATABASE_URL") {
        Ok(url) => Some(url),
        Err(env::VarError::NotPresent) => {
            eprintln!("skipping SQL reads test: KERNEL_TEST_DATABASE_URL is absent");
            None
        }
        Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
    }
}

fn establish_generated_execution_owner(client: &mut postgres::Client) -> Result<String, String> {
    let execution_role: String = client
        .query_one(
            "select kernel_installer_capability_role('execution_owner')",
            &[],
        )
        .map_err(|error| format!("resolve generated execution-owner role: {error:?}"))?
        .get(0);
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
        .map_err(|error| format!("establish generated execution-owner identity: {error:?}"))?;
    trusted_human::grant_capability(client, "execution_owner");
    Ok(execution_role)
}
