use std::collections::BTreeSet;

use serde_json::Value;

const FACADE_SOURCE: &str = include_str!("../../kernel/src/facade.rs");
const COVERAGE_SOURCE: &str = include_str!("fixtures/sql-runtime-parity-coverage.json");

#[test]
fn every_current_facade_operation_has_one_honest_sql_target_classification() {
    let facade_operations = FACADE_SOURCE
        .lines()
        .filter_map(|line| line.strip_prefix("pub fn "))
        .map(|declaration| {
            declaration
                .split(['(', '<'])
                .next()
                .expect("public function declaration has a name")
                .to_string()
        })
        .collect::<BTreeSet<_>>();

    let coverage: Value = serde_json::from_str(COVERAGE_SOURCE).expect("coverage JSON is valid");
    let entries = coverage["operations"]
        .as_array()
        .expect("coverage operations is an array");
    let mut classified = BTreeSet::new();
    for entry in entries {
        let operation = entry["rust"]
            .as_str()
            .expect("coverage operation has a Rust name");
        assert!(
            classified.insert(operation.to_string()),
            "facade operation `{operation}` is classified more than once"
        );
        assert!(
            !entry["target"].as_str().unwrap_or_default().is_empty(),
            "facade operation `{operation}` has no generated target"
        );
        assert!(
            matches!(
                entry["parity"].as_str(),
                Some(
                    "exact"
                        | "retirement_replacement"
                        | "typed_activation_replacement"
                        | "generated_client_protocol"
                )
            ),
            "facade operation `{operation}` has an unsupported parity classification"
        );
        assert!(
            matches!(
                entry["status"].as_str(),
                Some("gap" | "behavioral_parity" | "implemented")
            ),
            "facade operation `{operation}` has an unsupported implementation status"
        );
    }

    assert_eq!(classified, facade_operations);
}

#[test]
fn every_semantic_replacement_names_superseded_and_replacement_proof() {
    let coverage: Value = serde_json::from_str(COVERAGE_SOURCE).expect("coverage JSON is valid");
    let replacements = coverage["semantic_replacements"]
        .as_array()
        .expect("semantic replacements is an array");
    assert!(!replacements.is_empty());

    for replacement in replacements {
        let kind = replacement["kind"]
            .as_str()
            .expect("semantic replacement has a kind");
        assert!(
            replacement["supersedes"]
                .as_array()
                .is_some_and(|items| !items.is_empty()),
            "semantic replacement `{kind}` does not name the superseded contract"
        );
        assert!(
            replacement["requires"]
                .as_array()
                .is_some_and(|items| !items.is_empty()),
            "semantic replacement `{kind}` has no replacement proof"
        );
    }
}
