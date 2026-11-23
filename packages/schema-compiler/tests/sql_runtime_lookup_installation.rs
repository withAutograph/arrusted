use std::env;

use kernel::{connect_postgres, schema_hash, Schema};
use postgres::{error::SqlState, Client};
use schema_compiler::{
    compile_manifest_json, compile_sql_artifact_manifest, render_sql_artifact_bundle,
    CompiledManifest, NormalizedManifestExtras, SqlArtifactKind,
};
use serde_json::{json, Value};
use uuid::Uuid;

#[test]
fn generic_lookup_installation_drift_and_safe_queries_work_on_pg17() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let compiled = compile_manifest_json(&fixture_manifest().to_string())
        .expect("compile lookup installation fixture");
    let manifest = compile_sql_artifact_manifest(&compiled).expect("compile generated SQL bundle");
    let bundle = render_sql_artifact_bundle(&manifest);
    let mut client = connect_postgres(&database_url).expect("connect to PostgreSQL");
    let version: i32 = client
        .query_one("show server_version_num", &[])
        .expect("read PostgreSQL version")
        .get::<_, String>(0)
        .parse()
        .expect("numeric PostgreSQL version");
    assert!(version >= 170_000, "lookup runtime requires PostgreSQL 17");

    let schema_name = format!("kernel_lookup_install_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            r#"
            create schema "{schema_name}";
            set search_path to "{schema_name}";
            "#
        ))
        .expect("create isolated lookup schema");

    let result = (|| -> Result<(), String> {
        client
            .batch_execute(&bundle)
            .map_err(|error| format!("install generated bundle: {error:?}"))?;
        set_scope(&mut client)?;
        let schema_hash = seed_active_schema(&mut client, &compiled.schema)?;
        // A physical FK covers every tenant even when repair is requested for
        // only tenant_a. Retained history for tenant_b must be reconciled too.
        let mut other_schema = compiled.schema.clone();
        other_schema.customer_id = "tenant_b".into();
        seed_active_schema(&mut client, &other_schema)?;
        let revision_id: i64 = client
            .query_one(
                "select id from schema_revision where app_id = 'lookup_install_app' and customer_id = 'tenant_b' and activated_at is not null",
                &[],
            )
            .map_err(|error| format!("read active revision: {error:?}"))?
            .get(0);
        let change_set_id: i64 = client
            .query_one(
                r#"
                insert into change_set (
                  app_id, customer_id, schema_revision_id, created_with_mode,
                  status, source_kind, created_order, applied_order, applied_at
                ) values (
                  'lookup_install_app', 'tenant_b', $1, 'mainline', 'mainline',
                  'lookup-install-test', 1, 1, now()
                ) returning id
                "#,
                &[&revision_id],
            )
            .map_err(|error| format!("seed entity change set: {error:?}"))?
            .get(0);
        let employee_id = Uuid::new_v4();
        let employee_version_id = Uuid::new_v4();
        let retained_department_id = Uuid::new_v4();
        client
            .batch_execute(
                "alter table employee_version drop constraint employee_version_department_tenant_fk",
            )
            .map_err(|error| format!("remove lookup-target FK for legacy fixture: {error:?}"))?;
        client
            .execute(
                "insert into employee_record (id, app_id, customer_id) values ($1, 'lookup_install_app', 'tenant_b')",
                &[&employee_id],
            )
            .map_err(|error| format!("seed employee identity: {error:?}"))?;
        client
            .execute(
                r#"
                insert into employee_version (
                  id, record_id, app_id, customer_id, stage, effective_start,
                  change_set_id, applied_at, name, department,
                  department_target_model
                ) values (
                  $1, $2, 'lookup_install_app', 'tenant_b', 'mainline',
                  '2026-01-01', $3, now(), 'Retained relation', $4, 'department'
                )
                "#,
                &[
                    &employee_version_id,
                    &employee_id,
                    &change_set_id,
                    &retained_department_id,
                ],
            )
            .map_err(|error| format!("seed retained lookup relation: {error:?}"))?;
        client
            .batch_execute(
                r#"
                alter table employee_version
                  add constraint employee_version_department_tenant_fk
                  foreign key (app_id, customer_id, department_target_model, department)
                  references lookup_record (app_id, customer_id, model_id, id)
                  not valid
                "#,
            )
            .map_err(|error| format!("restore unvalidated lookup-target FK: {error:?}"))?;
        assert_ok_true(&call(
            &mut client,
            "kernel_repair_materialized_schema_revision",
            json!({"schema": compiled.schema, "expected_schema_hash": schema_hash}),
        )?);
        let reconciled: (i64, bool) = client
            .query_one(
                r#"
                select
                  (select count(*) from lookup_record
                    where app_id = 'lookup_install_app'
                      and customer_id = 'tenant_b'
                      and model_id = 'department'
                      and id = $1),
                  (select convalidated from pg_constraint
                    where conrelid = 'employee_version'::regclass
                      and conname = 'employee_version_department_tenant_fk')
                "#,
                &[&retained_department_id],
            )
            .map_err(|error| format!("inspect reconciled lookup target: {error:?}"))
            .map(|row| (row.get(0), row.get(1)))?;
        assert_eq!(reconciled, (1, true));
        let preservation: (i64, i64, bool) = client
            .query_one(
                r#"
                select
                  (select count(*) from lookup_record where id = $1),
                  (select count(*) from lookup_version where record_id = $1),
                  exists (
                    select 1 from employee_version
                    where id = $2 and record_id = $3
                      and app_id = 'lookup_install_app' and customer_id = 'tenant_b'
                      and name = 'Retained relation' and department = $1
                      and change_set_id = $4 and stage = 'mainline'
                      and effective_start = '2026-01-01'::date
                  )
                "#,
                &[
                    &retained_department_id,
                    &employee_version_id,
                    &employee_id,
                    &change_set_id,
                ],
            )
            .map(|row| (row.get(0), row.get(1), row.get(2)))
            .map_err(|error| format!("inspect retained history preservation: {error:?}"))?;
        // Exactly one identity in its original tenant, no invented values, and
        // the retained entity version is unchanged.
        assert_eq!(preservation, (1, 0, true));
        assert_ok_true(&call(
            &mut client,
            "kernel_validate_materialized_schema_revision",
            json!({"schema": compiled.schema, "expected_schema_hash": schema_hash}),
        )?);

        let typed_lookup_tables: (bool, bool) = client
            .query_one(
                "select to_regclass('department_record') is not null, to_regclass('department_version') is not null",
                &[],
            )
            .map(|row| (row.get(0), row.get(1)))
            .map_err(|error| format!("inspect lookup materialization: {error:?}"))?;
        assert_eq!(typed_lookup_tables, (false, false));

        client
            .batch_execute(
                "drop index lookup_alias_projection_match_idx; drop index lookup_alias_projection_display_page_idx",
            )
            .map_err(|error| format!("remove repairable lookup indexes: {error:?}"))?;
        assert_ok_true(&call(
            &mut client,
            "kernel_repair_materialized_schema_revision",
            json!({"schema": compiled.schema, "expected_schema_hash": schema_hash}),
        )?);
        let repaired: bool = client
            .query_one(
                "select to_regclass('lookup_alias_projection_match_idx') is not null",
                &[],
            )
            .map(|row| row.get(0))
            .map_err(|error| format!("inspect repaired lookup index: {error:?}"))?;
        assert!(repaired);
        let (display_page_columns, display_page_predicate): (Vec<String>, String) = client
            .query_one(
                r#"
                select array(
                  select attribute.attname::text
                  from unnest(index_value.indkey) with ordinality as key(attnum, ordinal)
                  join pg_attribute as attribute
                    on attribute.attrelid = index_value.indrelid
                   and attribute.attnum = key.attnum
                  order by key.ordinal
                ), pg_get_expr(index_value.indpred, index_value.indrelid)
                from pg_index as index_value
                where index_value.indexrelid = 'lookup_alias_projection_display_page_idx'::regclass
                "#,
                &[],
            )
            .map(|row| (row.get(0), row.get(1)))
            .map_err(|error| format!("inspect display pagination index: {error:?}"))?;
        assert_eq!(
            display_page_columns,
            vec![
                "app_id",
                "customer_id",
                "model_id",
                "normalized_alias",
                "record_id",
                "version_id"
            ]
        );
        assert_eq!(display_page_predicate, "(kind = 'display'::text)");

        seed_lookup_timeline(&mut client)?;
        assert_lookup_view(&mut client, "2026-06-01", 1, Some("Operations"))?;
        assert_lookup_view(&mut client, "2026-08-05", 0, None)?;

        let query_role: String = client
            .query_one("select kernel_installer_capability_role('query')", &[])
            .map_err(|error| format!("resolve generated query role: {error:?}"))?
            .get(0);
        let query_role_has_dml: bool = client
            .query_one(
                "select has_table_privilege($1, 'lookup_version', 'INSERT,UPDATE,DELETE,TRUNCATE')",
                &[&query_role],
            )
            .map(|row| row.get(0))
            .map_err(|error| format!("inspect query role privileges: {error:?}"))?;
        assert!(!query_role_has_dml);

        client
            .batch_execute(
                "alter table employee_version alter column metadata set default '[]'::jsonb",
            )
            .map_err(|error| format!("drift entity metadata default: {error:?}"))?;
        let drift = call(
            &mut client,
            "kernel_validate_materialized_schema_revision",
            json!({"schema": compiled.schema, "expected_schema_hash": schema_hash}),
        )?;
        assert_eq!(drift["ok"], false, "unexpected validation success: {drift}");
        assert_eq!(drift["error"]["code"], "schema_drift");
        assert_eq!(
            drift["error"]["details"][0]["message"],
            "employee_version.metadata: column default or nullability differs from the compiled catalog"
        );
        Ok(())
    })();

    let cleanup = client.batch_execute(&format!(
        "set search_path to public; drop schema \"{schema_name}\" cascade"
    ));
    if let Err(error) = result {
        panic!("{error}");
    }
    cleanup.expect("drop isolated lookup schema");
}

#[test]
fn generated_runtime_respects_restricted_database_connect_policy_pg17() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let mut owner = connect_postgres(&database_url).expect("connect database owner");
    assert_pg17(&mut owner, "restricted database access");
    let suffix = Uuid::new_v4().simple().to_string();
    let database_name = format!("kernel_connect_{suffix}");
    let principal = format!("kernel_login_{suffix}");
    let password = Uuid::new_v4().simple().to_string();
    owner
        .batch_execute(&format!("create database \"{database_name}\""))
        .expect("create isolated access-policy database");
    owner
        .batch_execute(&format!(
            "revoke connect on database \"{database_name}\" from public; \
             create role \"{principal}\" login password '{password}' \
             nosuperuser nocreatedb nocreaterole noreplication nobypassrls"
        ))
        .expect("restrict database access independently of generated roles");
    let mut config: postgres::Config = database_url.parse().expect("parse test database URL");
    config.dbname(&database_name);
    let mut capability_roles = Vec::<String>::new();
    let result =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<(), String> {
            let mut client = config
                .connect(postgres::NoTls)
                .map_err(|error| format!("connect isolated database: {error:?}"))?;
            let compiled = compile_manifest_json(&fixture_manifest().to_string()).unwrap();
            let bundle =
                render_sql_artifact_bundle(&compile_sql_artifact_manifest(&compiled).unwrap());
            let acl_before: String = client
                .query_one(
                    "select datacl::text from pg_database where datname = current_database()",
                    &[],
                )
                .map_err(|error| format!("read database ACL: {error:?}"))?
                .get(0);
            client
                .batch_execute(&bundle)
                .map_err(|error| format!("install bundle: {error:?}"))?;
            for capability in ["execution_owner", "runtime", "schema_admin", "query"] {
                capability_roles.push(
                    client
                        .query_one(
                            "select kernel_installer_capability_role($1)",
                            &[&capability],
                        )
                        .map_err(|error| format!("resolve capability: {error:?}"))?
                        .get(0),
                );
            }
            set_scope(&mut client)?;
            let hash = seed_active_schema(&mut client, &compiled.schema)?;
            assert_ok_true(&call(
                &mut client,
                "kernel_repair_materialized_schema_revision",
                json!({"schema": compiled.schema, "expected_schema_hash": hash}),
            )?);
            let acl_after: String = client
                .query_one(
                    "select datacl::text from pg_database where datname = current_database()",
                    &[],
                )
                .map_err(|error| format!("read preserved database ACL: {error:?}"))?
                .get(0);
            assert_eq!(
                acl_before, acl_after,
                "schema installation must preserve database access policy"
            );
            for role in &capability_roles {
                let can_connect: bool = client
                    .query_one(
                        "select has_database_privilege($1, current_database(), 'CONNECT')",
                        &[role],
                    )
                    .map_err(|error| format!("check NOLOGIN role: {error:?}"))?
                    .get(0);
                assert!(
                    !can_connect,
                    "NOLOGIN capabilities need no database CONNECT grant"
                );
            }

            let mut login_config = config.clone();
            login_config.user(&principal).password(&password);
            assert!(
                login_config.connect(postgres::NoTls).is_err(),
                "unprovisioned login must be denied"
            );
            client
                .batch_execute(&format!(
                    "grant connect on database \"{database_name}\" to \"{principal}\"; \
             grant \"{}\" to \"{principal}\"",
                    capability_roles[1]
                ))
                .map_err(|error| format!("provision fixture login access: {error:?}"))?;
            assert_eq!(
                call(
                    &mut client,
                    "kernel_bind_principal_scope",
                    json!({
                        "principal_name": principal, "capability": "runtime",
                        "app_id": "lookup_install_app", "customer_id": "tenant_a"
                    })
                )?["ok"],
                true
            );
            let mut login = login_config
                .connect(postgres::NoTls)
                .map_err(|error| format!("connect provisioned runtime login: {error:?}"))?;
            assert_eq!(
                call(
                    &mut login,
                    "kernel_read_active_schema_revision",
                    json!({
                        "app_id": "lookup_install_app", "customer_id": "tenant_a"
                    })
                )?["ok"],
                true
            );
            assert_eq!(
                call(
                    &mut login,
                    "kernel_read_active_schema_revision",
                    json!({
                        "app_id": "lookup_install_app", "customer_id": "tenant_b"
                    })
                )?["ok"],
                false,
                "database CONNECT must not grant tenant access"
            );
            Ok(())
        }));
    owner
        .batch_execute(&format!("drop database \"{database_name}\""))
        .expect("drop isolated access-policy database");
    owner
        .batch_execute(&format!("drop role \"{principal}\""))
        .expect("drop fixture login");
    for role in capability_roles {
        owner
            .batch_execute(&format!("drop role \"{role}\""))
            .expect("drop fixture capability role");
    }
    match result {
        Ok(result) => {
            result.expect("generated runtime works with independently provisioned database access")
        }
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

#[test]
fn generated_runtime_roles_deny_direct_dml_and_separate_schema_admin_pg17() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let compiled = compile_manifest_json(&fixture_manifest().to_string())
        .expect("compile runtime security fixture");
    let manifest = compile_sql_artifact_manifest(&compiled).expect("compile generated SQL bundle");
    let bundle = render_sql_artifact_bundle(&manifest);
    let mut client = connect_postgres(&database_url).expect("connect to PostgreSQL");
    assert_pg17(&mut client, "generated runtime security");
    let database_name: String = client
        .query_one("select current_database()", &[])
        .expect("read security-test database name")
        .get(0);

    let suffix = Uuid::new_v4().simple().to_string();
    let schema_name = format!("kernel_runtime_security_{suffix}");
    let attacker_schema = format!("kernel_runtime_attacker_{suffix}");
    let public_caller = format!("kernel_public_caller_{suffix}");
    let app_principal = format!("kernel_app_principal_{suffix}");
    let admin_principal = format!("kernel_admin_principal_{suffix}");
    let public_password = Uuid::new_v4().simple().to_string();
    let app_password = Uuid::new_v4().simple().to_string();
    let admin_password = Uuid::new_v4().simple().to_string();
    let mut capability_roles = Vec::new();
    client
        .batch_execute(&format!(
            r#"
            create role "{public_caller}" login password '{public_password}' nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
            create role "{app_principal}" login password '{app_password}' nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
            create role "{admin_principal}" login password '{admin_password}' nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
            create schema "{schema_name}";
            create schema "{attacker_schema}";
            set search_path to "{schema_name}";
            "#
        ))
        .expect("create isolated runtime security schemas");

    let result = (|| -> Result<(), String> {
        client
            .batch_execute(&bundle)
            .map_err(|error| format!("install secured generated bundle: {error:?}"))?;
        let runtime_role: String = client
            .query_one("select kernel_installer_capability_role('runtime')", &[])
            .map(|row| row.get(0))
            .map_err(|error| format!("read runtime capability role: {error:?}"))?;
        let schema_admin_role: String = client
            .query_one(
                "select kernel_installer_capability_role('schema_admin')",
                &[],
            )
            .map(|row| row.get(0))
            .map_err(|error| format!("read schema-admin capability role: {error:?}"))?;
        let execution_role: String = client
            .query_one(
                "select kernel_installer_capability_role('execution_owner')",
                &[],
            )
            .map(|row| row.get(0))
            .map_err(|error| format!("read execution-owner capability role: {error:?}"))?;
        capability_roles = vec![
            execution_role,
            runtime_role.clone(),
            schema_admin_role.clone(),
        ];
        client
            .batch_execute(&format!(
                r#"
                grant "{runtime_role}" to "{app_principal}";
                grant "{schema_admin_role}" to "{admin_principal}";
                grant connect on database "{database_name}" to "{public_caller}";
                "#
            ))
            .map_err(|error| format!("assign generated capability roles: {error:?}"))?;
        let runtime_binding = call(
            &mut client,
            "kernel_bind_principal_scope",
            json!({
                "principal_name": app_principal,
                "capability": "runtime",
                "app_id": "lookup_install_app",
                "customer_id": "tenant_a"
            }),
        )?;
        assert_eq!(runtime_binding["ok"], true, "{runtime_binding}");
        let admin_binding = call(
            &mut client,
            "kernel_bind_principal_scope",
            json!({
                "principal_name": admin_principal,
                "capability": "schema_admin",
                "app_id": "lookup_install_app",
                "customer_id": "tenant_a",
                "actor_id": "tenant-admin"
            }),
        )?;
        assert_eq!(admin_binding["ok"], true, "{admin_binding}");
        let mut public_client = connect_postgres(&principal_database_url(
            &database_url,
            &public_caller,
            &public_password,
        )?)
        .map_err(|error| format!("connect independent public principal: {error:?}"))?;
        let mut app_client = connect_postgres(&principal_database_url(
            &database_url,
            &app_principal,
            &app_password,
        )?)
        .map_err(|error| format!("connect independent app principal: {error:?}"))?;
        let mut admin_client = connect_postgres(&principal_database_url(
            &database_url,
            &admin_principal,
            &admin_password,
        )?)
        .map_err(|error| format!("connect independent schema-admin principal: {error:?}"))?;
        set_scope(&mut client)?;
        let active_hash = seed_active_schema(&mut client, &compiled.schema)?;
        assert_ok_true(&call(
            &mut client,
            "kernel_repair_materialized_schema_revision",
            json!({"schema": compiled.schema, "expected_schema_hash": active_hash}),
        )?);

        for (principal_name, principal_client) in [
            (&app_principal, &mut app_client),
            (&admin_principal, &mut admin_client),
        ] {
            assert_client_denied(
                principal_client,
                &format!(
                    "insert into \"{schema_name}\".lookup_record (app_id, customer_id, model_id, id) values ('lookup_install_app', 'tenant_a', 'department', gen_random_uuid())"
                ),
                &format!("{principal_name} direct table DML"),
            )?;
            assert_client_denied(
                principal_client,
                &format!("select nextval('\"{schema_name}\".change_set_lifecycle_order_seq')"),
                &format!("{principal_name} direct sequence access"),
            )?;
        }

        let runtime_read: Value = query_value(
            &mut app_client,
            &format!(
                "select \"{schema_name}\".kernel_read_active_schema_revision('{{\"app_id\":\"lookup_install_app\",\"customer_id\":\"tenant_a\"}}'::jsonb)"
            ),
        )?;
        assert_eq!(
            runtime_read["ok"], true,
            "runtime entrypoint was not callable"
        );
        // The restricted principal cannot read the revision tables directly,
        // yet the entrypoint returns the effective hash a tenant schema
        // revision commit compares against.
        assert_client_denied(
            &mut app_client,
            &format!("select schema_hash from \"{schema_name}\".schema_revision"),
            "runtime principal direct schema_revision read",
        )?;
        let commit_hash: String = client
            .query_one(
                "select coalesce(sir.effective_artifact_hash, sr.schema_hash, kernel_admin_sha256(kernel_canonical_json(sr.schema))) from schema_revision sr left join schema_installation_revision sir on sir.schema_revision_id = sr.id where sr.app_id = 'lookup_install_app' and sr.customer_id = 'tenant_a' and sr.activated_at is not null",
                &[],
            )
            .map_err(|error| format!("read commit effective hash: {error:?}"))?
            .get(0);
        assert_eq!(runtime_read["data"]["effective_hash"], commit_hash);
        let missing_scope_read: Value = query_value(
            &mut app_client,
            &format!(
                "select \"{schema_name}\".kernel_read_active_schema_revision('{{\"app_id\":\"lookup_install_app\"}}'::jsonb)"
            ),
        )?;
        assert_eq!(missing_scope_read["ok"], false);
        assert_eq!(
            missing_scope_read["error"]["code"], "contract_validation_failed",
            "a named runtime operation must fail closed when tenant scope is missing"
        );
        let malformed_scope_read: Value = query_value(
            &mut app_client,
            &format!("select \"{schema_name}\".kernel_read_active_schema_revision('[]'::jsonb)"),
        )?;
        assert_eq!(malformed_scope_read["ok"], false);
        assert_eq!(
            malformed_scope_read["error"]["code"], "contract_validation_failed",
            "a named runtime operation must fail closed for malformed input"
        );
        let wrong_tenant_read: Value = query_value(
            &mut app_client,
            &format!(
                "select \"{schema_name}\".kernel_read_active_schema_revision('{{\"app_id\":\"lookup_install_app\",\"customer_id\":\"tenant_b\"}}'::jsonb)"
            ),
        )?;
        assert_eq!(wrong_tenant_read["ok"], false);
        assert_eq!(wrong_tenant_read["error"]["code"], "authorization_denied");

        let active_revision_id: i64 = client
            .query_one(
                "select id from schema_revision where app_id='lookup_install_app' and customer_id='tenant_a' and activated_at is not null",
                &[],
            )
            .map_err(|error| format!("read active revision for authorization test: {error:?}"))?
            .get(0);
        let actor_spoof: Value = query_value(
            &mut admin_client,
            &format!(
                "select \"{schema_name}\".kernel_dry_run_tenant_schema_revision($json${}$json$::jsonb)",
                json!({
                    "app_id": "lookup_install_app",
                    "customer_id": "tenant_a",
                    "actor_id": "spoofed-admin",
                    "reason": "authorization test",
                    "idempotency_key": "actor-spoof",
                    "expected_revision_id": active_revision_id,
                    "expected_effective_hash": active_hash,
                    "operations": [{
                        "type": "update_model",
                        "model_id": "department",
                        "label": "Spoofed"
                    }]
                })
            ),
        )?;
        assert_eq!(actor_spoof["ok"], false);
        assert_eq!(actor_spoof["error"]["code"], "authorization_denied");
        let authorized_admin: Value = query_value(
            &mut admin_client,
            &format!(
                "select \"{schema_name}\".kernel_dry_run_tenant_schema_revision($json${}$json$::jsonb)",
                json!({
                    "app_id": "lookup_install_app",
                    "customer_id": "tenant_a",
                    "actor_id": "tenant-admin",
                    "reason": "authorization test",
                    "idempotency_key": "authorized-admin",
                    "expected_revision_id": active_revision_id,
                    "expected_effective_hash": active_hash,
                    "operations": [{
                        "type": "update_model",
                        "model_id": "department",
                        "label": "Renamed"
                    }]
                })
            ),
        )?;
        assert_eq!(authorized_admin["ok"], false);
        assert_eq!(
            authorized_admin["error"]["code"],
            "schema_management_forbidden",
            "the bound schema administrator should pass authorization before fixed-definition validation: {authorized_admin}"
        );
        let wrong_tenant_admin: Value = query_value(
            &mut admin_client,
            &format!(
                "select \"{schema_name}\".kernel_dry_run_tenant_schema_revision($json${}$json$::jsonb)",
                json!({
                    "app_id": "lookup_install_app",
                    "customer_id": "tenant_b",
                    "actor_id": "tenant-admin",
                    "reason": "authorization test",
                    "idempotency_key": "wrong-tenant-admin",
                    "expected_revision_id": active_revision_id,
                    "expected_effective_hash": active_hash,
                    "operations": [{
                        "type": "update_model",
                        "model_id": "department",
                        "label": "Renamed"
                    }]
                })
            ),
        )?;
        assert_eq!(wrong_tenant_admin["ok"], false);
        assert_eq!(wrong_tenant_admin["error"]["code"], "authorization_denied");

        let runtime_schema_admin = query_value_result(
            &mut app_client,
            &format!(
                "select \"{schema_name}\".kernel_dry_run_tenant_schema_revision('{{}}'::jsonb) from (select set_config('kernel.tenant_schema_admin', 'on', true)) as spoofed_scope"
            ),
        );
        assert_permission_denied(runtime_schema_admin, "runtime schema-admin call")?;
        assert_permission_denied(
            query_value_result(
                &mut app_client,
                &format!("select \"{schema_name}\".kernel_bind_principal_scope('{{}}'::jsonb)"),
            ),
            "runtime scope-binding call",
        )?;
        assert_client_denied(
            &mut app_client,
            &format!(
                "insert into \"{schema_name}\".kernel_principal_scope (principal_name, capability, app_id, customer_id) values (session_user, 'runtime', 'lookup_install_app', 'tenant_b')"
            ),
            "runtime principal scope escalation",
        )?;

        client
            .batch_execute(&format!(
                r#"
                grant usage on schema "{schema_name}" to "{public_caller}";
                set search_path to "{attacker_schema}";
                create function kernel_tenant_schema_execute(jsonb, boolean)
                returns jsonb language sql as $$ select '{{"spoofed":true}}'::jsonb $$;
                grant usage on schema "{attacker_schema}" to "{schema_admin_role}";
                set search_path to "{schema_name}";
                "#
            ))
            .map_err(|error| format!("prepare privilege adversary: {error:?}"))?;
        let public_call = query_value_result(
            &mut public_client,
            &format!("select \"{schema_name}\".kernel_read_active_schema_revision('{{}}'::jsonb)"),
        );
        assert_permission_denied(public_call, "PUBLIC generated-function call")?;

        admin_client
            .batch_execute(&format!(
                "set search_path to \"{attacker_schema}\", \"{schema_name}\""
            ))
            .map_err(|error| format!("set hostile schema-admin search path: {error:?}"))?;
        let admin_result: Value = query_value(
            &mut admin_client,
            &format!(
                "select \"{schema_name}\".kernel_dry_run_tenant_schema_revision('{{}}'::jsonb)"
            ),
        )?;
        assert_eq!(admin_result["ok"], false);
        assert_ne!(admin_result["spoofed"], true);
        assert_permission_denied(
            query_value_result(
                &mut admin_client,
                &format!(
                    "select \"{schema_name}\".kernel_read_active_schema_revision('{{}}'::jsonb)"
                ),
            ),
            "schema-admin runtime call",
        )?;

        let privilege_contract: (bool, bool, bool, bool, bool) = client
            .query_one(
                &format!(
                    r#"
                    select
                      has_function_privilege($1, '"{schema_name}".kernel_apply_change_set(jsonb)', 'execute'),
                      has_function_privilege($1, '"{schema_name}".kernel_commit_tenant_schema_revision(jsonb)', 'execute'),
                      has_function_privilege($2, '"{schema_name}".kernel_commit_tenant_schema_revision(jsonb)', 'execute'),
                      procedure.prosecdef,
                      procedure.proconfig @> array['search_path={schema_name}, pg_catalog, pg_temp']
                    from pg_proc as procedure
                    where procedure.oid = '"{schema_name}".kernel_commit_tenant_schema_revision(jsonb)'::regprocedure
                    "#
                ),
                &[&runtime_role, &schema_admin_role],
            )
            .map(|row| (row.get(0), row.get(1), row.get(2), row.get(3), row.get(4)))
            .map_err(|error| format!("inspect generated privilege contract: {error:?}"))?;
        assert_eq!(privilege_contract, (true, false, true, true, true));
        let principal_memberships: (bool, bool, bool, bool) = client
            .query_one(
                "select pg_has_role($1, $2, 'MEMBER'), pg_has_role($1, $3, 'MEMBER'), pg_has_role($4, $2, 'MEMBER'), pg_has_role($4, $3, 'MEMBER')",
                &[&app_principal, &runtime_role, &schema_admin_role, &admin_principal],
            )
            .map(|row| (row.get(0), row.get(1), row.get(2), row.get(3)))
            .map_err(|error| format!("inspect principal capability memberships: {error:?}"))?;
        assert_eq!(principal_memberships, (true, false, false, true));
        let principal_attributes_are_limited: bool = client
            .query_one(
                r#"
                select bool_and(
                  role_value.rolcanlogin
                  and not role_value.rolsuper
                  and not role_value.rolcreatedb
                  and not role_value.rolcreaterole
                  and not role_value.rolreplication
                  and not role_value.rolbypassrls
                  and (
                    to_regrole('neon_superuser') is null
                    or not pg_has_role(role_value.rolname, 'neon_superuser', 'MEMBER')
                  )
                )
                from pg_roles as role_value
                where role_value.rolname = any($1)
                "#,
                &[&vec![app_principal.clone(), admin_principal.clone()]],
            )
            .map(|row| row.get(0))
            .map_err(|error| format!("inspect principal role attributes: {error:?}"))?;
        assert!(principal_attributes_are_limited);
        Ok(())
    })();

    let membership_cleanup = if capability_roles.len() == 3 {
        format!(
            "revoke \"{}\" from \"{app_principal}\"; revoke \"{}\" from \"{admin_principal}\";",
            capability_roles[1], capability_roles[2]
        )
    } else {
        String::new()
    };
    let cleanup = client.batch_execute(&format!(
        r#"
        set role none;
        set search_path to public;
        drop schema if exists "{attacker_schema}" cascade;
        drop schema if exists "{schema_name}" cascade;
        {membership_cleanup}
        revoke connect on database "{database_name}" from "{public_caller}";
        drop role if exists "{public_caller}";
        drop role if exists "{app_principal}";
        drop role if exists "{admin_principal}";
        "#
    ));
    if let Err(error) = result {
        panic!("{error}");
    }
    cleanup.expect("drop isolated runtime security state");
    for role_name in capability_roles {
        client
            .batch_execute(&format!(
                "revoke connect on database \"{database_name}\" from \"{role_name}\"; drop role if exists \"{role_name}\""
            ))
            .expect("drop generated capability role");
    }
}

#[test]
fn installer_upgrades_uuid_only_lookup_keys_without_losing_rows_pg17() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let compiled = compile_manifest_json(&fixture_manifest().to_string())
        .expect("compile old lookup key fixture");
    let manifest = compile_sql_artifact_manifest(&compiled).expect("compile generated SQL bundle");
    let bundle = render_sql_artifact_bundle(&manifest);
    let mut client = connect_postgres(&database_url).expect("connect to PostgreSQL");
    assert_pg17(&mut client, "lookup key upgrade");

    let schema_name = format!("kernel_lookup_key_upgrade_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            "create schema \"{schema_name}\"; set search_path to \"{schema_name}\""
        ))
        .expect("create isolated lookup key upgrade schema");
    let result = (|| -> Result<(), String> {
        client
            .batch_execute(&bundle)
            .map_err(|error| format!("install generated bundle: {error:?}"))?;
        set_scope(&mut client)?;
        let active_hash = seed_active_schema(&mut client, &compiled.schema)?;
        let version_id = Uuid::new_v4();
        let record_id = Uuid::new_v4();
        let change_set_id = seed_mainline_change_set(&mut client)?;
        client
            .execute(
                "insert into lookup_record (app_id, customer_id, model_id, id) values ('lookup_install_app', 'tenant_a', 'department', $1)",
                &[&record_id],
            )
            .map_err(|error| format!("seed lookup record: {error:?}"))?;
        client
            .execute(
                r#"
                insert into lookup_version (
                  app_id, customer_id, model_id, id, record_id, stage,
                  effective_start, change_set_id, applied_at, values
                ) values (
                  'lookup_install_app', 'tenant_a', 'department', $1, $2,
                  'mainline', '2026-01-01', $3, now(),
                  '{"name":{"type":"text","value":"Operations"}}'
                )
                "#,
                &[&version_id, &record_id, &change_set_id],
            )
            .map_err(|error| format!("seed lookup version: {error:?}"))?;
        client
            .execute(
                r#"
                insert into lookup_value_projection (
                  app_id, customer_id, model_id, version_id, record_id, field_id,
                  value_type, text_value
                ) values ('lookup_install_app', 'tenant_a', 'department', $1, $2, 'name', 'text', 'Operations')
                "#,
                &[&version_id, &record_id],
            )
            .map_err(|error| format!("seed lookup projection: {error:?}"))?;

        client
            .batch_execute(
                r#"
                alter table lookup_value_projection drop constraint lookup_value_projection_version_fk;
                alter table lookup_alias_projection drop constraint lookup_alias_projection_version_fk;
                alter table lookup_relation_projection drop constraint lookup_relation_projection_version_fk;
                alter table lookup_value_projection drop constraint lookup_value_projection_pkey;
                alter table lookup_value_projection add constraint lookup_value_projection_pkey primary key (version_id, field_id);
                alter table lookup_alias_projection drop constraint lookup_alias_projection_pkey;
                alter table lookup_alias_projection add constraint lookup_alias_projection_pkey primary key (version_id, field_id, kind, ordinal);
                alter table lookup_relation_projection drop constraint lookup_relation_projection_pkey;
                alter table lookup_relation_projection add constraint lookup_relation_projection_pkey primary key (version_id, field_id, ordinal);
                alter table lookup_version drop constraint lookup_version_pkey;
                alter table lookup_version add constraint lookup_version_pkey primary key (id);
                alter table lookup_value_projection add constraint lookup_value_projection_version_fk foreign key (version_id) references lookup_version(id) not valid;
                alter table lookup_alias_projection add constraint lookup_alias_projection_version_fk foreign key (version_id) references lookup_version(id) not valid;
                alter table lookup_relation_projection add constraint lookup_relation_projection_version_fk foreign key (version_id) references lookup_version(id) not valid;
                "#,
            )
            .map_err(|error| format!("downgrade lookup keys to UUID-only shape: {error:?}"))?;

        assert_ok_true(&call(
            &mut client,
            "kernel_repair_materialized_schema_revision",
            json!({"schema": compiled.schema, "expected_schema_hash": active_hash}),
        )?);

        let preserved: (i64, i64, String) = client
            .query_one(
                r#"
                select
                  (select count(*) from lookup_version where id = $1),
                  (select count(*) from lookup_value_projection where version_id = $1),
                  (select text_value from lookup_value_projection where version_id = $1 and field_id = 'name')
                "#,
                &[&version_id],
            )
            .map(|row| (row.get(0), row.get(1), row.get(2)))
            .map_err(|error| format!("inspect preserved lookup rows: {error:?}"))?;
        assert_eq!(preserved, (1, 1, "Operations".to_string()));

        for (table, constraint, expected_columns) in [
            (
                "lookup_version",
                "lookup_version_pkey",
                vec!["app_id", "customer_id", "model_id", "id"],
            ),
            (
                "lookup_value_projection",
                "lookup_value_projection_pkey",
                vec![
                    "app_id",
                    "customer_id",
                    "model_id",
                    "version_id",
                    "field_id",
                ],
            ),
            (
                "lookup_alias_projection",
                "lookup_alias_projection_pkey",
                vec![
                    "app_id",
                    "customer_id",
                    "model_id",
                    "version_id",
                    "field_id",
                    "kind",
                    "ordinal",
                ],
            ),
            (
                "lookup_relation_projection",
                "lookup_relation_projection_pkey",
                vec![
                    "app_id",
                    "customer_id",
                    "source_model_id",
                    "version_id",
                    "field_id",
                    "ordinal",
                ],
            ),
            (
                "lookup_value_projection",
                "lookup_value_projection_version_fk",
                vec!["app_id", "customer_id", "model_id", "version_id"],
            ),
            (
                "lookup_alias_projection",
                "lookup_alias_projection_version_fk",
                vec!["app_id", "customer_id", "model_id", "version_id"],
            ),
            (
                "lookup_relation_projection",
                "lookup_relation_projection_version_fk",
                vec!["app_id", "customer_id", "source_model_id", "version_id"],
            ),
        ] {
            let (columns, validated): (Vec<String>, bool) = client
                .query_one(
                    r#"
                    select array(
                      select attribute.attname::text
                      from unnest(constraint_value.conkey) with ordinality as key(attnum, ordinal)
                      join pg_attribute as attribute
                        on attribute.attrelid = constraint_value.conrelid
                       and attribute.attnum = key.attnum
                      order by key.ordinal
                    ), constraint_value.convalidated
                    from pg_constraint as constraint_value
                    where constraint_value.conrelid = to_regclass($1)
                      and constraint_value.conname = $2
                    "#,
                    &[&table, &constraint],
                )
                .map(|row| (row.get(0), row.get(1)))
                .map_err(|error| format!("inspect repaired {table}.{constraint}: {error:?}"))?;
            assert_eq!(columns, expected_columns);
            assert!(validated, "{table}.{constraint} remained NOT VALID");
        }

        let second_record_id = Uuid::new_v4();
        client
            .execute(
                "insert into lookup_record (app_id, customer_id, model_id, id) values ('lookup_install_app', 'tenant_a', 'category', $1)",
                &[&second_record_id],
            )
            .map_err(|error| format!("seed second model record: {error:?}"))?;
        client
            .execute(
                r#"
                insert into lookup_version (
                  app_id, customer_id, model_id, id, record_id, stage,
                  effective_start, change_set_id, applied_at, values
                ) values (
                  'lookup_install_app', 'tenant_a', 'category', $1, $2,
                  'mainline', '2026-01-01', $3, now(), '{}'
                )
                "#,
                &[&version_id, &second_record_id, &change_set_id],
            )
            .map_err(|error| format!("insert model-qualified duplicate version UUID: {error:?}"))?;
        Ok(())
    })();

    let cleanup = client.batch_execute(&format!(
        "set role none; set search_path to public; drop schema \"{schema_name}\" cascade"
    ));
    if let Err(error) = result {
        panic!("{error}");
    }
    cleanup.expect("drop isolated lookup key upgrade schema");
}

#[test]
fn activation_applies_compiler_seed_defaults_once_and_rolls_back_on_failure_pg17() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let compiled = compile_manifest_json(&seed_fixture_manifest().to_string())
        .expect("compile seed activation fixture");
    let manifest = compile_sql_artifact_manifest(&compiled).expect("compile seeded SQL bundle");
    let bundle = render_sql_artifact_bundle(&manifest);
    let mut client = connect_postgres(&database_url).expect("connect to PostgreSQL");
    let version: i32 = client
        .query_one("show server_version_num", &[])
        .expect("read PostgreSQL version")
        .get::<_, String>(0)
        .parse()
        .expect("numeric PostgreSQL version");
    assert!(version >= 170_000, "seed activation requires PostgreSQL 17");

    let schema_name = format!("kernel_seed_activation_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            "create schema \"{schema_name}\"; set search_path to \"{schema_name}\""
        ))
        .expect("create isolated seed schema");
    let result = (|| -> Result<(), String> {
        client
            .batch_execute(&bundle)
            .map_err(|error| format!("install seeded bundle: {error:?}"))?;
        set_scope(&mut client)?;

        let templates = serde_json::to_value(&compiled.extras.seed_change_sets)
            .expect("serialize compiler seed templates");
        let first_hash = schema_hash(&compiled.schema);
        let first_revision = prepare_ready_revision(
            &mut client,
            &compiled.schema,
            "seed-release-1",
            &first_hash,
            None,
            templates,
        )?;
        let activated = activate_tenant_revision(&mut client, first_revision, &first_hash, None)?;
        assert_eq!(activated["ok"], true, "seed activation failed: {activated}");

        let seeded: (i64, String) = client
            .query_one(
                r#"
                select count(*), max(v.values->'name'->>'value')
                from lookup_record r
                join lookup_version v
                  on v.app_id = r.app_id and v.customer_id = r.customer_id
                 and v.model_id = r.model_id and v.record_id = r.id
                where r.app_id = 'lookup_install_app'
                  and r.customer_id = 'tenant_a'
                  and r.model_id = 'department'
                  and r.id = '00000000-0000-4000-8000-000000000101'
                "#,
                &[],
            )
            .map(|row| (row.get(0), row.get(1)))
            .map_err(|error| format!("read installed seed: {error:?}"))?;
        assert_eq!(seeded, (1, "Operations".to_string()));

        let replay = activate_tenant_revision(&mut client, first_revision, &first_hash, None)?;
        assert_eq!(replay["ok"], true, "idempotent activation failed: {replay}");
        assert_eq!(replay["data"]["idempotent"], true);
        let seed_change_sets: i64 = client
            .query_one(
                "select count(*) from change_set where idempotency_key = 'department-defaults-v1'",
                &[],
            )
            .map(|row| row.get(0))
            .map_err(|error| format!("count seed change sets: {error:?}"))?;
        assert_eq!(seed_change_sets, 1);

        let mut failed_schema = compiled.schema.clone();
        failed_schema.version = "2026-08-06.failed".into();
        let failed_hash = schema_hash(&failed_schema);
        let failed_revision = prepare_ready_revision(
            &mut client,
            &failed_schema,
            "seed-release-failed",
            &failed_hash,
            Some(first_hash.clone()),
            json!([{"unexpected": true}]),
        )?;
        let failed_activation = activate_tenant_revision(
            &mut client,
            failed_revision,
            &failed_hash,
            Some(first_hash.clone()),
        )?;
        assert_eq!(failed_activation["ok"], false);
        assert_eq!(
            failed_activation["error"]["details"][0]["code"],
            "invalid_seed_template"
        );
        let active_revision: i64 = client
            .query_one(
                "select id from schema_revision where app_id = 'lookup_install_app' and customer_id = 'tenant_a' and activated_at is not null",
                &[],
            )
            .map(|row| row.get(0))
            .map_err(|error| format!("read active revision after seed failure: {error:?}"))?;
        assert_eq!(active_revision, first_revision);
        let failed_is_active: bool = client
            .query_one(
                "select activated_at is not null from schema_revision where id = $1",
                &[&failed_revision],
            )
            .map(|row| row.get(0))
            .map_err(|error| format!("read failed revision state: {error:?}"))?;
        assert!(!failed_is_active);
        Ok(())
    })();

    let cleanup = client.batch_execute(&format!(
        "set search_path to public; drop schema \"{schema_name}\" cascade"
    ));
    if let Err(error) = result {
        panic!("{error}");
    }
    cleanup.expect("drop isolated seed schema");
}

#[test]
fn app_base_activation_rolls_back_every_tenant_when_a_seed_fails_pg17() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let compiled = compile_manifest_json(&seed_fixture_manifest().to_string())
        .expect("compile app-base seed fixture");
    let manifest = compile_sql_artifact_manifest(&compiled).expect("compile app-base SQL bundle");
    let bundle = render_sql_artifact_bundle(&manifest);
    let mut client = connect_postgres(&database_url).expect("connect to PostgreSQL");
    let version: i32 = client
        .query_one("show server_version_num", &[])
        .expect("read PostgreSQL version")
        .get::<_, String>(0)
        .parse()
        .expect("numeric PostgreSQL version");
    assert!(version >= 170_000, "seed activation requires PostgreSQL 17");

    let schema_name = format!("kernel_seed_app_base_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            "create schema \"{schema_name}\"; set search_path to \"{schema_name}\""
        ))
        .expect("create isolated app-base seed schema");
    let result = (|| -> Result<(), String> {
        client
            .batch_execute(&bundle)
            .map_err(|error| format!("install app-base seed bundle: {error:?}"))?;
        let templates = serde_json::to_value(&compiled.extras.seed_change_sets)
            .expect("serialize compiler seed templates");
        let base_hash = "b".repeat(64);
        let release_id = "seed-app-base-release";
        let mut tenant_a = compiled.schema.clone();
        tenant_a.customer_id = "tenant_a".into();
        let mut tenant_b = compiled.schema.clone();
        tenant_b.customer_id = "tenant_b".into();
        let tenant_a_hash = schema_hash(&tenant_a);
        let tenant_b_hash = schema_hash(&tenant_b);
        let tenant_a_revision = prepare_ready_app_base_revision(
            &mut client,
            &tenant_a,
            release_id,
            &base_hash,
            &tenant_a_hash,
            templates,
        )?;
        let tenant_b_revision = prepare_ready_app_base_revision(
            &mut client,
            &tenant_b,
            release_id,
            &base_hash,
            &tenant_b_hash,
            json!([{"unexpected": true}]),
        )?;

        let activation = call(
            &mut client,
            "kernel_activate_app_base_schema_revision",
            json!({
                "app_id": "lookup_install_app",
                "release_id": release_id,
                "base_artifact_hash": base_hash,
                "targets": [
                    {
                        "customer_id": "tenant_a",
                        "schema_revision_id": tenant_a_revision,
                        "effective_artifact_hash": tenant_a_hash,
                        "expected_active_effective_hash": null
                    },
                    {
                        "customer_id": "tenant_b",
                        "schema_revision_id": tenant_b_revision,
                        "effective_artifact_hash": tenant_b_hash,
                        "expected_active_effective_hash": null
                    }
                ]
            }),
        )?;
        assert_eq!(activation["ok"], false);
        assert_eq!(
            activation["error"]["details"][0]["code"],
            "invalid_seed_template"
        );
        let active_revisions: i64 = client
            .query_one(
                "select count(*) from schema_revision where app_id = 'lookup_install_app' and activated_at is not null",
                &[],
            )
            .map(|row| row.get(0))
            .map_err(|error| format!("count rolled-back activations: {error:?}"))?;
        let seeded_records: i64 = client
            .query_one(
                "select count(*) from lookup_record where app_id = 'lookup_install_app'",
                &[],
            )
            .map(|row| row.get(0))
            .map_err(|error| format!("count rolled-back seeds: {error:?}"))?;
        assert_eq!(active_revisions, 0);
        assert_eq!(seeded_records, 0);
        Ok(())
    })();

    let cleanup = client.batch_execute(&format!(
        "set search_path to public; drop schema \"{schema_name}\" cascade"
    ));
    if let Err(error) = result {
        panic!("{error}");
    }
    cleanup.expect("drop isolated app-base seed schema");
}

fn fixture_manifest() -> Value {
    json!({
        "app_id": "lookup_install_app",
        "customer_id": "tenant_a",
        "version": "2026-08-05",
        "models": [
            {
                "id": "department",
                "kind": "lookup",
                "label": "Department",
                "display_field_id": "name",
                "fields": [
                    {"id": "name", "label": "Name", "type": "text", "required": true},
                    {"id": "code", "label": "Code", "type": "text"}
                ]
            },
            {
                "id": "employee",
                "kind": "entity",
                "label": "Employee",
                "extensions": {
                    "record_metadata": {
                        "max_bytes": 2048,
                        "max_depth": 3,
                        "max_keys": 16,
                        "max_key_bytes": 64,
                        "max_scalar_bytes": 512,
                        "max_array_items": 16
                    }
                },
                "fields": [
                    {"id": "name", "label": "Name", "type": "text", "required": true},
                    {"id": "department", "label": "Department", "type": "relation", "target_model": "department"}
                ]
            }
        ],
        "change_types": [],
        "constraints": [],
        "seed_change_sets": []
    })
}

fn seed_fixture_manifest() -> Value {
    let mut manifest = fixture_manifest();
    manifest["seed_change_sets"] = json!([{
        "id": "department_defaults_v1",
        "effective_start": "2026-01-01",
        "actor_id": "app_installer",
        "source_kind": "app_seed",
        "idempotency_key": "department-defaults-v1",
        "writes": [{
            "model": "department",
            "new_record_id": "00000000-0000-4000-8000-000000000101",
            "values": {"name": "Operations", "code": "OPS"}
        }]
    }]);
    manifest
}

fn install_constraint_catalog(client: &mut Client, schema: &Schema) -> Result<(), String> {
    let manifest = compile_sql_artifact_manifest(&CompiledManifest {
        schema: schema.clone(),
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
    })
    .map_err(|error| format!("compile constraint catalog: {error:?}"))?;
    let catalog = manifest
        .artifacts
        .iter()
        .find(|artifact| artifact.kind == SqlArtifactKind::ConstraintCatalog)
        .ok_or_else(|| "compiler omitted constraint catalog".to_string())?;
    client
        .batch_execute(&catalog.sql)
        .map_err(|error| format!("install compiler constraint catalog: {error:?}"))
}

fn prepare_ready_revision(
    client: &mut Client,
    schema: &Schema,
    release_id: &str,
    effective_hash: &str,
    expected_active_hash: Option<String>,
    seed_change_sets: Value,
) -> Result<i64, String> {
    let schema_json = serde_json::to_value(schema).expect("serialize prepared schema");
    install_constraint_catalog(client, schema)?;
    let prepared = call(
        client,
        "kernel_prepare_schema_revision",
        json!({
            "app_id": schema.app_id,
            "customer_id": schema.customer_id,
            "version": schema.version,
            "release_id": release_id,
            "activation_kind": "tenant_overlay",
            "schema_hash": effective_hash,
            "base_artifact_hash": effective_hash,
            "effective_artifact_hash": effective_hash,
            "materialization_plan_hash": effective_hash,
            "expected_active_effective_hash": expected_active_hash,
            "base_schema": schema_json,
            "customer_overlay": {},
            "schema": schema_json,
            "seed_change_sets": seed_change_sets,
            "phase_plan": []
        }),
    )?;
    if prepared["ok"] != true {
        return Err(format!("prepare seeded revision: {prepared}"));
    }
    let revision_id = prepared["data"]["schema_revision_id"]
        .as_i64()
        .expect("prepared revision id");
    let ready = call(
        client,
        "kernel_validate_schema_revision_readiness",
        json!({
            "app_id": schema.app_id,
            "customer_id": schema.customer_id,
            "schema_revision_id": revision_id,
            "effective_artifact_hash": effective_hash,
            "materialization_plan_hash": effective_hash,
            "phase_results": []
        }),
    )?;
    if ready["ok"] != true {
        return Err(format!("validate seeded revision readiness: {ready}"));
    }
    Ok(revision_id)
}

fn prepare_ready_app_base_revision(
    client: &mut Client,
    schema: &Schema,
    release_id: &str,
    base_hash: &str,
    effective_hash: &str,
    seed_change_sets: Value,
) -> Result<i64, String> {
    let schema_json = serde_json::to_value(schema).expect("serialize app-base schema");
    install_constraint_catalog(client, schema)?;
    let prepared = call(
        client,
        "kernel_prepare_schema_revision",
        json!({
            "app_id": schema.app_id,
            "customer_id": schema.customer_id,
            "version": schema.version,
            "release_id": release_id,
            "activation_kind": "app_base",
            "schema_hash": effective_hash,
            "base_artifact_hash": base_hash,
            "effective_artifact_hash": effective_hash,
            "materialization_plan_hash": effective_hash,
            "expected_active_effective_hash": null,
            "base_schema": schema_json,
            "customer_overlay": {},
            "schema": schema_json,
            "seed_change_sets": seed_change_sets,
            "phase_plan": []
        }),
    )?;
    if prepared["ok"] != true {
        return Err(format!("prepare app-base seeded revision: {prepared}"));
    }
    let revision_id = prepared["data"]["schema_revision_id"]
        .as_i64()
        .expect("prepared app-base revision id");
    let ready = call(
        client,
        "kernel_validate_schema_revision_readiness",
        json!({
            "app_id": schema.app_id,
            "customer_id": schema.customer_id,
            "schema_revision_id": revision_id,
            "effective_artifact_hash": effective_hash,
            "materialization_plan_hash": effective_hash,
            "phase_results": []
        }),
    )?;
    if ready["ok"] != true {
        return Err(format!("validate app-base seeded revision: {ready}"));
    }
    Ok(revision_id)
}

fn activate_tenant_revision(
    client: &mut Client,
    schema_revision_id: i64,
    effective_hash: &str,
    expected_active_hash: Option<String>,
) -> Result<Value, String> {
    call(
        client,
        "kernel_activate_tenant_schema_revision",
        json!({
            "app_id": "lookup_install_app",
            "customer_id": "tenant_a",
            "schema_revision_id": schema_revision_id,
            "effective_artifact_hash": effective_hash,
            "expected_active_effective_hash": expected_active_hash
        }),
    )
}

fn seed_active_schema(client: &mut Client, schema: &Schema) -> Result<String, String> {
    let schema_json = serde_json::to_value(schema).expect("serialize schema");
    let hash = schema_hash(schema);
    let revision_id: i64 = client
        .query_one(
            r#"
            insert into schema_revision (
              app_id, customer_id, version, base_schema, customer_overlay, schema,
              schema_hash, materialization_source, materialized_at, activated_at
            ) values ($1, $2, $3, $4, '{}'::jsonb, $4, $5, 'test', now(), now())
            returning id
            "#,
            &[
                &schema.app_id.as_str(),
                &schema.customer_id.as_str(),
                &schema.version.as_str(),
                &schema_json,
                &hash,
            ],
        )
        .map_err(|error| format!("seed schema revision: {error:?}"))?
        .get(0);
    client
        .execute(
            r#"
            insert into schema_installation_revision (
              schema_revision_id, app_id, customer_id, release_id, activation_kind,
              base_artifact_hash, effective_artifact_hash, materialization_plan_hash,
              phase_plan, phase_results, ready_at, activated_at
            ) values ($1, $2, $3, 'lookup-install', 'tenant_overlay', $4, $4, $4,
              '[]'::jsonb, '[]'::jsonb, now(), now())
            "#,
            &[
                &revision_id,
                &schema.app_id.as_str(),
                &schema.customer_id.as_str(),
                &hash,
            ],
        )
        .map_err(|error| format!("seed installation revision: {error:?}"))?;
    client
        .execute(
            "select kernel_sync_schema_constraint_identities($1)",
            &[&revision_id],
        )
        .map_err(|error| format!("sync seeded constraint catalog: {error:?}"))?;
    Ok(hash)
}

fn seed_lookup_timeline(client: &mut Client) -> Result<(), String> {
    let revision = client
        .query_one(
                "select id, schema_hash from schema_revision where app_id = 'lookup_install_app' and customer_id = 'tenant_a' and activated_at is not null",
            &[],
        )
        .map_err(|error| format!("read active revision: {error:?}"))?;
    let revision_id: i64 = revision.get(0);
    let schema_hash: String = revision.get(1);
    client
        .execute(
            r#"
            insert into lookup_storage_authority (
              app_id, customer_id, model_id, schema_hash, authority,
              legacy_record_table, legacy_version_table, activated_at
            ) values (
              'lookup_install_app', 'tenant_a', 'department', $1, 'generic',
              'department_record', 'department_version', now()
            )
            on conflict (app_id, customer_id, model_id) do update
            set schema_hash = excluded.schema_hash,
                authority = 'generic',
                activated_at = now()
            "#,
            &[&schema_hash],
        )
        .map_err(|error| format!("establish generic lookup authority: {error:?}"))?;
    let record_id = Uuid::new_v4();
    let first_version = Uuid::new_v4();
    let retired_version = Uuid::new_v4();
    let first_change: i64 = client
        .query_one(
            r#"
            insert into change_set (
              app_id, customer_id, schema_revision_id, created_with_mode, status,
              source_kind, created_order, applied_order, applied_at
            ) values ('lookup_install_app', 'tenant_a', $1, 'mainline', 'mainline',
              'test', 1, 1, now()) returning id
            "#,
            &[&revision_id],
        )
        .map_err(|error| format!("seed active change set: {error:?}"))?
        .get(0);
    let retired_change: i64 = client
        .query_one(
            r#"
            insert into change_set (
              app_id, customer_id, schema_revision_id, created_with_mode, status,
              source_kind, created_order, applied_order, applied_at
            ) values ('lookup_install_app', 'tenant_a', $1, 'mainline', 'mainline',
              'test', 2, 2, now()) returning id
            "#,
            &[&revision_id],
        )
        .map_err(|error| format!("seed retired change set: {error:?}"))?
        .get(0);
    client
        .execute(
            "insert into lookup_record (app_id, customer_id, model_id, id, external_key) values ('lookup_install_app', 'tenant_a', 'department', $1, 'operations')",
            &[&record_id],
        )
        .map_err(|error| format!("seed lookup record: {error:?}"))?;
    client
        .execute(
            r#"
            insert into lookup_version (
              id, app_id, customer_id, model_id, record_id, stage,
              effective_start, effective_end, change_set_id, applied_at,
              availability, metadata, many_relations, values
            ) values (
              $1, 'lookup_install_app', 'tenant_a', 'department', $2, 'mainline',
              '2026-01-01', '2026-07-31', $3, now(), 'active',
              '{}', '{}',
              '{"name":{"type":"text","value":"Operations"},"code":{"type":"text","value":"OPS"}}'
            )
            "#,
            &[&first_version, &record_id, &first_change],
        )
        .map_err(|error| format!("seed active lookup version: {error:?}"))?;
    client
        .execute(
            r#"
            insert into lookup_version (
              id, app_id, customer_id, model_id, record_id, stage,
              effective_start, change_set_id, applied_at, availability,
              metadata, many_relations, values
            ) values (
              $1, 'lookup_install_app', 'tenant_a', 'department', $2, 'mainline',
              '2026-08-01', $3, now(), 'retired', '{}', '{}',
              '{"name":{"type":"text","value":"Operations"},"code":{"type":"text","value":"OPS"}}'
            )
            "#,
            &[&retired_version, &record_id, &retired_change],
        )
        .map_err(|error| format!("seed retired lookup version: {error:?}"))?;
    Ok(())
}

fn assert_lookup_view(
    client: &mut Client,
    as_of: &str,
    expected_count: i64,
    expected_name: Option<&str>,
) -> Result<(), String> {
    let mut transaction = client
        .transaction()
        .map_err(|error| format!("begin safe query: {error:?}"))?;
    let prepared: Value = transaction
        .query_one(
            "select kernel_prepare_visible_query($1::jsonb)",
            &[&json!({
                "app_id": "lookup_install_app",
                "customer_id": "tenant_a",
                "as_of": as_of
            })],
        )
        .map_err(|error| format!("prepare lookup views: {error:?}"))?
        .get(0);
    assert_eq!(
        prepared["ok"], true,
        "safe query preparation failed: {prepared}"
    );
    let count: i64 = transaction
        .query_one("select count(*) from department_record", &[])
        .map_err(|error| format!("query lookup record view: {error:?}"))?
        .get(0);
    assert_eq!(count, expected_count);
    if let Some(expected_name) = expected_name {
        let row = transaction
            .query_one("select name, code, metadata from department_version", &[])
            .map_err(|error| format!("query lookup version view: {error:?}"))?;
        assert_eq!(row.get::<_, String>(0), expected_name);
        assert_eq!(row.get::<_, String>(1), "OPS");
        assert_eq!(row.get::<_, Value>(2), json!({}));
    }
    transaction
        .rollback()
        .map_err(|error| format!("rollback safe query: {error:?}"))
}

fn set_scope(client: &mut Client) -> Result<(), String> {
    client
        .query_one(
            "select set_config('kernel.app_id', 'lookup_install_app', false), set_config('kernel.customer_id', 'tenant_a', false)",
            &[],
        )
        .map_err(|error| format!("set tenant scope: {error:?}"))?;
    Ok(())
}

fn call(client: &mut Client, function: &str, request: Value) -> Result<Value, String> {
    client
        .query_one(&format!("select {function}($1::jsonb)"), &[&request])
        .map(|row| row.get(0))
        .map_err(|error| format!("call {function}: {error:?}"))
}

fn assert_ok_true(result: &Value) {
    assert_eq!(result["ok"], true, "unexpected installer error: {result}");
    assert_eq!(
        result["data"], true,
        "unexpected installer result: {result}"
    );
}

fn assert_pg17(client: &mut Client, feature: &str) {
    let version: i32 = client
        .query_one("show server_version_num", &[])
        .expect("read PostgreSQL version")
        .get::<_, String>(0)
        .parse()
        .expect("numeric PostgreSQL version");
    assert!(version >= 170_000, "{feature} requires PostgreSQL 17");
}

fn assert_permission_denied(
    result: Result<Value, postgres::Error>,
    context: &str,
) -> Result<(), String> {
    let error = result
        .map(|_| ())
        .expect_err("privileged call unexpectedly succeeded");
    if error.code() != Some(&SqlState::INSUFFICIENT_PRIVILEGE) {
        return Err(format!(
            "{context} returned {:?}, expected insufficient_privilege: {error:?}",
            error.code()
        ));
    }
    Ok(())
}

fn assert_client_denied(client: &mut Client, statement: &str, context: &str) -> Result<(), String> {
    let error = client
        .query(statement, &[])
        .expect_err("direct database access unexpectedly succeeded");
    if error.code() != Some(&SqlState::INSUFFICIENT_PRIVILEGE) {
        return Err(format!(
            "{context} returned {:?}, expected insufficient_privilege: {error:?}",
            error.code()
        ));
    }
    Ok(())
}

fn query_value(client: &mut Client, query: &str) -> Result<Value, String> {
    query_value_result(client, query).map_err(|error| format!("principal query: {error:?}"))
}

fn query_value_result(client: &mut Client, query: &str) -> Result<Value, postgres::Error> {
    client.query_one(query, &[]).map(|row| row.get(0))
}

fn principal_database_url(
    database_url: &str,
    principal: &str,
    password: &str,
) -> Result<String, String> {
    let authority_start = database_url
        .find("://")
        .map(|index| index + 3)
        .ok_or_else(|| "database URL is missing a scheme".to_string())?;
    let authority_end = database_url[authority_start..]
        .find(['/', '?'])
        .map(|index| authority_start + index)
        .unwrap_or(database_url.len());
    let host_start = database_url[authority_start..authority_end]
        .rfind('@')
        .map(|index| authority_start + index + 1)
        .unwrap_or(authority_start);
    Ok(format!(
        "{}{}:{}@{}",
        &database_url[..authority_start],
        principal,
        password,
        &database_url[host_start..]
    ))
}

fn seed_mainline_change_set(client: &mut Client) -> Result<i64, String> {
    let revision_id: i64 = client
        .query_one(
            "select id from schema_revision where app_id = 'lookup_install_app' and customer_id = 'tenant_a' and activated_at is not null",
            &[],
        )
        .map_err(|error| format!("read active revision: {error:?}"))?
        .get(0);
    client
        .query_one(
            r#"
            insert into change_set (
              app_id, customer_id, schema_revision_id, created_with_mode, status,
              source_kind, created_order, applied_order, applied_at
            ) values (
              'lookup_install_app', 'tenant_a', $1, 'mainline', 'mainline',
              'test', 1, 1, now()
            ) returning id
            "#,
            &[&revision_id],
        )
        .map(|row| row.get(0))
        .map_err(|error| format!("seed mainline change set: {error:?}"))
}

fn test_database_url() -> Option<String> {
    match env::var("KERNEL_TEST_DATABASE_URL") {
        Ok(value) if !value.trim().is_empty() => Some(value),
        Ok(_) | Err(env::VarError::NotPresent) => {
            eprintln!("skipping lookup installation SQL test: KERNEL_TEST_DATABASE_URL is absent");
            None
        }
        Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
    }
}
