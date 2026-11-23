use std::collections::BTreeMap;
use std::env;
use support::trusted_human;

use chrono::{DateTime, NaiveDate, Utc};
use kernel::testing::{call_generated_sql, GeneratedSqlFunction};
use kernel::{
    connect_postgres, AppId, AppliedChangeSet, ApplyChangeSet, ApplyMode, ChangeType, ChangeTypeId,
    CustomFieldDefinition, CustomFieldDefinitionId, CustomFieldEntry, CustomFieldType,
    CustomFieldValue, CustomerId, EnumOption, EnumOptionId, ErrorDetail, ErrorEnvelope,
    ExternalKey, Field, FieldId, FieldType, FieldValue, KernelError, Model, ModelId, ModelKind,
    RecordKey, RowVersionWrite, Schema, SchemaElementLifecycle, SchemaRevisionId, SchemaVersion,
};
use postgres::Client;
use rust_decimal::Decimal;
use schema_compiler::{
    compile_sql_artifact_manifest, render_sql_artifact_bundle, CompiledManifest,
    NormalizedManifestExtras,
};
use uuid::Uuid;

mod support;

const APP_ID: &str = "core_app";
const CUSTOMER_ID: &str = "customer_a";

struct TestDatabase {
    client: Client,
    schema_name: String,
}

impl TestDatabase {
    fn connect(schema: Schema) -> Option<Self> {
        Self::connect_for_scope(schema, APP_ID, CUSTOMER_ID)
    }

    fn connect_for_scope(schema: Schema, app_id: &str, customer_id: &str) -> Option<Self> {
        let database_url = match env::var("KERNEL_TEST_DATABASE_URL") {
            Ok(url) => url,
            Err(env::VarError::NotPresent) => {
                eprintln!(
                    "skipping generated SQL apply contract parity test: KERNEL_TEST_DATABASE_URL is absent"
                );
                return None;
            }
            Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
        };
        let mut client = connect_postgres(&database_url).expect("connect to PostgreSQL");
        let schema_name = format!("kernel_apply_contracts_{}", Uuid::new_v4().simple());
        client
            .batch_execute(&format!(
                "create schema \"{schema_name}\"; set search_path to \"{schema_name}\""
            ))
            .expect("create isolated generated SQL contract schema");

        let compiled = compiled_manifest(schema);
        let manifest =
            compile_sql_artifact_manifest(&compiled).expect("compile generated SQL artifacts");
        trusted_human::before_install(&mut client);
        client
            .batch_execute(&render_sql_artifact_bundle(&manifest))
            .unwrap_or_else(|error| panic!("install generated SQL contract bundle: {error}"));
        client
            .execute(
                r#"
                insert into schema_revision (
                  id, app_id, customer_id, version, base_schema, customer_overlay,
                  schema, activated_at, materialized_at
                ) values (1, $1, $2, $3, $4, '{}'::jsonb, $4, now(), now())
                "#,
                &[
                    &app_id,
                    &customer_id,
                    &compiled.schema.version.as_str(),
                    &serde_json::to_value(&compiled.schema).expect("serialize test schema"),
                ],
            )
            .expect("activate generated SQL contract schema");

        trusted_human::bind(&mut client, app_id, customer_id, "user_1");
        Some(Self {
            client,
            schema_name,
        })
    }

    fn apply(&mut self, request: &ApplyChangeSet) -> Result<AppliedChangeSet, KernelError> {
        call_generated_sql(
            &mut self.client,
            GeneratedSqlFunction::ApplyChangeSet,
            request,
        )
    }
}

impl Drop for TestDatabase {
    fn drop(&mut self) {
        support::drop_generated_sql_fixture(&mut self.client, &self.schema_name);
    }
}

#[test]
fn validates_row_version_apply_contracts_against_schema_match_generated_sql() {
    let Some(mut database) = TestDatabase::connect(valid_schema()) else {
        return;
    };
    let request = ApplyChangeSet {
        schema_revision_id: Some(SchemaRevisionId::new(1)),
        actor_id: Some("user_1".to_string()),
        source_kind: "user_edit".to_string(),
        idempotency_key: Some("request_1".to_string()),
        change_type_id: Some(ChangeTypeId::from("record_update")),
        notes: Some("initial write".to_string()),
        writes: vec![ordinary_write(
            None,
            None,
            Some(display_name("Example Record")),
        )],
        ..base_apply()
    };

    database
        .apply(&request)
        .expect("valid row-version contract applies through generated SQL");
}

#[test]
fn validates_custom_field_contracts_against_schema_match_generated_sql() {
    let Some(mut database) = TestDatabase::connect(custom_field_schema()) else {
        return;
    };
    seed_record(&mut database, "parent-1", "Parent");
    seed_record(&mut database, "record-1", "Record");

    database
        .apply(&custom_field_write(vec![
            custom("nickname", CustomFieldValue::Text("Al".to_string())),
            custom(
                "parent_custom",
                CustomFieldValue::Relation(RecordKey::ExternalKey(ExternalKey::from("parent-1"))),
            ),
            custom("tier", CustomFieldValue::Enum(EnumOptionId::from("gold"))),
        ]))
        .expect("valid custom-field contract applies through generated SQL");
}

#[test]
fn separates_unknown_custom_enum_options_from_type_mismatches_match_generated_sql() {
    let Some(mut database) = TestDatabase::connect(custom_field_schema()) else {
        return;
    };
    assert_validation(
        database
            .apply(&custom_field_write(vec![custom(
                "tier",
                CustomFieldValue::Enum(EnumOptionId::from("platinum")),
            )]))
            .expect_err("unknown custom enum option must fail"),
        vec![detail(
            "writes[0].custom_fields[0].value",
            "unknown_custom_enum_option",
            "custom enum option `platinum` is not active for custom field `tier`",
        )],
    );
    assert_validation(
        database
            .apply(&custom_field_write(vec![custom(
                "tier",
                CustomFieldValue::Text("gold".to_string()),
            )]))
            .expect_err("wrong custom enum value type must fail"),
        vec![detail(
            "writes[0].custom_fields[0].value",
            "custom_field_value_type_mismatch",
            "custom field `tier` value does not match declared type",
        )],
    );
}

#[test]
fn rejects_invalid_custom_field_writes_with_structured_paths_match_generated_sql() {
    let Some(mut database) = TestDatabase::connect(custom_field_schema_with_department()) else {
        return;
    };
    let request = custom_field_write(vec![
        custom("unknown", CustomFieldValue::Text("x".to_string())),
        custom("dept_code", CustomFieldValue::Text("x".to_string())),
        custom("old_code", CustomFieldValue::Text("x".to_string())),
        custom(
            "tier",
            CustomFieldValue::Enum(EnumOptionId::from("platinum")),
        ),
        custom("nickname", CustomFieldValue::Number(Decimal::new(42, 0))),
        custom("nickname", CustomFieldValue::Text("Al".to_string())),
        custom("nickname", CustomFieldValue::Text("Also Al".to_string())),
    ]);

    assert_validation(
        database
            .apply(&request)
            .expect_err("invalid custom-field set must fail"),
        vec![
            detail(
                "writes[0].custom_fields[0].field_id",
                "unknown_custom_field",
                "custom field `unknown` is not declared",
            ),
            detail(
                "writes[0].custom_fields[1].field_id",
                "wrong_model_custom_field",
                "custom field `dept_code` is not declared on model `record`",
            ),
            detail(
                "writes[0].custom_fields[2].field_id",
                "archived_custom_field",
                "custom field `old_code` is archived",
            ),
            detail(
                "writes[0].custom_fields[3].value",
                "unknown_custom_enum_option",
                "custom enum option `platinum` is not active for custom field `tier`",
            ),
            detail(
                "writes[0].custom_fields[4].value",
                "custom_field_value_type_mismatch",
                "custom field `nickname` value does not match declared type",
            ),
            detail(
                "writes[0].custom_fields[5].field_id",
                "duplicate_custom_field_value",
                "custom field `nickname` is duplicated in the write",
            ),
            detail(
                "writes[0].custom_fields[6].field_id",
                "duplicate_custom_field_value",
                "custom field `nickname` is duplicated in the write",
            ),
        ],
    );
}

#[test]
fn archived_custom_field_ids_on_other_models_are_unknown_match_generated_sql() {
    let schema = custom_field_schema_with_department();
    let Some(mut database) = TestDatabase::connect(schema) else {
        return;
    };
    let mut request = custom_field_write(vec![custom(
        "old_code",
        CustomFieldValue::Text("x".to_string()),
    )]);
    request.writes[0].model_id = ModelId::from("department");

    assert_validation(
        database
            .apply(&request)
            .expect_err("other-model archived id must remain unknown"),
        vec![detail(
            "writes[0].custom_fields[0].field_id",
            "unknown_custom_field",
            "custom field `old_code` is not declared",
        )],
    );
}

#[test]
fn rejects_empty_custom_field_only_writes_match_generated_sql() {
    let Some(mut database) = TestDatabase::connect(custom_field_schema()) else {
        return;
    };
    assert_validation(
        database
            .apply(&custom_field_write(vec![]))
            .expect_err("empty custom-field-only write must fail"),
        vec![detail(
            "writes[0].values",
            "empty_values",
            "ordinary row-version writes must include at least one value, clear field, or metadata patch",
        )],
    );
}

#[test]
fn rejects_blank_unique_text_values_match_generated_sql() {
    let mut schema = valid_schema();
    schema.models[0].fields[0].is_unique = true;
    let Some(mut database) = TestDatabase::connect(schema) else {
        return;
    };
    let request = ApplyChangeSet {
        schema_revision_id: Some(SchemaRevisionId::new(1)),
        actor_id: Some("user_1".to_string()),
        source_kind: "user_edit".to_string(),
        idempotency_key: Some("request_1".to_string()),
        change_type_id: Some(ChangeTypeId::from("record_update")),
        writes: vec![ordinary_write(None, None, Some(display_name("  ")))],
        ..base_apply()
    };

    assert_validation(
        database
            .apply(&request)
            .expect_err("blank unique text must fail"),
        vec![detail(
            "writes[0].values.display_name",
            "blank_unique_text_value",
            "unique text fields must be omitted instead of supplied as blank text",
        )],
    );
}

#[test]
fn rejects_apply_contracts_that_do_not_match_schema_identity_or_write_shape_match_generated_sql() {
    let Some(mut database) =
        TestDatabase::connect_for_scope(valid_schema(), APP_ID, "other_customer")
    else {
        return;
    };
    let request = ApplyChangeSet {
        customer_id: CustomerId::from("other_customer"),
        schema_revision_id: Some(SchemaRevisionId::new(1)),
        change_type_id: Some(ChangeTypeId::from("missing_change_type")),
        mode: ApplyMode::Draft,
        writes: vec![RowVersionWrite {
            model_id: ModelId::from("missing_model"),
            record_key: None,
            new_record_id: None,
            effective_start: date("2026-05-04"),
            values: None,
            custom_fields: None,
            tombstones_record: false,
            provenance: None,
            ..Default::default()
        }],
        ..base_apply()
    };

    assert_validation(
        database
            .apply(&request)
            .expect_err("identity and write-shape mismatches must aggregate"),
        vec![
            detail(
                "customer_id",
                "customer_id_mismatch",
                "apply customer_id must match schema customer_id",
            ),
            detail(
                "change_type_id",
                "unknown_change_type",
                "change_type_id `missing_change_type` is not declared in the active schema",
            ),
            detail(
                "writes[0].model_id",
                "unknown_write_model",
                "write model_id `missing_model` is not declared in the active schema",
            ),
            detail(
                "writes[0].values",
                "missing_values",
                "ordinary row-version writes must include values, custom_fields, clear fields, or metadata_patch",
            ),
        ],
    );
}

#[test]
fn rejects_record_event_values_and_unknown_value_fields_match_generated_sql() {
    let Some(mut database) = TestDatabase::connect(valid_schema()) else {
        return;
    };
    let request = ApplyChangeSet {
        mode: ApplyMode::Draft,
        writes: vec![
            RowVersionWrite {
                model_id: ModelId::from("record"),
                record_key: None,
                new_record_id: None,
                effective_start: date("2026-05-04"),
                values: Some(BTreeMap::new()),
                custom_fields: Some(vec![custom(
                    "display_name_custom",
                    CustomFieldValue::Text("not allowed".to_string()),
                )]),
                tombstones_record: true,
                provenance: None,
                ..Default::default()
            },
            ordinary_write(
                None,
                None,
                Some(BTreeMap::from([(
                    FieldId::from("unknown_field"),
                    FieldValue::Text("value".to_string()),
                )])),
            ),
        ],
        ..base_apply()
    };

    assert_validation(
        database
            .apply(&request)
            .expect_err("record-event payload and unknown field must fail"),
        vec![
            detail(
                "writes[0].record_key",
                "missing_record_event_key",
                "tombstone writes must identify an existing record",
            ),
            detail(
                "writes[0].values",
                "record_event_values_forbidden",
                "tombstone writes must not carry typed values",
            ),
            detail(
                "writes[0].custom_fields",
                "record_event_custom_fields_forbidden",
                "tombstone writes must not carry custom field values",
            ),
            detail(
                "writes[1].values.unknown_field",
                "unknown_write_field",
                "field `unknown_field` is not declared on model `record`",
            ),
        ],
    );
}

#[test]
fn rejects_record_events_without_record_key_match_generated_sql() {
    let Some(mut database) = TestDatabase::connect(valid_schema()) else {
        return;
    };
    let request = ApplyChangeSet {
        writes: vec![RowVersionWrite {
            model_id: ModelId::from("record"),
            record_key: None,
            new_record_id: None,
            effective_start: date("2026-05-04"),
            values: None,
            custom_fields: None,
            tombstones_record: true,
            provenance: None,
            ..Default::default()
        }],
        ..base_apply()
    };

    assert_validation(
        database
            .apply(&request)
            .expect_err("record event without key must fail"),
        vec![detail(
            "writes[0].record_key",
            "missing_record_event_key",
            "tombstone writes must identify an existing record",
        )],
    );
}

#[test]
fn rejects_conflicting_and_tombstoned_new_record_subjects_match_generated_sql() {
    let Some(mut database) = TestDatabase::connect(valid_schema()) else {
        return;
    };
    let first = Uuid::parse_str("018f6bf3-1ea5-7812-9a5a-a1f5b04f0100").unwrap();
    let second = Uuid::parse_str("018f6bf3-1ea5-7812-9a5a-a1f5b04f0101").unwrap();
    let request = ApplyChangeSet {
        writes: vec![
            RowVersionWrite {
                model_id: ModelId::from("record"),
                record_key: Some(RecordKey::RecordId(first)),
                new_record_id: Some(first),
                effective_start: date("2026-05-04"),
                values: None,
                custom_fields: None,
                tombstones_record: false,
                provenance: None,
                ..Default::default()
            },
            RowVersionWrite {
                model_id: ModelId::from("record"),
                record_key: None,
                new_record_id: Some(second),
                effective_start: date("2026-05-04"),
                values: None,
                custom_fields: None,
                tombstones_record: true,
                provenance: None,
                ..Default::default()
            },
        ],
        ..base_apply()
    };

    assert_validation(
        database
            .apply(&request)
            .expect_err("conflicting and tombstoned new subjects must fail"),
        vec![
            detail(
                "writes[0].record_key",
                "mixed_new_record_subject_addressing",
                "all writes for an explicitly new record must identify the subject with new_record_id",
            ),
            detail(
                "writes[0].new_record_id",
                "conflicting_write_subject",
                "writes must identify either an existing subject or a new record, not both",
            ),
            detail(
                "writes[0].values",
                "missing_values",
                "ordinary row-version writes must include values, custom_fields, clear fields, or metadata_patch",
            ),
            detail(
                "writes[1].new_record_id",
                "new_record_tombstone_forbidden",
                "tombstone writes must identify an existing record",
            ),
        ],
    );
}

#[test]
fn rejects_mixed_subject_addressing_for_an_explicit_new_record_match_generated_sql() {
    let Some(mut database) = TestDatabase::connect(valid_schema()) else {
        return;
    };
    let record_id = Uuid::parse_str("018f6bf3-1ea5-7812-9a5a-a1f5b04f0102").unwrap();
    let request = ApplyChangeSet {
        writes: vec![
            ordinary_write(None, Some(record_id), Some(display_name("Initial"))),
            RowVersionWrite {
                model_id: ModelId::from("record"),
                record_key: Some(RecordKey::RecordId(record_id)),
                new_record_id: None,
                effective_start: date("2026-06-04"),
                values: Some(display_name("Updated")),
                custom_fields: None,
                tombstones_record: false,
                provenance: None,
                ..Default::default()
            },
        ],
        ..base_apply()
    };

    assert_validation(
        database
            .apply(&request)
            .expect_err("mixed explicit-new addressing must fail"),
        vec![detail(
            "writes[1].record_key",
            "mixed_new_record_subject_addressing",
            "all writes for an explicitly new record must identify the subject with new_record_id",
        )],
    );
}

fn assert_validation(error: KernelError, details: Vec<ErrorDetail>) {
    assert_eq!(
        error.into_envelope(),
        ErrorEnvelope {
            code: "contract_validation_failed".to_string(),
            message: "Contract validation failed".to_string(),
            details,
        }
    );
}

fn detail(path: &str, code: &str, message: &str) -> ErrorDetail {
    ErrorDetail {
        path: path.to_string(),
        code: code.to_string(),
        message: message.to_string(),
    }
}

fn compiled_manifest(schema: Schema) -> CompiledManifest {
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

fn valid_schema() -> Schema {
    Schema {
        app_id: AppId::from(APP_ID),
        customer_id: CustomerId::from(CUSTOMER_ID),
        version: SchemaVersion::from("2026-05-04"),
        models: vec![Model {
            id: ModelId::from("record"),
            kind: ModelKind::Entity,
            label: "Record".to_string(),
            extensions: kernel::EntityExtensionCapabilities {
                typed_custom_fields: true,
                ..Default::default()
            },
            fields: vec![
                field("display_name", FieldType::Text, true, false, None),
                field(
                    "parent_record",
                    FieldType::Relation,
                    false,
                    false,
                    Some("record"),
                ),
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
        custom_definition(
            "record_nickname",
            "record",
            "nickname",
            CustomFieldType::Text,
        ),
        CustomFieldDefinition {
            target_model_id: Some(ModelId::from("record")),
            ..custom_definition(
                "record_parent_custom",
                "record",
                "parent_custom",
                CustomFieldType::Relation,
            )
        },
        CustomFieldDefinition {
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
            ..custom_definition("record_tier", "record", "tier", CustomFieldType::Enum)
        },
        CustomFieldDefinition {
            archived_at: Some(
                DateTime::parse_from_rfc3339("2026-06-01T00:00:00Z")
                    .unwrap()
                    .with_timezone(&Utc),
            ),
            lifecycle: SchemaElementLifecycle::Retired,
            ..custom_definition(
                "record_old_code",
                "record",
                "old_code",
                CustomFieldType::Text,
            )
        },
    ];
    schema
}

fn custom_field_schema_with_department() -> Schema {
    let mut schema = custom_field_schema();
    schema.models.push(Model {
        id: ModelId::from("department"),
        kind: ModelKind::Entity,
        label: "Department".to_string(),
        fields: vec![field("name", FieldType::Text, true, false, None)],
        extensions: kernel::EntityExtensionCapabilities {
            typed_custom_fields: true,
            ..Default::default()
        },
        ..Default::default()
    });
    schema.custom_fields.push(custom_definition(
        "department_code",
        "department",
        "dept_code",
        CustomFieldType::Text,
    ));
    schema
}

fn custom_definition(
    id: &str,
    model_id: &str,
    field_id: &str,
    field_type: CustomFieldType,
) -> CustomFieldDefinition {
    CustomFieldDefinition {
        id: CustomFieldDefinitionId::from(id),
        model_id: ModelId::from(model_id),
        field_id: FieldId::from(field_id),
        label: field_id.to_string(),
        field_type,
        target_model_id: None,
        option_set: vec![],
        archived_at: None,
        ..Default::default()
    }
}

fn field(
    id: &str,
    field_type: FieldType,
    required: bool,
    is_unique: bool,
    target_model: Option<&str>,
) -> Field {
    Field {
        id: FieldId::from(id),
        label: id.to_string(),
        field_type,
        required,
        is_unique,
        target_model: target_model.map(ModelId::from),
        option_set: vec![],
        ..Default::default()
    }
}

fn base_apply() -> ApplyChangeSet {
    ApplyChangeSet {
        app_id: AppId::from(APP_ID),
        customer_id: CustomerId::from(CUSTOMER_ID),
        schema_revision_id: None,
        actor_id: Some("user_1".to_string()),
        source_kind: "test".to_string(),
        source_ref: None,
        idempotency_key: None,
        change_type_id: None,
        notes: None,
        mode: ApplyMode::Mainline,
        writes: vec![],
    }
}

fn custom_field_write(entries: Vec<CustomFieldEntry>) -> ApplyChangeSet {
    ApplyChangeSet {
        schema_revision_id: Some(SchemaRevisionId::new(1)),
        actor_id: Some("user_1".to_string()),
        source_kind: "user_edit".to_string(),
        idempotency_key: Some("custom_request".to_string()),
        writes: vec![RowVersionWrite {
            model_id: ModelId::from("record"),
            record_key: Some(RecordKey::ExternalKey(ExternalKey::from("record-1"))),
            new_record_id: None,
            effective_start: date("2026-05-04"),
            values: None,
            custom_fields: Some(entries),
            tombstones_record: false,
            provenance: None,
            ..Default::default()
        }],
        ..base_apply()
    }
}

fn seed_record(database: &mut TestDatabase, external_key: &str, name: &str) {
    let request = ApplyChangeSet {
        idempotency_key: Some(format!("seed-{external_key}")),
        writes: vec![ordinary_write(
            Some(RecordKey::ExternalKey(ExternalKey::from(external_key))),
            None,
            Some(display_name(name)),
        )],
        ..base_apply()
    };
    database.apply(&request).expect("seed contract test record");
}

fn ordinary_write(
    record_key: Option<RecordKey>,
    new_record_id: Option<Uuid>,
    values: Option<BTreeMap<FieldId, FieldValue>>,
) -> RowVersionWrite {
    RowVersionWrite {
        model_id: ModelId::from("record"),
        record_key,
        new_record_id,
        effective_start: date("2026-05-04"),
        values,
        custom_fields: None,
        tombstones_record: false,
        provenance: None,
        ..Default::default()
    }
}

fn display_name(value: &str) -> BTreeMap<FieldId, FieldValue> {
    BTreeMap::from([(
        FieldId::from("display_name"),
        FieldValue::Text(value.to_string()),
    )])
}

fn custom(field_id: &str, value: CustomFieldValue) -> CustomFieldEntry {
    CustomFieldEntry {
        field_id: FieldId::from(field_id),
        value,
    }
}

fn date(value: &str) -> NaiveDate {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").expect("valid parity test date")
}
