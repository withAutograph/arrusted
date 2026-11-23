import { expect, test } from "vite-plus/test";
import { randomUUID } from "node:crypto";
import { createDataClient, type DataContext } from "../data";

type CapturedCall = { operation: string; input: Record<string, unknown> };
type Harness = {
  context: DataContext;
  calls: CapturedCall[];
  capabilities: string[];
  sentinel: Error;
  denial: Error;
};

const employeeFields = [
  { id: "employee_name", name: "name", type: "text", required: true, readOnly: false },
] as const;
const assetFields = [
  {
    id: "asset_owner",
    name: "owner",
    type: "relation",
    target_model: "employee",
    required: false,
    readOnly: false,
  },
] as const;
const assetModel = {
  id: "asset",
  name: "asset",
  fields: assetFields,
  relations: [],
} as const;
const policyDefinition = {
  formatVersion: 1,
  schemaVersion: "policy-relation-v1",
  capabilities: { authorization: true },
  models: [
    {
      id: "employee",
      name: "employee",
      fields: employeeFields,
      relations: [
        {
          id: "employee_assets",
          name: "assets",
          model: "asset",
          through: "asset_owner",
        },
      ],
    },
    assetModel,
  ],
} as const;
const legacyDefinition = {
  formatVersion: 1,
  schemaVersion: "legacy-relation-v1",
  models: [
    {
      id: "employee",
      name: "employee",
      fields: employeeFields,
      relations: [{ name: "assets", model: "asset", through: "asset_owner" }],
    },
    assetModel,
  ],
} as const;
const missingRelationIdDefinition = {
  formatVersion: 1,
  schemaVersion: "policy-relation-missing-id-v1",
  capabilities: { authorization: true },
  models: [
    {
      id: "employee",
      name: "employee",
      fields: employeeFields,
      relations: [{ name: "assets", model: "asset", through: "asset_owner" }],
    },
    assetModel,
  ],
} as const;

function captureContext(deniedCapability?: string): Harness {
  const calls: CapturedCall[] = [];
  const capabilities: string[] = [];
  const sentinel = new Error("captured kernel request");
  const denial = new Error("source capability denied");
  const context: DataContext = {
    scope: { appId: "relation-app", customerId: "relation-customer" },
    authorize: async (capability) => {
      capabilities.push(capability);
      if (capability === deniedCapability) throw denial;
    },
    transaction: async (run) =>
      run({
        actorId: "relation-actor",
        sourceKind: "human",
        call: async <T>(operation: string, input: Record<string, unknown>): Promise<T> => {
          calls.push({ operation, input });
          throw sentinel;
        },
      }),
  };
  return { context, calls, capabilities, sentinel, denial };
}

test("uses the canonical relation id and private relation_source for policy reads", async () => {
  const harness = captureContext();
  const operations = createDataClient(policyDefinition, harness.context);
  const sourceRecordId = randomUUID();

  await expect(
    operations.employee.relations.assets.list({
      id: sourceRecordId,
      asOf: "2026-09-16",
    }),
  ).rejects.toBe(harness.sentinel);

  expect(harness.capabilities).toEqual(["employee.relations.employee_assets.list", "asset.list"]);
  expect(harness.calls).toHaveLength(1);
  expect(harness.calls[0]).toMatchObject({ operation: "kernel_data_query" });
  expect(harness.calls[0]?.input).toMatchObject({
    model_id: "asset",
    relation_source: {
      model_id: "employee",
      relation_id: "employee_assets",
      record_id: sourceRecordId,
    },
  });
  expect(harness.calls[0]?.input.where).toBeUndefined();
  expect(harness.calls[0]?.input).not.toHaveProperty("source_relation");
});

test("denies the source relation capability before issuing a target query", async () => {
  const harness = captureContext("employee.relations.employee_assets.list");
  const operations = createDataClient(policyDefinition, harness.context);

  await expect(
    operations.employee.relations.assets.list({ id: randomUUID(), asOf: "2026-09-16" }),
  ).rejects.toBe(harness.denial);
  expect(harness.capabilities).toEqual(["employee.relations.employee_assets.list"]);
  expect(harness.calls).toHaveLength(0);
});

test("fails closed when a policy-enabled historical relation has no stable id", async () => {
  const harness = captureContext();
  const operations = createDataClient(missingRelationIdDefinition, harness.context);

  await expect(
    operations.employee.relations.assets.list({ id: randomUUID(), asOf: "2026-09-16" }),
  ).rejects.toThrow("relation authorization metadata is unavailable");
  expect(harness.capabilities).toEqual([]);
  expect(harness.calls).toHaveLength(0);
});

test("keeps legacy relation reads on their validated foreign-key filter", async () => {
  const harness = captureContext();
  const operations = createDataClient(legacyDefinition, harness.context);
  const sourceRecordId = randomUUID();

  await expect(
    operations.employee.relations.assets.list({ id: sourceRecordId, asOf: "2026-09-16" }),
  ).rejects.toBe(harness.sentinel);

  expect(harness.capabilities).toEqual(["asset.list"]);
  expect(harness.calls[0]?.input).toMatchObject({
    model_id: "asset",
    where: [{ field: "asset_owner", op: "eq", value: sourceRecordId }],
  });
  expect(harness.calls[0]?.input).not.toHaveProperty("relation_source");
});

test("rejects invalid relation inputs and caller-owned relation_source transport", async () => {
  const harness = captureContext();
  const operations = createDataClient(policyDefinition, harness.context);

  await expect(
    operations.employee.relations.assets.list({ id: "", asOf: "2026-09-16" }),
  ).rejects.toThrow("contract_validation_failed");
  await expect(
    operations.employee.relations.assets.list({
      id: randomUUID(),
      asOf: "2026-09-16",
      // @ts-expect-error relation_source is private generated transport
      relation_source: { model_id: "forged", relation_id: "forged", record_id: randomUUID() },
    }),
  ).rejects.toThrow("unknown input");
});
