use std::collections::BTreeMap;
use std::env;
use support::trusted_human;

use chrono::NaiveDate;
use kernel::testing::GeneratedSqlFunction;
use kernel::{
    connect_postgres, ActiveSchemaRevision, App, AppId, AppliedChangeSet, ApplyChangeSet,
    ApplyMode, CustomFieldDefinition, CustomFieldDefinitionId, CustomFieldEntry, CustomFieldType,
    CustomFieldValue, CustomerId, ErrorEnvelope, ExternalKey, Field, FieldId, FieldType,
    FieldValue, KernelError, Model, ModelId, ModelKind, MoneyRatePeriod, MoneyRateValue, RecordKey,
    RevertChangeSet, RowVersionWrite, Schema, SchemaVersion, VisibleRecord,
};
use postgres::Client;
use rust_decimal::Decimal;
use schema_compiler::{
    compile_app_artifact_json, compile_sql_artifact_manifest, render_sql_artifact_bundle,
    CompiledAppArtifact, CompiledManifest,
};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};
use uuid::Uuid;

mod support;

const APP_ID: &str = "ops.revenue/v1";
const CUSTOMER_ID: &str = "018f6bf3-1ea5-7812-9a5a-a1f5b04f0001";

struct Fixture {
    client: Client,
    schema_name: String,
    schema: Schema,
    app_artifact: CompiledAppArtifact,
}

impl Fixture {
    fn connect() -> Option<Self> {
        let database_url = match env::var("KERNEL_TEST_DATABASE_URL") {
            Ok(url) => url,
            Err(env::VarError::NotPresent) => {
                eprintln!(
                    "skipping final generated SQL wire parity test: KERNEL_TEST_DATABASE_URL is absent"
                );
                return None;
            }
            Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
        };
        let mut client = connect_postgres(&database_url).expect("connect to PostgreSQL");
        let schema_name = format!("kernel_wire_final_{}", Uuid::new_v4().simple());
        client
            .batch_execute(&format!(
                "create schema \"{schema_name}\"; set search_path to \"{schema_name}\""
            ))
            .expect("create isolated generated SQL wire schema");

        let app_artifact = test_app_artifact();
        let schema = app_artifact.schema.clone();
        assert_eq!(schema, test_schema());
        let compiled = CompiledManifest {
            schema: schema.clone(),
            extras: app_artifact.extras.clone(),
        };
        let manifest =
            compile_sql_artifact_manifest(&compiled).expect("compile generated SQL artifacts");
        trusted_human::before_install(&mut client);
        client
            .batch_execute(&render_sql_artifact_bundle(&manifest))
            .expect("install generated SQL bundle");
        let schema_json = serde_json::to_value(&schema).expect("serialize schema");
        client
            .execute(
                r#"
                insert into schema_revision (
                  id, app_id, customer_id, version, base_schema, customer_overlay,
                  schema, activated_at, materialized_at
                ) values (1, $1, $2, $3, $4, '{}'::jsonb, $4, now(), now())
                "#,
                &[
                    &schema.app_id.as_str(),
                    &schema.customer_id.as_str(),
                    &schema.version.as_str(),
                    &schema_json,
                ],
            )
            .expect("activate generated SQL schema");

        trusted_human::bind(
            &mut client,
            schema.app_id.as_str(),
            schema.customer_id.as_str(),
            "wire-test",
        );
        Some(Self {
            client,
            schema_name,
            schema,
            app_artifact,
        })
    }

    fn call<T: DeserializeOwned>(
        &mut self,
        function: GeneratedSqlFunction,
        request: &(impl Serialize + ?Sized),
    ) -> Result<T, KernelError> {
        function.call_top_level(&mut self.client, request)
    }

    fn call_json<TRequest, TResult>(
        &mut self,
        function: GeneratedSqlFunction,
        request: Value,
    ) -> Result<TResult, KernelError>
    where
        TRequest: DeserializeOwned + Serialize,
        TResult: DeserializeOwned,
    {
        function.call_json_top_level::<TRequest, TResult>(&mut self.client, request)
    }

    fn apply(&mut self, request: &ApplyChangeSet) -> Result<AppliedChangeSet, KernelError> {
        self.call(GeneratedSqlFunction::ApplyChangeSet, request)
    }

    fn read(&mut self, as_of: &str) -> Result<Vec<VisibleRecord>, KernelError> {
        self.call(
            GeneratedSqlFunction::ReadVisibleRecords,
            &json!({
                "app_id": APP_ID,
                "customer_id": CUSTOMER_ID,
                "model_id": "record",
                "as_of": as_of,
            }),
        )
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        support::drop_generated_sql_fixture(&mut self.client, &self.schema_name);
    }
}

fn test_schema() -> Schema {
    Schema {
        app_id: AppId::from(APP_ID),
        customer_id: CustomerId::from(CUSTOMER_ID),
        version: SchemaVersion::from("2026-08-04.wire-final"),
        models: vec![Model {
            id: ModelId::from("record"),
            kind: ModelKind::Entity,
            label: "Record".to_string(),
            extensions: kernel::EntityExtensionCapabilities {
                typed_custom_fields: true,
                ..Default::default()
            },
            fields: vec![
                Field {
                    id: FieldId::from("display_name"),
                    label: "Display Name".to_string(),
                    field_type: FieldType::Text,
                    required: true,
                    is_unique: true,
                    target_model: None,
                    option_set: vec![],
                    ..Default::default()
                },
                Field {
                    id: FieldId::from("rate"),
                    label: "Rate".to_string(),
                    field_type: FieldType::MoneyRate,
                    required: false,
                    is_unique: false,
                    target_model: None,
                    option_set: vec![],
                    ..Default::default()
                },
                Field {
                    id: FieldId::from("quantity"),
                    label: "Quantity".to_string(),
                    field_type: FieldType::Number,
                    required: false,
                    is_unique: false,
                    target_model: None,
                    option_set: vec![],
                    ..Default::default()
                },
            ],
            ..Default::default()
        }],
        custom_fields: vec![CustomFieldDefinition {
            id: CustomFieldDefinitionId::from("record_bonus"),
            model_id: ModelId::from("record"),
            field_id: FieldId::from("bonus"),
            label: "Bonus".to_string(),
            field_type: CustomFieldType::MoneyRate,
            target_model_id: None,
            option_set: vec![],
            archived_at: None,
            ..Default::default()
        }],
        change_types: vec![],
    }
}

fn test_app_artifact() -> CompiledAppArtifact {
    let manifest = json!({
        "app_id": APP_ID,
        "customer_id": CUSTOMER_ID,
        "version": "2026-08-04.wire-final",
        "label": "Core App",
        "connectors": {"csv": {"enabled": true}},
        "agents": {"reviewer": {"enabled": true}},
        "models": [{
            "id": "record",
            "kind": "entity",
            "label": "Record",
            "extensions": {"typed_custom_fields": true},
            "fields": [
                {
                    "id": "display_name",
                    "label": "Display Name",
                    "type": "text",
                    "required": true,
                    "is_unique": true
                },
                {"id": "rate", "label": "Rate", "type": "money_rate"},
                {"id": "quantity", "label": "Quantity", "type": "number"}
            ]
        }],
        "custom_fields": [{
            "id": "record_bonus",
            "model": "record",
            "field": "bonus",
            "label": "Bonus",
            "type": "money_rate"
        }]
    });
    compile_app_artifact_json(&manifest.to_string())
        .expect("compile complete generated client app artifact")
}

fn date(value: &str) -> NaiveDate {
    value.parse().expect("valid date")
}

fn values(name: &str) -> BTreeMap<FieldId, FieldValue> {
    BTreeMap::from([(
        FieldId::from("display_name"),
        FieldValue::Text(name.to_string()),
    )])
}

fn write(key: RecordKey, effective_start: &str, name: &str) -> RowVersionWrite {
    RowVersionWrite {
        model_id: ModelId::from("record"),
        record_key: Some(key),
        new_record_id: None,
        effective_start: date(effective_start),
        values: Some(values(name)),
        custom_fields: None,
        tombstones_record: false,
        provenance: None,
        ..Default::default()
    }
}

fn external_write(key: &str, effective_start: &str, name: &str) -> RowVersionWrite {
    write(
        RecordKey::ExternalKey(ExternalKey::from(key)),
        effective_start,
        name,
    )
}

fn apply_request(key: &str, mode: ApplyMode, writes: Vec<RowVersionWrite>) -> ApplyChangeSet {
    ApplyChangeSet {
        app_id: AppId::from(APP_ID),
        customer_id: CustomerId::from(CUSTOMER_ID),
        schema_revision_id: None,
        actor_id: Some("wire-test".to_string()),
        source_kind: "test".to_string(),
        source_ref: Some(format!("wire://{key}")),
        idempotency_key: Some(key.to_string()),
        change_type_id: None,
        notes: Some("wire parity".to_string()),
        mode,
        writes,
    }
}

fn error(error: KernelError) -> ErrorEnvelope {
    error.into_envelope()
}

#[test]
fn app_contract_round_trips_through_json_match_generated_sql_client() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    let active: ActiveSchemaRevision = fixture
        .call(
            GeneratedSqlFunction::ReadActiveSchemaRevision,
            &json!({"app_id": APP_ID, "customer_id": CUSTOMER_ID}),
        )
        .expect("read and decode active schema through generated API");
    let app = fixture
        .app_artifact
        .app_with_schema(active.schema)
        .expect("combine generated client metadata with SQL-backed schema");

    let wire = serde_json::to_value(&app).expect("encode generated client app artifact");
    assert_eq!(wire["id"], APP_ID);
    assert_eq!(wire["label"], "Core App");
    assert_eq!(wire["schema"]["customer_id"], CUSTOMER_ID);
    assert_eq!(wire["connectors"]["csv"]["enabled"], true);
    assert_eq!(wire["agents"]["reviewer"]["enabled"], true);
    let decoded: App = serde_json::from_value(wire).expect("decode generated client app artifact");
    assert_eq!(decoded, app);
    assert_eq!(decoded.schema, fixture.schema);
}

#[test]
fn custom_field_entries_serialize_as_field_type_value_objects_match_generated_sql() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    let entry = CustomFieldEntry {
        field_id: FieldId::from("bonus"),
        value: CustomFieldValue::MoneyRate(MoneyRateValue {
            amount: Decimal::new(125000, 2),
            currency: "USD".to_string(),
            period: MoneyRatePeriod::Annual,
        }),
    };
    let mut request = apply_request(
        "custom-field-shape",
        ApplyMode::Mainline,
        vec![external_write("record-1", "2026-05-04", "Example Record")],
    );
    request.writes[0].custom_fields = Some(vec![entry.clone()]);
    fixture
        .apply(&request)
        .expect("apply custom field through generated SQL");

    let records = fixture
        .read("2026-05-04")
        .expect("read generated custom field");
    assert_eq!(records[0].custom_fields, vec![entry.clone()]);
    let wire = serde_json::to_value(&records[0].custom_fields[0]).unwrap();
    assert_eq!(wire["field_id"], "bonus");
    assert_eq!(wire["type"], "money_rate");
    assert_eq!(wire["value"]["amount"], "1250.00");
    assert_eq!(wire["value"]["period"], "annual");
}

#[test]
fn error_envelope_preserves_machine_readable_validation_details_match_generated_sql() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    let request = apply_request(
        "validation-envelope",
        ApplyMode::Mainline,
        vec![RowVersionWrite {
            model_id: ModelId::from("missing_model"),
            ..external_write("record-1", "2026-05-04", "Example Record")
        }],
    );
    let envelope = error(
        fixture
            .apply(&request)
            .expect_err("unknown model must fail"),
    );
    let wire = serde_json::to_value(&envelope).unwrap();
    assert_eq!(envelope.code, "contract_validation_failed");
    assert_eq!(envelope.message, "Contract validation failed");
    assert_eq!(envelope.details[0].path, "writes[0].model_id");
    assert_eq!(envelope.details[0].code, "unknown_write_model");
    assert_eq!(wire["details"][0]["path"], "writes[0].model_id");
}

#[test]
fn db_error_envelope_uses_stable_machine_readable_codes_match_generated_sql() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    fixture
        .apply(&apply_request(
            "request-1",
            ApplyMode::Mainline,
            vec![external_write("record-1", "2026-05-04", "Example Record")],
        ))
        .unwrap();
    let envelope = error(
        fixture
            .apply(&apply_request(
                "request-1",
                ApplyMode::Mainline,
                vec![external_write("record-1", "2026-05-04", "Changed")],
            ))
            .expect_err("changed idempotent request must fail"),
    );
    assert_eq!(envelope.code, "idempotency_conflict");
    assert_eq!(
        envelope.message,
        "Idempotency key was reused for a different request"
    );
    assert_eq!(envelope.details[0].path, "idempotency_key");
    assert_eq!(envelope.details[0].code, "idempotency_conflict");
    assert!(envelope.details[0].message.contains("request-1"));
}

#[test]
fn unique_field_conflict_envelope_carries_generic_structured_details_match_generated_sql() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    fixture
        .apply(&apply_request(
            "unique-first",
            ApplyMode::Mainline,
            vec![external_write("record-1", "2026-05-04", "Duplicate")],
        ))
        .unwrap();
    let envelope = error(
        fixture
            .apply(&apply_request(
                "unique-second",
                ApplyMode::Mainline,
                vec![external_write("record-2", "2026-05-04", "Duplicate")],
            ))
            .expect_err("duplicate unique value must fail"),
    );
    assert_eq!(envelope.code, "unique_field_conflict");
    assert_eq!(envelope.message, "Unique field value already exists");
    assert_eq!(
        envelope
            .details
            .iter()
            .map(|detail| (detail.path.as_str(), detail.message.as_str()))
            .collect::<Vec<_>>(),
        vec![
            ("model", "record"),
            ("field", "display_name"),
            ("value", "Duplicate"),
        ]
    );
}

#[test]
fn db_error_envelope_strips_internal_error_details_match_generated_sql_client() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    let mut schema_json = serde_json::to_value(&fixture.schema).unwrap();
    schema_json["models"][0]
        .as_object_mut()
        .unwrap()
        .remove("kind");
    fixture
        .client
        .execute(
            "update schema_revision set schema = $1 where id = 1",
            &[&schema_json],
        )
        .expect("inject malformed stored schema");
    let envelope = error(
        fixture
            .call::<ActiveSchemaRevision>(
                GeneratedSqlFunction::ReadActiveSchemaRevision,
                &json!({"app_id": APP_ID, "customer_id": CUSTOMER_ID}),
            )
            .expect_err("generated client must reject malformed endpoint data"),
    );
    assert_eq!(envelope.code, "serialization_error");
    assert_eq!(envelope.message, "Kernel serialization failed");
    assert!(envelope.details.is_empty());
}

#[test]
fn db_error_envelope_preserves_schema_drift_detail_shape_match_generated_sql() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    let draft = fixture
        .apply(&apply_request(
            "schema-drift",
            ApplyMode::Draft,
            vec![external_write("record-1", "2026-05-04", "Example Record")],
        ))
        .unwrap();
    fixture
        .client
        .execute(
            "update record_version set stage = 'mainline', applied_at = now() where change_set_id = $1",
            &[&draft.id],
        )
        .expect("inject generated catalog drift");
    let envelope = error(
        fixture
            .read("2026-05-04")
            .expect_err("drift must fail closed"),
    );
    assert_eq!(envelope.code, "schema_drift");
    assert_eq!(envelope.message, "Schema drift detected");
    assert_eq!(envelope.details[0].path, "object");
    assert_eq!(envelope.details[0].code, "schema_drift");
    assert!(envelope.details[0].message.contains("record_version:"));
}

#[test]
fn db_error_envelope_preserves_bare_details_shape_match_generated_sql() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    fixture
        .apply(&apply_request(
            "revert-create",
            ApplyMode::Mainline,
            vec![external_write("record-1", "2026-05-01", "One")],
        ))
        .unwrap();
    let target = fixture
        .apply(&apply_request(
            "revert-target",
            ApplyMode::Mainline,
            vec![external_write("record-1", "2026-06-01", "Two")],
        ))
        .unwrap();
    fixture
        .apply(&apply_request(
            "revert-later",
            ApplyMode::Mainline,
            vec![external_write("record-1", "2026-07-01", "Three")],
        ))
        .unwrap();
    let envelope = error(
        fixture
            .call::<AppliedChangeSet>(
                GeneratedSqlFunction::RevertChangeSet,
                &RevertChangeSet {
                    app_id: AppId::from(APP_ID),
                    customer_id: CustomerId::from(CUSTOMER_ID),
                    change_set_id: target.id,
                    actor_id: Some("wire-test".to_string()),
                    idempotency_key: Some("revert-conflict".to_string()),
                    notes: None,
                },
            )
            .expect_err("non-tip revert must fail"),
    );
    assert_eq!(envelope.code, "revert_conflict");
    assert!(envelope.message.contains("has a later mainline version"));
    assert!(envelope.details.is_empty());
}

#[test]
fn record_ids_serialize_as_uuids_not_freeform_strings_match_generated_sql_client() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    let record_id = Uuid::parse_str("018f6bf3-1ea5-7812-9a5a-a1f5b04f0002").unwrap();
    let mut create = external_write("record-1", "2026-05-04", "Example Record");
    create.record_key = None;
    create.new_record_id = Some(record_id);
    fixture
        .apply(&apply_request(
            "uuid-create",
            ApplyMode::Mainline,
            vec![create],
        ))
        .unwrap();
    fixture
        .apply(&apply_request(
            "uuid-update",
            ApplyMode::Mainline,
            vec![write(
                RecordKey::RecordId(record_id),
                "2026-06-04",
                "Updated Record",
            )],
        ))
        .expect("generated SQL accepts UUID record key");
    assert_eq!(fixture.read("2026-06-04").unwrap()[0].record_id, record_id);

    let malformed = json!({
        "app_id": APP_ID,
        "customer_id": CUSTOMER_ID,
        "source_kind": "test",
        "mode": "mainline",
        "writes": [{
            "model_id": "record",
            "record_key": {"type": "record_id", "value": "freeform-id"},
            "effective_start": "2026-07-04",
            "values": {"display_name": {"type": "text", "value": "Invalid"}}
        }]
    });
    let envelope = error(
        fixture
            .call_json::<ApplyChangeSet, AppliedChangeSet>(
                GeneratedSqlFunction::ApplyChangeSet,
                malformed,
            )
            .expect_err("generated client rejects non-UUID record id"),
    );
    assert_eq!(envelope.code, "serialization_error");
    assert!(envelope.details.is_empty());
}

#[test]
fn apply_contract_round_trips_through_json_match_generated_sql_client() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    let mut request = apply_request(
        "apply-round-trip",
        ApplyMode::Mainline,
        vec![external_write("record-1", "2026-05-04", "Example Record")],
    );
    request.writes[0].values.as_mut().unwrap().insert(
        FieldId::from("rate"),
        FieldValue::MoneyRate(MoneyRateValue {
            amount: Decimal::new(125000, 2),
            currency: "USD".to_string(),
            period: MoneyRatePeriod::Annual,
        }),
    );
    request.writes[0].values.as_mut().unwrap().insert(
        FieldId::from("quantity"),
        FieldValue::Number(Decimal::new(125, 1)),
    );
    let wire = serde_json::to_value(&request).expect("encode generated SQL request");
    assert_eq!(wire["writes"][0]["record_key"]["type"], "external_key");
    assert_eq!(
        wire["writes"][0]["values"]["rate"]["value"]["amount"],
        "1250.00"
    );
    assert_eq!(
        wire["writes"][0]["values"]["rate"]["value"]["period"],
        "annual"
    );
    assert_eq!(wire["writes"][0]["values"]["quantity"]["value"], "12.5");
    fixture
        .call_json::<ApplyChangeSet, AppliedChangeSet>(GeneratedSqlFunction::ApplyChangeSet, wire)
        .expect("generated client decodes and applies request");
    let record = &fixture.read("2026-05-04").unwrap()[0];
    assert_eq!(record.values, request.writes[0].values.clone().unwrap());

    let anonymous = serde_json::to_value(RowVersionWrite {
        model_id: ModelId::from("record"),
        record_key: None,
        new_record_id: None,
        effective_start: date("2026-05-04"),
        values: None,
        custom_fields: None,
        tombstones_record: false,
        provenance: None,
        ..Default::default()
    })
    .unwrap();
    assert_eq!(anonymous["record_key"], Value::Null);
    assert!(anonymous.get("new_record_id").is_none());

    let mut malformed = serde_json::to_value(&request).unwrap();
    malformed["idempotency_key"] = json!("numeric-number");
    malformed["writes"][0]["record_key"]["value"] = json!("record-2");
    malformed["writes"][0]["values"]["quantity"]["value"] = json!(12.5);
    let envelope = error(
        fixture
            .call_json::<ApplyChangeSet, AppliedChangeSet>(
                GeneratedSqlFunction::ApplyChangeSet,
                malformed,
            )
            .expect_err("generated client rejects floating-point number values"),
    );
    assert_eq!(envelope.code, "serialization_error");
}

#[test]
fn apply_contract_rejects_removed_reason_field_match_generated_sql_client() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    let malformed = json!({
        "app_id": APP_ID,
        "customer_id": CUSTOMER_ID,
        "source_kind": "user_edit",
        "reason": "removed field",
        "mode": "mainline",
        "writes": [{
            "model_id": "record",
            "record_key": {"type": "external_key", "value": "record-1"},
            "effective_start": "2026-05-04",
            "values": {
                "display_name": {"type": "text", "value": "Example Record"}
            }
        }]
    });
    let envelope = error(
        fixture
            .call_json::<ApplyChangeSet, AppliedChangeSet>(
                GeneratedSqlFunction::ApplyChangeSet,
                malformed,
            )
            .expect_err("generated client rejects removed reason field"),
    );
    assert_eq!(envelope.code, "serialization_error");
    assert_eq!(envelope.message, "Kernel serialization failed");
    assert!(envelope.details.is_empty());
    let count: i64 = fixture
        .client
        .query_one("select count(*) from change_set", &[])
        .unwrap()
        .get(0);
    assert_eq!(count, 0, "rejected client request must not reach SQL");
}
