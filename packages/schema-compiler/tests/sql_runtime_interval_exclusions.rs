use kernel::connect_postgres;
use postgres::Client;
use schema_compiler::{
    compile_manifest_json, compile_sql_artifact_manifest, render_sql_artifact_bundle,
};
use serde_json::{json, Value};
use support::trusted_human;
use uuid::Uuid;

mod support;

const APP: &str = "interval_rules";
const RULE: &str = "assignment_one_active_per_subject";

fn fixture() -> Value {
    json!({
        "app_id":APP, "customer_id":"tenant_a", "version":"intervals-v1",
        "models":[
            {"id":"employee","kind":"entity","label":"Employee","fields":[
                {"id":"name","label":"Name","type":"text","required":true}
            ]},
            {"id":"position","kind":"entity","label":"Position","fields":[
                {"id":"name","label":"Name","type":"text","required":true}
            ]},
            {"id":"assignment","kind":"entity","label":"Org Assignment","fields":[
                {"id":"employee","label":"Filled by","type":"relation","target_model":"employee"},
                {"id":"position","label":"Seat","type":"relation","target_model":"position"},
                {"id":"start_date","label":"Assignment Start","type":"date","required":true},
                {"id":"end_date","label":"Assignment End","type":"date"},
                {"id":"desk","label":"Desk","type":"text"}
            ]}
        ],
        "constraints":[
            {"id":RULE,"model":"assignment","label":"One active assignment per subject","authority":"authoritative",
             "expression":{"type":"non_overlapping_intervals","start":"start_date","end":"end_date",
                           "subjects":[["employee"],["position"],["desk"]]},
             "message":"Private author message"}
        ]
    })
}

struct Harness {
    url: String,
    client: Client,
    name: String,
    schema: Value,
    revision: i64,
}

impl Harness {
    fn new() -> Option<Self> {
        let url = match std::env::var("KERNEL_TEST_DATABASE_URL") {
            Ok(url) => url,
            Err(std::env::VarError::NotPresent) => {
                // The dedicated schema:test-parity runner requires this URL
                // and rejects skipped targets; general Rust unit runs do not.
                eprintln!(
                    "skipping interval exclusion runtime: KERNEL_TEST_DATABASE_URL is absent"
                );
                return None;
            }
            Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
        };
        let mut client = connect_postgres(&url).unwrap();
        let name = format!("interval_rules_{}", Uuid::new_v4().simple());
        let url_for_harness = url.clone();
        client
            .batch_execute(&format!("create schema {name}; set search_path to {name}"))
            .unwrap();
        trusted_human::before_install(&mut client);
        let compiled = compile_manifest_json(&fixture().to_string()).unwrap();
        let schema = serde_json::to_value(&compiled.schema).unwrap();
        let bundle = render_sql_artifact_bundle(&compile_sql_artifact_manifest(&compiled).unwrap());
        client.batch_execute(&bundle).unwrap();
        let mut h = Self {
            url: url_for_harness,
            client,
            name,
            schema,
            revision: 0,
        };
        let prepared = h.call(
            "kernel_prepare_schema_revision",
            h.prepare_request("app_base"),
        );
        assert_eq!(prepared["ok"], true, "{prepared}");
        h.revision = prepared["data"]["schema_revision_id"].as_i64().unwrap();
        assert_eq!(h.ready(h.revision, "2")["ok"], true);
        let activated = h.call(
            "kernel_activate_app_base_schema_revision",
            json!({
                "app_id":APP,"release_id":"intervals-v1","base_artifact_hash":"2".repeat(64),
                "targets":[{"customer_id":"tenant_a","schema_revision_id":h.revision,"effective_artifact_hash":"2".repeat(64),"expected_active_effective_hash":null}]
            }),
        );
        assert_eq!(activated["ok"], true, "{activated}");
        trusted_human::bind(&mut h.client, APP, "tenant_a", "reviewer");
        Some(h)
    }

    fn prepare_request(&self, activation_kind: &str) -> Value {
        json!({
            "app_id":APP,"customer_id":"tenant_a","version":self.schema["version"],"release_id":"intervals-v1",
            "activation_kind":activation_kind,"schema_hash":"1".repeat(64),"base_artifact_hash":"2".repeat(64),
            "effective_artifact_hash":"2".repeat(64),"materialization_plan_hash":"3".repeat(64),
            "expected_active_effective_hash":null,"base_schema":self.schema,"schema":self.schema,
            "customer_overlay":{},"phase_plan":[]
        })
    }

    fn ready(&mut self, revision: i64, effective_hash: &str) -> Value {
        self.call(
            "kernel_validate_schema_revision_readiness",
            json!({
                "app_id":APP,"customer_id":"tenant_a","schema_revision_id":revision,
                "effective_artifact_hash":effective_hash.repeat(64),"materialization_plan_hash":"3".repeat(64),"phase_results":[]
            }),
        )
    }

    fn call(&mut self, operation: &str, input: Value) -> Value {
        self.client
            .query_one(&format!("select {operation}($1::jsonb)"), &[&input])
            .unwrap()
            .get(0)
    }

    fn request(&self, key: &str, mode: &str, writes: Value) -> Value {
        json!({
            "app_id":APP,"customer_id":"tenant_a","schema_revision_id":self.revision,
            "actor_id":"reviewer","source_kind":"test","idempotency_key":key,"mode":mode,"writes":writes
        })
    }

    fn apply(&mut self, key: &str, writes: Value) -> Value {
        let request = self.request(key, "mainline", writes);
        self.call("kernel_apply_change_set", request)
    }

    fn dry_run(&mut self, key: &str, writes: Value) -> Value {
        let request = self.request(key, "mainline", writes);
        self.call("kernel_validate_change_set_dry_run", request)
    }

    fn draft(&mut self, key: &str, writes: Value) -> Value {
        let request = self.request(key, "draft", writes);
        self.call("kernel_apply_change_set", request)
    }

    fn create(&mut self, model: &str, name: &str) -> String {
        let id = Uuid::new_v4().to_string();
        let applied = self.apply(
            &format!("create-{id}"),
            json!([{"model_id":model,"new_record_id":id,"effective_start":"2026-01-01",
                    "values":{"name":{"type":"text","value":name}}}]),
        );
        assert_eq!(applied["ok"], true, "{applied}");
        id
    }

    /// Live (current) assignment intervals as `(record_id, start, end)`.
    fn live_assignments(&mut self) -> Vec<(String, String, Option<String>)> {
        let mut rows = self
            .client
            .query(
                "select v.record_id::text, v.start_date::text, v.end_date::text from assignment_version v
                 where v.stage = 'mainline' and v.effective_end is null and not v.tombstones_record",
                &[],
            )
            .unwrap()
            .into_iter()
            .map(|row| (row.get(0), row.get(1), row.get(2)))
            .collect::<Vec<_>>();
        rows.sort();
        rows
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        support::drop_generated_sql_fixture(&mut self.client, &self.name);
    }
}

fn relation(id: &str) -> Value {
    json!({"type":"relation","value":{"type":"record_id","value":id}})
}

fn date(value: &str) -> Value {
    json!({"type":"date","value":value})
}

fn assignment(
    id: &str,
    employee: Option<&str>,
    position: Option<&str>,
    start: &str,
    end: Option<&str>,
) -> Value {
    let mut values = json!({"start_date":date(start)});
    if let Some(employee) = employee {
        values["employee"] = relation(employee);
    }
    if let Some(position) = position {
        values["position"] = relation(position);
    }
    if let Some(end) = end {
        values["end_date"] = date(end);
    }
    json!({"model_id":"assignment","new_record_id":id,"effective_start":start,"values":values})
}

fn update(id: &str, effective_start: &str, values: Value, clear: &[&str]) -> Value {
    json!({"model_id":"assignment","record_key":{"type":"record_id","value":id},
           "effective_start":effective_start,"values":values,"clear_fields":clear})
}

fn new_id() -> String {
    Uuid::new_v4().to_string()
}

fn assert_overlap(response: &Value, other_record: &str) {
    let error = &response["error"];
    assert_eq!(response["ok"], false, "{response}");
    assert_eq!(error["code"], "constraint_violation", "{response}");
    let message = error["message"].as_str().unwrap();
    for label in [
        "One active assignment per subject",
        "Org Assignment",
        "Assignment Start",
        "Assignment End",
    ] {
        assert!(
            message.contains(label),
            "{message} lacks schema label {label}"
        );
    }
    assert!(!message.contains("Private author message"), "{message}");
    assert!(!message.contains("start_date"), "{message} leaks field IDs");
    let details = error["details"].as_array().unwrap();
    assert_eq!(details[0]["path"], "interval", "{response}");
    assert_eq!(details[0]["message"], error["message"], "{response}");
    for (path, value) in [
        ("model", "assignment"),
        ("constraint", RULE),
        ("field", "start_date"),
        ("field", "end_date"),
        ("field", "employee"),
        ("field", "position"),
        ("record", other_record),
    ] {
        assert!(
            details
                .iter()
                .any(|detail| detail["path"] == path && detail["message"] == value),
            "{response} lacks {path}={value}"
        );
    }
}

#[test]
fn overlapping_create_is_rejected_and_adjacent_create_is_accepted() {
    let Some(mut h) = Harness::new() else {
        return;
    };
    let ada = h.create("employee", "Ada");
    let first_seat = h.create("position", "Engineer");
    let second_seat = h.create("position", "Manager");

    let first = new_id();
    let created = h.apply(
        "first",
        json!([assignment(
            &first,
            Some(&ada),
            Some(&first_seat),
            "2026-01-01",
            Some("2026-06-30")
        )]),
    );
    assert_eq!(created["ok"], true, "{created}");

    // End dates are inclusive: starting on the previous end date overlaps.
    let overlapping = json!([assignment(
        &new_id(),
        Some(&ada),
        Some(&second_seat),
        "2026-06-30",
        None
    )]);
    let dry_run = h.dry_run("overlap-dry-run", overlapping.clone());
    assert_overlap(&dry_run, &first);
    let rejected = h.apply("overlap", overlapping.clone());
    assert_overlap(&rejected, &first);
    assert!(rejected["error"]["message"]
        .as_str()
        .unwrap()
        .contains("with the same Filled by"));
    // Nothing was committed for the rejected key, so its replay re-validates.
    assert_overlap(&h.apply("overlap", overlapping), &first);

    // The day after the previous end date is adjacent, not overlapping.
    let adjacent = new_id();
    let accepted = h.apply(
        "adjacent",
        json!([assignment(
            &adjacent,
            Some(&ada),
            Some(&second_seat),
            "2026-07-01",
            None
        )]),
    );
    assert_eq!(accepted["ok"], true, "{accepted}");

    // A one-day interval (start == end) is valid and reserves only that day.
    let hedy = h.create("employee", "Hedy");
    let one_day = new_id();
    let single = h.apply(
        "one-day",
        json!([assignment(
            &one_day,
            Some(&hedy),
            None,
            "2026-05-05",
            Some("2026-05-05")
        )]),
    );
    assert_eq!(single["ok"], true, "{single}");
    let same_day = h.apply(
        "one-day-overlap",
        json!([assignment(&new_id(), Some(&hedy), None, "2026-05-05", None)]),
    );
    assert_overlap(&same_day, &one_day);
    let next_day = h.apply(
        "one-day-next",
        json!([assignment(&new_id(), Some(&hedy), None, "2026-05-06", None)]),
    );
    assert_eq!(next_day["ok"], true, "{next_day}");

    // A second subject field set is independent: the first seat is free again
    // from 2026-07-01, but the second seat is now occupied.
    let grace = h.create("employee", "Grace");
    let seat_overlap = h.apply(
        "seat-overlap",
        json!([assignment(
            &new_id(),
            Some(&grace),
            Some(&second_seat),
            "2026-09-01",
            None
        )]),
    );
    assert_overlap(&seat_overlap, &adjacent);
    assert!(seat_overlap["error"]["message"]
        .as_str()
        .unwrap()
        .contains("with the same Seat"));
    let free_seat = h.apply(
        "free-seat",
        json!([assignment(
            &new_id(),
            Some(&grace),
            Some(&first_seat),
            "2026-07-01",
            None
        )]),
    );
    assert_eq!(free_seat["ok"], true, "{free_seat}");

    // Rows without a subject value are never compared on that subject.
    let unfilled = h.apply(
        "unfilled",
        json!([
            assignment(&new_id(), None, None, "2026-01-01", None),
            assignment(&new_id(), None, None, "2026-01-01", None)
        ]),
    );
    assert_eq!(unfilled["ok"], true, "{unfilled}");

    // A tombstoned record is not live and no longer reserves its interval.
    let tombstoned = h.apply(
        "tombstone-adjacent",
        json!([{"model_id":"assignment","record_key":{"type":"record_id","value":adjacent},
                "effective_start":"2026-08-01","tombstones_record":true}]),
    );
    assert_eq!(tombstoned["ok"], true, "{tombstoned}");
    let reuse = h.apply(
        "reuse-after-tombstone",
        json!([assignment(
            &new_id(),
            Some(&ada),
            Some(&second_seat),
            "2026-08-01",
            None
        )]),
    );
    assert_eq!(reuse["ok"], true, "{reuse}");
}

#[test]
fn overlapping_update_is_rejected_and_accepted_receipts_replay() {
    let Some(mut h) = Harness::new() else {
        return;
    };
    let ada = h.create("employee", "Ada");
    let first_seat = h.create("position", "Engineer");
    let second_seat = h.create("position", "Manager");
    let first = new_id();
    let second = new_id();
    let created = h.apply(
        "pair",
        json!([
            assignment(
                &first,
                Some(&ada),
                Some(&first_seat),
                "2026-01-01",
                Some("2026-06-30")
            ),
            assignment(&second, Some(&ada), Some(&second_seat), "2026-07-01", None)
        ]),
    );
    assert_eq!(created["ok"], true, "{created}");
    let before = h.live_assignments();

    let extended = h.apply(
        "extend",
        json!([update(
            &first,
            "2026-03-01",
            json!({"end_date":date("2026-07-01")}),
            &[]
        )]),
    );
    assert_overlap(&extended, &second);
    let reopened = h.apply(
        "reopen",
        json!([update(&first, "2026-03-01", json!({}), &["end_date"])]),
    );
    assert_overlap(&reopened, &second);
    assert_eq!(
        h.live_assignments(),
        before,
        "rejected writes must not persist"
    );

    let shortened_request = json!([update(
        &first,
        "2026-03-01",
        json!({"end_date":date("2026-06-15")}),
        &[]
    )]);
    let shortened = h.apply("shorten", shortened_request.clone());
    assert_eq!(shortened["ok"], true, "{shortened}");

    // The same envelope may end one interval and start the next, in any order.
    let third = new_id();
    let swapped = h.apply(
        "swap",
        json!([
            assignment(&third, Some(&ada), Some(&first_seat), "2026-10-01", None),
            update(
                &second,
                "2026-09-01",
                json!({"end_date":date("2026-09-30")}),
                &[]
            )
        ]),
    );
    assert_eq!(swapped["ok"], true, "{swapped}");

    // Canonical idempotency returns the committed receipt before current-state
    // validation, so an exact replay stays successful after later writes.
    let replay = h.apply("shorten", shortened_request);
    assert_eq!(replay["ok"], true, "{replay}");
    assert_eq!(replay["data"]["id"], shortened["data"]["id"]);
}

#[test]
fn draft_approval_and_revert_cannot_create_overlaps() {
    let Some(mut h) = Harness::new() else {
        return;
    };
    let ada = h.create("employee", "Ada");
    let first_seat = h.create("position", "Engineer");
    let second_seat = h.create("position", "Manager");
    let third_seat = h.create("position", "Director");
    let first = new_id();
    assert_eq!(
        h.apply(
            "first",
            json!([assignment(
                &first,
                Some(&ada),
                Some(&first_seat),
                "2026-01-01",
                None
            )])
        )["ok"],
        true
    );
    let ended = h.apply(
        "end-first",
        json!([update(
            &first,
            "2026-02-01",
            json!({"end_date":date("2026-06-30")}),
            &[]
        )]),
    );
    assert_eq!(ended["ok"], true, "{ended}");
    let second = new_id();
    assert_eq!(
        h.apply(
            "second",
            json!([assignment(
                &second,
                Some(&ada),
                Some(&second_seat),
                "2026-07-01",
                None
            )])
        )["ok"],
        true
    );
    let before = h.live_assignments();

    // Reverting the end date would reopen the first interval over the second.
    let reverted = h.call(
        "kernel_revert_change_set",
        json!({"app_id":APP,"customer_id":"tenant_a","change_set_id":ended["data"]["id"],
               "actor_id":"reviewer","idempotency_key":"revert-end"}),
    );
    assert_overlap(&reverted, &second);
    assert_eq!(h.live_assignments(), before);

    // Drafts do not change mainline; approval validates the promoted state.
    let draft = h.draft(
        "draft-third",
        json!([assignment(
            &new_id(),
            Some(&ada),
            Some(&third_seat),
            "2026-08-01",
            None
        )]),
    );
    assert_eq!(draft["ok"], true, "{draft}");
    let approved = h.call(
        "kernel_approve_draft_change_set",
        json!({"app_id":APP,"customer_id":"tenant_a","actor_id":"reviewer","change_set_id":draft["data"]["id"]}),
    );
    assert_overlap(&approved, &second);
    assert_eq!(h.live_assignments(), before);
    let status: String = h
        .client
        .query_one(
            "select status from change_set where id = $1",
            &[&draft["data"]["id"].as_i64().unwrap()],
        )
        .unwrap()
        .get(0);
    assert_eq!(status, "draft");
}

#[test]
fn readiness_rejects_existing_overlapping_live_rows() {
    let Some(mut h) = Harness::new() else {
        return;
    };
    let validated = h.call(
        "kernel_validate_materialized_schema_revision",
        json!({"schema":h.schema,"expected_schema_hash":"1".repeat(64)}),
    );
    assert_eq!(validated["ok"], true, "{validated}");

    let ada = h.create("employee", "Ada");
    let first_seat = h.create("position", "Engineer");
    let second_seat = h.create("position", "Manager");
    let first = new_id();
    let second = new_id();
    assert_eq!(
        h.apply(
            "pair",
            json!([
                assignment(
                    &first,
                    Some(&ada),
                    Some(&first_seat),
                    "2026-01-01",
                    Some("2026-06-30")
                ),
                assignment(&second, Some(&ada), Some(&second_seat), "2026-07-01", None)
            ])
        )["ok"],
        true
    );
    // Simulate rows persisted before the rule existed.
    h.client
        .execute(
            "update assignment_version set end_date = date '2026-12-01' where record_id = $1::text::uuid",
            &[&first],
        )
        .unwrap();

    let mut overlay = h.prepare_request("tenant_overlay");
    overlay["version"] = json!("intervals-v1-overlay");
    overlay["schema"]["version"] = json!("intervals-v1-overlay");
    overlay["effective_artifact_hash"] = json!("4".repeat(64));
    overlay["expected_active_effective_hash"] = json!("2".repeat(64));
    let prepared = h.call("kernel_prepare_schema_revision", overlay);
    assert_eq!(prepared["ok"], true, "{prepared}");
    let ready = h.ready(
        prepared["data"]["schema_revision_id"].as_i64().unwrap(),
        "4",
    );
    assert_eq!(
        ready["error"]["code"], "schema_revision_not_ready",
        "{ready}"
    );
    let details = ready["error"]["details"].as_array().unwrap();
    assert!(details
        .iter()
        .any(|detail| detail["path"] == "constraint" && detail["message"] == RULE));
    assert!(details[0]["message"]
        .as_str()
        .unwrap()
        .contains("One active assignment per subject"));
}

#[test]
fn concurrent_writers_cannot_both_admit_an_overlapping_pair() {
    let Some(mut h) = Harness::new() else {
        return;
    };
    let desk = |id: &str, start: &str| {
        json!({"model_id":"assignment","new_record_id":id,"effective_start":start,
               "values":{"start_date":date(start),"desk":{"type":"text","value":"D-1"}}})
    };
    // The writes share only a text subject, so no canonical row lock orders
    // them; the interval-rule model lock must.
    let first = new_id();
    let mut holder = connect_postgres(&h.url).unwrap();
    holder
        .batch_execute(&format!("set search_path to {}; begin", h.name))
        .unwrap();
    trusted_human::select(&mut holder, "reviewer");
    let held: Value = holder
        .query_one(
            "select kernel_apply_change_set($1::jsonb)",
            &[&h.request("held", "mainline", json!([desk(&first, "2026-01-01")]))],
        )
        .unwrap()
        .get(0);
    assert_eq!(held["ok"], true, "{held}");

    let mut contender = connect_postgres(&h.url).unwrap();
    contender
        .batch_execute(&format!("set search_path to {}", h.name))
        .unwrap();
    trusted_human::select(&mut contender, "reviewer");
    let contender_request = h.request(
        "contender",
        "mainline",
        json!([desk(&new_id(), "2026-03-01")]),
    );
    let waiting = std::thread::spawn(move || -> Value {
        contender
            .query_one(
                "select kernel_apply_change_set($1::jsonb)",
                &[&contender_request],
            )
            .unwrap()
            .get(0)
    });
    std::thread::sleep(std::time::Duration::from_millis(500));
    assert!(
        !waiting.is_finished(),
        "the contender must wait for the held model lock"
    );
    holder.batch_execute("commit").unwrap();

    let contended = waiting.join().unwrap();
    assert_overlap(&contended, &first);
    assert!(contended["error"]["message"]
        .as_str()
        .unwrap()
        .contains("with the same Desk"));
    assert_eq!(h.live_assignments().len(), 1);
}

#[test]
fn interval_rule_writes_reject_snapshot_isolation_levels() {
    let Some(mut h) = Harness::new() else {
        return;
    };
    let request = h.request(
        "repeatable-read",
        "mainline",
        json!([assignment(&new_id(), None, None, "2026-01-01", None)]),
    );
    // An older snapshot cannot observe a write committed while it waited for
    // the model lock, so the rule fails closed outside READ COMMITTED.
    for isolation in ["repeatable read", "serializable"] {
        let mut transaction = h
            .client
            .build_transaction()
            .isolation_level(match isolation {
                "repeatable read" => postgres::IsolationLevel::RepeatableRead,
                _ => postgres::IsolationLevel::Serializable,
            })
            .start()
            .unwrap();
        let rejected: Value = transaction
            .query_one("select kernel_apply_change_set($1::jsonb)", &[&request])
            .unwrap()
            .get(0);
        transaction.rollback().unwrap();
        assert_eq!(
            rejected["error"]["code"], "contract_validation_failed",
            "{isolation}: {rejected}"
        );
        assert_eq!(
            rejected["error"]["details"][0]["code"], "interval_rule_requires_read_committed",
            "{isolation}: {rejected}"
        );
    }
    let accepted = h.call("kernel_apply_change_set", request);
    assert_eq!(accepted["ok"], true, "{accepted}");
}

#[test]
fn tenant_overlay_activation_revalidates_after_readiness() {
    let Some(mut h) = Harness::new() else {
        return;
    };
    let ada = h.create("employee", "Ada");
    let first = new_id();
    let second = new_id();
    assert_eq!(
        h.apply(
            "pair",
            json!([
                assignment(&first, Some(&ada), None, "2026-01-01", Some("2026-06-30")),
                assignment(&second, Some(&ada), None, "2026-07-01", None)
            ])
        )["ok"],
        true
    );
    let mut overlay = h.prepare_request("tenant_overlay");
    overlay["version"] = json!("intervals-v1-overlay");
    overlay["schema"]["version"] = json!("intervals-v1-overlay");
    overlay["effective_artifact_hash"] = json!("4".repeat(64));
    overlay["expected_active_effective_hash"] = json!("2".repeat(64));
    let prepared = h.call("kernel_prepare_schema_revision", overlay);
    assert_eq!(prepared["ok"], true, "{prepared}");
    let revision = prepared["data"]["schema_revision_id"].as_i64().unwrap();
    assert_eq!(h.ready(revision, "4")["ok"], true);

    // Rows that overlap after readiness must still block activation.
    h.client
        .execute(
            "update assignment_version set end_date = date '2026-12-01' where record_id = $1::text::uuid",
            &[&first],
        )
        .unwrap();
    let activated = h.call(
        "kernel_activate_tenant_schema_revision",
        json!({"app_id":APP,"customer_id":"tenant_a","schema_revision_id":revision,
               "effective_artifact_hash":"4".repeat(64),"expected_active_effective_hash":"2".repeat(64)}),
    );
    assert_eq!(
        activated["error"]["code"], "schema_revision_not_ready",
        "{activated}"
    );
    assert!(activated["error"]["details"]
        .as_array()
        .unwrap()
        .iter()
        .any(|detail| detail["path"] == "constraint" && detail["message"] == RULE));
}

#[test]
fn draft_and_installer_paths_report_the_isolation_requirement() {
    let Some(mut h) = Harness::new() else {
        return;
    };
    let draft = h.draft(
        "draft-under-rr",
        json!([assignment(&new_id(), None, None, "2026-01-01", None)]),
    );
    assert_eq!(draft["ok"], true, "{draft}");
    let mut overlay = h.prepare_request("tenant_overlay");
    overlay["version"] = json!("intervals-v1-overlay");
    overlay["schema"]["version"] = json!("intervals-v1-overlay");
    overlay["effective_artifact_hash"] = json!("4".repeat(64));
    overlay["expected_active_effective_hash"] = json!("2".repeat(64));
    let prepared = h.call("kernel_prepare_schema_revision", overlay);
    assert_eq!(prepared["ok"], true, "{prepared}");
    let revision = prepared["data"]["schema_revision_id"].as_i64().unwrap();

    let calls = [
        (
            "kernel_approve_draft_change_set",
            json!({"app_id":APP,"customer_id":"tenant_a","actor_id":"reviewer","change_set_id":draft["data"]["id"]}),
            "contract_validation_failed",
        ),
        (
            "kernel_validate_schema_revision_readiness",
            json!({
                "app_id":APP,"customer_id":"tenant_a","schema_revision_id":revision,
                "effective_artifact_hash":"4".repeat(64),"materialization_plan_hash":"3".repeat(64),"phase_results":[]
            }),
            "schema_revision_not_ready",
        ),
    ];
    for (operation, request, code) in calls {
        let mut transaction = h
            .client
            .build_transaction()
            .isolation_level(postgres::IsolationLevel::RepeatableRead)
            .start()
            .unwrap();
        let rejected: Value = transaction
            .query_one(&format!("select {operation}($1::jsonb)"), &[&request])
            .unwrap()
            .get(0);
        transaction.rollback().unwrap();
        assert_eq!(rejected["error"]["code"], code, "{operation}: {rejected}");
        assert!(
            rejected["error"]["details"]
                .as_array()
                .unwrap()
                .iter()
                .any(|detail| detail["code"] == "interval_rule_requires_read_committed"),
            "{operation}: {rejected}"
        );
    }
}
