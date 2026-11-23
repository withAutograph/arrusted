#[path = "support/trusted_human.rs"]
mod trusted_human;
use std::env;
use std::sync::{Arc, Barrier};
use std::thread;

use kernel::{
    AppId, CustomerId, Field, FieldId, FieldType, Model, ModelId, ModelKind, Schema, SchemaVersion,
};
use postgres::{Client, NoTls};
use schema_compiler::{
    compile_sql_artifact_manifest, render_sql_artifact_bundle, CompiledManifest,
    NormalizedManifestExtras,
};
use serde_json::{json, Value};
use uuid::Uuid;

const APP_ID: &str = "lookup_alias_transfer_app";
const CUSTOMER_ID: &str = "tenant_a";

struct Fixture {
    client: Client,
    database_url: String,
    schema_name: String,
    revision_id: i64,
    today: String,
}

impl Fixture {
    fn connect() -> Option<Self> {
        let database_url = match env::var("KERNEL_TEST_DATABASE_URL") {
            Ok(url) => url,
            Err(env::VarError::NotPresent) => {
                eprintln!(
                    "skipping lookup alias-transfer SQL tests: KERNEL_TEST_DATABASE_URL is absent"
                );
                return None;
            }
            Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
        };
        let mut client = Client::connect(&database_url, NoTls).expect("connect PostgreSQL 17");
        let schema_name = format!("kernel_alias_transfer_{}", Uuid::new_v4().simple());
        client
            .batch_execute(&format!(
                r#"create schema "{schema_name}"; set search_path to "{schema_name}""#
            ))
            .expect("create alias-transfer schema");
        let compiled = compiled();
        let manifest = compile_sql_artifact_manifest(&compiled).expect("compile generated SQL");
        trusted_human::before_install(&mut client);
        client
            .batch_execute(&render_sql_artifact_bundle(&manifest))
            .expect("install generated SQL");
        let schema_json = serde_json::to_value(&compiled.schema).expect("serialize schema");
        let revision_id = client
            .query_one(
                "insert into schema_revision(app_id,customer_id,version,base_schema,customer_overlay,schema,activated_at,materialized_at) values($1,$2,$3,$4,'{}'::jsonb,$4,now(),now()) returning id",
                &[&APP_ID, &CUSTOMER_ID, &compiled.schema.version.as_str(), &schema_json],
            )
            .expect("activate schema")
            .get(0);
        let today = client
            .query_one("select current_date::text", &[])
            .expect("read database date")
            .get(0);
        trusted_human::bind(&mut client, APP_ID, "tenant_a", "lookup-admin");
        Some(Self {
            client,
            database_url,
            schema_name,
            revision_id,
            today,
        })
    }

    fn call(&mut self, function: &str, request: &Value) -> Value {
        if let Some(actor) = request["actor_id"].as_str() {
            trusted_human::select(&mut self.client, actor);
        }
        self.client
            .query_one(&format!("select {function}($1::jsonb)"), &[request])
            .unwrap_or_else(|error| panic!("call {function}: {error:?}"))
            .get(0)
    }

    fn apply(&mut self, request: &Value) -> Value {
        self.call("kernel_apply_change_set", request)
    }

    fn connect_worker(&self) -> Client {
        let mut client = Client::connect(&self.database_url, NoTls).expect("connect worker");
        client
            .batch_execute(&format!(r#"set search_path to "{}""#, self.schema_name))
            .expect("set worker search path");
        trusted_human::select(&mut client, "lookup-admin");
        client
    }

    fn create_lookup(
        &mut self,
        model_id: &str,
        record_id: Uuid,
        name: &str,
        aliases: &[&str],
        key: &str,
    ) -> Value {
        let today = self.today.clone();
        self.apply(&lookup_write(
            model_id,
            record_id,
            true,
            Some(name),
            Some(aliases),
            &today,
            key,
        ))
    }

    fn update_lookup(
        &mut self,
        model_id: &str,
        record_id: Uuid,
        name: Option<&str>,
        aliases: Option<&[&str]>,
        effective_start: &str,
        key: &str,
    ) -> Value {
        self.apply(&lookup_write(
            model_id,
            record_id,
            false,
            name,
            aliases,
            effective_start,
            key,
        ))
    }

    fn transfer(
        &mut self,
        source_record_id: Uuid,
        target_record_id: Uuid,
        alias: &str,
        expected_source_version_id: Uuid,
        expected_target_version_id: Uuid,
        idempotency_key: &str,
    ) -> Value {
        let request = transfer_request(
            APP_ID,
            CUSTOMER_ID,
            "department",
            source_record_id,
            target_record_id,
            alias,
            &self.today,
            self.revision_id,
            expected_source_version_id,
            expected_target_version_id,
            idempotency_key,
        );
        self.call("kernel_lookup_transfer_alias", &request)
    }

    fn current_version(&mut self, model_id: &str, record_id: Uuid) -> Uuid {
        self.client
            .query_one(
                r#"
                select version.id
                from lookup_version version
                join change_set changes
                  on changes.id=version.change_set_id
                 and changes.app_id=version.app_id
                 and changes.customer_id=version.customer_id
                where version.app_id=$1 and version.customer_id=$2
                  and version.model_id=$3 and version.record_id=$4
                  and version.stage='mainline' and changes.status='mainline'
                  and changes.applied_order is not null
                  and version.effective_start<=current_date
                  and (version.effective_end is null or version.effective_end>=current_date)
                order by version.effective_start desc,version.tombstones_record desc,
                  version.untombstones_record desc,changes.applied_order desc,version.id desc
                limit 1
                "#,
                &[&APP_ID, &CUSTOMER_ID, &model_id, &record_id],
            )
            .expect("read current lookup version")
            .get(0)
    }

    fn current_aliases(&mut self, model_id: &str, record_id: Uuid) -> Vec<String> {
        let version_id = self.current_version(model_id, record_id);
        self.client
            .query_one(
                "select coalesce(array(select jsonb_array_elements_text(values#>'{aliases,value}')),'{}'::text[]) from lookup_version where app_id=$1 and customer_id=$2 and model_id=$3 and id=$4",
                &[&APP_ID, &CUSTOMER_ID, &model_id, &version_id],
            )
            .expect("read current aliases")
            .get(0)
    }

    fn set_authority(&mut self, model_id: &str, authority: &str) {
        self.client
            .query_one(
                "select set_config('kernel.app_id',$1,false),set_config('kernel.customer_id',$2,false)",
                &[&APP_ID, &CUSTOMER_ID],
            )
            .expect("set fixture scope");
        self.client
            .execute(
                r#"
                insert into lookup_storage_authority(
                  app_id,customer_id,model_id,schema_hash,authority,
                  legacy_record_table,legacy_version_table
                ) values($1,$2,$3,repeat('a',64),$4,$3 || '_record',$3 || '_version')
                on conflict(app_id,customer_id,model_id) do update
                set authority=excluded.authority,
                    activated_at=case when excluded.authority='generic' then now() else null end
                "#,
                &[&APP_ID, &CUSTOMER_ID, &model_id, &authority],
            )
            .expect("set storage authority");
    }

    fn retire(&mut self, record_id: Uuid, key: &str) -> Value {
        let request = json!({
            "app_id":APP_ID,"customer_id":CUSTOMER_ID,"model_id":"department",
            "record_id":record_id,"availability":"retired","actor_id":"lookup-admin",
            "idempotency_key":key,"effective_start":self.today,
            "schema_revision_id":self.revision_id,"reason":"alias-transfer fixture retirement"
        });
        self.call("kernel_lookup_set_availability", &request)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = trusted_human::drop_fixture(&mut self.client, &self.schema_name);
    }
}

fn compiled() -> CompiledManifest {
    let lookup = |id: &str, label: &str| Model {
        id: ModelId::from(id),
        kind: ModelKind::Lookup,
        label: label.to_string(),
        display_field_id: Some(FieldId::from("name")),
        fields: vec![
            Field {
                id: FieldId::from("name"),
                label: "Name".to_string(),
                field_type: FieldType::Text,
                required: true,
                ..Field::default()
            },
            Field {
                id: FieldId::from("aliases"),
                label: "Known aliases".to_string(),
                field_type: FieldType::KnownAliases,
                ..Field::default()
            },
        ],
        ..Model::default()
    };
    CompiledManifest {
        schema: Schema {
            app_id: AppId::from(APP_ID),
            customer_id: CustomerId::from(CUSTOMER_ID),
            version: SchemaVersion::from("2026-08-05.lookup-alias-transfer"),
            models: vec![
                lookup("department", "Department"),
                lookup("region", "Region"),
            ],
            custom_fields: vec![],
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

fn text(value: &str) -> Value {
    json!({"type":"text","value":value})
}

fn aliases(values: &[&str]) -> Value {
    json!({"type":"text_list","value":values})
}

#[allow(clippy::too_many_arguments)]
fn lookup_write(
    model_id: &str,
    record_id: Uuid,
    create: bool,
    name: Option<&str>,
    alias_values: Option<&[&str]>,
    effective_start: &str,
    key: &str,
) -> Value {
    let mut values = serde_json::Map::new();
    if let Some(name) = name {
        values.insert("name".to_string(), text(name));
    }
    if let Some(alias_values) = alias_values {
        values.insert("aliases".to_string(), aliases(alias_values));
    }
    let mut write = json!({
        "model_id":model_id,"effective_start":effective_start,"values":values
    });
    if create {
        write["new_record_id"] = json!(record_id);
    } else {
        write["record_key"] = json!({"type":"record_id","value":record_id});
    }
    json!({
        "app_id":APP_ID,"customer_id":CUSTOMER_ID,"actor_id":"lookup-admin",
        "source_kind":"fixture","idempotency_key":key,"mode":"mainline",
        "notes":"alias-transfer fixture write","writes":[write]
    })
}

#[allow(clippy::too_many_arguments)]
fn transfer_request(
    app_id: &str,
    customer_id: &str,
    model_id: &str,
    source_record_id: Uuid,
    target_record_id: Uuid,
    alias: &str,
    effective_start: &str,
    schema_revision_id: i64,
    expected_source_version_id: Uuid,
    expected_target_version_id: Uuid,
    idempotency_key: &str,
) -> Value {
    json!({
        "app_id":app_id,"customer_id":customer_id,"model_id":model_id,
        "source_record_id":source_record_id,"target_record_id":target_record_id,
        "alias":alias,"effective_start":effective_start,
        "expected_source_version_id":expected_source_version_id,
        "expected_target_version_id":expected_target_version_id,
        "schema_revision_id":schema_revision_id,"actor_id":"lookup-admin",
        "idempotency_key":idempotency_key,"reason":"transfer lookup alias"
    })
}

fn assert_ok(result: &Value) {
    assert_eq!(result.get("ok"), Some(&Value::Bool(true)), "{result:#}");
}

fn assert_error(result: &Value, code: &str) {
    assert_eq!(result["ok"], false, "{result:#}");
    assert_eq!(result["error"]["code"], code, "{result:#}");
}

#[test]
fn transfer_is_atomic_audited_idempotent_and_reservations_are_permanent_on_postgres_17() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    let source = Uuid::new_v4();
    let target = Uuid::new_v4();
    assert_ok(&fixture.create_lookup(
        "department",
        source,
        "Source",
        &["Legacy", "Stable"],
        "create-source",
    ));
    assert_ok(&fixture.create_lookup(
        "department",
        target,
        "Target",
        &["Target Alias"],
        "create-target",
    ));

    let today = fixture.today.clone();
    assert_ok(&fixture.update_lookup(
        "department",
        source,
        Some("Source Renamed"),
        Some(&["Legacy", "Stable", "Added"]),
        &today,
        "same-record-source-edit",
    ));
    assert_ok(&fixture.update_lookup(
        "department",
        target,
        Some("Target Renamed"),
        Some(&["Target Alias"]),
        &today,
        "same-record-target-edit",
    ));
    let source_version = fixture.current_version("department", source);
    let target_version = fixture.current_version("department", target);
    let transfer = fixture.transfer(
        source,
        target,
        " legacy ",
        source_version,
        target_version,
        "transfer-legacy",
    );
    assert_ok(&transfer);
    let change_set_id = transfer["data"]["id"]
        .as_i64()
        .expect("transfer change set id");
    let audit: (String, String, String, i64, i64) = fixture
        .client
        .query_one(
            r#"
            select source_kind,actor_id,notes,
              (select count(*) from lookup_version where change_set_id=change_set.id),
              (select count(distinct record_id) from lookup_version where change_set_id=change_set.id)
            from change_set where id=$1
            "#,
            &[&change_set_id],
        )
        .map(|row| {
            (
                row.get(0),
                row.get(1),
                row.get(2),
                row.get(3),
                row.get(4),
            )
        })
        .expect("read transfer audit");
    assert_eq!(audit.0, "lookup_alias_transfer");
    assert_eq!(audit.1, "lookup-admin");
    assert_eq!(audit.2, "transfer lookup alias");
    assert_eq!((audit.3, audit.4), (2, 2));
    assert_eq!(
        fixture.current_aliases("department", source),
        vec!["Stable", "Added"]
    );
    assert_eq!(
        fixture.current_aliases("department", target),
        vec!["Target Alias", "Legacy"]
    );

    let replay = fixture.transfer(
        source,
        target,
        " legacy ",
        source_version,
        target_version,
        "transfer-legacy",
    );
    assert_ok(&replay);
    assert_eq!(replay["data"]["id"], change_set_id);
    let replay_version_count: i64 = fixture
        .client
        .query_one(
            "select count(*) from lookup_version where change_set_id=$1",
            &[&change_set_id],
        )
        .expect("count replay versions")
        .get(0);
    assert_eq!(replay_version_count, 2);

    let target_aliases = fixture.current_aliases("department", target);
    let hijack = fixture.update_lookup(
        "department",
        target,
        None,
        Some(&["Target Alias", "Legacy", "Added"]),
        &today,
        "ordinary-active-hijack",
    );
    assert_error(&hijack, "lookup_alias_collision");
    assert_eq!(
        fixture.current_aliases("department", target),
        target_aliases
    );

    assert_ok(&fixture.update_lookup(
        "department",
        source,
        None,
        Some(&["Added"]),
        &today,
        "remove-stable-from-source",
    ));
    let reserved = fixture.update_lookup(
        "department",
        target,
        None,
        Some(&["Target Alias", "Legacy", "Stable"]),
        &today,
        "ordinary-reserved-hijack",
    );
    assert_error(&reserved, "lookup_alias_reserved");
    assert_eq!(
        fixture.current_aliases("department", target),
        target_aliases
    );
}

#[test]
fn transfer_rejects_invalid_scope_identity_authority_and_internal_markers_on_postgres_17() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    let source = Uuid::new_v4();
    let target = Uuid::new_v4();
    assert_ok(&fixture.create_lookup(
        "department",
        source,
        "Canonical Source",
        &["Owned"],
        "validation-source",
    ));
    assert_ok(&fixture.create_lookup(
        "department",
        target,
        "Canonical Target",
        &[],
        "validation-target",
    ));
    let source_version = fixture.current_version("department", source);
    let target_version = fixture.current_version("department", target);

    assert_error(
        &fixture.transfer(
            source,
            source,
            "Owned",
            source_version,
            source_version,
            "same-record",
        ),
        "lookup_alias_transfer_same_record",
    );
    assert_error(
        &fixture.transfer(
            source,
            target,
            "Canonical Source",
            source_version,
            target_version,
            "canonical-label",
        ),
        "lookup_alias_transfer_canonical_forbidden",
    );
    assert_error(
        &fixture.transfer(
            source,
            target,
            "Not Owned",
            source_version,
            target_version,
            "not-owned",
        ),
        "lookup_alias_transfer_not_owned",
    );

    let base = transfer_request(
        APP_ID,
        CUSTOMER_ID,
        "department",
        source,
        target,
        "Owned",
        &fixture.today,
        fixture.revision_id,
        source_version,
        target_version,
        "scope-check",
    );
    for (path, value, code) in [
        ("app_id", json!("wrong_app"), "active_schema_missing"),
        (
            "customer_id",
            json!("wrong_customer"),
            "active_schema_missing",
        ),
        (
            "model_id",
            json!("region"),
            "lookup_alias_transfer_source_missing",
        ),
    ] {
        let mut request = base.clone();
        request[path] = value;
        request["idempotency_key"] = json!(format!("wrong-{path}"));
        let result = fixture.call("kernel_lookup_transfer_alias", &request);
        assert_error(&result, code);
    }

    let mut missing_source = base.clone();
    missing_source["source_record_id"] = json!(Uuid::new_v4());
    missing_source["idempotency_key"] = json!("missing-source");
    assert_error(
        &fixture.call("kernel_lookup_transfer_alias", &missing_source),
        "lookup_alias_transfer_source_missing",
    );
    let mut missing_target = base.clone();
    missing_target["target_record_id"] = json!(Uuid::new_v4());
    missing_target["idempotency_key"] = json!("missing-target");
    assert_error(
        &fixture.call("kernel_lookup_transfer_alias", &missing_target),
        "lookup_alias_transfer_target_missing",
    );

    let mut stale_schema = base.clone();
    stale_schema["schema_revision_id"] = json!(fixture.revision_id + 1);
    stale_schema["idempotency_key"] = json!("stale-schema");
    assert_error(
        &fixture.call("kernel_lookup_transfer_alias", &stale_schema),
        "stale_schema_revision",
    );

    let mut spoof = base.clone();
    spoof["__kernel_alias_transfer"] = json!(true);
    spoof["idempotency_key"] = json!("spoof-transfer-marker");
    let spoof_result = fixture.call("kernel_lookup_transfer_alias", &spoof);
    assert_error(&spoof_result, "contract_validation_failed");
    assert!(
        spoof_result["error"]["details"][0]["message"]
            .as_str()
            .is_some_and(|message| message.contains("reserved_internal_apply_field")),
        "{spoof_result:#}"
    );
    let mut spoof_write = lookup_write(
        "department",
        target,
        false,
        None,
        Some(&["Owned"]),
        &fixture.today,
        "spoof-apply-marker",
    );
    spoof_write["writes"][0]["__kernel_alias_transfer"] = json!(true);
    let spoof_apply = fixture.apply(&spoof_write);
    assert_error(&spoof_apply, "contract_validation_failed");
    assert_eq!(
        spoof_apply["error"]["details"][0]["code"],
        "reserved_internal_apply_field"
    );
    for (field, value) in [
        ("source_record_id", Value::Null),
        ("expected_source_version_id", Value::Null),
        ("expected_target_version_id", Value::Null),
        ("effective_start", Value::Null),
        ("schema_revision_id", json!(0)),
    ] {
        let mut request = base.clone();
        request[field] = value;
        request["idempotency_key"] = json!(format!("invalid-{field}"));
        assert_error(
            &fixture.call("kernel_lookup_transfer_alias", &request),
            "contract_validation_failed",
        );
    }

    fixture.set_authority("department", "typed");
    let typed = fixture.call("kernel_lookup_transfer_alias", &base);
    assert_error(&typed, "lookup_storage_authority_mismatch");
}

#[test]
fn transfer_rejects_retired_stale_and_future_timeline_records_on_postgres_17() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };

    let retired_source = Uuid::new_v4();
    let active_target = Uuid::new_v4();
    assert_ok(&fixture.create_lookup(
        "department",
        retired_source,
        "Retired Source",
        &["Retired Source Alias"],
        "retired-source-create",
    ));
    assert_ok(&fixture.create_lookup(
        "department",
        active_target,
        "Active Target",
        &[],
        "retired-source-target",
    ));
    let retired_source_version = fixture.current_version("department", retired_source);
    let active_target_version = fixture.current_version("department", active_target);
    assert_ok(&fixture.retire(retired_source, "retire-source"));
    assert_error(
        &fixture.transfer(
            retired_source,
            active_target,
            "Retired Source Alias",
            retired_source_version,
            active_target_version,
            "transfer-retired-source",
        ),
        "lookup_alias_transfer_source_inactive",
    );

    let active_source = Uuid::new_v4();
    let retired_target = Uuid::new_v4();
    assert_ok(&fixture.create_lookup(
        "department",
        active_source,
        "Active Source",
        &["Retired Target Alias"],
        "retired-target-source",
    ));
    assert_ok(&fixture.create_lookup(
        "department",
        retired_target,
        "Retired Target",
        &[],
        "retired-target-create",
    ));
    let active_source_version = fixture.current_version("department", active_source);
    let retired_target_version = fixture.current_version("department", retired_target);
    assert_ok(&fixture.retire(retired_target, "retire-target"));
    assert_error(
        &fixture.transfer(
            active_source,
            retired_target,
            "Retired Target Alias",
            active_source_version,
            retired_target_version,
            "transfer-retired-target",
        ),
        "lookup_alias_transfer_target_inactive",
    );

    let stale_source = Uuid::new_v4();
    let stale_target = Uuid::new_v4();
    assert_ok(&fixture.create_lookup(
        "department",
        stale_source,
        "Stale Source",
        &["Stale Alias"],
        "stale-source-create",
    ));
    assert_ok(&fixture.create_lookup(
        "department",
        stale_target,
        "Stale Target",
        &[],
        "stale-cas-target-create",
    ));
    let old_source_version = fixture.current_version("department", stale_source);
    let stale_target_version = fixture.current_version("department", stale_target);
    let today = fixture.today.clone();
    assert_ok(&fixture.update_lookup(
        "department",
        stale_source,
        Some("Stale Source Renamed"),
        None,
        &today,
        "stale-source-update",
    ));
    assert_error(
        &fixture.transfer(
            stale_source,
            stale_target,
            "Stale Alias",
            old_source_version,
            stale_target_version,
            "stale-source-transfer",
        ),
        "lookup_alias_transfer_stale_source",
    );

    let stale_target_source = Uuid::new_v4();
    let stale_target = Uuid::new_v4();
    assert_ok(&fixture.create_lookup(
        "department",
        stale_target_source,
        "Stale Target Source",
        &["Stale Target Alias"],
        "stale-target-source-create",
    ));
    assert_ok(&fixture.create_lookup(
        "department",
        stale_target,
        "CAS Target",
        &[],
        "stale-target-create",
    ));
    let stale_target_source_version = fixture.current_version("department", stale_target_source);
    let old_target_version = fixture.current_version("department", stale_target);
    assert_ok(&fixture.update_lookup(
        "department",
        stale_target,
        Some("CAS Target Renamed"),
        None,
        &today,
        "stale-target-update",
    ));
    assert_error(
        &fixture.transfer(
            stale_target_source,
            stale_target,
            "Stale Target Alias",
            stale_target_source_version,
            old_target_version,
            "stale-target-transfer",
        ),
        "lookup_alias_transfer_stale_target",
    );

    let future_source = Uuid::new_v4();
    let future_target = Uuid::new_v4();
    assert_ok(&fixture.create_lookup(
        "department",
        future_source,
        "Future Source",
        &["Future Alias"],
        "future-source-create",
    ));
    assert_ok(&fixture.create_lookup(
        "department",
        future_target,
        "Future Target",
        &[],
        "future-target-create",
    ));
    let future_source_version = fixture.current_version("department", future_source);
    let future_target_version = fixture.current_version("department", future_target);
    let tomorrow: String = fixture
        .client
        .query_one("select (current_date+1)::text", &[])
        .expect("read tomorrow")
        .get(0);
    assert_ok(&fixture.update_lookup(
        "department",
        future_source,
        Some("Future Source Renamed"),
        None,
        &tomorrow,
        "future-source-update",
    ));
    assert_error(
        &fixture.transfer(
            future_source,
            future_target,
            "Future Alias",
            future_source_version,
            future_target_version,
            "future-timeline-transfer",
        ),
        "lookup_alias_transfer_timeline_conflict",
    );
}

#[test]
fn concurrent_transfers_have_one_winner_and_never_partially_write_on_postgres_17() {
    let Some(mut fixture) = Fixture::connect() else {
        return;
    };
    let source = Uuid::new_v4();
    let first_target = Uuid::new_v4();
    let second_target = Uuid::new_v4();
    assert_ok(&fixture.create_lookup(
        "department",
        source,
        "Concurrent Source",
        &["Contended"],
        "concurrent-source",
    ));
    assert_ok(&fixture.create_lookup(
        "department",
        first_target,
        "First Target",
        &[],
        "concurrent-first-target",
    ));
    assert_ok(&fixture.create_lookup(
        "department",
        second_target,
        "Second Target",
        &[],
        "concurrent-second-target",
    ));
    let source_version = fixture.current_version("department", source);
    let first_target_version = fixture.current_version("department", first_target);
    let second_target_version = fixture.current_version("department", second_target);
    let requests = [
        transfer_request(
            APP_ID,
            CUSTOMER_ID,
            "department",
            source,
            first_target,
            "Contended",
            &fixture.today,
            fixture.revision_id,
            source_version,
            first_target_version,
            "concurrent-transfer-first",
        ),
        transfer_request(
            APP_ID,
            CUSTOMER_ID,
            "department",
            source,
            second_target,
            "Contended",
            &fixture.today,
            fixture.revision_id,
            source_version,
            second_target_version,
            "concurrent-transfer-second",
        ),
    ];
    let barrier = Arc::new(Barrier::new(3));
    let mut workers = Vec::new();
    for request in requests {
        let mut client = fixture.connect_worker();
        let barrier = Arc::clone(&barrier);
        workers.push(thread::spawn(move || {
            barrier.wait();
            client
                .query_one(
                    "select kernel_lookup_transfer_alias($1::jsonb)",
                    &[&request],
                )
                .expect("call concurrent transfer")
                .get::<_, Value>(0)
        }));
    }
    barrier.wait();
    let results = workers
        .into_iter()
        .map(|worker| worker.join().expect("join transfer worker"))
        .collect::<Vec<_>>();
    assert_eq!(
        results.iter().filter(|result| result["ok"] == true).count(),
        1,
        "{results:#?}"
    );
    assert_eq!(
        results
            .iter()
            .filter(|result| result["ok"] == false)
            .count(),
        1,
        "{results:#?}"
    );

    let transfer_change_sets: i64 = fixture
        .client
        .query_one(
            "select count(*) from change_set where source_kind='lookup_alias_transfer'",
            &[],
        )
        .expect("count transfer change sets")
        .get(0);
    assert_eq!(transfer_change_sets, 1);
    assert!(!fixture
        .current_aliases("department", source)
        .iter()
        .any(|alias| alias == "Contended"));
    let winner_count = [first_target, second_target]
        .into_iter()
        .filter(|target| {
            fixture
                .current_aliases("department", *target)
                .iter()
                .any(|alias| alias == "Contended")
        })
        .count();
    assert_eq!(winner_count, 1);
    let transfer_versions: i64 = fixture
        .client
        .query_one(
            "select count(*) from lookup_version version join change_set changes on changes.id=version.change_set_id where changes.source_kind='lookup_alias_transfer'",
            &[],
        )
        .expect("count atomic transfer versions")
        .get(0);
    assert_eq!(transfer_versions, 2);
}
