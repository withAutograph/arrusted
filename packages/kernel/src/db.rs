use std::collections::{BTreeMap, BTreeSet};
use std::error::Error as StdError;
use std::str::FromStr;
use std::sync::Arc;

use bytes::BytesMut;
use chrono::{DateTime, Duration, NaiveDate, Utc};
use postgres::{error::SqlState, Client, GenericClient, Row, Transaction};
use postgres_types::{Format, IsNull, ToSql, Type};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

use crate::contracts::{
    active_custom_field_definition, AgentRunLedgerEntry, AgentRunStatus, AgentRunStatusUpdate,
    AppId, ApplyChangeSet, ApplyMode, ChangeSetDiff, ChangeSetDiffRequest, ChangeSetStatus,
    ChangeTypeId, CommitEnumOptionSetRevision, CustomFieldDiff, CustomFieldEntry, CustomFieldType,
    CustomFieldValue, CustomerId, EnumAuditHydratedValue, EnumOption, EnumOptionId,
    EnumOptionSetTarget, ExternalKey, Field, FieldDiff, FieldHistoryEntry, FieldHistoryRequest,
    FieldId, FieldType, FieldValue, Model, ModelId, MoneyRatePeriod, MoneyRateValue, QueryColumn,
    QueryResult, QueryVisibleSql, RecentActivityEntry, RecentActivityRequest, RecordDiff, RecordId,
    RecordKey, RevertChangeSet, RowVersionWrite, Schema, SchemaElementLifecycle, SchemaRevisionId,
    SchemaVersion, SqlParam, VersionStage, AGENT_SOURCE_KIND,
};
use crate::error::{ErrorDetail, KernelError, KernelErrorDto, ValidationError, ValidationIssue};
use crate::identifiers::{bounded_physical_identifier, normalize_identifier, quote_identifier};
use crate::validation::{
    validate_agent_run_ledger_entry, validate_agent_run_status_update,
    validate_apply_against_schema, validate_schema, validate_schema_revision,
};

const TENANT_POLICY: &str = "platform_tenant_scope";
const SCHEMA_CATALOG_READ_SETTING: &str = "platform.schema_catalog_read";
// Schema materialization creates shared substrate tables before app-specific
// model tables. Use one transaction-scoped lock so pooled deploy connections
// cannot interleave cross-app DDL during cold starts.
const SCHEMA_MATERIALIZATION_LOCK: &str = "platform:schema-materialization";
const SCHEMA_ACTIVATION_HEAD_TABLE: &str = "schema_activation_head";
const SCHEMA_ACTIVATION_HEAD_FUNCTION: &str = "platform_enforce_schema_activation_head";
const SCHEMA_ACTIVATION_HEAD_TRIGGER: &str = "schema_revision_activation_head";
const SCHEMA_ACTIVATION_HEAD_FUNCTION_BODY: &str = r#"
declare
  required_base_schema_version text;
begin
  if new.activated_at is null then
    return new;
  end if;

  select base_schema_version
    into required_base_schema_version
    from schema_activation_head
   where app_id = new.app_id
     and customer_id = new.customer_id;

  if found
     and new.base_schema ->> 'version' is distinct from required_base_schema_version then
    raise exception
      'schema revision base version % is behind activation head % for app % customer %',
      new.base_schema ->> 'version',
      required_base_schema_version,
      new.app_id,
      new.customer_id
      using errcode = '23514',
            constraint = 'schema_revision_activation_head_check';
  end if;

  return new;
end;
"#;
// Identifier cutovers require a clean or explicitly rematerialized schema; do
// not alias predecessor role or policy names at this boundary.
const QUERY_ROLE: &str = "kernel_query";
const DEFAULT_QUERY_TIMEOUT_MS: u64 = 1_000;
const MAX_QUERY_TIMEOUT_MS: u64 = 5_000;
const QUERY_WORK_MEM: &str = "4MB";
// Bound version snapshots before expanding each snapshot into per-field history entries.
const MAX_FIELD_HISTORY_VERSION_LIMIT: i64 = 100;
const APPLY_DEPENDENCY_DRIFT_MESSAGE: &str = "record apply dependency drift";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VersionOrderDirection {
    Ascending,
    Descending,
}

fn version_precedence_sql(
    version_alias: &str,
    change_set_alias: &str,
    direction: VersionOrderDirection,
    include_draft_precedence: bool,
) -> String {
    let direction = match direction {
        VersionOrderDirection::Ascending => "asc",
        VersionOrderDirection::Descending => "desc",
    };
    let mut keys = vec![
        format!("{version_alias}.effective_start {direction}"),
        format!("{version_alias}.tombstones_record {direction}"),
        format!("{version_alias}.untombstones_record {direction}"),
    ];
    if include_draft_precedence {
        keys.push(format!(
            "case when {version_alias}.stage = 'draft' then 1 else 0 end {direction}"
        ));
    }
    keys.push(format!(
        "case when {version_alias}.stage in ('mainline', 'reverted') then {change_set_alias}.applied_order else {change_set_alias}.created_order end {direction}"
    ));
    keys.push(format!("{version_alias}.id {direction}"));
    keys.join(",\n              ")
}

fn ensure_mainline_version_order_integrity(
    client: &mut impl GenericClient,
    physical_model: &PhysicalModel,
    app_id: &AppId,
    customer_id: &CustomerId,
) -> Result<(), DbError> {
    let drift = client.query_opt(
        &format!(
            r#"
            select v.id, v.change_set_id, cs.status, cs.applied_order
            from {} v
            left join change_set cs
              on cs.id = v.change_set_id
             and cs.app_id = v.app_id
             and cs.customer_id = v.customer_id
            where v.app_id = $1
              and v.customer_id = $2
              and v.stage in ('mainline', 'reverted')
              and (
                cs.id is null
                or cs.status <> 'mainline'
                or cs.applied_order is null
              )
            limit 1
            "#,
            quote_identifier(&physical_model.version_table)
        ),
        &[&app_id.as_str(), &customer_id.as_str()],
    )?;
    if let Some(row) = drift {
        let version_id: Uuid = row.get("id");
        let change_set_id: i64 = row.get("change_set_id");
        let status: Option<String> = row.get("status");
        let applied_order: Option<i64> = row.get("applied_order");
        return Err(DbError::SchemaDrift {
            object: physical_model.version_table.clone(),
            details: format!(
                "version `{version_id}` is mainline history but owning change_set `{change_set_id}` has status {status:?} and applied_order {applied_order:?}"
            ),
        });
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MaterializationMode {
    CreateMissing,
    ValidateExisting,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UnexpectedColumnMode {
    Repair,
    ValidateOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SchemaActivationHeadMode {
    Observe,
    Advance,
}

#[derive(Debug, Default)]
struct MaterializationCatalog {
    sibling_version_columns_by_table: BTreeMap<String, Vec<ColumnSpec>>,
    sibling_required_columns_by_table: BTreeMap<String, BTreeSet<String>>,
    sibling_unique_columns_by_table: BTreeMap<String, BTreeSet<String>>,
    sibling_contracts_by_table: BTreeMap<String, Vec<SiblingVersionTableContract>>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum CanonicalProbeRequest {
    Check {
        columns_sql: String,
        check_sql: String,
    },
    IndexPredicate {
        columns_sql: String,
        predicate_sql: String,
    },
    Policy {
        scope_sql: String,
    },
    Default {
        data_type: String,
        default_sql: String,
    },
}

#[derive(Debug, Deserialize)]
struct CanonicalProbeRow {
    id: usize,
    value: String,
}

#[derive(Debug, Default)]
struct CanonicalProbeResults {
    values: BTreeMap<CanonicalProbeRequest, String>,
}

impl CanonicalProbeResults {
    fn for_schema(
        client: &mut impl GenericClient,
        schema: &Schema,
        physical_models: &BTreeMap<ModelId, PhysicalModel>,
    ) -> Result<Self, DbError> {
        Self::load(client, canonical_probe_requests(schema, physical_models)?)
    }

    fn load(
        client: &mut impl GenericClient,
        requests: impl IntoIterator<Item = CanonicalProbeRequest>,
    ) -> Result<Self, DbError> {
        Self::load_with_round_trips(client, requests).map(|(results, _)| results)
    }

    fn load_with_round_trips(
        client: &mut impl GenericClient,
        requests: impl IntoIterator<Item = CanonicalProbeRequest>,
    ) -> Result<(Self, MaterializationRoundTrips), DbError> {
        let requests = requests.into_iter().collect::<BTreeSet<_>>();
        if requests.is_empty() {
            return Ok((Self::default(), MaterializationRoundTrips::default()));
        }
        let mut round_trips = MaterializationRoundTrips::default();
        let indexed = requests.iter().cloned().enumerate().collect::<Vec<_>>();
        let payload = indexed
            .iter()
            .map(|(id, request)| {
                let mut value = serde_json::to_value(request).expect("probe request serializes");
                value
                    .as_object_mut()
                    .expect("probe request is an object")
                    .insert("id".to_string(), Value::from(*id));
                value
            })
            .collect::<Vec<_>>();

        // Each probe runs inside a deliberately rolled-back PL/pgSQL
        // subtransaction. PostgreSQL keeps the canonical expression in the
        // scalar variable while releasing all locks and temporary objects
        // created by that probe. This bounds relation locks independently of
        // the number of models while retaining PostgreSQL's parser output.
        round_trips.record_canonical_probe_round_trip();
        client.batch_execute(
            r#"
            create or replace function pg_temp.platform_canonical_probes(requests jsonb)
            returns jsonb language plpgsql as $probe$
            declare
              request jsonb;
              canonical text;
              results jsonb := '[]'::jsonb;
            begin
              for request in select value from jsonb_array_elements(requests)
              loop
                canonical := null;
                begin
                  case request->>'kind'
                    when 'check' then
                      execute format(
                        'create temp table platform_expr_probe (%s, constraint probe_check check (%s)) on commit drop',
                        request->>'columns_sql', request->>'check_sql'
                      );
                      select pg_get_expr(c.conbin, c.conrelid) into strict canonical
                      from pg_constraint c
                      join pg_class r on r.oid = c.conrelid
                      join pg_namespace n on n.oid = r.relnamespace
                      where n.oid = pg_my_temp_schema()
                        and r.relname = 'platform_expr_probe'
                        and c.conname = 'probe_check';
                    when 'index_predicate' then
                      execute format(
                        'create temp table platform_expr_probe (%s) on commit drop',
                        request->>'columns_sql'
                      );
                      execute format(
                        'create index platform_expr_probe_index on platform_expr_probe (app_id) where %s',
                        request->>'predicate_sql'
                      );
                      select pg_get_expr(i.indpred, i.indrelid) into strict canonical
                      from pg_index i
                      join pg_class idx on idx.oid = i.indexrelid
                      join pg_namespace n on n.oid = idx.relnamespace
                      where n.oid = pg_my_temp_schema()
                        and idx.relname = 'platform_expr_probe_index';
                    when 'policy' then
                      create temp table platform_expr_probe (
                        app_id text, customer_id text
                      ) on commit drop;
                      execute format(
                        'create policy platform_expr_probe_policy on platform_expr_probe for all using (%s) with check (%s)',
                        request->>'scope_sql', request->>'scope_sql'
                      );
                      select pg_get_expr(p.polqual, p.polrelid) into strict canonical
                      from pg_policy p
                      join pg_class r on r.oid = p.polrelid
                      join pg_namespace n on n.oid = r.relnamespace
                      where n.oid = pg_my_temp_schema()
                        and r.relname = 'platform_expr_probe'
                        and p.polname = 'platform_expr_probe_policy';
                    when 'default' then
                      execute format(
                        'create temp table platform_expr_probe (value %s default %s) on commit drop',
                        request->>'data_type', request->>'default_sql'
                      );
                      select pg_get_expr(d.adbin, d.adrelid) into strict canonical
                      from pg_attrdef d
                      join pg_class r on r.oid = d.adrelid
                      join pg_namespace n on n.oid = r.relnamespace
                      join pg_attribute a
                        on a.attrelid = d.adrelid and a.attnum = d.adnum
                      where n.oid = pg_my_temp_schema()
                        and r.relname = 'platform_expr_probe'
                        and a.attname = 'value';
                    else
                      raise exception 'unknown canonical probe kind: %', request->>'kind';
                  end case;
                  raise sqlstate 'PZ001';
                exception when sqlstate 'PZ001' then
                  results := results || jsonb_build_array(jsonb_build_object(
                    'id', (request->>'id')::integer,
                    'value', canonical
                  ));
                end;
              end loop;
              return results;
            end
            $probe$;
            "#,
        )?;
        let payload = Value::Array(payload);
        round_trips.record_canonical_probe_round_trip();
        let raw: Value = client
            .query_one(
                "select pg_temp.platform_canonical_probes($1::jsonb)",
                &[&payload],
            )?
            .get(0);
        let rows: Vec<CanonicalProbeRow> = serde_json::from_value(raw)?;
        let by_id = rows
            .into_iter()
            .map(|row| (row.id, row.value))
            .collect::<BTreeMap<_, _>>();
        let values = indexed
            .into_iter()
            .map(|(id, request)| {
                by_id
                    .get(&id)
                    .cloned()
                    .map(|value| (request, value))
                    .ok_or_else(|| DbError::SchemaDrift {
                        object: "canonical_probe".to_string(),
                        details: format!("missing canonical probe result {id}"),
                    })
            })
            .collect::<Result<_, _>>()?;
        debug_assert_eq!(
            round_trips.canonical_probe_round_trips,
            CANONICAL_PROBE_ROUND_TRIPS
        );
        Ok((Self { values }, round_trips))
    }

    fn get(&self, request: CanonicalProbeRequest) -> &str {
        self.values
            .get(&request)
            .expect("all expected canonical probes are planned before materialization")
    }
}

#[derive(Debug, Default)]
struct PostgresCatalogSnapshot {
    canonical: Arc<CanonicalProbeResults>,
    schema_name: String,
    tables: BTreeSet<String>,
    sequences: BTreeSet<String>,
    columns_by_table: BTreeMap<String, Vec<ActualColumn>>,
    rls_by_table: BTreeMap<String, RlsTableContract>,
    constraints: BTreeMap<(String, String), SnapshotConstraint>,
    indexes: BTreeMap<String, IndexContract>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CatalogSnapshotQueryFamily {
    Tables,
    Sequences,
    ColumnsAndDefaults,
    RlsPolicies,
    Constraints,
    Indexes,
}

const CATALOG_SNAPSHOT_QUERY_FAMILIES: [CatalogSnapshotQueryFamily; 6] = [
    CatalogSnapshotQueryFamily::Tables,
    CatalogSnapshotQueryFamily::Sequences,
    CatalogSnapshotQueryFamily::ColumnsAndDefaults,
    CatalogSnapshotQueryFamily::RlsPolicies,
    CatalogSnapshotQueryFamily::Constraints,
    CatalogSnapshotQueryFamily::Indexes,
];

const CANONICAL_PROBE_ROUND_TRIPS: usize = 2;
const MATERIALIZATION_ADVISORY_LOCK_QUERY_COUNT: usize = 1;

#[derive(Debug, Default)]
struct MaterializationRoundTrips {
    catalog_queries: Vec<CatalogSnapshotQueryFamily>,
    canonical_probe_round_trips: usize,
    advisory_lock_round_trips: usize,
}

impl MaterializationRoundTrips {
    fn record_catalog_query(&mut self, family: CatalogSnapshotQueryFamily) {
        self.catalog_queries.push(family);
    }

    fn record_canonical_probe_round_trip(&mut self) {
        self.canonical_probe_round_trips += 1;
    }

    fn record_advisory_lock_round_trip(&mut self) {
        self.advisory_lock_round_trips += 1;
    }
}

impl PostgresCatalogSnapshot {
    fn load(
        client: &mut impl GenericClient,
        canonical: Arc<CanonicalProbeResults>,
    ) -> Result<Self, DbError> {
        Self::load_with_round_trips(client, canonical).map(|(snapshot, _)| snapshot)
    }

    fn load_with_round_trips(
        client: &mut impl GenericClient,
        canonical: Arc<CanonicalProbeResults>,
    ) -> Result<(Self, MaterializationRoundTrips), DbError> {
        let mut round_trips = MaterializationRoundTrips::default();
        round_trips.record_catalog_query(CatalogSnapshotQueryFamily::Tables);
        let table_rows = client.query(
            r#"
                select schema_name, tables.table_name
                from (select current_schema() as schema_name) current
                left join information_schema.tables tables
                  on tables.table_schema = current.schema_name
                "#,
            &[],
        )?;
        let schema_name = table_rows
            .first()
            .map(|row| row.get("schema_name"))
            .expect("current_schema query returns one row");
        let tables = table_rows
            .into_iter()
            .filter_map(|row| row.get("table_name"))
            .collect();
        round_trips.record_catalog_query(CatalogSnapshotQueryFamily::Sequences);
        let sequences = client
            .query(
                r#"
                select sequence_name
                from information_schema.sequences
                where sequence_schema = current_schema()
                "#,
                &[],
            )?
            .into_iter()
            .map(|row| row.get("sequence_name"))
            .collect();
        round_trips.record_catalog_query(CatalogSnapshotQueryFamily::ColumnsAndDefaults);
        let mut columns_by_table = BTreeMap::<String, Vec<ActualColumn>>::new();
        for row in client.query(
            r#"
            select
              r.relname as table_name,
              a.attname,
              format_type(a.atttypid, a.atttypmod) as data_type,
              a.attnotnull,
              pg_get_expr(d.adbin, d.adrelid) as column_default,
              seq.relname as owned_sequence
            from pg_attribute a
            join pg_class r on r.oid = a.attrelid
            join pg_namespace n on n.oid = r.relnamespace
            left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
            left join pg_class seq
              on seq.oid = pg_get_serial_sequence(
                format('%I.%I', n.nspname, r.relname), a.attname
              )::regclass
            where n.nspname = current_schema()
              and r.relkind in ('r', 'p')
              and a.attnum > 0
              and not a.attisdropped
            order by r.relname, a.attnum
            "#,
            &[],
        )? {
            columns_by_table
                .entry(row.get("table_name"))
                .or_default()
                .push(ActualColumn {
                    name: row.get("attname"),
                    data_type: row.get("data_type"),
                    not_null: row.get("attnotnull"),
                    default: row.get("column_default"),
                    owned_sequence: row.get("owned_sequence"),
                });
        }
        round_trips.record_catalog_query(CatalogSnapshotQueryFamily::RlsPolicies);
        let mut rls_by_table = BTreeMap::<String, RlsTableContract>::new();
        for row in client.query(
            r#"
            select
              r.relname as table_name,
              r.relrowsecurity,
              r.relforcerowsecurity,
              p.policyname,
              p.cmd,
              p.permissive,
              p.roles,
              p.qual,
              p.with_check
            from pg_class r
            join pg_namespace n on n.oid = r.relnamespace
            left join pg_policies p
              on p.schemaname = n.nspname and p.tablename = r.relname
            where n.nspname = current_schema()
              and r.relkind in ('r', 'p')
            order by r.relname, p.policyname
            "#,
            &[],
        )? {
            let contract = rls_by_table
                .entry(row.get("table_name"))
                .or_insert_with(|| RlsTableContract {
                    row_security: row.get("relrowsecurity"),
                    force_row_security: row.get("relforcerowsecurity"),
                    policies: Vec::new(),
                });
            if let Some(name) = row.get::<_, Option<String>>("policyname") {
                contract.policies.push(RlsPolicyContract {
                    name,
                    command: row.get("cmd"),
                    roles: row.get("roles"),
                    permissive: row.get("permissive"),
                    // Both expressions are nullable in pg_policies. Preserve a
                    // malformed policy in the snapshot so contract validation
                    // reports targeted SchemaDrift instead of a decode error.
                    qual: row.get::<_, Option<String>>("qual").unwrap_or_default(),
                    with_check: row
                        .get::<_, Option<String>>("with_check")
                        .unwrap_or_default(),
                });
            }
        }
        round_trips.record_catalog_query(CatalogSnapshotQueryFamily::Constraints);
        let mut constraints = BTreeMap::<(String, String), SnapshotConstraint>::new();
        for row in client.query(
            r#"
            select
              r.relname as table_name,
              c.conname as constraint_name,
              c.contype::text as constraint_type,
              c.condeferrable,
              c.condeferred,
              c.convalidated,
              c.confupdtype::text as update_action,
              c.confdeltype::text as delete_action,
              c.confmatchtype::text as match_type,
              rrn.nspname as referenced_schema,
              rr.relname as referenced_table,
              pg_get_expr(c.conbin, c.conrelid) as check_expr,
              a.attname as column_name,
              ra.attname as referenced_column,
              key_column.ordinality
            from pg_constraint c
            join pg_class r on r.oid = c.conrelid
            join pg_namespace n on n.oid = r.relnamespace
            left join pg_class rr on rr.oid = c.confrelid
            left join pg_namespace rrn on rrn.oid = rr.relnamespace
            left join lateral unnest(c.conkey) with ordinality
              as key_column(attnum, ordinality) on true
            left join pg_attribute a
              on a.attrelid = c.conrelid and a.attnum = key_column.attnum
            left join pg_attribute ra
              on ra.attrelid = c.confrelid
             and ra.attnum = c.confkey[key_column.ordinality::int]
            where n.nspname = current_schema()
            order by r.relname, c.conname, key_column.ordinality
            "#,
            &[],
        )? {
            let contract = constraints
                .entry((row.get("table_name"), row.get("constraint_name")))
                .or_insert_with(|| SnapshotConstraint {
                    constraint_type: row.get("constraint_type"),
                    deferrable: row.get("condeferrable"),
                    initially_deferred: row.get("condeferred"),
                    validated: row.get("convalidated"),
                    update_action: row.get("update_action"),
                    delete_action: row.get("delete_action"),
                    match_type: row.get("match_type"),
                    referenced_schema: row.get("referenced_schema"),
                    referenced_table: row.get("referenced_table"),
                    check_expr: row.get("check_expr"),
                    columns: Vec::new(),
                    referenced_columns: Vec::new(),
                });
            if let Some(column) = row.get::<_, Option<String>>("column_name") {
                contract.columns.push(column);
            }
            if let Some(column) = row.get::<_, Option<String>>("referenced_column") {
                contract.referenced_columns.push(column);
            }
        }
        round_trips.record_catalog_query(CatalogSnapshotQueryFamily::Indexes);
        let mut indexes = BTreeMap::<String, IndexContract>::new();
        for row in client.query(
            r#"
            select
              idx.relname as index_name,
              tbl.relname as table_name,
              a.attname,
              ((i.indoption[(k.ordinality - 1)::int]::int & 1) <> 0) as is_desc,
              i.indisunique,
              pg_get_expr(i.indpred, i.indrelid) as predicate
            from pg_index i
            join pg_class idx on idx.oid = i.indexrelid
            join pg_namespace n on n.oid = idx.relnamespace
            join pg_class tbl on tbl.oid = i.indrelid
            join pg_namespace tn on tn.oid = tbl.relnamespace
            join unnest(i.indkey) with ordinality as k(attnum, ordinality) on true
            join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
            where n.nspname = current_schema()
              and tn.nspname = current_schema()
            order by idx.relname, k.ordinality
            "#,
            &[],
        )? {
            let contract = indexes
                .entry(row.get("index_name"))
                .or_insert_with(|| IndexContract {
                    table_name: row.get("table_name"),
                    unique: row.get("indisunique"),
                    predicate: row.get("predicate"),
                    columns: Vec::new(),
                });
            contract
                .columns
                .push((row.get("attname"), row.get("is_desc")));
        }
        debug_assert_eq!(round_trips.catalog_queries, CATALOG_SNAPSHOT_QUERY_FAMILIES);
        Ok((
            Self {
                canonical,
                schema_name,
                tables,
                sequences,
                columns_by_table,
                rls_by_table,
                constraints,
                indexes,
            },
            round_trips,
        ))
    }

    fn validate_table_exists(&self, table_name: &str) -> Result<(), DbError> {
        if self.tables.contains(table_name) {
            return Ok(());
        }
        Err(DbError::SchemaDrift {
            object: table_name.to_string(),
            details: "missing table".to_string(),
        })
    }

    fn validate_sequence_exists(&self, sequence_name: &str) -> Result<(), DbError> {
        if self.sequences.contains(sequence_name) {
            return Ok(());
        }
        Err(DbError::SchemaDrift {
            object: sequence_name.to_string(),
            details: "missing sequence".to_string(),
        })
    }

    fn columns(&self, table_name: &str) -> &[ActualColumn] {
        self.columns_by_table
            .get(table_name)
            .map(Vec::as_slice)
            .unwrap_or_default()
    }

    fn rls(&self, table_name: &str) -> Option<&RlsTableContract> {
        self.rls_by_table.get(table_name)
    }

    fn constraint(&self, table_name: &str, constraint_name: &str) -> Option<&SnapshotConstraint> {
        self.constraints
            .get(&(table_name.to_string(), constraint_name.to_string()))
    }

    fn index(&self, index_name: &str) -> Option<&IndexContract> {
        self.indexes.get(index_name)
    }
}

#[derive(Debug)]
struct SnapshotConstraint {
    constraint_type: String,
    columns: Vec<String>,
    referenced_schema: Option<String>,
    referenced_table: Option<String>,
    referenced_columns: Vec<String>,
    update_action: String,
    delete_action: String,
    match_type: String,
    deferrable: bool,
    initially_deferred: bool,
    validated: bool,
    check_expr: Option<String>,
}

#[derive(Debug)]
struct SiblingVersionTableContract {
    app_id: AppId,
    customer_id: CustomerId,
    columns: Vec<ColumnSpec>,
    required_columns: BTreeSet<String>,
    unique_columns: BTreeSet<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SchemaRevisionOverlay {
    #[serde(default)]
    declared_enum_option_additions: Vec<EnumOptionSetOverlay>,
    #[serde(default)]
    custom_enum_option_sets: Vec<EnumOptionSetOverlay>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EnumOptionSetOverlay {
    model_id: ModelId,
    field_id: FieldId,
    option_set: Vec<EnumOption>,
}

#[derive(Debug, Error)]
pub enum DbError {
    #[error(transparent)]
    Validation(#[from] ValidationError),
    #[error(transparent)]
    Postgres(#[from] postgres::Error),
    #[error(transparent)]
    Serde(#[from] serde_json::Error),
    #[error(
        "schema revision already exists with different schema JSON (existing_hash={existing_hash}, current_hash={current_hash})"
    )]
    SchemaRevisionConflict {
        existing_hash: String,
        current_hash: String,
    },
    #[error("schema drift on {object}: {details}")]
    SchemaDrift { object: String, details: String },
    #[error("no active schema revision for app_id `{app_id}` and customer_id `{customer_id}`")]
    ActiveSchemaMissing { app_id: String, customer_id: String },
    #[error(
        "apply schema_revision_id `{supplied}` does not match active schema_revision_id `{active}`"
    )]
    StaleSchemaRevision { supplied: i64, active: i64 },
    #[error("draft status conflict: {details}")]
    DraftStatusConflict { details: String },
    #[error("stale draft: {details}")]
    StaleDraft { details: String },
    #[error("revert conflict: {details}")]
    RevertConflict { details: String },
    #[error("change_set is already reverted: {details}")]
    AlreadyReverted { details: String },
    #[error("source_kind `{source_kind}` is reserved for kernel APIs")]
    ReservedSourceKind { source_kind: String },
    #[error("agent run conflict: {details}")]
    AgentRunConflict { details: String },
    #[error("agent run is missing: {details}")]
    AgentRunMissing { details: String },
    #[error("agent run schema mismatch: {details}")]
    AgentRunSchemaMismatch { details: String },
    #[error("query rejected: {details}")]
    QueryRejected { details: String },
    #[error("query timed out: {details}")]
    QueryTimeout { details: String },
    #[error("idempotency key `{key}` was reused for a different request")]
    IdempotencyConflict { key: String },
    #[error("record key conflict: {details}")]
    RecordKeyConflict { details: String },
    #[error("record version conflict")]
    VersionConflict,
    #[error("policy-enabled records require generated PostgreSQL operations")]
    AuthorizationPolicyUnsupported,
    #[error("record target is missing: {details}")]
    RecordTargetMissing { details: String },
    #[error("record is tombstoned: {details}")]
    TombstonedRecord { details: String },
    #[error("timeline conflict: {details}")]
    TimelineConflict { details: String },
    #[error("unique field conflict on {model}.{field}: {value}")]
    UniqueFieldConflict {
        model: String,
        field: String,
        value: String,
    },
    #[error("atomic dry-run changeset {index} failed: {source}")]
    AtomicDryRunChangeSetFailed {
        index: usize,
        #[source]
        source: Box<DbError>,
    },
}

impl From<DbError> for KernelError {
    fn from(error: DbError) -> Self {
        match error {
            DbError::Validation(error) => KernelError::Validation(error),
            DbError::Serde(error) => KernelError::from_dto_with_source(
                KernelErrorDto::new("serialization_error", "Kernel serialization failed"),
                error,
            ),
            DbError::Postgres(error) => KernelError::from_dto_with_source(
                KernelErrorDto::new("database_error", "Database operation failed"),
                error,
            ),
            DbError::SchemaRevisionConflict {
                existing_hash,
                current_hash,
            } => KernelError::from_dto(KernelErrorDto {
                code: "schema_revision_conflict".to_string(),
                message: "Schema revision already exists with different schema JSON".to_string(),
                details: vec![
                    ErrorDetail {
                        path: "schema_revision.existing_schema_hash".to_string(),
                        code: "schema_hash".to_string(),
                        message: existing_hash,
                    },
                    ErrorDetail {
                        path: "schema_revision.current_schema_hash".to_string(),
                        code: "schema_hash".to_string(),
                        message: current_hash,
                    },
                ],
            }),
            DbError::SchemaDrift { object, details } => KernelError::from_dto(
                KernelErrorDto::with_detail(
                    "schema_drift",
                    "Schema drift detected",
                    "object",
                    "schema_drift",
                    format!("{object}: {details}"),
                ),
            ),
            DbError::ActiveSchemaMissing {
                app_id,
                customer_id,
            } => KernelError::from_dto(KernelErrorDto::with_detail(
                "active_schema_missing",
                "No active schema revision exists for this scope",
                "scope",
                "active_schema_missing",
                format!(
                    "{app_id}/{customer_id}: materialize a schema before applying or reading records"
                ),
            )),
            DbError::StaleSchemaRevision { supplied, active } => KernelError::from_dto(
                KernelErrorDto::with_detail(
                    "stale_schema_revision",
                    "The supplied schema revision is not active",
                    "schema_revision_id",
                    "stale_schema_revision",
                    format!(
                        "Supplied schema_revision_id is {supplied}; active schema_revision_id is {active}"
                    ),
                ),
            ),
            DbError::DraftStatusConflict { details } => KernelError::from_dto(KernelErrorDto::new(
                "draft_status_conflict",
                details,
            )),
            DbError::StaleDraft { details } => {
                KernelError::from_dto(KernelErrorDto::new("stale_draft", details))
            }
            DbError::RevertConflict { details } => {
                KernelError::from_dto(KernelErrorDto::new("revert_conflict", details))
            }
            DbError::AlreadyReverted { details } => {
                KernelError::from_dto(KernelErrorDto::new("already_reverted", details))
            }
            DbError::ReservedSourceKind { source_kind } => KernelError::from_dto(
                KernelErrorDto::with_detail(
                    "reserved_source_kind",
                    "Source kind is reserved for a kernel API",
                    "source_kind",
                    "reserved_source_kind",
                    source_kind,
                ),
            ),
            DbError::AgentRunConflict { details } => {
                KernelError::from_dto(KernelErrorDto::new("agent_run_conflict", details))
            }
            DbError::AgentRunMissing { details } => {
                KernelError::from_dto(KernelErrorDto::new("agent_run_missing", details))
            }
            DbError::AgentRunSchemaMismatch { details } => {
                KernelError::from_dto(KernelErrorDto::new("agent_run_schema_mismatch", details))
            }
            DbError::QueryRejected { details } => {
                KernelError::from_dto(KernelErrorDto::new("query_rejected", details))
            }
            DbError::QueryTimeout { details } => {
                KernelError::from_dto(KernelErrorDto::new("query_timeout", details))
            }
            DbError::IdempotencyConflict { key } => KernelError::from_dto(
                KernelErrorDto::with_detail(
                    "idempotency_conflict",
                    "Idempotency key was reused for a different request",
                    "idempotency_key",
                    "idempotency_conflict",
                    format!(
                        "Key `{key}` was reused; use a new idempotency key or replay the exact equivalent request"
                    ),
                ),
            ),
            DbError::RecordTargetMissing { details } => {
                KernelError::from_dto(KernelErrorDto::new("record_target_missing", details))
            }
            DbError::RecordKeyConflict { details } => {
                KernelError::from_dto(KernelErrorDto::new("record_key_conflict", details))
            }
            DbError::AuthorizationPolicyUnsupported => KernelError::from_dto(KernelErrorDto::new(
                "unsupported_capability",
                "Policy-enabled records require generated PostgreSQL operations",
            )),
            DbError::VersionConflict => KernelError::from_dto(KernelErrorDto::new(
                "version_conflict",
                "This record has changed. Reload and try again.",
            )),
            DbError::TombstonedRecord { details } => {
                KernelError::from_dto(KernelErrorDto::new("tombstoned_record", details))
            }
            DbError::TimelineConflict { details } => {
                KernelError::from_dto(KernelErrorDto::new("timeline_conflict", details))
            }
            DbError::UniqueFieldConflict {
                model,
                field,
                value,
            } => KernelError::from_dto(KernelErrorDto {
                code: "unique_field_conflict".to_string(),
                message: "Unique field value already exists".to_string(),
                details: vec![
                    ErrorDetail {
                        path: "model".to_string(),
                        code: "unique_field_conflict".to_string(),
                        message: model,
                    },
                    ErrorDetail {
                        path: "field".to_string(),
                        code: "unique_field_conflict".to_string(),
                        message: field,
                    },
                    ErrorDetail {
                        path: "value".to_string(),
                        code: "unique_field_conflict".to_string(),
                        message: value,
                    },
                ],
            }),
            DbError::AtomicDryRunChangeSetFailed { index, source } => {
                let envelope = KernelError::from(*source).into_envelope();
                let details = if envelope.details.is_empty() {
                    vec![ErrorDetail {
                        path: format!("changesets[{index}]"),
                        code: envelope.code.clone(),
                        message: envelope.message.clone(),
                    }]
                } else {
                    envelope
                        .details
                        .into_iter()
                        .map(|mut detail| {
                            detail.path = format!("changesets[{index}].{}", detail.path);
                            detail
                        })
                        .collect()
                };
                KernelError::from_dto(KernelErrorDto {
                    code: envelope.code,
                    message: envelope.message,
                    details,
                })
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppliedChangeSet {
    pub id: i64,
    pub schema_revision_id: SchemaRevisionId,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoredAgentRun {
    pub id: i64,
    pub run_id: String,
    pub schema_revision_id: SchemaRevisionId,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActiveSchemaRevision {
    pub schema_revision_id: SchemaRevisionId,
    pub schema: Schema,
    /// The effective hash a tenant schema revision commit compares
    /// `expected_effective_hash` against.
    pub effective_hash: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VisibleRecord {
    pub record_id: RecordId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version_id: Option<RecordId>,
    pub external_key: Option<String>,
    pub effective_start: NaiveDate,
    pub effective_end: Option<NaiveDate>,
    pub values: BTreeMap<FieldId, FieldValue>,
    pub custom_fields: Vec<CustomFieldEntry>,
    #[serde(default)]
    pub metadata: Map<String, Value>,
    #[serde(default)]
    pub many_relations: BTreeMap<FieldId, Vec<RecordId>>,
    #[serde(default)]
    pub availability: Option<SchemaElementLifecycle>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DraftSummary {
    pub id: i64,
    pub schema_revision_id: SchemaRevisionId,
    pub actor_id: Option<String>,
    pub source_kind: String,
    pub source_ref: Option<String>,
    pub change_type_id: Option<ChangeTypeId>,
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DraftRecord {
    pub change_set_id: i64,
    pub model_id: ModelId,
    pub record_id: RecordId,
    pub external_key: Option<String>,
    pub effective_start: NaiveDate,
    pub effective_end: Option<NaiveDate>,
    pub tombstones_record: bool,
    pub untombstones_record: bool,
    pub values: BTreeMap<FieldId, FieldValue>,
    pub custom_fields: Vec<CustomFieldEntry>,
    #[serde(default)]
    pub metadata: Map<String, Value>,
    #[serde(default)]
    pub many_relations: BTreeMap<FieldId, Vec<RecordId>>,
    #[serde(default)]
    pub availability: Option<SchemaElementLifecycle>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SchemaRevisionProvenance {
    pub materialization_source: Option<String>,
    pub git_sha: Option<String>,
    pub vercel_deployment_id: Option<String>,
    pub vercel_environment: Option<String>,
    pub vercel_git_ref: Option<String>,
}

pub fn materialize_schema(
    client: &mut Client,
    schema: &Schema,
) -> Result<SchemaRevisionId, DbError> {
    materialize_schema_with_provenance(client, schema, None)
}

pub fn preflight_schema_materialization(
    client: &mut Client,
    schema: &Schema,
) -> Result<(), DbError> {
    validate_schema(schema)?;

    let mut tx = kernel_transaction(client)?;
    lock_schema_materialization(&mut tx)?;
    lock_schema_activation_reader(&mut tx, &schema.app_id, &schema.customer_id)?;
    set_tenant_scope(&mut tx, &schema.app_id, &schema.customer_id)?;
    observe_schema_activation_head(&mut tx, schema)?;
    let catalog = materialization_catalog(&mut tx, schema)?;
    for contract in active_schema_version_table_contracts(schema)? {
        preflight_version_table_contract(&contract, &catalog)?;
    }
    Ok(())
}

/// Reconcile only the kernel-owned RLS policies before a strict preflight.
///
/// Existing provider Preview databases can predate `platform_tenant_scope`.
/// Keep this repair separate from preflight so preflight remains read-only and
/// continues to reject every non-policy schema mismatch.
pub fn reconcile_schema_materialization_policies(
    client: &mut Client,
    schema: &Schema,
) -> Result<(), DbError> {
    validate_schema(schema)?;

    let mut tx = kernel_transaction(client)?;
    lock_schema_materialization(&mut tx)?;
    lock_schema_activation_writer(&mut tx, &schema.app_id, &schema.customer_id)?;
    set_tenant_scope(&mut tx, &schema.app_id, &schema.customer_id)?;
    reconcile_schema_materialization_policies_in_transaction(&mut tx, schema)?;

    tx.commit()?;
    Ok(())
}

/// Restore the kernel-owned activation-head tenant policy without reading
/// stored schema JSON or reconciling unrelated materialized tables.
pub fn ensure_schema_activation_head_policy(
    client: &mut Client,
    schema: &Schema,
) -> Result<(), DbError> {
    validate_schema(schema)?;

    let mut tx = kernel_transaction(client)?;
    lock_schema_materialization(&mut tx)?;
    lock_schema_activation_writer(&mut tx, &schema.app_id, &schema.customer_id)?;
    set_tenant_scope(&mut tx, &schema.app_id, &schema.customer_id)?;
    if table_exists(&mut tx, SCHEMA_ACTIVATION_HEAD_TABLE)? {
        let scope = tenant_policy_scope(SCHEMA_ACTIVATION_HEAD_TABLE);
        let canonical = Arc::new(CanonicalProbeResults::load(
            &mut tx,
            [CanonicalProbeRequest::Policy { scope_sql: scope }],
        )?);
        let postgres_catalog = PostgresCatalogSnapshot::load(&mut tx, canonical)?;
        ensure_rls_against(&mut tx, SCHEMA_ACTIVATION_HEAD_TABLE, &postgres_catalog)?;
    }
    tx.commit()?;
    Ok(())
}

fn reconcile_schema_materialization_policies_in_transaction(
    tx: &mut Transaction<'_>,
    schema: &Schema,
) -> Result<(), DbError> {
    if !table_exists(tx, "schema_revision")? {
        return Ok(());
    }

    let physical_models = physical_models(schema)?;
    let canonical = Arc::new(CanonicalProbeResults::for_schema(
        tx,
        schema,
        &physical_models,
    )?);
    let postgres_catalog = PostgresCatalogSnapshot::load(tx, canonical)?;

    for table_name in ["schema_revision", "change_set", "agent_run"] {
        if !postgres_catalog.tables.contains(table_name) {
            return Err(DbError::SchemaDrift {
                object: table_name.to_string(),
                details: "missing table".to_string(),
            });
        }
        ensure_rls_against(tx, table_name, &postgres_catalog)?;
    }
    if postgres_catalog
        .tables
        .contains(SCHEMA_ACTIVATION_HEAD_TABLE)
    {
        ensure_rls_against(tx, SCHEMA_ACTIVATION_HEAD_TABLE, &postgres_catalog)?;
    }
    for physical_model in physical_models.values() {
        for table_name in [&physical_model.record_table, &physical_model.version_table] {
            if postgres_catalog.tables.contains(table_name) {
                ensure_rls_against(tx, table_name, &postgres_catalog)?;
            }
        }
    }
    Ok(())
}

pub(crate) fn preflight_schema_materialization_guarded<F>(
    client: &mut Client,
    schema: &Schema,
    guard: F,
) -> Result<(), KernelError>
where
    F: FnOnce(&mut Transaction<'_>) -> Result<(), KernelError>,
{
    validate_schema(schema)
        .map_err(DbError::from)
        .map_err(KernelError::from)?;

    let mut tx = kernel_transaction(client).map_err(KernelError::from)?;
    lock_schema_materialization(&mut tx).map_err(KernelError::from)?;
    lock_schema_activation_writer(&mut tx, &schema.app_id, &schema.customer_id)
        .map_err(KernelError::from)?;
    set_tenant_scope(&mut tx, &schema.app_id, &schema.customer_id).map_err(KernelError::from)?;
    reconcile_schema_materialization_policies_in_transaction(&mut tx, schema)
        .map_err(KernelError::from)?;
    guard(&mut tx)?;
    observe_schema_activation_head_for_guarded_transition(&mut tx, schema)
        .map_err(KernelError::from)?;
    let catalog = materialization_catalog(&mut tx, schema).map_err(KernelError::from)?;
    for contract in active_schema_version_table_contracts(schema).map_err(KernelError::from)? {
        preflight_version_table_contract(&contract, &catalog).map_err(KernelError::from)?;
    }
    tx.rollback()
        .map_err(DbError::from)
        .map_err(KernelError::from)
}

pub fn materialize_schema_with_provenance(
    client: &mut Client,
    schema: &Schema,
    provenance: Option<&SchemaRevisionProvenance>,
) -> Result<SchemaRevisionId, DbError> {
    validate_schema(schema)?;
    ensure_query_role_exists(client)?;

    let mut tx = kernel_transaction(client)?;
    lock_schema_materialization(&mut tx)?;
    lock_schema_activation_writer(&mut tx, &schema.app_id, &schema.customer_id)?;
    let revision_id = materialize_schema_with_provenance_in_transaction(
        &mut tx,
        schema,
        provenance,
        SchemaActivationHeadMode::Observe,
    )?;
    tx.commit()?;
    Ok(revision_id)
}

pub(crate) fn materialize_schema_with_provenance_guarded<F>(
    client: &mut Client,
    schema: &Schema,
    provenance: Option<&SchemaRevisionProvenance>,
    guard: F,
) -> Result<SchemaRevisionId, KernelError>
where
    F: FnOnce(&mut Transaction<'_>) -> Result<(), KernelError>,
{
    validate_schema(schema)
        .map_err(DbError::from)
        .map_err(KernelError::from)?;
    ensure_query_role_exists(client).map_err(KernelError::from)?;
    let mut tx = kernel_transaction(client).map_err(KernelError::from)?;
    lock_schema_materialization(&mut tx).map_err(KernelError::from)?;
    lock_schema_activation_writer(&mut tx, &schema.app_id, &schema.customer_id)
        .map_err(KernelError::from)?;
    set_tenant_scope(&mut tx, &schema.app_id, &schema.customer_id).map_err(KernelError::from)?;
    reconcile_schema_materialization_policies_in_transaction(&mut tx, schema)
        .map_err(KernelError::from)?;
    guard(&mut tx)?;
    let revision_id = materialize_schema_with_provenance_in_transaction(
        &mut tx,
        schema,
        provenance,
        SchemaActivationHeadMode::Advance,
    )
    .map_err(KernelError::from)?;
    tx.commit()
        .map_err(DbError::from)
        .map_err(KernelError::from)?;
    Ok(revision_id)
}

fn materialize_schema_with_provenance_in_transaction(
    tx: &mut Transaction<'_>,
    schema: &Schema,
    provenance: Option<&SchemaRevisionProvenance>,
    activation_head_mode: SchemaActivationHeadMode,
) -> Result<SchemaRevisionId, DbError> {
    ensure_schema_revision_catalog_policy(tx)?;
    let catalog = materialization_catalog(tx, schema)?;
    set_tenant_scope(tx, &schema.app_id, &schema.customer_id)?;
    prepare_schema_activation_head(tx, schema, activation_head_mode)?;

    let active_state =
        active_schema_revision_materialization_state(tx, &schema.app_id, &schema.customer_id)
            .map(Some)
            .or_else(|error| match error {
                DbError::ActiveSchemaMissing { .. } => Ok(None),
                error => Err(error),
            })?;
    if let Some(active_state) = active_state.as_ref() {
        if active_state.base_schema_version == schema.version {
            let mut active_base_schema_json = active_state.base_schema_json.clone();
            let mut repaired_active_schema_json =
                fill_missing_model_kinds_from_schema(&mut active_base_schema_json, schema);
            let active_base_schema: Schema =
                serde_json::from_value(active_base_schema_json.clone())?;
            if active_base_schema != *schema {
                let existing_schema =
                    serde_json::to_value(&active_base_schema).expect("schema serializes");
                let current_schema = serde_json::to_value(schema).expect("schema serializes");
                return Err(schema_revision_conflict(&existing_schema, &current_schema));
            }
            let mut effective_schema =
                recompose_active_schema_revision(schema, &active_state.overlay)?;
            let mut active_schema_json = active_state.schema_json.clone();
            repaired_active_schema_json |=
                fill_missing_model_kinds_from_schema(&mut active_schema_json, &effective_schema);
            let active_schema: Schema = serde_json::from_value(active_schema_json.clone())?;
            effective_schema.version = active_schema.version.clone();
            if effective_schema != active_schema {
                let existing_schema =
                    serde_json::to_value(&active_schema).expect("schema serializes");
                let current_schema =
                    serde_json::to_value(&effective_schema).expect("schema serializes");
                return Err(schema_revision_conflict(&existing_schema, &current_schema));
            }
            if repaired_active_schema_json {
                update_schema_revision_contract_json(
                    tx,
                    active_state.id.get(),
                    &active_base_schema_json,
                    &active_schema_json,
                )?;
            }
            ensure_materialized_schema(
                tx,
                &effective_schema,
                MaterializationMode::ValidateExisting,
                UnexpectedColumnMode::Repair,
                &catalog,
            )?;
            prepare_schema_activation_head(tx, schema, activation_head_mode)?;
            update_schema_revision_provenance(
                tx,
                active_state.id.get(),
                &effective_schema,
                provenance,
            )?;
            return Ok(active_state.id);
        }
    }

    // A new base may not add a custom/declared field-id collision the active
    // revision lacks. An active row that no longer parses gets no tolerance.
    let prior: Option<Schema> = active_state
        .as_ref()
        .and_then(|state| serde_json::from_value(state.schema_json.clone()).ok());
    let overlay = active_state.map(|state| state.overlay).unwrap_or_default();
    let effective_schema = compose_schema_revision(schema, &overlay, prior.as_ref())?;
    let existing_revision_id = schema_revision_for_version(tx, &effective_schema)?;
    let materialization_mode = if existing_revision_id.is_some() {
        MaterializationMode::ValidateExisting
    } else {
        MaterializationMode::CreateMissing
    };

    ensure_materialized_schema(
        tx,
        &effective_schema,
        materialization_mode,
        UnexpectedColumnMode::Repair,
        &catalog,
    )?;
    prepare_schema_activation_head(tx, schema, activation_head_mode)?;
    let revision_id = if let Some(revision_id) = existing_revision_id {
        update_schema_revision_provenance(tx, revision_id.get(), &effective_schema, provenance)?;
        activate_revision(tx, &effective_schema, revision_id.get())?;
        revision_id
    } else {
        store_schema_revision(tx, schema, &overlay, &effective_schema, provenance)?
    };
    Ok(revision_id)
}

fn ensure_materialized_schema(
    client: &mut impl GenericClient,
    schema: &Schema,
    materialization_mode: MaterializationMode,
    unexpected_column_mode: UnexpectedColumnMode,
    catalog: &MaterializationCatalog,
) -> Result<(), DbError> {
    let physical_models = schema
        .models
        .iter()
        .map(|model| Ok((model.id.clone(), physical_model(model)?)))
        .collect::<Result<BTreeMap<_, _>, DbError>>()?;

    let canonical = Arc::new(CanonicalProbeResults::for_schema(
        client,
        schema,
        &physical_models,
    )?);
    let mutation_catalog = PostgresCatalogSnapshot::load(client, Arc::clone(&canonical))?;
    ensure_substrate_tables(client, materialization_mode, &mutation_catalog)?;
    lock_materialization(client, schema, &physical_models)?;

    for physical_model in physical_models.values() {
        ensure_record_table(
            client,
            physical_model,
            materialization_mode,
            &mutation_catalog,
        )?;
    }

    for model in &schema.models {
        let physical_model = physical_models.get(&model.id).expect("model was collected");
        ensure_version_table(
            client,
            model,
            physical_model,
            VersionMaterializationContext {
                physical_models: &physical_models,
                mode: materialization_mode,
                unexpected_column_mode,
                catalog,
                postgres_catalog: &mutation_catalog,
            },
        )?;
    }

    ensure_query_role_grants(client, &physical_models)?;
    let validation_catalog = PostgresCatalogSnapshot::load(client, canonical)?;
    validate_materialized_schema_contracts_against(
        client,
        schema,
        catalog,
        &physical_models,
        &validation_catalog,
    )?;
    Ok(())
}

pub fn commit_enum_option_set_revision(
    client: &mut Client,
    request: &CommitEnumOptionSetRevision,
) -> Result<Vec<EnumOption>, DbError> {
    validate_commit_enum_option_set_revision(request)?;
    ensure_query_role_exists(client)?;

    let mut tx = kernel_transaction(client)?;
    lock_schema_materialization(&mut tx)?;
    lock_schema_activation_writer(&mut tx, &request.app_id, &request.customer_id)?;
    ensure_schema_revision_catalog_policy(&mut tx)?;
    let catalog =
        materialization_catalog_for_scope(&mut tx, &request.app_id, &request.customer_id)?;
    set_tenant_scope(&mut tx, &request.app_id, &request.customer_id)?;

    let active = active_schema_revision_state(&mut tx, &request.app_id, &request.customer_id)?;
    if active.id != request.baseline_revision_id {
        return Err(DbError::StaleSchemaRevision {
            supplied: request.baseline_revision_id.get(),
            active: active.id.get(),
        });
    }
    // Native enum lifecycle writes cannot evaluate generated authorization
    // policy, so reject a policy-enabled active revision before creating a new
    // revision or activating it without a policy snapshot.
    assert_native_policy_supported(&mut tx, &request.app_id, &request.customer_id)?;

    let mut overlay = active.overlay;
    apply_option_set_overlay_update(
        &active.base_schema,
        &mut overlay,
        &request.target,
        normalize_enum_options_for_write(&request.options)?,
    )?;
    let mut schema = compose_schema_revision(&active.base_schema, &overlay, Some(&active.schema))?;
    schema.version = next_runtime_schema_version(&mut tx, &active.base_schema)?;

    ensure_materialized_schema(
        &mut tx,
        &schema,
        MaterializationMode::ValidateExisting,
        UnexpectedColumnMode::ValidateOnly,
        &catalog,
    )?;
    let overlay_json = serde_json::to_value(&overlay).expect("schema overlay serializes");
    let base_schema_json =
        serde_json::to_value(&active.base_schema).expect("base schema serializes");
    let schema_json = serde_json::to_value(&schema).expect("schema contract serializes");
    let schema_hash = schema_json_hash(&schema_json);
    let row = tx.query_one(
        r#"
        insert into schema_revision (
          app_id,
          customer_id,
          version,
          base_schema,
          customer_overlay,
          schema,
          schema_hash,
          materialization_source,
          materialized_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, 'kernel.commit_enum_option_set_revision', now())
        returning id
        "#,
        &[
            &schema.app_id.as_str(),
            &schema.customer_id.as_str(),
            &schema.version.as_str(),
            &base_schema_json,
            &overlay_json,
            &schema_json,
            &schema_hash,
        ],
    )?;
    let revision_id: i64 = row.get("id");
    activate_revision(&mut tx, &schema, revision_id)?;
    tx.commit()?;

    option_set_for_target(&schema, &request.target)
}

fn validate_commit_enum_option_set_revision(
    request: &CommitEnumOptionSetRevision,
) -> Result<(), ValidationError> {
    let mut issues = Vec::new();
    if request.app_id.as_str().trim().is_empty() {
        issues.push(ValidationIssue::new(
            "app_id",
            "empty_scope_id",
            "scope id must not be empty",
        ));
    }
    if request.customer_id.as_str().trim().is_empty() {
        issues.push(ValidationIssue::new(
            "customer_id",
            "empty_scope_id",
            "scope id must not be empty",
        ));
    }
    match &request.target {
        EnumOptionSetTarget::Declared { model_id, field_id }
        | EnumOptionSetTarget::Custom { model_id, field_id } => {
            if model_id.as_str().trim().is_empty() {
                issues.push(ValidationIssue::new(
                    "target.model_id",
                    "empty_value",
                    "target model_id must not be empty",
                ));
            }
            if field_id.as_str().trim().is_empty() {
                issues.push(ValidationIssue::new(
                    "target.field_id",
                    "empty_value",
                    "target field_id must not be empty",
                ));
            }
        }
    }
    if request.options.is_empty() {
        issues.push(ValidationIssue::new(
            "options",
            "empty_option_set",
            "enum option set must not be empty",
        ));
    }
    if issues.is_empty() {
        Ok(())
    } else {
        Err(ValidationError::new(issues))
    }
}

struct ActiveSchemaRevisionState {
    id: SchemaRevisionId,
    base_schema: Schema,
    schema: Schema,
    overlay: SchemaRevisionOverlay,
}

struct ActiveSchemaRevisionMaterializationState {
    id: SchemaRevisionId,
    base_schema_version: SchemaVersion,
    base_schema_json: Value,
    schema_json: Value,
    overlay: SchemaRevisionOverlay,
}

fn active_schema_revision_state(
    client: &mut impl GenericClient,
    app_id: &AppId,
    customer_id: &CustomerId,
) -> Result<ActiveSchemaRevisionState, DbError> {
    if !table_exists(client, "schema_revision")? {
        return Err(DbError::ActiveSchemaMissing {
            app_id: app_id.to_string(),
            customer_id: customer_id.to_string(),
        });
    }

    let Some(row) = client.query_opt(
        r#"
        select id, base_schema, schema, customer_overlay
        from schema_revision
        where app_id = $1 and customer_id = $2 and activated_at is not null
        for update
        "#,
        &[&app_id.as_str(), &customer_id.as_str()],
    )?
    else {
        return Err(DbError::ActiveSchemaMissing {
            app_id: app_id.to_string(),
            customer_id: customer_id.to_string(),
        });
    };
    let base_schema_json: Value = row.get("base_schema");
    let schema_json: Value = row.get("schema");
    let overlay_json: Value = row.get("customer_overlay");
    Ok(ActiveSchemaRevisionState {
        id: SchemaRevisionId::new(row.get("id")),
        base_schema: serde_json::from_value(base_schema_json)?,
        schema: serde_json::from_value(schema_json)?,
        overlay: serde_json::from_value(overlay_json)?,
    })
}

fn active_schema_revision_materialization_state(
    client: &mut impl GenericClient,
    app_id: &AppId,
    customer_id: &CustomerId,
) -> Result<ActiveSchemaRevisionMaterializationState, DbError> {
    if !table_exists(client, "schema_revision")? {
        return Err(DbError::ActiveSchemaMissing {
            app_id: app_id.to_string(),
            customer_id: customer_id.to_string(),
        });
    }

    let Some(row) = client.query_opt(
        r#"
        select id, base_schema, schema, customer_overlay
        from schema_revision
        where app_id = $1 and customer_id = $2 and activated_at is not null
        for update
        "#,
        &[&app_id.as_str(), &customer_id.as_str()],
    )?
    else {
        return Err(DbError::ActiveSchemaMissing {
            app_id: app_id.to_string(),
            customer_id: customer_id.to_string(),
        });
    };
    let base_schema_json: Value = row.get("base_schema");
    let schema_json: Value = row.get("schema");
    let overlay_json: Value = row.get("customer_overlay");
    let base_schema_version = schema_version_from_json(&base_schema_json)?;
    Ok(ActiveSchemaRevisionMaterializationState {
        id: SchemaRevisionId::new(row.get("id")),
        base_schema_version,
        base_schema_json,
        schema_json,
        overlay: serde_json::from_value(overlay_json)?,
    })
}

fn schema_version_from_json(schema_json: &Value) -> Result<SchemaVersion, DbError> {
    if let Some(version) = schema_json.get("version").and_then(Value::as_str) {
        return Ok(SchemaVersion::from(version));
    };
    let schema: Schema = serde_json::from_value(schema_json.clone())?;
    Ok(schema.version)
}

fn fill_missing_model_kinds_from_schema(schema_json: &mut Value, expected_schema: &Schema) -> bool {
    let expected_kinds: BTreeMap<String, Value> = expected_schema
        .models
        .iter()
        .map(|model| {
            (
                model.id.as_str().to_string(),
                serde_json::to_value(model.kind).expect("model kind serializes"),
            )
        })
        .collect();
    let Some(models) = schema_json.get_mut("models").and_then(Value::as_array_mut) else {
        return false;
    };

    let mut changed = false;
    for model in models {
        let Some(model_object) = model.as_object_mut() else {
            continue;
        };
        if model_object.contains_key("kind") {
            continue;
        }
        let Some(model_id) = model_object.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(kind) = expected_kinds.get(model_id) else {
            continue;
        };
        model_object.insert("kind".to_string(), kind.clone());
        changed = true;
    }
    changed
}

fn normalize_enum_options_for_write(
    options: &[EnumOption],
) -> Result<Vec<EnumOption>, ValidationError> {
    let mut issues = Vec::new();
    let mut normalized = Vec::with_capacity(options.len());
    for (index, option) in options.iter().enumerate() {
        let normalized_id = match normalize_identifier(option.id.as_str()) {
            Ok(value) => value,
            Err(mut issue) => {
                issue.path = format!("options[{index}].id");
                issues.push(issue);
                continue;
            }
        };
        normalized.push(EnumOption {
            id: EnumOptionId::from(normalized_id),
            label: option.label.clone(),
            aliases: option.aliases.clone(),
            origin: option.origin,
            management: option.management,
            lifecycle: option.lifecycle,
        });
    }
    if issues.is_empty() {
        Ok(normalized)
    } else {
        Err(ValidationError::new(issues))
    }
}

fn apply_option_set_overlay_update(
    base_schema: &Schema,
    overlay: &mut SchemaRevisionOverlay,
    target: &EnumOptionSetTarget,
    option_set: Vec<EnumOption>,
) -> Result<(), DbError> {
    match target {
        EnumOptionSetTarget::Declared { model_id, field_id } => {
            let additions = declared_option_additions(base_schema, model_id, field_id, option_set)?;
            set_option_set_entry(
                &mut overlay.declared_enum_option_additions,
                model_id,
                field_id,
                additions,
            );
        }
        EnumOptionSetTarget::Custom { model_id, field_id } => {
            set_option_set_entry(
                &mut overlay.custom_enum_option_sets,
                model_id,
                field_id,
                option_set,
            );
        }
    }
    Ok(())
}

fn set_option_set_entry(
    entries: &mut Vec<EnumOptionSetOverlay>,
    model_id: &ModelId,
    field_id: &FieldId,
    option_set: Vec<EnumOption>,
) {
    if let Some(entry) = entries
        .iter_mut()
        .find(|entry| entry.model_id == *model_id && entry.field_id == *field_id)
    {
        entry.option_set = option_set;
    } else {
        entries.push(EnumOptionSetOverlay {
            model_id: model_id.clone(),
            field_id: field_id.clone(),
            option_set,
        });
    }
}

fn declared_option_additions(
    base_schema: &Schema,
    model_id: &ModelId,
    field_id: &FieldId,
    requested_effective_options: Vec<EnumOption>,
) -> Result<Vec<EnumOption>, DbError> {
    let base_options = base_declared_enum_options(base_schema, model_id, field_id)?;
    let requested_by_id = requested_effective_options
        .iter()
        .map(|option| (option.id.clone(), option))
        .collect::<BTreeMap<_, _>>();

    for base_option in base_options {
        let Some(requested_option) = requested_by_id.get(&base_option.id) else {
            return Err(overlay_option_error(
                "options",
                "declared_base_option_removed",
                format!(
                    "declared enum base option `{}` must remain present",
                    base_option.id
                ),
            ));
        };
        if *requested_option != base_option {
            return Err(overlay_option_error(
                "options",
                "declared_base_option_modified",
                format!(
                    "declared enum base option `{}` may not be renamed or redefined",
                    base_option.id
                ),
            ));
        }
    }

    let base_ids = base_options
        .iter()
        .map(|option| option.id.clone())
        .collect::<BTreeSet<_>>();
    Ok(requested_effective_options
        .into_iter()
        .filter(|option| !base_ids.contains(&option.id))
        .collect())
}

fn next_runtime_schema_version(
    client: &mut impl GenericClient,
    base_schema: &Schema,
) -> Result<SchemaVersion, DbError> {
    let prefix = format!("{}+r", base_schema.version);
    let pattern = format!("{prefix}%");
    let count: i64 = client
        .query_one(
            r#"
            select count(*)
            from schema_revision
            where app_id = $1 and customer_id = $2 and version like $3
            "#,
            &[
                &base_schema.app_id.as_str(),
                &base_schema.customer_id.as_str(),
                &pattern,
            ],
        )?
        .get(0);
    Ok(SchemaVersion::from(format!("{prefix}{}", count + 1)))
}

/// Composes `overlay` on `base_schema` and validates the result as the
/// successor of `prior` (see `validate_schema_revision`).
fn compose_schema_revision(
    base_schema: &Schema,
    overlay: &SchemaRevisionOverlay,
    prior: Option<&Schema>,
) -> Result<Schema, DbError> {
    let schema = compose_overlay(base_schema, overlay)?;
    validate_schema_revision(&schema, prior)?;
    Ok(schema)
}

/// Recomposes the active overlay on its own base. The caller requires the
/// result to equal the active schema, so any collision in it already exists.
fn recompose_active_schema_revision(
    base_schema: &Schema,
    overlay: &SchemaRevisionOverlay,
) -> Result<Schema, DbError> {
    let schema = compose_overlay(base_schema, overlay)?;
    validate_schema_revision(&schema, Some(&schema))?;
    Ok(schema)
}

fn compose_overlay(
    base_schema: &Schema,
    overlay: &SchemaRevisionOverlay,
) -> Result<Schema, DbError> {
    let mut schema = base_schema.clone();
    for entry in &overlay.declared_enum_option_additions {
        let field = schema
            .models
            .iter_mut()
            .find(|model| model.id == entry.model_id)
            .and_then(|model| {
                model
                    .fields
                    .iter_mut()
                    .find(|field| field.id == entry.field_id)
            })
            .ok_or_else(|| overlay_target_error("target.field_id", "unknown_enum_target"))?;
        if !matches!(field.field_type, FieldType::Enum) {
            return Err(overlay_target_error(
                "target.field_id",
                "non_enum_option_set_target",
            ));
        }
        field.option_set.extend(entry.option_set.clone());
    }
    for entry in &overlay.custom_enum_option_sets {
        let definition =
            active_custom_field_definition(&schema.custom_fields, &entry.model_id, &entry.field_id)
                .ok_or_else(|| {
                    overlay_target_error("target.field_id", "unknown_custom_enum_target")
                })?;
        if !matches!(definition.field_type, CustomFieldType::Enum) {
            return Err(overlay_target_error(
                "target.field_id",
                "non_enum_option_set_target",
            ));
        }
        let definition = schema
            .custom_fields
            .iter_mut()
            .find(|definition| {
                definition.model_id == entry.model_id
                    && definition.field_id == entry.field_id
                    && definition.archived_at.is_none()
            })
            .expect("active custom field definition was found");
        definition.option_set = entry.option_set.clone();
    }
    Ok(schema)
}

fn base_declared_enum_options<'a>(
    schema: &'a Schema,
    model_id: &ModelId,
    field_id: &FieldId,
) -> Result<&'a [EnumOption], DbError> {
    schema
        .models
        .iter()
        .find(|model| model.id == *model_id)
        .and_then(|model| model.fields.iter().find(|field| field.id == *field_id))
        .filter(|field| matches!(field.field_type, FieldType::Enum))
        .map(|field| field.option_set.as_slice())
        .ok_or_else(|| overlay_target_error("target.field_id", "unknown_enum_target"))
}

fn overlay_target_error(path: &'static str, code: &'static str) -> DbError {
    DbError::Validation(ValidationError::new(vec![ValidationIssue::new(
        path,
        code,
        "enum option-set target is not an active enum field",
    )]))
}

fn overlay_option_error(
    path: &'static str,
    code: &'static str,
    message: impl Into<String>,
) -> DbError {
    DbError::Validation(ValidationError::new(vec![ValidationIssue::new(
        path, code, message,
    )]))
}

fn option_set_for_target(
    schema: &Schema,
    target: &EnumOptionSetTarget,
) -> Result<Vec<EnumOption>, DbError> {
    match target {
        EnumOptionSetTarget::Declared { model_id, field_id } => schema
            .models
            .iter()
            .find(|model| model.id == *model_id)
            .and_then(|model| model.fields.iter().find(|field| field.id == *field_id))
            .filter(|field| matches!(field.field_type, FieldType::Enum))
            .map(|field| field.option_set.clone())
            .ok_or_else(|| overlay_target_error("target.field_id", "unknown_enum_target")),
        EnumOptionSetTarget::Custom { model_id, field_id } => {
            active_custom_field_definition(&schema.custom_fields, model_id, field_id)
                .filter(|definition| matches!(definition.field_type, CustomFieldType::Enum))
                .map(|definition| definition.option_set.clone())
                .ok_or_else(|| {
                    overlay_target_error("target.field_id", "unknown_custom_enum_target")
                })
        }
    }
}

pub fn schema_revision_is_active_with_materialized_tables(
    client: &mut Client,
    schema: &Schema,
) -> Result<bool, DbError> {
    validate_schema(schema)?;

    let mut tx = kernel_transaction(client)?;
    lock_schema_materialization(&mut tx)?;
    lock_schema_activation_reader(&mut tx, &schema.app_id, &schema.customer_id)?;
    let catalog = materialization_catalog(&mut tx, schema)?;
    set_tenant_scope(&mut tx, &schema.app_id, &schema.customer_id)?;
    let active_state = active_schema_revision_state(&mut tx, &schema.app_id, &schema.customer_id)
        .map(Some)
        .or_else(|error| match error {
            DbError::ActiveSchemaMissing { .. } => Ok(None),
            error => Err(error),
        })?;
    let Some(active_state) = active_state else {
        return Ok(false);
    };
    if active_state.base_schema.version != schema.version {
        return Ok(false);
    }
    if active_state.base_schema != *schema {
        let existing_schema =
            serde_json::to_value(&active_state.base_schema).expect("schema serializes");
        let current_schema = serde_json::to_value(schema).expect("schema serializes");
        return Err(schema_revision_conflict(&existing_schema, &current_schema));
    }
    let mut effective_schema = recompose_active_schema_revision(schema, &active_state.overlay)?;
    effective_schema.version = active_state.schema.version.clone();
    if effective_schema != active_state.schema {
        let existing_schema =
            serde_json::to_value(&active_state.schema).expect("schema serializes");
        let current_schema = serde_json::to_value(&effective_schema).expect("schema serializes");
        return Err(schema_revision_conflict(&existing_schema, &current_schema));
    }
    validate_materialized_schema_contracts(&mut tx, &effective_schema, &catalog)?;
    tx.commit()?;
    Ok(true)
}

fn validate_materialized_schema_contracts(
    client: &mut impl GenericClient,
    schema: &Schema,
    catalog: &MaterializationCatalog,
) -> Result<(), DbError> {
    let physical_models = physical_models(schema)?;
    // Materialization and repair complete before validation reaches this point.
    // Load a fresh, immutable catalog view so existence checks remain constant
    // as the number of app models grows.
    let canonical = Arc::new(CanonicalProbeResults::for_schema(
        client,
        schema,
        &physical_models,
    )?);
    let postgres_catalog = PostgresCatalogSnapshot::load(client, canonical)?;
    validate_materialized_schema_contracts_against(
        client,
        schema,
        catalog,
        &physical_models,
        &postgres_catalog,
    )
}

fn validate_materialized_schema_contracts_against(
    client: &mut impl GenericClient,
    schema: &Schema,
    catalog: &MaterializationCatalog,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
    postgres_catalog: &PostgresCatalogSnapshot,
) -> Result<(), DbError> {
    postgres_catalog.validate_sequence_exists("change_set_lifecycle_order_seq")?;
    postgres_catalog.validate_table_exists("schema_revision")?;
    postgres_catalog.validate_table_exists("change_set")?;
    postgres_catalog.validate_table_exists("agent_run")?;
    validate_columns_against(
        postgres_catalog,
        "schema_revision",
        &schema_revision_columns(),
        postgres_catalog.columns("schema_revision"),
    )?;
    validate_columns_against(
        postgres_catalog,
        "change_set",
        &change_set_columns(),
        postgres_catalog.columns("change_set"),
    )?;
    validate_columns_against(
        postgres_catalog,
        "agent_run",
        &agent_run_columns(),
        postgres_catalog.columns("agent_run"),
    )?;
    if postgres_catalog
        .tables
        .contains(SCHEMA_ACTIVATION_HEAD_TABLE)
    {
        validate_columns_against(
            postgres_catalog,
            SCHEMA_ACTIVATION_HEAD_TABLE,
            &schema_activation_head_columns(),
            postgres_catalog.columns(SCHEMA_ACTIVATION_HEAD_TABLE),
        )?;
        validate_key_constraint(
            postgres_catalog,
            SCHEMA_ACTIVATION_HEAD_TABLE,
            "schema_activation_head_pkey",
            "p",
            &["app_id", "customer_id"],
        )?;
        validate_rls_against(
            SCHEMA_ACTIVATION_HEAD_TABLE,
            postgres_catalog.rls(SCHEMA_ACTIVATION_HEAD_TABLE),
            postgres_catalog,
        )?;
        validate_schema_activation_head_trigger(client)?;
    }
    for model in &schema.models {
        let physical_model = physical_models.get(&model.id).expect("model was collected");
        validate_record_table_contract(client, physical_model, postgres_catalog)?;
        validate_version_table_contract(
            client,
            model,
            physical_model,
            physical_models,
            catalog,
            postgres_catalog,
        )?;
    }
    Ok(())
}

pub fn record_agent_run(
    client: &mut Client,
    run: &AgentRunLedgerEntry,
) -> Result<StoredAgentRun, DbError> {
    validate_agent_run_ledger_entry(run)?;
    let mut tx = tenant_transaction(client, &run.app_id, &run.customer_id)?;
    if let Some(existing) = existing_agent_run(&mut tx, run)? {
        tx.commit()?;
        return Ok(existing);
    }
    let (schema_revision_id, _) = active_schema(&mut tx, &run.app_id, &run.customer_id)?;
    if let Some(supplied) = run.schema_revision_id {
        if supplied != schema_revision_id {
            return Err(DbError::StaleSchemaRevision {
                supplied: supplied.get(),
                active: schema_revision_id.get(),
            });
        }
    }
    let stored = insert_agent_run(&mut tx, run, schema_revision_id)?;
    tx.commit()?;
    Ok(stored)
}

pub fn read_active_schema_revision(
    client: &mut Client,
    app_id: &AppId,
    customer_id: &CustomerId,
) -> Result<ActiveSchemaRevision, DbError> {
    let mut tx = tenant_transaction(client, app_id, customer_id)?;
    let (schema_revision_id, schema) = active_schema(&mut tx, app_id, customer_id)?;
    // Generated installations: the same expression the tenant schema revision
    // commit compares against. Native storage has no installation ledger, so
    // its recorded schema hash is the effective hash.
    let installed: bool = tx
        .query_one(
            "select to_regclass('schema_installation_revision') is not null",
            &[],
        )?
        .get(0);
    let recorded: Option<String> = tx
        .query_one(
            if installed {
                r#"
                select coalesce(sir.effective_artifact_hash, sr.schema_hash, kernel_admin_sha256(kernel_canonical_json(sr.schema)))
                from schema_revision sr
                left join schema_installation_revision sir on sir.schema_revision_id = sr.id
                where sr.id = $1 and sr.app_id = $2 and sr.customer_id = $3
                "#
            } else {
                "select schema_hash from schema_revision where id = $1 and app_id = $2 and customer_id = $3"
            },
            &[&schema_revision_id.get(), &app_id.as_str(), &customer_id.as_str()],
        )?
        .get(0);
    let effective_hash = recorded.unwrap_or_else(|| schema_hash(&schema));
    tx.commit()?;
    Ok(ActiveSchemaRevision {
        schema_revision_id,
        schema,
        effective_hash,
    })
}

pub fn update_agent_run_status(
    client: &mut Client,
    update: &AgentRunStatusUpdate,
) -> Result<StoredAgentRun, DbError> {
    validate_agent_run_status_update(update)?;
    let mut tx = tenant_transaction(client, &update.app_id, &update.customer_id)?;
    let stored = update_existing_agent_run_status(&mut tx, update)?;
    tx.commit()?;
    Ok(stored)
}

pub fn apply_change_set(
    client: &mut Client,
    apply: &ApplyChangeSet,
) -> Result<AppliedChangeSet, DbError> {
    run_change_set(client, apply, ChangeSetRunMode::Commit)
}

pub fn begin_tenant_transaction<'a>(
    client: &'a mut Client,
    app_id: &AppId,
    customer_id: &CustomerId,
) -> Result<Transaction<'a>, DbError> {
    tenant_transaction(client, app_id, customer_id)
}

pub fn apply_change_set_in_transaction(
    tx: &mut impl GenericClient,
    apply: &ApplyChangeSet,
) -> Result<AppliedChangeSet, DbError> {
    ensure_caller_owned_transaction(tx)?;
    lock_schema_activation_reader(tx, &apply.app_id, &apply.customer_id)?;
    drop_current_session_temp_views(tx)?;
    assert_native_policy_supported(tx, &apply.app_id, &apply.customer_id)?;
    run_change_set_in_transaction(tx, apply, ChangeSetRunMode::Commit)
}

fn ensure_caller_owned_transaction(client: &mut impl GenericClient) -> Result<(), DbError> {
    // GenericClient includes both Transaction and autocommit Client. Prove the
    // caller supplied a real multi-statement transaction before taking a
    // transaction-scoped activation lock: a transaction-local setting survives
    // the next statement only when both statements share the same transaction.
    let probe = Uuid::new_v4().to_string();
    client.query_one(
        "select set_config('platform.caller_owned_transaction_probe', $1, true)",
        &[&probe],
    )?;
    let persisted: Option<String> = client
        .query_one(
            "select nullif(current_setting('platform.caller_owned_transaction_probe', true), '')",
            &[],
        )?
        .get(0);
    if persisted.as_deref() != Some(probe.as_str()) {
        return Err(DbError::Validation(ValidationError::new(vec![
            ValidationIssue::new(
                "transaction",
                "caller_owned_transaction_required",
                "apply_change_set_in_transaction requires an explicit caller-owned transaction",
            ),
        ])));
    }
    Ok(())
}

pub fn validate_change_set_dry_run(
    client: &mut Client,
    apply: &ApplyChangeSet,
) -> Result<AppliedChangeSet, DbError> {
    run_change_set(client, apply, ChangeSetRunMode::DryRun)
}

pub fn validate_change_sets_dry_run(
    client: &mut Client,
    applies: &[ApplyChangeSet],
) -> Result<Vec<AppliedChangeSet>, DbError> {
    let Some(first) = applies.first() else {
        return Err(DbError::Validation(ValidationError::new(vec![
            ValidationIssue::new(
                "changesets",
                "empty_changesets",
                "atomic dry-run must include at least one changeset",
            ),
        ])));
    };

    loop {
        let mut tx = tenant_transaction(client, &first.app_id, &first.customer_id)?;
        match validate_change_sets_dry_run_in_transaction(&mut tx, applies) {
            Ok(applied) => {
                tx.rollback()?;
                return Ok(applied);
            }
            Err(error) if is_apply_dependency_drift(&error) => {
                tx.rollback()?;
            }
            Err(error) => return Err(error),
        }
    }
}

fn validate_change_sets_dry_run_in_transaction(
    tx: &mut impl GenericClient,
    applies: &[ApplyChangeSet],
) -> Result<Vec<AppliedChangeSet>, DbError> {
    let first = applies
        .first()
        .expect("empty dry-run batches are rejected before opening a transaction");
    lock_schema_activation_reader(tx, &first.app_id, &first.customer_id)?;
    let (schema_revision_id, schema) = active_schema(tx, &first.app_id, &first.customer_id)?;
    // One atomic validation envelope is evaluated against one schema revision.
    // Do not re-read the active schema inside the changeset loop: at READ
    // COMMITTED, a concurrent schema activation could otherwise split one
    // logical validation across multiple revisions.
    let mut applied = Vec::with_capacity(applies.len());
    let mut synthetic_orders = SyntheticOrderAllocator::default();
    for (index, apply) in applies.iter().enumerate() {
        if apply.app_id != first.app_id || apply.customer_id != first.customer_id {
            return Err(DbError::Validation(ValidationError::new(vec![
                ValidationIssue::new(
                    format!("changesets[{index}]"),
                    "mixed_changeset_scope",
                    "all atomic dry-run changesets must share one app_id and customer_id",
                ),
            ])));
        }
        match run_change_set_in_transaction_with_schema_and_orders(
            tx,
            apply,
            ChangeSetRunMode::DryRun,
            schema_revision_id,
            &schema,
            &mut synthetic_orders,
        ) {
            Ok(change_set) => applied.push(change_set),
            Err(error) => {
                return Err(DbError::AtomicDryRunChangeSetFailed {
                    index,
                    source: Box::new(error),
                });
            }
        }
    }
    Ok(applied)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ChangeSetRunMode {
    Commit,
    DryRun,
}

#[derive(Default)]
struct SyntheticOrderAllocator {
    last_order: Option<i64>,
}

impl SyntheticOrderAllocator {
    fn next(&mut self, client: &mut impl GenericClient) -> Result<i64, DbError> {
        let current = match self.last_order {
            Some(order) => order,
            None => client
                .query_one(
                    r#"
                    select coalesce(
                      max(greatest(created_order, coalesce(applied_order, created_order))),
                      0
                    ) as lifecycle_order
                    from change_set
                    "#,
                    &[],
                )?
                .get("lifecycle_order"),
        };
        let next = current.checked_add(1).ok_or_else(|| DbError::SchemaDrift {
            object: "change_set_lifecycle_order_seq".to_string(),
            details: "cannot allocate a transaction-local synthetic lifecycle order".to_string(),
        })?;
        self.last_order = Some(next);
        Ok(next)
    }
}

fn run_change_set(
    client: &mut Client,
    apply: &ApplyChangeSet,
    mode: ChangeSetRunMode,
) -> Result<AppliedChangeSet, DbError> {
    if apply.source_kind == "revert" {
        return Err(DbError::ReservedSourceKind {
            source_kind: apply.source_kind.clone(),
        });
    }
    if let Some(existing) = existing_idempotent_change_set_before_activation(client, apply)? {
        return Ok(existing);
    }

    loop {
        let mut tx = tenant_transaction(client, &apply.app_id, &apply.customer_id)?;
        match run_change_set_in_transaction(&mut tx, apply, mode) {
            Ok(result) => {
                match mode {
                    ChangeSetRunMode::Commit => tx.commit()?,
                    ChangeSetRunMode::DryRun => tx.rollback()?,
                }
                return Ok(result);
            }
            Err(error) if is_apply_dependency_drift(&error) => {
                tx.rollback()?;
            }
            Err(error) => return Err(error),
        }
    }
}

fn existing_idempotent_change_set_before_activation(
    client: &mut Client,
    apply: &ApplyChangeSet,
) -> Result<Option<AppliedChangeSet>, DbError> {
    if apply.idempotency_key.is_none() {
        return Ok(None);
    }

    // Exact replays remain valid across schema activation. Probe them in a
    // short transaction that releases its change_set relation lock before a
    // new mutation transaction waits for the activation reader lock. The
    // mutation path reacquires the idempotency lock and rechecks the replay.
    let mut tx = kernel_transaction(client)?;
    set_tenant_scope(&mut tx, &apply.app_id, &apply.customer_id)?;
    // The legacy replay fast path bypasses tenant_transaction, so it must
    // independently reject policy-enabled receipts before reading their audit.
    assert_native_policy_supported(&mut tx, &apply.app_id, &apply.customer_id)?;
    lock_idempotency_key(&mut tx, apply)?;
    let existing = existing_idempotent_change_set(&mut tx, apply)?;
    tx.commit()?;
    Ok(existing)
}

fn is_apply_dependency_drift(error: &DbError) -> bool {
    match error {
        DbError::AtomicDryRunChangeSetFailed { source, .. } => is_apply_dependency_drift(source),
        DbError::Postgres(error) => {
            error.code() == Some(&SqlState::T_R_SERIALIZATION_FAILURE)
                && error
                    .as_db_error()
                    .is_some_and(|error| error.message() == APPLY_DEPENDENCY_DRIFT_MESSAGE)
        }
        _ => false,
    }
}

fn abort_for_apply_dependency_drift(client: &mut impl GenericClient) -> DbError {
    let error = client
        .batch_execute(
            r#"
            do $$
            begin
              raise exception 'record apply dependency drift' using errcode = '40001';
            end
            $$;
            "#,
        )
        .expect_err("dependency drift abort always raises a serialization failure");
    DbError::Postgres(error)
}

fn run_change_set_in_transaction(
    tx: &mut impl GenericClient,
    apply: &ApplyChangeSet,
    mode: ChangeSetRunMode,
) -> Result<AppliedChangeSet, DbError> {
    let mut synthetic_orders = SyntheticOrderAllocator::default();
    lock_schema_activation_reader(&mut *tx, &apply.app_id, &apply.customer_id)?;
    if let Some(existing) = prepare_change_set_in_transaction(&mut *tx, apply)? {
        return Ok(existing);
    }
    let (schema_revision_id, schema) = active_schema(&mut *tx, &apply.app_id, &apply.customer_id)?;
    run_prepared_change_set_in_transaction_with_schema(
        tx,
        apply,
        mode,
        schema_revision_id,
        &schema,
        &mut synthetic_orders,
    )
}

fn run_change_set_in_transaction_with_schema_and_orders(
    tx: &mut impl GenericClient,
    apply: &ApplyChangeSet,
    mode: ChangeSetRunMode,
    schema_revision_id: SchemaRevisionId,
    schema: &Schema,
    synthetic_orders: &mut SyntheticOrderAllocator,
) -> Result<AppliedChangeSet, DbError> {
    if let Some(existing) = prepare_change_set_in_transaction(&mut *tx, apply)? {
        return Ok(existing);
    }
    run_prepared_change_set_in_transaction_with_schema(
        tx,
        apply,
        mode,
        schema_revision_id,
        schema,
        synthetic_orders,
    )
}

fn prepare_change_set_in_transaction(
    tx: &mut impl GenericClient,
    apply: &ApplyChangeSet,
) -> Result<Option<AppliedChangeSet>, DbError> {
    if apply.source_kind == "revert" {
        return Err(DbError::ReservedSourceKind {
            source_kind: apply.source_kind.clone(),
        });
    }

    lock_idempotency_key(&mut *tx, apply)?;
    if let Some(existing) = existing_idempotent_change_set(&mut *tx, apply)? {
        return Ok(Some(existing));
    }
    Ok(None)
}

fn run_prepared_change_set_in_transaction_with_schema(
    tx: &mut impl GenericClient,
    apply: &ApplyChangeSet,
    mode: ChangeSetRunMode,
    schema_revision_id: SchemaRevisionId,
    schema: &Schema,
    synthetic_orders: &mut SyntheticOrderAllocator,
) -> Result<AppliedChangeSet, DbError> {
    if let Some(supplied) = apply.schema_revision_id {
        if supplied != schema_revision_id {
            return Err(DbError::StaleSchemaRevision {
                supplied: supplied.get(),
                active: schema_revision_id.get(),
            });
        }
    }
    validate_apply_against_schema(apply, schema)?;
    validate_agent_write_provenance(&mut *tx, apply, schema_revision_id)?;

    let request_fingerprint = request_fingerprint(apply, schema_revision_id)?;
    match (mode, &apply.mode) {
        (ChangeSetRunMode::Commit, ApplyMode::Mainline) => apply_prepared_mainline_change_set(
            tx,
            apply,
            schema_revision_id,
            schema,
            &request_fingerprint,
        ),
        (ChangeSetRunMode::Commit, ApplyMode::Draft) => apply_prepared_draft_change_set(
            tx,
            apply,
            schema_revision_id,
            schema,
            &request_fingerprint,
        ),
        (ChangeSetRunMode::DryRun, _) => apply_prepared_dry_run_change_set(
            tx,
            apply,
            schema_revision_id,
            schema,
            &request_fingerprint,
            synthetic_orders,
        ),
    }
}

pub fn list_draft_change_sets(
    client: &mut Client,
    app_id: &AppId,
    customer_id: &CustomerId,
) -> Result<Vec<DraftSummary>, DbError> {
    let mut tx = tenant_transaction(client, app_id, customer_id)?;
    let rows = tx.query(
        r#"
        select id, schema_revision_id, actor_id, source_kind, source_ref, change_type_id, notes, created_at
        from change_set
        where app_id = $1 and customer_id = $2 and status = 'draft'
        order by created_order desc, id desc
        "#,
        &[&app_id.as_str(), &customer_id.as_str()],
    )?;
    let drafts = rows
        .into_iter()
        .map(|row| DraftSummary {
            id: row.get("id"),
            schema_revision_id: SchemaRevisionId::new(row.get("schema_revision_id")),
            actor_id: row.get("actor_id"),
            source_kind: row.get("source_kind"),
            source_ref: row.get("source_ref"),
            change_type_id: row
                .get::<_, Option<String>>("change_type_id")
                .map(ChangeTypeId::from),
            notes: row.get("notes"),
            created_at: row.get("created_at"),
        })
        .collect();
    tx.commit()?;
    Ok(drafts)
}

pub fn read_draft_change_set(
    client: &mut Client,
    app_id: &AppId,
    customer_id: &CustomerId,
    change_set_id: i64,
) -> Result<Vec<DraftRecord>, DbError> {
    let mut tx = tenant_transaction(client, app_id, customer_id)?;
    let (schema_revision_id, status) =
        change_set_revision_and_status(&mut tx, app_id, customer_id, change_set_id, false)?;
    if status != "draft" {
        return Err(DbError::DraftStatusConflict {
            details: format!("change_set `{change_set_id}` has status `{status}`, not `draft`"),
        });
    }
    let schema = schema_by_revision(&mut tx, app_id, customer_id, schema_revision_id)?;
    let physical_models = physical_models(&schema)?;
    let mut records = Vec::new();
    for model in &schema.models {
        let physical_model = physical_models
            .get(&model.id)
            .expect("model was materialized");
        records.extend(load_draft_records_for_model(
            &mut tx,
            change_set_id,
            &schema,
            model,
            physical_model,
            &physical_models,
        )?);
    }
    tx.commit()?;
    Ok(records)
}

pub fn approve_draft_change_set(
    client: &mut Client,
    app_id: &AppId,
    customer_id: &CustomerId,
    change_set_id: i64,
) -> Result<AppliedChangeSet, DbError> {
    loop {
        let mut tx = tenant_transaction(client, app_id, customer_id)?;
        match approve_draft_change_set_in_transaction(&mut tx, app_id, customer_id, change_set_id) {
            Ok(result) => {
                tx.commit()?;
                return Ok(result);
            }
            Err(error) if is_apply_dependency_drift(&error) => {
                tx.rollback()?;
            }
            Err(error) => return Err(error),
        }
    }
}

fn approve_draft_change_set_in_transaction(
    tx: &mut impl GenericClient,
    app_id: &AppId,
    customer_id: &CustomerId,
    change_set_id: i64,
) -> Result<AppliedChangeSet, DbError> {
    let (schema_revision_id, status) =
        change_set_revision_and_status(tx, app_id, customer_id, change_set_id, true)?;
    match status.as_str() {
        "mainline" if change_set_was_draft_request(tx, app_id, customer_id, change_set_id)? => {
            return Ok(AppliedChangeSet {
                id: change_set_id,
                schema_revision_id,
            });
        }
        "draft" => {}
        _ => {
            return Err(DbError::DraftStatusConflict {
                details: format!(
                    "cannot approve change_set `{change_set_id}` with status `{status}`"
                ),
            })
        }
    }

    let schema = schema_by_revision(tx, app_id, customer_id, schema_revision_id)?;
    let physical_models = physical_models(&schema)?;
    let mut draft_rows = Vec::new();
    for model in &schema.models {
        let physical_model = physical_models
            .get(&model.id)
            .expect("model was materialized");
        draft_rows.extend(load_draft_version_rows_for_model(
            tx,
            app_id,
            customer_id,
            change_set_id,
            &schema,
            model,
            physical_model,
            &physical_models,
        )?);
    }
    if draft_rows.is_empty() {
        return Err(DbError::DraftStatusConflict {
            details: format!("change_set `{change_set_id}` has no draft version rows"),
        });
    }

    reject_draft_tombstone_before_later_draft(&draft_rows)?;
    draft_rows.sort_by(|left, right| {
        left.model_id
            .cmp(&right.model_id)
            .then(left.record_id.cmp(&right.record_id))
            .then(left.effective_start.cmp(&right.effective_start))
            .then(left.version_id.cmp(&right.version_id))
    });

    let mut relation_addresses = Vec::new();
    for draft in &draft_rows {
        let model = schema
            .models
            .iter()
            .find(|model| model.id == draft.model_id)
            .expect("draft model was loaded from schema");
        let mut snapshot_addresses = Vec::new();
        collect_snapshot_relation_addresses(
            &schema,
            model,
            &draft.values,
            &draft.custom_fields,
            &mut snapshot_addresses,
        )?;
        relation_addresses.extend(
            snapshot_addresses
                .into_iter()
                .map(|(model_id, record_key)| (model_id, record_key, draft.effective_start)),
        );
    }

    let mut relation_targets = BTreeMap::new();
    for (target_model_id, record_key, _) in &relation_addresses {
        let address = scoped_record_address(target_model_id, record_key);
        if relation_targets.contains_key(&address) {
            continue;
        }
        let physical_model = physical_models
            .get(target_model_id)
            .expect("draft relation target model was materialized");
        let record_id = resolve_existing_record_id_for_scope_unlocked(
            tx,
            app_id,
            customer_id,
            physical_model,
            record_key,
        )?;
        relation_targets.insert(address, record_id);
    }
    let mut lock_set = draft_rows
        .iter()
        .map(|draft| (draft.model_id.clone(), draft.record_id))
        .collect::<BTreeSet<_>>();
    for (address, record_id) in &relation_targets {
        lock_set.insert((address.model_id.clone(), *record_id));
    }
    lock_record_set_for_scope(tx, app_id, customer_id, &physical_models, &lock_set)?;

    for (address, record_id) in &relation_targets {
        let physical_model = physical_models
            .get(&address.model_id)
            .expect("draft relation target model was materialized");
        let record_key = match &address.address {
            CanonicalRecordAddress::RecordId(record_id) => RecordKey::RecordId(*record_id),
            CanonicalRecordAddress::ExternalKey(external_key) => {
                RecordKey::ExternalKey(ExternalKey::from(external_key.as_str()))
            }
            CanonicalRecordAddress::LookupOrCreate(_) => {
                return Err(lookup_or_create_requires_generated_sql("record_key"));
            }
            CanonicalRecordAddress::NewRecordId(_) => {
                unreachable!("stored draft relations never use new-record subject addresses")
            }
            CanonicalRecordAddress::Anonymous(_) => {
                unreachable!("stored draft relations never use anonymous addresses")
            }
        };
        let rechecked = resolve_existing_record_id_for_scope_unlocked(
            tx,
            app_id,
            customer_id,
            physical_model,
            &record_key,
        )?;
        if rechecked != *record_id {
            return Err(abort_for_apply_dependency_drift(tx));
        }
    }

    reject_stale_draft(
        tx,
        app_id,
        customer_id,
        change_set_id,
        &physical_models,
        &draft_rows,
    )?;
    for (target_model_id, record_key, as_of) in &relation_addresses {
        let address = scoped_record_address(target_model_id, record_key);
        let record_id = *relation_targets
            .get(&address)
            .expect("every draft relation target was resolved");
        let physical_model = physical_models
            .get(target_model_id)
            .expect("draft relation target model was materialized");
        match relation_target_visibility_for_scope(
            tx,
            app_id,
            customer_id,
            Some(change_set_id),
            physical_model,
            record_id,
            *as_of,
        )? {
            Some(false) => {}
            Some(true) => {
                return Err(DbError::TombstonedRecord {
                    details: format!("record `{record_id}` is tombstoned as of {as_of}"),
                });
            }
            None => {
                return Err(DbError::RecordTargetMissing {
                    details: format!("record `{record_id}` is not visible as of {as_of}"),
                });
            }
        }
    }

    // Complete every validation that can be evaluated against the locked
    // baseline before allocating approval's causal order.
    reject_draft_live_unique_conflicts(
        tx,
        app_id,
        customer_id,
        &schema,
        &physical_models,
        &draft_rows,
    )?;
    for draft in &draft_rows {
        let model = schema
            .models
            .iter()
            .find(|model| model.id == draft.model_id)
            .expect("draft model was loaded from schema");
        let physical_model = physical_models
            .get(&draft.model_id)
            .expect("draft model was materialized");
        if draft.tombstones_record || draft.untombstones_record {
            ensure_no_same_day_mainline(
                tx,
                app_id,
                customer_id,
                physical_model,
                MainlineUniquenessKey {
                    record_id: draft.record_id,
                    effective_start: draft.effective_start,
                    tombstones_record: draft.tombstones_record,
                    untombstones_record: draft.untombstones_record,
                },
            )?;
        }
        let next_start = next_version_start_for_scope(
            tx,
            app_id,
            customer_id,
            physical_model,
            draft.record_id,
            draft.effective_start,
        )?;
        if draft.tombstones_record && next_start.is_some() {
            return Err(DbError::TimelineConflict {
                details: format!(
                    "tombstone for record `{}` at {} would precede a later mainline version",
                    draft.record_id, draft.effective_start
                ),
            });
        }
        ensure_unique_field_values_available(
            tx,
            UniqueFieldValueCheck {
                app_id,
                customer_id,
                model,
                physical_model,
                physical_models: &physical_models,
                record_id: draft.record_id,
                values: &draft.values,
            },
        )?;
    }

    let applied_order = next_change_set_order(tx)?;
    let updated = tx.execute(
        r#"
        update change_set
        set status = 'mainline', applied_order = $4, applied_at = now()
        where id = $1 and app_id = $2 and customer_id = $3 and status = 'draft'
        "#,
        &[
            &change_set_id,
            &app_id.as_str(),
            &customer_id.as_str(),
            &applied_order,
        ],
    )?;
    if updated != 1 {
        return Err(DbError::DraftStatusConflict {
            details: format!("draft change_set `{change_set_id}` changed during approval"),
        });
    }
    notify_canonical(tx, app_id.as_str(), customer_id.as_str())?;

    for draft in &draft_rows {
        let model = schema
            .models
            .iter()
            .find(|model| model.id == draft.model_id)
            .expect("draft model was loaded from schema");
        let physical_model = physical_models
            .get(&draft.model_id)
            .expect("draft model was materialized");
        let predecessor = load_mainline_predecessor_for_scope(
            tx,
            app_id,
            customer_id,
            &schema,
            model,
            &physical_models,
            draft.record_id,
            draft.effective_start,
        )?;
        let next_start = next_version_start_for_scope(
            tx,
            app_id,
            customer_id,
            physical_model,
            draft.record_id,
            draft.effective_start,
        )?;
        let same_day_predecessor = predecessor.as_ref().filter(|predecessor| {
            predecessor.effective_start == draft.effective_start
                && !predecessor.tombstones_record
                && !predecessor.untombstones_record
        });
        let effective_end = same_day_predecessor
            .map(|predecessor| predecessor.effective_end)
            .unwrap_or_else(|| next_start.map(|date| date - Duration::days(1)));
        close_displaced_mainline_version_for_scope(
            tx,
            app_id,
            customer_id,
            physical_model,
            draft.effective_start,
            predecessor.as_ref(),
        )?;
        execute_unique_checked(
            tx,
            &format!(
                r#"
                update {}
                set stage = 'mainline',
                    effective_end = $4,
                    applied_at = now()
                where id = $1
                  and app_id = $2
                  and customer_id = $3
                  and stage = 'draft'
                "#,
                quote_identifier(&physical_model.version_table)
            ),
            &[
                &draft.version_id,
                &app_id.as_str(),
                &customer_id.as_str(),
                &effective_end,
            ],
            model,
            physical_model,
            &physical_models,
            &draft.values,
        )?;
    }
    Ok(AppliedChangeSet {
        id: change_set_id,
        schema_revision_id,
    })
}

pub fn discard_draft_change_set(
    client: &mut Client,
    app_id: &AppId,
    customer_id: &CustomerId,
    change_set_id: i64,
) -> Result<AppliedChangeSet, DbError> {
    let mut tx = tenant_transaction(client, app_id, customer_id)?;
    let (schema_revision_id, status) =
        change_set_revision_and_status(&mut tx, app_id, customer_id, change_set_id, true)?;
    match status.as_str() {
        "discarded" => {
            tx.commit()?;
            return Ok(AppliedChangeSet {
                id: change_set_id,
                schema_revision_id,
            });
        }
        "draft" => {}
        _ => {
            return Err(DbError::DraftStatusConflict {
                details: format!(
                    "cannot discard change_set `{change_set_id}` with status `{status}`"
                ),
            })
        }
    }

    let schema = schema_by_revision(&mut tx, app_id, customer_id, schema_revision_id)?;
    let physical_models = physical_models(&schema)?;
    for physical_model in physical_models.values() {
        tx.execute(
            &format!(
                r#"
                update {}
                set stage = 'discarded'
                where change_set_id = $1
                  and app_id = $2
                  and customer_id = $3
                  and stage = 'draft'
                "#,
                quote_identifier(&physical_model.version_table)
            ),
            &[&change_set_id, &app_id.as_str(), &customer_id.as_str()],
        )?;
    }
    release_orphan_draft_external_keys(
        &mut tx,
        app_id,
        customer_id,
        &physical_models,
        change_set_id,
    )?;
    tx.execute(
        r#"
        update change_set
        set status = 'discarded'
        where id = $1 and app_id = $2 and customer_id = $3 and status = 'draft'
        "#,
        &[&change_set_id, &app_id.as_str(), &customer_id.as_str()],
    )?;
    // Open review surfaces learn a draft left the queue.
    notify_canonical(&mut tx, app_id.as_str(), customer_id.as_str())?;
    tx.commit()?;
    Ok(AppliedChangeSet {
        id: change_set_id,
        schema_revision_id,
    })
}

pub fn revert_change_set(
    client: &mut Client,
    request: &RevertChangeSet,
) -> Result<AppliedChangeSet, DbError> {
    loop {
        let mut tx = tenant_transaction(client, &request.app_id, &request.customer_id)?;
        match revert_change_set_in_transaction(&mut tx, request) {
            Ok(result) => {
                tx.commit()?;
                return Ok(result);
            }
            Err(error) if is_apply_dependency_drift(&error) => {
                tx.rollback()?;
            }
            Err(error) => return Err(error),
        }
    }
}

fn revert_change_set_in_transaction(
    tx: &mut impl GenericClient,
    request: &RevertChangeSet,
) -> Result<AppliedChangeSet, DbError> {
    lock_revert_idempotency_key(&mut *tx, request)?;
    if let Some(existing) = existing_idempotent_revert_change_set(&mut *tx, request)? {
        return Ok(existing);
    }

    let target = target_change_set_for_revert(&mut *tx, request)?;
    if target.status != "mainline" {
        return Err(DbError::RevertConflict {
            details: format!(
                "change_set `{}` has status `{}`, not `mainline`",
                request.change_set_id, target.status
            ),
        });
    }
    if target.source_kind == "revert" {
        return Err(DbError::RevertConflict {
            details: format!("change_set `{}` is itself a revert", request.change_set_id),
        });
    }

    let schema = schema_by_revision(
        &mut *tx,
        &request.app_id,
        &request.customer_id,
        target.schema_revision_id,
    )?;
    let physical_models = physical_models(&schema)?;
    let target_applied_order = target.applied_order.ok_or_else(|| DbError::SchemaDrift {
        object: "change_set.applied_order".to_string(),
        details: format!(
            "mainline change_set `{}` has no applied_order",
            request.change_set_id
        ),
    })?;
    let prepared = prepare_revert(
        &mut *tx,
        request,
        &schema,
        &physical_models,
        target_applied_order,
    )?;

    let request_fingerprint = revert_request_fingerprint(request, target.schema_revision_id)?;
    let revert_change_set_id = insert_revert_change_set(
        &mut *tx,
        request,
        target.schema_revision_id,
        &request_fingerprint,
    )?;

    for target_row in &prepared.target_rows {
        let physical_model = physical_models
            .get(&target_row.model_id)
            .expect("target model was materialized");
        let updated = tx.execute(
            &format!(
                r#"
                update {}
                set stage = 'reverted',
                    applied_at = null
                where id = $1
                  and app_id = $2
                  and customer_id = $3
                  and stage = 'mainline'
                "#,
                quote_identifier(&physical_model.version_table)
            ),
            &[
                &target_row.version_id,
                &request.app_id.as_str(),
                &request.customer_id.as_str(),
            ],
        )?;
        if updated != 1 {
            return Err(DbError::SchemaDrift {
                object: physical_model.version_table.clone(),
                details: format!(
                    "revert target version `{}` was not a live mainline row",
                    target_row.version_id
                ),
            });
        }
    }

    for subject in &prepared.subjects {
        normalize_reverted_subject_timeline(&mut *tx, request, &schema, &physical_models, subject)?;
    }
    validate_restored_revert_state(&mut *tx, request, &schema, &physical_models, &prepared)?;
    release_orphan_reverted_external_keys(
        &mut *tx,
        &request.app_id,
        &request.customer_id,
        &physical_models,
        request.change_set_id,
    )?;

    Ok(AppliedChangeSet {
        id: revert_change_set_id,
        schema_revision_id: target.schema_revision_id,
    })
}

pub fn update_draft_notes(
    client: &mut Client,
    app_id: &AppId,
    customer_id: &CustomerId,
    change_set_id: i64,
    notes: Option<String>,
) -> Result<(), DbError> {
    let mut tx = tenant_transaction(client, app_id, customer_id)?;
    let (_, status) =
        change_set_revision_and_status(&mut tx, app_id, customer_id, change_set_id, true)?;
    if status != "draft" {
        return Err(DbError::DraftStatusConflict {
            details: format!(
                "cannot update notes for change_set `{change_set_id}` with status `{status}`"
            ),
        });
    }
    tx.execute(
        "update change_set set notes = $4 where id = $1 and app_id = $2 and customer_id = $3 and status = 'draft'",
        &[&change_set_id, &app_id.as_str(), &customer_id.as_str(), &notes],
    )?;
    tx.commit()?;
    Ok(())
}

fn release_orphan_draft_external_keys(
    client: &mut impl GenericClient,
    app_id: &AppId,
    customer_id: &CustomerId,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
    change_set_id: i64,
) -> Result<(), DbError> {
    for physical_model in physical_models.values() {
        client.execute(
            &format!(
                r#"
                update {} r
                set external_key = null
                where r.app_id = $1
                  and r.customer_id = $2
                  and r.external_key is not null
                  and exists (
                    select 1
                    from {} discarded
                    where discarded.record_id = r.id
                      and discarded.app_id = r.app_id
                      and discarded.customer_id = r.customer_id
                      and discarded.change_set_id = $3
                      and discarded.stage = 'discarded'
                  )
                  and not exists (
                    select 1
                    from {} active_version
                    where active_version.record_id = r.id
                      and active_version.app_id = r.app_id
                      and active_version.customer_id = r.customer_id
                      and active_version.stage in ('draft', 'mainline')
                  )
                "#,
                quote_identifier(&physical_model.record_table),
                quote_identifier(&physical_model.version_table),
                quote_identifier(&physical_model.version_table)
            ),
            &[&app_id.as_str(), &customer_id.as_str(), &change_set_id],
        )?;
    }
    Ok(())
}

fn release_orphan_reverted_external_keys(
    client: &mut impl GenericClient,
    app_id: &AppId,
    customer_id: &CustomerId,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
    change_set_id: i64,
) -> Result<(), DbError> {
    for physical_model in physical_models.values() {
        client.execute(
            &format!(
                r#"
                update {} r
                set external_key = null
                where r.app_id = $1
                  and r.customer_id = $2
                  and r.external_key is not null
                  and exists (
                    select 1
                    from {} reverted
                    where reverted.record_id = r.id
                      and reverted.app_id = r.app_id
                      and reverted.customer_id = r.customer_id
                      and reverted.change_set_id = $3
                      and reverted.stage = 'reverted'
                  )
                  and not exists (
                    select 1
                    from {} active_version
                    where active_version.record_id = r.id
                      and active_version.app_id = r.app_id
                      and active_version.customer_id = r.customer_id
                      and active_version.stage in ('draft', 'mainline')
                  )
                "#,
                quote_identifier(&physical_model.record_table),
                quote_identifier(&physical_model.version_table),
                quote_identifier(&physical_model.version_table)
            ),
            &[&app_id.as_str(), &customer_id.as_str(), &change_set_id],
        )?;
    }
    Ok(())
}

pub fn read_visible_records(
    client: &mut Client,
    app_id: &AppId,
    customer_id: &CustomerId,
    model_id: &ModelId,
    as_of: NaiveDate,
) -> Result<Vec<VisibleRecord>, DbError> {
    let mut tx = tenant_transaction(client, app_id, customer_id)?;
    let (_, schema) = active_schema(&mut tx, app_id, customer_id)?;
    let physical_models = physical_models(&schema)?;
    let records = read_visible_records_for_model(
        &mut tx,
        &schema,
        &physical_models,
        model_id,
        as_of,
        VisibleRecordReadOptions::default(),
    )?;
    tx.commit()?;
    Ok(records)
}

pub fn read_visible_records_in_transaction(
    tx: &mut impl GenericClient,
    app_id: &AppId,
    customer_id: &CustomerId,
    model_id: &ModelId,
    as_of: NaiveDate,
) -> Result<Vec<VisibleRecord>, DbError> {
    ensure_caller_owned_transaction(tx)?;
    lock_schema_activation_reader(tx, app_id, customer_id)?;
    drop_current_session_temp_views(tx)?;
    assert_native_policy_supported(tx, app_id, customer_id)?;
    let (_, schema) = active_schema(&mut *tx, app_id, customer_id)?;
    let physical_models = physical_models(&schema)?;
    read_visible_records_for_model(
        &mut *tx,
        &schema,
        &physical_models,
        model_id,
        as_of,
        VisibleRecordReadOptions::default(),
    )
}

pub fn read_visible_records_by_text_fields_in_transaction(
    tx: &mut impl GenericClient,
    app_id: &AppId,
    customer_id: &CustomerId,
    model_id: &ModelId,
    as_of: NaiveDate,
    field_filters: &BTreeMap<FieldId, String>,
) -> Result<Vec<VisibleRecord>, DbError> {
    ensure_caller_owned_transaction(tx)?;
    lock_schema_activation_reader(tx, app_id, customer_id)?;
    drop_current_session_temp_views(tx)?;
    assert_native_policy_supported(tx, app_id, customer_id)?;
    let (_, schema) = active_schema(&mut *tx, app_id, customer_id)?;
    let physical_models = physical_models(&schema)?;
    read_visible_records_for_model(
        &mut *tx,
        &schema,
        &physical_models,
        model_id,
        as_of,
        VisibleRecordReadOptions {
            text_field_filters: Some(field_filters),
            ..VisibleRecordReadOptions::default()
        },
    )
}

pub fn read_visible_record(
    client: &mut Client,
    app_id: &AppId,
    customer_id: &CustomerId,
    model_id: &ModelId,
    record_id: &RecordId,
    as_of: NaiveDate,
) -> Result<Option<VisibleRecord>, DbError> {
    let mut tx = tenant_transaction(client, app_id, customer_id)?;
    let (_, schema) = active_schema(&mut tx, app_id, customer_id)?;
    let physical_models = physical_models(&schema)?;
    let records = read_visible_records_for_model(
        &mut tx,
        &schema,
        &physical_models,
        model_id,
        as_of,
        VisibleRecordReadOptions {
            record_id_filter: Some(VisibleRecordIdFilter::One(record_id)),
            ..VisibleRecordReadOptions::default()
        },
    )?;
    tx.commit()?;
    Ok(records.into_iter().next())
}

pub fn read_visible_record_for_update_in_transaction(
    tx: &mut impl GenericClient,
    app_id: &AppId,
    customer_id: &CustomerId,
    model_id: &ModelId,
    record_id: &RecordId,
    as_of: NaiveDate,
) -> Result<Option<VisibleRecord>, DbError> {
    ensure_caller_owned_transaction(tx)?;
    lock_schema_activation_reader(tx, app_id, customer_id)?;
    drop_current_session_temp_views(tx)?;
    assert_native_policy_supported(tx, app_id, customer_id)?;
    let (_, schema) = active_schema(&mut *tx, app_id, customer_id)?;
    let physical_models = physical_models(&schema)?;
    let records = read_visible_records_for_model(
        &mut *tx,
        &schema,
        &physical_models,
        model_id,
        as_of,
        VisibleRecordReadOptions {
            record_id_filter: Some(VisibleRecordIdFilter::One(record_id)),
            lock_record: true,
            ..VisibleRecordReadOptions::default()
        },
    )?;
    Ok(records.into_iter().next())
}

pub struct ReadVisibleRecordsByModelRequest<'a> {
    pub model_ids: &'a [ModelId],
    pub as_of: NaiveDate,
    pub fields_by_model: &'a BTreeMap<ModelId, BTreeSet<FieldId>>,
    pub record_ids_by_model: Option<&'a BTreeMap<ModelId, BTreeSet<RecordId>>>,
    pub limit_per_model: Option<usize>,
}

pub fn read_visible_records_by_model(
    client: &mut Client,
    app_id: &AppId,
    customer_id: &CustomerId,
    request: ReadVisibleRecordsByModelRequest<'_>,
) -> Result<BTreeMap<ModelId, Vec<VisibleRecord>>, DbError> {
    let mut tx = tenant_transaction(client, app_id, customer_id)?;
    let (_, schema) = active_schema(&mut tx, app_id, customer_id)?;
    let physical_models = physical_models(&schema)?;
    let mut records_by_model = BTreeMap::new();
    for model_id in request.model_ids {
        let records = read_visible_records_for_model(
            &mut tx,
            &schema,
            &physical_models,
            model_id,
            request.as_of,
            VisibleRecordReadOptions {
                field_projection: request.fields_by_model.get(model_id),
                record_id_filter: request
                    .record_ids_by_model
                    .and_then(|records_by_model| records_by_model.get(model_id))
                    .map(VisibleRecordIdFilter::Many),
                limit: request
                    .limit_per_model
                    .and_then(|limit| i64::try_from(limit).ok()),
                ..VisibleRecordReadOptions::default()
            },
        )?;
        records_by_model.insert(model_id.clone(), records);
    }
    tx.commit()?;
    Ok(records_by_model)
}

#[derive(Default)]
struct VisibleRecordReadOptions<'a> {
    field_projection: Option<&'a BTreeSet<FieldId>>,
    record_id_filter: Option<VisibleRecordIdFilter<'a>>,
    text_field_filters: Option<&'a BTreeMap<FieldId, String>>,
    limit: Option<i64>,
    lock_record: bool,
}

#[derive(Clone, Copy)]
enum VisibleRecordIdFilter<'a> {
    One(&'a RecordId),
    Many(&'a BTreeSet<RecordId>),
}

fn read_visible_records_for_model(
    client: &mut impl GenericClient,
    schema: &Schema,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
    model_id: &ModelId,
    as_of: NaiveDate,
    options: VisibleRecordReadOptions<'_>,
) -> Result<Vec<VisibleRecord>, DbError> {
    let model = schema
        .models
        .iter()
        .find(|model| model.id == *model_id)
        .ok_or_else(|| DbError::RecordTargetMissing {
            details: format!("model `{model_id}` is not declared in active schema"),
        })?;
    let physical_model =
        physical_models
            .get(model_id)
            .ok_or_else(|| DbError::RecordTargetMissing {
                details: format!("model `{model_id}` was not materialized"),
            })?;
    ensure_mainline_version_order_integrity(
        client,
        physical_model,
        &schema.app_id,
        &schema.customer_id,
    )?;

    let projected_field_columns =
        model_field_columns_for_projection(model, physical_models, options.field_projection)?;
    let select_columns = projected_field_columns
        .iter()
        .flat_map(|(_, columns)| columns.iter())
        .map(|column| column.select_sql("v"))
        .collect::<Vec<_>>();
    let mut select_sql =
        "r.id, v.id, r.external_key, v.effective_start, v.effective_end, v.custom_fields"
            .to_string();
    if !select_columns.is_empty() {
        select_sql.push_str(", ");
        select_sql.push_str(&select_columns.join(", "));
    }
    let record_filter_sql = if options.record_id_filter.is_some() {
        "          and r.id = any($4)\n"
    } else {
        ""
    };
    let mut next_parameter = if options.record_id_filter.is_some() {
        5
    } else {
        4
    };
    let mut text_filter_values = Vec::new();
    let mut text_filter_sql = String::new();
    if let Some(filters) = options.text_field_filters {
        for (field_id, value) in filters {
            let field = model
                .fields
                .iter()
                .find(|field| field.id == *field_id)
                .ok_or_else(|| DbError::RecordTargetMissing {
                    details: format!("field `{field_id}` is not declared on model `{}`", model.id),
                })?;
            if !matches!(
                field.field_type,
                FieldType::Text | FieldType::IsoCountry | FieldType::IsoCurrency
            ) {
                return Err(DbError::RecordTargetMissing {
                    details: format!(
                        "field `{field_id}` on model `{}` is not a text field",
                        model.id
                    ),
                });
            }
            let columns = field_columns(field, physical_models)?;
            let [column] = columns.as_slice() else {
                return Err(DbError::SchemaDrift {
                    object: format!("{}.{}", model.id, field.id),
                    details: "text field did not materialize to one SQL column".to_string(),
                });
            };
            text_filter_sql.push_str(&format!(
                "          and v.{} = ${next_parameter}\n",
                quote_identifier(&column.name)
            ));
            text_filter_values.push(value);
            next_parameter += 1;
        }
    }
    let lock_sql = if options.lock_record {
        "        for update of r\n"
    } else {
        ""
    };
    let limit_sql = options
        .limit
        .map(|_| format!("        limit ${next_parameter}\n"))
        .unwrap_or_default();
    let precedence = version_precedence_sql("v", "cs", VersionOrderDirection::Descending, false);
    let sql = format!(
        r#"
        select {select_sql}
        from {} r
        join lateral (
          select v.*
          from {} v
          join change_set cs
            on cs.id = v.change_set_id
           and cs.app_id = v.app_id
           and cs.customer_id = v.customer_id
           and cs.status = 'mainline'
           and cs.applied_order is not null
          where v.record_id = r.id
            and v.app_id = r.app_id
            and v.customer_id = r.customer_id
            and v.stage = 'mainline'
            and v.effective_start <= $3
            and (v.effective_end is null or v.effective_end >= $3)
          order by
            {precedence}
          limit 1
        ) v on true
        where r.app_id = $1
          and r.customer_id = $2
{record_filter_sql}
{text_filter_sql}
          and not v.tombstones_record
          and not v.untombstones_record
        order by r.external_key nulls last, r.id
{limit_sql}
{lock_sql}
        "#,
        quote_identifier(&physical_model.record_table),
        quote_identifier(&physical_model.version_table)
    );
    let app_id = schema.app_id.as_str();
    let customer_id = schema.customer_id.as_str();
    let mut params: Vec<&(dyn ToSql + Sync)> = vec![&app_id, &customer_id, &as_of];
    let record_id_filter_values;
    if let Some(record_id_filter) = options.record_id_filter {
        record_id_filter_values = match record_id_filter {
            VisibleRecordIdFilter::One(record_id) => vec![*record_id],
            VisibleRecordIdFilter::Many(record_ids) => record_ids.iter().copied().collect(),
        };
        params.push(&record_id_filter_values);
    }
    params.extend(
        text_filter_values
            .into_iter()
            .map(|value| value as &(dyn ToSql + Sync)),
    );
    let limit_value = options.limit;
    if let Some(limit) = limit_value.as_ref() {
        params.push(limit);
    }
    let rows = client.query(&sql, &params)?;
    let mut records = Vec::with_capacity(rows.len());
    for row in rows {
        let mut values = BTreeMap::new();
        let custom_fields = custom_fields_from_json_for_schema(schema, model_id, row.get(5))?;
        let mut offset = 6;
        for (field, columns) in &projected_field_columns {
            if let Some(value) = field_value_from_row(&row, offset, field, columns)? {
                values.insert(field.id.clone(), value);
            }
            offset += columns.len();
        }
        records.push(VisibleRecord {
            record_id: row.get(0),
            version_id: Some(row.get(1)),
            external_key: row.get(2),
            effective_start: row.get(3),
            effective_end: row.get(4),
            values,
            custom_fields,
            metadata: Map::new(),
            many_relations: BTreeMap::new(),
            availability: None,
        });
    }
    Ok(records)
}

pub fn query_visible_sql(
    client: &mut Client,
    request: &QueryVisibleSql,
) -> Result<QueryResult, DbError> {
    // Apps that install from a generated SQL bundle never run kernel
    // `materialize_schema`, which is otherwise the only creator of this role.
    ensure_query_role_exists(client)?;
    // Query views are session-scoped even though their defining transaction is
    // request-scoped. Always clean them up after that transaction resolves so
    // no later kernel operation on this client can resolve a canonical table
    // name through a query-only projection.
    let result = query_visible_sql_transaction(client, request);
    let cleanup = drop_current_session_temp_views(client);
    match result {
        Ok(result) => {
            cleanup?;
            Ok(result)
        }
        Err(error) => {
            // Preserve the query error while still making a best effort to
            // remove views restored by a transaction rollback.
            let _ = cleanup;
            Err(error)
        }
    }
}

fn query_visible_sql_transaction(
    client: &mut Client,
    request: &QueryVisibleSql,
) -> Result<QueryResult, DbError> {
    let mut tx = tenant_transaction(client, &request.app_id, &request.customer_id)?;
    let (_, schema) = active_schema(&mut tx, &request.app_id, &request.customer_id)?;
    let physical_models = physical_models(&schema)?;
    prepare_query_temp_views(&mut tx, request, &physical_models)?;
    bind_query_limits(&mut tx)?;
    set_query_search_path(&mut tx)?;
    tx.batch_execute(&format!("set local role {}", quote_identifier(QUERY_ROLE)))?;
    activate_query_timeout(&mut tx, request.statement_timeout_ms)?;

    let param_types = sql_param_types(&request.params);
    validate_select_sql(&mut tx, &request.sql, &param_types)?;
    let statement = tx
        .prepare_typed(&request.sql, &param_types)
        .map_err(query_preparation_error)?;
    let param_values = sql_param_values(&request.params);
    let params = param_values
        .iter()
        .map(|value| value.as_ref() as &(dyn ToSql + Sync))
        .collect::<Vec<_>>();
    let allowed_query_relations = query_relation_names(&physical_models);
    reject_catalog_access(
        &mut tx,
        &request.sql,
        &param_types,
        &params,
        &allowed_query_relations,
    )?;
    let mut seen_columns = BTreeSet::new();
    let columns = statement
        .columns()
        .iter()
        .map(|column| {
            if !seen_columns.insert(column.name().to_string()) {
                return Err(DbError::QueryRejected {
                    details: format!("duplicate result column `{}`", column.name()),
                });
            }
            Ok(QueryColumn {
                name: column.name().to_string(),
                type_name: column.type_().name().to_string(),
            })
        })
        .collect::<Result<Vec<_>, DbError>>()?;
    let execution_sql = format!(
        "select to_jsonb(kernel_query_result) as row_json from ({}) kernel_query_result",
        request.sql
    );
    let execution_statement = tx
        .prepare_typed(&execution_sql, &param_types)
        .map_err(query_preparation_error)?;
    let rows = match tx.query(&execution_statement, &params) {
        Ok(rows) => rows,
        Err(error) if error.code() == Some(&SqlState::QUERY_CANCELED) => {
            return Err(DbError::QueryTimeout {
                details: "statement_timeout cancelled the query".to_string(),
            })
        }
        Err(error) if error.code() == Some(&SqlState::INSUFFICIENT_PRIVILEGE) => {
            return Err(DbError::QueryRejected {
                details: format!("query role lacks permission: {error}"),
            })
        }
        Err(error) => return Err(DbError::Postgres(error)),
    };
    let json_rows = rows
        .iter()
        .map(|row| row_to_json_values(row, &columns))
        .collect::<Result<Vec<_>, DbError>>()?;
    tx.commit()?;
    Ok(QueryResult {
        columns,
        rows: json_rows,
    })
}

pub fn change_set_diff(
    client: &mut Client,
    request: &ChangeSetDiffRequest,
) -> Result<ChangeSetDiff, DbError> {
    let mut tx = tenant_transaction(client, &request.app_id, &request.customer_id)?;
    let (schema_revision_id, source_change_set_id) = diff_source_change_set(&mut tx, request)?;
    let schema = schema_by_revision(
        &mut tx,
        &request.app_id,
        &request.customer_id,
        schema_revision_id,
    )?;
    let (_, current_schema) = active_schema(&mut tx, &request.app_id, &request.customer_id)?;
    let physical_models = physical_models(&schema)?;
    let projection = request.project.iter().cloned().collect::<BTreeSet<_>>();
    let is_revert_diff = source_change_set_id != request.change_set_id;
    let mut records = Vec::new();
    for model in &schema.models {
        let physical_model = physical_models
            .get(&model.id)
            .expect("model was materialized");
        let version_rows = load_history_version_rows_for_model(
            &mut tx,
            source_change_set_id,
            &schema,
            model,
            physical_model,
            &physical_models,
        )?;
        for version in version_rows {
            let previous = load_diff_predecessor(
                &mut tx,
                &request.app_id,
                &request.customer_id,
                &schema,
                model,
                &physical_models,
                &version,
            )?;
            let previous_exists = previous.is_some();
            let prior_tombstones_record = previous
                .as_ref()
                .is_some_and(|loaded| loaded.tombstones_record);
            let (previous_values, previous_custom_fields) = previous
                .map(|loaded| (loaded.values, loaded.custom_fields))
                .unwrap_or_default();
            let (
                before_values,
                after_values,
                before_custom_fields,
                after_custom_fields,
                before_tombstones_record,
                after_tombstones_record,
                before_untombstones_record,
                after_untombstones_record,
            ) = if is_revert_diff {
                (
                    version.values.clone(),
                    previous_values,
                    version.custom_fields.clone(),
                    previous_custom_fields,
                    version.tombstones_record,
                    prior_tombstones_record || (!previous_exists && !version.tombstones_record),
                    version.untombstones_record,
                    false,
                )
            } else {
                (
                    previous_values,
                    version.values.clone(),
                    previous_custom_fields,
                    version.custom_fields.clone(),
                    prior_tombstones_record,
                    version.tombstones_record,
                    false,
                    version.untombstones_record,
                )
            };
            let mut fields = Vec::new();
            for field in &model.fields {
                if !projection.is_empty() && !projection.contains(&field.id) {
                    continue;
                }
                let before = before_values.get(&field.id).cloned();
                let after = after_values.get(&field.id).cloned();
                if before != after {
                    let before_enum = enum_audit_hydrated_value(
                        &current_schema,
                        &schema,
                        &model.id,
                        &field.id,
                        field_value_enum_option(before.as_ref()),
                        schema_revision_id,
                    )?;
                    let after_enum = enum_audit_hydrated_value(
                        &current_schema,
                        &schema,
                        &model.id,
                        &field.id,
                        field_value_enum_option(after.as_ref()),
                        schema_revision_id,
                    )?;
                    fields.push(FieldDiff {
                        field_id: field.id.clone(),
                        before,
                        after,
                        before_enum,
                        after_enum,
                    });
                }
            }
            let before_custom_values = custom_field_values_by_field_id(before_custom_fields);
            let after_custom_values = custom_field_values_by_field_id(after_custom_fields);
            let custom_field_ids = before_custom_values
                .keys()
                .chain(after_custom_values.keys())
                .cloned()
                .collect::<BTreeSet<_>>();
            let mut custom_fields = Vec::new();
            for field_id in custom_field_ids {
                if !projection.is_empty() && !projection.contains(&field_id) {
                    continue;
                }
                let before = before_custom_values.get(&field_id).cloned();
                let after = after_custom_values.get(&field_id).cloned();
                if before != after {
                    let before_enum = enum_audit_hydrated_value(
                        &current_schema,
                        &schema,
                        &model.id,
                        &field_id,
                        custom_field_value_enum_option(before.as_ref()),
                        schema_revision_id,
                    )?;
                    let after_enum = enum_audit_hydrated_value(
                        &current_schema,
                        &schema,
                        &model.id,
                        &field_id,
                        custom_field_value_enum_option(after.as_ref()),
                        schema_revision_id,
                    )?;
                    custom_fields.push(CustomFieldDiff {
                        field_id,
                        before,
                        after,
                        before_enum,
                        after_enum,
                    });
                }
            }
            records.push(RecordDiff {
                model_id: model.id.clone(),
                record_id: version.record_id,
                external_key: version.external_key,
                version_id: version.version_id,
                change_set_id: version.change_set_id,
                stage: version.stage,
                effective_start: version.effective_start,
                effective_end: version.effective_end,
                before_tombstones_record,
                after_tombstones_record,
                before_untombstones_record,
                after_untombstones_record,
                fields,
                custom_fields,
            });
        }
    }
    records.sort_by(|left, right| {
        left.model_id
            .cmp(&right.model_id)
            .then(left.effective_start.cmp(&right.effective_start))
            .then(left.record_id.cmp(&right.record_id))
            .then(
                (left.before_tombstones_record || left.after_tombstones_record)
                    .cmp(&(right.before_tombstones_record || right.after_tombstones_record)),
            )
            .then(
                (left.before_untombstones_record || left.after_untombstones_record)
                    .cmp(&(right.before_untombstones_record || right.after_untombstones_record)),
            )
            .then(left.version_id.cmp(&right.version_id))
    });
    tx.commit()?;
    Ok(ChangeSetDiff {
        change_set_id: request.change_set_id,
        source_change_set_id,
        records,
    })
}

fn field_value_enum_option(value: Option<&FieldValue>) -> Option<&EnumOptionId> {
    match value {
        Some(FieldValue::Enum(option_id)) => Some(option_id),
        _ => None,
    }
}

fn custom_field_value_enum_option(value: Option<&CustomFieldValue>) -> Option<&EnumOptionId> {
    match value {
        Some(CustomFieldValue::Enum(option_id)) => Some(option_id),
        _ => None,
    }
}

fn enum_option_set_for_audit<'a>(
    schema: &'a Schema,
    model_id: &ModelId,
    field_id: &FieldId,
) -> Result<Option<&'a [EnumOption]>, DbError> {
    let declared = schema
        .models
        .iter()
        .find(|model| model.id == *model_id)
        .and_then(|model| model.fields.iter().find(|field| field.id == *field_id))
        .filter(|field| matches!(field.field_type, FieldType::Enum))
        .map(|field| field.option_set.as_slice());
    let custom = schema
        .custom_fields
        .iter()
        .find(|definition| {
            definition.model_id == *model_id
                && definition.field_id == *field_id
                && matches!(definition.field_type, CustomFieldType::Enum)
        })
        .map(|definition| definition.option_set.as_slice());
    match (declared, custom) {
        (Some(_), Some(_)) => Err(DbError::SchemaDrift {
            object: "enum".to_string(),
            details: format!("schema declares `{model_id}`.`{field_id}` more than once"),
        }),
        (Some(options), None) | (None, Some(options)) => Ok(Some(options)),
        (None, None) => Ok(None),
    }
}

fn enum_audit_hydrated_value(
    current_schema: &Schema,
    event_schema: &Schema,
    model_id: &ModelId,
    field_id: &FieldId,
    option_id: Option<&EnumOptionId>,
    event_schema_revision_id: SchemaRevisionId,
) -> Result<Option<EnumAuditHydratedValue>, DbError> {
    let Some(option_id) = option_id else {
        return Ok(None);
    };
    let event_options = enum_option_set_for_audit(event_schema, model_id, field_id)?.ok_or_else(|| {
        DbError::SchemaDrift {
            object: "enum".to_string(),
            details: format!(
                "enum field `{model_id}`.`{field_id}` is not declared in pinned schema revision `{}`",
                event_schema_revision_id.get()
            ),
        }
    })?;
    let event_option = event_options
        .iter()
        .find(|option| option.id == *option_id)
        .ok_or_else(|| DbError::SchemaDrift {
            object: "enum".to_string(),
            details: format!(
                "enum option `{option_id}` is not declared for `{model_id}`.`{field_id}` in pinned schema revision `{}`",
                event_schema_revision_id.get()
            ),
        })?;
    let current_label = enum_option_set_for_audit(current_schema, model_id, field_id)?
        .and_then(|options| options.iter().find(|option| option.id == *option_id))
        .map(|option| option.label.clone());
    Ok(Some(EnumAuditHydratedValue {
        option_id: option_id.clone(),
        event_schema_revision_id,
        current_label,
        event_label: event_option.label.clone(),
    }))
}

pub fn field_history(
    client: &mut Client,
    request: &FieldHistoryRequest,
) -> Result<Vec<FieldHistoryEntry>, DbError> {
    let mut tx = tenant_transaction(client, &request.app_id, &request.customer_id)?;
    let (_, schema) = active_schema(&mut tx, &request.app_id, &request.customer_id)?;
    let physical_models = physical_models(&schema)?;
    let model = schema
        .models
        .iter()
        .find(|model| model.id == request.model_id)
        .ok_or_else(|| DbError::RecordTargetMissing {
            details: format!(
                "model `{}` is not declared in active schema",
                request.model_id
            ),
        })?;
    let physical_model =
        physical_models
            .get(&request.model_id)
            .ok_or_else(|| DbError::RecordTargetMissing {
                details: format!("model `{}` was not materialized", request.model_id),
            })?;
    ensure_mainline_version_order_integrity(
        &mut tx,
        physical_model,
        &request.app_id,
        &request.customer_id,
    )?;
    let fields = if let Some(field_id) = &request.field_id {
        vec![model
            .fields
            .iter()
            .find(|field| field.id == *field_id)
            .ok_or_else(|| DbError::RecordTargetMissing {
                details: format!(
                    "field `{field_id}` is not declared on model `{}`",
                    request.model_id
                ),
            })?]
    } else {
        model.fields.iter().collect::<Vec<_>>()
    };
    let stages = requested_stage_strings(&request.stages);
    let field_columns = model_field_columns(model, &physical_models)?;
    let select_columns = field_columns
        .iter()
        .flat_map(|(_, columns)| columns.iter())
        .map(|column| column.select_sql("v"))
        .collect::<Vec<_>>();
    let mut select_sql = r#"
        v.id,
        v.change_set_id,
        v.stage,
        v.effective_start,
        v.effective_end,
        (
          select revert_cs.id
          from change_set revert_cs
          where revert_cs.app_id = v.app_id
            and revert_cs.customer_id = v.customer_id
            and revert_cs.status = 'mainline'
            and revert_cs.applied_order is not null
            and revert_cs.source_kind = 'revert'
            and revert_cs.source_ref = v.change_set_id::text
          order by revert_cs.applied_order desc, revert_cs.id desc
          limit 1
        ) as reverted_by,
        selected.schema_revision_id,
        v.tombstones_record,
        v.untombstones_record,
        event_cs.actor_id,
        event_cs.source_kind,
        event_cs.source_ref,
        event_cs.notes,
        event_cs.applied_at as change_set_applied_at
    "#
    .to_string();
    if !select_columns.is_empty() {
        select_sql.push_str(", ");
        select_sql.push_str(&select_columns.join(", "));
    }
    let limit = effective_field_history_version_limit(request.limit);
    let rows = tx.query(
        &format!(
            r#"
            with eligible_snapshots as (
              select
                v.change_set_id,
                v.effective_start,
                cs.schema_revision_id,
                bool_or(v.tombstones_record) as tombstones_record,
                bool_or(v.untombstones_record) as untombstones_record,
                case
                  when v.stage in ('mainline', 'reverted') then cs.applied_order
                  else cs.created_order
                end as causal_order
              from {} v
              join change_set cs
                on cs.id = v.change_set_id
               and cs.app_id = v.app_id
               and cs.customer_id = v.customer_id
              where v.record_id = $1
                and v.app_id = $2
                and v.customer_id = $3
                and v.stage = any($4)
                and ($5::date is null or v.effective_start <= $5)
                and (
                  (v.stage in ('mainline', 'reverted') and cs.status = 'mainline' and cs.applied_order is not null)
                  or (v.stage = 'draft' and cs.status = 'draft' and cs.applied_order is null)
                  or (v.stage = 'discarded' and cs.status = 'discarded' and cs.applied_order is null)
                )
              group by
                v.change_set_id,
                v.effective_start,
                v.stage,
                cs.schema_revision_id,
                cs.applied_order,
                cs.created_order
            ),
            selected_snapshots as (
              select *
              from eligible_snapshots
              order by
                effective_start desc,
                tombstones_record desc,
                untombstones_record desc,
                causal_order desc
              limit $6
            )
            select {select_sql}
            from selected_snapshots selected
            join {} v
              on v.change_set_id = selected.change_set_id
             and v.effective_start = selected.effective_start
             and v.record_id = $1
             and v.app_id = $2
             and v.customer_id = $3
             and v.stage = any($4)
            join change_set event_cs
              on event_cs.id = v.change_set_id
             and event_cs.app_id = v.app_id
             and event_cs.customer_id = v.customer_id
            order by
              selected.effective_start,
              selected.tombstones_record,
              selected.untombstones_record,
              selected.causal_order,
              v.tombstones_record,
              v.untombstones_record,
              v.id
            "#,
            quote_identifier(&physical_model.version_table),
            quote_identifier(&physical_model.version_table)
        ),
        &[
            &request.record_id,
            &request.app_id.as_str(),
            &request.customer_id.as_str(),
            &stages,
            &request.as_of,
            &limit,
        ],
    )?;
    let mut entries = Vec::new();
    let mut event_schemas = BTreeMap::new();
    for row in rows {
        let version_id = row.get("id");
        let change_set_id = row.get("change_set_id");
        let stage = version_stage_from_str(row.get::<_, String>("stage").as_str())?;
        let effective_start = row.get("effective_start");
        let effective_end = row.get("effective_end");
        let reverted_by = row.get("reverted_by");
        let event_schema_revision_id = SchemaRevisionId::new(row.get("schema_revision_id"));
        let tombstones_record: bool = row.get("tombstones_record");
        let untombstones_record: bool = row.get("untombstones_record");
        let actor_id: Option<String> = row.get("actor_id");
        let source_kind: String = row.get("source_kind");
        let source_ref: Option<String> = row.get("source_ref");
        let notes: Option<String> = row.get("notes");
        let applied_at: Option<DateTime<Utc>> = row.get("change_set_applied_at");
        if let std::collections::btree_map::Entry::Vacant(entry) =
            event_schemas.entry(event_schema_revision_id)
        {
            let event_schema = schema_by_revision(
                &mut tx,
                &request.app_id,
                &request.customer_id,
                event_schema_revision_id,
            )
            .map_err(|error| match error {
                DbError::ActiveSchemaMissing { .. } => DbError::SchemaDrift {
                    object: "change_set".to_string(),
                    details: format!(
                        "change_set `{change_set_id}` pins missing schema revision `{}`",
                        event_schema_revision_id.get()
                    ),
                },
                error => error,
            })?;
            entry.insert(event_schema);
        }
        let event_schema = event_schemas
            .get(&event_schema_revision_id)
            .expect("event schema was inserted");
        let mut values = BTreeMap::new();
        let mut offset = 14;
        for (field, columns) in &field_columns {
            if let Some(value) = field_value_from_row(&row, offset, field, columns)? {
                values.insert(field.id.clone(), value);
            }
            offset += columns.len();
        }
        for field in &fields {
            let value = values.get(&field.id).cloned();
            let enum_value = enum_audit_hydrated_value(
                &schema,
                event_schema,
                &model.id,
                &field.id,
                field_value_enum_option(value.as_ref()),
                event_schema_revision_id,
            )?;
            entries.push(FieldHistoryEntry {
                version_id,
                change_set_id,
                stage: stage.clone(),
                effective_start,
                effective_end,
                field_id: field.id.clone(),
                value,
                reverted_by,
                enum_value,
                withheld: false,
                tombstones_record,
                untombstones_record,
                actor_id: actor_id.clone(),
                source_kind: source_kind.clone(),
                source_ref: source_ref.clone(),
                applied_at,
                notes: notes.clone(),
            });
        }
    }
    tx.commit()?;
    Ok(entries)
}

fn effective_field_history_version_limit(limit: Option<i64>) -> i64 {
    limit
        .unwrap_or(MAX_FIELD_HISTORY_VERSION_LIMIT)
        .clamp(1, MAX_FIELD_HISTORY_VERSION_LIMIT)
}

pub fn recent_activity(
    client: &mut Client,
    request: &RecentActivityRequest,
) -> Result<Vec<RecentActivityEntry>, DbError> {
    let mut tx = tenant_transaction(client, &request.app_id, &request.customer_id)?;
    let (_, schema) = active_schema(&mut tx, &request.app_id, &request.customer_id)?;
    let physical_models = physical_models(&schema)?;
    let statuses = requested_status_strings(&request.statuses);
    let limit = request.limit.unwrap_or(50).clamp(1, 100);
    let source_kinds = request.source_kinds.clone();
    let rows = tx.query(
        r#"
        select id, status, actor_id, source_kind, source_ref, change_type_id, notes, created_at, applied_at
        from change_set
        where app_id = $1
          and customer_id = $2
          and status = any($3)
          and (cardinality($4::text[]) = 0 or source_kind = any($4))
        order by
          case when status = 'mainline' then applied_order else created_order end desc,
          id desc
        limit $5
        "#,
        &[
            &request.app_id.as_str(),
            &request.customer_id.as_str(),
            &statuses,
            &source_kinds,
            &limit,
        ],
    )?;
    let mut entries = Vec::new();
    for row in rows {
        let change_set_id = row.get("id");
        let source_kind: String = row.get("source_kind");
        let source_ref: Option<String> = row.get("source_ref");
        let touched_record_count = touched_record_count(
            &mut tx,
            &request.app_id,
            &request.customer_id,
            &physical_models,
            change_set_id,
            source_kind.as_str(),
            source_ref.as_deref(),
        )?;
        entries.push(RecentActivityEntry {
            change_set_id,
            status: change_set_status_from_str(row.get::<_, String>("status").as_str())?,
            actor_id: row.get("actor_id"),
            source_kind,
            source_ref,
            change_type_id: row
                .get::<_, Option<String>>("change_type_id")
                .map(ChangeTypeId::from),
            notes: row.get("notes"),
            created_at: row.get("created_at"),
            applied_at: row.get("applied_at"),
            touched_record_count,
        });
    }
    tx.commit()?;
    Ok(entries)
}

fn bind_query_limits(client: &mut impl GenericClient) -> Result<(), DbError> {
    client.batch_execute("set local transaction_read_only = on;")?;
    client.query_one(
        "select set_config('work_mem', $1, true)",
        &[&QUERY_WORK_MEM],
    )?;
    Ok(())
}

fn activate_query_timeout(
    client: &mut impl GenericClient,
    statement_timeout_ms: Option<u64>,
) -> Result<(), DbError> {
    let timeout_ms = statement_timeout_ms
        .unwrap_or(DEFAULT_QUERY_TIMEOUT_MS)
        .clamp(1, MAX_QUERY_TIMEOUT_MS);
    client.query_one(
        "select set_config('statement_timeout', $1, true)",
        &[&format!("{timeout_ms}ms")],
    )?;
    Ok(())
}

fn set_query_search_path(client: &mut impl GenericClient) -> Result<(), DbError> {
    client.batch_execute("set local search_path to pg_temp, pg_catalog;")?;
    Ok(())
}

fn prepare_query_temp_views(
    client: &mut impl GenericClient,
    request: &QueryVisibleSql,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
) -> Result<(), DbError> {
    drop_current_session_temp_views(client)?;
    let schema_name: String = client.query_one("select current_schema()", &[])?.get(0);
    let schema = quote_identifier(&schema_name);
    let app_id = quote_literal(request.app_id.as_str());
    let customer_id = quote_literal(request.customer_id.as_str());
    let role = quote_identifier(QUERY_ROLE);
    client.batch_execute(&format!(
        r#"
        create or replace temp view change_set as
          select *
          from {schema}.change_set
          where app_id = {app_id} and customer_id = {customer_id};
        grant select on pg_temp.change_set to {role};
        "#
    ))?;
    for physical_model in physical_models.values() {
        // Generated installers store tenant-managed lookups on shared lookup
        // tables. Skip dedicated `{model}_version` projections that were never
        // created so a query against materialized entity tables can still run.
        if !table_exists(client, &physical_model.version_table)? {
            continue;
        }
        ensure_mainline_version_order_integrity(
            client,
            physical_model,
            &request.app_id,
            &request.customer_id,
        )?;
        let record_table = quote_identifier(&physical_model.record_table);
        let version_table = quote_identifier(&physical_model.version_table);
        if let Some(as_of) = request.as_of {
            let as_of = quote_literal(&as_of.to_string());
            let precedence =
                version_precedence_sql("v", "cs", VersionOrderDirection::Descending, false);
            // Keep this as-of visibility predicate in sync with
            // record_visibility and relation_target_visibility below. SQL
            // analysis, apply-time record targeting, and relation checks must
            // agree on which mainline version is visible.
            client.batch_execute(&format!(
                r#"
                create or replace temp view {record_table} as
                  with visible_version as (
                    select distinct on (v.record_id) v.*
                    from {schema}.{version_table} v
                    join {schema}.change_set cs
                      on cs.id = v.change_set_id
                     and cs.app_id = v.app_id
                     and cs.customer_id = v.customer_id
                     and cs.status = 'mainline'
                     and cs.applied_order is not null
                    where v.app_id = {app_id}
                      and v.customer_id = {customer_id}
                      and v.stage = 'mainline'
                      and v.effective_start <= {as_of}
                      and (v.effective_end is null or v.effective_end >= {as_of})
                    order by
                      v.record_id,
                      {precedence}
                  )
                  select record.*
                  from {schema}.{record_table} record
                  join visible_version
                    on visible_version.record_id = record.id
                  where record.app_id = {app_id}
                    and record.customer_id = {customer_id}
                    and not visible_version.tombstones_record
                    and not visible_version.untombstones_record;
                grant select on pg_temp.{record_table} to {role};

                create or replace temp view {version_table} as
                  select *
                  from (
                    select distinct on (v.record_id) v.*
                    from {schema}.{version_table} v
                    join {schema}.change_set cs
                      on cs.id = v.change_set_id
                     and cs.app_id = v.app_id
                     and cs.customer_id = v.customer_id
                     and cs.status = 'mainline'
                     and cs.applied_order is not null
                    where v.app_id = {app_id}
                      and v.customer_id = {customer_id}
                      and v.stage = 'mainline'
                      and v.effective_start <= {as_of}
                      and (v.effective_end is null or v.effective_end >= {as_of})
                    order by
                      v.record_id,
                      {precedence}
                  ) visible_version
                  where not tombstones_record
                    and not untombstones_record;
                grant select on pg_temp.{version_table} to {role};
                "#
            ))?;
        } else {
            client.batch_execute(&format!(
                r#"
                create or replace temp view {record_table} as
                  select *
                  from {schema}.{record_table}
                  where app_id = {app_id} and customer_id = {customer_id};
                grant select on pg_temp.{record_table} to {role};

                create or replace temp view {version_table} as
                  select *
                  from {schema}.{version_table}
                  where app_id = {app_id} and customer_id = {customer_id};
                grant select on pg_temp.{version_table} to {role};
                "#
            ))?;
        }
    }
    Ok(())
}

fn drop_current_session_temp_views(client: &mut impl GenericClient) -> Result<(), DbError> {
    // The SQL workbench and internal kernel transactions own the session
    // temp-view namespace at their respective boundaries.
    let rows = client.query(
        r#"
        select n.nspname, c.relname
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where c.relkind = 'v'
          and c.relnamespace = pg_my_temp_schema()
        "#,
        &[],
    )?;
    for row in rows {
        let schema_name: String = row.get(0);
        let view_name: String = row.get(1);
        client.batch_execute(&format!(
            "drop view if exists {}.{} cascade",
            quote_identifier(&schema_name),
            quote_identifier(&view_name)
        ))?;
    }
    Ok(())
}

fn validate_select_sql(
    client: &mut impl GenericClient,
    sql: &str,
    param_types: &[Type],
) -> Result<(), DbError> {
    if sql.trim().is_empty() {
        return Err(DbError::QueryRejected {
            details: "SQL must not be empty".to_string(),
        });
    }
    reject_forbidden_query_functions(sql)?;
    let probe_sql = format!("select * from ({sql}) kernel_query_probe where false");
    client
        .prepare_typed(&probe_sql, param_types)
        .map(|_| ())
        .map_err(|error| {
            if query_was_cancelled(error.code()) {
                DbError::QueryTimeout {
                    details: "statement_timeout cancelled query validation".to_string(),
                }
            } else {
                DbError::QueryRejected {
                    details: format!("SQL must be one SELECT statement: {error}"),
                }
            }
        })
}

fn query_preparation_error(error: postgres::Error) -> DbError {
    if query_was_cancelled(error.code()) {
        DbError::QueryTimeout {
            details: "statement_timeout cancelled query preparation".to_string(),
        }
    } else {
        DbError::Postgres(error)
    }
}

fn query_was_cancelled(code: Option<&SqlState>) -> bool {
    code == Some(&SqlState::QUERY_CANCELED)
}

fn reject_forbidden_query_functions(sql: &str) -> Result<(), DbError> {
    let lowered = sql.to_ascii_lowercase();
    if lowered.contains("set_config") {
        return Err(DbError::QueryRejected {
            details: "SQL must not call set_config".to_string(),
        });
    }
    Ok(())
}

fn reject_catalog_access(
    client: &mut impl GenericClient,
    sql: &str,
    param_types: &[Type],
    params: &[&(dyn ToSql + Sync)],
    allowed_query_relations: &BTreeSet<String>,
) -> Result<(), DbError> {
    let explain_sql = format!("explain (format json) {sql}");
    let statement = client
        .prepare_typed(&explain_sql, param_types)
        .map_err(|error| {
            if error.code() == Some(&SqlState::QUERY_CANCELED) {
                DbError::QueryTimeout {
                    details: "statement_timeout cancelled query planning".to_string(),
                }
            } else {
                DbError::QueryRejected {
                    details: format!("SQL could not be planned safely: {error}"),
                }
            }
        })?;
    let rows = client.query(&statement, params).map_err(|error| {
        if error.code() == Some(&SqlState::QUERY_CANCELED) {
            DbError::QueryTimeout {
                details: "statement_timeout cancelled query planning".to_string(),
            }
        } else {
            DbError::QueryRejected {
                details: format!("SQL could not be planned safely: {error}"),
            }
        }
    })?;
    for row in rows {
        let plan: Value = row.get(0);
        if plan_references_catalog(&plan, allowed_query_relations) {
            return Err(DbError::QueryRejected {
                details: "SQL must not reference Postgres catalog objects".to_string(),
            });
        }
    }
    Ok(())
}

fn query_relation_names(physical_models: &BTreeMap<ModelId, PhysicalModel>) -> BTreeSet<String> {
    let mut names = BTreeSet::from(["change_set".to_string()]);
    for physical_model in physical_models.values() {
        names.insert(physical_model.record_table.clone());
        names.insert(physical_model.version_table.clone());
    }
    names
}

fn plan_references_catalog(value: &Value, allowed_query_relations: &BTreeSet<String>) -> bool {
    match value {
        Value::Object(object) => {
            let schema = object.get("Schema").and_then(Value::as_str);
            if schema.is_some_and(|schema| schema == "pg_catalog" || schema == "information_schema")
            {
                return true;
            }
            if schema.is_none()
                && object
                    .get("Relation Name")
                    .and_then(Value::as_str)
                    .is_some_and(|relation| {
                        relation.starts_with("pg_") && !allowed_query_relations.contains(relation)
                    })
            {
                return true;
            }
            object
                .values()
                .any(|value| plan_references_catalog(value, allowed_query_relations))
        }
        Value::Array(values) => values
            .iter()
            .any(|value| plan_references_catalog(value, allowed_query_relations)),
        _ => false,
    }
}

fn quote_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn sql_param_types(params: &[SqlParam]) -> Vec<Type> {
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

fn sql_param_values(params: &[SqlParam]) -> Vec<Box<dyn ToSql + Sync>> {
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

#[derive(Debug)]
struct NumericParam(Decimal);

impl ToSql for NumericParam {
    fn to_sql(
        &self,
        ty: &Type,
        out: &mut BytesMut,
    ) -> Result<IsNull, Box<dyn StdError + Sync + Send>> {
        if !Self::accepts(ty) {
            return Err(format!("NumericParam cannot encode postgres type {}", ty.name()).into());
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

    postgres_types::to_sql_checked!();
}

fn row_to_json_values(row: &Row, columns: &[QueryColumn]) -> Result<Vec<Value>, DbError> {
    let value: Value = row.get("row_json");
    let object = value.as_object().ok_or_else(|| DbError::QueryRejected {
        details: "query row did not serialize as a JSON object".to_string(),
    })?;
    Ok(columns
        .iter()
        .map(|column| object.get(&column.name).cloned().unwrap_or(Value::Null))
        .collect())
}

fn set_tenant_scope(
    client: &mut impl GenericClient,
    app_id: &AppId,
    customer_id: &CustomerId,
) -> Result<(), DbError> {
    client.query_one(
        "select set_config('platform.app_id', $1, true)",
        &[&app_id.as_str()],
    )?;
    client.query_one(
        "select set_config('platform.customer_id', $1, true)",
        &[&customer_id.as_str()],
    )?;
    Ok(())
}

fn tenant_transaction<'a>(
    client: &'a mut Client,
    app_id: &AppId,
    customer_id: &CustomerId,
) -> Result<Transaction<'a>, DbError> {
    let mut tx = kernel_transaction(client)?;
    lock_schema_activation_reader(&mut tx, app_id, customer_id)?;
    set_tenant_scope(&mut tx, app_id, customer_id)?;
    assert_native_policy_supported(&mut tx, app_id, customer_id)?;
    Ok(tx)
}

// Native request functions do not evaluate generated field/record policies. Reject
// such revisions before reads, replay receipts, or writes; installers use their
// separate lifecycle path. Normal requests hold the activation reader lock; the
// legacy replay probe also checks this boundary before inspecting any receipt.
fn assert_native_policy_supported(
    client: &mut impl GenericClient,
    app_id: &AppId,
    customer_id: &CustomerId,
) -> Result<(), DbError> {
    let catalog = client.query_one(
        "select to_regclass(format('%I.schema_authorization_policy_expectation', current_schema())) is not null as expectation, to_regclass(format('%I.schema_authorization_policy_source', current_schema())) is not null as source, to_regclass(format('%I.schema_authorization_policy_snapshot', current_schema())) is not null as snapshot",
        &[],
    )?;
    let expectation: bool = catalog.get("expectation");
    let source: bool = catalog.get("source");
    let snapshot: bool = catalog.get("snapshot");
    let revision_catalog: bool = client
        .query_one(
            "select to_regclass(format('%I.schema_revision', current_schema())) is not null",
            &[],
        )?
        .get(0);
    let declared_policy_marker = if revision_catalog {
        client
            .query_one(
                "select exists (select 1 from schema_revision revision where revision.app_id=$1 and revision.customer_id=$2 and revision.activated_at is not null and coalesce((to_jsonb(revision)->>'authorization_policy_declared')::boolean, false))",
                &[&app_id.as_str(), &customer_id.as_str()],
            )?
            .get(0)
    } else {
        false
    };
    if !expectation && !source && !snapshot {
        if declared_policy_marker {
            return Err(DbError::SchemaDrift {
                object: "schema_authorization_policy".to_string(),
                details: "policy catalogs are missing for an active declared policy revision"
                    .to_string(),
            });
        }
        return Ok(()); // No marker means historical or pre-policy generated legacy.
    }
    if declared_policy_marker && (!expectation || !source || !snapshot) {
        return Err(DbError::SchemaDrift {
            object: "schema_authorization_policy".to_string(),
            details: "policy catalog is incomplete for an active declared policy revision"
                .to_string(),
        });
    }
    if declared_policy_marker {
        let complete_policy_artifacts: bool = client
            .query_one(
                r#"
                select exists (
                  select 1
                  from schema_revision revision
                  join schema_authorization_policy_expectation expectation
                    on expectation.app_id = revision.app_id
                   and expectation.schema_version = coalesce(revision.base_schema->>'version', revision.schema->>'version')
                  join schema_authorization_policy_source source
                    on source.app_id = revision.app_id
                   and source.schema_version = expectation.schema_version
                  join schema_authorization_policy_snapshot snapshot
                    on snapshot.schema_revision_id = revision.id
                   and snapshot.app_id = revision.app_id
                   and snapshot.customer_id = revision.customer_id
                  where revision.app_id = $1
                    and revision.customer_id = $2
                    and revision.activated_at is not null
                    and expectation.policy_declared
                    and expectation.policy_hash is not null
                    and source.policy_hash = expectation.policy_hash
                    and snapshot.policy is not null
                    and snapshot.policy_hash = expectation.policy_hash
                )
                "#,
                &[&app_id.as_str(), &customer_id.as_str()],
            )?
            .get(0);
        if !complete_policy_artifacts {
            return Err(DbError::SchemaDrift {
                object: "schema_authorization_policy".to_string(),
                details: "active declared policy marker lacks complete policy artifacts"
                    .to_string(),
            });
        }
        return Err(DbError::AuthorizationPolicyUnsupported);
    }
    if snapshot {
        let enabled: bool = client.query_one(
            "select exists (select 1 from schema_authorization_policy_snapshot snapshot join schema_revision revision on revision.id = snapshot.schema_revision_id and revision.app_id = snapshot.app_id and revision.customer_id = snapshot.customer_id where revision.app_id=$1 and revision.customer_id=$2 and revision.activated_at is not null and snapshot.policy is not null)",
            &[&app_id.as_str(), &customer_id.as_str()],
        )?.get(0);
        if enabled {
            return Err(DbError::AuthorizationPolicyUnsupported);
        }
    }
    if !expectation || !source {
        return Err(DbError::SchemaDrift {
            object: "schema_authorization_policy".to_string(),
            details: "policy catalog is incomplete".to_string(),
        });
    }
    let enabled: bool = client.query_one(
        r#"
        select exists (
          select 1 from schema_revision revision
          left join schema_authorization_policy_expectation expectation
            on expectation.app_id = revision.app_id
           and expectation.schema_version = coalesce(revision.base_schema->>'version', revision.schema->>'version')
          left join schema_authorization_policy_source source
            on source.app_id = revision.app_id
           and source.schema_version = coalesce(revision.base_schema->>'version', revision.schema->>'version')
          where revision.app_id = $1 and revision.customer_id = $2
            and revision.activated_at is not null
            and (coalesce(expectation.policy_declared, false) or source.app_id is not null)
        )
        "#,
        &[&app_id.as_str(), &customer_id.as_str()],
    )?.get(0);
    if enabled {
        return Err(DbError::AuthorizationPolicyUnsupported);
    }
    Ok(())
}

fn kernel_transaction(client: &mut Client) -> Result<Transaction<'_>, DbError> {
    // Workbench views deliberately reuse physical model/catalog names. Remove
    // every current-session temp view before internal SQL can resolve one in
    // preference to the physical relation. Run cleanup before opening the
    // transaction so its catalog locks are released before materialization
    // acquires advisory and DDL locks.
    drop_current_session_temp_views(client)?;
    Ok(client.transaction()?)
}

fn lock_idempotency_key(
    client: &mut impl GenericClient,
    apply: &ApplyChangeSet,
) -> Result<(), DbError> {
    let Some(key) = apply.idempotency_key.as_ref() else {
        return Ok(());
    };
    let lock_name = format!("idempotency:{}:{}:{key}", apply.app_id, apply.customer_id);
    client.query_one(
        "select pg_advisory_xact_lock(hashtext($1)::bigint)",
        &[&lock_name],
    )?;
    Ok(())
}

fn lock_revert_idempotency_key(
    client: &mut impl GenericClient,
    request: &RevertChangeSet,
) -> Result<(), DbError> {
    let Some(key) = request.idempotency_key.as_ref() else {
        return Ok(());
    };
    let lock_name = format!(
        "idempotency:{}:{}:{key}",
        request.app_id, request.customer_id
    );
    client.query_one(
        "select pg_advisory_xact_lock(hashtext($1)::bigint)",
        &[&lock_name],
    )?;
    Ok(())
}

fn lock_schema_materialization(client: &mut impl GenericClient) -> Result<(), DbError> {
    let scope = advisory_lock_schema_scope(client)?;
    let lock_name = format!("{scope}:{SCHEMA_MATERIALIZATION_LOCK}");
    client.query_one(
        "select pg_advisory_xact_lock(hashtext($1)::bigint)",
        &[&lock_name],
    )?;
    Ok(())
}

fn lock_schema_activation_reader(
    client: &mut impl GenericClient,
    app_id: &AppId,
    customer_id: &CustomerId,
) -> Result<(), DbError> {
    let scope = advisory_lock_schema_scope(client)?;
    let lock_name = schema_activation_lock_name(&scope, app_id, customer_id);
    client.query_one(
        "select pg_advisory_xact_lock_shared(hashtext($1)::bigint)",
        &[&lock_name],
    )?;
    Ok(())
}

fn lock_schema_activation_writer(
    client: &mut impl GenericClient,
    app_id: &AppId,
    customer_id: &CustomerId,
) -> Result<(), DbError> {
    let scope = advisory_lock_schema_scope(client)?;
    let lock_name = schema_activation_lock_name(&scope, app_id, customer_id);
    client.query_one(
        "select pg_advisory_xact_lock(hashtext($1)::bigint)",
        &[&lock_name],
    )?;
    Ok(())
}

fn advisory_lock_schema_scope(client: &mut impl GenericClient) -> Result<String, DbError> {
    let schema_name: String = client.query_one("select current_schema()", &[])?.get(0);
    Ok(format!("postgres-schema:{schema_name}"))
}

fn schema_revision_for_version(
    client: &mut impl GenericClient,
    schema: &Schema,
) -> Result<Option<SchemaRevisionId>, DbError> {
    if !table_exists(client, "schema_revision")? {
        return Ok(None);
    }

    let Some(row) = client.query_opt(
        "select id, schema from schema_revision where app_id = $1 and customer_id = $2 and version = $3",
        &[&schema.app_id.as_str(), &schema.customer_id.as_str(), &schema.version.as_str()],
    )? else {
        return Ok(None);
    };

    let schema_json = serde_json::to_value(schema).expect("schema contract serializes");
    let existing_schema: Value = row.get("schema");
    if existing_schema != schema_json {
        return Err(schema_revision_conflict(&existing_schema, &schema_json));
    }
    Ok(Some(SchemaRevisionId::new(row.get("id"))))
}

fn schema_revision_conflict(existing_schema: &Value, current_schema: &Value) -> DbError {
    DbError::SchemaRevisionConflict {
        existing_hash: schema_json_hash(existing_schema),
        current_hash: schema_json_hash(current_schema),
    }
}

pub fn schema_hash(schema: &Schema) -> String {
    let schema_json = serde_json::to_value(schema).expect("schema contract serializes");
    schema_json_hash(&schema_json)
}

fn schema_json_hash(schema_json: &Value) -> String {
    let stable_schema_json = stable_json_value(schema_json);
    let bytes = serde_json::to_vec(&stable_schema_json).expect("schema JSON serializes");
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn stable_json_value(value: &Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.iter().map(stable_json_value).collect()),
        Value::Object(entries) => Value::Object(
            entries
                .iter()
                .map(|(key, value)| (key.clone(), stable_json_value(value)))
                .collect::<BTreeMap<_, _>>()
                .into_iter()
                .collect(),
        ),
        value => value.clone(),
    }
}

fn active_schema(
    client: &mut impl GenericClient,
    app_id: &AppId,
    customer_id: &CustomerId,
) -> Result<(SchemaRevisionId, Schema), DbError> {
    let Some(row) = client.query_opt(
        r#"
        select id, schema
        from schema_revision
        where app_id = $1 and customer_id = $2 and activated_at is not null
        "#,
        &[&app_id.as_str(), &customer_id.as_str()],
    )?
    else {
        return Err(DbError::ActiveSchemaMissing {
            app_id: app_id.to_string(),
            customer_id: customer_id.to_string(),
        });
    };
    let id: i64 = row.get("id");
    let schema_json: Value = row.get("schema");
    Ok((
        SchemaRevisionId::new(id),
        serde_json::from_value(schema_json)?,
    ))
}

fn schema_by_revision(
    client: &mut impl GenericClient,
    app_id: &AppId,
    customer_id: &CustomerId,
    schema_revision_id: SchemaRevisionId,
) -> Result<Schema, DbError> {
    let Some(row) = client.query_opt(
        r#"
        select schema
        from schema_revision
        where id = $1 and app_id = $2 and customer_id = $3
        "#,
        &[
            &schema_revision_id.get(),
            &app_id.as_str(),
            &customer_id.as_str(),
        ],
    )?
    else {
        return Err(DbError::ActiveSchemaMissing {
            app_id: app_id.to_string(),
            customer_id: customer_id.to_string(),
        });
    };
    let schema_json: Value = row.get("schema");
    Ok(serde_json::from_value(schema_json)?)
}

fn change_set_revision_and_status(
    client: &mut impl GenericClient,
    app_id: &AppId,
    customer_id: &CustomerId,
    change_set_id: i64,
    lock: bool,
) -> Result<(SchemaRevisionId, String), DbError> {
    let lock_clause = if lock { " for update" } else { "" };
    let Some(row) = client.query_opt(
        &format!(
            r#"
            select schema_revision_id, status
            from change_set
            where id = $1 and app_id = $2 and customer_id = $3
            {lock_clause}
            "#
        ),
        &[&change_set_id, &app_id.as_str(), &customer_id.as_str()],
    )?
    else {
        return Err(DbError::RecordTargetMissing {
            details: format!("change_set `{change_set_id}` did not resolve"),
        });
    };
    Ok((
        SchemaRevisionId::new(row.get("schema_revision_id")),
        row.get("status"),
    ))
}

struct RevertTargetChangeSet {
    schema_revision_id: SchemaRevisionId,
    status: String,
    source_kind: String,
    applied_order: Option<i64>,
}

fn target_change_set_for_revert(
    client: &mut impl GenericClient,
    request: &RevertChangeSet,
) -> Result<RevertTargetChangeSet, DbError> {
    let Some(row) = client.query_opt(
        r#"
        select schema_revision_id, status, source_kind, applied_order
        from change_set
        where id = $1 and app_id = $2 and customer_id = $3
        for update
        "#,
        &[
            &request.change_set_id,
            &request.app_id.as_str(),
            &request.customer_id.as_str(),
        ],
    )?
    else {
        return Err(DbError::RecordTargetMissing {
            details: format!("change_set `{}` did not resolve", request.change_set_id),
        });
    };
    Ok(RevertTargetChangeSet {
        schema_revision_id: SchemaRevisionId::new(row.get("schema_revision_id")),
        status: row.get("status"),
        source_kind: row.get("source_kind"),
        applied_order: row.get("applied_order"),
    })
}

fn change_set_was_draft_request(
    client: &mut impl GenericClient,
    app_id: &AppId,
    customer_id: &CustomerId,
    change_set_id: i64,
) -> Result<bool, DbError> {
    let mode: String = client
        .query_one(
            r#"
            select created_with_mode
            from change_set
            where id = $1 and app_id = $2 and customer_id = $3
            "#,
            &[&change_set_id, &app_id.as_str(), &customer_id.as_str()],
        )?
        .get("created_with_mode");
    Ok(mode == "draft")
}

fn request_fingerprint(
    apply: &ApplyChangeSet,
    effective_schema_revision_id: SchemaRevisionId,
) -> Result<String, DbError> {
    // Idempotency identity uses canonical key-sorted JSON. Do not replace this
    // with serde_json::to_string, whose object ordering is feature-sensitive.
    canonical_json(&serde_json::json!({
        "app_id": &apply.app_id,
        "customer_id": &apply.customer_id,
        "schema_revision_id": effective_schema_revision_id.get(),
        "actor_id": &apply.actor_id,
        "source_kind": &apply.source_kind,
        "source_ref": &apply.source_ref,
        "idempotency_key": &apply.idempotency_key,
        "change_type_id": &apply.change_type_id,
        "notes": &apply.notes,
        "mode": &apply.mode,
        "writes": &apply.writes,
    }))
}

fn canonical_json(value: &Value) -> Result<String, DbError> {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {
            Ok(serde_json::to_string(value)?)
        }
        Value::Array(values) => {
            let mut output = String::from("[");
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(&canonical_json(value)?);
            }
            output.push(']');
            Ok(output)
        }
        Value::Object(object) => {
            let mut entries = object.iter().collect::<Vec<_>>();
            entries.sort_by_key(|(key, _)| *key);

            let mut output = String::from("{");
            for (index, (key, value)) in entries.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(&serde_json::to_string(key)?);
                output.push(':');
                output.push_str(&canonical_json(value)?);
            }
            output.push('}');
            Ok(output)
        }
    }
}

fn revert_request_fingerprint(
    request: &RevertChangeSet,
    schema_revision_id: SchemaRevisionId,
) -> Result<String, DbError> {
    canonical_json(&serde_json::json!({
        "app_id": &request.app_id,
        "customer_id": &request.customer_id,
        "schema_revision_id": schema_revision_id.get(),
        "actor_id": &request.actor_id,
        "source_kind": "revert",
        "source_ref": request.change_set_id.to_string(),
        "idempotency_key": &request.idempotency_key,
        "change_type_id": null,
        "notes": &request.notes,
        "mode": "mainline",
        "revert_target_change_set_id": request.change_set_id,
    }))
}

fn existing_idempotent_change_set(
    client: &mut impl GenericClient,
    apply: &ApplyChangeSet,
) -> Result<Option<AppliedChangeSet>, DbError> {
    let Some(key) = apply.idempotency_key.as_ref() else {
        return Ok(None);
    };
    let Some(row) = client.query_opt(
        r#"
        select id, schema_revision_id, request_fingerprint
        from change_set
        where app_id = $1 and customer_id = $2 and idempotency_key = $3
        "#,
        &[&apply.app_id.as_str(), &apply.customer_id.as_str(), key],
    )?
    else {
        return Ok(None);
    };
    let existing_fingerprint: Option<String> = row.get("request_fingerprint");
    let existing_revision_id: i64 = row.get("schema_revision_id");
    let existing_revision_id = SchemaRevisionId::new(existing_revision_id);
    if apply
        .schema_revision_id
        .is_some_and(|supplied| supplied != existing_revision_id)
    {
        return Err(DbError::IdempotencyConflict {
            key: key.to_string(),
        });
    }
    let request_fingerprint = request_fingerprint(apply, existing_revision_id)?;
    if existing_fingerprint.as_deref() != Some(request_fingerprint.as_str()) {
        return Err(DbError::IdempotencyConflict {
            key: key.to_string(),
        });
    }
    Ok(Some(AppliedChangeSet {
        id: row.get("id"),
        schema_revision_id: existing_revision_id,
    }))
}

fn existing_idempotent_revert_change_set(
    client: &mut impl GenericClient,
    request: &RevertChangeSet,
) -> Result<Option<AppliedChangeSet>, DbError> {
    let Some(key) = request.idempotency_key.as_ref() else {
        return Ok(None);
    };
    let Some(row) = client.query_opt(
        r#"
        select id, schema_revision_id, request_fingerprint
        from change_set
        where app_id = $1 and customer_id = $2 and idempotency_key = $3
        "#,
        &[&request.app_id.as_str(), &request.customer_id.as_str(), key],
    )?
    else {
        return Ok(None);
    };
    let existing_revision_id = SchemaRevisionId::new(row.get("schema_revision_id"));
    let request_fingerprint = revert_request_fingerprint(request, existing_revision_id)?;
    let existing_fingerprint: Option<String> = row.get("request_fingerprint");
    if existing_fingerprint.as_deref() != Some(request_fingerprint.as_str()) {
        return Err(DbError::IdempotencyConflict {
            key: key.to_string(),
        });
    }
    Ok(Some(AppliedChangeSet {
        id: row.get("id"),
        schema_revision_id: existing_revision_id,
    }))
}

fn insert_agent_run(
    client: &mut impl GenericClient,
    run: &AgentRunLedgerEntry,
    schema_revision_id: SchemaRevisionId,
) -> Result<StoredAgentRun, DbError> {
    // Insert status is caller-asserted so a run whose first durable evidence is
    // terminal (for example, a record-failed-then-retried runtime error) can be
    // recorded accurately. Later lifecycle moves use update_agent_run_status,
    // which locks the row and only transitions out of `recorded`.
    if let Some(existing) = existing_agent_run(client, run)? {
        return Ok(existing);
    }
    let source_artifacts = run.source_artifacts.clone();
    let alignment_decisions = run.alignment_decisions.clone();
    let model_calls = run.model_calls.clone();
    let tool_calls = run.tool_calls.clone();
    let token_usage = run.token_usage.clone();
    let validation_failures = run.validation_failures.clone();
    let final_outputs = run.final_outputs.clone();
    let approval_boundaries = run.approval_boundaries.clone();
    let compiled_preview_ids =
        serde_json::to_value(&run.compiled_preview_ids).expect("preview ids serialize");
    let Some(row) = client.query_opt(
        r#"
        insert into agent_run (
          app_id,
          customer_id,
          run_id,
          status,
          schema_revision_id,
          actor_id,
          agent_identity_id,
          execution_profile_id,
          source_artifacts,
          alignment_decisions,
          model_calls,
          tool_calls,
          token_usage,
          validation_failures,
          final_outputs,
          approval_boundaries,
          compiled_preview_ids
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        on conflict (app_id, customer_id, run_id) do nothing
        returning id
        "#,
        &[
            &run.app_id.as_str(),
            &run.customer_id.as_str(),
            &run.run_id,
            &run.status.as_str(),
            &schema_revision_id.get(),
            &run.actor_id,
            &run.agent_identity_id,
            &run.execution_profile_id,
            &source_artifacts,
            &alignment_decisions,
            &model_calls,
            &tool_calls,
            &token_usage,
            &validation_failures,
            &final_outputs,
            &approval_boundaries,
            &compiled_preview_ids,
        ],
    )?
    else {
        return existing_agent_run(client, run)?.ok_or_else(|| DbError::AgentRunConflict {
            details: format!(
                "agent run `{}` conflicted during insert but could not be read back",
                run.run_id
            ),
        });
    };
    Ok(StoredAgentRun {
        id: row.get("id"),
        run_id: run.run_id.clone(),
        schema_revision_id,
    })
}

fn existing_agent_run(
    client: &mut impl GenericClient,
    run: &AgentRunLedgerEntry,
) -> Result<Option<StoredAgentRun>, DbError> {
    let Some(row) = client.query_opt(
        r#"
        select
          id,
          schema_revision_id,
          actor_id,
          agent_identity_id,
          execution_profile_id,
          source_artifacts,
          alignment_decisions,
          model_calls,
          tool_calls,
          token_usage,
          validation_failures,
          final_outputs,
          approval_boundaries,
          compiled_preview_ids
        from agent_run
        where app_id = $1 and customer_id = $2 and run_id = $3
        "#,
        &[&run.app_id.as_str(), &run.customer_id.as_str(), &run.run_id],
    )?
    else {
        return Ok(None);
    };
    let existing_revision_id = SchemaRevisionId::new(row.get("schema_revision_id"));
    if let Some(supplied) = run.schema_revision_id {
        if supplied == existing_revision_id {
            return compare_existing_agent_run(run, row, existing_revision_id);
        }
        return Err(DbError::AgentRunSchemaMismatch {
            details: format!(
                "agent run `{}` was recorded against schema_revision_id `{}` not supplied schema_revision_id `{}`",
                run.run_id,
                existing_revision_id.get(),
                supplied.get()
            ),
        });
    }
    compare_existing_agent_run(run, row, existing_revision_id)
}

fn update_existing_agent_run_status(
    client: &mut impl GenericClient,
    update: &AgentRunStatusUpdate,
) -> Result<StoredAgentRun, DbError> {
    let Some(row) = client.query_opt(
        r#"
        select
          id,
          schema_revision_id,
          status,
          model_calls,
          tool_calls,
          token_usage,
          validation_failures,
          final_outputs
        from agent_run
        where app_id = $1 and customer_id = $2 and run_id = $3
        for update
        "#,
        &[
            &update.app_id.as_str(),
            &update.customer_id.as_str(),
            &update.run_id,
        ],
    )?
    else {
        return Err(DbError::AgentRunMissing {
            details: format!("agent run `{}` has not been recorded", update.run_id),
        });
    };
    let stored = StoredAgentRun {
        id: row.get("id"),
        run_id: update.run_id.clone(),
        schema_revision_id: SchemaRevisionId::new(row.get("schema_revision_id")),
    };
    let current_status: String = row.get("status");
    if current_status == update.status.as_str() {
        return Ok(stored);
    }
    if current_status != AgentRunStatus::Recorded.as_str() {
        return Err(DbError::AgentRunConflict {
            details: format!(
                "agent run `{}` is already terminal with status `{current_status}`",
                update.run_id
            ),
        });
    }
    let model_calls = merge_evidence_array(row.get("model_calls"), update.model_calls.as_ref());
    let tool_calls = merge_evidence_array(row.get("tool_calls"), update.tool_calls.as_ref());
    let token_usage = merge_evidence_object(row.get("token_usage"), update.token_usage.as_ref());
    let validation_failures = merge_evidence_array(
        row.get("validation_failures"),
        update.validation_failures.as_ref(),
    );
    let final_outputs =
        merge_evidence_object(row.get("final_outputs"), update.final_outputs.as_ref());
    client.execute(
        r#"
        update agent_run
        set
          status = $4,
          model_calls = $5,
          tool_calls = $6,
          token_usage = $7,
          validation_failures = $8,
          final_outputs = $9
        where app_id = $1 and customer_id = $2 and run_id = $3
        "#,
        &[
            &update.app_id.as_str(),
            &update.customer_id.as_str(),
            &update.run_id,
            &update.status.as_str(),
            &model_calls,
            &tool_calls,
            &token_usage,
            &validation_failures,
            &final_outputs,
        ],
    )?;
    Ok(stored)
}

fn merge_evidence_array(existing: Value, update: Option<&Value>) -> Value {
    let Some(Value::Array(update_items)) = update else {
        return existing;
    };
    match existing {
        Value::Array(mut existing_items) => {
            existing_items.extend(update_items.iter().cloned());
            Value::Array(existing_items)
        }
        other => other,
    }
}

fn merge_evidence_object(existing: Value, update: Option<&Value>) -> Value {
    let Some(Value::Object(update_entries)) = update else {
        return existing;
    };
    match existing {
        Value::Object(mut existing_entries) => {
            for (key, value) in update_entries {
                existing_entries
                    .entry(key.clone())
                    .or_insert_with(|| value.clone());
            }
            Value::Object(existing_entries)
        }
        other => other,
    }
}

fn compare_existing_agent_run(
    run: &AgentRunLedgerEntry,
    row: Row,
    existing_revision_id: SchemaRevisionId,
) -> Result<Option<StoredAgentRun>, DbError> {
    let compiled_preview_ids =
        serde_json::to_value(&run.compiled_preview_ids).expect("preview ids serialize");
    // Adding a persisted AgentRunLedgerEntry identity field must update this
    // expected list, the typed row.get dispatch below, and the replay-conflict
    // tests. `status` is intentionally excluded: it is mutable lifecycle state
    // written through update_agent_run_status, so idempotent run replay must
    // survive later terminal transitions.
    let expected_fields = [
        (
            "actor_id",
            serde_json::to_value(&run.actor_id).expect("actor id serializes"),
        ),
        (
            "agent_identity_id",
            serde_json::to_value(&run.agent_identity_id).expect("agent identity id serializes"),
        ),
        (
            "execution_profile_id",
            serde_json::to_value(&run.execution_profile_id)
                .expect("execution profile id serializes"),
        ),
        ("source_artifacts", run.source_artifacts.clone()),
        ("alignment_decisions", run.alignment_decisions.clone()),
        ("model_calls", run.model_calls.clone()),
        ("tool_calls", run.tool_calls.clone()),
        ("token_usage", run.token_usage.clone()),
        ("validation_failures", run.validation_failures.clone()),
        ("final_outputs", run.final_outputs.clone()),
        ("approval_boundaries", run.approval_boundaries.clone()),
        ("compiled_preview_ids", compiled_preview_ids),
    ];
    for (column, expected) in expected_fields {
        let actual = match column {
            "actor_id" => {
                serde_json::to_value(row.get::<_, Option<String>>(column)).expect("serializes")
            }
            "agent_identity_id" | "execution_profile_id" => {
                serde_json::to_value(row.get::<_, String>(column)).expect("serializes")
            }
            _ => row.get::<_, Value>(column),
        };
        if actual != expected {
            return Err(DbError::AgentRunConflict {
                details: format!(
                    "agent run `{}` is already recorded with different `{column}`",
                    run.run_id
                ),
            });
        }
    }
    Ok(Some(StoredAgentRun {
        id: row.get("id"),
        run_id: run.run_id.clone(),
        schema_revision_id: existing_revision_id,
    }))
}

fn validate_agent_write_provenance(
    client: &mut impl GenericClient,
    apply: &ApplyChangeSet,
    schema_revision_id: SchemaRevisionId,
) -> Result<(), DbError> {
    if apply.source_kind != AGENT_SOURCE_KIND {
        return Ok(());
    }
    let run_id = apply
        .source_ref
        .as_ref()
        .ok_or_else(|| DbError::AgentRunMissing {
            details: "agent write source_ref is missing".to_string(),
        })?;
    let row = client.query_opt(
        r#"
        select schema_revision_id
        from agent_run
        where app_id = $1 and customer_id = $2 and run_id = $3
        "#,
        &[&apply.app_id.as_str(), &apply.customer_id.as_str(), run_id],
    )?;
    let Some(row) = row else {
        return Err(DbError::AgentRunMissing {
            details: format!("agent run `{run_id}` has not been recorded"),
        });
    };
    let run_schema_revision_id = SchemaRevisionId::new(row.get("schema_revision_id"));
    if run_schema_revision_id != schema_revision_id {
        return Err(DbError::AgentRunSchemaMismatch {
            details: format!(
                "agent run `{run_id}` was recorded against schema_revision_id `{}` but active schema_revision_id is `{}`",
                run_schema_revision_id.get(),
                schema_revision_id.get()
            ),
        });
    }
    Ok(())
}

fn insert_change_set(
    client: &mut impl GenericClient,
    apply: &ApplyChangeSet,
    schema_revision_id: SchemaRevisionId,
    request_fingerprint: &str,
) -> Result<i64, DbError> {
    let (status, applied_at): (&str, Option<DateTime<Utc>>) = match apply.mode {
        ApplyMode::Mainline => ("mainline", Some(Utc::now())),
        ApplyMode::Draft => ("draft", None),
    };
    let created_order = next_change_set_order(client)?;
    let applied_order = match apply.mode {
        ApplyMode::Mainline => Some(created_order),
        ApplyMode::Draft => None,
    };
    let created_with_mode = apply_mode_string(&apply.mode);
    let row = client.query_one(
        r#"
        insert into change_set (
          app_id,
          customer_id,
          schema_revision_id,
          created_with_mode,
          status,
          actor_id,
          source_kind,
          source_ref,
          idempotency_key,
          request_fingerprint,
          change_type_id,
          notes,
          created_order,
          applied_order,
          applied_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        returning id
        "#,
        &[
            &apply.app_id.as_str(),
            &apply.customer_id.as_str(),
            &schema_revision_id.get(),
            &created_with_mode,
            &status,
            &apply.actor_id,
            &apply.source_kind,
            &apply.source_ref,
            &apply.idempotency_key,
            &request_fingerprint,
            &apply
                .change_type_id
                .as_ref()
                .map(|change_type_id| change_type_id.to_string()),
            &apply.notes,
            &created_order,
            &applied_order,
            &applied_at,
        ],
    )?;
    // Drafts land here: open review surfaces learn a draft joined the queue.
    notify_canonical(client, apply.app_id.as_str(), apply.customer_id.as_str())?;
    Ok(row.get("id"))
}

fn insert_mainline_change_set(
    client: &mut impl GenericClient,
    apply: &ApplyChangeSet,
    schema_revision_id: SchemaRevisionId,
    request_fingerprint: &str,
) -> Result<(i64, i64), DbError> {
    let applied_order = next_change_set_order(client)?;
    let row = client.query_one(
        r#"
        insert into change_set (
          app_id,
          customer_id,
          schema_revision_id,
          created_with_mode,
          status,
          actor_id,
          source_kind,
          source_ref,
          idempotency_key,
          request_fingerprint,
          change_type_id,
          notes,
          created_order,
          applied_order,
          applied_at
        )
        values ($1, $2, $3, 'mainline', 'mainline', $4, $5, $6, $7, $8, $9, $10, $11, $11, now())
        returning id
        "#,
        &[
            &apply.app_id.as_str(),
            &apply.customer_id.as_str(),
            &schema_revision_id.get(),
            &apply.actor_id,
            &apply.source_kind,
            &apply.source_ref,
            &apply.idempotency_key,
            &request_fingerprint,
            &apply
                .change_type_id
                .as_ref()
                .map(|change_type_id| change_type_id.to_string()),
            &apply.notes,
            &applied_order,
        ],
    )?;
    notify_canonical(client, apply.app_id.as_str(), apply.customer_id.as_str())?;
    Ok((row.get("id"), applied_order))
}

fn insert_dry_run_change_set(
    client: &mut impl GenericClient,
    apply: &ApplyChangeSet,
    schema_revision_id: SchemaRevisionId,
    request_fingerprint: &str,
    lifecycle_order: i64,
) -> Result<i64, DbError> {
    let (status, applied_at): (&str, Option<DateTime<Utc>>) = match apply.mode {
        ApplyMode::Mainline => ("mainline", Some(Utc::now())),
        ApplyMode::Draft => ("draft", None),
    };
    // Dry-runs insert a transient change_set row only inside a transaction
    // that is rolled back. The id is negative and JS-safe so the response
    // cannot collide with durable sequence-backed ids or lose precision in TS.
    // The lifecycle order is a post-lock, transaction-local simulation of the
    // next durable order and never advances change_set_lifecycle_order_seq.
    let dry_run_id_bits = (Uuid::new_v4().as_u128() & ((1_u128 << 52) - 1)) as i64;
    let change_set_id = -(dry_run_id_bits + 1);
    let applied_order = match apply.mode {
        ApplyMode::Mainline => Some(lifecycle_order),
        ApplyMode::Draft => None,
    };
    let created_with_mode = apply_mode_string(&apply.mode);
    client.execute(
        r#"
        insert into change_set (
          id,
          app_id,
          customer_id,
          schema_revision_id,
          created_with_mode,
          status,
          actor_id,
          source_kind,
          source_ref,
          idempotency_key,
          request_fingerprint,
          change_type_id,
          notes,
          created_order,
          applied_order,
          applied_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        "#,
        &[
            &change_set_id,
            &apply.app_id.as_str(),
            &apply.customer_id.as_str(),
            &schema_revision_id.get(),
            &created_with_mode,
            &status,
            &apply.actor_id,
            &apply.source_kind,
            &apply.source_ref,
            &apply.idempotency_key,
            &request_fingerprint,
            &apply
                .change_type_id
                .as_ref()
                .map(|change_type_id| change_type_id.to_string()),
            &apply.notes,
            &lifecycle_order,
            &applied_order,
            &applied_at,
        ],
    )?;
    Ok(change_set_id)
}

fn insert_revert_change_set(
    client: &mut impl GenericClient,
    request: &RevertChangeSet,
    schema_revision_id: SchemaRevisionId,
    request_fingerprint: &str,
) -> Result<i64, DbError> {
    let created_order = next_change_set_order(client)?;
    let source_kind = "revert";
    let source_ref = request.change_set_id.to_string();
    let row = client.query_one(
        r#"
        insert into change_set (
          app_id,
          customer_id,
          schema_revision_id,
          created_with_mode,
          status,
          actor_id,
          source_kind,
          source_ref,
          idempotency_key,
          request_fingerprint,
          change_type_id,
          notes,
          created_order,
          applied_order,
          applied_at
        )
        values ($1, $2, $3, 'mainline', 'mainline', $4, $5, $6, $7, $8, null, $9, $10, $10, now())
        returning id
        "#,
        &[
            &request.app_id.as_str(),
            &request.customer_id.as_str(),
            &schema_revision_id.get(),
            &request.actor_id,
            &source_kind,
            &source_ref,
            &request.idempotency_key,
            &request_fingerprint,
            &request.notes,
            &created_order,
        ],
    )?;
    notify_canonical(
        client,
        request.app_id.as_str(),
        request.customer_id.as_str(),
    )?;
    Ok(row.get("id"))
}

/// Open canvases re-read when published data of this scope changes. Postgres
/// delivers the notification on commit, so a rolled-back write sends nothing.
fn notify_canonical(
    client: &mut impl GenericClient,
    app_id: &str,
    customer_id: &str,
) -> Result<(), DbError> {
    client.execute(
        "select pg_notify('kernel_canonical', $1)",
        &[&format!("{app_id}:{customer_id}")],
    )?;
    Ok(())
}

fn next_change_set_order(client: &mut impl GenericClient) -> Result<i64, DbError> {
    Ok(client
        .query_one("select nextval('change_set_lifecycle_order_seq')", &[])?
        .get(0))
}

fn apply_mode_string(mode: &ApplyMode) -> String {
    match mode {
        ApplyMode::Mainline => "mainline",
        ApplyMode::Draft => "draft",
    }
    .to_string()
}

fn physical_models(schema: &Schema) -> Result<BTreeMap<ModelId, PhysicalModel>, DbError> {
    schema
        .models
        .iter()
        .map(|model| Ok((model.id.clone(), physical_model(model)?)))
        .collect()
}

fn materialization_catalog(
    client: &mut impl GenericClient,
    schema: &Schema,
) -> Result<MaterializationCatalog, DbError> {
    materialization_catalog_for_scope(client, &schema.app_id, &schema.customer_id)
}

fn materialization_catalog_for_scope(
    client: &mut impl GenericClient,
    app_id: &AppId,
    customer_id: &CustomerId,
) -> Result<MaterializationCatalog, DbError> {
    if !table_exists(client, "schema_revision")? {
        return Ok(MaterializationCatalog::default());
    }

    client.query_one(
        "select set_config($1, 'on', true)",
        &[&SCHEMA_CATALOG_READ_SETTING],
    )?;
    let rows = client.query(
        r#"
        select app_id, customer_id, schema
        from schema_revision
        where activated_at is not null
          and not (app_id = $1 and customer_id = $2)
        "#,
        &[&app_id.as_str(), &customer_id.as_str()],
    );
    client.query_one(
        "select set_config($1, 'off', true)",
        &[&SCHEMA_CATALOG_READ_SETTING],
    )?;
    let rows = rows?;
    let mut catalog = MaterializationCatalog::default();
    for row in rows {
        let sibling_app_id = AppId::from(row.get::<_, String>("app_id"));
        let sibling_customer_id = CustomerId::from(row.get::<_, String>("customer_id"));
        let schema_json: Value = row.get("schema");
        let schema: Schema = serde_json::from_value(schema_json)?;
        for table_contract in active_schema_version_table_contracts(&schema)? {
            let retained = catalog
                .sibling_version_columns_by_table
                .entry(table_contract.table_name.clone())
                .or_default();
            for column in &table_contract.columns {
                match retained
                    .iter()
                    .position(|retained| retained.name == column.name)
                {
                    Some(index) if retained[index] == *column => {}
                    Some(_) => {
                        return Err(DbError::SchemaDrift {
                            object: table_contract.table_name,
                            details: format!(
                                "active sibling schemas disagree on column contract for {:?}",
                                column.name
                            ),
                        });
                    }
                    None => retained.push(column.clone()),
                }
            }
            catalog
                .sibling_required_columns_by_table
                .entry(table_contract.table_name.clone())
                .or_default()
                .extend(table_contract.required_columns.clone());
            catalog
                .sibling_unique_columns_by_table
                .entry(table_contract.table_name.clone())
                .or_default()
                .extend(table_contract.unique_columns.clone());
            catalog
                .sibling_contracts_by_table
                .entry(table_contract.table_name)
                .or_default()
                .push(SiblingVersionTableContract {
                    app_id: sibling_app_id.clone(),
                    customer_id: sibling_customer_id.clone(),
                    columns: table_contract.columns,
                    required_columns: table_contract.required_columns,
                    unique_columns: table_contract.unique_columns,
                });
        }
    }
    Ok(catalog)
}

fn preflight_version_table_contract(
    current: &VersionTableContract,
    catalog: &MaterializationCatalog,
) -> Result<(), DbError> {
    if let Some(siblings) = catalog.sibling_contracts_by_table.get(&current.table_name) {
        for sibling in siblings {
            for column in &current.columns {
                if let Some(sibling_column) = sibling
                    .columns
                    .iter()
                    .find(|candidate| candidate.name == column.name)
                {
                    if sibling_column != column {
                        return Err(coordinated_schema_transition_error(
                            &current.table_name,
                            sibling,
                            format!("column {:?} has a different physical contract", column.name),
                        ));
                    }
                }
            }
            if current.required_columns != sibling.required_columns {
                return Err(coordinated_schema_transition_error(
                    &current.table_name,
                    sibling,
                    format!(
                        "required columns differ (proposed={:?}, active={:?})",
                        current.required_columns, sibling.required_columns
                    ),
                ));
            }
            if current.unique_columns != sibling.unique_columns {
                return Err(coordinated_schema_transition_error(
                    &current.table_name,
                    sibling,
                    format!(
                        "unique columns differ (proposed={:?}, active={:?})",
                        current.unique_columns, sibling.unique_columns
                    ),
                ));
            }
        }
    }
    Ok(())
}

fn coordinated_schema_transition_error(
    table_name: &str,
    sibling: &SiblingVersionTableContract,
    mismatch: String,
) -> DbError {
    DbError::SchemaDrift {
        object: table_name.to_string(),
        details: format!(
            "{mismatch}; active sibling scope={}/{}; coordinated schema migration required because sequential materialization cannot change required, unique, or physical column contracts across active sibling tenants",
            sibling.app_id.as_str(),
            sibling.customer_id.as_str(),
        ),
    }
}

struct VersionTableContract {
    table_name: String,
    columns: Vec<ColumnSpec>,
    required_columns: BTreeSet<String>,
    unique_columns: BTreeSet<String>,
}

fn active_schema_version_table_contracts(
    schema: &Schema,
) -> Result<Vec<VersionTableContract>, DbError> {
    let physical_models = physical_models(schema)?;
    let mut contracts = Vec::new();
    for model in &schema.models {
        let physical_model = physical_models.get(&model.id).expect("model was collected");
        let columns = expected_version_table_columns(model, &physical_models)?;
        contracts.push(VersionTableContract {
            table_name: physical_model.version_table.clone(),
            columns,
            required_columns: required_version_columns(model, &physical_models)?,
            unique_columns: unique_version_columns(model, &physical_models)?,
        });
    }
    Ok(contracts)
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum CanonicalRecordAddress {
    RecordId(RecordId),
    NewRecordId(RecordId),
    ExternalKey(String),
    LookupOrCreate(String),
    Anonymous(usize),
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct ScopedRecordAddress {
    model_id: ModelId,
    address: CanonicalRecordAddress,
}

#[derive(Debug)]
struct PreparedMainlineWrite<'a> {
    write: &'a RowVersionWrite,
    record_id: RecordId,
    predecessor: Option<LoadedVersion>,
}

struct PreparedMainlineRequest<'a> {
    writes: Vec<PreparedMainlineWrite<'a>>,
    address_map: BTreeMap<ScopedRecordAddress, RecordId>,
}

#[derive(Debug)]
struct PreparedDraftWrite<'a> {
    write: &'a RowVersionWrite,
    record_id: RecordId,
    mainline_predecessor: Option<LoadedVersion>,
}

struct PreparedDraftRequest<'a> {
    writes: Vec<PreparedDraftWrite<'a>>,
}

struct PreparedMainlineContext<'a> {
    apply: &'a ApplyChangeSet,
    schema: &'a Schema,
    physical_models: &'a BTreeMap<ModelId, PhysicalModel>,
    request: &'a PreparedMainlineRequest<'a>,
}

fn apply_prepared_mainline_change_set(
    client: &mut impl GenericClient,
    apply: &ApplyChangeSet,
    schema_revision_id: SchemaRevisionId,
    schema: &Schema,
    request_fingerprint: &str,
) -> Result<AppliedChangeSet, DbError> {
    let physical_models = physical_models(schema)?;
    let prepared = prepare_mainline_request(client, apply, schema, &physical_models)?;
    let (change_set_id, applied_order) =
        insert_mainline_change_set(client, apply, schema_revision_id, request_fingerprint)?;
    apply_prepared_mainline_request(
        client,
        apply,
        schema_revision_id,
        schema,
        &physical_models,
        &prepared,
        change_set_id,
        applied_order,
    )
}

#[allow(clippy::too_many_arguments)]
fn apply_prepared_mainline_request(
    client: &mut impl GenericClient,
    apply: &ApplyChangeSet,
    schema_revision_id: SchemaRevisionId,
    schema: &Schema,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
    prepared: &PreparedMainlineRequest<'_>,
    change_set_id: i64,
    applied_order: i64,
) -> Result<AppliedChangeSet, DbError> {
    let context = PreparedMainlineContext {
        apply,
        schema,
        physical_models,
        request: prepared,
    };
    let mut write_order = (0..prepared.writes.len()).collect::<Vec<_>>();
    write_order.sort_by_key(|index| {
        let prepared_write = &prepared.writes[*index];
        (
            prepared_write.write.model_id.clone(),
            prepared_write.record_id,
            prepared_write.write.effective_start,
            lifecycle_priority(prepared_write.write.tombstones_record, false),
            *index,
        )
    });
    let mut planned_predecessors = BTreeMap::new();
    for index in write_order {
        let prepared_write = &prepared.writes[index];
        let planned_predecessor = planned_predecessors
            .get(&(
                prepared_write.write.model_id.clone(),
                prepared_write.record_id,
            ))
            .filter(|version: &&LoadedVersion| {
                version.effective_start <= prepared_write.write.effective_start
            });
        let predecessor = [prepared_write.predecessor.as_ref(), planned_predecessor]
            .into_iter()
            .flatten()
            .max_by_key(|version| {
                (
                    version.effective_start,
                    lifecycle_priority(version.tombstones_record, version.untombstones_record),
                    version.applied_order,
                )
            });
        if !prepared_write.write.tombstones_record
            && predecessor.is_some_and(|predecessor| predecessor.tombstones_record)
        {
            return Err(DbError::TombstonedRecord {
                details: format!(
                    "record `{}` is tombstoned as of {}",
                    prepared_write.record_id, prepared_write.write.effective_start
                ),
            });
        }
        let version = apply_prepared_mainline_write(
            client,
            change_set_id,
            applied_order,
            &context,
            prepared_write,
            predecessor,
        )?;
        planned_predecessors.insert(
            (
                prepared_write.write.model_id.clone(),
                prepared_write.record_id,
            ),
            version,
        );
    }
    Ok(AppliedChangeSet {
        id: change_set_id,
        schema_revision_id,
    })
}

fn apply_prepared_draft_change_set(
    client: &mut impl GenericClient,
    apply: &ApplyChangeSet,
    schema_revision_id: SchemaRevisionId,
    schema: &Schema,
    request_fingerprint: &str,
) -> Result<AppliedChangeSet, DbError> {
    let physical_models = physical_models(schema)?;
    let prepared = prepare_draft_request(client, apply, schema, &physical_models)?;
    let change_set_id = insert_change_set(client, apply, schema_revision_id, request_fingerprint)?;
    apply_prepared_draft_request(
        client,
        apply,
        schema_revision_id,
        schema,
        &physical_models,
        &prepared,
        change_set_id,
    )
}

#[allow(clippy::too_many_arguments)]
fn apply_prepared_draft_request(
    client: &mut impl GenericClient,
    apply: &ApplyChangeSet,
    schema_revision_id: SchemaRevisionId,
    schema: &Schema,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
    prepared: &PreparedDraftRequest<'_>,
    change_set_id: i64,
) -> Result<AppliedChangeSet, DbError> {
    for prepared_write in &prepared.writes {
        apply_prepared_draft_write(
            client,
            apply,
            schema,
            physical_models,
            change_set_id,
            prepared_write,
        )?;
    }
    Ok(AppliedChangeSet {
        id: change_set_id,
        schema_revision_id,
    })
}

fn apply_prepared_dry_run_change_set(
    client: &mut impl GenericClient,
    apply: &ApplyChangeSet,
    schema_revision_id: SchemaRevisionId,
    schema: &Schema,
    request_fingerprint: &str,
    synthetic_orders: &mut SyntheticOrderAllocator,
) -> Result<AppliedChangeSet, DbError> {
    let physical_models = physical_models(schema)?;
    match apply.mode {
        ApplyMode::Mainline => {
            let prepared = prepare_mainline_request(client, apply, schema, &physical_models)?;
            let applied_order = synthetic_orders.next(client)?;
            let change_set_id = insert_dry_run_change_set(
                client,
                apply,
                schema_revision_id,
                request_fingerprint,
                applied_order,
            )?;
            apply_prepared_mainline_request(
                client,
                apply,
                schema_revision_id,
                schema,
                &physical_models,
                &prepared,
                change_set_id,
                applied_order,
            )
        }
        ApplyMode::Draft => {
            let prepared = prepare_draft_request(client, apply, schema, &physical_models)?;
            let created_order = synthetic_orders.next(client)?;
            let change_set_id = insert_dry_run_change_set(
                client,
                apply,
                schema_revision_id,
                request_fingerprint,
                created_order,
            )?;
            apply_prepared_draft_request(
                client,
                apply,
                schema_revision_id,
                schema,
                &physical_models,
                &prepared,
                change_set_id,
            )
        }
    }
}

fn scoped_record_address(model_id: &ModelId, record_key: &RecordKey) -> ScopedRecordAddress {
    ScopedRecordAddress {
        model_id: model_id.clone(),
        address: match record_key {
            RecordKey::RecordId(record_id) => CanonicalRecordAddress::RecordId(*record_id),
            RecordKey::ExternalKey(external_key) => {
                CanonicalRecordAddress::ExternalKey(external_key.as_str().to_string())
            }
            RecordKey::LookupOrCreate { label, .. } => {
                CanonicalRecordAddress::LookupOrCreate(label.clone())
            }
        },
    }
}

fn lookup_or_create_requires_generated_sql(path: impl Into<String>) -> DbError {
    DbError::Validation(ValidationError::new(vec![ValidationIssue::new(
        path,
        "lookup_or_create_requires_generated_sql",
        "lookup-or-create record keys are supported only by the generated SQL apply API",
    )]))
}

fn subject_address(index: usize, write: &RowVersionWrite) -> ScopedRecordAddress {
    match (&write.record_key, write.new_record_id) {
        (Some(record_key), None) => scoped_record_address(&write.model_id, record_key),
        (None, Some(record_id)) => ScopedRecordAddress {
            model_id: write.model_id.clone(),
            address: CanonicalRecordAddress::NewRecordId(record_id),
        },
        (None, None) => ScopedRecordAddress {
            model_id: write.model_id.clone(),
            address: CanonicalRecordAddress::Anonymous(index),
        },
        (Some(_), Some(_)) => unreachable!("conflicting write subjects were validated"),
    }
}

fn prepare_mainline_request<'a>(
    client: &mut impl GenericClient,
    apply: &'a ApplyChangeSet,
    schema: &Schema,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
) -> Result<PreparedMainlineRequest<'a>, DbError> {
    let mut address_map = resolve_request_subjects(client, apply, physical_models)?;

    let mut prepared_writes = Vec::with_capacity(apply.writes.len());
    let mut logical_snapshots = BTreeSet::new();
    for (index, write) in apply.writes.iter().enumerate() {
        let record_id = *address_map
            .get(&subject_address(index, write))
            .expect("every validated subject was resolved");
        let lifecycle = write.tombstones_record;
        if !logical_snapshots.insert((
            write.model_id.clone(),
            record_id,
            write.effective_start,
            lifecycle,
        )) {
            return Err(DbError::TimelineConflict {
                details: format!(
                    "change set contains more than one {} snapshot for record `{record_id}` at {}",
                    if lifecycle {
                        "tombstone"
                    } else {
                        "ordinary value"
                    },
                    write.effective_start
                ),
            });
        }
        let model = schema
            .models
            .iter()
            .find(|model| model.id == write.model_id)
            .expect("write model was validated");
        let predecessor = load_mainline_predecessor(
            client,
            apply,
            schema,
            model,
            physical_models,
            record_id,
            write.effective_start,
        )?;
        prepared_writes.push(PreparedMainlineWrite {
            write,
            record_id,
            predecessor,
        });
    }

    let mut relation_addresses = Vec::new();
    for prepared_write in &prepared_writes {
        collect_write_relation_addresses(
            schema,
            prepared_write.write,
            prepared_write.predecessor.as_ref(),
            &mut relation_addresses,
        )?;
    }
    for (target_model_id, record_key, _) in &relation_addresses {
        let address = scoped_record_address(target_model_id, record_key);
        if address_map.contains_key(&address) {
            continue;
        }
        let physical_model = physical_models
            .get(target_model_id)
            .expect("relation target model was validated");
        let record_id =
            resolve_existing_record_id_unlocked(client, apply, physical_model, record_key)?;
        address_map.insert(address, record_id);
        address_map.insert(
            ScopedRecordAddress {
                model_id: target_model_id.clone(),
                address: CanonicalRecordAddress::RecordId(record_id),
            },
            record_id,
        );
    }

    let mut lock_set = prepared_writes
        .iter()
        .map(|prepared| (prepared.write.model_id.clone(), prepared.record_id))
        .collect::<BTreeSet<_>>();
    for (target_model_id, record_key, _) in &relation_addresses {
        let record_id = *address_map
            .get(&scoped_record_address(target_model_id, record_key))
            .expect("every relation target was resolved");
        lock_set.insert((target_model_id.clone(), record_id));
    }
    lock_record_set(client, apply, physical_models, &lock_set)?;

    // Every guarded baseline is observed after the complete canonical lock set
    // is held. Check all guards before any dependency-drift recheck so an
    // unguarded sibling cannot hide a stale guarded target behind retryable 40001.
    for prepared in &prepared_writes {
        let Some(expected_version_id) = prepared.write.expected_version_id else {
            continue;
        };
        let model = schema
            .models
            .iter()
            .find(|model| model.id == prepared.write.model_id)
            .expect("write model was validated");
        let visible = load_mainline_predecessor(
            client,
            apply,
            schema,
            model,
            physical_models,
            prepared.record_id,
            prepared.write.effective_start,
        )?;
        if visible.as_ref().map(|version| version.version_id) != Some(expected_version_id) {
            return Err(DbError::VersionConflict);
        }
    }

    if existing_idempotent_change_set(client, apply)?.is_some() {
        return Err(abort_for_apply_dependency_drift(client));
    }
    for (target_model_id, record_key, _) in &relation_addresses {
        let physical_model = physical_models
            .get(target_model_id)
            .expect("relation target model was validated");
        let rechecked =
            resolve_existing_record_id_unlocked(client, apply, physical_model, record_key)?;
        let resolved = *address_map
            .get(&scoped_record_address(target_model_id, record_key))
            .expect("every relation target was resolved");
        if rechecked != resolved {
            return Err(abort_for_apply_dependency_drift(client));
        }
    }
    for prepared in &prepared_writes {
        if let Some(record_key) = &prepared.write.record_key {
            let physical_model = physical_models
                .get(&prepared.write.model_id)
                .expect("write model was validated");
            let resolved =
                resolve_existing_record_id_unlocked(client, apply, physical_model, record_key)?;
            if resolved != prepared.record_id {
                return Err(abort_for_apply_dependency_drift(client));
            }
        }
        let model = schema
            .models
            .iter()
            .find(|model| model.id == prepared.write.model_id)
            .expect("write model was validated");
        let rechecked = load_mainline_predecessor(
            client,
            apply,
            schema,
            model,
            physical_models,
            prepared.record_id,
            prepared.write.effective_start,
        )?;
        if rechecked != prepared.predecessor {
            return Err(abort_for_apply_dependency_drift(client));
        }
        if !prepared.write.tombstones_record
            && prepared
                .predecessor
                .as_ref()
                .is_some_and(|predecessor| predecessor.tombstones_record)
        {
            return Err(DbError::TombstonedRecord {
                details: format!(
                    "record `{}` is tombstoned as of {}",
                    prepared.record_id, prepared.write.effective_start
                ),
            });
        }
    }

    let prepared = PreparedMainlineRequest {
        writes: prepared_writes,
        address_map,
    };
    let context = PreparedMainlineContext {
        apply,
        schema,
        physical_models,
        request: &prepared,
    };
    for (target_model_id, record_key, as_of) in relation_addresses {
        validate_prepared_relation_target(client, &context, &target_model_id, &record_key, as_of)?;
    }
    Ok(prepared)
}

fn prepare_draft_request<'a>(
    client: &mut impl GenericClient,
    apply: &'a ApplyChangeSet,
    schema: &Schema,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
) -> Result<PreparedDraftRequest<'a>, DbError> {
    let mut address_map = resolve_request_subjects(client, apply, physical_models)?;
    let mut prepared_writes = Vec::with_capacity(apply.writes.len());
    let mut logical_snapshots = BTreeSet::new();
    let mut latest_draft_starts = BTreeMap::new();

    for (index, write) in apply.writes.iter().enumerate() {
        let record_id = *address_map
            .get(&subject_address(index, write))
            .expect("every validated subject was resolved");
        if !logical_snapshots.insert((
            write.model_id.clone(),
            record_id,
            write.effective_start,
            write.tombstones_record,
        )) {
            return Err(DbError::TimelineConflict {
                details: format!(
                    "change set contains more than one {} snapshot for record `{record_id}` at {}",
                    if write.tombstones_record {
                        "tombstone"
                    } else {
                        "ordinary value"
                    },
                    write.effective_start
                ),
            });
        }
        let subject = (write.model_id.clone(), record_id);
        if latest_draft_starts
            .get(&subject)
            .is_some_and(|latest| *latest > write.effective_start)
        {
            return Err(DbError::TimelineConflict {
                details: format!(
                    "draft change set has a later version for record `{record_id}` before {}; submit same-record draft writes in effective_start order",
                    write.effective_start
                ),
            });
        }
        latest_draft_starts.insert(subject, write.effective_start);

        let model = schema
            .models
            .iter()
            .find(|model| model.id == write.model_id)
            .expect("write model was validated");
        let mainline_predecessor = load_mainline_predecessor(
            client,
            apply,
            schema,
            model,
            physical_models,
            record_id,
            write.effective_start,
        )?;
        prepared_writes.push(PreparedDraftWrite {
            write,
            record_id,
            mainline_predecessor,
        });
    }

    let mut relation_addresses = Vec::new();
    for prepared_write in &prepared_writes {
        collect_write_relation_addresses(
            schema,
            prepared_write.write,
            prepared_write.mainline_predecessor.as_ref(),
            &mut relation_addresses,
        )?;
    }
    for (target_model_id, record_key, _) in &relation_addresses {
        let address = scoped_record_address(target_model_id, record_key);
        if address_map.contains_key(&address) {
            continue;
        }
        let physical_model = physical_models
            .get(target_model_id)
            .expect("relation target model was validated");
        let record_id =
            resolve_existing_record_id_unlocked(client, apply, physical_model, record_key)?;
        address_map.insert(address, record_id);
    }

    let mut lock_set = prepared_writes
        .iter()
        .map(|prepared| (prepared.write.model_id.clone(), prepared.record_id))
        .collect::<BTreeSet<_>>();
    for (target_model_id, record_key, _) in &relation_addresses {
        let record_id = *address_map
            .get(&scoped_record_address(target_model_id, record_key))
            .expect("every relation target was resolved");
        lock_set.insert((target_model_id.clone(), record_id));
    }
    lock_record_set(client, apply, physical_models, &lock_set)?;

    if existing_idempotent_change_set(client, apply)?.is_some() {
        return Err(abort_for_apply_dependency_drift(client));
    }
    for (target_model_id, record_key, _) in &relation_addresses {
        let physical_model = physical_models
            .get(target_model_id)
            .expect("relation target model was validated");
        let rechecked =
            resolve_existing_record_id_unlocked(client, apply, physical_model, record_key)?;
        let resolved = *address_map
            .get(&scoped_record_address(target_model_id, record_key))
            .expect("every relation target was resolved");
        if rechecked != resolved {
            return Err(abort_for_apply_dependency_drift(client));
        }
    }
    for prepared in &prepared_writes {
        if let Some(record_key) = &prepared.write.record_key {
            let physical_model = physical_models
                .get(&prepared.write.model_id)
                .expect("write model was validated");
            let rechecked =
                resolve_existing_record_id_unlocked(client, apply, physical_model, record_key)?;
            if rechecked != prepared.record_id {
                return Err(abort_for_apply_dependency_drift(client));
            }
        }
        let model = schema
            .models
            .iter()
            .find(|model| model.id == prepared.write.model_id)
            .expect("write model was validated");
        let rechecked = load_mainline_predecessor(
            client,
            apply,
            schema,
            model,
            physical_models,
            prepared.record_id,
            prepared.write.effective_start,
        )?;
        if rechecked != prepared.mainline_predecessor {
            return Err(abort_for_apply_dependency_drift(client));
        }
    }

    Ok(PreparedDraftRequest {
        writes: prepared_writes,
    })
}

fn resolve_request_subjects(
    client: &mut impl GenericClient,
    apply: &ApplyChangeSet,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
) -> Result<BTreeMap<ScopedRecordAddress, RecordId>, DbError> {
    let mut address_map = BTreeMap::new();
    let mut new_candidates = BTreeMap::new();

    for (index, write) in apply.writes.iter().enumerate() {
        let address = subject_address(index, write);
        let physical_model = physical_models
            .get(&write.model_id)
            .expect("write model was validated");
        match address.address.clone() {
            CanonicalRecordAddress::RecordId(record_id) => {
                resolve_existing_record_id_unlocked(
                    client,
                    apply,
                    physical_model,
                    &RecordKey::RecordId(record_id),
                )?;
                address_map.insert(address, record_id);
            }
            CanonicalRecordAddress::NewRecordId(record_id) => {
                new_candidates.insert(address, record_id);
            }
            CanonicalRecordAddress::ExternalKey(external_key) => {
                let record_key = RecordKey::ExternalKey(ExternalKey::from(external_key.as_str()));
                match resolve_existing_record_id_unlocked(
                    client,
                    apply,
                    physical_model,
                    &record_key,
                ) {
                    Ok(record_id) => {
                        address_map.insert(address, record_id);
                    }
                    Err(DbError::RecordTargetMissing { .. })
                        if apply.writes.iter().enumerate().any(
                            |(candidate_index, candidate)| {
                                !candidate.tombstones_record
                                    && subject_address(candidate_index, candidate) == address
                            },
                        ) =>
                    {
                        new_candidates.entry(address).or_insert_with(Uuid::new_v4);
                    }
                    Err(error) => return Err(error),
                }
            }
            CanonicalRecordAddress::LookupOrCreate(_) => {
                return Err(lookup_or_create_requires_generated_sql("record_key"));
            }
            CanonicalRecordAddress::Anonymous(_) => {
                new_candidates.insert(address, Uuid::new_v4());
            }
        }
    }

    for (address, candidate) in new_candidates {
        let physical_model = physical_models
            .get(&address.model_id)
            .expect("write model was validated");
        let record_id = match &address.address {
            CanonicalRecordAddress::NewRecordId(record_id) => {
                insert_record_row(client, physical_model, apply, *record_id, None)?;
                *record_id
            }
            CanonicalRecordAddress::ExternalKey(external_key) => {
                reserve_external_record(client, apply, physical_model, candidate, external_key)?
            }
            CanonicalRecordAddress::Anonymous(_) => {
                insert_record_row(client, physical_model, apply, candidate, None)?;
                candidate
            }
            CanonicalRecordAddress::LookupOrCreate(_) => {
                return Err(lookup_or_create_requires_generated_sql("record_key"));
            }
            CanonicalRecordAddress::RecordId(_) => {
                unreachable!("existing record ids are not reservation candidates")
            }
        };
        address_map.insert(address, record_id);
    }

    for (address, record_id) in address_map.clone() {
        address_map.insert(
            ScopedRecordAddress {
                model_id: address.model_id,
                address: CanonicalRecordAddress::RecordId(record_id),
            },
            record_id,
        );
    }
    Ok(address_map)
}

fn reserve_external_record(
    client: &mut impl GenericClient,
    apply: &ApplyChangeSet,
    physical_model: &PhysicalModel,
    candidate: RecordId,
    external_key: &str,
) -> Result<RecordId, DbError> {
    if let Some(row) = client.query_opt(
        &format!(
            r#"
            insert into {} (id, app_id, customer_id, external_key)
            values ($1, $2, $3, $4)
            on conflict (app_id, customer_id, external_key)
              where external_key is not null
            do nothing
            returning id
            "#,
            quote_identifier(&physical_model.record_table)
        ),
        &[
            &candidate,
            &apply.app_id.as_str(),
            &apply.customer_id.as_str(),
            &external_key,
        ],
    )? {
        return Ok(row.get("id"));
    }
    resolve_existing_record_id_unlocked(
        client,
        apply,
        physical_model,
        &RecordKey::ExternalKey(ExternalKey::from(external_key)),
    )
}

fn resolve_existing_record_id_unlocked(
    client: &mut impl GenericClient,
    apply: &ApplyChangeSet,
    physical_model: &PhysicalModel,
    record_key: &RecordKey,
) -> Result<RecordId, DbError> {
    resolve_existing_record_id_for_scope_unlocked(
        client,
        &apply.app_id,
        &apply.customer_id,
        physical_model,
        record_key,
    )
}

fn resolve_existing_record_id_for_scope_unlocked(
    client: &mut impl GenericClient,
    app_id: &AppId,
    customer_id: &CustomerId,
    physical_model: &PhysicalModel,
    record_key: &RecordKey,
) -> Result<RecordId, DbError> {
    let table = quote_identifier(&physical_model.record_table);
    let row = match record_key {
        RecordKey::RecordId(record_id) => client.query_opt(
            &format!(
                "select id from {table} where app_id = $1 and customer_id = $2 and id = $3"
            ),
            &[&app_id.as_str(), &customer_id.as_str(), record_id],
        )?,
        RecordKey::ExternalKey(external_key) => client.query_opt(
            &format!(
                "select id from {table} where app_id = $1 and customer_id = $2 and external_key = $3"
            ),
            &[
                &app_id.as_str(),
                &customer_id.as_str(),
                &external_key.as_str(),
            ],
        )?,
        RecordKey::LookupOrCreate { .. } => {
            return Err(lookup_or_create_requires_generated_sql("record_key"));
        }
    };
    row.map(|row| row.get("id"))
        .ok_or_else(|| DbError::RecordTargetMissing {
            details: format!("record key `{record_key:?}` did not resolve"),
        })
}

fn lock_record_set(
    client: &mut impl GenericClient,
    apply: &ApplyChangeSet,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
    lock_set: &BTreeSet<(ModelId, RecordId)>,
) -> Result<(), DbError> {
    lock_record_set_for_scope(
        client,
        &apply.app_id,
        &apply.customer_id,
        physical_models,
        lock_set,
    )
}

fn lock_record_set_for_scope(
    client: &mut impl GenericClient,
    app_id: &AppId,
    customer_id: &CustomerId,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
    lock_set: &BTreeSet<(ModelId, RecordId)>,
) -> Result<(), DbError> {
    for (model_id, record_id) in lock_set {
        let physical_model = physical_models
            .get(model_id)
            .expect("lock model was validated");
        let row = client.query_opt(
            &format!(
                "select id from {} where app_id = $1 and customer_id = $2 and id = $3 for update",
                quote_identifier(&physical_model.record_table)
            ),
            &[&app_id.as_str(), &customer_id.as_str(), record_id],
        )?;
        if row.is_none() {
            return Err(abort_for_apply_dependency_drift(client));
        }
    }
    Ok(())
}

fn collect_write_relation_addresses(
    schema: &Schema,
    write: &RowVersionWrite,
    predecessor: Option<&LoadedVersion>,
    addresses: &mut Vec<(ModelId, RecordKey, NaiveDate)>,
) -> Result<(), DbError> {
    let model = schema
        .models
        .iter()
        .find(|model| model.id == write.model_id)
        .expect("write model was validated");
    if let Some(predecessor) = predecessor {
        for field in &model.fields {
            if let Some(FieldValue::Relation(record_key)) = predecessor.values.get(&field.id) {
                addresses.push((
                    field
                        .target_model
                        .as_ref()
                        .expect("relation target was validated")
                        .clone(),
                    record_key.clone(),
                    write.effective_start,
                ));
            }
        }
        for entry in &predecessor.custom_fields {
            if let CustomFieldValue::Relation(record_key) = &entry.value {
                let definition = active_custom_field_definition(
                    &schema.custom_fields,
                    &write.model_id,
                    &entry.field_id,
                )
                .ok_or_else(|| DbError::SchemaDrift {
                    object: format!("{}.{}", write.model_id, entry.field_id),
                    details: "inherited custom relation definition is missing".to_string(),
                })?;
                addresses.push((
                    definition
                        .target_model_id
                        .as_ref()
                        .expect("custom relation target was validated")
                        .clone(),
                    record_key.clone(),
                    write.effective_start,
                ));
            }
        }
    }
    if let Some(values) = &write.values {
        for field in &model.fields {
            if let Some(FieldValue::Relation(record_key)) = values.get(&field.id) {
                addresses.push((
                    field
                        .target_model
                        .as_ref()
                        .expect("relation target was validated")
                        .clone(),
                    record_key.clone(),
                    write.effective_start,
                ));
            }
        }
    }
    if let Some(custom_fields) = &write.custom_fields {
        for entry in custom_fields {
            if let CustomFieldValue::Relation(record_key) = &entry.value {
                let definition = active_custom_field_definition(
                    &schema.custom_fields,
                    &write.model_id,
                    &entry.field_id,
                )
                .expect("custom field was validated");
                addresses.push((
                    definition
                        .target_model_id
                        .as_ref()
                        .expect("custom relation target was validated")
                        .clone(),
                    record_key.clone(),
                    write.effective_start,
                ));
            }
        }
    }
    Ok(())
}

fn load_mainline_predecessor(
    client: &mut impl GenericClient,
    apply: &ApplyChangeSet,
    schema: &Schema,
    model: &Model,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
    record_id: RecordId,
    as_of: NaiveDate,
) -> Result<Option<LoadedVersion>, DbError> {
    load_mainline_predecessor_for_scope(
        client,
        &apply.app_id,
        &apply.customer_id,
        schema,
        model,
        physical_models,
        record_id,
        as_of,
    )
}

#[allow(clippy::too_many_arguments)]
fn load_mainline_predecessor_for_scope(
    client: &mut impl GenericClient,
    app_id: &AppId,
    customer_id: &CustomerId,
    schema: &Schema,
    model: &Model,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
    record_id: RecordId,
    as_of: NaiveDate,
) -> Result<Option<LoadedVersion>, DbError> {
    let physical_model = physical_models
        .get(&model.id)
        .expect("predecessor model was validated");
    ensure_mainline_version_order_integrity(client, physical_model, app_id, customer_id)?;
    let field_columns = model_field_columns(model, physical_models)?;
    let selected_columns = field_columns
        .iter()
        .flat_map(|(_, columns)| columns.iter())
        .map(|column| column.select_sql("v"))
        .collect::<Vec<_>>();
    let mut select_sql = "
        v.id,
        v.effective_start,
        v.effective_end,
        v.tombstones_record,
        v.untombstones_record,
        cs.applied_order,
        v.custom_fields
    "
    .to_string();
    if !selected_columns.is_empty() {
        select_sql.push_str(", ");
        select_sql.push_str(&selected_columns.join(", "));
    }
    let precedence = version_precedence_sql("v", "cs", VersionOrderDirection::Descending, false);
    let row = client.query_opt(
        &format!(
            r#"
            select {select_sql}
            from {} v
            join change_set cs
              on cs.id = v.change_set_id
             and cs.app_id = v.app_id
             and cs.customer_id = v.customer_id
             and cs.status = 'mainline'
             and cs.applied_order is not null
            where v.record_id = $1
              and v.app_id = $2
              and v.customer_id = $3
              and v.stage = 'mainline'
              and v.effective_start <= $4
              and (v.effective_end is null or v.effective_end >= $4)
            order by
              {precedence}
            limit 1
            "#,
            quote_identifier(&physical_model.version_table)
        ),
        &[&record_id, &app_id.as_str(), &customer_id.as_str(), &as_of],
    )?;
    let Some(row) = row else {
        return Ok(None);
    };
    let mut values = BTreeMap::new();
    let custom_fields =
        custom_fields_from_json_for_schema(schema, &model.id, row.get("custom_fields"))?;
    let mut offset = 7;
    for (field, columns) in &field_columns {
        if let Some(value) = field_value_from_row(&row, offset, field, columns)? {
            values.insert(field.id.clone(), value);
        }
        offset += columns.len();
    }
    Ok(Some(LoadedVersion {
        version_id: row.get("id"),
        effective_start: row.get("effective_start"),
        effective_end: row.get("effective_end"),
        applied_order: row.get("applied_order"),
        values,
        custom_fields,
        tombstones_record: row.get("tombstones_record"),
        untombstones_record: row.get("untombstones_record"),
    }))
}

fn lifecycle_priority(tombstones_record: bool, untombstones_record: bool) -> u8 {
    if tombstones_record {
        2
    } else if untombstones_record {
        1
    } else {
        0
    }
}

fn validate_prepared_relation_target(
    client: &mut impl GenericClient,
    context: &PreparedMainlineContext<'_>,
    target_model_id: &ModelId,
    record_key: &RecordKey,
    as_of: NaiveDate,
) -> Result<RecordId, DbError> {
    let record_id = *context
        .request
        .address_map
        .get(&scoped_record_address(target_model_id, record_key))
        .ok_or_else(|| DbError::RecordTargetMissing {
            details: format!("record key `{record_key:?}` did not resolve"),
        })?;
    let model = context
        .schema
        .models
        .iter()
        .find(|model| model.id == *target_model_id)
        .expect("relation target model was validated");
    let existing = load_mainline_predecessor(
        client,
        context.apply,
        context.schema,
        model,
        context.physical_models,
        record_id,
        as_of,
    )?;
    let planned = context
        .request
        .writes
        .iter()
        .filter(|candidate| {
            candidate.write.model_id == *target_model_id
                && candidate.record_id == record_id
                && candidate.write.effective_start <= as_of
        })
        .max_by_key(|candidate| {
            (
                candidate.write.effective_start,
                lifecycle_priority(candidate.write.tombstones_record, false),
            )
        });

    let planned_wins = planned.is_some_and(|planned| {
        existing.as_ref().is_none_or(|existing| {
            (
                planned.write.effective_start,
                lifecycle_priority(planned.write.tombstones_record, false),
                i64::MAX,
            ) >= (
                existing.effective_start,
                lifecycle_priority(existing.tombstones_record, existing.untombstones_record),
                existing.applied_order,
            )
        })
    });
    let tombstoned = if planned_wins {
        planned
            .expect("planned winner exists")
            .write
            .tombstones_record
    } else if let Some(existing) = existing {
        existing.tombstones_record
    } else {
        return Err(DbError::RecordTargetMissing {
            details: format!("record `{record_id}` is not visible as of {as_of}"),
        });
    };
    if tombstoned {
        return Err(DbError::TombstonedRecord {
            details: format!("record `{record_id}` is tombstoned as of {as_of}"),
        });
    }
    Ok(record_id)
}

fn resolve_prepared_field_value(
    client: &mut impl GenericClient,
    context: &PreparedMainlineContext<'_>,
    field: &Field,
    value: &FieldValue,
    as_of: NaiveDate,
) -> Result<FieldValue, DbError> {
    if let (FieldType::Relation, FieldValue::Relation(record_key)) = (&field.field_type, value) {
        let target_model_id = field.target_model.as_ref().expect("schema was validated");
        let record_id =
            validate_prepared_relation_target(client, context, target_model_id, record_key, as_of)?;
        return Ok(FieldValue::Relation(RecordKey::RecordId(record_id)));
    }
    Ok(value.clone())
}

fn overlay_prepared_custom_fields(
    client: &mut impl GenericClient,
    context: &PreparedMainlineContext<'_>,
    model_id: &ModelId,
    existing: Vec<CustomFieldEntry>,
    incoming: Option<&[CustomFieldEntry]>,
    as_of: NaiveDate,
) -> Result<Vec<CustomFieldEntry>, DbError> {
    let mut by_field = existing
        .into_iter()
        .filter(|entry| {
            active_custom_field_definition(&context.schema.custom_fields, model_id, &entry.field_id)
                .is_some()
        })
        .map(|entry| (entry.field_id.clone(), entry))
        .collect::<BTreeMap<_, _>>();
    for entry in incoming.into_iter().flatten() {
        let definition = active_custom_field_definition(
            &context.schema.custom_fields,
            model_id,
            &entry.field_id,
        )
        .expect("custom field was validated");
        let value = match (&definition.field_type, &entry.value) {
            (CustomFieldType::Relation, CustomFieldValue::Relation(record_key)) => {
                let target_model_id = definition
                    .target_model_id
                    .as_ref()
                    .expect("custom relation target was validated");
                let record_id = validate_prepared_relation_target(
                    client,
                    context,
                    target_model_id,
                    record_key,
                    as_of,
                )?;
                CustomFieldValue::Relation(RecordKey::RecordId(record_id))
            }
            _ => entry.value.clone(),
        };
        by_field.insert(
            entry.field_id.clone(),
            CustomFieldEntry {
                field_id: entry.field_id.clone(),
                value,
            },
        );
    }
    Ok(by_field.into_values().collect())
}

fn apply_prepared_mainline_write(
    client: &mut impl GenericClient,
    change_set_id: i64,
    applied_order: i64,
    context: &PreparedMainlineContext<'_>,
    prepared_write: &PreparedMainlineWrite<'_>,
    predecessor: Option<&LoadedVersion>,
) -> Result<LoadedVersion, DbError> {
    let apply = context.apply;
    let schema = context.schema;
    let physical_models = context.physical_models;
    let write = prepared_write.write;
    let model = schema
        .models
        .iter()
        .find(|model| model.id == write.model_id)
        .expect("write model was validated");
    let physical_model = physical_models
        .get(&write.model_id)
        .expect("write model was materialized");
    let predecessor = predecessor.cloned();

    if write.tombstones_record {
        ensure_no_same_day_mainline(
            client,
            &apply.app_id,
            &apply.customer_id,
            physical_model,
            MainlineUniquenessKey {
                record_id: prepared_write.record_id,
                effective_start: write.effective_start,
                tombstones_record: true,
                untombstones_record: false,
            },
        )?;
    }

    let (mut snapshot, mut custom_fields) = predecessor.clone().map_or_else(
        || (BTreeMap::new(), Vec::new()),
        |version| (version.values, version.custom_fields),
    );
    if !write.tombstones_record {
        if let Some(values) = &write.values {
            for (field_id, value) in values {
                let field = model
                    .fields
                    .iter()
                    .find(|field| field.id == *field_id)
                    .expect("field was validated");
                snapshot.insert(
                    field_id.clone(),
                    resolve_prepared_field_value(
                        client,
                        context,
                        field,
                        value,
                        write.effective_start,
                    )?,
                );
            }
        }
        custom_fields = overlay_prepared_custom_fields(
            client,
            context,
            &write.model_id,
            custom_fields,
            write.custom_fields.as_deref(),
            write.effective_start,
        )?;
    }

    let next_start = next_version_start(
        client,
        apply,
        physical_model,
        prepared_write.record_id,
        write.effective_start,
    )?;
    if write.tombstones_record && next_start.is_some() {
        return Err(DbError::TimelineConflict {
            details: format!(
                "tombstone for record `{}` at {} would precede a later mainline version",
                prepared_write.record_id, write.effective_start
            ),
        });
    }
    let same_day_predecessor = predecessor.as_ref().filter(|predecessor| {
        predecessor.effective_start == write.effective_start
            && !predecessor.tombstones_record
            && !predecessor.untombstones_record
    });
    let effective_end = same_day_predecessor
        .map(|predecessor| predecessor.effective_end)
        .unwrap_or_else(|| next_start.map(|date| date - Duration::days(1)));
    ensure_unique_field_values_available(
        client,
        UniqueFieldValueCheck {
            app_id: &apply.app_id,
            customer_id: &apply.customer_id,
            model,
            physical_model,
            physical_models,
            record_id: prepared_write.record_id,
            values: &snapshot,
        },
    )?;
    close_displaced_mainline_version(
        client,
        apply,
        physical_model,
        write.effective_start,
        predecessor.as_ref(),
    )?;
    let version_id = Uuid::new_v4();
    insert_version_row(
        client,
        VersionInsert {
            apply,
            model,
            physical_model,
            physical_models,
            change_set_id,
            version_id,
            record_id: prepared_write.record_id,
            write,
            effective_end,
            snapshot: &snapshot,
            custom_fields: &custom_fields,
            stage: "mainline",
            applied_at: Some(Utc::now()),
        },
    )?;
    Ok(LoadedVersion {
        version_id,
        effective_start: write.effective_start,
        effective_end,
        applied_order,
        values: snapshot,
        custom_fields,
        tombstones_record: write.tombstones_record,
        untombstones_record: false,
    })
}

fn close_displaced_mainline_version(
    client: &mut impl GenericClient,
    apply: &ApplyChangeSet,
    physical_model: &PhysicalModel,
    effective_start: NaiveDate,
    predecessor: Option<&LoadedVersion>,
) -> Result<(), DbError> {
    close_displaced_mainline_version_for_scope(
        client,
        &apply.app_id,
        &apply.customer_id,
        physical_model,
        effective_start,
        predecessor,
    )
}

fn close_displaced_mainline_version_for_scope(
    client: &mut impl GenericClient,
    app_id: &AppId,
    customer_id: &CustomerId,
    physical_model: &PhysicalModel,
    effective_start: NaiveDate,
    predecessor: Option<&LoadedVersion>,
) -> Result<(), DbError> {
    let Some(predecessor) = predecessor else {
        return Ok(());
    };
    let displaced_end = if predecessor.effective_start == effective_start
        && !predecessor.tombstones_record
        && !predecessor.untombstones_record
    {
        effective_start
    } else if predecessor.effective_start < effective_start {
        effective_start
            .checked_sub_signed(Duration::days(1))
            .ok_or_else(|| DbError::TimelineConflict {
                details: format!(
                    "effective_start `{effective_start}` is too early to close a prior version range"
                ),
            })?
    } else {
        return Ok(());
    };
    client.execute(
        &format!(
            r#"
            update {}
            set effective_end = $4
            where id = $1 and app_id = $2 and customer_id = $3 and stage = 'mainline'
            "#,
            quote_identifier(&physical_model.version_table)
        ),
        &[
            &predecessor.version_id,
            &app_id.as_str(),
            &customer_id.as_str(),
            &displaced_end,
        ],
    )?;
    Ok(())
}

fn apply_prepared_draft_write(
    client: &mut impl GenericClient,
    apply: &ApplyChangeSet,
    schema: &Schema,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
    change_set_id: i64,
    prepared_write: &PreparedDraftWrite<'_>,
) -> Result<(), DbError> {
    let write = prepared_write.write;
    let model = schema
        .models
        .iter()
        .find(|model| model.id == write.model_id)
        .expect("write model was validated");
    let physical_model = physical_models
        .get(&write.model_id)
        .expect("write model was materialized");
    let record_id = prepared_write.record_id;
    let uniqueness_key = MainlineUniquenessKey {
        record_id,
        effective_start: write.effective_start,
        tombstones_record: write.tombstones_record,
        untombstones_record: false,
    };
    if write.tombstones_record {
        ensure_no_same_day_mainline(
            client,
            &apply.app_id,
            &apply.customer_id,
            physical_model,
            uniqueness_key,
        )?;
    }
    ensure_no_same_day_draft(client, apply, physical_model, change_set_id, uniqueness_key)?;
    ensure_no_later_draft_version(
        client,
        apply,
        physical_model,
        change_set_id,
        record_id,
        write.effective_start,
    )?;
    let previous = load_previous_version(
        client,
        PreviousVersionScope {
            app_id: &apply.app_id,
            customer_id: &apply.customer_id,
            draft_change_set_id: Some(change_set_id),
        },
        schema,
        model,
        physical_models,
        record_id,
        write.effective_start,
    )?;
    if previous
        .as_ref()
        .is_some_and(|version| version.tombstones_record && !write.tombstones_record)
    {
        return Err(DbError::TombstonedRecord {
            details: format!(
                "record `{record_id}` is tombstoned before {}",
                write.effective_start
            ),
        });
    }

    let (mut snapshot, mut custom_fields) = previous.map_or_else(
        || (BTreeMap::new(), Vec::new()),
        |version| (version.values, version.custom_fields),
    );
    if !write.tombstones_record {
        if let Some(values) = &write.values {
            for (field_id, value) in values {
                let field = model
                    .fields
                    .iter()
                    .find(|field| field.id == *field_id)
                    .expect("field was validated");
                snapshot.insert(
                    field_id.clone(),
                    resolve_field_value(
                        client,
                        FieldResolutionScope {
                            apply,
                            draft_change_set_id: Some(change_set_id),
                        },
                        schema,
                        physical_models,
                        field,
                        value,
                        write.effective_start,
                    )?,
                );
            }
        }
        custom_fields = overlay_custom_fields(
            client,
            CustomFieldOverlayRequest {
                scope: FieldResolutionScope {
                    apply,
                    draft_change_set_id: Some(change_set_id),
                },
                schema,
                physical_models,
                model_id: &write.model_id,
                existing: custom_fields,
                incoming: write.custom_fields.as_deref(),
                as_of: write.effective_start,
            },
        )?;
    }
    let next_mainline_start = next_version_start(
        client,
        apply,
        physical_model,
        record_id,
        write.effective_start,
    )?;
    let next_draft_start = next_draft_version_start(
        client,
        apply,
        physical_model,
        change_set_id,
        record_id,
        write.effective_start,
    )?;
    if write.tombstones_record && next_mainline_start.or(next_draft_start).is_some() {
        return Err(DbError::TimelineConflict {
            details: format!(
                "tombstone for record `{record_id}` at {} would precede a later version",
                write.effective_start
            ),
        });
    }

    insert_version_row(
        client,
        VersionInsert {
            apply,
            model,
            physical_model,
            physical_models,
            change_set_id,
            version_id: Uuid::new_v4(),
            record_id,
            write,
            effective_end: None,
            snapshot: &snapshot,
            custom_fields: &custom_fields,
            stage: "draft",
            applied_at: None,
        },
    )?;
    Ok(())
}

fn insert_record_row(
    client: &mut impl GenericClient,
    physical_model: &PhysicalModel,
    apply: &ApplyChangeSet,
    record_id: RecordId,
    external_key: Option<&str>,
) -> Result<(), DbError> {
    let result = match external_key {
        Some(external_key) => client.execute(
            &format!(
                "insert into {} (id, app_id, customer_id, external_key) values ($1, $2, $3, $4)",
                quote_identifier(&physical_model.record_table)
            ),
            &[
                &record_id,
                &apply.app_id.as_str(),
                &apply.customer_id.as_str(),
                &external_key,
            ],
        ),
        None => client.execute(
            &format!(
                "insert into {} (id, app_id, customer_id) values ($1, $2, $3) on conflict (id) do nothing",
                quote_identifier(&physical_model.record_table)
            ),
            &[
                &record_id,
                &apply.app_id.as_str(),
                &apply.customer_id.as_str(),
            ],
        ),
    };
    match result {
        Ok(1) => Ok(()),
        Ok(0)
            if external_key.is_none()
                && reusable_discarded_subject(client, physical_model, apply, record_id)? =>
        {
            Ok(())
        }
        Ok(_) => Err(DbError::RecordKeyConflict {
            details: format!("record_id `{record_id}` already exists"),
        }),
        Err(error) if error.code() == Some(&postgres::error::SqlState::UNIQUE_VIOLATION) => {
            Err(DbError::RecordKeyConflict {
                details: match external_key {
                    Some(external_key) => format!("external_key `{external_key}` already exists"),
                    None => format!("record_id `{record_id}` already exists"),
                },
            })
        }
        Err(error) => Err(error.into()),
    }
}

fn reusable_discarded_subject(
    client: &mut impl GenericClient,
    physical_model: &PhysicalModel,
    apply: &ApplyChangeSet,
    record_id: RecordId,
) -> Result<bool, DbError> {
    let Some(_) = client.query_opt(
        &format!(
            "select id from {} where id = $1 and app_id = $2 and customer_id = $3 for update",
            quote_identifier(&physical_model.record_table)
        ),
        &[
            &record_id,
            &apply.app_id.as_str(),
            &apply.customer_id.as_str(),
        ],
    )?
    else {
        return Ok(false);
    };
    client
        .query_one(
            &format!(
                r#"
                select
                  exists (
                    select 1 from {} where record_id = $1 and app_id = $2 and customer_id = $3 and stage = 'discarded'
                  )
                  and not exists (
                    select 1 from {} where record_id = $1 and app_id = $2 and customer_id = $3 and stage <> 'discarded'
                  ) as reusable
                "#,
                quote_identifier(&physical_model.version_table),
                quote_identifier(&physical_model.version_table)
            ),
            &[
                &record_id,
                &apply.app_id.as_str(),
                &apply.customer_id.as_str(),
            ],
        )
        .map(|row| row.get("reusable"))
        .map_err(Into::into)
}

fn resolve_existing_record(
    client: &mut impl GenericClient,
    apply: &ApplyChangeSet,
    physical_model: &PhysicalModel,
    record_key: &RecordKey,
    as_of: NaiveDate,
    require_visible: bool,
) -> Result<RecordId, DbError> {
    let table = quote_identifier(&physical_model.record_table);
    let row = match record_key {
        RecordKey::RecordId(record_id) => client.query_opt(
            &format!(
                "select id from {table} where app_id = $1 and customer_id = $2 and id = $3 for update"
            ),
            &[&apply.app_id.as_str(), &apply.customer_id.as_str(), record_id],
        )?,
        RecordKey::ExternalKey(external_key) => client.query_opt(
            &format!(
                "select id from {table} where app_id = $1 and customer_id = $2 and external_key = $3 for update"
            ),
            &[
                &apply.app_id.as_str(),
                &apply.customer_id.as_str(),
                &external_key.as_str(),
            ],
        )?,
        RecordKey::LookupOrCreate { .. } => {
            return Err(lookup_or_create_requires_generated_sql("record_key"));
        }
    };
    let Some(row) = row else {
        return Err(DbError::RecordTargetMissing {
            details: format!("record key `{record_key:?}` did not resolve"),
        });
    };
    let record_id = row.get("id");
    if require_visible {
        match record_visibility(client, apply, physical_model, record_id, as_of)? {
            Some(false) => {}
            Some(true) => {
                return Err(DbError::TombstonedRecord {
                    details: format!("record `{record_id}` is tombstoned as of {as_of}"),
                })
            }
            None => {
                return Err(DbError::RecordTargetMissing {
                    details: format!("record `{record_id}` is not visible as of {as_of}"),
                })
            }
        }
    }
    Ok(record_id)
}

#[derive(Clone, Copy)]
struct FieldResolutionScope<'a> {
    apply: &'a ApplyChangeSet,
    draft_change_set_id: Option<i64>,
}

fn record_visibility(
    client: &mut impl GenericClient,
    apply: &ApplyChangeSet,
    physical_model: &PhysicalModel,
    record_id: RecordId,
    as_of: NaiveDate,
) -> Result<Option<bool>, DbError> {
    record_visibility_for_scope(
        client,
        &apply.app_id,
        &apply.customer_id,
        physical_model,
        record_id,
        as_of,
    )
}

fn record_visibility_for_scope(
    client: &mut impl GenericClient,
    app_id: &AppId,
    customer_id: &CustomerId,
    physical_model: &PhysicalModel,
    record_id: RecordId,
    as_of: NaiveDate,
) -> Result<Option<bool>, DbError> {
    // Keep this as-of visibility predicate in sync with the query_visible_sql
    // temp views and relation_target_visibility. This is the apply-time
    // record-target check for existing record writes.
    ensure_mainline_version_order_integrity(client, physical_model, app_id, customer_id)?;
    let precedence = version_precedence_sql("v", "cs", VersionOrderDirection::Descending, false);
    let row = client.query_opt(
        &format!(
            r#"
            select v.tombstones_record
            from {} v
            join change_set cs
              on cs.id = v.change_set_id
             and cs.app_id = v.app_id
             and cs.customer_id = v.customer_id
             and cs.status = 'mainline'
             and cs.applied_order is not null
            where v.record_id = $1
              and v.app_id = $2
              and v.customer_id = $3
              and v.stage = 'mainline'
              and v.effective_start <= $4
              and (v.effective_end is null or v.effective_end >= $4)
            order by
              {precedence}
            limit 1
            "#,
            quote_identifier(&physical_model.version_table)
        ),
        &[&record_id, &app_id.as_str(), &customer_id.as_str(), &as_of],
    )?;
    Ok(row.map(|row| row.get("tombstones_record")))
}

fn relation_target_visibility(
    client: &mut impl GenericClient,
    scope: FieldResolutionScope<'_>,
    _target_model_id: &ModelId,
    physical_model: &PhysicalModel,
    record_id: RecordId,
    as_of: NaiveDate,
) -> Result<Option<bool>, DbError> {
    relation_target_visibility_for_scope(
        client,
        &scope.apply.app_id,
        &scope.apply.customer_id,
        scope.draft_change_set_id,
        physical_model,
        record_id,
        as_of,
    )
}

fn relation_target_visibility_for_scope(
    client: &mut impl GenericClient,
    app_id: &AppId,
    customer_id: &CustomerId,
    draft_change_set_id: Option<i64>,
    physical_model: &PhysicalModel,
    record_id: RecordId,
    as_of: NaiveDate,
) -> Result<Option<bool>, DbError> {
    // Keep this as-of visibility predicate in sync with the query_visible_sql
    // temp views and record_visibility. This variant also considers the active
    // draft change set so relation rewrites can point at rows introduced in
    // the same draft group.
    ensure_mainline_version_order_integrity(client, physical_model, app_id, customer_id)?;
    let precedence = version_precedence_sql("v", "cs", VersionOrderDirection::Descending, true);
    let row = client.query_opt(
        &format!(
            r#"
            select v.tombstones_record
            from {} v
            join change_set cs
              on cs.id = v.change_set_id
             and cs.app_id = v.app_id
             and cs.customer_id = v.customer_id
            where v.record_id = $1
              and v.app_id = $2
              and v.customer_id = $3
              and v.effective_start <= $4
              and (
                (v.stage = 'mainline' and cs.status = 'mainline' and cs.applied_order is not null)
                or (
                  $5::bigint is not null
                  and v.change_set_id = $5
                  and v.stage = 'draft'
                  and cs.status = 'draft'
                  and cs.applied_order is null
                )
              )
            order by
              {precedence}
            limit 1
            "#,
            quote_identifier(&physical_model.version_table)
        ),
        &[
            &record_id,
            &app_id.as_str(),
            &customer_id.as_str(),
            &as_of,
            &draft_change_set_id,
        ],
    )?;
    Ok(row.map(|row| row.get("tombstones_record")))
}

#[derive(Debug, Clone, PartialEq)]
struct LoadedVersion {
    version_id: Uuid,
    effective_start: NaiveDate,
    effective_end: Option<NaiveDate>,
    applied_order: i64,
    values: BTreeMap<FieldId, FieldValue>,
    custom_fields: Vec<CustomFieldEntry>,
    tombstones_record: bool,
    untombstones_record: bool,
}

struct PreviousVersionScope<'a> {
    app_id: &'a AppId,
    customer_id: &'a CustomerId,
    draft_change_set_id: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
struct DraftVersionRow {
    model_id: ModelId,
    version_id: Uuid,
    change_set_id: i64,
    record_id: RecordId,
    effective_start: NaiveDate,
    tombstones_record: bool,
    untombstones_record: bool,
    values: BTreeMap<FieldId, FieldValue>,
    custom_fields: Vec<CustomFieldEntry>,
}

#[derive(Debug, Clone, PartialEq)]
struct RevertTimelineVersion {
    version_id: Uuid,
    change_set_id: i64,
    effective_start: NaiveDate,
    effective_end: Option<NaiveDate>,
    applied_order: i64,
    tombstones_record: bool,
    untombstones_record: bool,
    values: BTreeMap<FieldId, FieldValue>,
    custom_fields: Vec<CustomFieldEntry>,
}

#[derive(Debug, Clone, PartialEq)]
struct PreparedRevertSubject {
    model_id: ModelId,
    record_id: RecordId,
    timeline: Vec<RevertTimelineVersion>,
}

struct PreparedRevert {
    target_rows: Vec<DraftVersionRow>,
    subjects: Vec<PreparedRevertSubject>,
    relation_targets: BTreeMap<ScopedRecordAddress, RecordId>,
}

#[derive(Debug, Clone)]
struct HistoryVersionRow {
    version_id: Uuid,
    change_set_id: i64,
    record_id: RecordId,
    external_key: Option<String>,
    stage: VersionStage,
    effective_start: NaiveDate,
    effective_end: Option<NaiveDate>,
    tombstones_record: bool,
    untombstones_record: bool,
    causal_order: i64,
    values: BTreeMap<FieldId, FieldValue>,
    custom_fields: Vec<CustomFieldEntry>,
}

fn load_draft_records_for_model(
    client: &mut impl GenericClient,
    change_set_id: i64,
    schema: &Schema,
    model: &Model,
    physical_model: &PhysicalModel,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
) -> Result<Vec<DraftRecord>, DbError> {
    let field_columns = model_field_columns(model, physical_models)?;
    let select_columns = field_columns
        .iter()
        .flat_map(|(_, columns)| columns.iter())
        .map(|column| column.select_sql("v"))
        .collect::<Vec<_>>();
    let mut select_sql = "v.record_id, r.external_key, v.effective_start, v.effective_end, v.tombstones_record, v.untombstones_record, v.custom_fields".to_string();
    if !select_columns.is_empty() {
        select_sql.push_str(", ");
        select_sql.push_str(&select_columns.join(", "));
    }
    let sql = format!(
        r#"
        select {select_sql}
        from {} v
        join {} r
          on r.id = v.record_id
         and r.app_id = v.app_id
         and r.customer_id = v.customer_id
        where v.app_id = $1
          and v.customer_id = $2
          and v.change_set_id = $3
          and v.stage = 'draft'
        order by
          v.effective_start,
          v.tombstones_record,
          v.untombstones_record,
          v.id
        "#,
        quote_identifier(&physical_model.version_table),
        quote_identifier(&physical_model.record_table)
    );
    let rows = client.query(
        &sql,
        &[
            &schema.app_id.as_str(),
            &schema.customer_id.as_str(),
            &change_set_id,
        ],
    )?;
    let mut records = Vec::with_capacity(rows.len());
    for row in rows {
        let mut values = BTreeMap::new();
        let custom_fields = custom_fields_from_json_for_schema(schema, &model.id, row.get(6))?;
        let mut offset = 7;
        for (field, columns) in &field_columns {
            if let Some(value) = field_value_from_row(&row, offset, field, columns)? {
                values.insert(field.id.clone(), value);
            }
            offset += columns.len();
        }
        records.push(DraftRecord {
            change_set_id,
            model_id: model.id.clone(),
            record_id: row.get(0),
            external_key: row.get(1),
            effective_start: row.get(2),
            effective_end: row.get(3),
            tombstones_record: row.get(4),
            untombstones_record: row.get(5),
            values,
            custom_fields,
            metadata: Map::new(),
            many_relations: BTreeMap::new(),
            availability: None,
        });
    }
    Ok(records)
}

#[allow(clippy::too_many_arguments)]
fn load_draft_version_rows_for_model(
    client: &mut impl GenericClient,
    app_id: &AppId,
    customer_id: &CustomerId,
    change_set_id: i64,
    schema: &Schema,
    model: &Model,
    physical_model: &PhysicalModel,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
) -> Result<Vec<DraftVersionRow>, DbError> {
    let field_columns = model_field_columns(model, physical_models)?;
    let select_columns = field_columns
        .iter()
        .flat_map(|(_, columns)| columns.iter())
        .map(|column| column.select_sql(""))
        .collect::<Vec<_>>();
    let mut select_sql =
        "id, record_id, effective_start, tombstones_record, untombstones_record, custom_fields"
            .to_string();
    if !select_columns.is_empty() {
        select_sql.push_str(", ");
        select_sql.push_str(&select_columns.join(", "));
    }
    let rows = client.query(
        &format!(
            r#"
            select {select_sql}
            from {}
            where app_id = $1
              and customer_id = $2
              and change_set_id = $3
              and stage = 'draft'
            order by
              effective_start,
              tombstones_record,
              untombstones_record,
              id
            for update
            "#,
            quote_identifier(&physical_model.version_table)
        ),
        &[&app_id.as_str(), &customer_id.as_str(), &change_set_id],
    )?;
    let mut draft_rows = Vec::with_capacity(rows.len());
    for row in rows {
        let mut values = BTreeMap::new();
        let custom_fields =
            custom_fields_from_json_for_schema(schema, &model.id, row.get("custom_fields"))?;
        let mut offset = 6;
        for (field, columns) in &field_columns {
            if let Some(value) = field_value_from_row(&row, offset, field, columns)? {
                values.insert(field.id.clone(), value);
            }
            offset += columns.len();
        }
        draft_rows.push(DraftVersionRow {
            model_id: model.id.clone(),
            version_id: row.get("id"),
            change_set_id,
            record_id: row.get("record_id"),
            effective_start: row.get("effective_start"),
            tombstones_record: row.get("tombstones_record"),
            untombstones_record: row.get("untombstones_record"),
            values,
            custom_fields,
        });
    }
    Ok(draft_rows)
}

#[allow(clippy::too_many_arguments)]
fn load_revert_target_rows_for_model(
    client: &mut impl GenericClient,
    app_id: &AppId,
    customer_id: &CustomerId,
    change_set_id: i64,
    schema: &Schema,
    model: &Model,
    physical_model: &PhysicalModel,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
) -> Result<Vec<DraftVersionRow>, DbError> {
    let field_columns = model_field_columns(model, physical_models)?;
    let select_columns = field_columns
        .iter()
        .flat_map(|(_, columns)| columns.iter())
        .map(|column| column.select_sql(""))
        .collect::<Vec<_>>();
    let mut select_sql =
        "id, record_id, effective_start, tombstones_record, untombstones_record, custom_fields"
            .to_string();
    if !select_columns.is_empty() {
        select_sql.push_str(", ");
        select_sql.push_str(&select_columns.join(", "));
    }
    let rows = client.query(
        &format!(
            r#"
            select {select_sql}
            from {}
            where app_id = $1
              and customer_id = $2
              and change_set_id = $3
              and stage = 'mainline'
            order by
              effective_start,
              tombstones_record,
              untombstones_record,
              id
            "#,
            quote_identifier(&physical_model.version_table)
        ),
        &[&app_id.as_str(), &customer_id.as_str(), &change_set_id],
    )?;
    let mut target_rows = Vec::with_capacity(rows.len());
    for row in rows {
        let mut values = BTreeMap::new();
        let custom_fields =
            custom_fields_from_json_for_schema(schema, &model.id, row.get("custom_fields"))?;
        let mut offset = 6;
        for (field, columns) in &field_columns {
            if let Some(value) = field_value_from_row(&row, offset, field, columns)? {
                values.insert(field.id.clone(), value);
            }
            offset += columns.len();
        }
        target_rows.push(DraftVersionRow {
            model_id: model.id.clone(),
            version_id: row.get("id"),
            change_set_id,
            record_id: row.get("record_id"),
            effective_start: row.get("effective_start"),
            tombstones_record: row.get("tombstones_record"),
            untombstones_record: row.get("untombstones_record"),
            values,
            custom_fields,
        });
    }
    Ok(target_rows)
}

fn load_revert_target_rows(
    client: &mut impl GenericClient,
    request: &RevertChangeSet,
    schema: &Schema,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
) -> Result<Vec<DraftVersionRow>, DbError> {
    let mut target_rows = Vec::new();
    for model in &schema.models {
        let physical_model = physical_models
            .get(&model.id)
            .expect("model was materialized");
        target_rows.extend(load_revert_target_rows_for_model(
            client,
            &request.app_id,
            &request.customer_id,
            request.change_set_id,
            schema,
            model,
            physical_model,
            physical_models,
        )?);
    }
    Ok(target_rows)
}

fn load_revert_timeline_for_subject(
    client: &mut impl GenericClient,
    request: &RevertChangeSet,
    schema: &Schema,
    model: &Model,
    physical_model: &PhysicalModel,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
    record_id: RecordId,
) -> Result<PreparedRevertSubject, DbError> {
    ensure_mainline_version_order_integrity(
        client,
        physical_model,
        &request.app_id,
        &request.customer_id,
    )?;
    let field_columns = model_field_columns(model, physical_models)?;
    let selected_columns = field_columns
        .iter()
        .flat_map(|(_, columns)| columns.iter())
        .map(|column| column.select_sql("v"))
        .collect::<Vec<_>>();
    let mut select_sql = r#"
        v.id,
        v.change_set_id,
        v.effective_start,
        v.effective_end,
        v.tombstones_record,
        v.untombstones_record,
        cs.applied_order
    "#
    .to_string();
    if !selected_columns.is_empty() {
        select_sql.push_str(", ");
        select_sql.push_str(&selected_columns.join(", "));
    }
    select_sql.push_str(", v.custom_fields");
    let precedence = version_precedence_sql("v", "cs", VersionOrderDirection::Ascending, false);
    let rows = client.query(
        &format!(
            r#"
            select {select_sql}
            from {} v
            join change_set cs
              on cs.id = v.change_set_id
             and cs.app_id = v.app_id
             and cs.customer_id = v.customer_id
             and cs.status = 'mainline'
             and cs.applied_order is not null
            where v.record_id = $1
              and v.app_id = $2
              and v.customer_id = $3
              and v.stage = 'mainline'
              and v.change_set_id <> $4
            order by {precedence}
            "#,
            quote_identifier(&physical_model.version_table)
        ),
        &[
            &record_id,
            &request.app_id.as_str(),
            &request.customer_id.as_str(),
            &request.change_set_id,
        ],
    )?;
    let mut timeline = Vec::with_capacity(rows.len());
    for row in rows {
        let mut values = BTreeMap::new();
        let mut offset = 7;
        for (field, columns) in &field_columns {
            if let Some(value) = field_value_from_row(&row, offset, field, columns)? {
                values.insert(field.id.clone(), value);
            }
            offset += columns.len();
        }
        let custom_fields = custom_fields_from_json_for_schema(schema, &model.id, row.get(offset))?;
        timeline.push(RevertTimelineVersion {
            version_id: row.get("id"),
            change_set_id: row.get("change_set_id"),
            effective_start: row.get("effective_start"),
            effective_end: row.get("effective_end"),
            applied_order: row.get("applied_order"),
            tombstones_record: row.get("tombstones_record"),
            untombstones_record: row.get("untombstones_record"),
            values,
            custom_fields,
        });
    }
    Ok(PreparedRevertSubject {
        model_id: model.id.clone(),
        record_id,
        timeline,
    })
}

fn diff_source_change_set(
    client: &mut impl GenericClient,
    request: &ChangeSetDiffRequest,
) -> Result<(SchemaRevisionId, i64), DbError> {
    let Some(row) = client.query_opt(
        r#"
        select schema_revision_id, source_kind, source_ref
        from change_set
        where id = $1 and app_id = $2 and customer_id = $3
        "#,
        &[
            &request.change_set_id,
            &request.app_id.as_str(),
            &request.customer_id.as_str(),
        ],
    )?
    else {
        return Err(DbError::RecordTargetMissing {
            details: format!("change_set `{}` did not resolve", request.change_set_id),
        });
    };
    let schema_revision_id = SchemaRevisionId::new(row.get("schema_revision_id"));
    let source_kind: String = row.get("source_kind");
    if source_kind != "revert" {
        return Ok((schema_revision_id, request.change_set_id));
    }
    let Some(source_ref) = row.get::<_, Option<String>>("source_ref") else {
        return Err(DbError::SchemaDrift {
            object: "change_set.source_ref".to_string(),
            details: format!(
                "revert change_set `{}` has no source_ref",
                request.change_set_id
            ),
        });
    };
    let source_change_set_id = source_ref
        .parse::<i64>()
        .map_err(|error| DbError::SchemaDrift {
            object: "change_set.source_ref".to_string(),
            details: format!(
                "revert change_set `{}` source_ref is not a change_set id: {error}",
                request.change_set_id
            ),
        })?;
    Ok((schema_revision_id, source_change_set_id))
}

fn load_history_version_rows_for_model(
    client: &mut impl GenericClient,
    change_set_id: i64,
    schema: &Schema,
    model: &Model,
    physical_model: &PhysicalModel,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
) -> Result<Vec<HistoryVersionRow>, DbError> {
    ensure_mainline_version_order_integrity(
        client,
        physical_model,
        &schema.app_id,
        &schema.customer_id,
    )?;
    let field_columns = model_field_columns(model, physical_models)?;
    let select_columns = field_columns
        .iter()
        .flat_map(|(_, columns)| columns.iter())
        .map(|column| column.select_sql("v"))
        .collect::<Vec<_>>();
    let mut select_sql = r#"
        v.id,
        v.change_set_id,
        v.record_id,
        r.external_key,
        v.stage,
        v.effective_start,
        v.effective_end,
        v.tombstones_record,
        v.untombstones_record
        , case when v.stage in ('mainline', 'reverted') then cs.applied_order else cs.created_order end as causal_order
    "#
    .to_string();
    if !select_columns.is_empty() {
        select_sql.push_str(", ");
        select_sql.push_str(&select_columns.join(", "));
    }
    select_sql.push_str(", v.custom_fields");
    let precedence = version_precedence_sql("v", "cs", VersionOrderDirection::Ascending, true);
    let rows = client.query(
        &format!(
            r#"
            select {select_sql}
            from {} v
            join {} r
              on r.id = v.record_id
             and r.app_id = v.app_id
             and r.customer_id = v.customer_id
            join change_set cs
              on cs.id = v.change_set_id
             and cs.app_id = v.app_id
             and cs.customer_id = v.customer_id
            where v.app_id = $1
              and v.customer_id = $2
              and v.change_set_id = $3
              and (
                (v.stage in ('mainline', 'reverted') and cs.status = 'mainline' and cs.applied_order is not null)
                or (v.stage = 'draft' and cs.status = 'draft' and cs.applied_order is null)
                or (v.stage = 'discarded' and cs.status = 'discarded' and cs.applied_order is null)
              )
            order by {precedence}
            "#,
            quote_identifier(&physical_model.version_table),
            quote_identifier(&physical_model.record_table)
        ),
        &[
            &schema.app_id.as_str(),
            &schema.customer_id.as_str(),
            &change_set_id,
        ],
    )?;
    rows.into_iter()
        .map(|row| {
            let mut values = BTreeMap::new();
            let mut offset = 10;
            for (field, columns) in &field_columns {
                if let Some(value) = field_value_from_row(&row, offset, field, columns)? {
                    values.insert(field.id.clone(), value);
                }
                offset += columns.len();
            }
            let custom_fields =
                custom_fields_from_json_for_schema(schema, &model.id, row.get(offset))?;
            Ok(HistoryVersionRow {
                version_id: row.get("id"),
                change_set_id: row.get("change_set_id"),
                record_id: row.get("record_id"),
                external_key: row.get("external_key"),
                stage: version_stage_from_str(row.get::<_, String>("stage").as_str())?,
                effective_start: row.get("effective_start"),
                effective_end: row.get("effective_end"),
                tombstones_record: row.get("tombstones_record"),
                untombstones_record: row.get("untombstones_record"),
                causal_order: row.get("causal_order"),
                values,
                custom_fields,
            })
        })
        .collect()
}

fn requested_stage_strings(stages: &[VersionStage]) -> Vec<String> {
    let stages = if stages.is_empty() {
        vec![VersionStage::Mainline, VersionStage::Reverted]
    } else {
        stages.to_vec()
    };
    stages
        .iter()
        .map(|stage| stage.as_str().to_string())
        .collect()
}

fn requested_status_strings(statuses: &[ChangeSetStatus]) -> Vec<String> {
    let statuses = if statuses.is_empty() {
        vec![ChangeSetStatus::Mainline, ChangeSetStatus::Draft]
    } else {
        statuses.to_vec()
    };
    statuses
        .iter()
        .map(|status| status.as_str().to_string())
        .collect()
}

fn version_stage_from_str(value: &str) -> Result<VersionStage, DbError> {
    match value {
        "draft" => Ok(VersionStage::Draft),
        "mainline" => Ok(VersionStage::Mainline),
        "discarded" => Ok(VersionStage::Discarded),
        "reverted" => Ok(VersionStage::Reverted),
        _ => Err(DbError::SchemaDrift {
            object: "version.stage".to_string(),
            details: format!("unknown stage `{value}`"),
        }),
    }
}

fn change_set_status_from_str(value: &str) -> Result<ChangeSetStatus, DbError> {
    match value {
        "draft" => Ok(ChangeSetStatus::Draft),
        "mainline" => Ok(ChangeSetStatus::Mainline),
        "discarded" => Ok(ChangeSetStatus::Discarded),
        _ => Err(DbError::SchemaDrift {
            object: "change_set.status".to_string(),
            details: format!("unknown status `{value}`"),
        }),
    }
}

fn touched_record_count(
    client: &mut impl GenericClient,
    app_id: &AppId,
    customer_id: &CustomerId,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
    change_set_id: i64,
    source_kind: &str,
    source_ref: Option<&str>,
) -> Result<i64, DbError> {
    let version_change_set_id = if source_kind == "revert" {
        let Some(source_ref) = source_ref else {
            return Err(DbError::SchemaDrift {
                object: "change_set.source_ref".to_string(),
                details: format!("revert change_set `{change_set_id}` has no source_ref"),
            });
        };
        source_ref
            .parse::<i64>()
            .map_err(|error| DbError::SchemaDrift {
                object: "change_set.source_ref".to_string(),
                details: format!(
                "revert change_set `{change_set_id}` source_ref is not a change_set id: {error}"
            ),
            })?
    } else {
        change_set_id
    };
    let mut touched = 0;
    for physical_model in physical_models.values() {
        let mut sql = format!(
            r#"
            select count(distinct record_id)
            from {}
            where app_id = $1
              and customer_id = $2
              and change_set_id = $3
            "#,
            quote_identifier(&physical_model.version_table)
        );
        if source_kind == "revert" {
            sql.push_str(" and stage = 'reverted'");
        }
        touched += client
            .query_one(
                &sql,
                &[
                    &app_id.as_str(),
                    &customer_id.as_str(),
                    &version_change_set_id,
                ],
            )?
            .get::<_, i64>(0);
    }
    Ok(touched)
}

fn reject_draft_live_unique_conflicts(
    client: &mut impl GenericClient,
    app_id: &AppId,
    customer_id: &CustomerId,
    schema: &Schema,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
    draft_rows: &[DraftVersionRow],
) -> Result<(), DbError> {
    let mut latest_by_record = BTreeMap::new();
    for draft in draft_rows {
        let key = (draft.model_id.clone(), draft.record_id);
        match latest_by_record.entry(key) {
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert(draft);
            }
            std::collections::btree_map::Entry::Occupied(mut entry)
                if entry.get().effective_start < draft.effective_start =>
            {
                entry.insert(draft);
            }
            std::collections::btree_map::Entry::Occupied(_) => {}
        }
    }

    let mut live_heads = Vec::new();
    for draft in latest_by_record.into_values() {
        if draft.tombstones_record {
            continue;
        }
        let physical_model = physical_models
            .get(&draft.model_id)
            .expect("draft model was materialized");
        if next_version_start_for_scope(
            client,
            app_id,
            customer_id,
            physical_model,
            draft.record_id,
            draft.effective_start,
        )?
        .is_none()
        {
            live_heads.push(draft);
        }
    }

    for (index, left) in live_heads.iter().enumerate() {
        let model = schema
            .models
            .iter()
            .find(|model| model.id == left.model_id)
            .expect("draft model was loaded from schema");
        for right in live_heads
            .iter()
            .skip(index + 1)
            .filter(|right| right.model_id == left.model_id && right.record_id != left.record_id)
        {
            for field in model.fields.iter().filter(|field| field.is_unique) {
                let Some(left_value) = left.values.get(&field.id) else {
                    continue;
                };
                if right.values.get(&field.id) == Some(left_value) {
                    return Err(DbError::UniqueFieldConflict {
                        model: model.id.to_string(),
                        field: field.id.to_string(),
                        value: field_value_display(left_value),
                    });
                }
            }
        }
    }
    Ok(())
}

fn reject_stale_draft(
    client: &mut impl GenericClient,
    app_id: &AppId,
    customer_id: &CustomerId,
    change_set_id: i64,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
    draft_rows: &[DraftVersionRow],
) -> Result<(), DbError> {
    let draft_created_order: i64 = client
        .query_one(
            "select created_order from change_set where id = $1 and app_id = $2 and customer_id = $3",
            &[&change_set_id, &app_id.as_str(), &customer_id.as_str()],
        )?
        .get("created_order");
    let mut stale = Vec::new();
    for draft in draft_rows {
        let physical_model = physical_models
            .get(&draft.model_id)
            .expect("draft model was materialized");
        let rows = client.query(
            &format!(
                r#"
                select distinct v.change_set_id, cs.applied_order
                from {} v
                join change_set cs
                  on cs.id = v.change_set_id
                 and cs.app_id = v.app_id
                 and cs.customer_id = v.customer_id
                where v.record_id = $1
                  and v.app_id = $2
                  and v.customer_id = $3
                  and v.stage = 'mainline'
                  and v.change_set_id <> $4
                  and cs.applied_order is not null
                  and cs.applied_order > $5
                order by cs.applied_order, v.change_set_id
                "#,
                quote_identifier(&physical_model.version_table)
            ),
            &[
                &draft.record_id,
                &app_id.as_str(),
                &customer_id.as_str(),
                &change_set_id,
                &draft_created_order,
            ],
        )?;
        for row in rows {
            let updated_change_set_id: i64 = row.get("change_set_id");
            stale.push(format!(
                "{}:{} updated by change_set `{updated_change_set_id}`",
                draft.model_id, draft.record_id
            ));
        }
        let rows = client.query(
            &format!(
                r#"
                select distinct revert_cs.id, revert_cs.applied_order
                from {} v
                join change_set revert_cs
                  on revert_cs.app_id = v.app_id
                 and revert_cs.customer_id = v.customer_id
                 and revert_cs.source_kind = 'revert'
                 and revert_cs.source_ref = v.change_set_id::text
                where v.record_id = $1
                  and v.app_id = $2
                  and v.customer_id = $3
                  and v.stage = 'reverted'
                  and v.change_set_id <> $4
                  and revert_cs.status = 'mainline'
                  and revert_cs.applied_order is not null
                  and revert_cs.applied_order > $5
                order by revert_cs.applied_order, revert_cs.id
                "#,
                quote_identifier(&physical_model.version_table)
            ),
            &[
                &draft.record_id,
                &app_id.as_str(),
                &customer_id.as_str(),
                &change_set_id,
                &draft_created_order,
            ],
        )?;
        for row in rows {
            let reverted_by_change_set_id: i64 = row.get("id");
            stale.push(format!(
                "{}:{} reverted by change_set `{reverted_by_change_set_id}`",
                draft.model_id, draft.record_id
            ));
        }
    }
    if !stale.is_empty() {
        stale.sort();
        stale.dedup();
        return Err(DbError::StaleDraft {
            details: stale.join("; "),
        });
    }
    Ok(())
}

fn prepare_revert(
    client: &mut impl GenericClient,
    request: &RevertChangeSet,
    schema: &Schema,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
    target_applied_order: i64,
) -> Result<PreparedRevert, DbError> {
    let target_rows = load_revert_target_rows(client, request, schema, physical_models)?;
    if target_rows.is_empty() {
        return Err(DbError::AlreadyReverted {
            details: format!(
                "change_set `{}` has no mainline version rows to revert",
                request.change_set_id
            ),
        });
    }

    let subject_keys = target_rows
        .iter()
        .map(|target| (target.model_id.clone(), target.record_id))
        .collect::<BTreeSet<_>>();
    let mut subjects = Vec::with_capacity(subject_keys.len());
    for (model_id, record_id) in &subject_keys {
        let model = schema
            .models
            .iter()
            .find(|model| model.id == *model_id)
            .expect("target model was loaded from schema");
        let physical_model = physical_models
            .get(model_id)
            .expect("target model was materialized");
        subjects.push(load_revert_timeline_for_subject(
            client,
            request,
            schema,
            model,
            physical_model,
            physical_models,
            *record_id,
        )?);
    }

    let mut relation_addresses = Vec::new();
    for subject in &subjects {
        let model = schema
            .models
            .iter()
            .find(|model| model.id == subject.model_id)
            .expect("target model was loaded from schema");
        for (index, version) in subject.timeline.iter().enumerate() {
            let is_winner_for_date = subject
                .timeline
                .get(index + 1)
                .is_none_or(|next| next.effective_start != version.effective_start);
            if is_winner_for_date {
                collect_revert_relation_addresses(schema, model, version, &mut relation_addresses)?;
            }
        }
    }

    let mut relation_targets = BTreeMap::new();
    for (target_model_id, record_key) in relation_addresses {
        let address = scoped_record_address(&target_model_id, &record_key);
        if relation_targets.contains_key(&address) {
            continue;
        }
        let physical_model = physical_models
            .get(&target_model_id)
            .expect("relation target model was validated");
        let record_id = resolve_existing_record_id_for_scope_unlocked(
            client,
            &request.app_id,
            &request.customer_id,
            physical_model,
            &record_key,
        )?;
        relation_targets.insert(address, record_id);
    }

    let mut lock_set = subject_keys;
    for (address, record_id) in &relation_targets {
        lock_set.insert((address.model_id.clone(), *record_id));
    }
    lock_record_set_for_scope(
        client,
        &request.app_id,
        &request.customer_id,
        physical_models,
        &lock_set,
    )?;

    if load_revert_target_rows(client, request, schema, physical_models)? != target_rows {
        return Err(abort_for_apply_dependency_drift(client));
    }
    for subject in &subjects {
        let model = schema
            .models
            .iter()
            .find(|model| model.id == subject.model_id)
            .expect("target model was loaded from schema");
        let physical_model = physical_models
            .get(&subject.model_id)
            .expect("target model was materialized");
        let rechecked = load_revert_timeline_for_subject(
            client,
            request,
            schema,
            model,
            physical_model,
            physical_models,
            subject.record_id,
        )?;
        if rechecked != *subject {
            return Err(abort_for_apply_dependency_drift(client));
        }
    }
    for (address, record_id) in &relation_targets {
        let physical_model = physical_models
            .get(&address.model_id)
            .expect("relation target model was validated");
        let record_key = match &address.address {
            CanonicalRecordAddress::RecordId(record_id) => RecordKey::RecordId(*record_id),
            CanonicalRecordAddress::ExternalKey(external_key) => {
                RecordKey::ExternalKey(ExternalKey::from(external_key.as_str()))
            }
            CanonicalRecordAddress::LookupOrCreate(_) => {
                return Err(lookup_or_create_requires_generated_sql("record_key"));
            }
            CanonicalRecordAddress::NewRecordId(_) => {
                unreachable!("restored relations never use new-record subject addresses")
            }
            CanonicalRecordAddress::Anonymous(_) => {
                unreachable!("restored relations never use anonymous record addresses")
            }
        };
        let rechecked = resolve_existing_record_id_for_scope_unlocked(
            client,
            &request.app_id,
            &request.customer_id,
            physical_model,
            &record_key,
        )?;
        if rechecked != *record_id {
            return Err(abort_for_apply_dependency_drift(client));
        }
    }

    reject_revert_tip_conflicts(
        client,
        &request.app_id,
        &request.customer_id,
        physical_models,
        &target_rows,
        target_applied_order,
    )?;
    Ok(PreparedRevert {
        target_rows,
        subjects,
        relation_targets,
    })
}

fn collect_revert_relation_addresses(
    schema: &Schema,
    model: &Model,
    version: &RevertTimelineVersion,
    addresses: &mut Vec<(ModelId, RecordKey)>,
) -> Result<(), DbError> {
    collect_snapshot_relation_addresses(
        schema,
        model,
        &version.values,
        &version.custom_fields,
        addresses,
    )
}

fn collect_snapshot_relation_addresses(
    schema: &Schema,
    model: &Model,
    values: &BTreeMap<FieldId, FieldValue>,
    custom_fields: &[CustomFieldEntry],
    addresses: &mut Vec<(ModelId, RecordKey)>,
) -> Result<(), DbError> {
    for field in &model.fields {
        if let Some(FieldValue::Relation(record_key)) = values.get(&field.id) {
            addresses.push((
                field
                    .target_model
                    .as_ref()
                    .expect("relation target was validated")
                    .clone(),
                record_key.clone(),
            ));
        }
    }
    for entry in custom_fields {
        if let CustomFieldValue::Relation(record_key) = &entry.value {
            let definition =
                active_custom_field_definition(&schema.custom_fields, &model.id, &entry.field_id)
                    .ok_or_else(|| DbError::SchemaDrift {
                    object: format!("{}.{}", model.id, entry.field_id),
                    details: "restored custom relation definition is missing".to_string(),
                })?;
            addresses.push((
                definition
                    .target_model_id
                    .as_ref()
                    .expect("custom relation target was validated")
                    .clone(),
                record_key.clone(),
            ));
        }
    }
    Ok(())
}

fn reject_revert_tip_conflicts(
    client: &mut impl GenericClient,
    app_id: &AppId,
    customer_id: &CustomerId,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
    target_rows: &[DraftVersionRow],
    target_applied_order: i64,
) -> Result<(), DbError> {
    for target_row in target_rows {
        let physical_model = physical_models
            .get(&target_row.model_id)
            .expect("target model was materialized");
        if let Some((next_start, next_change_set_id)) = next_tip_conflict_for_revert(
            client,
            RevertTipConflictCheck {
                app_id,
                customer_id,
                physical_model,
                target_row,
                target_applied_order,
            },
        )? {
            return Err(DbError::RevertConflict {
                details: format!(
                    "record `{}` has a later mainline version at {next_start} from change_set `{next_change_set_id}`",
                    target_row.record_id
                ),
            });
        }
    }
    Ok(())
}

struct RevertTipConflictCheck<'a> {
    app_id: &'a AppId,
    customer_id: &'a CustomerId,
    physical_model: &'a PhysicalModel,
    target_row: &'a DraftVersionRow,
    target_applied_order: i64,
}

fn next_tip_conflict_for_revert(
    client: &mut impl GenericClient,
    check: RevertTipConflictCheck<'_>,
) -> Result<Option<(NaiveDate, i64)>, DbError> {
    let target_lifecycle_priority = i32::from(lifecycle_priority(
        check.target_row.tombstones_record,
        check.target_row.untombstones_record,
    ));
    Ok(client
        .query_opt(
            &format!(
                r#"
                select v.effective_start, v.change_set_id
                from {} v
                join change_set cs
                  on cs.id = v.change_set_id
                 and cs.app_id = v.app_id
                 and cs.customer_id = v.customer_id
                 and cs.status = 'mainline'
                 and cs.applied_order is not null
                where v.record_id = $1
                  and v.app_id = $2
                  and v.customer_id = $3
                  and v.stage = 'mainline'
                  and v.change_set_id <> $4
                  and (
                    v.effective_start > $5
                    or (
                      v.effective_start = $5
                      and (
                        case
                          when v.tombstones_record then 2
                          when v.untombstones_record then 1
                          else 0
                        end > $6
                        or (
                          case
                            when v.tombstones_record then 2
                            when v.untombstones_record then 1
                            else 0
                          end = $6
                          and cs.applied_order > $7
                        )
                      )
                    )
                  )
                order by
                  v.effective_start asc,
                  v.tombstones_record desc,
                  v.untombstones_record desc,
                  cs.applied_order asc,
                  v.id asc
                limit 1
                "#,
                quote_identifier(&check.physical_model.version_table)
            ),
            &[
                &check.target_row.record_id,
                &check.app_id.as_str(),
                &check.customer_id.as_str(),
                &check.target_row.change_set_id,
                &check.target_row.effective_start,
                &target_lifecycle_priority,
                &check.target_applied_order,
            ],
        )?
        .map(|row| (row.get("effective_start"), row.get("change_set_id"))))
}

fn reject_draft_tombstone_before_later_draft(
    draft_rows: &[DraftVersionRow],
) -> Result<(), DbError> {
    let mut by_subject: BTreeMap<(ModelId, RecordId), Vec<&DraftVersionRow>> = BTreeMap::new();
    for draft in draft_rows {
        by_subject
            .entry((draft.model_id.clone(), draft.record_id))
            .or_default()
            .push(draft);
    }
    for ((model_id, record_id), mut subject_rows) in by_subject {
        subject_rows.sort_by(|left, right| {
            left.effective_start
                .cmp(&right.effective_start)
                .then(left.version_id.cmp(&right.version_id))
        });
        for (index, draft) in subject_rows.iter().enumerate() {
            if !draft.tombstones_record {
                continue;
            }
            if subject_rows
                .iter()
                .skip(index + 1)
                .any(|later| later.effective_start > draft.effective_start)
            {
                return Err(DbError::TimelineConflict {
                    details: format!(
                        "draft tombstone for `{model_id}:{record_id}` at {} would precede a later draft version",
                        draft.effective_start
                    ),
                });
            }
        }
    }
    Ok(())
}

fn load_previous_version(
    client: &mut impl GenericClient,
    scope: PreviousVersionScope<'_>,
    schema: &Schema,
    model: &Model,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
    record_id: RecordId,
    effective_start: NaiveDate,
) -> Result<Option<LoadedVersion>, DbError> {
    let physical_model =
        physical_models
            .get(&model.id)
            .ok_or_else(|| DbError::RecordTargetMissing {
                details: format!("model `{}` was not materialized", model.id),
            })?;
    ensure_mainline_version_order_integrity(
        client,
        physical_model,
        scope.app_id,
        scope.customer_id,
    )?;
    let field_columns = model_field_columns(model, physical_models)?;
    let select_columns = field_columns
        .iter()
        .flat_map(|(_, columns)| columns.iter())
        .map(|column| column.select_sql("v"))
        .collect::<Vec<_>>();
    let mut select_sql = "
        v.id,
        v.effective_start,
        v.effective_end,
        v.tombstones_record,
        v.untombstones_record,
        case when v.stage = 'mainline' then cs.applied_order else cs.created_order end as applied_order,
        v.custom_fields
    "
    .to_string();
    if !select_columns.is_empty() {
        select_sql.push_str(", ");
        select_sql.push_str(&select_columns.join(", "));
    }
    let precedence = version_precedence_sql("v", "cs", VersionOrderDirection::Descending, true);
    let rows = client.query(
        &format!(
            r#"
            select {select_sql}
            from {} v
            join change_set cs
              on cs.id = v.change_set_id
             and cs.app_id = v.app_id
             and cs.customer_id = v.customer_id
            where v.record_id = $1
              and v.app_id = $2
              and v.customer_id = $3
              and v.effective_start <= $4
              and (
                (v.stage = 'mainline' and cs.status = 'mainline' and cs.applied_order is not null)
                or (
                  $5::bigint is not null
                  and v.change_set_id = $5
                  and v.stage = 'draft'
                  and cs.status = 'draft'
                  and cs.applied_order is null
                )
              )
            order by
              {precedence}
            limit 1
            "#,
            quote_identifier(&physical_model.version_table)
        ),
        &[
            &record_id,
            &scope.app_id.as_str(),
            &scope.customer_id.as_str(),
            &effective_start,
            &scope.draft_change_set_id,
        ],
    )?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };
    let mut values = BTreeMap::new();
    let custom_fields =
        custom_fields_from_json_for_schema(schema, &model.id, row.get("custom_fields"))?;
    let mut offset = 7;
    for (field, columns) in &field_columns {
        if let Some(value) = field_value_from_row(row, offset, field, columns)? {
            values.insert(field.id.clone(), value);
        }
        offset += columns.len();
    }
    Ok(Some(LoadedVersion {
        version_id: row.get("id"),
        effective_start: row.get("effective_start"),
        effective_end: row.get("effective_end"),
        applied_order: row.get("applied_order"),
        values,
        custom_fields,
        tombstones_record: row.get("tombstones_record"),
        untombstones_record: row.get("untombstones_record"),
    }))
}

fn load_diff_predecessor(
    client: &mut impl GenericClient,
    app_id: &AppId,
    customer_id: &CustomerId,
    schema: &Schema,
    model: &Model,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
    current: &HistoryVersionRow,
) -> Result<Option<LoadedVersion>, DbError> {
    let physical_model =
        physical_models
            .get(&model.id)
            .ok_or_else(|| DbError::RecordTargetMissing {
                details: format!("model `{}` was not materialized", model.id),
            })?;
    ensure_mainline_version_order_integrity(client, physical_model, app_id, customer_id)?;
    let field_columns = model_field_columns(model, physical_models)?;
    let select_columns = field_columns
        .iter()
        .flat_map(|(_, columns)| columns.iter())
        .map(|column| column.select_sql("v"))
        .collect::<Vec<_>>();
    let mut select_sql = r#"
        v.id,
        v.effective_start,
        v.effective_end,
        v.tombstones_record,
        v.untombstones_record,
        case when v.stage = 'mainline' then cs.applied_order else cs.created_order end as applied_order,
        v.custom_fields
    "#
    .to_string();
    if !select_columns.is_empty() {
        select_sql.push_str(", ");
        select_sql.push_str(&select_columns.join(", "));
    }
    let current_lifecycle_priority = if current.tombstones_record {
        2_i32
    } else if current.untombstones_record {
        1_i32
    } else {
        0_i32
    };
    let current_draft_priority = i32::from(current.stage == VersionStage::Draft);
    let draft_change_set_id =
        (current.stage == VersionStage::Draft).then_some(current.change_set_id);
    let precedence = version_precedence_sql("v", "cs", VersionOrderDirection::Descending, true);
    let row = client.query_opt(
        &format!(
            r#"
            select {select_sql}
            from {} v
            join change_set cs
              on cs.id = v.change_set_id
             and cs.app_id = v.app_id
             and cs.customer_id = v.customer_id
            where v.record_id = $1
              and v.app_id = $2
              and v.customer_id = $3
              and v.id <> $8
              and (
                (v.stage = 'mainline' and cs.status = 'mainline' and cs.applied_order is not null)
                or (
                  $9::bigint is not null
                  and v.change_set_id = $9
                  and v.stage = 'draft'
                  and cs.status = 'draft'
                  and cs.applied_order is null
                )
              )
              and (
                v.effective_start,
                case when v.tombstones_record then 2 when v.untombstones_record then 1 else 0 end,
                case when v.stage = 'draft' then 1 else 0 end,
                case when v.stage = 'mainline' then cs.applied_order else cs.created_order end
              ) < ($4::date, $5::integer, $6::integer, $7::bigint)
            order by
              {precedence}
            limit 1
            "#,
            quote_identifier(&physical_model.version_table)
        ),
        &[
            &current.record_id,
            &app_id.as_str(),
            &customer_id.as_str(),
            &current.effective_start,
            &current_lifecycle_priority,
            &current_draft_priority,
            &current.causal_order,
            &current.version_id,
            &draft_change_set_id,
        ],
    )?;
    let Some(row) = row else {
        return Ok(None);
    };
    let mut values = BTreeMap::new();
    let custom_fields =
        custom_fields_from_json_for_schema(schema, &model.id, row.get("custom_fields"))?;
    let mut offset = 7;
    for (field, columns) in &field_columns {
        if let Some(value) = field_value_from_row(&row, offset, field, columns)? {
            values.insert(field.id.clone(), value);
        }
        offset += columns.len();
    }
    Ok(Some(LoadedVersion {
        version_id: row.get("id"),
        effective_start: row.get("effective_start"),
        effective_end: row.get("effective_end"),
        applied_order: row.get("applied_order"),
        values,
        custom_fields,
        tombstones_record: row.get("tombstones_record"),
        untombstones_record: row.get("untombstones_record"),
    }))
}

fn next_version_start(
    client: &mut impl GenericClient,
    apply: &ApplyChangeSet,
    physical_model: &PhysicalModel,
    record_id: RecordId,
    effective_start: NaiveDate,
) -> Result<Option<NaiveDate>, DbError> {
    next_version_start_for_scope(
        client,
        &apply.app_id,
        &apply.customer_id,
        physical_model,
        record_id,
        effective_start,
    )
}

fn next_version_start_for_scope(
    client: &mut impl GenericClient,
    app_id: &AppId,
    customer_id: &CustomerId,
    physical_model: &PhysicalModel,
    record_id: RecordId,
    effective_start: NaiveDate,
) -> Result<Option<NaiveDate>, DbError> {
    Ok(client
        .query_opt(
            &format!(
                r#"
                select effective_start
                from {}
                where record_id = $1
                  and app_id = $2
                  and customer_id = $3
                  and stage = 'mainline'
                  and effective_start > $4
                order by effective_start asc
                limit 1
                "#,
                quote_identifier(&physical_model.version_table)
            ),
            &[
                &record_id,
                &app_id.as_str(),
                &customer_id.as_str(),
                &effective_start,
            ],
        )?
        .map(|row| row.get("effective_start")))
}

fn next_draft_version_start(
    client: &mut impl GenericClient,
    apply: &ApplyChangeSet,
    physical_model: &PhysicalModel,
    change_set_id: i64,
    record_id: RecordId,
    effective_start: NaiveDate,
) -> Result<Option<NaiveDate>, DbError> {
    Ok(client
        .query_opt(
            &format!(
                r#"
                select effective_start
                from {}
                where record_id = $1
                  and app_id = $2
                  and customer_id = $3
                  and change_set_id = $4
                  and stage = 'draft'
                  and effective_start > $5
                order by effective_start asc
                limit 1
                "#,
                quote_identifier(&physical_model.version_table)
            ),
            &[
                &record_id,
                &apply.app_id.as_str(),
                &apply.customer_id.as_str(),
                &change_set_id,
                &effective_start,
            ],
        )?
        .map(|row| row.get("effective_start")))
}

fn ensure_no_later_draft_version(
    client: &mut impl GenericClient,
    apply: &ApplyChangeSet,
    physical_model: &PhysicalModel,
    change_set_id: i64,
    record_id: RecordId,
    effective_start: NaiveDate,
) -> Result<(), DbError> {
    if let Some(later_start) = next_draft_version_start(
        client,
        apply,
        physical_model,
        change_set_id,
        record_id,
        effective_start,
    )? {
        return Err(DbError::TimelineConflict {
            details: format!(
                "draft change_set `{change_set_id}` already has a later version for record `{record_id}` at {later_start}; submit same-record draft writes in effective_start order"
            ),
        });
    }
    Ok(())
}

#[derive(Debug, Clone, Copy)]
struct MainlineUniquenessKey {
    record_id: RecordId,
    effective_start: NaiveDate,
    tombstones_record: bool,
    untombstones_record: bool,
}

fn ensure_no_same_day_mainline(
    client: &mut impl GenericClient,
    app_id: &AppId,
    customer_id: &CustomerId,
    physical_model: &PhysicalModel,
    key: MainlineUniquenessKey,
) -> Result<(), DbError> {
    let same_day_exists: bool = client
        .query_one(
            &format!(
                "select exists (select 1 from {} where record_id = $1 and app_id = $2 and customer_id = $3 and stage = 'mainline' and effective_start = $4 and tombstones_record = $5 and untombstones_record = $6)",
                quote_identifier(&physical_model.version_table)
            ),
            &[
                &key.record_id,
                &app_id.as_str(),
                &customer_id.as_str(),
                &key.effective_start,
                &key.tombstones_record,
                &key.untombstones_record,
            ],
        )?
        .get(0);
    if same_day_exists {
        return Err(DbError::TimelineConflict {
            details: format!(
                "record `{}` already has a mainline version at {}",
                key.record_id, key.effective_start
            ),
        });
    }
    Ok(())
}

fn ensure_no_same_day_draft(
    client: &mut impl GenericClient,
    apply: &ApplyChangeSet,
    physical_model: &PhysicalModel,
    change_set_id: i64,
    key: MainlineUniquenessKey,
) -> Result<(), DbError> {
    let same_day_exists: bool = client
        .query_one(
            &format!(
                "select exists (select 1 from {} where record_id = $1 and app_id = $2 and customer_id = $3 and change_set_id = $4 and stage = 'draft' and effective_start = $5 and tombstones_record = $6 and untombstones_record = $7)",
                quote_identifier(&physical_model.version_table)
            ),
            &[
                &key.record_id,
                &apply.app_id.as_str(),
                &apply.customer_id.as_str(),
                &change_set_id,
                &key.effective_start,
                &key.tombstones_record,
                &key.untombstones_record,
            ],
        )?
        .get(0);
    if same_day_exists {
        return Err(DbError::TimelineConflict {
            details: format!(
                "draft change_set `{change_set_id}` already has a version for record `{}` at {}",
                key.record_id, key.effective_start
            ),
        });
    }
    Ok(())
}

fn normalize_reverted_subject_timeline(
    client: &mut impl GenericClient,
    request: &RevertChangeSet,
    schema: &Schema,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
    subject: &PreparedRevertSubject,
) -> Result<(), DbError> {
    let model = schema
        .models
        .iter()
        .find(|model| model.id == subject.model_id)
        .expect("target model was loaded from schema");
    let physical_model = physical_models
        .get(&subject.model_id)
        .expect("target model was materialized");
    for (index, version) in subject.timeline.iter().enumerate() {
        let next = subject.timeline.get(index + 1);
        let effective_end =
            if next.is_some_and(|next| next.effective_start == version.effective_start) {
                Some(version.effective_start)
            } else if let Some(next) = next {
                Some(
                    next.effective_start
                        .checked_sub_signed(Duration::days(1))
                        .ok_or_else(|| DbError::TimelineConflict {
                            details: format!(
                                "effective_start `{}` is too early to bound a restored timeline",
                                next.effective_start
                            ),
                        })?,
                )
            } else {
                None
            };
        if version.effective_end == effective_end {
            continue;
        }
        let updated = execute_unique_checked(
            client,
            &format!(
                r#"
                update {}
                set effective_end = $4
                where id = $1
                  and app_id = $2
                  and customer_id = $3
                  and stage = 'mainline'
                "#,
                quote_identifier(&physical_model.version_table)
            ),
            &[
                &version.version_id,
                &request.app_id.as_str(),
                &request.customer_id.as_str(),
                &effective_end,
            ],
            model,
            physical_model,
            physical_models,
            &version.values,
        )?;
        if updated != 1 {
            return Err(DbError::SchemaDrift {
                object: physical_model.version_table.clone(),
                details: format!(
                    "restored version `{}` was not a live mainline row",
                    version.version_id
                ),
            });
        }
    }
    Ok(())
}

fn validate_restored_revert_state(
    client: &mut impl GenericClient,
    request: &RevertChangeSet,
    schema: &Schema,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
    prepared: &PreparedRevert,
) -> Result<(), DbError> {
    for subject in &prepared.subjects {
        let model = schema
            .models
            .iter()
            .find(|model| model.id == subject.model_id)
            .expect("target model was loaded from schema");
        let physical_model = physical_models
            .get(&subject.model_id)
            .expect("target model was materialized");
        if let Some(live_head) = subject.timeline.last() {
            ensure_unique_field_values_available(
                client,
                UniqueFieldValueCheck {
                    app_id: &request.app_id,
                    customer_id: &request.customer_id,
                    model,
                    physical_model,
                    physical_models,
                    record_id: subject.record_id,
                    values: &live_head.values,
                },
            )?;
        }
        for (index, version) in subject.timeline.iter().enumerate() {
            let is_winner_for_date = subject
                .timeline
                .get(index + 1)
                .is_none_or(|next| next.effective_start != version.effective_start);
            if is_winner_for_date {
                validate_restored_version_relations(
                    client,
                    request,
                    schema,
                    model,
                    physical_models,
                    &prepared.relation_targets,
                    version,
                )?;
            }
        }
    }
    Ok(())
}

fn validate_restored_version_relations(
    client: &mut impl GenericClient,
    request: &RevertChangeSet,
    schema: &Schema,
    model: &Model,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
    relation_targets: &BTreeMap<ScopedRecordAddress, RecordId>,
    version: &RevertTimelineVersion,
) -> Result<(), DbError> {
    for field in &model.fields {
        if let Some(FieldValue::Relation(record_key)) = version.values.get(&field.id) {
            validate_restored_relation_target(
                client,
                request,
                physical_models,
                relation_targets,
                field
                    .target_model
                    .as_ref()
                    .expect("relation target was validated"),
                record_key,
                version.effective_start,
            )?;
        }
    }
    for entry in &version.custom_fields {
        if let CustomFieldValue::Relation(record_key) = &entry.value {
            let definition =
                active_custom_field_definition(&schema.custom_fields, &model.id, &entry.field_id)
                    .ok_or_else(|| DbError::SchemaDrift {
                    object: format!("{}.{}", model.id, entry.field_id),
                    details: "restored custom relation definition is missing".to_string(),
                })?;
            validate_restored_relation_target(
                client,
                request,
                physical_models,
                relation_targets,
                definition
                    .target_model_id
                    .as_ref()
                    .expect("custom relation target was validated"),
                record_key,
                version.effective_start,
            )?;
        }
    }
    Ok(())
}

fn validate_restored_relation_target(
    client: &mut impl GenericClient,
    request: &RevertChangeSet,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
    relation_targets: &BTreeMap<ScopedRecordAddress, RecordId>,
    target_model_id: &ModelId,
    record_key: &RecordKey,
    as_of: NaiveDate,
) -> Result<(), DbError> {
    let record_id = *relation_targets
        .get(&scoped_record_address(target_model_id, record_key))
        .ok_or_else(|| DbError::RecordTargetMissing {
            details: format!("record key `{record_key:?}` did not resolve"),
        })?;
    let physical_model = physical_models
        .get(target_model_id)
        .expect("relation target model was materialized");
    match record_visibility_for_scope(
        client,
        &request.app_id,
        &request.customer_id,
        physical_model,
        record_id,
        as_of,
    )? {
        Some(false) => Ok(()),
        Some(true) => Err(DbError::TombstonedRecord {
            details: format!("record `{record_id}` is tombstoned as of {as_of}"),
        }),
        None => Err(DbError::RecordTargetMissing {
            details: format!("record `{record_id}` is not visible as of {as_of}"),
        }),
    }
}

fn resolve_field_value(
    client: &mut impl GenericClient,
    scope: FieldResolutionScope<'_>,
    schema: &Schema,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
    field: &Field,
    value: &FieldValue,
    as_of: NaiveDate,
) -> Result<FieldValue, DbError> {
    if let (FieldType::Relation, FieldValue::Relation(record_key)) = (&field.field_type, value) {
        let target_model_id = field.target_model.as_ref().expect("schema was validated");
        let target_model = schema
            .models
            .iter()
            .find(|model| model.id == *target_model_id)
            .expect("relation target was validated");
        let target_physical_model = physical_models
            .get(&target_model.id)
            .expect("relation target was materialized");
        let record_id = resolve_existing_record(
            client,
            scope.apply,
            target_physical_model,
            record_key,
            as_of,
            false,
        )?;
        match relation_target_visibility(
            client,
            scope,
            target_model_id,
            target_physical_model,
            record_id,
            as_of,
        )? {
            Some(false) => {}
            Some(true) => {
                return Err(DbError::TombstonedRecord {
                    details: format!("record `{record_id}` is tombstoned as of {as_of}"),
                })
            }
            None => {
                return Err(DbError::RecordTargetMissing {
                    details: format!("record `{record_id}` is not visible as of {as_of}"),
                });
            }
        }
        return Ok(FieldValue::Relation(RecordKey::RecordId(record_id)));
    }
    Ok(value.clone())
}

struct CustomFieldOverlayRequest<'a> {
    scope: FieldResolutionScope<'a>,
    schema: &'a Schema,
    physical_models: &'a BTreeMap<ModelId, PhysicalModel>,
    model_id: &'a ModelId,
    existing: Vec<CustomFieldEntry>,
    incoming: Option<&'a [CustomFieldEntry]>,
    as_of: NaiveDate,
}

fn overlay_custom_fields(
    client: &mut impl GenericClient,
    request: CustomFieldOverlayRequest<'_>,
) -> Result<Vec<CustomFieldEntry>, DbError> {
    let mut by_field = request
        .existing
        .into_iter()
        .filter(|entry| {
            active_custom_field_definition(
                &request.schema.custom_fields,
                request.model_id,
                &entry.field_id,
            )
            .is_some()
        })
        .map(|entry| (entry.field_id.clone(), entry))
        .collect::<BTreeMap<_, _>>();
    if let Some(incoming) = request.incoming {
        for entry in incoming {
            let resolved = resolve_custom_field_entry(
                client,
                request.scope,
                request.schema,
                request.physical_models,
                request.model_id,
                entry,
                request.as_of,
            )?;
            by_field.insert(resolved.field_id.clone(), resolved);
        }
    }
    Ok(by_field.into_values().collect())
}

fn resolve_custom_field_entry(
    client: &mut impl GenericClient,
    scope: FieldResolutionScope<'_>,
    schema: &Schema,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
    model_id: &ModelId,
    entry: &CustomFieldEntry,
    as_of: NaiveDate,
) -> Result<CustomFieldEntry, DbError> {
    let definition =
        active_custom_field_definition(&schema.custom_fields, model_id, &entry.field_id)
            .ok_or_else(|| DbError::SchemaDrift {
                object: format!("{model_id}.{}", entry.field_id),
                details: "custom field definition missing after validation".to_string(),
            })?;
    let value = match (&definition.field_type, &entry.value) {
        (CustomFieldType::Relation, CustomFieldValue::Relation(record_key)) => {
            let target_model_id =
                definition
                    .target_model_id
                    .as_ref()
                    .ok_or_else(|| DbError::SchemaDrift {
                        object: entry.field_id.to_string(),
                        details: "custom relation field missing target model after validation"
                            .to_string(),
                    })?;
            let target_model = schema
                .models
                .iter()
                .find(|model| model.id == *target_model_id)
                .expect("custom relation target was validated");
            let target_physical_model =
                physical_models
                    .get(&target_model.id)
                    .ok_or_else(|| DbError::SchemaDrift {
                        object: entry.field_id.to_string(),
                        details: "custom relation target missing after validation".to_string(),
                    })?;
            let record_id = resolve_existing_record(
                client,
                scope.apply,
                target_physical_model,
                record_key,
                as_of,
                false,
            )?;
            match relation_target_visibility(
                client,
                scope,
                target_model_id,
                target_physical_model,
                record_id,
                as_of,
            )? {
                Some(false) => {}
                Some(true) => {
                    return Err(DbError::TombstonedRecord {
                        details: format!("record `{record_id}` is tombstoned as of {as_of}"),
                    })
                }
                None => {
                    return Err(DbError::RecordTargetMissing {
                        details: format!("record `{record_id}` is not visible as of {as_of}"),
                    });
                }
            }
            CustomFieldValue::Relation(RecordKey::RecordId(record_id))
        }
        _ => entry.value.clone(),
    };
    Ok(CustomFieldEntry {
        field_id: entry.field_id.clone(),
        value,
    })
}

struct VersionInsert<'a> {
    apply: &'a ApplyChangeSet,
    model: &'a Model,
    physical_model: &'a PhysicalModel,
    physical_models: &'a BTreeMap<ModelId, PhysicalModel>,
    change_set_id: i64,
    version_id: Uuid,
    record_id: RecordId,
    write: &'a RowVersionWrite,
    effective_end: Option<NaiveDate>,
    snapshot: &'a BTreeMap<FieldId, FieldValue>,
    custom_fields: &'a [CustomFieldEntry],
    stage: &'a str,
    applied_at: Option<DateTime<Utc>>,
}

fn insert_version_row(
    client: &mut impl GenericClient,
    version: VersionInsert<'_>,
) -> Result<(), DbError> {
    let field_columns = model_field_columns(version.model, version.physical_models)?;
    let mut columns = vec![
        "id".to_string(),
        "record_id".to_string(),
        "app_id".to_string(),
        "customer_id".to_string(),
        "stage".to_string(),
        "effective_start".to_string(),
        "effective_end".to_string(),
        "change_set_id".to_string(),
        "applied_at".to_string(),
        "tombstones_record".to_string(),
        "untombstones_record".to_string(),
        "provenance".to_string(),
        "custom_fields".to_string(),
    ];
    for (_, field_columns) in &field_columns {
        for column in field_columns {
            columns.push(column.name.clone());
        }
    }

    let stage = version.stage.to_string();
    let provenance = version.write.provenance.clone();
    let custom_fields = custom_fields_to_json(version.custom_fields)?;
    let mut values: Vec<Box<dyn ToSql + Sync>> = vec![
        Box::new(version.version_id),
        Box::new(version.record_id),
        Box::new(version.apply.app_id.to_string()),
        Box::new(version.apply.customer_id.to_string()),
        Box::new(stage),
        Box::new(version.write.effective_start),
        Box::new(version.effective_end),
        Box::new(version.change_set_id),
        Box::new(version.applied_at),
        Box::new(version.write.tombstones_record),
        Box::new(false),
        Box::new(provenance),
        Box::new(custom_fields),
    ];
    for (field, columns) in &field_columns {
        let value = version.snapshot.get(&field.id);
        values.extend(field_sql_values(
            field,
            columns,
            value,
            version.write.tombstones_record,
        ));
    }
    let params = values
        .iter()
        .map(|value| value.as_ref() as &(dyn ToSql + Sync))
        .collect::<Vec<_>>();
    let mut placeholder_casts = vec![None; 13];
    for (_, field_columns) in &field_columns {
        for column in field_columns {
            placeholder_casts.push(column.placeholder_cast());
        }
    }
    let placeholders = (1..=columns.len())
        .map(|index| match placeholder_casts[index - 1] {
            Some(cast) => format!("${index}::{cast}"),
            None => format!("${index}"),
        })
        .collect::<Vec<_>>();
    let column_sql = columns
        .iter()
        .map(|column| quote_identifier(column))
        .collect::<Vec<_>>()
        .join(", ");
    client
        .execute(
            &format!(
                "insert into {} ({column_sql}) values ({})",
                quote_identifier(&version.physical_model.version_table),
                placeholders.join(", ")
            ),
            &params,
        )
        .map_err(|error| {
            unique_field_error_from_postgres(
                &error,
                version.model,
                version.physical_model,
                version.physical_models,
                version.snapshot,
            )
            .unwrap_or(DbError::Postgres(error))
        })?;
    Ok(())
}

fn execute_unique_checked(
    client: &mut impl GenericClient,
    sql: &str,
    params: &[&(dyn ToSql + Sync)],
    model: &Model,
    physical_model: &PhysicalModel,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
    values: &BTreeMap<FieldId, FieldValue>,
) -> Result<u64, DbError> {
    client.execute(sql, params).map_err(|error| {
        unique_field_error_from_postgres(&error, model, physical_model, physical_models, values)
            .unwrap_or(DbError::Postgres(error))
    })
}

struct UniqueFieldValueCheck<'a> {
    app_id: &'a AppId,
    customer_id: &'a CustomerId,
    model: &'a Model,
    physical_model: &'a PhysicalModel,
    physical_models: &'a BTreeMap<ModelId, PhysicalModel>,
    record_id: RecordId,
    values: &'a BTreeMap<FieldId, FieldValue>,
}

fn ensure_unique_field_values_available(
    client: &mut impl GenericClient,
    check: UniqueFieldValueCheck<'_>,
) -> Result<(), DbError> {
    for field in check.model.fields.iter().filter(|field| field.is_unique) {
        let Some(value) = check.values.get(&field.id) else {
            continue;
        };
        let columns = field_columns(field, check.physical_models)?;
        let column = unique_field_column(field, &columns)?;
        let sql_values = field_sql_values(field, &columns, Some(value), false);
        if sql_values.len() != 1 {
            return Err(DbError::SchemaDrift {
                object: format!("{}.{}", check.model.id, field.id),
                details: "unique field did not materialize to one SQL value".to_string(),
            });
        }
        let app_id = check.app_id.to_string();
        let customer_id = check.customer_id.to_string();
        let value_param = sql_values[0].as_ref() as &(dyn ToSql + Sync);
        let params: Vec<&(dyn ToSql + Sync)> =
            vec![&app_id, &customer_id, &check.record_id, value_param];
        let value_placeholder = match column.placeholder_cast() {
            Some(cast) => format!("$4::{cast}"),
            None => "$4".to_string(),
        };
        let conflict = client.query_opt(
            &format!(
                r#"
                select record_id
                from {}
                where app_id = $1
                  and customer_id = $2
                  and record_id <> $3
                  and stage = 'mainline'
                  and effective_end is null
                  and {} = {value_placeholder}
                limit 1
                "#,
                quote_identifier(&check.physical_model.version_table),
                quote_identifier(&column.name)
            ),
            &params,
        )?;
        if conflict.is_some() {
            return Err(DbError::UniqueFieldConflict {
                model: check.model.id.to_string(),
                field: field.id.to_string(),
                value: field_value_display(value),
            });
        }
    }
    Ok(())
}

fn unique_field_error_from_postgres(
    error: &postgres::Error,
    model: &Model,
    physical_model: &PhysicalModel,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
    values: &BTreeMap<FieldId, FieldValue>,
) -> Option<DbError> {
    let db_error = error.as_db_error()?;
    if db_error.code() != &SqlState::UNIQUE_VIOLATION {
        return None;
    }
    let constraint = db_error.constraint()?;
    for field in model.fields.iter().filter(|field| field.is_unique) {
        let columns = field_columns(field, physical_models).ok()?;
        let column = unique_field_column(field, &columns).ok()?;
        if constraint == unique_field_index_name(physical_model, column) {
            return Some(DbError::UniqueFieldConflict {
                model: model.id.to_string(),
                field: field.id.to_string(),
                value: values
                    .get(&field.id)
                    .map(field_value_display)
                    .unwrap_or_else(|| "<unknown>".to_string()),
            });
        }
    }
    None
}

fn unique_field_column<'a>(
    field: &Field,
    columns: &'a [FieldColumn],
) -> Result<&'a FieldColumn, DbError> {
    if columns.len() == 1 {
        return Ok(&columns[0]);
    }
    Err(DbError::SchemaDrift {
        object: field.id.to_string(),
        details: "unique fields must materialize to exactly one column".to_string(),
    })
}

fn field_value_display(value: &FieldValue) -> String {
    match value {
        FieldValue::Text(value) => value.clone(),
        FieldValue::Number(value) => value.to_string(),
        FieldValue::Bool(value) => value.to_string(),
        FieldValue::Date(value) => value.to_string(),
        FieldValue::Datetime(value) => value.to_rfc3339(),
        FieldValue::Relation(value) => format!("{value:?}"),
        FieldValue::RelationList(values) => format!("{values:?}"),
        FieldValue::TextList(value) => value.join(", "),
        FieldValue::Json(value) => value.to_string(),
        FieldValue::Enum(value) => value.to_string(),
        FieldValue::SchemaLifecycle(value) => format!("{value:?}"),
        FieldValue::MoneyRate(value) => {
            format!("{} {} {:?}", value.amount, value.currency, value.period)
        }
    }
}

fn custom_fields_to_json(custom_fields: &[CustomFieldEntry]) -> Result<Value, DbError> {
    Ok(serde_json::to_value(custom_fields)?)
}

fn custom_fields_from_json(value: Value) -> Result<Vec<CustomFieldEntry>, DbError> {
    Ok(serde_json::from_value(value)?)
}

fn custom_fields_from_json_for_schema(
    schema: &Schema,
    model_id: &ModelId,
    value: Value,
) -> Result<Vec<CustomFieldEntry>, DbError> {
    Ok(sanitize_custom_fields_for_schema(
        schema,
        model_id,
        custom_fields_from_json(value)?,
    ))
}

fn sanitize_custom_fields_for_schema(
    schema: &Schema,
    model_id: &ModelId,
    entries: Vec<CustomFieldEntry>,
) -> Vec<CustomFieldEntry> {
    entries
        .into_iter()
        .filter(|entry| match &entry.value {
            CustomFieldValue::Enum(option_id) => {
                active_custom_field_definition(&schema.custom_fields, model_id, &entry.field_id)
                    .is_none_or(|definition| {
                        definition.field_type != CustomFieldType::Enum
                            || definition
                                .option_set
                                .iter()
                                .any(|option| option.id == *option_id)
                    })
            }
            _ => true,
        })
        .collect()
}

fn custom_field_values_by_field_id(
    entries: Vec<CustomFieldEntry>,
) -> BTreeMap<FieldId, CustomFieldValue> {
    entries
        .into_iter()
        .map(|entry| (entry.field_id, entry.value))
        .collect()
}

fn model_field_columns<'a>(
    model: &'a Model,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
) -> Result<Vec<(&'a Field, Vec<FieldColumn>)>, DbError> {
    model_field_columns_for_projection(model, physical_models, None)
}

fn model_field_columns_for_projection<'a>(
    model: &'a Model,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
    field_projection: Option<&BTreeSet<FieldId>>,
) -> Result<Vec<(&'a Field, Vec<FieldColumn>)>, DbError> {
    if let Some(field_projection) = field_projection {
        let declared_field_ids = model
            .fields
            .iter()
            .map(|field| field.id.clone())
            .collect::<BTreeSet<_>>();
        for field_id in field_projection {
            if !declared_field_ids.contains(field_id) {
                return Err(DbError::RecordTargetMissing {
                    details: format!("field `{field_id}` is not declared on model `{}`", model.id),
                });
            }
        }
    }

    model
        .fields
        .iter()
        .filter(|field| field_projection.is_none_or(|fields| fields.contains(&field.id)))
        .map(|field| Ok((field, field_columns(field, physical_models)?)))
        .collect()
}

fn field_sql_values(
    field: &Field,
    _columns: &[FieldColumn],
    value: Option<&FieldValue>,
    force_null: bool,
) -> Vec<Box<dyn ToSql + Sync>> {
    let value = if force_null { None } else { value };
    match (&field.field_type, value) {
        (
            FieldType::Text | FieldType::IsoCountry | FieldType::IsoCurrency,
            Some(FieldValue::Text(value)),
        ) => vec![Box::new(Some(value.clone()))],
        (FieldType::Number, Some(FieldValue::Number(value))) => {
            vec![Box::new(Some(value.to_string()))]
        }
        (FieldType::Bool, Some(FieldValue::Bool(value))) => vec![Box::new(Some(*value))],
        (FieldType::Date, Some(FieldValue::Date(value))) => vec![Box::new(Some(*value))],
        (FieldType::Datetime, Some(FieldValue::Datetime(value))) => vec![Box::new(Some(*value))],
        (FieldType::Relation, Some(FieldValue::Relation(RecordKey::RecordId(value)))) => {
            vec![Box::new(Some(*value))]
        }
        (FieldType::TextList | FieldType::KnownAliases, Some(FieldValue::TextList(value))) => {
            vec![Box::new(Some(value.clone()))]
        }
        (FieldType::Json, Some(FieldValue::Json(value))) => vec![Box::new(Some(value.clone()))],
        (FieldType::Enum, Some(FieldValue::Enum(value))) => {
            vec![Box::new(Some(value.as_str().to_string()))]
        }
        (FieldType::MoneyRate, Some(FieldValue::MoneyRate(value))) => vec![
            Box::new(Some(value.amount.to_string())),
            Box::new(Some(value.currency.clone())),
            Box::new(Some(money_rate_period_string(&value.period))),
        ],
        (FieldType::MoneyRate, _) => vec![
            Box::new(Option::<String>::None),
            Box::new(Option::<String>::None),
            Box::new(Option::<String>::None),
        ],
        (FieldType::Text | FieldType::IsoCountry | FieldType::IsoCurrency, _) => {
            vec![Box::new(Option::<String>::None)]
        }
        (FieldType::Number, _) => vec![Box::new(Option::<String>::None)],
        (FieldType::Bool, _) => vec![Box::new(Option::<bool>::None)],
        (FieldType::Date, _) => vec![Box::new(Option::<NaiveDate>::None)],
        (FieldType::Datetime, _) => vec![Box::new(Option::<chrono::DateTime<chrono::Utc>>::None)],
        (FieldType::Relation, _) => vec![Box::new(Option::<Uuid>::None)],
        (FieldType::TextList | FieldType::KnownAliases, _) => {
            vec![Box::new(Option::<Vec<String>>::None)]
        }
        (FieldType::Json, _) => vec![Box::new(Option::<Value>::None)],
        (FieldType::Enum, _) => vec![Box::new(Option::<String>::None)],
    }
}

fn field_value_from_row(
    row: &Row,
    offset: usize,
    field: &Field,
    _columns: &[FieldColumn],
) -> Result<Option<FieldValue>, DbError> {
    Ok(match field.field_type {
        FieldType::Text | FieldType::IsoCountry | FieldType::IsoCurrency => {
            row.get::<_, Option<String>>(offset).map(FieldValue::Text)
        }
        FieldType::Number => row
            .get::<_, Option<String>>(offset)
            .map(|value| Decimal::from_str(&value))
            .transpose()
            .map_err(|error| DbError::SchemaDrift {
                object: field.id.to_string(),
                details: format!("invalid decimal value: {error}"),
            })?
            .map(FieldValue::Number),
        FieldType::Bool => row.get::<_, Option<bool>>(offset).map(FieldValue::Bool),
        FieldType::Date => row
            .get::<_, Option<NaiveDate>>(offset)
            .map(FieldValue::Date),
        FieldType::Datetime => row
            .get::<_, Option<chrono::DateTime<chrono::Utc>>>(offset)
            .map(FieldValue::Datetime),
        FieldType::Relation => row
            .get::<_, Option<Uuid>>(offset)
            .map(|record_id| FieldValue::Relation(RecordKey::RecordId(record_id))),
        FieldType::TextList | FieldType::KnownAliases => row
            .get::<_, Option<Vec<String>>>(offset)
            .map(FieldValue::TextList),
        FieldType::Json => row.get::<_, Option<Value>>(offset).map(FieldValue::Json),
        FieldType::Enum => row.get::<_, Option<String>>(offset).and_then(|value| {
            field
                .option_set
                .iter()
                .find(|option| option.id.as_str() == value)
                .map(|option| FieldValue::Enum(option.id.clone()))
        }),
        FieldType::MoneyRate => {
            let amount = row
                .get::<_, Option<String>>(offset)
                .map(|value| Decimal::from_str(&value))
                .transpose()
                .map_err(|error| DbError::SchemaDrift {
                    object: field.id.to_string(),
                    details: format!("invalid money_rate amount: {error}"),
                })?;
            let currency = row.get::<_, Option<String>>(offset + 1);
            let period = row.get::<_, Option<String>>(offset + 2);
            match (amount, currency, period) {
                (Some(amount), Some(currency), Some(period)) => {
                    Some(FieldValue::MoneyRate(MoneyRateValue {
                        amount,
                        currency,
                        period: money_rate_period_from_str(&period)?,
                    }))
                }
                _ => None,
            }
        }
    })
}

fn money_rate_period_string(period: &MoneyRatePeriod) -> String {
    match period {
        MoneyRatePeriod::Hourly => "hourly",
        MoneyRatePeriod::Daily => "daily",
        MoneyRatePeriod::Weekly => "weekly",
        MoneyRatePeriod::Monthly => "monthly",
        MoneyRatePeriod::Annual => "annual",
    }
    .to_string()
}

fn money_rate_period_from_str(value: &str) -> Result<MoneyRatePeriod, DbError> {
    match value {
        "hourly" => Ok(MoneyRatePeriod::Hourly),
        "daily" => Ok(MoneyRatePeriod::Daily),
        "weekly" => Ok(MoneyRatePeriod::Weekly),
        "monthly" => Ok(MoneyRatePeriod::Monthly),
        "annual" => Ok(MoneyRatePeriod::Annual),
        _ => Err(DbError::SchemaDrift {
            object: "money_rate.period".to_string(),
            details: format!("unknown period `{value}`"),
        }),
    }
}

fn lock_materialization(
    client: &mut impl GenericClient,
    schema: &Schema,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
) -> Result<(), DbError> {
    let scope = advisory_lock_schema_scope(client)?;
    let lock_names = materialization_lock_names(&scope, schema, physical_models);
    let mut round_trips = MaterializationRoundTrips::default();
    round_trips.record_advisory_lock_round_trip();
    client.query(
        r#"
        select pg_advisory_xact_lock(hashtext(lock_name)::bigint)
        from unnest($1::text[]) with ordinality as locks(lock_name, lock_order)
        order by lock_order
        "#,
        &[&lock_names],
    )?;
    debug_assert_eq!(
        round_trips.advisory_lock_round_trips,
        MATERIALIZATION_ADVISORY_LOCK_QUERY_COUNT
    );
    Ok(())
}

fn materialization_lock_names(
    scope: &str,
    schema: &Schema,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
) -> Vec<String> {
    let mut lock_names = vec![schema_activation_lock_name(
        scope,
        &schema.app_id,
        &schema.customer_id,
    )];
    for physical_model in physical_models.values() {
        lock_names.push(format!(
            "{scope}:materialize-table:{}",
            physical_model.record_table
        ));
        lock_names.push(format!(
            "{scope}:materialize-table:{}",
            physical_model.version_table
        ));
    }
    lock_names.sort();
    lock_names
}

fn schema_activation_lock_name(scope: &str, app_id: &AppId, customer_id: &CustomerId) -> String {
    format!("{scope}:materialize-tenant:{app_id}:{customer_id}:schema-activation")
}

fn ensure_substrate_tables(
    client: &mut impl GenericClient,
    mode: MaterializationMode,
    postgres_catalog: &PostgresCatalogSnapshot,
) -> Result<(), DbError> {
    match mode {
        MaterializationMode::CreateMissing => client.batch_execute(
            r#"
        create sequence if not exists change_set_lifecycle_order_seq;

        create table if not exists schema_revision (
          id bigserial,
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
          materialization_git_sha text,
          materialization_vercel_deployment_id text,
          materialization_vercel_environment text,
          materialization_vercel_git_ref text,
          materialized_at timestamptz,
          authorization_policy_declared boolean,
          constraint schema_revision_pkey primary key (id),
          constraint schema_revision_scope_version_key unique (app_id, customer_id, version)
        );

        create unique index if not exists schema_revision_tenant_id_idx
          on schema_revision (id, app_id, customer_id);

        create unique index if not exists schema_revision_active_idx
          on schema_revision (app_id, customer_id)
          where activated_at is not null;

        create table if not exists change_set (
          id bigserial,
          app_id text not null,
          customer_id text not null,
          schema_revision_id bigint not null,
          created_with_mode text not null,
          status text not null,
          actor_id text,
          source_kind text not null,
          source_ref text,
          idempotency_key text,
          request_fingerprint text,
          change_type_id text,
          notes text,
          created_order bigint not null,
          applied_order bigint,
          created_at timestamptz not null default now(),
          applied_at timestamptz,
          constraint change_set_pkey primary key (id)
        );

        create unique index if not exists change_set_tenant_id_idx
          on change_set (id, app_id, customer_id);

        create unique index if not exists change_set_idempotency_idx
          on change_set (app_id, customer_id, idempotency_key)
          where idempotency_key is not null;

        create table if not exists agent_run (
          id bigserial,
          app_id text not null,
          customer_id text not null,
          run_id text not null,
          status text not null default 'recorded',
          schema_revision_id bigint not null,
          actor_id text,
          agent_identity_id text not null,
          execution_profile_id text not null,
          source_artifacts jsonb not null default '[]',
          alignment_decisions jsonb not null default '[]',
          model_calls jsonb not null default '[]',
          tool_calls jsonb not null default '[]',
          token_usage jsonb not null default '{}',
          validation_failures jsonb not null default '[]',
          final_outputs jsonb not null default '{}',
          approval_boundaries jsonb not null default '[]',
          compiled_preview_ids jsonb not null default '[]',
          created_at timestamptz not null default now(),
          constraint agent_run_pkey primary key (id),
          constraint agent_run_scope_run_key unique (app_id, customer_id, run_id)
        );

        create unique index if not exists agent_run_tenant_id_idx
          on agent_run (id, app_id, customer_id);
        "#,
        )?,
        MaterializationMode::ValidateExisting => {
            validate_sequence_exists(client, "change_set_lifecycle_order_seq")?;
            validate_table_exists(client, "schema_revision")?;
            validate_table_exists(client, "change_set")?;
            validate_table_exists(client, "agent_run")?;
        }
    }

    ensure_schema_revision_metadata_columns(client)?;
    ensure_agent_run_status_column(client)?;

    reject_removed_change_set_contract(client, postgres_catalog)?;
    if mode == MaterializationMode::ValidateExisting {
        ensure_substrate_indexes(client, postgres_catalog)?;
    }
    ensure_key_constraint(
        client,
        postgres_catalog,
        "schema_revision",
        "schema_revision_pkey",
        "p",
        &["id"],
    )?;
    ensure_key_constraint(
        client,
        postgres_catalog,
        "schema_revision",
        "schema_revision_scope_version_key",
        "u",
        &["app_id", "customer_id", "version"],
    )?;
    ensure_key_constraint(
        client,
        postgres_catalog,
        "change_set",
        "change_set_pkey",
        "p",
        &["id"],
    )?;
    ensure_key_constraint(
        client,
        postgres_catalog,
        "agent_run",
        "agent_run_pkey",
        "p",
        &["id"],
    )?;
    ensure_key_constraint(
        client,
        postgres_catalog,
        "agent_run",
        "agent_run_scope_run_key",
        "u",
        &["app_id", "customer_id", "run_id"],
    )?;
    ensure_check_constraint(
        client,
        postgres_catalog,
        "change_set",
        "change_set_created_with_mode_check",
        CHANGE_SET_COLUMNS,
        "created_with_mode in ('mainline', 'draft')",
    )?;
    ensure_check_constraint(
        client,
        postgres_catalog,
        "change_set",
        "change_set_status_check",
        CHANGE_SET_COLUMNS,
        "status in ('draft', 'mainline', 'discarded')",
    )?;
    ensure_check_constraint(
        client,
        postgres_catalog,
        "change_set",
        "change_set_applied_at_status_check",
        CHANGE_SET_COLUMNS,
        "(status = 'mainline') = (applied_at is not null)",
    )?;
    ensure_check_constraint(
        client,
        postgres_catalog,
        "change_set",
        "change_set_applied_order_status_check",
        CHANGE_SET_COLUMNS,
        "(status = 'mainline') = (applied_order is not null)",
    )?;
    ensure_agent_run_status_check(client, postgres_catalog)?;
    ensure_fk_constraint(
        client,
        postgres_catalog,
        "change_set",
        "change_set_schema_revision_tenant_fk",
        &["schema_revision_id", "app_id", "customer_id"],
        "schema_revision",
        &["id", "app_id", "customer_id"],
    )?;
    ensure_fk_constraint(
        client,
        postgres_catalog,
        "agent_run",
        "agent_run_schema_revision_tenant_fk",
        &["schema_revision_id", "app_id", "customer_id"],
        "schema_revision",
        &["id", "app_id", "customer_id"],
    )?;
    ensure_rls_against(client, "schema_revision", postgres_catalog)?;
    ensure_rls_against(client, "change_set", postgres_catalog)?;
    ensure_rls_against(client, "agent_run", postgres_catalog)?;
    Ok(())
}

fn ensure_schema_revision_catalog_policy(client: &mut impl GenericClient) -> Result<(), DbError> {
    if table_exists(client, "schema_revision")? {
        ensure_rls(client, "schema_revision")?;
    }
    Ok(())
}

fn prepare_schema_activation_head(
    client: &mut impl GenericClient,
    schema: &Schema,
    mode: SchemaActivationHeadMode,
) -> Result<(), DbError> {
    if !table_exists(client, "schema_revision")? {
        if table_exists(client, SCHEMA_ACTIVATION_HEAD_TABLE)? {
            return Err(DbError::SchemaDrift {
                object: SCHEMA_ACTIVATION_HEAD_TABLE.to_string(),
                details: "activation head exists without the schema revision catalog".to_string(),
            });
        }
        return Ok(());
    }

    match mode {
        SchemaActivationHeadMode::Observe => {
            if table_exists(client, SCHEMA_ACTIVATION_HEAD_TABLE)? {
                ensure_schema_activation_head_catalog(client)?;
                observe_schema_activation_head(client, schema)?;
            }
        }
        SchemaActivationHeadMode::Advance => {
            ensure_schema_activation_head_catalog(client)?;
            advance_schema_activation_head(client, schema)?;
        }
    }
    Ok(())
}

fn observe_schema_activation_head(
    client: &mut impl GenericClient,
    schema: &Schema,
) -> Result<(), DbError> {
    if !table_exists(client, SCHEMA_ACTIVATION_HEAD_TABLE)? {
        return Ok(());
    }
    validate_schema_activation_head_trigger(client)?;
    let required_version = client
        .query_opt(
            r#"
            select base_schema_version
            from schema_activation_head
            where app_id = $1 and customer_id = $2
            "#,
            &[&schema.app_id.as_str(), &schema.customer_id.as_str()],
        )?
        .map(|row| row.get::<_, String>(0));
    if required_version
        .as_deref()
        .is_some_and(|required| required != schema.version.as_str())
    {
        return Err(DbError::SchemaDrift {
            object: format!(
                "{SCHEMA_ACTIVATION_HEAD_TABLE}.{}:{}",
                schema.app_id, schema.customer_id
            ),
            details: format!(
                "base schema version `{}` cannot activate behind forward-only head `{}`",
                schema.version,
                required_version.expect("mismatched head is present")
            ),
        });
    }
    Ok(())
}

fn observe_schema_activation_head_for_guarded_transition(
    client: &mut impl GenericClient,
    schema: &Schema,
) -> Result<(), DbError> {
    if !table_exists(client, SCHEMA_ACTIVATION_HEAD_TABLE)? {
        return Ok(());
    }
    validate_schema_activation_head_trigger(client)?;
    let Some(existing_head) = client
        .query_opt(
            r#"
            select base_schema_version
            from schema_activation_head
            where app_id = $1 and customer_id = $2
            "#,
            &[&schema.app_id.as_str(), &schema.customer_id.as_str()],
        )?
        .map(|row| row.get::<_, String>(0))
    else {
        return Ok(());
    };
    let active_base_version = client
        .query_opt(
            r#"
            select base_schema ->> 'version'
            from schema_revision
            where app_id = $1
              and customer_id = $2
              and activated_at is not null
            "#,
            &[&schema.app_id.as_str(), &schema.customer_id.as_str()],
        )?
        .map(|row| row.get::<_, String>(0));
    if active_base_version.as_deref() != Some(existing_head.as_str())
        && active_base_version.as_deref() != Some(schema.version.as_str())
    {
        return Err(DbError::SchemaDrift {
            object: format!(
                "{SCHEMA_ACTIVATION_HEAD_TABLE}.{}:{}",
                schema.app_id, schema.customer_id
            ),
            details: format!(
                "activation head `{existing_head}` does not match active base schema {:?}",
                active_base_version
            ),
        });
    }
    Ok(())
}

fn advance_schema_activation_head(
    client: &mut impl GenericClient,
    schema: &Schema,
) -> Result<(), DbError> {
    let existing_head = client
        .query_opt(
            r#"
            select base_schema_version
            from schema_activation_head
            where app_id = $1 and customer_id = $2
            for update
            "#,
            &[&schema.app_id.as_str(), &schema.customer_id.as_str()],
        )?
        .map(|row| row.get::<_, String>(0));
    if existing_head.as_deref() == Some(schema.version.as_str()) {
        return Ok(());
    }

    if let Some(existing_head) = existing_head.as_deref() {
        let active_base_version = client
            .query_opt(
                r#"
                select base_schema ->> 'version'
                from schema_revision
                where app_id = $1
                  and customer_id = $2
                  and activated_at is not null
                for update
                "#,
                &[&schema.app_id.as_str(), &schema.customer_id.as_str()],
            )?
            .map(|row| row.get::<_, String>(0));
        if active_base_version.as_deref() != Some(existing_head)
            && active_base_version.as_deref() != Some(schema.version.as_str())
        {
            return Err(DbError::SchemaDrift {
                object: format!(
                    "{SCHEMA_ACTIVATION_HEAD_TABLE}.{}:{}",
                    schema.app_id, schema.customer_id
                ),
                details: format!(
                    "activation head `{existing_head}` does not match active base schema {:?}",
                    active_base_version
                ),
            });
        }
        client.execute(
            r#"
            update schema_activation_head
            set base_schema_version = $3, advanced_at = now()
            where app_id = $1 and customer_id = $2
            "#,
            &[
                &schema.app_id.as_str(),
                &schema.customer_id.as_str(),
                &schema.version.as_str(),
            ],
        )?;
    } else {
        client.execute(
            r#"
            insert into schema_activation_head (app_id, customer_id, base_schema_version)
            values ($1, $2, $3)
            "#,
            &[
                &schema.app_id.as_str(),
                &schema.customer_id.as_str(),
                &schema.version.as_str(),
            ],
        )?;
    }
    Ok(())
}

fn ensure_schema_activation_head_catalog(client: &mut impl GenericClient) -> Result<(), DbError> {
    client.batch_execute(&format!(
        r#"
        create table if not exists {SCHEMA_ACTIVATION_HEAD_TABLE} (
          app_id text not null,
          customer_id text not null,
          base_schema_version text not null,
          advanced_at timestamptz not null default now(),
          constraint schema_activation_head_pkey primary key (app_id, customer_id)
        );

        create or replace function {SCHEMA_ACTIVATION_HEAD_FUNCTION}()
        returns trigger
        language plpgsql
        set search_path from current
        as $activation_head$
        {SCHEMA_ACTIVATION_HEAD_FUNCTION_BODY}
        $activation_head$;

        drop trigger if exists {SCHEMA_ACTIVATION_HEAD_TRIGGER} on schema_revision;
        create trigger {SCHEMA_ACTIVATION_HEAD_TRIGGER}
          before insert or update of activated_at, base_schema on schema_revision
          for each row execute function {SCHEMA_ACTIVATION_HEAD_FUNCTION}();
        "#
    ))?;
    ensure_rls(client, SCHEMA_ACTIVATION_HEAD_TABLE)?;
    validate_schema_activation_head_trigger(client)
}

fn validate_schema_activation_head_trigger(client: &mut impl GenericClient) -> Result<(), DbError> {
    let row = client.query_opt(
        r#"
        select
          trigger.tgenabled::text as tgenabled,
          trigger.tgtype,
          pg_get_triggerdef(trigger.oid, true) as trigger_definition,
          trigger.tgqual is null as trigger_when_is_null,
          procedure.prosrc,
          procedure.proconfig
        from pg_trigger trigger
        join pg_class relation on relation.oid = trigger.tgrelid
        join pg_namespace namespace on namespace.oid = relation.relnamespace
        join pg_proc procedure on procedure.oid = trigger.tgfoid
        where namespace.nspname = current_schema()
          and relation.relname = 'schema_revision'
          and trigger.tgname = $1
          and not trigger.tgisinternal
        "#,
        &[&SCHEMA_ACTIVATION_HEAD_TRIGGER],
    )?;
    let Some(row) = row else {
        return Err(DbError::SchemaDrift {
            object: format!("schema_revision.{SCHEMA_ACTIVATION_HEAD_TRIGGER}"),
            details: "forward-only schema activation trigger is missing".to_string(),
        });
    };
    let enabled: String = row.get("tgenabled");
    let trigger_type: i16 = row.get("tgtype");
    let trigger_definition: String = row.get("trigger_definition");
    let trigger_when_is_null: bool = row.get("trigger_when_is_null");
    let function_body: String = row.get("prosrc");
    let function_config: Option<Vec<String>> = row.get("proconfig");
    let is_row = trigger_type & 1 != 0;
    let is_before = trigger_type & 2 != 0;
    let handles_insert = trigger_type & 4 != 0;
    let handles_delete = trigger_type & 8 != 0;
    let handles_update = trigger_type & 16 != 0;
    let handles_truncate = trigger_type & 32 != 0;
    let definition_matches = trigger_definition.contains("UPDATE OF activated_at, base_schema")
        && trigger_definition.contains("ON schema_revision")
        && trigger_definition.contains(&format!(
            "EXECUTE FUNCTION {SCHEMA_ACTIVATION_HEAD_FUNCTION}()"
        ));
    if enabled != "O"
        || !is_row
        || !is_before
        || !handles_insert
        || !handles_update
        || handles_delete
        || handles_truncate
        || !trigger_when_is_null
        || !definition_matches
        || function_body.trim() != SCHEMA_ACTIVATION_HEAD_FUNCTION_BODY.trim()
        || !function_config
            .as_deref()
            .unwrap_or_default()
            .iter()
            .any(|setting| setting.starts_with("search_path="))
    {
        return Err(DbError::SchemaDrift {
            object: format!("schema_revision.{SCHEMA_ACTIVATION_HEAD_TRIGGER}"),
            details: "forward-only schema activation trigger contract drifted".to_string(),
        });
    }
    let competing_trigger = client.query_opt(
        r#"
        select trigger.tgname
        from pg_trigger trigger
        join pg_class relation on relation.oid = trigger.tgrelid
        join pg_namespace namespace on namespace.oid = relation.relnamespace
        where namespace.nspname = current_schema()
          and relation.relname = 'schema_revision'
          and not trigger.tgisinternal
          and trigger.tgname <> $1
          and (trigger.tgtype::integer & 1) <> 0
          and (trigger.tgtype::integer & 2) <> 0
          and (
            (trigger.tgtype::integer & 4) <> 0
            or (trigger.tgtype::integer & 16) <> 0
          )
        order by trigger.tgname
        limit 1
        "#,
        &[&SCHEMA_ACTIVATION_HEAD_TRIGGER],
    )?;
    if let Some(competing_trigger) = competing_trigger {
        let trigger_name: String = competing_trigger.get(0);
        return Err(DbError::SchemaDrift {
            object: format!("schema_revision.{trigger_name}"),
            details: "competing BEFORE ROW INSERT/UPDATE trigger could mutate the revision after the activation-head check".to_string(),
        });
    }
    Ok(())
}

fn ensure_schema_revision_metadata_columns(client: &mut impl GenericClient) -> Result<(), DbError> {
    client.batch_execute(
        r#"
        alter table schema_revision add column if not exists schema_hash text;
        alter table schema_revision add column if not exists materialization_source text;
        alter table schema_revision add column if not exists materialization_git_sha text;
        alter table schema_revision add column if not exists materialization_vercel_deployment_id text;
        alter table schema_revision add column if not exists materialization_vercel_environment text;
        alter table schema_revision add column if not exists materialization_vercel_git_ref text;
        alter table schema_revision add column if not exists materialized_at timestamptz;
        alter table schema_revision add column if not exists authorization_policy_declared boolean;
        "#,
    )?;
    Ok(())
}

fn ensure_agent_run_status_column(client: &mut impl GenericClient) -> Result<(), DbError> {
    client.batch_execute(
        r#"
        alter table agent_run add column if not exists status text not null default 'recorded';
        "#,
    )?;
    Ok(())
}

fn ensure_agent_run_status_check(
    client: &mut impl GenericClient,
    postgres_catalog: &PostgresCatalogSnapshot,
) -> Result<(), DbError> {
    let legacy_status_checks = [
        "status in ('recorded', 'completed', 'validation_exhausted', 'runtime_error')",
        "status in ('recorded', 'completed', 'validation_exhausted', 'runtime_error', 'cancelled')",
    ];
    let existing_status_check = constraint_expr(client, "agent_run", "agent_run_status_check")?;
    let mut should_replace_status_check = false;
    for legacy_status_check in legacy_status_checks {
        let legacy_status_check = postgres_catalog
            .canonical
            .get(CanonicalProbeRequest::Check {
                columns_sql: "status text".to_string(),
                check_sql: legacy_status_check.to_string(),
            });
        if existing_status_check.as_deref() == Some(legacy_status_check) {
            should_replace_status_check = true;
            break;
        }
    }
    if should_replace_status_check {
        client.batch_execute(
            r#"
            alter table agent_run drop constraint agent_run_status_check;
            alter table agent_run add constraint agent_run_status_check check (
              status in ('recorded', 'completed', 'validation_exhausted', 'budget_exhausted', 'runtime_error', 'cancelled')
            );
            "#,
        )?;
        return Ok(());
    }
    ensure_check_constraint(
        client,
        postgres_catalog,
        "agent_run",
        "agent_run_status_check",
        "status text",
        "status in ('recorded', 'completed', 'validation_exhausted', 'budget_exhausted', 'runtime_error', 'cancelled')",
    )
}

fn reject_removed_change_set_contract(
    client: &mut impl GenericClient,
    postgres_catalog: &PostgresCatalogSnapshot,
) -> Result<(), DbError> {
    let reason_exists = column_exists(client, "change_set", "reason")?;
    if reason_exists {
        return Err(DbError::SchemaDrift {
            object: "change_set.reason".to_string(),
            details: "removed column exists; reset the pre-launch database instead of migrating removed shape"
                .to_string(),
        });
    }

    let reverted_count: i64 = client
        .query_one(
            "select count(*) from change_set where status = 'reverted'",
            &[],
        )?
        .get(0);
    if reverted_count > 0 {
        return Err(DbError::SchemaDrift {
            object: "change_set.status".to_string(),
            details: "cannot shrink status enum while reverted rows exist".to_string(),
        });
    }

    let old_status_check = postgres_catalog
        .canonical
        .get(CanonicalProbeRequest::Check {
            columns_sql: CHANGE_SET_COLUMNS.to_string(),
            check_sql: "status in ('draft', 'mainline', 'discarded', 'reverted')".to_string(),
        });
    if constraint_expr(client, "change_set", "change_set_status_check")?.as_deref()
        == Some(old_status_check)
    {
        return Err(DbError::SchemaDrift {
            object: "change_set.status".to_string(),
            details: "removed status enum value remains in check constraint; reset the pre-launch database instead of migrating removed shape".to_string(),
        });
    }

    Ok(())
}

fn column_exists(
    client: &mut impl GenericClient,
    table_name: &str,
    column_name: &str,
) -> Result<bool, DbError> {
    let row = client.query_one(
        r#"
        select exists (
          select 1
          from information_schema.columns
          where table_schema = current_schema()
            and table_name = $1
            and column_name = $2
        )
        "#,
        &[&table_name, &column_name],
    )?;
    Ok(row.get(0))
}

fn table_exists(client: &mut impl GenericClient, table_name: &str) -> Result<bool, DbError> {
    let row = client.query_one(
        r#"
        select exists (
          select 1
          from information_schema.tables
          where table_schema = current_schema()
            and table_name = $1
        )
        "#,
        &[&table_name],
    )?;
    Ok(row.get(0))
}

fn sequence_exists(client: &mut impl GenericClient, sequence_name: &str) -> Result<bool, DbError> {
    let row = client.query_one(
        r#"
        select exists (
          select 1
          from information_schema.sequences
          where sequence_schema = current_schema()
            and sequence_name = $1
        )
        "#,
        &[&sequence_name],
    )?;
    Ok(row.get(0))
}

fn validate_table_exists(client: &mut impl GenericClient, table_name: &str) -> Result<(), DbError> {
    if table_exists(client, table_name)? {
        return Ok(());
    }
    Err(DbError::SchemaDrift {
        object: table_name.to_string(),
        details: "missing table".to_string(),
    })
}

fn validate_sequence_exists(
    client: &mut impl GenericClient,
    sequence_name: &str,
) -> Result<(), DbError> {
    if sequence_exists(client, sequence_name)? {
        return Ok(());
    }
    Err(DbError::SchemaDrift {
        object: sequence_name.to_string(),
        details: "missing sequence".to_string(),
    })
}

fn ensure_substrate_indexes(
    client: &mut impl GenericClient,
    postgres_catalog: &PostgresCatalogSnapshot,
) -> Result<(), DbError> {
    ensure_index(
        client,
        postgres_catalog,
        ExpectedIndex {
            table_name: "schema_revision",
            index_name: "schema_revision_tenant_id_idx",
            create_sql: "create unique index schema_revision_tenant_id_idx on schema_revision (id, app_id, customer_id)",
            columns: &[
                ("id".to_string(), false),
                ("app_id".to_string(), false),
                ("customer_id".to_string(), false),
            ],
            column_probe_sql: SCHEMA_REVISION_COLUMNS,
            predicate_sql: None,
            unique: true,
        },
    )?;
    ensure_index(
        client,
        postgres_catalog,
        ExpectedIndex {
            table_name: "schema_revision",
            index_name: "schema_revision_active_idx",
            create_sql: "create unique index schema_revision_active_idx on schema_revision (app_id, customer_id) where activated_at is not null",
            columns: &[
                ("app_id".to_string(), false),
                ("customer_id".to_string(), false),
            ],
            column_probe_sql: SCHEMA_REVISION_COLUMNS,
            predicate_sql: Some("activated_at is not null"),
            unique: true,
        },
    )?;
    ensure_index(
        client,
        postgres_catalog,
        ExpectedIndex {
            table_name: "change_set",
            index_name: "change_set_tenant_id_idx",
            create_sql: "create unique index change_set_tenant_id_idx on change_set (id, app_id, customer_id)",
            columns: &[
                ("id".to_string(), false),
                ("app_id".to_string(), false),
                ("customer_id".to_string(), false),
            ],
            column_probe_sql: CHANGE_SET_COLUMNS,
            predicate_sql: None,
            unique: true,
        },
    )?;
    ensure_index(
        client,
        postgres_catalog,
        ExpectedIndex {
            table_name: "change_set",
            index_name: "change_set_idempotency_idx",
            create_sql: "create unique index change_set_idempotency_idx on change_set (app_id, customer_id, idempotency_key) where idempotency_key is not null",
            columns: &[
                ("app_id".to_string(), false),
                ("customer_id".to_string(), false),
                ("idempotency_key".to_string(), false),
            ],
            column_probe_sql: CHANGE_SET_COLUMNS,
            predicate_sql: Some("idempotency_key is not null"),
            unique: true,
        },
    )?;
    ensure_index(
        client,
        postgres_catalog,
        ExpectedIndex {
            table_name: "agent_run",
            index_name: "agent_run_tenant_id_idx",
            create_sql:
                "create unique index agent_run_tenant_id_idx on agent_run (id, app_id, customer_id)",
            columns: &[
                ("id".to_string(), false),
                ("app_id".to_string(), false),
                ("customer_id".to_string(), false),
            ],
            column_probe_sql: AGENT_RUN_COLUMNS,
            predicate_sql: None,
            unique: true,
        },
    )?;
    Ok(())
}

fn store_schema_revision(
    client: &mut impl GenericClient,
    base_schema: &Schema,
    overlay: &SchemaRevisionOverlay,
    schema: &Schema,
    provenance: Option<&SchemaRevisionProvenance>,
) -> Result<SchemaRevisionId, DbError> {
    let schema_json = serde_json::to_value(schema).expect("schema contract serializes");
    let base_schema_json = serde_json::to_value(base_schema).expect("base schema serializes");
    let overlay_json = serde_json::to_value(overlay).expect("schema overlay serializes");
    let schema_hash = schema_json_hash(&schema_json);

    if let Some(row) = client.query_opt(
        "select id, schema from schema_revision where app_id = $1 and customer_id = $2 and version = $3",
        &[&schema.app_id.as_str(), &schema.customer_id.as_str(), &schema.version.as_str()],
    )? {
        let existing_schema: Value = row.get("schema");
        if existing_schema != schema_json {
            return Err(schema_revision_conflict(&existing_schema, &schema_json));
        }
        let id: i64 = row.get("id");
        update_schema_revision_provenance(client, id, schema, provenance)?;
        activate_revision(client, schema, id)?;
        return Ok(SchemaRevisionId::new(id));
    }

    let row = client.query_one(
        r#"
        insert into schema_revision (
          app_id,
          customer_id,
          version,
          base_schema,
          customer_overlay,
          schema,
          schema_hash,
          materialization_source,
          materialization_git_sha,
          materialization_vercel_deployment_id,
          materialization_vercel_environment,
          materialization_vercel_git_ref,
          materialized_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
        returning id
        "#,
        &[
            &schema.app_id.as_str(),
            &schema.customer_id.as_str(),
            &schema.version.as_str(),
            &base_schema_json,
            &overlay_json,
            &schema_json,
            &schema_hash,
            &provenance.and_then(|provenance| provenance.materialization_source.as_deref()),
            &provenance.and_then(|provenance| provenance.git_sha.as_deref()),
            &provenance.and_then(|provenance| provenance.vercel_deployment_id.as_deref()),
            &provenance.and_then(|provenance| provenance.vercel_environment.as_deref()),
            &provenance.and_then(|provenance| provenance.vercel_git_ref.as_deref()),
        ],
    )?;
    let id: i64 = row.get("id");
    activate_revision(client, schema, id)?;
    Ok(SchemaRevisionId::new(id))
}

fn update_schema_revision_provenance(
    client: &mut impl GenericClient,
    revision_id: i64,
    schema: &Schema,
    provenance: Option<&SchemaRevisionProvenance>,
) -> Result<(), DbError> {
    let schema_hash = schema_hash(schema);
    client.execute(
        r#"
        update schema_revision
        set schema_hash = $2,
            materialization_source = coalesce($3, materialization_source),
            materialization_git_sha = coalesce($4, materialization_git_sha),
            materialization_vercel_deployment_id = coalesce($5, materialization_vercel_deployment_id),
            materialization_vercel_environment = coalesce($6, materialization_vercel_environment),
            materialization_vercel_git_ref = coalesce($7, materialization_vercel_git_ref),
            materialized_at = now()
        where id = $1
        "#,
        &[
            &revision_id,
            &schema_hash,
            &provenance.and_then(|provenance| provenance.materialization_source.as_deref()),
            &provenance.and_then(|provenance| provenance.git_sha.as_deref()),
            &provenance.and_then(|provenance| provenance.vercel_deployment_id.as_deref()),
            &provenance.and_then(|provenance| provenance.vercel_environment.as_deref()),
            &provenance.and_then(|provenance| provenance.vercel_git_ref.as_deref()),
        ],
    )?;
    Ok(())
}

fn update_schema_revision_contract_json(
    client: &mut impl GenericClient,
    revision_id: i64,
    base_schema_json: &Value,
    schema_json: &Value,
) -> Result<(), DbError> {
    let schema_hash = schema_json_hash(schema_json);
    client.execute(
        r#"
        update schema_revision
        set base_schema = $2,
            schema = $3,
            schema_hash = $4
        where id = $1
        "#,
        &[&revision_id, base_schema_json, schema_json, &schema_hash],
    )?;
    Ok(())
}

fn activate_revision(
    client: &mut impl GenericClient,
    schema: &Schema,
    revision_id: i64,
) -> Result<(), DbError> {
    client.execute(
        "update schema_revision set activated_at = null where app_id = $1 and customer_id = $2 and id <> $3",
        &[&schema.app_id.as_str(), &schema.customer_id.as_str(), &revision_id],
    )?;
    client.execute(
        "update schema_revision set activated_at = coalesce(activated_at, now()) where id = $1",
        &[&revision_id],
    )?;
    Ok(())
}

fn ensure_record_table(
    client: &mut impl GenericClient,
    physical_model: &PhysicalModel,
    mode: MaterializationMode,
    postgres_catalog: &PostgresCatalogSnapshot,
) -> Result<(), DbError> {
    let table = quote_identifier(&physical_model.record_table);
    let pkey_name = constraint_name(&physical_model.record_table, "pkey");
    let tenant_key_name = constraint_name(&physical_model.record_table, "tenant_id_key");
    match mode {
        MaterializationMode::CreateMissing => client.batch_execute(&format!(
            r#"
        create table if not exists {table} (
          id uuid,
          app_id text not null,
          customer_id text not null,
          external_key text,
          created_at timestamptz not null default now(),
          constraint {} primary key (id),
          constraint {} unique (id, app_id, customer_id)
        );
        "#,
            quote_identifier(&pkey_name),
            quote_identifier(&tenant_key_name)
        ))?,
        MaterializationMode::ValidateExisting => {
            postgres_catalog.validate_table_exists(&physical_model.record_table)?;
        }
    }

    if postgres_catalog
        .tables
        .contains(&physical_model.record_table)
    {
        validate_columns_against(
            postgres_catalog,
            &physical_model.record_table,
            &record_table_columns(),
            postgres_catalog.columns(&physical_model.record_table),
        )?;
    }
    ensure_key_constraint(
        client,
        postgres_catalog,
        &physical_model.record_table,
        &pkey_name,
        "p",
        &["id"],
    )?;
    ensure_key_constraint(
        client,
        postgres_catalog,
        &physical_model.record_table,
        &tenant_key_name,
        "u",
        &["id", "app_id", "customer_id"],
    )?;
    let index_name =
        bounded_physical_identifier(&format!("{}_external_key_idx", physical_model.record_table));
    let create_sql = format!(
            "create unique index {} on {table} (app_id, customer_id, external_key) where external_key is not null",
            quote_identifier(&index_name)
    );
    ensure_index(
        client,
        postgres_catalog,
        ExpectedIndex {
            table_name: &physical_model.record_table,
            index_name: &index_name,
            create_sql: &create_sql,
            columns: &[
                ("app_id".to_string(), false),
                ("customer_id".to_string(), false),
                ("external_key".to_string(), false),
            ],
            column_probe_sql: RECORD_COLUMNS,
            predicate_sql: Some("external_key is not null"),
            unique: true,
        },
    )?;
    ensure_rls_against(client, &physical_model.record_table, postgres_catalog)?;
    Ok(())
}

struct VersionMaterializationContext<'a> {
    physical_models: &'a BTreeMap<ModelId, PhysicalModel>,
    mode: MaterializationMode,
    unexpected_column_mode: UnexpectedColumnMode,
    catalog: &'a MaterializationCatalog,
    postgres_catalog: &'a PostgresCatalogSnapshot,
}

fn ensure_version_table(
    client: &mut impl GenericClient,
    model: &Model,
    physical_model: &PhysicalModel,
    context: VersionMaterializationContext<'_>,
) -> Result<(), DbError> {
    let VersionMaterializationContext {
        physical_models,
        mode,
        unexpected_column_mode,
        catalog,
        postgres_catalog,
    } = context;
    let table = quote_identifier(&physical_model.version_table);
    let record_table = quote_identifier(&physical_model.record_table);
    let pkey_name = constraint_name(&physical_model.version_table, "pkey");
    let record_fk_name = constraint_name(&physical_model.version_table, "record_tenant_fk");
    let change_set_fk_name = constraint_name(&physical_model.version_table, "change_set_tenant_fk");
    match mode {
        MaterializationMode::CreateMissing => client.batch_execute(&format!(
            r#"
        create table if not exists {table} (
          id uuid,
          record_id uuid not null,
          app_id text not null,
          customer_id text not null,
          stage text not null,
          effective_start date not null,
          effective_end date,
          change_set_id bigint not null,
          created_at timestamptz not null default now(),
          applied_at timestamptz,
          tombstones_record bool not null default false,
          untombstones_record bool not null default false,
          provenance jsonb,
          custom_fields jsonb not null default '[]',
          constraint {} primary key (id),
          constraint {} foreign key (record_id, app_id, customer_id) references {record_table}(id, app_id, customer_id),
          constraint {} foreign key (change_set_id, app_id, customer_id) references change_set(id, app_id, customer_id)
        );
        "#,
            quote_identifier(&pkey_name),
            quote_identifier(&record_fk_name),
            quote_identifier(&change_set_fk_name)
        ))?,
        MaterializationMode::ValidateExisting => {
            postgres_catalog.validate_table_exists(&physical_model.version_table)?;
        }
    }

    if postgres_catalog
        .tables
        .contains(&physical_model.version_table)
    {
        ensure_key_constraint(
            client,
            postgres_catalog,
            &physical_model.version_table,
            &pkey_name,
            "p",
            &["id"],
        )?;
        ensure_fk_constraint(
            client,
            postgres_catalog,
            &physical_model.version_table,
            &record_fk_name,
            &["record_id", "app_id", "customer_id"],
            &physical_model.record_table,
            &["id", "app_id", "customer_id"],
        )?;
        ensure_fk_constraint(
            client,
            postgres_catalog,
            &physical_model.version_table,
            &change_set_fk_name,
            &["change_set_id", "app_id", "customer_id"],
            "change_set",
            &["id", "app_id", "customer_id"],
        )?;
    }

    let mut version_columns = VERSION_COLUMNS.to_string();
    let mut expected_columns = version_table_columns();
    for field in &model.fields {
        for column in field_columns(field, physical_models)? {
            let expected_column = ColumnSpec {
                name: column.name.clone(),
                data_type: column.validation_type.clone(),
                not_null: false,
                default: DefaultSpec::None,
            };
            if mode == MaterializationMode::CreateMissing
                || unexpected_column_mode == UnexpectedColumnMode::Repair
            {
                client.batch_execute(&format!(
                    "alter table {table} add column if not exists {} {};",
                    quote_identifier(&column.name),
                    column.sql_type
                ))?;
            }
            version_columns.push_str(", ");
            version_columns.push_str(&column.definition);
            expected_columns.push(expected_column);
        }
    }
    let current_required_columns = required_version_columns(model, physical_models)?;
    let current_unique_columns = unique_version_columns(model, physical_models)?;
    let retained_columns =
        retained_version_table_columns(&physical_model.version_table, expected_columns, catalog);
    reject_unsupported_sibling_field_contracts(
        &physical_model.version_table,
        &current_required_columns,
        &current_unique_columns,
        catalog,
    )?;
    if unexpected_column_mode == UnexpectedColumnMode::Repair {
        drop_unsupported_field_artifacts(
            client,
            physical_model,
            &retained_columns,
            &current_required_columns,
            &current_unique_columns,
        )?;
        drop_unexpected_columns(
            client,
            &physical_model.version_table,
            &retained_columns,
            postgres_catalog,
        )?;
    }

    ensure_relation_fks(
        client,
        model,
        physical_model,
        physical_models,
        postgres_catalog,
    )?;
    ensure_version_checks(
        client,
        physical_model,
        &version_columns,
        model,
        physical_models,
        postgres_catalog,
    )?;
    ensure_version_indexes(client, physical_model, postgres_catalog)?;
    ensure_unique_field_indexes(
        client,
        model,
        physical_model,
        physical_models,
        &version_columns,
        postgres_catalog,
    )?;
    ensure_rls_against(client, &physical_model.version_table, postgres_catalog)?;
    Ok(())
}

fn expected_version_table_columns(
    model: &Model,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
) -> Result<Vec<ColumnSpec>, DbError> {
    let mut expected_columns = version_table_columns();
    for field in &model.fields {
        expected_columns.extend(
            field_columns(field, physical_models)?
                .into_iter()
                .map(|column| ColumnSpec {
                    name: column.name,
                    data_type: column.validation_type,
                    not_null: false,
                    default: DefaultSpec::None,
                }),
        );
    }
    Ok(expected_columns)
}

fn required_version_columns(
    model: &Model,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
) -> Result<BTreeSet<String>, DbError> {
    let mut required_columns = BTreeSet::new();
    for field in &model.fields {
        if field.required {
            required_columns.extend(
                field_columns(field, physical_models)?
                    .into_iter()
                    .map(|column| column.name),
            );
        }
    }
    Ok(required_columns)
}

fn unique_version_columns(
    model: &Model,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
) -> Result<BTreeSet<String>, DbError> {
    let mut unique_columns = BTreeSet::new();
    for field in model.fields.iter().filter(|field| field.is_unique) {
        let columns = field_columns(field, physical_models)?;
        unique_columns.insert(unique_field_column(field, &columns)?.name.clone());
    }
    Ok(unique_columns)
}

fn validate_record_table_contract(
    client: &mut impl GenericClient,
    physical_model: &PhysicalModel,
    postgres_catalog: &PostgresCatalogSnapshot,
) -> Result<(), DbError> {
    let pkey_name = constraint_name(&physical_model.record_table, "pkey");
    let tenant_key_name = constraint_name(&physical_model.record_table, "tenant_id_key");
    postgres_catalog.validate_table_exists(&physical_model.record_table)?;
    validate_columns_against(
        postgres_catalog,
        &physical_model.record_table,
        &record_table_columns(),
        postgres_catalog.columns(&physical_model.record_table),
    )?;
    validate_key_constraint(
        postgres_catalog,
        &physical_model.record_table,
        &pkey_name,
        "p",
        &["id"],
    )?;
    validate_key_constraint(
        postgres_catalog,
        &physical_model.record_table,
        &tenant_key_name,
        "u",
        &["id", "app_id", "customer_id"],
    )?;
    let index_name =
        bounded_physical_identifier(&format!("{}_external_key_idx", physical_model.record_table));
    validate_index(
        client,
        postgres_catalog,
        ExpectedIndex {
            table_name: &physical_model.record_table,
            index_name: &index_name,
            create_sql: "",
            columns: &[
                ("app_id".to_string(), false),
                ("customer_id".to_string(), false),
                ("external_key".to_string(), false),
            ],
            column_probe_sql: RECORD_COLUMNS,
            predicate_sql: Some("external_key is not null"),
            unique: true,
        },
    )?;
    validate_rls_against(
        &physical_model.record_table,
        postgres_catalog.rls(&physical_model.record_table),
        postgres_catalog,
    )?;
    Ok(())
}

fn validate_version_table_contract(
    client: &mut impl GenericClient,
    model: &Model,
    physical_model: &PhysicalModel,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
    catalog: &MaterializationCatalog,
    postgres_catalog: &PostgresCatalogSnapshot,
) -> Result<(), DbError> {
    let pkey_name = constraint_name(&physical_model.version_table, "pkey");
    let record_fk_name = constraint_name(&physical_model.version_table, "record_tenant_fk");
    let change_set_fk_name = constraint_name(&physical_model.version_table, "change_set_tenant_fk");
    postgres_catalog.validate_table_exists(&physical_model.version_table)?;
    validate_key_constraint(
        postgres_catalog,
        &physical_model.version_table,
        &pkey_name,
        "p",
        &["id"],
    )?;
    validate_fk_constraint(
        postgres_catalog,
        &physical_model.version_table,
        &record_fk_name,
        &["record_id", "app_id", "customer_id"],
        &physical_model.record_table,
        &["id", "app_id", "customer_id"],
    )?;
    validate_fk_constraint(
        postgres_catalog,
        &physical_model.version_table,
        &change_set_fk_name,
        &["change_set_id", "app_id", "customer_id"],
        "change_set",
        &["id", "app_id", "customer_id"],
    )?;

    let mut version_columns = VERSION_COLUMNS.to_string();
    let mut expected_columns = version_table_columns();
    for field in &model.fields {
        for column in field_columns(field, physical_models)? {
            version_columns.push_str(", ");
            version_columns.push_str(&column.definition);
            expected_columns.push(ColumnSpec {
                name: column.name,
                data_type: column.validation_type,
                not_null: false,
                default: DefaultSpec::None,
            });
        }
    }
    validate_relation_fks(model, physical_model, physical_models, postgres_catalog)?;
    validate_version_checks(
        client,
        physical_model,
        &version_columns,
        model,
        physical_models,
        postgres_catalog,
    )?;
    validate_version_indexes(client, physical_model, postgres_catalog)?;
    validate_unique_field_indexes(
        client,
        model,
        physical_model,
        physical_models,
        &version_columns,
        postgres_catalog,
    )?;
    validate_rls_against(
        &physical_model.version_table,
        postgres_catalog.rls(&physical_model.version_table),
        postgres_catalog,
    )?;
    let current_required_columns = required_version_columns(model, physical_models)?;
    let current_unique_columns = unique_version_columns(model, physical_models)?;
    let retained_columns =
        retained_version_table_columns(&physical_model.version_table, expected_columns, catalog);
    reject_unsupported_sibling_field_contracts(
        &physical_model.version_table,
        &current_required_columns,
        &current_unique_columns,
        catalog,
    )?;
    validate_no_unsupported_field_artifacts(
        postgres_catalog,
        physical_model,
        &retained_columns,
        &current_required_columns,
        &current_unique_columns,
    )?;
    validate_columns_against(
        postgres_catalog,
        &physical_model.version_table,
        &retained_columns,
        postgres_catalog.columns(&physical_model.version_table),
    )?;
    Ok(())
}

fn ensure_query_role_exists(client: &mut Client) -> Result<(), DbError> {
    // PostgreSQL roles are shared across schemas. Finish this deliberately
    // short global critical section before opening a materialization
    // transaction, so no transaction can hold schema catalog/relation locks
    // while it waits for the query-role advisory lock.
    let mut tx = client.transaction()?;
    tx.query_one(
        "select pg_advisory_xact_lock(hashtext($1)::bigint)",
        &[&QUERY_ROLE],
    )?;
    tx.batch_execute(&format!(
        r#"
        do $$
        begin
          if not exists (select 1 from pg_roles where rolname = '{QUERY_ROLE}') then
            create role {role} nologin;
          end if;
        exception when duplicate_object then
          null;
        end
        $$;
        "#,
        role = quote_identifier(QUERY_ROLE)
    ))?;
    tx.commit()?;
    Ok(())
}

fn ensure_query_role_grants(
    client: &mut impl GenericClient,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
) -> Result<(), DbError> {
    // The global role was bootstrapped before this materialization transaction
    // began. These object grants are schema-local and intentionally do not
    // reacquire that global lock before the validation catalog snapshot.
    let schema_name: String = client.query_one("select current_schema()", &[])?.get(0);
    client.batch_execute(&format!(
        "grant usage on schema {} to {}; revoke all privileges on change_set from {}; revoke all privileges on schema_revision from {}; revoke all privileges on agent_run from {};",
        quote_identifier(&schema_name),
        quote_identifier(QUERY_ROLE),
        quote_identifier(QUERY_ROLE),
        quote_identifier(QUERY_ROLE),
        quote_identifier(QUERY_ROLE)
    ))?;
    for physical_model in physical_models.values() {
        client.batch_execute(&format!(
            "revoke all privileges on {} from {}; revoke all privileges on {} from {};",
            quote_identifier(&physical_model.record_table),
            quote_identifier(QUERY_ROLE),
            quote_identifier(&physical_model.version_table),
            quote_identifier(QUERY_ROLE)
        ))?;
    }
    Ok(())
}

fn ensure_relation_fks(
    client: &mut impl GenericClient,
    model: &Model,
    physical_model: &PhysicalModel,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
    postgres_catalog: &PostgresCatalogSnapshot,
) -> Result<(), DbError> {
    for field in &model.fields {
        if !matches!(field.field_type, FieldType::Relation) {
            continue;
        }
        let columns = field_columns(field, physical_models)?;
        let relation_column = columns.first().expect("relation has one column");
        let target_model = field.target_model.as_ref().expect("schema was validated");
        let target = physical_models
            .get(target_model)
            .expect("relation target was validated");
        ensure_fk_constraint(
            client,
            postgres_catalog,
            &physical_model.version_table,
            &constraint_name(
                &physical_model.version_table,
                &format!("{}_tenant_fk", relation_column.name),
            ),
            &[&relation_column.name, "app_id", "customer_id"],
            &target.record_table,
            &["id", "app_id", "customer_id"],
        )?;
    }
    Ok(())
}

fn validate_relation_fks(
    model: &Model,
    physical_model: &PhysicalModel,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
    postgres_catalog: &PostgresCatalogSnapshot,
) -> Result<(), DbError> {
    for field in &model.fields {
        if !matches!(field.field_type, FieldType::Relation) {
            continue;
        }
        let columns = field_columns(field, physical_models)?;
        let relation_column = columns.first().expect("relation has one column");
        let target_model = field.target_model.as_ref().expect("schema was validated");
        let target = physical_models
            .get(target_model)
            .expect("relation target was validated");
        validate_fk_constraint(
            postgres_catalog,
            &physical_model.version_table,
            &constraint_name(
                &physical_model.version_table,
                &format!("{}_tenant_fk", relation_column.name),
            ),
            &[&relation_column.name, "app_id", "customer_id"],
            &target.record_table,
            &["id", "app_id", "customer_id"],
        )?;
    }
    Ok(())
}

fn ensure_version_checks(
    client: &mut impl GenericClient,
    physical_model: &PhysicalModel,
    version_columns: &str,
    model: &Model,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
    postgres_catalog: &PostgresCatalogSnapshot,
) -> Result<(), DbError> {
    let table = &physical_model.version_table;
    ensure_check_constraint(
        client,
        postgres_catalog,
        table,
        &constraint_name(table, "stage_check"),
        version_columns,
        "stage in ('draft', 'mainline', 'discarded', 'reverted')",
    )?;
    ensure_check_constraint(
        client,
        postgres_catalog,
        table,
        &constraint_name(table, "effective_range_check"),
        version_columns,
        "effective_end is null or effective_end >= effective_start",
    )?;
    ensure_check_constraint(
        client,
        postgres_catalog,
        table,
        &constraint_name(table, "applied_at_stage_check"),
        version_columns,
        "(stage = 'mainline') = (applied_at is not null)",
    )?;
    ensure_check_constraint(
        client,
        postgres_catalog,
        table,
        &constraint_name(table, "record_event_exclusion_check"),
        version_columns,
        "not (tombstones_record and untombstones_record)",
    )?;

    for field in &model.fields {
        let columns = field_columns(field, physical_models)?;
        for column in &columns {
            ensure_check_constraint(
                client,
                postgres_catalog,
                table,
                &constraint_name(table, &format!("{}_record_event_null_check", column.name)),
                version_columns,
                &format!(
                    "(not tombstones_record and not untombstones_record) or {} is null",
                    quote_identifier(&column.name)
                ),
            )?;
        }
        if field.required {
            for column in &columns {
                ensure_check_constraint(
                    client,
                    postgres_catalog,
                    table,
                    &constraint_name(table, &format!("{}_required_check", column.name)),
                    version_columns,
                    &format!(
                        "tombstones_record or untombstones_record or {} is not null",
                        quote_identifier(&column.name)
                    ),
                )?;
            }
        }
        if matches!(field.field_type, FieldType::MoneyRate) {
            ensure_money_rate_all_or_none_check(
                client,
                table,
                version_columns,
                &columns,
                postgres_catalog,
            )?;
            let period_column = columns
                .iter()
                .find(|column| column.name.ends_with("_period"))
                .expect("money_rate has period column");
            ensure_check_constraint(
                client,
                postgres_catalog,
                table,
                &constraint_name(table, &format!("{}_period_check", period_column.name)),
                version_columns,
                &format!(
                    "{} is null or {} in ({})",
                    quote_identifier(&period_column.name),
                    quote_identifier(&period_column.name),
                    MoneyRatePeriod::sql_literals()
                ),
            )?;
        }
    }
    Ok(())
}

fn validate_version_checks(
    client: &mut impl GenericClient,
    physical_model: &PhysicalModel,
    version_columns: &str,
    model: &Model,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
    postgres_catalog: &PostgresCatalogSnapshot,
) -> Result<(), DbError> {
    let table = &physical_model.version_table;
    validate_check_constraint(
        client,
        postgres_catalog,
        table,
        &constraint_name(table, "stage_check"),
        version_columns,
        "stage in ('draft', 'mainline', 'discarded', 'reverted')",
    )?;
    validate_check_constraint(
        client,
        postgres_catalog,
        table,
        &constraint_name(table, "effective_range_check"),
        version_columns,
        "effective_end is null or effective_end >= effective_start",
    )?;
    validate_check_constraint(
        client,
        postgres_catalog,
        table,
        &constraint_name(table, "applied_at_stage_check"),
        version_columns,
        "(stage = 'mainline') = (applied_at is not null)",
    )?;
    validate_check_constraint(
        client,
        postgres_catalog,
        table,
        &constraint_name(table, "record_event_exclusion_check"),
        version_columns,
        "not (tombstones_record and untombstones_record)",
    )?;

    for field in &model.fields {
        let columns = field_columns(field, physical_models)?;
        for column in &columns {
            validate_check_constraint(
                client,
                postgres_catalog,
                table,
                &constraint_name(table, &format!("{}_record_event_null_check", column.name)),
                version_columns,
                &format!(
                    "(not tombstones_record and not untombstones_record) or {} is null",
                    quote_identifier(&column.name)
                ),
            )?;
        }
        if field.required {
            for column in &columns {
                validate_check_constraint(
                    client,
                    postgres_catalog,
                    table,
                    &constraint_name(table, &format!("{}_required_check", column.name)),
                    version_columns,
                    &format!(
                        "tombstones_record or untombstones_record or {} is not null",
                        quote_identifier(&column.name)
                    ),
                )?;
            }
        }
        if matches!(field.field_type, FieldType::MoneyRate) {
            validate_money_rate_all_or_none_check(
                client,
                table,
                version_columns,
                &columns,
                postgres_catalog,
            )?;
            let period_column = columns
                .iter()
                .find(|column| column.name.ends_with("_period"))
                .expect("money_rate has period column");
            validate_check_constraint(
                client,
                postgres_catalog,
                table,
                &constraint_name(table, &format!("{}_period_check", period_column.name)),
                version_columns,
                &format!(
                    "{} is null or {} in ({})",
                    quote_identifier(&period_column.name),
                    quote_identifier(&period_column.name),
                    MoneyRatePeriod::sql_literals()
                ),
            )?;
        }
    }
    Ok(())
}

fn ensure_money_rate_all_or_none_check(
    client: &mut impl GenericClient,
    table: &str,
    version_columns: &str,
    columns: &[FieldColumn],
    postgres_catalog: &PostgresCatalogSnapshot,
) -> Result<(), DbError> {
    let amount = columns
        .iter()
        .find(|column| column.name.ends_with("_amount"))
        .expect("money_rate has amount column");
    let currency = columns
        .iter()
        .find(|column| column.name.ends_with("_currency"))
        .expect("money_rate has currency column");
    let period = columns
        .iter()
        .find(|column| column.name.ends_with("_period"))
        .expect("money_rate has period column");
    ensure_check_constraint(
        client,
        postgres_catalog,
        table,
        &constraint_name(table, &format!("{}_all_or_none_check", amount.name)),
        version_columns,
        &format!(
            "(({} is null and {} is null and {} is null) or ({} is not null and {} is not null and {} is not null))",
            quote_identifier(&amount.name),
            quote_identifier(&currency.name),
            quote_identifier(&period.name),
            quote_identifier(&amount.name),
            quote_identifier(&currency.name),
            quote_identifier(&period.name),
        ),
    )
}

fn validate_money_rate_all_or_none_check(
    client: &mut impl GenericClient,
    table: &str,
    version_columns: &str,
    columns: &[FieldColumn],
    postgres_catalog: &PostgresCatalogSnapshot,
) -> Result<(), DbError> {
    let amount = columns
        .iter()
        .find(|column| column.name.ends_with("_amount"))
        .expect("money_rate has amount column");
    let currency = columns
        .iter()
        .find(|column| column.name.ends_with("_currency"))
        .expect("money_rate has currency column");
    let period = columns
        .iter()
        .find(|column| column.name.ends_with("_period"))
        .expect("money_rate has period column");
    validate_check_constraint(
        client,
        postgres_catalog,
        table,
        &constraint_name(table, &format!("{}_all_or_none_check", amount.name)),
        version_columns,
        &format!(
            "(({} is null and {} is null and {} is null) or ({} is not null and {} is not null and {} is not null))",
            quote_identifier(&amount.name),
            quote_identifier(&currency.name),
            quote_identifier(&period.name),
            quote_identifier(&amount.name),
            quote_identifier(&currency.name),
            quote_identifier(&period.name),
        ),
    )
}

fn ensure_version_indexes(
    client: &mut impl GenericClient,
    physical_model: &PhysicalModel,
    postgres_catalog: &PostgresCatalogSnapshot,
) -> Result<(), DbError> {
    let table_name = &physical_model.version_table;
    let table = quote_identifier(table_name);

    let lookup_index = bounded_physical_identifier(&format!("{table_name}_lookup_idx"));
    let lookup_sql = format!(
        "create index {} on {table} (record_id, stage, effective_start desc)",
        quote_identifier(&lookup_index)
    );
    ensure_index(
        client,
        postgres_catalog,
        ExpectedIndex {
            table_name,
            index_name: &lookup_index,
            create_sql: &lookup_sql,
            columns: &[
                ("record_id".to_string(), false),
                ("stage".to_string(), false),
                ("effective_start".to_string(), true),
            ],
            column_probe_sql: VERSION_INDEX_COLUMNS,
            predicate_sql: None,
            unique: false,
        },
    )?;
    let change_set_index = bounded_physical_identifier(&format!("{table_name}_change_set_idx"));
    let change_set_sql = format!(
        "create index {} on {table} (change_set_id)",
        quote_identifier(&change_set_index)
    );
    ensure_index(
        client,
        postgres_catalog,
        ExpectedIndex {
            table_name,
            index_name: &change_set_index,
            create_sql: &change_set_sql,
            columns: &[("change_set_id".to_string(), false)],
            column_probe_sql: VERSION_INDEX_COLUMNS,
            predicate_sql: None,
            unique: false,
        },
    )?;
    let legacy_mainline_index =
        bounded_physical_identifier(&format!("{table_name}_mainline_unique_idx"));
    client.batch_execute(&format!(
        "drop index if exists {}",
        quote_identifier(&legacy_mainline_index)
    ))?;
    let value_index =
        bounded_physical_identifier(&format!("{table_name}_change_set_value_once_idx"));
    let value_sql = format!(
        "create unique index {} on {table} (record_id, effective_start, change_set_id) where not tombstones_record and not untombstones_record",
        quote_identifier(&value_index)
    );
    ensure_index(
        client,
        postgres_catalog,
        ExpectedIndex {
            table_name,
            index_name: &value_index,
            create_sql: &value_sql,
            columns: &[
                ("record_id".to_string(), false),
                ("effective_start".to_string(), false),
                ("change_set_id".to_string(), false),
            ],
            column_probe_sql: VERSION_INDEX_COLUMNS,
            predicate_sql: Some("not tombstones_record and not untombstones_record"),
            unique: true,
        },
    )?;
    let lifecycle_index =
        bounded_physical_identifier(&format!("{table_name}_mainline_lifecycle_once_idx"));
    let lifecycle_sql = format!(
        "create unique index {} on {table} (record_id, effective_start, tombstones_record, untombstones_record) where stage = 'mainline' and (tombstones_record or untombstones_record)",
        quote_identifier(&lifecycle_index)
    );
    ensure_index(
        client,
        postgres_catalog,
        ExpectedIndex {
            table_name,
            index_name: &lifecycle_index,
            create_sql: &lifecycle_sql,
            columns: &[
                ("record_id".to_string(), false),
                ("effective_start".to_string(), false),
                ("tombstones_record".to_string(), false),
                ("untombstones_record".to_string(), false),
            ],
            column_probe_sql: VERSION_INDEX_COLUMNS,
            predicate_sql: Some(
                "stage = 'mainline' and (tombstones_record or untombstones_record)",
            ),
            unique: true,
        },
    )?;
    Ok(())
}

fn ensure_unique_field_indexes(
    client: &mut impl GenericClient,
    model: &Model,
    physical_model: &PhysicalModel,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
    version_columns: &str,
    postgres_catalog: &PostgresCatalogSnapshot,
) -> Result<(), DbError> {
    let table_name = &physical_model.version_table;
    let table = quote_identifier(table_name);
    for field in model.fields.iter().filter(|field| field.is_unique) {
        let columns = field_columns(field, physical_models)?;
        let column = unique_field_column(field, &columns)?;
        let duplicate_sql = format!(
            r#"
            select app_id, customer_id, {column}::text as value
            from {table}
            where stage = 'mainline'
              and effective_end is null
              and {column} is not null
            group by app_id, customer_id, {column}
            having count(*) > 1
            limit 1
            "#,
            column = quote_identifier(&column.name)
        );
        if let Some(row) = client.query_opt(&duplicate_sql, &[])? {
            let app_id: String = row.get("app_id");
            let customer_id: String = row.get("customer_id");
            let value: String = row.get("value");
            return Err(DbError::SchemaDrift {
                object: format!("{}.{}", table_name, unique_field_index_name(physical_model, column)),
                details: format!(
                    "duplicate live mainline value before unique index creation: scope={app_id}/{customer_id}; field={}.{}; value={value}",
                    model.id, field.id
                ),
            });
        }

        let index_name = unique_field_index_name(physical_model, column);
        let predicate = format!(
            "stage = 'mainline' and effective_end is null and {} is not null",
            quote_identifier(&column.name)
        );
        let create_sql = format!(
            "create unique index {} on {table} (app_id, customer_id, {}) where {predicate}",
            quote_identifier(&index_name),
            quote_identifier(&column.name)
        );
        let index_columns = vec![
            ("app_id".to_string(), false),
            ("customer_id".to_string(), false),
            (column.name.clone(), false),
        ];
        ensure_index(
            client,
            postgres_catalog,
            ExpectedIndex {
                table_name,
                index_name: &index_name,
                create_sql: &create_sql,
                columns: &index_columns,
                column_probe_sql: version_columns,
                predicate_sql: Some(&predicate),
                unique: true,
            },
        )?;
    }
    Ok(())
}

fn validate_version_indexes(
    client: &mut impl GenericClient,
    physical_model: &PhysicalModel,
    postgres_catalog: &PostgresCatalogSnapshot,
) -> Result<(), DbError> {
    let table_name = &physical_model.version_table;
    let lookup_index = bounded_physical_identifier(&format!("{table_name}_lookup_idx"));
    validate_index(
        client,
        postgres_catalog,
        ExpectedIndex {
            table_name,
            index_name: &lookup_index,
            create_sql: "",
            columns: &[
                ("record_id".to_string(), false),
                ("stage".to_string(), false),
                ("effective_start".to_string(), true),
            ],
            column_probe_sql: VERSION_INDEX_COLUMNS,
            predicate_sql: None,
            unique: false,
        },
    )?;
    let change_set_index = bounded_physical_identifier(&format!("{table_name}_change_set_idx"));
    validate_index(
        client,
        postgres_catalog,
        ExpectedIndex {
            table_name,
            index_name: &change_set_index,
            create_sql: "",
            columns: &[("change_set_id".to_string(), false)],
            column_probe_sql: VERSION_INDEX_COLUMNS,
            predicate_sql: None,
            unique: false,
        },
    )?;
    let legacy_mainline_index =
        bounded_physical_identifier(&format!("{table_name}_mainline_unique_idx"));
    if postgres_catalog.index(&legacy_mainline_index).is_some() {
        return Err(DbError::SchemaDrift {
            object: format!("{table_name}.{legacy_mainline_index}"),
            details: "legacy mainline uniqueness index is still present".to_string(),
        });
    }
    let value_index =
        bounded_physical_identifier(&format!("{table_name}_change_set_value_once_idx"));
    validate_index(
        client,
        postgres_catalog,
        ExpectedIndex {
            table_name,
            index_name: &value_index,
            columns: &[
                ("record_id".to_string(), false),
                ("effective_start".to_string(), false),
                ("change_set_id".to_string(), false),
            ],
            create_sql: "",
            column_probe_sql: VERSION_INDEX_COLUMNS,
            predicate_sql: Some("not tombstones_record and not untombstones_record"),
            unique: true,
        },
    )?;
    let lifecycle_index =
        bounded_physical_identifier(&format!("{table_name}_mainline_lifecycle_once_idx"));
    validate_index(
        client,
        postgres_catalog,
        ExpectedIndex {
            table_name,
            index_name: &lifecycle_index,
            columns: &[
                ("record_id".to_string(), false),
                ("effective_start".to_string(), false),
                ("tombstones_record".to_string(), false),
                ("untombstones_record".to_string(), false),
            ],
            create_sql: "",
            column_probe_sql: VERSION_INDEX_COLUMNS,
            predicate_sql: Some(
                "stage = 'mainline' and (tombstones_record or untombstones_record)",
            ),
            unique: true,
        },
    )?;
    Ok(())
}

fn validate_unique_field_indexes(
    client: &mut impl GenericClient,
    model: &Model,
    physical_model: &PhysicalModel,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
    version_columns: &str,
    postgres_catalog: &PostgresCatalogSnapshot,
) -> Result<(), DbError> {
    for field in model.fields.iter().filter(|field| field.is_unique) {
        let columns = field_columns(field, physical_models)?;
        let column = unique_field_column(field, &columns)?;
        let index_name = unique_field_index_name(physical_model, column);
        let predicate = format!(
            "stage = 'mainline' and effective_end is null and {} is not null",
            quote_identifier(&column.name)
        );
        let index_columns = vec![
            ("app_id".to_string(), false),
            ("customer_id".to_string(), false),
            (column.name.clone(), false),
        ];
        validate_index(
            client,
            postgres_catalog,
            ExpectedIndex {
                table_name: &physical_model.version_table,
                index_name: &index_name,
                create_sql: "",
                columns: &index_columns,
                column_probe_sql: version_columns,
                predicate_sql: Some(&predicate),
                unique: true,
            },
        )?;
    }
    Ok(())
}

fn unique_field_index_name(physical_model: &PhysicalModel, column: &FieldColumn) -> String {
    unique_field_index_name_for_column(&physical_model.version_table, &column.name)
}

fn ensure_check_constraint(
    client: &mut impl GenericClient,
    postgres_catalog: &PostgresCatalogSnapshot,
    table_name: &str,
    constraint_name: &str,
    columns_sql: &str,
    check_sql: &str,
) -> Result<(), DbError> {
    let actual = postgres_catalog
        .constraint(table_name, constraint_name)
        .and_then(|constraint| constraint.check_expr.as_deref());
    if actual.is_none() {
        client.batch_execute(&format!(
            "alter table {} add constraint {} check ({check_sql});",
            quote_identifier(table_name),
            quote_identifier(constraint_name)
        ))?;
    }

    let expected = postgres_catalog
        .canonical
        .get(CanonicalProbeRequest::Check {
            columns_sql: columns_sql.to_string(),
            check_sql: check_sql.to_string(),
        });
    if actual.is_some_and(|actual| actual != expected) {
        return Err(DbError::SchemaDrift {
            object: format!("{table_name}.{constraint_name}"),
            details: format!("expected `{expected}`, found `{}`", actual.unwrap()),
        });
    }
    Ok(())
}

fn validate_check_constraint(
    _client: &mut impl GenericClient,
    postgres_catalog: &PostgresCatalogSnapshot,
    table_name: &str,
    constraint_name: &str,
    columns_sql: &str,
    check_sql: &str,
) -> Result<(), DbError> {
    let actual = postgres_catalog
        .constraint(table_name, constraint_name)
        .and_then(|constraint| constraint.check_expr.clone())
        .ok_or_else(|| DbError::SchemaDrift {
            object: format!("{table_name}.{constraint_name}"),
            details: "missing check constraint".to_string(),
        })?;
    let expected = postgres_catalog
        .canonical
        .get(CanonicalProbeRequest::Check {
            columns_sql: columns_sql.to_string(),
            check_sql: check_sql.to_string(),
        });
    if actual != expected {
        return Err(DbError::SchemaDrift {
            object: format!("{table_name}.{constraint_name}"),
            details: format!("expected `{expected}`, found `{actual}`"),
        });
    }
    Ok(())
}

fn constraint_expr(
    client: &mut impl GenericClient,
    table_name: &str,
    constraint_name: &str,
) -> Result<Option<String>, DbError> {
    Ok(client
        .query_opt(
            r#"
            select pg_get_expr(c.conbin, c.conrelid) as expr
            from pg_constraint c
            join pg_class r on r.oid = c.conrelid
            join pg_namespace n on n.oid = r.relnamespace
            where n.nspname = current_schema()
              and r.relname = $1
              and c.conname = $2
              and c.contype = 'c'
            "#,
            &[&table_name, &constraint_name],
        )?
        .map(|row| row.get("expr")))
}

struct ExpectedIndex<'a> {
    table_name: &'a str,
    index_name: &'a str,
    create_sql: &'a str,
    columns: &'a [(String, bool)],
    column_probe_sql: &'a str,
    predicate_sql: Option<&'a str>,
    unique: bool,
}

fn ensure_index(
    client: &mut impl GenericClient,
    postgres_catalog: &PostgresCatalogSnapshot,
    expected: ExpectedIndex<'_>,
) -> Result<(), DbError> {
    let Some(actual) = postgres_catalog.index(expected.index_name) else {
        client.batch_execute(expected.create_sql)?;
        return Ok(());
    };
    if actual.table_name != expected.table_name
        || actual.unique != expected.unique
        || actual.columns != expected.columns
        || actual.predicate.as_deref()
            != expected.predicate_sql.map(|predicate_sql| {
                postgres_catalog
                    .canonical
                    .get(CanonicalProbeRequest::IndexPredicate {
                        columns_sql: expected.column_probe_sql.to_string(),
                        predicate_sql: predicate_sql.to_string(),
                    })
            })
    {
        return Err(DbError::SchemaDrift {
            object: format!("{}.{}", expected.table_name, expected.index_name),
            details: format!("index contract mismatch: {actual:?}"),
        });
    }
    Ok(())
}

fn validate_index(
    _client: &mut impl GenericClient,
    postgres_catalog: &PostgresCatalogSnapshot,
    expected: ExpectedIndex<'_>,
) -> Result<(), DbError> {
    let actual =
        postgres_catalog
            .index(expected.index_name)
            .ok_or_else(|| DbError::SchemaDrift {
                object: expected.index_name.to_string(),
                details: "missing index".to_string(),
            })?;
    if actual.table_name != expected.table_name
        || actual.unique != expected.unique
        || actual.columns != expected.columns
        || actual.predicate.as_deref()
            != expected.predicate_sql.map(|predicate_sql| {
                postgres_catalog
                    .canonical
                    .get(CanonicalProbeRequest::IndexPredicate {
                        columns_sql: expected.column_probe_sql.to_string(),
                        predicate_sql: predicate_sql.to_string(),
                    })
            })
    {
        return Err(DbError::SchemaDrift {
            object: format!("{}.{}", expected.table_name, expected.index_name),
            details: format!("index contract mismatch: {actual:?}"),
        });
    }
    Ok(())
}

#[derive(Debug)]
struct IndexContract {
    table_name: String,
    unique: bool,
    columns: Vec<(String, bool)>,
    predicate: Option<String>,
}

fn ensure_key_constraint(
    client: &mut impl GenericClient,
    postgres_catalog: &PostgresCatalogSnapshot,
    table_name: &str,
    constraint_name: &str,
    constraint_type: &str,
    columns: &[&str],
) -> Result<(), DbError> {
    if !postgres_catalog.tables.contains(table_name) {
        return Ok(());
    }
    let Some(snapshot) = postgres_catalog.constraint(table_name, constraint_name) else {
        let column_sql = columns
            .iter()
            .map(|column| quote_identifier(column))
            .collect::<Vec<_>>()
            .join(", ");
        let constraint_sql = match constraint_type {
            "p" => format!("primary key ({column_sql})"),
            "u" => format!("unique ({column_sql})"),
            _ => {
                return Err(DbError::SchemaDrift {
                    object: format!("{table_name}.{constraint_name}"),
                    details: format!("unsupported key constraint type {constraint_type}"),
                })
            }
        };
        client.batch_execute(&format!(
            "alter table {} add constraint {} {constraint_sql};",
            quote_identifier(table_name),
            quote_identifier(constraint_name)
        ))?;
        return Ok(());
    };
    let actual = KeyContract {
        constraint_type: snapshot.constraint_type.clone(),
        columns: snapshot.columns.clone(),
        deferrable: snapshot.deferrable,
        initially_deferred: snapshot.initially_deferred,
        validated: snapshot.validated,
    };
    let expected_columns = columns
        .iter()
        .map(|column| column.to_string())
        .collect::<Vec<_>>();
    if actual.constraint_type != constraint_type
        || actual.columns != expected_columns
        || actual.deferrable
        || actual.initially_deferred
        || !actual.validated
    {
        return Err(DbError::SchemaDrift {
            object: format!("{table_name}.{constraint_name}"),
            details: format!("key constraint mismatch: {actual:?}"),
        });
    }
    Ok(())
}

fn validate_key_constraint(
    postgres_catalog: &PostgresCatalogSnapshot,
    table_name: &str,
    constraint_name: &str,
    constraint_type: &str,
    columns: &[&str],
) -> Result<(), DbError> {
    let Some(snapshot) = postgres_catalog.constraint(table_name, constraint_name) else {
        return Err(DbError::SchemaDrift {
            object: format!("{table_name}.{constraint_name}"),
            details: "missing key constraint".to_string(),
        });
    };
    let actual = KeyContract {
        constraint_type: snapshot.constraint_type.clone(),
        columns: snapshot.columns.clone(),
        deferrable: snapshot.deferrable,
        initially_deferred: snapshot.initially_deferred,
        validated: snapshot.validated,
    };
    let expected_columns = columns
        .iter()
        .map(|column| column.to_string())
        .collect::<Vec<_>>();
    if actual.constraint_type != constraint_type
        || actual.columns != expected_columns
        || actual.deferrable
        || actual.initially_deferred
        || !actual.validated
    {
        return Err(DbError::SchemaDrift {
            object: format!("{table_name}.{constraint_name}"),
            details: format!("key constraint mismatch: {actual:?}"),
        });
    }
    Ok(())
}

#[derive(Debug)]
struct KeyContract {
    constraint_type: String,
    columns: Vec<String>,
    deferrable: bool,
    initially_deferred: bool,
    validated: bool,
}

fn ensure_fk_constraint(
    client: &mut impl GenericClient,
    postgres_catalog: &PostgresCatalogSnapshot,
    table_name: &str,
    constraint_name: &str,
    columns: &[&str],
    referenced_table: &str,
    referenced_columns: &[&str],
) -> Result<(), DbError> {
    let Some(snapshot) = postgres_catalog.constraint(table_name, constraint_name) else {
        let column_sql = columns
            .iter()
            .map(|column| quote_identifier(column))
            .collect::<Vec<_>>()
            .join(", ");
        let referenced_column_sql = referenced_columns
            .iter()
            .map(|column| quote_identifier(column))
            .collect::<Vec<_>>()
            .join(", ");
        client.batch_execute(&format!(
            "alter table {} add constraint {} foreign key ({column_sql}) references {} ({referenced_column_sql});",
            quote_identifier(table_name),
            quote_identifier(constraint_name),
            quote_identifier(referenced_table)
        ))?;
        return Ok(());
    };
    let actual = FkContract {
        columns: snapshot.columns.clone(),
        referenced_schema: snapshot.referenced_schema.clone().unwrap_or_default(),
        referenced_table: snapshot.referenced_table.clone().unwrap_or_default(),
        referenced_columns: snapshot.referenced_columns.clone(),
        update_action: snapshot.update_action.clone(),
        delete_action: snapshot.delete_action.clone(),
        match_type: snapshot.match_type.clone(),
        deferrable: snapshot.deferrable,
        initially_deferred: snapshot.initially_deferred,
        validated: snapshot.validated,
    };
    let expected_columns = columns
        .iter()
        .map(|column| column.to_string())
        .collect::<Vec<_>>();
    let expected_referenced_columns = referenced_columns
        .iter()
        .map(|column| column.to_string())
        .collect::<Vec<_>>();
    if actual.referenced_schema != postgres_catalog.schema_name
        || actual.referenced_table != referenced_table
        || actual.columns != expected_columns
        || actual.referenced_columns != expected_referenced_columns
        || actual.update_action != "a"
        || actual.delete_action != "a"
        || actual.match_type != "s"
        || actual.deferrable
        || actual.initially_deferred
        || !actual.validated
    {
        return Err(DbError::SchemaDrift {
            object: format!("{table_name}.{constraint_name}"),
            details: format!("foreign key contract mismatch: {actual:?}"),
        });
    }
    Ok(())
}

fn validate_fk_constraint(
    postgres_catalog: &PostgresCatalogSnapshot,
    table_name: &str,
    constraint_name: &str,
    columns: &[&str],
    referenced_table: &str,
    referenced_columns: &[&str],
) -> Result<(), DbError> {
    let Some(snapshot) = postgres_catalog.constraint(table_name, constraint_name) else {
        return Err(DbError::SchemaDrift {
            object: format!("{table_name}.{constraint_name}"),
            details: "missing foreign key".to_string(),
        });
    };
    let actual = FkContract {
        columns: snapshot.columns.clone(),
        referenced_schema: snapshot.referenced_schema.clone().unwrap_or_default(),
        referenced_table: snapshot.referenced_table.clone().unwrap_or_default(),
        referenced_columns: snapshot.referenced_columns.clone(),
        update_action: snapshot.update_action.clone(),
        delete_action: snapshot.delete_action.clone(),
        match_type: snapshot.match_type.clone(),
        deferrable: snapshot.deferrable,
        initially_deferred: snapshot.initially_deferred,
        validated: snapshot.validated,
    };
    let expected_columns = columns
        .iter()
        .map(|column| column.to_string())
        .collect::<Vec<_>>();
    let expected_referenced_columns = referenced_columns
        .iter()
        .map(|column| column.to_string())
        .collect::<Vec<_>>();
    if actual.referenced_schema != postgres_catalog.schema_name
        || actual.referenced_table != referenced_table
        || actual.columns != expected_columns
        || actual.referenced_columns != expected_referenced_columns
        || actual.update_action != "a"
        || actual.delete_action != "a"
        || actual.match_type != "s"
        || actual.deferrable
        || actual.initially_deferred
        || !actual.validated
    {
        return Err(DbError::SchemaDrift {
            object: format!("{table_name}.{constraint_name}"),
            details: format!("foreign key contract mismatch: {actual:?}"),
        });
    }
    Ok(())
}

#[derive(Debug)]
struct FkContract {
    columns: Vec<String>,
    referenced_schema: String,
    referenced_table: String,
    referenced_columns: Vec<String>,
    update_action: String,
    delete_action: String,
    match_type: String,
    deferrable: bool,
    initially_deferred: bool,
    validated: bool,
}

fn ensure_rls(client: &mut impl GenericClient, table_name: &str) -> Result<(), DbError> {
    let table = quote_identifier(table_name);
    let scope = tenant_policy_scope(table_name);
    client.batch_execute(&format!(
        "alter table {table} enable row level security;
         alter table {table} force row level security;
         drop policy if exists {TENANT_POLICY} on {table};
         create policy {TENANT_POLICY} on {table} for all using ({scope}) with check ({scope});"
    ))?;
    Ok(())
}

fn ensure_rls_against(
    client: &mut impl GenericClient,
    table_name: &str,
    postgres_catalog: &PostgresCatalogSnapshot,
) -> Result<(), DbError> {
    let table = quote_identifier(table_name);
    let scope = tenant_policy_scope(table_name);
    let expected_scope = postgres_catalog
        .canonical
        .get(CanonicalProbeRequest::Policy {
            scope_sql: tenant_policy_scope(table_name),
        });
    let contract = postgres_catalog.rls(table_name);
    if contract.is_none_or(|contract| !contract.row_security || !contract.force_row_security) {
        client.batch_execute(&format!(
            "alter table {table} enable row level security; alter table {table} force row level security;"
        ))?;
    }
    let policy =
        contract.and_then(|contract| (contract.policies.len() == 1).then(|| &contract.policies[0]));
    if contract.is_none_or(|contract| contract.policies.is_empty()) {
        client.batch_execute(&format!(
            "create policy {TENANT_POLICY} on {table} for all using ({scope}) with check ({scope});"
        ))?;
    } else if policy.is_none_or(|policy| {
        policy.name != TENANT_POLICY
            || policy.command != "ALL"
            || policy.roles != vec!["public".to_string()]
            || policy.permissive != "PERMISSIVE"
            || policy.qual != expected_scope
            || policy.with_check != expected_scope
    }) {
        for existing_policy in &contract.expect("policy contract exists").policies {
            let policy_name = quote_identifier(&existing_policy.name);
            client.batch_execute(&format!("drop policy if exists {policy_name} on {table};"))?;
        }
        client.batch_execute(&format!(
            "create policy {TENANT_POLICY} on {table} for all using ({scope}) with check ({scope});"
        ))?;
    }
    Ok(())
}

fn validate_rls_against(
    table_name: &str,
    contract: Option<&RlsTableContract>,
    postgres_catalog: &PostgresCatalogSnapshot,
) -> Result<(), DbError> {
    let policy = contract
        .and_then(|contract| (contract.policies.len() == 1).then(|| contract.policies[0].clone()));
    let expected_scope = postgres_catalog
        .canonical
        .get(CanonicalProbeRequest::Policy {
            scope_sql: tenant_policy_scope(table_name),
        });
    if policy.as_ref().is_none_or(|policy| {
        policy.name != TENANT_POLICY
            || policy.command != "ALL"
            || policy.roles != vec!["public".to_string()]
            || policy.permissive != "PERMISSIVE"
            || policy.qual != expected_scope
            || policy.with_check != expected_scope
    }) {
        return Err(DbError::SchemaDrift {
            object: format!("{table_name}.{TENANT_POLICY}"),
            details: format!("tenant policy mismatch: {policy:?}"),
        });
    }

    let row_security = contract.is_some_and(|contract| contract.row_security);
    let force_row_security = contract.is_some_and(|contract| contract.force_row_security);
    if !row_security || !force_row_security {
        return Err(DbError::SchemaDrift {
            object: table_name.to_string(),
            details: "row-level security is not enabled and forced".to_string(),
        });
    }
    Ok(())
}

#[derive(Debug, Clone)]
struct RlsPolicyContract {
    name: String,
    command: String,
    roles: Vec<String>,
    permissive: String,
    qual: String,
    with_check: String,
}

#[derive(Debug)]
struct RlsTableContract {
    row_security: bool,
    force_row_security: bool,
    policies: Vec<RlsPolicyContract>,
}

fn tenant_policy_scope(table_name: &str) -> String {
    let tenant_scope = "app_id = current_setting('platform.app_id', true) and customer_id = current_setting('platform.customer_id', true)";
    if table_name == "schema_revision" {
        format!("{tenant_scope} or current_setting('{SCHEMA_CATALOG_READ_SETTING}', true) = 'on'")
    } else {
        tenant_scope.to_string()
    }
}

fn canonical_probe_requests(
    schema: &Schema,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
) -> Result<BTreeSet<CanonicalProbeRequest>, DbError> {
    let mut requests = BTreeSet::new();

    for (columns, expression) in [
        (CHANGE_SET_COLUMNS, "created_with_mode in ('mainline', 'draft')"),
        (CHANGE_SET_COLUMNS, "status in ('draft', 'mainline', 'discarded')"),
        (
            CHANGE_SET_COLUMNS,
            "(status = 'mainline') = (applied_at is not null)",
        ),
        (
            CHANGE_SET_COLUMNS,
            "(status = 'mainline') = (applied_order is not null)",
        ),
        (
            CHANGE_SET_COLUMNS,
            "status in ('draft', 'mainline', 'discarded', 'reverted')",
        ),
        (
            "status text",
            "status in ('recorded', 'completed', 'validation_exhausted', 'runtime_error')",
        ),
        (
            "status text",
            "status in ('recorded', 'completed', 'validation_exhausted', 'runtime_error', 'cancelled')",
        ),
        (
            "status text",
            "status in ('recorded', 'completed', 'validation_exhausted', 'budget_exhausted', 'runtime_error', 'cancelled')",
        ),
    ] {
        collect_check_probe(&mut requests, columns, expression.to_string());
    }

    for scope in [
        tenant_policy_scope("schema_revision"),
        tenant_policy_scope("change_set"),
        tenant_policy_scope(SCHEMA_ACTIVATION_HEAD_TABLE),
    ] {
        requests.insert(CanonicalProbeRequest::Policy { scope_sql: scope });
    }
    for (columns_sql, predicate_sql) in [
        (SCHEMA_REVISION_COLUMNS, "activated_at is not null"),
        (CHANGE_SET_COLUMNS, "idempotency_key is not null"),
        (RECORD_COLUMNS, "external_key is not null"),
        (VERSION_INDEX_COLUMNS, "stage = 'mainline'"),
        (
            VERSION_INDEX_COLUMNS,
            "not tombstones_record and not untombstones_record",
        ),
        (
            VERSION_INDEX_COLUMNS,
            "stage = 'mainline' and (tombstones_record or untombstones_record)",
        ),
    ] {
        requests.insert(CanonicalProbeRequest::IndexPredicate {
            columns_sql: columns_sql.to_string(),
            predicate_sql: predicate_sql.to_string(),
        });
    }

    for specs in [
        schema_revision_columns(),
        schema_activation_head_columns(),
        change_set_columns(),
        agent_run_columns(),
        record_table_columns(),
        version_table_columns(),
    ] {
        collect_default_probes(&mut requests, &specs);
    }

    for model in &schema.models {
        let physical_model = physical_models.get(&model.id).expect("model was collected");
        let version_columns = version_columns_sql(model, physical_models)?;
        for expression in [
            "stage in ('draft', 'mainline', 'discarded', 'reverted')".to_string(),
            "effective_end is null or effective_end >= effective_start".to_string(),
            "(stage = 'mainline') = (applied_at is not null)".to_string(),
            "not (tombstones_record and untombstones_record)".to_string(),
        ] {
            collect_check_probe(&mut requests, &version_columns, expression);
        }
        for field in &model.fields {
            let columns = field_columns(field, physical_models)?;
            for column in &columns {
                collect_check_probe(
                    &mut requests,
                    &version_columns,
                    format!(
                        "(not tombstones_record and not untombstones_record) or {} is null",
                        quote_identifier(&column.name)
                    ),
                );
                if field.required {
                    collect_check_probe(
                        &mut requests,
                        &version_columns,
                        format!(
                            "tombstones_record or untombstones_record or {} is not null",
                            quote_identifier(&column.name)
                        ),
                    );
                }
            }
            if matches!(field.field_type, FieldType::MoneyRate) {
                let amount = columns
                    .iter()
                    .find(|column| column.name.ends_with("_amount"))
                    .expect("money rate amount");
                let currency = columns
                    .iter()
                    .find(|column| column.name.ends_with("_currency"))
                    .expect("money rate currency");
                let period = columns
                    .iter()
                    .find(|column| column.name.ends_with("_period"))
                    .expect("money rate period");
                collect_check_probe(
                    &mut requests,
                    &version_columns,
                    format!(
                        "(({} is null and {} is null and {} is null) or ({} is not null and {} is not null and {} is not null))",
                        quote_identifier(&amount.name), quote_identifier(&currency.name), quote_identifier(&period.name),
                        quote_identifier(&amount.name), quote_identifier(&currency.name), quote_identifier(&period.name)
                    ),
                );
                collect_check_probe(
                    &mut requests,
                    &version_columns,
                    format!(
                        "{} is null or {} in ({})",
                        quote_identifier(&period.name),
                        quote_identifier(&period.name),
                        MoneyRatePeriod::sql_literals()
                    ),
                );
            }
            if field.is_unique {
                let column = unique_field_column(field, &columns)?;
                requests.insert(CanonicalProbeRequest::IndexPredicate {
                    columns_sql: version_columns.clone(),
                    predicate_sql: format!(
                        "stage = 'mainline' and effective_end is null and {} is not null",
                        quote_identifier(&column.name)
                    ),
                });
            }
        }
        let mut version_specs = version_table_columns();
        for field in &model.fields {
            for column in field_columns(field, physical_models)? {
                version_specs.push(ColumnSpec::new(&column.name, &column.sql_type, false));
            }
        }
        collect_default_probes(&mut requests, &version_specs);
        let _ = physical_model;
    }
    Ok(requests)
}

fn collect_check_probe(
    requests: &mut BTreeSet<CanonicalProbeRequest>,
    columns_sql: &str,
    check_sql: String,
) {
    requests.insert(CanonicalProbeRequest::Check {
        columns_sql: columns_sql.to_string(),
        check_sql,
    });
}

fn collect_default_probes(requests: &mut BTreeSet<CanonicalProbeRequest>, columns: &[ColumnSpec]) {
    for column in columns {
        if let DefaultSpec::Exact(default_sql) = &column.default {
            requests.insert(CanonicalProbeRequest::Default {
                data_type: column.data_type.clone(),
                default_sql: default_sql.clone(),
            });
        }
    }
}

fn version_columns_sql(
    model: &Model,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
) -> Result<String, DbError> {
    let mut version_columns = VERSION_COLUMNS.to_string();
    for field in &model.fields {
        for column in field_columns(field, physical_models)? {
            version_columns.push_str(", ");
            version_columns.push_str(&column.definition);
        }
    }
    Ok(version_columns)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ColumnSpec {
    name: String,
    data_type: String,
    not_null: bool,
    default: DefaultSpec,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum DefaultSpec {
    None,
    OwnedSequence,
    Exact(String),
}

#[derive(Debug, Clone)]
struct ActualColumn {
    name: String,
    data_type: String,
    not_null: bool,
    default: Option<String>,
    owned_sequence: Option<String>,
}

fn validate_columns_against(
    postgres_catalog: &PostgresCatalogSnapshot,
    table_name: &str,
    expected: &[ColumnSpec],
    actual: &[ActualColumn],
) -> Result<(), DbError> {
    if actual.len() != expected.len() {
        return Err(DbError::SchemaDrift {
            object: table_name.to_string(),
            details: format!("column contract mismatch: expected {expected:?}, found {actual:?}"),
        });
    }
    let actual_by_name = actual
        .iter()
        .map(|column| (column.name.as_str(), column))
        .collect::<BTreeMap<_, _>>();
    for expected in expected {
        let Some(actual) = actual_by_name.get(expected.name.as_str()) else {
            return Err(DbError::SchemaDrift {
                object: table_name.to_string(),
                details: format!(
                    "column contract mismatch: expected column {:?} not found; actual columns: {actual:?}",
                    expected.name
                ),
            });
        };
        let default_matches = match &expected.default {
            DefaultSpec::None => actual.default.is_none(),
            DefaultSpec::OwnedSequence => match actual.default.as_ref() {
                Some(actual_default) => {
                    actual.owned_sequence.as_ref().is_some_and(|sequence_name| {
                        actual_default
                            == &format!(
                                "nextval('{}'::regclass)",
                                sequence_name.replace('\'', "''")
                            )
                    })
                }
                None => false,
            },
            DefaultSpec::Exact(default_sql) => match actual.default.as_ref() {
                Some(actual_default) => {
                    let expected_default =
                        postgres_catalog
                            .canonical
                            .get(CanonicalProbeRequest::Default {
                                data_type: expected.data_type.clone(),
                                default_sql: default_sql.clone(),
                            });
                    actual_default.as_str() == expected_default
                }
                None => false,
            },
        };
        if normalized_column_data_type(&actual.data_type)
            != normalized_column_data_type(&expected.data_type)
            || actual.not_null != expected.not_null
            || !default_matches
        {
            return Err(DbError::SchemaDrift {
                object: table_name.to_string(),
                details: format!(
                    "column contract mismatch: expected {expected:?}, found {actual:?}"
                ),
            });
        }
    }
    Ok(())
}

fn normalized_column_data_type(data_type: &str) -> &str {
    match data_type {
        "timestamp with time zone" => "timestamptz",
        other => other,
    }
}

fn drop_unexpected_columns(
    client: &mut impl GenericClient,
    table_name: &str,
    expected: &[ColumnSpec],
    postgres_catalog: &PostgresCatalogSnapshot,
) -> Result<(), DbError> {
    let expected_names = expected
        .iter()
        .map(|column| column.name.as_str())
        .collect::<BTreeSet<_>>();
    for column in postgres_catalog.columns(table_name) {
        if !expected_names.contains(column.name.as_str()) {
            client.batch_execute(&format!(
                "alter table {} drop column if exists {} cascade;",
                quote_identifier(table_name),
                quote_identifier(&column.name)
            ))?;
        }
    }
    Ok(())
}

fn retained_version_table_columns(
    table_name: &str,
    mut expected: Vec<ColumnSpec>,
    catalog: &MaterializationCatalog,
) -> Vec<ColumnSpec> {
    let mut expected_names = expected
        .iter()
        .map(|column| column.name.clone())
        .collect::<BTreeSet<_>>();
    if let Some(sibling_columns) = catalog.sibling_version_columns_by_table.get(table_name) {
        for column in sibling_columns {
            if expected_names.insert(column.name.clone()) {
                expected.push(column.clone());
            }
        }
    }
    expected
}

fn reject_unsupported_sibling_field_contracts(
    table_name: &str,
    current_required_columns: &BTreeSet<String>,
    current_unique_columns: &BTreeSet<String>,
    catalog: &MaterializationCatalog,
) -> Result<(), DbError> {
    let unsupported_required = catalog
        .sibling_required_columns_by_table
        .get(table_name)
        .into_iter()
        .flatten()
        .filter(|column| !current_required_columns.contains(column.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if !unsupported_required.is_empty() {
        return Err(DbError::SchemaDrift {
            object: table_name.to_string(),
            details: format!(
                "active sibling schema has required columns not required by this schema: {unsupported_required:?}"
            ),
        });
    }

    let unsupported_unique = catalog
        .sibling_unique_columns_by_table
        .get(table_name)
        .into_iter()
        .flatten()
        .filter(|column| !current_unique_columns.contains(column.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if !unsupported_unique.is_empty() {
        return Err(DbError::SchemaDrift {
            object: table_name.to_string(),
            details: format!(
                "active sibling schema has unique columns not unique in this schema: {unsupported_unique:?}"
            ),
        });
    }
    if let Some(sibling_contracts) = catalog.sibling_contracts_by_table.get(table_name) {
        for sibling in sibling_contracts {
            let local_required_unsupported = current_required_columns
                .difference(&sibling.required_columns)
                .cloned()
                .collect::<Vec<_>>();
            if !local_required_unsupported.is_empty() {
                return Err(DbError::SchemaDrift {
                    object: table_name.to_string(),
                    details: format!(
                        "this schema has required columns not required by an active sibling schema: {local_required_unsupported:?}"
                    ),
                });
            }
            let local_unique_unsupported = current_unique_columns
                .difference(&sibling.unique_columns)
                .cloned()
                .collect::<Vec<_>>();
            if !local_unique_unsupported.is_empty() {
                return Err(DbError::SchemaDrift {
                    object: table_name.to_string(),
                    details: format!(
                        "this schema has unique columns not unique in an active sibling schema: {local_unique_unsupported:?}"
                    ),
                });
            }
        }
    }
    Ok(())
}

fn drop_unsupported_field_artifacts(
    client: &mut impl GenericClient,
    physical_model: &PhysicalModel,
    retained_columns: &[ColumnSpec],
    current_required_columns: &BTreeSet<String>,
    current_unique_columns: &BTreeSet<String>,
) -> Result<(), DbError> {
    let table_name = &physical_model.version_table;
    for column in retained_columns {
        if !current_required_columns.contains(column.name.as_str()) {
            client.batch_execute(&format!(
                "alter table {} drop constraint if exists {};",
                quote_identifier(table_name),
                quote_identifier(&constraint_name(
                    table_name,
                    &format!("{}_required_check", column.name)
                ))
            ))?;
        }
        if !current_unique_columns.contains(column.name.as_str()) {
            client.batch_execute(&format!(
                "drop index if exists {};",
                quote_identifier(&unique_field_index_name_for_column(
                    table_name,
                    &column.name
                ))
            ))?;
        }
    }
    Ok(())
}

fn validate_no_unsupported_field_artifacts(
    postgres_catalog: &PostgresCatalogSnapshot,
    physical_model: &PhysicalModel,
    retained_columns: &[ColumnSpec],
    current_required_columns: &BTreeSet<String>,
    current_unique_columns: &BTreeSet<String>,
) -> Result<(), DbError> {
    let table_name = &physical_model.version_table;
    for column in retained_columns {
        if !current_required_columns.contains(column.name.as_str()) {
            let constraint =
                constraint_name(table_name, &format!("{}_required_check", column.name));
            if postgres_catalog
                .constraint(table_name, &constraint)
                .is_some()
            {
                return Err(DbError::SchemaDrift {
                    object: format!("{table_name}.{constraint}"),
                    details: "unsupported retained-column required check".to_string(),
                });
            }
        }
        if !current_unique_columns.contains(column.name.as_str()) {
            let index = unique_field_index_name_for_column(table_name, &column.name);
            if postgres_catalog.index(&index).is_some() {
                return Err(DbError::SchemaDrift {
                    object: format!("{table_name}.{index}"),
                    details: "unsupported retained-column unique index".to_string(),
                });
            }
        }
    }
    Ok(())
}

fn unique_field_index_name_for_column(table_name: &str, column_name: &str) -> String {
    bounded_physical_identifier(&format!("{table_name}_{column_name}_live_unique_idx"))
}

#[derive(Debug, Clone)]
struct PhysicalModel {
    record_table: String,
    version_table: String,
}

fn physical_model(model: &Model) -> Result<PhysicalModel, DbError> {
    let model_identifier = normalize_identifier(model.id.as_str())
        .map_err(|issue| ValidationError::new(vec![issue]))?;
    Ok(PhysicalModel {
        record_table: bounded_physical_identifier(&format!("{model_identifier}_record")),
        version_table: bounded_physical_identifier(&format!("{model_identifier}_version")),
    })
}

#[derive(Debug)]
struct FieldColumn {
    name: String,
    sql_type: String,
    validation_type: String,
    definition: String,
}

impl FieldColumn {
    fn select_sql(&self, table_alias: &str) -> String {
        let prefix = if table_alias.is_empty() {
            String::new()
        } else {
            format!("{table_alias}.")
        };
        if self.validation_type == "numeric" {
            format!("{prefix}{}::text", quote_identifier(&self.name))
        } else {
            format!("{prefix}{}", quote_identifier(&self.name))
        }
    }

    fn placeholder_cast(&self) -> Option<&'static str> {
        if self.validation_type == "numeric" {
            Some("text::numeric")
        } else {
            None
        }
    }
}

fn field_columns(
    field: &Field,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
) -> Result<Vec<FieldColumn>, DbError> {
    let field_identifier = normalize_identifier(field.id.as_str())
        .map_err(|issue| ValidationError::new(vec![issue]))?;
    let columns = match field.field_type {
        FieldType::Text | FieldType::IsoCountry | FieldType::IsoCurrency => {
            vec![field_column(&field_identifier, "text")]
        }
        FieldType::Number => vec![field_column(&field_identifier, "numeric")],
        FieldType::Bool => vec![field_column(&field_identifier, "boolean")],
        FieldType::Date => vec![field_column(&field_identifier, "date")],
        FieldType::Datetime => vec![field_column_with_validation(
            &field_identifier,
            "timestamptz",
            "timestamp with time zone",
        )],
        FieldType::Relation => {
            let target_model = field
                .target_model
                .as_ref()
                .ok_or_else(|| DbError::SchemaDrift {
                    object: field.id.to_string(),
                    details: "relation field missing target model after validation".to_string(),
                })?;
            physical_models
                .get(target_model)
                .ok_or_else(|| DbError::SchemaDrift {
                    object: field.id.to_string(),
                    details: "relation target missing after validation".to_string(),
                })?;
            let name = bounded_physical_identifier(&field_identifier);
            vec![FieldColumn {
                name: name.clone(),
                sql_type: "uuid".to_string(),
                validation_type: "uuid".to_string(),
                definition: format!("{} uuid", quote_identifier(&name)),
            }]
        }
        FieldType::TextList | FieldType::KnownAliases => {
            vec![field_column(&field_identifier, "text[]")]
        }
        FieldType::Json => vec![field_column(&field_identifier, "jsonb")],
        FieldType::Enum => vec![field_column(&field_identifier, "text")],
        FieldType::MoneyRate => ["amount", "currency", "period"]
            .into_iter()
            .map(|suffix| {
                let name = bounded_physical_identifier(&format!("{field_identifier}_{suffix}"));
                let sql_type = match suffix {
                    "amount" => "numeric",
                    "currency" | "period" => "text",
                    _ => unreachable!(),
                };
                FieldColumn {
                    name: name.clone(),
                    sql_type: sql_type.to_string(),
                    validation_type: sql_type.to_string(),
                    definition: format!("{} {sql_type}", quote_identifier(&name)),
                }
            })
            .collect(),
    };
    Ok(columns)
}

fn field_column(field_identifier: &str, sql_type: &str) -> FieldColumn {
    field_column_with_validation(field_identifier, sql_type, sql_type)
}

fn field_column_with_validation(
    field_identifier: &str,
    sql_type: &str,
    validation_type: &str,
) -> FieldColumn {
    let name = bounded_physical_identifier(field_identifier);
    FieldColumn {
        name: name.clone(),
        sql_type: sql_type.to_string(),
        validation_type: validation_type.to_string(),
        definition: format!("{} {sql_type}", quote_identifier(&name)),
    }
}

fn schema_revision_columns() -> Vec<ColumnSpec> {
    vec![
        ColumnSpec::new("id", "bigint", true).with_owned_sequence_default(),
        ColumnSpec::new("app_id", "text", true),
        ColumnSpec::new("customer_id", "text", true),
        ColumnSpec::new("version", "text", true),
        ColumnSpec::new("base_schema", "jsonb", true),
        ColumnSpec::new("customer_overlay", "jsonb", true).with_default("'{}'"),
        ColumnSpec::new("schema", "jsonb", true),
        ColumnSpec::new("created_at", "timestamp with time zone", true).with_default("now()"),
        ColumnSpec::new("activated_at", "timestamp with time zone", false),
        ColumnSpec::new("schema_hash", "text", false),
        ColumnSpec::new("materialization_source", "text", false),
        ColumnSpec::new("materialization_git_sha", "text", false),
        ColumnSpec::new("materialization_vercel_deployment_id", "text", false),
        ColumnSpec::new("materialization_vercel_environment", "text", false),
        ColumnSpec::new("materialization_vercel_git_ref", "text", false),
        ColumnSpec::new("materialized_at", "timestamp with time zone", false),
        ColumnSpec::new("authorization_policy_declared", "boolean", false),
    ]
}

fn schema_activation_head_columns() -> Vec<ColumnSpec> {
    vec![
        ColumnSpec::new("app_id", "text", true),
        ColumnSpec::new("customer_id", "text", true),
        ColumnSpec::new("base_schema_version", "text", true),
        ColumnSpec::new("advanced_at", "timestamp with time zone", true).with_default("now()"),
    ]
}

fn change_set_columns() -> Vec<ColumnSpec> {
    vec![
        ColumnSpec::new("id", "bigint", true).with_owned_sequence_default(),
        ColumnSpec::new("app_id", "text", true),
        ColumnSpec::new("customer_id", "text", true),
        ColumnSpec::new("schema_revision_id", "bigint", true),
        ColumnSpec::new("created_with_mode", "text", true),
        ColumnSpec::new("status", "text", true),
        ColumnSpec::new("actor_id", "text", false),
        ColumnSpec::new("source_kind", "text", true),
        ColumnSpec::new("source_ref", "text", false),
        ColumnSpec::new("idempotency_key", "text", false),
        ColumnSpec::new("request_fingerprint", "text", false),
        ColumnSpec::new("change_type_id", "text", false),
        ColumnSpec::new("notes", "text", false),
        ColumnSpec::new("created_order", "bigint", true),
        ColumnSpec::new("applied_order", "bigint", false),
        ColumnSpec::new("created_at", "timestamp with time zone", true).with_default("now()"),
        ColumnSpec::new("applied_at", "timestamp with time zone", false),
    ]
}

fn agent_run_columns() -> Vec<ColumnSpec> {
    vec![
        ColumnSpec::new("id", "bigint", true).with_owned_sequence_default(),
        ColumnSpec::new("app_id", "text", true),
        ColumnSpec::new("customer_id", "text", true),
        ColumnSpec::new("run_id", "text", true),
        ColumnSpec::new("status", "text", true).with_default("'recorded'"),
        ColumnSpec::new("schema_revision_id", "bigint", true),
        ColumnSpec::new("actor_id", "text", false),
        ColumnSpec::new("agent_identity_id", "text", true),
        ColumnSpec::new("execution_profile_id", "text", true),
        ColumnSpec::new("source_artifacts", "jsonb", true).with_default("'[]'"),
        ColumnSpec::new("alignment_decisions", "jsonb", true).with_default("'[]'"),
        ColumnSpec::new("model_calls", "jsonb", true).with_default("'[]'"),
        ColumnSpec::new("tool_calls", "jsonb", true).with_default("'[]'"),
        ColumnSpec::new("token_usage", "jsonb", true).with_default("'{}'"),
        ColumnSpec::new("validation_failures", "jsonb", true).with_default("'[]'"),
        ColumnSpec::new("final_outputs", "jsonb", true).with_default("'{}'"),
        ColumnSpec::new("approval_boundaries", "jsonb", true).with_default("'[]'"),
        ColumnSpec::new("compiled_preview_ids", "jsonb", true).with_default("'[]'"),
        ColumnSpec::new("created_at", "timestamp with time zone", true).with_default("now()"),
    ]
}

fn record_table_columns() -> Vec<ColumnSpec> {
    vec![
        ColumnSpec::new("id", "uuid", true),
        ColumnSpec::new("app_id", "text", true),
        ColumnSpec::new("customer_id", "text", true),
        ColumnSpec::new("external_key", "text", false),
        ColumnSpec::new("created_at", "timestamp with time zone", true).with_default("now()"),
    ]
}

fn version_table_columns() -> Vec<ColumnSpec> {
    vec![
        ColumnSpec::new("id", "uuid", true),
        ColumnSpec::new("record_id", "uuid", true),
        ColumnSpec::new("app_id", "text", true),
        ColumnSpec::new("customer_id", "text", true),
        ColumnSpec::new("stage", "text", true),
        ColumnSpec::new("effective_start", "date", true),
        ColumnSpec::new("effective_end", "date", false),
        ColumnSpec::new("change_set_id", "bigint", true),
        ColumnSpec::new("created_at", "timestamp with time zone", true).with_default("now()"),
        ColumnSpec::new("applied_at", "timestamp with time zone", false),
        ColumnSpec::new("tombstones_record", "boolean", true).with_default("false"),
        // Internal storage keeps this column reserved for a future un-tombstone primitive.
        // The public apply DTO does not expose a write path for it in V0.
        ColumnSpec::new("untombstones_record", "boolean", true).with_default("false"),
        ColumnSpec::new("provenance", "jsonb", false),
        ColumnSpec::new("custom_fields", "jsonb", true).with_default("'[]'"),
    ]
}

impl ColumnSpec {
    fn new(name: &str, data_type: &str, not_null: bool) -> Self {
        Self {
            name: name.to_string(),
            data_type: data_type.to_string(),
            not_null,
            default: DefaultSpec::None,
        }
    }

    fn with_default(mut self, default_sql: &str) -> Self {
        self.default = DefaultSpec::Exact(default_sql.to_string());
        self
    }

    fn with_owned_sequence_default(mut self) -> Self {
        self.default = DefaultSpec::OwnedSequence;
        self
    }
}

fn constraint_name(table: &str, suffix: &str) -> String {
    bounded_physical_identifier(&format!("{table}_{suffix}"))
}

trait MoneyRatePeriodSql {
    fn sql_literals() -> &'static str;
}

impl MoneyRatePeriodSql for MoneyRatePeriod {
    fn sql_literals() -> &'static str {
        "'hourly', 'daily', 'weekly', 'monthly', 'annual'"
    }
}

const RECORD_COLUMNS: &str = "
    id uuid,
    app_id text,
    customer_id text,
    external_key text,
    created_at timestamptz
";

const SCHEMA_REVISION_COLUMNS: &str = "
    id bigint,
    app_id text,
    customer_id text,
    version text,
    base_schema jsonb,
    customer_overlay jsonb,
    schema jsonb,
    created_at timestamptz,
    activated_at timestamptz
";

const CHANGE_SET_COLUMNS: &str = "
    id bigint,
    app_id text,
    customer_id text,
    schema_revision_id bigint,
    created_with_mode text,
    status text,
    actor_id text,
    source_kind text,
    source_ref text,
    idempotency_key text,
    request_fingerprint text,
    change_type_id text,
    notes text,
    created_order bigint,
    applied_order bigint,
    created_at timestamptz,
    applied_at timestamptz
";

const AGENT_RUN_COLUMNS: &str = "
    id bigint,
    app_id text,
    customer_id text,
    run_id text,
    schema_revision_id bigint,
    actor_id text,
    agent_identity_id text,
    execution_profile_id text,
    source_artifacts jsonb,
    alignment_decisions jsonb,
    model_calls jsonb,
    tool_calls jsonb,
    token_usage jsonb,
    validation_failures jsonb,
    final_outputs jsonb,
    approval_boundaries jsonb,
    compiled_preview_ids jsonb,
    created_at timestamptz
";

const VERSION_COLUMNS: &str = "
    id uuid,
    record_id uuid,
    app_id text,
    customer_id text,
    stage text,
    effective_start date,
    effective_end date,
    change_set_id bigint,
    created_at timestamptz,
    applied_at timestamptz,
    tombstones_record boolean,
    untombstones_record boolean,
    provenance jsonb,
    custom_fields jsonb
";

const VERSION_INDEX_COLUMNS: &str = VERSION_COLUMNS;

#[cfg(test)]
mod tests {
    use super::{
        canonical_json, effective_field_history_version_limit, materialization_lock_names,
        query_was_cancelled, relation_target_visibility, version_precedence_sql,
        CanonicalProbeRequest, CanonicalProbeResults, CatalogSnapshotQueryFamily,
        FieldResolutionScope, PhysicalModel, PostgresCatalogSnapshot, VersionOrderDirection,
        CANONICAL_PROBE_ROUND_TRIPS, CATALOG_SNAPSHOT_QUERY_FAMILIES,
        MATERIALIZATION_ADVISORY_LOCK_QUERY_COUNT, MAX_FIELD_HISTORY_VERSION_LIMIT,
    };
    use crate::contracts::{
        AppId, ApplyChangeSet, ApplyMode, ChangeTypeId, CustomerId, RecordId, SchemaRevisionId,
    };
    use chrono::NaiveDate;
    use postgres::error::SqlState;
    use postgres::Client;
    use serde_json::json;
    use std::collections::BTreeMap;
    use std::env;
    use std::sync::Arc;
    use uuid::Uuid;

    #[test]
    fn native_policy_gate_preserves_pre_policy_installed_legacy_scope() {
        let Ok(database_url) = env::var("PLATFORM_TEST_DATABASE_URL") else {
            eprintln!("skipping PostgreSQL test: PLATFORM_TEST_DATABASE_URL is not set");
            return;
        };
        let mut client = crate::connect_postgres(&database_url).expect("connect test database");
        let schema = format!("native_policy_pre_auth_{}", Uuid::new_v4().simple());
        let mut tx = client
            .transaction()
            .expect("open isolated test transaction");
        tx.batch_execute(&format!(
            "create schema {schema}; set local search_path to {schema};
             create table schema_revision (id bigserial primary key, app_id text, customer_id text, base_schema jsonb, schema jsonb, activated_at timestamptz);
             create table schema_installation_revision (schema_revision_id bigint, app_id text, customer_id text);
             insert into schema_revision (app_id, customer_id, base_schema, schema, activated_at) values ('native_policy', 'tenant_a', '{{\"version\":\"v45\"}}', '{{\"version\":\"v45\"}}', now());
             insert into schema_installation_revision (schema_revision_id, app_id, customer_id) values (1, 'native_policy', 'tenant_a');"
        ))
        .expect("create pre-policy installed legacy fixture");
        super::assert_native_policy_supported(
            &mut tx,
            &AppId::from("native_policy"),
            &CustomerId::from("tenant_a"),
        )
        .expect(
            "pre-policy generated installations remain native legacy when no policy catalogs exist",
        );
        tx.rollback().expect("remove isolated test schema");
    }

    #[test]
    fn native_policy_gate_preserves_legacy_and_rejects_declared_scope() {
        let Ok(database_url) = env::var("PLATFORM_TEST_DATABASE_URL") else {
            eprintln!("skipping PostgreSQL test: PLATFORM_TEST_DATABASE_URL is not set");
            return;
        };
        let mut client = crate::connect_postgres(&database_url).expect("connect test database");
        let schema = format!("native_policy_{}", Uuid::new_v4().simple());
        let mut tx = client
            .transaction()
            .expect("open isolated test transaction");
        tx.batch_execute(&format!(
            "create schema {schema}; set local search_path to {schema}"
        ))
        .expect("isolate native policy catalog");
        let app = AppId::from("native_policy");
        let tenant = CustomerId::from("tenant_a");
        super::assert_native_policy_supported(&mut tx, &app, &tenant)
            .expect("historical schemas without catalogs remain supported");
        tx.batch_execute(r#"
          create table schema_revision (
            id bigserial primary key, app_id text, customer_id text, base_schema jsonb, schema jsonb, activated_at timestamptz
          );
          create table schema_authorization_policy_expectation (
            app_id text, schema_version text, policy_declared boolean, policy_hash text
          );
          create table schema_authorization_policy_source (
            app_id text, schema_version text, policy jsonb, policy_hash text
          );
          insert into schema_revision (app_id,customer_id,base_schema,schema,activated_at) values
            ('native_policy','tenant_a','{"version":"base-v1"}','{"version":"tenant-overlay"}',now()),
            ('native_policy','tenant_a','{"version":"inactive-v2"}','{"version":"inactive-v2"}',null),
            ('native_policy','tenant_b','{"version":"legacy-v1"}','{"version":"legacy-v1"}',now());
          insert into schema_authorization_policy_expectation values
            ('native_policy','base-v1',false,null),
            ('native_policy','inactive-v2',true,'hash'),
            ('native_policy','legacy-v1',false,null);
        "#).expect("create canonical policy catalog fixture");
        super::assert_native_policy_supported(&mut tx, &app, &tenant)
            .expect("inactive policy and explicit legacy declaration do not block legacy reads");
        tx.execute("update schema_authorization_policy_expectation set policy_declared=true where schema_version='base-v1'", &[])
            .expect("declare policy on active base revision");
        let error = super::assert_native_policy_supported(&mut tx, &app, &tenant).unwrap_err();
        assert!(matches!(
            error,
            super::DbError::AuthorizationPolicyUnsupported
        ));
        let envelope = crate::KernelError::from(error).into_envelope();
        assert_eq!(envelope.code, "unsupported_capability");
        assert!(envelope.details.is_empty());
        super::assert_native_policy_supported(&mut tx, &app, &CustomerId::from("tenant_b"))
            .expect("a different tenant's legacy revision remains supported");
        tx.execute(
            "delete from schema_authorization_policy_expectation where schema_version='base-v1'",
            &[],
        )
        .unwrap();
        tx.execute("insert into schema_authorization_policy_source values ('native_policy','base-v1','{}','hash')", &[]).unwrap();
        assert!(
            matches!(
                super::assert_native_policy_supported(&mut tx, &app, &tenant),
                Err(super::DbError::AuthorizationPolicyUnsupported)
            ),
            "a source policy cannot silently become legacy when its expectation row disappears"
        );
        tx.batch_execute("drop table schema_authorization_policy_source")
            .unwrap();
        assert!(matches!(
            super::assert_native_policy_supported(&mut tx, &app, &tenant),
            Err(super::DbError::SchemaDrift { .. })
        ));
        tx.batch_execute(r#"
          create table schema_authorization_policy_snapshot (
            schema_revision_id bigint, app_id text, customer_id text, policy jsonb
          );
          insert into schema_authorization_policy_snapshot values (1,'native_policy','tenant_a','{}');
          drop table schema_authorization_policy_expectation;
        "#).unwrap();
        assert!(
            matches!(
                super::assert_native_policy_supported(&mut tx, &app, &tenant),
                Err(super::DbError::AuthorizationPolicyUnsupported)
            ),
            "retained active snapshot prevents source-catalog deletion from downgrading policy"
        );
        tx.rollback().expect("remove isolated test schema");
    }

    #[test]
    fn query_timeout_mapping_only_recognizes_query_cancellation() {
        assert!(query_was_cancelled(Some(&SqlState::QUERY_CANCELED)));
        assert!(!query_was_cancelled(Some(&SqlState::SYNTAX_ERROR)));
        assert!(!query_was_cancelled(None));
    }

    #[test]
    fn field_history_limit_defaults_and_clamps() {
        assert_eq!(
            effective_field_history_version_limit(None),
            MAX_FIELD_HISTORY_VERSION_LIMIT
        );
        assert_eq!(effective_field_history_version_limit(Some(-5)), 1);
        assert_eq!(effective_field_history_version_limit(Some(25)), 25);
        assert_eq!(
            effective_field_history_version_limit(Some(MAX_FIELD_HISTORY_VERSION_LIMIT + 1)),
            MAX_FIELD_HISTORY_VERSION_LIMIT
        );
    }

    #[test]
    fn version_precedence_uses_causal_order_after_lifecycle() {
        let mainline = version_precedence_sql("v", "cs", VersionOrderDirection::Descending, false);
        assert_eq!(
            mainline,
            "v.effective_start desc,\n              v.tombstones_record desc,\n              v.untombstones_record desc,\n              case when v.stage in ('mainline', 'reverted') then cs.applied_order else cs.created_order end desc,\n              v.id desc"
        );
        assert!(!mainline.contains("created_at"));
        assert!(!mainline.contains("change_set_id"));

        let draft = version_precedence_sql("v", "cs", VersionOrderDirection::Descending, true);
        assert!(draft.find("tombstones_record").unwrap() < draft.find("stage = 'draft'").unwrap());
        assert!(draft.find("stage = 'draft'").unwrap() < draft.find("applied_order").unwrap());
    }

    #[test]
    fn catalog_snapshot_has_a_bounded_model_independent_query_plan() {
        assert_eq!(
            CATALOG_SNAPSHOT_QUERY_FAMILIES,
            [
                CatalogSnapshotQueryFamily::Tables,
                CatalogSnapshotQueryFamily::Sequences,
                CatalogSnapshotQueryFamily::ColumnsAndDefaults,
                CatalogSnapshotQueryFamily::RlsPolicies,
                CatalogSnapshotQueryFamily::Constraints,
                CatalogSnapshotQueryFamily::Indexes,
            ]
        );
        assert!(CATALOG_SNAPSHOT_QUERY_FAMILIES.len() <= 6);
    }

    #[test]
    fn materialization_locks_are_ordered_and_use_one_batch_query() {
        let schema = crate::contracts::Schema {
            app_id: AppId::from("app"),
            customer_id: CustomerId::from("customer"),
            version: crate::contracts::SchemaVersion::from("1"),
            models: Vec::new(),
            custom_fields: Vec::new(),
            change_types: Vec::new(),
        };
        let physical_models = BTreeMap::from([
            (
                crate::contracts::ModelId::from("z"),
                PhysicalModel {
                    record_table: "z_record".to_string(),
                    version_table: "z_version".to_string(),
                },
            ),
            (
                crate::contracts::ModelId::from("a"),
                PhysicalModel {
                    record_table: "a_record".to_string(),
                    version_table: "a_version".to_string(),
                },
            ),
        ]);

        let names = materialization_lock_names("scope", &schema, &physical_models);

        assert_eq!(MATERIALIZATION_ADVISORY_LOCK_QUERY_COUNT, 1);
        assert_eq!(names.len(), 1 + 2 * physical_models.len());
        assert!(names.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn postgres_catalog_and_probe_round_trips_stay_constant_under_load() {
        let Ok(database_url) = env::var("PLATFORM_TEST_DATABASE_URL") else {
            return;
        };
        let mut client = Client::connect(&database_url, postgres::NoTls).unwrap();
        let schema_name = format!("platform_round_trip_{}", Uuid::new_v4().simple());
        client
            .batch_execute(&format!(
                "create schema {schema_name}; set search_path to {schema_name}, pg_catalog;"
            ))
            .unwrap();

        let canonical = Arc::new(CanonicalProbeResults::default());
        let (_, one_table_round_trips) =
            PostgresCatalogSnapshot::load_with_round_trips(&mut client, Arc::clone(&canonical))
                .unwrap();
        for index in 0..64 {
            client
                .batch_execute(&format!("create table model_{index} (id bigint)"))
                .unwrap();
        }
        let (_, many_table_round_trips) =
            PostgresCatalogSnapshot::load_with_round_trips(&mut client, canonical).unwrap();

        let requests = (0..128)
            .map(|value| CanonicalProbeRequest::Default {
                data_type: "bigint".to_string(),
                default_sql: value.to_string(),
            })
            .collect::<Vec<_>>();
        let (results, probe_round_trips) =
            CanonicalProbeResults::load_with_round_trips(&mut client, requests).unwrap();
        let probe_remnants: i64 = client
            .query_one(
                r#"
                select count(*)
                from pg_class r
                join pg_namespace n on n.oid = r.relnamespace
                where n.oid = pg_my_temp_schema()
                  and r.relname like 'platform_expr_probe%'
                "#,
                &[],
            )
            .unwrap()
            .get(0);

        assert_eq!(
            one_table_round_trips.catalog_queries,
            CATALOG_SNAPSHOT_QUERY_FAMILIES
        );
        assert_eq!(
            many_table_round_trips.catalog_queries,
            CATALOG_SNAPSHOT_QUERY_FAMILIES
        );
        assert_eq!(
            probe_round_trips.canonical_probe_round_trips,
            CANONICAL_PROBE_ROUND_TRIPS
        );
        assert_eq!(results.values.len(), 128);
        assert_eq!(probe_remnants, 0);

        client
            .batch_execute(&format!(
                "set search_path to public, pg_catalog; drop schema {schema_name} cascade;"
            ))
            .unwrap();
    }

    #[test]
    fn canonical_json_sorts_object_keys_recursively() {
        let left = json!({
            "b": [{"d": true, "c": null}],
            "a": 1
        });
        let right = json!({
            "a": 1,
            "b": [{"c": null, "d": true}]
        });

        assert_eq!(
            canonical_json(&left).unwrap(),
            canonical_json(&right).unwrap()
        );
        assert_eq!(
            canonical_json(&left).unwrap(),
            r#"{"a":1,"b":[{"c":null,"d":true}]}"#
        );
    }

    #[test]
    fn canonical_json_matches_current_stored_fingerprint_shape() {
        let value = json!({
            "b": [{"d": true, "c": null}],
            "a": 1
        });

        assert_eq!(
            canonical_json(&value).unwrap(),
            serde_json::to_string(&value).unwrap()
        );
    }

    #[test]
    fn relation_target_visibility_lifecycle_tiebreaks_before_draft_stage() {
        let Ok(database_url) = env::var("PLATFORM_TEST_DATABASE_URL") else {
            return;
        };
        let mut client = Client::connect(&database_url, postgres::NoTls).unwrap();
        let table = format!("platform_relation_visibility_{}", Uuid::new_v4().simple());
        client
            .batch_execute(&format!(
                r#"
                create temp table {table} (
                  id uuid not null,
                  record_id uuid not null,
                  app_id text not null,
                  customer_id text not null,
                  stage text not null,
                  effective_start date not null,
                  change_set_id bigint not null,
                  created_at timestamptz not null,
                  tombstones_record boolean not null,
                  untombstones_record boolean not null
                );
                create temp table change_set (
                  id bigint not null,
                  app_id text not null,
                  customer_id text not null,
                  status text not null,
                  created_order bigint not null,
                  applied_order bigint
                );
                insert into change_set
                  (id, app_id, customer_id, status, created_order, applied_order)
                values
                  (1, 'core_app', 'customer_a', 'mainline', 1, 1),
                  (9, 'core_app', 'customer_a', 'mainline', 9, 9),
                  (7, 'core_app', 'customer_a', 'draft', 7, null);
                "#
            ))
            .unwrap();

        let record_id: RecordId = Uuid::new_v4();
        let effective_start = NaiveDate::from_ymd_opt(2026, 5, 1).unwrap();
        client
            .execute(
                &format!(
                    r#"
                    insert into {table}
                      (id, record_id, app_id, customer_id, stage, effective_start,
                       change_set_id, created_at, tombstones_record, untombstones_record)
                    values
                      ($1, $2, 'core_app', 'customer_a', 'mainline', $3, 1, now(), true, false),
                      ($4, $2, 'core_app', 'customer_a', 'mainline', $3, 9, now(), false, false),
                      ($5, $2, 'core_app', 'customer_a', 'draft', $3, 7, now(), false, false)
                    "#
                ),
                &[
                    &Uuid::new_v4(),
                    &record_id,
                    &effective_start,
                    &Uuid::new_v4(),
                    &Uuid::new_v4(),
                ],
            )
            .unwrap();

        let apply = ApplyChangeSet {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from("customer_a"),
            schema_revision_id: Some(SchemaRevisionId::new(1)),
            actor_id: None,
            source_kind: "test".to_string(),
            source_ref: None,
            idempotency_key: None,
            change_type_id: Some(ChangeTypeId::from("record_update")),
            notes: None,
            mode: ApplyMode::Draft,
            writes: Vec::new(),
        };
        let visibility = relation_target_visibility(
            &mut client,
            FieldResolutionScope {
                apply: &apply,
                draft_change_set_id: Some(7),
            },
            &crate::contracts::ModelId::from("record"),
            &PhysicalModel {
                record_table: "unused_record".to_string(),
                version_table: table,
            },
            record_id,
            effective_start,
        )
        .unwrap();

        assert_eq!(visibility, Some(true));
    }
}
