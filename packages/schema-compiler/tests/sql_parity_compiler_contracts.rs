use chrono::{TimeZone, Utc};
use kernel::{
    validate_app, AppId, ChangeType, ChangeTypeId, CustomFieldDefinition, CustomFieldDefinitionId,
    CustomFieldType, CustomerId, EnumOption, EnumOptionId, Field, FieldId, FieldType, Model,
    ModelId, ModelKind, Schema, SchemaElementLifecycle, SchemaVersion,
};
use schema_compiler::{
    compile_app_artifact_json, compile_sql_artifact_manifest, CompiledManifest,
    NormalizedManifestExtras, SqlCompileError,
};

fn valid_schema() -> Schema {
    Schema {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from("customer_a"),
        version: SchemaVersion::from("2026-08-04"),
        models: vec![Model {
            id: ModelId::from("record"),
            kind: ModelKind::Entity,
            label: "Record".to_string(),
            extensions: kernel::EntityExtensionCapabilities {
                typed_custom_fields: true,
                ..Default::default()
            },
            fields: vec![
                field("display_name", FieldType::Text),
                Field {
                    target_model: Some(ModelId::from("record")),
                    ..field("parent_record", FieldType::Relation)
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

fn custom_field_schema() -> Schema {
    let mut schema = valid_schema();
    schema.custom_fields = vec![
        custom_field("record_nickname", "nickname", CustomFieldType::Text, false),
        CustomFieldDefinition {
            target_model_id: Some(ModelId::from("record")),
            ..custom_field(
                "record_parent_custom",
                "parent_custom",
                CustomFieldType::Relation,
                false,
            )
        },
        CustomFieldDefinition {
            option_set: vec![option("gold", "Gold"), option("silver", "Silver")],
            ..custom_field("record_tier", "tier", CustomFieldType::Enum, false)
        },
        custom_field("record_old_code", "old_code", CustomFieldType::Text, true),
    ];
    schema
}

fn field(id: &str, field_type: FieldType) -> Field {
    Field {
        id: FieldId::from(id),
        label: id.to_string(),
        field_type,
        required: false,
        is_unique: false,
        target_model: None,
        option_set: vec![],
        ..Default::default()
    }
}

fn option(id: &str, label: &str) -> EnumOption {
    EnumOption {
        id: EnumOptionId::from(id),
        label: label.to_string(),
        aliases: vec![],
        ..Default::default()
    }
}

fn custom_field(
    id: &str,
    field_id: &str,
    field_type: CustomFieldType,
    archived: bool,
) -> CustomFieldDefinition {
    CustomFieldDefinition {
        id: CustomFieldDefinitionId::from(id),
        model_id: ModelId::from("record"),
        field_id: FieldId::from(field_id),
        label: field_id.to_string(),
        field_type,
        target_model_id: None,
        option_set: vec![],
        archived_at: archived.then(|| Utc.with_ymd_and_hms(2026, 6, 1, 0, 0, 0).unwrap()),
        lifecycle: if archived {
            SchemaElementLifecycle::Retired
        } else {
            SchemaElementLifecycle::Active
        },
        ..Default::default()
    }
}

fn compiled(schema: Schema) -> CompiledManifest {
    CompiledManifest {
        schema,
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

fn compile_schema(schema: Schema) -> Result<schema_compiler::SqlArtifactManifest, SqlCompileError> {
    compile_sql_artifact_manifest(&compiled(schema))
}

fn assert_sql_error(error: SqlCompileError, code: &str, path: &str, message: &str) {
    assert_eq!(error.code, code);
    assert_eq!(error.path, path);
    assert_eq!(error.message, message);
}

#[test]
fn compiler_validates_a_minimal_schema_contract() {
    let artifact = compile_schema(valid_schema()).expect("compile minimal schema to SQL artifacts");
    assert_eq!(artifact.app_id, "core_app");
    assert!(!artifact.artifacts.is_empty());
}

#[test]
fn compiler_validates_at_most_one_import_default_per_target_model() {
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

    assert_sql_error(
        compile_schema(schema.clone()).unwrap_err(),
        "duplicate_import_default",
        "change_types[1].is_import_default",
        "model `record` may declare at most one import-default change type",
    );

    schema.change_types[1].is_import_default = false;
    compile_schema(schema).expect("compile schema with one import default");
}

#[test]
fn compiler_rejects_duplicate_change_type_fields() {
    let mut schema = valid_schema();
    schema.change_types[0].touches =
        vec![FieldId::from("display_name"), FieldId::from("display_name")];

    assert_sql_error(
        compile_schema(schema).unwrap_err(),
        "duplicate_change_type_field",
        "change_types[0].touches",
        "field `display_name` is listed more than once for model `record`",
    );
}

#[test]
fn compiler_validates_unique_metadata_only_on_single_column_scalar_fields() {
    let mut schema = valid_schema();
    schema.models[0].fields[0].is_unique = true;
    compile_schema(schema.clone()).expect("compile unique scalar field");

    schema.models[0].fields[1].is_unique = true;
    assert_sql_error(
        compile_schema(schema).unwrap_err(),
        "unsupported_unique_field_type",
        "models[0].fields[1].is_unique",
        "unique fields must be single-column scalar fields",
    );

    let mut schema = valid_schema();
    schema.models[0].fields.push(Field {
        is_unique: true,
        ..field("aliases", FieldType::KnownAliases)
    });
    assert_sql_error(
        compile_schema(schema).unwrap_err(),
        "unsupported_unique_field_type",
        "models[0].fields[2].is_unique",
        "unique fields must be single-column scalar fields",
    );

    let mut schema = valid_schema();
    schema.models[0].fields.push(Field {
        is_unique: true,
        option_set: vec![option("active", "Active")],
        ..field("status", FieldType::Enum)
    });
    assert_sql_error(
        compile_schema(schema).unwrap_err(),
        "unsupported_unique_field_type",
        "models[0].fields[2].is_unique",
        "unique fields must be single-column scalar fields",
    );
}

#[test]
fn compiler_rejects_option_set_on_relation_fields() {
    let mut schema = valid_schema();
    schema.models[0].fields[1].option_set = vec![option("active", "Active")];

    assert_sql_error(
        compile_schema(schema).unwrap_err(),
        "unexpected_option_set",
        "models[0].fields[1].option_set",
        "only enum fields may declare option_set",
    );
}

#[test]
fn compiler_rejects_option_set_on_scalar_fields() {
    let mut schema = valid_schema();
    schema.models[0].fields[0].option_set = vec![option("active", "Active")];

    assert_sql_error(
        compile_schema(schema).unwrap_err(),
        "unexpected_option_set",
        "models[0].fields[0].option_set",
        "only enum fields may declare option_set",
    );
}

#[test]
fn compiler_rejects_empty_declared_enum_option_set() {
    let mut schema = valid_schema();
    schema.models[0]
        .fields
        .push(field("status", FieldType::Enum));

    assert_sql_error(
        compile_schema(schema).unwrap_err(),
        "empty_option_set",
        "models[0].fields[2].option_set",
        "enum fields must declare at least one option",
    );
}

#[test]
fn compiler_rejects_normalized_declared_enum_option_id_collisions() {
    let mut schema = valid_schema();
    schema.models[0].fields.push(Field {
        option_set: vec![option("Active", "Active"), option("active", "Active Again")],
        ..field("status", FieldType::Enum)
    });

    assert_sql_error(
        compile_schema(schema).unwrap_err(),
        "duplicate_option_id",
        "models[0].fields[2].option_set[1].id",
        "enum option id `active` is duplicated",
    );
}

#[test]
fn compiler_rejects_invalid_declared_enum_option_ids_before_deduping() {
    let mut schema = valid_schema();
    schema.models[0].fields.push(Field {
        option_set: vec![option("active", "Active"), option("bad/value", "Bad")],
        ..field("status", FieldType::Enum)
    });

    assert_sql_error(
        compile_schema(schema).unwrap_err(),
        "invalid_identifier_character",
        "models[0].fields[2].option_set[1].id",
        "identifier contains unsupported character `/`",
    );
}

#[test]
fn compiler_rejects_normalized_custom_enum_option_id_collisions() {
    let mut schema = custom_field_schema();
    schema.custom_fields.push(CustomFieldDefinition {
        option_set: vec![option("Active", "Active"), option("active", "Active Again")],
        ..custom_field("record_status", "status", CustomFieldType::Enum, false)
    });

    assert_sql_error(
        compile_schema(schema).unwrap_err(),
        "duplicate_custom_option_id",
        "custom_fields[4].option_set[1].id",
        "enum option id `active` is duplicated",
    );
}

#[test]
fn compiler_accepts_opaque_scope_ids_without_identifier_normalization() {
    let mut schema = valid_schema();
    schema.app_id = AppId::from("ops.revenue/v1");
    schema.customer_id = CustomerId::from("018f6bf3-1ea5-7812-9a5a-a1f5b04f0001");

    let artifact = compile_schema(schema).expect("compile opaque scope ids");
    assert_eq!(artifact.app_id, "ops.revenue/v1");
    assert_eq!(artifact.customer_id, "018f6bf3-1ea5-7812-9a5a-a1f5b04f0001");
}

#[test]
fn compiler_rejects_empty_opaque_scope_ids() {
    let mut schema = valid_schema();
    schema.app_id = AppId::from(" ");
    assert_sql_error(
        compile_schema(schema).unwrap_err(),
        "empty_scope_id",
        "app_id",
        "scope id must not be empty",
    );

    let mut schema = valid_schema();
    schema.customer_id = CustomerId::from("");
    assert_sql_error(
        compile_schema(schema).unwrap_err(),
        "empty_scope_id",
        "customer_id",
        "scope id must not be empty",
    );
}

#[test]
fn compiler_validates_top_level_app_schema_contract() {
    let source = r#"{
          "app_id": "core_app",
          "customer_id": "customer_a",
          "version": "2026-08-04",
          "label": "Core App",
          "connectors": {"csv": {"enabled": true}},
          "agents": {"reviewer": {"enabled": true}},
          "models": [{
            "id": "record",
            "kind": "entity",
            "label": "Record",
            "fields": [{"id": "display_name", "label": "Display Name", "type": "text"}]
          }]
        }"#;
    let artifact = compile_app_artifact_json(source).expect("compile complete app artifact");
    let app = artifact
        .app_with_schema(artifact.schema.clone())
        .expect("reconstruct complete app contract from compiler artifact");

    validate_app(&app).expect("generated app contract validates");
    assert_eq!(app.id.as_str(), "core_app");
    assert_eq!(app.label, "Core App");
    assert_eq!(app.schema.customer_id.as_str(), "customer_a");
    assert_eq!(app.connectors["csv"]["enabled"], true);
    assert_eq!(app.agents["reviewer"]["enabled"], true);

    let first = serde_json::to_vec(&artifact).expect("serialize app artifact");
    let second = serde_json::to_vec(
        &compile_app_artifact_json(source).expect("compile deterministic app artifact"),
    )
    .expect("serialize deterministic app artifact");
    assert_eq!(first, second);
}

#[test]
fn compiler_rejects_invalid_schema_contracts_with_structured_paths() {
    let mut unknown_relation = valid_schema();
    unknown_relation.models[0].fields[1].target_model = Some(ModelId::from("missing_model"));
    assert_sql_error(
        compile_schema(unknown_relation).unwrap_err(),
        "unknown_relation_target",
        "models[0].fields[1].target_model",
        "relation target `missing_model` is not a declared model",
    );

    let mut unknown_required = valid_schema();
    unknown_required.change_types[0].required = vec![FieldId::from("missing_field")];
    assert_sql_error(
        compile_schema(unknown_required).unwrap_err(),
        "unknown_change_type_field",
        "change_types[0].required",
        "field `missing_field` is not declared on model `record`",
    );
}

#[test]
fn compiler_rejects_normalized_identifier_collisions() {
    let mut schema = valid_schema();
    schema.models[0]
        .fields
        .push(field("display-name", FieldType::Text));
    assert_sql_error(
        compile_schema(schema).unwrap_err(),
        "normalized_field_id_collision",
        "models[0].fields[2].id",
        "field id `display-name` collides after identifier normalization",
    );

    let mut schema = valid_schema();
    schema.change_types.push(ChangeType {
        id: ChangeTypeId::from("record-update"),
        label: "Record Update 2".to_string(),
        target_model: ModelId::from("record"),
        is_import_default: false,
        touches: vec![],
        required: vec![],
    });
    assert_sql_error(
        compile_schema(schema).unwrap_err(),
        "normalized_change_type_id_collision",
        "change_types[1].id",
        "change type id `record-update` collides after identifier normalization",
    );
}

#[test]
fn compiler_rejects_declared_fields_that_collide_with_system_columns() {
    let mut schema = valid_schema();
    schema.models[0]
        .fields
        .push(field("provenance", FieldType::Text));

    assert_sql_error(
        compile_schema(schema).unwrap_err(),
        "system_column_collision",
        "models[0].fields[2].id",
        "field id `provenance` collides with reserved row-version column `provenance`",
    );
}

#[test]
fn compiler_rejects_money_rate_component_column_collisions() {
    let mut schema = valid_schema();
    schema.models[0]
        .fields
        .push(field("rate", FieldType::MoneyRate));
    schema.models[0]
        .fields
        .push(field("rate_amount", FieldType::Number));

    assert_sql_error(
        compile_schema(schema).unwrap_err(),
        "physical_name_collision",
        "models[0].fields[3].id",
        "field id `rate_amount` collides at physical column `rate_amount`",
    );
}

#[test]
fn compiler_rejects_reusing_archived_custom_field_ids() {
    let mut schema = custom_field_schema();
    schema.custom_fields.push(custom_field(
        "record_old_code_replacement",
        "old_code",
        CustomFieldType::Number,
        false,
    ));

    assert_sql_error(
        compile_schema(schema).unwrap_err(),
        "custom_field_id_reused",
        "custom_fields[4].field_id",
        "custom field `old_code` is already reserved for model `record`",
    );
}

#[test]
fn compiler_rejects_custom_fields_that_normalize_collide_with_declared_field_ids() {
    let mut schema = custom_field_schema();
    schema.custom_fields.push(custom_field(
        "record_display_name_custom",
        "Display Name",
        CustomFieldType::Text,
        false,
    ));

    assert_sql_error(
        compile_schema(schema).unwrap_err(),
        "custom_field_declared_field_collision",
        "custom_fields[4].field_id",
        "custom field `Display Name` collides with a declared field on model `record`",
    );
}

#[test]
fn compiler_rejects_custom_field_ids_that_collide_after_normalization() {
    let mut schema = custom_field_schema();
    schema.custom_fields.push(custom_field(
        "record_old_code_replacement",
        "Old Code",
        CustomFieldType::Text,
        false,
    ));

    assert_sql_error(
        compile_schema(schema).unwrap_err(),
        "custom_field_id_reused",
        "custom_fields[4].field_id",
        "custom field `Old Code` is already reserved for model `record`",
    );
}

#[test]
fn compiler_rejects_custom_fields_that_collide_with_system_columns() {
    let mut schema = custom_field_schema();
    schema.custom_fields.push(custom_field(
        "record_provenance_custom",
        "provenance",
        CustomFieldType::Text,
        false,
    ));

    assert_sql_error(
        compile_schema(schema).unwrap_err(),
        "system_column_collision",
        "custom_fields[4].field_id",
        "custom field `provenance` collides with reserved row-version column `provenance`",
    );
}
