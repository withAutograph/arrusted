import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";
import type { CanvasClient } from "../client";
import type { CanvasLayout } from "@autograph/work-session-tools/layout";
import { connectGraceMs, useCanvasSession } from "../use-canvas-session";
import { guard, ids, memory, num, recording, text, edit } from "./fixture";

const score = (record_id: string, value: string) => ({
  model_id: "m_person",
  record_id,
  field_id: "f_score",
  value: num(value),
});
// A free layout: the hook shows it as stored (a grid layout is placed).
const layout = (x: number): CanvasLayout => ({
  mode: "free",
  units: [{ id: "u1", kind: "grid", config: { model_id: "m_person" }, x, y: 24, w: 400, h: 300 }],
});

async function mount(client: CanvasClient, pageSize?: number) {
  const hook = renderHook(() =>
    useCanvasSession(client, ids.session, pageSize === undefined ? {} : { pageSize }),
  );
  await waitFor(() => expect(hook.result.current.status).toBe("ready"));
  return hook;
}
const ops = (calls: Record<string, unknown>[], operation: string) =>
  calls.filter((call) => call.operation === operation);

describe("useCanvasSession: reading", () => {
  test("follows every entries page and groups agent turns by time, then your edits", async () => {
    const m = memory();
    await m
      .asAgent(ids.turn2)
      .request({ operation: "stage", ...edit(), changes: [score(ids.cy, "9")] });
    await m.asAgent(ids.turn1).request({
      operation: "stage",
      ...edit(),
      changes: [score(ids.ada, "9"), score(ids.bo, "9")],
    });
    await m.client.session.request({
      operation: "stage",
      ...edit(),
      changes: [{ model_id: "m_person", record_id: ids.ada, field_id: "f_name", value: text("A") }],
    });
    const { client, calls } = recording(m.client);
    const { result } = await mount(client, 2);
    expect(result.current.entries).toHaveLength(4);
    expect(ops(calls, "entries").length).toBeGreaterThanOrEqual(2);
    expect(ops(calls, "get")[0]).toMatchObject({ overlay: false });
    expect(result.current.groups.map((g) => [g.turn_id, g.entries.length])).toEqual([
      [ids.turn2, 1],
      [ids.turn1, 2],
      [null, 1],
    ]);
  });

  test("never settles a mixed snapshot: it keeps the last coherent one and says the refresh failed", async () => {
    const m = memory();
    let mix = false;
    const client: CanvasClient = {
      ...m.client,
      session: {
        request: async (input) => {
          const result = await m.client.session.request(input);
          // Every entries page answers from a later revision.
          return (
            mix && input.operation === "entries" ? { ...(result as object), revision: 99 } : result
          ) as never;
        },
      },
      subscribe: () => () => {},
    };
    const { result } = await mount(client, 1);
    mix = true;
    await m.client.session.request({
      operation: "stage",
      ...edit(),
      changes: [score(ids.ada, "9")],
    });
    await act(() => result.current.reload());
    expect(result.current.revision).toBe(1);
    expect(result.current.entries).toEqual([]);
    expect(result.current.error).toBeTruthy();
    mix = false;
    await act(() => result.current.reload());
    expect(result.current.revision).toBe(2);
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  test("re-reads on a push at the revision shown: canonical changes alter stale without a bump", async () => {
    const m = memory();
    await m.client.session.request({
      operation: "stage",
      ...edit(),
      changes: [score(ids.ada, "9")],
    });
    const { result } = await mount(m.client);
    expect(result.current.entries[0]!.stale).toBe(false);
    const generation = result.current.generation;
    m.writeCanonical("m_person", ids.ada, { f_name: text("Ada L") });
    act(() => m.reconnect(ids.session));
    await waitFor(() => expect(result.current.entries[0]!.stale).toBe(true));
    expect(result.current.revision).toBe(2);
    // Units re-read on the generation, which a same-revision read still bumps.
    expect(result.current.generation).toBeGreaterThan(generation);
  });

  test("reads once the stream connects, so a change before that is in the first read", async () => {
    const m = memory();
    await m.client.session.request({
      operation: "stage",
      ...edit(),
      changes: [score(ids.ada, "9")],
    });
    let listener: Parameters<CanvasClient["subscribe"]>[1] | null = null;
    const { client, calls } = recording({
      ...m.client,
      subscribe: (_sessionId, heard) => {
        listener = heard;
        return () => {};
      },
    });
    const hook = renderHook(() => useCanvasSession(client, ids.session));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Nothing is read before the stream connects.
    expect(ops(calls, "get")).toHaveLength(0);
    m.writeCanonical("m_person", ids.ada, { f_name: text("Ada L") });
    act(() => {
      listener!.onConnect?.();
      listener!.onRevision(2);
    });
    await waitFor(() => expect(hook.result.current.status).toBe("ready"));
    expect(hook.result.current.entries[0]!.stale).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // One read of the session: the first connect re-reads nothing more.
    expect(ops(calls, "get")).toHaveLength(1);
    expect(hook.result.current.generation).toBe(1);
  });

  test("a stream slow to connect does not hold the canvas; its late connect re-reads once", async () => {
    const m = memory();
    let listener: Parameters<CanvasClient["subscribe"]>[1] | null = null;
    const { client, calls } = recording({
      ...m.client,
      subscribe: (_sessionId, heard) => {
        listener = heard;
        return () => {};
      },
    });
    const hook = renderHook(() => useCanvasSession(client, ids.session));
    await waitFor(() => expect(hook.result.current.status).toBe("ready"), {
      timeout: connectGraceMs + 2000,
    });
    expect(hook.result.current.generation).toBe(1);
    act(() => {
      listener!.onConnect?.();
      listener!.onRevision(hook.result.current.revision!);
    });
    await waitFor(() => expect(hook.result.current.generation).toBe(2));
    expect(ops(calls, "get")).toHaveLength(2);
  });

  test("re-reads when published data changes, with no revision bump", async () => {
    const m = memory();
    await m.client.session.request({
      operation: "stage",
      ...edit(),
      changes: [score(ids.ada, "9")],
    });
    const { client, calls } = recording(m.client);
    const { result } = await mount(client);
    const gets = ops(calls, "get").length;
    await act(async () => m.removeRecord("m_person", ids.ada));
    await waitFor(() => expect(result.current.entries[0]!.gone).toBe("record_gone"));
    expect(result.current.revision).toBe(2);
    expect(ops(calls, "get").length).toBeGreaterThan(gets);
  });

  test("another session discards the last one's state and reads, and mutates nothing until it loads", async () => {
    const m = memory();
    const other = "00000000-0000-4000-8000-0000000000bb";
    await m.client.session.request({
      operation: "create",
      session_id: other,
      expected_revision: 0,
      request_id: "create-other",
      title: "Other",
      as_of: "2026-10-01",
    });
    await m.client.session.request({
      operation: "stage",
      ...edit(),
      changes: [score(ids.ada, "9")],
    });
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const client: CanvasClient = {
      ...m.client,
      session: {
        request: async (input) => {
          if (input.operation === "get" && input.session_id === other) await gate;
          return m.client.session.request(input);
        },
      },
    };
    const hook = renderHook(({ id }) => useCanvasSession(client, id), {
      initialProps: { id: ids.session },
    });
    await waitFor(() => expect(hook.result.current.entries).toHaveLength(1));
    hook.rerender({ id: other });
    expect(hook.result.current.session).toBeNull();
    expect(hook.result.current.entries).toEqual([]);
    expect(await act(() => hook.result.current.stage([score(ids.bo, "9")]))).toMatchObject({
      ok: false,
      code: "not_loaded",
    });
    release();
    await waitFor(() => expect(hook.result.current.session?.id).toBe(other));
    expect(hook.result.current.entries).toEqual([]);
  });

  test("re-reads when the client pushes a new revision", async () => {
    const m = memory();
    const { result } = await mount(m.client);
    await act(() =>
      m
        .asAgent(ids.turn1)
        .request({ operation: "stage", ...edit(), changes: [score(ids.ada, "9")] }),
    );
    await waitFor(() => expect(result.current.revision).toBe(2));
    expect(result.current.entries).toHaveLength(1);
  });
});

describe("useCanvasSession: reverting", () => {
  test("per change, per turn and all agent changes, last-write-wins, patched without a re-read", async () => {
    const m = memory();
    await m
      .asAgent(ids.turn1)
      .request({ operation: "stage", ...edit(), changes: [score(ids.ada, "9")] });
    await m
      .asAgent(ids.turn2)
      .request({ operation: "stage", ...edit(), changes: [score(ids.bo, "9")] });
    await m.client.session.request({
      operation: "stage",
      ...edit(),
      changes: [score(ids.cy, "9")],
    });
    const { client, calls } = recording(m.client);
    const { result } = await mount(client);

    expect(await act(() => result.current.discardTurn(ids.turn1))).toMatchObject({ ok: true });
    expect(result.current.entries.map((e) => e.record_id)).toEqual([ids.bo, ids.cy]);
    expect(await act(() => result.current.discardAgent())).toMatchObject({ ok: true });
    expect(result.current.entries.map((e) => e.record_id)).toEqual([ids.cy]);
    expect(await act(() => result.current.unstage(result.current.entries[0]!))).toMatchObject({
      ok: true,
    });
    expect(result.current.entries).toEqual([]);

    const mutations = calls.filter((c) => c.operation !== "get" && c.operation !== "entries");
    expect(mutations.map((c) => c.operation)).toEqual([
      "discard_turn",
      "discard_source",
      "unstage",
    ]);
    for (const mutation of mutations) {
      expect(mutation).not.toHaveProperty("expected_revision");
      expect(mutation).not.toHaveProperty("request_id");
    }
    // Each answer was applied to what is shown: only the first read re-read.
    expect(ops(calls, "get")).toHaveLength(1);
    expect(result.current.revision).toBe(7);
  });

  test("a stage answer patches the entries and generation without a session get", async () => {
    const m = memory();
    await m.client.session.request({
      operation: "stage",
      ...edit(),
      changes: [score(ids.bo, "8")],
    });
    const { client, calls } = recording(m.client);
    const { result } = await mount(client);
    const generation = result.current.generation;
    const reads = calls.length;
    expect(await act(() => result.current.stage([score(ids.ada, "9")]))).toEqual({
      ok: true,
      revision: 3,
    });
    // The stage itself is the only call: no get, no entries page.
    expect(calls.slice(reads).map((c) => c.operation)).toEqual(["stage"]);
    expect(result.current.revision).toBe(3);
    // Units re-read on the new generation.
    expect(result.current.generation).toBe(generation + 1);
    expect(result.current.entries.map((e) => [e.record_id, e.value])).toEqual([
      [ids.ada, num("9")],
      [ids.bo, num("8")],
    ]);
    // A new entry is not stale; its current value is the saved one.
    expect(result.current.entries[0]).toMatchObject({ stale: false, current_value: num("1") });
    // What is shown matches a fresh read.
    const fresh = await m.client.session.request({ operation: "get", session_id: ids.session });
    expect(result.current.entries).toEqual(fresh.overlay);
  });

  test("an edit that met another change since the read re-reads instead of patching", async () => {
    const m = memory();
    const { client, calls } = recording(m.client, { silent: true });
    const { result } = await mount(client);
    await m
      .asAgent(ids.turn1)
      .request({ operation: "stage", ...edit(), changes: [score(ids.bo, "8")] });
    const reads = ops(calls, "get").length;
    await act(() => result.current.stage([score(ids.ada, "9")]));
    expect(ops(calls, "get").length).toBe(reads + 1);
    expect(result.current.revision).toBe(3);
    expect(result.current.entries.map((e) => e.record_id)).toEqual([ids.ada, ids.bo]);
  });
});

describe("useCanvasSession: layout", () => {
  test("a drop that meets an agent's stage lands at once: layout updates are last-write-wins", async () => {
    const m = memory();
    const { client, calls } = recording(m.client, { silent: true });
    const { result } = await mount(client);
    await m
      .asAgent(ids.turn1)
      .request({ operation: "stage", ...edit(), changes: [score(ids.ada, "9")] });

    act(() => {
      result.current.beginLayoutGesture();
      result.current.moveLayout(layout(200));
    });
    expect(result.current.layout).toEqual(layout(200));
    const outcome = await act(() => result.current.commitLayout(() => layout(200)));
    expect(outcome).toEqual({ ok: true, revision: 3 });
    const updates = ops(calls, "update");
    expect(updates).toHaveLength(1);
    expect(updates[0]).not.toHaveProperty("expected_revision");
    expect(updates[0]).not.toHaveProperty("request_id");
    expect(result.current.session?.layout).toEqual(layout(200));
    expect(result.current.layout).toEqual(layout(200));
  });

  test("inbound layout is ignored while a gesture is live", async () => {
    const m = memory();
    const { result } = await mount(m.client);
    act(() => {
      result.current.beginLayoutGesture();
      result.current.moveLayout(layout(100));
    });
    // Another tab saves a different layout.
    await act(() =>
      m.client.session.request({
        operation: "update",
        ...edit(),
        patch: { layout: layout(900) },
      }),
    );
    await waitFor(() => expect(result.current.revision).toBe(2));
    expect(result.current.layout).toEqual(layout(100));
    await act(() => result.current.commitLayout(() => layout(100)));
    expect(result.current.session?.layout).toEqual(layout(100));
  });

  test("an invalid session layout shows no units and says why", async () => {
    const m = memory();
    await m.client.session.request({
      operation: "update",
      ...edit(),
      patch: { layout: { units: [{ id: "x" }] } },
    });
    const { result } = await mount(m.client);
    expect(result.current.layout.units).toEqual([]);
    expect(result.current.layoutError).toBeTruthy();
    // A move never replaces it; adding a unit starts a new layout.
    const moved = await act(() => result.current.commitLayout(() => layout(1)));
    expect(moved).toMatchObject({ ok: false, code: "layout_invalid" });
    const added = await act(() =>
      result.current.commitLayout(() => layout(2), { startOver: true }),
    );
    expect(added.ok).toBe(true);
    await waitFor(() => expect(result.current.layoutError).toBeNull());
    expect(result.current.layout).toEqual(layout(2));
  });
});

describe("useCanvasSession: Save", () => {
  test("passes the revision shown and the confirmed stale entries, never a mode, and reads how it saved", async () => {
    const m = memory();
    await m.client.session.request({
      operation: "stage",
      ...edit(),
      changes: [score(ids.ada, "9"), score(ids.bo, "9")],
    });
    m.writeCanonical("m_person", ids.ada, { f_name: text("Ada L") });
    const { client, calls } = recording(m.client);
    const { result } = await mount(client);
    const stale = result.current.entries.find((e) => e.stale)!;
    expect(stale.record_id).toBe(ids.ada);

    const outcome = await act(() => result.current.save(result.current.revision!, [stale]));
    expect(outcome).toMatchObject({ ok: true, changeSetId: 1, published: false });
    expect(ops(calls, "save")[0]).not.toHaveProperty("mode");
    expect(ops(calls, "save")[0]).not.toHaveProperty("expected_mode");
    expect(ops(calls, "save")).toEqual([
      expect.objectContaining({
        expected_revision: 2,
        confirmed_stale: [
          {
            model_id: "m_person",
            record_id: ids.ada,
            field_id: "f_score",
            current_version: stale.current_version,
          },
        ],
      }),
    ]);
    expect(result.current.entries).toEqual([]);
  });

  test("Save at the revision the user reviewed is refused once anything changed, and nothing is saved", async () => {
    const m = memory();
    await m.client.session.request({
      operation: "stage",
      ...edit(),
      changes: [score(ids.ada, "9")],
    });
    const { result } = await mount(m.client);
    const reviewed = result.current.revision!;
    // While the confirmation is open, the agent stages more and the canvas re-reads.
    await act(() =>
      m
        .asAgent(ids.turn1)
        .request({ operation: "stage", ...edit(), changes: [score(ids.bo, "9")] }),
    );
    await waitFor(() => expect(result.current.revision).toBe(3));
    expect(await act(() => result.current.save(reviewed))).toMatchObject({
      ok: false,
      code: "revision_conflict",
    });
    expect(m.saves).toEqual([]);
  });

  test("Save waits for the person's own stage in flight and saves it at the revision it settled at", async () => {
    const m = memory();
    await m.client.session.request({
      operation: "stage",
      ...edit(),
      changes: [score(ids.ada, "9")],
    });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client: CanvasClient = {
      ...m.client,
      session: {
        request: async (input) => {
          if (input.operation === "stage") await held;
          return m.client.session.request(input);
        },
      },
    };
    const { result } = await mount(client);
    const reviewed = result.current.revision!;
    let staging!: Promise<unknown>;
    let saving!: Promise<unknown>;
    act(() => {
      // A blur commits a stage; Save is clicked in the same tick.
      staging = result.current.stage([score(ids.bo, "7")]);
      saving = result.current.save(reviewed);
    });
    expect(m.saves).toEqual([]);
    release();
    const outcome = await act(async () => {
      await staging;
      return saving;
    });
    expect(outcome).toMatchObject({ ok: true, changeSetId: 1 });
    expect(m.saves).toHaveLength(1);
    expect(m.saves[0]!.revision).toBe(reviewed + 1);
    expect(m.saves[0]!.entries.map((entry) => entry.record_id).sort()).toEqual(
      [ids.ada, ids.bo].sort(),
    );
    expect(result.current.entries).toEqual([]);
  });

  test("a stage of the person's that fails while an agent stages saves nothing and shows the change", async () => {
    const m = memory();
    await m.client.session.request({
      operation: "stage",
      ...edit(),
      changes: [score(ids.ada, "9")],
    });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client: CanvasClient = {
      ...m.client,
      session: {
        request: async (input) => {
          if (input.operation === "stage") {
            await held;
            throw Object.assign(new Error("refused"), {
              envelope: { code: "contract_validation_failed", message: "refused" },
            });
          }
          return m.client.session.request(input);
        },
      },
      subscribe: () => () => {},
    };
    const { result } = await mount(client);
    const reviewed = result.current.revision!;
    let staging!: Promise<unknown>;
    let saving!: Promise<unknown>;
    act(() => {
      staging = result.current.stage([score(ids.bo, "7")]);
      saving = result.current.save(reviewed);
    });
    // The agent's stage commits the next revision; the person's fails.
    await m
      .asAgent(ids.turn1)
      .request({ operation: "stage", ...edit(), changes: [score(ids.cy, "5")] });
    release();
    const outcome = await act(async () => {
      await staging;
      return saving;
    });
    expect(outcome).toMatchObject({ ok: false, code: "revision_conflict" });
    expect(m.saves).toEqual([]);
    // Refreshed: the agent's change is shown for review.
    expect(result.current.revision).toBe(reviewed + 1);
    expect(result.current.entries.map((entry) => entry.record_id).sort()).toEqual(
      [ids.ada, ids.cy].sort(),
    );
  });

  test("a conflict re-reads and is not re-applied", async () => {
    const m = memory();
    await m.client.session.request({
      operation: "stage",
      ...edit(),
      changes: [score(ids.ada, "9")],
    });
    const { client, calls } = recording(m.client, { silent: true });
    const { result } = await mount(client);
    await m
      .asAgent(ids.turn1)
      .request({ operation: "stage", ...edit(), changes: [score(ids.bo, "9")] });

    const outcome = await act(() => result.current.save(result.current.revision!));
    expect(outcome).toMatchObject({ ok: false, code: "revision_conflict" });
    expect(ops(calls, "save")).toHaveLength(1);
    expect(result.current.revision).toBe(3);
    expect(result.current.entries).toHaveLength(2);
    expect(m.saves).toEqual([]);
  });

  test("an unanswered Save is outcome-unknown and re-reads", async () => {
    const m = memory();
    await m.client.session.request({
      operation: "stage",
      ...edit(),
      changes: [score(ids.ada, "9")],
    });
    const { client, calls } = recording({
      ...m.client,
      session: {
        request: (input) =>
          input.operation === "save"
            ? Promise.reject(new TypeError("network"))
            : m.client.session.request(input),
      },
    });
    const { result } = await mount(client);
    const reads = ops(calls, "get").length;
    expect(await act(() => result.current.save(result.current.revision!))).toMatchObject({
      ok: false,
      code: "outcome_unknown",
    });
    expect(ops(calls, "get").length).toBe(reads + 1);
    expect(ops(calls, "save")).toHaveLength(1);
  });
});

describe("useCanvasSession: Pull and Dismiss", () => {
  async function proposed() {
    const m = memory();
    await m.client.session.request({
      operation: "thread_open",
      ...guard(1),
      thread_id: "t",
      anchor: { unit_id: "u1" },
    });
    await m.asAgent(ids.turn1).request({
      operation: "propose",
      ...guard(2),
      thread_id: "t",
      changes: [score(ids.ada, "8")],
    });
    const recorded = recording(m.client, { silent: true });
    const hook = await mount(recorded.client);
    return { m, ...recorded, ...hook };
  }

  test("after an unrelated revision, an unchanged proposal is pulled again with a new request id", async () => {
    const { m, calls, result } = await proposed();
    expect(result.current.threads[0]?.proposal?.changes).toHaveLength(1);
    await m
      .asAgent(ids.turn1)
      .request({ operation: "stage", ...edit(), changes: [score(ids.bo, "9")] });

    expect(await act(() => result.current.pull("t"))).toMatchObject({ ok: true });
    const pulls = ops(calls, "pull");
    expect(pulls.map((p) => p.expected_revision)).toEqual([3, 4]);
    expect(pulls[0]!.request_id).not.toBe(pulls[1]!.request_id);
    expect(result.current.entries.find((e) => e.record_id === ids.ada)).toMatchObject({
      thread_id: "t",
    });
  });

  test("a changed proposal is reported, not resolved", async () => {
    const { m, calls, result } = await proposed();
    await m.asAgent(ids.turn1).request({
      operation: "propose",
      ...guard(3),
      thread_id: "t",
      changes: [score(ids.ada, "7")],
    });

    expect(await act(() => result.current.dismiss("t"))).toMatchObject({
      ok: false,
      code: "proposal_changed",
    });
    expect(ops(calls, "dismiss")).toHaveLength(1);
    expect(result.current.threads[0]?.proposal?.changes[0]?.value).toEqual(num("7"));
  });
});
