use std::env;

use kernel::connect_postgres;
use postgres::error::SqlState;
use schema_compiler::{
    compile_sql_artifact_manifest, CompiledManifest, NormalizedManifestExtras, SqlArtifactKind,
};
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
#[allow(dead_code)]
#[path = "../src/sql_runtime/installer.rs"]
mod installer;
#[allow(dead_code)]
#[path = "../src/sql_runtime/lookup_migration.rs"]
mod lookup_migration;
#[allow(dead_code)]
#[path = "../src/sql_runtime/shared.rs"]
mod shared;
#[allow(dead_code)]
#[path = "../src/sql_runtime/tenant_schema.rs"]
mod tenant_schema;

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
"#;

#[test]
fn app_base_recomposition_preserves_tenant_schema_and_new_app_additions_on_pg17() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let (mut client, database_schema) = install_admin_overlay_runtime(&database_url);
    let result = (|| {
        let effective: Value = client
            .query_one(
                "select kernel_admin_apply_overlay($1::jsonb, $2::jsonb)",
                &[&next_base(), &tenant_overlay()],
            )
            .map_err(|error| format!("recompose tenant schema: {error:?}"))?
            .get(0);

        assert_eq!(
            ids(&effective["models"]),
            ["company", "country", "department", "lookup_tenant_team"]
        );
        let country = by_id(&effective["models"], "country");
        assert_eq!(country["label"], "Tenant Countries");
        assert_eq!(country["lifecycle"], "retired");
        assert_eq!(
            ids(&country["fields"]),
            ["name", "code", "status", "iso_code", "local_code"]
        );
        let code = by_id(&country["fields"], "code");
        assert_eq!(code["label"], "Code v2");
        assert_eq!(code["required"], true);
        assert_eq!(code["is_unique"], false);
        assert_eq!(code["management"], "tenant_managed");
        assert_eq!(
            by_id(&country["fields"], "status")["label"],
            "Lifecycle status"
        );
        let status = by_id(&country["fields"], "status");
        assert_eq!(
            ids(&status["option_set"]),
            ["active", "pending", "tenant_custom"]
        );
        let active = by_id(&status["option_set"], "active");
        assert_eq!(active["label"], "Enabled");
        assert_eq!(active["aliases"], json!(["current"]));
        assert_eq!(active["lifecycle"], "retired");
        assert_eq!(by_id(&status["option_set"], "pending")["label"], "Pending");
        assert_eq!(
            by_id(&status["option_set"], "tenant_custom")["origin"],
            "tenant"
        );
        assert_eq!(
            by_id(&effective["models"], "department")["label"],
            "Department"
        );
        assert_eq!(
            by_id(&effective["models"], "lookup_tenant_team")["origin"],
            "tenant"
        );
        assert_eq!(
            by_id(&effective["models"], "lookup_tenant_team")["lifecycle"],
            "retired"
        );
        assert_eq!(
            by_id(&country["fields"], "local_code")["lifecycle"],
            "retired"
        );

        assert_eq!(
            ids(&effective["custom_fields"]),
            ["app_color", "app_new", "tenant_notes"]
        );
        let app_color = by_id(&effective["custom_fields"], "app_color");
        assert_eq!(ids(&app_color["option_set"]), ["red", "blue", "green"]);
        assert_eq!(
            by_id(&app_color["option_set"], "red")["lifecycle"],
            "retired"
        );
        assert_eq!(by_id(&app_color["option_set"], "blue")["origin"], "app");
        assert_eq!(by_id(&app_color["option_set"], "green")["origin"], "tenant");
        assert_eq!(
            by_id(&effective["custom_fields"], "tenant_notes")["origin"],
            "tenant"
        );
        assert_eq!(
            by_id(&effective["custom_fields"], "tenant_notes")["lifecycle"],
            "retired"
        );
        assert_eq!(
            by_id(&effective["custom_fields"], "tenant_notes")["archived_at"],
            "2026-08-05T13:00:00Z"
        );

        let mut inherit_app_label = tenant_overlay();
        inherit_app_label["tenant_schema"]["change_paths"]
            .as_array_mut()
            .expect("change paths")
            .retain(|path| path != "models.country.label");
        let inherited = apply_overlay(&mut client, &next_base(), &inherit_app_label)?;
        assert_eq!(
            by_id(&inherited["models"], "country")["label"],
            "Countries v2",
            "untouched tenant-manageable labels inherit the new app default"
        );
        let round_trip_catalog: Value = client
            .query_one(
                "select kernel_tenant_schema_catalog($1::jsonb, $2::jsonb)",
                &[&effective, &tenant_overlay()],
            )
            .map_err(|error| format!("round-trip recomposed catalog: {error:?}"))?
            .get(0);
        let round_trip_country = by_id(&round_trip_catalog["models"], "country");
        assert_eq!(
            by_id(&round_trip_country["fields"], "code")["label"],
            "Code v2"
        );
        assert!(by_id(&round_trip_country["fields"], "iso_code").is_object());
        assert_eq!(
            ids::<3>(&by_id(&round_trip_country["fields"], "status")["option_set"]),
            ["active", "pending", "tenant_custom"]
        );
        assert_eq!(
            by_id(&round_trip_catalog["custom_fields"], "tenant_notes")["archived_at"],
            "2026-08-05T13:00:00Z",
            "retired custom-field archive time survives effective-schema catalog round trips"
        );
        Ok::<_, String>(())
    })();
    drop_schema(&mut client, &database_schema);
    result.expect("tenant schema app-base recomposition");
}

#[test]
fn app_base_recomposition_fails_closed_for_incompatible_changes_on_pg17() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let (mut client, database_schema) = install_admin_overlay_runtime(&database_url);
    let result = (|| {
        let mut changed_type = next_base();
        by_id_mut(&mut changed_type["models"], "country")["fields"][2]["type"] = json!("text");
        assert_rebase_conflict(
            &mut client,
            changed_type,
            "immutable_field_contract_changed",
        )?;

        let mut removed_field = next_base();
        by_id_mut(&mut removed_field["models"], "country")["fields"]
            .as_array_mut()
            .expect("fields")
            .retain(|field| field["id"] != "name");
        assert_rebase_conflict(&mut client, removed_field, "app_field_removed")?;

        let mut alias_collision = next_base();
        by_id_mut(&mut alias_collision["models"], "country")["fields"][2]["option_set"][1]
            ["label"] = json!("Current");
        assert_rebase_conflict(&mut client, alias_collision, "enum_option_rebase_collision")?;

        let mut model_collision = next_base();
        model_collision["models"]
            .as_array_mut()
            .expect("models")
            .push(json!({
                "id": "lookup_tenant_team",
                "kind": "lookup",
                "label": "App Team",
                "display_field_id": "name",
                "origin": "app",
                "management": "fixed",
                "lifecycle": "active",
                "extensions": {},
                "fields": [field("name", "Name", "text", true, false, "fixed")],
                "many_relations": []
            }));
        assert_rebase_conflict(&mut client, model_collision, "model_id_collision")?;

        let mut custom_fields_disabled = next_base();
        by_id_mut(&mut custom_fields_disabled["models"], "company")["extensions"] = json!({});
        assert_rebase_conflict(
            &mut client,
            custom_fields_disabled,
            "custom_fields_not_enabled",
        )?;

        let mut explicit_management_revoked = next_base();
        by_id_mut(
            &mut by_id_mut(&mut explicit_management_revoked["models"], "country")["fields"],
            "name",
        )["management"] = json!("fixed");
        assert_rebase_conflict(
            &mut client,
            explicit_management_revoked,
            "tenant_management_revoked",
        )?;

        let mut legacy = tenant_overlay();
        legacy["tenant_schema"]
            .as_object_mut()
            .expect("tenant schema")
            .remove("provenance_version");
        legacy["tenant_schema"]
            .as_object_mut()
            .expect("tenant schema")
            .remove("change_paths");
        assert_overlay_conflict(
            &mut client,
            next_base(),
            legacy,
            "legacy_tenant_overlay_requires_provenance",
        )?;
        Ok::<_, String>(())
    })();
    drop_schema(&mut client, &database_schema);
    result.expect("incompatible app-base recomposition checks");
}

#[test]
fn app_base_recomposition_leaves_custom_field_collisions_to_readiness_on_pg17() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let (mut client, database_schema) = install_admin_overlay_runtime(&database_url);
    let result = (|| {
        let mut declared_notes = next_base();
        by_id_mut(&mut declared_notes["models"], "company")["fields"]
            .as_array_mut()
            .expect("fields")
            .push(field("notes", "Notes", "text", false, false, "fixed"));

        // A retired tenant field keeps its id reserved but never collides, so
        // a release that declares that id recomposes cleanly.
        let retired = apply_overlay(&mut client, &declared_notes, &tenant_overlay())?;
        assert_eq!(
            collision_codes(&mut client, &retired, &json!({}))?,
            Vec::<String>::new()
        );

        // An active one recomposes too: recomposition also replays the active
        // overlay on its own base, so it must never fail on a collision.
        // Readiness rejects only a collision the active revision lacked.
        let mut active_notes = tenant_overlay();
        let notes = &mut active_notes["tenant_schema"]["custom_fields"][0];
        notes["lifecycle"] = json!("active");
        notes
            .as_object_mut()
            .expect("custom field")
            .remove("archived_at");
        let before = apply_overlay(&mut client, &next_base(), &active_notes)?;
        let after = apply_overlay(&mut client, &declared_notes, &active_notes)?;
        assert_eq!(
            collision_codes(&mut client, &after, &before)?,
            vec!["custom_field_declared_field_collision".to_string()]
        );
        assert_eq!(
            collision_codes(&mut client, &after, &after)?,
            Vec::<String>::new()
        );
        Ok::<_, String>(())
    })();
    drop_schema(&mut client, &database_schema);
    result.expect("custom-field collision recomposition checks");
}

fn collision_codes(
    client: &mut postgres::Client,
    schema: &Value,
    prior_schema: &Value,
) -> Result<Vec<String>, String> {
    let issues: Value = client
        .query_one(
            "select kernel_admin_custom_field_collision_issues($1::jsonb, $2::jsonb)",
            &[schema, prior_schema],
        )
        .map(|row| row.get(0))
        .map_err(|error| format!("collision issues: {error:?}"))?;
    Ok(issues
        .as_array()
        .expect("issues")
        .iter()
        .map(|issue| issue["code"].as_str().expect("code").to_string())
        .collect())
}

#[test]
fn tenant_override_provenance_is_explicit_sorted_and_deterministic_on_pg17() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let (mut client, database_schema) = install_admin_overlay_runtime(&database_url);
    let result = (|| {
        let mut models = next_base()["models"].as_array().expect("models").clone();
        models.extend(
            tenant_overlay()["tenant_schema"]["models"]
                .as_array()
                .expect("tenant models")
                .clone(),
        );
        let mut custom_fields = next_base()["custom_fields"]
            .as_array()
            .expect("custom fields")
            .clone();
        custom_fields.extend(
            tenant_overlay()["tenant_schema"]["custom_fields"]
                .as_array()
                .expect("tenant custom fields")
                .clone(),
        );
        let catalog = json!({"models": models, "custom_fields": custom_fields});
        let operations = json!([
            {"type": "update_model", "model_id": "country", "label": "Tenant country"},
            {"type": "update_field", "model_id": "country", "field_id": "code", "required": true},
            {"type": "retire_custom_field", "definition_id": "app_color"},
            {"type": "update_enum_option", "model_id": "country", "field_id": "status", "option_id": "active", "aliases": ["enabled"]}
        ]);
        let first: Value = client
            .query_one(
                "select kernel_tenant_schema_overlay('{}'::jsonb, $1::jsonb, $2::jsonb)",
                &[&catalog, &operations],
            )
            .map_err(|error| format!("persist provenance: {error:?}"))?
            .get(0);
        assert_eq!(first["tenant_schema"]["provenance_version"], 1);
        assert_eq!(
            first["tenant_schema"]["change_paths"],
            json!([
                "custom_fields.app_color.lifecycle",
                "models.country.fields.code.required",
                "models.country.fields.status.options.active.aliases",
                "models.country.label"
            ])
        );
        let second: Value = client
            .query_one(
                "select kernel_tenant_schema_overlay($1::jsonb, $2::jsonb, $3::jsonb)",
                &[&first, &catalog, &operations],
            )
            .map_err(|error| format!("replay provenance: {error:?}"))?
            .get(0);
        assert_eq!(second, first, "provenance replay must be byte-stable JSON");
        Ok::<_, String>(())
    })();
    drop_schema(&mut client, &database_schema);
    result.expect("tenant override provenance persistence");
}

#[test]
fn tenant_schema_mutation_racing_rebased_app_activation_loses_expected_hash_cas_on_pg17() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let (mut client, database_schema) = install_admin_overlay_runtime(&database_url);
    let result = (|| {
        client
            .batch_execute(SCHEMA_REVISION_SUBSTRATE)
            .map_err(|error| format!("install schema revision substrate: {error:?}"))?;
        client
            .batch_execute(installer::substrate_sql())
            .map_err(|error| format!("install installer substrate: {error:?}"))?;
        for function in authorization::functions() {
            client
                .batch_execute(&function.sql)
                .map_err(|error| format!("install {}: {error:?}", function.signature))?;
        }
        for function in installer::functions() {
            client
                .batch_execute(&function.sql)
                .map_err(|error| format!("install {}: {error:?}", function.signature))?;
        }
        let lookup_substrate = lookup_migration::functions()
            .into_iter()
            .find(|function| function.signature == "kernel_lookup_migration_error(text,text,text)")
            .expect("missing generated lookup migration substrate");
        client
            .batch_execute(&lookup_substrate.sql)
            .map_err(|error| format!("install lookup migration substrate: {error:?}"))?;

        let base_v1 = previous_base();
        let overlay_v1 = tenant_overlay();
        let effective_v1 = apply_overlay(&mut client, &base_v1, &overlay_v1)?;
        let baseline = prepare_revision(
            &mut client,
            "baseline",
            "tenant_overlay",
            &base_v1,
            &overlay_v1,
            &effective_v1,
            hash('a'),
            None,
        )?;
        let baseline_id = prepared_id(&baseline)?;
        assert_ok(&ready_revision(&mut client, baseline_id, hash('a'))?)?;
        assert_ok(&activate_tenant_revision(
            &mut client,
            baseline_id,
            hash('a'),
            None,
        )?)?;

        let base_v2 = next_base();
        let effective_v2 = apply_overlay(&mut client, &base_v2, &overlay_v1)?;
        let app_candidate = prepare_revision(
            &mut client,
            "app-v2",
            "app_base",
            &base_v2,
            &overlay_v1,
            &effective_v2,
            hash('b'),
            Some(hash('a')),
        )?;
        let app_candidate_id = prepared_id(&app_candidate)?;
        assert_ok(&ready_revision(&mut client, app_candidate_id, hash('b'))?)?;

        let mut overlay_v1_race = overlay_v1.clone();
        by_id_mut(
            &mut overlay_v1_race["tenant_schema"]["model_overrides"],
            "country",
        )["label"] = json!("Countries edited during release");
        let mut effective_v1_race = apply_overlay(&mut client, &base_v1, &overlay_v1_race)?;
        effective_v1_race["version"] = json!("2026-08-05.v1+r2");
        let tenant_candidate = prepare_revision(
            &mut client,
            "tenant-race",
            "tenant_overlay",
            &base_v1,
            &overlay_v1_race,
            &effective_v1_race,
            hash('c'),
            Some(hash('a')),
        )?;
        let tenant_candidate_id = prepared_id(&tenant_candidate)?;
        assert_ok(&ready_revision(
            &mut client,
            tenant_candidate_id,
            hash('c'),
        )?)?;
        assert_ok(&activate_tenant_revision(
            &mut client,
            tenant_candidate_id,
            hash('c'),
            Some(hash('a')),
        )?)?;

        let app_activation = call_json(
            &mut client,
            "kernel_activate_app_base_schema_revision",
            json!({
                "app_id": "admin_recompose_app",
                "release_id": "app-v2",
                "base_artifact_hash": hash('0'),
                "targets": [{
                    "customer_id": "tenant_a",
                    "schema_revision_id": app_candidate_id,
                    "effective_artifact_hash": hash('b'),
                    "expected_active_effective_hash": hash('a')
                }]
            }),
        )?;
        assert_eq!(
            app_activation["ok"], false,
            "stale app activation succeeded"
        );
        assert_eq!(
            app_activation["error"]["details"][0]["code"],
            "expected_hash_mismatch"
        );
        let active: (i64, String) = client
            .query_one(
                r#"
                select revision.id, installation.effective_artifact_hash
                from schema_revision revision
                join schema_installation_revision installation
                  on installation.schema_revision_id = revision.id
                where revision.app_id = 'admin_recompose_app'
                  and revision.customer_id = 'tenant_a'
                  and revision.activated_at is not null
                "#,
                &[],
            )
            .map(|row| (row.get(0), row.get(1)))
            .map_err(|error| format!("read active revision after CAS loss: {error:?}"))?;
        assert_eq!(active, (tenant_candidate_id, hash('c')));
        Ok::<_, String>(())
    })();
    drop_schema(&mut client, &database_schema);
    result.expect("app-base and tenant schema activation race");
}

fn previous_base() -> Value {
    let mut base = next_base();
    base["version"] = json!("2026-08-05.v1");
    base["models"]
        .as_array_mut()
        .expect("models")
        .retain(|model| model["id"] != "department");
    let country = by_id_mut(&mut base["models"], "country");
    country["label"] = json!("Countries");
    country["fields"]
        .as_array_mut()
        .expect("fields")
        .retain(|field| field["id"] != "iso_code");
    by_id_mut(&mut country["fields"], "status")["option_set"]
        .as_array_mut()
        .expect("options")
        .retain(|option| option["id"] != "pending");
    base["custom_fields"]
        .as_array_mut()
        .expect("custom fields")
        .retain(|field| field["id"] != "app_new");
    base
}

fn next_base() -> Value {
    json!({
        "app_id": "admin_recompose_app",
        "customer_id": "tenant_a",
        "version": "2026-08-05.v2",
        "models": [
            {
                "id": "company", "kind": "entity", "label": "Company",
                "origin": "app", "management": "fixed", "lifecycle": "active",
                "extensions": {"typed_custom_fields": true},
                "fields": [field("name", "Name", "text", true, true, "fixed")],
                "many_relations": []
            },
            {
                "id": "country", "kind": "lookup", "label": "Countries v2",
                "display_field_id": "name", "origin": "app",
                "management": "tenant_managed", "lifecycle": "active", "extensions": {},
                "fields": [
                    field("name", "Name v2", "text", true, false, "tenant_managed"),
                    field("code", "Code v2", "text", false, false, "tenant_managed"),
                    enum_field("status", "Lifecycle status", [
                        option("active", "Active v2", ["enabled"], "tenant_managed"),
                        option("pending", "Pending", [], "tenant_managed")
                    ]),
                    field("iso_code", "ISO code", "text", false, false, "fixed")
                ],
                "many_relations": []
            },
            {
                "id": "department", "kind": "lookup", "label": "Department",
                "display_field_id": "name", "origin": "app", "management": "fixed",
                "lifecycle": "active", "extensions": {},
                "fields": [field("name", "Name", "text", true, false, "fixed")],
                "many_relations": []
            }
        ],
        "custom_fields": [
            custom_enum("app_color", "company", "color", "Color v2", [
                option("red", "Red v2", [], "tenant_managed"),
                option("blue", "Blue", [], "tenant_managed")
            ], "app"),
            {
                "id": "app_new", "model_id": "company", "field_id": "new_field",
                "label": "New field", "type": "text", "target_model_id": null,
                "option_set": [], "origin": "app", "management": "fixed", "lifecycle": "active"
            }
        ],
        "change_types": []
    })
}

fn tenant_overlay() -> Value {
    json!({
        "tenant_schema": {
            "provenance_version": 1,
            "change_paths": [
                "custom_fields.app_color.label",
                "custom_fields.app_color.options.red.aliases",
                "custom_fields.app_color.options.red.label",
                "custom_fields.app_color.options.red.lifecycle",
                "models.country.fields.code.required",
                "models.country.fields.name.label",
                "models.country.fields.status.options.active.aliases",
                "models.country.fields.status.options.active.label",
                "models.country.fields.status.options.active.lifecycle",
                "models.country.label",
                "models.country.lifecycle"
            ],
            "models": [{
                "id": "lookup_tenant_team", "kind": "lookup", "label": "Team",
                "display_field_id": "name", "origin": "tenant", "management": "tenant_managed",
                "lifecycle": "retired", "retired_at": "2026-08-05T12:30:00Z", "extensions": {},
                "fields": [field("name", "Name", "text", true, false, "tenant_managed")],
                "many_relations": [{
                    "id": "countries", "label": "Countries", "target_model": "country",
                    "origin": "tenant", "management": "tenant_managed", "lifecycle": "active"
                }]
            }],
            "model_overrides": [{
                "id": "country", "kind": "lookup", "label": "Tenant Countries",
                "display_field_id": "name", "origin": "app", "management": "tenant_managed",
                "lifecycle": "retired", "retired_at": "2026-08-05T12:15:00Z", "extensions": {},
                "fields": [
                    field("name", "Local Name", "text", true, false, "tenant_managed"),
                    field("code", "Code", "text", true, true, "tenant_managed"),
                    enum_field("status", "Status", [
                        retired_option("active", "Enabled", ["current"], "app"),
                        option_with_origin("tenant_custom", "Custom", [], "tenant_managed", "tenant")
                    ]),
                    retired_field("local_code", "Local code", "text")
                ],
                "many_relations": []
            }],
            "custom_fields": [{
                "id": "tenant_notes", "model_id": "company", "field_id": "notes",
                "label": "Notes", "type": "text", "target_model_id": null, "option_set": [],
                "origin": "tenant", "management": "tenant_managed", "lifecycle": "retired",
                "archived_at": "2026-08-05T13:00:00Z"
            }],
            "custom_field_overrides": [custom_enum("app_color", "company", "color", "Tenant Color", [
                retired_option("red", "Rouge", ["red"], "app"),
                option_with_origin("green", "Green", [], "tenant_managed", "tenant")
            ], "app")]
        }
    })
}

fn field(
    id: &str,
    label: &str,
    field_type: &str,
    required: bool,
    unique: bool,
    management: &str,
) -> Value {
    field_with_origin(id, label, field_type, required, unique, management, "app")
}

fn field_with_origin(
    id: &str,
    label: &str,
    field_type: &str,
    required: bool,
    unique: bool,
    management: &str,
    origin: &str,
) -> Value {
    json!({
        "id": id, "label": label, "type": field_type, "required": required,
        "is_unique": unique, "target_model": null, "option_set": [],
        "origin": origin, "management": management, "lifecycle": "active"
    })
}

fn retired_field(id: &str, label: &str, field_type: &str) -> Value {
    let mut field = field_with_origin(
        id,
        label,
        field_type,
        false,
        false,
        "tenant_managed",
        "tenant",
    );
    field["lifecycle"] = json!("retired");
    field["retired_at"] = json!("2026-08-05T12:45:00Z");
    field
}

fn enum_field<const N: usize>(id: &str, label: &str, options: [Value; N]) -> Value {
    let options = options.to_vec();
    json!({
        "id": id, "label": label, "type": "enum", "required": false,
        "is_unique": false, "target_model": null, "option_set": options,
        "origin": "app", "management": "tenant_managed", "lifecycle": "active"
    })
}

fn option<const N: usize>(id: &str, label: &str, aliases: [&str; N], management: &str) -> Value {
    option_with_origin(id, label, aliases, management, "app")
}

fn option_with_origin<const N: usize>(
    id: &str,
    label: &str,
    aliases: [&str; N],
    management: &str,
    origin: &str,
) -> Value {
    let aliases = aliases.to_vec();
    json!({
        "id": id, "label": label, "aliases": aliases, "origin": origin,
        "management": management, "lifecycle": "active"
    })
}

fn retired_option<const N: usize>(
    id: &str,
    label: &str,
    aliases: [&str; N],
    origin: &str,
) -> Value {
    let aliases = aliases.to_vec();
    json!({
        "id": id, "label": label, "aliases": aliases, "origin": origin,
        "management": "tenant_managed", "lifecycle": "retired",
        "retired_at": "2026-08-05T12:00:00Z"
    })
}

fn custom_enum<const N: usize>(
    id: &str,
    model_id: &str,
    field_id: &str,
    label: &str,
    options: [Value; N],
    origin: &str,
) -> Value {
    let options = options.to_vec();
    json!({
        "id": id, "model_id": model_id, "field_id": field_id, "label": label,
        "type": "enum", "target_model_id": null, "option_set": options,
        "origin": origin, "management": "tenant_managed", "lifecycle": "active"
    })
}

fn install_admin_overlay_runtime(database_url: &str) -> (postgres::Client, String) {
    let mut client = connect_postgres(database_url).expect("connect to PostgreSQL");
    let version: i32 = client
        .query_one("show server_version_num", &[])
        .expect("read PostgreSQL version")
        .get::<_, String>(0)
        .parse()
        .expect("parse PostgreSQL version");
    assert!(
        version >= 170_000,
        "admin recomposition requires PostgreSQL 17"
    );
    let database_schema = format!("kernel_admin_recompose_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            "create schema \"{database_schema}\"; set search_path to \"{database_schema}\""
        ))
        .expect("create isolated admin recomposition schema");
    for signature in [
        "kernel_lookup_has_typed_history(text,text,text)",
        "kernel_physical_identifier(text)",
        "kernel_canonical_json(jsonb)",
    ] {
        let function = shared::functions()
            .into_iter()
            .find(|function| function.signature == signature)
            .unwrap_or_else(|| panic!("missing generated shared function {signature}"));
        client
            .batch_execute(&function.sql)
            .unwrap_or_else(|error| panic!("install {signature}: {error:?}"));
    }
    for signature in [
        "kernel_admin_error(text,text,jsonb)",
        "kernel_admin_validation_error(jsonb)",
        "kernel_admin_normalize_identifier(text)",
        "kernel_admin_sha256(text)",
        "kernel_admin_bounded_identifier(text)",
        "kernel_admin_enum_match_key(text)",
        "kernel_admin_validate_enum_options(jsonb,boolean)",
        "kernel_admin_custom_field_collision_issues(jsonb,jsonb)",
        "kernel_admin_apply_overlay(jsonb,jsonb)",
    ] {
        let function = admin::functions()
            .into_iter()
            .find(|function| function.signature == signature)
            .unwrap_or_else(|| panic!("missing generated admin function {signature}"));
        client
            .batch_execute(&function.sql)
            .unwrap_or_else(|error| panic!("install {signature}: {error:?}"));
    }
    // Installer readiness re-validates derived fields against effective schemas.
    for function in derived::functions() {
        client
            .batch_execute(&function.sql)
            .unwrap_or_else(|error| panic!("install {}: {error:?}", function.signature));
    }
    for signature in [
        "kernel_tenant_schema_strip_option(jsonb)",
        "kernel_tenant_schema_strip_field(jsonb)",
        "kernel_tenant_schema_strip_many_relation(jsonb)",
        "kernel_tenant_schema_strip_model(jsonb)",
        "kernel_tenant_schema_strip_custom_field(jsonb)",
        "kernel_tenant_schema_catalog(jsonb,jsonb)",
        "kernel_tenant_schema_overlay(jsonb,jsonb,jsonb)",
    ] {
        let function = tenant_schema::functions()
            .into_iter()
            .find(|function| function.signature == signature)
            .unwrap_or_else(|| panic!("missing tenant schema function {signature}"));
        client
            .batch_execute(&function.sql)
            .unwrap_or_else(|error| panic!("install {signature}: {error:?}"));
    }
    (client, database_schema)
}

#[allow(clippy::too_many_arguments)]
fn prepare_revision(
    client: &mut postgres::Client,
    release_id: &str,
    activation_kind: &str,
    base_schema: &Value,
    customer_overlay: &Value,
    effective_schema: &Value,
    effective_hash: String,
    expected_hash: Option<String>,
) -> Result<Value, String> {
    // This fixture installs runtime functions directly. Install the real compiler
    // catalog artifact too, as a normal release would before preparing revisions.
    let compiled = CompiledManifest {
        schema: serde_json::from_value(base_schema.clone())
            .map_err(|error| format!("decode base schema: {error}"))?,
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
    };
    let manifest = compile_sql_artifact_manifest(&compiled)
        .map_err(|error| format!("compile base catalog: {error}"))?;
    let catalog = manifest
        .artifacts
        .iter()
        .find(|artifact| artifact.kind == SqlArtifactKind::ConstraintCatalog)
        .ok_or_else(|| "compiler omitted constraint catalog".to_string())?;
    client
        .batch_execute(&catalog.sql)
        .map_err(|error| format!("install base catalog: {error:?}"))?;
    call_json(
        client,
        "kernel_prepare_schema_revision",
        json!({
            "app_id": "admin_recompose_app",
            "customer_id": "tenant_a",
            "version": effective_schema["version"],
            "release_id": release_id,
            "activation_kind": activation_kind,
            "schema_hash": hash('8'),
            "base_artifact_hash": hash('0'),
            "effective_artifact_hash": effective_hash,
            "materialization_plan_hash": hash('9'),
            "expected_active_effective_hash": expected_hash,
            "base_schema": base_schema,
            "customer_overlay": customer_overlay,
            "schema": effective_schema,
            "seed_change_sets": [],
            "phase_plan": []
        }),
    )
}

fn ready_revision(
    client: &mut postgres::Client,
    revision_id: i64,
    effective_hash: String,
) -> Result<Value, String> {
    call_json(
        client,
        "kernel_validate_schema_revision_readiness",
        json!({
            "app_id": "admin_recompose_app",
            "customer_id": "tenant_a",
            "schema_revision_id": revision_id,
            "effective_artifact_hash": effective_hash,
            "materialization_plan_hash": hash('9'),
            "phase_results": []
        }),
    )
}

fn activate_tenant_revision(
    client: &mut postgres::Client,
    revision_id: i64,
    effective_hash: String,
    expected_hash: Option<String>,
) -> Result<Value, String> {
    call_json(
        client,
        "kernel_activate_tenant_schema_revision",
        json!({
            "app_id": "admin_recompose_app",
            "customer_id": "tenant_a",
            "schema_revision_id": revision_id,
            "effective_artifact_hash": effective_hash,
            "expected_active_effective_hash": expected_hash
        }),
    )
}

fn apply_overlay(
    client: &mut postgres::Client,
    base_schema: &Value,
    customer_overlay: &Value,
) -> Result<Value, String> {
    client
        .query_one(
            "select kernel_admin_apply_overlay($1::jsonb, $2::jsonb)",
            &[base_schema, customer_overlay],
        )
        .map(|row| row.get(0))
        .map_err(|error| format!("apply tenant overlay: {error:?}"))
}

fn call_json(
    client: &mut postgres::Client,
    function: &str,
    request: Value,
) -> Result<Value, String> {
    client
        .query_one(&format!("select {function}($1::jsonb)"), &[&request])
        .map(|row| row.get(0))
        .map_err(|error| format!("call {function}: {error:?}"))
}

fn prepared_id(result: &Value) -> Result<i64, String> {
    assert_ok(result)?;
    result["data"]["schema_revision_id"]
        .as_i64()
        .ok_or_else(|| format!("prepared revision id is absent: {result}"))
}

fn assert_ok(result: &Value) -> Result<(), String> {
    if result["ok"] == true {
        Ok(())
    } else {
        Err(format!("unexpected generated SQL error: {result}"))
    }
}

fn hash(character: char) -> String {
    character.to_string().repeat(64)
}

fn assert_rebase_conflict(
    client: &mut postgres::Client,
    next_base: Value,
    expected_detail_code: &str,
) -> Result<(), String> {
    assert_overlay_conflict(client, next_base, tenant_overlay(), expected_detail_code)
}

fn assert_overlay_conflict(
    client: &mut postgres::Client,
    next_base: Value,
    overlay: Value,
    expected_detail_code: &str,
) -> Result<(), String> {
    let error = client
        .query_one(
            "select kernel_admin_apply_overlay($1::jsonb, $2::jsonb)",
            &[&next_base, &overlay],
        )
        .expect_err("incompatible app base unexpectedly recomposed");
    if error.code() != Some(&SqlState::CHECK_VIOLATION) {
        return Err(format!(
            "unexpected SQLSTATE for rebase conflict: {error:?}"
        ));
    }
    let database_error = error.as_db_error().expect("database error");
    if database_error.message() != "tenant_schema_rebase_conflict"
        || !database_error
            .detail()
            .unwrap_or_default()
            .contains(expected_detail_code)
    {
        return Err(format!("unexpected rebase conflict: {database_error:?}"));
    }
    if expected_detail_code == "legacy_tenant_overlay_requires_provenance"
        && !database_error
            .hint()
            .unwrap_or_default()
            .contains("normal expected-hash CAS")
    {
        return Err(format!(
            "legacy migration conflict omitted the reviewed tenant-overlay migration path: {database_error:?}"
        ));
    }
    Ok(())
}

fn ids<const N: usize>(values: &Value) -> [&str; N] {
    let actual = values
        .as_array()
        .expect("array")
        .iter()
        .map(|value| value["id"].as_str().expect("id"))
        .collect::<Vec<_>>();
    actual
        .try_into()
        .unwrap_or_else(|actual: Vec<_>| panic!("expected {N} ids, got {actual:?}"))
}

fn by_id<'a>(values: &'a Value, id: &str) -> &'a Value {
    values
        .as_array()
        .expect("array")
        .iter()
        .find(|value| value["id"] == id)
        .unwrap_or_else(|| panic!("missing {id}"))
}

fn by_id_mut<'a>(values: &'a mut Value, id: &str) -> &'a mut Value {
    values
        .as_array_mut()
        .expect("array")
        .iter_mut()
        .find(|value| value["id"] == id)
        .unwrap_or_else(|| panic!("missing {id}"))
}

fn drop_schema(client: &mut postgres::Client, database_schema: &str) {
    client
        .batch_execute(&format!(
            "set search_path to public; drop schema if exists \"{database_schema}\" cascade"
        ))
        .expect("drop isolated admin recomposition schema");
}

fn test_database_url() -> Option<String> {
    match env::var("KERNEL_TEST_DATABASE_URL") {
        Ok(url) => Some(url),
        Err(env::VarError::NotPresent) => {
            eprintln!("skipping admin recomposition SQL test: KERNEL_TEST_DATABASE_URL is absent");
            None
        }
        Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
    }
}
