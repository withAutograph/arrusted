import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, test } from "vitest";
import { createWorkSessionChatTools, workSessionToolLabels } from "../chat";
import { workSessionRequestId, workSessionToolSpecs } from "../core";
import { CANVAS_RESOURCE_URI, createWorkSessionMcpHandler, mcpConversationId } from "../mcp";
import { definition, entry, fakeContext, header, recordId, sessionId } from "./fixture";

test("MCP: a verified agent lists and calls the tools over Streamable HTTP", async () => {
  const h = fakeContext(({ input }) =>
    input.operation === "stage"
      ? { revision: 4, entries: [], removed: [] }
      : input.operation === "thread_resolve"
        ? { revision: 5 }
        : header,
  );
  const turns: string[] = [];
  const handler = createWorkSessionMcpHandler({
    definition,
    conversationId: "mcp-connection",
    contextForTurn: (turnId) => {
      turns.push(turnId);
      return h.context;
    },
  });
  const client = new Client({ name: "tools-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://app.test/mcp"), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    }),
  );
  try {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(workSessionToolSpecs.map((spec) => spec.id));
    expect(tools.find((tool) => tool.name === "list_sessions")?.annotations?.readOnlyHint).toBe(
      true,
    );
    const described = await client.callTool({
      name: "describe_workspace",
      arguments: { session_id: sessionId },
    });
    expect(described.isError).toBeFalsy();
    const text = (described.content as { type: string; text: string }[])[0]!.text;
    expect(JSON.parse(text)).toMatchObject({ session: { session_id: sessionId, revision: 3 } });
    const staged = await client.callTool({
      name: "stage_changes",
      arguments: {
        session_id: sessionId,
        changes: [{ model: "Item", record_id: recordId, column: "Score", value: "4" }],
      },
    });
    expect(staged.isError).toBeFalsy();
    const failed = await client.callTool({
      name: "stage_changes",
      arguments: {
        session_id: sessionId,
        changes: [{ model: "Item", record_id: recordId, column: "Salary", value: "4" }],
      },
    });
    expect(failed.isError).toBe(true);
    const resolved = await client.callTool({
      name: "resolve_thread",
      arguments: { session_id: sessionId, expected_revision: 4, thread_id: "t" },
    });
    expect(resolved.isError).toBeFalsy();
    // One turn per tool call, each a fresh UUID.
    expect(turns).toHaveLength(4);
    expect(new Set(turns).size).toBe(4);
    // Staging is last-write-wins: no request id.
    expect(h.calls.find((call) => call.input.operation === "stage")!.input).not.toHaveProperty(
      "request_id",
    );
    const stage = h.calls.find((call) => call.input.operation === "thread_resolve")!;
    expect(String(stage.input.request_id)).toMatch(/^agent:/u);
    // The client numbers its JSON-RPC ids; the request ID derives from the
    // numeric id, never its string form.
    const ids = Array.from({ length: 50 }, (_, id) => id);
    const numeric = ids.find(
      (id) =>
        workSessionRequestId(
          mcpConversationId("mcp-connection", undefined),
          id,
          "resolve_thread",
        ) === stage.input.request_id,
    );
    expect(numeric).toBeDefined();
    expect(stage.input.request_id).not.toBe(
      workSessionRequestId(
        mcpConversationId("mcp-connection", undefined),
        String(numeric),
        "resolve_thread",
      ),
    );
  } finally {
    await client.close();
    await handler.close();
  }
});

test("chat: tools run the same core with the turn's context and the call id", async () => {
  const h = fakeContext(() => ({ revision: 4, entries: [], removed: [] }));
  const tools = createWorkSessionChatTools({
    definition,
    conversationId: "chat-thread",
    context: h.context,
  });
  expect(tools.map((tool) => tool.definition.id)).toEqual(
    workSessionToolSpecs.map((spec) => spec.id),
  );
  expect(tools.every((tool) => tool.definition.groupId === "work_session")).toBe(true);
  const stage = tools.find((tool) => tool.definition.id === "resolve_thread")!;
  const args = { session_id: sessionId, expected_revision: 3, thread_id: "t" };
  await stage.execute(args, { toolCallId: "tool-1", messages: [], context: undefined });
  await stage.execute(args, { toolCallId: "tool-1", messages: [], context: undefined });
  expect(h.calls[0]!.input.request_id).toBe(h.calls[1]!.input.request_id);
  expect(workSessionToolLabels.stage_changes).toBe("Staging changes");
});

test("MCP: the same JSON-RPC id under two MCP sessions gives distinct request ids", () => {
  const first = mcpConversationId("route-connection", "session-a");
  const second = mcpConversationId("route-connection", "session-b");
  expect(workSessionRequestId(first, 1, "stage_changes")).not.toBe(
    workSessionRequestId(second, 1, "stage_changes"),
  );
  expect(mcpConversationId("route-connection", undefined)).not.toBe(first);
});

/** One schema-valid input per tool, with the kernel operation it must reach. */
const validInputs: Record<string, [Record<string, unknown>, string | null]> = {
  list_sessions: [{}, "list"],
  describe_workspace: [{ session_id: sessionId }, "get"],
  read_entries: [
    {
      session_id: sessionId,
      after: { model: "Item", record_id: recordId, column: "Score" },
      limit: 5,
    },
    "entries",
  ],
  find_records: [
    {
      session_id: sessionId,
      model: "Item",
      columns: ["Score"],
      where: [{ column: "Stage", op: "eq", value: "Done" }],
      search: { query: "a", columns: ["Owner"] },
      order_by: [{ column: "Score", direction: "desc" }],
      limit: 5,
      offset: 0,
    },
    "kernel_data_query",
  ],
  aggregate: [
    {
      session_id: sessionId,
      model: "Item",
      group_by: ["Stage", { column: "Score", edges: ["0", "10"] }],
      metrics: [{ fn: "count" }, { fn: "percentile", column: "Score", p: 0.5 }],
    },
    "kernel_data_query",
  ],
  field_options: [{ model: "Item", column: "Stage" }, null],
  record_history: [{ model: "Item", record_id: recordId, limit: 5 }, "kernel_field_history"],
  propose_records: [
    { session_id: sessionId, model: "Item", rows: [{ values: { Owner: "Jane" } }] },
    "get",
  ],
  import_csv: [
    { session_id: sessionId, model: "Item", csv: "owner\nJane", mapping: { owner: "Owner" } },
    "get",
  ],
  stage_changes: [
    {
      session_id: sessionId,
      changes: [{ model: "Item", record_id: recordId, column: "Notes", value: { any: ["json"] } }],
    },
    "stage",
  ],
  unstage: [
    {
      session_id: sessionId,
      model: "Item",
      record_id: recordId,
      column: "Score",
    },
    "unstage",
  ],
  discard_mine: [{ session_id: sessionId }, "discard_source"],
  revert_turn: [
    {
      session_id: sessionId,
      turn_id: "00000000-0000-4000-8000-0000000000a1",
    },
    "discard_turn",
  ],
  open_thread: [
    {
      session_id: sessionId,
      expected_revision: 3,
      anchor: { model: "Item", record_id: recordId, column: "Score" },
    },
    "thread_open",
  ],
  propose_changes: [
    {
      session_id: sessionId,
      expected_revision: 3,
      thread_id: "t",
      changes: [{ model: "Item", record_id: recordId, column: "Related items", value: [recordId] }],
    },
    "propose",
  ],
  reply: [
    { session_id: sessionId, expected_revision: 3, thread_id: "t", message: "hi" },
    "thread_reply",
  ],
  dismiss_proposal: [{ session_id: sessionId, expected_revision: 3, thread_id: "t" }, "dismiss"],
  create_rule: [
    {
      session_id: sessionId,
      expected_revision: 3,
      model: "Item",
      column: "Score",
      description: "double",
      value: {
        type: "multiply",
        left: { type: "field", field: "Score" },
        right: { type: "parameter", parameter: "k" },
      },
      condition: {
        type: "compare",
        op: "gt",
        left: { type: "field", field: "Score" },
        right: { type: "literal", value: { type: "number", value: "1" } },
      },
      parameters: { k: { type: "number", value: "2" } },
    },
    "rule_create",
  ],
  set_rule_parameters: [
    {
      session_id: sessionId,
      expected_revision: 3,
      rule_id: "r",
      parameters: { k: { type: "number", value: "3" } },
    },
    "rule_parameters",
  ],
  remove_rule: [{ session_id: sessionId, expected_revision: 3, rule_id: "r" }, "rule_remove"],
  resolve_thread: [
    { session_id: sessionId, expected_revision: 3, thread_id: "t" },
    "thread_resolve",
  ],
  request_save: [
    { session_id: sessionId, expected_revision: 3, reason: "Ready to Save" },
    "save_request",
  ],
  set_as_of: [{ session_id: sessionId, as_of: "2026-02-01" }, "update"],
  add_unit: [{ session_id: sessionId, kind: "grid", model: "Item" }, "update"],
  update_unit: [{ session_id: sessionId, unit_id: "u", model: "Item" }, "get"],
  move_unit: [{ session_id: sessionId, unit_id: "u", x: 10, w: 200 }, "update"],
  remove_unit: [{ session_id: sessionId, unit_id: "u" }, "update"],
  create_session: [{ title: "Started by the agent", as_of: "2028-02-29" }, "create"],
  arrange_layout: [{ session_id: sessionId, mode: "auto" }, "update"],
};

test("MCP: every tool's schema-valid input passes validation and dispatches", async () => {
  expect(Object.keys(validInputs).toSorted()).toEqual(
    workSessionToolSpecs.map((spec) => spec.id).toSorted(),
  );
  const touched = { revision: 4, entries: [], removed: [] };
  const h = fakeContext(({ operation, input }) => {
    if (operation === "kernel_data_query")
      return input.kind === "list"
        ? []
        : { as_of: "2026-01-01", units: [null, null], groups: [], total: { metrics: ["0", null] } };
    if (operation === "kernel_field_history") return [];
    switch (input.operation) {
      case "list":
        return [header];
      case "get":
        return {
          ...header,
          layout: {
            units: [
              { id: "u", kind: "grid", config: { model_id: "item" }, x: 0, y: 0, w: 9, h: 9 },
            ],
          },
        };
      case "entries":
        return { revision: 3, entries: [], has_more: false, next: null };
      case "create":
        return { revision: 1, session_id: input.session_id };
      case "save_request":
        return { revision: 4, thread: { id: input.thread_id, kind: "save_request" } };
      case "thread_open":
        return {
          revision: 4,
          thread: { id: input.thread_id, anchor: {}, resolved: false, messages: [] },
        };
      case "propose":
        return { revision: 4, proposal: { changes: [], author_kind: "agent" } };
      case "thread_reply":
        return { revision: 4, message: { id: "m" } };
      case "dismiss":
        return { revision: 4 };
      case "rule_create":
      case "rule_parameters":
        return { ...touched, rule: null, overlaps: [] };
      default:
        return touched;
    }
  });
  const handler = createWorkSessionMcpHandler({
    definition,
    conversationId: "dispatch",
    contextForTurn: () => h.context,
  });
  const client = new Client({ name: "tools-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://app.test/mcp"), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    }),
  );
  try {
    for (const [tool, [args, reaches]] of Object.entries(validInputs)) {
      const before = h.calls.length;
      const result = await client.callTool({ name: tool, arguments: args });
      expect(result.isError, `${tool}: ${JSON.stringify(result.content)}`).toBeFalsy();
      const made = h.calls.slice(before);
      if (reaches === null) expect(made, tool).toEqual([]);
      else
        expect(
          made.some((call) => call.operation === reaches || call.input.operation === reaches),
          tool,
        ).toBe(true);
    }
  } finally {
    await client.close();
    await handler.close();
  }
});

test("MCP: the canvas resource and open_canvas, standing alone as text", async () => {
  let twin = false;
  const h = fakeContext(({ input }) =>
    input.operation === "create"
      ? { revision: 1, session_id: input.session_id }
      : input.operation === "list"
        ? twin
          ? [header, { ...header, id: "00000000-0000-4000-8000-0000000000aa" }]
          : [header]
        : {
            // The agent reads entries in pages, as its context allows.
            revision: 3,
            has_more: false,
            next: null,
            entries: [
              entry("stage", { type: "enum", value: "open" }),
              entry("stage", { type: "enum", value: "done" }),
            ],
          },
  );
  const read = async () => ({
    uri: CANVAS_RESOURCE_URI,
    mimeType: "text/html;profile=mcp-app",
    text: "<html><head></head><body></body></html>",
    _meta: {
      ui: { csp: { connectDomains: ["https://apps.test"] }, domain: "x.claudemcpcontent.com" },
    },
  });
  const handler = createWorkSessionMcpHandler({
    definition,
    conversationId: "mcp-connection",
    contextForTurn: () => h.context,
    canvas: { read, webLink: (id) => `https://apps.test/app/${id}` },
  });
  const client = new Client({ name: "tools-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://app.test/mcp"), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    }),
  );
  try {
    expect(client.getInstructions()).toContain("Call open_canvas");
    const { tools } = await client.listTools();
    const open = tools.find((tool) => tool.name === "open_canvas");
    expect(open?._meta).toMatchObject({ ui: { resourceUri: CANVAS_RESOURCE_URI } });
    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri)).toEqual([CANVAS_RESOURCE_URI]);
    const contents = (await client.readResource({ uri: CANVAS_RESOURCE_URI })).contents[0]!;
    expect(contents.mimeType).toBe("text/html;profile=mcp-app");
    expect(contents._meta).toMatchObject({ ui: { domain: "x.claudemcpcontent.com" } });
    for (const session of [sessionId, header.title.toUpperCase()]) {
      const opened = await client.callTool({ name: "open_canvas", arguments: { session } });
      expect(opened.isError, JSON.stringify(opened.content)).toBeFalsy();
      expect(opened.structuredContent).toEqual({ session_id: sessionId });
      const text = (opened.content as { text: string }[])[0]!.text;
      expect(text).toContain(header.title);
      expect(text).toContain("2 staged changes");
      expect(text).toContain(`https://apps.test/app/${sessionId}`);
    }
    // Only what the agent context may read: the list and entry pages.
    expect(h.calls.map((call) => call.input.operation)).not.toContain("get");
    const missing = await client.callTool({ name: "open_canvas", arguments: { session: "nope" } });
    expect(missing.isError).toBe(true);
    // Two sessions share a title: an error naming the ambiguity, never the first.
    twin = true;
    const ambiguous = await client.callTool({
      name: "open_canvas",
      arguments: { session: header.title },
    });
    expect(ambiguous.isError).toBe(true);
    expect((ambiguous.content as { text: string }[])[0]!.text).toContain(
      `2 active sessions are titled "${header.title}"`,
    );
    expect(ambiguous.structuredContent).toBeUndefined();
    // By id it still opens.
    const byId = await client.callTool({ name: "open_canvas", arguments: { session: sessionId } });
    expect(byId.structuredContent).toEqual({ session_id: sessionId });
    // A session the agent starts shows in the chat too; its text stands alone.
    expect(client.getInstructions()).toContain("create_session");
    const create = tools.find((tool) => tool.name === "create_session");
    expect(create?._meta).toMatchObject({ ui: { resourceUri: CANVAS_RESOURCE_URI } });
    const started = await client.callTool({
      name: "create_session",
      arguments: { title: "Q3 merit", as_of: "2026-07-01" },
    });
    expect(started.isError, JSON.stringify(started.content)).toBeFalsy();
    const created = h.calls.find((call) => call.input.operation === "create")!.input;
    expect(started.structuredContent).toEqual({ session_id: created.session_id });
    const startedText = (started.content as { text: string }[])[0]!.text;
    expect(startedText).toContain('"Q3 merit"');
    expect(startedText).toContain(String(created.session_id));
    expect(startedText).toContain("as of 2026-07-01");
    expect(startedText).toContain(`https://apps.test/app/${String(created.session_id)}`);
  } finally {
    await client.close();
    await handler.close();
  }
});

test("MCP: without a built view, open_canvas answers in text and no resource is offered", async () => {
  const h = fakeContext(({ input }) =>
    input.operation === "list"
      ? [header]
      : { revision: 3, has_more: false, next: null, entries: [] },
  );
  const handler = createWorkSessionMcpHandler({
    definition,
    conversationId: "mcp-connection",
    contextForTurn: () => h.context,
    canvas: { webLink: (id) => `https://apps.test/app/${id}` },
  });
  const client = new Client({ name: "tools-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://app.test/mcp"), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    }),
  );
  try {
    expect(client.getServerCapabilities()?.resources).toBeUndefined();
    const { tools } = await client.listTools();
    const open = tools.find((tool) => tool.name === "open_canvas");
    expect(open).toBeDefined();
    expect(open?._meta).toBeUndefined();
    expect(tools.find((tool) => tool.name === "create_session")?._meta).toBeUndefined();
    const opened = await client.callTool({
      name: "open_canvas",
      arguments: { session: sessionId },
    });
    expect(opened.isError).toBeFalsy();
    expect((opened.content as { text: string }[])[0]!.text).toContain(
      `https://apps.test/app/${sessionId}`,
    );
  } finally {
    await client.close();
    await handler.close();
  }
});
