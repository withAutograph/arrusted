use std::env;

use kernel::connect_postgres;
use serde_json::json;
use uuid::Uuid;

use schema_compiler::{
    compile_manifest_json, compile_sql_artifact_manifest, render_sql_artifact_bundle,
};

#[test]
fn generated_bundle_installs_principal_helper_before_policy_bootstraps() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let compiled = compile_manifest_json(
        &json!({
            "app_id": "install_order_app",
            "customer_id": "install_order_customer",
            "version": "2026-08-05",
            "models": [{
                "id": "company",
                "kind": "entity",
                "label": "Company",
                "fields": [{"id": "name", "label": "Name", "type": "text"}]
            }],
            "change_types": [],
            "constraints": [],
            "seed_change_sets": []
        })
        .to_string(),
    )
    .expect("compile install-order fixture");
    let manifest = compile_sql_artifact_manifest(&compiled).expect("compile install-order SQL");

    let mut client = connect_postgres(&database_url).expect("connect to test PostgreSQL");
    let schema = format!("kernel_sql_order_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            "create schema \"{schema}\"; set search_path to \"{schema}\""
        ))
        .expect("create install-order schema");
    let result = (|| {
        client
            .batch_execute(&render_sql_artifact_bundle(&manifest))
            .map_err(|error| format!("install generated bundle: {error:#?}"))?;
        let helper_exists: bool = client
            .query_one(
                "select to_regprocedure('kernel_principal_scope_authorized(text,text,text,text)') is not null",
                &[],
            )
            .map_err(|error| format!("inspect principal helper: {error:#?}"))?
            .get(0);
        let policy_count: i64 = client
            .query_one(
                "select count(*) from pg_policies where schemaname = current_schema() and tablename in ('lookup_storage_authority', 'installed_seed') and policyname = 'kernel_tenant_isolation'",
                &[],
            )
            .map_err(|error| format!("inspect generated policies: {error:#?}"))?
            .get(0);
        assert!(helper_exists);
        assert_eq!(policy_count, 2);

        client
            .batch_execute(
                "create temp view schema_revision as select 1::bigint as id; create temp view lookup_storage_authority as select 'stale'::text as authority",
            )
            .map_err(|error| format!("install persisted temp views: {error:#?}"))?;
        client
            .batch_execute(&render_sql_artifact_bundle(&manifest))
            .map_err(|error| format!("reinstall generated bundle after temp views: {error:#?}"))?;
        let temp_view_count: i64 = client
            .query_one(
                "select count(*) from pg_class where relkind = 'v' and relnamespace = pg_my_temp_schema()",
                &[],
            )
            .map_err(|error| format!("inspect temp-view cleanup: {error:#?}"))?
            .get(0);
        assert_eq!(temp_view_count, 0);
        Ok::<_, String>(())
    })();
    if result.is_err() {
        let _ = client.batch_execute("rollback");
    }
    client
        .batch_execute(&format!("drop schema \"{schema}\" cascade"))
        .expect("drop install-order schema");
    result.expect("principal helper install ordering");
}

#[test]
fn generated_canonical_json_matches_the_rust_idempotency_format() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let compiled = compile_manifest_json(
        &json!({
            "app_id": "canonical_app",
            "customer_id": "canonical_customer",
            "version": "2026-08-04",
            "models": [{
                "id": "company",
                "kind": "entity",
                "label": "Company",
                "fields": [{
                    "id": "name",
                    "label": "Name",
                    "type": "text",
                    "required": true
                }]
            }],
            "change_types": [],
            "constraints": [],
            "seed_change_sets": []
        })
        .to_string(),
    )
    .expect("compile canonicalization fixture");
    let manifest = compile_sql_artifact_manifest(&compiled).expect("compile SQL artifacts");
    let bundle = render_sql_artifact_bundle(&manifest);

    let mut client = connect_postgres(&database_url).expect("connect to test PostgreSQL");
    let schema = format!("kernel_sql_canonical_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            "create schema \"{schema}\"; set search_path to \"{schema}\""
        ))
        .expect("create isolated schema");

    let result = (|| {
        client
            .batch_execute(&bundle)
            .map_err(|error| format!("{error:#?}"))?;
        let value = json!({
            "writes": [{
                "values": {"name": "Acme", "active": true},
                "custom_fields": [{"field_id": "tags", "value": ["a", "b"]}]
            }],
            "schema_revision_id": 7,
            "actor_id": null
        });
        let actual: String = client
            .query_one("select kernel_canonical_json($1::jsonb)", &[&value])
            .map_err(|error| format!("{error:#?}"))?
            .get(0);
        assert_eq!(
            actual,
            r#"{"actor_id":null,"schema_revision_id":7,"writes":[{"custom_fields":[{"field_id":"tags","value":["a","b"]}],"values":{"active":true,"name":"Acme"}}]}"#
        );

        let logical_identifiers = vec![
            "employee".to_string(),
            "Record Level".to_string(),
            "a".repeat(80),
            format!("{}-version", "long_model_name_".repeat(6)),
        ];
        for logical in logical_identifiers {
            let normalized =
                kernel::normalize_identifier(&logical).expect("test logical identifier is valid");
            let expected = bounded_identifier_reference(&normalized);
            let actual: String = client
                .query_one("select kernel_physical_identifier($1)", &[&logical])
                .map_err(|error| format!("{error:#?}"))?
                .get(0);
            assert_eq!(actual, expected, "logical identifier {logical}");
        }
        Ok::<_, String>(())
    })();

    if result.is_err() {
        let _ = client.batch_execute("rollback");
    }
    client
        .batch_execute(&format!("drop schema \"{schema}\" cascade"))
        .expect("drop isolated schema");
    result.expect("canonical JSON fixture");
}

// The same cases (and expected strings) are asserted against Explore's
// the historical frontend search normalization contract,
// so server search and Explore normalize identically.
const SEARCH_NORMALIZE_CASES: &[(&str, Option<&str>)] = &[
    ("  Jane \t  DOE \n", Some("jane doe")),
    (" \t ", None),
    ("Jane\u{a0}Doe", Some("jane doe")),
    ("  Jane\u{a0}\u{2003}DOE \u{3000}", Some("jane doe")),
    ("a\u{feff}b", Some("a b")),
    ("José ÇELIK", Some("jose celik")),
    ("İstanbul", Some("istanbul")),
    ("ДЖОН Смит", Some("джон смит")),
    ("ΟΔΟΣ ΣΟΦΟΣ", Some("οδος σοφος")),
];

#[test]
fn generated_search_normalizes_unicode_like_javascript_under_any_locale() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let compiled = compile_manifest_json(
        &json!({
            "app_id": "search_app",
            "customer_id": "search_customer",
            "version": "2026-10-19",
            "models": [{
                "id": "company",
                "kind": "entity",
                "label": "Company",
                "fields": [{"id": "name", "label": "Name", "type": "text"}]
            }],
            "change_types": [],
            "constraints": [],
            "seed_change_sets": []
        })
        .to_string(),
    )
    .expect("compile search fixture");
    let manifest = compile_sql_artifact_manifest(&compiled).expect("compile search SQL");

    let mut client = connect_postgres(&database_url).expect("connect to test PostgreSQL");
    let schema = format!("kernel_sql_search_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            "create schema \"{schema}\"; set search_path to \"{schema}\""
        ))
        .expect("create isolated schema");

    let result = (|| {
        client
            .batch_execute(&render_sql_artifact_bundle(&manifest))
            .map_err(|error| format!("{error:#?}"))?;
        for (raw, expected) in SEARCH_NORMALIZE_CASES {
            // Input in the C collation, where locale-aware `lower` and `\s`
            // leave non-ASCII letters and spaces alone.
            let actual: Option<String> = client
                .query_one(
                    "select kernel_search_normalize($1::text collate \"C\")",
                    &[raw],
                )
                .map_err(|error| format!("{error:#?}"))?
                .get(0);
            assert_eq!(actual.as_deref(), *expected, "normalize {raw:?}");
        }
        // Non-ASCII words split at word boundaries as ASCII ones do.
        for (candidate, query, grade) in [
            ("джон смит", "смит", 2),
            ("джонсмит", "смит", 3),
            ("οδοςσοφος", "σοφος", 3),
            ("джон смит", "смитт", 4),
            // A letter outside the BMP is one word character; `½` (not a
            // decimal digit) is not one.
            ("𐐨alpha", "alpha", 3),
            ("x½alpha", "alpha", 2),
        ] {
            let actual: Option<i32> = client
                .query_one(
                    "select kernel_search_grade($1::text collate \"C\", $2::text collate \"C\")",
                    &[&candidate, &query],
                )
                .map_err(|error| format!("{error:#?}"))?
                .get(0);
            assert_eq!(actual, Some(grade), "grade {candidate:?} for {query:?}");
        }
        Ok::<_, String>(())
    })();

    if result.is_err() {
        let _ = client.batch_execute("rollback");
    }
    client
        .batch_execute(&format!("drop schema \"{schema}\" cascade"))
        .expect("drop isolated schema");
    result.expect("search normalization fixture");
}

fn bounded_identifier_reference(identifier: &str) -> String {
    if identifier.len() <= 63 {
        return identifier.to_string();
    }
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in identifier.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{}_{hash:016x}", &identifier[..46])
}

fn test_database_url() -> Option<String> {
    match env::var("KERNEL_TEST_DATABASE_URL") {
        Ok(url) => Some(url),
        Err(env::VarError::NotPresent) => {
            eprintln!("skipping SQL canonical JSON test: KERNEL_TEST_DATABASE_URL is absent");
            None
        }
        Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
    }
}
