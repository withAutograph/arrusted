use std::{env, str::FromStr};

use kernel::connect_postgres;
use postgres::{Config, NoTls};
use schema_compiler::{
    compile_manifest_json, compile_sql_artifact_manifest, render_sql_artifact_bundle,
};
use serde_json::{json, Value};
use uuid::Uuid;

const APP_ID: &str = "policy_write_relation_fixture";
const CUSTOMER_ID: &str = "tenant_a";
const VERSION: &str = "policy-write-relation-v1";
const EXISTING_TARGET: &str = "00000000-0000-0000-0000-000000000001";
const SECOND_TARGET: &str = "00000000-0000-0000-0000-000000000002";
const PENDING_TARGET: &str = "00000000-0000-0000-0000-000000000020";
const PENDING_CHILD: &str = "00000000-0000-0000-0000-000000000021";
const ROLLBACK_SIBLING: &str = "00000000-0000-0000-0000-000000000030";
const ROLLBACK_DENIED: &str = "00000000-0000-0000-0000-000000000031";
const ID_CHILD: &str = "00000000-0000-0000-0000-000000000040";
const EXTERNAL_CHILD: &str = "00000000-0000-0000-0000-000000000041";
const REPLAY_CHILD: &str = "00000000-0000-0000-0000-000000000050";
const CUSTOM_REPLAY_CHILD: &str = "00000000-0000-0000-0000-000000000051";
const MANY_REPLAY_DEPARTMENT: &str = "00000000-0000-0000-0000-000000000052";
const UPDATE_CHILD: &str = "00000000-0000-0000-0000-000000000060";

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
fn policy_write_relations_require_live_target_read_grants_and_preserve_atomicity() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let compiled =
        compile_manifest_json(&policy_manifest().to_string()).expect("compile policy manifest");
    let manifest = compile_sql_artifact_manifest(&compiled).expect("compile SQL policy bundle");
    let mut client = connect_postgres(&database_url).expect("connect PostgreSQL");
    let schema = format!("kernel_policy_write_relation_{}", Uuid::new_v4().simple());
    let principal = format!("policy_write_relation_runtime_{}", Uuid::new_v4().simple());
    let password = format!(
        "policy-write-relation-runtime-test-{}",
        Uuid::new_v4().simple()
    );
    client
        .batch_execute(&format!(
            "create schema \"{schema}\"; set search_path to \"{schema}\""
        ))
        .expect("create isolated policy schema");

    let mut cleanup = AuthorizationFixtureCleanup::new(&database_url, &schema, &principal);

    let result = (|| -> Result<(), String> {
        client
            .batch_execute(&render_sql_artifact_bundle(&manifest))
            .map_err(|error| format!("install policy bundle: {error}"))?;
        let runtime_role = scalar(
            &mut client,
            "select kernel_installer_capability_role('runtime')",
        )?;
        client
            .batch_execute(&format!("grant \"{runtime_role}\" to session_user"))
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
                insert into company_record (id,app_id,customer_id,external_key) values
                  ('{EXISTING_TARGET}','{APP_ID}','{CUSTOMER_ID}','existing-target'),
                  ('{SECOND_TARGET}','{APP_ID}','{CUSTOMER_ID}','second-target');
                insert into company_version (
                  id,record_id,app_id,customer_id,stage,effective_start,change_set_id,applied_at,owner,name
                ) values
                  ('00000000-0000-0000-0000-000000000011','{EXISTING_TARGET}','{APP_ID}','{CUSTOMER_ID}','mainline','2026-01-01',1,now(),'actor_a','existing target'),
                  ('00000000-0000-0000-0000-000000000012','{SECOND_TARGET}','{APP_ID}','{CUSTOMER_ID}','mainline','2026-01-01',1,now(),'actor_b','second target');
                "#
            ))
            .map_err(|error| format!("seed existing relation target: {error}"))?;
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
        set_membership(&mut client, &principal, "writer", true)?;

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

        let denied_existing = apply(
            &mut runtime,
            relation_create(
                "existing-id-denied",
                "00000000-0000-0000-0000-000000000010",
                record_id(EXISTING_TARGET),
            ),
        )?;
        assert_denied(&denied_existing);

        let unsupported_subject = apply(
            &mut runtime,
            external_subject_write("external-subject-unsupported"),
        )?;
        assert_unsupported(&unsupported_subject);
        assert_eq!(
            change_set_count(&mut client, "external-subject-unsupported")?,
            0,
            "unsupported policy subjects must not persist an idempotency receipt"
        );

        let unsupported_lifecycle = apply(
            &mut runtime,
            lookup_lifecycle_write("lookup-lifecycle-unsupported"),
        )?;
        assert_unsupported(&unsupported_lifecycle);
        assert_eq!(
            change_set_count(&mut client, "lookup-lifecycle-unsupported")?,
            0,
            "unsupported policy lifecycle writes must not persist an idempotency receipt"
        );

        let pending_request = json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_revision_id":"1","actor_id":"actor_a","source_kind":"fixture","idempotency_key":"pending-target","mode":"mainline","writes":[
          {"model_id":"company","new_record_id":PENDING_TARGET,"effective_start":"2026-01-02","values":{"owner":{"type":"text","value":"actor_a"},"name":{"type":"text","value":"pending target"}}},
          {"model_id":"child","new_record_id":PENDING_CHILD,"effective_start":"2026-01-02","values":{"owner":{"type":"text","value":"actor_a"},"name":{"type":"text","value":"pending child"},"company":{"type":"relation","value":{"type":"record_id","value":PENDING_TARGET}}}}
        ]});
        assert_ok(&apply(&mut runtime, pending_request.clone())?);
        assert_ok(&apply(&mut runtime, pending_request)?);

        let mixed = apply(
            &mut runtime,
            json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_revision_id":"1","actor_id":"actor_a","source_kind":"fixture","idempotency_key":"target-denied-rolls-back","mode":"mainline","writes":[
              {"model_id":"child","new_record_id":ROLLBACK_SIBLING,"effective_start":"2026-01-03","values":{"owner":{"type":"text","value":"actor_a"},"name":{"type":"text","value":"must rollback"}}},
              {"model_id":"child","new_record_id":ROLLBACK_DENIED,"effective_start":"2026-01-03","values":{"owner":{"type":"text","value":"actor_a"},"name":{"type":"text","value":"denied target"},"company":{"type":"relation","value":{"type":"record_id","value":EXISTING_TARGET}}}}
            ]}),
        )?;
        assert_denied(&mixed);
        assert_eq!(record_count(&mut client, "child", ROLLBACK_SIBLING)?, 0);
        assert_eq!(record_count(&mut client, "child", ROLLBACK_DENIED)?, 0);

        set_membership(&mut client, &principal, "target_id_reader", true)?;
        let id_authorized = relation_create(
            "existing-id-authorized",
            ID_CHILD,
            record_id(EXISTING_TARGET),
        );
        assert_ok(&apply(&mut runtime, id_authorized)?);

        let update_seed =
            relation_create("update-only-seed", UPDATE_CHILD, record_id(EXISTING_TARGET));
        assert_ok(&apply(&mut runtime, update_seed)?);
        set_membership(&mut client, &principal, "writer", false)?;
        set_membership(&mut client, &principal, "updater", true)?;
        let update_only_replay = record_update(
            "update-only-replay",
            UPDATE_CHILD,
            "2026-01-03",
            "updated once",
        );
        assert_ok(&apply(&mut runtime, update_only_replay.clone())?);
        assert_ok(&apply(&mut runtime, update_only_replay)?);
        let two_update_replay = two_date_updates(UPDATE_CHILD);
        assert_ok(&apply(&mut runtime, two_update_replay.clone())?);
        assert_ok(&apply(&mut runtime, two_update_replay)?);
        set_membership(&mut client, &principal, "updater", false)?;
        set_membership(&mut client, &principal, "writer", true)?;

        let external_without_key = relation_create(
            "external-key-denied",
            "00000000-0000-0000-0000-000000000042",
            external_key("existing-target"),
        );
        assert_denied(&apply(&mut runtime, external_without_key)?);

        set_membership(&mut client, &principal, "target_external_key_reader", true)?;
        let external_replay = relation_create(
            "external-key-authorized",
            EXTERNAL_CHILD,
            external_key("existing-target"),
        );
        assert_ok(&apply(&mut runtime, external_replay.clone())?);
        client
            .batch_execute(&format!(
                "update company_record set external_key = case id when '{EXISTING_TARGET}'::uuid then 'retired-target' when '{SECOND_TARGET}'::uuid then 'existing-target' else external_key end where id in ('{EXISTING_TARGET}'::uuid, '{SECOND_TARGET}'::uuid)"
            ))
            .map_err(|error| format!("transfer fixture external key: {error}"))?;
        assert_ok(&apply(&mut runtime, external_replay.clone())?);
        set_membership(&mut client, &principal, "target_id_reader", false)?;
        set_membership(&mut client, &principal, "target_external_key_reader", false)?;
        assert_denied(&apply(&mut runtime, external_replay)?);
        set_membership(&mut client, &principal, "target_id_reader", true)?;

        let replay = relation_create(
            "target-permission-replay",
            REPLAY_CHILD,
            record_id(EXISTING_TARGET),
        );
        assert_ok(&apply(&mut runtime, replay.clone())?);
        set_membership(&mut client, &principal, "target_id_reader", false)?;
        let revoked_target_replay = apply(&mut runtime, replay)?;
        assert_denied(&revoked_target_replay);

        set_membership(&mut client, &principal, "target_id_reader", true)?;
        let custom_replay = custom_relation_create("custom-relation-replay", CUSTOM_REPLAY_CHILD);
        assert_ok(&apply(&mut runtime, custom_replay.clone())?);
        set_membership(&mut client, &principal, "target_id_reader", false)?;
        assert_denied(&apply(&mut runtime, custom_replay)?);

        set_membership(&mut client, &principal, "target_id_reader", true)?;
        let many_replay = many_relation_create("many-relation-replay", MANY_REPLAY_DEPARTMENT);
        assert_ok(&apply(&mut runtime, many_replay.clone())?);
        let stored_many: Value = client
            .query_one(
                "select many_relations->'related_companies' from lookup_version where record_id=$1::uuid order by effective_start desc limit 1",
                &[&Uuid::parse_str(MANY_REPLAY_DEPARTMENT).expect("parse many replay id")],
            )
            .expect("read persisted relation-list order")
            .get(0);
        assert_eq!(
            stored_many,
            json!([EXISTING_TARGET, PENDING_TARGET]),
            "replay must pair original relation-list positions with persisted UUIDs"
        );
        set_membership(&mut client, &principal, "target_id_reader", false)?;
        assert_denied(&apply(&mut runtime, many_replay)?);

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
            panic!("policy write relation behavior: {error}");
        }
    }
}

fn lookup_lifecycle_write(idempotency_key: &str) -> Value {
    json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_revision_id":"1","actor_id":"actor_a","source_kind":"fixture","idempotency_key":idempotency_key,"mode":"mainline","writes":[{
      "model_id":"department","new_record_id":"00000000-0000-0000-0000-000000000061","effective_start":"2026-01-02",
      "values":{"name":{"type":"text","value":"unsupported lifecycle"},"__lookup_lifecycle":{"type":"schema_lifecycle","value":"retired"}}
    }]})
}

fn external_subject_write(idempotency_key: &str) -> Value {
    json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_revision_id":"1","actor_id":"actor_a","source_kind":"fixture","idempotency_key":idempotency_key,"mode":"mainline","writes":[{
      "model_id":"company","record_key":{"type":"external_key","value":"existing-target"},"effective_start":"2026-01-02",
      "values":{"owner":{"type":"text","value":"actor_a"},"name":{"type":"text","value":"unsupported subject"}}
    }]})
}

fn record_update(
    idempotency_key: &str,
    child_id: &str,
    effective_start: &str,
    name: &str,
) -> Value {
    json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_revision_id":"1","actor_id":"actor_a","source_kind":"fixture","idempotency_key":idempotency_key,"mode":"mainline","writes":[{
      "model_id":"child","record_key":{"type":"record_id","value":child_id},"effective_start":effective_start,
      "values":{"name":{"type":"text","value":name}}
    }]})
}

fn two_date_updates(child_id: &str) -> Value {
    json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_revision_id":"1","actor_id":"actor_a","source_kind":"fixture","idempotency_key":"two-date-update-replay","mode":"mainline","writes":[
      {"model_id":"child","record_key":{"type":"record_id","value":child_id},"effective_start":"2026-01-04","values":{"name":{"type":"text","value":"first dated update"}}},
      {"model_id":"child","record_key":{"type":"record_id","value":child_id},"effective_start":"2026-01-05","values":{"name":{"type":"text","value":"second dated update"}}}
    ]})
}

fn relation_create(idempotency_key: &str, child_id: &str, target: Value) -> Value {
    json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_revision_id":"1","actor_id":"actor_a","source_kind":"fixture","idempotency_key":idempotency_key,"mode":"mainline","writes":[{
      "model_id":"child","new_record_id":child_id,"effective_start":"2026-01-02",
      "values":{"owner":{"type":"text","value":"actor_a"},"name":{"type":"text","value":"child"},"company":{"type":"relation","value":target}}
    }]})
}

fn custom_relation_create(idempotency_key: &str, child_id: &str) -> Value {
    json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_revision_id":"1","actor_id":"actor_a","source_kind":"fixture","idempotency_key":idempotency_key,"mode":"mainline","writes":[{
      "model_id":"child","new_record_id":child_id,"effective_start":"2026-01-02",
      "values":{"owner":{"type":"text","value":"actor_a"},"name":{"type":"text","value":"custom child"}},
      "custom_fields":[{"field_id":"home_company","type":"relation","value":{"type":"record_id","value":EXISTING_TARGET}}]
    }]})
}

fn many_relation_create(idempotency_key: &str, child_id: &str) -> Value {
    json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_revision_id":"1","actor_id":"actor_a","source_kind":"fixture","idempotency_key":idempotency_key,"mode":"mainline","writes":[{
      "model_id":"department","new_record_id":child_id,"effective_start":"2026-01-02",
      "values":{"name":{"type":"text","value":"many department"},"related_companies":{"type":"relation_list","value":[{"type":"record_id","value":EXISTING_TARGET},{"type":"record_id","value":PENDING_TARGET}]}}
    }]})
}

fn record_id(id: &str) -> Value {
    json!({"type":"record_id","value":id})
}

fn external_key(key: &str) -> Value {
    json!({"type":"external_key","value":key})
}

fn apply(client: &mut postgres::Client, request: Value) -> Result<Value, String> {
    client
        .batch_execute("begin; select set_config('kernel.actor_id', 'actor_a', true)")
        .map_err(|error| error.to_string())?;
    let result = match call(client, "kernel_apply_change_set", request) {
        Ok(value) => value,
        Err(error) => {
            let _ = client.batch_execute("rollback");
            return Err(error);
        }
    };
    client
        .batch_execute("commit")
        .map_err(|error| error.to_string())?;
    Ok(result)
}

fn record_count(client: &mut postgres::Client, model: &str, id: &str) -> Result<i64, String> {
    let id = Uuid::parse_str(id).map_err(|error| error.to_string())?;
    client
        .query_one(
            &format!("select count(*) from {model}_record where id=$1::uuid"),
            &[&id],
        )
        .map(|row| row.get(0))
        .map_err(|error| error.to_string())
}

fn change_set_count(client: &mut postgres::Client, idempotency_key: &str) -> Result<i64, String> {
    client
        .query_one(
            "select count(*) from change_set where app_id=$1 and customer_id=$2 and idempotency_key=$3",
            &[&APP_ID, &CUSTOMER_ID, &idempotency_key],
        )
        .map(|row| row.get(0))
        .map_err(|error| error.to_string())
}

fn set_membership(
    client: &mut postgres::Client,
    principal: &str,
    role: &str,
    active: bool,
) -> Result<(), String> {
    let result = call(
        client,
        "kernel_bind_actor_membership",
        json!({"actor_kind":"human","principal_name":principal,"app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"actor_a","role":role,"active":active}),
    )?;
    assert_ok(&result);
    Ok(())
}

fn policy_manifest() -> Value {
    json!({
      "app_id":APP_ID,"customer_id":CUSTOMER_ID,"version":VERSION,
      "models":[
        {"id":"company","kind":"entity","label":"Target","fields":[
          {"id":"owner","label":"Owner","type":"text","required":true},
          {"id":"name","label":"Name","type":"text"}
        ]},
        {"id":"child","kind":"entity","label":"Child","extensions":{"typed_custom_fields":true},"fields":[
          {"id":"owner","label":"Owner","type":"text","required":true},
          {"id":"name","label":"Name","type":"text"},
          {"id":"company","label":"Target","type":"relation","target_model":"company"}
        ]},
        {"id":"department","kind":"lookup","label":"Department","fields":[
          {"id":"name","label":"Name","type":"text","required":true}
        ],"many_relations":[{"id":"related_companies","label":"Related targets","target_model":"company"}]}
      ],
      "custom_fields":[{"id":"child_home_company","model":"child","field":"home_company","label":"Home target","type":"relation","target_model":"company"}],
      "authorization":{"roles":[{"id":"writer"},{"id":"updater"},{"id":"target_id_reader"},{"id":"target_external_key_reader"}],"grants":[
        {"role":"writer","model":"company","operations":["create"],"write_fields":["owner","name"],"record":{"kind":"all"}},
        {"role":"writer","model":"child","operations":["create"],"write_fields":["owner","name","company","home_company"],"record":{"kind":"all"}},
        {"role":"updater","model":"child","operations":["update"],"write_fields":["name"],"record":{"kind":"all"}},
        {"role":"writer","model":"department","operations":["create"],"write_fields":["name","related_companies"],"record":{"kind":"all"}},
        {"role":"target_id_reader","model":"company","operations":["read"],"read_fields":["$id"],"record":{"kind":"actor_equals_field","field":"owner"}},
        {"role":"target_external_key_reader","model":"company","operations":["read"],"read_fields":["$externalKey"],"record":{"kind":"actor_equals_field","field":"owner"}}
      ]}
    })
}

fn call(client: &mut postgres::Client, function: &str, request: Value) -> Result<Value, String> {
    client
        .query_one(&format!("select {function}($1::jsonb)"), &[&request])
        .map(|row| row.get(0))
        .map_err(|error| format!("{function}: {error}"))
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

fn assert_unsupported(value: &Value) {
    assert_eq!(value["ok"], false, "{value}");
    assert_eq!(value["error"]["code"], "unsupported_capability", "{value}");
}

fn assert_denied(value: &Value) {
    assert_eq!(value["ok"], false, "{value}");
    assert_eq!(value["error"]["code"], "authorization_denied", "{value}");
}

fn test_database_url() -> Option<String> {
    match env::var("KERNEL_TEST_DATABASE_URL") {
        Ok(value) => Some(value),
        Err(env::VarError::NotPresent) => {
            eprintln!("skipping PostgreSQL test: KERNEL_TEST_DATABASE_URL is absent");
            None
        }
        Err(error) => panic!("read KERNEL_TEST_DATABASE_URL: {error}"),
    }
}
