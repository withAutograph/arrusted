use std::env;
use std::sync::{mpsc, Arc, Barrier};
use std::thread;
use std::time::Duration;

use kernel::connect_postgres;
use postgres::{Client, Transaction};
use schema_compiler::{
    compile_manifest_json, compile_sql_artifact_manifest, render_sql_artifact_bundle,
    SqlArtifactKind,
};
use serde_json::{json, Value};
use uuid::Uuid;

#[test]
fn concurrent_materialization_acquires_query_role_before_catalog_relations_via_generated_installer()
{
    let Some(mut harness) = Harness::new("query_role_lock_order") else {
        return;
    };
    let schema = harness.activate("tenant_a", "2026-08-05.base", hash('a'));
    let query_role: String = harness
        .client
        .query_one("select kernel_installer_capability_role('query')", &[])
        .expect("read generated query role")
        .get(0);
    let mut blocker = connect_to_schema(&harness.database_url, &harness.schema_name);
    let mut blocker = blocker.transaction().expect("start query-role blocker");
    blocker
        .query_one(
            "select pg_advisory_xact_lock(hashtext($1)::bigint)",
            &[&query_role],
        )
        .expect("hold generated query-role lock");

    let mut materializer = connect_to_schema(&harness.database_url, &harness.schema_name);
    let materializer_pid: i32 = materializer
        .query_one("select pg_backend_pid()", &[])
        .expect("read materializer backend pid")
        .get(0);
    let materialization = thread::spawn(move || repair(&mut materializer, &schema));
    wait_for_advisory_lock(&mut harness.client, materializer_pid);

    blocker
        .batch_execute("lock table schema_revision in access exclusive mode nowait")
        .expect("query-role wait must precede generated catalog relation locks");
    blocker.commit().expect("release generated query-role lock");
    assert_ok_true(&materialization.join().expect("join materializer"));
}

#[test]
fn independent_postgres_schemas_materialize_while_peer_is_guarded_via_generated_installer() {
    let Some(mut first) = Harness::new("independent_first") else {
        return;
    };
    let Some(mut second) = Harness::new("independent_second") else {
        return;
    };
    let first_schema = first.activate("tenant_a", "2026-08-05.first", hash('a'));
    let second_schema = second.activate("tenant_b", "2026-08-05.second", hash('b'));
    let first_query_role: String = first
        .client
        .query_one("select kernel_installer_capability_role('query')", &[])
        .expect("read first generated query role")
        .get(0);
    let second_query_role: String = second
        .client
        .query_one("select kernel_installer_capability_role('query')", &[])
        .expect("read second generated query role")
        .get(0);
    assert_ne!(first_query_role, second_query_role);

    let mut blocker = connect_to_schema(&first.database_url, &first.schema_name);
    let mut blocker = blocker.transaction().expect("start first schema blocker");
    blocker
        .query_one(
            "select pg_advisory_xact_lock(hashtext($1)::bigint)",
            &[&first_query_role],
        )
        .expect("hold first generated query-role lock");
    let mut first_materializer = connect_to_schema(&first.database_url, &first.schema_name);
    let first_pid: i32 = first_materializer
        .query_one("select pg_backend_pid()", &[])
        .expect("read first materializer backend pid")
        .get(0);
    let first_run = thread::spawn(move || repair(&mut first_materializer, &first_schema));
    wait_for_advisory_lock(&mut first.client, first_pid);

    let mut second_materializer = connect_to_schema(&second.database_url, &second.schema_name);
    let (second_done_tx, second_done_rx) = mpsc::channel();
    let second_run = thread::spawn(move || {
        second_done_tx
            .send(repair(&mut second_materializer, &second_schema))
            .expect("report second materialization");
    });
    let second_result = second_done_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("independent generated schema must not share advisory-lock scope");
    assert_ok_true(&second_result);

    blocker.commit().expect("release first query-role lock");
    assert_ok_true(&first_run.join().expect("join first materializer"));
    second_run.join().expect("join second materializer");
}

#[test]
fn activation_head_trigger_drift_fails_validation_and_guarded_materialization_repairs_it_via_generated_installer(
) {
    let Some(mut harness) = Harness::new("trigger_repair") else {
        return;
    };
    let schema = harness.activate("tenant_a", "2026-08-04.base", hash('a'));
    harness
        .client
        .batch_execute(
            "alter table schema_revision disable trigger schema_revision_activation_head",
        )
        .expect("disable activation-head trigger");
    assert_schema_drift(
        &validate(&mut harness.client, &schema),
        "schema_revision.schema_revision_activation_head",
        "activation-head trigger differs from the compiled catalog",
    );
    assert_ok_true(&repair(&mut harness.client, &schema));

    harness
        .client
        .batch_execute(
            r#"
            drop trigger schema_revision_activation_head on schema_revision;
            create trigger schema_revision_activation_head
              before insert or update of activated_at, base_schema on schema_revision
              for each row when (false)
              execute function kernel_enforce_schema_activation_head();
            "#,
        )
        .expect("drift activation-head trigger predicate");
    assert_schema_drift(
        &validate(&mut harness.client, &schema),
        "schema_revision.schema_revision_activation_head",
        "activation-head trigger differs from the compiled catalog",
    );
    assert_ok_true(&repair(&mut harness.client, &schema));
    let has_no_when_clause: bool = harness
        .client
        .query_one(
            r#"
            select trigger_value.tgqual is null
            from pg_trigger trigger_value
            where trigger_value.tgrelid = 'schema_revision'::regclass
              and trigger_value.tgname = 'schema_revision_activation_head'
            "#,
            &[],
        )
        .expect("inspect repaired trigger")
        .get(0);
    assert!(has_no_when_clause);
}

#[test]
fn activation_head_trigger_respects_forced_rls_without_mutating_tenant_scope_via_generated_installer(
) {
    let Some(mut harness) = Harness::new_owned("trigger_rls") else {
        return;
    };
    let schema = harness.activate("tenant_a", "2026-08-04.base", hash('a'));
    assert_ok_true(&validate(&mut harness.client, &schema));

    let mut transaction = harness.client.transaction().expect("start RLS transaction");
    transaction
        .query_one(
            "select set_config('kernel.app_id', 'installer_app', true)",
            &[],
        )
        .expect("set app scope");
    transaction
        .query_one(
            "select set_config('kernel.customer_id', 'tenant_a', true)",
            &[],
        )
        .expect("set customer scope");
    transaction
        .query_one(
            "select set_config('kernel.schema_catalog_read', 'on', true)",
            &[],
        )
        .expect("enable catalog reads without granting catalog writes");
    transaction.batch_execute("savepoint wrong_insert").unwrap();
    let insert_error = transaction
        .execute(
            r#"
            insert into schema_revision (
              app_id, customer_id, version, base_schema, customer_overlay, schema,
              schema_hash, activated_at
            )
            select app_id, 'tenant_wrong', 'wrong-insert', base_schema,
                   customer_overlay, schema, schema_hash, now()
            from schema_revision where customer_id = 'tenant_a' and activated_at is not null
            "#,
            &[],
        )
        .expect_err("forced RLS must reject wrong-scope insert");
    assert_eq!(
        insert_error.code(),
        Some(&postgres::error::SqlState::INSUFFICIENT_PRIVILEGE)
    );
    transaction
        .batch_execute("rollback to savepoint wrong_insert; release savepoint wrong_insert")
        .unwrap();
    assert_eq!(
        tenant_scope(&mut transaction),
        ("installer_app".into(), "tenant_a".into())
    );

    transaction.batch_execute("savepoint wrong_update").unwrap();
    let update_error = transaction
        .execute(
            "update schema_revision set customer_id = 'tenant_wrong' where customer_id = 'tenant_a' and activated_at is not null",
            &[],
        )
        .expect_err("forced RLS must reject wrong-scope update");
    assert_eq!(
        update_error.code(),
        Some(&postgres::error::SqlState::INSUFFICIENT_PRIVILEGE)
    );
    transaction
        .batch_execute("rollback to savepoint wrong_update; release savepoint wrong_update")
        .unwrap();
    assert_eq!(
        tenant_scope(&mut transaction),
        ("installer_app".into(), "tenant_a".into())
    );
    transaction.rollback().unwrap();
}

#[test]
fn activation_head_rejects_competing_before_row_revision_triggers_via_generated_installer() {
    let Some(mut harness) = Harness::new("competing_trigger") else {
        return;
    };
    let schema = harness.activate("tenant_a", "2026-08-04.base", hash('a'));
    harness
        .client
        .batch_execute(
            r#"
            create function zz_rewrite_schema_revision_base() returns trigger language plpgsql as $$
            begin new.base_schema = jsonb_set(new.base_schema, '{version}', '"bypassed"'); return new; end
            $$;
            create trigger zz_rewrite_schema_revision_base
              before insert or update on schema_revision
              for each row execute function zz_rewrite_schema_revision_base();
            "#,
        )
        .expect("install competing trigger");
    for result in [
        validate(&mut harness.client, &schema),
        repair(&mut harness.client, &schema),
    ] {
        assert_schema_drift(
            &result,
            "schema_revision.zz_rewrite_schema_revision_base",
            "competing BEFORE ROW INSERT/UPDATE trigger could mutate the revision after the activation-head check",
        );
    }
    harness
        .client
        .batch_execute(
            "drop trigger zz_rewrite_schema_revision_base on schema_revision; drop function zz_rewrite_schema_revision_base()",
        )
        .unwrap();
    assert_ok_true(&repair(&mut harness.client, &schema));
}

#[test]
fn materialize_schema_rejects_unique_index_drift_via_generated_installer() {
    let Some(mut harness) = Harness::new("unique_index") else {
        return;
    };
    let schema = harness.activate("tenant_a", "2026-08-04.base", hash('a'));
    harness
        .client
        .batch_execute(
            "drop index employee_version_ref_live_unique_idx; create index employee_version_ref_live_unique_idx on employee_version (app_id, customer_id, ref)",
        )
        .unwrap();
    assert_schema_drift(
        &repair(&mut harness.client, &schema),
        "employee_version.employee_version_ref_live_unique_idx",
        "materialized index definition or readiness differs from the compiled catalog",
    );
}

#[test]
fn materialize_schema_sets_tenant_scope_before_forced_rls_writes_via_generated_installer() {
    let Some(mut harness) = Harness::new_owned("materialize_rls") else {
        return;
    };
    let schema = harness.activate("tenant_a", "2026-08-04.base", hash('a'));
    assert_ok_true(&validate(&mut harness.client, &schema));
    assert_ok_true(&call(
        &mut harness.client,
        "kernel_schema_revision_is_active_with_materialized_tables",
        json!({"schema": schema}),
    ));
    let policies: Vec<(String, String)> = harness
        .client
        .query(
            r#"
            select policyname::text, cmd
            from pg_policies
            where schemaname = current_schema() and tablename = 'schema_revision'
            order by policyname
            "#,
            &[],
        )
        .expect("read split schema-revision policies")
        .into_iter()
        .map(|row| (row.get(0), row.get(1)))
        .collect();
    assert_eq!(
        policies,
        [
            ("kernel_schema_catalog_read".into(), "SELECT".into()),
            ("kernel_tenant_isolation".into(), "ALL".into()),
        ]
    );
    harness
        .client
        .batch_execute(
            "select set_config('kernel.app_id', 'installer_app', false); select set_config('kernel.customer_id', 'tenant_a', false)",
        )
        .expect("set scope for post-materialization read");
    let count: i64 = harness
        .client
        .query_one("select count(*) from schema_revision", &[])
        .expect("read tenant revision under forced RLS")
        .get(0);
    assert_eq!(count, 1);
}

#[test]
fn concurrent_materialize_schema_serializes_shared_substrate_ddl_via_generated_installer() {
    let Some(mut harness) = Harness::new("concurrent_ddl") else {
        return;
    };
    let first_schema = harness.activate("tenant_a", "2026-08-04.a", hash('a'));
    let second_schema = harness.activate("tenant_b", "2026-08-04.b", hash('b'));
    harness
        .client
        .batch_execute("drop index employee_version_change_set_value_once_idx")
        .unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let handles = [first_schema, second_schema]
        .into_iter()
        .map(|schema| {
            let database_url = harness.database_url.clone();
            let schema_name = harness.schema_name.clone();
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                let mut client = connect_postgres(&database_url).unwrap();
                client
                    .batch_execute(&format!("set search_path to \"{schema_name}\""))
                    .unwrap();
                barrier.wait();
                repair(&mut client, &schema)
            })
        })
        .collect::<Vec<_>>();
    for handle in handles {
        assert_ok_true(&handle.join().expect("concurrent repair thread"));
    }
}

#[test]
fn materialize_schema_rejects_semantic_check_drift_via_generated_installer() {
    assert_drift_after(
        "semantic_check",
        r#"
        alter table employee_version drop constraint employee_version_stage_check;
        alter table employee_version add constraint employee_version_stage_check
          check (stage in ('draft', 'mainline', 'discarded', 'reverted', 'broken'));
        "#,
        "employee_version.employee_version_stage_check",
        "materialized constraint definition or validation state differs from the compiled catalog",
    );
}

#[test]
fn materialize_schema_rejects_wrong_index_order_via_generated_installer() {
    assert_drift_after(
        "index_order",
        r#"
        drop index employee_version_change_set_value_once_idx;
        create unique index employee_version_change_set_value_once_idx
          on employee_version (effective_start, record_id, change_set_id)
          where not tombstones_record and not untombstones_record;
        "#,
        "employee_version.employee_version_change_set_value_once_idx",
        "materialized index definition or readiness differs from the compiled catalog",
    );
}

#[test]
fn materialize_schema_rejects_static_index_drift_via_generated_installer() {
    assert_drift_after(
        "static_index",
        r#"
        drop index schema_revision_active_idx;
        create unique index schema_revision_active_idx
          on schema_revision (customer_id, app_id) where activated_at is not null;
        "#,
        "schema_revision.schema_revision_active_idx",
        "materialized index definition or readiness differs from the compiled catalog",
    );
}

#[test]
fn materialize_schema_rejects_index_on_wrong_table_via_generated_installer() {
    assert_drift_after(
        "index_table",
        r#"
        drop index schema_revision_active_idx;
        create table index_probe (app_id text, customer_id text, activated_at timestamptz);
        create unique index schema_revision_active_idx
          on index_probe (app_id, customer_id) where activated_at is not null;
        "#,
        "schema_revision.schema_revision_active_idx",
        "required materialized index is missing",
    );
}

#[test]
fn materialize_schema_rejects_core_unique_constraint_drift_via_generated_installer() {
    assert_drift_after(
        "core_unique",
        r#"
        alter table schema_revision drop constraint schema_revision_scope_version_key;
        alter table schema_revision add constraint schema_revision_scope_version_key
          unique (customer_id, app_id, version);
        "#,
        "schema_revision.schema_revision_scope_version_key",
        "unique constraint contract differs from the compiled catalog",
    );
}

#[test]
fn materialize_schema_rejects_core_foreign_key_drift_via_generated_installer() {
    assert_drift_after(
        "core_fk",
        r#"
        alter table employee_version drop constraint employee_version_change_set_tenant_fk;
        alter table employee_version add constraint employee_version_change_set_tenant_fk
          foreign key (change_set_id) references change_set(id);
        "#,
        "employee_version.employee_version_change_set_tenant_fk",
        "foreign key contract differs from the compiled catalog",
    );
}

#[test]
fn materialize_schema_rejects_core_unique_deferrability_drift_via_generated_installer() {
    assert_drift_after(
        "core_unique_deferred",
        r#"
        alter table schema_revision drop constraint schema_revision_scope_version_key;
        alter table schema_revision add constraint schema_revision_scope_version_key
          unique (app_id, customer_id, version) deferrable initially immediate;
        "#,
        "schema_revision.schema_revision_scope_version_key",
        "unique constraint contract differs from the compiled catalog",
    );
}

#[test]
fn materialize_schema_rejects_core_foreign_key_schema_drift_via_generated_installer() {
    let Some(mut harness) = Harness::new("fk_schema") else {
        return;
    };
    let schema = harness.activate("tenant_a", "2026-08-04.base", hash('a'));
    let other_schema = format!("kernel_other_{}", Uuid::new_v4().simple());
    harness
        .client
        .batch_execute(&format!(
            r#"
            create schema "{other_schema}";
            create table "{other_schema}".change_set (
              id bigint not null, app_id text not null, customer_id text not null,
              unique (id, app_id, customer_id)
            );
            alter table employee_version drop constraint employee_version_change_set_tenant_fk;
            alter table employee_version add constraint employee_version_change_set_tenant_fk
              foreign key (change_set_id, app_id, customer_id)
              references "{other_schema}".change_set(id, app_id, customer_id);
            "#
        ))
        .unwrap();
    assert_schema_drift(
        &repair(&mut harness.client, &schema),
        "employee_version.employee_version_change_set_tenant_fk",
        "foreign key contract differs from the compiled catalog",
    );
    harness
        .client
        .batch_execute(&format!("drop schema \"{other_schema}\" cascade"))
        .unwrap();
}

#[test]
fn materialize_schema_rejects_core_foreign_key_action_drift_via_generated_installer() {
    assert_drift_after(
        "fk_action",
        r#"
        alter table employee_version drop constraint employee_version_change_set_tenant_fk;
        alter table employee_version add constraint employee_version_change_set_tenant_fk
          foreign key (change_set_id, app_id, customer_id)
          references change_set(id, app_id, customer_id) on delete cascade;
        "#,
        "employee_version.employee_version_change_set_tenant_fk",
        "foreign key contract differs from the compiled catalog",
    );
}

#[test]
fn materialize_schema_rejects_default_drift_via_generated_installer() {
    assert_drift_after(
        "default",
        "alter table employee_version alter column tombstones_record set default true",
        "employee_version",
        "materialized column default differs from the compiled catalog",
    );
}

#[test]
fn materialize_schema_rejects_sequence_default_drift_via_generated_installer() {
    assert_drift_after(
        "sequence_default",
        "alter table change_set alter column id set default 1",
        "change_set",
        "sequence-backed column default differs from the compiled catalog",
    );
}

#[test]
fn materialize_schema_repairs_extra_rls_policy_drift_via_generated_installer() {
    let Some(mut harness) = Harness::new("extra_policy") else {
        return;
    };
    let schema = harness.activate("tenant_a", "2026-08-04.base", hash('a'));
    harness
        .client
        .batch_execute(
            "create policy bypass_policy on company_record using (true) with check (true)",
        )
        .unwrap();

    assert_ok_true(&repair(&mut harness.client, &schema));
    assert_policy_names(
        &mut harness.client,
        "company_record",
        &["kernel_tenant_isolation"],
    );
}

#[test]
fn generated_bundle_reconciles_activation_head_policy_without_touching_app_owned_tables() {
    let Some(mut harness) = Harness::new("activation_head_policy") else {
        return;
    };
    harness
        .client
        .batch_execute(
            r#"
            drop policy kernel_tenant_isolation on schema_activation_head;
            create policy platform_tenant_scope on schema_activation_head
              for all using (true) with check (true);
            create policy legacy_tenant_scope on schema_activation_head
              for all using (true) with check (true);

            create table application_owned_evidence (
              app_id text not null,
              customer_id text not null,
              marker text not null
            );
            alter table application_owned_evidence enable row level security;
            alter table application_owned_evidence force row level security;
            create policy application_owned_policy on application_owned_evidence
              for all using (true) with check (true);
            insert into application_owned_evidence values ('app', 'customer', 'preserved');
            "#,
        )
        .expect("install legacy activation-head and unrelated app-owned policies");

    harness.install_bundle();

    assert_policy_names(
        &mut harness.client,
        "schema_activation_head",
        &["kernel_tenant_isolation"],
    );
    let activation_head_rls = harness
        .client
        .query_one(
            "select relrowsecurity, relforcerowsecurity from pg_class where oid = 'schema_activation_head'::regclass",
            &[],
        )
        .expect("inspect repaired activation-head RLS");
    assert!(activation_head_rls.get::<_, bool>(0));
    assert!(activation_head_rls.get::<_, bool>(1));

    assert_policy_names(
        &mut harness.client,
        "application_owned_evidence",
        &["application_owned_policy"],
    );
    let preserved_marker: String = harness
        .client
        .query_one("select marker from application_owned_evidence", &[])
        .expect("read unrelated app-owned evidence")
        .get(0);
    assert_eq!(preserved_marker, "preserved");
}

#[test]
fn policy_reconciliation_repairs_legacy_preview_state_before_strict_validation_via_generated_installer(
) {
    let Some(mut harness) = Harness::new("missing_policy") else {
        return;
    };
    let schema = harness.activate("tenant_a", "2026-08-04.base", hash('a'));
    harness
        .client
        .batch_execute("drop policy kernel_tenant_isolation on company_record")
        .unwrap();

    assert_schema_drift(
        &validate(&mut harness.client, &schema),
        "company_record.kernel_tenant_isolation",
        "RLS or tenant policy differs from the compiled catalog",
    );
    assert_ok_true(&repair(&mut harness.client, &schema));
    assert_ok_true(&validate(&mut harness.client, &schema));
}

#[test]
fn policy_reconciliation_replaces_additional_legacy_policies_via_generated_installer() {
    let Some(mut harness) = Harness::new("legacy_policy") else {
        return;
    };
    let schema = harness.activate("tenant_a", "2026-08-04.base", hash('a'));
    harness
        .client
        .batch_execute(
            "create policy legacy_tenant_scope on company_record for all using (true) with check (true)",
        )
        .unwrap();

    assert_ok_true(&repair(&mut harness.client, &schema));
    assert_policy_names(
        &mut harness.client,
        "company_record",
        &["kernel_tenant_isolation"],
    );
}

#[test]
fn policy_reconciliation_reports_missing_kernel_tables_as_schema_drift_via_generated_installer() {
    let Some(mut harness) = Harness::new("missing_policy_table") else {
        return;
    };
    let schema = harness.activate("tenant_a", "2026-08-04.base", hash('a'));
    harness
        .client
        .batch_execute(
            r#"
            alter table company_version drop constraint company_version_change_set_tenant_fk;
            alter table employee_version drop constraint employee_version_change_set_tenant_fk;
            alter table lookup_version drop constraint lookup_version_change_set_fk;
            drop table change_set;
            "#,
        )
        .unwrap();

    assert_schema_drift(
        &validate(&mut harness.client, &schema),
        "change_set",
        "required materialized table is missing",
    );
}

#[test]
fn materialize_schema_probe_helpers_do_not_drop_permanent_tables_via_generated_installer() {
    let Some(mut harness) = Harness::empty("probe_tables", false) else {
        return;
    };
    harness
        .client
        .batch_execute(
            r#"
            create table kernel_check_expr_probe (marker text);
            create table kernel_index_predicate_probe (marker text);
            create table kernel_policy_probe (marker text);
            create table kernel_default_probe (marker text);
            "#,
        )
        .unwrap();
    harness.install_bundle();
    let count: i64 = harness
        .client
        .query_one(
            "select count(*) from information_schema.tables where table_schema = current_schema() and table_name in ('kernel_check_expr_probe', 'kernel_index_predicate_probe', 'kernel_policy_probe', 'kernel_default_probe')",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(count, 4);
}

#[test]
fn materialize_schema_rolls_back_partial_model_tables_on_failure_via_generated_installer() {
    let Some(mut harness) = Harness::empty("rollback", false) else {
        return;
    };
    harness
        .client
        .batch_execute("create table employee_record (id text primary key)")
        .unwrap();
    let error = harness
        .client
        .batch_execute(&harness.bundle)
        .expect_err("malformed preexisting model must reject generated installation");
    assert!(
        error.as_db_error().is_some(),
        "unexpected installation error: {error:?}"
    );
    harness
        .client
        .batch_execute("rollback")
        .expect("roll back failed generated installation");
    let company_exists: bool = harness
        .client
        .query_one("select to_regclass('company_record') is not null", &[])
        .unwrap()
        .get(0);
    assert!(
        !company_exists,
        "failed bundle must roll back partial model DDL"
    );
    let activation_head_exists: bool = harness
        .client
        .query_one(
            "select to_regclass('schema_activation_head') is not null",
            &[],
        )
        .unwrap()
        .get(0);
    let activation_head_policy_count: i64 = harness
        .client
        .query_one(
            "select count(*) from pg_policies where schemaname = current_schema() and tablename = 'schema_activation_head'",
            &[],
        )
        .unwrap()
        .get(0);
    assert!(
        !activation_head_exists,
        "failed bundle must not leave a partial activation-head table"
    );
    assert_eq!(
        activation_head_policy_count, 0,
        "failed bundle must not leave a partial activation-head policy"
    );
}

// Parallel tests share one database; its grants cannot be changed concurrently.
// Each batch is one implicit transaction, so the lock lasts until it ends.
const DATABASE_ACL_LOCK: i64 = 7_340_121;

struct Harness {
    database_url: String,
    client: Client,
    schema_name: String,
    schema_template: Value,
    bundle: String,
    role_name: Option<String>,
    capability_roles: Vec<String>,
}

impl Harness {
    fn new(suffix: &str) -> Option<Self> {
        let mut harness = Self::empty(suffix, false)?;
        harness.install_bundle();
        Some(harness)
    }

    fn new_owned(suffix: &str) -> Option<Self> {
        let mut harness = Self::empty(suffix, true)?;
        harness.install_bundle();
        Some(harness)
    }

    fn empty(suffix: &str, owned_by_role: bool) -> Option<Self> {
        let database_url = test_database_url()?;
        let compiled = compile_manifest_json(&fixture_manifest().to_string())
            .expect("compile final installer parity fixture");
        let schema_template = serde_json::to_value(&compiled.schema)
            .expect("serialize final installer parity schema");
        let manifest =
            compile_sql_artifact_manifest(&compiled).expect("compile generated SQL bundle");
        let bundle = render_sql_artifact_bundle(&manifest);
        let schema_name = format!(
            "kernel_installer_final_{suffix}_{}",
            Uuid::new_v4().simple()
        );
        let mut client = connect_postgres(&database_url).expect("connect to PostgreSQL");
        let role_name = owned_by_role.then(|| format!("{schema_name}_owner"));
        if let Some(role_name) = &role_name {
            client
                .batch_execute(&format!(
                    r#"
                    create role "{role_name}" nologin createrole;
                    grant "{role_name}" to current_user;
                    create schema "{schema_name}" authorization "{role_name}";
                    set search_path to "{schema_name}";
                    set role "{role_name}";
                    "#
                ))
                .expect("create role-owned final installer schema");
        } else {
            client
                .batch_execute(&format!(
                    "create schema \"{schema_name}\"; set search_path to \"{schema_name}\""
                ))
                .expect("create isolated final installer schema");
        }
        Some(Self {
            database_url,
            client,
            schema_name,
            schema_template,
            bundle,
            role_name,
            capability_roles: Vec::new(),
        })
    }

    fn install_bundle(&mut self) {
        self.client
            .batch_execute(&self.bundle)
            .expect("install compiler-emitted SQL bundle");
        self.capability_roles = ["query", "runtime", "schema_admin", "execution_owner"]
            .into_iter()
            .map(|capability| {
                self.client
                    .query_one(
                        "select kernel_installer_capability_role($1)",
                        &[&capability],
                    )
                    .expect("read generated capability role")
                    .get(0)
            })
            .collect();
        if let Some(role_name) = &self.role_name {
            let database_name: String = self
                .client
                .query_one("select current_database()", &[])
                .expect("read test database")
                .get(0);
            self.client
                .batch_execute(&format!(
                    "reset role; select pg_advisory_xact_lock({DATABASE_ACL_LOCK}); grant connect on database \"{database_name}\" to \"{}\", \"{}\"; set role \"{role_name}\"",
                    self.capability_roles[1], self.capability_roles[2]
                ))
                .expect("grant owned fixture capability roles database connect");
        }
    }

    fn schema_for(&self, customer_id: &str, version: &str) -> Value {
        let mut schema = self.schema_template.clone();
        schema["app_id"] = json!("installer_app");
        schema["customer_id"] = json!(customer_id);
        schema["version"] = json!(version);
        schema
    }

    fn activate(&mut self, customer_id: &str, version: &str, effective_hash: String) -> Value {
        let schema = self.schema_for(customer_id, version);
        let revision_id = prepare_ready(&mut self.client, &schema, effective_hash.clone(), None);
        assert_ok(&activate_tenant(
            &mut self.client,
            customer_id,
            revision_id,
            effective_hash,
            None,
        ));
        assert_ok_true(&repair(&mut self.client, &schema));
        schema
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = self.client.batch_execute("reset role");
        let _ = self.client.batch_execute(&format!(
            "set search_path to public; drop schema if exists \"{}\" cascade",
            self.schema_name
        ));
        if let Some(role_name) = &self.role_name {
            let quoted_role_name = role_name.replace('"', "\"\"");
            let _ = self
                .client
                .batch_execute(&format!("drop role if exists \"{quoted_role_name}\""));
        }
        if self.capability_roles.len() == 4 {
            let query_role = &self.capability_roles[0];
            let runtime_role = &self.capability_roles[1];
            let execution_role = &self.capability_roles[3];
            let _ = self
                .client
                .batch_execute(&format!("revoke \"{query_role}\" from \"{runtime_role}\""));
            let _ = self
                .client
                .batch_execute(&format!("revoke \"{execution_role}\" from current_user"));
        }
        for capability_role in &self.capability_roles {
            let database_name: String = self
                .client
                .query_one("select current_database()", &[])
                .map(|row| row.get(0))
                .unwrap_or_default();
            let _ = self.client.batch_execute(&format!(
                "select pg_advisory_xact_lock({DATABASE_ACL_LOCK}); revoke connect on database \"{database_name}\" from \"{capability_role}\""
            ));
            let _ = self
                .client
                .batch_execute(&format!("drop role if exists \"{capability_role}\""));
        }
        let _ = self.client.batch_execute(&format!(
            "drop role if exists \"{}\"",
            self.schema_name.replace('"', "\"\"")
        ));
    }
}

fn fixture_manifest() -> Value {
    json!({
        "app_id": "installer_app",
        "customer_id": "bundle_customer",
        "version": "2026-08-04.bundle",
        "models": [
            {
                "id": "company",
                "kind": "entity",
                "label": "Company",
                "fields": [
                    {"id": "name", "label": "Name", "type": "text", "required": true}
                ]
            },
            {
                "id": "employee",
                "kind": "entity",
                "label": "Employee",
                "fields": [
                    {"id": "name", "label": "Name", "type": "text", "required": true},
                    {"id": "ref", "label": "Reference", "type": "text", "is_unique": true},
                    {"id": "employer", "label": "Employer", "type": "relation", "target_model": "company"}
                ]
            }
        ],
        "change_types": [
            {"id": "company_update", "label": "Company Update", "model": "company", "required": ["name"]},
            {"id": "employee_update", "label": "Employee Update", "model": "employee", "required": ["name"]}
        ],
        "constraints": [],
        "seed_change_sets": []
    })
}

fn prepare_ready(
    client: &mut Client,
    schema: &Value,
    effective_hash: String,
    expected_hash: Option<String>,
) -> i64 {
    install_compiler_catalog_for_schema(client, schema);
    let customer_id = schema["customer_id"].as_str().unwrap();
    let prepared = call(
        client,
        "kernel_prepare_schema_revision",
        json!({
            "app_id": "installer_app",
            "customer_id": customer_id,
            "version": schema["version"],
            "release_id": format!("release-{customer_id}-{}", schema["version"]),
            "activation_kind": "tenant_overlay",
            "schema_hash": hash('8'),
            "base_artifact_hash": hash('1'),
            "effective_artifact_hash": effective_hash,
            "materialization_plan_hash": hash('9'),
            "expected_active_effective_hash": expected_hash,
            "base_schema": schema,
            "customer_overlay": {},
            "schema": schema,
            "phase_plan": [],
        }),
    );
    assert_ok(&prepared);
    let revision_id = prepared["data"]["schema_revision_id"]
        .as_i64()
        .expect("schema revision id");
    assert_ok(&call(
        client,
        "kernel_validate_schema_revision_readiness",
        json!({
            "app_id": "installer_app",
            "customer_id": customer_id,
            "schema_revision_id": revision_id,
            "effective_artifact_hash": effective_hash,
            "materialization_plan_hash": hash('9'),
            "phase_results": [],
        }),
    ));
    revision_id
}

fn install_compiler_catalog_for_schema(client: &mut Client, schema: &Value) {
    let customer_id = schema["customer_id"].as_str().expect("fixture customer id");
    let version = schema["version"].as_str().expect("fixture schema version");
    let mut manifest = fixture_manifest();
    manifest["customer_id"] = json!(customer_id);
    manifest["version"] = json!(version);
    let compiled =
        compile_manifest_json(&manifest.to_string()).expect("compile fixture catalog source");
    let artifact = compile_sql_artifact_manifest(&compiled)
        .expect("compile fixture catalog artifact")
        .artifacts
        .into_iter()
        .find(|artifact| artifact.kind == SqlArtifactKind::ConstraintCatalog)
        .expect("compiler emits fixture constraint catalog");
    client
        .batch_execute(&artifact.sql)
        .expect("install compiler-derived fixture catalog");
}

fn activate_tenant(
    client: &mut Client,
    customer_id: &str,
    revision_id: i64,
    effective_hash: String,
    expected_hash: Option<String>,
) -> Value {
    call(
        client,
        "kernel_activate_tenant_schema_revision",
        json!({
            "app_id": "installer_app",
            "customer_id": customer_id,
            "schema_revision_id": revision_id,
            "effective_artifact_hash": effective_hash,
            "expected_active_effective_hash": expected_hash,
        }),
    )
}

fn repair(client: &mut Client, schema: &Value) -> Value {
    call(
        client,
        "kernel_repair_materialized_schema_revision",
        json!({"schema": schema, "expected_schema_hash": hash('8')}),
    )
}

fn validate(client: &mut Client, schema: &Value) -> Value {
    call(
        client,
        "kernel_validate_materialized_schema_revision",
        json!({"schema": schema, "expected_schema_hash": hash('8')}),
    )
}

fn assert_drift_after(
    suffix: &str,
    drift_sql: &str,
    expected_object: &str,
    expected_details: &str,
) {
    let Some(mut harness) = Harness::new(suffix) else {
        return;
    };
    let schema = harness.activate("tenant_a", "2026-08-04.base", hash('a'));
    harness
        .client
        .batch_execute(drift_sql)
        .expect("introduce materialized catalog drift");
    assert_schema_drift(
        &repair(&mut harness.client, &schema),
        expected_object,
        expected_details,
    );
}

fn assert_policy_names(client: &mut Client, table: &str, expected: &[&str]) {
    let policy_names = client
        .query(
            "select policyname from pg_policies where schemaname = current_schema() and tablename = $1 order by policyname",
            &[&table],
        )
        .unwrap()
        .into_iter()
        .map(|row| row.get::<_, String>(0))
        .collect::<Vec<_>>();
    assert_eq!(policy_names, expected);
}

fn tenant_scope(transaction: &mut Transaction<'_>) -> (String, String) {
    let row = transaction
        .query_one(
            "select current_setting('kernel.app_id'), current_setting('kernel.customer_id')",
            &[],
        )
        .expect("read tenant scope");
    (row.get(0), row.get(1))
}

fn call(client: &mut Client, function: &str, request: Value) -> Value {
    client
        .query_one(&format!("select {function}($1::jsonb)"), &[&request])
        .unwrap_or_else(|error| panic!("call {function}: {error:?}"))
        .get(0)
}

fn connect_to_schema(database_url: &str, schema_name: &str) -> Client {
    let mut client = connect_postgres(database_url).expect("connect generated installer client");
    client
        .batch_execute(&format!("set search_path to \"{schema_name}\""))
        .expect("select generated installer schema");
    client
}

fn wait_for_advisory_lock(observer: &mut Client, backend_pid: i32) {
    for _ in 0..100 {
        let waiting: bool = observer
            .query_one(
                r#"
                select coalesce((
                  select wait_event_type = 'Lock' and wait_event = 'advisory'
                  from pg_stat_activity
                  where pid = $1
                ), false)
                "#,
                &[&backend_pid],
            )
            .expect("inspect generated installer lock waiter")
            .get(0);
        if waiting {
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
    panic!("generated installer backend {backend_pid} did not wait for an advisory lock");
}

fn assert_ok(result: &Value) {
    assert_eq!(result["ok"], true, "unexpected installer error: {result}");
}

fn assert_ok_true(result: &Value) {
    assert_ok(result);
    assert_eq!(
        result["data"], true,
        "unexpected validation result: {result}"
    );
}

fn assert_schema_drift(result: &Value, object: &str, details: &str) {
    assert_eq!(
        result["ok"], false,
        "unexpected validation success: {result}"
    );
    assert_eq!(result["error"]["code"], "schema_drift");
    assert_eq!(result["error"]["details"][0]["path"], "object");
    assert_eq!(result["error"]["details"][0]["code"], "schema_drift");
    assert_eq!(
        result["error"]["details"][0]["message"],
        format!("{object}: {details}")
    );
}

fn hash(character: char) -> String {
    character.to_string().repeat(64)
}

fn test_database_url() -> Option<String> {
    match env::var("KERNEL_TEST_DATABASE_URL") {
        Ok(url) => Some(url),
        Err(env::VarError::NotPresent) => {
            eprintln!(
                "skipping final generated installer parity: KERNEL_TEST_DATABASE_URL is absent"
            );
            None
        }
        Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
    }
}
