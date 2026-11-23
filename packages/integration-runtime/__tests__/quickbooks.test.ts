import { expect, test } from "vitest";
import {
  createQuickBooksRecipe,
  type QuickBooksMappedRecord,
  type QuickBooksReadEnvelope,
} from "../recipes/quickbooks";
import type { ActiveIntegrationBinding } from "../index";
import { definition } from "./quickbooks-fixture";
const identity = {
  appId: "app",
  customerId: "tenant",
  bindingId: "binding",
  connectionId: "conn",
  routingId: "route",
  deliveryId: "chunk-1",
};
const binding: ActiveIntegrationBinding = {
  ...identity,
  lifecycle: "active",
  bindingRevision: 1,
  actorId: "service",
};
const envelope: QuickBooksReadEnvelope = {
  identity,
  object: "vendor",
  provider: "quickbooks",
  installationId: "installation",
  operationTime: "2026-10-15T12:00:00Z",
};
const projection = createQuickBooksRecipe(definition, {
  id: "app.quickbooks.apply",
  version: "v1",
  vendors: { model: "supplier", name: "name", status: "status", entityName: "entity" },
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
function record(values: Record<string, unknown>): QuickBooksMappedRecord {
  return { mappedFields: { source_record_id: "source-1", ...values } };
}
const delivery = { payloadHash: "a".repeat(64), deliveryRef: "delivery" };
test("QuickBooks mapped vendor uses app schema fields and never a provider external key", () => {
  const recipe = projection.recipe.projections.supplier!;
  const input = record({ name: "Acme", status: true, entity_name: "Acme Inc" });
  expect(recipe.normalize(input, envelope, binding, delivery)).toEqual({
    name: "Acme",
    status: "active",
    entity: "Acme Inc",
  });
  expect(recipe.sourceReference(input, envelope)).toBe("quickbooks:vendor:installation:source-1");
  expect(projection.recipe.effectiveStart(envelope)).toBe("2026-10-15");
  expect(() =>
    recipe.normalize(record({ name: "Acme", status: "active" }), envelope, binding, delivery),
  ).toThrow("status_invalid");
});
test("bills preserve decimal precision and credits normalize sign, zero, and canonical source relation", () => {
  const recipe = projection.recipe.projections.payable!;
  const input = record({
    vendor_source_record_id: "vendor-1",
    amount: "9007199254740993.125",
    currency_code: "usd",
    transaction_date: "2026-10-15",
    source_updated_at: "2026-10-15T12:00:00Z",
    open_amount: "99.12",
    due_date: "2026-11-15",
  });
  expect(recipe.normalize(input, { ...envelope, object: "bill" }, binding, delivery)).toMatchObject(
    {
      amount: "9007199254740993.125",
      currency: "USD",
      kind: "bill",
      open: "99.12",
      due: "2026-11-15",
      vendor: {
        kind: "integration_source",
        model: "supplier",
        sourceRef: "quickbooks:vendor:installation:vendor-1",
      },
    },
  );
  expect(
    recipe.normalize(input, { ...envelope, object: "vendor_credit" }, binding, delivery),
  ).toMatchObject({ amount: "-9007199254740993.125", kind: "credit" });
  expect(
    recipe.normalize(
      record({ ...input.mappedFields, amount: "-0.00" }),
      { ...envelope, object: "vendorCredit" },
      binding,
      delivery,
    ),
  ).toMatchObject({ amount: "0.00" });
});
test("invalid provider dates/currency/numeric coercion and missing mapped source fail closed", () => {
  const recipe = projection.recipe.projections.payable!;
  const valid = {
    vendor_source_record_id: "vendor",
    amount: "1",
    currency_code: "USD",
    transaction_date: "2026-10-15",
    source_updated_at: "2026-10-15T12:00:00Z",
  };
  for (const changes of [
    { amount: "1e4" },
    { currency_code: "US" },
    { transaction_date: "2026-02-30" },
    { source_updated_at: "yesterday" },
  ])
    expect(() =>
      recipe.normalize(
        record({ ...valid, ...changes }),
        { ...envelope, object: "bill" },
        binding,
        delivery,
      ),
    ).toThrow();
  expect(() =>
    projection.recipe.effectiveStart({ ...envelope, provider: "xero" as "quickbooks" }),
  ).toThrow("provider_mismatch");
  expect(() =>
    recipe.sourceReference({ mappedFields: {} }, { ...envelope, object: "bill" }),
  ).toThrow("text_invalid");
});

test("provider factory rejects schema enums missing required supported options", () => {
  const unsupported = {
    ...definition,
    models: [
      {
        ...definition.models[0],
        fields: [
          definition.models[0].fields[0],
          { ...definition.models[0].fields[1], option_set: [{ id: "active" }] },
          definition.models[0].fields[2],
        ],
      },
      definition.models[1],
    ],
  } as const;
  expect(() =>
    createQuickBooksRecipe(unsupported, {
      id: "unsupported",
      version: "v1",
      vendors: { model: "supplier", name: "name", status: "status" },
    }),
  ).toThrow("recipe_enum_option_missing");
});

test("provider factory rejects omitted writable required generated fields during definition", () => {
  const requiredEntity = {
    ...definition,
    models: [
      {
        ...definition.models[0],
        fields: [
          definition.models[0].fields[0],
          definition.models[0].fields[1],
          { ...definition.models[0].fields[2], required: true },
        ],
      },
      definition.models[1],
    ],
  } as const;
  expect(() =>
    createQuickBooksRecipe(requiredEntity, {
      id: "missing-map",
      version: "v1",
      vendors: { model: "supplier", name: "name", status: "status" },
    }),
  ).toThrow("required_field_mapping_missing");
});

test.each(["2026-99-99", "2026-00-00", "2026-02-30"])(
  "direct QuickBooks normalization rejects impossible date %s with its validation error",
  (transaction_date) => {
    expect(() =>
      projection.recipe.projections.payable!.normalize(
        record({
          vendor_source_record_id: "vendor",
          amount: "1",
          currency_code: "USD",
          transaction_date,
          source_updated_at: "2026-10-15T12:00:00Z",
        }),
        { ...envelope, object: "bill" },
        binding,
        delivery,
      ),
    ).toThrow("integration_date_invalid");
  },
);
