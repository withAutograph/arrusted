#[path = "support/work_sessions.rs"]
mod support;
use serde_json::json;
use std::time::{Duration, Instant};
use support::*;

// The product budget: one stage, get and an overlay aggregate over 30,000
// staged entries on a 50,000-row model, plus a rule over every row. Budgets are
// the targets multiplied by WORK_SCALE_BUDGET_FACTOR (default 5) for CI hosts.
#[test]
fn large_work_session_stage_read_aggregate_and_lookup_rule() {
    let Some(mut f) = Fixture::new() else { return };
    let env = |name: &str, default: i32| {
        std::env::var(name)
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(default)
    };
    let model_rows = env("WORK_SCALE_MODEL_ROWS", 50_000);
    let staged_rows = env("WORK_SCALE_STAGED_ROWS", 30_000);
    let factor = env("WORK_SCALE_BUDGET_FACTOR", 5) as u32;
    let budget = |name: &str, elapsed: Duration, target_ms: u64| {
        eprintln!("work scale {name}={elapsed:?} (target {target_ms} ms)");
        assert!(
            elapsed <= Duration::from_millis(target_ms) * factor,
            "{name} took {elapsed:?}, over {factor} x {target_ms} ms"
        );
    };
    assert!(staged_rows > 1 && model_rows > staged_rows);
    assert_ok(&f.create());
    let staged = f.work(json!({"operation":"stage","changes":[{"model_id":"item","record_id":RECORD,"field_id":"score","value":{"type":"number","value":"20"}}]}));
    assert_ok(&staged);
    f.client
        .batch_execute("reset session authorization")
        .unwrap();
    // SQL seeds only test-owned canonical/staged fixtures. Every measured
    // operation below runs as the actual runtime principal with record policy.
    f.client.execute(
        "insert into item_record(id,app_id,customer_id,external_key)
         select md5('scale-record-'||g)::uuid,$1,$2,'scale-'||g from generate_series(1,$3::integer-2) g",
        &[&APP, &CUSTOMER, &model_rows],
    ).unwrap();
    f.client.execute(
        "insert into item_version(id,record_id,app_id,customer_id,stage,effective_start,change_set_id,applied_at,owner,score,parent,custom_fields)
         select md5('scale-version-'||g)::uuid,md5('scale-record-'||g)::uuid,$1,$2,'mainline','2026-01-01',1,now(),'human',10,$4::text::uuid,'[]'
         from generate_series(1,$3::integer-2) g",
        &[&APP, &CUSTOMER, &model_rows, &RECORD],
    ).unwrap();
    f.client.execute(
        "insert into work_session_record(app_id,customer_id,session_id,model_id,record_id,field_id,value,baseline,base_version,
           source,actor_id,author_principal,author_kind,created_at,updated_at)
         select $1,$2,$3::text::uuid,'item',md5('scale-record-'||g)::uuid,'score','{\"type\":\"number\",\"value\":\"20\"}',
           '{\"type\":\"number\",\"value\":\"10\"}',md5('scale-version-'||g)::uuid,'user','human',$4,'human',now(),now()
         from generate_series(1,$5::integer-1) g",
        &[&APP, &CUSTOMER, &f.session_id, &f.principal, &staged_rows],
    ).unwrap();
    // Measure steady-state tables, as autovacuum leaves them.
    for table in [
        "item_record",
        "item_version",
        "work_session_record",
        "change_set",
    ] {
        f.client
            .batch_execute(&format!("vacuum analyze {table}"))
            .unwrap();
    }
    f.client
        .batch_execute("set statement_timeout='300s'")
        .unwrap();
    f.actor("human");
    // Each primary operation is timed three times and judged by its fastest
    // run, so one slow scheduling slot on a shared host does not decide it.
    let mut stage_elapsed = Duration::MAX;
    for value in ["21", "22", "21"] {
        let started = Instant::now();
        let changed = f.work(json!({"operation":"stage","changes":[{"model_id":"item","record_id":RECORD,"field_id":"score","value":{"type":"number","value":value}}]}));
        stage_elapsed = stage_elapsed.min(started.elapsed());
        assert_ok(&changed);
        assert_eq!(changed["data"]["entries"].as_array().unwrap().len(), 1);
    }
    let mut read_elapsed = Duration::MAX;
    for _ in 0..3 {
        let started = Instant::now();
        let read = f.work(json!({"operation":"get"}));
        read_elapsed = read_elapsed.min(started.elapsed());
        assert_ok(&read);
        assert_eq!(
            read["data"]["overlay"].as_array().unwrap().len(),
            staged_rows as usize
        );
    }
    let mut aggregate_elapsed = Duration::MAX;
    for _ in 0..3 {
        let started = Instant::now();
        let aggregate = f.call(
            "kernel_data_query",
            json!({"app_id":APP,"customer_id":CUSTOMER,"schema_version":VERSION,
            "model_id":"item","as_of":"2026-01-01","kind":"aggregate","work":f.work_ref(),
            "metrics":[{"fn":"sum","field":"score"}]}),
        );
        aggregate_elapsed = aggregate_elapsed.min(started.elapsed());
        assert_ok(&aggregate);
        // Exclude the hidden record and count each staged row only at its overlay value.
        let expected = (model_rows - staged_rows - 1) * 10 + (staged_rows - 1) * 20 + 21;
        assert_eq!(
            aggregate["data"]["total"]["metrics"],
            json!([expected.to_string()])
        );
    }
    // A rule over every readable row, each output read through a relation
    // lookup of the parent's staged score (21).
    let started = Instant::now();
    let ruled = f.work(json!({"operation":"rule_create","expected_revision":5,"request_id":"scale-lookup-rule","rule_id":"lookup",
        "rule":{"model_id":"item","field_id":"custom_score","value":{"type":"relation_field","relation":"parent","field":"score"}}}));
    let rule_elapsed = started.elapsed();
    assert_ok(&ruled);
    let outputs = ruled["data"]["entries"].as_array().unwrap();
    assert_eq!(outputs.len(), model_rows as usize - 1);
    assert!(outputs.iter().all(|entry| entry["value"]["value"] == "21"));
    // The hidden record is never admitted to the lookup or aggregate result.
    assert!(!outputs
        .iter()
        .any(|entry| entry["record_id"] == OTHER_RECORD));
    eprintln!("work scale model={model_rows} staged={staged_rows}");
    budget("stage_one", stage_elapsed, 300);
    budget("get", read_elapsed, 2_000);
    budget("aggregate", aggregate_elapsed, 2_000);
    budget("whole_model_rule", rule_elapsed, 10_000);
}
