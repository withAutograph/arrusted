#[path = "support/work_sessions.rs"]
mod support;
use serde_json::{json, Value};
use support::*;

fn apply(f: &mut Fixture, mode: &str, source: &str, actor: &str) -> Value {
    f.call(
        "kernel_apply_change_set",
        json!({
            "app_id":APP,"customer_id":CUSTOMER,"actor_id":actor,
            "source_kind":source,"source_ref":"authority-run","mode":mode,
            "writes":[{"model_id":"item","record_key":{"type":"record_id","value":RECORD},
            "effective_start":"2026-01-01","values":{"score":{"type":"number","value":"21"}}}]
        }),
    )
}
fn record_run(f: &mut Fixture) {
    f.client
        .batch_execute("reset session authorization")
        .unwrap();
    f.client.execute("insert into agent_run(app_id,customer_id,run_id,schema_revision_id,actor_id,agent_identity_id,execution_profile_id) values($1,$2,'authority-run',1,'human','authority-agent','authority-profile')", &[&APP,&CUSTOMER]).unwrap();
}
fn approve(f: &mut Fixture, id: i64, actor: Option<&str>) -> Value {
    let mut request = json!({"app_id":APP,"customer_id":CUSTOMER,"change_set_id":id});
    if let Some(actor) = actor {
        request["actor_id"] = json!(actor);
    }
    f.call("kernel_approve_draft_change_set", request)
}

#[test]
fn declared_policy_apply_uses_trusted_membership_independently_of_source() {
    // A scope that declares an authorization policy takes canonical authority
    // from the trusted principal/tenant/actor binding.
    let Some(mut f) = Fixture::new() else { return };
    f.actor("agent");
    for source in ["human", "fixture", "agent"] {
        assert_error(
            &apply(&mut f, "mainline", source, "human"),
            "authorization_denied",
        );
    }
    f.actor("human");
    // The request actor must match the trusted binding.
    assert_error(
        &apply(&mut f, "mainline", "fixture", "other"),
        "authorization_denied",
    );
    for binding in ["missing", ""] {
        f.client
            .batch_execute(&format!("set kernel.actor_id='{binding}'"))
            .unwrap();
        assert_error(
            &apply(&mut f, "mainline", "fixture", "human"),
            "authorization_denied",
        );
    }
    // Omission of actor_kind remains agent even for a previously human principal.
    f.client
        .batch_execute("reset session authorization")
        .unwrap();
    let rebound = f.call("kernel_bind_actor_membership",json!({"principal_name":f.principal,"app_id":APP,"customer_id":CUSTOMER,"actor_id":"human","role":"editor"}));
    assert_ok(&rebound);
    f.actor("human");
    assert_error(
        &apply(&mut f, "mainline", "fixture", "human"),
        "authorization_denied",
    );
}

#[test]
fn declared_policy_apply_accepts_a_bound_human() {
    let Some(mut f) = Fixture::new() else { return };
    f.actor("human");
    assert_ok(&apply(&mut f, "mainline", "fixture", "human"));
    // Draft and revert lifecycle endpoints are unavailable under a declared policy.
    assert_error(
        &f.call("kernel_revert_change_set", json!({"app_id":APP,"customer_id":CUSTOMER,"change_set_id":1,"actor_id":"human","idempotency_key":"revert"})),
        "unsupported_capability",
    );
}

#[test]
fn policy_less_apply_needs_no_actor_binding() {
    // Policy-less scopes do not bind canonical writers yet (follow-up ad.51.5);
    // the runtime principal's tenant scope still applies.
    let Some(mut f) = Fixture::without_policy() else {
        return;
    };
    f.actor("human");
    f.client.batch_execute("set kernel.actor_id=''").unwrap();
    let created = apply(&mut f, "mainline", "fixture", "unbound");
    assert_ok(&created);
    record_run(&mut f);
    f.actor("agent");
    f.client.batch_execute("set kernel.actor_id=''").unwrap();
    let draft = apply(&mut f, "draft", "agent", "unbound");
    assert_ok(&draft);
    let id = draft["data"]["id"].as_i64().expect("draft receipt id");
    assert_ok(&approve(&mut f, id, None));
    // The approved draft is the record's latest mainline change, so it reverts.
    let revert = json!({"app_id":APP,"customer_id":CUSTOMER,"change_set_id":id,"idempotency_key":"unbound-revert"});
    assert_ok(&f.call("kernel_revert_change_set", revert));
}

#[test]
fn system_provenance_and_seed_authority_are_not_runtime_capabilities() {
    let Some(mut f) = Fixture::without_policy() else {
        return;
    };
    assert_error(
        &apply(&mut f, "mainline", "system", "human"),
        "reserved_source_kind",
    );
    for sql in [
        "select kernel_apply_seed_defaults('{}'::jsonb)",
        "select kernel_apply_execute_internal('{}'::jsonb,false,null,null,true)",
    ] {
        assert!(
            f.client.query_one(sql, &[]).is_err(),
            "runtime must not execute {sql}"
        );
    }
}

#[test]
fn per_query_record_grant_predicate_matches_the_policy_function() {
    let Some(mut f) = Fixture::new() else { return };
    f.client
        .batch_execute("reset session authorization")
        .unwrap();
    let grants = json!([
        {"record":{"kind":"actor_equals_field","field":"owner"},"read_fields":["$id","score"],"write_fields":["score"]},
        {"record":{"kind":"all"},"read_fields":["$id","rate"],"write_fields":[]}
    ]);
    for operation in ["read", "update", "delete", "history"] {
        for actor in [json!("human"), Value::Null] {
            let captured = json!({"actor_id":actor,"operation":operation,"grants":grants});
            for required in [
                json!([]),
                json!(["$id"]),
                json!(["score"]),
                json!(["rate"]),
                json!(["score", "rate"]),
                json!(["secret"]),
            ] {
                for values in [
                    json!({"owner":{"type":"text","value":"human"}}),
                    json!({"owner":{"type":"text","value":"other"}}),
                    json!({}),
                ] {
                    let expected: bool = f
                        .client
                        .query_one(
                            "select kernel_policy_grants_record_allowed($1,$2,$3)",
                            &[&captured, &required, &values],
                        )
                        .unwrap()
                        .get(0);
                    let predicate: String = f
                        .client
                        .query_one(
                            "select kernel_policy_grants_record_sql($1,$2,'x.v')",
                            &[&captured, &required],
                        )
                        .unwrap()
                        .get(0);
                    let actual: bool = f
                        .client
                        .query_one(
                            &format!("select ({predicate}) from (select $1::jsonb v) x"),
                            &[&values],
                        )
                        .unwrap()
                        .get(0);
                    assert_eq!(actual, expected, "{operation} {actor} {required} {values}");
                }
            }
        }
    }
    let none: String = f
        .client
        .query_one("select kernel_policy_grants_record_sql('{\"operation\":\"read\",\"grants\":[]}',null,'x.v')", &[])
        .unwrap()
        .get(0);
    assert_eq!(none, "false");
}

#[test]
fn tenant_policies_fix_scope_for_the_whole_statement() {
    let Some(mut f) = Fixture::new() else { return };
    assert_ok(&f.create());
    // Another tenant's rows, placed after this tenant's rows in each table.
    f.client
        .batch_execute(&format!(
            "reset session authorization;
             insert into work_session(app_id,customer_id,id,owner_id,title,as_of)
               values('{APP}','other_tenant','00000000-0000-0000-0000-0000000000ee','human','Other','2026-01-01');
             insert into item_record(id,app_id,customer_id,external_key)
               values('00000000-0000-0000-0000-0000000000ef','{APP}','other_tenant','other-tenant');
             create function test_switch_scope() returns boolean language sql volatile
               as $$ select set_config('kernel.customer_id','other_tenant',false) is not null $$;
             grant select on work_session, item_record to {principal};
             grant execute on function test_switch_scope(), kernel_principal_scope_authorized(text,text,text,text) to {principal};",
            principal = f.principal
        ))
        .unwrap();
    f.actor("human");
    f.client
        .batch_execute(&format!(
            "select set_config('kernel.app_id','{APP}',false), set_config('kernel.customer_id','{CUSTOMER}',false);
             set enable_indexscan = off; set enable_bitmapscan = off"
        ))
        .unwrap();
    for table in ["work_session", "item_record"] {
        // A sequential scan judges each row in turn. The first visible row
        // switches the scope; later rows must still be judged against the
        // scope the statement started with.
        let other: i64 = f
            .client
            .query_one(
                &format!("select count(*) filter (where customer_id = 'other_tenant') from {table} where test_switch_scope()"),
                &[],
            )
            .unwrap()
            .get(0);
        assert_eq!(other, 0, "{table}");
        f.client
            .batch_execute(&format!(
                "select set_config('kernel.customer_id','{CUSTOMER}',false)"
            ))
            .unwrap();
    }
}
