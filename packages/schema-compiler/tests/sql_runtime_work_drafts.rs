// Reads with `include_pending_drafts`: every pending draft's field changes
// overlay mainline, in save order, under the session's staged entries.
#[path = "support/work_sessions.rs"]
mod support;
use serde_json::{json, Value};
use support::*;

/// One write of `item` values (and custom values) in `mode`, as `human`.
fn apply(f: &mut Fixture, mode: &str, record: &str, start: &str, values: Value) -> i64 {
    let mut write = json!({"model_id":"item","record_key":{"type":"record_id","value":record},
        "effective_start":start,"values":{}});
    for (field, value) in values.as_object().unwrap() {
        if field == "custom_score" {
            write["custom_fields"] =
                json!([{"field_id":"custom_score","type":"number","value":value}]);
        } else {
            write["values"][field] = json!({"type":"number","value":value});
        }
    }
    let applied = f.call(
        "kernel_apply_change_set",
        json!({"app_id":APP,"customer_id":CUSTOMER,"actor_id":"human","source_kind":"fixture",
            "mode":mode,"writes":[write]}),
    );
    assert_ok(&applied);
    applied["data"]["id"].as_i64().unwrap()
}

fn read(f: &mut Fixture, patch: Value) -> Value {
    let mut request = json!({"app_id":APP,"customer_id":CUSTOMER,"schema_version":VERSION,
        "model_id":"item","as_of":"2026-01-01","select":["$id","score","secret","custom_score"]});
    request
        .as_object_mut()
        .unwrap()
        .extend(patch.as_object().unwrap().clone());
    let answer = f.call("kernel_data_query", request);
    assert_ok(&answer);
    answer["data"].clone()
}

/// `{record_id: {field: value}}` of a list read.
fn values(rows: &Value) -> Value {
    let mut out = serde_json::Map::new();
    for row in rows.as_array().unwrap() {
        let mut fields = serde_json::Map::new();
        for (field, value) in row["values"].as_object().into_iter().flatten() {
            fields.insert(field.clone(), value["value"].clone());
        }
        for entry in row["custom_fields"].as_array().into_iter().flatten() {
            fields.insert(
                entry["field_id"].as_str().unwrap().to_owned(),
                entry["value"].clone(),
            );
        }
        out.insert(
            row["record_id"].as_str().unwrap().to_owned(),
            Value::Object(fields),
        );
    }
    Value::Object(out)
}

fn sum(f: &mut Fixture, field: &str, patch: Value) -> Value {
    let mut request = json!({"app_id":APP,"customer_id":CUSTOMER,"schema_version":VERSION,
        "model_id":"item","as_of":"2026-01-01","kind":"aggregate",
        "metrics":[{"fn":"count"},{"fn":"sum","field":field}]});
    request
        .as_object_mut()
        .unwrap()
        .extend(patch.as_object().unwrap().clone());
    let answer = f.call("kernel_data_query", request);
    assert_ok(&answer);
    answer["data"]["total"]["metrics"].clone()
}

fn lifecycle(f: &mut Fixture, function: &str, id: i64) {
    assert_ok(&f.call(
        function,
        json!({"app_id":APP,"customer_id":CUSTOMER,"actor_id":"human","change_set_id":id}),
    ));
}

const DRAFTS: &str = "include_pending_drafts";

#[test]
fn pending_drafts_overlay_mainline_field_by_field_in_save_order_under_staged_entries() {
    let Some(mut f) = Fixture::without_policy() else {
        return;
    };
    let off = read(&mut f, json!({}));
    // No pending drafts: the flag changes nothing, in lists and aggregates.
    assert_eq!(read(&mut f, json!({DRAFTS:true})), off);
    assert_eq!(read(&mut f, json!({DRAFTS:false})), off);
    assert_eq!(
        sum(&mut f, "score", json!({DRAFTS:true})),
        sum(&mut f, "score", json!({}))
    );
    let invalid = f.call(
        "kernel_data_query",
        json!({"app_id":APP,"customer_id":CUSTOMER,"schema_version":VERSION,"model_id":"item",
            "as_of":"2026-01-01",DRAFTS:"yes"}),
    );
    assert_error(&invalid, "contract_validation_failed");

    // Mainline: RECORD score 10, secret 123, custom 7; OTHER score 900.
    let older = apply(&mut f, "draft", RECORD, "2026-01-01", json!({"score":"11"}));
    let other_fields = apply(
        &mut f,
        "draft",
        RECORD,
        "2026-01-01",
        json!({"secret":"124","custom_score":"8"}),
    );
    let newer = apply(&mut f, "draft", RECORD, "2026-01-01", json!({"score":"12"}));
    let rejected = apply(
        &mut f,
        "draft",
        RECORD,
        "2026-01-01",
        json!({"score":"99","secret":"999"}),
    );
    lifecycle(&mut f, "kernel_discard_draft_change_set", rejected);
    let later = apply(
        &mut f,
        "draft",
        OTHER_RECORD,
        "2026-03-01",
        json!({"score":"901"}),
    );

    // Off: today's read exactly.
    assert_eq!(read(&mut f, json!({})), off);
    let on = values(&read(&mut f, json!({DRAFTS:true})));
    // The newest draft wins score; another draft's different fields still
    // show; the discarded draft does not; a later-dated draft does not yet.
    assert_eq!(
        on[RECORD],
        json!({"score":"12","secret":"124","custom_score":"8"})
    );
    assert_eq!(on[OTHER_RECORD]["score"], "900");
    // Lists, gets, aggregates and filters agree.
    let full = read(
        &mut f,
        json!({DRAFTS:true,"where":[{"field":"$id","op":"eq","value":RECORD}]}),
    );
    let full = values(&full);
    assert_eq!(full[RECORD]["score"], "12");
    let unselected = f.call(
        "kernel_data_query",
        json!({"app_id":APP,"customer_id":CUSTOMER,"schema_version":VERSION,"model_id":"item",
            "as_of":"2026-01-01",DRAFTS:true,"where":[{"field":"$id","op":"eq","value":RECORD}]}),
    );
    assert_ok(&unselected);
    assert_eq!(values(&unselected["data"])[RECORD]["secret"], "124");
    assert_eq!(
        sum(&mut f, "score", json!({DRAFTS:true})),
        json!(["2", "912"])
    );
    assert_eq!(sum(&mut f, "score", json!({})), json!(["2", "910"]));
    let filtered = read(
        &mut f,
        json!({DRAFTS:true,"where":[{"field":"score","op":"eq","value":"12"}]}),
    );
    assert_eq!(filtered.as_array().unwrap().len(), 1);
    // At the later draft's date it shows too.
    let march = values(&read(&mut f, json!({DRAFTS:true,"as_of":"2026-03-01"})));
    assert_eq!(march[OTHER_RECORD]["score"], "901");
    assert_eq!(march[RECORD]["score"], "12");

    // Staged entries overlay drafts; untouched fields keep the draft value.
    assert_ok(&f.create());
    let staged = f.work(json!({"operation":"stage","changes":[{"model_id":"item","record_id":RECORD,"field_id":"score","value":{"type":"number","value":"15"}}]}));
    assert_ok(&staged);
    let work = f.work_ref();
    let session = values(&read(&mut f, json!({DRAFTS:true,"work":work.clone()})));
    assert_eq!(
        session[RECORD],
        json!({"score":"15","secret":"124","custom_score":"8"})
    );
    let session_off = values(&read(&mut f, json!({"work":work.clone()})));
    assert_eq!(
        session_off[RECORD],
        json!({"score":"15","secret":"123","custom_score":"7"})
    );
    assert_eq!(
        sum(&mut f, "secret", json!({DRAFTS:true,"work":work})),
        json!(["2", "580"])
    );

    // A rejected draft drops out: the older draft's score shows again.
    lifecycle(&mut f, "kernel_discard_draft_change_set", newer);
    assert_eq!(
        values(&read(&mut f, json!({DRAFTS:true})))[RECORD]["score"],
        "11"
    );
    lifecycle(&mut f, "kernel_discard_draft_change_set", older);
    assert_eq!(
        values(&read(&mut f, json!({DRAFTS:true})))[RECORD],
        json!({"score":"10","secret":"124","custom_score":"8"})
    );

    // Approval moves a draft to mainline once: the same values, never twice.
    let before = sum(&mut f, "score", json!({DRAFTS:true,"as_of":"2026-03-01"}));
    assert_eq!(before, json!(["2", "911"]));
    lifecycle(&mut f, "kernel_approve_draft_change_set", later);
    lifecycle(&mut f, "kernel_approve_draft_change_set", other_fields);
    assert_eq!(
        sum(&mut f, "score", json!({DRAFTS:true,"as_of":"2026-03-01"})),
        before
    );
    assert_eq!(sum(&mut f, "score", json!({"as_of":"2026-03-01"})), before);
    assert_eq!(read(&mut f, json!({DRAFTS:true})), read(&mut f, json!({})));

    // A draft shows only where it would be visible once approved: not over
    // a later-dated mainline version.
    let january = apply(&mut f, "draft", RECORD, "2026-01-15", json!({"score":"77"}));
    apply(
        &mut f,
        "mainline",
        RECORD,
        "2026-02-01",
        json!({"score":"50"}),
    );
    assert_eq!(
        values(&read(&mut f, json!({DRAFTS:true,"as_of":"2026-01-20"})))[RECORD]["score"],
        "77"
    );
    assert_eq!(
        values(&read(&mut f, json!({DRAFTS:true,"as_of":"2026-02-15"})))[RECORD]["score"],
        "50"
    );
    // Its unchanged fields never override mainline: only its changed score.
    apply(
        &mut f,
        "mainline",
        RECORD,
        "2026-01-01",
        json!({"secret":"200"}),
    );
    assert_eq!(
        values(&read(&mut f, json!({DRAFTS:true,"as_of":"2026-01-20"})))[RECORD],
        json!({"score":"77","secret":"200","custom_score":"8"})
    );
    let _ = january;
}

#[test]
fn pending_drafts_keep_record_and_field_grants_and_feed_derived_values() {
    let Some(mut f) = Fixture::with_derived() else {
        return;
    };
    // Drafts are refused under a declared policy; rows stored as drafts
    // still pass the reader's grants on both images.
    let draft = |f: &mut Fixture, order: i64, record: &str, owner: &str, score: i64| {
        f.client
            .batch_execute("reset session authorization")
            .unwrap();
        let id: i64 = f.client.query_one(
            "insert into change_set(app_id,customer_id,schema_revision_id,created_with_mode,status,source_kind,created_order) values($1,$2,1,'draft','draft','fixture',$3) returning id",
            &[&APP, &CUSTOMER, &order],
        ).unwrap().get(0);
        f.client.execute(
            "insert into item_version(id,record_id,app_id,customer_id,stage,effective_start,change_set_id,owner,score,secret,rate_amount,rate_currency,rate_period,parent,custom_fields)
             select gen_random_uuid(),record_id,app_id,customer_id,'draft',effective_start,$2,$3,$4::text::numeric,secret,rate_amount,rate_currency,rate_period,parent,custom_fields
             from item_version where record_id=$1::text::uuid and stage='mainline'",
            &[&record, &id, &owner, &score.to_string()],
        ).unwrap();
        // A draft overlays the fields it wrote: here owner and score.
        f.client.execute(
            "update change_set set written_fields=jsonb_build_object('item',jsonb_build_object($1::text,
               (select jsonb_object_agg(to_char(effective_start,'YYYY-MM-DD'),'[\"owner\",\"score\"]'::jsonb)
                from item_version where change_set_id=$2))) where id=$2",
            &[&record, &id],
        ).unwrap();
        f.actor("human");
        id
    };
    let query = |f: &mut Fixture, select: Value| {
        f.call(
            "kernel_data_query",
            json!({"app_id":APP,"customer_id":CUSTOMER,"schema_version":VERSION,"model_id":"item",
                "as_of":"2026-01-01",DRAFTS:true,"select":select}),
        )
    };
    let baseline = query(&mut f, json!(["$id", "score"]));
    assert_ok(&baseline);
    // A draft giving the reader someone else's record does not show it.
    draft(&mut f, 2, OTHER_RECORD, "human", 901);
    let shown = query(&mut f, json!(["$id", "score"]));
    assert_eq!(shown, baseline);
    // A draft moving the reader's record away hides it, in counts too.
    let away = draft(&mut f, 3, RECORD, "other", 10);
    assert_eq!(query(&mut f, json!(["$id", "score"]))["data"], json!([]));
    let count = f.call(
        "kernel_data_query",
        json!({"app_id":APP,"customer_id":CUSTOMER,"schema_version":VERSION,"model_id":"item",
            "as_of":"2026-01-01",DRAFTS:true,"kind":"aggregate","metrics":[{"fn":"count"}]}),
    );
    assert_eq!(count["data"]["total"]["metrics"], json!(["0"]));
    f.client
        .batch_execute("reset session authorization")
        .unwrap();
    f.client
        .execute(
            "update item_version set stage='discarded' where change_set_id=$1",
            &[&away],
        )
        .unwrap();
    f.client
        .execute(
            "update change_set set status='discarded' where id=$1",
            &[&away],
        )
        .unwrap();
    f.actor("human");
    // A visible draft value reaches derived values and relation lookups.
    draft(&mut f, 4, RECORD, "human", 11);
    let derived = query(&mut f, json!(["score", "double_score", "parent_score"]));
    assert_ok(&derived);
    assert_eq!(derived["data"][0]["values"]["score"]["value"], "11");
    let custom = derived["data"][0]["custom_fields"].as_array().unwrap();
    let value = |id: &str| {
        custom
            .iter()
            .find(|entry| entry["field_id"] == id)
            .map(|entry| entry["value"].clone())
    };
    assert_eq!(value("double_score"), Some(json!("22")));
    assert_eq!(value("parent_score"), Some(json!("11")));
    // Field grants are unchanged: an unreadable field stays unreadable.
    assert_error(&query(&mut f, json!(["secret"])), "authorization_denied");
}

#[test]
fn a_draft_writing_several_dates_shows_its_cumulative_changes_at_each() {
    let Some(mut f) = Fixture::without_policy() else {
        return;
    };
    // One draft: January changes score 10→11; February changes only secret.
    let write = |start: &str, field: &str, value: &str| {
        json!({"model_id":"item","record_key":{"type":"record_id","value":RECORD},
            "effective_start":start,"values":{field:{"type":"number","value":value}}})
    };
    let draft = f.call(
        "kernel_apply_change_set",
        json!({"app_id":APP,"customer_id":CUSTOMER,"actor_id":"human","source_kind":"fixture",
            "mode":"draft","writes":[write("2026-01-01","score","11"),write("2026-02-01","secret","124")]}),
    );
    assert_ok(&draft);
    let january = values(&read(&mut f, json!({DRAFTS:true})));
    assert_eq!(
        january[RECORD],
        json!({"score":"11","secret":"123","custom_score":"7"})
    );
    // February shows the January score too, as approving would publish it.
    let february = values(&read(&mut f, json!({DRAFTS:true,"as_of":"2026-02-15"})));
    assert_eq!(
        february[RECORD],
        json!({"score":"11","secret":"124","custom_score":"7"})
    );
    lifecycle(
        &mut f,
        "kernel_approve_draft_change_set",
        draft["data"]["id"].as_i64().unwrap(),
    );
    assert_eq!(
        values(&read(&mut f, json!({"as_of":"2026-02-15"})))[RECORD],
        february[RECORD]
    );
}

#[test]
fn a_draft_overlays_only_the_fields_it_wrote_whatever_mainline_does_after() {
    let Some(mut f) = Fixture::without_policy() else {
        return;
    };
    // Mainline secret 123→200; a draft saved over it changes only score;
    // then the secret change is reverted.
    let secret = apply(
        &mut f,
        "mainline",
        RECORD,
        "2026-01-01",
        json!({"secret":"200"}),
    );
    apply(&mut f, "draft", RECORD, "2026-01-01", json!({"score":"11"}));
    assert_eq!(
        values(&read(&mut f, json!({DRAFTS:true})))[RECORD],
        json!({"score":"11","secret":"200","custom_score":"7"})
    );
    assert_ok(&f.call(
        "kernel_revert_change_set",
        json!({"app_id":APP,"customer_id":CUSTOMER,"actor_id":"human","change_set_id":secret,
            "idempotency_key":"revert-secret"}),
    ));
    // The draft never wrote secret: the reverted mainline value stays out.
    assert_eq!(
        values(&read(&mut f, json!({DRAFTS:true})))[RECORD],
        json!({"score":"11","secret":"123","custom_score":"7"})
    );
    // Nor does mainline moving after a draft that wrote only custom_score.
    let restored = apply(
        &mut f,
        "mainline",
        RECORD,
        "2026-01-01",
        json!({"secret":"300"}),
    );
    assert_ok(&f.call(
        "kernel_revert_change_set",
        json!({"app_id":APP,"customer_id":CUSTOMER,"actor_id":"human","change_set_id":restored,
            "idempotency_key":"revert-restored"}),
    ));
    apply(
        &mut f,
        "draft",
        RECORD,
        "2026-01-01",
        json!({"custom_score":"9"}),
    );
    apply(
        &mut f,
        "mainline",
        RECORD,
        "2026-01-01",
        json!({"secret":"400"}),
    );
    assert_eq!(
        values(&read(&mut f, json!({DRAFTS:true})))[RECORD],
        json!({"score":"11","secret":"400","custom_score":"9"})
    );
}

#[test]
fn staging_the_mainline_value_over_a_pending_drafts_change_keeps_the_entry() {
    let Some(mut f) = Fixture::without_policy() else {
        return;
    };
    // Mainline score 10 (RECORD) and 900 (OTHER_RECORD); a pending draft
    // has RECORD's score at 11 and changes nothing of OTHER_RECORD.
    apply(&mut f, "draft", RECORD, "2026-01-01", json!({"score":"11"}));
    apply(
        &mut f,
        "draft",
        RECORD,
        "2026-01-01",
        json!({"custom_score":"8"}),
    );
    assert_ok(&f.create());
    let entries = |state: &Value| {
        let data = &state["data"];
        data.get("overlay").unwrap_or(&data["entries"]).clone()
    };
    let stage = |f: &mut Fixture, _revision: i64, record: &str, value: &str| {
        let staged = f.work(json!({"operation":"stage","changes":[{"model_id":"item","record_id":record,"field_id":"score",
                "value":{"type":"number","value":value}}]}));
        assert_ok(&staged);
        staged
    };
    // Without a pending draft on the field, the mainline value is a no-op.
    let noop = stage(&mut f, 1, OTHER_RECORD, "900");
    assert_eq!(entries(&noop), json!([]));
    // Over the draft's change the entry is kept, and Show drafts shows it.
    let kept = entries(&stage(&mut f, 2, RECORD, "10"));
    assert_eq!(kept.as_array().unwrap().len(), 1, "{kept}");
    assert_eq!(kept[0]["value"]["value"], "10");
    let custom = f.work(
        json!({"operation":"stage","changes":[{"model_id":"item","record_id":RECORD,"field_id":"custom_score",
            "value":{"type":"number","value":"7"}}]}),
    );
    assert_ok(&custom);
    let kept = entries(&custom);
    assert_eq!(kept.as_array().unwrap().len(), 1, "{kept}");
    assert_eq!(kept[0]["field_id"], "custom_score");
    let work = f.work_ref();
    let shown = values(&read(&mut f, json!({DRAFTS:true,"work":work})));
    assert_eq!(
        shown[RECORD],
        json!({"score":"10","secret":"123","custom_score":"7"})
    );
    assert_eq!(
        values(&read(&mut f, json!({DRAFTS:true})))[RECORD],
        json!({"score":"11","secret":"123","custom_score":"8"})
    );
    // Save writes the kept entry into its draft.
    let saved = f.work(json!({"operation":"save","expected_revision":4,"request_id":"save"}));
    assert_ok(&saved);
    let id = saved["data"]["change_set"]["id"]
        .as_i64()
        .expect("Save wrote a draft");
    f.client
        .batch_execute("reset session authorization")
        .unwrap();
    let score: String = f
        .client
        .query_one(
            "select score::text from item_version where change_set_id=$1 and record_id=$2::text::uuid",
            &[&id, &RECORD],
        )
        .unwrap()
        .get(0);
    assert_eq!(score.parse::<f64>().unwrap(), 10.0);
}

#[test]
fn a_saved_draft_setting_a_field_back_to_mainline_shows_over_an_older_draft() {
    let Some(mut f) = Fixture::without_policy() else {
        return;
    };
    // Mainline score 10; a pending draft has 11.
    apply(&mut f, "draft", RECORD, "2026-01-01", json!({"score":"11"}));
    assert_eq!(
        values(&read(&mut f, json!({DRAFTS:true})))[RECORD]["score"],
        "11"
    );
    // A session sets it back to 10: kept over the draft, then saved.
    assert_ok(&f.create());
    let staged = f.work(json!({"operation":"stage","changes":[{"model_id":"item","record_id":RECORD,"field_id":"score",
        "value":{"type":"number","value":"10"}}]}));
    assert_ok(&staged);
    let saved = f.work(json!({"operation":"save","expected_revision":2,"request_id":"save"}));
    assert_ok(&saved);
    let id = saved["data"]["change_set"]["id"]
        .as_i64()
        .expect("Save wrote a draft");
    // The later draft wrote score, so its mainline value shows with drafts.
    assert_eq!(
        values(&read(&mut f, json!({DRAFTS:true})))[RECORD],
        json!({"score":"10","secret":"123","custom_score":"7"})
    );
    // Staging the mainline value again is kept: a pending draft wrote it.
    let again = f.work(json!({"operation":"stage","changes":[{"model_id":"item","record_id":RECORD,"field_id":"score",
        "value":{"type":"number","value":"10"}}]}));
    assert_ok(&again);
    let data = &again["data"];
    let entries = data.get("overlay").unwrap_or(&data["entries"]);
    assert_eq!(entries.as_array().unwrap().len(), 1, "{entries}");
    // Discarding it brings the older draft's value back.
    lifecycle(&mut f, "kernel_discard_draft_change_set", id);
    assert_eq!(
        values(&read(&mut f, json!({DRAFTS:true})))[RECORD]["score"],
        "11"
    );
}

/// The record ids of a list read, in order.
fn ids(rows: &Value) -> Vec<String> {
    rows.as_array()
        .unwrap()
        .iter()
        .map(|row| row["record_id"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn pending_draft_values_are_searched_and_ordered() {
    let Some(mut f) = Fixture::without_policy() else {
        return;
    };
    // Mainline: RECORD score 10, OTHER score 900; a draft moves RECORD's
    // score above OTHER's and renames its owner.
    let renamed = f.call(
        "kernel_apply_change_set",
        json!({"app_id":APP,"customer_id":CUSTOMER,"actor_id":"human","source_kind":"fixture","mode":"draft",
            "writes":[{"model_id":"item","record_key":{"type":"record_id","value":RECORD},"effective_start":"2026-01-01",
            "values":{"owner":{"type":"text","value":"zeta-team"},"score":{"type":"number","value":"1000"}}}]}),
    );
    assert_ok(&renamed);
    let search = json!({"search":{"query":"zeta","fields":["owner"]}});
    assert!(ids(&read(&mut f, search.clone())).is_empty());
    let mut on = search;
    on[DRAFTS] = json!(true);
    assert_eq!(ids(&read(&mut f, on)), vec![RECORD.to_owned()]);
    let order = json!({"order_by":[{"field":"score","direction":"desc"}]});
    assert_eq!(
        ids(&read(&mut f, order.clone())),
        vec![OTHER_RECORD.to_owned(), RECORD.to_owned()]
    );
    let mut on = order;
    on[DRAFTS] = json!(true);
    assert_eq!(
        ids(&read(&mut f, on)),
        vec![RECORD.to_owned(), OTHER_RECORD.to_owned()]
    );
}

/// Scans of `item_version` (sequential, and through any of its indexes) in
/// the current transaction.
fn version_scans(f: &mut Fixture) -> i64 {
    f.client
        .query_one(
            "select (pg_stat_get_xact_numscans('item_version'::regclass)
               + coalesce((select sum(pg_stat_get_xact_numscans(indexrelid)) from pg_index
                  where indrelid='item_version'::regclass),0))::bigint",
            &[],
        )
        .unwrap()
        .get(0)
}

/// How many more scans of `item_version` a read with pending drafts makes
/// than the same read without.
fn draft_scans(f: &mut Fixture) -> i64 {
    f.client.batch_execute("begin").unwrap();
    let start = version_scans(f);
    read(f, json!({}));
    let off = version_scans(f) - start;
    read(f, json!({DRAFTS:true}));
    let on = version_scans(f) - start - off;
    f.client.batch_execute("commit").unwrap();
    on - off
}

#[test]
fn reads_skip_pending_drafts_when_none_wrote_the_model() {
    let Some(mut f) = Fixture::without_policy() else {
        return;
    };
    // No pending draft: the read with pending drafts is the mainline read.
    assert_eq!(draft_scans(&mut f), 0);
    // A discarded draft is not pending either.
    let discarded = apply(&mut f, "draft", RECORD, "2026-01-01", json!({"score":"11"}));
    lifecycle(&mut f, "kernel_discard_draft_change_set", discarded);
    assert_eq!(draft_scans(&mut f), 0);
    // A pending draft of the model makes the read look for draft versions.
    apply(&mut f, "draft", RECORD, "2026-01-01", json!({"score":"12"}));
    assert!(draft_scans(&mut f) > 0);
}
