use std::env;
use std::sync::{Arc, Barrier};
use std::thread;

use kernel::connect_postgres;
use serde_json::{json, Value};
use uuid::Uuid;

struct RuntimeSqlFunction {
    signature: &'static str,
    sql: String,
}
#[path = "../src/sql_runtime/admin.rs"]
mod admin;
#[path = "../src/sql_runtime/authorization.rs"]
mod authorization;
#[path = "../src/sql_runtime/derived.rs"]
mod derived;

#[path = "../src/sql_runtime/installer.rs"]
mod installer;
#[path = "../src/sql_runtime/lookup_migration.rs"]
mod lookup_migration;
#[path = "../src/sql_runtime/shared.rs"]
mod shared;

const SCHEMA_REVISION_SUBSTRATE: &str = r#"
create table schema_revision (
  id bigserial primary key,
  app_id text not null,
  customer_id text not null,
  version text not null,
  base_schema jsonb not null,
  customer_overlay jsonb not null default '{}',
  schema jsonb not null,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  schema_hash text,
  materialization_source text,
  materialized_at timestamptz,
  constraint schema_revision_scope_version_key unique (app_id, customer_id, version)
);
create unique index schema_revision_active_idx
  on schema_revision (app_id, customer_id) where activated_at is not null;
create table schema_activation_head (
  app_id text not null,
  customer_id text not null,
  base_schema_version text not null,
  advanced_at timestamptz not null default now(),
  primary key (app_id, customer_id)
);
create table lookup_record (
  app_id text not null,
  customer_id text not null,
  model_id text not null,
  id uuid not null,
  external_key text,
  created_at timestamptz not null default now(),
  constraint lookup_record_pkey primary key (app_id, customer_id, model_id, id)
);
create table lookup_version (
  id uuid not null,
  app_id text not null,
  customer_id text not null,
  model_id text not null,
  record_id uuid not null,
  stage text not null,
  effective_start date not null,
  effective_end date,
  change_set_id bigint not null,
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  tombstones_record boolean not null default false,
  untombstones_record boolean not null default false,
  availability text not null default 'active',
  provenance jsonb,
  custom_fields jsonb not null default '[]',
  metadata jsonb not null default '{}',
  many_relations jsonb not null default '{}',
  values jsonb not null default '{}',
  constraint lookup_version_pkey primary key (app_id, customer_id, model_id, id)
);
"#;

#[test]
fn installer_artifacts_are_non_destructive_and_have_stable_public_envelopes() {
    let substrate = installer::substrate_sql().to_ascii_lowercase();
    // The service-kind upgrade replaces one check constraint in place; it
    // preserves memberships and fences. No other DROP is an installer operation.
    let replaced_check = "alter table kernel_actor_membership drop constraint if exists kernel_actor_membership_actor_kind_check;";
    assert_eq!(substrate.matches(replaced_check).count(), 1);
    assert!(!substrate.replace(replaced_check, "").contains("drop "));
    assert_eq!(
        installer::privilege_installation_sql(),
        "select kernel_install_runtime_privileges()"
    );
    let functions = installer::functions();
    for signature in [
        "kernel_prepare_schema_revision(jsonb)",
        "kernel_validate_schema_revision_readiness(jsonb)",
        "kernel_activate_tenant_schema_revision(jsonb)",
        "kernel_activate_app_base_schema_revision(jsonb)",
        "kernel_continue_app_base_schema_revision(jsonb)",
        "kernel_read_runtime_release_observability(jsonb)",
    ] {
        let function = functions
            .iter()
            .find(|function| function.signature == signature)
            .unwrap_or_else(|| panic!("missing installer function {signature}"));
        let sql = function.sql.to_ascii_lowercase();
        assert!(sql.contains("returns jsonb"));
        assert!(sql.contains("jsonb_build_object('ok'"));
        assert!(!sql.contains("execute "));
        assert!(!sql.contains("drop "));
        assert!(!sql.contains("create extension"));
    }
    let continuation = functions
        .iter()
        .find(|function| function.signature == "kernel_continue_app_base_schema_revision(jsonb)")
        .expect("app-base continuation is emitted from the shared canonical SQL asset");
    assert_eq!(
        continuation.sql,
        include_str!("../src/sql_runtime/app_base_continuation.sql").trim()
    );
    functions
        .iter()
        .find(|function| function.signature == "kernel_activate_app_base_schema_revision(jsonb)")
        .expect("app-base activation is emitted from the shared canonical SQL asset");
}

#[test]
fn runtime_release_observability_is_read_only_and_covers_the_release_ledger() {
    let function = installer::functions()
        .into_iter()
        .find(|function| function.signature == "kernel_read_runtime_release_observability(jsonb)")
        .expect("release observability runtime entrypoint");
    let sql = function.sql.to_ascii_lowercase();
    // Capability wrappers rename the implementation function. Local-variable
    // qualification must use a stable block label, not its original name.
    assert!(function.sql.contains("<<release_observability>>"));
    assert_eq!(
        function.sql.matches("release_observability.app_id").count(),
        2
    );
    assert_eq!(
        function
            .sql
            .matches("release_observability.customer_id")
            .count(),
        2
    );
    assert!(!function
        .sql
        .contains("kernel_read_runtime_release_observability.app_id"));
    assert!(!function
        .sql
        .contains("kernel_read_runtime_release_observability.customer_id"));
    for signal in [
        "artifact_hashes",
        "preparation",
        "resumable_backfill",
        "lock_waits",
        "activation_cas",
        "drift_reconciliation",
        "runtime_schema",
        "forward_recovery",
    ] {
        assert!(
            sql.contains(signal),
            "missing observability signal {signal}"
        );
    }
    assert!(sql.contains("kernel_authorize_scope('runtime'"));
    assert!(sql.contains("if authorization_result is not null then"));
    assert!(sql.contains("request - array['app_id', 'customer_id'] <> '{}'::jsonb"));
    assert!(sql.contains("from pg_locks"));
    assert!(sql.contains("'not_measured_by_snapshot'"));
    assert!(sql.contains("'would_conflict'"));
    for forbidden in [
        "insert into",
        "update ",
        "delete from",
        "perform kernel_installer_lock",
        "kernel_prepare_schema_revision",
        "kernel_activate_",
        "kernel_repair_",
    ] {
        assert!(
            !sql.contains(forbidden),
            "release observability must remain read-only: found {forbidden}"
        );
    }
}

#[test]
fn runtime_release_observability_survives_capability_implementation_rename() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let schema = create_installer_schema(&database_url, "observability_rename");
    let mut client = scoped_client(&database_url, &schema);
    // This regression isolates PL/pgSQL local binding. Authorization behavior
    // remains covered by the dedicated runtime authorization suite.
    client.batch_execute("create or replace function kernel_authorize_scope(requested_capability text, requested_app_id text, requested_customer_id text, requested_actor_id text default null) returns jsonb language sql as 'select null::jsonb'; alter function kernel_read_runtime_release_observability(jsonb) rename to kernel_observability_implementation;").unwrap();
    let result: Value = client
        .query_one(
            "select kernel_observability_implementation($1::jsonb)",
            &[&json!({"app_id":"spend-review", "customer_id":"fixture_tenant"})],
        )
        .unwrap()
        .get(0);
    assert_eq!(result["ok"], true);
    assert_eq!(result["data"]["app_id"], "spend-review");
    assert_eq!(result["data"]["customer_id"], "fixture_tenant");
    assert_eq!(result["data"]["releases"], json!([]));
    drop_schema(&mut client, &schema);
}

#[test]
fn tenant_activation_uses_expected_hash_cas_under_concurrency() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let schema = create_installer_schema(&database_url, "cas");
    let mut setup = scoped_client(&database_url, &schema);
    let old = prepare_ready_activate_baseline(&mut setup, "tenant_a", "old", hash('a'));
    assert!(old["ok"].as_bool().unwrap());

    let first = prepare(
        &mut setup,
        prepare_request(
            "tenant_a",
            "candidate_one",
            "tenant_overlay",
            "release-one",
            hash('b'),
            hash('c'),
            Some(hash('a')),
            json!([]),
        ),
    );
    let second = prepare(
        &mut setup,
        prepare_request(
            "tenant_a",
            "candidate_two",
            "tenant_overlay",
            "release-two",
            hash('d'),
            hash('e'),
            Some(hash('a')),
            json!([]),
        ),
    );
    let first_id = revision_id(&first);
    let second_id = revision_id(&second);
    assert_ok(&ready(
        &mut setup,
        "tenant_a",
        first_id,
        hash('c'),
        json!([]),
    ));
    assert_ok(&ready(
        &mut setup,
        "tenant_a",
        second_id,
        hash('e'),
        json!([]),
    ));

    let barrier = Arc::new(Barrier::new(3));
    let mut handles = Vec::new();
    for (revision_id, effective_hash) in [(first_id, hash('c')), (second_id, hash('e'))] {
        let database_url = database_url.clone();
        let schema = schema.clone();
        let barrier = Arc::clone(&barrier);
        handles.push(thread::spawn(move || {
            let mut client = scoped_client(&database_url, &schema);
            barrier.wait();
            activate_tenant(
                &mut client,
                "tenant_a",
                revision_id,
                effective_hash,
                Some(hash('a')),
            )
        }));
    }
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

    let active: (i64, String) = setup
        .query_one(
            r#"
            select sr.id, sir.effective_artifact_hash
            from schema_revision sr
            join schema_installation_revision sir on sir.schema_revision_id = sr.id
            where sr.app_id = 'installer_app' and sr.customer_id = 'tenant_a'
              and sr.activated_at is not null
            "#,
            &[],
        )
        .map(|row| (row.get(0), row.get(1)))
        .expect("read active CAS winner");
    assert!([(first_id, hash('c')), (second_id, hash('e'))].contains(&active));

    drop_schema(&mut setup, &schema);
}

#[test]
fn app_base_activation_requires_all_ready_targets_and_rolls_back_as_one_unit() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let schema = create_installer_schema(&database_url, "app_base");
    let mut client = scoped_client(&database_url, &schema);
    assert_ok(&prepare_ready_activate_baseline(
        &mut client,
        "tenant_a",
        "old_a",
        hash('a'),
    ));
    assert_ok(&prepare_ready_activate_baseline(
        &mut client,
        "tenant_b",
        "old_b",
        hash('b'),
    ));

    let phase_plan = json!([{"id":"validate_catalog","kind":"validation","hash":hash('f')}]);
    let first = prepare(
        &mut client,
        prepare_request(
            "tenant_a",
            "new_a",
            "app_base",
            "release-base",
            hash('c'),
            hash('d'),
            Some(hash('a')),
            phase_plan.clone(),
        ),
    );
    let second = prepare(
        &mut client,
        prepare_request(
            "tenant_b",
            "new_b",
            "app_base",
            "release-base",
            hash('c'),
            hash('e'),
            Some(hash('b')),
            phase_plan,
        ),
    );
    let first_id = revision_id(&first);
    let second_id = revision_id(&second);

    let invalid_readiness = ready(
        &mut client,
        "tenant_a",
        first_id,
        hash('d'),
        json!([{"id":"validate_catalog","hash":hash('1'),"status":"complete"}]),
    );
    assert_error(&invalid_readiness, "phase_validation_failed");
    assert_eq!(active_version(&mut client, "tenant_a"), "old_a");

    let activation = app_base_activation(first_id, second_id);
    let unready = activate_app_base(&mut client, &activation);
    assert_error(&unready, "readiness_required");
    assert_eq!(active_version(&mut client, "tenant_a"), "old_a");
    assert_eq!(active_version(&mut client, "tenant_b"), "old_b");

    let phase_results = json!([{"id":"validate_catalog","hash":hash('f'),"status":"complete"}]);
    assert_ok(&ready(
        &mut client,
        "tenant_a",
        first_id,
        hash('d'),
        phase_results.clone(),
    ));
    assert_ok(&ready(
        &mut client,
        "tenant_b",
        second_id,
        hash('e'),
        phase_results,
    ));

    client
        .batch_execute(
            r#"
            create function reject_second_activation() returns trigger language plpgsql as $$
            begin
              if new.customer_id = 'tenant_b' and new.version = 'new_b'
                and new.activated_at is not null
              then
                raise exception 'forced second target failure';
              end if;
              return new;
            end $$;
            create trigger reject_second_activation
              before update of activated_at on schema_revision
              for each row execute function reject_second_activation();
            "#,
        )
        .expect("install rollback trigger");
    let rolled_back = activate_app_base(&mut client, &activation);
    assert_error(&rolled_back, "activation_failed");
    assert_eq!(active_version(&mut client, "tenant_a"), "old_a");
    assert_eq!(active_version(&mut client, "tenant_b"), "old_b");
    client
        .batch_execute("drop trigger reject_second_activation on schema_revision")
        .expect("remove rollback trigger");

    let activated = activate_app_base(&mut client, &activation);
    assert_ok(&activated);
    assert_eq!(activated["data"]["activation_kind"], "app_base");
    assert_eq!(active_version(&mut client, "tenant_a"), "new_a");
    assert_eq!(active_version(&mut client, "tenant_b"), "new_b");

    client
        .execute(
            "update schema_activation_head set base_schema_version = 'drifted' where app_id = 'installer_app' and customer_id = 'tenant_a'",
            &[],
        )
        .expect("corrupt compiler-owned activation head");
    let replay = prepare(
        &mut client,
        prepare_request(
            "tenant_a",
            "new_a",
            "app_base",
            "release-base",
            hash('c'),
            hash('d'),
            Some(hash('a')),
            json!([{"id":"validate_catalog","kind":"validation","hash":hash('f')}]),
        ),
    );
    assert_ok(&replay);
    assert_eq!(replay["data"]["idempotent"], true);
    let repaired_head: String = client
        .query_one(
            "select base_schema_version from schema_activation_head where app_id = 'installer_app' and customer_id = 'tenant_a'",
            &[],
        )
        .expect("read reconciled activation head")
        .get(0);
    assert_eq!(repaired_head, "new_a");

    drop_schema(&mut client, &schema);
}

#[test]
fn app_base_activation_and_continuation_scope_rls_reads_for_approved_tenants() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let schema = create_installer_schema(&database_url, "app_base_rls");
    let mut client = scoped_client(&database_url, &schema);
    let release_id = "release-base";
    let base_hash = hash('c');
    let phase_plan = json!([]);
    let mut prepared = Vec::new();
    for (customer_id, effective_hash) in [("tenant_a", hash('d')), ("tenant_b", hash('e'))] {
        let result = prepare(
            &mut client,
            prepare_request(
                customer_id,
                release_id,
                "app_base",
                release_id,
                base_hash.clone(),
                effective_hash.clone(),
                None,
                phase_plan.clone(),
            ),
        );
        let revision_id = revision_id(&result);
        assert_ok(&ready(
            &mut client,
            customer_id,
            revision_id,
            effective_hash.clone(),
            json!([]),
        ));
        prepared.push((customer_id, revision_id, effective_hash));
    }

    let execution_role = enable_non_bypass_schema_revision_rls(&mut client, &schema);
    let activation = json!({
        "app_id": "installer_app",
        "release_id": release_id,
        "base_artifact_hash": base_hash,
        "targets": prepared.iter().map(|(customer_id, revision_id, effective_hash)| json!({
            "customer_id": customer_id,
            "schema_revision_id": revision_id,
            "effective_artifact_hash": effective_hash,
            "expected_active_effective_hash": null,
        })).collect::<Vec<_>>(),
    });
    client
        .batch_execute(&format!("set role \"{execution_role}\""))
        .expect("assume non-BYPASSRLS installer role");
    let activated = activate_app_base(&mut client, &activation);
    client
        .batch_execute("reset role")
        .expect("reset installer role");
    assert_ok(&activated);
    assert_eq!(active_version(&mut client, "tenant_a"), release_id);
    assert_eq!(active_version(&mut client, "tenant_b"), release_id);

    let continuation_hash = hash('f');
    let continuation_prepared = prepare(
        &mut client,
        prepare_request(
            "tenant_c",
            release_id,
            "app_base",
            release_id,
            base_hash.clone(),
            continuation_hash.clone(),
            None,
            phase_plan,
        ),
    );
    let continuation_revision_id = revision_id(&continuation_prepared);
    assert_ok(&ready(
        &mut client,
        "tenant_c",
        continuation_revision_id,
        continuation_hash.clone(),
        json!([]),
    ));

    client
        .batch_execute(&format!("set role \"{execution_role}\""))
        .expect("assume non-BYPASSRLS installer role for continuation");
    let continued = call(
        &mut client,
        "kernel_continue_app_base_schema_revision",
        json!({
            "app_id": "installer_app",
            "release_id": release_id,
            "base_artifact_hash": base_hash,
            "targets": [{
                "customer_id": "tenant_c",
                "schema_revision_id": continuation_revision_id,
                "effective_artifact_hash": continuation_hash,
                "expected_active_effective_hash": null,
            }],
        }),
    );
    client
        .batch_execute("reset role")
        .expect("reset installer role");
    assert_ok(&continued);
    assert_eq!(active_version(&mut client, "tenant_c"), release_id);

    client
        .batch_execute(&format!(
            "set search_path to public; drop schema \"{schema}\" cascade; drop role \"{execution_role}\""
        ))
        .expect("remove isolated RLS fixture");
}

fn create_installer_schema(database_url: &str, suffix: &str) -> String {
    let schema = format!("kernel_installer_{suffix}_{}", Uuid::new_v4().simple());
    let mut client = connect_postgres(database_url).expect("connect to PostgreSQL");
    client
        .batch_execute(&format!(
            "create schema \"{schema}\"; set search_path to \"{schema}\""
        ))
        .expect("create isolated installer schema");
    client
        .batch_execute(SCHEMA_REVISION_SUBSTRATE)
        .expect("install schema revision substrate");
    client
        .batch_execute(installer::substrate_sql())
        .expect("install installer substrate");
    // App-base activation reconciles lookup storage on every target. This
    // standalone fixture installs the authorization helpers and shared and
    // lookup migration helpers that the exercised installer paths call. It
    // also installs kernel_admin_sha256 because authorization snapshot sync
    // references it, and the derived-field validators that readiness runs.
    // Readiness also checks custom/declared field-id collisions, which
    // normalize identifiers. The remaining admin helpers are deliberately
    // omitted: these fixture paths do not apply overlays, so a future
    // dependency on one fails as an explicit fixture update.
    for function in installer::functions()
        .into_iter()
        .chain(authorization::functions())
        .chain(shared::functions())
        .chain(admin::functions().into_iter().filter(|function| {
            [
                "kernel_admin_sha256(text)",
                "kernel_admin_normalize_identifier(text)",
                "kernel_admin_custom_field_collision_issues(jsonb,jsonb)",
            ]
            .contains(&function.signature)
        }))
        .chain(lookup_migration::functions())
        .chain(derived::functions())
    {
        client
            .batch_execute(&function.sql)
            .unwrap_or_else(|error| panic!("install {}: {error:?}", function.signature));
    }
    schema
}

fn scoped_client(database_url: &str, schema: &str) -> postgres::Client {
    let mut client = connect_postgres(database_url).expect("connect to PostgreSQL");
    client
        .batch_execute(&format!("set search_path to \"{schema}\""))
        .expect("set installer schema");
    client
}

fn prepare(client: &mut postgres::Client, request: Value) -> Value {
    // This standalone fixture supplies raw schemas with no declared authoritative
    // CHECK expressions, so its compiler-derived catalog is intentionally empty.
    let app_id = request["app_id"].as_str().expect("fixture app id");
    let base_version = request["base_schema"]["version"]
        .as_str()
        .expect("fixture base schema version");
    client
        .execute(
            "insert into schema_constraint_identity_source (app_id, schema_version, catalog) values ($1, $2, '[]'::jsonb) on conflict do nothing",
            &[&app_id, &base_version],
        )
        .expect("install empty compiler-derived fixture catalog");
    call(client, "kernel_prepare_schema_revision", request)
}

fn ready(
    client: &mut postgres::Client,
    customer_id: &str,
    schema_revision_id: i64,
    effective_artifact_hash: String,
    phase_results: Value,
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
            "phase_results": phase_results,
        }),
    )
}

fn activate_tenant(
    client: &mut postgres::Client,
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

fn activate_app_base(client: &mut postgres::Client, request: &Value) -> Value {
    call(
        client,
        "kernel_activate_app_base_schema_revision",
        request.clone(),
    )
}

fn prepare_ready_activate_baseline(
    client: &mut postgres::Client,
    customer_id: &str,
    version: &str,
    effective_artifact_hash: String,
) -> Value {
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
            json!([]),
        ),
    );
    let schema_revision_id = revision_id(&prepared);
    assert_ok(&ready(
        client,
        customer_id,
        schema_revision_id,
        effective_artifact_hash.clone(),
        json!([]),
    ));
    activate_tenant(
        client,
        customer_id,
        schema_revision_id,
        effective_artifact_hash,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn prepare_request(
    customer_id: &str,
    version: &str,
    activation_kind: &str,
    release_id: &str,
    base_artifact_hash: String,
    effective_artifact_hash: String,
    expected_active_effective_hash: Option<String>,
    phase_plan: Value,
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
        "base_schema": schema(customer_id, version),
        "customer_overlay": {},
        "schema": schema(customer_id, version),
        "phase_plan": phase_plan,
    })
}

fn app_base_activation(first_id: i64, second_id: i64) -> Value {
    json!({
        "app_id": "installer_app",
        "release_id": "release-base",
        "base_artifact_hash": hash('c'),
        "targets": [
            {
                "customer_id": "tenant_a",
                "schema_revision_id": first_id,
                "effective_artifact_hash": hash('d'),
                "expected_active_effective_hash": hash('a'),
            },
            {
                "customer_id": "tenant_b",
                "schema_revision_id": second_id,
                "effective_artifact_hash": hash('e'),
                "expected_active_effective_hash": hash('b'),
            },
        ],
    })
}

fn schema(customer_id: &str, version: &str) -> Value {
    json!({
        "app_id": "installer_app",
        "customer_id": customer_id,
        "version": version,
        "models": [],
        "custom_fields": [],
        "change_types": [],
    })
}

fn call(client: &mut postgres::Client, function: &str, request: Value) -> Value {
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

fn active_version(client: &mut postgres::Client, customer_id: &str) -> String {
    client
        .query_one(
            "select version from schema_revision where app_id = 'installer_app' and customer_id = $1 and activated_at is not null",
            &[&customer_id],
        )
        .expect("active schema revision")
        .get(0)
}

fn hash(character: char) -> String {
    character.to_string().repeat(64)
}

fn drop_schema(client: &mut postgres::Client, schema: &str) {
    client
        .batch_execute(&format!("drop schema \"{schema}\" cascade"))
        .expect("drop isolated installer schema");
}

fn enable_non_bypass_schema_revision_rls(client: &mut postgres::Client, schema: &str) -> String {
    let execution_role: String = client
        .query_one(
            "select kernel_installer_capability_role('execution_owner')",
            &[],
        )
        .expect("resolve installer execution role")
        .get(0);
    client
        .batch_execute(&format!(
            r#"
            create role "{execution_role}" nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
            grant "{execution_role}" to session_user;
            grant usage on schema "{schema}" to "{execution_role}";
            grant all privileges on all tables in schema "{schema}" to "{execution_role}";
            grant usage, select, update on all sequences in schema "{schema}" to "{execution_role}";
            grant execute on all functions in schema "{schema}" to "{execution_role}";
            alter table schema_revision enable row level security;
            alter table schema_revision force row level security;
            "#
        ))
        .expect("install non-BYPASSRLS fixture principal and policy enforcement");
    let role_attributes = client
        .query_one(
            "select rolsuper, rolbypassrls from pg_roles where rolname = $1",
            &[&execution_role],
        )
        .expect("verify restricted installer role attributes");
    let is_superuser: bool = role_attributes.get(0);
    let bypass_rls: bool = role_attributes.get(1);
    assert!(!is_superuser && !bypass_rls);
    let rls_flags = client
        .query_one(
            "select relrowsecurity, relforcerowsecurity from pg_class where oid = 'schema_revision'::regclass",
            &[],
        )
        .expect("verify schema revision row security");
    let row_security: bool = rls_flags.get(0);
    let force_row_security: bool = rls_flags.get(1);
    assert!(row_security && force_row_security);
    execution_role
}

fn test_database_url() -> Option<String> {
    match env::var("KERNEL_TEST_DATABASE_URL") {
        Ok(url) => Some(url),
        Err(env::VarError::NotPresent) => {
            eprintln!("skipping installer SQL test: KERNEL_TEST_DATABASE_URL is absent");
            None
        }
        Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
    }
}
