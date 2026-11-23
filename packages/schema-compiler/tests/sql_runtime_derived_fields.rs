//! Runtime derived custom fields and compiled derived fields through the
//! generated PostgreSQL runtime: tenant authoring, validation, read-only
//! writes, list projection, filters, ordering, aggregation and isolation.

#[path = "support/trusted_human.rs"]
mod trusted_human;

use std::collections::BTreeMap;
use std::env;

use kernel::{connect_postgres, schema_hash, Schema, TenantSchemaRevisionResult};
use schema_compiler::{
    compile_manifest_json, compile_sql_artifact_manifest, render_sql_artifact_bundle,
};
use serde_json::{json, Value};
use uuid::Uuid;

const APP_ID: &str = "derived_fixture";

fn manifest(customer_id: &str) -> Value {
    json!({
        "app_id": APP_ID, "customer_id": customer_id, "version": "derived-v1",
        "models": [{
            "id": "position", "kind": "entity", "label": "Position",
            "extensions": {"typed_custom_fields": true},
            "fields": [
                {"id": "name", "label": "Name", "type": "text", "required": true},
                {"id": "salary", "label": "Salary", "type": "number"},
                {"id": "midpoint", "label": "Midpoint", "type": "number"},
                {"id": "base", "label": "Base", "type": "money_rate"},
                {"id": "bonus", "label": "Bonus", "type": "money_rate"}
            ],
            "derived_fields": [{
                "id": "total_cash", "label": "Total cash", "type": "money_rate",
                "expression": {"type": "add", "left": field("base"), "right": field("bonus")}
            }]
        }, {
            // No tenant custom-field opt-in: app-authored derived fields need none.
            "id": "team", "kind": "entity", "label": "Team",
            "fields": [{"id": "name", "label": "Name", "type": "text", "required": true}],
            "derived_fields": [{
                "id": "badge", "label": "Badge", "type": "text",
                "expression": {"type": "concat", "expressions": [{"type": "literal", "value": {"type": "text", "value": "Team "}}, field("name")]}
            }]
        }]
    })
}

fn field(id: &str) -> Value {
    json!({"type": "field", "field": id})
}

fn number(value: &str) -> Value {
    json!({"type": "literal", "value": {"type": "number", "value": value}})
}

fn derived(field_id: &str, field_type: &str, expression: Value) -> Value {
    json!({"type": "create_custom_field", "definition": {
        "id": format!("position_{field_id}"), "model_id": "position", "field_id": field_id,
        "label": field_id, "type": field_type, "option_set": [], "expression": expression
    }})
}

#[test]
fn derived_custom_fields_are_read_only_typed_values_in_kernel_queries() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let tenant_a = compile_manifest_json(&manifest("tenant_a").to_string()).expect("compile A");
    let tenant_b = compile_manifest_json(&manifest("tenant_b").to_string()).expect("compile B");
    let bundle =
        render_sql_artifact_bundle(&compile_sql_artifact_manifest(&tenant_a).expect("SQL bundle"));
    let mut client = connect_postgres(&database_url).expect("connect PostgreSQL");
    let database_schema = format!("kernel_derived_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            "create schema \"{database_schema}\"; set search_path to \"{database_schema}\""
        ))
        .expect("create isolated schema");

    trusted_human::before_install(&mut client);
    let result = (|| -> Result<(), String> {
        client
            .batch_execute(&bundle)
            .map_err(|error| format!("install bundle: {error:?}"))?;
        let (revision_a, hash_a) = seed_active_schema(&mut client, &tenant_a.schema)?;
        let (revision_b, _) = seed_active_schema(&mut client, &tenant_b.schema)?;
        // Mainline fixture writes come from a trusted human actor.
        for customer_id in ["tenant_a", "tenant_b"] {
            trusted_human::bind(&mut client, APP_ID, customer_id, "fixture");
        }
        set_scope(&mut client, "tenant_a")?;

        // Invalid definitions fail with structured issues and change nothing.
        for (operations, code) in [
            (
                json!([
                    derived(
                        "loop_a",
                        "text",
                        json!({"type": "concat", "expressions": [field("loop_b")]})
                    ),
                    derived(
                        "loop_b",
                        "text",
                        json!({"type": "concat", "expressions": [field("loop_a")]})
                    )
                ]),
                "derived_cycle",
            ),
            (
                json!([derived("loop_self", "number", field("loop_self"))]),
                "derived_cycle",
            ),
            (
                json!([derived("ghost", "number", field("missing"))]),
                "unknown_field",
            ),
            (
                json!([derived(
                    "mixed",
                    "number",
                    json!({"type": "add", "left": field("salary"), "right": field("base")})
                )]),
                "type_mismatch",
            ),
            (
                json!([derived("declared", "text", field("salary"))]),
                "type_mismatch",
            ),
            (
                json!([derived(
                    "headcount",
                    "number",
                    json!({"type": "inverse_aggregate", "inverse_relation": "reports", "aggregate": "count"})
                )]),
                "unsupported_derived_expression",
            ),
            (
                json!([derived(
                    "listed",
                    "text_list",
                    json!({"type": "literal", "value": {"type": "text", "value": "x"}})
                )]),
                "unsupported_derived_type",
            ),
            // A custom field never reuses a declared field id: a derived one
            // would otherwise stand in for the declared field it shadows.
            (
                json!([derived("salary", "number", number("0"))]),
                "custom_field_declared_field_collision",
            ),
            (
                json!([{"type": "create_custom_field", "definition": {
                    "id": "position_midpoint", "model_id": "position", "field_id": "midpoint",
                    "label": "Midpoint", "type": "number", "option_set": []
                }}]),
                "custom_field_declared_field_collision",
            ),
        ] {
            let rejected = call(
                &mut client,
                "kernel_dry_run_tenant_schema_revision",
                &revision_request(revision_a, &hash_a, code, operations),
            )?;
            assert_eq!(rejected["ok"], false, "{rejected}");
            assert!(
                detail_codes(&rejected).contains(&code.to_string()),
                "expected {code}: {rejected}"
            );
        }

        let committed = call(
            &mut client,
            "kernel_commit_tenant_schema_revision",
            &revision_request(
                revision_a,
                &hash_a,
                "derived-create",
                json!([
                    {"type": "create_custom_field", "definition": {
                        "id": "position_stipend", "model_id": "position", "field_id": "stipend",
                        "label": "Stipend", "type": "number", "option_set": []
                    }},
                    derived("compa_ratio", "number", json!({"type": "divide", "left": field("salary"), "right": field("midpoint")})),
                    derived("loaded_salary", "number", json!({"type": "add", "left": field("salary"),
                        "right": {"type": "coalesce", "expressions": [field("stipend"), number("0")]}})),
                    derived("total_monthly", "money_rate", json!({"type": "normalize_money_rate", "expression": field("total_cash"), "period": "monthly"}))
                ]),
            ),
        )?;
        assert_eq!(committed["ok"], true, "{committed}");
        let committed: TenantSchemaRevisionResult =
            serde_json::from_value(committed["data"].clone()).map_err(|e| e.to_string())?;
        assert!(committed
            .schema
            .custom_fields
            .iter()
            .any(|definition| definition.field_id.as_str() == "compa_ratio"
                && definition.expression.is_some()));
        let revision_a = committed.schema_revision_id.get();
        let version_a = committed.schema.version.to_string();
        // Recomposing the tenant overlay over the app base keeps the app-derived
        // field on the model that never opted into tenant custom fields.
        let recomposed: Value = client
            .query_one(
                "select kernel_admin_apply_overlay(base_schema, customer_overlay) from schema_revision where id=$1",
                &[&revision_a],
            )
            .map_err(|error| format!("recompose overlay: {error:?}"))?
            .get(0);
        let recomposed = recomposed.to_string();
        assert!(
            recomposed.contains("\"badge\"") && recomposed.contains("compa_ratio"),
            "{recomposed}"
        );

        // A referenced field cannot be retired while a derived field reads it.
        let retire = call(
            &mut client,
            "kernel_dry_run_tenant_schema_revision",
            &revision_request(
                revision_a,
                &committed.effective_hash,
                "retire-stipend",
                json!([{"type": "retire_custom_field", "definition_id": "position_stipend"}]),
            ),
        )?;
        assert!(
            detail_codes(&retire).contains(&"unknown_field".to_string()),
            "{retire}"
        );
        // The expression is immutable; only label and management change.
        let update = call(
            &mut client,
            "kernel_dry_run_tenant_schema_revision",
            &revision_request(
                revision_a,
                &committed.effective_hash,
                "update-expression",
                json!([{"type": "update_custom_field", "definition_id": "position_compa_ratio", "expression": number("1")}]),
            ),
        )?;
        assert_eq!(update["ok"], false, "{update}");
        // Reading one derived field twice is a DAG, not a cycle.
        let doubled =
            json!({"type": "add", "left": field("loaded_salary"), "right": field("loaded_salary")});
        let dag = call(
            &mut client,
            "kernel_dry_run_tenant_schema_revision",
            &revision_request(
                revision_a,
                &committed.effective_hash,
                "derived-dag",
                json!([derived("doubled", "number", doubled.clone())]),
            ),
        )?;
        assert_eq!(dag["ok"], true, "{dag}");
        client
            .query_one(
                "select kernel_derived_value_sql($1, kernel_derived_environment(schema, 'position'), '%L', '%L', null) from schema_revision where id=$2",
                &[&doubled, &revision_a],
            )
            .map_err(|error| format!("lower derived DAG: {error:?}"))?;

        let money = |amount: &str, currency: &str, period: &str| json!({"type": "money_rate", "value": {"amount": amount, "currency": currency, "period": period}});
        let positions = [
            (
                "p1",
                "100",
                "3",
                money("120000", "USD", "annual"),
                money("12000", "USD", "annual"),
                Some("5"),
            ),
            (
                "p2",
                "90",
                "0",
                money("2400", "USD", "monthly"),
                money("600", "USD", "monthly"),
                None,
            ),
            (
                "p3",
                "50",
                "50",
                money("1000", "EUR", "annual"),
                Value::Null,
                None,
            ),
        ];
        for (name, salary, midpoint, base, bonus, stipend) in positions {
            let mut values = json!({
                "name": {"type": "text", "value": name},
                "salary": {"type": "number", "value": salary},
                "midpoint": {"type": "number", "value": midpoint},
                "base": base
            });
            if !bonus.is_null() {
                values["bonus"] = bonus;
            }
            let custom_fields: Vec<Value> = stipend
                .map(|value| json!({"field_id": "stipend", "type": "number", "value": value}))
                .into_iter()
                .collect();
            assert_ok(&apply(
                &mut client,
                "tenant_a",
                revision_a,
                name,
                json!([{"model_id": "position", "new_record_id": Uuid::new_v4(), "effective_start": "2026-01-01",
                    "values": values, "custom_fields": custom_fields}]),
            )?);
        }
        set_scope(&mut client, "tenant_b")?;
        assert_ok(&apply(
            &mut client,
            "tenant_b",
            revision_b,
            "b-1",
            json!([{"model_id": "position", "new_record_id": Uuid::new_v4(), "effective_start": "2026-01-01",
                "values": {"name": {"type": "text", "value": "b1"}, "salary": {"type": "number", "value": "7"},
                    "base": money("1", "USD", "annual"), "bonus": money("2", "USD", "annual")}}]),
        )?);
        set_scope(&mut client, "tenant_a")?;

        // Derived values are never accepted as write values.
        for write in [
            json!({"custom_fields": [{"field_id": "compa_ratio", "type": "number", "value": "1"}]}),
            json!({"custom_fields": [{"field_id": "total_cash", "type": "money_rate", "value": {"amount": "1", "currency": "USD", "period": "annual"}}]}),
            json!({"values": {"salary": {"type": "number", "value": "1"}}, "clear_custom_fields": ["loaded_salary"]}),
        ] {
            let mut write = write;
            write["model_id"] = json!("position");
            write["record_key"] = json!({"type": "external_key", "value": "missing"});
            write["effective_start"] = json!("2026-02-01");
            let rejected = apply(
                &mut client,
                "tenant_a",
                revision_a,
                &Uuid::new_v4().to_string(),
                json!([write]),
            )?;
            assert!(
                detail_codes(&rejected).contains(&"derived_field_read_only".to_string()),
                "{rejected}"
            );
        }

        let query = |client: &mut postgres::Client, customer: &str, extra: Value| {
            let version = if customer == "tenant_a" {
                version_a.as_str()
            } else {
                "derived-v1"
            };
            let mut request = json!({"app_id": APP_ID, "customer_id": customer,
                "schema_version": version, "model_id": "position", "as_of": "2026-01-01"});
            request
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            call(client, "kernel_data_query", &request)
        };

        let listed = query(
            &mut client,
            "tenant_a",
            json!({"select": ["name", "compa_ratio", "loaded_salary", "total_cash", "total_monthly"],
                "order_by": [{"field": "name", "direction": "asc"}]}),
        )?;
        assert_ok(&listed);
        let rows: Vec<BTreeMap<String, Value>> = listed["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(custom_values)
            .collect();
        let usd = |amount: &str, period: &str| json!({"amount": amount, "currency": "USD", "period": period});
        assert_eq!(
            rows[0]["compa_ratio"],
            json!("33.33333333333333333333333333")
        );
        assert_eq!(rows[0]["loaded_salary"], json!("105"));
        assert_eq!(rows[0]["total_cash"], usd("132000", "annual"));
        assert_eq!(rows[0]["total_monthly"], usd("11000", "monthly"));
        // Division by zero and a missing operand are absent, never invented.
        assert!(!rows[1].contains_key("compa_ratio"), "{listed}");
        assert_eq!(rows[1]["loaded_salary"], json!("90"));
        assert_eq!(rows[1]["total_monthly"], usd("3000", "monthly"));
        assert_eq!(rows[2]["compa_ratio"], json!("1"));
        assert!(!rows[2].contains_key("total_cash"), "{listed}");

        let full = query(
            &mut client,
            "tenant_a",
            json!({"where": [{"field": "name", "op": "eq", "value": "p1"}]}),
        )?;
        assert_ok(&full);
        let full_values = custom_values(&full["data"][0]);
        assert_eq!(full_values["stipend"], json!("5"));
        assert_eq!(
            full_values["compa_ratio"],
            json!("33.33333333333333333333333333")
        );

        let filtered = query(
            &mut client,
            "tenant_a",
            json!({"select": ["name"], "where": [{"field": "compa_ratio", "op": "gt", "value": "2"}]}),
        )?;
        assert_eq!(names(&filtered), vec!["p1"], "{filtered}");
        let ordered = query(
            &mut client,
            "tenant_a",
            json!({"select": ["name"], "order_by": [{"field": "compa_ratio", "direction": "desc"}]}),
        )?;
        assert_eq!(names(&ordered), vec!["p1", "p3", "p2"], "{ordered}");

        let cash = query(
            &mut client,
            "tenant_a",
            json!({"kind": "aggregate", "metrics": [{"fn": "sum", "field": "total_cash"}]}),
        )?;
        assert_ok(&cash);
        assert_eq!(
            cash["data"]["groups"],
            json!([
                {"key": [{"unit": null}], "metrics": [null]},
                {"key": [{"unit": {"currency": "USD", "period": "annual"}}], "metrics": ["132000"]},
                {"key": [{"unit": {"currency": "USD", "period": "monthly"}}], "metrics": ["3000"]}
            ]),
            "{cash}"
        );
        assert_eq!(cash["data"]["total"]["metrics"], json!([null]), "{cash}");

        let mixed = query(
            &mut client,
            "tenant_a",
            json!({"kind": "aggregate", "group_by": ["loaded_salary"],
                "metrics": [{"fn": "count"}, {"fn": "sum", "field": "compa_ratio"}]}),
        )?;
        assert_ok(&mixed);
        assert_eq!(
            mixed["data"]["groups"],
            json!([
                {"key": ["50"], "metrics": ["1", "1"]},
                {"key": ["90"], "metrics": ["1", null]},
                {"key": ["105"], "metrics": ["1", "33.33333333333333333333333333"]}
            ]),
            "{mixed}"
        );
        assert_eq!(
            mixed["data"]["total"]["metrics"],
            json!(["3", "34.33333333333333333333333333"])
        );

        // Computed columns are per-query derived fields: never stored, scoped to
        // one request, and usable everywhere a derived field is.
        let computed = json!([
            {"id": "ratio_pct", "type": "number", "expression": {"type": "multiply", "left": field("compa_ratio"), "right": number("100")}},
            {"id": "half_salary", "type": "number", "expression": {"type": "divide", "left": field("salary"), "right": number("2")}},
            {"id": "cash_doubled", "type": "money_rate", "expression": {"type": "multiply", "left": field("total_cash"), "right": number("2")}}
        ]);
        let listed = query(
            &mut client,
            "tenant_a",
            json!({"computed": computed, "select": ["name", "ratio_pct", "half_salary"],
                "where": [{"field": "half_salary", "op": "gte", "value": "45"}],
                "order_by": [{"field": "ratio_pct", "direction": "desc"}]}),
        )?;
        assert_ok(&listed);
        assert_eq!(names(&listed), vec!["p1", "p2"], "{listed}");
        let first = custom_values(&listed["data"][0]);
        assert_eq!(first["ratio_pct"], json!("3333.333333333333333333333333"));
        assert_eq!(first["half_salary"], json!("50"));
        assert!(!first.contains_key("compa_ratio"), "{listed}");
        let grouped = query(
            &mut client,
            "tenant_a",
            json!({"kind": "aggregate", "computed": computed, "group_by": ["half_salary"],
                "metrics": [{"fn": "sum", "field": "cash_doubled"}]}),
        )?;
        assert_ok(&grouped);
        assert_eq!(
            grouped["data"]["groups"],
            json!([
                {"key": ["25", {"unit": null}], "metrics": [null]},
                {"key": ["45", {"unit": {"currency": "USD", "period": "monthly"}}], "metrics": ["6000"]},
                {"key": ["50", {"unit": {"currency": "USD", "period": "annual"}}], "metrics": ["264000"]}
            ]),
            "{grouped}"
        );
        // A stale stored entry under a derived or computed id never surfaces:
        // p2's compa_ratio is null (division by zero) and stays absent.
        client
            .execute(
                "update position_version set custom_fields = custom_fields || '[{\"field_id\":\"compa_ratio\",\"type\":\"number\",\"value\":\"99\"},{\"field_id\":\"scratch\",\"type\":\"number\",\"value\":\"98\"}]'::jsonb where name='p2'",
                &[],
            )
            .map_err(|error| format!("seed stale entries: {error:?}"))?;
        let stale = query(
            &mut client,
            "tenant_a",
            json!({"computed": [{"id": "scratch", "type": "number", "expression": {"type": "divide", "left": field("salary"), "right": field("midpoint")}}],
                "select": ["compa_ratio", "scratch"], "where": [{"field": "name", "op": "eq", "value": "p2"}]}),
        )?;
        assert_ok(&stale);
        assert!(custom_values(&stale["data"][0]).is_empty(), "{stale}");
        // A request that reads no derived id returns no entry under one.
        for extra in [
            json!({"select": ["name"]}),
            json!({"kind": "aggregate", "metrics": [{"fn": "count"}]}),
        ] {
            let mut request = extra;
            request["where"] = json!([{"field": "name", "op": "eq", "value": "p2"}]);
            let plain = query(&mut client, "tenant_a", request)?;
            assert_ok(&plain);
            assert!(!plain.to_string().contains("\"99\""), "{plain}");
        }
        // Only requested computed columns are evaluated and returned; one that
        // another column reads is expanded inline.
        let chained = query(
            &mut client,
            "tenant_a",
            json!({"computed": [
                    {"id": "unused", "type": "number", "expression": {"type": "divide", "left": field("salary"), "right": number("0")}},
                    {"id": "base_pay", "type": "number", "expression": {"type": "multiply", "left": field("salary"), "right": number("3")}},
                    {"id": "doubled", "type": "number", "expression": {"type": "multiply", "left": field("base_pay"), "right": number("2")}}
                ],
                "select": ["name", "doubled"], "where": [{"field": "name", "op": "eq", "value": "p1"}]}),
        )?;
        assert_ok(&chained);
        let chained_values = custom_values(&chained["data"][0]);
        assert_eq!(
            chained_values.get("doubled"),
            Some(&json!("600")),
            "{chained}"
        );
        assert_eq!(chained_values.len(), 1, "{chained}");
        for (computed, message) in [
            (
                json!([{"id": "salary", "type": "number", "expression": number("1")}]),
                "reuses a field",
            ),
            (
                json!([{"id": "stipend", "type": "number", "expression": number("1")}]),
                "reuses a field",
            ),
            (
                json!([{"id": "compa_ratio", "type": "number", "expression": number("1")}]),
                "reuses a field",
            ),
            (
                json!([{"id": "a", "type": "number", "expression": field("b")}, {"id": "b", "type": "number", "expression": field("a")}]),
                "derived_cycle",
            ),
            (
                json!([{"id": "a", "type": "number", "expression": field("name")}]),
                "type_mismatch",
            ),
            (
                json!([{"id": "a", "type": "number", "expression": number("1"), "stored": true}]),
                "invalid computed column",
            ),
        ] {
            let rejected = query(
                &mut client,
                "tenant_a",
                json!({"computed": computed, "select": ["name"]}),
            )?;
            assert_eq!(
                rejected["error"]["code"], "contract_validation_failed",
                "{rejected}"
            );
            assert!(
                rejected.to_string().contains(message),
                "{message}: {rejected}"
            );
        }

        // Tenant B neither sees tenant A's definitions nor its rows.
        set_scope(&mut client, "tenant_b")?;
        let foreign = query(&mut client, "tenant_b", json!({"select": ["compa_ratio"]}))?;
        assert_eq!(foreign["ok"], false, "{foreign}");
        let foreign_computed = query(
            &mut client,
            "tenant_b",
            json!({"computed": [{"id": "copy", "type": "number", "expression": field("compa_ratio")}], "select": ["name"]}),
        )?;
        assert!(
            foreign_computed.to_string().contains("unknown_field"),
            "{foreign_computed}"
        );
        let tenant_b_cash = query(
            &mut client,
            "tenant_b",
            json!({"kind": "aggregate", "metrics": [{"fn": "count"}, {"fn": "sum", "field": "total_cash"}]}),
        )?;
        assert_eq!(
            tenant_b_cash["data"]["total"]["metrics"],
            json!(["1", "3"]),
            "{tenant_b_cash}"
        );

        // A base release that retires a field a tenant derived field reads is
        // not ready: readiness reports the derived issue instead of activating.
        set_scope(&mut client, "tenant_a")?;
        let mut retired: Value = client
            .query_one(
                "select schema from schema_revision where id=$1",
                &[&revision_a],
            )
            .map_err(|error| format!("read active schema: {error:?}"))?
            .get(0);
        for field in retired["models"][0]["fields"].as_array_mut().unwrap() {
            if field["id"] == "midpoint" {
                field["lifecycle"] = json!("retired");
            }
        }
        let readiness = prepared_readiness(&mut client, &retired, "derived-v2", 'a')?;
        assert_eq!(
            readiness["error"]["code"], "schema_revision_not_ready",
            "{readiness}"
        );
        assert!(
            detail_codes(&readiness).contains(&"unknown_field".to_string()),
            "{readiness}"
        );

        // A base release that declares a field id an active tenant custom field
        // already uses is not ready either.
        let mut colliding: Value = client
            .query_one(
                "select schema from schema_revision where id=$1",
                &[&revision_a],
            )
            .map_err(|error| format!("read active schema: {error:?}"))?
            .get(0);
        colliding["models"][0]["fields"]
            .as_array_mut()
            .unwrap()
            .push(
                json!({"id": "compa_ratio", "label": "Compa ratio", "type": "number",
                "origin": "app", "management": "fixed", "lifecycle": "active"}),
            );
        let readiness = prepared_readiness(&mut client, &colliding, "derived-v3", 'c')?;
        assert_eq!(
            readiness["error"]["code"], "schema_revision_not_ready",
            "{readiness}"
        );
        assert!(
            detail_codes(&readiness).contains(&"custom_field_declared_field_collision".to_string()),
            "{readiness}"
        );

        // Queries evaluate only the derived fields they read, so even a
        // drifted definition does not break unrelated reads and aggregates.
        client
            .execute(
                "update schema_revision set schema=$2 where id=$1",
                &[&revision_a, &retired],
            )
            .map_err(|error| format!("drift active schema: {error:?}"))?;
        let unrelated = query(
            &mut client,
            "tenant_a",
            json!({"select": ["name", "loaded_salary"]}),
        )?;
        assert_ok(&unrelated);
        assert_ok(&query(
            &mut client,
            "tenant_a",
            json!({"kind": "aggregate", "metrics": [{"fn": "sum", "field": "total_cash"}]}),
        )?);
        let drifted = query(&mut client, "tenant_a", json!({"select": ["compa_ratio"]}))?;
        assert_eq!(drifted["error"]["code"], "schema_drift", "{drifted}");

        // Derived money reads are canonical decimals: a passthrough of a
        // stored `100.50` amount reads as `100.5`.
        let mut passthrough = retired.clone();
        passthrough["custom_fields"].as_array_mut().unwrap().push(json!({
            "id": "position_base_copy", "model_id": "position", "field_id": "base_copy",
            "label": "base_copy", "type": "money_rate", "option_set": [], "expression": field("base"),
            "origin": "tenant", "management": "tenant_managed", "lifecycle": "active"
        }));
        client
            .execute(
                "update schema_revision set schema=$2 where id=$1",
                &[&revision_a, &passthrough],
            )
            .map_err(|error| format!("store passthrough: {error:?}"))?;
        client
            .execute(
                "update position_version set base_amount = 100.50 where name='p3'",
                &[],
            )
            .map_err(|error| format!("store trailing zero: {error:?}"))?;
        let copied = query(
            &mut client,
            "tenant_a",
            json!({"select": ["base", "base_copy"], "where": [{"field": "name", "op": "eq", "value": "p3"}]}),
        )?;
        assert_ok(&copied);
        assert_eq!(
            copied["data"][0]["values"]["base"]["value"]["amount"], "100.50",
            "{copied}"
        );
        assert_eq!(
            copied["data"][0]["custom_fields"],
            json!([{"field_id": "base_copy", "type": "money_rate",
                "value": {"amount": "100.5", "currency": "EUR", "period": "annual"}}]),
            "{copied}"
        );

        // A stored derived cycle that bypassed validation fails as schema
        // drift when read or lowered instead of recursing without bound.
        let mut cyclic = retired.clone();
        for (field_id, reads) in [
            ("loop_a", "loop_b"),
            ("loop_b", "loop_a"),
            ("loop_self", "loop_self"),
        ] {
            cyclic["custom_fields"].as_array_mut().unwrap().push(json!({
                "id": format!("position_{field_id}"), "model_id": "position", "field_id": field_id,
                "label": field_id, "type": "number", "option_set": [], "expression": field(reads),
                "origin": "tenant", "management": "tenant_managed", "lifecycle": "active"
            }));
        }
        client
            .execute(
                "update schema_revision set schema=$2 where id=$1",
                &[&revision_a, &cyclic],
            )
            .map_err(|error| format!("store derived cycle: {error:?}"))?;
        for loop_field in ["loop_a", "loop_self"] {
            let cycle = query(&mut client, "tenant_a", json!({"select": [loop_field]}))?;
            assert_eq!(cycle["error"]["code"], "schema_drift", "{cycle}");
        }
        let lowering = client
            .query_one(
                "select kernel_derived_value_sql($1, kernel_derived_environment($2, 'position'), '%L', '%L', null)",
                &[&field("loop_a"), &cyclic],
            )
            .expect_err("a derived cycle must not lower");
        assert!(
            lowering
                .as_db_error()
                .is_some_and(|error| error.message().starts_with("schema_drift:")),
            "{lowering:?}"
        );
        Ok(())
    })();

    let cleanup = trusted_human::drop_fixture(&mut client, &database_schema);
    result.expect("derived field PostgreSQL contract");
    cleanup.expect("drop isolated schema");
}

fn collision_manifest() -> Value {
    json!({
        "app_id": APP_ID, "customer_id": "tenant_a", "version": "collision-v1",
        "models": [{
            "id": "position", "kind": "entity", "label": "Position",
            "extensions": {"typed_custom_fields": true},
            "fields": [
                {"id": "name", "label": "Name", "type": "text", "required": true},
                {"id": "salary", "label": "Salary", "type": "number"}
            ],
            "many_relations": [{"id": "peers", "label": "Peers", "target_model": "position"}]
        }, {
            "id": "grade", "kind": "lookup", "label": "Grade", "display_field_id": "name",
            "management": "tenant_managed", "extensions": {"typed_custom_fields": true},
            "fields": [{"id": "name", "label": "Name", "type": "text", "required": true}]
        }]
    })
}

fn stored(id: &str, model_id: &str, field_id: &str) -> Value {
    json!({"type": "create_custom_field", "definition": {
        "id": id, "model_id": model_id, "field_id": field_id,
        "label": field_id, "type": "text", "option_set": []
    }})
}

#[test]
fn custom_field_collisions_are_rejected_when_new_and_recoverable_when_existing() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let compiled = compile_manifest_json(&collision_manifest().to_string()).expect("compile");
    let bundle =
        render_sql_artifact_bundle(&compile_sql_artifact_manifest(&compiled).expect("SQL bundle"));
    let mut client = connect_postgres(&database_url).expect("connect PostgreSQL");
    let database_schema = format!("kernel_collision_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            "create schema \"{database_schema}\"; set search_path to \"{database_schema}\""
        ))
        .expect("create isolated schema");

    let result = (|| -> Result<(), String> {
        client
            .batch_execute(&bundle)
            .map_err(|error| format!("install bundle: {error:?}"))?;
        let (revision, hash) = seed_active_schema(&mut client, &compiled.schema)?;
        set_scope(&mut client, "tenant_a")?;
        let dry_run = |client: &mut postgres::Client, key: &str, operations: Value| {
            call(
                client,
                "kernel_dry_run_tenant_schema_revision",
                &revision_request(revision, &hash, key, operations),
            )
        };
        let collision = "custom_field_declared_field_collision".to_string();

        // A many-relation id is declared too: neither a derived nor a stored
        // custom field may take it.
        for operations in [
            json!([derived("peers", "number", number("1"))]),
            json!([stored("position_peers", "position", "peers")]),
        ] {
            let rejected = dry_run(&mut client, "many-relation", operations)?;
            assert!(detail_codes(&rejected).contains(&collision), "{rejected}");
        }

        let committed = call(
            &mut client,
            "kernel_commit_tenant_schema_revision",
            &revision_request(
                revision,
                &hash,
                "collision-setup",
                json!([
                    stored("grade_band", "grade", "band"),
                    stored("position_legacy", "position", "legacy"),
                    stored("position_bonus", "position", "bonus"),
                    {"type": "retire_custom_field", "definition_id": "position_legacy"}
                ]),
            ),
        )?;
        assert_eq!(committed["ok"], true, "{committed}");
        let committed: TenantSchemaRevisionResult =
            serde_json::from_value(committed["data"].clone()).map_err(|e| e.to_string())?;
        let revision = committed.schema_revision_id.get();
        let hash = committed.effective_hash;
        let dry_run = |client: &mut postgres::Client, key: &str, operations: Value| {
            call(
                client,
                "kernel_dry_run_tenant_schema_revision",
                &revision_request(revision, &hash, key, operations),
            )
        };

        // A tenant-created lookup field may not take an active custom field id.
        let rejected = dry_run(
            &mut client,
            "create-field",
            json!([{"type": "create_field", "model_id": "grade",
                "field": {"id": "band", "label": "Band", "type": "text"}}]),
        )?;
        assert!(detail_codes(&rejected).contains(&collision), "{rejected}");

        // A computed column may not take a many-relation id or any custom
        // field id, retired ones included.
        let version: String = client
            .query_one(
                "select schema->>'version' from schema_revision where id=$1",
                &[&revision],
            )
            .map_err(|error| format!("read active version: {error:?}"))?
            .get(0);
        for (field_id, rejected) in [
            ("peers", true),
            ("legacy", true),
            ("bonus", true),
            ("extra", false),
        ] {
            let response = call(
                &mut client,
                "kernel_data_query",
                &json!({"app_id": APP_ID, "customer_id": "tenant_a", "schema_version": version,
                    "model_id": "position", "as_of": "2026-01-01", "select": ["name", field_id],
                    "computed": [{"id": field_id, "type": "number", "expression": number("1")}]}),
            )?;
            assert_eq!(response["ok"], !rejected, "{field_id}: {response}");
            if rejected {
                assert!(
                    response.to_string().contains("reuses a field"),
                    "{field_id}: {response}"
                );
            }
        }

        // Simulate a release that declares `legacy` and an older runtime that
        // let `bonus` collide: an active collision already exists.
        let mut active: Value = client
            .query_one(
                "select schema from schema_revision where id=$1",
                &[&revision],
            )
            .map_err(|error| format!("read active schema: {error:?}"))?
            .get(0);
        for field_id in ["legacy", "bonus"] {
            active["models"][0]["fields"]
                .as_array_mut()
                .unwrap()
                .push(json!({
                    "id": field_id, "label": field_id, "type": "number",
                    "origin": "app", "management": "fixed", "lifecycle": "active"
                }));
        }
        client
            .execute(
                "update schema_revision set schema=$2 where id=$1",
                &[&revision, &active],
            )
            .map_err(|error| format!("store collision: {error:?}"))?;

        // Restoring the retired field would create a new collision.
        let rejected = dry_run(
            &mut client,
            "restore",
            json!([{"type": "restore_custom_field", "definition_id": "position_legacy"}]),
        )?;
        assert!(detail_codes(&rejected).contains(&collision), "{rejected}");

        // The existing collision blocks neither unrelated tenant revisions,
        // nor retiring it, nor a release that keeps it.
        for (key, operations) in [
            (
                "unrelated",
                json!([stored("position_extra", "position", "extra")]),
            ),
            (
                "retire",
                json!([{"type": "retire_custom_field", "definition_id": "position_bonus"}]),
            ),
        ] {
            let accepted = dry_run(&mut client, key, operations)?;
            assert_eq!(accepted["ok"], true, "{key}: {accepted}");
        }
        let readiness = prepared_readiness(&mut client, &active, "collision-v2", 'd')?;
        assert!(
            !detail_codes(&readiness).contains(&collision),
            "{readiness}"
        );
        assert_eq!(readiness["ok"], true, "{readiness}");
        Ok(())
    })();

    let cleanup = client.batch_execute(&format!(
        "reset search_path; drop schema if exists \"{database_schema}\" cascade"
    ));
    result.expect("custom-field collision PostgreSQL contract");
    cleanup.expect("drop isolated schema");
}

/// Prepares an installation of `schema` and returns its readiness result.
fn prepared_readiness(
    client: &mut postgres::Client,
    schema: &Value,
    version: &str,
    hash_character: char,
) -> Result<Value, String> {
    let effective_hash = hash_character.to_string().repeat(64);
    let plan_hash = "b".repeat(64);
    let prepared: i64 = client
        .query_one(
            "insert into schema_revision (app_id,customer_id,version,base_schema,customer_overlay,schema,schema_hash,materialization_source)
             values ($1,'tenant_a',$2,$3,'{}'::jsonb,$3,$4,'test') returning id",
            &[&APP_ID, &version, schema, &effective_hash],
        )
        .map_err(|error| format!("prepare revision {version}: {error:?}"))?
        .get(0);
    client
        .execute(
            "insert into schema_installation_revision (schema_revision_id,app_id,customer_id,release_id,activation_kind,
               base_artifact_hash,effective_artifact_hash,materialization_plan_hash,expected_active_effective_hash,
               phase_plan,prepared_at)
             values ($1,$2,'tenant_a',$3,'tenant_overlay',$4,$4,$5,null,'[]'::jsonb,now())",
            &[&prepared, &APP_ID, &version, &effective_hash, &plan_hash],
        )
        .map_err(|error| format!("prepare installation {version}: {error:?}"))?;
    call(
        client,
        "kernel_validate_schema_revision_readiness",
        &json!({"app_id": APP_ID, "customer_id": "tenant_a", "schema_revision_id": prepared.to_string(),
            "effective_artifact_hash": effective_hash, "materialization_plan_hash": plan_hash, "phase_results": []}),
    )
}

fn custom_values(record: &Value) -> BTreeMap<String, Value> {
    record["custom_fields"]
        .as_array()
        .map(|entries| {
            entries
                .iter()
                .map(|entry| {
                    (
                        entry["field_id"].as_str().unwrap().to_string(),
                        entry["value"].clone(),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

fn names(response: &Value) -> Vec<String> {
    response["data"]
        .as_array()
        .unwrap_or(&Vec::new())
        .iter()
        .map(|record| {
            record["values"]["name"]["value"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect()
}

fn detail_codes(response: &Value) -> Vec<String> {
    response["error"]["details"]
        .as_array()
        .map(|details| {
            details
                .iter()
                .filter_map(|detail| detail["code"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn assert_ok(response: &Value) {
    assert_eq!(response["ok"], true, "{response}");
}

fn revision_request(revision: i64, hash: &str, key: &str, operations: Value) -> Value {
    json!({
        "app_id": APP_ID, "customer_id": "tenant_a", "actor_id": "admin_a",
        "reason": key, "idempotency_key": key,
        "expected_revision_id": revision, "expected_effective_hash": hash,
        "operations": operations
    })
}

fn apply(
    client: &mut postgres::Client,
    customer_id: &str,
    revision: i64,
    key: &str,
    writes: Value,
) -> Result<Value, String> {
    trusted_human::select(client, "fixture");
    let result = call(
        client,
        "kernel_apply_change_set",
        &json!({
            "app_id": APP_ID, "customer_id": customer_id, "schema_revision_id": revision,
            "actor_id": "fixture", "source_kind": "fixture", "idempotency_key": key,
            "mode": "mainline", "writes": writes
        }),
    );
    trusted_human::select(client, "admin_a");
    result
}

fn call(client: &mut postgres::Client, function: &str, request: &Value) -> Result<Value, String> {
    client
        .query_one(&format!("select {function}($1::jsonb)"), &[request])
        .map(|row| row.get(0))
        .map_err(|error| format!("call {function}: {error:?}"))
}

fn set_scope(client: &mut postgres::Client, customer_id: &str) -> Result<(), String> {
    client
        .query_one(
            "select set_config('kernel.app_id',$1,false), set_config('kernel.customer_id',$2,false), set_config('kernel.actor_id','admin_a',false)",
            &[&APP_ID, &customer_id],
        )
        .map(|_| ())
        .map_err(|error| format!("set scope: {error:?}"))
}

fn seed_active_schema(
    client: &mut postgres::Client,
    schema: &Schema,
) -> Result<(i64, String), String> {
    let schema_json = serde_json::to_value(schema).expect("serialize schema");
    let hash = schema_hash(schema);
    let revision_id: i64 = client
        .query_one(
            r#"
            insert into schema_revision (
              app_id, customer_id, version, base_schema, customer_overlay, schema,
              schema_hash, materialization_source, materialized_at, activated_at
            ) values ($1, $2, $3, $4, '{}'::jsonb, $4, $5, 'test', now(), now())
            returning id
            "#,
            &[
                &schema.app_id.as_str(),
                &schema.customer_id.as_str(),
                &schema.version.as_str(),
                &schema_json,
                &hash,
            ],
        )
        .map_err(|error| format!("seed schema revision: {error:?}"))?
        .get(0);
    client
        .execute(
            r#"
            insert into schema_installation_revision (
              schema_revision_id, app_id, customer_id, release_id, activation_kind,
              base_artifact_hash, effective_artifact_hash, materialization_plan_hash,
              expected_active_effective_hash, phase_plan, phase_results,
              prepared_at, ready_at, activated_at
            ) values ($1, $2, $3, 'base', 'tenant_overlay', $4, $4,
              kernel_admin_sha256(kernel_canonical_json('[]'::jsonb)), null,
              '[]'::jsonb, '[]'::jsonb, now(), now(), now())
            "#,
            &[
                &revision_id,
                &schema.app_id.as_str(),
                &schema.customer_id.as_str(),
                &hash,
            ],
        )
        .map_err(|error| format!("seed installation revision: {error:?}"))?;
    Ok((revision_id, hash))
}

fn test_database_url() -> Option<String> {
    match env::var("KERNEL_TEST_DATABASE_URL") {
        Ok(value) if !value.trim().is_empty() => Some(value),
        Ok(_) | Err(env::VarError::NotPresent) => {
            eprintln!("skipping derived field SQL test: KERNEL_TEST_DATABASE_URL is absent");
            None
        }
        Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
    }
}
