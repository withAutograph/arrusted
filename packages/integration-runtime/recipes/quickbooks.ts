import { assertEnumOptions } from "./normalization";
import type { DataDefinition, DataField } from "../../generated-app-runtime/data";
import {
  defineIntegrationRecipe,
  integrationSource,
  type IntegrationEnvelope,
  type IntegrationRecipe,
} from "../index";

type ModelId<D extends DataDefinition> = D["models"][number]["id"];
type Model<D extends DataDefinition, I extends string> = Extract<D["models"][number], { id: I }>;
type FieldName<D extends DataDefinition, I extends string, T extends string> = Exclude<
  Extract<Model<D, I>["fields"][number], { type: T }>,
  { readOnly: true } | { lifecycle: "retired" }
>["name"];
type RelationName<D extends DataDefinition, I extends string, Target extends string> = Extract<
  Model<D, I>["fields"][number],
  { type: "relation"; target_model: Target; readOnly: false }
>["name"];
export type QuickBooksMappedRecord = Readonly<{ mappedFields: Readonly<Record<string, unknown>> }>;
export type QuickBooksReadEnvelope = IntegrationEnvelope &
  Readonly<{
    provider: "quickbooks" | "quickbooksSandbox";
    installationId: string;
    operationTime: string;
  }>;
export type QuickBooksVendorBinding<D extends DataDefinition, I extends string> = {
  model: I;
  name: FieldName<D, I, "text">;
  status: FieldName<D, I, "enum" | "text">;
  entityName?: FieldName<D, I, "text">;
};
export type QuickBooksPayablesBinding<
  D extends DataDefinition,
  I extends string,
  Vendor extends string,
> = {
  model: I;
  vendor: RelationName<D, I, Vendor>;
  amount: FieldName<D, I, "number">;
  currencyCode: FieldName<D, I, "iso_currency" | "text">;
  transactionDate: FieldName<D, I, "date">;
  sourceUpdatedAt: FieldName<D, I, "datetime">;
  transactionKind: FieldName<D, I, "enum" | "text">;
  counterpartyName?: FieldName<D, I, "text">;
  documentNumber?: FieldName<D, I, "text">;
  openAmount?: FieldName<D, I, "number">;
  dueDate?: FieldName<D, I, "date">;
  sourceReference?: FieldName<D, I, "text">;
  sourceRecordId?: FieldName<D, I, "text">;
  sourceConnectionId?: FieldName<D, I, "text">;
  provider?: FieldName<D, I, "text" | "enum">;
  integrationPlatformId?: FieldName<D, I, "text" | "enum">;
  payloadHash?: FieldName<D, I, "text">;
};

/**
 * App-owned typed projection of QuickBooks mapped reads: Vendor, Bill and
 * VendorCredit. Provider authority, signature/URL handling and payload parsing
 * remain the host's ingress responsibilities. No provider client is created.
 */
export function createQuickBooksRecipe<
  D extends DataDefinition,
  V extends ModelId<D>,
  T extends ModelId<D> = ModelId<D>,
>(
  definition: D,
  input: {
    id: string;
    version: string;
    vendors: QuickBooksVendorBinding<D, V>;
    payables?: QuickBooksPayablesBinding<D, T, V>;
  },
) {
  const vendors = input.vendors;
  if (String(input.payables?.model) === String(vendors.model))
    throw new Error("integration_recipe_models_overlap");
  assertEnumOptions(definition, vendors.model, vendors.status, ["active", "inactive"]);
  const vendorFields = [
    vendors.name,
    vendors.status,
    ...(vendors.entityName ? [vendors.entityName] : []),
  ];
  assertBindings(definition, vendors.model, {
    [vendors.name]: ["text"],
    [vendors.status]: ["enum", "text"],
    ...(vendors.entityName ? { [vendors.entityName]: ["text"] } : {}),
  });
  const projections: Record<string, unknown> = {
    [vendors.model]: {
      object: "vendor",
      fields: vendorFields,
      matching: "source_reference",
      clearing: "reject",
      sourceReference: (record: QuickBooksMappedRecord, envelope: QuickBooksReadEnvelope) =>
        sourceReference("vendor", record, envelope),
      normalize: (record: QuickBooksMappedRecord, envelope: QuickBooksReadEnvelope) => {
        verifyEnvelope(envelope);
        const fields = mapped(record);
        if (typeof fields.status !== "boolean")
          throw new Error("integration_quickbooks_status_invalid");
        const output: Record<string, unknown> = {
          [vendors.name]: text(fields.name),
          [vendors.status]: fields.status ? "active" : "inactive",
        };
        optional(output, vendors.entityName, fields.entity_name, text);
        return output;
      },
    },
  };
  if (input.payables) {
    const target = input.payables;
    if (target.provider)
      assertEnumOptions(definition, target.model, target.provider, ["quickbooks"]);
    if (target.integrationPlatformId)
      assertEnumOptions(definition, target.model, target.integrationPlatformId, ["ampersand"]);
    assertEnumOptions(definition, target.model, target.transactionKind, ["bill", "credit"]);
    const names = Object.entries(target).flatMap(([key, value]) =>
      key !== "model" && value !== undefined ? [value as string] : [],
    );
    assertBindings(definition, target.model, {
      [target.vendor]: ["relation"],
      [target.amount]: ["number"],
      [target.currencyCode]: ["iso_currency", "text"],
      [target.transactionDate]: ["date"],
      [target.sourceUpdatedAt]: ["datetime"],
      [target.transactionKind]: ["enum", "text"],
      ...(target.openAmount ? { [target.openAmount]: ["number"] } : {}),
      ...(target.dueDate ? { [target.dueDate]: ["date"] } : {}),
    });
    const relation = definition.models
      .find((model) => model.id === target.model)
      ?.fields.find((field) => field.name === target.vendor);
    if (!relation || relation.target_model !== vendors.model)
      throw new Error("integration_recipe_relation_mismatch");
    projections[target.model] = {
      object: ["bill", "vendorCredit", "vendor_credit"],
      fields: names,
      matching: "source_reference",
      clearing: "reject",
      sourceReference: (record: QuickBooksMappedRecord, envelope: QuickBooksReadEnvelope) =>
        sourceReference(providerObject(envelope), record, envelope),
      normalize: (
        record: QuickBooksMappedRecord,
        envelope: QuickBooksReadEnvelope,
        _binding: unknown,
        delivery: { payloadHash: string },
      ) => {
        verifyEnvelope(envelope);
        const fields = mapped(record);
        const credit = providerObject(envelope) === "vendorCredit";
        const output: Record<string, unknown> = {
          [target.vendor]: integrationSource(
            vendors.model,
            `quickbooks:vendor:${text(envelope.installationId)}:${text(fields.vendor_source_record_id)}`,
          ),
          [target.amount]: signedNumber(fields.amount, credit),
          [target.currencyCode]: currency(fields.currency_code),
          [target.transactionDate]: date(fields.transaction_date),
          [target.sourceUpdatedAt]: datetime(fields.source_updated_at),
          [target.transactionKind]: credit ? "credit" : "bill",
        };
        optional(output, target.counterpartyName, fields.counterparty_name, text);
        optional(output, target.documentNumber, fields.document_number, text);
        if (!credit) {
          optional(output, target.openAmount, fields.open_amount, (value) =>
            signedNumber(value, false),
          );
          optional(output, target.dueDate, fields.due_date, date);
        }
        optional(
          output,
          target.sourceReference,
          sourceReference(providerObject(envelope), record, envelope),
          text,
        );
        optional(output, target.sourceRecordId, fields.source_record_id, text);
        optional(output, target.sourceConnectionId, envelope.installationId, text);
        optional(output, target.provider, "quickbooks", text);
        optional(output, target.integrationPlatformId, "ampersand", text);
        optional(output, target.payloadHash, delivery.payloadHash, text);
        return output;
      },
    };
  }
  return defineIntegrationRecipe<D, QuickBooksMappedRecord, QuickBooksReadEnvelope>(definition, {
    id: input.id,
    version: input.version,
    sourceIdentity: "app_owned",
    effectiveStart: (envelope) => {
      verifyEnvelope(envelope);
      return datetime(envelope.operationTime).slice(0, 10);
    },
    projections: projections as IntegrationRecipe<
      D,
      QuickBooksMappedRecord,
      QuickBooksReadEnvelope
    >["projections"],
  });
}
function verifyEnvelope(envelope: QuickBooksReadEnvelope): void {
  if (!["quickbooks", "quickbooksSandbox"].includes(envelope.provider))
    throw new Error("integration_provider_mismatch");
  text(envelope.installationId);
  datetime(envelope.operationTime);
}
function mapped(record: QuickBooksMappedRecord): Readonly<Record<string, unknown>> {
  if (
    !record ||
    !record.mappedFields ||
    typeof record.mappedFields !== "object" ||
    Array.isArray(record.mappedFields)
  )
    throw new Error("integration_mapped_fields_required");
  return record.mappedFields;
}
function providerObject(envelope: QuickBooksReadEnvelope): string {
  return envelope.object === "vendor_credit" ? "vendorCredit" : envelope.object;
}
function sourceReference(
  object: string,
  record: QuickBooksMappedRecord,
  envelope: QuickBooksReadEnvelope,
): string {
  verifyEnvelope(envelope);
  return `quickbooks:${object}:${text(envelope.installationId)}:${text(mapped(record).source_record_id)}`;
}
function assertBindings(
  definition: DataDefinition,
  modelId: string,
  fields: Record<string, string[]>,
): void {
  const model = definition.models.find((entry) => entry.id === modelId);
  const fieldsByName = new Map(model?.fields.map((field) => [field.name, field]));
  for (const [name, types] of Object.entries(fields)) {
    const field: DataField | undefined = fieldsByName.get(name);
    if (!field || field.readOnly || field.lifecycle === "retired" || !types.includes(field.type))
      throw new Error("integration_recipe_field_mismatch");
  }
}
function optional(
  output: Record<string, unknown>,
  field: string | undefined,
  value: unknown,
  normalize: (value: unknown) => unknown,
): void {
  if (field && value !== undefined && value !== null && value !== "")
    output[field] = normalize(value);
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("integration_text_invalid");
  return value.trim();
}
function signedNumber(value: unknown, negative: boolean): string {
  const numeric = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof numeric !== "string" || !/^-?\d+(?:\.\d+)?$/.test(numeric))
    throw new Error("integration_decimal_invalid");
  const magnitude = numeric.replace(/^-/u, "");
  return negative && !/^0+(?:\.0+)?$/.test(magnitude) ? `-${magnitude}` : magnitude;
}
function currency(value: unknown): string {
  const code = text(value).toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new Error("integration_currency_invalid");
  return code;
}
function date(value: unknown): string {
  const result = text(value);
  const epoch = Date.parse(`${result}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(result) ||
    !Number.isFinite(epoch) ||
    new Date(epoch).toISOString().slice(0, 10) !== result
  )
    throw new Error("integration_date_invalid");
  return result;
}
function datetime(value: unknown): string {
  const result = text(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(result) ||
    !Number.isFinite(Date.parse(result))
  )
    throw new Error("integration_datetime_invalid");
  date(result.slice(0, 10));
  return result;
}
