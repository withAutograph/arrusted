use kernel::connect_postgres;
use schema_compiler::{
    compile_manifest_json, compile_sql_artifact_manifest, render_sql_artifact_bundle,
};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use uuid::Uuid;

#[test]
fn trusted_ingestion_matches_sources_and_replays_under_current_policy() {
    let Ok(url) = std::env::var("KERNEL_TEST_DATABASE_URL") else {
        return;
    };
    let schema = format!("integration_test_{}", Uuid::new_v4().simple());
    let principal = format!("ingestion_runtime_{}", Uuid::new_v4().simple());
    let password = format!("integration-runtime-test-{}", Uuid::new_v4().simple());
    let compiled = compile_manifest_json(&json!({
      "app_id":"integration_fixture","customer_id":"tenant_a","version":"ingestion-v1",
      "models":[{"id":"company","kind":"entity","label":"Company","extensions":{"typed_custom_fields":true},"fields":[
        {"id":"name","label":"Name","type":"text","required":true},
        {"id":"note","label":"Note","type":"text"},
        {"id":"parent","label":"Parent","type":"relation","target_model":"company"}
      ]}],
      "custom_fields":[{"id":"company_custom_note","model":"company","field":"custom_note","label":"Custom note","type":"text"}],
      "authorization":{"roles":[{"id":"writer"},{"id":"name_only"}],"grants":[
        {"role":"writer","model":"company","operations":["read","create","update","delete"],"write_fields":["name","note","parent","custom_note"],"read_fields":["name","note","parent","custom_note","$id","$version"],"record":{"kind":"all"}},
        {"role":"name_only","model":"company","operations":["read","create","update"],"write_fields":["name"],"read_fields":["name","$id","$version"],"record":{"kind":"all"}}
      ]}
    }).to_string()).expect("compile integration fixture");
    let bundle = render_sql_artifact_bundle(&compile_sql_artifact_manifest(&compiled).unwrap());
    let mut admin = connect_postgres(&url).unwrap();
    admin
        .batch_execute(&format!(
            "create schema \"{schema}\"; set search_path to \"{schema}\""
        ))
        .unwrap();
    let existing_roles: BTreeSet<String> = admin
        .query("select rolname::text from pg_roles", &[])
        .unwrap()
        .into_iter()
        .map(|row| row.get(0))
        .collect();
    let mut owned_roles: Vec<String> = Vec::new();
    let mut added_runtime_membership: Option<String> = None;
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        admin
            .batch_execute(&bundle)
            .expect("install integration SQL");
        let runtime_role: String = admin
            .query_one("select kernel_installer_capability_role('runtime')", &[])
            .unwrap()
            .get(0);
        owned_roles = admin.query("select kernel_installer_capability_role(capability) from unnest(array['runtime','query','schema_admin','execution_owner']) capability", &[]).unwrap().into_iter().map(|row| row.get::<_,String>(0)).filter(|name| !existing_roles.contains(name)).collect();
        let directly_granted: bool = admin.query_one("select exists(select 1 from pg_auth_members m join pg_roles r on r.oid=m.roleid join pg_roles u on u.oid=m.member where r.rolname=$1 and u.rolname=session_user)", &[&runtime_role]).unwrap().get(0);
        if !directly_granted {
            admin
                .batch_execute(&format!("grant \"{runtime_role}\" to session_user"))
                .unwrap();
            added_runtime_membership = Some(runtime_role.clone());
        }
        admin.batch_execute(&format!("create role \"{principal}\" login password '{password}' nosuperuser nobypassrls; grant \"{runtime_role}\" to \"{principal}\"; grant usage on schema \"{schema}\" to \"{principal}\"" )).unwrap();
        let schema_json = serde_json::to_value(&compiled.schema).unwrap();
        admin.execute("insert into schema_revision(app_id,customer_id,version,base_schema,customer_overlay,schema,schema_hash,activated_at) values('integration_fixture','tenant_a','ingestion-v1',$1,'{}'::jsonb,$1,kernel_admin_sha256(kernel_canonical_json($1)),now())", &[&schema_json]).unwrap();
        admin
            .batch_execute(
                "select kernel_sync_schema_authorization_policy(id), kernel_sync_schema_constraint_identities(id) from schema_revision",
            )
            .unwrap();
        ok(call(
            &mut admin,
            "kernel_bind_principal_scope",
            json!({"principal_name":principal,"capability":"runtime","app_id":"integration_fixture","customer_id":"tenant_a"}),
        ));
        ok(call(
            &mut admin,
            "kernel_bind_actor_membership",
            json!({"principal_name":principal,"app_id":"integration_fixture","customer_id":"tenant_a","actor_id":"service_actor","role":"writer","actor_kind":"service"}),
        ));
        // Upgrading an earlier issued integration bundle preserves service grants.
        admin.batch_execute("alter table kernel_actor_membership drop constraint kernel_actor_membership_actor_kind_check; update kernel_actor_membership set actor_kind='integration_service'; alter table kernel_actor_membership add constraint kernel_actor_membership_actor_kind_check check(actor_kind in ('human','integration_service'))").unwrap();
        admin.batch_execute(&bundle).unwrap();
        let kind: String = admin
            .query_one(
                "select actor_kind from kernel_actor_membership where actor_id='service_actor'",
                &[],
            )
            .unwrap()
            .get(0);
        assert_eq!(kind, "service");
        let mut config: postgres::Config = url.parse().unwrap();
        config.user(&principal).password(password);
        let mut runtime = config.connect(postgres::NoTls).unwrap();
        runtime.batch_execute(&format!("set search_path to \"{schema}\"; set kernel.actor_id='service_actor'; set kernel.app_id='integration_fixture'; set kernel.customer_id='tenant_a'" )).unwrap();
        ok(call(
            &mut admin,
            "kernel_bind_actor_membership",
            json!({"principal_name":principal,"app_id":"integration_fixture","customer_id":"tenant_a","actor_id":"human_actor","role":"writer","actor_kind":"human"}),
        ));
        // Omitted kinds stay agents. Neither claimed human provenance nor the
        // reserved source namespace permits an agent to publish canonical writes.
        ok(call(
            &mut admin,
            "kernel_bind_actor_membership",
            json!({
                "principal_name":principal,"app_id":"integration_fixture",
                "customer_id":"tenant_a","actor_id":"agent_actor","role":"writer"
            }),
        ));
        runtime
            .batch_execute("set kernel.actor_id='agent_actor'")
            .unwrap();
        let mut agent_request = request(
            "agent-forged-source",
            "source-agent",
            "2026-01-01",
            "Agent",
            'a',
        );
        agent_request["actor_id"] = json!("agent_actor");
        error(
            call(&mut runtime, "resolve_then_apply", agent_request.clone()),
            "authorization_denied",
        );
        agent_request["source_kind"] = json!("human");
        agent_request["writes"][0]
            .as_object_mut()
            .unwrap()
            .remove("provenance");
        error(
            call(&mut runtime, "kernel_apply_change_set", agent_request),
            "authorization_denied",
        );
        runtime
            .batch_execute("set kernel.actor_id='human_actor'")
            .unwrap();
        let mut human_request = request(
            "human-not-ingress",
            "source-human",
            "2026-01-01",
            "Human",
            'a',
        );
        human_request["actor_id"] = json!("human_actor");
        error(
            call(&mut runtime, "resolve_then_apply", human_request),
            "authorization_denied",
        );
        // Direct canonical apply is also an authority boundary: source_kind alone
        // cannot grant service provenance, nor may human attribution hide its keys.
        for source_kind in ["integration", "human", "integration_maintenance"] {
            let mut forged = request(
                "human-forged-source",
                "source-1",
                "2026-01-01",
                "Poisoned",
                'a',
            );
            forged["actor_id"] = json!("human_actor");
            forged["source_kind"] = json!(source_kind);
            error(
                call(&mut runtime, "kernel_apply_change_set", forged),
                "authorization_denied",
            );
        }
        let mut source_kind_only = request(
            "human-forged-kind",
            "unused",
            "2026-01-01",
            "Forged kind",
            'a',
        );
        source_kind_only["actor_id"] = json!("human_actor");
        source_kind_only["writes"][0]
            .as_object_mut()
            .unwrap()
            .remove("provenance");
        error(
            call(&mut runtime, "kernel_apply_change_set", source_kind_only),
            "authorization_denied",
        );
        for key in ["relation_source_record_refs", "source_resolution_hash"] {
            let mut forged = request(
                "human-forged-metadata",
                "unused",
                "2026-01-01",
                "Forged metadata",
                'a',
            );
            forged["actor_id"] = json!("human_actor");
            forged["source_kind"] = json!("human");
            forged["writes"][0]["provenance"] = json!({key: "forged"});
            error(
                call(&mut runtime, "kernel_apply_change_set", forged),
                "authorization_denied",
            );
        }
        assert_eq!(
            admin
                .query_one("select count(*) from company_record", &[])
                .unwrap()
                .get::<_, i64>(0),
            0,
            "rejected provenance must not seed canonical subjects"
        );
        assert!(runtime.query_one("select kernel_bind_actor_membership($1::jsonb)",&[&json!({"principal_name":principal,"app_id":"integration_fixture","customer_id":"tenant_a","actor_id":"human_actor","role":"writer","actor_kind":"service"})]).is_err(),"runtime cannot self-provision service identity");
        runtime
            .batch_execute("set kernel.actor_id='service_actor'")
            .unwrap();
        ok(call(
            &mut admin,
            "kernel_bind_actor_membership",
            json!({"principal_name":principal,"app_id":"integration_fixture","customer_id":"tenant_a","actor_id":"fenced_service","role":"writer","fence_generation":1}),
        ));
        error(
            call(
                &mut admin,
                "kernel_bind_actor_membership",
                json!({"principal_name":principal,"app_id":"integration_fixture","customer_id":"tenant_a","actor_id":"fenced_service","role":"writer","actor_kind":"service","fence_generation":1}),
            ),
            "authorization_denied",
        );
        ok(call(
            &mut admin,
            "kernel_bind_actor_membership",
            json!({"principal_name":principal,"app_id":"integration_fixture","customer_id":"tenant_a","actor_id":"fenced_service","role":"writer","actor_kind":"service","fence_generation":2}),
        ));
        let revoked = ok(call(
            &mut admin,
            "kernel_bind_actor_membership",
            json!({"principal_name":principal,"app_id":"integration_fixture","customer_id":"tenant_a","actor_id":"fenced_service","role":"writer","actor_kind":"service","active":false,"fence_generation":3}),
        ));
        assert_eq!(
            revoked["actor_kind"], "service",
            "explicit classification preserves protected service identity during revocation"
        );
        error(
            call(
                &mut admin,
                "kernel_bind_actor_membership",
                json!({"principal_name":principal,"app_id":"integration_fixture","customer_id":"tenant_a","actor_id":"fenced_service","role":"writer","actor_kind":"service","fence_generation":2}),
            ),
            "authorization_denied",
        );
        let mut first_request = request("message-1", "source-1", "2026-01-01", "First", 'a');
        first_request["writes"][0]["provenance"]["source_input_hash"] = json!("e".repeat(64));
        first_request["writes"][0]["values"]["note"] = json!({"type":"text","value":"initial"});
        let first = ok(call(
            &mut runtime,
            "resolve_then_apply",
            first_request.clone(),
        ));
        assert_eq!(
            ok(call(
                &mut runtime,
                "resolve_then_apply",
                first_request.clone()
            )),
            first
        );
        // Generic resolution only locks/reads; ordinary apply owns persistence.
        runtime.batch_execute("begin").unwrap();
        let mut generic = request(
            "generic-import",
            "generic-source",
            "2026-01-01",
            "Import",
            'f',
        );
        generic["source_kind"] = json!("import");
        let before: i64 = admin
            .query_one("select count(*) from change_set", &[])
            .unwrap()
            .get(0);
        let resolved = ok(call(
            &mut runtime,
            "kernel_resolve_source_identities",
            generic,
        ));
        assert_eq!(
            admin
                .query_one("select count(*) from change_set", &[])
                .unwrap()
                .get::<_, i64>(0),
            before
        );
        ok(call(&mut runtime, "kernel_apply_change_set", resolved));
        runtime.batch_execute("rollback").unwrap();
        let replay_lookup = json!({"app_id":"integration_fixture","customer_id":"tenant_a","actor_id":"service_actor","source_kind":"integration","mode":"mainline","source_ref":"message-1","idempotency_key":"message-1","source_input_hash":"e".repeat(64),"replay_only":true});
        let restored = ok(call(
            &mut runtime,
            "kernel_resolve_source_identities",
            replay_lookup.clone(),
        ));
        assert_eq!(
            ok(call(&mut runtime, "kernel_apply_change_set", restored)),
            first
        );
        let mut forged_lookup = replay_lookup.clone();
        forged_lookup["source_input_hash"] = json!("d".repeat(64));
        error(
            call(
                &mut runtime,
                "kernel_resolve_source_identities",
                forged_lookup,
            ),
            "idempotency_conflict",
        );
        let mut conflict = first_request.clone();
        conflict["writes"][0]["provenance"]["payload_hash"] = json!("b".repeat(64));
        error(
            call(&mut runtime, "resolve_then_apply", conflict),
            "idempotency_conflict",
        );
        let old_version: Uuid = admin
            .query_one(
                "select id from company_version order by applied_at desc limit 1",
                &[],
            )
            .unwrap()
            .get(0);
        let canonical_target: Uuid = admin
            .query_one(
                "select record_id from company_version where name='First' limit 1",
                &[],
            )
            .unwrap()
            .get(0);
        let mut next = request("message-2", "source-1", "2026-01-02", "Updated", 'b');
        next["writes"][0]["values"]["note"] = json!({"type":"text","value":"keep"});
        ok(call(&mut runtime, "resolve_then_apply", next));
        assert_eq!(
            ok(call(
                &mut runtime,
                "resolve_then_apply",
                first_request.clone()
            )),
            first,
            "replay survives later versions"
        );
        runtime
            .batch_execute("set kernel.actor_id='human_actor'")
            .unwrap();
        error(
            call(
                &mut runtime,
                "kernel_apply_change_set",
                json!({"app_id":"integration_fixture","customer_id":"tenant_a","actor_id":"human_actor","source_kind":"human","idempotency_key":"stale-user-version","mode":"mainline","writes":[{"model_id":"company","record_key":{"type":"record_id","value":canonical_target},"expected_version_id":old_version,"effective_start":"2026-01-02","values":{"name":{"type":"text","value":"Stale user edit"}}}]}),
            ),
            "version_conflict",
        );
        runtime
            .batch_execute("set kernel.actor_id='service_actor'")
            .unwrap();
        let mut omitted = request("message-clear", "source-1", "2026-01-03", "Updated", 'c');
        error(
            call(&mut runtime, "resolve_then_apply", omitted.clone()),
            "source_clear_rejected",
        );
        omitted["writes"][0]["provenance"]["clear_policy"] = json!("preserve");
        ok(call(&mut runtime, "resolve_then_apply", omitted));
        let mut create_only = request("create-only", "source-1", "2026-01-04", "Duplicate", 'c');
        create_only["writes"][0]["provenance"]["match_policy"] = json!("create_only");
        error(
            call(&mut runtime, "resolve_then_apply", create_only),
            "source_identity_exists",
        );
        let count: i64 = admin
            .query_one("select count(*) from company_record", &[])
            .unwrap()
            .get(0);
        assert_eq!(count, 1);
        for (field, value) in [("customer_id", "tenant_b"), ("app_id", "other_app")] {
            let mut outside = first_request.clone();
            outside[field] = json!(value);
            error(
                call(&mut runtime, "resolve_then_apply", outside),
                "authorization_denied",
            );
        }
        // Split messages share an operation label but retain distinct message keys.
        ok(call(
            &mut runtime,
            "resolve_then_apply",
            request("operation:chunk-1", "source-2", "2026-01-01", "Two", 'd'),
        ));
        ok(call(
            &mut runtime,
            "resolve_then_apply",
            request("operation:chunk-2", "source-3", "2026-01-01", "Three", 'e'),
        ));
        let mut relation = request("relation-missing", "source-4", "2026-01-01", "Four", 'f');
        relation["writes"][0]["provenance"]["relation_source_record_refs"] =
            json!({"parent":{"model_id":"company","source_record_ref":"absent"}});
        error(
            call(&mut runtime, "resolve_then_apply", relation),
            "record_target_missing",
        );
        let count: i64 = admin
            .query_one("select count(*) from company_record", &[])
            .unwrap()
            .get(0);
        assert_eq!(count, 3);
        // A relation-only direct bridge write must initialize values rather than
        // silently dropping the resolved parent when the parent object is absent.
        let mut relation_only = request("relation-only", "source-2", "2026-01-02", "unused", 'f');
        relation_only["writes"][0]
            .as_object_mut()
            .unwrap()
            .remove("values");
        relation_only["writes"][0]["provenance"]["mapped_field_ids"] = json!(["parent"]);
        relation_only["writes"][0]["provenance"]["relation_source_record_refs"] =
            json!({"parent":{"model_id":"company","source_record_ref":"source-1"}});
        ok(call(&mut runtime, "resolve_then_apply", relation_only));
        let parent: Option<Uuid> = admin.query_one("select parent from company_version where effective_start='2026-01-02' and provenance->>'source_record_ref'='source-2'", &[]).unwrap().get(0);
        assert!(
            parent.is_some(),
            "relation-only write lost its source reference"
        );

        let mut custom = request("custom-update", "source-2", "2026-01-03", "Two", 'f');
        custom["writes"][0]["provenance"]["mapped_field_ids"] = json!(["custom_note"]);
        custom["writes"][0]["custom_fields"] =
            json!([{"field_id":"custom_note","type":"text","value":"mapped custom"}]);
        ok(call(&mut runtime, "resolve_then_apply", custom.clone()));
        ok(call(&mut runtime, "resolve_then_apply", custom.clone()));
        let mut missing_custom =
            request("custom-reject-clear", "source-2", "2026-01-04", "Two", 'a');
        missing_custom["writes"][0]["provenance"]["mapped_field_ids"] = json!(["custom_note"]);
        error(
            call(&mut runtime, "resolve_then_apply", missing_custom.clone()),
            "source_clear_rejected",
        );
        missing_custom["idempotency_key"] = json!("custom-preserve");
        missing_custom["writes"][0]["provenance"]["clear_policy"] = json!("preserve");
        ok(call(
            &mut runtime,
            "resolve_then_apply",
            missing_custom.clone(),
        ));
        let values: Value = admin.query_one("select custom_fields from company_version where effective_start='2026-01-04' and provenance->>'source_record_ref'='source-2'", &[]).unwrap().get(0);
        assert_eq!(values[0]["value"], "mapped custom");
        missing_custom["idempotency_key"] = json!("custom-clear");
        missing_custom["writes"][0]["effective_start"] = json!("2026-01-05");
        missing_custom["writes"][0]["provenance"]["clear_policy"] = json!("clear");
        ok(call(&mut runtime, "resolve_then_apply", missing_custom));
        let values: Value = admin.query_one("select custom_fields from company_version where effective_start='2026-01-05' and provenance->>'source_record_ref'='source-2'", &[]).unwrap().get(0);
        assert_eq!(values, json!([]));
        for (model_id, lifecycle) in [("company", "retired"), ("other_model", "active")] {
            let mut invalid_schema = schema_json.clone();
            invalid_schema["custom_fields"][0]["model_id"] = json!(model_id);
            invalid_schema["custom_fields"][0]["lifecycle"] = json!(lifecycle);
            admin
                .execute("update schema_revision set schema=$1", &[&invalid_schema])
                .unwrap();
            let mut invalid = custom.clone();
            invalid["idempotency_key"] = json!(format!("invalid-custom-{model_id}-{lifecycle}"));
            error(
                call(&mut runtime, "resolve_then_apply", invalid),
                "contract_validation_failed",
            );
        }
        admin
            .execute("update schema_revision set schema=$1", &[&schema_json])
            .unwrap();

        // Preserve the legacy trusted Rust path: ordinary apply may write source
        // provenance under an explicit service actor, and the fixed bridge must
        // subsequently match that same canonical subject without duplication.
        let legacy = request(
            "legacy-service",
            "legacy-source",
            "2026-01-01",
            "Legacy",
            'a',
        );
        let legacy_id = legacy["writes"][0]["new_record_id"].clone();
        ok(call(&mut runtime, "kernel_apply_change_set", legacy));
        ok(call(
            &mut runtime,
            "resolve_then_apply",
            request(
                "legacy-cutover",
                "legacy-source",
                "2026-01-02",
                "Migrated",
                'b',
            ),
        ));
        let matched: Uuid = admin
            .query_one(
                "select record_id from company_version where name='Migrated'",
                &[],
            )
            .unwrap()
            .get(0);
        assert_eq!(json!(matched), legacy_id);
        runtime
            .batch_execute("set kernel.actor_id='human_actor'")
            .unwrap();
        let mut ordinary = request(
            "ordinary-human",
            "unused",
            "2026-01-01",
            "Human authored",
            'a',
        );
        ordinary["actor_id"] = json!("human_actor");
        ordinary["source_kind"] = json!("human");
        ordinary["writes"][0]["provenance"] = json!({"source":"ordinary attribution"});
        ok(call(&mut runtime, "kernel_apply_change_set", ordinary));
        let mut human_replay = first_request.clone();
        human_replay["actor_id"] = json!("human_actor");
        human_replay["source_kind"] = json!("human");
        error(
            call(&mut runtime, "kernel_apply_change_set", human_replay),
            "authorization_denied",
        );
        runtime
            .batch_execute("set kernel.actor_id='service_actor'")
            .unwrap();
        // Current field grants, including replay, remain canonical authorization.
        ok(call(
            &mut admin,
            "kernel_bind_actor_membership",
            json!({"principal_name":principal,"app_id":"integration_fixture","customer_id":"tenant_a","actor_id":"service_actor","role":"writer","active":false}),
        ));
        ok(call(
            &mut admin,
            "kernel_bind_actor_membership",
            json!({"principal_name":principal,"app_id":"integration_fixture","customer_id":"tenant_a","actor_id":"service_actor","role":"name_only","actor_kind":"service"}),
        ));
        error(
            call(&mut runtime, "resolve_then_apply", first_request.clone()),
            "authorization_denied",
        );
        error(
            call(
                &mut runtime,
                "kernel_resolve_source_identities",
                replay_lookup.clone(),
            ),
            "authorization_denied",
        );
        let mut custom_denied = custom.clone();
        custom_denied["idempotency_key"] = json!("custom-field-denied");
        custom_denied["writes"][0]["effective_start"] = json!("2026-01-06");
        error(
            call(&mut runtime, "resolve_then_apply", custom_denied),
            "authorization_denied",
        );
        let mut denied = request("field-denied", "source-5", "2026-01-01", "Denied", 'a');
        denied["writes"][0]["values"]["note"] = json!({"type":"text","value":"forbidden"});
        error(
            call(&mut runtime, "resolve_then_apply", denied),
            "authorization_denied",
        );
        ok(call(
            &mut admin,
            "kernel_bind_actor_membership",
            json!({"principal_name":principal,"app_id":"integration_fixture","customer_id":"tenant_a","actor_id":"service_actor","role":"name_only","active":false}),
        ));
        error(
            call(
                &mut runtime,
                "resolve_then_apply",
                request("revoked-service", "source-6", "2026-01-01", "Revoked", 'a'),
            ),
            "authorization_denied",
        );
        error(
            call(&mut runtime, "resolve_then_apply", first_request),
            "authorization_denied",
        );
        // Compiler output and catalog repair must install the same usable
        // partial expression index. Test planner selection with real history.
        let original_index: String = admin.query_one("select indexdef from pg_indexes where schemaname=current_schema() and indexname='company_version_source_record_ref_idx'", &[]).unwrap().get(0);
        admin
            .batch_execute("drop index company_version_source_record_ref_idx")
            .unwrap();
        let schema_hash: String = admin
            .query_one(
                "select kernel_admin_sha256(kernel_canonical_json($1::jsonb))",
                &[&schema_json],
            )
            .unwrap()
            .get(0);
        let missing_index = call(
            &mut admin,
            "kernel_validate_materialized_schema_revision",
            json!({"schema":schema_json,"expected_schema_hash":schema_hash}),
        );
        error(missing_index.clone(), "schema_drift");
        assert!(missing_index
            .to_string()
            .contains("company_version_source_record_ref_idx"));
        admin.batch_execute("create index company_version_source_record_ref_idx on company_version (app_id,customer_id,(provenance->>'wrong_source')) where provenance ? 'source_record_ref'").unwrap();
        let wrong_expression = call(
            &mut admin,
            "kernel_validate_materialized_schema_revision",
            json!({"schema":schema_json,"expected_schema_hash":schema_hash}),
        );
        error(wrong_expression.clone(), "schema_drift");
        assert!(wrong_expression
            .to_string()
            .contains("company_version_source_record_ref_idx"));
        admin
            .batch_execute("drop index company_version_source_record_ref_idx")
            .unwrap();
        ok(call(
            &mut admin,
            "kernel_repair_materialized_schema_revision",
            json!({"schema":schema_json,"expected_schema_hash":schema_hash}),
        ));
        let repaired_index: String = admin.query_one("select indexdef from pg_indexes where schemaname=current_schema() and indexname='company_version_source_record_ref_idx'", &[]).unwrap().get(0);
        assert_eq!(original_index, repaired_index);
        admin.batch_execute("insert into company_version select (jsonb_populate_record(null::company_version,to_jsonb(template) || jsonb_build_object('id',md5('integration-scale:'||n::text)::uuid,'effective_start',date '1900-01-01'+n,'provenance',template.provenance||jsonb_build_object('source_record_ref','scale-'||n::text)))).* from (select * from company_version limit 1) template cross join generate_series(1,10000) n; analyze company_version").unwrap();
        let plan: Value = admin.query_one("explain (format json) select record_id from company_version where app_id='integration_fixture' and customer_id='tenant_a' and provenance ? 'source_record_ref' and provenance->>'source_record_ref'='scale-9000'", &[]).unwrap().get(0);
        assert!(
            plan.to_string()
                .contains("company_version_source_record_ref_idx"),
            "source lookup did not use its index: {plan}"
        );
        // No direct version-table DML authority is needed by the runtime role.
        assert!(runtime
            .execute("update company_version set name='wrong'", &[])
            .is_err());
    }));
    let mut cleanup_errors = Vec::new();
    let mut cleanup = vec![
        "rollback".to_string(),
        "reset role".to_string(),
        "set search_path to public".to_string(),
        format!("drop schema if exists \"{schema}\" cascade"),
        format!("drop role if exists \"{principal}\""),
    ];
    if let Some(role) = added_runtime_membership {
        cleanup.push(format!("revoke \"{role}\" from session_user"));
    }
    cleanup.extend(
        owned_roles
            .into_iter()
            .map(|role| format!("drop role if exists \"{role}\"")),
    );
    for statement in cleanup {
        if let Err(error) = admin.batch_execute(&statement) {
            cleanup_errors.push(error.to_string());
        }
    }
    if !cleanup_errors.is_empty() {
        eprintln!("integration fixture cleanup failed: {cleanup_errors:?}");
    }

    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
    assert!(
        cleanup_errors.is_empty(),
        "integration fixture cleanup failed"
    );
}
fn request(delivery: &str, source: &str, date: &str, name: &str, hash: char) -> Value {
    json!({"app_id":"integration_fixture","customer_id":"tenant_a","schema_revision_id":"1","actor_id":"service_actor","source_kind":"integration","source_ref":delivery,"idempotency_key":delivery,"mode":"mainline","writes":[{
     "model_id":"company","new_record_id":Uuid::new_v4(),"effective_start":date,"values":{"name":{"type":"text","value":name}},"clear_fields":[],"clear_custom_fields":[],
     "provenance":{"source_record_ref":source,"payload_hash":hash.to_string().repeat(64),"mapped_field_ids":["name","note"],"match_policy":"source_reference","clear_policy":"reject"}
    }]})
}
fn call(client: &mut postgres::Client, name: &str, input: Value) -> Value {
    let sql = if name == "resolve_then_apply" {
        "with resolved as materialized (select kernel_resolve_source_identities($1::jsonb) r) select case when r->'ok'='true'::jsonb then kernel_apply_change_set(r->'data') else r end from resolved".to_string()
    } else {
        format!("select {name}($1::jsonb)")
    };
    client.query_one(&sql, &[&input]).expect(name).get(0)
}
fn ok(response: Value) -> Value {
    assert_eq!(response["ok"], true, "{response}");
    response["data"].clone()
}
fn error(response: Value, code: &str) {
    assert_eq!(response["ok"], false, "expected {code}: {response}");
    assert_eq!(response["error"]["code"], code, "{response}");
}
