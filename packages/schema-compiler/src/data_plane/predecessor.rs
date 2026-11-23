use std::collections::BTreeMap;

use kernel::{Field, FieldId, ModelId, ModelKind, SchemaElementLifecycle};
use serde_json::{json, Value};

use crate::CompiledManifest;

/// The digest is over the immutable compiled artifact bytes used by the installer.
pub struct DataPlanePredecessor {
    pub artifact_sha256: String,
    pub compiled: CompiledManifest,
}

pub(super) fn compatibility(
    candidate: &CompiledManifest,
    predecessors: &[DataPlanePredecessor],
) -> Option<Value> {
    let compatible: BTreeMap<_, _> = predecessors
        .iter()
        .filter_map(|predecessor| {
            let (model, field) = optional_text_addition(&predecessor.compiled, candidate)?;
            Some((
                &predecessor.artifact_sha256,
                json!({
                    "artifactSha256": predecessor.artifact_sha256,
                    "schema": predecessor.compiled.schema,
                    "field": {"modelId": model, "fieldId": field},
                }),
            ))
        })
        .collect();
    if compatible.is_empty() {
        return None;
    }
    Some(json!({
        "kind": "optional-text-addition-v1",
        "predecessors": compatible.into_values().collect::<Vec<_>>(),
    }))
}

pub(crate) fn optional_text_addition(
    previous: &CompiledManifest,
    candidate: &CompiledManifest,
) -> Option<(ModelId, FieldId)> {
    if candidate.schema.version == previous.schema.version {
        return None;
    }

    let mut additions = candidate.schema.models.iter().flat_map(|model| {
        let previous_model = previous.schema.models.iter().find(|old| old.id == model.id);
        model.fields.iter().filter_map(move |field| {
            let previous_model = previous_model?;
            (!previous_model.fields.iter().any(|old| old.id == field.id)).then_some((model, field))
        })
    });
    let (model, field) = additions.next()?;
    if additions.next().is_some()
        || model.kind != ModelKind::Entity
        || model.lifecycle != SchemaElementLifecycle::Active
        || field
            != &(Field {
                id: field.id.clone(),
                label: field.label.clone(),
                ..Field::default()
            })
    {
        return None;
    }

    let mut remaining = candidate.clone();
    remaining.schema.version = previous.schema.version.clone();
    let remaining_model = remaining
        .schema
        .models
        .iter_mut()
        .find(|entry| entry.id == model.id)?;
    remaining_model.fields.retain(|entry| entry.id != field.id);
    remaining.extras.field_metadata.retain(|metadata| {
        metadata.model != model.id.as_str() || metadata.field != field.id.as_str()
    });
    for change in &mut remaining.schema.change_types {
        if change.target_model == model.id
            && previous
                .schema
                .change_types
                .iter()
                .any(|before| before.id == change.id && !before.touches.is_empty())
        {
            change.touches.retain(|entry| *entry != field.id);
        }
    }

    (&remaining == previous).then(|| (model.id.clone(), field.id.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(version: &str) -> CompiledManifest {
        serde_json::from_value(json!({
            "schema": {
                "app_id": "fixture", "customer_id": "template", "version": version,
                "models": [{
                    "id": "entry", "kind": "entity", "label": "Entry",
                    "fields": [{"id": "name", "label": "Name", "type": "text", "required": true}]
                }],
                "change_types": [{"id": "edit", "label": "Edit", "target_model": "entry", "touches": ["name"]}]
            },
            "extras": {
                "model_metadata": [], "field_metadata": [], "inverse_relations": [],
                "many_relations": [], "constraints": [], "derived_fields": [], "seed_change_sets": []
            }
        }))
        .expect("compiled fixture")
    }

    #[test]
    fn emits_exact_predecessor_in_manifest_and_runtime_definition() {
        let artifact_sha256 = "1".repeat(64);
        let previous = fixture("v1");
        let expected = json!({
            "kind": "optional-text-addition-v1",
            "predecessors": [{
                "artifactSha256": artifact_sha256,
                "schema": previous.schema,
                "field": {"modelId": "entry", "fieldId": "notes"},
            }]
        });
        let mut candidate = fixture("v2");
        candidate.schema.models[0].fields.push(Field {
            id: "notes".into(),
            label: "Notes".to_string(),
            ..Field::default()
        });
        candidate.schema.change_types[0]
            .touches
            .push("notes".into());

        let generated = super::super::compile_with_predecessors(
            &candidate,
            &[DataPlanePredecessor {
                artifact_sha256,
                compiled: previous,
            }],
        )
        .expect("generate candidate data plane");
        assert_eq!(generated["manifest"]["predecessorCompatibility"], expected);
        assert!(generated["typescript"]
            .as_str()
            .expect("typescript")
            .contains(&format!(
                "export const definition = {} as const satisfies DataDefinition;",
                serde_json::to_string_pretty(&generated["manifest"]).expect("manifest")
            )));
        assert!(
            super::super::compile(&candidate).expect("legacy generation")["manifest"]
                .get("predecessorCompatibility")
                .is_none()
        );
    }

    #[test]
    fn declines_required_fields_and_other_changes_in_the_same_candidate() {
        let previous = fixture("v1");
        let mut candidate = fixture("v2");
        candidate.schema.models[0].fields.push(Field {
            id: "notes".into(),
            label: "Notes".to_string(),
            required: true,
            ..Field::default()
        });
        assert!(optional_text_addition(&previous, &candidate).is_none());
        candidate.schema.models[0].fields[1].required = false;
        candidate.schema.models[0].fields[0].label = "Modified existing field".to_string();
        assert!(optional_text_addition(&previous, &candidate).is_none());
        candidate.schema.models[0].fields[0].label = "Name".to_string();
        candidate.schema.change_types[0]
            .required
            .push("notes".into());
        assert!(optional_text_addition(&previous, &candidate).is_none());
        candidate.schema.change_types[0].required.clear();
        candidate.schema.customer_id = "another-tenant".into();
        assert!(optional_text_addition(&previous, &candidate).is_none());
    }
}
