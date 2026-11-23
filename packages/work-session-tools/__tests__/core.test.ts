import { describe, expect, test } from "vitest";
import { displayDecoded, displayWire, encodeCell } from "../labels";
import { newSessionLayout } from "../layout";
import {
  createLabelIndex,
  createWorkSessionToolCore,
  mintedId,
  workSessionRequestId,
  workSessionToolSpecs,
} from "../index";
import { definition, entry, fakeContext, header, recordId, sessionId, type Call } from "./fixture";

const core = createWorkSessionToolCore(definition);
const touched = { revision: 4, entries: [], removed: [] };
const guard = { session_id: sessionId, expected_revision: 3 };
const edit = { session_id: sessionId };
const call = (context: ReturnType<typeof fakeContext>["context"], callId = "call-1") => ({
  context,
  conversationId: "conversation-1",
  callId,
});
const work = (calls: Call[]) => calls.filter((item) => item.operation === "kernel_work_session");

describe("tool table", () => {
  test("names every tool in the plan and nothing that saves or manages sessions", () => {
    expect(workSessionToolSpecs.map((spec) => spec.id)).toEqual([
      "list_sessions",
      "create_session",
      "describe_workspace",
      "read_entries",
      "find_records",
      "aggregate",
      "field_options",
      "record_history",
      "propose_records",
      "import_csv",
      "stage_changes",
      "unstage",
      "discard_mine",
      "revert_turn",
      "open_thread",
      "propose_changes",
      "reply",
      "dismiss_proposal",
      "create_rule",
      "set_rule_parameters",
      "remove_rule",
      "resolve_thread",
      "request_save",
      "set_as_of",
      "add_unit",
      "update_unit",
      "move_unit",
      "arrange_layout",
      "remove_unit",
    ]);
    // The table is app-agnostic: every app's core publishes the same tools.
    expect(core.tools).toBe(workSessionToolSpecs);
    for (const spec of workSessionToolSpecs) expect(spec.inputSchema.type).toBe("object");
  });
});

describe("mappings", () => {
  const cases: [string, Record<string, unknown>, Record<string, unknown>, unknown][] = [
    ["list_sessions", { status: "active" }, { operation: "list", status: "active" }, [header]],
    [
      "read_entries",
      {
        session_id: sessionId,
        model: "item",
        source: "agent",
        limit: 2,
        after: { model: "Item", record_id: recordId, column: "score" },
      },
      {
        operation: "entries",
        session_id: sessionId,
        model_id: "item",
        source: "agent",
        limit: 2,
        after: { model_id: "item", record_id: recordId, field_id: "score" },
      },
      { revision: 3, entries: [], has_more: false, next: null },
    ],
    [
      "stage_changes",
      {
        ...edit,
        changes: [
          { model: "Item", record_id: recordId, column: "Score", value: 12 },
          { model: "Item", record_id: recordId, column: "stage", value: "planned" },
          { model: "Item", record_id: recordId, column: "Parent item", value: recordId },
          { model: "Item", record_id: recordId, column: "Owner", value: null },
        ],
      },
      {
        operation: "stage",
        ...edit,
        changes: [
          {
            model_id: "item",
            record_id: recordId,
            field_id: "score",
            value: { type: "number", value: "12" },
          },
          {
            model_id: "item",
            record_id: recordId,
            field_id: "stage",
            value: { type: "enum", value: "draft" },
          },
          {
            model_id: "item",
            record_id: recordId,
            field_id: "parent",
            value: { type: "relation", value: { type: "record_id", value: recordId } },
          },
          { model_id: "item", record_id: recordId, field_id: "owner", value: null },
        ],
      },
      touched,
    ],
    [
      "unstage",
      { ...edit, model: "Item", record_id: recordId, column: "Score" },
      { operation: "unstage", ...edit, model_id: "item", record_id: recordId, field_id: "score" },
      touched,
    ],
    ["discard_mine", edit, { operation: "discard_source", ...edit, source: "agent" }, touched],
    [
      "revert_turn",
      { ...edit, turn_id: "00000000-0000-4000-8000-0000000000a1" },
      { operation: "discard_turn", ...edit, turn_id: "00000000-0000-4000-8000-0000000000a1" },
      touched,
    ],
    [
      "propose_changes",
      {
        ...guard,
        thread_id: "t",
        changes: [{ model: "Item", record_id: recordId, column: "Score", value: "5" }],
      },
      {
        operation: "propose",
        ...guard,
        thread_id: "t",
        changes: [
          {
            model_id: "item",
            record_id: recordId,
            field_id: "score",
            value: { type: "number", value: "5" },
          },
        ],
      },
      { revision: 4, proposal: { changes: [], author_kind: "agent" } },
    ],
    [
      "reply",
      { ...guard, thread_id: "t", message: "Done" },
      { operation: "thread_reply", ...guard, thread_id: "t", message: "Done" },
      { revision: 4, message: { id: "m" } },
    ],
    [
      "dismiss_proposal",
      { ...guard, thread_id: "t" },
      { operation: "dismiss", ...guard, thread_id: "t" },
      { revision: 4 },
    ],
    [
      "set_rule_parameters",
      { ...guard, rule_id: "r", parameters: { x: { type: "number", value: "2" } } },
      {
        operation: "rule_parameters",
        ...guard,
        rule_id: "r",
        parameters: { x: { type: "number", value: "2" } },
      },
      { ...touched, rule: null, overlaps: [] },
    ],
    [
      "remove_rule",
      { ...guard, rule_id: "r" },
      { operation: "rule_remove", ...guard, rule_id: "r" },
      touched,
    ],
    // Any calendar date, a future one included.
    [
      "set_as_of",
      { ...edit, as_of: "2027-01-01" },
      { operation: "update", ...edit, patch: { as_of: "2027-01-01" } },
      touched,
    ],
  ];
  test.each(cases)("%s", async (tool, args, expected, response) => {
    const h = fakeContext(() => response);
    const result = await core.call(tool, args, call(h.context));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const sent = work(h.calls);
    expect(sent).toHaveLength(1);
    const { schema_version: _version, request_id: requestId, ...wire } = sent[0]!.input;
    expect(wire).toEqual(expected);
    if ("expected_revision" in expected)
      expect(requestId).toBe(workSessionRequestId("conversation-1", "call-1", tool));
    else expect(requestId).toBeUndefined();
  });

  test("describe_workspace reads the header without the overlay and names columns by header", async () => {
    const h = fakeContext(() => ({
      ...header,
      rules: {
        r: {
          id: "r",
          model_id: "item",
          field_id: "score",
          value: { type: "field", field: "score" },
          author_kind: "agent",
          author_principal: "agent",
        },
      },
      threads: {
        open: {
          id: "open",
          anchor: { model_id: "item", record_id: recordId },
          resolved: false,
          messages: [],
        },
        closed: { id: "closed", anchor: {}, resolved: true, messages: [] },
      },
    }));
    const result = await core.call(
      "describe_workspace",
      { session_id: sessionId },
      call(h.context),
    );
    expect(work(h.calls)[0]!.input).toMatchObject({ operation: "get", overlay: false });
    expect(h.capabilities).toEqual(["work_session.get_without_overlay"]);
    expect(result).toMatchObject({
      ok: true,
      data: {
        session: { session_id: sessionId, as_of: "2026-01-01", revision: 3 },
        models: [
          {
            model: "Item",
            columns: [
              { header: "Owner", type: "text", required: true },
              { header: "Score", type: "number" },
              { header: "Stage", type: "enum", options: ["Draft", "Done"] },
              { header: "Related items", type: "relation_list", relates_to: "Item" },
              { header: "Pay", type: "money_rate" },
              { header: "Notes", type: "json" },
              { header: "Parent item", type: "relation", relates_to: "Item" },
            ],
          },
        ],
        rules: [{ rule_id: "r", model: "Item", column: "Score", author_kind: "agent" }],
        open_threads: [{ thread_id: "open", anchor: { model: "Item", record_id: recordId } }],
        save_request: null,
        selection: { records: [] },
      },
    });
  });

  test("describe_workspace names the person's selection and the open request to Save", async () => {
    const h = fakeContext(({ operation, input }) =>
      operation === "kernel_data_query"
        ? input.kind === "list"
          ? [{ record_id: recordId, values: { owner: { type: "text", value: "Ada's item" } } }]
          : null
        : {
            ...header,
            revision: 5,
            presence: {
              selection: [
                { model_id: "item", record_id: recordId, field_id: "score" },
                { model_id: "item", record_id: recordId, field_id: "stage" },
                { model_id: "elsewhere", record_id: recordId },
              ],
              updated_at: "2026-10-31T00:00:00Z",
            },
            threads: {
              ask: {
                id: "ask",
                kind: "save_request",
                reason: "Raises staged",
                resolved: false,
                revision: 4,
                messages: [],
              },
              old: {
                id: "old",
                kind: "save_request",
                reason: "Earlier",
                resolved: true,
                revision: 2,
                messages: [],
              },
            },
          },
    );
    const result = await core.call(
      "describe_workspace",
      { session_id: sessionId },
      call(h.context),
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        open_threads: [],
        save_request: { reason: "Raises staged", asked_at_revision: 4, changed_since: true },
        selection: {
          records: [
            {
              model: "Item",
              record_id: recordId,
              record: "Ada's item",
              columns: ["Score", "Stage"],
            },
          ],
        },
      },
    });
    // The record is read over the session, by id, at its as-of date.
    const read = h.calls.find((item) => item.operation === "kernel_data_query")!;
    expect(read.input).toMatchObject({
      as_of: "2026-01-01",
      work: { session_id: sessionId },
      include_pending_drafts: true,
    });
  });

  test("request_save asks the person to Save with a bounded reason", async () => {
    const h = fakeContext(() => ({
      revision: 4,
      thread: { id: "t", kind: "save_request", reason: "Ready", resolved: false, messages: [] },
    }));
    const result = await core.call(
      "request_save",
      { session_id: sessionId, expected_revision: 3, reason: " Ready " },
      call(h.context),
    );
    expect(result).toEqual({ ok: true, data: { revision: 4, asked: true } });
    expect(work(h.calls)[0]!.input).toMatchObject({
      operation: "save_request",
      expected_revision: 3,
      reason: "Ready",
    });
    expect(String(work(h.calls)[0]!.input.thread_id)).not.toBe("");
    const long = await core.call(
      "request_save",
      { session_id: sessionId, expected_revision: 3, reason: "x".repeat(201) },
      call(h.context),
    );
    expect(long.ok).toBe(false);
  });

  test("find_records and aggregate read over the session at its as-of date", async () => {
    const h = fakeContext(({ operation, input }) =>
      operation === "kernel_work_session"
        ? header
        : input.kind === "list"
          ? [{ record_id: recordId, values: { score: { type: "number", value: "5" } } }]
          : {
              as_of: "2026-01-01",
              units: [null],
              groups: [{ key: ["draft"], metrics: ["2"] }],
              total: { metrics: ["2"] },
              other_units: "3",
            },
    );
    const found = await core.call(
      "find_records",
      {
        session_id: sessionId,
        model: "Item",
        columns: ["Score"],
        where: [{ column: "Stage", op: "eq", value: "Done" }],
        limit: 10,
      },
      call(h.context),
    );
    expect(found).toEqual({
      ok: true,
      data: { as_of: "2026-01-01", records: [{ record_id: recordId, values: { Score: "5" } }] },
    });
    expect(h.calls[1]!.input).toMatchObject({
      kind: "list",
      model_id: "item",
      as_of: "2026-01-01",
      work: { session_id: sessionId },
      // Pending drafts are read as the canvas shows them by default.
      include_pending_drafts: true,
      where: [{ field: "stage", op: "eq", value: "done" }],
      select: ["$id", "score"],
      limit: 10,
    });
    const aggregated = await core.call(
      "aggregate",
      { session_id: sessionId, model: "Item", group_by: ["Stage"], metrics: [{ fn: "count" }] },
      call(h.context),
    );
    expect(aggregated).toMatchObject({
      ok: true,
      data: {
        group_by: ["Stage"],
        groups: [{ key: ["Draft"], metrics: ["2"] }],
        other_units: "3",
      },
    });
    expect(h.calls[3]!.input).toMatchObject({
      kind: "aggregate",
      as_of: "2026-01-01",
      work: { session_id: sessionId },
      include_pending_drafts: true,
      group_by: ["stage"],
    });
    // Each tool call is one transaction.
    expect(h.transactions()).toBe(2);
  });

  test("field_options and record_history read the definition and canonical history", async () => {
    const h = fakeContext(() => []);
    expect(
      await core.call("field_options", { model: "Item", column: "Stage" }, call(h.context)),
    ).toEqual({
      ok: true,
      data: {
        column: "Stage",
        type: "enum",
        options: [{ label: "Draft", aliases: ["Planned"] }, { label: "Done" }],
      },
    });
    expect(h.calls).toEqual([]);
    expect(
      await core.call("record_history", { model: "Item", record_id: recordId }, call(h.context)),
    ).toEqual({ ok: true, data: [] });
    expect(h.calls[0]).toMatchObject({ operation: "kernel_field_history" });
    expect(h.capabilities).toEqual(["item.history"]);
  });

  test("entries read back with labels", async () => {
    const h = fakeContext(() => ({
      revision: 3,
      entries: [entry("stage", { type: "enum", value: "done" })],
      has_more: true,
      next: { model_id: "item", record_id: recordId, field_id: "stage" },
    }));
    expect(await core.call("read_entries", { session_id: sessionId }, call(h.context))).toEqual({
      ok: true,
      data: {
        revision: 3,
        has_more: true,
        next: { model: "Item", record_id: recordId, column: "Stage" },
        entries: [
          {
            model: "Item",
            record_id: recordId,
            column: "Stage",
            value: "Done",
            baseline: null,
            source: "agent",
            author_kind: "agent",
            turn_id: "00000000-0000-4000-8000-0000000000a1",
          },
        ],
      },
    });
  });
});

describe("identity and retries", () => {
  test("a retried call sends the same request, minted thread and rule ids", async () => {
    const respond = ({ input }: Call) =>
      input.operation === "thread_open"
        ? {
            revision: 4,
            thread: { id: input.thread_id, anchor: {}, resolved: false, messages: [] },
          }
        : {
            ...touched,
            rule: { id: input.rule_id, model_id: "item", field_id: "score" },
            overlaps: [],
          };
    const first = fakeContext(respond);
    const retry = fakeContext(respond);
    const other = fakeContext(respond);
    const args = { ...guard, anchor: { model: "Item", record_id: recordId, column: "Score" } };
    const opened = await core.call("open_thread", args, call(first.context));
    await core.call("open_thread", args, call(retry.context));
    await core.call("open_thread", args, call(other.context, "call-2"));
    const threadId = mintedId("conversation-1", "call-1", "thread");
    expect(opened).toMatchObject({ ok: true, data: { thread_id: threadId } });
    expect(first.calls[0]!.input).toEqual(retry.calls[0]!.input);
    expect(first.calls[0]!.input).toMatchObject({
      thread_id: threadId,
      anchor: { model_id: "item", record_id: recordId, field_id: "score" },
    });
    expect(other.calls[0]!.input.thread_id).not.toBe(threadId);
    expect(other.calls[0]!.input.request_id).not.toBe(first.calls[0]!.input.request_id);
    const rule = {
      ...guard,
      model: "Item",
      column: "Score",
      value: {
        type: "add",
        left: { type: "field", field: "Score" },
        right: { type: "relation_field", relation: "Parent item", field: "Score" },
      },
      condition: {
        type: "compare",
        op: "gt",
        left: { type: "field", field: "score" },
        right: { type: "parameter", parameter: "floor" },
      },
      parameters: { floor: { type: "number", value: "1" } },
    };
    const created = await core.call("create_rule", rule, call(first.context, "rule-call"));
    const ruleId = mintedId("conversation-1", "rule-call", "rule");
    expect(created).toMatchObject({ ok: true, data: { rule_id: ruleId } });
    expect(first.calls[1]!.input).toMatchObject({
      operation: "rule_create",
      rule_id: ruleId,
      rule: {
        model_id: "item",
        field_id: "score",
        value: {
          type: "add",
          left: { type: "field", field: "score" },
          right: { type: "relation_field", relation: "parent", field: "score" },
        },
        condition: { left: { field: "score" } },
        parameters: { floor: { type: "number", value: "1" } },
      },
    });
  });

  test("a client thread_id never reaches the kernel", async () => {
    const h = fakeContext(() => touched);
    await core.call(
      "stage_changes",
      {
        ...guard,
        thread_id: "forged",
        changes: [
          { model: "Item", record_id: recordId, column: "Score", value: "1", thread_id: "forged" },
        ],
      },
      call(h.context),
    );
    expect(JSON.stringify(h.calls)).not.toContain("forged");
  });
});

describe("errors", () => {
  test("kernel failures return as tool errors without retrying", async () => {
    const h = fakeContext(() =>
      Object.assign(new Error("session changed"), {
        envelope: { code: "revision_conflict", message: "session changed", details: [] },
      }),
    );
    expect(
      await core.call(
        "stage_changes",
        {
          ...guard,
          changes: [{ model: "Item", record_id: recordId, column: "Score", value: "1" }],
        },
        call(h.context),
      ),
    ).toEqual({
      ok: false,
      error: { code: "revision_conflict", message: "session changed", details: [] },
    });
    expect(h.calls).toHaveLength(1);
  });

  test("a create_session retried after its default date moved answers with the session it created", async () => {
    const stored = {
      ...header,
      title: "Started",
      as_of: "2026-03-01",
      revision: 1,
      layout: newSessionLayout(["item"]).layout,
    };
    const h = fakeContext((item) => {
      if (item.input.operation === "create")
        return Object.assign(new Error("request id was reused"), {
          envelope: { code: "idempotency_conflict", message: "request id was reused" },
        });
      return stored;
    });
    const result = await core.call("create_session", { title: "Started" }, call(h.context));
    expect(result).toMatchObject({
      ok: true,
      data: { title: "Started", as_of: "2026-03-01", revision: 1, units: [{ kind: "grid" }] },
    });
    const minted = mintedId("conversation-1", "call-1", "session");
    expect((result as { data: { session_id: string } }).data.session_id).toBe(minted);
    expect(work(h.calls).map((item) => [item.input.operation, item.input.session_id])).toEqual([
      ["create", minted],
      ["get", minted],
    ]);
  });

  test("create_session reports any other refusal", async () => {
    const h = fakeContext(() =>
      Object.assign(new Error("session already exists"), {
        envelope: { code: "revision_conflict", message: "session already exists" },
      }),
    );
    expect(await core.call("create_session", { title: "Started" }, call(h.context))).toMatchObject({
      ok: false,
      error: { code: "revision_conflict" },
    });
    expect(work(h.calls)).toHaveLength(1);
  });

  test("unknown labels and tools fail before the kernel", async () => {
    const h = fakeContext(() => touched);
    expect(
      await core.call(
        "stage_changes",
        {
          ...guard,
          changes: [{ model: "Item", record_id: recordId, column: "Salary", value: "1" }],
        },
        call(h.context),
      ),
    ).toMatchObject({ ok: false, error: { code: "contract_validation_failed" } });
    expect(await core.call("save", guard, call(h.context))).toMatchObject({
      ok: false,
      error: { code: "unknown_tool" },
    });
    expect(h.calls).toEqual([]);
  });

  test("an authorization refusal from the context is a tool error", async () => {
    const h = fakeContext(() => touched);
    h.context.authorize = async (capability) => {
      throw new Error(`authorization_denied: the agent context does not allow ${capability}`);
    };
    expect(await core.call("list_sessions", {}, call(h.context))).toEqual({
      ok: false,
      error: {
        code: "authorization_denied",
        message: "the agent context does not allow work_session.list",
      },
    });
  });
});

describe("derived identity is unambiguous", () => {
  test("a numeric and a string call id with the same text do not collide", () => {
    expect(workSessionRequestId("c", 1, "stage_changes")).not.toBe(
      workSessionRequestId("c", "1", "stage_changes"),
    );
    expect(mintedId("c", 1, "thread")).not.toBe(mintedId("c", "1", "thread"));
    expect(workSessionRequestId("c", 1, "stage_changes")).toBe(
      workSessionRequestId("c", 1, "stage_changes"),
    );
  });

  test("separator characters inside parts cannot shift the boundary", () => {
    expect(workSessionRequestId("a\u0000b", "c", "stage_changes")).not.toBe(
      workSessionRequestId("a", "b\u0000c", "stage_changes"),
    );
    expect(mintedId('a","b', "c", "rule")).not.toBe(mintedId("a", 'b","c', "rule"));
  });
});

describe("values follow the column's type", () => {
  const labels = createLabelIndex(definition);
  const column = (header: string) => labels.field(labels.model("Item"), header);

  test("relation_list ids encode as record keys and decode back to plain ids", () => {
    expect(
      encodeCell(labels, column("Related items"), [recordId, { external_key: "ext-1" }]),
    ).toEqual({
      type: "relation_list",
      value: [
        { type: "record_id", value: recordId },
        { type: "external_key", value: "ext-1" },
      ],
    });
    expect(
      displayWire(labels, column("Related items"), {
        type: "relation_list",
        value: [
          { type: "record_id", value: recordId },
          { type: "external_key", value: "ext-1" },
        ],
      }),
    ).toEqual([recordId, { external_key: "ext-1" }]);
  });

  test("relation keys keep external_key apart from record_id", () => {
    expect(encodeCell(labels, column("Parent item"), { external_key: "ext-1" })).toEqual({
      type: "relation",
      value: { type: "external_key", value: "ext-1" },
    });
    expect(encodeCell(labels, column("Parent item"), recordId)).toEqual({
      type: "relation",
      value: { type: "record_id", value: recordId },
    });
    expect(
      displayWire(labels, column("Parent item"), {
        type: "relation",
        value: { type: "external_key", value: "ext-1" },
      }),
    ).toEqual({ external_key: "ext-1" });
    expect(
      displayDecoded(labels, column("Parent item"), { type: "external_key", value: "ext-1" }),
    ).toEqual({ external_key: "ext-1" });
    expect(
      displayDecoded(labels, column("Parent item"), { type: "record_id", value: recordId }),
    ).toBe(recordId);
  });

  test("money_rate values encode and display as amount, currency and period", () => {
    const pay = { amount: "85000.00", currency: "EUR", period: "annual" };
    const wire = { type: "money_rate", value: pay };
    expect(encodeCell(labels, column("Pay"), pay)).toEqual(wire);
    expect(encodeCell(labels, column("Pay"), wire)).toEqual(wire);
    expect(displayWire(labels, column("Pay"), wire)).toEqual(pay);
    expect(displayDecoded(labels, column("Pay"), pay)).toEqual(pay);
  });

  test("json values pass through unchanged, including numbers and type/value objects", () => {
    expect(encodeCell(labels, column("Notes"), 3.5)).toEqual({ type: "json", value: 3.5 });
    const shaped = { type: "number", value: "1" };
    expect(encodeCell(labels, column("Notes"), shaped)).toEqual({ type: "json", value: shaped });
    expect(displayWire(labels, column("Notes"), { type: "json", value: shaped })).toEqual(shaped);
    expect(displayDecoded(labels, column("Notes"), shaped)).toEqual(shaped);
    // Only a number column turns a JSON number into a decimal string.
    expect(encodeCell(labels, column("Score"), 3.5)).toEqual({ type: "number", value: "3.5" });
  });
});

describe("layout tools", () => {
  const unit = (id: string, kind = "grid", config: object = { model_id: "item" }) => ({
    id,
    kind,
    config,
    x: 80,
    y: 24,
    w: 400,
    h: 300,
  });
  /** A kernel holding one session whose layout and revision the test controls. */
  const kernel = (layout: object, respond?: (input: Record<string, unknown>) => unknown) => {
    const state = { layout, revision: 3 };
    const h = fakeContext(({ input }) => {
      const answered = respond?.(input);
      if (answered !== undefined) return answered;
      if (input.operation === "get") return { ...header, ...state };
      if (input.operation === "update") {
        state.layout = (input.patch as { layout: object }).layout;
        state.revision += 1;
        return { revision: state.revision };
      }
      throw new Error(`unexpected ${String(input.operation)}`);
    });
    const updates = () =>
      work(h.calls)
        .filter((item) => item.input.operation === "update")
        .map((item) => item.input);
    return { h, state, updates };
  };
  const units = (layout: object) => (layout as { units: { id: string }[] }).units;

  test("adds a grid, a chart and a graph by label, each at a free place", async () => {
    const k = kernel({});
    const grid = await core.call(
      "add_unit",
      { session_id: sessionId, kind: "grid", model: "Item" },
      call(k.h.context, "grid"),
    );
    expect(grid).toMatchObject({ ok: true, data: { revision: 4 } });
    const chart = await core.call(
      "add_unit",
      {
        session_id: sessionId,
        kind: "chart",
        model: "Item",
        group_by: "Stage",
        metric: "sum",
        measure: "Score",
        chart: "donut",
      },
      call(k.h.context, "chart"),
    );
    const graph = await core.call(
      "add_unit",
      { session_id: sessionId, kind: "graph", model: "Item", relation: "Parent item" },
      call(k.h.context, "graph"),
    );
    expect(graph).toMatchObject({ ok: true, data: { revision: 6 } });
    const [g, c, r] = (k.state.layout as { units: Record<string, unknown>[] }).units;
    expect(g).toMatchObject({ kind: "grid", config: { model_id: "item" }, x: 80, y: 24 });
    expect(c).toMatchObject({
      id: (chart as { data: { unit_id: string } }).data.unit_id,
      kind: "chart",
      config: {
        model_id: "item",
        group_by: "stage",
        metric: { fn: "sum", field_id: "score" },
        kind: "donut",
      },
    });
    expect(r).toMatchObject({ kind: "graph", config: { model_id: "item", field_id: "parent" } });
    // Layout updates are last-write-wins: no revision or request id.
    for (const input of k.updates()) {
      expect(input).not.toHaveProperty("expected_revision");
      expect(input).not.toHaveProperty("request_id");
    }
    // The workspace names the units as the agent named them.
    const described = await core.call(
      "describe_workspace",
      { session_id: sessionId },
      call(k.h.context, "describe"),
    );
    expect((described as { data: { units: unknown[] } }).data.units).toEqual([
      expect.objectContaining({ kind: "grid", model: "Item" }),
      expect.objectContaining({
        kind: "chart",
        model: "Item",
        group_by: "Stage",
        metric: "sum",
        measure: "Score",
        chart: "donut",
      }),
      expect.objectContaining({ kind: "graph", model: "Item", relation: "Parent item" }),
    ]);
  });

  test("refuses what does not resolve before touching the layout", async () => {
    const k = kernel({});
    for (const [args, message] of [
      [{ kind: "graph", model: "Item", relation: "Score" }, /not a single relation/u],
      [{ kind: "graph", model: "Item", relation: "Related items" }, /not a single relation/u],
      [{ kind: "chart", model: "Item", group_by: "Stage", chart: "pie" }, /chart/u],
      [{ kind: "chart", model: "Item", group_by: "Stage", metric: "max" }, /metric/u],
      [{ kind: "chart", model: "Item", group_by: "Nope" }, /Nope/u],
      [{ kind: "table", model: "Item" }, /kind/u],
      [{ kind: "chart", model: "Item", group_by: "Stage", chart: "range" }, /Range|column|value/iu],
    ] as const) {
      const result = await core.call(
        "add_unit",
        { session_id: sessionId, ...args },
        call(k.h.context),
      );
      expect(result.ok ? null : result.error.message).toMatch(message);
    }
    expect(k.updates()).toEqual([]);
  });

  test("a retried add finds its unit instead of adding a second", async () => {
    const k = kernel({});
    const args = { session_id: sessionId, kind: "grid", model: "Item" };
    const first = await core.call("add_unit", args, call(k.h.context, "same"));
    const again = await core.call("add_unit", args, call(k.h.context, "same"));
    expect(again).toEqual(first);
    expect(units(k.state.layout)).toHaveLength(1);
    expect(k.updates()).toHaveLength(1);
  });

  test("applies to the latest layout and keeps a unit added before it reads", async () => {
    const k = kernel({ mode: "free", units: [unit("mine")] });
    // Someone adds a unit before the agent's call reads the layout.
    k.state.layout = { mode: "free", units: [unit("mine"), unit("theirs", "chart", {})] };
    k.state.revision += 1;
    const moved = await core.call(
      "move_unit",
      { session_id: sessionId, unit_id: "mine", x: 900, w: 500 },
      call(k.h.context),
    );
    expect(moved).toMatchObject({
      ok: true,
      data: { unit_id: "mine", x: 900, y: 24, w: 500, h: 300, revision: 5 },
    });
    expect(units(k.state.layout)).toEqual([
      { ...unit("mine"), x: 900, w: 500 },
      unit("theirs", "chart", {}),
    ]);
    expect(k.updates()).toHaveLength(1);
  });

  test("moving to where a unit already is changes nothing", async () => {
    const k = kernel({ units: [unit("mine")] });
    const result = await core.call(
      "move_unit",
      { session_id: sessionId, unit_id: "mine", x: 80, y: 24 },
      call(k.h.context),
    );
    expect(result).toMatchObject({ ok: true, data: { revision: 3 } });
    expect(k.updates()).toEqual([]);
  });

  test("removes a grid once; a retried remove changes nothing; a rule's card stays", async () => {
    const k = kernel({ units: [unit("mine"), unit("card", "rule", { rule_id: "r1" })] });
    const removed = await core.call(
      "remove_unit",
      { session_id: sessionId, unit_id: "mine" },
      call(k.h.context, "remove"),
    );
    expect(removed).toEqual({ ok: true, data: { removed: "mine", revision: 4 } });
    const again = await core.call(
      "remove_unit",
      { session_id: sessionId, unit_id: "mine" },
      call(k.h.context, "remove"),
    );
    expect(again).toEqual(removed);
    const card = await core.call(
      "remove_unit",
      { session_id: sessionId, unit_id: "card" },
      call(k.h.context, "card"),
    );
    expect(card.ok ? null : card.error.code).toBe("rule_unit");
    expect(k.updates()).toHaveLength(1);
    expect(units(k.state.layout).map((item) => item.id)).toEqual(["card"]);
  });

  test("a layout the canvas cannot read is reported, not overwritten", async () => {
    const k = kernel({ units: [{ id: "broken" }] });
    const result = await core.call(
      "add_unit",
      { session_id: sessionId, kind: "grid", model: "Item" },
      call(k.h.context),
    );
    expect(result.ok ? null : result.error.code).toBe("layout_invalid");
    expect(k.updates()).toEqual([]);
    const described = await core.call(
      "describe_workspace",
      { session_id: sessionId },
      call(k.h.context, "describe"),
    );
    expect(described).toMatchObject({
      ok: true,
      data: { units: [], layout_error: expect.any(String) },
    });
  });
});

test("renamed fields resolve their header, current name and old alias to one storage field", () => {
  const model = definition.models[0]!;
  const original = model.fields[0]!;
  const primary = { ...original, name: "heading", label: "Heading" };
  const renamed = {
    ...model,
    fields: [primary, { ...primary, name: "oldName", aliasOf: "heading", readOnly: true }],
  };
  const labels = createLabelIndex({ ...definition, models: [renamed] });
  for (const name of ["Heading", "heading", "oldName", original.id])
    expect(labels.field(renamed, name)).toBe(primary);
});
