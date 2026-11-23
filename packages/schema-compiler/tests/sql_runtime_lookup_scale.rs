use std::collections::BTreeMap;
use std::env;
use std::sync::{Arc, Barrier};
use std::thread;
use std::time::{Duration as StdDuration, Instant};

use chrono::{Duration, NaiveDate};
use kernel::{
    connect_postgres, schema_hash, AppId, ApplyChangeSet, ApplyMode, CustomerId, Field, FieldId,
    FieldType, FieldValue, LookupHydrateRequest, LookupHydrationReference, Model, ModelId,
    ModelKind, RowVersionWrite, Schema, SchemaRevisionId, SchemaVersion,
};
use schema_compiler::{
    compile_sql_artifact_manifest, render_sql_artifact_bundle, CompiledManifest,
    NormalizedManifestExtras,
};
use serde_json::{json, Value};
use uuid::Uuid;

const ROW_COUNT: i32 = 1_000_000;
const LOOKUP_WRITE_BATCH_P95_THRESHOLD_MS: f64 = 8_000.0;
const LOOKUP_SEARCH_P95_THRESHOLD_MS: f64 = 250.0;
const SINGLE_REFERENCE_HYDRATION_P95_THRESHOLD_MS: f64 = 60_000.0;
const LARGE_OVERLAY_P95_THRESHOLD_MS: f64 = 1_000.0;
const APP_BASE_PREPARATION_P95_THRESHOLD_MS: f64 = 1_000.0;
const PHASE_LEDGER_P95_THRESHOLD_MS: f64 = 1_000.0;
const ACTIVATION_LOCK_CALL_THRESHOLD_MS: f64 = 1_500.0;
const TENANT_MUTATION_P95_THRESHOLD_MS: f64 = 1_000.0;

#[test]
fn generated_lookup_scale_benchmark_uses_runtime_roles_and_bounded_apis() {
    let Some(database_url) = test_database_url() else {
        return;
    };
    let mut client = connect_postgres(&database_url).expect("connect scale database");
    let server_version: i32 = client
        .query_one("show server_version_num", &[])
        .expect("read PostgreSQL version")
        .get::<_, String>(0)
        .parse()
        .expect("numeric PostgreSQL version");
    assert!(
        server_version >= 170_000,
        "scale proof requires PostgreSQL 17"
    );

    let database_name: String = client
        .query_one("select current_database()", &[])
        .expect("read benchmark database")
        .get(0);
    let benchmark_date: NaiveDate = client
        .query_one("select current_date", &[])
        .expect("read benchmark date")
        .get(0);
    let principal = format!("a462_runtime_{}", Uuid::new_v4().simple());
    let password = Uuid::new_v4().simple().to_string();
    let admin_principal = format!("a462_schema_admin_{}", Uuid::new_v4().simple());
    let admin_password = Uuid::new_v4().simple().to_string();
    let installer_principal = format!("a462_installer_{}", Uuid::new_v4().simple());
    let installer_password = Uuid::new_v4().simple().to_string();
    let schema_name = format!("kernel_lookup_scale_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            "create schema \"{schema_name}\"; set search_path to \"{schema_name}\""
        ))
        .expect("create scale schema");

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        (|| -> Result<(), String> {
            let compiled = compiled();
            let manifest = compile_sql_artifact_manifest(&compiled)
                .map_err(|error| format!("compile scale bundle: {error}"))?;
            let bundle = render_sql_artifact_bundle(&manifest);
            assert!(
                bundle.contains("order by display.normalized_alias,display.record_id"),
                "lookup pagination must preserve projection-index ordering"
            );
            client
                .batch_execute(&bundle)
                .map_err(|error| format!("install scale bundle: {error:?}"))?;
            let schema_json = serde_json::to_value(&compiled.schema).expect("serialize schema");
            let effective_hash = schema_hash(&compiled.schema);
            let revision_id: i64 = client
                .query_one(
                    r#"
                insert into schema_revision(
                  app_id,customer_id,version,base_schema,customer_overlay,schema,schema_hash,
                  materialized_at,activated_at
                ) values ('lookup_scale','tenant_a','v1',$1,'{}'::jsonb,$1,$2,now(),now())
                returning id
                "#,
                    &[&schema_json, &effective_hash],
                )
                .map_err(|error| format!("seed hash-pinned scale schema: {error:?}"))?
                .get(0);
            client
                .execute(
                    r#"
                insert into schema_installation_revision(
                  schema_revision_id,app_id,customer_id,release_id,activation_kind,
                  base_artifact_hash,effective_artifact_hash,materialization_plan_hash,
                  phase_plan,phase_results,ready_at,activated_at
                ) values ($1,'lookup_scale','tenant_a','a462-benchmark','tenant_overlay',
                  $2,$2,$2,'[]'::jsonb,'[]'::jsonb,now(),now())
                "#,
                    &[&revision_id, &effective_hash],
                )
                .map_err(|error| format!("seed scale installation hash ledger: {error:?}"))?;
            client
                .execute(
                    r#"
                    insert into lookup_storage_authority(
                      app_id,customer_id,model_id,schema_hash,authority,
                      legacy_record_table,legacy_version_table,activated_at
                    ) values ('lookup_scale','tenant_a','option',$1,'generic',
                      'option_record','option_version',now())
                    "#,
                    &[&effective_hash],
                )
                .map_err(|error| format!("seed hash-pinned generic lookup authority: {error:?}"))?;
            let change_set_id: i64 = client
            .query_one(
                r#"
                insert into change_set(
                  app_id,customer_id,schema_revision_id,created_with_mode,status,actor_id,
                  source_kind,idempotency_key,created_order,applied_order,applied_at
                ) values (
                  'lookup_scale','tenant_a',$1,'mainline','mainline','scale','test','scale-load',
                  nextval('change_set_lifecycle_order_seq'),nextval('change_set_lifecycle_order_seq'),now()
                ) returning id
                "#,
                &[&revision_id],
            )
            .map_err(|error| format!("create scale change set: {error:?}"))?
            .get(0);

            let runtime_role: String = client
                .query_one("select kernel_installer_capability_role('runtime')", &[])
                .map_err(|error| format!("resolve generated runtime role: {error:?}"))?
                .get(0);
            let schema_admin_role: String = client
                .query_one(
                    "select kernel_installer_capability_role('schema_admin')",
                    &[],
                )
                .map_err(|error| format!("resolve generated schema-admin role: {error:?}"))?
                .get(0);
            let execution_role: String = client
                .query_one(
                    "select kernel_installer_capability_role('execution_owner')",
                    &[],
                )
                .map_err(|error| format!("resolve generated installer role: {error:?}"))?
                .get(0);
            client
                .batch_execute(&format!(
                    "create role \"{principal}\" login password '{password}' nosuperuser nocreatedb nocreaterole noreplication nobypassrls; grant connect on database \"{database_name}\" to \"{principal}\"; grant \"{runtime_role}\" to \"{principal}\"; create role \"{admin_principal}\" login password '{admin_password}' nosuperuser nocreatedb nocreaterole noreplication nobypassrls; grant connect on database \"{database_name}\" to \"{admin_principal}\"; grant \"{schema_admin_role}\" to \"{admin_principal}\"; create role \"{installer_principal}\" login password '{installer_password}' nosuperuser nocreatedb nocreaterole noreplication nobypassrls; grant connect on database \"{database_name}\" to \"{installer_principal}\"; grant \"{execution_role}\" to \"{installer_principal}\""
                ))
                .map_err(|error| format!("provision restricted benchmark principals: {error:?}"))?;
            let binding: Value = client
                .query_one(
                    "select kernel_bind_principal_scope($1::jsonb)",
                    &[&json!({
                        "principal_name": principal,
                        "capability": "runtime",
                        "app_id": compiled.schema.app_id,
                        "customer_id": compiled.schema.customer_id
                    })],
                )
                .map_err(|error| format!("bind runtime principal scope: {error:?}"))?
                .get(0);
            if binding["ok"] != true {
                return Err(format!("bind runtime principal scope: {binding}"));
            }

            let seed_started = Instant::now();
            client
                .execute(
                    r#"
                insert into lookup_record(app_id,customer_id,model_id,id,external_key)
                select 'lookup_scale','tenant_a','option',
                  ('00000000-0000-0000-0000-' || lpad(to_hex(item),12,'0'))::uuid,
                  'option:' || item
                from generate_series(1,$1) item
                "#,
                    &[&ROW_COUNT],
                )
                .map_err(|error| format!("insert scale records: {error:?}"))?;
            client
                .batch_execute(
                    "alter table lookup_version disable trigger lookup_version_mark_generic_write",
                )
                .map_err(|error| format!("pause generic-write fixture bookkeeping: {error:?}"))?;
            client
                .execute(
                    r#"
                insert into lookup_version(
                  id,app_id,customer_id,model_id,record_id,stage,effective_start,change_set_id,
                  applied_at,values
                )
                select
                  ('10000000-0000-0000-0000-' || lpad(to_hex(item),12,'0'))::uuid,
                  'lookup_scale','tenant_a','option',
                  ('00000000-0000-0000-0000-' || lpad(to_hex(item),12,'0'))::uuid,
                  'mainline',current_date,$2,now(),
                  jsonb_build_object('name',jsonb_build_object(
                    'type','text','value','label_' || lpad(item::text,7,'0')
                  ))
                from generate_series(1,$1) item
                "#,
                    &[&ROW_COUNT, &change_set_id],
                )
                .map_err(|error| format!("insert scale versions: {error:?}"))?;
            client
                .batch_execute(
                    "alter table lookup_version enable trigger lookup_version_mark_generic_write",
                )
                .map_err(|error| format!("restore generic-write bookkeeping: {error:?}"))?;
            client
                .batch_execute(
                    "alter table lookup_alias_projection drop constraint lookup_alias_projection_version_fk; drop index lookup_alias_projection_match_idx; drop index lookup_alias_projection_display_page_idx",
                )
                .map_err(|error| format!("prepare projection fixture bulk load: {error:?}"))?;
            client
                .execute(
                    r#"
                insert into lookup_alias_projection(
                  version_id,app_id,customer_id,model_id,record_id,field_id,ordinal,kind,
                  alias,normalized_alias,is_current
                )
                select
                  ('10000000-0000-0000-0000-' || lpad(to_hex(item),12,'0'))::uuid,
                  'lookup_scale','tenant_a','option',
                  ('00000000-0000-0000-0000-' || lpad(to_hex(item),12,'0'))::uuid,
                  'name',0,'display','label_' || lpad(item::text,7,'0'),
                  'label_' || lpad(item::text,7,'0'),true
                from generate_series(1,$1) item
                "#,
                    &[&ROW_COUNT],
                )
                .map_err(|error| format!("insert scale display projections: {error:?}"))?;
            client
                .batch_execute(
                    "create index lookup_alias_projection_match_idx on lookup_alias_projection (app_id, customer_id, model_id, normalized_alias, record_id) where is_current; create index lookup_alias_projection_display_page_idx on lookup_alias_projection (app_id, customer_id, model_id, normalized_alias, record_id, version_id) where kind = 'display'",
                )
                .map_err(|error| format!("build generated lookup projection indexes: {error:?}"))?;
            client
                .batch_execute(
                    "alter table lookup_alias_projection add constraint lookup_alias_projection_version_fk foreign key (app_id, customer_id, model_id, version_id) references lookup_version (app_id, customer_id, model_id, id) not valid; alter table lookup_alias_projection validate constraint lookup_alias_projection_version_fk",
                )
                .map_err(|error| format!("restore generated projection version integrity: {error:?}"))?;
            client
                .batch_execute(
                    "analyze lookup_record; analyze lookup_alias_projection; analyze lookup_version; analyze change_set",
                )
                .map_err(|error| format!("analyze scale tables: {error:?}"))?;

            let seed_elapsed_ms = seed_started.elapsed().as_secs_f64() * 1000.0;
            let cursor_id: Uuid = client
            .query_one(
                "select record_id from lookup_alias_projection where app_id='lookup_scale' and customer_id='tenant_a' and model_id='option' and normalized_alias='label_0999900' and kind='display'",
                &[],
            )
            .map_err(|error| format!("read scale cursor: {error:?}"))?
            .get(0);
            let membership: Value = client
                .query_one(
                    "select kernel_bind_actor_membership($1::jsonb)",
                    &[&json!({
                        "principal_name":principal,"app_id":"lookup_scale","customer_id":"tenant_a",
                        "actor_id":"a462-benchmark","actor_kind":"human","role":"fixture"
                    })],
                )
                .unwrap()
                .get(0);
            assert_eq!(membership["ok"], true, "{membership}");
            let runtime_url = principal_database_url(&database_url, &principal, &password)?;
            let mut runtime_client = connect_postgres(&runtime_url)
                .map_err(|error| format!("connect generated runtime principal: {error:?}"))?;
            runtime_client
                .batch_execute(&format!("set search_path to \"{schema_name}\""))
                .map_err(|error| format!("set runtime schema path: {error:?}"))?;
            runtime_client
                .batch_execute("set kernel.actor_id='a462-benchmark'")
                .unwrap();
            let restricted_runtime_row = client
                .query_one(
                    r#"
                select role_value.rolsuper, role_value.rolbypassrls,
                  has_table_privilege($1,'lookup_record','INSERT,UPDATE,DELETE,TRUNCATE')
                from pg_roles role_value where role_value.rolname=$1
                "#,
                    &[&principal],
                )
                .map_err(|error| format!("inspect generated runtime principal: {error:?}"))?;
            let restricted_runtime = (
                restricted_runtime_row.get::<_, bool>(0),
                restricted_runtime_row.get::<_, bool>(1),
                restricted_runtime_row.get::<_, bool>(2),
            );
            assert_eq!(restricted_runtime, (false, false, false));
            let rls_enabled: bool = client
            .query_one(
                "select relrowsecurity and relforcerowsecurity from pg_class where oid=to_regclass('lookup_record')",
                &[],
            )
            .map_err(|error| format!("inspect lookup RLS policy: {error:?}"))?
            .get(0);
            assert!(rls_enabled, "generated lookup storage must force RLS");
            let request = json!({
                "app_id":"lookup_scale","customer_id":"tenant_a","model_id":"option",
                "limit":25,"after":{"normalized_label":"label_0999900","record_id":cursor_id}
            });
            let mut samples_ms = Vec::with_capacity(9);
            let mut page = Value::Null;
            for sample_index in 0..10 {
                let started = Instant::now();
                page = runtime_client
                    .query_one(
                        &format!("select \"{schema_name}\".kernel_lookup_list($1::jsonb)"),
                        &[&request],
                    )
                    .map_err(|error| format!("page scale lookup: {error:?}"))?
                    .get(0);
                let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
                if sample_index > 0 {
                    samples_ms.push(elapsed_ms);
                }
            }
            assert_eq!(page["ok"], true, "{page:#}");
            let rows = page["data"].as_array().expect("scale page rows");
            assert_eq!(rows.len(), 25);
            let write_date = benchmark_date - Duration::days(30);
            let history_date = benchmark_date - Duration::days(365);
            let history_end_date = benchmark_date - Duration::days(1);
            let mut write_samples_ms = Vec::with_capacity(5);
            for batch_index in 0..5_u128 {
                let writes = (0..100_u128)
                    .map(|row_index| RowVersionWrite {
                        model_id: ModelId::from("option"),
                        new_record_id: Some(Uuid::from_u128(
                            0xa462_0000_0000_0000_0000_0000_0000_0000_u128
                                + batch_index * 100
                                + row_index,
                        )),
                        effective_start: write_date,
                        values: Some(BTreeMap::from([(
                            FieldId::from("name"),
                            FieldValue::Text(format!(
                                "bench_write_{batch_index:02}_{row_index:03}"
                            )),
                        )])),
                        ..RowVersionWrite::default()
                    })
                    .collect();
                let apply_request = ApplyChangeSet {
                    app_id: AppId::from("lookup_scale"),
                    customer_id: CustomerId::from("tenant_a"),
                    schema_revision_id: Some(SchemaRevisionId::new(revision_id)),
                    actor_id: Some("a462-benchmark".to_string()),
                    source_kind: "a462-benchmark".to_string(),
                    source_ref: Some("synthetic-lookup-batch".to_string()),
                    idempotency_key: Some(format!("lookup-write-batch-{batch_index}")),
                    change_type_id: None,
                    notes: Some("Synthetic A-462 lookup throughput batch".to_string()),
                    mode: ApplyMode::Mainline,
                    writes,
                };
                let apply_json = serde_json::to_value(apply_request)
                    .map_err(|error| format!("serialize lookup write batch: {error}"))?;
                let started = Instant::now();
                let response: Value = runtime_client
                    .query_one(
                        &format!("select \"{schema_name}\".kernel_apply_change_set($1::jsonb)"),
                        &[&apply_json],
                    )
                    .map_err(|error| format!("write generated lookup batch: {error:?}"))?
                    .get(0);
                if response["ok"] != true {
                    return Err(format!("generated lookup batch failed: {response}"));
                }
                write_samples_ms.push(started.elapsed().as_secs_f64() * 1000.0);
            }
            write_samples_ms.sort_by(f64::total_cmp);
            let write_p95_ms = write_samples_ms[write_samples_ms.len() - 1];
            if write_p95_ms > LOOKUP_WRITE_BATCH_P95_THRESHOLD_MS {
                return Err(format!(
                    "100-row lookup write p95 {write_p95_ms:.2} ms exceeds benchmark threshold {LOOKUP_WRITE_BATCH_P95_THRESHOLD_MS:.2} ms"
                ));
            }
            println!(
                "A462_BENCHMARK_RESULT {}",
                json!({
                    "workload": "lookup_write_throughput",
                    "rows_per_batch": 100,
                    "batches": write_samples_ms.len(),
                    "total_rows": write_samples_ms.len() * 100,
                    "samples_ms": write_samples_ms,
                    "p95_ms": write_p95_ms,
                    "p95_threshold_ms": LOOKUP_WRITE_BATCH_P95_THRESHOLD_MS,
                    "rows_per_second_at_p95": 100_000.0 / write_p95_ms
                })
            );

            let search_request = json!({
                "app_id":"lookup_scale","customer_id":"tenant_a","model_id":"option",
                "query":"label_0000","limit":25
            });
            let mut search_samples_ms = Vec::with_capacity(9);
            for sample_index in 0..10 {
                let started = Instant::now();
                let response: Value = runtime_client
                    .query_one(
                        &format!("select \"{schema_name}\".kernel_lookup_list($1::jsonb)"),
                        &[&search_request],
                    )
                    .map_err(|error| format!("search generated lookup catalog: {error:?}"))?
                    .get(0);
                if response["ok"] != true
                    || response["data"]
                        .as_array()
                        .is_none_or(|rows| rows.len() != 25)
                {
                    return Err(format!(
                        "generated lookup search did not return a bounded page: {response}"
                    ));
                }
                let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
                if sample_index > 0 {
                    search_samples_ms.push(elapsed_ms);
                }
            }
            search_samples_ms.sort_by(f64::total_cmp);
            let search_median_ms = search_samples_ms[search_samples_ms.len() / 2];
            let search_p95_ms = search_samples_ms[search_samples_ms.len() - 1];
            if search_p95_ms > LOOKUP_SEARCH_P95_THRESHOLD_MS {
                return Err(format!(
                    "prefix search p95 {search_p95_ms:.2} ms exceeds benchmark threshold {LOOKUP_SEARCH_P95_THRESHOLD_MS:.2} ms"
                ));
            }
            println!(
                "A462_BENCHMARK_RESULT {}",
                json!({
                    "workload": "lookup_prefix_search",
                    "rows": ROW_COUNT,
                    "prefix": "label_0000",
                    "page_size": 25,
                    "warmup_calls": 1,
                    "samples_ms": search_samples_ms,
                    "median_ms": search_median_ms,
                    "p95_ms": search_p95_ms,
                    "p95_threshold_ms": LOOKUP_SEARCH_P95_THRESHOLD_MS
                })
            );

            client
                .batch_execute(&format!("set search_path to \"{schema_name}\""))
                .map_err(|error| format!("restore owner fixture schema path: {error:?}"))?;
            let history_change_set_id: i64 = client
                .query_one(
                    r#"
                    insert into change_set(
                      app_id,customer_id,schema_revision_id,created_with_mode,status,actor_id,
                      source_kind,idempotency_key,created_order,applied_order,applied_at
                    ) values (
                      'lookup_scale','tenant_a',$1,'mainline','mainline','scale','a462-benchmark-history','history-load',
                      nextval('change_set_lifecycle_order_seq'),nextval('change_set_lifecycle_order_seq'),now()
                    ) returning id
                    "#,
                    &[&revision_id],
                )
                .map_err(|error| format!("create historical label fixture change set: {error:?}"))?
                .get(0);
            client
                .execute(
                    r#"
                    insert into lookup_version(
                      id,app_id,customer_id,model_id,record_id,stage,effective_start,effective_end,
                      change_set_id,applied_at,availability,values
                    )
                    select
                      ('20000000-0000-0000-0000-' || right(selected.record_id::text,12))::uuid,
                      'lookup_scale','tenant_a','option',selected.record_id,'mainline',
                      $2,$3,$1,now(),'active',
                      jsonb_build_object('name',jsonb_build_object(
                        'type','text','value','history_' || selected.normalized_alias
                      ))
                    from (
                      select record_id,normalized_alias from lookup_alias_projection
                      where app_id='lookup_scale' and customer_id='tenant_a'
                        and model_id='option' and kind='display'
                        and normalized_alias between 'label_0999900' and 'label_0999999'
                      order by normalized_alias,record_id limit 1
                    ) selected
                    "#,
                    &[&history_change_set_id, &history_date, &history_end_date],
                )
                .map_err(|error| format!("seed historical label fixture: {error:?}"))?;
            let historical_ids: Vec<Uuid> = client
                .query(
                    "select record_id from lookup_alias_projection where app_id='lookup_scale' and customer_id='tenant_a' and model_id='option' and kind='display' and normalized_alias between 'label_0999900' and 'label_0999999' order by normalized_alias,record_id limit 1",
                    &[],
                )
                .map_err(|error| format!("read historical label references: {error:?}"))?
                .into_iter()
                .map(|row| row.get(0))
                .collect();
            let history_request = LookupHydrateRequest {
                app_id: AppId::from("lookup_scale"),
                customer_id: CustomerId::from("tenant_a"),
                references: historical_ids
                    .iter()
                    .map(|record_id| LookupHydrationReference {
                        model_id: ModelId::from("option"),
                        record_id: *record_id,
                        as_of: None,
                        effective_start: Some(history_date),
                        event_change_set_id: Some(history_change_set_id),
                    })
                    .collect(),
                as_of: Some(benchmark_date),
                event_change_set_id: None,
            };
            let history_json = serde_json::to_value(history_request)
                .map_err(|error| format!("serialize historical hydration request: {error}"))?;
            let mut hydration_samples_ms = Vec::with_capacity(2);
            let mut hydrated = Value::Null;
            for sample_index in 0..3 {
                let started = Instant::now();
                hydrated = runtime_client
                    .query_one(
                        &format!("select \"{schema_name}\".kernel_lookup_hydrate($1::jsonb)"),
                        &[&history_json],
                    )
                    .map_err(|error| format!("hydrate historical lookup labels: {error:?}"))?
                    .get(0);
                if hydrated["ok"] != true
                    || hydrated["data"]
                        .as_array()
                        .is_none_or(|rows| rows.len() != 1)
                {
                    return Err(format!(
                        "historical label hydration returned an unexpected result: {hydrated}"
                    ));
                }
                if sample_index > 0 {
                    hydration_samples_ms.push(started.elapsed().as_secs_f64() * 1000.0);
                }
            }
            let history_rows = hydrated["data"].as_array().expect("hydrated history rows");
            assert!(history_rows[0]["event"]["label"]
                .as_str()
                .unwrap_or_default()
                .starts_with("history_label_"));
            assert!(history_rows[0]["current"]["label"]
                .as_str()
                .unwrap_or_default()
                .starts_with("label_"));
            hydration_samples_ms.sort_by(f64::total_cmp);
            let hydration_median_ms = hydration_samples_ms[hydration_samples_ms.len() / 2];
            let hydration_p95_ms = hydration_samples_ms[hydration_samples_ms.len() - 1];
            if hydration_p95_ms > SINGLE_REFERENCE_HYDRATION_P95_THRESHOLD_MS {
                return Err(format!(
                    "single-reference history hydration p95 {hydration_p95_ms:.2} ms exceeds benchmark threshold {SINGLE_REFERENCE_HYDRATION_P95_THRESHOLD_MS:.2} ms"
                ));
            }
            println!(
                "A462_BENCHMARK_RESULT {}",
                json!({
                    "workload": "historical_label_hydration",
                    "rows": ROW_COUNT,
                    "references_per_call": 1,
                    "warmup_calls": 1,
                    "samples_ms": hydration_samples_ms,
                    "median_ms": hydration_median_ms,
                    "p95_ms": hydration_p95_ms,
                    "p95_threshold_ms": SINGLE_REFERENCE_HYDRATION_P95_THRESHOLD_MS
                })
            );

            let mut overlay_schema_samples_ms = Vec::with_capacity(3);
            let admin_database_url =
                principal_database_url(&database_url, &admin_principal, &admin_password)?;
            let mut admin_client = connect_postgres(&admin_database_url)
                .map_err(|error| format!("connect generated schema-admin principal: {error:?}"))?;
            admin_client
                .batch_execute(&format!("set search_path to \"{schema_name}\""))
                .map_err(|error| format!("set schema-admin search path: {error:?}"))?;
            let installer_database_url =
                principal_database_url(&database_url, &installer_principal, &installer_password)?;
            for overlay_index in 0..3 {
                client
                    .batch_execute(&format!("set search_path to \"{schema_name}\""))
                    .map_err(|error| format!("restore overlay fixture schema path: {error:?}"))?;
                let customer_id = format!("overlay_tenant_{overlay_index}");
                let mut overlay_base = compiled.schema.clone();
                overlay_base.customer_id = CustomerId::from(customer_id.as_str());
                let overlay_base_json = serde_json::to_value(&overlay_base)
                    .map_err(|error| format!("serialize overlay base schema: {error}"))?;
                let overlay_hash = schema_hash(&overlay_base);
                let base_revision_id: i64 = client
                    .query_one(
                        r#"
                        insert into schema_revision(
                          app_id,customer_id,version,base_schema,customer_overlay,schema,
                          schema_hash,materialized_at,activated_at
                        ) values ('lookup_scale',$1,'v1',$2,'{}'::jsonb,$2,$3,now(),now())
                        returning id
                        "#,
                        &[&customer_id, &overlay_base_json, &overlay_hash],
                    )
                    .map_err(|error| format!("seed large overlay base schema: {error:?}"))?
                    .get(0);
                client
                    .execute(
                        r#"
                        insert into schema_installation_revision(
                          schema_revision_id,app_id,customer_id,release_id,activation_kind,
                          base_artifact_hash,effective_artifact_hash,materialization_plan_hash,
                          phase_plan,phase_results,ready_at,activated_at
                        ) values ($1,'lookup_scale',$2,'a462-overlay-benchmark','tenant_overlay',
                          $3,$3,$3,'[]'::jsonb,'[]'::jsonb,now(),now())
                        "#,
                        &[&base_revision_id, &customer_id, &overlay_hash],
                    )
                    .map_err(|error| format!("seed overlay installation hash ledger: {error:?}"))?;
                client
                    .execute(
                        r#"
                        insert into lookup_storage_authority(
                          app_id,customer_id,model_id,schema_hash,authority,
                          legacy_record_table,legacy_version_table,activated_at
                        ) values ('lookup_scale',$1,'option',$2,'generic',
                          'option_record','option_version',now())
                        "#,
                        &[&customer_id, &overlay_hash],
                    )
                    .map_err(|error| format!("seed overlay lookup authority hash: {error:?}"))?;
                let binding: Value = client
                    .query_one(
                        "select kernel_bind_principal_scope($1::jsonb)",
                        &[&json!({
                            "principal_name": admin_principal,
                            "capability": "schema_admin",
                            "app_id": "lookup_scale",
                            "customer_id": customer_id,
                            "actor_id": "a462-benchmark-admin"
                        })],
                    )
                    .map_err(|error| format!("bind schema-admin tenant scope: {error:?}"))?
                    .get(0);
                if binding["ok"] != true {
                    return Err(format!("bind schema-admin tenant scope: {binding}"));
                }
                let mut fields = Vec::with_capacity(100);
                fields.push(json!({
                    "id":"name","label":"Name","type":"text",
                    "required":true,"is_unique":false
                }));
                fields.extend((0..99).map(|field_index| {
                    json!({
                        "id":format!("overlay_field_{field_index:03}"),
                        "label":format!("Overlay Field {field_index:03}"),
                        "type":"text","required":false,"is_unique":false
                    })
                }));
                let request = json!({
                    "app_id":"lookup_scale",
                    "customer_id":customer_id,
                    "actor_id":"a462-benchmark-admin",
                    "reason":"Synthetic large tenant overlay capacity sample",
                    "idempotency_key":format!("a462-large-overlay-{overlay_index}"),
                    "expected_revision_id":base_revision_id.to_string(),
                    "expected_effective_hash":overlay_hash,
                    "operations":[{
                        "type":"create_model",
                        "model":{
                            "kind":"lookup","label":"Benchmark Overlay",
                            "display_field_id":"name","fields":fields,"many_relations":[]
                        }
                    }]
                });
                let started = Instant::now();
                let response: Value = admin_client
                    .query_one(
                        &format!("select \"{schema_name}\".kernel_commit_tenant_schema_revision($1::jsonb)"),
                        &[&request],
                    )
                    .map_err(|error| format!("commit large tenant overlay through generated API: {error:?}"))?
                    .get(0);
                if response["ok"] != true {
                    return Err(format!("large tenant overlay failed: {response}"));
                }
                overlay_schema_samples_ms.push(started.elapsed().as_secs_f64() * 1000.0);
            }
            overlay_schema_samples_ms.sort_by(f64::total_cmp);
            let overlay_schema_p95_ms =
                overlay_schema_samples_ms[overlay_schema_samples_ms.len() - 1];
            if overlay_schema_p95_ms > LARGE_OVERLAY_P95_THRESHOLD_MS {
                return Err(format!(
                    "100-field overlay p95 {overlay_schema_p95_ms:.2} ms exceeds benchmark threshold {LARGE_OVERLAY_P95_THRESHOLD_MS:.2} ms"
                ));
            }
            println!(
                "A462_BENCHMARK_RESULT {}",
                json!({
                    "workload":"large_tenant_overlay",
                    "samples":overlay_schema_samples_ms.len(),
                    "models_added_per_sample":1,
                    "fields_per_model":100,
                    "samples_ms":overlay_schema_samples_ms,
                    "p95_ms":overlay_schema_p95_ms,
                    "p95_threshold_ms":LARGE_OVERLAY_P95_THRESHOLD_MS
                })
            );

            let phase_count = 100;
            let phase_plan = (0..phase_count)
                .map(|phase_index| {
                    json!({
                        "id":format!("backfill_{phase_index:03}"),
                        "kind":"backfill",
                        "hash":effective_hash
                    })
                })
                .collect::<Vec<_>>();
            let phase_results = (0..phase_count)
                .map(|phase_index| {
                    json!({
                        "id":format!("backfill_{phase_index:03}"),
                        "hash":effective_hash,
                        "status":"complete"
                    })
                })
                .collect::<Vec<_>>();
            let mut app_base_requests = Vec::with_capacity(4);
            for prep_index in 0..4 {
                client
                    .batch_execute(&format!("set search_path to \"{schema_name}\""))
                    .map_err(|error| format!("restore app-base fixture schema path: {error:?}"))?;
                let customer_id = format!("app_base_tenant_{prep_index}");
                let mut prep_schema = compiled.schema.clone();
                prep_schema.customer_id = CustomerId::from(customer_id.as_str());
                let prep_schema_json = serde_json::to_value(&prep_schema)
                    .map_err(|error| format!("serialize app-base preparation schema: {error}"))?;
                let prep_hash = schema_hash(&prep_schema);
                client
                    .execute(
                        "insert into schema_constraint_identity_source(app_id,schema_version,catalog) values ('lookup_scale','v1','[]'::jsonb) on conflict (app_id,schema_version) do nothing",
                        &[],
                    )
                    .map_err(|error| format!("seed app-base compiler constraint catalog: {error:?}"))?;
                let binding: Value = client
                    .query_one(
                        "select kernel_bind_principal_scope($1::jsonb)",
                        &[&json!({
                            "principal_name": admin_principal,
                            "capability": "schema_admin",
                            "app_id": "lookup_scale",
                            "customer_id": customer_id,
                            "actor_id": "a462-benchmark-admin"
                        })],
                    )
                    .map_err(|error| format!("bind app-base preparation admin scope: {error:?}"))?
                    .get(0);
                if binding["ok"] != true {
                    return Err(format!("bind app-base preparation admin scope: {binding}"));
                }
                app_base_requests.push(json!({
                    "app_id":"lookup_scale",
                    "customer_id":customer_id,
                    "version":prep_schema.version,
                    "release_id":"a462-app-base-preparation",
                    "activation_kind":"app_base",
                    "schema_hash":prep_hash,
                    "base_artifact_hash":prep_hash,
                    "effective_artifact_hash":prep_hash,
                    "materialization_plan_hash":prep_hash,
                    "expected_active_effective_hash":null,
                    "base_schema":prep_schema_json,
                    "customer_overlay":{},
                    "schema":prep_schema,
                    "seed_change_sets":[],
                    "phase_plan":phase_plan
                }));
            }
            let prep_barrier = Arc::new(Barrier::new(app_base_requests.len() + 1));
            let prep_handles = app_base_requests
                .iter()
                .cloned()
                .map(|request| {
                    let database_url = installer_database_url.clone();
                    let schema_name = schema_name.clone();
                    let barrier = Arc::clone(&prep_barrier);
                    thread::spawn(move || {
                        let mut worker = connect_postgres(&database_url)
                            .expect("connect app-base preparation worker");
                        worker
                            .batch_execute(&format!("set search_path to \"{schema_name}\""))
                            .expect("set app-base preparation search path");
                        barrier.wait();
                        let started = Instant::now();
                        let response: Value = worker
                            .query_one(
                                &format!("select \"{schema_name}\".kernel_prepare_schema_revision($1::jsonb)"),
                                &[&request],
                            )
                            .expect("prepare app-base revision")
                            .get(0);
                        (response, started.elapsed().as_secs_f64() * 1000.0)
                    })
                })
                .collect::<Vec<_>>();
            prep_barrier.wait();
            let prep_results = prep_handles
                .into_iter()
                .map(|handle| handle.join().expect("app-base preparation thread"))
                .collect::<Vec<_>>();
            if let Some((response, _)) = prep_results
                .iter()
                .find(|(response, _)| response["ok"] != true)
            {
                return Err(format!(
                    "concurrent app-base preparation failed: {response}"
                ));
            }
            let mut app_base_samples_ms = prep_results
                .iter()
                .map(|(_, elapsed_ms)| *elapsed_ms)
                .collect::<Vec<_>>();
            app_base_samples_ms.sort_by(f64::total_cmp);
            let app_base_p95_ms = app_base_samples_ms[app_base_samples_ms.len() - 1];
            if app_base_p95_ms > APP_BASE_PREPARATION_P95_THRESHOLD_MS {
                return Err(format!(
                    "four-way app-base preparation p95 {app_base_p95_ms:.2} ms exceeds benchmark threshold {APP_BASE_PREPARATION_P95_THRESHOLD_MS:.2} ms"
                ));
            }
            println!(
                "A462_BENCHMARK_RESULT {}",
                json!({
                    "workload":"concurrent_app_base_preparation",
                    "concurrency":app_base_samples_ms.len(),
                    "phase_plan_count":phase_count,
                    "samples_ms":app_base_samples_ms,
                    "p95_ms":app_base_p95_ms,
                    "p95_threshold_ms":APP_BASE_PREPARATION_P95_THRESHOLD_MS
                })
            );

            let mut phase_ledger_samples_ms = Vec::with_capacity(prep_results.len());
            for (request, (prepared, _)) in app_base_requests.iter().zip(prep_results.iter()) {
                let revision_id = prepared["data"]["schema_revision_id"]
                    .as_i64()
                    .ok_or_else(|| format!("app-base prepare omitted revision id: {prepared}"))?;
                let readiness = json!({
                    "app_id":"lookup_scale",
                    "customer_id":request["customer_id"],
                    "schema_revision_id":revision_id,
                    "effective_artifact_hash":request["effective_artifact_hash"],
                    "materialization_plan_hash":request["materialization_plan_hash"],
                    "phase_results":phase_results
                });
                let started = Instant::now();
                let mut installer_client = connect_postgres(&installer_database_url)
                    .map_err(|error| format!("connect generated installer principal: {error:?}"))?;
                installer_client
                    .batch_execute(&format!("set search_path to \"{schema_name}\""))
                    .map_err(|error| format!("set installer schema path: {error:?}"))?;
                let response: Value = installer_client
                    .query_one(
                        &format!("select \"{schema_name}\".kernel_validate_schema_revision_readiness($1::jsonb)"),
                        &[&readiness],
                    )
                    .map_err(|error| format!("record phase-ledger backfill results: {error:?}"))?
                    .get(0);
                if response["ok"] != true {
                    return Err(format!(
                        "phase-ledger backfill readiness failed: {response}"
                    ));
                }
                phase_ledger_samples_ms.push(started.elapsed().as_secs_f64() * 1000.0);
            }
            phase_ledger_samples_ms.sort_by(f64::total_cmp);
            let phase_ledger_p95_ms = phase_ledger_samples_ms[phase_ledger_samples_ms.len() - 1];
            if phase_ledger_p95_ms > PHASE_LEDGER_P95_THRESHOLD_MS {
                return Err(format!(
                    "100-phase readiness p95 {phase_ledger_p95_ms:.2} ms exceeds benchmark threshold {PHASE_LEDGER_P95_THRESHOLD_MS:.2} ms"
                ));
            }
            println!(
                "A462_BENCHMARK_RESULT {}",
                json!({
                    "workload":"phase_ledger_backfill_readiness",
                    "phases_per_revision":phase_count,
                    "revisions":phase_ledger_samples_ms.len(),
                    "samples_ms":phase_ledger_samples_ms,
                    "p95_ms":phase_ledger_p95_ms,
                    "p95_threshold_ms":PHASE_LEDGER_P95_THRESHOLD_MS
                })
            );

            let activation_request = &app_base_requests[0];
            let activation_revision_id =
                prep_results[0].0["data"]["schema_revision_id"]
                    .as_i64()
                    .ok_or_else(|| "app-base activation fixture omitted revision id".to_string())?;
            let activation_customer = activation_request["customer_id"]
                .as_str()
                .expect("app-base activation tenant");
            let lock_name = format!(
                "postgres-schema:{schema_name}:materialize-tenant:lookup_scale:{activation_customer}:schema-activation"
            );
            client
                .batch_execute("begin")
                .map_err(|error| format!("begin activation lock holder: {error:?}"))?;
            client
                .query_one(
                    "select pg_advisory_xact_lock(hashtext($1)::bigint)",
                    &[&lock_name],
                )
                .map_err(|error| format!("hold generated tenant activation lock: {error:?}"))?;
            let lock_started = Instant::now();
            let activation_database_url = installer_database_url.clone();
            let activation_schema_name = schema_name.clone();
            let activation_request_json = json!({
                "app_id":"lookup_scale",
                "customer_id":activation_customer,
                "schema_revision_id":activation_revision_id,
                "effective_artifact_hash":activation_request["effective_artifact_hash"],
                "expected_active_effective_hash":null
            });
            let activation_handle = thread::spawn(move || {
                let mut worker = connect_postgres(&activation_database_url)
                    .expect("connect generated tenant activation worker");
                worker
                    .batch_execute(&format!("set search_path to \"{activation_schema_name}\""))
                    .expect("set activation worker schema path");
                let started = Instant::now();
                let response: Value = worker
                    .query_one(
                        &format!("select \"{activation_schema_name}\".kernel_activate_tenant_schema_revision($1::jsonb)"),
                        &[&activation_request_json],
                    )
                    .expect("call generated tenant activation under contention")
                    .get(0);
                (response, started.elapsed().as_secs_f64() * 1000.0)
            });
            let wait_deadline = Instant::now() + StdDuration::from_secs(10);
            let mut activation_waiter_observed = false;
            while Instant::now() < wait_deadline {
                let waiting: bool = client
                    .query_one(
                        r#"
                        select exists (
                          select 1 from pg_locks locks
                          join pg_stat_activity activity using (pid)
                          where not locks.granted
                            and activity.query like '%kernel_activate_tenant_schema_revision%'
                        )
                        "#,
                        &[],
                    )
                    .map_err(|error| {
                        format!("observe generated activation lock waiter: {error:?}")
                    })?
                    .get(0);
                if waiting {
                    activation_waiter_observed = true;
                    break;
                }
                thread::sleep(StdDuration::from_millis(10));
            }
            if !activation_waiter_observed {
                return Err(
                    "generated tenant activation did not enter advisory-lock wait".to_string(),
                );
            }
            thread::sleep(StdDuration::from_millis(250));
            client
                .batch_execute("commit")
                .map_err(|error| format!("release generated tenant activation lock: {error:?}"))?;
            let (activation_response, activation_elapsed_ms) = activation_handle
                .join()
                .map_err(|_| "generated tenant activation worker panicked".to_string())?;
            if activation_response["ok"] != false
                || activation_response["error"]["details"][0]["code"]
                    != "app_base_requires_group_activation"
            {
                return Err(format!(
                    "activation contention probe returned an unexpected response: {activation_response}"
                ));
            }
            if activation_elapsed_ms > ACTIVATION_LOCK_CALL_THRESHOLD_MS {
                return Err(format!(
                    "activation lock-wait call {activation_elapsed_ms:.2} ms exceeds benchmark threshold {ACTIVATION_LOCK_CALL_THRESHOLD_MS:.2} ms"
                ));
            }
            let lock_wait_ms = lock_started.elapsed().as_secs_f64() * 1000.0;
            println!(
                "A462_BENCHMARK_RESULT {}",
                json!({
                    "workload":"tenant_activation_lock_wait",
                    "observed_ungranted_advisory_lock":activation_waiter_observed,
                    "held_ms":lock_wait_ms,
                    "call_elapsed_ms":activation_elapsed_ms,
                    "call_threshold_ms":ACTIVATION_LOCK_CALL_THRESHOLD_MS,
                    "probe_result":"activation_mode_mismatch_after_lock",
                    "expected_mode":"tenant_overlay"
                })
            );

            client
                .batch_execute(&format!("set search_path to \"{schema_name}\""))
                .map_err(|error| {
                    format!("restore tenant contention fixture schema path: {error:?}")
                })?;
            let mutation_customer = "mutation_contention";
            let mut mutation_schema = compiled.schema.clone();
            mutation_schema.customer_id = CustomerId::from(mutation_customer);
            let mutation_schema_json = serde_json::to_value(&mutation_schema)
                .map_err(|error| format!("serialize tenant mutation baseline: {error}"))?;
            let mutation_hash = schema_hash(&mutation_schema);
            let mutation_revision_id: i64 = client
                .query_one(
                    r#"
                    insert into schema_revision(
                      app_id,customer_id,version,base_schema,customer_overlay,schema,
                      schema_hash,materialized_at,activated_at
                    ) values ('lookup_scale',$1,'v1',$2,'{}'::jsonb,$2,$3,now(),now())
                    returning id
                    "#,
                    &[&mutation_customer, &mutation_schema_json, &mutation_hash],
                )
                .map_err(|error| format!("seed tenant mutation baseline: {error:?}"))?
                .get(0);
            client
                .execute(
                    r#"
                    insert into schema_installation_revision(
                      schema_revision_id,app_id,customer_id,release_id,activation_kind,
                      base_artifact_hash,effective_artifact_hash,materialization_plan_hash,
                      phase_plan,phase_results,ready_at,activated_at
                    ) values ($1,'lookup_scale',$2,'a462-contention-baseline','tenant_overlay',
                      $3,$3,$3,'[]'::jsonb,'[]'::jsonb,now(),now())
                    "#,
                    &[&mutation_revision_id, &mutation_customer, &mutation_hash],
                )
                .map_err(|error| format!("seed tenant mutation installation ledger: {error:?}"))?;
            client
                .execute(
                    r#"
                    insert into lookup_storage_authority(
                      app_id,customer_id,model_id,schema_hash,authority,
                      legacy_record_table,legacy_version_table,activated_at
                    ) values ('lookup_scale',$1,'option',$2,'generic',
                      'option_record','option_version',now())
                    "#,
                    &[&mutation_customer, &mutation_hash],
                )
                .map_err(|error| format!("seed tenant mutation lookup authority: {error:?}"))?;
            let mutation_binding: Value = client
                .query_one(
                    "select kernel_bind_principal_scope($1::jsonb)",
                    &[&json!({
                        "principal_name":admin_principal,
                        "capability":"schema_admin",
                        "app_id":"lookup_scale",
                        "customer_id":mutation_customer,
                        "actor_id":"a462-contention-admin"
                    })],
                )
                .map_err(|error| format!("bind tenant mutation schema-admin scope: {error:?}"))?
                .get(0);
            if mutation_binding["ok"] != true {
                return Err(format!(
                    "bind tenant mutation schema-admin scope: {mutation_binding}"
                ));
            }
            let mutation_barrier = Arc::new(Barrier::new(3));
            let mutation_handles = ["Race A", "Race B"]
                .into_iter()
                .enumerate()
                .map(|(index, label)| {
                    let database_url = admin_database_url.clone();
                    let schema_name = schema_name.clone();
                    let barrier = Arc::clone(&mutation_barrier);
                    let request = json!({
                        "app_id":"lookup_scale",
                        "customer_id":mutation_customer,
                        "actor_id":"a462-contention-admin",
                        "reason":"Measure competing tenant schema edits",
                        "idempotency_key":format!("a462-tenant-race-{index}"),
                        "expected_revision_id":mutation_revision_id.to_string(),
                        "expected_effective_hash":mutation_hash,
                        "operations":[{
                            "type":"create_model",
                            "model":{
                                "kind":"lookup","label":label,
                                "display_field_id":"name",
                                "fields":[{
                                    "id":"name","label":"Name","type":"text",
                                    "required":true,"is_unique":false
                                }],
                                "many_relations":[]
                            }
                        }]
                    });
                    thread::spawn(move || {
                        let mut worker = connect_postgres(&database_url)
                            .expect("connect competing tenant schema editor");
                        worker
                            .batch_execute(&format!("set search_path to \"{schema_name}\""))
                            .expect("set tenant mutation worker schema path");
                        barrier.wait();
                        let started = Instant::now();
                        let response: Value = worker
                            .query_one(
                                &format!("select \"{schema_name}\".kernel_commit_tenant_schema_revision($1::jsonb)"),
                                &[&request],
                            )
                            .expect("call generated tenant schema mutation")
                            .get(0);
                        (response, started.elapsed().as_secs_f64() * 1000.0)
                    })
                })
                .collect::<Vec<_>>();
            mutation_barrier.wait();
            let mutation_results = mutation_handles
                .into_iter()
                .map(|handle| handle.join().expect("tenant mutation worker"))
                .collect::<Vec<_>>();
            let mutation_successes = mutation_results
                .iter()
                .filter(|(response, _)| response["ok"] == true)
                .count();
            let stale_losers = mutation_results
                .iter()
                .filter(|(response, _)| {
                    response["error"]["details"][0]["code"] == "stale_schema_revision"
                })
                .count();
            if mutation_successes != 1 || stale_losers != 1 {
                return Err(format!(
                    "competing tenant schema mutations did not serialize by revision: {mutation_results:?}"
                ));
            }
            let mut mutation_samples_ms = mutation_results
                .iter()
                .map(|(_, elapsed_ms)| *elapsed_ms)
                .collect::<Vec<_>>();
            mutation_samples_ms.sort_by(f64::total_cmp);
            let mutation_p95_ms = mutation_samples_ms[mutation_samples_ms.len() - 1];
            if mutation_p95_ms > TENANT_MUTATION_P95_THRESHOLD_MS {
                return Err(format!(
                    "tenant mutation contention p95 {mutation_p95_ms:.2} ms exceeds benchmark threshold {TENANT_MUTATION_P95_THRESHOLD_MS:.2} ms"
                ));
            }
            println!(
                "A462_BENCHMARK_RESULT {}",
                json!({
                    "workload":"tenant_schema_mutation_contention",
                    "concurrency":mutation_samples_ms.len(),
                    "successes":mutation_successes,
                    "stale_revision_losers":stale_losers,
                    "samples_ms":mutation_samples_ms,
                    "p95_ms":mutation_p95_ms,
                    "p95_threshold_ms":TENANT_MUTATION_P95_THRESHOLD_MS
                })
            );

            let other_tenant: Value = runtime_client
            .query_one(
                &format!("select \"{schema_name}\".kernel_lookup_list($1::jsonb)"),
                &[&json!({"app_id":"lookup_scale","customer_id":"tenant_b","model_id":"option","limit":25})],
            )
            .map_err(|error| format!("check runtime tenant scope: {error:?}"))?
            .get(0);
            assert_eq!(
                other_tenant["ok"], false,
                "runtime principal crossed tenant scope"
            );
            assert!(rows.windows(2).all(|pair| {
                pair[0]["normalized_label"]
                    .as_str()
                    .expect("first normalized label")
                    < pair[1]["normalized_label"]
                        .as_str()
                        .expect("second normalized label")
            }));

            let plan = client
                .query(
                    r#"
                explain (format text)
                select normalized_alias,record_id
                from lookup_alias_projection
                where app_id='lookup_scale' and customer_id='tenant_a' and model_id='option'
                  and kind='display'
                  and (normalized_alias,record_id) > ('label_0999900',$1)
                order by normalized_alias,record_id limit 25
                "#,
                    &[&cursor_id],
                )
                .map_err(|error| format!("explain scale page: {error:?}"))?
                .into_iter()
                .map(|row| row.get::<_, String>(0))
                .collect::<Vec<_>>()
                .join("\n");
            assert!(
                plan.contains("lookup_alias_projection_display_page_idx"),
                "scale page did not use the display index:\n{plan}"
            );
            samples_ms.sort_by(f64::total_cmp);
            let median_ms = samples_ms[samples_ms.len() / 2];
            let p95_ms = samples_ms[(samples_ms.len() * 95).div_ceil(100) - 1];
            let p95_threshold_ms = match env::var("A462_LOOKUP_PAGE_P95_THRESHOLD_MS") {
                Ok(value) => value
                    .parse::<f64>()
                    .map_err(|error| format!("invalid lookup p95 threshold: {error}"))?,
                Err(env::VarError::NotPresent) => 250.0,
                Err(error) => return Err(format!("invalid lookup p95 threshold: {error}")),
            };
            if !p95_threshold_ms.is_finite() || p95_threshold_ms <= 0.0 {
                return Err("lookup p95 threshold must be a positive finite number".to_string());
            }
            if p95_ms > p95_threshold_ms {
                return Err(format!(
                    "lookup page p95 {p95_ms:.2} ms exceeds regression threshold {p95_threshold_ms:.2} ms"
                ));
            }
            println!(
                "A462_BENCHMARK_RESULT {}",
                json!({
                    "workload": "lookup_keyset_pagination",
                    "rows": ROW_COUNT,
                    "page_size": 25,
                    "warmup_calls": 1,
                    "measured_calls": samples_ms.len(),
                    "seed_ms": seed_elapsed_ms,
                    "samples_ms": samples_ms,
                    "median_ms": median_ms,
                    "p95_ms": p95_ms,
                    "p95_threshold_ms": p95_threshold_ms,
                    "plan": plan
                })
            );
            Ok(())
        })()
    }));

    let _ = client.batch_execute("rollback; set search_path to public");
    let cleanup = client.batch_execute(&format!(
        "set search_path to public; drop schema \"{schema_name}\" cascade; revoke connect on database \"{database_name}\" from \"{principal}\", \"{admin_principal}\", \"{installer_principal}\"; drop role if exists \"{principal}\"; drop role if exists \"{admin_principal}\"; drop role if exists \"{installer_principal}\""
    ));
    cleanup.expect("drop scale schema and benchmark principals");
    match result {
        Ok(result) => result.expect("A-462 generated lookup scale benchmark"),
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

fn principal_database_url(
    database_url: &str,
    principal: &str,
    password: &str,
) -> Result<String, String> {
    let authority_start = database_url
        .find("://")
        .map(|index| index + 3)
        .ok_or_else(|| "database URL is missing a scheme".to_string())?;
    let authority_end = database_url[authority_start..]
        .find(['/', '?'])
        .map(|index| authority_start + index)
        .unwrap_or(database_url.len());
    let host_start = database_url[authority_start..authority_end]
        .rfind('@')
        .map(|index| authority_start + index + 1)
        .unwrap_or(authority_start);
    Ok(format!(
        "{}{}:{}@{}",
        &database_url[..authority_start],
        principal,
        password,
        &database_url[host_start..]
    ))
}

fn compiled() -> CompiledManifest {
    CompiledManifest {
        schema: Schema {
            app_id: AppId::from("lookup_scale"),
            customer_id: CustomerId::from("tenant_a"),
            version: SchemaVersion::from("v1"),
            models: vec![Model {
                id: ModelId::from("option"),
                kind: ModelKind::Lookup,
                label: "Option".to_string(),
                display_field_id: Some(FieldId::from("name")),
                fields: vec![Field {
                    id: FieldId::from("name"),
                    label: "Name".to_string(),
                    field_type: FieldType::Text,
                    required: true,
                    ..Field::default()
                }],
                ..Model::default()
            }],
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

fn test_database_url() -> Option<String> {
    match env::var("KERNEL_TEST_DATABASE_URL") {
        Ok(url) => Some(url),
        Err(env::VarError::NotPresent) => {
            eprintln!(
                "skipping generated lookup scale benchmark: KERNEL_TEST_DATABASE_URL is absent"
            );
            None
        }
        Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
    }
}
