import type {
  AppliedChangeSet,
  FieldHistoryEntry,
  FieldValue,
  MoneyRatePeriod,
  RecordKey,
} from "../contracts";
import { isIso3166Alpha2Code, isIso4217TenderCurrencyCode } from "../engines/reference-data/index";
import type { DataField, DataModel } from "./data";

/** A malformed successful transport response is never a browser form failure. */
export class DataResponseError extends Error {
  override readonly name = "DataResponseError";
  constructor(
    readonly operation: string,
    readonly path: string,
    readonly expected: string,
  ) {
    super(`Generated data response contract violation: ${operation} ${path} expected ${expected}`);
  }
}

export function responseFailure(operation: string, path: string, expected: string): never {
  throw new DataResponseError(operation, path, expected);
}
function responseObject(operation: string, path: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    responseFailure(operation, path, "object");
  return value as Record<string, unknown>;
}
function responseKeys(
  operation: string,
  path: string,
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value))
    if (!allowedSet.has(key)) responseFailure(operation, path, "known property");
}
function responseHas(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
function responseString(operation: string, path: string, value: unknown): string {
  if (typeof value !== "string") responseFailure(operation, path, "string");
  return value;
}
function responseBoolean(operation: string, path: string, value: unknown): boolean {
  if (typeof value !== "boolean") responseFailure(operation, path, "boolean");
  return value;
}
function responseOptionalNullable<K extends string, T>(
  value: Record<string, unknown>,
  key: K,
  decode: (value: unknown) => T,
): Partial<Record<K, T | null>> {
  const property = value[key];
  if (property === undefined) return {};
  return { [key]: property === null ? null : decode(property) } as Partial<Record<K, T | null>>;
}
export function responseUuid(operation: string, path: string, value: unknown): string {
  const result = responseString(operation, path, value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result))
    responseFailure(operation, path, "UUID");
  return result;
}
function responseDate(operation: string, path: string, value: unknown): string {
  const result = responseString(operation, path, value);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(result) ||
    !Number.isFinite(Date.parse(`${result}T00:00:00Z`)) ||
    new Date(`${result}T00:00:00Z`).toISOString().slice(0, 10) !== result
  )
    responseFailure(operation, path, "ISO date");
  return result;
}
function responseDateTime(operation: string, path: string, value: unknown): string {
  const result = responseString(operation, path, value);
  if (
    !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(result) ||
    !Number.isFinite(Date.parse(result))
  )
    responseFailure(operation, path, "ISO datetime");
  responseDate(operation, path, result.slice(0, 10));
  return result;
}
function responseDecimal(operation: string, path: string, value: unknown): string {
  const result = responseString(operation, path, value);
  if (!/^-?\d+(?:\.\d+)?$/.test(result)) responseFailure(operation, path, "decimal string");
  return result;
}
function responseDecimalInteger(operation: string, path: string, value: unknown): string {
  const result = responseString(operation, path, value);
  if (!/^(?:0|[1-9]\d*)$/.test(result))
    responseFailure(operation, path, "non-negative integer string");
  return result;
}
function responseSchemaRevisionId(operation: string, path: string, value: unknown): string {
  const result = responseString(operation, path, value);
  if (!/^[1-9]\d{0,18}$/.test(result) || BigInt(result) > 9_223_372_036_854_775_807n)
    responseFailure(operation, path, "positive signed 64-bit schema revision ID");
  return result;
}
/** Compatibility for historical SQL JSON bigint output; preserve the public string shape. */
function responseHistorySchemaRevisionId(operation: string, path: string, value: unknown): string {
  if (typeof value === "string") return responseSchemaRevisionId(operation, path, value);
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > Number.MAX_SAFE_INTEGER
  )
    responseFailure(operation, path, "positive safe integer or signed 64-bit revision string");
  return `${value}`;
}
function responseSafeInteger(operation: string, path: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    responseFailure(operation, path, "safe integer");
  return value;
}
function responseHistoryStage(
  operation: string,
  path: string,
  value: unknown,
): FieldHistoryEntry["stage"] {
  const stage = responseString(operation, path, value);
  if (stage === "draft" || stage === "mainline" || stage === "discarded" || stage === "reverted")
    return stage;
  responseFailure(operation, path, "history stage");
}
function responseMoneyRatePeriod(operation: string, path: string, value: unknown): MoneyRatePeriod {
  const period = responseString(operation, path, value);
  if (
    period !== "annual" &&
    period !== "monthly" &&
    period !== "weekly" &&
    period !== "daily" &&
    period !== "hourly"
  )
    responseFailure(operation, path, "money rate period");
  return period;
}
function responseKey(operation: string, path: string, value: unknown): RecordKey {
  const key = responseObject(operation, path, value);
  responseKeys(operation, path, key, ["type", "value"]);
  if (key.type === "record_id")
    return {
      type: "record_id",
      value: responseUuid(operation, `${path}.value`, key.value),
    };
  if (key.type === "external_key") {
    const external = responseString(operation, `${path}.value`, key.value);
    if (!external) responseFailure(operation, `${path}.value`, "non-empty external key");
    return { type: "external_key", value: external };
  }
  responseFailure(operation, `${path}.type`, "record_id or external_key");
}
export function responseFieldValue(operation: string, path: string, value: unknown): FieldValue {
  const field = responseObject(operation, path, value);
  responseKeys(operation, path, field, ["type", "value"]);
  if (!responseHas(field, "value")) responseFailure(operation, `${path}.value`, "field value");
  const type = responseString(operation, `${path}.type`, field.type);
  if (type === "text")
    return {
      type,
      value: responseString(operation, `${path}.value`, field.value),
    };
  if (type === "number")
    return {
      type,
      value: responseDecimal(operation, `${path}.value`, field.value),
    };
  if (type === "date")
    return {
      type,
      value: responseDate(operation, `${path}.value`, field.value),
    };
  if (type === "datetime")
    return {
      type,
      value: responseDateTime(operation, `${path}.value`, field.value),
    };
  if (type === "enum")
    return {
      type,
      value: responseString(operation, `${path}.value`, field.value),
    };
  if (type === "schema_lifecycle") {
    const lifecycle = responseString(operation, `${path}.value`, field.value);
    if (lifecycle !== "active" && lifecycle !== "retired")
      responseFailure(operation, `${path}.value`, "schema lifecycle");
    return { type, value: lifecycle };
  }
  if (type === "bool") {
    if (typeof field.value !== "boolean") responseFailure(operation, `${path}.value`, "boolean");
    return { type: "bool", value: field.value };
  }
  if (type === "json") return { type: "json", value: field.value };
  if (type === "relation")
    return {
      type: "relation",
      value: responseKey(operation, `${path}.value`, field.value),
    };
  if (type === "relation_list") {
    if (!Array.isArray(field.value))
      responseFailure(operation, `${path}.value`, "record key array");
    return {
      type: "relation_list",
      value: field.value.map((item, index) =>
        responseKey(operation, `${path}.value[${index}]`, item),
      ),
    };
  }
  if (type === "text_list") {
    if (!Array.isArray(field.value) || !field.value.every((item) => typeof item === "string"))
      responseFailure(operation, `${path}.value`, "string array");
    return { type: "text_list", value: field.value };
  }
  if (type === "money_rate") {
    const money = responseObject(operation, `${path}.value`, field.value);
    responseKeys(operation, `${path}.value`, money, ["amount", "currency", "period"]);
    const amount = responseDecimal(operation, `${path}.value.amount`, money.amount);
    const currency = responseString(operation, `${path}.value.currency`, money.currency);
    const period = responseMoneyRatePeriod(operation, `${path}.value.period`, money.period);
    return {
      type: "money_rate",
      value: { amount, currency, period },
    };
  }
  responseFailure(operation, `${path}.type`, "supported field value type");
}
function responseCustomFields(
  operation: string,
  path: string,
  value: unknown,
): readonly ({ field_id: string } & FieldValue)[] {
  if (!Array.isArray(value)) responseFailure(operation, path, "custom field array");
  return value.map((item, index) => {
    const entry = responseObject(operation, `${path}[${index}]`, item);
    responseKeys(operation, `${path}[${index}]`, entry, ["field_id", "type", "value"]);
    const field_id = responseString(operation, `${path}[${index}].field_id`, entry.field_id);
    const decoded = responseFieldValue(operation, `${path}[${index}]`, {
      type: entry.type,
      value: entry.value,
    });
    if (["relation_list", "json", "schema_lifecycle"].includes(decoded.type))
      responseFailure(operation, `${path}[${index}].type`, "custom field value type");
    return { field_id, ...decoded };
  });
}

export function responseAppliedChangeSet(
  value: unknown,
  operation = "kernel_apply_change_set",
): AppliedChangeSet {
  const receipt = responseObject(operation, "response", value);
  responseKeys(operation, "response", receipt, ["id", "schema_revision_id"]);
  if (!responseHas(receipt, "id") || !responseHas(receipt, "schema_revision_id"))
    responseFailure(operation, "response", "change set receipt");
  return {
    id: responseSafeInteger(operation, "response.id", receipt.id),
    schema_revision_id: responseSchemaRevisionId(
      operation,
      "response.schema_revision_id",
      receipt.schema_revision_id,
    ),
  };
}

export type ResponseDecoderOptions = {
  fieldsByModel: ReadonlyMap<string, ReadonlyMap<string, DataField>>;
  supportsVersionPreconditions: boolean;
  onFullRecord?: (record: Record<string, unknown>, modelId: string, recordId: string) => void;
};

export function createResponseDecoder({
  fieldsByModel,
  supportsVersionPreconditions,
  onFullRecord,
}: ResponseDecoderOptions) {
  const responseFieldType = (field: DataField): FieldValue["type"] => {
    if (field.type === "iso_country" || field.type === "iso_currency") return "text";
    if (field.type === "known_aliases") return "text_list";
    switch (field.type) {
      case "text":
      case "number":
      case "bool":
      case "date":
      case "datetime":
      case "relation":
      case "relation_list":
      case "text_list":
      case "json":
      case "enum":
      case "money_rate":
      case "schema_lifecycle":
        return field.type;
    }
    responseFailure("kernel_data_query", `field.${field.id}.type`, "supported field type");
  };
  const decodeFieldValue = (
    field: DataField,
    value: unknown,
    operation: string,
    path: string,
    activeEnumOptionIds?: ReadonlySet<string>,
  ): FieldValue => {
    const decoded = responseFieldValue(operation, path, value);
    if (decoded.type !== responseFieldType(field))
      responseFailure(operation, `${path}.type`, `${field.type} field value`);
    if (
      field.type === "enum" &&
      (!field.option_set || !field.option_set.some((option) => option.id === decoded.value)) &&
      !activeEnumOptionIds?.has(String(decoded.value))
    )
      responseFailure(operation, `${path}.value`, "declared enum option");
    if (
      field.type === "iso_country" &&
      (decoded.type !== "text" || !isIso3166Alpha2Code(decoded.value))
    )
      responseFailure(operation, `${path}.value`, "ISO 3166-1 alpha-2 country code");
    if (
      field.type === "iso_currency" &&
      (decoded.type !== "text" || !isIso4217TenderCurrencyCode(decoded.value))
    )
      responseFailure(operation, `${path}.value`, "ISO 4217 tender currency code");
    return decoded;
  };
  const decodeManyRelations = (
    operation: string,
    path: string,
    value: unknown,
  ): Record<string, string[]> => {
    const relations = responseObject(operation, path, value);
    const decoded: Record<string, string[]> = {};
    for (const [fieldId, targets] of Object.entries(relations)) {
      if (!Array.isArray(targets)) responseFailure(operation, path, "UUID array");
      decoded[fieldId] = targets.map((target, index) =>
        responseUuid(operation, `${path}[${index}]`, target),
      );
    }
    return decoded;
  };
  const draftNumber = (operation: string, path: string, value: unknown) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
      responseFailure(operation, path, "draft change set id");
    return value;
  };
  /** A row's `pending_draft`: the draft creating it and, per field name, the draft whose value shows. */
  const decodePendingDraft = (model: DataModel, operation: string, value: unknown) => {
    const draft = responseObject(operation, "response.pending_draft", value);
    responseKeys(operation, "response.pending_draft", draft, ["created", "fields"]);
    const fields: Record<string, number> = {};
    for (const [fieldId, id] of Object.entries(
      responseObject(operation, "response.pending_draft.fields", draft.fields),
    )) {
      const field = fieldsByModel.get(model.id)?.get(fieldId);
      fields[field?.name ?? fieldId] = draftNumber(
        operation,
        `response.pending_draft.fields.${fieldId}`,
        id,
      );
    }
    return {
      ...(responseHas(draft, "created")
        ? { created: draftNumber(operation, "response.pending_draft.created", draft.created) }
        : {}),
      fields,
    };
  };
  const decodeRecord = (
    model: DataModel,
    value: unknown,
    select?: readonly string[],
    options?: { activeEnumOptionIdsByField?: ReadonlyMap<string, ReadonlySet<string>> },
  ) => {
    const operation = "kernel_data_query";
    const record = responseObject(operation, "response", value);
    responseKeys(operation, "response", record, [
      "record_id",
      "version_id",
      "external_key",
      "effective_start",
      "effective_end",
      "values",
      "custom_fields",
      "metadata",
      "many_relations",
      "availability",
      "pending_draft",
    ]);
    const selected = select ? new Set(select) : undefined;
    const include = (name: string) => !selected || selected.has(name);
    const full = !select;
    const recordId = responseHas(record, "record_id")
      ? responseUuid(operation, "response.record_id", record.record_id)
      : full || include("id")
        ? responseFailure(operation, "response.record_id", "UUID")
        : undefined;
    const version = responseHas(record, "version_id")
      ? responseUuid(operation, "response.version_id", record.version_id)
      : undefined;
    if (supportsVersionPreconditions && (full || include("$version")) && !version)
      responseFailure(operation, "response.version_id", "UUID");
    const external = responseHas(record, "external_key")
      ? record.external_key === null
        ? null
        : responseString(operation, "response.external_key", record.external_key)
      : full || include("externalKey")
        ? responseFailure(operation, "response.external_key", "string or null")
        : undefined;
    const effectiveStart = responseHas(record, "effective_start")
      ? responseDate(operation, "response.effective_start", record.effective_start)
      : full
        ? responseFailure(operation, "response.effective_start", "ISO date")
        : undefined;
    const effectiveEnd = responseHas(record, "effective_end")
      ? record.effective_end === null
        ? null
        : responseDate(operation, "response.effective_end", record.effective_end)
      : full
        ? responseFailure(operation, "response.effective_end", "ISO date or null")
        : undefined;
    const values = responseHas(record, "values")
      ? responseObject(operation, "response.values", record.values)
      : undefined;
    const customFields = responseHas(record, "custom_fields")
      ? responseCustomFields(operation, "response.custom_fields", record.custom_fields)
      : undefined;
    const metadata = responseHas(record, "metadata")
      ? responseObject(operation, "response.metadata", record.metadata)
      : undefined;
    const manyRelations = responseHas(record, "many_relations")
      ? decodeManyRelations(operation, "response.many_relations", record.many_relations)
      : undefined;
    if (full && !values) responseFailure(operation, "response.values", "field value object");
    if (full && !customFields)
      responseFailure(operation, "response.custom_fields", "custom field array");
    if (full && !metadata) responseFailure(operation, "response.metadata", "metadata object");
    if (full && !manyRelations)
      responseFailure(operation, "response.many_relations", "many relation object");
    const decodedValues: Record<string, FieldValue> = {};
    if (values)
      for (const [fieldId, fieldValue] of Object.entries(values)) {
        const field = fieldsByModel.get(model.id)?.get(fieldId);
        const fieldPath = field ? `response.values.${field.name}` : "response.values.value";
        decodedValues[fieldId] = field
          ? decodeFieldValue(
              field,
              fieldValue,
              operation,
              fieldPath,
              options?.activeEnumOptionIdsByField?.get(field.id),
            )
          : responseFieldValue(operation, fieldPath, fieldValue);
      }
    const customById = new Map<string, FieldValue>();
    for (const [index, entry] of (customFields ?? []).entries()) {
      if (customById.has(entry.field_id))
        responseFailure(operation, `response.custom_fields[${index}]`, "unique field entry");
      const field = fieldsByModel.get(model.id)?.get(entry.field_id);
      customById.set(
        entry.field_id,
        field
          ? decodeFieldValue(
              field,
              { type: entry.type, value: entry.value },
              operation,
              `response.custom_fields[${index}]`,
              options?.activeEnumOptionIdsByField?.get(field.id),
            )
          : entry,
      );
    }
    const pendingDraft = responseHas(record, "pending_draft")
      ? decodePendingDraft(model, operation, record.pending_draft)
      : undefined;
    const decoded: Record<string, unknown> = {};
    if (include("id")) decoded.id = recordId;
    if (include("externalKey")) decoded.externalKey = external ?? null;
    if (supportsVersionPreconditions && (full || include("$version"))) decoded.$version = version;
    for (const field of model.fields) {
      if (!include(field.name)) continue;
      if (field.storage === "custom") {
        decoded[field.name] = customById.get(field.id)?.value ?? null;
      } else if (field.storage === "many") {
        decoded[field.name] = (manyRelations?.[field.id] ?? []).map((item) => ({
          type: "record_id",
          value: item,
        }));
      } else {
        const hasValue = values !== undefined && responseHas(values, field.id);
        if (field.required && field.lifecycle !== "retired" && !hasValue)
          responseFailure(
            operation,
            `response.values.${field.id}`,
            "required declared field value",
          );
        decoded[field.name] = hasValue ? (decodedValues[field.id]?.value ?? null) : null;
      }
    }
    if (full) {
      decoded.effectiveStart = effectiveStart;
      decoded.effectiveEnd = effectiveEnd;
      decoded.customFields = customFields;
      decoded.metadata = metadata;
      decoded.manyRelations = manyRelations;
    }
    // Only reads with pending drafts say what came from one (see `PendingDraft`).
    if (pendingDraft) decoded.pendingDraft = pendingDraft;
    if (full && recordId) onFullRecord?.(decoded, model.id, recordId);
    return decoded;
  };
  const decodeGroupValue = (
    field: DataField,
    value: unknown,
    activeEnumOptionIds?: ReadonlySet<string>,
  ): unknown => {
    const operation = "kernel_data_query";
    const path = "response.value";
    if (value === null) {
      if (field.required && field.lifecycle !== "retired")
        responseFailure(operation, path, "non-null declared field value");
      return null;
    }
    switch (responseFieldType(field)) {
      case "bool":
        if (typeof value !== "boolean") responseFailure(operation, path, "boolean");
        return value;
      case "date":
        return responseDate(operation, path, value);
      case "datetime":
        return responseDateTime(operation, path, value);
      case "number":
        return responseDecimal(operation, path, value);
      case "enum": {
        const option = responseString(operation, path, value);
        if (
          !field.option_set?.some((candidate) => candidate.id === option) &&
          !activeEnumOptionIds?.has(option)
        )
          responseFailure(operation, path, "declared enum option");
        return option;
      }
      case "text":
      case "schema_lifecycle": {
        const text = responseString(operation, path, value);
        if (field.type === "iso_country" && !isIso3166Alpha2Code(text))
          responseFailure(operation, path, "ISO 3166-1 alpha-2 country code");
        if (field.type === "iso_currency" && !isIso4217TenderCurrencyCode(text))
          responseFailure(operation, path, "ISO 4217 tender currency code");
        return text;
      }
      default:
        responseFailure(operation, path, "groupable scalar field value");
    }
  };
  const decodeAggregate = (
    groups: readonly { field: DataField; bins?: { edges: readonly string[] } }[],
    metrics: readonly { fn: string; field?: string; money?: boolean }[],
    value: unknown,
    options?: { activeEnumOptionIdsByField?: ReadonlyMap<string, ReadonlySet<string>> },
  ) => {
    const operation = "kernel_data_query";
    const root = responseObject(operation, "response", value);
    responseKeys(operation, "response", root, ["as_of", "units", "groups", "total", "other_units"]);
    if (
      groups.some((group) => group.field.type === "money_rate" && group.bins !== undefined) &&
      root.other_units === undefined
    )
      responseFailure(operation, "response.other_units", "money-bin excluded-unit count");
    const as_of = responseDate(operation, "response.as_of", root.as_of);
    if (!Array.isArray(root.units) || root.units.length !== metrics.length)
      responseFailure(operation, "response.units", "metric unit tuple");
    const units = root.units.map((item, index) => {
      if (item === null) return null;
      const path = `response.units[${index}]`;
      if (!metrics[index]!.money) responseFailure(operation, path, "null for non-money metric");
      const unit = responseObject(operation, path, item);
      responseKeys(operation, path, unit, ["currency", "period"]);
      const currency = responseString(operation, path, unit.currency);
      if (!isIso4217TenderCurrencyCode(currency)) responseFailure(operation, path, "currency");
      return { currency, period: responseMoneyRatePeriod(operation, path, unit.period) };
    });
    const moneyFields = [
      ...new Set(metrics.filter((metric) => metric.money).map((metric) => metric.field)),
    ];
    const metricValues = (value: unknown, path: string) => {
      if (!Array.isArray(value) || value.length !== metrics.length)
        responseFailure(operation, path, "metric tuple");
      return value.map((item, index) => {
        const fn = metrics[index]!.fn;
        if (
          item === null &&
          fn === "count_distinct" &&
          metrics[index]!.money &&
          path === "response.total.metrics"
        )
          return null;
        if (fn === "count" || fn === "count_distinct")
          return responseDecimalInteger(operation, `${path}[${index}]`, item);
        return item === null ? null : responseDecimal(operation, `${path}[${index}]`, item);
      });
    };
    if (!Array.isArray(root.groups) || root.groups.length > 100)
      responseFailure(operation, "response.groups", "at most 100 groups");
    const decodedGroups = root.groups.map((entry, index) => {
      const path = `response.groups[${index}]`;
      const group = responseObject(operation, path, entry);
      responseKeys(operation, path, group, ["key", "metrics"]);
      if (!Array.isArray(group.key) || group.key.length !== groups.length + moneyFields.length)
        responseFailure(operation, `${path}.key`, "group key tuple");
      const key = group.key.map((item, index) => {
        if (index >= groups.length) {
          const wrapped = responseObject(operation, `${path}.key[${index}]`, item);
          responseKeys(operation, path, wrapped, ["unit"]);
          if (wrapped.unit === null) return { unit: null };
          const unit = responseObject(operation, path, wrapped.unit);
          responseKeys(operation, path, unit, ["currency", "period"]);
          const currency = responseString(operation, path, unit.currency);
          if (!isIso4217TenderCurrencyCode(currency)) responseFailure(operation, path, "currency");
          return {
            unit: { currency, period: responseMoneyRatePeriod(operation, path, unit.period) },
          };
        }
        const spec = groups[index]!;
        if (spec.bins) {
          if (item === null || item === "below" || item === "above") return item;
          const bin = responseObject(operation, path, item);
          responseKeys(operation, path, bin, ["from", "to"]);
          const from = responseDecimal(operation, path, bin.from);
          const to = responseDecimal(operation, path, bin.to);
          const edgeIndex = spec.bins.edges.indexOf(from);
          if (edgeIndex < 0 || spec.bins.edges[edgeIndex + 1] !== to)
            responseFailure(operation, path, "declared bin");
          return { from, to };
        }
        if (spec.field.type === "relation")
          return item === null
            ? decodeGroupValue(
                spec.field,
                item,
                options?.activeEnumOptionIdsByField?.get(spec.field.id),
              )
            : { type: "record_id" as const, value: responseUuid(operation, path, item) };
        return decodeGroupValue(
          spec.field,
          item,
          options?.activeEnumOptionIdsByField?.get(spec.field.id),
        );
      });
      return { key, metrics: metricValues(group.metrics, `${path}.metrics`) };
    });
    const total = responseObject(operation, "response.total", root.total);
    responseKeys(operation, "response.total", total, ["metrics"]);
    return {
      as_of,
      units,
      groups: decodedGroups,
      total: { metrics: metricValues(total.metrics, "response.total.metrics") },
      ...(root.other_units === undefined
        ? {}
        : {
            other_units: responseDecimalInteger(
              operation,
              "response.other_units",
              root.other_units,
            ),
          }),
    };
  };
  const decodeActiveRevision = (
    value: unknown,
  ): {
    schema_revision_id: string;
    schemaVersion: string;
    schema: Record<string, unknown>;
    effectiveHash?: string;
  } => {
    const operation = "kernel_read_active_schema_revision";
    const active = responseObject(operation, "response", value);
    const schema = responseObject(operation, "response.schema", active.schema);
    if (!responseHas(active, "schema_revision_id") || !responseHas(schema, "version"))
      responseFailure(operation, "response", "active schema revision and version");
    return {
      schema_revision_id: responseSchemaRevisionId(
        operation,
        "response.schema_revision_id",
        active.schema_revision_id,
      ),
      schemaVersion: responseString(operation, "response.schema.version", schema.version),
      schema,
      ...(typeof active.effective_hash === "string"
        ? { effectiveHash: active.effective_hash }
        : {}),
    };
  };
  const decodeReceipt = (value: unknown): AppliedChangeSet => responseAppliedChangeSet(value);
  const decodeHistory = (value: unknown): FieldHistoryEntry[] => {
    const operation = "kernel_field_history";
    if (!Array.isArray(value)) responseFailure(operation, "response", "history entry array");
    return value.map((entry, index) => {
      const path = `response[${index}]`;
      const history = responseObject(operation, path, entry);
      responseKeys(operation, path, history, [
        "version_id",
        "change_set_id",
        "stage",
        "effective_start",
        "effective_end",
        "field_id",
        "value",
        "reverted_by",
        "enum_value",
        "withheld",
        "tombstones_record",
        "untombstones_record",
        "actor_id",
        "source_kind",
        "source_ref",
        "applied_at",
        "notes",
      ]);
      for (const property of [
        "version_id",
        "change_set_id",
        "stage",
        "effective_start",
        "field_id",
        "withheld",
        "tombstones_record",
        "untombstones_record",
        "source_kind",
      ])
        if (!responseHas(history, property))
          responseFailure(operation, `${path}.${property}`, "present property");
      const stage = responseHistoryStage(operation, `${path}.stage`, history.stage);
      const decodedValue =
        history.value === undefined
          ? undefined
          : history.value === null
            ? null
            : responseFieldValue(operation, `${path}.value`, history.value);
      const enumValue = history.enum_value;
      let decodedEnumValue: NonNullable<FieldHistoryEntry["enum_value"]> | null | undefined =
        enumValue === null ? null : undefined;
      if (enumValue !== undefined && enumValue !== null) {
        const hydrated = responseObject(operation, `${path}.enum_value`, enumValue);
        responseKeys(operation, `${path}.enum_value`, hydrated, [
          "option_id",
          "event_schema_revision_id",
          "current_label",
          "event_label",
        ]);
        for (const property of ["option_id", "event_schema_revision_id", "event_label"])
          if (!responseHas(hydrated, property))
            responseFailure(operation, `${path}.enum_value.${property}`, "present property");
        const optionId = responseString(
          operation,
          `${path}.enum_value.option_id`,
          hydrated.option_id,
        );
        const eventSchemaRevisionId = responseHistorySchemaRevisionId(
          operation,
          `${path}.enum_value.event_schema_revision_id`,
          hydrated.event_schema_revision_id,
        );
        const eventLabel = responseString(
          operation,
          `${path}.enum_value.event_label`,
          hydrated.event_label,
        );
        if (decodedValue?.type !== "enum" || decodedValue.value !== optionId)
          responseFailure(operation, `${path}.enum_value`, "matching historical enum value");
        decodedEnumValue = {
          option_id: optionId,
          event_schema_revision_id: eventSchemaRevisionId,
          event_label: eventLabel,
          ...(hydrated.current_label === undefined
            ? {}
            : {
                current_label:
                  hydrated.current_label === null
                    ? null
                    : responseString(
                        operation,
                        `${path}.enum_value.current_label`,
                        hydrated.current_label,
                      ),
              }),
        };
      }
      const decodedHistory: FieldHistoryEntry = {
        version_id: responseUuid(operation, `${path}.version_id`, history.version_id),
        change_set_id: responseSafeInteger(
          operation,
          `${path}.change_set_id`,
          history.change_set_id,
        ),
        stage,
        effective_start: responseDate(
          operation,
          `${path}.effective_start`,
          history.effective_start,
        ),
        ...(history.effective_end === undefined
          ? {}
          : {
              effective_end:
                history.effective_end === null
                  ? null
                  : responseDate(operation, `${path}.effective_end`, history.effective_end),
            }),
        field_id: responseString(operation, `${path}.field_id`, history.field_id),
        ...(decodedValue === undefined ? {} : { value: decodedValue }),
        ...(history.reverted_by === undefined
          ? {}
          : history.reverted_by === null
            ? { reverted_by: null }
            : {
                reverted_by: responseSafeInteger(
                  operation,
                  `${path}.reverted_by`,
                  history.reverted_by,
                ),
              }),
        ...(decodedEnumValue === undefined ? {} : { enum_value: decodedEnumValue }),
        withheld: responseBoolean(operation, `${path}.withheld`, history.withheld),
        tombstones_record: responseBoolean(
          operation,
          `${path}.tombstones_record`,
          history.tombstones_record,
        ),
        untombstones_record: responseBoolean(
          operation,
          `${path}.untombstones_record`,
          history.untombstones_record,
        ),
        source_kind: responseString(operation, `${path}.source_kind`, history.source_kind),
        ...responseOptionalNullable(history, "actor_id", (value) =>
          responseString(operation, `${path}.actor_id`, value),
        ),
        ...responseOptionalNullable(history, "source_ref", (value) =>
          responseString(operation, `${path}.source_ref`, value),
        ),
        ...responseOptionalNullable(history, "applied_at", (value) =>
          responseDateTime(operation, `${path}.applied_at`, value),
        ),
        ...responseOptionalNullable(history, "notes", (value) =>
          responseString(operation, `${path}.notes`, value),
        ),
      };
      return decodedHistory;
    });
  };
  return {
    decodeRecord,
    decodeAggregate,
    decodeActiveRevision,
    decodeReceipt,
    decodeHistory,
  };
}

export const decodeAppliedChangeSet = responseAppliedChangeSet;
