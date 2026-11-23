#[path = "support/work_sessions.rs"]
mod support;
use postgres::fallible_iterator::FallibleIterator;
use serde_json::{json, Value};
use support::*;
fn change(n: &str) -> Value {
    json!({"model_id":"item","record_id":RECORD,"field_id":"score","value":{"type":"number","value":n}})
}
/// A get's overlay, or the entries a mutation touched.
fn overlay(state: &Value) -> Value {
    let data = &state["data"];
    data.get("overlay").unwrap_or(&data["entries"]).clone()
}
/// Entries without get's read-time annotations.
fn plain(entries: Value) -> Value {
    let mut entries = entries;
    for entry in entries.as_array_mut().unwrap() {
        for key in ["stale", "current_version", "current_value", "gone"] {
            entry.as_object_mut().unwrap().remove(key);
        }
    }
    entries
}
fn stage(f: &mut Fixture, _rev: i64, _id: &str, n: &str) -> Value {
    let result = f.work(json!({"operation":"stage","changes":[change(n)]}));
    assert_ok(&result);
    result
}
#[test]
fn create_returns_the_persisted_initial_revision() {
    let Some(mut f) = Fixture::new() else { return };
    let created = f.create();
    assert_ok(&created);
    assert_eq!(created["data"]["revision"], 1);
    f.client
        .batch_execute("reset session authorization")
        .unwrap();
    let persisted: i64 = f
        .client
        .query_one("select revision from work_session", &[])
        .unwrap()
        .get(0);
    assert_eq!(persisted, 1);
    f.actor("human");
    assert_ok(&f.work(json!({"operation":"update","patch":{"title":"Updated"}})));
}

#[test]
fn sessions_preserve_first_baseline_and_stage_last_write_wins() {
    let Some(mut f) = Fixture::new() else { return };
    assert_ok(&f.create());
    let a = stage(&mut f, 1, "user12", "12");
    assert_eq!(overlay(&a)[0]["baseline"]["value"], "10");
    let b = stage(&mut f, 2, "user13", "13");
    assert_eq!(overlay(&b)[0]["baseline"]["value"], "10");
    assert_eq!(overlay(&b)[0]["value"]["value"], "13");
    let clean = stage(&mut f, 3, "baseline", "10");
    assert_eq!(overlay(&clean), json!([]));
    assert_eq!(clean["data"]["revision"], 4);
    // Staging is last-write-wins: two writers that read revision 4 both land,
    // in order, with no revision conflict; the entry keeps its first baseline.
    let first = stage(&mut f, 4, "human12", "12");
    assert_eq!(first["data"]["revision"], 5);
    f.actor("agent");
    let second = stage(&mut f, 4, "agent11", "11");
    assert_eq!(second["data"]["revision"], 6);
    let entry = &overlay(&second)[0];
    assert_eq!(entry["value"]["value"], "11");
    assert_eq!(entry["baseline"]["value"], "10");
    assert_eq!(entry["author_kind"], "agent");
    // A request id or revision on an edit is refused: edits take neither.
    assert_error(
        &f.work(json!({"operation":"stage","expected_revision":6,"request_id":"old","changes":[change("12")]})),
        "contract_validation_failed",
    );
    f.actor("human");
    f.actor("other");
    assert_error(&f.work(json!({"operation":"get"})), "authorization_denied");
    assert_error(
        &f.work(json!({"operation":"archive","expected_revision":6,"request_id":"other"})),
        "authorization_denied",
    );
}

#[test]
fn sessions_agents_change_human_edits_keeping_the_replaced_value_and_pull_keeps_proposal_provenance(
) {
    let Some(mut f) = Fixture::new() else { return };
    assert_ok(&f.create());
    let human = stage(&mut f, 1, "user12", "12");
    assert_eq!(overlay(&human)[0]["author_kind"], "human");
    assert_ok(&f.work(json!({"operation":"thread_open","thread_id":"t","anchor":{"model_id":"item","record_id":RECORD,"field_id":"score"},"expected_revision":2,"request_id":"open"})));
    // The agent changes the human's staged edit; the human's value and author stay as `replaced`.
    f.actor("agent");
    let changed = stage(&mut f, 3, "agent14", "14");
    let entry = &overlay(&changed)[0];
    assert_eq!(entry["value"]["value"], "14");
    assert_eq!(entry["author_kind"], "agent");
    assert_eq!(entry["baseline"]["value"], "10");
    assert_eq!(
        entry["replaced"],
        json!({"value":{"type":"number","value":"12"},"author_kind":"human","actor_id":"human","author_principal":f.principal})
    );
    // Discarding the agent's changes gives the human back their value.
    let discarded = f.work(json!({"operation":"discard_source","source":"agent"}));
    assert_ok(&discarded);
    assert_eq!(discarded["data"]["removed"], json!([]));
    assert_eq!(
        overlay(&f.work(json!({"operation":"get"})))[0]["value"]["value"],
        "12"
    );
    // The agent proposes too; a human pull stages it with the proposal's provenance.
    let proposal = f.work(json!({"operation":"propose","thread_id":"t","expected_revision":5,"request_id":"proposal","changes":[change("18")]}));
    assert_ok(&proposal);
    assert_eq!(
        proposal["data"]["proposal"]["changes"][0]["value"]["value"],
        "18"
    );
    f.actor("human");
    // The expected revision identifies the proposal the human saw.
    let wrong = f.work(
        json!({"operation":"pull","thread_id":"t","expected_revision":5,"request_id":"wrong"}),
    );
    assert_error(&wrong, "revision_conflict");
    let pulled = f.work(
        json!({"operation":"pull","thread_id":"t","expected_revision":6,"request_id":"pull"}),
    );
    assert_ok(&pulled);
    let entry = &overlay(&pulled)[0];
    assert_eq!(entry["value"]["value"], "18");
    assert_eq!(entry["baseline"]["value"], "10");
    assert_eq!(entry["source"], "agent");
    assert_eq!(entry["author_kind"], "agent");
    assert_eq!(entry["author_principal"], f.agent_principal);
    assert_eq!(entry["thread_id"], "t");
    // The pulled agent proposal replaced the human's restored 12.
    assert_eq!(entry["replaced"]["value"]["value"], "12");
    assert!(f.work(json!({"operation":"get"}))["data"]["threads"]["t"]
        .get("proposal")
        .is_none());
    // Another agent changes it too; a human restage clears `replaced`.
    f.actor("agent2");
    let other = stage(&mut f, 7, "agent20", "20");
    assert_eq!(
        overlay(&other)[0]["author_principal"],
        f.second_agent_principal
    );
    f.actor("human");
    let restaged = stage(&mut f, 8, "human15", "15");
    assert_eq!(overlay(&restaged)[0]["author_kind"], "human");
    assert!(overlay(&restaged)[0].get("thread_id").is_none());
    assert!(overlay(&restaged)[0].get("replaced").is_none());
    assert_eq!(
        plain(overlay(&f.work(json!({"operation":"get"})))),
        overlay(&restaged)
    );
}

#[test]
fn sessions_duplicate_copies_metadata_rules_and_staged_entries() {
    let Some(mut f) = Fixture::new() else { return };
    assert_ok(&f.create());
    assert_ok(
        &f.work(json!({"operation":"update","patch":{"layout":{"x":1},"scope":{"model":"item"}}})),
    );
    stage(&mut f, 2, "stage", "12");
    let rule = json!({"model_id":"item","field_id":"custom_score","value":{"type":"parameter","parameter":"score"},"parameters":{"score":{"type":"number","value":"9"}}});
    assert_ok(&f.work(json!({"operation":"rule_create","expected_revision":3,"request_id":"rule","rule_id":"fixed","rule":rule})));
    assert_ok(&f.work(json!({"operation":"thread_open","thread_id":"t","anchor":{},"expected_revision":4,"request_id":"open"})));
    let source = f.work(json!({"operation":"get"}));
    assert_ok(&source);
    let source_id = f.session_id.clone();
    let copy_id = uuid::Uuid::new_v4().to_string();
    let request = json!({"operation":"duplicate","session_id":copy_id,"source_session_id":source_id,"expected_revision":0,"request_id":"copy","title":"Scenario"});
    f.actor("agent");
    assert_error(&f.work(request.clone()), "authorization_denied");
    f.actor("human");
    let copied = f.work(request.clone());
    assert_ok(&copied);
    assert_eq!(copied["data"], json!({"revision":1,"session_id":copy_id}));
    assert_eq!(f.work(request), copied, "duplicate replays return the copy");
    let source_id_for_get = f.session_id.clone();
    f.session_id = copy_id.clone();
    let read = f.work(json!({"operation":"get"}));
    f.session_id = source_id_for_get;
    let copy = &read["data"];
    assert_eq!(copy["id"], copy_id);
    assert_eq!(copy["title"], "Scenario");
    assert_eq!(copy["revision"], 1);
    for key in ["as_of", "scope", "layout", "rules", "owner_id"] {
        assert_eq!(copy[key], source["data"][key], "{key}");
    }
    assert_eq!(copy["threads"], json!({}));
    assert_eq!(copy["overlay"], source["data"]["overlay"]);
    assert_eq!(copy["overlay"].as_array().unwrap().len(), 2);
    // The sessions diverge independently and read through their own overlay.
    f.session_id = copy_id.clone();
    let changed = stage(&mut f, 1, "copy-stage", "30");
    assert_eq!(changed["data"]["revision"], 2);
    let copy_read = f.query(json!({"work":{"session_id":copy_id}}));
    assert_eq!(copy_read["data"][0]["values"]["score"]["value"], "30");
    f.session_id = source_id.clone();
    let source_read = f.query(json!({"work":{"session_id":source_id}}));
    assert_eq!(source_read["data"][0]["values"]["score"]["value"], "12");
    let unknown = f.work(json!({"operation":"duplicate","session_id":uuid::Uuid::new_v4().to_string(),"source_session_id":uuid::Uuid::new_v4().to_string(),"expected_revision":0,"request_id":"missing","title":"Missing"}));
    assert_error(&unknown, "authorization_denied");
}
#[test]
fn sessions_save_one_draft_change_set_and_require_stale_confirmation() {
    {
        let Some(mut f) = Fixture::without_policy() else {
            return;
        };
        assert_ok(&f.create());
        let a=f.work(json!({"operation":"stage","changes":[change("12"),{"model_id":"item","record_id":RECORD,"field_id":"custom_score","value":{"type":"number","value":"9"}}]}));
        assert_ok(&a);
        // The expected revision identifies the overlay the human saw.
        let wrong = f.work(json!({"operation":"save","expected_revision":1,"request_id":"wrong"}));
        assert_error(&wrong, "revision_conflict");
        // Move canonical data under the edit without changing session state.
        let canonical=f.call("kernel_apply_change_set",json!({"app_id":APP,"customer_id":CUSTOMER,"actor_id":"human","source_kind":"fixture","mode":"mainline","writes":[{"model_id":"item","record_key":{"type":"record_id","value":RECORD},"effective_start":"2026-01-01","values":{"score":{"type":"number","value":"11"}}}]}));
        assert_ok(&canonical);
        let current = f.work(json!({"operation":"get"}));
        assert_ok(&current);
        // Entries are ordered by model, record and field.
        assert_eq!(overlay(&current)[1]["field_id"], "score");
        assert_eq!(overlay(&current)[1]["stale"], true);
        assert_eq!(overlay(&current)[1]["current_value"]["value"], "11");
        let stale = f.work(json!({"operation":"save","expected_revision":2,"request_id":"save"}));
        assert_error(&stale, "stale_base");
        let confirmation = json!([
            {"model_id":"item","record_id":RECORD,"field_id":"score","current_version":overlay(&current)[1]["current_version"]},
            {"model_id":"item","record_id":RECORD,"field_id":"custom_score","current_version":overlay(&current)[0]["current_version"]}
        ]);
        let request = json!({"operation":"save","expected_revision":2,"request_id":"save","confirmed_stale":confirmation});
        let saved = f.work(request.clone());
        assert_ok(&saved);
        assert_eq!(saved["data"]["cleared"], true);
        assert_eq!(saved["data"]["revision"], 3);
        assert_eq!(overlay(&f.work(json!({"operation":"get"}))), json!([]));
        let replay = f.work(request);
        assert_eq!(saved, replay);
        f.client
            .batch_execute("reset session authorization")
            .unwrap();
        let count: i64 = f
            .client
            .query_one(
                "select count(*) from change_set where source_kind='work_session'",
                &[],
            )
            .unwrap()
            .get(0);
        assert_eq!(count, 1);
        let status: String = f
            .client
            .query_one(
                "select status from change_set where source_kind='work_session'",
                &[],
            )
            .unwrap()
            .get(0);
        // Save always writes a draft; publishing it is a separate approval.
        assert_eq!(status, "draft");
        let saved_row = f
            .client
            .query_one(
                "select score::text,custom_fields from item_version where change_set_id=$1",
                &[&saved["data"]["change_set"]["id"].as_i64().unwrap()],
            )
            .unwrap();
        assert_eq!(saved_row.get::<_, String>(0), "12");
        let custom_values: Value = saved_row.get(1);
        assert_eq!(
            custom_values,
            json!([{"field_id":"custom_score","type":"number","value":"9"}])
        );
    }
}
#[test]
fn sessions_cannot_stage_hidden_fields_or_records() {
    let Some(mut f) = Fixture::new() else { return };
    assert_ok(&f.create());
    let hidden=f.work(json!({"operation":"stage","changes":[{"model_id":"item","record_id":RECORD,"field_id":"secret","value":{"type":"number","value":"0"}}]}));
    assert_error(&hidden, "authorization_denied");
    let other=f.work(json!({"operation":"stage","changes":[{"model_id":"item","record_id":OTHER_RECORD,"field_id":"score","value":{"type":"number","value":"0"}}]}));
    assert_error(&other, "authorization_denied");
}
#[test]
fn sessions_reauthorize_get_and_historical_replay_after_read_grant_revocation() {
    let Some(mut f) = Fixture::new() else { return };
    assert_ok(&f.create());
    let staged = stage(&mut f, 1, "stage", "12");
    assert_ok(&f.work(json!({"operation":"thread_open","thread_id":"t","anchor":{},"expected_revision":2,"request_id":"open"})));
    let proposal=f.work(json!({"operation":"propose","thread_id":"t","expected_revision":3,"request_id":"proposal","changes":[change("18")]}));
    assert_ok(&proposal);
    f.client.batch_execute("reset session authorization; update kernel_actor_membership set role='revoked' where actor_id='human'").unwrap();
    f.actor("human");
    assert_error(&f.work(json!({"operation":"get"})), "authorization_denied");
    let replay = f.work(json!({"operation":"stage","changes":[change("12")]}));
    assert_error(&replay, "authorization_denied");
    assert_eq!(overlay(&staged)[0]["value"]["value"], "12");
    assert!(
        f.client
            .query_one("select * from work_session", &[])
            .is_err(),
        "runtime principal has no raw session table grant"
    );
}
#[test]
fn sessions_headers_layout_threads_and_archive_are_guarded_working_state() {
    let Some(mut f) = Fixture::new() else { return };
    assert_ok(&f.create());
    assert_ok(
        &f.work(json!({"operation":"update","patch":{"layout":{"x":10},"scope":{"model":"item"}}})),
    );
    assert_error(
        &f.work(json!({"operation":"update","patch":{"as_of":"2027-02-30"}})),
        "contract_validation_failed",
    );
    assert_error(
        &f.work(json!({"operation":"update","patch":{"scope":null}})),
        "contract_validation_failed",
    );
    assert_ok(
        &f.work(json!({"operation":"pin","expected_revision":2,"request_id":"pin","pinned":true})),
    );
    let opened = f.work(json!({"operation":"thread_open","expected_revision":3,"request_id":"open","thread_id":"t","anchor":{}}));
    assert_eq!(opened["data"]["thread"]["id"], "t");
    let replied = f.work(json!({"operation":"thread_reply","expected_revision":4,"request_id":"reply","thread_id":"t","message":"Review this"}));
    assert_eq!(replied["data"]["message"]["message"], "Review this");
    assert_eq!(replied["data"]["message"]["author_kind"], "human");
    let resolved=f.work(json!({"operation":"thread_resolve","expected_revision":5,"request_id":"resolve","thread_id":"t"}));
    assert_eq!(resolved["data"], json!({"revision":6}));
    let resolved = f.work(json!({"operation":"get"}));
    assert_eq!(resolved["data"]["threads"]["t"]["resolved"], true);
    assert_eq!(
        resolved["data"]["threads"]["t"]["messages"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(resolved["data"]["layout"], json!({"x":10}));
    let first = f.session_id.clone();
    f.session_id = uuid::Uuid::new_v4().to_string();
    assert_ok(&f.create());
    let list = f.work(json!({"operation":"list"}));
    assert_ok(&list);
    assert_eq!(list["data"][0]["id"], first);
    for key in ["overlay", "rules", "threads"] {
        assert!(list["data"][0].get(key).is_none(), "{key}");
    }
    f.session_id = first;
    assert_ok(&f.work(json!({"operation":"archive","expected_revision":6,"request_id":"archive"})));
    let list = f.work(json!({"operation":"list"}));
    assert_eq!(list["data"].as_array().unwrap().len(), 1);
    assert_error(
        &f.work(
            json!({"operation":"pin","expected_revision":7,"request_id":"late","pinned":false}),
        ),
        "revision_conflict",
    );
    f.client
        .batch_execute("reset session authorization")
        .unwrap();
    let count: i64 = f
        .client
        .query_one("select count(*) from change_set", &[])
        .unwrap()
        .get(0);
    assert_eq!(
        count, 1,
        "working mutations do not version canonical records"
    );
}
#[test]
fn sessions_agents_may_update_only_the_layout() {
    let Some(mut f) = Fixture::new() else { return };
    assert_ok(&f.create());
    let title = f.work(json!({"operation":"get"}))["data"]["title"].clone();
    f.actor("agent");
    for (_id, patch) in [
        ("title", json!({"title":"Renamed"})),
        (
            "mixed",
            json!({"layout":{"units":[]},"scope":{"model":"item"}}),
        ),
        ("empty", json!({})),
        ("list", json!([])),
    ] {
        assert_error(
            &f.work(json!({"operation":"update","patch":patch})),
            "authorization_denied",
        );
    }
    let layout = json!({"units":[{"id":"u","kind":"grid","config":{"model_id":"item"},"x":0,"y":0,"w":10,"h":10}]});
    let updated = f.work(json!({"operation":"update","patch":{"layout":layout}}));
    assert_eq!(updated["data"], json!({"revision":2}));
    let read = f.work(json!({"operation":"get"}));
    assert_eq!(read["data"]["layout"], layout);
    assert_eq!(read["data"]["title"], title);
}
#[test]
fn sessions_reject_unparsed_and_nonfinite_values_without_revision_change() {
    let Some(mut f) = Fixture::new() else { return };
    assert_ok(&f.create());
    for (i, v) in [
        json!({"type":"number","value":"NaN"}),
        json!({"type":"number","value":12}),
        json!({"type":"money_rate","value":{"amount":"100","period":"annual"}}),
    ]
    .into_iter()
    .enumerate()
    {
        let field = if i == 2 { "rate" } else { "score" };
        assert_error(&f.work(json!({"operation":"stage","changes":[{"model_id":"item","record_id":RECORD,"field_id":field,"value":v}]})),"contract_validation_failed");
    }
    assert_error(
        &f.work(
            json!({"operation":"pin","expected_revision":1,"request_id":"badPin","pinned":"true"}),
        ),
        "contract_validation_failed",
    );
    assert_error(
        &f.work(json!({"operation":"update","patch":{"title":42}})),
        "contract_validation_failed",
    );
    let clean = stage(&mut f, 1, "numericEqual", "10.0");
    assert_eq!(overlay(&clean), json!([]));
}

#[test]
fn sessions_authorship_is_trusted_and_proposal_dismissal_is_principal_bound() {
    let Some(mut f) = Fixture::new() else { return };
    assert_ok(&f.create());
    let staged=f.work(json!({"operation":"stage","changes":[{"model_id":"item","record_id":RECORD,"field_id":"score","value":{"type":"number","value":"12"},"author_principal":"forged","author_kind":"agent","source":"agent"}]}));
    assert_ok(&staged);
    assert_eq!(overlay(&staged)[0]["author_principal"], f.principal);
    assert_eq!(overlay(&staged)[0]["author_kind"], "human");
    assert_ok(&f.work(json!({"operation":"thread_open","thread_id":"t","anchor":{},"expected_revision":2,"request_id":"open"})));
    for (author, rev) in [("human", 3), ("agent", 5)] {
        f.actor(author);
        let proposed=f.work(json!({"operation":"propose","thread_id":"t","expected_revision":rev,"request_id":format!("propose{rev}"),"author_principal":"forged","author_kind":"human","changes":[change("18")]}));
        assert_ok(&proposed);
        let proposal = proposed["data"]["proposal"].clone();
        assert_eq!(
            proposal["author_principal"],
            if author == "human" {
                f.principal.as_str()
            } else {
                f.agent_principal.as_str()
            }
        );
        assert_eq!(
            proposal["author_kind"],
            if author == "human" { "human" } else { "agent" }
        );
        f.actor("agent2");
        assert_error(&f.work(json!({"operation":"dismiss","thread_id":"t","expected_revision":rev+1,"request_id":format!("denied{rev}")})), "authorization_denied");
        assert_error(&f.work(json!({"operation":"propose","thread_id":"t","expected_revision":rev+1,"request_id":format!("overwrite{rev}"),"changes":[change("19")]})), "authorization_denied");
        f.actor(author);
        assert_ok(&f.work(json!({"operation":"dismiss","thread_id":"t","expected_revision":rev+1,"request_id":format!("dismiss{rev}")})));
    }
}

#[test]
fn sessions_agents_change_one_anothers_entries_but_discard_only_their_own() {
    let Some(mut f) = Fixture::new() else { return };
    assert_ok(&f.create());
    f.actor("agent");
    let staged = stage(&mut f, 1, "agent12", "12");
    assert_eq!(overlay(&staged)[0]["author_principal"], f.agent_principal);
    assert_eq!(overlay(&staged)[0]["author_kind"], "agent");
    f.actor("agent2");
    assert_error(
        &f.work(json!({"operation":"archive","expected_revision":2,"request_id":"archive"})),
        "authorization_denied",
    );
    // A bulk discard removes only the calling agent's own entries.
    let untouched = f.work(json!({"operation":"discard_source","source":"agent"}));
    assert_ok(&untouched);
    assert_eq!(untouched["data"]["removed"], json!([]));
    assert_eq!(
        plain(overlay(&f.work(json!({"operation":"get"})))),
        overlay(&staged)
    );
    // One entry at a time, any agent changes any staged entry; no `replaced`
    // is kept between agents.
    let changed = stage(&mut f, 3, "agent13", "13");
    assert_eq!(
        overlay(&changed)[0]["author_principal"],
        f.second_agent_principal
    );
    assert!(overlay(&changed)[0].get("replaced").is_none());
    let removed = f.work(
        json!({"operation":"unstage","model_id":"item","record_id":RECORD,"field_id":"score"}),
    );
    assert_ok(&removed);
    assert_eq!(overlay(&removed), json!([]));
    assert_eq!(
        removed["data"]["removed"],
        json!([{"model_id":"item","record_id":RECORD,"field_id":"score"}])
    );
}

#[test]
fn sessions_store_one_row_per_staged_field_without_rewriting_others() {
    let Some(mut f) = Fixture::new() else { return };
    f.make_other_record_visible();
    assert_ok(&f.create());
    stage(&mut f, 1, "first", "12");
    let row = "select xmin::text,ctid::text,value from work_session_record where record_id=$1::text::uuid and field_id='score'";
    f.client
        .batch_execute("reset session authorization")
        .unwrap();
    let before = f.client.query_one(row, &[&RECORD]).unwrap();
    f.actor("human");
    let staged=f.work(json!({"operation":"stage","changes":[{"model_id":"item","record_id":OTHER_RECORD,"field_id":"score","value":{"type":"number","value":"20"}},{"model_id":"item","record_id":RECORD,"field_id":"custom_score","value":{"type":"number","value":"8"}}]}));
    assert_ok(&staged);
    // The response carries only the two entries this stage touched.
    assert_eq!(overlay(&staged).as_array().unwrap().len(), 2);
    f.client
        .batch_execute("reset session authorization")
        .unwrap();
    let after = f.client.query_one(row, &[&RECORD]).unwrap();
    assert_eq!(before.get::<_, String>(0), after.get::<_, String>(0));
    assert_eq!(before.get::<_, String>(1), after.get::<_, String>(1));
    assert_eq!(before.get::<_, Value>(2), after.get::<_, Value>(2));
    let rows: i64 = f
        .client
        .query_one("select count(*) from work_session_record", &[])
        .unwrap()
        .get(0);
    assert_eq!(rows, 3);
    let oversized = json!({"type":"text","value":"x".repeat(1024*1024)});
    let error = f
        .client
        .execute(
            "update work_session_record set value=$1 where record_id=$2::text::uuid and field_id='score'",
            &[&oversized, &RECORD],
        )
        .unwrap_err();
    assert_eq!(
        error.code(),
        Some(&postgres::error::SqlState::CHECK_VIOLATION)
    );
}

#[test]
fn sessions_policy_save_rejection_preserves_overlay_and_revision() {
    let Some(mut f) = Fixture::new() else { return };
    assert_ok(&f.create());
    stage(&mut f, 1, "stage", "12");
    // Save always drafts, and a declared policy refuses drafts (policy-aware
    // drafts are a follow-up): Save is refused before any work.
    let before = f.work(json!({"operation":"get"}));
    let rejected = f.work(json!({"operation":"save","expected_revision":2,"request_id":"draft"}));
    assert_error(&rejected, "unsupported_capability");
    assert_eq!(
        rejected["error"]["details"][0]["code"],
        "unsupported_policy_lifecycle"
    );
    let current = f.work(json!({"operation":"get"}));
    assert_ok(&current);
    assert_eq!(current["data"]["revision"], 2);
    assert_eq!(current, before);
    f.client
        .batch_execute("reset session authorization")
        .unwrap();
    let count: i64 = f
        .client
        .query_one(
            "select count(*) from change_set where source_kind='work_session'",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(count, 0);
}

#[test]
fn sessions_serialization_failure_remains_retryable_sqlstate() {
    let Some(mut f) = Fixture::new() else { return };
    assert_ok(&f.create());
    f.client.batch_execute("reset session authorization; create or replace function kernel_work_stage(request jsonb, session jsonb, changes jsonb, provenance jsonb, apply boolean) returns void language plpgsql as $test$ begin raise exception using errcode='40001',message='injected concurrent mutation'; end $test$").unwrap();
    f.actor("human");
    let mut request = f.base();
    request.as_object_mut().unwrap().extend(
        json!({"operation":"stage","changes":[change("12")]})
            .as_object()
            .unwrap()
            .clone(),
    );
    let error = f
        .client
        .query_one("select kernel_work_session($1::jsonb)", &[&request])
        .unwrap_err();
    assert_eq!(
        error.code(),
        Some(&postgres::error::SqlState::T_R_SERIALIZATION_FAILURE)
    );
}

#[test]
fn sessions_save_racing_ordinary_apply_detects_versions_and_drops_revived_gone_entries() {
    // Scenario 0: a live entry's record changes while Save waits: Save fails and
    // keeps the overlay. Scenario 2: a confirmed-gone record is restored while
    // Save waits: Save writes the live entry and drops the gone one.
    for scenario in [0, 2] {
        let gone = scenario != 0;
        let Some(mut f) = Fixture::without_policy() else {
            return;
        };
        assert_ok(&f.create());
        let changes = if scenario == 2 {
            json!([change("12"),{"model_id":"item","record_id":OTHER_RECORD,"field_id":"score","value":{"type":"number","value":"22"}}])
        } else {
            json!([change("12")])
        };
        assert_ok(&f.work(json!({"operation":"stage","changes":changes})));
        let tombstone = if scenario == 2 {
            let result=f.call("kernel_apply_change_set",json!({"app_id":APP,"customer_id":CUSTOMER,"actor_id":"human","source_kind":"fixture","mode":"mainline","writes":[{"model_id":"item","record_key":{"type":"record_id","value":RECORD},"effective_start":"2026-01-01","tombstones_record":true}]}));
            assert_ok(&result);
            result["data"]["id"].clone()
        } else {
            Value::Null
        };
        f.client
            .batch_execute("reset session authorization")
            .unwrap();
        f.actor("human");
        let shown = f.work(json!({"operation":"get"}));
        assert_ok(&shown);
        f.client
            .batch_execute("reset session authorization")
            .unwrap();
        // Pause Save just before canonical apply. Ordinary apply must still be
        // able to lock and change the subject while Save is paused here.
        let definition: String = f.client.query_one("select pg_get_functiondef('kernel_apply_execute_internal(jsonb,boolean,bigint,jsonb,boolean)'::regprocedure)", &[]).unwrap().get(0);
        f.client
            .batch_execute(&definition.replacen(
                "kernel_apply_execute_internal(",
                "test_original_apply(",
                1,
            ))
            .unwrap();
        let gate: i64 = (uuid::Uuid::new_v4().as_u128() & 0x7fff_ffff_ffff_ffff) as i64;
        f.client.batch_execute(&format!("create or replace function kernel_apply_execute_internal(request jsonb,is_dry_run boolean,synthetic_order bigint,alias_transfer jsonb,installer_seed boolean) returns jsonb language plpgsql as $test$ begin if request->>'source_kind'='work_session' then perform pg_advisory_xact_lock({gate}); end if; return test_original_apply(request,is_dry_run,synthetic_order,alias_transfer,installer_seed); end $test$")).unwrap();
        f.client
            .query_one("select pg_advisory_lock($1)", &[&gate])
            .unwrap();
        let mut request = f.base();
        request.as_object_mut().unwrap().extend(json!({"operation":"save","expected_revision":2,"request_id":"race","confirmed_stale":if gone {json!([{"model_id":"item","record_id":RECORD,"field_id":"score","current_version":overlay(&shown).as_array().unwrap().iter().find(|entry|entry["record_id"]==RECORD).unwrap()["current_version"],"gone":"record_gone"}])} else {json!([])}}).as_object().unwrap().clone());
        let schema = f.schema.clone();
        let principal = f.principal.clone();
        let (sender, receiver) = std::sync::mpsc::channel();
        let save = std::thread::spawn(move || {
            let mut client =
                kernel::connect_postgres(&std::env::var("KERNEL_TEST_DATABASE_URL").unwrap())
                    .unwrap();
            client.batch_execute(&format!("set search_path to {schema}; set session authorization {principal}; set kernel.actor_id='human'; set statement_timeout='30s'")).unwrap();
            let pid: i32 = client
                .query_one("select pg_backend_pid()", &[])
                .unwrap()
                .get(0);
            sender.send(pid).unwrap();
            client
                .query_one("select kernel_work_session($1::jsonb)", &[&request])
                .map(|row| row.get::<_, Value>(0))
        });
        let pid = receiver
            .recv_timeout(std::time::Duration::from_secs(30))
            .unwrap();
        let start = std::time::Instant::now();
        let waiting = loop {
            let waiting:bool=f.client.query_one("select exists(select 1 from pg_locks where pid=$1 and locktype='advisory' and not granted)",&[&pid]).unwrap().get(0);
            if waiting || start.elapsed() > std::time::Duration::from_secs(20) {
                break waiting;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        };
        f.actor("human");
        f.client
            .batch_execute("set statement_timeout='10s'")
            .unwrap();
        let canonical = if scenario == 2 {
            f.call("kernel_revert_change_set",json!({"app_id":APP,"customer_id":CUSTOMER,"actor_id":"human","change_set_id":tombstone,"idempotency_key":"revive"}))
        } else {
            f.call("kernel_apply_change_set",json!({"app_id":APP,"customer_id":CUSTOMER,"actor_id":"human","source_kind":"fixture","mode":"mainline","writes":[{"model_id":"item","record_key":{"type":"record_id","value":RECORD},"effective_start":"2026-01-01","values":{"score":{"type":"number","value":"11"}}}]}))
        };
        f.client
            .query_one("select pg_advisory_unlock($1)", &[&gate])
            .unwrap();
        let saved = save.join().unwrap().unwrap();
        assert!(waiting, "Save did not reach the canonical-apply barrier");
        assert_ok(&canonical);
        if gone {
            // The owner accepted this race: the restored record's staged
            // change is dropped, and the live entry is written.
            assert_ok(&saved);
            assert!(saved["data"]["change_set"]["id"].is_number(), "{saved}");
            assert_eq!(overlay(&f.work(json!({"operation":"get"}))), json!([]));
            f.client
                .batch_execute("reset session authorization")
                .unwrap();
            let scores: Vec<(String, String)> = f
                .client
                .query(
                    "select record_id::text, score::text from item_version where change_set_id=$1",
                    &[&saved["data"]["change_set"]["id"].as_i64().unwrap()],
                )
                .unwrap()
                .iter()
                .map(|row| (row.get(0), row.get(1)))
                .collect();
            assert_eq!(scores, vec![(OTHER_RECORD.to_string(), "22".to_string())]);
            continue;
        }
        assert_error(&saved, "stale_base");
        let current = f.work(json!({"operation":"get"}));
        assert_ok(&current);
        assert_eq!(current["data"]["revision"], 2);
        assert_eq!(overlay(&current).as_array().unwrap().len(), 1);
        assert_eq!(overlay(&current)[0]["value"]["value"], "12");
        f.client
            .batch_execute("reset session authorization")
            .unwrap();
        let receipts: Value = f
            .client
            .query_one(
                "select receipts from work_session where id=$1::text::uuid",
                &[&f.session_id],
            )
            .unwrap()
            .get(0);
        assert!(
            receipts.get("race").is_none(),
            "failed Save must not persist its receipt"
        );
        let count: i64 = f
            .client
            .query_one(
                "select count(*) from change_set where source_kind='work_session'",
                &[],
            )
            .unwrap()
            .get(0);
        assert_eq!(count, 0, "failed Save rolls back its change set too");
    }
}

#[test]
fn sessions_concurrent_reads_keep_revision_and_record_entries_together() {
    let Some(mut f) = Fixture::new() else { return };
    assert_ok(&f.create());
    let schema = f.schema.clone();
    let principal = f.principal.clone();
    let session_id = f.session_id.clone();
    let reader = std::thread::spawn(move || {
        let mut client =
            kernel::connect_postgres(&std::env::var("KERNEL_TEST_DATABASE_URL").unwrap()).unwrap();
        client.batch_execute(&format!("set search_path to {schema}; set session authorization {principal}; set kernel.actor_id='human'")).unwrap();
        for _ in 0..40 {
            let result:Value=client.query_one("select kernel_work_session($1::jsonb)",&[&json!({"app_id":APP,"customer_id":CUSTOMER,"schema_version":VERSION,"session_id":session_id,"operation":"get"})]).unwrap().get(0);
            assert_ok(&result);
            let revision = result["data"]["revision"].as_i64().unwrap();
            let entries = overlay(&result);
            if revision == 1 {
                assert_eq!(entries, json!([]));
            } else {
                assert_eq!(entries[0]["value"]["value"], (10 + revision).to_string());
            }
        }
    });
    for revision in 1..=20 {
        stage(
            &mut f,
            revision,
            &format!("concurrent{revision}"),
            &(11 + revision).to_string(),
        );
    }
    reader.join().unwrap();
}

#[test]
fn sessions_human_can_save_agent_authored_entries() {
    let Some(mut f) = Fixture::without_policy() else {
        return;
    };
    assert_ok(&f.create());
    f.actor("agent");
    let staged = stage(&mut f, 1, "agent-stage", "12");
    assert_eq!(overlay(&staged)[0]["source"], "agent");
    f.actor("human");
    let saved = f.work(json!({"operation":"save","expected_revision":2,"request_id":"human-save"}));
    assert_ok(&saved);
    assert_eq!(saved["data"]["cleared"], true);
    f.approve_saved(&saved);
    let canonical = f.query(json!({}));
    assert_ok(&canonical);
    assert_eq!(canonical["data"][0]["values"]["score"]["value"], "12");
}

#[test]
fn sessions_agents_can_discard_their_own_thread_anchored_entries() {
    let Some(mut f) = Fixture::new() else { return };
    assert_ok(&f.create());
    f.actor("agent");
    assert_ok(&f.work(json!({"operation":"stage","changes":[{"model_id":"item","record_id":RECORD,"field_id":"score","thread_id":"context","value":{"type":"number","value":"12"}}]})));
    let discarded = f.work(json!({"operation":"discard_source","source":"agent"}));
    assert_ok(&discarded);
    assert_eq!(overlay(&discarded), json!([]));
}

#[test]
fn sessions_unstage_only_against_current_canonical_value() {
    let Some(mut f) = Fixture::without_policy() else {
        return;
    };
    assert_ok(&f.create());
    stage(&mut f, 1, "first", "12");
    let moved=f.call("kernel_apply_change_set",json!({"app_id":APP,"customer_id":CUSTOMER,"actor_id":"human","source_kind":"fixture","mode":"mainline","writes":[{"model_id":"item","record_key":{"type":"record_id","value":RECORD},"effective_start":"2026-01-01","values":{"score":{"type":"number","value":"11"}}}]}));
    assert_ok(&moved);
    let original = stage(&mut f, 2, "original-baseline", "10");
    assert_eq!(overlay(&original)[0]["baseline"]["value"], "10");
    let current = f.work(json!({"operation":"get"}));
    assert_ok(&current);
    assert_eq!(overlay(&current)[0]["stale"], true);
    assert_eq!(overlay(&current)[0]["value"]["value"], "10");
    assert_eq!(overlay(&current)[0]["current_value"]["value"], "11");
    let save = json!({"operation":"save","expected_revision":3,"request_id":"save-original"});
    assert_error(&f.work(save.clone()), "stale_base");
    let mut confirmed = save;
    confirmed["confirmed_stale"] = json!([{"model_id":"item","record_id":RECORD,"field_id":"score","current_version":overlay(&current)[0]["current_version"]}]);
    let saved = f.work(confirmed);
    assert_ok(&saved);
    f.approve_saved(&saved);
    assert_eq!(
        f.query(json!({}))["data"][0]["values"]["score"]["value"],
        "10"
    );
    stage(&mut f, 4, "another-edit", "13");
    let unstaged = stage(&mut f, 5, "current-value", "10.00");
    assert_eq!(overlay(&unstaged), json!([]));
}

#[test]
fn sessions_gone_targets_remain_recoverable_and_save_confirms_then_drops() {
    for lifecycle in ["deleted", "ended", "archived", "inactive"] {
        let Some(mut f) = Fixture::without_policy() else {
            return;
        };
        let field = if lifecycle == "archived" || lifecycle == "inactive" {
            "custom_score"
        } else {
            "score"
        };
        let target = if lifecycle == "deleted" {
            json!({"model_id":"item","record_id":RECORD})
        } else {
            json!({"model_id":"item","record_id":RECORD,"field_id":field})
        };
        let change = json!({"model_id":"item","record_id":RECORD,"field_id":field,"value":{"type":"number","value":"12"}});
        assert_ok(&f.work(json!({"operation":"create","expected_revision":0,"request_id":"create","title":"Gone","as_of":"2026-01-02"})));
        assert_ok(&f.work(json!({"operation":"stage","changes":[change]})));
        f.actor("agent");
        assert_ok(&f.work(json!({"operation":"stage","changes":[{"model_id":"item","record_id":RECORD,"field_id":"rate","value":{"type":"money_rate","value":{"amount":"200","currency":"USD","period":"annual"}}}]})));
        f.actor("human");
        assert_ok(&f.work(json!({"operation":"thread_open","expected_revision":3,"request_id":"thread","thread_id":"t","anchor":target})));
        assert_ok(&f.work(json!({"operation":"propose","expected_revision":4,"request_id":"propose","thread_id":"t","changes":[change]})));
        f.client
            .batch_execute("reset session authorization")
            .unwrap();
        match lifecycle {
            "deleted" => {
                f.client.batch_execute(&format!("insert into item_version(id,record_id,app_id,customer_id,stage,effective_start,change_set_id,applied_at,tombstones_record) values('00000000-0000-0000-0000-000000000099','{RECORD}','{APP}','{CUSTOMER}','mainline','2026-01-02',1,now(),true)")).unwrap();
            }
            "ended" => {
                f.client.batch_execute(&format!("update item_version set effective_end='2026-01-01' where record_id='{RECORD}'")).unwrap();
            }
            "archived" | "inactive" => {
                let path = if lifecycle == "archived" {
                    "archived_at"
                } else {
                    "lifecycle"
                };
                let value = if lifecycle == "archived" {
                    "2026-01-02"
                } else {
                    "inactive"
                };
                f.client.execute("update schema_revision set schema=jsonb_set(schema,array['custom_fields','0',$1],to_jsonb($2::text))", &[&path,&value]).unwrap();
            }
            _ => unreachable!(),
        }
        f.actor("human");
        let reason = if field == "score" {
            "record_gone"
        } else {
            "field_archived"
        };
        let gone = f.work(json!({"operation":"get"}));
        assert_ok(&gone);
        assert_eq!(overlay(&gone)[0]["gone"], reason, "{lifecycle}: {gone}");
        assert_eq!(overlay(&gone)[0]["stale"], true);
        assert_eq!(gone["data"]["threads"]["t"]["anchor"]["gone"], reason);
        assert_eq!(
            gone["data"]["threads"]["t"]["proposal"]["changes"][0]["gone"],
            reason
        );
        let read = f.query(json!({"as_of":"2026-01-02","work":f.work_ref()}));
        assert_ok(&read);
        // Without a policy the other record stays readable beside the gone one.
        if field == "score" {
            assert!(
                read["data"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|row| row["record_id"] != RECORD),
                "{read}"
            );
        }
        let aggregate=f.call("kernel_data_query",json!({"app_id":APP,"customer_id":CUSTOMER,"schema_version":VERSION,"model_id":"item","as_of":"2026-01-02","kind":"aggregate","metrics":[{"fn":"count"},{"fn":"sum","field":"score"}],"work":f.work_ref()}));
        assert_ok(&aggregate);
        if field == "score" {
            assert_eq!(aggregate["data"]["total"]["metrics"], json!(["1", "900"]));
        } else {
            assert_eq!(aggregate["data"]["total"]["metrics"], json!(["2", "910"]));
        }
        // Every working operation that does not stage the gone target stays
        // usable, including copying the session and removing entries.
        let mut revision = 5;
        for mut operation in [
            json!({"operation":"thread_reply","thread_id":"t","message":"Still here"}),
            json!({"operation":"discard_source","source":"agent"}),
        ] {
            if !is_edit(&operation) {
                operation["expected_revision"] = json!(revision);
                operation["request_id"] = json!(format!("recover{revision}"));
            }
            assert_ok(&f.work(operation));
            revision += 1;
        }
        let source = f.session_id.clone();
        f.session_id = uuid::Uuid::new_v4().to_string();
        assert_ok(&f.work(json!({"operation":"duplicate","source_session_id":source,"expected_revision":0,"request_id":"copy","title":"Copy"})));
        let removed = f.work(
            json!({"operation":"unstage","model_id":"item","record_id":RECORD,"field_id":field}),
        );
        assert_ok(&removed);
        assert_eq!(overlay(&removed), json!([]));
        f.session_id = source;
        let current = f.work(json!({"operation":"get"}));
        assert_ok(&current);
        assert_eq!(overlay(&current).as_array().unwrap().len(), 1);
        assert_eq!(overlay(&current)[0]["value"]["value"], "12");
        assert!(current["data"]["threads"]["t"]["proposal"].is_object());
        assert_ok(&f.work(json!({"operation":"dismiss","expected_revision":revision,"request_id":"dismiss","thread_id":"t"})));
        revision += 1;
        let save =
            json!({"operation":"save","expected_revision":revision,"request_id":"save-gone"});
        assert_error(&f.work(save.clone()), "stale_base");
        let mut save = save;
        save["confirmed_stale"] = json!([{"model_id":"item","record_id":RECORD,"field_id":field,"current_version":overlay(&current)[0]["current_version"],"gone":reason}]);
        // A confirmed all-gone Save writes nothing and only clears the overlay.
        let saved = f.work(save.clone());
        assert_ok(&saved);
        assert_eq!(saved["data"]["cleared"], true);
        assert_eq!(saved["data"]["change_set"], Value::Null);
        assert_ok(&f.work(save));
        assert_ok(&f.work(
            json!({"operation":"archive","expected_revision":revision+1,"request_id":"archive"}),
        ));
        assert_ok(&f.work(json!({"operation":"get"})));
        f.client
            .batch_execute("reset session authorization")
            .unwrap();
        let count: i64 = f
            .client
            .query_one(
                "select count(*) from change_set where source_kind='work_session'",
                &[],
            )
            .unwrap()
            .get(0);
        assert_eq!(count, 0);
    }
}

#[test]
fn sessions_gone_targets_do_not_mask_current_read_denials() {
    for field in ["score", "custom_score"] {
        let Some(mut f) = Fixture::new() else { return };
        assert_ok(&f.create());
        assert_ok(&f.work(json!({"operation":"stage","changes":[{"model_id":"item","record_id":RECORD,"field_id":field,"value":{"type":"number","value":"12"}}]})));
        f.client
            .batch_execute("reset session authorization")
            .unwrap();
        if field == "score" {
            // The last ordinary image is no longer readable, even though ended.
            f.client.batch_execute(&format!("update item_version set owner='other',effective_end='2026-01-01' where record_id='{RECORD}'; update work_session set as_of='2026-01-02'")).unwrap();
        } else {
            f.client.batch_execute("update schema_revision set schema=jsonb_set(schema,'{custom_fields,0,archived_at}','\"2026-01-02\"'); update kernel_actor_membership set role='revoked' where actor_id='human'").unwrap();
        }
        f.actor("human");
        assert_error(&f.work(json!({"operation":"get"})), "authorization_denied");
        // Removing an entry reads nothing, so the owner can clear the
        // unreadable entry and use the session again.
        let removed = f.work(
            json!({"operation":"unstage","model_id":"item","record_id":RECORD,"field_id":field}),
        );
        assert_ok(&removed);
        assert_eq!(overlay(&removed), json!([]));
        assert_ok(&f.work(json!({"operation":"get"})));
    }
}

#[test]
fn sessions_save_omits_archived_field_but_applies_live_entries() {
    let Some(mut f) = Fixture::without_policy() else {
        return;
    };
    assert_ok(&f.create());
    let staged=f.work(json!({"operation":"stage","changes":[change("12"),{"model_id":"item","record_id":RECORD,"field_id":"custom_score","value":{"type":"number","value":"8"}}]}));
    assert_ok(&staged);
    f.client.batch_execute("reset session authorization; update schema_revision set schema=jsonb_set(schema,'{custom_fields,0,archived_at}','\"2026-01-02\"')").unwrap();
    f.actor("human");
    let current = f.work(json!({"operation":"get"}));
    assert_ok(&current);
    let saved=f.work(json!({"operation":"save","expected_revision":2,"request_id":"save-live","confirmed_stale":[{"model_id":"item","record_id":RECORD,"field_id":"custom_score","current_version":overlay(&current)[0]["current_version"],"gone":"field_archived"}]}));
    assert_ok(&saved);
    assert!(saved["data"]["change_set"]["id"].is_number());
    f.approve_saved(&saved);
    assert_eq!(
        f.query(json!({}))["data"][0]["values"]["score"]["value"],
        "12"
    );
}

#[test]
fn sessions_expired_readable_image_does_not_hide_a_live_denied_winner() {
    let Some(mut f) = Fixture::new() else { return };
    assert_ok(&f.create());
    stage(&mut f, 1, "edit", "12");
    f.client
        .batch_execute("reset session authorization")
        .unwrap();
    f.client.batch_execute(&format!("update work_session set as_of='2026-01-03'; update item_version set effective_start='2025-01-01',owner='other' where record_id='{RECORD}'; insert into item_version select (jsonb_populate_record(null::item_version,to_jsonb(v)||jsonb_build_object('id','00000000-0000-0000-0000-000000000099','owner','human','effective_start','2026-01-01','effective_end','2026-01-02'))).* from item_version v where record_id='{RECORD}'")).unwrap();
    f.actor("human");
    assert_error(&f.work(json!({"operation":"get"})), "authorization_denied");
    assert_error(
        &f.work(json!({"operation":"stage","changes":[change("13")]})),
        "authorization_denied",
    );
}

#[test]
fn sessions_archived_field_still_requires_its_record_scoped_read_grant() {
    let Some(mut f) = Fixture::with_public_ids() else {
        return;
    };
    assert_ok(&f.create());
    let stage = json!({"operation":"stage","changes":[{"model_id":"item","record_id":RECORD,"field_id":"custom_score","value":{"type":"number","value":"12"}}]});
    assert_ok(&f.work(stage.clone()));
    f.client.batch_execute(&format!("reset session authorization; update item_version set owner='other' where record_id='{RECORD}'; update schema_revision set schema=jsonb_set(schema,'{{custom_fields,0,archived_at}}','\"2026-01-02\"')")).unwrap();
    f.actor("human");
    assert_ok(&f.query(json!({"select":["$id","$version"]})));
    assert_error(&f.work(json!({"operation":"get"})), "authorization_denied");
    assert_error(&f.work(stage), "authorization_denied");
    assert_ok(&f.work(json!({"operation":"unstage","model_id":"item","record_id":RECORD,"field_id":"custom_score"})));
}

#[test]
fn sessions_mutations_answer_only_for_touched_entries_while_others_are_unreadable() {
    let Some(mut f) = Fixture::new() else { return };
    f.make_other_record_visible();
    assert_ok(&f.create());
    let other = |n: &str| json!({"model_id":"item","record_id":OTHER_RECORD,"field_id":"score","value":{"type":"number","value":n}});
    assert_ok(&f.work(json!({"operation":"stage","changes":[change("12"),other("20")]})));
    // RECORD becomes unreadable; its entry stays in the session.
    f.client
        .batch_execute(&format!(
            "reset session authorization; update item_version set owner='other' where record_id='{RECORD}'"
        ))
        .unwrap();
    f.actor("human");
    assert_error(&f.work(json!({"operation":"get"})), "authorization_denied");
    // Mutations on readable entries and on metadata still succeed, and their
    // responses never carry the unreadable entry.
    let staged = f.work(json!({"operation":"stage","changes":[other("21")]}));
    assert_ok(&staged);
    assert_eq!(
        staged["data"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>(),
        vec!["entries", "removed", "revision"]
    );
    assert_eq!(staged["data"]["revision"], 3);
    assert_eq!(overlay(&staged).as_array().unwrap().len(), 1);
    assert_eq!(overlay(&staged)[0]["record_id"], OTHER_RECORD);
    assert_eq!(overlay(&staged)[0]["value"]["value"], "21");
    let pinned =
        f.work(json!({"operation":"pin","expected_revision":3,"request_id":"pin","pinned":true}));
    assert_eq!(pinned["data"], json!({"revision":4}));
    let opened = f.work(json!({"operation":"thread_open","expected_revision":4,"request_id":"open","thread_id":"t","anchor":{}}));
    assert_ok(&opened);
    assert!(!opened.to_string().contains(RECORD));
    // Staging the unreadable target itself is still denied.
    assert_error(
        &f.work(json!({"operation":"stage","changes":[change("13")]})),
        "authorization_denied",
    );
    // Restaging the same value answers the entry as it stands.
    let restaged = f.work(json!({"operation":"stage","changes":[other("21")]}));
    assert_eq!(restaged["data"]["entries"], staged["data"]["entries"]);
    assert_eq!(restaged["data"]["revision"], 6);
    // Removing the unreadable entry returns no data and restores get.
    let removed = f.work(
        json!({"operation":"unstage","model_id":"item","record_id":RECORD,"field_id":"score"}),
    );
    assert_ok(&removed);
    assert_eq!(removed["data"]["entries"], json!([]));
    assert_eq!(
        removed["data"]["removed"],
        json!([{"model_id":"item","record_id":RECORD,"field_id":"score"}])
    );
    let read = f.work(json!({"operation":"get"}));
    assert_ok(&read);
    assert_eq!(overlay(&read).as_array().unwrap().len(), 1);
}

#[test]
fn sessions_install_refuses_empty_predecessor_fork_tables() {
    let Some(mut f) = Fixture::new() else { return };
    install_legacy_session_fixture(&mut f);
    let before = legacy_preservation_snapshot(&mut f);
    let error = f
        .client
        .batch_execute(&f.bundle)
        .expect_err("legacy shapes are never reset");
    assert!(error
        .as_db_error()
        .unwrap()
        .message()
        .contains("legacy_schema_upgrade_unsupported"));
    f.client.batch_execute("rollback").unwrap();
    assert_eq!(legacy_preservation_snapshot(&mut f), before);
}

fn install_legacy_session_fixture(f: &mut Fixture) {
    f.client
        .batch_execute(
            "reset session authorization;
         drop table work_session_record cascade;
         drop table work_session cascade;
         create table work_session(id integer primary key, forks jsonb);
         create table work_session_record(id integer primary key, entries jsonb);",
        )
        .unwrap();
}

fn legacy_preservation_snapshot(f: &mut Fixture) -> Value {
    legacy_preservation_snapshot_for_client(&mut f.client)
}

fn legacy_preservation_snapshot_for_client(client: &mut postgres::Client) -> Value {
    client.query_one(
        "select jsonb_build_object(
           'sessions', (select coalesce(jsonb_agg(to_jsonb(s) order by id), '[]') from work_session s),
           'entries', (select coalesce(jsonb_agg(to_jsonb(r) order by id), '[]') from work_session_record r),
           'history', (select jsonb_agg(to_jsonb(v) order by id) from item_version v),
           'audit', (select jsonb_agg(to_jsonb(c) order by id) from change_set c))",
        &[],
    ).unwrap().get(0)
}

#[test]
fn sessions_install_preserves_populated_legacy_tables_and_history() {
    for populated in ["work_session", "work_session_record", "both"] {
        let Some(mut f) = Fixture::new() else { return };
        install_legacy_session_fixture(&mut f);
        if populated != "work_session_record" {
            f.client
                .batch_execute(r#"insert into work_session values(1, '{"draft":true}')"#)
                .unwrap();
        }
        if populated != "work_session" {
            f.client
                .batch_execute(r#"insert into work_session_record values(1, '[{"value":12}]')"#)
                .unwrap();
        }
        let before = legacy_preservation_snapshot(&mut f);
        let error = f
            .client
            .batch_execute(&f.bundle)
            .expect_err("populated legacy state must block cleanup");
        assert_eq!(
            error.as_db_error().unwrap().message(),
            "legacy_schema_upgrade_unsupported: existing data was preserved"
        );
        f.client.batch_execute("rollback").unwrap();
        assert_eq!(legacy_preservation_snapshot(&mut f), before);
    }
}

#[test]
fn sessions_install_does_not_treat_rls_hidden_legacy_rows_as_empty() {
    let Some(mut f) = Fixture::new() else { return };
    install_legacy_session_fixture(&mut f);
    f.client
        .batch_execute(&format!(
            "insert into work_session values(1, '{{}}');
         alter table work_session owner to {};
         alter table work_session_record owner to {};
         alter table work_session enable row level security;
         alter table work_session force row level security;
         grant create on schema {} to {};
         set session authorization {}",
            f.principal, f.principal, f.schema, f.principal, f.principal,
        ))
        .unwrap();
    let hidden: i64 = f
        .client
        .query_one("select count(*) from work_session", &[])
        .unwrap()
        .get(0);
    assert_eq!(hidden, 0);
    let error = f
        .client
        .batch_execute(&f.bundle)
        .expect_err("hidden working state must not be discarded");
    assert!(error
        .as_db_error()
        .unwrap()
        .message()
        .contains("legacy_schema_upgrade_unsupported"));
    f.client
        .batch_execute("rollback; reset session authorization")
        .unwrap();
    let preserved: i64 = f
        .client
        .query_one("select count(*) from work_session", &[])
        .unwrap()
        .get(0);
    assert_eq!(preserved, 1);
}

#[test]
fn sessions_install_refuses_missing_legacy_record_table() {
    let Some(mut f) = Fixture::new() else { return };
    install_legacy_session_fixture(&mut f);
    f.client
        .batch_execute("drop table work_session_record")
        .unwrap();
    let error = f
        .client
        .batch_execute(&f.bundle)
        .expect_err("legacy shape is unsupported");
    assert!(error
        .as_db_error()
        .unwrap()
        .message()
        .contains("legacy_schema_upgrade_unsupported"));
    f.client.batch_execute("rollback").unwrap();
    let absent: bool = f
        .client
        .query_one("select to_regclass('work_session_record') is null", &[])
        .unwrap()
        .get(0);
    assert!(absent);
}

#[test]
fn sessions_install_preserves_legacy_rows_outside_a_repeatable_read_snapshot() {
    let Some(mut f) = Fixture::new() else { return };
    install_legacy_session_fixture(&mut f);
    f.client
        .batch_execute("begin isolation level repeatable read")
        .unwrap();
    let before_insert: i64 = f
        .client
        .query_one("select count(*) from work_session", &[])
        .unwrap()
        .get(0);
    assert_eq!(before_insert, 0);
    let url = std::env::var("KERNEL_TEST_DATABASE_URL").unwrap();
    let mut writer = kernel::connect_postgres(&url).unwrap();
    writer
        .batch_execute(&format!(
            r#"set search_path to {}; insert into work_session values(1, '{{"draft":true}}')"#,
            f.schema,
        ))
        .unwrap();
    let snapshot_count: i64 = f
        .client
        .query_one("select count(*) from work_session", &[])
        .unwrap()
        .get(0);
    assert_eq!(
        snapshot_count, 0,
        "the installer has a stale empty snapshot"
    );
    let before = legacy_preservation_snapshot_for_client(&mut writer);
    let error = f
        .client
        .batch_execute(&f.bundle)
        .expect_err("stale transaction snapshots must not authorize cleanup");
    assert_eq!(
        error.as_db_error().unwrap().message(),
        "legacy_schema_upgrade_unsupported: existing data was preserved"
    );
    f.client.batch_execute("rollback").unwrap();
    assert_eq!(legacy_preservation_snapshot(&mut f), before);
}

#[test]
fn sessions_install_cannot_clean_up_a_concurrent_legacy_insert() {
    let Some(mut f) = Fixture::new() else { return };
    install_legacy_session_fixture(&mut f);
    f.client
        .batch_execute("begin; insert into work_session values(1, '{}')")
        .unwrap();
    let url = std::env::var("KERNEL_TEST_DATABASE_URL").unwrap();
    let mut installer = kernel::connect_postgres(&url).unwrap();
    installer
        .batch_execute(&format!(
            "set search_path to {}; set lock_timeout='100ms'",
            f.schema
        ))
        .unwrap();
    let error = installer
        .batch_execute(&f.bundle)
        .expect_err("legacy shape is refused without inspecting rows");
    assert!(error
        .as_db_error()
        .unwrap()
        .message()
        .contains("legacy_schema_upgrade_unsupported"));
    installer.batch_execute("rollback").unwrap();
    f.client.batch_execute("commit").unwrap();
    let before = legacy_preservation_snapshot(&mut f);
    let error = installer
        .batch_execute(&f.bundle)
        .expect_err("committed legacy insert must be preserved");
    assert_eq!(
        error.as_db_error().unwrap().message(),
        "legacy_schema_upgrade_unsupported: existing data was preserved"
    );
    installer.batch_execute("rollback").unwrap();
    assert_eq!(legacy_preservation_snapshot(&mut f), before);
}

#[test]
fn sessions_reinstall_keeps_current_tables_and_ignores_other_schemas() {
    let Some(mut f) = Fixture::new() else { return };
    assert_ok(&f.create());
    assert_ok(&stage(&mut f, 1, "stage", "12"));
    f.client
        .batch_execute("reset session authorization")
        .unwrap();
    f.client
        .batch_execute("alter table work_session add column forks jsonb")
        .unwrap();
    // A current field_id table must survive even when legacy session metadata remains.
    // Old-shape tables in another schema on the search path are not this
    // installation's tables and must remain untouched.
    let decoy = format!("{}_decoy", f.schema);
    f.client
        .batch_execute(&format!(
            "create schema {decoy}; set search_path to {decoy}; {}; set search_path to {}, {decoy}",
            predecessor_session_tables(),
            f.schema
        ))
        .unwrap();
    let bundle = f.bundle.clone();
    f.client
        .batch_execute(&bundle)
        .expect("reinstall work runtime");
    let count = |f: &mut Fixture, table: &str| -> i64 {
        f.client
            .query_one(&format!("select count(*) from {table}"), &[])
            .unwrap()
            .get(0)
    };
    let schema = f.schema.clone();
    assert_eq!(count(&mut f, &format!("{schema}.work_session")), 1);
    assert_eq!(count(&mut f, &format!("{schema}.work_session_record")), 1);
    assert_eq!(count(&mut f, &format!("{decoy}.work_session")), 0);
    assert_eq!(count(&mut f, &format!("{decoy}.work_session_record")), 0);
    // A fresh installation schema must not reach the other schema's old tables
    // through the search path.
    let fresh = format!("{schema}_fresh");
    f.client
        .batch_execute(&format!(
            "create schema {fresh}; set search_path to {fresh}, {decoy}"
        ))
        .unwrap();
    f.client
        .batch_execute(&bundle)
        .expect("install into a fresh schema");
    let has_forks: bool = f
        .client
        .query_one(
            &format!("select exists(select 1 from pg_attribute where attrelid = to_regclass('{decoy}.work_session') and attname = 'forks')"),
            &[],
        )
        .unwrap()
        .get(0);
    assert!(has_forks, "installation changed another schema's tables");
    assert_eq!(count(&mut f, &format!("{fresh}.work_session")), 0);
}

#[test]
fn sessions_duplicate_copies_one_source_revision() {
    let Some(mut f) = Fixture::new() else { return };
    assert_ok(&f.create());
    let rule = json!({"model_id":"item","field_id":"score","value":{"type":"parameter","parameter":"n"},"parameters":{"n":{"type":"number","value":"20"}}});
    assert_ok(&f.work(json!({"operation":"rule_create","expected_revision":1,"request_id":"rule","rule_id":"fixed","rule":rule})));
    // A source mutation is in flight, holding the source's lock.
    let mut source = f.base();
    source.as_object_mut().unwrap().extend(json!({"operation":"rule_parameters","expected_revision":2,"request_id":"params","rule_id":"fixed","parameters":{"n":{"type":"number","value":"30"}}}).as_object().unwrap().clone());
    f.client.batch_execute("begin").unwrap();
    let changed: Value = f
        .client
        .query_one("select kernel_work_session($1::jsonb)", &[&source])
        .unwrap()
        .get(0);
    assert_ok(&changed);
    let copy_id = uuid::Uuid::new_v4().to_string();
    let mut request = f.base();
    request.as_object_mut().unwrap().extend(json!({"operation":"duplicate","session_id":copy_id,"source_session_id":f.session_id,"expected_revision":0,"request_id":"copy","title":"Copy"}).as_object().unwrap().clone());
    let (schema, principal) = (f.schema.clone(), f.principal.clone());
    let (sender, receiver) = std::sync::mpsc::channel();
    let duplicate = std::thread::spawn(move || {
        let mut client =
            kernel::connect_postgres(&std::env::var("KERNEL_TEST_DATABASE_URL").unwrap()).unwrap();
        client.batch_execute(&format!("set search_path to {schema}; set session authorization {principal}; set kernel.actor_id='human'; set statement_timeout='30s'")).unwrap();
        let pid: i32 = client
            .query_one("select pg_backend_pid()", &[])
            .unwrap()
            .get(0);
        sender.send(pid).unwrap();
        client
            .query_one("select kernel_work_session($1::jsonb)", &[&request])
            .map(|row| row.get::<_, Value>(0))
    });
    let pid = receiver
        .recv_timeout(std::time::Duration::from_secs(30))
        .unwrap();
    let mut observer =
        kernel::connect_postgres(&std::env::var("KERNEL_TEST_DATABASE_URL").unwrap()).unwrap();
    let start = std::time::Instant::now();
    let waiting = loop {
        let waiting: bool = observer.query_one("select exists(select 1 from pg_locks where pid=$1 and locktype='advisory' and not granted)", &[&pid]).unwrap().get(0);
        if waiting || start.elapsed() > std::time::Duration::from_secs(20) {
            break waiting;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    };
    assert!(waiting, "duplicate waits for the in-flight source mutation");
    f.client.batch_execute("commit").unwrap();
    assert_ok(&duplicate.join().unwrap().unwrap());
    f.session_id = copy_id;
    let copied = f.work(json!({"operation":"get"}));
    assert_ok(&copied);
    // Rules and entries both come from the committed source revision.
    assert_eq!(
        copied["data"]["rules"]["fixed"]["parameters"]["n"]["value"],
        "30"
    );
    assert_eq!(overlay(&copied)[0]["value"]["value"], "30");
}

#[test]
fn sessions_replays_return_only_what_an_authorized_read_would() {
    let Some(mut f) = Fixture::new() else { return };
    assert_ok(&f.create());
    let open = json!({"operation":"thread_open","thread_id":"t","anchor":{},"expected_revision":1,"request_id":"open"});
    assert_ok(&f.work(open.clone()));
    assert_ok(&f.work(json!({"operation":"propose","thread_id":"t","expected_revision":2,"request_id":"propose","changes":[change("18")]})));
    let replayed = f.work(open.clone());
    assert_ok(&replayed);
    assert_eq!(
        replayed["data"]["thread"]["proposal"]["changes"][0]["value"]["value"],
        "18"
    );
    // Once the proposal's record is unreadable, replaying the open (which now
    // returns the thread with that proposal) is denied, as get is.
    f.client
        .batch_execute(&format!(
            "reset session authorization; update item_version set owner='other' where record_id='{RECORD}'"
        ))
        .unwrap();
    f.actor("human");
    assert_error(&f.work(json!({"operation":"get"})), "authorization_denied");
    assert_error(&f.work(open), "authorization_denied");
}

#[test]
fn sessions_replays_answer_in_each_operations_shape() {
    let Some(mut f) = Fixture::without_policy() else {
        return;
    };
    let keys = |value: &Value| -> Vec<String> {
        let mut keys: Vec<String> = value["data"].as_object().unwrap().keys().cloned().collect();
        keys.sort();
        keys
    };
    let create = json!({"operation":"create","expected_revision":0,"request_id":"create","title":"Shapes","as_of":"2026-01-01"});
    let rule = json!({"model_id":"item","field_id":"custom_score","value":{"type":"literal","value":{"type":"number","value":"3"}}});
    let operations = [
        (create, vec!["revision", "session_id"]),
        (
            json!({"operation":"stage","changes":[change("12")]}),
            vec!["entries", "removed", "revision"],
        ),
        (
            json!({"operation":"thread_open","expected_revision":2,"request_id":"open","thread_id":"t","anchor":{}}),
            vec!["revision", "thread"],
        ),
        (
            json!({"operation":"thread_reply","expected_revision":3,"request_id":"reply","thread_id":"t","message":"Hi"}),
            vec!["message", "revision"],
        ),
        (
            json!({"operation":"propose","expected_revision":4,"request_id":"propose","thread_id":"t","changes":[change("18")]}),
            vec!["proposal", "revision"],
        ),
        (
            json!({"operation":"pull","expected_revision":5,"request_id":"pull","thread_id":"t"}),
            vec!["entries", "removed", "revision"],
        ),
        (
            json!({"operation":"rule_create","expected_revision":6,"request_id":"rule","rule_id":"r","rule":rule}),
            vec!["entries", "overlaps", "removed", "revision", "rule"],
        ),
        (
            json!({"operation":"rule_parameters","expected_revision":7,"request_id":"params","rule_id":"r","parameters":{}}),
            vec!["entries", "overlaps", "removed", "revision", "rule"],
        ),
        (
            json!({"operation":"rule_remove","expected_revision":8,"request_id":"remove-rule","rule_id":"r"}),
            vec!["entries", "removed", "revision"],
        ),
        (
            json!({"operation":"unstage","model_id":"item","record_id":RECORD,"field_id":"score"}),
            vec!["entries", "removed", "revision"],
        ),
        (
            json!({"operation":"discard_source","source":"user"}),
            vec!["entries", "removed", "revision"],
        ),
        (
            json!({"operation":"pin","expected_revision":11,"request_id":"pin","pinned":true}),
            vec!["revision"],
        ),
        (
            json!({"operation":"stage","changes":[change("14")]}),
            vec!["entries", "removed", "revision"],
        ),
        (
            json!({"operation":"save","expected_revision":13,"request_id":"save"}),
            vec!["change_set", "cleared", "revision"],
        ),
    ];
    let mut done = Vec::new();
    for (request, expected) in operations {
        let live = f.work(request.clone());
        assert_ok(&live);
        assert_eq!(keys(&live), expected, "{request}");
        done.push((request, expected));
    }
    // Every replay (a repeat, for last-write-wins edits), including a pull
    // whose entries are gone, keeps its shape.
    for (request, expected) in done {
        let replay = f.work(request.clone());
        assert_ok(&replay);
        assert_eq!(keys(&replay), expected, "replay {request}");
        for collection in ["entries", "removed", "overlaps"] {
            if expected.contains(&collection) {
                assert!(replay["data"][collection].is_array(), "replay {request}");
            }
        }
    }
}

#[test]
fn bulk_removals_report_only_targets_a_fresh_read_would_show() {
    let rule = json!({"model_id":"item","field_id":"custom_score","value":{"type":"literal","value":{"type":"number","value":"3"}}});
    for revoke in ["record", "field"] {
        for path in ["discard_source", "rule_remove", "rule_parameters"] {
            let Some(mut f) = Fixture::new() else { return };
            assert_ok(&f.create());
            let setup = if path == "discard_source" {
                f.work(json!({"operation":"stage","changes":[change("12")]}))
            } else {
                f.work(json!({"operation":"rule_create","expected_revision":1,"request_id":"rule","rule_id":"r","rule":rule}))
            };
            assert_ok(&setup);
            assert_eq!(
                setup["data"]["entries"].as_array().unwrap().len(),
                1,
                "{revoke} {path}"
            );
            let (revoke_sql, restore_sql) = if revoke == "record" {
                (
                    format!("update item_version set owner='other' where record_id='{RECORD}'"),
                    format!("update item_version set owner='human' where record_id='{RECORD}'"),
                )
            } else {
                (
                    "update kernel_actor_membership set role='reader' where actor_id='human'"
                        .to_string(),
                    "update kernel_actor_membership set role='editor' where actor_id='human'"
                        .to_string(),
                )
            };
            f.client
                .batch_execute(&format!("reset session authorization; {revoke_sql}"))
                .unwrap();
            f.actor("human");
            let request = match path {
                "discard_source" => {
                    json!({"operation":"discard_source","source":"user"})
                }
                "rule_remove" => {
                    json!({"operation":"rule_remove","expected_revision":2,"request_id":"bulk","rule_id":"r"})
                }
                _ => {
                    json!({"operation":"rule_parameters","expected_revision":2,"request_id":"bulk","rule_id":"r","parameters":{}})
                }
            };
            let removed = f.work(request.clone());
            if path == "rule_parameters" && revoke == "field" {
                // Re-evaluating a rule whose target field is unreadable is denied.
                assert_error(&removed, "authorization_denied");
                continue;
            }
            assert_ok(&removed);
            assert_eq!(removed["data"]["removed"], json!([]), "{revoke} {path}");
            assert_eq!(removed["data"]["entries"], json!([]), "{revoke} {path}");
            let replayed = f.work(request);
            assert_ok(&replayed);
            assert_eq!(
                replayed["data"]["removed"],
                json!([]),
                "replay {revoke} {path}"
            );
            // The deletion still happened: with access restored, nothing is staged.
            f.client
                .batch_execute(&format!("reset session authorization; {restore_sql}"))
                .unwrap();
            f.actor("human");
            let state = f.work(json!({"operation":"get"}));
            assert_ok(&state);
            assert_eq!(state["data"]["overlay"], json!([]), "{revoke} {path}");
        }
    }
}

#[test]
fn bulk_removals_still_report_readable_targets() {
    let Some(mut f) = Fixture::new() else { return };
    assert_ok(&f.create());
    assert_ok(&f.work(json!({"operation":"stage","changes":[change("12")]})));
    let removed = f.work(json!({"operation":"discard_source","source":"user"}));
    assert_ok(&removed);
    assert_eq!(
        removed["data"]["removed"],
        json!([{"model_id":"item","record_id":RECORD,"field_id":"score"}])
    );
}

/// Function shapes earlier branch releases defined that the current runtime
/// replaced or removed; none may survive an upgrade.
fn refuses_legacy_release(bundle: &str) {
    let Some(mut f) = Fixture::new() else { return };
    f.client.batch_execute(&format!("reset session authorization; drop schema {} cascade; create schema {}; set search_path to {}", f.schema, f.schema, f.schema)).unwrap();
    f.client
        .batch_execute(bundle)
        .expect("install historical fixture");
    f.client.batch_execute("create table preserved_fixture(value text); insert into preserved_fixture values('keep this history')").unwrap();
    let snapshot = |client: &mut postgres::Client| -> Value {
        client.query_one("select jsonb_build_object('functions', (select jsonb_agg(pg_get_functiondef(p.oid) order by p.oid) from pg_proc p where pronamespace=current_schema()::regnamespace), 'columns', (select jsonb_agg(to_jsonb(c) order by table_name, ordinal_position) from information_schema.columns c where table_schema=current_schema()))", &[]).unwrap().get(0)
    };
    let before = snapshot(&mut f.client);
    f.client
        .batch_execute(&f.bundle)
        .expect_err("pre-rework release is no longer upgraded destructively");
    f.client.batch_execute("rollback").unwrap();
    assert_eq!(snapshot(&mut f.client), before);
    assert_eq!(
        f.client
            .query_one("select value from preserved_fixture", &[])
            .unwrap()
            .get::<_, String>(0),
        "keep this history"
    );
}

#[test]
fn sessions_refuse_upgrade_from_the_first_session_release() {
    refuses_legacy_release(include_str!(
        "fixtures/historical-sql/2026-10-24.canvas-sessions-v78.sql"
    ));
}

#[test]
fn sessions_refuse_upgrade_from_the_last_fork_release() {
    refuses_legacy_release(include_str!(
        "fixtures/historical-sql/2026-10-26.canvas-sessions-v82.sql"
    ));
}

#[test]
fn sessions_refuse_upgrade_from_the_void_evaluator_release() {
    refuses_legacy_release(include_str!(
        "fixtures/historical-sql/2026-10-26.canvas-sessions-v83.sql"
    ));
}

#[test]
fn sessions_refuse_upgrade_from_the_last_app_setting_release() {
    refuses_legacy_release(include_str!(
        "fixtures/historical-sql/2026-10-31.canvas-in-chat-v115.sql"
    ));
}

#[test]
fn every_new_revision_notifies_once_with_only_its_customer_session_and_revision() {
    let Some(mut f) = Fixture::new() else { return };
    f.client
        .batch_execute("listen kernel_work_session")
        .unwrap();
    assert_ok(&f.create());
    stage(&mut f, 1, "first", "12");
    let pin = json!({"operation":"pin","expected_revision":2,"request_id":"pin","pinned":true});
    assert_ok(&f.work(pin.clone()));
    // A replay and a refused mutation change nothing, so they notify nothing.
    assert_ok(&f.work(pin));
    assert_error(
        &f.work(
            json!({"operation":"pin","expected_revision":2,"request_id":"stale","pinned":false}),
        ),
        "revision_conflict",
    );
    // Tests share the database, so keep only this session's notifications.
    let session = f.session_id.to_string();
    let payloads: Vec<(String, String)> = f
        .client
        .notifications()
        .iter()
        .map(|n| Ok((n.channel().to_owned(), n.payload().to_owned())))
        .filter(|(_, payload)| Ok(payload.contains(&session)))
        .collect()
        .unwrap();
    assert_eq!(
        payloads,
        vec![
            (
                "kernel_work_session".to_owned(),
                format!("{CUSTOMER}:{session}:1")
            ),
            (
                "kernel_work_session".to_owned(),
                format!("{CUSTOMER}:{session}:2")
            ),
            (
                "kernel_work_session".to_owned(),
                format!("{CUSTOMER}:{session}:3")
            ),
        ]
    );
}

#[test]
fn published_writes_drafts_and_discards_notify_their_scope() {
    // A draft notifies at creation and again when it is discarded, so an
    // open approver's review re-reads; a mainline write notifies once.
    for (mode, expected) in [("draft", 2), ("mainline", 1)] {
        let Some(mut f) = Fixture::without_policy() else {
            return;
        };
        // Tests share the database, so keep only this connection's notifications.
        let own: i32 = f
            .client
            .query_one("select pg_backend_pid()", &[])
            .unwrap()
            .get(0);
        f.client.batch_execute("listen kernel_canonical").unwrap();
        let written = f.call("kernel_apply_change_set",json!({"app_id":APP,"customer_id":CUSTOMER,"actor_id":"human","source_kind":"fixture","mode":mode,"writes":[{"model_id":"item","record_key":{"type":"record_id","value":RECORD},"effective_start":"2026-01-01","values":{"score":{"type":"number","value":"11"}}}]}));
        assert_ok(&written);
        if mode == "draft" {
            assert_ok(&f.call(
                "kernel_discard_draft_change_set",
                json!({"app_id":APP,"customer_id":CUSTOMER,"change_set_id":written["data"]["id"]}),
            ));
        }
        let payloads: Vec<String> = f
            .client
            .notifications()
            .iter()
            .filter(|n| Ok(n.process_id() == own))
            .map(|n| Ok(n.payload().to_owned()))
            .collect()
            .unwrap();
        assert_eq!(
            payloads,
            vec![format!("{APP}:{CUSTOMER}"); expected],
            "{mode}"
        );
    }
}

fn draft_threads(f: &mut Fixture, request: Value) -> Value {
    let mut full = json!({"app_id":APP,"customer_id":CUSTOMER});
    full.as_object_mut()
        .unwrap()
        .extend(request.as_object().unwrap().clone());
    f.call("kernel_draft_threads", full)
}

#[test]
fn draft_save_carries_open_threads_that_reviewers_read_reply_and_resolve() {
    let Some(mut f) = Fixture::without_policy() else {
        return;
    };
    assert_ok(&f.create());
    stage(&mut f, 1, "stage", "12");
    let anchor = json!({"model_id":"item","record_id":RECORD,"field_id":"score"});
    for (rev, id, anchor) in [
        (2, "t1", anchor.clone()),
        (3, "t2", json!({})),
        (4, "t3", json!({})),
    ] {
        assert_ok(&f.work(json!({"operation":"thread_open","expected_revision":rev,"request_id":format!("open-{id}"),"thread_id":id,"anchor":anchor})));
    }
    assert_ok(&f.work(json!({"operation":"thread_reply","expected_revision":5,"request_id":"why","thread_id":"t1","message":"Why 12?"})));
    assert_ok(&f.work(json!({"operation":"thread_resolve","expected_revision":6,"request_id":"done","thread_id":"t3"})));
    assert_ok(&f.work(json!({"operation":"propose","expected_revision":7,"request_id":"idea","thread_id":"t2","changes":[change("14")]})));
    let saved = f.work(json!({"operation":"save","expected_revision":8,"request_id":"save"}));
    assert_ok(&saved);
    let draft = saved["data"]["change_set"]["id"].as_i64().unwrap();

    // Open threads travel in the session's shape; resolved ones and proposals stay.
    let read = draft_threads(&mut f, json!({"operation":"get","change_set_id":draft}));
    assert_ok(&read);
    assert_eq!(read["data"]["status"], "draft");
    // The draft names its session, so a host can find its author.
    assert_eq!(read["data"]["source_kind"], "work_session");
    assert_eq!(read["data"]["source_ref"], json!(f.session_id.clone()));
    let threads = &read["data"]["threads"];
    assert_eq!(threads.as_object().unwrap().len(), 2, "{threads}");
    assert!(threads.get("t3").is_none());
    assert!(threads["t2"].get("proposal").is_none());
    assert_eq!(threads["t1"]["anchor"], anchor);
    assert_eq!(threads["t1"]["resolved"], false);
    assert_eq!(threads["t1"]["messages"][0]["message"], "Why 12?");
    // The session keeps its threads.
    assert_eq!(
        f.work(json!({"operation":"get"}))["data"]["threads"]
            .as_object()
            .unwrap()
            .len(),
        3
    );

    // Another tenant member reads and replies by id (the host decides who
    // may); replies are replay-safe. Only the owner lists a session's drafts.
    f.actor("other");
    let session = f.session_id.clone();
    assert_error(
        &draft_threads(
            &mut f,
            json!({"operation":"by_session","session_id":session}),
        ),
        "authorization_denied",
    );
    let reply = json!({"operation":"reply","change_set_id":draft,"thread_id":"t1","request_id":"r1","message":"Market rate"});
    let replied = draft_threads(&mut f, reply.clone());
    assert_ok(&replied);
    assert_eq!(replied["data"]["message"]["actor_id"], "other");
    assert_eq!(replied["data"]["message"]["author_kind"], "human");
    assert_eq!(draft_threads(&mut f, reply.clone()), replied);
    let mut reused = reply.clone();
    reused["message"] = json!("Changed");
    assert_error(&draft_threads(&mut f, reused), "idempotency_conflict");
    // A receipt is its actor's: someone else who learns the request id and
    // sends the same body gets a conflict, not the original message.
    f.actor("human");
    let stolen = draft_threads(&mut f, reply.clone());
    assert_error(&stolen, "idempotency_conflict");
    assert!(!stolen.to_string().contains("Market rate"), "{stolen}");
    f.actor("other");
    assert_eq!(draft_threads(&mut f, reply.clone()), replied);
    assert_error(
        &draft_threads(
            &mut f,
            json!({"operation":"reply","change_set_id":draft,"thread_id":"nope","request_id":"r2","message":"Hi"}),
        ),
        "record_target_missing",
    );
    assert_error(
        &draft_threads(
            &mut f,
            json!({"operation":"reply","change_set_id":draft,"thread_id":"t1","request_id":"r3","message":" "}),
        ),
        "contract_validation_failed",
    );

    // An agent replies and resolves, whether by membership or context mark.
    f.actor("agent");
    let agent_reply = draft_threads(
        &mut f,
        json!({"operation":"reply","change_set_id":draft,"thread_id":"t1","request_id":"a1","message":"Benchmarks agree"}),
    );
    assert_ok(&agent_reply);
    assert_eq!(agent_reply["data"]["message"]["author_kind"], "agent");
    let resolve =
        json!({"operation":"resolve","change_set_id":draft,"thread_id":"t1","request_id":"res"});
    let agent_resolved = draft_threads(
        &mut f,
        json!({"operation":"resolve","change_set_id":draft,"thread_id":"t1","request_id":"agent-res"}),
    );
    assert_ok(&agent_resolved);
    assert_eq!(agent_resolved["data"]["thread"]["resolved"], true);
    f.actor("human");
    f.client
        .batch_execute("set kernel.actor_kind='agent'")
        .unwrap();
    let marked = draft_threads(
        &mut f,
        json!({"operation":"reply","change_set_id":draft,"thread_id":"t1","request_id":"m1","message":"Marked"}),
    );
    assert_eq!(
        marked["data"]["message"]["author_kind"], "agent",
        "{marked}"
    );
    f.client.batch_execute("reset kernel.actor_kind").unwrap();

    // Another customer cannot read or reply.
    for request in [
        json!({"operation":"get","change_set_id":draft,"customer_id":"elsewhere"}),
        json!({"operation":"by_session","session_id":f.session_id.clone(),"customer_id":"elsewhere"}),
        json!({"operation":"reply","change_set_id":draft,"thread_id":"t1","request_id":"x","message":"Hi","customer_id":"elsewhere"}),
    ] {
        assert_error(&draft_threads(&mut f, request), "authorization_denied");
    }

    // A human resolves too; threads survive discard and stay readable and open to replies.
    let resolved = draft_threads(&mut f, resolve);
    assert_ok(&resolved);
    assert_eq!(resolved["data"]["thread"]["resolved"], true);
    assert_eq!(
        resolved["data"]["thread"]["messages"]
            .as_array()
            .unwrap()
            .len(),
        4
    );
    assert_ok(&f.call(
        "kernel_update_draft_notes",
        json!({"app_id":APP,"customer_id":CUSTOMER,"change_set_id":draft,"notes":"Too high"}),
    ));
    assert_ok(&f.call(
        "kernel_discard_draft_change_set",
        json!({"app_id":APP,"customer_id":CUSTOMER,"change_set_id":draft}),
    ));
    let after_discard = draft_threads(&mut f, json!({"operation":"get","change_set_id":draft}));
    assert_eq!(after_discard["data"]["status"], "discarded");
    assert_eq!(after_discard["data"]["notes"], "Too high");
    assert_eq!(after_discard["data"]["threads"]["t1"]["resolved"], true);
    assert_ok(&draft_threads(
        &mut f,
        json!({"operation":"reply","change_set_id":draft,"thread_id":"t2","request_id":"late","message":"Noted"}),
    ));

    // A second draft from the same session survives approval.
    stage(&mut f, 9, "stage-2", "13");
    assert_ok(&f.work(json!({"operation":"thread_open","expected_revision":10,"request_id":"open-t4","thread_id":"t4","anchor":{}})));
    let saved = f.work(json!({"operation":"save","expected_revision":11,"request_id":"save-2"}));
    assert_ok(&saved);
    let second = saved["data"]["change_set"]["id"].as_i64().unwrap();
    assert_ok(&f.call(
        "kernel_approve_draft_change_set",
        json!({"app_id":APP,"customer_id":CUSTOMER,"change_set_id":second,"actor_id":"human"}),
    ));
    let approved = draft_threads(&mut f, json!({"operation":"get","change_set_id":second}));
    assert_eq!(approved["data"]["status"], "mainline");
    for id in ["t1", "t2", "t4"] {
        assert!(approved["data"]["threads"].get(id).is_some(), "{id}");
    }

    // The author finds every draft the session saved, newest first, with threads.
    let session = f.session_id.clone();
    let by_session = draft_threads(
        &mut f,
        json!({"operation":"by_session","session_id":session}),
    );
    assert_ok(&by_session);
    let drafts = by_session["data"].as_array().unwrap();
    assert_eq!(drafts.len(), 2);
    assert_eq!(drafts[0]["id"], second);
    assert_eq!(drafts[1]["id"], draft);
    assert_eq!(drafts[1]["status"], "discarded");
    assert_eq!(
        drafts[1]["threads"]["t2"]["messages"][0]["message"],
        "Noted"
    );
}

#[test]
fn an_approved_save_keeps_its_open_threads_in_the_workspace() {
    let Some(mut f) = Fixture::without_policy() else {
        return;
    };
    assert_ok(&f.create());
    stage(&mut f, 1, "stage", "12");
    assert_ok(&f.work(json!({"operation":"thread_open","expected_revision":2,"request_id":"open","thread_id":"t","anchor":{}})));
    let saved = f.work(json!({"operation":"save","expected_revision":3,"request_id":"save"}));
    assert_ok(&saved);
    let id = saved["data"]["change_set"]["id"].as_i64().unwrap();
    let approve = json!({"app_id":APP,"customer_id":CUSTOMER,"change_set_id":id});
    // An agent context never approves, including the draft its person saved.
    f.client
        .batch_execute("set kernel.actor_kind='agent'")
        .unwrap();
    assert_error(
        &f.call("kernel_approve_draft_change_set", approve.clone()),
        "authorization_denied",
    );
    f.client.batch_execute("reset kernel.actor_kind").unwrap();
    // Save and approve: the approver publishes the draft Save just wrote.
    assert_ok(&f.call("kernel_approve_draft_change_set", approve));
    let read = draft_threads(&mut f, json!({"operation":"get","change_set_id":id}));
    assert_eq!(read["data"]["status"], json!("mainline"));
    assert!(read["data"]["threads"]["t"].is_object());
    // Another member reads and replies on the published change's discussion.
    f.actor("other");
    assert_ok(&draft_threads(
        &mut f,
        json!({"operation":"reply","change_set_id":id,"thread_id":"t","request_id":"r","message":"Seen"}),
    ));
    f.actor("human");
    let session = f.session_id.clone();
    let by_session = draft_threads(
        &mut f,
        json!({"operation":"by_session","session_id":session}),
    );
    assert_eq!(by_session["data"][0]["status"], json!("mainline"));
    assert_eq!(
        by_session["data"][0]["threads"]["t"]["messages"]
            .as_array()
            .map(Vec::len),
        Some(1)
    );
}

#[test]
fn draft_thread_replies_and_resolutions_notify_their_scope_once() {
    // An author's open Comments pane and approvers' open cards re-read on the
    // scope's channel; a replay changes nothing and notifies nothing.
    let Some(mut f) = Fixture::without_policy() else {
        return;
    };
    assert_ok(&f.create());
    stage(&mut f, 1, "stage", "12");
    assert_ok(&f.work(json!({"operation":"thread_open","expected_revision":2,"request_id":"open","thread_id":"t","anchor":{}})));
    let saved = f.work(json!({"operation":"save","expected_revision":3,"request_id":"save"}));
    let draft = saved["data"]["change_set"]["id"].as_i64().unwrap();
    let own: i32 = f
        .client
        .query_one("select pg_backend_pid()", &[])
        .unwrap()
        .get(0);
    f.client.batch_execute("listen kernel_canonical").unwrap();
    // Drain what the Save itself sent.
    let _ = f.client.notifications().iter().count().unwrap();
    f.actor("other");
    let reply = json!({"operation":"reply","change_set_id":draft,"thread_id":"t","request_id":"r1","message":"Market rate"});
    assert_ok(&draft_threads(&mut f, reply.clone()));
    assert_ok(&draft_threads(&mut f, reply));
    assert_ok(&draft_threads(
        &mut f,
        json!({"operation":"resolve","change_set_id":draft,"thread_id":"t","request_id":"done"}),
    ));
    let payloads: Vec<String> = f
        .client
        .notifications()
        .iter()
        .filter(|n| Ok(n.process_id() == own && n.channel() == "kernel_canonical"))
        .map(|n| Ok(n.payload().to_owned()))
        .collect()
        .unwrap();
    assert_eq!(payloads, vec![format!("{APP}:{CUSTOMER}"); 2]);
}

#[test]
fn only_work_session_save_writes_work_session_provenance() {
    // A member cannot apply a change set naming a colleague's session: it
    // would show in that owner's Comments pane with threads they never wrote.
    let Some(mut f) = Fixture::without_policy() else {
        return;
    };
    assert_ok(&f.create());
    let victim = f.session_id.clone();
    f.actor("other");
    for (mode, kind) in [
        ("draft", "work_session"),
        ("mainline", "work_session"),
        ("draft", " Work_Session "),
    ] {
        let forged = f.call(
            "kernel_apply_change_set",
            json!({"app_id":APP,"customer_id":CUSTOMER,"actor_id":"other","source_kind":kind,"source_ref":victim,"mode":mode,"writes":[{"model_id":"item","record_key":{"type":"record_id","value":RECORD},"effective_start":"2026-01-01","values":{"score":{"type":"number","value":"99"}}}]}),
        );
        assert_error(&forged, "reserved_source_kind");
    }
    let dry_run = f.call(
        "kernel_validate_change_set_dry_run",
        json!({"app_id":APP,"customer_id":CUSTOMER,"actor_id":"other","source_kind":"work_session","source_ref":victim,"mode":"draft","writes":[{"model_id":"item","record_key":{"type":"record_id","value":RECORD},"effective_start":"2026-01-01","values":{"score":{"type":"number","value":"99"}}}]}),
    );
    assert_error(&dry_run, "reserved_source_kind");
    f.client
        .batch_execute("reset session authorization")
        .unwrap();
    let forged_rows: i64 = f
        .client
        .query_one(
            "select count(*) from change_set where source_kind='work_session' and source_ref=$1",
            &[&victim],
        )
        .unwrap()
        .get(0);
    assert_eq!(forged_rows, 0);
    // The owner's list holds only what their own Save writes.
    f.actor("human");
    let listed = draft_threads(
        &mut f,
        json!({"operation":"by_session","session_id":victim.clone()}),
    );
    assert_eq!(listed["data"], json!([]), "{listed}");
    stage(&mut f, 1, "stage", "12");
    let saved = f.work(json!({"operation":"save","expected_revision":2,"request_id":"save"}));
    assert_ok(&saved);
    let listed = draft_threads(
        &mut f,
        json!({"operation":"by_session","session_id":victim}),
    );
    assert_eq!(listed["data"].as_array().unwrap().len(), 1, "{listed}");
}

#[test]
fn draft_thread_replies_require_and_replay_a_protected_request_when_bound() {
    let Some(mut f) = Fixture::without_policy() else {
        return;
    };
    assert_ok(&f.create());
    stage(&mut f, 1, "stage", "12");
    assert_ok(&f.work(json!({"operation":"thread_open","expected_revision":2,"request_id":"open","thread_id":"t","anchor":{}})));
    let saved = f.work(json!({"operation":"save","expected_revision":3,"request_id":"save"}));
    let draft = saved["data"]["change_set"]["id"].as_i64().unwrap();
    f.client
        .batch_execute("reset session authorization")
        .unwrap();
    let principal = f.principal.clone();
    assert_ok(&f.call("kernel_bind_principal_scope", json!({"principal_name":principal,"capability":"runtime","app_id":APP,"customer_id":CUSTOMER,"actor_binding_required":true})));
    assert_ok(&f.call("kernel_bind_actor_membership", json!({"principal_name":principal,"app_id":APP,"customer_id":CUSTOMER,"actor_id":"human","role":"editor","actor_kind":"human","fence_generation":1})));
    f.actor("human");
    f.client
        .batch_execute("set kernel.actor_role='editor'; set kernel.actor_fence_generation='1'")
        .unwrap();
    let reply = json!({"app_id":APP,"customer_id":CUSTOMER,"operation":"reply","change_set_id":draft,"thread_id":"t","request_id":"r1","message":"Signed"});
    let unsigned = f.call("kernel_draft_threads", reply.clone());
    assert_error(&unsigned, "authorization_denied");
    assert_eq!(
        unsigned["error"]["details"][0]["code"], "http_request_required",
        "{unsigned}"
    );
    // Reads need no protected request.
    assert_ok(&f.call(
        "kernel_draft_threads",
        json!({"app_id":APP,"customer_id":CUSTOMER,"operation":"get","change_set_id":draft}),
    ));
    let now: i64 = f
        .client
        .query_one(
            "select floor(extract(epoch from clock_timestamp()))::bigint",
            &[],
        )
        .unwrap()
        .get(0);
    let descriptor = json!({"jti":"draft-thread-request","issuer":"https://gateway.fixture","audience":APP,"method":"POST","target":"/action","bodySha256":"A".repeat(43),"payloadSha256":"A".repeat(43),"expiresAt":now+240});
    assert_ok(&f.call("kernel_admit_http_operation", json!({"app_id":APP,"customer_id":CUSTOMER,"actor_id":"human","role":"editor","fence_generation":1,"http_request":descriptor,"operation":"kernel_draft_threads","sequence":1,"payload":reply})));
    f.client
        .execute("select set_config('kernel.http_jti',$1,false),set_config('kernel.http_descriptor',$2,false),set_config('kernel.http_sequence','1',false)", &[&"draft-thread-request", &descriptor.to_string()])
        .unwrap();
    let signed = f.call("kernel_draft_threads", reply.clone());
    assert_ok(&signed);
    assert_eq!(signed["data"]["message"]["message"], "Signed");
    // The consumed request replays from its durable receipt without a second reply.
    assert_eq!(f.call("kernel_draft_threads", reply.clone()), signed);
    let read = f.call(
        "kernel_draft_threads",
        json!({"app_id":APP,"customer_id":CUSTOMER,"operation":"get","change_set_id":draft}),
    );
    assert_eq!(
        read["data"]["threads"]["t"]["messages"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    // Another payload under the consumed request is refused.
    let mut changed = reply;
    changed["request_id"] = json!("r2");
    assert_error(
        &f.call("kernel_draft_threads", changed),
        "authorization_denied",
    );
}

#[test]
fn as_of_changes_keep_manual_entries_and_rule_outputs_follow_the_new_date() {
    let Some(mut f) = Fixture::without_policy() else {
        return;
    };
    f.make_other_record_visible();
    assert_ok(&f.create());
    stage(&mut f, 1, "human12", "12");
    // custom_score = score + score, over the session's overlay.
    let rule = json!({"model_id":"item","field_id":"custom_score",
        "value":{"type":"add","left":{"type":"field","field":"score"},"right":{"type":"field","field":"score"}}});
    assert_ok(&f.work(json!({"operation":"rule_create","expected_revision":2,"request_id":"rule","rule_id":"double","rule":rule})));
    let outputs = |f: &mut Fixture| -> Vec<(String, String, String)> {
        let read = f.work(json!({"operation":"get"}));
        assert_ok(&read);
        read["data"]["overlay"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| {
                (
                    e["record_id"].as_str().unwrap().to_string(),
                    e["field_id"].as_str().unwrap().to_string(),
                    e["value"]["value"].as_str().unwrap().to_string(),
                )
            })
            .collect()
    };
    assert!(outputs(&mut f).contains(&(
        OTHER_RECORD.to_string(),
        "custom_score".into(),
        "1800".into()
    )));
    // A later canonical version of both records.
    let moved = f.call("kernel_apply_change_set",json!({"app_id":APP,"customer_id":CUSTOMER,"actor_id":"human","source_kind":"fixture","mode":"mainline","writes":[
        {"model_id":"item","record_key":{"type":"record_id","value":RECORD},"effective_start":"2026-02-01","values":{"score":{"type":"number","value":"30"}}},
        {"model_id":"item","record_key":{"type":"record_id","value":OTHER_RECORD},"effective_start":"2026-02-01","values":{"score":{"type":"number","value":"950"}}}]}));
    assert_ok(&moved);
    // The agent moves the session's as-of; the human edit stays and reads as
    // stale, the rule re-ran at the new date.
    f.actor("agent");
    assert_ok(&f.work(json!({"operation":"update","patch":{"as_of":"2026-02-01"}})));
    f.actor("human");
    let read = f.work(json!({"operation":"get"}));
    assert_eq!(read["data"]["as_of"], "2026-02-01");
    let entries = outputs(&mut f);
    assert!(
        entries.contains(&(RECORD.to_string(), "score".into(), "12".into())),
        "{entries:?}"
    );
    assert!(
        entries.contains(&(
            OTHER_RECORD.to_string(),
            "custom_score".into(),
            "1900".into()
        )),
        "{entries:?}"
    );
    let human = overlay(&read)
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["record_id"] == RECORD && e["field_id"] == "score")
        .cloned()
        .unwrap();
    assert_eq!(human["stale"], true);
    assert_eq!(human["current_value"]["value"], "30");
    assert_eq!(human["author_kind"], "human");
    let save = json!({"operation":"save","expected_revision":4,"request_id":"save"});
    assert_error(&f.work(save.clone()), "stale_base");
    let confirmed: Vec<Value> = overlay(&read)
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["stale"] == true)
        .map(|e| json!({"model_id":"item","record_id":e["record_id"],"field_id":e["field_id"],"current_version":e["current_version"]}))
        .collect();
    let mut save = save;
    save["confirmed_stale"] = json!(confirmed);
    let saved = f.work(save);
    assert_ok(&saved);
    // The Save takes effect on the session's as-of at that moment.
    f.client
        .batch_execute("reset session authorization")
        .unwrap();
    let starts: Vec<String> = f
        .client
        .query(
            "select distinct effective_start::text from item_version where change_set_id=$1",
            &[&saved["data"]["change_set"]["id"].as_i64().unwrap()],
        )
        .unwrap()
        .iter()
        .map(|row| row.get(0))
        .collect();
    assert_eq!(starts, vec!["2026-02-01".to_string()]);
}

#[test]
fn save_always_drafts_and_carries_rule_notes() {
    let Some(mut f) = Fixture::without_policy() else {
        return;
    };
    assert_ok(&f.create());
    // An agent's staged value carries its rule note to the saved change set.
    f.actor("agent");
    assert_error(
        &f.work(json!({"operation":"stage","changes":[change("12")],"note":"x".repeat(201)})),
        "contract_validation_failed",
    );
    assert_ok(&f.work(
        json!({"operation":"stage","changes":[change("12")],"note":"Raise to the band floor"}),
    ));
    f.actor("human");
    // Save names no mode: a request's own mode is ignored, and Save drafts.
    let saved = f.work(
        json!({"operation":"save","expected_revision":2,"request_id":"save","mode":"mainline"}),
    );
    assert_ok(&saved);
    f.client
        .batch_execute("reset session authorization")
        .unwrap();
    let row = f
        .client
        .query_one(
            "select status, entry_notes from change_set where id=$1",
            &[&saved["data"]["change_set"]["id"].as_i64().unwrap()],
        )
        .unwrap();
    assert_eq!(row.get::<_, String>(0), "draft");
    assert_eq!(
        row.get::<_, Value>(1),
        json!({format!("item:{RECORD}:score"): "Raise to the band floor"})
    );
    assert!(saved["data"].get("mode").is_none(), "{saved}");
}

#[test]
fn discarding_an_agents_changes_restores_the_human_values_it_replaced() {
    let Some(mut f) = Fixture::new() else { return };
    assert_ok(&f.create());
    stage(&mut f, 1, "human12", "12");
    f.client.batch_execute("set kernel.actor_kind='agent'; set kernel.turn_id='00000000-0000-4000-8000-0000000000a1'").unwrap();
    stage(&mut f, 2, "agent14", "14");
    // The agent discards its turn: the human's 12 comes back as the human's.
    let reverted = f
        .work(json!({"operation":"discard_turn","turn_id":"00000000-0000-4000-8000-0000000000a1"}));
    assert_ok(&reverted);
    assert_eq!(reverted["data"]["removed"], json!([]));
    // The restored entry is touched: the answer carries it as it now stands.
    assert_eq!(overlay(&reverted)[0]["value"]["value"], "12");
    assert_eq!(overlay(&reverted)[0]["author_kind"], "human");
    f.client
        .batch_execute("reset kernel.actor_kind; reset kernel.turn_id")
        .unwrap();
    let entry = overlay(&f.work(json!({"operation":"get"})))[0].clone();
    assert_eq!(entry["value"]["value"], "12");
    assert_eq!(entry["author_kind"], "human");
    assert_eq!(entry["author_principal"], f.principal);
    assert!(entry.get("replaced").is_none());
    // A human discarding the agent's changes restores the same way.
    f.actor("agent");
    stage(&mut f, 4, "agent16", "16");
    f.actor("human");
    let discarded = f.work(json!({"operation":"discard_source","source":"agent"}));
    assert_ok(&discarded);
    assert_eq!(overlay(&discarded)[0]["value"]["value"], "12");
    assert_eq!(overlay(&discarded)[0]["author_kind"], "human");
    let entry = overlay(&f.work(json!({"operation":"get"})))[0].clone();
    assert_eq!(entry["value"]["value"], "12");
    assert_eq!(entry["author_kind"], "human");
}

#[test]
fn save_writes_an_agent_value_equal_to_the_old_baseline_after_an_as_of_change() {
    let Some(mut f) = Fixture::without_policy() else {
        return;
    };
    assert_ok(&f.create());
    // The human stages 12 over the saved 10 (as of Jan 1).
    stage(&mut f, 1, "human12", "12");
    // Canonical moves to 30 on Feb 1, and the session moves there.
    let moved = f.call("kernel_apply_change_set",json!({"app_id":APP,"customer_id":CUSTOMER,"actor_id":"human","source_kind":"fixture","mode":"mainline","writes":[
        {"model_id":"item","record_key":{"type":"record_id","value":RECORD},"effective_start":"2026-02-01","values":{"score":{"type":"number","value":"30"}}}]}));
    assert_ok(&moved);
    assert_ok(&f.work(json!({"operation":"update","patch":{"as_of":"2026-02-01"}})));
    // The agent stages 10: equal to the entry's baseline, but a real change from 30.
    f.actor("agent");
    let staged = stage(&mut f, 3, "agent10", "10");
    assert_eq!(overlay(&staged)[0]["value"]["value"], "10");
    f.actor("human");
    let read = f.work(json!({"operation":"get"}));
    let entry = overlay(&read)[0].clone();
    let saved = f.work(json!({"operation":"save","expected_revision":4,"request_id":"save",
        "confirmed_stale":[{"model_id":"item","record_id":RECORD,"field_id":"score","current_version":entry["current_version"]}]}));
    assert_ok(&saved);
    assert!(saved["data"]["change_set"].is_object(), "{saved}");
    f.approve_saved(&saved);
    let after = f.query(json!({"as_of":"2026-02-01"}));
    let row = after["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["$id"] == RECORD || r["id"] == RECORD)
        .cloned()
        .unwrap_or(after["data"][0].clone());
    assert_eq!(row["values"]["score"]["value"], "10", "{after}");
}

/// Hides RECORD from the fixture's human (and its agent), as a revoked grant would.
fn hide_record(f: &mut Fixture) {
    f.client
        .batch_execute(&format!(
            "reset session authorization; update item_version set owner='other' where record_id='{RECORD}'"
        ))
        .unwrap();
}

#[test]
fn fresh_discard_and_unstage_answers_carry_only_readable_entries() {
    let Some(mut f) = Fixture::new() else { return };
    f.make_other_record_visible();
    assert_ok(&f.create());
    let other = |n: &str| json!({"model_id":"item","record_id":OTHER_RECORD,"field_id":"score","value":{"type":"number","value":n}});
    assert_ok(&f.work(json!({"operation":"stage","changes":[change("12"),other("20")]})));
    f.actor("agent");
    assert_ok(&f.work(json!({"operation":"stage","changes":[change("14"),other("24")]})));
    // RECORD becomes unreadable; discarding the agent's changes restores both
    // human values.
    hide_record(&mut f);
    f.actor("agent");
    let discarded = f.work(json!({"operation":"discard_source","source":"agent"}));
    assert_ok(&discarded);
    let entries = overlay(&discarded);
    assert_eq!(entries.as_array().unwrap().len(), 1, "{discarded}");
    assert_eq!(entries[0]["record_id"], OTHER_RECORD);
    assert_eq!(entries[0]["value"]["value"], "20");
    assert!(!discarded.to_string().contains(RECORD), "{discarded}");
    // The agent may not remove the hidden human edit; a human removes it and
    // no entry is answered.
    let refused = f.work(
        json!({"operation":"unstage","model_id":"item","record_id":RECORD,"field_id":"score"}),
    );
    assert_error(&refused, "authorization_denied");
    assert!(!refused.to_string().contains(RECORD), "{refused}");
    f.actor("human");
    let cleared = f.work(
        json!({"operation":"unstage","model_id":"item","record_id":RECORD,"field_id":"score"}),
    );
    assert_ok(&cleared);
    assert_eq!(cleared["data"]["entries"], json!([]), "{cleared}");
    assert!(!cleared["data"]["entries"].to_string().contains(RECORD));
}

#[test]
fn an_agents_unstage_answers_a_restored_persons_entry_only_where_readable() {
    let Some(mut f) = Fixture::new() else { return };
    assert_ok(&f.create());
    assert_ok(&f.work(json!({"operation":"stage","changes":[change("12")]})));
    let unstage =
        json!({"operation":"unstage","model_id":"item","record_id":RECORD,"field_id":"score"});
    // Readable: the person's restored entry is answered.
    f.actor("agent");
    assert_ok(&f.work(json!({"operation":"stage","changes":[change("14")]})));
    let restored = f.work(unstage.clone());
    assert_ok(&restored);
    assert_eq!(overlay(&restored)[0]["value"]["value"], "12");
    assert_eq!(overlay(&restored)[0]["author_kind"], "human");
    // Unreadable: the entry is restored in storage but not answered, nor
    // reported removed, and neither its value nor its baseline is revealed.
    assert_ok(&f.work(json!({"operation":"stage","changes":[change("14")]})));
    hide_record(&mut f);
    f.actor("agent");
    let hidden = f.work(unstage);
    assert_ok(&hidden);
    assert_eq!(hidden["data"]["entries"], json!([]), "{hidden}");
    assert_eq!(hidden["data"]["removed"], json!([]), "{hidden}");
    let text = hidden.to_string();
    assert!(
        !text.contains("\"12\"") && !text.contains("\"10\""),
        "{hidden}"
    );
    f.client
        .batch_execute("reset session authorization")
        .unwrap();
    let stored = f
        .client
        .query_one(
            "select value->>'value', author_kind from work_session_record where record_id=$1::text::uuid and field_id='score'",
            &[&RECORD],
        )
        .unwrap();
    assert_eq!(stored.get::<_, String>(0), "12");
    assert_eq!(stored.get::<_, String>(1), "human");
}

#[test]
fn an_agent_clearing_another_agents_entry_removes_it() {
    let Some(mut f) = Fixture::new() else { return };
    assert_ok(&f.create());
    f.actor("agent");
    stage(&mut f, 1, "agent14", "14");
    f.actor("agent2");
    let cleared = f.work(
        json!({"operation":"unstage","model_id":"item","record_id":RECORD,"field_id":"score"}),
    );
    assert_ok(&cleared);
    assert_eq!(cleared["data"]["entries"], json!([]));
    f.actor("human");
    assert_eq!(overlay(&f.work(json!({"operation":"get"}))), json!([]));
}

#[test]
fn save_after_removing_an_edit_that_becomes_hidden_writes_the_readable_staged_one() {
    let Some(mut f) = Fixture::without_policy() else {
        return;
    };
    f.make_other_record_visible();
    assert_ok(&f.create());
    let other = json!({"model_id":"item","record_id":OTHER_RECORD,"field_id":"score","value":{"type":"number","value":"20"}});
    assert_ok(&f.work(json!({"operation":"stage","changes":[change("12"),other]})));
    assert_ok(&f.work(
        json!({"operation":"unstage","model_id":"item","record_id":RECORD,"field_id":"score"}),
    ));
    hide_record(&mut f);
    f.actor("human");
    let saved = f.work(json!({"operation":"save","expected_revision":3,"request_id":"save"}));
    assert_ok(&saved);
    let id = saved["data"]["change_set"]["id"]
        .as_i64()
        .expect("a change set");
    f.client
        .batch_execute("reset session authorization")
        .unwrap();
    let records: Vec<String> = f
        .client
        .query(
            "select record_id::text from item_version where change_set_id=$1",
            &[&id],
        )
        .unwrap()
        .iter()
        .map(|row| row.get(0))
        .collect();
    assert_eq!(records, vec![OTHER_RECORD.to_string()]);
}

#[test]
fn an_all_cleared_save_with_a_hidden_target_is_refused_without_reading_it() {
    let Some(mut f) = Fixture::without_policy() else {
        return;
    };
    assert_ok(&f.create());
    stage(&mut f, 1, "human12", "12");
    assert_ok(&f.work(
        json!({"operation":"unstage","model_id":"item","record_id":RECORD,"field_id":"score"}),
    ));
    hide_record(&mut f);
    f.actor("human");
    // Placeholders alone are nothing to Save, hidden or not; nothing is read.
    let saved = f.work(json!({"operation":"save","expected_revision":3,"request_id":"save"}));
    assert_error(&saved, "contract_validation_failed");
}
