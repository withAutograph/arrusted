#[path = "support/trusted_human.rs"]
mod trusted_human;
use std::collections::BTreeMap;
use std::env;
use std::sync::{mpsc, Arc, Barrier};
use std::thread;
use std::time::{Duration, Instant};

use kernel::testing::{
    apply_generated_sql_change_set_in_transaction, begin_generated_sql_tenant_transaction,
    call_generated_sql, GeneratedSqlFunction,
};
use kernel::{
    connect_postgres, AppId, AppliedChangeSet, ApplyChangeSet, ApplyMode, ChangeType, ChangeTypeId,
    CustomerId, ErrorEnvelope, Field, FieldId, FieldType, FieldValue, Model, ModelId, ModelKind,
    RecordKey, RowVersionWrite, Schema, SchemaRevisionId, SchemaVersion,
};
use postgres::error::SqlState;
use postgres::Client;
use schema_compiler::{
    compile_sql_artifact_manifest, render_sql_artifact_bundle, CompiledManifest,
    NormalizedManifestExtras, SqlArtifactKind,
};
use uuid::Uuid;

const APP_ID: &str = "sql_same_day";

struct TestDatabase {
    client: Client,
    database_url: String,
    schema_name: String,
}

impl TestDatabase {
    fn connect(customer_id: &str) -> Option<Self> {
        let database_url = match env::var("KERNEL_TEST_DATABASE_URL") {
            Ok(url) => url,
            Err(env::VarError::NotPresent) => {
                eprintln!(
                    "skipping generated SQL same-day parity test: KERNEL_TEST_DATABASE_URL is absent"
                );
                return None;
            }
            Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
        };
        let mut client = connect_postgres(&database_url).expect("connect to PostgreSQL");
        let schema_name = format!("kernel_same_day_{}", Uuid::new_v4().simple());
        client
            .batch_execute(&format!(
                "create schema \"{schema_name}\"; set search_path to \"{schema_name}\""
            ))
            .expect("create isolated same-day parity schema");

        let compiled = compiled_manifest(customer_id);
        let mut manifest =
            compile_sql_artifact_manifest(&compiled).expect("compile generated SQL artifacts");
        manifest.artifacts.retain(|artifact| {
            artifact.kind != SqlArtifactKind::Function
                || artifact.name == "kernel_canonical_json(jsonb)"
                || artifact.name == "kernel_physical_identifier(text)"
                || artifact.name == "kernel_installer_capability_role(text)"
                || artifact.name == "kernel_principal_scope_authorized(text,text,text,text)"
                || artifact.name == "kernel_cleanup_generated_visible_query()"
                || artifact.name == "kernel_admin_sha256(text)"
                || artifact.name.starts_with("kernel_bind_")
                || artifact.name.starts_with("kernel_policy_")
                || artifact.name.starts_with("kernel_request_")
                || artifact.name.starts_with("kernel_apply_")
                || artifact.name.starts_with("kernel_constraint_interval_")
                // Public mutation wrappers preserve the original apply body and require
                // their fixed HTTP guard/receipt dependency closure even in legacy parity.
                || artifact.name.starts_with("kernel_http_")
                || artifact.name.starts_with("kernel_admit_http_")
                || artifact.name == "kernel_finish_http_request(jsonb)"
                || artifact.name == "kernel_prune_expired_http_requests(text,text)"
                || artifact.name == "kernel_installer_error(text,text,text,text,text)"
                || artifact.name == "kernel_authorize_scope(text,text,text,text)"
                || artifact.name.starts_with("kernel_validate_change_set")
        });
        trusted_human::before_install(&mut client);
        client
            .batch_execute(&render_sql_artifact_bundle(&manifest))
            .unwrap_or_else(|error| {
                panic!(
                    "install generated same-day bundle: {error}; database error: {:?}",
                    error.as_db_error()
                )
            });
        client
            .batch_execute(
                r#"
                do $kernel_test$
                declare role_name text := kernel_installer_capability_role('execution_owner');
                begin
                  if pg_catalog.to_regrole(role_name) is null then
                    execute pg_catalog.format(
                      'create role %I nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls',
                      role_name
                    );
                  end if;
                end
                $kernel_test$;
                "#,
            )
            .expect("establish generated execution-owner identity");
        trusted_human::grant_capability(&mut client, "execution_owner");
        client
            .execute(
                r#"
                insert into schema_revision (
                  id, app_id, customer_id, version, base_schema, customer_overlay,
                  schema, activated_at, materialized_at
                ) values (1, $1, $2, $3, $4, '{}'::jsonb, $4, now(), now())
                "#,
                &[
                    &APP_ID,
                    &customer_id,
                    &compiled.schema.version.as_str(),
                    &serde_json::to_value(&compiled.schema).expect("serialize test schema"),
                ],
            )
            .expect("activate same-day parity schema");

        trusted_human::bind(&mut client, APP_ID, customer_id, "same-day-parity");
        Some(Self {
            client,
            database_url,
            schema_name,
        })
    }

    fn apply(&mut self, request: &ApplyChangeSet) -> AppliedChangeSet {
        call_generated_sql(
            &mut self.client,
            GeneratedSqlFunction::ApplyChangeSet,
            request,
        )
        .expect("apply through generated SQL API")
    }
}

impl Drop for TestDatabase {
    fn drop(&mut self) {
        let _ = trusted_human::drop_fixture(&mut self.client, &self.schema_name);
    }
}

#[test]
fn concurrent_apply_acquires_activation_lock_before_schema_relations() {
    let Some(mut database) = TestDatabase::connect("activation_lock_order") else {
        return;
    };
    let mut activation_writer = database.client.transaction().unwrap();
    activation_writer
        .query_one(
            r#"
            select pg_advisory_xact_lock(hashtext(
              'postgres-schema:' || current_schema()
              || ':materialize-tenant:' || $1 || ':' || $2
              || ':schema-activation'
            )::bigint)
            "#,
            &[&APP_ID, &"activation_lock_order"],
        )
        .expect("acquire activation writer lock");

    let database_url = database.database_url.clone();
    let schema_name = database.schema_name.clone();
    let writer = thread::spawn(move || {
        let mut client = connect_peer(&database_url, &schema_name);
        let request = serde_json::to_value(apply_request(
            "activation_lock_order",
            "activation-lock-order-write",
            vec![company_write("acme", "2026-08-05", Some("Acme"), false)],
        ))
        .expect("serialize activation-lock request");
        client
            .query_one("select kernel_apply_change_set($1::jsonb)", &[&request])
            .expect_err("apply must retry in a fresh transaction during schema activation")
    });
    let error = writer.join().expect("join generated writer");
    let database_error = error.as_db_error().expect("database error");
    assert_eq!(database_error.code(), &SqlState::T_R_SERIALIZATION_FAILURE);
    assert_eq!(database_error.message(), "record apply dependency drift");

    activation_writer
        .commit()
        .expect("release activation writer lock");
}

#[test]
fn caller_owned_apply_rejects_autocommit_client_before_relation_work() {
    let Some(mut database) = TestDatabase::connect("caller_owned_required") else {
        return;
    };
    let response: serde_json::Value = database
        .client
        .query_one(
            "select kernel_apply_change_set_in_transaction($1::jsonb)",
            &[&serde_json::to_value(apply_request(
                "caller_owned_required",
                "caller-owned-without-transaction",
                vec![company_write("acme", "2026-08-05", Some("Acme"), false)],
            ))
            .unwrap()],
        )
        .expect("caller-owned entrypoint returns a structured contract error")
        .get(0);
    assert_eq!(
        response["error"]["details"][0]["code"],
        "caller_owned_transaction_required"
    );
    let change_sets: i64 = database
        .client
        .query_one(
            "select count(*) from change_set where app_id=$1 and customer_id=$2",
            &[&APP_ID, &"caller_owned_required"],
        )
        .unwrap()
        .get(0);
    assert_eq!(change_sets, 0);
}

#[test]
fn caller_owned_apply_holds_activation_reader_until_outer_transaction_ends() {
    let Some(mut database) = TestDatabase::connect("caller_owned_lock_lifetime") else {
        return;
    };
    let mut outer = begin_generated_sql_tenant_transaction(
        &mut database.client,
        &AppId::from(APP_ID),
        &CustomerId::from("caller_owned_lock_lifetime"),
    )
    .expect("begin caller-owned transaction");
    apply_generated_sql_change_set_in_transaction(
        &mut outer,
        &apply_request(
            "caller_owned_lock_lifetime",
            "caller-owned-lock-lifetime",
            vec![company_write("acme", "2026-08-05", Some("Acme"), false)],
        ),
    )
    .expect("apply in caller-owned transaction");

    let database_url = database.database_url.clone();
    let schema_name = database.schema_name.clone();
    let (pid_sender, pid_receiver) = mpsc::channel();
    let waiter = thread::spawn(move || {
        let mut client = connect_peer(&database_url, &schema_name);
        let mut transaction = client.transaction().unwrap();
        let pid: i32 = transaction
            .query_one("select pg_backend_pid()", &[])
            .unwrap()
            .get(0);
        pid_sender.send(pid).unwrap();
        transaction
            .query_one(
                r#"
                select pg_advisory_xact_lock(hashtext(
                  'postgres-schema:' || current_schema()
                  || ':materialize-tenant:' || $1 || ':' || $2
                  || ':schema-activation'
                )::bigint)
                "#,
                &[&APP_ID, &"caller_owned_lock_lifetime"],
            )
            .expect("activation writer proceeds after caller commit");
        transaction.commit().unwrap();
    });
    let waiter_pid = pid_receiver.recv().unwrap();
    assert!(wait_for_advisory_lock(&mut outer, waiter_pid, "advisory"));
    outer.commit().expect("commit caller-owned transaction");
    waiter.join().expect("join activation writer");
}

#[test]
fn overlapping_mainline_requests_lock_records_canonically_before_ordering() {
    let Some(mut database) = TestDatabase::connect("canonical_locks") else {
        return;
    };
    database.apply(&apply_request(
        "canonical_locks",
        "canonical-lock-baseline",
        vec![
            company_write("alpha", "2026-04-01", Some("Alpha"), false),
            company_write("beta", "2026-04-01", Some("Beta"), false),
        ],
    ));

    let database_url = database.database_url.clone();
    let schema_name = database.schema_name.clone();
    let barrier = Arc::new(Barrier::new(2));
    let first = spawn_apply(
        &database_url,
        &schema_name,
        Arc::clone(&barrier),
        apply_request(
            "canonical_locks",
            "canonical-lock-first",
            vec![
                company_write("alpha", "2026-05-01", Some("Alpha First"), false),
                company_write("beta", "2026-05-01", Some("Beta First"), false),
            ],
        ),
    );
    let second = spawn_apply(
        &database_url,
        &schema_name,
        barrier,
        apply_request(
            "canonical_locks",
            "canonical-lock-second",
            vec![
                company_write("beta", "2026-05-01", Some("Beta Second"), false),
                company_write("alpha", "2026-05-01", Some("Alpha Second"), false),
            ],
        ),
    );

    let first = first.join().expect("join first apply");
    let second = second.join().expect("join second apply");
    let first = first.unwrap_or_else(|error| panic!("first generated apply failed: {error}"));
    let second = second.unwrap_or_else(|error| panic!("second generated apply failed: {error}"));
    assert_ne!(first.id, second.id);

    let rows = database
        .client
        .query(
            r#"
            select idempotency_key, applied_order
            from change_set
            where app_id = $1
              and customer_id = 'canonical_locks'
              and idempotency_key in ('canonical-lock-first', 'canonical-lock-second')
            order by applied_order
            "#,
            &[&APP_ID],
        )
        .expect("read generated apply order");
    assert_eq!(rows.len(), 2);
    assert!(rows[0].get::<_, i64>("applied_order") < rows[1].get("applied_order"));
}

#[test]
fn applied_order_is_allocated_after_the_subject_lock_is_acquired() {
    let Some(mut database) = TestDatabase::connect("post_lock_order") else {
        return;
    };
    database.apply(&apply_request(
        "post_lock_order",
        "post-lock-order-baseline",
        vec![
            company_write("alpha", "2026-04-01", Some("Alpha"), false),
            company_write("beta", "2026-04-01", Some("Beta"), false),
        ],
    ));

    let app_id = AppId::from(APP_ID);
    let customer_id = CustomerId::from("post_lock_order");
    let mut blocker =
        begin_generated_sql_tenant_transaction(&mut database.client, &app_id, &customer_id)
            .expect("begin blocker transaction");
    blocker
        .query_one(
            "select id from company_record where app_id=$1 and customer_id=$2 and external_key='alpha' for update",
            &[&APP_ID, &customer_id.as_str()],
        )
        .expect("lock alpha subject");

    let database_url = database.database_url.clone();
    let schema_name = database.schema_name.clone();
    let (pid_sender, pid_receiver) = mpsc::channel();
    let waiting = thread::spawn(move || {
        let mut client = connect_peer(&database_url, &schema_name);
        let pid: i32 = client
            .query_one("select pg_backend_pid()", &[])
            .expect("read waiting backend pid")
            .get(0);
        pid_sender.send(pid).expect("send waiting backend pid");
        call_generated_sql::<AppliedChangeSet>(
            &mut client,
            GeneratedSqlFunction::ApplyChangeSet,
            &apply_request(
                "post_lock_order",
                "post-lock-order-alpha",
                vec![company_write(
                    "alpha",
                    "2026-05-01",
                    Some("Alpha Updated"),
                    false,
                )],
            ),
        )
        .map_err(|error| format!("{error:?}"))
    });
    let waiting_pid = pid_receiver.recv().expect("receive waiting backend pid");
    if !wait_for_lock(&mut blocker, waiting_pid) {
        blocker
            .rollback()
            .expect("release alpha lock after timeout");
        let _ = waiting.join();
        panic!("waiting generated apply never reached the subject lock");
    }

    let beta = {
        let mut peer = connect_peer(&database.database_url, &database.schema_name);
        call_generated_sql::<AppliedChangeSet>(
            &mut peer,
            GeneratedSqlFunction::ApplyChangeSet,
            &apply_request(
                "post_lock_order",
                "post-lock-order-beta",
                vec![company_write(
                    "beta",
                    "2026-05-01",
                    Some("Beta Updated"),
                    false,
                )],
            ),
        )
        .expect("apply independent beta update")
    };
    blocker.commit().expect("release alpha subject lock");
    let alpha = waiting
        .join()
        .expect("join waiting generated apply")
        .unwrap_or_else(|error| panic!("waiting generated apply failed: {error}"));

    let rows = database
        .client
        .query(
            "select id, applied_order from change_set where id = any($1) order by applied_order",
            &[&vec![alpha.id, beta.id]],
        )
        .expect("read post-lock apply order");
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].get::<_, i64>("id"), beta.id);
    assert_eq!(rows[1].get::<_, i64>("id"), alpha.id);
}

#[test]
fn caller_owned_apply_aborts_the_outer_transaction_on_dependency_drift() {
    let Some(mut database) = TestDatabase::connect("caller_owned_drift") else {
        return;
    };
    database.apply(&apply_request(
        "caller_owned_drift",
        "caller-owned-drift-baseline",
        vec![company_write("acme", "2026-04-01", Some("Acme"), false)],
    ));

    let app_id = AppId::from(APP_ID);
    let customer_id = CustomerId::from("caller_owned_drift");
    let mut blocker =
        begin_generated_sql_tenant_transaction(&mut database.client, &app_id, &customer_id)
            .expect("begin dependency-drift blocker");
    blocker
        .query_one(
            "select id from company_record where app_id=$1 and customer_id=$2 and external_key='acme' for update",
            &[&APP_ID, &customer_id.as_str()],
        )
        .expect("lock dependency-drift subject");

    let database_url = database.database_url.clone();
    let schema_name = database.schema_name.clone();
    let (pid_sender, pid_receiver) = mpsc::channel();
    let waiter = thread::spawn(move || {
        let mut client = connect_peer(&database_url, &schema_name);
        let mut transaction = begin_generated_sql_tenant_transaction(
            &mut client,
            &AppId::from(APP_ID),
            &CustomerId::from("caller_owned_drift"),
        )
        .expect("begin waiting caller-owned transaction");
        let pid: i32 = transaction
            .query_one("select pg_backend_pid()", &[])
            .expect("read caller-owned backend pid")
            .get(0);
        pid_sender.send(pid).expect("send caller-owned backend pid");
        let error = apply_generated_sql_change_set_in_transaction(
            &mut transaction,
            &apply_request(
                "caller_owned_drift",
                "caller-owned-drift-waiter",
                vec![company_write(
                    "acme",
                    "2026-05-01",
                    Some("Acme Waiting"),
                    false,
                )],
            ),
        )
        .expect_err("dependency drift must escape caller-owned generated apply");
        let aborted = transaction
            .query_one("select 1", &[])
            .expect_err("dependency drift must abort caller-owned transaction");
        let transaction_aborted = aborted.code() == Some(&SqlState::IN_FAILED_SQL_TRANSACTION);
        transaction
            .rollback()
            .expect("roll back aborted caller-owned transaction");
        (error.into_envelope(), transaction_aborted)
    });
    let waiting_pid = pid_receiver
        .recv()
        .expect("receive caller-owned backend pid");
    if !wait_for_lock(&mut blocker, waiting_pid) {
        blocker
            .rollback()
            .expect("release dependency-drift lock after timeout");
        let _ = waiter.join();
        panic!("caller-owned generated apply never reached the subject lock");
    }

    apply_generated_sql_change_set_in_transaction(
        &mut blocker,
        &apply_request(
            "caller_owned_drift",
            "caller-owned-drift-blocker",
            vec![company_write(
                "acme",
                "2026-05-01",
                Some("Acme Blocker"),
                false,
            )],
        ),
    )
    .expect("apply blocker update");
    blocker.commit().expect("commit blocker update");

    let (error, transaction_aborted) = waiter.join().expect("join caller-owned waiter");
    assert_eq!(
        error,
        ErrorEnvelope {
            code: "database_error".to_string(),
            message: "Database operation failed".to_string(),
            details: Vec::new(),
        }
    );
    assert!(transaction_aborted);
    let residue: i64 = database
        .client
        .query_one(
            "select count(*) from change_set where app_id=$1 and customer_id='caller_owned_drift' and idempotency_key='caller-owned-drift-waiter'",
            &[&APP_ID],
        )
        .expect("count rolled-back waiter change sets")
        .get(0);
    assert_eq!(residue, 0);
}

#[test]
fn generated_version_indexes_reject_duplicate_ordinary_and_lifecycle_rows() {
    let Some(mut database) = TestDatabase::connect("version_uniqueness") else {
        return;
    };
    let baseline = database.apply(&apply_request(
        "version_uniqueness",
        "ordinary-baseline",
        vec![company_write("acme", "2026-04-01", Some("Acme"), false)],
    ));

    let ordinary_duplicate = database.client.execute(
        r#"
        insert into company_version (
          id, record_id, app_id, customer_id, stage, effective_start, effective_end,
          change_set_id, applied_at, tombstones_record, untombstones_record,
          custom_fields, provenance, name
        )
        select $1, record_id, app_id, customer_id, stage, effective_start, effective_end,
               change_set_id, applied_at, tombstones_record, untombstones_record,
               custom_fields, provenance, name
        from company_version
        where change_set_id = $2
        "#,
        &[&Uuid::new_v4(), &baseline.id],
    );
    assert_eq!(
        ordinary_duplicate
            .expect_err("ordinary duplicate must fail")
            .code(),
        Some(&SqlState::UNIQUE_VIOLATION)
    );

    let tombstone = database.apply(&apply_request(
        "version_uniqueness",
        "lifecycle-tombstone",
        vec![company_write("acme", "2026-05-01", None, true)],
    ));
    let other = database.apply(&apply_request(
        "version_uniqueness",
        "lifecycle-other",
        vec![company_write("beta", "2026-05-01", Some("Beta"), false)],
    ));
    let lifecycle_duplicate = database.client.execute(
        r#"
        insert into company_version (
          id, record_id, app_id, customer_id, stage, effective_start, effective_end,
          change_set_id, applied_at, tombstones_record, untombstones_record,
          custom_fields, provenance, name
        )
        select $1, record_id, app_id, customer_id, stage, effective_start, effective_end,
               $2, applied_at, tombstones_record, untombstones_record,
               custom_fields, provenance, name
        from company_version
        where change_set_id = $3
        "#,
        &[&Uuid::new_v4(), &other.id, &tombstone.id],
    );
    assert_eq!(
        lifecycle_duplicate
            .expect_err("mainline lifecycle duplicate must fail")
            .code(),
        Some(&SqlState::UNIQUE_VIOLATION)
    );
}

#[test]
fn generated_change_set_constraints_reject_impossible_applied_order_states() {
    let Some(mut database) = TestDatabase::connect("change_set_state") else {
        return;
    };
    let applied = database.apply(&apply_request(
        "change_set_state",
        "valid-mainline",
        vec![company_write("acme", "2026-04-01", Some("Acme"), false)],
    ));
    let valid: bool = database
        .client
        .query_one(
            "select status='mainline' and applied_order is not null and created_order=applied_order from change_set where id=$1",
            &[&applied.id],
        )
        .expect("read valid generated mainline state")
        .get(0);
    assert!(valid);

    let mainline_without_order = database.client.execute(
        r#"
        insert into change_set (
          app_id, customer_id, schema_revision_id, created_with_mode, status,
          source_kind, created_order, applied_order, applied_at
        ) values ($1, 'change_set_state', 1, 'mainline', 'mainline', 'fixture',
                  nextval('change_set_lifecycle_order_seq'), null, now())
        "#,
        &[&APP_ID],
    );
    assert_eq!(
        mainline_without_order
            .expect_err("mainline without applied_order must fail")
            .code(),
        Some(&SqlState::CHECK_VIOLATION)
    );

    let draft_with_order = database.client.execute(
        r#"
        insert into change_set (
          app_id, customer_id, schema_revision_id, created_with_mode, status,
          source_kind, created_order, applied_order, applied_at
        ) values ($1, 'change_set_state', 1, 'draft', 'draft', 'fixture',
                  nextval('change_set_lifecycle_order_seq'),
                  nextval('change_set_lifecycle_order_seq'), null)
        "#,
        &[&APP_ID],
    );
    assert_eq!(
        draft_with_order
            .expect_err("non-mainline with applied_order must fail")
            .code(),
        Some(&SqlState::CHECK_VIOLATION)
    );
}

fn compiled_manifest(customer_id: &str) -> CompiledManifest {
    CompiledManifest {
        schema: Schema {
            app_id: AppId::from(APP_ID),
            customer_id: CustomerId::from(customer_id),
            version: SchemaVersion::from("2026-08-04"),
            models: vec![Model {
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
            }],
            custom_fields: vec![],
            change_types: vec![ChangeType {
                id: ChangeTypeId::from("company_update"),
                label: "Company Update".to_string(),
                target_model: ModelId::from("company"),
                is_import_default: false,
                touches: vec![],
                required: vec![],
            }],
        },
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

fn apply_request(
    customer_id: &str,
    idempotency_key: &str,
    writes: Vec<RowVersionWrite>,
) -> ApplyChangeSet {
    ApplyChangeSet {
        app_id: AppId::from(APP_ID),
        customer_id: CustomerId::from(customer_id),
        schema_revision_id: Some(SchemaRevisionId::new(1)),
        actor_id: Some("same-day-parity".to_string()),
        source_kind: "test".to_string(),
        source_ref: None,
        idempotency_key: Some(idempotency_key.to_string()),
        change_type_id: None,
        notes: None,
        mode: ApplyMode::Mainline,
        writes,
    }
}

fn company_write(
    external_key: &str,
    effective_start: &str,
    name: Option<&str>,
    tombstones_record: bool,
) -> RowVersionWrite {
    RowVersionWrite {
        model_id: ModelId::from("company"),
        record_key: Some(RecordKey::ExternalKey(external_key.into())),
        new_record_id: None,
        effective_start: effective_start.parse().expect("valid fixture date"),
        values: name.map(|name| {
            BTreeMap::from([(FieldId::from("name"), FieldValue::Text(name.to_string()))])
        }),
        custom_fields: None,
        tombstones_record,
        provenance: None,
        ..Default::default()
    }
}

fn spawn_apply(
    database_url: &str,
    schema_name: &str,
    barrier: Arc<Barrier>,
    request: ApplyChangeSet,
) -> thread::JoinHandle<Result<AppliedChangeSet, String>> {
    let database_url = database_url.to_string();
    let schema_name = schema_name.to_string();
    thread::spawn(move || {
        let mut client = connect_peer(&database_url, &schema_name);
        barrier.wait();
        GeneratedSqlFunction::ApplyChangeSet
            .call_top_level(&mut client, &request)
            .map_err(|error| format!("{error:?}"))
    })
}

fn connect_peer(database_url: &str, schema_name: &str) -> Client {
    let mut client = connect_postgres(database_url).expect("connect peer PostgreSQL session");
    client
        .batch_execute(&format!(
            "set search_path to \"{schema_name}\"; set statement_timeout = '10s'"
        ))
        .expect("configure peer PostgreSQL session");
    trusted_human::select(&mut client, "same-day-parity");
    client
}

fn wait_for_lock(client: &mut impl postgres::GenericClient, pid: i32) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        let waiting: bool = client
            .query_one(
                "select exists (select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock')",
                &[&pid],
            )
            .expect("inspect waiting backend")
            .get(0);
        if waiting {
            return true;
        }
        thread::sleep(Duration::from_millis(10));
    }
    false
}

fn wait_for_advisory_lock(
    client: &mut impl postgres::GenericClient,
    pid: i32,
    wait_event: &str,
) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        let waiting: bool = client
            .query_one(
                "select exists (select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock' and wait_event=$2)",
                &[&pid, &wait_event],
            )
            .expect("inspect advisory-lock waiter")
            .get(0);
        if waiting {
            return true;
        }
        thread::sleep(Duration::from_millis(10));
    }
    false
}
