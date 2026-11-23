#[path = "support/trusted_human.rs"]
mod trusted_human;
use std::env;

use kernel::{
    connect_postgres, AppId, CustomFieldDefinition, CustomFieldDefinitionId, CustomFieldType,
    CustomerId, EntityExtensionCapabilities, EnumOption, EnumOptionId, Field, FieldId, FieldType,
    ManyRelationDefinition, Model, ModelId, ModelKind, RecordMetadataLimits, Schema, SchemaVersion,
};
use schema_compiler::{
    compile_sql_artifact_manifest, compile_sql_materialization_plan, render_sql_artifact_bundle,
    CompiledManifest, NormalizedManifestExtras, SqlArtifactKind,
};
use serde_json::{json, Value};
use uuid::Uuid;

fn text_field(id: &str, required: bool) -> Field {
    Field {
        id: FieldId::from(id),
        label: id.to_string(),
        field_type: FieldType::Text,
        required,
        ..Field::default()
    }
}

fn metadata_limits() -> RecordMetadataLimits {
    RecordMetadataLimits {
        max_bytes: 512,
        max_depth: 3,
        max_keys: 12,
        max_key_bytes: 32,
        max_scalar_bytes: 64,
        max_array_items: 4,
    }
}

fn compiled() -> CompiledManifest {
    let department = Model {
        id: ModelId::from("department"),
        kind: ModelKind::Lookup,
        label: "Department".to_string(),
        display_field_id: Some(FieldId::from("name")),
        extensions: EntityExtensionCapabilities {
            typed_custom_fields: true,
            record_metadata: None,
        },
        fields: vec![
            text_field("name", true),
            text_field("code", false),
            Field {
                id: FieldId::from("status"),
                label: "Status".to_string(),
                field_type: FieldType::Enum,
                option_set: vec![
                    EnumOption {
                        id: EnumOptionId::from("open"),
                        label: "Open".to_string(),
                        ..EnumOption::default()
                    },
                    EnumOption {
                        id: EnumOptionId::from("closed"),
                        label: "Closed".to_string(),
                        lifecycle: kernel::SchemaElementLifecycle::Retired,
                        ..EnumOption::default()
                    },
                ],
                ..Field::default()
            },
        ],
        many_relations: vec![ManyRelationDefinition {
            id: FieldId::from("peers"),
            label: "Peers".to_string(),
            target_model: ModelId::from("department"),
            ..ManyRelationDefinition::default()
        }],
        ..Model::default()
    };
    let employee = Model {
        id: ModelId::from("employee"),
        kind: ModelKind::Entity,
        label: "Employee".to_string(),
        extensions: EntityExtensionCapabilities {
            typed_custom_fields: true,
            record_metadata: Some(metadata_limits()),
        },
        fields: vec![text_field("name", true), text_field("nickname", false)],
        ..Model::default()
    };
    let custom_field = CustomFieldDefinition {
        id: CustomFieldDefinitionId::from("employee_note"),
        model_id: ModelId::from("employee"),
        field_id: FieldId::from("note"),
        label: "Note".to_string(),
        field_type: CustomFieldType::Text,
        ..CustomFieldDefinition::default()
    };
    CompiledManifest {
        schema: Schema {
            app_id: AppId::from("sql_extensions"),
            customer_id: CustomerId::from("tenant_a"),
            version: SchemaVersion::from("2026-08-05"),
            models: vec![department, employee],
            custom_fields: vec![custom_field],
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

fn request(key: &str, writes: Value) -> Value {
    json!({
        "app_id": "sql_extensions",
        "customer_id": "tenant_a",
        "schema_revision_id": 1,
        "actor_id": "fixture-actor",
        "source_kind": "fixture",
        "source_ref": "extensions",
        "idempotency_key": key,
        "mode": "mainline",
        "writes": writes,
    })
}

fn apply(client: &mut postgres::Client, request: Value) -> Value {
    trusted_human::bind(client, "sql_extensions", "tenant_a", "fixture-actor");
    client
        .query_one("select kernel_apply_change_set($1::jsonb)", &[&request])
        .expect("call generated apply")
        .get(0)
}

fn assert_error_code(response: &Value, code: &str) {
    assert_eq!(response["ok"], false, "{response:#}");
    assert!(
        response["error"]["details"]
            .as_array()
            .is_some_and(|details| details.iter().any(|detail| detail["code"] == code)),
        "expected detail code {code}: {response:#}"
    );
}

#[test]
fn generated_apply_uses_snapshot_extension_wire_contract() {
    let plan = compile_sql_materialization_plan(None, &compiled()).unwrap();
    let source = plan
        .artifacts
        .iter()
        .find(|artifact| {
            artifact.kind == SqlArtifactKind::Function
                && artifact.name
                    == "kernel_apply_execute_internal(jsonb,boolean,bigint,jsonb,boolean)"
        })
        .expect("generated apply function")
        .sql
        .as_str();

    assert!(source.contains("values,__lookup_lifecycle,value"));
    assert!(source.contains("value->>'type'='relation_list'"));
    assert!(source.contains("snapshot := snapshot-field_id"));
    assert!(source.contains("custom_by_id := custom_by_id-field_id"));
    assert!(source.contains("kernel_apply_metadata_patch("));
    assert!(source.contains("insert_columns := insert_columns || ',metadata'"));
    assert!(source.contains(
        "array['metadata','lookup_availability','many_relations','clear_many_relations']"
    ));
    assert!(!source.contains("metadata_json := write->'metadata'"));
    assert!(!source.contains("many_relations_json := write->'many_relations'"));
}

#[test]
fn generated_apply_persists_extension_snapshots_on_postgres_17() {
    let database_url = match env::var("KERNEL_TEST_DATABASE_URL") {
        Ok(value) if !value.trim().is_empty() => value,
        Ok(_) | Err(env::VarError::NotPresent) => {
            eprintln!("skipping generated extension SQL test: KERNEL_TEST_DATABASE_URL is absent");
            return;
        }
        Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
    };
    let mut client = connect_postgres(&database_url).expect("connect to PostgreSQL");
    let server_version: i32 = client
        .query_one("select current_setting('server_version_num')::integer", &[])
        .unwrap()
        .get(0);
    assert!(
        (170000..180000).contains(&server_version),
        "extension parity must run on PostgreSQL 17, got {server_version}"
    );

    let fixture = compiled();
    let schema_name = format!("kernel_extensions_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            "create schema \"{schema_name}\"; set search_path to \"{schema_name}\""
        ))
        .unwrap();
    let manifest = compile_sql_artifact_manifest(&fixture).unwrap();
    trusted_human::before_install(&mut client);
    client
        .batch_execute(&render_sql_artifact_bundle(&manifest))
        .unwrap_or_else(|error| panic!("install generated extension bundle: {error:?}"));
    // The apply contract supports lookup metadata, while lookup models cannot
    // declare record metadata; this test opts the lookup in directly.
    client
        .batch_execute(
            "alter table lookup_version drop constraint lookup_version_department_metadata_check",
        )
        .unwrap();

    let mut active_schema = serde_json::to_value(&fixture.schema).unwrap();
    active_schema["models"][0]["extensions"]["record_metadata"] =
        serde_json::to_value(metadata_limits()).unwrap();
    active_schema["custom_fields"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "id":"department_note",
            "model_id":"department",
            "field_id":"note",
            "label":"Note",
            "type":"text",
            "target_model_id":null,
            "option_set":[],
            "archived_at":null,
            "origin":"tenant",
            "management":"tenant_managed",
            "lifecycle":"active"
        }));
    active_schema["custom_fields"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "id":"department_legacy",
            "model_id":"department",
            "field_id":"legacy",
            "label":"Legacy",
            "type":"text",
            "target_model_id":null,
            "option_set":[],
            "archived_at":"2026-01-01T00:00:00Z",
            "origin":"tenant",
            "management":"tenant_managed",
            "lifecycle":"active"
        }));
    active_schema["custom_fields"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "id":"department_retired",
            "model_id":"department",
            "field_id":"retired_note",
            "label":"Retired note",
            "type":"text",
            "target_model_id":null,
            "option_set":[],
            "archived_at":null,
            "origin":"tenant",
            "management":"tenant_managed",
            "lifecycle":"retired"
        }));
    client
        .execute(
            r#"
            insert into schema_revision (
              id,app_id,customer_id,version,base_schema,customer_overlay,schema,activated_at
            ) values (1,'sql_extensions','tenant_a','2026-08-05',$1,'{}'::jsonb,$1,now())
            "#,
            &[&active_schema],
        )
        .unwrap();
    client
        .query_one(
            "select set_config('kernel.app_id','sql_extensions',false), set_config('kernel.customer_id','tenant_a',false)",
            &[],
        )
        .unwrap();
    client
        .execute(
            r#"
            insert into lookup_storage_authority(
              app_id,customer_id,model_id,schema_hash,authority,
              legacy_record_table,legacy_version_table,activated_at
            ) values(
              'sql_extensions','tenant_a','department',repeat('a',64),'generic',
              'department_record','department_version',now()
            )
            "#,
            &[],
        )
        .expect("activate generic department authority");

    let department_a = Uuid::new_v4();
    let department_b = Uuid::new_v4();
    let employee = Uuid::new_v4();
    for (key, id, name) in [
        ("department-a", department_a, "Operations"),
        ("department-b", department_b, "Finance"),
    ] {
        let response = apply(
            &mut client,
            request(
                key,
                json!([{
                    "model_id": "department",
                    "new_record_id": id,
                    "effective_start": "2026-01-01",
                    "values": {
                        "name": {"type":"text","value":name},
                        "code": {"type":"text","value":name[0..3].to_uppercase()},
                        "status": {"type":"enum","value":"open"},
                        "__lookup_lifecycle": {"type":"schema_lifecycle","value":"active"}
                    },
                    "custom_fields": [{"field_id":"note","type":"text","value":"lookup note"}],
                    "metadata_patch": {"set":{"source":"seed"}}
                }]),
            ),
        );
        assert_eq!(response["ok"], true, "{response:#}");
    }
    let employee_response = apply(
        &mut client,
        request(
            "employee-create",
            json!([{
                "model_id": "employee",
                "new_record_id": employee,
                "effective_start": "2026-01-01",
                "values": {
                    "name": {"type":"text","value":"Ada"},
                    "nickname": {"type":"text","value":"A"}
                },
                "custom_fields": [{"field_id":"note","type":"text","value":"retain me"}],
                "metadata_patch": {"set":{"keep":"yes","remove":"old","nested":{"items":[1,2]}}}
            }]),
        ),
    );
    assert_eq!(employee_response["ok"], true, "{employee_response:#}");

    let relation_response = apply(
        &mut client,
        request(
            "department-relations",
            json!([{
                "model_id": "department",
                "record_key": {"type":"record_id","value":department_a},
                "effective_start": "2026-02-01",
                "values": {
                    "peers": {"type":"relation_list","value":[
                        {"type":"record_id","value":department_b}
                    ]}
                },
                "metadata_patch": {"remove":["source"],"set":{"edited":true}}
            }]),
        ),
    );
    assert_eq!(relation_response["ok"], true, "{relation_response:#}");
    let lookup_snapshot = client
        .query_one(
            "select values,many_relations,metadata,availability from lookup_version where model_id='department' and record_id=$1 order by effective_start desc limit 1",
            &[&department_a],
        )
        .unwrap();
    let values: Value = lookup_snapshot.get(0);
    let relations: Value = lookup_snapshot.get(1);
    let metadata: Value = lookup_snapshot.get(2);
    assert!(values.get("peers").is_none(), "{values:#}");
    assert!(values.get("__lookup_lifecycle").is_none(), "{values:#}");
    assert_eq!(relations["peers"], json!([department_b.to_string()]));
    assert_eq!(metadata, json!({"edited":true}));
    assert_eq!(lookup_snapshot.get::<_, String>(3), "active");

    let clear_response = apply(
        &mut client,
        request(
            "department-clear",
            json!([{
                "model_id": "department",
                "record_key": {"type":"record_id","value":department_a},
                "effective_start": "2026-03-01",
                "clear_fields": ["code","peers"],
                "clear_custom_fields": ["note"],
                "metadata_patch": {"set":{"cleared":true}}
            }]),
        ),
    );
    assert_eq!(clear_response["ok"], true, "{clear_response:#}");
    let cleared = client
        .query_one(
            "select values,many_relations,custom_fields from lookup_version where model_id='department' and record_id=$1 order by effective_start desc limit 1",
            &[&department_a],
        )
        .unwrap();
    let cleared_values: Value = cleared.get(0);
    let cleared_relations: Value = cleared.get(1);
    let cleared_custom_fields: Value = cleared.get(2);
    assert!(cleared_values.get("code").is_none(), "{cleared_values:#}");
    assert_eq!(cleared_relations["peers"], json!([]));
    assert_eq!(cleared_custom_fields, json!([]));

    // Unqualified history covers declared fields, many relations and active
    // custom fields in one request; record metadata stays explicit-only.
    let whole_history: Value = client
        .query_one(
            "select kernel_field_history($1::jsonb)",
            &[&json!({
                "app_id":"sql_extensions","customer_id":"tenant_a","model_id":"department",
                "record_id":department_a
            })],
        )
        .expect("read unqualified lookup history")
        .get(0);
    assert_eq!(whole_history["ok"], true, "{whole_history:#}");
    let entries = whole_history["data"].as_array().expect("history entries");
    let at = |date: &str, field: &str| -> Value {
        entries
            .iter()
            .find(|entry| entry["effective_start"] == date && entry["field_id"] == field)
            .unwrap_or_else(|| panic!("missing {field} at {date}: {whole_history:#}"))["value"]
            .clone()
    };
    let snapshot_fields: Vec<&str> = entries
        .iter()
        .filter(|entry| entry["effective_start"] == "2026-01-01")
        .map(|entry| entry["field_id"].as_str().unwrap())
        .collect();
    assert_eq!(
        snapshot_fields,
        vec!["name", "code", "status", "peers", "note"]
    );
    assert_eq!(
        at("2026-01-01", "note"),
        json!({"type":"text","value":"lookup note"})
    );
    assert_eq!(
        at("2026-01-01", "peers"),
        json!({"type":"relation_list","value":[]})
    );
    assert_eq!(
        at("2026-02-01", "peers"),
        json!({"type":"relation_list","value":[{"type":"record_id","value":department_b}]})
    );
    assert_eq!(
        at("2026-03-01", "peers"),
        json!({"type":"relation_list","value":[]})
    );
    assert_eq!(at("2026-03-01", "note"), Value::Null);
    assert!(entries
        .iter()
        .all(|entry| entry["field_id"] != "__record_metadata"));
    assert!(entries
        .iter()
        .all(|entry| entry["source_kind"] == "fixture" && entry["actor_id"] == "fixture-actor"));
    let employee_history: Value = client
        .query_one(
            "select kernel_field_history($1::jsonb)",
            &[&json!({
                "app_id":"sql_extensions","customer_id":"tenant_a","model_id":"employee",
                "record_id":employee
            })],
        )
        .expect("read unqualified entity history")
        .get(0);
    assert_eq!(employee_history["ok"], true, "{employee_history:#}");
    let employee_fields: Vec<&str> = employee_history["data"]
        .as_array()
        .expect("employee history entries")
        .iter()
        .map(|entry| entry["field_id"].as_str().unwrap())
        .collect();
    assert_eq!(employee_fields, vec!["name", "nickname", "note"]);
    assert_eq!(
        employee_history["data"][2]["value"],
        json!({"type":"text","value":"retain me"})
    );

    let employee_patch = apply(
        &mut client,
        request(
            "employee-patch",
            json!([{
                "model_id": "employee",
                "record_key": {"type":"record_id","value":employee},
                "effective_start": "2026-02-01",
                "metadata_patch": {"remove":["remove"],"set":{"new":{"ok":true}}}
            }]),
        ),
    );
    assert_eq!(employee_patch["ok"], true, "{employee_patch:#}");
    let employee_patch_id = employee_patch["data"]["id"]
        .as_i64()
        .expect("employee metadata patch change set id");
    let metadata_diff: Value = client
        .query_one(
            "select kernel_change_set_diff($1::jsonb)",
            &[&json!({
                "app_id":"sql_extensions","customer_id":"tenant_a",
                "change_set_id":employee_patch_id,"project":["__record_metadata"]
            })],
        )
        .expect("read metadata diff")
        .get(0);
    assert_eq!(metadata_diff["ok"], true, "{metadata_diff:#}");
    assert_eq!(
        metadata_diff["data"]["records"][0]["fields"][0]["field_id"],
        "__record_metadata"
    );
    assert_eq!(
        metadata_diff["data"]["records"][0]["fields"][0]["after"]["value"]["new"]["ok"],
        true
    );
    let metadata_history: Value = client
        .query_one(
            "select kernel_field_history($1::jsonb)",
            &[&json!({
                "app_id":"sql_extensions","customer_id":"tenant_a","model_id":"employee",
                "record_id":employee,"field_id":"__record_metadata",
                "stages":["mainline","reverted"]
            })],
        )
        .expect("read metadata history")
        .get(0);
    assert_eq!(metadata_history["ok"], true, "{metadata_history:#}");
    assert!(metadata_history["data"]
        .as_array()
        .expect("metadata history rows")
        .iter()
        .any(|entry| {
            entry["change_set_id"] == employee_patch_id
                && entry["value"]["value"]["new"]["ok"] == true
        }));
    let employee_metadata: Value = client
        .query_one(
            "select metadata from employee_version where record_id=$1 order by effective_start desc limit 1",
            &[&employee],
        )
        .unwrap()
        .get(0);
    assert_eq!(
        employee_metadata,
        json!({"keep":"yes","nested":{"items":[1,2]},"new":{"ok":true}})
    );

    let employee_clear = apply(
        &mut client,
        request(
            "employee-clear",
            json!([{
                "model_id": "employee",
                "record_key": {"type":"record_id","value":employee},
                "effective_start": "2026-03-01",
                "clear_fields": ["nickname"],
                "clear_custom_fields": ["note"],
                "metadata_patch": {"clear":true,"remove":["missing"],"set":{"only":"value"}}
            }]),
        ),
    );
    assert_eq!(employee_clear["ok"], true, "{employee_clear:#}");
    let employee_snapshot = client
        .query_one(
            "select nickname,custom_fields,metadata from employee_version where record_id=$1 order by effective_start desc limit 1",
            &[&employee],
        )
        .unwrap();
    assert_eq!(employee_snapshot.get::<_, Option<String>>(0), None);
    assert_eq!(employee_snapshot.get::<_, Value>(1), json!([]));
    assert_eq!(
        employee_snapshot.get::<_, Value>(2),
        json!({"only":"value"})
    );

    let required_clear = apply(
        &mut client,
        request(
            "employee-required-clear",
            json!([{
                "model_id": "employee",
                "record_key": {"type":"record_id","value":employee},
                "effective_start": "2026-04-01",
                "clear_fields": ["name"]
            }]),
        ),
    );
    assert_error_code(&required_clear, "required_field_clear");

    let set_and_clear = apply(
        &mut client,
        request(
            "employee-set-and-clear",
            json!([{
                "model_id": "employee",
                "record_key": {"type":"record_id","value":employee},
                "effective_start": "2026-04-02",
                "values": {"nickname":{"type":"text","value":"conflict"}},
                "clear_fields": ["nickname"]
            }]),
        ),
    );
    assert_error_code(&set_and_clear, "set_and_clear_field");
    let custom_set_and_clear = apply(
        &mut client,
        request(
            "custom-set-and-clear",
            json!([{
                "model_id": "employee",
                "record_key": {"type":"record_id","value":employee},
                "effective_start": "2026-04-02",
                "custom_fields": [{"field_id":"note","type":"text","value":"conflict"}],
                "clear_custom_fields": ["note"]
            }]),
        ),
    );
    assert_error_code(&custom_set_and_clear, "set_and_clear_custom_field");
    let relation_set_and_clear = apply(
        &mut client,
        request(
            "relation-set-and-clear",
            json!([{
                "model_id": "department",
                "record_key": {"type":"record_id","value":department_b},
                "effective_start": "2026-04-02",
                "values": {"peers":{"type":"relation_list","value":[]}},
                "clear_fields": ["peers"]
            }]),
        ),
    );
    assert_error_code(&relation_set_and_clear, "set_and_clear_field");
    let lifecycle_clear = apply(
        &mut client,
        request(
            "lifecycle-clear",
            json!([{
                "model_id": "department",
                "record_key": {"type":"record_id","value":department_b},
                "effective_start": "2026-04-02",
                "clear_fields": ["__lookup_lifecycle"]
            }]),
        ),
    );
    assert_error_code(&lifecycle_clear, "lookup_lifecycle_clear_forbidden");
    let metadata_tombstone = apply(
        &mut client,
        request(
            "metadata-tombstone",
            json!([{
                "model_id": "employee",
                "record_key": {"type":"record_id","value":employee},
                "effective_start": "2026-04-02",
                "tombstones_record": true,
                "metadata_patch": {"clear":true}
            }]),
        ),
    );
    assert_error_code(&metadata_tombstone, "record_event_metadata_patch_forbidden");

    let retired_option = apply(
        &mut client,
        request(
            "retired-option",
            json!([{
                "model_id": "department",
                "record_key": {"type":"record_id","value":department_b},
                "effective_start": "2026-04-01",
                "values": {"status":{"type":"enum","value":"closed"}}
            }]),
        ),
    );
    assert_error_code(&retired_option, "retired_enum_option");

    let retired_lookup = apply(
        &mut client,
        request(
            "retire-department",
            json!([{
                "model_id": "department",
                "record_key": {"type":"record_id","value":department_a},
                "effective_start": "2026-04-01",
                "values": {"__lookup_lifecycle":{"type":"schema_lifecycle","value":"retired"}}
            }]),
        ),
    );
    assert_eq!(retired_lookup["ok"], true, "{retired_lookup:#}");
    let retired_availability: String = client
        .query_one(
            "select availability from lookup_version where model_id='department' and record_id=$1 order by effective_start desc limit 1",
            &[&department_a],
        )
        .unwrap()
        .get(0);
    assert_eq!(retired_availability, "retired");

    let retired_target = apply(
        &mut client,
        request(
            "retired-target",
            json!([{
                "model_id": "department",
                "record_key": {"type":"record_id","value":department_b},
                "effective_start": "2026-05-01",
                "values": {"peers":{"type":"relation_list","value":[
                    {"type":"record_id","value":department_a}
                ]}}
            }]),
        ),
    );
    assert_eq!(retired_target["ok"], false, "{retired_target:#}");
    assert_eq!(retired_target["error"]["code"], "record_target_missing");

    let wrong_model_target = apply(
        &mut client,
        request(
            "wrong-model-target",
            json!([{
                "model_id": "department",
                "record_key": {"type":"record_id","value":department_b},
                "effective_start": "2026-05-02",
                "values": {"peers":{"type":"relation_list","value":[
                    {"type":"record_id","value":employee}
                ]}}
            }]),
        ),
    );
    assert_eq!(wrong_model_target["ok"], false, "{wrong_model_target:#}");
    assert_eq!(wrong_model_target["error"]["code"], "record_target_missing");

    client
        .execute(
            r#"
            update schema_revision
            set schema=jsonb_set(schema,'{custom_fields,0,archived_at}',to_jsonb('2026-04-01T00:00:00Z'::text))
            where id=1
            "#,
            &[],
        )
        .unwrap();
    let lifecycle_over_archived_at = apply(
        &mut client,
        request(
            "custom-lifecycle-authority",
            json!([{
                "model_id": "employee",
                "record_key": {"type":"record_id","value":employee},
                "effective_start": "2026-04-03",
                "values": {"nickname":{"type":"text","value":"preserved"}},
                "custom_fields": [{"field_id":"note","type":"text","value":"preserved"}]
            }]),
        ),
    );
    assert_eq!(
        lifecycle_over_archived_at["ok"], true,
        "{lifecycle_over_archived_at:#}"
    );
    client
        .execute(
            r#"
            update schema_revision
            set schema=jsonb_set(
              jsonb_set(schema,'{models,1,fields,1,lifecycle}','"retired"'::jsonb),
              '{custom_fields,0,lifecycle}','"retired"'::jsonb
            )
            where id=1
            "#,
            &[],
        )
        .unwrap();
    let retired_inheritance = apply(
        &mut client,
        request(
            "retired-inheritance",
            json!([{
                "model_id": "employee",
                "record_key": {"type":"record_id","value":employee},
                "effective_start": "2026-05-01",
                "metadata_patch": {"set":{"after_retirement":true}}
            }]),
        ),
    );
    assert_eq!(retired_inheritance["ok"], true, "{retired_inheritance:#}");
    let inherited_retired = client
        .query_one(
            "select nickname,custom_fields from employee_version where record_id=$1 order by effective_start desc limit 1",
            &[&employee],
        )
        .unwrap();
    assert_eq!(
        inherited_retired.get::<_, Option<String>>(0).as_deref(),
        Some("preserved")
    );
    assert_eq!(inherited_retired.get::<_, Value>(1), json!([]));
    let retired_field_set = apply(
        &mut client,
        request(
            "retired-field-set",
            json!([{
                "model_id": "employee",
                "record_key": {"type":"record_id","value":employee},
                "effective_start": "2026-05-02",
                "values": {"nickname":{"type":"text","value":"no"}}
            }]),
        ),
    );
    assert_error_code(&retired_field_set, "retired_write_field");
    let retired_field_clear = apply(
        &mut client,
        request(
            "retired-field-clear",
            json!([{
                "model_id": "employee",
                "record_key": {"type":"record_id","value":employee},
                "effective_start": "2026-05-02",
                "clear_fields": ["nickname"]
            }]),
        ),
    );
    assert_error_code(&retired_field_clear, "retired_field_clear");
    let retired_custom_set = apply(
        &mut client,
        request(
            "retired-custom-set",
            json!([{
                "model_id": "employee",
                "record_key": {"type":"record_id","value":employee},
                "effective_start": "2026-05-02",
                "custom_fields": [{"field_id":"note","type":"text","value":"no"}]
            }]),
        ),
    );
    assert_error_code(&retired_custom_set, "archived_custom_field");
    let retired_custom_clear = apply(
        &mut client,
        request(
            "retired-custom-clear",
            json!([{
                "model_id": "employee",
                "record_key": {"type":"record_id","value":employee},
                "effective_start": "2026-05-02",
                "clear_custom_fields": ["note"]
            }]),
        ),
    );
    assert_error_code(&retired_custom_clear, "unknown_clear_custom_field");
    client
        .execute(
            "update schema_revision set schema=jsonb_set(schema,'{models,1,lifecycle}','\"retired\"'::jsonb) where id=1",
            &[],
        )
        .unwrap();
    let retired_model_write = apply(
        &mut client,
        request(
            "retired-model-write",
            json!([{
                "model_id": "employee",
                "record_key": {"type":"record_id","value":employee},
                "effective_start": "2026-05-03",
                "metadata_patch": {"set":{"no":true}}
            }]),
        ),
    );
    assert_error_code(&retired_model_write, "retired_write_model");

    let permissive_limits = json!({
        "max_bytes": 1024,
        "max_depth": 8,
        "max_keys": 32,
        "max_key_bytes": 64,
        "max_scalar_bytes": 128,
        "max_array_items": 16
    });
    let metadata_limit_cases = [
        (json!({"a":"long"}), json!({"max_bytes":8})),
        (json!({"a":{"b":{"c":1}}}), json!({"max_depth":1})),
        (json!({"a":1,"b":2}), json!({"max_keys":1})),
        (json!({"long":1}), json!({"max_key_bytes":3})),
        (json!({"a":"long"}), json!({"max_scalar_bytes":3})),
        (json!({"a":[1,2]}), json!({"max_array_items":1})),
    ];
    for (invalid, override_limits) in metadata_limit_cases {
        let mut limits = permissive_limits.clone();
        limits
            .as_object_mut()
            .unwrap()
            .extend(override_limits.as_object().unwrap().clone());
        let valid: bool = client
            .query_one(
                "select kernel_apply_metadata_valid($1::jsonb,$2::jsonb)",
                &[&invalid, &limits],
            )
            .unwrap()
            .get(0);
        assert!(
            !valid,
            "metadata should exceed one of the six limits: {invalid}"
        );
    }

    let legacy_write = apply(
        &mut client,
        request(
            "legacy-write",
            json!([{
                "model_id": "department",
                "record_key": {"type":"record_id","value":department_b},
                "effective_start": "2026-06-01",
                "values": {"name":{"type":"text","value":"Finance"}},
                "lookup_availability": "retired"
            }]),
        ),
    );
    assert_eq!(legacy_write["ok"], false, "{legacy_write:#}");
    assert_eq!(legacy_write["error"]["code"], "serialization_error");

    trusted_human::drop_fixture(&mut client, &schema_name).unwrap();
}

/// Reads with pending drafts overlay a draft's many-relation writes (replace
/// and clear) in save order, only where the draft wrote the relation, and
/// stop once the draft is approved or discarded.
#[test]
fn pending_drafts_overlay_written_many_relations() {
    let database_url = match env::var("KERNEL_TEST_DATABASE_URL") {
        Ok(value) if !value.trim().is_empty() => value,
        Ok(_) | Err(env::VarError::NotPresent) => {
            eprintln!("skipping many-relation draft test: KERNEL_TEST_DATABASE_URL is absent");
            return;
        }
        Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
    };
    let mut client = connect_postgres(&database_url).expect("connect to PostgreSQL");
    let fixture = compiled();
    let schema_name = format!("kernel_extensions_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            "create schema \"{schema_name}\"; set search_path to \"{schema_name}\""
        ))
        .unwrap();
    let manifest = compile_sql_artifact_manifest(&fixture).unwrap();
    trusted_human::before_install(&mut client);
    client
        .batch_execute(&render_sql_artifact_bundle(&manifest))
        .unwrap();
    let active_schema = serde_json::to_value(&fixture.schema).unwrap();
    client
        .execute(
            "insert into schema_revision (id,app_id,customer_id,version,base_schema,customer_overlay,schema,activated_at) \
             values (1,'sql_extensions','tenant_a','2026-08-05',$1,'{}'::jsonb,$1,now())",
            &[&active_schema],
        )
        .unwrap();
    client
        .query_one(
            "select set_config('kernel.app_id','sql_extensions',false), set_config('kernel.customer_id','tenant_a',false)",
            &[],
        )
        .unwrap();
    client
        .execute(
            "insert into lookup_storage_authority(app_id,customer_id,model_id,schema_hash,authority,legacy_record_table,legacy_version_table,activated_at) \
             values('sql_extensions','tenant_a','department',repeat('a',64),'generic','department_record','department_version',now())",
            &[],
        )
        .unwrap();
    let [a, b, c] = [Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()];
    for (key, id, name) in [
        ("a", a, "Operations"),
        ("b", b, "Finance"),
        ("c", c, "Legal"),
    ] {
        let created = apply(
            &mut client,
            request(
                key,
                json!([{"model_id":"department","new_record_id":id,"effective_start":"2026-01-01",
                    "values":{"name":{"type":"text","value":name},
                        "__lookup_lifecycle":{"type":"schema_lifecycle","value":"active"}}}]),
            ),
        );
        assert_eq!(created["ok"], true, "{created:#}");
    }
    let peers = |ids: &[Uuid]| json!({"type":"relation_list","value":ids.iter().map(|id| json!({"type":"record_id","value":id})).collect::<Vec<_>>()});
    let mainline = apply(
        &mut client,
        request(
            "a-peers",
            json!([{"model_id":"department","record_key":{"type":"record_id","value":a},
                "effective_start":"2026-01-10","values":{"peers":peers(&[b])}}]),
        ),
    );
    assert_eq!(mainline["ok"], true, "{mainline:#}");
    let draft = |client: &mut postgres::Client, key: &str, write: Value| -> i64 {
        let mut body = request(key, json!([write]));
        body["mode"] = json!("draft");
        let saved = apply(client, body);
        assert_eq!(saved["ok"], true, "{saved:#}");
        saved["data"]["id"].as_i64().unwrap()
    };
    let target = json!({"model_id":"department","record_key":{"type":"record_id","value":a},"effective_start":"2026-01-15"});
    let with = |extra: Value| {
        let mut write = target.clone();
        write
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        write
    };
    let read = |client: &mut postgres::Client, drafts: bool| -> Value {
        let answer: Value = client
            .query_one(
                "select kernel_data_query($1::jsonb)",
                &[&json!({"app_id":"sql_extensions","customer_id":"tenant_a","schema_version":"2026-08-05",
                    "model_id":"department","as_of":"2026-02-01","select":["$id","name","peers"],
                    "include_pending_drafts":drafts})],
            )
            .unwrap()
            .get(0);
        assert_eq!(answer["ok"], true, "{answer:#}");
        let row = answer["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["record_id"] == a.to_string())
            .cloned()
            .unwrap();
        json!({"name":row["values"]["name"]["value"],"peers":row["many_relations"]["peers"]})
    };
    let ids = |ids: &[Uuid]| json!(ids.iter().map(|id| id.to_string()).collect::<Vec<_>>());

    // A draft replacing the list shows with pending drafts on, never off.
    let replace = draft(
        &mut client,
        "replace",
        with(json!({"values":{"peers":peers(&[c])}})),
    );
    assert_eq!(read(&mut client, false)["peers"], ids(&[b]));
    assert_eq!(read(&mut client, true)["peers"], ids(&[c]));
    // A later draft clearing it wins; discarding it brings the replacement back.
    let clear = draft(
        &mut client,
        "clear",
        with(json!({"clear_fields":["peers"]})),
    );
    assert_eq!(read(&mut client, true)["peers"], json!([]));
    trusted_human::select(&mut client, "fixture-actor");
    let discarded: Value = client
        .query_one(
            "select kernel_discard_draft_change_set($1::jsonb)",
            &[&json!({"app_id":"sql_extensions","customer_id":"tenant_a","actor_id":"fixture-actor","change_set_id":clear})],
        )
        .unwrap()
        .get(0);
    assert_eq!(discarded["ok"], true, "{discarded:#}");
    assert_eq!(read(&mut client, true)["peers"], ids(&[c]));
    // A draft that does not write the list leaves it alone, even though its
    // version still holds the list it was saved over.
    draft(
        &mut client,
        "rename",
        with(json!({"values":{"name":{"type":"text","value":"Ops"}}})),
    );
    assert_eq!(
        read(&mut client, true),
        json!({"name":"Ops","peers":ids(&[c])})
    );
    // Approving the replacement publishes it once; the pending rename still
    // shows only its name.
    let approved: Value = client
        .query_one(
            "select kernel_approve_draft_change_set($1::jsonb)",
            &[&json!({"app_id":"sql_extensions","customer_id":"tenant_a","actor_id":"fixture-actor","change_set_id":replace})],
        )
        .unwrap()
        .get(0);
    assert_eq!(approved["ok"], true, "{approved:#}");
    assert_eq!(
        read(&mut client, false),
        json!({"name":"Operations","peers":ids(&[c])})
    );
    assert_eq!(
        read(&mut client, true),
        json!({"name":"Ops","peers":ids(&[c])})
    );
}
