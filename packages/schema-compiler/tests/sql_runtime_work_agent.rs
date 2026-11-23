#[path = "support/work_sessions.rs"]
mod support;
use serde_json::{json, Value};
use support::*;

const TURN: &str = "00000000-0000-4000-8000-0000000000a1";
const NEXT_TURN: &str = "00000000-0000-4000-8000-0000000000a2";

fn change(field: &str, n: &str) -> Value {
    json!({"model_id":"item","record_id":RECORD,"field_id":field,"value":{"type":"number","value":n}})
}
/// Marks the connection as the platform agent context for one turn.
fn mark(f: &mut Fixture, turn: Option<&str>) {
    f.client
        .batch_execute(&format!(
            "set kernel.actor_kind='agent'; set kernel.turn_id='{}'",
            turn.unwrap_or("")
        ))
        .unwrap();
}
fn unmark(f: &mut Fixture) {
    f.client
        .batch_execute("reset kernel.actor_kind; reset kernel.turn_id")
        .unwrap();
}
fn revision(f: &mut Fixture) -> i64 {
    let read = f.work(json!({"operation":"get","overlay":false}));
    assert_ok(&read);
    read["data"]["revision"].as_i64().unwrap()
}
fn stage(f: &mut Fixture, _id: &str, changes: Value) -> Value {
    f.work(json!({"operation":"stage","changes":changes}))
}
/// Stored entries keyed by field, without read-time annotations.
fn entry(f: &mut Fixture, field: &str) -> Value {
    let read = f.work(json!({"operation":"get"}));
    assert_ok(&read);
    read["data"]["overlay"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["field_id"] == field && entry["record_id"] == RECORD)
        .cloned()
        .unwrap_or(Value::Null)
}
fn apply(f: &mut Fixture, mode: &str) -> Value {
    f.call(
        "kernel_apply_change_set",
        json!({
            "app_id":APP,"customer_id":CUSTOMER,"actor_id":"human","source_kind":"fixture","mode":mode,
            "idempotency_key":format!("agent-{mode}-{}", uuid::Uuid::new_v4()),
            "writes":[{"model_id":"item","record_key":{"type":"record_id","value":RECORD},
            "effective_start":"2026-01-01","values":{"score":{"type":"number","value":"21"}}}]
        }),
    )
}

fn marked_caller_writes_only_working_state(mut f: Fixture, policy: bool) {
    f.actor("human");
    assert_ok(&f.create());
    // A human principal in a marked context is an agent.
    mark(&mut f, Some(TURN));
    for (operation, extra) in [
        (
            "duplicate",
            json!({"session_id":uuid::Uuid::new_v4().to_string(),"expected_revision":0,"title":"Copy","source_session_id":f.session_id}),
        ),
        ("archive", json!({"expected_revision":1})),
        ("unarchive", json!({"expected_revision":1})),
        (
            "update",
            json!({"expected_revision":1,"patch":{"title":"x"}}),
        ),
        ("pin", json!({"expected_revision":1,"pinned":true})),
        ("pull", json!({"expected_revision":1,"thread_id":"t"})),
        ("save", json!({"expected_revision":1})),
    ] {
        let mut request = json!({"operation":operation,"request_id":format!("marked-{operation}")});
        request
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        assert_error(&f.work(request), "authorization_denied");
    }
    // Agent work-session operations still run.
    assert_ok(&stage(
        &mut f,
        "agent-stage",
        json!([change("score", "12")]),
    ));
    // Every canonical mutation is refused, whatever the app declares.
    for mode in ["mainline", "draft"] {
        let refused = apply(&mut f, mode);
        assert_error(&refused, "authorization_denied");
        assert_eq!(
            refused["error"]["details"][0]["code"], "agent_canonical_write_forbidden",
            "{refused}"
        );
    }
    let scope = json!({"app_id":APP,"customer_id":CUSTOMER,"actor_id":"human","change_set_id":1,"idempotency_key":"marked"});
    for function in [
        "kernel_apply_change_set_in_transaction",
        "kernel_approve_draft_change_set",
        "kernel_discard_draft_change_set",
        "kernel_update_draft_notes",
        "kernel_revert_change_set",
        "kernel_lookup_set_availability",
        "kernel_lookup_transfer_alias",
        "kernel_record_agent_run",
        "kernel_update_agent_run_status",
    ] {
        assert_error(&f.call(function, scope.clone()), "authorization_denied");
    }
    // The same human, unmarked, is unchanged.
    unmark(&mut f);
    assert_ok(&apply(&mut f, "mainline"));
    if !policy {
        let draft = apply(&mut f, "draft");
        assert_ok(&draft);
        let id = draft["data"]["id"].as_i64().unwrap();
        mark(&mut f, Some(TURN));
        let approve =
            json!({"app_id":APP,"customer_id":CUSTOMER,"actor_id":"human","change_set_id":id});
        assert_error(
            &f.call("kernel_approve_draft_change_set", approve.clone()),
            "authorization_denied",
        );
        unmark(&mut f);
        assert_ok(&f.call("kernel_approve_draft_change_set", approve));
        mark(&mut f, Some(TURN));
        let revert = json!({"app_id":APP,"customer_id":CUSTOMER,"actor_id":"human","change_set_id":id,"idempotency_key":"agent-revert"});
        assert_error(
            &f.call("kernel_revert_change_set", revert.clone()),
            "authorization_denied",
        );
        unmark(&mut f);
        assert_ok(&f.call("kernel_revert_change_set", revert));
    }
    let rev = revision(&mut f);
    assert_ok(&f.work(
        json!({"operation":"pin","expected_revision":rev,"request_id":"human-pin","pinned":true}),
    ));
}

#[test]
fn marked_caller_cannot_run_human_operations_or_canonical_writes_under_a_policy() {
    let Some(f) = Fixture::new() else { return };
    marked_caller_writes_only_working_state(f, true);
}

#[test]
fn marked_caller_cannot_run_human_operations_or_canonical_writes_without_a_policy() {
    let Some(f) = Fixture::without_policy() else {
        return;
    };
    marked_caller_writes_only_working_state(f, false);
}

#[test]
fn an_agent_starts_a_session_owned_by_and_private_to_its_person() {
    let Some(mut f) = Fixture::new() else { return };
    f.actor("human");
    mark(&mut f, Some(TURN));
    // Like `git checkout -b`: the session belongs to the person the agent acts for.
    let created = f.create();
    assert_ok(&created);
    // A replay repeats no effect.
    assert_ok(&f.create());
    let read = f.work(json!({"operation":"get","overlay":false}));
    assert_ok(&read);
    assert_eq!(read["data"]["owner_id"], "human", "{read}");
    assert_eq!(read["data"]["title"], "Test", "{read}");
    assert_eq!(read["data"]["as_of"], "2026-01-01", "{read}");
    assert_eq!(read["data"]["scope"], json!({}), "{read}");
    assert_eq!(read["data"]["revision"], 1, "{read}");
    // The agent goes on working in it.
    assert_ok(&stage(
        &mut f,
        "agent-stage",
        json!([change("score", "12")]),
    ));
    assert_eq!(entry(&mut f, "score")["turn_id"], TURN);
    // The person sees it unmarked; nobody else does.
    unmark(&mut f);
    let listed = f.work(json!({"operation":"list"}));
    assert_ok(&listed);
    assert!(
        listed["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["id"] == f.session_id.as_str()),
        "{listed}"
    );
    f.actor("other");
    assert_error(
        &f.work(json!({"operation":"get","overlay":false})),
        "authorization_denied",
    );
    let listed = f.work(json!({"operation":"list"}));
    assert_ok(&listed);
    assert_eq!(listed["data"], json!([]), "{listed}");
    // Save and the other human operations stay the person's.
    f.actor("human");
    mark(&mut f, Some(TURN));
    let rev = revision(&mut f);
    for (operation, extra) in [
        ("save", json!({})),
        ("archive", json!({})),
        ("pin", json!({"pinned":true})),
    ] {
        let mut request = json!({"operation":operation,"expected_revision":rev,"request_id":format!("after-{operation}")});
        request
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        assert_error(&f.work(request), "authorization_denied");
    }
}

#[test]
fn the_mark_cannot_make_a_membership_agent_human() {
    let Some(mut f) = Fixture::new() else { return };
    assert_ok(&f.create());
    f.actor("agent");
    for kind in ["human", "", "service"] {
        f.client
            .batch_execute(&format!("set kernel.actor_kind='{kind}'"))
            .unwrap();
        assert_error(
            &f.work(
                json!({"operation":"pin","expected_revision":1,"request_id":"pin","pinned":true}),
            ),
            "authorization_denied",
        );
        assert_error(&apply(&mut f, "mainline"), "authorization_denied");
        // An unmarked membership agent stages without a turn.
        let staged = f.work(
            json!({"operation":"stage","changes":[change("score", &format!("1{}", kind.len()))]}),
        );
        assert_ok(&staged);
        assert!(
            staged["data"]["entries"][0].get("turn_id").is_none(),
            "{staged}"
        );
    }
}

#[test]
fn human_callers_keep_the_protected_request_protocol() {
    let Some(mut f) = Fixture::new() else { return };
    f.actor("human");
    assert_ok(&f.create());
    f.client
        .batch_execute("reset session authorization; update kernel_principal_scope set actor_binding_required=true; update kernel_actor_membership set fence_generation=1")
        .unwrap();
    let fence: i64 = f
        .client
        .query_one(
            "select fence_generation from kernel_actor_membership where principal_name=$1 and actor_id='human'",
            &[&f.principal],
        )
        .unwrap()
        .get(0);
    f.actor("human");
    f.client
        .batch_execute(&format!(
            "set kernel.actor_role='editor'; set kernel.actor_fence_generation='{fence}'"
        ))
        .unwrap();
    // A human mutation without a verified request is refused.
    let refused = stage(&mut f, "human", json!([change("score", "12")]));
    assert_error(&refused, "authorization_denied");
    assert_eq!(
        refused["error"]["details"][0]["code"], "http_request_required",
        "{refused}"
    );
    // The marked agent context stages last-write-wins, without the protocol.
    mark(&mut f, Some(TURN));
    let staged = stage(&mut f, "agent", json!([change("score", "12")]));
    assert_ok(&staged);
    let restaged = f.work(json!({"operation":"stage","changes":[change("score", "12")]}));
    assert_ok(&restaged);
    assert_error(&apply(&mut f, "mainline"), "authorization_denied");
}

#[test]
fn agent_staging_stamps_the_context_turn_and_restaging_moves_it() {
    let Some(mut f) = Fixture::new() else { return };
    f.actor("human");
    assert_ok(&f.create());
    f.actor("agent");
    mark(&mut f, Some(TURN));
    // Request input never supplies a turn.
    let mut supplied = change("score", "12");
    supplied["turn_id"] = json!(NEXT_TURN);
    let staged = stage(&mut f, "first", json!([supplied]));
    assert_ok(&staged);
    assert_eq!(staged["data"]["entries"][0]["turn_id"], TURN);
    assert_eq!(entry(&mut f, "score")["turn_id"], TURN);
    // Restaging in a later turn moves the entry to that turn.
    mark(&mut f, Some(NEXT_TURN));
    assert_ok(&stage(&mut f, "second", json!([change("score", "13")])));
    assert_eq!(entry(&mut f, "score")["turn_id"], NEXT_TURN);
    // A malformed turn is rejected without staging.
    mark(&mut f, Some("not-a-uuid"));
    assert_error(
        &stage(&mut f, "bad", json!([change("score", "14")])),
        "contract_validation_failed",
    );
    // A human edit leaves no turn, including over an agent's entry.
    unmark(&mut f);
    f.actor("human");
    assert_ok(&stage(
        &mut f,
        "human",
        json!([change("custom_score", "8")]),
    ));
    assert!(entry(&mut f, "custom_score").get("turn_id").is_none());
    assert_ok(&stage(&mut f, "human-over", json!([change("score", "15")])));
    assert!(entry(&mut f, "score").get("turn_id").is_none());
    // Duplicate copies entries without their turn.
    f.client
        .batch_execute("reset session authorization")
        .unwrap();
    f.client
        .execute(
            "update work_session_record set turn_id=$1::text::uuid where field_id='score'",
            &[&TURN],
        )
        .unwrap();
    f.actor("human");
    let copy = uuid::Uuid::new_v4().to_string();
    assert_ok(&f.work(json!({"operation":"duplicate","session_id":copy,"expected_revision":0,"request_id":"copy","title":"Copy","source_session_id":f.session_id})));
    let original = f.session_id.clone();
    f.session_id = copy;
    assert!(entry(&mut f, "score").get("turn_id").is_none());
    f.session_id = original;
    assert_eq!(entry(&mut f, "score")["turn_id"], TURN);
}

#[test]
fn agent_rule_outputs_follow_the_turn_that_restaged_them() {
    let Some(mut f) = Fixture::new() else { return };
    f.actor("human");
    assert_ok(&f.create());
    f.actor("agent");
    mark(&mut f, Some(TURN));
    let rule = json!({"model_id":"item","field_id":"score","value":{"type":"parameter","parameter":"x"},
        "parameters":{"x":{"type":"number","value":"5"}}});
    let created = f.work(json!({"operation":"rule_create","expected_revision":1,"request_id":"rule","rule_id":"r","rule":rule}));
    assert_ok(&created);
    assert_eq!(created["data"]["entries"][0]["turn_id"], TURN);
    mark(&mut f, Some(NEXT_TURN));
    let reparam = f.work(json!({"operation":"rule_parameters","expected_revision":2,"request_id":"reparam","rule_id":"r",
        "parameters":{"x":{"type":"number","value":"6"}}}));
    assert_ok(&reparam);
    assert_eq!(reparam["data"]["entries"][0]["turn_id"], NEXT_TURN);
    // A human re-evaluation of an agent's rule leaves its outputs without a turn.
    unmark(&mut f);
    f.actor("human");
    let human = f.work(json!({"operation":"rule_parameters","expected_revision":3,"request_id":"human-reparam","rule_id":"r",
        "parameters":{"x":{"type":"number","value":"7"}}}));
    assert_ok(&human);
    assert!(
        human["data"]["entries"][0].get("turn_id").is_none(),
        "{human}"
    );
}

#[test]
fn discard_turn_removes_one_turns_entries_by_authority() {
    let Some(mut f) = Fixture::new() else { return };
    f.actor("human");
    assert_ok(&f.create());
    assert_ok(&f.work(json!({"operation":"thread_open","expected_revision":1,"request_id":"open","thread_id":"t","anchor":{}})));
    f.actor("agent");
    mark(&mut f, Some(TURN));
    assert_ok(&stage(&mut f, "agent", json!([change("score", "12")])));
    f.actor("agent2");
    mark(&mut f, Some(TURN));
    assert_ok(&stage(
        &mut f,
        "agent2",
        json!([change("custom_score", "8")]),
    ));
    mark(&mut f, Some(NEXT_TURN));
    assert_ok(&stage(
        &mut f,
        "agent2-next",
        json!([{"model_id":"item","record_id":RECORD,"field_id":"rate",
        "value":{"type":"money_rate","value":{"amount":"5","currency":"USD","period":"annual"}}}]),
    ));
    // An agent discards only the entries it authored in the turn.
    f.actor("agent");
    mark(&mut f, Some(NEXT_TURN));
    assert_error(
        &f.work(json!({"operation":"discard_turn","turn_id":"x"})),
        "contract_validation_failed",
    );
    let discarded = f.work(json!({"operation":"discard_turn","turn_id":TURN}));
    assert_ok(&discarded);
    assert_eq!(discarded["data"]["entries"], json!([]));
    assert_eq!(
        discarded["data"]["removed"],
        json!([{"model_id":"item","record_id":RECORD,"field_id":"score"}])
    );
    // Discarding is last-write-wins: repeating it removes nothing more.
    let repeated = f.work(json!({"operation":"discard_turn","turn_id":TURN}));
    assert_ok(&repeated);
    assert_eq!(repeated["data"]["removed"], json!([]));
    unmark(&mut f);
    f.actor("human");
    assert_eq!(entry(&mut f, "custom_score")["turn_id"], TURN);
    // A human discards any turn; rules and threads stay.
    let discarded = f.work(json!({"operation":"discard_turn","turn_id":TURN}));
    assert_ok(&discarded);
    assert_eq!(
        discarded["data"]["removed"],
        json!([{"model_id":"item","record_id":RECORD,"field_id":"custom_score"}])
    );
    let read = f.work(json!({"operation":"get"}));
    let fields: Vec<_> = read["data"]["overlay"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["field_id"].clone())
        .collect();
    assert_eq!(fields, vec![json!("rate")]);
    assert!(read["data"]["threads"].get("t").is_some());
}

#[test]
fn discard_turn_reports_only_readable_removals() {
    let Some(mut f) = Fixture::new() else { return };
    f.make_other_record_visible();
    assert_ok(&f.create());
    f.actor("agent");
    mark(&mut f, Some(TURN));
    let other = json!({"model_id":"item","record_id":OTHER_RECORD,"field_id":"score","value":{"type":"number","value":"20"}});
    assert_ok(&stage(&mut f, "two", json!([change("score", "12"), other])));
    f.client
        .batch_execute(&format!(
            "reset session authorization; update item_version set owner='other' where record_id='{RECORD}'"
        ))
        .unwrap();
    f.actor("agent");
    let discarded = f.work(json!({"operation":"discard_turn","turn_id":TURN}));
    assert_ok(&discarded);
    assert_eq!(
        discarded["data"]["removed"],
        json!([{"model_id":"item","record_id":OTHER_RECORD,"field_id":"score"}])
    );
}

#[test]
fn entries_pages_by_key_with_filters_and_omits_unreadable_entries() {
    let Some(mut f) = Fixture::new() else { return };
    f.make_other_record_visible();
    assert_ok(&f.create());
    assert_ok(&stage(&mut f, "human", json!([change("score", "12")])));
    f.actor("agent");
    mark(&mut f, Some(TURN));
    let other = json!({"model_id":"item","record_id":OTHER_RECORD,"field_id":"score","value":{"type":"number","value":"20"}});
    assert_ok(&stage(
        &mut f,
        "agent",
        json!([change("custom_score", "8"), other]),
    ));
    unmark(&mut f);
    f.actor("human");
    let page = |f: &mut Fixture, extra: Value| {
        let mut request = json!({"operation":"entries"});
        request
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let result = f.work(request);
        assert_ok(&result);
        result["data"].clone()
    };
    let key = |entry: &Value| {
        (
            entry["record_id"].as_str().unwrap().to_owned(),
            entry["field_id"].as_str().unwrap().to_owned(),
        )
    };
    // The default page holds everything, annotated as get annotates it.
    let all = page(&mut f, json!({}));
    assert_eq!(all["has_more"], false);
    assert_eq!(all["next"], Value::Null);
    assert_eq!(all["revision"], 3);
    let entries = all["entries"].as_array().unwrap();
    assert_eq!(
        entries.iter().map(key).collect::<Vec<_>>(),
        vec![
            (RECORD.into(), "custom_score".into()),
            (RECORD.into(), "score".into()),
            (OTHER_RECORD.into(), "score".into())
        ]
    );
    let read = f.work(json!({"operation":"get"}));
    assert_eq!(all["entries"], read["data"]["overlay"]);
    // Keyset pages follow `next`.
    let first = page(&mut f, json!({"limit":2}));
    assert_eq!(first["has_more"], true);
    assert_eq!(first["entries"].as_array().unwrap().len(), 2);
    let second = page(&mut f, json!({"limit":2,"after":first["next"]}));
    assert_eq!(second["has_more"], false);
    assert_eq!(
        second["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(key)
            .collect::<Vec<_>>(),
        vec![(OTHER_RECORD.into(), "score".into())]
    );
    // Filters by model, source and turn.
    assert_eq!(
        page(&mut f, json!({"model_id":"missing"}))["entries"],
        json!([])
    );
    assert_eq!(
        page(&mut f, json!({"source":"user"}))["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(key)
            .collect::<Vec<_>>(),
        vec![(RECORD.into(), "score".into())]
    );
    assert_eq!(
        page(
            &mut f,
            json!({"turn_id":TURN,"model_id":"item","source":"agent"})
        )["entries"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    for bad in [
        json!({"limit":0}),
        json!({"limit":1001}),
        json!({"limit":2.5}),
        json!({"source":"system"}),
        json!({"turn_id":"x"}),
        json!({"after":{"model_id":"item"}}),
    ] {
        let mut request = json!({"operation":"entries"});
        request
            .as_object_mut()
            .unwrap()
            .extend(bad.as_object().unwrap().clone());
        assert_error(&f.work(request), "contract_validation_failed");
    }
    // Unreadable entries are omitted and never named: the scan continues past
    // them to the readable rows after them, and no response carries a hidden key.
    f.client
        .batch_execute(&format!(
            "reset session authorization; update item_version set owner='other' where record_id='{RECORD}'"
        ))
        .unwrap();
    f.actor("human");
    assert_error(&f.work(json!({"operation":"get"})), "authorization_denied");
    for limit in [1, 2, 200] {
        let visible = page(&mut f, json!({"limit":limit}));
        assert!(!visible.to_string().contains(RECORD), "{visible}");
        assert_eq!(
            visible["entries"]
                .as_array()
                .unwrap()
                .iter()
                .map(key)
                .collect::<Vec<_>>(),
            vec![(OTHER_RECORD.into(), "score".into())]
        );
        assert_eq!(visible["has_more"], false);
        assert_eq!(visible["next"], Value::Null);
    }
    // A cursor before the hidden rows still lands on the readable rows after them.
    let after_hidden = page(
        &mut f,
        json!({"limit":1,"after":{"model_id":"item","record_id":RECORD,"field_id":"a"}}),
    );
    assert!(!after_hidden.to_string().contains(RECORD), "{after_hidden}");
    assert_eq!(after_hidden["entries"].as_array().unwrap().len(), 1);
    // Get without the overlay skips the entry capture entirely.
    let header = f.work(json!({"operation":"get","overlay":false}));
    assert_ok(&header);
    assert!(header["data"].get("overlay").is_none(), "{header}");
    assert_eq!(header["data"]["revision"], 3);
    assert!(header["data"]["rules"].is_object());
    assert_error(
        &f.work(json!({"operation":"get","overlay":"no"})),
        "contract_validation_failed",
    );
    // An agent reads pages the same way.
    f.actor("agent");
    mark(&mut f, Some(NEXT_TURN));
    assert_eq!(
        page(&mut f, json!({"source":"agent"}))["entries"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn marked_caller_cannot_approve_or_revert_in_a_policy_less_scope_even_past_the_guard() {
    let Some(mut f) = Fixture::without_policy() else {
        return;
    };
    f.actor("human");
    let draft = apply(&mut f, "draft");
    assert_ok(&draft);
    let id = draft["data"]["id"].as_i64().unwrap();
    let approve =
        json!({"app_id":APP,"customer_id":CUSTOMER,"actor_id":"human","change_set_id":id});
    let revert = json!({"app_id":APP,"customer_id":CUSTOMER,"actor_id":"human","change_set_id":1,"idempotency_key":"marked-body-revert"});
    // The public entrypoints refuse a marked caller at the mutation guard.
    mark(&mut f, Some(TURN));
    assert_error(
        &f.call("kernel_approve_draft_change_set", approve.clone()),
        "authorization_denied",
    );
    assert_error(
        &f.call("kernel_revert_change_set", revert.clone()),
        "authorization_denied",
    );
    // The bodies refuse it too, outside the declared-policy block: the
    // installer owner reaches them without the guard.
    f.client
        .batch_execute("reset session authorization")
        .unwrap();
    for (function, request, message) in [
        (
            "kernel_http_body_approve_draft_change_set",
            approve.clone(),
            "Draft approval requires human authority",
        ),
        (
            "kernel_http_body_revert_change_set",
            revert.clone(),
            "Revert requires human authority",
        ),
    ] {
        let refused = f.call(function, request);
        assert_error(&refused, "authorization_denied");
        assert_eq!(refused["error"]["message"], message, "{refused}");
    }
    // Unmarked, the same owner path approves.
    unmark(&mut f);
    assert_ok(&f.call("kernel_http_body_approve_draft_change_set", approve));
}

#[test]
fn thread_messages_record_whether_the_agent_or_the_human_wrote_them() {
    let Some(mut f) = Fixture::new() else { return };
    f.actor("human");
    assert_ok(&f.create());
    let rev = revision(&mut f);
    assert_ok(&f.work(json!({"operation":"thread_open","expected_revision":rev,"request_id":"open","thread_id":"t","anchor":{}})));
    f.actor("agent");
    mark(&mut f, Some(TURN));
    let rev = revision(&mut f);
    let agent = f.work(json!({"operation":"thread_reply","expected_revision":rev,"request_id":"agent","thread_id":"t","message":"Proposed"}));
    assert_eq!(agent["data"]["message"]["author_kind"], "agent");
    unmark(&mut f);
    f.actor("human");
    let rev = revision(&mut f);
    let human = f.work(json!({"operation":"thread_reply","expected_revision":rev,"request_id":"human","thread_id":"t","message":"Thanks"}));
    assert_eq!(human["data"]["message"]["author_kind"], "human");
}
