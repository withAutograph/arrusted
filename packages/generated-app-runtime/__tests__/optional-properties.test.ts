import { expect, test } from "vite-plus/test";
import type { DataContext, DataSession } from "../data";
import { createOperations, definition } from "./asset-operations.generated";

test("omits absent wire members while preserving explicit values and metadata nulls", async () => {
  const calls: { operation: string; input: Record<string, unknown> }[] = [];
  const context: DataContext = {
    scope: { appId: "asset-register", customerId: "optional-properties" },
    authorize: async () => {},
    transaction: <T>(run: (session: DataSession) => Promise<T>) =>
      run({
        actorId: "test",
        sourceKind: "human",
        call: async (operation, input) => {
          calls.push({ operation, input: structuredClone(input) });
          if (operation === "kernel_read_active_schema_revision")
            return {
              schema_revision_id: "1",
              schema: { version: definition.schemaVersion },
            };
          if (operation === "kernel_apply_change_set") return { id: 1, schema_revision_id: "1" };
          if (operation === "kernel_data_query") return [];
          throw new Error(`unexpected operation ${operation}`);
        },
      }),
  };
  const operations = createOperations(context);

  await operations.apply({
    effectiveStart: "2026-09-16",
    idempotencyKey: "omitted-optionals",
    writes: [operations.asset.writes.create({ title: "No optional members" })],
  });
  await operations.apply({
    effectiveStart: "2026-09-16",
    idempotencyKey: "present-optionals",
    notes: "Explicit note",
    writes: [
      operations.asset.writes.create(
        { title: "Explicit metadata patch" },
        { metadataPatch: { clear: true } },
      ),
    ],
  });
  await operations.apply({
    effectiveStart: "2026-09-16",
    idempotencyKey: "explicit-null",
    writes: [
      operations.asset.writes.create(
        { title: "Explicit null metadata patch" },
        { metadataPatch: null },
      ),
    ],
  });
  await operations.asset.list({ asOf: "2026-09-16" });
  await operations.asset.get({
    key: { type: "record_id", value: "00000000-0000-0000-0000-000000000001" },
    asOf: "2026-09-16",
  });

  const applyRequests = calls
    .filter(({ operation }) => operation === "kernel_apply_change_set")
    .map(({ input }) => input);
  expect(applyRequests).toHaveLength(3);
  expect(applyRequests[0]).not.toHaveProperty("notes");
  expect((applyRequests[0]!.writes as Record<string, unknown>[])[0]).not.toHaveProperty(
    "metadata_patch",
  );
  expect(applyRequests[1]).toHaveProperty("notes", "Explicit note");
  expect((applyRequests[1]!.writes as Record<string, unknown>[])[0]).toHaveProperty(
    "metadata_patch",
    { clear: true },
  );
  expect((applyRequests[2]!.writes as Record<string, unknown>[])[0]).toHaveProperty(
    "metadata_patch",
    null,
  );

  const queryRequests = calls
    .filter(({ operation }) => operation === "kernel_data_query")
    .map(({ input }) => input);
  expect(queryRequests).toHaveLength(2);
  expect(queryRequests[0]).not.toHaveProperty("where");
  expect(queryRequests[0]).not.toHaveProperty("order_by");
  expect(queryRequests[0]).not.toHaveProperty("limit");
  expect(queryRequests[0]).not.toHaveProperty("offset");
  expect(queryRequests[1]).toHaveProperty("where");
  expect(queryRequests[1]).toHaveProperty("limit", 1);
  expect(queryRequests[1]).not.toHaveProperty("order_by");
  expect(queryRequests[1]).not.toHaveProperty("offset");
  expect(queryRequests[1]).not.toHaveProperty("select");
});
