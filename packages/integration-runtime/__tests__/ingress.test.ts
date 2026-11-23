import { expect, test, vi } from "vitest";
import {
  createIntegrationIngress,
  defineIntegrationRecipe,
  integrationSource,
  type ActiveIntegrationBinding,
  type IntegrationEnvelope,
} from "../index";
import type { DataContext, DataDefinition } from "../../generated-app-runtime/data";
const definition = {
  formatVersion: 1,
  schemaVersion: "recipe-v1",
  capabilities: { versionPreconditions: true },
  models: [
    {
      id: "company",
      name: "company",
      fields: [
        { id: "name", name: "name", type: "text", required: true, readOnly: false },
        {
          id: "parent",
          name: "parent",
          type: "relation",
          target_model: "company",
          required: false,
          readOnly: false,
        },
      ],
      relations: [],
    },
  ],
} as const satisfies DataDefinition;
type RecordInput = { id: string; name: string; parent?: string };
type Envelope = IntegrationEnvelope & { date: string; records: RecordInput[] };
const identity = {
  appId: "app",
  customerId: "tenant",
  bindingId: "binding",
  connectionId: "connection",
  routingId: "route",
  deliveryId: "operation:chunk-1",
};
const binding: ActiveIntegrationBinding = {
  ...identity,
  lifecycle: "active",
  bindingRevision: 1,
  actorId: "service",
};
function setup() {
  const calls: { operation: string; input: Record<string, unknown> }[] = [];
  const order: string[] = [];
  const authorize = vi.fn(async () => {});
  const context: DataContext = {
    scope: { appId: "app", customerId: "tenant" },
    authorize,
    transaction: async (run) =>
      run({
        actorId: "service",
        sourceKind: "integration",
        call: async (operation, input) => {
          if (operation === "kernel_resolve_source_identities")
            return input.replay_only ? null : input;
          calls.push({ operation, input });
          if (operation === "kernel_read_active_schema_revision")
            return { schema_revision_id: "1", schema: { version: "recipe-v1" } };
          order.push("apply");
          return { id: 1, schema_revision_id: "1" };
        },
      }),
  };
  const projection = defineIntegrationRecipe<typeof definition, RecordInput, Envelope>(definition, {
    id: "app.companies",
    version: "v1",
    effectiveStart: (envelope) => envelope.date,
    projections: {
      company: {
        object: "companies",
        fields: ["name", "parent"],
        matching: "source_reference",
        clearing: "reject",
        sourceReference: (record) => record.id,
        normalize: (record) => ({
          name: record.name,
          ...(record.parent ? { parent: integrationSource("company", record.parent) } : {}),
        }),
      },
    },
  });
  const host = {
    projection,
    verifySignature: vi.fn(async (_body: Uint8Array, _request: { signature: string }) => {
      order.push("signature");
    }),
    parseEnvelope: vi.fn((bytes: Uint8Array): Envelope => {
      order.push("parse");
      return JSON.parse(Buffer.from(bytes).toString());
    }),
    verifyBinding: vi.fn(async () => {
      order.push("binding");
      return binding;
    }),
    withBindingLease: async <T>(
      _identity: unknown,
      run: (authority: ActiveIntegrationBinding) => Promise<T>,
    ) => {
      order.push("lease");
      try {
        return await run(binding);
      } finally {
        order.push("release");
      }
    },
    parseRecords: vi.fn((_payload: Uint8Array, envelope: Envelope) => envelope.records),
    createDataContext: vi.fn(() => context),
  };
  return { host, calls, order, context, authorize, ingest: createIntegrationIngress(host) };
}
function bytes(overrides: Partial<Envelope> = {}): Uint8Array {
  return Buffer.from(
    JSON.stringify({
      identity,
      object: "companies",
      date: "2026-10-15",
      records: [{ id: "provider-1", name: "Example" }],
      ...overrides,
    }),
  );
}
test("authenticates exact bytes before parsing, holds binding lease and revalidates before canonical apply", async () => {
  const state = setup();
  await state.ingest(bytes(), { signature: "valid" });
  expect(state.order).toEqual([
    "signature",
    "parse",
    "binding",
    "lease",
    "release",
    "binding",
    "lease",
    "apply",
    "release",
  ]);
  expect(state.authorize).toHaveBeenCalledWith("company.create");
  const input = state.calls.at(-1)!.input;
  expect(state.calls.at(-1)!.operation).toBe("kernel_apply_change_set");
  expect(input.source_ref).toMatch(/^integration:[a-f0-9]{64}$/);
  const write = (input.writes as Record<string, unknown>[])[0]!;
  expect(write.record_key).toBeUndefined();
  expect(write.provenance).toMatchObject({
    binding_id: "binding",
    binding_revision: 1,
    recipe_id: "app.companies",
    match_policy: "source_reference",
  });
  expect(JSON.stringify(input)).not.toContain("provider-1");
});
test("signature failure prevents parsing and authority access", async () => {
  const state = setup();
  state.host.verifySignature.mockRejectedValueOnce(new Error("bad signature"));
  await expect(state.ingest(bytes(), { signature: "bad" })).rejects.toThrow("bad signature");
  expect(state.host.parseEnvelope).not.toHaveBeenCalled();
  expect(state.host.verifyBinding).not.toHaveBeenCalled();
});
test("exact app/tenant/binding/connection/routing audience is required", async () => {
  for (const field of ["appId", "customerId", "bindingId", "connectionId", "routingId"] as const) {
    const state = setup();
    await expect(
      state.ingest(bytes({ identity: { ...identity, [field]: "other" } }), { signature: "valid" }),
    ).rejects.toThrow("binding_scope_mismatch");
    expect(state.calls).toHaveLength(0);
  }
});
test("revision change during final external readback fails before acquiring the lease", async () => {
  const state = setup();
  state.host.verifyBinding
    .mockResolvedValueOnce(binding)
    .mockResolvedValueOnce({ ...binding, bindingRevision: 2 });
  await expect(state.ingest(bytes(), { signature: "valid" })).rejects.toThrow(
    "binding_revision_changed",
  );
  expect(state.calls.every((call) => call.operation !== "kernel_apply_change_set")).toBe(true);
  expect(state.order.filter((event) => event === "lease")).toHaveLength(1);
});
test("delivery key is stable across conflicting content and differs for split chunks", async () => {
  const state = setup();
  await state.ingest(bytes(), { signature: "valid" });
  const first = state.calls.at(-1)!.input;
  await state.ingest(bytes({ records: [{ id: "provider-1", name: "Changed" }] }), {
    signature: "valid",
  });
  const changed = state.calls.at(-1)!.input;
  expect(changed.idempotency_key).toBe(first.idempotency_key);
  expect((changed.writes as any[])[0].provenance.payload_hash).not.toBe(
    (first.writes as any[])[0].provenance.payload_hash,
  );
  await state.ingest(bytes({ identity: { ...identity, deliveryId: "operation:chunk-2" } }), {
    signature: "valid",
  });
  expect(state.calls.at(-1)!.input.idempotency_key).not.toBe(first.idempotency_key);
});
test("payload retrieval runs after authority verification and before lease, including exact replay candidates", async () => {
  const state = setup();
  const host = {
    ...state.host,
    readPayload: vi.fn(async () => {
      state.order.push("download");
      return Buffer.from("[]");
    }),
  };
  await createIntegrationIngress(host)(bytes(), { signature: "valid" });
  expect(state.order.indexOf("download")).toBeGreaterThan(state.order.indexOf("binding"));
  expect(state.order.indexOf("download")).toBeLessThan(state.order.lastIndexOf("lease"));
});
test("relations carry app-owned typed source refs for trusted matching", async () => {
  const state = setup();
  await state.ingest(bytes({ records: [{ id: "child", name: "Child", parent: "parent" }] }), {
    signature: "valid",
  });
  expect(
    (state.calls.at(-1)!.input.writes as any[])[0].provenance.relation_source_record_refs.parent,
  ).toMatchObject({
    model_id: "company",
    source_record_ref: expect.stringMatching(/^integration:/),
  });
});
test("eligibility no-op verifies current authority under lease without inventing a receipt", async () => {
  const state = setup();
  state.host.projection.recipe.projections.company!.filterRecord = () => false;
  expect(await state.ingest(bytes(), { signature: "valid" })).toEqual({
    kind: "noop",
    reason: "no_eligible_records",
  });
  expect(state.calls).toEqual([]);
  expect(state.order).toEqual([
    "signature",
    "parse",
    "binding",
    "lease",
    "release",
    "binding",
    "lease",
    "release",
  ]);
});
test("per-record dates survive generated compilation and malformed input returns bounded status", async () => {
  const state = setup();
  state.host.projection.recipe.projections.company!.effectiveStart = (record) =>
    record.id === "first" ? "2026-10-10" : "2026-10-11";
  await state.ingest(
    bytes({
      records: [
        { id: "first", name: "One" },
        { id: "second", name: "Two" },
      ],
    }),
    { signature: "valid" },
  );
  expect(
    (state.calls.at(-1)!.input.writes as { effective_start: string }[]).map(
      (write) => write.effective_start,
    ),
  ).toEqual(["2026-10-10", "2026-10-11"]);
  await expect(state.ingest(Buffer.from("bad json"), { signature: "valid" })).rejects.toMatchObject(
    { code: "integration_invalid_envelope", status: 400 },
  );
});

test("empty provider reads retain the same binding lease and bounded no-op", async () => {
  const state = setup();
  expect(await state.ingest(bytes({ records: [] }), { signature: "valid" })).toEqual({
    kind: "noop",
    reason: "no_eligible_records",
  });
  expect(state.calls).toEqual([]);
  expect(state.host.verifyBinding).toHaveBeenCalledTimes(2);
});

test.each([false, true])(
  "fresh lease authority rejects a revision changed after provider readback (noop=%s)",
  async (noop) => {
    const state = setup();
    if (noop) state.host.projection.recipe.projections.company!.filterRecord = () => false;
    const host = {
      ...state.host,
      withBindingLease: async <T>(
        _identity: unknown,
        run: (authority: ActiveIntegrationBinding) => Promise<T>,
      ) => run({ ...binding, bindingRevision: 2 }),
    };
    await expect(createIntegrationIngress(host)(bytes(), { signature: "valid" })).rejects.toThrow(
      "binding_revision_changed",
    );
    expect(state.calls).toEqual([]);
  },
);

test.each([false, true])(
  "provider verification finishes before draining lease admission (noop=%s)",
  async (noop) => {
    const state = setup();
    if (noop) state.host.projection.recipe.projections.company!.filterRecord = () => false;
    let leased = false;
    const host = {
      ...state.host,
      verifyBinding: async () => {
        expect(leased).toBe(false);
        return binding;
      },
      withBindingLease: async <T>(
        _identity: unknown,
        run: (authority: ActiveIntegrationBinding) => Promise<T>,
      ) => {
        leased = true;
        try {
          return await run(binding);
        } finally {
          leased = false;
        }
      },
    };
    await createIntegrationIngress(host)(bytes(), { signature: "valid" });
    expect(leased).toBe(false);
  },
);

test.each([false, true])(
  "fresh lease rejects revoked or changed service authority (noop=%s)",
  async (noop) => {
    for (const authority of [
      { ...binding, actorId: "different-service" },
      { ...binding, lifecycle: "suspending" },
    ]) {
      const state = setup();
      if (noop) state.host.projection.recipe.projections.company!.filterRecord = () => false;
      const host = {
        ...state.host,
        withBindingLease: async <T>(
          _identity: unknown,
          run: (authority: ActiveIntegrationBinding) => Promise<T>,
        ) => run(authority as ActiveIntegrationBinding),
      };
      await expect(
        createIntegrationIngress(host)(bytes(), { signature: "valid" }),
      ).rejects.toThrow();
      expect(state.calls).toEqual([]);
    }
  },
);
