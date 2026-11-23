use std::env;
use std::sync::{Arc, Barrier};
use std::thread;

use kernel::connect_postgres;
use postgres::Client;
use schema_compiler::{
    compile_manifest_json, compile_sql_artifact_manifest, render_sql_artifact_bundle,
    SqlArtifactKind,
};
use serde_json::{json, Value};
use uuid::Uuid;

mod support;

#[test]
fn materialize_schema_is_idempotent_and_creates_row_version_tables_via_generated_installer() {
    let Some(mut harness) = Harness::new("idempotent") else {
        return;
    };
    harness.install_bundle();

    let request = prepare_request(
        "tenant_a",
        "2026-08-04.base",
        "tenant_overlay",
        "release-idempotent",
        hash('1'),
        hash('2'),
        None,
    );
    let prepared = prepare(&mut harness.client, request.clone());
    let initial_revision_id = revision_id(&prepared);
    assert_ok(&ready(
        &mut harness.client,
        "tenant_a",
        initial_revision_id,
        hash('2'),
    ));
    assert_ok(&activate_tenant(
        &mut harness.client,
        "tenant_a",
        initial_revision_id,
        hash('2'),
        None,
    ));

    let repeated = prepare(&mut harness.client, request);
    assert_ok(&repeated);
    assert_eq!(revision_id(&repeated), initial_revision_id);
    assert_eq!(repeated["data"]["state"], "active");
    assert_eq!(repeated["data"]["idempotent"], true);
    assert_eq!(
        active_check(
            &mut harness.client,
            "tenant_a",
            "2026-08-04.base",
            hash('8'),
            hash('2'),
        )["data"]["active"],
        true
    );

    let table_count: i64 = harness
        .client
        .query_one(
            r#"
            select count(*)
            from information_schema.tables
            where table_schema = current_schema()
              and table_name in (
                'schema_revision', 'change_set', 'agent_run',
                'company_record', 'company_version',
                'employee_record', 'employee_version'
              )
            "#,
            &[],
        )
        .expect("count generated materialization tables")
        .get(0);
    assert_eq!(table_count, 7);

    let money_columns: Vec<String> = harness
        .client
        .query(
            r#"
            select column_name
            from information_schema.columns
            where table_schema = current_schema()
              and table_name = 'employee_version'
              and column_name like 'comp_rate_%'
            order by column_name
            "#,
            &[],
        )
        .expect("read generated money columns")
        .into_iter()
        .map(|row| row.get(0))
        .collect();
    assert_eq!(
        money_columns,
        ["comp_rate_amount", "comp_rate_currency", "comp_rate_period"]
    );
}

#[test]
fn materialize_schema_creates_substrate_tables_on_fresh_database_via_generated_installer() {
    let Some(mut harness) = Harness::new("fresh") else {
        return;
    };
    let revision_id = prepare_ready_activate_baseline(
        &mut harness.client,
        "fresh_tenant",
        "2026-08-04.fresh",
        hash('a'),
    );
    assert!(revision_id > 0);

    let substrate_count: i64 = harness
        .client
        .query_one(
            r#"
            select count(*)
            from information_schema.tables
            where table_schema = current_schema()
              and table_name in (
                'schema_revision', 'schema_activation_head',
                'schema_installation_revision', 'change_set', 'agent_run'
              )
            "#,
            &[],
        )
        .expect("count generated substrate tables")
        .get(0);
    assert_eq!(substrate_count, 5);
}

#[test]
fn guarded_materialization_advances_activation_head_and_blocks_old_activation_via_generated_installer(
) {
    let Some(mut harness) = Harness::new("guarded") else {
        return;
    };
    prepare_ready_activate_baseline(
        &mut harness.client,
        "tenant_forward",
        "2026-08-01.legacy",
        hash('a'),
    );

    let current = prepare(
        &mut harness.client,
        prepare_request(
            "tenant_forward",
            "2026-08-02.current",
            "tenant_overlay",
            "release-current",
            hash('1'),
            hash('b'),
            Some(hash('a')),
        ),
    );
    let current_id = revision_id(&current);
    assert_ok(&ready(
        &mut harness.client,
        "tenant_forward",
        current_id,
        hash('b'),
    ));
    assert_ok(&activate_tenant(
        &mut harness.client,
        "tenant_forward",
        current_id,
        hash('b'),
        Some(hash('a')),
    ));
    assert_eq!(
        activation_head(&mut harness.client, "tenant_forward"),
        "2026-08-02.current"
    );

    let stale = prepare(
        &mut harness.client,
        prepare_request(
            "tenant_forward",
            "2026-08-03.stale",
            "tenant_overlay",
            "release-stale",
            hash('1'),
            hash('c'),
            Some(hash('a')),
        ),
    );
    let stale_id = revision_id(&stale);
    assert_ok(&ready(
        &mut harness.client,
        "tenant_forward",
        stale_id,
        hash('c'),
    ));
    assert_error(
        &activate_tenant(
            &mut harness.client,
            "tenant_forward",
            stale_id,
            hash('c'),
            Some(hash('a')),
        ),
        "expected_hash_mismatch",
    );
    assert_eq!(
        active_effective_hash(&mut harness.client, "tenant_forward"),
        hash('b')
    );

    let current_materialization_source: Option<String> = harness
        .client
        .query_one(
            "select materialization_source from schema_installation_revision where schema_revision_id = $1",
            &[&current_id],
        )
        .expect("read current materialization metadata")
        .get(0);
    let mut stale_activation = harness.client.transaction().unwrap();
    stale_activation
        .query_one(
            "select set_config('kernel.app_id', 'installer_app', true)",
            &[],
        )
        .unwrap();
    stale_activation
        .query_one(
            "select set_config('kernel.customer_id', 'tenant_forward', true)",
            &[],
        )
        .unwrap();
    stale_activation
        .batch_execute("alter table employee_version add column old_binary_attempt text")
        .unwrap();
    stale_activation
        .execute(
            "update schema_installation_revision set materialization_source = 'stale-attempt' where schema_revision_id = $1",
            &[&current_id],
        )
        .unwrap();
    stale_activation
        .execute(
            "update schema_revision set activated_at = null where app_id = 'installer_app' and customer_id = 'tenant_forward' and activated_at is not null",
            &[],
        )
        .unwrap();
    let downgrade_error = stale_activation
        .execute(
            "update schema_revision set activated_at = now() where app_id = 'installer_app' and customer_id = 'tenant_forward' and version = '2026-08-01.legacy'",
            &[],
        )
        .expect_err("activation head must reject a stale binary revision");
    assert_eq!(
        downgrade_error.code(),
        Some(&postgres::error::SqlState::CHECK_VIOLATION)
    );
    drop(stale_activation);
    let rollback_state: (bool, Option<String>, i64, String, String) = harness
        .client
        .query_one(
            r#"
            select
              exists (
                select 1 from information_schema.columns
                where table_schema = current_schema()
                  and table_name = 'employee_version'
                  and column_name = 'old_binary_attempt'
              ),
              installation.materialization_source,
              revision.id,
              revision.version,
              head.base_schema_version
            from schema_revision revision
            join schema_installation_revision installation
              on installation.schema_revision_id = revision.id
            join schema_activation_head head
              on head.app_id = revision.app_id and head.customer_id = revision.customer_id
            where revision.app_id = 'installer_app'
              and revision.customer_id = 'tenant_forward'
              and revision.activated_at is not null
            "#,
            &[],
        )
        .map(|row| (row.get(0), row.get(1), row.get(2), row.get(3), row.get(4)))
        .expect("read state after rejected stale activation");
    assert_eq!(
        rollback_state,
        (
            false,
            current_materialization_source,
            current_id,
            "2026-08-02.current".to_string(),
            "2026-08-02.current".to_string(),
        )
    );

    let next_schema = revision_schema("tenant_forward", "2026-08-04.next");
    let before_preflight: (i64, String) = harness
        .client
        .query_one(
            r#"
            select count(revision.id), head.base_schema_version
            from schema_activation_head head
            left join schema_revision revision
              on revision.app_id = head.app_id and revision.customer_id = head.customer_id
            where head.app_id = 'installer_app' and head.customer_id = 'tenant_forward'
            group by head.base_schema_version
            "#,
            &[],
        )
        .map(|row| (row.get(0), row.get(1)))
        .unwrap();
    assert_ok(&call(
        &mut harness.client,
        "kernel_preflight_schema_materialization",
        json!({"schema": next_schema}),
    ));
    let after_preflight: (i64, String, i64) = harness
        .client
        .query_one(
            r#"
            select count(revision.id), head.base_schema_version,
                   count(revision.id) filter (where revision.version = '2026-08-04.next')
            from schema_activation_head head
            left join schema_revision revision
              on revision.app_id = head.app_id and revision.customer_id = head.customer_id
            where head.app_id = 'installer_app' and head.customer_id = 'tenant_forward'
            group by head.base_schema_version
            "#,
            &[],
        )
        .map(|row| (row.get(0), row.get(1), row.get(2)))
        .unwrap();
    assert_eq!(after_preflight, (before_preflight.0, before_preflight.1, 0));

    let next = prepare(
        &mut harness.client,
        prepare_request(
            "tenant_forward",
            "2026-08-04.next",
            "tenant_overlay",
            "release-next",
            hash('1'),
            hash('d'),
            Some(hash('b')),
        ),
    );
    let next_id = revision_id(&next);
    assert_ok(&ready(
        &mut harness.client,
        "tenant_forward",
        next_id,
        hash('d'),
    ));
    let before_activation: (i64, String, bool, bool, bool) = harness
        .client
        .query_one(
            r#"
            select active.id, head.base_schema_version,
                   candidate.activated_at is null,
                   candidate.materialized_at is not null,
                   installation.ready_at is not null
            from schema_revision active
            join schema_activation_head head
              on head.app_id = active.app_id and head.customer_id = active.customer_id
            join schema_revision candidate on candidate.id = $1
            join schema_installation_revision installation
              on installation.schema_revision_id = candidate.id
            where active.app_id = 'installer_app'
              and active.customer_id = 'tenant_forward'
              and active.activated_at is not null
            "#,
            &[&next_id],
        )
        .map(|row| (row.get(0), row.get(1), row.get(2), row.get(3), row.get(4)))
        .expect("read readiness visibility before activation");
    assert_eq!(
        before_activation,
        (
            current_id,
            "2026-08-02.current".to_string(),
            true,
            true,
            true,
        )
    );
    assert_ok(&activate_tenant(
        &mut harness.client,
        "tenant_forward",
        next_id,
        hash('d'),
        Some(hash('b')),
    ));
    assert_eq!(
        active_revision_id(&mut harness.client, "tenant_forward"),
        next_id
    );
    assert_eq!(
        active_effective_hash(&mut harness.client, "tenant_forward"),
        hash('d')
    );
    assert_eq!(
        activation_head(&mut harness.client, "tenant_forward"),
        "2026-08-04.next"
    );
}

#[test]
fn activation_head_is_tenant_scoped_and_does_not_fence_unselected_tenants_via_generated_installer()
{
    let Some(mut harness) = Harness::new("tenant_scope") else {
        return;
    };
    prepare_ready_activate_baseline(&mut harness.client, "tenant_a", "2026-08-01.a", hash('a'));
    prepare_ready_activate_baseline(&mut harness.client, "tenant_b", "2026-08-01.b", hash('b'));

    let next = prepare(
        &mut harness.client,
        prepare_request(
            "tenant_a",
            "2026-08-02.a",
            "tenant_overlay",
            "release-a-next",
            hash('1'),
            hash('c'),
            Some(hash('a')),
        ),
    );
    let next_id = revision_id(&next);
    assert_ok(&ready(&mut harness.client, "tenant_a", next_id, hash('c')));
    assert_ok(&activate_tenant(
        &mut harness.client,
        "tenant_a",
        next_id,
        hash('c'),
        Some(hash('a')),
    ));

    assert_eq!(
        activation_head(&mut harness.client, "tenant_a"),
        "2026-08-02.a"
    );
    assert_eq!(
        activation_head(&mut harness.client, "tenant_b"),
        "2026-08-01.b"
    );
    assert_eq!(
        active_effective_hash(&mut harness.client, "tenant_b"),
        hash('b')
    );
}

#[test]
fn materialize_schema_rejects_same_revision_with_different_schema_json_via_generated_installer() {
    let Some(mut harness) = Harness::new("revision_conflict") else {
        return;
    };
    let original = prepare_request(
        "tenant_a",
        "2026-08-04.conflict",
        "tenant_overlay",
        "release-conflict",
        hash('1'),
        hash('2'),
        None,
    );
    let prepared = prepare(&mut harness.client, original.clone());
    let revision_id = revision_id(&prepared);
    assert_ok(&ready(
        &mut harness.client,
        "tenant_a",
        revision_id,
        hash('2'),
    ));
    assert_ok(&activate_tenant(
        &mut harness.client,
        "tenant_a",
        revision_id,
        hash('2'),
        None,
    ));

    let mut changed = original;
    changed["schema_hash"] = json!(hash('7'));
    changed["schema"]["models"][0]["label"] = json!("Changed Company");
    changed["base_schema"] = changed["schema"].clone();
    assert_error(
        &prepare(&mut harness.client, changed),
        "prepared_revision_mismatch",
    );
}

#[test]
fn materialize_schema_rejects_malformed_transition_contract_via_generated_installer() {
    let Some(mut harness) = Harness::new("prepare_contract_and_metadata") else {
        return;
    };
    let original = prepare_request(
        "tenant_a",
        "2026-08-04.contract",
        "tenant_overlay",
        "release-contract",
        hash('1'),
        hash('2'),
        None,
    );
    for malformed in [json!(null), json!([]), json!("not-a-contract")] {
        let mut request = original.clone();
        request["transition_contract"] = malformed;
        assert_error(
            &prepare(&mut harness.client, request),
            "invalid_transition_contract",
        );
    }
}

#[test]
fn schema_revision_validation_returns_false_for_new_base_version_via_generated_installer() {
    let Some(mut harness) = Harness::new("active_check") else {
        return;
    };
    prepare_ready_activate_baseline(
        &mut harness.client,
        "tenant_a",
        "2026-08-04.active",
        hash('a'),
    );

    let current = active_check(
        &mut harness.client,
        "tenant_a",
        "2026-08-04.active",
        hash('8'),
        hash('a'),
    );
    assert_ok(&current);
    assert_eq!(current["data"]["active"], true);

    let next = active_check(
        &mut harness.client,
        "tenant_a",
        "2026-08-05.next",
        hash('7'),
        hash('b'),
    );
    assert_ok(&next);
    assert_eq!(next["data"]["active"], false);
    assert!(next["data"]["schema_revision_id"].is_null());
}

#[test]
fn materialize_schema_records_revision_hash_and_provenance_via_generated_installer() {
    let Some(mut harness) = Harness::new("provenance") else {
        return;
    };
    let mut request = prepare_request(
        "tenant_a",
        "2026-08-04.provenance",
        "tenant_overlay",
        "release-provenance",
        hash('1'),
        hash('2'),
        None,
    );
    add_provenance(&mut request);
    let prepared = prepare(&mut harness.client, request);
    let revision_id = revision_id(&prepared);
    assert_ok(&ready(
        &mut harness.client,
        "tenant_a",
        revision_id,
        hash('2'),
    ));
    assert_ok(&activate_tenant(
        &mut harness.client,
        "tenant_a",
        revision_id,
        hash('2'),
        None,
    ));

    let row = harness
        .client
        .query_one(
            r#"
            select revision.schema_hash,
                   installation.materialization_source,
                   installation.materialization_git_sha,
                   installation.materialization_vercel_deployment_id,
                   installation.materialization_vercel_environment,
                   installation.materialization_vercel_git_ref,
                   revision.materialized_at is not null
            from schema_revision revision
            join schema_installation_revision installation
              on installation.schema_revision_id = revision.id
            where revision.id = $1
            "#,
            &[&revision_id],
        )
        .expect("read generated revision provenance");
    assert_eq!(row.get::<_, String>(0), hash('8'));
    assert_eq!(row.get::<_, String>(1), "parity-test");
    assert_eq!(row.get::<_, String>(2), "abc123");
    assert_eq!(row.get::<_, String>(3), "dpl_test");
    assert_eq!(row.get::<_, String>(4), "preview");
    assert_eq!(row.get::<_, String>(5), "feature/sql-installer");
    assert!(row.get::<_, bool>(6));
}

#[test]
fn materialize_schema_without_provenance_preserves_existing_revision_provenance_via_generated_installer(
) {
    let Some(mut harness) = Harness::new("provenance_preserve") else {
        return;
    };
    let mut request = prepare_request(
        "tenant_a",
        "2026-08-04.provenance",
        "tenant_overlay",
        "release-provenance",
        hash('1'),
        hash('2'),
        None,
    );
    let without_provenance = request.clone();
    add_provenance(&mut request);
    let prepared = prepare(&mut harness.client, request);
    let revision_id = revision_id(&prepared);
    assert_ok(&ready(
        &mut harness.client,
        "tenant_a",
        revision_id,
        hash('2'),
    ));
    assert_ok(&activate_tenant(
        &mut harness.client,
        "tenant_a",
        revision_id,
        hash('2'),
        None,
    ));

    let repeated = prepare(&mut harness.client, without_provenance);
    assert_ok(&repeated);
    assert_eq!(repeated["data"]["idempotent"], true);
    let provenance: (String, String) = harness
        .client
        .query_one(
            "select materialization_source, materialization_git_sha from schema_installation_revision where schema_revision_id = $1",
            &[&revision_id],
        )
        .map(|row| (row.get(0), row.get(1)))
        .expect("read preserved provenance");
    assert_eq!(
        provenance,
        ("parity-test".to_string(), "abc123".to_string())
    );
}

#[test]
fn materialize_schema_after_runtime_overlay_preserves_runtime_revision_hash_via_generated_installer(
) {
    let Some(mut harness) = Harness::new("overlay_preserve") else {
        return;
    };
    prepare_ready_activate_baseline(
        &mut harness.client,
        "tenant_a",
        "2026-08-01.base",
        hash('a'),
    );
    let overlay = prepare(
        &mut harness.client,
        prepare_request(
            "tenant_a",
            "2026-08-01.base+enum.1",
            "tenant_overlay",
            "runtime-enum-revision",
            hash('1'),
            hash('b'),
            Some(hash('a')),
        ),
    );
    let overlay_id = revision_id(&overlay);
    assert_ok(&ready(
        &mut harness.client,
        "tenant_a",
        overlay_id,
        hash('b'),
    ));
    assert_ok(&activate_tenant(
        &mut harness.client,
        "tenant_a",
        overlay_id,
        hash('b'),
        Some(hash('a')),
    ));

    let base_candidate = prepare(
        &mut harness.client,
        prepare_request(
            "tenant_a",
            "2026-08-02.base",
            "app_base",
            "next-base-release",
            hash('c'),
            hash('d'),
            Some(hash('b')),
        ),
    );
    let base_candidate_id = revision_id(&base_candidate);
    assert_ok(&ready(
        &mut harness.client,
        "tenant_a",
        base_candidate_id,
        hash('d'),
    ));

    assert_eq!(
        active_revision_id(&mut harness.client, "tenant_a"),
        overlay_id
    );
    assert_eq!(
        active_effective_hash(&mut harness.client, "tenant_a"),
        hash('b')
    );
}

#[test]
fn materialize_same_base_version_preserves_active_runtime_overlay_via_generated_installer() {
    let Some(mut harness) = Harness::new("same_base_overlay") else {
        return;
    };
    let customer_id = "tenant_same_base";
    let base_version = "2026-08-01.base";
    let base_schema = revision_schema(customer_id, base_version);
    prepare_ready_activate_baseline(&mut harness.client, customer_id, base_version, hash('a'));

    let runtime_version = "2026-08-01.base+r1";
    let runtime_overlay = json!({
        "declared_enum_option_additions": [{
            "model_id": "employee",
            "field_id": "status",
            "option_set": [{"id": "contractor", "label": "Contractor", "aliases": []}]
        }]
    });
    let mut runtime_schema = base_schema.clone();
    runtime_schema["version"] = json!(runtime_version);
    runtime_schema["models"][1]["fields"][1]["option_set"]
        .as_array_mut()
        .expect("declared enum options")
        .push(json!({"id": "contractor", "label": "Contractor", "aliases": []}));
    let mut runtime_request = prepare_request(
        customer_id,
        runtime_version,
        "tenant_overlay",
        "runtime-overlay",
        hash('0'),
        hash('b'),
        Some(hash('a')),
    );
    runtime_request["base_schema"] = base_schema.clone();
    runtime_request["customer_overlay"] = runtime_overlay.clone();
    runtime_request["schema"] = runtime_schema.clone();
    runtime_request["schema_hash"] = json!(hash('7'));
    let runtime = prepare(&mut harness.client, runtime_request);
    let runtime_id = revision_id(&runtime);
    assert_ok(&ready(
        &mut harness.client,
        customer_id,
        runtime_id,
        hash('b'),
    ));
    assert_ok(&activate_tenant(
        &mut harness.client,
        customer_id,
        runtime_id,
        hash('b'),
        Some(hash('a')),
    ));

    let before: (i64, String, String, Value, Value, String, i64) = harness
        .client
        .query_one(
            r#"
            select revision.id, revision.version, revision.schema_hash,
                   revision.schema, revision.customer_overlay,
                   installation.effective_artifact_hash,
                   (select count(*) from schema_revision all_revisions
                    where all_revisions.app_id = revision.app_id
                      and all_revisions.customer_id = revision.customer_id)
            from schema_revision revision
            join schema_installation_revision installation
              on installation.schema_revision_id = revision.id
            where revision.app_id = 'installer_app'
              and revision.customer_id = $1
              and revision.activated_at is not null
            "#,
            &[&customer_id],
        )
        .map(|row| {
            (
                row.get(0),
                row.get(1),
                row.get(2),
                row.get(3),
                row.get(4),
                row.get(5),
                row.get(6),
            )
        })
        .expect("read active runtime overlay before same-base materialization");
    assert_eq!(before.0, runtime_id);
    assert_eq!(before.1, runtime_version);
    assert_eq!(before.2, hash('7'));
    assert_eq!(before.3, runtime_schema);
    assert_eq!(before.4, runtime_overlay);
    assert_eq!(before.5, hash('b'));
    assert_eq!(before.6, 2);

    harness.install_manifest(fixture_manifest_for(customer_id, base_version));
    let stale_expected = prepare(
        &mut harness.client,
        prepare_request(
            customer_id,
            base_version,
            "app_base",
            "same-base-rematerialization",
            hash('0'),
            hash('a'),
            Some(hash('f')),
        ),
    );
    assert_error(&stale_expected, "expected_hash_mismatch");
    let rematerialized = prepare(
        &mut harness.client,
        prepare_request(
            customer_id,
            base_version,
            "app_base",
            "same-base-rematerialization",
            hash('0'),
            hash('a'),
            Some(hash('b')),
        ),
    );
    assert_ok(&rematerialized);
    assert_eq!(rematerialized["data"]["schema_revision_id"], runtime_id);
    assert_eq!(rematerialized["data"]["effective_artifact_hash"], hash('b'));
    assert_eq!(rematerialized["data"]["state"], "active");
    assert_eq!(rematerialized["data"]["idempotent"], true);

    let after: (i64, String, String, Value, Value, String, i64) = harness
        .client
        .query_one(
            r#"
            select active.id, active.version, active.schema_hash,
                   active.schema, active.customer_overlay,
                   installation.effective_artifact_hash,
                   (select count(*) from schema_revision all_revisions
                    where all_revisions.app_id = active.app_id
                      and all_revisions.customer_id = active.customer_id)
            from schema_revision active
            join schema_installation_revision installation
              on installation.schema_revision_id = active.id
            where active.app_id = 'installer_app'
              and active.customer_id = $1
              and active.activated_at is not null
            "#,
            &[&customer_id],
        )
        .map(|row| {
            (
                row.get(0),
                row.get(1),
                row.get(2),
                row.get(3),
                row.get(4),
                row.get(5),
                row.get(6),
            )
        })
        .expect("read active runtime overlay after same-base materialization");
    assert_eq!(after.0, before.0);
    assert_eq!(after.1, before.1);
    assert_eq!(after.2, before.2);
    assert_eq!(after.3, before.3);
    assert_eq!(after.4, before.4);
    assert_eq!(after.5, before.5);
    assert_eq!(
        after.6, before.6,
        "same-base materialization must not create a candidate"
    );
}

#[test]
fn concurrent_materialize_schema_serializes_same_tenant_activation_via_generated_installer() {
    let Some(mut harness) = Harness::new("concurrent_tenant") else {
        return;
    };
    prepare_ready_activate_baseline(
        &mut harness.client,
        "tenant_a",
        "2026-08-01.base",
        hash('a'),
    );

    let mut candidates = Vec::new();
    for (version, release, effective_hash) in [
        ("2026-08-02.first", "release-first", hash('b')),
        ("2026-08-02.second", "release-second", hash('c')),
    ] {
        let prepared = prepare(
            &mut harness.client,
            prepare_request(
                "tenant_a",
                version,
                "tenant_overlay",
                release,
                hash('1'),
                effective_hash.clone(),
                Some(hash('a')),
            ),
        );
        let revision_id = revision_id(&prepared);
        assert_ok(&ready(
            &mut harness.client,
            "tenant_a",
            revision_id,
            effective_hash.clone(),
        ));
        candidates.push((revision_id, effective_hash));
    }

    let barrier = Arc::new(Barrier::new(3));
    let handles = candidates
        .into_iter()
        .map(|(revision_id, effective_hash)| {
            let barrier = Arc::clone(&barrier);
            let database_url = harness.database_url.clone();
            let schema = harness.schema.clone();
            thread::spawn(move || {
                let mut client = scoped_client(&database_url, &schema);
                barrier.wait();
                activate_tenant(
                    &mut client,
                    "tenant_a",
                    revision_id,
                    effective_hash,
                    Some(hash('a')),
                )
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    let results = handles
        .into_iter()
        .map(|handle| handle.join().expect("activation thread"))
        .collect::<Vec<_>>();
    assert_eq!(
        results.iter().filter(|result| result["ok"] == true).count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|result| result["error"]["details"][0]["code"] == "expected_hash_mismatch")
            .count(),
        1
    );
}

struct Harness {
    database_url: String,
    schema: String,
    bundle: String,
    client: Client,
}

impl Harness {
    fn new(suffix: &str) -> Option<Self> {
        let database_url = test_database_url()?;
        let compiled = compile_manifest_json(&fixture_manifest().to_string())
            .expect("compile installer parity fixture");
        let manifest =
            compile_sql_artifact_manifest(&compiled).expect("compile generated SQL bundle");
        let bundle = render_sql_artifact_bundle(&manifest);
        let schema = format!(
            "kernel_installer_parity_{suffix}_{}",
            Uuid::new_v4().simple()
        );
        let mut client = connect_postgres(&database_url).expect("connect to PostgreSQL");
        client
            .batch_execute(&format!(
                "create schema \"{schema}\"; set search_path to \"{schema}\""
            ))
            .expect("create isolated schema");
        support::trusted_human::before_install(&mut client);
        client
            .batch_execute(&bundle)
            .expect("install compiler-emitted SQL bundle");
        Some(Self {
            database_url,
            schema,
            bundle,
            client,
        })
    }

    fn install_bundle(&mut self) {
        self.client
            .batch_execute(&self.bundle)
            .expect("idempotently reinstall compiler-emitted SQL bundle");
    }

    fn install_manifest(&mut self, manifest: Value) {
        let compiled = compile_manifest_json(&manifest.to_string())
            .expect("compile same-base installer parity fixture");
        let sql_manifest =
            compile_sql_artifact_manifest(&compiled).expect("compile same-base SQL bundle");
        self.client
            .batch_execute(&render_sql_artifact_bundle(&sql_manifest))
            .expect("install same-base compiler-emitted SQL bundle");
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        support::drop_generated_sql_fixture(&mut self.client, &self.schema);
    }
}

fn fixture_manifest() -> Value {
    fixture_manifest_for("bundle_customer", "2026-08-04.bundle")
}

fn fixture_manifest_for(customer_id: &str, version: &str) -> Value {
    json!({
        "app_id": "installer_app",
        "customer_id": customer_id,
        "version": version,
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
                    {"id": "status", "label": "Status", "type": "enum", "option_set": [
                        {"id": "active", "label": "Active", "aliases": ["current"]},
                        {"id": "inactive", "label": "Inactive", "aliases": []}
                    ]},
                    {"id": "company", "label": "Company", "type": "relation", "target_model": "company"},
                    {"id": "comp_rate", "label": "Compensation", "type": "money_rate"}
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

fn prepare_request(
    customer_id: &str,
    version: &str,
    activation_kind: &str,
    release_id: &str,
    base_artifact_hash: String,
    effective_artifact_hash: String,
    expected_active_effective_hash: Option<String>,
) -> Value {
    json!({
        "app_id": "installer_app",
        "customer_id": customer_id,
        "version": version,
        "release_id": release_id,
        "activation_kind": activation_kind,
        "schema_hash": hash('8'),
        "base_artifact_hash": base_artifact_hash,
        "effective_artifact_hash": effective_artifact_hash,
        "materialization_plan_hash": hash('9'),
        "expected_active_effective_hash": expected_active_effective_hash,
        "base_schema": revision_schema(customer_id, version),
        "customer_overlay": {},
        "schema": revision_schema(customer_id, version),
        "phase_plan": [],
    })
}

fn revision_schema(customer_id: &str, version: &str) -> Value {
    let compiled = compile_manifest_json(&fixture_manifest_for(customer_id, version).to_string())
        .expect("compile revision schema fixture");
    serde_json::to_value(compiled.schema).expect("serialize revision schema fixture")
}

fn add_provenance(request: &mut Value) {
    request["materialization_source"] = json!("parity-test");
    request["materialization_git_sha"] = json!("abc123");
    request["materialization_vercel_deployment_id"] = json!("dpl_test");
    request["materialization_vercel_environment"] = json!("preview");
    request["materialization_vercel_git_ref"] = json!("feature/sql-installer");
}

fn prepare_ready_activate_baseline(
    client: &mut Client,
    customer_id: &str,
    version: &str,
    effective_artifact_hash: String,
) -> i64 {
    let prepared = prepare(
        client,
        prepare_request(
            customer_id,
            version,
            "tenant_overlay",
            &format!("baseline-{customer_id}"),
            hash('0'),
            effective_artifact_hash.clone(),
            None,
        ),
    );
    let revision_id = revision_id(&prepared);
    assert_ok(&ready(
        client,
        customer_id,
        revision_id,
        effective_artifact_hash.clone(),
    ));
    assert_ok(&activate_tenant(
        client,
        customer_id,
        revision_id,
        effective_artifact_hash,
        None,
    ));
    revision_id
}

fn prepare(client: &mut Client, request: Value) -> Value {
    install_compiler_catalog_for_request(client, &request);
    call(client, "kernel_prepare_schema_revision", request)
}

fn install_compiler_catalog_for_request(client: &mut Client, request: &Value) {
    let customer_id = request["customer_id"]
        .as_str()
        .expect("fixture customer id");
    let base_version = request["base_schema"]["version"]
        .as_str()
        .expect("fixture base schema version");
    let compiled =
        compile_manifest_json(&fixture_manifest_for(customer_id, base_version).to_string())
            .expect("compile fixture catalog source");
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

fn ready(
    client: &mut Client,
    customer_id: &str,
    schema_revision_id: i64,
    effective_artifact_hash: String,
) -> Value {
    call(
        client,
        "kernel_validate_schema_revision_readiness",
        json!({
            "app_id": "installer_app",
            "customer_id": customer_id,
            "schema_revision_id": schema_revision_id,
            "effective_artifact_hash": effective_artifact_hash,
            "materialization_plan_hash": hash('9'),
            "phase_results": [],
        }),
    )
}

fn activate_tenant(
    client: &mut Client,
    customer_id: &str,
    schema_revision_id: i64,
    effective_artifact_hash: String,
    expected_active_effective_hash: Option<String>,
) -> Value {
    call(
        client,
        "kernel_activate_tenant_schema_revision",
        json!({
            "app_id": "installer_app",
            "customer_id": customer_id,
            "schema_revision_id": schema_revision_id,
            "effective_artifact_hash": effective_artifact_hash,
            "expected_active_effective_hash": expected_active_effective_hash,
        }),
    )
}

fn active_check(
    client: &mut Client,
    customer_id: &str,
    version: &str,
    schema_hash: String,
    effective_artifact_hash: String,
) -> Value {
    call(
        client,
        "kernel_schema_revision_is_active",
        json!({
            "app_id": "installer_app",
            "customer_id": customer_id,
            "version": version,
            "schema_hash": schema_hash,
            "effective_artifact_hash": effective_artifact_hash,
        }),
    )
}

fn call(client: &mut Client, function: &str, request: Value) -> Value {
    client
        .query_one(&format!("select {function}($1::jsonb)"), &[&request])
        .unwrap_or_else(|error| panic!("call {function}: {error:?}"))
        .get(0)
}

fn revision_id(result: &Value) -> i64 {
    assert_ok(result);
    result["data"]["schema_revision_id"]
        .as_i64()
        .expect("schema revision id")
}

fn assert_ok(result: &Value) {
    assert_eq!(result["ok"], true, "unexpected installer error: {result}");
}

fn assert_error(result: &Value, detail_code: &str) {
    assert_eq!(
        result["ok"], false,
        "unexpected installer success: {result}"
    );
    assert_eq!(result["error"]["details"][0]["code"], detail_code);
}

fn activation_head(client: &mut Client, customer_id: &str) -> String {
    client
        .query_one(
            "select base_schema_version from schema_activation_head where app_id = 'installer_app' and customer_id = $1",
            &[&customer_id],
        )
        .expect("read activation head")
        .get(0)
}

fn active_revision_id(client: &mut Client, customer_id: &str) -> i64 {
    client
        .query_one(
            "select id from schema_revision where app_id = 'installer_app' and customer_id = $1 and activated_at is not null",
            &[&customer_id],
        )
        .expect("read active revision id")
        .get(0)
}

fn active_effective_hash(client: &mut Client, customer_id: &str) -> String {
    client
        .query_one(
            r#"
            select installation.effective_artifact_hash
            from schema_revision revision
            join schema_installation_revision installation
              on installation.schema_revision_id = revision.id
            where revision.app_id = 'installer_app'
              and revision.customer_id = $1
              and revision.activated_at is not null
            "#,
            &[&customer_id],
        )
        .expect("read active effective artifact hash")
        .get(0)
}

fn scoped_client(database_url: &str, schema: &str) -> Client {
    let mut client = connect_postgres(database_url).expect("connect to PostgreSQL");
    client
        .batch_execute(&format!("set search_path to \"{schema}\""))
        .expect("set generated installer schema");
    client
}

fn hash(character: char) -> String {
    character.to_string().repeat(64)
}

fn test_database_url() -> Option<String> {
    match env::var("KERNEL_TEST_DATABASE_URL") {
        Ok(url) => Some(url),
        Err(env::VarError::NotPresent) => {
            eprintln!("skipping generated installer parity: KERNEL_TEST_DATABASE_URL is absent");
            None
        }
        Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
    }
}
