//! The compiler validator and the generated SQL runtime accept and reject the
//! same derived expressions, with the same structured error codes.

use std::env;

use kernel::connect_postgres;
use schema_compiler::{
    compile_manifest_json, compile_sql_artifact_manifest, render_sql_artifact_bundle,
};
use serde_json::{json, Value};
use uuid::Uuid;

const CASES: &str = include_str!("../../contracts/__fixtures__/derived-expressions.json");

fn manifest(derived_fields: &Value) -> Value {
    let cases: Value = serde_json::from_str(CASES).unwrap();
    let fields: Vec<Value> = cases["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|field| {
            let mut field = field.clone();
            field["label"] = field["id"].clone();
            field
        })
        .collect();
    let custom_fields: Vec<Value> = cases["custom_fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|field| {
            let mut definition = json!({
                "id": format!("position_{}", field["id"].as_str().unwrap()),
                "model": "position", "field": field["id"], "label": field["id"], "type": field["type"]
            });
            for key in ["lifecycle", "archived_at"] {
                if let Some(value) = field.get(key) {
                    definition[key] = value.clone();
                }
            }
            definition
        })
        .collect();
    json!({
        "app_id": "derived_parity", "customer_id": "tenant_a", "version": "parity-v1",
        "custom_fields": custom_fields,
        "models": [{
            "id": "position", "kind": "entity", "label": "Position",
            "extensions": {"typed_custom_fields": true},
            "fields": fields,
            "derived_fields": derived_fields.as_array().unwrap().iter().map(|field| {
                let mut field = field.clone();
                field["label"] = field["id"].clone();
                field
            }).collect::<Vec<_>>()
        }]
    })
}

fn cases() -> Vec<(String, Value, Option<String>)> {
    let cases: Value = serde_json::from_str(CASES).unwrap();
    let mut cases: Vec<_> = cases["validation"]
        .as_array()
        .unwrap()
        .iter()
        .map(|case| {
            (
                case["name"].as_str().unwrap().to_string(),
                case["derived_fields"].clone(),
                case["error"].as_str().map(str::to_string),
            )
        })
        .collect();
    let mut deep = json!({"type": "field", "field": "salary"});
    for _ in 0..32 {
        deep = json!({"type": "add", "left": deep, "right": {"type": "field", "field": "salary"}});
    }
    cases.push((
        "nesting beyond the depth bound".to_string(),
        json!([{"id": "d", "type": "number", "expression": deep}]),
        Some("derived_expression_too_large".to_string()),
    ));
    cases
}

fn compiler_result(derived_fields: &Value) -> Option<String> {
    compile_manifest_json(&manifest(derived_fields).to_string())
        .err()
        .map(|error| error.code.to_string())
}

#[test]
fn compiler_validator_matches_the_shared_derived_expression_cases() {
    for (name, derived_fields, expected) in cases() {
        assert_eq!(compiler_result(&derived_fields), expected, "{name}");
    }
}

// A tenant custom field (derived or stored) whose id is an active or retired
// declared field id or a many-relation id, before or after normalization, is
// rejected by the compiler validator and the SQL runtime alike.
fn collision_cases(base: &Value) -> Vec<(Value, Option<(String, String)>)> {
    ["salary", "legacy", "Salary", "peers", "Peers", "fresh"]
        .into_iter()
        .map(|field_id| {
            let mut schema = base.clone();
            let custom_fields = schema["custom_fields"].as_array_mut().unwrap();
            custom_fields.push(json!({
                "id": "position_tenant_derived", "model_id": "position", "field_id": field_id,
                "label": field_id, "type": "number", "target_model_id": null, "option_set": [],
                "expression": {"type": "literal", "value": {"type": "number", "value": "0"}},
                "origin": "tenant", "management": "tenant_managed", "lifecycle": "active"
            }));
            let expected = (field_id != "fresh").then(|| {
                (
                    format!("custom_fields[{}].field_id", custom_fields.len() - 1),
                    "custom_field_declared_field_collision".to_string(),
                )
            });
            (schema, expected)
        })
        .collect()
}

fn base_schema() -> Value {
    let base = compile_manifest_json(&manifest(&json!([])).to_string()).expect("base schema");
    let mut schema = serde_json::to_value(&base.schema).unwrap();
    schema["models"][0]["many_relations"] = json!([{
        "id": "peers", "label": "Peers", "target_model": "position",
        "origin": "app", "management": "fixed", "lifecycle": "active"
    }]);
    schema
}

#[test]
fn compiler_validator_rejects_custom_fields_that_reuse_declared_field_ids() {
    for (schema, expected) in collision_cases(&base_schema()) {
        let schema: kernel::Schema = serde_json::from_value(schema).unwrap();
        let actual = kernel::validate_schema(&schema).err().and_then(|error| {
            error
                .issues
                .into_iter()
                .find(|issue| issue.code == "custom_field_declared_field_collision")
                .map(|issue| (issue.path, issue.code.to_string()))
        });
        assert_eq!(
            actual,
            expected,
            "{}",
            schema.custom_fields.last().unwrap().field_id
        );
    }
}

#[test]
fn generated_sql_validator_matches_the_compiler_on_every_case() {
    let Ok(database_url) = env::var("KERNEL_TEST_DATABASE_URL") else {
        eprintln!("skipping derived expression SQL parity: KERNEL_TEST_DATABASE_URL is absent");
        return;
    };
    let base = compile_manifest_json(&manifest(&json!([])).to_string()).expect("base schema");
    let bundle =
        render_sql_artifact_bundle(&compile_sql_artifact_manifest(&base).expect("SQL bundle"));
    let mut client = connect_postgres(&database_url).expect("connect PostgreSQL");
    let database_schema = format!("kernel_derived_parity_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            "create schema \"{database_schema}\"; set search_path to \"{database_schema}\""
        ))
        .expect("create isolated schema");
    let result = (|| -> Result<(), String> {
        client
            .batch_execute(&bundle)
            .map_err(|error| format!("install bundle: {error:?}"))?;
        evaluation_cases(&mut client)?;
        let fixture: Value = serde_json::from_str(CASES).unwrap();
        for case in fixture["runtime_validation"].as_array().unwrap() {
            let field = &case["derived_fields"][0];
            let mut schema = serde_json::to_value(&base.schema).unwrap();
            schema["custom_fields"].as_array_mut().unwrap().push(json!({
                "id": "position_d", "model_id": "position", "field_id": "d", "label": "d",
                "type": field["type"], "expression": field["expression"],
                "origin": "tenant", "management": "tenant_managed", "lifecycle": "active"
            }));
            let issues: Value = client
                .query_one(
                    "select kernel_derived_issues(kernel_derived_environment($1,'position'),'d',$2,$3,'case')",
                    &[&schema, &field["expression"], &field["type"].as_str()],
                )
                .map_err(|error| format!("{}: {error:?}", case["name"]))?
                .get(0);
            assert_eq!(issues[0]["code"], case["error"], "{}", case["name"]);
        }
        for (name, derived_fields, expected) in cases() {
            let mut schema = serde_json::to_value(&base.schema).unwrap();
            for field in derived_fields.as_array().unwrap() {
                schema["custom_fields"].as_array_mut().unwrap().push(json!({
                    "id": format!("position_{}", field["id"].as_str().unwrap()),
                    "model_id": "position", "field_id": field["id"], "label": field["id"],
                    "type": field["type"], "expression": field["expression"],
                    "origin": "app", "management": "fixed", "lifecycle": "active"
                }));
            }
            let mut actual = None;
            for field in derived_fields.as_array().unwrap() {
                let issues: Value = client
                    .query_one(
                        "select kernel_derived_issues(kernel_derived_environment($1,'position'),$2,$3,$4,'case')",
                        &[&schema, &field["id"].as_str(), &field["expression"], &field["type"].as_str()],
                    )
                    .map_err(|error| format!("{name}: {error:?}"))?
                    .get(0);
                if let Some(issue) = issues.as_array().and_then(|issues| issues.first()) {
                    actual = issue["code"].as_str().map(str::to_string);
                    break;
                }
            }
            assert_eq!(actual, expected, "{name}");
            assert_eq!(actual, compiler_result(&derived_fields), "{name}");
        }
        for (schema, expected) in collision_cases(&base_schema()) {
            let issues: Value = client
                .query_one(
                    "select kernel_admin_custom_field_collision_issues($1, '{}'::jsonb)",
                    &[&schema],
                )
                .map_err(|error| format!("collision issues: {error:?}"))?
                .get(0);
            let actual = issues.as_array().unwrap().first().map(|issue| {
                (
                    issue["path"].as_str().unwrap().to_string(),
                    issue["code"].as_str().unwrap().to_string(),
                )
            });
            assert_eq!(actual, expected, "{schema}");
        }
        Ok(())
    })();
    let cleanup = client.batch_execute(&format!(
        "reset search_path; drop schema if exists \"{database_schema}\" cascade"
    ));
    result.expect("derived expression parity");
    cleanup.expect("drop isolated schema");
}

/// Every evaluation case lowers through the generated SQL runtime to exactly
/// the shared expected read value; the TypeScript evaluator asserts the same.
fn evaluation_cases(client: &mut postgres::Client) -> Result<(), String> {
    let cases: Value = serde_json::from_str(CASES).unwrap();
    // `manager` relates a position to a position, so its target fields are
    // the model's active stored fields.
    let active = |field: &&Value| field["lifecycle"].as_str().unwrap_or("active") == "active";
    let target_fields: serde_json::Map<String, Value> = cases["fields"]
        .as_array()
        .unwrap()
        .iter()
        .chain(cases["custom_fields"].as_array().unwrap())
        .filter(active)
        .map(|field| {
            (
                field["id"].as_str().unwrap().to_string(),
                field["type"].clone(),
            )
        })
        .collect();
    // Active declared and custom stored fields, the same environment the
    // TypeScript harness builds.
    let mut base = serde_json::Map::new();
    for (fields, source) in [
        (&cases["fields"], "base"),
        (&cases["custom_fields"], "custom"),
    ] {
        for field in fields.as_array().unwrap().iter().filter(active) {
            let mut entry = json!({"type": field["type"], "source": source});
            if field["type"] == "relation" {
                entry["target_fields"] = Value::Object(target_fields.clone());
            }
            base.insert(field["id"].as_str().unwrap().to_string(), entry);
        }
    }
    for input in cases["number_inputs"].as_array().unwrap() {
        let valid: bool = client
            .query_one(
                "select kernel_apply_typed_value_valid(jsonb_build_object('type','number','value',$1::text),'number')",
                &[&input["value"].as_str()],
            )
            .map_err(|error| format!("number input: {error:?}"))?
            .get(0);
        assert_eq!(valid, input["valid"].as_bool().unwrap(), "{input}");
    }
    for case in cases["evaluation"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let mut environment = base.clone();
        for field in case["derived_fields"].as_array().unwrap() {
            environment.insert(
                field["id"].as_str().unwrap().to_string(),
                json!({"type": field["type"], "source": "custom", "expression": field["expression"]}),
            );
        }
        if let Some(parameters) = case.get("parameters") {
            environment.insert("$parameters".to_string(), parameters.clone());
        }
        let environment = Value::Object(environment);
        let image =
            json!({"values": case["values"], "related": case.get("related").unwrap_or(&json!({}))});
        for field in case["derived_fields"].as_array().unwrap() {
            let id = field["id"].as_str().unwrap();
            let issues: Value = client
                .query_one(
                    "select kernel_derived_issues($1,$2,$3,$4,'case')",
                    &[
                        &environment,
                        &id,
                        &field["expression"],
                        &field["type"].as_str(),
                    ],
                )
                .map_err(|error| format!("{name}: validate: {error:?}"))?
                .get(0);
            assert_eq!(issues, json!([]), "{name}: {id}");
            let sql: String = client
                .query_one(
                    "select kernel_derived_value_sql($1,$2,'($1::jsonb)->''values''->%L','($1::jsonb)->''values''->%L','($1::jsonb)->''related''->%2$L->%3$L')",
                    &[&field["expression"], &environment],
                )
                .map_err(|error| format!("{name}: lower: {error:?}"))?
                .get(0);
            let actual: Option<Value> = client
                // The filter binds `$1` even when the expression reads no field.
                .query_one(
                    &format!("select ({sql})::jsonb where $1::jsonb is not null"),
                    &[&image],
                )
                .map_err(|error| format!("{name}: evaluate: {error:?}"))?
                .get(0);
            assert_eq!(
                actual.unwrap_or(Value::Null),
                case["expected"][id],
                "{name}: {id}"
            );
        }
    }
    Ok(())
}
