import type { Field } from "@contracts";

export type EditableGridFieldCapability = {
  relationOptions?: ReadonlyArray<unknown>;
  searchRelationOptions?: unknown;
};

export function isEditableGridField(
  field: Pick<Field, "type" | "option_set">,
  capability?: EditableGridFieldCapability,
): boolean {
  switch (field.type) {
    case "text":
    case "iso_country":
    case "iso_currency":
    case "number":
    case "bool":
    case "date":
    case "datetime":
    case "text_list":
    case "money_rate":
      return true;
    case "enum":
      return (field.option_set?.length ?? 0) > 0;
    case "relation":
      return (
        capability?.searchRelationOptions !== undefined ||
        (capability?.relationOptions?.length ?? 0) > 0
      );
    default:
      return false;
  }
}
