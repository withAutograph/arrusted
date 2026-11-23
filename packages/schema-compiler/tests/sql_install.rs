use std::env;
use std::path::PathBuf;
use std::process::Command;

use kernel::connect_postgres;
use serde_json::{json, Value};
use uuid::Uuid;

#[test]
fn generated_cue_bundle_installs_idempotently_without_activating_a_revision() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = Command::new(env!("CARGO_BIN_EXE_schema-compiler"))
        .arg("--sql-bundle")
        .arg(root.join("packages/schema-compiler/cue/app-manifest.cue"))
        .arg(root.join("docs/examples/schema-compiler/company.cue"))
        .output()
        .expect("run SQL bundle compiler target");
    assert!(
        output.status.success(),
        "SQL bundle compilation failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let bundle = String::from_utf8(output.stdout).expect("SQL bundle is UTF-8");

    let mut client = connect_postgres(&database_url).expect("connect to test PostgreSQL");
    let schema = format!("kernel_sql_install_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            "create schema \"{schema}\"; set search_path to \"{schema}\""
        ))
        .expect("create isolated SQL install schema");

    let result = (|| {
        client
            .batch_execute(&bundle)
            .map_err(|error| error.to_string())?;
        client
            .batch_execute(&bundle)
            .map_err(|error| error.to_string())?;

        let version_table_count: i64 = client
            .query_one(
                "select count(*) from information_schema.tables where table_schema = current_schema() and table_name in ('company_version', 'employee_version', 'region_version')",
                &[],
            )
            .map_err(|error| error.to_string())?
            .get(0);
        assert_eq!(
            version_table_count, 2,
            "entity models remain typed while the region lookup uses generic storage"
        );
        let generic_lookup_table_count: i64 = client
            .query_one(
                "select count(*) from information_schema.tables where table_schema = current_schema() and table_name in ('lookup_record', 'lookup_version')",
                &[],
            )
            .map_err(|error| error.to_string())?
            .get(0);
        assert_eq!(generic_lookup_table_count, 2);

        let active_revision_count: i64 = client
            .query_one(
                "select count(*) from schema_revision where activated_at is not null",
                &[],
            )
            .map_err(|error| error.to_string())?
            .get(0);
        assert_eq!(active_revision_count, 0);

        let missing: Value = client
            .query_one(
                "select kernel_read_active_schema_revision($1::jsonb)",
                &[&json!({"app_id": "company_directory", "customer_id": "example"})],
            )
            .map_err(|error| error.to_string())?
            .get(0);
        assert_eq!(missing["ok"], json!(false));
        assert_eq!(missing["error"]["code"], "active_schema_missing");

        client
            .batch_execute(
                r#"
                set kernel.app_id = 'company_directory';
                set kernel.customer_id = 'example';
                insert into schema_revision (
                  app_id, customer_id, version, base_schema, customer_overlay, schema
                ) values (
                  'company_directory', 'example', 'fixture',
                  '{"app_id":"company_directory","customer_id":"example","version":"fixture","models":[]}'::jsonb,
                  '{}'::jsonb,
                  '{"app_id":"company_directory","customer_id":"example","version":"fixture","models":[]}'::jsonb
                );
                insert into change_set (
                  app_id, customer_id, schema_revision_id, created_with_mode, status,
                  source_kind, created_order, applied_order, applied_at
                ) values (
                  'company_directory', 'example', 1, 'mainline', 'mainline',
                  'fixture', 1, 1, now()
                );
                insert into company_record (id, app_id, customer_id, external_key)
                values (
                  '00000000-0000-0000-0000-000000000001',
                  'company_directory', 'example', 'invalid-revenue'
                );
                "#,
            )
            .map_err(|error| error.to_string())?;

        client
            .execute(
                "update schema_revision set activated_at = now() where id = 1",
                &[],
            )
            .map_err(|error| error.to_string())?;
        let active: Value = client
            .query_one(
                "select kernel_read_active_schema_revision($1::jsonb)",
                &[&json!({"app_id": "company_directory", "customer_id": "example"})],
            )
            .map_err(|error| error.to_string())?
            .get(0);
        assert_eq!(active["ok"], json!(true));
        assert_eq!(active["data"]["schema_revision_id"], 1);
        assert_eq!(active["data"]["schema"]["app_id"], "company_directory");
        let error = client
            .execute(
                r#"
                insert into company_version (
                  id, record_id, app_id, customer_id, stage, effective_start,
                  change_set_id, applied_at, name, annual_revenue
                ) values (
                  '00000000-0000-0000-0000-000000000002',
                  '00000000-0000-0000-0000-000000000001',
                  'company_directory', 'example', 'mainline', '2026-08-04',
                  1, now(), 'Invalid Revenue', -1
                )
                "#,
                &[],
            )
            .expect_err("generated authoritative constraint rejects a negative revenue");
        assert_eq!(
            error.as_db_error().and_then(|error| error.constraint()),
            Some("company_version_company_revenue_nonnegative_constraint_check")
        );
        Ok::<_, String>(())
    })();

    client
        .batch_execute(&format!("drop schema \"{schema}\" cascade"))
        .expect("drop isolated SQL install schema");
    result.expect("install generated SQL bundle twice");
}

fn test_database_url() -> Option<String> {
    match env::var("KERNEL_TEST_DATABASE_URL") {
        Ok(url) => Some(url),
        Err(env::VarError::NotPresent) => {
            eprintln!("skipping SQL install test: KERNEL_TEST_DATABASE_URL is absent");
            None
        }
        Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
    }
}
