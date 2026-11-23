use std::env;

use kernel::{
    connect_postgres, AppId, ChangeType, CustomerId, Field, FieldId, FieldType, Model, ModelId,
    ModelKind, Schema, SchemaVersion,
};
use postgres::error::SqlState;
use postgres::types::{ToSql, Type};
use postgres::{Client, Transaction};
use schema_compiler::{
    compile_sql_artifact_manifest, render_sql_artifact_bundle, CompiledManifest,
    NormalizedManifestExtras,
};
use serde_json::{json, Value};
use uuid::Uuid;

mod support;

const APP_ID: &str = "rls_app";

struct TestDatabase {
    client: Client,
    schema_name: String,
    role_name: String,
    query_role: String,
}

impl TestDatabase {
    fn connect(session_role_is_tenant_owner: bool) -> Option<Self> {
        let database_url = match env::var("KERNEL_TEST_DATABASE_URL") {
            Ok(url) => url,
            Err(env::VarError::NotPresent) => {
                eprintln!(
                    "skipping generated SQL RLS parity test: KERNEL_TEST_DATABASE_URL is absent"
                );
                return None;
            }
            Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
        };
        let mut client = connect_postgres(&database_url).expect("connect generated SQL RLS test");
        let suffix = Uuid::new_v4().simple();
        let schema_name = format!("kernel_rls_{suffix}");
        let role_name = format!("kernel_rls_caller_{suffix}");
        client
            .batch_execute(&format!(
                r#"
                create role "{role_name}" nologin {} nobypassrls;
                grant "{role_name}" to current_user;
                create schema "{schema_name}"{};
                set search_path to "{schema_name}";
                {}
                "#,
                if session_role_is_tenant_owner {
                    "createrole"
                } else {
                    "nocreaterole"
                },
                if session_role_is_tenant_owner {
                    format!(" authorization \"{role_name}\"")
                } else {
                    String::new()
                },
                if session_role_is_tenant_owner {
                    format!("set role \"{role_name}\";")
                } else {
                    String::new()
                },
            ))
            .expect("provision generated SQL RLS roles and schema");
        support::trusted_human::before_install(&mut client);

        let schema = test_schema("tenant_a");
        let manifest = compile_sql_artifact_manifest(&compiled_manifest(schema.clone()))
            .expect("compile generated SQL RLS bundle");
        client
            .batch_execute(&render_sql_artifact_bundle(&manifest))
            .unwrap_or_else(|error| panic!("install generated SQL RLS bundle: {error:?}"));
        let capability_roles: Vec<String> = ["execution_owner", "runtime", "schema_admin", "query"]
            .into_iter()
            .map(|capability| {
                client
                    .query_one(
                        "select kernel_installer_capability_role($1)",
                        &[&capability],
                    )
                    .expect("read generated capability role")
                    .get(0)
            })
            .collect();
        let query_role = capability_roles[3].clone();
        client
            .batch_execute(&format!(
                "grant \"{}\" to \"{role_name}\"; grant \"{}\" to current_user",
                query_role.replace('"', "\"\""),
                query_role.replace('"', "\"\"")
            ))
            .expect("grant generated query role to test caller");
        seed_schema_revisions(&mut client, &schema);

        if !session_role_is_tenant_owner {
            client
                .batch_execute(&format!(
                    r#"
                    grant usage on schema "{schema_name}" to "{role_name}";
                    grant select, insert, update, delete on all tables in schema "{schema_name}" to "{role_name}";
                    grant usage, select on all sequences in schema "{schema_name}" to "{role_name}";
                    "#
                ))
                .expect("grant direct RLS test role privileges");
        }

        Some(Self {
            client,
            schema_name,
            role_name,
            query_role,
        })
    }

    fn set_scope(&mut self, customer_id: &str) {
        self.client
            .execute(
                "select set_config('kernel.app_id', $1, false), set_config('kernel.customer_id', $2, false)",
                &[&APP_ID, &customer_id],
            )
            .expect("set generated SQL tenant scope");
    }

    fn run_visible_query(
        &mut self,
        customer_id: &str,
        sql: &str,
        parameter_types: &[Type],
        parameters: &[&(dyn ToSql + Sync)],
        validate_plan: bool,
        timeout_ms: Option<u64>,
    ) -> Result<Vec<Value>, QueryFailure> {
        let mut transaction = self.client.transaction().expect("begin visible query");
        let prepared = prepare_visible_query(&mut transaction, &self.schema_name, customer_id);
        if let Err(error) = prepared {
            transaction.rollback().expect("rollback rejected prepare");
            return Err(error);
        }
        transaction
            .batch_execute(&format!(
                "set local search_path to pg_temp; set local role \"{}\"; set local statement_timeout = '{}ms'",
                self.query_role.replace('"', "\"\""),
                timeout_ms.unwrap_or(1_000)
            ))
            .expect("bind generated visible-query read role");
        if validate_plan {
            let validation: Value = match transaction.query_one(
                &format!(
                    "select \"{}\".kernel_validate_visible_query($1)",
                    self.schema_name
                ),
                &[&sql],
            ) {
                Ok(row) => row.get(0),
                Err(error) => {
                    let timeout = error.code() == Some(&SqlState::QUERY_CANCELED);
                    transaction
                        .rollback()
                        .expect("rollback failed query validation");
                    return Err(if timeout {
                        QueryFailure::Timeout
                    } else {
                        QueryFailure::Rejected(error.code().map_or_else(
                            || "query_rejected".to_string(),
                            |code| code.code().into(),
                        ))
                    });
                }
            };
            if validation["ok"] != json!(true) {
                let code = validation["error"]["code"]
                    .as_str()
                    .unwrap_or("query_rejected")
                    .to_string();
                let message = validation["error"]["message"]
                    .as_str()
                    .unwrap_or("query rejected");
                transaction.rollback().expect("rollback rejected query");
                return Err(QueryFailure::Rejected(format!("{code}: {message}")));
            }
        }

        let wrapped =
            format!("select to_jsonb(kernel_query_result) from ({sql}) kernel_query_result");
        let statement = match transaction.prepare_typed(&wrapped, parameter_types) {
            Ok(statement) => statement,
            Err(error) => {
                transaction
                    .rollback()
                    .expect("rollback rejected preparation");
                return Err(QueryFailure::Rejected(error.code().map_or_else(
                    || "query_rejected".to_string(),
                    |code| code.code().into(),
                )));
            }
        };
        let rows =
            match transaction.query(&statement, parameters) {
                Ok(rows) => rows,
                Err(error) => {
                    let timeout = error.code() == Some(&SqlState::QUERY_CANCELED);
                    transaction.rollback().expect("rollback failed query");
                    return Err(if timeout {
                        QueryFailure::Timeout
                    } else {
                        QueryFailure::Rejected(error.code().map_or_else(
                            || "query_rejected".to_string(),
                            |code| code.code().into(),
                        ))
                    });
                }
            };
        let values = rows.into_iter().map(|row| row.get(0)).collect();
        transaction.rollback().expect("rollback visible query");
        Ok(values)
    }
}

impl Drop for TestDatabase {
    fn drop(&mut self) {
        let _ = self.client.batch_execute("reset role; reset search_path");
        support::drop_generated_sql_fixture(&mut self.client, &self.schema_name);
        let _ = self.client.batch_execute("discard temp");
        let _ = self.client.batch_execute(&format!(
            r#"
            revoke "{}" from current_user;
            drop role if exists "{}";
            "#,
            self.role_name.replace('"', "\"\""),
            self.role_name
        ));
    }
}

#[derive(Debug, PartialEq, Eq)]
enum QueryFailure {
    Rejected(String),
    Timeout,
}

#[test]
fn rls_hides_and_blocks_cross_customer_rows_for_non_owner_role() {
    let Some(mut database) = TestDatabase::connect(false) else {
        return;
    };
    seed_tenant_rows(&mut database);

    let mut transaction = database.client.transaction().expect("begin RLS assertion");
    transaction
        .batch_execute(&format!(
            r#"
            set local role "{}";
            select set_config('kernel.app_id', 'rls_app', true);
            select set_config('kernel.customer_id', 'tenant_a', true);
            "#,
            database.role_name
        ))
        .expect("bind non-owner tenant role");
    for table in [
        "schema_revision",
        "change_set",
        "company_record",
        "employee_record",
        "employee_version",
    ] {
        let visible: i64 = transaction
            .query_one(&format!("select count(*) from {table}"), &[])
            .unwrap_or_else(|error| panic!("read {table} under RLS: {error:?}"))
            .get(0);
        assert_eq!(visible, 1, "{table} should expose only the tenant row");
    }
    assert_eq!(
        transaction
            .execute(
                "update company_record set external_key = 'blocked' where customer_id = 'tenant_b'",
                &[],
            )
            .expect("cross-tenant update is hidden"),
        0
    );
    assert_eq!(
        transaction
            .execute(
                "delete from employee_version where customer_id = 'tenant_b'",
                &[],
            )
            .expect("cross-tenant delete is hidden"),
        0
    );
    let blocked = transaction
        .execute(
            "insert into company_record (id, app_id, customer_id) values ('00000000-0000-0000-0000-000000000099', 'rls_app', 'tenant_b')",
            &[],
        )
        .expect_err("RLS blocks a cross-tenant insert");
    assert_eq!(blocked.code(), Some(&SqlState::INSUFFICIENT_PRIVILEGE));
    transaction.rollback().expect("rollback RLS assertion");
}

#[test]
fn tenant_scoped_foreign_keys_reject_cross_customer_links() {
    let Some(mut database) = TestDatabase::connect(false) else {
        return;
    };
    database.set_scope("tenant_b");
    database
        .client
        .execute(
            "insert into company_record (id, app_id, customer_id, external_key) values ('00000000-0000-0000-0000-000000000002', $1, 'tenant_b', 'b')",
            &[&APP_ID],
        )
        .expect("seed tenant B company");
    database.set_scope("tenant_a");
    database
        .client
        .batch_execute(
            r#"
            insert into employee_record (id, app_id, customer_id, external_key)
            values ('00000000-0000-0000-0000-000000000011', 'rls_app', 'tenant_a', 'a');
            insert into change_set (
              id, app_id, customer_id, schema_revision_id, created_with_mode, status,
              source_kind, created_order, applied_order, applied_at
            ) values (11, 'rls_app', 'tenant_a', 1, 'mainline', 'mainline', 'test', 1, 1, now());
            "#,
        )
        .expect("seed tenant A relation source");
    let blocked = database
        .client
        .execute(
            r#"
            insert into employee_version (
              id, record_id, employer, app_id, customer_id, stage,
              effective_start, change_set_id, applied_at, name
            ) values (
              '00000000-0000-0000-0000-000000000010',
              '00000000-0000-0000-0000-000000000011',
              '00000000-0000-0000-0000-000000000002',
              'rls_app', 'tenant_a', 'mainline', '2026-08-04', 11, now(), 'Alice'
            )
            "#,
            &[],
        )
        .expect_err("tenant-composite relation FK blocks cross-tenant target");
    assert_eq!(blocked.code(), Some(&SqlState::FOREIGN_KEY_VIOLATION));
}

#[test]
fn query_visible_sql_rejects_unsafe_sql_and_read_role_has_no_write_grants() {
    let Some(mut database) = TestDatabase::connect(false) else {
        return;
    };
    let query_role = database
        .client
        .query_one(
            "select rolcanlogin, rolbypassrls from pg_roles where rolname = $1",
            &[&database.query_role],
        )
        .expect("read generated query role attributes");
    assert!(!query_role.get::<_, bool>("rolcanlogin"));
    assert!(!query_role.get::<_, bool>("rolbypassrls"));
    seed_query_rows(&mut database);

    for sql in [
        "select 1; select 2",
        "insert into company_record (id) values (gen_random_uuid())",
        "create table query_escape (id int)",
        "update change_set set notes = 'bad'",
        "delete from change_set",
        "select set_config('kernel.customer_id', 'tenant_b', true)",
        "select count(*) from pg_catalog.pg_tables",
        "select count(*) from pg_tables",
        "select count(*) from information_schema.tables",
    ] {
        assert!(matches!(
            database.run_visible_query("tenant_a", sql, &[], &[], true, None),
            Err(QueryFailure::Rejected(_))
        ));
    }
    let qualified = format!(
        "select count(*) from \"{}\".company_record",
        database.schema_name
    );
    assert!(matches!(
        database.run_visible_query("tenant_a", &qualified, &[], &[], true, None),
        Err(QueryFailure::Rejected(_))
    ));
    assert_eq!(
        database
            .run_visible_query("tenant_a", "select 'pg_foo' as label", &[], &[], true, None,)
            .expect("incidental catalog-like text is safe"),
        vec![json!({"label": "pg_foo"})]
    );
    assert_eq!(
        database.run_visible_query("tenant_a", "select pg_sleep(1)", &[], &[], true, Some(1),),
        Err(QueryFailure::Timeout)
    );

    let mut transaction = database
        .client
        .transaction()
        .expect("begin read-role ACL test");
    transaction
        .batch_execute(&format!(
            "set local search_path to \"{}\"; set local role \"{}\"",
            database.schema_name,
            database.query_role.replace('"', "\"\"")
        ))
        .expect("assume generated read role");
    let blocked = transaction
        .execute(
            "insert into change_set (app_id, customer_id, schema_revision_id, created_with_mode, status, source_kind, created_order) values ('rls_app', 'tenant_a', 1, 'mainline', 'mainline', 'test', 100)",
            &[],
        )
        .expect_err("generated query role has no base-table write grant");
    assert_eq!(blocked.code(), Some(&SqlState::INSUFFICIENT_PRIVILEGE));
    transaction.rollback().expect("rollback read-role ACL test");
}

#[test]
fn query_visible_sql_sets_tenant_scope_before_schema_resolution_for_non_bypass_roles() {
    let Some(mut database) = TestDatabase::connect(true) else {
        return;
    };
    database.set_scope("tenant_a");
    database
        .client
        .batch_execute(
            r#"
            insert into change_set (
              id, app_id, customer_id, schema_revision_id, created_with_mode, status,
              source_kind, created_order, applied_order, applied_at
            ) values (101, 'rls_app', 'tenant_a', 1, 'mainline', 'mainline', 'test', 1, 1, now());
            insert into company_record (id, app_id, customer_id, external_key)
            values ('00000000-0000-0000-0000-000000000101', 'rls_app', 'tenant_a', 'acme');
            insert into company_version (
              id, record_id, app_id, customer_id, stage, effective_start,
              change_set_id, applied_at, name
            ) values (
              '00000000-0000-0000-0000-000000000201',
              '00000000-0000-0000-0000-000000000101',
              'rls_app', 'tenant_a', 'mainline', '2026-08-04', 101, now(), 'Acme'
            );
            "#,
        )
        .expect("seed non-bypass schema owner");
    assert_eq!(
        database
            .run_visible_query(
                "tenant_a",
                "select external_key from company_record",
                &[],
                &[],
                true,
                None,
            )
            .expect("query after tenant scope resolves active schema"),
        vec![json!({"external_key": "acme"})]
    );
}

#[test]
fn query_visible_sql_reads_drafts_change_sets_and_respects_rls() {
    let Some(mut database) = TestDatabase::connect(false) else {
        return;
    };
    seed_query_rows(&mut database);
    assert_eq!(
        database
            .run_visible_query(
                "tenant_a",
                "select external_key from company_record order by external_key",
                &[],
                &[],
                true,
                None,
            )
            .expect("read tenant records including draft"),
        vec![
            json!({"external_key": "acme-a"}),
            json!({"external_key": "draft-a"})
        ]
    );
    let draft_id = 102_i64;
    assert_eq!(
        database
            .run_visible_query(
                "tenant_a",
                "select stage, name from company_version where change_set_id = $1 and stage = 'draft'",
                &[Type::INT8],
                &[&draft_id],
                false,
                None,
            )
            .expect("read generated draft view"),
        vec![json!({"name": "Draft A", "stage": "draft"})]
    );
    assert_eq!(
        database
            .run_visible_query(
                "tenant_a",
                "select count(*) as count from change_set",
                &[],
                &[],
                true,
                None,
            )
            .expect("read tenant-filtered change sets"),
        vec![json!({"count": 2})]
    );
}

fn prepare_visible_query(
    transaction: &mut Transaction<'_>,
    schema_name: &str,
    customer_id: &str,
) -> Result<(), QueryFailure> {
    let response: Value = transaction
        .query_one(
            &format!("select \"{schema_name}\".kernel_prepare_visible_query($1)"),
            &[&json!({"app_id": APP_ID, "customer_id": customer_id})],
        )
        .expect("call generated visible-query prepare function")
        .get(0);
    if response["ok"] == json!(true) {
        Ok(())
    } else {
        Err(QueryFailure::Rejected(
            response["error"]["code"]
                .as_str()
                .unwrap_or("query_rejected")
                .to_string(),
        ))
    }
}

fn compiled_manifest(schema: Schema) -> CompiledManifest {
    CompiledManifest {
        schema,
        extras: NormalizedManifestExtras {
            model_metadata: vec![],
            field_metadata: vec![],
            inverse_relations: vec![],
            many_relations: vec![],
            constraints: vec![],
            derived_fields: vec![],
            authorization_policy: None,
            seed_change_sets: vec![],
        },
    }
}

fn test_schema(customer_id: &str) -> Schema {
    Schema {
        app_id: AppId::from(APP_ID),
        customer_id: CustomerId::from(customer_id),
        version: SchemaVersion::from("2026-08-04"),
        models: vec![
            Model {
                id: ModelId::from("company"),
                kind: ModelKind::Entity,
                label: "Company".to_string(),
                fields: vec![Field {
                    id: FieldId::from("name"),
                    label: "Name".to_string(),
                    field_type: FieldType::Text,
                    required: true,
                    is_unique: false,
                    target_model: None,
                    option_set: vec![],
                    ..Default::default()
                }],
                ..Default::default()
            },
            Model {
                id: ModelId::from("employee"),
                kind: ModelKind::Entity,
                label: "Employee".to_string(),
                fields: vec![
                    Field {
                        id: FieldId::from("name"),
                        label: "Name".to_string(),
                        field_type: FieldType::Text,
                        required: true,
                        is_unique: false,
                        target_model: None,
                        option_set: vec![],
                        ..Default::default()
                    },
                    Field {
                        id: FieldId::from("employer"),
                        label: "Employer".to_string(),
                        field_type: FieldType::Relation,
                        required: false,
                        is_unique: false,
                        target_model: Some(ModelId::from("company")),
                        option_set: vec![],
                        ..Default::default()
                    },
                ],
                ..Default::default()
            },
        ],
        custom_fields: vec![],
        change_types: Vec::<ChangeType>::new(),
    }
}

fn seed_schema_revisions(client: &mut Client, schema: &Schema) {
    let tenant_a = serde_json::to_value(schema).expect("serialize tenant A schema");
    let mut tenant_b = tenant_a.clone();
    tenant_b["customer_id"] = json!("tenant_b");
    for (id, customer_id, schema_json) in
        [(1_i64, "tenant_a", tenant_a), (2_i64, "tenant_b", tenant_b)]
    {
        client
            .execute(
                "select set_config('kernel.app_id', $1, false), set_config('kernel.customer_id', $2, false)",
                &[&APP_ID, &customer_id],
            )
            .expect("set schema revision tenant scope");
        client
            .execute(
                r#"
                insert into schema_revision (
                  id, app_id, customer_id, version, base_schema, customer_overlay,
                  schema, activated_at, materialized_at
                ) values ($1, $2, $3, '2026-08-04', $4, '{}', $4, now(), now())
                "#,
                &[&id, &APP_ID, &customer_id, &schema_json],
            )
            .expect("seed active generated schema revision");
    }
}

fn seed_tenant_rows(database: &mut TestDatabase) {
    for (customer_id, suffix, order) in [("tenant_a", "a", 1_i64), ("tenant_b", "b", 2_i64)] {
        database.set_scope(customer_id);
        let company_id = format!("00000000-0000-0000-0000-00000000000{}", order);
        let employee_id = format!("00000000-0000-0000-0000-00000000001{}", order);
        let version_id = format!("00000000-0000-0000-0000-00000000002{}", order);
        let change_set_id = 10 + order;
        database
            .client
            .execute(
                "insert into company_record (id, app_id, customer_id, external_key) values ($1::text::uuid, $2, $3, $4)",
                &[&company_id, &APP_ID, &customer_id, &suffix],
            )
            .expect("seed tenant company");
        database
            .client
            .execute(
                "insert into employee_record (id, app_id, customer_id, external_key) values ($1::text::uuid, $2, $3, $4)",
                &[&employee_id, &APP_ID, &customer_id, &format!("e{suffix}")],
            )
            .expect("seed tenant employee");
        database
            .client
            .execute(
                r#"
                insert into change_set (
                  id, app_id, customer_id, schema_revision_id, created_with_mode, status,
                  source_kind, created_order, applied_order, applied_at
                ) values ($1, $2, $3, $4, 'mainline', 'mainline', 'test', $5, $5, now())
                "#,
                &[&change_set_id, &APP_ID, &customer_id, &order, &order],
            )
            .expect("seed tenant change set");
        database
            .client
            .execute(
                r#"
                insert into employee_version (
                  id, record_id, app_id, customer_id, stage, effective_start,
                  change_set_id, applied_at, name
                ) values ($1::text::uuid, $2::text::uuid, $3, $4, 'mainline', '2026-08-04', $5, now(), $4)
                "#,
                &[
                    &version_id,
                    &employee_id,
                    &APP_ID,
                    &customer_id,
                    &change_set_id,
                ],
            )
            .expect("seed tenant employee version");
    }
}

fn seed_query_rows(database: &mut TestDatabase) {
    database.set_scope("tenant_a");
    database
        .client
        .batch_execute(
            r#"
            insert into change_set (
              id, app_id, customer_id, schema_revision_id, created_with_mode, status,
              source_kind, created_order, applied_order, applied_at
            ) values
              (101, 'rls_app', 'tenant_a', 1, 'mainline', 'mainline', 'test', 1, 1, now()),
              (102, 'rls_app', 'tenant_a', 1, 'draft', 'draft', 'test', 2, null, null);
            insert into company_record (id, app_id, customer_id, external_key) values
              ('00000000-0000-0000-0000-000000000101', 'rls_app', 'tenant_a', 'acme-a'),
              ('00000000-0000-0000-0000-000000000102', 'rls_app', 'tenant_a', 'draft-a');
            insert into company_version (
              id, record_id, app_id, customer_id, stage, effective_start,
              change_set_id, applied_at, name
            ) values
              ('00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000101', 'rls_app', 'tenant_a', 'mainline', '2026-08-04', 101, now(), 'Acme A'),
              ('00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000102', 'rls_app', 'tenant_a', 'draft', '2026-08-04', 102, null, 'Draft A');
            "#,
        )
        .expect("seed tenant A generated query rows");
    database.set_scope("tenant_b");
    database
        .client
        .batch_execute(
            r#"
            insert into change_set (
              id, app_id, customer_id, schema_revision_id, created_with_mode, status,
              source_kind, created_order, applied_order, applied_at
            ) values (201, 'rls_app', 'tenant_b', 2, 'mainline', 'mainline', 'test', 3, 3, now());
            insert into company_record (id, app_id, customer_id, external_key)
            values ('00000000-0000-0000-0000-000000000301', 'rls_app', 'tenant_b', 'other');
            insert into company_version (
              id, record_id, app_id, customer_id, stage, effective_start,
              change_set_id, applied_at, name
            ) values (
              '00000000-0000-0000-0000-000000000302',
              '00000000-0000-0000-0000-000000000301',
              'rls_app', 'tenant_b', 'mainline', '2026-08-04', 201, now(), 'Other Tenant'
            );
            "#,
        )
        .expect("seed tenant B generated query rows");
}
