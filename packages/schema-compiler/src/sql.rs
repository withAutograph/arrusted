use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{self, Write};
use std::str::FromStr;

use chrono::{DateTime, NaiveDate};
use kernel::{
    is_iso_3166_1_alpha_2, is_iso_4217_tender_currency, normalize_identifier, validate_schema,
    CustomFieldDefinition, Field, FieldType, Model, ModelId, ModelKind, Schema,
    SchemaElementLifecycle,
};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{Comparison, CompiledManifest, ConstraintAuthority, ConstraintExpr, TypedLiteral};

const SQL_ARTIFACT_FORMAT_VERSION: u32 = 1;
const TENANT_POLICY: &str = "kernel_tenant_isolation";
const APP_CATALOG_POLICY: &str = "kernel_app_catalog_isolation";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SqlArtifactManifest {
    pub format_version: u32,
    pub app_id: String,
    pub customer_id: String,
    pub version: String,
    pub source_checksum: String,
    pub checksum: String,
    pub constraint_expression_coverage: SqlFeatureCoverage,
    pub runtime_api_capabilities: Vec<SqlRuntimeApiCapability>,
    pub retirements: Vec<RetiredSchemaElement>,
    pub artifacts: Vec<SqlArtifact>,
}

/// Immutable, compiler-produced evidence of the schema shapes from which a
/// release may advance. The installer compares the active base schema against
/// this exact set before it prepares a new revision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SchemaTransitionContract {
    pub format_version: u32,
    pub app_id: String,
    pub customer_id: String,
    pub version: String,
    pub predecessors: Vec<SchemaTransitionPredecessor>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SchemaTransitionPredecessor {
    pub version: String,
    pub schema: Schema,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SqlFeatureCoverage {
    pub implemented: bool,
    pub source_items: Vec<String>,
    pub implemented_items: Vec<String>,
    pub gaps: BTreeMap<String, String>,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SqlRuntimeApiCapability {
    pub operation: String,
    pub sql_signatures: Vec<String>,
    pub function_emitted: bool,
    pub behavioral_parity: bool,
    pub implemented: bool,
    pub gap: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RetiredSchemaElement {
    pub kind: RetirementKind,
    pub model: Option<String>,
    pub field: Option<String>,
    pub element: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetirementKind {
    Model,
    Field,
    EnumOption,
    CustomField,
    ChangeType,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SqlArtifact {
    pub kind: SqlArtifactKind,
    pub name: String,
    pub sql: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SqlArtifactKind {
    Sequence,
    Table,
    Column,
    CheckConstraint,
    ForeignKey,
    Index,
    ConstraintCatalog,
    AuthorizationPolicyCatalog,
    Policy,
    Function,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SqlCompileError {
    pub code: &'static str,
    pub path: String,
    pub message: String,
}

impl SqlCompileError {
    fn new(code: &'static str, path: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code,
            path: path.into(),
            message: message.into(),
        }
    }
}

impl fmt::Display for SqlCompileError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{} at {}: {}",
            self.code, self.path, self.message
        )
    }
}

impl Error for SqlCompileError {}

pub fn compile_sql_artifact_manifest(
    compiled: &CompiledManifest,
) -> Result<SqlArtifactManifest, SqlCompileError> {
    compile_sql_materialization_plan(None, compiled)
}

pub fn compile_schema_transition_contract(
    predecessors: &[CompiledManifest],
    compiled: &CompiledManifest,
) -> Result<SchemaTransitionContract, SqlCompileError> {
    validate_archived_names(predecessors, compiled)?;
    if let Some(previous) = predecessors.last() {
        validate_required_additions(&previous.schema, &compiled.schema)?;
    }
    let mut predecessor_schemas = BTreeMap::new();
    for predecessor in predecessors {
        validate_transition(&predecessor.schema, &compiled.schema)?;
        validate_field_names(predecessor, compiled)?;
        if predecessor.schema.app_id != compiled.schema.app_id
            || predecessor.schema.customer_id != compiled.schema.customer_id
        {
            return Err(SqlCompileError::new(
                "transition_scope_mismatch",
                "previous_compiled_artifact",
                "a transition predecessor must have the same app and customer scope",
            ));
        }
        let version = predecessor.schema.version.to_string();
        let serialized_schema =
            serde_json::to_string(&predecessor.schema).expect("compiled schemas can be serialized");
        predecessor_schemas.insert((version, serialized_schema), predecessor.schema.clone());
    }
    Ok(SchemaTransitionContract {
        format_version: 1,
        app_id: compiled.schema.app_id.to_string(),
        customer_id: compiled.schema.customer_id.to_string(),
        version: compiled.schema.version.to_string(),
        predecessors: predecessor_schemas
            .into_iter()
            .map(|((version, _), schema)| SchemaTransitionPredecessor { version, schema })
            .collect(),
    })
}

#[cfg(test)]
mod transition_contract_tests {
    use super::*;
    use serde_json::json;

    fn compiled(schema: serde_json::Value) -> CompiledManifest {
        serde_json::from_value(json!({
            "schema": schema,
            "extras": {
                "model_metadata": [],
                "field_metadata": [],
                "inverse_relations": [],
                "many_relations": [],
                "constraints": [],
                "derived_fields": [],
                "authorization_policy": null,
                "seed_change_sets": []
            }
        }))
        .expect("test schema is a compiled manifest")
    }

    #[test]
    fn preserves_distinct_predecessor_shapes_with_the_same_version() {
        let omitted_lookup_default = compiled(json!({
            "app_id": "vendor",
            "customer_id": "dev",
            "version": "2026-07-27.vendor-type-review",
            "models": []
        }));
        let explicit_lookup_default = compiled(json!({
            "app_id": "vendor",
            "customer_id": "dev",
            "version": "2026-07-27.vendor-type-review",
            "models": [{ "id": "department", "kind": "entity", "label": "Department", "fields": [] }]
        }));
        let next = compiled(json!({
            "app_id": "vendor",
            "customer_id": "dev",
            "version": "2026-09-26.runtime-observability-v53",
            "models": []
        }));

        let contract = compile_schema_transition_contract(
            &[
                omitted_lookup_default.clone(),
                explicit_lookup_default.clone(),
                omitted_lookup_default,
            ],
            &next,
        )
        .expect("distinct predecessor shapes are valid");

        assert_eq!(contract.predecessors.len(), 2);
        assert_eq!(
            contract.predecessors[0].version,
            "2026-07-27.vendor-type-review"
        );
        assert_ne!(
            contract.predecessors[0].schema,
            contract.predecessors[1].schema
        );
    }
}

pub fn compile_sql_materialization_plan(
    previous: Option<&CompiledManifest>,
    compiled: &CompiledManifest,
) -> Result<SqlArtifactManifest, SqlCompileError> {
    compile_sql_materialization_with_catalog(previous, compiled).map(|(manifest, _)| manifest)
}

#[derive(Debug, Serialize)]
pub struct SqlOnlineOptionalTextAddition {
    kind: &'static str,
    predecessor_artifact_sha256: String,
    predecessor_schema: Schema,
    model_id: ModelId,
    field_id: kernel::FieldId,
    table: String,
    column: String,
    constraint: String,
    constraint_catalog: Vec<ConstraintCatalogEntry>,
    authorization_policy: Option<SqlAuthorizationPolicyCatalog>,
}

#[derive(Debug, Serialize)]
struct SqlAuthorizationPolicyCatalog {
    policy: serde_json::Value,
    sha256: String,
}

/// Issue online materialization evidence only when the checked predecessor SQL
/// is identical to the compiler's predecessor output and the candidate changes
/// only the physical objects needed by the verified optional text addition.
pub fn compile_online_sql_transition_plan(
    previous: &crate::data_plane::DataPlanePredecessor,
    checked_previous_sql: &SqlArtifactManifest,
    compiled: &CompiledManifest,
) -> Result<(SqlArtifactManifest, Option<SqlOnlineOptionalTextAddition>), SqlCompileError> {
    let (manifest, constraint_catalog) =
        compile_sql_materialization_with_catalog(Some(&previous.compiled), compiled)?;
    let Some((model_id, field_id)) =
        crate::data_plane::predecessor::optional_text_addition(&previous.compiled, compiled)
    else {
        return Ok((manifest, None));
    };
    if !manifest.retirements.is_empty()
        || compile_sql_artifact_manifest(&previous.compiled)? != *checked_previous_sql
    {
        return Ok((manifest, None));
    }
    let table = physical_models(&compiled.schema)?[&model_id]
        .version_table
        .clone();
    let field = compiled
        .schema
        .models
        .iter()
        .find(|model| model.id == model_id)
        .and_then(|model| model.fields.iter().find(|field| field.id == field_id))
        .expect("verified optional text field exists");
    let column = field_columns(field)?.remove(0).name;
    let constraint = constraint_name(&table, &format!("{column}_record_event_null_check"));
    if !same_online_sql_substrate(
        checked_previous_sql,
        &manifest,
        &table,
        &column,
        &constraint,
    ) {
        return Ok((manifest, None));
    }
    Ok((
        manifest,
        Some(SqlOnlineOptionalTextAddition {
            kind: "optional-text-addition-v1",
            predecessor_artifact_sha256: previous.artifact_sha256.clone(),
            predecessor_schema: previous.compiled.schema.clone(),
            model_id,
            field_id,
            table,
            column,
            constraint,
            constraint_catalog,
            authorization_policy: authorization_policy_catalog(compiled),
        }),
    ))
}

fn same_online_sql_substrate(
    previous: &SqlArtifactManifest,
    candidate: &SqlArtifactManifest,
    table: &str,
    column: &str,
    constraint: &str,
) -> bool {
    let column_name = format!("{table}.{column}");
    let constraint_name = format!("{table}.{constraint}");
    let scope = format!("{}.{}", candidate.app_id, candidate.customer_id);
    let preflight = format!("kernel_materialization_preflight.{scope}");
    let retirements = format!("kernel_retired_field_artifact_reconciliation.{scope}");
    let column_sql = format!(
        "alter table {} add column if not exists {} text",
        quote_identifier(table),
        quote_identifier(column)
    );
    let mut checks = Vec::new();
    push_check(
        &mut checks,
        table,
        constraint,
        &format!(
            "(not tombstones_record and not untombstones_record) or {} is null",
            quote_identifier(column)
        ),
    );
    let is_added = |artifact: &SqlArtifact| {
        (artifact.kind == SqlArtifactKind::Column && artifact.name == column_name)
            || (artifact.kind == SqlArtifactKind::CheckConstraint
                && artifact.name == constraint_name)
    };
    let ignored = |artifact: &SqlArtifact| {
        matches!(
            artifact.kind,
            SqlArtifactKind::ConstraintCatalog | SqlArtifactKind::AuthorizationPolicyCatalog
        ) || (artifact.kind == SqlArtifactKind::Function
            && (artifact.name == preflight || artifact.name == retirements))
    };
    !previous.artifacts.iter().any(&is_added)
        && candidate.artifacts.iter().any(|entry| {
            entry.kind == SqlArtifactKind::Column
                && entry.name == column_name
                && entry.sql == column_sql
        })
        && candidate.artifacts.contains(&checks[0])
        && candidate
            .artifacts
            .iter()
            .filter(|entry| is_added(entry))
            .count()
            == 2
        && previous
            .artifacts
            .iter()
            .filter(|entry| !ignored(entry))
            .eq(candidate
                .artifacts
                .iter()
                .filter(|entry| !ignored(entry) && !is_added(entry)))
}

fn compile_sql_materialization_with_catalog(
    previous: Option<&CompiledManifest>,
    compiled: &CompiledManifest,
) -> Result<(SqlArtifactManifest, Vec<ConstraintCatalogEntry>), SqlCompileError> {
    validate_schema(&compiled.schema).map_err(|error| {
        let issue = error.issues.into_iter().next().expect("validation issue");
        SqlCompileError::new(issue.code, issue.path, issue.message)
    })?;
    if let Some(previous) = previous {
        validate_archived_names(std::slice::from_ref(previous), compiled)?;
        validate_required_additions(&previous.schema, &compiled.schema)?;
        validate_transition(&previous.schema, &compiled.schema)?;
        validate_field_names(previous, compiled)?;
    }

    let physical_models = physical_models(&compiled.schema)?;
    let models = compiled
        .schema
        .models
        .iter()
        .map(|model| (model.id.clone(), model))
        .collect::<BTreeMap<_, _>>();
    let mut artifacts = Vec::new();
    substrate_artifacts(&mut artifacts);
    for model in &compiled.schema.models {
        if model.kind == ModelKind::Lookup {
            lookup_model_artifacts(&mut artifacts, model)?;
            continue;
        }
        let physical = physical_models
            .get(&model.id)
            .expect("physical model exists after schema validation");
        model_artifacts(&mut artifacts, model, physical, &physical_models, &models)?;
    }
    let constraint_catalog = constraint_artifacts(&mut artifacts, compiled, &physical_models)?;
    authorization_policy_artifacts(&mut artifacts, compiled);
    runtime_function_artifacts(&mut artifacts, compiled)?;
    artifacts.sort_by(|left, right| {
        left.kind.cmp(&right.kind).then_with(|| {
            if left.kind == SqlArtifactKind::Function {
                std::cmp::Ordering::Equal
            } else {
                left.name
                    .cmp(&right.name)
                    .then_with(|| left.sql.cmp(&right.sql))
            }
        })
    });

    let mut retirements = previous
        .map(|previous| retired_elements(previous, compiled))
        .unwrap_or_default();
    retirements.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .then_with(|| left.model.cmp(&right.model))
            .then_with(|| left.field.cmp(&right.field))
            .then_with(|| left.element.cmp(&right.element))
    });

    let source_checksum = checksum_of(compiled)?;
    let constraint_expression_coverage = constraint_expression_coverage(compiled);
    let runtime_api_capabilities = runtime_api_capabilities(&artifacts);
    let checksum = checksum_of(&ChecksumPayload {
        format_version: SQL_ARTIFACT_FORMAT_VERSION,
        app_id: compiled.schema.app_id.as_str(),
        customer_id: compiled.schema.customer_id.as_str(),
        version: compiled.schema.version.as_str(),
        source_checksum: &source_checksum,
        constraint_expression_coverage: &constraint_expression_coverage,
        runtime_api_capabilities: &runtime_api_capabilities,
        retirements: &retirements,
        artifacts: &artifacts,
    })?;

    Ok((
        SqlArtifactManifest {
            format_version: SQL_ARTIFACT_FORMAT_VERSION,
            app_id: compiled.schema.app_id.to_string(),
            customer_id: compiled.schema.customer_id.to_string(),
            version: compiled.schema.version.to_string(),
            source_checksum,
            checksum,
            constraint_expression_coverage,
            runtime_api_capabilities,
            retirements,
            artifacts,
        },
        constraint_catalog,
    ))
}

pub fn render_sql_artifact_bundle(manifest: &SqlArtifactManifest) -> String {
    let mut output = String::new();
    writeln!(output, "-- Kernel non-destructive generated SQL plan").unwrap();
    writeln!(output, "-- format_version: {}", manifest.format_version).unwrap();
    writeln!(output, "-- app_id: {}", json_comment(&manifest.app_id)).unwrap();
    writeln!(
        output,
        "-- customer_id: {}",
        json_comment(&manifest.customer_id)
    )
    .unwrap();
    writeln!(output, "-- version: {}", json_comment(&manifest.version)).unwrap();
    writeln!(output, "-- checksum: {}", manifest.checksum).unwrap();
    output.push_str(BUNDLE_TEMP_VIEW_PREFLIGHT);
    output.push('\n');
    writeln!(output, "begin;\n").unwrap();

    let mut artifacts = manifest.artifacts.iter().collect::<Vec<_>>();
    artifacts.sort_by(|left, right| {
        install_rank(left.kind)
            .cmp(&install_rank(right.kind))
            .then_with(|| {
                if left.kind == SqlArtifactKind::Function && right.kind == SqlArtifactKind::Function
                {
                    function_install_rank(&left.name).cmp(&function_install_rank(&right.name))
                } else {
                    left.name
                        .cmp(&right.name)
                        .then_with(|| left.sql.cmp(&right.sql))
                }
            })
    });
    for artifact in artifacts {
        writeln!(
            output,
            "-- artifact: {} {}",
            artifact_kind_name(artifact.kind),
            artifact.name
        )
        .unwrap();
        output.push_str(artifact.sql.trim());
        if !artifact.sql.trim_end().ends_with(';') {
            output.push(';');
        }
        output.push_str("\n\n");
    }
    output.push_str("commit;\n");
    output
}

fn function_install_rank(signature: &str) -> u8 {
    match signature {
        "kernel_installer_capability_role(text)" => 0,
        "kernel_principal_scope_authorized(text,text,text,text)" => 1,
        _ => 2,
    }
}

const BUNDLE_TEMP_VIEW_PREFLIGHT: &str = r#"do $kernel$
declare
  relation record;
begin
  for relation in
    select namespace.nspname as schema_name, class.relname as relation_name
    from pg_catalog.pg_class as class
    join pg_catalog.pg_namespace as namespace on namespace.oid = class.relnamespace
    where class.relkind = 'v'
      and class.relnamespace = pg_catalog.pg_my_temp_schema()
  loop
    execute pg_catalog.format(
      'drop view if exists %I.%I cascade',
      relation.schema_name,
      relation.relation_name
    );
  end loop;
end
$kernel$;
"#;

#[derive(Serialize)]
struct ChecksumPayload<'a> {
    format_version: u32,
    app_id: &'a str,
    customer_id: &'a str,
    version: &'a str,
    source_checksum: &'a str,
    constraint_expression_coverage: &'a SqlFeatureCoverage,
    runtime_api_capabilities: &'a [SqlRuntimeApiCapability],
    retirements: &'a [RetiredSchemaElement],
    artifacts: &'a [SqlArtifact],
}

#[derive(Debug)]
struct PhysicalModel {
    record_table: String,
    version_table: String,
}

/// The compiler-owned physical identity of an authoritative CHECK. PostgreSQL
/// scopes constraint names to their table, so readers must always compare the
/// complete pair rather than a name alone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct ConstraintIdentity {
    model_id: String,
    constraint_id: String,
    table_name: String,
    constraint_name: String,
    field_ids: Vec<String>,
}

/// The generated write-path identity of a cross-record interval rule. It has
/// no physical CHECK; generated apply, draft approval, revert, and installer
/// readiness read it from the revision's constraint catalog and resolve labels
/// from the effective schema.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct IntervalExclusionIdentity {
    kind: &'static str,
    model_id: String,
    constraint_id: String,
    label: String,
    start_field_id: String,
    end_field_id: String,
    subject_field_ids: Vec<Vec<String>>,
    field_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
enum ConstraintCatalogEntry {
    Check(ConstraintIdentity),
    IntervalExclusion(IntervalExclusionIdentity),
}

#[derive(Debug)]
struct FieldColumn {
    name: String,
    sql_type: &'static str,
}

fn physical_models(schema: &Schema) -> Result<BTreeMap<ModelId, PhysicalModel>, SqlCompileError> {
    schema
        .models
        .iter()
        .map(|model| {
            let identifier = normalize_identifier(model.id.as_str()).map_err(|issue| {
                SqlCompileError::new(issue.code, format!("models.{}.id", model.id), issue.message)
            })?;
            Ok((
                model.id.clone(),
                PhysicalModel {
                    record_table: bounded_identifier(&format!("{identifier}_record")),
                    version_table: bounded_identifier(&format!("{identifier}_version")),
                },
            ))
        })
        .collect()
}

pub(crate) fn constraint_expression_field_ids(expression: &ConstraintExpr) -> Vec<String> {
    fn add(field: &str, fields: &mut Vec<String>) {
        if !fields.iter().any(|existing| existing == field) {
            fields.push(field.to_string());
        }
    }
    fn collect(expression: &ConstraintExpr, fields: &mut Vec<String>) {
        match expression {
            ConstraintExpr::And { expressions } | ConstraintExpr::Or { expressions } => {
                for expression in expressions {
                    collect(expression, fields);
                }
            }
            ConstraintExpr::Not { expression } => collect(expression, fields),
            ConstraintExpr::FieldPresent { field }
            | ConstraintExpr::FieldAbsent { field }
            | ConstraintExpr::CompareLiteral { field, .. }
            | ConstraintExpr::FieldIn { field, .. }
            | ConstraintExpr::FieldSetContains { field, .. }
            | ConstraintExpr::TextLength { field, .. }
            | ConstraintExpr::TextStartsWith { field, .. } => add(field, fields),
            ConstraintExpr::CountPresent {
                fields: referenced, ..
            } => {
                for field in referenced {
                    add(field, fields);
                }
            }
            ConstraintExpr::CompareFields { left, right, .. } => {
                add(left, fields);
                add(right, fields);
            }
            ConstraintExpr::NonOverlappingIntervals {
                start,
                end,
                subjects,
            } => {
                add(start, fields);
                add(end, fields);
                for field in subjects.iter().flatten() {
                    add(field, fields);
                }
            }
        }
    }

    let mut fields = Vec::new();
    collect(expression, &mut fields);
    fields
}

fn authoritative_constraint_identity(
    constraint: &crate::ConstraintManifest,
    model: &Model,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
) -> Result<ConstraintIdentity, SqlCompileError> {
    let constraint_path = format!("constraints.{}", constraint.id);
    let physical = physical_models
        .get(&model.id)
        .expect("physical model exists after schema validation");
    let identifier = normalize_identifier(&constraint.id).map_err(|issue| {
        SqlCompileError::new(issue.code, format!("{constraint_path}.id"), issue.message)
    })?;
    let table_name = if model.kind == ModelKind::Lookup {
        "lookup_version".to_string()
    } else {
        physical.version_table.clone()
    };
    let suffix = if model.kind == ModelKind::Lookup {
        format!("{}_{}_constraint_check", model.id, identifier)
    } else {
        format!("{identifier}_constraint_check")
    };
    Ok(ConstraintIdentity {
        model_id: model.id.to_string(),
        constraint_id: constraint.id.clone(),
        constraint_name: constraint_name(&table_name, &suffix),
        table_name,
        field_ids: constraint_expression_field_ids(&constraint.expression),
    })
}
fn substrate_artifacts(artifacts: &mut Vec<SqlArtifact>) {
    push_artifact(
        artifacts,
        SqlArtifactKind::Sequence,
        "change_set_lifecycle_order_seq",
        "create sequence if not exists change_set_lifecycle_order_seq",
    );
    push_artifact(
        artifacts,
        SqlArtifactKind::Table,
        "schema_revision",
        r#"create table if not exists schema_revision (
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
  materialization_git_sha text,
  materialization_vercel_deployment_id text,
  materialization_vercel_environment text,
  materialization_vercel_git_ref text,
  materialized_at timestamptz,
  authorization_policy_declared boolean,
  constraint schema_revision_scope_version_key unique (app_id, customer_id, version)
)"#,
    );
    push_artifact(
        artifacts,
        SqlArtifactKind::Column,
        "schema_revision.authorization_policy_declared",
        "alter table schema_revision add column if not exists authorization_policy_declared boolean",
    );
    push_artifact(
        artifacts,
        SqlArtifactKind::Table,
        "schema_activation_head",
        r#"create table if not exists schema_activation_head (
  app_id text not null,
  customer_id text not null,
  base_schema_version text not null,
  advanced_at timestamptz not null default now(),
  constraint schema_activation_head_pkey primary key (app_id, customer_id)
)"#,
    );
    push_artifact(
        artifacts,
        SqlArtifactKind::Table,
        "change_set",
        r#"create table if not exists change_set (
  id bigserial primary key,
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
  threads jsonb not null default '{}',
  thread_receipts jsonb not null default '{}',
  entry_notes jsonb,
  written_fields jsonb,
  created_order bigint not null,
  applied_order bigint,
  created_at timestamptz not null default now(),
  applied_at timestamptz
)"#,
    );
    push_artifact(
        artifacts,
        SqlArtifactKind::Table,
        "agent_run",
        r#"create table if not exists agent_run (
  id bigserial primary key,
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
  constraint agent_run_scope_run_key unique (app_id, customer_id, run_id)
)"#,
    );
    // Fresh installations receive this from the table definition above, but
    // pre-compiler databases may have the old ledger without a status field.
    // Repair it before the generated status constraint is evaluated.
    push_artifact(
        artifacts,
        SqlArtifactKind::Column,
        "agent_run.status",
        "alter table agent_run add column if not exists status text not null default 'recorded'",
    );
    push_artifact(
        artifacts,
        SqlArtifactKind::Column,
        "change_set.notes",
        "alter table change_set add column if not exists notes text",
    );
    // A draft's review threads, copied from its work session on draft Save,
    // and the request receipts of thread replies and resolutions.
    push_artifact(
        artifacts,
        SqlArtifactKind::Column,
        "change_set.threads",
        "alter table change_set add column if not exists threads jsonb not null default '{}'",
    );
    push_artifact(
        artifacts,
        SqlArtifactKind::Column,
        "change_set.thread_receipts",
        "alter table change_set add column if not exists thread_receipts jsonb not null default '{}'",
    );
    // A work-session Save's rule notes, keyed `model:record:field`.
    push_artifact(
        artifacts,
        SqlArtifactKind::Column,
        "change_set.entry_notes",
        "alter table change_set add column if not exists entry_notes jsonb",
    );
    // The fields a draft wrote, keyed model id, record id, then effective
    // start; reads with pending drafts overlay exactly these.
    push_artifact(
        artifacts,
        SqlArtifactKind::Column,
        "change_set.written_fields",
        "alter table change_set add column if not exists written_fields jsonb",
    );

    for (table, name, expression) in [
        (
            "change_set",
            "change_set_created_with_mode_check",
            "created_with_mode in ('mainline', 'draft')",
        ),
        (
            "change_set",
            "change_set_status_check",
            "status in ('draft', 'mainline', 'discarded')",
        ),
        (
            "change_set",
            "change_set_applied_at_status_check",
            "(status = 'mainline') = (applied_at is not null)",
        ),
        (
            "change_set",
            "change_set_applied_order_status_check",
            "(status = 'mainline') = (applied_order is not null)",
        ),
    ] {
        push_check(artifacts, table, name, expression);
    }
    push_catalog_check_repair(
        artifacts,
        "agent_run",
        "agent_run_status_check",
        "status in ('recorded', 'completed', 'validation_exhausted', 'budget_exhausted', 'runtime_error', 'cancelled')",
        "status = ANY (ARRAY['recorded'::text, 'completed'::text, 'validation_exhausted'::text, 'budget_exhausted'::text, 'runtime_error'::text, 'cancelled'::text])",
        &[
            "status = ANY (ARRAY['recorded'::text, 'completed'::text, 'validation_exhausted'::text, 'runtime_error'::text])",
            "status = ANY (ARRAY['recorded'::text, 'completed'::text, 'validation_exhausted'::text, 'runtime_error'::text, 'cancelled'::text])",
        ],
    );
    push_foreign_key(
        artifacts,
        "change_set",
        "change_set_schema_revision_tenant_fk",
        &["schema_revision_id", "app_id", "customer_id"],
        "schema_revision",
        &["id", "app_id", "customer_id"],
    );
    push_foreign_key(
        artifacts,
        "agent_run",
        "agent_run_schema_revision_tenant_fk",
        &["schema_revision_id", "app_id", "customer_id"],
        "schema_revision",
        &["id", "app_id", "customer_id"],
    );
    push_foreign_key(
        artifacts,
        "schema_constraint_identity",
        "schema_constraint_identity_revision_tenant_fk",
        &["schema_revision_id", "app_id", "customer_id"],
        "schema_revision",
        &["id", "app_id", "customer_id"],
    );
    for (name, sql) in [
        (
            "schema_revision_tenant_id_idx",
            "create unique index if not exists schema_revision_tenant_id_idx on schema_revision (id, app_id, customer_id)",
        ),
        (
            "schema_revision_active_idx",
            "create unique index if not exists schema_revision_active_idx on schema_revision (app_id, customer_id) where activated_at is not null",
        ),
        (
            "change_set_tenant_id_idx",
            "create unique index if not exists change_set_tenant_id_idx on change_set (id, app_id, customer_id)",
        ),
        (
            "change_set_idempotency_idx",
            "create unique index if not exists change_set_idempotency_idx on change_set (app_id, customer_id, idempotency_key) where idempotency_key is not null",
        ),
        (
            "change_set_pending_draft_idx",
            "create index if not exists change_set_pending_draft_idx on change_set (app_id, customer_id) where status = 'draft' and applied_order is null",
        ),
        (
            "agent_run_tenant_id_idx",
            "create unique index if not exists agent_run_tenant_id_idx on agent_run (id, app_id, customer_id)",
        ),
    ] {
        push_artifact(artifacts, SqlArtifactKind::Index, name, sql);
    }
    for table in [
        "schema_revision",
        "schema_activation_head",
        "change_set",
        "agent_run",
        "schema_constraint_identity",
    ] {
        push_policy(artifacts, table, table == "change_set");
    }
    push_app_catalog_policy(artifacts);
    lookup_substrate_artifacts(artifacts);
    push_artifact(
        artifacts,
        SqlArtifactKind::Table,
        "schema_installation_revision",
        crate::sql_runtime::installer_substrate_sql(),
    );
    push_foreign_key(
        artifacts,
        "schema_installation_revision",
        "schema_installation_revision_schema_revision_fk",
        &["schema_revision_id"],
        "schema_revision",
        &["id"],
    );
}

fn lookup_substrate_artifacts(artifacts: &mut Vec<SqlArtifact>) {
    for (name, sql) in [
        (
            "lookup_record",
            r#"create table if not exists lookup_record (
  app_id text not null,
  customer_id text not null,
  model_id text not null,
  id uuid not null,
  external_key text,
  created_at timestamptz not null default now(),
  constraint lookup_record_pkey primary key (app_id, customer_id, model_id, id)
)"#,
        ),
        (
            "lookup_version",
            r#"create table if not exists lookup_version (
  id uuid not null,
  app_id text not null,
  customer_id text not null,
  model_id text not null,
  record_id uuid not null,
  stage text not null,
  effective_start date not null,
  effective_end date,
  change_set_id bigint not null,
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  tombstones_record boolean not null default false,
  untombstones_record boolean not null default false,
  availability text not null default 'active',
  provenance jsonb,
  custom_fields jsonb not null default '[]',
  metadata jsonb not null default '{}',
  many_relations jsonb not null default '{}',
  values jsonb not null default '{}',
  constraint lookup_version_pkey primary key (app_id, customer_id, model_id, id)
)"#,
        ),
        (
            "lookup_value_projection",
            r#"create table if not exists lookup_value_projection (
  version_id uuid not null,
  app_id text not null,
  customer_id text not null,
  model_id text not null,
  record_id uuid not null,
  field_id text not null,
  value_type text not null,
  text_value text,
  number_value numeric,
  bool_value boolean,
  date_value date,
  datetime_value timestamptz,
  json_value jsonb,
  text_list_value text[],
  constraint lookup_value_projection_pkey primary key (app_id, customer_id, model_id, version_id, field_id)
)"#,
        ),
        (
            "lookup_alias_projection",
            r#"create table if not exists lookup_alias_projection (
  version_id uuid not null,
  app_id text not null,
  customer_id text not null,
  model_id text not null,
  record_id uuid not null,
  field_id text not null,
  ordinal integer not null,
  kind text not null,
  alias text not null,
  normalized_alias text not null,
  is_current boolean not null default false,
  constraint lookup_alias_projection_pkey primary key (app_id, customer_id, model_id, version_id, field_id, kind, ordinal)
)"#,
        ),
        (
            "lookup_relation_projection",
            r#"create table if not exists lookup_relation_projection (
  version_id uuid not null,
  app_id text not null,
  customer_id text not null,
  source_model_id text not null,
  source_record_id uuid not null,
  field_id text not null,
  relation_kind text not null,
  ordinal integer not null,
  target_kind text not null,
  target_model_id text not null,
  target_record_id uuid not null,
  lookup_target_model_id text,
  lookup_target_record_id uuid,
  constraint lookup_relation_projection_pkey primary key (app_id, customer_id, source_model_id, version_id, field_id, ordinal)
)"#,
        ),
    ] {
        push_artifact(artifacts, SqlArtifactKind::Table, name, sql);
    }

    // `CREATE TABLE IF NOT EXISTS` deliberately preserves an installed
    // substrate.  Add this later-introduced runtime column explicitly so an
    // existing lookup substrate can accept the generated metadata constraints
    // and migration snapshots on the same idempotent installation run.
    push_artifact(
        artifacts,
        SqlArtifactKind::Column,
        "lookup_version.metadata",
        "alter table lookup_version add column if not exists metadata jsonb not null default '{}'",
    );

    push_catalog_check_repair(
        artifacts,
        "lookup_version",
        "lookup_version_stage_check",
        "stage in ('draft', 'mainline', 'discarded', 'reverted')",
        "stage = ANY (ARRAY['draft'::text, 'mainline'::text, 'discarded'::text, 'reverted'::text])",
        &["stage = ANY (ARRAY['draft'::text, 'mainline'::text, 'discarded'::text])"],
    );

    for (table, name, expression) in [
        (
            "lookup_version",
            "lookup_version_effective_range_check",
            "effective_end is null or effective_end >= effective_start",
        ),
        (
            "lookup_version",
            "lookup_version_applied_at_stage_check",
            "(stage = 'mainline') = (applied_at is not null)",
        ),
        (
            "lookup_version",
            "lookup_version_record_event_exclusion_check",
            "not (tombstones_record and untombstones_record)",
        ),
        (
            "lookup_version",
            "lookup_version_availability_check",
            "availability in ('active', 'retired')",
        ),
        (
            "lookup_version",
            "lookup_version_values_object_check",
            "jsonb_typeof(values) = 'object'",
        ),
        (
            "lookup_version",
            "lookup_version_metadata_object_check",
            "jsonb_typeof(metadata) = 'object'",
        ),
        (
            "lookup_version",
            "lookup_version_many_relations_object_check",
            "jsonb_typeof(many_relations) = 'object'",
        ),
        (
            "lookup_alias_projection",
            "lookup_alias_projection_kind_check",
            "kind in ('display', 'alias')",
        ),
        (
            "lookup_relation_projection",
            "lookup_relation_projection_target_check",
            "(target_kind = 'lookup' and lookup_target_model_id = target_model_id and lookup_target_record_id = target_record_id) or (target_kind = 'entity' and lookup_target_model_id is null and lookup_target_record_id is null)",
        ),
        (
            "lookup_relation_projection",
            "lookup_relation_projection_kind_check",
            "relation_kind in ('scalar', 'many') and ordinal >= 0",
        ),
    ] {
        push_check(artifacts, table, name, expression);
    }

    push_foreign_key(
        artifacts,
        "lookup_version",
        "lookup_version_record_fk",
        &["app_id", "customer_id", "model_id", "record_id"],
        "lookup_record",
        &["app_id", "customer_id", "model_id", "id"],
    );
    push_foreign_key(
        artifacts,
        "lookup_version",
        "lookup_version_change_set_fk",
        &["change_set_id", "app_id", "customer_id"],
        "change_set",
        &["id", "app_id", "customer_id"],
    );
    for table in ["lookup_value_projection", "lookup_alias_projection"] {
        push_foreign_key(
            artifacts,
            table,
            &format!("{table}_version_fk"),
            &["app_id", "customer_id", "model_id", "version_id"],
            "lookup_version",
            &["app_id", "customer_id", "model_id", "id"],
        );
    }
    push_foreign_key(
        artifacts,
        "lookup_relation_projection",
        "lookup_relation_projection_version_fk",
        &["app_id", "customer_id", "source_model_id", "version_id"],
        "lookup_version",
        &["app_id", "customer_id", "model_id", "id"],
    );
    push_foreign_key(
        artifacts,
        "lookup_relation_projection",
        "lookup_relation_projection_lookup_target_fk",
        &[
            "app_id",
            "customer_id",
            "lookup_target_model_id",
            "lookup_target_record_id",
        ],
        "lookup_record",
        &["app_id", "customer_id", "model_id", "id"],
    );

    for (name, sql) in [
        (
            "lookup_record_external_key_idx",
            "create unique index if not exists lookup_record_external_key_idx on lookup_record (app_id, customer_id, model_id, external_key) where external_key is not null",
        ),
        (
            "lookup_version_lookup_idx",
            "create index if not exists lookup_version_lookup_idx on lookup_version (app_id, customer_id, model_id, record_id, stage, effective_start desc)",
        ),
        (
            "lookup_version_change_set_idx",
            "create index if not exists lookup_version_change_set_idx on lookup_version (app_id, customer_id, change_set_id, model_id)",
        ),
        (
            "lookup_version_change_set_value_once_idx",
            "create unique index if not exists lookup_version_change_set_value_once_idx on lookup_version (app_id, customer_id, model_id, record_id, effective_start, change_set_id) where not tombstones_record and not untombstones_record",
        ),
        (
            "lookup_version_mainline_lifecycle_once_idx",
            "create unique index if not exists lookup_version_mainline_lifecycle_once_idx on lookup_version (app_id, customer_id, model_id, record_id, effective_start, tombstones_record, untombstones_record) where stage = 'mainline' and (tombstones_record or untombstones_record)",
        ),
        (
            "lookup_version_draft_idx",
            "create index if not exists lookup_version_draft_idx on lookup_version (app_id, customer_id, model_id, record_id, effective_start desc) where stage = 'draft'",
        ),
        (
            "lookup_value_projection_text_idx",
            "create index if not exists lookup_value_projection_text_idx on lookup_value_projection (app_id, customer_id, model_id, field_id, text_value, record_id)",
        ),
        (
            "lookup_value_projection_number_idx",
            "create index if not exists lookup_value_projection_number_idx on lookup_value_projection (app_id, customer_id, model_id, field_id, number_value, record_id) where number_value is not null",
        ),
        (
            "lookup_value_projection_bool_idx",
            "create index if not exists lookup_value_projection_bool_idx on lookup_value_projection (app_id, customer_id, model_id, field_id, bool_value, record_id) where bool_value is not null",
        ),
        (
            "lookup_value_projection_date_idx",
            "create index if not exists lookup_value_projection_date_idx on lookup_value_projection (app_id, customer_id, model_id, field_id, date_value, record_id) where date_value is not null",
        ),
        (
            "lookup_alias_projection_match_idx",
            "create index if not exists lookup_alias_projection_match_idx on lookup_alias_projection (app_id, customer_id, model_id, normalized_alias, record_id) where is_current",
        ),
        (
            // Each lookup write retires the record's current aliases by record id.
            "lookup_alias_projection_record_idx",
            "create index if not exists lookup_alias_projection_record_idx on lookup_alias_projection (app_id, customer_id, model_id, record_id) where is_current",
        ),
        (
            "lookup_alias_projection_display_page_idx",
            "create index if not exists lookup_alias_projection_display_page_idx on lookup_alias_projection (app_id, customer_id, model_id, normalized_alias, record_id, version_id) where kind = 'display'",
        ),
        (
            "lookup_alias_projection_active_unique_idx",
            "create unique index if not exists lookup_alias_projection_active_unique_idx on lookup_alias_projection (app_id, customer_id, model_id, normalized_alias) where is_current",
        ),
        (
            "lookup_relation_projection_target_idx",
            "create index if not exists lookup_relation_projection_target_idx on lookup_relation_projection (app_id, customer_id, target_model_id, target_record_id, source_model_id, source_record_id)",
        ),
    ] {
        push_artifact(artifacts, SqlArtifactKind::Index, name, sql);
    }
    for table in [
        "lookup_record",
        "lookup_version",
        "lookup_value_projection",
        "lookup_alias_projection",
        "lookup_relation_projection",
    ] {
        push_policy(artifacts, table, true);
    }
}

fn lookup_model_artifacts(
    artifacts: &mut Vec<SqlArtifact>,
    model: &Model,
) -> Result<(), SqlCompileError> {
    for field in model
        .fields
        .iter()
        .filter(|field| field.required && field.lifecycle == SchemaElementLifecycle::Active)
    {
        let name = constraint_name(
            "lookup_version",
            &format!("{}_{}_required_check", model.id, field.id),
        );
        push_required_check(
            artifacts,
            "lookup_version",
            &name,
            &format!(
                "model_id <> {} or tombstones_record or untombstones_record or values ? {}",
                quote_literal(model.id.as_str()),
                quote_literal(field.id.as_str())
            ),
        );
    }
    for field in model
        .fields
        .iter()
        .filter(|field| field.is_unique && field.lifecycle == SchemaElementLifecycle::Active)
    {
        let name = bounded_identifier(&format!(
            "{}_version_{}_live_unique_idx",
            model.id, field.id
        ));
        let model_id = quote_literal(model.id.as_str());
        let field_id = quote_literal(field.id.as_str());
        push_artifact(artifacts, SqlArtifactKind::Index, &name, format!(
            "do $kernel$ declare failing_rows text; begin
              create unique index if not exists {index} on lookup_version (app_id, customer_id, ((values->{field_id})->'value')) where model_id = {model_id} and stage = 'mainline' and effective_end is null and (values->{field_id})->'value' is not null;
            exception when unique_violation then
              select string_agg(record_id::text, ', ' order by record_id) into failing_rows from (
                select record_id, count(*) over (partition by app_id, customer_id, (values->{field_id})->'value') as duplicates
                from lookup_version where model_id = {model_id} and stage = 'mainline' and effective_end is null and (values->{field_id})->'value' is not null
              ) conflicts where duplicates > 1;
              raise exception 'Cannot make %.% unique. Give these rows distinct values through ordinary record writes, then retry. Failing rows: %', {model_id}, {field_id}, failing_rows;
            end $kernel$", index = quote_identifier(&name)));
    }
    let metadata_expression = model.extensions.record_metadata.as_ref().map_or_else(
        || {
            format!(
                "model_id <> {} or metadata = '{{}}'::jsonb",
                quote_literal(model.id.as_str())
            )
        },
        |limits| {
            format!(
                "model_id <> {} or octet_length(metadata::text) <= {}",
                quote_literal(model.id.as_str()),
                limits.max_bytes
            )
        },
    );
    push_check(
        artifacts,
        "lookup_version",
        &constraint_name("lookup_version", &format!("{}_metadata_check", model.id)),
        &metadata_expression,
    );
    Ok(())
}

fn model_artifacts(
    artifacts: &mut Vec<SqlArtifact>,
    model: &Model,
    physical: &PhysicalModel,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
    models: &BTreeMap<ModelId, &Model>,
) -> Result<(), SqlCompileError> {
    let record_table = quote_identifier(&physical.record_table);
    let version_table = quote_identifier(&physical.version_table);
    let record_pkey = constraint_name(&physical.record_table, "pkey");
    let tenant_key = constraint_name(&physical.record_table, "tenant_id_key");
    push_artifact(
        artifacts,
        SqlArtifactKind::Table,
        &physical.record_table,
        format!(
            "create table if not exists {record_table} (\n  id uuid,\n  app_id text not null,\n  customer_id text not null,\n  external_key text,\n  created_at timestamptz not null default now(),\n  constraint {} primary key (id),\n  constraint {} unique (id, app_id, customer_id)\n)",
            quote_identifier(&record_pkey),
            quote_identifier(&tenant_key)
        ),
    );
    push_artifact(
        artifacts,
        SqlArtifactKind::Table,
        &physical.version_table,
        format!(
            "create table if not exists {version_table} (\n  id uuid primary key,\n  record_id uuid not null,\n  app_id text not null,\n  customer_id text not null,\n  stage text not null,\n  effective_start date not null,\n  effective_end date,\n  change_set_id bigint not null,\n  created_at timestamptz not null default now(),\n  applied_at timestamptz,\n  tombstones_record boolean not null default false,\n  untombstones_record boolean not null default false,\n  provenance jsonb,\n  custom_fields jsonb not null default '[]',\n  metadata jsonb not null default '{{}}'\n)"
        ),
    );
    // The table definition above only applies to fresh installations. Keep
    // legacy typed version tables compatible before emitting constraints and
    // generated functions that read `metadata`.
    push_artifact(
        artifacts,
        SqlArtifactKind::Column,
        format!("{}.metadata", physical.version_table),
        format!(
            "alter table {version_table} add column if not exists metadata jsonb not null default '{{}}'"
        ),
    );

    push_check(
        artifacts,
        &physical.version_table,
        &constraint_name(&physical.version_table, "metadata_object_check"),
        "jsonb_typeof(metadata) = 'object'",
    );
    let metadata_expression = model.extensions.record_metadata.as_ref().map_or_else(
        || "metadata = '{}'::jsonb".to_string(),
        |limits| format!("octet_length(metadata::text) <= {}", limits.max_bytes),
    );
    push_check(
        artifacts,
        &physical.version_table,
        &constraint_name(&physical.version_table, "metadata_limits_check"),
        &metadata_expression,
    );

    for field in &model.fields {
        for column in field_columns(field)? {
            push_artifact(
                artifacts,
                SqlArtifactKind::Column,
                format!("{}.{}", physical.version_table, column.name),
                format!(
                    "alter table {version_table} add column if not exists {} {}",
                    quote_identifier(&column.name),
                    column.sql_type
                ),
            );
            push_check(
                artifacts,
                &physical.version_table,
                &constraint_name(
                    &physical.version_table,
                    &format!("{}_record_event_null_check", column.name),
                ),
                &format!(
                    "(not tombstones_record and not untombstones_record) or {} is null",
                    quote_identifier(&column.name)
                ),
            );
            if field.required && field.lifecycle == SchemaElementLifecycle::Active {
                push_required_check(
                    artifacts,
                    &physical.version_table,
                    &constraint_name(
                        &physical.version_table,
                        &format!("{}_required_check", column.name),
                    ),
                    &format!(
                        "tombstones_record or untombstones_record or {} is not null",
                        quote_identifier(&column.name)
                    ),
                );
            }
        }
        if field.field_type == FieldType::Relation {
            let target_model = field
                .target_model
                .as_ref()
                .and_then(|target| models.get(target))
                .expect("relation target exists after schema validation");
            let target = field
                .target_model
                .as_ref()
                .and_then(|target| physical_models.get(target))
                .expect("relation target exists after schema validation");
            let column = field_columns(field)?.remove(0);
            if target_model.kind == ModelKind::Lookup {
                let target_model_column = bounded_identifier(&format!(
                    "{}_target_model",
                    normalize_identifier(field.id.as_str()).expect("validated field identifier")
                ));
                push_artifact(
                    artifacts,
                    SqlArtifactKind::Column,
                    format!("{}.{}", physical.version_table, target_model_column),
                    format!(
                        "alter table {version_table} add column if not exists {} text not null default {}",
                        quote_identifier(&target_model_column),
                        quote_literal(target_model.id.as_str())
                    ),
                );
                push_check(
                    artifacts,
                    &physical.version_table,
                    &constraint_name(
                        &physical.version_table,
                        &format!("{}_target_model_check", column.name),
                    ),
                    &format!(
                        "{} = {}",
                        quote_identifier(&target_model_column),
                        quote_literal(target_model.id.as_str())
                    ),
                );
                push_foreign_key(
                    artifacts,
                    &physical.version_table,
                    &constraint_name(
                        &physical.version_table,
                        &format!("{}_tenant_fk", column.name),
                    ),
                    &["app_id", "customer_id", &target_model_column, &column.name],
                    "lookup_record",
                    &["app_id", "customer_id", "model_id", "id"],
                );
            } else {
                push_foreign_key(
                    artifacts,
                    &physical.version_table,
                    &constraint_name(
                        &physical.version_table,
                        &format!("{}_tenant_fk", column.name),
                    ),
                    &[&column.name, "app_id", "customer_id"],
                    &target.record_table,
                    &["id", "app_id", "customer_id"],
                );
            }
        }
        if field.field_type == FieldType::MoneyRate {
            let columns = field_columns(field)?;
            let amount = &columns[0];
            let currency = &columns[1];
            let period = &columns[2];
            push_check(
                artifacts,
                &physical.version_table,
                &constraint_name(
                    &physical.version_table,
                    &format!("{}_all_or_none_check", amount.name),
                ),
                &format!(
                    "(({} is null and {} is null and {} is null) or ({} is not null and {} is not null and {} is not null))",
                    quote_identifier(&amount.name),
                    quote_identifier(&currency.name),
                    quote_identifier(&period.name),
                    quote_identifier(&amount.name),
                    quote_identifier(&currency.name),
                    quote_identifier(&period.name)
                ),
            );
            push_check(
                artifacts,
                &physical.version_table,
                &constraint_name(
                    &physical.version_table,
                    &format!("{}_period_check", period.name),
                ),
                &format!(
                    "{} is null or {} in ('hourly', 'daily', 'weekly', 'monthly', 'annual')",
                    quote_identifier(&period.name),
                    quote_identifier(&period.name)
                ),
            );
        }
        if field.is_unique {
            let column = field_columns(field)?.remove(0);
            let name = bounded_identifier(&format!(
                "{}_{}_live_unique_idx",
                physical.version_table, column.name
            ));
            push_artifact(
                artifacts,
                SqlArtifactKind::Index,
                &name,
                format!(
                    "do $kernel$ declare failing_rows text; begin
                      create unique index if not exists {index} on {version_table} (app_id, customer_id, {column}) where stage = 'mainline' and effective_end is null and {column} is not null;
                    exception when unique_violation then
                      select string_agg(record_id::text, ', ' order by record_id) into failing_rows from (
                        select record_id, count(*) over (partition by app_id, customer_id, {column}) as duplicates
                        from {version_table} where stage = 'mainline' and effective_end is null and {column} is not null
                      ) conflicts where duplicates > 1;
                      raise exception 'Cannot make %.% unique. Give these rows distinct values through ordinary record writes, then retry. Failing rows: %', {model}, {field}, failing_rows;
                    end $kernel$",
                    index = quote_identifier(&name),
                    column = quote_identifier(&column.name),
                    model = quote_literal(model.id.as_str()),
                    field = quote_literal(field.id.as_str()),
                ),
            );
        }
    }

    for (name, expression) in [
        (
            constraint_name(&physical.version_table, "stage_check"),
            "stage in ('draft', 'mainline', 'discarded', 'reverted')".to_string(),
        ),
        (
            constraint_name(&physical.version_table, "effective_range_check"),
            "effective_end is null or effective_end >= effective_start".to_string(),
        ),
        (
            constraint_name(&physical.version_table, "applied_at_stage_check"),
            "(stage = 'mainline') = (applied_at is not null)".to_string(),
        ),
        (
            constraint_name(&physical.version_table, "record_event_exclusion_check"),
            "not (tombstones_record and untombstones_record)".to_string(),
        ),
    ] {
        push_check(artifacts, &physical.version_table, &name, &expression);
    }
    push_foreign_key(
        artifacts,
        &physical.version_table,
        &constraint_name(&physical.version_table, "record_tenant_fk"),
        &["record_id", "app_id", "customer_id"],
        &physical.record_table,
        &["id", "app_id", "customer_id"],
    );
    push_foreign_key(
        artifacts,
        &physical.version_table,
        &constraint_name(&physical.version_table, "change_set_tenant_fk"),
        &["change_set_id", "app_id", "customer_id"],
        "change_set",
        &["id", "app_id", "customer_id"],
    );

    let external_key_index =
        bounded_identifier(&format!("{}_external_key_idx", physical.record_table));
    let lookup_index = bounded_identifier(&format!("{}_lookup_idx", physical.version_table));
    let source_ref_index =
        bounded_identifier(&format!("{}_source_record_ref_idx", physical.version_table));
    let change_set_index =
        bounded_identifier(&format!("{}_change_set_idx", physical.version_table));
    let value_index = bounded_identifier(&format!(
        "{}_change_set_value_once_idx",
        physical.version_table
    ));
    let lifecycle_index = bounded_identifier(&format!(
        "{}_mainline_lifecycle_once_idx",
        physical.version_table
    ));
    let draft_index = bounded_identifier(&format!("{}_draft_idx", physical.version_table));
    for (name, sql) in [
        (
            external_key_index.clone(),
            format!("create unique index if not exists {} on {record_table} (app_id, customer_id, external_key) where external_key is not null", quote_identifier(&external_key_index)),
        ),
        (
            lookup_index.clone(),
            format!("create index if not exists {} on {version_table} (record_id, stage, effective_start desc)", quote_identifier(&lookup_index)),
        ),
        (
            source_ref_index.clone(),
            format!("create index if not exists {} on {version_table} (app_id, customer_id, (provenance->>'source_record_ref')) where provenance ? 'source_record_ref'", quote_identifier(&source_ref_index)),
        ),
        (
            change_set_index.clone(),
            format!("create index if not exists {} on {version_table} (change_set_id)", quote_identifier(&change_set_index)),
        ),
        (
            value_index.clone(),
            format!("create unique index if not exists {} on {version_table} (record_id, effective_start, change_set_id) where not tombstones_record and not untombstones_record", quote_identifier(&value_index)),
        ),
        (
            lifecycle_index.clone(),
            format!("create unique index if not exists {} on {version_table} (record_id, effective_start, tombstones_record, untombstones_record) where stage = 'mainline' and (tombstones_record or untombstones_record)", quote_identifier(&lifecycle_index)),
        ),
        (
            draft_index.clone(),
            format!("create index if not exists {} on {version_table} (app_id, customer_id, record_id, effective_start desc) where stage = 'draft'", quote_identifier(&draft_index)),
        ),
    ] {
        push_artifact(artifacts, SqlArtifactKind::Index, name, sql);
    }
    push_policy(artifacts, &physical.record_table, true);
    push_policy(artifacts, &physical.version_table, true);
    Ok(())
}

fn constraint_artifacts(
    artifacts: &mut Vec<SqlArtifact>,
    compiled: &CompiledManifest,
    physical_models: &BTreeMap<ModelId, PhysicalModel>,
) -> Result<Vec<ConstraintCatalogEntry>, SqlCompileError> {
    let models = compiled
        .schema
        .models
        .iter()
        .map(|model| (model.id.as_str(), model))
        .collect::<BTreeMap<_, _>>();
    let mut artifact_names = BTreeSet::new();
    let mut identities = Vec::new();

    for constraint in &compiled.extras.constraints {
        if constraint.authority == ConstraintAuthority::Advisory {
            continue;
        }
        let constraint_path = format!("constraints.{}", constraint.id);
        let model = models.get(constraint.model.as_str()).ok_or_else(|| {
            SqlCompileError::new(
                "unknown_constraint_model",
                format!("{constraint_path}.model"),
                format!("model `{}` is not declared", constraint.model),
            )
        })?;
        if let ConstraintExpr::NonOverlappingIntervals {
            start,
            end,
            subjects,
        } = &constraint.expression
        {
            if model.kind != ModelKind::Entity {
                return Err(SqlCompileError::new(
                    "unsupported_interval_constraint_model",
                    format!("{constraint_path}.model"),
                    "non_overlapping_intervals is supported only on entity models",
                ));
            }
            for field_id in constraint_expression_field_ids(&constraint.expression) {
                constraint_single_column(
                    constraint_field(model, &field_id, &format!("{constraint_path}.expression"))?,
                    &format!("{constraint_path}.expression"),
                )?;
            }
            identities.push(ConstraintCatalogEntry::IntervalExclusion(
                IntervalExclusionIdentity {
                    kind: "non_overlapping_intervals",
                    model_id: model.id.to_string(),
                    constraint_id: constraint.id.clone(),
                    label: constraint.label.clone(),
                    start_field_id: start.clone(),
                    end_field_id: end.clone(),
                    subject_field_ids: subjects.clone(),
                    field_ids: constraint_expression_field_ids(&constraint.expression),
                },
            ));
            continue;
        }
        let identity = authoritative_constraint_identity(constraint, model, physical_models)?;
        let artifact_name = format!("{}.{}", identity.table_name, identity.constraint_name);
        if !artifact_names.insert(artifact_name.clone())
            || artifacts.iter().any(|artifact| {
                artifact.kind == SqlArtifactKind::CheckConstraint && artifact.name == artifact_name
            })
        {
            return Err(SqlCompileError::new(
                "physical_identifier_collision",
                format!("{constraint_path}.id"),
                format!(
                    "constraint `{}` maps to duplicate physical artifact `{artifact_name}`",
                    constraint.id
                ),
            ));
        }
        let expression = if model.kind == ModelKind::Lookup {
            constraint_expression_json_sql(
                &constraint.expression,
                model,
                &format!("{constraint_path}.expression"),
            )?
        } else {
            constraint_expression_sql(
                &constraint.expression,
                model,
                &format!("{constraint_path}.expression"),
            )?
        };
        let model_guard = if model.kind == ModelKind::Lookup {
            format!("model_id <> {} or ", quote_literal(model.id.as_str()))
        } else {
            String::new()
        };
        push_check(
            artifacts,
            &identity.table_name,
            &identity.constraint_name,
            &format!(
                "{model_guard}tombstones_record or untombstones_record or (({expression}) is true)"
            ),
        );
        identities.push(ConstraintCatalogEntry::Check(identity));
    }
    push_constraint_identity_catalog(artifacts, compiled, &identities);
    Ok(identities)
}

fn push_constraint_identity_catalog(
    artifacts: &mut Vec<SqlArtifact>,
    compiled: &CompiledManifest,
    identities: &[ConstraintCatalogEntry],
) {
    let app_id = quote_literal(compiled.schema.app_id.as_str());
    let customer_id = quote_literal(compiled.schema.customer_id.as_str());
    let version = quote_literal(compiled.schema.version.as_str());
    let catalog = quote_literal(&serde_json::to_string(identities).expect("identities serialize"));
    // A logical release cannot silently change its diagnostic identities. A
    // new version inserts a separate catalog and never relabels active data.
    let sql = format!(
        "do $kernel$ begin\n\
         perform set_config('kernel.app_id', {app_id}, true);\n\
         perform set_config('kernel.customer_id', {customer_id}, true);\n\
         insert into schema_constraint_identity_source (app_id, schema_version, catalog) \
         values ({app_id}, {version}, {catalog}::jsonb) on conflict do nothing;\n\
         if not exists (select 1 from schema_constraint_identity_source where \
         app_id = {app_id} and schema_version = {version} \
         and catalog = {catalog}::jsonb) then\n\
         raise exception using errcode = 'P0001', message = 'schema constraint catalog drift';\n\
         end if; end $kernel$"
    );
    push_artifact(
        artifacts,
        SqlArtifactKind::ConstraintCatalog,
        format!(
            "kernel_constraint_identity_catalog.{}.{}",
            compiled.schema.app_id, compiled.schema.version
        ),
        sql,
    );
}

fn authorization_policy_catalog(
    compiled: &CompiledManifest,
) -> Option<SqlAuthorizationPolicyCatalog> {
    let policy = compiled.extras.authorization_policy.as_ref()?;
    let policy = serde_json::to_value(policy).expect("authorization policy serializes");
    let sha256 = hex_digest(&Sha256::digest(canonical_json(&policy).as_bytes()));
    Some(SqlAuthorizationPolicyCatalog { policy, sha256 })
}

fn authorization_policy_artifacts(artifacts: &mut Vec<SqlArtifact>, compiled: &CompiledManifest) {
    let app_id = quote_literal(compiled.schema.app_id.as_str());
    let version = quote_literal(compiled.schema.version.as_str());
    let (policy_declared, policy_hash, source_sql) = match compiled
        .extras
        .authorization_policy
        .as_ref()
    {
        Some(policy) => {
            let policy = serde_json::to_string(policy).expect("authorization policy serializes");
            let policy_hash = authorization_policy_catalog(compiled)
                .expect("authorization policy exists")
                .sha256;
            let quoted_policy = quote_literal(&policy);
            let quoted_hash = quote_literal(&policy_hash);
            let source_sql = format!(
                "insert into schema_authorization_policy_source (app_id, schema_version, policy, policy_hash) values ({app_id}, {version}, {quoted_policy}::jsonb, {quoted_hash}) on conflict do nothing;\n\
                 if not exists (select 1 from schema_authorization_policy_source where app_id = {app_id} and schema_version = {version} and policy = {quoted_policy}::jsonb and policy_hash = {quoted_hash}) then\n\
                 raise exception using errcode = 'P0001', message = 'schema authorization policy source drift';\n\
                 end if;"
            );
            ("true", quoted_hash, source_sql)
        }
        None => ("false", "null".to_string(), String::new()),
    };
    let sql = format!(
        "do $kernel$ begin\n\
         perform set_config('kernel.app_id', {app_id}, true);\n\
         {source_sql}\n\
         insert into schema_authorization_policy_expectation (app_id, schema_version, policy_declared, policy_hash) values ({app_id}, {version}, {policy_declared}, {policy_hash}) on conflict do nothing;\n\
         if not exists (select 1 from schema_authorization_policy_expectation where app_id = {app_id} and schema_version = {version} and policy_declared = {policy_declared} and policy_hash is not distinct from {policy_hash}) then\n\
         raise exception using errcode = 'P0001', message = 'schema authorization policy expectation drift';\n\
         end if; end $kernel$"
    );
    push_artifact(
        artifacts,
        SqlArtifactKind::AuthorizationPolicyCatalog,
        format!(
            "kernel_authorization_policy_catalog.{}.{}",
            compiled.schema.app_id, compiled.schema.version
        ),
        sql,
    );
}

fn runtime_function_artifacts(
    artifacts: &mut Vec<SqlArtifact>,
    compiled: &CompiledManifest,
) -> Result<(), SqlCompileError> {
    push_runtime_function_artifact(
        artifacts,
        "kernel_read_active_schema_revision(jsonb)",
        KERNEL_READ_ACTIVE_SCHEMA_REVISION_FUNCTION,
    )?;
    push_runtime_function_artifact(
        artifacts,
        "kernel_preflight_schema_materialization(jsonb)",
        KERNEL_PREFLIGHT_SCHEMA_MATERIALIZATION_FUNCTION,
    )?;
    for function in crate::sql_runtime::functions() {
        push_runtime_function_artifact(artifacts, function.signature, function.sql)?;
    }

    let schema_json = serde_json::to_string(&compiled.schema).map_err(|error| {
        SqlCompileError::new(
            "sql_manifest_serialization_failed",
            "schema",
            error.to_string(),
        )
    })?;
    push_artifact(
        artifacts,
        SqlArtifactKind::Function,
        format!(
            "kernel_materialization_preflight.{}.{}",
            compiled.schema.app_id, compiled.schema.customer_id
        ),
        materialization_preflight_sql(&schema_json),
    );
    push_artifact(
        artifacts,
        SqlArtifactKind::Function,
        format!(
            "kernel_retired_field_artifact_reconciliation.{}.{}",
            compiled.schema.app_id, compiled.schema.customer_id
        ),
        retired_field_artifact_reconciliation_sql(&schema_json),
    );
    push_artifact(
        artifacts,
        SqlArtifactKind::Function,
        "kernel_runtime_privilege_installation",
        crate::sql_runtime::installer_privilege_installation_sql(),
    );
    Ok(())
}

fn push_runtime_function_artifact(
    artifacts: &mut Vec<SqlArtifact>,
    signature: impl Into<String>,
    sql: impl Into<String>,
) -> Result<(), SqlCompileError> {
    let signature = signature.into();
    let sql = inject_runtime_boundary_cleanup(&signature, sql.into())?;
    push_artifact(artifacts, SqlArtifactKind::Function, signature, sql);
    Ok(())
}

fn inject_runtime_boundary_cleanup(
    signature: &str,
    sql: String,
) -> Result<String, SqlCompileError> {
    if !is_runtime_boundary(signature) {
        return Ok(sql);
    }
    let function_name = signature
        .split_once('(')
        .map_or(signature, |(name, _)| name);
    let declaration = format!("create or replace function {function_name}(");
    let declaration_offset = sql.rfind(&declaration).ok_or_else(|| {
        SqlCompileError::new(
            "runtime_boundary_declaration_missing",
            format!("runtime.{signature}"),
            "generated runtime entrypoint declaration is missing",
        )
    })?;
    let Some(body_offset) = sql[declaration_offset..]
        .find("\nbegin\n")
        .map(|offset| declaration_offset + offset)
    else {
        return inject_sql_runtime_boundary_cleanup(signature, declaration_offset, sql);
    };
    let insertion_offset = body_offset + "\nbegin\n".len();
    let mut guarded = String::with_capacity(sql.len() + 44);
    guarded.push_str(&sql[..insertion_offset]);
    guarded.push_str("  perform kernel_cleanup_generated_visible_query();\n");
    guarded.push_str(&sql[insertion_offset..]);
    Ok(guarded)
}

fn inject_sql_runtime_boundary_cleanup(
    signature: &str,
    declaration_offset: usize,
    sql: String,
) -> Result<String, SqlCompileError> {
    let language_offset = sql[declaration_offset..]
        .find("\nlanguage sql\n")
        .map(|offset| declaration_offset + offset)
        .ok_or_else(|| runtime_boundary_body_error(signature))?;
    let body_marker = "\nas $kernel$\n";
    let body_start = sql[language_offset..]
        .find(body_marker)
        .map(|offset| language_offset + offset + body_marker.len())
        .ok_or_else(|| runtime_boundary_body_error(signature))?;
    let body_end = sql[body_start..]
        .find("\n$kernel$;")
        .map(|offset| body_start + offset)
        .ok_or_else(|| runtime_boundary_body_error(signature))?;
    let expression = sql[body_start..body_end]
        .trim()
        .strip_prefix("select ")
        .and_then(|value| value.strip_suffix(';').or(Some(value)))
        .ok_or_else(|| runtime_boundary_body_error(signature))?;

    let mut guarded = String::with_capacity(sql.len() + 72);
    guarded.push_str(&sql[..language_offset]);
    guarded.push_str("\nlanguage plpgsql\n");
    guarded.push_str(&sql[language_offset + "\nlanguage sql\n".len()..body_start]);
    guarded.push_str("begin\n  perform kernel_cleanup_generated_visible_query();\n  return ");
    guarded.push_str(expression);
    guarded.push_str(";\nend;");
    guarded.push_str(&sql[body_end..]);
    Ok(guarded)
}

fn runtime_boundary_body_error(signature: &str) -> SqlCompileError {
    SqlCompileError::new(
        "runtime_boundary_body_missing",
        format!("runtime.{signature}"),
        "generated runtime entrypoint must have a PL/pgSQL body or a scalar SQL SELECT wrapper",
    )
}

fn is_runtime_boundary(signature: &str) -> bool {
    matches!(
        signature,
        "kernel_apply_change_set(jsonb)"
            | "kernel_resolve_source_identities(jsonb)"
            | "kernel_apply_change_set_in_transaction(jsonb)"
            | "kernel_validate_change_set_dry_run(jsonb)"
            | "kernel_validate_change_sets_dry_run(jsonb)"
            | "kernel_apply_seed_defaults(jsonb)"
            | "kernel_list_draft_change_sets(jsonb)"
            | "kernel_read_draft_change_set(jsonb)"
            | "kernel_update_draft_notes(jsonb)"
            | "kernel_discard_draft_change_set(jsonb)"
            | "kernel_approve_draft_change_set(jsonb)"
            | "kernel_draft_threads(jsonb)"
            | "kernel_revert_change_set(jsonb)"
            | "kernel_read_active_schema_revision(jsonb)"
            | "kernel_read_visible_records(jsonb)"
            | "kernel_read_visible_record(jsonb)"
            | "kernel_read_visible_records_by_text_fields(jsonb)"
            | "kernel_read_visible_record_for_update(jsonb)"
            | "kernel_read_visible_records_by_model(jsonb)"
            | "kernel_data_query(jsonb)"
            | "kernel_work_session(jsonb)"
            | "kernel_query_visible_sql(jsonb)"
            | "kernel_prepare_visible_query(jsonb)"
            | "kernel_change_set_diff(jsonb)"
            | "kernel_field_history(jsonb)"
            | "kernel_recent_activity(jsonb)"
            | "kernel_lookup_list(jsonb)"
            | "kernel_lookup_resolve_batch(jsonb)"
            | "kernel_lookup_hydrate(jsonb)"
            | "kernel_lookup_reference_count(jsonb)"
            | "kernel_lookup_set_availability(jsonb)"
            | "kernel_lookup_transfer_alias(jsonb)"
            | "kernel_record_agent_run(jsonb)"
            | "kernel_update_agent_run_status(jsonb)"
            | "kernel_schema_revision_is_active_with_materialized_tables(jsonb)"
            | "kernel_dry_run_tenant_schema_revision(jsonb)"
            | "kernel_commit_tenant_schema_revision(jsonb)"
            | "kernel_preflight_schema_materialization(jsonb)"
    )
}

const KERNEL_PREFLIGHT_SCHEMA_MATERIALIZATION_FUNCTION: &str = r#"
create or replace function kernel_preflight_schema_materialization(request jsonb)
returns jsonb
language plpgsql
volatile
parallel unsafe
security invoker
set search_path from current
as $kernel$
declare
  proposed_schema jsonb := case when request ? 'schema' then request->'schema' else request end;
  proposed_app_id text := proposed_schema->>'app_id';
  proposed_customer_id text := proposed_schema->>'customer_id';
  sibling record;
  proposed_model jsonb;
  sibling_model jsonb;
  proposed_field jsonb;
  sibling_field jsonb;
  proposed_required text[];
  sibling_required text[];
  proposed_unique text[];
  sibling_unique text[];
  mismatch text;
  previous_catalog_read text := current_setting('kernel.schema_catalog_read', true);
begin
  if jsonb_typeof(proposed_schema) is distinct from 'object'
     or coalesce(proposed_app_id, '') = ''
     or coalesce(proposed_customer_id, '') = ''
     or jsonb_typeof(proposed_schema->'models') is distinct from 'array' then
    return jsonb_build_object(
      'ok', false,
      'error', jsonb_build_object(
        'code', 'contract_validation_failed',
        'message', 'Contract validation failed',
        'details', jsonb_build_array(jsonb_build_object(
          'path', 'schema',
          'code', 'invalid_materialization_preflight',
          'message', 'schema identity and models are required'
        ))
      )
    );
  end if;

  perform set_config('kernel.schema_catalog_read', 'on', true);
  for sibling in
    select app_id, customer_id, schema
    from schema_revision
    where activated_at is not null
      and not (app_id = proposed_app_id and customer_id = proposed_customer_id)
    order by app_id, customer_id
  loop
    for proposed_model in
      select value from jsonb_array_elements(proposed_schema->'models')
    loop
      select value
      into sibling_model
      from jsonb_array_elements(coalesce(sibling.schema->'models', '[]'::jsonb))
      where value->>'id' = proposed_model->>'id'
      limit 1;
      if not found then
        continue;
      end if;

      for proposed_field in
        select value from jsonb_array_elements(coalesce(proposed_model->'fields', '[]'::jsonb))
      loop
        select value
        into sibling_field
        from jsonb_array_elements(coalesce(sibling_model->'fields', '[]'::jsonb))
        where value->>'id' = proposed_field->>'id'
        limit 1;
        if found and (
          sibling_field->>'type' is distinct from proposed_field->>'type'
          or sibling_field->>'target_model' is distinct from proposed_field->>'target_model'
        ) then
          mismatch := format(
            'column %L has a different physical contract',
            proposed_field->>'id'
          );
          perform set_config(
            'kernel.schema_catalog_read',
            coalesce(previous_catalog_read, ''),
            true
          );
          return jsonb_build_object(
            'ok', false,
            'error', jsonb_build_object(
              'code', 'schema_drift',
              'message', 'Schema drift detected',
              'details', jsonb_build_array(jsonb_build_object(
                'path', 'object',
                'code', 'schema_drift',
                'message', proposed_model->>'id' || '_version: ' || mismatch || '; active sibling scope=' || sibling.app_id || '/' || sibling.customer_id || '; coordinated schema migration required because sequential materialization cannot change required, unique, or physical column contracts across active sibling tenants'
              ))
            )
          );
        end if;
      end loop;

      select coalesce(array_agg(value->>'id' order by value->>'id'), array[]::text[])
      into proposed_required
      from jsonb_array_elements(coalesce(proposed_model->'fields', '[]'::jsonb))
      where coalesce((value->>'required')::boolean, false);
      select coalesce(array_agg(value->>'id' order by value->>'id'), array[]::text[])
      into sibling_required
      from jsonb_array_elements(coalesce(sibling_model->'fields', '[]'::jsonb))
      where coalesce((value->>'required')::boolean, false);
      if proposed_required is distinct from sibling_required then
        mismatch := format(
          'required columns differ (proposed=%s, active=%s)',
          proposed_required,
          sibling_required
        );
        perform set_config(
          'kernel.schema_catalog_read',
          coalesce(previous_catalog_read, ''),
          true
        );
        return jsonb_build_object(
          'ok', false,
          'error', jsonb_build_object(
            'code', 'schema_drift',
            'message', 'Schema drift detected',
            'details', jsonb_build_array(jsonb_build_object(
              'path', 'object',
              'code', 'schema_drift',
              'message', proposed_model->>'id' || '_version: ' || mismatch || '; active sibling scope=' || sibling.app_id || '/' || sibling.customer_id || '; coordinated schema migration required because sequential materialization cannot change required, unique, or physical column contracts across active sibling tenants'
            ))
          )
        );
      end if;

      select coalesce(array_agg(value->>'id' order by value->>'id'), array[]::text[])
      into proposed_unique
      from jsonb_array_elements(coalesce(proposed_model->'fields', '[]'::jsonb))
      where coalesce((value->>'is_unique')::boolean, false);
      select coalesce(array_agg(value->>'id' order by value->>'id'), array[]::text[])
      into sibling_unique
      from jsonb_array_elements(coalesce(sibling_model->'fields', '[]'::jsonb))
      where coalesce((value->>'is_unique')::boolean, false);
      if proposed_unique is distinct from sibling_unique then
        mismatch := format(
          'unique columns differ (proposed=%s, active=%s)',
          proposed_unique,
          sibling_unique
        );
        perform set_config(
          'kernel.schema_catalog_read',
          coalesce(previous_catalog_read, ''),
          true
        );
        return jsonb_build_object(
          'ok', false,
          'error', jsonb_build_object(
            'code', 'schema_drift',
            'message', 'Schema drift detected',
            'details', jsonb_build_array(jsonb_build_object(
              'path', 'object',
              'code', 'schema_drift',
              'message', proposed_model->>'id' || '_version: ' || mismatch || '; active sibling scope=' || sibling.app_id || '/' || sibling.customer_id || '; coordinated schema migration required because sequential materialization cannot change required, unique, or physical column contracts across active sibling tenants'
            ))
          )
        );
      end if;
    end loop;
  end loop;

  perform set_config(
    'kernel.schema_catalog_read',
    coalesce(previous_catalog_read, ''),
    true
  );
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('compatible', true));
end
$kernel$;
"#;

fn materialization_preflight_sql(schema_json: &str) -> String {
    format!(
        "do $kernel$\ndeclare\n  result jsonb;\nbegin\n  result := kernel_preflight_schema_materialization({}::jsonb);\n  if not coalesce((result->>'ok')::boolean, false) then\n    raise exception using\n      errcode = 'P0001',\n      message = coalesce(result->'error'->>'message', 'Schema materialization preflight failed'),\n      detail = coalesce(result->'error'->'details'->0->>'message', result->'error'->>'code', 'schema_drift');\n  end if;\nend\n$kernel$",
        quote_literal(schema_json)
    )
}

fn retired_field_artifact_reconciliation_sql(schema_json: &str) -> String {
    format!(
        r#"do $kernel$
declare
  proposed_schema jsonb := {schema_json}::jsonb;
  candidate record;
  still_declared boolean;
begin
  perform set_config('kernel.schema_catalog_read', 'on', true);

  for candidate in
    select relation.relname as table_name, constraint_value.conname as object_name
    from pg_constraint as constraint_value
    join pg_class as relation on relation.oid = constraint_value.conrelid
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = current_schema()
      and relation.relname like '%\_version' escape '\'
      and constraint_value.contype = 'c'
      and constraint_value.conname like '%\_required\_check' escape '\'
  loop
    select exists (
      select 1
      from (
        select proposed_schema as schema_json
        union all
        select schema
        from schema_revision
        where activated_at is not null
          and not (
            app_id = proposed_schema->>'app_id'
            and customer_id = proposed_schema->>'customer_id'
          )
      ) as declared_schema
      cross join lateral jsonb_array_elements(coalesce(declared_schema.schema_json->'models', '[]'::jsonb)) as model(value)
      cross join lateral jsonb_array_elements(coalesce(model.value->'fields', '[]'::jsonb)) as field(value)
      cross join lateral unnest(
        case when field.value->>'type' = 'money_rate'
          then array[
            field.value->>'id' || '_amount',
            field.value->>'id' || '_currency',
            field.value->>'id' || '_period'
          ]
          else array[field.value->>'id']
        end
      ) as physical_column(name)
      where coalesce((field.value->>'required')::boolean, false)
        and (
          (coalesce(model.value->>'kind', 'entity') = 'entity'
            and kernel_physical_identifier(model.value->>'id' || '_version') = candidate.table_name
            and kernel_physical_identifier(candidate.table_name || '_' || kernel_physical_identifier(physical_column.name) || '_required_check') = candidate.object_name)
          or (model.value->>'kind' = 'lookup' and candidate.table_name = 'lookup_version'
            and kernel_physical_identifier('lookup_version_' || (model.value->>'id') || '_' || (field.value->>'id') || '_required_check') = candidate.object_name)
        )
    ) into still_declared;
    if not still_declared then
      execute format(
        'alter table %I.%I drop constraint %I',
        current_schema(), candidate.table_name, candidate.object_name
      );
    end if;
  end loop;

  for candidate in
    select index_relation.relname as object_name
    from pg_class as index_relation
    join pg_namespace as namespace on namespace.oid = index_relation.relnamespace
    where namespace.nspname = current_schema()
      and index_relation.relkind = 'i'
      and index_relation.relname like '%\_live\_unique\_idx' escape '\'
  loop
    select exists (
      select 1
      from (
        select proposed_schema as schema_json
        union all
        select schema
        from schema_revision
        where activated_at is not null
          and not (
            app_id = proposed_schema->>'app_id'
            and customer_id = proposed_schema->>'customer_id'
          )
      ) as declared_schema
      cross join lateral jsonb_array_elements(coalesce(declared_schema.schema_json->'models', '[]'::jsonb)) as model(value)
      cross join lateral jsonb_array_elements(coalesce(model.value->'fields', '[]'::jsonb)) as field(value)
      where coalesce((field.value->>'is_unique')::boolean, false)
        and kernel_physical_identifier(
          kernel_physical_identifier(model.value->>'id' || '_version') || '_' ||
          kernel_physical_identifier(field.value->>'id') || '_live_unique_idx'
        ) = candidate.object_name
    ) into still_declared;
    if not still_declared then
      execute format('drop index %I.%I', current_schema(), candidate.object_name);
    end if;
  end loop;
end
$kernel$"#,
        schema_json = quote_literal(schema_json),
    )
}

const KERNEL_READ_ACTIVE_SCHEMA_REVISION_FUNCTION: &str = r#"
create or replace function kernel_read_active_schema_revision(request jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path from current
as $kernel$
declare
  request_app_id text;
  request_customer_id text;
  active_revision_id bigint;
  active_schema jsonb;
  active_effective_hash text;
  authorization_result jsonb;
begin
  if request is null or jsonb_typeof(request) <> 'object' then
    return jsonb_build_object(
      'ok', false,
      'error', jsonb_build_object(
        'code', 'contract_validation_failed',
        'message', 'Contract validation failed',
        'details', jsonb_build_array(jsonb_build_object(
          'path', 'request',
          'code', 'invalid_request',
          'message', 'request must be a JSON object'
        ))
      )
    );
  end if;

  request_app_id := request->>'app_id';
  request_customer_id := request->>'customer_id';
  if request_app_id is null or btrim(request_app_id) = '' then
    return jsonb_build_object(
      'ok', false,
      'error', jsonb_build_object(
        'code', 'contract_validation_failed',
        'message', 'Contract validation failed',
        'details', jsonb_build_array(jsonb_build_object(
          'path', 'app_id',
          'code', 'required',
          'message', 'app_id is required'
        ))
      )
    );
  end if;
  if request_customer_id is null or btrim(request_customer_id) = '' then
    return jsonb_build_object(
      'ok', false,
      'error', jsonb_build_object(
        'code', 'contract_validation_failed',
        'message', 'Contract validation failed',
        'details', jsonb_build_array(jsonb_build_object(
          'path', 'customer_id',
          'code', 'required',
          'message', 'customer_id is required'
        ))
      )
    );
  end if;

  authorization_result := kernel_authorize_scope(
    'runtime', request_app_id, request_customer_id, null
  );
  if authorization_result is not null then
    return authorization_result;
  end if;

  perform set_config('kernel.app_id', request_app_id, true);
  perform set_config('kernel.customer_id', request_customer_id, true);

  -- The effective hash is the exact expression the tenant schema revision
  -- commit compares `expected_effective_hash` against.
  select sr.id, sr.schema,
         coalesce(sir.effective_artifact_hash, sr.schema_hash, kernel_admin_sha256(kernel_canonical_json(sr.schema)))
  into active_revision_id, active_schema, active_effective_hash
  from schema_revision sr
  left join schema_installation_revision sir on sir.schema_revision_id = sr.id
  where sr.app_id = request_app_id
    and sr.customer_id = request_customer_id
    and sr.activated_at is not null;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'error', jsonb_build_object(
        'code', 'active_schema_missing',
        'message', 'No active schema revision exists for this scope',
        'details', jsonb_build_array(jsonb_build_object(
          'path', 'scope',
          'code', 'active_schema_missing',
          'message', request_app_id || '/' || request_customer_id ||
            ': materialize a schema before applying or reading records'
        ))
      )
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'data', jsonb_build_object(
      'schema_revision_id', active_revision_id,
      'schema', active_schema,
      'effective_hash', active_effective_hash
    )
  );
exception
  when others then
    return jsonb_build_object(
      'ok', false,
      'error', jsonb_build_object(
        'code', 'database_error',
        'message', 'Database operation failed',
        'details', '[]'::jsonb
      )
    );
end;
$kernel$
"#;

fn constraint_expression_coverage(compiled: &CompiledManifest) -> SqlFeatureCoverage {
    let source_items = compiled
        .extras
        .constraints
        .iter()
        .map(|constraint| constraint.id.clone())
        .collect::<Vec<_>>();
    let implemented_items = compiled
        .extras
        .constraints
        .iter()
        .filter(|constraint| constraint.authority == ConstraintAuthority::Authoritative)
        .map(|constraint| constraint.id.clone())
        .collect::<Vec<_>>();
    let gaps = compiled
        .extras
        .constraints
        .iter()
        .filter(|constraint| constraint.authority == ConstraintAuthority::Advisory)
        .map(|constraint| {
            (
                constraint.id.clone(),
                "advisory constraint requires generated runtime evaluation and is not a persistence check"
                    .to_string(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let mut detail = if source_items.is_empty() {
        "no constraint expressions are declared".to_string()
    } else if gaps.is_empty() {
        "all authoritative constraint expressions are lowered to model-version CHECK artifacts"
            .to_string()
    } else {
        "authoritative constraint expressions are lowered to model-version CHECK artifacts; advisory constraints remain explicit generated-runtime evaluation gaps"
            .to_string()
    };
    if compiled.extras.constraints.iter().any(|constraint| {
        constraint.authority == ConstraintAuthority::Authoritative
            && matches!(
                constraint.expression,
                ConstraintExpr::NonOverlappingIntervals { .. }
            )
    }) {
        // Cross-record interval rules have no CHECK; only row expressions do.
        detail = detail.replacen(
            "constraint expressions are lowered",
            "row constraint expressions are lowered",
            1,
        );
        detail.push_str(
            "; authoritative cross-record non_overlapping_intervals rules have no CHECK and are enforced by generated mainline apply, draft approval, revert, installer readiness, and app-base and tenant-overlay activation",
        );
    }
    SqlFeatureCoverage {
        implemented: gaps.is_empty(),
        source_items,
        implemented_items,
        gaps,
        detail,
    }
}

fn constraint_expression_sql(
    expression: &ConstraintExpr,
    model: &Model,
    path: &str,
) -> Result<String, SqlCompileError> {
    match expression {
        ConstraintExpr::And { expressions } | ConstraintExpr::Or { expressions } => {
            if expressions.is_empty() {
                return Err(SqlCompileError::new(
                    "empty_boolean_expression",
                    path,
                    "boolean expressions must contain at least one expression",
                ));
            }
            let operator = if matches!(expression, ConstraintExpr::And { .. }) {
                " and "
            } else {
                " or "
            };
            let expressions = expressions
                .iter()
                .enumerate()
                .map(|(index, expression)| {
                    constraint_expression_sql(
                        expression,
                        model,
                        &format!("{path}.expressions[{index}]"),
                    )
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(format!("({})", expressions.join(operator)))
        }
        ConstraintExpr::Not { expression } => Ok(format!(
            "(not ({}))",
            constraint_expression_sql(expression, model, &format!("{path}.expression"))?
        )),
        ConstraintExpr::FieldPresent { field } => {
            let field = constraint_field(model, field, &format!("{path}.field"))?;
            Ok(presence_sql(&field_columns(field)?, true))
        }
        ConstraintExpr::FieldAbsent { field } => {
            let field = constraint_field(model, field, &format!("{path}.field"))?;
            Ok(presence_sql(&field_columns(field)?, false))
        }
        ConstraintExpr::CountPresent { fields, min, max } => {
            if fields.is_empty() {
                return Err(SqlCompileError::new(
                    "empty_field_set",
                    format!("{path}.fields"),
                    "count_present must name at least one field",
                ));
            }
            if min.is_none() && max.is_none() {
                return Err(SqlCompileError::new(
                    "missing_count_bound",
                    path,
                    "count_present must declare min, max, or both",
                ));
            }
            if min
                .zip(*max)
                .is_some_and(|(minimum, maximum)| minimum > maximum)
            {
                return Err(SqlCompileError::new(
                    "invalid_count_range",
                    path,
                    "count_present min cannot exceed max",
                ));
            }
            if min.is_some_and(|bound| bound as usize > fields.len())
                || max.is_some_and(|bound| bound as usize > fields.len())
            {
                return Err(SqlCompileError::new(
                    "invalid_count_bound",
                    path,
                    "count_present bounds cannot exceed the number of fields",
                ));
            }
            let mut seen = BTreeSet::new();
            let terms = fields
                .iter()
                .enumerate()
                .map(|(index, field_id)| {
                    if !seen.insert(field_id.as_str()) {
                        return Err(SqlCompileError::new(
                            "duplicate_count_field",
                            format!("{path}.fields[{index}]"),
                            format!("field `{field_id}` is named more than once"),
                        ));
                    }
                    let field =
                        constraint_field(model, field_id, &format!("{path}.fields[{index}]"))?;
                    Ok(format!(
                        "case when {} then 1 else 0 end",
                        presence_sql(&field_columns(field)?, true)
                    ))
                })
                .collect::<Result<Vec<_>, _>>()?;
            let count = terms.join(" + ");
            let bounds = [
                min.map(|minimum| format!("(({count}) >= {minimum})")),
                max.map(|maximum| format!("(({count}) <= {maximum})")),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
            Ok(format!("({})", bounds.join(" and ")))
        }
        ConstraintExpr::CompareFields { left, op, right } => {
            let left_field = constraint_field(model, left, &format!("{path}.left"))?;
            let right_field = constraint_field(model, right, &format!("{path}.right"))?;
            if left_field.field_type != right_field.field_type {
                return Err(SqlCompileError::new(
                    "constraint_type_mismatch",
                    path,
                    format!(
                        "cannot compare fields `{left}` ({:?}) and `{right}` ({:?})",
                        left_field.field_type, right_field.field_type
                    ),
                ));
            }
            ensure_comparison_supported(left_field, *op, path)?;
            let left = constraint_single_column(left_field, &format!("{path}.left"))?;
            let right = constraint_single_column(right_field, &format!("{path}.right"))?;
            Ok(format!(
                "({} {} {})",
                quote_identifier(&left.name),
                comparison_sql(*op),
                quote_identifier(&right.name)
            ))
        }
        ConstraintExpr::CompareLiteral { field, op, value } => {
            let field = constraint_field(model, field, &format!("{path}.field"))?;
            ensure_comparison_supported(field, *op, path)?;
            let column = constraint_single_column(field, &format!("{path}.field"))?;
            let literal = typed_literal_sql(value, field, &format!("{path}.value"))?;
            Ok(format!(
                "({} {} {literal})",
                quote_identifier(&column.name),
                comparison_sql(*op)
            ))
        }
        ConstraintExpr::FieldIn { field, values } => {
            if values.is_empty() {
                return Err(SqlCompileError::new(
                    "empty_constraint_literal_set",
                    format!("{path}.values"),
                    "field_in must contain at least one literal",
                ));
            }
            let field = constraint_field(model, field, &format!("{path}.field"))?;
            ensure_equality_comparable(field, path)?;
            let column = constraint_single_column(field, &format!("{path}.field"))?;
            let values = values
                .iter()
                .enumerate()
                .map(|(index, value)| {
                    typed_literal_sql(value, field, &format!("{path}.values[{index}]"))
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(format!(
                "({} in ({}))",
                quote_identifier(&column.name),
                values.join(", ")
            ))
        }
        ConstraintExpr::FieldSetContains { field, value } => {
            let field = constraint_field(model, field, &format!("{path}.field"))?;
            if !matches!(
                field.field_type,
                FieldType::TextList | FieldType::KnownAliases
            ) {
                return Err(SqlCompileError::new(
                    "unsupported_constraint_field_type",
                    format!("{path}.field"),
                    format!(
                        "field_set_contains requires text_list or known_aliases, got `{:?}`",
                        field.field_type
                    ),
                ));
            }
            let column = constraint_single_column(field, &format!("{path}.field"))?;
            Ok(format!(
                "({}::text = any ({}))",
                quote_literal(value),
                quote_identifier(&column.name)
            ))
        }
        ConstraintExpr::TextLength { field, min, max } => {
            let field = constraint_field(model, field, &format!("{path}.field"))?;
            if field.field_type != FieldType::Text {
                return Err(SqlCompileError::new(
                    "unsupported_constraint_field_type",
                    format!("{path}.field"),
                    format!("text_length requires text, got `{:?}`", field.field_type),
                ));
            }
            if min.is_none() && max.is_none() {
                return Err(SqlCompileError::new(
                    "missing_text_length_bound",
                    path,
                    "text_length must declare min, max, or both",
                ));
            }
            if min
                .zip(*max)
                .is_some_and(|(minimum, maximum)| minimum > maximum)
            {
                return Err(SqlCompileError::new(
                    "invalid_text_length_range",
                    path,
                    "text_length min cannot exceed max",
                ));
            }
            let column = constraint_single_column(field, &format!("{path}.field"))?;
            let length = format!("char_length({})::numeric", quote_identifier(&column.name));
            let bounds = [
                min.map(|minimum| format!("({length} >= {minimum})")),
                max.map(|maximum| format!("({length} <= {maximum})")),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
            Ok(format!("({})", bounds.join(" and ")))
        }
        ConstraintExpr::TextStartsWith { field, value } => {
            let field = constraint_field(model, field, &format!("{path}.field"))?;
            if field.field_type != FieldType::Text || value.is_empty() {
                return Err(SqlCompileError::new(
                    "invalid_text_prefix",
                    path,
                    "text_starts_with requires a text field and a non-empty literal prefix",
                ));
            }
            let column = constraint_single_column(field, &format!("{path}.field"))?;
            Ok(text_starts_with_sql(&quote_identifier(&column.name), value))
        }
        ConstraintExpr::NonOverlappingIntervals { .. } => Err(non_row_constraint_error(path)),
    }
}

fn non_row_constraint_error(path: &str) -> SqlCompileError {
    SqlCompileError::new(
        "non_root_interval_constraint",
        path,
        "non_overlapping_intervals is a cross-record rule and cannot lower to a row expression",
    )
}

fn constraint_expression_json_sql(
    expression: &ConstraintExpr,
    model: &Model,
    path: &str,
) -> Result<String, SqlCompileError> {
    match expression {
        ConstraintExpr::And { expressions } | ConstraintExpr::Or { expressions } => {
            if expressions.is_empty() {
                return Err(SqlCompileError::new(
                    "empty_boolean_expression",
                    path,
                    "boolean expressions must contain at least one expression",
                ));
            }
            let operator = if matches!(expression, ConstraintExpr::And { .. }) {
                " and "
            } else {
                " or "
            };
            Ok(format!(
                "({})",
                expressions
                    .iter()
                    .enumerate()
                    .map(|(index, nested)| constraint_expression_json_sql(
                        nested,
                        model,
                        &format!("{path}.expressions[{index}]")
                    ))
                    .collect::<Result<Vec<_>, _>>()?
                    .join(operator)
            ))
        }
        ConstraintExpr::Not { expression } => Ok(format!(
            "(not ({}))",
            constraint_expression_json_sql(expression, model, &format!("{path}.expression"))?
        )),
        ConstraintExpr::FieldPresent { field } => {
            constraint_field(model, field, &format!("{path}.field"))?;
            Ok(format!("values ? {}", quote_literal(field.as_str())))
        }
        ConstraintExpr::FieldAbsent { field } => {
            constraint_field(model, field, &format!("{path}.field"))?;
            Ok(format!("not (values ? {})", quote_literal(field.as_str())))
        }
        ConstraintExpr::CountPresent { fields, min, max } => {
            if fields.is_empty() {
                return Err(SqlCompileError::new(
                    "empty_field_set",
                    format!("{path}.fields"),
                    "count_present must name at least one field",
                ));
            }
            if min.is_none() && max.is_none() {
                return Err(SqlCompileError::new(
                    "missing_count_bound",
                    path,
                    "count_present must declare min, max, or both",
                ));
            }
            if min
                .zip(*max)
                .is_some_and(|(minimum, maximum)| minimum > maximum)
            {
                return Err(SqlCompileError::new(
                    "invalid_count_range",
                    path,
                    "count_present min cannot exceed max",
                ));
            }
            if min.is_some_and(|bound| bound as usize > fields.len())
                || max.is_some_and(|bound| bound as usize > fields.len())
            {
                return Err(SqlCompileError::new(
                    "invalid_count_bound",
                    path,
                    "count_present bounds cannot exceed the number of fields",
                ));
            }
            let mut seen = BTreeSet::new();
            let terms = fields
                .iter()
                .enumerate()
                .map(|(index, field)| {
                    if !seen.insert(field.as_str()) {
                        return Err(SqlCompileError::new(
                            "duplicate_count_field",
                            format!("{path}.fields[{index}]"),
                            format!("field `{field}` is named more than once"),
                        ));
                    }
                    constraint_field(model, field, &format!("{path}.fields[{index}]"))?;
                    Ok(format!(
                        "case when values ? {} then 1 else 0 end",
                        quote_literal(field.as_str())
                    ))
                })
                .collect::<Result<Vec<_>, _>>()?;
            let count = terms.join(" + ");
            let bounds = [
                min.map(|minimum| format!("(({count}) >= {minimum})")),
                max.map(|maximum| format!("(({count}) <= {maximum})")),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
            Ok(format!("({})", bounds.join(" and ")))
        }
        ConstraintExpr::CompareFields { left, op, right } => {
            let left_field = constraint_field(model, left, &format!("{path}.left"))?;
            let right_field = constraint_field(model, right, &format!("{path}.right"))?;
            if left_field.field_type != right_field.field_type {
                return Err(SqlCompileError::new(
                    "constraint_type_mismatch",
                    path,
                    format!(
                        "cannot compare fields `{left}` ({:?}) and `{right}` ({:?})",
                        left_field.field_type, right_field.field_type
                    ),
                ));
            }
            ensure_comparison_supported(left_field, *op, path)?;
            Ok(format!(
                "({} {} {})",
                lookup_json_field_sql(left_field),
                comparison_sql(*op),
                lookup_json_field_sql(right_field)
            ))
        }
        ConstraintExpr::CompareLiteral { field, op, value } => {
            let field = constraint_field(model, field, &format!("{path}.field"))?;
            ensure_comparison_supported(field, *op, path)?;
            Ok(format!(
                "({} {} {})",
                lookup_json_field_sql(field),
                comparison_sql(*op),
                typed_literal_sql(value, field, &format!("{path}.value"))?
            ))
        }
        ConstraintExpr::FieldIn { field, values } => {
            if values.is_empty() {
                return Err(SqlCompileError::new(
                    "empty_constraint_literal_set",
                    format!("{path}.values"),
                    "field_in must contain at least one literal",
                ));
            }
            let field = constraint_field(model, field, &format!("{path}.field"))?;
            ensure_equality_comparable(field, path)?;
            let values = values
                .iter()
                .enumerate()
                .map(|(index, value)| {
                    typed_literal_sql(value, field, &format!("{path}.values[{index}]"))
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(format!(
                "({} in ({}))",
                lookup_json_field_sql(field),
                values.join(", ")
            ))
        }
        ConstraintExpr::FieldSetContains { field, value } => {
            let field = constraint_field(model, field, &format!("{path}.field"))?;
            if !matches!(
                field.field_type,
                FieldType::TextList | FieldType::KnownAliases
            ) {
                return Err(SqlCompileError::new(
                    "unsupported_constraint_field_type",
                    format!("{path}.field"),
                    format!(
                        "field_set_contains requires text_list or known_aliases, got `{:?}`",
                        field.field_type
                    ),
                ));
            }
            Ok(format!(
                "((values->{}->'value') ? {})",
                quote_literal(field.id.as_str()),
                quote_literal(value)
            ))
        }
        ConstraintExpr::TextLength { field, min, max } => {
            let field = constraint_field(model, field, &format!("{path}.field"))?;
            if field.field_type != FieldType::Text {
                return Err(SqlCompileError::new(
                    "unsupported_constraint_field_type",
                    format!("{path}.field"),
                    format!("text_length requires text, got `{:?}`", field.field_type),
                ));
            }
            if min.is_none() && max.is_none() {
                return Err(SqlCompileError::new(
                    "missing_text_length_bound",
                    path,
                    "text_length must declare min, max, or both",
                ));
            }
            if min
                .zip(*max)
                .is_some_and(|(minimum, maximum)| minimum > maximum)
            {
                return Err(SqlCompileError::new(
                    "invalid_text_length_range",
                    path,
                    "text_length min cannot exceed max",
                ));
            }
            let length = format!("char_length({})::numeric", lookup_json_field_sql(field));
            let bounds = [
                min.map(|minimum| format!("({length} >= {minimum})")),
                max.map(|maximum| format!("({length} <= {maximum})")),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
            Ok(format!("({})", bounds.join(" and ")))
        }
        ConstraintExpr::TextStartsWith { field, value } => {
            let field = constraint_field(model, field, &format!("{path}.field"))?;
            if field.field_type != FieldType::Text || value.is_empty() {
                return Err(SqlCompileError::new(
                    "invalid_text_prefix",
                    path,
                    "text_starts_with requires a text field and a non-empty literal prefix",
                ));
            }
            Ok(text_starts_with_sql(&lookup_json_field_sql(field), value))
        }
        ConstraintExpr::NonOverlappingIntervals { .. } => Err(non_row_constraint_error(path)),
    }
}

fn text_starts_with_sql(field_sql: &str, value: &str) -> String {
    let literal = quote_literal(value);
    format!("(left({field_sql} collate \"C\", char_length({literal})) = {literal} collate \"C\")")
}

fn lookup_json_field_sql(field: &Field) -> String {
    let raw = format!("values->{}->>'value'", quote_literal(field.id.as_str()));
    match field.field_type {
        FieldType::Number => format!("({raw})::numeric"),
        FieldType::Bool => format!("({raw})::boolean"),
        FieldType::Date => format!("({raw})::date"),
        FieldType::Datetime => format!("({raw})::timestamptz"),
        FieldType::Relation => format!(
            "(values->{}->'value'->>'value')::uuid",
            quote_literal(field.id.as_str())
        ),
        FieldType::TextList | FieldType::KnownAliases | FieldType::Json => {
            format!("values->{}->'value'", quote_literal(field.id.as_str()))
        }
        _ => raw,
    }
}

fn constraint_field<'a>(
    model: &'a Model,
    field_id: &str,
    path: &str,
) -> Result<&'a Field, SqlCompileError> {
    model
        .fields
        .iter()
        .find(|field| field.id.as_str() == field_id)
        .ok_or_else(|| {
            SqlCompileError::new(
                "unknown_constraint_field",
                path,
                format!("field `{field_id}` is not declared on model `{}`", model.id),
            )
        })
}

fn constraint_single_column(field: &Field, path: &str) -> Result<FieldColumn, SqlCompileError> {
    let mut columns = field_columns(field)?.into_iter();
    let column = columns.next().expect("every field has a physical column");
    if columns.next().is_some() {
        return Err(SqlCompileError::new(
            "unsupported_constraint_field_type",
            path,
            format!(
                "field `{}` ({:?}) spans multiple physical columns and cannot be used by this expression",
                field.id, field.field_type
            ),
        ));
    }
    Ok(column)
}

fn presence_sql(columns: &[FieldColumn], present: bool) -> String {
    let operator = if present { "is not null" } else { "is null" };
    format!(
        "({})",
        columns
            .iter()
            .map(|column| format!("{} {operator}", quote_identifier(&column.name)))
            .collect::<Vec<_>>()
            .join(" and ")
    )
}

fn ensure_comparison_supported(
    field: &Field,
    comparison: Comparison,
    path: &str,
) -> Result<(), SqlCompileError> {
    let supported = match comparison {
        Comparison::Eq | Comparison::NotEq => matches!(
            field.field_type,
            FieldType::Text
                | FieldType::Number
                | FieldType::Bool
                | FieldType::Date
                | FieldType::Datetime
                | FieldType::Enum
                | FieldType::IsoCountry
                | FieldType::IsoCurrency
        ),
        Comparison::Lt | Comparison::Lte | Comparison::Gt | Comparison::Gte => matches!(
            field.field_type,
            FieldType::Text | FieldType::Number | FieldType::Date | FieldType::Datetime
        ),
    };
    if supported {
        Ok(())
    } else {
        Err(SqlCompileError::new(
            "unsupported_constraint_comparison",
            path,
            format!(
                "operator `{comparison:?}` is not supported for field `{}` ({:?})",
                field.id, field.field_type
            ),
        ))
    }
}

fn ensure_equality_comparable(field: &Field, path: &str) -> Result<(), SqlCompileError> {
    ensure_comparison_supported(field, Comparison::Eq, path)
}

fn comparison_sql(comparison: Comparison) -> &'static str {
    match comparison {
        Comparison::Eq => "=",
        Comparison::NotEq => "<>",
        Comparison::Lt => "<",
        Comparison::Lte => "<=",
        Comparison::Gt => ">",
        Comparison::Gte => ">=",
    }
}

fn typed_literal_sql(
    literal: &TypedLiteral,
    field: &Field,
    path: &str,
) -> Result<String, SqlCompileError> {
    let expected = match literal {
        TypedLiteral::Text(_) => FieldType::Text,
        TypedLiteral::Number(_) => FieldType::Number,
        TypedLiteral::Bool(_) => FieldType::Bool,
        TypedLiteral::Date(_) => FieldType::Date,
        TypedLiteral::Datetime(_) => FieldType::Datetime,
        TypedLiteral::Enum(_) => FieldType::Enum,
        TypedLiteral::IsoCountry(_) => FieldType::IsoCountry,
        TypedLiteral::IsoCurrency(_) => FieldType::IsoCurrency,
    };
    if field.field_type != expected {
        return Err(SqlCompileError::new(
            "constraint_literal_type_mismatch",
            path,
            format!(
                "literal type `{expected:?}` does not match field `{}` ({:?})",
                field.id, field.field_type
            ),
        ));
    }

    match literal {
        TypedLiteral::Text(value) => Ok(format!("{}::text", quote_literal(value))),
        TypedLiteral::Number(value) => {
            Decimal::from_str(value).map_err(|_| {
                SqlCompileError::new(
                    "invalid_constraint_literal",
                    path,
                    format!("number literal `{value}` is not a decimal"),
                )
            })?;
            Ok(format!("{}::numeric", quote_literal(value)))
        }
        TypedLiteral::Bool(value) => Ok(format!("{value}::boolean")),
        TypedLiteral::Date(value) => {
            NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| {
                SqlCompileError::new(
                    "invalid_constraint_literal",
                    path,
                    format!("date literal `{value}` is not YYYY-MM-DD"),
                )
            })?;
            Ok(format!("{}::date", quote_literal(value)))
        }
        TypedLiteral::Datetime(value) => {
            DateTime::parse_from_rfc3339(value).map_err(|_| {
                SqlCompileError::new(
                    "invalid_constraint_literal",
                    path,
                    format!("datetime literal `{value}` is not RFC 3339"),
                )
            })?;
            Ok(format!("{}::timestamptz", quote_literal(value)))
        }
        TypedLiteral::Enum(value) => {
            if !field
                .option_set
                .iter()
                .any(|option| option.id.as_str() == value)
            {
                return Err(SqlCompileError::new(
                    "invalid_constraint_literal",
                    path,
                    format!(
                        "enum literal `{value}` is not an option of field `{}`",
                        field.id
                    ),
                ));
            }
            Ok(format!("{}::text", quote_literal(value)))
        }
        TypedLiteral::IsoCountry(value) => {
            if !is_iso_3166_1_alpha_2(value) {
                return Err(SqlCompileError::new(
                    "invalid_constraint_literal",
                    path,
                    format!("ISO country literal `{value}` is invalid"),
                ));
            }
            Ok(format!("{}::text", quote_literal(value)))
        }
        TypedLiteral::IsoCurrency(value) => {
            if !is_iso_4217_tender_currency(value) {
                return Err(SqlCompileError::new(
                    "invalid_constraint_literal",
                    path,
                    format!("ISO currency literal `{value}` is invalid"),
                ));
            }
            Ok(format!("{}::text", quote_literal(value)))
        }
    }
}

fn field_columns(field: &Field) -> Result<Vec<FieldColumn>, SqlCompileError> {
    let identifier = normalize_identifier(field.id.as_str()).map_err(|issue| {
        SqlCompileError::new(issue.code, format!("fields.{}.id", field.id), issue.message)
    })?;
    let column = |name: String, sql_type| FieldColumn {
        name: bounded_identifier(&name),
        sql_type,
    };
    Ok(match field.field_type {
        FieldType::Text | FieldType::IsoCountry | FieldType::IsoCurrency | FieldType::Enum => {
            vec![column(identifier, "text")]
        }
        FieldType::Number => vec![column(identifier, "numeric")],
        FieldType::Bool => vec![column(identifier, "boolean")],
        FieldType::Date => vec![column(identifier, "date")],
        FieldType::Datetime => vec![column(identifier, "timestamptz")],
        FieldType::Relation => vec![column(identifier, "uuid")],
        FieldType::TextList | FieldType::KnownAliases => vec![column(identifier, "text[]")],
        FieldType::Json => vec![column(identifier, "jsonb")],
        FieldType::MoneyRate => vec![
            column(format!("{identifier}_amount"), "numeric"),
            column(format!("{identifier}_currency"), "text"),
            column(format!("{identifier}_period"), "text"),
        ],
    })
}

fn validate_field_names(
    previous: &CompiledManifest,
    next: &CompiledManifest,
) -> Result<(), SqlCompileError> {
    for old in &previous.extras.model_metadata {
        let Some(new) = next
            .extras
            .model_metadata
            .iter()
            .find(|model| model.model == old.model)
        else {
            continue;
        };
        for name in old.name.iter().chain(old.aliases.iter()) {
            if new.name.as_ref() != Some(name) && !new.aliases.contains(name) {
                return Err(SqlCompileError::new("model_alias_required", format!("models.{}.aliases", old.model), format!("Keep previous public table name `{name}` in aliases; keep the same table id.")));
            }
        }
    }
    for old_model in &previous.schema.models {
        let Some(new_model) = next
            .schema
            .models
            .iter()
            .find(|model| model.id == old_model.id)
        else {
            continue;
        };
        for old_field in &old_model.fields {
            let Some(new_field) = new_model
                .fields
                .iter()
                .find(|field| field.id == old_field.id)
            else {
                continue;
            };
            for old_option in &old_field.option_set {
                let Some(new_option) = new_field
                    .option_set
                    .iter()
                    .find(|option| option.id == old_option.id)
                else {
                    continue;
                };
                for name in std::iter::once(&old_option.label).chain(old_option.aliases.iter()) {
                    if name != &new_option.label && !new_option.aliases.contains(name) {
                        return Err(SqlCompileError::new("option_alias_required", format!("models.{}.fields.{}.option_set.{}.aliases", old_model.id, old_field.id, old_option.id), format!("Keep previous choice name `{name}` in aliases; keep the same choice id.")));
                    }
                }
            }
        }
    }
    for old in &previous.extras.field_metadata {
        let Some(new) = next
            .extras
            .field_metadata
            .iter()
            .find(|field| field.model == old.model && field.field == old.field)
        else {
            continue;
        };
        // The ID-derived name is always retained by the generated client. Named
        // aliases must also survive later renames, including after retirement.
        for name in old.name.iter().chain(old.aliases.iter()) {
            if new.name.as_ref() != Some(name) && !new.aliases.contains(name) {
                return Err(SqlCompileError::new("field_alias_required", format!("models.{}.fields.{}.aliases", old.model, old.field), format!("keep previous public name `{name}` in aliases when renaming; field identity remains `{}`", old.field)));
            }
        }
    }
    Ok(())
}

// Predecessors are the applied ledger in chronological order. Removed IDs and
// public names stay reserved; storage survives only for history and undo.
fn validate_archived_names(
    history: &[CompiledManifest],
    next: &CompiledManifest,
) -> Result<(), SqlCompileError> {
    let Some(current) = history.last() else {
        return Ok(());
    };
    let definition = |manifest: &CompiledManifest| {
        crate::data_plane::compile(manifest)
            .map_err(|message| SqlCompileError::new("invalid_public_names", "models", message))
    };
    let next_definition = definition(next)?;
    let names = |definition: &serde_json::Value, model: &str, field: Option<&str>, label: &str| {
        let mut names = BTreeSet::from([field.unwrap_or(model).to_owned(), label.to_owned()]);
        let model = definition["manifest"]["models"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["id"] == model)
            .unwrap();
        if let Some(field) = field {
            names.extend(
                model["fields"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|f| f["id"] == field)
                    .map(|f| f["name"].as_str().unwrap().to_owned()),
            );
        } else {
            names.insert(model["name"].as_str().unwrap().to_owned());
            names.extend(
                model["aliases"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|n| n.as_str().unwrap().to_owned()),
            );
        }
        names
    };
    for old in history {
        let old_definition = definition(old)?;
        for model in &old.schema.models {
            let active = current.schema.models.iter().find(|m| m.id == model.id);
            let old_names = names(&old_definition, model.id.as_str(), None, &model.label);
            for candidate in &next.schema.models {
                if active.is_none()
                    && !old_names.is_disjoint(&names(
                        &next_definition,
                        candidate.id.as_str(),
                        None,
                        &candidate.label,
                    ))
                {
                    return Err(SqlCompileError::new(
                        "archived_table",
                        format!("models.{}", candidate.id),
                        format!(
                            "`{}` was archived; give the new table a different name.",
                            model.label
                        ),
                    ));
                }
                if candidate.id != model.id {
                    continue;
                }
                for field in &model.fields {
                    if active.is_some_and(|m| {
                        m.fields.iter().any(|f| {
                            f.id == field.id && f.lifecycle == SchemaElementLifecycle::Active
                        })
                    }) {
                        continue;
                    }
                    let old_names = names(
                        &old_definition,
                        model.id.as_str(),
                        Some(field.id.as_str()),
                        &field.label,
                    );
                    for new in &candidate.fields {
                        if new.lifecycle == SchemaElementLifecycle::Active
                            && !old_names.is_disjoint(&names(
                                &next_definition,
                                candidate.id.as_str(),
                                Some(new.id.as_str()),
                                &new.label,
                            ))
                        {
                            return Err(SqlCompileError::new(
                                "archived_field",
                                format!("models.{}.fields.{}", candidate.id, new.id),
                                format!(
                                    "`{}` was archived; give the new field a different name.",
                                    field.label
                                ),
                            ));
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

fn validate_required_additions(previous: &Schema, next: &Schema) -> Result<(), SqlCompileError> {
    for model in &next.models {
        let Some(old) = previous.models.iter().find(|old| old.id == model.id) else {
            continue;
        };
        for field in &model.fields {
            if field.required && !old.fields.iter().any(|f| f.id == field.id) {
                return Err(SqlCompileError::new("required_field_transition_refused",
                    format!("models.{}.fields.{}.required", model.id, field.id),
                    "A new required field cannot be added to an existing table. Add an optional field, fill existing rows through ordinary record writes, then make it required."));
            }
        }
    }
    Ok(())
}

fn validate_transition(previous: &Schema, next: &Schema) -> Result<(), SqlCompileError> {
    let next_models = next
        .models
        .iter()
        .map(|model| (&model.id, model))
        .collect::<BTreeMap<_, _>>();
    for old_model in &previous.models {
        let Some(new_model) = next_models.get(&old_model.id) else {
            continue;
        };
        if old_model.kind != new_model.kind {
            return Err(SqlCompileError::new(
                "model_kind_change_refused",
                format!("models.{}.kind", old_model.id),
                "Table storage kinds are immutable. Add a new table, copy records through ordinary writes, then archive the old table.",
            ));
        }
        let new_fields = new_model
            .fields
            .iter()
            .map(|field| (&field.id, field))
            .collect::<BTreeMap<_, _>>();
        for old_field in &old_model.fields {
            let Some(new_field) = new_fields.get(&old_field.id) else {
                continue;
            };
            if old_field.field_type != new_field.field_type {
                return Err(SqlCompileError::new(
                    "typed_migration_required",
                    format!("models.{}.fields.{}.type", old_model.id, old_field.id),
                    format!(
                        "Field types are immutable ({:?} cannot become {:?}). Add a new field, copy values through ordinary record writes, then archive the old field.",
                        old_field.field_type, new_field.field_type
                    ),
                ));
            }
            if old_field.target_model != new_field.target_model {
                return Err(SqlCompileError::new(
                    "typed_migration_required",
                    format!("models.{}.fields.{}.target_model", old_model.id, old_field.id),
                    "Relation targets are immutable. Add a new optional relation field, copy values through ordinary record writes, then archive the old field.",
                ));
            }
        }
    }
    Ok(())
}

fn retired_elements(
    previous: &CompiledManifest,
    next: &CompiledManifest,
) -> Vec<RetiredSchemaElement> {
    let mut retired = Vec::new();
    let next_models = next
        .schema
        .models
        .iter()
        .map(|model| (&model.id, model))
        .collect::<BTreeMap<_, _>>();
    for old_model in &previous.schema.models {
        let Some(new_model) = next_models.get(&old_model.id) else {
            retired.push(RetiredSchemaElement {
                kind: RetirementKind::Model,
                model: Some(old_model.id.to_string()),
                field: None,
                element: old_model.id.to_string(),
            });
            continue;
        };
        let new_fields = new_model
            .fields
            .iter()
            .map(|field| (&field.id, field))
            .collect::<BTreeMap<_, _>>();
        for old_field in &old_model.fields {
            let Some(new_field) = new_fields.get(&old_field.id) else {
                retired.push(RetiredSchemaElement {
                    kind: RetirementKind::Field,
                    model: Some(old_model.id.to_string()),
                    field: Some(old_field.id.to_string()),
                    element: old_field.id.to_string(),
                });
                continue;
            };
            if old_field.field_type == FieldType::Enum {
                let new_options = new_field
                    .option_set
                    .iter()
                    .map(|option| &option.id)
                    .collect::<BTreeSet<_>>();
                for option in &old_field.option_set {
                    if !new_options.contains(&option.id) {
                        retired.push(RetiredSchemaElement {
                            kind: RetirementKind::EnumOption,
                            model: Some(old_model.id.to_string()),
                            field: Some(old_field.id.to_string()),
                            element: option.id.to_string(),
                        });
                    }
                }
            }
        }
    }
    retire_custom_fields(
        &mut retired,
        &previous.schema.custom_fields,
        &next.schema.custom_fields,
    );
    let next_change_types = next
        .schema
        .change_types
        .iter()
        .map(|change_type| &change_type.id)
        .collect::<BTreeSet<_>>();
    for change_type in &previous.schema.change_types {
        if !next_change_types.contains(&change_type.id) {
            retired.push(RetiredSchemaElement {
                kind: RetirementKind::ChangeType,
                model: Some(change_type.target_model.to_string()),
                field: None,
                element: change_type.id.to_string(),
            });
        }
    }
    retired
}

fn retire_custom_fields(
    retired: &mut Vec<RetiredSchemaElement>,
    previous: &[CustomFieldDefinition],
    next: &[CustomFieldDefinition],
) {
    let next_fields = next
        .iter()
        .map(|field| (&field.id, field))
        .collect::<BTreeMap<_, _>>();
    for field in previous.iter().filter(|field| field.archived_at.is_none()) {
        if next_fields
            .get(&field.id)
            .is_none_or(|next| next.archived_at.is_some())
        {
            retired.push(RetiredSchemaElement {
                kind: RetirementKind::CustomField,
                model: Some(field.model_id.to_string()),
                field: Some(field.field_id.to_string()),
                element: field.id.to_string(),
            });
        }
    }
}

fn runtime_api_capabilities(artifacts: &[SqlArtifact]) -> Vec<SqlRuntimeApiCapability> {
    let operations: &[(&str, &[&str])] = &[
        ("apply_change_set", &["kernel_apply_change_set(jsonb)"]),
        (
            "apply_change_set_in_transaction",
            &["kernel_apply_change_set_in_transaction(jsonb)"],
        ),
        (
            "apply_seed_defaults",
            &["kernel_apply_seed_defaults(jsonb)"],
        ),
        (
            "approve_draft_change_set",
            &["kernel_approve_draft_change_set(jsonb)"],
        ),
        ("begin_tenant_transaction", &[]),
        ("change_set_diff", &["kernel_change_set_diff(jsonb)"]),
        (
            "commit_enum_option_set_revision",
            &["kernel_commit_tenant_schema_revision(jsonb)"],
        ),
        (
            "commit_tenant_schema_revision",
            &["kernel_commit_tenant_schema_revision(jsonb)"],
        ),
        (
            "discard_draft_change_set",
            &["kernel_discard_draft_change_set(jsonb)"],
        ),
        ("draft_threads", &["kernel_draft_threads(jsonb)"]),
        (
            "dry_run_tenant_schema_revision",
            &["kernel_dry_run_tenant_schema_revision(jsonb)"],
        ),
        ("field_history", &["kernel_field_history(jsonb)"]),
        (
            "list_draft_change_sets",
            &["kernel_list_draft_change_sets(jsonb)"],
        ),
        ("materialize_schema", &[]),
        ("materialize_schema_with_provenance", &[]),
        ("materialize_schema_with_provenance_guarded", &[]),
        ("lookup_hydrate", &["kernel_lookup_hydrate(jsonb)"]),
        ("lookup_list", &["kernel_lookup_list(jsonb)"]),
        (
            "lookup_reference_count",
            &["kernel_lookup_reference_count(jsonb)"],
        ),
        (
            "lookup_resolve_batch",
            &["kernel_lookup_resolve_batch(jsonb)"],
        ),
        (
            "lookup_set_availability",
            &["kernel_lookup_set_availability(jsonb)"],
        ),
        (
            "lookup_transfer_alias",
            &["kernel_lookup_transfer_alias(jsonb)"],
        ),
        (
            "preflight_schema_materialization",
            &["kernel_preflight_schema_materialization(jsonb)"],
        ),
        ("preflight_schema_materialization_guarded", &[]),
        ("reconcile_schema_materialization_policies", &[]),
        ("ensure_schema_activation_head_policy", &[]),
        ("query_visible_sql", &["kernel_query_visible_sql(jsonb)"]),
        (
            "read_active_schema_revision",
            &["kernel_read_active_schema_revision(jsonb)"],
        ),
        (
            "read_runtime_release_observability",
            &["kernel_read_runtime_release_observability(jsonb)"],
        ),
        (
            "read_draft_change_set",
            &["kernel_read_draft_change_set(jsonb)"],
        ),
        (
            "read_visible_record",
            &["kernel_read_visible_record(jsonb)"],
        ),
        (
            "read_visible_record_for_update_in_transaction",
            &["kernel_read_visible_record_for_update(jsonb)"],
        ),
        (
            "read_visible_records",
            &["kernel_read_visible_records(jsonb)"],
        ),
        (
            "read_visible_records_by_model",
            &["kernel_read_visible_records_by_model(jsonb)"],
        ),
        (
            "read_visible_records_by_text_fields_in_transaction",
            &["kernel_read_visible_records_by_text_fields(jsonb)"],
        ),
        (
            "read_visible_records_in_transaction",
            &["kernel_read_visible_records(jsonb)"],
        ),
        ("data_query", &["kernel_data_query(jsonb)"]),
        ("work_session", &["kernel_work_session(jsonb)"]),
        ("recent_activity", &["kernel_recent_activity(jsonb)"]),
        ("record_agent_run", &["kernel_record_agent_run(jsonb)"]),
        ("revert_change_set", &["kernel_revert_change_set(jsonb)"]),
        ("schema_hash", &[]),
        (
            "schema_revision_is_active_with_materialized_tables",
            &["kernel_schema_revision_is_active_with_materialized_tables(jsonb)"],
        ),
        (
            "update_agent_run_status",
            &["kernel_update_agent_run_status(jsonb)"],
        ),
        ("update_draft_notes", &["kernel_update_draft_notes(jsonb)"]),
        (
            "validate_change_set_dry_run",
            &["kernel_validate_change_set_dry_run(jsonb)"],
        ),
        (
            "validate_change_sets_dry_run",
            &["kernel_validate_change_sets_dry_run(jsonb)"],
        ),
    ];
    let emitted_functions = artifacts
        .iter()
        .filter(|artifact| artifact.kind == SqlArtifactKind::Function)
        .map(|artifact| artifact.name.as_str())
        .collect::<BTreeSet<_>>();

    operations
        .iter()
        .map(|(operation, signatures)| {
            let function_emitted = !signatures.is_empty()
                && signatures
                    .iter()
                    .all(|signature| emitted_functions.contains(signature));
            SqlRuntimeApiCapability {
                operation: (*operation).to_string(),
                sql_signatures: signatures
                    .iter()
                    .map(|signature| (*signature).to_string())
                    .collect(),
                function_emitted,
                behavioral_parity: true,
                implemented: true,
                gap: None,
            }
        })
        .collect()
}

fn push_artifact(
    artifacts: &mut Vec<SqlArtifact>,
    kind: SqlArtifactKind,
    name: impl Into<String>,
    sql: impl Into<String>,
) {
    artifacts.push(SqlArtifact {
        kind,
        name: name.into(),
        sql: sql.into(),
    });
}

// Required applies to open mainline records. Closed historical versions and
// saved drafts retain their original data; normal writes validate the new schema.
fn push_required_check(
    artifacts: &mut Vec<SqlArtifact>,
    table: &str,
    name: &str,
    old_expression: &str,
) {
    let expression =
        format!("stage <> 'mainline' or effective_end is not null or {old_expression}");
    let quoted_table = quote_identifier(table);
    let quoted_name = quote_identifier(name);
    let statement = format!(
        "alter table {quoted_table} add constraint {quoted_name} check ({expression}) not valid"
    );
    let sql = format!(
        r#"do $kernel$
    declare failing_rows text;
    begin
      {add};
      begin
        alter table {quoted_table} validate constraint {quoted_name};
      exception when check_violation then
        select string_agg(distinct record_id::text, ', ' order by record_id::text) into failing_rows
        from {quoted_table} where not ({expression});
        raise exception 'Cannot make field required (%). Fill these rows through ordinary record writes, then retry. Failing rows: %', {name_literal}, failing_rows;
      end;
    end $kernel$"#,
        name_literal = quote_literal(name),
        add = format!("if not exists (select 1 from pg_constraint where conrelid = to_regclass({}) and conname = {}) then\n    execute {};\n  end if", quote_literal(table), quote_literal(name), quote_literal(&statement))
    );
    push_artifact(
        artifacts,
        SqlArtifactKind::CheckConstraint,
        format!("{table}.{name}"),
        sql,
    );
}

fn push_check(artifacts: &mut Vec<SqlArtifact>, table: &str, name: &str, expression: &str) {
    let quoted_table = quote_identifier(table);
    let quoted_name = quote_identifier(name);
    let statement = format!(
        "alter table {} add constraint {} check ({expression}) not valid",
        quoted_table, quoted_name
    );
    let sql = format!(
        "{};\nalter table {quoted_table} validate constraint {quoted_name}",
        idempotent_constraint(table, name, &statement)
    );
    push_artifact(
        artifacts,
        SqlArtifactKind::CheckConstraint,
        format!("{table}.{name}"),
        sql,
    );
}

fn push_catalog_check_repair(
    artifacts: &mut Vec<SqlArtifact>,
    table: &str,
    name: &str,
    expression: &str,
    canonical_expression: &str,
    legacy_canonical_expressions: &[&str],
) {
    let quoted_table = quote_identifier(table);
    let quoted_name = quote_identifier(name);
    let legacy_expressions = legacy_canonical_expressions
        .iter()
        .map(|expression| quote_literal(expression))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "do $kernel$\ndeclare\n  existing_expression text;\n  existing_validated boolean;\nbegin\n  select pg_get_expr(constraint_row.conbin, constraint_row.conrelid, true),\n         constraint_row.convalidated\n    into existing_expression, existing_validated\n  from pg_constraint as constraint_row\n  where constraint_row.conrelid = to_regclass({table_literal})\n    and constraint_row.conname = {name_literal}\n    and constraint_row.contype = 'c';\n\n  if existing_expression = any (array[{legacy_expressions}]::text[]) then\n    execute {drop_statement};\n    existing_expression := null;\n    existing_validated := false;\n  elsif existing_expression is not null and existing_expression <> {canonical_expression} then\n    raise exception using\n      errcode = 'P0001',\n      message = {drift_message};\n  end if;\n\n  if existing_expression is null then\n    execute {add_statement};\n    existing_validated := false;\n  end if;\n\n  if not existing_validated then\n    execute {validate_statement};\n  end if;\nend\n$kernel$",
        table_literal = quote_literal(table),
        name_literal = quote_literal(name),
        legacy_expressions = legacy_expressions,
        drop_statement = quote_literal(&format!(
            "alter table {quoted_table} drop constraint {quoted_name}"
        )),
        canonical_expression = quote_literal(canonical_expression),
        drift_message = quote_literal(&format!(
            "schema drift at {table}.{name}: existing check constraint is not a recognized catalog revision"
        )),
        add_statement = quote_literal(&format!(
            "alter table {quoted_table} add constraint {quoted_name} check ({expression}) not valid"
        )),
        validate_statement = quote_literal(&format!(
            "alter table {quoted_table} validate constraint {quoted_name}"
        )),
    );
    push_artifact(
        artifacts,
        SqlArtifactKind::CheckConstraint,
        format!("{table}.{name}"),
        sql,
    );
}

fn push_foreign_key(
    artifacts: &mut Vec<SqlArtifact>,
    table: &str,
    name: &str,
    columns: &[&str],
    referenced_table: &str,
    referenced_columns: &[&str],
) {
    let quoted_table = quote_identifier(table);
    let quoted_name = quote_identifier(name);
    let column_names = columns;
    let referenced_column_names = referenced_columns;
    let columns = column_names
        .iter()
        .map(|column| quote_identifier(column))
        .collect::<Vec<_>>()
        .join(", ");
    let referenced_columns = referenced_column_names
        .iter()
        .map(|column| quote_identifier(column))
        .collect::<Vec<_>>()
        .join(", ");
    let statement = format!(
        "alter table {} add constraint {} foreign key ({columns}) references {} ({referenced_columns}) not valid",
        quoted_table,
        quoted_name,
        quote_identifier(referenced_table)
    );
    let expected_columns = column_names
        .iter()
        .map(|column| quote_literal(column))
        .collect::<Vec<_>>()
        .join(", ");
    let expected_referenced_columns = referenced_column_names
        .iter()
        .map(|column| quote_literal(column))
        .collect::<Vec<_>>()
        .join(", ");
    let recognized_entity_to_lookup_transition = if referenced_table == "lookup_record"
        && column_names.len() == 4
        && referenced_column_names == ["app_id", "customer_id", "model_id", "id"]
    {
        format!(
            "actual_columns = array[{}, 'app_id', 'customer_id']::text[]\n    and actual_referenced_columns = array['id', 'app_id', 'customer_id']::text[]\n    and actual_referenced_table like '%\\_record' escape '\\'",
            quote_literal(column_names[3])
        )
    } else {
        "false".to_string()
    };
    let validate_statement = quote_literal(&format!(
        "alter table {quoted_table} validate constraint {quoted_name}"
    ));
    let validation_block = if referenced_table == "lookup_record"
        && column_names.len() == 4
        && referenced_column_names == ["app_id", "customer_id", "model_id", "id"]
    {
        format!(
            "begin\n      execute {validate_statement};\n    exception when foreign_key_violation then\n      null;\n    end"
        )
    } else {
        format!("execute {validate_statement}")
    };
    let sql = format!(
        "do $kernel$\ndeclare\n  actual_columns text[];\n  actual_referenced_table text;\n  actual_referenced_columns text[];\n  actual_validated boolean;\n  differs boolean;\nbegin\n  select array(select attribute.attname from unnest(constraint_row.conkey) with ordinality key(attnum, position) join pg_attribute attribute on attribute.attrelid = constraint_row.conrelid and attribute.attnum = key.attnum order by key.position),\n         referenced_relation.relname,\n         array(select attribute.attname from unnest(constraint_row.confkey) with ordinality key(attnum, position) join pg_attribute attribute on attribute.attrelid = constraint_row.confrelid and attribute.attnum = key.attnum order by key.position),\n         constraint_row.convalidated\n    into actual_columns, actual_referenced_table, actual_referenced_columns, actual_validated\n  from pg_constraint constraint_row\n  join pg_class referenced_relation on referenced_relation.oid = constraint_row.confrelid\n  where constraint_row.conrelid = to_regclass({table_literal})\n    and constraint_row.conname = {name_literal}\n    and constraint_row.contype = 'f';\n\n  differs := found and (actual_columns is distinct from array[{expected_columns}]::text[]\n    or actual_referenced_table is distinct from {referenced_table_literal}\n    or actual_referenced_columns is distinct from array[{expected_referenced_columns}]::text[]);\n  if differs and ({recognized_entity_to_lookup_transition}) then\n    execute {drop_statement};\n    actual_columns := null;\n  elsif differs then\n    raise exception using errcode = 'P0001', message = {drift_message};\n  end if;\n  if actual_columns is null then\n    execute {add_statement};\n    actual_validated := false;\n  end if;\n  if not actual_validated then\n    {validation_block};\n  end if;\nend\n$kernel$",
        table_literal = quote_literal(table),
        name_literal = quote_literal(name),
        expected_columns = expected_columns,
        referenced_table_literal = quote_literal(referenced_table),
        expected_referenced_columns = expected_referenced_columns,
        recognized_entity_to_lookup_transition = recognized_entity_to_lookup_transition,
        drop_statement = quote_literal(&format!("alter table {quoted_table} drop constraint {quoted_name}")),
        drift_message = quote_literal(&format!("schema drift at {table}.{name}: existing foreign key is not a recognized catalog revision")),
        add_statement = quote_literal(&statement),
        validation_block = validation_block,
    );
    push_artifact(
        artifacts,
        SqlArtifactKind::ForeignKey,
        format!("{table}.{name}"),
        sql,
    );
}

fn idempotent_constraint(table: &str, name: &str, statement: &str) -> String {
    format!(
        "do $kernel$\nbegin\n  if not exists (\n    select 1 from pg_constraint\n    where conrelid = to_regclass({}) and conname = {}\n  ) then\n    execute {};\n  end if;\nend\n$kernel$",
        quote_literal(table),
        quote_literal(name),
        quote_literal(statement)
    )
}

fn push_policy(artifacts: &mut Vec<SqlArtifact>, table: &str, raw_guarded: bool) {
    let quoted_table = quote_identifier(table);
    let retained_policies = if table == "schema_revision" {
        format!(
            "{}, {}",
            quote_literal(TENANT_POLICY),
            quote_literal("kernel_schema_catalog_read")
        )
    } else {
        quote_literal(TENANT_POLICY)
    };
    // Row comparisons and authorization read one per-statement snapshot of the
    // kernel scope (one subquery), so set_config during a scan cannot pair one
    // scope's rows with another scope's authorization.
    let scope = if raw_guarded {
        "(app_id, customer_id) = (select scope.app_id, scope.customer_id from (select current_setting('kernel.app_id', true) app_id, current_setting('kernel.customer_id', true) customer_id) scope where kernel_principal_scope_authorized('any', scope.app_id, scope.customer_id, null) and kernel_policy_raw_table_access_allowed(current_user::name, scope.app_id, scope.customer_id))".to_string()
    } else {
        "(app_id, customer_id) = (select scope.app_id, scope.customer_id from (select current_setting('kernel.app_id', true) app_id, current_setting('kernel.customer_id', true) customer_id) scope where kernel_principal_scope_authorized('any', scope.app_id, scope.customer_id, null))".to_string()
    };
    let create = format!(
        "create policy {TENANT_POLICY} on {quoted_table} for all using ({scope}) with check ({scope})"
    );
    let update = format!(
        "alter policy {TENANT_POLICY} on {quoted_table} using ({scope}) with check ({scope})"
    );
    let sql = format!(
        "alter table {quoted_table} enable row level security;\nalter table {quoted_table} force row level security;\ndo $kernel$\ndeclare\n  unexpected_policy record;\nbegin\n  for unexpected_policy in\n    select policyname\n    from pg_policies\n    where schemaname = current_schema()\n      and tablename = {table_literal}\n      and policyname not in ({retained_policies})\n    order by policyname\n  loop\n    execute format('drop policy %I on %I', unexpected_policy.policyname, {table_literal});\n  end loop;\n\n  if exists (select 1 from pg_policies where schemaname = current_schema() and tablename = {table_literal} and policyname = {tenant_policy}) then\n    execute {update};\n  else\n    execute {create};\n  end if;\nend\n$kernel$",
        table_literal = quote_literal(table),
        retained_policies = retained_policies,
        tenant_policy = quote_literal(TENANT_POLICY),
        update = quote_literal(&update),
        create = quote_literal(&create)
    );
    push_artifact(
        artifacts,
        SqlArtifactKind::Policy,
        format!("{table}.{TENANT_POLICY}"),
        sql,
    );
}

fn push_app_catalog_policy(artifacts: &mut Vec<SqlArtifact>) {
    let table = "schema_constraint_identity_source";
    let quoted_table = quote_identifier(table);
    let source_scope = "app_id = (select scope.app_id from (select current_setting('kernel.app_id', true) app_id, current_setting('kernel.customer_id', true) customer_id) scope where kernel_principal_scope_authorized('any', scope.app_id, scope.customer_id, null))";
    let create = format!(
        "create policy {APP_CATALOG_POLICY} on {quoted_table} for all using ({source_scope}) with check ({source_scope})"
    );
    let update = format!(
        "alter policy {APP_CATALOG_POLICY} on {quoted_table} using ({source_scope}) with check ({source_scope})"
    );
    let sql = format!(
        "alter table {quoted_table} enable row level security;\nalter table {quoted_table} force row level security;\ndo $kernel$\ndeclare\n  unexpected_policy record;\nbegin\n  for unexpected_policy in\n    select policyname\n    from pg_policies\n    where schemaname = current_schema()\n      and tablename = {table_literal}\n      and policyname <> {policy_name}\n    order by policyname\n  loop\n    execute format('drop policy %I on %I', unexpected_policy.policyname, {table_literal});\n  end loop;\n\n  if exists (select 1 from pg_policies where schemaname = current_schema() and tablename = {table_literal} and policyname = {policy_name}) then\n    execute {update};\n  else\n    execute {create};\n  end if;\nend\n$kernel$",
        table_literal = quote_literal(table),
        policy_name = quote_literal(APP_CATALOG_POLICY),
        update = quote_literal(&update),
        create = quote_literal(&create),
    );
    push_artifact(
        artifacts,
        SqlArtifactKind::Policy,
        format!("{table}.{APP_CATALOG_POLICY}"),
        sql,
    );
}

fn checksum_of(value: &impl Serialize) -> Result<String, SqlCompileError> {
    let bytes = serde_json::to_vec(value).map_err(|error| {
        SqlCompileError::new(
            "sql_manifest_serialization_failed",
            "sql_artifact_manifest",
            error.to_string(),
        )
    })?;
    let digest = Sha256::digest(bytes);
    Ok(format!("sha256:{}", hex_digest(&digest)))
}

fn json_comment(value: &str) -> String {
    serde_json::to_string(value).expect("string serializes as JSON")
}

fn quote_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn quote_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn constraint_name(table: &str, suffix: &str) -> String {
    bounded_identifier(&format!("{table}_{suffix}"))
}

fn bounded_identifier(value: &str) -> String {
    const LIMIT: usize = 63;
    if value.len() <= LIMIT {
        return value.to_string();
    }
    // Keep compile-time names identical to kernel_physical_identifier(), which
    // must implement the same algorithm inside PostgreSQL without extensions.
    let suffix = format!(
        "{:016x}",
        value
            .as_bytes()
            .iter()
            .fold(0xcbf29ce484222325_u64, |hash, byte| (hash
                ^ u64::from(*byte))
            .wrapping_mul(0x100000001b3),)
    );
    let prefix_len = LIMIT - suffix.len() - 1;
    let prefix_end = value
        .char_indices()
        .map(|(index, character)| index + character.len_utf8())
        .take_while(|end| *end <= prefix_len)
        .last()
        .unwrap_or(0);
    format!("{}_{}", &value[..prefix_end], suffix)
}

fn canonical_json(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Object(entries) => {
            let mut keys = entries.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("JSON object key serializes"),
                        canonical_json(&entries[key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        serde_json::Value::Array(entries) => format!(
            "[{}]",
            entries
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        _ => value.to_string(),
    }
}

fn hex_digest(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(encoded, "{byte:02x}").expect("writing to String cannot fail");
    }
    encoded
}

fn install_rank(kind: SqlArtifactKind) -> u8 {
    match kind {
        SqlArtifactKind::Sequence => 0,
        SqlArtifactKind::Table => 1,
        SqlArtifactKind::Column => 2,
        SqlArtifactKind::CheckConstraint => 3,
        SqlArtifactKind::Index => 4,
        SqlArtifactKind::ConstraintCatalog | SqlArtifactKind::AuthorizationPolicyCatalog => 6,
        SqlArtifactKind::ForeignKey => 5,
        SqlArtifactKind::Function => 7,
        SqlArtifactKind::Policy => 8,
    }
}

fn artifact_kind_name(kind: SqlArtifactKind) -> &'static str {
    match kind {
        SqlArtifactKind::Sequence => "sequence",
        SqlArtifactKind::Table => "table",
        SqlArtifactKind::Column => "column",
        SqlArtifactKind::CheckConstraint => "check_constraint",
        SqlArtifactKind::ConstraintCatalog => "constraint_catalog",
        SqlArtifactKind::AuthorizationPolicyCatalog => "authorization_policy_catalog",
        SqlArtifactKind::ForeignKey => "foreign_key",
        SqlArtifactKind::Index => "index",
        SqlArtifactKind::Policy => "policy",
        SqlArtifactKind::Function => "function",
    }
}
