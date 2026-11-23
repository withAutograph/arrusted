use std::env;

use kernel::connect_postgres;
use schema_compiler::{
    compile_manifest_json, compile_sql_artifact_manifest, render_sql_artifact_bundle,
};
use serde_json::{json, Value};
use uuid::Uuid;

const APP_ID: &str = "policy_relation_fixture";
const CUSTOMER_ID: &str = "tenant_a";
const VERSION: &str = "policy-relation-v1";
const SOURCE_ALLOWED: &str = "00000000-0000-0000-0000-000000000001";
const SOURCE_DENIED: &str = "00000000-0000-0000-0000-000000000002";
const SOURCE_CREATED: &str = "00000000-0000-0000-0000-000000000003";
const SOURCE_CREATED_DENIED: &str = "00000000-0000-0000-0000-000000000004";

struct AuthorizationFixtureCleanup {
    database_url: String,
    schema: String,
    principal: String,
    runtime_role: Option<String>,
    revoke_runtime_membership: bool,
    complete: bool,
}

impl AuthorizationFixtureCleanup {
    fn new(database_url: &str, schema: &str, principal: &str) -> Self {
        Self {
            database_url: database_url.to_owned(),
            schema: schema.to_owned(),
            principal: principal.to_owned(),
            runtime_role: None,
            revoke_runtime_membership: false,
            complete: false,
        }
    }

    fn remember_runtime_membership(
        &mut self,
        client: &mut postgres::Client,
        runtime_role: &str,
    ) -> Result<(), String> {
        let membership_existed: bool = client
            .query_one(
                "select exists (select 1 from pg_auth_members membership join pg_roles role on role.oid = membership.roleid where role.rolname = $1 and membership.member = (select oid from pg_roles where rolname = session_user))",
                &[&runtime_role],
            )
            .map_err(|error| format!("inspect installer runtime membership: {error}"))?
            .get(0);
        self.runtime_role = Some(runtime_role.to_owned());
        self.revoke_runtime_membership = !membership_existed;
        Ok(())
    }

    fn finish(&mut self) -> Result<(), String> {
        if self.complete {
            return Ok(());
        }
        let mut cleanup = connect_postgres(&self.database_url)
            .map_err(|error| format!("connect cleanup PostgreSQL: {error}"))?;
        let revoke_runtime_membership =
            match (self.runtime_role.as_deref(), self.revoke_runtime_membership) {
                (Some(runtime_role), true) => {
                    format!("revoke \"{runtime_role}\" from session_user;")
                }
                _ => String::new(),
            };
        cleanup
            .batch_execute(&format!(
                r#"
                rollback;
                reset role;
                reset session authorization;
                set search_path to public;
                {revoke_runtime_membership}
                drop schema if exists "{}" cascade;
                drop role if exists "{}";
                "#,
                self.schema, self.principal,
            ))
            .map_err(|error| format!("remove isolated authorization fixture: {error}"))?;
        if self.revoke_runtime_membership {
            let runtime_role = self
                .runtime_role
                .as_deref()
                .expect("runtime role is tracked when its membership needs revocation");
            let membership_remains: bool = cleanup
                .query_one(
                    "select exists (
                        select 1
                        from pg_auth_members membership
                        join pg_roles role on role.oid = membership.roleid
                        where role.rolname = $1
                          and membership.member = (select oid from pg_roles where rolname = session_user)
                    )",
                    &[&runtime_role],
                )
                .map_err(|error| format!("verify installer runtime membership cleanup: {error}"))?
                .get(0);
            if membership_remains {
                return Err(format!(
                    "test-introduced installer runtime membership remains for {runtime_role}"
                ));
            }
        }
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
fn policy_relation_navigation_authorizes_source_target_and_internal_link_separately() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let compiled =
        compile_manifest_json(&policy_manifest().to_string()).expect("compile policy manifest");
    let manifest = compile_sql_artifact_manifest(&compiled).expect("compile SQL policy bundle");
    let mut client = connect_postgres(&database_url).expect("connect PostgreSQL");
    let schema = format!("kernel_policy_relation_{}", Uuid::new_v4().simple());
    let principal = format!("policy_relation_runtime_{}", Uuid::new_v4().simple());
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
        cleanup.remember_runtime_membership(&mut client, &runtime_role)?;
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
                insert into work_item_record (id,app_id,customer_id,external_key) values
                  ('{SOURCE_ALLOWED}','{APP_ID}','{CUSTOMER_ID}','allowed-source'),
                  ('{SOURCE_DENIED}','{APP_ID}','{CUSTOMER_ID}','denied-source');
                insert into work_item_version (
                  id,record_id,app_id,customer_id,stage,effective_start,change_set_id,applied_at,owner,summary
                ) values
                  ('00000000-0000-0000-0000-000000000011','{SOURCE_ALLOWED}','{APP_ID}','{CUSTOMER_ID}','mainline','2026-01-01',1,now(),'actor_a','allowed source'),
                  ('00000000-0000-0000-0000-000000000012','{SOURCE_DENIED}','{APP_ID}','{CUSTOMER_ID}','mainline','2026-01-01',1,now(),'actor_b','denied source');
                insert into child_record (id,app_id,customer_id,external_key) values
                  ('00000000-0000-0000-0000-000000000101','{APP_ID}','{CUSTOMER_ID}','allowed-child'),
                  ('00000000-0000-0000-0000-000000000102','{APP_ID}','{CUSTOMER_ID}','denied-child'),
                  ('00000000-0000-0000-0000-000000000103','{APP_ID}','{CUSTOMER_ID}','denied-source-child');
                insert into child_version (
                  id,record_id,app_id,customer_id,stage,effective_start,change_set_id,applied_at,owner,name,work_item
                ) values
                  ('00000000-0000-0000-0000-000000000111','00000000-0000-0000-0000-000000000101','{APP_ID}','{CUSTOMER_ID}','mainline','2026-01-01',1,now(),'actor_a','visible child','{SOURCE_ALLOWED}'),
                  ('00000000-0000-0000-0000-000000000112','00000000-0000-0000-0000-000000000102','{APP_ID}','{CUSTOMER_ID}','mainline','2026-01-01',1,now(),'actor_b','hidden target','{SOURCE_ALLOWED}'),
                  ('00000000-0000-0000-0000-000000000113','00000000-0000-0000-0000-000000000103','{APP_ID}','{CUSTOMER_ID}','mainline','2026-01-01',1,now(),'actor_a','hidden source','{SOURCE_DENIED}');
                "#
            ))
            .map_err(|error| format!("seed policy relation records: {error}"))?;

        client
            .batch_execute(&format!(
                r#"create role "{principal}" nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
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
            json!({"actor_kind":"human","principal_name":principal,"app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"actor_a","role":"reviewer"}),
        )?);

        client
            .batch_execute(&format!(
                r#"set session authorization "{principal}";
                   set kernel.actor_id = 'actor_a'"#
            ))
            .map_err(|error| format!("assume restricted policy principal: {error}"))?;

        let source_full_read = call(
            &mut client,
            "kernel_data_query",
            json!({
                "app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_version":VERSION,
                "model_id":"work_item","as_of":"2026-01-01"
            }),
        )?;
        assert_denied(&source_full_read);

        let related = query(&mut client, "child", "children", SOURCE_ALLOWED, json!({}))?;
        assert_ok(&related);
        assert_eq!(
            related["data"],
            json!([{"values":{"name":{"type":"text","value":"visible child"}}}]),
            "the relation needs no source projection or target work_item field grant"
        );

        assert_denied(&query(
            &mut client,
            "child",
            "children",
            SOURCE_DENIED,
            json!({}),
        )?);
        assert_denied(&query(
            &mut client,
            "child",
            "missing",
            SOURCE_ALLOWED,
            json!({}),
        )?);
        assert_denied(&query(
            &mut client,
            "work_item",
            "children",
            SOURCE_ALLOWED,
            json!({"select":["summary"]}),
        )?);
        assert_denied(&query(
            &mut client,
            "child",
            "children",
            "00000000-0000-0000-0000-000000000999",
            json!({}),
        )?);
        let malformed = call(
            &mut client,
            "kernel_data_query",
            json!({
                "app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_version":VERSION,
                "model_id":"child","as_of":"2026-01-01","select":["name"],
                "relation_source":{"model_id":"work_item","relation_id":"children","record_id":"not-a-uuid"}
            }),
        )?;
        assert_eq!(malformed["ok"], false, "{malformed}");
        assert_eq!(
            malformed["error"]["code"], "contract_validation_failed",
            "{malformed}"
        );
        assert_denied(&query(
            &mut client,
            "child",
            "children",
            SOURCE_ALLOWED,
            json!({"where":[{"field":"work_item","op":"eq","value":SOURCE_ALLOWED}]}),
        )?);

        // Search: the query must be a string of at most 200 characters.
        let search = |query: Value| {
            json!({
                "app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_version":VERSION,
                "model_id":"child","as_of":"2026-01-01","select":["name"],
                "search":{"query":query,"fields":["name"]}
            })
        };
        let found = call(
            &mut client,
            "kernel_data_query",
            search(json!("VISIBLE\u{a0}Child")),
        )?;
        assert_ok(&found);
        assert_eq!(
            found["data"],
            json!([{"values":{"name":{"type":"text","value":"visible child"}}}])
        );
        for invalid in [json!(5), json!(["visible"]), json!("v".repeat(201))] {
            let rejected = call(&mut client, "kernel_data_query", search(invalid))?;
            assert_eq!(rejected["ok"], false, "{rejected}");
            assert_eq!(
                rejected["error"]["code"], "contract_validation_failed",
                "{rejected}"
            );
        }
        assert_ok(&call(
            &mut client,
            "kernel_data_query",
            search(json!("v".repeat(200))),
        )?);

        client
            .batch_execute("set session authorization default")
            .map_err(|error| format!("restore installer session: {error}"))?;
        assert_ok(&call(
            &mut client,
            "kernel_bind_actor_membership",
            json!({"actor_kind":"human","principal_name":principal,"app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"actor_a","role":"fk_reader"}),
        )?);
        client
            .batch_execute(&format!(
                r#"set session authorization "{principal}";
                   set kernel.actor_id = 'actor_a'"#
            ))
            .map_err(|error| format!("resume restricted policy principal: {error}"))?;
        let explicitly_filtered = query(
            &mut client,
            "child",
            "children",
            SOURCE_ALLOWED,
            json!({"where":[{"field":"work_item","op":"eq","value":SOURCE_ALLOWED}]}),
        )?;
        assert_ok(&explicitly_filtered);
        assert_eq!(
            explicitly_filtered["data"],
            json!([{"values":{"name":{"type":"text","value":"visible child"}}}])
        );

        let aggregate = call(
            &mut client,
            "kernel_data_query",
            json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_version":VERSION,
                "model_id":"child","as_of":"2026-01-01","kind":"aggregate",
                "group_by":["work_item"],"metrics":[{"fn":"count"}],
                "relation_source":{"model_id":"work_item","relation_id":"children","record_id":SOURCE_ALLOWED},
                "where":[{"field":"work_item","op":"eq","value":SOURCE_ALLOWED}],
                "search":{"query":"visible child","fields":["name"]}}),
        )?;
        assert_ok(&aggregate);
        assert_eq!(
            aggregate["data"],
            json!({
                "as_of":"2026-01-01","units":[null],
                "groups":[{"key":[SOURCE_ALLOWED],"metrics":["1"]}],
                "total":{"metrics":["1"]}
            })
        );

        // Pending drafts: the source is navigated from as the read previews
        // it. One draft creates a source for actor_a and one for actor_b, and
        // deletes SOURCE_ALLOWED; a child (actor_a's) links to each new source.
        client
            .batch_execute(&format!(
                r#"set session authorization default;
                insert into change_set (app_id,customer_id,schema_revision_id,created_with_mode,status,source_kind,created_order,written_fields)
                values ('{APP_ID}','{CUSTOMER_ID}',1,'draft','draft','fixture',2,
                  jsonb_build_object('work_item',jsonb_build_object(
                    '{SOURCE_CREATED}','{{"2026-01-01":["owner","summary"]}}'::jsonb,
                    '{SOURCE_CREATED_DENIED}','{{"2026-01-01":["owner","summary"]}}'::jsonb,
                    '{SOURCE_ALLOWED}','{{"2026-01-01":[]}}'::jsonb)));
                insert into work_item_record (id,app_id,customer_id,external_key) values
                  ('{SOURCE_CREATED}','{APP_ID}','{CUSTOMER_ID}','created-source'),
                  ('{SOURCE_CREATED_DENIED}','{APP_ID}','{CUSTOMER_ID}','created-denied-source');
                insert into work_item_version (id,record_id,app_id,customer_id,stage,effective_start,change_set_id,tombstones_record,owner,summary)
                select gen_random_uuid(),source.id::uuid,'{APP_ID}','{CUSTOMER_ID}','draft','2026-01-01',
                  (select max(id) from change_set),source.tombstone,source.owner,source.summary
                from (values ('{SOURCE_CREATED}',false,'actor_a','created source'),
                  ('{SOURCE_CREATED_DENIED}',false,'actor_b','created denied source'),
                  ('{SOURCE_ALLOWED}',true,null,null)) source(id,tombstone,owner,summary);
                insert into child_record (id,app_id,customer_id,external_key) values
                  ('00000000-0000-0000-0000-000000000104','{APP_ID}','{CUSTOMER_ID}','created-source-child'),
                  ('00000000-0000-0000-0000-000000000105','{APP_ID}','{CUSTOMER_ID}','created-denied-child');
                insert into child_version (id,record_id,app_id,customer_id,stage,effective_start,change_set_id,applied_at,owner,name,work_item)
                values
                  ('00000000-0000-0000-0000-000000000114','00000000-0000-0000-0000-000000000104','{APP_ID}','{CUSTOMER_ID}','mainline','2026-01-01',1,now(),'actor_a','child of created','{SOURCE_CREATED}'),
                  ('00000000-0000-0000-0000-000000000115','00000000-0000-0000-0000-000000000105','{APP_ID}','{CUSTOMER_ID}','mainline','2026-01-01',1,now(),'actor_a','child of denied','{SOURCE_CREATED_DENIED}');
                set session authorization "{principal}";
                set kernel.actor_id = 'actor_a'"#
            ))
            .map_err(|error| format!("seed pending source drafts: {error}"))?;
        let drafts = json!({"include_pending_drafts":true});
        // A source a pending draft creates (the actor's) is navigated from
        // with drafts on, and not without.
        let from_created = query(
            &mut client,
            "child",
            "children",
            SOURCE_CREATED,
            drafts.clone(),
        )?;
        assert_ok(&from_created);
        assert_eq!(
            from_created["data"],
            json!([{"values":{"name":{"type":"text","value":"child of created"}}}])
        );
        assert_denied(&query(
            &mut client,
            "child",
            "children",
            SOURCE_CREATED,
            json!({}),
        )?);
        // Its record grant still applies: another actor's creation is not.
        assert_denied(&query(
            &mut client,
            "child",
            "children",
            SOURCE_CREATED_DENIED,
            drafts.clone(),
        )?);
        // A source a pending draft deletes no longer authorizes navigation.
        assert_denied(&query(
            &mut client,
            "child",
            "children",
            SOURCE_ALLOWED,
            drafts.clone(),
        )?);
        assert_ok(&query(
            &mut client,
            "child",
            "children",
            SOURCE_ALLOWED,
            json!({}),
        )?);

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
            panic!("policy relation navigation behavior: {error}");
        }
    }
}

fn query(
    client: &mut postgres::Client,
    model_id: &str,
    relation_id: &str,
    source_id: &str,
    extra: Value,
) -> Result<Value, String> {
    let mut request = json!({
        "app_id":APP_ID,
        "customer_id":CUSTOMER_ID,
        "schema_version":VERSION,
        "model_id":model_id,
        "as_of":"2026-01-01",
        "select":["name"],
        "relation_source":{"model_id":"work_item","relation_id":relation_id,"record_id":source_id}
    });
    if let (Some(target), Some(extra)) = (request.as_object_mut(), extra.as_object()) {
        target.extend(extra.clone());
    }
    call(client, "kernel_data_query", request)
}

fn policy_manifest() -> Value {
    json!({
      "app_id":APP_ID,"customer_id":CUSTOMER_ID,"version":VERSION,
      "models":[
        {"id":"work_item","kind":"entity","label":"Work item",
         "fields":[
           {"id":"owner","label":"Owner","type":"text","required":true},
           {"id":"summary","label":"Summary","type":"text"}
         ],
         "inverse_relations":[{"id":"children","model":"child","through":"work_item"}]
        },
        {"id":"child","kind":"entity","label":"Child","fields":[
          {"id":"owner","label":"Owner","type":"text","required":true},
          {"id":"name","label":"Name","type":"text"},
          {"id":"work_item","label":"Work item","type":"relation","target_model":"work_item"}
        ]}
      ],
      "authorization":{"roles":[{"id":"reviewer"},{"id":"fk_reader"}],"grants":[
        {"role":"reviewer","model":"work_item","operations":["read"],
         "read_fields":["summary"],"read_relations":["children"],
         "record":{"kind":"actor_equals_field","field":"owner"}},
        {"role":"reviewer","model":"child","operations":["read"],
         "read_fields":["name"],"record":{"kind":"actor_equals_field","field":"owner"}},
        {"role":"fk_reader","model":"child","operations":["read"],
         "read_fields":["work_item"],"record":{"kind":"actor_equals_field","field":"owner"}}
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

fn assert_denied(value: &Value) {
    assert_eq!(value["ok"], false, "{value}");
    assert_eq!(value["error"]["code"], "authorization_denied", "{value}");
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
