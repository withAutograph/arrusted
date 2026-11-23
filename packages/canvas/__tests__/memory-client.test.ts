import { describe, expect, test } from "vite-plus/test";
import { kernelErrorCode } from "../client";
import { guard, ids, memory, money, num, text, edit } from "./fixture";

const score = (record_id: string, value: string) => ({
  model_id: "m_person",
  record_id,
  field_id: "f_score",
  value: num(value),
});
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: unknown) => kernelErrorCode(error),
  );

describe("memory client: revisions and receipts", () => {
  test("edits are last-write-wins: concurrent stages both land, with no conflict", async () => {
    const m = memory();
    const staged = await m.client.session.request({
      operation: "stage",
      ...edit(),
      changes: [score(ids.ada, "5")],
    });
    expect(staged.revision).toBe(2);
    // Both writers read revision 1; neither names it, and the later one wins.
    const later = await m
      .asAgent(ids.turn1)
      .request({ operation: "stage", ...edit(), changes: [score(ids.ada, "6")] });
    expect(later.revision).toBe(3);
    expect(later.entries).toMatchObject([{ value: num("6"), author_kind: "agent" }]);
    expect(
      await code(
        m.client.session.request({
          operation: "stage",
          ...guard(3),
          changes: [score(ids.bo, "5")],
        } as never),
      ),
    ).toBe("contract_validation_failed");
  });

  test("other mutations bump the revision; a stale expected_revision conflicts", async () => {
    const { client } = memory();
    expect(
      (await client.session.request({ operation: "pin", ...guard(1), pinned: true })).revision,
    ).toBe(2);
    expect(
      await code(client.session.request({ operation: "pin", ...guard(1), pinned: false })),
    ).toBe("revision_conflict");
  });

  test("a request id replays an identical request without a second effect", async () => {
    const { client } = memory();
    const request = { operation: "pin", ...guard(1, "same"), pinned: true } as const;
    await client.session.request(request);
    const replay = await client.session.request(request);
    expect(replay.revision).toBe(2);
    expect(
      (await client.session.request({ operation: "get", session_id: ids.session })).revision,
    ).toBe(2);
  });

  test("a reused request id with another payload or expected_revision is an idempotency conflict", async () => {
    const { client } = memory();
    await client.session.request({ operation: "pin", ...guard(1, "once"), pinned: true });
    expect(
      await code(client.session.request({ operation: "pin", ...guard(1, "once"), pinned: false })),
    ).toBe("idempotency_conflict");
    expect(
      await code(client.session.request({ operation: "pin", ...guard(2, "once"), pinned: true })),
    ).toBe("idempotency_conflict");
  });

  test("a failed mutation leaves no effect", async () => {
    const { client } = memory();
    expect(
      await code(
        client.session.request({
          operation: "stage",
          ...edit(),
          changes: [score(ids.ada, "5"), { ...score(ids.bo, "5"), value: text("not a number") }],
        }),
      ),
    ).toBe("contract_validation_failed");
    const session = await client.session.request({ operation: "get", session_id: ids.session });
    expect(session.revision).toBe(1);
    expect(session.overlay).toEqual([]);
  });
});

describe("memory client: staging", () => {
  test("restaging keeps the first baseline; staging back to it unstages", async () => {
    const { client } = memory();
    await client.session.request({
      operation: "stage",
      ...edit(),
      changes: [score(ids.ada, "5")],
    });
    const again = await client.session.request({
      operation: "stage",
      ...edit(),
      changes: [score(ids.ada, "7")],
    });
    expect(again.entries[0]).toMatchObject({ value: num("7"), baseline: num("1"), source: "user" });
    const back = await client.session.request({
      operation: "stage",
      ...edit(),
      changes: [score(ids.ada, "1.0")],
    });
    expect(back.entries).toEqual([]);
    expect(back.removed).toEqual([
      { model_id: "m_person", record_id: ids.ada, field_id: "f_score" },
    ]);
  });

  test("agent entries carry the turn and note; an agent replaces a human's entry, keeping it for Restore", async () => {
    const m = memory();
    const agent = m.asAgent(ids.turn1);
    const staged = await agent.request({
      operation: "stage",
      ...edit(),
      changes: [score(ids.bo, "9")],
    });
    expect(staged.entries[0]).toMatchObject({
      source: "agent",
      author_kind: "agent",
      turn_id: ids.turn1,
    });
    await m.client.session.request({
      operation: "stage",
      ...edit(),
      changes: [score(ids.ada, "5")],
    });
    const replaced = await agent.request({
      operation: "stage",
      ...edit(),
      changes: [score(ids.ada, "6")],
      note: "Scores round up",
    });
    expect(replaced.entries[0]).toMatchObject({
      author_kind: "agent",
      note: "Scores round up",
      replaced: { value: { type: "number", value: "5" }, author_kind: "human", actor_id: "user-1" },
    });
    // The human restores theirs: as the kernel, a human's write clears `replaced`.
    const restored = await m.client.session.request({
      operation: "stage",
      ...edit(),
      changes: [score(ids.ada, "5")],
    });
    expect(restored.entries[0]).toMatchObject({ author_kind: "human" });
    expect(restored.entries[0]!.replaced).toBeUndefined();
    expect(
      await code(
        agent.request({
          operation: "stage",
          ...edit(),
          changes: [score(ids.ada, "7")],
          note: "x".repeat(201),
        }),
      ),
    ).toBe("contract_validation_failed");
    for (const patch of [
      { title: "x" },
      { layout: { units: [] }, title: "x" },
      {},
      { layout: undefined },
    ])
      expect(await code(agent.request({ operation: "update", ...edit(), patch }))).toBe(
        "authorization_denied",
      );
    // The agent may arrange the canvas and move its as-of date; staged entries stay.
    await agent.request({
      operation: "update",
      ...edit(),
      patch: { layout: { units: [] }, as_of: "2026-11-01" },
    });
    const read = await m.client.session.request({ operation: "get", session_id: ids.session });
    expect(read).toMatchObject({ layout: { units: [] }, as_of: "2026-11-01" });
    expect(read.overlay).toHaveLength(2);
    // The agent resolves threads too.
    await m.client.session.request({
      operation: "thread_open",
      ...guard(6),
      thread_id: "t-1",
      anchor: { model_id: "m_person" },
    });
    await agent.request({ operation: "thread_resolve", ...guard(7), thread_id: "t-1" });
  });

  test("unstage, discard_turn and discard_source remove only their entries", async () => {
    const m = memory();
    await m
      .asAgent(ids.turn1)
      .request({ operation: "stage", ...edit(), changes: [score(ids.ada, "5")] });
    await m
      .asAgent(ids.turn2)
      .request({ operation: "stage", ...edit(), changes: [score(ids.bo, "5")] });
    await m.client.session.request({
      operation: "stage",
      ...edit(),
      changes: [score(ids.cy, "5")],
    });
    const turn = await m.client.session.request({
      operation: "discard_turn",
      ...edit(),
      turn_id: ids.turn1,
    });
    expect(turn.removed).toEqual([
      { model_id: "m_person", record_id: ids.ada, field_id: "f_score" },
    ]);
    const agent = await m.client.session.request({
      operation: "discard_source",
      ...edit(),
      source: "agent",
    });
    expect(agent.removed.map((t) => t.record_id)).toEqual([ids.bo]);
    await m.client.session.request({
      operation: "unstage",
      ...edit(),
      model_id: "m_person",
      record_id: ids.cy,
      field_id: "f_score",
    });
    expect(
      (await m.client.session.request({ operation: "get", session_id: ids.session })).overlay,
    ).toEqual([]);
  });

  test("discarding the agent's changes restores the human value it replaced, and answers with it", async () => {
    for (const discard of [
      { operation: "discard_turn" as const, turn_id: ids.turn1 },
      { operation: "discard_source" as const, source: "agent" as const },
    ]) {
      const m = memory();
      await m.client.session.request({
        operation: "stage",
        ...edit(),
        changes: [score(ids.ada, "12")],
      });
      await m
        .asAgent(ids.turn1)
        .request({ operation: "stage", ...edit(), changes: [score(ids.ada, "14")] });
      const answer = await m.client.session.request({ ...discard, ...edit() } as never);
      const answered = answer as unknown as {
        entries: { value: unknown; author_kind: string }[];
        removed: unknown[];
      };
      expect(answered.removed).toEqual([]);
      expect(answered.entries).toMatchObject([{ value: num("12"), author_kind: "human" }]);
      const read = await m.client.session.request({ operation: "get", session_id: ids.session });
      expect(read.overlay).toMatchObject([
        { value: num("12"), author_kind: "human", source: "user" },
      ]);
      expect(read.overlay[0]!.replaced).toBeUndefined();
    }
  });

  test("replaced keeps the human's value and principal through agent writes, as the kernel", async () => {
    const m = memory();
    const get = async () =>
      (await m.client.session.request({ operation: "get", session_id: ids.session })).overlay[0]!;
    await m.client.session.request({
      operation: "stage",
      ...edit(),
      changes: [score(ids.ada, "12")],
    });
    const human = (await get()).author_principal;
    const first = m.asAgent(ids.turn1);
    await first.request({ operation: "stage", ...edit(), changes: [score(ids.ada, "14")] });
    expect((await get()).replaced).toMatchObject({
      value: num("12"),
      author_kind: "human",
      author_principal: human,
    });
    // Discard restores the human's value under the human's principal.
    await m.client.session.request({ operation: "discard_turn", ...edit(), turn_id: ids.turn1 });
    expect(await get()).toMatchObject({
      value: num("12"),
      author_kind: "human",
      author_principal: human,
    });
    expect((await get()).replaced).toBeUndefined();
    // The same agent overwrites again: Restore is offered again.
    await first.request({ operation: "stage", ...edit(), changes: [score(ids.ada, "15")] });
    await first.request({ operation: "stage", ...edit(), changes: [score(ids.ada, "16")] });
    expect((await get()).replaced).toMatchObject({ value: num("12"), author_kind: "human" });
    // A second agent over the first keeps the human's value, never the agent's.
    await m
      .asAgent(ids.turn2, "agent:other")
      .request({ operation: "stage", ...edit(), changes: [score(ids.ada, "17")] });
    expect((await get()).replaced).toMatchObject({ value: num("12"), author_kind: "human" });
  });

  test("an agent over another agent's entry creates no replaced value", async () => {
    const m = memory();
    await m
      .asAgent(ids.turn1)
      .request({ operation: "stage", ...edit(), changes: [score(ids.ada, "14")] });
    await m
      .asAgent(ids.turn2, "agent:other")
      .request({ operation: "stage", ...edit(), changes: [score(ids.ada, "15")] });
    const [entry] = (await m.client.session.request({ operation: "get", session_id: ids.session }))
      .overlay;
    expect(entry!.replaced).toBeUndefined();
  });

  test("entries page by key with has_more and next", async () => {
    const { client } = memory();
    await client.session.request({
      operation: "stage",
      ...edit(),
      changes: [score(ids.cy, "5"), score(ids.ada, "5"), score(ids.bo, "5")],
    });
    const first = await client.session.request({
      operation: "entries",
      session_id: ids.session,
      limit: 2,
    });
    expect(first.entries.map((e) => e.record_id)).toEqual([ids.ada, ids.bo]);
    expect(first).toMatchObject({ has_more: true, next: { record_id: ids.bo } });
    const second = await client.session.request({
      operation: "entries",
      session_id: ids.session,
      limit: 2,
      after: first.next!,
    });
    expect(second).toMatchObject({ has_more: false, next: null });
    expect(second.entries.map((e) => e.record_id)).toEqual([ids.cy]);
  });

  test("get without the overlay returns the header, rules and threads", async () => {
    const { client } = memory();
    await client.session.request({
      operation: "rule_create",
      ...guard(1),
      rule_id: "raise",
      rule: {
        model_id: "m_person",
        field_id: "f_score",
        value: { type: "literal", value: num("1") } as never,
      },
    });
    const header = await client.session.request({
      operation: "get",
      session_id: ids.session,
      overlay: false,
    });
    expect(header).not.toHaveProperty("overlay");
    expect(header.rules.raise).toMatchObject({ author_kind: "human", field_id: "f_score" });
  });
});

describe("memory client: threads and Save", () => {
  test("propose, pull with the proposal's provenance, and dismiss", async () => {
    const m = memory();
    const agent = m.asAgent(ids.turn1);
    await m.client.session.request({
      operation: "thread_open",
      ...guard(1),
      thread_id: "t",
      anchor: { unit_id: "u" },
    });
    await agent.request({
      operation: "propose",
      ...guard(2),
      thread_id: "t",
      changes: [score(ids.ada, "8")],
    });
    expect(await code(agent.request({ operation: "pull", ...guard(3), thread_id: "t" }))).toBe(
      "authorization_denied",
    );
    const pulled = await m.client.session.request({
      operation: "pull",
      ...guard(3),
      thread_id: "t",
    });
    expect(pulled.entries[0]).toMatchObject({ source: "agent", thread_id: "t" });
    expect(pulled.entries[0]).not.toHaveProperty("turn_id");
    expect(
      await code(m.client.session.request({ operation: "dismiss", ...guard(4), thread_id: "t" })),
    ).toBe("proposal_conflict");
  });

  test("Save needs stale entries confirmed, then clears the overlay; a draft leaves canonical rows unchanged", async () => {
    const m = memory();
    await m.client.session.request({
      operation: "stage",
      ...edit(),
      changes: [score(ids.ada, "5")],
    });
    m.writeCanonical("m_person", ids.ada, { f_name: text("Ada L") });
    const [entry] = (await m.client.session.request({ operation: "get", session_id: ids.session }))
      .overlay;
    expect(entry).toMatchObject({ stale: true });
    expect(await code(m.client.session.request({ operation: "save", ...guard(2) }))).toBe(
      "stale_base",
    );
    const saved = await m.client.session.request({
      operation: "save",
      ...guard(2),
      confirmed_stale: [
        {
          model_id: "m_person",
          record_id: ids.ada,
          field_id: "f_score",
          current_version: entry!.current_version!,
        },
      ],
    });
    expect(saved).toMatchObject({ revision: 3, cleared: true });
    expect(m.saves).toHaveLength(1);
    const [ada] = await m.client.data.list("m_person", {
      asOf: "2026-10-01",
      where: [{ field: "name", op: "eq", value: "Ada L" }],
    });
    expect(ada).toMatchObject({ score: "1" });
  });

  test("a Save always writes a draft; approving it applies the staged values", async () => {
    const m = memory({ drafts: true });
    await m.client.session.request({
      operation: "stage",
      ...edit(),
      changes: [score(ids.ada, "5")],
    });
    // A request's own mode is ignored: Save drafts.
    const saved = await m.client.session.request({
      operation: "save",
      ...guard(2),
      ...({ mode: "mainline" } as object),
    });
    expect(saved).toMatchObject({ revision: 3, cleared: true, change_set: { id: 1 } });
    expect(saved).not.toHaveProperty("mode");
    const ada = async () =>
      (
        await m.client.data.list("m_person", {
          asOf: "2026-10-01",
          where: [{ field: "name", op: "eq", value: "Ada" }],
        })
      )[0];
    expect(await ada()).toMatchObject({ score: "1" });
    await m.client.drafts!.kernel.postJson("/api/draft/approve", { change_set_id: 1 });
    expect(await ada()).toMatchObject({ score: "5" });
  });

  test("only an approver approves a saved draft", async () => {
    const m = memory({ drafts: true, canApprove: false });
    await m.client.session.request({
      operation: "stage",
      ...edit(),
      changes: [score(ids.ada, "5")],
    });
    await m.client.session.request({ operation: "save", ...guard(2) });
    expect(
      await code(m.client.drafts!.kernel.postJson("/api/draft/approve", { change_set_id: 1 })),
    ).toBe("authorization_denied");
  });
});

describe("memory client: an agent never removes the person's edit, as the kernel", () => {
  const agentId = "00000000-0000-4000-8000-0000000000c1";
  const ada = { model_id: "m_person", record_id: ids.ada, field_id: "f_score" } as const;
  const overlay = async (m: ReturnType<typeof memory>) =>
    (await m.client.session.request({ operation: "get", session_id: ids.session })).overlay;

  test("an agent may not unstage the person's entry", async () => {
    const m = memory();
    await m.client.session.request({
      operation: "stage",
      ...edit(),
      changes: [score(ids.ada, "5")],
    });
    expect(
      await code(m.asAgent(agentId).request({ operation: "unstage", ...edit(), ...ada })),
    ).toBe("authorization_denied");
    expect(await overlay(m)).toMatchObject([
      { record_id: ids.ada, author_kind: "human", value: { type: "number", value: "5" } },
    ]);
  });

  test("an agent staging the saved value over it keeps the person's value for Restore", async () => {
    const m = memory();
    await m.client.session.request({
      operation: "stage",
      ...edit(),
      changes: [score(ids.ada, "5")],
    });
    const staged = await m
      .asAgent(agentId)
      .request({ operation: "stage", ...edit(), changes: [score(ids.ada, "1")] });
    expect(staged.removed).toEqual([]);
    expect(staged.entries).toMatchObject([
      {
        record_id: ids.ada,
        author_kind: "agent",
        value: { type: "number", value: "1" },
        replaced: { author_kind: "human", value: { type: "number", value: "5" } },
      },
    ]);
    const [row] = await m.client.data.list("m_person", {
      asOf: "2026-10-01",
      where: [{ field: "name", op: "eq", value: "Ada" }],
      work: { sessionId: ids.session },
    });
    expect(row).toMatchObject({ score: "1" });
    // Unstaging its own entry puts the person's value back as theirs.
    const unstaged = await m.asAgent(agentId).request({ operation: "unstage", ...edit(), ...ada });
    expect(unstaged.removed).toEqual([]);
    expect(unstaged.entries).toMatchObject([
      { record_id: ids.ada, author_kind: "human", value: { type: "number", value: "5" } },
    ]);
    expect(unstaged.entries[0]).not.toHaveProperty("replaced");
    // The person still unstages anything.
    await m.client.session.request({ operation: "unstage", ...edit(), ...ada });
    expect(await overlay(m)).toEqual([]);
  });
});

describe("memory client: data over the session", () => {
  test("list applies the overlay only when a session is given", async () => {
    const { client } = memory();
    await client.session.request({
      operation: "stage",
      ...edit(),
      changes: [score(ids.ada, "5")],
    });
    const where = [{ field: "name", op: "eq", value: "Ada" }] as const;
    expect((await client.data.list("m_person", { asOf: "2026-10-01", where }))[0]).toMatchObject({
      score: "1",
    });
    expect(
      (
        await client.data.list("m_person", {
          asOf: "2026-10-01",
          where,
          work: { sessionId: ids.session },
        })
      )[0],
    ).toMatchObject({ score: "5" });
  });

  test("pending drafts overlay canonical rows field by field in save order, under staged values", async () => {
    const m = memory({ drafts: true });
    const read = async (input: Record<string, unknown> = {}) =>
      Object.fromEntries(
        (await m.client.data.list("m_person", { asOf: "2026-10-01", ...input })).map((row) => [
          row.name,
          [row.score, (row.pay as { amount: string } | null)?.amount],
        ]),
      );
    const off = await read();
    // No drafts: the flag changes nothing.
    expect(await read({ includePendingDrafts: true })).toEqual(off);
    const older = m.seedDraft({ actorId: "ravi", changes: [score(ids.ada, "7")] });
    m.seedDraft({
      actorId: "hana",
      changes: [
        { model_id: "m_person", record_id: ids.ada, field_id: "f_pay", value: money("150") },
      ],
    });
    const newer = m.seedDraft({ actorId: "ravi", changes: [score(ids.ada, "8")] });
    m.seedDraft({ actorId: "ravi", as_of: "2026-12-01", changes: [score(ids.bo, "9")] });
    expect(await read()).toEqual(off);
    const on = await read({ includePendingDrafts: true });
    expect(on.Ada).toEqual(["8", "150"]);
    expect(on.Bo).toEqual(["2", "200"]);
    expect((await read({ includePendingDrafts: true, asOf: "2026-12-01" })).Bo).toEqual([
      "9",
      "200",
    ]);
    const total = async (input: Record<string, unknown> = {}) =>
      (
        await m.client.data.aggregate("m_person", {
          asOf: "2026-10-01",
          metrics: [{ fn: "sum", field: "score" }],
          ...input,
        })
      ).total.metrics[0];
    expect(await total({ includePendingDrafts: true })).toBe("13");
    expect(await total()).toBe("6");
    // Staged values win over drafts.
    await m.client.session.request({
      operation: "stage",
      ...edit(),
      changes: [score(ids.ada, "5")],
    });
    expect(
      (await read({ includePendingDrafts: true, work: { sessionId: ids.session } })).Ada,
    ).toEqual(["5", "150"]);
    // A rejected draft drops out; an approved one is counted once.
    await m.client.drafts!.kernel.postJson("/api/draft/discard", { change_set_id: newer });
    expect((await read({ includePendingDrafts: true })).Ada).toEqual(["7", "150"]);
    await m.client.drafts!.kernel.postJson("/api/draft/approve", { change_set_id: older });
    expect((await read({ includePendingDrafts: true })).Ada).toEqual(["7", "150"]);
    expect((await read()).Ada).toEqual(["7", "100"]);
    expect(await total({ includePendingDrafts: true })).toBe("12");
  });

  test("pending drafts create and delete records in save order and say what came from them", async () => {
    const m = memory({ drafts: true });
    const dee = "00000000-0000-4000-8000-0000000000d1";
    const read = async (input: Record<string, unknown> = {}) =>
      await m.client.data.list("m_person", { asOf: "2026-10-01", ...input });
    const names = async (input: Record<string, unknown> = {}) =>
      (await read(input)).map((row) => row.name).toSorted();
    const off = await read();
    expect(off.every((row) => !("pendingDraft" in row))).toBe(true);
    const created = m.seedDraft({
      actorId: "ravi",
      changes: [],
      creates: [
        {
          model_id: "m_person",
          record_id: dee,
          values: { f_name: text("Dee"), f_score: num("4") },
        },
      ],
    });
    const changed = m.seedDraft({ actorId: "ravi", changes: [score(ids.ada, "7")] });
    const deleted = m.seedDraft({
      actorId: "hana",
      changes: [],
      deletes: [{ model_id: "m_person", record_id: ids.bo }],
    });
    // Off: published data, with no provenance.
    expect(await read()).toEqual(off);
    expect(await names({ includePendingDrafts: true })).toEqual(["Ada", "Cy", "Dee"]);
    const on = Object.fromEntries(
      (await read({ includePendingDrafts: true })).map((row) => [row.name, row.pendingDraft]),
    );
    expect(on.Dee).toEqual({ created, fields: { name: created, score: created } });
    expect(on.Ada).toEqual({ fields: { score: changed } });
    const count = await m.client.data.aggregate("m_person", {
      asOf: "2026-10-01",
      includePendingDrafts: true,
      metrics: [{ fn: "count" }],
    });
    expect(count.total.metrics).toEqual(["3"]);
    // A later change of the deleted record shows it again (latest save wins).
    m.seedDraft({ actorId: "ravi", changes: [score(ids.bo, "9")] });
    expect(await names({ includePendingDrafts: true })).toEqual(["Ada", "Bo", "Cy", "Dee"]);
    // A staged value no longer comes from the draft.
    await m.client.session.request({
      operation: "stage",
      ...edit(),
      changes: [score(ids.ada, "5")],
    });
    const staged = await read({ includePendingDrafts: true, work: { sessionId: ids.session } });
    expect(staged.find((row) => row.name === "Ada")).not.toHaveProperty("pendingDraft");
    // A "creation" of a record that already exists is no creation: its
    // values overlay the published record.
    const over = m.seedDraft({
      actorId: "ravi",
      changes: [],
      creates: [{ model_id: "m_person", record_id: ids.cy, values: { f_score: num("6") } }],
    });
    const cy = (await read({ includePendingDrafts: true })).find((row) => row.name === "Cy");
    expect(cy).toMatchObject({ score: "6", pendingDraft: { fields: { score: over } } });
    expect(cy?.pendingDraft).not.toHaveProperty("created");
    // Approved, the creation and deletion are published.
    await m.client.drafts!.kernel.postJson("/api/draft/approve", { change_set_id: created });
    await m.client.drafts!.kernel.postJson("/api/draft/approve", { change_set_id: deleted });
    expect(await names()).toEqual(["Ada", "Cy", "Dee"]);
    // Review sees a creation's values and a deletion, and counts their records.
    const kernel = m.client.drafts!.kernel;
    type Diff = {
      records: {
        record_id: string;
        after_tombstones_record: boolean;
        fields: { field_id: string; before: unknown; after: unknown }[];
      }[];
    };
    const createdDiff = await kernel.postJson<Diff>("/api/diff", { change_set_id: created });
    expect(createdDiff.records).toEqual([
      expect.objectContaining({
        record_id: dee,
        after_tombstones_record: false,
        fields: [
          { field_id: "f_name", before: null, after: text("Dee") },
          { field_id: "f_score", before: null, after: num("4") },
        ],
      }),
    ]);
    const deletedDiff = await kernel.postJson<Diff>("/api/diff", { change_set_id: deleted });
    expect(deletedDiff.records).toEqual([
      expect.objectContaining({ record_id: ids.bo, after_tombstones_record: true, fields: [] }),
    ]);
    const activity = await kernel.postJson<
      { change_set_id: number; touched_record_count: number }[]
    >("/api/activity", {});
    const touchedBy = (id: number) => activity.find((entry) => entry.change_set_id === id);
    expect(touchedBy(created)?.touched_record_count).toBe(1);
    expect(touchedBy(deleted)?.touched_record_count).toBe(1);
    // Reverting them undoes them: the created record goes, the deleted one returns.
    await kernel.postJson("/api/revert", { change_set_id: created });
    await kernel.postJson("/api/revert", { change_set_id: deleted });
    expect(await names()).toEqual(["Ada", "Bo", "Cy"]);
    // A "creation" over a published record: approval overlays its values,
    // and a revert restores the values it overwrote, keeping the record.
    const scoreOf = async (name: string) => (await read()).find((row) => row.name === name)?.score;
    const before = await scoreOf("Cy");
    await kernel.postJson("/api/draft/approve", { change_set_id: over });
    expect(await scoreOf("Cy")).toBe("6");
    await kernel.postJson("/api/revert", { change_set_id: over });
    expect(await scoreOf("Cy")).toBe(before);
    expect(await names()).toEqual(["Ada", "Bo", "Cy"]);
  });

  test("aggregate counts and sums by group, keeping money per currency and period", async () => {
    const { client } = memory();
    const result = await client.data.aggregate("m_person", {
      asOf: "2026-10-01",
      groupBy: ["team"],
      metrics: [{ fn: "count" }, { fn: "sum", field: "score" }, { fn: "sum", field: "pay" }],
    });
    expect(result.groups).toEqual([
      { key: ["eng", { unit: { currency: "USD", period: "annual" } }], metrics: ["2", "3", "300"] },
      { key: ["ops", { unit: { currency: "EUR", period: "monthly" } }], metrics: ["1", "3", "50"] },
    ]);
    expect(result.total.metrics).toEqual(["3", "6", null]);
    expect(result.units).toEqual([null, null, null]);
  });

  test("number filters and ordering compare decimals exactly, past float precision", async () => {
    const { client } = memory();
    await client.session.request({
      operation: "stage",
      ...edit(),
      changes: [score(ids.ada, "9007199254740993"), score(ids.bo, "9007199254740992")],
    });
    const work = { sessionId: ids.session };
    const exact = await client.data.list("m_person", {
      asOf: "2026-10-01",
      where: [{ field: "score", op: "eq", value: "9007199254740993" }],
      work,
    });
    expect(exact.map((row) => row.name)).toEqual(["Ada"]);
    const ordered = await client.data.list("m_person", {
      asOf: "2026-10-01",
      orderBy: [{ field: "score", direction: "asc" }],
      work,
    });
    expect(ordered.map((row) => row.score)).toEqual(["3", "9007199254740992", "9007199254740993"]);
  });

  test("subscribe sends the current revision, then every bump", async () => {
    const { client } = memory();
    const seen: number[] = [];
    client.subscribe(ids.session, { onRevision: (revision) => seen.push(revision) });
    await Promise.resolve();
    await client.session.request({
      operation: "stage",
      ...edit(),
      changes: [score(ids.ada, "5")],
    });
    await Promise.resolve();
    expect(seen).toEqual([1, 2]);
  });

  test("a published-data change calls onData without a revision", async () => {
    const m = memory();
    const revisions: number[] = [];
    let data = 0;
    const unsubscribe = m.client.subscribe(ids.session, {
      onRevision: (revision) => revisions.push(revision),
      onData: () => (data += 1),
    });
    await Promise.resolve();
    m.writeCanonical("m_person", ids.ada, { f_score: { type: "number", value: "4" } });
    m.removeRecord("m_person", ids.ada);
    await Promise.resolve();
    expect({ revisions, data }).toEqual({ revisions: [1], data: 2 });
    unsubscribe();
    m.writeCanonical("m_person", ids.bo, { f_score: { type: "number", value: "4" } });
    await Promise.resolve();
    expect(data).toBe(2);
  });
});
