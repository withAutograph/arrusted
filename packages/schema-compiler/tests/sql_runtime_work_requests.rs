// The agent's request to Save (a `save_request` thread), the person's
// selection as session presence, and an agent removing the person's edit.
#[path = "support/work_sessions.rs"]
mod support;
use postgres::fallible_iterator::FallibleIterator;
use serde_json::{json, Value};
use support::*;

const TURN: &str = "00000000-0000-4000-8000-0000000000c1";

fn change(field: &str, n: &str) -> Value {
    json!({"model_id":"item","record_id":RECORD,"field_id":field,"value":{"type":"number","value":n}})
}
fn revision(f: &mut Fixture) -> i64 {
    let read = f.work(json!({"operation":"get","overlay":false}));
    assert_ok(&read);
    read["data"]["revision"].as_i64().unwrap()
}
fn agent(f: &mut Fixture) {
    f.actor("agent");
    f.client
        .batch_execute(&format!("set kernel.turn_id='{TURN}'"))
        .unwrap();
}
fn human(f: &mut Fixture) {
    f.client.batch_execute("reset kernel.turn_id").unwrap();
    f.actor("human");
}
fn mutate(f: &mut Fixture, id: &str, patch: Value) -> Value {
    let rev = revision(f);
    let mut request = if is_edit(&patch) {
        json!({})
    } else {
        json!({"expected_revision":rev,"request_id":id})
    };
    request
        .as_object_mut()
        .unwrap()
        .extend(patch.as_object().unwrap().clone());
    f.work(request)
}
fn threads(f: &mut Fixture) -> Value {
    f.work(json!({"operation":"get","overlay":false}))["data"]["threads"].clone()
}
fn ask(f: &mut Fixture, id: &str, reason: &str) -> Value {
    mutate(
        f,
        id,
        json!({"operation":"save_request","thread_id":id,"reason":reason}),
    )
}
fn overlay(f: &mut Fixture) -> Vec<Value> {
    f.work(json!({"operation":"get"}))["data"]["overlay"]
        .as_array()
        .unwrap()
        .clone()
}

#[test]
fn an_agent_asks_to_save_and_a_new_request_replaces_the_open_one() {
    let Some(mut f) = Fixture::new() else { return };
    assert_ok(&f.create());
    // Only an agent asks; the reason is bounded text.
    assert_error(&ask(&mut f, "human-ask", "Please"), "authorization_denied");
    agent(&mut f);
    assert_error(
        &ask(&mut f, "long", &"x".repeat(201)),
        "contract_validation_failed",
    );
    assert_error(&ask(&mut f, "empty", " "), "contract_validation_failed");
    let first = ask(&mut f, "first", "The raises are staged");
    assert_ok(&first);
    let thread = &first["data"]["thread"];
    assert_eq!(thread["kind"], "save_request");
    assert_eq!(thread["reason"], "The raises are staged");
    assert_eq!(thread["resolved"], false);
    assert_eq!(thread["author_kind"], "agent");
    assert_eq!(thread["revision"], first["data"]["revision"]);
    let second = ask(&mut f, "second", "Now with bonuses");
    assert_ok(&second);
    let open = threads(&mut f);
    assert_eq!(open["first"]["resolved"], true, "{open}");
    assert_eq!(open["second"]["resolved"], false);
    // A replay answers the same thread and changes nothing.
    let rev = revision(&mut f);
    let replay = f.work(
        json!({"operation":"save_request","expected_revision":rev - 1,"request_id":"second",
        "thread_id":"second","reason":"Now with bonuses"}),
    );
    assert_ok(&replay);
    assert_eq!(replay["data"]["thread"]["id"], "second");
    assert_eq!(revision(&mut f), rev);
}

#[test]
fn save_resolves_the_request_in_its_transaction_and_a_failed_save_leaves_it() {
    let Some(mut f) = Fixture::without_policy() else {
        return;
    };
    assert_ok(&f.create());
    assert_ok(&mutate(
        &mut f,
        "stage",
        json!({"operation":"stage","changes":[change("score","12")]}),
    ));
    agent(&mut f);
    assert_ok(&ask(&mut f, "ask", "Ready to Save"));
    human(&mut f);
    // A refused Save (a gone confirmation for a live record) rolls back whole,
    // with the request still open.
    let refused = mutate(
        &mut f,
        "save-refused",
        json!({"operation":"save","confirmed_stale":[{"model_id":"item","record_id":RECORD,"field_id":"score","gone":"record_gone"}]}),
    );
    assert_error(&refused, "stale_base");
    assert_eq!(threads(&mut f)["ask"]["resolved"], false);
    let saved = mutate(&mut f, "save", json!({"operation":"save"}));
    assert_ok(&saved);
    assert_eq!(threads(&mut f)["ask"]["resolved"], true);
    // The request is session state: never sent with the change set's threads.
    let id = saved["data"]["change_set"]["id"].as_i64().unwrap();
    f.client
        .batch_execute("reset session authorization")
        .unwrap();
    let sent: Value = f
        .client
        .query_one("select threads from change_set where id=$1", &[&id])
        .unwrap()
        .get(0);
    assert!(sent.get("ask").is_none(), "{sent}");
}

#[test]
fn not_now_resolves_the_request_as_the_person() {
    let Some(mut f) = Fixture::new() else { return };
    assert_ok(&f.create());
    agent(&mut f);
    assert_ok(&ask(&mut f, "ask", "Save?"));
    human(&mut f);
    assert_ok(&mutate(
        &mut f,
        "not-now",
        json!({"operation":"thread_resolve","thread_id":"ask"}),
    ));
    assert_eq!(threads(&mut f)["ask"]["resolved"], true);
}

#[test]
fn presence_is_human_only_bounded_owner_private_and_bumps_and_notifies_nothing() {
    let Some(mut f) = Fixture::new() else { return };
    assert_ok(&f.create());
    f.client
        .batch_execute("listen kernel_work_session")
        .unwrap();
    let selection = json!([{"model_id":"item","record_id":RECORD,"field_id":"score"},{"model_id":"item","record_id":RECORD}]);
    let before = revision(&mut f);
    // No revision and no request id: presence is not working state.
    let set = f.work(json!({"operation":"presence","selection":selection}));
    assert_ok(&set);
    assert_eq!(set["data"]["targets"], 2);
    assert_eq!(revision(&mut f), before);
    let read = f.work(json!({"operation":"get","overlay":false}));
    assert_eq!(read["data"]["presence"]["selection"], selection, "{read}");
    // An agent reads it, never writes it; and stages meanwhile untouched.
    agent(&mut f);
    assert_error(
        &f.work(json!({"operation":"presence","selection":[]})),
        "authorization_denied",
    );
    assert_eq!(
        f.work(json!({"operation":"get","overlay":false}))["data"]["presence"]["selection"],
        selection
    );
    assert_ok(&f.work(json!({"operation":"stage","changes":[change("score","13")]})));
    human(&mut f);
    assert_ok(&f.work(json!({"operation":"presence","selection":[]})));
    assert_eq!(revision(&mut f), before + 1);
    // At most 200 targets, each a model and a record (and a field).
    let many: Vec<Value> = (0..201)
        .map(|_| json!({"model_id":"item","record_id":RECORD}))
        .collect();
    assert_error(
        &f.work(json!({"operation":"presence","selection":many})),
        "contract_validation_failed",
    );
    for bad in [
        json!([{"model_id":"item","record_id":"nope"}]),
        json!([{"model_id":"item","record_id":RECORD,"value":1}]),
        json!({"model_id":"item"}),
    ] {
        assert_error(
            &f.work(json!({"operation":"presence","selection":bad})),
            "contract_validation_failed",
        );
    }
    // Another person's session is unavailable, for writing and reading.
    f.actor("other");
    assert_error(
        &f.work(json!({"operation":"presence","selection":[]})),
        "authorization_denied",
    );
    f.client
        .batch_execute("reset session authorization")
        .unwrap();
    let rows: i64 = f
        .client
        .query_one(
            "select count(*) from work_session_presence where session_id=$1::text::uuid",
            &[&f.session_id],
        )
        .unwrap()
        .get(0);
    assert_eq!(rows, 1);
    // Only the create and the agent's stage notified; presence never did.
    let session = f.session_id.to_string();
    let revisions: Vec<String> = f
        .client
        .notifications()
        .iter()
        .map(|n| Ok(n.payload().to_owned()))
        .filter(|payload| Ok(payload.contains(&session)))
        .collect()
        .unwrap();
    assert_eq!(revisions, vec![format!("{CUSTOMER}:{session}:2")]);
}

#[test]
fn an_agent_may_not_unstage_the_persons_edit_and_unstaging_its_own_leaves_nothing_to_save() {
    let Some(mut f) = Fixture::without_policy() else {
        return;
    };
    assert_ok(&f.create());
    assert_ok(&mutate(
        &mut f,
        "human12",
        json!({"operation":"stage","changes":[change("score","12")]}),
    ));
    agent(&mut f);
    let unstage =
        json!({"operation":"unstage","model_id":"item","record_id":RECORD,"field_id":"score"});
    let refused = mutate(&mut f, "refused", unstage.clone());
    assert_error(&refused, "authorization_denied");
    assert_eq!(overlay(&mut f).len(), 1);
    // The person unstages their edit; the agent's own entry unstages.
    human(&mut f);
    assert_ok(&mutate(&mut f, "human-clear", unstage.clone()));
    agent(&mut f);
    assert_ok(&mutate(
        &mut f,
        "agent14",
        json!({"operation":"stage","changes":[change("score","14")]}),
    ));
    let removed = mutate(&mut f, "clear", unstage);
    assert_ok(&removed);
    assert_eq!(removed["data"]["entries"], json!([]));
    assert_eq!(
        removed["data"]["removed"],
        json!([{"model_id":"item","record_id":RECORD,"field_id":"score"}])
    );
    // No placeholder stays: the field reads as saved and Save has nothing.
    assert_eq!(overlay(&mut f), Vec::<Value>::new());
    assert_ok(&ask(&mut f, "ask", "Save?"));
    human(&mut f);
    let saved = mutate(&mut f, "save", json!({"operation":"save"}));
    assert_error(&saved, "contract_validation_failed");
    assert!(
        saved["error"]["message"]
            .as_str()
            .unwrap()
            .contains("nothing to Save"),
        "{saved}"
    );
    // The request stays open with the failed Save.
    assert_eq!(threads(&mut f)["ask"]["resolved"], false);
}

#[test]
fn presence_is_isolated_by_customer() {
    let Some(mut f) = Fixture::new() else { return };
    assert_ok(&f.create());
    let selection = json!([{"model_id":"item","record_id":RECORD}]);
    assert_ok(&f.work(json!({"operation":"presence","selection":selection})));
    // A second customer of the same app, with a person of the same actor id.
    f.client
        .batch_execute("reset session authorization")
        .unwrap();
    let schema: Value = f
        .client
        .query_one(
            "select schema from schema_revision where customer_id=$1",
            &[&CUSTOMER],
        )
        .unwrap()
        .get(0);
    let mut other_schema = schema.clone();
    other_schema["customer_id"] = json!("tenant_b");
    f.client
        .execute(
            "insert into schema_revision(app_id,customer_id,version,base_schema,customer_overlay,schema,activated_at) values($1,'tenant_b',$2,$3,'{}',$3,now())",
            &[&APP, &VERSION, &other_schema],
        )
        .unwrap();
    f.client
        .batch_execute(
            "select kernel_sync_schema_authorization_policy(id) from schema_revision where customer_id='tenant_b'",
        )
        .unwrap();
    let runtime: String = f
        .client
        .query_one("select kernel_installer_capability_role('runtime')", &[])
        .unwrap()
        .get(0);
    let other = format!("{}_b", f.principal);
    f.client
        .batch_execute(&format!(
            "create role {other} nologin; grant \"{runtime}\" to {other}; grant usage on schema {} to {other};",
            f.schema
        ))
        .unwrap();
    assert_ok(&f.call(
        "kernel_bind_principal_scope",
        json!({"principal_name":other,"capability":"runtime","app_id":APP,"customer_id":"tenant_b"}),
    ));
    assert_ok(&f.call(
        "kernel_bind_actor_membership",
        json!({"principal_name":other,"app_id":APP,"customer_id":"tenant_b","actor_id":"human","role":"editor","actor_kind":"human"}),
    ));
    f.client
        .batch_execute(&format!(
            "set session authorization {other}; set kernel.actor_id='human'"
        ))
        .unwrap();
    let mut as_b = f.base();
    as_b["customer_id"] = json!("tenant_b");
    let call = |f: &mut Fixture, patch: Value| {
        let mut request = as_b.clone();
        request
            .as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        f.call("kernel_work_session", request)
    };
    // The other customer neither reads nor writes this session's presence.
    let read = call(&mut f, json!({"operation":"get","overlay":false}));
    assert!(read["ok"] != json!(true), "{read}");
    assert!(read["data"]["presence"].is_null(), "{read}");
    let write = call(&mut f, json!({"operation":"presence","selection":[]}));
    assert!(write["ok"] != json!(true), "{write}");
    // Its own session's presence is its own.
    assert_ok(&call(
        &mut f,
        json!({"operation":"create","expected_revision":0,"request_id":"create-b","title":"B","as_of":"2026-01-01","session_id":"00000000-0000-4000-8000-0000000000b1"}),
    ));
    f.client
        .batch_execute("reset session authorization")
        .unwrap();
    let rows: Vec<(String, Value)> = f
        .client
        .query(
            "select customer_id, selection from work_session_presence where session_id=$1::text::uuid",
            &[&f.session_id],
        )
        .unwrap()
        .iter()
        .map(|row| (row.get(0), row.get(1)))
        .collect();
    assert_eq!(rows, vec![(CUSTOMER.to_string(), selection)]);
}
