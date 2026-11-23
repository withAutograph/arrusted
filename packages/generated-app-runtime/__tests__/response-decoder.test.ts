import { describe, expect, test } from "vitest";
import {
  createDataClient,
  type DataContext,
  type DataDefinition,
  type DataField,
  type DataModel,
} from "../data";
import { createResponseDecoder, DataResponseError, responseFieldValue } from "../response-decoder";

const nilUuid = "00000000-0000-0000-0000-000000000000";
const v7Uuid = "018f4e70-0000-7000-8000-000000000000";
const field = (overrides: Partial<DataField> = {}): DataField => ({
  id: "title",
  name: "title",
  type: "text",
  required: false,
  readOnly: false,
  ...overrides,
});
const model: DataModel = {
  id: "asset",
  name: "asset",
  fields: [
    field({ id: "title", name: "title", required: true }),
    field({ id: "custom", name: "custom", storage: "custom" }),
  ],
  relations: [],
};
const decoder = createResponseDecoder({
  fieldsByModel: new Map([[model.id, new Map(model.fields.map((entry) => [entry.id, entry]))]]),
  supportsVersionPreconditions: true,
});

// Project count assertions through the aggregate decoder's only wire contract.
function decodeGroupedCount(
  target: ReturnType<typeof createResponseDecoder>,
  field: DataField,
  groups: readonly { value: unknown; count: unknown; [key: string]: unknown }[],
) {
  return target
    .decodeAggregate([{ field }], [{ fn: "count" }], {
      as_of: "2026-10-24",
      units: [null],
      groups: groups.map(({ value, count, ...extra }) => ({
        key: [value],
        metrics: [count],
        ...extra,
      })),
      total: { metrics: ["0"] },
    })
    .groups.map((group) => ({ value: group.key[0], count: group.metrics[0] }));
}
function decodeCount(value: unknown) {
  return decoder.decodeAggregate([], [{ fn: "count" }], {
    as_of: "2026-10-24",
    units: [null],
    groups: [],
    total: { metrics: [value] },
  }).total.metrics[0];
}

const responseError = (run: () => unknown): void => {
  expect(run).toThrow(DataResponseError);
};

describe("response field values", () => {
  test.each([
    ["text", { type: "text", value: "hello" }, { type: "text", value: "hello" }],
    [
      "number",
      { type: "number", value: "-12345678901234567890.000001" },
      { type: "number", value: "-12345678901234567890.000001" },
    ],
    ["bool", { type: "bool", value: false }, { type: "bool", value: false }],
    ["date", { type: "date", value: "2028-02-29" }, { type: "date", value: "2028-02-29" }],
    [
      "datetime",
      { type: "datetime", value: "2028-02-29T23:59:59+00:00" },
      { type: "datetime", value: "2028-02-29T23:59:59+00:00" },
    ],
    ["enum", { type: "enum", value: "retired-option" }, { type: "enum", value: "retired-option" }],
    [
      "text_list",
      { type: "text_list", value: ["one", "two"] },
      { type: "text_list", value: ["one", "two"] },
    ],
    [
      "json",
      { type: "json", value: { nested: [1, null, true] } },
      { type: "json", value: { nested: [1, null, true] } },
    ],
    [
      "relation",
      { type: "relation", value: { type: "record_id", value: v7Uuid } },
      { type: "relation", value: { type: "record_id", value: v7Uuid } },
    ],
    [
      "relation_list",
      {
        type: "relation_list",
        value: [
          { type: "record_id", value: nilUuid },
          { type: "external_key", value: "legacy-key" },
        ],
      },
      {
        type: "relation_list",
        value: [
          { type: "record_id", value: nilUuid },
          { type: "external_key", value: "legacy-key" },
        ],
      },
    ],
    [
      "money_rate",
      {
        type: "money_rate",
        value: { amount: "999999999999999999.0100", currency: "USD", period: "hourly" },
      },
      {
        type: "money_rate",
        value: { amount: "999999999999999999.0100", currency: "USD", period: "hourly" },
      },
    ],
    [
      "schema_lifecycle",
      { type: "schema_lifecycle", value: "retired" },
      { type: "schema_lifecycle", value: "retired" },
    ],
  ] as const)("decodes %s", (_name, wire, expected) => {
    expect(responseFieldValue("test", "response.value", wire)).toEqual(expected);
  });

  test.each([
    { type: "number", value: "1e3" },
    { type: "bool", value: "false" },
    { type: "date", value: "2027-02-30" },
    { type: "datetime", value: "2027-02-30T10:00:00Z" },
    { type: "text_list", value: ["valid", 1] },
    { type: "relation", value: { type: "record_id", value: "not-a-uuid" } },
    { type: "relation_list", value: [{ type: "external_key", value: "" }] },
    { type: "money_rate", value: { amount: "1.2.3", currency: "USD", period: "yearly" } },
    { type: "schema_lifecycle", value: "removed" },
  ])("rejects invalid %#", (wire) =>
    responseError(() => responseFieldValue("test", "response.value", wire)),
  );

  test("does not include private response content in diagnostics", () => {
    const privateKey = "__private_response_key__";
    const privateValue = "__private_response_value__";
    for (const wire of [
      { type: "text", value: "ok", [privateKey]: privateValue },
      { type: "text", value: privateValue, [privateKey]: "unexpected" },
    ]) {
      let error: unknown;
      try {
        responseFieldValue("test", "response.value", wire);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(DataResponseError);
      expect(String(error)).not.toContain(privateKey);
      expect(String(error)).not.toContain(privateValue);
    }
  });
});

describe("response envelopes", () => {
  test("distinguishes required, nullable, retired, and custom field values", () => {
    const required = field({ required: true });
    const optional = field({ required: false });
    const retired = field({ required: true, lifecycle: "retired" });
    responseError(() => decodeGroupedCount(decoder, required, [{ value: null, count: "1" }]));
    expect(decodeGroupedCount(decoder, optional, [{ value: null, count: "1" }])).toEqual([
      { value: null, count: "1" },
    ]);
    expect(decodeGroupedCount(decoder, retired, [{ value: null, count: "1" }])).toEqual([
      { value: null, count: "1" },
    ]);

    responseError(() =>
      decodeGroupedCount(decoder, field({ type: "relation", required: true }), [
        { value: null, count: "1" },
      ]),
    );
    expect(
      decodeGroupedCount(decoder, field({ type: "relation", required: false }), [
        { value: null, count: "1" },
      ]),
    ).toEqual([{ value: null, count: "1" }]);

    const full = decoder.decodeRecord(model, {
      record_id: nilUuid,
      version_id: v7Uuid,
      external_key: null,
      effective_start: "2027-01-01",
      effective_end: null,
      values: { title: { type: "text", value: "asset" } },
      custom_fields: [],
      metadata: {},
      many_relations: {},
    });
    expect(full.custom).toBeNull();
    responseError(() =>
      decoder.decodeRecord(model, {
        record_id: nilUuid,
        version_id: v7Uuid,
        external_key: null,
        effective_start: "2027-01-01",
        effective_end: null,
        values: {},
        custom_fields: [],
        metadata: {},
        many_relations: {},
      }),
    );
  });

  test("allows selected omissions but requires selected identifiers", () => {
    expect(
      decoder.decodeRecord(model, { values: { title: { type: "text", value: "asset" } } }, [
        "title",
      ]),
    ).toEqual({ title: "asset" });
    responseError(() => decoder.decodeRecord(model, {}, ["id"]));
    responseError(() => decoder.decodeRecord(model, {}, ["externalKey"]));
    expect(decoder.decodeRecord(model, { external_key: null }, ["externalKey"])).toEqual({
      externalKey: null,
    });
  });

  test("retains declared retired enum options in reads and grouped counts", () => {
    const status = field({
      id: "status",
      name: "status",
      type: "enum",
      required: true,
      option_set: [
        { id: "active-option", lifecycle: "active" },
        { id: "retired-option", lifecycle: "retired" },
      ],
    });
    const enumModel: DataModel = { ...model, fields: [...model.fields, status] };
    const enumDecoder = createResponseDecoder({
      fieldsByModel: new Map([
        [enumModel.id, new Map(enumModel.fields.map((entry) => [entry.id, entry]))],
      ]),
      supportsVersionPreconditions: true,
    });
    const full = enumDecoder.decodeRecord(enumModel, {
      record_id: nilUuid,
      version_id: v7Uuid,
      external_key: null,
      effective_start: "2027-01-01",
      effective_end: null,
      values: {
        title: { type: "text", value: "asset" },
        status: { type: "enum", value: "retired-option" },
      },
      custom_fields: [],
      metadata: {},
      many_relations: {},
    });
    expect(full.status).toBe("retired-option");
    expect(
      enumDecoder.decodeRecord(
        enumModel,
        { values: { status: { type: "enum", value: "retired-option" } } },
        ["status"],
      ),
    ).toEqual({ status: "retired-option" });
    expect(
      decodeGroupedCount(enumDecoder, status, [{ value: "retired-option", count: "2" }]),
    ).toEqual([{ value: "retired-option", count: "2" }]);
    responseError(() =>
      enumDecoder.decodeRecord(enumModel, {
        record_id: nilUuid,
        version_id: v7Uuid,
        external_key: null,
        effective_start: "2027-01-01",
        effective_end: null,
        values: {
          title: { type: "text", value: "asset" },
          status: { type: "enum", value: "undeclared-option" },
        },
        custom_fields: [],
        metadata: {},
        many_relations: {},
      }),
    );
    responseError(() =>
      decodeGroupedCount(enumDecoder, status, [{ value: "undeclared-option", count: "1" }]),
    );
  });

  test("enforces pinned ISO code membership only for current declared values", () => {
    const country = field({ id: "country", name: "country", type: "iso_country" });
    const currency = field({
      id: "currency",
      name: "currency",
      type: "iso_currency",
      storage: "custom",
    });
    const codeModel: DataModel = { ...model, fields: [...model.fields, country, currency] };
    const codeDecoder = createResponseDecoder({
      fieldsByModel: new Map([
        [codeModel.id, new Map(codeModel.fields.map((entry) => [entry.id, entry]))],
      ]),
      supportsVersionPreconditions: true,
    });
    const full = codeDecoder.decodeRecord(codeModel, {
      record_id: nilUuid,
      version_id: v7Uuid,
      external_key: null,
      effective_start: "2027-01-01",
      effective_end: null,
      values: {
        title: { type: "text", value: "asset" },
        country: { type: "text", value: "US" },
      },
      custom_fields: [{ field_id: "currency", type: "text", value: "USD" }],
      metadata: {},
      many_relations: {},
    });
    expect(full).toMatchObject({ country: "US", currency: "USD" });
    expect(
      codeDecoder.decodeRecord(codeModel, { values: { country: { type: "text", value: "US" } } }, [
        "country",
      ]),
    ).toEqual({ country: "US" });
    expect(
      codeDecoder.decodeRecord(
        codeModel,
        { custom_fields: [{ field_id: "currency", type: "text", value: "USD" }] },
        ["currency"],
      ),
    ).toEqual({ currency: "USD" });
    expect(decodeGroupedCount(codeDecoder, country, [{ value: "US", count: "2" }])).toEqual([
      { value: "US", count: "2" },
    ]);
    expect(decodeGroupedCount(codeDecoder, currency, [{ value: "USD", count: "2" }])).toEqual([
      { value: "USD", count: "2" },
    ]);
    responseError(() =>
      codeDecoder.decodeRecord(codeModel, {
        record_id: nilUuid,
        version_id: v7Uuid,
        external_key: null,
        effective_start: "2027-01-01",
        effective_end: null,
        values: {
          title: { type: "text", value: "asset" },
          country: { type: "text", value: "ZZ" },
        },
        custom_fields: [{ field_id: "currency", type: "text", value: "XTS" }],
        metadata: {},
        many_relations: {},
      }),
    );
    responseError(() => decodeGroupedCount(codeDecoder, country, [{ value: "ZZ", count: "1" }]));
    responseError(() => decodeGroupedCount(codeDecoder, currency, [{ value: "XTS", count: "1" }]));
    expect(
      codeDecoder.decodeHistory([
        {
          version_id: nilUuid,
          change_set_id: 1,
          stage: "mainline",
          effective_start: "2027-01-01",
          field_id: "country",
          withheld: false,
          tombstones_record: false,
          untombstones_record: false,
          source_kind: "ui",
          value: { type: "text", value: "ZZ" },
        },
      ]),
    ).toMatchObject([{ value: { type: "text", value: "ZZ" } }]);
  });

  test("checks count bounds, group shapes, safe IDs, and consumed active-revision fields", () => {
    expect(decodeCount("18446744073709551616")).toBe("18446744073709551616");
    responseError(() => decodeCount("-1"));
    responseError(() =>
      decodeGroupedCount(
        decoder,
        field(),
        Array.from({ length: 101 }, () => ({ value: "x", count: "1" })),
      ),
    );
    responseError(() =>
      decodeGroupedCount(decoder, field(), [{ value: "x", count: "1", private: true }]),
    );
    const schema = { version: "v1", unrelated_metadata: { allowed: true } };
    const effectiveHash = "a".repeat(64);
    expect(
      decoder.decodeActiveRevision({
        schema_revision_id: "9223372036854775807",
        schema,
        effective_hash: effectiveHash,
        unrelated_metadata: { allowed: true },
      }),
    ).toEqual({
      schema_revision_id: "9223372036854775807",
      schemaVersion: "v1",
      schema,
      effectiveHash,
    });
    responseError(() =>
      decoder.decodeActiveRevision({ schema_revision_id: "0", schema: { version: "v1" } }),
    );
    responseError(() =>
      decoder.decodeReceipt({ id: Number.MAX_SAFE_INTEGER + 1, schema_revision_id: "1" }),
    );
  });

  test("hydrates history structurally without current field membership validation", () => {
    const history = decoder.decodeHistory([
      {
        version_id: nilUuid,
        change_set_id: 1,
        stage: "mainline",
        effective_start: "2027-01-01",
        field_id: "retired-field",
        withheld: false,
        tombstones_record: false,
        untombstones_record: false,
        source_kind: "ui",
        value: { type: "enum", value: "retired-option" },
        enum_value: {
          option_id: "retired-option",
          event_schema_revision_id: 1,
          event_label: "Retired option",
          current_label: null,
        },
      },
      {
        version_id: v7Uuid,
        change_set_id: 2,
        stage: "reverted",
        effective_start: "2027-02-01",
        field_id: "retired-field",
        withheld: false,
        tombstones_record: false,
        untombstones_record: false,
        source_kind: "ui",
        enum_value: null,
      },
    ]);
    expect(history[0]?.enum_value).toMatchObject({
      option_id: "retired-option",
      event_schema_revision_id: "1",
      current_label: null,
    });
    expect(history[1]?.enum_value).toBeNull();
    expect(history[0]).toMatchObject({
      withheld: false,
      tombstones_record: false,
      untombstones_record: false,
      source_kind: "ui",
    });
    expect(
      decoder.decodeHistory([
        {
          version_id: nilUuid,
          change_set_id: 3,
          stage: "mainline",
          effective_start: "2027-03-01",
          field_id: "status",
          withheld: false,
          tombstones_record: true,
          untombstones_record: false,
          actor_id: "importer",
          source_kind: "import",
          source_ref: "payroll.csv",
          applied_at: "2027-03-02T09:30:00Z",
          notes: null,
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        tombstones_record: true,
        actor_id: "importer",
        source_ref: "payroll.csv",
        applied_at: "2027-03-02T09:30:00Z",
        notes: null,
      }),
    ]);
    for (const malformed of [
      { tombstones_record: "yes" },
      { source_kind: undefined },
      { applied_at: "yesterday" },
    ])
      responseError(() =>
        decoder.decodeHistory([
          {
            version_id: nilUuid,
            change_set_id: 3,
            stage: "mainline",
            effective_start: "2027-03-01",
            field_id: "status",
            withheld: false,
            tombstones_record: false,
            untombstones_record: false,
            source_kind: "ui",
            ...malformed,
          },
        ]),
      );
    responseError(() =>
      decoder.decodeHistory([
        {
          version_id: nilUuid,
          change_set_id: 1,
          stage: "mainline",
          effective_start: "2027-01-01",
          field_id: "status",
          withheld: false,
          tombstones_record: false,
          untombstones_record: false,
          source_kind: "ui",
          value: { type: "enum", value: "retired-option" },
          enum_value: { option_id: "other", event_schema_revision_id: "1", event_label: "Other" },
        },
      ]),
    );
    responseError(() =>
      decoder.decodeHistory([
        {
          version_id: nilUuid,
          change_set_id: 1,
          stage: "mainline",
          effective_start: "2027-01-01",
          field_id: "status",
          withheld: false,
          tombstones_record: false,
          untombstones_record: false,
          source_kind: "ui",
          enum_value: {
            option_id: "retired-option",
            event_schema_revision_id: 1.5,
            event_label: "Retired",
          },
        },
      ]),
    );
  });
});

test("keeps malformed write inputs separate from malformed transport responses", async () => {
  const inputDefinition = {
    formatVersion: 1,
    schemaVersion: "input-validation-v1",
    models: [
      {
        id: "asset",
        name: "asset",
        fields: [
          field({ id: "changed-at", name: "changedAt", type: "datetime" }),
          field({ id: "lifecycle", name: "lifecycle", type: "schema_lifecycle" }),
        ],
        relations: [],
      },
    ],
  } as const satisfies DataDefinition;
  const context = (call: (operation: string) => Promise<unknown>): DataContext => ({
    scope: { appId: "input-validation", customerId: "customer" },
    authorize: async () => {},
    transaction: async (run) =>
      run({ actorId: "actor", sourceKind: "human", call: (operation) => call(operation) }),
  });
  const inputClient = createDataClient(
    inputDefinition,
    context(async (operation) => {
      if (operation === "kernel_read_active_schema_revision")
        return { schema_revision_id: "1", schema: { version: inputDefinition.schemaVersion } };
      throw new Error(`unexpected ${operation}`);
    }),
  );

  for (const values of [{ changedAt: "2027-02-30T10:00:00Z" }, { lifecycle: "removed" }]) {
    const error = await inputClient.asset
      .create(values, { effectiveStart: "2027-01-01", idempotencyKey: JSON.stringify(values) })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(String(error)).toContain("contract_validation_failed");
    expect(error).not.toBeInstanceOf(DataResponseError);
  }

  const privateSentinel = "__private_transport_value__";
  const responseClient = createDataClient(
    inputDefinition,
    context(async (operation) => {
      if (operation === "kernel_data_query") return [{ [privateSentinel]: privateSentinel }];
      throw new Error(`unexpected ${operation}`);
    }),
  );
  const malformedResponse = await responseClient.asset.list({ asOf: "2027-01-01" }).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(malformedResponse).toBeInstanceOf(DataResponseError);
  expect(String(malformedResponse)).not.toContain(privateSentinel);
});

test("renamed fields read the same storage value through old and new names", async () => {
  const renamedModel = {
    id: "note",
    name: "note",
    relations: [],
    fields: [
      { id: "title", name: "heading", type: "text", required: true, readOnly: false },
      {
        id: "title",
        name: "title",
        type: "text",
        required: true,
        readOnly: true,
        aliasOf: "heading",
      },
    ],
  } as const;
  const requests: unknown[] = [];
  const context: DataContext = {
    scope: { appId: "test", customerId: "tenant" },
    authorize: async () => {},
    transaction: async (run) =>
      run({
        actorId: "actor",
        sourceKind: "human",
        call: async (_operation, input) => {
          requests.push(input);
          return [{ values: { title: { type: "text", value: "Retained text" } } }];
        },
      }),
  };
  const client = createDataClient(
    { formatVersion: 1, schemaVersion: "v2", models: [renamedModel] } as const,
    context,
  );
  expect(await client.note.list({ asOf: "2026-11-18", select: ["heading", "title"] })).toEqual([
    { heading: "Retained text", title: "Retained text" },
  ]);
  expect(requests[0]).toMatchObject({ select: ["title"] });
});
