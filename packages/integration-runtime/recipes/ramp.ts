import type { DataDefinition } from "../../generated-app-runtime/data";
import {
  defineIntegrationRecipe,
  type IntegrationEnvelope,
  type IntegrationRecipe,
} from "../index";
import {
  assertBindings,
  assertEnumOptions,
  currency,
  date,
  datetime,
  decimal,
  invalid,
  optional,
  text,
  type FieldName,
  type ModelId,
} from "./normalization";

/** Raw transaction objects returned by the Ramp proxy, never Ampersand mapped reads. */
export type RampProxyTransaction = Readonly<Record<string, unknown>>;
export type RampProxyEnvelope = IntegrationEnvelope &
  Readonly<{
    provider: "ramp" | "rampDemo";
    installationId: string;
    syncTime: string;
    transport: "proxy";
  }>;
export type RampTransactionBinding<D extends DataDefinition, I extends string> = {
  model: I;
  counterpartyName: FieldName<D, I, "text">;
  amount: FieldName<D, I, "number">;
  currencyCode: FieldName<D, I, "text" | "iso_currency">;
  status: FieldName<D, I, "text">;
  transactionDate: FieldName<D, I, "date">;
  accountingDate: FieldName<D, I, "date">;
  sourceUpdatedAt: FieldName<D, I, "datetime">;
  settlementDate?: FieldName<D, I, "date"> | undefined;
  transactionKind?: FieldName<D, I, "text" | "enum"> | undefined;
  sourceReference?: FieldName<D, I, "text"> | undefined;
  sourceRecordId?: FieldName<D, I, "text"> | undefined;
  sourceConnectionId?: FieldName<D, I, "text"> | undefined;
  provider?: FieldName<D, I, "text" | "enum"> | undefined;
  integrationPlatformId?: FieldName<D, I, "text" | "enum"> | undefined;
  payloadHash?: FieldName<D, I, "text"> | undefined;
};
/**
 * Projects transaction-level proxy data. No aggregate conversion or speculative
 * vendor-name matching is performed. App-required relations require an explicit
 * app-owned supported recipe instead of provider IDs in external_key.
 */
export function createRampRecipe<D extends DataDefinition, T extends ModelId<D>>(
  definition: D,
  input: {
    id: string;
    version: string;
    transactions: RampTransactionBinding<D, T>;
    currencies?: readonly string[];
  },
) {
  const target = input.transactions;
  if (target.provider) assertEnumOptions(definition, target.model, target.provider, ["ramp"]);
  if (target.integrationPlatformId)
    assertEnumOptions(definition, target.model, target.integrationPlatformId, ["ampersand"]);
  if (target.transactionKind)
    assertEnumOptions(definition, target.model, target.transactionKind, ["card_transaction"]);
  assertBindings(definition, target.model, {
    [target.counterpartyName]: ["text"],
    [target.amount]: ["number"],
    [target.currencyCode]: ["text", "iso_currency"],
    [target.status]: ["text"],
    [target.transactionDate]: ["date"],
    [target.accountingDate]: ["date"],
    [target.sourceUpdatedAt]: ["datetime"],
    ...(target.settlementDate ? { [target.settlementDate]: ["date"] } : {}),
  });
  const model = definition.models.find((entry) => entry.id === target.model)!;
  if (
    model.fields.some(
      (field) =>
        field.type === "relation" &&
        field.required &&
        !field.readOnly &&
        field.lifecycle !== "retired",
    )
  )
    invalid("ramp_required_relation_unsupported");
  const fields = Object.entries(target).flatMap(([key, value]) =>
    key !== "model" && value !== undefined ? [value as string] : [],
  );
  const currencies = input.currencies ?? ["USD"];
  if (currencies.length === 0 || currencies.some((code) => !/^[A-Z]{3}$/.test(code)))
    invalid("currency_policy_invalid");
  const projection = {
    object: "transactions",
    fields,
    matching: "source_reference",
    clearing: "reject",
    effectiveStart: (record: RampProxyTransaction, envelope: RampProxyEnvelope) => {
      verify(record, envelope);
      return providerDate(record.accounting_date);
    },
    sourceReference: (record: RampProxyTransaction, envelope: RampProxyEnvelope) => {
      verify(record, envelope);
      return sourceRef(record, envelope);
    },
    normalize: (
      record: RampProxyTransaction,
      envelope: RampProxyEnvelope,
      _binding: unknown,
      delivery: { payloadHash: string },
    ) => {
      verify(record, envelope);
      const output: Record<string, unknown> = {
        [target.counterpartyName]: text(record.merchant_name),
        [target.amount]: proxyAmount(record),
        [target.currencyCode]: currency(proxyCurrency(record), currencies),
        [target.status]: text(record.state),
        [target.transactionDate]: datetime(record.user_transaction_time).slice(0, 10),
        [target.accountingDate]: providerDate(record.accounting_date),
        [target.sourceUpdatedAt]: datetime(
          record.updated_at ?? record.synced_at ?? record.user_transaction_time,
        ),
      };
      optional(output, target.settlementDate, record.settlement_date, providerDate);
      optional(output, target.transactionKind, "card_transaction", text);
      optional(output, target.sourceReference, sourceRef(record, envelope), text);
      optional(output, target.sourceRecordId, record.id, text);
      optional(output, target.sourceConnectionId, envelope.installationId, text);
      optional(output, target.provider, "ramp", text);
      optional(output, target.integrationPlatformId, "ampersand", text);
      optional(output, target.payloadHash, delivery.payloadHash, text);
      return output;
    },
  };
  return defineIntegrationRecipe<D, RampProxyTransaction, RampProxyEnvelope>(definition, {
    id: input.id,
    version: input.version,
    sourceIdentity: "app_owned",
    effectiveStart: (envelope) => {
      verifyEnvelope(envelope);
      return datetime(envelope.syncTime).slice(0, 10);
    },
    projections: { [target.model]: projection } as unknown as IntegrationRecipe<
      D,
      RampProxyTransaction,
      RampProxyEnvelope
    >["projections"],
  });
}
function verifyEnvelope(envelope: RampProxyEnvelope): void {
  if (!["ramp", "rampDemo"].includes(envelope.provider) || envelope.transport !== "proxy")
    invalid("ramp_transport_mismatch");
  text(envelope.installationId);
  datetime(envelope.syncTime);
}
function verify(record: RampProxyTransaction, envelope: RampProxyEnvelope): void {
  verifyEnvelope(envelope);
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    record.kind === "vendor_aggregate" ||
    record.mappedFields !== undefined
  )
    invalid("ramp_transaction_required");
  text(record.id);
}
function sourceRef(record: RampProxyTransaction, envelope: RampProxyEnvelope): string {
  return `ampersand:ramp:card_transaction:${text(envelope.installationId)}:${text(record.id)}`;
}
function providerDate(value: unknown): string {
  const candidate = text(value);
  return candidate.length === 10 ? date(candidate) : datetime(candidate).slice(0, 10);
}
function proxyCurrency(record: RampProxyTransaction): unknown {
  if (
    record.currency_code !== undefined &&
    record.currency_code !== null &&
    record.currency_code !== ""
  )
    return record.currency_code;
  const amount = record.original_transaction_amount;
  return amount && typeof amount === "object"
    ? (amount as Record<string, unknown>).currency_code
    : undefined;
}
function proxyAmount(record: RampProxyTransaction): string {
  const original = record.original_transaction_amount;
  if (original && typeof original === "object" && !Array.isArray(original)) {
    const amount = original as Record<string, unknown>;
    if (
      amount.currency_code === proxyCurrency(record) &&
      typeof amount.amount === "number" &&
      Number.isSafeInteger(amount.amount) &&
      typeof amount.minor_unit_conversion_rate === "number" &&
      Number.isSafeInteger(amount.minor_unit_conversion_rate)
    ) {
      const scale = amount.minor_unit_conversion_rate;
      if (scale <= 0 || !/^10*$/.test(String(scale))) invalid("ramp_minor_unit_scale_unsupported");
      const minor = BigInt(amount.amount);
      const rate = BigInt(scale);
      const absolute = minor < 0n ? -minor : minor;
      const fraction = absolute % rate;
      return `${minor < 0n ? "-" : ""}${absolute / rate}${
        fraction
          ? `.${String(fraction)
              .padStart(String(scale).length - 1, "0")
              .replace(/0+$/u, "")}`
          : ""
      }`;
    }
  }
  if (typeof record.amount !== "number") invalid("ramp_amount_invalid");
  return decimal(record.amount);
}
