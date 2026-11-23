use kernel::{
    AppId, CustomerId, EntityExtensionCapabilities, Field, FieldId, FieldType, Model, ModelId,
    ModelKind, RecordMetadataLimits, Schema, SchemaVersion,
};
use schema_compiler::{
    compile_sql_materialization_plan, CompiledManifest, NormalizedManifestExtras, SqlArtifactKind,
};

#[test]
fn lookup_models_use_the_generic_substrate_and_entities_get_metadata_storage() {
    let lookup = Model {
        id: ModelId::from("department"),
        kind: ModelKind::Lookup,
        label: "Department".to_string(),
        display_field_id: Some(FieldId::from("name")),
        fields: vec![Field {
            id: FieldId::from("name"),
            label: "Name".to_string(),
            field_type: FieldType::Text,
            required: true,
            ..Field::default()
        }],
        ..Model::default()
    };
    let entity = Model {
        id: ModelId::from("employee"),
        kind: ModelKind::Entity,
        label: "Employee".to_string(),
        extensions: EntityExtensionCapabilities {
            record_metadata: Some(RecordMetadataLimits {
                max_bytes: 2048,
                max_depth: 3,
                max_keys: 16,
                max_key_bytes: 64,
                max_scalar_bytes: 512,
                max_array_items: 16,
            }),
            ..EntityExtensionCapabilities::default()
        },
        fields: vec![Field {
            id: FieldId::from("department"),
            label: "Department".to_string(),
            field_type: FieldType::Relation,
            target_model: Some(ModelId::from("department")),
            ..Field::default()
        }],
        ..Model::default()
    };
    let compiled = CompiledManifest {
        schema: Schema {
            app_id: AppId::from("lookup_test"),
            customer_id: CustomerId::from("tenant_a"),
            version: SchemaVersion::from("2026-08-05"),
            models: vec![lookup, entity],
            custom_fields: vec![],
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
    };

    let plan = compile_sql_materialization_plan(None, &compiled).unwrap();
    let lookup_version = plan
        .artifacts
        .iter()
        .find(|artifact| {
            artifact.kind == SqlArtifactKind::Table && artifact.name == "lookup_version"
        })
        .expect("generic lookup version table");
    assert!(lookup_version
        .sql
        .contains("primary key (app_id, customer_id, model_id, id)"));
    for table in ["lookup_version", "employee_version"] {
        let artifact = plan
            .artifacts
            .iter()
            .find(|artifact| {
                artifact.kind == SqlArtifactKind::Column
                    && artifact.name == format!("{table}.metadata")
            })
            .unwrap_or_else(|| panic!("legacy metadata compatibility column `{table}.metadata`"));
        assert_eq!(
            artifact.sql,
            if table == "lookup_version" {
                "alter table lookup_version add column if not exists metadata jsonb not null default '{}'"
                    .to_string()
            } else {
                format!(
                    "alter table \"{table}\" add column if not exists metadata jsonb not null default '{{}}'"
                )
            }
        );
    }
    for (table, primary_key) in [
        (
            "lookup_value_projection",
            "primary key (app_id, customer_id, model_id, version_id, field_id)",
        ),
        (
            "lookup_alias_projection",
            "primary key (app_id, customer_id, model_id, version_id, field_id, kind, ordinal)",
        ),
        (
            "lookup_relation_projection",
            "primary key (app_id, customer_id, source_model_id, version_id, field_id, ordinal)",
        ),
    ] {
        let artifact = plan
            .artifacts
            .iter()
            .find(|artifact| artifact.kind == SqlArtifactKind::Table && artifact.name == table)
            .unwrap_or_else(|| panic!("generic lookup projection table `{table}`"));
        assert!(
            artifact.sql.contains(primary_key),
            "`{table}` does not use the model-qualified projection identity"
        );
    }
    for (name, columns) in [
        (
            "lookup_value_projection.lookup_value_projection_version_fk",
            "foreign key (\"app_id\", \"customer_id\", \"model_id\", \"version_id\")",
        ),
        (
            "lookup_alias_projection.lookup_alias_projection_version_fk",
            "foreign key (\"app_id\", \"customer_id\", \"model_id\", \"version_id\")",
        ),
        (
            "lookup_relation_projection.lookup_relation_projection_version_fk",
            "foreign key (\"app_id\", \"customer_id\", \"source_model_id\", \"version_id\")",
        ),
    ] {
        let artifact = plan
            .artifacts
            .iter()
            .find(|artifact| artifact.kind == SqlArtifactKind::ForeignKey && artifact.name == name)
            .unwrap_or_else(|| panic!("generic lookup projection foreign key `{name}`"));
        assert!(artifact.sql.contains(columns));
        assert!(artifact.sql.contains(
            "references \"lookup_version\" (\"app_id\", \"customer_id\", \"model_id\", \"id\")"
        ));
    }
    assert!(!plan.artifacts.iter().any(|artifact| {
        artifact.kind == SqlArtifactKind::Table
            && matches!(
                artifact.name.as_str(),
                "department_record" | "department_version"
            )
    }));
    assert!(plan.artifacts.iter().any(|artifact| {
        artifact.kind == SqlArtifactKind::Table
            && artifact.name == "employee_version"
            && artifact
                .sql
                .contains("metadata jsonb not null default '{}'")
    }));
    assert!(plan.artifacts.iter().any(|artifact| {
        artifact.kind == SqlArtifactKind::ForeignKey
            && artifact.name.starts_with("employee_version.")
            && artifact.sql.contains("references \"lookup_record\"")
            && artifact.sql.contains("\"department_target_model\"")
    }));
    for signature in [
        "kernel_apply_metadata_patch(jsonb,jsonb,jsonb,text)",
        "kernel_lookup_list(jsonb)",
        "kernel_lookup_resolve_batch(jsonb)",
    ] {
        assert!(plan.artifacts.iter().any(|artifact| {
            artifact.kind == SqlArtifactKind::Function && artifact.name == signature
        }));
    }
}
