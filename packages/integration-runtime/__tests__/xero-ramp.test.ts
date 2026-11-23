import { expect, test } from "vitest";
import type { DataDefinition } from "../../generated-app-runtime/data";
import { createXeroRecipe, type XeroReadEnvelope } from "../recipes/xero";
import { createRampRecipe, type RampProxyEnvelope } from "../recipes/ramp";
import { definition } from "./quickbooks-fixture";
import type { ActiveIntegrationBinding } from "../index";
const identity = {
  appId: "app",
  customerId: "tenant",
  bindingId: "binding",
  connectionId: "connection",
  routingId: "route",
  deliveryId: "chunk",
};
const binding: ActiveIntegrationBinding = {
  ...identity,
  lifecycle: "active",
  bindingRevision: 1,
  actorId: "service",
};
const delivery = { payloadHash: "a".repeat(64), deliveryRef: "delivery" };
const xero = createXeroRecipe(definition, {
  id: "app.xero.apply",
  version: "v1",
  suppliers: { model: "supplier", name: "name", status: "status" },
  payables: {
    model: "payable",
    vendor: "vendor",
    amount: "amount",
    currencyCode: "currency",
    transactionDate: "date",
    sourceUpdatedAt: "updated",
    transactionKind: "kind",
    openAmount: "open",
    dueDate: "due",
  },
});
const envelope: XeroReadEnvelope = {
  identity,
  object: "contacts",
  provider: "xero",
  installationId: "installation",
  operationTime: "2026-10-15T12:00:00Z",
};
test("Xero explicitly filters suppliers and accounts-payable documents", () => {
  const suppliers = xero.recipe.projections.supplier!;
  const payables = xero.recipe.projections.payable!;
  expect(
    suppliers.filterRecord!({ mappedFields: {}, fields: { IsSupplier: true } }, envelope),
  ).toBe(true);
  expect(
    suppliers.filterRecord!({ mappedFields: {}, fields: { IsSupplier: false } }, envelope),
  ).toBe(false);
  expect(
    payables.filterRecord!(
      { mappedFields: {}, fields: { Type: "ACCREC" } },
      { ...envelope, object: "invoices" },
    ),
  ).toBe(false);
  expect(
    payables.filterRecord!(
      { mappedFields: {}, fields: { Type: "ACCPAY" } },
      { ...envelope, object: "invoices" },
    ),
  ).toBe(true);
  expect(
    payables.filterRecord!(
      { mappedFields: {}, fields: { Type: "ACCPAYCREDIT" } },
      { ...envelope, object: "creditNotes" },
    ),
  ).toBe(true);
});
test("Xero credit and remaining balance are negative with scoped supplier relation", () => {
  const record = {
    mappedFields: {
      source_record_id: "credit-1",
      vendor_source_record_id: "vendor-1",
      amount: "9007199254740993.125",
      open_amount: "120.25",
      currency_code: "usd",
      transaction_date: "2026-10-15",
      source_updated_at: "2026-10-15T12:00:00Z",
    },
  };
  const projection = xero.recipe.projections.payable!;
  expect(
    projection.normalize(record, { ...envelope, object: "creditNotes" }, binding, delivery),
  ).toMatchObject({
    amount: "-9007199254740993.125",
    open: "-120.25",
    currency: "USD",
    kind: "credit",
    vendor: {
      kind: "integration_source",
      model: "supplier",
      sourceRef: "xero:contacts:installation:vendor-1",
    },
  });
  expect(projection.sourceReference(record, { ...envelope, object: "creditNotes" })).toBe(
    "xero:creditNotes:installation:credit-1",
  );
  expect(
    xero.recipe.projections.supplier!.normalize(
      { mappedFields: { name: "Acme", status: "inactive" } },
      envelope,
      binding,
      delivery,
    ),
  ).toEqual({ name: "Acme", status: "inactive" });
});
const rampDefinition = {
  formatVersion: 1,
  schemaVersion: "ramp-v1",
  models: [
    {
      id: "charge",
      name: "charge",
      fields: [
        { id: "merchant", name: "merchant", type: "text", required: true, readOnly: false },
        { id: "amount", name: "amount", type: "number", required: true, readOnly: false },
        { id: "currency", name: "currency", type: "iso_currency", required: true, readOnly: false },
        { id: "status", name: "status", type: "text", required: true, readOnly: false },
        { id: "date", name: "date", type: "date", required: true, readOnly: false },
        { id: "accounting", name: "accounting", type: "date", required: true, readOnly: false },
        { id: "updated", name: "updated", type: "datetime", required: true, readOnly: false },
        { id: "settled", name: "settled", type: "date", required: false, readOnly: false },
      ],
      relations: [],
    },
  ],
} as const satisfies DataDefinition;
const ramp = createRampRecipe(rampDefinition, {
  id: "app.ramp.apply",
  version: "v1",
  transactions: {
    model: "charge",
    counterpartyName: "merchant",
    amount: "amount",
    currencyCode: "currency",
    status: "status",
    transactionDate: "date",
    accountingDate: "accounting",
    sourceUpdatedAt: "updated",
    settlementDate: "settled",
  },
});
const rampEnvelope: RampProxyEnvelope = {
  identity,
  object: "transactions",
  provider: "ramp",
  installationId: "installation",
  syncTime: "2026-10-15T12:00:00Z",
  transport: "proxy",
};
const charge = {
  id: "transaction-1",
  merchant_name: "Acme",
  currency_code: "USD",
  amount: 999,
  original_transaction_amount: {
    amount: -12345,
    minor_unit_conversion_rate: 100,
    currency_code: "USD",
  },
  state: "CLEARED",
  user_transaction_time: "2026-10-10T12:00:00Z",
  accounting_date: "2026-10-11",
  settlement_date: "2026-10-12",
  updated_at: "2026-10-13T12:00:00Z",
};
test("Ramp proxy chooses exact minor-unit amount and record accounting date", () => {
  const projection = ramp.recipe.projections.charge!;
  expect(projection.normalize(charge, rampEnvelope, binding, delivery)).toEqual({
    merchant: "Acme",
    amount: "-123.45",
    currency: "USD",
    status: "CLEARED",
    date: "2026-10-10",
    accounting: "2026-10-11",
    settled: "2026-10-12",
    updated: "2026-10-13T12:00:00Z",
  });
  expect(projection.effectiveStart!(charge, rampEnvelope)).toBe("2026-10-11");
  expect(projection.sourceReference(charge, rampEnvelope)).toBe(
    "ampersand:ramp:card_transaction:installation:transaction-1",
  );
});
test("Ramp rejects mapped-read/aggregate transport and unsupported currency or scale", () => {
  const projection = ramp.recipe.projections.charge!;
  for (const record of [
    { ...charge, kind: "vendor_aggregate" },
    { ...charge, mappedFields: {} },
    { ...charge, currency_code: "EUR" },
    {
      ...charge,
      original_transaction_amount: {
        amount: 123,
        minor_unit_conversion_rate: 3,
        currency_code: "USD",
      },
    },
  ])
    expect(() => projection.normalize(record, rampEnvelope, binding, delivery)).toThrow();
  expect(() =>
    projection.normalize(
      charge,
      { ...rampEnvelope, transport: "read" as "proxy" },
      binding,
      delivery,
    ),
  ).toThrow("transport_mismatch");
  expect(() =>
    createRampRecipe(definition, {
      id: "unsupported",
      version: "v1",
      transactions: {
        model: "payable",
        counterpartyName: "vendor" as never,
        amount: "amount",
        currencyCode: "currency",
        status: "kind" as never,
        transactionDate: "date",
        accountingDate: "due",
        sourceUpdatedAt: "updated",
      },
    }),
  ).toThrow();
});

test("Ramp optional undefined bindings preserve normalization", () => {
  const recipe = createRampRecipe(rampDefinition, {
    id: "app.ramp.optional",
    version: "v1",
    transactions: {
      model: "charge",
      counterpartyName: "merchant",
      amount: "amount",
      currencyCode: "currency",
      status: "status",
      transactionDate: "date",
      accountingDate: "accounting",
      sourceUpdatedAt: "updated",
      settlementDate: undefined,
    },
  });
  expect(
    recipe.recipe.projections.charge!.normalize(charge, rampEnvelope, binding, delivery),
  ).toEqual({
    merchant: "Acme",
    amount: "-123.45",
    currency: "USD",
    status: "CLEARED",
    date: "2026-10-10",
    accounting: "2026-10-11",
    updated: "2026-10-13T12:00:00Z",
  });
});

test("Ramp ignores retired required relations while rejecting active required relations", () => {
  const relation = {
    id: "old",
    name: "old",
    type: "relation",
    required: true,
    readOnly: false,
    lifecycle: "retired",
  } as const;
  const schema = {
    ...rampDefinition,
    models: [
      { ...rampDefinition.models[0], fields: [...rampDefinition.models[0].fields, relation] },
    ],
  } as const;
  const transactions = {
    model: "charge",
    counterpartyName: "merchant",
    amount: "amount",
    currencyCode: "currency",
    status: "status",
    transactionDate: "date",
    accountingDate: "accounting",
    sourceUpdatedAt: "updated",
  } as const;
  expect(() =>
    createRampRecipe(schema, { id: "retired", version: "v1", transactions }),
  ).not.toThrow();
  const active = {
    ...schema,
    models: [
      {
        ...schema.models[0],
        fields: [...rampDefinition.models[0].fields, { ...relation, lifecycle: "active" as const }],
      },
    ],
  } as const;
  expect(() => createRampRecipe(active, { id: "active", version: "v1", transactions })).toThrow(
    "ramp_required_relation_unsupported",
  );
});
