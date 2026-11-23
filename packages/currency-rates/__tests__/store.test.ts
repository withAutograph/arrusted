import { expect, test, vi } from "vite-plus/test";
import type { AppliedChangeSet, RowVersionWrite, VisibleRecord } from "../../contracts";
import { createCurrencyRateStore, resolveCurrencyRate } from "../index";
const request = { sourceCurrency: "EUR", targetCurrency: "USD", asOf: "2026-03-15" };
const custom = {
  sourceCurrency: "EUR",
  targetCurrency: "USD",
  rate: "1.25",
  effectiveStart: "2026-03-01",
  effectiveEnd: "2026-03-20",
};
function setup(rows: VisibleRecord[] = []) {
  const kernel = {
    readVisibleRecords: vi.fn().mockResolvedValue(rows),
    applyChangeSet: vi.fn().mockResolvedValue({ id: 1 } as AppliedChangeSet),
  };
  return {
    kernel,
    store: createCurrencyRateStore({
      kernel,
      scope: { appId: "fx-test", customerId: "tenant-a" },
      actorId: "editor",
    }),
  };
}
function row(origin: "custom" | "frankfurter", rate?: string): VisibleRecord {
  const key = `EUR/USD/${origin}`;
  return {
    record_id: key,
    external_key: key,
    effective_start: "2026-03-01",
    effective_end: origin === "custom" && rate ? "2026-03-20" : null,
    custom_fields: [],
    values: {
      source_currency: { type: "text", value: "EUR" },
      target_currency: { type: "text", value: "USD" },
      origin: { type: "enum", value: origin },
      ...(rate ? { rate: { type: "number" as const, value: rate } } : {}),
    },
  };
}
test("custom writes use stable identity, tenant/actor scope and kernel versioning", async () => {
  const { store, kernel } = setup();
  await store.saveCustom(custom, { idempotencyKey: "save-1", expectedVersionId: "previous" });
  const call = kernel.applyChangeSet.mock.calls[0]![0];
  expect(call).toMatchObject({
    app_id: "fx-test",
    customer_id: "tenant-a",
    actor_id: "editor",
    mode: "mainline",
    idempotency_key: "save-1",
  });
  expect(call.writes[0]).toMatchObject({
    record_key: { type: "external_key", value: "EUR/USD/custom" },
    expected_version_id: "previous",
    effective_start: "2026-03-01",
    values: {
      rate: { type: "number", value: "1.25" },
    },
  });
  expect(call.writes[1]).toMatchObject({
    record_key: { type: "external_key", value: "EUR/USD/custom" },
    effective_start: "2026-03-21",
    clear_fields: ["rate", "observation_date"],
  });
  expect(call.writes[1]).not.toHaveProperty("expected_version_id");
});
test("returning to automatic clears the custom value through an ordinary version", async () => {
  const { store, kernel } = setup();
  await store.useAutomatic(
    { ...request, effectiveStart: "2026-03-10" },
    { idempotencyKey: "auto-1" },
  );
  const write = kernel.applyChangeSet.mock.calls[0]![0].writes[0];
  expect(write.clear_fields).toEqual(["rate", "observation_date"]);
  expect(write.values).not.toHaveProperty("rate");
});
test("live reads respect custom expiry, automatic fallback, and open-ended future dates", async () => {
  const { store, kernel } = setup([row("custom", "1.25"), row("frankfurter", "1.10")]);
  expect(resolveCurrencyRate(await store.read(request), request)).toMatchObject({
    rate: "1.25",
    origin: "custom",
  });
  const future = { ...request, asOf: "2027-01-01" };
  expect(resolveCurrencyRate(await store.read(future), future)).toMatchObject({
    rate: "1.10",
    origin: "frankfurter",
  });
  kernel.readVisibleRecords.mockResolvedValue([row("custom"), row("frankfurter", "1.15")]);
  expect(resolveCurrencyRate(await store.read(request), request)).toMatchObject({
    rate: "1.15",
    origin: "frankfurter",
  });
  expect(kernel.readVisibleRecords).toHaveBeenLastCalledWith({
    app_id: "fx-test",
    customer_id: "tenant-a",
    model_id: "exchange_rate",
    as_of: "2026-03-15",
  });
});
test("failed provider preparation never writes; successful preparation uses a separate stable provider record", async () => {
  const { store, kernel } = setup();
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response("{}", { status: 503 }))
    .mockResolvedValueOnce(
      new Response('{"base":"EUR","quote":"USD","date":"2026-03-01","rate":1.1}'),
    );
  const options = { fetch, today: "2026-03-15", idempotencyKey: "import-1" };
  await expect(store.importMonthly({ ...request, month: "2026-03" }, options)).rejects.toThrow();
  expect(kernel.applyChangeSet).not.toHaveBeenCalled();
  await store.importMonthly({ ...request, month: "2026-03" }, options);
  expect(kernel.applyChangeSet.mock.calls[0]![0]).toMatchObject({
    actor_id: "editor",
    source_kind: "data_import",
  });
  expect(kernel.applyChangeSet.mock.calls[0]![0].writes[0].record_key.value).toBe(
    "EUR/USD/frankfurter",
  );
});
test("monthly imports reject an empty idempotency key before contacting the provider", async () => {
  const { store, kernel } = setup();
  const fetch = vi.fn<typeof globalThis.fetch>();
  await expect(
    store.importMonthly(
      { ...request, month: "2026-03" },
      { fetch, today: "2026-03-15", idempotencyKey: " " },
    ),
  ).rejects.toThrow("idempotency");
  expect(fetch).not.toHaveBeenCalled();
  expect(kernel.applyChangeSet).not.toHaveBeenCalled();
});

test("extending a finite correction atomically replaces its old automatic boundary", async () => {
  const { store, kernel } = setup();
  await store.saveCustom(
    { ...custom, effectiveEnd: "2026-03-25", previousEffectiveEnd: "2026-03-20" },
    { idempotencyKey: "extend", expectedVersionId: "current" },
  );
  const writes = kernel.applyChangeSet.mock.calls[0]![0].writes;
  expect(writes.map((write: RowVersionWrite) => write.effective_start)).toEqual([
    "2026-03-01",
    "2026-03-21",
    "2026-03-26",
  ]);
  expect(writes[1].values.rate).toEqual({ type: "number", value: "1.25" });
  expect(writes[2].values).not.toHaveProperty("rate");
  expect(writes[0].expected_version_id).toBe("current");
});
test("invalid custom rates never reach persistence", () => {
  const { store, kernel } = setup();
  expect(() => store.saveCustom({ ...custom, rate: "-1" }, { idempotencyKey: "bad" })).toThrow();
  expect(kernel.applyChangeSet).not.toHaveBeenCalled();
});

test("history jumps visible version boundaries, including empty custom transitions, and deduplicates", async () => {
  const oldAutomatic = {
    ...row("frankfurter", "1.1"),
    version_id: "auto-old",
    effective_start: "2000-01-01",
    effective_end: "2026-02-28",
  };
  const latestAutomatic = { ...row("frankfurter", "1.2"), version_id: "auto-new" };
  const oldCustom = {
    ...row("custom", "1.3"),
    version_id: "custom-old",
    effective_start: "2026-02-01",
    effective_end: "2026-03-09",
  };
  const automaticTransition = {
    ...row("custom"),
    version_id: "custom-off",
    effective_start: "2026-03-10",
  };
  const { store, kernel } = setup();
  kernel.readVisibleRecords.mockImplementation(async ({ as_of }: { as_of: string }) =>
    [oldAutomatic, latestAutomatic, oldCustom, automaticTransition].filter(
      (version) =>
        version.effective_start <= as_of &&
        (!version.effective_end || version.effective_end >= as_of),
    ),
  );
  const periods = await store.history(request);
  expect(
    periods.map(({ rate, effectiveStart, effectiveEnd }) => [rate, effectiveStart, effectiveEnd]),
  ).toEqual([
    ["1.2", "2026-03-01", null],
    ["1.3", "2026-02-01", "2026-03-09"],
    ["1.1", "2000-01-01", "2026-02-28"],
  ]);
  expect(kernel.readVisibleRecords.mock.calls.map(([query]) => query.as_of)).toEqual([
    "9999-12-31",
    "2026-03-09",
    "2026-02-28",
    "2026-01-31",
    "1999-12-31",
  ]);
  expect(kernel.readVisibleRecords.mock.calls[0]![0]).not.toHaveProperty("record_ids");
  expect(kernel.readVisibleRecords.mock.calls[1]![0].record_ids).toEqual([
    "EUR/USD/frankfurter",
    "EUR/USD/custom",
  ]);
  expect(kernel.applyChangeSet).not.toHaveBeenCalled();
});

test("history handles missing pairs, identity, minimum dates, and malformed kernel periods", async () => {
  const { store, kernel } = setup();
  expect(await store.history(request)).toEqual([]);
  kernel.readVisibleRecords.mockClear();
  expect(await store.history({ sourceCurrency: "USD", targetCurrency: "USD" })).toEqual([]);
  expect(kernel.readVisibleRecords).not.toHaveBeenCalled();
  kernel.readVisibleRecords.mockResolvedValue([
    { ...row("frankfurter", "1.1"), effective_start: "0001-01-01" },
  ]);
  expect(await store.history(request)).toHaveLength(1);
  expect(kernel.readVisibleRecords).toHaveBeenCalledTimes(1);
  kernel.readVisibleRecords.mockResolvedValue([
    { ...row("custom"), effective_start: "2026-02-30" },
  ]);
  await expect(store.history(request)).rejects.toThrow(/date/);
});

test("reads ignore malformed unrelated pairs but reject malformed matching rows", async () => {
  const malformed = row("frankfurter");
  malformed.values.source_currency = { type: "text", value: "GBP" };
  const { store, kernel } = setup([malformed, row("frankfurter", "1.1")]);
  expect(resolveCurrencyRate(await store.read(request), request)).toMatchObject({ rate: "1.1" });
  kernel.readVisibleRecords.mockResolvedValue([row("frankfurter")]);
  await expect(store.read(request)).rejects.toThrow("Invalid persisted exchange rate rate");
});

test("returning an identity pair to automatic never persists a custom record", () => {
  const { store, kernel } = setup();
  expect(() =>
    store.useAutomatic(
      { sourceCurrency: "USD", targetCurrency: "USD", effectiveStart: "2026-03-01" },
      { idempotencyKey: "identity" },
    ),
  ).toThrow("Same-currency conversion always uses 1");
  expect(kernel.applyChangeSet).not.toHaveBeenCalled();
});

test("opposite quotes share one record identity and are readable in both directions", async () => {
  const { store, kernel } = setup();
  await store.saveCustom(custom, { idempotencyKey: "direct" });
  await store.saveCustom(
    { ...custom, sourceCurrency: "USD", targetCurrency: "EUR", rate: "0.8" },
    { idempotencyKey: "inverse" },
  );
  const writes = kernel.applyChangeSet.mock.calls.map(([call]) => call.writes[0]);
  expect(writes.map((write) => write.record_key.value)).toEqual([
    "EUR/USD/custom",
    "EUR/USD/custom",
  ]);
  expect(writes[1].values).toMatchObject({
    source_currency: { value: "USD" },
    target_currency: { value: "EUR" },
    rate: { value: "0.8" },
  });
  const inverse = row("custom", "0.8");
  inverse.values.source_currency = { type: "text", value: "USD" };
  inverse.values.target_currency = { type: "text", value: "EUR" };
  kernel.readVisibleRecords.mockResolvedValue([inverse, row("frankfurter", "1.1")]);
  expect(resolveCurrencyRate(await store.read(request), request)).toMatchObject({
    rate: "0.8",
    operation: "divide",
    origin: "custom",
  });
  const reverse = { ...request, sourceCurrency: "USD", targetCurrency: "EUR" };
  expect(resolveCurrencyRate(await store.read(reverse), reverse)).toMatchObject({
    rate: "0.8",
    operation: "multiply",
    origin: "custom",
  });
});
test("monthly imports use the same provider direction regardless of the requested direction", async () => {
  const { store, kernel } = setup();
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response('{"base":"EUR","quote":"USD","date":"2026-03-01","rate":1.1}'));
  await store.importMonthly(
    { sourceCurrency: "USD", targetCurrency: "EUR", month: "2026-03" },
    { fetch, today: "2026-03-15", idempotencyKey: "inverse-import" },
  );
  expect(fetch.mock.calls[0]![0]).toBeInstanceOf(URL);
  expect((fetch.mock.calls[0]![0] as URL).pathname).toBe("/v2/rate/EUR/USD");
  expect(kernel.applyChangeSet.mock.calls[0]![0].writes[0].record_key.value).toBe(
    "EUR/USD/frankfurter",
  );
});

test("monthly imports reject the original malformed pair before canonicalizing", async () => {
  const { store, kernel } = setup();
  const fetch = vi.fn<typeof globalThis.fetch>();
  await expect(
    store.importMonthly(
      { sourceCurrency: "EUR/USD", targetCurrency: "ZZZ", month: "2026-03" },
      { fetch, today: "2026-03-15", idempotencyKey: "invalid-pair" },
    ),
  ).rejects.toThrow("Invalid currency pair");
  expect(fetch).not.toHaveBeenCalled();
  expect(kernel.applyChangeSet).not.toHaveBeenCalled();
});
