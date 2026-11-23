import type { DataDefinition } from "../../generated-app-runtime/data";
import { IntegrationIngressError } from "../index";
export type ModelId<D extends DataDefinition> = D["models"][number]["id"];
export type Model<D extends DataDefinition, I extends string> = Extract<
  D["models"][number],
  { id: I }
>;
export type FieldName<D extends DataDefinition, I extends string, T extends string> = Exclude<
  Extract<Model<D, I>["fields"][number], { type: T }>,
  { readOnly: true } | { lifecycle: "retired" }
>["name"];
export type RelationName<
  D extends DataDefinition,
  I extends string,
  Target extends string,
> = Extract<
  Model<D, I>["fields"][number],
  { type: "relation"; target_model: Target; readOnly: false }
>["name"];
export function invalid(code: string): never {
  throw new IntegrationIngressError(`integration_${code}`, 400);
}
export function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) invalid("text_invalid");
  return value.trim();
}
export function decimal(value: unknown, sign?: "positive" | "negative"): string {
  const numeric = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof numeric !== "string" || !/^-?\d+(?:\.\d+)?$/.test(numeric)) invalid("decimal_invalid");
  if (!sign) return numeric;
  const magnitude = numeric.replace(/^-/u, "");
  return sign === "negative" && !/^0+(?:\.0+)?$/.test(magnitude) ? `-${magnitude}` : magnitude;
}
export function currency(value: unknown, allowed?: readonly string[]): string {
  const code = text(value).toUpperCase();
  if (!/^[A-Z]{3}$/.test(code) || (allowed && !allowed.includes(code))) invalid("currency_invalid");
  return code;
}
export function date(value: unknown): string {
  const result = text(value);
  const epoch = Date.parse(`${result}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(result) ||
    !Number.isFinite(epoch) ||
    new Date(epoch).toISOString().slice(0, 10) !== result
  )
    invalid("date_invalid");
  return result;
}
export function datetime(value: unknown): string {
  const result = text(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(result) ||
    !Number.isFinite(Date.parse(result))
  )
    invalid("datetime_invalid");
  date(result.slice(0, 10));
  return result;
}
export function optional(
  output: Record<string, unknown>,
  field: string | undefined,
  value: unknown,
  normalize: (value: unknown) => unknown,
): void {
  if (field && value !== undefined && value !== null && value !== "")
    output[field] = normalize(value);
}
export function assertBindings(
  definition: DataDefinition,
  modelId: string,
  fields: Record<string, readonly string[]>,
): void {
  const model = definition.models.find((entry) => entry.id === modelId);
  const fieldsByName = new Map(model?.fields.map((field) => [field.name, field]));
  for (const [name, types] of Object.entries(fields)) {
    const field = fieldsByName.get(name);
    if (!field || field.readOnly || field.lifecycle === "retired" || !types.includes(field.type))
      invalid("recipe_field_mismatch");
  }
}
export function mapped(record: {
  mappedFields: Readonly<Record<string, unknown>>;
}): Readonly<Record<string, unknown>> {
  if (
    !record ||
    !record.mappedFields ||
    typeof record.mappedFields !== "object" ||
    Array.isArray(record.mappedFields)
  )
    invalid("mapped_fields_required");
  return record.mappedFields;
}

export function assertEnumOptions(
  definition: DataDefinition,
  modelId: string,
  name: string,
  options: readonly string[],
): void {
  const field = definition.models
    .find((model) => model.id === modelId)
    ?.fields.find((field) => field.name === name);
  if (
    field?.type === "enum" &&
    options.some((option) => !field.option_set?.some((candidate) => candidate.id === option))
  )
    invalid("recipe_enum_option_missing");
}
