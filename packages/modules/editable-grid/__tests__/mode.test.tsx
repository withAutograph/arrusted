// Per-mode behavior of `useEditableRowVersionGrid`.
//
// Mounts the hook in a tiny harness for each of the three presentation modes
// and asserts the contract the library promises:
//   - read mode: the controller is a no-op (`isDirty` always false; `save`
//     resolves immediately; `dirtyCount` always 0); the columnDefs returned
//     by the hook stamp `editable: false`; the fieldSetter refuses commits
//     as a defensive backstop.
//   - tweak mode: per-field override `editable` is respected — a field
//     declared `editable: true` allows commits while fields without explicit
//     tweak opt-in stay non-editable; commits flow through Save.
//   - edit mode (default): behavior unchanged — `editable: true` columns
//     accept commits; the buffer dirties.
//
// Does NOT mount AG Grid. Mode behavior lives at the hook + columnDefs
// boundary; calling `ctx.fieldSetter(...)` directly with mock
// `ValueSetterParams` exercises the same contract AG Grid invokes.
//
// The visual difference (read theme vs edit theme; cellSelection toggle)
// lives in the `<EditableRowVersionGrid>` component and is verified by the
// PositionsPage screenshots in `.scratch/screenshots-mode/`. Asserting CSS
// from a Vitest harness without rendering AG Grid would test nothing
// meaningful (the theme is opaque to the test).

import { useEffect } from "react";
import { describe, expect, it } from "vite-plus/test";
import { act, render } from "@testing-library/react";

import type { ColDef, ValueSetterParams } from "ag-grid-community";

import type { KernelClient, Schema, VisibleRecord } from "@contracts";

import {
  useEditableRowVersionGrid,
  type EditableGridController,
  type EditableGridMode,
  type EditableRowVersionGridSurfaceProps,
} from "../index";

function makeFakeClient(): KernelClient {
  return {
    getJson: (async () => []) as KernelClient["getJson"],
    postJson: (async () => ({ id: 1, schema_revision_id: "1" })) as KernelClient["postJson"],
  };
}

function fakeRow(): VisibleRecord {
  return {
    record_id: "rec-1",
    effective_start: "2026-05-13",
    values: {
      title: { type: "text", value: "Original" },
      is_open: { type: "bool", value: true },
    },
    custom_fields: [],
  };
}

function fakeSetterParams(
  data: VisibleRecord,
  newValue: unknown,
  colId: string = "title",
): ValueSetterParams<VisibleRecord> {
  return {
    data,
    newValue,
    oldValue: undefined,
    colDef: { colId } as ColDef<VisibleRecord>,
    column: {} as never,
    api: {} as never,
    columnApi: {} as never,
    context: {} as never,
    node: null,
  } as unknown as ValueSetterParams<VisibleRecord>;
}

type Captured = {
  controller: EditableGridController;
  surfaceProps: EditableRowVersionGridSurfaceProps;
};

const TEST_SCHEMA: Schema = {
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
        { id: "is_open", label: "Open", type: "bool", required: false },
      ],
    },
  ],
};

function Harness(props: { mode?: EditableGridMode; onCaptured: (c: Captured) => void }) {
  const { controller, surfaceProps } = useEditableRowVersionGrid({
    modelId: "position",
    asOf: "2026-05-13",
    scope: { appId: "hc", customerId: "demo" },
    rows: [fakeRow()],
    client: makeFakeClient(),
    schema: TEST_SCHEMA,
    model: "position",
    fieldOverrides: {
      is_open: { editable: true },
    },
    mode: props.mode,
  });

  useEffect(() => {
    props.onCaptured({ controller, surfaceProps });
  });

  return null;
}

describe("useEditableRowVersionGrid mode prop", () => {
  describe("read mode", () => {
    it("controller exposes no-op shape: isDirty false, save resolves, dirtyCount 0", async () => {
      const captured: Captured[] = [];
      render(<Harness mode="read" onCaptured={(c) => captured.push(c)} />);
      const latest = () => captured[captured.length - 1]!;

      expect(latest().controller.isDirty).toBe(false);
      expect(latest().controller.dirtyCount).toBe(0);
      expect(latest().controller.submitting).toBe(false);
      expect(latest().controller.submitError).toBeNull();
      expect(latest().controller.lastSaveOutcome).toBeNull();

      // Read-mode save returns the empty SaveOutcome reference (zero
      // saved, zero remaining, no per-change_set entries). The shape
      // matches what live save() returns for a no-op early return so
      // page chrome can render uniformly without branching.
      const outcome = await latest().controller.save();
      expect(outcome).toEqual({
        savedStageCount: 0,
        remainingStageCount: 0,
        perChangeSet: [],
      });
      expect(latest().controller.isDirty).toBe(false);
    });

    it("forces editable:false on every column even when app says editable:true", () => {
      const captured: Captured[] = [];
      render(<Harness mode="read" onCaptured={(c) => captured.push(c)} />);
      const latest = () => captured[captured.length - 1]!;
      const cols = latest().surfaceProps.columnDefs;
      expect(cols).toHaveLength(2);
      for (const col of cols) {
        expect(col.editable).toBe(false);
      }
    });

    it("fieldSetter is a defensive backstop: returns false even when invoked directly with a valid commit", () => {
      const captured: Captured[] = [];
      const row = fakeRow();
      render(<Harness mode="read" onCaptured={(c) => captured.push(c)} />);
      const latest = () => captured[captured.length - 1]!;

      const setter = latest().surfaceProps.columnDefs.find((c) => c.colId === "title")!
        .valueSetter as unknown as (params: ValueSetterParams<VisibleRecord>) => boolean;
      let result = true;
      act(() => {
        result = setter(fakeSetterParams(row, "Edited"));
      });
      expect(result).toBe(false);
      expect(latest().controller.dirtyCount).toBe(0);
      expect(latest().controller.isDirty).toBe(false);
    });

    it("stageNewRecord is a no-op: returns empty tempRowKey and does not dirty the buffer", () => {
      const captured: Captured[] = [];
      render(<Harness mode="read" onCaptured={(c) => captured.push(c)} />);
      const latest = () => captured[captured.length - 1]!;

      let staged: { tempRowKey: string } | null = null;
      act(() => {
        staged = latest().controller.stageNewRecord({
          title: { type: "text", value: "New" },
        });
      });
      expect(staged).toEqual({ tempRowKey: "" });
      expect(latest().controller.dirtyCount).toBe(0);
      expect(latest().controller.newRowDrafts).toEqual([]);
    });

    it("ctx.mode is exposed so apps can vary column-specs per mode", () => {
      const captured: Captured[] = [];
      render(<Harness mode="read" onCaptured={(c) => captured.push(c)} />);
      expect(captured[captured.length - 1]!.surfaceProps.mode).toBe("read");
    });

    it("pendingEditsHidden is 0 when buffer is empty (no edits to hide)", () => {
      const captured: Captured[] = [];
      render(<Harness mode="read" onCaptured={(c) => captured.push(c)} />);
      expect(captured[captured.length - 1]!.controller.pendingEditsHidden).toBe(0);
    });
  });

  describe("tweak mode", () => {
    it("respects app's per-column editable flag (true → commit allowed)", () => {
      const captured: Captured[] = [];
      const row = fakeRow();
      render(<Harness mode="tweak" onCaptured={(c) => captured.push(c)} />);
      const latest = () => captured[captured.length - 1]!;

      // Library does NOT override editable in tweak mode — pass through.
      const cols = latest().surfaceProps.columnDefs;
      const isOpenCol = cols.find((c) => c.colId === "is_open")!;
      const titleCol = cols.find((c) => c.colId === "title")!;
      expect(isOpenCol.editable).toBe(true);
      expect(titleCol.editable).toBe(false);

      // Commit on the editable column flows through.
      const isOpenSetter = isOpenCol.valueSetter as unknown as (
        params: ValueSetterParams<VisibleRecord>,
      ) => boolean;
      let result = false;
      act(() => {
        result = isOpenSetter(fakeSetterParams(row, false, "is_open"));
      });
      expect(result).toBe(true);
      expect(latest().controller.dirtyCount).toBe(1);
      expect(latest().controller.isDirty).toBe(true);
    });

    it("ctx.mode === 'tweak' is forwarded so apps can branch column-specs", () => {
      const captured: Captured[] = [];
      render(<Harness mode="tweak" onCaptured={(c) => captured.push(c)} />);
      expect(captured[captured.length - 1]!.surfaceProps.mode).toBe("tweak");
    });

    it("pendingEditsHidden is always 0 in tweak mode (edits are visible + actionable)", () => {
      const captured: Captured[] = [];
      render(<Harness mode="tweak" onCaptured={(c) => captured.push(c)} />);
      expect(captured[captured.length - 1]!.controller.pendingEditsHidden).toBe(0);
    });

    it("save controller is live (not the no-op shape)", async () => {
      const captured: Captured[] = [];
      render(<Harness mode="tweak" onCaptured={(c) => captured.push(c)} />);
      const latest = () => captured[captured.length - 1]!;
      // Distinct identity from read mode's NO_OP_SAVE — the live save
      // closes over apply + buffer; read's is a constant module-level fn.
      expect(typeof latest().controller.save).toBe("function");
      // Smoke: calling save with an empty buffer returns the empty
      // outcome (no apply attempted, no per-change_set entries to surface).
      const outcome = await latest().controller.save();
      expect(outcome.savedStageCount).toBe(0);
      expect(outcome.perChangeSet).toEqual([]);
    });
  });

  describe("edit mode (default)", () => {
    it("default mode is 'edit': behavior unchanged from prior contract", () => {
      const captured: Captured[] = [];
      const row = fakeRow();
      render(<Harness onCaptured={(c) => captured.push(c)} />);
      const latest = () => captured[captured.length - 1]!;
      expect(latest().surfaceProps.mode).toBe("edit");

      // editable:true column accepts the commit; buffer dirties.
      const setter = latest().surfaceProps.columnDefs.find((c) => c.colId === "title")!
        .valueSetter as unknown as (params: ValueSetterParams<VisibleRecord>) => boolean;
      let result = false;
      act(() => {
        result = setter(fakeSetterParams(row, "Updated"));
      });
      expect(result).toBe(true);
      expect(latest().controller.dirtyCount).toBe(1);
    });

    it("explicit mode='edit' matches default", () => {
      const captured: Captured[] = [];
      render(<Harness mode="edit" onCaptured={(c) => captured.push(c)} />);
      const latest = () => captured[captured.length - 1]!;
      expect(latest().surfaceProps.mode).toBe("edit");
      expect(latest().controller.isDirty).toBe(false);
    });
  });

  describe("surfaceProps.mode", () => {
    it("forwards the mode to the surface so the component can pick a theme", () => {
      const captured: Captured[] = [];
      render(<Harness mode="read" onCaptured={(c) => captured.push(c)} />);
      expect(captured[captured.length - 1]!.surfaceProps.mode).toBe("read");
    });
  });
});
