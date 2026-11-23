type FieldShape = {
  type?: string;
  target_model?: string;
  option_set?: readonly { id: string }[];
};

type BlockShape = {
  name: string;
  fields: Record<string, FieldShape>;
  field_groups?: readonly { id: string; fields: readonly string[] }[];
  related?: readonly BlockShape[];
};

export function fieldGroupShape(block: BlockShape): {
  declaredFieldIds: string[];
  groupIds: string[];
  groupedFieldIds: string[];
} {
  const groupIds = (block.field_groups ?? []).map((group) => group.id);
  const duplicateGroupId = groupIds.find((groupId, index) => groupIds.indexOf(groupId) !== index);
  if (duplicateGroupId) throw new Error(`duplicate field group id ${duplicateGroupId}`);
  const reservedGroupId = groupIds.find((groupId) =>
    ["details", "other", "custom"].includes(groupId.toLowerCase()),
  );
  if (reservedGroupId) throw new Error(`reserved field group id ${reservedGroupId}`);
  return {
    declaredFieldIds: Object.keys(block.fields).sort(),
    groupIds,
    groupedFieldIds: (block.field_groups ?? []).flatMap((group) => group.fields).sort(),
  };
}

export function enumFieldShapes(blocks: readonly BlockShape[]): Array<[string, string[]]> {
  const result: Array<[string, string[]]> = [];
  for (const block of blocks) {
    for (const [fieldId, field] of Object.entries(block.fields)) {
      if (field.type === "enum") {
        result.push([
          `${block.name}.${fieldId}`,
          (field.option_set ?? []).map((option) => option.id),
        ]);
      }
    }
    result.push(...enumFieldShapes(block.related ?? []));
  }
  return result;
}
