// Reads with `include_pending_drafts`: records pending drafts create show and
// records they delete drop out, as if approved (latest save wins), and each
// row says what came from a pending draft (`pending_draft`).
#[path = "support/work_sessions.rs"]
mod support;
use serde_json::{json, Value};
use support::*;

const DRAFTS: &str = "include_pending_drafts";
const NEW_RECORD: &str = "00000000-0000-0000-0000-0000000000a1";

/// One draft (or mainline) change set of `writes`, as `human`; its id.
fn apply(f: &mut Fixture, mode: &str, writes: Value) -> i64 {
    let applied = f.call(
        "kernel_apply_change_set",
        json!({"app_id":APP,"customer_id":CUSTOMER,"actor_id":"human","source_kind":"fixture",
            "mode":mode,"writes":writes}),
    );
    assert_ok(&applied);
    applied["data"]["id"].as_i64().unwrap()
}

fn create(owner: &str, score: &str) -> Value {
    json!([{"model_id":"item","new_record_id":NEW_RECORD,"effective_start":"2026-01-01",
        "values":{"owner":{"type":"text","value":owner},"score":{"type":"number","value":score}}}])
}

fn score(record: &str, value: &str) -> Value {
    json!([{"model_id":"item","record_key":{"type":"record_id","value":record},
        "effective_start":"2026-01-01","values":{"score":{"type":"number","value":value}}}])
}

fn delete(record: &str) -> Value {
    json!([{"model_id":"item","record_key":{"type":"record_id","value":record},
        "effective_start":"2026-01-01","tombstones_record":true}])
}

fn list(f: &mut Fixture, patch: Value) -> Value {
    let mut request = json!({"app_id":APP,"customer_id":CUSTOMER,"schema_version":VERSION,
        "model_id":"item","as_of":"2026-01-01"});
    request
        .as_object_mut()
        .unwrap()
        .extend(patch.as_object().unwrap().clone());
    let answer = f.call("kernel_data_query", request);
    assert_ok(&answer);
    answer["data"].clone()
}

/// `{record_id: row}` of a list read.
fn rows(data: &Value) -> serde_json::Map<String, Value> {
    data.as_array()
        .unwrap()
        .iter()
        .map(|row| (row["record_id"].as_str().unwrap().to_owned(), row.clone()))
        .collect()
}

/// `[count, sum(score)]` of the read's records.
fn totals(f: &mut Fixture, patch: Value) -> Value {
    let mut request =
        json!({"kind":"aggregate","metrics":[{"fn":"count"},{"fn":"sum","field":"score"}]});
    request
        .as_object_mut()
        .unwrap()
        .extend(patch.as_object().unwrap().clone());
    list(f, request)["total"]["metrics"].clone()
}

fn lifecycle(f: &mut Fixture, function: &str, id: i64) {
    assert_ok(&f.call(
        function,
        json!({"app_id":APP,"customer_id":CUSTOMER,"actor_id":"human","change_set_id":id}),
    ));
}

#[test]
fn a_record_a_pending_draft_creates_shows_everywhere_as_if_approved() {
    let Some(mut f) = Fixture::without_policy() else {
        return;
    };
    let off = list(&mut f, json!({}));
    let created = apply(&mut f, "draft", create("newcomer", "50"));
    // Off: the mainline read exactly.
    assert_eq!(list(&mut f, json!({})), off);
    assert_eq!(totals(&mut f, json!({})), json!(["2", "910"]));
    // On: listed with its draft values and the draft that creates it.
    let on = rows(&list(&mut f, json!({DRAFTS:true})));
    assert_eq!(on.len(), 3);
    let row = &on[NEW_RECORD];
    assert_eq!(row["values"]["score"]["value"], "50");
    assert_eq!(row["values"]["owner"]["value"], "newcomer");
    assert_eq!(
        row["pending_draft"],
        json!({"created":created,"fields":{"owner":created,"score":created}})
    );
    // Counts, sums, filters, ordering, paging and a get by id all see it.
    assert_eq!(totals(&mut f, json!({DRAFTS:true})), json!(["3", "960"]));
    let filtered = list(
        &mut f,
        json!({DRAFTS:true,"where":[{"field":"score","op":"lt","value":"100"}]}),
    );
    assert_eq!(rows(&filtered).len(), 2);
    let ordered = list(
        &mut f,
        json!({DRAFTS:true,"order_by":[{"field":"score","direction":"desc"}],"limit":2}),
    );
    let ids: Vec<&str> = ordered
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["record_id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec![OTHER_RECORD, NEW_RECORD]);
    let get = list(
        &mut f,
        json!({DRAFTS:true,"where":[{"field":"$id","op":"eq","value":NEW_RECORD}],"select":["$id","owner"]}),
    );
    assert_eq!(get[0]["values"]["owner"]["value"], "newcomer");
    // A select keeps only the selected fields' provenance.
    assert_eq!(
        get[0]["pending_draft"],
        json!({"created":created,"fields":{"owner":created}})
    );
    let grouped = list(
        &mut f,
        json!({DRAFTS:true,"kind":"aggregate","group_by":["owner"],"metrics":[{"fn":"count"}]}),
    );
    assert!(grouped["groups"]
        .as_array()
        .unwrap()
        .iter()
        .any(|group| group["key"] == json!(["newcomer"])));
    // Not before the draft's date.
    let earlier = list(&mut f, json!({DRAFTS:true,"as_of":"2025-12-31"}));
    assert!(!rows(&earlier).contains_key(NEW_RECORD));

    // Approved, the creation is mainline: the same record and values, with
    // nothing pending.
    lifecycle(&mut f, "kernel_approve_draft_change_set", created);
    let approved = rows(&list(&mut f, json!({DRAFTS:true})));
    assert_eq!(approved[NEW_RECORD]["values"], row["values"]);
    assert!(approved[NEW_RECORD].get("pending_draft").is_none());
    let mainline = rows(&list(&mut f, json!({})));
    assert_eq!(mainline[NEW_RECORD]["values"], row["values"]);
    assert!(mainline[NEW_RECORD].get("pending_draft").is_none());
}

#[test]
fn a_record_a_pending_draft_deletes_drops_out_as_if_approved() {
    let Some(mut f) = Fixture::without_policy() else {
        return;
    };
    let off = list(&mut f, json!({}));
    // A draft that only deletes is still found by the read.
    let deleted = apply(&mut f, "draft", delete(OTHER_RECORD));
    assert_eq!(list(&mut f, json!({})), off);
    let on = rows(&list(&mut f, json!({DRAFTS:true})));
    assert_eq!(on.keys().collect::<Vec<_>>(), vec![RECORD]);
    assert_eq!(totals(&mut f, json!({DRAFTS:true})), json!(["1", "10"]));
    assert_eq!(totals(&mut f, json!({})), json!(["2", "910"]));
    let get = list(
        &mut f,
        json!({DRAFTS:true,"where":[{"field":"$id","op":"eq","value":OTHER_RECORD}]}),
    );
    assert_eq!(get, json!([]));
    // Once approved, mainline agrees; discarded, it never happened.
    let discard = apply(&mut f, "draft", delete(RECORD));
    assert_eq!(totals(&mut f, json!({DRAFTS:true})), json!(["0", null]));
    lifecycle(&mut f, "kernel_discard_draft_change_set", discard);
    assert_eq!(totals(&mut f, json!({DRAFTS:true})), json!(["1", "10"]));
    lifecycle(&mut f, "kernel_approve_draft_change_set", deleted);
    assert_eq!(list(&mut f, json!({DRAFTS:true})), list(&mut f, json!({})));
    assert_eq!(totals(&mut f, json!({})), json!(["1", "10"]));
}

#[test]
fn creations_deletions_and_changes_of_one_record_apply_in_save_order() {
    let Some(mut f) = Fixture::without_policy() else {
        return;
    };
    // A later draft deleting a record an earlier one changed hides it.
    let changed = apply(&mut f, "draft", score(RECORD, "11"));
    let deleted = apply(&mut f, "draft", delete(RECORD));
    assert!(!rows(&list(&mut f, json!({DRAFTS:true}))).contains_key(RECORD));
    // A later draft changing a record an earlier one deleted shows it, with
    // the later change.
    let rescored = apply(&mut f, "draft", score(RECORD, "12"));
    let on = rows(&list(&mut f, json!({DRAFTS:true})));
    assert_eq!(on[RECORD]["values"]["score"]["value"], "12");
    assert_eq!(
        on[RECORD]["pending_draft"],
        json!({"fields":{"score":rescored}})
    );
    lifecycle(&mut f, "kernel_discard_draft_change_set", rescored);
    lifecycle(&mut f, "kernel_discard_draft_change_set", deleted);
    assert_eq!(
        rows(&list(&mut f, json!({DRAFTS:true})))[RECORD]["pending_draft"],
        json!({"fields":{"score":changed}})
    );

    // A creation then a later deletion of it: not shown.
    let created = apply(&mut f, "draft", create("newcomer", "50"));
    assert!(rows(&list(&mut f, json!({DRAFTS:true}))).contains_key(NEW_RECORD));
    let removed = apply(&mut f, "draft", delete(NEW_RECORD));
    assert!(!rows(&list(&mut f, json!({DRAFTS:true}))).contains_key(NEW_RECORD));
    assert_eq!(totals(&mut f, json!({DRAFTS:true})), json!(["2", "911"]));
    // Discarding the deletion brings the creation back.
    lifecycle(&mut f, "kernel_discard_draft_change_set", removed);
    let on = rows(&list(&mut f, json!({DRAFTS:true})));
    assert_eq!(on[NEW_RECORD]["pending_draft"]["created"], json!(created));
}

#[test]
fn provenance_names_each_drafts_fields_and_yields_to_staged_values() {
    let Some(mut f) = Fixture::without_policy() else {
        return;
    };
    let older = apply(&mut f, "draft", score(RECORD, "11"));
    let secret = apply(
        &mut f,
        "draft",
        json!([{"model_id":"item","record_key":{"type":"record_id","value":RECORD},
            "effective_start":"2026-01-01","values":{"secret":{"type":"number","value":"124"}},
            "custom_fields":[{"field_id":"custom_score","type":"number","value":"8"}]}]),
    );
    let newer = apply(&mut f, "draft", score(RECORD, "12"));
    let on = rows(&list(&mut f, json!({DRAFTS:true})));
    // The draft whose value shows, per field; mainline values have none.
    assert_eq!(
        on[RECORD]["pending_draft"],
        json!({"fields":{"score":newer,"secret":secret,"custom_score":secret}})
    );
    assert!(on[OTHER_RECORD].get("pending_draft").is_none());
    let _ = older;
    // A staged value replaces the draft's: that field no longer names it.
    assert_ok(&f.create());
    assert_ok(&f.work(json!({"operation":"stage","changes":[{"model_id":"item","record_id":RECORD,"field_id":"score",
        "value":{"type":"number","value":"15"}}]})));
    let work = f.work_ref();
    let staged = rows(&list(&mut f, json!({DRAFTS:true,"work":work.clone()})));
    assert_eq!(staged[RECORD]["values"]["score"]["value"], "15");
    assert_eq!(
        staged[RECORD]["pending_draft"],
        json!({"fields":{"secret":secret,"custom_score":secret}})
    );
    // Off, with the session: no provenance at all.
    let off = rows(&list(&mut f, json!({"work":work})));
    assert!(off.values().all(|row| row.get("pending_draft").is_none()));
}

#[test]
fn reads_without_pending_drafts_are_unchanged_and_carry_no_provenance() {
    let Some(mut f) = Fixture::without_policy() else {
        return;
    };
    let off = list(&mut f, json!({}));
    // No pending draft: on is exactly off, in lists and aggregates.
    assert_eq!(list(&mut f, json!({DRAFTS:true})), off);
    assert_eq!(
        totals(&mut f, json!({DRAFTS:true})),
        totals(&mut f, json!({}))
    );
    // Pending drafts of every kind: off still reads mainline exactly.
    apply(&mut f, "draft", create("newcomer", "50"));
    apply(&mut f, "draft", delete(OTHER_RECORD));
    apply(&mut f, "draft", score(RECORD, "11"));
    assert_eq!(list(&mut f, json!({})), off);
    assert_eq!(list(&mut f, json!({DRAFTS:false})), off);
    assert!(off
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row.get("pending_draft").is_none()));
}

#[test]
fn a_record_a_pending_draft_creates_resolves_through_relation_lookups() {
    let Some(mut f) = Fixture::with_derived() else {
        return;
    };
    // Drafts are refused under a declared policy, so this one is stored as
    // Save would store it: it creates NEW_RECORD (score 40) and links
    // RECORD's parent to it.
    f.client
        .batch_execute("reset session authorization")
        .unwrap();
    let id: i64 = f.client.query_one(
        "insert into change_set(app_id,customer_id,schema_revision_id,created_with_mode,status,source_kind,created_order) values($1,$2,1,'draft','draft','fixture',2) returning id",
        &[&APP, &CUSTOMER],
    ).unwrap().get(0);
    f.client
        .execute(
            "insert into item_record(id,app_id,customer_id,external_key) values($1::text::uuid,$2,$3,'new')",
            &[&NEW_RECORD, &APP, &CUSTOMER],
        )
        .unwrap();
    f.client.execute(
        "insert into item_version(id,record_id,app_id,customer_id,stage,effective_start,change_set_id,owner,score,custom_fields)
         values(gen_random_uuid(),$1::text::uuid,$2,$3,'draft','2026-01-01',$4,'human',40,'[]')",
        &[&NEW_RECORD, &APP, &CUSTOMER, &id],
    ).unwrap();
    f.client.execute(
        "insert into item_version(id,record_id,app_id,customer_id,stage,effective_start,change_set_id,owner,score,secret,rate_amount,rate_currency,rate_period,parent,custom_fields)
         select gen_random_uuid(),record_id,app_id,customer_id,'draft',effective_start,$2,owner,score,secret,rate_amount,rate_currency,rate_period,$3::text::uuid,custom_fields
         from item_version where record_id=$1::text::uuid and stage='mainline'",
        &[&RECORD, &id, &NEW_RECORD],
    ).unwrap();
    f.client.execute(
        "update change_set set written_fields=jsonb_build_object('item',jsonb_build_object(
           $1::text,'{\"2026-01-01\":[\"owner\",\"score\"]}'::jsonb,$2::text,'{\"2026-01-01\":[\"parent\"]}'::jsonb)) where id=$3",
        &[&NEW_RECORD, &RECORD, &id],
    ).unwrap();
    f.actor("human");
    let read = |f: &mut Fixture, drafts: bool| {
        let answer = f.call(
            "kernel_data_query",
            json!({"app_id":APP,"customer_id":CUSTOMER,"schema_version":VERSION,"model_id":"item",
                "as_of":"2026-01-01",DRAFTS:drafts,"where":[{"field":"$id","op":"eq","value":RECORD}],
                "select":["$id","parent","parent_score"]}),
        );
        assert_ok(&answer);
        answer["data"][0].clone()
    };
    // The related read (with the same flag) finds the created record.
    let on = read(&mut f, true);
    assert_eq!(on["values"]["parent"]["value"]["value"], NEW_RECORD);
    let parent_score = on["custom_fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["field_id"] == "parent_score")
        .map(|entry| entry["value"].clone());
    assert_eq!(parent_score, Some(json!("40")));
    assert_eq!(on["pending_draft"], json!({"fields":{"parent":id}}));
    // A get of the created record by id (how a link is named) returns it.
    let named = f.call(
        "kernel_data_query",
        json!({"app_id":APP,"customer_id":CUSTOMER,"schema_version":VERSION,"model_id":"item",
            "as_of":"2026-01-01",DRAFTS:true,"where":[{"field":"$id","op":"eq","value":NEW_RECORD}],
            "select":["$id","owner"]}),
    );
    assert_eq!(named["data"][0]["values"]["owner"]["value"], "human");
    assert_eq!(named["data"][0]["pending_draft"]["created"], json!(id));
    // Off: mainline's own parent, and no provenance.
    let off = read(&mut f, false);
    assert_eq!(off["values"]["parent"]["value"]["value"], RECORD);
    assert!(off.get("pending_draft").is_none());
}

/// Stores a pending draft as Save would, by hand (drafts are refused under a
/// policy): versions of `records` (record, owner, score, effective start) in
/// `customer`, each writing `fields`. A record without a mainline row gets
/// one in `item_record`. Returns the draft's change set id.
fn seed_draft(
    f: &mut Fixture,
    customer: &str,
    order: i64,
    records: &[(&str, &str, i64, &str)],
    fields: &[&str],
) -> i64 {
    f.client
        .batch_execute("reset session authorization")
        .unwrap();
    // Another customer has its own copy of the schema revision.
    f.client.execute(
        "insert into schema_revision(app_id,customer_id,version,base_schema,customer_overlay,schema,activated_at)
         select app_id,$2,version,base_schema,customer_overlay,schema,activated_at from schema_revision
         where app_id=$1 and customer_id=$3
           and not exists (select 1 from schema_revision where app_id=$1 and customer_id=$2)",
        &[&APP, &customer, &CUSTOMER],
    ).unwrap();
    let revision: i64 = f
        .client
        .query_one(
            "select id from schema_revision where app_id=$1 and customer_id=$2",
            &[&APP, &customer],
        )
        .unwrap()
        .get(0);
    let id: i64 = f.client.query_one(
        "insert into change_set(app_id,customer_id,schema_revision_id,created_with_mode,status,source_kind,created_order) values($1,$2,$4,'draft','draft','fixture',$3) returning id",
        &[&APP, &customer, &order, &revision],
    ).unwrap().get(0);
    let mut written = serde_json::Map::new();
    for (record, owner, score, start) in records {
        f.client
            .execute(
                "insert into item_record(id,app_id,customer_id,external_key) values($1::text::uuid,$2,$3,$1) on conflict do nothing",
                &[record, &APP, &customer],
            )
            .unwrap();
        f.client.execute(
            "insert into item_version(id,record_id,app_id,customer_id,stage,effective_start,change_set_id,owner,score,custom_fields)
             values(gen_random_uuid(),$1::text::uuid,$2,$3,'draft',$4::text::date,$5,$6,$7::text::numeric,'[]')",
            &[record, &APP, &customer, start, &id, owner, &score.to_string()],
        ).unwrap();
        written.insert((*record).to_owned(), json!({ *start: fields }));
    }
    f.client
        .execute(
            "update change_set set written_fields=jsonb_build_object('item',$1::jsonb) where id=$2",
            &[&Value::Object(written), &id],
        )
        .unwrap();
    f.actor("human");
    id
}

#[test]
fn a_row_naming_no_draft_carries_no_pending_draft() {
    let Some(mut f) = Fixture::without_policy() else {
        return;
    };
    // A draft writes only RECORD's score.
    let draft = apply(&mut f, "draft", score(RECORD, "11"));
    // A select without score: the row names no draft.
    let selected = list(
        &mut f,
        json!({DRAFTS:true,"select":["$id","owner"],"where":[{"field":"score","op":"lt","value":"100"}]}),
    );
    assert_eq!(selected.as_array().unwrap().len(), 1);
    assert!(selected[0].get("pending_draft").is_none(), "{selected}");
    let with_score = list(&mut f, json!({DRAFTS:true,"select":["$id","score"]}));
    assert_eq!(
        rows(&with_score)[RECORD]["pending_draft"],
        json!({"fields":{"score":draft}})
    );
    // The session stages score: the draft's only field no longer shows.
    assert_ok(&f.create());
    assert_ok(&f.work(json!({"operation":"stage","changes":[{"model_id":"item","record_id":RECORD,"field_id":"score",
        "value":{"type":"number","value":"15"}}]})));
    let work = f.work_ref();
    let staged = rows(&list(&mut f, json!({DRAFTS:true,"work":work.clone()})));
    assert_eq!(staged[RECORD]["values"]["score"]["value"], "15");
    assert!(
        staged[RECORD].get("pending_draft").is_none(),
        "{}",
        staged[RECORD]
    );
    let staged_select = list(
        &mut f,
        json!({DRAFTS:true,"work":work,"select":["$id","score"]}),
    );
    assert!(staged_select
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row.get("pending_draft").is_none()));
}

const OWN_NEW: &str = "00000000-0000-0000-0000-0000000000b1";
const THEIR_NEW: &str = "00000000-0000-0000-0000-0000000000b2";
const ELSEWHERE_NEW: &str = "00000000-0000-0000-0000-0000000000b3";

#[test]
fn a_record_a_pending_draft_creates_passes_record_grants_and_stays_in_its_tenant() {
    let Some(mut f) = Fixture::new() else {
        return;
    };
    // Reads every record the actor owns (owner = actor).
    let created = seed_draft(
        &mut f,
        CUSTOMER,
        2,
        &[
            (OWN_NEW, "human", 40, "2026-01-01"),
            (THEIR_NEW, "other", 50, "2026-01-01"),
        ],
        &["owner", "score"],
    );
    // Another customer's draft creation, whoever owns it.
    seed_draft(
        &mut f,
        "elsewhere",
        3,
        &[(ELSEWHERE_NEW, "human", 60, "2026-01-01")],
        &["owner", "score"],
    );
    let select = json!(["$id", "owner", "score"]);
    let read = |f: &mut Fixture, patch: Value| {
        let mut request = json!({DRAFTS:true,"select":select.clone()});
        request
            .as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        rows(&list(f, request))
    };
    let count = |f: &mut Fixture| {
        list(
            f,
            json!({DRAFTS:true,"kind":"aggregate","metrics":[{"fn":"count"}]}),
        )["total"]["metrics"][0]
            .clone()
    };
    let get = |f: &mut Fixture, id: &str| {
        list(
            f,
            json!({DRAFTS:true,"select":select.clone(),"where":[{"field":"$id","op":"eq","value":id}]}),
        )
    };
    // The owner sees their creation, with its provenance; nobody else's.
    let human = read(&mut f, json!({}));
    assert!(human.contains_key(OWN_NEW));
    assert!(!human.contains_key(THEIR_NEW));
    assert!(!human.contains_key(ELSEWHERE_NEW));
    assert_eq!(
        human[OWN_NEW]["pending_draft"],
        json!({"created":created,"fields":{"owner":created,"score":created}})
    );
    assert_eq!(get(&mut f, THEIR_NEW), json!([]));
    assert_eq!(get(&mut f, ELSEWHERE_NEW), json!([]));
    // RECORD (owner human) and OWN_NEW.
    assert_eq!(count(&mut f), json!("2"));
    // Another actor sees only theirs.
    f.actor("other");
    let other = read(&mut f, json!({}));
    assert!(other.contains_key(THEIR_NEW));
    assert!(!other.contains_key(OWN_NEW));
    assert!(!other.contains_key(ELSEWHERE_NEW));
    assert_eq!(get(&mut f, OWN_NEW), json!([]));
    assert_eq!(other[THEIR_NEW]["pending_draft"]["created"], json!(created));
    // OTHER_RECORD (owner other) and THEIR_NEW.
    assert_eq!(count(&mut f), json!("2"));
    f.actor("human");
}

#[test]
fn a_draft_dated_before_a_records_first_mainline_version_creates_nothing() {
    let Some(mut f) = Fixture::without_policy() else {
        return;
    };
    // RECORD's first mainline version is 2026-01-01; a draft back-dates an
    // edit of its score to 2025-12-01.
    seed_draft(
        &mut f,
        CUSTOMER,
        2,
        &[(RECORD, "human", 5, "2025-12-01")],
        &["score"],
    );
    let december = rows(&list(&mut f, json!({DRAFTS:true,"as_of":"2025-12-15"})));
    assert!(!december.contains_key(RECORD), "{december:?}");
    assert_eq!(
        list(&mut f, json!({DRAFTS:true,"as_of":"2025-12-15"})),
        list(&mut f, json!({"as_of":"2025-12-15"}))
    );
    // From mainline's first version on, the older draft does not apply.
    let january = rows(&list(&mut f, json!({DRAFTS:true})));
    assert_eq!(january[RECORD]["values"]["score"]["value"], "10");
    assert!(january[RECORD].get("pending_draft").is_none());
}

#[test]
fn a_stale_draft_deletion_stops_applying_once_mainline_moves_past_it() {
    let Some(mut f) = Fixture::without_policy() else {
        return;
    };
    apply(&mut f, "draft", delete(OTHER_RECORD));
    // Mainline changes OTHER_RECORD later than the draft's date.
    apply(
        &mut f,
        "mainline",
        json!([{"model_id":"item","record_key":{"type":"record_id","value":OTHER_RECORD},
            "effective_start":"2026-02-01","values":{"score":{"type":"number","value":"901"}}}]),
    );
    // Before mainline's change the deletion still applies; after it, the
    // record shows with mainline's value.
    let january = rows(&list(&mut f, json!({DRAFTS:true,"as_of":"2026-01-15"})));
    assert!(!january.contains_key(OTHER_RECORD));
    let february = rows(&list(&mut f, json!({DRAFTS:true,"as_of":"2026-02-15"})));
    assert_eq!(february[OTHER_RECORD]["values"]["score"]["value"], "901");
    assert!(february[OTHER_RECORD].get("pending_draft").is_none());
}
