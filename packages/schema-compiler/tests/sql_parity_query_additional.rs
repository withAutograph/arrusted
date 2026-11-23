#[path = "support/trusted_human.rs"]
mod trusted_human;
use std::collections::BTreeMap;
use std::error::Error as StdError;
use std::fmt;
use std::{env, result};

use chrono::NaiveDate;
use kernel::testing::{call_generated_sql, GeneratedSqlFunction};
use kernel::{
    AppId, AppliedChangeSet, ApplyChangeSet, ApplyMode, ChangeSetDiff, ChangeSetDiffRequest,
    ChangeType, ChangeTypeId, CustomerId, ExternalKey, Field, FieldHistoryEntry,
    FieldHistoryRequest, FieldId, FieldType, FieldValue, Model, ModelId, ModelKind,
    MoneyRatePeriod, MoneyRateValue, QueryColumn, QueryResult, QueryVisibleSql, RecordKey,
    RowVersionWrite, Schema, SchemaVersion, SqlParam, VisibleRecord,
};
use postgres::error::SqlState;
use postgres::types::{Format, IsNull, ToSql, Type};
use postgres::{Client, Transaction};
use rust_decimal::Decimal;
use schema_compiler::{
    compile_sql_artifact_manifest, query_generated_visible_sql, render_sql_artifact_bundle,
    CompiledManifest, GeneratedQueryClient, GeneratedQueryError, GeneratedQueryExecutionError,
    GeneratedQueryTransaction, NormalizedManifestExtras,
};
use serde_json::{json, Value};
use uuid::Uuid;

const APP_ID: &str = "query_app";

struct TestDatabase {
    client: Client,
    schema_name: String,
}

impl TestDatabase {
    fn connect(schema: Schema) -> Option<Self> {
        let database_url = match env::var("KERNEL_TEST_DATABASE_URL") {
            Ok(url) => url,
            Err(env::VarError::NotPresent) => {
                eprintln!(
                    "skipping generated SQL query parity test: KERNEL_TEST_DATABASE_URL is absent"
                );
                return None;
            }
            Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
        };
        let mut client = kernel::connect_postgres(&database_url)
            .expect("connect generated SQL query parity test");
        let schema_name = format!("kernel_query_{}", Uuid::new_v4().simple());
        client
            .batch_execute(&format!(
                r#"
                create schema "{schema_name}";
                set search_path to "{schema_name}";
                "#
            ))
            .expect("provision generated SQL query schema");
        let manifest = compile_sql_artifact_manifest(&compiled_manifest(schema.clone()))
            .expect("compile generated SQL query bundle");
        trusted_human::before_install(&mut client);
        client
            .batch_execute(&render_sql_artifact_bundle(&manifest))
            .unwrap_or_else(|error| panic!("install generated SQL query bundle: {error:?}"));
        trusted_human::grant_capability(&mut client, "query");
        set_scope(&mut client, schema.customer_id.as_str());
        let schema_json = serde_json::to_value(&schema).expect("serialize query parity schema");
        client
            .execute(
                r#"
                insert into schema_revision (
                  id, app_id, customer_id, version, base_schema, customer_overlay,
                  schema, activated_at, materialized_at
                ) values (1, $1, $2, $3, $4, '{}', $4, now(), now())
                "#,
                &[
                    &schema.app_id.as_str(),
                    &schema.customer_id.as_str(),
                    &schema.version.as_str(),
                    &schema_json,
                ],
            )
            .expect("activate generated SQL query schema");
        trusted_human::bind(
            &mut client,
            schema.app_id.as_str(),
            schema.customer_id.as_str(),
            "tester",
        );
        Some(Self {
            client,
            schema_name,
        })
    }

    fn apply(&mut self, request: &ApplyChangeSet) -> AppliedChangeSet {
        call_generated_sql(
            &mut self.client,
            GeneratedSqlFunction::ApplyChangeSet,
            request,
        )
        .expect("apply generated SQL query fixture")
    }

    fn query(&mut self, request: &QueryVisibleSql) -> result::Result<QueryResult, QueryFailure> {
        let schema_name = self.schema_name.clone();
        let mut client = PostgresGeneratedQueryClient(&mut self.client);
        let result =
            query_generated_visible_sql(&mut client, &schema_name, request).map_err(|error| {
                match error {
                    GeneratedQueryError::Timeout { .. } => QueryFailure::Timeout,
                    error => QueryFailure::Rejected(error.to_string()),
                }
            });
        self.assert_protocol_clean();
        result
    }

    fn assert_protocol_clean(&mut self) {
        let row = self
            .client
            .query_one(
                r#"
                select current_user = session_user,
                       not exists (
                         select 1
                         from pg_class
                         where relkind = 'v' and relnamespace = pg_my_temp_schema()
                       )
                "#,
                &[],
            )
            .expect("inspect generated query protocol cleanup");
        assert!(row.get::<_, bool>(0), "query role leaked after protocol");
        assert!(row.get::<_, bool>(1), "temporary query view leaked");
    }
}

struct PostgresGeneratedQueryClient<'a>(&'a mut Client);

struct PostgresGeneratedQueryTransaction<'a>(Transaction<'a>);

impl GeneratedQueryClient for PostgresGeneratedQueryClient<'_> {
    type Error = postgres::Error;
    type Transaction<'a>
        = PostgresGeneratedQueryTransaction<'a>
    where
        Self: 'a;

    fn begin_generated_query(&mut self) -> Result<Self::Transaction<'_>, Self::Error> {
        self.0.transaction().map(PostgresGeneratedQueryTransaction)
    }

    fn cleanup_visible_query(&mut self, statement: &str) -> Result<(), Self::Error> {
        self.0.query_one(statement, &[]).map(|_| ())
    }
}

impl GeneratedQueryTransaction for PostgresGeneratedQueryTransaction<'_> {
    type Error = postgres::Error;

    fn call_json(&mut self, statement: &str, request: &Value) -> Result<Value, Self::Error> {
        self.0
            .query_one(statement, &[request])
            .map(|row| row.get(0))
    }

    fn batch_execute(&mut self, statement: &str) -> Result<(), Self::Error> {
        self.0.batch_execute(statement)
    }

    fn execute_caller_query(
        &mut self,
        request: &QueryVisibleSql,
    ) -> Result<QueryResult, GeneratedQueryExecutionError<Self::Error>> {
        let parameter_types = query_parameter_types(&request.params);
        let parameter_values = query_parameter_values(&request.params);
        let parameters = parameter_values
            .iter()
            .map(|value| value.as_ref() as &(dyn ToSql + Sync))
            .collect::<Vec<_>>();
        let statement = self
            .0
            .prepare_typed(&request.sql, &parameter_types)
            .map_err(query_execution_error)?;
        let mut seen = std::collections::BTreeSet::new();
        let columns = statement
            .columns()
            .iter()
            .map(|column| {
                if !seen.insert(column.name().to_string()) {
                    return Err(GeneratedQueryExecutionError::Rejected(format!(
                        "duplicate result column `{}`",
                        column.name()
                    )));
                }
                Ok(QueryColumn {
                    name: column.name().to_string(),
                    type_name: column.type_().name().to_string(),
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let execution_sql = format!(
            "select to_jsonb(kernel_query_result) as row_json from ({}) kernel_query_result",
            request.sql
        );
        let execution = self
            .0
            .prepare_typed(&execution_sql, &parameter_types)
            .map_err(query_execution_error)?;
        let rows = self
            .0
            .query(&execution, &parameters)
            .map_err(query_execution_error)?
            .into_iter()
            .map(|row| {
                let object: Value = row.get("row_json");
                columns
                    .iter()
                    .map(|column| object.get(&column.name).cloned().unwrap_or(Value::Null))
                    .collect()
            })
            .collect();
        Ok(QueryResult { columns, rows })
    }

    fn rollback(self) -> Result<(), Self::Error> {
        self.0.rollback()
    }
}

fn query_execution_error(error: postgres::Error) -> GeneratedQueryExecutionError<postgres::Error> {
    if error.code() == Some(&SqlState::QUERY_CANCELED) {
        GeneratedQueryExecutionError::Timeout(error.to_string())
    } else {
        GeneratedQueryExecutionError::Rejected(error.to_string())
    }
}

impl Drop for TestDatabase {
    fn drop(&mut self) {
        let _ = trusted_human::drop_fixture(&mut self.client, &self.schema_name);
    }
}

#[derive(Debug, PartialEq, Eq)]
enum QueryFailure {
    Rejected(String),
    Timeout,
}

#[derive(Debug)]
struct NumericParam(Decimal);

impl ToSql for NumericParam {
    fn to_sql(
        &self,
        ty: &Type,
        out: &mut postgres::types::private::BytesMut,
    ) -> result::Result<IsNull, Box<dyn StdError + Sync + Send>> {
        if !Self::accepts(ty) {
            return Err(format!("NumericParam cannot encode Postgres type {}", ty.name()).into());
        }
        out.extend_from_slice(self.0.to_string().as_bytes());
        Ok(IsNull::No)
    }

    fn accepts(ty: &Type) -> bool {
        *ty == Type::NUMERIC
    }

    fn encode_format(&self, _ty: &Type) -> Format {
        Format::Text
    }

    postgres::types::to_sql_checked!();
}

#[test]
fn query_visible_sql_filters_projects_joins_aggregates_and_windows() {
    let customer_id = "customer_a";
    let Some(mut database) = TestDatabase::connect(test_schema(customer_id)) else {
        return;
    };
    database.apply(&mainline_apply(
        customer_id,
        "sql-company-acme",
        vec![company_write("acme", "Acme")],
    ));
    database.apply(&mainline_apply(
        customer_id,
        "sql-employee-alice",
        vec![employee_write("alice", "Alice", "acme")],
    ));

    let result = database
        .query(&query_request(
            customer_id,
            r#"
            select
              er.external_key as employee_key,
              ev.name as employee_name,
              cr.external_key as company_key,
              ev.comp_rate_amount as hourly_rate,
              count(*) over () as visible_count
            from employee_record er
            join employee_version ev on ev.record_id = er.id
            join company_record cr on cr.id = ev.employer
            join company_version cv on cv.record_id = cr.id
            where ev.stage = 'mainline'
              and ev.effective_start <= $1
              and (ev.effective_end is null or ev.effective_end >= $1)
              and ev.comp_rate_amount >= $2
              and not ev.tombstones_record
              and cv.stage = 'mainline'
            order by er.external_key
            "#,
            vec![
                SqlParam::Date(date("2026-05-15")),
                SqlParam::Number(Decimal::new(12500, 2)),
            ],
        ))
        .expect("execute generated typed join query");
    assert_eq!(
        result
            .columns
            .iter()
            .map(|column| column.name.as_str())
            .collect::<Vec<_>>(),
        vec![
            "employee_key",
            "employee_name",
            "company_key",
            "hourly_rate",
            "visible_count"
        ]
    );
    assert_eq!(
        result.rows,
        vec![vec![
            json!("alice"),
            json!("Alice"),
            json!("acme"),
            json!(125.00),
            json!(1)
        ]]
    );
}

#[test]
fn query_visible_sql_allows_model_tables_with_pg_prefix() {
    let customer_id = "customer_a";
    let Some(mut database) = TestDatabase::connect(pg_prefix_schema(customer_id)) else {
        return;
    };
    database.apply(&mainline_apply(
        customer_id,
        "sql-pg-data",
        vec![RowVersionWrite {
            model_id: ModelId::from("pg_data"),
            new_record_id: None,
            record_key: Some(RecordKey::ExternalKey(ExternalKey::from("alpha"))),
            effective_start: date("2026-05-01"),
            values: Some(text_values("Alpha")),
            custom_fields: None,
            tombstones_record: false,
            provenance: None,
            ..Default::default()
        }],
    ));
    let result = database
        .query(&query_request(
            customer_id,
            r#"
            select r.external_key, v.name
            from pg_data_record r
            join pg_data_version v on v.record_id = r.id
            where v.stage = 'mainline'
            "#,
            vec![],
        ))
        .expect("query app model whose identifier starts with pg");
    assert_eq!(result.rows, vec![vec![json!("alpha"), json!("Alpha")]]);
}

#[test]
fn query_visible_sql_drops_stale_temp_views_before_preparing_request_views() {
    let customer_id = "customer_a";
    let Some(mut database) = TestDatabase::connect(test_schema(customer_id)) else {
        return;
    };
    database
        .client
        .batch_execute("create temp view stale_query_view as select 1 as value")
        .expect("create stale query view");
    database
        .query(&query_request(
            customer_id,
            "select count(*) from company_record",
            vec![],
        ))
        .expect("query after stale-view cleanup");
    database.assert_protocol_clean();

    database
        .client
        .batch_execute("create temp view stale_query_view as select 1 as value")
        .expect("recreate stale query view");
    assert!(matches!(
        database.query(&query_request(
            customer_id,
            "delete from change_set",
            vec![],
        )),
        Err(QueryFailure::Rejected(_))
    ));
    database.assert_protocol_clean();
}

#[test]
fn generated_runtime_boundaries_drop_persisted_workbench_views() {
    let customer_id = "customer_workbench_isolation";
    let other_customer_id = "customer_workbench_other";
    let Some(mut database) = TestDatabase::connect(test_schema(customer_id)) else {
        return;
    };
    activate_additional_tenant(&mut database.client, &test_schema(other_customer_id));

    let first = database.apply(&mainline_apply(
        customer_id,
        "workbench-isolation-first",
        vec![company_write_at("acme", "Acme A", "2026-05-01")],
    ));
    let second = database.apply(&mainline_apply(
        customer_id,
        "workbench-isolation-second",
        vec![company_write_at("acme", "Acme B", "2026-06-01")],
    ));
    database.apply(&mainline_apply(
        other_customer_id,
        "workbench-isolation-other",
        vec![company_write_at("other", "Other Tenant", "2026-05-01")],
    ));

    let workbench = database
        .query(&QueryVisibleSql {
            as_of: Some(date("2026-05-15")),
            ..query_request(
                customer_id,
                "select name from company_version order by name",
                vec![],
            )
        })
        .expect("query initial generated workbench snapshot");
    assert_eq!(workbench.rows, vec![vec![json!("Acme A")]]);

    install_persisted_workbench_views(&mut database, customer_id, "2026-05-15");
    let visible: Vec<VisibleRecord> = call_generated_sql(
        &mut database.client,
        GeneratedSqlFunction::ReadVisibleRecords,
        &json!({
            "app_id": APP_ID,
            "customer_id": customer_id,
            "model_id": "company",
            "as_of": "2026-06-15"
        }),
    )
    .expect("read through persisted generated workbench views");
    assert_eq!(visible.len(), 1);
    assert_eq!(
        visible[0].values.get(&FieldId::from("name")),
        Some(&FieldValue::Text("Acme B".to_string()))
    );

    install_persisted_workbench_views(&mut database, customer_id, "2026-05-15");
    let diff: ChangeSetDiff = call_generated_sql(
        &mut database.client,
        GeneratedSqlFunction::ChangeSetDiff,
        &ChangeSetDiffRequest {
            app_id: AppId::from(APP_ID),
            customer_id: CustomerId::from(customer_id),
            change_set_id: second.id,
            project: vec![FieldId::from("name")],
        },
    )
    .expect("diff through persisted generated workbench views");
    assert_eq!(diff.records.len(), 1);
    assert_eq!(
        diff.records[0].fields[0].before,
        Some(FieldValue::Text("Acme A".to_string()))
    );
    assert_eq!(
        diff.records[0].fields[0].after,
        Some(FieldValue::Text("Acme B".to_string()))
    );

    install_persisted_workbench_views(&mut database, customer_id, "2026-05-15");
    let history: Vec<FieldHistoryEntry> = call_generated_sql(
        &mut database.client,
        GeneratedSqlFunction::FieldHistory,
        &FieldHistoryRequest {
            app_id: AppId::from(APP_ID),
            customer_id: CustomerId::from(customer_id),
            model_id: ModelId::from("company"),
            record_id: visible[0].record_id,
            field_id: Some(FieldId::from("name")),
            as_of: None,
            limit: None,
            stages: vec![],
        },
    )
    .expect("history through persisted generated workbench views");
    assert_eq!(
        history
            .iter()
            .map(|entry| (entry.change_set_id, entry.value.clone()))
            .collect::<Vec<_>>(),
        vec![
            (first.id, Some(FieldValue::Text("Acme A".to_string()))),
            (second.id, Some(FieldValue::Text("Acme B".to_string()))),
        ]
    );

    install_persisted_workbench_views(&mut database, customer_id, "2026-05-15");
    database.apply(&mainline_apply(
        customer_id,
        "workbench-isolation-third",
        vec![company_write_at("acme", "Acme C", "2026-07-01")],
    ));

    for _ in 0..2 {
        let repeated = database
            .query(&QueryVisibleSql {
                as_of: Some(date("2026-07-15")),
                ..query_request(
                    customer_id,
                    "select name from company_version order by name",
                    vec![],
                )
            })
            .expect("repeat generated workbench query");
        assert_eq!(repeated.rows, vec![vec![json!("Acme C")]]);
    }
}

#[test]
fn same_day_read_query_history_and_diff_share_applied_order() {
    let customer_id = "customer_same_day_readers";
    let Some(mut database) = TestDatabase::connect(test_schema(customer_id)) else {
        return;
    };
    let mut change_sets = Vec::new();
    for (index, name) in ["Acme A", "Acme B", "Acme C"].into_iter().enumerate() {
        change_sets.push(database.apply(&mainline_apply(
            customer_id,
            &format!("same-day-reader-{index}"),
            vec![company_write("acme", name)],
        )));
    }
    set_scope(&mut database.client, customer_id);
    database
        .client
        .execute(
            r#"
            update company_version
            set created_at = case change_set_id
              when $1 then timestamptz '2026-05-03 00:00:00+00'
              when $2 then timestamptz '2026-05-02 00:00:00+00'
              when $3 then timestamptz '2026-05-01 00:00:00+00'
            end
            where change_set_id = any($4)
            "#,
            &[
                &change_sets[0].id,
                &change_sets[1].id,
                &change_sets[2].id,
                &change_sets
                    .iter()
                    .map(|change| change.id)
                    .collect::<Vec<_>>(),
            ],
        )
        .expect("invert generated same-day creation timestamps");

    let visible: Vec<VisibleRecord> = call_generated_sql(
        &mut database.client,
        GeneratedSqlFunction::ReadVisibleRecords,
        &json!({
            "app_id": APP_ID,
            "customer_id": customer_id,
            "model_id": "company",
            "as_of": "2026-05-01"
        }),
    )
    .expect("read generated same-day visible record");
    assert_eq!(visible.len(), 1);
    assert_eq!(
        visible[0].values.get(&FieldId::from("name")),
        Some(&FieldValue::Text("Acme C".to_string()))
    );

    let query = database
        .query(&QueryVisibleSql {
            as_of: Some(date("2026-05-01")),
            ..query_request(
                customer_id,
                "select name, change_set_id from company_version",
                vec![],
            )
        })
        .expect("query generated same-day snapshot");
    assert_eq!(
        query.rows,
        vec![vec![json!("Acme C"), json!(change_sets[2].id)]]
    );

    let diff: ChangeSetDiff = call_generated_sql(
        &mut database.client,
        GeneratedSqlFunction::ChangeSetDiff,
        &ChangeSetDiffRequest {
            app_id: AppId::from(APP_ID),
            customer_id: CustomerId::from(customer_id),
            change_set_id: change_sets[2].id,
            project: vec![FieldId::from("name")],
        },
    )
    .expect("diff generated same-day change set");
    assert_eq!(
        diff.records[0].fields[0].before,
        Some(FieldValue::Text("Acme B".to_string()))
    );
    assert_eq!(
        diff.records[0].fields[0].after,
        Some(FieldValue::Text("Acme C".to_string()))
    );

    let history: Vec<FieldHistoryEntry> = call_generated_sql(
        &mut database.client,
        GeneratedSqlFunction::FieldHistory,
        &FieldHistoryRequest {
            app_id: AppId::from(APP_ID),
            customer_id: CustomerId::from(customer_id),
            model_id: ModelId::from("company"),
            record_id: visible[0].record_id,
            field_id: Some(FieldId::from("name")),
            as_of: None,
            limit: Some(2),
            stages: vec![],
        },
    )
    .expect("read generated same-day field history");
    assert_eq!(
        history
            .iter()
            .map(|entry| (entry.change_set_id, entry.value.clone()))
            .collect::<Vec<_>>(),
        vec![
            (
                change_sets[1].id,
                Some(FieldValue::Text("Acme B".to_string()))
            ),
            (
                change_sets[2].id,
                Some(FieldValue::Text("Acme C".to_string()))
            ),
        ]
    );
}

fn query_parameter_types(params: &[SqlParam]) -> Vec<Type> {
    params
        .iter()
        .map(|param| match param {
            SqlParam::Text(_) => Type::TEXT,
            SqlParam::Int(_) => Type::INT8,
            SqlParam::Number(_) => Type::NUMERIC,
            SqlParam::Bool(_) => Type::BOOL,
            SqlParam::Date(_) => Type::DATE,
            SqlParam::Json(_) => Type::JSONB,
        })
        .collect()
}

fn query_parameter_values(params: &[SqlParam]) -> Vec<Box<dyn ToSql + Sync>> {
    params
        .iter()
        .map(|param| match param {
            SqlParam::Text(value) => Box::new(value.clone()) as Box<dyn ToSql + Sync>,
            SqlParam::Int(value) => Box::new(*value),
            SqlParam::Number(value) => Box::new(NumericParam(*value)),
            SqlParam::Bool(value) => Box::new(*value),
            SqlParam::Date(value) => Box::new(*value),
            SqlParam::Json(value) => Box::new(value.clone()),
        })
        .collect()
}

fn compiled_manifest(schema: Schema) -> CompiledManifest {
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

fn test_schema(customer_id: &str) -> Schema {
    Schema {
        app_id: AppId::from(APP_ID),
        customer_id: CustomerId::from(customer_id),
        version: SchemaVersion::from("2026-08-04"),
        models: vec![
            Model {
                id: ModelId::from("company"),
                kind: ModelKind::Entity,
                label: "Company".to_string(),
                fields: vec![text_field("name")],
                ..Default::default()
            },
            Model {
                id: ModelId::from("employee"),
                kind: ModelKind::Entity,
                label: "Employee".to_string(),
                fields: vec![
                    text_field("name"),
                    Field {
                        id: FieldId::from("employer"),
                        label: "Employer".to_string(),
                        field_type: FieldType::Relation,
                        required: false,
                        is_unique: false,
                        target_model: Some(ModelId::from("company")),
                        option_set: vec![],
                        ..Default::default()
                    },
                    Field {
                        id: FieldId::from("comp_rate"),
                        label: "Comp Rate".to_string(),
                        field_type: FieldType::MoneyRate,
                        required: false,
                        is_unique: false,
                        target_model: None,
                        option_set: vec![],
                        ..Default::default()
                    },
                ],
                ..Default::default()
            },
        ],
        custom_fields: vec![],
        change_types: vec![],
    }
}

fn pg_prefix_schema(customer_id: &str) -> Schema {
    Schema {
        app_id: AppId::from(APP_ID),
        customer_id: CustomerId::from(customer_id),
        version: SchemaVersion::from("2026-08-04"),
        models: vec![Model {
            id: ModelId::from("pg_data"),
            kind: ModelKind::Entity,
            label: "PG Data".to_string(),
            fields: vec![text_field("name")],
            ..Default::default()
        }],
        custom_fields: vec![],
        change_types: vec![ChangeType {
            id: ChangeTypeId::from("pg_data_update"),
            label: "PG Data Update".to_string(),
            target_model: ModelId::from("pg_data"),
            is_import_default: false,
            touches: vec![],
            required: vec![],
        }],
    }
}

fn text_field(id: &str) -> Field {
    Field {
        id: FieldId::from(id),
        label: id.to_string(),
        field_type: FieldType::Text,
        required: true,
        is_unique: false,
        target_model: None,
        option_set: vec![],
        ..Default::default()
    }
}

fn company_write(external_key: &str, name: &str) -> RowVersionWrite {
    company_write_at(external_key, name, "2026-05-01")
}

fn company_write_at(external_key: &str, name: &str, effective_start: &str) -> RowVersionWrite {
    RowVersionWrite {
        model_id: ModelId::from("company"),
        new_record_id: None,
        record_key: Some(RecordKey::ExternalKey(ExternalKey::from(external_key))),
        effective_start: date(effective_start),
        values: Some(text_values(name)),
        custom_fields: None,
        tombstones_record: false,
        provenance: None,
        ..Default::default()
    }
}

fn activate_additional_tenant(client: &mut Client, schema: &Schema) {
    trusted_human::bind(
        client,
        schema.app_id.as_str(),
        schema.customer_id.as_str(),
        "tester",
    );
    set_scope(client, schema.customer_id.as_str());
    let schema_json = serde_json::to_value(schema).expect("serialize additional tenant schema");
    client
        .execute(
            r#"
            insert into schema_revision (
              id, app_id, customer_id, version, base_schema, customer_overlay,
              schema, activated_at, materialized_at
            )
            select coalesce(max(id), 0) + 1, $1, $2, $3, $4, '{}', $4, now(), now()
            from schema_revision
            "#,
            &[
                &schema.app_id.as_str(),
                &schema.customer_id.as_str(),
                &schema.version.as_str(),
                &schema_json,
            ],
        )
        .expect("activate additional generated query tenant");
}

fn install_persisted_workbench_views(database: &mut TestDatabase, customer_id: &str, as_of: &str) {
    set_scope(&mut database.client, customer_id);
    let execution_role: String = database
        .client
        .query_one(
            &format!(
                "select \"{}\".kernel_installer_capability_role('execution_owner')",
                database.schema_name
            ),
            &[],
        )
        .expect("resolve generated execution owner")
        .get(0);
    let quoted_execution_role = format!("\"{}\"", execution_role.replace('"', "\"\""));
    database
        .client
        .batch_execute(&format!(
            r#"
            set role {execution_role};
            create temp view change_set as
              select *
              from "{schema}".change_set
              where app_id = '{app}' and customer_id = '{customer}';
            create temp view company_record as
              select *
              from "{schema}".company_record
              where app_id = '{app}' and customer_id = '{customer}';
            create temp view company_version as
              select *
              from "{schema}".company_version
              where app_id = '{app}'
                and customer_id = '{customer}'
                and effective_start <= date '{as_of}'
                and (effective_end is null or effective_end >= date '{as_of}');
            reset role;
            "#,
            execution_role = quoted_execution_role,
            schema = database.schema_name,
            app = APP_ID,
            customer = customer_id,
        ))
        .expect("install persisted generated workbench views");
}

fn employee_write(external_key: &str, name: &str, employer: &str) -> RowVersionWrite {
    let mut values = text_values(name);
    values.insert(
        FieldId::from("employer"),
        FieldValue::Relation(RecordKey::ExternalKey(ExternalKey::from(employer))),
    );
    values.insert(
        FieldId::from("comp_rate"),
        FieldValue::MoneyRate(MoneyRateValue {
            amount: Decimal::new(12500, 2),
            currency: "USD".to_string(),
            period: MoneyRatePeriod::Hourly,
        }),
    );
    RowVersionWrite {
        model_id: ModelId::from("employee"),
        new_record_id: None,
        record_key: Some(RecordKey::ExternalKey(ExternalKey::from(external_key))),
        effective_start: date("2026-05-01"),
        values: Some(values),
        custom_fields: None,
        tombstones_record: false,
        provenance: None,
        ..Default::default()
    }
}

fn text_values(name: &str) -> BTreeMap<FieldId, FieldValue> {
    BTreeMap::from([(FieldId::from("name"), FieldValue::Text(name.to_string()))])
}

fn mainline_apply(
    customer_id: &str,
    idempotency_key: &str,
    writes: Vec<RowVersionWrite>,
) -> ApplyChangeSet {
    ApplyChangeSet {
        app_id: AppId::from(APP_ID),
        customer_id: CustomerId::from(customer_id),
        schema_revision_id: None,
        actor_id: Some("tester".to_string()),
        source_kind: "test".to_string(),
        source_ref: None,
        idempotency_key: Some(idempotency_key.to_string()),
        change_type_id: None,
        notes: None,
        mode: ApplyMode::Mainline,
        writes,
    }
}

fn query_request(customer_id: &str, sql: &str, params: Vec<SqlParam>) -> QueryVisibleSql {
    QueryVisibleSql {
        app_id: AppId::from(APP_ID),
        customer_id: CustomerId::from(customer_id),
        as_of: None,
        sql: sql.to_string(),
        params,
        statement_timeout_ms: None,
    }
}

fn set_scope(client: &mut Client, customer_id: &str) {
    client
        .execute(
            "select set_config('kernel.app_id', $1, false), set_config('kernel.customer_id', $2, false)",
            &[&APP_ID, &customer_id],
        )
        .expect("set generated query tenant scope");
}

fn date(value: &str) -> NaiveDate {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").expect("valid query fixture date")
}

impl fmt::Display for QueryFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Rejected(message) => write!(formatter, "query rejected: {message}"),
            Self::Timeout => formatter.write_str("query timed out"),
        }
    }
}
