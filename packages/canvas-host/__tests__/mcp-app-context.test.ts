// What the chat's canvas tells the model: the selection and the person's last
// 20 actions as sentences by label, debounced 300 ms; never a token or code.
import { describe, expect, test } from "vitest";
import type { CanvasClient } from "@autograph/canvas";
import type { DataDefinition } from "@autograph/generated-app-runtime/data";

import {
  createModelContext,
  MODEL_CONTEXT_ACTIONS,
  MODEL_CONTEXT_DEBOUNCE_MS,
  observedClient,
} from "../mcp-app/context";

const definition = {
  formatVersion: 1,
  schemaVersion: "v1",
  models: [
    {
      id: "employee",
      name: "employee",
      label: "Employee",
      relations: [],
      fields: [
        {
          id: "base_salary",
          name: "base_salary",
          label: "Base Salary",
          type: "number",
          required: false,
          readOnly: false,
        },
        {
          id: "title",
          name: "title",
          label: "Job Title",
          type: "text",
          required: false,
          readOnly: false,
        },
      ],
    },
  ],
} as unknown as DataDefinition;
const record = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

function timers() {
  const pending: { run: () => void; ms: number }[] = [];
  return {
    pending,
    setTimeout: (run: () => void, ms: number) => {
      const entry = { run, ms };
      pending.push(entry);
      return entry;
    },
    clearTimeout: (handle: unknown) => {
      const index = pending.indexOf(handle as never);
      if (index >= 0) pending.splice(index, 1);
    },
    flush() {
      for (const entry of pending.splice(0)) entry.run();
    },
  };
}

describe("model context", () => {
  test("sends the selection and actions once, 300 ms after the last change", async () => {
    const sent: unknown[] = [];
    const clock = timers();
    const context = createModelContext({
      definition,
      send: async (update) => sent.push(update),
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    context.select({
      kind: "cells",
      unit_id: "u",
      model_id: "employee",
      cells: [
        { record_id: record(1), field_id: "base_salary" },
        { record_id: record(2), field_id: "base_salary" },
      ],
    });
    context.action("stage", "Staged Base Salary on 2 Employee records.");
    expect(clock.pending).toHaveLength(1);
    expect(clock.pending[0]!.ms).toBe(MODEL_CONTEXT_DEBOUNCE_MS);
    clock.flush();
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    const update = sent[0] as {
      content: { text: string }[];
      structuredContent: Record<string, unknown>;
    };
    expect(update.content[0]!.text).toContain("Selected Base Salary of 2 Employee records.");
    expect(update.content[0]!.text).toContain("- Staged Base Salary on 2 Employee records.");
    expect(update.structuredContent).toMatchObject({
      selection: { kind: "cells", model: "Employee", columns: ["Base Salary"], records: 2 },
      actions: [{ action: "stage", sentence: "Staged Base Salary on 2 Employee records." }],
    });
    // No record or field ids reach the model: describe_workspace names the records.
    const structured = JSON.stringify(update.structuredContent);
    expect(structured).not.toContain("base_salary");
    expect(structured).not.toMatch(/record_id|field_id|record_ids/u);
    expect(structured).not.toContain(record(1));
  });

  test("signing out forgets the selection and actions and sends nothing pending", async () => {
    const sent: unknown[] = [];
    const clock = timers();
    const context = createModelContext({
      definition,
      send: async (update) => sent.push(update),
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    context.select({ kind: "rows", unit_id: "u", model_id: "employee", record_ids: [record(1)] });
    context.action("stage", "Staged Base Salary on 1 Employee record.");
    context.reset();
    clock.flush();
    await Promise.resolve();
    expect(sent).toEqual([]);
    expect(context.current().structuredContent).toEqual({ selection: null, actions: [] });
  });

  test("keeps the last 20 actions", () => {
    const context = createModelContext({
      definition,
      send: async () => {},
      setTimeout: () => 0,
      clearTimeout: () => {},
    });
    for (let index = 0; index < 25; index += 1) context.action("stage", `Action ${index}.`);
    const actions = context.current().structuredContent.actions as { sentence: string }[];
    expect(actions).toHaveLength(MODEL_CONTEXT_ACTIONS);
    expect(actions[0]!.sentence).toBe("Action 5.");
  });

  test("an observed client names each successful mutation by label, never reads or failures", async () => {
    const heard: [string, string][] = [];
    let fail = false;
    let saves = 0;
    const base = {
      definition,
      session: {
        request: async (input: { operation: string }) => {
          if (fail) throw new Error("refused");
          if (input.operation !== "save") return { revision: 2 };
          saves += 1;
          return { revision: 3, cleared: true, change_set: saves === 1 ? { id: 7 } : null };
        },
      },
      drafts: { kernel: { getJson: async () => [], postJson: async () => ({ ok: true }) } },
    } as unknown as CanvasClient;
    const client = observedClient(base, (action, sentence) => heard.push([action, sentence]));
    await client.session.request({ operation: "get", session_id: "s" } as never);
    await client.session.request({
      operation: "stage",
      changes: [{ model_id: "employee", record_id: record(1), field_id: "title", value: null }],
    } as never);
    await client.session.request({ operation: "save" } as never);
    await client.session.request({ operation: "save" } as never);
    await client.session.request({
      operation: "presence",
      session_id: "s",
      selection: [],
    } as never);
    await client.drafts!.kernel.postJson("/api/draft/approve", { change_set_id: 4 });
    await client.drafts!.kernel.postJson("/api/diff", { change_set_id: 4 });
    fail = true;
    await expect(
      client.session.request({ operation: "stage", changes: [] } as never),
    ).rejects.toThrow();
    expect(heard).toEqual([
      ["stage", "Staged Job Title on 1 Employee record."],
      ["save", "Saved the staged changes as draft #7 for review."],
      ["save", "Saved; nothing needed writing."],
      ["draft/approve", "Approved and published a draft."],
    ]);
  });
});
