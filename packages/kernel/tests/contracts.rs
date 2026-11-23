use std::collections::BTreeMap;

use chrono::{DateTime, NaiveDate, Utc};
use kernel::testing::DbError;
use kernel::{
    validate_agent_run_ledger_entry, validate_app, validate_apply_against_schema, validate_schema,
    AgentRunLedgerEntry, App, AppId, ApplyChangeSet, ApplyMode, ChangeType, ChangeTypeId,
    CustomFieldDefinition, CustomFieldDefinitionId, CustomFieldEntry, CustomFieldType,
    CustomFieldValue, CustomerId, EntityExtensionCapabilities, EnumOption, EnumOptionId,
    ExternalKey, Field, FieldId, FieldType, FieldValue, KernelError, Model, ModelId, ModelKind,
    MoneyRatePeriod, MoneyRateValue, RecordKey, RowVersionWrite, Schema, SchemaElementLifecycle,
    SchemaRevisionId, SchemaVersion, AGENT_SOURCE_KIND,
};
use rust_decimal::Decimal;
use serde_json::json;
use uuid::Uuid;

fn valid_schema() -> Schema {
    Schema {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from("customer_a"),
        version: SchemaVersion::from("2026-05-04"),
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

#[test]
fn schema_deserialization_requires_model_kind() {
    let mut schema_json = serde_json::to_value(valid_schema()).unwrap();
    schema_json["models"][0]
        .as_object_mut()
        .expect("model serializes as an object")
        .remove("kind");

    let error = serde_json::from_value::<Schema>(schema_json).unwrap_err();
    assert!(error.to_string().contains("missing field `kind`"));
}

#[test]
fn change_type_import_default_is_optional_metadata() {
    let defaulted: ChangeType = serde_json::from_value(json!({
        "id": "record_update",
        "label": "Record Update",
        "target_model": "record",
        "touches": [],
        "required": []
    }))
    .unwrap();
    assert!(!defaulted.is_import_default);
    assert!(serde_json::to_value(&defaulted)
        .unwrap()
        .get("is_import_default")
        .is_none());

    let selected: ChangeType = serde_json::from_value(json!({
        "id": "record_import",
        "label": "Record Import",
        "target_model": "record",
        "is_import_default": true,
        "touches": [],
        "required": []
    }))
    .unwrap();
    assert!(selected.is_import_default);
    assert_eq!(
        serde_json::to_value(&selected).unwrap()["is_import_default"],
        json!(true)
    );
}

fn custom_field_schema() -> Schema {
    let mut schema = valid_schema();
    schema.models[0].extensions.typed_custom_fields = true;
    schema.custom_fields = vec![
        CustomFieldDefinition {
            id: CustomFieldDefinitionId::from("record_nickname"),
            model_id: ModelId::from("record"),
            field_id: FieldId::from("nickname"),
            label: "Nickname".to_string(),
            field_type: CustomFieldType::Text,
            target_model_id: None,
            option_set: vec![],
            archived_at: None,

            ..Default::default()
        },
        CustomFieldDefinition {
            id: CustomFieldDefinitionId::from("record_parent_custom"),
            model_id: ModelId::from("record"),
            field_id: FieldId::from("parent_custom"),
            label: "Parent Custom".to_string(),
            field_type: CustomFieldType::Relation,
            target_model_id: Some(ModelId::from("record")),
            option_set: vec![],
            archived_at: None,

            ..Default::default()
        },
        CustomFieldDefinition {
            id: CustomFieldDefinitionId::from("record_tier"),
            model_id: ModelId::from("record"),
            field_id: FieldId::from("tier"),
            label: "Tier".to_string(),
            field_type: CustomFieldType::Enum,
            target_model_id: None,
            option_set: vec![
                EnumOption {
                    id: EnumOptionId::from("gold"),
                    label: "Gold".to_string(),
                    aliases: vec![],

                    ..Default::default()
                },
                EnumOption {
                    id: EnumOptionId::from("silver"),
                    label: "Silver".to_string(),
                    aliases: vec![],

                    ..Default::default()
                },
            ],
            archived_at: None,

            ..Default::default()
        },
        CustomFieldDefinition {
            id: CustomFieldDefinitionId::from("record_old_code"),
            model_id: ModelId::from("record"),
            field_id: FieldId::from("old_code"),
            label: "Old Code".to_string(),
            field_type: CustomFieldType::Text,
            target_model_id: None,
            option_set: vec![],
            archived_at: Some(
                DateTime::parse_from_rfc3339("2026-06-01T00:00:00Z")
                    .unwrap()
                    .with_timezone(&Utc),
            ),
            lifecycle: SchemaElementLifecycle::Retired,

            ..Default::default()
        },
    ];
    schema
}

fn custom_field_write(entries: Vec<CustomFieldEntry>) -> ApplyChangeSet {
    ApplyChangeSet {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from("customer_a"),
        schema_revision_id: Some(SchemaRevisionId::new(1)),
        actor_id: Some("user_1".to_string()),
        source_kind: "user_edit".to_string(),
        source_ref: None,
        idempotency_key: Some("custom_request".to_string()),
        change_type_id: None,
        notes: None,
        mode: ApplyMode::Mainline,
        writes: vec![RowVersionWrite {
            model_id: ModelId::from("record"),
            new_record_id: None,
            record_key: Some(RecordKey::ExternalKey(ExternalKey::from("record-1"))),
            effective_start: NaiveDate::from_ymd_opt(2026, 5, 4).unwrap(),
            values: None,
            custom_fields: Some(entries),
            tombstones_record: false,
            provenance: None,

            ..Default::default()
        }],
    }
}

#[test]
fn validates_a_minimal_schema_contract() {
    validate_schema(&valid_schema()).unwrap();
}

#[test]
fn validates_at_most_one_import_default_per_target_model() {
    let mut schema = valid_schema();
    schema.change_types[0].is_import_default = true;
    schema.change_types.push(ChangeType {
        id: ChangeTypeId::from("record_import_alternate"),
        label: "Alternate Record Import".to_string(),
        target_model: ModelId::from("record"),
        is_import_default: true,
        touches: vec![],
        required: vec![],
    });

    let error = validate_schema(&schema).unwrap_err();
    assert!(error.issues.iter().any(|issue| {
        issue.path == "change_types[1].is_import_default"
            && issue.code == "duplicate_import_default"
    }));

    schema.change_types[1].is_import_default = false;
    validate_schema(&schema).unwrap();
}

#[test]
fn rejects_duplicate_change_type_fields() {
    let mut schema = valid_schema();
    schema.change_types[0].touches = vec![FieldId::from("name"), FieldId::from("name")];

    let error = validate_schema(&schema).unwrap_err();
    assert!(error.issues.iter().any(|issue| {
        issue.path == "change_types[0].touches" && issue.code == "duplicate_change_type_field"
    }));
}

#[test]
fn validates_unique_metadata_only_on_single_column_scalar_fields() {
    let mut schema = valid_schema();
    schema.models[0].fields[0].is_unique = true;
    validate_schema(&schema).unwrap();

    schema.models[0].fields[1].is_unique = true;
    let error = validate_schema(&schema).unwrap_err();
    assert!(error.issues.iter().any(|issue| {
        issue.path == "models[0].fields[1].is_unique"
            && issue.code == "unsupported_unique_field_type"
    }));

    schema.models[0].fields[1].is_unique = false;
    schema.models[0].fields.push(Field {
        id: FieldId::from("aliases"),
        label: "Aliases".to_string(),
        field_type: FieldType::KnownAliases,
        required: false,
        is_unique: true,
        target_model: None,
        option_set: vec![],

        ..Default::default()
    });
    let error = validate_schema(&schema).unwrap_err();
    assert!(error.issues.iter().any(|issue| {
        issue.path == "models[0].fields[2].is_unique"
            && issue.code == "unsupported_unique_field_type"
    }));

    schema.models[0].fields[2].is_unique = false;
    schema.models[0].fields.push(Field {
        id: FieldId::from("status"),
        label: "Status".to_string(),
        field_type: FieldType::Enum,
        required: false,
        is_unique: true,
        target_model: None,
        option_set: vec![EnumOption {
            id: EnumOptionId::from("active"),
            label: "Active".to_string(),
            aliases: vec![],

            ..Default::default()
        }],

        ..Default::default()
    });
    let error = validate_schema(&schema).unwrap_err();
    assert!(error.issues.iter().any(|issue| {
        issue.path == "models[0].fields[3].is_unique"
            && issue.code == "unsupported_unique_field_type"
    }));
}

#[test]
fn rejects_option_set_on_relation_fields() {
    let mut schema = valid_schema();
    schema.models[0].fields[1].option_set = vec![EnumOption {
        id: EnumOptionId::from("active"),
        label: "Active".to_string(),
        aliases: vec![],

        ..Default::default()
    }];

    let error = validate_schema(&schema).unwrap_err();
    assert!(error.issues.iter().any(|issue| {
        issue.path == "models[0].fields[1].option_set" && issue.code == "unexpected_option_set"
    }));
}

#[test]
fn rejects_option_set_on_scalar_fields() {
    let mut schema = valid_schema();
    schema.models[0].fields[0].option_set = vec![EnumOption {
        id: EnumOptionId::from("active"),
        label: "Active".to_string(),
        aliases: vec![],

        ..Default::default()
    }];

    let error = validate_schema(&schema).unwrap_err();
    assert!(error.issues.iter().any(|issue| {
        issue.path == "models[0].fields[0].option_set" && issue.code == "unexpected_option_set"
    }));
}

#[test]
fn rejects_empty_declared_enum_option_set() {
    let mut schema = valid_schema();
    schema.models[0].fields.push(Field {
        id: FieldId::from("status"),
        label: "Status".to_string(),
        field_type: FieldType::Enum,
        required: false,
        is_unique: false,
        target_model: None,
        option_set: vec![],

        ..Default::default()
    });

    let error = validate_schema(&schema).unwrap_err();
    assert!(error
        .issues
        .iter()
        .any(|issue| issue.path == "models[0].fields[2].option_set"
            && issue.code == "empty_option_set"));
}

#[test]
fn rejects_normalized_declared_enum_option_id_collisions() {
    let mut schema = valid_schema();
    schema.models[0].fields.push(Field {
        id: FieldId::from("status"),
        label: "Status".to_string(),
        field_type: FieldType::Enum,
        required: false,
        is_unique: false,
        target_model: None,
        option_set: vec![
            EnumOption {
                id: EnumOptionId::from("Active"),
                label: "Active".to_string(),
                aliases: vec![],

                ..Default::default()
            },
            EnumOption {
                id: EnumOptionId::from("active"),
                label: "Active Again".to_string(),
                aliases: vec![],

                ..Default::default()
            },
        ],

        ..Default::default()
    });

    let error = validate_schema(&schema).unwrap_err();
    assert!(error
        .issues
        .iter()
        .any(|issue| issue.path == "models[0].fields[2].option_set[1].id"
            && issue.code == "duplicate_option_id"));
}

#[test]
fn rejects_invalid_declared_enum_option_ids_before_deduping() {
    let mut schema = valid_schema();
    schema.models[0].fields.push(Field {
        id: FieldId::from("status"),
        label: "Status".to_string(),
        field_type: FieldType::Enum,
        required: false,
        is_unique: false,
        target_model: None,
        option_set: vec![
            EnumOption {
                id: EnumOptionId::from("active"),
                label: "Active".to_string(),
                aliases: vec![],

                ..Default::default()
            },
            EnumOption {
                id: EnumOptionId::from("bad/value"),
                label: "Bad".to_string(),
                aliases: vec![],

                ..Default::default()
            },
        ],

        ..Default::default()
    });

    let error = validate_schema(&schema).unwrap_err();
    assert!(error.issues.iter().any(|issue| {
        issue.path == "models[0].fields[2].option_set[1].id"
            && issue.code == "invalid_identifier_character"
    }));
}

#[test]
fn rejects_normalized_custom_enum_option_id_collisions() {
    let mut schema = custom_field_schema();
    schema.custom_fields.push(CustomFieldDefinition {
        id: CustomFieldDefinitionId::from("record_status"),
        model_id: ModelId::from("record"),
        field_id: FieldId::from("status"),
        label: "Status".to_string(),
        field_type: CustomFieldType::Enum,
        target_model_id: None,
        option_set: vec![
            EnumOption {
                id: EnumOptionId::from("Active"),
                label: "Active".to_string(),
                aliases: vec![],

                ..Default::default()
            },
            EnumOption {
                id: EnumOptionId::from("active"),
                label: "Active Again".to_string(),
                aliases: vec![],

                ..Default::default()
            },
        ],
        archived_at: None,

        ..Default::default()
    });

    let error = validate_schema(&schema).unwrap_err();
    assert!(error.issues.iter().any(|issue| {
        issue.path == "custom_fields[4].option_set[1].id"
            && issue.code == "duplicate_custom_option_id"
    }));
}

#[test]
fn accepts_opaque_scope_ids_without_identifier_normalization() {
    let mut schema = valid_schema();
    schema.app_id = AppId::from("ops.revenue/v1");
    schema.customer_id = CustomerId::from("018f6bf3-1ea5-7812-9a5a-a1f5b04f0001");

    validate_schema(&schema).unwrap();
}

#[test]
fn rejects_empty_opaque_scope_ids() {
    let mut schema = valid_schema();
    schema.app_id = AppId::from(" ");
    schema.customer_id = CustomerId::from("");

    let error = validate_schema(&schema).unwrap_err();
    assert!(error
        .issues
        .iter()
        .any(|issue| issue.path == "app_id" && issue.code == "empty_scope_id"));
    assert!(error
        .issues
        .iter()
        .any(|issue| issue.path == "customer_id" && issue.code == "empty_scope_id"));
}

#[test]
fn validates_top_level_app_contract() {
    let schema = valid_schema();
    let app = App {
        id: schema.app_id.clone(),
        label: "Core App".to_string(),
        schema,
        connectors: json!({"csv": {"enabled": true}}),
        agents: json!({"reviewer": {"enabled": true}}),
    };

    validate_app(&app).unwrap();
}

#[test]
fn app_contract_round_trips_through_json() {
    let schema = valid_schema();
    let app = App {
        id: schema.app_id.clone(),
        label: "Core App".to_string(),
        schema,
        connectors: json!({"csv": {"enabled": true}}),
        agents: json!({"reviewer": {"enabled": true}}),
    };

    let serialized = serde_json::to_value(&app).unwrap();
    assert_eq!(serialized["id"], "core_app");
    assert_eq!(serialized["connectors"]["csv"]["enabled"], true);
    assert_eq!(serialized["agents"]["reviewer"]["enabled"], true);

    let deserialized: App = serde_json::from_value(serialized).unwrap();
    assert_eq!(deserialized, app);
}

#[test]
fn rejects_invalid_schema_contracts_with_structured_paths() {
    let mut schema = valid_schema();
    schema.models[0].fields[1].target_model = Some(ModelId::from("missing_model"));
    schema.change_types[0].required = vec![FieldId::from("missing_field")];

    let error = validate_schema(&schema).unwrap_err();
    let codes = error
        .issues
        .iter()
        .map(|issue| issue.code)
        .collect::<Vec<_>>();

    assert!(codes.contains(&"unknown_relation_target"));
    assert!(codes.contains(&"unknown_change_type_field"));
    assert!(error
        .issues
        .iter()
        .any(|issue| issue.path == "models[0].fields[1].target_model"));
    assert!(error
        .issues
        .iter()
        .any(|issue| issue.path == "change_types[0].required"));
}

#[test]
fn validates_row_version_apply_contracts_against_schema() {
    let schema = valid_schema();
    let mut values = BTreeMap::new();
    values.insert(
        FieldId::from("display_name"),
        FieldValue::Text("Example Record".to_string()),
    );

    let apply = ApplyChangeSet {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from("customer_a"),
        schema_revision_id: Some(SchemaRevisionId::new(1)),
        actor_id: Some("user_1".to_string()),
        source_kind: "user_edit".to_string(),
        source_ref: None,
        idempotency_key: Some("request_1".to_string()),
        change_type_id: Some(ChangeTypeId::from("record_update")),
        notes: Some("initial write".to_string()),
        mode: ApplyMode::Mainline,
        writes: vec![RowVersionWrite {
            model_id: ModelId::from("record"),
            new_record_id: None,
            record_key: None,
            effective_start: NaiveDate::from_ymd_opt(2026, 5, 4).unwrap(),
            values: Some(values),
            custom_fields: None,
            tombstones_record: false,
            provenance: None,

            ..Default::default()
        }],
    };

    validate_apply_against_schema(&apply, &schema).unwrap();
}

#[test]
fn validates_custom_field_contracts_against_schema() {
    let schema = custom_field_schema();
    validate_schema(&schema).unwrap();

    validate_apply_against_schema(
        &custom_field_write(vec![
            CustomFieldEntry {
                field_id: FieldId::from("nickname"),
                value: CustomFieldValue::Text("Al".to_string()),
            },
            CustomFieldEntry {
                field_id: FieldId::from("parent_custom"),
                value: CustomFieldValue::Relation(RecordKey::ExternalKey(ExternalKey::from(
                    "parent-1",
                ))),
            },
            CustomFieldEntry {
                field_id: FieldId::from("tier"),
                value: CustomFieldValue::Enum(EnumOptionId::from("gold")),
            },
        ]),
        &schema,
    )
    .unwrap();
}

#[test]
fn separates_unknown_custom_enum_options_from_type_mismatches() {
    let schema = custom_field_schema();

    let unknown_option = validate_apply_against_schema(
        &custom_field_write(vec![CustomFieldEntry {
            field_id: FieldId::from("tier"),
            value: CustomFieldValue::Enum(EnumOptionId::from("platinum")),
        }]),
        &schema,
    )
    .unwrap_err();
    assert!(unknown_option.issues.iter().any(|issue| {
        issue.path == "writes[0].custom_fields[0].value"
            && issue.code == "unknown_custom_enum_option"
    }));

    let wrong_type = validate_apply_against_schema(
        &custom_field_write(vec![CustomFieldEntry {
            field_id: FieldId::from("tier"),
            value: CustomFieldValue::Text("gold".to_string()),
        }]),
        &schema,
    )
    .unwrap_err();
    assert!(wrong_type.issues.iter().any(|issue| {
        issue.path == "writes[0].custom_fields[0].value"
            && issue.code == "custom_field_value_type_mismatch"
    }));
}

#[test]
fn rejects_invalid_custom_field_writes_with_structured_paths() {
    let mut schema = custom_field_schema();
    schema.models.push(Model {
        id: ModelId::from("department"),
        kind: ModelKind::Entity,
        label: "Department".to_string(),
        fields: vec![Field {
            id: FieldId::from("name"),
            label: "Name".to_string(),
            field_type: FieldType::Text,
            required: true,
            is_unique: false,
            target_model: None,
            option_set: vec![],

            ..Default::default()
        }],
        extensions: EntityExtensionCapabilities {
            typed_custom_fields: true,
            ..Default::default()
        },

        ..Default::default()
    });
    schema.custom_fields.push(CustomFieldDefinition {
        id: CustomFieldDefinitionId::from("department_code"),
        model_id: ModelId::from("department"),
        field_id: FieldId::from("dept_code"),
        label: "Department Code".to_string(),
        field_type: CustomFieldType::Text,
        target_model_id: None,
        option_set: vec![],
        archived_at: None,

        ..Default::default()
    });

    let apply = custom_field_write(vec![
        CustomFieldEntry {
            field_id: FieldId::from("unknown"),
            value: CustomFieldValue::Text("x".to_string()),
        },
        CustomFieldEntry {
            field_id: FieldId::from("dept_code"),
            value: CustomFieldValue::Text("x".to_string()),
        },
        CustomFieldEntry {
            field_id: FieldId::from("old_code"),
            value: CustomFieldValue::Text("x".to_string()),
        },
        CustomFieldEntry {
            field_id: FieldId::from("tier"),
            value: CustomFieldValue::Enum(EnumOptionId::from("platinum")),
        },
        CustomFieldEntry {
            field_id: FieldId::from("nickname"),
            value: CustomFieldValue::Number(Decimal::new(42, 0)),
        },
        CustomFieldEntry {
            field_id: FieldId::from("nickname"),
            value: CustomFieldValue::Text("Al".to_string()),
        },
        CustomFieldEntry {
            field_id: FieldId::from("nickname"),
            value: CustomFieldValue::Text("Also Al".to_string()),
        },
    ]);

    let error = validate_apply_against_schema(&apply, &schema).unwrap_err();
    let codes = error
        .issues
        .iter()
        .map(|issue| issue.code)
        .collect::<Vec<_>>();

    assert!(codes.contains(&"unknown_custom_field"));
    assert!(codes.contains(&"wrong_model_custom_field"));
    assert!(codes.contains(&"archived_custom_field"));
    assert!(codes.contains(&"unknown_custom_enum_option"));
    assert!(codes.contains(&"custom_field_value_type_mismatch"));
    assert!(codes.contains(&"duplicate_custom_field_value"));
    assert!(error.issues.iter().any(|issue| {
        issue.path == "writes[0].custom_fields[1].field_id"
            && issue.code == "wrong_model_custom_field"
    }));
    assert!(error.issues.iter().any(|issue| {
        issue.path == "writes[0].custom_fields[2].field_id" && issue.code == "archived_custom_field"
    }));
}

#[test]
fn archived_custom_field_ids_on_other_models_are_unknown() {
    let mut schema = custom_field_schema();
    schema.models.push(Model {
        id: ModelId::from("department"),
        kind: ModelKind::Entity,
        label: "Department".to_string(),
        fields: vec![Field {
            id: FieldId::from("name"),
            label: "Name".to_string(),
            field_type: FieldType::Text,
            required: true,
            is_unique: false,
            target_model: None,
            option_set: vec![],

            ..Default::default()
        }],

        ..Default::default()
    });

    let mut apply = custom_field_write(vec![CustomFieldEntry {
        field_id: FieldId::from("old_code"),
        value: CustomFieldValue::Text("x".to_string()),
    }]);
    apply.writes[0].model_id = ModelId::from("department");

    let error = validate_apply_against_schema(&apply, &schema).unwrap_err();
    assert!(error.issues.iter().any(|issue| {
        issue.path == "writes[0].custom_fields[0].field_id" && issue.code == "unknown_custom_field"
    }));
    assert!(!error.issues.iter().any(|issue| {
        issue.path == "writes[0].custom_fields[0].field_id"
            && issue.code == "wrong_model_custom_field"
    }));
}

#[test]
fn rejects_empty_custom_field_only_writes() {
    let schema = custom_field_schema();
    let apply = custom_field_write(vec![]);

    let error = validate_apply_against_schema(&apply, &schema).unwrap_err();
    assert!(error
        .issues
        .iter()
        .any(|issue| issue.path == "writes[0].values" && issue.code == "empty_values"));
}

#[test]
fn rejects_reusing_archived_custom_field_ids() {
    let mut schema = custom_field_schema();
    schema.custom_fields.push(CustomFieldDefinition {
        id: CustomFieldDefinitionId::from("record_old_code_replacement"),
        model_id: ModelId::from("record"),
        field_id: FieldId::from("old_code"),
        label: "Old Code Replacement".to_string(),
        field_type: CustomFieldType::Number,
        target_model_id: None,
        option_set: vec![],
        archived_at: None,

        ..Default::default()
    });

    let error = validate_schema(&schema).unwrap_err();
    assert!(error.issues.iter().any(|issue| {
        issue.path == "custom_fields[4].field_id" && issue.code == "custom_field_id_reused"
    }));
}

#[test]
fn rejects_custom_fields_that_normalize_collide_with_declared_field_ids() {
    let mut schema = custom_field_schema();
    schema.custom_fields.push(CustomFieldDefinition {
        id: CustomFieldDefinitionId::from("record_display_name_custom"),
        model_id: ModelId::from("record"),
        field_id: FieldId::from("Display Name"),
        label: "Display Name Custom".to_string(),
        field_type: CustomFieldType::Text,
        target_model_id: None,
        option_set: vec![],
        archived_at: None,

        ..Default::default()
    });

    let error = validate_schema(&schema).unwrap_err();
    assert!(error.issues.iter().any(|issue| {
        issue.path == "custom_fields[4].field_id"
            && issue.code == "custom_field_declared_field_collision"
    }));
}

#[test]
fn rejects_custom_field_ids_that_collide_after_normalization() {
    let mut schema = custom_field_schema();
    schema.custom_fields.push(CustomFieldDefinition {
        id: CustomFieldDefinitionId::from("record_old_code_replacement"),
        model_id: ModelId::from("record"),
        field_id: FieldId::from("Old Code"),
        label: "Old Code Replacement".to_string(),
        field_type: CustomFieldType::Text,
        target_model_id: None,
        option_set: vec![],
        archived_at: None,

        ..Default::default()
    });

    let error = validate_schema(&schema).unwrap_err();
    assert!(error.issues.iter().any(|issue| {
        issue.path == "custom_fields[4].field_id" && issue.code == "custom_field_id_reused"
    }));
}

#[test]
fn rejects_custom_fields_that_collide_with_system_columns() {
    let mut schema = custom_field_schema();
    schema.custom_fields.push(CustomFieldDefinition {
        id: CustomFieldDefinitionId::from("record_provenance_custom"),
        model_id: ModelId::from("record"),
        field_id: FieldId::from("provenance"),
        label: "Provenance Custom".to_string(),
        field_type: CustomFieldType::Text,
        target_model_id: None,
        option_set: vec![],
        archived_at: None,

        ..Default::default()
    });

    let error = validate_schema(&schema).unwrap_err();
    assert!(error.issues.iter().any(|issue| {
        issue.path == "custom_fields[4].field_id" && issue.code == "system_column_collision"
    }));
}

#[test]
fn custom_field_entries_serialize_as_field_type_value_objects() {
    let entry = CustomFieldEntry {
        field_id: FieldId::from("bonus"),
        value: CustomFieldValue::MoneyRate(MoneyRateValue {
            amount: Decimal::new(125000, 2),
            currency: "USD".to_string(),
            period: MoneyRatePeriod::Annual,
        }),
    };

    let serialized = serde_json::to_value(&entry).unwrap();
    assert_eq!(serialized["field_id"], "bonus");
    assert_eq!(serialized["type"], "money_rate");
    assert_eq!(serialized["value"]["amount"], "1250.00");
    assert_eq!(serialized["value"]["period"], "annual");

    let deserialized: CustomFieldEntry = serde_json::from_value(serialized).unwrap();
    assert_eq!(deserialized, entry);

    let round_trip: CustomFieldEntry =
        serde_json::from_str(&serde_json::to_string(&entry).unwrap()).unwrap();
    assert_eq!(round_trip, entry);
}

#[test]
fn rejects_blank_unique_text_values() {
    let mut schema = valid_schema();
    schema.models[0].fields[0].is_unique = true;

    let mut values = BTreeMap::new();
    values.insert(
        FieldId::from("display_name"),
        FieldValue::Text("  ".to_string()),
    );

    let apply = ApplyChangeSet {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from("customer_a"),
        schema_revision_id: Some(SchemaRevisionId::new(1)),
        actor_id: Some("user_1".to_string()),
        source_kind: "user_edit".to_string(),
        source_ref: None,
        idempotency_key: Some("request_1".to_string()),
        change_type_id: Some(ChangeTypeId::from("record_update")),
        notes: None,
        mode: ApplyMode::Mainline,
        writes: vec![RowVersionWrite {
            model_id: ModelId::from("record"),
            new_record_id: None,
            record_key: None,
            effective_start: NaiveDate::from_ymd_opt(2026, 5, 4).unwrap(),
            values: Some(values),
            custom_fields: None,
            tombstones_record: false,
            provenance: None,

            ..Default::default()
        }],
    };

    let error = validate_apply_against_schema(&apply, &schema).unwrap_err();
    assert!(error.issues.iter().any(|issue| {
        issue.path == "writes[0].values.display_name" && issue.code == "blank_unique_text_value"
    }));
}

#[test]
fn rejects_apply_contracts_that_do_not_match_schema_identity_or_write_shape() {
    let schema = valid_schema();
    let apply = ApplyChangeSet {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from("other_customer"),
        schema_revision_id: Some(SchemaRevisionId::new(1)),
        actor_id: None,
        source_kind: "test".to_string(),
        source_ref: None,
        idempotency_key: None,
        change_type_id: Some(ChangeTypeId::from("missing_change_type")),
        notes: None,
        mode: ApplyMode::Draft,
        writes: vec![RowVersionWrite {
            model_id: ModelId::from("missing_model"),
            new_record_id: None,
            record_key: None,
            effective_start: NaiveDate::from_ymd_opt(2026, 5, 4).unwrap(),
            values: None,
            custom_fields: None,
            tombstones_record: false,
            provenance: None,

            ..Default::default()
        }],
    };

    let error = validate_apply_against_schema(&apply, &schema).unwrap_err();
    let codes = error
        .issues
        .iter()
        .map(|issue| issue.code)
        .collect::<Vec<_>>();

    assert!(codes.contains(&"customer_id_mismatch"));
    assert!(codes.contains(&"unknown_change_type"));
    assert!(codes.contains(&"unknown_write_model"));
    assert!(codes.contains(&"missing_values"));
}

#[test]
fn requires_agent_writes_to_reference_a_recorded_run() {
    let schema = valid_schema();
    let mut apply = ApplyChangeSet {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from("customer_a"),
        schema_revision_id: Some(SchemaRevisionId::new(1)),
        actor_id: Some("agent".to_string()),
        source_kind: AGENT_SOURCE_KIND.to_string(),
        source_ref: None,
        idempotency_key: None,
        change_type_id: None,
        notes: None,
        mode: ApplyMode::Draft,
        writes: vec![RowVersionWrite {
            model_id: ModelId::from("record"),
            new_record_id: None,
            record_key: None,
            effective_start: NaiveDate::from_ymd_opt(2026, 5, 4).unwrap(),
            values: Some(BTreeMap::from([(
                FieldId::from("display_name"),
                FieldValue::Text("Example".to_string()),
            )])),
            custom_fields: None,
            tombstones_record: false,
            provenance: None,

            ..Default::default()
        }],
    };

    let error = validate_apply_against_schema(&apply, &schema).unwrap_err();
    assert!(error
        .issues
        .iter()
        .any(|issue| issue.path == "source_ref" && issue.code == "missing_agent_run_ref"));

    apply.source_ref = Some("run_1".to_string());
    validate_apply_against_schema(&apply, &schema).unwrap();
}

#[test]
fn validates_agent_run_ledger_entries() {
    let entry = AgentRunLedgerEntry {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from("customer_a"),
        run_id: "run_1".to_string(),
        status: Default::default(),
        schema_revision_id: Some(SchemaRevisionId::new(1)),
        actor_id: Some("agent".to_string()),
        agent_identity_id: "csv_import_planner".to_string(),
        execution_profile_id: "planner".to_string(),
        source_artifacts: json!([{"artifact_id": "sha256:abc"}]),
        alignment_decisions: json!([]),
        model_calls: json!([]),
        tool_calls: json!([]),
        token_usage: json!({"input": 10, "output": 4}),
        validation_failures: json!([]),
        final_outputs: json!({"status": "drafted"}),
        approval_boundaries: json!([]),
        compiled_preview_ids: vec!["preview_1".to_string()],
    };
    validate_agent_run_ledger_entry(&entry).unwrap();

    let defaulted: AgentRunLedgerEntry = serde_json::from_value(json!({
        "app_id": "core_app",
        "customer_id": "customer_a",
        "run_id": "run_defaulted",
        "agent_identity_id": "csv_import_planner",
        "execution_profile_id": "planner"
    }))
    .unwrap();
    assert_eq!(defaulted.source_artifacts, json!([]));
    assert_eq!(defaulted.alignment_decisions, json!([]));
    assert_eq!(defaulted.model_calls, json!([]));
    assert_eq!(defaulted.tool_calls, json!([]));
    assert_eq!(defaulted.token_usage, json!({}));
    assert_eq!(defaulted.validation_failures, json!([]));
    assert_eq!(defaulted.final_outputs, json!({}));
    assert_eq!(defaulted.approval_boundaries, json!([]));
    validate_agent_run_ledger_entry(&defaulted).unwrap();

    let mut null_evidence = entry.clone();
    null_evidence.source_artifacts = json!(null);
    let error = validate_agent_run_ledger_entry(&null_evidence).unwrap_err();
    assert!(error.issues.iter().any(|issue| {
        issue.path == "source_artifacts" && issue.code == "invalid_json_evidence"
    }));

    let mut wrong_container = entry.clone();
    wrong_container.token_usage = json!([]);
    let error = validate_agent_run_ledger_entry(&wrong_container).unwrap_err();
    assert!(error
        .issues
        .iter()
        .any(|issue| issue.path == "token_usage" && issue.code == "invalid_json_evidence"));

    let mut invalid = entry;
    invalid.run_id = " ".to_string();
    invalid.agent_identity_id = "".to_string();
    let error = validate_agent_run_ledger_entry(&invalid).unwrap_err();
    assert!(error
        .issues
        .iter()
        .any(|issue| issue.path == "run_id" && issue.code == "empty_value"));
    assert!(error
        .issues
        .iter()
        .any(|issue| issue.path == "agent_identity_id" && issue.code == "empty_value"));
}

#[test]
fn rejects_record_event_values_and_unknown_value_fields() {
    let schema = valid_schema();
    let mut values = BTreeMap::new();
    values.insert(
        FieldId::from("unknown_field"),
        FieldValue::Text("value".to_string()),
    );

    let apply = ApplyChangeSet {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from("customer_a"),
        schema_revision_id: Some(SchemaRevisionId::new(1)),
        actor_id: None,
        source_kind: "test".to_string(),
        source_ref: None,
        idempotency_key: None,
        change_type_id: None,
        notes: None,
        mode: ApplyMode::Draft,
        writes: vec![
            RowVersionWrite {
                model_id: ModelId::from("record"),
                new_record_id: None,
                record_key: None,
                effective_start: NaiveDate::from_ymd_opt(2026, 5, 4).unwrap(),
                values: Some(BTreeMap::new()),
                custom_fields: Some(vec![CustomFieldEntry {
                    field_id: FieldId::from("display_name_custom"),
                    value: CustomFieldValue::Text("not allowed".to_string()),
                }]),
                tombstones_record: true,
                provenance: None,

                ..Default::default()
            },
            RowVersionWrite {
                model_id: ModelId::from("record"),
                new_record_id: None,
                record_key: None,
                effective_start: NaiveDate::from_ymd_opt(2026, 5, 4).unwrap(),
                values: Some(values),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            },
        ],
    };

    let error = validate_apply_against_schema(&apply, &schema).unwrap_err();
    let issues = error
        .issues
        .iter()
        .map(|issue| (issue.path.as_str(), issue.code))
        .collect::<Vec<_>>();

    assert!(issues.contains(&("writes[0].values", "record_event_values_forbidden")));
    assert!(issues.contains(&(
        "writes[0].custom_fields",
        "record_event_custom_fields_forbidden"
    )));
    assert!(issues.contains(&("writes[1].values.unknown_field", "unknown_write_field")));
}

#[test]
fn rejects_record_events_without_record_key() {
    let schema = valid_schema();
    let apply = ApplyChangeSet {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from("customer_a"),
        schema_revision_id: Some(SchemaRevisionId::new(1)),
        actor_id: None,
        source_kind: "test".to_string(),
        source_ref: None,
        idempotency_key: None,
        change_type_id: None,
        notes: None,
        mode: ApplyMode::Mainline,
        writes: vec![RowVersionWrite {
            model_id: ModelId::from("record"),
            new_record_id: None,
            record_key: None,
            effective_start: NaiveDate::from_ymd_opt(2026, 5, 4).unwrap(),
            values: None,
            custom_fields: None,
            tombstones_record: true,
            provenance: None,

            ..Default::default()
        }],
    };

    let error = validate_apply_against_schema(&apply, &schema).unwrap_err();
    assert_eq!(
        error
            .issues
            .iter()
            .filter(|issue| issue.code == "missing_record_event_key")
            .count(),
        1
    );
}

#[test]
fn rejects_conflicting_and_tombstoned_new_record_subjects() {
    let schema = valid_schema();
    let new_record_id = Uuid::parse_str("018f6bf3-1ea5-7812-9a5a-a1f5b04f0100").unwrap();
    let apply = ApplyChangeSet {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from("customer_a"),
        schema_revision_id: Some(SchemaRevisionId::new(1)),
        actor_id: None,
        source_kind: "test".to_string(),
        source_ref: None,
        idempotency_key: None,
        change_type_id: None,
        notes: None,
        mode: ApplyMode::Mainline,
        writes: vec![
            RowVersionWrite {
                model_id: ModelId::from("record"),
                new_record_id: Some(new_record_id),
                record_key: Some(RecordKey::RecordId(new_record_id)),
                effective_start: NaiveDate::from_ymd_opt(2026, 5, 4).unwrap(),
                values: None,
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            },
            RowVersionWrite {
                model_id: ModelId::from("record"),
                new_record_id: Some(
                    Uuid::parse_str("018f6bf3-1ea5-7812-9a5a-a1f5b04f0101").unwrap(),
                ),
                record_key: None,
                effective_start: NaiveDate::from_ymd_opt(2026, 5, 4).unwrap(),
                values: None,
                custom_fields: None,
                tombstones_record: true,
                provenance: None,

                ..Default::default()
            },
        ],
    };

    let error = validate_apply_against_schema(&apply, &schema).unwrap_err();
    assert!(error.issues.iter().any(|issue| {
        issue.path == "writes[0].new_record_id" && issue.code == "conflicting_write_subject"
    }));
    assert!(error.issues.iter().any(|issue| {
        issue.path == "writes[1].new_record_id" && issue.code == "new_record_tombstone_forbidden"
    }));
}

#[test]
fn rejects_mixed_subject_addressing_for_an_explicit_new_record() {
    let schema = valid_schema();
    let new_record_id = Uuid::parse_str("018f6bf3-1ea5-7812-9a5a-a1f5b04f0102").unwrap();
    let values = |name: &str| {
        BTreeMap::from([(
            FieldId::from("display_name"),
            FieldValue::Text(name.to_string()),
        )])
    };
    let apply = ApplyChangeSet {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from("customer_a"),
        schema_revision_id: Some(SchemaRevisionId::new(1)),
        actor_id: None,
        source_kind: "test".to_string(),
        source_ref: None,
        idempotency_key: None,
        change_type_id: None,
        notes: None,
        mode: ApplyMode::Mainline,
        writes: vec![
            RowVersionWrite {
                model_id: ModelId::from("record"),
                record_key: None,
                new_record_id: Some(new_record_id),
                effective_start: NaiveDate::from_ymd_opt(2026, 5, 4).unwrap(),
                values: Some(values("Initial")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            },
            RowVersionWrite {
                model_id: ModelId::from("record"),
                record_key: Some(RecordKey::RecordId(new_record_id)),
                new_record_id: None,
                effective_start: NaiveDate::from_ymd_opt(2026, 6, 4).unwrap(),
                values: Some(values("Updated")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            },
        ],
    };

    let error = validate_apply_against_schema(&apply, &schema).unwrap_err();
    assert!(error.issues.iter().any(|issue| {
        issue.path == "writes[1].record_key" && issue.code == "mixed_new_record_subject_addressing"
    }));
}

#[test]
fn permits_repeated_versions_for_an_explicit_new_record() {
    let schema = valid_schema();
    let new_record_id = Uuid::parse_str("018f6bf3-1ea5-7812-9a5a-a1f5b04f0103").unwrap();
    let write = |date, name: &str| RowVersionWrite {
        model_id: ModelId::from("record"),
        record_key: None,
        new_record_id: Some(new_record_id),
        effective_start: date,
        values: Some(BTreeMap::from([(
            FieldId::from("display_name"),
            FieldValue::Text(name.to_string()),
        )])),
        custom_fields: None,
        tombstones_record: false,
        provenance: None,

        ..Default::default()
    };
    let apply = ApplyChangeSet {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from("customer_a"),
        schema_revision_id: Some(SchemaRevisionId::new(1)),
        actor_id: None,
        source_kind: "test".to_string(),
        source_ref: None,
        idempotency_key: None,
        change_type_id: None,
        notes: None,
        mode: ApplyMode::Mainline,
        writes: vec![
            write(NaiveDate::from_ymd_opt(2026, 5, 4).unwrap(), "Initial"),
            write(NaiveDate::from_ymd_opt(2026, 6, 4).unwrap(), "Updated"),
        ],
    };

    validate_apply_against_schema(&apply, &schema).unwrap();
}

#[test]
fn rejects_values_that_do_not_match_declared_field_type() {
    let schema = valid_schema();
    let mut values = BTreeMap::new();
    values.insert(FieldId::from("display_name"), FieldValue::Bool(true));

    let apply = ApplyChangeSet {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from("customer_a"),
        schema_revision_id: Some(SchemaRevisionId::new(1)),
        actor_id: None,
        source_kind: "test".to_string(),
        source_ref: None,
        idempotency_key: None,
        change_type_id: None,
        notes: None,
        mode: ApplyMode::Draft,
        writes: vec![RowVersionWrite {
            model_id: ModelId::from("record"),
            new_record_id: None,
            record_key: None,
            effective_start: NaiveDate::from_ymd_opt(2026, 5, 4).unwrap(),
            values: Some(values),
            custom_fields: None,
            tombstones_record: false,
            provenance: None,

            ..Default::default()
        }],
    };

    let error = validate_apply_against_schema(&apply, &schema).unwrap_err();
    assert!(error
        .issues
        .iter()
        .any(|issue| issue.code == "field_value_type_mismatch"));
}

#[test]
fn validates_all_field_value_variants_against_declared_field_types() {
    let record_id = Uuid::parse_str("018f6bf3-1ea5-7812-9a5a-a1f5b04f0001").unwrap();
    let datetime = DateTime::parse_from_rfc3339("2026-05-04T12:00:00Z")
        .unwrap()
        .with_timezone(&Utc);

    let field_cases = vec![
        (FieldType::Text, FieldValue::Text("value".to_string())),
        (FieldType::IsoCountry, FieldValue::Text("US".to_string())),
        (FieldType::IsoCurrency, FieldValue::Text("USD".to_string())),
        (FieldType::Number, FieldValue::Number(Decimal::new(125, 1))),
        (FieldType::Bool, FieldValue::Bool(true)),
        (
            FieldType::Date,
            FieldValue::Date(NaiveDate::from_ymd_opt(2026, 5, 4).unwrap()),
        ),
        (FieldType::Datetime, FieldValue::Datetime(datetime)),
        (
            FieldType::Relation,
            FieldValue::Relation(RecordKey::RecordId(record_id)),
        ),
        (
            FieldType::TextList,
            FieldValue::TextList(vec!["a".to_string(), "b".to_string()]),
        ),
        (
            FieldType::KnownAliases,
            FieldValue::TextList(vec!["alias".to_string(), "alternate".to_string()]),
        ),
        (
            FieldType::Json,
            FieldValue::Json(serde_json::json!({"key": "value"})),
        ),
        (
            FieldType::MoneyRate,
            FieldValue::MoneyRate(MoneyRateValue {
                amount: Decimal::new(10000, 2),
                currency: "USD".to_string(),
                period: MoneyRatePeriod::Annual,
            }),
        ),
        (
            FieldType::Enum,
            FieldValue::Enum(EnumOptionId::from("active")),
        ),
    ];

    let schema = Schema {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from("customer_a"),
        version: SchemaVersion::from("2026-05-04"),
        models: vec![Model {
            id: ModelId::from("record"),
            kind: ModelKind::Entity,
            label: "Record".to_string(),
            fields: field_cases
                .iter()
                .enumerate()
                .map(|(index, (field_type, _))| Field {
                    id: FieldId::from(format!("field_{index}")),
                    label: format!("Field {index}"),
                    field_type: field_type.clone(),
                    required: false,
                    is_unique: false,
                    target_model: matches!(field_type, FieldType::Relation)
                        .then(|| ModelId::from("record")),
                    option_set: matches!(field_type, FieldType::Enum)
                        .then(|| {
                            vec![EnumOption {
                                id: EnumOptionId::from("active"),
                                label: "Active".to_string(),
                                aliases: vec!["current".to_string()],

                                ..Default::default()
                            }]
                        })
                        .unwrap_or_default(),

                    ..Default::default()
                })
                .collect(),

            ..Default::default()
        }],
        custom_fields: vec![],
        change_types: vec![],
    };

    let values = field_cases
        .into_iter()
        .enumerate()
        .map(|(index, (_, value))| (FieldId::from(format!("field_{index}")), value))
        .collect();

    let apply = ApplyChangeSet {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from("customer_a"),
        schema_revision_id: Some(SchemaRevisionId::new(1)),
        actor_id: None,
        source_kind: "test".to_string(),
        source_ref: None,
        idempotency_key: None,
        change_type_id: None,
        notes: None,
        mode: ApplyMode::Mainline,
        writes: vec![RowVersionWrite {
            model_id: ModelId::from("record"),
            new_record_id: None,
            record_key: None,
            effective_start: NaiveDate::from_ymd_opt(2026, 5, 4).unwrap(),
            values: Some(values),
            custom_fields: None,
            tombstones_record: false,
            provenance: None,

            ..Default::default()
        }],
    };

    validate_apply_against_schema(&apply, &schema).unwrap();
}

#[test]
fn rejects_unknown_declared_enum_option() {
    let mut schema = valid_schema();
    schema.models[0].fields.push(Field {
        id: FieldId::from("status"),
        label: "Status".to_string(),
        field_type: FieldType::Enum,
        required: false,
        is_unique: false,
        target_model: None,
        option_set: vec![EnumOption {
            id: EnumOptionId::from("active"),
            label: "Active".to_string(),
            aliases: vec![],

            ..Default::default()
        }],

        ..Default::default()
    });

    let mut values = BTreeMap::new();
    values.insert(
        FieldId::from("status"),
        FieldValue::Enum(EnumOptionId::from("inactive")),
    );

    let error = validate_apply_against_schema(
        &ApplyChangeSet {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from("customer_a"),
            schema_revision_id: Some(SchemaRevisionId::new(1)),
            actor_id: None,
            source_kind: "test".to_string(),
            source_ref: None,
            idempotency_key: None,
            change_type_id: None,
            notes: None,
            mode: ApplyMode::Mainline,
            writes: vec![RowVersionWrite {
                model_id: ModelId::from("record"),
                new_record_id: None,
                record_key: None,
                effective_start: NaiveDate::from_ymd_opt(2026, 5, 4).unwrap(),
                values: Some(values),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,

                ..Default::default()
            }],
        },
        &schema,
    )
    .unwrap_err();

    assert!(error.issues.iter().any(|issue| {
        issue.path == "writes[0].values.status" && issue.code == "unknown_enum_option"
    }));
}

#[test]
fn rejects_invalid_money_rate_values() {
    let mut schema = valid_schema();
    schema.models[0].fields.push(Field {
        id: FieldId::from("rate"),
        label: "Rate".to_string(),
        field_type: FieldType::MoneyRate,
        required: false,
        is_unique: false,
        target_model: None,
        option_set: vec![],

        ..Default::default()
    });

    let mut values = BTreeMap::new();
    values.insert(
        FieldId::from("rate"),
        FieldValue::MoneyRate(MoneyRateValue {
            amount: Decimal::new(10000, 2),
            currency: "XXX".to_string(),
            period: MoneyRatePeriod::Annual,
        }),
    );

    let apply = ApplyChangeSet {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from("customer_a"),
        schema_revision_id: Some(SchemaRevisionId::new(1)),
        actor_id: None,
        source_kind: "test".to_string(),
        source_ref: None,
        idempotency_key: None,
        change_type_id: None,
        notes: None,
        mode: ApplyMode::Mainline,
        writes: vec![RowVersionWrite {
            model_id: ModelId::from("record"),
            new_record_id: None,
            record_key: None,
            effective_start: NaiveDate::from_ymd_opt(2026, 5, 4).unwrap(),
            values: Some(values),
            custom_fields: None,
            tombstones_record: false,
            provenance: None,

            ..Default::default()
        }],
    };

    let error = validate_apply_against_schema(&apply, &schema).unwrap_err();
    assert!(error
        .issues
        .iter()
        .any(|issue| issue.code == "field_value_type_mismatch"));

    let invalid_period = serde_json::from_value::<FieldValue>(json!({
        "type": "money_rate",
        "value": {
            "amount": "100.00",
            "currency": "USD",
            "period": "quarterly"
        }
    }));
    assert!(invalid_period.is_err());

    let numeric_amount = serde_json::from_value::<FieldValue>(json!({
        "type": "money_rate",
        "value": {
            "amount": 100.00,
            "currency": "USD",
            "period": "annual"
        }
    }));
    assert!(numeric_amount.is_err());
}

#[test]
fn rejects_invalid_iso_country_and_currency_values() {
    let mut schema = valid_schema();
    schema.models[0].fields.extend([
        Field {
            id: FieldId::from("country"),
            label: "Country".to_string(),
            field_type: FieldType::IsoCountry,
            required: false,
            is_unique: false,
            target_model: None,
            option_set: vec![],

            ..Default::default()
        },
        Field {
            id: FieldId::from("currency"),
            label: "Currency".to_string(),
            field_type: FieldType::IsoCurrency,
            required: false,
            is_unique: false,
            target_model: None,
            option_set: vec![],

            ..Default::default()
        },
    ]);

    let mut values = BTreeMap::new();
    values.insert(
        FieldId::from("country"),
        FieldValue::Text("USA".to_string()),
    );
    values.insert(
        FieldId::from("currency"),
        FieldValue::Text("XXX".to_string()),
    );

    let apply = ApplyChangeSet {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from("customer_a"),
        schema_revision_id: Some(SchemaRevisionId::new(1)),
        actor_id: None,
        source_kind: "test".to_string(),
        source_ref: None,
        idempotency_key: None,
        change_type_id: None,
        notes: None,
        mode: ApplyMode::Mainline,
        writes: vec![RowVersionWrite {
            model_id: ModelId::from("record"),
            new_record_id: None,
            record_key: None,
            effective_start: NaiveDate::from_ymd_opt(2026, 5, 4).unwrap(),
            values: Some(values),
            custom_fields: None,
            tombstones_record: false,
            provenance: None,

            ..Default::default()
        }],
    };

    let error = validate_apply_against_schema(&apply, &schema).unwrap_err();
    let codes: Vec<_> = error
        .issues
        .iter()
        .map(|issue| issue.path.clone())
        .collect();
    assert!(codes
        .iter()
        .any(|path| path.ends_with("writes[0].values.country")));
    assert!(codes
        .iter()
        .any(|path| path.ends_with("writes[0].values.currency")));
}

#[test]
fn rejects_invalid_record_keys() {
    let schema = valid_schema();
    let mut values = BTreeMap::new();
    values.insert(
        FieldId::from("display_name"),
        FieldValue::Text("Example Record".to_string()),
    );

    let apply = ApplyChangeSet {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from("customer_a"),
        schema_revision_id: Some(SchemaRevisionId::new(1)),
        actor_id: None,
        source_kind: "test".to_string(),
        source_ref: None,
        idempotency_key: None,
        change_type_id: None,
        notes: None,
        mode: ApplyMode::Draft,
        writes: vec![RowVersionWrite {
            model_id: ModelId::from("record"),
            new_record_id: None,
            record_key: Some(RecordKey::ExternalKey(ExternalKey::from("  "))),
            effective_start: NaiveDate::from_ymd_opt(2026, 5, 4).unwrap(),
            values: Some(values),
            custom_fields: None,
            tombstones_record: false,
            provenance: None,

            ..Default::default()
        }],
    };

    let error = validate_apply_against_schema(&apply, &schema).unwrap_err();
    assert!(error
        .issues
        .iter()
        .any(|issue| issue.code == "empty_external_key"));
}

#[test]
fn rejects_change_type_model_mismatch_without_enforcing_touches() {
    let mut schema = valid_schema();
    schema.models.push(Model {
        id: ModelId::from("other_record"),
        kind: ModelKind::Entity,
        label: "Other Record".to_string(),
        fields: vec![Field {
            id: FieldId::from("display_name"),
            label: "Display Name".to_string(),
            field_type: FieldType::Text,
            required: false,
            is_unique: false,
            target_model: None,
            option_set: vec![],

            ..Default::default()
        }],

        ..Default::default()
    });

    let mut values = BTreeMap::new();
    values.insert(
        FieldId::from("display_name"),
        FieldValue::Text("Other".to_string()),
    );

    let apply = ApplyChangeSet {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from("customer_a"),
        schema_revision_id: Some(SchemaRevisionId::new(1)),
        actor_id: None,
        source_kind: "test".to_string(),
        source_ref: None,
        idempotency_key: None,
        change_type_id: Some(ChangeTypeId::from("record_update")),
        notes: None,
        mode: ApplyMode::Draft,
        writes: vec![RowVersionWrite {
            model_id: ModelId::from("other_record"),
            new_record_id: None,
            record_key: None,
            effective_start: NaiveDate::from_ymd_opt(2026, 5, 4).unwrap(),
            values: Some(values),
            custom_fields: None,
            tombstones_record: false,
            provenance: None,

            ..Default::default()
        }],
    };

    let error = validate_apply_against_schema(&apply, &schema).unwrap_err();
    assert_eq!(error.issues[0].code, "change_type_model_mismatch");
}

#[test]
fn change_type_touches_and_required_are_descriptive_for_apply() {
    let mut schema = valid_schema();
    schema.models[0].fields.push(Field {
        id: FieldId::from("required_note"),
        label: "Required Note".to_string(),
        field_type: FieldType::Text,
        required: false,
        is_unique: false,
        target_model: None,
        option_set: vec![],

        ..Default::default()
    });
    schema.models[0].fields.push(Field {
        id: FieldId::from("review_note"),
        label: "Review Note".to_string(),
        field_type: FieldType::Text,
        required: false,
        is_unique: false,
        target_model: None,
        option_set: vec![],

        ..Default::default()
    });
    schema.change_types[0].touches = vec![FieldId::from("display_name")];
    schema.change_types[0].required = vec![FieldId::from("required_note")];
    validate_schema(&schema).unwrap();

    let mut values = BTreeMap::new();
    values.insert(
        FieldId::from("review_note"),
        FieldValue::Text("Not listed in change_type.touches".to_string()),
    );

    let apply = ApplyChangeSet {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from("customer_a"),
        schema_revision_id: Some(SchemaRevisionId::new(1)),
        actor_id: None,
        source_kind: "test".to_string(),
        source_ref: None,
        idempotency_key: None,
        change_type_id: Some(ChangeTypeId::from("record_update")),
        notes: None,
        mode: ApplyMode::Draft,
        writes: vec![RowVersionWrite {
            model_id: ModelId::from("record"),
            new_record_id: None,
            record_key: None,
            effective_start: NaiveDate::from_ymd_opt(2026, 5, 4).unwrap(),
            values: Some(values),
            custom_fields: None,
            tombstones_record: false,
            provenance: None,

            ..Default::default()
        }],
    };

    validate_apply_against_schema(&apply, &schema).unwrap();
}

#[test]
fn rejects_normalized_identifier_collisions() {
    let mut schema = valid_schema();
    schema.models[0].fields.push(Field {
        id: FieldId::from("display-name"),
        label: "Display Name 2".to_string(),
        field_type: FieldType::Text,
        required: false,
        is_unique: false,
        target_model: None,
        option_set: vec![],

        ..Default::default()
    });

    let error = validate_schema(&schema).unwrap_err();
    assert!(error
        .issues
        .iter()
        .any(|issue| issue.code == "normalized_field_id_collision"));

    let mut schema = valid_schema();
    schema.change_types.push(ChangeType {
        id: ChangeTypeId::from("record-update"),
        label: "Record Update 2".to_string(),
        target_model: ModelId::from("record"),
        is_import_default: false,
        touches: vec![],
        required: vec![],
    });

    let error = validate_schema(&schema).unwrap_err();
    assert!(error
        .issues
        .iter()
        .any(|issue| issue.code == "normalized_change_type_id_collision"));
}

#[test]
fn rejects_declared_fields_that_collide_with_system_columns() {
    let mut schema = valid_schema();
    schema.models[0].fields.push(Field {
        id: FieldId::from("provenance"),
        label: "Provenance".to_string(),
        field_type: FieldType::Text,
        required: false,
        is_unique: false,
        target_model: None,
        option_set: vec![],

        ..Default::default()
    });

    let error = validate_schema(&schema).unwrap_err();
    assert!(error
        .issues
        .iter()
        .any(|issue| issue.code == "system_column_collision"));
}

#[test]
fn rejects_money_rate_component_column_collisions() {
    let mut schema = valid_schema();
    schema.models[0].fields.push(Field {
        id: FieldId::from("rate"),
        label: "Rate".to_string(),
        field_type: FieldType::MoneyRate,
        required: false,
        is_unique: false,
        target_model: None,
        option_set: vec![],

        ..Default::default()
    });
    schema.models[0].fields.push(Field {
        id: FieldId::from("rate_amount"),
        label: "Rate Amount".to_string(),
        field_type: FieldType::Number,
        required: false,
        is_unique: false,
        target_model: None,
        option_set: vec![],

        ..Default::default()
    });

    let error = validate_schema(&schema).unwrap_err();
    assert!(error
        .issues
        .iter()
        .any(|issue| issue.code == "physical_name_collision"));
}

#[test]
fn error_envelope_preserves_machine_readable_validation_details() {
    let mut schema = valid_schema();
    schema.models[0].id = ModelId::from("123_bad");

    let envelope = KernelError::from(validate_schema(&schema).unwrap_err()).into_envelope();
    let serialized = serde_json::to_value(&envelope).unwrap();

    assert_eq!(envelope.code, "contract_validation_failed");
    assert_eq!(envelope.message, "Contract validation failed");
    assert_eq!(envelope.details[0].path, "models[0].id");
    assert_eq!(
        envelope.details[0].code,
        "identifier_must_start_with_letter"
    );
    assert_eq!(serialized["code"], "contract_validation_failed");
    assert_eq!(serialized["details"][0]["path"], "models[0].id");
}

#[test]
fn db_error_envelope_uses_stable_machine_readable_codes() {
    let envelope = KernelError::from(DbError::IdempotencyConflict {
        key: "request-1".to_string(),
    })
    .into_envelope();

    assert_eq!(envelope.code, "idempotency_conflict");
    assert_eq!(
        envelope.message,
        "Idempotency key was reused for a different request"
    );
    assert_eq!(envelope.details[0].path, "idempotency_key");
    assert_eq!(envelope.details[0].code, "idempotency_conflict");
    assert!(envelope.details[0].message.contains("request-1"));
}

#[test]
fn unique_field_conflict_envelope_carries_generic_structured_details() {
    let envelope = KernelError::from(DbError::UniqueFieldConflict {
        model: "employee".to_string(),
        field: "ref".to_string(),
        value: "EMP-1".to_string(),
    })
    .into_envelope();

    assert_eq!(envelope.code, "unique_field_conflict");
    assert_eq!(envelope.message, "Unique field value already exists");
    assert_eq!(
        envelope
            .details
            .iter()
            .map(|detail| (detail.path.as_str(), detail.message.as_str()))
            .collect::<Vec<_>>(),
        vec![("model", "employee"), ("field", "ref"), ("value", "EMP-1"),]
    );
}

#[test]
fn db_error_envelope_strips_internal_error_details() {
    let error = serde_json::from_str::<serde_json::Value>("{").unwrap_err();
    let envelope = KernelError::from(DbError::Serde(error)).into_envelope();

    assert_eq!(envelope.code, "serialization_error");
    assert_eq!(envelope.message, "Kernel serialization failed");
    assert!(envelope.details.is_empty());
}

#[test]
fn db_error_envelope_preserves_schema_drift_detail_shape() {
    let envelope = KernelError::from(DbError::SchemaDrift {
        object: "change_set.status".to_string(),
        details: "expected mainline/draft/discarded".to_string(),
    })
    .into_envelope();

    assert_eq!(envelope.code, "schema_drift");
    assert_eq!(envelope.message, "Schema drift detected");
    assert_eq!(envelope.details[0].path, "object");
    assert_eq!(envelope.details[0].code, "schema_drift");
    assert_eq!(
        envelope.details[0].message,
        "change_set.status: expected mainline/draft/discarded"
    );
}

#[test]
fn db_error_envelope_preserves_bare_details_shape() {
    let envelope = KernelError::from(DbError::RevertConflict {
        details: "target is not the current tip".to_string(),
    })
    .into_envelope();

    assert_eq!(envelope.code, "revert_conflict");
    assert_eq!(envelope.message, "target is not the current tip");
    assert!(envelope.details.is_empty());
}

#[test]
fn contract_ids_serialize_as_plain_json_strings() {
    let schema = valid_schema();
    let serialized = serde_json::to_value(&schema).unwrap();

    assert_eq!(serialized["app_id"], "core_app");
    assert_eq!(serialized["customer_id"], "customer_a");
    assert_eq!(serialized["models"][0]["id"], "record");
    assert_eq!(serialized["models"][0]["fields"][0]["id"], "display_name");
}

#[test]
fn record_ids_serialize_as_uuids_not_freeform_strings() {
    let record_id = Uuid::parse_str("018f6bf3-1ea5-7812-9a5a-a1f5b04f0001").unwrap();
    let key = RecordKey::RecordId(record_id);
    let serialized = serde_json::to_value(&key).unwrap();

    assert_eq!(serialized["type"], "record_id");
    assert_eq!(serialized["value"], record_id.to_string());
}

#[test]
fn apply_contract_round_trips_through_json() {
    let mut values = BTreeMap::new();
    values.insert(
        FieldId::from("display_name"),
        FieldValue::Text("Example Record".to_string()),
    );
    values.insert(
        FieldId::from("rate"),
        FieldValue::MoneyRate(MoneyRateValue {
            amount: Decimal::new(125000, 2),
            currency: "USD".to_string(),
            period: MoneyRatePeriod::Annual,
        }),
    );

    let apply = ApplyChangeSet {
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
            values: Some(values),
            custom_fields: None,
            tombstones_record: false,
            provenance: Some(json!({"source": "test"})),

            ..Default::default()
        }],
    };

    let serialized = serde_json::to_value(&apply).unwrap();
    assert_eq!(
        serialized["writes"][0]["record_key"]["type"],
        "external_key"
    );
    assert_eq!(
        serialized["writes"][0]["values"]["rate"]["value"]["amount"],
        "1250.00"
    );
    assert_eq!(
        serialized["writes"][0]["values"]["rate"]["value"]["period"],
        "annual"
    );

    let deserialized: ApplyChangeSet = serde_json::from_value(serialized).unwrap();
    assert_eq!(deserialized, apply);

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
    let serialized_anonymous = serde_json::to_value(anonymous_write).unwrap();
    assert_eq!(serialized_anonymous["record_key"], json!(null));
    assert!(serialized_anonymous.get("new_record_id").is_none());

    let number_value = FieldValue::Number(Decimal::new(125, 1));
    let serialized = serde_json::to_value(&number_value).unwrap();
    assert_eq!(serialized["value"], "12.5");

    let numeric_number = serde_json::from_value::<FieldValue>(json!({
        "type": "number",
        "value": 12.5
    }));
    assert!(numeric_number.is_err());
}

#[test]
fn apply_contract_rejects_removed_reason_field() {
    let apply = json!({
        "app_id": "core_app",
        "customer_id": "customer_a",
        "source_kind": "user_edit",
        "reason": "removed field",
        "mode": "mainline",
        "writes": [{
            "model_id": "record",
            "record_key": { "type": "external_key", "value": "record-1" },
            "effective_start": "2026-05-04",
            "values": {
                "display_name": { "type": "text", "value": "Example Record" }
            }
        }]
    });

    let error = serde_json::from_value::<ApplyChangeSet>(apply).unwrap_err();
    assert!(error.to_string().contains("unknown field `reason`"));
}
