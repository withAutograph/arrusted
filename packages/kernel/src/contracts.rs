use std::collections::BTreeMap;

use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::{de, Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::expressions::DerivedExpr;

pub const AGENT_SOURCE_KIND: &str = "agent";
pub const MAX_RECORD_METADATA_BYTES: u32 = 65_536;
pub const MAX_RECORD_METADATA_DEPTH: u16 = 16;
pub const MAX_RECORD_METADATA_KEYS: u16 = 256;
pub const MAX_RECORD_METADATA_KEY_BYTES: u16 = 256;
pub const MAX_RECORD_METADATA_SCALAR_BYTES: u32 = 16_384;
pub const MAX_RECORD_METADATA_ARRAY_ITEMS: u32 = 256;
pub const LOOKUP_LIFECYCLE_FIELD_ID: &str = "__lookup_lifecycle";
pub const RECORD_METADATA_FIELD_ID: &str = "__record_metadata";

/// Matching policies accepted by the generated source identity resolver.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceIdentityMatchPolicy {
    CreateOnly,
    SourceReference,
}

macro_rules! string_id {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            // IDs are boundary-validated against their specific contract.
            // Constructors stay lossless so opaque scope ids are never normalized.
            pub fn new(value: impl Into<String>) -> Self {
                Self(value.into())
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                Self::new(value)
            }
        }

        impl From<String> for $name {
            fn from(value: String) -> Self {
                Self::new(value)
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                self.0.fmt(formatter)
            }
        }
    };
}

string_id!(AppId);
string_id!(CustomerId);
string_id!(SchemaVersion);
string_id!(ModelId);
string_id!(FieldId);
string_id!(EnumOptionId);
string_id!(ChangeTypeId);
string_id!(CustomFieldDefinitionId);
string_id!(ExternalKey);

pub type RecordId = Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordsByModelRequest {
    pub model_ids: Vec<ModelId>,
    pub as_of: String,
    pub fields: Option<String>,
    pub record_ids_by_model: Option<BTreeMap<ModelId, Vec<RecordId>>>,
    pub limit_per_model: Option<usize>,
}

/// HC `POST /api/record-options`: the best matches for `query` among the
/// records a link to `model_id` may choose on `as_of`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordOptionsRequest {
    pub model_id: ModelId,
    pub as_of: String,
    #[serde(default)]
    pub query: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SchemaRevisionId(i64);

impl SchemaRevisionId {
    pub fn new(value: i64) -> Self {
        Self(value)
    }

    pub fn get(self) -> i64 {
        self.0
    }
}

// PostgreSQL revision identities are signed 64-bit values. JSON numbers cannot
// preserve every valid value in JavaScript, so the public wire contract uses a
// decimal string while still accepting legacy numeric values from generated SQL.
impl Serialize for SchemaRevisionId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0.to_string())
    }
}

impl<'de> Deserialize<'de> for SchemaRevisionId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct SchemaRevisionIdVisitor;

        impl de::Visitor<'_> for SchemaRevisionIdVisitor {
            type Value = SchemaRevisionId;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a signed 64-bit revision ID as a decimal string or integer")
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                value
                    .parse::<i64>()
                    .map(SchemaRevisionId::new)
                    .map_err(E::custom)
            }

            fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(SchemaRevisionId::new(value))
            }

            fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                i64::try_from(value)
                    .map(SchemaRevisionId::new)
                    .map_err(E::custom)
            }
        }

        deserializer.deserialize_any(SchemaRevisionIdVisitor)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppIdentity {
    pub app_id: AppId,
    pub customer_id: CustomerId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "capability", rename_all = "snake_case", deny_unknown_fields)]
pub enum InstallerPrincipalScopeBindingRequest {
    Runtime {
        principal_name: String,
        app_id: AppId,
        customer_id: CustomerId,
        #[serde(default)]
        actor_id: Option<String>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "deserialize_present_option"
        )]
        active: Option<bool>,
    },
    SchemaAdmin {
        principal_name: String,
        app_id: AppId,
        customer_id: CustomerId,
        actor_id: String,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "deserialize_present_option"
        )]
        active: Option<bool>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrincipalScopeCapability {
    Runtime,
    SchemaAdmin,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InstallerPrincipalScopeBindingResult {
    pub principal_name: String,
    pub capability: PrincipalScopeCapability,
    pub app_id: AppId,
    pub customer_id: CustomerId,
    pub actor_id: Option<String>,
    pub active: bool,
}

fn deserialize_present_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct App {
    pub id: AppId,
    pub label: String,
    pub schema: Schema,
    #[serde(default)]
    pub connectors: Value,
    #[serde(default)]
    pub agents: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Schema {
    pub app_id: AppId,
    pub customer_id: CustomerId,
    pub version: SchemaVersion,
    pub models: Vec<Model>,
    #[serde(default)]
    pub custom_fields: Vec<CustomFieldDefinition>,
    #[serde(default)]
    pub change_types: Vec<ChangeType>,
}

impl Schema {
    pub fn identity(&self) -> AppIdentity {
        AppIdentity {
            app_id: self.app_id.clone(),
            customer_id: self.customer_id.clone(),
        }
    }
}

pub(crate) fn active_custom_field_definition<'a>(
    definitions: &'a [CustomFieldDefinition],
    model_id: &ModelId,
    field_id: &FieldId,
) -> Option<&'a CustomFieldDefinition> {
    definitions.iter().find(|definition| {
        definition.model_id == *model_id
            && definition.field_id == *field_id
            && definition.lifecycle == SchemaElementLifecycle::Active
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Model {
    pub id: ModelId,
    pub kind: ModelKind,
    pub label: String,
    #[serde(default)]
    pub display_field_id: Option<FieldId>,
    #[serde(default)]
    pub origin: SchemaElementOrigin,
    #[serde(default)]
    pub management: SchemaManagementPolicy,
    #[serde(default)]
    pub lifecycle: SchemaElementLifecycle,
    #[serde(default)]
    pub extensions: EntityExtensionCapabilities,
    pub fields: Vec<Field>,
    #[serde(default)]
    pub many_relations: Vec<ManyRelationDefinition>,
}

impl Default for Model {
    fn default() -> Self {
        Self {
            id: ModelId::from(""),
            kind: ModelKind::Entity,
            label: String::new(),
            display_field_id: None,
            origin: SchemaElementOrigin::default(),
            management: SchemaManagementPolicy::default(),
            lifecycle: SchemaElementLifecycle::default(),
            extensions: EntityExtensionCapabilities::default(),
            fields: Vec::new(),
            many_relations: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelKind {
    #[default]
    Entity,
    Lookup,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SchemaElementOrigin {
    #[default]
    App,
    Tenant,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SchemaManagementPolicy {
    #[default]
    Fixed,
    TenantManaged,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SchemaElementLifecycle {
    #[default]
    Active,
    Retired,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EntityExtensionCapabilities {
    #[serde(default)]
    pub typed_custom_fields: bool,
    #[serde(default)]
    pub record_metadata: Option<RecordMetadataLimits>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordMetadataLimits {
    pub max_bytes: u32,
    pub max_depth: u16,
    pub max_keys: u16,
    pub max_key_bytes: u16,
    pub max_scalar_bytes: u32,
    pub max_array_items: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManyRelationDefinition {
    pub id: FieldId,
    pub label: String,
    pub target_model: ModelId,
    #[serde(default)]
    pub origin: SchemaElementOrigin,
    #[serde(default)]
    pub management: SchemaManagementPolicy,
    #[serde(default)]
    pub lifecycle: SchemaElementLifecycle,
}

impl Default for ManyRelationDefinition {
    fn default() -> Self {
        Self {
            id: FieldId::from(""),
            label: String::new(),
            target_model: ModelId::from(""),
            origin: SchemaElementOrigin::default(),
            management: SchemaManagementPolicy::default(),
            lifecycle: SchemaElementLifecycle::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Field {
    pub id: FieldId,
    pub label: String,
    #[serde(rename = "type")]
    pub field_type: FieldType,
    pub required: bool,
    #[serde(default)]
    pub is_unique: bool,
    #[serde(default)]
    pub target_model: Option<ModelId>,
    #[serde(default)]
    pub option_set: Vec<EnumOption>,
    #[serde(default)]
    pub origin: SchemaElementOrigin,
    #[serde(default)]
    pub management: SchemaManagementPolicy,
    #[serde(default)]
    pub lifecycle: SchemaElementLifecycle,
}

impl Default for Field {
    fn default() -> Self {
        Self {
            id: FieldId::from(""),
            label: String::new(),
            field_type: FieldType::Text,
            required: false,
            is_unique: false,
            target_model: None,
            option_set: Vec::new(),
            origin: SchemaElementOrigin::default(),
            management: SchemaManagementPolicy::default(),
            lifecycle: SchemaElementLifecycle::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldType {
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
#[serde(rename_all = "snake_case")]
pub enum CustomFieldType {
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
pub struct EnumOption {
    pub id: EnumOptionId,
    pub label: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub origin: SchemaElementOrigin,
    #[serde(default)]
    pub management: SchemaManagementPolicy,
    #[serde(default)]
    pub lifecycle: SchemaElementLifecycle,
}

impl Default for EnumOption {
    fn default() -> Self {
        Self {
            id: EnumOptionId::from(""),
            label: String::new(),
            aliases: Vec::new(),
            origin: SchemaElementOrigin::default(),
            management: SchemaManagementPolicy::default(),
            lifecycle: SchemaElementLifecycle::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum EnumOptionSetTarget {
    Declared {
        model_id: ModelId,
        field_id: FieldId,
    },
    Custom {
        model_id: ModelId,
        field_id: FieldId,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommitEnumOptionSetRevision {
    pub app_id: AppId,
    pub customer_id: CustomerId,
    pub baseline_revision_id: SchemaRevisionId,
    pub target: EnumOptionSetTarget,
    pub options: Vec<EnumOption>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CustomFieldDefinition {
    pub id: CustomFieldDefinitionId,
    pub model_id: ModelId,
    pub field_id: FieldId,
    pub label: String,
    #[serde(rename = "type")]
    pub field_type: CustomFieldType,
    #[serde(default)]
    pub target_model_id: Option<ModelId>,
    #[serde(default)]
    pub option_set: Vec<EnumOption>,
    /// Present only on a derived definition: its read-only value is evaluated
    /// from this expression at read time and is never stored or written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expression: Option<DerivedExpr>,
    /// Deprecated compatibility timestamp. Lifecycle is authoritative; active fields must omit it
    /// and retired fields must retain it until the wire field is removed in a versioned contract.
    #[serde(default)]
    pub archived_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub origin: SchemaElementOrigin,
    #[serde(default)]
    pub management: SchemaManagementPolicy,
    #[serde(default)]
    pub lifecycle: SchemaElementLifecycle,
}

impl Default for CustomFieldDefinition {
    fn default() -> Self {
        Self {
            id: CustomFieldDefinitionId::from(""),
            model_id: ModelId::from(""),
            field_id: FieldId::from(""),
            label: String::new(),
            field_type: CustomFieldType::Text,
            target_model_id: None,
            option_set: Vec::new(),
            expression: None,
            archived_at: None,
            origin: SchemaElementOrigin::default(),
            management: SchemaManagementPolicy::default(),
            lifecycle: SchemaElementLifecycle::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TenantSchemaRevisionRequest {
    pub app_id: AppId,
    pub customer_id: CustomerId,
    pub actor_id: String,
    pub reason: String,
    pub idempotency_key: String,
    pub expected_revision_id: SchemaRevisionId,
    pub expected_effective_hash: String,
    pub operations: Vec<TenantSchemaOperation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TenantCreateModelInput {
    pub kind: ModelKind,
    pub label: String,
    #[serde(default)]
    pub display_field_id: Option<FieldId>,
    pub fields: Vec<Field>,
    #[serde(default)]
    pub many_relations: Vec<ManyRelationDefinition>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum TenantSchemaOperation {
    CreateModel {
        model: TenantCreateModelInput,
    },
    UpdateModel {
        model_id: ModelId,
        #[serde(default)]
        label: Option<String>,
        #[serde(default)]
        management: Option<SchemaManagementPolicy>,
        #[serde(default)]
        extensions: Option<EntityExtensionCapabilities>,
    },
    RetireModel {
        model_id: ModelId,
    },
    RestoreModel {
        model_id: ModelId,
    },
    CreateField {
        model_id: ModelId,
        field: Field,
    },
    UpdateField {
        model_id: ModelId,
        field_id: FieldId,
        #[serde(default)]
        label: Option<String>,
        #[serde(default)]
        required: Option<bool>,
        #[serde(default)]
        is_unique: Option<bool>,
        #[serde(default)]
        management: Option<SchemaManagementPolicy>,
    },
    RetireField {
        model_id: ModelId,
        field_id: FieldId,
    },
    RestoreField {
        model_id: ModelId,
        field_id: FieldId,
    },
    CreateManyRelation {
        model_id: ModelId,
        relation: ManyRelationDefinition,
    },
    UpdateManyRelation {
        model_id: ModelId,
        relation_id: FieldId,
        #[serde(default)]
        label: Option<String>,
        #[serde(default)]
        management: Option<SchemaManagementPolicy>,
    },
    RetireManyRelation {
        model_id: ModelId,
        relation_id: FieldId,
    },
    RestoreManyRelation {
        model_id: ModelId,
        relation_id: FieldId,
    },
    CreateEnumOption {
        model_id: ModelId,
        field_id: FieldId,
        option: EnumOption,
    },
    UpdateEnumOption {
        model_id: ModelId,
        field_id: FieldId,
        option_id: EnumOptionId,
        #[serde(default)]
        label: Option<String>,
        #[serde(default)]
        aliases: Option<Vec<String>>,
        #[serde(default)]
        management: Option<SchemaManagementPolicy>,
    },
    RetireEnumOption {
        model_id: ModelId,
        field_id: FieldId,
        option_id: EnumOptionId,
    },
    RestoreEnumOption {
        model_id: ModelId,
        field_id: FieldId,
        option_id: EnumOptionId,
    },
    TransferEnumAlias {
        model_id: ModelId,
        field_id: FieldId,
        alias: String,
        from_option_id: EnumOptionId,
        to_option_id: EnumOptionId,
    },
    CreateCustomField {
        definition: CustomFieldDefinition,
    },
    UpdateCustomField {
        definition_id: CustomFieldDefinitionId,
        #[serde(default)]
        label: Option<String>,
        #[serde(default)]
        management: Option<SchemaManagementPolicy>,
    },
    RetireCustomField {
        definition_id: CustomFieldDefinitionId,
    },
    RestoreCustomField {
        definition_id: CustomFieldDefinitionId,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TenantSchemaRevisionDryRunResult {
    pub baseline_revision_id: SchemaRevisionId,
    pub candidate_effective_hash: String,
    pub candidate_schema: Schema,
    #[serde(default)]
    pub affected_references: Vec<TenantSchemaAffectedReference>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TenantSchemaRevisionResult {
    pub schema_revision_id: SchemaRevisionId,
    pub effective_hash: String,
    pub schema: Schema,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TenantSchemaAffectedReference {
    pub model_id: ModelId,
    #[serde(default)]
    pub field_id: Option<FieldId>,
    #[serde(default)]
    pub option_id: Option<EnumOptionId>,
    pub visible_reference_count: u64,
    pub historical_reference_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LookupPageCursor {
    pub normalized_label: String,
    pub record_id: RecordId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LookupListRequest {
    pub app_id: AppId,
    pub customer_id: CustomerId,
    pub model_id: ModelId,
    #[serde(default)]
    pub as_of: Option<NaiveDate>,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub include_retired: bool,
    #[serde(default)]
    pub limit: Option<u16>,
    #[serde(default)]
    pub after: Option<LookupPageCursor>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LookupRecordView {
    pub model_id: ModelId,
    pub record_id: RecordId,
    pub external_key: Option<String>,
    pub label: String,
    pub normalized_label: String,
    pub availability: SchemaElementLifecycle,
    pub effective_start: NaiveDate,
    pub effective_end: Option<NaiveDate>,
    pub values: BTreeMap<FieldId, FieldValue>,
    #[serde(default)]
    pub custom_fields: Vec<CustomFieldEntry>,
    #[serde(default)]
    pub metadata: Map<String, Value>,
    #[serde(default)]
    pub many_relations: BTreeMap<FieldId, Vec<RecordId>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LookupResolveBatchRequest {
    pub app_id: AppId,
    pub customer_id: CustomerId,
    pub model_id: ModelId,
    pub record_ids: Vec<RecordId>,
    #[serde(default)]
    pub as_of: Option<NaiveDate>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LookupResolvedRecord {
    pub model_id: ModelId,
    pub record_id: RecordId,
    pub external_key: Option<String>,
    pub label: String,
    pub availability: SchemaElementLifecycle,
    pub current_label: Option<String>,
    pub current_availability: Option<SchemaElementLifecycle>,
    pub values: BTreeMap<FieldId, FieldValue>,
    #[serde(default)]
    pub custom_fields: Vec<CustomFieldEntry>,
    #[serde(default)]
    pub metadata: Map<String, Value>,
    #[serde(default)]
    pub many_relations: BTreeMap<FieldId, Vec<RecordId>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LookupHydrationReference {
    pub model_id: ModelId,
    pub record_id: RecordId,
    #[serde(default)]
    pub as_of: Option<NaiveDate>,
    #[serde(default)]
    pub effective_start: Option<NaiveDate>,
    #[serde(default)]
    pub event_change_set_id: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LookupHydrateRequest {
    pub app_id: AppId,
    pub customer_id: CustomerId,
    pub references: Vec<LookupHydrationReference>,
    #[serde(default)]
    pub as_of: Option<NaiveDate>,
    #[serde(default)]
    pub event_change_set_id: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LookupLabelSnapshot {
    pub model_id: ModelId,
    pub record_id: RecordId,
    pub label: String,
    pub availability: SchemaElementLifecycle,
    pub retired: bool,
    pub effective_start: NaiveDate,
    pub change_set_id: i64,
    pub applied_order: i64,
    #[serde(default)]
    pub schema_revision_id: Option<SchemaRevisionId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LookupHydratedReference {
    pub model_id: ModelId,
    pub record_id: RecordId,
    pub resolved: Option<LookupResolvedRecord>,
    pub current: Option<LookupLabelSnapshot>,
    pub event: Option<LookupLabelSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LookupReferenceCountRequest {
    pub app_id: AppId,
    pub customer_id: CustomerId,
    pub model_id: ModelId,
    pub record_id: RecordId,
    #[serde(default)]
    pub as_of: Option<NaiveDate>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LookupReferenceCount {
    pub count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LookupSetAvailabilityRequest {
    pub app_id: AppId,
    pub customer_id: CustomerId,
    pub model_id: ModelId,
    pub record_id: RecordId,
    pub availability: SchemaElementLifecycle,
    pub effective_start: NaiveDate,
    #[serde(default)]
    pub schema_revision_id: Option<SchemaRevisionId>,
    pub actor_id: String,
    #[serde(default)]
    pub source_kind: Option<String>,
    #[serde(default)]
    pub source_ref: Option<String>,
    pub idempotency_key: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LookupSetAvailabilityResult {
    pub id: i64,
    pub schema_revision_id: SchemaRevisionId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LookupAliasTransferRequest {
    pub app_id: AppId,
    pub customer_id: CustomerId,
    pub model_id: ModelId,
    pub source_record_id: RecordId,
    pub target_record_id: RecordId,
    pub alias: String,
    pub effective_start: NaiveDate,
    pub expected_source_version_id: RecordId,
    pub expected_target_version_id: RecordId,
    #[serde(default)]
    pub schema_revision_id: Option<SchemaRevisionId>,
    pub actor_id: String,
    pub idempotency_key: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChangeType {
    pub id: ChangeTypeId,
    pub label: String,
    pub target_model: ModelId,
    /// Schema metadata selecting this change type as the model's default import action.
    #[serde(default, skip_serializing_if = "is_false")]
    pub is_import_default: bool,
    /// Metadata for app forms and audit labels; the kernel does not use this as apply-time validation.
    #[serde(default)]
    pub touches: Vec<FieldId>,
    /// Metadata for app forms and audit labels; the kernel does not use this as apply-time validation.
    #[serde(default)]
    pub required: Vec<FieldId>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApplyMode {
    Mainline,
    Draft,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApplyChangeSet {
    pub app_id: AppId,
    pub customer_id: CustomerId,
    #[serde(default)]
    pub schema_revision_id: Option<SchemaRevisionId>,
    #[serde(default)]
    pub actor_id: Option<String>,
    pub source_kind: String,
    #[serde(default)]
    pub source_ref: Option<String>,
    #[serde(default)]
    pub idempotency_key: Option<String>,
    #[serde(default)]
    pub change_type_id: Option<ChangeTypeId>,
    #[serde(default)]
    pub notes: Option<String>,
    pub mode: ApplyMode,
    pub writes: Vec<RowVersionWrite>,
}

impl ApplyChangeSet {
    pub fn identity(&self) -> AppIdentity {
        AppIdentity {
            app_id: self.app_id.clone(),
            customer_id: self.customer_id.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AtomicApplyDryRunRequest {
    pub app_id: AppId,
    pub customer_id: CustomerId,
    pub changesets: Vec<ApplyChangeSet>,
}

impl AtomicApplyDryRunRequest {
    pub fn identity(&self) -> AppIdentity {
        AppIdentity {
            app_id: self.app_id.clone(),
            customer_id: self.customer_id.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentRunLedgerEntry {
    pub app_id: AppId,
    pub customer_id: CustomerId,
    pub run_id: String,
    #[serde(default)]
    pub status: AgentRunStatus,
    #[serde(default)]
    pub schema_revision_id: Option<SchemaRevisionId>,
    #[serde(default)]
    pub actor_id: Option<String>,
    pub agent_identity_id: String,
    pub execution_profile_id: String,
    #[serde(default = "empty_json_array")]
    pub source_artifacts: Value,
    #[serde(default = "empty_json_array")]
    pub alignment_decisions: Value,
    #[serde(default = "empty_json_array")]
    pub model_calls: Value,
    #[serde(default = "empty_json_array")]
    pub tool_calls: Value,
    #[serde(default = "empty_json_object")]
    pub token_usage: Value,
    #[serde(default = "empty_json_array")]
    pub validation_failures: Value,
    #[serde(default = "empty_json_object")]
    pub final_outputs: Value,
    #[serde(default = "empty_json_array")]
    pub approval_boundaries: Value,
    #[serde(default)]
    pub compiled_preview_ids: Vec<String>,
}

fn empty_json_array() -> Value {
    Value::Array(Vec::new())
}

fn empty_json_object() -> Value {
    Value::Object(Map::new())
}

impl AgentRunLedgerEntry {
    pub fn identity(&self) -> AppIdentity {
        AppIdentity {
            app_id: self.app_id.clone(),
            customer_id: self.customer_id.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum AgentRunStatus {
    #[default]
    Recorded,
    Completed,
    ValidationExhausted,
    BudgetExhausted,
    RuntimeError,
    Cancelled,
}

impl AgentRunStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Recorded => "recorded",
            Self::Completed => "completed",
            Self::ValidationExhausted => "validation_exhausted",
            Self::BudgetExhausted => "budget_exhausted",
            Self::RuntimeError => "runtime_error",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn is_terminal(&self) -> bool {
        match self {
            Self::Recorded => false,
            Self::Completed
            | Self::ValidationExhausted
            | Self::BudgetExhausted
            | Self::RuntimeError
            | Self::Cancelled => true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentRunStatusUpdate {
    pub app_id: AppId,
    pub customer_id: CustomerId,
    pub run_id: String,
    pub status: AgentRunStatus,
    // Terminal evidence is merged only while moving recorded -> terminal:
    // arrays append, object fields fill gaps, and scalar/object conflicts keep
    // the already-recorded value. These payloads can duplicate record-level
    // values; see the agent-run ledger retention footgun before deployment.
    #[serde(default)]
    pub model_calls: Option<Value>,
    #[serde(default)]
    pub tool_calls: Option<Value>,
    #[serde(default)]
    pub token_usage: Option<Value>,
    #[serde(default)]
    pub validation_failures: Option<Value>,
    #[serde(default)]
    pub final_outputs: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RevertChangeSet {
    pub app_id: AppId,
    pub customer_id: CustomerId,
    pub change_set_id: i64,
    #[serde(default)]
    pub actor_id: Option<String>,
    #[serde(default)]
    pub idempotency_key: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

impl RevertChangeSet {
    pub fn identity(&self) -> AppIdentity {
        AppIdentity {
            app_id: self.app_id.clone(),
            customer_id: self.customer_id.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QueryVisibleSql {
    pub app_id: AppId,
    pub customer_id: CustomerId,
    #[serde(default)]
    pub as_of: Option<NaiveDate>,
    pub sql: String,
    #[serde(default)]
    pub params: Vec<SqlParam>,
    #[serde(default)]
    pub statement_timeout_ms: Option<u64>,
}

impl QueryVisibleSql {
    pub fn identity(&self) -> AppIdentity {
        AppIdentity {
            app_id: self.app_id.clone(),
            customer_id: self.customer_id.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum SqlParam {
    Text(String),
    Int(i64),
    Number(#[serde(with = "rust_decimal::serde::str")] Decimal),
    Bool(bool),
    Date(NaiveDate),
    Json(Value),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QueryResult {
    pub columns: Vec<QueryColumn>,
    pub rows: Vec<Vec<Value>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QueryColumn {
    pub name: String,
    pub type_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VersionStage {
    Draft,
    Mainline,
    Discarded,
    Reverted,
}

impl VersionStage {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Mainline => "mainline",
            Self::Discarded => "discarded",
            Self::Reverted => "reverted",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeSetStatus {
    Draft,
    Mainline,
    Discarded,
}

impl ChangeSetStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Mainline => "mainline",
            Self::Discarded => "discarded",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChangeSetDiffRequest {
    pub app_id: AppId,
    pub customer_id: CustomerId,
    pub change_set_id: i64,
    #[serde(default)]
    pub project: Vec<FieldId>,
}

impl ChangeSetDiffRequest {
    pub fn identity(&self) -> AppIdentity {
        AppIdentity {
            app_id: self.app_id.clone(),
            customer_id: self.customer_id.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChangeSetDiff {
    pub change_set_id: i64,
    pub source_change_set_id: i64,
    pub records: Vec<RecordDiff>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordDiff {
    pub model_id: ModelId,
    pub record_id: RecordId,
    pub external_key: Option<String>,
    pub version_id: RecordId,
    pub change_set_id: i64,
    pub stage: VersionStage,
    pub effective_start: NaiveDate,
    pub effective_end: Option<NaiveDate>,
    pub before_tombstones_record: bool,
    pub after_tombstones_record: bool,
    pub before_untombstones_record: bool,
    pub after_untombstones_record: bool,
    pub fields: Vec<FieldDiff>,
    pub custom_fields: Vec<CustomFieldDiff>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FieldDiff {
    pub field_id: FieldId,
    pub before: Option<FieldValue>,
    pub after: Option<FieldValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_enum: Option<EnumAuditHydratedValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_enum: Option<EnumAuditHydratedValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CustomFieldDiff {
    pub field_id: FieldId,
    pub before: Option<CustomFieldValue>,
    pub after: Option<CustomFieldValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_enum: Option<EnumAuditHydratedValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_enum: Option<EnumAuditHydratedValue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FieldHistoryRequest {
    pub app_id: AppId,
    pub customer_id: CustomerId,
    pub model_id: ModelId,
    pub record_id: RecordId,
    #[serde(default)]
    pub field_id: Option<FieldId>,
    #[serde(default)]
    pub as_of: Option<NaiveDate>,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub stages: Vec<VersionStage>,
}

impl FieldHistoryRequest {
    pub fn identity(&self) -> AppIdentity {
        AppIdentity {
            app_id: self.app_id.clone(),
            customer_id: self.customer_id.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FieldHistoryEntry {
    pub version_id: RecordId,
    pub change_set_id: i64,
    pub stage: VersionStage,
    pub effective_start: NaiveDate,
    pub effective_end: Option<NaiveDate>,
    pub field_id: FieldId,
    pub value: Option<FieldValue>,
    pub reverted_by: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enum_value: Option<EnumAuditHydratedValue>,
    /// The snapshot exists but the actor may not read this field in it under
    /// the declared policy: `value` and `enum_value` are absent. Readers treat
    /// the value as unknown, never as empty.
    pub withheld: bool,
    /// Lifecycle flags of the physical version row, so readers can show a
    /// deletion or restoration without inferring it from absent values.
    pub tombstones_record: bool,
    pub untombstones_record: bool,
    /// Attribution joined from the owning change set. `applied_at` is the
    /// change set's recorded time and survives a later revert.
    pub actor_id: Option<String>,
    pub source_kind: String,
    pub source_ref: Option<String>,
    pub applied_at: Option<DateTime<Utc>>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnumAuditHydratedValue {
    pub option_id: EnumOptionId,
    pub event_schema_revision_id: SchemaRevisionId,
    pub current_label: Option<String>,
    pub event_label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecentActivityRequest {
    pub app_id: AppId,
    pub customer_id: CustomerId,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub statuses: Vec<ChangeSetStatus>,
    #[serde(default)]
    pub source_kinds: Vec<String>,
}

impl RecentActivityRequest {
    pub fn identity(&self) -> AppIdentity {
        AppIdentity {
            app_id: self.app_id.clone(),
            customer_id: self.customer_id.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecentActivityEntry {
    pub change_set_id: i64,
    pub status: ChangeSetStatus,
    pub actor_id: Option<String>,
    pub source_kind: String,
    pub source_ref: Option<String>,
    pub change_type_id: Option<ChangeTypeId>,
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
    pub applied_at: Option<DateTime<Utc>>,
    pub touched_record_count: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RowVersionWrite {
    pub model_id: ModelId,
    #[serde(default)]
    pub record_key: Option<RecordKey>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_record_id: Option<RecordId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_version_id: Option<RecordId>,
    pub effective_start: NaiveDate,
    #[serde(default)]
    pub values: Option<BTreeMap<FieldId, FieldValue>>,
    #[serde(default)]
    pub custom_fields: Option<Vec<CustomFieldEntry>>,
    #[serde(default)]
    pub clear_fields: Vec<FieldId>,
    #[serde(default)]
    pub clear_custom_fields: Vec<FieldId>,
    #[serde(default)]
    pub metadata_patch: Option<RecordMetadataPatch>,
    #[serde(default)]
    pub tombstones_record: bool,
    #[serde(default)]
    pub provenance: Option<Value>,
}

impl Default for RowVersionWrite {
    fn default() -> Self {
        Self {
            model_id: ModelId::from(""),
            record_key: None,
            new_record_id: None,
            expected_version_id: None,
            effective_start: NaiveDate::from_ymd_opt(1970, 1, 1).expect("valid epoch date"),
            values: None,
            custom_fields: None,
            clear_fields: Vec::new(),
            clear_custom_fields: Vec::new(),
            metadata_patch: None,
            tombstones_record: false,
            provenance: None,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordMetadataPatch {
    #[serde(default)]
    pub clear: bool,
    #[serde(default)]
    pub set: BTreeMap<String, Value>,
    #[serde(default)]
    pub remove: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum RecordKey {
    RecordId(RecordId),
    ExternalKey(ExternalKey),
    LookupOrCreate {
        label: String,
        #[serde(default)]
        values: BTreeMap<FieldId, FieldValue>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum FieldValue {
    Text(String),
    #[serde(with = "rust_decimal::serde::str")]
    Number(Decimal),
    Bool(bool),
    Date(NaiveDate),
    Datetime(DateTime<Utc>),
    Relation(RecordKey),
    RelationList(Vec<RecordKey>),
    TextList(Vec<String>),
    Json(Value),
    Enum(EnumOptionId),
    MoneyRate(MoneyRateValue),
    SchemaLifecycle(SchemaElementLifecycle),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CustomFieldEntry {
    pub field_id: FieldId,
    #[serde(flatten)]
    pub value: CustomFieldValue,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum CustomFieldValue {
    Text(String),
    #[serde(with = "rust_decimal::serde::str")]
    Number(Decimal),
    Bool(bool),
    Date(NaiveDate),
    Datetime(DateTime<Utc>),
    Relation(RecordKey),
    TextList(Vec<String>),
    Enum(EnumOptionId),
    MoneyRate(MoneyRateValue),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MoneyRateValue {
    #[serde(with = "rust_decimal::serde::str")]
    pub amount: Decimal,
    pub currency: String,
    pub period: MoneyRatePeriod,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MoneyRatePeriod {
    Hourly,
    Daily,
    Weekly,
    Monthly,
    Annual,
}
