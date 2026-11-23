import type { SchemaFormFieldSpec, SchemaFormValue } from "./SchemaForm";

export function coerceSchemaFormValue(field: SchemaFormFieldSpec, value: string): SchemaFormValue {
  if (value === "" && (field.control === "number" || field.control === "date")) {
    return null;
  }
  if (field.control !== "number") {
    return value;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : value;
}
