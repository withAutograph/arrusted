use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

const INVENTORY: &str = include_str!("parity_coverage/kernel_behavior_inventory.json");
const FACADE_COVERAGE: &str = include_str!("fixtures/sql-runtime-parity-coverage.json");
// Keep the current count named in the canonical compiler docs from drifting.
const DOCUMENTED_KERNEL_BEHAVIOR_TEST_COUNT: usize = 298;
const SOURCE_SUITES: &[&str] = &[
    "packages/kernel/tests/materialization.rs",
    "packages/kernel/tests/contracts.rs",
    "packages/kernel/tests/sql_transport.rs",
    "packages/kernel/tests/wire_roundtrip.rs",
    "packages/kernel/src/db.rs",
    "packages/kernel/src/validation.rs",
    "packages/kernel/src/identifiers.rs",
    "packages/kernel/src/iso_codes.rs",
    "packages/kernel/src/postgres_connection.rs",
];
const CLASSIFICATIONS: &[&str] = &[
    "exact",
    "retirement_replacement",
    "typed_activation_replacement",
    "generated_client_protocol",
    "shared_wire_contract",
    "generated_client_mechanic",
    "rust_internal_mechanic",
    "retired_rust_materializer_mechanic",
    "compiler_validation",
    "compiler_identifier_contract",
    "compiler_reference_data_contract",
    "installer_connection_policy",
];
const NON_SQL_CLASSIFICATIONS: &[&str] = &[
    "shared_wire_contract",
    "generated_client_mechanic",
    "rust_internal_mechanic",
    "retired_rust_materializer_mechanic",
    "compiler_validation",
    "compiler_identifier_contract",
    "compiler_reference_data_contract",
    "installer_connection_policy",
];
const STATUSES: &[&str] = &["gap", "implemented", "not_sql_runtime"];

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Inventory {
    format_version: u32,
    tests: Vec<InventoryEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct InventoryEntry {
    source_suite: String,
    test: String,
    classification: String,
    sql_counterparts: Vec<String>,
    required_counterpart: Option<String>,
    status: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FacadeCoverage {
    format_version: u32,
    reference: String,
    operations: Vec<FacadeOperation>,
    semantic_replacements: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FacadeOperation {
    rust: String,
    target: String,
    parity: String,
    status: String,
}

#[test]
fn checked_kernel_behavior_inventory_matches_test_sources_and_sql_counterparts() {
    let root = repository_root();
    let inventory: Inventory =
        serde_json::from_str(INVENTORY).expect("parity coverage inventory must be valid JSON");
    assert_eq!(inventory.format_version, 1, "unsupported inventory format");
    assert_eq!(
        inventory.tests.len(),
        DOCUMENTED_KERNEL_BEHAVIOR_TEST_COUNT,
        "kernel behavior inventory changed; update the documented baseline and its classification summary"
    );

    let expected = source_tests(&root);
    let actual: Vec<_> = inventory
        .tests
        .iter()
        .map(|entry| (entry.source_suite.clone(), entry.test.clone()))
        .collect();
    let expected_set: BTreeSet<_> = expected.iter().cloned().collect();
    let actual_set: BTreeSet<_> = actual.iter().cloned().collect();
    assert_eq!(
        actual.len(),
        expected.len(),
        "inventory and current source test counts differ; missing={:?}; obsolete={:?}",
        expected_set.difference(&actual_set).collect::<Vec<_>>(),
        actual_set.difference(&expected_set).collect::<Vec<_>>()
    );
    for (index, (actual, expected)) in actual.iter().zip(&expected).enumerate() {
        assert_eq!(
            actual, expected,
            "inventory entry {index} must match the current source test order"
        );
    }

    let generated = generated_sql_tests(&root);
    let mut source_entries = BTreeSet::new();
    let mut counterpart_owners = BTreeMap::new();

    for entry in &inventory.tests {
        let source = format!("{}::{}", entry.source_suite, entry.test);
        assert!(
            source_entries.insert(source.clone()),
            "duplicate source mapping: {source}"
        );
        assert!(
            CLASSIFICATIONS.contains(&entry.classification.as_str()),
            "unclassified source test {source}: {}",
            entry.classification
        );
        assert!(
            STATUSES.contains(&entry.status.as_str()),
            "invalid parity status for {source}: {}",
            entry.status
        );

        for counterpart in &entry.sql_counterparts {
            assert!(
                generated.contains(counterpart),
                "{source} maps to missing generated SQL test {counterpart}"
            );
            if let Some(previous) = counterpart_owners.insert(counterpart.clone(), source.clone()) {
                panic!("generated SQL test {counterpart} is mapped twice: {previous} and {source}");
            }
        }

        if let Some(counterpart) = &entry.required_counterpart {
            assert!(
                generated.contains(counterpart),
                "{source} requires missing generated SQL test {counterpart}"
            );
            if let Some(previous) = counterpart_owners.insert(counterpart.clone(), source.clone()) {
                panic!("generated SQL test {counterpart} is owned twice: {previous} and {source}");
            }
        }

        if entry.status == "implemented" {
            assert!(
                !entry.sql_counterparts.is_empty(),
                "implemented source test {source} has no generated SQL counterpart"
            );
            assert!(
                !NON_SQL_CLASSIFICATIONS.contains(&entry.classification.as_str()),
                "non-SQL source test {source} cannot claim implemented SQL parity"
            );
            assert!(
                entry.required_counterpart.is_none(),
                "implemented source test {source} still declares a required counterpart"
            );
        } else {
            assert!(
                entry.sql_counterparts.is_empty(),
                "{source} has status {} but still claims generated counterparts",
                entry.status
            );
        }

        if entry.status == "not_sql_runtime" {
            assert!(
                NON_SQL_CLASSIFICATIONS.contains(&entry.classification.as_str()),
                "not-SQL source test {source} needs a precise non-SQL classification"
            );
            assert!(
                entry.required_counterpart.is_none(),
                "not-SQL source test {source} cannot require a generated counterpart"
            );
        } else if entry.status == "gap" {
            assert!(
                entry.required_counterpart.is_some(),
                "SQL parity gap {source} must name the exact required counterpart"
            );
            assert!(
                !NON_SQL_CLASSIFICATIONS.contains(&entry.classification.as_str()),
                "SQL parity gap {source} uses non-SQL classification {}",
                entry.classification
            );
        } else {
            assert!(
                !NON_SQL_CLASSIFICATIONS.contains(&entry.classification.as_str()),
                "SQL parity source test {source} uses non-SQL classification {}",
                entry.classification
            );
        }
    }
}

#[test]
fn checked_facade_coverage_matches_every_current_public_operation_once() {
    let root = repository_root();
    let coverage: FacadeCoverage = serde_json::from_str(FACADE_COVERAGE)
        .expect("facade coverage inventory must be valid JSON");
    assert_eq!(
        coverage.format_version, 1,
        "unsupported facade coverage format"
    );
    assert_eq!(coverage.reference, "packages/kernel/src/facade.rs");
    assert!(
        !coverage.semantic_replacements.is_empty(),
        "facade coverage must retain its declared semantic replacements"
    );

    let source = fs::read_to_string(root.join(&coverage.reference))
        .expect("read current kernel facade source");
    let expected = parse_public_function_names(&source);
    let actual: Vec<_> = coverage
        .operations
        .iter()
        .map(|operation| operation.rust.clone())
        .collect();
    assert_eq!(
        actual, expected,
        "facade coverage must enumerate every current public operation exactly once in source order"
    );

    let mut operations = BTreeSet::new();
    for operation in &coverage.operations {
        assert!(
            operations.insert(operation.rust.as_str()),
            "duplicate facade operation mapping: {}",
            operation.rust
        );
        assert!(
            !operation.target.trim().is_empty(),
            "facade operation {} has no target authority",
            operation.rust
        );
        assert!(
            CLASSIFICATIONS.contains(&operation.parity.as_str()),
            "facade operation {} has unknown parity classification {}",
            operation.rust,
            operation.parity
        );
        assert_eq!(
            operation.status, "behavioral_parity",
            "facade operation {} is not at behavioral parity",
            operation.rust
        );
    }
}

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("resolve repository root")
}

fn source_tests(root: &Path) -> Vec<(String, String)> {
    SOURCE_SUITES
        .iter()
        .flat_map(|suite| {
            let source = fs::read_to_string(root.join(suite))
                .unwrap_or_else(|error| panic!("read {suite}: {error}"));
            parse_test_names(&source)
                .into_iter()
                .map(|test| ((*suite).to_owned(), test))
                .collect::<Vec<_>>()
        })
        .collect()
}

fn generated_sql_tests(root: &Path) -> BTreeSet<String> {
    let tests_dir = root.join("packages/schema-compiler/tests");
    let mut sources: Vec<_> = fs::read_dir(&tests_dir)
        .expect("read schema compiler tests")
        .map(|entry| entry.expect("read schema compiler test entry").path())
        .filter(|path| {
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                return false;
            };
            name.ends_with(".rs")
                && ((name.starts_with("sql_parity_") && name != "sql_parity_coverage.rs")
                    || name.starts_with("sql_runtime_"))
        })
        .collect();
    sources.push(root.join("packages/kernel/tests/sql_transport.rs"));
    sources.sort();

    sources
        .into_iter()
        .flat_map(|path| {
            let relative = path
                .strip_prefix(root)
                .expect("generated SQL test path is below repository root")
                .to_string_lossy()
                .replace('\\', "/");
            let source = fs::read_to_string(&path)
                .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
            parse_test_names(&source)
                .into_iter()
                .map(move |test| format!("{relative}::{test}"))
        })
        .collect()
}

fn parse_test_names(source: &str) -> Vec<String> {
    let lines: Vec<_> = source.lines().collect();
    let mut names = Vec::new();
    let mut index = 0;

    while index < lines.len() {
        let line = lines[index].trim();
        if line != "#[test]" && line != "#[tokio::test]" {
            index += 1;
            continue;
        }

        index += 1;
        while index < lines.len() {
            let candidate = lines[index].trim();
            if candidate.is_empty() || candidate.starts_with("#[") {
                index += 1;
                continue;
            }
            let signature = candidate.strip_prefix("async ").unwrap_or(candidate);
            let function = signature.strip_prefix("fn ").unwrap_or_else(|| {
                panic!("test attribute is not followed by a function: {candidate}")
            });
            let end = function
                .find(|character: char| !(character.is_ascii_alphanumeric() || character == '_'))
                .expect("test function signature must continue after its name");
            names.push(function[..end].to_owned());
            break;
        }
        index += 1;
    }

    names
}

fn parse_public_function_names(source: &str) -> Vec<String> {
    source
        .lines()
        .filter_map(|line| line.trim_start().strip_prefix("pub fn "))
        .map(|signature| {
            let end = signature
                .find(|character: char| !(character.is_ascii_alphanumeric() || character == '_'))
                .expect("public function signature must continue after its name");
            signature[..end].to_owned()
        })
        .collect()
}

#[test]
fn test_name_parser_handles_supported_test_attributes() {
    let source = r#"
        #[test]
        fn sync_case() {}

        #[tokio::test]
        #[cfg(unix)]
        async fn async_case() {}
    "#;

    assert_eq!(parse_test_names(source), ["sync_case", "async_case"]);
}

#[test]
fn public_function_parser_ignores_non_facade_items_and_preserves_order() {
    let source = r#"
        pub struct Request;
        fn private_case() {}
        pub fn first<T>(value: T) {}
        pub fn second() {}
    "#;

    assert_eq!(parse_public_function_names(source), ["first", "second"]);
}
