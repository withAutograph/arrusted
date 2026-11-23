import type { FieldValue, Model, ModelId, Schema, VisibleRecord } from "@contracts";
import {
  relationLabelFormatter,
  type FieldOverrides,
  type RelationOption,
} from "@modules/editable-grid";

import {
  activeCustomFieldIds,
  projectRecordCustomFields,
  schemaWithCustomFields,
} from "../engines/custom-field-projection/index";
import type { WorkspaceDraft } from "./draft";
import type { CsvAgentWorkspacePresentation } from "./CsvAgentWorkspace";
import type { CsvWorkspaceContext } from "./types";

export type CsvWorkspaceRecordLabel = (input: {
  model: Model;
  record: VisibleRecord;
  schema: Schema;
}) => string | null | undefined;

function primitiveLabel(value: FieldValue | null | undefined): string | undefined {
  if (!value || !("value" in value)) return undefined;
  const primitive = value.value;
  if (typeof primitive === "string" || typeof primitive === "number") return String(primitive);
  if (typeof primitive === "boolean") return primitive ? "Yes" : "No";
  return undefined;
}

function labelRecord(
  schema: Schema,
  model: Model,
  record: VisibleRecord,
  customLabel: CsvWorkspaceRecordLabel | undefined,
) {
  const custom = customLabel?.({ schema, model, record })?.trim();
  if (custom) return custom;
  const declared = model.display_field_id
    ? primitiveLabel(record.values[model.display_field_id])
    : undefined;
  return declared?.trim() || `Unnamed ${model.label.toLocaleLowerCase()}`;
}

// Saved values as the grid shows them: declared values plus the model's
// active custom values, by field id.
function projectedValues(schema: Schema, modelId: string, record: VisibleRecord | undefined) {
  if (!record) return {};
  return projectRecordCustomFields(record, activeCustomFieldIds(schema, modelId as ModelId)).values;
}

export function buildCsvWorkspacePresentation(
  context: CsvWorkspaceContext,
  draft: WorkspaceDraft | null,
  recordLabel?: CsvWorkspaceRecordLabel,
): CsvAgentWorkspacePresentation {
  const populations = new Map(
    Object.entries(context.recordsByModel).map(([modelId, records]) => [
      modelId,
      new Map(records.map((record) => [String(record.record_id), record])),
    ]),
  );
  for (const row of draft?.rows ?? []) {
    let records = populations.get(row.modelId);
    if (!records) {
      records = new Map();
      populations.set(row.modelId, records);
    }
    const prior = records.get(row.recordId);
    const values = { ...projectedValues(context.schema, row.modelId, prior), ...row.values };
    for (const fieldId of row.clearFields) delete values[fieldId];
    records.set(row.recordId, {
      record_id: row.recordId,
      // A staged update keeps the loaded record's external key, so links
      // stored by that key still resolve.
      external_key: prior?.external_key ?? null,
      effective_start: row.effectiveStart,
      effective_end: null,
      custom_fields: prior?.custom_fields ?? [],
      values,
    });
  }

  // Relation pickers and labels for every relation field the grid shows,
  // declared and active custom, from the target model's loaded records.
  const gridSchema = schemaWithCustomFields(context.schema);
  const modelsById = new Map(gridSchema.models.map((model) => [model.id, model]));
  const fieldOverridesByModel = {} as Record<ModelId, FieldOverrides>;
  for (const model of gridSchema.models) {
    fieldOverridesByModel[model.id] = Object.fromEntries(
      model.fields.flatMap((field) => {
        if (field.type !== "relation" || !field.target_model) return [];
        const target = modelsById.get(field.target_model);
        const records = [...(populations.get(field.target_model)?.values() ?? [])];
        const labelled = records.map((record) => ({
          record,
          label: target
            ? labelRecord(context.schema, target, record, recordLabel)
            : "Unnamed record",
        }));
        const labelCounts = new Map<string, number>();
        for (const { label } of labelled) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
        // Records sharing a label (e.g. several unnamed ones) are told apart
        // by their external key, else the date they took effect.
        const suffixed = labelled.map(({ record, label }) =>
          (labelCounts.get(label) ?? 0) > 1
            ? `${label} (${record.external_key ?? `since ${record.effective_start}`})`
            : label,
        );
        // Labels still identical after the suffix get an ordinal.
        const suffixedCounts = new Map<string, number>();
        for (const label of suffixed) {
          suffixedCounts.set(label, (suffixedCounts.get(label) ?? 0) + 1);
        }
        const ordinals = new Map<string, number>();
        const options: RelationOption[] = labelled.map(({ record }, index) => {
          const base = suffixed[index] ?? "";
          let label = base;
          if ((suffixedCounts.get(base) ?? 0) > 1) {
            const ordinal = (ordinals.get(base) ?? 0) + 1;
            ordinals.set(base, ordinal);
            label = `${base} (${ordinal})`;
          }
          return {
            key: { type: "record_id" as const, value: String(record.record_id) },
            label,
            ...(record.external_key
              ? { aliasKeys: [{ type: "external_key" as const, value: record.external_key }] }
              : {}),
            // Retired targets still label stored values but aren't offered.
            ...(record.availability === "retired" ? { retired: true } : {}),
          };
        });
        const unknown = `Unknown ${target?.label.toLocaleLowerCase() ?? "record"}`;
        return [
          [
            field.id,
            {
              relationOptions: options,
              // Labels never fall back to a record key. A lookup-or-create
              // value names the record it will create, so it shows that name.
              formatValue: relationLabelFormatter(options, unknown),
            },
          ],
        ];
      }),
    );
  }

  return {
    schema: context.schema,
    scope: context.scope,
    asOf: context.asOf,
    models: context.schema.models.map((model) => ({
      modelId: model.id,
      label: model.label,
    })),
    fieldOverridesByModel,
    priorValuesByRowId: Object.fromEntries(
      (draft?.rows ?? []).map((row) => [
        row.rowId,
        projectedValues(
          context.schema,
          row.modelId,
          context.recordsByModel[row.modelId]?.find(
            (record) => String(record.record_id) === row.recordId,
          ),
        ),
      ]),
    ),
  };
}
