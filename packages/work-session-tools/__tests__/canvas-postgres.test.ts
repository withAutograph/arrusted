// @vitest-environment node
// Owned-PostgreSQL round trip for the canvas: a real CanvasClient (the work
// session client and data client over a PostgreSQL data context) driven
// through the calls `useCanvasSession` makes — the coherent read (header
// without the overlay plus every entries page of one revision), last-write-wins
// edits, other mutations at the revision shown with a fresh request id — with
// the canvas's own parsers reading what the kernel returns.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, test } from "vitest";
import {
  createDataClient,
  createWorkSessionClient,
  isWorkEdit,
  type WorkChange,
  type WorkEntriesPage,
  type WorkSessionClient,
  type WorkSessionRequest,
} from "@autograph/generated-app-runtime/data";
import type { CanvasClient } from "../../canvas/client";
import { parseLayout, type CanvasLayout } from "../layout";
import { parseThreads } from "../../canvas/threads";
import { groupByTurn } from "../../canvas/use-canvas-session";
import {
  agent,
  human,
  install,
  startPostgres,
  stopPostgres,
  type InstalledApp,
} from "./postgres-fixture";

const num = (value: string) => ({ type: "number" as const, value });
const enumValue = (value: string) => ({ type: "enum" as const, value });

async function roundTrip(app: InstalledApp) {
  const people = human(app);
  const data = createDataClient(app.definition, people) as unknown as Record<
    string,
    {
      create(values: unknown, options: unknown): Promise<unknown>;
      list(input: unknown): Promise<Record<string, unknown>[]>;
      aggregate(input: unknown): Promise<unknown>;
    }
  >;
  // The host's CanvasClient: session and data over the human's context.
  const canvas: CanvasClient = {
    session: createWorkSessionClient(people, app.definition.schemaVersion),
    data: {
      list: (modelId, input) => data[modelId]!.list(input) as never,
      aggregate: (modelId, input) => data[modelId]!.aggregate(input) as never,
    },
    definition: app.definition,
    subscribe: () => () => {},
  };
  for (const [index, score] of ["10", "20"].entries())
    await data.item!.create(
      { owner: "person", score, phase: "draft" },
      { effectiveStart: "2026-01-01", idempotencyKey: `canvas-seed-${index}` },
    );
  const [first, second] = (
    await data.item!.list({
      asOf: "2026-01-01",
      orderBy: [{ field: "score", direction: "asc" }],
      select: ["id", "score"],
    })
  ).map((row) => row.id as string);
  const sessionId = randomUUID();
  await canvas.session.request({
    operation: "create",
    session_id: sessionId,
    expected_revision: 0,
    request_id: randomUUID(),
    title: "Plan",
    as_of: "2026-01-01",
  });

  /** The hook's read: the header without the overlay, then every entries page of its revision. */
  const read = async () => {
    const header = await canvas.session.request({
      operation: "get",
      session_id: sessionId,
      overlay: false,
    });
    const entries: WorkChange[] = [];
    let after: WorkEntriesPage["next"] = null;
    do {
      const page: WorkEntriesPage = await canvas.session.request({
        operation: "entries",
        session_id: sessionId,
        limit: 1,
        ...(after === null ? {} : { after }),
      });
      assert.equal(page.revision, header.revision, "entries pages share the header's revision");
      entries.push(...page.entries);
      after = page.has_more ? page.next : null;
    } while (after !== null);
    return { header, entries };
  };
  let shown = await read();
  /**
   * One mutation: an edit as is, any other at the revision shown with a fresh
   * request id; it re-reads either way.
   */
  const send = async (
    input: Record<string, unknown>,
    client: WorkSessionClient = canvas.session,
  ) => {
    try {
      const request = { ...input, session_id: sessionId } as WorkSessionRequest;
      const result = await client.request(
        isWorkEdit(request)
          ? request
          : ({
              ...request,
              expected_revision: shown.header.revision,
              request_id: randomUUID(),
            } as WorkSessionRequest),
      );
      return result as unknown as Record<string, unknown> & { revision: number };
    } finally {
      // Re-read either way, as the hook does.
      shown = await read();
    }
  };
  const score = (record_id: string, value: string) => ({
    model_id: "item",
    record_id,
    field_id: "score",
    value: num(value),
  });

  const handle = await agent(app);
  try {
    const turn = randomUUID();
    const asAgent = (turnId: string) =>
      createWorkSessionClient(handle.contextForTurn(turnId), app.definition.schemaVersion);

    // The user's edit stages and reverts per change.
    assert.equal((await send({ operation: "stage", changes: [score(first!, "15")] })).revision, 2);
    assert.deepEqual(
      groupByTurn(shown.entries).map((g) => [g.turn_id, g.entries.length]),
      [[null, 1]],
    );
    assert.equal(shown.entries[0]!.author_kind, "human");
    await send({ operation: "unstage", model_id: "item", record_id: first, field_id: "score" });
    assert.equal(shown.entries.length, 0);

    // An agent-marked stage carries its turn and reverts per turn.
    await send({ operation: "stage", changes: [score(second!, "25")] }, asAgent(turn));
    assert.deepEqual(
      groupByTurn(shown.entries).map((g) => [g.turn_id, g.entries.length]),
      [[turn, 1]],
    );
    assert.equal(shown.entries[0]!.author_kind, "agent");
    const discarded = await send({ operation: "discard_turn", turn_id: turn });
    assert.equal((discarded.removed as unknown[]).length, 1);
    assert.equal(shown.entries.length, 0);
    assert.equal(shown.header.revision, 5);

    // A rule stages its matches.
    const ruleId = randomUUID();
    const rule = await send({
      operation: "rule_create",
      rule_id: ruleId,
      rule: {
        model_id: "item",
        field_id: "score",
        value: {
          type: "multiply",
          left: { type: "field", field: "score" },
          right: { type: "parameter", parameter: "factor" },
        },
        condition: {
          type: "compare",
          op: "gte",
          left: { type: "field", field: "score" },
          right: { type: "literal", value: num("20") },
        },
        parameters: { factor: num("2") },
      },
    });
    assert.deepEqual(
      (rule.entries as WorkChange[]).map((e) => [e.record_id, e.value]),
      [[second, num("40")]],
    );
    assert.equal(shown.header.rules[ruleId]?.author_kind, "human");
    assert.deepEqual(
      shown.entries.map((e) => [e.record_id, e.rule_id]),
      [[second, ruleId]],
    );

    // A thread: open on a field, reply, the agent proposes, the user pulls.
    const threadId = randomUUID();
    await send({
      operation: "thread_open",
      thread_id: threadId,
      anchor: { model_id: "item", record_id: first, field_id: "phase" },
    });
    await send({ operation: "thread_reply", thread_id: threadId, message: "Mark it done?" });
    await send(
      {
        operation: "propose",
        thread_id: threadId,
        changes: [
          { model_id: "item", record_id: first, field_id: "phase", value: enumValue("done") },
        ],
      },
      asAgent(randomUUID()),
    );
    const [proposed] = parseThreads(shown.header.threads);
    assert.deepEqual(
      proposed!.messages.map((m) => [m.author_kind, m.message]),
      [["human", "Mark it done?"]],
    );
    assert.equal(proposed!.proposal?.author_kind, "agent");
    assert.equal(proposed!.proposal?.changes.length, 1);
    await send({ operation: "pull", thread_id: threadId });
    assert.equal(parseThreads(shown.header.threads)[0]!.proposal, undefined);
    const pulled = shown.entries.find((e) => e.field_id === "phase")!;
    assert.equal(pulled.thread_id, threadId);
    assert.deepEqual(pulled.value, enumValue("done"));
    // Pulled changes keep the proposal's provenance.
    assert.equal(pulled.author_kind, "agent");

    // A layout drop that meets an agent's stage lands: both are last-write-wins.
    const layout: CanvasLayout = {
      units: [
        { id: "u1", kind: "grid", config: { model_id: "item" }, x: 200, y: 24, w: 400, h: 300 },
      ],
    };
    const seen = shown.header.revision;
    await asAgent(randomUUID()).request({
      operation: "stage",
      session_id: sessionId,
      changes: [score(first!, "12")],
    });
    assert.equal((await send({ operation: "update", patch: { layout } })).revision, seen + 2);
    assert.deepEqual(parseLayout(shown.header.layout), { ok: true, layout });

    // The data client reads over the staged values.
    const overlay = await canvas.data.list("item", {
      asOf: "2026-01-01",
      work: { sessionId },
      orderBy: [{ field: "score", direction: "asc" }],
      select: ["id", "score", "phase"],
    });
    assert.deepEqual(
      overlay.map((row) => [row.id, row.score, row.phase]),
      [
        [first, "12", "done"],
        [second, "40", "draft"],
      ],
    );
  } finally {
    await handle.close();
  }

  // Save at the revision shown: one draft; the overlay clears. Approving the
  // draft (an approver's Save and approve) writes it to published data.
  const saved = await send({ operation: "save" });
  assert.notEqual(saved.change_set, null);
  assert.equal(shown.entries.length, 0);
  await people.transaction((db) =>
    db.call("kernel_approve_draft_change_set", {
      change_set_id: (saved.change_set as { id: number }).id,
    }),
  );
  const after = await data.item!.list({
    asOf: "2026-01-01",
    orderBy: [{ field: "score", direction: "asc" }],
    select: ["id", "score", "phase"],
  });
  assert.deepEqual(
    after.map((row) => [row.id, row.score, row.phase]),
    [
      [first, "12", "done"],
      [second, "40", "draft"],
    ],
  );
}

/**
 * An agent unstages a human's staged edit: the entry is removed (no
 * placeholder) from get and the entries page, and reads show the canonical value.
 */
async function agentUnstageRoundTrip(app: InstalledApp) {
  const people = human(app);
  const data = createDataClient(app.definition, people) as unknown as Record<
    string,
    {
      create(values: unknown, options: unknown): Promise<unknown>;
      list(input: unknown): Promise<Record<string, unknown>[]>;
    }
  >;
  const session = createWorkSessionClient(people, app.definition.schemaVersion);
  await data.item!.create(
    { owner: "person", score: "10", phase: "draft" },
    { effectiveStart: "2026-01-01", idempotencyKey: "cleared-seed" },
  );
  const [record] = (await data.item!.list({ asOf: "2026-01-01", select: ["id"] })).map(
    (row) => row.id as string,
  );
  const sessionId = randomUUID();
  await session.request({
    operation: "create",
    session_id: sessionId,
    expected_revision: 0,
    request_id: randomUUID(),
    title: "Cleared",
    as_of: "2026-01-01",
  });
  const target = { model_id: "item", record_id: record!, field_id: "score" };
  await session.request({
    operation: "stage",
    session_id: sessionId,
    changes: [{ ...target, value: num("12") }],
  });
  const handle = await agent(app);
  try {
    const agentSession = createWorkSessionClient(
      handle.contextForTurn(randomUUID()),
      app.definition.schemaVersion,
    );
    // An agent may not unstage the person's edit.
    await assert.rejects(
      agentSession.request({ operation: "unstage", session_id: sessionId, ...target }),
      (error: { envelope?: { code?: string; details?: { message?: string }[] } }) =>
        error.envelope?.code === "authorization_denied" &&
        error.envelope.details?.[0]?.message === "agents may not unstage a person's change",
    );
    // Staging the saved value over it keeps an agent entry holding the
    // person's value as `replaced`, so Restore brings it back.
    await agentSession.request({
      operation: "stage",
      session_id: sessionId,
      changes: [{ ...target, value: num("10") }],
    });
  } finally {
    await handle.close();
  }
  const got = await session.request({ operation: "get", session_id: sessionId });
  assert.equal(got.overlay.length, 1);
  const [entry] = got.overlay;
  assert.equal(entry!.author_kind, "agent");
  assert.deepEqual(entry!.value, num("10"));
  assert.equal(entry!.replaced?.author_kind, "human");
  assert.deepEqual(entry!.replaced?.value, num("12"));
  const read = await data.item!.list({
    asOf: "2026-01-01",
    work: { sessionId },
    select: ["id", "score"],
  });
  assert.equal(read.find((row) => row.id === record)?.score, "10");
}

// Needs PostgreSQL binaries and the schema compiler; `mise run test:work-session-tools` runs it.
describe.skipIf(process.env.WORK_SESSION_TOOLS_POSTGRES !== "1")("canvas over PostgreSQL", () => {
  beforeAll(startPostgres, 120_000);
  afterAll(stopPostgres, 120_000);
  test("stage, revert per change and per turn, rule, thread pull, layout and Save", async () => {
    // No policy: Save drafts, which a declared policy refuses.
    await roundTrip(await install("canvas-open", false));
  }, 600_000);
  test("an agent may not unstage a human edit; staging mainline over it keeps it for Restore", async () => {
    await agentUnstageRoundTrip(await install("canvas-cleared", true));
  }, 600_000);
});
