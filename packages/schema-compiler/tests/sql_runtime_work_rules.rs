#[path = "support/work_sessions.rs"]
mod support;
use serde_json::{json, Value};
use support::*;

fn field(id: &str) -> Value {
    json!({"type":"field","field":id})
}
fn number(value: &str) -> Value {
    json!({"type":"literal","value":{"type":"number","value":value}})
}
fn parameter(name: &str) -> Value {
    json!({"type":"parameter","parameter":name})
}
fn relation(field: &str) -> Value {
    json!({"type":"relation_field","relation":"parent","field":field})
}
fn binary(kind: &str, left: Value, right: Value) -> Value {
    json!({"type":kind,"left":left,"right":right})
}
/// A get's overlay, or the entries a mutation touched.
fn overlay(state: &Value) -> Value {
    let data = &state["data"];
    data.get("overlay").unwrap_or(&data["entries"]).clone()
}
fn entry(state: &Value, field_id: &str) -> Value {
    overlay(state)
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["field_id"] == field_id && entry["record_id"] == RECORD)
        .cloned()
        .unwrap_or(Value::Null)
}
/// The session's stored entries, without get's read-time annotations.
fn stored(f: &mut Fixture) -> Value {
    let read = f.work(json!({"operation":"get"}));
    assert_ok(&read);
    let mut read = read;
    for entry in read["data"]["overlay"].as_array_mut().unwrap() {
        for key in ["stale", "current_version", "current_value", "gone"] {
            entry.as_object_mut().unwrap().remove(key);
        }
    }
    read
}
fn create_rule(f: &mut Fixture, revision: i64, id: &str, rule: Value) -> Value {
    f.work(json!({"operation":"rule_create","expected_revision":revision,"request_id":id,"rule_id":id,"rule":rule}))
}

#[test]
fn rules_combine_two_relation_lookups() {
    let Some(mut f) = Fixture::new() else { return };
    assert_ok(&f.create());
    let result = create_rule(
        &mut f,
        1,
        "two-lookups",
        json!({"model_id":"item","field_id":"score",
            "value":binary("add", relation("score"), relation("custom_score"))}),
    );
    assert_ok(&result);
    assert_eq!(overlay(&result).as_array().unwrap().len(), 1);
    assert_eq!(entry(&result, "score")["value"]["value"], "17");
    assert_eq!(entry(&result, "score")["rule_id"], "two-lookups");
}

#[test]
fn rules_skip_manual_edits_and_remove_outputs_leaving_the_match_set() {
    for author in ["human", "agent"] {
        let Some(mut f) = Fixture::new() else { return };
        f.make_other_record_visible();
        assert_ok(&f.create());
        let staged = f.work(json!({"operation":"stage","changes":[{"model_id":"item","record_id":RECORD,"field_id":"score","value":{"type":"number","value":"12"}}]}));
        assert_ok(&staged);
        let manual = entry(&staged, "score");
        f.actor(author);
        let rule = json!({"model_id":"item","field_id":"score",
            "condition":{"type":"compare","op":"gte","left":field("score"),"right":number("0")},
            "value":parameter("score"),"parameters":{"score":{"type":"number","value":"20"}}});
        let ruled = create_rule(&mut f, 2, "filtered", rule);
        assert_ok(&ruled);
        // The manual edit wins; the other matching record takes the rule output.
        assert_eq!(entry(&ruled, "score"), Value::Null, "{author}");
        assert_eq!(entry(&stored(&mut f), "score"), manual, "{author}");
        let other = overlay(&ruled)
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["record_id"] == OTHER_RECORD)
            .cloned()
            .unwrap();
        assert_eq!(other["value"]["value"], "20");
        assert_eq!(other["rule_id"], "filtered");
        assert_eq!(other["baseline"]["value"], "900");
        assert_eq!(other["author_kind"], author);
        // The other record leaves the match set; re-evaluation removes its output.
        f.client
            .batch_execute("reset session authorization")
            .unwrap();
        f.client
            .execute(
                "update item_version set score=-1 where record_id=$1::text::uuid",
                &[&OTHER_RECORD],
            )
            .unwrap();
        f.actor(author);
        let reevaluated = f.work(
            json!({"operation":"rule_parameters","expected_revision":3,"request_id":"again",
            "rule_id":"filtered","parameters":{"score":{"type":"number","value":"30"}}}),
        );
        assert_ok(&reevaluated);
        assert_eq!(overlay(&reevaluated), json!([]));
        assert_eq!(
            reevaluated["data"]["removed"],
            json!([{"model_id":"item","record_id":OTHER_RECORD,"field_id":"score"}])
        );
        assert_eq!(overlay(&stored(&mut f)), json!([manual]));
        assert_eq!(
            f.query(json!({"work":f.work_ref()}))["data"][0]["values"]["score"]["value"],
            "12"
        );
    }
}

#[test]
fn rule_parameters_restage_without_compounding_and_removal_deletes_outputs() {
    let Some(mut f) = Fixture::new() else { return };
    let canonical = f.query(json!({}));
    assert_ok(&canonical);
    assert_ok(&f.create());
    let empty = f.query(json!({"work":f.work_ref()}));
    assert_eq!(empty, canonical);
    let rule = json!({"description":"Raise","model_id":"item","field_id":"score",
        "value":binary("multiply", field("score"), parameter("factor")),
        "parameters":{"factor":{"type":"number","value":"2"}}});
    let staged = create_rule(&mut f, 1, "raise", rule.clone());
    assert_ok(&staged);
    assert_eq!(staged["data"]["rule"]["author_kind"], "human");
    assert_eq!(
        f.query(json!({"work":f.work_ref()}))["data"][0]["values"]["score"]["value"],
        "20"
    );
    let first = entry(&staged, "score");
    let restaged = f.work(
        json!({"operation":"rule_parameters","expected_revision":2,"request_id":"parameters",
        "rule_id":"raise","parameters":{"factor":{"type":"number","value":"3"}}}),
    );
    assert_ok(&restaged);
    // The rule's own output is excluded while re-evaluating, so it never
    // compounds, and the entry keeps its first baseline and creation time.
    let second = entry(&restaged, "score");
    assert_eq!(second["value"]["value"], "30");
    assert_eq!(second["baseline"]["value"], "10");
    assert_eq!(second["created_at"], first["created_at"]);
    // Replaying the original request returns the current session; it does not
    // re-evaluate the rule with its original parameters.
    let replay = create_rule(&mut f, 1, "raise", rule);
    assert_ok(&replay);
    assert_eq!(replay["data"]["revision"], 3);
    assert_eq!(entry(&replay, "score")["value"]["value"], "30");
    let aggregate = f.call("kernel_data_query", json!({"app_id":APP,"customer_id":CUSTOMER,"schema_version":VERSION,
        "model_id":"item","as_of":"2026-01-01","kind":"aggregate","work":f.work_ref(),"metrics":[{"fn":"sum","field":"score"}]}));
    assert_ok(&aggregate);
    assert_eq!(aggregate["data"]["total"]["metrics"], json!(["30"]));
    let removed = f.work(json!({"operation":"rule_remove","expected_revision":3,"request_id":"remove","rule_id":"raise"}));
    assert_ok(&removed);
    assert_eq!(overlay(&removed), json!([]));
    assert_eq!(stored(&mut f)["data"]["rules"], json!({}));
    assert_eq!(f.query(json!({"work":f.work_ref()})), canonical);
    f.actor("other");
    assert_error(
        &f.query(json!({"work":f.work_ref()})),
        "authorization_denied",
    );
}

#[test]
fn rule_arithmetic_is_derived_arithmetic() {
    let Some(mut f) = Fixture::new() else { return };
    assert_ok(&f.create());
    // Division: 28 significant digits rounded half-even, as derived fields.
    let divided = create_rule(
        &mut f,
        1,
        "divide",
        json!({"model_id":"item","field_id":"score","value":binary("divide", field("score"), number("3"))}),
    );
    assert_ok(&divided);
    f.client
        .batch_execute("reset session authorization")
        .unwrap();
    let derived: String = f
        .client
        .query_one("select trim_scale(kernel_derived_divide(10,3))::text", &[])
        .unwrap()
        .get(0);
    f.actor("human");
    assert_eq!(derived, "3.333333333333333333333333333");
    assert_eq!(entry(&divided, "score")["value"]["value"], derived);
    // Division by zero is null, and a null result stages nothing.
    let by_zero = create_rule(
        &mut f,
        2,
        "zero",
        json!({"model_id":"item","field_id":"custom_score","value":binary("divide", field("score"), number("0"))}),
    );
    assert_ok(&by_zero);
    assert_eq!(entry(&by_zero, "custom_score"), Value::Null);
    // Money keeps its unit; mixing currencies is null, not a silent conversion.
    let money = create_rule(
        &mut f,
        3,
        "money",
        json!({"model_id":"item","field_id":"rate","value":binary("multiply", field("rate"), number("1.1"))}),
    );
    assert_ok(&money);
    assert_eq!(
        entry(&money, "rate")["value"]["value"],
        json!({"amount":"110","currency":"USD","period":"annual"})
    );
    let mixed = f.work(json!({"operation":"rule_create","expected_revision":4,"request_id":"eur","rule_id":"eur",
        "rule":{"model_id":"item","field_id":"rate","value":binary("add", field("rate"), parameter("bonus")),
            "parameters":{"bonus":{"type":"money_rate","value":{"amount":"1","currency":"EUR","period":"annual"}}}}}));
    assert_ok(&mixed);
    // The EUR sum is null; the existing USD output of the other rule stays.
    assert_eq!(overlay(&mixed), json!([]));
    assert_eq!(entry(&stored(&mut f), "rate")["rule_id"], "money");
    // Comparisons, conditionals and clamp: if(score < 20, clamp(score + p, 0, 12), 1 / 0).
    let conditional = create_rule(
        &mut f,
        5,
        "conditional",
        json!({"model_id":"item","field_id":"custom_score","parameters":{"p":{"type":"number","value":"5"}},
            "value":{"type":"if","condition":{"type":"compare","op":"lt","left":field("score"),"right":number("20")},
                "then":{"type":"clamp","expression":binary("add", field("score"), parameter("p")),"min":number("0"),"max":number("12")},
                "else":binary("divide", number("1"), number("0"))}}),
    );
    assert_ok(&conditional);
    // The rule reads the overlay: score is staged at 10/3 by the divide rule.
    assert_eq!(
        entry(&conditional, "custom_score")["value"]["value"],
        "8.333333333333333333333333333"
    );
    assert_eq!(
        entry(&conditional, "custom_score")["rule_id"],
        "conditional"
    );
}

#[test]
fn rule_definitions_are_typed_derived_expressions() {
    let Some(mut f) = Fixture::new() else { return };
    assert_ok(&f.create());
    let rule = |value: Value| json!({"model_id":"item","field_id":"score","value":value,"parameters":{"p":{"type":"number","value":"5"}}});
    for (id, value, code) in [
        ("code", json!({"sql":"select pg_sleep(10)"}), None),
        (
            "type",
            json!({"type":"literal","value":{"type":"bool","value":true}}),
            Some("type_mismatch"),
        ),
        ("missing", parameter("absent"), Some("unknown_parameter")),
        ("unknown", field("absent"), Some("unknown_field")),
        (
            "derived-only",
            json!({"type":"inverse_aggregate","inverse_relation":"children","aggregate":"count"}),
            Some("unsupported_derived_expression"),
        ),
    ] {
        let result = create_rule(&mut f, 1, id, rule(value));
        assert_error(&result, "contract_validation_failed");
        if let Some(code) = code {
            assert_eq!(
                result["error"]["details"][0]["code"], code,
                "{id}: {result}"
            );
        }
    }
    let bad_parameter = f.work(json!({"operation":"rule_create","expected_revision":1,"request_id":"bad-parameter","rule_id":"bad-parameter",
        "rule":{"model_id":"item","field_id":"score","value":parameter("p"),"parameters":{"p":"5"}}}));
    assert_error(&bad_parameter, "contract_validation_failed");
    let condition = f.work(json!({"operation":"rule_create","expected_revision":1,"request_id":"condition","rule_id":"condition",
        "rule":{"model_id":"item","field_id":"score","value":number("1"),"condition":field("score")}}));
    assert_error(&condition, "contract_validation_failed");
    let hidden = create_rule(&mut f, 1, "secret", rule(field("secret")));
    assert_error(&hidden, "authorization_denied");
    let current = f.work(json!({"operation":"get"}));
    assert_eq!(current["data"]["revision"], 1);
    assert_eq!(current["data"]["rules"], json!({}));
}

#[test]
fn rules_use_authorized_lookups_money_and_active_custom_fields() {
    let Some(mut f) = Fixture::new() else { return };
    assert_ok(&f.create());
    let staged = f.work(json!({"operation":"stage","changes":[{"model_id":"item","record_id":RECORD,"field_id":"custom_score","value":{"type":"number","value":"14"}}]}));
    assert_ok(&staged);
    // The lookup reads the related record through the overlay.
    let lookup = create_rule(
        &mut f,
        2,
        "lookup",
        json!({"model_id":"item","field_id":"score","value":relation("custom_score")}),
    );
    assert_ok(&lookup);
    assert_eq!(
        f.query(json!({"work":f.work_ref()}))["data"][0]["values"]["score"]["value"],
        "14"
    );
    // A rule never replaces the manual custom_score edit.
    let custom = create_rule(
        &mut f,
        3,
        "custom-rule",
        json!({"model_id":"item","field_id":"custom_score","value":binary("add", field("custom_score"), number("1"))}),
    );
    assert_ok(&custom);
    assert_eq!(overlay(&custom), json!([]));
    let current = stored(&mut f);
    assert_eq!(entry(&current, "custom_score")["value"]["value"], "14");
    assert!(entry(&current, "custom_score").get("rule_id").is_none());
    let denied = create_rule(
        &mut f,
        4,
        "lookup-secret",
        json!({"model_id":"item","field_id":"score","value":relation("secret")}),
    );
    assert_error(&denied, "authorization_denied");
}

#[test]
fn rule_scan_exceeds_one_page_and_overlay_totals_are_exact() {
    let Some(mut f) = Fixture::new() else { return };
    f.client
        .batch_execute("reset session authorization")
        .unwrap();
    f.client.batch_execute(&format!(r#"
      insert into item_record(id,app_id,customer_id,external_key)
        select md5('work-scale-record-'||n)::uuid,'{APP}','{CUSTOMER}','bulk-'||n from generate_series(1,137) n;
      insert into item_version(id,record_id,app_id,customer_id,stage,effective_start,change_set_id,applied_at,owner,score)
        select md5('work-scale-version-'||n)::uuid,md5('work-scale-record-'||n)::uuid,
          '{APP}','{CUSTOMER}','mainline','2026-01-01',1,now(),'human',1 from generate_series(1,137) n;
    "#)).unwrap();
    f.actor("human");
    assert_ok(&f.create());
    let rule = create_rule(
        &mut f,
        1,
        "bulk",
        json!({"model_id":"item","field_id":"score","value":binary("add", field("score"), number("1"))}),
    );
    assert_ok(&rule);
    assert_eq!(overlay(&rule).as_array().unwrap().len(), 138);
    let aggregate = f.call("kernel_data_query", json!({"app_id":APP,"customer_id":CUSTOMER,"schema_version":VERSION,"model_id":"item","as_of":"2026-01-01","kind":"aggregate",
      "work":f.work_ref(),"metrics":[{"fn":"count"},{"fn":"sum","field":"score"}]}));
    assert_ok(&aggregate);
    assert_eq!(aggregate["data"]["total"]["metrics"], json!(["138", "285"]));
    let denied = f.work(json!({"operation":"stage","changes":[{"model_id":"item","record_id":RECORD,"field_id":"owner","value":{"type":"text","value":"other"}}]}));
    assert_error(&denied, "authorization_denied");
}

#[test]
fn relation_lookups_authorize_only_when_used() {
    let Some(mut f) = Fixture::new() else { return };
    assert_ok(&f.create());
    let value = json!({"type":"if","condition":{"type":"compare","op":"gt","left":field("score"),"right":number("0")},
        "then":number("20"),"else":relation("secret")});
    // The unused lookup branch neither reads nor authorizes secret.
    let allowed = create_rule(
        &mut f,
        1,
        "lazy",
        json!({"model_id":"item","field_id":"score","value":value}),
    );
    assert_ok(&allowed);
    assert_eq!(entry(&allowed, "score")["value"]["value"], "20");
    let denied = create_rule(
        &mut f,
        2,
        "used",
        json!({"model_id":"item","field_id":"custom_score","value":relation("secret")}),
    );
    assert_error(&denied, "authorization_denied");
    // An empty relation is null, so the other record gets no output.
    f.make_other_record_visible();
    let empty = create_rule(
        &mut f,
        2,
        "empty",
        json!({"model_id":"item","field_id":"custom_score","value":relation("score")}),
    );
    assert_ok(&empty);
    assert!(!overlay(&empty)
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["record_id"] == OTHER_RECORD));
}

#[test]
fn derived_custom_fields_are_computed_from_overlaid_staged_values() {
    let Some(mut f) = Fixture::with_derived() else {
        return;
    };
    let derived = |result: &Value, id: &str| {
        result["custom_fields"]
            .as_array()
            .and_then(|entries| entries.iter().find(|entry| entry["field_id"] == id))
            .map(|entry| entry["value"].clone())
    };
    let select = json!(["$id", "score", "double_score", "parent_score"]);
    let canonical = f.query(json!({"select":select}));
    assert_ok(&canonical);
    assert_eq!(
        derived(&canonical["data"][0], "double_score"),
        Some(json!("20")),
        "{canonical}"
    );
    // relation_field reads the related record (here the record itself).
    assert_eq!(
        derived(&canonical["data"][0], "parent_score"),
        Some(json!("10")),
        "{canonical}"
    );
    assert_ok(&f.create());
    let work = f.work_ref();
    // A derived field is never writable, so it cannot be staged; the revision is unchanged.
    let read_only=f.work(json!({"operation":"stage","changes":[{"model_id":"item","record_id":RECORD,"field_id":"double_score","value":{"type":"number","value":"1"}}]}));
    assert_error(&read_only, "authorization_denied");
    let stage=f.work(json!({"operation":"stage","changes":[{"model_id":"item","record_id":RECORD,"field_id":"score","value":{"type":"number","value":"12"}}]}));
    assert_ok(&stage);
    // Overlay first, then derive: impact reads see derived values over staged values.
    let visible = f.query(json!({"select":select,"work":work}));
    assert_ok(&visible);
    assert_eq!(visible["data"][0]["values"]["score"]["value"], "12");
    assert_eq!(
        derived(&visible["data"][0], "double_score"),
        Some(json!("24")),
        "{visible}"
    );
    assert_eq!(
        derived(&visible["data"][0], "parent_score"),
        Some(json!("12")),
        "{visible}"
    );
    let filtered = f.query(json!({"select":select,"work":work,"where":[{"field":"double_score","op":"eq","value":"24"}]}));
    assert_eq!(
        filtered["data"].as_array().map(Vec::len),
        Some(1),
        "{filtered}"
    );
    let stale = f.query(json!({"select":select,"work":work,"where":[{"field":"double_score","op":"eq","value":"20"}]}));
    assert_eq!(stale["data"], json!([]), "{stale}");
    let aggregate=f.call("kernel_data_query",json!({"app_id":APP,"customer_id":CUSTOMER,"schema_version":VERSION,"model_id":"item","as_of":"2026-01-01","kind":"aggregate","work":work,"metrics":[{"fn":"sum","field":"double_score"},{"fn":"sum","field":"parent_score"}]}));
    assert_ok(&aggregate);
    assert_eq!(aggregate["data"]["total"]["metrics"], json!(["24", "12"]));
    // Mainline reads are unchanged by the session.
    assert_eq!(f.query(json!({"select":select})), canonical);
}

#[test]
fn computed_columns_read_relation_lookups_over_the_overlay() {
    let Some(mut f) = Fixture::new() else { return };
    let computed =
        |expression: Value| json!([{"id":"parent_double","type":"number","expression":expression}]);
    let value = |result: &Value| result["data"][0]["custom_fields"][0]["value"].clone();
    let doubled = computed(binary("multiply", relation("score"), number("2")));
    let select = json!(["$id", "parent_double"]);
    // relation_field reads the related record (here the record itself).
    let canonical = f.query(json!({"computed":doubled,"select":select}));
    assert_ok(&canonical);
    assert_eq!(value(&canonical), json!("20"), "{canonical}");
    assert_ok(&f.create());
    let staged = f.work(json!({"operation":"stage","changes":[{"model_id":"item","record_id":RECORD,"field_id":"score","value":{"type":"number","value":"12"}}]}));
    assert_ok(&staged);
    let overlaid = f.query(json!({"computed":doubled,"select":select,"work":f.work_ref()}));
    assert_ok(&overlaid);
    assert_eq!(value(&overlaid), json!("24"), "{overlaid}");
    // The related field is authorized by the lookup's own query.
    let secret = f.query(json!({"computed":computed(relation("secret")),"select":select}));
    assert_error(&secret, "authorization_denied");
    // Parameters belong to working-session rules only.
    let parameterized = f.query(json!({"computed":computed(parameter("cap")),"select":select}));
    assert_error(&parameterized, "contract_validation_failed");
    assert!(
        parameterized["error"]["details"][0]["message"]
            .as_str()
            .is_some_and(|message| message.contains("unsupported_derived_expression")),
        "{parameterized}"
    );
}

#[test]
fn private_scan_is_not_a_runtime_entrypoint() {
    let Some(mut f) = Fixture::new() else { return };
    for call in [
        "select kernel_data_query_core('{}'::jsonb,null,true)",
        "select kernel_data_query_scan('{}'::jsonb,null)",
    ] {
        let denied = f
            .client
            .query_one(call, &[])
            .expect_err("private scan is not a runtime entrypoint");
        assert_eq!(denied.as_db_error().unwrap().code().code(), "42501");
    }
}

#[test]
fn rule_responses_report_only_cells_held_by_another_rule() {
    let Some(mut f) = Fixture::new() else { return };
    f.make_other_record_visible();
    assert_ok(&f.create());
    let when = |op: &str, n: &str| json!({"type":"compare","op":op,"left":field("score"),"right":number(n)});
    // Rule a holds RECORD (score 10).
    let a = create_rule(
        &mut f,
        1,
        "a",
        json!({"model_id":"item","field_id":"score","condition":when("lt","100"),"value":number("1")}),
    );
    assert_eq!(a["data"]["overlaps"], json!([]));
    // Rule b matches both records; the first rule keeps RECORD.
    let b = create_rule(
        &mut f,
        2,
        "b",
        json!({"model_id":"item","field_id":"score","value":number("5")}),
    );
    assert_ok(&b);
    assert_eq!(b["data"]["overlaps"], json!([{"rule_id":"a","records":1}]));
    assert_eq!(overlay(&b).as_array().unwrap().len(), 1);
    assert_eq!(overlay(&b)[0]["record_id"], OTHER_RECORD);
    let again = f.work(json!({"operation":"rule_parameters","expected_revision":3,"request_id":"b-again","rule_id":"b","parameters":{}}));
    assert_eq!(
        again["data"]["overlaps"],
        json!([{"rule_id":"a","records":1}])
    );
    // Targeting the same field without colliding cells is not an overlap.
    let none = create_rule(
        &mut f,
        4,
        "none",
        json!({"model_id":"item","field_id":"score","condition":when("eq","12345"),"value":number("7")}),
    );
    assert_ok(&none);
    assert_eq!(none["data"]["overlaps"], json!([]));
}

#[test]
fn rule_writes_are_authorized_against_canonical_predicate_values() {
    let Some(mut f) = Fixture::with_owner_scoped_updates() else {
        return;
    };
    assert_ok(&f.create());
    let when = |op: &str, n: &str| json!({"type":"compare","op":op,"left":field("score"),"right":number(n)});
    // A constant rule that never reads `owner` still passes `owner = actor`.
    let constant = create_rule(
        &mut f,
        1,
        "constant",
        json!({"model_id":"item","field_id":"score","condition":when("lt","100"),"value":number("5")}),
    );
    assert_ok(&constant);
    assert_eq!(entry(&constant, "score")["value"]["value"], "5");
    // A staged ownership change does not grant update authority over the
    // canonical owner's record.
    f.client
        .batch_execute(&format!(
            "reset session authorization;
             insert into work_session_record(app_id,customer_id,session_id,model_id,record_id,field_id,value,baseline,base_version,
               source,actor_id,author_principal,author_kind,created_at,updated_at)
             values('{APP}','{CUSTOMER}','{}','item','{OTHER_RECORD}','owner','{{\"type\":\"text\",\"value\":\"human\"}}',
               '{{\"type\":\"text\",\"value\":\"other\"}}','00000000-0000-0000-0000-000000000012','user','human','{}','human',now(),now())",
            f.session_id, f.principal
        ))
        .unwrap();
    f.actor("agent");
    let denied = create_rule(
        &mut f,
        2,
        "staged-owner",
        json!({"model_id":"item","field_id":"score","condition":when("gt","500"),"value":number("1")}),
    );
    assert_error(&denied, "authorization_denied");
}

#[test]
fn rule_outputs_get_field_level_currency_checks() {
    let Some(mut f) = Fixture::new() else { return };
    assert_ok(&f.create());
    let result = create_rule(
        &mut f,
        1,
        "zzz",
        json!({"model_id":"item","field_id":"rate","value":parameter("rate"),
            "parameters":{"rate":{"type":"money_rate","value":{"amount":"1","currency":"ZZZ","period":"annual"}}}}),
    );
    assert_error(&result, "contract_validation_failed");
    assert_eq!(
        f.work(json!({"operation":"get"}))["data"]["overlay"],
        json!([])
    );
}
