use std::collections::{BTreeMap, BTreeSet};
use std::env;

use chrono::NaiveDate;
use kernel::testing::{
    call_generated_sql, decode_generated_sql_result, DbError, GeneratedSqlFunction,
};
use kernel::{
    connect_postgres, schema_hash, validate_schema, ActiveSchemaRevision, App, AppId,
    ApplyChangeSet, ApplyMode, ChangeType, ChangeTypeId, CustomFieldEntry, CustomFieldValue,
    CustomerId, ErrorDetail, ErrorEnvelope, ExternalKey, Field, FieldId, FieldType, FieldValue,
    KernelError, Model, ModelId, ModelKind, MoneyRatePeriod, MoneyRateValue, RecordKey,
    RowVersionWrite, Schema, SchemaVersion,
};
use postgres::Client;
use rust_decimal::Decimal;
use schema_compiler::{
    compile_sql_artifact_manifest, render_sql_artifact_bundle, CompiledManifest,
    NormalizedManifestExtras,
};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};
use uuid::Uuid;

mod support;

struct GeneratedSchemaFixture<'a> {
    client: &'a mut Client,
    schema_name: String,
}

impl Drop for GeneratedSchemaFixture<'_> {
    fn drop(&mut self) {
        support::drop_generated_sql_fixture(self.client, &self.schema_name);
    }
}

fn valid_schema() -> Schema {
    Schema {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from("customer_a"),
        version: SchemaVersion::from("2026-08-04"),
        models: vec![Model {
            id: ModelId::from("record"),
            kind: ModelKind::Entity,
            label: "Record".to_string(),
            fields: vec![
                Field {
                    id: FieldId::from("display_name"),
                    label: "Display Name".to_string(),
                    field_type: FieldType::Text,
                    required: true,
                    is_unique: false,
                    target_model: None,
                    option_set: vec![],
                    ..Default::default()
                },
                Field {
                    id: FieldId::from("parent_record"),
                    label: "Parent Record".to_string(),
                    field_type: FieldType::Relation,
                    required: false,
                    is_unique: false,
                    target_model: Some(ModelId::from("record")),
                    option_set: vec![],
                    ..Default::default()
                },
            ],
            ..Default::default()
        }],
        custom_fields: vec![],
        change_types: vec![ChangeType {
            id: ChangeTypeId::from("record_update"),
            label: "Record Update".to_string(),
            target_model: ModelId::from("record"),
            is_import_default: false,
            touches: vec![
                FieldId::from("display_name"),
                FieldId::from("parent_record"),
            ],
            required: vec![FieldId::from("display_name")],
        }],
    }
}

fn representative_apply() -> ApplyChangeSet {
    ApplyChangeSet {
        app_id: AppId::from("ops.revenue/v1"),
        customer_id: CustomerId::from("018f6bf3-1ea5-7812-9a5a-a1f5b04f0001"),
        schema_revision_id: None,
        actor_id: Some("user_1".to_string()),
        source_kind: "user_edit".to_string(),
        source_ref: Some("dev://round-trip".to_string()),
        idempotency_key: Some("request_1".to_string()),
        change_type_id: None,
        notes: Some("round-trip fixture".to_string()),
        mode: ApplyMode::Mainline,
        writes: vec![RowVersionWrite {
            model_id: ModelId::from("record"),
            new_record_id: None,
            record_key: Some(RecordKey::ExternalKey(ExternalKey::from("record-1"))),
            effective_start: NaiveDate::from_ymd_opt(2026, 5, 4).unwrap(),
            values: Some(BTreeMap::from([
                (
                    FieldId::from("display_name"),
                    FieldValue::Text("Example Record".to_string()),
                ),
                (
                    FieldId::from("rate"),
                    FieldValue::MoneyRate(MoneyRateValue {
                        amount: Decimal::new(125000, 2),
                        currency: "USD".to_string(),
                        period: MoneyRatePeriod::Annual,
                    }),
                ),
            ])),
            custom_fields: None,
            tombstones_record: false,
            provenance: Some(json!({"source": "test"})),
            ..Default::default()
        }],
    }
}

fn with_generated_schema_api(schema_contract: Schema, test: impl FnOnce(&mut Client)) {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let compiled = CompiledManifest {
        schema: schema_contract.clone(),
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
    };
    let manifest = compile_sql_artifact_manifest(&compiled).expect("compile generated SQL bundle");
    let mut client = connect_postgres(&database_url).expect("connect to test PostgreSQL");
    let schema = format!("kernel_contract_parity_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            "create schema \"{schema}\"; set search_path to \"{schema}\""
        ))
        .expect("create isolated generated SQL schema");
    support::trusted_human::before_install(&mut client);
    client
        .batch_execute(&render_sql_artifact_bundle(&manifest))
        .expect("install compiler-emitted SQL bundle");
    let schema_json = serde_json::to_value(&schema_contract).expect("serialize schema");
    let schema_hash = schema_hash(&schema_contract);
    client
        .execute(
            r#"
            insert into schema_revision (
              app_id, customer_id, version, base_schema, customer_overlay, schema,
              schema_hash, materialization_source, materialized_at, activated_at
            ) values ($1, $2, $3, $4, '{}'::jsonb, $4, $5, 'test', now(), now())
            "#,
            &[
                &schema_contract.app_id.as_str(),
                &schema_contract.customer_id.as_str(),
                &schema_contract.version.as_str(),
                &schema_json,
                &schema_hash,
            ],
        )
        .expect("seed active schema revision");

    let fixture = GeneratedSchemaFixture {
        client: &mut client,
        schema_name: schema,
    };
    test(&mut *fixture.client);
}

fn test_database_url() -> Option<String> {
    match env::var("KERNEL_TEST_DATABASE_URL") {
        Ok(url) => Some(url),
        Err(env::VarError::NotPresent) => {
            eprintln!(
                "skipping generated SQL contract parity test: KERNEL_TEST_DATABASE_URL is absent"
            );
            None
        }
        Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
    }
}

struct SerdeOnly;

fn with_serde_only(test: impl FnOnce(&mut SerdeOnly)) {
    test(&mut SerdeOnly);
}

fn transport_round_trip<T>(_transport: &mut SerdeOnly, value: &T) -> T
where
    T: Serialize + DeserializeOwned,
{
    serde_json::from_value(serde_json::to_value(value).expect("serialize DTO"))
        .expect("deserialize DTO")
}

fn transport_json(_transport: &mut SerdeOnly, value: &(impl Serialize + ?Sized)) -> Value {
    serde_json::to_value(value).expect("serialize DTO")
}

fn transport_error(_transport: &mut SerdeOnly, envelope: &ErrorEnvelope) -> ErrorEnvelope {
    decode_generated_sql_result::<Value>(json!({"ok": false, "error": envelope}))
        .expect_err("generated SQL client error envelope must decode as KernelError")
        .into_envelope()
}

fn assert_serialization_failure(error: KernelError) {
    assert_eq!(
        error.into_envelope(),
        ErrorEnvelope {
            code: "serialization_error".to_string(),
            message: "Kernel serialization failed".to_string(),
            details: vec![],
        }
    );
}

#[test]
fn active_schema_api_fails_closed_when_stored_schema_omits_model_kind() {
    let schema = valid_schema();
    with_generated_schema_api(schema.clone(), |client| {
        let mut schema_json = serde_json::to_value(&schema).unwrap();
        schema_json["models"][0]
            .as_object_mut()
            .expect("model serializes as an object")
            .remove("kind");
        client
            .execute(
                "update schema_revision set schema = $1 where activated_at is not null",
                &[&schema_json],
            )
            .expect("corrupt stored schema fixture");

        let error = call_generated_sql::<ActiveSchemaRevision>(
            client,
            GeneratedSqlFunction::ReadActiveSchemaRevision,
            &json!({"app_id": "core_app", "customer_id": "customer_a"}),
        )
        .unwrap_err();
        assert_serialization_failure(error);
    });
}

#[test]
fn active_schema_api_preserves_optional_import_default_metadata() {
    let schema = valid_schema();
    with_generated_schema_api(schema.clone(), |client| {
        let defaulted: ActiveSchemaRevision = call_generated_sql(
            client,
            GeneratedSqlFunction::ReadActiveSchemaRevision,
            &json!({
                "app_id": "core_app",
                "customer_id": "customer_a"
            }),
        )
        .unwrap();
        assert!(!defaulted.schema.change_types[0].is_import_default);
        assert!(serde_json::to_value(&defaulted.schema.change_types[0])
            .unwrap()
            .get("is_import_default")
            .is_none());
    });

    let mut selected_schema = schema;
    selected_schema.change_types[0].is_import_default = true;
    with_generated_schema_api(selected_schema, |client| {
        let selected: ActiveSchemaRevision = call_generated_sql(
            client,
            GeneratedSqlFunction::ReadActiveSchemaRevision,
            &json!({"app_id": "core_app", "customer_id": "customer_a"}),
        )
        .unwrap();
        assert!(selected.schema.change_types[0].is_import_default);
    });
}

#[test]
fn app_contract_round_trip_is_serde_only() {
    with_serde_only(|client| {
        let schema = valid_schema();
        let app = App {
            id: schema.app_id.clone(),
            label: "Core App".to_string(),
            schema,
            connectors: json!({"csv": {"enabled": true}}),
            agents: json!({"reviewer": {"enabled": true}}),
        };

        let transported = transport_round_trip(client, &app);
        assert_eq!(transported.id.as_str(), "core_app");
        assert_eq!(transported.connectors["csv"]["enabled"], true);
        assert_eq!(transported.agents["reviewer"]["enabled"], true);
        assert_eq!(transported, app);
    });
}

#[test]
fn custom_field_entry_shape_is_serde_only() {
    with_serde_only(|client| {
        let entry = CustomFieldEntry {
            field_id: FieldId::from("bonus"),
            value: CustomFieldValue::MoneyRate(MoneyRateValue {
                amount: Decimal::new(125000, 2),
                currency: "USD".to_string(),
                period: MoneyRatePeriod::Annual,
            }),
        };

        let transported = transport_json(client, &entry);
        assert_eq!(transported["field_id"], "bonus");
        assert_eq!(transported["type"], "money_rate");
        assert_eq!(transported["value"]["amount"], "1250.00");
        assert_eq!(transported["value"]["period"], "annual");
        assert_eq!(transport_round_trip(client, &entry), entry);
    });
}

#[test]
fn validation_error_envelope_is_rust_validation_and_client_decoder_only() {
    with_serde_only(|client| {
        let mut schema = valid_schema();
        schema.models[0].id = ModelId::from("123_bad");
        let source = KernelError::from(validate_schema(&schema).unwrap_err()).into_envelope();
        let expected = ErrorEnvelope {
            code: "contract_validation_failed".to_string(),
            message: "Contract validation failed".to_string(),
            details: vec![
                ErrorDetail {
                    path: "models[0].id".to_string(),
                    code: "identifier_must_start_with_letter".to_string(),
                    message: "identifier must start with an ASCII letter".to_string(),
                },
                ErrorDetail {
                    path: "models[0].fields[1].target_model".to_string(),
                    code: "unknown_relation_target".to_string(),
                    message: "relation target `record` is not a declared model".to_string(),
                },
                ErrorDetail {
                    path: "change_types[0].target_model".to_string(),
                    code: "unknown_change_type_target".to_string(),
                    message: "change type target_model `record` is not a declared model"
                        .to_string(),
                },
            ],
        };

        assert_eq!(source, expected);
        assert_eq!(transport_error(client, &expected), expected);
    });
}

#[test]
fn idempotency_db_error_envelope_is_rust_mapping_and_client_decoder_only() {
    with_serde_only(|client| {
        let source = KernelError::from(DbError::IdempotencyConflict {
            key: "request-1".to_string(),
        })
        .into_envelope();
        let expected = ErrorEnvelope {
            code: "idempotency_conflict".to_string(),
            message: "Idempotency key was reused for a different request".to_string(),
            details: vec![ErrorDetail {
                path: "idempotency_key".to_string(),
                code: "idempotency_conflict".to_string(),
                message: "Key `request-1` was reused; use a new idempotency key or replay the exact equivalent request".to_string(),
            }],
        };

        assert_eq!(source, expected);
        assert_eq!(transport_error(client, &expected), expected);
    });
}

#[test]
fn unique_field_db_error_envelope_is_rust_mapping_and_client_decoder_only() {
    with_serde_only(|client| {
        let source = KernelError::from(DbError::UniqueFieldConflict {
            model: "employee".to_string(),
            field: "ref".to_string(),
            value: "EMP-1".to_string(),
        })
        .into_envelope();
        let expected = ErrorEnvelope {
            code: "unique_field_conflict".to_string(),
            message: "Unique field value already exists".to_string(),
            details: vec![
                ErrorDetail {
                    path: "model".to_string(),
                    code: "unique_field_conflict".to_string(),
                    message: "employee".to_string(),
                },
                ErrorDetail {
                    path: "field".to_string(),
                    code: "unique_field_conflict".to_string(),
                    message: "ref".to_string(),
                },
                ErrorDetail {
                    path: "value".to_string(),
                    code: "unique_field_conflict".to_string(),
                    message: "EMP-1".to_string(),
                },
            ],
        };

        assert_eq!(source, expected);
        assert_eq!(transport_error(client, &expected), expected);
    });
}

#[test]
fn serialization_db_error_envelope_is_rust_mapping_and_client_decoder_only() {
    with_serde_only(|client| {
        let source = serde_json::from_str::<Value>("{").unwrap_err();
        let source = KernelError::from(DbError::Serde(source)).into_envelope();
        let expected = ErrorEnvelope {
            code: "serialization_error".to_string(),
            message: "Kernel serialization failed".to_string(),
            details: vec![],
        };

        assert_eq!(source, expected);
        assert_eq!(transport_error(client, &expected), expected);
    });
}

#[test]
fn schema_drift_db_error_envelope_is_rust_mapping_and_client_decoder_only() {
    with_serde_only(|client| {
        let source = KernelError::from(DbError::SchemaDrift {
            object: "change_set.status".to_string(),
            details: "expected mainline/draft/discarded".to_string(),
        })
        .into_envelope();
        let expected = ErrorEnvelope {
            code: "schema_drift".to_string(),
            message: "Schema drift detected".to_string(),
            details: vec![ErrorDetail {
                path: "object".to_string(),
                code: "schema_drift".to_string(),
                message: "change_set.status: expected mainline/draft/discarded".to_string(),
            }],
        };

        assert_eq!(source, expected);
        assert_eq!(transport_error(client, &expected), expected);
    });
}

#[test]
fn bare_db_error_envelope_is_rust_mapping_and_client_decoder_only() {
    with_serde_only(|client| {
        let source = KernelError::from(DbError::RevertConflict {
            details: "target is not the current tip".to_string(),
        })
        .into_envelope();
        let expected = ErrorEnvelope {
            code: "revert_conflict".to_string(),
            message: "target is not the current tip".to_string(),
            details: vec![],
        };

        assert_eq!(source, expected);
        assert_eq!(transport_error(client, &expected), expected);
    });
}

#[test]
fn active_schema_api_returns_contract_ids_as_plain_strings() {
    with_generated_schema_api(valid_schema(), |client| {
        let active: ActiveSchemaRevision = call_generated_sql(
            client,
            GeneratedSqlFunction::ReadActiveSchemaRevision,
            &json!({"app_id": "core_app", "customer_id": "customer_a"}),
        )
        .unwrap();
        let transported = serde_json::to_value(active.schema).unwrap();
        assert_eq!(transported["app_id"], "core_app");
        assert_eq!(transported["customer_id"], "customer_a");
        assert_eq!(transported["models"][0]["id"], "record");
        assert_eq!(transported["models"][0]["fields"][0]["id"], "display_name");
    });
}

#[test]
fn record_id_shape_is_serde_only() {
    with_serde_only(|client| {
        let record_id = Uuid::parse_str("018f6bf3-1ea5-7812-9a5a-a1f5b04f0001").unwrap();
        let transported = transport_json(client, &RecordKey::RecordId(record_id));

        assert_eq!(transported["type"], "record_id");
        assert_eq!(transported["value"], record_id.to_string());
    });
}

#[test]
fn apply_contract_round_trip_is_serde_only() {
    with_serde_only(|client| {
        let apply = representative_apply();
        let transported = transport_json(client, &apply);
        assert_eq!(
            transported["writes"][0]["record_key"]["type"],
            "external_key"
        );
        assert_eq!(
            transported["writes"][0]["values"]["rate"]["value"]["amount"],
            "1250.00"
        );
        assert_eq!(
            transported["writes"][0]["values"]["rate"]["value"]["period"],
            "annual"
        );
        assert_eq!(transport_round_trip(client, &apply), apply);

        let anonymous_write = RowVersionWrite {
            model_id: ModelId::from("record"),
            record_key: None,
            new_record_id: None,
            effective_start: NaiveDate::from_ymd_opt(2026, 5, 4).unwrap(),
            values: None,
            custom_fields: None,
            tombstones_record: false,
            provenance: None,
            ..Default::default()
        };
        let transported = transport_json(client, &anonymous_write);
        assert_eq!(transported["record_key"], Value::Null);
        assert!(transported.get("new_record_id").is_none());

        let transported = transport_json(client, &FieldValue::Number(Decimal::new(125, 1)));
        assert_eq!(transported["value"], "12.5");
        let error = serde_json::from_value::<FieldValue>(json!({"type": "number", "value": 12.5}))
            .unwrap_err();
        assert!(error.to_string().contains("floating point"));
    });
}

#[test]
fn removed_apply_reason_field_is_serde_only() {
    with_serde_only(|_client| {
        let malformed = json!({
            "app_id": "core_app",
            "customer_id": "customer_a",
            "source_kind": "user_edit",
            "reason": "removed field",
            "mode": "mainline",
            "writes": [{
                "model_id": "record",
                "record_key": {"type": "external_key", "value": "record-1"},
                "effective_start": "2026-05-04",
                "values": {
                    "display_name": {"type": "text", "value": "Example Record"}
                }
            }]
        });

        let error = serde_json::from_value::<ApplyChangeSet>(malformed).unwrap_err();
        assert!(error.to_string().contains("unknown field `reason`"));
    });
}

struct ContractGap {
    source_test: &'static str,
    required_sql_proof: &'static str,
}

// These contracts are exercised through compiler-emitted PostgreSQL functions.
// They prove the production endpoint's wire compatibility, not SQL-side schema
// validation or mutation behavior, and must not be credited as behavioral parity.
const GENERATED_API_CONTRACTS: &[&str] = &[
    "schema_deserialization_requires_model_kind",
    "change_type_import_default_is_optional_metadata",
    "contract_ids_serialize_as_plain_json_strings",
];

// These checks prove only Rust serde, Rust error mapping, or the generated-SQL
// client envelope decoder. They are deliberately not credited as SQL runtime parity.
const SERDE_OR_DECODER_ONLY_CONTRACTS: &[&str] = &[
    "app_contract_round_trips_through_json",
    "custom_field_entries_serialize_as_field_type_value_objects",
    "error_envelope_preserves_machine_readable_validation_details",
    "db_error_envelope_uses_stable_machine_readable_codes",
    "unique_field_conflict_envelope_carries_generic_structured_details",
    "db_error_envelope_strips_internal_error_details",
    "db_error_envelope_preserves_schema_drift_detail_shape",
    "db_error_envelope_preserves_bare_details_shape",
    "record_ids_serialize_as_uuids_not_freeform_strings",
    "apply_contract_round_trips_through_json",
    "apply_contract_rejects_removed_reason_field",
];

// These contracts require generated compiler/runtime behavior, not only JSON transport.
// Keeping them explicit prevents transport round trips from being counted as behavioral parity.
const CONTRACT_GAPS: &[ContractGap] = &[
    ContractGap {
        source_test: "validates_a_minimal_schema_contract",
        required_sql_proof: "generated installer accepts the schema and validates its live catalog",
    },
    ContractGap {
        source_test: "validates_at_most_one_import_default_per_target_model",
        required_sql_proof: "compiler rejects duplicate import defaults before installation",
    },
    ContractGap {
        source_test: "rejects_duplicate_change_type_fields",
        required_sql_proof: "compiler rejects duplicate change-type fields",
    },
    ContractGap {
        source_test: "validates_unique_metadata_only_on_single_column_scalar_fields",
        required_sql_proof: "compiler and installer validate unique-field support",
    },
    ContractGap {
        source_test: "rejects_option_set_on_relation_fields",
        required_sql_proof: "compiler rejects relation option sets",
    },
    ContractGap {
        source_test: "rejects_option_set_on_scalar_fields",
        required_sql_proof: "compiler rejects option sets on non-enum scalar fields",
    },
    ContractGap {
        source_test: "rejects_empty_declared_enum_option_set",
        required_sql_proof: "compiler rejects empty enum option sets",
    },
    ContractGap {
        source_test: "rejects_normalized_declared_enum_option_id_collisions",
        required_sql_proof: "compiler rejects normalized declared enum collisions",
    },
    ContractGap {
        source_test: "rejects_invalid_declared_enum_option_ids_before_deduping",
        required_sql_proof: "compiler preserves validation ordering for invalid enum IDs",
    },
    ContractGap {
        source_test: "rejects_normalized_custom_enum_option_id_collisions",
        required_sql_proof: "compiler rejects normalized custom enum collisions",
    },
    ContractGap {
        source_test: "accepts_opaque_scope_ids_without_identifier_normalization",
        required_sql_proof: "installer and runtime preserve opaque scope IDs",
    },
    ContractGap {
        source_test: "rejects_empty_opaque_scope_ids",
        required_sql_proof: "compiler rejects empty scope IDs with exact details",
    },
    ContractGap {
        source_test: "validates_top_level_app_contract",
        required_sql_proof: "app manifest compiler validates top-level app metadata",
    },
    ContractGap {
        source_test: "rejects_invalid_schema_contracts_with_structured_paths",
        required_sql_proof: "compiler returns exact multi-issue schema paths",
    },
    ContractGap {
        source_test: "validates_row_version_apply_contracts_against_schema",
        required_sql_proof: "generated apply accepts the valid write",
    },
    ContractGap {
        source_test: "validates_custom_field_contracts_against_schema",
        required_sql_proof: "generated apply accepts all valid custom-field writes",
    },
    ContractGap {
        source_test: "separates_unknown_custom_enum_options_from_type_mismatches",
        required_sql_proof: "generated apply emits distinct enum-option and type errors",
    },
    ContractGap {
        source_test: "rejects_invalid_custom_field_writes_with_structured_paths",
        required_sql_proof: "generated apply returns exact custom-field issue paths",
    },
    ContractGap {
        source_test: "archived_custom_field_ids_on_other_models_are_unknown",
        required_sql_proof: "generated apply scopes archived custom-field identity by model",
    },
    ContractGap {
        source_test: "rejects_empty_custom_field_only_writes",
        required_sql_proof: "generated apply rejects empty custom-field writes",
    },
    ContractGap {
        source_test: "rejects_reusing_archived_custom_field_ids",
        required_sql_proof: "compiler rejects archived custom-field ID reuse",
    },
    ContractGap {
        source_test: "rejects_custom_fields_that_normalize_collide_with_declared_field_ids",
        required_sql_proof: "compiler rejects custom/declared physical collisions",
    },
    ContractGap {
        source_test: "rejects_custom_field_ids_that_collide_after_normalization",
        required_sql_proof: "compiler rejects normalized custom-field collisions",
    },
    ContractGap {
        source_test: "rejects_custom_fields_that_collide_with_system_columns",
        required_sql_proof: "compiler rejects custom-field/system-column collisions",
    },
    ContractGap {
        source_test: "rejects_blank_unique_text_values",
        required_sql_proof: "generated apply rejects blank unique values",
    },
    ContractGap {
        source_test: "rejects_apply_contracts_that_do_not_match_schema_identity_or_write_shape",
        required_sql_proof: "generated apply accumulates exact identity and shape issues",
    },
    ContractGap {
        source_test: "requires_agent_writes_to_reference_a_recorded_run",
        required_sql_proof: "generated apply enforces agent-run provenance",
    },
    ContractGap {
        source_test: "validates_agent_run_ledger_entries",
        required_sql_proof: "generated agent-run API validates exact ledger fields",
    },
    ContractGap {
        source_test: "rejects_record_event_values_and_unknown_value_fields",
        required_sql_proof: "generated apply validates record-event value shape",
    },
    ContractGap {
        source_test: "rejects_record_events_without_record_key",
        required_sql_proof: "generated apply requires event record keys",
    },
    ContractGap {
        source_test: "rejects_conflicting_and_tombstoned_new_record_subjects",
        required_sql_proof: "generated apply enforces new-subject conflicts",
    },
    ContractGap {
        source_test: "rejects_mixed_subject_addressing_for_an_explicit_new_record",
        required_sql_proof: "generated apply rejects mixed subject addressing",
    },
    ContractGap {
        source_test: "permits_repeated_versions_for_an_explicit_new_record",
        required_sql_proof: "generated apply accepts repeated explicit-subject versions",
    },
    ContractGap {
        source_test: "rejects_values_that_do_not_match_declared_field_type",
        required_sql_proof: "generated apply emits exact declared-type errors",
    },
    ContractGap {
        source_test: "validates_all_field_value_variants_against_declared_field_types",
        required_sql_proof: "generated apply covers every field-value variant",
    },
    ContractGap {
        source_test: "rejects_unknown_declared_enum_option",
        required_sql_proof: "generated apply rejects unknown declared enum options",
    },
    ContractGap {
        source_test: "rejects_invalid_money_rate_values",
        required_sql_proof: "generated apply validates money-rate amount currency and period",
    },
    ContractGap {
        source_test: "rejects_invalid_iso_country_and_currency_values",
        required_sql_proof: "generated apply validates ISO values",
    },
    ContractGap {
        source_test: "rejects_invalid_record_keys",
        required_sql_proof: "generated apply returns exact record-key errors",
    },
    ContractGap {
        source_test: "rejects_change_type_model_mismatch_without_enforcing_touches",
        required_sql_proof: "generated apply enforces only change-type target model",
    },
    ContractGap {
        source_test: "change_type_touches_and_required_are_descriptive_for_apply",
        required_sql_proof: "generated apply preserves descriptive touches/required semantics",
    },
    ContractGap {
        source_test: "rejects_normalized_identifier_collisions",
        required_sql_proof: "compiler rejects normalized model and field collisions",
    },
    ContractGap {
        source_test: "rejects_declared_fields_that_collide_with_system_columns",
        required_sql_proof: "compiler rejects declared/system-column collisions",
    },
    ContractGap {
        source_test: "rejects_money_rate_component_column_collisions",
        required_sql_proof: "compiler rejects money-rate component collisions",
    },
];

#[test]
fn non_transport_contracts_remain_explicit_generated_sql_parity_gaps() {
    assert_eq!(CONTRACT_GAPS.len(), 44);
    let generated_api = GENERATED_API_CONTRACTS
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    assert_eq!(generated_api.len(), GENERATED_API_CONTRACTS.len());
    let serde_or_decoder_only = SERDE_OR_DECODER_ONLY_CONTRACTS
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    assert_eq!(
        serde_or_decoder_only.len(),
        SERDE_OR_DECODER_ONLY_CONTRACTS.len()
    );

    let mut gaps = BTreeSet::new();
    for gap in CONTRACT_GAPS {
        assert!(
            gaps.insert(gap.source_test),
            "duplicate gap: {}",
            gap.source_test
        );
        assert!(!gap.required_sql_proof.is_empty());
    }
    assert!(generated_api.is_disjoint(&serde_or_decoder_only));
    assert!(generated_api.is_disjoint(&gaps));
    assert!(serde_or_decoder_only.is_disjoint(&gaps));

    let accounted_for = generated_api
        .union(&serde_or_decoder_only)
        .copied()
        .collect::<BTreeSet<_>>()
        .union(&gaps)
        .copied()
        .collect::<BTreeSet<_>>();
    assert_eq!(accounted_for, source_contract_test_names());
}

fn source_contract_test_names() -> BTreeSet<&'static str> {
    include_str!("../../kernel/tests/contracts.rs")
        .split("#[test]")
        .skip(1)
        .map(|test| {
            let function = test
                .find("fn ")
                .map(|offset| offset + 3)
                .expect("contract test has a function");
            let end = test[function..]
                .find('(')
                .map(|offset| function + offset)
                .expect("contract test function has arguments");
            &test[function..end]
        })
        .collect()
}
