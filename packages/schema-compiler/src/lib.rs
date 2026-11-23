use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt;
use std::str::FromStr;

use chrono::{DateTime, NaiveDate, Utc};
use kernel::{
    is_iso_3166_1_alpha_2, is_iso_4217_tender_currency, normalize_identifier, validate_app,
    validate_apply_against_schema, validate_schema, App, AppId, ApplyChangeSet, ApplyMode,
    ChangeType, ChangeTypeId, CustomFieldDefinition, CustomFieldDefinitionId, CustomFieldType,
    CustomerId, EntityExtensionCapabilities, EnumOption, EnumOptionId, ExternalKey, Field, FieldId,
    FieldType, FieldValue, ManyRelationDefinition, Model, ModelId, ModelKind,
    MoneyRatePeriod as KernelMoneyRatePeriod, MoneyRateValue, RecordKey, RowVersionWrite, Schema,
    SchemaElementLifecycle, SchemaElementOrigin, SchemaManagementPolicy, SchemaVersion,
};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub mod data_plane;
mod generated_query;
mod sql;
mod sql_runtime;

pub use generated_query::{
    query_generated_visible_sql, GeneratedQueryClient, GeneratedQueryError,
    GeneratedQueryExecutionError, GeneratedQueryTransaction,
};

pub use kernel::{
    Aggregate, Comparison, ConstraintExpr, DerivedExpr, MoneyRatePeriod, TypedLiteral,
};

pub use sql::{
    compile_online_sql_transition_plan, compile_schema_transition_contract,
    compile_sql_artifact_manifest, compile_sql_materialization_plan, render_sql_artifact_bundle,
    RetiredSchemaElement, RetirementKind, SchemaTransitionContract, SchemaTransitionPredecessor,
    SqlArtifact, SqlArtifactKind, SqlArtifactManifest, SqlCompileError, SqlFeatureCoverage,
    SqlOnlineOptionalTextAddition, SqlRuntimeApiCapability,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppManifest {
    pub app_id: String,
    pub customer_id: String,
    pub version: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub connectors: Option<Value>,
    #[serde(default)]
    pub agents: Option<Value>,
    pub models: Vec<ModelManifest>,
    #[serde(default)]
    pub custom_fields: Vec<CustomFieldManifest>,
    #[serde(default)]
    pub change_types: Vec<ChangeTypeManifest>,
    #[serde(default)]
    pub constraints: Vec<ConstraintManifest>,
    #[serde(default)]
    pub authorization: Option<AuthorizationManifest>,
    #[serde(default)]
    pub seed_change_sets: Vec<SeedChangeSetManifest>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthorizationManifest {
    #[serde(default)]
    pub roles: Vec<AuthorizationRoleManifest>,
    #[serde(default)]
    pub grants: Vec<AuthorizationGrantManifest>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthorizationRoleManifest {
    pub id: String,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthorizationGrantManifest {
    pub role: String,
    pub model: String,
    pub operations: Vec<AuthorizationOperation>,
    #[serde(default)]
    pub read_fields: Vec<String>,
    #[serde(default)]
    pub write_fields: Vec<String>,
    #[serde(default)]
    pub read_relations: Vec<String>,
    pub record: AuthorizationRecordPredicate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthorizationOperation {
    Read,
    Create,
    Update,
    Delete,
    History,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AuthorizationRecordPredicate {
    All,
    ActorEqualsField { field: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelManifest {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    pub kind: ManifestModelKind,
    pub label: String,
    #[serde(default)]
    pub display_field_id: Option<String>,
    #[serde(default)]
    pub origin: SchemaElementOrigin,
    #[serde(default)]
    pub management: SchemaManagementPolicy,
    #[serde(default)]
    pub lifecycle: SchemaElementLifecycle,
    #[serde(default)]
    pub extensions: EntityExtensionCapabilities,
    #[serde(default)]
    pub notes: Option<String>,
    pub fields: Vec<FieldManifest>,
    #[serde(default)]
    pub field_groups: Vec<FieldGroupManifest>,
    #[serde(default)]
    pub many_relations: Vec<ManyRelationManifest>,
    #[serde(default)]
    pub inverse_relations: Vec<InverseRelationManifest>,
    #[serde(default)]
    pub derived_fields: Vec<DerivedFieldManifest>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FieldGroupManifest {
    pub id: String,
    pub label: String,
    pub fields: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManyRelationManifest {
    pub id: String,
    pub label: String,
    pub target_model: String,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub origin: SchemaElementOrigin,
    #[serde(default)]
    pub management: SchemaManagementPolicy,
    #[serde(default)]
    pub lifecycle: SchemaElementLifecycle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ManifestModelKind {
    Entity,
    Lookup,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FieldManifest {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    pub label: String,
    #[serde(rename = "type")]
    pub field_type: ManifestFieldType,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub is_unique: bool,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub target_model: Option<String>,
    #[serde(default)]
    pub option_set: Vec<EnumOptionManifest>,
    #[serde(default)]
    pub origin: SchemaElementOrigin,
    #[serde(default)]
    pub management: SchemaManagementPolicy,
    #[serde(default)]
    pub lifecycle: SchemaElementLifecycle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ManifestFieldType {
    Text,
    Number,
    Bool,
    Date,
    Datetime,
    Relation,
    TextList,
    KnownAliases,
    Json,
    Enum,
    IsoCountry,
    IsoCurrency,
    MoneyRate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnumOptionManifest {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub origin: SchemaElementOrigin,
    #[serde(default)]
    pub management: SchemaManagementPolicy,
    #[serde(default)]
    pub lifecycle: SchemaElementLifecycle,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CustomFieldManifest {
    pub id: String,
    pub model: String,
    pub field: String,
    pub label: String,
    #[serde(rename = "type")]
    pub field_type: ManifestCustomFieldType,
    #[serde(default)]
    pub target_model: Option<String>,
    #[serde(default)]
    pub option_set: Vec<EnumOptionManifest>,
    #[serde(default)]
    pub archived_at: Option<String>,
    #[serde(default)]
    pub origin: SchemaElementOrigin,
    #[serde(default)]
    pub management: SchemaManagementPolicy,
    #[serde(default)]
    pub lifecycle: Option<SchemaElementLifecycle>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ManifestCustomFieldType {
    Text,
    Number,
    Bool,
    Date,
    Datetime,
    Relation,
    TextList,
    Enum,
    MoneyRate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChangeTypeManifest {
    pub id: String,
    pub label: String,
    pub model: String,
    #[serde(default)]
    pub touches: Option<Vec<String>>,
    #[serde(default)]
    pub required: Vec<String>,
    #[serde(default)]
    pub is_import_default: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InverseRelationManifest {
    pub id: String,
    pub model: String,
    pub through: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConstraintManifest {
    pub id: String,
    pub label: String,
    pub model: String,
    #[serde(default)]
    pub authority: ConstraintAuthority,
    pub expression: ConstraintExpr,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConstraintAuthority {
    #[default]
    Authoritative,
    Advisory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DerivedFieldManifest {
    pub id: String,
    pub label: String,
    #[serde(rename = "type")]
    pub field_type: ManifestFieldType,
    pub expression: DerivedExpr,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SeedChangeSetManifest {
    pub id: String,
    pub effective_start: String,
    #[serde(default)]
    pub change_type: Option<String>,
    pub actor_id: String,
    pub source_kind: String,
    pub idempotency_key: String,
    #[serde(default)]
    pub notes: Option<String>,
    pub writes: Vec<SeedWriteManifest>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SeedWriteManifest {
    pub model: String,
    #[serde(default)]
    pub record_key: Option<SeedRecordKeyManifest>,
    #[serde(default)]
    pub new_record_id: Option<String>,
    pub values: BTreeMap<String, Value>,
    #[serde(default)]
    pub provenance: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum SeedRecordKeyManifest {
    RecordId(String),
    ExternalKey(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelMetadata {
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    pub notes: Option<String>,
    #[serde(default)]
    pub field_groups: Vec<FieldGroupManifest>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FieldMetadata {
    pub model: String,
    pub field: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    pub notes: Option<String>,
    pub enum_option_notes: Vec<EnumOptionNote>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnumOptionNote {
    pub option: String,
    pub notes: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NormalizedInverseRelation {
    pub owner_model: String,
    pub id: String,
    pub model: String,
    pub through: String,
    pub label: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NormalizedManyRelation {
    pub owner_model: String,
    pub id: String,
    pub label: String,
    pub target_model: String,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NormalizedDerivedField {
    pub model: String,
    pub field: DerivedFieldManifest,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NormalizedManifestExtras {
    pub model_metadata: Vec<ModelMetadata>,
    pub field_metadata: Vec<FieldMetadata>,
    pub inverse_relations: Vec<NormalizedInverseRelation>,
    pub many_relations: Vec<NormalizedManyRelation>,
    pub constraints: Vec<ConstraintManifest>,
    pub derived_fields: Vec<NormalizedDerivedField>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authorization_policy: Option<NormalizedAuthorizationPolicy>,
    pub seed_change_sets: Vec<CompiledSeedChangeSetTemplate>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompiledManifest {
    pub schema: Schema,
    pub extras: NormalizedManifestExtras,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompiledAppArtifact {
    pub schema: Schema,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client: Option<GeneratedAppClientMetadata>,
    pub extras: NormalizedManifestExtras,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GeneratedAppClientMetadata {
    pub id: AppId,
    pub label: String,
    #[serde(default)]
    pub connectors: Value,
    #[serde(default)]
    pub agents: Value,
}

impl CompiledAppArtifact {
    pub fn app_with_schema(&self, schema: Schema) -> Result<App, CompileError> {
        let client = self.client.as_ref().ok_or_else(|| {
            CompileError::new(
                "missing_app_client_metadata",
                "client",
                "generated app artifact does not contain app-owned client metadata",
            )
        })?;
        let app = App {
            id: client.id.clone(),
            label: client.label.clone(),
            schema,
            connectors: client.connectors.clone(),
            agents: client.agents.clone(),
        };
        validate_app(&app).map_err(|error| {
            let issue = error.issues.into_iter().next().expect("validation issue");
            CompileError::new(issue.code, issue.path, issue.message)
        })?;
        Ok(app)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompiledSeedChangeSetTemplate {
    pub seed_identity: String,
    pub seed_record_ids: Vec<uuid::Uuid>,
    pub actor_id: String,
    pub source_kind: String,
    pub idempotency_key: String,
    pub change_type_id: Option<ChangeTypeId>,
    pub notes: Option<String>,
    pub writes: Vec<RowVersionWrite>,
}

impl From<CompiledManifest> for CompiledAppArtifact {
    fn from(compiled: CompiledManifest) -> Self {
        Self {
            schema: compiled.schema,
            client: None,
            extras: compiled.extras,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompileError {
    pub code: &'static str,
    pub path: String,
    pub message: String,
}

impl CompileError {
    fn new(code: &'static str, path: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code,
            path: path.into(),
            message: message.into(),
        }
    }
}

impl fmt::Display for CompileError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.path.is_empty() {
            write!(formatter, "{}: {}", self.code, self.message)
        } else {
            write!(
                formatter,
                "{} at {}: {}",
                self.code, self.path, self.message
            )
        }
    }
}

impl Error for CompileError {}

pub fn compile_manifest_json(manifest_json: &str) -> Result<CompiledManifest, CompileError> {
    compile_manifest(parse_manifest_json(manifest_json)?)
}

pub fn compile_app_artifact_json(manifest_json: &str) -> Result<CompiledAppArtifact, CompileError> {
    let manifest = parse_manifest_json(manifest_json)?;
    let client = match manifest.label.clone() {
        Some(label) => Some(GeneratedAppClientMetadata {
            id: AppId::from(manifest.app_id.as_str()),
            label,
            connectors: manifest.connectors.clone().unwrap_or(Value::Null),
            agents: manifest.agents.clone().unwrap_or(Value::Null),
        }),
        None if manifest.connectors.is_some() || manifest.agents.is_some() => {
            return Err(CompileError::new(
                "missing_app_label",
                "label",
                "app-owned client metadata requires an app label",
            ));
        }
        None => None,
    };
    let compiled = compile_manifest(manifest)?;
    let artifact = CompiledAppArtifact {
        schema: compiled.schema,
        client,
        extras: compiled.extras,
    };
    if artifact.client.is_some() {
        artifact.app_with_schema(artifact.schema.clone())?;
    }
    Ok(artifact)
}

fn parse_manifest_json(manifest_json: &str) -> Result<AppManifest, CompileError> {
    serde_json::from_str::<AppManifest>(manifest_json).map_err(|error| {
        CompileError::new(
            "invalid_manifest_json",
            "manifest",
            format!("manifest JSON does not match AppManifest: {error}"),
        )
    })
}

pub fn compile_manifest(mut manifest: AppManifest) -> Result<CompiledManifest, CompileError> {
    normalize_manifest(&mut manifest)?;

    let model_index = build_model_index(&manifest);
    validate_model_relations(&manifest, &model_index)?;
    validate_custom_fields(&manifest)?;
    validate_change_types(&manifest, &model_index)?;
    validate_inverse_relations(&manifest, &model_index)?;
    validate_constraints(&manifest, &model_index)?;
    validate_authorization(&manifest, &model_index)?;
    validate_derived_fields(&manifest, &model_index)?;
    validate_seed_change_sets(&manifest, &model_index)?;

    let schema = compile_schema(&manifest);
    validate_schema(&schema).map_err(|error| {
        let issue = error.issues.into_iter().next().expect("validation issue");
        CompileError::new(issue.code, issue.path, issue.message)
    })?;

    let seed_change_sets = compile_seed_change_sets(&manifest)?;
    validate_compiled_seed_change_sets(&manifest, &schema, &seed_change_sets)?;
    Ok(CompiledManifest {
        schema,
        extras: compile_extras(manifest, seed_change_sets),
    })
}

fn normalize_manifest(manifest: &mut AppManifest) -> Result<(), CompileError> {
    let mut model_ids = BTreeSet::new();
    for model in &mut manifest.models {
        if !model_ids.insert(model.id.clone()) {
            return Err(CompileError::new(
                "duplicate_model_id",
                format!("models.{}", model.id),
                format!("model `{}` is declared more than once", model.id),
            ));
        }
        let mut field_ids = BTreeSet::new();
        for field in &model.fields {
            let normalized = compiler_identifier(
                &format!("models.{}.fields.{}.id", model.id, field.id),
                &field.id,
            )?;
            if !field_ids.insert(normalized) {
                return Err(CompileError::new(
                    "duplicate_field_id",
                    format!("models.{}.fields.{}", model.id, field.id),
                    format!("field `{}` is declared more than once", field.id),
                ));
            }
        }

        let mut group_ids = BTreeSet::new();
        let mut grouped_field_ids = BTreeSet::new();
        for group in &model.field_groups {
            let group_path = format!("models.{}.field_groups.{}", model.id, group.id);
            let normalized_group_id = compiler_identifier(&format!("{group_path}.id"), &group.id)?;
            if matches!(normalized_group_id.as_str(), "details" | "other" | "custom") {
                return Err(CompileError::new(
                    "reserved_field_group_id",
                    format!("{group_path}.id"),
                    format!(
                        "field group id `{}` is reserved for runtime fallback",
                        group.id
                    ),
                ));
            }
            if !group_ids.insert(normalized_group_id) {
                return Err(CompileError::new(
                    "duplicate_field_group_id",
                    group_path,
                    format!("field group `{}` is declared more than once", group.id),
                ));
            }
            for field_id in &group.fields {
                let normalized_field_id =
                    compiler_identifier(&format!("{group_path}.fields.{field_id}"), field_id)?;
                if !field_ids.contains(&normalized_field_id) {
                    return Err(CompileError::new(
                        "unknown_field_group_field",
                        format!("{group_path}.fields.{field_id}"),
                        format!("field group references unknown field `{field_id}`"),
                    ));
                }
                if !grouped_field_ids.insert(normalized_field_id) {
                    return Err(CompileError::new(
                        "duplicate_field_group_membership",
                        format!("{group_path}.fields.{field_id}"),
                        format!("field `{field_id}` belongs to more than one field group"),
                    ));
                }
            }
        }

        let mut metadata_ids = BTreeSet::new();
        for relation in &model.many_relations {
            let path = format!("models.{}.many_relations.{}.id", model.id, relation.id);
            let normalized = compiler_identifier(&path, &relation.id)?;
            if field_ids.contains(&normalized) {
                return Err(CompileError::new(
                    "many_relation_id_collision",
                    format!("models.{}.many_relations.{}", model.id, relation.id),
                    "many relation id collides with a persisted field",
                ));
            }
            require_unique_metadata_id(&mut metadata_ids, path, normalized)?;
        }
        for inverse in &model.inverse_relations {
            let path = format!("models.{}.inverse_relations.{}.id", model.id, inverse.id);
            let normalized = compiler_identifier(&path, &inverse.id)?;
            if field_ids.contains(&normalized) {
                return Err(CompileError::new(
                    "inverse_relation_id_collision",
                    format!("models.{}.inverse_relations.{}", model.id, inverse.id),
                    "inverse relation id collides with a persisted field",
                ));
            }
            require_unique_metadata_id(&mut metadata_ids, path, normalized)?;
        }
        for derived in &model.derived_fields {
            let path = format!("models.{}.derived_fields.{}.id", model.id, derived.id);
            let normalized = compiler_identifier(&path, &derived.id)?;
            require_unique_metadata_id(&mut metadata_ids, path.clone(), normalized.clone())?;
            if field_ids.contains(&normalized) {
                return Err(CompileError::new(
                    "derived_field_id_collision",
                    format!("models.{}.derived_fields.{}", model.id, derived.id),
                    "derived field id collides with a persisted field",
                ));
            }
        }
    }

    let mut constraint_ids = BTreeSet::new();
    for constraint in &manifest.constraints {
        let path = format!("constraints.{}.id", constraint.id);
        let normalized = compiler_identifier(&path, &constraint.id)?;
        if !constraint_ids.insert(normalized) {
            return Err(CompileError::new(
                "duplicate_constraint_id",
                path,
                "constraint id collides after identifier normalization",
            ));
        }
    }

    normalize_authorization(manifest)?;

    let mut seed_ids = BTreeSet::new();
    for seed in &manifest.seed_change_sets {
        if seed.id.trim().is_empty() {
            continue;
        }
        let path = format!("seed_change_sets.{}.id", seed.id);
        let normalized = compiler_identifier(&path, &seed.id)?;
        if !seed_ids.insert(normalized) {
            return Err(CompileError::new(
                "duplicate_seed_change_set_id",
                path,
                "seed change-set id collides after identifier normalization",
            ));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NormalizedAuthorizationPolicy {
    pub roles: Vec<AuthorizationRoleManifest>,
    pub grants: Vec<AuthorizationGrantManifest>,
    pub relations: Vec<NormalizedAuthorizationRelation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NormalizedAuthorizationRelation {
    pub model: String,
    pub id: String,
    pub target_model: String,
    pub through: String,
}

fn normalize_authorization(manifest: &mut AppManifest) -> Result<(), CompileError> {
    let Some(policy) = manifest.authorization.as_mut() else {
        return Ok(());
    };

    let mut role_ids = BTreeSet::new();
    for role in &mut policy.roles {
        let path = format!("authorization.roles.{}.id", role.id);
        role.id = compiler_identifier(&path, &role.id)?;
        if !role_ids.insert(role.id.clone()) {
            return Err(CompileError::new(
                "duplicate_authorization_role_id",
                path,
                "authorization roles must be unique after identifier normalization",
            ));
        }
    }

    for (grant_index, grant) in policy.grants.iter_mut().enumerate() {
        let path = format!("authorization.grants[{grant_index}]");
        grant.role = compiler_identifier(&format!("{path}.role"), &grant.role)?;
        grant.model = compiler_identifier(&format!("{path}.model"), &grant.model)?;
        normalize_authorization_list(&mut grant.read_fields, &format!("{path}.read_fields"), true)?;
        normalize_authorization_list(
            &mut grant.write_fields,
            &format!("{path}.write_fields"),
            true,
        )?;
        normalize_authorization_list(
            &mut grant.read_relations,
            &format!("{path}.read_relations"),
            false,
        )?;
        if let AuthorizationRecordPredicate::ActorEqualsField { field } = &mut grant.record {
            *field = compiler_identifier(&format!("{path}.record.field"), field)?;
        }
        // Logical IDs remain lossless in Schema; normalized spelling is only a
        // reference lookup aid, never a replacement for the declared identity.
        if let Some(model) = manifest
            .models
            .iter()
            .find(|model| normalize_identifier(&model.id).is_ok_and(|id| id == grant.model))
        {
            grant.model.clone_from(&model.id);
            let field_ids = model
                .fields
                .iter()
                .map(|field| field.id.as_str())
                .chain(
                    model
                        .many_relations
                        .iter()
                        .map(|relation| relation.id.as_str()),
                )
                .chain(model.derived_fields.iter().map(|field| field.id.as_str()))
                .chain(
                    manifest
                        .custom_fields
                        .iter()
                        .filter(|field| field.model == model.id)
                        .map(|field| field.field.as_str()),
                )
                .collect::<Vec<_>>();
            for field in grant.read_fields.iter_mut().chain(&mut grant.write_fields) {
                resolve_authorization_identity(field, &field_ids);
            }
            let relation_ids = model
                .inverse_relations
                .iter()
                .map(|relation| relation.id.as_str())
                .chain(
                    model
                        .many_relations
                        .iter()
                        .map(|relation| relation.id.as_str()),
                )
                .collect::<Vec<_>>();
            for relation in &mut grant.read_relations {
                resolve_authorization_identity(relation, &relation_ids);
            }
            if let AuthorizationRecordPredicate::ActorEqualsField { field } = &mut grant.record {
                resolve_authorization_identity(field, &field_ids);
            }
        }
        require_unique_authorization_items(
            &grant.operations,
            &format!("{path}.operations"),
            "duplicate_authorization_operation",
        )?;
    }

    policy.roles.sort_by(|left, right| left.id.cmp(&right.id));
    for grant in &mut policy.grants {
        grant.operations.sort();
        grant.read_fields.sort();
        grant.write_fields.sort();
        grant.read_relations.sort();
    }
    policy.grants.sort_by(|left, right| {
        serde_json::to_string(left)
            .expect("authorization grants serialize")
            .cmp(&serde_json::to_string(right).expect("authorization grants serialize"))
    });
    let mut grants = BTreeSet::new();
    for grant in &policy.grants {
        let encoded = serde_json::to_string(grant).expect("authorization grants serialize");
        if !grants.insert(encoded) {
            return Err(CompileError::new(
                "duplicate_authorization_grant",
                "authorization.grants",
                "authorization grants must be unique after canonical sorting",
            ));
        }
    }
    Ok(())
}

fn resolve_authorization_identity(value: &mut String, declarations: &[&str]) {
    if let Some(declared) = declarations
        .iter()
        .find(|id| normalize_identifier(id).is_ok_and(|normalized| normalized == *value))
    {
        *value = (*declared).to_string();
    }
}

fn normalize_authorization_list(
    values: &mut [String],
    path: &str,
    allow_metadata: bool,
) -> Result<(), CompileError> {
    for value in values.iter_mut() {
        if allow_metadata && authorization_metadata_id(value).is_some() {
            continue;
        }
        *value = compiler_identifier(&format!("{path}.{value}"), value)?;
    }
    if values.iter().collect::<BTreeSet<_>>().len() != values.len() {
        return Err(CompileError::new(
            "duplicate_authorization_reference",
            path,
            "authorization field and relation references must be unique",
        ));
    }
    Ok(())
}

fn require_unique_authorization_items<T: Ord>(
    values: &[T],
    path: &str,
    code: &'static str,
) -> Result<(), CompileError> {
    if values.iter().collect::<BTreeSet<_>>().len() == values.len() {
        Ok(())
    } else {
        Err(CompileError::new(
            code,
            path,
            "authorization grant values must be unique",
        ))
    }
}

fn authorization_metadata_id(value: &str) -> Option<()> {
    matches!(
        value,
        "$id" | "$externalKey" | "$version" | "$effectiveStart" | "$effectiveEnd" | "$metadata"
    )
    .then_some(())
}

fn validate_authorization(
    manifest: &AppManifest,
    index: &ModelIndex<'_>,
) -> Result<(), CompileError> {
    let Some(policy) = manifest.authorization.as_ref() else {
        return Ok(());
    };
    let roles = policy
        .roles
        .iter()
        .map(|role| role.id.as_str())
        .collect::<BTreeSet<_>>();
    for (grant_index, grant) in policy.grants.iter().enumerate() {
        let path = format!("authorization.grants[{grant_index}]");
        if !roles.contains(grant.role.as_str()) {
            return Err(CompileError::new(
                "unknown_authorization_role",
                format!("{path}.role"),
                format!("role `{}` is not declared", grant.role),
            ));
        }
        if grant.operations.is_empty() {
            return Err(CompileError::new(
                "empty_authorization_operations",
                format!("{path}.operations"),
                "authorization grants must declare at least one operation",
            ));
        }
        let (model, fields) = index.get(grant.model.as_str()).ok_or_else(|| {
            CompileError::new(
                "unknown_authorization_model",
                format!("{path}.model"),
                format!("model `{}` is not declared", grant.model),
            )
        })?;
        if model.lifecycle != SchemaElementLifecycle::Active {
            return Err(CompileError::new(
                "inactive_authorization_model",
                format!("{path}.model"),
                "authorization grants may only reference active models",
            ));
        }
        let reads = grant.operations.contains(&AuthorizationOperation::Read)
            || grant.operations.contains(&AuthorizationOperation::History);
        let writes = grant.operations.contains(&AuthorizationOperation::Create)
            || grant.operations.contains(&AuthorizationOperation::Update);
        if !grant.read_fields.is_empty() && !reads {
            return Err(CompileError::new(
                "inapplicable_authorization_read_fields",
                format!("{path}.read_fields"),
                "read_fields require read or history permission",
            ));
        }
        if !grant.write_fields.is_empty() && !writes {
            return Err(CompileError::new(
                "inapplicable_authorization_write_fields",
                format!("{path}.write_fields"),
                "write_fields require create or update permission",
            ));
        }
        if !grant.read_relations.is_empty()
            && !grant.operations.contains(&AuthorizationOperation::Read)
        {
            return Err(CompileError::new(
                "inapplicable_authorization_read_relations",
                format!("{path}.read_relations"),
                "read_relations require read permission",
            ));
        }
        validate_authorization_fields(
            manifest,
            model,
            fields,
            &grant.read_fields,
            false,
            &format!("{path}.read_fields"),
        )?;
        validate_authorization_fields(
            manifest,
            model,
            fields,
            &grant.write_fields,
            true,
            &format!("{path}.write_fields"),
        )?;
        validate_authorization_relations(
            index,
            model,
            &grant.read_relations,
            &format!("{path}.read_relations"),
        )?;
        if let AuthorizationRecordPredicate::ActorEqualsField { field } = &grant.record {
            let owner = fields.get(field.as_str()).ok_or_else(|| {
                CompileError::new(
                    "unknown_authorization_owner_field",
                    format!("{path}.record.field"),
                    format!("field `{field}` is not declared"),
                )
            })?;
            if owner.field_type != ManifestFieldType::Text
                || !owner.required
                || owner.lifecycle != SchemaElementLifecycle::Active
            {
                return Err(CompileError::new(
                    "invalid_authorization_owner_field",
                    format!("{path}.record.field"),
                    "actor_equals_field requires an active required text field",
                ));
            }
        }
    }
    Ok(())
}

fn validate_authorization_fields(
    manifest: &AppManifest,
    model: &ModelManifest,
    fields: &BTreeMap<&str, &FieldManifest>,
    values: &[String],
    writing: bool,
    path: &str,
) -> Result<(), CompileError> {
    for value in values {
        if authorization_metadata_id(value).is_some() {
            if !writing {
                continue;
            }
            if value == "$metadata" && model.extensions.record_metadata.is_some() {
                continue;
            }
            return Err(CompileError::new(
                "readonly_authorization_field",
                format!("{path}.{value}"),
                "write_fields may only include $metadata when record metadata is enabled",
            ));
        }
        if let Some(field) = fields.get(value.as_str()) {
            if field.lifecycle == SchemaElementLifecycle::Active {
                continue;
            }
            return Err(CompileError::new(
                "inactive_authorization_field",
                format!("{path}.{value}"),
                "authorization grants may only reference active fields",
            ));
        }
        if model.derived_fields.iter().any(|field| field.id == *value) {
            return Err(CompileError::new(
                "unsupported_authorization_field_projection",
                format!("{path}.{value}"),
                "derived fields are unsupported by generated authorization projections",
            ));
        }
        if let Some(relation) = model
            .many_relations
            .iter()
            .find(|relation| relation.id == *value)
        {
            if relation.lifecycle == SchemaElementLifecycle::Active
                && (!writing || model.kind == ManifestModelKind::Lookup)
            {
                continue;
            }
            if writing {
                return Err(CompileError::new(
                    "unsupported_authorization_field",
                    format!("{path}.{value}"),
                    "many relation writes are only supported for lookup models",
                ));
            }
            if relation.lifecycle == SchemaElementLifecycle::Active {
                continue;
            }
            return Err(CompileError::new(
                "inactive_authorization_field",
                format!("{path}.{value}"),
                "authorization grants may only reference active many relations",
            ));
        }
        if manifest.custom_fields.iter().any(|field| {
            field.model == model.id
                && field.field == *value
                && field.lifecycle.unwrap_or(if field.archived_at.is_some() {
                    SchemaElementLifecycle::Retired
                } else {
                    SchemaElementLifecycle::Active
                }) == SchemaElementLifecycle::Active
        }) {
            continue;
        }
        return Err(CompileError::new(
            "unknown_authorization_field",
            format!("{path}.{value}"),
            format!("field `{value}` is not declared for model `{}`", model.id),
        ));
    }
    Ok(())
}

fn validate_authorization_relations(
    index: &ModelIndex<'_>,
    model: &ModelManifest,
    values: &[String],
    path: &str,
) -> Result<(), CompileError> {
    for value in values {
        if model
            .many_relations
            .iter()
            .any(|relation| relation.id == *value)
        {
            return Err(CompileError::new(
                "unsupported_authorization_relation",
                format!("{path}.{value}"),
                "many relations are authorized through read_fields and cannot be navigated",
            ));
        }
        if let Some(relation) = model
            .inverse_relations
            .iter()
            .find(|relation| relation.id == *value)
        {
            let Some((target_model, target_fields)) = index.get(relation.model.as_str()) else {
                return Err(CompileError::new(
                    "unknown_authorization_relation",
                    format!("{path}.{value}"),
                    "inverse relation target model is unavailable",
                ));
            };
            let Some(through) = target_fields.get(relation.through.as_str()) else {
                return Err(CompileError::new(
                    "unknown_authorization_relation",
                    format!("{path}.{value}"),
                    "inverse relation through field is unavailable",
                ));
            };
            if target_model.lifecycle == SchemaElementLifecycle::Active
                && through.lifecycle == SchemaElementLifecycle::Active
            {
                continue;
            }
            return Err(CompileError::new(
                "inactive_authorization_relation",
                format!("{path}.{value}"),
                "authorization grants may only reference active inverse relations",
            ));
        }
        return Err(CompileError::new(
            "unknown_authorization_relation",
            format!("{path}.{value}"),
            format!(
                "relation `{value}` is not declared for model `{}`",
                model.id
            ),
        ));
    }
    Ok(())
}

fn require_unique_metadata_id(
    ids: &mut BTreeSet<String>,
    path: String,
    normalized: String,
) -> Result<(), CompileError> {
    if ids.insert(normalized) {
        Ok(())
    } else {
        Err(CompileError::new(
            "duplicate_model_metadata_id",
            path,
            "relation and derived field ids must be unique after identifier normalization",
        ))
    }
}

fn compiler_identifier(path: &str, value: &str) -> Result<String, CompileError> {
    normalize_identifier(value).map_err(|issue| CompileError::new(issue.code, path, issue.message))
}

type ModelIndex<'a> = BTreeMap<&'a str, (&'a ModelManifest, BTreeMap<&'a str, &'a FieldManifest>)>;

fn build_model_index(manifest: &AppManifest) -> ModelIndex<'_> {
    manifest
        .models
        .iter()
        .map(|model| {
            let fields = model
                .fields
                .iter()
                .map(|field| (field.id.as_str(), field))
                .collect();
            (model.id.as_str(), (model, fields))
        })
        .collect()
}

fn validate_model_relations(
    manifest: &AppManifest,
    index: &ModelIndex<'_>,
) -> Result<(), CompileError> {
    for model in &manifest.models {
        for field in &model.fields {
            if field.field_type != ManifestFieldType::Relation {
                continue;
            }
            let path = format!("models.{}.fields.{}.target_model", model.id, field.id);
            let target_model = field
                .target_model
                .as_deref()
                .filter(|target| !target.is_empty())
                .ok_or_else(|| {
                    CompileError::new(
                        "missing_relation_target",
                        &path,
                        "relation fields must declare target_model",
                    )
                })?;
            if !index.contains_key(target_model) {
                return Err(CompileError::new(
                    "unknown_relation_target",
                    path,
                    format!("model `{target_model}` is not declared"),
                ));
            }
        }
        for relation in &model.many_relations {
            if !index.contains_key(relation.target_model.as_str()) {
                return Err(CompileError::new(
                    "unknown_many_relation_target",
                    format!(
                        "models.{}.many_relations.{}.target_model",
                        model.id, relation.id
                    ),
                    format!("model `{}` is not declared", relation.target_model),
                ));
            }
        }
    }
    Ok(())
}

fn validate_custom_fields(manifest: &AppManifest) -> Result<(), CompileError> {
    for (index, field) in manifest.custom_fields.iter().enumerate() {
        if let Some(archived_at) = &field.archived_at {
            DateTime::parse_from_rfc3339(archived_at).map_err(|_| {
                CompileError::new(
                    "invalid_custom_field_archived_at",
                    format!("custom_fields[{index}].archived_at"),
                    "archived_at must be an RFC 3339 timestamp",
                )
            })?;
        }
    }
    Ok(())
}

fn validate_inverse_relations(
    manifest: &AppManifest,
    index: &ModelIndex<'_>,
) -> Result<(), CompileError> {
    for owner in &manifest.models {
        for inverse in &owner.inverse_relations {
            let path = format!("models.{}.inverse_relations.{}", owner.id, inverse.id);
            let (_, fields) = index.get(inverse.model.as_str()).ok_or_else(|| {
                CompileError::new(
                    "unknown_inverse_model",
                    format!("{path}.model"),
                    format!("model `{}` is not declared", inverse.model),
                )
            })?;
            let through = fields.get(inverse.through.as_str()).ok_or_else(|| {
                CompileError::new(
                    "unknown_inverse_through_field",
                    format!("{path}.through"),
                    format!(
                        "field `{}.{}` is not declared",
                        inverse.model, inverse.through
                    ),
                )
            })?;
            if through.field_type != ManifestFieldType::Relation
                || through.target_model.as_deref() != Some(owner.id.as_str())
            {
                return Err(CompileError::new(
                    "invalid_inverse_relation",
                    format!("{path}.through"),
                    format!(
                        "`{}.{}` must be a scalar relation targeting `{}`",
                        inverse.model, inverse.through, owner.id
                    ),
                ));
            }
        }
    }
    Ok(())
}

fn validate_change_types(
    manifest: &AppManifest,
    index: &ModelIndex<'_>,
) -> Result<(), CompileError> {
    let mut ids = BTreeSet::new();
    for change_type in &manifest.change_types {
        let path = format!("change_types.{}", change_type.id);
        if !ids.insert(change_type.id.as_str()) {
            return Err(CompileError::new(
                "duplicate_change_type_id",
                path,
                "change type id is declared more than once",
            ));
        }
        let (_, fields) = index.get(change_type.model.as_str()).ok_or_else(|| {
            CompileError::new(
                "unknown_change_type_model",
                format!("{path}.model"),
                format!("model `{}` is not declared", change_type.model),
            )
        })?;
        for (property, field_ids) in [
            (
                "touches",
                change_type.touches.as_deref().unwrap_or_default(),
            ),
            ("required", change_type.required.as_slice()),
        ] {
            let mut seen = BTreeSet::new();
            for field_id in field_ids {
                require_field(fields, field_id, &format!("{path}.{property}.{field_id}"))?;
                if !seen.insert(field_id) {
                    return Err(CompileError::new(
                        "duplicate_change_type_field",
                        format!("{path}.{property}.{field_id}"),
                        "change type field is declared more than once",
                    ));
                }
            }
        }
    }
    Ok(())
}

fn validate_constraints(
    manifest: &AppManifest,
    index: &ModelIndex<'_>,
) -> Result<(), CompileError> {
    let mut ids = BTreeSet::new();
    for constraint in &manifest.constraints {
        if !ids.insert(constraint.id.as_str()) {
            return Err(CompileError::new(
                "duplicate_constraint_id",
                format!("constraints.{}", constraint.id),
                "constraint id is declared more than once",
            ));
        }
        let (model, fields) = index.get(constraint.model.as_str()).ok_or_else(|| {
            CompileError::new(
                "unknown_constraint_model",
                format!("constraints.{}.model", constraint.id),
                format!("model `{}` is not declared", constraint.model),
            )
        })?;
        let path = format!("constraints.{}.expression", constraint.id);
        if let ConstraintExpr::NonOverlappingIntervals {
            start,
            end,
            subjects,
        } = &constraint.expression
        {
            validate_non_overlapping_intervals(model, fields, start, end, subjects, &path)?;
        } else {
            validate_constraint_expr(&constraint.expression, fields, &path)?;
        }
    }
    Ok(())
}

fn validate_non_overlapping_intervals(
    model: &ModelManifest,
    fields: &BTreeMap<&str, &FieldManifest>,
    start: &str,
    end: &str,
    subjects: &[Vec<String>],
    path: &str,
) -> Result<(), CompileError> {
    if model.kind != ManifestModelKind::Entity {
        return Err(CompileError::new(
            "unsupported_interval_constraint_model",
            path,
            "non_overlapping_intervals is supported only on entity models",
        ));
    }
    let start_field = require_field(fields, start, &format!("{path}.start"))?;
    if start_field.field_type != ManifestFieldType::Date || !start_field.required {
        return Err(type_error(
            format!("{path}.start"),
            "non_overlapping_intervals start must be a required date field",
        ));
    }
    if require_field(fields, end, &format!("{path}.end"))?.field_type != ManifestFieldType::Date
        || end == start
    {
        return Err(type_error(
            format!("{path}.end"),
            "non_overlapping_intervals end must be a date field distinct from start",
        ));
    }
    if subjects.is_empty() {
        return Err(CompileError::new(
            "empty_field_set",
            format!("{path}.subjects"),
            "non_overlapping_intervals must name at least one subject field set",
        ));
    }
    let mut seen_subjects = BTreeSet::new();
    for (index, subject) in subjects.iter().enumerate() {
        let subject_path = format!("{path}.subjects[{index}]");
        let unique_fields = subject.iter().collect::<BTreeSet<_>>();
        if subject.is_empty() || unique_fields.len() != subject.len() {
            return Err(CompileError::new(
                "invalid_interval_subject",
                subject_path,
                "each subject field set must name one or more distinct fields",
            ));
        }
        if !seen_subjects.insert(unique_fields) {
            return Err(CompileError::new(
                "duplicate_interval_subject",
                subject_path,
                "subject field sets must be distinct",
            ));
        }
        for field_id in subject {
            let field = require_field(fields, field_id, &subject_path)?;
            if field_id == start
                || field_id == end
                || matches!(
                    field.field_type,
                    ManifestFieldType::TextList
                        | ManifestFieldType::KnownAliases
                        | ManifestFieldType::Json
                        | ManifestFieldType::MoneyRate
                )
            {
                return Err(type_error(
                    subject_path,
                    format!(
                        "subject field `{field_id}` must be a single-column scalar field other than the interval bounds"
                    ),
                ));
            }
        }
    }
    Ok(())
}

fn validate_constraint_expr(
    expression: &ConstraintExpr,
    fields: &BTreeMap<&str, &FieldManifest>,
    path: &str,
) -> Result<(), CompileError> {
    match expression {
        ConstraintExpr::And { expressions } | ConstraintExpr::Or { expressions } => {
            if expressions.is_empty() {
                return Err(CompileError::new(
                    "empty_boolean_expression",
                    path,
                    "boolean expressions must contain at least one expression",
                ));
            }
            for (index, expression) in expressions.iter().enumerate() {
                validate_constraint_expr(expression, fields, &format!("{path}[{index}]"))?;
            }
        }
        ConstraintExpr::Not { expression } => {
            validate_constraint_expr(expression, fields, path)?;
        }
        ConstraintExpr::FieldPresent { field } | ConstraintExpr::FieldAbsent { field } => {
            require_field(fields, field, path)?;
        }
        ConstraintExpr::CountPresent {
            fields: field_ids,
            min,
            max,
        } => {
            if field_ids.is_empty() {
                return Err(CompileError::new(
                    "empty_field_set",
                    path,
                    "count_present must name at least one field",
                ));
            }
            if min.is_none() && max.is_none() {
                return Err(CompileError::new(
                    "missing_count_bound",
                    path,
                    "count_present must declare min, max, or both",
                ));
            }
            if min.zip(*max).is_some_and(|(min, max)| min > max) {
                return Err(CompileError::new(
                    "invalid_count_range",
                    path,
                    "count_present min cannot exceed max",
                ));
            }
            let unique_fields = field_ids.iter().collect::<BTreeSet<_>>();
            if unique_fields.len() != field_ids.len() {
                return Err(CompileError::new(
                    "duplicate_count_field",
                    path,
                    "count_present fields must be unique",
                ));
            }
            if min.is_some_and(|bound| bound as usize > field_ids.len())
                || max.is_some_and(|bound| bound as usize > field_ids.len())
            {
                return Err(CompileError::new(
                    "invalid_count_bound",
                    path,
                    "count_present bounds cannot exceed the number of fields",
                ));
            }
            for field in field_ids {
                require_field(fields, field, path)?;
            }
        }
        ConstraintExpr::CompareFields { left, op, right } => {
            let left_type = require_field(fields, left, path)?.field_type;
            let right_type = require_field(fields, right, path)?.field_type;
            if left_type != right_type || !comparison_supported(left_type, *op) {
                return Err(type_error(
                    path,
                    format!(
                        "cannot compare fields `{left}` ({left_type:?}) and `{right}` ({right_type:?}) with `{op:?}`"
                    ),
                ));
            }
        }
        ConstraintExpr::CompareLiteral { field, op, value } => {
            let field = require_field(fields, field, path)?;
            if !literal_matches(field.field_type, value)
                || !comparison_supported(field.field_type, *op)
                || !literal_value_is_valid(field, value)
            {
                return Err(type_error(
                    path,
                    format!(
                        "literal type or value does not match field `{}` ({:?})",
                        field.id, field.field_type
                    ),
                ));
            }
        }
        ConstraintExpr::FieldIn { field, values } => {
            let field = require_field(fields, field, path)?;
            if values.is_empty()
                || values.iter().any(|value| {
                    !literal_matches(field.field_type, value)
                        || !literal_value_is_valid(field, value)
                })
            {
                return Err(type_error(
                    path,
                    format!(
                        "field_in values must be a non-empty set matching field `{}` ({:?})",
                        field.id, field.field_type
                    ),
                ));
            }
        }
        ConstraintExpr::FieldSetContains { field, .. } => {
            let field_type = require_field(fields, field, path)?.field_type;
            if !matches!(
                field_type,
                ManifestFieldType::TextList | ManifestFieldType::KnownAliases
            ) {
                return Err(type_error(
                    path,
                    format!(
                        "field_set_contains requires a text_list or known_aliases field, got `{field}` ({field_type:?})"
                    ),
                ));
            }
        }
        ConstraintExpr::TextLength { field, min, max } => {
            let field_type = require_field(fields, field, path)?.field_type;
            if field_type != ManifestFieldType::Text {
                return Err(type_error(path, "text_length requires a text field"));
            }
            if min.is_none() && max.is_none() {
                return Err(CompileError::new(
                    "missing_text_length_bound",
                    path,
                    "text_length must declare min, max, or both",
                ));
            }
            if min
                .zip(*max)
                .is_some_and(|(minimum, maximum)| minimum > maximum)
            {
                return Err(CompileError::new(
                    "invalid_text_length_range",
                    path,
                    "text_length min cannot exceed max",
                ));
            }
        }
        ConstraintExpr::TextStartsWith { field, value } => {
            if require_field(fields, field, path)?.field_type != ManifestFieldType::Text {
                return Err(type_error(path, "text_starts_with requires a text field"));
            }
            if value.is_empty() {
                return Err(CompileError::new(
                    "empty_text_prefix",
                    path,
                    "text_starts_with requires a non-empty literal prefix",
                ));
            }
        }
        ConstraintExpr::NonOverlappingIntervals { .. } => {
            return Err(CompileError::new(
                "non_root_interval_constraint",
                path,
                "non_overlapping_intervals must be the root expression of a model constraint",
            ));
        }
    }
    Ok(())
}

/// Shared bounds for derived expressions with referenced derived fields
/// expanded. The SQL runtime and TypeScript evaluator enforce the same limits.
const MAX_DERIVED_EXPRESSION_NODES: usize = 256;
const MAX_DERIVED_EXPRESSION_DEPTH: usize = 32;

fn validate_derived_fields(
    manifest: &AppManifest,
    index: &ModelIndex<'_>,
) -> Result<(), CompileError> {
    for model in &manifest.models {
        let (_, fields) = index.get(model.id.as_str()).expect("indexed model");
        for derived in &model.derived_fields {
            let path = format!("models.{}.derived_fields.{}", model.id, derived.id);
            let mut scope = DerivedScope {
                manifest,
                index,
                model,
                fields,
                custom_fields: active_custom_field_types(manifest, &model.id),
                nodes: 0,
                visiting: vec![derived.id.as_str()],
            };
            let inferred = scope.infer(&derived.expression, 1, &path)?;
            if !matches!(
                inferred,
                ManifestFieldType::Text
                    | ManifestFieldType::Number
                    | ManifestFieldType::Bool
                    | ManifestFieldType::Date
                    | ManifestFieldType::Datetime
                    | ManifestFieldType::MoneyRate
            ) {
                return Err(CompileError::new(
                    "unsupported_derived_type",
                    format!("{path}.type"),
                    "derived fields evaluate to text, number, bool, date, datetime, or money_rate",
                ));
            }
            if inferred != derived.field_type {
                return Err(type_error(
                    format!("{path}.type"),
                    format!(
                        "declared type `{:?}` does not match expression type `{:?}`",
                        derived.field_type, inferred
                    ),
                ));
            }
        }
    }
    Ok(())
}

/// Active manifest custom fields of one model by field id, using the same
/// effective lifecycle (explicit lifecycle, else `archived_at`) as the runtime.
fn active_custom_field_types<'a>(
    manifest: &'a AppManifest,
    model_id: &str,
) -> BTreeMap<&'a str, ManifestFieldType> {
    manifest
        .custom_fields
        .iter()
        .filter(|field| {
            field.model == model_id
                && field.lifecycle.unwrap_or(if field.archived_at.is_some() {
                    SchemaElementLifecycle::Retired
                } else {
                    SchemaElementLifecycle::Active
                }) == SchemaElementLifecycle::Active
        })
        .map(|field| {
            let field_type = match field.field_type {
                ManifestCustomFieldType::Text => ManifestFieldType::Text,
                ManifestCustomFieldType::Number => ManifestFieldType::Number,
                ManifestCustomFieldType::Bool => ManifestFieldType::Bool,
                ManifestCustomFieldType::Date => ManifestFieldType::Date,
                ManifestCustomFieldType::Datetime => ManifestFieldType::Datetime,
                ManifestCustomFieldType::Relation => ManifestFieldType::Relation,
                ManifestCustomFieldType::TextList => ManifestFieldType::TextList,
                ManifestCustomFieldType::Enum => ManifestFieldType::Enum,
                ManifestCustomFieldType::MoneyRate => ManifestFieldType::MoneyRate,
            };
            (field.field.as_str(), field_type)
        })
        .collect()
}

/// Type inference for one derived field. Field references resolve to active
/// declared fields, active custom fields or, by expansion, to other derived
/// fields on the same model. A relation field reads one active stored field
/// of the related record through an active declared relation.
struct DerivedScope<'a> {
    manifest: &'a AppManifest,
    index: &'a ModelIndex<'a>,
    model: &'a ModelManifest,
    fields: &'a BTreeMap<&'a str, &'a FieldManifest>,
    custom_fields: BTreeMap<&'a str, ManifestFieldType>,
    nodes: usize,
    visiting: Vec<&'a str>,
}

impl<'a> DerivedScope<'a> {
    fn infer(
        &mut self,
        expression: &'a DerivedExpr,
        depth: usize,
        path: &str,
    ) -> Result<ManifestFieldType, CompileError> {
        self.nodes += 1;
        if self.nodes > MAX_DERIVED_EXPRESSION_NODES || depth > MAX_DERIVED_EXPRESSION_DEPTH {
            return Err(CompileError::new(
                "derived_expression_too_large",
                path,
                "derived expressions are limited to 256 nodes and depth 32 after expanding referenced derived fields",
            ));
        }
        match expression {
            DerivedExpr::Field { field } => {
                if let Some(persisted) = self.fields.get(field.as_str()) {
                    if persisted.lifecycle == SchemaElementLifecycle::Active {
                        return Ok(persisted.field_type);
                    }
                    return Err(CompileError::new(
                        "unknown_field",
                        path,
                        format!("field `{field}` is not an active field on the model"),
                    ));
                }
                if let Some(custom) = self.custom_fields.get(field.as_str()) {
                    return Ok(*custom);
                }
                let derived = self
                    .model
                    .derived_fields
                    .iter()
                    .find(|derived| derived.id == *field)
                    .ok_or_else(|| {
                        CompileError::new(
                            "unknown_field",
                            path,
                            format!("field `{field}` is not declared on the model"),
                        )
                    })?;
                if self.visiting.contains(&derived.id.as_str()) {
                    return Err(CompileError::new(
                        "derived_cycle",
                        path,
                        format!("derived field `{field}` references itself"),
                    ));
                }
                self.visiting.push(derived.id.as_str());
                let inferred = self.infer(&derived.expression, depth + 1, path)?;
                self.visiting.pop();
                Ok(inferred)
            }
            DerivedExpr::Literal { value } => {
                if matches!(
                    value,
                    TypedLiteral::Enum(_)
                        | TypedLiteral::IsoCountry(_)
                        | TypedLiteral::IsoCurrency(_)
                ) {
                    return Err(CompileError::new(
                        "unsupported_derived_type",
                        path,
                        "derived literals are text, number, bool, date, or datetime",
                    ));
                }
                if !derived_literal_is_valid(value) {
                    return Err(type_error(path, "derived literal value is invalid"));
                }
                Ok(literal_type(value))
            }
            DerivedExpr::Coalesce { expressions } => {
                let mut expressions = expressions.iter();
                let first = expressions.next().ok_or_else(|| {
                    CompileError::new(
                        "empty_derived_expression",
                        path,
                        "coalesce must contain at least one expression",
                    )
                })?;
                let expected = self.infer(first, depth + 1, path)?;
                for expression in expressions {
                    if self.infer(expression, depth + 1, path)? != expected {
                        return Err(type_error(path, "coalesce expressions must have one type"));
                    }
                }
                Ok(expected)
            }
            DerivedExpr::Concat { expressions } => {
                if expressions.is_empty() {
                    return Err(CompileError::new(
                        "empty_derived_expression",
                        path,
                        "concat must contain at least one expression",
                    ));
                }
                for expression in expressions {
                    if self.infer(expression, depth + 1, path)? != ManifestFieldType::Text {
                        return Err(type_error(path, "concat expressions must be text"));
                    }
                }
                Ok(ManifestFieldType::Text)
            }
            DerivedExpr::Add { left, right } | DerivedExpr::Subtract { left, right } => {
                let left_type = self.infer(left, depth + 1, path)?;
                let right_type = self.infer(right, depth + 1, path)?;
                if left_type == right_type
                    && matches!(
                        left_type,
                        ManifestFieldType::Number | ManifestFieldType::MoneyRate
                    )
                {
                    Ok(left_type)
                } else {
                    Err(type_error(
                        path,
                        "add/subtract requires matching number or money_rate operands",
                    ))
                }
            }
            DerivedExpr::Multiply { left, right } | DerivedExpr::Divide { left, right } => {
                let left_type = self.infer(left, depth + 1, path)?;
                let right_type = self.infer(right, depth + 1, path)?;
                match (expression, left_type, right_type) {
                    (_, ManifestFieldType::Number, ManifestFieldType::Number)
                    | (
                        DerivedExpr::Divide { .. },
                        ManifestFieldType::MoneyRate,
                        ManifestFieldType::MoneyRate,
                    ) => Ok(ManifestFieldType::Number),
                    (
                        DerivedExpr::Multiply { .. },
                        ManifestFieldType::MoneyRate,
                        ManifestFieldType::Number,
                    )
                    | (
                        DerivedExpr::Multiply { .. },
                        ManifestFieldType::Number,
                        ManifestFieldType::MoneyRate,
                    )
                    | (
                        DerivedExpr::Divide { .. },
                        ManifestFieldType::MoneyRate,
                        ManifestFieldType::Number,
                    ) => Ok(ManifestFieldType::MoneyRate),
                    _ => Err(type_error(
                        path,
                        "multiply/divide operands are not a supported number or money_rate combination",
                    )),
                }
            }
            DerivedExpr::NormalizeMoneyRate { expression, .. } => {
                if self.infer(expression, depth + 1, path)? != ManifestFieldType::MoneyRate {
                    return Err(type_error(
                        path,
                        "normalize_money_rate requires money_rate input",
                    ));
                }
                Ok(ManifestFieldType::MoneyRate)
            }
            DerivedExpr::RelationField { relation, field } => {
                let target = self
                    .fields
                    .get(relation.as_str())
                    .filter(|relation| {
                        relation.lifecycle == SchemaElementLifecycle::Active
                            && relation.field_type == ManifestFieldType::Relation
                    })
                    .and_then(|relation| relation.target_model.as_deref())
                    .and_then(|target| self.index.get(target))
                    .ok_or_else(|| {
                        CompileError::new(
                            "unknown_field",
                            path,
                            format!("`{relation}` is not an active relation field on the model"),
                        )
                    })?;
                if let Some(persisted) = target.1.get(field.as_str()) {
                    if persisted.lifecycle == SchemaElementLifecycle::Active {
                        return Ok(persisted.field_type);
                    }
                }
                active_custom_field_types(self.manifest, &target.0.id)
                    .get(field.as_str())
                    .copied()
                    .ok_or_else(|| {
                        CompileError::new(
                            "unknown_field",
                            path,
                            format!("field `{field}` is not an active stored field on the related model"),
                        )
                    })
            }
            DerivedExpr::Parameter { .. } => Err(CompileError::new(
                "unsupported_derived_expression",
                path,
                "parameters are valid only in working-session rules",
            )),
            DerivedExpr::Compare { op, left, right } => {
                let left_type = self.infer(left, depth + 1, path)?;
                let right_type = self.infer(right, depth + 1, path)?;
                let comparable = match op {
                    Comparison::Eq | Comparison::NotEq => matches!(
                        left_type,
                        ManifestFieldType::Text
                            | ManifestFieldType::Number
                            | ManifestFieldType::Bool
                            | ManifestFieldType::Date
                            | ManifestFieldType::Datetime
                            | ManifestFieldType::MoneyRate
                    ),
                    _ => matches!(
                        left_type,
                        ManifestFieldType::Number
                            | ManifestFieldType::Date
                            | ManifestFieldType::Datetime
                            | ManifestFieldType::MoneyRate
                    ),
                };
                if left_type == right_type && comparable {
                    Ok(ManifestFieldType::Bool)
                } else {
                    Err(type_error(
                        path,
                        "compare requires matching comparable operands",
                    ))
                }
            }
            DerivedExpr::If {
                condition,
                then_expression,
                else_expression,
            } => {
                if self.infer(condition, depth + 1, path)? != ManifestFieldType::Bool {
                    return Err(type_error(path, "if condition must be bool"));
                }
                let then_type = self.infer(then_expression, depth + 1, path)?;
                if self.infer(else_expression, depth + 1, path)? != then_type {
                    return Err(type_error(path, "if branches must have one type"));
                }
                Ok(then_type)
            }
            DerivedExpr::Min { left, right } | DerivedExpr::Max { left, right } => {
                self.infer_same_amount(&[left, right], depth, path, "min/max")
            }
            DerivedExpr::Clamp {
                expression,
                min,
                max,
            } => self.infer_same_amount(&[expression, min, max], depth, path, "clamp"),
            DerivedExpr::InverseAggregate { .. } => Err(CompileError::new(
                "unsupported_derived_expression",
                path,
                "inverse_aggregate is not evaluated by the SQL runtime",
            )),
        }
    }

    /// Operands of min, max and clamp share one number or money_rate type.
    fn infer_same_amount(
        &mut self,
        expressions: &[&'a DerivedExpr],
        depth: usize,
        path: &str,
        name: &str,
    ) -> Result<ManifestFieldType, CompileError> {
        let mut expected = None;
        for expression in expressions {
            let inferred = self.infer(expression, depth + 1, path)?;
            if expected.is_some_and(|expected| expected != inferred)
                || !matches!(
                    inferred,
                    ManifestFieldType::Number | ManifestFieldType::MoneyRate
                )
            {
                return Err(type_error(
                    path,
                    format!("{name} requires matching number or money_rate operands"),
                ));
            }
            expected = Some(inferred);
        }
        Ok(expected.expect("min, max and clamp have operands"))
    }
}

/// Derived number literals use the canonical decimal string shape shared by
/// the SQL runtime and the TypeScript evaluator.
fn derived_literal_is_valid(literal: &TypedLiteral) -> bool {
    match literal {
        TypedLiteral::Number(value) => {
            let digits = value.strip_prefix('-').unwrap_or(value);
            let (integer, fraction) = digits.split_once('.').unwrap_or((digits, ""));
            !integer.is_empty()
                && integer.bytes().all(|byte| byte.is_ascii_digit())
                && (!digits.contains('.') || !fraction.is_empty())
                && fraction.bytes().all(|byte| byte.is_ascii_digit())
                && fraction.len() <= 28
                && format!("{integer}{fraction}")
                    .parse::<u128>()
                    .is_ok_and(|coefficient| coefficient <= 79_228_162_514_264_337_593_543_950_335)
        }
        TypedLiteral::Date(value) => derived_date_is_valid(value),
        TypedLiteral::Datetime(value) => derived_datetime_is_valid(value),
        _ => typed_literal_value_is_valid(literal),
    }
}

/// `YYYY-MM-DD` naming a real calendar date from year 1, as PostgreSQL accepts.
fn derived_date_is_valid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && match (
            value[0..4].parse::<i32>(),
            value[5..7].parse::<u32>(),
            value[8..10].parse::<u32>(),
        ) {
            (Ok(year), Ok(month), Ok(day)) => {
                year >= 1
                    && value
                        .bytes()
                        .enumerate()
                        .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
                    && NaiveDate::from_ymd_opt(year, month, day).is_some()
            }
            _ => false,
        }
}

/// RFC 3339 with the ranges both the compiler and PostgreSQL accept: hours
/// 00-23, minutes 00-59, seconds 00-60 (leap), offsets up to 15:59.
fn derived_datetime_is_valid(value: &str) -> bool {
    let Some((date, time)) = value.split_once('T') else {
        return false;
    };
    let (clock, offset) = if let Some(clock) = time.strip_suffix('Z') {
        (clock, None)
    } else if time.len() > 6 && matches!(time.as_bytes()[time.len() - 6], b'+' | b'-') {
        (&time[..time.len() - 6], Some(&time[time.len() - 5..]))
    } else {
        return false;
    };
    let two_digits = |text: &str| -> Option<u32> {
        (text.len() == 2 && text.bytes().all(|byte| byte.is_ascii_digit()))
            .then(|| text.parse().ok())
            .flatten()
    };
    let (whole, fraction) = clock.split_once('.').unwrap_or((clock, "0"));
    let parts: Vec<&str> = whole.split(':').collect();
    let offset_ok = match offset {
        None => true,
        Some(offset) => {
            offset.as_bytes()[2] == b':'
                && two_digits(&offset[0..2]).is_some_and(|hour| hour <= 15)
                && two_digits(&offset[3..5]).is_some_and(|minute| minute <= 59)
        }
    };
    derived_date_is_valid(date)
        && parts.len() == 3
        && two_digits(parts[0]).is_some_and(|hour| hour <= 23)
        && two_digits(parts[1]).is_some_and(|minute| minute <= 59)
        && two_digits(parts[2]).is_some_and(|second| second <= 60)
        && !fraction.is_empty()
        && fraction.bytes().all(|byte| byte.is_ascii_digit())
        && offset_ok
}

fn validate_seed_change_sets(
    manifest: &AppManifest,
    index: &ModelIndex<'_>,
) -> Result<(), CompileError> {
    let change_types = manifest
        .change_types
        .iter()
        .map(|change_type| change_type.id.as_str())
        .collect::<BTreeSet<_>>();
    let mut ids = BTreeSet::new();
    let mut idempotency_keys = BTreeSet::new();
    let mut earlier_writes = BTreeSet::new();

    for (change_set_index, change_set) in manifest.seed_change_sets.iter().enumerate() {
        let path = if change_set.id.is_empty() {
            format!("seed_change_sets[{change_set_index}]")
        } else {
            format!("seed_change_sets.{}", change_set.id)
        };
        for (property, value) in [
            ("id", change_set.id.as_str()),
            ("actor_id", change_set.actor_id.as_str()),
            ("source_kind", change_set.source_kind.as_str()),
            ("idempotency_key", change_set.idempotency_key.as_str()),
        ] {
            if value.trim().is_empty() {
                return Err(CompileError::new(
                    "empty_seed_metadata",
                    format!("{path}.{property}"),
                    format!("seed {property} must be non-empty"),
                ));
            }
        }
        if !ids.insert(change_set.id.as_str()) {
            return Err(CompileError::new(
                "duplicate_seed_change_set_id",
                path,
                "seed change-set id is declared more than once",
            ));
        }
        if !idempotency_keys.insert(change_set.idempotency_key.as_str()) {
            return Err(CompileError::new(
                "duplicate_seed_idempotency_key",
                format!("{path}.idempotency_key"),
                "seed idempotency key is declared more than once",
            ));
        }
        if let Some(change_type) = &change_set.change_type {
            if !change_types.contains(change_type.as_str()) {
                return Err(CompileError::new(
                    "unknown_seed_change_type",
                    format!("{path}.change_type"),
                    format!("change type `{change_type}` is not declared"),
                ));
            }
        }
        parse_seed_date(
            &change_set.effective_start,
            &format!("{path}.effective_start"),
        )?;
        if change_set.writes.is_empty() {
            return Err(CompileError::new(
                "empty_seed_change_set",
                format!("{path}.writes"),
                "seed change sets must contain at least one write",
            ));
        }

        for (write_index, write) in change_set.writes.iter().enumerate() {
            let write_path = format!("{path}.writes[{write_index}]");
            let (_, fields) = index.get(write.model.as_str()).ok_or_else(|| {
                CompileError::new(
                    "unknown_seed_model",
                    format!("{write_path}.model"),
                    format!("model `{}` is not declared", write.model),
                )
            })?;
            if write.record_key.is_some() == write.new_record_id.is_some() {
                return Err(CompileError::new(
                    "invalid_seed_write_subject",
                    write_path,
                    "seed writes must identify exactly one existing record_key or new_record_id",
                ));
            }
            if let Some(record_key) = &write.record_key {
                validate_seed_record_key(record_key, &format!("{write_path}.record_key"))?;
            }
            if let Some(new_record_id) = &write.new_record_id {
                uuid::Uuid::parse_str(new_record_id).map_err(|_| {
                    CompileError::new(
                        "invalid_seed_new_record_id",
                        format!("{write_path}.new_record_id"),
                        "new record id must be a UUID",
                    )
                })?;
            }
            if write
                .provenance
                .as_ref()
                .is_some_and(|provenance| !provenance.is_object())
            {
                return Err(CompileError::new(
                    "invalid_seed_provenance",
                    format!("{write_path}.provenance"),
                    "seed provenance must be a JSON object",
                ));
            }

            for (field_id, value) in &write.values {
                let value_path = format!("{write_path}.values.{field_id}");
                let field = require_field(fields, field_id, &value_path)?;
                if field.field_type == ManifestFieldType::Relation {
                    validate_relation_seed_reference(value, field, &earlier_writes, &value_path)?;
                } else if !seed_value_matches(field, value) {
                    return Err(type_error(
                        value_path,
                        format!(
                            "seed value does not match field `{field_id}` ({:?})",
                            field.field_type
                        ),
                    ));
                }
            }
            for field in fields.values().filter(|field| field.required) {
                if !write.values.contains_key(&field.id) {
                    return Err(CompileError::new(
                        "missing_required_seed_value",
                        format!("{write_path}.values.{}", field.id),
                        format!("required field `{}` is missing", field.id),
                    ));
                }
            }
            if let Some(SeedRecordKeyManifest::ExternalKey(external_key)) = &write.record_key {
                if !earlier_writes.insert((write.model.clone(), external_key.clone())) {
                    return Err(CompileError::new(
                        "duplicate_seed_record_key",
                        format!("{write_path}.record_key"),
                        format!(
                            "seed record `{}.{external_key}` is written more than once",
                            write.model
                        ),
                    ));
                }
            }
        }
    }
    Ok(())
}

fn validate_seed_record_key(
    record_key: &SeedRecordKeyManifest,
    path: &str,
) -> Result<(), CompileError> {
    match record_key {
        SeedRecordKeyManifest::RecordId(value) => {
            uuid::Uuid::parse_str(value).map(|_| ()).map_err(|_| {
                CompileError::new("invalid_seed_record_id", path, "record id must be a UUID")
            })
        }
        SeedRecordKeyManifest::ExternalKey(value) if value.trim().is_empty() => {
            Err(CompileError::new(
                "invalid_seed_external_key",
                path,
                "external key must be non-empty",
            ))
        }
        SeedRecordKeyManifest::ExternalKey(_) => Ok(()),
    }
}

fn validate_relation_seed_reference(
    value: &Value,
    field: &FieldManifest,
    earlier_writes: &BTreeSet<(String, String)>,
    path: &str,
) -> Result<(), CompileError> {
    let object = value.as_object().ok_or_else(|| {
        CompileError::new(
            "invalid_seed_relation_reference",
            path,
            "relation seed values must use a typed reference object",
        )
    })?;
    let reference_type = object.get("type").and_then(Value::as_str).ok_or_else(|| {
        CompileError::new(
            "invalid_seed_relation_reference",
            path,
            "relation seed reference requires type",
        )
    })?;
    let target_model = field
        .target_model
        .as_deref()
        .expect("validated relation field");
    let expected_keys = match reference_type {
        "record_id" => BTreeSet::from(["type", "value"]),
        "external_key" => BTreeSet::from(["type", "model", "value"]),
        "within_batch" => BTreeSet::from(["type", "model", "external_key"]),
        _ => {
            return Err(CompileError::new(
                "invalid_seed_relation_reference",
                format!("{path}.type"),
                format!("unknown relation seed reference type `{reference_type}`"),
            ));
        }
    };
    if object.keys().map(String::as_str).collect::<BTreeSet<_>>() != expected_keys {
        return Err(CompileError::new(
            "invalid_seed_relation_reference",
            path,
            "relation seed reference has unexpected or missing properties",
        ));
    }
    if reference_type == "record_id" {
        let value = require_non_empty_json_string(object.get("value"), &format!("{path}.value"))?;
        uuid::Uuid::parse_str(value).map_err(|_| {
            CompileError::new(
                "invalid_seed_relation_record_id",
                format!("{path}.value"),
                "relation record id must be a UUID",
            )
        })?;
        return Ok(());
    }

    let model = require_non_empty_json_string(object.get("model"), &format!("{path}.model"))?;
    if model != target_model {
        return Err(CompileError::new(
            "seed_relation_target_mismatch",
            format!("{path}.model"),
            format!("reference targets `{model}`, expected `{target_model}`"),
        ));
    }
    let address_key = if reference_type == "within_batch" {
        "external_key"
    } else {
        "value"
    };
    let address =
        require_non_empty_json_string(object.get(address_key), &format!("{path}.{address_key}"))?;
    if reference_type == "within_batch"
        && !earlier_writes.contains(&(model.to_string(), address.to_string()))
    {
        return Err(CompileError::new(
            "unknown_within_batch_seed_reference",
            path,
            format!("seed `{model}.{address}` must be written earlier"),
        ));
    }
    Ok(())
}

fn require_non_empty_json_string<'a>(
    value: Option<&'a Value>,
    path: &str,
) -> Result<&'a str, CompileError> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            CompileError::new(
                "invalid_seed_relation_reference",
                path,
                "value must be a non-empty string",
            )
        })
}

fn require_field<'a>(
    fields: &'a BTreeMap<&str, &'a FieldManifest>,
    field: &str,
    path: &str,
) -> Result<&'a FieldManifest, CompileError> {
    fields.get(field).copied().ok_or_else(|| {
        CompileError::new(
            "unknown_field",
            path,
            format!("field `{field}` is not declared on the model"),
        )
    })
}

fn comparison_supported(field_type: ManifestFieldType, comparison: Comparison) -> bool {
    match comparison {
        Comparison::Eq | Comparison::NotEq => matches!(
            field_type,
            ManifestFieldType::Text
                | ManifestFieldType::Number
                | ManifestFieldType::Bool
                | ManifestFieldType::Date
                | ManifestFieldType::Datetime
                | ManifestFieldType::Enum
                | ManifestFieldType::IsoCountry
                | ManifestFieldType::IsoCurrency
        ),
        Comparison::Lt | Comparison::Lte | Comparison::Gt | Comparison::Gte => matches!(
            field_type,
            ManifestFieldType::Text
                | ManifestFieldType::Number
                | ManifestFieldType::Date
                | ManifestFieldType::Datetime
        ),
    }
}

fn literal_matches(field_type: ManifestFieldType, literal: &TypedLiteral) -> bool {
    literal_type(literal) == field_type
}

fn literal_type(literal: &TypedLiteral) -> ManifestFieldType {
    match literal {
        TypedLiteral::Text(_) => ManifestFieldType::Text,
        TypedLiteral::Number(_) => ManifestFieldType::Number,
        TypedLiteral::Bool(_) => ManifestFieldType::Bool,
        TypedLiteral::Date(_) => ManifestFieldType::Date,
        TypedLiteral::Datetime(_) => ManifestFieldType::Datetime,
        TypedLiteral::Enum(_) => ManifestFieldType::Enum,
        TypedLiteral::IsoCountry(_) => ManifestFieldType::IsoCountry,
        TypedLiteral::IsoCurrency(_) => ManifestFieldType::IsoCurrency,
    }
}

fn literal_value_is_valid(field: &FieldManifest, literal: &TypedLiteral) -> bool {
    if !typed_literal_value_is_valid(literal) {
        return false;
    }
    match literal {
        TypedLiteral::Enum(value) => field.option_set.iter().any(|option| option.id == *value),
        _ => true,
    }
}

fn typed_literal_value_is_valid(literal: &TypedLiteral) -> bool {
    match literal {
        TypedLiteral::Text(_) | TypedLiteral::Bool(_) => true,
        TypedLiteral::Number(value) => Decimal::from_str(value).is_ok(),
        TypedLiteral::Date(value) => NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok(),
        TypedLiteral::Datetime(value) => DateTime::parse_from_rfc3339(value).is_ok(),
        TypedLiteral::Enum(_) => true,
        TypedLiteral::IsoCountry(value) => is_iso_3166_1_alpha_2(value),
        TypedLiteral::IsoCurrency(value) => is_iso_4217_tender_currency(value),
    }
}

fn seed_value_matches(field: &FieldManifest, value: &Value) -> bool {
    if value.is_null() {
        return !field.required;
    }
    match field.field_type {
        ManifestFieldType::Text
        | ManifestFieldType::Date
        | ManifestFieldType::Datetime
        | ManifestFieldType::Relation
        | ManifestFieldType::IsoCountry
        | ManifestFieldType::IsoCurrency => value.is_string(),
        ManifestFieldType::Number => value.as_str().is_some(),
        ManifestFieldType::Bool => value.is_boolean(),
        ManifestFieldType::TextList | ManifestFieldType::KnownAliases => value
            .as_array()
            .is_some_and(|items| items.iter().all(Value::is_string)),
        ManifestFieldType::Json => true,
        ManifestFieldType::Enum => value.as_str().is_some_and(|option| {
            field
                .option_set
                .iter()
                .any(|declared| declared.id == option)
        }),
        ManifestFieldType::MoneyRate => value.as_object().is_some_and(|object| {
            object.get("amount").is_some_and(Value::is_string)
                && object.get("currency").is_some_and(Value::is_string)
                && object.get("period").is_some_and(Value::is_string)
                && object.len() == 3
        }),
    }
}

fn type_error(path: impl Into<String>, message: impl Into<String>) -> CompileError {
    CompileError::new("type_mismatch", path, message)
}

fn compile_seed_change_sets(
    manifest: &AppManifest,
) -> Result<Vec<CompiledSeedChangeSetTemplate>, CompileError> {
    let index = build_model_index(manifest);
    manifest
        .seed_change_sets
        .iter()
        .map(|change_set| {
            let path = format!("seed_change_sets.{}", change_set.id);
            let effective_start = parse_seed_date(
                &change_set.effective_start,
                &format!("{path}.effective_start"),
            )?;
            let writes = change_set
                .writes
                .iter()
                .enumerate()
                .map(|(write_index, write)| {
                    let write_path = format!("{path}.writes[{write_index}]");
                    let (_, fields) = index
                        .get(write.model.as_str())
                        .expect("validated seed model");
                    let values = write
                        .values
                        .iter()
                        .filter_map(|(field_id, value)| {
                            let field =
                                fields.get(field_id.as_str()).expect("validated seed field");
                            match compile_seed_value(
                                field,
                                value,
                                &format!("{write_path}.values.{field_id}"),
                            ) {
                                Ok(Some(value)) => {
                                    Some(Ok((FieldId::from(field_id.as_str()), value)))
                                }
                                Ok(None) => None,
                                Err(error) => Some(Err(error)),
                            }
                        })
                        .collect::<Result<BTreeMap<_, _>, _>>()?;
                    Ok(RowVersionWrite {
                        model_id: ModelId::from(write.model.as_str()),
                        record_key: write
                            .record_key
                            .as_ref()
                            .map(|key| compile_seed_record_key(key, &write_path))
                            .transpose()?,
                        new_record_id: write
                            .new_record_id
                            .as_deref()
                            .map(uuid::Uuid::parse_str)
                            .transpose()
                            .map_err(|_| {
                                CompileError::new(
                                    "invalid_seed_new_record_id",
                                    format!("{write_path}.new_record_id"),
                                    "new record id must be a UUID",
                                )
                            })?,
                        expected_version_id: None,
                        effective_start,
                        values: Some(values),
                        custom_fields: None,
                        clear_fields: Vec::new(),
                        clear_custom_fields: Vec::new(),
                        metadata_patch: None,
                        tombstones_record: false,
                        provenance: write.provenance.clone().or_else(|| {
                            Some(serde_json::json!({
                                "source": "app_manifest_seed",
                                "seed_change_set": change_set.id,
                            }))
                        }),
                    })
                })
                .collect::<Result<Vec<_>, CompileError>>()?;
            let seed_record_ids = change_set
                .writes
                .iter()
                .map(|write| compiled_seed_record_id(&manifest.app_id, write))
                .collect::<Result<Vec<_>, _>>()?;

            Ok(CompiledSeedChangeSetTemplate {
                seed_identity: compiled_seed_identity(&manifest.app_id, &change_set.id),
                seed_record_ids,
                actor_id: change_set.actor_id.clone(),
                source_kind: change_set.source_kind.clone(),
                idempotency_key: change_set.idempotency_key.clone(),
                change_type_id: change_set.change_type.as_deref().map(ChangeTypeId::from),
                notes: change_set.notes.clone(),
                writes,
            })
        })
        .collect()
}

fn compiled_seed_identity(app_id: &str, seed_id: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"schema-seed-identity-v1\0");
    digest.update(app_id.as_bytes());
    digest.update(b"\0");
    digest.update(seed_id.as_bytes());
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn compiled_seed_record_id(
    app_id: &str,
    write: &SeedWriteManifest,
) -> Result<uuid::Uuid, CompileError> {
    match (&write.new_record_id, &write.record_key) {
        (Some(record_id), None) => uuid::Uuid::parse_str(record_id).map_err(|_| {
            CompileError::new(
                "invalid_seed_new_record_id",
                "seed_change_sets.writes.new_record_id",
                "new record id must be a UUID",
            )
        }),
        (None, Some(SeedRecordKeyManifest::RecordId(record_id))) => {
            uuid::Uuid::parse_str(record_id).map_err(|_| {
                CompileError::new(
                    "invalid_seed_record_id",
                    "seed_change_sets.writes.record_key",
                    "record id must be a UUID",
                )
            })
        }
        (None, Some(SeedRecordKeyManifest::ExternalKey(external_key))) => {
            let mut digest = Sha256::new();
            digest.update(b"schema-seed-record-v1\0");
            digest.update(app_id.as_bytes());
            digest.update(b"\0");
            digest.update(write.model.as_bytes());
            digest.update(b"\0");
            digest.update(external_key.as_bytes());
            let digest = digest.finalize();
            let mut bytes = [0_u8; 16];
            bytes.copy_from_slice(&digest[..16]);
            bytes[6] = (bytes[6] & 0x0f) | 0x50;
            bytes[8] = (bytes[8] & 0x3f) | 0x80;
            Ok(uuid::Uuid::from_bytes(bytes))
        }
        _ => unreachable!("seed write subjects are validated before lowering"),
    }
}

fn validate_compiled_seed_change_sets(
    manifest: &AppManifest,
    schema: &Schema,
    templates: &[CompiledSeedChangeSetTemplate],
) -> Result<(), CompileError> {
    for (change_set, template) in manifest.seed_change_sets.iter().zip(templates) {
        let apply = ApplyChangeSet {
            app_id: schema.app_id.clone(),
            customer_id: schema.customer_id.clone(),
            schema_revision_id: None,
            actor_id: Some(template.actor_id.clone()),
            source_kind: template.source_kind.clone(),
            source_ref: None,
            idempotency_key: Some(template.idempotency_key.clone()),
            change_type_id: template.change_type_id.clone(),
            notes: template.notes.clone(),
            mode: ApplyMode::Mainline,
            writes: template.writes.clone(),
        };
        if let Err(error) = validate_apply_against_schema(&apply, schema) {
            let issue = error.issues.into_iter().next().expect("validation issue");
            return Err(CompileError::new(
                issue.code,
                format!("seed_change_sets.{}.{}", change_set.id, issue.path),
                issue.message,
            ));
        }
    }
    Ok(())
}

fn compile_seed_record_key(
    record_key: &SeedRecordKeyManifest,
    path: &str,
) -> Result<RecordKey, CompileError> {
    match record_key {
        SeedRecordKeyManifest::RecordId(value) => uuid::Uuid::parse_str(value)
            .map(RecordKey::RecordId)
            .map_err(|_| {
                CompileError::new("invalid_seed_record_id", path, "record id must be a UUID")
            }),
        SeedRecordKeyManifest::ExternalKey(value) => {
            Ok(RecordKey::ExternalKey(ExternalKey::from(value.as_str())))
        }
    }
}

fn compile_seed_value(
    field: &FieldManifest,
    value: &Value,
    path: &str,
) -> Result<Option<FieldValue>, CompileError> {
    if value.is_null() {
        return Ok(None);
    }
    let string_value = || {
        value
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| type_error(path, "seed value must be a string"))
    };
    let compiled = match field.field_type {
        ManifestFieldType::Text
        | ManifestFieldType::IsoCountry
        | ManifestFieldType::IsoCurrency => FieldValue::Text(string_value()?),
        ManifestFieldType::Number => {
            let value = string_value()?;
            FieldValue::Number(
                Decimal::from_str(&value)
                    .map_err(|_| type_error(path, "seed number is not a decimal"))?,
            )
        }
        ManifestFieldType::Bool => FieldValue::Bool(
            value
                .as_bool()
                .ok_or_else(|| type_error(path, "seed value must be a boolean"))?,
        ),
        ManifestFieldType::Date => FieldValue::Date(
            NaiveDate::parse_from_str(&string_value()?, "%Y-%m-%d")
                .map_err(|_| type_error(path, "seed date must use YYYY-MM-DD"))?,
        ),
        ManifestFieldType::Datetime => FieldValue::Datetime(
            DateTime::parse_from_rfc3339(&string_value()?)
                .map_err(|_| type_error(path, "seed datetime must use RFC 3339"))?
                .with_timezone(&Utc),
        ),
        ManifestFieldType::Relation => {
            FieldValue::Relation(compile_seed_relation_value(value, path)?)
        }
        ManifestFieldType::TextList | ManifestFieldType::KnownAliases => FieldValue::TextList(
            value
                .as_array()
                .ok_or_else(|| type_error(path, "seed value must be a string array"))?
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .map(str::to_string)
                        .ok_or_else(|| type_error(path, "seed list items must be strings"))
                })
                .collect::<Result<Vec<_>, _>>()?,
        ),
        ManifestFieldType::Json => FieldValue::Json(value.clone()),
        ManifestFieldType::Enum => FieldValue::Enum(EnumOptionId::from(string_value()?)),
        ManifestFieldType::MoneyRate => {
            let object = value
                .as_object()
                .ok_or_else(|| type_error(path, "money_rate seed value must be an object"))?;
            let amount = object
                .get("amount")
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| type_error(path, "money_rate amount is required"))?;
            let currency = object
                .get("currency")
                .and_then(Value::as_str)
                .ok_or_else(|| type_error(path, "money_rate currency is required"))?;
            let period = object
                .get("period")
                .and_then(Value::as_str)
                .and_then(|value| match value {
                    "hourly" => Some(KernelMoneyRatePeriod::Hourly),
                    "daily" => Some(KernelMoneyRatePeriod::Daily),
                    "weekly" => Some(KernelMoneyRatePeriod::Weekly),
                    "monthly" => Some(KernelMoneyRatePeriod::Monthly),
                    "annual" => Some(KernelMoneyRatePeriod::Annual),
                    _ => None,
                })
                .ok_or_else(|| type_error(path, "money_rate period is not supported"))?;
            FieldValue::MoneyRate(MoneyRateValue {
                amount: Decimal::from_str(&amount)
                    .map_err(|_| type_error(path, "money_rate amount is not a decimal"))?,
                currency: currency.to_string(),
                period,
            })
        }
    };
    Ok(Some(compiled))
}

fn compile_seed_relation_value(value: &Value, path: &str) -> Result<RecordKey, CompileError> {
    let object = value
        .as_object()
        .ok_or_else(|| type_error(path, "relation seed value must be an object"))?;
    match object.get("type").and_then(Value::as_str) {
        Some("record_id") => object
            .get("value")
            .and_then(Value::as_str)
            .and_then(|value| uuid::Uuid::parse_str(value).ok())
            .map(RecordKey::RecordId)
            .ok_or_else(|| type_error(path, "relation record_id must be a UUID")),
        Some("external_key") => object
            .get("value")
            .and_then(Value::as_str)
            .map(|value| RecordKey::ExternalKey(ExternalKey::from(value)))
            .ok_or_else(|| type_error(path, "relation external_key value is required")),
        Some("within_batch") => object
            .get("external_key")
            .and_then(Value::as_str)
            .map(|value| RecordKey::ExternalKey(ExternalKey::from(value)))
            .ok_or_else(|| type_error(path, "relation within_batch external_key is required")),
        _ => Err(type_error(
            path,
            "relation seed reference type is not supported",
        )),
    }
}

fn parse_seed_date(value: &str, path: &str) -> Result<NaiveDate, CompileError> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| {
        CompileError::new(
            "invalid_seed_effective_start",
            path,
            "date must use YYYY-MM-DD",
        )
    })
}

fn compile_schema(manifest: &AppManifest) -> Schema {
    Schema {
        app_id: AppId::from(manifest.app_id.as_str()),
        customer_id: CustomerId::from(manifest.customer_id.as_str()),
        version: SchemaVersion::from(manifest.version.as_str()),
        models: manifest.models.iter().map(compile_model).collect(),
        custom_fields: manifest
            .custom_fields
            .iter()
            .map(compile_custom_field)
            .chain(manifest.models.iter().flat_map(|model| {
                model
                    .derived_fields
                    .iter()
                    .map(|derived| compile_derived_field(&model.id, derived))
            }))
            .collect(),
        change_types: manifest
            .change_types
            .iter()
            .map(|change_type| ChangeType {
                id: ChangeTypeId::from(change_type.id.as_str()),
                label: change_type.label.clone(),
                target_model: ModelId::from(change_type.model.as_str()),
                touches: change_type
                    .touches
                    .as_ref()
                    .cloned()
                    .unwrap_or_else(|| {
                        manifest
                            .models
                            .iter()
                            .find(|model| model.id == change_type.model)
                            .expect("validated change type model")
                            .fields
                            .iter()
                            .map(|field| field.id.clone())
                            .collect()
                    })
                    .iter()
                    .map(|field| FieldId::from(field.as_str()))
                    .collect(),
                required: change_type
                    .required
                    .iter()
                    .map(|field| FieldId::from(field.as_str()))
                    .collect(),
                is_import_default: change_type.is_import_default,
            })
            .collect(),
    }
}

/// App-authored derived fields lower to fixed derived custom-field
/// definitions, the single runtime representation of a derived value.
fn compile_derived_field(model_id: &str, derived: &DerivedFieldManifest) -> CustomFieldDefinition {
    CustomFieldDefinition {
        // Length-prefixed so distinct (model, field) pairs never share an id.
        id: CustomFieldDefinitionId::from(format!(
            "derived_{}_{model_id}_{}",
            model_id.len(),
            derived.id
        )),
        model_id: ModelId::from(model_id),
        field_id: FieldId::from(derived.id.as_str()),
        label: derived.label.clone(),
        field_type: match derived.field_type {
            ManifestFieldType::Text => CustomFieldType::Text,
            ManifestFieldType::Number => CustomFieldType::Number,
            ManifestFieldType::Bool => CustomFieldType::Bool,
            ManifestFieldType::Date => CustomFieldType::Date,
            ManifestFieldType::Datetime => CustomFieldType::Datetime,
            ManifestFieldType::MoneyRate => CustomFieldType::MoneyRate,
            _ => unreachable!("validated derived field type"),
        },
        expression: Some(derived.expression.clone()),
        origin: SchemaElementOrigin::App,
        management: SchemaManagementPolicy::Fixed,
        lifecycle: SchemaElementLifecycle::Active,
        ..CustomFieldDefinition::default()
    }
}

fn compile_custom_field(field: &CustomFieldManifest) -> CustomFieldDefinition {
    let archived_at = field.archived_at.as_deref().map(|value| {
        DateTime::parse_from_rfc3339(value)
            .expect("validated custom field archived_at")
            .with_timezone(&Utc)
    });
    let lifecycle = field.lifecycle.unwrap_or(if archived_at.is_some() {
        SchemaElementLifecycle::Retired
    } else {
        SchemaElementLifecycle::Active
    });
    CustomFieldDefinition {
        expression: None,
        id: CustomFieldDefinitionId::from(field.id.as_str()),
        model_id: ModelId::from(field.model.as_str()),
        field_id: FieldId::from(field.field.as_str()),
        label: field.label.clone(),
        field_type: match field.field_type {
            ManifestCustomFieldType::Text => CustomFieldType::Text,
            ManifestCustomFieldType::Number => CustomFieldType::Number,
            ManifestCustomFieldType::Bool => CustomFieldType::Bool,
            ManifestCustomFieldType::Date => CustomFieldType::Date,
            ManifestCustomFieldType::Datetime => CustomFieldType::Datetime,
            ManifestCustomFieldType::Relation => CustomFieldType::Relation,
            ManifestCustomFieldType::TextList => CustomFieldType::TextList,
            ManifestCustomFieldType::Enum => CustomFieldType::Enum,
            ManifestCustomFieldType::MoneyRate => CustomFieldType::MoneyRate,
        },
        target_model_id: field.target_model.as_deref().map(ModelId::from),
        option_set: field
            .option_set
            .iter()
            .map(|option| EnumOption {
                id: EnumOptionId::from(option.id.as_str()),
                label: option.label.clone(),
                aliases: option.aliases.clone(),
                origin: option.origin,
                management: option.management,
                lifecycle: option.lifecycle,
            })
            .collect(),
        archived_at,
        origin: field.origin,
        management: field.management,
        lifecycle,
    }
}

fn compile_model(model: &ModelManifest) -> Model {
    Model {
        id: ModelId::from(model.id.as_str()),
        kind: match model.kind {
            ManifestModelKind::Entity => ModelKind::Entity,
            ManifestModelKind::Lookup => ModelKind::Lookup,
        },
        label: model.label.clone(),
        display_field_id: model
            .display_field_id
            .as_deref()
            .or((model.kind == ManifestModelKind::Lookup).then_some("name"))
            .map(FieldId::from),
        origin: model.origin,
        management: model.management,
        lifecycle: model.lifecycle,
        extensions: model.extensions.clone(),
        fields: model
            .fields
            .iter()
            .map(|field| Field {
                id: FieldId::from(field.id.as_str()),
                label: field.label.clone(),
                field_type: compile_field_type(field.field_type),
                required: field.required,
                is_unique: field.is_unique,
                target_model: field.target_model.as_deref().map(ModelId::from),
                option_set: field
                    .option_set
                    .iter()
                    .map(|option| EnumOption {
                        id: EnumOptionId::from(option.id.as_str()),
                        label: option.label.clone(),
                        aliases: option.aliases.clone(),
                        origin: option.origin,
                        management: option.management,
                        lifecycle: option.lifecycle,
                    })
                    .collect(),
                origin: field.origin,
                management: field.management,
                lifecycle: field.lifecycle,
            })
            .collect(),
        many_relations: model
            .many_relations
            .iter()
            .map(|relation| ManyRelationDefinition {
                id: FieldId::from(relation.id.as_str()),
                label: relation.label.clone(),
                target_model: ModelId::from(relation.target_model.as_str()),
                origin: relation.origin,
                management: relation.management,
                lifecycle: relation.lifecycle,
            })
            .collect(),
    }
}

fn compile_field_type(field_type: ManifestFieldType) -> FieldType {
    match field_type {
        ManifestFieldType::Text => FieldType::Text,
        ManifestFieldType::Number => FieldType::Number,
        ManifestFieldType::Bool => FieldType::Bool,
        ManifestFieldType::Date => FieldType::Date,
        ManifestFieldType::Datetime => FieldType::Datetime,
        ManifestFieldType::Relation => FieldType::Relation,
        ManifestFieldType::TextList => FieldType::TextList,
        ManifestFieldType::KnownAliases => FieldType::KnownAliases,
        ManifestFieldType::Json => FieldType::Json,
        ManifestFieldType::Enum => FieldType::Enum,
        ManifestFieldType::IsoCountry => FieldType::IsoCountry,
        ManifestFieldType::IsoCurrency => FieldType::IsoCurrency,
        ManifestFieldType::MoneyRate => FieldType::MoneyRate,
    }
}

fn compile_extras(
    mut manifest: AppManifest,
    seed_change_sets: Vec<CompiledSeedChangeSetTemplate>,
) -> NormalizedManifestExtras {
    let mut model_metadata = Vec::new();
    let mut field_metadata = Vec::new();
    let mut inverse_relations = Vec::new();
    let mut many_relations = Vec::new();
    let mut derived_fields = Vec::new();
    let authorization_policy = manifest.authorization.take().map(|policy| {
        let mut relations = manifest
            .models
            .iter()
            .flat_map(|model| {
                let inverse = model.inverse_relations.iter().map(|relation| {
                    NormalizedAuthorizationRelation {
                        model: model.id.clone(),
                        id: relation.id.clone(),
                        target_model: relation.model.clone(),
                        through: relation.through.clone(),
                    }
                });
                inverse
            })
            .collect::<Vec<_>>();
        relations.sort_by(|left, right| {
            left.model
                .cmp(&right.model)
                .then_with(|| left.id.cmp(&right.id))
                .then_with(|| left.target_model.cmp(&right.target_model))
                .then_with(|| left.through.cmp(&right.through))
        });
        NormalizedAuthorizationPolicy {
            roles: policy.roles,
            grants: policy.grants,
            relations,
        }
    });

    for model in manifest.models {
        model_metadata.push(ModelMetadata {
            model: model.id.clone(),
            name: model.name,
            aliases: model.aliases,
            notes: model.notes,
            field_groups: model.field_groups,
        });
        for field in model.fields {
            field_metadata.push(FieldMetadata {
                model: model.id.clone(),
                field: field.id,
                name: field.name,
                aliases: field.aliases,
                notes: field.notes,
                enum_option_notes: field
                    .option_set
                    .into_iter()
                    .filter_map(|option| {
                        option.notes.map(|notes| EnumOptionNote {
                            option: option.id,
                            notes,
                        })
                    })
                    .collect(),
            });
        }
        many_relations.extend(model.many_relations.into_iter().map(|relation| {
            NormalizedManyRelation {
                owner_model: model.id.clone(),
                id: relation.id,
                label: relation.label,
                target_model: relation.target_model,
                notes: relation.notes,
            }
        }));
        inverse_relations.extend(model.inverse_relations.into_iter().map(|inverse| {
            NormalizedInverseRelation {
                owner_model: model.id.clone(),
                id: inverse.id,
                model: inverse.model,
                through: inverse.through,
                label: inverse.label,
                notes: inverse.notes,
            }
        }));
        derived_fields.extend(model.derived_fields.into_iter().map(|field| {
            NormalizedDerivedField {
                model: model.id.clone(),
                field,
            }
        }));
    }

    NormalizedManifestExtras {
        model_metadata,
        field_metadata,
        inverse_relations,
        many_relations,
        constraints: manifest.constraints,
        derived_fields,
        authorization_policy,
        seed_change_sets,
    }
}
