use schema_compiler::{compile_manifest_json, compile_sql_artifact_manifest, SqlArtifactKind};
use serde_json::{json, Value};

fn manifest() -> Value {
    json!({
        "app_id":"intervals", "customer_id":"tenant", "version":"v1",
        "models":[
            {"id":"employee","kind":"entity","label":"Employee","fields":[
                {"id":"name","label":"Name","type":"text","required":true}
            ]},
            {"id":"desk","kind":"lookup","label":"Desk","display_field_id":"name","fields":[
                {"id":"name","label":"Name","type":"text","required":true},
                {"id":"opened","label":"Opened","type":"date","required":true},
                {"id":"closed","label":"Closed","type":"date"}
            ]},
            {"id":"assignment","kind":"entity","label":"Assignment","fields":[
                {"id":"employee","label":"Employee","type":"relation","target_model":"employee"},
                {"id":"code","label":"Code","type":"text"},
                {"id":"tags","label":"Tags","type":"text_list"},
                {"id":"start_date","label":"Start","type":"date","required":true},
                {"id":"end_date","label":"End","type":"date"},
                {"id":"loose_start","label":"Loose start","type":"date"}
            ]}
        ],
        "constraints":[
            {"id":"one_active","label":"One active assignment","model":"assignment",
             "expression":{"type":"non_overlapping_intervals","start":"start_date","end":"end_date",
                           "subjects":[["employee"],["code"]]}}
        ]
    })
}

fn rejection(expression: Value, model: &str) -> &'static str {
    let mut manifest = manifest();
    manifest["constraints"][0]["expression"] = expression;
    manifest["constraints"][0]["model"] = json!(model);
    compile_manifest_json(&manifest.to_string())
        .unwrap_err()
        .code
}

fn interval(start: &str, end: &str, subjects: Value) -> Value {
    json!({"type":"non_overlapping_intervals","start":start,"end":end,"subjects":subjects})
}

#[test]
fn interval_rule_lowers_to_a_catalog_entry_instead_of_a_check() {
    let compiled = compile_manifest_json(&manifest().to_string()).unwrap();
    let sql = compile_sql_artifact_manifest(&compiled).unwrap();
    assert!(!sql
        .artifacts
        .iter()
        .any(|artifact| artifact.kind == SqlArtifactKind::CheckConstraint
            && artifact.name.contains("one_active")));
    let catalog = sql
        .artifacts
        .iter()
        .find(|artifact| artifact.kind == SqlArtifactKind::ConstraintCatalog)
        .unwrap();
    assert!(catalog.sql.contains(
        r#"{"kind":"non_overlapping_intervals","model_id":"assignment","constraint_id":"one_active","label":"One active assignment","start_field_id":"start_date","end_field_id":"end_date","subject_field_ids":[["employee"],["code"]],"field_ids":["start_date","end_date","employee","code"]}"#
    ));
    assert!(sql
        .constraint_expression_coverage
        .detail
        .contains("non_overlapping_intervals"));
}

#[test]
fn interval_rule_rejects_unsupported_shapes() {
    let subjects = json!([["employee"]]);
    let valid = interval("start_date", "end_date", subjects.clone());
    assert_eq!(
        rejection(json!({"type":"not","expression":valid}), "assignment"),
        "non_root_interval_constraint"
    );
    assert_eq!(
        rejection(interval("opened", "closed", json!([["name"]])), "desk"),
        "unsupported_interval_constraint_model"
    );
    assert_eq!(
        rejection(
            interval("loose_start", "end_date", subjects.clone()),
            "assignment"
        ),
        "type_mismatch"
    );
    assert_eq!(
        rejection(
            interval("start_date", "code", subjects.clone()),
            "assignment"
        ),
        "type_mismatch"
    );
    assert_eq!(
        rejection(
            interval("start_date", "start_date", subjects.clone()),
            "assignment"
        ),
        "type_mismatch"
    );
    assert_eq!(
        rejection(interval("start_date", "end_date", json!([])), "assignment"),
        "empty_field_set"
    );
    assert_eq!(
        rejection(
            interval("start_date", "end_date", json!([[]])),
            "assignment"
        ),
        "invalid_interval_subject"
    );
    assert_eq!(
        rejection(
            interval(
                "start_date",
                "end_date",
                json!([["employee"], ["employee"]])
            ),
            "assignment"
        ),
        "duplicate_interval_subject"
    );
    assert_eq!(
        rejection(
            interval("start_date", "end_date", json!([["tags"]])),
            "assignment"
        ),
        "type_mismatch"
    );
    assert_eq!(
        rejection(
            interval("start_date", "end_date", json!([["end_date"]])),
            "assignment"
        ),
        "type_mismatch"
    );
    assert_eq!(
        rejection(
            interval("start_date", "end_date", json!([["missing"]])),
            "assignment"
        ),
        "unknown_field"
    );
}
