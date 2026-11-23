#[path = "support/trusted_human.rs"]
mod trusted_human;
use std::collections::BTreeMap;
use std::env;
use std::sync::{Arc, Barrier};
use std::thread;

use kernel::{
    validate_apply_against_schema, AppId, ApplyChangeSet, ApplyMode, ChangeType, ChangeTypeId,
    CustomerId, Field, FieldId, FieldType, FieldValue, Model, ModelId, ModelKind, RecordKey,
    RowVersionWrite, Schema, SchemaVersion,
};
use postgres::{Client, NoTls};
use schema_compiler::{
    compile_sql_artifact_manifest, render_sql_artifact_bundle, CompiledManifest,
    NormalizedManifestExtras, SqlArtifactKind,
};
use serde_json::{json, Value};
use uuid::Uuid;

const APP_ID: &str = "lookup_or_create_app";
const CUSTOMER_ID: &str = "tenant_a";

struct Fixture {
    client: Client,
    database_url: String,
    schema_name: String,
}

impl Fixture {
    fn connect() -> Option<Self> {
        Self::connect_with_activation(true)
    }

    fn connect_with_activation(activate_fixture: bool) -> Option<Self> {
        let database_url = match env::var("KERNEL_TEST_DATABASE_URL") {
            Ok(url) => url,
            Err(env::VarError::NotPresent) => {
                eprintln!(
                    "skipping lookup-or-create SQL tests: KERNEL_TEST_DATABASE_URL is absent"
                );
                return None;
            }
            Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
        };
        let mut client = Client::connect(&database_url, NoTls).expect("connect PostgreSQL 17");
        let schema_name = format!("kernel_lookup_create_{}", Uuid::new_v4().simple());
        client
            .batch_execute(&format!(
                r#"create schema "{schema_name}"; set search_path to "{schema_name}""#
            ))
            .expect("create lookup-or-create schema");
        let compiled = compiled();
        let manifest = compile_sql_artifact_manifest(&compiled).expect("compile generated SQL");
        trusted_human::before_install(&mut client);
        client
            .batch_execute(&render_sql_artifact_bundle(&manifest))
            .expect("install generated SQL");
        if activate_fixture {
            activate(&mut client, &compiled.schema);
        }
        trusted_human::bind(&mut client, APP_ID, "tenant_a", "lookup-importer");
        trusted_human::bind(&mut client, APP_ID, "tenant_a", "lookup-admin");
        trusted_human::bind(&mut client, APP_ID, "tenant_a", "installer");
        Some(Self {
            client,
            database_url,
            schema_name,
        })
    }

    fn call(&mut self, function: &str, request: &Value) -> Value {
        if let Some(actor) = request["actor_id"].as_str() {
            trusted_human::select(&mut self.client, actor);
        }
        self.client
            .query_one(&format!("select {function}($1::jsonb)"), &[request])
            .unwrap_or_else(|error| panic!("call {function}: {error:?}"))
            .get(0)
    }

    fn apply(&mut self, request: &Value) -> Value {
        self.call("kernel_apply_change_set", request)
    }

    fn connect_worker(&self) -> Client {
        let mut client = Client::connect(&self.database_url, NoTls).expect("connect worker");
        client
            .batch_execute(&format!(r#"set search_path to "{}""#, self.schema_name))
            .expect("set worker search path");
        trusted_human::select(&mut client, "lookup-importer");
        client
    }

    fn set_authority(&mut self, app_id: &str, customer_id: &str, model_id: &str, authority: &str) {
        self.client
            .query_one(
                "select set_config('kernel.app_id',$1,false),set_config('kernel.customer_id',$2,false)",
                &[&app_id, &customer_id],
            )
            .expect("set authority fixture scope");
        self.client
            .execute(
                r#"
                insert into lookup_storage_authority(
                  app_id,customer_id,model_id,schema_hash,authority,
                  legacy_record_table,legacy_version_table
                ) values($1,$2,$3,repeat('a',64),$4,$3 || '_record',$3 || '_version')
                on conflict(app_id,customer_id,model_id) do update
                set authority=excluded.authority,
                    activated_at=case when excluded.authority='generic' then now() else null end,
                    first_generic_write_at=null
                "#,
                &[&app_id, &customer_id, &model_id, &authority],
            )
            .expect("set lookup storage authority");
        self.client
            .query_one(
                "select set_config('kernel.app_id',$1,false),set_config('kernel.customer_id',$2,false)",
                &[&APP_ID, &CUSTOMER_ID],
            )
            .expect("restore fixture scope");
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = trusted_human::drop_fixture(&mut self.client, &self.schema_name);
    }
}

fn compiled() -> CompiledManifest {
    let department = Model {
        id: ModelId::from("department"),
        kind: ModelKind::Lookup,
        label: "Department".to_string(),
        display_field_id: Some(FieldId::from("name")),
        fields: vec![
            field("name", FieldType::Text, true, None),
            field("aliases", FieldType::KnownAliases, false, None),
        ],
        ..Model::default()
    };
    let employee = Model {
        id: ModelId::from("employee"),
        kind: ModelKind::Entity,
        label: "Employee".to_string(),
        fields: vec![
            field("name", FieldType::Text, true, None),
            field("department", FieldType::Relation, true, Some("department")),
        ],
        ..Model::default()
    };
    CompiledManifest {
        schema: Schema {
            app_id: AppId::from(APP_ID),
            customer_id: CustomerId::from(CUSTOMER_ID),
            version: SchemaVersion::from("2026-08-05.lookup-or-create"),
            models: vec![department, employee],
            custom_fields: vec![],
            change_types: vec![ChangeType {
                id: ChangeTypeId::from("employee_update"),
                label: "Employee Update".to_string(),
                target_model: ModelId::from("employee"),
                is_import_default: true,
                touches: vec![],
                required: vec![],
            }],
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

fn field(id: &str, field_type: FieldType, required: bool, target: Option<&str>) -> Field {
    Field {
        id: FieldId::from(id),
        label: id.to_string(),
        field_type,
        required,
        target_model: target.map(ModelId::from),
        ..Field::default()
    }
}

fn activate(client: &mut Client, schema: &Schema) {
    let schema_json = serde_json::to_value(schema).expect("serialize schema");
    client
        .execute(
            "insert into schema_revision(app_id,customer_id,version,base_schema,customer_overlay,schema,activated_at,materialized_at) values($1,$2,$3,$4,'{}'::jsonb,$4,now(),now())",
            &[&schema.app_id.as_str(),&schema.customer_id.as_str(),&schema.version.as_str(),&schema_json],
        )
        .expect("activate schema");
}

fn text(value: &str) -> Value {
    json!({"type":"text","value":value})
}

fn lookup(label: &str, values: Value) -> Value {
    json!({"type":"relation","value":{"type":"lookup_or_create","value":{"label":label,"values":values}}})
}

fn employee_write(record_id: Uuid, name: &str, department: Value, date: &str) -> Value {
    json!({
        "model_id":"employee","new_record_id":record_id,"effective_start":date,
        "values":{"name":text(name),"department":department}
    })
}

fn apply_request(key: &str, mode: &str, writes: Value) -> Value {
    json!({
        "app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"lookup-importer",
        "source_kind":"import","source_ref":"fixture.csv","idempotency_key":key,
        "change_type_id":"employee_update","notes":"lookup-or-create fixture",
        "mode":mode,"writes":writes
    })
}

fn assert_ok(result: &Value) {
    assert_eq!(result.get("ok"), Some(&Value::Bool(true)), "{result:#}");
}

fn assert_authority_mismatch(result: &Value, model_id: &str) {
    assert_eq!(result["ok"], false, "{result:#}");
    assert_eq!(
        result["error"]["code"], "lookup_storage_authority_mismatch",
        "{result:#}"
    );
    assert!(
        result["error"]["details"][0]["message"]
            .as_str()
            .is_some_and(|message| message.ends_with(&format!("/{model_id}`"))),
        "{result:#}"
    );
}

fn direct_lookup_write(record_id: Uuid, label: &str, date: &str, key: &str) -> Value {
    json!({
        "app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"lookup-admin",
        "source_kind":"fixture","idempotency_key":key,"mode":"mainline",
        "writes":[{"model_id":"department","new_record_id":record_id,
          "effective_start":date,"values":{"name":text(label)}}]
    })
}

#[test]
fn native_installer_registers_generic_authority_with_empty_legacy_tables() {
    native_installer_legacy_case(None, false);
    native_installer_legacy_case(Some("other_tenant"), false);
}

#[test]
fn native_installer_preserves_selected_tenant_typed_history() {
    native_installer_legacy_case(Some(CUSTOMER_ID), false);
    native_installer_legacy_case(Some(CUSTOMER_ID), true);
}

fn native_installer_legacy_case(legacy_tenant: Option<&str>, versions_only: bool) {
    let Some(mut fixture) = Fixture::connect_with_activation(false) else {
        return;
    };
    fixture.client.batch_execute("create table department_record as select * from lookup_record with no data; create table department_version as select * from lookup_version with no data; alter table department_version add column name text, add column aliases text[]").expect("create empty legacy tables");
    if let Some(tenant) = legacy_tenant {
        let table = if versions_only {
            "department_version"
        } else {
            "department_record"
        };
        fixture
            .client
            .execute(
                &format!("insert into {table}(id,app_id,customer_id) values($1,$2,$3)"),
                &[&Uuid::new_v4(), &APP_ID, &tenant],
            )
            .unwrap();
    }
    let schema = serde_json::to_value(compiled().schema).unwrap();
    let hash = "c".repeat(64);
    let prepared = fixture.call(
        "kernel_prepare_schema_revision",
        &json!({
            "app_id":APP_ID,"customer_id":CUSTOMER_ID,"version":schema["version"],
            "release_id":"synthetic-native-release","activation_kind":"tenant_overlay",
            "schema_hash":hash,"base_artifact_hash":hash,"effective_artifact_hash":hash,
            "materialization_plan_hash":hash,"expected_active_effective_hash":null,
            "base_schema":schema,"customer_overlay":{},"schema":schema,"phase_plan":[]
        }),
    );
    assert_ok(&prepared);
    let revision = prepared["data"]["schema_revision_id"].as_i64().unwrap();
    assert_ok(&fixture.call(
        "kernel_validate_schema_revision_readiness",
        &json!({
            "app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_revision_id":revision,
            "effective_artifact_hash":hash,"materialization_plan_hash":hash,"phase_results":[]
        }),
    ));
    assert_ok(&fixture.call(
        "kernel_activate_tenant_schema_revision",
        &json!({
            "app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_revision_id":revision,
            "effective_artifact_hash":hash,"expected_active_effective_hash":null
        }),
    ));
    let authority: i64=fixture.client.query_one("select count(*) from lookup_storage_authority where app_id=$1 and customer_id=$2 and model_id='department'",&[&APP_ID,&CUSTOMER_ID]).unwrap().get(0);
    if legacy_tenant == Some(CUSTOMER_ID) {
        assert_eq!(
            authority, 0,
            "selected typed history must not acquire generic authority"
        );
        return;
    }
    assert_eq!(
        authority, 1,
        "empty or other-tenant legacy tables must not suppress native authority"
    );
    assert_ok(&fixture.apply(&direct_lookup_write(
        Uuid::new_v4(),
        "Synthetic native lookup",
        "2026-08-05",
        "native-installer-empty-legacy",
    )));
    let migration=fixture.call("kernel_prepare_lookup_migration",&json!({
        "app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_revision_id":revision,"expected_schema_hash":hash
    }));
    assert_ok(&migration);
}

#[test]
fn seeded_native_authority_recovery_is_forward_only_and_preserves_data() {
    for fault in [
        "none",
        "unseeded",
        "fingerprint",
        "skipped",
        "typed",
        "version_only",
        "stale",
        "missing_ledger",
        "duplicate_version",
        "conflicting_authority",
        "inactive_revision",
        "busy",
    ] {
        let Some(mut fixture) = Fixture::connect_with_activation(false) else {
            return;
        };
        fixture.client.batch_execute("create table department_record as select * from lookup_record with no data; create table department_version as select * from lookup_version with no data").unwrap();
        let schema = serde_json::to_value(compiled().schema).unwrap();
        let hash = "c".repeat(64);
        let record_id = Uuid::new_v4();
        let seeds = json!([{
            "seed_identity":"a".repeat(64),"seed_record_ids":[record_id],
            "actor_id":"installer","source_kind":"seed","idempotency_key":"native-seed",
            "writes":[{"model_id":"department","record_key":{"type":"record_id","value":record_id},
                "effective_start":"2026-08-05","values":{"name":text("Seeded department")}}]
        }]);
        let prepared=fixture.call("kernel_prepare_schema_revision",&json!({
            "app_id":APP_ID,"customer_id":CUSTOMER_ID,"version":schema["version"],
            "release_id":"seeded-native-release","activation_kind":"tenant_overlay",
            "schema_hash":hash,"base_artifact_hash":hash,"effective_artifact_hash":hash,
            "materialization_plan_hash":hash,"expected_active_effective_hash":null,
            "base_schema":schema,"customer_overlay":{},"schema":schema,"phase_plan":[],"seed_change_sets":seeds
        }));
        assert_ok(&prepared);
        let revision = prepared["data"]["schema_revision_id"].as_i64().unwrap();
        assert_ok(&fixture.call(
            "kernel_validate_schema_revision_readiness",
            &json!({
                "app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_revision_id":revision,
                "effective_artifact_hash":hash,"materialization_plan_hash":hash,"phase_results":[]
            }),
        ));
        assert_ok(&fixture.call(
            "kernel_activate_tenant_schema_revision",
            &json!({
                "app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_revision_id":revision,
                "effective_artifact_hash":hash,"expected_active_effective_hash":null
            }),
        ));
        // Reproduce the historical missing metadata after genuine installer seed writes.
        // Neither authority nor generic records/versions are fabricated by this fixture.
        if fault == "conflicting_authority" {
            fixture
                .client
                .batch_execute("update lookup_storage_authority set schema_hash=repeat('d',64)")
                .unwrap();
        } else {
            fixture
                .client
                .batch_execute("delete from lookup_storage_authority")
                .unwrap();
        }
        let mut competing_writer = None;
        if fault == "busy" {
            let mut worker = fixture.connect_worker();
            worker
                .batch_execute("begin; lock table lookup_record in row exclusive mode")
                .unwrap();
            competing_writer = Some(worker);
        }
        match fault {
            "inactive_revision" => {
                fixture
                    .client
                    .batch_execute("update schema_revision set activated_at=null")
                    .unwrap();
            }
            "missing_ledger" => {
                fixture
                    .client
                    .batch_execute("delete from installed_seed")
                    .unwrap();
            }
            "duplicate_version" => {
                fixture.client.batch_execute("insert into lookup_version select gen_random_uuid(),app_id,customer_id,model_id,record_id,stage,effective_start+1,effective_end,change_set_id,created_at,applied_at,tombstones_record,untombstones_record,availability,provenance,custom_fields,metadata,many_relations,values from lookup_version").unwrap();
            }
            "unseeded" => {
                assert_ok(&fixture.apply(&direct_lookup_write(
                    Uuid::new_v4(),
                    "Unseeded",
                    "2026-08-05",
                    "extra",
                )));
            }
            "fingerprint" => {
                fixture
                    .client
                    .batch_execute("update installed_seed set payload_fingerprint=repeat('b',64)")
                    .unwrap();
            }
            "skipped" => {
                fixture
                    .client
                    .batch_execute("update installed_seed set install_status='skipped_existing'")
                    .unwrap();
            }
            "typed" => {
                fixture
                    .client
                    .execute(
                        "insert into department_record(id,app_id,customer_id) values($1,$2,$3)",
                        &[&Uuid::new_v4(), &APP_ID, &CUSTOMER_ID],
                    )
                    .unwrap();
            }
            "version_only" => {
                fixture
                    .client
                    .execute(
                        "insert into department_version(id,app_id,customer_id) values($1,$2,$3)",
                        &[&Uuid::new_v4(), &APP_ID, &CUSTOMER_ID],
                    )
                    .unwrap();
            }
            "stale" => {
                fixture.client.batch_execute("update schema_installation_revision set effective_artifact_hash=repeat('d',64)").unwrap();
            }
            _ => {}
        }
        let snapshot = |fixture: &mut Fixture| -> Value {
            fixture.client.query_one("select jsonb_build_object('records',(select jsonb_agg(to_jsonb(r) order by id) from lookup_record r),'versions',(select jsonb_agg(to_jsonb(v) order by id) from lookup_version v))",&[]).unwrap().get(0)
        };
        let before = snapshot(&mut fixture);
        let request = json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_revision_id":revision,"expected_schema_hash":hash});
        let result = fixture.call("kernel_prepare_lookup_migration", &request);
        if fault == "none" {
            assert_ok(&result);
            assert_ok(&fixture.call("kernel_prepare_lookup_migration", &request));
            let authority: String = fixture
                .client
                .query_one(
                    "select authority from lookup_storage_authority where model_id='department'",
                    &[],
                )
                .unwrap()
                .get(0);
            assert_eq!(authority, "generic");
        } else {
            assert_eq!(result["ok"], false, "fault={fault}: {result}");
            assert_eq!(
                result["error"]["code"],
                match fault {
                    "inactive_revision" => "stale_schema_revision",
                    "busy" => "lookup_recovery_busy",
                    _ => "lookup_migration_forward_only",
                },
                "fault={fault}: {result}"
            );
            let count: i64 = fixture
                .client
                .query_one("select count(*) from lookup_storage_authority", &[])
                .unwrap()
                .get(0);
            assert_eq!(
                count,
                if fault == "conflicting_authority" {
                    1
                } else {
                    0
                },
                "fault={fault}"
            );
        }
        if let Some(mut worker) = competing_writer {
            worker.batch_execute("rollback").unwrap();
            assert_ok(&fixture.call("kernel_prepare_lookup_migration", &request));
        }
        assert_eq!(snapshot(&mut fixture), before, "fault={fault}");
    }
}

#[test]
fn artifacts_and_rust_runtime_boundary_are_explicit() {
    let compiled = compiled();
    let manifest = compile_sql_artifact_manifest(&compiled).expect("compile artifacts");
    for signature in [
        "kernel_apply_normalize_lookup_label(text)",
        "kernel_apply_prepare_lookup_or_create(jsonb,jsonb)",
    ] {
        assert!(manifest.artifacts.iter().any(|artifact| {
            artifact.kind == SqlArtifactKind::Function && artifact.name == signature
        }));
    }
    let history = manifest
        .artifacts
        .iter()
        .find(|artifact| artifact.name == "kernel_lookup_has_typed_history(text,text,text)")
        .expect("shared typed history reader");
    let history_sql = history.sql.to_ascii_lowercase();
    assert!(history_sql.contains("stable\nsecurity invoker"));
    assert!(history_sql.contains("select exists(select 1"));
    assert!(history_sql.contains("where app_id=$1 and customer_id=$2"));
    for write in [
        "insert ",
        "update ",
        "delete ",
        "alter ",
        "drop ",
        "truncate ",
        "set_config(",
    ] {
        assert!(
            !history_sql.contains(write),
            "typed history helper must only read: {write}"
        );
    }
    let execute = manifest
        .artifacts
        .iter()
        .find(|artifact| artifact.name == "kernel_apply_execute(jsonb,boolean,bigint)")
        .expect("apply executor");
    assert!(execute
        .sql
        .contains("kernel_apply_prepare_lookup_or_create(request,active_schema)"));

    let apply = ApplyChangeSet {
        app_id: AppId::from(APP_ID),
        customer_id: CustomerId::from(CUSTOMER_ID),
        schema_revision_id: None,
        actor_id: None,
        source_kind: "fixture".to_string(),
        source_ref: None,
        idempotency_key: None,
        change_type_id: Some(ChangeTypeId::from("employee_update")),
        notes: None,
        mode: ApplyMode::Mainline,
        writes: vec![RowVersionWrite {
            model_id: ModelId::from("employee"),
            new_record_id: Some(Uuid::new_v4()),
            effective_start: "2026-08-05".parse().unwrap(),
            values: Some(BTreeMap::from([
                (FieldId::from("name"), FieldValue::Text("Ada".to_string())),
                (
                    FieldId::from("department"),
                    FieldValue::Relation(RecordKey::LookupOrCreate {
                        label: "Engineering".to_string(),
                        values: BTreeMap::new(),
                    }),
                ),
            ])),
            ..RowVersionWrite::default()
        }],
    };
    let error = validate_apply_against_schema(&apply, &compiled.schema).unwrap_err();
    assert!(error
        .issues
        .iter()
        .any(|issue| issue.code == "lookup_or_create_requires_generated_sql"));
}

#[test]
fn mainline_alias_reuse_draft_atomicity_and_reserved_markers_work_on_postgres_17() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    let first_employee = Uuid::new_v4();
    let first = apply_request(
        "create-engineering",
        "mainline",
        json!([employee_write(
            first_employee,
            "Ada",
            lookup(
                "Engineering",
                json!({"aliases":{"type":"text_list","value":["Eng"]}}),
            ),
            "2026-08-05",
        )]),
    );
    let first_result = fixture.apply(&first);
    assert_ok(&first_result);
    let first_change_set = first_result["data"]["id"].as_i64().unwrap();
    let (lookup_id, relation_id, version_count): (Uuid, Uuid, i64) = fixture
        .client
        .query_one(
            "select l.record_id,e.department,(select count(*) from lookup_version where change_set_id=$1)+(select count(*) from employee_version where change_set_id=$1) from lookup_version l join employee_version e on e.change_set_id=l.change_set_id where l.change_set_id=$1",
            &[&first_change_set],
        )
        .map(|row| (row.get(0), row.get(1), row.get(2)))
        .expect("read atomic lookup/source versions");
    assert_eq!(lookup_id, relation_id);
    assert_eq!(version_count, 2);

    let alias = apply_request(
        "reuse-eng-alias",
        "mainline",
        json!([employee_write(
            Uuid::new_v4(),
            "Grace",
            lookup(" eng ", json!({})),
            "2026-08-05",
        )]),
    );
    assert_ok(&fixture.apply(&alias));
    let lookup_count: i64 = fixture
        .client
        .query_one(
            "select count(*) from lookup_record where app_id=$1 and customer_id=$2 and model_id='department'",
            &[&APP_ID, &CUSTOMER_ID],
        )
        .unwrap()
        .get(0);
    assert_eq!(lookup_count, 1);

    let draft = apply_request(
        "draft-finance",
        "draft",
        json!([employee_write(
            Uuid::new_v4(),
            "Lin",
            lookup("Finance", json!({})),
            "2026-08-05",
        )]),
    );
    let draft_result = fixture.apply(&draft);
    assert_ok(&draft_result);
    let draft_id = draft_result["data"]["id"].as_i64().unwrap();
    let draft_versions: i64 = fixture
        .client
        .query_one(
            "select (select count(*) from lookup_version where change_set_id=$1 and stage='draft')+(select count(*) from employee_version where change_set_id=$1 and stage='draft')",
            &[&draft_id],
        )
        .unwrap()
        .get(0);
    assert_eq!(draft_versions, 2);

    let invalid = apply_request(
        "rollback-lookup-create",
        "mainline",
        json!([{"model_id":"employee","new_record_id":Uuid::new_v4(),
          "effective_start":"2026-08-05","values":{"department":lookup("Legal",json!({}))}}]),
    );
    let invalid_result = fixture.apply(&invalid);
    assert_eq!(invalid_result["ok"], false);
    let legal_count: i64 = fixture
        .client
        .query_one(
            "select count(*) from lookup_alias_projection where normalized_alias='legal'",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(legal_count, 0);

    let injected = json!({
        "app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"lookup-importer",
        "source_kind":"fixture","change_type_id":"employee_update","mode":"mainline",
        "writes":[{"model_id":"department","new_record_id":Uuid::new_v4(),
          "effective_start":"2026-08-05","values":{"name":text("Injected")},
          "__kernel_lookup_or_create":true}]
    });
    let injected_result = fixture.apply(&injected);
    assert_eq!(injected_result["ok"], false);
    assert_eq!(
        injected_result["error"]["details"][0]["code"],
        "reserved_internal_apply_field"
    );
}

#[test]
fn concurrent_and_temporal_matches_are_model_qualified_and_deterministic_on_postgres_17() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    let barrier = Arc::new(Barrier::new(3));
    let mut workers = Vec::new();
    for index in 0..2 {
        let mut client = fixture.connect_worker();
        let barrier = Arc::clone(&barrier);
        workers.push(thread::spawn(move || {
            let request = apply_request(
                &format!("concurrent-{index}"),
                "mainline",
                json!([employee_write(
                    Uuid::new_v4(),
                    &format!("Worker {index}"),
                    lookup("Shared Services", json!({})),
                    "2026-08-05",
                )]),
            );
            barrier.wait();
            let result = client
                .query_one("select kernel_apply_change_set($1::jsonb)", &[&request])
                .unwrap()
                .get::<_, Value>(0);
            (result, request)
        }));
    }
    barrier.wait();
    for worker in workers {
        let (result, request) = worker.join().expect("lookup worker");
        if result["error"]["code"] == "database_error" {
            let error = fixture
                .client
                .query_one(
                    "select kernel_apply_execute($1::jsonb,false,null::bigint)",
                    &[&request],
                )
                .expect_err("database error must reproduce");
            panic!("concurrent apply failed: {:?}", error.as_db_error());
        }
        assert_ok(&result);
    }
    let shared_count: i64 = fixture
        .client
        .query_one(
            "select count(distinct record_id) from lookup_alias_projection where model_id='department' and normalized_alias='shared_services'",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(shared_count, 1);

    let historical_id = Uuid::new_v4();
    assert_ok(&fixture.apply(&direct_lookup_write(
        historical_id,
        "Temporal",
        "2026-01-01",
        "temporal-old",
    )));
    let rename = json!({
        "app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"lookup-admin","source_kind":"fixture",
        "idempotency_key":"temporal-rename","mode":"mainline",
        "writes":[{"model_id":"department","record_key":{"type":"record_id","value":historical_id},
          "effective_start":"2027-01-01","values":{"name":text("Historical")}}]
    });
    assert_ok(&fixture.apply(&rename));
    let future_id = Uuid::new_v4();
    assert_ok(&fixture.apply(&direct_lookup_write(
        future_id,
        "Temporal",
        "2027-01-01",
        "temporal-new",
    )));

    let retro_employee = Uuid::new_v4();
    let future_employee = Uuid::new_v4();
    let temporal = apply_request(
        "temporal-source-writes",
        "mainline",
        json!([
            employee_write(
                retro_employee,
                "Retro",
                lookup("Temporal", json!({})),
                "2026-06-01"
            ),
            employee_write(
                future_employee,
                "Future",
                lookup("Temporal", json!({})),
                "2028-06-01"
            )
        ]),
    );
    assert_ok(&fixture.apply(&temporal));
    let rows = fixture
        .client
        .query(
            "select record_id,department from employee_version where record_id=any($1) order by record_id",
            &[&vec![retro_employee, future_employee]],
        )
        .unwrap()
        .into_iter()
        .map(|row| (row.get::<_, Uuid>(0), row.get::<_, Uuid>(1)))
        .collect::<BTreeMap<_, _>>();
    assert_eq!(rows[&retro_employee], historical_id);
    assert_eq!(rows[&future_employee], future_id);
}

#[test]
fn retired_reservations_and_ambiguous_matches_fail_without_source_writes_on_postgres_17() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    let retired_id = Uuid::new_v4();
    assert_ok(&fixture.apply(&direct_lookup_write(
        retired_id,
        "Retired Value",
        "2026-01-01",
        "retired-create",
    )));
    let retire = json!({
        "app_id":APP_ID,"customer_id":CUSTOMER_ID,"model_id":"department",
        "record_id":retired_id,"availability":"retired","actor_id":"lookup-admin",
        "idempotency_key":"retire-value","effective_start":"2026-08-05","reason":"retired"
    });
    assert_ok(&fixture.call("kernel_lookup_set_availability", &retire));
    let retired_match = apply_request(
        "retired-match",
        "mainline",
        json!([employee_write(
            Uuid::new_v4(),
            "Blocked",
            lookup("Retired Value", json!({})),
            "2026-08-06",
        )]),
    );
    let retired_result = fixture.apply(&retired_match);
    assert_eq!(retired_result["error"]["code"], "lookup_label_reserved");

    fixture
        .client
        .batch_execute("drop index lookup_alias_projection_active_unique_idx")
        .unwrap();
    for (index, record_id) in [Uuid::new_v4(), Uuid::new_v4()].into_iter().enumerate() {
        assert_ok(&fixture.apply(&direct_lookup_write(
            record_id,
            "Ambiguous",
            "2026-01-01",
            &format!("ambiguous-{index}"),
        )));
    }
    let ambiguous = apply_request(
        "ambiguous-match",
        "mainline",
        json!([employee_write(
            Uuid::new_v4(),
            "Blocked",
            lookup("Ambiguous", json!({})),
            "2026-08-05",
        )]),
    );
    let ambiguous_result = fixture.apply(&ambiguous);
    assert_eq!(ambiguous_result["error"]["code"], "lookup_match_ambiguous");
}

#[test]
fn lookup_storage_authority_is_model_qualified_fail_closed_and_forward_only_on_postgres_17() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };

    let existing_record = Uuid::new_v4();
    let no_row_write = fixture.apply(&direct_lookup_write(
        existing_record,
        "No Row Allowed",
        "2026-08-05",
        "authority-no-row-mainline",
    ));
    assert_ok(&no_row_write);
    let mainline_change_set = no_row_write["data"]["id"].as_i64().unwrap();
    let schema_revision_id = no_row_write["data"]["schema_revision_id"].as_i64().unwrap();
    assert_ok(&fixture.call(
        "kernel_lookup_list",
        &json!({
            "app_id":APP_ID,"customer_id":CUSTOMER_ID,"model_id":"department",
            "as_of":"2026-08-05"
        }),
    ));

    let draft_record = Uuid::new_v4();
    let mut no_row_draft = direct_lookup_write(
        draft_record,
        "Draft Before Authority",
        "2026-08-05",
        "authority-no-row-draft",
    );
    no_row_draft["mode"] = json!("draft");
    let no_row_draft_result = fixture.apply(&no_row_draft);
    assert_ok(&no_row_draft_result);
    let draft_change_set = no_row_draft_result["data"]["id"].as_i64().unwrap();

    fixture
        .client
        .execute(
            "update schema_revision set schema_hash=repeat('c',64) where id=$1",
            &[&schema_revision_id],
        )
        .expect("assign fixture schema hash");
    let no_row_forward_only = fixture.call(
        "kernel_prepare_lookup_migration",
        &json!({
            "app_id":APP_ID,"customer_id":CUSTOMER_ID,
            "schema_revision_id":schema_revision_id,"expected_schema_hash":"c".repeat(64),
            "batch_size":1
        }),
    );
    assert_eq!(no_row_forward_only["ok"], false, "{no_row_forward_only:#}");
    assert_eq!(
        no_row_forward_only["error"]["code"],
        "lookup_migration_forward_only"
    );

    fixture.set_authority(APP_ID, CUSTOMER_ID, "unrelated_lookup", "typed");
    fixture.set_authority(APP_ID, "tenant_b", "department", "typed");
    assert_ok(&fixture.apply(&direct_lookup_write(
        Uuid::new_v4(),
        "Qualified Authority",
        "2026-08-05",
        "authority-qualified",
    )));

    fixture.set_authority(APP_ID, CUSTOMER_ID, "department", "typed");
    assert_authority_mismatch(
        &fixture.apply(&direct_lookup_write(
            Uuid::new_v4(),
            "Typed Write Blocked",
            "2026-08-05",
            "authority-typed-write",
        )),
        "department",
    );
    assert_authority_mismatch(
        &fixture.call(
            "kernel_lookup_list",
            &json!({
                "app_id":APP_ID,"customer_id":CUSTOMER_ID,"model_id":"department",
                "as_of":"2026-08-05"
            }),
        ),
        "department",
    );
    assert_authority_mismatch(
        &fixture.call(
            "kernel_lookup_resolve_batch",
            &json!({
                "app_id":APP_ID,"customer_id":CUSTOMER_ID,"model_id":"department",
                "as_of":"2026-08-05","record_ids":[existing_record]
            }),
        ),
        "department",
    );
    assert_authority_mismatch(
        &fixture.call(
            "kernel_lookup_hydrate",
            &json!({
                "app_id":APP_ID,"customer_id":CUSTOMER_ID,"as_of":"2026-08-05",
                "references":[{"model_id":"department","record_id":existing_record}]
            }),
        ),
        "department",
    );
    assert_authority_mismatch(
        &fixture.call(
            "kernel_lookup_reference_count",
            &json!({
                "app_id":APP_ID,"customer_id":CUSTOMER_ID,"model_id":"department",
                "record_id":existing_record,"as_of":"2026-08-05"
            }),
        ),
        "department",
    );
    let label_at = fixture
        .client
        .query_one(
            "select kernel_lookup_label_at($1,$2,$3,$4,$5::text::date,null::bigint,null::bigint)",
            &[
                &APP_ID,
                &CUSTOMER_ID,
                &"department",
                &existing_record,
                &"2026-08-05",
            ],
        )
        .expect("call authority-guarded label lookup")
        .get::<_, Value>(0);
    assert_authority_mismatch(&label_at, "department");

    let match_write = apply_request(
        "authority-typed-match",
        "mainline",
        json!([employee_write(
            Uuid::new_v4(),
            "Blocked Match",
            lookup("Typed Match Blocked", json!({})),
            "2026-08-05",
        )]),
    );
    assert_authority_mismatch(&fixture.apply(&match_write), "department");
    let mut typed_draft = direct_lookup_write(
        Uuid::new_v4(),
        "Typed Draft Blocked",
        "2026-08-05",
        "authority-typed-draft",
    );
    typed_draft["mode"] = json!("draft");
    assert_authority_mismatch(&fixture.apply(&typed_draft), "department");
    for (function, request) in [
        (
            "kernel_read_draft_change_set",
            json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"change_set_id":draft_change_set}),
        ),
        (
            "kernel_approve_draft_change_set",
            json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"lookup-admin","change_set_id":draft_change_set}),
        ),
        (
            "kernel_revert_change_set",
            json!({
                "app_id":APP_ID,"customer_id":CUSTOMER_ID,"change_set_id":mainline_change_set,
                "actor_id":"lookup-admin","idempotency_key":"authority-typed-revert"
            }),
        ),
    ] {
        assert_authority_mismatch(&fixture.call(function, &request), "department");
    }

    fixture.set_authority(APP_ID, CUSTOMER_ID, "department", "generic");
    assert_ok(&fixture.apply(&direct_lookup_write(
        Uuid::new_v4(),
        "Generic Allowed",
        "2026-08-06",
        "authority-generic-write",
    )));
    let marked_today: bool = fixture
        .client
        .query_one(
            "select first_generic_write_at::date=current_date from lookup_storage_authority where app_id=$1 and customer_id=$2 and model_id='department'",
            &[&APP_ID, &CUSTOMER_ID],
        )
        .expect("read first generic API write marker")
        .get(0);
    assert!(marked_today);
    assert_ok(&fixture.call(
        "kernel_approve_draft_change_set",
        &json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"lookup-admin","change_set_id":draft_change_set}),
    ));
    assert_ok(&fixture.call(
        "kernel_revert_change_set",
        &json!({
            "app_id":APP_ID,"customer_id":CUSTOMER_ID,"change_set_id":mainline_change_set,
            "actor_id":"lookup-admin","idempotency_key":"authority-generic-revert"
        }),
    ));
}
