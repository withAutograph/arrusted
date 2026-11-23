#[path = "support/trusted_human.rs"]
mod trusted_human;
use std::env;

use kernel::{
    AppId, CustomerId, Field, FieldId, FieldType, LookupSetAvailabilityResult,
    ManyRelationDefinition, Model, ModelId, ModelKind, Schema, SchemaVersion,
};
use postgres::{Client, NoTls};
use schema_compiler::{
    compile_sql_artifact_manifest, render_sql_artifact_bundle, CompiledManifest,
    NormalizedManifestExtras,
};
use serde_json::{json, Value};
use uuid::Uuid;

const APP_ID: &str = "lookup_lifecycle_app";

struct LookupFixture {
    client: Client,
    schema_name: String,
    revision_id: i64,
}

impl LookupFixture {
    fn connect() -> Option<Self> {
        let database_url = match env::var("KERNEL_TEST_DATABASE_URL") {
            Ok(url) => url,
            Err(env::VarError::NotPresent) => {
                eprintln!("skipping lookup lifecycle parity: KERNEL_TEST_DATABASE_URL is absent");
                return None;
            }
            Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
        };
        let mut client = Client::connect(&database_url, NoTls)
            .unwrap_or_else(|error| panic!("connect lookup lifecycle database: {error}"));
        let schema_name = format!("kernel_lookup_lifecycle_{}", Uuid::new_v4().simple());
        client
            .batch_execute(&format!(
                r#"create schema "{schema_name}"; set search_path to "{schema_name}""#
            ))
            .expect("create lookup lifecycle schema");

        let active_schema = schema("tenant_a");
        let compiled = CompiledManifest {
            schema: active_schema.clone(),
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
        let manifest = compile_sql_artifact_manifest(&compiled).expect("compile lookup SQL");
        trusted_human::before_install(&mut client);
        client
            .batch_execute(&render_sql_artifact_bundle(&manifest))
            .expect("install lookup SQL");
        let revision_id = activate(&mut client, &active_schema);
        activate(&mut client, &schema("tenant_b"));
        client
            .batch_execute(
                r#"
                insert into lookup_storage_authority(
                  app_id,customer_id,model_id,schema_hash,authority,
                  legacy_record_table,legacy_version_table,activated_at
                )
                select 'lookup_lifecycle_app',customer_id,model_id,repeat('a',64),'generic',
                       model_id || '_record',model_id || '_version',now()
                from (values ('tenant_a'),('tenant_b')) tenants(customer_id)
                cross join (values ('region'),('department')) models(model_id)
                "#,
            )
            .expect("activate generic lookup authority for lifecycle fixtures");

        trusted_human::bind(&mut client, APP_ID, "tenant_a", "lookup-admin");
        trusted_human::bind(&mut client, APP_ID, "tenant_a", "lookup-tester");
        trusted_human::bind(&mut client, APP_ID, "tenant_b", "lookup-admin");
        trusted_human::bind(&mut client, APP_ID, "tenant_b", "lookup-tester");
        Some(Self {
            client,
            schema_name,
            revision_id,
        })
    }

    fn call(&mut self, function: &str, request: Value) -> Value {
        if let Some(actor) = request["actor_id"].as_str() {
            trusted_human::select(&mut self.client, actor);
        }
        self.client
            .query_one(&format!("select {function}($1::jsonb)"), &[&request])
            .unwrap_or_else(|error| panic!("call {function}: {error:?}"))
            .get(0)
    }

    fn ok(&mut self, function: &str, request: Value) -> Value {
        let result = self.call(function, request.clone());
        assert_eq!(
            result.get("ok"),
            Some(&Value::Bool(true)),
            "{function} request={request:#} result={result:#}"
        );
        result["data"].clone()
    }

    fn apply(&mut self, customer_id: &str, mode: &str, key: &str, writes: Value) -> i64 {
        let request = json!({
            "app_id": APP_ID,
            "customer_id": customer_id,
            "actor_id": "lookup-tester",
            "source_kind": "test",
            "idempotency_key": key,
            "mode": mode,
            "writes": writes,
        });
        let result = self.call("kernel_apply_change_set", request.clone());
        if result.get("ok") != Some(&Value::Bool(true)) {
            let internal = self
                .client
                .query_one(
                    "select kernel_apply_execute($1::jsonb,false,null::bigint)",
                    &[&request],
                )
                .map(|row| row.get::<_, Value>(0))
                .unwrap_or_else(|error| {
                    panic!(
                        "kernel_apply_change_set={result:#}; internal={error}; db={:?}",
                        error.as_db_error()
                    )
                });
            panic!("kernel_apply_change_set={result:#}; internal={internal:#}");
        }
        result["data"]["id"].as_i64().expect("change set id")
    }

    fn draft_and_approve(&mut self, key: &str, writes: Value) -> i64 {
        let change_set_id = self.apply("tenant_a", "draft", key, writes);
        self.ok(
            "kernel_approve_draft_change_set",
            json!({"app_id":APP_ID,"customer_id":"tenant_a","actor_id":"lookup-tester","change_set_id":change_set_id}),
        );
        change_set_id
    }
}

impl Drop for LookupFixture {
    fn drop(&mut self) {
        let _ = self
            .client
            .batch_execute("rollback; set search_path to public");
        let _ = trusted_human::drop_fixture(&mut self.client, &self.schema_name);
    }
}

fn activate(client: &mut Client, schema: &Schema) -> i64 {
    let schema_json = serde_json::to_value(schema).expect("serialize lookup schema");
    client
        .query_one(
            r#"
            insert into schema_revision (
              app_id,customer_id,version,base_schema,customer_overlay,schema,activated_at,materialized_at
            ) values ($1,$2,$3,$4,'{}'::jsonb,$4,now(),now()) returning id
            "#,
            &[
                &schema.app_id.as_str(),
                &schema.customer_id.as_str(),
                &schema.version.as_str(),
                &schema_json,
            ],
        )
        .expect("activate lookup schema")
        .get(0)
}

fn schema(customer_id: &str) -> Schema {
    let region = Model {
        id: ModelId::from("region"),
        kind: ModelKind::Lookup,
        label: "Region".to_string(),
        display_field_id: Some(FieldId::from("name")),
        fields: vec![text_field("name", true)],
        ..Model::default()
    };
    let department = Model {
        id: ModelId::from("department"),
        kind: ModelKind::Lookup,
        label: "Department".to_string(),
        display_field_id: Some(FieldId::from("name")),
        fields: vec![
            text_field("name", true),
            Field {
                id: FieldId::from("region"),
                label: "Region".to_string(),
                field_type: FieldType::Relation,
                target_model: Some(ModelId::from("region")),
                ..Field::default()
            },
        ],
        many_relations: vec![ManyRelationDefinition {
            id: FieldId::from("available_regions"),
            label: "Available Regions".to_string(),
            target_model: ModelId::from("region"),
            ..ManyRelationDefinition::default()
        }],
        ..Model::default()
    };
    let employee = Model {
        id: ModelId::from("employee"),
        kind: ModelKind::Entity,
        label: "Employee".to_string(),
        fields: vec![
            text_field("name", true),
            Field {
                id: FieldId::from("region"),
                label: "Region".to_string(),
                field_type: FieldType::Relation,
                target_model: Some(ModelId::from("region")),
                ..Field::default()
            },
        ],
        ..Model::default()
    };
    Schema {
        app_id: AppId::from(APP_ID),
        customer_id: CustomerId::from(customer_id),
        version: SchemaVersion::from("2026-08-05.lookup-lifecycle"),
        models: vec![region, department, employee],
        custom_fields: vec![],
        change_types: vec![],
    }
}

fn text_field(id: &str, required: bool) -> Field {
    Field {
        id: FieldId::from(id),
        label: id.to_string(),
        field_type: FieldType::Text,
        required,
        ..Field::default()
    }
}

fn record_key(record_id: Uuid) -> Value {
    json!({"type":"record_id","value":record_id})
}

fn text(value: &str) -> Value {
    json!({"type":"text","value":value})
}

#[test]
fn generic_lookup_drafts_reads_audit_labels_and_retirement_are_model_and_tenant_safe() {
    let Some(mut fixture) = LookupFixture::connect() else {
        return;
    };
    let region_id = Uuid::new_v4();
    let department_id = Uuid::new_v4();
    let employee_id = Uuid::new_v4();
    let availability_request = |record_id: Value| {
        json!({
            "app_id":APP_ID,"customer_id":"tenant_a","model_id":"region",
            "record_id":record_id,"availability":"retired","effective_start":"2026-08-06",
            "schema_revision_id":fixture.revision_id,"actor_id":"lookup-admin",
            "idempotency_key":"invalid-not-applied","reason":"validate request"
        })
    };
    let mut unknown_field = availability_request(json!(region_id));
    unknown_field["unexpected"] = json!(true);
    let mut invalid_date = availability_request(json!(region_id));
    invalid_date["effective_start"] = json!("2026-02-30");
    let mut invalid_revision = availability_request(json!(region_id));
    invalid_revision["schema_revision_id"] = json!("1");
    let mut invalid_availability = availability_request(json!(region_id));
    invalid_availability["availability"] = json!("deleted");
    for (request, detail_code) in [
        (unknown_field, "unknown_field"),
        (
            availability_request(json!("not-a-uuid")),
            "invalid_record_id",
        ),
        (invalid_date, "invalid_date"),
        (invalid_revision, "invalid_schema_revision_id"),
        (invalid_availability, "invalid_lifecycle"),
    ] {
        let result = fixture.call("kernel_lookup_set_availability", request);
        assert_eq!(result["error"]["code"], "contract_validation_failed");
        assert_eq!(result["error"]["details"][0]["code"], detail_code);
    }
    fixture
        .client
        .execute(
            "insert into lookup_record(app_id,customer_id,model_id,id) values ($1,'tenant_a','region',$2),($1,'tenant_a','department',$3)",
            &[&APP_ID, &region_id, &department_id],
        )
        .expect("preallocate lookup identities for lifecycle routing test");

    fixture.draft_and_approve(
        "region-create",
        json!([{
            "model_id":"region","record_key":record_key(region_id),"effective_start":"2026-08-05",
            "values":{"name":text("North")}
        }]),
    );
    fixture.draft_and_approve(
        "employee-create",
        json!([{
            "model_id":"employee","new_record_id":employee_id,"effective_start":"2026-08-05",
            "values":{"name":text("Ada"),"region":{"type":"relation","value":record_key(region_id)}}
        }]),
    );
    let create_id = fixture.draft_and_approve(
        "department-create",
        json!([{
            "model_id":"department","record_key":record_key(department_id),"effective_start":"2026-08-05",
            "values":{
                "name":text("Finance")
            }
        }]),
    );
    fixture
        .client
        .execute(
            "update lookup_version set many_relations=jsonb_build_object('available_regions',jsonb_build_array($1::text)) where app_id=$2 and customer_id='tenant_a' and model_id='department' and record_id=$3 and change_set_id=$4",
            &[&region_id.to_string(), &APP_ID, &department_id, &create_id],
        )
        .expect("seed inherited many-relation snapshot for lifecycle routing test");
    let rename_id = fixture.draft_and_approve(
        "department-rename",
        json!([{
            "model_id":"department","record_key":record_key(department_id),
            "effective_start":"2026-08-05","values":{"name":text("Finance Ops")}
        }]),
    );
    let reference_count = fixture.ok(
        "kernel_lookup_reference_count",
        json!({
            "app_id":APP_ID,"customer_id":"tenant_a","model_id":"region",
            "record_id":region_id,"as_of":"2026-08-05"
        }),
    );
    assert_eq!(
        reference_count["count"], 2,
        "reference counts include generic many-relations and typed entity relations"
    );

    let label: Value = fixture
        .client
        .query_one(
            "select kernel_lookup_label_at($1,$2,$3,$4,$5::text::date,null::bigint,null::bigint)",
            &[
                &APP_ID,
                &"tenant_a",
                &"department",
                &department_id,
                &"2026-08-05",
            ],
        )
        .unwrap_or_else(|error| panic!("lookup label: {error}; db={:?}", error.as_db_error()))
        .get(0);
    assert_eq!(label["label"], "Finance Ops");

    let _ = fixture.ok(
        "kernel_lookup_resolve_batch",
        json!({
            "app_id":APP_ID,"customer_id":"tenant_a","model_id":"department",
            "as_of":"2026-08-05","record_ids":[department_id]
        }),
    );

    let hydrated = fixture.ok(
        "kernel_lookup_hydrate",
        json!({
            "app_id":APP_ID,"customer_id":"tenant_a","as_of":"2026-08-05",
            "references":[{
                "model_id":"department","record_id":department_id,
                "effective_start":"2026-08-05","event_change_set_id":create_id
            }]
        }),
    );
    assert_eq!(hydrated[0]["event"]["label"], "Finance");
    assert_eq!(hydrated[0]["current"]["label"], "Finance Ops");

    let discarded_id = fixture.apply(
        "tenant_a",
        "draft",
        "department-discard",
        json!([{
            "model_id":"department","record_key":record_key(department_id),
            "effective_start":"2026-08-05","values":{"name":text("Discard Me")}
        }]),
    );
    let discarded_read = fixture.ok(
        "kernel_read_draft_change_set",
        json!({"app_id":APP_ID,"customer_id":"tenant_a","change_set_id":discarded_id}),
    );
    assert_eq!(discarded_read[0]["values"]["name"]["value"], "Discard Me");
    assert_eq!(
        discarded_read[0]["many_relations"]["available_regions"][0],
        region_id.to_string()
    );
    let drafts = fixture.ok(
        "kernel_list_draft_change_sets",
        json!({"app_id":APP_ID,"customer_id":"tenant_a"}),
    );
    assert!(drafts
        .as_array()
        .expect("draft list")
        .iter()
        .any(|draft| draft["id"] == discarded_id));
    fixture.ok(
        "kernel_discard_draft_change_set",
        json!({"app_id":APP_ID,"customer_id":"tenant_a","change_set_id":discarded_id}),
    );

    let draft_id = fixture.apply(
        "tenant_a",
        "draft",
        "department-approve",
        json!([{
            "model_id":"department","record_key":record_key(department_id),
            "effective_start":"2026-08-05","values":{"name":text("Finance Approved")}
        }]),
    );
    fixture.ok(
        "kernel_approve_draft_change_set",
        json!({"app_id":APP_ID,"customer_id":"tenant_a","actor_id":"lookup-tester","change_set_id":draft_id}),
    );
    let visible = fixture.ok(
        "kernel_read_visible_record_for_update",
        json!({
            "app_id":APP_ID,"customer_id":"tenant_a","model_id":"department",
            "record_id":department_id,"as_of":"2026-08-05"
        }),
    );
    assert_eq!(visible["values"]["name"]["value"], "Finance Approved");
    assert_eq!(
        visible["many_relations"]["available_regions"][0],
        region_id.to_string()
    );
    let text_filtered = fixture.ok(
        "kernel_read_visible_records_by_text_fields",
        json!({
            "app_id":APP_ID,"customer_id":"tenant_a","model_id":"department","as_of":"2026-08-05",
            "field_filters":{"name":"Finance Approved"}
        }),
    );
    assert_eq!(text_filtered[0]["record_id"], department_id.to_string());
    let by_model = fixture.ok(
        "kernel_read_visible_records_by_model",
        json!({
            "app_id":APP_ID,"customer_id":"tenant_a","as_of":"2026-08-05",
            "model_ids":["region","department"]
        }),
    );
    assert_eq!(
        by_model["department"][0]["record_id"],
        department_id.to_string()
    );

    let diff = fixture.ok(
        "kernel_change_set_diff",
        json!({"app_id":APP_ID,"customer_id":"tenant_a","change_set_id":draft_id,"project":[]}),
    );
    assert_eq!(
        diff["records"][0]["fields"][0]["after"]["value"],
        "Finance Approved"
    );
    let history = fixture.ok(
        "kernel_field_history",
        json!({
            "app_id":APP_ID,"customer_id":"tenant_a","model_id":"department",
            "record_id":department_id,"field_id":"name","stages":["mainline","reverted"]
        }),
    );
    assert!(history
        .as_array()
        .expect("history rows")
        .iter()
        .any(|entry| entry["change_set_id"] == draft_id));
    let activity = fixture.ok(
        "kernel_recent_activity",
        json!({"app_id":APP_ID,"customer_id":"tenant_a","limit":20}),
    );
    assert!(activity
        .as_array()
        .expect("activity rows")
        .iter()
        .any(|entry| { entry["change_set_id"] == draft_id && entry["touched_record_count"] == 1 }));

    let retirement = fixture.ok(
        "kernel_lookup_set_availability",
        json!({
            "app_id":APP_ID,"customer_id":"tenant_a","model_id":"region","record_id":region_id,
            "availability":"retired","effective_start":"2026-08-06","schema_revision_id":fixture.revision_id,
            "actor_id":"lookup-admin","idempotency_key":"region-retire","reason":"no longer selectable"
        }),
    );
    let retirement_result: LookupSetAvailabilityResult =
        serde_json::from_value(retirement).expect("typed lookup availability result");
    assert_eq!(
        retirement_result.schema_revision_id.get(),
        fixture.revision_id
    );
    let retirement_id = retirement_result.id;
    let lifecycle_diff = fixture.ok(
        "kernel_change_set_diff",
        json!({
            "app_id":APP_ID,"customer_id":"tenant_a","change_set_id":retirement_id,
            "project":["__lookup_lifecycle"]
        }),
    );
    assert_eq!(
        lifecycle_diff["records"][0]["fields"][0],
        json!({
            "field_id":"__lookup_lifecycle",
            "before":{"type":"schema_lifecycle","value":"active"},
            "after":{"type":"schema_lifecycle","value":"retired"}
        })
    );
    let lifecycle_history = fixture.ok(
        "kernel_field_history",
        json!({
            "app_id":APP_ID,"customer_id":"tenant_a","model_id":"region",
            "record_id":region_id,"field_id":"__lookup_lifecycle",
            "stages":["mainline","reverted"]
        }),
    );
    assert!(lifecycle_history
        .as_array()
        .expect("lifecycle history")
        .iter()
        .any(|entry| {
            entry["change_set_id"] == retirement_id && entry["value"]["value"] == "retired"
        }));
    let options = fixture.ok(
        "kernel_lookup_list",
        json!({"app_id":APP_ID,"customer_id":"tenant_a","model_id":"region","as_of":"2026-08-06"}),
    );
    assert!(options.as_array().expect("lookup options").is_empty());
    let retired = fixture.ok(
        "kernel_lookup_resolve_batch",
        json!({
            "app_id":APP_ID,"customer_id":"tenant_a","model_id":"region","as_of":"2026-08-06",
            "record_ids":[region_id]
        }),
    );
    assert_eq!(retired[0]["availability"], "retired");

    let inherited_update = fixture.apply(
        "tenant_a",
        "draft",
        "department-after-region-retire",
        json!([{
            "model_id":"department","record_key":record_key(department_id),
            "effective_start":"2026-08-06","values":{"name":text("Finance Retained")}
        }]),
    );
    fixture.ok(
        "kernel_approve_draft_change_set",
        json!({"app_id":APP_ID,"customer_id":"tenant_a","actor_id":"lookup-tester","change_set_id":inherited_update}),
    );

    fixture.draft_and_approve(
        "region-restore",
        json!([{
            "model_id":"region","record_key":record_key(region_id),"effective_start":"2026-08-07",
            "values":{"__lookup_lifecycle":{"type":"schema_lifecycle","value":"active"}}
        }]),
    );
    let restored_options = fixture.ok(
        "kernel_lookup_list",
        json!({"app_id":APP_ID,"customer_id":"tenant_a","model_id":"region","as_of":"2026-08-07"}),
    );
    assert_eq!(restored_options[0]["record_id"], region_id.to_string());
    assert_eq!(restored_options[0]["availability"], "active");

    let wrong_model = fixture.ok(
        "kernel_read_visible_records",
        json!({
            "app_id":APP_ID,"customer_id":"tenant_a","model_id":"region","as_of":"2026-08-06",
            "record_ids":[department_id]
        }),
    );
    assert!(wrong_model.as_array().expect("wrong model rows").is_empty());
    let cross_tenant = fixture.ok(
        "kernel_read_visible_records",
        json!({
            "app_id":APP_ID,"customer_id":"tenant_b","model_id":"department","as_of":"2026-08-06",
            "record_ids":[department_id]
        }),
    );
    assert!(cross_tenant
        .as_array()
        .expect("cross tenant rows")
        .is_empty());

    let revert = fixture.ok(
        "kernel_revert_change_set",
        json!({
            "app_id":APP_ID,"customer_id":"tenant_a","change_set_id":inherited_update,
            "actor_id":"lookup-tester","idempotency_key":"revert-inherited-update"
        }),
    );
    assert!(revert["id"].as_i64().is_some());
    let reverted = fixture.ok(
        "kernel_read_visible_record",
        json!({
            "app_id":APP_ID,"customer_id":"tenant_a","model_id":"department",
            "record_id":department_id,"as_of":"2026-08-06"
        }),
    );
    assert_eq!(reverted["values"]["name"]["value"], "Finance Approved");
    assert!(rename_id > create_id);
}

#[test]
fn generic_lookup_visible_tokens_guard_mainline_updates() {
    let Some(mut fixture) = LookupFixture::connect() else {
        return;
    };
    let record_id = Uuid::new_v4();
    fixture.apply(
        "tenant_a",
        "mainline",
        "guard-create",
        json!([{
            "model_id":"region", "new_record_id":record_id,
            "effective_start":"2026-08-05", "values":{"name":text("North")}
        }]),
    );
    let read = json!({
        "app_id":APP_ID,"customer_id":"tenant_a","model_id":"region",
        "record_id":record_id,"as_of":"2026-08-06"
    });
    let initial = fixture.ok("kernel_read_visible_record", read.clone());
    let token = initial["version_id"]
        .as_str()
        .expect("lookup exposes visible token");
    Uuid::parse_str(token).expect("lookup version token is UUID");
    let request = json!({
        "app_id":APP_ID,"customer_id":"tenant_a","actor_id":"lookup-tester",
        "source_kind":"test","idempotency_key":"guard-update","mode":"mainline",
        "writes":[{"model_id":"region","record_key":record_key(record_id),
            "effective_start":"2026-08-06","expected_version_id":token,
            "values":{"name":text("Updated")}}]
    });
    fixture.ok("kernel_apply_change_set", request.clone());
    let mut stale = request;
    stale["idempotency_key"] = json!("guard-stale");
    stale["writes"][0]["values"]["name"] = text("Must roll back");
    let failure = fixture.call("kernel_apply_change_set", stale);
    assert_eq!(
        failure["error"],
        json!({
            "code":"version_conflict",
            "message":"This record has changed. Reload and try again.",
            "details":[]
        })
    );
    let current = fixture.ok("kernel_read_visible_record", read);
    assert_ne!(current["version_id"], initial["version_id"]);
    assert_eq!(current["values"]["name"]["value"], "Updated");
}

#[test]
fn protected_lookup_availability_replays_canonical_receipt_and_hydration_reads_without_nonce() {
    let Some(mut fixture) = LookupFixture::connect() else {
        return;
    };
    let record_id = Uuid::new_v4();
    fixture.client.execute("insert into lookup_record(app_id,customer_id,model_id,id) values($1,'tenant_a','region',$2)", &[&APP_ID,&record_id]).unwrap();
    fixture.apply("tenant_a","mainline","protected-region-create",json!([{"model_id":"region","record_key":record_key(record_id),"effective_start":"2026-08-05","values":{"name":text("Protected region")}}]));
    let principal: String = fixture
        .client
        .query_one("select session_user::text", &[])
        .unwrap()
        .get(0);
    fixture.ok("kernel_bind_principal_scope",json!({"principal_name":principal,"capability":"runtime","app_id":APP_ID,"customer_id":"tenant_a","actor_binding_required":true}));
    fixture.ok("kernel_bind_actor_membership",json!({"principal_name":principal,"app_id":APP_ID,"customer_id":"tenant_a","actor_id":"lookup-admin","actor_kind":"human","role":"member","active":true,"fence_generation":1}));
    fixture.client.batch_execute("set kernel.actor_id='lookup-admin'; set kernel.actor_role='member'; set kernel.actor_fence_generation='1'").unwrap();
    let now: i64 = fixture
        .client
        .query_one(
            "select floor(extract(epoch from clock_timestamp()))::bigint",
            &[],
        )
        .unwrap()
        .get(0);
    let descriptor = json!({"jti":"lookup-retire-request","issuer":"https://gateway.fixture","audience":APP_ID,"method":"POST","target":"/lookup/action","bodySha256":"A".repeat(43),"payloadSha256":"A".repeat(43),"expiresAt":now+240});
    let request = json!({"app_id":APP_ID,"customer_id":"tenant_a","model_id":"region","record_id":record_id,"availability":"retired","effective_start":"2026-08-06","schema_revision_id":fixture.revision_id,"actor_id":"lookup-admin","idempotency_key":"protected-region-retire","reason":"retire once"});
    fixture.ok("kernel_admit_http_operation",json!({"app_id":APP_ID,"customer_id":"tenant_a","actor_id":"lookup-admin","actor_kind":"human","role":"member","fence_generation":1,"http_request":descriptor,"operation":"kernel_lookup_set_availability","sequence":1,"payload":request}));
    fixture.client.execute("select set_config('kernel.http_jti',$1,false),set_config('kernel.http_descriptor',$2,false),set_config('kernel.http_sequence','1',false)", &[&"lookup-retire-request",&descriptor.to_string()]).unwrap();
    fixture.client.batch_execute("begin").unwrap();
    let first = fixture.ok("kernel_lookup_set_availability", request.clone());
    fixture.ok(
        "kernel_finish_http_request",
        json!({"app_id":APP_ID,"customer_id":"tenant_a","operation_count":1}),
    );
    let receipt_rows: Value=fixture.client.query_one("select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from kernel_http_operation_receipt r",&[]).unwrap().get(0);
    assert_eq!(
        receipt_rows[0]["change_set_id"], first["id"],
        "{receipt_rows}"
    );
    let key_rows: Value=fixture.client.query_one("select coalesce(jsonb_agg(jsonb_build_object('id',id,'key',idempotency_key)), '[]'::jsonb) from change_set where idempotency_key='protected-region-retire'",&[]).unwrap().get(0);
    assert_eq!(key_rows[0]["id"], first["id"], "{key_rows}");
    fixture.client.batch_execute("commit; begin").unwrap();
    let replay = fixture.ok("kernel_lookup_set_availability", request);
    fixture.ok(
        "kernel_finish_http_request",
        json!({"app_id":APP_ID,"customer_id":"tenant_a","operation_count":1}),
    );
    fixture.client.batch_execute("commit").unwrap();
    assert_eq!(first, replay);
    let count: i64 = fixture
        .client
        .query_one(
            "select count(*) from change_set where idempotency_key='protected-region-retire'",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(count, 1);
    fixture
        .client
        .batch_execute(
            "reset kernel.http_jti; reset kernel.http_descriptor; reset kernel.http_sequence",
        )
        .unwrap();
    let hydrated=fixture.ok("kernel_lookup_hydrate",json!({"app_id":APP_ID,"customer_id":"tenant_a","as_of":"2026-08-07","references":[{"model_id":"region","record_id":record_id}]}));
    assert_eq!(hydrated.as_array().unwrap().len(), 1);
}
