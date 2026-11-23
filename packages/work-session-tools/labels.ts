import type { DataDefinition, DataField, DataModel } from "@autograph/generated-app-runtime/data";
import type { DerivedExpr, FieldValue } from "@contracts";

/** A tool input the core cannot resolve to the app's data definition. */
export class WorkSessionToolInputError extends Error {
  readonly code = "contract_validation_failed";
}

type Option = { id: string; label?: unknown; aliases?: unknown; lifecycle?: unknown };
const fold = (value: string) => value.trim().toLocaleLowerCase("en-US");
const modelLabel = (model: DataModel) =>
  typeof model.label === "string" ? model.label : model.name;
const fieldHeader = (field: DataField) =>
  typeof field.label === "string" ? field.label : field.name;

/**
 * Resolves the names agents use — model labels and column headers — to the
 * data definition's ids, and back. Resolution is lookup only: the kernel
 * validates every value and target it receives.
 */
export function createLabelIndex(definition: DataDefinition) {
  const models = definition.models;
  const byId = new Map(models.map((model) => [model.id, model]));
  const pick = <T>(
    items: readonly T[],
    name: string,
    keys: (item: T) => string[],
    kind: string,
  ) => {
    const exact = items.filter((item) => keys(item).includes(name));
    if (exact.length === 1) return exact[0]!;
    const folded = items.filter((item) => keys(item).some((key) => fold(key) === fold(name)));
    if (folded.length === 1) return folded[0]!;
    throw new WorkSessionToolInputError(
      folded.length > 1 ? `${kind} "${name}" is ambiguous` : `unknown ${kind} "${name}"`,
    );
  };
  const model = (name: string): DataModel =>
    pick(
      models,
      name,
      (item) => [modelLabel(item), item.id, item.name, ...(item.aliases ?? [])],
      "model",
    );
  const modelById = (id: string): DataModel | undefined => byId.get(id);
  const field = (owner: DataModel, header: string): DataField =>
    pick(
      owner.fields.filter((item) => !item.aliasOf),
      header,
      (item) => [
        fieldHeader(item),
        item.id,
        item.name,
        ...owner.fields.filter((alias) => alias.aliasOf === item.name).map((alias) => alias.name),
      ],
      `column of ${modelLabel(owner)}`,
    );
  const fieldById = (owner: DataModel | undefined, id: string): DataField | undefined =>
    owner?.fields.find((item) => item.id === id);
  const options = (owner: DataField): Option[] =>
    Array.isArray(owner.option_set) ? (owner.option_set as Option[]) : [];
  const optionId = (owner: DataField, label: string): string => {
    const found = options(owner).filter(
      (option) =>
        option.id === label ||
        (typeof option.label === "string" && fold(option.label) === fold(label)) ||
        (Array.isArray(option.aliases) &&
          option.aliases.some((alias) => typeof alias === "string" && fold(alias) === fold(label))),
    );
    // An unknown option passes through unchanged; the kernel rejects it.
    return found.length === 1 ? found[0]!.id : label;
  };
  const optionLabel = (owner: DataField | undefined, id: string): string => {
    const option = owner === undefined ? undefined : options(owner).find((item) => item.id === id);
    return typeof option?.label === "string" ? option.label : id;
  };
  return {
    model,
    modelById,
    field,
    fieldById,
    options,
    optionId,
    optionLabel,
    modelLabel: (id: string) => {
      const found = byId.get(id);
      return found === undefined ? id : modelLabel(found);
    },
    header: (modelId: string, fieldId: string) => {
      const found = fieldById(byId.get(modelId), fieldId);
      return found === undefined ? fieldId : fieldHeader(found);
    },
  };
}
export type LabelIndex = ReturnType<typeof createLabelIndex>;
export { fieldHeader, modelLabel };

/** A model label as a plural, for titles and prompts ("Employees", "Job Families"). */
export const pluralLabel = (label: string) =>
  /s$/iu.test(label)
    ? label
    : /[^aeiou]y$/iu.test(label)
      ? `${label.slice(0, -1)}ies`
      : `${label}s`;

/**
 * The app's models, main model first, from the schema alone: the most live
 * link columns (relation or relation list, on any model, its own included)
 * pointing at it, then the most columns, then the definition's order. So a
 * lookup table (zones, departments) that one model links to falls behind a
 * model with more links pointing at it; on a tie of links, the model with
 * more columns leads.
 */
export function mainModelOrder(definition: Pick<DataDefinition, "models">): DataModel[] {
  const live = (field: DataField) => field.lifecycle !== "retired" && !field.aliasOf;
  const inbound = new Map<string, number>();
  for (const model of definition.models)
    for (const field of model.fields)
      if (
        live(field) &&
        (field.type === "relation" || field.type === "relation_list") &&
        typeof field.target_model === "string"
      )
        inbound.set(field.target_model, (inbound.get(field.target_model) ?? 0) + 1);
  const rank = (model: DataModel) => [inbound.get(model.id) ?? 0, model.fields.filter(live).length];
  // `toSorted` is stable: ties keep the definition's order.
  return definition.models.toSorted((a, b) => {
    const [aIn, aFields] = rank(a);
    const [bIn, bFields] = rank(b);
    return bIn! - aIn! || bFields! - aFields!;
  });
}

/**
 * A model's title column, by which people name its records: its display
 * field, else its first text column that is not unique, else its first.
 */
export function titleFieldOf(model: DataModel | undefined): DataField | undefined {
  if (model === undefined) return undefined;
  const display = model.display_field_id;
  const text = model.fields.filter(
    (field) => field.type === "text" && field.lifecycle !== "retired" && !field.aliasOf,
  );
  return (
    (typeof display === "string"
      ? model.fields.find((field) => field.id === display)
      : undefined) ??
    text.find((field) => field.is_unique !== true) ??
    text[0]
  );
}

/** The wire type a column's values carry. */
const wireType = (field: DataField): string =>
  field.type === "iso_country" || field.type === "iso_currency"
    ? "text"
    : field.type === "known_aliases"
      ? "text_list"
      : field.type;

/**
 * A related record as agents name it: a record id string, or
 * `{ external_key }`. An external key is never turned into a record id.
 */
function encodeKey(value: unknown): unknown {
  if (typeof value === "string") return { type: "record_id", value };
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const key = value as Record<string, unknown>;
    if (typeof key.external_key === "string" && Object.keys(key).length === 1)
      return { type: "external_key", value: key.external_key };
  }
  // A wire key or anything else passes through for the kernel to judge.
  return value;
}
function displayKey(key: unknown): unknown {
  if (key === null || typeof key !== "object" || Array.isArray(key)) return key;
  const tagged = key as { type?: unknown; value?: unknown };
  if (tagged.type === "record_id") return tagged.value;
  if (tagged.type === "external_key") return { external_key: tagged.value };
  return key;
}

/**
 * Tags an agent's plain value with its column's wire type, decided by the
 * column's type in the definition: enum labels become option ids, related
 * records become record keys, JSON passes through unchanged. A value already
 * tagged with the column's own wire type passes through.
 */
export function encodeCell(
  labels: LabelIndex,
  field: DataField,
  value: unknown,
): FieldValue | null {
  if (value === null) return null;
  const type = wireType(field);
  if (type === "json") return { type: "json", value };
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === type &&
    Object.hasOwn(value, "value")
  )
    return value as FieldValue;
  switch (type) {
    case "enum":
      return { type: "enum", value: labels.optionId(field, String(value)) };
    case "relation":
      return { type: "relation", value: encodeKey(value) } as FieldValue;
    case "relation_list":
      return {
        type: "relation_list",
        value: Array.isArray(value) ? value.map(encodeKey) : value,
      } as FieldValue;
    case "number":
    case "text":
    case "date":
    case "datetime":
      return { type, value: typeof value === "number" ? String(value) : value } as FieldValue;
    default:
      return { type, value } as FieldValue;
  }
}

/** A column's plain value as agents read it, converted by the column's type. */
function displayPlain(labels: LabelIndex, field: DataField, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (field.type) {
    case "enum":
      return typeof value === "string" ? labels.optionLabel(field, value) : value;
    case "relation":
      return displayKey(value);
    case "relation_list":
      return Array.isArray(value) ? value.map(displayKey) : value;
    default:
      return value;
  }
}

/**
 * A wire value (`{ type, value }`, as staged entries, proposals and history
 * carry it) as agents read it. The wrapper is removed once, whatever the inner
 * value looks like, so a JSON value with `type`/`value` keys stays intact.
 */
export function displayWire(
  labels: LabelIndex,
  field: DataField | undefined,
  value: unknown,
): unknown {
  if (value === null || value === undefined) return null;
  const inner =
    typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "value")
      ? (value as { value: unknown }).value
      : value;
  return field === undefined ? inner : displayPlain(labels, field, inner);
}

/** A value the generated data client already decoded, as agents read it. */
export function displayDecoded(
  labels: LabelIndex,
  field: DataField | undefined,
  value: unknown,
): unknown {
  if (value === null || value === undefined) return null;
  return field === undefined ? value : displayPlain(labels, field, value);
}

/**
 * Rewrites column headers in a rule expression to field ids: `field` within
 * the rule's model, `relation_field` through the relation to its target. A
 * name that does not resolve passes through for the kernel to reject.
 */
export function resolveExpression(
  labels: LabelIndex,
  model: DataModel,
  expression: unknown,
): DerivedExpr {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== "object") return node;
    const record = node as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) next[key] = walk(value);
    const lookup = (owner: DataModel | undefined, name: unknown) => {
      if (owner === undefined || typeof name !== "string") return name;
      try {
        return labels.field(owner, name).id;
      } catch {
        return name;
      }
    };
    if (record.type === "field") next.field = lookup(model, record.field);
    if (record.type === "relation_field") {
      const relation =
        typeof record.relation === "string"
          ? model.fields.find((field) => field.id === lookup(model, record.relation))
          : undefined;
      next.relation = relation?.id ?? record.relation;
      const target =
        typeof relation?.target_model === "string"
          ? labels.modelById(relation.target_model)
          : undefined;
      next.field = lookup(target, record.field);
    }
    return next;
  };
  return walk(expression) as DerivedExpr;
}
