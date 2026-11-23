#[path = "support/trusted_human.rs"]
mod trusted_human;
use std::env;

use kernel::{connect_postgres, schema_hash, Schema};
use postgres::Client;
use schema_compiler::{
    compile_sql_artifact_manifest, render_sql_artifact_bundle, CompiledManifest,
    NormalizedManifestExtras,
};
use serde_json::{json, Value};
use uuid::Uuid;

#[test]
fn migration_sql_is_resumable_non_destructive_and_forward_only() {
    let source = include_str!("../src/sql_runtime/lookup_migration.rs");
    let installer_source = include_str!("../src/sql_runtime/installer.rs");
    for required in [
        "kernel_prepare_lookup_migration(jsonb)",
        "kernel_validate_lookup_migration(jsonb)",
        "kernel_activate_lookup_migration(jsonb)",
        "lookup_migration_phase",
        "lookup_storage_authority",
        "cursor_id uuid",
        "source_history_hash",
        "target_history_hash",
        "access exclusive mode",
        "lookup_migration_write_block",
        "first_generic_write_at",
        "kernel_lookup_storage_authority_error(text,text,text)",
        "lookup_storage_authority_mismatch",
        "kernel_apply_project_lookup_version",
        "lookup_migration_forward_only",
    ] {
        assert!(
            source.contains(required),
            "migration SQL is missing `{required}`"
        );
    }
    assert!(
        installer_source.contains("kernel_reconcile_lookup_foreign_key_targets(text,text)"),
        "installer SQL must own lookup-target reconciliation used by materialized repair"
    );
    let prepare_runtime = source
        .split("const PREPARE_MIGRATION")
        .nth(1)
        .expect("prepare runtime is present");
    let authority = prepare_runtime
        .find("insert into lookup_storage_authority")
        .expect("storage authority is established");
    let reconciliation = prepare_runtime
        .find("perform kernel_reconcile_lookup_foreign_key_targets(app_id, customer_id);")
        .expect("foreign-key reconciliation is present");
    let record_phase = prepare_runtime
        .find("-- Records for every model must exist")
        .expect("record migration phase is present");
    assert!(
        authority < reconciliation && reconciliation < record_phase,
        "foreign-key targets must be reconciled after authority is established and before lookup records migrate"
    );
    let lowercase = source.to_ascii_lowercase();
    for forbidden in [
        "drop table",
        "drop column",
        "delete from lookup_record",
        "delete from lookup_version",
        "provider",
        "xero",
        "ramp",
        "quickbooks",
    ] {
        assert!(
            !lowercase.contains(forbidden),
            "migration SQL contains `{forbidden}`"
        );
    }
    assert!(source.contains("authority in ('typed', 'generic')"));
    assert!(source.contains("legacy_lookup_authority_retired"));
    assert!(source.contains("unclassified_legacy_column"));
    assert!(source.contains("on conflict on constraint lookup_version_pkey"));
    assert!(source.contains("(alias_projection.model_id, alias_projection.version_id) in"));
    assert!(!source.contains("where existing.id ="));
}

#[test]
fn typed_lookup_history_migrates_and_activates_atomically_on_postgres_17() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let compiled = compiled_fixture();
    let manifest = compile_sql_artifact_manifest(&compiled).expect("compile generated SQL bundle");
    let bundle = render_sql_artifact_bundle(&manifest);
    let mut client = connect_postgres(&database_url).expect("connect to PostgreSQL");
    let version: i32 = client
        .query_one("show server_version_num", &[])
        .expect("read PostgreSQL version")
        .get::<_, String>(0)
        .parse()
        .expect("numeric PostgreSQL version");
    assert!(
        version >= 170_000,
        "lookup migration requires PostgreSQL 17"
    );

    let database_schema = format!("kernel_lookup_migration_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            "create schema \"{database_schema}\"; set search_path to \"{database_schema}\""
        ))
        .expect("create isolated schema");
    trusted_human::before_install(&mut client);

    let result = (|| -> Result<(), String> {
        client
            .batch_execute(&bundle)
            .map_err(|error| format!("install generated bundle: {error:?}"))?;
        client
            .batch_execute(&migration_sql())
            .map_err(|error| format!("install lookup migration: {error:?}"))?;
        set_scope(&mut client)?;
        let schema_hash = schema_hash(&compiled.schema);
        let revision_id =
            seed_schema_and_legacy_history(&mut client, &compiled.schema, &schema_hash)?;
        let request = json!({
            "app_id": "migration_app",
            "customer_id": "tenant_a",
            "schema_revision_id": revision_id,
            "expected_schema_hash": schema_hash,
            "batch_size": 1
        });

        client
            .batch_execute(
                "alter table department_version add column legacy_unmapped text; update department_version set legacy_unmapped = 'cannot-preserve' where stage = 'draft'",
            )
            .map_err(|error| format!("add unclassified legacy data: {error:?}"))?;
        let unclassified = call(
            &mut client,
            "kernel_prepare_lookup_migration",
            request.clone(),
        )?;
        assert_eq!(
            unclassified["ok"], false,
            "unclassified data was accepted: {unclassified}"
        );
        assert_eq!(unclassified["error"]["code"], "unclassified_legacy_column");
        client
            .execute("update department_version set legacy_unmapped = null", &[])
            .map_err(|error| format!("clear unclassified legacy data: {error:?}"))?;

        let prepared = prepare_until_ready(&mut client, request.clone())?;
        assert_eq!(
            prepared["ok"], true,
            "initial preparation failed: {prepared}"
        );
        assert_eq!(prepared["data"]["ready"], true);

        let authority_before: Vec<(String, String)> = client
            .query(
                "select model_id, authority from lookup_storage_authority order by model_id",
                &[],
            )
            .map_err(|error| format!("read typed authority: {error:?}"))?
            .into_iter()
            .map(|row| (row.get(0), row.get(1)))
            .collect();
        assert_eq!(
            authority_before,
            vec![
                ("category".to_string(), "typed".to_string()),
                ("department".to_string(), "typed".to_string()),
            ]
        );

        client
            .execute(
                "update lookup_version set values = '{\"name\":{\"type\":\"text\",\"value\":\"corrupt\"}}' where model_id = 'department' and stage = 'mainline' and not tombstones_record",
                &[],
            )
            .map_err(|error| format!("corrupt shadow copy: {error:?}"))?;
        let mismatch = call(
            &mut client,
            "kernel_validate_lookup_migration",
            without_batch_size(&request),
        )?;
        assert_eq!(
            mismatch["ok"], false,
            "corruption was not detected: {mismatch}"
        );
        assert_eq!(mismatch["error"]["code"], "lookup_migration_mismatch");

        let late_record = Uuid::parse_str("00000000-0000-4000-8000-000000000001").unwrap();
        let late_version = Uuid::parse_str("00000000-0000-4000-8000-000000000002").unwrap();
        let late_change: i64 = client
            .query_one(
                r#"
                insert into change_set (
                  app_id, customer_id, schema_revision_id, created_with_mode, status,
                  source_kind, created_order, applied_order, applied_at
                ) values ('migration_app', 'tenant_a', $1, 'mainline', 'mainline',
                  'migration-test', 5, 5, now()) returning id
                "#,
                &[&revision_id],
            )
            .map_err(|error| format!("create late change set: {error:?}"))?
            .get(0);
        client
            .execute(
                "insert into category_record (id, app_id, customer_id, external_key, created_at) values ($1, 'migration_app', 'tenant_a', 'late', '2026-08-05T12:00:00Z')",
                &[&late_record],
            )
            .map_err(|error| format!("insert late typed record: {error:?}"))?;
        client
            .execute(
                r#"
                insert into category_version (
                  id, record_id, app_id, customer_id, stage, effective_start,
                  change_set_id, created_at, applied_at, name
                ) values ($1, $2, 'migration_app', 'tenant_a', 'mainline',
                  '2026-08-05', $3, '2026-08-05T12:00:00Z',
                  '2026-08-05T12:00:00Z', 'Late category')
                "#,
                &[&late_version, &late_record, &late_change],
            )
            .map_err(|error| format!("insert late typed version: {error:?}"))?;

        let activated = call(
            &mut client,
            "kernel_activate_lookup_migration",
            without_batch_size(&request),
        )?;
        assert_eq!(activated["ok"], true, "activation failed: {activated}");
        assert_eq!(activated["data"]["activated"], true);
        assert_eq!(activated["data"]["idempotent"], false);

        let authority_after: Vec<(String, String, bool)> = client
            .query(
                "select model_id, authority, first_generic_write_at is null from lookup_storage_authority order by model_id",
                &[],
            )
            .map_err(|error| format!("read generic authority: {error:?}"))?
            .into_iter()
            .map(|row| (row.get(0), row.get(1), row.get(2)))
            .collect();
        assert_eq!(
            authority_after,
            vec![
                ("category".to_string(), "generic".to_string(), true),
                ("department".to_string(), "generic".to_string(), true),
            ]
        );

        assert_migrated_history(&mut client, late_record)?;
        // Simulate a retained identity lost by a legacy installer, preserving
        // versions and projections. Ordinary DELETE is correctly rejected by
        // incoming FKs (or cascades history), so only the isolated corruption
        // fixture suppresses the identity table's referential triggers.
        client
            .batch_execute("begin; alter table lookup_record disable trigger all")
            .map_err(|error| format!("begin legacy corruption fixture: {error:?}"))?;
        client
            .execute(
                "delete from lookup_record where app_id = 'migration_app' and customer_id = 'tenant_a' and model_id = 'department'",
                &[],
            )
            .map_err(|error| format!("remove recoverable generic lookup record: {error:?}"))?;
        client
            .batch_execute("alter table lookup_record enable trigger all; commit")
            .map_err(|error| format!("finish legacy corruption fixture: {error:?}"))?;
        let repaired = prepare_until_ready(&mut client, request.clone())?;
        assert_eq!(
            repaired["ok"], true,
            "generic shadow repair failed: {repaired}"
        );
        assert_eq!(repaired["data"]["ready"], true);
        assert_migrated_history(&mut client, late_record)?;
        let validated = call(
            &mut client,
            "kernel_validate_lookup_migration",
            without_batch_size(&request),
        )?;
        assert_eq!(
            validated["ok"], true,
            "final evidence mismatch: {validated}"
        );

        let legacy_write = client.execute(
            "update department_record set external_key = 'blocked' where customer_id = 'tenant_a'",
            &[],
        );
        let legacy_error = legacy_write.expect_err("legacy writes must be blocked");
        assert!(
            legacy_error
                .as_db_error()
                .is_some_and(|error| error.message().contains("legacy_lookup_authority_retired")),
            "unexpected legacy write error: {legacy_error:?}"
        );

        trusted_human::bind(&mut client, "migration_app", "tenant_a", "fixture-human");
        let generic_write = call(
            &mut client,
            "kernel_apply_change_set",
            json!({
                "app_id":"migration_app","customer_id":"tenant_a",
                "actor_id":"fixture-human","source_kind":"migration-test","idempotency_key":"first-generic-api-write",
                "mode":"mainline","writes":[{
                    "model_id":"department","new_record_id":Uuid::new_v4(),
                    "effective_start":"2026-08-06",
                    "values":{"name":{"type":"text","value":"post-cutover"}}
                }]
            }),
        )?;
        assert_eq!(
            generic_write["ok"], true,
            "generic API write failed: {generic_write}"
        );
        let first_write_marked: bool = client
            .query_one(
                "select first_generic_write_at::date=current_date from lookup_storage_authority where model_id = 'department'",
                &[],
            )
            .map_err(|error| format!("read generic write marker: {error:?}"))?
            .get(0);
        assert!(first_write_marked);

        client
            .batch_execute("begin; alter table lookup_record disable trigger all")
            .map_err(|error| format!("begin post-cutover corruption fixture: {error:?}"))?;
        client
            .execute(
                "delete from lookup_record where app_id = 'migration_app' and customer_id = 'tenant_a' and model_id = 'department' and id = (select id from department_record where app_id = 'migration_app' and customer_id = 'tenant_a' order by id limit 1)",
                &[],
            )
            .map_err(|error| format!("remove post-cutover recoverable record: {error:?}"))?;
        client
            .batch_execute("alter table lookup_record enable trigger all; commit")
            .map_err(|error| format!("finish post-cutover corruption fixture: {error:?}"))?;
        let post_cutover_repair = prepare_until_ready(&mut client, request.clone())?;
        assert_eq!(
            post_cutover_repair["ok"], true,
            "post-cutover identity repair failed: {post_cutover_repair}"
        );
        let restored_post_cutover_record: i64 = client
            .query_one(
                "select count(*) from lookup_record where app_id = 'migration_app' and customer_id = 'tenant_a' and model_id = 'department'",
                &[],
            )
            .map_err(|error| format!("count repaired post-cutover records: {error:?}"))?
            .get(0);
        assert!(restored_post_cutover_record > 0);

        let replay = call(
            &mut client,
            "kernel_activate_lookup_migration",
            without_batch_size(&request),
        )?;
        assert_eq!(replay["ok"], true);
        assert_eq!(replay["data"]["idempotent"], true);

        // A version-only replay is intentionally compatible. Model a genuinely
        // different, unapproved schema rather than assigning an arbitrary hash
        // to the unchanged schema JSON.
        let mut next_schema = compiled.schema.clone();
        next_schema.version = "2026-08-06".into();
        next_schema.models[0].label = "Changed category".into();
        let next_hash = kernel::schema_hash(&next_schema);
        let next_revision: i64 = client
            .query_one(
                r#"
                insert into schema_revision(
                  app_id,customer_id,version,base_schema,customer_overlay,schema,
                  schema_hash,materialization_source,materialized_at
                ) values('migration_app','tenant_a','2026-08-06',$1,'{}',$1,$2,'migration-test',now())
                returning id
                "#,
                &[&serde_json::to_value(&next_schema).unwrap(), &next_hash],
            )
            .map_err(|error| format!("create forward-only revision: {error:?}"))?
            .get(0);
        let malformed_revision = call(
            &mut client,
            "kernel_prepare_lookup_migration",
            json!({
                "app_id":"migration_app","customer_id":"tenant_a",
                "schema_revision_id":"not-a-number","expected_schema_hash":next_hash,
                "batch_size":1
            }),
        )?;
        assert_eq!(malformed_revision["ok"], false);
        assert_eq!(
            malformed_revision["error"]["code"],
            "contract_validation_failed"
        );

        let inactive_revision = call(
            &mut client,
            "kernel_prepare_lookup_migration",
            json!({
                "app_id":"migration_app","customer_id":"tenant_a",
                "schema_revision_id":next_revision,"expected_schema_hash":next_hash,
                "batch_size":1
            }),
        )?;
        assert_eq!(inactive_revision["ok"], false);
        assert_eq!(inactive_revision["error"]["code"], "stale_schema_revision");
        client
            .execute(
                "update schema_revision set activated_at=case when id=$1 then now() else null end where app_id='migration_app' and customer_id='tenant_a'",
                &[&next_revision],
            )
            .map_err(|error| format!("activate forward-only revision: {error:?}"))?;
        let forward_only = call(
            &mut client,
            "kernel_prepare_lookup_migration",
            json!({
                "app_id":"migration_app","customer_id":"tenant_a",
                "schema_revision_id":next_revision,"expected_schema_hash":next_hash,
                "batch_size":1
            }),
        )?;
        assert_eq!(
            forward_only["ok"], false,
            "generic authority regressed: {forward_only}"
        );
        assert_eq!(
            forward_only["error"]["code"],
            "lookup_migration_forward_only"
        );
        Ok(())
    })();

    let cleanup = trusted_human::drop_fixture(&mut client, &database_schema);
    if let Err(error) = result {
        panic!("{error}");
    }
    cleanup.expect("drop isolated migration schema");
}

fn compiled_fixture() -> CompiledManifest {
    let schema: Schema = serde_json::from_value(json!({
        "app_id": "migration_app",
        "customer_id": "tenant_a",
        "version": "2026-08-05",
        "models": [
            {
                "id": "category",
                "kind": "lookup",
                "label": "Category",
                "display_field_id": "name",
                "fields": [{
                    "id": "name", "label": "Name", "type": "text",
                    "required": true, "is_unique": false
                }]
            },
            {
                "id": "department",
                "kind": "lookup",
                "label": "Department",
                "display_field_id": "name",
                "fields": [
                    {"id": "name", "label": "Name", "type": "text", "required": true, "is_unique": false},
                    {"id": "category", "label": "Category", "type": "relation", "target_model": "category", "required": false, "is_unique": false},
                    {"id": "aliases", "label": "Aliases", "type": "known_aliases", "required": false, "is_unique": false},
                    {"id": "rate", "label": "Rate", "type": "money_rate", "required": false, "is_unique": false}
                ],
                "many_relations": [{
                    "id": "peers", "label": "Peers", "target_model": "department"
                }]
            }
        ],
        "custom_fields": [],
        "change_types": []
    }))
    .expect("valid migration schema");
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

fn seed_schema_and_legacy_history(
    client: &mut Client,
    schema: &Schema,
    expected_hash: &str,
) -> Result<i64, String> {
    let revision_id: i64 = client
        .query_one(
            r#"
            insert into schema_revision (
              app_id, customer_id, version, base_schema, customer_overlay, schema,
              schema_hash, materialization_source, materialized_at, activated_at
            ) values ('migration_app', 'tenant_a', '2026-08-05', $1, '{}', $1,
              $2, 'migration-test', now(), now()) returning id
            "#,
            &[&serde_json::to_value(schema).unwrap(), &expected_hash],
        )
        .map_err(|error| format!("seed schema revision: {error:?}"))?
        .get(0);
    client
        .batch_execute(
            r#"
            create table category_record (
              id uuid primary key, app_id text not null, customer_id text not null,
              external_key text, created_at timestamptz not null default now()
            );
            create table category_version (
              id uuid primary key, record_id uuid not null, app_id text not null,
              customer_id text not null, stage text not null, effective_start date not null,
              effective_end date, change_set_id bigint not null,
              created_at timestamptz not null default now(), applied_at timestamptz,
              tombstones_record boolean not null default false,
              untombstones_record boolean not null default false,
              provenance jsonb, custom_fields jsonb not null default '[]',
              name text
            );
            create table department_record (
              id uuid primary key, app_id text not null, customer_id text not null,
              external_key text, created_at timestamptz not null default now()
            );
            create table department_version (
              id uuid primary key, record_id uuid not null, app_id text not null,
              customer_id text not null, stage text not null, effective_start date not null,
              effective_end date, change_set_id bigint not null,
              created_at timestamptz not null default now(), applied_at timestamptz,
              tombstones_record boolean not null default false,
              untombstones_record boolean not null default false,
              provenance jsonb, custom_fields jsonb not null default '[]',
              metadata jsonb not null default '{}',
              many_relations jsonb not null default '{}',
              availability text not null default 'active',
              name text, category uuid, aliases text[], rate_amount numeric,
              rate_currency text, rate_period text
            );
            "#,
        )
        .map_err(|error| format!("create legacy lookup tables: {error:?}"))?;

    let mainline_one = insert_change_set(client, revision_id, "mainline", "mainline", 1, Some(1))?;
    let draft = insert_change_set(client, revision_id, "draft", "draft", 2, None)?;
    let mainline_two = insert_change_set(client, revision_id, "mainline", "mainline", 3, Some(3))?;
    let tombstone = insert_change_set(client, revision_id, "mainline", "mainline", 4, Some(4))?;
    let shared_record = Uuid::parse_str("10000000-0000-4000-8000-000000000001").unwrap();
    let shared_version = Uuid::parse_str("30000000-0000-4000-8000-000000000001").unwrap();
    client
        .execute(
            "insert into category_record values ($1, 'migration_app', 'tenant_a', 'operations', '2026-01-01T00:00:00Z')",
            &[&shared_record],
        )
        .map_err(|error| format!("seed category record: {error:?}"))?;
    client
        .execute(
            r#"
            insert into category_version (
              id, record_id, app_id, customer_id, stage, effective_start,
              change_set_id, created_at, applied_at, provenance, name
            ) values ($1, $2, 'migration_app', 'tenant_a', 'mainline',
              '2026-01-01', $3, '2026-01-01T00:00:00Z',
              '2026-01-01T00:00:00Z', '{"source":"legacy"}', 'Operations')
            "#,
            &[&shared_version, &shared_record, &mainline_one],
        )
        .map_err(|error| format!("seed category version: {error:?}"))?;

    client
        .execute(
            "insert into department_record values ($1, 'migration_app', 'tenant_a', 'engineering', '2026-01-02T00:00:00Z')",
            &[&shared_record],
        )
        .map_err(|error| format!("seed department record: {error:?}"))?;
    let main_version = shared_version;
    let draft_version = Uuid::parse_str("30000000-0000-4000-8000-000000000002").unwrap();
    let reverted_version = Uuid::parse_str("30000000-0000-4000-8000-000000000003").unwrap();
    let tombstone_version = Uuid::parse_str("30000000-0000-4000-8000-000000000004").unwrap();
    client
        .execute(
            r#"
            insert into department_version (
              id, record_id, app_id, customer_id, stage, effective_start,
              effective_end, change_set_id, created_at, applied_at, provenance,
              custom_fields, metadata, many_relations, name, category, aliases,
              rate_amount, rate_currency, rate_period
            ) values ($1, $2, 'migration_app', 'tenant_a', 'mainline',
              '2026-01-02', '2026-07-31', $3, '2026-01-02T00:00:00Z',
              '2026-01-02T00:00:00Z', '{"source":"legacy","row":1}',
              '[{"field_id":"legacy_note","type":"text","value":"preserve"}]',
              '{}', $4, 'Engineering', $2,
              array['Eng', 'ENG'], 125.25, 'USD', 'hourly')
            "#,
            &[
                &main_version,
                &shared_record,
                &mainline_one,
                &json!({"peers": [shared_record.to_string()]}),
            ],
        )
        .map_err(|error| format!("seed mainline department version: {error:?}"))?;
    client
        .execute(
            r#"
            insert into department_version (
              id, record_id, app_id, customer_id, stage, effective_start,
              change_set_id, created_at, provenance, name, category
            ) values ($1, $2, 'migration_app', 'tenant_a', 'draft',
              '2026-08-01', $3, '2026-07-01T00:00:00Z',
              '{"source":"draft"}', 'Engineering draft', $2)
            "#,
            &[&draft_version, &shared_record, &draft],
        )
        .map_err(|error| format!("seed draft department version: {error:?}"))?;
    client
        .execute(
            r#"
            insert into department_version (
              id, record_id, app_id, customer_id, stage, effective_start,
              change_set_id, created_at, provenance, name, category
            ) values ($1, $2, 'migration_app', 'tenant_a', 'reverted',
              '2026-08-01', $3, '2026-07-02T00:00:00Z',
              '{"source":"revert"}', 'Engineering reverted', $2)
            "#,
            &[&reverted_version, &shared_record, &mainline_two],
        )
        .map_err(|error| format!("seed reverted department version: {error:?}"))?;
    client
        .execute(
            r#"
            insert into department_version (
              id, record_id, app_id, customer_id, stage, effective_start,
              change_set_id, created_at, applied_at, tombstones_record
            ) values ($1, $2, 'migration_app', 'tenant_a', 'mainline',
              '2026-08-01', $3, '2026-08-01T00:00:00Z',
              '2026-08-01T00:00:00Z', true)
            "#,
            &[&tombstone_version, &shared_record, &tombstone],
        )
        .map_err(|error| format!("seed tombstone department version: {error:?}"))?;
    Ok(revision_id)
}

fn insert_change_set(
    client: &mut Client,
    revision_id: i64,
    created_mode: &str,
    status: &str,
    created_order: i64,
    applied_order: Option<i64>,
) -> Result<i64, String> {
    client
        .query_one(
            r#"
            insert into change_set (
              app_id, customer_id, schema_revision_id, created_with_mode, status,
              source_kind, created_order, applied_order, applied_at
            ) values ('migration_app', 'tenant_a', $1, $2, $3, 'migration-test',
              $4, $5, case when $5::bigint is null then null else now() end)
            returning id
            "#,
            &[
                &revision_id,
                &created_mode,
                &status,
                &created_order,
                &applied_order,
            ],
        )
        .map(|row| row.get(0))
        .map_err(|error| format!("insert change set: {error:?}"))
}

fn assert_migrated_history(client: &mut Client, late_record: Uuid) -> Result<(), String> {
    let legacy_evidence_retained: (bool, bool, bool, bool) = client
        .query_one(
            "select to_regclass('category_record') is not null, to_regclass('category_version') is not null, to_regclass('department_record') is not null, to_regclass('department_version') is not null",
            &[],
        )
        .map(|row| (row.get(0), row.get(1), row.get(2), row.get(3)))
        .map_err(|error| format!("inspect retained legacy evidence: {error:?}"))?;
    assert_eq!(legacy_evidence_retained, (true, true, true, true));
    let counts: (i64, i64, i64, i64) = client
        .query_one(
            r#"
            select
              (select count(*) from lookup_record where model_id = 'category'),
              (select count(*) from lookup_record where model_id = 'department'),
              (select count(*) from lookup_version where model_id = 'department'),
              (select count(*) from lookup_version where model_id = 'department' and stage in ('draft', 'reverted') or model_id = 'department' and tombstones_record)
            "#,
            &[],
        )
        .map(|row| (row.get(0), row.get(1), row.get(2), row.get(3)))
        .map_err(|error| format!("read migrated counts: {error:?}"))?;
    assert_eq!(counts, (2, 1, 4, 3));
    let shared_version = Uuid::parse_str("30000000-0000-4000-8000-000000000001").unwrap();
    let colliding_versions: Vec<(String, String)> = client
        .query(
            r#"
            select model_id, values #>> '{name,value}'
            from lookup_version
            where app_id = 'migration_app' and customer_id = 'tenant_a' and id = $1
            order by model_id
            "#,
            &[&shared_version],
        )
        .map_err(|error| format!("read colliding lookup versions: {error:?}"))?
        .into_iter()
        .map(|row| (row.get(0), row.get(1)))
        .collect();
    assert_eq!(
        colliding_versions,
        vec![
            ("category".to_string(), "Operations".to_string()),
            ("department".to_string(), "Engineering".to_string()),
        ]
    );
    let colliding_value_projections: Vec<(String, String)> = client
        .query(
            r#"
            select model_id, text_value
            from lookup_value_projection
            where app_id = 'migration_app' and customer_id = 'tenant_a'
              and version_id = $1 and field_id = 'name'
            order by model_id
            "#,
            &[&shared_version],
        )
        .map_err(|error| format!("read colliding value projections: {error:?}"))?
        .into_iter()
        .map(|row| (row.get(0), row.get(1)))
        .collect();
    assert_eq!(colliding_value_projections, colliding_versions);
    let colliding_alias_projections: Vec<(String, String)> = client
        .query(
            r#"
            select model_id, alias
            from lookup_alias_projection
            where app_id = 'migration_app' and customer_id = 'tenant_a'
              and version_id = $1 and kind = 'display'
            order by model_id
            "#,
            &[&shared_version],
        )
        .map_err(|error| format!("read colliding alias projections: {error:?}"))?
        .into_iter()
        .map(|row| (row.get(0), row.get(1)))
        .collect();
    assert_eq!(colliding_alias_projections, colliding_versions);
    let colliding_relation_projection: i64 = client
        .query_one(
            r#"
            select count(*)
            from lookup_relation_projection
            where app_id = 'migration_app' and customer_id = 'tenant_a'
              and source_model_id = 'department' and version_id = $1
              and field_id = 'category' and target_model_id = 'category'
              and target_record_id = '10000000-0000-4000-8000-000000000001'
            "#,
            &[&shared_version],
        )
        .map_err(|error| format!("read colliding relation projection: {error:?}"))?
        .get(0);
    assert_eq!(colliding_relation_projection, 1);
    let late_exists: bool = client
        .query_one(
            "select exists(select 1 from lookup_record where model_id = 'category' and id = $1)",
            &[&late_record],
        )
        .map_err(|error| format!("read late migrated record: {error:?}"))?
        .get(0);
    assert!(late_exists);
    let preserved: (Value, Value, Value, Value, String) = client
        .query_one(
            r#"
            select custom_fields, metadata, many_relations, provenance,
              values #>> '{rate,value,amount}'
            from lookup_version
            where model_id = 'department' and stage = 'mainline'
              and not tombstones_record
            "#,
            &[],
        )
        .map(|row| (row.get(0), row.get(1), row.get(2), row.get(3), row.get(4)))
        .map_err(|error| format!("read preserved lookup snapshot: {error:?}"))?;
    assert_eq!(
        preserved.0,
        json!([{"field_id":"legacy_note","type":"text","value":"preserve"}])
    );
    assert_eq!(preserved.1, json!({}));
    assert_eq!(
        preserved.2,
        json!({"peers": ["10000000-0000-4000-8000-000000000001"]})
    );
    assert_eq!(preserved.3, json!({"source": "legacy", "row": 1}));
    assert_eq!(preserved.4, "125.25");
    let relation_projection: i64 = client
        .query_one(
            "select count(*) from lookup_relation_projection where source_model_id = 'department' and target_model_id = 'category' and target_record_id = '10000000-0000-4000-8000-000000000001'",
            &[],
        )
        .map_err(|error| format!("read migrated relation projection: {error:?}"))?
        .get(0);
    assert_eq!(relation_projection, 3);

    let category_list = call(
        client,
        "kernel_lookup_list",
        json!({
            "app_id": "migration_app",
            "customer_id": "tenant_a",
            "model_id": "category",
            "as_of": "2026-06-01",
            "query": "Operations"
        }),
    )?;
    assert_eq!(
        category_list["ok"], true,
        "category lookup failed: {category_list}"
    );
    assert_eq!(category_list["data"].as_array().map(Vec::len), Some(1));
    assert_eq!(category_list["data"][0]["label"], "Operations");
    let department_list = call(
        client,
        "kernel_lookup_list",
        json!({
            "app_id": "migration_app",
            "customer_id": "tenant_a",
            "model_id": "department",
            "as_of": "2026-06-01",
            "query": "Engineering"
        }),
    )?;
    assert_eq!(
        department_list["ok"], true,
        "department lookup failed: {department_list}"
    );
    assert_eq!(department_list["data"].as_array().map(Vec::len), Some(1));
    assert_eq!(department_list["data"][0]["label"], "Engineering");
    let cross_model_alias = call(
        client,
        "kernel_lookup_list",
        json!({
            "app_id": "migration_app",
            "customer_id": "tenant_a",
            "model_id": "department",
            "as_of": "2026-06-01",
            "query": "Operations"
        }),
    )?;
    assert_eq!(cross_model_alias["ok"], true);
    assert_eq!(cross_model_alias["data"], json!([]));
    Ok(())
}

fn prepare_until_ready(client: &mut Client, request: Value) -> Result<Value, String> {
    for _ in 0..100 {
        let result = call(client, "kernel_prepare_lookup_migration", request.clone())?;
        if result["ok"] != true || result["data"]["ready"] == true {
            return Ok(result);
        }
    }
    Err("lookup migration did not become ready".to_string())
}

fn without_batch_size(request: &Value) -> Value {
    let mut request = request.clone();
    request.as_object_mut().unwrap().remove("batch_size");
    request
}

fn migration_sql() -> String {
    let source = include_str!("../src/sql_runtime/lookup_migration.rs");
    let mut remaining = source;
    let mut sql = String::new();
    while let Some(constant_start) = remaining.find("const ") {
        remaining = &remaining[constant_start..];
        let Some(value_start) = remaining.find("= r#\"") else {
            remaining = &remaining[6..];
            continue;
        };
        remaining = &remaining[value_start + 5..];
        let value_end = remaining.find("\"#;").expect("SQL constant terminator");
        sql.push_str(&remaining[..value_end]);
        sql.push_str(";\n");
        remaining = &remaining[value_end + 3..];
    }
    sql
}

fn set_scope(client: &mut Client) -> Result<(), String> {
    client
        .query_one(
            "select set_config('kernel.app_id', 'migration_app', false), set_config('kernel.customer_id', 'tenant_a', false)",
            &[],
        )
        .map(|_| ())
        .map_err(|error| format!("set tenant scope: {error:?}"))
}

fn call(client: &mut Client, function: &str, request: Value) -> Result<Value, String> {
    client
        .query_one(&format!("select {function}($1::jsonb)"), &[&request])
        .map(|row| row.get(0))
        .map_err(|error| format!("call {function}: {error:?}"))
}

fn test_database_url() -> Option<String> {
    match env::var("KERNEL_TEST_DATABASE_URL") {
        Ok(value) if !value.trim().is_empty() => Some(value),
        Ok(_) | Err(env::VarError::NotPresent) => {
            eprintln!("skipping lookup migration SQL test: KERNEL_TEST_DATABASE_URL is absent");
            None
        }
        Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
    }
}
