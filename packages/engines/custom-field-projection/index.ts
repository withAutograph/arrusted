import type {
  CustomFieldDefinition,
  CustomFieldEntry,
  Field,
  FieldId,
  FieldValue,
  ModelId,
  RowVersionWrite,
  Schema,
  VisibleRecord,
} from "@contracts";

// Custom-field projection lets field-driven surfaces (grids, forms, record
// views) treat a model's active tenant custom fields as ordinary fields. The
// wire keeps them apart: definitions live in `schema.custom_fields`, values in
// `VisibleRecord.custom_fields`, writes in `RowVersionWrite.custom_fields` /
// `clear_custom_fields`. These helpers convert in both directions.

export function isActiveCustomField(definition: CustomFieldDefinition): boolean {
  return definition.lifecycle !== "retired" && (definition.archived_at ?? null) === null;
}

// A definition whose field id the model already declares is left out, so it
// can never shadow the declared field's value or reroute its writes.
export function activeCustomFields(
  schema: Schema,
  modelId: ModelId,
): readonly CustomFieldDefinition[] {
  const declared = new Set(
    schema.models.find((model) => model.id === modelId)?.fields.map((field) => field.id) ?? [],
  );
  return (schema.custom_fields ?? []).filter(
    (definition) =>
      definition.model_id === modelId &&
      isActiveCustomField(definition) &&
      !declared.has(definition.field_id),
  );
}

export function activeCustomFieldIds(schema: Schema, modelId: ModelId): ReadonlySet<FieldId> {
  return new Set(activeCustomFields(schema, modelId).map((definition) => definition.field_id));
}

export function customFieldDefinitionAsField(definition: CustomFieldDefinition): Field {
  return {
    id: definition.field_id,
    label: definition.label,
    type: definition.type,
    required: false,
    target_model: definition.target_model_id ?? null,
    option_set: definition.option_set ?? [],
  };
}

// Appends each model's active custom fields to its declared fields, in
// definition order. Each surface projects once, from the unprojected schema.
export function schemaWithCustomFields(schema: Schema): Schema {
  return {
    ...schema,
    models: schema.models.map((model) => {
      const custom = activeCustomFields(schema, model.id);
      if (custom.length === 0) return model;
      return { ...model, fields: [...model.fields, ...custom.map(customFieldDefinitionAsField)] };
    }),
  };
}

export function projectCustomFields(
  values: Readonly<Record<FieldId, FieldValue | null>>,
  customFields: readonly CustomFieldEntry[],
  allowedCustomFieldIds?: ReadonlySet<FieldId>,
): Record<FieldId, FieldValue | null> {
  const projected = { ...values };
  for (const entry of customFields) {
    if (allowedCustomFieldIds && !allowedCustomFieldIds.has(entry.field_id)) continue;
    const { field_id: fieldId, ...value } = entry;
    projected[fieldId] = value;
  }
  return projected;
}

// Projects a record's active custom-field entries into `values`. Entries for
// retired definitions stay only in `custom_fields`. Returns the same record
// when there is nothing to project.
export function projectRecordCustomFields(
  record: VisibleRecord,
  customFieldIds: ReadonlySet<FieldId>,
): VisibleRecord {
  if (customFieldIds.size === 0) return record;
  const entries = (record.custom_fields ?? []).filter((entry) =>
    customFieldIds.has(entry.field_id),
  );
  if (entries.length === 0) return record;
  return {
    ...record,
    values: projectCustomFields(record.values, entries) as Record<FieldId, FieldValue>,
  };
}

export function splitProjectedCustomFields(
  values: Readonly<Record<FieldId, FieldValue>>,
  customFieldIds: ReadonlySet<FieldId>,
): { values: Record<FieldId, FieldValue>; customFields: CustomFieldEntry[] } {
  const declared: Record<FieldId, FieldValue> = {};
  const customFields: CustomFieldEntry[] = [];
  for (const [fieldId, value] of Object.entries(values) as [FieldId, FieldValue][]) {
    if (customFieldIds.has(fieldId)) {
      customFields.push({ field_id: fieldId, ...value } as CustomFieldEntry);
    } else declared[fieldId] = value;
  }
  return { values: declared, customFields };
}

// Moves projected custom-field ids out of `values` / `clear_fields` into
// `custom_fields` / `clear_custom_fields`, so a write built from a projected
// row reaches the kernel in canonical shape.
export function splitCustomFieldsFromWrites(
  writes: readonly RowVersionWrite[],
  schema: Schema,
): RowVersionWrite[] {
  const customFieldIdsByModel = new Map<ModelId, ReadonlySet<FieldId>>();
  return writes.map((write) => {
    const customFieldIds =
      customFieldIdsByModel.get(write.model_id) ?? activeCustomFieldIds(schema, write.model_id);
    customFieldIdsByModel.set(write.model_id, customFieldIds);
    if (customFieldIds.size === 0) return write;
    const split = write.values
      ? splitProjectedCustomFields(write.values, customFieldIds)
      : { values: write.values, customFields: [] };
    const declaredClears = (write.clear_fields ?? []).filter((id) => !customFieldIds.has(id));
    const customClears = (write.clear_fields ?? []).filter((id) => customFieldIds.has(id));
    if (split.customFields.length === 0 && customClears.length === 0) return write;
    const projectedFieldIds = new Set([
      ...split.customFields.map((entry) => entry.field_id),
      ...customClears,
    ]);
    const next: RowVersionWrite = {
      ...write,
      values: split.values,
      custom_fields: [
        ...(write.custom_fields ?? []).filter((entry) => !projectedFieldIds.has(entry.field_id)),
        ...split.customFields,
      ],
    };
    if (write.clear_fields !== undefined) {
      if (declaredClears.length > 0) next.clear_fields = declaredClears;
      else delete next.clear_fields;
    }
    const customClearIds = new Set(customClears);
    const clearCustomFields = [
      ...(write.clear_custom_fields ?? []).filter((id) => !customClearIds.has(id)),
      ...customClears,
    ];
    if (clearCustomFields.length > 0) next.clear_custom_fields = clearCustomFields;
    return next;
  });
}
