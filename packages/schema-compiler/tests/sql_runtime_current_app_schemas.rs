#[path = "support/trusted_human.rs"]
mod trusted_human;
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fmt;

use kernel::{
    connect_postgres, schema_hash, validate_schema, EntityExtensionCapabilities, FieldId,
    FieldType, FieldValue, ModelKind, RecordKey, Schema, SchemaElementLifecycle,
    SchemaElementOrigin, SchemaManagementPolicy,
};
use postgres::Client;
use schema_compiler::{
    compile_manifest, compile_sql_artifact_manifest, render_sql_artifact_bundle, AppManifest,
    CompiledAppArtifact, CompiledManifest, EnumOptionManifest, FieldManifest,
    InverseRelationManifest, ManifestFieldType, ManifestModelKind, ManyRelationManifest,
    ModelManifest, NormalizedManifestExtras, SqlArtifactKind,
};
use serde::de::{MapAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::{json, Value};
use uuid::Uuid;

const HC_ARTIFACT: &str = include_str!("fixtures/lookup-schemas/hc.json");
const VENDOR_ARTIFACT: &str = include_str!("fixtures/lookup-schemas/vendor.json");
const DOMAIN_CATALOG: &str = include_str!("../../../packages/domain-libs/catalog.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HcArtifact {
    extras: NormalizedManifestExtras,
    schema: Schema,
}

#[derive(Clone, Debug, Deserialize)]
struct CatalogArtifact {
    domain_catalog: DomainCatalog,
}

#[derive(Clone, Debug, Deserialize)]
struct DomainCatalog {
    version: u32,
    model_count: usize,
    models: OrderedModels,
}

#[derive(Clone, Debug)]
struct OrderedModels(Vec<(String, CatalogModel)>);

#[derive(Clone, Debug, Deserialize)]
struct CatalogModel {
    id: String,
    source_package: String,
    kind: ManifestModelKind,
    label: String,
    #[serde(default)]
    notes: Option<String>,
    field_order: Vec<String>,
    fields: BTreeMap<String, CatalogField>,
    #[serde(default)]
    inverse_relations: Vec<InverseRelationManifest>,
    #[serde(default)]
    seed_rows: Vec<CatalogSeedRow>,
}

#[derive(Clone, Debug, Deserialize)]
struct CatalogField {
    #[serde(rename = "type")]
    field_type: ManifestFieldType,
    label: String,
    #[serde(default)]
    target_model: Option<String>,
    #[serde(default)]
    is_multi_value: bool,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    is_unique: bool,
    #[serde(default)]
    option_set: Vec<EnumOptionManifest>,
}

#[derive(Clone, Debug, Deserialize)]
struct CatalogSeedRow {
    external_key: String,
    values: BTreeMap<String, Value>,
}

#[derive(Debug)]
struct LookupFixture {
    model_id: String,
    external_key: String,
    label: String,
    aliases: Vec<String>,
    from_catalog_seed: bool,
}

impl<'de> Deserialize<'de> for OrderedModels {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct OrderedModelsVisitor;

        impl<'de> Visitor<'de> for OrderedModelsVisitor {
            type Value = OrderedModels;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("an ordered object of domain catalog models")
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut models = Vec::with_capacity(map.size_hint().unwrap_or_default());
                while let Some(entry) = map.next_entry()? {
                    models.push(entry);
                }
                Ok(OrderedModels(models))
            }
        }

        deserializer.deserialize_map(OrderedModelsVisitor)
    }
}

#[test]
fn checked_hc_and_vendor_artifacts_compile_deterministically_with_lookup_metadata() {
    let hc: HcArtifact =
        serde_json::from_str(HC_ARTIFACT).expect("deserialize checked HC artifact");
    let vendor: CompiledAppArtifact =
        serde_json::from_str(VENDOR_ARTIFACT).expect("deserialize checked Vendor artifact");
    let hc_compiled = CompiledManifest {
        schema: hc.schema,
        extras: hc.extras,
    };
    let vendor_compiled = CompiledManifest {
        schema: vendor.schema,
        extras: vendor.extras,
    };

    for (name, compiled) in [("HC", &hc_compiled), ("Vendor", &vendor_compiled)] {
        validate_schema(&compiled.schema)
            .unwrap_or_else(|error| panic!("checked {name} schema validates: {error}"));
        assert_lookup_metadata(&compiled.schema);
        assert_deterministic_sql(name, compiled);
    }

    assert_eq!(
        model_and_field_order(&hc_compiled.schema),
        artifact_model_and_field_order(HC_ARTIFACT)
    );
    assert_eq!(
        model_and_field_order(&vendor_compiled.schema),
        artifact_model_and_field_order(VENDOR_ARTIFACT)
    );
}

#[test]
fn all_domain_catalog_lookups_normalize_validate_and_compile_deterministically() {
    let catalog = read_catalog();
    let expected_model_order = selected_catalog_model_order(&catalog);
    let expected_lookup_count = catalog
        .models
        .0
        .iter()
        .filter(|(_, model)| model.kind == ManifestModelKind::Lookup)
        .count();
    assert_eq!(catalog.version, 1);
    assert_eq!(catalog.model_count, 38);
    assert_eq!(catalog.models.0.len(), 38);
    assert_eq!(expected_lookup_count, 13);

    let compiled = compile_catalog(catalog.clone());
    assert_eq!(
        compiled
            .schema
            .models
            .iter()
            .map(|model| model.id.to_string())
            .collect::<Vec<_>>(),
        expected_model_order
    );
    assert_lookup_metadata(&compiled.schema);
    assert_catalog_lookup_shapes(&catalog, &compiled.schema);
    assert_eq!(
        compiled
            .schema
            .models
            .iter()
            .filter(|model| model.kind == ModelKind::Lookup)
            .count(),
        13
    );
    let artifact = assert_deterministic_sql("domain catalog", &compiled);
    for model in compiled
        .schema
        .models
        .iter()
        .filter(|model| model.kind == ModelKind::Lookup)
    {
        assert!(!artifact.artifacts.iter().any(|sql| {
            sql.kind == SqlArtifactKind::Table
                && matches!(
                    sql.name.as_str(),
                    name if name == format!("{}_record", model.id)
                        || name == format!("{}_version", model.id)
                )
        }));
    }
}

#[test]
fn current_hc_vendor_and_domain_lookup_schemas_install_and_use_generated_sql_on_pg17() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let hc: HcArtifact =
        serde_json::from_str(HC_ARTIFACT).expect("deserialize checked HC artifact");
    let hc_lookup = hc_lookup_seed_fixture(&hc.extras);
    let vendor: CompiledAppArtifact =
        serde_json::from_str(VENDOR_ARTIFACT).expect("deserialize checked Vendor artifact");
    let catalog = read_catalog();
    let domain_lookups = catalog_lookup_fixtures(&catalog);
    assert_eq!(domain_lookups.len(), 13);
    assert_eq!(
        domain_lookups
            .iter()
            .filter(|fixture| fixture.from_catalog_seed)
            .count(),
        6
    );

    install_apply_and_read_lookups(
        &database_url,
        "hc",
        &CompiledManifest {
            schema: hc.schema,
            extras: hc.extras,
        },
        &[hc_lookup],
    );
    install_apply_and_read_lookups(
        &database_url,
        "vendor",
        &CompiledManifest {
            schema: vendor.schema,
            extras: vendor.extras,
        },
        &[LookupFixture {
            model_id: "department".to_string(),
            external_key: "compiler_parity_department".to_string(),
            label: "Compiler Parity Department".to_string(),
            aliases: vec!["parity-dept".to_string()],
            from_catalog_seed: false,
        }],
    );
    install_apply_and_read_lookups(
        &database_url,
        "domain",
        &compile_catalog(catalog),
        &domain_lookups,
    );
}

#[test]
fn hc_org_assignment_constraints_enforce_mainline_apply_and_draft_approval_on_pg17() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let hc: HcArtifact =
        serde_json::from_str(HC_ARTIFACT).expect("deserialize checked HC artifact");
    assert_eq!(
        hc.extras
            .constraints
            .iter()
            .map(|constraint| constraint.id.as_str())
            .collect::<Vec<_>>(),
        vec![
            "org_assignment_has_subject",
            "org_assignment_has_at_most_one_manager",
            "org_assignment_one_active_per_subject"
        ]
    );
    let compiled = CompiledManifest {
        schema: hc.schema,
        extras: hc.extras,
    };
    let artifact = compile_sql_artifact_manifest(&compiled).expect("compile HC SQL artifact");
    let mut client = connect_postgres(&database_url).expect("connect to PostgreSQL");
    require_postgres_17(&mut client);
    let schema_name = format!("hc_assignment_parity_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            "create schema \"{schema_name}\"; set search_path to \"{schema_name}\""
        ))
        .expect("create isolated HC constraint schema");

    let result = (|| -> Result<(), String> {
        trusted_human::before_install(&mut client);
        client
            .batch_execute(&render_sql_artifact_bundle(&artifact))
            .map_err(|error| format!("install generated HC SQL bundle: {error:?}"))?;
        let schema_json =
            serde_json::to_value(&compiled.schema).map_err(|error| error.to_string())?;
        let revision_id: i64 = client
            .query_one(
                "insert into schema_revision(app_id,customer_id,version,base_schema,customer_overlay,schema,schema_hash,activated_at) values($1,$2,$3,$4,'{}',$4,$5,now()) returning id",
                &[
                    &compiled.schema.app_id.as_str(),
                    &compiled.schema.customer_id.as_str(),
                    &compiled.schema.version.as_str(),
                    &schema_json,
                    &schema_hash(&compiled.schema),
                ],
            )
            .map_err(|error| format!("activate HC schema fixture: {error:?}"))?
            .get(0);

        trusted_human::bind(&mut client, "hc", "hc", "constraint-test");
        let employee_id = Uuid::new_v4();
        let position_id = Uuid::new_v4();
        assert_generated_ok(
            call_generated(
                &mut client,
                "kernel_apply_change_set",
                json!({
                    "app_id":"hc","customer_id":"hc","schema_revision_id":revision_id,
                    "actor_id":"constraint-test","source_kind":"constraint_parity",
                    "idempotency_key":"hc-constraint-employee","change_type_id":"employee_update",
                    "mode":"mainline","writes":[{
                        "model_id":"employee","new_record_id":employee_id,
                        "effective_start":"2025-01-01","values":{
                            "ref":{"type":"text","value":"employee-constraint-test"},
                            "name":{"type":"text","value":"Constraint Employee"}
                        }
                    }]
                }),
            )?,
            "create HC employee relation target",
        )?;
        assert_generated_ok(
            call_generated(
                &mut client,
                "kernel_apply_change_set",
                json!({
                    "app_id":"hc","customer_id":"hc","schema_revision_id":revision_id,
                    "actor_id":"constraint-test","source_kind":"constraint_parity",
                    "idempotency_key":"hc-constraint-position","change_type_id":"position_update",
                    "mode":"mainline","writes":[{
                        "model_id":"position","new_record_id":position_id,
                        "effective_start":"2025-01-01","values":{
                            "ref":{"type":"text","value":"position-constraint-test"}
                        }
                    }]
                }),
            )?,
            "create HC position relation target",
        )?;

        let valid_mainline_id = Uuid::new_v4();
        assert_generated_ok(
            apply_org_assignment(
                &mut client,
                revision_id,
                valid_mainline_id,
                "mainline",
                "valid-mainline",
                json!({
                    "employee":{"type":"relation","value":{"type":"record_id","value":employee_id}},
                    "start_date":{"type":"date","value":"2026-01-01"}
                }),
            )?,
            "apply valid mainline org assignment",
        )?;

        for (case, values) in [
            (
                "missing-subject",
                json!({"start_date":{"type":"date","value":"2026-01-01"}}),
            ),
            (
                "dual-manager",
                json!({
                    "employee":{"type":"relation","value":{"type":"record_id","value":employee_id}},
                    "reports_to_employee":{"type":"relation","value":{"type":"record_id","value":employee_id}},
                    "reports_to_position":{"type":"relation","value":{"type":"record_id","value":position_id}},
                    "start_date":{"type":"date","value":"2026-01-01"}
                }),
            ),
        ] {
            let record_id = Uuid::new_v4();
            let rejected = apply_org_assignment(
                &mut client,
                revision_id,
                record_id,
                "mainline",
                case,
                values,
            )?;
            assert_eq!(rejected["ok"], false, "{case} was accepted: {rejected:#}");
            assert_eq!(rejected["error"]["code"], "database_error");
            let persisted: bool = client
                .query_one(
                    "select exists(select 1 from org_assignment_record where id=$1)",
                    &[&record_id],
                )
                .map_err(|error| format!("inspect rejected {case} record: {error:?}"))?
                .get(0);
            assert!(!persisted, "rejected {case} record was persisted");
        }

        let valid_draft_id = Uuid::new_v4();
        let valid_draft = apply_org_assignment(
            &mut client,
            revision_id,
            valid_draft_id,
            "draft",
            "valid-draft",
            json!({
                "position":{"type":"relation","value":{"type":"record_id","value":position_id}},
                "reports_to_employee":{"type":"relation","value":{"type":"record_id","value":employee_id}},
                "start_date":{"type":"date","value":"2026-02-01"}
            }),
        )?;
        assert_generated_ok(valid_draft.clone(), "create valid HC assignment draft")?;
        let valid_draft_change_set = valid_draft["data"]["id"]
            .as_i64()
            .ok_or_else(|| format!("valid draft has no change-set id: {valid_draft:#}"))?;
        assert_generated_ok(
            call_generated(
                &mut client,
                "kernel_approve_draft_change_set",
                json!({
                    "app_id":"hc","customer_id":"hc","actor_id":"constraint-test","change_set_id":valid_draft_change_set
                }),
            )?,
            "approve valid HC assignment draft",
        )?;

        let occupancy_check = artifact
            .artifacts
            .iter()
            .find(|item| {
                item.kind == SqlArtifactKind::CheckConstraint
                    && item.name.starts_with("org_assignment_version.")
                    && item.sql.contains("employee")
                    && item.sql.contains("position")
                    && item.sql.contains(">= 1")
            })
            .ok_or_else(|| "generated HC occupancy check is missing".to_string())?;
        let constraint_name = occupancy_check
            .name
            .split_once('.')
            .map(|(_, name)| name)
            .ok_or_else(|| format!("invalid constraint artifact name: {}", occupancy_check.name))?;
        client
            .batch_execute(&format!(
                "alter table org_assignment_version drop constraint \"{constraint_name}\""
            ))
            .map_err(|error| format!("temporarily remove occupancy check: {error:?}"))?;
        let invalid_draft = apply_org_assignment(
            &mut client,
            revision_id,
            Uuid::new_v4(),
            "draft",
            "preexisting-invalid-draft",
            json!({"start_date":{"type":"date","value":"2026-03-01"}}),
        )?;
        assert_generated_ok(
            invalid_draft.clone(),
            "create pre-existing invalid draft fixture",
        )?;
        let invalid_draft_change_set = invalid_draft["data"]["id"]
            .as_i64()
            .ok_or_else(|| format!("invalid draft has no change-set id: {invalid_draft:#}"))?;
        // The fixture intentionally violates this check until draft approval.
        // Restore the generated NOT VALID definition but defer its transition-plan
        // validation step so approval, not fixture setup, exercises rejection.
        let check_sql = occupancy_check
            .sql
            .split("\nalter table ")
            .next()
            .expect("generated occupancy check has creation SQL")
            .trim();
        client.batch_execute(check_sql).map_err(|error| {
            format!("restore occupancy check without validating fixture: {error:?}")
        })?;
        let rejected_approval = call_generated(
            &mut client,
            "kernel_approve_draft_change_set",
            json!({
                "app_id":"hc","customer_id":"hc","actor_id":"constraint-test","change_set_id":invalid_draft_change_set
            }),
        )?;
        assert_eq!(
            rejected_approval["ok"], false,
            "invalid draft was approved: {rejected_approval:#}"
        );
        assert_eq!(rejected_approval["error"]["code"], "database_error");
        let status: String = client
            .query_one(
                "select status from change_set where id=$1",
                &[&invalid_draft_change_set],
            )
            .map_err(|error| format!("inspect rejected draft status: {error:?}"))?
            .get(0);
        assert_eq!(status, "draft");
        Ok(())
    })();

    let cleanup = trusted_human::drop_fixture(&mut client, &schema_name);
    result.unwrap_or_else(|error| panic!("{error}"));
    cleanup.expect("drop isolated HC constraint schema");
}

#[test]
fn current_hc_and_vendor_department_history_migrates_through_compiled_lookup_schemas_on_pg17() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let hc: HcArtifact =
        serde_json::from_str(HC_ARTIFACT).expect("deserialize checked HC artifact");
    let vendor: CompiledAppArtifact =
        serde_json::from_str(VENDOR_ARTIFACT).expect("deserialize checked Vendor artifact");

    migrate_current_department_fixture(
        &database_url,
        "hc",
        &CompiledManifest {
            schema: hc.schema,
            extras: hc.extras,
        },
    );
    migrate_current_department_fixture(
        &database_url,
        "vendor",
        &CompiledManifest {
            schema: vendor.schema,
            extras: vendor.extras,
        },
    );
}

fn apply_org_assignment(
    client: &mut Client,
    revision_id: i64,
    record_id: Uuid,
    mode: &str,
    idempotency_suffix: &str,
    values: Value,
) -> Result<Value, String> {
    call_generated(
        client,
        "kernel_apply_change_set",
        json!({
            "app_id":"hc","customer_id":"hc","schema_revision_id":revision_id,
            "actor_id":"constraint-test","source_kind":"constraint_parity",
            "idempotency_key":format!("hc-assignment-{idempotency_suffix}"),
            "change_type_id":"org_assignment_change","mode":mode,
            "writes":[{
                "model_id":"org_assignment","new_record_id":record_id,
                "effective_start":"2026-01-01","values":values
            }]
        }),
    )
}

fn assert_generated_ok(response: Value, operation: &str) -> Result<(), String> {
    if response["ok"] == json!(true) {
        Ok(())
    } else {
        Err(format!("{operation} failed: {response:#}"))
    }
}

fn call_generated(client: &mut Client, function: &str, request: Value) -> Result<Value, String> {
    client
        .query_one(&format!("select {function}($1::jsonb)"), &[&request])
        .map(|row| row.get(0))
        .map_err(|error| format!("call {function}: {error:?}"))
}

fn migrate_current_department_fixture(
    database_url: &str,
    fixture: &str,
    compiled: &CompiledManifest,
) {
    let department = compiled
        .schema
        .models
        .iter()
        .find(|model| model.id.as_str() == "department")
        .unwrap_or_else(|| panic!("{fixture} schema has a department lookup"));
    assert_eq!(department.kind, ModelKind::Lookup);
    assert!(department.fields.iter().any(|field| {
        field.id.as_str() == "name" && field.field_type == FieldType::Text && field.required
    }));
    assert!(department.fields.iter().any(|field| {
        field.id.as_str() == "known_aliases" && field.field_type == FieldType::KnownAliases
    }));

    let artifact = compile_sql_artifact_manifest(compiled)
        .unwrap_or_else(|error| panic!("compile {fixture} migration artifact: {error}"));
    let mut client = connect_postgres(database_url).expect("connect to PostgreSQL");
    require_postgres_17(&mut client);
    let schema_name = format!("{fixture}_migration_parity_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            "create schema \"{schema_name}\"; set search_path to \"{schema_name}\""
        ))
        .unwrap_or_else(|error| panic!("create {fixture} migration schema: {error:?}"));

    let result = (|| -> Result<(), String> {
        trusted_human::before_install(&mut client);
        client
            .batch_execute(&render_sql_artifact_bundle(&artifact))
            .map_err(|error| format!("install generated {fixture} SQL bundle: {error:?}"))?;
        client
            .batch_execute(&lookup_migration_sql())
            .map_err(|error| format!("install {fixture} lookup migration API: {error:?}"))?;
        client
            .query_one(
                "select set_config('kernel.app_id',$1,false),set_config('kernel.customer_id',$2,false)",
                &[
                    &compiled.schema.app_id.as_str(),
                    &compiled.schema.customer_id.as_str(),
                ],
            )
            .map_err(|error| format!("set {fixture} migration scope: {error:?}"))?;

        let schema_json =
            serde_json::to_value(&compiled.schema).map_err(|error| error.to_string())?;
        let effective_hash = schema_hash(&compiled.schema);
        let revision_id: i64 = client
            .query_one(
                "insert into schema_revision(app_id,customer_id,version,base_schema,customer_overlay,schema,schema_hash,materialization_source,materialized_at,activated_at) values($1,$2,$3,$4,'{}',$4,$5,'current-app-migration-parity',now(),now()) returning id",
                &[
                    &compiled.schema.app_id.as_str(),
                    &compiled.schema.customer_id.as_str(),
                    &compiled.schema.version.as_str(),
                    &schema_json,
                    &effective_hash,
                ],
            )
            .map_err(|error| format!("activate {fixture} migration schema: {error:?}"))?
            .get(0);
        create_current_app_typed_lookup_tables(&mut client, compiled)
            .map_err(|error| format!("create {fixture} typed lookup tables: {error}"))?;
        let change_set_id: i64 = client
            .query_one(
                "insert into change_set(app_id,customer_id,schema_revision_id,created_with_mode,status,source_kind,created_order,applied_order,applied_at) values($1,$2,$3,'mainline','mainline','current-app-migration-parity',1,1,now()) returning id",
                &[
                    &compiled.schema.app_id.as_str(),
                    &compiled.schema.customer_id.as_str(),
                    &revision_id,
                ],
            )
            .map_err(|error| format!("create {fixture} typed change set: {error:?}"))?
            .get(0);
        let record_id = Uuid::new_v4();
        let version_id = Uuid::new_v4();
        let external_key = format!("{fixture}-legacy-department");
        let label = format!("{fixture} Legacy Department");
        client
            .execute(
                "insert into department_record(id,app_id,customer_id,external_key,created_at) values($1,$2,$3,$4,'2026-01-01T00:00:00Z')",
                &[
                    &record_id,
                    &compiled.schema.app_id.as_str(),
                    &compiled.schema.customer_id.as_str(),
                    &external_key,
                ],
            )
            .map_err(|error| format!("insert {fixture} typed department record: {error:?}"))?;
        client
            .execute(
                "insert into department_version(id,record_id,app_id,customer_id,stage,effective_start,change_set_id,created_at,applied_at,provenance,name,known_aliases) values($1,$2,$3,$4,'mainline','2026-01-01',$5,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',$6,$7,$8)",
                &[
                    &version_id,
                    &record_id,
                    &compiled.schema.app_id.as_str(),
                    &compiled.schema.customer_id.as_str(),
                    &change_set_id,
                    &json!({"source":"current-app-migration-parity","fixture":fixture}),
                    &label,
                    &vec![format!("{fixture} Dept"), format!("{fixture} Org Unit")],
                ],
            )
            .map_err(|error| format!("insert {fixture} typed department version: {error:?}"))?;
        client
            .execute(
                "insert into lookup_storage_authority(app_id,customer_id,model_id,schema_hash,authority,legacy_record_table,legacy_version_table) values($1,$2,'department',$3,'typed','department_record','department_version')",
                &[
                    &compiled.schema.app_id.as_str(),
                    &compiled.schema.customer_id.as_str(),
                    &effective_hash,
                ],
            )
            .map_err(|error| format!("declare {fixture} typed lookup authority: {error:?}"))?;

        let request = json!({
            "app_id":compiled.schema.app_id,
            "customer_id":compiled.schema.customer_id,
            "schema_revision_id":revision_id,
            "expected_schema_hash":effective_hash,
            "batch_size":10
        });
        let prepared = prepare_current_app_migration(&mut client, request.clone())?;
        assert_eq!(
            prepared["ok"], true,
            "{fixture} preparation failed: {prepared:#}"
        );
        assert_eq!(prepared["data"]["ready"], true);
        let mut activation_request = request.clone();
        activation_request
            .as_object_mut()
            .expect("migration request object")
            .remove("batch_size");
        let validated = call_generated(
            &mut client,
            "kernel_validate_lookup_migration",
            activation_request.clone(),
        )?;
        assert_eq!(
            validated["ok"], true,
            "{fixture} validation failed: {validated:#}"
        );
        let activated = call_generated(
            &mut client,
            "kernel_activate_lookup_migration",
            activation_request,
        )?;
        assert_eq!(
            activated["ok"], true,
            "{fixture} activation failed: {activated:#}"
        );

        let migrated: (Uuid, Uuid, String, Value, Value) = client
            .query_one(
                "select r.id,v.id,v.values#>>'{name,value}',v.values->'known_aliases'->'value',v.provenance from lookup_record r join lookup_version v on v.app_id=r.app_id and v.customer_id=r.customer_id and v.model_id=r.model_id and v.record_id=r.id where r.app_id=$1 and r.customer_id=$2 and r.model_id='department'",
                &[
                    &compiled.schema.app_id.as_str(),
                    &compiled.schema.customer_id.as_str(),
                ],
            )
            .map(|row| (row.get(0), row.get(1), row.get(2), row.get(3), row.get(4)))
            .map_err(|error| format!("read migrated {fixture} lookup history: {error:?}"))?;
        assert_eq!(migrated.0, record_id);
        assert_eq!(migrated.1, version_id);
        assert_eq!(migrated.2, label);
        assert_eq!(
            migrated.3,
            json!([format!("{fixture} Dept"), format!("{fixture} Org Unit")])
        );
        assert_eq!(
            migrated.4,
            json!({"source":"current-app-migration-parity","fixture":fixture})
        );
        let authority: String = client
            .query_one(
                "select authority from lookup_storage_authority where app_id=$1 and customer_id=$2 and model_id='department'",
                &[
                    &compiled.schema.app_id.as_str(),
                    &compiled.schema.customer_id.as_str(),
                ],
            )
            .map_err(|error| format!("read {fixture} lookup authority: {error:?}"))?
            .get(0);
        assert_eq!(authority, "generic");
        let listed = call_generated(
            &mut client,
            "kernel_lookup_list",
            json!({
                "app_id":compiled.schema.app_id,"customer_id":compiled.schema.customer_id,
                "model_id":"department","as_of":"2026-08-05","query":label
            }),
        )?;
        assert_eq!(
            listed["ok"], true,
            "{fixture} migrated lookup read failed: {listed:#}"
        );
        assert_eq!(listed["data"][0]["record_id"], record_id.to_string());
        assert_eq!(listed["data"][0]["external_key"], external_key);
        let evidence_retained: (bool, bool) = client
            .query_one(
                "select to_regclass('department_record') is not null,to_regclass('department_version') is not null",
                &[],
            )
            .map(|row| (row.get(0), row.get(1)))
            .map_err(|error| format!("inspect {fixture} legacy evidence: {error:?}"))?;
        assert_eq!(evidence_retained, (true, true));
        Ok(())
    })();

    let cleanup = trusted_human::drop_fixture(&mut client, &schema_name);
    result.unwrap_or_else(|error| panic!("{error}"));
    cleanup.unwrap_or_else(|error| panic!("drop {fixture} migration schema: {error:?}"));
}

fn prepare_current_app_migration(client: &mut Client, request: Value) -> Result<Value, String> {
    for _ in 0..100 {
        let response = call_generated(client, "kernel_prepare_lookup_migration", request.clone())?;
        if response["ok"] != json!(true) || response["data"]["ready"] == json!(true) {
            return Ok(response);
        }
    }
    Err("current-app lookup migration did not become ready".to_string())
}

fn create_current_app_typed_lookup_tables(
    client: &mut Client,
    compiled: &CompiledManifest,
) -> Result<(), String> {
    let mut ddl = String::new();
    for model in compiled
        .schema
        .models
        .iter()
        .filter(|model| model.kind == ModelKind::Lookup)
    {
        let record_table = sql_identifier(&format!("{}_record", model.id));
        let version_table = sql_identifier(&format!("{}_version", model.id));
        let mut field_columns = Vec::new();
        for field in &model.fields {
            let field_id = sql_identifier(field.id.as_str());
            match field.field_type {
                FieldType::Text
                | FieldType::IsoCountry
                | FieldType::IsoCurrency
                | FieldType::Enum => field_columns.push(format!("{field_id} text")),
                FieldType::Number => field_columns.push(format!("{field_id} numeric")),
                FieldType::Bool => field_columns.push(format!("{field_id} boolean")),
                FieldType::Date => field_columns.push(format!("{field_id} date")),
                FieldType::Datetime => field_columns.push(format!("{field_id} timestamptz")),
                FieldType::Relation => field_columns.push(format!("{field_id} uuid")),
                FieldType::TextList | FieldType::KnownAliases => {
                    field_columns.push(format!("{field_id} text[]"));
                }
                FieldType::Json => field_columns.push(format!("{field_id} jsonb")),
                FieldType::MoneyRate => {
                    field_columns.push(format!("{field_id}_amount numeric"));
                    field_columns.push(format!("{field_id}_currency text"));
                    field_columns.push(format!("{field_id}_period text"));
                }
            }
        }
        ddl.push_str(&format!(
            "create table {record_table} (id uuid primary key,app_id text not null,customer_id text not null,external_key text,created_at timestamptz not null default now());\n"
        ));
        ddl.push_str(&format!(
            "create table {version_table} (id uuid primary key,record_id uuid not null,app_id text not null,customer_id text not null,stage text not null,effective_start date not null,effective_end date,change_set_id bigint not null,created_at timestamptz not null default now(),applied_at timestamptz,tombstones_record boolean not null default false,untombstones_record boolean not null default false,provenance jsonb,custom_fields jsonb not null default '[]',metadata jsonb not null default '{{}}',many_relations jsonb not null default '{{}}',availability text not null default 'active',{});\n",
            field_columns.join(",")
        ));
    }
    client
        .batch_execute(&ddl)
        .map_err(|error| format!("execute typed lookup DDL: {error:?}"))
}

fn sql_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn lookup_migration_sql() -> String {
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

fn compile_catalog(catalog: DomainCatalog) -> CompiledManifest {
    let selected_model_ids = selected_catalog_model_order(&catalog)
        .into_iter()
        .collect::<BTreeSet<_>>();
    let mut models = Vec::with_capacity(selected_model_ids.len());
    for (catalog_key, source) in catalog.models.0 {
        assert_eq!(catalog_key, source.id);
        if !selected_model_ids.contains(&source.id) {
            continue;
        }
        assert!(!source.source_package.trim().is_empty());
        let declared_fields = source.fields.keys().cloned().collect::<BTreeSet<_>>();
        let ordered_fields = source.field_order.iter().cloned().collect::<BTreeSet<_>>();
        assert_eq!(
            declared_fields, ordered_fields,
            "{} field inventory",
            source.id
        );
        assert_eq!(source.field_order.len(), ordered_fields.len());

        let mut fields = Vec::new();
        let mut many_relations = Vec::new();
        let selected_field_order = if source.kind == ManifestModelKind::Lookup {
            source.field_order.iter().collect::<Vec<_>>()
        } else {
            // Non-lookup models are relation-target closure only in this lookup parity fixture.
            vec![source
                .field_order
                .iter()
                .find(|field_id| field_id.as_str() == "name")
                .or_else(|| {
                    source.field_order.iter().find(|field_id| {
                        field_id.as_str() != "id"
                            && source.fields.get(*field_id).is_some_and(|field| {
                                field.field_type != ManifestFieldType::Relation
                            })
                    })
                })
                .expect("relation target stub has a safe scalar field")]
        };
        for field_id in selected_field_order {
            let field = source
                .fields
                .get(field_id)
                .unwrap_or_else(|| panic!("catalog field {}.{field_id}", source.id));
            if field.field_type == ManifestFieldType::Relation && field.is_multi_value {
                many_relations.push(ManyRelationManifest {
                    id: field_id.clone(),
                    label: field.label.clone(),
                    target_model: field
                        .target_model
                        .clone()
                        .expect("multi-value relation target"),
                    notes: field.notes.clone(),
                    origin: SchemaElementOrigin::App,
                    management: SchemaManagementPolicy::Fixed,
                    lifecycle: SchemaElementLifecycle::Active,
                });
                continue;
            }
            fields.push(FieldManifest {
                id: field_id.clone(),
                name: None,
                aliases: Vec::new(),
                label: field.label.clone(),
                field_type: field.field_type,
                required: source.kind == ManifestModelKind::Lookup && field_id == "name",
                is_unique: field.is_unique,
                notes: field.notes.clone(),
                target_model: field.target_model.clone(),
                option_set: field.option_set.clone(),
                origin: SchemaElementOrigin::App,
                management: SchemaManagementPolicy::Fixed,
                lifecycle: SchemaElementLifecycle::Active,
            });
        }
        models.push(ModelManifest {
            id: source.id,
            name: None,
            aliases: vec![],
            kind: source.kind,
            label: source.label,
            display_field_id: (source.kind == ManifestModelKind::Lookup)
                .then(|| "name".to_string()),
            origin: SchemaElementOrigin::App,
            management: if source.kind == ManifestModelKind::Lookup {
                SchemaManagementPolicy::TenantManaged
            } else {
                SchemaManagementPolicy::Fixed
            },
            lifecycle: SchemaElementLifecycle::Active,
            extensions: EntityExtensionCapabilities::default(),
            notes: source.notes,
            fields,
            field_groups: vec![],
            many_relations,
            inverse_relations: if source.kind == ManifestModelKind::Lookup {
                source.inverse_relations
            } else {
                vec![]
            },
            derived_fields: vec![],
        });
    }

    compile_manifest(AppManifest {
        app_id: "domain_catalog_parity".to_string(),
        customer_id: "catalog".to_string(),
        version: "catalog-v1".to_string(),
        label: None,
        connectors: None,
        agents: None,
        models,
        custom_fields: vec![],
        change_types: vec![],
        constraints: vec![],
        authorization: None,
        seed_change_sets: vec![],
    })
    .expect("normalize and validate every domain catalog model")
}

fn assert_catalog_lookup_shapes(catalog: &DomainCatalog, schema: &Schema) {
    for (_, source) in catalog
        .models
        .0
        .iter()
        .filter(|(_, model)| model.kind == ManifestModelKind::Lookup)
    {
        let model = schema
            .models
            .iter()
            .find(|model| model.id.as_str() == source.id)
            .unwrap_or_else(|| panic!("compiled catalog lookup {}", source.id));
        assert_eq!(model.label, source.label);
        assert_eq!(
            model
                .fields
                .iter()
                .map(|field| field.id.as_str())
                .collect::<Vec<_>>(),
            source
                .field_order
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
        );
        for field in &model.fields {
            let expected = source
                .fields
                .get(field.id.as_str())
                .unwrap_or_else(|| panic!("catalog field {}.{}", source.id, field.id));
            assert_eq!(field.label, expected.label);
            assert_eq!(
                serde_json::to_value(&field.field_type).expect("serialize kernel field type"),
                serde_json::to_value(expected.field_type).expect("serialize manifest field type")
            );
            assert_eq!(field.is_unique, expected.is_unique);
            assert_eq!(
                field.target_model.as_ref().map(ToString::to_string),
                expected.target_model
            );
            assert_eq!(
                field
                    .option_set
                    .iter()
                    .map(|option| (
                        option.id.to_string(),
                        option.label.clone(),
                        option.aliases.clone()
                    ))
                    .collect::<Vec<_>>(),
                expected
                    .option_set
                    .iter()
                    .map(|option| (
                        option.id.clone(),
                        option.label.clone(),
                        option.aliases.clone()
                    ))
                    .collect::<Vec<_>>()
            );
        }
    }
}

fn selected_catalog_model_order(catalog: &DomainCatalog) -> Vec<String> {
    let lookup_ids = catalog
        .models
        .0
        .iter()
        .filter(|(_, model)| model.kind == ManifestModelKind::Lookup)
        .map(|(_, model)| model.id.as_str())
        .collect::<BTreeSet<_>>();
    let relation_targets = catalog
        .models
        .0
        .iter()
        .filter(|(_, model)| model.kind == ManifestModelKind::Lookup)
        .flat_map(|(_, model)| model.fields.values())
        .filter_map(|field| field.target_model.as_deref())
        .collect::<BTreeSet<_>>();
    catalog
        .models
        .0
        .iter()
        .filter(|(_, model)| {
            lookup_ids.contains(model.id.as_str()) || relation_targets.contains(model.id.as_str())
        })
        .map(|(_, model)| model.id.clone())
        .collect()
}

fn assert_deterministic_sql(
    name: &str,
    compiled: &CompiledManifest,
) -> schema_compiler::SqlArtifactManifest {
    let original_order = model_and_field_order(&compiled.schema);
    let first = compile_sql_artifact_manifest(compiled)
        .unwrap_or_else(|error| panic!("compile {name} SQL artifact: {error}"));
    let second = compile_sql_artifact_manifest(compiled)
        .unwrap_or_else(|error| panic!("recompile {name} SQL artifact: {error}"));
    assert_eq!(first, second, "{name} SQL manifest is deterministic");
    assert_eq!(
        render_sql_artifact_bundle(&first),
        render_sql_artifact_bundle(&second),
        "{name} SQL bundle is byte-identical"
    );
    assert_eq!(model_and_field_order(&compiled.schema), original_order);
    first
}

fn assert_lookup_metadata(schema: &Schema) {
    for model in schema
        .models
        .iter()
        .filter(|model| model.kind == ModelKind::Lookup)
    {
        assert_eq!(
            model.origin,
            SchemaElementOrigin::App,
            "{} origin",
            model.id
        );
        assert_eq!(
            model.management,
            SchemaManagementPolicy::TenantManaged,
            "{} management",
            model.id
        );
        assert_eq!(
            model.lifecycle,
            SchemaElementLifecycle::Active,
            "{} lifecycle",
            model.id
        );
        let display_field_id = model
            .display_field_id
            .as_ref()
            .unwrap_or_else(|| panic!("{} display field", model.id));
        let display_field = model
            .fields
            .iter()
            .find(|field| field.id == *display_field_id)
            .unwrap_or_else(|| panic!("{} display field exists", model.id));
        assert_eq!(display_field.field_type, FieldType::Text);
        assert!(display_field.required);
        assert_eq!(display_field.lifecycle, SchemaElementLifecycle::Active);
    }
}

fn install_apply_and_read_lookups(
    database_url: &str,
    fixture: &str,
    compiled: &CompiledManifest,
    lookups: &[LookupFixture],
) {
    validate_schema(&compiled.schema).expect("app schema validates before installation");
    let artifact = compile_sql_artifact_manifest(compiled).expect("compile app SQL artifact");
    let mut client = connect_postgres(database_url).expect("connect to PostgreSQL");
    require_postgres_17(&mut client);
    let schema_name = format!("{fixture}_schema_parity_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            "create schema \"{schema_name}\"; set search_path to \"{schema_name}\""
        ))
        .expect("create isolated app schema");

    let result = (|| -> Result<(), String> {
        trusted_human::before_install(&mut client);
        client
            .batch_execute(&render_sql_artifact_bundle(&artifact))
            .map_err(|error| format!("install generated {fixture} SQL bundle: {error:?}"))?;
        let schema_json =
            serde_json::to_value(&compiled.schema).map_err(|error| error.to_string())?;
        let effective_schema_hash = schema_hash(&compiled.schema);
        let revision_id: i64 = client
            .query_one(
                "insert into schema_revision (app_id,customer_id,version,base_schema,customer_overlay,schema,activated_at,schema_hash) values ($1,$2,$3,$4,'{}'::jsonb,$4,now(),$5) returning id",
                &[
                    &compiled.schema.app_id.as_str(),
                    &compiled.schema.customer_id.as_str(),
                    &compiled.schema.version.as_str(),
                    &schema_json,
                    &effective_schema_hash,
                ],
            )
            .map_err(|error| format!("activate {fixture} schema fixture: {error:?}"))?
            .get(0);
        for lookup in lookups {
            client
                .execute(
                    "insert into lookup_storage_authority (app_id,customer_id,model_id,schema_hash,authority,legacy_record_table,legacy_version_table,activated_at) values ($1,$2,$3,$4,'generic','lookup_record','lookup_version',now())",
                    &[
                        &compiled.schema.app_id.as_str(),
                        &compiled.schema.customer_id.as_str(),
                        &lookup.model_id,
                        &effective_schema_hash,
                    ],
                )
                .map_err(|error| {
                    format!(
                        "declare {fixture} lookup {} generic authority: {error:?}",
                        lookup.model_id
                    )
                })?;
        }
        trusted_human::bind(
            &mut client,
            compiled.schema.app_id.as_str(),
            compiled.schema.customer_id.as_str(),
            "schema-parity-test",
        );
        for lookup in lookups {
            let response: Value = client
                .query_one(
                    "select kernel_apply_change_set($1::jsonb)",
                    &[&json!({
                        "app_id": compiled.schema.app_id,
                        "customer_id": compiled.schema.customer_id,
                        "schema_revision_id": revision_id,
                        "actor_id": "schema-parity-test",
                        "source_kind": "schema_parity",
                        "idempotency_key": format!(
                            "{fixture}-{}-{}",
                            lookup.model_id, lookup.external_key
                        ),
                        "mode": "mainline",
                        "writes": [{
                            "model_id": lookup.model_id,
                            "record_key": {
                                "type": "external_key",
                                "value": lookup.external_key
                            },
                            "effective_start": "2026-01-01",
                            "values": {
                                "name": {"type": "text", "value": lookup.label},
                                "known_aliases": {
                                    "type": "text_list",
                                    "value": lookup.aliases
                                }
                            }
                        }]
                    })],
                )
                .map_err(|error| {
                    format!(
                        "apply {fixture} lookup {} through generated SQL: {error:?}",
                        lookup.model_id
                    )
                })?
                .get(0);
            if response["ok"] != json!(true) {
                return Err(format!(
                    "generated {fixture} lookup {} apply failed: {response:#}",
                    lookup.model_id
                ));
            }
            let listed: Value = client
                .query_one(
                    "select kernel_lookup_list($1::jsonb)",
                    &[&json!({
                        "app_id": compiled.schema.app_id,
                        "customer_id": compiled.schema.customer_id,
                        "model_id": lookup.model_id,
                        "as_of": "2026-08-05",
                        "query": lookup.label,
                        "limit": 10
                    })],
                )
                .map_err(|error| {
                    format!(
                        "list {fixture} lookup {} through generated SQL: {error:?}",
                        lookup.model_id
                    )
                })?
                .get(0);
            if listed["ok"] != json!(true) {
                return Err(format!(
                    "generated {fixture} lookup {} read failed: {listed:#}",
                    lookup.model_id
                ));
            }
            let rows = listed["data"].as_array().ok_or_else(|| {
                format!(
                    "generated {fixture} lookup {} data is not an array",
                    lookup.model_id
                )
            })?;
            if rows.len() != 1
                || rows[0]["external_key"] != json!(lookup.external_key)
                || rows[0]["label"] != json!(lookup.label)
            {
                return Err(format!(
                    "generated {fixture} lookup {} read mismatch: {listed:#}",
                    lookup.model_id
                ));
            }
        }
        Ok(())
    })();

    let cleanup = trusted_human::drop_fixture(&mut client, &schema_name);
    result.unwrap_or_else(|error| panic!("{error}"));
    cleanup.expect("drop isolated app schema");
}

fn catalog_lookup_fixtures(catalog: &DomainCatalog) -> Vec<LookupFixture> {
    catalog
        .models
        .0
        .iter()
        .filter(|(_, model)| model.kind == ManifestModelKind::Lookup)
        .map(|(_, model)| {
            if let Some(seed) = model.seed_rows.first() {
                return LookupFixture {
                    model_id: model.id.clone(),
                    external_key: seed.external_key.clone(),
                    label: seed_label(seed),
                    aliases: seed_aliases(seed),
                    from_catalog_seed: true,
                };
            }
            LookupFixture {
                model_id: model.id.clone(),
                external_key: format!("schema_parity_{}", model.id),
                label: format!("Schema Parity {}", model.label),
                aliases: vec![format!("lookup-alias-{}", model.id)],
                from_catalog_seed: false,
            }
        })
        .collect()
}

fn hc_lookup_seed_fixture(extras: &NormalizedManifestExtras) -> LookupFixture {
    let write = extras
        .seed_change_sets
        .iter()
        .flat_map(|template| template.writes.iter())
        .find(|write| write.model_id.as_str() == "department")
        .expect("checked HC department seed change set");
    let external_key = match write.record_key.as_ref() {
        Some(RecordKey::ExternalKey(value)) => value.as_str().to_string(),
        _ => panic!("HC department seed change set has an external key"),
    };
    let values = write
        .values
        .as_ref()
        .expect("HC department seed change set has values");
    let label = match values.get(&FieldId::from("name")) {
        Some(FieldValue::Text(value)) => value.clone(),
        _ => panic!("HC department seed change set has a text name"),
    };
    let aliases = match values.get(&FieldId::from("known_aliases")) {
        Some(FieldValue::TextList(value)) => value.clone(),
        _ => panic!("HC department seed change set has text aliases"),
    };

    LookupFixture {
        model_id: "department".to_string(),
        external_key,
        label,
        aliases,
        from_catalog_seed: true,
    }
}

fn read_catalog() -> DomainCatalog {
    serde_json::from_str::<CatalogArtifact>(DOMAIN_CATALOG)
        .expect("deserialize checked domain catalog")
        .domain_catalog
}

fn seed_label(seed: &CatalogSeedRow) -> String {
    seed.values
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("seed {} has a text name", seed.external_key))
        .to_string()
}

fn seed_aliases(seed: &CatalogSeedRow) -> Vec<String> {
    seed.values
        .get("known_aliases")
        .and_then(Value::as_array)
        .unwrap_or_else(|| panic!("seed {} has known aliases", seed.external_key))
        .iter()
        .map(|value| {
            value
                .as_str()
                .unwrap_or_else(|| panic!("seed {} alias is text", seed.external_key))
                .to_string()
        })
        .collect()
}

fn model_and_field_order(schema: &Schema) -> Vec<(String, Vec<String>)> {
    schema
        .models
        .iter()
        .map(|model| {
            (
                model.id.to_string(),
                model
                    .fields
                    .iter()
                    .map(|field| field.id.to_string())
                    .collect(),
            )
        })
        .collect()
}

fn artifact_model_and_field_order(artifact: &str) -> Vec<(String, Vec<String>)> {
    serde_json::from_str::<Value>(artifact)
        .expect("deserialize checked app artifact as JSON")
        .get("schema")
        .and_then(|schema| schema.get("models"))
        .and_then(Value::as_array)
        .expect("checked artifact schema model array")
        .iter()
        .map(|model| {
            (
                model["id"].as_str().expect("model id").to_string(),
                model["fields"]
                    .as_array()
                    .expect("model field array")
                    .iter()
                    .map(|field| field["id"].as_str().expect("field id").to_string())
                    .collect(),
            )
        })
        .collect()
}

fn test_database_url() -> Option<String> {
    match env::var("KERNEL_TEST_DATABASE_URL") {
        Ok(value) if !value.trim().is_empty() => Some(value),
        Ok(_) | Err(env::VarError::NotPresent) => {
            eprintln!("skipping current app schema SQL test: KERNEL_TEST_DATABASE_URL is absent");
            None
        }
        Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
    }
}

fn require_postgres_17(client: &mut postgres::Client) {
    let version: i32 = client
        .query_one("show server_version_num", &[])
        .expect("read PostgreSQL version")
        .get::<_, String>(0)
        .parse()
        .expect("numeric PostgreSQL version");
    assert!(
        version >= 170_000,
        "app schema parity requires PostgreSQL 17"
    );
}
