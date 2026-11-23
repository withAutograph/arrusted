use std::env;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use kernel::connect_postgres;
use postgres::Client;
use schema_compiler::{
    compile_manifest_json, compile_sql_artifact_manifest, compile_sql_materialization_plan,
    render_sql_artifact_bundle, CompiledManifest, RetirementKind, SqlArtifactKind,
    SqlArtifactManifest,
};
use serde_json::{json, Value};

mod support;

static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn materialize_schema_drops_removed_version_field_column_replaced_by_non_destructive_retirement() {
    let Some(mut harness) = Harness::new("retired_field") else {
        return;
    };
    let previous = manifest(
        "core_app",
        "retired_field",
        "2026-08-01",
        vec![model(
            "company",
            vec![
                text_field("name", true, false),
                text_field("slug", false, false),
            ],
        )],
    );
    harness.install(&previous);
    activate_schema(&mut harness.client, &previous);
    insert_company_version(&mut harness.client, &previous, Some("retained-slug"));

    let next = manifest(
        "core_app",
        "retired_field",
        "2026-08-02",
        vec![model("company", vec![text_field("name", true, false)])],
    );
    let plan = compile_sql_materialization_plan(Some(&previous), &next).unwrap();
    assert!(plan.retirements.iter().any(|retirement| {
        retirement.kind == RetirementKind::Field
            && retirement.model.as_deref() == Some("company")
            && retirement.field.as_deref() == Some("slug")
    }));
    assert_non_destructive(&plan);
    harness.install_plan(&plan);

    assert_eq!(
        column_type(&mut harness.client, "company_version", "slug"),
        Some("text")
    );
    let retained: Option<String> = harness
        .client
        .query_one("select slug from company_version limit 1", &[])
        .expect("read retired field data")
        .get(0);
    assert_eq!(retained.as_deref(), Some("retained-slug"));
}

#[test]
fn materialize_schema_allows_renamed_field_when_old_field_had_different_type_via_immutable_ids() {
    let Some(mut harness) = Harness::new("rename_type") else {
        return;
    };
    let previous = employee_status_manifest("rename_type", "status", "relation");
    harness.install(&previous);

    let next = employee_status_manifest("rename_type", "employment_status", "enum");
    let plan = compile_sql_materialization_plan(Some(&previous), &next).unwrap();
    assert_non_destructive(&plan);
    harness.install_plan(&plan);
    assert_eq!(
        column_type(&mut harness.client, "employee_version", "status"),
        Some("uuid")
    );
    assert_eq!(
        column_type(&mut harness.client, "employee_version", "employment_status"),
        Some("text")
    );
}

#[test]
fn materialize_schema_allows_multiple_renamed_status_fields_with_old_relation_columns_via_immutable_ids(
) {
    let Some(mut harness) = Harness::new("multiple_renames") else {
        return;
    };
    let previous = multi_status_manifest("multiple_renames", false);
    harness.install(&previous);
    let next = multi_status_manifest("multiple_renames", true);
    let plan = compile_sql_materialization_plan(Some(&previous), &next).unwrap();
    assert_non_destructive(&plan);
    harness.install_plan(&plan);

    for (table, old, new) in [
        ("employee_version", "status", "employment_status"),
        ("position_version", "status", "position_status"),
    ] {
        assert_eq!(column_type(&mut harness.client, table, old), Some("uuid"));
        assert_eq!(column_type(&mut harness.client, table, new), Some("text"));
    }
}

#[test]
fn materialize_schema_preserves_columns_declared_by_sibling_active_schema_via_generated_sql() {
    let Some(mut harness) = Harness::new("sibling_columns") else {
        return;
    };
    let sibling = manifest(
        "hc_app",
        "hc_tenant",
        "2026-08-01",
        vec![
            model("company", vec![text_field("name", true, false)]),
            model(
                "employee",
                vec![
                    text_field("name", true, false),
                    relation_field("employer", "company"),
                    money_rate_field("comp_rate"),
                ],
            ),
        ],
    );
    harness.install(&sibling);
    activate_schema(&mut harness.client, &sibling);

    let subset = manifest(
        "vendor_app",
        "vendor_tenant",
        "2026-08-01",
        vec![model("employee", vec![text_field("name", true, false)])],
    );
    harness.install(&subset);
    for column in [
        "employer",
        "comp_rate_amount",
        "comp_rate_currency",
        "comp_rate_period",
    ] {
        assert!(column_type(&mut harness.client, "employee_version", column).is_some());
    }
}

#[test]
fn materialize_schema_rejects_required_columns_declared_only_by_sibling_schema_via_generated_preflight(
) {
    let Some(mut harness) = Harness::new("sibling_required") else {
        return;
    };
    let sibling = employee_title_manifest("hc_app", "hc_tenant", true, false);
    harness.install(&sibling);
    activate_schema(&mut harness.client, &sibling);
    let proposed = manifest(
        "vendor_app",
        "vendor_tenant",
        "2026-08-01",
        vec![model("employee", vec![text_field("name", true, false)])],
    );

    let error = harness.install_error(&proposed);
    assert!(
        error.contains("coordinated schema migration required"),
        "{error}"
    );
    assert!(error.contains("hc_app/hc_tenant"), "{error}");
}

#[test]
fn materialize_schema_rejects_local_required_or_unique_columns_not_shared_by_sibling_schema_via_generated_preflight(
) {
    let Some(mut harness) = Harness::new("local_contract") else {
        return;
    };
    let sibling = employee_title_manifest("vendor_app", "vendor_tenant", false, false);
    harness.install(&sibling);
    activate_schema(&mut harness.client, &sibling);

    for (app_id, customer_id, required, unique, expected) in [
        (
            "hc_required",
            "required_tenant",
            true,
            false,
            "required columns differ",
        ),
        (
            "hc_unique",
            "unique_tenant",
            false,
            true,
            "unique columns differ",
        ),
    ] {
        let proposed = employee_title_manifest(app_id, customer_id, required, unique);
        let result = call_preflight(&mut harness.client, &proposed);
        assert_eq!(
            result["ok"], false,
            "unexpected preflight success: {result}"
        );
        assert!(
            result["error"]["details"][0]["message"]
                .as_str()
                .expect("drift details")
                .contains(expected),
            "{result}"
        );
    }
}

#[test]
fn materialization_preflight_rejects_coordinated_contract_changes_without_writing_via_generated_sql(
) {
    let Some(mut harness) = Harness::new("preflight_read_only") else {
        return;
    };
    let active = employee_title_manifest("vendor_app", "active_tenant", false, false);
    harness.install(&active);
    activate_schema(&mut harness.client, &active);
    let proposed = employee_title_manifest("vendor_app", "proposed_tenant", true, false);
    let before: i64 = harness
        .client
        .query_one("select count(*) from schema_revision", &[])
        .unwrap()
        .get(0);

    let result = call_preflight(&mut harness.client, &proposed);
    assert_eq!(
        result["ok"], false,
        "unexpected preflight success: {result}"
    );
    assert_eq!(result["error"]["code"], "schema_drift");
    assert_eq!(result["error"]["message"], "Schema drift detected");
    assert_eq!(result["error"]["details"][0]["path"], "object");
    assert_eq!(result["error"]["details"][0]["code"], "schema_drift");
    assert!(result
        .to_string()
        .contains("coordinated schema migration required"));
    let catalog_read: Option<String> = harness
        .client
        .query_one(
            "select nullif(current_setting('kernel.schema_catalog_read', true), '')",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(catalog_read, None, "preflight leaked catalog-read scope");
    let after: i64 = harness
        .client
        .query_one("select count(*) from schema_revision", &[])
        .unwrap()
        .get(0);
    assert_eq!(after, before, "preflight wrote a schema revision");
}

#[test]
fn materialize_schema_drops_stale_required_and_unique_artifacts_for_retained_sibling_column_via_generated_reconciliation(
) {
    let Some(mut harness) = Harness::new("stale_artifacts") else {
        return;
    };
    let sibling = employee_title_manifest("vendor_app", "vendor_tenant", false, false);
    harness.install(&sibling);
    activate_schema(&mut harness.client, &sibling);
    harness
        .client
        .batch_execute(
            r#"
            alter table employee_version
              add constraint employee_version_title_required_check
              check (tombstones_record or untombstones_record or title is not null);
            create unique index employee_version_title_live_unique_idx
              on employee_version (app_id, customer_id, title)
              where stage = 'mainline' and effective_end is null and title is not null;
            "#,
        )
        .unwrap();

    let proposed = manifest(
        "hc_app",
        "hc_tenant",
        "2026-08-02",
        vec![model("employee", vec![text_field("name", true, false)])],
    );
    harness.install(&proposed);
    assert_eq!(
        column_type(&mut harness.client, "employee_version", "title"),
        Some("text")
    );
    assert!(!constraint_exists(
        &mut harness.client,
        "employee_version",
        "employee_version_title_required_check"
    ));
    assert!(!index_exists(
        &mut harness.client,
        "employee_version_title_live_unique_idx"
    ));
}

#[test]
fn materialize_schema_rejects_removed_change_set_reason_column_replaced_by_column_retirement() {
    let Some(mut harness) = Harness::new("reason_retirement") else {
        return;
    };
    let compiled = company_manifest("reason_retirement");
    harness.install(&compiled);
    activate_schema(&mut harness.client, &compiled);
    insert_change_set(
        &mut harness.client,
        &compiled,
        "mainline",
        Some("legacy reason"),
    );
    harness
        .client
        .batch_execute("alter table change_set rename column notes to reason")
        .unwrap();

    harness.install(&compiled);
    assert_eq!(
        column_type(&mut harness.client, "change_set", "reason"),
        Some("text")
    );
    assert_eq!(
        column_type(&mut harness.client, "change_set", "notes"),
        Some("text")
    );
    let reason: Option<String> = harness
        .client
        .query_one("select reason from change_set limit 1", &[])
        .unwrap()
        .get(0);
    assert_eq!(reason.as_deref(), Some("legacy reason"));
}

#[test]
fn materialize_schema_rejects_removed_reverted_change_set_status_rows_replaced_by_historical_retirement(
) {
    let Some(mut harness) = Harness::new("reverted_row") else {
        return;
    };
    let compiled = company_manifest("reverted_row");
    harness.install(&compiled);
    activate_schema(&mut harness.client, &compiled);
    install_legacy_reverted_status_check(&mut harness.client);
    insert_change_set(&mut harness.client, &compiled, "reverted", None);

    harness.install(&compiled);
    let count: i64 = harness
        .client
        .query_one(
            "select count(*) from change_set where status = 'reverted'",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(
        count, 1,
        "historical reverted status was rewritten or deleted"
    );
}

#[test]
fn materialize_schema_rejects_removed_reverted_change_set_status_check_replaced_by_non_destructive_retirement(
) {
    let Some(mut harness) = Harness::new("reverted_check") else {
        return;
    };
    let compiled = company_manifest("reverted_check");
    harness.install(&compiled);
    install_legacy_reverted_status_check(&mut harness.client);

    harness.install(&compiled);
    assert!(constraint_exists(
        &mut harness.client,
        "change_set",
        "change_set_status_check"
    ));
    let expression: String = harness
        .client
        .query_one(
            r#"
            select pg_get_expr(c.conbin, c.conrelid, true)
            from pg_constraint c
            where c.conrelid = 'change_set'::regclass
              and c.conname = 'change_set_status_check'
            "#,
            &[],
        )
        .unwrap()
        .get(0);
    assert!(
        expression.contains("reverted"),
        "legacy domain was destructively narrowed: {expression}"
    );
}

struct Harness {
    client: Client,
    schema: String,
}

impl Harness {
    fn new(label: &str) -> Option<Self> {
        let database_url = match env::var("KERNEL_TEST_DATABASE_URL") {
            Ok(database_url) => database_url,
            Err(env::VarError::NotPresent) => {
                eprintln!("skipping PostgreSQL parity test: KERNEL_TEST_DATABASE_URL is absent");
                return None;
            }
            Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
        };
        let mut client = match connect_postgres(&database_url) {
            Ok(client) => client,
            Err(error) => {
                eprintln!("skipping PostgreSQL parity test: {error}");
                return None;
            }
        };
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let counter = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let schema = format!("kernel_sql_migration_{label}_{nonce}_{counter}");
        client
            .batch_execute(&format!(
                "create schema \"{schema}\"; set search_path to \"{schema}\""
            ))
            .unwrap();
        support::trusted_human::before_install(&mut client);
        Some(Self { client, schema })
    }

    fn install(&mut self, compiled: &CompiledManifest) {
        let plan = compile_sql_artifact_manifest(compiled).unwrap();
        self.install_plan(&plan);
    }

    fn install_plan(&mut self, plan: &schema_compiler::SqlArtifactManifest) {
        self.client
            .batch_execute(&render_sql_artifact_bundle(plan))
            .expect("install compiler-emitted SQL materialization plan");
    }

    fn install_error(&mut self, compiled: &CompiledManifest) -> String {
        let plan = compile_sql_artifact_manifest(compiled).unwrap();
        let error = self
            .client
            .batch_execute(&render_sql_artifact_bundle(&plan))
            .expect_err("incompatible sibling contract must fail");
        error.as_db_error().map_or_else(
            || error.to_string(),
            |database_error| {
                format!(
                    "{} {}",
                    database_error.message(),
                    database_error.detail().unwrap_or_default()
                )
            },
        )
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        support::drop_generated_sql_fixture(&mut self.client, &self.schema);
    }
}

fn manifest(
    app_id: &str,
    customer_id: &str,
    version: &str,
    models: Vec<Value>,
) -> CompiledManifest {
    compile_manifest_json(
        &json!({
            "app_id": app_id,
            "customer_id": customer_id,
            "version": version,
            "models": models,
            "custom_fields": [],
            "change_types": [],
            "constraints": [],
            "seed_change_sets": []
        })
        .to_string(),
    )
    .unwrap()
}

fn model(id: &str, fields: Vec<Value>) -> Value {
    json!({"id": id, "kind": "entity", "label": id, "fields": fields})
}

fn text_field(id: &str, required: bool, unique: bool) -> Value {
    json!({
        "id": id,
        "label": id,
        "type": "text",
        "required": required,
        "is_unique": unique
    })
}

fn relation_field(id: &str, target: &str) -> Value {
    json!({"id": id, "label": id, "type": "relation", "target_model": target})
}

fn money_rate_field(id: &str) -> Value {
    json!({"id": id, "label": id, "type": "money_rate"})
}

fn enum_field(id: &str) -> Value {
    json!({
        "id": id,
        "label": id,
        "type": "enum",
        "option_set": [{"id": "active", "label": "Active"}]
    })
}

fn company_manifest(customer_id: &str) -> CompiledManifest {
    manifest(
        "core_app",
        customer_id,
        "2026-08-01",
        vec![model("company", vec![text_field("name", true, false)])],
    )
}

fn employee_title_manifest(
    app_id: &str,
    customer_id: &str,
    required: bool,
    unique: bool,
) -> CompiledManifest {
    manifest(
        app_id,
        customer_id,
        "2026-08-01",
        vec![model(
            "employee",
            vec![
                text_field("name", true, false),
                text_field("title", required, unique),
            ],
        )],
    )
}

fn employee_status_manifest(
    customer_id: &str,
    field_id: &str,
    field_type: &str,
) -> CompiledManifest {
    let status = if field_type == "relation" {
        relation_field(field_id, "company")
    } else {
        enum_field(field_id)
    };
    manifest(
        "core_app",
        customer_id,
        if field_id == "status" {
            "2026-08-01"
        } else {
            "2026-08-02"
        },
        vec![
            model("company", vec![text_field("name", true, false)]),
            model("employee", vec![text_field("name", true, false), status]),
        ],
    )
}

fn multi_status_manifest(customer_id: &str, renamed: bool) -> CompiledManifest {
    let employee_status = if renamed {
        enum_field("employment_status")
    } else {
        relation_field("status", "company")
    };
    let position_status = if renamed {
        enum_field("position_status")
    } else {
        relation_field("status", "company")
    };
    manifest(
        "core_app",
        customer_id,
        if renamed { "2026-08-02" } else { "2026-08-01" },
        vec![
            model("company", vec![text_field("name", true, false)]),
            model(
                "employee",
                vec![text_field("name", true, false), employee_status],
            ),
            model(
                "position",
                vec![text_field("name", true, false), position_status],
            ),
        ],
    )
}

fn activate_schema(client: &mut Client, compiled: &CompiledManifest) {
    let schema = serde_json::to_value(&compiled.schema).unwrap();
    client
        .execute(
            r#"
            insert into schema_revision (
              app_id, customer_id, version, base_schema, customer_overlay, schema,
              activated_at, schema_hash, materialized_at
            ) values ($1, $2, $3, $4, '{}'::jsonb, $4, now(), 'test-hash', now())
            "#,
            &[
                &compiled.schema.app_id.as_str(),
                &compiled.schema.customer_id.as_str(),
                &compiled.schema.version.as_str(),
                &schema,
            ],
        )
        .expect("activate test schema revision");
}

fn insert_change_set(
    client: &mut Client,
    compiled: &CompiledManifest,
    status: &str,
    notes: Option<&str>,
) -> i64 {
    client
        .query_one(
            r#"
            insert into change_set (
              app_id, customer_id, schema_revision_id, created_with_mode, status,
              source_kind, notes, created_order, applied_order, applied_at
            )
            select app_id, customer_id, id, 'mainline', $3, 'migration-test', $4,
                   nextval('change_set_lifecycle_order_seq'),
                   case when $3 = 'mainline' then nextval('change_set_lifecycle_order_seq') end,
                   case when $3 = 'mainline' then now() end
            from schema_revision
            where app_id = $1 and customer_id = $2 and activated_at is not null
            returning id
            "#,
            &[
                &compiled.schema.app_id.as_str(),
                &compiled.schema.customer_id.as_str(),
                &status,
                &notes,
            ],
        )
        .expect("insert test change set")
        .get(0)
}

fn insert_company_version(client: &mut Client, compiled: &CompiledManifest, slug: Option<&str>) {
    let change_set_id = insert_change_set(client, compiled, "mainline", None);
    let record_id = "10000000-0000-0000-0000-000000000001";
    client
        .execute(
            "insert into company_record (id, app_id, customer_id, external_key) values (cast($1 as text)::uuid, $2, $3, 'company-a')",
            &[&record_id, &compiled.schema.app_id.as_str(), &compiled.schema.customer_id.as_str()],
        )
        .unwrap();
    client
        .execute(
            r#"
            insert into company_version (
              id, record_id, app_id, customer_id, stage, effective_start,
              change_set_id, applied_at, name, slug
            ) values (
              '20000000-0000-0000-0000-000000000001', cast($1 as text)::uuid, $2, $3,
              'mainline', '2026-08-01', $4, now(), 'Company A', $5
            )
            "#,
            &[
                &record_id,
                &compiled.schema.app_id.as_str(),
                &compiled.schema.customer_id.as_str(),
                &change_set_id,
                &slug,
            ],
        )
        .unwrap();
}

fn install_legacy_reverted_status_check(client: &mut Client) {
    client
        .batch_execute(
            r#"
            alter table change_set drop constraint change_set_status_check;
            alter table change_set add constraint change_set_status_check
              check (status in ('draft', 'mainline', 'discarded', 'reverted'));
            "#,
        )
        .unwrap();
}

fn call_preflight(client: &mut Client, compiled: &CompiledManifest) -> Value {
    let request = json!({"schema": compiled.schema});
    client
        .query_one(
            "select kernel_preflight_schema_materialization($1::jsonb)",
            &[&request],
        )
        .expect("call generated materialization preflight")
        .get(0)
}

fn column_type(client: &mut Client, table: &str, column: &str) -> Option<&'static str> {
    let value = client
        .query_opt(
            r#"
            select data_type
            from information_schema.columns
            where table_schema = current_schema() and table_name = $1 and column_name = $2
            "#,
            &[&table, &column],
        )
        .unwrap()
        .map(|row| row.get::<_, String>(0));
    value.map(|value| match value.as_str() {
        "text" => "text",
        "uuid" => "uuid",
        "numeric" => "numeric",
        "boolean" => "boolean",
        "date" => "date",
        "timestamp with time zone" => "timestamptz",
        "ARRAY" => "array",
        "jsonb" => "jsonb",
        other => panic!("unexpected PostgreSQL type {other}"),
    })
}

fn constraint_exists(client: &mut Client, table: &str, constraint: &str) -> bool {
    client
        .query_one(
            "select exists (select 1 from pg_constraint where conrelid = to_regclass($1) and conname = $2)",
            &[&table, &constraint],
        )
        .unwrap()
        .get(0)
}

fn index_exists(client: &mut Client, index: &str) -> bool {
    client
        .query_one("select to_regclass($1) is not null", &[&index])
        .unwrap()
        .get(0)
}

fn assert_non_destructive(plan: &SqlArtifactManifest) {
    let materialization_sql = plan
        .artifacts
        .iter()
        .filter(|artifact| artifact.kind != SqlArtifactKind::Function)
        .map(|artifact| artifact.sql.clone())
        .collect::<Vec<_>>()
        .join("\n")
        .to_ascii_lowercase();
    for forbidden in ["drop table", "drop column", "delete from"] {
        assert!(
            !materialization_sql.contains(forbidden),
            "found destructive SQL: {forbidden}"
        );
    }
}
