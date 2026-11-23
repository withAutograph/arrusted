use std::env;

use kernel::connect_postgres;
use schema_compiler::{
    compile_manifest_json, compile_sql_artifact_manifest, render_sql_artifact_bundle,
};
use serde_json::{json, Value};
use uuid::Uuid;

const APP_ID: &str = "policy_query_fixture";
const CUSTOMER_ID: &str = "tenant_a";
const VERSION: &str = "policy-v1";

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
fn policy_enabled_data_query_requires_exact_actor_membership_and_filters_rows_before_query_expressions(
) {
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
        cleanup.remember_runtime_membership(&mut client, &installer_runtime_role)?;
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

        let malformed_membership = call(
            &mut client,
            "kernel_bind_actor_membership",
            json!({"principal_name":"malformed_fixture","app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"actor_a","role":"reviewer","active":"garbage"}),
        )?;
        assert_eq!(malformed_membership["ok"], false, "{malformed_membership}");
        assert_eq!(
            malformed_membership["error"]["code"], "contract_validation_failed",
            "{malformed_membership}"
        );

        let sql_null_required_fields: Option<Value> = None;
        let sql_null_error = client
            .query_one(
                "select kernel_policy_authorize_query($1, $2, $3, $4)",
                &[
                    &APP_ID,
                    &CUSTOMER_ID,
                    &"work_item",
                    &sql_null_required_fields,
                ],
            )
            .expect_err("SQL null required_fields must fail contract validation");
        assert!(
            sql_null_error
                .as_db_error()
                .is_some_and(|error| error.message().contains("contract_validation_failed")),
            "{sql_null_error:?}"
        );
        let json_null_error = client
            .query_one(
                "select kernel_policy_authorize_query($1, $2, $3, $4)",
                &[&APP_ID, &CUSTOMER_ID, &"work_item", &json!(null)],
            )
            .expect_err("JSON null required_fields must fail contract validation");
        assert!(
            json_null_error
                .as_db_error()
                .is_some_and(|error| error.message().contains("contract_validation_failed")),
            "{json_null_error:?}"
        );

        client
            .batch_execute(&format!(
                r#"
                insert into change_set (
                  app_id, customer_id, schema_revision_id, created_with_mode, status,
                  source_kind, created_order, applied_order, applied_at
                ) values ('{APP_ID}', '{CUSTOMER_ID}', 1, 'mainline', 'mainline', 'fixture', 1, 1, now());
                insert into work_item_record (id,app_id,customer_id,external_key) values
                  ('00000000-0000-0000-0000-000000000001','{APP_ID}','{CUSTOMER_ID}','mine'),
                  ('00000000-0000-0000-0000-000000000002','{APP_ID}','{CUSTOMER_ID}','other'),
                  ('00000000-0000-0000-0000-000000000003','{APP_ID}','{CUSTOMER_ID}','later');
                insert into work_item_version (
                  id,record_id,app_id,customer_id,stage,effective_start,change_set_id,applied_at,owner,summary,bucket,score,rate_amount,rate_currency,rate_period
                ) values
                  ('00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000001','{APP_ID}','{CUSTOMER_ID}','mainline','2026-01-01',1,now(),'actor_a','mine','review',2,10,'USD','hourly'),
                  ('00000000-0000-0000-0000-000000000012','00000000-0000-0000-0000-000000000002','{APP_ID}','{CUSTOMER_ID}','mainline','2026-01-01',1,now(),'actor_b','other','review',100,999,'USD','hourly'),
                  ('00000000-0000-0000-0000-000000000013','00000000-0000-0000-0000-000000000003','{APP_ID}','{CUSTOMER_ID}','mainline','2026-01-01',1,now(),'actor_a','later','planning',4,20,'USD','hourly');
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
        let roleless = call(
            &mut client,
            "kernel_bind_actor_access",
            json!({"actor_kind":"human","principal_name":principal,"app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"actor_a","active":true,"fence_generation":1}),
        )?;
        assert_eq!(
            roleless["ok"], false,
            "app admission must not replace named role policy"
        );

        client
            .batch_execute(&format!(
                r#"set session authorization "{principal}";
                   set kernel.actor_id = 'actor_a'"#
            ))
            .map_err(|error| format!("assume restricted policy principal: {error}"))?;
        let visible = call(
            &mut client,
            "kernel_data_query",
            json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_version":VERSION,"model_id":"work_item","as_of":"2026-01-01","select":["summary"]}),
        )?;
        assert_ok(&visible);
        assert_eq!(
            visible["data"],
            json!([
                {"values":{"summary":{"type":"text","value":"mine"}}},
                {"values":{"summary":{"type":"text","value":"later"}}}
            ])
        );

        let current_date = scalar(&mut client, "select current_date::text")?;
        let unsupported_alias_transfer = call(
            &mut client,
            "kernel_lookup_transfer_alias",
            json!({
                "app_id":APP_ID,"customer_id":CUSTOMER_ID,"model_id":"work_item",
                "source_record_id":"00000000-0000-0000-0000-000000000001",
                "target_record_id":"00000000-0000-0000-0000-000000000002",
                "alias":"transferred","effective_start":current_date,
                "expected_source_version_id":"00000000-0000-0000-0000-000000000011",
                "expected_target_version_id":"00000000-0000-0000-0000-000000000012",
                "schema_revision_id":"1","actor_id":"actor_a",
                "idempotency_key":"policy-alias-transfer-unsupported","reason":"fixture"
            }),
        )?;
        assert_eq!(
            unsupported_alias_transfer["ok"], false,
            "{unsupported_alias_transfer}"
        );
        assert_eq!(
            unsupported_alias_transfer["error"]["code"], "unsupported_capability",
            "{unsupported_alias_transfer}"
        );
        assert_eq!(
            unsupported_alias_transfer["error"]["message"], "This capability is not supported",
            "{unsupported_alias_transfer}"
        );
        assert_eq!(unsupported_alias_transfer["error"]["details"], json!([]));

        let per_row_field_union = call(
            &mut client,
            "kernel_data_query",
            json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_version":VERSION,"model_id":"work_item","as_of":"2026-01-01","select":["summary","bucket"]}),
        )?;
        assert_ok(&per_row_field_union);
        assert_eq!(
            per_row_field_union["data"],
            json!([
                {"values":{"summary":{"type":"text","value":"mine"},"bucket":{"type":"text","value":"review"}}},
                {"values":{"summary":{"type":"text","value":"later"},"bucket":{"type":"text","value":"planning"}}}
            ])
        );

        let paginated = call(
            &mut client,
            "kernel_data_query",
            json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_version":VERSION,"model_id":"work_item","as_of":"2026-01-01","select":["summary"],"order_by":[{"field":"summary","direction":"asc"}],"limit":1,"offset":1}),
        )?;
        assert_ok(&paginated);
        assert_eq!(
            paginated["data"],
            json!([{"values":{"summary":{"type":"text","value":"mine"}}}])
        );

        let grouped = call(
            &mut client,
            "kernel_data_query",
            json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_version":VERSION,"model_id":"work_item","as_of":"2026-01-01","kind":"aggregate","group_by":["bucket"],"metrics":[{"fn":"count"}]}),
        )?;
        assert_ok(&grouped);
        assert_eq!(
            grouped["data"],
            json!({"as_of":"2026-01-01","units":[null],"groups":[
                {"key":["planning"],"metrics":["1"]},
                {"key":["review"],"metrics":["1"]}
            ],"total":{"metrics":["2"]}})
        );

        let full_read_denied = call(
            &mut client,
            "kernel_data_query",
            json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_version":VERSION,"model_id":"work_item","as_of":"2026-01-01"}),
        )?;
        assert_eq!(full_read_denied["ok"], false, "{full_read_denied}");
        assert_eq!(
            full_read_denied["error"]["code"], "authorization_denied",
            "{full_read_denied}"
        );

        let count = call(
            &mut client,
            "kernel_data_query",
            json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_version":VERSION,"model_id":"work_item","as_of":"2026-01-01","kind":"aggregate","metrics":[{"fn":"count"}]}),
        )?;
        assert_ok(&count);
        assert_eq!(count["data"]["total"]["metrics"], json!(["2"]));
        aggregate_cases(&mut client)?;
        derived_field_cases(&mut client, &principal)?;

        let filter_denied = call(
            &mut client,
            "kernel_data_query",
            json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_version":VERSION,"model_id":"work_item","as_of":"2026-01-01","select":["summary"],"where":[{"field":"owner","op":"eq","value":"actor_a"}]}),
        )?;
        assert_eq!(filter_denied["ok"], false, "{filter_denied}");
        assert_eq!(
            filter_denied["error"]["code"], "authorization_denied",
            "{filter_denied}"
        );

        client
            .batch_execute("set kernel.actor_id = 'actor_b'")
            .map_err(|error| format!("forge actor binding: {error}"))?;
        let forged_actor_denied = call(
            &mut client,
            "kernel_data_query",
            json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_version":VERSION,"model_id":"work_item","as_of":"2026-01-01","select":["summary"]}),
        )?;
        assert_denied(&forged_actor_denied);

        client
            .batch_execute("set kernel.actor_id = 'actor_a'")
            .map_err(|error| format!("restore actor binding: {error}"))?;
        client
            .batch_execute(&format!(
                r#"set session authorization default;
                   update kernel_principal_scope set actor_id='different_actor'
                   where principal_name='{principal}' and capability='runtime';
                   set session authorization "{principal}";"#
            ))
            .map_err(|error| format!("bind actor-restricted principal: {error}"))?;
        let bound_actor_denied = call(
            &mut client,
            "kernel_data_query",
            json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_version":VERSION,"model_id":"work_item","as_of":"2026-01-01","select":["summary"]}),
        )?;
        assert_denied(&bound_actor_denied);
        client
            .batch_execute(&format!(
                r#"set session authorization default;
                   update kernel_principal_scope set actor_id=null
                   where principal_name='{principal}' and capability='runtime';
                   set session authorization "{principal}";"#
            ))
            .map_err(|error| format!("restore host delegation scope: {error}"))?;
        let cross_tenant_denied = call(
            &mut client,
            "kernel_data_query",
            json!({"app_id":APP_ID,"customer_id":"tenant_b","schema_version":VERSION,"model_id":"work_item","as_of":"2026-01-01","select":["summary"]}),
        )?;
        assert_denied(&cross_tenant_denied);

        client
            .batch_execute("reset kernel.actor_id")
            .map_err(|error| format!("clear actor binding: {error}"))?;
        let membership_denied = call(
            &mut client,
            "kernel_data_query",
            json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_version":VERSION,"model_id":"work_item","as_of":"2026-01-01","select":["summary"]}),
        )?;
        assert_eq!(membership_denied["ok"], false, "{membership_denied}");
        assert_eq!(
            membership_denied["error"]["code"], "authorization_denied",
            "{membership_denied}"
        );

        client
            .batch_execute(&format!(
                r#"set session authorization default;
                   update schema_authorization_policy_snapshot
                   set policy='{{}}'::jsonb
                   where app_id='{APP_ID}' and customer_id='{CUSTOMER_ID}';
                   set session authorization "{principal}";
                   set kernel.actor_id = 'actor_a'"#
            ))
            .map_err(|error| format!("alter isolated policy snapshot: {error}"))?;
        let catalog_drift = call(
            &mut client,
            "kernel_data_query",
            json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,"schema_version":VERSION,"model_id":"work_item","as_of":"2026-01-01","select":["summary"]}),
        )?;
        assert_eq!(catalog_drift["ok"], false, "{catalog_drift}");
        assert_eq!(
            catalog_drift["error"]["code"], "schema_drift",
            "{catalog_drift}"
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
      "models":[{"id":"work_item","kind":"entity","label":"Work item","extensions":{"typed_custom_fields":true},"fields":[
        {"id":"owner","label":"Owner","type":"text","required":true},
        {"id":"summary","label":"Summary","type":"text"},
        {"id":"bucket","label":"Bucket","type":"text"},
        {"id":"status","label":"Status","type":"enum","option_set":[{"id":"draft","label":"Draft"},{"id":"approved","label":"Approved"},{"id":"rejected","label":"Rejected"}]},
        {"id":"day","label":"Day","type":"date"},
        {"id":"score","label":"Score","type":"number"},
        {"id":"secret","label":"Secret","type":"number"},
        {"id":"rate","label":"Rate","type":"money_rate"}
      ],"derived_fields":[
        {"id":"computed_score","label":"Computed score","type":"number","expression":{"type":"multiply","left":{"type":"field","field":"score"},"right":{"type":"literal","value":{"type":"number","value":"2"}}}},
        {"id":"computed_bucket","label":"Computed bucket","type":"text","expression":{"type":"concat","expressions":[{"type":"field","field":"bucket"},{"type":"literal","value":{"type":"text","value":"-x"}}]}},
        {"id":"computed_secret","label":"Computed secret","type":"number","expression":{"type":"add","left":{"type":"field","field":"computed_score"},"right":{"type":"field","field":"secret"}}}
      ],"many_relations":[{"id":"watchers","label":"Watchers","target_model":"work_item"}]}],
      "custom_fields":[{"id":"work_item_custom_score","model":"work_item","field":"custom_score",
        "label":"Custom score","type":"number","archived_at":null},
        {"id":"work_item_custom_status","model":"work_item","field":"custom_status","label":"Custom status","type":"enum","archived_at":null,
        "option_set":[{"id":"draft","label":"Draft"},{"id":"approved","label":"Approved"},{"id":"rejected","label":"Rejected"}]}],
      "authorization":{"roles":[{"id":"reviewer"},{"id":"auditor"}],"grants":[
        {
          "role":"auditor","model":"work_item","operations":["read"],
          "read_fields":["summary"],"record":{"kind":"all"}
        },
        {
          "role":"reviewer","model":"work_item","operations":["read"],
          "read_fields":["summary"],
          "record":{"kind":"actor_equals_field","field":"owner"}
        },
        {
          "role":"reviewer","model":"work_item","operations":["read"],
          "read_fields":["bucket","score","custom_score","rate","day","status","custom_status"],
          "record":{"kind":"actor_equals_field","field":"owner"}
        }
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

// A derived field is readable only when every stored field it reads is, in
// every position a request can name it, and a custom definition can never
// stand in for a declared field.
fn derived_field_cases(client: &mut postgres::Client, principal: &str) -> Result<(), String> {
    let query = |client: &mut postgres::Client, extra: Value| -> Result<Value, String> {
        let mut request = json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,
            "schema_version":VERSION,"model_id":"work_item","as_of":"2026-01-01"});
        request
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        call(client, "kernel_data_query", request)
    };
    let selected = query(
        client,
        json!({"select":["summary","computed_score"],"order_by":[{"field":"computed_score","direction":"asc"}]}),
    )?;
    assert_ok(&selected);
    // aggregate_cases tombstoned `mine`, so only `later` is still visible.
    assert_eq!(
        selected["data"],
        json!([{"custom_fields":[{"field_id":"computed_score","type":"number","value":"8"}],
            "values":{"summary":{"type":"text","value":"later"}}}])
    );
    for extra in [
        json!({"select":["summary","computed_secret"]}),
        json!({"select":["summary"],"order_by":[{"field":"computed_secret","direction":"asc"}]}),
        json!({"select":["summary"],"where":[{"field":"computed_secret","op":"gt","value":"0"}]}),
        json!({"kind":"aggregate","metrics":[{"fn":"count"}],"group_by":["computed_secret"]}),
        json!({"kind":"aggregate","metrics":[{"fn":"count"}],
            "group_by":[{"field":"computed_secret","bins":{"edges":["0","10"]}}]}),
    ] {
        assert_denied(&query(client, extra)?);
    }

    // Even stored custom derived fields that reuse the declared `secret` id
    // or the `watchers` many-relation id (validation rejects both) leave each
    // authorized as the declared element, and change no other read.
    let shadow = |field_id: &str| {
        json!({"id":format!("work_item_{field_id}_shadow"),"model_id":"work_item","field_id":field_id,
            "label":field_id,"type":"number","target_model_id":null,"option_set":[],
            "expression":{"type":"literal","value":{"type":"number","value":"0"}},
            "origin":"tenant","management":"tenant_managed","lifecycle":"active"})
    };
    let shadows = json!([shadow("secret"), shadow("watchers"), shadow("owner")]);
    let set_schema = |client: &mut postgres::Client, update: &str| {
        client
            .batch_execute(&format!(
                r#"set session authorization default;
                   update schema_revision set schema = {update}
                   where app_id='{APP_ID}' and customer_id='{CUSTOMER_ID}';
                   set session authorization "{principal}";
                   set kernel.actor_id = 'actor_a'"#
            ))
            .map_err(|error| format!("update isolated active schema: {error}"))
    };
    let unchanged = [
        json!({}),
        json!({"kind":"aggregate","metrics":[{"fn":"count"}]}),
        json!({"select":["summary","score"]}),
    ];
    let before = unchanged
        .iter()
        .map(|extra| query(client, extra.clone()))
        .collect::<Result<Vec<_>, _>>()?;
    set_schema(
        client,
        &format!(
            "jsonb_set(schema, '{{custom_fields}}', schema->'custom_fields' || '{shadows}'::jsonb)"
        ),
    )?;
    let shadowed = [
        json!({"select":["summary","secret"]}),
        json!({"select":["summary"],"where":[{"field":"secret","op":"gt","value":"0"}]}),
        json!({"select":["summary"],"order_by":[{"field":"secret","direction":"asc"}]}),
        json!({"kind":"aggregate","metrics":[{"fn":"sum","field":"secret"}]}),
        json!({"select":["summary","watchers"]}),
        // `owner` drives the record policy; its shadow changes nothing either.
        json!({"select":["summary","owner"]}),
    ]
    .into_iter()
    .chain(unchanged.iter().cloned())
    .map(|extra| query(client, extra))
    .collect::<Result<Vec<_>, _>>();
    set_schema(
        client,
        "jsonb_set(schema, '{custom_fields}', (select coalesce(jsonb_agg(value), '[]'::jsonb) from jsonb_array_elements(schema->'custom_fields') where value->>'id' not like '%_shadow'))",
    )?;
    let shadowed = shadowed?;
    let (denied, after) = shadowed.split_at(6);
    for result in denied {
        assert_denied(result);
    }
    assert_eq!(after, before.as_slice());

    // A shadow on a retired declared field is ignored as well.
    client
        .batch_execute(&format!(
            "set session authorization default;
             create temporary table saved_schema as select schema from schema_revision
             where app_id='{APP_ID}' and customer_id='{CUSTOMER_ID}'"
        ))
        .map_err(|error| format!("save active schema: {error}"))?;
    let retired_secret = "jsonb_set(schema, '{models,0,fields}', (select jsonb_agg(case when value->>'id'='secret' then value || '{\"lifecycle\":\"retired\"}'::jsonb else value end order by ordinality) from jsonb_array_elements(schema->'models'->0->'fields') with ordinality))";
    set_schema(
        client,
        &format!("jsonb_set({retired_secret}, '{{custom_fields}}', schema->'custom_fields' || '[{}]'::jsonb)", shadow("secret")),
    )?;
    let retired = query(client, json!({"select":["summary","secret"]}));
    client
        .batch_execute(&format!(
            r#"set session authorization default;
               update schema_revision set schema = (select schema from saved_schema)
               where app_id='{APP_ID}' and customer_id='{CUSTOMER_ID}';
               drop table saved_schema;
               set session authorization "{principal}";
               set kernel.actor_id = 'actor_a'"#
        ))
        .map_err(|error| format!("restore active schema: {error}"))?;
    let retired = retired?;
    assert_eq!(retired["ok"], false, "{retired}");

    // A stored custom value under a declared id is never returned: the id
    // always means the declared field.
    let set_stored = |client: &mut postgres::Client, entries: &str| {
        client
            .batch_execute(&format!(
                r#"set session authorization default;
                   update work_item_version set custom_fields = custom_fields || '{entries}'::jsonb
                   where summary = 'later';
                   set session authorization "{principal}";
                   set kernel.actor_id = 'actor_a'"#
            ))
            .map_err(|error| format!("store custom entries: {error}"))
    };
    let stored = r#"[{"field_id":"score","type":"number","value":"5"},{"field_id":"watchers","type":"number","value":"5"}]"#;
    set_stored(client, stored)?;
    let scored = query(client, json!({"select":["summary","score"]}));
    client
        .batch_execute(&format!(
            r#"set session authorization default;
               update work_item_version set custom_fields = (select coalesce(jsonb_agg(value), '[]'::jsonb) from jsonb_array_elements(custom_fields) where value->>'field_id' not in ('score','watchers'))
               where summary = 'later';
               set session authorization "{principal}";
               set kernel.actor_id = 'actor_a'"#
        ))
        .map_err(|error| format!("restore custom entries: {error}"))?;
    let scored = scored?;
    assert_ok(&scored);
    assert_eq!(scored, before[2], "{scored}");
    Ok(())
}

// Uses the same restricted principal as selected reads: hidden actor_b values
// must never enter a metric, and metric/bin/group fields require read grants.
fn aggregate_cases(client: &mut postgres::Client) -> Result<(), String> {
    let query = |client: &mut postgres::Client, extra: Value| -> Result<Value, String> {
        let mut request = json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,
            "schema_version":VERSION,"model_id":"work_item","as_of":"2026-01-01",
            "kind":"aggregate","metrics":[{"fn":"count"}]});
        request
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        call(client, "kernel_data_query", request)
    };
    // Derived fields aggregate like stored fields and are authorized through
    // the stored fields their expressions read.
    for (extra, expected) in [
        (
            json!({"metrics":[{"fn":"sum","field":"computed_score"}]}),
            json!([{"key":[],"metrics":["12"]}]),
        ),
        (
            json!({"group_by":["computed_bucket"]}),
            json!([{"key":["planning-x"],"metrics":["1"]},{"key":["review-x"],"metrics":["1"]}]),
        ),
        (
            json!({"group_by":[{"field":"computed_score","bins":{"edges":["0","10"]}}]}),
            json!([{"key":[{"from":"0","to":"10"}],"metrics":["2"]}]),
        ),
    ] {
        let result = query(client, extra)?;
        assert_ok(&result);
        assert_eq!(result["data"]["groups"], expected, "{result}");
    }
    for extra in [
        json!({"metrics":[{"fn":"sum","field":"computed_secret"}]}),
        json!({"where":[{"field":"computed_secret","op":"gt","value":"0"}]}),
    ] {
        assert_denied(&query(client, extra)?);
    }
    // Computed columns are authorized through the stored fields they read,
    // directly or through a derived field, wherever the request uses them.
    let field = |id: &str| json!({"type":"field","field":id});
    let one = json!({"type":"literal","value":{"type":"number","value":"1"}});
    for expression in [
        json!({"type":"multiply","left":field("secret"),"right":one}),
        json!({"type":"multiply","left":field("computed_secret"),"right":one}),
    ] {
        let computed = json!([{"id":"leak","type":"number","expression":expression}]);
        for extra in [
            json!({"computed":computed,"metrics":[{"fn":"sum","field":"leak"}]}),
            json!({"computed":computed,"group_by":["leak"]}),
            json!({"computed":computed,"group_by":[{"field":"leak","bins":{"edges":["0","10"]}}]}),
            json!({"computed":computed,"where":[{"field":"leak","op":"gt","value":"0"}]}),
        ] {
            assert_denied(&query(client, extra)?);
        }
        for extra in [
            json!({"computed":computed,"select":["summary","leak"]}),
            json!({"computed":computed,"select":["summary"],"where":[{"field":"leak","op":"gt","value":"0"}]}),
            json!({"computed":computed,"select":["summary"],"order_by":[{"field":"leak","direction":"asc"}]}),
        ] {
            let mut request = json!({"app_id":APP_ID,"customer_id":CUSTOMER_ID,
                "schema_version":VERSION,"model_id":"work_item","as_of":"2026-01-01"});
            request
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            assert_denied(&call(client, "kernel_data_query", request)?);
        }
    }
    let granted = query(
        client,
        json!({"computed":[{"id":"doubled","type":"number","expression":{"type":"multiply","left":field("score"),"right":one}}],
            "metrics":[{"fn":"sum","field":"doubled"}]}),
    )?;
    assert_ok(&granted);
    assert_eq!(
        granted["data"]["total"]["metrics"],
        json!(["6"]),
        "{granted}"
    );
    for (field, expected) in [
        ("score", ["2", "6", "3", "2", "4", "3", "2.5"]),
        ("rate", ["2", "30", "15", "10", "20", "15", "12.5"]),
    ] {
        let metrics = json!([
            {"fn":"count_distinct","field":field}, {"fn":"sum","field":field},
            {"fn":"avg","field":field}, {"fn":"min","field":field},
            {"fn":"max","field":field}, {"fn":"median","field":field},
            {"fn":"percentile","field":field,"p":0.25}
        ]);
        let result = query(client, json!({"metrics":metrics}))?;
        assert_ok(&result);
        assert_eq!(result["data"]["as_of"], "2026-01-01");
        let unit = if field == "rate" {
            json!({"currency":"USD","period":"hourly"})
        } else {
            Value::Null
        };
        assert_eq!(result["data"]["units"], Value::Array(vec![unit; 7]));
        let values = result["data"]["groups"][0]["metrics"].as_array().unwrap();
        for (value, expected) in values.iter().zip(expected) {
            let actual: rust_decimal::Decimal = value
                .as_str()
                .expect("decimal string metric")
                .parse()
                .unwrap();
            assert_eq!(
                actual,
                expected.parse::<rust_decimal::Decimal>().unwrap(),
                "{result}"
            );
        }
        let empty = query(
            client,
            json!({"metrics":metrics,
            "where":[{"field":"summary","op":"eq","value":"absent"}]}),
        )?;
        assert_ok(&empty);
        assert_eq!(
            empty["data"]["units"],
            json!([null, null, null, null, null, null, null])
        );
        assert_eq!(
            empty["data"]["total"]["metrics"],
            json!(["0", null, null, null, null, null, null])
        );
        let single = query(
            client,
            json!({"metrics":metrics,
            "where":[{"field":"summary","op":"eq","value":"mine"}]}),
        )?;
        assert_ok(&single);
        assert_eq!(single["data"]["total"]["metrics"][0], "1");
    }
    let pair = query(client, json!({"group_by":["bucket","summary"]}))?;
    assert_ok(&pair);
    assert_eq!(pair["data"]["groups"].as_array().unwrap().len(), 2);
    assert_eq!(
        pair["data"]["groups"][0]["key"],
        json!(["planning", "later"])
    );
    assert_eq!(pair["data"]["groups"][1]["key"], json!(["review", "mine"]));
    for extra in [
        json!({"metrics":[{"fn":"sum","field":"secret"}]}),
        json!({"group_by":["owner"]}),
        json!({"group_by":[{"field":"secret","bins":{"edges":["0","10"]}}]}),
    ] {
        assert_denied(&query(client, extra)?);
    }
    let bins = query(
        client,
        json!({"group_by":[{"field":"score","bins":{"edges":["2","3","4"]}}]}),
    )?;
    assert_ok(&bins);
    assert_eq!(
        bins["data"]["groups"],
        json!([
            {"key":[{"from":"2","to":"3"}],"metrics":["1"]},
            {"key":[{"from":"3","to":"4"}],"metrics":["1"]}
        ])
    );
    let outside = query(
        client,
        json!({"group_by":[{"field":"score","bins":{"edges":["2.5","3.5"]}}]}),
    )?;
    assert_ok(&outside);
    let outside_groups = outside["data"]["groups"].as_array().unwrap();
    assert!(outside_groups.contains(&json!({"key":["below"],"metrics":["1"]})));
    assert!(outside_groups.contains(&json!({"key":["above"],"metrics":["1"]})));

    let principal = scalar(client, "select current_user::text")?;
    client.batch_execute("set session authorization default; update work_item_version set day=case when summary='mine' then date '2026-10-01' else date '2026-02-01' end, bucket='same'") .map_err(|e| e.to_string())?;
    client
        .batch_execute(&format!("set session authorization \"{principal}\""))
        .map_err(|e| e.to_string())?;
    let dates = query(client, json!({"group_by":["bucket","day"]}))?;
    assert_ok(&dates);
    assert_eq!(
        dates["data"]["groups"][0]["key"],
        json!(["same", "2026-02-01"])
    );
    assert_eq!(
        dates["data"]["groups"][1]["key"],
        json!(["same", "2026-10-01"])
    );
    client.batch_execute("set session authorization default; update work_item_version set bucket=case when summary='later' then 'planning' else 'review' end") .map_err(|e| e.to_string())?;
    client
        .batch_execute(&format!("set session authorization \"{principal}\""))
        .map_err(|e| e.to_string())?;
    for (mine, later, expected) in [
        ("10", "5", json!([["5"], ["10"]])),
        ("null", "5", json!([["5"], [null]])),
    ] {
        client.batch_execute(&format!("set session authorization default; update work_item_version set score=case when summary='mine' then {mine} else {later} end"))
            .map_err(|e| e.to_string())?;
        client
            .batch_execute(&format!("set session authorization \"{principal}\""))
            .map_err(|e| e.to_string())?;
        let ordered = query(client, json!({"group_by":["score"]}))?;
        assert_ok(&ordered);
        assert_eq!(
            Value::Array(
                ordered["data"]["groups"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|g| g["key"].clone())
                    .collect()
            ),
            expected
        );
    }
    for (mine, later, expected) in [
        (
            "0",
            "5",
            json!([[{"from":"0","to":"5"}],[{"from":"5","to":"10"}]]),
        ),
        ("-1", "5", json!([["below"], [{"from":"5","to":"10"}]])),
        ("5", "11", json!([[{"from":"5","to":"10"}], ["above"]])),
        ("-1", "11", json!([["below"], ["above"]])),
        ("11", "null", json!([["above"], [null]])),
    ] {
        client.batch_execute(&format!("set session authorization default; update work_item_version set score=case when summary='mine' then {mine} else {later} end")) .map_err(|e| e.to_string())?;
        client
            .batch_execute(&format!("set session authorization \"{principal}\""))
            .map_err(|e| e.to_string())?;
        let ordered = query(
            client,
            json!({"group_by":[{"field":"score","bins":{"edges":["0","5","10"]}}]}),
        )?;
        assert_ok(&ordered);
        assert_eq!(
            Value::Array(
                ordered["data"]["groups"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|g| g["key"].clone())
                    .collect()
            ),
            expected
        );
    }
    client.batch_execute("set session authorization default; update work_item_version set score=case when summary='mine' then 2 else 4 end") .map_err(|e| e.to_string())?;
    client
        .batch_execute(&format!("set session authorization \"{principal}\""))
        .map_err(|e| e.to_string())?;

    client
        .batch_execute(
            "set session authorization default;
        update work_item_version set rate_amount=20,rate_currency='EUR',rate_period='hourly'
        where summary='later'",
        )
        .map_err(|error| error.to_string())?;
    client
        .batch_execute(&format!("set session authorization \"{principal}\""))
        .map_err(|error| error.to_string())?;
    let money = query(client, json!({"metrics":[{"fn":"sum","field":"rate"}]}))?;
    assert_ok(&money);
    assert_eq!(money["data"]["groups"].as_array().unwrap().len(), 2);
    assert_eq!(money["data"]["total"]["metrics"], json!([null]));
    assert_eq!(money["data"]["units"], json!([null]));
    let money_bin = query(
        client,
        json!({"group_by":[{"field":"rate",
        "bins":{"edges":["0","30"]},"unit":{"currency":"USD","period":"hourly"}}]}),
    )?;
    assert_ok(&money_bin);
    assert_eq!(money_bin["data"]["other_units"], "1");
    assert_eq!(money_bin["data"]["total"]["metrics"], json!(["1"]));
    client
        .batch_execute(
            "set session authorization default;
        update work_item_version set rate_amount=20,rate_currency='USD',rate_period='daily'
        where summary='later'",
        )
        .map_err(|error| error.to_string())?;
    client
        .batch_execute(&format!("set session authorization \"{principal}\""))
        .map_err(|error| error.to_string())?;
    let periods = query(client, json!({"metrics":[{"fn":"sum","field":"rate"}]}))?;
    assert_ok(&periods);
    assert_eq!(periods["data"]["groups"].as_array().unwrap().len(), 2);
    assert_eq!(periods["data"]["total"]["metrics"], json!([null]));

    // Direct fixture inserts avoid 10,001 lifecycle round-trips while keeping
    // the same mainline/version representation used by the runtime.
    client
        .batch_execute("set session authorization default")
        .map_err(|error| error.to_string())?;
    client
        .batch_execute(&format!(
            r#"
        insert into work_item_record(id,app_id,customer_id,external_key)
        select md5('aggregate-record-'||i)::uuid,'{APP_ID}','{CUSTOMER_ID}','bulk-'||i
        from generate_series(1,10001) i;
        insert into work_item_version(id,record_id,app_id,customer_id,stage,effective_start,
            change_set_id,applied_at,owner,summary,score)
        select md5('aggregate-version-'||i)::uuid,md5('aggregate-record-'||i)::uuid,
            '{APP_ID}','{CUSTOMER_ID}','mainline','2027-01-01',1,now(),'actor_a','bulk',
            case when i=10001 then null else i end
        from generate_series(1,10001) i;
    "#
        ))
        .map_err(|error| error.to_string())?;
    client
        .batch_execute(&format!("set session authorization \"{principal}\""))
        .map_err(|error| error.to_string())?;
    let before = query(client, json!({}))?;
    assert_ok(&before);
    assert_eq!(before["data"]["total"]["metrics"], json!(["2"]));
    let large = query(
        client,
        json!({"as_of":"2028-01-01",
        "metrics":[{"fn":"count"},{"fn":"sum","field":"score"}]}),
    )?;
    assert_ok(&large);
    assert_eq!(
        large["data"]["total"]["metrics"],
        json!(["10003", "50005006"])
    );
    for field in ["score", "rate"] {
        let all_null = query(
            client,
            json!({"as_of":"2028-01-01",
            "where":[{"field":"score","op":"isNull"}],
            "metrics":[{"fn":"count"}, {"fn":"count_distinct","field":field},
                {"fn":"sum","field":field}, {"fn":"avg","field":field},
                {"fn":"min","field":field}, {"fn":"max","field":field},
                {"fn":"median","field":field},
                {"fn":"percentile","field":field,"p":0.25}]}),
        )?;
        assert_ok(&all_null);
        assert_eq!(
            all_null["data"]["total"]["metrics"],
            json!(["1", "0", null, null, null, null, null, null])
        );
        assert_eq!(
            all_null["data"]["groups"][0]["metrics"],
            json!(["1", "0", null, null, null, null, null, null])
        );
    }
    let null_group = query(client, json!({"as_of":"2028-01-01","group_by":["bucket"]}))?;
    assert_ok(&null_group);
    assert!(null_group["data"]["groups"]
        .as_array()
        .unwrap()
        .contains(&json!({"key":[null],"metrics":["10001"]})));
    client
        .batch_execute(
            "set session authorization default;
        update work_item_version set bucket=(score::integer % 101)::text where summary='bulk'",
        )
        .map_err(|error| error.to_string())?;
    client
        .batch_execute(&format!("set session authorization \"{principal}\""))
        .map_err(|error| error.to_string())?;
    // Fail if either grouped or total sorted metrics run before the key bound.
    client
        .batch_execute("set session authorization default")
        .map_err(|e| e.to_string())?;
    let percentile_definition = scalar(client,
        "select pg_get_functiondef('kernel_read_aggregate_percentile(numeric[],numeric)'::regprocedure)")?;
    client.batch_execute("create or replace function kernel_read_aggregate_percentile(amounts numeric[],p numeric) returns numeric language plpgsql as $$ begin raise exception 'metric evaluated before group bound'; end $$")
        .map_err(|e| e.to_string())?;
    client
        .batch_execute(&format!("set session authorization \"{principal}\""))
        .map_err(|e| e.to_string())?;
    let overflow = query(
        client,
        json!({"as_of":"2028-01-01","group_by":["bucket"],
        "metrics":[{"fn":"median","field":"score"},{"fn":"percentile","field":"score","p":0.9}]}),
    )?;
    assert_eq!(overflow["ok"], false, "{overflow}");
    assert_eq!(overflow["error"]["code"], "query_rejected", "{overflow}");
    assert!(overflow["error"]["message"]
        .as_str()
        .unwrap()
        .contains("group limit exceeded"));
    client
        .batch_execute("set session authorization default")
        .map_err(|e| e.to_string())?;
    client
        .batch_execute(&percentile_definition)
        .map_err(|e| e.to_string())?;
    // An all-record grant keeps the assertion independent of the cleared
    // owner field: the record remains authorized even as a tombstone event.
    client
        .batch_execute("set session authorization default")
        .map_err(|error| error.to_string())?;
    assert_ok(&call(
        client,
        "kernel_bind_actor_membership",
        json!({"actor_kind":"human",
            "principal_name":principal,"app_id":APP_ID,"customer_id":CUSTOMER_ID,
            "actor_id":"actor_a","role":"auditor"
        }),
    )?);
    client
        .batch_execute(&format!("set session authorization \"{principal}\""))
        .map_err(|error| error.to_string())?;
    let before_tombstone = query(client, json!({}))?;
    assert_ok(&before_tombstone);
    assert_eq!(before_tombstone["data"]["total"]["metrics"], json!(["3"]));
    client
        .batch_execute(
            "set session authorization default;
        update work_item_version set tombstones_record=true,
            owner=null,summary=null,bucket=null,score=null,secret=null,day=null,
            rate_amount=null,rate_currency=null,rate_period=null,custom_fields='[]'::jsonb
        where summary='mine'",
        )
        .map_err(|error| error.to_string())?;
    client
        .batch_execute(&format!("set session authorization \"{principal}\""))
        .map_err(|error| error.to_string())?;
    let tombstoned = query(client, json!({}))?;
    assert_ok(&tombstoned);
    assert_eq!(tombstoned["data"]["total"]["metrics"], json!(["2"]));
    // Equal numeric values must share identity regardless of stored decimal scale.
    client
        .batch_execute("set session authorization default")
        .map_err(|e| e.to_string())?;
    assert_ok(&call(
        client,
        "kernel_bind_actor_membership",
        json!({"actor_kind":"human","principal_name":principal,"app_id":APP_ID,"customer_id":CUSTOMER_ID,
            "actor_id":"actor_a","role":"reviewer"}),
    )?);
    client
        .batch_execute(&format!(
            r#"
        insert into work_item_record(id,app_id,customer_id,external_key)
        select md5('scale-record-'||i)::uuid,'{APP_ID}','{CUSTOMER_ID}','scale-'||i
        from generate_series(1,3) i;
        insert into work_item_version(id,record_id,app_id,customer_id,stage,effective_start,
            change_set_id,applied_at,owner,summary,score,custom_fields)
        select md5('scale-version-'||i)::uuid,md5('scale-record-'||i)::uuid,
            '{APP_ID}','{CUSTOMER_ID}','mainline','2029-01-01',1,now(),'actor_a','scale',
            value::numeric,jsonb_build_array(jsonb_build_object('field_id','custom_score',
                'type','number','value',value))
        from (values (1,'1'),(2,'1.0'),(3,'1.00')) v(i,value);
    "#
        ))
        .map_err(|e| e.to_string())?;
    client
        .batch_execute(&format!("set session authorization \"{principal}\""))
        .map_err(|e| e.to_string())?;
    for fields in [
        json!(["score"]),
        json!(["custom_score"]),
        json!(["score", "custom_score"]),
    ] {
        let result = query(
            client,
            json!({"as_of":"2029-01-01","group_by":fields,
            "where":[{"field":"summary","op":"eq","value":"scale"}],
            "metrics":[{"fn":"count"},{"fn":"count_distinct","field":"score"},
                {"fn":"count_distinct","field":"custom_score"}]}),
        )?;
        assert_ok(&result);
        let key = vec![json!("1"); fields.as_array().unwrap().len()];
        assert_eq!(
            result["data"]["groups"],
            json!([{"key":key,"metrics":["3","1","1"]}])
        );
    }
    client.batch_execute(&format!(r#"
        set session authorization default;
        insert into work_item_record(id,app_id,customer_id,external_key)
        select md5('enum-record-'||i)::uuid,'{APP_ID}','{CUSTOMER_ID}','enum-'||i
        from generate_series(1,4) i;
        insert into work_item_version(id,record_id,app_id,customer_id,stage,effective_start,
            change_set_id,applied_at,owner,summary,status,custom_fields)
        select md5('enum-version-'||i)::uuid,md5('enum-record-'||i)::uuid,
            '{APP_ID}','{CUSTOMER_ID}','mainline','2029-01-01',1,now(),'actor_a','enum',
            value,case when value is null then '[]'::jsonb else
            jsonb_build_array(jsonb_build_object('field_id','custom_status','type','enum','value',value)) end
        from (values (1,'approved'),(2,'rejected'),(3,'draft'),(4,null)) v(i,value);
        set session authorization "{principal}";
    "#)).map_err(|e| e.to_string())?;
    for field in ["status", "custom_status"] {
        for fields in [
            json!([field]),
            json!([field, "summary"]),
            json!(["summary", field]),
        ] {
            let result = query(
                client,
                json!({"as_of":"2029-01-01","group_by":fields,
                "where":[{"field":"summary","op":"eq","value":"enum"}]}),
            )?;
            assert_ok(&result);
            let index = if fields[0] == "summary" { 1 } else { 0 };
            let keys: Vec<Value> = result["data"]["groups"]
                .as_array()
                .unwrap()
                .iter()
                .map(|group| group["key"][index].clone())
                .collect();
            assert_eq!(
                keys,
                vec![
                    json!("draft"),
                    json!("approved"),
                    json!("rejected"),
                    Value::Null
                ],
                "{result}"
            );
        }
    }
    Ok(())
}
