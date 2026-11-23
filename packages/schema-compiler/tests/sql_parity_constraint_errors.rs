use kernel::connect_postgres;
use postgres::Client;
use schema_compiler::{
    compile_manifest_json, compile_sql_artifact_manifest, render_sql_artifact_bundle,
};
use serde_json::{json, Value};
use support::trusted_human;
use uuid::Uuid;

mod support;

fn fixture() -> Value {
    json!({
        "app_id":"constraint_errors", "customer_id":"tenant_a", "version":"errors-v1",
        "models":[
            {"id":"asset","kind":"entity","label":"Asset","fields":[
                {"id":"title","label":"Title","type":"text","required":true,"is_unique":true},
                {"id":"amount","label":"Amount","type":"number","required":true},
                {"id":"budget","label":"Budget","type":"number","required":true}
            ]},
            {"id":"category","kind":"lookup","label":"Category","fields":[
                {"id":"name","label":"Name","type":"text","required":true}
            ]}
        ],
        "constraints":[
            {"id":"nonnegative","model":"asset","label":"Nonnegative","authority":"authoritative",
             "expression":{"type":"compare_literal","field":"amount","op":"gte","value":{"type":"number","value":"0"}},"message":"Private author message"},
            {"id":"within_budget","model":"asset","label":"Budget","authority":"authoritative",
             "expression":{"type":"compare_fields","left":"amount","right":"budget","op":"lte"},"message":"Within budget"},
            {"id":"category_name_is_not_empty_and_has_a_bounded_length_for_diagnostic_testing","model":"category","label":"Name length","authority":"authoritative",
             "expression":{"type":"text_length","field":"name","min":1,"max":20},"message":"Valid category name"}
        ]
    })
}

struct Harness {
    client: Client,
    name: String,
    schema: Value,
    bundle: String,
    revision: i64,
}
impl Harness {
    fn new() -> Option<Self> {
        Self::new_with_manifest(fixture())
    }

    fn new_with_manifest(manifest: Value) -> Option<Self> {
        let mut h = Self::unprepared(manifest)?;
        let prepared = h.call("kernel_prepare_schema_revision", prepare_request(&h.schema));
        assert_eq!(prepared["ok"], true, "{prepared}");
        h.revision = prepared["data"]["schema_revision_id"].as_i64().unwrap();
        let ready = h.call(
            "kernel_validate_schema_revision_readiness",
            json!({
                "app_id":"constraint_errors","customer_id":"tenant_a","schema_revision_id":h.revision,
                "effective_artifact_hash":"2".repeat(64),"materialization_plan_hash":"3".repeat(64),"phase_results":[]
            }),
        );
        assert_eq!(ready["ok"], true, "{ready}");
        let activated = h.call(
            "kernel_activate_app_base_schema_revision",
            json!({
                "app_id":"constraint_errors","release_id":"errors-v1","base_artifact_hash":"2".repeat(64),
                "targets":[{"customer_id":"tenant_a","schema_revision_id":h.revision,"effective_artifact_hash":"2".repeat(64),"expected_active_effective_hash":null}]
            }),
        );
        assert_eq!(activated["ok"], true, "{activated}");
        Some(h)
    }

    fn unprepared(manifest: Value) -> Option<Self> {
        let url = match std::env::var("KERNEL_TEST_DATABASE_URL") {
            Ok(url) => url,
            Err(std::env::VarError::NotPresent) => {
                // The dedicated schema:test-parity runner requires this URL
                // and rejects skipped targets; general Rust unit runs do not.
                eprintln!("skipping constraint error parity: KERNEL_TEST_DATABASE_URL is absent");
                return None;
            }
            Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
        };
        let mut client = connect_postgres(&url).unwrap();
        let name = format!("constraint_errors_{}", Uuid::new_v4().simple());
        client
            .batch_execute(&format!("create schema {name}; set search_path to {name}"))
            .unwrap();
        trusted_human::before_install(&mut client);
        let compiled = compile_manifest_json(&manifest.to_string()).unwrap();
        let schema = serde_json::to_value(&compiled.schema).unwrap();
        let bundle = render_sql_artifact_bundle(&compile_sql_artifact_manifest(&compiled).unwrap());
        client.batch_execute(&bundle).unwrap();
        trusted_human::bind(&mut client, "constraint_errors", "tenant_a", "reviewer");
        trusted_human::bind(&mut client, "constraint_errors", "tenant_b", "reviewer");
        Some(Self {
            client,
            name,
            schema,
            bundle,
            revision: 0,
        })
    }

    fn call(&mut self, operation: &str, input: Value) -> Value {
        self.client
            .query_one(&format!("select {operation}($1::jsonb)"), &[&input])
            .unwrap()
            .get(0)
    }

    fn apply(&mut self, key: &str, writes: Value) -> Value {
        self.call("kernel_apply_change_set",json!({
            "app_id":"constraint_errors","customer_id":"tenant_a","schema_revision_id":self.revision,
            "actor_id":"reviewer","source_kind":"test","idempotency_key":key,"mode":"mainline","writes":writes
        }))
    }

    fn validate(&mut self) -> Value {
        self.call(
            "kernel_validate_materialized_schema_revision",
            json!({"schema":self.schema,"expected_schema_hash":"1".repeat(64)}),
        )
    }
}

fn prepare_request(schema: &Value) -> Value {
    prepare_request_for(schema, "tenant_a", "app_base")
}

fn prepare_request_for(schema: &Value, customer_id: &str, activation_kind: &str) -> Value {
    json!({
        "app_id":"constraint_errors","customer_id":customer_id,"version":schema["version"],"release_id":"errors-v1",
        "activation_kind":activation_kind,"schema_hash":"1".repeat(64),"base_artifact_hash":"2".repeat(64),
        "effective_artifact_hash":"2".repeat(64),"materialization_plan_hash":"3".repeat(64),
        "expected_active_effective_hash":null,"base_schema":schema,"schema":schema,"customer_overlay":{},"phase_plan":[]
    })
}

impl Drop for Harness {
    fn drop(&mut self) {
        support::drop_generated_sql_fixture(&mut self.client, &self.name);
    }
}

#[test]
fn catalog_bundle_binds_compiler_scope_for_forced_rls_non_bypass_owner() {
    let url = match std::env::var("KERNEL_TEST_DATABASE_URL") {
        Ok(url) => url,
        Err(std::env::VarError::NotPresent) => {
            eprintln!("skipping forced-RLS catalog install: KERNEL_TEST_DATABASE_URL is absent");
            return;
        }
        Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
    };
    let mut client = connect_postgres(&url).expect("connect forced-RLS catalog install fixture");
    let suffix = Uuid::new_v4().simple();
    let schema_name = format!("constraint_catalog_rls_{suffix}");
    let owner_name = format!("{schema_name}_owner");
    let compiled = compile_manifest_json(&fixture().to_string()).expect("compile fixture");
    let bundle = render_sql_artifact_bundle(
        &compile_sql_artifact_manifest(&compiled).expect("compile SQL bundle"),
    );

    let result = (|| -> Result<(), String> {
        client
            .batch_execute(&format!(
                r#"
                create role "{owner_name}" nologin createrole nobypassrls;
                grant "{owner_name}" to current_user;
                create schema "{schema_name}" authorization "{owner_name}";
                set search_path to "{schema_name}";
                set role "{owner_name}";
                "#
            ))
            .map_err(|error| format!("provision forced-RLS owner: {error}"))?;
        trusted_human::before_install(&mut client);
        client
            .batch_execute(&bundle)
            .map_err(|error| format!("first generated bundle install: {error}"))?;
        let bypasses_rls: bool = client
            .query_one(
                "select rolbypassrls from pg_roles where rolname = current_user",
                &[],
            )
            .map_err(|error| format!("read forced-RLS owner: {error}"))?
            .get(0);
        if bypasses_rls {
            return Err("forced-RLS fixture owner unexpectedly bypasses RLS".to_string());
        }
        client
            .batch_execute("alter table schema_constraint_identity_source force row level security")
            .map_err(|error| format!("force catalog source RLS: {error}"))?;
        client.batch_execute(&bundle).map_err(|error| {
            format!("repeat generated bundle install under forced RLS: {error}")
        })?;
        client
            .query_one(
                "select set_config('kernel.app_id', $1, false), set_config('kernel.customer_id', $2, false)",
                &[&"constraint_errors", &"tenant_a"],
            )
            .map_err(|error| format!("bind catalog fixture scope: {error}"))?;
        let catalogs: i64 = client
            .query_one(
                "select count(*) from schema_constraint_identity_source",
                &[],
            )
            .map_err(|error| format!("read repeated catalog source: {error}"))?
            .get(0);
        if catalogs != 1 {
            return Err(format!(
                "expected exactly one catalog source after replay, found {catalogs}"
            ));
        }
        Ok(())
    })();

    support::drop_generated_sql_fixture(&mut client, &schema_name);
    client.batch_execute("discard temp").unwrap();
    let quoted_owner = owner_name.replace('"', "\"\"");
    client
        .batch_execute(&format!(
            "revoke \"{quoted_owner}\" from current_user; drop role \"{quoted_owner}\""
        ))
        .expect("remove forced-RLS fixture owner");
    let owner_remains: bool = client
        .query_one("select to_regrole($1) is not null", &[&owner_name])
        .expect("verify forced-RLS fixture owner cleanup")
        .get(0);
    assert!(!owner_remains);
    if let Err(error) = result {
        panic!("{error}");
    }
}
#[test]
fn missing_catalog_source_rejects_first_prepare_without_a_revision_write() {
    let Some(mut h) = Harness::unprepared(fixture()) else {
        return;
    };
    h.client
        .execute(
            "delete from schema_constraint_identity_source where app_id = $1 and schema_version = $2",
            &[&"constraint_errors", &"errors-v1"],
        )
        .unwrap();

    let response = h.call("kernel_prepare_schema_revision", prepare_request(&h.schema));
    assert_eq!(response["error"]["code"], "schema_drift", "{response}");
    assert!(response["error"]["details"]
        .as_array()
        .unwrap()
        .iter()
        .any(|detail| detail["code"] == "schema_drift"
            && detail["message"]
                .as_str()
                .is_some_and(|message| message.starts_with("schema_constraint_identity_source:"))));
    let revisions: i64 = h
        .client
        .query_one("select count(*) from schema_revision", &[])
        .unwrap()
        .get(0);
    assert_eq!(revisions, 0);
}

#[test]
fn empty_compiler_catalog_is_present_and_prepares_successfully() {
    let mut manifest = fixture();
    manifest["constraints"] = json!([]);
    let Some(mut h) = Harness::unprepared(manifest) else {
        return;
    };
    let source_catalog: Value = h
        .client
        .query_one(
            "select catalog from schema_constraint_identity_source where app_id = $1 and schema_version = $2",
            &[&"constraint_errors", &"errors-v1"],
        )
        .unwrap()
        .get(0);
    assert_eq!(source_catalog, json!([]));

    let prepared = h.call("kernel_prepare_schema_revision", prepare_request(&h.schema));
    assert_eq!(prepared["ok"], true, "{prepared}");
    let revision = prepared["data"]["schema_revision_id"].as_i64().unwrap();
    let snapshot: Value = h
        .client
        .query_one(
            "select catalog from schema_constraint_identity where schema_revision_id = $1",
            &[&revision],
        )
        .unwrap()
        .get(0);
    assert_eq!(snapshot, json!([]));
}

#[test]
fn source_less_active_legacy_revision_validates_and_returns_generic_check_errors() {
    let Some(mut h) = Harness::new() else {
        return;
    };
    h.client
        .batch_execute(
            "delete from schema_constraint_identity; delete from schema_constraint_identity_source",
        )
        .unwrap();

    assert_eq!(h.validate()["ok"], true);
    let failure = h.apply("legacy-generic-check", json!([write("legacy", "-1", "10")]));
    assert_eq!(failure["error"]["code"], "database_error", "{failure}");
}

#[test]
fn extension_prepare_uses_the_catalog_for_its_base_schema_version() {
    let Some(mut h) = Harness::unprepared(fixture()) else {
        return;
    };
    let mut effective_schema = h.schema.clone();
    effective_schema["version"] = json!("errors-v1-overlay");
    let mut request = prepare_request(&h.schema);
    request["version"] = json!("errors-v1-overlay");
    request["activation_kind"] = json!("tenant_overlay");
    request["schema"] = effective_schema;

    let prepared = h.call("kernel_prepare_schema_revision", request);
    assert_eq!(prepared["ok"], true, "{prepared}");
}

#[test]
fn compiler_catalog_definition_is_shared_only_with_authorized_tenant_snapshots() {
    let Some(mut h) = Harness::unprepared(fixture()) else {
        return;
    };
    let first = h.call("kernel_prepare_schema_revision", prepare_request(&h.schema));
    assert_eq!(first["ok"], true, "{first}");
    let first_revision = first["data"]["schema_revision_id"].as_i64().unwrap();

    let mut second_schema = h.schema.clone();
    second_schema["customer_id"] = json!("tenant_b");
    let second = h.call(
        "kernel_prepare_schema_revision",
        prepare_request_for(&second_schema, "tenant_b", "app_base"),
    );
    assert_eq!(second["ok"], true, "{second}");
    let second_revision = second["data"]["schema_revision_id"].as_i64().unwrap();

    for (customer_id, revision) in [("tenant_a", first_revision), ("tenant_b", second_revision)] {
        let ready = h.call(
            "kernel_validate_schema_revision_readiness",
            json!({
                "app_id":"constraint_errors","customer_id":customer_id,"schema_revision_id":revision,
                "effective_artifact_hash":"2".repeat(64),"materialization_plan_hash":"3".repeat(64),"phase_results":[]
            }),
        );
        assert_eq!(ready["ok"], true, "{ready}");
    }
    let activated = h.call(
        "kernel_activate_app_base_schema_revision",
        json!({
            "app_id":"constraint_errors","release_id":"errors-v1","base_artifact_hash":"2".repeat(64),
            "targets":[
                {"customer_id":"tenant_a","schema_revision_id":first_revision,"effective_artifact_hash":"2".repeat(64),"expected_active_effective_hash":null},
                {"customer_id":"tenant_b","schema_revision_id":second_revision,"effective_artifact_hash":"2".repeat(64),"expected_active_effective_hash":null}
            ]
        }),
    );
    assert_eq!(activated["ok"], true, "{activated}");

    let source_count: i64 = h
        .client
        .query_one(
            "select count(*) from schema_constraint_identity_source where app_id = $1 and schema_version = $2",
            &[&"constraint_errors", &"errors-v1"],
        )
        .unwrap()
        .get(0);
    assert_eq!(source_count, 1);
    let first_catalog: Value = h
        .client
        .query_one(
            "select catalog from schema_constraint_identity where schema_revision_id = $1",
            &[&first_revision],
        )
        .unwrap()
        .get(0);
    let second_catalog: Value = h
        .client
        .query_one(
            "select catalog from schema_constraint_identity where schema_revision_id = $1",
            &[&second_revision],
        )
        .unwrap()
        .get(0);
    assert_eq!(first_catalog, second_catalog);

    let typed = h.call(
        "kernel_apply_change_set",
        json!({
            "app_id":"constraint_errors","customer_id":"tenant_b","schema_revision_id":second_revision,
            "actor_id":"reviewer","source_kind":"test","idempotency_key":"tenant-b-negative-check","mode":"mainline",
            "writes":[write("tenant-b-negative", "-1", "10")]
        }),
    );
    assert_eq!(typed["error"]["code"], "constraint_violation", "{typed}");
    assert!(typed["error"]["details"]
        .as_array()
        .unwrap()
        .iter()
        .any(|detail| detail["path"] == "field" && detail["message"] == "amount"));
}

#[test]
fn app_catalog_source_denies_unbound_and_cross_app_principals() {
    let Some(mut h) = Harness::unprepared(fixture()) else {
        return;
    };
    let role_name = format!("catalog_reader_{}", Uuid::new_v4().simple());
    let runtime_role: String = h
        .client
        .query_one("select kernel_installer_capability_role('runtime')", &[])
        .unwrap()
        .get(0);
    let execution_role = establish_generated_execution_owner(&mut h.client)
        .expect("establish generated execution-owner identity");
    let result = (|| -> Result<(), String> {
        h.client
            .batch_execute(&format!(
                r#"create role "{role_name}" nologin; grant "{runtime_role}" to "{role_name}"; grant usage on schema "{}" to "{role_name}"; grant select on schema_constraint_identity_source to "{role_name}"; grant execute on function kernel_principal_scope_authorized(text,text,text,text) to "{role_name}""#,
                h.name
            ))
            .map_err(|error| format!("provision catalog reader: {error}"))?;
        let binding = h.call(
            "kernel_bind_principal_scope",
            json!({
                "principal_name": role_name, "capability": "runtime",
                "app_id": "other_app", "customer_id": "tenant_b"
            }),
        );
        if binding["ok"] != true {
            return Err(format!("bind other-app principal: {binding}"));
        }
        h.client
            .batch_execute(&format!(
                r#"set session authorization "{role_name}"; set kernel.app_id = 'other_app'; set kernel.customer_id = 'tenant_b'"#
            ))
            .map_err(|error| format!("assume other-app principal: {error}"))?;
        let cross_app_visible: bool = h
            .client
            .query_one(
                "select exists(select 1 from schema_constraint_identity_source where app_id = 'constraint_errors' and schema_version = 'errors-v1')",
                &[],
            )
            .map_err(|error| format!("read source as other app: {error}"))?
            .get(0);
        if cross_app_visible {
            return Err("other-app principal could read this catalog definition".to_string());
        }
        h.client
            .batch_execute(&format!(
                r#"reset session authorization; delete from kernel_principal_scope where principal_name = '{role_name}'::name"#
            ))
            .map_err(|error| format!("remove other-app binding: {error}"))?;
        h.client
            .batch_execute(&format!(
                r#"set session authorization "{role_name}"; set kernel.app_id = 'constraint_errors'; set kernel.customer_id = 'tenant_b'"#
            ))
            .map_err(|error| format!("assume unbound principal: {error}"))?;
        let unbound_visible: bool = h
            .client
            .query_one(
                "select exists(select 1 from schema_constraint_identity_source where app_id = 'constraint_errors' and schema_version = 'errors-v1')",
                &[],
            )
            .map_err(|error| format!("read source as unbound principal: {error}"))?
            .get(0);
        if unbound_visible {
            return Err("unbound principal could read app catalog source".to_string());
        }
        Ok(())
    })();
    h.client
        .batch_execute(&format!(
            r#"reset session authorization; delete from kernel_principal_scope where principal_name = '{role_name}'::name; revoke execute on function kernel_principal_scope_authorized(text,text,text,text) from "{role_name}"; revoke select on schema_constraint_identity_source from "{role_name}"; revoke usage on schema "{}" from "{role_name}"; revoke "{runtime_role}" from "{role_name}"; drop role "{role_name}"; revoke "{execution_role}" from current_user"#,
            h.name
        ))
        .expect("remove catalog reader");
    if let Err(error) = result {
        panic!("{error}");
    }
}

#[test]
fn app_catalog_source_and_snapshots_require_the_bound_tenant_scope() {
    let Some(mut h) = Harness::unprepared(fixture()) else {
        return;
    };
    let prepared = h.call("kernel_prepare_schema_revision", prepare_request(&h.schema));
    assert_eq!(prepared["ok"], true, "{prepared}");
    let tenant_a_revision = prepared["data"]["schema_revision_id"].as_i64().unwrap();
    let mut tenant_b_schema = h.schema.clone();
    tenant_b_schema["customer_id"] = json!("tenant_b");
    let prepared = h.call(
        "kernel_prepare_schema_revision",
        prepare_request_for(&tenant_b_schema, "tenant_b", "app_base"),
    );
    assert_eq!(prepared["ok"], true, "{prepared}");
    let tenant_b_revision = prepared["data"]["schema_revision_id"].as_i64().unwrap();
    for (customer_id, revision) in [
        ("tenant_a", tenant_a_revision),
        ("tenant_b", tenant_b_revision),
    ] {
        let ready = h.call(
            "kernel_validate_schema_revision_readiness",
            json!({
                "app_id":"constraint_errors","customer_id":customer_id,"schema_revision_id":revision,
                "effective_artifact_hash":"2".repeat(64),"materialization_plan_hash":"3".repeat(64),"phase_results":[]
            }),
        );
        assert_eq!(ready["ok"], true, "{ready}");
    }
    let activated = h.call(
        "kernel_activate_app_base_schema_revision",
        json!({
            "app_id":"constraint_errors","release_id":"errors-v1","base_artifact_hash":"2".repeat(64),
            "targets":[
                {"customer_id":"tenant_a","schema_revision_id":tenant_a_revision,"effective_artifact_hash":"2".repeat(64),"expected_active_effective_hash":null},
                {"customer_id":"tenant_b","schema_revision_id":tenant_b_revision,"effective_artifact_hash":"2".repeat(64),"expected_active_effective_hash":null}
            ]
        }),
    );
    assert_eq!(activated["ok"], true, "{activated}");

    let role_name = format!("catalog_scope_{}", Uuid::new_v4().simple());
    let runtime_role: String = h
        .client
        .query_one("select kernel_installer_capability_role('runtime')", &[])
        .unwrap()
        .get(0);
    let execution_role = establish_generated_execution_owner(&mut h.client)
        .expect("establish generated execution-owner identity");
    let result = (|| -> Result<(), String> {
        h.client
            .batch_execute(&format!(
                r#"create role "{role_name}" nologin; grant "{runtime_role}" to "{role_name}"; grant usage on schema "{}" to "{role_name}"; grant select on schema_constraint_identity_source, schema_constraint_identity to "{role_name}"; grant execute on function kernel_principal_scope_authorized(text,text,text,text) to "{role_name}""#,
                h.name
            ))
            .map_err(|error| format!("provision bound catalog reader: {error}"))?;
        let binding = h.call(
            "kernel_bind_principal_scope",
            json!({
                "principal_name": role_name, "capability": "runtime",
                "app_id": "constraint_errors", "customer_id": "tenant_b"
            }),
        );
        if binding["ok"] != true {
            return Err(format!("bind tenant-b principal: {binding}"));
        }
        h.client
            .batch_execute(&format!(
                r#"set session authorization "{role_name}"; set kernel.app_id = 'constraint_errors'; set kernel.customer_id = 'tenant_b'"#
            ))
            .map_err(|error| format!("assume bound tenant-b principal: {error}"))?;
        let source_visible: bool = h
            .client
            .query_one(
                "select exists(select 1 from schema_constraint_identity_source where app_id = 'constraint_errors' and schema_version = 'errors-v1')",
                &[],
            )
            .map_err(|error| format!("read source as bound tenant-b principal: {error}"))?
            .get(0);
        let own_snapshot_visible: bool = h
            .client
            .query_one(
                "select exists(select 1 from schema_constraint_identity where schema_revision_id = $1 and customer_id = 'tenant_b')",
                &[&tenant_b_revision],
            )
            .map_err(|error| format!("read tenant-b snapshot: {error}"))?
            .get(0);
        if !source_visible || !own_snapshot_visible {
            return Err(
                "bound tenant-b principal could not read its catalog definition and snapshot"
                    .to_string(),
            );
        }
        h.client
            .batch_execute("set kernel.customer_id = 'tenant_a'")
            .map_err(|error| format!("forge tenant-a scope: {error}"))?;
        let source_visible_as_forged_tenant: bool = h
            .client
            .query_one(
                "select exists(select 1 from schema_constraint_identity_source where app_id = 'constraint_errors' and schema_version = 'errors-v1')",
                &[],
            )
            .map_err(|error| format!("read source as forged tenant: {error}"))?
            .get(0);
        let other_snapshot_visible: bool = h
            .client
            .query_one(
                "select exists(select 1 from schema_constraint_identity where schema_revision_id = $1 and customer_id = 'tenant_a')",
                &[&tenant_a_revision],
            )
            .map_err(|error| format!("read tenant-a snapshot as forged tenant: {error}"))?
            .get(0);
        if source_visible_as_forged_tenant || other_snapshot_visible {
            return Err("tenant-b principal could forge tenant-a catalog scope".to_string());
        }
        Ok(())
    })();
    h.client
        .batch_execute(&format!(
            r#"reset session authorization; delete from kernel_principal_scope where principal_name = '{role_name}'::name; revoke execute on function kernel_principal_scope_authorized(text,text,text,text) from "{role_name}"; revoke select on schema_constraint_identity_source, schema_constraint_identity from "{role_name}"; revoke usage on schema "{}" from "{role_name}"; revoke "{runtime_role}" from "{role_name}"; drop role "{role_name}"; revoke "{execution_role}" from current_user"#,
            h.name
        ))
        .expect("remove bound catalog reader");
    if let Err(error) = result {
        panic!("{error}");
    }
}

fn establish_generated_execution_owner(client: &mut Client) -> Result<String, String> {
    let execution_role: String = client
        .query_one(
            "select kernel_installer_capability_role('execution_owner')",
            &[],
        )
        .map_err(|error| format!("resolve generated execution-owner role: {error}"))?
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
              execute pg_catalog.format('grant %I to %I', role_name, session_user);
            end
            $kernel_test$;
            "#,
        )
        .map_err(|error| format!("establish generated execution-owner identity: {error}"))?;
    Ok(execution_role)
}

fn write(key: &str, amount: &str, budget: &str) -> Value {
    json!({"model_id":"asset","record_key":{"type":"external_key","value":key},
    "effective_start":"2026-09-15","values":{
        "title":{"type":"text","value":key},"amount":{"type":"number","value":amount},"budget":{"type":"number","value":budget}
    }})
}
fn lookup_write(key: &str, name: &str) -> Value {
    json!({"model_id":"category","record_key":{"type":"external_key","value":key},
        "effective_start":"2026-09-15","values":{"name":{"type":"text","value":name}}})
}

#[test]
fn literal_text_prefix_is_enforced_for_entity_and_lookup_writes() {
    let mut manifest = fixture();
    manifest["constraints"].as_array_mut().unwrap().extend([
        json!({"id":"asset_title_prefix","model":"asset","label":"Asset title prefix","authority":"authoritative",
            "expression":{"type":"text_starts_with","field":"title","value":"PO-%_"}}),
        json!({"id":"category_name_prefix","model":"category","label":"Category name prefix","authority":"authoritative",
            "expression":{"type":"text_starts_with","field":"name","value":"CAT-"}}),
    ]);
    let Some(mut h) = Harness::new_with_manifest(manifest) else {
        return;
    };
    let entity_ok = h.apply("prefix-entity-ok", json!([write("PO-%_123", "1", "10")]));
    assert_eq!(entity_ok["ok"], true, "{entity_ok}");
    let entity_bad = h.apply("prefix-entity-bad", json!([write("PO-xx123", "1", "10")]));
    assert_eq!(
        entity_bad["error"]["code"], "constraint_violation",
        "{entity_bad}"
    );
    assert!(entity_bad["error"]["details"]
        .to_string()
        .contains("asset_title_prefix"));

    let lookup_ok = h.apply(
        "prefix-lookup-ok",
        json!([lookup_write("good", "CAT-Tools")]),
    );
    assert_eq!(lookup_ok["ok"], true, "{lookup_ok}");
    let lookup_bad = h.apply(
        "prefix-lookup-bad",
        json!([lookup_write("bad", "Cat-Tools")]),
    );
    assert_eq!(
        lookup_bad["error"]["code"], "constraint_violation",
        "{lookup_bad}"
    );
    assert!(lookup_bad["error"]["details"]
        .to_string()
        .contains("category_name_prefix"));
}

#[test]
fn declared_checks_are_scoped_safe_atomic_and_replayable() {
    let Some(mut h) = Harness::new() else {
        return;
    };
    assert_eq!(h.validate()["ok"], true);
    let failure = h.apply(
        "bad-batch",
        json!([write("good-sibling", "1", "10"), write("bad", "-1", "10")]),
    );
    assert_eq!(
        failure["error"]["code"], "constraint_violation",
        "{failure}"
    );
    let details = failure["error"]["details"].as_array().unwrap();
    assert!(details
        .iter()
        .any(|d| d["path"] == "constraint" && d["message"] == "nonnegative"));
    assert!(details
        .iter()
        .any(|d| d["path"] == "field" && d["message"] == "amount"));
    assert!(!failure.to_string().contains("Private author message"));
    assert!(!failure.to_string().contains("violates check constraint"));
    assert_eq!(
        h.client
            .query_one("select count(*) from asset_record", &[])
            .unwrap()
            .get::<_, i64>(0),
        0
    );
    let multi = h.apply("bad-budget", json!([write("over-budget", "20", "10")]));
    assert_eq!(multi["error"]["code"], "constraint_violation", "{multi}");
    for field in ["amount", "budget"] {
        assert!(multi["error"]["details"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["path"] == "field" && d["message"] == field));
    }
    let good = h.apply("success", json!([write("saved", "1", "10")]));
    assert_eq!(good["ok"], true, "{good}");
    assert_eq!(h.apply("success", json!([write("saved", "1", "10")])), good);
    let lookup_failure = h.apply(
        "lookup-too-long",
        json!([lookup_write(
            "long-category",
            "this category name is longer than twenty"
        )]),
    );
    assert_eq!(
        lookup_failure["error"]["code"], "constraint_violation",
        "{lookup_failure}"
    );
    let lookup_details = lookup_failure["error"]["details"].as_array().unwrap();
    assert!(lookup_details
        .iter()
        .any(|detail| detail["path"] == "model" && detail["message"] == "category"));
    assert!(lookup_details
        .iter()
        .any(|detail| detail["path"] == "constraint"
            && detail["message"]
                == "category_name_is_not_empty_and_has_a_bounded_length_for_diagnostic_testing"));
    assert!(lookup_details
        .iter()
        .any(|detail| detail["path"] == "field" && detail["message"] == "name"));
    // Physical identity requires both table and constraint, as well as the active scope.
    let name:String=h.client.query_one("select item->>'constraint_name' from schema_constraint_identity, lateral jsonb_array_elements(catalog) item where item->>'constraint_id'='nonnegative'",&[]).unwrap().get(0);
    for (table, tenant) in [("wrong_table", "tenant_a"), ("asset_version", "tenant_b")] {
        let result:Value=h.client.query_one("select kernel_apply_error_envelope_v2('23514','private diagnostic',$1,$2,$3::jsonb)",&[&name,&table,&json!({"app_id":"constraint_errors","customer_id":tenant})]).unwrap().get(0);
        assert_eq!(result["code"], "database_error", "{result}");
        assert!(!result.to_string().contains("private diagnostic"));
    }
    h.client
        .batch_execute(
            "alter table asset_version add constraint undeclared_check check (amount < 100)",
        )
        .unwrap();
    let unknown = h.apply("unknown", json!([write("unknown", "150", "200")]));
    assert_eq!(unknown["error"]["code"], "database_error", "{unknown}");
    let legacy:Value=h.client.query_one("select kernel_apply_error_envelope('23514','private diagnostic', 'undeclared_check', $1::jsonb)",&[&json!({"app_id":"constraint_errors","customer_id":"tenant_a"})]).unwrap().get(0);
    assert_eq!(legacy["code"], "database_error");
}

#[test]
fn catalog_drift_is_detected_and_lookup_names_are_compiler_owned() {
    let Some(mut h) = Harness::new() else {
        return;
    };
    let catalog: Value = h
        .client
        .query_one(
            "select catalog from schema_constraint_identity where schema_revision_id=$1",
            &[&h.revision],
        )
        .unwrap()
        .get(0);
    let lookup = catalog
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["model_id"] == "category")
        .unwrap();
    assert_eq!(lookup["table_name"], "lookup_version");
    assert!(lookup["constraint_name"].as_str().unwrap().len() <= 63);
    let denied:bool=h.client.query_one("select not has_table_privilege(kernel_installer_capability_role('runtime'),'schema_constraint_identity','SELECT') and not has_table_privilege(kernel_installer_capability_role('runtime'),'schema_constraint_identity_source','UPDATE')",&[]).unwrap().get(0);
    assert!(denied);
    h.client
        .batch_execute("begin; update schema_constraint_identity set catalog='[]'")
        .unwrap();
    assert_eq!(h.validate()["error"]["code"], "schema_drift");
    h.client.batch_execute("rollback").unwrap();
    h.client
        .batch_execute("begin; delete from schema_constraint_identity_source")
        .unwrap();
    assert_eq!(h.validate()["error"]["code"], "schema_drift");
    h.client.batch_execute("rollback").unwrap();
    h.client
        .batch_execute("begin; update schema_constraint_identity_source set catalog='[]'")
        .unwrap();
    assert!(
        h.client.batch_execute(&h.bundle).is_err(),
        "an issued catalog must not be silently rewritten"
    );
    h.client.batch_execute("rollback").unwrap();
    h.client
        .batch_execute("begin; alter table schema_constraint_identity_source drop column catalog")
        .unwrap();
    assert_eq!(h.validate()["error"]["code"], "schema_drift");
    h.client.batch_execute("rollback").unwrap();
    h.client
        .batch_execute("begin; alter table schema_constraint_identity_source alter column schema_version type varchar(100)")
        .unwrap();
    assert_eq!(h.validate()["error"]["code"], "schema_drift");
    h.client.batch_execute("rollback").unwrap();
    h.client
        .batch_execute("begin; alter table schema_constraint_identity_source drop constraint schema_constraint_identity_source_pkey")
        .unwrap();
    assert_eq!(h.validate()["error"]["code"], "schema_drift");
    h.client.batch_execute("rollback").unwrap();
    h.client
        .batch_execute(
            "begin; alter table schema_constraint_identity_source disable row level security",
        )
        .unwrap();
    assert_eq!(h.validate()["error"]["code"], "schema_drift");
    h.client.batch_execute("rollback").unwrap();
    h.client
        .batch_execute("begin; alter policy kernel_app_catalog_isolation on schema_constraint_identity_source using (true) with check (true)")
        .unwrap();
    assert_eq!(h.validate()["error"]["code"], "schema_drift");
    h.client.batch_execute("rollback").unwrap();
    h.client.batch_execute("begin; alter table schema_constraint_identity drop constraint schema_constraint_identity_pkey").unwrap();
    assert_eq!(h.validate()["error"]["code"], "schema_drift");
    h.client.batch_execute("rollback").unwrap();
    h.client
        .batch_execute(
            "begin; alter table schema_constraint_identity drop constraint schema_constraint_identity_revision_tenant_fk",
        )
        .unwrap();
    assert_eq!(h.validate()["error"]["code"], "schema_drift");
    h.client.batch_execute("rollback").unwrap();
    h.client
        .batch_execute(
            "begin;
             alter table schema_constraint_identity drop constraint schema_constraint_identity_revision_tenant_fk;
             alter table schema_constraint_identity add constraint schema_constraint_identity_revision_tenant_fk
               foreign key (schema_revision_id) references schema_revision(id)",
        )
        .unwrap();
    assert_eq!(h.validate()["error"]["code"], "schema_drift");
    h.client.batch_execute("rollback").unwrap();
    assert_eq!(h.validate()["ok"], true);
}
