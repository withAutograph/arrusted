use std::fs;
use std::path::PathBuf;
use std::process::Command;

use schema_compiler::{CompiledAppArtifact, CompiledManifest};

#[test]
fn cue_example_compiles_to_normalized_schema_and_extras() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = Command::new(env!("CARGO_BIN_EXE_schema-compiler"))
        .arg(root.join("packages/schema-compiler/cue/app-manifest.cue"))
        .arg(root.join("docs/examples/schema-compiler/company.cue"))
        .output()
        .expect("run schema-compiler CUE frontend");

    assert!(
        output.status.success(),
        "CUE frontend failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let compiled: CompiledManifest =
        serde_json::from_slice(&output.stdout).expect("deserialize normalized compiler output");

    assert_eq!(
        compiled
            .schema
            .models
            .iter()
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>(),
        vec!["company", "employee", "region"]
    );
    assert_eq!(compiled.extras.constraints.len(), 1);
    assert_eq!(compiled.extras.derived_fields.len(), 1);
    assert_eq!(compiled.extras.seed_change_sets.len(), 1);
}

#[test]
fn cue_authorization_metadata_compiles_to_normalized_policy() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let source = r#"package schema

manifest: #AppManifest & {
  app_id: "cue_authorization_fixture"
  customer_id: "base"
  version: "cue-v1"
  models: [
    {
      id: "work_item"
      kind: "entity"
      label: "Work item"
      fields: [{id: "owner", label: "Owner", type: "text", required: true}]
    },
  ]
  authorization: {
    roles: [{id: "reviewer"}]
    grants: [{
      role: "reviewer"
      model: "work_item"
      operations: ["read"]
      read_fields: ["$id", "owner"]
      record: {kind: "actor_equals_field", field: "owner"}
    }]
  }
}
"#;
    let temporary_path = std::env::temp_dir().join(format!(
        "schema-cue-authorization-{}.cue",
        std::process::id()
    ));
    fs::write(&temporary_path, source).expect("write authorization CUE fixture");
    let output = Command::new(env!("CARGO_BIN_EXE_schema-compiler"))
        .arg(root.join("packages/schema-compiler/cue/app-manifest.cue"))
        .arg(&temporary_path)
        .output()
        .expect("run authorization CUE frontend");
    let _ = fs::remove_file(&temporary_path);
    assert!(
        output.status.success(),
        "authorization CUE frontend failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let compiled: CompiledManifest =
        serde_json::from_slice(&output.stdout).expect("deserialize authorization policy");
    let policy = compiled
        .extras
        .authorization_policy
        .expect("normalized authorization policy");
    assert_eq!(policy.grants[0].read_fields, vec!["$id", "owner"]);
}

#[test]
fn vendor_catalog_selection_compiles_to_ordered_schema_and_seed_templates() {
    let root = repository_root();
    let output = vendor_compiler_command(&root)
        .arg("--app-artifact")
        .args(vendor_inputs(
            &root,
            root.join("packages/schema-compiler/tests/fixtures/catalog-selection/selection.cue"),
        ))
        .output()
        .expect("run Vendor CUE compiler");

    assert!(
        output.status.success(),
        "Vendor CUE frontend failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let artifact: CompiledAppArtifact =
        serde_json::from_slice(&output.stdout).expect("deserialize Vendor artifact");
    assert_eq!(
        artifact
            .schema
            .models
            .iter()
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>(),
        vec![
            "vendor",
            "vendor_spend_transaction",
            "vendor_settings",
            "vendor_identity_mapping",
            "vendor_review_resolution",
            "employee",
            "department",
            "chart_account",
        ]
    );
    assert_eq!(artifact.extras.seed_change_sets.len(), 1);
    let employee_metadata = artifact
        .extras
        .model_metadata
        .iter()
        .find(|metadata| metadata.model == "employee")
        .expect("Employee presentation metadata");
    assert_eq!(
        employee_metadata
            .field_groups
            .iter()
            .map(|group| group.id.as_str())
            .collect::<Vec<_>>(),
        vec!["summary", "personal"]
    );
    assert_eq!(
        employee_metadata.field_groups[0].fields,
        vec!["ref", "name", "known_aliases"]
    );
    assert_eq!(employee_metadata.field_groups[1].fields, vec!["work_email"]);
    assert!(artifact
        .extras
        .model_metadata
        .iter()
        .find(|metadata| metadata.model == "vendor")
        .expect("Vendor presentation metadata")
        .field_groups
        .is_empty());
    assert!(artifact.extras.seed_change_sets.iter().all(|change_set| {
        change_set.actor_id == "apps/vendor seed"
            && change_set.source_kind == "vendor_seed"
            && change_set.writes.len() == 1
    }));
}

#[test]
fn vendor_catalog_selection_rejects_unknown_and_unselected_required_fields() {
    let root = repository_root();
    let source_path = root.join("packages/schema-compiler/tests/fixtures/catalog-selection/selection.cue");
    let source = fs::read_to_string(&source_path).expect("read Vendor CUE source");

    for (name, modified, expression, expected_error) in [
        (
            "unknown-selected-field",
            source.replacen("\"default_chart_account\",", "\"missing_field\",", 1),
            None,
            "undefined field",
        ),
        (
            "unselected-required-field",
            source.replacen("required: [\"name\"]", "required: [\"id\"]", 1),
            None,
            "explicit error",
        ),
        (
            "unknown-import-token-model",
            source.replacen("chart_account:   \"acct\"", "missing_model: \"acct\"", 1),
            Some("import_policy"),
            "missing_model",
        ),
        (
            "unknown-import-identity-field",
            source.replacen(
                "{fieldId: \"ref\", kind: \"id\"}",
                "{fieldId: \"missing_field\", kind: \"id\"}",
                1,
            ),
            Some("import_policy"),
            "missing_field",
        ),
        (
            "duplicate-import-identity-model",
            source.replacen(
                "\t\t{\n\t\t\tmodelId: \"vendor\"\n\t\t\tidentity: [",
                "\t\t{modelId: \"vendor\", identity: [{fieldId: \"name\", kind: \"name\"}]},\n\t\t{\n\t\t\tmodelId: \"vendor\"\n\t\t\tidentity: [",
                1,
            ),
            Some("import_policy"),
            "explicit error",
        ),
    ] {
        assert_ne!(
            modified, source,
            "invalid fixture {name} must modify CUE source"
        );
        let temporary_path =
            std::env::temp_dir().join(format!("schema-vendor-{name}-{}.cue", std::process::id()));
        fs::write(&temporary_path, modified).expect("write invalid Vendor CUE fixture");
        let mut command = vendor_compiler_command(&root);
        if let Some(expression) = expression {
            command.args(["--raw", "--expression", expression]);
        } else {
            command.arg("--app-artifact");
        }
        let output = command
            .args(vendor_inputs(&root, temporary_path.clone()))
            .output()
            .expect("run invalid Vendor CUE compiler");
        let _ = fs::remove_file(&temporary_path);

        assert!(
            !output.status.success(),
            "invalid Vendor CUE fixture {name} must fail"
        );
        assert!(
            String::from_utf8_lossy(&output.stderr).contains(expected_error),
            "expected {expected_error} in: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
fn vendor_catalog_selection_includes_unrooted_selected_and_local_models() {
    let root = repository_root();
    let source_path = root.join("packages/schema-compiler/tests/fixtures/catalog-selection/selection.cue");
    let source = fs::read_to_string(&source_path).expect("read Vendor CUE source");
    let source = source.replacen(
        "\t]\n\tlocal_models:",
        "\t\t{\n\t\t\tmodel: \"location\"\n\t\t\tfields: [\"name\"]\n\t\t\trequired: [\"name\"]\n\t\t\tdisplay_field_id: \"name\"\n\t\t\tmanagement: \"tenant_managed\"\n\t\t\treason: \"Unrooted selection fixture.\"\n\t\t},\n\t]\n\tlocal_models:",
        1,
    );
    let source = source.replacen(
        "\t]\n\tchange_types:",
        "\t\t{\n\t\t\tmodel: {\n\t\t\t\tid: \"vendor_audit_note\"\n\t\t\t\tkind: \"entity\"\n\t\t\t\tlabel: \"Vendor Audit Note\"\n\t\t\t\tfields: [{id: \"body\", label: \"Body\", type: \"text\"}]\n\t\t\t}\n\t\t\treason: \"Unrooted local-model fixture.\"\n\t\t},\n\t]\n\tchange_types:",
        1,
    );
    let temporary_path = std::env::temp_dir().join(format!(
        "schema-vendor-unrooted-models-{}.cue",
        std::process::id()
    ));
    fs::write(&temporary_path, source).expect("write Vendor CUE fixture");

    let output = vendor_compiler_command(&root)
        .arg("--app-artifact")
        .args(vendor_inputs(&root, temporary_path.clone()))
        .output()
        .expect("run Vendor CUE compiler");
    let _ = fs::remove_file(&temporary_path);
    assert!(
        output.status.success(),
        "Vendor CUE frontend failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let artifact: CompiledAppArtifact = serde_json::from_slice(&output.stdout).unwrap();
    let model_ids = artifact
        .schema
        .models
        .iter()
        .map(|model| model.id.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        &model_ids[model_ids.len() - 2..],
        &["location", "vendor_audit_note"]
    );
}

#[test]
fn catalog_multi_value_fields_compile_as_inverse_scalar_relations() {
    let root = repository_root();
    let source_path = root.join("packages/schema-compiler/tests/fixtures/catalog-selection/selection.cue");
    let source = fs::read_to_string(&source_path).expect("read Vendor CUE source");
    let source = source.replacen(
        "\t]\n\tlocal_models:",
        "\t\t{\n\t\t\tmodel: \"candidate\"\n\t\t\tfields: [\"name\", \"applications\"]\n\t\t\treason: \"Inverse relation fixture.\"\n\t\t},\n\t\t{\n\t\t\tmodel: \"application\"\n\t\t\tfields: [\"candidate\"]\n\t\t\treason: \"Authoritative child relation fixture.\"\n\t\t},\n\t]\n\tlocal_models:",
        1,
    );
    let temporary_path = std::env::temp_dir().join(format!(
        "schema-vendor-inverse-relation-{}.cue",
        std::process::id()
    ));
    fs::write(&temporary_path, source).expect("write Vendor CUE fixture");

    let output = vendor_compiler_command(&root)
        .arg("--app-artifact")
        .args(vendor_inputs(&root, temporary_path.clone()))
        .output()
        .expect("run Vendor CUE compiler");
    let _ = fs::remove_file(&temporary_path);
    assert!(
        output.status.success(),
        "Vendor CUE frontend failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let artifact: CompiledAppArtifact = serde_json::from_slice(&output.stdout).unwrap();
    assert!(artifact.extras.many_relations.is_empty());
    assert!(artifact.extras.inverse_relations.iter().any(|relation| {
        relation.owner_model == "candidate"
            && relation.id == "applications"
            && relation.model == "application"
            && relation.through == "candidate"
    }));
}

#[test]
fn vendor_seed_selection_omits_values_for_deferred_fields() {
    let root = repository_root();
    let catalog_path = root.join("packages/domain-libs/catalog.json");
    let mut catalog: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&catalog_path).expect("read catalog"))
            .expect("parse catalog");
    catalog["domain_catalog"]["models"]["department"]["seed_rows"][0]["values"]["lead"] =
        serde_json::json!("employee:one");
    let temporary_path = std::env::temp_dir().join(format!(
        "schema-vendor-deferred-seed-{}.json",
        std::process::id()
    ));
    fs::write(
        &temporary_path,
        serde_json::to_vec(&catalog).expect("serialize catalog"),
    )
    .expect("write catalog fixture");

    let vendor_source = fs::read_to_string(root.join("packages/schema-compiler/tests/fixtures/catalog-selection/selection.cue"))
        .expect("read Vendor CUE source")
        .replacen(
            "\t\t\tmanagement:       \"tenant_managed\"\n\t\t\tdeferred_fields: [\"lead\", \"executive\"]",
            "\t\t\tmanagement:       \"tenant_managed\"\n\t\t\tseed_rows: [\"engineering\"]\n\t\t\tdeferred_fields: [\"lead\", \"executive\"]",
            1,
        );
    let vendor_path = std::env::temp_dir().join(format!(
        "schema-vendor-deferred-seed-source-{}.cue",
        std::process::id()
    ));
    fs::write(&vendor_path, vendor_source).expect("write Vendor CUE fixture");

    let output = vendor_compiler_command(&root)
        .arg("--app-artifact")
        .args(vendor_inputs_with_catalog(
            &root,
            vendor_path.clone(),
            temporary_path.clone(),
        ))
        .output()
        .expect("run Vendor CUE compiler");
    let _ = fs::remove_file(&temporary_path);
    let _ = fs::remove_file(&vendor_path);

    assert!(
        output.status.success(),
        "Vendor CUE frontend failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let artifact: CompiledAppArtifact =
        serde_json::from_slice(&output.stdout).expect("deserialize Vendor artifact");
    let department_seed = artifact
        .extras
        .seed_change_sets
        .iter()
        .find(|change_set| change_set.idempotency_key == "vendor-seed-department-engineering")
        .expect("department seed exists");
    let values = department_seed.writes[0]
        .values
        .as_ref()
        .expect("seed values");
    assert!(!values.keys().any(|field| field.as_str() == "lead"));
}

fn repository_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn vendor_compiler_command(root: &std::path::Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_schema-compiler"));
    command.current_dir(root);
    command
}

fn vendor_inputs(root: &std::path::Path, vendor_path: PathBuf) -> Vec<PathBuf> {
    vendor_inputs_with_catalog(
        root,
        vendor_path,
        root.join("packages/domain-libs/catalog.json"),
    )
}

fn vendor_inputs_with_catalog(
    root: &std::path::Path,
    vendor_path: PathBuf,
    catalog_path: PathBuf,
) -> Vec<PathBuf> {
    vec![
        root.join("packages/schema-compiler/cue/app-manifest.cue"),
        root.join("packages/schema-compiler/cue/app-selection.cue"),
        vendor_path,
        catalog_path,
    ]
}
