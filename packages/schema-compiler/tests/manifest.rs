use kernel::{
    CustomFieldType, FieldId, FieldType, FieldValue, ModelId, ModelKind, RecordKey,
    SchemaElementLifecycle, SchemaElementOrigin, SchemaManagementPolicy,
};
use schema_compiler::{compile_app_artifact_json, compile_manifest_json};

const FULL_MANIFEST: &str = r#"
{
  "app_id": "compiler_fixture",
  "customer_id": "base",
  "version": "2026-07-13.base",
  "models": [
    {
      "id": "company",
      "kind": "entity",
      "label": "Company",
      "notes": "Parent records",
      "extensions": {"typed_custom_fields": true},
      "field_groups": [
        {"id": "summary", "label": "Summary", "fields": ["name"]},
        {"id": "classification", "label": "Classification", "fields": ["status"]}
      ],
      "fields": [
        {"id": "name", "label": "Name", "type": "text", "required": true, "is_unique": true},
        {"id": "status", "label": "Status", "type": "enum", "option_set": [
          {"id": "active", "label": "Active", "aliases": ["current"], "notes": "Still trading"},
          {"id": "inactive", "label": "Inactive"}
        ]}
      ],
      "inverse_relations": [
        {"id": "employees", "model": "employee", "through": "company", "label": "Employees"}
      ],
      "derived_fields": [
        {"id": "display_name", "label": "Display name", "type": "text", "expression": {"type": "concat", "expressions": [{"type": "field", "field": "name"}, {"type": "literal", "value": {"type": "text", "value": " (company)"}}]}}
      ]
    },
    {
      "id": "employee",
      "kind": "entity",
      "label": "Employee",
      "fields": [
        {"id": "company", "label": "Company", "type": "relation", "target_model": "company"},
        {"id": "name", "label": "Name", "type": "text", "required": true, "notes": "Display name"}
      ]
    },
    {
      "id": "region",
      "kind": "lookup",
      "label": "Region",
      "display_field_id": "name",
      "fields": [
        {"id": "known_aliases", "label": "Aliases", "type": "known_aliases"},
        {"id": "name", "label": "Name", "type": "text", "required": true, "is_unique": true}
      ]
    }
  ],
  "change_types": [
    {"id": "employee_create", "label": "Create employee", "model": "employee", "touches": ["name"], "required": ["name"], "is_import_default": true},
    {"id": "region_update", "label": "Update region", "model": "region"}
  ],
  "constraints": [
    {"id": "company_status", "label": "Company status", "model": "company", "authority": "authoritative", "expression": {"type": "field_in", "field": "status", "values": [{"type": "enum", "value": "active"}, {"type": "enum", "value": "inactive"}]}},
    {"id": "employee_name_hint", "label": "Employee name hint", "model": "employee", "authority": "advisory", "expression": {"type": "field_present", "field": "name"}, "message": "Add a name"}
  ],
  "seed_change_sets": [
    {
      "id": "seed_region_north_america",
      "effective_start": "2024-01-01",
      "change_type": "region_update",
      "actor_id": "compiler fixture",
      "source_kind": "fixture_seed",
      "idempotency_key": "fixture-region-north-america",
      "notes": "Base lookup",
      "writes": [{
        "model": "region",
        "record_key": {"type": "external_key", "value": "north_america"},
        "values": {"name": "North America", "known_aliases": ["NA", "North America"]},
        "provenance": {"source": "fixture seed"}
      }]
    }
  ]
}
"#;

#[test]
fn compiles_full_manifest_to_kernel_schema_and_normalized_extras() {
    let compiled = compile_manifest_json(FULL_MANIFEST).unwrap();

    assert_eq!(
        compiled
            .schema
            .models
            .iter()
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>(),
        vec!["company", "employee", "region"]
    );
    assert_eq!(compiled.schema.models[2].kind, ModelKind::Lookup);
    assert_eq!(
        compiled.schema.models[2]
            .display_field_id
            .as_ref()
            .map(|field| field.as_str()),
        Some("name")
    );
    assert_eq!(
        compiled.schema.models[0].fields[1].field_type,
        FieldType::Enum
    );
    assert_eq!(compiled.schema.models[0].fields[1].option_set.len(), 2);
    assert_eq!(compiled.extras.inverse_relations[0].owner_model, "company");
    assert_eq!(compiled.extras.constraints.len(), 2);
    assert_eq!(compiled.extras.derived_fields[0].field.id, "display_name");
    assert_eq!(
        compiled.extras.seed_change_sets[0].idempotency_key,
        "fixture-region-north-america"
    );
    assert_eq!(compiled.extras.seed_change_sets[0].seed_identity.len(), 64);
    assert_eq!(
        compiled.extras.seed_change_sets[0].seed_record_ids.len(),
        compiled.extras.seed_change_sets[0].writes.len()
    );
    assert_eq!(compiled.extras.field_metadata[1].enum_option_notes.len(), 1);
    assert_eq!(
        compiled.extras.model_metadata[0]
            .field_groups
            .iter()
            .map(|group| group.id.as_str())
            .collect::<Vec<_>>(),
        vec!["summary", "classification"]
    );
    assert_eq!(
        compiled.extras.model_metadata[0].field_groups[0].fields,
        vec!["name"]
    );
    assert!(compiled.extras.model_metadata[1].field_groups.is_empty());
    assert_eq!(compiled.schema.change_types[0].touches[0].as_str(), "name");
    assert!(compiled.schema.change_types[0].is_import_default);
    assert_eq!(
        compiled.extras.seed_change_sets[0].writes[0].provenance,
        Some(serde_json::json!({"source": "fixture seed"}))
    );
}

#[test]
fn rejects_invalid_field_group_metadata() {
    let base: serde_json::Value = serde_json::from_str(FULL_MANIFEST).unwrap();
    for (groups, code) in [
        (
            serde_json::json!([{"id": "summary", "label": "Summary", "fields": ["missing"]}]),
            "unknown_field_group_field",
        ),
        (
            serde_json::json!([{"id": "summary", "label": "Summary", "fields": ["name"]}, {"id": "classification", "label": "Classification", "fields": ["name"]}]),
            "duplicate_field_group_membership",
        ),
        (
            serde_json::json!([{"id": "other", "label": "Other", "fields": ["name"]}]),
            "reserved_field_group_id",
        ),
    ] {
        let mut manifest = base.clone();
        manifest["models"][0]["field_groups"] = groups;
        assert_eq!(
            compile_manifest_json(&serde_json::to_string(&manifest).unwrap())
                .unwrap_err()
                .code,
            code
        );
    }
}

#[test]
fn field_groups_do_not_change_persisted_kernel_schema() {
    let with_groups = compile_manifest_json(FULL_MANIFEST).unwrap();
    let mut without_groups: serde_json::Value = serde_json::from_str(FULL_MANIFEST).unwrap();
    without_groups["models"][0]
        .as_object_mut()
        .unwrap()
        .remove("field_groups");
    let without_groups =
        compile_manifest_json(&serde_json::to_string(&without_groups).unwrap()).unwrap();
    assert_eq!(with_groups.schema, without_groups.schema);
    assert!(without_groups.extras.model_metadata[0]
        .field_groups
        .is_empty());
}

#[test]
fn seed_identity_and_record_ids_are_stable_across_release_payload_changes() {
    let original = compile_manifest_json(FULL_MANIFEST).unwrap();
    let original_seed = &original.extras.seed_change_sets[0];
    let mut changed: serde_json::Value = serde_json::from_str(FULL_MANIFEST).unwrap();
    changed["seed_change_sets"][0]["idempotency_key"] =
        serde_json::json!("fixture-region-north-america-v2");
    changed["seed_change_sets"][0]["writes"][0]["values"]["name"] =
        serde_json::json!("North America renamed by a later release");

    let changed = compile_manifest_json(&serde_json::to_string(&changed).unwrap()).unwrap();
    let changed_seed = &changed.extras.seed_change_sets[0];
    assert_eq!(changed_seed.seed_identity, original_seed.seed_identity);
    assert_eq!(changed_seed.seed_record_ids, original_seed.seed_record_ids);
    assert_ne!(changed_seed.idempotency_key, original_seed.idempotency_key);
    assert_ne!(changed_seed.writes, original_seed.writes);

    let mut renamed: serde_json::Value = serde_json::from_str(FULL_MANIFEST).unwrap();
    renamed["seed_change_sets"][0]["id"] =
        serde_json::json!("seed_region_north_america_reintroduced");
    let renamed = compile_manifest_json(&serde_json::to_string(&renamed).unwrap()).unwrap();
    assert_ne!(
        renamed.extras.seed_change_sets[0].seed_identity,
        original_seed.seed_identity
    );
    assert_eq!(
        renamed.extras.seed_change_sets[0].seed_record_ids,
        original_seed.seed_record_ids
    );
}

#[test]
fn compiles_effective_schema_custom_fields() {
    let mut manifest: serde_json::Value = serde_json::from_str(FULL_MANIFEST).unwrap();
    manifest["custom_fields"] = serde_json::json!([{
        "id": "company_risk_definition",
        "model": "company",
        "field": "risk",
        "label": "Risk",
        "type": "enum",
        "option_set": [{"id": "low", "label": "Low"}],
        "archived_at": "2026-08-04T12:00:00Z"
    }]);

    let compiled = compile_manifest_json(&serde_json::to_string(&manifest).unwrap()).unwrap();
    let field = &compiled.schema.custom_fields[0];
    assert_eq!(field.model_id.as_str(), "company");
    assert_eq!(field.field_id.as_str(), "risk");
    assert_eq!(field.field_type, CustomFieldType::Enum);
    assert_eq!(field.option_set[0].id.as_str(), "low");
    assert!(field.archived_at.is_some());
    assert_eq!(field.lifecycle, SchemaElementLifecycle::Retired);

    manifest["custom_fields"][0]["archived_at"] = serde_json::json!("not-a-timestamp");
    let error = compile_manifest_json(&serde_json::to_string(&manifest).unwrap()).unwrap_err();
    assert_eq!(error.code, "invalid_custom_field_archived_at");
}

#[test]
fn compiler_only_ids_use_kernel_identifier_rules() {
    let mut manifest: serde_json::Value = serde_json::from_str(FULL_MANIFEST).unwrap();
    manifest["models"][0]["many_relations"] = serde_json::json!([{
        "id": "employee-list",
        "label": "Employees",
        "target_model": "employee"
    }, {
        "id": "employee list",
        "label": "Duplicate employees",
        "target_model": "employee"
    }]);

    let error = compile_manifest_json(&serde_json::to_string(&manifest).unwrap()).unwrap_err();
    assert_eq!(error.code, "duplicate_model_metadata_id");

    manifest["models"][0]["many_relations"][1]["id"] = serde_json::json!("employees.list");
    let error = compile_manifest_json(&serde_json::to_string(&manifest).unwrap()).unwrap_err();
    assert_eq!(error.code, "invalid_identifier_character");
}

#[test]
fn seed_writes_support_deterministic_new_record_ids() {
    let mut manifest: serde_json::Value = serde_json::from_str(FULL_MANIFEST).unwrap();
    let write = &mut manifest["seed_change_sets"][0]["writes"][0];
    write.as_object_mut().unwrap().remove("record_key");
    write["new_record_id"] = serde_json::json!("018f6bf3-1ea5-7812-9a5a-a1f5b04f0100");

    let compiled = compile_manifest_json(&serde_json::to_string(&manifest).unwrap()).unwrap();
    assert_eq!(
        compiled.extras.seed_change_sets[0].writes[0]
            .new_record_id
            .map(|id| id.to_string()),
        Some("018f6bf3-1ea5-7812-9a5a-a1f5b04f0100".to_string())
    );
    assert!(compiled.extras.seed_change_sets[0].writes[0]
        .record_key
        .is_none());
}

#[test]
fn seed_writes_reject_ambiguous_subjects() {
    let mut manifest: serde_json::Value = serde_json::from_str(FULL_MANIFEST).unwrap();
    manifest["seed_change_sets"][0]["writes"][0]["new_record_id"] =
        serde_json::json!("018f6bf3-1ea5-7812-9a5a-a1f5b04f0100");

    let error = compile_manifest_json(&serde_json::to_string(&manifest).unwrap()).unwrap_err();
    assert_eq!(error.code, "invalid_seed_write_subject");
}

#[test]
fn many_relations_compile_into_the_kernel_schema_and_compiler_extras() {
    let mut manifest: serde_json::Value = serde_json::from_str(FULL_MANIFEST).unwrap();
    manifest["models"][0]["many_relations"] = serde_json::json!([{
        "id": "employees_many",
        "label": "Employees",
        "target_model": "employee",
        "origin": "tenant",
        "management": "tenant_managed"
    }]);

    let compiled = compile_manifest_json(&serde_json::to_string(&manifest).unwrap()).unwrap();
    let relation = &compiled.schema.models[0].many_relations[0];
    assert_eq!(relation.id.as_str(), "employees_many");
    assert_eq!(relation.label, "Employees");
    assert_eq!(relation.target_model.as_str(), "employee");
    assert_eq!(relation.origin, SchemaElementOrigin::Tenant);
    assert_eq!(relation.management, SchemaManagementPolicy::TenantManaged);
    assert_eq!(relation.lifecycle, SchemaElementLifecycle::Active);
    assert_eq!(compiled.extras.many_relations.len(), 1);
    assert_eq!(compiled.extras.many_relations[0].owner_model, "company");
    assert_eq!(compiled.extras.many_relations[0].target_model, "employee");
    assert!(compiled.schema.models[0]
        .fields
        .iter()
        .all(|field| field.id.as_str() != "employees_many"));

    manifest["models"][0]["many_relations"][0]["target_model"] = serde_json::json!("missing");
    let error = compile_manifest_json(&serde_json::to_string(&manifest).unwrap()).unwrap_err();
    assert_eq!(error.code, "unknown_many_relation_target");
}

#[test]
fn many_relations_reject_tenant_origin_with_fixed_management() {
    let mut manifest: serde_json::Value = serde_json::from_str(FULL_MANIFEST).unwrap();
    manifest["models"][0]["many_relations"] = serde_json::json!([{
        "id": "employees_many",
        "label": "Employees",
        "target_model": "employee",
        "origin": "tenant",
        "management": "fixed"
    }]);

    let error = compile_manifest_json(&serde_json::to_string(&manifest).unwrap()).unwrap_err();
    assert_eq!(error.code, "tenant_definition_must_be_tenant_managed");
    assert_eq!(error.path, "models[0].many_relations[0].management");
}

#[test]
fn lookup_display_field_must_be_active_required_text() {
    let mut manifest: serde_json::Value = serde_json::from_str(FULL_MANIFEST).unwrap();
    manifest["models"][2]["fields"][1]["required"] = serde_json::json!(false);

    let error = compile_manifest_json(&serde_json::to_string(&manifest).unwrap()).unwrap_err();
    assert_eq!(error.code, "invalid_lookup_display_field");

    manifest["models"][2]["fields"][1]["required"] = serde_json::json!(true);
    manifest["models"][2]["fields"][1]["lifecycle"] = serde_json::json!("retired");
    let error = compile_manifest_json(&serde_json::to_string(&manifest).unwrap()).unwrap_err();
    assert_eq!(error.code, "invalid_lookup_display_field");
}

#[test]
fn lookup_display_field_defaults_during_lowering() {
    let mut manifest: serde_json::Value = serde_json::from_str(FULL_MANIFEST).unwrap();
    manifest["models"][2]
        .as_object_mut()
        .unwrap()
        .remove("display_field_id");

    let compiled = compile_manifest_json(&serde_json::to_string(&manifest).unwrap()).unwrap();
    assert_eq!(
        compiled.schema.models[2]
            .display_field_id
            .as_ref()
            .map(|field| field.as_str()),
        Some("name")
    );
}

#[test]
fn omitted_touches_expand_to_all_persisted_model_fields() {
    let manifest = FULL_MANIFEST.replace(", \"touches\": [\"name\"]", "");
    let compiled = compile_manifest_json(&manifest).unwrap();

    assert_eq!(
        compiled.schema.change_types[0]
            .touches
            .iter()
            .map(|field| field.as_str())
            .collect::<Vec<_>>(),
        vec!["company", "name"]
    );
}

#[test]
fn output_preserves_authored_model_and_field_order() {
    let mut reordered: serde_json::Value = serde_json::from_str(FULL_MANIFEST).unwrap();
    reordered["models"].as_array_mut().unwrap().reverse();
    for model in reordered["models"].as_array_mut().unwrap() {
        model["fields"].as_array_mut().unwrap().reverse();
    }

    let actual = compile_manifest_json(&serde_json::to_string(&reordered).unwrap()).unwrap();

    assert_eq!(
        actual
            .schema
            .models
            .iter()
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>(),
        vec!["region", "employee", "company"]
    );
    assert_eq!(
        actual.schema.models[0]
            .fields
            .iter()
            .map(|field| field.id.as_str())
            .collect::<Vec<_>>(),
        vec!["name", "known_aliases"]
    );
}

#[test]
fn rejects_inverse_relations_that_do_not_traverse_a_scalar_relation() {
    let invalid = FULL_MANIFEST.replace("\"through\": \"company\"", "\"through\": \"name\"");

    let error = compile_manifest_json(&invalid).unwrap_err();

    assert_eq!(error.code, "invalid_inverse_relation");
    assert!(error
        .to_string()
        .contains("scalar relation targeting `company`"));
}

#[test]
fn rejects_typed_expression_mismatches() {
    let invalid = FULL_MANIFEST.replace(
        "{\"type\": \"enum\", \"value\": \"active\"}",
        "{\"type\": \"bool\", \"value\": true}",
    );

    let error = compile_manifest_json(&invalid).unwrap_err();

    assert_eq!(error.code, "type_mismatch");
    assert!(error.to_string().contains("company_status"));
}

#[test]
fn rejects_unknown_manifest_properties() {
    let invalid = FULL_MANIFEST.replace(
        "\"notes\": \"Parent records\"",
        "\"notes\": \"Parent records\", \"formula\": \"raw sql\"",
    );

    let error = compile_manifest_json(&invalid).unwrap_err();

    assert_eq!(error.code, "invalid_manifest_json");
    assert!(error.to_string().contains("formula"));
}

#[test]
fn supported_manifest_fields_survive_the_compiler_boundary() {
    let mut input: serde_json::Value = serde_json::from_str(FULL_MANIFEST).unwrap();
    input["label"] = serde_json::json!("Compiler fixture");
    input["connectors"] = serde_json::json!({"provider": "fixture", "enabled": false});
    input["agents"] = serde_json::json!({"review": {"mode": "manual"}});
    input["models"][0]["fields"][0]["notes"] = serde_json::json!("Legal name");

    let artifact = compile_app_artifact_json(&input.to_string()).unwrap();
    let client = artifact.client.expect("app-owned client metadata");
    assert_eq!(client.label, "Compiler fixture");
    assert_eq!(client.connectors, input["connectors"]);
    assert_eq!(client.agents, input["agents"]);
    assert_eq!(artifact.schema.models[0].fields[0].id.as_str(), "name");
    assert!(artifact.schema.models[0].fields[0].required);
    assert!(artifact.schema.models[0].fields[0].is_unique);
    assert_eq!(
        artifact
            .extras
            .field_metadata
            .iter()
            .find(|field| field.model == "company" && field.field == "name")
            .unwrap()
            .notes
            .as_deref(),
        Some("Legal name")
    );
    assert_eq!(
        artifact.extras.model_metadata[0].field_groups[0].fields,
        vec!["name"]
    );
    assert_eq!(artifact.extras.constraints[0].id, "company_status");
    assert_eq!(artifact.extras.derived_fields[0].field.id, "display_name");
    assert_eq!(
        artifact.extras.seed_change_sets[0].writes[0]
            .values
            .as_ref()
            .unwrap()
            .get(&FieldId::from("name")),
        Some(&FieldValue::Text("North America".to_string()))
    );
}

#[test]
fn unsupported_properties_fail_at_each_manifest_level() {
    let base: serde_json::Value = serde_json::from_str(FULL_MANIFEST).unwrap();
    for pointer in [
        "",
        "/models/0",
        "/models/0/fields/0",
        "/models/0/field_groups/0",
        "/models/0/fields/1/option_set/0",
        "/change_types/0",
        "/constraints/0",
        "/seed_change_sets/0",
        "/seed_change_sets/0/writes/0",
    ] {
        let mut input = base.clone();
        input.pointer_mut(pointer).unwrap()["unsupported_contract_field"] = serde_json::json!(true);
        let error = compile_manifest_json(&input.to_string()).unwrap_err();
        assert_eq!(error.code, "invalid_manifest_json", "at {pointer}");
        assert!(
            error.to_string().contains("unsupported_contract_field"),
            "at {pointer}"
        );
    }
}

#[test]
fn rejects_unknown_typed_literal_properties() {
    let invalid = FULL_MANIFEST.replace(
        "{\"type\": \"enum\", \"value\": \"active\"}",
        "{\"type\": \"enum\", \"value\": \"active\", \"formula\": \"raw sql\"}",
    );

    let error = compile_manifest_json(&invalid).unwrap_err();

    assert_eq!(error.code, "invalid_manifest_json");
    assert!(error.to_string().contains("formula"));
}

#[test]
fn relation_errors_are_structured_before_expression_and_seed_validation() {
    let missing_target = FULL_MANIFEST.replace(", \"target_model\": \"company\"", "");
    let error = compile_manifest_json(&missing_target).unwrap_err();
    assert_eq!(error.code, "missing_relation_target");
    assert!(error.path.ends_with("employee.fields.company.target_model"));

    let unknown_target = FULL_MANIFEST.replace(
        "\"target_model\": \"company\"",
        "\"target_model\": \"missing_company\"",
    );
    let error = compile_manifest_json(&unknown_target).unwrap_err();
    assert_eq!(error.code, "unknown_relation_target");
    assert!(error.path.ends_with("employee.fields.company.target_model"));
}

#[test]
fn relation_targets_are_present_in_the_compiled_schema() {
    let compiled = compile_manifest_json(FULL_MANIFEST).unwrap();
    let employee = compiled
        .schema
        .models
        .iter()
        .find(|model| model.id == ModelId::from("employee"))
        .unwrap();

    assert_eq!(
        employee.fields[0].target_model.as_ref().unwrap().as_str(),
        "company"
    );
}

#[test]
fn rejects_inverse_ids_that_duplicate_persisted_fields() {
    let invalid = FULL_MANIFEST.replace(
        "\"id\": \"employees\", \"model\": \"employee\"",
        "\"id\": \"status\", \"model\": \"employee\"",
    );

    let error = compile_manifest_json(&invalid).unwrap_err();

    assert_eq!(error.code, "inverse_relation_id_collision");
}

#[test]
fn supports_entity_seeds_and_requires_complete_rows() {
    let mut entity_seed: serde_json::Value = serde_json::from_str(FULL_MANIFEST).unwrap();
    entity_seed["seed_change_sets"][0]["change_type"] = serde_json::json!("employee_create");
    let write = &mut entity_seed["seed_change_sets"][0]["writes"][0];
    write["model"] = serde_json::json!("employee");
    write["record_key"] = serde_json::json!({"type": "external_key", "value": "employee_1"});
    write["values"] = serde_json::json!({
        "company": {"type": "external_key", "model": "company", "value": "company_1"},
        "name": "Example Employee"
    });
    compile_manifest_json(&serde_json::to_string(&entity_seed).unwrap()).unwrap();

    entity_seed["seed_change_sets"][0]["writes"][0]["values"]
        .as_object_mut()
        .unwrap()
        .remove("name");
    assert_eq!(
        compile_manifest_json(&serde_json::to_string(&entity_seed).unwrap())
            .unwrap_err()
            .code,
        "missing_required_seed_value"
    );
}

#[test]
fn rejects_seed_templates_that_fail_kernel_apply_validation() {
    let mut manifest: serde_json::Value = serde_json::from_str(FULL_MANIFEST).unwrap();
    manifest["seed_change_sets"][0]["writes"][0]["model"] = serde_json::json!("employee");
    manifest["seed_change_sets"][0]["writes"][0]["values"] =
        serde_json::json!({"name": "Example Employee"});

    let error = compile_manifest_json(&serde_json::to_string(&manifest).unwrap()).unwrap_err();
    assert_eq!(error.code, "change_type_model_mismatch");
    assert!(error
        .path
        .contains("seed_region_north_america.writes[0].model_id"));

    manifest["seed_change_sets"][0]["change_type"] = serde_json::json!("employee_create");
    manifest["seed_change_sets"][0]["writes"][0]["record_key"] =
        serde_json::json!({"type": "external_key", "value": "   "});
    assert_eq!(
        compile_manifest_json(&serde_json::to_string(&manifest).unwrap())
            .unwrap_err()
            .code,
        "invalid_seed_external_key"
    );
}

#[test]
fn rejects_invalid_iso_and_money_rate_seed_values() {
    let mut manifest: serde_json::Value = serde_json::from_str(FULL_MANIFEST).unwrap();
    let region = &mut manifest["models"][2];
    region["fields"].as_array_mut().unwrap().extend([
        serde_json::json!({"id": "currency", "label": "Currency", "type": "iso_currency"}),
        serde_json::json!({"id": "budget", "label": "Budget", "type": "money_rate"}),
    ]);
    let values = manifest["seed_change_sets"][0]["writes"][0]["values"]
        .as_object_mut()
        .unwrap();
    values.insert("currency".to_string(), serde_json::json!("XXX"));
    values.insert(
        "budget".to_string(),
        serde_json::json!({"amount": "100", "currency": "USD", "period": "annual"}),
    );

    let error = compile_manifest_json(&serde_json::to_string(&manifest).unwrap()).unwrap_err();
    assert_eq!(error.code, "field_value_type_mismatch");
    assert!(error.path.ends_with("writes[0].values.currency"));

    manifest["seed_change_sets"][0]["writes"][0]["values"]["currency"] = serde_json::json!("USD");
    manifest["seed_change_sets"][0]["writes"][0]["values"]["budget"]["currency"] =
        serde_json::json!("XXX");
    let error = compile_manifest_json(&serde_json::to_string(&manifest).unwrap()).unwrap_err();
    assert_eq!(error.code, "field_value_type_mismatch");
    assert!(error.path.ends_with("writes[0].values.budget"));
}

#[test]
fn decimal_seed_values_require_precision_preserving_strings() {
    let mut manifest: serde_json::Value = serde_json::from_str(FULL_MANIFEST).unwrap();
    manifest["models"][2]["fields"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({"id": "weight", "label": "Weight", "type": "number"}));
    manifest["seed_change_sets"][0]["writes"][0]["values"]["weight"] =
        serde_json::json!("0.1234567890123456789012345678");

    let compiled = compile_manifest_json(&serde_json::to_string(&manifest).unwrap()).unwrap();
    let values = compiled.extras.seed_change_sets[0].writes[0]
        .values
        .as_ref()
        .unwrap();
    let weight = values
        .iter()
        .find(|(field, _)| field.as_str() == "weight")
        .map(|(_, value)| value)
        .unwrap();
    assert!(
        matches!(weight, FieldValue::Number(value) if value.to_string() == "0.1234567890123456789012345678")
    );

    manifest["seed_change_sets"][0]["writes"][0]["values"]["weight"] =
        serde_json::json!(0.12345678901234568);
    assert_eq!(
        compile_manifest_json(&serde_json::to_string(&manifest).unwrap())
            .unwrap_err()
            .code,
        "type_mismatch"
    );

    manifest["seed_change_sets"][0]["writes"][0]["values"]
        .as_object_mut()
        .unwrap()
        .remove("weight");
    manifest["models"][2]["fields"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({"id": "budget", "label": "Budget", "type": "money_rate"}));
    manifest["seed_change_sets"][0]["writes"][0]["values"]["budget"] =
        serde_json::json!({"amount": 100.25, "currency": "USD", "period": "annual"});
    assert_eq!(
        compile_manifest_json(&serde_json::to_string(&manifest).unwrap())
            .unwrap_err()
            .code,
        "type_mismatch"
    );
}

#[test]
fn iso_constraint_literals_require_canonical_membership() {
    let mut manifest: serde_json::Value = serde_json::from_str(FULL_MANIFEST).unwrap();
    manifest["models"][2]["fields"]
        .as_array_mut()
        .unwrap()
        .extend([
            serde_json::json!({"id": "country", "label": "Country", "type": "iso_country"}),
            serde_json::json!({"id": "currency", "label": "Currency", "type": "iso_currency"}),
        ]);
    manifest["constraints"]
        .as_array_mut()
        .unwrap()
        .extend([
            serde_json::json!({
                "id": "region_country",
                "label": "Region country",
                "model": "region",
                "expression": {"type": "compare_literal", "field": "country", "op": "eq", "value": {"type": "iso_country", "value": "US"}}
            }),
            serde_json::json!({
                "id": "region_currency",
                "label": "Region currency",
                "model": "region",
                "expression": {"type": "compare_literal", "field": "currency", "op": "eq", "value": {"type": "iso_currency", "value": "USD"}}
            }),
        ]);
    compile_manifest_json(&serde_json::to_string(&manifest).unwrap()).unwrap();

    manifest["constraints"][2]["expression"]["value"]["value"] = serde_json::json!("ZZ");
    assert_eq!(
        compile_manifest_json(&serde_json::to_string(&manifest).unwrap())
            .unwrap_err()
            .code,
        "type_mismatch"
    );
    manifest["constraints"][2]["expression"]["value"]["value"] = serde_json::json!("US");
    manifest["constraints"][3]["expression"]["value"]["value"] = serde_json::json!("XXX");
    assert_eq!(
        compile_manifest_json(&serde_json::to_string(&manifest).unwrap())
            .unwrap_err()
            .code,
        "type_mismatch"
    );
}

#[test]
fn derived_literals_require_valid_typed_values() {
    let mut manifest: serde_json::Value = serde_json::from_str(FULL_MANIFEST).unwrap();
    manifest["models"][2]["derived_fields"] = serde_json::json!([{
        "id": "review_date",
        "label": "Review date",
        "type": "date",
        "expression": {"type": "literal", "value": {"type": "date", "value": "2026-01-31"}}
    }]);
    compile_manifest_json(&serde_json::to_string(&manifest).unwrap()).unwrap();

    manifest["models"][2]["derived_fields"][0]["expression"]["value"]["value"] =
        serde_json::json!("2026-02-31");
    assert_eq!(
        compile_manifest_json(&serde_json::to_string(&manifest).unwrap())
            .unwrap_err()
            .code,
        "type_mismatch"
    );
}

fn derived_error(derived_fields: serde_json::Value) -> &'static str {
    let mut manifest: serde_json::Value = serde_json::from_str(FULL_MANIFEST).unwrap();
    manifest["models"][0]["derived_fields"] = derived_fields;
    compile_manifest_json(&serde_json::to_string(&manifest).unwrap())
        .unwrap_err()
        .code
}

#[test]
fn derived_fields_lower_to_read_only_derived_custom_field_definitions() {
    let mut manifest: serde_json::Value = serde_json::from_str(FULL_MANIFEST).unwrap();
    manifest["models"][0]["fields"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({"id": "base", "label": "Base", "type": "money_rate"}));
    manifest["models"][0]["derived_fields"] = serde_json::json!([
        {"id": "doubled", "label": "Doubled", "type": "money_rate", "expression": {"type": "multiply", "left": {"type": "field", "field": "base"}, "right": {"type": "literal", "value": {"type": "number", "value": "2"}}}},
        {"id": "doubled_monthly", "label": "Doubled monthly", "type": "money_rate", "expression": {"type": "normalize_money_rate", "expression": {"type": "field", "field": "doubled"}, "period": "monthly"}}
    ]);
    let compiled = compile_manifest_json(&serde_json::to_string(&manifest).unwrap()).unwrap();
    let derived = compiled
        .schema
        .custom_fields
        .iter()
        .find(|definition| definition.field_id.as_str() == "doubled_monthly")
        .expect("derived definition");
    assert_eq!(derived.id.as_str(), "derived_7_company_doubled_monthly");
    assert_eq!(derived.model_id.as_str(), "company");
    assert_eq!(derived.field_type, CustomFieldType::MoneyRate);
    assert_eq!(derived.origin, SchemaElementOrigin::App);
    assert_eq!(derived.management, SchemaManagementPolicy::Fixed);
    assert!(derived.expression.is_some());
}

#[test]
fn derived_fields_reject_runtime_unsupported_forms_cycles_and_types() {
    let field = |id: &str| serde_json::json!({"type": "field", "field": id});
    assert_eq!(
        derived_error(
            serde_json::json!([{"id": "count", "label": "Count", "type": "number", "expression": {"type": "inverse_aggregate", "inverse_relation": "employees", "aggregate": "count"}}])
        ),
        "unsupported_derived_expression"
    );
    assert_eq!(
        derived_error(serde_json::json!([
            {"id": "a", "label": "A", "type": "text", "expression": {"type": "concat", "expressions": [field("b")]}},
            {"id": "b", "label": "B", "type": "text", "expression": {"type": "concat", "expressions": [field("a")]}}
        ])),
        "derived_cycle"
    );
    assert_eq!(
        derived_error(
            serde_json::json!([{"id": "a", "label": "A", "type": "text", "expression": field("missing")}])
        ),
        "unknown_field"
    );
    assert_eq!(
        derived_error(
            serde_json::json!([{"id": "a", "label": "A", "type": "enum", "expression": field("status")}])
        ),
        "unsupported_derived_type"
    );
    assert_eq!(
        derived_error(
            serde_json::json!([{"id": "a", "label": "A", "type": "number", "expression": {"type": "add", "left": field("name"), "right": {"type": "literal", "value": {"type": "number", "value": "1"}}}}])
        ),
        "type_mismatch"
    );
    assert_eq!(
        derived_error(
            serde_json::json!([{"id": "a", "label": "A", "type": "number", "expression": {"type": "literal", "value": {"type": "number", "value": "1e3"}}}])
        ),
        "type_mismatch"
    );
    let mut deep =
        serde_json::json!({"type": "literal", "value": {"type": "number", "value": "1"}});
    for _ in 0..32 {
        deep = serde_json::json!({"type": "add", "left": deep, "right": {"type": "literal", "value": {"type": "number", "value": "1"}}});
    }
    assert_eq!(
        derived_error(
            serde_json::json!([{"id": "a", "label": "A", "type": "number", "expression": deep}])
        ),
        "derived_expression_too_large"
    );
}

#[test]
fn seed_metadata_is_non_empty_at_the_rust_manifest_boundary() {
    for property in ["id", "actor_id", "source_kind", "idempotency_key"] {
        for invalid_value in ["", "   "] {
            let mut manifest: serde_json::Value = serde_json::from_str(FULL_MANIFEST).unwrap();
            manifest["seed_change_sets"][0][property] = serde_json::json!(invalid_value);

            let error =
                compile_manifest_json(&serde_json::to_string(&manifest).unwrap()).unwrap_err();
            assert_eq!(error.code, "empty_seed_metadata", "property {property}");
            assert!(error.path.ends_with(property), "property {property}");
        }
    }
}

#[test]
fn validates_field_set_membership_types() {
    let constraint: serde_json::Value = serde_json::json!({
        "id": "region_alias",
        "label": "Region alias",
        "model": "region",
        "authority": "authoritative",
        "expression": {
            "type": "field_set_contains",
            "field": "known_aliases",
            "value": "NA"
        }
    });
    let mut manifest: serde_json::Value = serde_json::from_str(FULL_MANIFEST).unwrap();
    manifest["constraints"]
        .as_array_mut()
        .unwrap()
        .push(constraint);
    compile_manifest_json(&serde_json::to_string(&manifest).unwrap()).unwrap();

    manifest["constraints"].as_array_mut().unwrap()[2]["expression"]["field"] =
        serde_json::json!("name");
    assert_eq!(
        compile_manifest_json(&serde_json::to_string(&manifest).unwrap())
            .unwrap_err()
            .code,
        "type_mismatch"
    );
}

#[test]
fn text_prefix_requires_text_and_a_nonempty_literal() {
    let mut manifest: serde_json::Value = serde_json::from_str(FULL_MANIFEST).unwrap();
    manifest["constraints"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({
            "id": "region_code_prefix", "label": "Region code prefix", "model": "region",
            "expression": {"type": "text_starts_with", "field": "name", "value": "PO-%_"}
        }));
    compile_manifest_json(&manifest.to_string()).unwrap();

    manifest["constraints"][2]["expression"]["value"] = serde_json::json!("");
    assert_eq!(
        compile_manifest_json(&manifest.to_string())
            .unwrap_err()
            .code,
        "empty_text_prefix"
    );

    manifest["constraints"][2]["expression"]["value"] = serde_json::json!("PO-");
    manifest["constraints"][2]["expression"]["field"] = serde_json::json!("known_aliases");
    assert_eq!(
        compile_manifest_json(&manifest.to_string())
            .unwrap_err()
            .code,
        "type_mismatch"
    );

    manifest["constraints"][2]["expression"]["field"] = serde_json::json!("name");
    manifest["constraints"][2]["expression"]["sql"] = serde_json::json!("true");
    assert_eq!(
        compile_manifest_json(&manifest.to_string())
            .unwrap_err()
            .code,
        "invalid_manifest_json"
    );
}

#[test]
fn rejects_non_lowerable_constraint_values_and_cardinality() {
    let unknown_enum = FULL_MANIFEST.replace(
        "{\"type\": \"enum\", \"value\": \"active\"}",
        "{\"type\": \"enum\", \"value\": \"missing\"}",
    );
    assert_eq!(
        compile_manifest_json(&unknown_enum).unwrap_err().code,
        "type_mismatch"
    );

    let mut manifest: serde_json::Value = serde_json::from_str(FULL_MANIFEST).unwrap();
    manifest["constraints"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({
            "id": "invalid_count",
            "label": "Invalid count",
            "model": "employee",
            "expression": {"type": "count_present", "fields": ["name"]}
        }));
    assert_eq!(
        compile_manifest_json(&serde_json::to_string(&manifest).unwrap())
            .unwrap_err()
            .code,
        "missing_count_bound"
    );
}

#[test]
fn relation_seeds_require_typed_resolvable_addresses() {
    let mut manifest: serde_json::Value = serde_json::from_str(FULL_MANIFEST).unwrap();
    manifest["models"][2]["fields"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({
            "id": "parent",
            "label": "Parent",
            "type": "relation",
            "target_model": "region"
        }));
    let child_write = &mut manifest["seed_change_sets"][0]["writes"][0];
    child_write["record_key"] =
        serde_json::json!({"type": "external_key", "value": "child_region"});
    child_write["values"]["parent"] = serde_json::json!("north_america");
    assert_eq!(
        compile_manifest_json(&serde_json::to_string(&manifest).unwrap())
            .unwrap_err()
            .code,
        "invalid_seed_relation_reference"
    );

    manifest["seed_change_sets"][0]["writes"][0]["values"]["parent"] = serde_json::json!({
        "type": "within_batch",
        "model": "region",
        "external_key": "north_america"
    });
    manifest["seed_change_sets"][0]["writes"]
        .as_array_mut()
        .unwrap()
        .insert(
            0,
            serde_json::json!({
                "model": "region",
                "record_key": {"type": "external_key", "value": "north_america"},
                "values": {"name": "North America"}
            }),
        );
    let compiled = compile_manifest_json(&serde_json::to_string(&manifest).unwrap()).unwrap();
    let writes = &compiled.extras.seed_change_sets[0].writes;
    assert_eq!(writes.len(), 2);
    assert!(matches!(
        writes[0].record_key,
        Some(RecordKey::ExternalKey(ref key)) if key.as_str() == "north_america"
    ));
    assert!(matches!(
        writes[1].record_key,
        Some(RecordKey::ExternalKey(ref key)) if key.as_str() == "child_region"
    ));
}

#[test]
fn invalid_change_type_models_return_structured_errors() {
    let invalid = FULL_MANIFEST.replace(
        "\"model\": \"employee\", \"touches\": [\"name\"]",
        "\"model\": \"missing\"",
    );

    let error = compile_manifest_json(&invalid).unwrap_err();

    assert_eq!(error.code, "unknown_change_type_model");
}

#[test]
fn enum_and_iso_constraints_require_typed_valid_literals() {
    let text_enum = FULL_MANIFEST.replace(
        "{\"type\": \"enum\", \"value\": \"active\"}",
        "{\"type\": \"text\", \"value\": \"active\"}",
    );
    assert_eq!(
        compile_manifest_json(&text_enum).unwrap_err().code,
        "type_mismatch"
    );
}

#[test]
fn derived_definition_ids_are_unambiguous_across_models() {
    let model = |id: &str, derived: &str| {
        serde_json::json!({
            "id": id, "kind": "entity", "label": id,
            "fields": [{"id": "name", "label": "Name", "type": "text", "required": true}],
            "derived_fields": [{"id": derived, "label": derived, "type": "text",
                "expression": {"type": "field", "field": "name"}}]
        })
    };
    let manifest = serde_json::json!({
        "app_id": "derived_ids", "customer_id": "base", "version": "v1",
        "models": [model("a_b", "c"), model("a", "b_c")]
    });
    let compiled = compile_manifest_json(&manifest.to_string()).unwrap();
    let ids: Vec<_> = compiled
        .schema
        .custom_fields
        .iter()
        .map(|definition| definition.id.as_str())
        .collect();
    assert_eq!(ids, vec!["derived_3_a_b_c", "derived_1_a_b_c"]);
}
