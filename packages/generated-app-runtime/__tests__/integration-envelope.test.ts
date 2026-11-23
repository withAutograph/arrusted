import { expect, test } from "vite-plus/test";
import { createDataClient, type DataContext, type DataSession } from "../data";
import { applySourceWrites, type SourceWriteProvenance } from "../source";
import { definition } from "./asset-operations.generated";

const limit = 1048576;
const provenance: SourceWriteProvenance = {
  source_record_ref: "provider:asset:1",
  payload_hash: "a".repeat(64),
  mapped_field_ids: ["title"],
  match_policy: "source_reference",
  clear_policy: "reject",
  recipe_id: "asset.recipe",
  recipe_version: "1",
};
function fixture(customerId = "tenant") {
  const requests: Record<string, unknown>[] = [];
  const permissions: string[] = [];
  const context: DataContext = {
    scope: { appId: "asset-register", customerId },
    authorize: async (capability) => {
      permissions.push(capability);
    },
    transaction: <T>(run: (session: DataSession) => Promise<T>) =>
      run({
        actorId: "integration-service",
        sourceKind: "integration",
        call: async (operation, payload) => {
          if (operation === "kernel_resolve_source_identities")
            return payload.replay_only ? null : payload;
          if (operation === "kernel_read_active_schema_revision")
            return {
              schema_revision_id: "1",
              schema: { version: definition.schemaVersion },
            };
          if (operation !== "kernel_apply_change_set")
            throw new Error(`unexpected operation ${operation}`);
          requests.push({
            ...payload,
            app_id: context.scope.appId,
            customer_id: context.scope.customerId,
          });
          return { id: 1, schema_revision_id: "1" };
        },
      }),
  };
  const client = createDataClient(definition, context);
  return {
    requests,
    permissions,
    apply: (title: string, entry = provenance, sourceRef = "integration:delivery") =>
      applySourceWrites(definition, context, {
        effectiveStart: "2026-10-15",
        idempotencyKey: "delivery",
        sourceRef,
        writes: [
          client.asset.writes.create({ title }, { id: "00000000-0000-0000-0000-000000000001" }),
        ],
        provenance: [entry],
      }),
  };
}

// Expected JSONB display formatting for these fixtures (string values and small
// integers), not a claim that compact JSON matches every PostgreSQL number form.
function display(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(display).join(", ")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .map(([key, member]) => `${JSON.stringify(key)}: ${display(member)}`)
      .join(", ")}}`;
  return JSON.stringify(value);
}
const byteLength = (value: unknown) => new TextEncoder().encode(display(value)).length;

async function availableTitleBytes(customerId?: string) {
  const baseline = fixture(customerId);
  await baseline.apply("a");
  return limit - byteLength(baseline.requests[0]) + 1;
}

test("final provenance and scoped envelope reaches the boundary and rejects the next byte before SQL apply", async () => {
  const titleBytes = await availableTitleBytes();
  const accepted = fixture();
  await accepted.apply("a".repeat(titleBytes));
  expect(byteLength(accepted.requests[0])).toBe(limit);
  expect(accepted.permissions).toContain("asset.create");
  expect(accepted.requests[0]).toMatchObject({
    source_ref: "integration:delivery",
    app_id: "asset-register",
    customer_id: "tenant",
  });
  expect((accepted.requests[0]!.writes as { provenance: unknown }[])[0]!.provenance).toEqual(
    provenance,
  );
  const rejected = fixture();
  await expect(rejected.apply("a".repeat(titleBytes + 1))).rejects.toThrow(
    "Source payload exceeds 1 MiB",
  );
  expect(rejected.requests).toEqual([]);
});

test("UTF-8 bytes and trusted scope are included rather than JavaScript character counts", async () => {
  const titleBytes = await availableTitleBytes("租户".repeat(30));
  const title = "é".repeat(Math.floor(titleBytes / 2));
  const accepted = fixture("租户".repeat(30));
  await accepted.apply(title);
  expect(byteLength(accepted.requests[0])).toBeLessThanOrEqual(limit);
  const rejected = fixture("租户".repeat(30));
  await expect(rejected.apply(title + "é")).rejects.toThrow("Source payload exceeds 1 MiB");
  expect(rejected.requests).toEqual([]);
});

test("source references and per-write provenance cannot bypass the generated request's earlier bound", async () => {
  for (const [entry, sourceRef] of [
    [{ ...provenance, recipe_version: "p".repeat(limit) }, "integration:delivery"],
    [provenance, "s".repeat(limit)],
  ] as const) {
    const state = fixture();
    await expect(state.apply("Small app value", entry, sourceRef)).rejects.toThrow(
      "Source payload exceeds 1 MiB",
    );
    expect(state.requests).toEqual([]);
  }
});

test("JSONB numeric expansion is reserved before applying an enriched near-limit envelope", async () => {
  const titleBytes = await availableTitleBytes();
  const state = fixture();
  // The compact numeric token is six bytes; PostgreSQL renders 22 decimal digits.
  const enriched = { ...provenance, binding_revision: 1e21 };
  await expect(state.apply("a".repeat(titleBytes - 6), enriched)).rejects.toThrow(
    "Source payload exceeds 1 MiB",
  );
  expect(state.requests).toEqual([]);
});
