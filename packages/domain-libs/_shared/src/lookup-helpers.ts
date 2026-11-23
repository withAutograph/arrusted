import type { EnumOption } from "@contracts";

import type { EnumFieldDefinition, FieldGroup, LookupSeedRow } from "./_types";

/**
 * Standard fields for all lookup models.
 *
 * Lookup models expose only display + alias fields in schema. Their
 * seed-row external_key is authoring/addressing plumbing, not a field.
 *
 * All lookup models include these two fields:
 * - name: Unique display name
 * - known_aliases: Array of aliases/alternative values from source systems
 */
export const LOOKUP_MODEL_FIELDS: FieldGroup = {
  name: { type: "text", label: "Name", is_unique: true },
  known_aliases: { type: "text_list", label: "Aliases" },
} as const;

export const PLACEHOLDER_ENUM_OPTIONS: readonly EnumOption[] = [
  { id: "unspecified", label: "Unspecified", aliases: [] },
];

export function enumOptionsFromLookupSeedRows(
  rows: readonly LookupSeedRow[] = [],
): readonly EnumOption[] {
  return rows.map((row) => ({
    id: row.external_key,
    label: String(row.values.name ?? row.external_key),
    aliases: textListValue(row.values.known_aliases),
  }));
}

export function enumFieldFromLookupSeedRows(
  rows: readonly LookupSeedRow[] = [],
  metadata: Omit<EnumFieldDefinition, "type" | "option_set"> = {},
): EnumFieldDefinition {
  return {
    type: "enum",
    option_set: enumOptionsFromLookupSeedRows(rows),
    ...metadata,
  };
}

export function placeholderEnumField(
  metadata: Omit<EnumFieldDefinition, "type" | "option_set"> = {},
): EnumFieldDefinition {
  return {
    type: "enum",
    option_set: PLACEHOLDER_ENUM_OPTIONS,
    ...metadata,
  };
}

function textListValue(value: LookupSeedRow["values"][string] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String);
}
