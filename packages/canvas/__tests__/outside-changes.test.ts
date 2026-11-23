import { describe, expect, test } from "vite-plus/test";
import type { WorkChange } from "@autograph/generated-app-runtime/data";

import { outsideChanges } from "../outside-changes";
import type { CanvasThread } from "../threads";

const entry = (record: string, extra: Partial<WorkChange> = {}) =>
  ({
    model_id: "m",
    record_id: record,
    field_id: "f",
    value: null,
    source: "human",
    updated_at: "2026-10-01T00:00:00Z",
    stale: false,
    ...extra,
  }) as WorkChange;
const thread = (extra: Partial<CanvasThread> = {}): CanvasThread => ({
  id: "t",
  anchor: {},
  resolved: false,
  messages: [],
  ...extra,
});
const message = (id: string, author_kind: "human" | "agent") => ({
  id,
  actor_id: "a",
  author_kind,
  message: id,
  created_at: "2026-10-01T00:00:00Z",
});

describe("outside changes", () => {
  test("an agent turn's new or restaged values; not your edits or your Pull", () => {
    const before = { entries: [entry("1", { source: "agent", turn_id: "x" })], threads: [] };
    const after = {
      entries: [
        entry("1", { source: "agent", turn_id: "x", updated_at: "2026-10-02T00:00:00Z" }),
        entry("2", { source: "agent", turn_id: "y" }),
        entry("3"),
        // A pulled proposal is the agent's value but the user's act.
        entry("4", { source: "agent" }),
      ],
      threads: [],
    };
    expect(outsideChanges(before, after)).toEqual([
      {
        kind: "agent_staged",
        entries: [
          { model_id: "m", record_id: "1", field_id: "f" },
          { model_id: "m", record_id: "2", field_id: "f" },
        ],
      },
    ]);
    expect(outsideChanges(after, after)).toEqual([]);
  });

  test("an agent's reply or new proposal; a human reply is not one", () => {
    const before = { entries: [], threads: [thread({ messages: [message("m1", "human")] })] };
    const replied = {
      entries: [],
      threads: [thread({ messages: [message("m1", "human"), message("m2", "agent")] })],
    };
    expect(outsideChanges(before, replied)).toEqual([{ kind: "agent_replied", thread_id: "t" }]);
    const human = {
      entries: [],
      threads: [thread({ messages: [message("m1", "human"), message("m3", "human")] })],
    };
    expect(outsideChanges(before, human)).toEqual([]);
    const proposal = {
      id: "p",
      changes: [],
      actor_id: "a",
      author_principal: "agent:x",
      author_kind: "agent" as const,
      created_at: "2026-10-01T00:00:00Z",
    };
    expect(
      outsideChanges(before, { entries: [], threads: [thread({ proposal, messages: [] })] }),
    ).toEqual([{ kind: "agent_proposed", thread_id: "t" }]);
  });

  test("staged values that became stale or gone; ones already flagged are not counted again", () => {
    const before = { entries: [entry("1"), entry("2"), entry("3", { stale: true })], threads: [] };
    const after = {
      entries: [
        entry("1", { stale: true }),
        entry("2", { stale: true, gone: "record_gone" }),
        entry("3", { stale: true }),
      ],
      threads: [],
    };
    expect(outsideChanges(before, after)).toEqual([
      {
        kind: "changed_underneath",
        entries: [
          { model_id: "m", record_id: "1", field_id: "f" },
          { model_id: "m", record_id: "2", field_id: "f" },
        ],
      },
    ]);
  });
});
