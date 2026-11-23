import { describe, expect, it, vi } from "vitest";
import type { Schema, ApplyChangeSet, VisibleRecord } from "../../contracts/index";
import type { AgentTextRunResult } from "../../agent-foundation/index";
import {
  createCsvWorkspaceService,
  createCsvWorkspaceRequestHandler,
  KernelFailure,
  type CanonicalKernelOperations,
  type CsvWorkspaceServiceOptions,
  type WorkspaceDraft,
} from "../server";

const context = {
  appId: "test_app",
  customerId: "customer_a",
  actorId: "reviewer_a",
  asOf: "2027-03-15",
};
const schema = {
  models: ["sample", "tray"].map((id) => ({
    id,
    label: id,
    fields: [{ id: "serial_key", label: "Serial", type: "text", required: true, is_unique: true }],
  })),
} as unknown as Schema;
const draft: WorkspaceDraft = {
  revision: 1,
  rows: ["sample", "tray"].map((modelId) => ({
    rowId: `${modelId}-row`,
    modelId,
    recordId: `${modelId}-record`,
    operation: "create",
    effectiveStart: context.asOf,
    values: { serial_key: { type: "text", value: modelId } },
    clearFields: [],
  })),
};
const result: AgentTextRunResult = {
  text: "Prepared",
  metadata: {
    runId: "run",
    identityId: "agent",
    executionProfileId: "profile",
    provider: "test",
    model: "test",
    toolSurface: [],
  },
  toolCalls: [],
  toolResults: [],
  steps: [],
};
function setup(
  overrides: Partial<CanonicalKernelOperations> = {},
  extra: Partial<CsvWorkspaceServiceOptions> = {},
) {
  const kernel: CanonicalKernelOperations = {
    readVisibleRecords: vi.fn(async () => []),
    validateChangeSetDryRun: vi.fn(async () => ({ alreadyApplied: false })),
    applyChangeSet: vi.fn(async () => ({ id: 41, schema_revision_id: "9007199254740993" })),
    recentActivity: vi.fn(async () => []),
    changeSetDiff: vi.fn(async () => ({
      change_set_id: 41,
      source_change_set_id: 41,
      records: [],
    })),
    ...overrides,
  };
  const options: CsvWorkspaceServiceOptions = {
    schema,
    schemaRevisionId: "9007199254740993",
    context,
    policies: ["sample", "tray"].map((modelId) => ({
      modelId,
      rungs: [{ kind: "unique", fieldId: "serial_key" }],
    })),
    domainInstructions: "Match laboratory serial keys.",
    kernel,
    agent: { model: { provider: "test", model: "test" } },
    ...extra,
  };
  const service = createCsvWorkspaceService(options);
  return { kernel, options, service, handler: createCsvWorkspaceRequestHandler(service) };
}
const saveInput = () => ({
  draft,
  sourceFilename: "customer-import.csv",
  schemaRevisionId: "9007199254740993",
  idempotencyKey: "stable-human-save-key",
  recoveryContext: { ...context },
});
const post = (path: string, input: unknown) =>
  new Request(`https://host.test/api/${path}`, { method: "POST", body: JSON.stringify(input) });

describe("installed CSV workspace service", () => {
  it("reads records with their active custom values as ordinary values", async () => {
    const customSchema = {
      ...schema,
      custom_fields: [
        { id: "cfd_note", model_id: "sample", field_id: "cf_note", label: "Note", type: "text" },
      ],
    } as unknown as Schema;
    const stored: VisibleRecord = {
      record_id: "sample-record",
      effective_start: "2027-01-01",
      values: { serial_key: { type: "text", value: "S-1" } },
      custom_fields: [{ field_id: "cf_note", type: "text", value: "Recounted" }],
    };
    const { service } = setup(
      { readVisibleRecords: vi.fn(async () => [stored]) },
      { schema: customSchema },
    );
    const [record] = await service.read("sample");
    // Record search and identity matching read `values`.
    expect(record!.values).toEqual({
      serial_key: { type: "text", value: "S-1" },
      cf_note: { type: "text", value: "Recounted" },
    });
  });

  it("dry-runs and applies custom-field sets and clears in canonical shape", async () => {
    const customSchema = {
      ...schema,
      custom_fields: [
        { id: "cfd_note", model_id: "sample", field_id: "cf_note", label: "Note", type: "text" },
        { id: "cfd_lot", model_id: "sample", field_id: "cf_lot", label: "Lot", type: "text" },
      ],
    } as unknown as Schema;
    const visible: VisibleRecord = {
      record_id: "sample-record",
      effective_start: "2027-01-01",
      values: { serial_key: { type: "text", value: "S-1" } },
      custom_fields: [{ field_id: "cf_lot", type: "text", value: "L-9" }],
    };
    const { service, kernel } = setup(
      {
        readVisibleRecords: vi.fn(async (request) =>
          request.model_id === "sample" ? [visible] : [],
        ),
      },
      { schema: customSchema },
    );
    await service.save({
      ...saveInput(),
      draft: {
        revision: 1,
        rows: [
          {
            rowId: "sample-row",
            modelId: "sample",
            recordId: "sample-record",
            operation: "update",
            effectiveStart: context.asOf,
            values: {
              serial_key: { type: "text", value: "S-1" },
              cf_note: { type: "text", value: "Recounted" },
            },
            clearFields: ["cf_lot"],
          },
        ],
      },
    });
    const expected = {
      model_id: "sample",
      record_key: { type: "record_id", value: "sample-record" },
      effective_start: context.asOf,
      values: { serial_key: { type: "text", value: "S-1" } },
      custom_fields: [{ field_id: "cf_note", type: "text", value: "Recounted" }],
      clear_custom_fields: ["cf_lot"],
    };
    expect(vi.mocked(kernel.validateChangeSetDryRun).mock.calls[0]![0].writes).toEqual([expected]);
    expect(vi.mocked(kernel.applyChangeSet).mock.calls[0]![0].writes).toEqual([expected]);
  });

  it("rejects a near-limit CSV before materializing its tail or calling the agent", async () => {
    const runner = vi.fn(async () => result);
    const { service, kernel } = setup({}, { runner });
    const csv = `serial;note\n${"A;B\n".repeat(750_000)}"unterminated`;
    expect(new TextEncoder().encode(csv).byteLength).toBeLessThan(3 * 1024 * 1024);
    const actual = await service.turn({
      schemaRevisionId: "9007199254740993",
      csv,
      instruction: "Import",
      draft: { revision: 0, rows: [] },
    });
    expect(actual).toMatchObject({
      ok: false,
      issues: [{ code: "row_limit_exceeded", row: 10002 }],
    });
    if (!actual.ok) expect(actual.issues).toHaveLength(1);
    expect(runner).not.toHaveBeenCalled();
    expect(kernel.readVisibleRecords).not.toHaveBeenCalled();
    expect(kernel.applyChangeSet).not.toHaveBeenCalled();
  });

  it("rejects manual rows outside the frozen date during dry-run and refinement", async () => {
    const runner = vi.fn(async () => result);
    const { service, kernel } = setup({}, { runner });
    const changed = structuredClone(draft);
    changed.rows[0]!.effectiveStart = "2027-03-16";
    expect(await service.dryRun(changed)).toMatchObject([{ code: "frozen_date_mismatch" }]);
    expect(
      await service.turn({
        schemaRevisionId: "9007199254740993",
        csv: "serial\nA",
        instruction: "Refine",
        draft: changed,
      }),
    ).toMatchObject({ ok: false, issues: [{ code: "frozen_date_mismatch" }] });
    expect(runner).not.toHaveBeenCalled();
    expect(kernel.validateChangeSetDryRun).not.toHaveBeenCalled();
    expect(kernel.readVisibleRecords).not.toHaveBeenCalled();
  });

  it("rejects a new Save outside the frozen date but preserves exact committed replay", async () => {
    for (const alreadyApplied of [false, true]) {
      const { handler, kernel } = setup({
        validateChangeSetDryRun: vi.fn(async () => ({ alreadyApplied })),
      });
      const input = saveInput();
      input.draft = structuredClone(draft);
      input.draft.rows[0]!.effectiveStart = "2027-03-16";
      const response = await handler(post("save", input));
      expect(kernel.validateChangeSetDryRun).toHaveBeenCalledOnce();
      if (alreadyApplied) {
        expect(response.status).toBe(200);
        expect(kernel.applyChangeSet).toHaveBeenCalledWith(
          expect.objectContaining({
            writes: expect.arrayContaining([
              expect.objectContaining({ effective_start: "2027-03-16" }),
            ]),
          }),
        );
      } else {
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({
          outcome: "not_applied",
          error: { code: "frozen_date_mismatch" },
        });
        expect(kernel.applyChangeSet).not.toHaveBeenCalled();
      }
    }
  });

  it("filters saved history to human mainline changes before the limit", async () => {
    const { service, kernel } = setup();
    await service.activity();
    expect(kernel.recentActivity).toHaveBeenCalledWith({
      app_id: context.appId,
      customer_id: context.customerId,
      statuses: ["mainline"],
      source_kinds: ["human"],
      limit: 30,
    });
  });
  it("keeps models without identity policies available as read-only reference context", async () => {
    const { service } = setup(
      {},
      { policies: [{ modelId: "sample", rungs: [{ kind: "unique", fieldId: "serial_key" }] }] },
    );
    expect((await service.inspect()).schema.models.map((model) => model.id)).toEqual([
      "sample",
      "tray",
    ]);
  });

  it("lets the agent search actual reference records without an identity or write policy", async () => {
    const { service, kernel } = setup(
      {
        readVisibleRecords: vi.fn<CanonicalKernelOperations["readVisibleRecords"]>(async () => [
          {
            record_id: "tray-1",
            effective_start: context.asOf,
            values: { serial_key: { type: "text", value: "Cold storage" } },
            custom_fields: [],
          },
        ]),
      },
      {
        policies: [{ modelId: "sample", rungs: [{ kind: "unique", fieldId: "serial_key" }] }],
        runner: async ({ tools }) => {
          const search = tools!.find((tool) => tool.definition.id === "search_records")!;
          expect(
            await search.execute({ modelId: "tray", query: "STORAGE", offset: 0, limit: 1 }),
          ).toMatchObject({ total: 1, records: [{ record_id: "tray-1" }] });
          expect(() =>
            search.execute({ modelId: "tray", query: "", offset: 0, limit: 21 }),
          ).toThrow();
          return result;
        },
      },
    );
    await service.turn({
      schemaRevisionId: "9007199254740993",
      csv: "serial\nLAB-42",
      instruction: "Find the storage tray",
      draft: { revision: 0, rows: [] },
    });
    expect(kernel.applyChangeSet).not.toHaveBeenCalled();
  });

  it("rejects refinement against a different schema before reading records or running the agent", async () => {
    const runner = vi.fn(async () => result);
    const { service, kernel } = setup({}, { schemaRevisionId: "new-revision", runner });
    await expect(
      service.turn({
        schemaRevisionId: "old-revision",
        csv: "serial\nA",
        instruction: "Refine",
        draft,
      }),
    ).rejects.toThrow("schema changed");
    expect(runner).not.toHaveBeenCalled();
    expect(kernel.readVisibleRecords).not.toHaveBeenCalled();
    expect(kernel.applyChangeSet).not.toHaveBeenCalled();
  });

  it("retries the original reviewed schema revision after the active schema changes", async () => {
    const { service, kernel } = setup({}, { schemaRevisionId: "9007199254740994" });
    await service.save(saveInput());
    expect(kernel.applyChangeSet).toHaveBeenCalledWith(
      expect.objectContaining({
        schema_revision_id: "9007199254740993",
        idempotency_key: "stable-human-save-key",
        source_ref: "csv:customer-import.csv",
      }),
    );
  });

  it("owns CSV parsing, arbitrary domain identity and canonical proposal validation", async () => {
    const { service, kernel } = setup(
      {},
      {
        runner: async ({ tools }) => {
          const inspect = (await tools!
            .find((tool) => tool.definition.id === "inspect_workspace")!
            .execute({})) as { identityPolicies: unknown };
          expect(inspect.identityPolicies).toEqual([
            { modelId: "sample", rungs: [{ kind: "unique", fieldId: "serial_key" }] },
            { modelId: "tray", rungs: [{ kind: "unique", fieldId: "serial_key" }] },
          ]);
          const source = (await tools!
            .find((tool) => tool.definition.id === "read_source_rows")!
            .execute({ offset: 0, limit: 100 })) as { rows: { serial: string }[] };
          expect(source.rows).toEqual([{ serial: "LAB-42" }]);
          const values = { serial_key: { type: "text", value: source.rows[0]!.serial } };
          const resolved = (await tools!
            .find((tool) => tool.definition.id === "resolve_identity")!
            .execute({
              modelId: "sample",
              valuesJson: JSON.stringify(values),
              effectiveStart: context.asOf,
            })) as Record<string, unknown>;
          expect(resolved).toMatchObject({ kind: "resolved", modelId: "sample" });
          expect(
            await tools!
              .find((tool) => tool.definition.id === "compute_draft")!
              .execute({
                code: "input => ({ additions: input.identityGrants, amendments: [] })",
              }),
          ).toMatchObject({ accepted: true });
          return result;
        },
      },
    );
    expect(
      await service.turn({
        schemaRevisionId: "9007199254740993",
        csv: "serial\nLAB-42",
        instruction: "Prepare this sample",
        draft: { revision: 0, rows: [] },
      }),
    ).toMatchObject({
      ok: true,
      draft: {
        rows: [{ modelId: "sample", values: { serial_key: { type: "text", value: "LAB-42" } } }],
      },
    });
    expect(kernel.validateChangeSetDryRun).toHaveBeenCalledOnce();
    expect(kernel.applyChangeSet).not.toHaveBeenCalled();
  });

  it.each(["omitted", "cleared"])(
    "forwards %s required-create fields to canonical validation and preserves its verdict",
    async (kind) => {
      const issues = [
        { code: "kernel_required", path: "writes[0]", message: "Canonical rejection" },
      ];
      const { service, kernel } = setup({
        validateChangeSetDryRun: vi.fn(async () => {
          throw new KernelFailure({ code: "invalid", message: "Rejected", details: issues });
        }),
      });
      const invalid = structuredClone(draft);
      invalid.rows[0]!.values = {};
      if (kind === "cleared") invalid.rows[0]!.clearFields = ["serial_key"];
      expect(await service.dryRun(invalid)).toEqual(issues);
      expect(kernel.validateChangeSetDryRun).toHaveBeenCalledOnce();
      expect(kernel.validateChangeSetDryRun).toHaveBeenCalledWith(
        expect.objectContaining({
          writes: expect.arrayContaining([
            expect.objectContaining({
              model_id: "sample",
              values: {},
              clear_fields: kind === "cleared" ? ["serial_key"] : [],
            }),
          ]),
        }),
      );
      expect(kernel.applyChangeSet).not.toHaveBeenCalled();
    },
  );

  it("lowers all models to one canonical human apply and returns the frozen recovery identity", async () => {
    const { service, kernel } = setup();
    const receipt = await service.save(saveInput());
    expect(kernel.applyChangeSet).toHaveBeenCalledOnce();
    expect(kernel.applyChangeSet).toHaveBeenCalledWith({
      app_id: context.appId,
      customer_id: context.customerId,
      actor_id: context.actorId,
      schema_revision_id: "9007199254740993",
      source_kind: "human",
      source_ref: "csv:customer-import.csv",
      mode: "mainline",
      idempotency_key: "stable-human-save-key",
      writes: expect.arrayContaining([
        expect.objectContaining({ model_id: "sample", new_record_id: "sample-record" }),
        expect.objectContaining({ model_id: "tray", new_record_id: "tray-record" }),
      ]),
    });
    const request = vi.mocked(kernel.applyChangeSet).mock.calls[0]![0];
    expect(request.writes).toHaveLength(2);
    expect(receipt).toMatchObject({
      recoveryContext: context,
      applied: { schema_revision_id: "9007199254740993" },
    });
    expect(kernel.readVisibleRecords).toHaveBeenCalledWith({
      app_id: context.appId,
      customer_id: context.customerId,
      model_id: "sample",
      as_of: context.asOf,
    });
  });

  it.each(["appId", "customerId", "actorId", "asOf"] as const)(
    "rejects changed recovery %s before any apply",
    async (key) => {
      const { handler, kernel } = setup();
      const input = saveInput();
      input.recoveryContext[key] = "changed";
      const response = await handler(post("save", input));
      expect(response.status).toBe(400);
      expect(await response.json()).toHaveProperty("outcome", "not_applied");
      expect(kernel.applyChangeSet).not.toHaveBeenCalled();
    },
  );

  it("replays the exact key and writes through canonical apply rather than a workspace session", async () => {
    const { service, kernel } = setup();
    await service.save(saveInput());
    await service.save(saveInput());
    const calls = vi.mocked(kernel.applyChangeSet).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]![0]).toEqual(calls[1]![0]);
  });

  it("replays an applied request without rechecking identities against a later population", async () => {
    const { service, kernel } = setup(
      {
        validateChangeSetDryRun: vi.fn(async () => ({ alreadyApplied: true })),
        readVisibleRecords: vi.fn(async () => {
          expect(kernel.applyChangeSet).toHaveBeenCalledOnce();
          return [];
        }),
      },
      { schemaRevisionId: "999" },
    );
    await service.save(saveInput());
    const request = vi.mocked(kernel.applyChangeSet).mock.calls[0]![0];
    expect(request.schema_revision_id).toBe(saveInput().schemaRevisionId);
    expect(kernel.validateChangeSetDryRun).toHaveBeenCalledWith(request);
  });

  it("rejects multiple dates for the same record before applying", async () => {
    const { handler, kernel } = setup();
    const input = saveInput();
    input.draft = {
      ...draft,
      rows: [
        ...draft.rows,
        {
          ...draft.rows[0]!,
          rowId: "another-row",
          effectiveStart: "2027-03-16",
        },
      ],
    };
    const response = await handler(post("save", input));
    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty("outcome", "not_applied");
    expect(kernel.applyChangeSet).not.toHaveBeenCalled();
  });

  it("returns a definitive rejection when canonical replay detects a changed request", async () => {
    const { handler, kernel } = setup({
      validateChangeSetDryRun: async () => {
        throw new KernelFailure({ code: "idempotency_conflict", message: "Changed request" });
      },
    });
    const response = await handler(post("save", saveInput()));
    expect(response.status).toBe(422);
    expect(await response.json()).toHaveProperty("outcome", "not_applied");
    expect(kernel.applyChangeSet).not.toHaveBeenCalled();
  });

  it("a canonical apply rejection has evidence of not_applied", async () => {
    const { handler } = setup({
      applyChangeSet: async () => {
        throw new KernelFailure({ code: "invalid", message: "Rejected" });
      },
    });
    const response = await handler(post("save", saveInput()));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ outcome: "not_applied" });
  });

  it("preserves uncertainty after transport or post-apply receipt failure", async () => {
    for (const overrides of [
      {
        applyChangeSet: async (_request: ApplyChangeSet): Promise<never> => {
          throw new Error("Transport failed");
        },
      },
      {
        recentActivity: async (): Promise<never> => {
          throw new KernelFailure({ code: "receipt_failed", message: "Receipt unavailable" });
        },
      },
    ]) {
      const { handler } = setup(overrides);
      expect(await (await handler(post("save", saveInput()))).json()).not.toHaveProperty("outcome");
    }
  });

  it("keeps frozen context independent of caller mutations and aborts before work", async () => {
    const mutable = { ...context };
    const { service, kernel } = setup({}, { context: mutable });
    mutable.actorId = "changed";
    expect(service.recoveryContext.actorId).toBe(context.actorId);
    const controller = new AbortController();
    controller.abort();
    await expect(service.save(saveInput(), controller.signal)).rejects.toThrow();
    await expect(
      service.turn(
        { schemaRevisionId: "9007199254740993", csv: "serial\nA", instruction: "Import", draft },
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(kernel.applyChangeSet).not.toHaveBeenCalled();
    expect(kernel.readVisibleRecords).not.toHaveBeenCalled();
  });
});
