// The agent's request to Save on the Save bar, and the person's selection
// written as presence: over the in-memory client, which keeps the kernel's
// rules (agents ask, Save or Not now answers, presence takes no revision).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import { bootstrapAgCharts } from "@autograph/compositions";
import { bootstrapAgGrid } from "@modules/editable-grid";

import type { WorkSessionRequest } from "@autograph/generated-app-runtime/data";

import { Canvas } from "../canvas";
import { createPresenceWriter, PRESENCE_DEBOUNCE_MS, presenceTargets } from "../selection";
import { parseSaveRequest, parseThreads } from "../threads";
import { canvasMemory, send, sessionId, turns, typicalLayout } from "../stories/fixtures/canvas";
import { change, stageAs } from "../stories/fixtures/grid";

bootstrapAgCharts();
bootstrapAgGrid();

function mount(memory: ReturnType<typeof canvasMemory>) {
  return render(
    <div style={{ width: 1400, height: 900 }}>
      <Canvas client={memory.client} sessionId={sessionId} />
    </div>,
  );
}
const header = (memory: ReturnType<typeof canvasMemory>) =>
  memory.client.session.request({ operation: "get", session_id: sessionId, overlay: false });

describe("the agent's request to Save", () => {
  it("is not a discussion thread, and only the open one counts", () => {
    const threads = {
      t: { id: "t", anchor: {}, resolved: false, messages: [] },
      old: {
        id: "old",
        kind: "save_request",
        reason: "Before",
        resolved: true,
        revision: 2,
        messages: [],
      },
      ask: {
        id: "ask",
        kind: "save_request",
        reason: "Now",
        resolved: false,
        revision: 4,
        messages: [],
      },
    };
    expect(parseThreads(threads).map((thread) => thread.id)).toEqual(["t"]);
    expect(parseSaveRequest(threads)).toEqual({ id: "ask", reason: "Now", revision: 4 });
    expect(parseSaveRequest({ t: threads.t })).toBeNull();
  });

  it("shows on the Save bar; Not now answers it as the person", async () => {
    const memory = canvasMemory(typicalLayout);
    await stageAs(memory.client.session, [
      change(1, "f_status", { type: "enum", value: "active" }),
    ]);
    await send(memory.asAgent(turns.first), {
      operation: "save_request",
      thread_id: "ask-1",
      reason: "The Q4 statuses are staged",
    });
    mount(memory);
    const bar = await screen.findByText("The agent asks to Save: The Q4 statuses are staged");
    const request = bar.closest("[data-save-request]") as HTMLElement;
    expect(within(request).queryByText("The session changed since the agent asked")).toBeNull();
    fireEvent.click(within(request).getByRole("button", { name: "Not now" }));
    await waitFor(() =>
      expect(screen.queryByText(/The agent asks to Save/u)).not.toBeInTheDocument(),
    );
    const threads = (await header(memory)).threads as Record<string, { resolved: boolean }>;
    expect(threads["ask-1"]!.resolved).toBe(true);
  });

  it("says when the session changed since, and Save answers it", async () => {
    const memory = canvasMemory(typicalLayout);
    await stageAs(memory.client.session, [
      change(1, "f_status", { type: "enum", value: "active" }),
    ]);
    await send(memory.asAgent(turns.first), {
      operation: "save_request",
      thread_id: "ask-1",
      reason: "Ready",
    });
    // A newer request replaces the first; then the session changes.
    await send(memory.asAgent(turns.first), {
      operation: "save_request",
      thread_id: "ask-2",
      reason: "Ready now",
    });
    await stageAs(memory.client.session, [change(3, "f_status", { type: "enum", value: "done" })]);
    mount(memory);
    const request = (await screen.findByText("The agent asks to Save: Ready now")).closest(
      "[data-save-request]",
    ) as HTMLElement;
    expect(
      within(request).getByText("The session changed since the agent asked"),
    ).toBeInTheDocument();
    // The person's ordinary Save: the first press shows changes not on the
    // canvas (the hidden-change warning), the second saves.
    fireEvent.click(within(request).getByRole("button", { name: "Save" }));
    await screen.findByRole("region", { name: /unsaved/iu }).catch(() => null);
    fireEvent.click(within(request).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.queryByText(/The agent asks to Save/u)).not.toBeInTheDocument(),
    );
    const threads = (await header(memory)).threads as Record<string, { resolved: boolean }>;
    expect(threads["ask-1"]!.resolved).toBe(true);
    expect(threads["ask-2"]!.resolved).toBe(true);
  });

  it("only an agent asks, with a reason of at most 200 characters", async () => {
    const memory = canvasMemory(typicalLayout);
    await expect(
      send(memory.client.session, { operation: "save_request", thread_id: "x", reason: "Me" }),
    ).rejects.toMatchObject({ envelope: { code: "authorization_denied" } });
    await expect(
      send(memory.asAgent(turns.first), {
        operation: "save_request",
        thread_id: "x",
        reason: "x".repeat(201),
      }),
    ).rejects.toMatchObject({ envelope: { code: "contract_validation_failed" } });
  });
});

describe("the person's selection as presence", () => {
  it("names records by cell, row or node; a chart bar names none; at most 200", () => {
    expect(
      presenceTargets({
        kind: "cells",
        unit_id: "u",
        model_id: "m",
        cells: [{ record_id: "r1", field_id: "f" }],
      }),
    ).toEqual([{ model_id: "m", record_id: "r1", field_id: "f" }]);
    expect(
      presenceTargets({ kind: "rows", unit_id: "u", model_id: "m", record_ids: ["a", "b"] }),
    ).toEqual([
      { model_id: "m", record_id: "a" },
      { model_id: "m", record_id: "b" },
    ]);
    expect(
      presenceTargets({ kind: "segment", unit_id: "u", model_id: "m", field_id: "f", value: 1 }),
    ).toEqual([]);
    expect(presenceTargets(null)).toEqual([]);
    const many = Array.from({ length: 250 }, (_, index) => `r${index}`);
    expect(
      presenceTargets({ kind: "rows", unit_id: "u", model_id: "m", record_ids: many }),
    ).toHaveLength(200);
  });

  it("writes only a settled change: a selection undone within the debounce writes nothing", () => {
    const pending = new Map<number, () => void>();
    let next = 0;
    const writes: unknown[] = [];
    const writer = createPresenceWriter((targets) => writes.push(targets), {
      setTimeout: (run, ms) => {
        expect(ms).toBe(PRESENCE_DEBOUNCE_MS);
        pending.set(++next, run);
        return next;
      },
      clearTimeout: (handle) => pending.delete(handle as number),
    });
    const flush = () => {
      for (const [handle, run] of [...pending]) {
        pending.delete(handle);
        run();
      }
    };
    const a = [{ model_id: "m", record_id: "a" }];
    const b = [{ model_id: "m", record_id: "b" }];
    // Nothing is written before what presence holds is known.
    writer.next(a);
    expect(pending.size).toBe(0);
    writer.next([]);
    writer.known([]);
    expect(pending.size).toBe(0);
    // Empty → selected → empty within 500 ms: nothing to write.
    writer.next(a);
    writer.next([]);
    expect(pending.size).toBe(0);
    flush();
    expect(writes).toEqual([]);
    // A settles and is written; a filter change (the same A) neither writes nor delays.
    writer.next(a);
    writer.next(a);
    expect(pending.size).toBe(1);
    flush();
    expect(writes).toEqual([a]);
    // A → B → A within 500 ms: A is already written, so nothing new.
    writer.next(b);
    writer.next(a);
    expect(pending.size).toBe(0);
    flush();
    expect(writes).toEqual([a]);
    // A → B settles as B; clearing after it writes the empty selection.
    writer.next(b);
    flush();
    writer.next([]);
    flush();
    expect(writes).toEqual([a, b, []]);
  });

  it("replaces a stored selection once it is known, whatever its keys' order", () => {
    const pending: (() => void)[] = [];
    const writes: unknown[] = [];
    const writer = createPresenceWriter((targets) => writes.push(targets), {
      setTimeout: (run) => pending.push(run),
      clearTimeout: () => {},
    });
    // Reopened with an old selection stored, and nothing selected now.
    writer.next([]);
    writer.known([{ record_id: "a", model_id: "m" }]);
    for (const run of pending.splice(0)) run();
    expect(writes).toEqual([[]]);
    // The same selection stored as is selected now: nothing to write.
    const same = createPresenceWriter((targets) => writes.push(targets), {
      setTimeout: (run) => pending.push(run),
      clearTimeout: () => {},
    });
    same.next([{ model_id: "m", record_id: "a", field_id: "f" }]);
    same.known([{ field_id: "f", model_id: "m", record_id: "a" }]);
    expect(pending).toHaveLength(0);
  });

  it("serializes writes: a slow write of A never lands after B", async () => {
    const pending: (() => void)[] = [];
    const sent: string[] = [];
    const landed: string[] = [];
    const releases: (() => void)[] = [];
    const writer = createPresenceWriter(
      (targets) => {
        const name = targets[0]?.record_id ?? "none";
        sent.push(name);
        return new Promise<void>((resolve) =>
          releases.push(() => {
            landed.push(name);
            resolve();
          }),
        );
      },
      { setTimeout: (run) => pending.push(run), clearTimeout: () => {} },
    );
    const flush = () => {
      for (const run of pending.splice(0)) run();
    };
    const target = (id: string) => [{ model_id: "m", record_id: id }];
    writer.known([]);
    writer.next(target("a"));
    flush();
    expect(sent).toEqual(["a"]);
    // B and then C settle while A is still in flight: only the latest waits.
    writer.next(target("b"));
    flush();
    writer.next(target("c"));
    flush();
    expect(sent).toEqual(["a"]);
    releases.shift()!();
    await waitFor(() => expect(sent).toEqual(["a", "c"]));
    releases.shift()!();
    await waitFor(() => expect(landed).toEqual(["a", "c"]));
  });

  it("drops queued writes when it leaves its session", async () => {
    const pending: (() => void)[] = [];
    const sent: string[] = [];
    let release!: () => void;
    const writer = createPresenceWriter(
      (targets) => {
        sent.push(targets[0]?.record_id ?? "none");
        return new Promise<void>((resolve) => (release = resolve));
      },
      { setTimeout: (run) => pending.push(run), clearTimeout: () => {} },
    );
    const flush = () => {
      for (const run of pending.splice(0)) run();
    };
    writer.known([]);
    writer.next([{ model_id: "m", record_id: "a" }]);
    flush();
    writer.next([{ model_id: "m", record_id: "b" }]);
    flush();
    writer.dispose();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toEqual(["a"]);
    writer.next([{ model_id: "m", record_id: "c" }]);
    flush();
    expect(sent).toEqual(["a"]);
  });

  it("never writes the old session's selection into the session it switches to", async () => {
    const memory = canvasMemory(typicalLayout);
    const other = "00000000-0000-4000-8000-0000000000aa";
    await memory.client.session.request({
      operation: "create",
      session_id: other,
      expected_revision: 0,
      request_id: crypto.randomUUID(),
      title: "Other",
      as_of: "2026-10-01",
      layout: typicalLayout,
    } as WorkSessionRequest);
    // Presence writes are held until released, as over a slow network.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const written: { session: string; targets: number }[] = [];
    const request = memory.client.session.request.bind(memory.client.session);
    const client = {
      ...memory.client,
      session: {
        ...memory.client.session,
        request: (async (input: WorkSessionRequest) => {
          if (input.operation === "presence") {
            written.push({ session: input.session_id, targets: input.selection.length });
            await held;
          }
          return await request(input as never);
        }) as typeof memory.client.session.request,
      },
    };
    const view = render(
      <div style={{ width: 1400, height: 900 }}>
        <Canvas client={client} sessionId={sessionId} />
      </div>,
    );
    const nodes = await screen.findAllByRole("button", { name: /^Activate / });
    // A is written (and held in flight); B settles and queues behind it.
    fireEvent.click(nodes[0]!);
    await waitFor(() => expect(written).toHaveLength(1), { timeout: 3000 });
    fireEvent.click(nodes[1]!);
    await new Promise((resolve) => setTimeout(resolve, PRESENCE_DEBOUNCE_MS + 100));
    expect(written).toHaveLength(1);
    // The canvas switches sessions before A answers.
    view.rerender(
      <div style={{ width: 1400, height: 900 }}>
        <Canvas client={client} sessionId={other} />
      </div>,
    );
    await screen.findAllByRole("button", { name: /^Activate / });
    release();
    await new Promise((resolve) => setTimeout(resolve, PRESENCE_DEBOUNCE_MS + 300));
    // Nothing of the old session's selection reached either session after the switch.
    expect(written.filter((write) => write.session === other && write.targets > 0)).toEqual([]);
    expect(written.filter((write) => write.session === sessionId)).toHaveLength(1);
  });

  it("clears a persisted selection when the canvas reopens with nothing selected", async () => {
    const memory = canvasMemory(typicalLayout);
    const nodes = await (async () => {
      const first = mount(memory);
      const found = await screen.findAllByRole("button", { name: /^Activate / });
      fireEvent.click(found[0]!);
      await waitFor(async () => expect((await header(memory)).presence?.selection.length).toBe(1), {
        timeout: 3000,
      });
      first.unmount();
      return found;
    })();
    expect(nodes.length).toBeGreaterThan(0);
    // Reopened: nothing is selected, so the agent no longer reads the old selection.
    mount(memory);
    await waitFor(async () => expect((await header(memory)).presence?.selection).toEqual([]), {
      timeout: 3000,
    });
  });

  it("writes a settled selection without a revision; an agent cannot write it", async () => {
    const memory = canvasMemory(typicalLayout);
    const before = (await header(memory)).revision;
    mount(memory);
    const nodes = await screen.findAllByRole("button", { name: /^Activate / });
    fireEvent.click(nodes[0]!);
    await waitFor(async () => expect((await header(memory)).presence?.selection.length).toBe(1), {
      timeout: 3000,
    });
    expect((await header(memory)).revision).toBe(before);
    await expect(
      memory
        .asAgent(turns.first)
        .request({ operation: "presence", session_id: sessionId, selection: [] }),
    ).rejects.toMatchObject({ envelope: { code: "authorization_denied" } });
  });
});
