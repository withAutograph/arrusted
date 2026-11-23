import type {
  AuthoredFieldGroups,
  FieldGroupDefinition,
} from "../../../engines/field-groups/index";

export type {
  AuthoredFieldGroups,
  FieldGroupDefinition,
} from "../../../engines/field-groups/index";

export function defineFieldGroups<const TGroups extends readonly FieldGroupDefinition[]>(
  _modelId: string,
  groups: TGroups & AuthoredFieldGroups<TGroups>,
): TGroups {
  return groups;
}

// Domain declarations expose the generic catalog AST as type-only vocabulary.
// Catalog traversal, validation, and serialization remain owned by the engine.
export type * from "@engines/schema-catalog";
export type { ImportIdentityPolicy, ImportIdentityRung } from "@engines/import-classification";
