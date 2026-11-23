import { expect, test } from "vite-plus/test";
import { createDataClient, type AggregateUnit, type DataContext } from "../data";
import { DataResponseError } from "../response-decoder";

const definition = {
  formatVersion: 1,
  schemaVersion: "test",
  models: [
    {
      id: "items",
      name: "items",
      relations: [],
      fields: [
        { id: "active", name: "active", type: "bool", required: false, readOnly: false },
        { id: "amount", name: "amount", type: "number", required: false, readOnly: false },
        { id: "pay", name: "pay", type: "money_rate", required: false, readOnly: false },
        {
          id: "derivedAmount",
          name: "derivedAmount",
          type: "number",
          storage: "custom",
          required: false,
          readOnly: true,
        },
        {
          id: "derivedLabel",
          name: "derivedLabel",
          type: "text",
          storage: "custom",
          required: false,
          readOnly: true,
        },
        { id: "title", name: "title", type: "text", required: false, readOnly: false },
        {
          id: "nickname",
          name: "nickname",
          type: "text",
          storage: "custom",
          required: false,
          readOnly: false,
        },
        {
          id: "owner",
          name: "owner",
          type: "relation",
          required: false,
          readOnly: false,
          target_model: "items",
        },
      ],
    },
  ],
} as const;
function client(response: unknown) {
  const calls: Record<string, unknown>[] = [];
  const permissions: string[] = [];
  const context: DataContext = {
    scope: { appId: "test", customerId: "tenant" },
    authorize: async (permission) => {
      permissions.push(permission);
    },
    transaction: async (run) =>
      run({
        actorId: "actor",
        sourceKind: "human",
        call: async (_, input) => {
          calls.push(input);
          return response;
        },
      }),
  };
  return { api: createDataClient(definition, context).items, calls, permissions };
}
const asOf = "2026-10-24";
test("aggregate preserves typed key order and decimal precision without paging", async () => {
  const fixture = {
    as_of: "2026-10-24",
    units: [null, null],
    groups: [{ key: [true], metrics: ["12000", "9007199254740993.125"] }],
    total: { metrics: ["12000", "9007199254740993.125"] },
  };
  const { api, calls } = client(fixture);
  const result = await api.aggregate({
    asOf,
    groupBy: ["active"],
    metrics: [{ fn: "count" }, { fn: "sum", field: "amount" }],
  });
  const typed: boolean | null = result.groups[0]!.key[0];
  expect(typed).toBe(true);
  expect(result).toEqual(fixture);
  expect(calls[0]).toMatchObject({
    kind: "aggregate",
    group_by: ["active"],
    metrics: [{ fn: "count" }, { fn: "sum", field: "amount" }],
  });
  expect(calls[0]).not.toHaveProperty("limit");
});
test("count and countBy use the aggregate wire and retain their public results", async () => {
  const { api, calls, permissions } = client({
    as_of: "2026-10-24",
    units: [null],
    groups: [{ key: [null], metrics: ["12"] }],
    total: { metrics: ["12"] },
  });
  const ungrouped = client({ as_of: asOf, units: [null], groups: [], total: { metrics: ["12"] } });
  expect(
    await ungrouped.api.count({
      asOf,
      limit: 1,
      offset: 2,
      orderBy: [{ field: "amount", direction: "asc" }],
    }),
  ).toBe("12");
  expect(await api.countBy({ asOf, groupBy: "active" })).toEqual([{ value: null, count: "12" }]);
  expect(ungrouped.calls[0]).not.toHaveProperty("limit");
  expect(ungrouped.calls[0]).not.toHaveProperty("offset");
  expect(ungrouped.calls[0]).not.toHaveProperty("order_by");
  expect(calls.every((call) => call.kind === "aggregate")).toBe(true);
  expect([...ungrouped.permissions, ...permissions]).toEqual(["items.count", "items.count"]);
});
test("countBy retains SQL group ordering", async () => {
  const { api } = client({
    as_of: "2026-10-24",
    units: [null],
    groups: [
      { key: [false], metrics: ["2"] },
      { key: [null], metrics: ["1"] },
    ],
    total: { metrics: ["3"] },
  });
  expect(await api.countBy({ asOf, groupBy: "active" })).toEqual([
    { value: false, count: "2" },
    { value: null, count: "1" },
  ]);
});
test("money unit dimensions are retained and mixed-unit total can be null", async () => {
  const { api } = client({
    as_of: "2026-10-24",
    units: [null, null],
    groups: [{ key: [{ unit: { currency: "USD", period: "annual" } }], metrics: ["100", "100"] }],
    total: { metrics: [null, null] },
    other_units: "2",
  });
  const result = await api.aggregate({
    asOf,
    metrics: [
      { fn: "sum", field: "pay" },
      { fn: "avg", field: "pay" },
    ],
  });
  expect(result.groups[0]!.key[0]!.unit?.currency).toBe("USD");
  expect(result.total.metrics).toEqual([null, null]);
  expect(result.units).toEqual([null, null]);
  expect(result.other_units).toBe("2");
});
test("money bins require the excluded-unit count in the response", async () => {
  const { api } = client({ as_of: asOf, units: [null], groups: [], total: { metrics: ["0"] } });
  await expect(
    api.aggregate({
      asOf,
      groupBy: [
        { field: "pay", bins: { edges: ["0", "1"] }, unit: { currency: "USD", period: "annual" } },
      ],
      metrics: [{ fn: "count" }],
    }),
  ).rejects.toBeInstanceOf(DataResponseError);
});

test("rejects malformed metric values and undeclared bins", async () => {
  for (const metrics of [[12], ["1e3"], []]) {
    const { api } = client({ as_of: asOf, units: [null], groups: [], total: { metrics } });
    await expect(
      api.aggregate({ asOf, metrics: [{ fn: "sum", field: "amount" }] }),
    ).rejects.toBeInstanceOf(DataResponseError);
  }
  const { api } = client({
    as_of: "2026-10-24",
    units: [null],
    groups: [{ key: [{ from: "1", to: "3" }], metrics: ["2"] }],
    total: { metrics: ["2"] },
  });
  await expect(
    api.aggregate({
      asOf,
      groupBy: [{ field: "amount", bins: { edges: ["0", "1", "2"] } }],
      metrics: [{ fn: "count" }],
    }),
  ).rejects.toBeInstanceOf(DataResponseError);
});
test("validates exact decimal edges before transport", async () => {
  const { api, calls } = client({});
  await expect(
    api.aggregate({
      asOf,
      groupBy: [{ field: "amount", bins: { edges: ["9007199254740993", "9007199254740992"] } }],
      metrics: [{ fn: "count" }],
    }),
  ).rejects.toThrow();
  expect(calls).toHaveLength(0);
});

test("relation groups decode to canonical generated record keys", async () => {
  const uuid = "00000000-0000-4000-8000-000000000001";
  const { api } = client({
    as_of: asOf,
    units: [null],
    groups: [{ key: [uuid], metrics: ["1"] }],
    total: { metrics: ["1"] },
  });
  const result = await api.aggregate({ asOf, groupBy: ["owner"], metrics: [{ fn: "count" }] });
  expect(result.groups[0]!.key[0]).toEqual({ type: "record_id", value: uuid });
});

test("derived fields are grouping, bin, and metric operands", async () => {
  const { api, calls } = client({
    as_of: asOf,
    units: [null],
    groups: [{ key: ["fixed"], metrics: ["2.5"] }],
    total: { metrics: ["2.5"] },
  });
  const result = await api.aggregate({
    asOf,
    groupBy: ["derivedLabel"],
    metrics: [{ fn: "sum", field: "derivedAmount" }],
  });
  const label: string | null = result.groups[0]!.key[0];
  expect(label).toBe("fixed");
  expect(calls[0]).toMatchObject({
    kind: "aggregate",
    group_by: ["derivedLabel"],
    metrics: [{ fn: "sum", field: "derivedAmount" }],
  });
  const binned = client({
    as_of: asOf,
    units: [null],
    groups: [{ key: [{ from: "0", to: "1" }], metrics: ["1"] }],
    total: { metrics: ["1"] },
  });
  await binned.api.aggregate({
    asOf,
    groupBy: [{ field: "derivedAmount", bins: { edges: ["0", "1"] } }],
    metrics: [{ fn: "count" }],
  });
  expect(binned.calls[0]).toMatchObject({
    group_by: [{ field: "derivedAmount", bins: { edges: ["0", "1"] } }],
  });
});

test("malformed group entries return contract validation errors before transport", async () => {
  const { api, calls } = client({});
  for (const group of [null, 1, false, []]) {
    await expect(
      // @ts-expect-error deliberately malformed group
      api.aggregate({ asOf, groupBy: [group], metrics: [{ fn: "count" }] }),
    ).rejects.toThrow("contract_validation_failed");
  }
  expect(calls).toHaveLength(0);
});

// These calls are checked by tsc without making invalid transport requests.
function typeChecks(api: ReturnType<typeof client>["api"]) {
  // @ts-expect-error boolean fields do not support numeric metrics
  api.aggregate({ asOf, metrics: [{ fn: "sum", field: "active" }] });
  api.aggregate({ asOf, groupBy: ["amount"], metrics: [{ fn: "count" }] });
  api.aggregate({
    asOf,
    // @ts-expect-error money bins require an explicit unit
    groupBy: [{ field: "pay", bins: { edges: ["0", "1"] } }],
    metrics: [{ fn: "count" }],
  });
  // @ts-expect-error percentile requires a probability
  api.aggregate({ asOf, metrics: [{ fn: "percentile", field: "amount" }] });
}
void typeChecks;

test("optional grouping keeps both possible key layouts in the result type", async () => {
  const unitKey = { unit: { currency: "USD", period: "annual" } };
  const run = (groupBy?: readonly ["active"]) =>
    client({
      as_of: asOf,
      units: [null],
      groups: [{ key: groupBy ? [true, unitKey] : [unitKey], metrics: ["100"] }],
      total: { metrics: ["100"] },
    }).api.aggregate({ asOf, groupBy, metrics: [{ fn: "sum", field: "pay" }] });
  const ungrouped = await run();
  const first = ungrouped.groups[0]!.key[0];
  // @ts-expect-error the first key may be the appended money unit when groupBy is omitted
  const flag: boolean | null = first;
  void flag;
  const layout:
    | [boolean | null, { unit: AggregateUnit | null }]
    | [{ unit: AggregateUnit | null }] = ungrouped.groups[0]!.key;
  expect(layout).toEqual([unitKey]);
  expect((await run(["active"])).groups[0]!.key).toEqual([true, unitKey]);
});

test("aggregate retains a single money unit in the header", async () => {
  const fixture = {
    as_of: asOf,
    units: [{ currency: "USD", period: "annual" }],
    groups: [],
    total: { metrics: ["100"] },
  };
  const { api } = client(fixture);
  const result = await api.aggregate({ asOf, metrics: [{ fn: "sum", field: "pay" }] });
  expect(result).toEqual(fixture);
  const unit: { currency: string; period: string } | null = result.units[0];
  expect(unit?.currency).toBe("USD");
});

test("aggregate rejects missing or invalid response headers", async () => {
  for (const header of [
    {},
    { as_of: asOf },
    { as_of: "invalid", units: [null] },
    { as_of: asOf, units: [] },
    { as_of: asOf, units: [{ currency: "USD", period: "annual" }] },
  ]) {
    const { api } = client({ ...header, groups: [], total: { metrics: ["0"] } });
    await expect(api.aggregate({ asOf, metrics: [{ fn: "count" }] })).rejects.toBeInstanceOf(
      DataResponseError,
    );
  }
});

test("search accepts stored text fields and rejects custom-field storage before transport", async () => {
  const { api, calls } = client({
    as_of: asOf,
    units: [null],
    groups: [],
    total: { metrics: ["1"] },
  });
  expect(await api.count({ asOf, search: { query: "ada", fields: ["title"] } })).toBe("1");
  expect(calls[0]).toMatchObject({ search: { query: "ada", fields: ["title"] } });
  await expect(
    // @ts-expect-error kernel_data_query does not search custom-field storage
    api.count({ asOf, search: { query: "ada", fields: ["nickname"] } }),
  ).rejects.toThrow("contract_validation_failed");
  expect(calls).toHaveLength(1);
});
