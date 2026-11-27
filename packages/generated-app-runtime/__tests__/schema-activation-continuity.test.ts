import { expect, test, vi } from "vite-plus/test";
import {
  createDataClient,
  DataFieldActivationPendingError,
  type DataContext,
  type DataDefinition,
  type DataSession,
} from "../data";

const recordId = "00000000-0000-0000-0000-000000000001";
const asOf = "2026-11-13";
const scope = { appId: "shelf", customerId: "authorized-tenant" };
const priorArtifactHash = "a".repeat(64);
const oldField = {
  id: "label",
  name: "label",
  type: "text",
  required: true,
  readOnly: false,
} as const;
const addedField = {
  id: "note",
  name: "note",
  type: "text",
  required: false,
  readOnly: false,
} as const;
const priorSchema = {
  app_id: scope.appId,
  customer_id: "local-demo",
  version: "v3",
  models: [{ id: "item", fields: [{ id: "label", type: "text", required: true }] }],
};
const definition = {
  formatVersion: 1,
  schemaVersion: "v4",
  models: [{ id: "item", name: "item", fields: [oldField, addedField], relations: [] }],
  predecessorCompatibility: {
    kind: "optional-text-addition-v1",
    predecessors: [
      {
        schema: priorSchema,
        artifactSha256: priorArtifactHash,
        field: { modelId: "item", fieldId: "note" },
      },
    ],
  },
} as const satisfies DataDefinition;

function fixture() {
  const calls: { operation: string; input: Record<string, unknown> }[] = [];
  const receipts = new Map<string, { id: number; schema_revision_id: string }>();
  let current = {
    schema_revision_id: "3",
    effective_hash: priorArtifactHash,
    schema: { ...priorSchema, customer_id: scope.customerId },
  };
  const authorize = vi.fn(async (_capability: string) => {});
  const context: DataContext = {
    scope,
    authorize,
    transaction: <T>(run: (session: DataSession) => Promise<T>) => {
      let locked = false;
      return run({
        actorId: "authorized-actor",
        sourceKind: "human",
        lockSchemaActivation: async () => {
          locked = true;
        },
        call: async (operation, input) => {
          expect(locked).toBe(true);
          calls.push({ operation, input: structuredClone(input) });
          if (operation === "kernel_read_active_schema_revision") return structuredClone(current);
          if (operation === "kernel_data_query") {
            expect(input.schema_version).toBe(current.schema.version);
            const selected = input.select as string[];
            const activeFields = current.schema.models[0]?.fields.map(({ id }) => id) ?? [];
            expect(selected.every((field) => field === "$id" || activeFields.includes(field))).toBe(
              true,
            );
            const values = Object.fromEntries([
              ...(selected.includes("label")
                ? [["label", { type: "text", value: "Old label" }]]
                : []),
              ...(selected.includes("note") ? [["note", { type: "text", value: "New note" }]] : []),
            ]);
            return [{ ...(selected.includes("$id") ? { record_id: recordId } : {}), values }];
          }
          if (operation === "kernel_apply_change_set") {
            const key = String(input.idempotency_key);
            const existing = receipts.get(key);
            if (existing) return existing;
            const receipt = {
              id: receipts.size + 1,
              schema_revision_id: current.schema_revision_id,
            };
            receipts.set(key, receipt);
            return receipt;
          }
          throw new Error(`unexpected operation ${operation}`);
        },
      });
    },
  };
  return {
    calls,
    authorize,
    operations: createDataClient(definition, context),
    setActive: (observed: Partial<typeof current>) => {
      current = { ...current, ...observed };
    },
    activate: () => {
      current = {
        schema_revision_id: "4",
        effective_hash: "b".repeat(64),
        schema: {
          ...priorSchema,
          version: "v4",
          customer_id: scope.customerId,
          models: [
            {
              id: "item",
              fields: [
                ...priorSchema.models[0]!.fields,
                { id: "note", type: "text", required: false },
              ],
            },
          ],
        },
      };
    },
  };
}

test("reads old rows through the exact predecessor and returns null for the pending optional field", async () => {
  const { operations, calls, authorize, activate } = fixture();
  await expect(operations.item.list({ asOf, select: ["id", "label", "note"] })).resolves.toEqual([
    { id: recordId, label: "Old label", note: null },
  ]);
  await expect(
    operations.item.get({ asOf, key: { type: "record_id", value: recordId }, select: ["note"] }),
  ).resolves.toEqual({ note: null });
  expect(calls[1]?.input).toMatchObject({ schema_version: "v3", select: ["$id", "label"] });
  expect(calls[3]?.input).toMatchObject({ schema_version: "v3", select: ["$id"] });
  expect(authorize.mock.calls.map(([capability]) => capability)).toEqual(["item.list", "item.get"]);
  activate();
  await expect(operations.item.list({ asOf, select: ["note"] })).resolves.toEqual([
    { note: "New note" },
  ]);
  expect(calls[5]?.input).toMatchObject({ schema_version: "v4", select: ["note"] });
});

test("reports readiness for authorized writes without changing records", async () => {
  const { operations, calls, authorize, activate } = fixture();
  await expect(
    operations.item.fieldActivation({ field: "note", operation: "create" }),
  ).resolves.toBe("pending");
  await expect(
    operations.item.fieldActivation({ field: "label", operation: "update" }),
  ).resolves.toBe("active");

  activate();
  await expect(
    operations.item.fieldActivation({ field: "note", operation: "create" }),
  ).resolves.toBe("active");
  expect(authorize.mock.calls).toEqual([["item.create"], ["item.update"], ["item.create"]]);
  expect(calls).toEqual(
    Array.from({ length: 3 }, () => ({
      operation: "kernel_read_active_schema_revision",
      input: {},
    })),
  );
});

test("checks operation authorization before observing field readiness", async () => {
  const { operations, calls, authorize } = fixture();
  authorize.mockRejectedValueOnce(new Error("update denied"));
  await expect(
    operations.item.fieldActivation({ field: "note", operation: "update" }),
  ).rejects.toThrow("update denied");
  expect(authorize).toHaveBeenCalledExactlyOnceWith("item.update");
  expect(calls).toEqual([]);
});

test("preserves old writes and their exact replay across activation, and keeps new values pending", async () => {
  const { operations, calls, authorize, activate } = fixture();
  const apply = (idempotencyKey: string, note?: string) =>
    operations.apply({
      effectiveStart: asOf,
      idempotencyKey,
      writes: [
        operations.item.writes.create(
          { label: "Socket", ...(note === undefined ? {} : { note }) },
          { id: recordId },
        ),
      ],
    });
  const prior = await apply("same-request");
  expect(prior).toEqual({ id: 1, schema_revision_id: "3" });
  await expect(apply("pending-request", "Keep this note")).rejects.toBeInstanceOf(
    DataFieldActivationPendingError,
  );
  await expect(
    operations.item.update(
      recordId,
      {},
      { effectiveStart: asOf, idempotencyKey: "pending-clear", clear: ["note"] },
    ),
  ).rejects.toBeInstanceOf(DataFieldActivationPendingError);
  expect(calls.filter(({ operation }) => operation === "kernel_apply_change_set")).toHaveLength(1);
  expect(authorize).toHaveBeenCalledWith("item.create");
  expect(authorize).toHaveBeenCalledWith("item.update");
  activate();
  await expect(apply("same-request")).resolves.toEqual(prior);
  await expect(apply("pending-request", "Keep this note")).resolves.toEqual({
    id: 2,
    schema_revision_id: "4",
  });
  const writes = calls.filter(({ operation }) => operation === "kernel_apply_change_set");
  expect(writes[0]?.input).toEqual(writes[1]?.input);
  expect(writes[0]?.input).not.toHaveProperty("schema_revision_id");
  expect(writes[2]?.input).toMatchObject({
    writes: [{ values: { note: { type: "text", value: "Keep this note" } } }],
  });
});

test("does not use a pending field for filtering or ranking", async () => {
  const { operations, calls } = fixture();
  await expect(
    operations.item.list({ asOf, where: [{ field: "note", op: "eq", value: "a" }] }),
  ).rejects.toBeInstanceOf(DataFieldActivationPendingError);
  await expect(
    operations.item.list({ asOf, orderBy: [{ field: "note", direction: "asc" }] }),
  ).rejects.toBeInstanceOf(DataFieldActivationPendingError);
  await expect(operations.item.countBy({ asOf, groupBy: "note" })).rejects.toBeInstanceOf(
    DataFieldActivationPendingError,
  );
  expect(calls.every(({ operation }) => operation === "kernel_read_active_schema_revision")).toBe(
    true,
  );
});

test.each([
  { effective_hash: "b".repeat(64) },
  { schema: { ...priorSchema, customer_id: "another-tenant" } },
  { schema: { ...priorSchema, customer_id: scope.customerId, app_id: "another-app" } },
  { schema: { ...priorSchema, customer_id: scope.customerId, models: [] } },
])("fails closed for a different predecessor artifact or scope", async (different) => {
  const { operations, calls, setActive } = fixture();
  setActive(different);
  await expect(operations.item.list({ asOf, select: ["note"] })).rejects.toThrow(
    "does not match active artifact",
  );
  await expect(
    operations.item.fieldActivation({ field: "note", operation: "create" }),
  ).rejects.toThrow("does not match active artifact");
  expect(calls.map(({ operation }) => operation)).toEqual([
    "kernel_read_active_schema_revision",
    "kernel_read_active_schema_revision",
  ]);
});

test("sibling additive successor continuity allows an installed prior revision across additive changes and rejects fabricated or non-additive revisions", async () => {
  const v1Def = {
    formatVersion: 1,
    schemaVersion: "v3",
    models: [
      {
        id: "item",
        name: "item",
        fields: [
          oldField,
          {
            id: "legacy_archived",
            name: "legacyArchived",
            type: "text",
            lifecycle: "retired",
            required: false,
            readOnly: false,
          },
        ],
        relations: [],
      },
    ],
  } as const satisfies DataDefinition;

  let active = {
    schema_revision_id: "4",
    effective_hash: "b".repeat(64),
    schema: {
      app_id: scope.appId,
      customer_id: scope.customerId,
      version: "v4",
      models: [
        {
          id: "item",
          fields: [
            { id: "label", type: "text", required: true },
            { id: "note", type: "text", required: false },
          ],
        },
      ],
    },
  };
  let releases: unknown[] = [
    {
      schema_revision_id: 3,
      effective_revision: "v3",
      base_revision: "v3",
      release_id: "v3",
      timestamps: { ready_at: "2026-11-13T00:00:00Z" },
    },
    {
      schema_revision_id: 4,
      effective_revision: "v4",
      base_revision: "v4",
      release_id: "v4",
      timestamps: { ready_at: "2026-11-13T01:00:00Z" },
    },
  ];

  const queryInputs: Record<string, unknown>[] = [];
  const versionId = "20000000-0000-4000-8000-000000000002";

  const makeClient = (def: DataDefinition) =>
    createDataClient(def, {
      scope,
      authorize: async () => {},
      transaction: (run) =>
        run({
          actorId: "authorized-actor",
          sourceKind: "human",
          call: async (operation, input) => {
            if (operation === "kernel_read_active_schema_revision") return structuredClone(active);
            if (operation === "kernel_read_runtime_release_observability") return { releases };
            if (operation === "kernel_data_query") {
              queryInputs.push(structuredClone(input));
              if (input.schema_version !== active.schema.version) {
                const { KernelFailure } = await import("../../kernel-client/postgres");
                throw new KernelFailure({
                  code: "schema_drift",
                  message: "Schema drift detected",
                });
              }
              if (Array.isArray(input.select) && input.select.includes("$effectiveStart")) {
                return [
                  {
                    record_id: recordId,
                    version_id: versionId,
                    external_key: null,
                    effective_start: asOf,
                    effective_end: null,
                    metadata: {},
                    values: { label: { type: "text", value: "Kept" } },
                  },
                ];
              }
              return [{ record_id: recordId, values: { label: { type: "text", value: "Kept" } } }];
            }
            if (operation === "kernel_apply_change_set") {
              return { id: 1, schema_revision_id: active.schema_revision_id };
            }
            if (operation === "kernel_work_session") {
              if (input.schema_version !== active.schema.version) {
                if (
                  input.operation !== "get" &&
                  input.operation !== "list" &&
                  input.operation !== "entries"
                ) {
                  // Simulate protectedHttpRequest durable mutationQueue poisoning if a work-session mutation ever sends a stale schema_version!
                  throw new Error("poisoned_http_mutation_queue");
                }
                const { KernelFailure } = await import("../../kernel-client/postgres");
                throw new KernelFailure({
                  code: "schema_drift",
                  message: "Schema drift detected",
                });
              }
              if (input.operation === "create") {
                return { revision: 1, session_id: String(input.session_id) };
              }
              if (input.operation === "get") {
                return {
                  id: String(input.session_id),
                  owner_id: "authorized-actor",
                  title: "Additive Session",
                  as_of: asOf,
                  scope: null,
                  layout: null,
                  pinned: false,
                  status: "open",
                  revision: 7,
                  rules: {},
                  threads: {},
                };
              }
              return [];
            }
            throw new Error(`unexpected ${operation}`);
          },
        }),
    });

  // 1. Installed prior v3 client reads (both selected AND unselected full ModelRecord!) & writes seamlessly when v4 is additive
  const v1Ops = makeClient(v1Def);
  await expect(v1Ops.item!.list({ asOf, select: ["id", "label"] })).resolves.toEqual([
    { id: recordId, label: "Kept" },
  ]);
  queryInputs.length = 0;
  const fullRecords = await v1Ops.item!.list({ asOf });
  expect(queryInputs[1]?.select).toEqual([
    "$id",
    "$externalKey",
    "$version",
    "$effectiveStart",
    "$effectiveEnd",
    "$metadata",
    "label",
  ]);
  expect(fullRecords).toMatchObject([
    {
      id: recordId,
      externalKey: null,
      effectiveStart: asOf,
      effectiveEnd: null,
      label: "Kept",
    },
  ]);
  // Full record returned by unselected additive retry carries provenance branding for update()!
  await expect(
    v1Ops.item!.update(
      fullRecords[0]!,
      { label: "Updated via branded full record" },
      { effectiveStart: asOf, idempotencyKey: "k-full-update" },
    ),
  ).resolves.toEqual({ id: 1, schema_revision_id: "4" });
  await expect(
    v1Ops.item!.create(
      { label: "Written from v3" },
      { effectiveStart: asOf, idempotencyKey: "k1" },
    ),
  ).resolves.toEqual({ id: 1, schema_revision_id: "4" });
  await expect(v1Ops.workSessions.request({ operation: "list" })).resolves.toEqual([]);
  await expect(
    v1Ops.workSessions.request({
      operation: "get",
      session_id: recordId,
      overlay: false,
    }),
  ).resolves.toMatchObject({ id: recordId, revision: 7 });
  await expect(
    v1Ops.workSessions.request({
      operation: "create",
      expected_revision: 0,
      request_id: "req-ws-1",
      session_id: recordId,
      title: "Additive Session",
      as_of: asOf,
    }),
  ).resolves.toEqual({ revision: 1, session_id: recordId });

  // 2. Uninstalled / fabricated schemaVersion ("stale") is rejected on both list() and create()
  const staleOps = makeClient({ ...v1Def, schemaVersion: "stale" });
  await expect(staleOps.item!.list({ asOf, select: ["id", "label"] })).rejects.toThrow(
    "Schema drift",
  );
  await expect(
    staleOps.item!.create({ label: "Stale write" }, { effectiveStart: asOf, idempotencyKey: "k2" }),
  ).rejects.toThrow("does not match active artifact");

  // 3. Installed prior v3 client fails closed if active schema retired/added enum options or changed many-relation target_model
  const enumAndManyV1Def = {
    formatVersion: 1,
    schemaVersion: "v3",
    models: [
      {
        id: "item",
        name: "item",
        fields: [
          oldField,
          {
            id: "status",
            name: "status",
            type: "enum",
            required: false,
            readOnly: false,
            option_set: [
              { id: "open", lifecycle: "active" },
              { id: "closed", lifecycle: "active" },
            ],
          },
          {
            id: "tags",
            name: "tags",
            type: "relation_list",
            storage: "many",
            target_model: "tag",
            required: false,
            readOnly: false,
          },
        ],
        relations: [],
      },
    ],
  } as const satisfies DataDefinition;
  const enumOps = makeClient(enumAndManyV1Def);

  // Retired enum option -> rejected
  active = {
    ...active,
    schema: {
      ...active.schema,
      models: [
        {
          id: "item",
          fields: [
            { id: "label", type: "text", required: true },
            {
              id: "status",
              type: "enum",
              required: false,
              option_set: [
                { id: "open", lifecycle: "active" },
                { id: "closed", lifecycle: "retired" },
              ],
            } as never,
          ],
          many_relations: [{ id: "tags", target_model: "tag", lifecycle: "active" }],
        } as never,
      ],
    },
  };
  await expect(enumOps.item!.list({ asOf, select: ["id", "label"] })).rejects.toThrow(
    "Schema drift",
  );

  // Newly added enum option unknown to v3 decoder -> rejected
  active = {
    ...active,
    schema: {
      ...active.schema,
      models: [
        {
          id: "item",
          fields: [
            { id: "label", type: "text", required: true },
            {
              id: "status",
              type: "enum",
              required: false,
              option_set: [
                { id: "open", lifecycle: "active" },
                { id: "closed", lifecycle: "active" },
                { id: "won", lifecycle: "active" },
              ],
            } as never,
          ],
          many_relations: [{ id: "tags", target_model: "tag", lifecycle: "active" }],
        } as never,
      ],
    },
  };
  await expect(enumOps.item!.list({ asOf, select: ["id", "label"] })).rejects.toThrow(
    "Schema drift",
  );

  // Many-relation target_model changed -> rejected
  active = {
    ...active,
    schema: {
      ...active.schema,
      models: [
        {
          id: "item",
          fields: [
            { id: "label", type: "text", required: true },
            {
              id: "status",
              type: "enum",
              required: false,
              option_set: [
                { id: "open", lifecycle: "active" },
                { id: "closed", lifecycle: "active" },
              ],
            } as never,
          ],
          many_relations: [{ id: "tags", target_model: "other_model", lifecycle: "active" }],
        } as never,
      ],
    },
  };
  await expect(enumOps.item!.list({ asOf, select: ["id", "label"] })).rejects.toThrow(
    "Schema drift",
  );

  // Custom enum option_set and custom relation target_model_id changes in activeSchema.custom_fields -> rejected
  const customV1Def = {
    formatVersion: 1,
    schemaVersion: "v3",
    models: [
      {
        id: "item",
        name: "item",
        fields: [
          oldField,
          {
            id: "tier",
            name: "customTier",
            type: "enum",
            storage: "custom",
            required: false,
            readOnly: false,
            option_set: [{ id: "gold", lifecycle: "active" }],
          },
          {
            id: "owner",
            name: "customOwner",
            type: "relation",
            storage: "custom",
            target_model: "person",
            required: false,
            readOnly: false,
          },
        ],
        relations: [],
      },
    ],
  } as const satisfies DataDefinition;
  const customOps = makeClient(customV1Def);
  active = {
    ...active,
    schema: {
      ...active.schema,
      models: [{ id: "item", fields: [{ id: "label", type: "text", required: true }] }],
      custom_fields: [
        {
          model_id: "item",
          field_id: "tier",
          type: "enum",
          option_set: [
            { id: "gold", lifecycle: "active" },
            { id: "platinum", lifecycle: "active" },
          ],
        },
        { model_id: "item", field_id: "owner", type: "relation", target_model_id: "person" },
      ],
    } as never,
  };
  await expect(customOps.item!.list({ asOf, select: ["id", "label"] })).rejects.toThrow(
    "Schema drift",
  );
  active = {
    ...active,
    schema: {
      ...active.schema,
      models: [{ id: "item", fields: [{ id: "label", type: "text", required: true }] }],
      custom_fields: [
        {
          model_id: "item",
          field_id: "tier",
          type: "enum",
          option_set: [{ id: "gold", lifecycle: "active" }],
        },
        { model_id: "item", field_id: "owner", type: "relation", target_model_id: "team" },
      ],
    } as never,
  };
  await expect(customOps.item!.list({ asOf, select: ["id", "label"] })).rejects.toThrow(
    "Schema drift",
  );

  // 4. Installed prior v3 client fails closed if active schema retired a field or added a required field
  active = {
    ...active,
    schema: {
      ...active.schema,
      models: [
        {
          id: "item",
          fields: [
            { id: "label", type: "text", required: true, lifecycle: "retired" } as never,
            { id: "note", type: "text", required: false },
          ],
        },
      ],
    },
  };
  await expect(v1Ops.item!.list({ asOf, select: ["id", "label"] })).rejects.toThrow("Schema drift");
  await expect(
    v1Ops.item!.create({ label: "Retired write" }, { effectiveStart: asOf, idempotencyKey: "k3" }),
  ).rejects.toThrow("does not match active artifact");
});
