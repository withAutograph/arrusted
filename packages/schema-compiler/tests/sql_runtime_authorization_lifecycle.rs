use std::{env, sync::mpsc, thread, time::Duration};

use kernel::{connect_postgres, schema_hash};
use postgres::Client;
use schema_compiler::{
    compile_manifest_json, compile_sql_artifact_manifest, render_sql_artifact_bundle,
};
use serde_json::{json, Value};
use uuid::Uuid;

const APP_ID: &str = "authorization_lifecycle_fixture";
const CUSTOMER_ID: &str = "tenant_a";
const ACTOR_ID: &str = "actor_a";
const LONG_MODEL_ID: &str =
    "a_very_long_model_identifier_that_exceeds_the_postgresql_identifier_limit_for_storage";

struct Cleanup {
    database_url: String,
    schema: String,
    principal: String,
    runtime_role: Option<String>,
    complete: bool,
}

impl Cleanup {
    fn finish(&mut self) -> Result<(), String> {
        if self.complete {
            return Ok(());
        }
        let mut client = connect_postgres(&self.database_url)
            .map_err(|error| format!("connect cleanup PostgreSQL: {error}"))?;
        let revoke_runtime_role = self
            .runtime_role
            .as_ref()
            .map(|role| format!("revoke \"{role}\" from session_user;"))
            .unwrap_or_default();
        client
            .batch_execute(&format!(
                r#"rollback;
                   reset role;
                   reset session authorization;
                   set search_path to public;
                   {revoke_runtime_role}
                   drop schema if exists "{}" cascade;
                   drop role if exists "{}";"#,
                self.schema, self.principal
            ))
            .map_err(|error| format!("remove lifecycle fixture: {error}"))?;
        self.complete = true;
        Ok(())
    }
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        if let Err(error) = self.finish() {
            eprintln!("lifecycle fixture cleanup after panic: {error}");
        }
    }
}

#[test]
fn policy_activation_serializes_legacy_mutations_before_rechecking_policy() {
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
    let mut installer = connect_postgres(&database_url).expect("connect PostgreSQL");
    let schema = format!("kernel_authorization_lifecycle_{}", Uuid::new_v4().simple());
    let principal = format!("authorization_lifecycle_{}", Uuid::new_v4().simple());
    installer
        .batch_execute(&format!(
            "create schema \"{schema}\"; set search_path to \"{schema}\""
        ))
        .expect("create isolated schema");
    let mut cleanup = Cleanup {
        database_url: database_url.clone(),
        schema: schema.clone(),
        principal: principal.clone(),
        runtime_role: None,
        complete: false,
    };

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        (|| -> Result<(), String> {
            installer
                .batch_execute(&legacy_bundle)
                .map_err(|error| format!("install legacy bundle: {error}"))?;
            let runtime_role = scalar(
                &mut installer,
                "select kernel_installer_capability_role('runtime')",
            )?;
            cleanup.runtime_role = Some(runtime_role.clone());
            installer
            .batch_execute(&format!(
                "grant \"{runtime_role}\" to session_user; create role \"{principal}\" nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls; grant \"{runtime_role}\" to \"{principal}\"; grant usage on schema \"{schema}\" to \"{principal}\""
            ))
            .map_err(|error| format!("create restricted runtime principal: {error}"))?;

            let legacy_hash = schema_hash(&legacy.schema);
            let legacy_revision = prepare_validate_activate(
                &mut installer,
                &legacy.schema,
                "legacy-lifecycle",
                None,
            )?;
            bind_runtime_principal(&mut installer, &principal, CUSTOMER_ID)?;
            bind_runtime_principal(&mut installer, &principal, "no-active")?;

            assume_runtime_principal(&mut installer, &principal)?;
            let legacy_run = agent_run("legacy-run", legacy_revision);
            let first_legacy_record = call(
                &mut installer,
                "kernel_record_agent_run",
                legacy_run.clone(),
            )?;
            assert_ok(&first_legacy_record);
            assert_eq!(
                call(&mut installer, "kernel_record_agent_run", legacy_run)?,
                first_legacy_record,
                "legacy agent record must replay exactly before policy activation"
            );
            let no_active = call(
                &mut installer,
                "kernel_record_agent_run",
                agent_run_for_customer("no-active", "no-active-run", 1),
            )?;
            assert_error(&no_active, "active_schema_missing");
            installer
                .batch_execute("reset session authorization")
                .map_err(|error| format!("restore installer principal: {error}"))?;

            installer
                .batch_execute(&policy_bundle)
                .map_err(|error| format!("install policy bundle before activation: {error}"))?;
            let policy_revision = prepare_validate(
                &mut installer,
                &policy.schema,
                "policy-lifecycle",
                Some(&legacy_hash),
            )?;

            installer
                .batch_execute("begin")
                .map_err(|error| format!("begin activation transaction: {error}"))?;
            installer
            .query_one(
                "select pg_advisory_xact_lock(hashtext('postgres-schema:' || current_schema() || ':materialize-tenant:' || $1 || ':' || $2 || ':schema-activation')::bigint)",
                &[&APP_ID, &CUSTOMER_ID],
            )
            .map_err(|error| format!("acquire exclusive activation lock: {error}"))?;

            let requests = vec![
                (
                    "agent record",
                    "kernel_record_agent_run",
                    agent_run("blocked-record", legacy_revision),
                ),
                (
                    "agent status",
                    "kernel_update_agent_run_status",
                    json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"run_id":"legacy-run","status":"completed"}),
                ),
                (
                    "draft approve",
                    "kernel_approve_draft_change_set",
                    json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"change_set_id":999_001}),
                ),
                (
                    "draft revert",
                    "kernel_revert_change_set",
                    json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"change_set_id":999_002,"idempotency_key":"blocked-revert"}),
                ),
            ];
            let (started_tx, started_rx) = mpsc::channel();
            let mut callers = Vec::new();
            for (name, function, request) in requests {
                let database_url = database_url.clone();
                let schema = schema.clone();
                let principal = principal.clone();
                let started_tx = started_tx.clone();
                callers.push((
                name,
                thread::spawn(move || -> Result<Value, String> {
                    let mut client = connect_postgres(&database_url)
                        .map_err(|error| format!("connect {name}: {error}"))?;
                    client
                        .batch_execute(&format!(
                            "set search_path to \"{schema}\"; set statement_timeout = '5s'; set session authorization \"{principal}\"; set kernel.actor_id = '{ACTOR_ID}'"
                        ))
                        .map_err(|error| format!("assume runtime principal for {name}: {error}"))?;
                    let pid: i32 = client
                        .query_one("select pg_backend_pid()", &[])
                        .map_err(|error| format!("read {name} backend pid: {error}"))?
                        .get(0);
                    started_tx
                        .send((name, pid))
                        .map_err(|error| format!("announce {name} caller: {error}"))?;
                    call(&mut client, function, request)
                }),
            ));
            }
            drop(started_tx);
            for _ in 0..callers.len() {
                let (name, pid) = started_rx
                    .recv_timeout(Duration::from_secs(5))
                    .map_err(|error| format!("wait for blocked caller: {error}"))?;
                wait_for_advisory_lock(&mut installer, pid, name)?;
            }

            let activated = call(
                &mut installer,
                "kernel_activate_tenant_schema_revision",
                json!({
                    "app_id":APP_ID,
                    "customer_id":CUSTOMER_ID,
                    "schema_revision_id":policy_revision,
                    "effective_artifact_hash":schema_hash(&policy.schema),
                    "expected_active_effective_hash":legacy_hash,
                }),
            )?;
            assert_ok(&activated);
            installer
                .batch_execute("commit")
                .map_err(|error| format!("commit policy activation: {error}"))?;

            for (name, caller) in callers {
                let response = caller
                    .join()
                    .map_err(|_| format!("{name} caller panicked"))??;
                assert_error(&response, "unsupported_capability");
            }
            let agent_count: i64 = installer
                .query_one(
                    "select count(*) from agent_run where app_id=$1 and customer_id=$2",
                    &[&APP_ID, &CUSTOMER_ID],
                )
                .map_err(|error| format!("count agent rows after policy activation: {error}"))?
                .get(0);
            assert_eq!(
                agent_count, 1,
                "blocked record must not insert an agent run"
            );
            let legacy_status: String = installer
            .query_one(
                "select status from agent_run where app_id=$1 and customer_id=$2 and run_id='legacy-run'",
                &[&APP_ID, &CUSTOMER_ID],
            )
            .map_err(|error| format!("read legacy agent status: {error}"))?
            .get(0);
            assert_eq!(
                legacy_status, "recorded",
                "blocked status call must not mutate legacy run"
            );
            let change_set_count: i64 = installer
                .query_one(
                    "select count(*) from change_set where app_id=$1 and customer_id=$2",
                    &[&APP_ID, &CUSTOMER_ID],
                )
                .map_err(|error| format!("count change sets after policy activation: {error}"))?
                .get(0);
            assert_eq!(
                change_set_count, 0,
                "blocked draft calls must not create a change set"
            );
            Ok(())
        })()
    }));
    installer.batch_execute("rollback").ok();

    match result {
        Ok(Ok(())) => cleanup.finish().expect("remove lifecycle fixture"),
        Ok(Err(error)) => {
            if let Err(cleanup_error) = cleanup.finish() {
                eprintln!("lifecycle fixture cleanup after failure: {cleanup_error}");
            }
            panic!("activation must serialize then recheck policy: {error}");
        }
        Err(panic) => {
            if let Err(cleanup_error) = cleanup.finish() {
                eprintln!("lifecycle fixture cleanup after panic: {cleanup_error}");
            }
            std::panic::resume_unwind(panic);
        }
    }
}

#[test]
fn declared_policy_activates_with_bounded_long_model_physical_tables() {
    let database_url = test_database_url();
    let compiled = compile_manifest_json(&long_policy_manifest().to_string())
        .expect("compile long-model policy manifest");
    let sql = compile_sql_artifact_manifest(&compiled).expect("compile long-model policy SQL");
    let tables = vec![
        kernel::bounded_physical_identifier(&format!("{LONG_MODEL_ID}_record")),
        kernel::bounded_physical_identifier(&format!("{LONG_MODEL_ID}_version")),
    ];
    assert!(tables.iter().all(|table| table.len() == 63), "{tables:?}");
    assert_ne!(tables[0], tables[1]);
    for table in &tables {
        assert!(
            sql.artifacts.iter().any(|artifact| artifact.kind
                == schema_compiler::SqlArtifactKind::Table
                && artifact.name == *table),
            "missing bounded physical table {table}"
        );
    }
    let bundle = render_sql_artifact_bundle(&sql);
    let mut installer = connect_postgres(&database_url).expect("connect PostgreSQL");
    let schema = format!(
        "kernel_authorization_long_model_{}",
        Uuid::new_v4().simple()
    );
    installer
        .batch_execute(&format!(
            "create schema \"{schema}\"; set search_path to \"{schema}\""
        ))
        .expect("create fixture schema");
    let mut cleanup = Cleanup {
        database_url,
        schema,
        principal: format!("authorization_long_model_{}", Uuid::new_v4().simple()),
        runtime_role: None,
        complete: false,
    };
    let result = (|| -> Result<(), String> {
        installer
            .batch_execute(&bundle)
            .map_err(|error| format!("install long-model policy bundle: {error}"))?;
        let revision_id =
            prepare_validate_activate(&mut installer, &compiled.schema, "long-model-policy", None)?;
        let active: bool = installer.query_one(
            "select authorization_policy_declared from schema_revision where id=$1 and activated_at is not null", &[&revision_id],
        ).map_err(|error| format!("read active long-model revision: {error}"))?.get(0);
        assert!(active);
        for table in tables {
            let raw_guarded: bool = installer.query_one(
                "select exists (select 1 from pg_policies where schemaname=current_schema() and tablename=$1 and policyname='kernel_tenant_isolation' and qual like '%kernel_policy_raw_table_access_allowed%')", &[&table],
            ).map_err(|error| format!("inspect raw guard for {table}: {error}"))?.get(0);
            assert!(
                raw_guarded,
                "{table} must retain its raw authorization guard"
            );
        }
        Ok(())
    })();
    installer.batch_execute("rollback").ok();
    match result {
        Ok(()) => cleanup.finish().expect("remove long-model fixture"),
        Err(error) => {
            if let Err(cleanup_error) = cleanup.finish() {
                eprintln!("long-model fixture cleanup after failure: {cleanup_error}");
            }
            panic!("long-model declared policy activation must succeed: {error}");
        }
    }
}

fn bind_runtime_principal(
    client: &mut Client,
    principal: &str,
    customer_id: &str,
) -> Result<(), String> {
    assert_ok(&call(
        client,
        "kernel_bind_principal_scope",
        json!({"principal_name":principal,"capability":"runtime","app_id":APP_ID,"customer_id":customer_id}),
    )?);
    assert_ok(&call(
        client,
        "kernel_bind_actor_membership",
        json!({"actor_kind":"human","principal_name":principal,"app_id":APP_ID,"customer_id":customer_id,"actor_id":ACTOR_ID,"role":"reviewer"}),
    )?);
    Ok(())
}

fn assume_runtime_principal(client: &mut Client, principal: &str) -> Result<(), String> {
    client
        .batch_execute(&format!(
            "set session authorization \"{principal}\"; set kernel.actor_id = '{ACTOR_ID}'"
        ))
        .map_err(|error| format!("assume restricted runtime principal: {error}"))
}

fn prepare_validate_activate(
    client: &mut Client,
    schema: &kernel::Schema,
    release_id: &str,
    expected_active_hash: Option<&str>,
) -> Result<i64, String> {
    let revision_id = prepare_validate(client, schema, release_id, expected_active_hash)?;
    let hash = schema_hash(schema);
    let activated = call(
        client,
        "kernel_activate_tenant_schema_revision",
        json!({"app_id":schema.app_id,"customer_id":schema.customer_id,"schema_revision_id":revision_id,"effective_artifact_hash":hash,"expected_active_effective_hash":expected_active_hash}),
    )?;
    assert_ok(&activated);
    Ok(revision_id)
}

fn prepare_validate(
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
            "app_id":schema.app_id,"customer_id":schema.customer_id,"version":schema.version,
            "release_id":release_id,"activation_kind":"tenant_overlay","schema_hash":hash,
            "base_artifact_hash":hash,"effective_artifact_hash":hash,"materialization_plan_hash":hash,
            "expected_active_effective_hash":expected_active_hash,"base_schema":schema_json,
            "customer_overlay":{},"schema":schema_json,"seed_change_sets":[],"phase_plan":[]
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
            "app_id":schema.app_id,"customer_id":schema.customer_id,"schema_revision_id":revision_id,
            "effective_artifact_hash":hash,"materialization_plan_hash":hash,"phase_results":[]
        }),
    )?;
    assert_ok(&ready);
    Ok(revision_id)
}
fn long_policy_manifest() -> Value {
    let mut value = manifest("long-model-policy", true);
    value["models"][0]["id"] = json!(LONG_MODEL_ID);
    value["authorization"]["grants"][0]["model"] = json!(LONG_MODEL_ID);
    value
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

fn agent_run(run_id: &str, schema_revision_id: i64) -> Value {
    agent_run_for_customer(CUSTOMER_ID, run_id, schema_revision_id)
}

fn agent_run_for_customer(customer_id: &str, run_id: &str, schema_revision_id: i64) -> Value {
    json!({
        "app_id":APP_ID,"customer_id":customer_id,"run_id":run_id,"status":"recorded",
        "schema_revision_id":schema_revision_id,"actor_id":ACTOR_ID,
        "agent_identity_id":"fixture-agent","execution_profile_id":"fixture-profile"
    })
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

fn scalar(client: &mut Client, sql: &str) -> Result<String, String> {
    client
        .query_one(sql, &[])
        .map(|row| row.get(0))
        .map_err(|error| error.to_string())
}

fn wait_for_advisory_lock(
    observer: &mut Client,
    backend_pid: i32,
    name: &str,
) -> Result<(), String> {
    for _ in 0..100 {
        let blocked: bool = observer
            .query_one(
                "select exists (select 1 from pg_locks where pid=$1 and locktype='advisory' and not granted)",
                &[&backend_pid],
            )
            .map_err(|error| format!("inspect {name} advisory lock: {error}"))?
            .get(0);
        if blocked {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(20));
    }
    Err(format!(
        "{name} backend {backend_pid} did not block on the activation advisory lock"
    ))
}

fn assert_ok(value: &Value) {
    assert_eq!(value["ok"], true, "{value}");
}

fn assert_error(value: &Value, code: &str) {
    assert_eq!(value["ok"], false, "{value}");
    assert_eq!(value["error"]["code"], code, "{value}");
}

fn test_database_url() -> String {
    for variable in ["KERNEL_TEST_DATABASE_URL", "PLATFORM_TEST_DATABASE_URL"] {
        match env::var(variable) {
            Ok(database_url) if !database_url.trim().is_empty() => return database_url,
            Ok(_) | Err(env::VarError::NotPresent) => continue,
            Err(error) => panic!("read {variable}: {error}"),
        }
    }
    panic!("lifecycle SQL test requires KERNEL_TEST_DATABASE_URL or PLATFORM_TEST_DATABASE_URL");
}
