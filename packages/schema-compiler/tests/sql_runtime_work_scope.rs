#[path = "support/work_sessions.rs"]
mod support;
use serde_json::{json, Value};
use support::*;

fn change(n: &str) -> Value {
    json!({"model_id":"item","record_id":RECORD,"field_id":"score","value":{"type":"number","value":n}})
}
fn mutate(f: &mut Fixture, revision: &mut i64, mut request: Value) -> Value {
    if !is_edit(&request) {
        request["expected_revision"] = json!(*revision);
        request["request_id"] = json!(format!("operation-{}", *revision));
    }
    let result = f.work(request);
    assert_ok(&result);
    *revision += 1;
    result
}
fn rule() -> Value {
    json!({"model_id":"item","field_id":"score",
        "condition":{"type":"compare","op":"eq","left":{"type":"field","field":"score"},"right":{"type":"literal","value":{"type":"number","value":"999"}}},
        "value":{"type":"parameter","parameter":"score"},"parameters":{"score":{"type":"number","value":"20"}}})
}

#[test]
fn agents_cannot_invoke_human_session_operations_even_without_staged_edits() {
    let Some(mut f) = Fixture::new() else { return };
    assert_ok(&f.create());
    let mut revision = 1;
    mutate(
        &mut f,
        &mut revision,
        json!({"operation":"thread_open","thread_id":"human","anchor":{}}),
    );
    mutate(
        &mut f,
        &mut revision,
        json!({"operation":"rule_create","rule_id":"human","rule":rule()}),
    );
    f.actor("agent");
    let denied = [
        json!({"operation":"archive"}),
        json!({"operation":"unarchive"}),
        json!({"operation":"update","patch":{"title":"Agent title"}}),
        json!({"operation":"update","patch":{"scope":{}}}),
        json!({"operation":"update","patch":{"layout":{},"title":"Agent title"}}),
        json!({"operation":"pin","pinned":true}),
        json!({"operation":"update","patch":{"as_of":"2026-02-01","title":"Agent title"}}),
        json!({"operation":"duplicate","session_id":uuid::Uuid::new_v4().to_string(),"source_session_id":f.session_id,"title":"Agent copy"}),
        json!({"operation":"rule_remove","rule_id":"human"}),
        json!({"operation":"save"}),
        json!({"operation":"pull","thread_id":"human"}),
    ];
    for (index, mut request) in denied.into_iter().enumerate() {
        request["expected_revision"] = json!(revision);
        request["request_id"] = json!(format!("denied-{index}"));
        assert_error(&f.work(request), "authorization_denied");
    }
    let current = f.work(json!({"operation":"get"}));
    assert_ok(&current);
    assert_eq!(current["data"]["revision"], revision);
    assert_eq!(current["data"]["overlay"], json!([]));
    // An agent may start a brand-new session for its person, as the person would.
    let agent_session = uuid::Uuid::new_v4().to_string();
    let created = f.work(json!({"operation":"create","session_id":agent_session,"expected_revision":0,"request_id":"agent-create","title":"Agent","as_of":"2026-01-01","scope":{"models":["item"]}}));
    assert_ok(&created);
    // It is the person's (the agent acts for `human`): theirs to read, as a human.
    f.actor("human");
    let read = f.work(json!({"operation":"get","session_id":agent_session,"overlay":false}));
    assert_ok(&read);
    assert_eq!(read["data"]["owner_id"], "human", "{read}");
    assert_eq!(read["data"]["scope"], json!({"models":["item"]}), "{read}");
}

#[test]
fn agents_can_manage_own_changes_threads_proposals_and_rules() {
    let Some(mut f) = Fixture::without_policy() else {
        return;
    };
    assert_ok(&f.create());
    f.actor("agent");
    let mut revision = 1;
    mutate(
        &mut f,
        &mut revision,
        json!({"operation":"stage","changes":[change("12")]}),
    );
    mutate(
        &mut f,
        &mut revision,
        json!({"operation":"unstage","model_id":"item","record_id":RECORD,"field_id":"score"}),
    );
    mutate(
        &mut f,
        &mut revision,
        json!({"operation":"stage","changes":[change("13")]}),
    );
    mutate(
        &mut f,
        &mut revision,
        json!({"operation":"discard_source","source":"agent"}),
    );
    mutate(
        &mut f,
        &mut revision,
        json!({"operation":"thread_open","thread_id":"agent","anchor":{"model_id":"item","record_id":RECORD,"field_id":"score"}}),
    );
    mutate(
        &mut f,
        &mut revision,
        json!({"operation":"thread_reply","thread_id":"agent","message":"Please review"}),
    );
    let proposed = mutate(
        &mut f,
        &mut revision,
        json!({"operation":"propose","thread_id":"agent","changes":[change("14")]}),
    );
    assert_eq!(proposed["data"]["proposal"]["author_kind"], "agent");
    mutate(
        &mut f,
        &mut revision,
        json!({"operation":"dismiss","thread_id":"agent"}),
    );
    let created = mutate(
        &mut f,
        &mut revision,
        json!({"operation":"rule_create","rule_id":"agent","rule":rule()}),
    );
    assert_eq!(created["data"]["rule"]["author_kind"], "agent");
    assert_eq!(
        created["data"]["rule"]["author_principal"],
        f.agent_principal
    );
    f.actor("agent2");
    assert_error(&f.work(json!({"operation":"rule_remove","rule_id":"agent","expected_revision":revision,"request_id":"other-agent-remove"})), "authorization_denied");
    f.actor("agent");
    mutate(
        &mut f,
        &mut revision,
        json!({"operation":"rule_parameters","rule_id":"agent","parameters":{"score":{"type":"number","value":"30"}}}),
    );
    mutate(
        &mut f,
        &mut revision,
        json!({"operation":"rule_remove","rule_id":"agent"}),
    );
    // Staged changes are a shared working tree: the agent changes a human's
    // edit, which keeps the human's value for Restore.
    f.actor("human");
    mutate(
        &mut f,
        &mut revision,
        json!({"operation":"stage","changes":[change("15")]}),
    );
    f.actor("agent");
    let replaced = mutate(
        &mut f,
        &mut revision,
        json!({"operation":"stage","changes":[change("16")],"note":"Raise to the band floor"}),
    );
    let entry = &replaced["data"]["entries"][0];
    assert_eq!(entry["value"]["value"], "16");
    assert_eq!(entry["author_kind"], "agent");
    assert_eq!(entry["note"], "Raise to the band floor");
    assert_eq!(
        entry["replaced"],
        json!({"value":{"type":"number","value":"15"},"author_kind":"human","actor_id":"human","author_principal":f.principal})
    );
    // A later agent edit keeps the human's value; a human edit clears it.
    let again = mutate(
        &mut f,
        &mut revision,
        json!({"operation":"stage","changes":[change("17")]}),
    );
    assert_eq!(
        again["data"]["entries"][0]["replaced"]["value"]["value"],
        "15"
    );
    assert!(again["data"]["entries"][0].get("note").is_none());
    f.actor("human");
    let restored = mutate(
        &mut f,
        &mut revision,
        json!({"operation":"stage","changes":[change("15")]}),
    );
    assert!(restored["data"]["entries"][0].get("replaced").is_none());
    assert_eq!(restored["data"]["entries"][0]["author_kind"], "human");
    // The agent sets any rule's parameters and
    // resolves threads; it removes only its own rules.
    mutate(
        &mut f,
        &mut revision,
        json!({"operation":"rule_create","rule_id":"human","rule":rule()}),
    );
    f.actor("agent");
    let tuned = mutate(
        &mut f,
        &mut revision,
        json!({"operation":"rule_parameters","rule_id":"human","parameters":{"score":{"type":"number","value":"31"}}}),
    );
    assert_eq!(tuned["data"]["rule"]["author_kind"], "human");
    assert_eq!(tuned["data"]["rule"]["parameters"]["score"]["value"], "31");
    assert_error(&f.work(json!({"operation":"rule_remove","rule_id":"human","expected_revision":revision,"request_id":"agent-remove-human"})), "authorization_denied");
    mutate(
        &mut f,
        &mut revision,
        json!({"operation":"thread_resolve","thread_id":"agent"}),
    );
    // An agent never removes a person's edit: unstaging it is refused.
    let refused = f.work(
        json!({"operation":"unstage","model_id":"item","record_id":RECORD,"field_id":"score"}),
    );
    assert_error(&refused, "authorization_denied");
    let current = f.work(json!({"operation":"get"}));
    assert_eq!(current["data"]["overlay"][0]["value"]["value"], "15");
    assert_eq!(current["data"]["overlay"][0]["author_kind"], "human");
    assert_eq!(current["data"]["threads"]["agent"]["resolved"], true);
    // Staging the saved value over a person's edit keeps an agent entry that
    // holds the person's value, so Restore brings it back.
    let staged_back = mutate(
        &mut f,
        &mut revision,
        json!({"operation":"stage","changes":[change("10")]}),
    );
    let entry = &staged_back["data"]["entries"][0];
    assert_eq!(entry["value"]["value"], "10");
    assert_eq!(entry["author_kind"], "agent");
    assert_eq!(entry["replaced"]["value"]["value"], "15");
    assert_eq!(entry["replaced"]["author_kind"], "human");
    // Staging the saved value again still keeps the person's value.
    let again = mutate(
        &mut f,
        &mut revision,
        json!({"operation":"stage","changes":[change("10")]}),
    );
    assert_eq!(
        again["data"]["entries"][0]["replaced"]["value"]["value"],
        "15"
    );
    // Unstaging its own entry puts the person's value back.
    let unstaged = mutate(
        &mut f,
        &mut revision,
        json!({"operation":"unstage","model_id":"item","record_id":RECORD,"field_id":"score"}),
    );
    assert_eq!(unstaged["data"]["removed"], json!([]));
    assert_eq!(unstaged["data"]["entries"][0]["value"]["value"], "15");
    assert_eq!(unstaged["data"]["entries"][0]["author_kind"], "human");
    assert!(unstaged["data"]["entries"][0].get("replaced").is_none());
    // An agent's own entry (no person's value under it) unstages as before.
    mutate(
        &mut f,
        &mut revision,
        json!({"operation":"stage","changes":[{"model_id":"item","record_id":RECORD,"field_id":"custom_score","value":{"type":"number","value":"8"}}]}),
    );
    let own = mutate(
        &mut f,
        &mut revision,
        json!({"operation":"unstage","model_id":"item","record_id":RECORD,"field_id":"custom_score"}),
    );
    assert_eq!(
        own["data"]["removed"],
        json!([{"model_id":"item","record_id":RECORD,"field_id":"custom_score"}])
    );
    // A person unstages anything, including an agent entry over their edit.
    mutate(
        &mut f,
        &mut revision,
        json!({"operation":"stage","changes":[change("16")]}),
    );
    f.actor("human");
    let removed = mutate(
        &mut f,
        &mut revision,
        json!({"operation":"unstage","model_id":"item","record_id":RECORD,"field_id":"score"}),
    );
    assert_eq!(
        removed["data"]["removed"],
        json!([{"model_id":"item","record_id":RECORD,"field_id":"score"}])
    );
    assert_eq!(
        f.work(json!({"operation":"get"}))["data"]["overlay"],
        json!([])
    );
    f.actor("human");
    let saved =
        f.work(json!({"operation":"save","expected_revision":revision,"request_id":"save"}));
    assert_error(&saved, "contract_validation_failed");
}

#[test]
fn humans_can_unarchive_with_revision_and_replay_guards() {
    let Some(mut f) = Fixture::new() else { return };
    assert_ok(&f.create());
    let staged = f.work(json!({"operation":"stage","changes":[change("12")]}));
    assert_ok(&staged);
    assert_ok(&f.work(json!({"operation":"archive","expected_revision":2,"request_id":"archive"})));
    f.actor("agent");
    assert_error(
        &f.work(
            json!({"operation":"unarchive","expected_revision":3,"request_id":"agent-unarchive"}),
        ),
        "authorization_denied",
    );
    f.actor("human");
    assert_error(
        &f.work(
            json!({"operation":"unarchive","expected_revision":2,"request_id":"stale-unarchive"}),
        ),
        "revision_conflict",
    );
    let request = json!({"operation":"unarchive","expected_revision":3,"request_id":"unarchive"});
    let restored = f.work(request.clone());
    assert_ok(&restored);
    assert_eq!(restored["data"], json!({"revision":4}));
    assert_eq!(f.work(request), restored);
    let current = f.work(json!({"operation":"get"}));
    assert_eq!(current["data"]["status"], "active");
    assert_eq!(
        current["data"]["overlay"][0]["value"],
        staged["data"]["entries"][0]["value"]
    );
    assert_ok(
        &f.work(json!({"operation":"pin","expected_revision":4,"request_id":"pin","pinned":true})),
    );
}
