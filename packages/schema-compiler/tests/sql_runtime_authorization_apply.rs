use std::env;

use kernel::connect_postgres;
use postgres::{Config, NoTls};
use schema_compiler::{
    compile_manifest_json, compile_sql_artifact_manifest, render_sql_artifact_bundle,
};
use serde_json::{json, Value};
use std::str::FromStr;
use uuid::Uuid;

const APP_ID: &str = "policy_apply_fixture";
const CUSTOMER_ID: &str = "tenant_a";
const VERSION: &str = "policy-apply-v1";
const HISTORICAL_HC_RELEASE_BUNDLE: &str =
    include_str!("fixtures/historical-sql/2026-09-26.runtime-observability-v52.sql");

struct AuthorizationFixtureCleanup {
    database_url: String,
    schema: String,
    principal: String,
    complete: bool,
}

impl AuthorizationFixtureCleanup {
    fn new(database_url: &str, schema: &str, principal: &str) -> Self {
        Self {
            database_url: database_url.to_owned(),
            schema: schema.to_owned(),
            principal: principal.to_owned(),
            complete: false,
        }
    }

    fn finish(&mut self) -> Result<(), String> {
        if self.complete {
            return Ok(());
        }
        let mut cleanup = connect_postgres(&self.database_url)
            .map_err(|error| format!("connect cleanup PostgreSQL: {error}"))?;
        cleanup
            .batch_execute(&format!(
                r#"
                rollback;
                reset role;
                reset session authorization;
                set search_path to public;
                drop schema if exists "{}" cascade;
                drop role if exists "{}";
                "#,
                self.schema, self.principal,
            ))
            .map_err(|error| format!("remove isolated authorization fixture: {error}"))?;
        self.complete = true;
        Ok(())
    }
}

impl Drop for AuthorizationFixtureCleanup {
    fn drop(&mut self) {
        if let Err(error) = self.finish() {
            eprintln!("authorization fixture cleanup after panic: {error}");
        }
    }
}

#[test]
fn historical_release_replay_cannot_bypass_actor_membership_fence() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let compiled = compile_manifest_json(&policy_manifest().to_string())
        .expect("compile test-owned policy manifest");
    let manifest = compile_sql_artifact_manifest(&compiled).expect("compile policy SQL bundle");
    let current_bundle = render_sql_artifact_bundle(&manifest);
    let mut client = connect_postgres(&database_url).expect("connect PostgreSQL");
    let schema = format!("kernel_fence_replay_{}", Uuid::new_v4().simple());
    let principal = format!("fence_replay_runtime_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            "create schema \"{schema}\"; set search_path to \"{schema}\""
        ))
        .expect("create isolated fence replay schema");
    let mut cleanup = AuthorizationFixtureCleanup::new(&database_url, &schema, &principal);

    let result = (|| -> Result<(), String> {
        client
            .batch_execute(&current_bundle)
            .map_err(|error| format!("install current policy fixture bundle: {error}"))?;
        let fence_guard_installed: bool = client
            .query_one(
                "select exists (select 1 from pg_trigger where tgrelid='kernel_actor_membership'::regclass and tgname='kernel_actor_membership_fence_guard' and not tgisinternal)",
                &[],
            )
            .map_err(|error| format!("check membership fence trigger: {error}"))?
            .get(0);
        assert!(
            fence_guard_installed,
            "current policy fixture bundle installs the row fence guard"
        );
        let runtime_role = scalar(
            &mut client,
            "select kernel_installer_capability_role('runtime')",
        )?;
        client
            .batch_execute(&format!(
                "create role \"{principal}\" nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls; grant \"{runtime_role}\" to \"{principal}\""
            ))
            .map_err(|error| format!("create protected runtime principal: {error}"))?;

        assert_ok(&call(
            &mut client,
            "kernel_bind_actor_membership",
            json!({"principal_name":principal,"app_id":"hc","customer_id":"hc","actor_id":"actor-a","actor_kind":"human","role":"reviewer","active":true,"fence_generation":1}),
        )?);
        assert_ok(&call(
            &mut client,
            "kernel_bind_actor_membership",
            json!({"principal_name":principal,"app_id":"hc","customer_id":"hc","actor_id":"actor-a","actor_kind":"human","role":"reviewer","active":false,"fence_generation":2}),
        )?);

        client
            .batch_execute(HISTORICAL_HC_RELEASE_BUNDLE)
            .map_err(|error| format!("replay historical HC release bundle: {error}"))?;
        let delayed_legacy_grant = call(
            &mut client,
            "kernel_bind_actor_membership",
            json!({"principal_name":principal,"app_id":"hc","customer_id":"hc","actor_id":"actor-a","role":"reviewer","active":true}),
        )
        .expect_err("historical function must not reopen a fenced membership");
        assert!(
            delayed_legacy_grant
                .contains("changing fenced actor membership requires a higher generation"),
            "unexpected historical replay rejection: {delayed_legacy_grant}"
        );
        let after_replay = client
            .query_one(
                "select active, fence_generation from kernel_actor_membership where principal_name=$1 and app_id='hc' and customer_id='hc' and actor_id='actor-a' and role='reviewer'",
                &[&principal],
            )
            .map_err(|error| format!("read fenced membership after historical replay: {error}"))?;
        assert!(!after_replay.get::<_, bool>("active"));
        assert_eq!(after_replay.get::<_, i64>("fence_generation"), 2);

        client.batch_execute(&current_bundle).map_err(|error| {
            format!("restore current policy fixture bundle after replay: {error}")
        })?;
        assert_ok(&call(
            &mut client,
            "kernel_bind_actor_membership",
            json!({"principal_name":principal,"app_id":"hc","customer_id":"hc","actor_id":"actor-a","actor_kind":"human","role":"reviewer","active":false,"fence_generation":2}),
        )?);
        Ok(())
    })();

    match result {
        Ok(()) => cleanup
            .finish()
            .expect("remove isolated fence replay fixture"),
        Err(error) => {
            if let Err(cleanup_error) = cleanup.finish() {
                eprintln!("fence replay fixture cleanup after test failure: {cleanup_error}");
            }
            panic!("historical release replay fence behavior: {error}");
        }
    }
}

#[test]
fn policy_enabled_apply_uses_current_membership_and_checks_old_and_new_owner_images() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let compiled =
        compile_manifest_json(&policy_manifest().to_string()).expect("compile policy manifest");
    let manifest = compile_sql_artifact_manifest(&compiled).expect("compile SQL policy bundle");
    let mut client = connect_postgres(&database_url).expect("connect PostgreSQL");
    let schema = format!("kernel_policy_apply_{}", Uuid::new_v4().simple());
    let principal = format!("policy_apply_runtime_{}", Uuid::new_v4().simple());
    let password = format!("policy-apply-runtime-test-{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            "create schema \"{schema}\"; set search_path to \"{schema}\""
        ))
        .expect("create isolated policy schema");

    let mut cleanup = AuthorizationFixtureCleanup::new(&database_url, &schema, &principal);

    let result = (|| -> Result<(), String> {
        // Start with the pre-fence table shape: compiling/installing the current trusted catalog
        // must upgrade existing rows with generation zero before the current function is used.
        client
            .batch_execute(
                "create table kernel_actor_membership (principal_name name not null, app_id text not null, customer_id text not null, actor_id text not null, role text not null, active boolean not null default true, bound_at timestamptz not null default now(), primary key (principal_name,app_id,customer_id,actor_id,role)); insert into kernel_actor_membership (principal_name,app_id,customer_id,actor_id,role,active) values ('legacy_member','legacy-app','legacy-tenant','legacy-actor','legacy-role',false)",
            )
            .map_err(|error| format!("create pre-fence membership table: {error}"))?;
        client
            .batch_execute(&render_sql_artifact_bundle(&manifest))
            .map_err(|error| format!("install policy bundle: {error}"))?;
        let legacy_membership = client
            .query_one(
                "select active, fence_generation from kernel_actor_membership where principal_name='legacy_member'",
                &[],
            )
            .map_err(|error| format!("read upgraded legacy membership: {error}"))?;
        assert!(!legacy_membership.get::<_, bool>("active"));
        assert_eq!(legacy_membership.get::<_, i64>("fence_generation"), 0);
        let installer_runtime_role = scalar(
            &mut client,
            "select kernel_installer_capability_role('runtime')",
        )?;
        client
            .batch_execute(&format!(
                "grant \"{}\" to session_user",
                installer_runtime_role
            ))
            .map_err(|error| format!("grant runtime capability to installer: {error}"))?;

        let schema_json = serde_json::to_value(&compiled.schema).expect("serialize schema");
        client
            .execute(
                "insert into schema_revision (app_id,customer_id,version,base_schema,customer_overlay,schema,activated_at) values ($1,$2,$3,$4,'{}'::jsonb,$4,now())",
                &[&APP_ID, &CUSTOMER_ID, &VERSION, &schema_json],
            )
            .map_err(|error| format!("insert active policy revision: {error}"))?;
        client
            .execute(
                "select kernel_sync_schema_authorization_policy(id) from schema_revision where app_id=$1 and customer_id=$2 and version=$3",
                &[&APP_ID, &CUSTOMER_ID, &VERSION],
            )
            .map_err(|error| format!("snapshot compiler policy: {error}"))?;

        client
            .batch_execute(&format!(
                r#"
                insert into change_set (
                  app_id, customer_id, schema_revision_id, created_with_mode, status,
                  source_kind, created_order, applied_order, applied_at
                ) values ('{APP_ID}', '{CUSTOMER_ID}', 1, 'mainline', 'mainline', 'fixture', 1, 1, now());
                insert into work_item_record (id,app_id,customer_id,external_key) values
                  ('00000000-0000-0000-0000-000000000001','{APP_ID}','{CUSTOMER_ID}','mine'),
                  ('00000000-0000-0000-0000-000000000002','{APP_ID}','{CUSTOMER_ID}','other');
                insert into work_item_version (
                  id,record_id,app_id,customer_id,stage,effective_start,change_set_id,applied_at,owner,summary
                ) values
                  ('00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000001','{APP_ID}','{CUSTOMER_ID}','mainline','2026-01-01',1,now(),'actor_a','mine'),
                  ('00000000-0000-0000-0000-000000000012','00000000-0000-0000-0000-000000000002','{APP_ID}','{CUSTOMER_ID}','mainline','2026-01-01',1,now(),'actor_b','other');
                "#
            ))
            .map_err(|error| format!("seed policy query records: {error}"))?;

        let runtime_role = scalar(
            &mut client,
            "select kernel_installer_capability_role('runtime')",
        )?;
        client
            .batch_execute(&format!(
                r#"create role "{principal}" login password '{password}' nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
                   grant "{runtime_role}" to "{principal}";
                   grant usage on schema "{schema}" to "{principal}""#
            ))
            .map_err(|error| format!("create restricted policy role: {error}"))?;
        assert_ok(&call(
            &mut client,
            "kernel_bind_principal_scope",
            json!({"principal_name":principal,"capability":"runtime","app_id":APP_ID,"customer_id":CUSTOMER_ID}),
        )?);
        assert_ok(&call(
            &mut client,
            "kernel_bind_actor_membership",
            json!({"principal_name":principal,"app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"actor_a","actor_kind":"human","role":"reviewer"}),
        )?);

        // Protected retries are fenced by the trusted journal generation. Legacy zero remains
        // compatible only until a positive protected operation has advanced this membership.
        assert_ok(&call(
            &mut client,
            "kernel_bind_actor_membership",
            json!({"principal_name":principal,"app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"actor_a","actor_kind":"human","role":"reviewer","active":false,"fence_generation":2}),
        )?);
        for stale_or_conflicting in [
            json!({"principal_name":principal,"app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"actor_a","actor_kind":"human","role":"reviewer","active":true,"fence_generation":1}),
            json!({"principal_name":principal,"app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"actor_a","actor_kind":"human","role":"reviewer","active":true,"fence_generation":2}),
            json!({"principal_name":principal,"app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"actor_a","actor_kind":"human","role":"reviewer","active":true}),
        ] {
            let rejected = call(
                &mut client,
                "kernel_bind_actor_membership",
                stale_or_conflicting,
            )?;
            assert_eq!(rejected["ok"], false, "{rejected}");
        }
        let revoked = client
            .query_one(
                "select active, fence_generation from kernel_actor_membership where principal_name=$1 and app_id=$2 and customer_id=$3 and actor_id=$4 and role=$5",
                &[&principal, &APP_ID, &CUSTOMER_ID, &"actor_a", &"reviewer"],
            )
            .map_err(|error| format!("read fenced membership after stale writes: {error}"))?;
        assert!(!revoked.get::<_, bool>("active"));
        assert_eq!(revoked.get::<_, i64>("fence_generation"), 2);
        assert_ok(&call(
            &mut client,
            "kernel_bind_actor_membership",
            json!({"principal_name":principal,"app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"actor_a","actor_kind":"human","role":"reviewer","active":false,"fence_generation":2}),
        )?);
        assert_ok(&call(
            &mut client,
            "kernel_bind_actor_membership",
            json!({"principal_name":principal,"app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"actor_a","actor_kind":"human","role":"reviewer","active":true,"fence_generation":3}),
        )?);
        let conflicting_retry = call(
            &mut client,
            "kernel_bind_actor_membership",
            json!({"principal_name":principal,"app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"actor_a","actor_kind":"human","role":"reviewer","active":false,"fence_generation":3}),
        )?;
        assert_eq!(conflicting_retry["ok"], false, "{conflicting_retry}");

        let mut runtime_config = Config::from_str(&database_url)
            .map_err(|error| format!("parse restricted runtime URL: {error}"))?;
        runtime_config.user(&principal).password(password);
        let mut runtime = runtime_config
            .connect(NoTls)
            .map_err(|error| format!("connect restricted LOGIN principal: {error}"))?;
        runtime
            .batch_execute(&format!(
                "set search_path to \"{schema}\"; set kernel.actor_id = 'actor_a'"
            ))
            .map_err(|error| format!("bind trusted actor for restricted principal: {error}"))?;
        let bound_actor: String = runtime
            .query_one("select current_setting('kernel.actor_id', true)", &[])
            .map_err(|error| error.to_string())?
            .get(0);
        assert_eq!(bound_actor, "actor_a");

        assert_ok(&call(
            &mut client,
            "kernel_bind_actor_membership",
            json!({"principal_name":principal,"app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"actor_a","actor_kind":"human","role":"reviewer","active":false,"fence_generation":4}),
        )?);
        assert_ok(&call(
            &mut client,
            "kernel_bind_actor_membership",
            json!({"principal_name":principal,"app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"actor_a","actor_kind":"human","role":"create_only","active":true}),
        )?);
        let backdated_existing = json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_revision_id":"1","actor_id":"actor_a","source_kind":"fixture","idempotency_key":"backdated-existing-create-only","mode":"mainline","writes":[{"model_id":"work_item","record_key":{"type":"record_id","value":"00000000-0000-0000-0000-000000000002"},"effective_start":"2025-12-31","values":{"owner":{"type":"text","value":"actor_a"},"summary":{"type":"text","value":"must remain update"}}}]});
        runtime
            .batch_execute("begin; select set_config('kernel.actor_id', 'actor_a', true)")
            .map_err(|error| error.to_string())?;
        let create_only_backdate =
            call(&mut runtime, "kernel_apply_change_set", backdated_existing)?;
        runtime
            .batch_execute("commit")
            .map_err(|error| error.to_string())?;
        assert_eq!(create_only_backdate["ok"], false, "{create_only_backdate}");
        assert_eq!(
            create_only_backdate["error"]["code"], "authorization_denied",
            "{create_only_backdate}"
        );

        assert_ok(&call(
            &mut client,
            "kernel_bind_actor_membership",
            json!({"principal_name":principal,"app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"actor_a","actor_kind":"human","role":"create_only","active":false}),
        )?);
        assert_ok(&call(
            &mut client,
            "kernel_bind_actor_membership",
            json!({"principal_name":principal,"app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"actor_a","actor_kind":"human","role":"update_all","active":true}),
        )?);
        let update_all_backdate = json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_revision_id":"1","actor_id":"actor_a","source_kind":"fixture","idempotency_key":"backdated-existing-update-all","mode":"mainline","writes":[{"model_id":"work_item","record_key":{"type":"record_id","value":"00000000-0000-0000-0000-000000000002"},"effective_start":"2025-12-31","values":{"owner":{"type":"text","value":"actor_a"},"summary":{"type":"text","value":"authorized update"}}}]});
        runtime
            .batch_execute("begin; select set_config('kernel.actor_id', 'actor_a', true)")
            .map_err(|error| error.to_string())?;
        let update_all_result = call(&mut runtime, "kernel_apply_change_set", update_all_backdate)?;
        runtime
            .batch_execute("commit")
            .map_err(|error| error.to_string())?;
        assert_ok(&update_all_result);
        assert_ok(&call(
            &mut client,
            "kernel_bind_actor_membership",
            json!({"principal_name":principal,"app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"actor_a","actor_kind":"human","role":"update_all","active":false}),
        )?);
        assert_ok(&call(
            &mut client,
            "kernel_bind_actor_membership",
            json!({"principal_name":principal,"app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"actor_a","actor_kind":"human","role":"reviewer","active":true,"fence_generation":5}),
        )?);

        let created = "00000000-0000-0000-0000-000000000101";
        let create = json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_revision_id":"1","actor_id":"actor_a","source_kind":"fixture","idempotency_key":"create-a","mode":"mainline","writes":[{"model_id":"work_item","new_record_id":created,"effective_start":"2026-01-02","values":{"owner":{"type":"text","value":"actor_a"},"summary":{"type":"text","value":"created"}}}]});
        runtime
            .batch_execute("begin; select set_config('kernel.actor_id', 'actor_a', true)")
            .map_err(|error| error.to_string())?;
        let created_result = call(&mut runtime, "kernel_apply_change_set", create.clone())?;
        runtime
            .batch_execute("commit")
            .map_err(|error| error.to_string())?;
        assert_eq!(
            created_result["ok"], true,
            "create must authorize: {created_result}"
        );
        let owner_transfer_with_stale_version = json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_revision_id":"1","actor_id":"actor_a","source_kind":"fixture","idempotency_key":"owner-transfer","mode":"mainline","writes":[{"model_id":"work_item","record_key":{"type":"record_id","value":created},"effective_start":"2026-01-03","expected_version_id":"00000000-0000-0000-0000-000000000000","values":{"owner":{"type":"text","value":"actor_b"}}}]});
        runtime
            .batch_execute("begin; select set_config('kernel.actor_id', 'actor_a', true)")
            .map_err(|error| error.to_string())?;
        let denied_transfer = call(
            &mut runtime,
            "kernel_apply_change_set",
            owner_transfer_with_stale_version,
        )?;
        runtime
            .batch_execute("commit")
            .map_err(|error| error.to_string())?;
        assert_eq!(
            denied_transfer["error"]["code"], "authorization_denied",
            "new owner denial must precede version guard: {denied_transfer}"
        );
        runtime
            .batch_execute("begin; select set_config('kernel.actor_id', 'actor_a', true)")
            .map_err(|error| error.to_string())?;
        let replay = call(&mut runtime, "kernel_apply_change_set", create.clone())?;
        runtime
            .batch_execute("commit")
            .map_err(|error| error.to_string())?;
        assert_eq!(replay["ok"], true, "replay must authorize: {replay}");
        assert_eq!(replay["data"], created_result["data"]);

        let update_owned = json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_revision_id":"1","actor_id":"actor_a","source_kind":"fixture","idempotency_key":"update-owned","mode":"mainline","writes":[{"model_id":"work_item","record_key":{"type":"record_id","value":"00000000-0000-0000-0000-000000000001"},"effective_start":"2026-01-02","values":{"summary":{"type":"text","value":"updated"}}}]});
        let clear_owned = json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_revision_id":"1","actor_id":"actor_a","source_kind":"fixture","idempotency_key":"clear-owned","mode":"mainline","writes":[{"model_id":"work_item","record_key":{"type":"record_id","value":"00000000-0000-0000-0000-000000000001"},"effective_start":"2026-01-03","clear_fields":["summary"]}]});
        let delete_owned = json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_revision_id":"1","actor_id":"actor_a","source_kind":"fixture","idempotency_key":"delete-owned","mode":"mainline","writes":[{"model_id":"work_item","record_key":{"type":"record_id","value":"00000000-0000-0000-0000-000000000001"},"effective_start":"2026-01-04","tombstones_record":true}]});
        for request in [update_owned, clear_owned, delete_owned] {
            runtime
                .batch_execute("begin; select set_config('kernel.actor_id', 'actor_a', true)")
                .map_err(|error| error.to_string())?;
            let result = call(&mut runtime, "kernel_apply_change_set", request)?;
            runtime
                .batch_execute("commit")
                .map_err(|error| error.to_string())?;
            assert_ok(&result);
        }

        let mixed_record = "00000000-0000-0000-0000-000000000102";
        let mixed = json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_revision_id":"1","actor_id":"actor_a","source_kind":"fixture","idempotency_key":"mixed-rollback","mode":"mainline","writes":[
          {"model_id":"work_item","new_record_id":mixed_record,"effective_start":"2026-01-05","values":{"owner":{"type":"text","value":"actor_a"},"summary":{"type":"text","value":"must rollback"}}},
          {"model_id":"work_item","record_key":{"type":"record_id","value":"00000000-0000-0000-0000-000000000002"},"effective_start":"2026-01-05","values":{"summary":{"type":"text","value":"forbidden"}}}
        ]});
        runtime
            .batch_execute("begin; select set_config('kernel.actor_id', 'actor_a', true)")
            .map_err(|error| error.to_string())?;
        let mixed_result = call(&mut runtime, "kernel_apply_change_set", mixed)?;
        runtime
            .batch_execute("commit")
            .map_err(|error| error.to_string())?;
        assert_eq!(mixed_result["ok"], false, "{mixed_result}");
        let mixed_record_id = Uuid::parse_str(mixed_record).map_err(|error| error.to_string())?;
        let mixed_rows: i64 = client
            .query_one(
                "select count(*) from work_item_record where id=$1::uuid",
                &[&mixed_record_id],
            )
            .map_err(|error| error.to_string())?
            .get(0);
        assert_eq!(mixed_rows, 0, "unauthorized mixed batch must roll back");

        assert_ok(&call(
            &mut client,
            "kernel_bind_actor_membership",
            json!({"principal_name":principal,"app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"actor_a","actor_kind":"human","role":"reviewer","active":false,"fence_generation":6}),
        )?);
        assert_ok(&call(
            &mut client,
            "kernel_bind_actor_membership",
            json!({"principal_name":principal,"app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"actor_a","actor_kind":"human","role":"summary_only","active":true}),
        )?);
        runtime
            .batch_execute("begin; select set_config('kernel.actor_id', 'actor_a', true)")
            .map_err(|error| error.to_string())?;
        let changed_role_replay = call(&mut runtime, "kernel_apply_change_set", create.clone())?;
        runtime
            .batch_execute("commit")
            .map_err(|error| error.to_string())?;
        assert_eq!(changed_role_replay["ok"], false, "{changed_role_replay}");
        assert_eq!(
            changed_role_replay["error"]["code"], "authorization_denied",
            "{changed_role_replay}"
        );

        assert_ok(&call(
            &mut client,
            "kernel_bind_actor_membership",
            json!({"principal_name":principal,"app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"actor_a","actor_kind":"human","role":"summary_only","active":false}),
        )?);
        runtime
            .batch_execute("begin; select set_config('kernel.actor_id', 'actor_a', true)")
            .map_err(|error| error.to_string())?;
        let revoked_replay = call(&mut runtime, "kernel_apply_change_set", create)?;
        runtime
            .batch_execute("commit")
            .map_err(|error| error.to_string())?;
        assert_eq!(revoked_replay["ok"], false, "{revoked_replay}");
        assert_eq!(
            revoked_replay["error"]["code"], "authorization_denied",
            "{revoked_replay}"
        );

        // Protected scopes require the exact Gateway-observed role and journal fence
        // inside the real runtime operation transaction, even if another role is active.
        assert_ok(&call(
            &mut client,
            "kernel_bind_principal_scope",
            json!({
                "principal_name": principal, "capability":"runtime", "app_id":APP_ID,
                "customer_id":CUSTOMER_ID, "actor_binding_required":true
            }),
        )?);
        assert_ok(&call(
            &mut client,
            "kernel_bind_actor_membership",
            json!({
                "principal_name":principal,"app_id":APP_ID,"customer_id":CUSTOMER_ID,
                "actor_id":"actor_a","actor_kind":"human","role":"reviewer","active":true,"fence_generation":7
            }),
        )?);
        let locking_catalog = client.query("select proname,provolatile::text,proparallel::text from pg_proc where pronamespace=current_schema()::regnamespace and proname in ('kernel_principal_scope_authorized','kernel_authorize_scope','kernel_policy_request_actor') order by proname", &[]).map_err(|e|e.to_string())?;
        assert_eq!(locking_catalog.len(), 3);
        for function in locking_catalog {
            assert_eq!(function.get::<_, String>("provolatile"), "v");
            assert_eq!(function.get::<_, String>("proparallel"), "u");
        }
        let binding_request = json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"actor_a","role":"reviewer"});
        let binding = call(
            &mut runtime,
            "kernel_read_actor_binding",
            binding_request.clone(),
        )?;
        assert_eq!(
            binding["data"],
            json!({"appId":APP_ID,"organizationId":CUSTOMER_ID,"actorId":"actor_a","role":"reviewer","active":true,"fenceGeneration":7})
        );
        let unknown = call(
            &mut runtime,
            "kernel_read_actor_binding",
            json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"unknown","role":"reviewer"}),
        )?;
        assert!(unknown["data"].is_null());
        for request in [
            json!({"app_id":"different_app","customer_id":CUSTOMER_ID,"actor_id":"actor_a","role":"reviewer"}),
            json!({"app_id":APP_ID,"customer_id":"different_org","actor_id":"actor_a","role":"reviewer"}),
        ] {
            assert_eq!(
                call(&mut runtime, "kernel_read_actor_binding", request)?["ok"],
                false
            );
        }
        runtime.batch_execute("set kernel.actor_id='actor_a'; reset kernel.actor_role; reset kernel.actor_fence_generation").map_err(|e|e.to_string())?;
        let read_request = json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_version":VERSION,"model_id":"work_item","as_of":"2026-01-01","select":["summary"]});
        for settings in [
            "reset kernel.actor_role; reset kernel.actor_fence_generation",
            "set kernel.actor_role='reviewer'; set kernel.actor_fence_generation='6'",
            "set kernel.actor_role='summary_only'; set kernel.actor_fence_generation='7'",
        ] {
            runtime.batch_execute(settings).map_err(|e| e.to_string())?;
            let denied = call(&mut runtime, "kernel_data_query", read_request.clone())?;
            assert_eq!(denied["error"]["code"], "authorization_denied", "{denied}");
            // This entrypoint uses shared principal scope without evaluating model policy.
            let denied_without_policy = call(
                &mut runtime,
                "kernel_read_runtime_release_observability",
                json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID}),
            )?;
            assert_eq!(
                denied_without_policy["error"]["code"], "authorization_denied",
                "{denied_without_policy}"
            );
            let denied_write = call(
                &mut runtime,
                "kernel_apply_change_set",
                json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_revision_id":"1","actor_id":"actor_a","source_kind":"fixture","idempotency_key":"stale-fence-write","mode":"mainline","writes":[{"model_id":"work_item","record_key":{"type":"record_id","value":"00000000-0000-0000-0000-000000000001"},"effective_start":"2026-01-02","values":{"summary":{"type":"text","value":"denied"}}}]}),
            )?;
            assert_eq!(
                denied_write["error"]["code"], "authorization_denied",
                "{denied_write}"
            );
        }
        // A null requested actor must not widen a principal bound to another actor.
        assert_ok(&call(
            &mut client,
            "kernel_bind_principal_scope",
            json!({"principal_name":principal,"capability":"runtime","app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"bound_other_actor","actor_binding_required":true}),
        )?);
        runtime.batch_execute("set kernel.actor_id='actor_a'; set kernel.actor_role='reviewer'; set kernel.actor_fence_generation='7'").map_err(|e|e.to_string())?;
        let wrong_bound_actor = call(
            &mut runtime,
            "kernel_read_runtime_release_observability",
            json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID}),
        )?;
        assert_eq!(
            wrong_bound_actor["error"]["code"], "authorization_denied",
            "{wrong_bound_actor}"
        );
        assert_ok(&call(
            &mut client,
            "kernel_bind_principal_scope",
            json!({"principal_name":principal,"capability":"runtime","app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":null,"actor_binding_required":true}),
        )?);
        runtime
            .batch_execute(
                "set kernel.actor_role='reviewer'; set kernel.actor_fence_generation='7'",
            )
            .map_err(|e| e.to_string())?;
        assert_ok(&call(
            &mut runtime,
            "kernel_data_query",
            read_request.clone(),
        )?);
        assert!(runtime
            .batch_execute("update kernel_actor_membership set active=true,fence_generation=99")
            .is_err());
        assert!(runtime
            .batch_execute("update kernel_principal_scope set actor_binding_required=false")
            .is_err());
        assert!(call(&mut runtime,"kernel_bind_actor_membership",json!({"principal_name":principal,"app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"actor_a","actor_kind":"human","role":"reviewer","active":true,"fence_generation":99})).is_err());
        // Supply the trusted test request's immutable nonce/body admission before the
        // protected mutation; this fixture diagnoses SQL fences, not HTTP signatures.
        let admitted_write = json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_revision_id":"1","actor_id":"actor_a","source_kind":"fixture","idempotency_key":"binding-locked-commit","mode":"mainline","writes":[{"model_id":"work_item","record_key":{"type":"record_id","value":"00000000-0000-0000-0000-000000000001"},"effective_start":"2026-01-02","values":{"summary":{"type":"text","value":"before revoke"}}}]});
        let database_now: i64 = client
            .query_one(
                "select floor(extract(epoch from clock_timestamp()))::bigint",
                &[],
            )
            .map_err(|e| e.to_string())?
            .get(0);
        let descriptor = json!({"jti":"binding-locked-http-request","issuer":"https://gateway.fixture","audience":APP_ID,"method":"POST","target":"/action","bodySha256":"A".repeat(43),"payloadSha256":"A".repeat(43),"expiresAt":database_now+240});
        let mut expired_descriptor = descriptor.clone();
        expired_descriptor["jti"] = json!("owned-expiry-proof");
        expired_descriptor["expiresAt"] = json!(database_now - 1);
        let expired_admission = json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"actor_a","role":"reviewer","fence_generation":7,"http_request":expired_descriptor});
        let denied_expired = call(
            &mut runtime,
            "kernel_admit_http_request",
            expired_admission.clone(),
        )?;
        assert_eq!(
            denied_expired["error"]["details"][0]["code"],
            "http_request_expired"
        );
        // Only synthetic state in this owned isolated schema is inserted/discarded.
        // The same expired descriptor remains denied with and without retained rows.
        client.execute("insert into kernel_http_request_admission(principal_name,app_id,customer_id,jti,identity,expires_at) values($1::name,$2,$3,'owned-expiry-proof','{}',$4)",&[&principal,&APP_ID,&CUSTOMER_ID,&(database_now-1)]).map_err(|e|e.to_string())?;
        assert_eq!(
            call(
                &mut runtime,
                "kernel_admit_http_request",
                expired_admission.clone()
            )?["error"]["details"][0]["code"],
            "http_request_expired"
        );
        client.execute("delete from kernel_http_request_admission where principal_name=$1::name and app_id=$2 and customer_id=$3 and jti='owned-expiry-proof'", &[&principal,&APP_ID,&CUSTOMER_ID]).map_err(|e|e.to_string())?;
        assert_eq!(
            call(&mut runtime, "kernel_admit_http_request", expired_admission)?["error"]["details"]
                [0]["code"],
            "http_request_expired"
        );
        client.execute("insert into kernel_http_request_admission(principal_name,app_id,customer_id,jti,identity,expires_at) values($1::name,$2,$3,'owned-prune-proof','{}',$4)",&[&principal,&APP_ID,&CUSTOMER_ID,&(database_now-1)]).map_err(|e|e.to_string())?;
        client.execute("insert into kernel_http_request_consumption(principal_name,app_id,customer_id,jti,owner_xid) values($1::name,$2,$3,'owned-prune-proof',pg_current_xact_id())", &[&principal,&APP_ID,&CUSTOMER_ID]).map_err(|e|e.to_string())?;
        assert!(
            runtime
                .query_one("select kernel_prune_expired_http_requests()", &[])
                .is_err(),
            "runtime cannot prune private nonce records"
        );
        client.batch_execute("begin").map_err(|e| e.to_string())?;
        client.query_one("select jti from kernel_http_request_consumption where jti='owned-prune-proof' for update",&[]).map_err(|e|e.to_string())?;
        let mut maintenance = connect_postgres(&database_url).map_err(|e| e.to_string())?;
        maintenance
            .batch_execute(&format!("set search_path to \"{schema}\""))
            .map_err(|e| e.to_string())?;
        let skipped: i64 = maintenance
            .query_one("select kernel_prune_expired_http_requests()", &[])
            .map_err(|e| e.to_string())?
            .get(0);
        assert_eq!(
            skipped, 0,
            "active consumption lock must preserve all nonce state"
        );
        client.batch_execute("commit").map_err(|e| e.to_string())?;
        let removed: i64 = maintenance
            .query_one("select kernel_prune_expired_http_requests()", &[])
            .map_err(|e| e.to_string())?
            .get(0);
        assert_eq!(
            removed, 1,
            "only proven expired owned nonce is removed after lock release"
        );
        let mut pruned_descriptor = expired_descriptor.clone();
        pruned_descriptor["jti"] = json!("owned-prune-proof");
        let denied_after_prune = call(
            &mut runtime,
            "kernel_admit_http_request",
            json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"actor_a","role":"reviewer","fence_generation":7,"http_request":pruned_descriptor}),
        )?;
        assert_eq!(
            denied_after_prune["error"]["details"][0]["code"],
            "http_request_expired"
        );

        // Authenticated admission performs only same-login/app/customer expiry cleanup.
        // These are synthetic rows in the owned disposable schema, never provider/customer state.
        for (nonce, login, app, customer, expiry) in [
            (
                "auto-expired",
                principal.as_str(),
                APP_ID,
                CUSTOMER_ID,
                Some(database_now - 1),
            ),
            (
                "auto-locked-consumption",
                principal.as_str(),
                APP_ID,
                CUSTOMER_ID,
                Some(database_now - 1),
            ),
            (
                "auto-locked-admission",
                principal.as_str(),
                APP_ID,
                CUSTOMER_ID,
                Some(database_now - 1),
            ),
            (
                "auto-other-login",
                "fixture_other_login",
                APP_ID,
                CUSTOMER_ID,
                Some(database_now - 1),
            ),
            (
                "auto-other-app",
                principal.as_str(),
                "other_app",
                CUSTOMER_ID,
                Some(database_now - 1),
            ),
            (
                "auto-other-customer",
                principal.as_str(),
                APP_ID,
                "other_customer",
                Some(database_now - 1),
            ),
            (
                "auto-live",
                principal.as_str(),
                APP_ID,
                CUSTOMER_ID,
                Some(database_now + 240),
            ),
            ("auto-legacy", principal.as_str(), APP_ID, CUSTOMER_ID, None),
        ] {
            client.execute("insert into kernel_http_request_admission(principal_name,app_id,customer_id,jti,identity,expires_at) values($1::name,$2,$3,$4,'{}',$5)", &[&login,&app,&customer,&nonce,&expiry]).map_err(|e|e.to_string())?;
        }
        for nonce in ["auto-expired", "auto-locked-consumption"] {
            client.execute("insert into kernel_http_request_consumption(principal_name,app_id,customer_id,jti,owner_xid) values($1::name,$2,$3,$4,pg_current_xact_id())", &[&principal,&APP_ID,&CUSTOMER_ID,&nonce]).map_err(|e|e.to_string())?;
        }
        client.execute("insert into kernel_http_operation_admission(principal_name,app_id,customer_id,jti,sequence,operation,fingerprint) values($1::name,$2,$3,'auto-expired',1,'kernel_apply_change_set','fixture')", &[&principal,&APP_ID,&CUSTOMER_ID]).map_err(|e|e.to_string())?;
        client.execute("insert into kernel_http_operation_receipt(principal_name,app_id,customer_id,jti,sequence) values($1::name,$2,$3,'auto-expired',1)", &[&principal,&APP_ID,&CUSTOMER_ID]).map_err(|e|e.to_string())?;
        assert!(
            runtime
                .query_one(
                    "select kernel_prune_expired_http_requests($1,$2)",
                    &[&APP_ID, &CUSTOMER_ID]
                )
                .is_err(),
            "runtime cannot call scoped private cleanup"
        );
        let denied_scope = call(
            &mut runtime,
            "kernel_admit_http_request",
            json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"unknown","role":"reviewer","fence_generation":7,"http_request":descriptor}),
        )?;
        assert_eq!(denied_scope["ok"], false);
        assert!(client.query_one("select exists(select 1 from kernel_http_request_admission where jti='auto-expired')", &[]).map_err(|e|e.to_string())?.get::<_,bool>(0),"denied admission cannot trigger maintenance");
        client.batch_execute("begin").map_err(|e| e.to_string())?;
        client.query_one("select jti from kernel_http_request_consumption where jti='auto-locked-consumption' for update", &[]).map_err(|e|e.to_string())?;
        client.query_one("select jti from kernel_http_request_admission where jti='auto-locked-admission' for update", &[]).map_err(|e|e.to_string())?;
        runtime
            .batch_execute("set statement_timeout='2000ms'")
            .map_err(|e| e.to_string())?;
        let mut cleanup_descriptor = descriptor.clone();
        cleanup_descriptor["jti"] = json!("authenticated-cleanup-one");
        assert_ok(&call(
            &mut runtime,
            "kernel_admit_http_request",
            json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"actor_a","role":"reviewer","fence_generation":7,"http_request":cleanup_descriptor}),
        )?);
        let kept:Vec<String>=client.query("select jti from kernel_http_request_admission where jti like 'auto-%' order by jti", &[]).map_err(|e|e.to_string())?.iter().map(|row|row.get(0)).collect();
        assert_eq!(
            kept,
            vec![
                "auto-legacy",
                "auto-live",
                "auto-locked-admission",
                "auto-locked-consumption",
                "auto-other-app",
                "auto-other-customer",
                "auto-other-login"
            ]
        );
        for table in [
            "kernel_http_request_consumption",
            "kernel_http_operation_admission",
            "kernel_http_operation_receipt",
        ] {
            assert_eq!(
                scalar(
                    &mut client,
                    &format!("select count(*)::text from {table} where jti='auto-expired'")
                )?,
                "0"
            );
        }
        client.batch_execute("commit").map_err(|e| e.to_string())?;
        cleanup_descriptor["jti"] = json!("authenticated-cleanup-two");
        assert_ok(&call(
            &mut runtime,
            "kernel_admit_http_request",
            json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"actor_a","role":"reviewer","fence_generation":7,"http_request":cleanup_descriptor}),
        )?);
        assert_eq!(scalar(&mut client,"select count(*)::text from kernel_http_request_admission where jti like 'auto-locked-%'")?,"0");
        assert_eq!(scalar(&mut client,"select count(*)::text from pg_indexes where schemaname=current_schema() and indexname='kernel_http_request_admission_expiry_scope_idx'")?,"1");
        runtime
            .batch_execute("set statement_timeout=0")
            .map_err(|e| e.to_string())?;

        // Real actor-lock wait proves the second native-clock expiry check runs before cleanup/admission.
        client
            .batch_execute(
                "begin; select 1 from kernel_actor_membership where actor_id='actor_a' for update",
            )
            .map_err(|e| e.to_string())?;
        let expiry_config = runtime_config.clone();
        let expiry_schema = schema.clone();
        let expiry_application = format!("admission_expiry_{}", Uuid::new_v4().simple());
        let thread_application = expiry_application.clone();
        let mut waiting_descriptor = descriptor.clone();
        waiting_descriptor["jti"] = json!("expires-on-actor-lock");
        waiting_descriptor["expiresAt"] = json!(client
            .query_one(
                "select floor(extract(epoch from clock_timestamp()))::bigint+2",
                &[]
            )
            .map_err(|e| e.to_string())?
            .get::<_, i64>(0));
        let waiting = std::thread::spawn(move || -> Result<Value, String> {
            let mut connection = expiry_config.connect(NoTls).map_err(|e| e.to_string())?;
            connection
                .batch_execute(&format!(
                    "set search_path to \"{expiry_schema}\";set statement_timeout='10000ms'"
                ))
                .map_err(|e| e.to_string())?;
            connection
                .execute(
                    "select set_config('application_name',$1,false)",
                    &[&thread_application],
                )
                .map_err(|e| e.to_string())?;
            connection.execute("select set_config('kernel.app_id',$1,false),set_config('kernel.customer_id',$2,false),set_config('kernel.actor_id','actor_a',false)",&[&APP_ID,&CUSTOMER_ID]).map_err(|e|e.to_string())?;
            call(
                &mut connection,
                "kernel_admit_http_request",
                json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"actor_a","role":"reviewer","fence_generation":7,"http_request":waiting_descriptor}),
            )
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let mut actor_blocked = false;
        while std::time::Instant::now() < deadline {
            client
                .batch_execute("select pg_stat_clear_snapshot()")
                .map_err(|e| e.to_string())?;
            actor_blocked=client.query_one("select exists(select 1 from pg_stat_activity where application_name=$1 and wait_event_type='Lock')",&[&expiry_application]).map_err(|e|e.to_string())?.get(0);
            if actor_blocked {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        client
            .batch_execute("select pg_sleep(3);commit")
            .map_err(|e| e.to_string())?;
        let expired_after_wait = waiting
            .join()
            .map_err(|_| "expiry admission thread panicked".to_owned())??;
        assert!(
            actor_blocked,
            "admission must actually wait on actor authority: {expired_after_wait}"
        );
        assert_eq!(
            expired_after_wait["error"]["details"][0]["code"],
            "http_request_expired"
        );
        assert_eq!(scalar(&mut client,"select count(*)::text from kernel_http_request_admission where jti='expires-on-actor-lock'")?,"0");

        assert_ok(&call(
            &mut runtime,
            "kernel_admit_http_operation",
            json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"actor_a","role":"reviewer","fence_generation":7,"http_request":descriptor,"operation":"kernel_apply_change_set","sequence":1,"payload":admitted_write}),
        )?);
        runtime.execute("select set_config('kernel.http_jti',$1,false),set_config('kernel.http_descriptor',$2,false),set_config('kernel.http_sequence','1',false)", &[&"binding-locked-http-request",&descriptor.to_string()]).map_err(|e|e.to_string())?;
        runtime.batch_execute("begin").map_err(|e| e.to_string())?;
        let accepted_write = call(
            &mut runtime,
            "kernel_apply_change_set",
            json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_revision_id":"1","actor_id":"actor_a","source_kind":"fixture","idempotency_key":"binding-locked-commit","mode":"mainline","writes":[{"model_id":"work_item","record_key":{"type":"record_id","value":"00000000-0000-0000-0000-000000000001"},"effective_start":"2026-01-02","values":{"summary":{"type":"text","value":"before revoke"}}}]}),
        )?;
        assert_ok(&accepted_write);
        let revoke_url = database_url.clone();
        let revoke_schema = schema.clone();
        let revoke_principal = principal.clone();
        let application_name = format!("binding_revoke_{}", Uuid::new_v4().simple());
        let revoke_application = application_name.clone();
        let revoker = std::thread::spawn(move || -> Result<Value, String> {
            let mut connection = connect_postgres(&revoke_url).map_err(|e| e.to_string())?;
            connection
                .batch_execute(&format!(
                    "set search_path to \"{revoke_schema}\"; set lock_timeout='5000ms'"
                ))
                .map_err(|e| e.to_string())?;
            connection
                .execute(
                    "select set_config('application_name',$1,false)",
                    &[&revoke_application],
                )
                .map_err(|e| e.to_string())?;
            call(
                &mut connection,
                "kernel_bind_actor_membership",
                json!({"principal_name":revoke_principal,"app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"actor_a","actor_kind":"human","role":"reviewer","active":false,"fence_generation":8}),
            )
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        let mut blocked = false;
        while std::time::Instant::now() < deadline {
            blocked = client.query_one("select exists(select 1 from pg_stat_activity where application_name=$1 and wait_event_type='Lock')", &[&application_name]).map_err(|e|e.to_string())?.get(0);
            if blocked {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_ok(&call(
            &mut runtime,
            "kernel_finish_http_request",
            json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"operation_count":1}),
        )?);
        runtime.batch_execute("commit").map_err(|e| e.to_string())?;
        let revoked = revoker
            .join()
            .map_err(|_| "revocation thread panicked".to_string())??;
        assert!(
            blocked,
            "accepted mutation must hold its binding row until commit"
        );
        assert_ok(&revoked);
        let inactive = call(&mut runtime, "kernel_read_actor_binding", binding_request)?;
        assert_eq!(inactive["data"]["active"], false);
        assert_eq!(inactive["data"]["fenceGeneration"], 8);
        let denied = call(&mut runtime, "kernel_data_query", read_request)?;
        assert_eq!(denied["error"]["code"], "authorization_denied", "{denied}");

        runtime
            .batch_execute("reset kernel.actor_id")
            .map_err(|error| format!("clear actor binding: {error}"))?;
        let membership_denied = call(
            &mut runtime,
            "kernel_data_query",
            json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_version":VERSION,"model_id":"work_item","as_of":"2026-01-01","select":["summary"]}),
        )?;
        assert_eq!(membership_denied["ok"], false, "{membership_denied}");
        assert_eq!(
            membership_denied["error"]["code"], "authorization_denied",
            "{membership_denied}"
        );

        Ok(())
    })();

    match result {
        Ok(()) => cleanup
            .finish()
            .expect("remove isolated authorization fixture"),
        Err(error) => {
            if let Err(cleanup_error) = cleanup.finish() {
                eprintln!("authorization fixture cleanup after test failure: {cleanup_error}");
            }
            panic!("policy query behavior: {error}");
        }
    }
}

fn policy_manifest() -> Value {
    json!({
      "app_id":APP_ID,"customer_id":CUSTOMER_ID,"version":VERSION,
      "models":[{"id":"work_item","kind":"entity","label":"Work item","fields":[
        {"id":"owner","label":"Owner","type":"text","required":true},
        {"id":"summary","label":"Summary","type":"text"}
      ]}],
      "authorization":{"roles":[{"id":"reviewer"},{"id":"summary_only"},{"id":"create_only"},{"id":"update_all"}],"grants":[{
        "role":"reviewer","model":"work_item","operations":["read","create","update","delete"],
        "write_fields":["owner","summary"],
        "read_fields":["summary","$id","$externalKey","$version","$effectiveStart","$effectiveEnd","$metadata"],
        "record":{"kind":"actor_equals_field","field":"owner"}
      },{
        "role":"summary_only","model":"work_item","operations":["create"],
        "write_fields":["summary"],
        "record":{"kind":"actor_equals_field","field":"owner"}
      },{
        "role":"create_only","model":"work_item","operations":["create"],
        "write_fields":["owner","summary"],
        "record":{"kind":"actor_equals_field","field":"owner"}
      },{
        "role":"update_all","model":"work_item","operations":["update"],
        "write_fields":["owner","summary"],
        "record":{"kind":"all"}
      }]}
    })
}

fn call(client: &mut postgres::Client, function: &str, request: Value) -> Result<Value, String> {
    client
        .query_one(&format!("select {function}($1::jsonb)"), &[&request])
        .map(|row| row.get(0))
        .map_err(|error| format!("{function}: {error:?}"))
}

fn scalar(client: &mut postgres::Client, sql: &str) -> Result<String, String> {
    client
        .query_one(sql, &[])
        .map(|row| row.get(0))
        .map_err(|error| error.to_string())
}

fn assert_ok(value: &Value) {
    assert_eq!(value["ok"], true, "{value}");
}

fn test_database_url() -> Option<String> {
    match env::var("KERNEL_TEST_DATABASE_URL") {
        Ok(database_url) => Some(database_url),
        Err(env::VarError::NotPresent) => {
            eprintln!("skipping PostgreSQL test: KERNEL_TEST_DATABASE_URL is absent");
            None
        }
        Err(error) => panic!("read KERNEL_TEST_DATABASE_URL: {error}"),
    }
}
