import { parseCsv } from "../../engines/csv-parser/index";
import { executeArtifactComputation } from "../../agent-foundation/artifact-compute/index";
import { expect, it, vi } from "vitest";
import { runWorkspaceAgent, WORKSPACE_TOOL_GROUP, type WorkspaceAgentInput } from "../agent";
import type { AgentTextRunResult } from "../../agent-foundation/index";
const metadata = {
  runId: "run",
  identityId: "agent",
  executionProfileId: "profile",
  provider: "test",
  model: "test",
  toolSurface: [],
};
const result: AgentTextRunResult = {
  text: "Prepared",
  metadata,
  toolCalls: [],
  toolResults: [],
  steps: [],
};
const input = (): WorkspaceAgentInput => ({
  runId: "run",
  identity: {
    id: "agent",
    name: "Agent",
    purpose: "test",
    baseInstructions: "test",
    allowedToolGroups: [WORKSPACE_TOOL_GROUP],
    defaultExecutionProfile: "profile",
    budget: {},
  },
  executionProfile: {
    id: "profile",
    label: "Profile",
    model: { provider: "test", model: "test" },
    retryLimit: 0,
    maxSteps: 8,
    toolGroups: [WORKSPACE_TOOL_GROUP],
    budget: {},
  },
  sourceRows: [{ name: "A" }],
  schemaContext: {},
  domainInstructions: "test",
  currentDraft: {
    revision: 1,
    rows: [
      {
        rowId: "row",
        modelId: "item",
        recordId: "id",
        operation: "create",
        effectiveStart: "2026-01-01",
        values: { name: { type: "text", value: "Human" } },
        clearFields: [],
      },
    ],
  },
  instruction: "add a note",
  asOf: "2026-01-01",
  identityInput: {
    policies: [{ modelId: "item", rungs: [{ kind: "name", fieldId: "name" }] }],
    catalog: { models: new Map([["item", { fields: new Map([["name", { type: "text" }]]) }]]) },
    recordsByModel: new Map(),
  },
  validation: { dryRun: async () => [] },
});
it("rejects a manual draft with a different effective date before the agent runs", async () => {
  const request = input();
  request.currentDraft.rows[0]!.effectiveStart = "2026-01-02";
  request.runner = vi.fn(async () => result);
  expect(await runWorkspaceAgent(request)).toMatchObject({
    ok: false,
    issues: [{ code: "frozen_date_mismatch" }],
  });
  expect(request.runner).not.toHaveBeenCalled();
});

it.each([false, true])(
  "enforces the frozen proposal date with computation enabled=%s",
  async (computed) => {
    const request = input();
    request.validation.dryRun = vi.fn(async () => []);
    if (computed) request.computationExecutor = executeArtifactComputation;
    request.runner = async ({ tools }) => {
      const values = { name: { type: "text", value: "Imported" } };
      const resolved = (await tools!
        .find((tool) => tool.definition.id === "resolve_identity")!
        .execute({
          modelId: "item",
          valuesJson: JSON.stringify(values),
          effectiveStart: request.asOf,
        })) as { rowId: string; recordId: string; modelId: string; operation: "create" };
      const proposal = {
        additions: [
          {
            rowId: resolved.rowId,
            recordId: resolved.recordId,
            modelId: resolved.modelId,
            operation: resolved.operation,
            values,
            effectiveStart: "2026-01-02",
            clearFields: [],
          },
        ],
        amendments: [],
      };
      const tool = tools!.find(
        (tool) => tool.definition.id === (computed ? "compute_draft" : "propose_draft"),
      )!;
      const args = () =>
        computed
          ? { code: `input=>(${JSON.stringify(proposal)})` }
          : { proposalJson: JSON.stringify(proposal) };
      expect(await tool.execute(args())).toMatchObject({
        accepted: false,
        issues: [{ code: "frozen_date_mismatch" }],
      });
      expect(request.validation.dryRun).not.toHaveBeenCalled();
      proposal.additions[0]!.effectiveStart = request.asOf;
      expect(await tool.execute(args())).toMatchObject({ accepted: true });
      return result;
    };
    expect(await runWorkspaceAgent(request)).toMatchObject({ ok: true });
    expect(request.validation.dryRun).toHaveBeenCalledOnce();
  },
);

it("returns only a whole accepted refinement built from current human edits", async () => {
  const request = input();
  request.runner = async ({ tools }) => {
    await tools!
      .find((tool) => tool.definition.id === "propose_draft")!
      .execute({
        proposalJson: JSON.stringify({
          additions: [],
          amendments: [
            { rowId: "row", values: { note: { type: "text", value: "Agent" } }, clearFields: [] },
          ],
        }),
      });
    return result;
  };
  const actual = await runWorkspaceAgent(request);
  expect(actual.ok).toBe(true);
  if (actual.ok)
    expect(actual.draft.rows[0]?.values).toEqual({
      name: { type: "text", value: "Human" },
      note: { type: "text", value: "Agent" },
    });
  expect(request.currentDraft.rows[0]?.values.note).toBeUndefined();
});
it("returns failure and preserves prior draft when dry-run rejects or runtime fails after proposing", async () => {
  for (const runtimeFails of [false, true]) {
    const request = input();
    const before = structuredClone(request.currentDraft);
    request.validation.dryRun = async () =>
      runtimeFails ? [] : [{ code: "relation_missing", message: "Related create missing" }];
    request.runner = async ({ tools }) => {
      await tools!
        .find((tool) => tool.definition.id === "propose_draft")!
        .execute({ proposalJson: JSON.stringify({ additions: [], amendments: [] }) });
      if (runtimeFails) throw new Error("Gateway interrupted");
      return result;
    };
    expect((await runWorkspaceAgent(request)).ok).toBe(false);
    expect(request.currentDraft).toEqual(before);
  }
});
it.each([
  ["propose_draft", new Error("Dry-run unavailable"), "workspace_failed"],
  ["propose_draft", new DOMException("This operation was aborted", "AbortError"), "cancelled"],
  ["compute_draft", new Error("Dry-run unavailable"), "workspace_failed"],
  ["compute_draft", new DOMException("This operation was aborted", "AbortError"), "cancelled"],
])(
  "$0 does not present canonical validation failures as invalid proposals",
  async (toolId, failure, code) => {
    const request = input();
    const cancel = new AbortController();
    if (code === "cancelled") request.abortSignal = cancel.signal;
    const proposal = { additions: [], amendments: [] };
    if (toolId === "compute_draft")
      request.computationExecutor = async () => ({
        value: proposal,
        metrics: { elapsedMs: 1, inputBytes: 1, outputBytes: 1 },
      });
    request.validation.dryRun = async () => {
      if (code === "cancelled") cancel.abort();
      throw failure;
    };
    request.runner = async ({ tools }) => {
      await Promise.resolve(
        tools!
          .find((tool) => tool.definition.id === toolId)!
          .execute(
            toolId === "compute_draft"
              ? { code: "input=>input" }
              : { proposalJson: JSON.stringify(proposal) },
          ),
      ).catch(() => undefined); // The real agent runtime reports tool errors to the model.
      return result;
    };
    expect(await runWorkspaceAgent(request)).toMatchObject({
      ok: false,
      issues: [{ code }],
    });
  },
);
it("answers a pure question without replacing the edited draft and includes bounded conversation", async () => {
  const request = input();
  request.conversation = [
    { role: "user", content: "Keep manual names" },
    { role: "assistant", content: "Understood" },
  ];
  request.runner = async ({ prompt, tools }) => {
    expect(prompt).toContain("Keep manual names");
    expect(prompt).toContain("REFINEMENT: Start from the actual human-edited currentDraft");
    expect(prompt).toContain("NEVER justifies reverting an edited cell by itself");
    expect(prompt).toContain("should answer without a proposal");
    expect(prompt).not.toContain("INITIAL PREPARATION");
    const overview = await tools!
      .find((tool) => tool.definition.id === "inspect_workspace")!
      .execute({});
    expect(overview).toMatchObject({ draftRowCount: 1, draftRevision: 1 });
    expect(overview).not.toHaveProperty("currentDraft");
    const page = await tools!
      .find((tool) => tool.definition.id === "read_draft_rows")!
      .execute({ offset: 0, limit: 10 });
    expect(page).toMatchObject({ total: 1, rows: request.currentDraft.rows });
    return { ...result, text: "The name reflects your manual edit." };
  };
  const actual = await runWorkspaceAgent(request);
  expect(actual).toMatchObject({
    ok: true,
    draft: request.currentDraft,
    explanation: "The name reflects your manual edit.",
  });
});
it("stages bulk computation output tool-side and returns bounded counts without row replay", async () => {
  const request = input();
  request.currentDraft.rows = Array.from({ length: 1000 }, (_, i) => ({
    ...structuredClone(request.currentDraft.rows[0]!),
    rowId: `row-${i}`,
    recordId: `id-${i}`,
    values: { name: { type: "text", value: `Human ${i}` } },
  }));
  request.computationExecutor = async ({ code, input: data }) => {
    expect(code).toBe("(input) => make amendments");
    const computation = data as {
      currentDraft: WorkspaceAgentInput["currentDraft"];
      sourceRows: unknown[];
      identityGrants: unknown[];
    };
    expect(computation.currentDraft).toEqual(request.currentDraft);
    expect(computation.identityGrants).toEqual([]);
    return {
      value: {
        additions: [],
        amendments: computation.currentDraft.rows.map((row) => ({
          rowId: row.rowId,
          values: { note: { type: "text", value: "bulk-value-must-not-be-replayed" } },
          clearFields: [],
        })),
      },
      metrics: { elapsedMs: 1, inputBytes: 1000, outputBytes: 1000 },
    };
  };
  request.runner = async ({ tools }) => {
    const verdict = await tools!
      .find((tool) => tool.definition.id === "compute_draft")!
      .execute({ code: "(input) => make amendments" });
    expect(verdict).toMatchObject({ accepted: true, rowCount: 1000, amendments: 1000, issues: [] });
    expect(JSON.stringify(verdict).length).toBeLessThan(1000);
    expect(JSON.stringify(verdict)).not.toContain("bulk-value-must-not-be-replayed");
    return result;
  };
  const actual = await runWorkspaceAgent(request);
  expect(actual.ok).toBe(true);
  if (actual.ok) {
    expect(actual.draft.rows).toHaveLength(1000);
    expect(actual.draft.rows[999]?.values).toMatchObject({
      name: { value: "Human 999" },
      note: { value: "bulk-value-must-not-be-replayed" },
    });
  }
  expect(request.currentDraft.rows[999]?.values.note).toBeUndefined();
});
it("rejects a computed batch atomically for ungranted IDs or invalid envelope properties", async () => {
  for (const proposal of [
    {
      additions: [
        {
          rowId: "fake",
          modelId: "item",
          recordId: "fake-id",
          operation: "create",
          effectiveStart: "2026-01-01",
          values: { name: { type: "text", value: "invented" } },
          clearFields: [],
        },
      ],
      amendments: [
        {
          rowId: "row",
          values: { note: { type: "text", value: "must-not-stage" } },
          clearFields: [],
        },
      ],
    },
    { additions: [], amendments: [], privilegedApply: true },
  ]) {
    const request = input();
    request.computationExecutor = async () => ({
      value: proposal,
      metrics: { elapsedMs: 1, inputBytes: 1, outputBytes: 1 },
    });
    request.runner = async ({ tools }) => {
      expect(
        await tools!
          .find((tool) => tool.definition.id === "compute_draft")!
          .execute({ code: "expression" }),
      ).toMatchObject({ accepted: false, issueCount: 1 });
      return result;
    };
    const actual = await runWorkspaceAgent(request);
    expect(actual.ok).toBe(false);
    expect(request.currentDraft.rows[0]?.values.note).toBeUndefined();
  }
});
it("does not accept an earlier computed draft if a later batch fails canonical dry-run", async () => {
  const request = input();
  let count = 0;
  request.validation.dryRun = async () =>
    ++count === 1 ? [] : [{ code: "required_relation", message: "Missing related row" }];
  request.computationExecutor = async () => ({
    value: { additions: [], amendments: [] },
    metrics: { elapsedMs: 1, inputBytes: 1, outputBytes: 1 },
  });
  request.runner = async ({ tools }) => {
    const compute = tools!.find((tool) => tool.definition.id === "compute_draft")!;
    expect(await compute.execute({ code: "first" })).toMatchObject({ accepted: true });
    expect(await compute.execute({ code: "second" })).toMatchObject({ accepted: false });
    return result;
  };
  expect(await runWorkspaceAgent(request)).toMatchObject({
    ok: false,
    issues: [{ code: "required_relation" }],
  });
});
it("supplies canonical identity grants to computation without exposing existing populations", async () => {
  const request = input();
  request.computationExecutor = async ({ input: data }) => {
    const context = data as {
      identityGrants: {
        rowId: string;
        modelId: string;
        recordId: string;
        operation: string;
        effectiveStart: string;
        values: unknown;
      }[];
    };
    expect(context).not.toHaveProperty("recordsByModel");
    expect(context.identityGrants).toHaveLength(1);
    const grant = context.identityGrants[0]!;
    expect(Object.keys(grant).sort()).toEqual([
      "clearFields",
      "effectiveStart",
      "modelId",
      "operation",
      "recordId",
      "rowId",
      "values",
    ]);
    return {
      value: {
        additions: [{ ...grant }],
        amendments: [],
      },
      metrics: { elapsedMs: 1, inputBytes: 1, outputBytes: 1 },
    };
  };
  request.runner = async ({ tools }) => {
    await tools!
      .find((tool) => tool.definition.id === "resolve_identity")!
      .execute({
        modelId: "item",
        valuesJson: JSON.stringify({ name: { type: "text", value: "New canonical entity" } }),
        effectiveStart: "2026-01-01",
      });
    expect(
      await tools!
        .find((tool) => tool.definition.id === "compute_draft")!
        .execute({ code: "expression" }),
    ).toMatchObject({ accepted: true, additions: 1, rowCount: 2 });
    return result;
  };
  expect(await runWorkspaceAgent(request)).toMatchObject({ ok: true, draft: { revision: 2 } });
});

it("integrates real QuickJS output with identity and canonical dry-run gates before preserving human edits", async () => {
  const request = input();
  request.computationExecutor = executeArtifactComputation;
  const gateCalls: string[] = [];
  request.validation.dryRun = async (writes) => {
    gateCalls.push("dry-run");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      new_record_id: "id",
      values: { name: { type: "text", value: "Human" } },
    });
    return writes[0]?.values?.note?.value === "dry-reject"
      ? [{ code: "canonical_rule", message: "Canonical dry-run rejected this value" }]
      : [];
  };
  request.runner = async ({ tools }) => {
    const compute = tools!.find((tool) => tool.definition.id === "compute_draft")!;
    const fakeIdentity = await compute.execute({
      code: `(input) => ({ additions: [{ ...input.currentDraft.rows[0], rowId: "fake", recordId: "fake-id" }], amendments: [] })`,
    });
    expect(fakeIdentity).toMatchObject({ accepted: false, issues: [{ code: "invalid_proposal" }] });
    expect(gateCalls).toEqual([]);
    const codeFor = (note: string) =>
      `(input) => ({ additions: [], amendments: input.currentDraft.rows.map(row => ({ rowId: row.rowId, values: { note: { type: "text", value: ${JSON.stringify(note)} } }, clearFields: [] })) })`;
    expect(await compute.execute({ code: codeFor("dry-reject") })).toMatchObject({
      accepted: false,
      issues: [{ code: "canonical_rule" }],
    });
    expect(gateCalls).toEqual(["dry-run"]);
    const accepted = await compute.execute({
      code: `(input) => ({ additions: [], amendments: input.currentDraft.rows.map(row => ({ rowId: row.rowId, values: { note: { type: "text", value: "final: " + input.sourceRows[0].name } }, clearFields: [] })) })`,
    });
    expect(accepted).toMatchObject({
      accepted: true,
      rowCount: 1,
      amendments: 1,
      metrics: { inputBytes: expect.any(Number), outputBytes: expect.any(Number) },
    });
    expect(accepted).not.toHaveProperty("value");
    return result;
  };
  const before = structuredClone(request.currentDraft);
  const actual = await runWorkspaceAgent(request);
  expect(actual).toMatchObject({
    ok: true,
    draft: {
      revision: 2,
      rows: [{ recordId: "id", values: { name: { value: "Human" }, note: { value: "final: A" } } }],
    },
  });
  expect(request.currentDraft).toEqual(before);
  expect(gateCalls).toEqual(["dry-run", "dry-run"]);
});
it.each(["direct", "compute"] as const)(
  "serializes overlapping %s proposals through delayed dry-run in invocation order",
  async (firstTool) => {
    const request = input();
    const events: string[] = [];
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const proposal = (note: string) => ({
      additions: [],
      amendments: [
        { rowId: "row", values: { note: { type: "text", value: note } }, clearFields: [] },
      ],
    });
    if (firstTool === "compute")
      request.computationExecutor = async ({ code }) => {
        events.push(`compute:${code}`);
        return { value: proposal(code), metrics: { elapsedMs: 1, inputBytes: 1, outputBytes: 1 } };
      };
    request.validation.dryRun = async (writes) => {
      const note = writes[0]?.values?.note?.value;
      events.push(`dry:${note}:start`);
      if (note === "first") {
        firstStarted();
        await release;
        events.push("dry:first:end");
        return [];
      }
      return [{ code: "second_rejected", message: "Later proposal rejected" }];
    };
    request.runner = async ({ tools }) => {
      const direct = tools!.find((tool) => tool.definition.id === "propose_draft")!;
      const compute = tools!.find((tool) => tool.definition.id === "compute_draft")!;
      const invoke = (kind: "direct" | "compute", note: string) =>
        kind === "direct"
          ? direct.execute({ proposalJson: JSON.stringify(proposal(note)) })
          : compute.execute({ code: note });
      const first = invoke(firstTool, "first");
      await started;
      const second = invoke(firstTool, "second");
      try {
        // Let a racing second operation enter compute/domain/dry-run if unqueued.
        await Promise.resolve();
        await Promise.resolve();
        expect(events.some((event) => event.includes("second"))).toBe(false);
      } finally {
        releaseFirst();
      }
      const verdicts = await Promise.all([first, second]);
      expect(verdicts[0]).toMatchObject({ accepted: true });
      expect(verdicts[1]).toMatchObject({ accepted: false, issues: [{ code: "second_rejected" }] });
      return result;
    };
    expect(await runWorkspaceAgent(request)).toMatchObject({
      ok: false,
      explanation: result.text,
      metadata,
      issues: [{ code: "second_rejected" }],
    });
    expect(events.indexOf("dry:first:end")).toBeLessThan(events.indexOf("dry:second:start"));
    expect(request.currentDraft.rows[0]?.values.note).toBeUndefined();
  },
);

it("returns actionable unknown-row-property diagnostics then accepts a repaired proposal", async () => {
  const request = input();
  request.runner = async ({ tools }) => {
    const resolve = tools!.find((tool) => tool.definition.id === "resolve_identity")!;
    const propose = tools!.find((tool) => tool.definition.id === "propose_draft")!;
    const values = { name: { type: "text", value: "Repair entity" } };
    const grant = (await resolve.execute({
      modelId: "item",
      valuesJson: JSON.stringify(values),
      effectiveStart: "2026-01-01",
    })) as Record<string, unknown>;
    const row = { ...grant, values, effectiveStart: "2026-01-01", clearFields: [] };
    const submit = () =>
      propose.execute({ proposalJson: JSON.stringify({ additions: [row], amendments: [] }) });
    expect(await submit()).toMatchObject({
      accepted: false,
      issues: [
        {
          code: "invalid_proposal",
          message: expect.stringContaining(
            'at proposal.additions[0]: "kind", "currentValues". Allowed keys:',
          ),
        },
      ],
    });
    delete (row as Record<string, unknown>).kind;
    delete (row as Record<string, unknown>).currentValues;
    expect(await submit()).toMatchObject({ accepted: true, additions: 1 });
    return result;
  };
  expect(await runWorkspaceAgent(request)).toMatchObject({ ok: true, draft: { revision: 2 } });
});

it("repairs an amendment of an unstaged database record into an update addition", async () => {
  const request = input();
  request.identityInput.recordsByModel = new Map([
    [
      "item",
      [
        {
          record_id: "existing-record",
          effective_start: "2026-01-01",
          values: { name: { type: "text", value: "Existing" } },
          custom_fields: [],
        },
      ],
    ],
  ]);
  request.runner = async ({ tools }) => {
    const inspect = (await tools!
      .find((tool) => tool.definition.id === "inspect_workspace")!
      .execute({})) as {
      fieldValueExamples: Record<string, unknown>;
      fieldValueContract: string;
      identityPolicies: unknown;
      proposalContract: string;
    };
    expect(inspect.identityPolicies).toEqual(request.identityInput.policies);
    expect(inspect.fieldValueExamples.relation).toEqual({
      type: "relation",
      value: { type: "record_id", value: "<resolved recordId>" },
    });
    expect(inspect.fieldValueExamples.number).toEqual({ type: "number", value: "12.50" });
    expect(inspect.fieldValueContract).toContain("iso_currency and iso_country use text");
    const values = { name: { type: "text", value: "Existing" } };
    const grant = (await tools!
      .find((tool) => tool.definition.id === "resolve_identity")!
      .execute({
        modelId: "item",
        valuesJson: JSON.stringify(values),
        effectiveStart: "2026-01-01",
      })) as Record<string, unknown>;
    expect(grant.operation).toBe("update");
    expect(grant.currentValues).toEqual(values);
    const propose = tools!.find((tool) => tool.definition.id === "propose_draft")!;
    expect(
      await propose.execute({
        proposalJson: JSON.stringify({
          additions: [],
          amendments: [{ rowId: grant.rowId, values, clearFields: [] }],
        }),
      }),
    ).toMatchObject({
      accepted: false,
      issues: [
        {
          message: expect.stringContaining(
            "use additions with its resolve_identity grant and operation update",
          ),
        },
      ],
    });
    const { kind: _status, currentValues: _currentValues, ...identity } = grant;
    expect(
      await propose.execute({
        proposalJson: JSON.stringify({
          additions: [{ ...identity, values, effectiveStart: "2026-01-01", clearFields: [] }],
          amendments: [],
        }),
      }),
    ).toMatchObject({ accepted: true });
    return result;
  };
  const output = await runWorkspaceAgent(request);
  expect(output).toMatchObject({
    ok: true,
    draft: {
      rows: [request.currentDraft.rows[0], { operation: "update", recordId: "existing-record" }],
    },
  });
});

it("computes 101 mixed identities and a draft through the real isolated executor and canonical gate", async () => {
  const request = input();
  request.currentDraft = { revision: 0, rows: [] };
  request.sourceRows = Array.from({ length: 101 }, (_, index) => ({ name: `Item ${index % 100}` }));
  request.identityInput.recordsByModel = new Map([
    [
      "item",
      [
        {
          record_id: "existing",
          effective_start: request.asOf,
          values: {
            name: { type: "text", value: "Item 0" },
            note: { type: "text", value: "Keep" },
          },
          custom_fields: [],
        },
      ],
    ],
  ]);
  request.computationExecutor = executeArtifactComputation;
  let validated = 0;
  request.validation.dryRun = async (rows) => {
    validated++;
    expect(rows).toHaveLength(100);
    return [];
  };
  request.runner = async ({ tools }) => {
    const batch = tools!.find((tool) => tool.definition.id === "compute_identities")!;
    expect(
      await batch.execute({
        code: `(input)=>input.sourceRows.map(row=>({modelId:'item',values:{name:{type:'text',value:row.name}},effectiveStart:input.asOf}))`,
      }),
    ).toMatchObject({
      accepted: true,
      requestCount: 101,
      resolvedCount: 101,
      blockedCount: 0,
      grantCount: 100,
    });
    expect(
      await tools!
        .find((tool) => tool.definition.id === "compute_draft")!
        .execute({
          code: `(input)=>({additions:input.identityGrants.map(grant=>({...grant,values:grant.operation==='update'?{note:input.identityCurrentValues[grant.rowId].note}:grant.values})),amendments:[]})`,
        }),
    ).toMatchObject({ accepted: true, rowCount: 100 });
    return result;
  };
  const actual = await runWorkspaceAgent(request);
  expect(actual.ok).toBe(true);
  expect(validated).toBe(1);
  if (actual.ok)
    expect(actual.draft.rows.find((row) => row.recordId === "existing")?.values).toEqual({
      note: { type: "text", value: "Keep" },
    });
});

it("rejects malformed or oversized identity batches before any allocation, and reports ambiguity by index", async () => {
  const request = input();
  request.currentDraft = { revision: 0, rows: [] };
  request.identityInput.recordsByModel = new Map([
    [
      "item",
      ["one", "two"].map((record_id) => ({
        record_id,
        effective_start: request.asOf,
        values: { name: { type: "text" as const, value: "Ambiguous" } },
        custom_fields: [],
      })),
    ],
  ]);
  request.computationExecutor = executeArtifactComputation;
  request.runner = async ({ tools }) => {
    const batch = tools!.find((tool) => tool.definition.id === "compute_identities")!;
    for (const code of [
      `input=>[{modelId:'item',values:{name:{type:'text',value:'New'}},effectiveStart:input.asOf},{modelId:'unknown',values:{},effectiveStart:input.asOf}]`,
      `input=>Array.from({length:1001},()=>({modelId:'item',values:{name:{type:'text',value:'New'}},effectiveStart:input.asOf}))`,
      `input=>[{modelId:'item',values:{name:'untyped'},effectiveStart:input.asOf}]`,
    ])
      expect(await batch.execute({ code })).toMatchObject({ accepted: false });
    expect(
      await batch.execute({
        code: `input=>{if(input.identityGrants.length)throw Error('partial grants');return [{modelId:'item',values:{name:{type:'text',value:'Ambiguous'}},effectiveStart:input.asOf},{modelId:'item',values:{name:{type:'text',value:'New'}},effectiveStart:input.asOf}]}`,
      }),
    ).toMatchObject({
      accepted: true,
      resolvedCount: 1,
      blockedCount: 1,
      grantCount: 1,
      issues: [{ index: 0, kind: "ambiguous" }],
    });
    const manyBlocked = (await batch.execute({
      code: `input=>Array.from({length:1000},()=>({modelId:'item',values:{name:{type:'text',value:'Ambiguous'}},effectiveStart:input.asOf}))`,
    })) as { issues: unknown[] };
    expect(manyBlocked).toMatchObject({ accepted: true, blockedCount: 1000, issueCount: 1000 });
    expect(manyBlocked.issues).toHaveLength(30);
    return result;
  };
  expect((await runWorkspaceAgent(request)).ok).toBe(true);
});

it("batch grants cannot bypass canonical draft rejection", async () => {
  const request = input();
  request.currentDraft = { revision: 0, rows: [] };
  request.computationExecutor = executeArtifactComputation;
  request.validation.dryRun = async () => [
    { code: "domain_constraint", message: "Rejected by canonical validation" },
  ];
  request.runner = async ({ tools }) => {
    await tools!
      .find((tool) => tool.definition.id === "compute_identities")!
      .execute({
        code: `input=>[{modelId:'item',values:{name:{type:'text',value:'New'}},effectiveStart:input.asOf}]`,
      });
    expect(
      await tools!
        .find((tool) => tool.definition.id === "compute_draft")!
        .execute({ code: `input=>({additions:input.identityGrants,amendments:[]})` }),
    ).toMatchObject({ accepted: false, issues: [{ code: "domain_constraint" }] });
    return result;
  };
  expect(await runWorkspaceAgent(request)).toMatchObject({
    ok: false,
    issues: [{ code: "domain_constraint" }],
  });
  expect(request.currentDraft.rows).toEqual([]);
});

it.each([false, true])("exposes exactly one proposal path with computation=%s", async (enabled) => {
  const request = input();
  if (enabled) request.computationExecutor = executeArtifactComputation;
  request.runner = async ({ tools, prompt }) => {
    expect(
      tools!
        .filter((tool) => tool.definition.capability === "proposal")
        .map((tool) => tool.definition.id),
    ).toEqual([enabled ? "compute_draft" : "propose_draft"]);
    expect(prompt).not.toContain(enabled ? "propose_draft" : "compute_draft");
    return result;
  };
  expect((await runWorkspaceAgent(request)).ok).toBe(true);
});

it("retains a repeated new related identity when real computation stages null-current-value creates", async () => {
  const request = input();
  request.currentDraft = { revision: 0, rows: [] };
  request.sourceRows = [
    { name: "One", group: "Research" },
    { name: "Two", group: "Research" },
  ];
  request.identityInput.policies = ["item", "group"].map((modelId) => ({
    modelId,
    rungs: [{ kind: "name", fieldId: "name" }],
  }));
  request.identityInput.catalog = {
    models: new Map(
      ["item", "group"].map((modelId) => [
        modelId,
        { fields: new Map([["name", { type: "text" }]]) },
      ]),
    ),
  };
  request.computationExecutor = executeArtifactComputation;
  let dryRuns = 0;
  request.validation.dryRun = async (writes) => {
    dryRuns++;
    const group = writes.find((row) => row.model_id === "group");
    if (!group)
      return [{ code: "record_target_missing", message: "Related group create is required" }];
    const items = writes.filter((row) => row.model_id === "item");
    expect(items).toHaveLength(2);
    for (const row of items)
      expect(row.values?.group).toEqual({
        type: "relation",
        value: { type: "record_id", value: group.new_record_id },
      });
    return [];
  };
  request.runner = async ({ tools }) => {
    const batch = tools!.find((tool) => tool.definition.id === "compute_identities")!;
    expect(
      await batch.execute({
        code: `input=>input.sourceRows.map(row=>({modelId:'group',values:{name:{type:'text',value:row.group}},effectiveStart:input.asOf}))`,
      }),
    ).toMatchObject({ resolvedCount: 2, grantCount: 1 });
    expect(
      await batch.execute({
        code: `input=>input.sourceRows.map(row=>({modelId:'item',values:{name:{type:'text',value:row.name},group:{type:'relation',value:{type:'record_id',value:input.identityGrants.find(g=>g.modelId==='group').recordId}}},effectiveStart:input.asOf}))`,
      }),
    ).toMatchObject({ resolvedCount: 2, grantCount: 3 });
    expect(
      await tools!
        .find((tool) => tool.definition.id === "compute_draft")!
        .execute({
          code: `input=>({additions:input.identityGrants.filter(g=>input.identityCurrentValues[g.rowId]===null),amendments:[],removeRowIds:[]})`,
        }),
    ).toMatchObject({ accepted: true, rowCount: 3 });
    return result;
  };
  const actual = await runWorkspaceAgent(request);
  expect(actual).toMatchObject({ ok: true });
  expect(dryRuns).toBe(1);
  if (actual.ok) expect(actual.draft.rows.filter((row) => row.modelId === "group")).toHaveLength(1);
});

it.each([
  { revision: 0, rows: [] },
  { revision: 1, rows: [] },
])("uses run phase for an empty draft at revision $revision", async (draft) => {
  const request = input();
  request.currentDraft = draft;
  request.runner = async ({ prompt }) => {
    expect(prompt).toContain(draft.revision ? "REFINEMENT:" : "INITIAL PREPARATION:");
    expect(prompt).not.toContain(draft.revision ? "INITIAL PREPARATION:" : "REFINEMENT:");
    return result;
  };
  expect(await runWorkspaceAgent(request)).toMatchObject({ ok: true, draft });
});

it("checks amended and manually captured identities while allowing an intentional unused rename", async () => {
  for (const clear of [true, false]) {
    const request = input();
    let dryRuns = 0;
    request.validation.dryRun = async () => {
      dryRuns++;
      return [];
    };
    request.runner = async ({ tools }) => {
      const verdict = await tools!
        .find((tool) => tool.definition.id === "propose_draft")!
        .execute({
          proposalJson: JSON.stringify({
            additions: [],
            amendments: [
              {
                rowId: "row",
                values: clear ? {} : { name: { type: "text", value: "Renamed" } },
                clearFields: clear ? ["name"] : [],
              },
            ],
          }),
        });
      expect(verdict).toMatchObject({ accepted: !clear });
      return result;
    };
    expect((await runWorkspaceAgent(request)).ok).toBe(!clear);
    expect(dryRuns).toBe(clear ? 0 : 1);
    expect(request.currentDraft.rows[0]!.values.name).toEqual({ type: "text", value: "Human" });
  }
  const manual = input();
  manual.currentDraft.rows[0]!.values = {};
  manual.runner = async () => result;
  expect(await runWorkspaceAgent(manual)).toMatchObject({
    ok: false,
    issues: [{ code: "invalid_identity" }],
  });
});

it("validates an existing record rename against final identities, not old matching evidence", async () => {
  const request = input();
  request.currentDraft.rows[0]!.operation = "update";
  request.identityInput.recordsByModel = new Map([
    [
      "item",
      [
        {
          record_id: "id",
          effective_start: "2026-01-01",
          custom_fields: [],
          values: { name: { type: "text", value: "Old name" } },
        },
      ],
    ],
  ]);
  request.runner = async ({ tools }) => {
    expect(
      await tools!
        .find((tool) => tool.definition.id === "propose_draft")!
        .execute({
          proposalJson: JSON.stringify({
            additions: [],
            amendments: [
              {
                rowId: "row",
                values: { name: { type: "text", value: "New name" } },
                clearFields: [],
              },
            ],
          }),
        }),
    ).toMatchObject({ accepted: true });
    return result;
  };
  expect(await runWorkspaceAgent(request)).toMatchObject({
    ok: true,
    draft: {
      rows: [
        {
          recordId: "id",
          values: { name: { type: "text", value: "New name" } },
        },
      ],
    },
  });
  expect(request.identityInput.recordsByModel.get("item")![0]!.values.name).toEqual({
    type: "text",
    value: "Old name",
  });
});

it("rejects a wide short-cell CSV before model execution using the real computation ceiling", async () => {
  const headers = Array.from({ length: 60 }, (_, i) => `source_column_${i}_descriptive_name`);
  const csv =
    headers.join(",") +
    "\n" +
    Array.from({ length: 2200 }, () => headers.map(() => "x").join(",")).join("\n");
  const parsed = parseCsv(csv);
  expect(parsed.errors).toEqual([]);
  expect(new TextEncoder().encode(JSON.stringify({ csv })).length).toBeLessThan(3 * 1024 * 1024);
  const request = input();
  request.sourceRows = parsed.rows;
  request.currentDraft = { revision: 0, rows: [] };
  request.computationExecutor = vi.fn(executeArtifactComputation);
  request.runner = vi.fn(async () => result);
  expect(await runWorkspaceAgent(request)).toMatchObject({
    ok: false,
    issues: [
      { code: "computation_input_too_large", message: expect.stringContaining("split the CSV") },
    ],
  });
  expect(request.runner).not.toHaveBeenCalled();
  expect(request.computationExecutor).not.toHaveBeenCalled();
  await expect(
    executeArtifactComputation({
      code: "() => ({ additions: [], amendments: [] })",
      input: {
        currentDraft: request.currentDraft,
        sourceRows: parsed.rows,
        asOf: request.asOf,
        identityGrants: [],
        identityCurrentValues: {},
      },
    }),
  ).rejects.toThrow(/Computation input limit exceeded/);
});

it("includes the existing draft in computation preflight before a refinement", async () => {
  const request = input();
  request.currentDraft.rows[0]!.values.notes = { type: "text", value: "x".repeat(4 * 1024 * 1024) };
  request.computationExecutor = executeArtifactComputation;
  request.runner = vi.fn(async () => result);
  expect(await runWorkspaceAgent(request)).toMatchObject({
    ok: false,
    issues: [{ code: "computation_input_too_large" }],
  });
  expect(request.runner).not.toHaveBeenCalled();
});
