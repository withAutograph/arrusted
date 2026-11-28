use std::env;

use kernel::{connect_postgres, generated::GeneratedSqlFunction};
use schema_compiler::{
    compile_manifest_json, compile_sql_artifact_manifest, render_sql_artifact_bundle,
};
use serde_json::{json, Value};
use uuid::Uuid;

const APP_ID: &str = "policy_history_fixture";
const CUSTOMER_ID: &str = "tenant_a";
const VERSION: &str = "policy-history-v1";

struct AuthorizationFixtureCleanup {
    database_url: String,
    schema: String,
    principal: String,
    /// A role this fixture granted to the session user, revoked on cleanup.
    granted_role: Option<String>,
    complete: bool,
}

impl AuthorizationFixtureCleanup {
    fn new(database_url: &str, schema: &str, principal: &str) -> Self {
        Self {
            database_url: database_url.to_owned(),
            schema: schema.to_owned(),
            principal: principal.to_owned(),
            granted_role: None,
            complete: false,
        }
    }

    /// Grants `role` to the session user, remembering to revoke it on
    /// cleanup only when this fixture added the membership.
    fn grant_to_session_user(
        &mut self,
        client: &mut postgres::Client,
        role: &str,
    ) -> Result<(), String> {
        let existed: bool = client
            .query_one(
                "select exists (select 1 from pg_auth_members membership \
                 join pg_roles granted on granted.oid = membership.roleid \
                 join pg_roles member on member.oid = membership.member \
                 where granted.rolname = $1 and member.rolname = session_user)",
                &[&role],
            )
            .map_err(|error| format!("read session role membership: {error}"))?
            .get(0);
        client
            .batch_execute(&format!("grant \"{role}\" to session_user"))
            .map_err(|error| format!("grant {role} to session user: {error}"))?;
        if !existed {
            self.granted_role = Some(role.to_owned());
        }
        Ok(())
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
                {}
                drop schema if exists "{}" cascade;
                drop role if exists "{}";
                "#,
                self.granted_role
                    .as_ref()
                    .map(|role| format!("revoke \"{role}\" from session_user;"))
                    .unwrap_or_default(),
                self.schema,
                self.principal,
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
fn policy_enabled_history_requires_history_grant_and_current_membership_for_every_temporal_image() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let compiled =
        compile_manifest_json(&policy_manifest().to_string()).expect("compile policy manifest");
    let manifest = compile_sql_artifact_manifest(&compiled).expect("compile SQL policy bundle");
    let mut client = connect_postgres(&database_url).expect("connect PostgreSQL");
    let schema = format!("kernel_policy_query_{}", Uuid::new_v4().simple());
    let principal = format!("policy_runtime_{}", Uuid::new_v4().simple());
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
        let installer_runtime_role = scalar(
            &mut client,
            "select kernel_installer_capability_role('runtime')",
        )?;
        cleanup.grant_to_session_user(&mut client, &installer_runtime_role)?;

        let mut schema_json = serde_json::to_value(&compiled.schema).expect("serialize schema");
        // A tenant custom field no grant names: unqualified history omits it.
        schema_json["custom_fields"] = json!([{
            "id":"work_item_priority","model_id":"work_item","field_id":"priority",
            "label":"Priority","type":"text","target_model_id":null,"option_set":[],
            "archived_at":null,"origin":"tenant","management":"tenant_managed","lifecycle":"active"
        }]);
        let revision_id: i64 = client
            .query_one(
                "insert into schema_revision (app_id,customer_id,version,base_schema,customer_overlay,schema,activated_at) values ($1,$2,$3,$4,'{}'::jsonb,$4,now()) returning id",
                &[&APP_ID, &CUSTOMER_ID, &VERSION, &schema_json],
            )
            .map_err(|error| format!("insert active policy revision: {error}"))?
        .get(0);
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
                  actor_id, source_kind, source_ref, notes, created_order, applied_order, applied_at
                ) values ('{APP_ID}', '{CUSTOMER_ID}', {revision_id}, 'mainline', 'mainline',
                  'importer', 'fixture', 'seed.csv', 'private note', 1, 1, now());
                insert into work_item_record (id,app_id,customer_id,external_key) values
                  ('00000000-0000-0000-0000-000000000001','{APP_ID}','{CUSTOMER_ID}','mine'),
                  ('00000000-0000-0000-0000-000000000002','{APP_ID}','{CUSTOMER_ID}','other');
                insert into work_item_version (
                  id,record_id,app_id,customer_id,stage,effective_start,change_set_id,applied_at,owner,summary,custom_fields
                ) values
                  ('00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000001','{APP_ID}','{CUSTOMER_ID}','mainline','2026-01-01',1,now(),'actor_a','mine',
                   '[{{"field_id":"priority","type":"text","value":"high"}}]'::jsonb);
                "#
            ))
            .map_err(|error| format!("seed policy query records: {error}"))?;

        let runtime_role = scalar(
            &mut client,
            "select kernel_installer_capability_role('runtime')",
        )?;
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
        for (function, request) in [
            (
                "kernel_read_visible_records",
                json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"model_id":"work_item","as_of":"2026-01-01","fields":["summary"]}),
            ),
            (
                "kernel_prepare_visible_query",
                json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"as_of":"2026-01-01"}),
            ),
            (
                "kernel_lookup_list",
                json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"model_id":"work_item"}),
            ),
            (
                "kernel_list_draft_change_sets",
                json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID}),
            ),
            (
                "kernel_record_agent_run",
                json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"run_id":"policy-history-run","agent_identity_id":"fixture","execution_profile_id":"fixture"}),
            ),
        ] {
            let rejected = call(&mut client, function, request)?;
            assert_eq!(rejected["ok"], false, "{function}: {rejected}");
            assert_eq!(
                rejected["error"]["code"], "unsupported_capability",
                "{function}: {rejected}"
            );
        }

        let initial_history = call(
            &mut client,
            "kernel_field_history",
            json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"model_id":"work_item","record_id":"00000000-0000-0000-0000-000000000001","field_id":"summary"}),
        )?;
        assert_ok(&initial_history);
        assert_eq!(initial_history["data"].as_array().map(Vec::len), Some(1));
        let attributed = &initial_history["data"][0];
        assert_eq!(attributed["source_kind"], "fixture", "{attributed}");
        assert_eq!(attributed["source_ref"], "seed.csv", "{attributed}");
        assert!(attributed["applied_at"].is_string(), "{attributed}");
        assert_eq!(attributed["tombstones_record"], false, "{attributed}");
        assert_eq!(
            attributed["actor_id"],
            Value::Null,
            "a declared policy withholds the actor: {attributed}"
        );
        assert_eq!(
            attributed["notes"],
            Value::Null,
            "a declared policy withholds notes: {attributed}"
        );

        let draft_history = call(
            &mut client,
            "kernel_field_history",
            json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"model_id":"work_item","record_id":"00000000-0000-0000-0000-000000000001","field_id":"summary","stages":["draft"]}),
        )?;
        assert_eq!(
            draft_history["error"]["code"], "unsupported_capability",
            "{draft_history}"
        );
        let whole_history = call(
            &mut client,
            "kernel_field_history",
            json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"model_id":"work_item","record_id":"00000000-0000-0000-0000-000000000001"}),
        )?;
        assert_ok(&whole_history);
        let whole_fields: Vec<_> = whole_history["data"]
            .as_array()
            .expect("whole history entries")
            .iter()
            .map(|entry| entry["field_id"].as_str().unwrap_or_default().to_string())
            .collect();
        assert_eq!(
            whole_fields,
            vec!["summary".to_string()],
            "unqualified history leaves out ungranted declared and custom fields: {whole_history}"
        );

        let field_grant_denied = call(
            &mut client,
            "kernel_field_history",
            json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"model_id":"work_item","record_id":"00000000-0000-0000-0000-000000000001","field_id":"owner"}),
        )?;
        assert_eq!(field_grant_denied["ok"], false, "{field_grant_denied}");
        assert_eq!(field_grant_denied["error"]["code"], "authorization_denied");
        // A bound actor missing a field grant is told so, not that its tenant
        // binding failed.
        assert_eq!(
            field_grant_denied["error"]["details"][0]["code"], "grant_not_authorized",
            "{field_grant_denied}"
        );

        client
            .batch_execute("reset session authorization")
            .map_err(|error| error.to_string())?;
        assert_ok(&call(
            &mut client,
            "kernel_bind_actor_membership",
            json!({"actor_kind":"human","principal_name":principal,"app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"actor_a","role":"owner_reader"}),
        )?);
        client
            .batch_execute(&format!(
                "set session authorization \"{principal}\"; set kernel.actor_id='actor_a'"
            ))
            .map_err(|error| error.to_string())?;
        let whole_history_allowed = call(
            &mut client,
            "kernel_field_history",
            json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"model_id":"work_item","record_id":"00000000-0000-0000-0000-000000000001"}),
        )?;
        assert_ok(&whole_history_allowed);
        assert_eq!(
            whole_history_allowed["data"].as_array().map(Vec::len),
            Some(2),
            "per-row matching grants jointly authorize both declared fields"
        );
        let custom_denied = call(
            &mut client,
            "kernel_field_history",
            json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"model_id":"work_item","record_id":"00000000-0000-0000-0000-000000000001","field_id":"priority"}),
        )?;
        assert_eq!(
            custom_denied["error"]["code"], "authorization_denied",
            "an explicit ungranted custom field still fails: {custom_denied}"
        );

        client.batch_execute(&format!(
            r#"
            reset session authorization;
            update work_item_version
            set effective_end='2026-01-31'
            where id='00000000-0000-0000-0000-000000000011';
            insert into change_set (
              app_id, customer_id, schema_revision_id, created_with_mode, status,
              source_kind, created_order, applied_order, applied_at
            ) values ('{APP_ID}', '{CUSTOMER_ID}', {revision_id}, 'mainline', 'mainline', 'fixture', 2, 2, now());
            insert into work_item_version (
              id,record_id,app_id,customer_id,stage,effective_start,change_set_id,applied_at,owner,summary
            ) values (
              '00000000-0000-0000-0000-000000000012','00000000-0000-0000-0000-000000000001',
              '{APP_ID}','{CUSTOMER_ID}','mainline','2026-02-01',2,now(),'actor_b','transferred'
            );
            set session authorization "{principal}";
            set kernel.actor_id = 'actor_a';
            "#
        )).map_err(|error| format!("seed transferred history image: {error}"))?;
        let mixed_history = call(
            &mut client,
            "kernel_field_history",
            json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"model_id":"work_item","record_id":"00000000-0000-0000-0000-000000000001","field_id":"summary"}),
        )?;
        assert_eq!(mixed_history["ok"], false, "{mixed_history}");
        assert_eq!(mixed_history["error"]["code"], "authorization_denied");
        assert!(mixed_history.get("data").is_none(), "{mixed_history}");
        let mixed_whole_history = call(
            &mut client,
            "kernel_field_history",
            json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"model_id":"work_item","record_id":"00000000-0000-0000-0000-000000000001"}),
        )?;
        assert_eq!(
            mixed_whole_history["error"]["code"], "authorization_denied",
            "field omission never hides a snapshot no record grant covers: {mixed_whole_history}"
        );

        client.batch_execute(&format!(
            r#"reset session authorization;
               update kernel_actor_membership set active=false
               where principal_name='{principal}'::name and app_id='{APP_ID}' and customer_id='{CUSTOMER_ID}' and actor_id='actor_a';
               set session authorization "{principal}";
               set kernel.actor_id = 'actor_a'"#
        )).map_err(|error| format!("revoke current history membership: {error}"))?;
        let revoked_history = call(
            &mut client,
            "kernel_field_history",
            json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"model_id":"work_item","record_id":"00000000-0000-0000-0000-000000000001","field_id":"summary"}),
        )?;
        assert_eq!(revoked_history["ok"], false, "{revoked_history}");
        assert_eq!(revoked_history["error"]["code"], "authorization_denied");

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

#[test]
fn unqualified_policy_history_marks_unreadable_fields_withheld_and_keeps_every_snapshot() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let app_id = "withheld_history_fixture";
    let version = "withheld-history-v1";
    // A model-wide history grant that reads no field, plus an owner-conditioned
    // grant that reads salary: only the owner's snapshots reveal salary.
    let authored = json!({
      "app_id":app_id,"customer_id":CUSTOMER_ID,"version":version,
      "models":[{"id":"pay_record","kind":"entity","label":"Pay record","fields":[
        {"id":"owner","label":"Owner","type":"text","required":true},
        {"id":"salary","label":"Salary","type":"text"}
      ]}],
      "authorization":{"roles":[{"id":"viewer"}],"grants":[{
        "role":"viewer","model":"pay_record","operations":["history"],
        "read_fields":[],
        "record":{"kind":"all"}
      },{
        "role":"viewer","model":"pay_record","operations":["history"],
        "read_fields":["salary"],
        "record":{"kind":"actor_equals_field","field":"owner"}
      }]}
    });
    let compiled = compile_manifest_json(&authored.to_string()).expect("compile withheld manifest");
    let manifest = compile_sql_artifact_manifest(&compiled).expect("compile withheld bundle");
    let mut client = connect_postgres(&database_url).expect("connect PostgreSQL");
    let schema = format!("kernel_withheld_history_{}", Uuid::new_v4().simple());
    let principal = format!("withheld_runtime_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            "create schema \"{schema}\"; set search_path to \"{schema}\""
        ))
        .expect("create isolated withheld schema");
    let mut cleanup = AuthorizationFixtureCleanup::new(&database_url, &schema, &principal);

    let result = (|| -> Result<(), String> {
        client
            .batch_execute(&render_sql_artifact_bundle(&manifest))
            .map_err(|error| format!("install withheld bundle: {error}"))?;
        let runtime_role = scalar(
            &mut client,
            "select kernel_installer_capability_role('runtime')",
        )?;
        cleanup.grant_to_session_user(&mut client, &runtime_role)?;
        let schema_json = serde_json::to_value(&compiled.schema).expect("serialize schema");
        let revision_id: i64 = client
            .query_one(
                "insert into schema_revision (app_id,customer_id,version,base_schema,customer_overlay,schema,activated_at) values ($1,$2,$3,$4,'{}'::jsonb,$4,now()) returning id",
                &[&app_id, &CUSTOMER_ID, &version, &schema_json],
            )
            .map_err(|error| format!("insert active revision: {error}"))?
            .get(0);
        client
            .execute(
                "select kernel_sync_schema_authorization_policy(id) from schema_revision where app_id=$1 and customer_id=$2 and version=$3",
                &[&app_id, &CUSTOMER_ID, &version],
            )
            .map_err(|error| format!("snapshot policy: {error}"))?;
        client
            .batch_execute(&format!(
                r#"
                insert into change_set (
                  app_id, customer_id, schema_revision_id, created_with_mode, status,
                  actor_id, source_kind, notes, created_order, applied_order, applied_at
                ) values
                  ('{app_id}', '{CUSTOMER_ID}', {revision_id}, 'mainline', 'mainline', 'hr', 'import', 'jan', 1, 1, now()),
                  ('{app_id}', '{CUSTOMER_ID}', {revision_id}, 'mainline', 'mainline', 'hr', 'import', 'feb', 2, 2, now()),
                  ('{app_id}', '{CUSTOMER_ID}', {revision_id}, 'mainline', 'mainline', 'hr', 'import', 'mar', 3, 3, now());
                insert into pay_record_record (id,app_id,customer_id,external_key) values
                  ('20000000-0000-0000-0000-000000000001','{app_id}','{CUSTOMER_ID}','pay');
                insert into pay_record_version (
                  id,record_id,app_id,customer_id,stage,effective_start,effective_end,change_set_id,applied_at,owner,salary
                ) select ('20000000-0000-0000-0000-00000000001' || n)::uuid, '20000000-0000-0000-0000-000000000001'::uuid,
                    '{app_id}', '{CUSTOMER_ID}', 'mainline', start_date, end_date, cs.id, now(), owner, salary
                  from (values
                    (1, date '2026-01-01', date '2026-01-31', 'actor_a', '100'),
                    (2, date '2026-02-01', date '2026-02-28', 'actor_b', '200'),
                    (3, date '2026-03-01', null::date, 'actor_a', '300')
                  ) snapshot(n, start_date, end_date, owner, salary)
                  join change_set cs on cs.app_id = '{app_id}' and cs.applied_order = snapshot.n;
                "#
            ))
            .map_err(|error| format!("seed withheld history: {error}"))?;
        client
            .batch_execute(&format!(
                r#"create role "{principal}" nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
                   grant "{runtime_role}" to "{principal}";
                   grant usage on schema "{schema}" to "{principal}""#
            ))
            .map_err(|error| format!("create restricted role: {error}"))?;
        assert_ok(&call(
            &mut client,
            "kernel_bind_principal_scope",
            json!({"principal_name":principal,"capability":"runtime","app_id":app_id,"customer_id":CUSTOMER_ID}),
        )?);
        assert_ok(&call(
            &mut client,
            "kernel_bind_actor_membership",
            json!({"actor_kind":"human","principal_name":principal,"app_id":app_id,"customer_id":CUSTOMER_ID,"actor_id":"actor_a","role":"viewer"}),
        )?);
        client
            .batch_execute(&format!(
                "set session authorization \"{principal}\"; set kernel.actor_id = 'actor_a'"
            ))
            .map_err(|error| format!("assume restricted principal: {error}"))?;

        let history = call(
            &mut client,
            "kernel_field_history",
            json!({"app_id":app_id,"customer_id":CUSTOMER_ID,"model_id":"pay_record","record_id":"20000000-0000-0000-0000-000000000001"}),
        )?;
        assert_ok(&history);
        let entries = history["data"].as_array().expect("history entries");
        let observed: Vec<_> = entries
            .iter()
            .map(|entry| {
                (
                    entry["effective_start"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string(),
                    entry["field_id"].as_str().unwrap_or_default().to_string(),
                    entry["withheld"].clone(),
                    entry["value"].clone(),
                )
            })
            .collect();
        assert_eq!(
            observed,
            vec![
                (
                    "2026-01-01".into(),
                    "salary".into(),
                    json!(false),
                    json!({"type":"text","value":"100"})
                ),
                (
                    "2026-02-01".into(),
                    "salary".into(),
                    json!(true),
                    Value::Null
                ),
                (
                    "2026-03-01".into(),
                    "salary".into(),
                    json!(false),
                    json!({"type":"text","value":"300"})
                ),
            ],
            "the February boundary stays, with salary withheld and no value: {history}"
        );
        let february = &entries[1];
        assert!(february.get("enum_value").is_none(), "{february}");
        assert_eq!(february["source_kind"], "import", "{february}");
        assert_eq!(february["notes"], Value::Null, "{february}");
        assert!(
            !history.to_string().contains("\"200\""),
            "a withheld value never leaves the database: {history}"
        );

        // An explicit request for the field still fails on the unreadable snapshot.
        let explicit = call(
            &mut client,
            "kernel_field_history",
            json!({"app_id":app_id,"customer_id":CUSTOMER_ID,"model_id":"pay_record","record_id":"20000000-0000-0000-0000-000000000001","field_id":"salary"}),
        )?;
        assert_eq!(
            explicit["error"]["code"], "authorization_denied",
            "{explicit}"
        );
        Ok(())
    })();

    match result {
        Ok(()) => cleanup.finish().expect("remove withheld fixture"),
        Err(error) => {
            if let Err(cleanup_error) = cleanup.finish() {
                eprintln!("withheld fixture cleanup after test failure: {cleanup_error}");
            }
            panic!("withheld history behavior: {error}");
        }
    }
}

#[test]
fn host_bound_actor_authorizes_generated_top_level_reads_under_declared_policy() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let compiled =
        compile_manifest_json(&policy_manifest().to_string()).expect("compile policy manifest");
    let manifest = compile_sql_artifact_manifest(&compiled).expect("compile SQL policy bundle");
    let mut client = connect_postgres(&database_url).expect("connect PostgreSQL");
    let schema = format!("kernel_policy_host_actor_{}", Uuid::new_v4().simple());
    let principal = format!("policy_runtime_{}", Uuid::new_v4().simple());
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
        let revision_id: i64 = client
            .query_one(
                "insert into schema_revision (app_id,customer_id,version,base_schema,customer_overlay,schema,activated_at) values ($1,$2,$3,$4,'{}'::jsonb,$4,now()) returning id",
                &[&APP_ID, &CUSTOMER_ID, &VERSION, &schema_json],
            )
            .map_err(|error| format!("insert active policy revision: {error}"))?
            .get(0);
        client
            .execute(
                "select kernel_sync_schema_authorization_policy(id) from schema_revision where app_id=$1 and customer_id=$2 and version=$3",
                &[&APP_ID, &CUSTOMER_ID, &VERSION],
            )
            .map_err(|error| format!("snapshot compiler policy: {error}"))?;
        let change_set_id: i64 = client
            .query_one(
                "insert into change_set (app_id, customer_id, schema_revision_id, created_with_mode, status, source_kind, created_order, applied_order, applied_at) values ($1, $2, $3, 'mainline', 'mainline', 'fixture', 1, 1, now()) returning id",
                &[&APP_ID, &CUSTOMER_ID, &revision_id],
            )
            .map_err(|error| format!("seed policy change set: {error}"))?
            .get(0);
        client
            .batch_execute(&format!(
                r#"
                insert into work_item_record (id,app_id,customer_id,external_key) values
                  ('00000000-0000-0000-0000-000000000001','{APP_ID}','{CUSTOMER_ID}','mine');
                insert into work_item_version (
                  id,record_id,app_id,customer_id,stage,effective_start,change_set_id,applied_at,owner,summary
                ) values
                  ('00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000001','{APP_ID}','{CUSTOMER_ID}','mainline','2026-01-01',{change_set_id},now(),'actor_a','mine');
                create role "{principal}" nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
                grant "{runtime_role}" to "{principal}";
                grant usage on schema "{schema}" to "{principal}";
                "#
            ))
            .map_err(|error| format!("seed policy history fixture: {error}"))?;
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
                "set session authorization \"{principal}\"; reset kernel.actor_id"
            ))
            .map_err(|error| format!("assume restricted policy principal: {error}"))?;

        let history_request = json!({
            "app_id":APP_ID,"customer_id":CUSTOMER_ID,"model_id":"work_item",
            "record_id":"00000000-0000-0000-0000-000000000001","field_id":"summary"
        });
        let error_code = |error: kernel::KernelError| error.into_envelope().code;

        let unbound = GeneratedSqlFunction::FieldHistory
            .call_top_level::<Value>(&mut client, &history_request)
            .expect_err("a declared policy requires a host-bound actor");
        assert_eq!(error_code(unbound), "authorization_denied");

        let authorized = GeneratedSqlFunction::FieldHistory
            .call_top_level_as_actor::<Value>(&mut client, "actor_a", &history_request)
            .map_err(|error| format!("authorized actor history: {error}"))?;
        assert_eq!(authorized.as_array().map(Vec::len), Some(1), "{authorized}");
        assert_eq!(authorized[0]["value"]["value"], "mine", "{authorized}");

        let leaked_actor = scalar(
            &mut client,
            "select coalesce(current_setting('kernel.actor_id', true), '')",
        )?;
        assert_eq!(leaked_actor, "", "actor binding is transaction-local");

        let unauthorized = GeneratedSqlFunction::FieldHistory
            .call_top_level_as_actor::<Value>(
                &mut client,
                "actor_without_membership",
                &history_request,
            )
            .expect_err("an actor without membership is refused");
        assert_eq!(error_code(unauthorized), "authorization_denied");

        let raw_diff = GeneratedSqlFunction::ChangeSetDiff
            .call_top_level_as_actor::<Value>(
                &mut client,
                "actor_a",
                &json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"change_set_id":change_set_id}),
            )
            .expect_err("raw diff cannot enforce a declared policy");
        assert_eq!(error_code(raw_diff), "unsupported_capability");

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
            panic!("host-bound actor behavior: {error}");
        }
    }
}

#[test]
fn policy_absent_compiled_releases_preserve_legacy_field_history() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let app_id = "legacy_history_fixture";
    let version = "legacy-history-v1";
    let mut authored = policy_manifest();
    authored["app_id"] = json!(app_id);
    authored["version"] = json!(version);
    authored
        .as_object_mut()
        .expect("manifest object")
        .remove("authorization");
    let compiled = compile_manifest_json(&authored.to_string()).expect("compile legacy manifest");
    let manifest = compile_sql_artifact_manifest(&compiled).expect("compile legacy SQL bundle");
    let mut client = connect_postgres(&database_url).expect("connect PostgreSQL");
    let schema = format!("kernel_legacy_history_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            "create schema \"{schema}\"; set search_path to \"{schema}\""
        ))
        .expect("create isolated legacy schema");

    let result = (|| -> Result<(), String> {
        client
            .batch_execute(&render_sql_artifact_bundle(&manifest))
            .map_err(|error| format!("install legacy bundle: {error}"))?;
        let runtime_role = scalar(
            &mut client,
            "select kernel_installer_capability_role('runtime')",
        )?;
        client
            .batch_execute(&format!("grant \"{runtime_role}\" to session_user"))
            .map_err(|error| format!("grant runtime capability: {error}"))?;
        let schema_json = serde_json::to_value(&compiled.schema).expect("serialize legacy schema");
        let revision_id: i64 = client
            .query_one(
                "insert into schema_revision (app_id,customer_id,version,base_schema,customer_overlay,schema,activated_at) values ($1,$2,$3,$4,'{}'::jsonb,$4,now()) returning id",
                &[&app_id, &CUSTOMER_ID, &version, &schema_json],
            )
            .map_err(|error| format!("insert active legacy revision: {error}"))?
        .get(0);
        client
            .execute(
                "select kernel_sync_schema_authorization_policy(id) from schema_revision where app_id=$1 and customer_id=$2 and version=$3",
                &[&app_id, &CUSTOMER_ID, &version],
            )
            .map_err(|error| format!("snapshot explicit legacy policy absence: {error}"))?;
        let principal = scalar(&mut client, "select session_user")?;
        assert_ok(&call(
            &mut client,
            "kernel_bind_principal_scope",
            json!({"principal_name":principal,"capability":"runtime","app_id":app_id,"customer_id":CUSTOMER_ID}),
        )?);
        client
            .batch_execute(&format!(
                r#"
                insert into change_set (
                  app_id, customer_id, schema_revision_id, created_with_mode, status,
                  source_kind, created_order, applied_order, applied_at
                ) values ('{app_id}', '{CUSTOMER_ID}', {revision_id}, 'mainline', 'mainline', 'fixture', 1, 1, now());
                insert into work_item_record (id,app_id,customer_id,external_key) values
                  ('10000000-0000-0000-0000-000000000001','{app_id}','{CUSTOMER_ID}','legacy');
                insert into work_item_version (
                  id,record_id,app_id,customer_id,stage,effective_start,change_set_id,applied_at,owner,summary
                ) values
                  ('10000000-0000-0000-0000-000000000011','10000000-0000-0000-0000-000000000001','{app_id}','{CUSTOMER_ID}','mainline','2026-01-01',1,now(),'legacy-owner','legacy history');
                "#
            ))
            .map_err(|error| format!("seed legacy history: {error}"))?;
        let history = call(
            &mut client,
            "kernel_field_history",
            json!({"app_id":app_id,"customer_id":CUSTOMER_ID,"model_id":"work_item","record_id":"10000000-0000-0000-0000-000000000001","field_id":"summary"}),
        )?;
        assert_ok(&history);
        assert_eq!(history["data"].as_array().map(Vec::len), Some(1));
        Ok(())
    })();

    let mut cleanup = connect_postgres(&database_url).expect("connect legacy cleanup client");
    cleanup
        .batch_execute(&format!("drop schema \"{schema}\" cascade"))
        .expect("drop isolated legacy schema");
    result.expect("legacy field history behavior");
}

fn policy_manifest() -> Value {
    json!({
      "app_id":APP_ID,"customer_id":CUSTOMER_ID,"version":VERSION,
      "models":[{"id":"work_item","kind":"entity","label":"Work item","fields":[
        {"id":"owner","label":"Owner","type":"text","required":true},
        {"id":"summary","label":"Summary","type":"text"}
      ]}],
      "authorization":{"roles":[{"id":"reviewer"},{"id":"owner_reader"}],"grants":[{
        "role":"reviewer","model":"work_item","operations":["history"],
        "read_fields":["summary"],
        "record":{"kind":"actor_equals_field","field":"owner"}
      },{
        "role":"owner_reader","model":"work_item","operations":["history"],
        "read_fields":["owner"],
        "record":{"kind":"actor_equals_field","field":"owner"}
      }]}
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
