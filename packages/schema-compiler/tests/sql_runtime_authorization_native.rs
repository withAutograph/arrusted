use std::env;

use chrono::NaiveDate;
use kernel::{
    connect_postgres, AppId, ApplyChangeSet, CommitEnumOptionSetRevision, CustomerId, EnumOption,
    EnumOptionId, EnumOptionSetTarget, FieldId, KernelError, ModelId, SchemaRevisionId,
};
use schema_compiler::{
    compile_manifest_json, compile_sql_artifact_manifest, render_sql_artifact_bundle,
};
use serde_json::json;
use uuid::Uuid;

#[test]
fn compiled_policy_closes_native_request_entrypoints() {
    let Ok(database_url) = env::var("KERNEL_TEST_DATABASE_URL") else {
        eprintln!("skipping PostgreSQL test: KERNEL_TEST_DATABASE_URL is absent");
        return;
    };
    let authored = json!({
        "app_id":"museum", "customer_id":"gallery", "version":"policy-v1",
        "models":[{"id":"exhibit", "kind":"entity", "label":"Exhibit", "fields":[
            {"id":"title", "type":"text", "label":"Title"}
        ]}],
        "authorization":{"roles":[], "grants":[]}
    });
    let compiled =
        compile_manifest_json(&authored.to_string()).expect("compile unrelated deny-all schema");
    let mut legacy_authored = authored.clone();
    legacy_authored
        .as_object_mut()
        .unwrap()
        .remove("authorization");
    legacy_authored["version"] = json!("legacy-v1");
    let legacy = compile_manifest_json(&legacy_authored.to_string()).unwrap();
    let legacy_bundle =
        render_sql_artifact_bundle(&compile_sql_artifact_manifest(&legacy).unwrap());
    let bundle = render_sql_artifact_bundle(&compile_sql_artifact_manifest(&compiled).unwrap());
    let mut client = connect_postgres(&database_url).unwrap();
    let namespace = format!("native_authorization_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            "create schema {namespace}; set search_path to {namespace}"
        ))
        .unwrap();
    let result = (|| -> Result<(), String> {
        client
            .batch_execute(&legacy_bundle)
            .map_err(|error| format!("legacy bundle: {error:?}"))?;
        let legacy_schema = serde_json::to_value(&legacy.schema).unwrap();
        let legacy_revision_id: i64 = client
            .query_one(
                "insert into schema_revision (app_id, customer_id, version, base_schema, customer_overlay, schema, activated_at, materialized_at) values ('museum', 'gallery', 'legacy-v1', $1, '{}', $1, now(), now()) returning id",
                &[&legacy_schema],
            )
            .map_err(|error| format!("legacy revision: {error:?}"))?
            .get(0);
        client
            .execute(
                "select kernel_sync_schema_authorization_policy($1)",
                &[&legacy_revision_id],
            )
            .map_err(|error| format!("sync explicit legacy marker: {error:?}"))?;
        let legacy_marker: bool = client
            .query_one(
                "select authorization_policy_declared from schema_revision where id = $1",
                &[&legacy_revision_id],
            )
            .map_err(|error| format!("read explicit legacy marker: {error:?}"))?
            .get(0);
        assert!(!legacy_marker, "explicit policy absence must persist false");
        let replay: ApplyChangeSet = serde_json::from_value(json!({
            "app_id":"museum", "customer_id":"gallery", "source_kind":"fixture", "mode":"mainline",
            "idempotency_key":"native-policy-replay", "writes":[{
                "model_id":"exhibit", "record_key":{"type":"external_key","value":"exhibit-one"},
                "effective_start":"2026-09-16", "values":{"title":{"type":"text","value":"Protected exhibit"}}
            }]
        })).unwrap();
        kernel::apply_change_set(&mut client, &replay)
            .map_err(|error| format!("legacy write: {error:?}"))?;
        client
            .batch_execute(&bundle)
            .map_err(|error| format!("compiled bundle: {error:?}"))?;
        client
            .execute("update schema_revision set activated_at=null", &[])
            .map_err(|error| error.to_string())?;
        let schema = serde_json::to_value(&compiled.schema).unwrap();
        // Administrator installation fixture: actual compiler artifacts govern the
        // public native request path even before a policy snapshot is available.
        let policy_revision_id: i64 = client
            .query_one(
                "insert into schema_revision (app_id, customer_id, version, base_schema, customer_overlay, schema, activated_at, materialized_at) values ('museum', 'gallery', 'policy-v1', $1, '{}', $1, now(), now()) returning id",
                &[&schema],
            )
            .map_err(|error| format!("active revision: {error:?}"))?
            .get(0);
        client
            .execute(
                "select kernel_sync_schema_authorization_policy($1)",
                &[&policy_revision_id],
            )
            .map_err(|error| format!("sync declared policy marker: {error:?}"))?;
        assert_denied(kernel::apply_change_set(&mut client, &replay));
        let revisions_before_lifecycle: i64 = client
            .query_one("select count(*) from schema_revision", &[])
            .map_err(|error| format!("count revisions before native lifecycle: {error:?}"))?
            .get(0);
        assert_denied(kernel::commit_enum_option_set_revision(
            &mut client,
            &CommitEnumOptionSetRevision {
                app_id: AppId::from("museum"),
                customer_id: CustomerId::from("gallery"),
                baseline_revision_id: SchemaRevisionId::new(policy_revision_id),
                target: EnumOptionSetTarget::Declared {
                    model_id: ModelId::from("exhibit"),
                    field_id: FieldId::from("status"),
                },
                options: vec![EnumOption {
                    id: EnumOptionId::from("open"),
                    label: "Open".to_string(),
                    ..Default::default()
                }],
            },
        ));
        let revisions_after_lifecycle: i64 = client
            .query_one("select count(*) from schema_revision", &[])
            .map_err(|error| format!("count revisions after native lifecycle: {error:?}"))?
            .get(0);
        assert_eq!(
            revisions_after_lifecycle, revisions_before_lifecycle,
            "policy-enabled native lifecycle rejection must not create or activate a revision"
        );
        let app = AppId::from("museum");
        let tenant = CustomerId::from("gallery");
        let model = ModelId::from("exhibit");
        let date = NaiveDate::from_ymd_opt(2026, 9, 16).unwrap();
        assert_denied(kernel::read_visible_records(
            &mut client,
            &app,
            &tenant,
            &model,
            date,
        ));
        assert_denied(kernel::read_active_schema_revision(
            &mut client,
            &app,
            &tenant,
        ));
        assert_denied(kernel::begin_tenant_transaction(&mut client, &app, &tenant));
        let mut transaction = client.transaction().map_err(|error| error.to_string())?;
        assert_denied(kernel::read_visible_records_in_transaction(
            &mut transaction,
            &app,
            &tenant,
            &model,
            date,
        ));
        transaction.rollback().map_err(|error| error.to_string())?;
        client
            .batch_execute(
                "delete from schema_authorization_policy_snapshot; delete from schema_authorization_policy_source; delete from schema_authorization_policy_expectation",
            )
            .map_err(|error| format!("delete policy catalog rows: {error:?}"))?;
        assert_sql_schema_drift(
            client.query_one(
                "select kernel_policy_active_snapshot('museum', 'gallery')",
                &[],
            ),
            "active policy snapshot accepted deleted policy catalog rows",
        );
        assert_sql_schema_drift(
            client.query_one(
                "select kernel_sync_schema_authorization_policy($1)",
                &[&policy_revision_id],
            ),
            "policy sync accepted an active declared marker without catalog rows",
        );
        assert_schema_drift(kernel::read_visible_records(
            &mut client,
            &app,
            &tenant,
            &model,
            date,
        ));
        client
            .batch_execute(
                "drop table schema_authorization_policy_snapshot; drop table schema_authorization_policy_source; drop table schema_authorization_policy_expectation",
            )
            .map_err(|error| format!("drop policy catalogs: {error:?}"))?;
        assert_schema_drift(kernel::read_visible_records(
            &mut client,
            &app,
            &tenant,
            &model,
            date,
        ));
        Ok(())
    })();
    client
        .batch_execute(&format!(
            "rollback; set search_path to public; drop schema {namespace} cascade"
        ))
        .unwrap();
    result.unwrap();
}

fn assert_denied<T>(result: Result<T, KernelError>) {
    match result {
        Ok(_) => panic!("native request bypassed compiled policy"),
        Err(error) => {
            let envelope = error.into_envelope();
            assert_eq!(envelope.code, "unsupported_capability");
            assert!(envelope.details.is_empty());
        }
    }
}

fn assert_schema_drift<T>(result: Result<T, KernelError>) {
    match result {
        Ok(_) => panic!("native request accepted deleted policy catalogs"),
        Err(error) => assert_eq!(error.into_envelope().code, "schema_drift"),
    }
}

fn assert_sql_schema_drift(result: Result<postgres::Row, postgres::Error>, success_message: &str) {
    let error = result.expect_err(success_message);
    let Some(database_error) = error.as_db_error() else {
        panic!("expected PostgreSQL schema drift, got {error:?}");
    };
    assert!(
        database_error.message().contains("schema_drift"),
        "expected schema drift, got {error:?}"
    );
}
