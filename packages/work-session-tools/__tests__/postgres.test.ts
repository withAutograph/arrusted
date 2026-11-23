// @vitest-environment node
// Owned-PostgreSQL acceptance for the work-session tool core and the platform
// agent context, over test-owned generated apps with and without a declared
// authorization policy. Never uses a configured application database.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, test } from "vitest";
import { createDataClient } from "@autograph/generated-app-runtime/data";
import { workSessionEventsResponse } from "../../platform-microfrontends/src/policy/verified-data-context";
import { createWorkSessionToolCore } from "../index";
import { createWorkSessionMcpHandler } from "../mcp";
import {
  agent,
  human,
  install,
  runtimeOf,
  startPostgres,
  stopPostgres,
  type InstalledApp,
} from "./postgres-fixture";

async function exercise(app: InstalledApp) {
  const people = human(app);
  const data = createDataClient(app.definition, people) as unknown as Record<
    string,
    {
      create(values: unknown, options: unknown): Promise<unknown>;
      list(input: unknown): Promise<{ id: string }[]>;
    }
  > & { workSessions: ReturnType<typeof createDataClient>["workSessions"] };
  await data.item!.create(
    { owner: "person", score: "10", phase: "draft" },
    { effectiveStart: "2026-01-01", idempotencyKey: `${app.app}-seed-1` },
  );
  await data.item!.create(
    { owner: "person", score: "20", phase: "draft" },
    { effectiveStart: "2026-01-01", idempotencyKey: `${app.app}-seed-2` },
  );
  const [first, second] = (
    await data.item!.list({
      asOf: "2026-01-01",
      orderBy: [{ field: "score", direction: "asc" }],
      select: ["id", "score"],
    })
  ).map((row) => row.id);
  const sessionId = randomUUID();
  await data.workSessions.request({
    operation: "create",
    session_id: sessionId,
    expected_revision: 0,
    request_id: "create",
    title: "Plan",
    as_of: "2026-01-01",
  });

  const handle = await agent(app);
  try {
    const core = createWorkSessionToolCore(app.definition);
    const turn: string = randomUUID();
    const call = (callId: string, turnId: string = turn) => ({
      context: handle.contextForTurn(turnId),
      conversationId: "conversation",
      callId,
    });
    const ok = async (
      tool: string,
      args: Record<string, unknown>,
      callId: string,
      turnId?: string,
    ) => {
      const result = await core.call(tool, args, call(callId, turnId ?? turn));
      assert.equal(result.ok, true, `${app.app} ${tool}: ${JSON.stringify(result)}`);
      return (result as { data: Record<string, unknown> }).data;
    };

    const sessions = (await ok("list_sessions", {}, "list")) as unknown as { session_id: string }[];
    assert.deepEqual(
      sessions.map((session) => session.session_id),
      [sessionId],
    );
    const described = await ok("describe_workspace", { session_id: sessionId }, "describe");
    assert.equal((described.session as { revision: number }).revision, 1);

    // An open canvas hears the agent's new revision on its event stream.
    const closeEvents = new AbortController();
    const events = await workSessionEventsResponse({
      context: people,
      schemaVersion: app.definition.schemaVersion,
      runtime: runtimeOf(app),
      sessionId,
      signal: closeEvents.signal,
    });
    const reader = events.body!.getReader();
    const revisions: string[] = [];
    const nextRevision = async () => {
      let text = "";
      while (!text.includes("\n\n")) text += new TextDecoder().decode((await reader.read()).value);
      revisions.push(/data: (\d+)/.exec(text)![1]!);
    };
    await nextRevision();

    // Staging stamps the turn and takes no revision: it is last-write-wins.
    const stage = {
      session_id: sessionId,
      changes: [{ model: "Item", record_id: first, column: "Score", value: "15" }],
    };
    const staged = await ok("stage_changes", stage, "stage");
    assert.equal(staged.revision, 2);
    assert.equal((staged.entries as { turn_id: string }[])[0]!.turn_id, turn);
    await nextRevision();
    assert.deepEqual(revisions, ["1", "2"]);
    closeEvents.abort();
    // A human's write and a retried agent write both land, last one wins,
    // with no revision conflict.
    await data.workSessions.request({
      operation: "stage",
      session_id: sessionId,
      changes: [
        {
          model_id: "item",
          record_id: first!,
          field_id: "score",
          value: { type: "number", value: "16" },
        },
      ],
    });
    const retried = await ok("stage_changes", stage, "stage");
    assert.equal(retried.revision, 4);
    assert.equal((retried.entries as { value: string }[])[0]!.value, "15");

    const found = await ok(
      "find_records",
      {
        session_id: sessionId,
        model: "Item",
        columns: ["Score"],
        where: [{ column: "Phase", op: "eq", value: "Draft" }],
      },
      "find",
    );
    assert.deepEqual(
      (found.records as { values: { Score: string } }[]).map((row) => row.values.Score).toSorted(),
      ["15", "20"],
    );
    const summed = await ok(
      "aggregate",
      { session_id: sessionId, model: "Item", metrics: [{ fn: "sum", column: "Score" }] },
      "sum",
    );
    assert.deepEqual((summed.total as { metrics: string[] }).metrics, ["35"]);

    // Threads, proposals and rules with minted ids.
    const opened = await ok(
      "open_thread",
      { session_id: sessionId, expected_revision: 4, anchor: { model: "Item", record_id: first } },
      "thread",
    );
    const threadId = opened.thread_id as string;
    await ok(
      "reply",
      {
        session_id: sessionId,
        expected_revision: 5,
        thread_id: threadId,
        message: "Raising the lower score",
      },
      "reply",
    );
    await ok(
      "propose_changes",
      {
        session_id: sessionId,
        expected_revision: 6,
        thread_id: threadId,
        changes: [{ model: "Item", record_id: second, column: "Phase", value: "Done" }],
      },
      "propose",
    );
    await ok(
      "dismiss_proposal",
      { session_id: sessionId, expected_revision: 7, thread_id: threadId },
      "dismiss",
    );
    const ruleTurn = randomUUID();
    const rule = await ok(
      "create_rule",
      {
        session_id: sessionId,
        expected_revision: 8,
        model: "Item",
        column: "Score",
        value: {
          type: "multiply",
          left: { type: "field", field: "Score" },
          right: { type: "parameter", parameter: "factor" },
        },
        condition: {
          type: "compare",
          op: "gte",
          left: { type: "field", field: "Score" },
          right: { type: "literal", value: { type: "number", value: "20" } },
        },
        parameters: { factor: { type: "number", value: "2" } },
      },
      "rule",
      ruleTurn,
    );
    const ruleId = rule.rule_id as string;
    assert.deepEqual(
      (rule.entries as { record_id: string; value: string; turn_id: string }[]).map((e) => [
        e.record_id,
        e.value,
        e.turn_id,
      ]),
      [[second, "40", ruleTurn]],
    );
    await ok(
      "set_rule_parameters",
      {
        session_id: sessionId,
        expected_revision: 9,
        rule_id: ruleId,
        parameters: { factor: { type: "number", value: "3" } },
      },
      "reparam",
      ruleTurn,
    );
    const page = await ok("read_entries", { session_id: sessionId, turn_id: ruleTurn }, "entries");
    assert.deepEqual(
      (page.entries as { value: string }[]).map((e) => e.value),
      ["60"],
    );
    await ok(
      "remove_rule",
      { session_id: sessionId, expected_revision: 10, rule_id: ruleId },
      "remove-rule",
    );
    // Revert the first turn, then stage again and discard everything mine.
    const reverted = await ok("revert_turn", { session_id: sessionId, turn_id: turn }, "revert");
    // The turn's entry held the human's 16 it replaced: reverting gives it back.
    assert.equal((reverted.removed as unknown[]).length, 0);
    assert.deepEqual(
      (reverted.entries as { value: string }[]).map((e) => e.value),
      ["16"],
    );
    await ok(
      "stage_changes",
      {
        session_id: sessionId,
        changes: [{ model: "Item", record_id: second, column: "Phase", value: "Done" }],
      },
      "restage",
    );
    await ok(
      "unstage",
      {
        session_id: sessionId,
        model: "Item",
        record_id: second,
        column: "Phase",
      },
      "unstage",
    );
    await ok(
      "stage_changes",
      {
        session_id: sessionId,
        changes: [{ model: "Item", record_id: second, column: "Score", value: "25" }],
      },
      "restage-2",
    );
    const history = await ok("record_history", { model: "Item", record_id: first }, "history");
    assert.ok(Array.isArray(history));
    assert.deepEqual(
      (
        (await ok("field_options", { model: "Item", column: "Phase" }, "options")).options as {
          label: string;
        }[]
      ).map((o) => o.label),
      ["Draft", "Done"],
    );

    // The agent arranges the canvas: the kernel takes a layout-only update from it.
    const added = await ok(
      "add_unit",
      { session_id: sessionId, kind: "chart", model: "Item", group_by: "Phase" },
      "add-unit",
    );
    assert.equal(added.revision, 16);
    const moved = await ok(
      "move_unit",
      { session_id: sessionId, unit_id: added.unit_id, x: 900 },
      "move-unit",
    );
    assert.equal(moved.x, 900);
    const arranged = await ok("describe_workspace", { session_id: sessionId }, "arranged");
    assert.deepEqual(
      (arranged.units as { unit_id: string; group_by: string; x: number }[]).map((unit) => [
        unit.unit_id,
        unit.group_by,
        unit.x,
      ]),
      [[added.unit_id, "Phase", 900]],
    );
    await ok("remove_unit", { session_id: sessionId, unit_id: added.unit_id }, "remove-unit");
    assert.deepEqual(
      (await ok("describe_workspace", { session_id: sessionId }, "cleared")).units,
      [],
    );

    // The agent context refuses what is outside its list, and the kernel refuses
    // canonical writes from the marked context on every app.
    const context = handle.contextForTurn(randomUUID());
    await assert.rejects(context.authorize("item.create"), /authorization_denied/u);
    await assert.rejects(context.authorize("work_session.save"), /authorization_denied/u);
    await assert.rejects(context.authorize("work_session.get"), /authorization_denied/u);
    await assert.rejects(
      context.transaction((session) =>
        session.call("kernel_apply_change_set", {
          source_kind: "agent",
          mode: "mainline",
          idempotency_key: randomUUID(),
          writes: [
            {
              model_id: "item",
              record_key: { type: "record_id", value: first },
              effective_start: "2026-01-01",
              values: { score: { type: "number", value: "99" } },
            },
          ],
        }),
      ),
      /Agent context cannot write canonical data/u,
    );
    // Nor does it approve a draft: Save and approve stays a human approver's.
    await assert.rejects(
      context.transaction((session) =>
        session.call("kernel_approve_draft_change_set", { change_set_id: 1 }),
      ),
      /Agent context cannot write canonical data|Draft approval requires human authority/u,
    );
    await assert.rejects(
      context.transaction((session) =>
        session.call("kernel_work_session", {
          operation: "save",
          schema_version: app.definition.schemaVersion,
          session_id: sessionId,
          expected_revision: 15,
          request_id: "agent-save",
        }),
      ),
      (error: unknown) =>
        (error as { envelope?: { code?: string; details?: { message?: string }[] } }).envelope
          ?.details?.[0]?.message === "operation requires a human",
    );

    // One MCP round trip over Streamable HTTP for the same verified agent.
    const mcp = createWorkSessionMcpHandler({
      definition: app.definition,
      conversationId: "mcp",
      contextForTurn: handle.contextForTurn,
    });
    const client = new Client({ name: "acceptance", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://app.test/mcp"), {
        fetch: (target, init) => mcp.fetch(new Request(target, init)),
      }),
    );
    try {
      const result = await client.callTool({
        name: "read_entries",
        arguments: { session_id: sessionId, source: "agent" },
      });
      assert.notEqual(result.isError, true);
      const text = (result.content as { text: string }[])[0]!.text;
      assert.deepEqual(
        (JSON.parse(text).entries as { value: string }[]).map((e) => e.value),
        ["25"],
      );
    } finally {
      await client.close();
      await mcp.close();
    }

    // The agent changes a human's staged edit with a rule note; the human's
    // value stays for Restore.
    await data.workSessions.request({
      operation: "stage",
      session_id: sessionId,
      changes: [
        {
          model_id: "item",
          record_id: first!,
          field_id: "score",
          value: { type: "number", value: "11" },
        },
      ],
    });
    const replaced = await ok(
      "stage_changes",
      {
        session_id: sessionId,
        changes: [{ model: "Item", record_id: first, column: "Score", value: "12" }],
        rule: { description: "Raise to the floor" },
      },
      "over-human",
    );
    assert.deepEqual(
      (replaced.entries as { value: string; rule_note: string; replaced: { value: string } }[]).map(
        (e) => [e.value, e.rule_note, e.replaced.value],
      ),
      [["12", "Raise to the floor", "11"]],
    );
    // It resolves a thread, moves the as-of date and edits a note unit.
    const second_thread = await ok(
      "open_thread",
      { session_id: sessionId, expected_revision: 20 },
      "thread-2",
    );
    await ok(
      "resolve_thread",
      { session_id: sessionId, expected_revision: 21, thread_id: second_thread.thread_id },
      "resolve",
    );
    await ok("set_as_of", { session_id: sessionId, as_of: "2026-01-02" }, "as-of");
    const note = await ok(
      "add_unit",
      { session_id: sessionId, kind: "note", text: "Check the floor" },
      "note",
    );
    const edited = await ok(
      "update_unit",
      { session_id: sessionId, unit_id: note.unit_id, text: "Floor checked" },
      "note-edit",
    );
    assert.equal(edited.text, "Floor checked");
    const moved_on = await ok("describe_workspace", { session_id: sessionId }, "described");
    const header = moved_on.session as { as_of: string; revision: number };
    assert.equal(header.as_of, "2026-01-02");
    assert.equal(header.revision, 25);
  } finally {
    await handle.close();
  }

  // The human reviews and Saves: Save always writes a draft, which a declared
  // policy refuses (policy-aware drafts are a follow-up); published data
  // stays as it was until an approver approves the draft.
  const save = () =>
    data.workSessions.request({
      operation: "save",
      session_id: sessionId,
      expected_revision: 25,
      request_id: "save",
    });
  if (app.policy)
    await assert.rejects(
      save(),
      (error: unknown) =>
        (error as { envelope?: { code?: string } }).envelope?.code === "unsupported_capability",
    );
  else {
    const saved = await save();
    assert.notEqual(saved.change_set, null);
    assert.equal("mode" in saved, false);
  }
  const after = await data.item!.list({
    asOf: "2026-01-02",
    orderBy: [{ field: "score", direction: "asc" }],
    select: ["id", "score"],
  });
  assert.deepEqual(
    after.map((row) => (row as unknown as { score: string }).score),
    ["10", "20"],
  );
}

/**
 * An agent never removes a human's staged edit: unstaging it is refused, and
 * staging the saved value over it keeps an agent entry with the human's value
 * as `replaced`, so the person can Restore it.
 */
async function agentKeepsHumanEdit(app: InstalledApp) {
  const people = human(app);
  const data = createDataClient(app.definition, people) as unknown as Record<
    string,
    {
      create(values: unknown, options: unknown): Promise<unknown>;
      update(target: unknown, values: unknown, options: unknown): Promise<unknown>;
      list(input: unknown): Promise<{ id: string }[]>;
    }
  > & { workSessions: ReturnType<typeof createDataClient>["workSessions"] };
  await data.item!.create(
    { owner: "person", score: "10", phase: "draft" },
    { effectiveStart: "2026-01-01", idempotencyKey: `${app.app}-cleared-seed` },
  );
  const [record] = (await data.item!.list({ asOf: "2026-01-01", select: ["id"] })).map(
    (row) => row.id,
  );
  const sessionId = randomUUID();
  await data.workSessions.request({
    operation: "create",
    session_id: sessionId,
    expected_revision: 0,
    request_id: "create",
    title: "Cleared",
    as_of: "2026-01-01",
  });
  await data.workSessions.request({
    operation: "stage",
    session_id: sessionId,
    changes: [
      {
        model_id: "item",
        record_id: record!,
        field_id: "score",
        value: { type: "number", value: "12" },
      },
    ],
  });
  const handle = await agent(app);
  try {
    const core = createWorkSessionToolCore(app.definition);
    const turn = randomUUID();
    const ok = async (tool: string, args: Record<string, unknown>, callId: string) => {
      const result = await core.call(tool, args, {
        context: handle.contextForTurn(turn),
        conversationId: "cleared",
        callId,
      });
      assert.equal(result.ok, true, `${app.app} ${tool}: ${JSON.stringify(result)}`);
      return (result as { data: Record<string, unknown> }).data;
    };
    const target = { model: "Item", record_id: record, column: "Score" };
    // An agent may not unstage the person's edit.
    const refused = await core.call(
      "unstage",
      { session_id: sessionId, ...target },
      { context: handle.contextForTurn(turn), conversationId: "cleared", callId: "clear" },
    );
    assert.equal(refused.ok, false);
    assert.equal(
      (refused as { error: { code: string } }).error.code,
      "authorization_denied",
      JSON.stringify(refused),
    );
    // Staging the saved value over it keeps the person's value for Restore.
    const staged = await ok(
      "stage_changes",
      { session_id: sessionId, changes: [{ ...target, value: "10" }] },
      "back",
    );
    assert.deepEqual(staged.removed, []);
    const [entry] = staged.entries as {
      value: string;
      author_kind: string;
      replaced?: { value: string; author_kind: string };
    }[];
    assert.equal(entry!.author_kind, "agent");
    assert.equal(entry!.value, "10");
    assert.deepEqual(entry!.replaced, { value: "12", author_kind: "human" });
    const page = await ok("read_entries", { session_id: sessionId }, "read");
    assert.equal((page.entries as unknown[]).length, 1);
  } finally {
    await handle.close();
  }
}

/**
 * The agent starts a session for the person over MCP (like `git checkout -b`):
 * it is the person's, one grid per model, arranged; the agent goes
 * on to build the canvas, and Save stays the person's.
 */
async function agentStartsSession(app: InstalledApp) {
  const data = createDataClient(app.definition, human(app));
  const handle = await agent(app);
  const mcp = createWorkSessionMcpHandler({
    definition: app.definition,
    conversationId: "start",
    contextForTurn: handle.contextForTurn,
  });
  const client = new Client({ name: "acceptance", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://app.test/mcp"), {
      fetch: (target, init) => mcp.fetch(new Request(target, init)),
    }),
  );
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { text: string }[])[0]!.text;
    assert.notEqual(result.isError, true, `${name}: ${text}`);
    return { result, text };
  };
  try {
    const { result, text } = await call("create_session", {
      title: "Agent canvas",
      as_of: "2026-03-01",
    });
    const sessionId = (result.structuredContent as { session_id: string }).session_id;
    assert.match(text, /Started "Agent canvas" \(session [0-9a-f-]{36}\), as of 2026-03-01\./u);
    // The person owns it and reads it: one grid per model, arranged; no app layout.
    const [listed] = await data.workSessions.request({ operation: "list" });
    assert.equal(listed!.id, sessionId);
    assert.equal(listed!.owner_id, "person");
    assert.deepEqual(listed!.scope, { models: ["item"] });
    const layout = listed!.layout as {
      mode: string;
      units: { kind: string; x: number; y: number; w: number }[];
    };
    assert.equal(layout.mode, "grid");
    assert.deepEqual(
      layout.units.map((unit) => [unit.kind, unit.x, unit.y, unit.w]),
      [["grid", 80, 24, 1560]],
    );
    // A retried call (same JSON-RPC id is not reachable here; same core call id is) replays.
    const core = createWorkSessionToolCore(app.definition);
    const again = { context: handle.contextForTurn(randomUUID()), conversationId: "c", callId: 7 };
    const first = await core.call("create_session", { title: "Twice" }, again);
    const second = await core.call("create_session", { title: "Twice" }, again);
    assert.deepEqual(second, first);
    // The agent builds the canvas, then tidies it.
    await call("add_unit", {
      session_id: sessionId,
      kind: "chart",
      model: "Item",
      group_by: "Phase",
    });
    await call("add_unit", { session_id: sessionId, kind: "note", text: "Read me" });
    const arranged = JSON.parse(
      (await call("arrange_layout", { session_id: sessionId, mode: "auto" })).text,
    ) as { mode: string; units: { kind: string; y: number; span: number }[] };
    assert.equal(arranged.mode, "grid");
    assert.deepEqual(
      arranged.units.map((unit) => [unit.kind, unit.span]),
      [
        ["grid", 12],
        ["chart", 6],
        ["note", 6],
      ],
    );
    assert.equal(arranged.units[1]!.y, arranged.units[2]!.y);
    // Save stays the person's.
    const work = createDataClient(app.definition, handle.contextForTurn(randomUUID())).workSessions;
    await assert.rejects(
      work.request({
        operation: "save",
        session_id: sessionId,
        expected_revision: 3,
        request_id: "agent-save",
      }),
      /authorization_denied|does not allow/u,
    );
  } finally {
    await client.close();
    await mcp.close();
    await handle.close();
  }
}

// Needs PostgreSQL binaries and the schema compiler; `mise run test:work-session-tools` runs it.
describe.skipIf(process.env.WORK_SESSION_TOOLS_POSTGRES !== "1")(
  "work-session tools over PostgreSQL",
  () => {
    beforeAll(startPostgres, 120_000);
    afterAll(stopPostgres, 120_000);
    test.each([
      ["tools-policy", true],
      ["tools-open", false],
    ] as const)(
      "%s: each tool, retries, conflicts, the agent context and a human Save",
      async (app, policy) => {
        await exercise(await install(app, policy));
      },
      600_000,
    );
    test("an agent starts a session for the person and builds its canvas", async () => {
      await agentStartsSession(await install("tools-start", true));
    }, 600_000);
    test("an agent may not remove a human edit; staging mainline over it keeps it", async () => {
      await agentKeepsHumanEdit(await install("tools-cleared", false));
    }, 600_000);
  },
);
