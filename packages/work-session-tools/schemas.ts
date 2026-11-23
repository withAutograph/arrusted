/** JSON Schema documents for the tool inputs. Shapes only; the kernel validates meaning. */
export type JsonSchemaObject = { readonly [key: string]: unknown };

const string = (description?: string): JsonSchemaObject => ({
  type: "string",
  ...(description === undefined ? {} : { description }),
});
const integer = (description: string, minimum: number, maximum?: number): JsonSchemaObject => ({
  type: "integer",
  minimum,
  ...(maximum === undefined ? {} : { maximum }),
  description,
});
export function object(
  properties: Readonly<Record<string, JsonSchemaObject>>,
  required: readonly string[] = [],
  extra: JsonSchemaObject = {},
): JsonSchemaObject {
  return { type: "object", properties, required, additionalProperties: false, ...extra };
}

const sessionId = string("Working session id, from list_sessions.");
const expectedRevision = integer(
  "Session revision you last read; a stale revision fails with revision_conflict, then re-read.",
  0,
);
export const guarded = { session_id: sessionId, expected_revision: expectedRevision };
export const guardedRequired = ["session_id", "expected_revision"] as const;
export const sessionOnly = { session_id: sessionId };
export const model = string("Model label, as describe_workspace names it.");
export const column = string("Column header, as describe_workspace names it.");
export const recordId = string("Record id (UUID).");
export const cellValue: JsonSchemaObject = {
  description:
    "Plain value for the column: text, decimal string, true/false, YYYY-MM-DD date, option label, related record id or {external_key}, a list of those for multi-relations, {amount,currency,period} for money, any JSON for JSON columns, or null to clear. The column's type decides how it is read; the kernel validates it.",
};
export const target = object({ model, record_id: recordId, column }, [
  "model",
  "record_id",
  "column",
]);
export const change = object({ model, record_id: recordId, column, value: cellValue }, [
  "model",
  "record_id",
  "column",
  "value",
]);
export const changes: JsonSchemaObject = { type: "array", items: change, minItems: 1 };
export const threadId = string("Thread id, from open_thread or describe_workspace.");
export const ruleId = string("Rule id, from create_rule or describe_workspace.");
export const unitId = string("Canvas unit id, from add_unit or describe_workspace.");
const typedLiteral: JsonSchemaObject = {
  type: "object",
  properties: {
    type: {
      enum: ["text", "number", "bool", "date", "datetime", "enum", "iso_country", "iso_currency"],
    },
    value: { type: ["string", "boolean"] },
  },
  required: ["type", "value"],
  additionalProperties: false,
};
export const ruleParameters: JsonSchemaObject = {
  type: "object",
  description:
    'Named typed parameters, e.g. {"rate": {"type": "number", "value": "1.05"}}; referenced by {"type": "parameter", "parameter": "rate"}.',
  additionalProperties: {
    type: "object",
    properties: {
      type: { enum: ["text", "number", "bool", "date", "datetime", "money_rate"] },
      value: {},
    },
    required: ["type", "value"],
    additionalProperties: false,
  },
};

const ref = { $ref: "#/$defs/expr" };
const node = (type: string, properties: Readonly<Record<string, JsonSchemaObject>>) =>
  object({ type: { const: type }, ...properties }, ["type", ...Object.keys(properties)]);
const binary = (type: string) => node(type, { left: ref, right: ref });
/** The contracts `DerivedExpr` AST; `field` and `relation` name column headers. */
export const derivedExpressionDefs: JsonSchemaObject = {
  expr: {
    anyOf: [
      node("field", { field: column }),
      node("relation_field", {
        relation: column,
        field: string("Column header of the related model."),
      }),
      node("literal", { value: typedLiteral }),
      node("parameter", { parameter: string() }),
      node("coalesce", { expressions: { type: "array", items: ref } }),
      node("concat", { expressions: { type: "array", items: ref } }),
      ...["add", "subtract", "multiply", "divide", "min", "max"].map(binary),
      node("compare", {
        op: { enum: ["eq", "not_eq", "lt", "lte", "gt", "gte"] },
        left: ref,
        right: ref,
      }),
      node("if", { condition: ref, then: ref, else: ref }),
      node("clamp", { expression: ref, min: ref, max: ref }),
      node("normalize_money_rate", {
        expression: ref,
        period: { enum: ["hourly", "daily", "weekly", "monthly", "annual"] },
      }),
    ],
  },
};
export const expression = (description: string): JsonSchemaObject => ({ ...ref, description });
