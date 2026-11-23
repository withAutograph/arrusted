export type FieldGroupDefinition = {
  id: string;
  label: string;
  fields: readonly string[];
};

export type ResolvedFieldGroup<TField> = {
  id: string;
  label: string;
  fields: readonly TField[];
};

type FieldLike = { id: string };
type ReservedFallbackGroupId = "details" | "other" | "custom";
export type AuthoredFieldGroups<TGroups extends readonly FieldGroupDefinition[]> = {
  readonly [TIndex in keyof TGroups]: TGroups[TIndex] extends FieldGroupDefinition
    ? Lowercase<TGroups[TIndex]["id"]> extends ReservedFallbackGroupId
      ? never
      : TGroups[TIndex]
    : never;
};

const RESERVED_FALLBACK_GROUP_IDS = new Set(["details", "other", "custom"]);

function assertAuthoredGroupId(modelId: string, groupId: string): void {
  if (RESERVED_FALLBACK_GROUP_IDS.has(groupId.toLowerCase())) {
    throw new Error(`${modelId}: field group id ${groupId} is reserved for runtime fallback`);
  }
}

function assertFieldGroupDefinitions(
  modelId: string,
  groups: readonly FieldGroupDefinition[],
): void {
  const groupIds = new Set<string>();
  for (const group of groups) {
    if (!group.id.trim()) throw new Error(`${modelId}: field group id must not be blank`);
    if (!group.label.trim()) {
      throw new Error(`${modelId}.${group.id}: field group label must not be blank`);
    }
    if (groupIds.has(group.id)) {
      throw new Error(`${modelId}: duplicate field group id ${group.id}`);
    }
    assertAuthoredGroupId(modelId, group.id);
    groupIds.add(group.id);
  }
}

export function assertFieldGroupPartition(
  modelId: string,
  fieldIds: readonly string[],
  groups: readonly FieldGroupDefinition[],
): void {
  const declared = new Set(fieldIds);
  const grouped = new Set<string>();
  assertFieldGroupDefinitions(modelId, groups);

  for (const group of groups) {
    for (const fieldId of group.fields) {
      if (!declared.has(fieldId)) {
        throw new Error(`${modelId}.${group.id}: unknown field ${fieldId}`);
      }
      if (grouped.has(fieldId)) {
        throw new Error(`${modelId}: field ${fieldId} belongs to more than one field group`);
      }
      grouped.add(fieldId);
    }
  }

  const missing = fieldIds.filter((fieldId) => !grouped.has(fieldId));
  if (missing.length > 0) {
    throw new Error(`${modelId}: ungrouped fields ${missing.join(", ")}`);
  }
}

export function resolveFieldGroups<TField extends FieldLike>(args: {
  fields: readonly TField[];
  definitions?: readonly FieldGroupDefinition[];
  customFieldIds?: ReadonlySet<string>;
}): readonly ResolvedFieldGroup<TField>[] {
  const { fields, definitions = [], customFieldIds = new Set<string>() } = args;
  if (definitions.length === 0) {
    const detailsFields = fields.filter((field) => !customFieldIds.has(field.id));
    const customFields = fields.filter((field) => customFieldIds.has(field.id));
    return [
      ...(detailsFields.length > 0
        ? [{ id: "details", label: "Details", fields: detailsFields }]
        : []),
      ...(customFields.length > 0
        ? [{ id: "custom", label: "Custom fields", fields: customFields }]
        : []),
    ];
  }

  const fieldById = new Map(fields.map((field) => [field.id, field]));
  const consumed = new Set<string>();
  const resolved: ResolvedFieldGroup<TField>[] = [];
  assertFieldGroupDefinitions("field groups", definitions);

  for (const definition of definitions) {
    const groupFields: TField[] = [];
    for (const fieldId of definition.fields) {
      const field = fieldById.get(fieldId);
      if (!field || consumed.has(fieldId)) continue;
      consumed.add(fieldId);
      groupFields.push(field);
    }
    if (groupFields.length > 0) {
      resolved.push({ id: definition.id, label: definition.label, fields: groupFields });
    }
  }

  const customFields: TField[] = [];
  const otherFields: TField[] = [];
  for (const field of fields) {
    if (consumed.has(field.id)) continue;
    if (customFieldIds.has(field.id)) customFields.push(field);
    else otherFields.push(field);
  }

  if (otherFields.length > 0) {
    resolved.push({ id: "other", label: "Other fields", fields: otherFields });
  }
  if (customFields.length > 0) {
    resolved.push({ id: "custom", label: "Custom fields", fields: customFields });
  }

  return resolved;
}
