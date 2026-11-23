use kernel::{
    CustomFieldDefinition, CustomFieldDefinitionId, CustomFieldType, FieldId,
    SchemaElementLifecycle,
};
use schema_compiler::{
    compile_manifest_json, data_plane, Comparison, ConstraintAuthority, ConstraintExpr,
    ConstraintManifest, NormalizedInverseRelation, TypedLiteral,
};
use serde_json::json;

fn fixture() -> schema_compiler::CompiledManifest {
    compile_manifest_json(&json!({
        "app_id":"inventory", "customer_id":"tenant", "version":"v1",
        "models":[{"id":"stock_item","kind":"entity","label":"Stock item","fields":[
            {"id":"name","label":"Name","type":"text","required":true},
            {"id":"unit_cost","label":"Unit cost","type":"number"},
            {"id":"state","label":"State","type":"enum","option_set":[{"id":"ready","label":"Ready"}]}
        ]}]
    }).to_string()).unwrap()
}

#[test]
fn generated_docs_use_the_actual_app_owned_next_schema_alias() {
    let generated = data_plane::compile(&fixture()).unwrap();
    let documentation = generated["documentation"].as_str().unwrap();
    assert!(documentation.contains("from `@/schema`"));
    assert!(documentation.contains("standard Next `@/*` alias (`${configDir}/*`)"));
    assert!(documentation.contains("explicitly configured project alias"));
    assert!(documentation.contains("app-owned generated `schema/index.ts`"));
    assert!(!documentation.contains("stable `schema` alias"));
}

#[test]
fn deterministic_catalog_and_bindings_are_schema_derived() {
    let compiled = fixture();
    let first = data_plane::compile(&compiled).unwrap();
    assert_eq!(first, data_plane::compile(&compiled).unwrap());
    let model = &first["manifest"]["models"][0];
    assert_eq!(model["name"], "stockItem");
    assert_eq!(
        first["manifest"]["capabilities"]["versionPreconditions"],
        true
    );
    assert!(model["operations"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|operation| matches!(
            operation["id"].as_str(),
            Some("stock_item.get" | "stock_item.list")
        ))
        .all(|operation| operation["input"]["select"]["allowedFields"]
            .as_array()
            .is_some_and(|fields| fields.iter().any(|field| field == "$version"))));
    assert_eq!(model["fields"][1]["name"], "unitCost");
    assert_eq!(model["fields"][1]["type"], "number");
    assert_eq!(model["operations"].as_array().unwrap().len(), 9);
    let count_by = model["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|operation| operation["id"] == "stock_item.countBy")
        .unwrap();
    assert_eq!(count_by["result"]["kind"], "bounded_group_counts");
    assert_eq!(count_by["result"]["valueType"], "group_field_read_value");
    assert_eq!(count_by["result"]["countType"], "decimal_integer_string");
    assert!(model["operations"]
        .as_array()
        .unwrap()
        .iter()
        .all(|operation| operation["exposed"] == false));
    for operation_id in ["stock_item.update", "stock_item.delete"] {
        let operation = model["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|operation| operation["id"] == operation_id)
            .expect("conditional write operation is present");
        assert_eq!(operation["input"]["options"]["ifVersion"]["type"], "uuid");
        assert_eq!(
            operation["input"]["options"]["ifVersion"]["source"],
            "$version"
        );
        assert_eq!(
            operation["input"]["options"]["ifVersion"]["mainlineOnly"],
            true
        );
        assert!(operation["errors"]
            .as_array()
            .is_some_and(|errors| errors.iter().any(|error| error == "version_conflict")));
        assert_eq!(
            operation["errorContracts"]["version_conflict"]["message"],
            "This record has changed. Reload and try again."
        );
    }
    assert!(first["typescript"]
        .as_str()
        .unwrap()
        .contains("export type StockItem = ModelRecord"));
    assert!(first["typescript"]
        .as_str()
        .unwrap()
        .contains("export type StockItemCreateField = ModelCreateField"));
    assert!(first["typescript"]
        .as_str()
        .unwrap()
        .contains("export type StockItemUpdateField = ModelUpdateField"));
    assert!(!first["typescript"]
        .as_str()
        .unwrap()
        .contains("stock_item_record"));
    assert!(first["documentation"]
        .as_str()
        .unwrap()
        .contains("audited tombstone"));
    assert_eq!(model["form"]["method"], "parseForm");
    assert_eq!(
        model["form"]["fieldTypes"]["create"],
        "StockItemCreateField"
    );
    assert_eq!(
        model["form"]["fieldTypes"]["update"],
        "StockItemUpdateField"
    );
    assert_eq!(model["form"]["authorization"], "none");
    assert_eq!(model["form"]["persistence"], "none");
    assert_eq!(model["form"]["allowlist"]["minItems"], 1);
    assert_eq!(
        model["form"]["controls"]["composites"],
        "single_json_control"
    );
    assert_eq!(model["form"]["clear"]["prefix"], "clear:");
    assert_eq!(model["form"]["errorMapping"]["method"], "toFormError");
    assert_eq!(
        model["form"]["errorMapping"]["constraintIdentity"],
        "authoritative_declared_constraint_with_exact_referencedFieldIds"
    );
    assert_eq!(
        model["form"]["errorMapping"]["unknownOrMalformed"],
        "undefined"
    );
    assert!(first["documentation"]
        .as_str()
        .unwrap()
        .contains("toFormError(error, { fields })"));
    assert!(first["documentation"]
        .as_str()
        .unwrap()
        .contains("raw database diagnostics are never exposed"));
    assert!(first["documentation"]
        .as_str()
        .unwrap()
        .contains("options.ifVersion accepts the selected $version"));
    let documentation = first["documentation"].as_str().unwrap();
    assert!(documentation.contains("readonly UUID `$version`"));
    assert!(documentation.contains("`[\"id\", \"$version\"]`"));
    assert!(documentation.contains("use its `id` as the mutation target"));
    assert!(documentation.contains("`<Model>CreateField` and `<Model>UpdateField`"));
    assert!(documentation.contains("selected supported group field's generated read type"));

    // The definition carries each model's title column, so a client names a
    // lookup record by its display field: null for an entity.
    assert!(first["manifest"]["models"][0]["display_field_id"].is_null());
    let mut lookup = fixture();
    lookup.schema.models[0].kind = kernel::ModelKind::Lookup;
    lookup.schema.models[0].display_field_id = Some(FieldId::from("name"));
    let lookup_catalog = data_plane::compile(&lookup).expect("lookup catalogs are supported");
    assert_eq!(
        lookup_catalog["manifest"]["models"][0]["display_field_id"],
        "name"
    );
    let lookup_operations = &lookup_catalog["manifest"]["models"][0]["operations"];
    assert!(lookup_operations
        .as_array()
        .unwrap()
        .iter()
        .filter(|operation| matches!(
            operation["id"].as_str(),
            Some("stock_item.get" | "stock_item.list")
        ))
        .all(|operation| operation["input"]["select"]["allowedFields"]
            .as_array()
            .is_some_and(|fields| fields.iter().any(|field| field == "$version"))));
}

#[test]
fn generated_operations_keep_model_constraints_and_active_custom_fields_only() {
    let mut compiled = fixture();
    compiled.extras.constraints = vec![
        ConstraintManifest {
            id: "stock_item_name".to_string(),
            label: "Stock item name".to_string(),
            model: "stock_item".to_string(),
            authority: ConstraintAuthority::Authoritative,
            expression: ConstraintExpr::FieldPresent {
                field: "name".to_string(),
            },
            message: None,
            notes: None,
        },
        ConstraintManifest {
            id: "other_name".to_string(),
            label: "Other name".to_string(),
            model: "other".to_string(),
            authority: ConstraintAuthority::Authoritative,
            expression: ConstraintExpr::FieldPresent {
                field: "name".to_string(),
            },
            message: None,
            notes: None,
        },
    ];
    compiled.extras.inverse_relations = vec![NormalizedInverseRelation {
        owner_model: "stock_item".to_string(),
        id: "related_stock_items".to_string(),
        model: "stock_item".to_string(),
        through: "stock_item".to_string(),
        label: None,
        notes: None,
    }];
    compiled.schema.custom_fields = vec![
        CustomFieldDefinition {
            id: CustomFieldDefinitionId::from("stock_item_note"),
            model_id: "stock_item".into(),
            field_id: FieldId::from("note"),
            label: "Note".to_string(),
            field_type: CustomFieldType::Text,
            ..Default::default()
        },
        CustomFieldDefinition {
            id: CustomFieldDefinitionId::from("stock_item_legacy"),
            model_id: "stock_item".into(),
            field_id: FieldId::from("legacy"),
            label: "Legacy".to_string(),
            field_type: CustomFieldType::Text,
            lifecycle: SchemaElementLifecycle::Retired,
            archived_at: Some("2026-09-15T00:00:00Z".parse().unwrap()),
            ..Default::default()
        },
    ];

    let generated = data_plane::compile(&compiled).unwrap();
    let model = &generated["manifest"]["models"][0];
    assert_eq!(
        model["operations"][0]["constraints"][0]["id"],
        "stock_item_name"
    );
    assert_eq!(
        model["operations"][0]["constraints"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(model["fields"]
        .as_array()
        .unwrap()
        .iter()
        .any(|field| field["name"] == "customNote"));
    assert!(!model["fields"]
        .as_array()
        .unwrap()
        .iter()
        .any(|field| field["name"] == "customLegacy"));
    assert!(!generated["documentation"]
        .as_str()
        .unwrap()
        .contains("Example: `\""));
    assert!(generated["documentation"]
        .as_str()
        .unwrap()
        .contains("Example: `operations.stockItem.get(input)`"));
    assert!(generated["documentation"]
        .as_str()
        .unwrap()
        .contains("Example: `operations.stockItem.relations.relatedStockItems.list({ id: \"00000000-0000-0000-0000-000000000001\", asOf: \"2026-09-15\" })`"));
}

#[test]
fn generated_constraint_field_ids_follow_typed_expression_references_only() {
    let mut compiled = fixture();
    compiled.extras.constraints = vec![ConstraintManifest {
        id: "stock_item_typed_references".to_string(),
        label: "Typed references".to_string(),
        model: "stock_item".to_string(),
        authority: ConstraintAuthority::Authoritative,
        expression: ConstraintExpr::And {
            expressions: vec![
                ConstraintExpr::Or {
                    expressions: vec![
                        ConstraintExpr::FieldPresent {
                            field: "name".to_string(),
                        },
                        ConstraintExpr::Not {
                            expression: Box::new(ConstraintExpr::FieldAbsent {
                                field: "unit_cost".to_string(),
                            }),
                        },
                    ],
                },
                ConstraintExpr::CountPresent {
                    fields: vec!["state".to_string(), "name".to_string()],
                    min: Some(1),
                    max: Some(2),
                },
                ConstraintExpr::CompareFields {
                    left: "unit_cost".to_string(),
                    op: Comparison::Gte,
                    right: "state".to_string(),
                },
                ConstraintExpr::CompareLiteral {
                    field: "name".to_string(),
                    op: Comparison::Eq,
                    value: TypedLiteral::Text("literal_only_not_a_field".to_string()),
                },
                ConstraintExpr::FieldIn {
                    field: "state".to_string(),
                    values: vec![TypedLiteral::Text("literal_only_in_value".to_string())],
                },
                ConstraintExpr::FieldSetContains {
                    field: "name".to_string(),
                    value: "literal_only_set_value".to_string(),
                },
                ConstraintExpr::TextLength {
                    field: "unit_cost".to_string(),
                    min: Some(1),
                    max: Some(80),
                },
                ConstraintExpr::TextStartsWith {
                    field: "name".to_string(),
                    value: "literal_only_prefix".to_string(),
                },
            ],
        },
        message: None,
        notes: None,
    }];

    let generated = data_plane::compile(&compiled).unwrap();
    let fields = &generated["manifest"]["constraints"][0]["referencedFieldIds"];
    assert_eq!(fields, &json!(["name", "unit_cost", "state"]));
    assert_eq!(
        generated["manifest"]["constraints"][0]["expression"]["expressions"][7],
        json!({"type": "text_starts_with", "field": "name", "value": "literal_only_prefix"})
    );
    assert!(fields.as_array().unwrap().iter().all(|field| ![
        "literal_only_not_a_field",
        "literal_only_in_value",
        "literal_only_set_value",
        "literal_only_prefix",
    ]
    .iter()
    .any(|literal| field == literal)));
}

#[test]
fn retired_declared_fields_remain_readable_but_are_excluded_from_forms() {
    let mut compiled = fixture();
    compiled.schema.models[0].fields[1].lifecycle = SchemaElementLifecycle::Retired;

    let generated = data_plane::compile(&compiled).unwrap();
    let model = &generated["manifest"]["models"][0];
    assert!(model["fields"]
        .as_array()
        .unwrap()
        .iter()
        .any(|field| field["name"] == "unitCost" && field["lifecycle"] == "retired"));
    assert!(model["form"]["allowedFields"]
        .as_array()
        .unwrap()
        .iter()
        .all(|field| field != "unitCost"));
    assert!(model["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|operation| operation["id"] == "stock_item.get")
        .unwrap()["input"]["select"]["allowedFields"]
        .as_array()
        .unwrap()
        .iter()
        .any(|field| field == "unitCost"));
}

#[test]
fn invalid_inverse_relation_target_returns_a_compiler_error() {
    let mut compiled = fixture();
    compiled.extras.inverse_relations = vec![NormalizedInverseRelation {
        owner_model: "stock_item".to_string(),
        id: "unknown_target".to_string(),
        model: "missing_model".to_string(),
        through: "stock_item".to_string(),
        label: None,
        notes: None,
    }];

    assert_eq!(
        data_plane::compile(&compiled).unwrap_err(),
        "unknown inverse relation target model: missing_model"
    );
}

#[test]
fn rejects_model_record_types_that_shadow_reserved_generated_types() {
    for (model_id, public_type) in [
        ("canonical_record_key", "CanonicalRecordKey"),
        ("query_input", "QueryInput"),
        ("write_options", "WriteOptions"),
        ("data_write", "DataWrite"),
        ("form_error", "FormError"),
        ("form_error_code", "FormErrorCode"),
        ("form_action_result", "FormActionResult"),
        ("data_context", "DataContext"),
        ("data_definition", "DataDefinition"),
        ("model_create_field", "ModelCreateField"),
        ("model_record", "ModelRecord"),
        ("model_update_field", "ModelUpdateField"),
    ] {
        let compiled = compile_manifest_json(
            &json!({
                "app_id":"inventory", "customer_id":"tenant", "version":"v1",
                "models":[{"id":model_id,"kind":"entity","label":"Reserved","fields":[
                    {"id":"name","label":"Name","type":"text","required":true}
                ]}]
            })
            .to_string(),
        )
        .unwrap();

        assert_eq!(
            data_plane::compile(&compiled).unwrap_err(),
            format!("data record type collides with reserved generated type: {public_type}"),
        );
    }
}

#[test]
fn rejects_record_types_that_collide_with_generated_field_vocabulary_aliases() {
    let compiled = compile_manifest_json(
        &json!({
            "app_id":"inventory", "customer_id":"tenant", "version":"v1",
            "models":[
                {"id":"foo","kind":"entity","label":"Foo","fields":[
                    {"id":"name","label":"Name","type":"text","required":true}
                ]},
                {"id":"foo_create_field","kind":"entity","label":"Conflicting Foo","fields":[
                    {"id":"name","label":"Name","type":"text","required":true}
                ]}
            ]
        })
        .to_string(),
    )
    .unwrap();

    assert_eq!(
        data_plane::compile(&compiled).unwrap_err(),
        "data public type symbol collision: FooCreateField"
    );
}

#[test]
fn rejects_model_field_vocabulary_aliases_that_shadow_runtime_imports() {
    let compiled = compile_manifest_json(
        &json!({
            "app_id":"inventory", "customer_id":"tenant", "version":"v1",
            "models":[{"id":"model","kind":"entity","label":"Model","fields":[
                {"id":"name","label":"Name","type":"text","required":true}
            ]}]
        })
        .to_string(),
    )
    .unwrap();

    assert_eq!(
        data_plane::compile(&compiled).unwrap_err(),
        "data generated field type collides with reserved generated type: ModelCreateField"
    );
}

#[test]
fn operation_guidance_names_the_generated_factory_without_an_app_owned_path() {
    let generated = data_plane::compile(&fixture()).unwrap();
    let documentation = generated["documentation"].as_str().unwrap();
    let typescript = generated["typescript"].as_str().unwrap();
    assert!(documentation.contains("`createOperations(context)`"));
    assert!(documentation.contains("authenticated server-only `DataContext`"));
    assert!(documentation.contains("module path and exported accessor are chosen by the app"));
    assert!(typescript.contains("export function createOperations(context: DataContext)"));
    assert!(!documentation.contains("getDataOperations()"));
    assert!(!documentation.contains("server/data.ts"));
    assert!(!documentation.contains("server/context.ts"));
}

#[test]
fn generated_form_error_guidance_covers_handled_runtime_failures() {
    let generated = data_plane::compile(&fixture()).unwrap();
    let documentation = generated["documentation"].as_str().unwrap();
    for contract in [
        "non-empty, distinct writable field allowlist",
        "matching parser validation failure maps to `invalid_input`",
        "declared unique-field conflict maps to `conflict`",
        "generated `referencedFieldIds` maps to `constraint_violation`",
        "`version_conflict` maps to `conflict`",
        "This record has changed. Reload and try again.",
        "definition supports version preconditions and the failure has no details",
        "legacy definitions and conflicts with details return `undefined`",
        "`authorization_denied` and `forbidden` map to `forbidden`",
        "empty `fieldErrors`",
        "invalid-allowlist failures return `undefined`",
        "raw database diagnostics are never exposed",
    ] {
        assert!(
            documentation.contains(contract),
            "missing contract: {contract}"
        );
    }
}

#[test]
fn schema_admin_guidance_qualifies_both_supported_builders() {
    let generated = data_plane::compile(&fixture()).unwrap();
    let documentation = generated["documentation"].as_str().unwrap();
    assert!(documentation.contains("`helpers.schemaAdmin.dryRunTenantSchemaRevision(input)`"));
    assert!(documentation.contains("`helpers.schemaAdmin.commitTenantSchemaRevision(input)`"));
    assert!(!documentation.contains("and `commitTenantSchemaRevision(input)`"));
}

#[test]
fn generated_work_sessions_are_platform_capabilities() {
    let generated = data_plane::compile(&fixture()).unwrap();
    assert_eq!(generated["manifest"]["capabilities"]["workSessions"], true);
    let documentation = generated["documentation"].as_str().unwrap();
    assert!(documentation.contains("operations.workSessions.request(input)"));
    assert!(documentation.contains("kernel_work_session"));
    assert!(documentation.contains("work: { sessionId }"));
}

#[test]
fn renamed_field_keeps_storage_identity_and_real_read_aliases() {
    let mut compiled = fixture();
    let field = &mut compiled.extras.field_metadata[0];
    field.name = Some("heading".into());
    field.aliases = vec!["oldHeading".into()];
    let generated = data_plane::compile(&compiled).unwrap();
    let fields = generated["manifest"]["models"][0]["fields"]
        .as_array()
        .unwrap();
    let primary = fields
        .iter()
        .find(|field| field["name"] == "heading")
        .unwrap();
    assert_eq!(primary["id"], "name");
    assert_eq!(primary["readOnly"], false);
    for alias in ["name", "oldHeading"] {
        let field = fields.iter().find(|field| field["name"] == alias).unwrap();
        assert_eq!(field["id"], "name");
        assert_eq!(field["readOnly"], true);
        assert_eq!(field["aliasOf"], "heading");
    }
    let mut next = compiled.clone();
    next.extras.field_metadata[0].name = Some("subject".into());
    let error =
        schema_compiler::compile_sql_materialization_plan(Some(&compiled), &next).unwrap_err();
    assert_eq!(error.code, "field_alias_required");
    next.extras.field_metadata[0].aliases.push("heading".into());
    schema_compiler::compile_sql_materialization_plan(Some(&compiled), &next).unwrap();
}

#[test]
fn public_field_aliases_cannot_shadow_existing_or_reserved_fields() {
    for alias in ["unitCost", "id", "__proto__", "bad-name"] {
        let mut compiled = fixture();
        compiled.extras.field_metadata[0].aliases.push(alias.into());
        assert!(data_plane::compile(&compiled).is_err(), "{alias}");
    }
}

#[test]
fn renamed_table_keeps_identity_and_aliases_without_duplicate_models() {
    let mut compiled = fixture();
    compiled.extras.model_metadata[0].name = Some("inventory".into());
    compiled.extras.model_metadata[0].aliases = vec!["oldInventory".into()];
    let generated = data_plane::compile(&compiled).unwrap();
    let models = generated["manifest"]["models"].as_array().unwrap();
    assert_eq!(models.len(), 1);
    assert_eq!(models[0]["id"], "stock_item");
    assert_eq!(models[0]["name"], "inventory");
    assert_eq!(models[0]["aliases"], json!(["oldInventory", "stockItem"]));
    compiled.extras.model_metadata[0].aliases = vec!["apply".into()];
    assert!(data_plane::compile(&compiled)
        .unwrap_err()
        .contains("invalid data model name"));
}
