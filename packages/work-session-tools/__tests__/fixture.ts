import type { DataContext, DataDefinition } from "@autograph/generated-app-runtime/data";

export const sessionId = "00000000-0000-4000-8000-000000000001";
export const recordId = "00000000-0000-4000-8000-000000000002";
export const otherRecordId = "00000000-0000-4000-8000-000000000003";
export const versionId = "00000000-0000-4000-8000-000000000004";

/** A test-owned definition: one model with typed columns and an enum. */
export const definition = {
  formatVersion: 1,
  schemaVersion: "tools-v1",
  models: [
    {
      id: "item",
      name: "item",
      label: "Item",
      fields: [
        {
          id: "owner",
          name: "owner",
          label: "Owner",
          type: "text",
          required: true,
          readOnly: false,
        },
        {
          id: "score",
          name: "score",
          label: "Score",
          type: "number",
          required: false,
          readOnly: false,
        },
        {
          id: "stage",
          name: "stage",
          label: "Stage",
          type: "enum",
          required: false,
          readOnly: false,
          option_set: [
            { id: "draft", label: "Draft", aliases: ["Planned"], lifecycle: "active" },
            { id: "done", label: "Done", lifecycle: "active" },
          ],
        },
        {
          id: "related",
          name: "related",
          label: "Related items",
          type: "relation_list",
          required: false,
          readOnly: false,
          target_model: "item",
        },
        {
          id: "pay",
          name: "pay",
          label: "Pay",
          type: "money_rate",
          required: false,
          readOnly: false,
        },
        {
          id: "notes",
          name: "notes",
          label: "Notes",
          type: "json",
          required: false,
          readOnly: false,
        },
        {
          id: "parent",
          name: "parent",
          label: "Parent item",
          type: "relation",
          required: false,
          readOnly: false,
          target_model: "item",
        },
      ],
      relations: [],
    },
  ],
} as const satisfies DataDefinition;

export const header = {
  id: sessionId,
  owner_id: "human",
  title: "Plan",
  as_of: "2026-01-01",
  scope: {},
  layout: {},
  pinned: false,
  status: "active",
  revision: 3,
  rules: {},
  threads: {},
};

export const entry = (fieldId: string, value: unknown) => ({
  model_id: "item",
  record_id: recordId,
  field_id: fieldId,
  value,
  baseline: null,
  base_version: versionId,
  source: "agent",
  actor_id: "human",
  author_principal: "agent",
  author_kind: "agent",
  turn_id: "00000000-0000-4000-8000-0000000000a1",
  created_at: "2026-10-28T00:00:00Z",
  updated_at: "2026-10-28T00:00:00Z",
});

export type Call = { operation: string; input: Record<string, unknown> };

/** A DataContext whose kernel answers from `respond`; records every call and capability. */
export function fakeContext(respond: (call: Call) => unknown) {
  const calls: Call[] = [];
  const capabilities: string[] = [];
  let transactions = 0;
  let open = false;
  const session = {
    actorId: "human",
    sourceKind: "agent",
    call: async (operation: string, input: Record<string, unknown>) => {
      const call = { operation, input };
      calls.push(call);
      const result = respond(call);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  const context: DataContext = {
    scope: { appId: "tools-test", customerId: "tenant" },
    authorize: async (capability) => {
      capabilities.push(capability);
    },
    // Like the PostgreSQL context, a nested transaction joins the open one.
    transaction: async (run) => {
      if (open) return await run(session);
      transactions += 1;
      open = true;
      try {
        return await run(session);
      } finally {
        open = false;
      }
    },
  };
  return { context, calls, capabilities, transactions: () => transactions };
}
