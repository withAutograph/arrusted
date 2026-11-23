use std::collections::{BTreeMap, BTreeSet};

use crate::contracts::{
    active_custom_field_definition, AgentRunLedgerEntry, AgentRunStatusUpdate, App, ApplyChangeSet,
    CustomFieldDefinition, CustomFieldEntry, CustomFieldType, CustomFieldValue, EnumOption, Field,
    FieldId, FieldType, FieldValue, Model, ModelId, ModelKind, RecordId, RecordKey,
    RowVersionWrite, Schema, SchemaElementLifecycle, SchemaElementOrigin, SchemaManagementPolicy,
    AGENT_SOURCE_KIND, LOOKUP_LIFECYCLE_FIELD_ID, MAX_RECORD_METADATA_ARRAY_ITEMS,
    MAX_RECORD_METADATA_BYTES, MAX_RECORD_METADATA_DEPTH, MAX_RECORD_METADATA_KEYS,
    MAX_RECORD_METADATA_KEY_BYTES, MAX_RECORD_METADATA_SCALAR_BYTES,
};
use crate::error::{ValidationError, ValidationIssue};
use crate::identifiers::{bounded_physical_identifier, normalize_identifier};
use crate::iso_codes::{is_iso_3166_1_alpha_2, is_iso_4217_tender_currency};

pub fn validate_schema(schema: &Schema) -> Result<(), ValidationError> {
    validate_schema_revision(schema, None)
}

/// Validates `schema` as the successor of `prior`. A custom field that
/// collides with a declared field or many-relation id is rejected only when
/// `prior` did not already hold that active collision, so a tenant that has
/// one can still write and retire it. Same rule as the SQL runtime's
/// `kernel_admin_custom_field_collision_issues`.
pub fn validate_schema_revision(
    schema: &Schema,
    prior: Option<&Schema>,
) -> Result<(), ValidationError> {
    let mut validator = Validator::default();

    validator.require_scope_id("app_id", schema.app_id.as_str());
    validator.require_scope_id("customer_id", schema.customer_id.as_str());
    validator.require_non_empty("version", schema.version.as_str());

    if schema.models.is_empty() {
        validator.issue(
            "models",
            "empty_models",
            "schema must declare at least one model",
        );
    }

    let mut model_ids = BTreeSet::new();
    let mut normalized_model_ids = BTreeSet::new();
    let mut model_physical_names = BTreeSet::new();
    let mut fields_by_model = BTreeMap::new();
    let mut normalized_fields_by_model = BTreeMap::new();

    for (model_index, model) in schema.models.iter().enumerate() {
        let model_path = format!("models[{model_index}]");
        validate_schema_element_policy(&mut validator, &model_path, model.origin, model.management);
        let Some(model_identifier) =
            validator.require_identifier(format!("{model_path}.id"), model.id.as_str())
        else {
            continue;
        };

        if !model_ids.insert(model.id.clone()) {
            validator.issue(
                format!("{model_path}.id"),
                "duplicate_model_id",
                format!("model id `{}` is duplicated", model.id),
            );
        }

        if !normalized_model_ids.insert(model_identifier.clone()) {
            validator.issue(
                format!("{model_path}.id"),
                "normalized_model_id_collision",
                format!(
                    "model id `{}` collides after identifier normalization",
                    model.id
                ),
            );
        }

        let record_table = bounded_physical_identifier(&format!("{model_identifier}_record"));
        let version_table = bounded_physical_identifier(&format!("{model_identifier}_version"));
        for physical_name in [record_table, version_table] {
            if !model_physical_names.insert(physical_name.clone()) {
                validator.issue(
                    format!("{model_path}.id"),
                    "physical_name_collision",
                    format!(
                        "model id `{}` collides at physical name `{physical_name}`",
                        model.id
                    ),
                );
            }
        }

        if model.fields.is_empty() {
            validator.issue(
                format!("{model_path}.fields"),
                "empty_fields",
                "model must declare at least one field",
            );
        }

        match model.kind {
            ModelKind::Entity => {
                if model.display_field_id.is_some() {
                    validator.issue(
                        format!("{model_path}.display_field_id"),
                        "unexpected_lookup_display_field",
                        "only lookup models may declare display_field_id",
                    );
                }
                validate_entity_extensions(&mut validator, &model_path, model);
            }
            ModelKind::Lookup => {
                if model.extensions.record_metadata.is_some() {
                    validator.issue(
                        format!("{model_path}.extensions"),
                        "lookup_extensions_forbidden",
                        "lookup models cannot declare record metadata",
                    );
                }
            }
        }

        let mut field_ids = BTreeSet::new();
        let mut normalized_field_ids = BTreeSet::new();
        let mut field_physical_names = BTreeSet::new();
        for (field_index, field) in model.fields.iter().enumerate() {
            let field_path = format!("{model_path}.fields[{field_index}]");
            validate_schema_element_policy(
                &mut validator,
                &field_path,
                field.origin,
                field.management,
            );
            let Some(field_identifier) =
                validator.require_identifier(format!("{field_path}.id"), field.id.as_str())
            else {
                continue;
            };

            if !field_ids.insert(field.id.clone()) {
                validator.issue(
                    format!("{field_path}.id"),
                    "duplicate_field_id",
                    format!(
                        "field id `{}` is duplicated in model `{}`",
                        field.id, model.id
                    ),
                );
            }

            if !normalized_field_ids.insert(field_identifier.clone()) {
                validator.issue(
                    format!("{field_path}.id"),
                    "normalized_field_id_collision",
                    format!(
                        "field id `{}` collides after identifier normalization",
                        field.id
                    ),
                );
            }

            if is_system_column(&field_identifier) {
                validator.issue(
                    format!("{field_path}.id"),
                    "system_column_collision",
                    format!(
                        "field id `{}` collides with reserved row-version column `{field_identifier}`",
                        field.id
                    ),
                );
            }

            for physical_column in field_physical_columns(&field_identifier, &field.field_type) {
                if !field_physical_names.insert(physical_column.clone()) {
                    validator.issue(
                        format!("{field_path}.id"),
                        "physical_name_collision",
                        format!(
                            "field id `{}` collides at physical column `{physical_column}`",
                            field.id
                        ),
                    );
                }
            }

            match field.field_type {
                FieldType::Relation => {
                    if field
                        .target_model
                        .as_ref()
                        .is_none_or(|target_model| target_model.as_str().is_empty())
                    {
                        validator.issue(
                            format!("{field_path}.target_model"),
                            "missing_relation_target",
                            "relation fields must declare target_model",
                        );
                    }
                    if !field.option_set.is_empty() {
                        validator.issue(
                            format!("{field_path}.option_set"),
                            "unexpected_option_set",
                            "only enum fields may declare option_set",
                        );
                    }
                }
                FieldType::Enum => {
                    if field.target_model.is_some() {
                        validator.issue(
                            format!("{field_path}.target_model"),
                            "unexpected_relation_target",
                            "only relation fields may declare target_model",
                        );
                    }
                    validate_enum_options(
                        &mut validator,
                        format!("{field_path}.option_set"),
                        &field.option_set,
                        EnumOptionContext::DeclaredField,
                    );
                }
                _ => {
                    if field.target_model.is_some() {
                        validator.issue(
                            format!("{field_path}.target_model"),
                            "unexpected_relation_target",
                            "only relation fields may declare target_model",
                        );
                    }
                    if !field.option_set.is_empty() {
                        validator.issue(
                            format!("{field_path}.option_set"),
                            "unexpected_option_set",
                            "only enum fields may declare option_set",
                        );
                    }
                }
            }
            if field.is_unique
                && !matches!(
                    field.field_type,
                    FieldType::Text
                        | FieldType::IsoCountry
                        | FieldType::IsoCurrency
                        | FieldType::Number
                        | FieldType::Bool
                        | FieldType::Date
                        | FieldType::Datetime
                )
            {
                validator.issue(
                    format!("{field_path}.is_unique"),
                    "unsupported_unique_field_type",
                    "unique fields must be single-column scalar fields",
                );
            }
        }

        let mut relation_ids = BTreeSet::new();
        let mut normalized_metadata_ids = normalized_field_ids.clone();
        for (relation_index, relation) in model.many_relations.iter().enumerate() {
            let relation_path = format!("{model_path}.many_relations[{relation_index}]");
            validate_schema_element_policy(
                &mut validator,
                &relation_path,
                relation.origin,
                relation.management,
            );
            if let Some(normalized_id) =
                validator.require_identifier(format!("{relation_path}.id"), relation.id.as_str())
            {
                if !normalized_metadata_ids.insert(normalized_id) {
                    validator.issue(
                        format!("{relation_path}.id"),
                        "many_relation_id_collision",
                        format!(
                            "many relation id `{}` collides with another field or relation on model `{}`",
                            relation.id, model.id
                        ),
                    );
                }
            }
            if !relation_ids.insert(&relation.id) {
                validator.issue(
                    format!("{relation_path}.id"),
                    "duplicate_many_relation_id",
                    format!(
                        "many relation id `{}` is duplicated on model `{}`",
                        relation.id, model.id
                    ),
                );
            }
            validator.require_non_empty(format!("{relation_path}.label"), &relation.label);
        }

        if model.kind == ModelKind::Lookup {
            match model.display_field_id.as_ref() {
                None => validator.issue(
                    format!("{model_path}.display_field_id"),
                    "missing_lookup_display_field",
                    "lookup models must declare display_field_id",
                ),
                Some(display_field_id) => match model
                    .fields
                    .iter()
                    .find(|field| field.id == *display_field_id)
                {
                    None => validator.issue(
                        format!("{model_path}.display_field_id"),
                        "unknown_lookup_display_field",
                        format!(
                            "lookup display_field_id `{display_field_id}` is not declared on model `{}`",
                            model.id
                        ),
                    ),
                    Some(field)
                        if field.field_type != FieldType::Text
                            || !field.required
                            || field.lifecycle != SchemaElementLifecycle::Active =>
                    {
                        validator.issue(
                            format!("{model_path}.display_field_id"),
                            "invalid_lookup_display_field",
                            "lookup display_field_id must reference an active required text field",
                        );
                    }
                    Some(_) => {}
                },
            }
        }

        fields_by_model.insert(model.id.clone(), field_ids);
        // Custom fields may not reuse a declared field or many-relation id.
        normalized_fields_by_model.insert(
            model.id.clone(),
            normalized_metadata_ids
                .into_iter()
                .map(FieldId::from)
                .collect(),
        );
    }

    for (model_index, model) in schema.models.iter().enumerate() {
        for (field_index, field) in model.fields.iter().enumerate() {
            if matches!(field.field_type, FieldType::Relation)
                && field
                    .target_model
                    .as_ref()
                    .is_some_and(|target_model| !model_ids.contains(target_model))
            {
                validator.issue(
                    format!("models[{model_index}].fields[{field_index}].target_model"),
                    "unknown_relation_target",
                    format!(
                        "relation target `{}` is not a declared model",
                        field.target_model.as_ref().unwrap()
                    ),
                );
            }
        }
        for (relation_index, relation) in model.many_relations.iter().enumerate() {
            if !model_ids.contains(&relation.target_model) {
                validator.issue(
                    format!("models[{model_index}].many_relations[{relation_index}].target_model"),
                    "unknown_many_relation_target",
                    format!(
                        "many relation target `{}` is not a declared model",
                        relation.target_model
                    ),
                );
            }
        }
    }

    let mut change_type_ids = BTreeSet::new();
    let mut normalized_change_type_ids = BTreeSet::new();
    let mut import_default_by_model = BTreeSet::new();
    for (change_type_index, change_type) in schema.change_types.iter().enumerate() {
        let change_type_path = format!("change_types[{change_type_index}]");
        if let Some(change_type_identifier) =
            validator.require_identifier(format!("{change_type_path}.id"), change_type.id.as_str())
        {
            if !normalized_change_type_ids.insert(change_type_identifier) {
                validator.issue(
                    format!("{change_type_path}.id"),
                    "normalized_change_type_id_collision",
                    format!(
                        "change type id `{}` collides after identifier normalization",
                        change_type.id
                    ),
                );
            }
        }

        if !change_type_ids.insert(change_type.id.clone()) {
            validator.issue(
                format!("{change_type_path}.id"),
                "duplicate_change_type_id",
                format!("change type id `{}` is duplicated", change_type.id),
            );
        }

        if change_type.is_import_default
            && !import_default_by_model.insert(change_type.target_model.clone())
        {
            validator.issue(
                format!("{change_type_path}.is_import_default"),
                "duplicate_import_default",
                format!(
                    "model `{}` may declare at most one import-default change type",
                    change_type.target_model
                ),
            );
        }

        let Some(field_ids) = fields_by_model.get(&change_type.target_model) else {
            validator.issue(
                format!("{change_type_path}.target_model"),
                "unknown_change_type_target",
                format!(
                    "change type target_model `{}` is not a declared model",
                    change_type.target_model
                ),
            );
            continue;
        };

        let mut touched_field_ids = BTreeSet::new();
        for field_id in &change_type.touches {
            if !touched_field_ids.insert(field_id) {
                validator.issue(
                    format!("{change_type_path}.touches"),
                    "duplicate_change_type_field",
                    format!(
                        "field `{field_id}` is listed more than once for model `{}`",
                        change_type.target_model
                    ),
                );
            }
            if !field_ids.contains(field_id) {
                validator.issue(
                    format!("{change_type_path}.touches"),
                    "unknown_change_type_field",
                    format!(
                        "field `{field_id}` is not declared on model `{}`",
                        change_type.target_model
                    ),
                );
            }
        }

        for field_id in &change_type.required {
            if !field_ids.contains(field_id) {
                validator.issue(
                    format!("{change_type_path}.required"),
                    "unknown_change_type_field",
                    format!(
                        "field `{field_id}` is not declared on model `{}`",
                        change_type.target_model
                    ),
                );
            }
        }
    }

    validate_custom_field_definitions(
        &mut validator,
        schema,
        &model_ids,
        &normalized_fields_by_model,
        &prior.map(custom_field_collisions).unwrap_or_default(),
    );

    validator.finish()
}

/// `(model_id, normalized field_id)` of every active custom field in `schema`
/// that reuses a declared field or many-relation id of its model.
fn custom_field_collisions(schema: &Schema) -> BTreeSet<(ModelId, String)> {
    schema
        .custom_fields
        .iter()
        .filter(|definition| definition.lifecycle == SchemaElementLifecycle::Active)
        .filter_map(|definition| {
            let field_id = normalize_identifier(definition.field_id.as_str()).ok()?;
            let model = schema
                .models
                .iter()
                .find(|model| model.id == definition.model_id)?;
            model
                .fields
                .iter()
                .map(|field| field.id.as_str())
                .chain(
                    model
                        .many_relations
                        .iter()
                        .map(|relation| relation.id.as_str()),
                )
                .any(|declared| normalize_identifier(declared).ok().as_deref() == Some(&*field_id))
                .then(|| (definition.model_id.clone(), field_id))
        })
        .collect()
}

fn validate_custom_field_definitions(
    validator: &mut Validator,
    schema: &Schema,
    model_ids: &BTreeSet<ModelId>,
    normalized_fields_by_model: &BTreeMap<ModelId, BTreeSet<FieldId>>,
    tolerated_collisions: &BTreeSet<(ModelId, String)>,
) {
    let mut definition_ids = BTreeSet::new();
    let mut reserved_fields_by_model = BTreeSet::new();
    let mut active_fields_by_model = BTreeSet::new();
    for (index, definition) in schema.custom_fields.iter().enumerate() {
        let path = format!("custom_fields[{index}]");
        validate_schema_element_policy(validator, &path, definition.origin, definition.management);
        match (definition.lifecycle, definition.archived_at.is_some()) {
            (SchemaElementLifecycle::Active, true) => validator.issue(
                format!("{path}.archived_at"),
                "custom_field_lifecycle_mismatch",
                "active custom fields must not carry archived_at",
            ),
            (SchemaElementLifecycle::Retired, false) => validator.issue(
                format!("{path}.archived_at"),
                "custom_field_lifecycle_mismatch",
                "retired custom fields must retain archived_at",
            ),
            _ => {}
        }
        if !definition_ids.insert(definition.id.clone()) {
            validator.issue(
                format!("{path}.id"),
                "duplicate_custom_field_definition_id",
                format!(
                    "custom field definition id `{}` is duplicated",
                    definition.id
                ),
            );
        }
        validator.require_identifier(format!("{path}.id"), definition.id.as_str());
        let normalized_field_id = validator
            .require_identifier(format!("{path}.field_id"), definition.field_id.as_str())
            .map(FieldId::from);
        validator.require_non_empty(format!("{path}.label"), &definition.label);
        if !model_ids.contains(&definition.model_id) {
            validator.issue(
                format!("{path}.model_id"),
                "unknown_custom_field_model",
                format!(
                    "custom field model_id `{}` is not declared in the active schema",
                    definition.model_id
                ),
            );
        }
        if schema
            .models
            .iter()
            .find(|model| model.id == definition.model_id)
            .is_some_and(|model| !model.extensions.typed_custom_fields)
            // App-authored derived fields store nothing and need no tenant opt-in.
            && !(definition.expression.is_some() && definition.origin == SchemaElementOrigin::App)
        {
            validator.issue(
                format!("{path}.model_id"),
                "custom_fields_not_enabled",
                format!(
                    "model `{}` does not enable typed custom fields",
                    definition.model_id
                ),
            );
        }
        if definition.expression.is_some()
            && matches!(
                definition.field_type,
                CustomFieldType::Relation | CustomFieldType::TextList | CustomFieldType::Enum
            )
        {
            validator.issue(
                format!("{path}.type"),
                "unsupported_derived_type",
                "derived fields evaluate to text, number, bool, date, datetime, or money_rate",
            );
        }
        if let Some(normalized_field_id) = normalized_field_id.as_ref() {
            if is_system_column(normalized_field_id.as_str()) {
                validator.issue(
                    format!("{path}.field_id"),
                    "system_column_collision",
                    format!(
                        "custom field `{}` collides with reserved row-version column `{normalized_field_id}`",
                        definition.field_id
                    ),
                );
            }
            if !reserved_fields_by_model
                .insert((definition.model_id.clone(), normalized_field_id.clone()))
            {
                validator.issue(
                    format!("{path}.field_id"),
                    "custom_field_id_reused",
                    format!(
                        "custom field `{}` is already reserved for model `{}`",
                        definition.field_id, definition.model_id
                    ),
                );
            }
            if definition.lifecycle == SchemaElementLifecycle::Active
                && !active_fields_by_model
                    .insert((definition.model_id.clone(), normalized_field_id.clone()))
            {
                validator.issue(
                    format!("{path}.field_id"),
                    "duplicate_active_custom_field",
                    format!(
                        "custom field `{}` is duplicated for model `{}`",
                        definition.field_id, definition.model_id
                    ),
                );
            }
            if definition.lifecycle == SchemaElementLifecycle::Active
                && normalized_fields_by_model
                    .get(&definition.model_id)
                    .is_some_and(|field_ids| field_ids.contains(normalized_field_id))
                && !tolerated_collisions.contains(&(
                    definition.model_id.clone(),
                    normalized_field_id.as_str().to_string(),
                ))
            {
                validator.issue(
                    format!("{path}.field_id"),
                    "custom_field_declared_field_collision",
                    format!(
                        "custom field `{}` collides with a declared field on model `{}`",
                        definition.field_id, definition.model_id
                    ),
                );
            }
        }
        match definition.field_type {
            CustomFieldType::Relation => {
                match &definition.target_model_id {
                    Some(target_model_id) if model_ids.contains(target_model_id) => {}
                    Some(target_model_id) => validator.issue(
                        format!("{path}.target_model_id"),
                        "unknown_custom_relation_target",
                        format!(
                            "custom relation target_model_id `{target_model_id}` is not declared"
                        ),
                    ),
                    None => validator.issue(
                        format!("{path}.target_model_id"),
                        "missing_custom_relation_target",
                        "custom relation fields must declare target_model_id",
                    ),
                }
                if !definition.option_set.is_empty() {
                    validator.issue(
                        format!("{path}.option_set"),
                        "unexpected_custom_option_set",
                        "only enum custom fields may declare option_set",
                    );
                }
            }
            CustomFieldType::Enum => {
                if definition.target_model_id.is_some() {
                    validator.issue(
                        format!("{path}.target_model_id"),
                        "unexpected_custom_relation_target",
                        "only relation custom fields may declare target_model_id",
                    );
                }
                validate_enum_options(
                    validator,
                    format!("{path}.option_set"),
                    &definition.option_set,
                    EnumOptionContext::CustomField,
                );
            }
            _ => {
                if definition.target_model_id.is_some() {
                    validator.issue(
                        format!("{path}.target_model_id"),
                        "unexpected_custom_relation_target",
                        "only relation custom fields may declare target_model_id",
                    );
                }
                if !definition.option_set.is_empty() {
                    validator.issue(
                        format!("{path}.option_set"),
                        "unexpected_custom_option_set",
                        "only enum custom fields may declare option_set",
                    );
                }
            }
        }
    }
}

#[derive(Clone, Copy)]
enum EnumOptionContext {
    DeclaredField,
    CustomField,
}

fn validate_enum_options(
    validator: &mut Validator,
    path: String,
    option_set: &[EnumOption],
    context: EnumOptionContext,
) {
    if option_set.is_empty() {
        let (code, details) = match context {
            EnumOptionContext::DeclaredField => (
                "empty_option_set",
                "enum fields must declare at least one option",
            ),
            EnumOptionContext::CustomField => (
                "empty_custom_option_set",
                "enum custom fields must declare at least one option",
            ),
        };
        validator.issue(path.clone(), code, details);
    }
    let mut option_ids = BTreeSet::new();
    let mut match_keys = BTreeMap::new();
    let mut reported_match_keys = BTreeSet::new();
    for (index, option) in option_set.iter().enumerate() {
        let option_path = format!("{path}[{index}]");
        validate_schema_element_policy(validator, &option_path, option.origin, option.management);
        let normalized_id =
            validator.require_identifier(format!("{option_path}.id"), option.id.as_str());
        validator.require_non_empty(format!("{option_path}.label"), &option.label);
        if let Some(normalized_id) = normalized_id {
            if !option_ids.insert(normalized_id.clone()) {
                let code = match context {
                    EnumOptionContext::DeclaredField => "duplicate_option_id",
                    EnumOptionContext::CustomField => "duplicate_custom_option_id",
                };
                validator.issue(
                    format!("{option_path}.id"),
                    code,
                    format!("enum option id `{}` is duplicated", option.id),
                );
            }
            let id_match_key = normalize_enum_match_key(option.id.as_str());
            if let Some(prior_option_id) = match_keys.get(&id_match_key) {
                if *prior_option_id != option.id && reported_match_keys.insert(id_match_key.clone())
                {
                    let code = match context {
                        EnumOptionContext::DeclaredField => "duplicate_option_alias",
                        EnumOptionContext::CustomField => "duplicate_custom_option_alias",
                    };
                    validator.issue(
                        format!("{option_path}.id"),
                        code,
                        format!(
                            "enum option id `{}` collides with an existing option match key for option `{prior_option_id}`",
                            option.id
                        ),
                    );
                }
            } else {
                match_keys.insert(id_match_key, option.id.clone());
            }
        }
        if option.lifecycle != SchemaElementLifecycle::Active {
            continue;
        }
        let label_match_key = normalize_enum_match_key(&option.label);
        register_enum_match_key(
            validator,
            format!("{option_path}.label"),
            &option.label,
            label_match_key,
            option,
            context,
            &mut match_keys,
            &mut reported_match_keys,
        );
        for (alias_index, alias) in option.aliases.iter().enumerate() {
            let canonical_alias = normalize_enum_match_key(alias);
            register_enum_match_key(
                validator,
                format!("{option_path}.aliases[{alias_index}]"),
                alias,
                canonical_alias,
                option,
                context,
                &mut match_keys,
                &mut reported_match_keys,
            );
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn register_enum_match_key(
    validator: &mut Validator,
    path: String,
    raw_value: &str,
    match_key: String,
    option: &EnumOption,
    context: EnumOptionContext,
    match_keys: &mut BTreeMap<String, crate::contracts::EnumOptionId>,
    reported_match_keys: &mut BTreeSet<String>,
) {
    if match_key.is_empty() {
        return;
    }
    if let Some(prior_option_id) = match_keys.get(&match_key) {
        if *prior_option_id == option.id || !reported_match_keys.insert(match_key) {
            return;
        }
        let code = match context {
            EnumOptionContext::DeclaredField => "duplicate_option_alias",
            EnumOptionContext::CustomField => "duplicate_custom_option_alias",
        };
        validator.issue(
            path,
            code,
            format!(
                "enum option match value `{raw_value}` is also reserved by option `{prior_option_id}`"
            ),
        );
    } else {
        match_keys.insert(match_key, option.id.clone());
    }
}

fn validate_schema_element_policy(
    validator: &mut Validator,
    path: &str,
    origin: SchemaElementOrigin,
    management: SchemaManagementPolicy,
) {
    if origin == SchemaElementOrigin::Tenant && management != SchemaManagementPolicy::TenantManaged
    {
        validator.issue(
            format!("{path}.management"),
            "tenant_definition_must_be_tenant_managed",
            "tenant-origin schema elements must use tenant_managed management",
        );
    }
}

fn validate_entity_extensions(validator: &mut Validator, model_path: &str, model: &Model) {
    let Some(limits) = model.extensions.record_metadata.as_ref() else {
        return;
    };
    for (field, value, maximum) in [
        (
            "max_bytes",
            u64::from(limits.max_bytes),
            u64::from(MAX_RECORD_METADATA_BYTES),
        ),
        (
            "max_depth",
            u64::from(limits.max_depth),
            u64::from(MAX_RECORD_METADATA_DEPTH),
        ),
        (
            "max_keys",
            u64::from(limits.max_keys),
            u64::from(MAX_RECORD_METADATA_KEYS),
        ),
        (
            "max_key_bytes",
            u64::from(limits.max_key_bytes),
            u64::from(MAX_RECORD_METADATA_KEY_BYTES),
        ),
        (
            "max_scalar_bytes",
            u64::from(limits.max_scalar_bytes),
            u64::from(MAX_RECORD_METADATA_SCALAR_BYTES),
        ),
        (
            "max_array_items",
            u64::from(limits.max_array_items),
            u64::from(MAX_RECORD_METADATA_ARRAY_ITEMS),
        ),
    ] {
        if value == 0 || value > maximum {
            validator.issue(
                format!("{model_path}.extensions.record_metadata.{field}"),
                "invalid_record_metadata_limit",
                format!("{field} must be between 1 and {maximum}"),
            );
        }
    }
}

fn normalize_enum_match_key(raw: &str) -> String {
    // Mirrors packages/engines/import-classification normalizeEnumOptionValue.
    let mut normalized = String::new();
    let mut in_separator = false;
    for ch in raw.trim().chars() {
        if ch.is_whitespace() || ch == '_' || ch == '-' {
            in_separator = true;
            continue;
        }
        if in_separator && !normalized.is_empty() {
            normalized.push(' ');
        }
        for lower in ch.to_lowercase() {
            normalized.push(lower);
        }
        in_separator = false;
    }
    normalized
}

pub fn validate_app(app: &App) -> Result<(), ValidationError> {
    let mut validator = Validator::default();

    validator.require_scope_id("id", app.id.as_str());
    validator.require_non_empty("label", &app.label);

    if app.schema.app_id != app.id {
        validator.issue(
            "schema.app_id",
            "app_id_mismatch",
            "app schema app_id must match app id",
        );
    }

    if let Err(error) = validate_schema(&app.schema) {
        validator
            .issues
            .extend(error.issues.into_iter().map(|mut issue| {
                issue.path = format!("schema.{}", issue.path);
                issue
            }));
    }

    validator.finish()
}

pub fn validate_apply_against_schema(
    apply: &ApplyChangeSet,
    schema: &Schema,
) -> Result<(), ValidationError> {
    let mut validator = Validator::default();

    if let Err(error) = validate_schema(schema) {
        validator.issues.extend(error.issues);
        return validator.finish();
    }

    if apply.app_id != schema.app_id {
        validator.issue(
            "app_id",
            "app_id_mismatch",
            "apply app_id must match schema app_id",
        );
    }
    if apply.customer_id != schema.customer_id {
        validator.issue(
            "customer_id",
            "customer_id_mismatch",
            "apply customer_id must match schema customer_id",
        );
    }
    validator.require_non_empty("source_kind", &apply.source_kind);
    if apply.source_kind == AGENT_SOURCE_KIND {
        match apply.source_ref.as_deref() {
            Some(source_ref) if !source_ref.trim().is_empty() => {}
            _ => validator.issue(
                "source_ref",
                "missing_agent_run_ref",
                "agent writes must include source_ref pointing at an agent run",
            ),
        }
    }

    if apply
        .schema_revision_id
        .is_some_and(|schema_revision_id| schema_revision_id.get() <= 0)
    {
        validator.issue(
            "schema_revision_id",
            "invalid_schema_revision_id",
            "schema_revision_id must be positive when supplied",
        );
    }

    if apply.writes.is_empty() {
        validator.issue(
            "writes",
            "empty_writes",
            "apply must include at least one write",
        );
    }

    let model_ids = schema
        .models
        .iter()
        .map(|model| &model.id)
        .collect::<BTreeSet<_>>();
    let models_by_id = schema
        .models
        .iter()
        .map(|model| (&model.id, model))
        .collect::<BTreeMap<_, _>>();
    let fields_by_model = schema
        .models
        .iter()
        .map(|model| {
            (
                &model.id,
                model
                    .fields
                    .iter()
                    .map(|field| (&field.id, field))
                    .collect::<BTreeMap<_, _>>(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let change_type_ids = schema
        .change_types
        .iter()
        .map(|change_type| (&change_type.id, &change_type.target_model))
        .collect::<BTreeMap<_, _>>();

    let explicit_new_subjects = apply
        .writes
        .iter()
        .filter_map(|write| {
            write
                .new_record_id
                .map(|record_id| (write.model_id.clone(), record_id))
        })
        .collect::<BTreeSet<(ModelId, RecordId)>>();

    if let Some(change_type_id) = &apply.change_type_id {
        if !change_type_ids.contains_key(change_type_id) {
            validator.issue(
                "change_type_id",
                "unknown_change_type",
                format!("change_type_id `{change_type_id}` is not declared in the active schema"),
            );
        }
    }

    for (write_index, write) in apply.writes.iter().enumerate() {
        if apply.mode != crate::contracts::ApplyMode::Mainline
            && write.expected_version_id.is_some()
        {
            validator.issue(
                format!("writes[{write_index}].expected_version_id"),
                "version_precondition_requires_mainline",
                "version preconditions are supported only for mainline writes",
            );
        }
        if let Some(RecordKey::RecordId(record_id)) = &write.record_key {
            if explicit_new_subjects.contains(&(write.model_id.clone(), *record_id)) {
                validator.issue(
                    format!("writes[{write_index}].record_key"),
                    "mixed_new_record_subject_addressing",
                    "all writes for an explicitly new record must identify the subject with new_record_id",
                );
            }
        }

        validate_write(
            &mut validator,
            write_index,
            write,
            &model_ids,
            &models_by_id,
            &fields_by_model,
            &schema.custom_fields,
        );

        if let Some(change_type_id) = &apply.change_type_id {
            if let Some(target_model) = change_type_ids.get(change_type_id) {
                if write.model_id != **target_model {
                    validator.issue(
                        format!("writes[{write_index}].model_id"),
                        "change_type_model_mismatch",
                        format!(
                            "write model_id `{}` does not match change_type target_model `{}`",
                            write.model_id, target_model
                        ),
                    );
                }
            }
        }
    }

    validator.finish()
}

pub fn validate_agent_run_ledger_entry(run: &AgentRunLedgerEntry) -> Result<(), ValidationError> {
    let mut validator = Validator::default();
    validator.require_scope_id("app_id", run.app_id.as_str());
    validator.require_scope_id("customer_id", run.customer_id.as_str());
    validator.require_non_empty("run_id", &run.run_id);
    validator.require_non_empty("agent_identity_id", &run.agent_identity_id);
    validator.require_non_empty("execution_profile_id", &run.execution_profile_id);
    if run
        .schema_revision_id
        .is_some_and(|schema_revision_id| schema_revision_id.get() <= 0)
    {
        validator.issue(
            "schema_revision_id",
            "invalid_schema_revision_id",
            "schema_revision_id must be positive when supplied",
        );
    }
    for (path, value) in [
        ("source_artifacts", &run.source_artifacts),
        ("alignment_decisions", &run.alignment_decisions),
        ("model_calls", &run.model_calls),
        ("tool_calls", &run.tool_calls),
        ("validation_failures", &run.validation_failures),
        ("approval_boundaries", &run.approval_boundaries),
    ] {
        if !value.is_array() {
            validator.issue(
                path,
                "invalid_json_evidence",
                "agent run evidence field must be omitted for defaults or supplied as a JSON array",
            );
        }
    }
    for (path, value) in [
        ("token_usage", &run.token_usage),
        ("final_outputs", &run.final_outputs),
    ] {
        if !value.is_object() {
            validator.issue(
                path,
                "invalid_json_evidence",
                "agent run evidence field must be omitted for defaults or supplied as a JSON object",
            );
        }
    }
    validator.finish()
}

pub fn validate_agent_run_status_update(
    update: &AgentRunStatusUpdate,
) -> Result<(), ValidationError> {
    let mut validator = Validator::default();
    validator.require_scope_id("app_id", update.app_id.as_str());
    validator.require_scope_id("customer_id", update.customer_id.as_str());
    validator.require_non_empty("run_id", &update.run_id);
    if !update.status.is_terminal() {
        validator.issue(
            "status",
            "invalid_agent_run_status",
            "agent run status updates must move a recorded run to a terminal status",
        );
    }
    for (path, value) in [
        ("model_calls", &update.model_calls),
        ("tool_calls", &update.tool_calls),
        ("validation_failures", &update.validation_failures),
    ] {
        if value.as_ref().is_some_and(|value| !value.is_array()) {
            validator.issue(
                path,
                "invalid_json_evidence",
                "agent run evidence field must be omitted or supplied as a JSON array",
            );
        }
    }
    for (path, value) in [
        ("token_usage", &update.token_usage),
        ("final_outputs", &update.final_outputs),
    ] {
        if value.as_ref().is_some_and(|value| !value.is_object()) {
            validator.issue(
                path,
                "invalid_json_evidence",
                "agent run evidence field must be omitted or supplied as a JSON object",
            );
        }
    }
    validator.finish()
}

fn validate_write(
    validator: &mut Validator,
    write_index: usize,
    write: &RowVersionWrite,
    model_ids: &BTreeSet<&ModelId>,
    models_by_id: &BTreeMap<&ModelId, &Model>,
    fields_by_model: &BTreeMap<&ModelId, BTreeMap<&FieldId, &Field>>,
    custom_field_definitions: &[CustomFieldDefinition],
) {
    let write_path = format!("writes[{write_index}]");

    if !model_ids.contains(&write.model_id) {
        validator.issue(
            format!("{write_path}.model_id"),
            "unknown_write_model",
            format!(
                "write model_id `{}` is not declared in the active schema",
                write.model_id
            ),
        );
    }
    if models_by_id
        .get(&write.model_id)
        .is_some_and(|model| model.lifecycle != SchemaElementLifecycle::Active)
    {
        validator.issue(
            format!("{write_path}.model_id"),
            "retired_write_model",
            format!(
                "model `{}` is retired and cannot accept new writes",
                write.model_id
            ),
        );
    }

    if write.effective_start == chrono::NaiveDate::MIN {
        validator.issue(
            format!("{write_path}.effective_start"),
            "effective_start_underflow",
            "effective_start is too early to close a prior version range",
        );
    }

    if let Some(record_key) = &write.record_key {
        match record_key {
            RecordKey::RecordId(_) => {}
            RecordKey::ExternalKey(external_key) if external_key.as_str().trim().is_empty() => {
                validator.issue(
                    format!("{write_path}.record_key"),
                    "empty_external_key",
                    "external record keys must not be empty",
                );
            }
            RecordKey::ExternalKey(_) => {}
            RecordKey::LookupOrCreate { .. } => validator.issue(
                format!("{write_path}.record_key"),
                "lookup_or_create_requires_generated_sql",
                "lookup-or-create record keys are supported only by the generated SQL apply API",
            ),
        }
    }

    if write.record_key.is_some() && write.new_record_id.is_some() {
        validator.issue(
            format!("{write_path}.new_record_id"),
            "conflicting_write_subject",
            "writes must identify either an existing subject or a new record, not both",
        );
    }
    if write.expected_version_id.is_some()
        && (write.new_record_id.is_some() || write.record_key.is_none())
    {
        validator.issue(
            format!("{write_path}.expected_version_id"),
            "create_version_precondition_forbidden",
            "new record writes cannot carry a version precondition",
        );
    }

    let is_record_event = write.tombstones_record;
    if is_record_event && write.new_record_id.is_some() {
        validator.issue(
            format!("{write_path}.new_record_id"),
            "new_record_tombstone_forbidden",
            "tombstone writes must identify an existing record",
        );
    } else if is_record_event && write.record_key.is_none() {
        validator.issue(
            format!("{write_path}.record_key"),
            "missing_record_event_key",
            "tombstone writes must identify an existing record",
        );
    }

    if is_record_event {
        if write.values.is_some() {
            validator.issue(
                format!("{write_path}.values"),
                "record_event_values_forbidden",
                "tombstone writes must not carry typed values",
            );
        }
        if write.custom_fields.is_some() {
            validator.issue(
                format!("{write_path}.custom_fields"),
                "record_event_custom_fields_forbidden",
                "tombstone writes must not carry custom field values",
            );
        }
        if !write.clear_fields.is_empty() {
            validator.issue(
                format!("{write_path}.clear_fields"),
                "record_event_clear_fields_forbidden",
                "tombstone writes must not clear typed values",
            );
        }
        if !write.clear_custom_fields.is_empty() {
            validator.issue(
                format!("{write_path}.clear_custom_fields"),
                "record_event_clear_custom_fields_forbidden",
                "tombstone writes must not clear custom field values",
            );
        }
        if write.metadata_patch.is_some() {
            validator.issue(
                format!("{write_path}.metadata_patch"),
                "record_event_metadata_patch_forbidden",
                "tombstone writes must not patch record metadata",
            );
        }
        return;
    }

    let has_clear = !write.clear_fields.is_empty() || !write.clear_custom_fields.is_empty();
    let has_metadata_patch = write.metadata_patch.is_some();
    match (write.values.as_ref(), write.custom_fields.as_ref()) {
        (None, None) if !has_clear && !has_metadata_patch => validator.issue(
            format!("{write_path}.values"),
            "missing_values",
            "ordinary row-version writes must include values, custom_fields, clear fields, or metadata_patch",
        ),
        (values, custom_fields)
            if values.is_none_or(BTreeMap::is_empty) && custom_fields.is_none_or(Vec::is_empty) =>
        {
            if !has_clear && !has_metadata_patch {
                validator.issue(
                    format!("{write_path}.values"),
                    "empty_values",
                    "ordinary row-version writes must include at least one value, clear field, or metadata patch",
                )
            }
        }
        (values, custom_fields) => {
            if let Some(field_ids) = fields_by_model.get(&write.model_id) {
                for (field_id, value) in values.into_iter().flat_map(BTreeMap::iter) {
                    let model = models_by_id.get(&write.model_id).copied();
                    if field_id.as_str() == LOOKUP_LIFECYCLE_FIELD_ID {
                        if !matches!(model.map(|model| model.kind), Some(ModelKind::Lookup))
                            || !matches!(value, FieldValue::SchemaLifecycle(_))
                        {
                            validator.issue(
                                format!("{write_path}.values.{field_id}"),
                                "invalid_lookup_lifecycle_value",
                                "the reserved lookup lifecycle value is valid only on lookup models and must use type schema_lifecycle",
                            );
                        }
                        continue;
                    }
                    if let Some(relation) = model.and_then(|model| {
                        model.many_relations.iter().find(|relation| relation.id == *field_id)
                    }) {
                        if relation.lifecycle != SchemaElementLifecycle::Active {
                            validator.issue(
                                format!("{write_path}.values.{field_id}"),
                                "retired_many_relation",
                                format!("many relation `{field_id}` is retired and cannot accept new values"),
                            );
                        }
                        match value {
                            FieldValue::RelationList(record_keys) => {
                                for (index, record_key) in record_keys.iter().enumerate() {
                                    validate_relation_record_key(
                                        validator,
                                        &format!("{write_path}.values.{field_id}.value[{index}]"),
                                        record_key,
                                    );
                                }
                            }
                            _ => validator.issue(
                                format!("{write_path}.values.{field_id}"),
                                "many_relation_value_type_mismatch",
                                format!("many relation `{field_id}` must use a relation_list value"),
                            ),
                        }
                        continue;
                    }
                    let Some(field) = field_ids.get(field_id) else {
                        validator.issue(
                            format!("{write_path}.values.{field_id}"),
                            "unknown_write_field",
                            format!(
                                "field `{field_id}` is not declared on model `{}`",
                                write.model_id
                            ),
                        );
                        continue;
                    };

                    if field.lifecycle != SchemaElementLifecycle::Active {
                        validator.issue(
                            format!("{write_path}.values.{field_id}"),
                            "retired_write_field",
                            format!("field `{field_id}` is retired and cannot accept new values"),
                        );
                        continue;
                    }

                    if let Some((code, message)) = field_value_issue(value, field) {
                        validator.issue(format!("{write_path}.values.{field_id}"), code, message);
                        continue;
                    }

                    if field.field_type == FieldType::Relation
                        && field
                            .target_model
                            .as_ref()
                            .and_then(|target| models_by_id.get(target))
                            .is_some_and(|target| {
                                target.lifecycle != SchemaElementLifecycle::Active
                            })
                    {
                        validator.issue(
                            format!("{write_path}.values.{field_id}"),
                            "retired_relation_target_model",
                            format!(
                                "relation field `{field_id}` targets a retired model and cannot accept new values"
                            ),
                        );
                    }

                    if field.is_unique
                        && matches!(field.field_type, FieldType::Text)
                        && matches!(value, FieldValue::Text(text) if text.trim().is_empty())
                    {
                        validator.issue(
                            format!("{write_path}.values.{field_id}"),
                            "blank_unique_text_value",
                            "unique text fields must be omitted instead of supplied as blank text",
                        );
                    }
                }
            }
            if let Some(custom_fields) = custom_fields {
                validate_custom_field_entries(
                    validator,
                    &write_path,
                    &write.model_id,
                    custom_fields,
                    custom_field_definitions,
                );
            }
        }
    }

    validate_clear_fields(
        validator,
        &write_path,
        write,
        models_by_id.get(&write.model_id).copied(),
        fields_by_model.get(&write.model_id),
        custom_field_definitions,
    );
    if let Some(patch) = &write.metadata_patch {
        validate_metadata_patch(
            validator,
            &write_path,
            patch,
            models_by_id.get(&write.model_id).copied(),
        );
    }
}

fn validate_clear_fields(
    validator: &mut Validator,
    write_path: &str,
    write: &RowVersionWrite,
    model: Option<&Model>,
    fields: Option<&BTreeMap<&FieldId, &Field>>,
    definitions: &[CustomFieldDefinition],
) {
    let mut cleared = BTreeSet::new();
    for (index, field_id) in write.clear_fields.iter().enumerate() {
        let path = format!("{write_path}.clear_fields[{index}]");
        if !cleared.insert(field_id) {
            validator.issue(
                path.clone(),
                "duplicate_clear_field",
                "clear_fields contains a duplicate field",
            );
        }
        if write
            .values
            .as_ref()
            .is_some_and(|values| values.contains_key(field_id))
        {
            validator.issue(
                path.clone(),
                "set_and_clear_field",
                "a field cannot be set and cleared in the same write",
            );
        }
        if field_id.as_str() == LOOKUP_LIFECYCLE_FIELD_ID {
            validator.issue(
                path,
                "lookup_lifecycle_clear_forbidden",
                "lookup lifecycle must be set to active or retired and cannot be cleared",
            );
            continue;
        }
        if let Some(relation) = model.and_then(|model| {
            model
                .many_relations
                .iter()
                .find(|relation| relation.id == *field_id)
        }) {
            if relation.lifecycle != SchemaElementLifecycle::Active {
                validator.issue(
                    path,
                    "retired_many_relation_clear",
                    format!("retired many relation `{field_id}` cannot be cleared"),
                );
            }
            continue;
        }
        match fields.and_then(|fields| fields.get(field_id)) {
            None => validator.issue(
                path,
                "unknown_clear_field",
                format!(
                    "field `{field_id}` is not declared on model `{}`",
                    write.model_id
                ),
            ),
            Some(field) if field.required => validator.issue(
                path,
                "required_field_clear",
                format!("required field `{field_id}` cannot be cleared"),
            ),
            Some(field) if field.lifecycle != SchemaElementLifecycle::Active => validator.issue(
                path,
                "retired_field_clear",
                format!("retired field `{field_id}` cannot be cleared"),
            ),
            Some(_) => {}
        }
    }

    let set_custom_fields = write
        .custom_fields
        .iter()
        .flatten()
        .map(|entry| &entry.field_id)
        .collect::<BTreeSet<_>>();
    let mut cleared_custom = BTreeSet::new();
    for (index, field_id) in write.clear_custom_fields.iter().enumerate() {
        let path = format!("{write_path}.clear_custom_fields[{index}]");
        if !cleared_custom.insert(field_id) {
            validator.issue(
                path.clone(),
                "duplicate_clear_custom_field",
                "clear_custom_fields contains a duplicate field",
            );
        }
        if set_custom_fields.contains(field_id) {
            validator.issue(
                path.clone(),
                "set_and_clear_custom_field",
                "a custom field cannot be set and cleared in the same write",
            );
        }
        let definition = active_custom_field_definition(definitions, &write.model_id, field_id);
        if definition.is_some_and(|definition| definition.expression.is_some()) {
            validator.issue(
                path,
                "derived_field_read_only",
                format!("custom field `{field_id}` is derived and read-only"),
            );
        } else if definition.is_none() {
            validator.issue(
                path,
                "unknown_clear_custom_field",
                format!(
                    "active custom field `{field_id}` is not declared on model `{}`",
                    write.model_id
                ),
            );
        }
    }
}

fn validate_relation_record_key(validator: &mut Validator, path: &str, record_key: &RecordKey) {
    match record_key {
        RecordKey::ExternalKey(external_key) if external_key.as_str().trim().is_empty() => {
            validator.issue(
                path,
                "empty_external_key",
                "external relation keys must not be empty",
            );
        }
        RecordKey::LookupOrCreate { .. } => validator.issue(
            path,
            "lookup_or_create_requires_generated_sql",
            "lookup-or-create record keys are supported only by the generated SQL apply API",
        ),
        RecordKey::RecordId(_) | RecordKey::ExternalKey(_) => {}
    }
}

fn validate_metadata_patch(
    validator: &mut Validator,
    write_path: &str,
    patch: &crate::contracts::RecordMetadataPatch,
    model: Option<&Model>,
) {
    let path = format!("{write_path}.metadata_patch");
    let Some(limits) = model.and_then(|model| model.extensions.record_metadata.as_ref()) else {
        validator.issue(
            path,
            "record_metadata_not_enabled",
            "record metadata is not enabled for this model",
        );
        return;
    };
    if !patch.clear && patch.set.is_empty() && patch.remove.is_empty() {
        validator.issue(
            path.clone(),
            "empty_metadata_patch",
            "metadata_patch must set, remove, or clear metadata",
        );
    }
    let mut remove_keys = BTreeSet::new();
    for (index, key) in patch.remove.iter().enumerate() {
        let key_path = format!("{path}.remove[{index}]");
        if key.trim().is_empty() {
            validator.issue(
                key_path.clone(),
                "empty_metadata_key",
                "metadata keys must not be blank",
            );
        }
        if key.len() > usize::from(limits.max_key_bytes) {
            validator.issue(
                key_path.clone(),
                "metadata_key_size_limit_exceeded",
                format!(
                    "metadata key exceeds the model limit of {} bytes",
                    limits.max_key_bytes
                ),
            );
        }
        if !remove_keys.insert(key) {
            validator.issue(
                key_path.clone(),
                "duplicate_metadata_remove",
                "metadata remove keys must be unique",
            );
        }
        if patch.set.contains_key(key) {
            validator.issue(
                key_path,
                "set_and_remove_metadata_key",
                "a metadata key cannot be set and removed in the same patch",
            );
        }
    }
    let nested_key_count = patch
        .set
        .values()
        .map(metadata_nested_key_count)
        .sum::<usize>();
    if patch
        .set
        .len()
        .saturating_add(patch.remove.len())
        .saturating_add(nested_key_count)
        > usize::from(limits.max_keys)
    {
        validator.issue(
            format!("{path}.set"),
            "metadata_key_limit_exceeded",
            format!(
                "metadata patch exceeds the model limit of {} keys",
                limits.max_keys
            ),
        );
    }
    let serialized_bytes = serde_json::to_vec(&patch.set).map_or(usize::MAX, |bytes| bytes.len());
    if serialized_bytes > limits.max_bytes as usize {
        validator.issue(
            format!("{path}.set"),
            "metadata_size_limit_exceeded",
            format!(
                "metadata patch exceeds the model limit of {} bytes",
                limits.max_bytes
            ),
        );
    }
    for (key, value) in &patch.set {
        if key.trim().is_empty() {
            validator.issue(
                format!("{path}.set"),
                "empty_metadata_key",
                "metadata keys must not be blank",
            );
        }
        if key.len() > usize::from(limits.max_key_bytes) {
            validator.issue(
                format!("{path}.set.{key}"),
                "metadata_key_size_limit_exceeded",
                format!(
                    "metadata key exceeds the model limit of {} bytes",
                    limits.max_key_bytes
                ),
            );
        }
        validate_metadata_value(validator, &format!("{path}.set.{key}"), value, limits, 0);
    }
}

fn metadata_nested_key_count(value: &serde_json::Value) -> usize {
    match value {
        serde_json::Value::Array(values) => values.iter().map(metadata_nested_key_count).sum(),
        serde_json::Value::Object(values) => {
            values.len()
                + values
                    .values()
                    .map(metadata_nested_key_count)
                    .sum::<usize>()
        }
        _ => 0,
    }
}

fn validate_metadata_value(
    validator: &mut Validator,
    path: &str,
    value: &serde_json::Value,
    limits: &crate::contracts::RecordMetadataLimits,
    depth: usize,
) {
    if depth > usize::from(limits.max_depth) {
        validator.issue(
            path,
            "metadata_depth_limit_exceeded",
            format!(
                "metadata value exceeds the model depth limit of {}",
                limits.max_depth
            ),
        );
        return;
    }
    match value {
        serde_json::Value::Array(values) => {
            if values.len() > limits.max_array_items as usize {
                validator.issue(
                    path,
                    "metadata_array_limit_exceeded",
                    format!(
                        "metadata array exceeds the model limit of {} items",
                        limits.max_array_items
                    ),
                );
            }
            for (index, value) in values.iter().enumerate() {
                validate_metadata_value(
                    validator,
                    &format!("{path}[{index}]"),
                    value,
                    limits,
                    depth + 1,
                );
            }
        }
        serde_json::Value::Object(values) => {
            for (key, value) in values {
                let key_path = format!("{path}.{key}");
                if key.trim().is_empty() {
                    validator.issue(
                        key_path.clone(),
                        "empty_metadata_key",
                        "metadata keys must not be blank",
                    );
                }
                if key.len() > usize::from(limits.max_key_bytes) {
                    validator.issue(
                        key_path.clone(),
                        "metadata_key_size_limit_exceeded",
                        format!(
                            "metadata key exceeds the model limit of {} bytes",
                            limits.max_key_bytes
                        ),
                    );
                }
                validate_metadata_value(validator, &key_path, value, limits, depth + 1);
            }
        }
        scalar => {
            let scalar_bytes = match scalar {
                serde_json::Value::String(value) => value.len(),
                _ => scalar.to_string().len(),
            };
            if scalar_bytes > limits.max_scalar_bytes as usize {
                validator.issue(
                    path,
                    "metadata_scalar_limit_exceeded",
                    format!(
                        "metadata scalar exceeds the model limit of {} bytes",
                        limits.max_scalar_bytes
                    ),
                );
            }
        }
    }
}

fn validate_custom_field_entries(
    validator: &mut Validator,
    write_path: &str,
    model_id: &ModelId,
    entries: &[CustomFieldEntry],
    definitions: &[CustomFieldDefinition],
) {
    let mut field_ids = BTreeSet::new();
    for (index, entry) in entries.iter().enumerate() {
        let path = format!("{write_path}.custom_fields[{index}]");
        if !field_ids.insert(entry.field_id.clone()) {
            validator.issue(
                format!("{path}.field_id"),
                "duplicate_custom_field_value",
                format!(
                    "custom field `{}` is duplicated in the write",
                    entry.field_id
                ),
            );
        }
        let definition = active_custom_field_definition(definitions, model_id, &entry.field_id);
        let Some(definition) = definition else {
            if definitions.iter().any(|definition| {
                definition.model_id == *model_id
                    && definition.field_id == entry.field_id
                    && definition.lifecycle == SchemaElementLifecycle::Retired
            }) {
                validator.issue(
                    format!("{path}.field_id"),
                    "archived_custom_field",
                    format!("custom field `{}` is archived", entry.field_id),
                );
            } else if definitions.iter().any(|definition| {
                definition.lifecycle == SchemaElementLifecycle::Active
                    && definition.field_id == entry.field_id
            }) {
                validator.issue(
                    format!("{path}.field_id"),
                    "wrong_model_custom_field",
                    format!(
                        "custom field `{}` is not declared on model `{model_id}`",
                        entry.field_id
                    ),
                );
            } else {
                validator.issue(
                    format!("{path}.field_id"),
                    "unknown_custom_field",
                    format!("custom field `{}` is not declared", entry.field_id),
                );
            }
            continue;
        };
        if definition.expression.is_some() {
            validator.issue(
                format!("{path}.field_id"),
                "derived_field_read_only",
                format!("custom field `{}` is derived and read-only", entry.field_id),
            );
            continue;
        }
        if let Some((code, message)) = custom_field_value_issue(&entry.value, definition) {
            validator.issue(format!("{path}.value"), code, message);
        }
    }
}

fn custom_field_value_issue(
    value: &CustomFieldValue,
    definition: &CustomFieldDefinition,
) -> Option<(&'static str, String)> {
    match (value, &definition.field_type) {
        (CustomFieldValue::Text(_), CustomFieldType::Text)
        | (CustomFieldValue::Number(_), CustomFieldType::Number)
        | (CustomFieldValue::Bool(_), CustomFieldType::Bool)
        | (CustomFieldValue::Date(_), CustomFieldType::Date)
        | (CustomFieldValue::Datetime(_), CustomFieldType::Datetime)
        | (CustomFieldValue::TextList(_), CustomFieldType::TextList) => None,
        (CustomFieldValue::Relation(record_key), CustomFieldType::Relation) => match record_key {
            RecordKey::RecordId(_) => None,
            RecordKey::ExternalKey(external_key) if !external_key.as_str().trim().is_empty() => {
                None
            }
            RecordKey::ExternalKey(_) => Some((
                "custom_field_value_type_mismatch",
                format!(
                    "custom field `{}` value does not match declared type",
                    definition.field_id
                ),
            )),
            RecordKey::LookupOrCreate { .. } => Some((
                "lookup_or_create_requires_generated_sql",
                "lookup-or-create record keys are supported only by the generated SQL apply API"
                    .to_string(),
            )),
        },
        (CustomFieldValue::Enum(value), CustomFieldType::Enum)
            if definition.option_set.iter().any(|option| {
                option.id == *value && option.lifecycle == SchemaElementLifecycle::Active
            }) =>
        {
            None
        }
        (CustomFieldValue::Enum(value), CustomFieldType::Enum) => {
            let retired = definition.option_set.iter().any(|option| {
                option.id == *value && option.lifecycle == SchemaElementLifecycle::Retired
            });
            Some((
                if retired {
                    "retired_custom_enum_option"
                } else {
                    "unknown_custom_enum_option"
                },
                format!(
                    "custom enum option `{value}` is not active for custom field `{}`",
                    definition.field_id
                ),
            ))
        }
        (CustomFieldValue::MoneyRate(value), CustomFieldType::MoneyRate)
            if is_iso_4217_tender_currency(value.currency.as_str()) =>
        {
            None
        }
        _ => Some((
            "custom_field_value_type_mismatch",
            format!(
                "custom field `{}` value does not match declared type",
                definition.field_id
            ),
        )),
    }
}

fn field_value_issue(value: &FieldValue, field: &Field) -> Option<(&'static str, String)> {
    if matches!(
        value,
        FieldValue::Relation(RecordKey::LookupOrCreate { .. })
    ) {
        return Some((
            "lookup_or_create_requires_generated_sql",
            "lookup-or-create record keys are supported only by the generated SQL apply API"
                .to_string(),
        ));
    }
    if field_value_matches_type(value, field) {
        return None;
    }
    if let (FieldValue::Enum(value), FieldType::Enum) = (value, &field.field_type) {
        let retired = field.option_set.iter().any(|option| {
            option.id == *value && option.lifecycle == SchemaElementLifecycle::Retired
        });
        return Some((
            if retired {
                "retired_enum_option"
            } else {
                "unknown_enum_option"
            },
            format!(
                "enum option `{value}` is not active for field `{}`",
                field.id
            ),
        ));
    }
    Some((
        "field_value_type_mismatch",
        format!("field `{}` value does not match declared type", field.id),
    ))
}

fn field_value_matches_type(value: &FieldValue, field: &Field) -> bool {
    match (value, &field.field_type) {
        (FieldValue::Text(_), FieldType::Text) => true,
        (FieldValue::Text(value), FieldType::IsoCountry) => is_iso_3166_1_alpha_2(value.as_str()),
        (FieldValue::Text(value), FieldType::IsoCurrency) => {
            is_iso_4217_tender_currency(value.as_str())
        }
        (FieldValue::Number(_), FieldType::Number) => true,
        (FieldValue::Bool(_), FieldType::Bool) => true,
        (FieldValue::Date(_), FieldType::Date) => true,
        (FieldValue::Datetime(_), FieldType::Datetime) => true,
        (FieldValue::Relation(record_key), FieldType::Relation) => match record_key {
            RecordKey::RecordId(_) => true,
            RecordKey::ExternalKey(external_key) => !external_key.as_str().trim().is_empty(),
            RecordKey::LookupOrCreate { .. } => false,
        },
        (FieldValue::TextList(_), FieldType::TextList | FieldType::KnownAliases) => true,
        (FieldValue::Json(_), FieldType::Json) => true,
        (FieldValue::Enum(value), FieldType::Enum) => field.option_set.iter().any(|option| {
            option.id == *value && option.lifecycle == SchemaElementLifecycle::Active
        }),
        (FieldValue::MoneyRate(value), FieldType::MoneyRate) => {
            is_iso_4217_tender_currency(value.currency.as_str())
        }
        _ => false,
    }
}

fn is_system_column(identifier: &str) -> bool {
    matches!(
        identifier,
        "id" | "record_id"
            | "app_id"
            | "customer_id"
            | "stage"
            | "effective_start"
            | "effective_end"
            | "change_set_id"
            | "created_at"
            | "applied_at"
            | "tombstones_record"
            | "untombstones_record"
            | "custom_fields"
            | "provenance"
            | "external_key"
    )
}

fn field_physical_columns(field_identifier: &str, field_type: &FieldType) -> Vec<String> {
    if matches!(field_type, FieldType::MoneyRate) {
        ["amount", "currency", "period"]
            .into_iter()
            .map(|suffix| bounded_physical_identifier(&format!("{field_identifier}_{suffix}")))
            .collect()
    } else {
        vec![bounded_physical_identifier(field_identifier)]
    }
}

#[derive(Default)]
struct Validator {
    issues: Vec<ValidationIssue>,
}

impl Validator {
    fn require_non_empty(&mut self, path: impl Into<String>, value: &str) {
        let path = path.into();
        if value.trim().is_empty() {
            self.issue(path, "empty_value", "value must not be empty");
        }
    }

    fn require_scope_id(&mut self, path: impl Into<String>, value: &str) {
        let path = path.into();
        if value.trim().is_empty() {
            self.issue(path, "empty_scope_id", "scope id must not be empty");
        }
    }

    fn require_identifier(&mut self, path: impl Into<String>, value: &str) -> Option<String> {
        let path = path.into();
        match normalize_identifier(value) {
            Ok(identifier) => Some(identifier),
            Err(mut issue) => {
                issue.path = path;
                self.issues.push(issue);
                None
            }
        }
    }

    fn issue(&mut self, path: impl Into<String>, code: &'static str, message: impl Into<String>) {
        self.issues.push(ValidationIssue::new(path, code, message));
    }

    fn finish(self) -> Result<(), ValidationError> {
        if self.issues.is_empty() {
            Ok(())
        } else {
            Err(ValidationError::new(self.issues))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::{
        AppId, ApplyMode, CustomFieldDefinitionId, CustomerId, EntityExtensionCapabilities,
        EnumOptionId, ManyRelationDefinition, RecordMetadataLimits, RecordMetadataPatch,
        SchemaVersion,
    };

    fn validation_codes_for_options(options: &[EnumOption]) -> Vec<&'static str> {
        let mut validator = Validator::default();
        validate_enum_options(
            &mut validator,
            "fields[0].option_set".to_string(),
            options,
            EnumOptionContext::DeclaredField,
        );
        validator
            .issues
            .into_iter()
            .map(|issue| issue.code)
            .collect()
    }

    fn validation_issues_for_options(options: &[EnumOption]) -> Vec<ValidationIssue> {
        let mut validator = Validator::default();
        validate_enum_options(
            &mut validator,
            "fields[0].option_set".to_string(),
            options,
            EnumOptionContext::DeclaredField,
        );
        validator.issues
    }

    #[test]
    fn enum_alias_collision_is_reported_once_per_match_key() {
        let options = vec![
            EnumOption {
                id: EnumOptionId::from("on_leave"),
                label: "On Leave".to_string(),
                aliases: vec!["temporary".to_string()],
                ..Default::default()
            },
            EnumOption {
                id: EnumOptionId::from("temporary"),
                label: "Temporary".to_string(),
                aliases: vec![],
                ..Default::default()
            },
        ];

        assert_eq!(
            validation_codes_for_options(&options),
            vec!["duplicate_option_alias"]
        );
    }

    #[test]
    fn enum_id_match_key_collision_message_is_origin_agnostic() {
        let options = vec![
            EnumOption {
                id: EnumOptionId::from("on_leave"),
                label: "On Leave".to_string(),
                aliases: vec!["temporary".to_string()],
                ..Default::default()
            },
            EnumOption {
                id: EnumOptionId::from("temporary"),
                label: "Temporary".to_string(),
                aliases: vec![],
                ..Default::default()
            },
        ];

        let issues = validation_issues_for_options(&options);
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0].message,
            "enum option id `temporary` collides with an existing option match key for option `on_leave`"
        );
    }

    #[test]
    fn enum_alias_collisions_on_distinct_match_keys_are_reported_separately() {
        let options = vec![
            EnumOption {
                id: EnumOptionId::from("active"),
                label: "Active".to_string(),
                aliases: vec!["current".to_string(), "enabled".to_string()],
                ..Default::default()
            },
            EnumOption {
                id: EnumOptionId::from("inactive"),
                label: "Current".to_string(),
                aliases: vec!["enabled".to_string()],
                ..Default::default()
            },
        ];

        assert_eq!(
            validation_codes_for_options(&options),
            vec!["duplicate_option_alias", "duplicate_option_alias"]
        );
    }

    fn valid_schema() -> Schema {
        Schema {
            app_id: AppId::from("test_app"),
            customer_id: CustomerId::from("test_customer"),
            version: SchemaVersion::from("test.v1"),
            models: vec![
                Model {
                    id: ModelId::from("tag"),
                    kind: ModelKind::Lookup,
                    label: "Tag".to_string(),
                    display_field_id: Some(FieldId::from("name")),
                    fields: vec![Field {
                        id: FieldId::from("name"),
                        label: "Name".to_string(),
                        field_type: FieldType::Text,
                        required: true,
                        ..Default::default()
                    }],
                    ..Default::default()
                },
                Model {
                    id: ModelId::from("company"),
                    kind: ModelKind::Entity,
                    label: "Company".to_string(),
                    extensions: EntityExtensionCapabilities {
                        typed_custom_fields: true,
                        record_metadata: Some(RecordMetadataLimits {
                            max_bytes: 128,
                            max_depth: 2,
                            max_keys: 8,
                            max_key_bytes: 8,
                            max_scalar_bytes: 8,
                            max_array_items: 2,
                        }),
                    },
                    fields: vec![
                        Field {
                            id: FieldId::from("name"),
                            label: "Name".to_string(),
                            field_type: FieldType::Text,
                            required: true,
                            ..Default::default()
                        },
                        Field {
                            id: FieldId::from("status"),
                            label: "Status".to_string(),
                            field_type: FieldType::Enum,
                            option_set: vec![
                                EnumOption {
                                    id: EnumOptionId::from("active"),
                                    label: "Active".to_string(),
                                    ..Default::default()
                                },
                                EnumOption {
                                    id: EnumOptionId::from("retired"),
                                    label: "Retired".to_string(),
                                    lifecycle: SchemaElementLifecycle::Retired,
                                    ..Default::default()
                                },
                            ],
                            ..Default::default()
                        },
                    ],
                    many_relations: vec![ManyRelationDefinition {
                        id: FieldId::from("tags"),
                        label: "Tags".to_string(),
                        target_model: ModelId::from("tag"),
                        ..Default::default()
                    }],
                    ..Default::default()
                },
            ],
            custom_fields: vec![],
            change_types: vec![],
        }
    }

    fn custom_text(field_id: &str, lifecycle: SchemaElementLifecycle) -> CustomFieldDefinition {
        CustomFieldDefinition {
            id: CustomFieldDefinitionId::from(format!("company_{field_id}").as_str()),
            model_id: ModelId::from("company"),
            field_id: FieldId::from(field_id),
            label: field_id.to_string(),
            field_type: CustomFieldType::Text,
            lifecycle,
            ..Default::default()
        }
    }

    fn collision_paths(schema: &Schema, prior: Option<&Schema>) -> Vec<String> {
        validate_schema_revision(schema, prior)
            .err()
            .map(|error| {
                error
                    .issues
                    .into_iter()
                    .filter(|issue| issue.code == "custom_field_declared_field_collision")
                    .map(|issue| issue.path)
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn custom_field_collisions_are_rejected_unless_the_prior_revision_held_them() {
        let mut prior = valid_schema();
        prior
            .custom_fields
            .push(custom_text("Tags", SchemaElementLifecycle::Active));
        let mut schema = prior.clone();
        schema
            .custom_fields
            .push(custom_text("name", SchemaElementLifecycle::Active));

        // A many-relation id collides like a field id, after normalization.
        assert_eq!(
            collision_paths(&schema, None),
            ["custom_fields[0].field_id", "custom_fields[1].field_id"]
        );
        assert_eq!(
            collision_paths(&schema, Some(&prior)),
            ["custom_fields[1].field_id"]
        );
        // A retired prior field grants no tolerance.
        let mut retired_prior = valid_schema();
        retired_prior
            .custom_fields
            .push(custom_text("tags", SchemaElementLifecycle::Retired));
        assert_eq!(
            collision_paths(&prior, Some(&retired_prior)),
            ["custom_fields[0].field_id"]
        );
    }

    fn apply_with_write(write: RowVersionWrite) -> ApplyChangeSet {
        ApplyChangeSet {
            app_id: AppId::from("test_app"),
            customer_id: CustomerId::from("test_customer"),
            schema_revision_id: None,
            actor_id: Some("tester".to_string()),
            source_kind: "test".to_string(),
            source_ref: None,
            idempotency_key: None,
            change_type_id: None,
            notes: None,
            mode: ApplyMode::Mainline,
            writes: vec![write],
        }
    }

    #[test]
    fn validates_lookup_display_and_many_relation_contract() {
        let mut schema = valid_schema();
        assert!(validate_schema(&schema).is_ok());

        schema.models[0].fields[0].required = false;
        let error = validate_schema(&schema).unwrap_err();
        assert!(error
            .issues
            .iter()
            .any(|issue| issue.code == "invalid_lookup_display_field"));

        schema = valid_schema();
        schema.models[1].many_relations[0].target_model = ModelId::from("missing");
        let error = validate_schema(&schema).unwrap_err();
        assert!(error
            .issues
            .iter()
            .any(|issue| issue.code == "unknown_many_relation_target"));
    }

    #[test]
    fn custom_field_lifecycle_and_model_opt_in_are_single_authorities() {
        let mut schema = valid_schema();
        schema.custom_fields.push(CustomFieldDefinition {
            id: CustomFieldDefinitionId::from("company_risk_definition"),
            model_id: ModelId::from("company"),
            field_id: FieldId::from("risk"),
            label: "Risk".to_string(),
            field_type: CustomFieldType::Text,
            ..Default::default()
        });
        assert!(validate_schema(&schema).is_ok());

        schema.models[1].extensions.typed_custom_fields = false;
        let error = validate_schema(&schema).unwrap_err();
        assert!(error
            .issues
            .iter()
            .any(|issue| issue.code == "custom_fields_not_enabled"));

        schema.models[1].extensions.typed_custom_fields = true;
        schema.custom_fields[0].archived_at = Some(
            "2026-08-05T00:00:00Z"
                .parse()
                .expect("valid test timestamp"),
        );
        let error = validate_schema(&schema).unwrap_err();
        assert!(error
            .issues
            .iter()
            .any(|issue| issue.code == "custom_field_lifecycle_mismatch"));

        // Lookups opt in the same way, but never take record metadata.
        let mut schema = valid_schema();
        schema.custom_fields.push(CustomFieldDefinition {
            id: CustomFieldDefinitionId::from("tag_owner_definition"),
            model_id: ModelId::from("tag"),
            field_id: FieldId::from("owner"),
            label: "Owner".to_string(),
            field_type: CustomFieldType::Text,
            ..Default::default()
        });
        let error = validate_schema(&schema).unwrap_err();
        assert!(error
            .issues
            .iter()
            .any(|issue| issue.code == "custom_fields_not_enabled"));

        schema.models[0].extensions.typed_custom_fields = true;
        assert!(validate_schema(&schema).is_ok());

        schema.models[0].extensions.record_metadata =
            schema.models[1].extensions.record_metadata.clone();
        let error = validate_schema(&schema).unwrap_err();
        assert!(error
            .issues
            .iter()
            .any(|issue| issue.code == "lookup_extensions_forbidden"));
    }

    #[test]
    fn rejects_new_values_for_retired_models_fields_and_enum_options() {
        let schema = valid_schema();
        let mut values = BTreeMap::new();
        values.insert(
            FieldId::from("status"),
            FieldValue::Enum(EnumOptionId::from("retired")),
        );
        let write = RowVersionWrite {
            model_id: ModelId::from("company"),
            new_record_id: Some(uuid::Uuid::new_v4()),
            values: Some(values),
            ..Default::default()
        };
        let error = validate_apply_against_schema(&apply_with_write(write), &schema).unwrap_err();
        assert!(error
            .issues
            .iter()
            .any(|issue| issue.code == "retired_enum_option"));

        let mut schema = valid_schema();
        schema.models[1].fields[0].lifecycle = SchemaElementLifecycle::Retired;
        let write = RowVersionWrite {
            model_id: ModelId::from("company"),
            new_record_id: Some(uuid::Uuid::new_v4()),
            values: Some(BTreeMap::from([(
                FieldId::from("name"),
                FieldValue::Text("Acme".to_string()),
            )])),
            ..Default::default()
        };
        let error = validate_apply_against_schema(&apply_with_write(write), &schema).unwrap_err();
        assert!(error
            .issues
            .iter()
            .any(|issue| issue.code == "retired_write_field"));

        schema.models[1].lifecycle = SchemaElementLifecycle::Retired;
        let write = RowVersionWrite {
            model_id: ModelId::from("company"),
            new_record_id: Some(uuid::Uuid::new_v4()),
            values: Some(BTreeMap::from([(
                FieldId::from("status"),
                FieldValue::Enum(EnumOptionId::from("active")),
            )])),
            ..Default::default()
        };
        let error = validate_apply_against_schema(&apply_with_write(write), &schema).unwrap_err();
        assert!(error
            .issues
            .iter()
            .any(|issue| issue.code == "retired_write_model"));
    }

    #[test]
    fn rejects_version_preconditions_outside_mainline() {
        let schema = valid_schema();
        let mut apply = apply_with_write(RowVersionWrite {
            model_id: ModelId::from("company"),
            record_key: Some(RecordKey::RecordId(uuid::Uuid::new_v4())),
            expected_version_id: Some(uuid::Uuid::new_v4()),
            values: Some(BTreeMap::from([(
                FieldId::from("name"),
                FieldValue::Text("Acme".to_string()),
            )])),
            ..Default::default()
        });
        apply.mode = ApplyMode::Draft;
        let error = validate_apply_against_schema(&apply, &schema).unwrap_err();
        assert!(error
            .issues
            .iter()
            .any(|issue| issue.code == "version_precondition_requires_mainline"));

        apply.mode = ApplyMode::Mainline;
        apply.writes[0].record_key = None;
        let error = validate_apply_against_schema(&apply, &schema).unwrap_err();
        assert!(error
            .issues
            .iter()
            .any(|issue| issue.code == "create_version_precondition_forbidden"));
    }

    #[test]
    fn validates_clear_disjointness_and_recursive_metadata_limits() {
        let schema = valid_schema();
        let write = RowVersionWrite {
            model_id: ModelId::from("company"),
            new_record_id: Some(uuid::Uuid::new_v4()),
            values: Some(BTreeMap::from([(
                FieldId::from("name"),
                FieldValue::Text("Acme".to_string()),
            )])),
            clear_fields: vec![FieldId::from("name")],
            metadata_patch: Some(RecordMetadataPatch {
                set: BTreeMap::from([(
                    "too_long_key".to_string(),
                    serde_json::json!({"nested": ["123456789", 2, 3]}),
                )]),
                ..Default::default()
            }),
            ..Default::default()
        };
        let error = validate_apply_against_schema(&apply_with_write(write), &schema).unwrap_err();
        for code in [
            "set_and_clear_field",
            "required_field_clear",
            "metadata_key_size_limit_exceeded",
            "metadata_scalar_limit_exceeded",
            "metadata_array_limit_exceeded",
        ] {
            assert!(
                error.issues.iter().any(|issue| issue.code == code),
                "missing validation code {code}: {:?}",
                error.issues
            );
        }
    }

    #[test]
    fn validates_many_relation_values_and_lookup_record_lifecycle() {
        let schema = valid_schema();
        let relation_id = FieldId::from("tags");
        let relation_write = RowVersionWrite {
            model_id: ModelId::from("company"),
            new_record_id: Some(uuid::Uuid::new_v4()),
            values: Some(BTreeMap::from([(
                relation_id.clone(),
                FieldValue::RelationList(vec![RecordKey::RecordId(uuid::Uuid::new_v4())]),
            )])),
            ..Default::default()
        };
        assert!(validate_apply_against_schema(&apply_with_write(relation_write), &schema).is_ok());

        let conflicting_clear = RowVersionWrite {
            model_id: ModelId::from("company"),
            record_key: Some(RecordKey::RecordId(uuid::Uuid::new_v4())),
            values: Some(BTreeMap::from([(
                relation_id.clone(),
                FieldValue::RelationList(vec![]),
            )])),
            clear_fields: vec![relation_id],
            ..Default::default()
        };
        let error = validate_apply_against_schema(&apply_with_write(conflicting_clear), &schema)
            .unwrap_err();
        assert!(error
            .issues
            .iter()
            .any(|issue| issue.code == "set_and_clear_field"));

        let lookup_lifecycle = RowVersionWrite {
            model_id: ModelId::from("tag"),
            record_key: Some(RecordKey::RecordId(uuid::Uuid::new_v4())),
            values: Some(BTreeMap::from([(
                FieldId::from(LOOKUP_LIFECYCLE_FIELD_ID),
                FieldValue::SchemaLifecycle(SchemaElementLifecycle::Retired),
            )])),
            ..Default::default()
        };
        assert!(
            validate_apply_against_schema(&apply_with_write(lookup_lifecycle), &schema).is_ok()
        );

        let entity_lifecycle = RowVersionWrite {
            model_id: ModelId::from("company"),
            record_key: Some(RecordKey::RecordId(uuid::Uuid::new_v4())),
            values: Some(BTreeMap::from([(
                FieldId::from(LOOKUP_LIFECYCLE_FIELD_ID),
                FieldValue::SchemaLifecycle(SchemaElementLifecycle::Retired),
            )])),
            ..Default::default()
        };
        let error = validate_apply_against_schema(&apply_with_write(entity_lifecycle), &schema)
            .unwrap_err();
        assert!(error
            .issues
            .iter()
            .any(|issue| issue.code == "invalid_lookup_lifecycle_value"));
    }

    #[test]
    fn retired_enum_aliases_can_transfer_but_retired_ids_remain_reserved() {
        let retired = EnumOption {
            id: EnumOptionId::from("legacy"),
            label: "Legacy label".to_string(),
            aliases: vec!["transfer me".to_string()],
            lifecycle: SchemaElementLifecycle::Retired,
            ..Default::default()
        };
        let active = EnumOption {
            id: EnumOptionId::from("current"),
            label: "Current".to_string(),
            aliases: vec!["transfer me".to_string()],
            ..Default::default()
        };
        assert!(validation_codes_for_options(&[retired.clone(), active.clone()]).is_empty());

        let reserved_id_alias = EnumOption {
            aliases: vec!["legacy".to_string()],
            ..active
        };
        assert_eq!(
            validation_codes_for_options(&[retired, reserved_id_alias]),
            vec!["duplicate_option_alias"]
        );
    }
}
