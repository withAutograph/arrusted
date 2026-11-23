use std::collections::BTreeMap;
use std::env;
use support::trusted_human;

use chrono::NaiveDate;
use kernel::testing::GeneratedSqlFunction;
use kernel::{
    connect_postgres, AppId, AppliedChangeSet, ApplyChangeSet, ApplyMode, ChangeSetDiff,
    ChangeSetDiffRequest, CustomFieldDefinition, CustomFieldDefinitionId, CustomFieldEntry,
    CustomFieldType, CustomFieldValue, CustomerId, ExternalKey, Field, FieldHistoryEntry,
    FieldHistoryRequest, FieldId, FieldType, FieldValue, KernelError, Model, ModelId, ModelKind,
    RecordKey, RevertChangeSet, RowVersionWrite, Schema, SchemaVersion, VersionStage,
    VisibleRecord,
};
use postgres::Client;
use schema_compiler::{
    compile_sql_artifact_manifest, render_sql_artifact_bundle, CompiledManifest,
    NormalizedManifestExtras,
};
use serde::Serialize;
use serde_json::json;
use uuid::Uuid;

mod support;

const APP_ID: &str = "revert_audit_app";
const CUSTOMER_ID: &str = "tenant_a";

struct Fixture {
    client: Client,
    schema_name: String,
}

impl Fixture {
    fn connect() -> Option<Self> {
        let database_url = match env::var("KERNEL_TEST_DATABASE_URL") {
            Ok(value) => value,
            Err(env::VarError::NotPresent) => {
                eprintln!(
                    "skipping generated revert audit parity: KERNEL_TEST_DATABASE_URL is absent"
                );
                return None;
            }
            Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
        };
        let compiled = compiled_schema();
        let manifest = compile_sql_artifact_manifest(&compiled).expect("compile SQL artifacts");
        let bundle = render_sql_artifact_bundle(&manifest);
        let mut client = connect_postgres(&database_url).expect("connect to PostgreSQL");
        let schema_name = format!("kernel_revert_audit_{}", Uuid::new_v4().simple());
        client
            .batch_execute(&format!(
                "create schema \"{schema_name}\"; set search_path to \"{schema_name}\""
            ))
            .expect("create fixture schema");
        trusted_human::before_install(&mut client);
        client
            .batch_execute(&bundle)
            .expect("install generated SQL bundle");
        let schema_json = serde_json::to_value(&compiled.schema).expect("serialize schema");
        client
            .execute(
                "insert into schema_revision(app_id,customer_id,version,base_schema,customer_overlay,schema,activated_at,materialized_at) values($1,$2,$3,$4,'{}',$4,now(),now())",
                &[&APP_ID, &CUSTOMER_ID, &compiled.schema.version.as_str(), &schema_json],
            )
            .expect("activate generated schema revision");
        trusted_human::bind(&mut client, APP_ID, CUSTOMER_ID, "tester");
        Some(Self {
            client,
            schema_name,
        })
    }

    fn call<T: serde::de::DeserializeOwned>(
        &mut self,
        function: GeneratedSqlFunction,
        request: &(impl Serialize + ?Sized),
    ) -> Result<T, KernelError> {
        function.call_top_level(&mut self.client, request)
    }

    fn apply(
        &mut self,
        mode: ApplyMode,
        key: &str,
        writes: Vec<RowVersionWrite>,
    ) -> AppliedChangeSet {
        self.call(
            GeneratedSqlFunction::ApplyChangeSet,
            &apply_request(mode, key, writes),
        )
        .expect("apply through generated SQL")
    }

    fn revert(&mut self, change_set_id: i64, key: &str) -> Result<AppliedChangeSet, KernelError> {
        self.call(
            GeneratedSqlFunction::RevertChangeSet,
            &RevertChangeSet {
                app_id: AppId::from(APP_ID),
                customer_id: CustomerId::from(CUSTOMER_ID),
                change_set_id,
                actor_id: Some("tester".to_string()),
                idempotency_key: Some(key.to_string()),
                notes: None,
            },
        )
    }

    fn diff(&mut self, change_set_id: i64) -> ChangeSetDiff {
        self.call(
            GeneratedSqlFunction::ChangeSetDiff,
            &ChangeSetDiffRequest {
                app_id: AppId::from(APP_ID),
                customer_id: CustomerId::from(CUSTOMER_ID),
                change_set_id,
                project: vec![],
            },
        )
        .expect("read generated SQL diff")
    }

    fn history(&mut self, record_id: Uuid, stages: Vec<VersionStage>) -> Vec<FieldHistoryEntry> {
        self.call(
            GeneratedSqlFunction::FieldHistory,
            &FieldHistoryRequest {
                app_id: AppId::from(APP_ID),
                customer_id: CustomerId::from(CUSTOMER_ID),
                model_id: ModelId::from("company"),
                record_id,
                field_id: Some(FieldId::from("name")),
                as_of: None,
                limit: None,
                stages,
            },
        )
        .expect("read generated SQL field history")
    }

    fn visible(&mut self, model_id: &str, as_of: &str) -> Vec<VisibleRecord> {
        self.call(
            GeneratedSqlFunction::ReadVisibleRecords,
            &json!({
                "app_id": APP_ID,
                "customer_id": CUSTOMER_ID,
                "model_id": model_id,
                "as_of": as_of,
            }),
        )
        .expect("read generated SQL visible records")
    }

    fn record_id(&mut self, model_id: &str, external_key: &str) -> Uuid {
        self.client
            .query_one(
                &format!(
                    "select id from {model_id}_record where app_id=$1 and customer_id=$2 and external_key=$3"
                ),
                &[&APP_ID, &CUSTOMER_ID, &external_key],
            )
            .expect("read generated SQL record id")
            .get(0)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        support::drop_generated_sql_fixture(&mut self.client, &self.schema_name);
    }
}

fn compiled_schema() -> CompiledManifest {
    let field = |id: &str, field_type: FieldType, required: bool| Field {
        id: FieldId::from(id),
        label: id.to_string(),
        field_type,
        required,
        is_unique: false,
        target_model: None,
        option_set: vec![],
        ..Default::default()
    };
    let mut employer = field("employer", FieldType::Relation, false);
    employer.target_model = Some(ModelId::from("company"));
    CompiledManifest {
        schema: Schema {
            app_id: AppId::from(APP_ID),
            customer_id: CustomerId::from(CUSTOMER_ID),
            version: SchemaVersion::from("2026-08-04.revert-audit-final"),
            models: vec![
                Model {
                    id: ModelId::from("company"),
                    kind: ModelKind::Entity,
                    label: "Company".to_string(),
                    fields: vec![field("name", FieldType::Text, true)],
                    ..Default::default()
                },
                Model {
                    id: ModelId::from("employee"),
                    kind: ModelKind::Entity,
                    label: "Employee".to_string(),
                    fields: vec![field("name", FieldType::Text, true), employer],
                    extensions: kernel::EntityExtensionCapabilities {
                        typed_custom_fields: true,
                        ..Default::default()
                    },
                    ..Default::default()
                },
            ],
            custom_fields: vec![CustomFieldDefinition {
                id: CustomFieldDefinitionId::from("employee_home_company"),
                model_id: ModelId::from("employee"),
                field_id: FieldId::from("home_company"),
                label: "Home Company".to_string(),
                field_type: CustomFieldType::Relation,
                target_model_id: Some(ModelId::from("company")),
                option_set: vec![],
                archived_at: None,
                ..Default::default()
            }],
            change_types: vec![],
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

fn date(value: &str) -> NaiveDate {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").expect("valid date")
}

fn text_values(name: &str) -> BTreeMap<FieldId, FieldValue> {
    BTreeMap::from([(FieldId::from("name"), FieldValue::Text(name.to_string()))])
}

fn employee_values(name: &str, employer: &str) -> BTreeMap<FieldId, FieldValue> {
    BTreeMap::from([
        (FieldId::from("name"), FieldValue::Text(name.to_string())),
        (
            FieldId::from("employer"),
            FieldValue::Relation(RecordKey::ExternalKey(ExternalKey::from(employer))),
        ),
    ])
}

fn custom_relation(employer: &str) -> Vec<CustomFieldEntry> {
    vec![CustomFieldEntry {
        field_id: FieldId::from("home_company"),
        value: CustomFieldValue::Relation(RecordKey::ExternalKey(ExternalKey::from(employer))),
    }]
}

fn custom_value<'a>(
    entries: &'a [CustomFieldEntry],
    field_id: &str,
) -> Option<&'a CustomFieldValue> {
    entries
        .iter()
        .find(|entry| entry.field_id == FieldId::from(field_id))
        .map(|entry| &entry.value)
}

fn write(
    model_id: &str,
    external_key: &str,
    effective_start: &str,
    values: BTreeMap<FieldId, FieldValue>,
    custom_fields: Option<Vec<CustomFieldEntry>>,
) -> RowVersionWrite {
    RowVersionWrite {
        model_id: ModelId::from(model_id),
        new_record_id: None,
        record_key: Some(RecordKey::ExternalKey(ExternalKey::from(external_key))),
        effective_start: date(effective_start),
        values: Some(values),
        custom_fields,
        tombstones_record: false,
        provenance: None,
        ..Default::default()
    }
}

fn apply_request(mode: ApplyMode, key: &str, writes: Vec<RowVersionWrite>) -> ApplyChangeSet {
    ApplyChangeSet {
        app_id: AppId::from(APP_ID),
        customer_id: CustomerId::from(CUSTOMER_ID),
        schema_revision_id: None,
        actor_id: Some("tester".to_string()),
        source_kind: "test".to_string(),
        source_ref: None,
        idempotency_key: Some(key.to_string()),
        change_type_id: None,
        notes: None,
        mode,
        writes,
    }
}

#[test]
fn history_and_diff_annotate_reverted_rows_and_revert_audit_effect_match_generated_sql() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    fixture.apply(
        ApplyMode::Mainline,
        "history-revert-create",
        vec![write(
            "company",
            "acme",
            "2026-05-01",
            text_values("Acme"),
            None,
        )],
    );
    let target = fixture.apply(
        ApplyMode::Mainline,
        "history-revert-update",
        vec![write(
            "company",
            "acme",
            "2026-06-01",
            text_values("Acme Updated"),
            None,
        )],
    );
    let record_id = fixture.record_id("company", "acme");
    let revert = fixture
        .revert(target.id, "history-revert-update-key")
        .unwrap();

    let target_diff = fixture.diff(target.id);
    assert_eq!(target_diff.records[0].stage, VersionStage::Reverted);
    assert_eq!(
        target_diff.records[0].fields[0].after,
        Some(FieldValue::Text("Acme Updated".to_string()))
    );
    let revert_diff = fixture.diff(revert.id);
    assert_eq!(revert_diff.change_set_id, revert.id);
    assert_eq!(revert_diff.source_change_set_id, target.id);
    assert_eq!(
        revert_diff.records[0].fields[0].before,
        Some(FieldValue::Text("Acme Updated".to_string()))
    );
    assert_eq!(
        revert_diff.records[0].fields[0].after,
        Some(FieldValue::Text("Acme".to_string()))
    );

    let history = fixture.history(record_id, vec![]);
    assert_eq!(history.len(), 2);
    assert_eq!(history[0].stage, VersionStage::Mainline);
    assert_eq!(history[0].reverted_by, None);
    assert_eq!(history[1].stage, VersionStage::Reverted);
    assert_eq!(history[1].reverted_by, Some(revert.id));

    let draft = fixture.apply(
        ApplyMode::Draft,
        "history-draft",
        vec![write(
            "company",
            "acme",
            "2026-07-01",
            text_values("Acme Draft"),
            None,
        )],
    );
    let draft_history = fixture.history(record_id, vec![VersionStage::Draft]);
    assert_eq!(draft_history.len(), 1);
    assert_eq!(draft_history[0].change_set_id, draft.id);
    assert_eq!(
        draft_history[0].value,
        Some(FieldValue::Text("Acme Draft".to_string()))
    );
}

#[test]
fn revert_same_day_tips_walk_immediate_predecessors_and_retain_audit_rows_match_generated_sql() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    let versions = ["Acme One", "Acme Two", "Acme Three"]
        .into_iter()
        .enumerate()
        .map(|(index, name)| {
            fixture.apply(
                ApplyMode::Mainline,
                &format!("revert-same-day-walk-{index}"),
                vec![write(
                    "company",
                    "acme",
                    "2026-05-01",
                    text_values(name),
                    None,
                )],
            )
        })
        .collect::<Vec<_>>();
    let record_id = fixture.record_id("company", "acme");
    assert_eq!(
        fixture
            .revert(versions[1].id, "revert-same-day-walk-non-tip")
            .unwrap_err()
            .into_envelope(),
        kernel::ErrorEnvelope {
            code: "revert_conflict".to_string(),
            message: format!(
                "record `{record_id}` has a later mainline version at 2026-05-01 from change_set `{}`",
                versions[2].id
            ),
            details: vec![],
        }
    );

    let third_revert = fixture
        .revert(versions[2].id, "revert-same-day-walk-third")
        .unwrap();
    let after_third = fixture.visible("company", "2026-05-15");
    assert_eq!(
        after_third[0].values.get(&FieldId::from("name")),
        Some(&FieldValue::Text("Acme Two".to_string()))
    );
    assert_eq!(after_third[0].effective_end, None);
    let second_revert = fixture
        .revert(versions[1].id, "revert-same-day-walk-second")
        .unwrap();
    let after_second = fixture.visible("company", "2026-05-15");
    assert_eq!(
        after_second[0].values.get(&FieldId::from("name")),
        Some(&FieldValue::Text("Acme One".to_string()))
    );
    assert_eq!(after_second[0].effective_end, None);

    let retained = fixture
        .client
        .query(
            "select v.change_set_id,v.stage,v.effective_end from company_version v join change_set cs on cs.id=v.change_set_id where v.app_id=$1 and v.customer_id=$2 and v.record_id=$3 order by cs.applied_order",
            &[&APP_ID, &CUSTOMER_ID, &record_id],
        )
        .unwrap();
    assert_eq!(retained.len(), 3);
    assert_eq!(retained[0].get::<_, String>("stage"), "mainline");
    assert_eq!(
        retained[0].get::<_, Option<NaiveDate>>("effective_end"),
        None
    );
    assert_eq!(retained[1].get::<_, String>("stage"), "reverted");
    assert_eq!(retained[2].get::<_, String>("stage"), "reverted");
    for revert in [third_revert, second_revert] {
        let audit = fixture
            .client
            .query_one(
                "select created_order=applied_order orders_match,(select count(*) from company_version where change_set_id=$1) version_count from change_set where id=$1 and source_kind='revert'",
                &[&revert.id],
            )
            .unwrap();
        assert!(audit.get::<_, bool>("orders_match"));
        assert_eq!(audit.get::<_, i64>("version_count"), 0);
    }
}

#[test]
fn revert_same_day_restores_declared_and_custom_relations_match_generated_sql() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    for key in ["acme", "zenith"] {
        fixture.apply(
            ApplyMode::Mainline,
            &format!("revert-relation-company-{key}"),
            vec![write("company", key, "2026-05-01", text_values(key), None)],
        );
    }
    let acme_id = fixture.record_id("company", "acme");
    fixture.apply(
        ApplyMode::Mainline,
        "revert-relation-employee-acme",
        vec![write(
            "employee",
            "alice",
            "2026-05-01",
            employee_values("Alice", "acme"),
            Some(custom_relation("acme")),
        )],
    );
    let target = fixture.apply(
        ApplyMode::Mainline,
        "revert-relation-employee-zenith",
        vec![write(
            "employee",
            "alice",
            "2026-05-01",
            employee_values("Alice", "zenith"),
            Some(custom_relation("zenith")),
        )],
    );
    fixture
        .revert(target.id, "revert-relation-employee-target")
        .unwrap();
    let visible = fixture.visible("employee", "2026-05-15");
    assert_eq!(
        visible[0].values.get(&FieldId::from("employer")),
        Some(&FieldValue::Relation(RecordKey::RecordId(acme_id)))
    );
    assert_eq!(
        custom_value(&visible[0].custom_fields, "home_company"),
        Some(&CustomFieldValue::Relation(RecordKey::RecordId(acme_id)))
    );
}
