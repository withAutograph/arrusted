import type { DataDefinition } from "../../generated-app-runtime/data";
import {
  defineIntegrationRecipe,
  integrationSource,
  type IntegrationEnvelope,
  type IntegrationRecipe,
} from "../index";
import type { QuickBooksPayablesBinding, QuickBooksVendorBinding } from "./quickbooks";
import {
  assertBindings,
  assertEnumOptions,
  currency,
  date,
  datetime,
  decimal,
  invalid,
  mapped,
  optional,
  text,
  type ModelId,
} from "./normalization";

export type XeroMappedRecord = Readonly<{
  mappedFields: Readonly<Record<string, unknown>>;
  fields?: Readonly<Record<string, unknown>>;
}>;
export type XeroReadEnvelope = IntegrationEnvelope &
  Readonly<{ provider: "xero"; installationId: string; operationTime: string }>;
export type XeroSupplierBinding<D extends DataDefinition, I extends string> = Omit<
  QuickBooksVendorBinding<D, I>,
  "entityName"
>;
export type XeroPayablesBinding<
  D extends DataDefinition,
  I extends string,
  V extends string,
> = QuickBooksPayablesBinding<D, I, V> & {
  status?: Extract<
    Extract<D["models"][number], { id: I }>["fields"][number],
    { type: "text" | "enum"; readOnly: false }
  >["name"];
};
/** Xero supplier and AP mapped reads; raw fields are used only for deliberate eligibility filters. */
export function createXeroRecipe<
  D extends DataDefinition,
  V extends ModelId<D>,
  T extends ModelId<D> = ModelId<D>,
>(
  definition: D,
  input: {
    id: string;
    version: string;
    suppliers: XeroSupplierBinding<D, V>;
    payables?: XeroPayablesBinding<D, T, V>;
  },
) {
  const supplier = input.suppliers;
  assertEnumOptions(definition, supplier.model, supplier.status, ["active", "inactive"]);
  assertBindings(definition, supplier.model, {
    [supplier.name]: ["text"],
    [supplier.status]: ["text", "enum"],
  });
  if (String(input.payables?.model) === String(supplier.model)) invalid("recipe_models_overlap");
  const projections: Record<string, unknown> = {
    [supplier.model]: {
      object: "contacts",
      fields: [supplier.name, supplier.status],
      matching: "source_reference",
      clearing: "reject",
      filterRecord: (record: XeroMappedRecord, envelope: XeroReadEnvelope) => {
        verifyEnvelope(envelope);
        const value = record.fields?.IsSupplier ?? mapped(record).is_supplier;
        if (typeof value !== "boolean") invalid("xero_supplier_flag_invalid");
        return value;
      },
      sourceReference: (record: XeroMappedRecord, envelope: XeroReadEnvelope) =>
        sourceReference("contacts", record, envelope),
      normalize: (record: XeroMappedRecord, envelope: XeroReadEnvelope) => {
        verifyEnvelope(envelope);
        const fields = mapped(record);
        const status = text(fields.status);
        if (!["active", "inactive"].includes(status)) invalid("xero_status_invalid");
        return { [supplier.name]: text(fields.name), [supplier.status]: status };
      },
    },
  };
  if (input.payables) {
    const target = input.payables;
    if (target.provider) assertEnumOptions(definition, target.model, target.provider, ["xero"]);
    if (target.integrationPlatformId)
      assertEnumOptions(definition, target.model, target.integrationPlatformId, ["ampersand"]);
    assertEnumOptions(definition, target.model, target.transactionKind, ["bill", "credit"]);
    const fields = Object.entries(target).flatMap(([key, value]) =>
      key !== "model" && value !== undefined ? [value as string] : [],
    );
    assertBindings(definition, target.model, {
      [target.vendor]: ["relation"],
      [target.amount]: ["number"],
      [target.currencyCode]: ["text", "iso_currency"],
      [target.transactionDate]: ["date"],
      [target.sourceUpdatedAt]: ["datetime"],
      [target.transactionKind]: ["text", "enum"],
      ...(target.openAmount ? { [target.openAmount]: ["number"] } : {}),
      ...(target.dueDate ? { [target.dueDate]: ["date"] } : {}),
    });
    const relation = definition.models
      .find((model) => model.id === target.model)
      ?.fields.find((field) => field.name === target.vendor);
    if (!relation || relation.target_model !== supplier.model) invalid("recipe_relation_mismatch");
    projections[target.model] = {
      object: ["invoices", "creditNotes"],
      fields,
      matching: "source_reference",
      clearing: "reject",
      filterRecord: (record: XeroMappedRecord, envelope: XeroReadEnvelope) => {
        verifyEnvelope(envelope);
        const type = record.fields?.Type ?? mapped(record).document_type;
        if (typeof type !== "string") invalid("xero_document_type_invalid");
        return type === (envelope.object === "creditNotes" ? "ACCPAYCREDIT" : "ACCPAY");
      },
      sourceReference: (record: XeroMappedRecord, envelope: XeroReadEnvelope) =>
        sourceReference(envelope.object, record, envelope),
      normalize: (
        record: XeroMappedRecord,
        envelope: XeroReadEnvelope,
        _binding: unknown,
        delivery: { payloadHash: string },
      ) => {
        verifyEnvelope(envelope);
        const source = mapped(record);
        const credit = envelope.object === "creditNotes";
        const sign = credit ? "negative" : "positive";
        const output: Record<string, unknown> = {
          [target.vendor]: integrationSource(
            supplier.model,
            `xero:contacts:${text(envelope.installationId)}:${text(source.vendor_source_record_id)}`,
          ),
          [target.amount]: decimal(source.amount, sign),
          [target.currencyCode]: currency(source.currency_code),
          [target.transactionDate]: date(source.transaction_date),
          [target.sourceUpdatedAt]: datetime(source.source_updated_at),
          [target.transactionKind]: credit ? "credit" : "bill",
        };
        optional(output, target.status, source.status, text);
        optional(output, target.counterpartyName, source.counterparty_name, text);
        optional(output, target.documentNumber, source.document_number, text);
        optional(output, target.openAmount, source.open_amount, (value) => decimal(value, sign));
        if (!credit) optional(output, target.dueDate, source.due_date, date);
        optional(
          output,
          target.sourceReference,
          sourceReference(envelope.object, record, envelope),
          text,
        );
        optional(output, target.sourceRecordId, source.source_record_id, text);
        optional(output, target.sourceConnectionId, envelope.installationId, text);
        optional(output, target.provider, "xero", text);
        optional(output, target.integrationPlatformId, "ampersand", text);
        optional(output, target.payloadHash, delivery.payloadHash, text);
        return output;
      },
    };
  }
  return defineIntegrationRecipe<D, XeroMappedRecord, XeroReadEnvelope>(definition, {
    id: input.id,
    version: input.version,
    sourceIdentity: "app_owned",
    effectiveStart: (envelope) => {
      verifyEnvelope(envelope);
      return datetime(envelope.operationTime).slice(0, 10);
    },
    projections: projections as IntegrationRecipe<
      D,
      XeroMappedRecord,
      XeroReadEnvelope
    >["projections"],
  });
}
function verifyEnvelope(envelope: XeroReadEnvelope): void {
  if (envelope.provider !== "xero") invalid("provider_mismatch");
  text(envelope.installationId);
  datetime(envelope.operationTime);
}
function sourceReference(
  object: string,
  record: XeroMappedRecord,
  envelope: XeroReadEnvelope,
): string {
  verifyEnvelope(envelope);
  return `xero:${object}:${text(envelope.installationId)}:${text(mapped(record).source_record_id)}`;
}
