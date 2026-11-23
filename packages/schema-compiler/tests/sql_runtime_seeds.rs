#[path = "support/trusted_human.rs"]
mod trusted_human;
use std::env;

use kernel::{connect_postgres, schema_hash};
use schema_compiler::{
    compile_manifest_json, compile_sql_artifact_manifest, render_sql_artifact_bundle,
    SqlArtifactKind,
};
use serde_json::{json, Value};
use uuid::Uuid;

#[path = "../src/sql_runtime/mod.rs"]
#[allow(dead_code)]
mod sql_runtime;

#[test]
fn seed_defaults_are_ledgered_ordinary_change_sets() {
    let function = sql_runtime::functions()
        .into_iter()
        .find(|function| function.signature == "kernel_apply_seed_defaults(jsonb)")
        .expect("seed-default function is generated");

    for required in [
        "create table if not exists installed_seed",
        "primary key (app_id, customer_id, seed_identity)",
        "alter table installed_seed force row level security",
        "pg_advisory_xact_lock",
        "kernel_apply_execute_internal(apply_request,false,null,null,true)",
        "'mode', 'mainline'",
        "'schema_revision_id', schema_revision_id",
        "'idempotency_key', template->'idempotency_key'",
        "'writes', template->'writes'",
        "'status', 'already_installed'",
        "'status', 'skipped_existing'",
    ] {
        assert!(
            function.sql.contains(required),
            "seed-default SQL is missing `{required}`"
        );
    }
    assert!(!function.sql.to_ascii_lowercase().contains("delete from"));
}

#[test]
fn seed_defaults_reject_runtime_identity_policy_and_scope_overrides() {
    let function = sql_runtime::functions()
        .into_iter()
        .find(|function| function.signature == "kernel_apply_seed_defaults(jsonb)")
        .expect("seed-default function is generated");

    assert!(function.sql.contains(
        "'seed_identity', 'seed_record_ids', 'actor_id', 'source_kind', 'idempotency_key',"
    ));
    assert!(function
        .sql
        .contains("seed request contains an unknown field"));
    assert!(function
        .sql
        .contains("seed identity must be compiler-derived SHA-256 hex"));
    assert!(!function.sql.contains("source_ref"));
    assert!(!function.sql.contains("provenance"));
}

#[test]
fn defaults_once_survives_release_edits_omission_retirement_and_restore_pg17() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let compiled_v1 =
        compile_manifest_json(&manifest("Operations", "seed-ops-v1", false).to_string())
            .expect("compile first seed release");
    let artifact = compile_sql_artifact_manifest(&compiled_v1).expect("compile seed SQL artifact");
    let mut client = connect_postgres(&database_url).expect("connect to PostgreSQL");
    let version: i32 = client
        .query_one("show server_version_num", &[])
        .expect("read PostgreSQL version")
        .get::<_, String>(0)
        .parse()
        .expect("numeric PostgreSQL version");
    assert!(version >= 170_000, "seed runtime requires PostgreSQL 17");

    let schema_name = format!("kernel_seed_once_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            "create schema \"{schema_name}\"; set search_path to \"{schema_name}\""
        ))
        .expect("create isolated seed schema");

    let result = (|| -> Result<(), String> {
        trusted_human::before_install(&mut client);
        client
            .batch_execute(&render_sql_artifact_bundle(&artifact))
            .map_err(|error| format!("install generated seed runtime: {error:?}"))?;
        set_scope(&mut client)?;
        let revision_id = seed_schema_revision(&mut client, &compiled_v1.schema)?;
        let templates_v1 = serde_json::to_value(&compiled_v1.extras.seed_change_sets)
            .map_err(|error| error.to_string())?;
        let seed_record_id = compiled_v1.extras.seed_change_sets[0].seed_record_ids[0];

        let first = apply_seeds(&mut client, revision_id, templates_v1.clone())?;
        assert_eq!(first["ok"], true, "first seed install failed: {first:#}");
        assert_eq!(first["data"]["applied_count"], 1);
        assert_eq!(first["data"]["skipped_count"], 0);
        assert_eq!(first["data"]["seeds"][0]["status"], "applied");
        assert_lookup_name(&mut client, seed_record_id, "Operations")?;

        let replay = apply_seeds(&mut client, revision_id, templates_v1)?;
        assert_eq!(replay["ok"], true, "seed replay failed: {replay:#}");
        assert_eq!(replay["data"]["applied_count"], 0);
        assert_eq!(replay["data"]["skipped_count"], 1);
        assert_eq!(replay["data"]["seeds"][0]["status"], "already_installed");

        let edit = apply(
            &mut client,
            json!({
                "app_id":"seed_once_app","customer_id":"tenant_a",
                "schema_revision_id":revision_id,"actor_id":"tenant-admin",
                "source_kind":"tenant_ui","idempotency_key":"tenant-renames-ops",
                "mode":"mainline","writes":[{
                    "model_id":"department",
                    "record_key":{"type":"record_id","value":seed_record_id},
                    "effective_start":"2026-08-06",
                    "values":{"name":{"type":"text","value":"Tenant Operations"}}
                }]
            }),
        )?;
        assert_eq!(edit["ok"], true, "tenant edit failed: {edit:#}");

        let compiled_v2 = compile_manifest_json(
            &manifest("Release Renamed Operations", "seed-ops-v2", true).to_string(),
        )
        .expect("compile second seed release");
        assert_eq!(
            compiled_v1.extras.seed_change_sets[0].seed_identity,
            compiled_v2.extras.seed_change_sets[0].seed_identity
        );
        assert_eq!(
            compiled_v1.extras.seed_change_sets[0].seed_record_ids,
            compiled_v2.extras.seed_change_sets[0].seed_record_ids
        );
        let second = apply_seeds(
            &mut client,
            revision_id,
            serde_json::to_value(&compiled_v2.extras.seed_change_sets)
                .map_err(|error| error.to_string())?,
        )?;
        assert_eq!(second["ok"], true, "second release failed: {second:#}");
        assert_eq!(
            second["data"]["applied_count"], 1,
            "only the new identity applies"
        );
        assert_eq!(second["data"]["skipped_count"], 1);
        assert_lookup_name(&mut client, seed_record_id, "Tenant Operations")?;
        let finance_id = compiled_v2.extras.seed_change_sets[1].seed_record_ids[0];
        assert_lookup_name(&mut client, finance_id, "Finance")?;

        let omitted = apply_seeds(&mut client, revision_id, json!([]))?;
        assert_eq!(omitted["ok"], true);
        assert_eq!(omitted["data"]["applied_count"], 0);
        assert_lookup_name(&mut client, seed_record_id, "Tenant Operations")?;

        set_availability(
            &mut client,
            revision_id,
            seed_record_id,
            "retired",
            "retire-ops",
        )?;
        let after_retire = apply_seeds(
            &mut client,
            revision_id,
            serde_json::to_value(&compiled_v2.extras.seed_change_sets[0..1])
                .map_err(|error| error.to_string())?,
        )?;
        assert_eq!(
            after_retire["data"]["seeds"][0]["status"],
            "already_installed"
        );
        assert_lookup_state(&mut client, seed_record_id, "Tenant Operations", "retired")?;

        set_availability(
            &mut client,
            revision_id,
            seed_record_id,
            "active",
            "restore-ops",
        )?;
        let after_restore = apply_seeds(
            &mut client,
            revision_id,
            serde_json::to_value(&compiled_v2.extras.seed_change_sets[0..1])
                .map_err(|error| error.to_string())?,
        )?;
        assert_eq!(
            after_restore["data"]["seeds"][0]["status"],
            "already_installed"
        );
        assert_lookup_state(&mut client, seed_record_id, "Tenant Operations", "active")?;

        let mut atomic_manifest = manifest("Legal", "seed-legal-v1", true);
        atomic_manifest["seed_change_sets"][0]["id"] = json!("department_legal");
        atomic_manifest["seed_change_sets"][0]["writes"][0]["record_key"]["value"] = json!("legal");
        atomic_manifest["seed_change_sets"][1]["id"] = json!("department_people");
        atomic_manifest["seed_change_sets"][1]["idempotency_key"] = json!("seed-people-v1");
        atomic_manifest["seed_change_sets"][1]["writes"][0]["record_key"]["value"] =
            json!("people");
        atomic_manifest["seed_change_sets"][1]["writes"][0]["values"]["name"] = json!("People");
        let atomic_compiled =
            compile_manifest_json(&atomic_manifest.to_string()).expect("compile atomic seed batch");
        let mut atomic_templates = serde_json::to_value(&atomic_compiled.extras.seed_change_sets)
            .map_err(|error| error.to_string())?;
        atomic_templates[1]["writes"][0]["values"]["name"] = json!({"type":"number","value":"1"});
        let atomic_failure = apply_seeds(&mut client, revision_id, atomic_templates)?;
        assert_eq!(atomic_failure["ok"], false, "invalid second seed must fail");
        let partial_records: i64 = client
            .query_one(
                "select count(*) from lookup_record where app_id='seed_once_app' and customer_id='tenant_a' and model_id='department' and external_key in ('legal','people')",
                &[],
            )
            .map_err(|error| format!("count rolled-back seed subjects: {error:?}"))?
            .get(0);
        assert_eq!(partial_records, 0, "the full seed batch must roll back");

        let mut reintroduced_manifest =
            manifest("Must Not Replace Tenant Value", "seed-ops-v3", false);
        reintroduced_manifest["seed_change_sets"][0]["id"] =
            json!("department_operations_reintroduced");
        let reintroduced = compile_manifest_json(&reintroduced_manifest.to_string())
            .expect("compile reintroduced seed identity");
        let reintroduced_result = apply_seeds(
            &mut client,
            revision_id,
            serde_json::to_value(&reintroduced.extras.seed_change_sets)
                .map_err(|error| error.to_string())?,
        )?;
        assert_eq!(
            reintroduced_result["data"]["seeds"][0]["status"],
            "skipped_existing"
        );
        assert_lookup_state(&mut client, seed_record_id, "Tenant Operations", "active")?;

        let ledger_rows: i64 = client
            .query_one(
                "select count(*) from installed_seed where app_id='seed_once_app' and customer_id='tenant_a'",
                &[],
            )
            .map_err(|error| format!("count seed ledger: {error:?}"))?
            .get(0);
        let seed_change_sets: i64 = client
            .query_one(
                "select count(*) from change_set where source_kind='app_seed'",
                &[],
            )
            .map_err(|error| format!("count seed audit rows: {error:?}"))?
            .get(0);
        assert_eq!(ledger_rows, 3);
        assert_eq!(seed_change_sets, 2);
        let audit: (String, String, Value) = client
            .query_one(
                "select cs.actor_id,cs.idempotency_key,v.provenance from change_set cs join lookup_version v on v.change_set_id=cs.id and v.app_id=cs.app_id and v.customer_id=cs.customer_id where cs.idempotency_key='seed-ops-v1'",
                &[],
            )
            .map_err(|error| format!("read seed audit: {error:?}"))
            .map(|row| (row.get(0), row.get(1), row.get(2)))?;
        assert_eq!(audit.0, "app-installer");
        assert_eq!(audit.1, "seed-ops-v1");
        assert_eq!(audit.2["source"], "seed fixture");
        Ok(())
    })();

    let cleanup = trusted_human::drop_fixture(&mut client, &schema_name);
    if let Err(error) = result {
        panic!("{error}");
    }
    cleanup.expect("drop isolated seed schema");
}

#[test]
fn global_seed_collision_allocates_scoped_subject_and_preserves_ambiguous_skips() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let mut input = manifest("Operations", "seed-ops-v1", false);
    input["models"][0]["kind"] = json!("entity");
    input["models"][0]
        .as_object_mut()
        .unwrap()
        .remove("display_field_id");
    let compiled = compile_manifest_json(&input.to_string()).unwrap();
    let artifact = compile_sql_artifact_manifest(&compiled).unwrap();
    let mut client = connect_postgres(&database_url).unwrap();
    for case in ["fresh", "ambiguous_skip", "explicit_id", "existing_subject"] {
        let historical_skip = case == "ambiguous_skip";
        let schema_name = format!("kernel_seed_collision_{}", Uuid::new_v4().simple());
        client
            .batch_execute(&format!(
                "create schema \"{schema_name}\"; set search_path to \"{schema_name}\""
            ))
            .unwrap();
        let result = (|| -> Result<(), String> {
            trusted_human::before_install(&mut client);
            client
                .batch_execute(&render_sql_artifact_bundle(&artifact))
                .map_err(|e| format!("{e:?}"))?;
            set_scope(&mut client)?;
            let revision = seed_schema_revision(&mut client, &compiled.schema)?;
            let mut templates = serde_json::to_value(&compiled.extras.seed_change_sets).unwrap();
            let original_id = compiled.extras.seed_change_sets[0].seed_record_ids[0];
            client.execute("insert into department_record(app_id,customer_id,id,external_key) values('seed_once_app','other_tenant',$1,'other-custom')", &[&original_id]).unwrap();
            if case == "explicit_id" {
                templates[0]["writes"][0]["record_key"] =
                    json!({"type":"record_id","value":original_id});
            }
            if case == "existing_subject" {
                let custom = Uuid::new_v4();
                client.execute("insert into department_record(app_id,customer_id,id,external_key) values('seed_once_app','tenant_a',$1,'operations')",&[&custom]).unwrap();
            }
            if historical_skip {
                // The old receipt cannot distinguish a global-ID collision from
                // a legitimate skip followed by customer deletion. Keep both.
                client.execute("insert into installed_seed(app_id,customer_id,seed_identity,seed_record_ids,payload_fingerprint,source_idempotency_key,install_status,result) select 'seed_once_app','tenant_a',$1::jsonb->>'seed_identity',array[$2::uuid],kernel_admin_sha256(kernel_canonical_json($1)),$1::jsonb->>'idempotency_key','skipped_existing',jsonb_build_object('status','skipped_existing','seed_record_ids',jsonb_build_array($2::uuid))", &[&templates[0], &original_id]).unwrap();
            }
            let first = apply_seeds(&mut client, revision, templates.clone())?;
            if case == "explicit_id" {
                assert_eq!(first["ok"], false, "{first:#}");
                assert!(first.to_string().contains("seed_record_id_collision"));
                let count: i64 = client
                    .query_one("select count(*) from installed_seed", &[])
                    .unwrap()
                    .get(0);
                assert_eq!(count, 0, "collision failure must not become a durable skip");
                return Ok(());
            }
            assert_eq!(first["ok"], true, "{first:#}");
            if case == "existing_subject" {
                assert_eq!(first["data"]["seeds"][0]["status"], "skipped_existing");
                let count: i64 = client
                    .query_one(
                        "select count(*) from department_version where customer_id='tenant_a'",
                        &[],
                    )
                    .unwrap()
                    .get(0);
                assert_eq!(count, 0, "custom subject must not acquire default data");
                return Ok(());
            }
            if historical_skip {
                assert_eq!(first["data"]["seeds"][0]["status"], "already_installed");
                let count: i64 = client
                    .query_one(
                        "select count(*) from department_record where customer_id='tenant_a'",
                        &[],
                    )
                    .unwrap()
                    .get(0);
                assert_eq!(
                    count, 0,
                    "ambiguous historical skip must not recreate defaults"
                );
            } else {
                assert_eq!(first["data"]["applied_count"], 1, "{first:#}");
                let allocated: Uuid =
                    serde_json::from_value(first["data"]["seeds"][0]["seed_record_ids"][0].clone())
                        .unwrap();
                assert_ne!(allocated, original_id);
                let name: String = client.query_one("select name from department_version where record_id=$1 and customer_id='tenant_a'", &[&allocated]).unwrap().get(0);
                assert_eq!(name, "Operations");
                let replay = apply_seeds(&mut client, revision, templates)?;
                assert_eq!(replay["data"]["seeds"][0]["status"], "already_installed");
                assert_eq!(
                    replay["data"]["seeds"][0]["seed_record_ids"][0],
                    json!(allocated)
                );
                let count: i64 = client
                    .query_one(
                        "select count(*) from department_version where customer_id='tenant_a'",
                        &[],
                    )
                    .unwrap()
                    .get(0);
                assert_eq!(count, 1);
            }
            let foreign: String = client.query_one("select external_key from department_record where id=$1 and customer_id='other_tenant'", &[&original_id]).unwrap().get(0);
            assert_eq!(foreign, "other-custom");
            Ok(())
        })();
        trusted_human::drop_fixture(&mut client, &schema_name).unwrap();
        result.unwrap();
    }
}

#[test]
fn first_activation_collision_receipt_recovers_on_normal_upgrade_only() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let mut input = manifest("Operations", "seed-ops-v1", true);
    input["models"][0]["kind"] = json!("entity");
    input["models"][0]
        .as_object_mut()
        .unwrap()
        .remove("display_field_id");
    let compiled = compile_manifest_json(&input.to_string()).unwrap();
    let artifact = compile_sql_artifact_manifest(&compiled).unwrap();
    let current_seed_sql = sql_runtime::functions()
        .into_iter()
        .find(|f| f.signature == "kernel_apply_seed_defaults(jsonb)")
        .unwrap()
        .sql;
    // Reproduce the shipped reservation behavior, through the actual installer.
    let start = current_seed_sql
        .find("          if reserved_count <> 1 then")
        .unwrap();
    let end = current_seed_sql[start..]
        .find("        end if;\n        write_index")
        .unwrap()
        + start;
    let mut legacy_seed_sql = current_seed_sql.clone();
    legacy_seed_sql.replace_range(start..end,"          if reserved_count <> 1 then\n            raise exception using errcode='P0002', message='seed subject was created concurrently';\n          end if;\n");
    for activation_kind in ["app_base", "tenant_overlay"] {
        for fault in ["none", "fingerprint", "older_receipt", "custom_history"] {
            let mut client = connect_postgres(&database_url).unwrap();
            let scope = format!("seed_first_activation_{}", Uuid::new_v4().simple());
            client
                .batch_execute(&format!(
                    "create schema \"{scope}\"; set search_path to \"{scope}\""
                ))
                .unwrap();
            let result = (|| -> Result<(), String> {
                trusted_human::before_install(&mut client);
                client
                    .batch_execute(&render_sql_artifact_bundle(&artifact))
                    .unwrap();
                client.batch_execute(&legacy_seed_sql).unwrap();
                set_scope(&mut client)?;
                let templates = serde_json::to_value(&compiled.extras.seed_change_sets).unwrap();
                for seed in &compiled.extras.seed_change_sets {
                    let original_id = seed.seed_record_ids[0];
                    client.execute("insert into department_record(app_id,customer_id,id,external_key) values('seed_once_app','other_tenant',$1,$2)",&[&original_id,&original_id.to_string()]).unwrap();
                }
                let schema = serde_json::to_value(&compiled.schema).unwrap();
                let activate = |client: &mut postgres::Client,
                                hash: &str,
                                previous: Option<&str>|
                 -> Result<i64, String> {
                    let mut schema = schema.clone();
                    if previous.is_some() {
                        schema["version"] = json!("2026-08-06");
                    }
                    let prepared_compiled = compile_manifest_json(&schema.to_string())
                        .map_err(|error| format!("compile changed seed schema: {error:?}"))?;
                    let prepared_manifest = compile_sql_artifact_manifest(&prepared_compiled)
                        .map_err(|error| format!("compile changed seed catalog: {error:?}"))?;
                    let catalog = prepared_manifest
                        .artifacts
                        .iter()
                        .find(|artifact| artifact.kind == SqlArtifactKind::ConstraintCatalog)
                        .ok_or_else(|| "compiler omitted changed seed catalog".to_string())?;
                    client
                        .batch_execute(&catalog.sql)
                        .map_err(|error| format!("install changed seed catalog: {error:?}"))?;
                    let prepared = call(
                        client,
                        "kernel_prepare_schema_revision",
                        json!({
                            "app_id":"seed_once_app","customer_id":"tenant_a","version":schema["version"],
                            "release_id":hash,"activation_kind":activation_kind,"schema_hash":hash,
                            "base_artifact_hash":hash,"effective_artifact_hash":hash,"materialization_plan_hash":hash,
                            "expected_active_effective_hash":previous,"base_schema":schema,"customer_overlay":{},
                            "schema":schema,"phase_plan":[],"seed_change_sets":templates
                        }),
                    )?;
                    assert_eq!(prepared["ok"], true, "{prepared:#}");
                    let revision = prepared["data"]["schema_revision_id"].as_i64().unwrap();
                    let ready = call(
                        client,
                        "kernel_validate_schema_revision_readiness",
                        json!({"app_id":"seed_once_app","customer_id":"tenant_a","schema_revision_id":revision,"effective_artifact_hash":hash,"materialization_plan_hash":hash,"phase_results":[]}),
                    )?;
                    assert_eq!(ready["ok"], true, "{ready:#}");
                    let active = if activation_kind == "tenant_overlay" {
                        call(
                            client,
                            "kernel_activate_tenant_schema_revision",
                            json!({"app_id":"seed_once_app","customer_id":"tenant_a","schema_revision_id":revision,"effective_artifact_hash":hash,"expected_active_effective_hash":previous}),
                        )?
                    } else {
                        call(
                            client,
                            "kernel_activate_app_base_schema_revision",
                            json!({"app_id":"seed_once_app","release_id":hash,"base_artifact_hash":hash,"targets":[{"customer_id":"tenant_a","schema_revision_id":revision,"effective_artifact_hash":hash,"expected_active_effective_hash":previous}]}),
                        )?
                    };
                    assert_eq!(active["ok"], true, "{active:#}");
                    Ok(revision)
                };
                let old_hash = "a".repeat(64);
                let first_revision = activate(&mut client, &old_hash, None)?;
                let status: String = client
                    .query_one("select min(install_status) from installed_seed", &[])
                    .unwrap()
                    .get(0);
                assert_eq!(status, "skipped_existing");
                match fault {
                    "fingerprint" => {
                        client
                            .batch_execute(
                                "update installed_seed set payload_fingerprint=repeat('f',64)",
                            )
                            .unwrap();
                    }
                    "older_receipt" => {
                        client.batch_execute("update installed_seed set installed_at=installed_at-interval '1 second'").unwrap();
                    }
                    "custom_history" => {
                        trusted_human::bind(&mut client, "seed_once_app", "tenant_a", "owner");
                        let changed = apply(
                            &mut client,
                            json!({"app_id":"seed_once_app","customer_id":"tenant_a","schema_revision_id":first_revision,"actor_id":"owner","source_kind":"tenant_ui","idempotency_key":"custom","mode":"mainline","writes":[{"model_id":"department","record_key":{"type":"external_key","value":"custom"},"effective_start":"2026-08-05","values":{"name":{"type":"text","value":"Custom"}}}]}),
                        )?;
                        assert_eq!(changed["ok"], true, "{changed:#}");
                    }
                    _ => {}
                }
                client.batch_execute(&current_seed_sql).unwrap();
                activate(&mut client, &"b".repeat(64), Some(&old_hash))?;
                let row = client
                    .query_one("select min(install_status) from installed_seed", &[])
                    .unwrap();
                let status: String = row.get(0);
                assert_eq!(
                    status,
                    if fault == "none" {
                        "applied"
                    } else {
                        "skipped_existing"
                    }
                );
                let old_inactive: bool = client
                    .query_one(
                        "select activated_at is null from schema_revision where id=$1",
                        &[&first_revision],
                    )
                    .unwrap()
                    .get(0);
                assert!(old_inactive);
                let applied: i64 = client
                    .query_one(
                        "select count(*) from installed_seed where install_status='applied'",
                        &[],
                    )
                    .unwrap()
                    .get(0);
                assert_eq!(
                    applied,
                    if fault == "none" { 2 } else { 0 },
                    "all eligible templates recover in the same activation"
                );
                let count:i64=client.query_one("select count(*) from department_version where customer_id='tenant_a' and name='Operations'",&[]).unwrap().get(0);
                assert_eq!(count, if fault == "none" { 1 } else { 0 });
                Ok(())
            })();
            trusted_human::drop_fixture(&mut client, &scope).unwrap();
            result.unwrap();
        }
    }
}

fn manifest(operations_name: &str, idempotency_key: &str, add_finance: bool) -> Value {
    let mut seeds = vec![json!({
        "id":"department_operations",
        "effective_start":"2026-08-05",
        "actor_id":"app-installer",
        "source_kind":"app_seed",
        "idempotency_key":idempotency_key,
        "writes":[{
            "model":"department",
            "record_key":{"type":"external_key","value":"operations"},
            "values":{"name":operations_name},
            "provenance":{"source":"seed fixture"}
        }]
    })];
    if add_finance {
        seeds.push(json!({
            "id":"department_finance",
            "effective_start":"2026-08-05",
            "actor_id":"app-installer",
            "source_kind":"app_seed",
            "idempotency_key":"seed-finance-v1",
            "writes":[{
                "model":"department",
                "record_key":{"type":"external_key","value":"finance"},
                "values":{"name":"Finance"}
            }]
        }));
    }
    json!({
        "app_id":"seed_once_app",
        "customer_id":"tenant_a",
        "version":"2026-08-05",
        "models":[{
            "id":"department","kind":"lookup","label":"Department",
            "display_field_id":"name",
            "fields":[{"id":"name","label":"Name","type":"text","required":true}]
        }],
        "change_types":[],"constraints":[],"seed_change_sets":seeds
    })
}

fn test_database_url() -> Option<String> {
    match env::var("KERNEL_TEST_DATABASE_URL") {
        Ok(value) if !value.trim().is_empty() => Some(value),
        Ok(_) | Err(env::VarError::NotPresent) => {
            eprintln!("skipping seed PostgreSQL test: KERNEL_TEST_DATABASE_URL is absent");
            None
        }
        Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
    }
}

fn set_scope(client: &mut postgres::Client) -> Result<(), String> {
    trusted_human::bind(client, "seed_once_app", "tenant_a", "tenant-admin");
    client
        .query_one(
            "select set_config('kernel.app_id','seed_once_app',false), set_config('kernel.customer_id','tenant_a',false)",
            &[],
        )
        .map(|_| ())
        .map_err(|error| format!("set tenant scope: {error:?}"))
}

fn seed_schema_revision(
    client: &mut postgres::Client,
    schema: &kernel::Schema,
) -> Result<i64, String> {
    let schema_json = serde_json::to_value(schema).map_err(|error| error.to_string())?;
    let hash = schema_hash(schema);
    client
        .query_one(
            "insert into schema_revision(app_id,customer_id,version,base_schema,customer_overlay,schema,activated_at,schema_hash) values ('seed_once_app','tenant_a',$1,$2,'{}',$2,now(),$3) returning id",
            &[&schema.version.as_str(), &schema_json, &hash],
        )
        .map(|row| row.get(0))
        .map_err(|error| format!("seed active schema revision: {error:?}"))
}

fn apply_seeds(
    client: &mut postgres::Client,
    schema_revision_id: i64,
    templates: Value,
) -> Result<Value, String> {
    call(
        client,
        "kernel_apply_seed_defaults",
        json!({
            "app_id":"seed_once_app","customer_id":"tenant_a",
            "schema_revision_id":schema_revision_id,"change_sets":templates
        }),
    )
}

fn apply(client: &mut postgres::Client, request: Value) -> Result<Value, String> {
    call(client, "kernel_apply_change_set", request)
}

fn set_availability(
    client: &mut postgres::Client,
    schema_revision_id: i64,
    record_id: Uuid,
    availability: &str,
    idempotency_key: &str,
) -> Result<(), String> {
    let result = call(
        client,
        "kernel_lookup_set_availability",
        json!({
            "app_id":"seed_once_app","customer_id":"tenant_a",
            "schema_revision_id":schema_revision_id,"actor_id":"tenant-admin",
            "source_kind":"tenant_ui","idempotency_key":idempotency_key,
            "reason":idempotency_key,"model_id":"department","record_id":record_id,
            "effective_start":"2026-08-07","availability":availability
        }),
    )?;
    if result["ok"] != true {
        return Err(format!("set lookup availability: {result:#}"));
    }
    Ok(())
}

fn assert_lookup_name(
    client: &mut postgres::Client,
    record_id: Uuid,
    expected: &str,
) -> Result<(), String> {
    let name: String = client
        .query_one(
            "select version.values->'name'->>'value' from lookup_version version join change_set changes on changes.id=version.change_set_id and changes.app_id=version.app_id and changes.customer_id=version.customer_id where version.app_id='seed_once_app' and version.customer_id='tenant_a' and version.model_id='department' and version.record_id=$1 and version.stage='mainline' order by version.effective_start desc,changes.applied_order desc,version.id desc limit 1",
            &[&record_id],
        )
        .map_err(|error| format!("read lookup name: {error:?}"))?
        .get(0);
    assert_eq!(name, expected);
    Ok(())
}

fn assert_lookup_state(
    client: &mut postgres::Client,
    record_id: Uuid,
    expected_name: &str,
    expected_availability: &str,
) -> Result<(), String> {
    let row = client
        .query_one(
            "select version.values->'name'->>'value',version.availability from lookup_version version join change_set changes on changes.id=version.change_set_id and changes.app_id=version.app_id and changes.customer_id=version.customer_id where version.app_id='seed_once_app' and version.customer_id='tenant_a' and version.model_id='department' and version.record_id=$1 and version.stage='mainline' order by version.effective_start desc,changes.applied_order desc,version.id desc limit 1",
            &[&record_id],
        )
        .map_err(|error| format!("read lookup state: {error:?}"))?;
    assert_eq!(row.get::<_, String>(0), expected_name);
    assert_eq!(row.get::<_, String>(1), expected_availability);
    Ok(())
}

fn call(client: &mut postgres::Client, function: &str, request: Value) -> Result<Value, String> {
    client
        .query_one(&format!("select {function}($1::jsonb)"), &[&request])
        .map(|row| row.get(0))
        .map_err(|error| format!("call {function}: {error:?}"))
}

#[test]
fn fresh_seeded_activation_uses_system_authority_without_runtime_actor() {
    let Some(url) = test_database_url() else {
        return;
    };
    for declared_policy in [false, true] {
        let mut input = manifest("Operations", "fresh-system-seed", false);
        if declared_policy {
            input["authorization"] = json!({"roles":[{"id":"editor"}],"grants":[{
                "role":"editor","model":"department","operations":["read","create","update"],
                "read_fields":["$id","$version","name"],"write_fields":["name"],
                "record":{"kind":"all"}
            }]});
        }
        let compiled = compile_manifest_json(&input.to_string()).unwrap();
        let artifacts = compile_sql_artifact_manifest(&compiled).unwrap();
        let mut client = connect_postgres(&url).unwrap();
        let scope = format!("fresh_system_seed_{}", Uuid::new_v4().simple());
        client
            .batch_execute(&format!(
                "create schema {scope}; set search_path to {scope}"
            ))
            .unwrap();
        trusted_human::before_install(&mut client);
        client
            .batch_execute(&render_sql_artifact_bundle(&artifacts))
            .unwrap();
        // No runtime principal scope, membership or kernel.actor_id is provisioned.
        let schema = serde_json::to_value(&compiled.schema).unwrap();
        let hash = "a".repeat(64);
        let prepared = call(&mut client, "kernel_prepare_schema_revision", json!({
        "app_id":"seed_once_app","customer_id":"tenant_a","version":schema["version"],
        "release_id":"fresh","activation_kind":"app_base","schema_hash":hash,
        "base_artifact_hash":hash,"effective_artifact_hash":hash,"materialization_plan_hash":hash,
        "expected_active_effective_hash":null,"base_schema":schema,"customer_overlay":{},
        "schema":schema,"phase_plan":[],"seed_change_sets":compiled.extras.seed_change_sets
    })).unwrap();
        assert_eq!(prepared["ok"], true, "{prepared}");
        let revision = &prepared["data"]["schema_revision_id"];
        let ready = call(
            &mut client,
            "kernel_validate_schema_revision_readiness",
            json!({
                "app_id":"seed_once_app","customer_id":"tenant_a","schema_revision_id":revision,
                "effective_artifact_hash":hash,"materialization_plan_hash":hash,"phase_results":[]
            }),
        )
        .unwrap();
        assert_eq!(ready["ok"], true, "{ready}");
        let activated = call(
            &mut client,
            "kernel_activate_app_base_schema_revision",
            json!({
                "app_id":"seed_once_app","release_id":"fresh","base_artifact_hash":hash,
                "targets":[{"customer_id":"tenant_a","schema_revision_id":revision,
                "effective_artifact_hash":hash,"expected_active_effective_hash":null}]
            }),
        )
        .unwrap();
        assert_eq!(activated["ok"], true, "{activated}");
        assert_eq!(
            client
                .query_one("select source_kind from change_set", &[])
                .unwrap()
                .get::<_, String>(0),
            "app_seed"
        );
        assert_eq!(
            client
                .query_one("select count(*) from kernel_actor_membership", &[])
                .unwrap()
                .get::<_, i64>(0),
            0
        );
        let runtime: String = client
            .query_one("select kernel_installer_capability_role('runtime')", &[])
            .unwrap()
            .get(0);
        for signature in [
            "kernel_apply_seed_defaults(jsonb)",
            "kernel_apply_execute_internal(jsonb,boolean,bigint,jsonb,boolean)",
        ] {
            assert!(
                !client
                    .query_one(
                        "select has_function_privilege($1,$2,'EXECUTE')",
                        &[&runtime, &signature]
                    )
                    .unwrap()
                    .get::<_, bool>(0),
                "runtime must not execute {signature}"
            );
        }
        trusted_human::drop_fixture(&mut client, &scope).unwrap();
    }
}
