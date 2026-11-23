use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

use kernel::{
    AppId, ChangeType, ChangeTypeId, CustomerId, EnumOption, EnumOptionId, Field, FieldId,
    FieldType, Model, ModelId, ModelKind, Schema, SchemaVersion,
};
use schema_compiler::data_plane::DataPlanePredecessor;
use schema_compiler::{
    compile_online_sql_transition_plan, compile_sql_artifact_manifest,
    compile_sql_materialization_plan, render_sql_artifact_bundle, Comparison, CompiledManifest,
    ConstraintAuthority, ConstraintExpr, ConstraintManifest, NormalizedManifestExtras,
    RetirementKind, SqlArtifact, SqlArtifactKind, TypedLiteral,
};

fn compiled_schema() -> CompiledManifest {
    CompiledManifest {
        schema: Schema {
            app_id: AppId::from("sql_app"),
            customer_id: CustomerId::from("customer_a"),
            version: SchemaVersion::from("2026-08-04"),
            models: vec![Model {
                id: ModelId::from("company"),
                kind: ModelKind::Entity,
                label: "Company".to_string(),
                fields: vec![
                    Field {
                        id: FieldId::from("name"),
                        label: "Name".to_string(),
                        field_type: FieldType::Text,
                        required: true,
                        is_unique: true,
                        target_model: None,
                        option_set: vec![],
                        ..Default::default()
                    },
                    Field {
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
                                id: EnumOptionId::from("inactive"),
                                label: "Inactive".to_string(),
                                aliases: vec![],
                                ..Default::default()
                            },
                        ],
                        ..Default::default()
                    },
                    Field {
                        id: FieldId::from("parent"),
                        label: "Parent".to_string(),
                        field_type: FieldType::Relation,
                        required: false,
                        is_unique: false,
                        target_model: Some(ModelId::from("company")),
                        option_set: vec![],
                        ..Default::default()
                    },
                ],
                ..Default::default()
            }],
            custom_fields: vec![],
            change_types: vec![ChangeType {
                id: ChangeTypeId::from("company_update"),
                label: "Company Update".to_string(),
                target_model: ModelId::from("company"),
                is_import_default: true,
                touches: vec![FieldId::from("name"), FieldId::from("status")],
                required: vec![FieldId::from("name")],
            }],
        },
        extras: NormalizedManifestExtras {
            model_metadata: vec![],
            field_metadata: vec![],
            inverse_relations: vec![],
            many_relations: vec![],
            constraints: vec![ConstraintManifest {
                id: "company_name_present".to_string(),
                label: "Company name present".to_string(),
                model: "company".to_string(),
                authority: ConstraintAuthority::Authoritative,
                expression: ConstraintExpr::FieldPresent {
                    field: "name".to_string(),
                },
                message: None,
                notes: None,
            }],
            derived_fields: vec![],
            authorization_policy: None,
            seed_change_sets: vec![],
        },
    }
}

#[test]
fn online_plan_binds_the_checked_predecessor_and_only_the_new_optional_text_column() {
    let previous = DataPlanePredecessor {
        artifact_sha256: "1".repeat(64),
        compiled: compiled_schema(),
    };
    let checked_sql = compile_sql_artifact_manifest(&previous.compiled).unwrap();
    let mut candidate = previous.compiled.clone();
    candidate.schema.version = "2026-08-05".into();
    candidate.schema.models[0].fields.push(Field {
        id: "asset_tag".into(),
        label: "Asset Tag".to_string(),
        ..Field::default()
    });
    candidate.schema.change_types[0]
        .touches
        .push("asset_tag".into());

    let (manifest, online) =
        compile_online_sql_transition_plan(&previous, &checked_sql, &candidate).unwrap();
    assert_eq!(
        manifest,
        compile_sql_materialization_plan(Some(&previous.compiled), &candidate).unwrap()
    );
    let online = serde_json::to_value(online.expect("exact optional text addition")).unwrap();
    assert_eq!(online["kind"], "optional-text-addition-v1");
    assert_eq!(
        online["predecessor_artifact_sha256"],
        previous.artifact_sha256
    );
    assert_eq!(
        online["predecessor_schema"],
        serde_json::to_value(&previous.compiled.schema).unwrap()
    );
    assert_eq!(online["model_id"], "company");
    assert_eq!(online["field_id"], "asset_tag");
    assert_eq!(online["table"], "company_version");
    assert_eq!(online["column"], "asset_tag");
    assert_eq!(
        online["constraint"],
        "company_version_asset_tag_record_event_null_check"
    );
    assert_eq!(
        online["constraint_catalog"][0]["constraint_id"],
        "company_name_present"
    );
    assert!(online["authorization_policy"].is_null());

    let mut checked_with_runtime_drift = checked_sql.clone();
    let prior_policy = checked_with_runtime_drift
        .artifacts
        .iter_mut()
        .find(|artifact| artifact.kind == SqlArtifactKind::Policy)
        .expect("predecessor has an installed policy");
    prior_policy.sql.push_str("\n-- changed predecessor policy");
    let (_, online) =
        compile_online_sql_transition_plan(&previous, &checked_with_runtime_drift, &candidate)
            .unwrap();
    assert!(online.is_none());

    candidate.schema.models[0]
        .fields
        .last_mut()
        .unwrap()
        .required = true;
    let error =
        compile_online_sql_transition_plan(&previous, &checked_sql, &candidate).unwrap_err();
    assert_eq!(error.code, "required_field_transition_refused");
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

fn authoritative_constraint(
    id: &str,
    model: &str,
    expression: ConstraintExpr,
) -> ConstraintManifest {
    ConstraintManifest {
        id: id.to_string(),
        label: id.to_string(),
        model: model.to_string(),
        authority: ConstraintAuthority::Authoritative,
        expression,
        message: None,
        notes: None,
    }
}

fn check_artifact<'a>(
    manifest: &'a schema_compiler::SqlArtifactManifest,
    name: &str,
) -> &'a SqlArtifact {
    manifest
        .artifacts
        .iter()
        .find(|artifact| artifact.kind == SqlArtifactKind::CheckConstraint && artifact.name == name)
        .unwrap_or_else(|| panic!("missing generated check artifact {name}"))
}

fn check_artifact_with_sql<'a>(
    manifest: &'a schema_compiler::SqlArtifactManifest,
    fragments: &[&str],
) -> &'a SqlArtifact {
    manifest
        .artifacts
        .iter()
        .find(|artifact| {
            artifact.kind == SqlArtifactKind::CheckConstraint
                && fragments
                    .iter()
                    .all(|fragment| artifact.sql.contains(fragment))
        })
        .unwrap_or_else(|| panic!("missing generated check containing {fragments:?}"))
}

fn decoded_check_expression(artifact: &SqlArtifact) -> String {
    let execute = artifact
        .sql
        .lines()
        .map(str::trim)
        .find_map(|line| line.strip_prefix("execute "))
        .expect("idempotent check contains an execute statement")
        .strip_suffix(';')
        .expect("execute statement ends with a semicolon");
    assert!(execute.starts_with('\'') && execute.ends_with('\''));
    let statement = execute[1..execute.len() - 1].replace("''", "'");
    statement
        .strip_prefix(&format!(
            "alter table \"{}\" add constraint \"{}\" check (",
            artifact.name.split('.').next().unwrap(),
            artifact.name.split('.').nth(1).unwrap()
        ))
        .and_then(|expression| expression.strip_suffix(") not valid"))
        .unwrap_or_else(|| panic!("unexpected generated check statement: {statement}"))
        .to_string()
}

#[test]
fn sql_manifest_and_bundle_are_byte_deterministic() {
    let compiled = compiled_schema();
    let first = compile_sql_artifact_manifest(&compiled).unwrap();
    let second = compile_sql_artifact_manifest(&compiled).unwrap();

    assert_eq!(first, second);
    assert_eq!(
        serde_json::to_vec(&first).unwrap(),
        serde_json::to_vec(&second).unwrap()
    );
    assert_eq!(
        render_sql_artifact_bundle(&first),
        render_sql_artifact_bundle(&second)
    );
    assert!(first.checksum.starts_with("sha256:"));
    assert!(first.source_checksum.starts_with("sha256:"));
    assert!(first.constraint_expression_coverage.implemented);
    assert_eq!(
        first.constraint_expression_coverage.source_items,
        vec!["company_name_present"]
    );
    assert_eq!(
        first.constraint_expression_coverage.implemented_items,
        vec!["company_name_present"]
    );
    assert!(first.constraint_expression_coverage.gaps.is_empty());
    let runtime_functions = first
        .artifacts
        .iter()
        .filter(|artifact| artifact.kind == SqlArtifactKind::Function)
        .collect::<Vec<_>>();
    let runtime_function_names = runtime_functions
        .iter()
        .map(|artifact| artifact.name.as_str())
        .collect::<BTreeSet<_>>();
    assert_eq!(runtime_function_names.len(), runtime_functions.len());
    let active_schema_function = runtime_functions
        .iter()
        .find(|artifact| artifact.name == "kernel_read_active_schema_revision(jsonb)")
        .expect("active schema runtime function is generated");
    assert!(active_schema_function
        .sql
        .contains("'code', 'active_schema_missing'"));
    assert!(runtime_function_names.contains("kernel_canonical_json(jsonb)"));

    let kinds = first
        .artifacts
        .iter()
        .map(|artifact| artifact.kind)
        .collect::<BTreeSet<_>>();
    assert_eq!(
        kinds,
        BTreeSet::from([
            SqlArtifactKind::Sequence,
            SqlArtifactKind::Table,
            SqlArtifactKind::Column,
            SqlArtifactKind::CheckConstraint,
            SqlArtifactKind::ForeignKey,
            SqlArtifactKind::Index,
            SqlArtifactKind::ConstraintCatalog,
            SqlArtifactKind::AuthorizationPolicyCatalog,
            SqlArtifactKind::Policy,
            SqlArtifactKind::Function,
        ])
    );
    let bundle = render_sql_artifact_bundle(&first);
    for expected in [
        "schema_revision",
        "schema_activation_head",
        "change_set",
        "agent_run",
        "company_record",
        "company_version",
        "created_order bigint not null",
        "applied_order bigint",
        "enable row level security",
    ] {
        assert!(
            bundle.contains(expected),
            "missing generated DDL: {expected}"
        );
    }
    let temp_view_preflight = bundle
        .find("pg_catalog.pg_my_temp_schema()")
        .expect("bundle has caller-session temp-view preflight");
    let transaction_start = bundle
        .find("\nbegin;\n")
        .expect("bundle has generated install transaction");
    assert!(
        temp_view_preflight < transaction_start,
        "temp-view cleanup must commit before the generated install transaction"
    );
    let function_start = bundle
        .find("-- artifact: function ")
        .expect("bundle has generated functions");
    let policy_start = bundle
        .find("-- artifact: policy ")
        .expect("bundle has generated policies");
    assert!(
        function_start < policy_start,
        "policy helpers must be installed before policy expressions are parsed"
    );
    let capability_helper = bundle
        .find("-- artifact: function kernel_installer_capability_role(text)")
        .expect("bundle has capability-role helper");
    let principal_helper = bundle
        .find("-- artifact: function kernel_principal_scope_authorized(text,text,text,text)")
        .expect("bundle has principal-scope helper");
    let lookup_policy_bootstrap = bundle
        .find("-- artifact: function kernel_lookup_migration_error(text,text,text)")
        .expect("bundle has lookup migration substrate");
    let seed_policy_bootstrap = bundle
        .find("-- artifact: function kernel_apply_seed_defaults(jsonb)")
        .expect("bundle has seed substrate");
    assert!(capability_helper < principal_helper);
    assert!(principal_helper < lookup_policy_bootstrap);
    assert!(principal_helper < seed_policy_bootstrap);
    for kind in [
        "table",
        "column",
        "check_constraint",
        "index",
        "foreign_key",
    ] {
        let artifact_start = bundle
            .find(&format!("-- artifact: {kind} "))
            .unwrap_or_else(|| panic!("bundle has {kind} artifacts"));
        assert!(
            artifact_start < function_start,
            "{kind} artifacts must be installed before functions"
        );
    }
    for policy in first
        .artifacts
        .iter()
        .filter(|artifact| artifact.kind == SqlArtifactKind::Policy)
    {
        // Rows and authorization share one per-statement scope snapshot.
        let authorization = "where kernel_principal_scope_authorized(''any'', scope.app_id, scope.customer_id, null)";
        assert!(
            policy.sql.contains(authorization),
            "policy {} must authorize the immutable database principal",
            policy.name
        );
    }
    assert!(!bundle.contains("status_enum_check"));
}

#[test]
fn public_runtime_boundaries_clean_persisted_temp_views_without_breaking_query_validation() {
    let manifest = compile_sql_artifact_manifest(&compiled_schema()).unwrap();
    for signature in [
        "kernel_apply_change_set(jsonb)",
        "kernel_read_visible_records(jsonb)",
        "kernel_change_set_diff(jsonb)",
        "kernel_field_history(jsonb)",
        "kernel_prepare_visible_query(jsonb)",
        "kernel_dry_run_tenant_schema_revision(jsonb)",
    ] {
        let artifact = manifest
            .artifacts
            .iter()
            .rev()
            .find(|artifact| artifact.name == signature)
            .unwrap_or_else(|| panic!("generated runtime function {signature}"));
        assert!(
            artifact
                .sql
                .contains("perform kernel_cleanup_generated_visible_query();"),
            "runtime boundary {signature} must clear persisted temp views"
        );
    }
    let dry_run = manifest
        .artifacts
        .iter()
        .find(|artifact| artifact.name == "kernel_dry_run_tenant_schema_revision(jsonb)")
        .expect("generated tenant schema dry-run function");
    assert!(dry_run.sql.contains("language plpgsql"));
    assert!(dry_run
        .sql
        .contains("return kernel_tenant_schema_execute(request, true);"));

    let validator = manifest
        .artifacts
        .iter()
        .find(|artifact| artifact.name == "kernel_validate_visible_query(jsonb)")
        .expect("generated query validator");
    assert!(
        !validator
            .sql
            .contains("perform kernel_cleanup_generated_visible_query();"),
        "validation runs after query-view preparation and must preserve those views"
    );

    let active_schema = manifest
        .artifacts
        .iter()
        .find(|artifact| artifact.name == "kernel_read_active_schema_revision(jsonb)")
        .expect("generated active-schema reader");
    let authorization = active_schema
        .sql
        .find("kernel_authorize_scope(\n    'runtime', request_app_id, request_customer_id, null")
        .expect("active-schema reader authorizes runtime scope");
    let scope_binding = active_schema
        .sql
        .find("set_config('kernel.app_id', request_app_id, true)")
        .expect("active-schema reader binds tenant scope");
    assert!(authorization < scope_binding);
}

#[test]
fn constraint_metadata_is_checksummed_without_changing_lowered_sql() {
    let first_source = compiled_schema();
    let mut second_source = first_source.clone();
    second_source.extras.constraints[0].message = Some("Name is required".to_string());

    let first = compile_sql_artifact_manifest(&first_source).unwrap();
    let second = compile_sql_artifact_manifest(&second_source).unwrap();

    assert_ne!(first.source_checksum, second.source_checksum);
    assert_ne!(first.checksum, second.checksum);
    assert_eq!(first.artifacts, second.artifacts);
    assert!(first.constraint_expression_coverage.implemented);
    assert!(second.constraint_expression_coverage.implemented);
}

#[test]
fn authoritative_constraint_ast_and_typed_literals_have_stable_sql_snapshots() {
    let mut compiled = compiled_schema();
    compiled.schema.models[0].fields.extend([
        field("other_name", FieldType::Text),
        field("amount", FieldType::Number),
        field("enabled", FieldType::Bool),
        field("start_date", FieldType::Date),
        field("observed_at", FieldType::Datetime),
        field("country", FieldType::IsoCountry),
        field("currency", FieldType::IsoCurrency),
        field("aliases", FieldType::TextList),
        field("known_aliases", FieldType::KnownAliases),
        field("rate", FieldType::MoneyRate),
    ]);
    compiled.extras.constraints = vec![
        authoritative_constraint(
            "logic_and",
            "company",
            ConstraintExpr::And {
                expressions: vec![
                    ConstraintExpr::FieldPresent {
                        field: "name".to_string(),
                    },
                    ConstraintExpr::Not {
                        expression: Box::new(ConstraintExpr::FieldAbsent {
                            field: "other_name".to_string(),
                        }),
                    },
                ],
            },
        ),
        authoritative_constraint(
            "logic_or",
            "company",
            ConstraintExpr::Or {
                expressions: vec![
                    ConstraintExpr::FieldAbsent {
                        field: "other_name".to_string(),
                    },
                    ConstraintExpr::FieldPresent {
                        field: "name".to_string(),
                    },
                ],
            },
        ),
        authoritative_constraint(
            "cardinality",
            "company",
            ConstraintExpr::CountPresent {
                fields: vec!["parent".to_string(), "rate".to_string()],
                min: Some(1),
                max: Some(2),
            },
        ),
        authoritative_constraint(
            "compare_fields",
            "company",
            ConstraintExpr::CompareFields {
                left: "name".to_string(),
                op: Comparison::Lt,
                right: "other_name".to_string(),
            },
        ),
        authoritative_constraint(
            "literal_text",
            "company",
            ConstraintExpr::CompareLiteral {
                field: "name".to_string(),
                op: Comparison::Eq,
                value: TypedLiteral::Text("O'Reilly'); drop table company; --".to_string()),
            },
        ),
        authoritative_constraint(
            "literal_number",
            "company",
            ConstraintExpr::CompareLiteral {
                field: "amount".to_string(),
                op: Comparison::Gte,
                value: TypedLiteral::Number("12.50".to_string()),
            },
        ),
        authoritative_constraint(
            "literal_bool",
            "company",
            ConstraintExpr::CompareLiteral {
                field: "enabled".to_string(),
                op: Comparison::NotEq,
                value: TypedLiteral::Bool(false),
            },
        ),
        authoritative_constraint(
            "literal_date",
            "company",
            ConstraintExpr::CompareLiteral {
                field: "start_date".to_string(),
                op: Comparison::Lte,
                value: TypedLiteral::Date("2026-08-04".to_string()),
            },
        ),
        authoritative_constraint(
            "literal_datetime",
            "company",
            ConstraintExpr::CompareLiteral {
                field: "observed_at".to_string(),
                op: Comparison::Gt,
                value: TypedLiteral::Datetime("2026-08-04T12:34:56-04:00".to_string()),
            },
        ),
        authoritative_constraint(
            "literal_enum",
            "company",
            ConstraintExpr::CompareLiteral {
                field: "status".to_string(),
                op: Comparison::Eq,
                value: TypedLiteral::Enum("active".to_string()),
            },
        ),
        authoritative_constraint(
            "literal_country",
            "company",
            ConstraintExpr::CompareLiteral {
                field: "country".to_string(),
                op: Comparison::NotEq,
                value: TypedLiteral::IsoCountry("US".to_string()),
            },
        ),
        authoritative_constraint(
            "literal_currency",
            "company",
            ConstraintExpr::CompareLiteral {
                field: "currency".to_string(),
                op: Comparison::Eq,
                value: TypedLiteral::IsoCurrency("USD".to_string()),
            },
        ),
        authoritative_constraint(
            "field_in",
            "company",
            ConstraintExpr::FieldIn {
                field: "status".to_string(),
                values: vec![
                    TypedLiteral::Enum("active".to_string()),
                    TypedLiteral::Enum("inactive".to_string()),
                ],
            },
        ),
        authoritative_constraint(
            "set_contains",
            "company",
            ConstraintExpr::FieldSetContains {
                field: "aliases".to_string(),
                value: "O'Reilly".to_string(),
            },
        ),
        authoritative_constraint(
            "known_alias_contains",
            "company",
            ConstraintExpr::FieldSetContains {
                field: "known_aliases".to_string(),
                value: "Acme".to_string(),
            },
        ),
        authoritative_constraint(
            "text_length",
            "company",
            ConstraintExpr::TextLength {
                field: "name".to_string(),
                min: Some(1),
                max: Some(120),
            },
        ),
        authoritative_constraint(
            "text_starts_with",
            "company",
            ConstraintExpr::TextStartsWith {
                field: "name".to_string(),
                value: "PO-%_O'Reilly".to_string(),
            },
        ),
    ];

    let manifest = compile_sql_artifact_manifest(&compiled).unwrap();
    assert!(manifest.constraint_expression_coverage.implemented);
    assert_eq!(
        manifest.constraint_expression_coverage.implemented_items,
        compiled
            .extras
            .constraints
            .iter()
            .map(|constraint| constraint.id.clone())
            .collect::<Vec<_>>()
    );
    assert!(manifest.constraint_expression_coverage.gaps.is_empty());

    let expression = |id: &str| {
        decoded_check_expression(check_artifact(
            &manifest,
            &format!("company_version.company_version_{id}_constraint_check"),
        ))
    };
    assert_eq!(
        expression("logic_and"),
        "tombstones_record or untombstones_record or ((((\"name\" is not null) and (not ((\"other_name\" is null))))) is true)"
    );
    assert_eq!(
        expression("logic_or"),
        "tombstones_record or untombstones_record or ((((\"other_name\" is null) or (\"name\" is not null))) is true)"
    );
    assert_eq!(
        expression("compare_fields"),
        "tombstones_record or untombstones_record or (((\"name\" < \"other_name\")) is true)"
    );
    assert_eq!(
        expression("literal_text"),
        "tombstones_record or untombstones_record or (((\"name\" = 'O''Reilly''); drop table company; --'::text)) is true)"
    );
    assert_eq!(
        expression("literal_number"),
        "tombstones_record or untombstones_record or (((\"amount\" >= '12.50'::numeric)) is true)"
    );
    assert_eq!(
        expression("literal_bool"),
        "tombstones_record or untombstones_record or (((\"enabled\" <> false::boolean)) is true)"
    );
    assert_eq!(
        expression("literal_date"),
        "tombstones_record or untombstones_record or (((\"start_date\" <= '2026-08-04'::date)) is true)"
    );
    assert_eq!(
        expression("literal_datetime"),
        "tombstones_record or untombstones_record or (((\"observed_at\" > '2026-08-04T12:34:56-04:00'::timestamptz)) is true)"
    );
    assert_eq!(
        expression("literal_enum"),
        "tombstones_record or untombstones_record or (((\"status\" = 'active'::text)) is true)"
    );
    assert_eq!(
        expression("literal_country"),
        "tombstones_record or untombstones_record or (((\"country\" <> 'US'::text)) is true)"
    );
    assert_eq!(
        expression("literal_currency"),
        "tombstones_record or untombstones_record or (((\"currency\" = 'USD'::text)) is true)"
    );
    assert_eq!(
        expression("field_in"),
        "tombstones_record or untombstones_record or (((\"status\" in ('active'::text, 'inactive'::text))) is true)"
    );
    assert_eq!(
        expression("set_contains"),
        "tombstones_record or untombstones_record or ((('O''Reilly'::text = any (\"aliases\"))) is true)"
    );
    assert_eq!(
        expression("known_alias_contains"),
        "tombstones_record or untombstones_record or ((('Acme'::text = any (\"known_aliases\"))) is true)"
    );
    assert_eq!(
        expression("text_length"),
        "tombstones_record or untombstones_record or ((((char_length(\"name\")::numeric >= 1) and (char_length(\"name\")::numeric <= 120))) is true)"
    );
    assert_eq!(
        expression("text_starts_with"),
        "tombstones_record or untombstones_record or (((left(\"name\" collate \"C\", char_length('PO-%_O''Reilly')) = 'PO-%_O''Reilly' collate \"C\")) is true)"
    );
    let cardinality = expression("cardinality");
    assert!(cardinality.contains("case when (\"parent\" is not null) then 1 else 0 end"));
    assert!(cardinality.contains(
        "case when (\"rate_amount\" is not null and \"rate_currency\" is not null and \"rate_period\" is not null) then 1 else 0 end"
    ));
    assert_eq!(
        cardinality,
        "tombstones_record or untombstones_record or (((((case when (\"parent\" is not null) then 1 else 0 end + case when (\"rate_amount\" is not null and \"rate_currency\" is not null and \"rate_period\" is not null) then 1 else 0 end) >= 1) and ((case when (\"parent\" is not null) then 1 else 0 end + case when (\"rate_amount\" is not null and \"rate_currency\" is not null and \"rate_period\" is not null) then 1 else 0 end) <= 2))) is true)"
    );
}

#[test]
fn hc_org_assignment_cardinality_constraints_have_stable_sql_snapshots() {
    let relation = |id: &str, target: &str| Field {
        target_model: Some(ModelId::from(target)),
        ..field(id, FieldType::Relation)
    };
    let model = |id: &str| Model {
        id: ModelId::from(id),
        kind: ModelKind::Entity,
        label: id.to_string(),
        fields: vec![field("name", FieldType::Text)],
        ..Default::default()
    };
    let compiled = CompiledManifest {
        schema: Schema {
            app_id: AppId::from("hc"),
            customer_id: CustomerId::from("base"),
            version: SchemaVersion::from("2026-08-04"),
            models: vec![
                model("employee"),
                model("position"),
                Model {
                    id: ModelId::from("org_assignment"),
                    kind: ModelKind::Entity,
                    label: "Org assignment".to_string(),
                    fields: vec![
                        relation("employee", "employee"),
                        relation("position", "position"),
                        relation("reports_to_employee", "employee"),
                        relation("reports_to_position", "position"),
                        Field {
                            required: true,
                            ..field("start_date", FieldType::Date)
                        },
                    ],
                    ..Default::default()
                },
            ],
            custom_fields: vec![],
            change_types: vec![],
        },
        extras: NormalizedManifestExtras {
            model_metadata: vec![],
            field_metadata: vec![],
            inverse_relations: vec![],
            many_relations: vec![],
            constraints: vec![
                authoritative_constraint(
                    "assignment_has_occupancy",
                    "org_assignment",
                    ConstraintExpr::CountPresent {
                        fields: vec!["employee".to_string(), "position".to_string()],
                        min: Some(1),
                        max: None,
                    },
                ),
                authoritative_constraint(
                    "assignment_has_at_most_one_manager",
                    "org_assignment",
                    ConstraintExpr::CountPresent {
                        fields: vec![
                            "reports_to_employee".to_string(),
                            "reports_to_position".to_string(),
                        ],
                        min: None,
                        max: Some(1),
                    },
                ),
            ],
            derived_fields: vec![],
            authorization_policy: None,
            seed_change_sets: vec![],
        },
    };

    let manifest = compile_sql_artifact_manifest(&compiled).unwrap();
    assert_eq!(
        decoded_check_expression(check_artifact(
            &manifest,
            "org_assignment_version.org_assignment_version_start_date_required_check",
        )),
        "stage <> 'mainline' or effective_end is not null or tombstones_record or untombstones_record or \"start_date\" is not null"
    );
    assert_eq!(
        decoded_check_expression(check_artifact_with_sql(
            &manifest,
            &["case when", "employee", "position", ">= 1"],
        )),
        "tombstones_record or untombstones_record or (((((case when (\"employee\" is not null) then 1 else 0 end + case when (\"position\" is not null) then 1 else 0 end) >= 1))) is true)"
    );
    assert_eq!(
        decoded_check_expression(check_artifact_with_sql(
            &manifest,
            &["case when", "reports_to_employee", "reports_to_position", "<= 1"],
        )),
        "tombstones_record or untombstones_record or (((((case when (\"reports_to_employee\" is not null) then 1 else 0 end + case when (\"reports_to_position\" is not null) then 1 else 0 end) <= 1))) is true)"
    );
}

#[test]
fn advisory_constraints_are_explicit_gaps_and_do_not_emit_checks() {
    let mut compiled = compiled_schema();
    compiled.extras.constraints.push(ConstraintManifest {
        id: "company_name_hint".to_string(),
        label: "Company name hint".to_string(),
        model: "company".to_string(),
        authority: ConstraintAuthority::Advisory,
        expression: ConstraintExpr::TextLength {
            field: "name".to_string(),
            min: Some(10),
            max: None,
        },
        message: Some("Use a descriptive name".to_string()),
        notes: None,
    });

    let manifest = compile_sql_artifact_manifest(&compiled).unwrap();
    assert!(!manifest.constraint_expression_coverage.implemented);
    assert_eq!(
        manifest.constraint_expression_coverage.implemented_items,
        vec!["company_name_present"]
    );
    assert_eq!(
        manifest
            .constraint_expression_coverage
            .gaps
            .get("company_name_hint")
            .map(String::as_str),
        Some(
            "advisory constraint requires generated runtime evaluation and is not a persistence check"
        )
    );
    assert!(!manifest
        .artifacts
        .iter()
        .any(|artifact| artifact.name.contains("company_name_hint")));
}

#[test]
fn authoritative_constraint_lowering_fails_closed_with_structured_errors() {
    struct Case {
        id: &'static str,
        field: Option<Field>,
        expression: ConstraintExpr,
        code: &'static str,
        path_suffix: &'static str,
    }

    let cases = vec![
        Case {
            id: "money_compare",
            field: Some(field("rate", FieldType::MoneyRate)),
            expression: ConstraintExpr::CompareFields {
                left: "rate".to_string(),
                op: Comparison::Eq,
                right: "rate".to_string(),
            },
            code: "unsupported_constraint_comparison",
            path_suffix: ".expression",
        },
        Case {
            id: "bool_order",
            field: Some(field("enabled", FieldType::Bool)),
            expression: ConstraintExpr::CompareLiteral {
                field: "enabled".to_string(),
                op: Comparison::Lt,
                value: TypedLiteral::Bool(true),
            },
            code: "unsupported_constraint_comparison",
            path_suffix: ".expression",
        },
        Case {
            id: "wrong_literal_type",
            field: None,
            expression: ConstraintExpr::CompareLiteral {
                field: "name".to_string(),
                op: Comparison::Eq,
                value: TypedLiteral::Number("1".to_string()),
            },
            code: "constraint_literal_type_mismatch",
            path_suffix: ".expression.value",
        },
        Case {
            id: "invalid_number",
            field: Some(field("amount", FieldType::Number)),
            expression: ConstraintExpr::CompareLiteral {
                field: "amount".to_string(),
                op: Comparison::Eq,
                value: TypedLiteral::Number("1); drop table company".to_string()),
            },
            code: "invalid_constraint_literal",
            path_suffix: ".expression.value",
        },
        Case {
            id: "invalid_country",
            field: Some(field("country", FieldType::IsoCountry)),
            expression: ConstraintExpr::CompareLiteral {
                field: "country".to_string(),
                op: Comparison::Eq,
                value: TypedLiteral::IsoCountry("ZZ".to_string()),
            },
            code: "invalid_constraint_literal",
            path_suffix: ".expression.value",
        },
        Case {
            id: "set_on_scalar",
            field: None,
            expression: ConstraintExpr::FieldSetContains {
                field: "name".to_string(),
                value: "Acme".to_string(),
            },
            code: "unsupported_constraint_field_type",
            path_suffix: ".expression.field",
        },
    ];

    for case in cases {
        let mut compiled = compiled_schema();
        if let Some(field) = case.field {
            compiled.schema.models[0].fields.push(field);
        }
        compiled.extras.constraints = vec![authoritative_constraint(
            case.id,
            "company",
            case.expression,
        )];

        let error = compile_sql_artifact_manifest(&compiled).unwrap_err();
        assert_eq!(error.code, case.code, "case {}", case.id);
        assert_eq!(
            error.path,
            format!("constraints.{}{}", case.id, case.path_suffix),
            "case {}",
            case.id
        );
    }
}

#[test]
fn constraint_identifiers_cannot_inject_sql() {
    let mut compiled = compiled_schema();
    compiled.extras.constraints[0].id = "bad'); drop table company; --".to_string();

    let error = compile_sql_artifact_manifest(&compiled).unwrap_err();
    assert_eq!(error.code, "invalid_identifier_character");
    assert_eq!(error.path, "constraints.bad'); drop table company; --.id");
}

#[test]
fn removals_are_retired_without_destructive_sql_or_activation() {
    let previous = compiled_schema();
    let mut next = previous.clone();
    next.schema.version = SchemaVersion::from("2026-08-05");
    next.schema.models[0].fields.remove(2);
    next.schema.models[0].fields[1].option_set.remove(1);

    let plan = compile_sql_materialization_plan(Some(&previous), &next).unwrap();
    assert!(plan.retirements.iter().any(|retirement| {
        retirement.kind == RetirementKind::Field && retirement.element == "parent"
    }));
    assert!(plan.retirements.iter().any(|retirement| {
        retirement.kind == RetirementKind::EnumOption && retirement.element == "inactive"
    }));

    let materialization_sql = plan
        .artifacts
        .iter()
        .filter(|artifact| artifact.kind != SqlArtifactKind::Function)
        .map(|artifact| artifact.sql.clone())
        .collect::<Vec<_>>()
        .join("\n")
        .to_ascii_lowercase();
    for forbidden in [
        "drop table",
        "drop column",
        "drop type",
        "delete from",
        "insert into schema_revision",
        "update schema_revision",
    ] {
        assert!(
            !materialization_sql.contains(forbidden),
            "found forbidden SQL: {forbidden}"
        );
    }
    let bundle = render_sql_artifact_bundle(&plan);
    assert!(bundle.contains("add column if not exists"));
    assert!(bundle.contains("not valid"));
}

#[test]
fn physical_type_changes_are_refused_with_a_new_field_alternative() {
    let previous = compiled_schema();
    let mut next = previous.clone();
    next.schema.version = SchemaVersion::from("2026-08-05");
    next.schema.models[0].fields[0].field_type = FieldType::Number;

    let error = compile_sql_materialization_plan(Some(&previous), &next).unwrap_err();
    assert_eq!(error.code, "typed_migration_required");
    assert!(error
        .message
        .to_lowercase()
        .contains("field types are immutable"));
    assert!(error.message.contains("then archive the old field"));
    assert!(error.message.to_lowercase().contains("add a new field"));
}

#[test]
fn coverage_metadata_matches_every_current_facade_operation() {
    let manifest = compile_sql_artifact_manifest(&compiled_schema()).unwrap();
    let covered = manifest
        .runtime_api_capabilities
        .iter()
        .map(|capability| capability.operation.as_str())
        .collect::<BTreeSet<_>>();

    let facade = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../kernel/src/facade.rs"),
    )
    .unwrap();
    let declared = facade
        .lines()
        .filter_map(|line| line.trim_start().strip_prefix("pub fn "))
        .filter_map(|suffix| {
            suffix
                .split(['(', '<'])
                .next()
                .filter(|name| !name.is_empty())
        })
        .collect::<BTreeSet<_>>();

    let compiler_only_operations = BTreeSet::from([
        "data_query",
        "work_session",
        "draft_threads",
        "apply_seed_defaults",
        "commit_tenant_schema_revision",
        "dry_run_tenant_schema_revision",
        "lookup_hydrate",
        "lookup_list",
        "lookup_reference_count",
        "lookup_resolve_batch",
        "lookup_set_availability",
        "lookup_transfer_alias",
        "read_runtime_release_observability",
    ]);
    assert_eq!(
        covered,
        declared
            .into_iter()
            .chain(compiler_only_operations)
            .collect()
    );
    for capability in &manifest.runtime_api_capabilities {
        let expected_emitted = !capability.sql_signatures.is_empty()
            && capability.sql_signatures.iter().all(|signature| {
                manifest.artifacts.iter().any(|artifact| {
                    artifact.kind == SqlArtifactKind::Function && artifact.name == *signature
                })
            });
        assert_eq!(capability.function_emitted, expected_emitted);
        assert!(capability.behavioral_parity);
        assert!(capability.implemented);
        assert!(capability.gap.is_none());
    }
}

#[test]
fn legacy_enum_mutation_authority_is_superseded_by_tenant_schema_revision() {
    let manifest = compile_sql_artifact_manifest(&compiled_schema()).unwrap();
    assert!(manifest.artifacts.iter().all(|artifact| {
        artifact.name != "kernel_commit_enum_option_set_revision(jsonb)"
            && !artifact
                .sql
                .contains("kernel_commit_enum_option_set_revision")
    }));
    let legacy_capability = manifest
        .runtime_api_capabilities
        .iter()
        .find(|capability| capability.operation == "commit_enum_option_set_revision")
        .expect("legacy facade operation remains represented for migration coverage");
    assert_eq!(
        legacy_capability.sql_signatures,
        vec!["kernel_commit_tenant_schema_revision(jsonb)"]
    );
    assert!(legacy_capability.function_emitted);
}

#[test]
fn legacy_activation_head_repair_is_superseded_by_transactional_policy_artifact() {
    let manifest = compile_sql_artifact_manifest(&compiled_schema()).unwrap();
    let capability = manifest
        .runtime_api_capabilities
        .iter()
        .find(|capability| capability.operation == "ensure_schema_activation_head_policy")
        .expect("legacy activation-head repair remains represented for migration coverage");
    assert!(capability.sql_signatures.is_empty());
    assert!(!capability.function_emitted);
    assert!(manifest.artifacts.iter().any(|artifact| {
        artifact.kind == SqlArtifactKind::Policy
            && artifact.name == "schema_activation_head.kernel_tenant_isolation"
    }));

    let bundle = render_sql_artifact_bundle(&manifest);
    let transaction_start = bundle
        .find("\nbegin;\n")
        .expect("generated bundle begins one installation transaction");
    let activation_head_policy = bundle
        .find("-- artifact: policy schema_activation_head.kernel_tenant_isolation")
        .expect("generated bundle contains the canonical activation-head policy");
    assert!(transaction_start < activation_head_policy);
    assert!(bundle.ends_with("commit;\n"));
}

#[test]
fn cue_cli_emits_sql_manifest_and_executable_bundle_targets() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let inputs = [
        root.join("packages/schema-compiler/cue/app-manifest.cue"),
        root.join("docs/examples/schema-compiler/company.cue"),
    ];

    let manifest_output = Command::new(env!("CARGO_BIN_EXE_schema-compiler"))
        .arg("--sql-manifest")
        .args(&inputs)
        .output()
        .expect("run SQL manifest compiler target");
    assert!(
        manifest_output.status.success(),
        "SQL manifest compilation failed: {}",
        String::from_utf8_lossy(&manifest_output.stderr)
    );
    let manifest: schema_compiler::SqlArtifactManifest =
        serde_json::from_slice(&manifest_output.stdout).expect("SQL manifest is JSON");
    assert_eq!(manifest.app_id, "company_directory");
    assert!(manifest.checksum.starts_with("sha256:"));

    let bundle_output = Command::new(env!("CARGO_BIN_EXE_schema-compiler"))
        .arg("--sql-bundle")
        .args(&inputs)
        .output()
        .expect("run SQL bundle compiler target");
    assert!(
        bundle_output.status.success(),
        "SQL bundle compilation failed: {}",
        String::from_utf8_lossy(&bundle_output.stderr)
    );
    let bundle = String::from_utf8(bundle_output.stdout).expect("SQL bundle is UTF-8");
    assert!(bundle.starts_with("-- Kernel non-destructive generated SQL plan"));
    assert!(bundle.contains("create table if not exists \"company_version\""));
    assert!(!bundle.to_ascii_lowercase().contains("drop column"));
}

#[test]
fn cue_cli_rejects_multiple_output_targets() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = Command::new(env!("CARGO_BIN_EXE_schema-compiler"))
        .args(["--app-artifact", "--sql-bundle"])
        .arg(root.join("packages/schema-compiler/cue/app-manifest.cue"))
        .arg(root.join("docs/examples/schema-compiler/company.cue"))
        .output()
        .expect("run compiler with conflicting output targets");

    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("Usage:"));
}

#[test]
fn historical_contract_refuses_readding_archived_field() {
    let mut original = compiled_schema();
    original.schema.models[0].fields[0].required = false;
    let mut retired = original.clone();
    retired.schema.version = SchemaVersion::from("retired");
    retired.schema.models[0].fields.remove(0);
    let mut reintroduced = original.clone();
    reintroduced.schema.version = SchemaVersion::from("reintroduced");
    reintroduced.schema.models[0].fields[0].field_type = FieldType::Number;
    let error =
        schema_compiler::compile_schema_transition_contract(&[original, retired], &reintroduced)
            .unwrap_err();
    assert_eq!(error.code, "archived_field");
    assert!(error.message.contains("was archived"));
}

#[test]
fn new_required_fields_are_refused_but_existing_fields_can_be_required() {
    let previous = compiled_schema();
    let mut next = previous.clone();
    next.schema.models[0].fields.push(Field {
        id: FieldId::from("mandatory"),
        label: "Mandatory".into(),
        required: true,
        ..Field::default()
    });
    let error = compile_sql_materialization_plan(Some(&previous), &next).unwrap_err();
    assert_eq!(error.code, "required_field_transition_refused");
    assert!(error.message.contains("optional field"));
    next.schema.models[0].fields.pop();
    next.schema.models[0]
        .fields
        .iter_mut()
        .find(|field| !field.required)
        .unwrap()
        .required = true;
    compile_sql_materialization_plan(Some(&previous), &next)
        .expect("existing data is checked during materialization");
}

#[test]
fn persisted_model_storage_kind_is_immutable() {
    let previous = compiled_schema();
    let mut next = previous.clone();
    next.schema.models[0].kind = ModelKind::Lookup;
    next.schema.models[0].display_field_id = Some(FieldId::from("name"));
    let error = compile_sql_materialization_plan(Some(&previous), &next).unwrap_err();
    assert_eq!(error.code, "model_kind_change_refused");
}

#[test]
fn history_refuses_required_field_reintroduction_and_preserves_aliases() {
    let initial = compiled_schema();
    let mut absent = initial.clone();
    absent.schema.version = "archived".into();
    absent.schema.models[0].fields.clear();
    let mut restored = initial.clone();
    restored.schema.version = "restored".into();
    restored.schema.models[0].fields[0].required = true;
    assert_eq!(
        schema_compiler::compile_schema_transition_contract(&[initial.clone(), absent], &restored)
            .unwrap_err()
            .code,
        "archived_field"
    );
    let mut renamed = initial.clone();
    renamed
        .extras
        .model_metadata
        .push(schema_compiler::ModelMetadata {
            model: renamed.schema.models[0].id.to_string(),
            name: Some("renamed".into()),
            aliases: vec![],
            notes: None,
            field_groups: vec![],
        });
    let mut renamed_again = renamed.clone();
    renamed_again.extras.model_metadata.last_mut().unwrap().name = Some("again".into());
    assert_eq!(
        schema_compiler::compile_schema_transition_contract(&[renamed.clone()], &renamed_again)
            .unwrap_err()
            .code,
        "model_alias_required"
    );
    renamed_again
        .extras
        .model_metadata
        .last_mut()
        .unwrap()
        .aliases
        .push("renamed".into());
    schema_compiler::compile_schema_transition_contract(&[renamed], &renamed_again).unwrap();
}

#[test]
fn choice_rename_requires_retaining_old_names_and_aliases() {
    let previous = schema_compiler::compile_manifest_json(&serde_json::json!({
        "app_id": "choices", "customer_id": "tenant", "version": "v1",
        "models": [{"id": "item", "label": "Item", "kind": "entity", "fields": [
            {"id": "state", "label": "State", "type": "enum", "option_set": [{"id": "open", "label": "Open"}]}
        ]}]
    }).to_string()).unwrap();
    let mut next = previous.clone();
    next.schema.models[0].fields[0].option_set[0].label = "Ready".into();
    assert_eq!(
        schema_compiler::compile_schema_transition_contract(&[previous.clone()], &next)
            .unwrap_err()
            .code,
        "option_alias_required"
    );
    next.schema.models[0].fields[0].option_set[0]
        .aliases
        .push("Open".into());
    schema_compiler::compile_schema_transition_contract(&[previous], &next).unwrap();
}

#[test]
fn archived_generated_public_names_cannot_be_reused() {
    let initial = schema_compiler::compile_manifest_json(
        &serde_json::json!({
            "app_id":"names", "customer_id":"tenant", "version":"v1",
            "models":[{"id":"sales_contact", "label":"Contact", "kind":"entity", "fields":[
                {"id":"full_name", "label":"Name", "type":"text"},
                {"id":"code", "label":"Code", "type":"text"}
            ]}]
        })
        .to_string(),
    )
    .unwrap();
    let mut archived = initial.clone();
    archived.schema.models[0].fields.remove(0);
    let mut candidate = archived.clone();
    candidate.schema.models[0].fields.push(Field {
        id: "fullName".into(),
        label: "Replacement".into(),
        ..Field::default()
    });
    assert_eq!(
        schema_compiler::compile_schema_transition_contract(
            &[initial.clone(), archived.clone()],
            &candidate
        )
        .unwrap_err()
        .code,
        "archived_field"
    );
    archived.schema.models.clear();
    candidate.schema.models[0].id = "salesContact".into();
    candidate.schema.models[0].label = "Replacement".into();
    assert_eq!(
        schema_compiler::compile_schema_transition_contract(&[initial, archived], &candidate)
            .unwrap_err()
            .code,
        "archived_table"
    );
}
