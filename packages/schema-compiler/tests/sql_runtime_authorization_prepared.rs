use std::env;

use kernel::{connect_postgres, schema_hash};
use postgres::{error::SqlState, Client};
use schema_compiler::{
    compile_manifest_json, compile_sql_artifact_manifest, render_sql_artifact_bundle,
};
use serde_json::{json, Value};
use uuid::Uuid;

const APP_ID: &str = "authorization_prepared_fixture";
const CUSTOMER_ID: &str = "tenant_a";

struct AuthorizationFixtureCleanup {
    database_url: String,
    schema: String,
    principal: String,
    complete: bool,
}

impl AuthorizationFixtureCleanup {
    fn new(database_url: &str, schema: &str, principal: &str) -> Self {
        Self {
            database_url: database_url.to_owned(),
            schema: schema.to_owned(),
            principal: principal.to_owned(),
            complete: false,
        }
    }

    fn finish(&mut self) -> Result<(), String> {
        if self.complete {
            return Ok(());
        }
        let mut cleanup = connect_postgres(&self.database_url)
            .map_err(|error| format!("connect cleanup PostgreSQL: {error}"))?;
        cleanup
            .batch_execute(&format!(
                r#"
                rollback;
                reset role;
                reset session authorization;
                set search_path to public;
                drop schema if exists "{}" cascade;
                drop role if exists "{}";
                "#,
                self.schema, self.principal,
            ))
            .map_err(|error| format!("remove isolated authorization fixture: {error}"))?;
        self.complete = true;
        Ok(())
    }
}

impl Drop for AuthorizationFixtureCleanup {
    fn drop(&mut self) {
        if let Err(error) = self.finish() {
            eprintln!("authorization fixture cleanup after panic: {error}");
        }
    }
}

#[test]
fn policy_activation_closes_legacy_temp_views_and_prepared_queries_for_runtime_principals() {
    let database_url = test_database_url();
    let legacy = compile_manifest_json(&manifest("legacy-v1", false).to_string())
        .expect("compile legacy manifest");
    let policy = compile_manifest_json(&manifest("policy-v2", true).to_string())
        .expect("compile policy manifest");
    let legacy_bundle = render_sql_artifact_bundle(
        &compile_sql_artifact_manifest(&legacy).expect("compile legacy SQL bundle"),
    );
    let policy_bundle = render_sql_artifact_bundle(
        &compile_sql_artifact_manifest(&policy).expect("compile policy SQL bundle"),
    );
    let mut client = connect_postgres(&database_url).expect("connect PostgreSQL");
    let schema = format!("kernel_authorization_prepared_{}", Uuid::new_v4().simple());
    let principal = format!("authorization_runtime_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            "create schema \"{schema}\"; set search_path to \"{schema}\""
        ))
        .expect("create isolated schema");

    let mut cleanup = AuthorizationFixtureCleanup::new(&database_url, &schema, &principal);

    let result = (|| -> Result<(), String> {
        client
            .batch_execute(&legacy_bundle)
            .map_err(|error| format!("install legacy bundle: {error}"))?;
        let runtime_role = scalar(
            &mut client,
            "select kernel_installer_capability_role('runtime')",
        )?;
        let execution_owner = scalar(
            &mut client,
            "select kernel_installer_capability_role('execution_owner')",
        )?;
        let query_role = scalar(
            &mut client,
            "select kernel_installer_capability_role('query')",
        )?;
        client
            .batch_execute(&format!(
                "grant \"{runtime_role}\" to session_user; create role \"{principal}\" nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls; grant \"{runtime_role}\" to \"{principal}\"; grant usage on schema \"{schema}\" to \"{principal}\""
            ))
            .map_err(|error| format!("create restricted runtime principal: {error}"))?;

        let legacy_hash = schema_hash(&legacy.schema);
        let legacy_revision =
            prepare_validate_activate(&mut client, &legacy.schema, "legacy-policy-prepared", None)?;
        assert_ok(&call(
            &mut client,
            "kernel_bind_principal_scope",
            json!({"principal_name":principal,"capability":"runtime","app_id":APP_ID,"customer_id":CUSTOMER_ID}),
        )?);
        assert_ok(&call(
            &mut client,
            "kernel_bind_actor_membership",
            json!({"actor_kind":"human","principal_name":principal,"app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"actor_a","role":"reviewer"}),
        )?);

        client
            .batch_execute(&format!(
                r#"
                set kernel.app_id = '{APP_ID}';
                set kernel.customer_id = '{CUSTOMER_ID}';
                insert into change_set (
                  app_id, customer_id, schema_revision_id, created_with_mode, status,
                  source_kind, created_order, applied_order, applied_at
                ) values ('{APP_ID}', '{CUSTOMER_ID}', {legacy_revision}, 'mainline', 'mainline', 'fixture', 1, 1, now());
                insert into work_item_record (id,app_id,customer_id,external_key) values
                  ('10000000-0000-0000-0000-000000000001','{APP_ID}','{CUSTOMER_ID}','protected');
                insert into work_item_version (
                  id,record_id,app_id,customer_id,stage,effective_start,change_set_id,applied_at,owner,summary
                ) values (
                  '10000000-0000-0000-0000-000000000011','10000000-0000-0000-0000-000000000001',
                  '{APP_ID}','{CUSTOMER_ID}','mainline','2026-01-01',1,now(),'actor_a','protected row'
                );
                "#
            ))
            .map_err(|error| format!("seed legacy visible row: {error}"))?;

        // The policy release is installed while the legacy revision remains
        // active. Its policy DDL must be safe for the old query protocol until
        // activation, then close the already-created protocol without repair.
        assert!(
            policy_bundle.contains("kernel_policy_raw_table_access_allowed"),
            "the normal policy bundle must emit the raw-access RLS guard"
        );
        client
            .batch_execute(&policy_bundle)
            .map_err(|error| format!("install policy bundle before activation: {error}"))?;
        client
            .batch_execute(&format!(
                r#"set session authorization "{principal}";
                   set kernel.actor_id = 'actor_a';"#
            ))
            .map_err(|error| format!("assume restricted runtime principal: {error}"))?;
        assert_ok(&call(
            &mut client,
            "kernel_prepare_visible_query",
            json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"as_of":"2026-01-01"}),
        )?);
        client
            .batch_execute(&format!(
                "set role \"{query_role}\"; set kernel.app_id = '{APP_ID}'; set kernel.customer_id = '{CUSTOMER_ID}'; prepare legacy_visible as select summary from work_item_version order by summary"
            ))
            .map_err(|error| format!("prepare legacy query as query role: {error}"))?;
        assert_eq!(
            query_texts(&mut client, "execute legacy_visible")?,
            vec!["protected row"],
            "the legacy protocol must work before the policy revision activates"
        );
        client
            .batch_execute("reset role; reset session authorization")
            .map_err(|error| format!("restore installer principal: {error}"))?;

        let policy_revision = prepare_validate_activate(
            &mut client,
            &policy.schema,
            "policy-prepared",
            Some(&legacy_hash),
        )?;
        assert!(policy_revision > legacy_revision);
        for table in ["work_item_record", "work_item_version", "change_set"] {
            let row = client
                .query_one(
                    "select relrowsecurity, relforcerowsecurity, coalesce((select qual from pg_policies where schemaname=current_schema() and tablename=$1 and policyname='kernel_tenant_isolation'), '') from pg_class where oid=to_regclass(format('%I.%I', current_schema(), $1))",
                    &[&table],
                )
                .map_err(|error| format!("inspect {table} activation RLS: {error}"))?;
            let row_security: bool = row.get(0);
            let force_row_security: bool = row.get(1);
            let policy_qual: String = row.get(2);
            assert!(row_security, "{table} must enable RLS on policy activation");
            assert!(
                force_row_security,
                "{table} must force RLS on policy activation"
            );
            assert!(
                policy_qual.contains("kernel_policy_raw_table_access_allowed"),
                "{table} must apply the policy-aware raw access predicate: {policy_qual}"
            );
        }

        client
            .batch_execute(&format!(
                r#"set session authorization "{principal}";
                   set kernel.app_id = '{APP_ID}';
                   set kernel.customer_id = '{CUSTOMER_ID}';
                   set kernel.actor_id = 'actor_a';"#
            ))
            .map_err(|error| format!("restore restricted runtime principal: {error}"))?;
        client
            .batch_execute(&format!("set role \"{query_role}\""))
            .map_err(|error| format!("assume restricted query role: {error}"))?;
        assert!(
            query_texts(&mut client, "select summary from work_item_version")?.is_empty(),
            "the existing legacy temp view must not expose rows after ordinary activation"
        );
        assert!(
            query_texts(&mut client, "execute legacy_visible")?.is_empty(),
            "the already-prepared legacy query must not expose rows after ordinary activation"
        );
        client
            .batch_execute("reset role")
            .map_err(|error| format!("reset restricted query role: {error}"))?;
        let canonical = call(
            &mut client,
            "kernel_data_query",
            json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_version":policy.schema.version,"model_id":"work_item","as_of":"2026-01-01","select":["summary"]}),
        )?;
        assert_ok(&canonical);
        assert_eq!(
            canonical["data"][0]["values"]["summary"]["value"],
            "protected row"
        );

        assert_permission_denied(
            &mut client,
            &format!("set role \"{execution_owner}\""),
            "execution owner",
        );
        for table in [
            "schema_authorization_policy_source",
            "schema_authorization_policy_snapshot",
            "kernel_actor_membership",
        ] {
            assert_permission_denied(&mut client, &format!("select * from {table}"), table);
        }
        Ok(())
    })();

    match result {
        Ok(()) => cleanup
            .finish()
            .expect("remove isolated authorization fixture"),
        Err(error) => {
            if let Err(cleanup_error) = cleanup.finish() {
                eprintln!("authorization fixture cleanup after test failure: {cleanup_error}");
            }
            panic!("policy activation must close stale legacy prepared SQL: {error}");
        }
    }
}

fn prepare_validate_activate(
    client: &mut Client,
    schema: &kernel::Schema,
    release_id: &str,
    expected_active_hash: Option<&str>,
) -> Result<i64, String> {
    let schema_json = serde_json::to_value(schema).map_err(|error| error.to_string())?;
    let hash = schema_hash(schema);
    let prepared = call(
        client,
        "kernel_prepare_schema_revision",
        json!({
            "app_id":schema.app_id,
            "customer_id":schema.customer_id,
            "version":schema.version,
            "release_id":release_id,
            "activation_kind":"tenant_overlay",
            "schema_hash":hash,
            "base_artifact_hash":hash,
            "effective_artifact_hash":hash,
            "materialization_plan_hash":hash,
            "expected_active_effective_hash":expected_active_hash,
            "base_schema":schema_json,
            "customer_overlay":{},
            "schema":schema_json,
            "seed_change_sets":[],
            "phase_plan":[]
        }),
    )?;
    assert_ok(&prepared);
    let revision_id = prepared["data"]["schema_revision_id"]
        .as_i64()
        .ok_or_else(|| format!("prepared revision lacks id: {prepared}"))?;
    let ready = call(
        client,
        "kernel_validate_schema_revision_readiness",
        json!({
            "app_id":schema.app_id,
            "customer_id":schema.customer_id,
            "schema_revision_id":revision_id,
            "effective_artifact_hash":hash,
            "materialization_plan_hash":hash,
            "phase_results":[]
        }),
    )?;
    assert_ok(&ready);
    let activated = call(
        client,
        "kernel_activate_tenant_schema_revision",
        json!({
            "app_id":schema.app_id,
            "customer_id":schema.customer_id,
            "schema_revision_id":revision_id,
            "effective_artifact_hash":hash,
            "expected_active_effective_hash":expected_active_hash
        }),
    )?;
    assert_ok(&activated);
    Ok(revision_id)
}

fn manifest(version: &str, authorization: bool) -> Value {
    let mut manifest = json!({
      "app_id":APP_ID,"customer_id":CUSTOMER_ID,"version":version,
      "models":[{"id":"work_item","kind":"entity","label":"Work item","fields":[
        {"id":"owner","label":"Owner","type":"text","required":true},
        {"id":"summary","label":"Summary","type":"text"}
      ]}]
    });
    if authorization {
        manifest["authorization"] = json!({"roles":[{"id":"reviewer"}],"grants":[{
          "role":"reviewer","model":"work_item","operations":["read"],
          "read_fields":["summary"],"record":{"kind":"all"}
        }]});
    }
    manifest
}

fn call(client: &mut Client, function: &str, request: Value) -> Result<Value, String> {
    client
        .query_one(&format!("select {function}($1::jsonb)"), &[&request])
        .map(|row| row.get(0))
        .map_err(|error| {
            format!(
                "{function}: {error}; database error: {:?}",
                error.as_db_error()
            )
        })
}

fn query_texts(client: &mut Client, sql: &str) -> Result<Vec<String>, String> {
    client
        .query(sql, &[])
        .map(|rows| rows.into_iter().map(|row| row.get(0)).collect())
        .map_err(|error| format!("{sql}: {error}; database error: {:?}", error.as_db_error()))
}

fn scalar(client: &mut Client, sql: &str) -> Result<String, String> {
    client
        .query_one(sql, &[])
        .map(|row| row.get(0))
        .map_err(|error| error.to_string())
}

fn assert_permission_denied(client: &mut Client, sql: &str, target: &str) {
    let error = client.batch_execute(sql).expect_err(&format!(
        "{target} must deny the restricted runtime principal"
    ));
    assert_eq!(
        error.code(),
        Some(&SqlState::INSUFFICIENT_PRIVILEGE),
        "{target}: {error}"
    );
}

fn assert_ok(value: &Value) {
    assert_eq!(value["ok"], true, "{value}");
}

fn test_database_url() -> String {
    for variable in ["KERNEL_TEST_DATABASE_URL", "PLATFORM_TEST_DATABASE_URL"] {
        match env::var(variable) {
            Ok(database_url) if !database_url.trim().is_empty() => return database_url,
            Ok(_) | Err(env::VarError::NotPresent) => continue,
            Err(error) => panic!("read {variable}: {error}"),
        }
    }
    panic!(
        "policy prepared SQL test requires KERNEL_TEST_DATABASE_URL or PLATFORM_TEST_DATABASE_URL"
    );
}
