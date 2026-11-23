use std::env;

use kernel::{
    connect_postgres, AppId, CustomerId, Field, FieldId, FieldType, Model, ModelId, ModelKind,
    Schema, SchemaVersion,
};
use schema_compiler::{
    compile_sql_artifact_manifest, render_sql_artifact_bundle, CompiledManifest,
    NormalizedManifestExtras, SqlArtifactKind,
};
use uuid::Uuid;

fn compiled_schema() -> CompiledManifest {
    CompiledManifest {
        schema: Schema {
            app_id: AppId::from("repair_app"),
            customer_id: CustomerId::from("repair_customer"),
            version: SchemaVersion::from("2026-08-04"),
            models: vec![Model {
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
            }],
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
fn agent_run_status_check_is_an_explicit_catalog_repair() {
    let manifest = compile_sql_artifact_manifest(&compiled_schema()).unwrap();
    let repair = manifest
        .artifacts
        .iter()
        .find(|artifact| {
            artifact.kind == SqlArtifactKind::CheckConstraint
                && artifact.name == "agent_run.agent_run_status_check"
        })
        .expect("agent-run status repair artifact");

    for fragment in [
        "pg_get_expr",
        "existing_expression = any",
        "validation_exhausted''::text, ''runtime_error''::text]",
        "validation_exhausted''::text, ''runtime_error''::text, ''cancelled''::text]",
        "budget_exhausted",
        "drop constraint \"agent_run_status_check\"",
        "not valid",
        "validate constraint \"agent_run_status_check\"",
        "not a recognized catalog revision",
    ] {
        assert!(
            repair.sql.contains(fragment),
            "missing repair fragment: {fragment}"
        );
    }
    for forbidden in ["drop table", "drop column", "delete from"] {
        assert!(!repair.sql.to_ascii_lowercase().contains(forbidden));
    }
}

#[test]
fn lookup_stage_check_repairs_the_legacy_catalog_revision() {
    let manifest = compile_sql_artifact_manifest(&compiled_schema()).unwrap();
    let repair = manifest
        .artifacts
        .iter()
        .find(|artifact| {
            artifact.kind == SqlArtifactKind::CheckConstraint
                && artifact.name == "lookup_version.lookup_version_stage_check"
        })
        .expect("lookup-version stage repair artifact");

    for fragment in [
        "pg_get_expr",
        "existing_expression = any",
        "''discarded''::text]",
        "''discarded''::text, ''reverted''::text]",
        "drop constraint \"lookup_version_stage_check\"",
        "validate constraint \"lookup_version_stage_check\"",
    ] {
        assert!(
            repair.sql.contains(fragment),
            "missing lookup repair fragment: {fragment}"
        );
    }
}

#[test]
fn generated_constraints_are_validated_after_idempotent_creation() {
    let manifest = compile_sql_artifact_manifest(&compiled_schema()).unwrap();
    for kind in [
        SqlArtifactKind::CheckConstraint,
        SqlArtifactKind::ForeignKey,
    ] {
        for artifact in manifest
            .artifacts
            .iter()
            .filter(|artifact| artifact.kind == kind)
        {
            assert!(
                artifact.sql.contains("validate constraint"),
                "generated constraint {} must converge to a validated catalog object",
                artifact.name
            );
        }
    }
}

#[test]
fn legacy_agent_run_status_check_is_repaired_and_reinstall_is_idempotent() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let manifest = compile_sql_artifact_manifest(&compiled_schema()).unwrap();
    let bundle = render_sql_artifact_bundle(&manifest);
    let mut client = connect_postgres(&database_url).expect("connect to PostgreSQL");
    let schema = format!("kernel_check_repair_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            "create schema \"{schema}\"; set search_path to \"{schema}\""
        ))
        .expect("create isolated repair schema");

    let result = (|| {
        client.batch_execute(&bundle)?;
        client.batch_execute(
            r#"
            alter table agent_run drop constraint agent_run_status_check;
            alter table agent_run add constraint agent_run_status_check check (
              status in ('recorded', 'completed', 'validation_exhausted', 'runtime_error')
            );
            "#,
        )?;
        client.batch_execute(&bundle)?;
        client.batch_execute(&bundle)?;

        let (expression, validated): (String, bool) = client
            .query_one(
                r#"
                select pg_get_expr(conbin, conrelid, true), convalidated
                from pg_constraint
                where conrelid = 'agent_run'::regclass
                  and conname = 'agent_run_status_check'
                "#,
                &[],
            )
            .map(|row| (row.get(0), row.get(1)))?;
        assert!(expression.contains("'budget_exhausted'::text"));
        assert!(validated);

        client.batch_execute(
            r#"
            alter table agent_run drop constraint agent_run_status_check;
            alter table agent_run add constraint agent_run_status_check
              check (status <> 'unrecognized_catalog_shape');
            "#,
        )?;
        let error = client
            .batch_execute(&bundle)
            .expect_err("unrecognized same-name check must fail closed");
        assert!(error
            .as_db_error()
            .map(|error| error.message())
            .unwrap_or_default()
            .contains("existing check constraint is not a recognized catalog revision"));
        client.batch_execute("rollback")?;
        let expression: String = client
            .query_one(
                r#"
                select pg_get_expr(conbin, conrelid, true)
                from pg_constraint
                where conrelid = 'agent_run'::regclass
                  and conname = 'agent_run_status_check'
                "#,
                &[],
            )?
            .get(0);
        assert!(expression.contains("unrecognized_catalog_shape"));
        Ok::<_, postgres::Error>(())
    })();

    client
        .batch_execute(&format!("drop schema \"{schema}\" cascade"))
        .expect("drop isolated repair schema");
    result.expect("exercise generated catalog repair");
}

fn test_database_url() -> Option<String> {
    match env::var("KERNEL_TEST_DATABASE_URL") {
        Ok(url) => Some(url),
        Err(env::VarError::NotPresent) => {
            eprintln!("skipping SQL constraint repair test: KERNEL_TEST_DATABASE_URL is absent");
            None
        }
        Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
    }
}
