import { expect, expectTypeOf, test, vi } from "vitest";
import {
  createWorkSessionClient,
  type WorkSession,
  type WorkSessionRequest,
  type WorkSessionResult,
} from "../work-sessions";
import { createArtifactHelpers } from "../artifact-helpers";
import { createDataClient, type DataContext, type PendingDraft } from "../data";

vi.mock("../../schema-compiler/src/sql_runtime/app_base_activation.sql", () => ({ default: "" }));
vi.mock("../../schema-compiler/src/sql_runtime/app_base_continuation.sql", () => ({ default: "" }));

const sessionId = "00000000-0000-4000-8000-000000000001";
const state = {
  id: sessionId,
  owner_id: "person",
  title: "Plan",
  as_of: "2026-10-24",
  scope: {},
  layout: {},
  pinned: false,
  status: "open",
  revision: 1,
  overlay: [],
  rules: {},
  threads: {},
};
function harness(response: unknown = state) {
  const calls: { operation: string; input: Record<string, unknown> }[] = [];
  const capabilities: string[] = [];
  const context: DataContext = {
    scope: { appId: "test-owned", customerId: "tenant" },
    authorize: async (capability) => {
      capabilities.push(capability);
    },
    transaction: async (run) =>
      run({
        actorId: "person",
        sourceKind: "human",
        call: async (operation, input) => {
          calls.push({ operation, input });
          return typeof response === "function" ? response(input) : response;
        },
      }),
  };
  return { calls, capabilities, context, client: createWorkSessionClient(context, "test-v1") };
}

test("session mutation preserves revision and request identity through the context-owned entrypoint", async () => {
  const h = harness({ revision: 1 });
  const input = {
    operation: "pin",
    session_id: sessionId,
    expected_revision: 0,
    request_id: "pin-1",
    pinned: true,
  } as const;
  expect(await h.client.request(input)).toEqual({ revision: 1 });
  expect(h.calls).toEqual([
    { operation: "kernel_work_session", input: { ...input, schema_version: "test-v1" } },
  ]);
  expect(h.capabilities).toEqual(["work_session.pin"]);
  await h.client.request(input);
  expect(h.calls[1]?.input).toEqual(h.calls[0]?.input);
});

test("scope forgery and absent mutation guards fail before transport", async () => {
  const h = harness();
  await expect(
    h.client.request({
      operation: "get",
      session_id: sessionId,
      actor_id: "other",
    } as WorkSessionRequest),
  ).rejects.toThrow("context-owned");
  await expect(
    h.client.request({
      operation: "archive",
      session_id: sessionId,
      expected_revision: -1,
      request_id: "",
    }),
  ).rejects.toThrow("revision and request identity");
  expect(h.calls).toEqual([]);
});

test("malformed session responses fail without supplying a typed state", async () => {
  await expect(
    harness({ id: sessionId }).client.request({ operation: "get", session_id: sessionId }),
  ).rejects.toThrow();
  expect(await harness([state]).client.request({ operation: "list" })).toEqual([state]);
});

test("generated list and aggregate retain the optional work selector in the existing query path", async () => {
  const h = harness((input: Record<string, unknown>) =>
    input.kind === "aggregate"
      ? { as_of: input.as_of, units: [null], groups: [], total: { metrics: ["0"] } }
      : [],
  );
  const data = createDataClient(
    {
      formatVersion: 1,
      schemaVersion: "test-v1",
      models: [
        {
          id: "asset",
          name: "assets",
          fields: [{ id: "score", name: "score", type: "number", required: true, readOnly: false }],
          relations: [],
        },
      ],
    } as const,
    h.context,
  );
  await data.assets.list({ asOf: "2026-10-24", work: { sessionId } });
  expect(h.calls[0]).toMatchObject({
    operation: "kernel_data_query",
    input: { kind: "list", work: { session_id: sessionId } },
  });
  await data.assets.aggregate({
    asOf: "2026-10-24",
    work: { sessionId },
    metrics: [{ fn: "sum", field: "score" }],
  });
  expect(h.calls[1]).toMatchObject({
    operation: "kernel_data_query",
    input: { kind: "aggregate", work: { session_id: sessionId } },
  });
  // Pending drafts are read only when asked for, by every kind of read.
  expect(h.calls[0]?.input).not.toHaveProperty("include_pending_drafts");
  await data.assets.list({ asOf: "2026-10-24", work: { sessionId }, includePendingDrafts: true });
  await data.assets.count({ asOf: "2026-10-24", includePendingDrafts: true });
  expect(h.calls[2]).toMatchObject({ input: { include_pending_drafts: true } });
  expect(h.calls[3]).toMatchObject({ input: { kind: "aggregate", include_pending_drafts: true } });
  await expect(
    data.assets.list({
      asOf: "2026-10-24",
      includePendingDrafts: "yes" as unknown as boolean,
    }),
  ).rejects.toThrow("includePendingDrafts");
  await expect(
    data.assets.list({
      asOf: "2026-10-24",
      work: { sessionId, forkId: "main" } as unknown as { sessionId: string },
    }),
  ).rejects.toThrow();
  expect(data.workSessions).toBeDefined();
  const helpers = createArtifactHelpers({
    appId: "test-owned",
    schemaVersion: "test-v1",
    staticIds: {
      models: ["asset"],
      fields: { asset: ["score"] },
      enumOptions: {},
      changeTypes: [],
      constraints: [],
    },
    models: [{ id: "asset", fields: [{ id: "score", type: "number" }] }],
  } as const);
  expect(
    helpers.dataQuery({
      kind: "aggregate",
      model_id: "asset",
      customer_id: "tenant",
      as_of: "2026-10-24",
      metrics: [{ fn: "sum", field: "score" }],
      work: { session_id: sessionId },
    }).work?.session_id,
  ).toBe(sessionId);
  expect(
    helpers.workSession({ operation: "get", session_id: sessionId, customer_id: "tenant" }),
  ).toMatchObject({
    function: "kernel_work_session",
    request: { app_id: "test-owned", schema_version: "test-v1" },
  });
});

test("a read with pending drafts decodes what came from them by field name", async () => {
  const recordId = "00000000-0000-4000-8000-000000000001";
  const row = {
    record_id: recordId,
    values: { score: { type: "number", value: "5" } },
  };
  const h = harness((input: Record<string, unknown>) =>
    input.include_pending_drafts === true
      ? [{ ...row, pending_draft: { created: 12, fields: { score: 14 } } }]
      : [row],
  );
  const data = createDataClient(
    {
      formatVersion: 1,
      schemaVersion: "test-v1",
      models: [
        {
          id: "asset",
          name: "assets",
          fields: [
            { id: "score", name: "points", type: "number", required: true, readOnly: false },
          ],
          relations: [],
        },
      ],
    } as const,
    h.context,
  );
  const select = ["id", "points"] as const;
  const [on] = await data.assets.list({ asOf: "2026-10-24", includePendingDrafts: true, select });
  expect(on).toMatchObject({ points: "5", pendingDraft: { created: 12, fields: { points: 14 } } });
  const [off] = await data.assets.list({ asOf: "2026-10-24", select });
  expect(off).not.toHaveProperty("pendingDraft");
  // A selected read's declared type reaches it too, as a full record's does.
  expectTypeOf(on!.pendingDraft).toEqualTypeOf<PendingDraft | undefined>();
  type FullRecord = Awaited<ReturnType<typeof data.assets.list<undefined>>>[number];
  expectTypeOf<FullRecord["pendingDraft"]>().toEqualTypeOf<PendingDraft | undefined>();
});

test("protected installer accepts only explicit trusted actor kinds", async () => {
  const { protectedGeneratedPlanSchema } = await import("../protected-installer");
  const actorSchema = protectedGeneratedPlanSchema.shape.organizations.element.shape.actors.element;
  expect(
    actorSchema.parse({ actorId: "actor", actorKind: "human", roles: ["editor"] }).actorKind,
  ).toBe("human");
  expect(
    actorSchema.parse({ actorId: "agent", actorKind: "agent", roles: ["editor"] }).actorKind,
  ).toBe("agent");
  expect(() => actorSchema.parse({ actorId: "old", roles: ["editor"] })).toThrow();
  expect(() =>
    actorSchema.parse({ actorId: "bad", actorKind: "system", roles: ["editor"] }),
  ).toThrow();
}, 30000);

test("session read validates tagged staged values rather than trusting the transport", async () => {
  const bad = {
    ...state,
    overlay: [
      {
        model_id: "asset",
        record_id: sessionId,
        field_id: "score",
        value: { type: "number", value: "invalid" },
        baseline: null,
        base_version: sessionId,
        source: "user",
        actor_id: "person",
        author_principal: "human-principal",
        author_kind: "human",
        created_at: "now",
        updated_at: "now",
      },
    ],
  };
  await expect(
    harness(bad).client.request({ operation: "get", session_id: sessionId }),
  ).rejects.toThrow("expected decimal");
});

test("Save validates the complete canonical change set receipt", async () => {
  const input = {
    operation: "save",
    session_id: sessionId,
    expected_revision: 1,
    request_id: "save-1",
  } as const;
  const change_set = { id: 1, schema_revision_id: "42" };
  // Save names no mode (it always drafts): the decoded answer drops one.
  const saved = { revision: 2, change_set, cleared: true };
  expect(await harness({ ...saved, mode: "draft" }).client.request(input)).toEqual(saved);
  for (const malformed of [
    { id: 1 },
    { id: 1, schema_revision_id: 42 },
    { id: 1, schema_revision_id: "0" },
    { id: Number.MAX_SAFE_INTEGER + 1, schema_revision_id: "42" },
  ]) {
    await expect(
      harness({ revision: 2, change_set: malformed, cleared: true }).client.request(input),
    ).rejects.toThrow("Generated data response contract violation: kernel_work_session");
  }
});

test("Save accepts an all-gone result without a canonical change set", async () => {
  const response = { revision: 2, change_set: null, cleared: true };
  const h = harness({ ...response, mode: null });
  expect(
    await h.client.request({
      operation: "save",
      session_id: sessionId,
      expected_revision: 1,
      request_id: "gone-save",
      confirmed_stale: [
        {
          model_id: "asset",
          record_id: sessionId,
          field_id: "score",
          current_version: sessionId,
          gone: "record_gone",
        },
      ],
    }),
  ).toEqual(response);
  expect(h.calls[0]?.input.confirmed_stale).toEqual([
    {
      model_id: "asset",
      record_id: sessionId,
      field_id: "score",
      current_version: sessionId,
      gone: "record_gone",
    },
  ]);
});

test("session create decodes the generated response including PostgreSQL UUIDs", async () => {
  // PostgreSQL accepts UUIDs without RFC version/variant restrictions, as canonical reads do.
  const id = "01234567-89ab-cdef-0123-456789abcdef";
  const response = { revision: 1, session_id: id };
  const h = harness(response);
  expect(
    await h.client.request({
      operation: "create",
      expected_revision: 0,
      request_id: "create-session",
      session_id: id,
      title: "Plan",
      as_of: "2026-10-24",
    }),
  ).toEqual(response);
  await expect(
    harness({ ...state, id: "invalid" }).client.request({
      operation: "get",
      session_id: id,
    }),
  ).rejects.toThrow("UUID");
});

test("duplicate and derived-expression rules use the context-owned entrypoint", async () => {
  const h = harness((input: Record<string, unknown>) =>
    input.operation === "duplicate"
      ? { revision: 1, session_id: sessionId }
      : {
          revision: 2,
          entries: [],
          removed: [],
          rule: {},
          overlaps: [{ rule_id: "a", records: 3 }],
        },
  );
  const duplicate = {
    operation: "duplicate",
    session_id: sessionId,
    source_session_id: "00000000-0000-4000-8000-000000000002",
    expected_revision: 0,
    request_id: "copy-1",
    title: "Scenario",
  } as const;
  expect(await h.client.request(duplicate)).toEqual({ revision: 1, session_id: sessionId });
  const ruled = await h.client.request({
    operation: "rule_create",
    session_id: sessionId,
    expected_revision: 1,
    request_id: "rule-1",
    rule_id: "raise",
    rule: {
      model_id: "asset",
      field_id: "score",
      condition: {
        type: "compare",
        op: "lt",
        left: { type: "field", field: "score" },
        right: { type: "literal", value: { type: "number", value: "20" } },
      },
      value: {
        type: "multiply",
        left: { type: "field", field: "score" },
        right: { type: "parameter", parameter: "factor" },
      },
      parameters: { factor: { type: "number", value: "1.1" } },
    },
  });
  expect(ruled.overlaps).toEqual([{ rule_id: "a", records: 3 }]);
  expect(h.capabilities).toEqual(["work_session.duplicate", "work_session.rule_create"]);
  expect(h.calls[0]?.input).toEqual({ ...duplicate, schema_version: "test-v1" });
});

test("mutation responses are validated against the touched-entries contract", async () => {
  const stage = {
    operation: "stage",
    session_id: sessionId,
    changes: [],
  } as const;
  const touched = { revision: 2, entries: [], removed: [] };
  expect(await harness(touched).client.request(stage)).toEqual(touched);
  await expect(harness(state).client.request(stage)).rejects.toThrow();
  await expect(
    harness({ revision: 2, entries: [], removed: [{ model_id: "asset" }] }).client.request(stage),
  ).rejects.toThrow();
});

test("replayed mutations decode in each operation's shape", async () => {
  // A replay answers from current state: touched collections may be empty and
  // a rule replay reports no overlaps, but every key of the live shape is present.
  const touched = { revision: 4, entries: [], removed: [] };
  const base = { session_id: sessionId, expected_revision: 3, request_id: "replayed" } as const;
  const edit = { session_id: sessionId } as const;
  const replays: [WorkSessionRequest, unknown][] = [
    [{ ...edit, operation: "stage", changes: [] }, touched],
    [
      { ...edit, operation: "unstage", model_id: "asset", record_id: sessionId, field_id: "score" },
      touched,
    ],
    [{ ...base, operation: "pull", thread_id: "t" }, touched],
    [{ ...edit, operation: "discard_source", source: "agent" }, touched],
    [{ ...base, operation: "rule_remove", rule_id: "r" }, touched],
    [
      { ...base, operation: "rule_parameters", rule_id: "r", parameters: {} },
      { ...touched, rule: {}, overlaps: [] },
    ],
    [
      { ...base, operation: "thread_open", thread_id: "t", anchor: {} },
      { revision: 4, thread: {} },
    ],
    [
      { ...base, operation: "propose", thread_id: "t", changes: [] },
      { revision: 4, proposal: {} },
    ],
    // A superseded proposal replays as null rather than as the newer one.
    [
      { ...base, operation: "propose", thread_id: "t", changes: [] },
      { revision: 4, proposal: null },
    ],
  ];
  for (const [request, response] of replays)
    expect(await harness(response).client.request(request)).toEqual(response);
  // The shapes replays used to answer with are rejected.
  await expect(
    harness({ revision: 4 }).client.request({ ...base, operation: "pull", thread_id: "t" }),
  ).rejects.toThrow();
  await expect(
    harness({ ...touched, rule: {} }).client.request({
      ...base,
      operation: "rule_parameters",
      rule_id: "r",
      parameters: {},
    }),
  ).rejects.toThrow();
  await expect(
    harness({ revision: 4 }).client.request({
      ...base,
      operation: "propose",
      thread_id: "t",
      changes: [],
    }),
  ).rejects.toThrow();
});

test("replaying a rule create after the rule was removed decodes a null rule", async () => {
  const rule = {
    model_id: "asset",
    field_id: "score",
    value: { type: "literal", value: { type: "number", value: "1" } },
  } as const;
  const create = {
    operation: "rule_create",
    session_id: sessionId,
    expected_revision: 1,
    request_id: "rule-1",
    rule_id: "r",
    rule,
  } as const;
  const remove = {
    operation: "rule_remove",
    session_id: sessionId,
    expected_revision: 2,
    request_id: "remove-1",
    rule_id: "r",
  } as const;
  let removed = false;
  const h = harness((input: Record<string, unknown>) => {
    if (input.operation === "rule_remove") {
      removed = true;
      return { revision: 3, entries: [], removed: [] };
    }
    return removed
      ? { revision: 3, entries: [], removed: [], rule: null, overlaps: [] }
      : {
          revision: 2,
          entries: [],
          removed: [],
          rule: { ...rule, id: "r", author_principal: "p", author_kind: "human" },
          overlaps: [],
        };
  });
  expect((await h.client.request(create)).rule?.field_id).toBe("score");
  expect(await h.client.request(remove)).toEqual({ revision: 3, entries: [], removed: [] });
  const replayed = await h.client.request(create);
  expect(replayed.rule).toBeNull();
  expect(replayed.overlaps).toEqual([]);
});

const turnId = "00000000-0000-4000-8000-0000000000a1";
const entry = {
  model_id: "asset",
  record_id: "00000000-0000-4000-8000-000000000002",
  field_id: "score",
  value: { type: "number", value: "2" },
  baseline: { type: "number", value: "1" },
  base_version: "00000000-0000-4000-8000-000000000003",
  source: "agent",
  actor_id: "person",
  author_principal: "agent",
  author_kind: "agent",
  turn_id: turnId,
  created_at: "2026-10-28T00:00:00Z",
  updated_at: "2026-10-28T00:00:00Z",
  stale: false,
  current_version: "00000000-0000-4000-8000-000000000003",
  current_value: { type: "number", value: "1" },
};

test("entries pages are reads that decode entries, has_more and the next key", async () => {
  const page = {
    revision: 3,
    entries: [entry],
    has_more: true,
    next: { model_id: "asset", record_id: entry.record_id, field_id: "score" },
  };
  const h = harness(page);
  const request = {
    operation: "entries",
    session_id: sessionId,
    turn_id: turnId,
    source: "agent",
    limit: 1,
  } as const;
  const result = await h.client.request(request);
  expect(result).toEqual(page);
  expect(result.entries[0]?.turn_id).toBe(turnId);
  expect(h.capabilities).toEqual(["work_session.entries"]);
  expect(h.calls[0]?.input).toEqual({ ...request, schema_version: "test-v1" });
  await expect(harness({ ...page, has_more: "yes" }).client.request(request)).rejects.toThrow();
});

test("get without the overlay is its own capability and decodes no entries", async () => {
  const { overlay: _overlay, ...header } = state;
  const h = harness(header);
  const result = await h.client.request({
    operation: "get",
    session_id: sessionId,
    overlay: false,
  });
  expect(result).toEqual(header);
  expect(h.capabilities).toEqual(["work_session.get_without_overlay"]);
  await expect(
    harness(header).client.request({ operation: "get", session_id: sessionId }),
  ).rejects.toThrow();
});

test("discard_turn is a last-write-wins edit answering with touched targets", async () => {
  const h = harness({ revision: 5, entries: [], removed: [] });
  const request = {
    operation: "discard_turn",
    session_id: sessionId,
    turn_id: turnId,
  } as const;
  expect(await h.client.request(request)).toEqual({ revision: 5, entries: [], removed: [] });
  expect(h.capabilities).toEqual(["work_session.discard_turn"]);
});

test("edits carry no revision or request id; other mutations need both", async () => {
  const h = harness({ revision: 2, entries: [], removed: [] });
  for (const extra of [{ expected_revision: 1 }, { request_id: "stage-1" }])
    await expect(
      h.client.request({
        operation: "stage",
        session_id: sessionId,
        changes: [],
        ...extra,
      } as unknown as WorkSessionRequest),
    ).rejects.toThrow("last-write-wins");
  await expect(
    h.client.request({
      operation: "pin",
      session_id: sessionId,
      pinned: true,
    } as unknown as WorkSessionRequest),
  ).rejects.toThrow("revision and request identity");
  expect(h.calls).toEqual([]);
});

test("responses are the decoded values, not the raw transport JSON", async () => {
  const raw = { revision: 1, session_id: sessionId, unexpected: true };
  const decoded = await harness(raw).client.request({
    operation: "create",
    session_id: sessionId,
    expected_revision: 0,
    request_id: "create",
    title: "Plan",
    as_of: "2026-10-24",
  });
  expect(decoded).toEqual({ revision: 1, session_id: sessionId });
});

test("get results are a union whenever the request's overlay may be false", () => {
  type Full = WorkSessionResult<{ operation: "get"; session_id: string }>;
  type Header = WorkSessionResult<{ operation: "get"; session_id: string; overlay: false }>;
  type Either = WorkSessionResult<{ operation: "get"; session_id: string; overlay: boolean }>;
  type Optional = WorkSessionResult<{ operation: "get"; session_id: string; overlay?: boolean }>;
  expectTypeOf<Full>().toEqualTypeOf<WorkSession>();
  expectTypeOf<Header>().toEqualTypeOf<Omit<WorkSession, "overlay">>();
  expectTypeOf<Either>().toEqualTypeOf<WorkSession | Omit<WorkSession, "overlay">>();
  expectTypeOf<Optional>().toEqualTypeOf<WorkSession | Omit<WorkSession, "overlay">>();
});
