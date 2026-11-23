use schema_compiler::{compile_manifest_json, compile_sql_artifact_manifest, SqlArtifactKind};
use serde_json::{json, Value};

fn policy_manifest() -> Value {
    json!({
        "app_id": "authorization_fixture",
        "customer_id": "base",
        "version": "authorization-v1",
        "models": [
            {
                "id": "work_item",
                "kind": "entity",
                "label": "Work item",
                "extensions": {"typed_custom_fields": true, "record_metadata": {"max_bytes": 1024, "max_depth": 4, "max_keys": 16, "max_key_bytes": 64, "max_scalar_bytes": 256, "max_array_items": 16}},
                "fields": [
                    {"id":"owner","label":"Owner","type":"text","required":true},
                    {"id":"summary","label":"Summary","type":"text"},
                    {"id":"score","label":"Score","type":"number"},
                    {"id":"open","label":"Open","type":"bool"},
                    {"id":"due_date","label":"Due date","type":"date"},
                    {"id":"observed_at","label":"Observed at","type":"datetime"},
                    {"id":"parent","label":"Parent","type":"relation","target_model":"work_item"},
                    {"id":"tags","label":"Tags","type":"text_list"},
                    {"id":"aliases","label":"Aliases","type":"known_aliases"},
                    {"id":"payload","label":"Payload","type":"json"},
                    {"id":"state","label":"State","type":"enum","option_set":[{"id":"open","label":"Open"}]},
                    {"id":"country","label":"Country","type":"iso_country"},
                    {"id":"currency","label":"Currency","type":"iso_currency"},
                    {"id":"rate","label":"Rate","type":"money_rate"}
                ],
                "many_relations": [{"id":"children_many","label":"Children","target_model":"child"}],
                "inverse_relations": [{"id":"children_inverse","model":"child","through":"work_item"}]
            },
            {
                "id": "child",
                "kind": "entity",
                "label": "Child",
                "fields": [
                    {"id":"work_item","label":"Work item","type":"relation","target_model":"work_item"},
                    {"id":"name","label":"Name","type":"text"}
                ]
            }
        ],
        "custom_fields": [{
            "id":"case_priority_definition","model":"work_item","field":"priority","label":"Priority","type":"enum",
            "option_set":[{"id":"high","label":"High"}]
        }],
        "authorization": {
            "roles": [{"id":"Writer"},{"id":"Reviewer","label":"Reviewer"}],
            "grants": [
                {
                    "role":"Writer","model":"Work item","operations":["update","create"],
                    "write_fields":["summary","priority","$metadata"],
                    "record":{"kind":"all"}
                },
                {
                    "role":"Reviewer","model":"Work item","operations":["history","read"],
                    "read_fields":["summary","owner","score","open","due_date","observed_at","parent","tags","aliases","payload","state","country","currency","rate","priority","children_many","$id","$externalKey","$version","$effectiveStart","$effectiveEnd","$metadata"],
                    "read_relations":["children_inverse"],
                    "record":{"kind":"actor_equals_field","field":"owner"}
                }
            ]
        }
    })
}

fn compile(
    value: &Value,
) -> Result<schema_compiler::CompiledManifest, schema_compiler::CompileError> {
    compile_manifest_json(&serde_json::to_string(value).unwrap())
}

#[test]
fn normalizes_policy_for_all_supported_field_categories_and_declares_immutable_catalog() {
    let compiled = compile(&policy_manifest()).expect("policy manifest compiles");
    let policy = compiled
        .extras
        .authorization_policy
        .as_ref()
        .expect("normalized authorization policy");
    assert_eq!(
        policy
            .roles
            .iter()
            .map(|role| role.id.as_str())
            .collect::<Vec<_>>(),
        vec!["reviewer", "writer"]
    );
    assert_eq!(
        policy.relations,
        vec![schema_compiler::NormalizedAuthorizationRelation {
            model: "work_item".to_string(),
            id: "children_inverse".to_string(),
            target_model: "child".to_string(),
            through: "work_item".to_string()
        },]
    );
    assert_eq!(policy.grants.len(), 2);
    assert_eq!(policy.grants[0].role, "reviewer");
    assert_eq!(policy.grants[0].model, "work_item");
    assert_eq!(policy.grants[0].read_fields.len(), 22);
    assert_eq!(policy.grants[0].read_relations, vec!["children_inverse"]);
    assert_eq!(
        policy.grants[1].write_fields,
        vec!["$metadata", "priority", "summary"]
    );

    let artifacts = compile_sql_artifact_manifest(&compiled).expect("policy catalog compiles");
    let catalog = artifacts
        .artifacts
        .iter()
        .find(|artifact| artifact.kind == SqlArtifactKind::AuthorizationPolicyCatalog)
        .expect("authorization policy catalog artifact");
    assert!(catalog.sql.contains("schema_authorization_policy_source"));
    assert!(catalog
        .sql
        .contains("schema_authorization_policy_expectation"));
    assert!(catalog.sql.contains("policy_declared, policy_hash) values (\x27authorization_fixture\x27, \x27authorization-v1\x27, true"));
    assert!(catalog
        .sql
        .contains("schema authorization policy source drift"));
    assert!(catalog
        .sql
        .contains("schema authorization policy expectation drift"));
    let data_plane = schema_compiler::data_plane::compile(&compiled).expect("data plane compiles");
    assert_eq!(
        data_plane["manifest"]["capabilities"]["authorization"],
        true
    );
    assert_eq!(
        data_plane["manifest"]["authorization"]["membership"]["identity"],
        "exact_principal_app_customer_actor_role"
    );
    assert_eq!(
        data_plane["manifest"]["authorization"]["grants"]["history"],
        "current_policy_all_or_error_temporal_images"
    );
    assert!(data_plane["manifest"]["authorization"]["supported"]
        .as_array()
        .unwrap()
        .contains(&json!("relation_list")));
    assert!(data_plane["manifest"]["authorization"]["unsupported"]
        .as_array()
        .unwrap()
        .contains(&json!("legacy_prepared_query")));
    assert!(data_plane["manifest"]["authorization"]["unsupported"]
        .as_array()
        .unwrap()
        .contains(&json!("legacy_external_key_write_subjects")));
    let mut legacy_manifest = policy_manifest();
    legacy_manifest
        .as_object_mut()
        .unwrap()
        .remove("authorization");
    let legacy = compile(&legacy_manifest).expect("legacy manifest compiles");
    let legacy_data_plane =
        schema_compiler::data_plane::compile(&legacy).expect("legacy data plane compiles");
    assert!(legacy_data_plane["manifest"]["capabilities"]
        .get("authorization")
        .is_none());
    assert!(legacy_data_plane["manifest"].get("authorization").is_none());
    let legacy_work_item = legacy_data_plane["manifest"]["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|model| model["id"] == "work_item")
        .expect("legacy work item generated model");
    let legacy_relation_operation = legacy_work_item["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|operation| operation["id"] == "work_item.relations.children_inverse.list")
        .expect("stable legacy inverse relation operation id");
    assert_eq!(legacy_relation_operation["permission"], "child.list");
    let work_item = data_plane["manifest"]["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|model| model["id"] == "work_item")
        .expect("work item generated model");
    assert_eq!(work_item["relations"][0]["id"], "children_inverse");
    let relation_operation = work_item["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|operation| operation["id"] == "work_item.relations.children_inverse.list")
        .expect("stable inverse relation operation id");
    assert_eq!(
        relation_operation["permission"],
        "work_item.relations.children_inverse.list"
    );
    assert_eq!(
        relation_operation["name"],
        "workItem.relations.childrenInverse.list"
    );
}

#[test]
fn policy_canonicalization_is_deterministic_and_empty_lookup_policy_is_explicit() {
    let first = compile(&policy_manifest()).unwrap();
    let mut reordered = policy_manifest();
    reordered["authorization"]["roles"]
        .as_array_mut()
        .unwrap()
        .reverse();
    reordered["authorization"]["grants"]
        .as_array_mut()
        .unwrap()
        .reverse();
    reordered["authorization"]["grants"][0]["operations"] = json!(["read", "history"]);
    reordered["authorization"]["grants"][0]["read_fields"]
        .as_array_mut()
        .unwrap()
        .reverse();
    reordered["authorization"]["grants"][0]["read_relations"]
        .as_array_mut()
        .unwrap()
        .reverse();
    let second = compile(&reordered).unwrap();
    assert_eq!(
        first.extras.authorization_policy,
        second.extras.authorization_policy
    );
    assert_eq!(
        compile_sql_artifact_manifest(&first).unwrap(),
        compile_sql_artifact_manifest(&second).unwrap()
    );

    let lookup = json!({
        "app_id":"lookup_policy_fixture", "customer_id":"base", "version":"lookup-v1",
        "models":[{"id":"region","kind":"lookup","label":"Region","fields":[{"id":"name","label":"Name","type":"text","required":true}],"many_relations":[{"id":"related_regions","label":"Related regions","target_model":"region"}]}],
        "authorization":{"roles":[{"id":"writer"}],"grants":[{"role":"writer","model":"region","operations":["update"],"write_fields":["related_regions"],"record":{"kind":"all"}}]}
    });
    let compiled = compile(&lookup).expect("empty policy is deny all");
    assert_eq!(
        compiled
            .extras
            .authorization_policy
            .expect("explicit policy")
            .grants[0]
            .write_fields,
        vec!["related_regions"]
    );
}

#[test]
fn authorization_rejects_invalid_references_operations_and_owner_predicates() {
    type InvalidPolicyCase = (&'static str, Box<dyn Fn(&mut Value)>);
    let cases: Vec<InvalidPolicyCase> = vec![
        (
            "unknown_authorization_role",
            Box::new(|value| value["authorization"]["grants"][0]["role"] = json!("missing")),
        ),
        (
            "unknown_authorization_model",
            Box::new(|value| value["authorization"]["grants"][0]["model"] = json!("missing")),
        ),
        (
            "duplicate_authorization_operation",
            Box::new(|value| {
                value["authorization"]["grants"][0]["operations"] = json!(["read", "read"])
            }),
        ),
        (
            "unknown_authorization_field",
            Box::new(|value| {
                value["authorization"]["grants"][1]["read_fields"][0] = json!("missing")
            }),
        ),
        (
            "unknown_authorization_relation",
            Box::new(|value| {
                value["authorization"]["grants"][1]["read_relations"][0] = json!("missing")
            }),
        ),
        (
            "invalid_authorization_owner_field",
            Box::new(|value| {
                value["authorization"]["grants"][1]["record"]["field"] = json!("summary")
            }),
        ),
        (
            "inapplicable_authorization_read_fields",
            Box::new(|value| {
                value["authorization"]["grants"][1]["operations"] = json!(["delete"]);
            }),
        ),
        (
            "readonly_authorization_field",
            Box::new(|value| {
                value["authorization"]["grants"][0]["write_fields"] = json!(["$id"]);
            }),
        ),
        (
            "readonly_authorization_field",
            Box::new(|value| {
                value["models"][0]["extensions"]
                    .as_object_mut()
                    .unwrap()
                    .remove("record_metadata");
            }),
        ),
        (
            "unsupported_authorization_relation",
            Box::new(|value| {
                value["authorization"]["grants"][1]["read_relations"] = json!(["children_many"]);
            }),
        ),
        (
            "unsupported_authorization_field",
            Box::new(|value| {
                value["authorization"]["grants"][0]["write_fields"] = json!(["children_many"]);
            }),
        ),
        (
            "invalid_identifier_character",
            Box::new(|value| value["authorization"]["roles"][0]["id"] = json!("reviewer!")),
        ),
    ];
    for (expected, mutate) in cases {
        let mut value = policy_manifest();
        mutate(&mut value);
        assert_eq!(compile(&value).unwrap_err().code, expected, "{expected}");
    }

    let mut unsupported_operation = policy_manifest();
    unsupported_operation["authorization"]["grants"][0]["operations"] = json!(["execute"]);
    assert_eq!(
        compile(&unsupported_operation).unwrap_err().code,
        "invalid_manifest_json"
    );
}

#[test]
fn policy_references_preserve_declared_logical_ids() {
    let manifest = json!({
        "app_id":"mixed_policy", "customer_id":"base", "version":"v1",
        "models":[
            {"id":"Work Item","kind":"entity","label":"Work", "fields":[
                {"id":"Owner Name","label":"Owner","type":"text","required":true}
            ], "inverse_relations":[{"id":"Child Items","model":"Child Item","through":"Parent Item"}]},
            {"id":"Child Item","kind":"entity","label":"Child", "fields":[
                {"id":"Parent Item","label":"Parent","type":"relation","target_model":"Work Item"}
            ]}
        ],
        "authorization":{"roles":[{"id":"Reader"}], "grants":[{
            "role":"reader","model":"work-item","operations":["read","update"],
            "read_fields":["owner_name"], "write_fields":["owner-name"],
            "read_relations":["child_items"],
            "record":{"kind":"actor_equals_field","field":"owner_name"}
        }]}
    });
    let compiled = compile(&manifest).expect("noncanonical logical IDs remain valid");
    let policy = compiled.extras.authorization_policy.unwrap();
    let grant = &policy.grants[0];
    assert_eq!(grant.model, "Work Item");
    assert_eq!(grant.read_fields, vec!["Owner Name"]);
    assert_eq!(grant.write_fields, vec!["Owner Name"]);
    assert_eq!(grant.read_relations, vec!["Child Items"]);
    assert_eq!(policy.relations[0].model, "Work Item");
}

#[test]
fn bounded_model_tables_keep_raw_authorization_guards() {
    let model_id =
        "a_very_long_model_identifier_that_exceeds_the_postgresql_identifier_limit_for_storage";
    let compiled = compile(&json!({
        "app_id":"long_policy", "customer_id":"base", "version":"v1",
        "models":[{"id":model_id,"label":"Long model","kind":"entity","fields":[{"id":"name","label":"Name","type":"text"}]}]
    }))
    .unwrap();
    let sql = compile_sql_artifact_manifest(&compiled).unwrap();
    let policies = sql.artifacts.iter().filter(|artifact| {
        artifact.kind == SqlArtifactKind::Policy && artifact.name.starts_with("a_very_long_model")
    });
    let policies = policies.collect::<Vec<_>>();
    assert_eq!(policies.len(), 2);
    for policy in policies {
        assert!(
            policy
                .sql
                .contains("kernel_policy_raw_table_access_allowed"),
            "{}",
            policy.name
        );
    }
}
