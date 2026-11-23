// Correctness landmines regression tests (`polish/positions-editing-model`
// Phase 5). Each test pins one of the fixes called out by the external
// re-review:
//
//   #1: row.values stays immutable; revert paths delete pending values so AG
//       Grid projections fall back to baseline values after Discard.
//   #2: cell setters preserve `meta.changeTypeId` across follow-up edits
//       so `setRowChangeType` / `stageBulkUpdate({changeTypeId: ...})`
//       don't get silently undone by the next cell commit.
//   #3: `save()` throws when no resolution path produces a non-empty
//       change_type id, instead of shipping `change_type_id: ""` to the
//       kernel.
//   #6: `pendingChangesByRow` (digest) and the save partition rule
//       resolve change_type identically — the row-meta strip narrates
//       the same verb the save loop commits under.
//
// Tests intentionally don't mount AG Grid — the controller's contract
// is what we're pinning. Visual proof of #1's grid repaint goes via
// Playwright (see `.scratch/sweep-2026-05-15/P5-landmines/`).

import { useEffect, useRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, render, waitFor } from "@testing-library/react";

import type { ApplyChangeSet, FieldValue, KernelClient, Schema, VisibleRecord } from "@contracts";

import { createEditBuffer } from "@engines/edit-buffer/index";

import { useEditableRowVersionGrid } from "../index";
import { makeDiffCellRenderer } from "../diff-cell-renderer";
import { fieldSetterFromSurface, invalidRuleFromSurface, testSchemaConfig } from "./test-schema";

function makeFakeClient() {
  const postJson = vi.fn(async (_path: string, _body: unknown) => ({
    id: 1,
    schema_revision_id: "1",
  }));
  const getJson = vi.fn(async (_path: string) => []);
  return { postJson, getJson } as unknown as KernelClient & {
    postJson: ReturnType<typeof vi.fn>;
    getJson: ReturnType<typeof vi.fn>;
  };
}

function freshRow(record_id: string, values: VisibleRecord["values"]): VisibleRecord {
  return {
    record_id,
    effective_start: "2026-05-13",
    effective_end: null,
    values,
    custom_fields: [],
  };
}

describe("editable-grid: row-level buffer projects over immutable row.values (fix #1)", () => {
  it("revertField drops the pending value without mutating the live row", () => {
    const client = makeFakeClient();
    const rowA = freshRow("rec-A", { title: { type: "text", value: "Senior Designer" } });

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
      fieldSetter: (
        fieldId: string,
        type: "text",
      ) => (params: { data?: VisibleRecord; newValue: unknown }) => boolean;
    };
    let captured: Captured | null = null;

    function Harness() {
      const ctxRef = useRef<{ fieldSetter: Captured["fieldSetter"] } | null>(null);
      const { controller, surfaceProps } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [rowA],
        client,
        changeTypeId: "position_update",
        ...testSchemaConfig(),
      });
      useEffect(() => {
        ctxRef.current = {
          ...((ctxRef.current ?? {}) as object),
          fieldSetter: fieldSetterFromSurface(surfaceProps),
          invalidRule: invalidRuleFromSurface(surfaceProps),
        } as never;
        if (ctxRef.current) {
          captured = { controller, fieldSetter: fieldSetterFromSurface(surfaceProps) };
        }
      });
      return null;
    }

    render(<Harness />);
    expect(captured).not.toBeNull();

    // Stage an edit. The setter writes only to the pending row buffer; AG Grid
    // repaints via valueGetter projection over the buffer.
    const titleSetter = captured!.fieldSetter("title", "text");
    act(() => {
      titleSetter({ data: rowA, newValue: "Senior VP" });
    });
    expect(rowA.values.title).toEqual({ type: "text", value: "Senior Designer" });
    expect(captured!.controller.dirtyCount).toBe(1);
    expect(captured!.controller.pendingChangesByRow.get("rec-A")?.fieldChanges[0]?.next).toEqual({
      type: "text",
      value: "Senior VP",
    });

    act(() => {
      captured!.controller.revertField("rec-A", "title");
    });

    expect(captured!.controller.dirtyCount).toBe(0);
    expect(rowA.values.title).toEqual({ type: "text", value: "Senior Designer" });
  });

  it("revertRowEdits drops every pending field on the row", () => {
    const client = makeFakeClient();
    const rowA = freshRow("rec-A", {
      title: { type: "text", value: "Old Title" },
      level: { type: "text", value: "L4" },
    });

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
      fieldSetter: (
        fieldId: string,
        type: "text",
      ) => (params: { data?: VisibleRecord; newValue: unknown }) => boolean;
    };
    let captured: Captured | null = null;

    function Harness() {
      const ctxRef = useRef<{ fieldSetter: Captured["fieldSetter"] } | null>(null);
      const { controller, surfaceProps } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [rowA],
        client,
        changeTypeId: "position_update",
        ...testSchemaConfig(),
      });
      useEffect(() => {
        ctxRef.current = {
          ...((ctxRef.current ?? {}) as object),
          fieldSetter: fieldSetterFromSurface(surfaceProps),
          invalidRule: invalidRuleFromSurface(surfaceProps),
        } as never;
        if (ctxRef.current) {
          captured = { controller, fieldSetter: fieldSetterFromSurface(surfaceProps) };
        }
      });
      return null;
    }

    render(<Harness />);
    expect(captured).not.toBeNull();

    const titleSetter = captured!.fieldSetter("title", "text");
    const levelSetter = captured!.fieldSetter("level", "text");
    act(() => {
      titleSetter({ data: rowA, newValue: "New Title" });
      levelSetter({ data: rowA, newValue: "L5" });
    });
    expect(rowA.values.title).toEqual({ type: "text", value: "Old Title" });
    expect(rowA.values.level).toEqual({ type: "text", value: "L4" });
    expect(captured!.controller.dirtyCount).toBe(2);

    act(() => {
      captured!.controller.revertRowEdits("rec-A");
    });

    expect(captured!.controller.dirtyCount).toBe(0);
    expect(rowA.values.title).toEqual({ type: "text", value: "Old Title" });
    expect(rowA.values.level).toEqual({ type: "text", value: "L4" });
  });

  it("revertBulkGroup drops every pending cell across every affected row", () => {
    const client = makeFakeClient();
    const rowA = freshRow("rec-A", { flag: { type: "bool", value: true } });
    const rowB = freshRow("rec-B", { flag: { type: "bool", value: true } });

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
    };
    let captured: Captured | null = null;

    function Harness() {
      const { controller, surfaceProps } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [rowA, rowB],
        client,
        changeTypeId: "position_update",
        ...testSchemaConfig(),
      });
      useEffect(() => {
        captured = { controller };
      });
      return null;
    }

    render(<Harness />);
    expect(captured).not.toBeNull();

    act(() => {
      captured!.controller.stageBulkUpdate({
        rows: [{ rowKey: "rec-A" }, { rowKey: "rec-B" }],
        fieldId: "flag",
        value: { type: "bool", value: false },
        bulkGroupId: "flag-q1",
      });
    });
    expect(rowA.values.flag).toEqual({ type: "bool", value: true });
    expect(rowB.values.flag).toEqual({ type: "bool", value: true });
    expect(captured!.controller.dirtyCount).toBe(2);

    act(() => {
      captured!.controller.revertBulkGroup("flag-q1");
    });

    expect(captured!.controller.dirtyCount).toBe(0);
    expect(rowA.values.flag).toEqual({ type: "bool", value: true });
    expect(rowB.values.flag).toEqual({ type: "bool", value: true });
  });

  it("revertBulkGroup works in the SAME event tick as the stages it rolls back", () => {
    // The agent stage-rollback path stages N rows and reverts the group inside
    // one synchronous handler. `pendingChangesByRow` is a render-time useMemo,
    // so a memo-walking revert sees the PREVIOUS render and silently reverts
    // nothing — the live-buffer walk must see same-tick stages.
    const client = makeFakeClient();
    const rowA = freshRow("rec-A", { flag: { type: "bool", value: true } });
    const rowB = freshRow("rec-B", { flag: { type: "bool", value: true } });

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
    };
    let captured: Captured | null = null;

    function Harness() {
      const { controller } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [rowA, rowB],
        client,
        changeTypeId: "position_update",
        ...testSchemaConfig(),
      });
      useEffect(() => {
        captured = { controller };
      });
      return null;
    }

    render(<Harness />);
    expect(captured).not.toBeNull();

    act(() => {
      // Stage two rows, then roll the group back — all in one tick, before
      // React re-renders. This is exactly stageDraft's atomic-failure path.
      captured!.controller.stageBulkUpdate({
        rows: [{ rowKey: "rec-A" }],
        fieldId: "flag",
        value: { type: "bool", value: false },
        bulkGroupId: "agent-same-tick",
      });
      captured!.controller.stageBulkUpdate({
        rows: [{ rowKey: "rec-B" }],
        fieldId: "flag",
        value: { type: "bool", value: false },
        bulkGroupId: "agent-same-tick",
      });
      captured!.controller.revertBulkGroup("agent-same-tick");
    });

    expect(captured!.controller.dirtyCount).toBe(0);
  });
});

describe("editable-grid: explicit changeTypeId survives follow-up edits (fix #2)", () => {
  it("setRowChangeType + next cell edit: new entry's meta keeps the explicit pick", async () => {
    const client = makeFakeClient();
    const rowA = freshRow("rec-A", {
      title: { type: "text", value: "Old" },
      level: { type: "text", value: "L4" },
    });

    // App supplies inferChangeType — without the fix, the next cell
    // edit would re-resolve through inference and clobber the
    // explicit pick. The test uses a function that returns a
    // DIFFERENT value than the explicit one to make the regression
    // visible.
    const inferChangeType = () => "title_change";

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
      fieldSetter: (
        fieldId: string,
        type: "text",
      ) => (params: { data?: VisibleRecord; newValue: unknown }) => boolean;
    };
    let captured: Captured | null = null;

    function Harness() {
      const ctxRef = useRef<{ fieldSetter: Captured["fieldSetter"] } | null>(null);
      const { controller, surfaceProps } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [rowA],
        client,
        changeTypeId: "position_update",
        inferChangeType,
        ...testSchemaConfig(),
      });
      useEffect(() => {
        ctxRef.current = {
          ...((ctxRef.current ?? {}) as object),
          fieldSetter: fieldSetterFromSurface(surfaceProps),
          invalidRule: invalidRuleFromSurface(surfaceProps),
        } as never;
        if (ctxRef.current) {
          captured = { controller, fieldSetter: fieldSetterFromSurface(surfaceProps) };
        }
      });
      return null;
    }

    render(<Harness />);
    expect(captured).not.toBeNull();

    // 1. Stage an edit on field X (no explicit type — inferred).
    const titleSetter = captured!.fieldSetter("title", "text");
    act(() => {
      titleSetter({ data: rowA, newValue: "New Title" });
    });

    // 2. User explicitly picks a different change_type for the row.
    act(() => {
      captured!.controller.setRowChangeType("rec-A", "reorganization");
    });

    // 3. User edits a second cell on the same row. Without fix #2 this
    //    rebuilds meta with only {modelId, recordKey, effectiveStart,
    //    bulkGroupId} — silently dropping `changeTypeId: "reorganization"`.
    const levelSetter = captured!.fieldSetter("level", "text");
    act(() => {
      levelSetter({ data: rowA, newValue: "L5" });
    });

    // The digest's per-row change_type MUST stay "reorganization"
    // (explicit override wins over inference).
    const summary = captured!.controller.pendingChangesByRow.get("rec-A");
    expect(summary?.changeType).toBe("reorganization");

    // And saving partitions under the explicit change_type, not the
    // inferred one. The fix preserves explicit changeTypeId on every
    // new buffer entry, so the partition rule's "first-non-null adopt"
    // still resolves to "reorganization."
    await act(async () => {
      await captured!.controller.save();
    });
    expect(client.postJson).toHaveBeenCalledTimes(1);
    const payload = client.postJson.mock.calls[0]![1] as ApplyChangeSet;
    expect(payload.change_type_id).toBe("reorganization");
  });
});

describe("editable-grid: save throws on unresolved change_type (fix #3)", () => {
  it("no config.changeTypeId AND no inferChangeType → save() rejects", async () => {
    const client = makeFakeClient();
    const rowA = freshRow("rec-A", { title: { type: "text", value: "Old" } });

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
      fieldSetter: (
        fieldId: string,
        type: "text",
      ) => (params: { data?: VisibleRecord; newValue: unknown }) => boolean;
    };
    let captured: Captured | null = null;

    function Harness() {
      const ctxRef = useRef<{ fieldSetter: Captured["fieldSetter"] } | null>(null);
      // NO changeTypeId. NO inferChangeType. The controller must fail before
      // it can ship an empty change_type_id to the kernel.
      const { controller, surfaceProps } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [rowA],
        client,
        ...testSchemaConfig(),
      });
      useEffect(() => {
        ctxRef.current = {
          ...((ctxRef.current ?? {}) as object),
          fieldSetter: fieldSetterFromSurface(surfaceProps),
          invalidRule: invalidRuleFromSurface(surfaceProps),
        } as never;
        if (ctxRef.current) {
          captured = { controller, fieldSetter: fieldSetterFromSurface(surfaceProps) };
        }
      });
      return null;
    }

    render(<Harness />);
    expect(captured).not.toBeNull();

    const titleSetter = captured!.fieldSetter("title", "text");
    act(() => {
      titleSetter({ data: rowA, newValue: "New" });
    });
    expect(captured!.controller.dirtyCount).toBe(1);

    // save() should throw the dev-loud guardrail BEFORE any postJson
    // fires. The guard fires inside the save partitioner
    // (the synchronous setup phase of save), so the rejection
    // surfaces as a thrown error.
    await expect(
      act(async () => {
        await captured!.controller.save();
      }),
    ).rejects.toThrow(/Cannot resolve change_type/);

    // Kernel never received a wrongly-typed payload.
    expect(client.postJson).not.toHaveBeenCalled();
    // Buffer entry stays for the user to retry (the page would
    // surface the error, fix the config, then save again).
    expect(captured!.controller.dirtyCount).toBe(1);
  });
});

describe("editable-grid: save provenance", () => {
  it("human field setters overwrite configured provenance with user/null", async () => {
    const client = makeFakeClient();
    const rowA = freshRow("rec-A", { title: { type: "text", value: "Old" } });

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
      fieldSetter: (
        fieldId: string,
        type: "text",
      ) => (params: { data?: VisibleRecord; newValue: unknown }) => boolean;
    };
    let captured: Captured | null = null;

    function Harness() {
      const { controller, surfaceProps } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [rowA],
        client,
        changeTypeId: "position_update",
        // Direct field setters are human edits. They must overwrite any
        // configured programmatic source with user/null last-touched provenance.
        sourceKind: "agent",
        sourceRef: "run_123",
        ...testSchemaConfig(),
      });
      useEffect(() => {
        captured = { controller, fieldSetter: fieldSetterFromSurface(surfaceProps) };
      });
      return null;
    }

    render(<Harness />);
    expect(captured).not.toBeNull();
    const titleSetter = captured!.fieldSetter("title", "text");
    act(() => {
      titleSetter({ data: rowA, newValue: "New Title" });
    });
    expect(captured!.controller.pendingChangesByRow.get("rec-A")?.sourceKind).toBe("user");
    expect(captured!.controller.pendingChangesByRow.get("rec-A")?.sourceRef).toBeNull();

    await act(async () => {
      await captured!.controller.save();
    });

    expect(client.postJson).toHaveBeenCalledTimes(1);
    const payload = client.postJson.mock.calls[0]![1] as ApplyChangeSet;
    expect(payload.source_kind).toBe("user");
    expect(payload.source_ref).toBeUndefined();
  });

  it("surfaces last-touched sourceKind on pendingChangesByRow, preserving the agent bulkGroupId after a human edit", async () => {
    // Regression guard for the conflict-classification blocker: a human edit
    // onto an agent-staged row must keep the row's `agent-*` bulkGroupId (so the
    // group chrome still resolves) WHILE flipping the summary's last-touched
    // `sourceKind` to "user". Consumers classify agent-vs-human by sourceKind,
    // not the (preserved) group prefix.
    const client = makeFakeClient();
    const rowA = freshRow("rec-A", { title: { type: "text", value: "Old" } });

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
      fieldSetter: (
        fieldId: string,
        type: "text",
      ) => (params: { data?: VisibleRecord; newValue: unknown }) => boolean;
    };
    let captured: Captured | null = null;

    function Harness() {
      const { controller, surfaceProps } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [rowA],
        client,
        changeTypeId: "position_update",
        ...testSchemaConfig(),
      });
      useEffect(() => {
        captured = { controller, fieldSetter: fieldSetterFromSurface(surfaceProps) };
      });
      return null;
    }

    render(<Harness />);
    expect(captured).not.toBeNull();

    // Agent stages the row under an agent group.
    act(() => {
      captured!.controller.stageBulkUpdate({
        rows: [{ rowKey: "rec-A" }],
        fieldId: "title",
        value: { type: "text", value: "Agent Title" },
        bulkGroupId: "agent-proposal",
        sourceKind: "agent",
      });
    });
    expect(captured!.controller.pendingChangesByRow.get("rec-A")?.sourceKind).toBe("agent");
    expect(captured!.controller.pendingChangesByRow.get("rec-A")?.bulkGroupId).toBe(
      "agent-proposal",
    );

    // The human edits the same row via a field setter.
    const titleSetter = captured!.fieldSetter("title", "text");
    act(() => {
      titleSetter({ data: rowA, newValue: "Human Title" });
    });

    const summary = captured!.controller.pendingChangesByRow.get("rec-A");
    // bulkGroupId PRESERVED, but last-touched provenance is now the human.
    expect(summary?.bulkGroupId).toBe("agent-proposal");
    expect(summary?.sourceKind).toBe("user");
  });

  it("surfaces last-touched sourceRef on pendingChangesByRow (provenance a consumer can round-trip on restore)", async () => {
    // A consumer that snapshots a row's pending state to revert-then-RESTORE it
    // (the agent-chat replace path) needs the row's sourceRef, not just its
    // sourceKind, to put provenance back faithfully. Assert the digest exposes
    // the last-`set` sourceRef.
    const client = makeFakeClient();
    const rowA = freshRow("rec-A", { title: { type: "text", value: "Old" } });

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
    };
    let captured: Captured | null = null;

    function Harness() {
      const { controller } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [rowA],
        client,
        changeTypeId: "position_update",
        ...testSchemaConfig(),
      });
      useEffect(() => {
        captured = { controller };
      });
      return null;
    }

    render(<Harness />);
    expect(captured).not.toBeNull();

    act(() => {
      captured!.controller.stageBulkUpdate({
        rows: [{ rowKey: "rec-A" }],
        fieldId: "title",
        value: { type: "text", value: "Agent Title" },
        bulkGroupId: "agent-proposal",
        sourceKind: "agent",
        sourceRef: "run_789",
      });
    });

    const summary = captured!.controller.pendingChangesByRow.get("rec-A");
    expect(summary?.sourceKind).toBe("agent");
    expect(summary?.sourceRef).toBe("run_789");
  });

  it("programmatic staging threads sourceRef into ApplyChangeSet.source_ref", async () => {
    const client = makeFakeClient();
    const rowA = freshRow("rec-A", { title: { type: "text", value: "Old" } });

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
    };
    let captured: Captured | null = null;

    function Harness() {
      const { controller } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [rowA],
        client,
        changeTypeId: "position_update",
        sourceKind: "agent",
        sourceRef: "run_123",
        ...testSchemaConfig(),
      });
      useEffect(() => {
        captured = { controller };
      });
      return null;
    }

    render(<Harness />);
    expect(captured).not.toBeNull();
    act(() => {
      captured!.controller.stageBulkUpdate({
        rows: [{ rowKey: "rec-A" }],
        fieldId: "title",
        value: { type: "text", value: "New Title" },
        bulkGroupId: "agent-proposal",
      });
    });

    await act(async () => {
      await captured!.controller.save();
    });

    expect(client.postJson).toHaveBeenCalledTimes(1);
    const payload = client.postJson.mock.calls[0]![1] as ApplyChangeSet;
    expect(payload.source_kind).toBe("agent");
    expect(payload.source_ref).toBe("run_123");
  });

  it("programmatic staging can override hook-level source provenance per call", async () => {
    const client = makeFakeClient();
    const rowA = freshRow("rec-A", { title: { type: "text", value: "Old" } });

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
    };
    let captured: Captured | null = null;

    function Harness() {
      const { controller } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [rowA],
        client,
        changeTypeId: "position_update",
        sourceKind: "user",
        sourceRef: null,
        ...testSchemaConfig(),
      });
      useEffect(() => {
        captured = { controller };
      });
      return null;
    }

    render(<Harness />);
    expect(captured).not.toBeNull();
    act(() => {
      captured!.controller.stageBulkUpdate({
        rows: [{ rowKey: "rec-A" }],
        fieldId: "title",
        value: { type: "text", value: "Agent Title" },
        bulkGroupId: "agent-proposal",
        sourceKind: "agent",
        sourceRef: "run_agent",
      });
    });

    await act(async () => {
      await captured!.controller.save();
    });

    expect(client.postJson).toHaveBeenCalledTimes(1);
    const payload = client.postJson.mock.calls[0]![1] as ApplyChangeSet;
    expect(payload.source_kind).toBe("agent");
    expect(payload.source_ref).toBe("run_agent");
  });

  it("programmatic staging overwrites earlier human row provenance", async () => {
    const client = makeFakeClient();
    const rowA = freshRow("rec-A", {
      flag: { type: "bool", value: true },
      title: { type: "text", value: "Old" },
    });

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
      fieldSetter: (
        fieldId: string,
        type: "text",
      ) => (params: { data?: VisibleRecord; newValue: unknown }) => boolean;
    };
    let captured: Captured | null = null;

    function Harness() {
      const { controller, surfaceProps } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [rowA],
        client,
        changeTypeId: "position_update",
        sourceKind: "agent",
        sourceRef: "run_123",
        ...testSchemaConfig(),
      });
      useEffect(() => {
        captured = { controller, fieldSetter: fieldSetterFromSurface(surfaceProps) };
      });
      return null;
    }

    render(<Harness />);
    expect(captured).not.toBeNull();
    const titleSetter = captured!.fieldSetter("title", "text");
    act(() => {
      titleSetter({ data: rowA, newValue: "Human Title" });
    });
    act(() => {
      captured!.controller.stageBulkUpdate({
        rows: [{ rowKey: "rec-A" }],
        fieldId: "flag",
        value: { type: "bool", value: false },
        bulkGroupId: "agent-proposal",
      });
    });

    await act(async () => {
      await captured!.controller.save();
    });

    expect(client.postJson).toHaveBeenCalledTimes(1);
    const payload = client.postJson.mock.calls[0]![1] as ApplyChangeSet;
    expect(payload.source_kind).toBe("agent");
    expect(payload.source_ref).toBe("run_123");
    expect(payload.writes[0]!.values).toEqual({
      flag: { type: "bool", value: false },
      title: { type: "text", value: "Human Title" },
    });
  });

  it("human field setters overwrite earlier programmatic row provenance", async () => {
    const client = makeFakeClient();
    const rowA = freshRow("rec-A", {
      flag: { type: "bool", value: true },
      title: { type: "text", value: "Old" },
    });

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
      fieldSetter: (
        fieldId: string,
        type: "text",
      ) => (params: { data?: VisibleRecord; newValue: unknown }) => boolean;
    };
    let captured: Captured | null = null;

    function Harness() {
      const { controller, surfaceProps } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [rowA],
        client,
        changeTypeId: "position_update",
        sourceKind: "agent",
        sourceRef: "run_123",
        ...testSchemaConfig(),
      });
      useEffect(() => {
        captured = { controller, fieldSetter: fieldSetterFromSurface(surfaceProps) };
      });
      return null;
    }

    render(<Harness />);
    expect(captured).not.toBeNull();
    act(() => {
      captured!.controller.stageBulkUpdate({
        rows: [{ rowKey: "rec-A" }],
        fieldId: "flag",
        value: { type: "bool", value: false },
        bulkGroupId: "agent-proposal",
      });
    });
    const titleSetter = captured!.fieldSetter("title", "text");
    act(() => {
      titleSetter({ data: rowA, newValue: "Human Title" });
    });

    await act(async () => {
      await captured!.controller.save();
    });

    expect(client.postJson).toHaveBeenCalledTimes(1);
    const payload = client.postJson.mock.calls[0]![1] as ApplyChangeSet;
    expect(payload.source_kind).toBe("user");
    expect(payload.source_ref).toBeUndefined();
    expect(payload.writes[0]!.values).toEqual({
      flag: { type: "bool", value: false },
      title: { type: "text", value: "Human Title" },
    });
  });
});

describe("editable-grid: digest and partition resolve identically (fix #6)", () => {
  it("multi-row + multi-change_type: digest narrates the same verb save commits under", async () => {
    // Make per-partition replies trackable so we can correlate which
    // change_type each apply call carried.
    const client = makeFakeClient();

    const inferChangeType = (touched: string[]) => {
      const set = new Set(touched);
      if (set.has("title")) return "title_change";
      if (set.has("flag")) return "flag_toggle";
      return "position_update";
    };

    const rowA = freshRow("rec-A", { title: { type: "text", value: "Old A" } });
    const rowB = freshRow("rec-B", { flag: { type: "bool", value: true } });

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
      fieldSetter: (
        fieldId: string,
        type: "text",
      ) => (params: { data?: VisibleRecord; newValue: unknown }) => boolean;
    };
    let captured: Captured | null = null;

    function Harness() {
      const ctxRef = useRef<{ fieldSetter: Captured["fieldSetter"] } | null>(null);
      const { controller, surfaceProps } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [rowA, rowB],
        client,
        changeTypeId: "position_update",
        inferChangeType,
        ...testSchemaConfig(),
      });
      useEffect(() => {
        ctxRef.current = {
          ...((ctxRef.current ?? {}) as object),
          fieldSetter: fieldSetterFromSurface(surfaceProps),
          invalidRule: invalidRuleFromSurface(surfaceProps),
        } as never;
        if (ctxRef.current) {
          captured = { controller, fieldSetter: fieldSetterFromSurface(surfaceProps) };
        }
      });
      return null;
    }

    render(<Harness />);
    expect(captured).not.toBeNull();

    // Row A: hand edit → infers `title_change`.
    // Row B: bulk update with EXPLICIT `flag_toggle` override.
    const titleSetter = captured!.fieldSetter("title", "text");
    act(() => {
      titleSetter({ data: rowA, newValue: "New A" });
    });
    act(() => {
      captured!.controller.stageBulkUpdate({
        rows: [{ rowKey: "rec-B" }],
        fieldId: "flag",
        value: { type: "bool", value: false },
        bulkGroupId: "flag-q1",
        changeTypeId: "flag_toggle",
      });
    });

    // Read the row-meta digest BEFORE save (this is what the row-meta
    // strip narrates to the user).
    const digestA = captured!.controller.pendingChangesByRow.get("rec-A");
    const digestB = captured!.controller.pendingChangesByRow.get("rec-B");
    expect(digestA?.changeType).toBe("title_change");
    expect(digestB?.changeType).toBe("flag_toggle");

    // Save and inspect each per-change_set apply.
    await act(async () => {
      await captured!.controller.save();
    });
    expect(client.postJson).toHaveBeenCalledTimes(2);

    const payloads = client.postJson.mock.calls.map((call) => call[1] as ApplyChangeSet);
    const changeTypesShipped = payloads.map((p) => p.change_type_id).sort();
    expect(changeTypesShipped).toEqual(["flag_toggle", "title_change"]);

    // And the per-change_set outcome that the controller exposes
    // mirrors the digest. The save loop's `perChangeSet` is what the
    // status banner reads, so this is the load-bearing contract: the
    // digest the strip narrates and the change_types the save
    // commits under stay in lockstep.
    const outcome = captured!.controller.lastSaveOutcome!;
    const outcomeTypes = outcome.perChangeSet.map((p) => p.changeTypeId).sort();
    expect(outcomeTypes).toEqual(["flag_toggle", "title_change"]);
  });
});

// P6 review fix #1: partial-save reload race. When a save partition fails,
// the page reloads rows from the kernel — failed-partition rows snap back
// to the OLD server value while their BUFFER entries stay for retry. The
// diff-cell renderer used to read the displayed value off `params.value` /
// `params.valueFormatted` (the AG Grid view of `row.values[fieldId]`),
// which is now the stale server value, so the cell would paint
// "OLD with `was OLD` struck out" — identical strings — making the user
// believe the cell was clean while Save would still re-submit the hidden
// buffer value. The fix sources the current text FROM the buffer when an
// entry exists for the address.
describe("editable-grid: diff-cell renders buffer value after partial-save reload (fix #4)", () => {
  it("dirty cell reads current value from the buffer, not from the reloaded row.values", () => {
    // Simulate post-reload state for the failed-partition row B:
    //   - row.values has the SERVER's stored value (the prior; the failed
    //     write never persisted).
    //   - buffer still holds B's PENDING edit (preserved for retry).
    const buffer = createEditBuffer().set(
      { rowKey: "rec-B", fieldId: "title" },
      { type: "text", value: "User Pending Edit" },
    );

    const reloadedRowB: VisibleRecord = {
      record_id: "rec-B",
      effective_start: "2026-05-13",
      effective_end: null,
      custom_fields: [],
      // Reload snapped back to the pre-edit server value.
      values: { title: { type: "text", value: "Old Server Value" } },
    };

    // The prior the diff cell shows under the strikethrough — the
    // value captured at the time of the original commit (before save).
    const priorValueGetter = (): FieldValue => ({
      type: "text",
      value: "Old Server Value",
    });

    // App formatter mirrors what the positions grid passes: project the
    // primitive into a string. Used for BOTH current and prior text.
    const formatValue = (value: unknown): string => {
      if (value == null) return "";
      return String(value);
    };

    const Renderer = makeDiffCellRenderer({
      buffer,
      priorValueGetter,
      onRevert: () => {},
      formatValue,
    });

    // Mount the renderer so its hooks resolve. AG Grid calls the
    // renderer with `value` / `valueFormatted` computed off the
    // RELOADED row.values — the stale server string. The legacy
    // renderer surfaced exactly that string as `currentText`, hiding
    // the user's pending edit.
    const { container } = render(
      <Renderer
        data={reloadedRowB}
        value="Old Server Value"
        valueFormatted="Old Server Value"
        colDef={{ colId: "title" }}
      />,
    );

    const current = container.querySelector(".ag-diff-current");
    const was = container.querySelector(".ag-diff-was");
    expect(current).not.toBeNull();
    expect(was).not.toBeNull();
    // The HIGH-severity assertion: the displayed current value matches
    // the BUFFER's pending value, NOT the reloaded server value.
    expect(current!.textContent).toBe("User Pending Edit");
    expect(was!.textContent).toBe("was Old Server Value");
    // Defense-in-depth: the legacy bug would have produced two identical
    // strings (both "Old Server Value"). Assert they differ.
    expect(current!.textContent).not.toBe("Old Server Value");
  });

  it("create-row dirty cells suppress empty prior copy", () => {
    const buffer = createEditBuffer().set(
      { rowKey: "tmp:new-row", fieldId: "title" },
      { type: "text", value: "Sarah-Jane Williams" },
    );
    const row: VisibleRecord = {
      record_id: "tmp:new-row",
      effective_start: "2026-05-13",
      effective_end: null,
      custom_fields: [],
      values: {},
    };

    const Renderer = makeDiffCellRenderer({
      buffer,
      priorValueGetter: () => null,
      onRevert: () => {},
      formatValue: (value) => (value == null ? "" : String(value)),
    });

    const { container } = render(
      <Renderer data={row} value="" valueFormatted="" colDef={{ colId: "title" }} />,
    );

    expect(container.querySelector(".ag-diff-current")?.textContent).toBe("Sarah-Jane Williams");
    expect(container.querySelector(".ag-diff-was")).toBeNull();
  });

  // P7 review fix FR-A F3: digest leaves `summary.changeType` undefined
  // when no resolution path produces a value, so the strip can render a
  // "Set type" placeholder rather than narrating an empty pill while
  // save() throws the dev-loud guardrail. The legacy `?? ""` floor hid
  // the misconfig until save fired.
  it("pendingChangesByRow leaves changeType undefined when nothing resolves (FR-A F3)", () => {
    const client = makeFakeClient();
    const rowA = freshRow("rec-A", { title: { type: "text", value: "Old" } });

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
      fieldSetter: (
        fieldId: string,
        type: "text",
      ) => (params: { data?: VisibleRecord; newValue: unknown }) => boolean;
    };
    let captured: Captured | null = null;

    function Harness() {
      const ctxRef = useRef<{ fieldSetter: Captured["fieldSetter"] } | null>(null);
      // No `changeTypeId`. No `inferChangeType`. The legacy digest would
      // resolve to `""` here; the fix leaves it undefined so the renderer
      // surfaces a placeholder.
      const { controller, surfaceProps } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [rowA],
        client,
        ...testSchemaConfig(),
      });
      useEffect(() => {
        ctxRef.current = {
          ...((ctxRef.current ?? {}) as object),
          fieldSetter: fieldSetterFromSurface(surfaceProps),
          invalidRule: invalidRuleFromSurface(surfaceProps),
        } as never;
        if (ctxRef.current) {
          captured = { controller, fieldSetter: fieldSetterFromSurface(surfaceProps) };
        }
      });
      return null;
    }

    render(<Harness />);
    expect(captured).not.toBeNull();

    const titleSetter = captured!.fieldSetter("title", "text");
    act(() => {
      titleSetter({ data: rowA, newValue: "New" });
    });

    const summary = captured!.controller.pendingChangesByRow.get("rec-A");
    expect(summary).toBeDefined();
    // The load-bearing assertion: undefined, NOT empty string. The strip
    // reads this and renders "Set type" instead of an empty pill.
    expect(summary?.changeType).toBeUndefined();
  });

  // P7 review fix FR-A F1: stageBulkUpdate must mirror the cell setters'
  // `isTempRowKey` guard — a draft row (rowKey starts with `tmp:`) bulk-
  // targeted via the bulk-action sidebar would otherwise stamp a synthetic
  // `recordKey: { type: "record_id", value: "tmp:..." }` the kernel
  // rejects. The fix leaves `meta.recordKey` undefined so the wire payload
  // omits `record_key` and the kernel treats the row as a new-record
  // create.
  it("stageBulkUpdate leaves meta.recordKey undefined for tmp rowKeys (FR-A F1)", async () => {
    const client = makeFakeClient();

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
    };
    let captured: Captured | null = null;

    function Harness() {
      const { controller, surfaceProps } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [],
        client,
        changeTypeId: "position_update",
        ...testSchemaConfig(),
      });
      useEffect(() => {
        captured = { controller };
      });
      return null;
    }

    render(<Harness />);
    expect(captured).not.toBeNull();

    // Stage a new record so `pendingChangesByRow` exposes a tmp rowKey.
    let tmpRowKey = "";
    act(() => {
      const { tempRowKey } = captured!.controller.stageNewRecord({
        title: { type: "text", value: "Draft" },
      });
      tmpRowKey = tempRowKey;
    });
    expect(tmpRowKey.startsWith("tmp:")).toBe(true);

    // Now bulk-target the draft (this is the regression scenario — apps
    // wiring multi-row bulk actions don't necessarily filter drafts out
    // of the selection, so the library must produce kernel-safe payloads).
    act(() => {
      captured!.controller.stageBulkUpdate({
        rows: [{ rowKey: tmpRowKey }],
        fieldId: "flag",
        value: { type: "bool", value: false },
        bulkGroupId: "bulk-A",
      });
    });

    // Read back the buffer entry's meta via the digest. The summary's
    // fieldChanges include both `title` (from stageNewRecord) + `flag`
    // (from stageBulkUpdate). Both should carry `meta.recordKey: undefined`
    // — we probe by saving and asserting the wire payload omits
    // `record_key` (the kernel-create signal).
    expect(captured!.controller.pendingChangesByRow.has(tmpRowKey)).toBe(true);

    // Save and inspect the actual wire payload — the buffer-state probe
    // above isn't sufficient because a regression that re-introduces
    // `record_key: "tmp:..."` on the wire while leaving meta.recordKey
    // undefined would still pass the digest check. The kernel's create
    // path branches on `Some(record_key)` vs `None`; shipping a tmp
    // string in `record_key` makes it treat the row as an UPDATE to a
    // non-existent record, which 404s.
    await act(async () => {
      await captured!.controller.save();
    });
    expect(client.postJson).toHaveBeenCalledTimes(1);
    const payload = client.postJson.mock.calls[0]![1] as ApplyChangeSet;
    expect(payload.writes.length).toBe(1);
    const tmpWrite = payload.writes[0]!;
    // Load-bearing assertion: `record_key` is OMITTED from the write,
    // not present-with-some-value. Use `in` so a present `undefined` /
    // present `null` would also fail.
    expect("record_key" in tmpWrite).toBe(false);
  });
});

// P10 review fix FR-A F1: when a tmp row's existing buffer entries carry
// `meta.effectiveStart = A` and the toolbar as-of changes to B before the user
// bulk-targets the same draft, the bulk path used to stamp the new entry with
// B — splitting `entriesToWrites`'s row group (`${rowKey}::${eff}`) and
// emitting TWO record-create writes for the same draft. The fix mirrors the
// cell setters' `effectiveStartForRowEdit(rowKey, asOf, buffer)` lookup so
// bulk entries on a row with prior staged edits land at the SAME
// effective_start.
describe("editable-grid: stageBulkUpdate anchors tmp-row entries to existing effective_start (FR-A F1)", () => {
  it("tmp row staged at A, bulk update after as-of switch to B emits ONE create write", async () => {
    const client = makeFakeClient();

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
    };
    let captured: Captured | null = null;

    // The Harness re-renders the hook with a new `asOf` so the bulk path
    // sees a different `asOf` than the draft was staged under (the legacy
    // bug only fires when the two diverge). The test pins the draft to
    // ASOF_A first, then flips the prop to ASOF_B, then bulk-targets.
    const ASOF_A = "2026-01-01";
    const ASOF_B = "2026-05-15";

    function Harness({ asOf }: { asOf: string }) {
      const { controller, surfaceProps } = useEditableRowVersionGrid({
        modelId: "position",
        asOf,
        scope: { appId: "hc", customerId: "demo" },
        rows: [],
        client,
        changeTypeId: "position_update",
        ...testSchemaConfig(),
      });
      useEffect(() => {
        captured = { controller };
      });
      return null;
    }

    const { rerender } = render(<Harness asOf={ASOF_A} />);
    expect(captured).not.toBeNull();

    // 1. Stage a tmp row at as-of A. The synthesized draft entry's
    //    meta.effectiveStart locks to ASOF_A.
    let tmpRowKey = "";
    act(() => {
      const { tempRowKey } = captured!.controller.stageNewRecord({
        title: { type: "text", value: "Draft" },
      });
      tmpRowKey = tempRowKey;
    });
    expect(tmpRowKey.startsWith("tmp:")).toBe(true);

    // 2. Toolbar as-of flips to B. Hook re-binds with the new asOf prop
    //    so `stageBulkUpdate`'s `asOf` closure is now ASOF_B.
    rerender(<Harness asOf={ASOF_B} />);

    // 3. Bulk-target the same draft from the bulk-action sidebar. The
    //    legacy code would stamp this entry with ASOF_B; the fix routes
    //    it through `effectiveStartForRowEdit` so it lands at ASOF_A
    //    (matching the existing draft entry).
    act(() => {
      captured!.controller.stageBulkUpdate({
        rows: [{ rowKey: tmpRowKey }],
        fieldId: "flag",
        value: { type: "bool", value: false },
        bulkGroupId: "bulk-anchor",
      });
    });

    // 4. Save and inspect the wire payload. The load-bearing assertion:
    //    `payload.writes.length === 1`. With the legacy split,
    //    `entriesToWrites` grouped by `${rowKey}::${effectiveStart}` would
    //    emit TWO writes — both without `record_key` — and the kernel
    //    would mint two unrelated records for what the user perceives as
    //    one draft.
    await act(async () => {
      await captured!.controller.save();
    });
    expect(client.postJson).toHaveBeenCalledTimes(1);
    const payload = client.postJson.mock.calls[0]![1] as ApplyChangeSet;
    expect(payload.writes.length).toBe(1);
    const write = payload.writes[0]!;
    // The single write carries both staged fields (title + flag) under
    // the original effective_start (ASOF_A), without `record_key` (create).
    expect(write.effective_start).toBe(ASOF_A);
    expect("record_key" in write).toBe(false);
  });
});

// P10 review fix FR-A F2: `stageBulkUpdate` must consult each touched
// field's registered validator (the same callback `fieldSetter` /
// `fieldSetterFromValue` register at column-build time) BEFORE writing
// any buffer entries. Without this gate, the bulk path could land an
// app-invalid value the inline editor would reject — money_rate amount
// "abc", relation = null when `required`, etc. The fix pre-validates
// every (row × field) pair and returns `{ ok: false, failures }` if any
// reject; ZERO entries are written on failure (atomic).
describe("editable-grid: stageBulkUpdate consults registered validators (FR-A F2)", () => {
  it("returns { ok: false } and stages NO entries when a validator rejects", () => {
    const client = makeFakeClient();
    const rowA = freshRow("rec-A", { title: { type: "text", value: "Old" } });

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
    };
    let captured: Captured | null = null;

    function Harness() {
      const { controller, surfaceProps } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [rowA],
        client,
        changeTypeId: "position_update",
        ...testSchemaConfig(),
        fieldOverrides: {
          title: {
            validate: (next) => {
              if (next?.type === "text" && next.value.includes("REJECT")) {
                return { ok: false, message: "Cannot contain REJECT" };
              }
              return { ok: true };
            },
          },
        },
      });
      useEffect(() => {
        captured = { controller };
      });
      return null;
    }

    render(<Harness />);
    expect(captured).not.toBeNull();

    // Bulk-stage a value the validator rejects. The contract: zero entries
    // land, `{ ok: false, failures: [...] }` returns, `dirtyCount` stays
    // at 0, the row's values DON'T mutate.
    let result: ReturnType<Captured["controller"]["stageBulkUpdate"]> | null = null;
    act(() => {
      result = captured!.controller.stageBulkUpdate({
        rows: [{ rowKey: "rec-A" }],
        fieldId: "title",
        value: { type: "text", value: "REJECT-me" },
        bulkGroupId: "bulk-reject",
      });
    });

    expect(result).not.toBeNull();
    const narrowed = result!;
    expect(narrowed.ok).toBe(false);
    if (narrowed.ok) {
      throw new Error("expected validator rejection");
    }
    expect(narrowed.failures.length).toBe(1);
    expect(narrowed.failures[0]).toEqual({
      rowKey: "rec-A",
      fieldId: "title",
      message: "Cannot contain REJECT",
    });
    // Load-bearing: the buffer is untouched. dirtyCount stays 0 (no
    // staged entries) AND row data isn't mutated.
    expect(captured!.controller.dirtyCount).toBe(0);
    expect(rowA.values.title).toEqual({ type: "text", value: "Old" });
  });

  it("returns { ok: true } and stages entries when validators pass", () => {
    const client = makeFakeClient();
    const rowA = freshRow("rec-A", { title: { type: "text", value: "Old" } });

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
    };
    let captured: Captured | null = null;

    function Harness() {
      const { controller, surfaceProps } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [rowA],
        client,
        changeTypeId: "position_update",
        ...testSchemaConfig(),
        fieldOverrides: {
          title: {
            validate: (next) => {
              if (next?.type === "text" && next.value.includes("REJECT")) {
                return { ok: false, message: "Cannot contain REJECT" };
              }
              return { ok: true };
            },
          },
        },
      });
      useEffect(() => {
        captured = { controller };
      });
      return null;
    }

    render(<Harness />);
    expect(captured).not.toBeNull();

    let result: ReturnType<Captured["controller"]["stageBulkUpdate"]> | null = null;
    act(() => {
      result = captured!.controller.stageBulkUpdate({
        rows: [{ rowKey: "rec-A" }],
        fieldId: "title",
        value: { type: "text", value: "Senior Designer" },
        bulkGroupId: "bulk-pass",
      });
    });

    expect(result).not.toBeNull();
    expect(result!.ok).toBe(true);
    expect(captured!.controller.dirtyCount).toBe(1);
    expect(rowA.values.title).toEqual({ type: "text", value: "Old" });
    expect(captured!.controller.pendingChangesByRow.get("rec-A")?.fieldChanges[0]?.next).toEqual({
      type: "text",
      value: "Senior Designer",
    });
  });
});

// P11 B1 (FR-A landmine): the row-meta strip's date/type pills must not
// mutate buffer meta while `save()` is in flight. The save loop snapshots
// entries BEFORE awaiting apply; `revertMatching(snapshot)` then evicts
// each entry by an (addr, value, meta) equality check. If `setRowEffectiveDate`
// changes the live entry's meta mid-flight, the equality fails → revert
// skips → entry stays in the buffer → next Save re-applies the SAME write
// at the new effective_start. Net effect: same record persisted twice
// under two different effective dates (and via `setRowChangeType`, an
// extra change_set under a different change_type).
describe("editable-grid: meta-mutators no-op during in-flight save (P11 B1)", () => {
  it("setRowEffectiveDate mid-flight does not strand a buffer entry", async () => {
    // Deferred /api/apply: we resolve it manually so we can fire the
    // meta-mutator while `submitting === true`.
    let resolveApply: ((value: unknown) => void) | null = null;
    const postJson = vi.fn((path: string, _body: unknown) => {
      if (path === "/api/apply") {
        return new Promise((res) => {
          resolveApply = res;
        });
      }
      return Promise.resolve({});
    });
    const getJson = vi.fn(async () => []);
    const client = { postJson, getJson } as unknown as KernelClient;

    const ASOF_ORIG = "2026-05-13";
    const ASOF_MID = "2026-09-30";
    const rowA = freshRow("rec-A", { title: { type: "text", value: "Old" } });

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
      fieldSetter: (
        fieldId: string,
        type: "text",
      ) => (params: { data?: VisibleRecord; newValue: unknown }) => boolean;
    };
    let captured: Captured | null = null;

    function Harness() {
      const ctxRef = useRef<{ fieldSetter: Captured["fieldSetter"] } | null>(null);
      const { controller, surfaceProps } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: ASOF_ORIG,
        scope: { appId: "hc", customerId: "demo" },
        rows: [rowA],
        client,
        changeTypeId: "position_update",
        ...testSchemaConfig(),
      });
      useEffect(() => {
        ctxRef.current = {
          ...((ctxRef.current ?? {}) as object),
          fieldSetter: fieldSetterFromSurface(surfaceProps),
          invalidRule: invalidRuleFromSurface(surfaceProps),
        } as never;
        if (ctxRef.current) {
          captured = { controller, fieldSetter: fieldSetterFromSurface(surfaceProps) };
        }
      });
      return null;
    }

    render(<Harness />);
    expect(captured).not.toBeNull();

    // Stage one cell edit on rec-A at the ORIGINAL as-of.
    const titleSetter = captured!.fieldSetter("title", "text");
    act(() => {
      titleSetter({ data: rowA, newValue: "Edited" });
    });
    expect(captured!.controller.dirtyCount).toBe(1);

    // Kick off save WITHOUT awaiting — apply() returns the deferred above.
    let savePromise: Promise<unknown>;
    act(() => {
      savePromise = captured!.controller.save();
    });

    // Wait for apply to dispatch (deferred installed).
    await waitFor(() => {
      expect(resolveApply).not.toBeNull();
      expect(captured!.controller.submitting).toBe(true);
    });

    // MID-FLIGHT: user clicks the row-meta strip's date pill. The
    // guard MUST refuse this — without it the buffer entry's meta
    // changes to ASOF_MID and `revertMatching` will fail to evict it
    // after apply resolves.
    act(() => {
      captured!.controller.setRowEffectiveDate("rec-A", ASOF_MID);
    });

    // Resolve apply with a success envelope so the success branch runs
    // `revertMatching(snapshot)`.
    await act(async () => {
      resolveApply!({ id: 1, schema_revision_id: "1" });
      await savePromise;
    });

    // Load-bearing assertions:
    //   1. Buffer is CLEAN (the success-path revertMatching evicted the
    //      entry; the guard kept the live entry meta-stable so the
    //      equality check passed).
    //   2. `lastSaveOutcome.savedStageCount === 1` (we DID save 1 cell).
    //   3. Re-saving with a clean buffer is a no-op (no stranded entry
    //      remains to re-apply under ASOF_MID).
    expect(captured!.controller.dirtyCount).toBe(0);
    expect(captured!.controller.lastSaveOutcome?.savedStageCount).toBe(1);

    // Sanity: a second save() must produce no new postJson calls — if
    // the entry had stranded, we'd see a second /api/apply here.
    const postCountAfterFirstSave = postJson.mock.calls.filter((c) => c[0] === "/api/apply").length;
    await act(async () => {
      await captured!.controller.save();
    });
    const postCountAfterSecondSave = postJson.mock.calls.filter(
      (c) => c[0] === "/api/apply",
    ).length;
    expect(postCountAfterSecondSave).toBe(postCountAfterFirstSave);
  });

  it("cell setter mid-flight is a no-op and does not strand a saved sibling", async () => {
    let resolveApply: ((value: unknown) => void) | null = null;
    const postJson = vi.fn((path: string, _body: unknown) => {
      if (path === "/api/apply") {
        return new Promise((res) => {
          resolveApply = res;
        });
      }
      return Promise.resolve({});
    });
    const getJson = vi.fn(async () => []);
    const client = { postJson, getJson } as unknown as KernelClient;
    const rowA = freshRow("rec-A", {
      title: { type: "text", value: "Old" },
      level: { type: "text", value: "L4" },
    });

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
      fieldSetter: (
        fieldId: string,
        type: "text",
      ) => (params: { data?: VisibleRecord; newValue: unknown }) => boolean;
    };
    let captured: Captured | null = null;

    function Harness() {
      const { controller, surfaceProps } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [rowA],
        client,
        changeTypeId: "position_update",
        sourceKind: "agent",
        sourceRef: "run-1",
        ...testSchemaConfig(),
      });
      useEffect(() => {
        captured = { controller, fieldSetter: fieldSetterFromSurface(surfaceProps) };
      });
      return null;
    }

    render(<Harness />);
    expect(captured).not.toBeNull();

    act(() => {
      captured!.controller.stageBulkUpdate({
        rows: [{ rowKey: "rec-A" }],
        fieldId: "title",
        value: { type: "text", value: "Agent Title" },
        bulkGroupId: "agent-run",
      });
    });
    expect(captured!.controller.dirtyCount).toBe(1);

    let savePromise!: Promise<unknown>;
    act(() => {
      savePromise = captured!.controller.save();
    });
    await waitFor(() => {
      expect(resolveApply).not.toBeNull();
      expect(captured!.controller.submitting).toBe(true);
    });

    const levelSetter = captured!.fieldSetter("level", "text");
    let accepted = true;
    act(() => {
      accepted = levelSetter({ data: rowA, newValue: "L5" });
    });
    expect(accepted).toBe(false);
    expect(captured!.controller.dirtyCount).toBe(1);

    await act(async () => {
      resolveApply!({ id: 1, schema_revision_id: "1" });
      await savePromise;
    });
    expect(captured!.controller.dirtyCount).toBe(0);
  });

  it("FieldValue setter mid-flight is a no-op and does not strand a saved sibling", async () => {
    let resolveApply: ((value: unknown) => void) | null = null;
    const postJson = vi.fn((path: string, _body: unknown) => {
      if (path === "/api/apply") {
        return new Promise((res) => {
          resolveApply = res;
        });
      }
      return Promise.resolve({});
    });
    const getJson = vi.fn(async () => []);
    const client = { postJson, getJson } as unknown as KernelClient;
    const schema: Schema = {
      app_id: "hc",
      customer_id: "demo",
      version: "v1",
      change_types: [],
      models: [
        {
          id: "position",
          kind: "entity",
          label: "Position",
          fields: [
            { id: "title", label: "Title", type: "text", required: false },
            { id: "base_salary", label: "Base salary", type: "money_rate", required: false },
          ],
        },
      ],
    };
    const rowA = freshRow("rec-A", {
      title: { type: "text", value: "Old" },
      base_salary: {
        type: "money_rate",
        value: { amount: "100000", currency: "USD", period: "annual" },
      },
    });

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
      fieldSetter: (
        fieldId: string,
        type: "text",
      ) => (params: { data?: VisibleRecord; newValue: unknown }) => boolean;
    };
    let captured: Captured | null = null;
    let moneyRateSetter: ((params: { data?: VisibleRecord; newValue: unknown }) => boolean) | null =
      null;

    function Harness() {
      const { controller, surfaceProps } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [rowA],
        client,
        changeTypeId: "position_update",
        schema,
        model: "position",
        fieldOverrides: {
          base_salary: {
            formatValue: (_primitive, fieldValue) =>
              fieldValue?.type === "money_rate" ? fieldValue.value.amount : "",
          },
        },
      });
      useEffect(() => {
        const fieldSetter = fieldSetterFromSurface(surfaceProps) as (
          fieldId: string,
          type?: string,
        ) => (params: { data?: VisibleRecord; newValue: unknown }) => boolean;
        captured = { controller, fieldSetter: fieldSetterFromSurface(surfaceProps) };
        moneyRateSetter = fieldSetter("base_salary", "money_rate");
      });
      return null;
    }

    render(<Harness />);
    expect(captured).not.toBeNull();
    expect(moneyRateSetter).not.toBeNull();

    const titleSetter = captured!.fieldSetter("title", "text");
    act(() => {
      titleSetter({ data: rowA, newValue: "Human Title" });
    });
    expect(captured!.controller.dirtyCount).toBe(1);

    let savePromise!: Promise<unknown>;
    act(() => {
      savePromise = captured!.controller.save();
    });
    await waitFor(() => {
      expect(resolveApply).not.toBeNull();
      expect(captured!.controller.submitting).toBe(true);
    });

    let accepted = true;
    act(() => {
      accepted = moneyRateSetter!({
        data: rowA,
        newValue: {
          type: "money_rate",
          value: { amount: "125000", currency: "USD", period: "annual" },
        },
      });
    });
    expect(accepted).toBe(false);
    expect(captured!.controller.dirtyCount).toBe(1);

    await act(async () => {
      resolveApply!({ id: 1, schema_revision_id: "1" });
      await savePromise;
    });
    expect(captured!.controller.dirtyCount).toBe(0);
  });

  it("stageBulkUpdate mid-flight is rejected and does not strand a saved sibling", async () => {
    let resolveApply: ((value: unknown) => void) | null = null;
    const postJson = vi.fn((path: string, _body: unknown) => {
      if (path === "/api/apply") {
        return new Promise((res) => {
          resolveApply = res;
        });
      }
      return Promise.resolve({});
    });
    const getJson = vi.fn(async () => []);
    const client = { postJson, getJson } as unknown as KernelClient;
    const rowA = freshRow("rec-A", {
      title: { type: "text", value: "Old" },
      level: { type: "text", value: "L4" },
    });

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
      fieldSetter: (
        fieldId: string,
        type: "text",
      ) => (params: { data?: VisibleRecord; newValue: unknown }) => boolean;
    };
    let captured: Captured | null = null;

    function Harness() {
      const { controller, surfaceProps } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [rowA],
        client,
        changeTypeId: "position_update",
        ...testSchemaConfig(),
      });
      useEffect(() => {
        captured = { controller, fieldSetter: fieldSetterFromSurface(surfaceProps) };
      });
      return null;
    }

    render(<Harness />);
    expect(captured).not.toBeNull();

    const titleSetter = captured!.fieldSetter("title", "text");
    act(() => {
      titleSetter({ data: rowA, newValue: "Human Title" });
    });
    expect(captured!.controller.dirtyCount).toBe(1);

    let savePromise!: Promise<unknown>;
    act(() => {
      savePromise = captured!.controller.save();
    });
    await waitFor(() => {
      expect(resolveApply).not.toBeNull();
      expect(captured!.controller.submitting).toBe(true);
    });

    let result: ReturnType<Captured["controller"]["stageBulkUpdate"]> | null = null;
    act(() => {
      result = captured!.controller.stageBulkUpdate({
        rows: [{ rowKey: "rec-A" }],
        fieldId: "level",
        value: { type: "text", value: "L5" },
        bulkGroupId: "agent-run",
      });
    });
    expect(result).toEqual({
      ok: false,
      failures: [
        {
          rowKey: "rec-A",
          fieldId: "level",
          message: "Save is already in flight. Wait for it to finish, then retry.",
        },
      ],
    });
    expect(captured!.controller.dirtyCount).toBe(1);

    await act(async () => {
      resolveApply!({ id: 1, schema_revision_id: "1" });
      await savePromise;
    });
    expect(captured!.controller.dirtyCount).toBe(0);
  });
});

// P11 P2 (FR-A landmine): discard during in-flight save → revert lost to
// the reload race. The cheap defense: gate the three revert paths with
// `if (submitting) return;` so the discard click is rejected at the
// boundary. The user can retry after save resolves. See
// docs/interaction-footguns.md for the broader write-up.
describe("editable-grid: revert paths no-op during in-flight save (P11 P2)", () => {
  it("revertRowEdits called mid-save is a no-op (entry stays for save loop)", async () => {
    let resolveApply: ((value: unknown) => void) | null = null;
    const postJson = vi.fn((path: string, _body: unknown) => {
      if (path === "/api/apply") {
        return new Promise((res) => {
          resolveApply = res;
        });
      }
      return Promise.resolve({});
    });
    const getJson = vi.fn(async () => []);
    const client = { postJson, getJson } as unknown as KernelClient;

    const rowA = freshRow("rec-A", { title: { type: "text", value: "Old" } });

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
      fieldSetter: (
        fieldId: string,
        type: "text",
      ) => (params: { data?: VisibleRecord; newValue: unknown }) => boolean;
    };
    let captured: Captured | null = null;

    function Harness() {
      const ctxRef = useRef<{ fieldSetter: Captured["fieldSetter"] } | null>(null);
      const { controller, surfaceProps } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [rowA],
        client,
        changeTypeId: "position_update",
        ...testSchemaConfig(),
      });
      useEffect(() => {
        ctxRef.current = {
          ...((ctxRef.current ?? {}) as object),
          fieldSetter: fieldSetterFromSurface(surfaceProps),
          invalidRule: invalidRuleFromSurface(surfaceProps),
        } as never;
        if (ctxRef.current) {
          captured = { controller, fieldSetter: fieldSetterFromSurface(surfaceProps) };
        }
      });
      return null;
    }

    render(<Harness />);
    const titleSetter = captured!.fieldSetter("title", "text");
    act(() => {
      titleSetter({ data: rowA, newValue: "Edited" });
    });
    expect(captured!.controller.dirtyCount).toBe(1);

    let savePromise: Promise<unknown>;
    act(() => {
      savePromise = captured!.controller.save();
    });
    await waitFor(() => {
      expect(resolveApply).not.toBeNull();
      expect(captured!.controller.submitting).toBe(true);
    });

    // MID-FLIGHT: user clicks Discard on the row's meta strip. The
    // guard MUST refuse — without it, the buffer drops + row.values
    // reverts → apply resolves successfully → reload returns the
    // saved value → row shows saved-not-discarded.
    act(() => {
      captured!.controller.revertRowEdits("rec-A");
    });

    // The dirty count must still be 1 — the discard was refused.
    expect(captured!.controller.dirtyCount).toBe(1);

    await act(async () => {
      resolveApply!({ id: 1, schema_revision_id: "1" });
      await savePromise;
    });

    // Save completed normally: 1 stage saved, buffer cleared via the
    // success-path revertMatching (not via the discard).
    expect(captured!.controller.lastSaveOutcome?.savedStageCount).toBe(1);
    expect(captured!.controller.dirtyCount).toBe(0);
  });
});

describe("editable-grid: diff-cell renders buffer value after partial-save reload (fix #4 — clean cell)", () => {
  it("clean cell still uses AG Grid's pre-formatted value (no regression)", () => {
    // No buffer entry for this address — the renderer must keep using
    // AG Grid's `valueFormatted` (canonical for clean cells), not
    // re-format via the app's `formatValue`.
    const buffer = createEditBuffer();
    const row: VisibleRecord = {
      record_id: "rec-A",
      effective_start: "2026-05-13",
      effective_end: null,
      custom_fields: [],
      values: { title: { type: "text", value: "Designer" } },
    };
    const formatValue = vi.fn(() => "FORMATTER_CALLED");

    const Renderer = makeDiffCellRenderer({
      buffer,
      priorValueGetter: () => undefined,
      onRevert: () => {},
      formatValue,
    });

    const { container } = render(
      <Renderer
        data={row}
        value="Designer"
        valueFormatted="Designer (pre-formatted)"
        colDef={{ colId: "title" }}
      />,
    );

    const current = container.querySelector(".ag-diff-current");
    expect(current).not.toBeNull();
    // Clean-path short-circuit: `valueFormatted` wins; the app's
    // formatter is not invoked.
    expect(current!.textContent).toBe("Designer (pre-formatted)");
    expect(formatValue).not.toHaveBeenCalled();
  });
});
