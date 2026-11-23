use kernel::{
    validate_schema, ActiveSchemaRevision, AppliedChangeSet, CustomFieldEntry, CustomFieldValue,
    DraftRecord, DraftSummary, FieldValue, InstallerPrincipalScopeBindingRequest,
    InstallerPrincipalScopeBindingResult, LookupSetAvailabilityRequest,
    LookupSetAvailabilityResult, Schema, SchemaRevisionId, StoredAgentRun, TenantSchemaOperation,
    VisibleRecord,
};
use serde::de::DeserializeOwned;
use serde_json::Value;

const FIXTURES: &str = include_str!("../../contracts/__fixtures__/wire-roundtrip.json");

fn fixture(name: &str) -> Value {
    serde_json::from_str::<Value>(FIXTURES).unwrap()[name].clone()
}

fn assert_round_trip<T>(value: Value)
where
    T: DeserializeOwned + serde::Serialize + PartialEq + std::fmt::Debug,
{
    let parsed: T = serde_json::from_value(value.clone()).unwrap();
    let reparsed: T = serde_json::from_value(serde_json::to_value(&parsed).unwrap()).unwrap();
    assert_eq!(reparsed, parsed);
    assert_eq!(serde_json::to_value(parsed).unwrap(), value);
}

#[test]
fn shared_wire_fixtures_round_trip_through_rust_contracts() {
    assert_round_trip::<Schema>(fixture("schema"));
    let minimal_schema: Schema = serde_json::from_value(fixture("minimal_schema")).unwrap();
    assert!(minimal_schema.custom_fields.is_empty());
    assert!(minimal_schema.change_types.is_empty());
    assert_round_trip::<Schema>(fixture("minimal_schema_serialized"));
    assert_round_trip::<CustomFieldEntry>(fixture("custom_field_entry_enum"));

    let schema: Schema = serde_json::from_value(fixture("schema")).unwrap();
    validate_schema(&schema).unwrap();

    let field_values = fixture("field_values");
    for value in field_values.as_object().unwrap().values() {
        assert_round_trip::<FieldValue>(value.clone());
    }

    let custom_field_values = fixture("custom_field_values");
    for value in custom_field_values.as_object().unwrap().values() {
        assert_round_trip::<CustomFieldValue>(value.clone());
    }
}

#[test]
fn generated_sql_result_dtos_are_bidirectional_wire_types() {
    fn assert_bidirectional<T: serde::Serialize + DeserializeOwned>() {}

    assert_bidirectional::<AppliedChangeSet>();
    assert_bidirectional::<StoredAgentRun>();
    assert_bidirectional::<ActiveSchemaRevision>();
    assert_bidirectional::<VisibleRecord>();
    assert_bidirectional::<DraftSummary>();
    assert_bidirectional::<DraftRecord>();
    assert_bidirectional::<LookupSetAvailabilityResult>();
}

#[test]
fn schema_revision_ids_use_lossless_decimal_strings_on_the_public_wire() {
    let revision = SchemaRevisionId::new(9_007_199_254_740_993);
    assert_eq!(serde_json::to_value(revision).unwrap(), "9007199254740993");

    let parsed: SchemaRevisionId =
        serde_json::from_value(serde_json::json!("9007199254740993")).unwrap();
    assert_eq!(parsed, revision);

    // Generated SQL currently returns numeric JSON values internally. Accepting
    // those values lets Rust bridge the SQL result while HTTP serialization stays
    // lossless for JavaScript clients.
    let legacy_numeric: SchemaRevisionId = serde_json::from_value(serde_json::json!(42)).unwrap();
    assert_eq!(legacy_numeric, SchemaRevisionId::new(42));
}

#[test]
fn schema_extension_requests_round_trip_and_reject_server_owned_fields() {
    let create_model = serde_json::json!({
        "type": "create_model",
        "model": {
            "kind": "lookup",
            "label": "Department",
            "display_field_id": "name",
            "fields": [{
                "id": "name",
                "label": "Name",
                "type": "text",
                "required": true,
                "is_unique": true,
                "target_model": null,
                "option_set": [],
                "origin": "tenant",
                "management": "tenant_managed",
                "lifecycle": "active"
            }],
            "many_relations": []
        }
    });
    assert_round_trip::<TenantSchemaOperation>(create_model.clone());

    let mut caller_identified = create_model;
    caller_identified["model"]["id"] = serde_json::json!("caller-selected-id");
    let error = serde_json::from_value::<TenantSchemaOperation>(caller_identified).unwrap_err();
    assert!(error.to_string().contains("unknown field `id`"));

    let availability_request = serde_json::json!({
        "app_id": "core_app",
        "customer_id": "customer_a",
        "model_id": "department",
        "record_id": "019fd4ce-97c6-7652-905d-f689dc7d78ac",
        "availability": "retired",
        "effective_start": "2026-08-05",
        "schema_revision_id": "42",
        "actor_id": "schema-admin",
        "source_kind": "lookup_admin",
        "source_ref": "lookup-editor",
        "idempotency_key": "retire-department-1",
        "reason": "No longer selectable"
    });
    assert_round_trip::<LookupSetAvailabilityRequest>(availability_request.clone());

    let mut malformed_request = availability_request;
    malformed_request["unexpected"] = serde_json::json!(true);
    let error =
        serde_json::from_value::<LookupSetAvailabilityRequest>(malformed_request).unwrap_err();
    assert!(error.to_string().contains("unknown field `unexpected`"));

    assert_round_trip::<LookupSetAvailabilityResult>(serde_json::json!({
        "id": 71,
        "schema_revision_id": "42"
    }));
}

#[test]
fn installer_principal_scope_bindings_are_strict_global_wire_contracts() {
    let runtime_binding = serde_json::json!({
        "capability": "runtime",
        "principal_name": "app_runtime",
        "app_id": "core_app",
        "customer_id": "customer_a",
        "actor_id": null,
        "active": true
    });
    assert_round_trip::<InstallerPrincipalScopeBindingRequest>(runtime_binding.clone());

    let schema_admin_binding = serde_json::json!({
        "capability": "schema_admin",
        "principal_name": "tenant_schema_admin",
        "app_id": "core_app",
        "customer_id": "customer_a",
        "actor_id": "admin-user",
        "active": false
    });
    assert_round_trip::<InstallerPrincipalScopeBindingRequest>(schema_admin_binding);

    let mut unknown_field = runtime_binding;
    unknown_field["role"] = serde_json::json!("not-a-capability");
    let error =
        serde_json::from_value::<InstallerPrincipalScopeBindingRequest>(unknown_field).unwrap_err();
    assert!(error.to_string().contains("unknown field `role`"));

    let missing_admin_actor = serde_json::json!({
        "capability": "schema_admin",
        "principal_name": "tenant_schema_admin",
        "app_id": "core_app",
        "customer_id": "customer_a"
    });
    let error =
        serde_json::from_value::<InstallerPrincipalScopeBindingRequest>(missing_admin_actor)
            .unwrap_err();
    assert!(error.to_string().contains("missing field `actor_id`"));

    let null_active = serde_json::json!({
        "capability": "runtime",
        "principal_name": "app_runtime",
        "app_id": "core_app",
        "customer_id": "customer_a",
        "active": null
    });
    assert!(serde_json::from_value::<InstallerPrincipalScopeBindingRequest>(null_active).is_err());

    assert_round_trip::<InstallerPrincipalScopeBindingResult>(serde_json::json!({
        "principal_name": "tenant_schema_admin",
        "capability": "schema_admin",
        "app_id": "core_app",
        "customer_id": "customer_a",
        "actor_id": "admin-user",
        "active": true
    }));
}
